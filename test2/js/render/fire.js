/* render/fire.js — the heat FIELD of the burning ground (P37-W3, P45). The burning patches of the sim (S.flames: napalm, oil rings, car wrecks,
 * the flamethrower's gel) and the burning grass / bush cells (S.veg) are no longer drawn as separate flames each: their heat is summed
 * into one smooth FIELD on a ground grid (cell 0.45 m, a quadratic falloff of each patch's radius), and a flame SOURCE is submitted to
 * the fire system (render/flame.js) on every cell where the summed heat is high enough: the source's height grows with the heat
 * (sqrt: a dense core of merged patches towers over the thin edge), its radius overlaps the neighbours' so adjacent cells blend into
 * ONE continuous sheet of flame; two patches that come close simply add their fields. At most MAXC cells: past that the cell grows
 * (x 1.35 per pass) so a huge fire stays cheap. Presentation only (no sim state touched, no Math.random).
 * API: emit(S): submits the sources (SS.flameView.src), stats().
 * Porting: feed the same heat field to a GPU particle / volume emitter. */
(function (SS) {
  'use strict';
  const FV = SS.fireView = {};
  const MAXC = 170, CELL0 = 0.45, FADE = 1.2;
  const grid = new Map(), gcache = new Map(), creep = new Map();
  let gcT = 0;
  let last = { cells: 0, cell: CELL0, flames: 0, tm: 0 };
  const hash = (a, b) => { let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  /* P65d: the surface under a cell, from the density field (not the coarse column top, which is up to 0.4 m off on a slope): cached 0.5 s per
   * cell, found within 2.6 m of the patch's height; NONE (-1e9) = a drop / void below the patch (no flame hangs over it) */
  const NONE = -1e9;
  function surf(x, z, yref, cell, tm) {
    const key = (Math.floor(x / 0.2) + 8192) * 16384 + Math.floor(z / 0.2) + 8192;
    let c = gcache.get(key);
    if (c && tm - c.t < 0.5 && Math.abs(c.r - yref) < 0.8) return c.y;
    const gv = SS.groundView, g = gv ? gv.ground(x, yref, z) : null, y = g == null ? NONE : g;
    if (!c) { c = { y: 0, t: 0, r: 0 }; gcache.set(key, c); }
    c.y = y; c.t = tm; c.r = yref; return y;
  }
  /* a burning puddle of gel / oil flows downhill: the visible heat of a napalm patch creeps down the local slope (render only: the sim patch
   * stays put) by up to 0.9 of its radius, faster on a steeper slope, and stretches along it */
  const nrm = { x: 0, y: 1, z: 0 };
  function creepOf(f, tm) {
    let c = creep.get(f);
    if (!c) { c = { dx: 0, dz: 0, g: 0, t: -9, ox: 0, oz: 0, t0: tm }; creep.set(f, c); }
    if (tm - c.t > 1.0) {
      c.t = tm; const W = SS.world, gv = SS.groundView;
      const gy = gv ? gv.ground(f.x, f.y + 0.3, f.z) : null;
      if (gy != null && W.normal) { W.normal(f.x, gy + 0.03, f.z, nrm); const h = Math.hypot(nrm.x, nrm.z); c.g = h / Math.max(0.2, nrm.y); c.dx = h > 1e-4 ? nrm.x / h : 0; c.dz = h > 1e-4 ? nrm.z / h : 0; }
      else { c.g = 0; c.dx = c.dz = 0; }
    }
    return c;
  }
  FV.emit = function (S) {
    const FLv = SS.flameView; if (!FLv) return;
    const fl = S.flames, V = S.veg, W = SS.world, nG = V && V.nAct > 0 ? V.nAct : 0;
    if ((!fl || !fl.length) && !nG) { last.cells = 0; last.flames = 0; return; }
    let cell = CELL0; last.tm = S.time;
    if (S.time - gcT > 4) { gcT = S.time; for (const [k, v] of gcache) if (S.time - v.t > 4) gcache.delete(k); for (const k of creep.keys()) if (S.time > k.t1 + 1) creep.delete(k); }
    for (let pass = 0; pass < 4; pass++) {
      grid.clear();
      if (fl) for (const f of fl) {
        const left = f.t1 - S.time; if (left <= 0) continue;
        const k = Math.min(1, left / FADE), re = f.r * 1.25 + cell * 0.5, re2 = re * re;
        let cx = f.x, cz = f.z, sa = 1, sb = 1, ux = 1, uz = 0;
        if (f.napalm) {                                                              // gel flows downhill: shift + stretch along the slope
          const cr = creepOf(f, S.time), age = S.time - cr.t0, flow = Math.min(0.9, cr.g * 0.5 * Math.max(0, Math.min(6, age + 3))) * f.r;
          if (cr.g > 0.1) { cx += cr.dx * flow; cz += cr.dz * flow; ux = cr.dx; uz = cr.dz; sa = 1 / (1 + Math.min(0.7, cr.g * 0.9)); sb = 1.0; }
        }
        const ext = re * 1.7, i0 = Math.floor((cx - ext) / cell), i1 = Math.floor((cx + ext) / cell), k0 = Math.floor((cz - ext) / cell), k1 = Math.floor((cz + ext) / cell);
        for (let iz = k0; iz <= k1; iz++) for (let ix = i0; ix <= i1; ix++) {
          const dx = (ix + 0.5) * cell - cx, dz = (iz + 0.5) * cell - cz, al = (dx * ux + dz * uz) * sa, be = (-dx * uz + dz * ux) * sb, d2 = al * al + be * be;
          if (d2 >= re2) continue;
          const px = (ix + 0.5) * cell, pz = (iz + 0.5) * cell, gy = surf(px, pz, f.y, cell, S.time);
          if (gy === NONE || gy < f.y - 1.1) continue;                                // over a drop: nothing to burn on
          const q = 1 - d2 / re2, e = k * q * q * 1.4, key = (ix + 4096) * 8192 + (iz + 4096);
          let c = grid.get(key);
          if (!c) { c = { ix, iz, E: 0, Y: 0, S: 0 }; grid.set(key, c); }
          c.E += e; c.Y += gy * e; c.S += 0.95 * e;
        }
      }
      if (nG) {                                                                    // burning grass / bushes: low, light flames, thin grey smoke
        const n = V.n, H = W.H, top = W.top, gk = 0.5;
        for (let a = 0; a < nG; a++) {
          const c0 = V.act[a]; if (!(V.burnT[c0] > 0)) continue;
          const e = V.burnI[c0] * Math.min(1, V.burnT[c0] / 0.8) * gk, x = (c0 % n) * H, z = ((c0 / n) | 0) * H;
          if (FV.vis && !FV.vis(x, z)) continue;
          const ix = Math.floor(x / cell), iz = Math.floor(z / cell), key = (ix + 4096) * 8192 + (iz + 4096);
          let c = grid.get(key);
          if (!c) { c = { ix, iz, E: 0, Y: 0, S: 0 }; grid.set(key, c); }
          c.E += e; c.Y += top[c0] * e; c.S += 0.35 * e;
        }
      }
      if (grid.size <= MAXC) break;
      cell *= 1.35;
    }
    let n = 0;
    for (const c of grid.values()) {
      if (c.E < 0.12) continue;
      const E = c.E, x = (c.ix + 0.5) * cell, z = (c.iz + 0.5) * cell, sd = hash(c.ix, c.iz);
      let y = c.Y / E; const g2 = surf(x, z, y, cell, last.tm);       // the cell centre sits on the real surface
      if (g2 !== NONE && Math.abs(g2 - y) < 1.0) y = g2; else if (g2 === NONE) { const top = W.top_at(x, z); if (top > -1e8 && Math.abs(top - y) < 1.2) y = top; }
      const h = (0.45 + 1.15 * Math.sqrt(Math.min(E, 2.4))) * (0.9 + 0.2 * sd), rr = cell * (0.9 + 0.25 * Math.min(E, 1.5));
      FLv.src(x, y - 0.05, z, rr, h, Math.min(1.45, 0.6 + 0.55 * E), c.S / E, Math.min(1, E * 0.8)); n++;
    }
    last.cells = n; last.cell = cell; last.flames = fl ? fl.length : 0;
  };
  FV.stats = () => last;
})(window.SS = window.SS || {});
