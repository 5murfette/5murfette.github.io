/* sim/edge.js — what the section's surface is made of (Step E2), for the material edge that replaces the bright
 * outline once the section stops rotating (render/edge.js draws it).
 * ED.build(S, sec) chains the section's marching-squares outline (sec.outline: unordered segments s0,y0,s1,y1 on the
 * plane) into polylines and labels every chain point:
 *   - air normal (s, y) from the density gradient; facing UP / WALL / DOWN (overhang and cave ceilings);
 *   - class from the solid material just inside the surface (W.mat_at 0.3 m in), turned into GRASS / DRY / BURNT where
 *     the point is the column's topmost surface and S.veg has grass there (cover, dryness, char), LAVA where the
 *     lava layer covers it; wet = under the simulated sea;
 *   - one smoothing pass: a single point whose neighbours agree takes their class (no 0.5 m speckles).
 * Deterministic (no RNG), reads the world and S only; cost ~1-3 ms per section (measured in edgetest).
 * C layout: struct Edge { i32 np, nc; f32 *pts (s, y), *nrm (air normal s, y); u8 *cls, *base (material class),
 *   *face, *veg (cover, dry, char, burning 0..255), *wet; i32 *chain (first point, count); u8 *closed; f32 O[2], theta; };
 * ED.refresh(S, sec) re-labels the existing chains (fire, water, lava changed; geometry unchanged). */
(function (SS) {
  'use strict';
  const M = SS.math;
  const C = SS.CFG, MAT = C.MAT;
  const ED = SS.edge = {};
  const K = ED.CLS = { NONE: 0, GRASS: 1, DRY: 2, BURNT: 3, SOIL: 4, ROCK: 5, SAND: 6, SNOW: 7, ICE: 8, LAVA: 9, BASALT: 10, ASH: 11, SCREE: 12, SANDSTONE: 13 };
  ED.NAMES = ['none', 'grass', 'dry', 'burnt', 'soil', 'rock', 'sand', 'snow', 'ice', 'lava', 'basalt', 'ash', 'scree', 'sandstone'];
  const F = ED.FACE = { UP: 0, WALL: 1, DOWN: 2 };
  const GRASS_MIN = 64;        // cover (0..255) from which the edge shows grass
  const DRY_MIN = 140;         // dryness (0..255) above which it is dry grass
  const CHAR_MIN = 120;        // char (0..255) above which it is burnt stubble

  function matClass(m) {
    switch (m) {
      case MAT.SOIL: return K.SOIL;
      case MAT.SAND: return K.SAND;
      case MAT.SANDSTONE: return K.SANDSTONE;
      case MAT.SNOW: return K.SNOW;
      case MAT.ICE: return K.ICE;
      case MAT.BASALT: case MAT.CRUST: case MAT.OBSIDIAN: return K.BASALT;
      case MAT.LAVA: return K.LAVA;
      case MAT.ASH: return K.ASH;
      case MAT.SCREE: return K.SCREE;
      case MAT.ROCK: case MAT.BEDROCK: case MAT.CONCRETE: return K.ROCK;
      default: return K.NONE;
    }
  }

  /* chain the unordered segments: every crossing point is shared by the two cells on either side of its lattice edge
   * (exactly equal floats), so endpoints are matched by a quantised key; grid-border points end open chains */
  function chains(seg) {
    const ns = seg.length / 4, map = new Map(), used = new Uint8Array(ns);
    const key = (s, y) => Math.round(s * 1024) * 262147 + Math.round(y * 1024);
    for (let i = 0; i < ns; i++) for (let e = 0; e < 2; e++) {
      const k = key(seg[i * 4 + e * 2], seg[i * 4 + e * 2 + 1]), v = map.get(k);
      if (v === undefined) map.set(k, [i * 2 + e]); else v.push(i * 2 + e);
    }
    const other = (k, ref) => { const v = map.get(k); for (const r of v) if ((r >> 1) !== (ref >> 1) && !used[r >> 1]) return r; return -1; };
    const pts = [], chain = [], closed = [];
    for (let i0 = 0; i0 < ns; i0++) {
      if (used[i0]) continue;
      // walk forward from end 1 of i0, then backward from end 0, and join
      const fwd = [], bwd = [];
      used[i0] = 1;
      let ref = i0 * 2 + 1;
      for (;;) {
        const sg = ref >> 1, e = ref & 1, s = seg[sg * 4 + e * 2], y = seg[sg * 4 + e * 2 + 1];
        fwd.push(s, y);
        const nx = other(key(s, y), ref); if (nx < 0) break;
        used[nx >> 1] = 1; ref = (nx >> 1) * 2 + (1 - (nx & 1));
      }
      ref = i0 * 2;
      for (;;) {
        const sg = ref >> 1, e = ref & 1, s = seg[sg * 4 + e * 2], y = seg[sg * 4 + e * 2 + 1];
        bwd.push(s, y);
        const nx = other(key(s, y), ref); if (nx < 0) break;
        used[nx >> 1] = 1; ref = (nx >> 1) * 2 + (1 - (nx & 1));
      }
      const start = pts.length / 2;
      for (let q = bwd.length - 2; q >= 0; q -= 2) pts.push(bwd[q], bwd[q + 1]);
      for (let q = 0; q < fwd.length; q += 2) pts.push(fwd[q], fwd[q + 1]);
      let cnt = pts.length / 2 - start;
      // a loop comes back to its first point: drop the duplicate, mark it closed
      const isClosed = cnt > 2 && Math.abs(pts[start * 2] - pts[pts.length - 2]) < 1e-6 && Math.abs(pts[start * 2 + 1] - pts[pts.length - 1]) < 1e-6;
      if (isClosed) { pts.length -= 2; cnt--; }
      chain.push(start, cnt); closed.push(isClosed ? 1 : 0);
    }
    return { pts: new Float32Array(pts), chain: new Int32Array(chain), closed: new Uint8Array(closed) };
  }

  /* label every point (geometry fixed: normals, facing, material; state: veg, water, lava) */
  function label(S, E, geom) {
    const W = SS.world, H = W.H, NX = W.NX, NZ = W.NZ, d = { x: M.cos(E.theta), z: M.sin(E.theta) }, O = E.O;
    const st = S.veg, lv = S.lava && SS.lava ? S.lava : null, wa = S.water && SS.water ? S.water : null;
    const np = E.np, pts = E.pts, nrm = E.nrm, cls = E.cls, face = E.face, veg = E.veg, wet = E.wet, base = E.base;
    for (let p = 0; p < np; p++) {
      const s = pts[p * 2], y = pts[p * 2 + 1], x = O.x + s * d.x, z = O.z + s * d.z;
      if (geom) {
        const e = 0.2;
        let gs = W.sample(x + e * d.x, y, z + e * d.z) - W.sample(x - e * d.x, y, z - e * d.z), gy = W.sample(x, y + e, z) - W.sample(x, y - e, z);
        const l = M.len2(gs, gy);
        if (l < 1e-6) { gs = 0; gy = -1; } else { gs /= l; gy /= l; }
        const ns = -gs, ny = -gy;                                     // into the air
        nrm[p * 2] = ns; nrm[p * 2 + 1] = ny;
        face[p] = ny > 0.45 ? F.UP : ny < -0.45 ? F.DOWN : F.WALL;
        base[p] = matClass(W.mat_at(x - ns * 0.3 * d.x, y - ny * 0.3, z - ns * 0.3 * d.z));
      }
      const i = Math.max(0, Math.min(NX - 1, Math.round(x / H))), k = Math.max(0, Math.min(NZ - 1, Math.round(z / H))), c = k * NX + i;
      const out = W.far && W.outside(x, z);                          // dry worlds (D4): the far dunes beyond the lattice
      const top = face[p] !== F.DOWN && (out || y > W.top[c] - 0.6);  // the column's topmost surface (grass, lava live there)
      let k0 = base[p];
      veg[p * 4] = veg[p * 4 + 1] = veg[p * 4 + 2] = veg[p * 4 + 3] = 0;
      wet[p] = wa && SS.water.surface(S, x, z) > y + 0.05 ? 1 : 0;
      if (top && st && !wet[p] && !out) {
        const cv = st.surf[c * 4], dr = st.surf[c * 4 + 1], ch = st.surf[c * 4 + 2], bu = st.surf[c * 4 + 3];
        veg[p * 4] = cv; veg[p * 4 + 1] = dr; veg[p * 4 + 2] = ch; veg[p * 4 + 3] = bu;
        // the terrain paints the column cover on any top material (thin turf over rock too), so the edge follows it
        if (nrm[p * 2 + 1] > 0.2 && k0 !== K.SNOW && k0 !== K.ICE && k0 !== K.LAVA) {
          if (cv >= GRASS_MIN) k0 = ch >= CHAR_MIN ? K.BURNT : dr >= DRY_MIN ? K.DRY : K.GRASS;
          else if (ch >= CHAR_MIN && k0 === K.SOIL) k0 = K.BURNT;
        }
      }
      if (top && lv && SS.lava.depth_at(S, x, z) > 0.03) k0 = K.LAVA;
      cls[p] = k0;
    }
    // one smoothing pass along each chain: a lone point whose two neighbours agree takes their class
    const tmp = E.tmp || (E.tmp = new Uint8Array(np));
    tmp.set(cls);
    for (let q = 0; q < E.nc; q++) {
      const a = E.chain[q * 2], n = E.chain[q * 2 + 1], cl = E.closed[q];
      if (n < 3) continue;
      for (let t = 0; t < n; t++) {
        if (!cl && (t === 0 || t === n - 1)) continue;
        const p = a + t, pp = a + (t + n - 1) % n, pn = a + (t + 1) % n;
        if (tmp[pp] === tmp[pn] && tmp[p] !== tmp[pp] && face[p] !== F.DOWN) cls[p] = tmp[pp];
      }
    }
  }

  ED.build = function (S, sec) {
    const ch = chains(sec.outline), np = ch.pts.length / 2;
    const E = {
      np, nc: ch.chain.length / 2, pts: ch.pts, chain: ch.chain, closed: ch.closed,
      nrm: new Float32Array(np * 2), cls: new Uint8Array(np), base: new Uint8Array(np), face: new Uint8Array(np),
      veg: new Uint8Array(np * 4), wet: new Uint8Array(np), O: { x: sec.O.x, z: sec.O.z }, theta: sec.theta,
      vegVer: S.veg ? S.veg.surfVer : 0, ver: (ED.ver = (ED.ver | 0) + 1)
    };
    label(S, E, true);
    sec.edge = E;
    return E;
  };
  ED.refresh = function (S, sec) {
    const E = sec.edge; if (!E) return ED.build(S, sec);
    label(S, E, false);
    E.vegVer = S.veg ? S.veg.surfVer : 0; E.ver = (ED.ver = (ED.ver | 0) + 1);
    return E;
  };
  /* class histogram over points (optionally only one facing) — tests and HUD debugging */
  ED.stats = function (E, onlyFace) {
    const h = {};
    for (let p = 0; p < E.np; p++) if (onlyFace === undefined || E.face[p] === onlyFace) { const nm = ED.NAMES[E.cls[p]]; h[nm] = (h[nm] || 0) + 1; }
    return h;
  };
})(window.SS = window.SS || {});
