/* sim/derelict.js — the crashed derelict alien ship on the volcanic island (P37 W5; user: "a stunning crashed derelict
 * alien
 * ship, Alien-movie style: horseshoe / croissant hull, biomechanical ribs, partly buried; collidable, ideally part of
 * the destructible world"). Stamped into the voxel world as MAT.OBSIDIAN (glossy black volcanic glass: strength 240, so
 * a blast bites it like rock) from signed distances (metres, > 0 inside), in the ship's tilted local frame:
 *   hull   = a torus segment: ring radius Rm about the centre, an elliptical tube (semi axes EX x EY times the tube
 *          radius
 *            r) swept over an ARC of ~240 deg (the gap opens at th0 + pi: the "horseshoe"), flat-cut ends. The outer
 *            radius carries RIBS: NR ridges round the full ring, r (1 + RIB_O rib(th)).
 *   cavity = the same tube r - WALL thick, above a floor at FLOOR x the hull height below the axis, thickened inward at
 *            the ribs (RIB_I) and open through both ends: a corridor a worm can walk (the ends are the doors);
 *   breaches = 3-5 spheres bitten out of the hull (the crash), a few reach the corridor;
 *   skirt  = BASALT mound below the hull down to the ground (the wreck is half buried, never floats).
 * Placement: the ring's ground (16 points + centre) flat within FLAT m, dry land, clear of lava / the crater / worms /
 * bunkers / town; the best of a 4 m grid (ties: a seeded hash). Skipped when nothing fits. Render (render/derelict.js)
 * adds the lime biomechanical glow pods along the ribs inside and out; they disappear where the hull is blown away.
 * State: S.derelict = { x, y, z, Rm, r, pitch, roll, th0, thm, arc, pods: [{x, y, z, ax, ay, az, k}] (a glow pod on the
 * hull, an anchor point in the wall: the pod is gone when that voxel is; k 0 inside, 1 crest) } or null. C layout:
 * struct Derelict { f32 x, y, z, Rm, r, pitch, roll, th0, thm, arc; i32 npods; Pod pods[48]; }; API: populate(S,
 * taken), sdf(d, x, y, z) -> { solid, air }, stats(S). Cost: ~25k lattice cells. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT;
  const DR = SS.derelict = {};
  const W = () => SS.world;
  const K =
    DR.K = {
      RM: 10, R: 3.3, EX: 1.25, EY: 0.85, WALL: 0.9, ARC: 4.1, NR: 13, RIB_O: 0.2, RIB_I: 0.5, FLOOR: 0.5, FLAT: 6.5, FLAT_ROUGH: 11,
      EDGE: 17
    };
  const wrap = a => {
    while (a > M.PI) a -= M.TAU;
    while (a < -M.PI) a += M.TAU;
    return a;
  };

  /* signed distances at world (x, y, z): out.solid (hull > 0), out.air (cavity > 0), out.skirt (> 0) */
  function frame(d, x, y, z, o) {
    const cp = M.cos(d.pitch), sp = M.sin(d.pitch), cr = M.cos(d.roll), sr = M.sin(d.roll);
    let px = x - d.x, py = y - d.y, pz = z - d.z;
    // inverse of (Rx(pitch) then Rz(roll)): undo roll about z, then pitch about x
    let qx = cr * px + sr * py, qy = -sr * px + cr * py;
    px = qx;
    py = qy;
    qy = cp * py + sp * pz;
    const qz = -sp * py + cp * pz;
    py = qy;
    pz = qz;
    o.px = px; o.py = py; o.pz = pz;
  }
  const FR = { px: 0, py: 0, pz: 0 };
  /* local (ship frame) -> world: Rz(roll) Rx(pitch) local + centre */
  DR.to_world = function (d, px, py, pz) {
    const cp = M.cos(d.pitch), sp = M.sin(d.pitch), cr = M.cos(d.roll), sr = M.sin(d.roll);
    let qy = cp * py - sp * pz;
    const qz = sp * py + cp * pz, qx = px;
    const rx = cr * qx - sr * qy, ry = sr * qx + cr * qy;
    qy = ry;
    return { x: d.x + rx, y: d.y + qy, z: d.z + qz };
  };
  /* points on the corridor floor, along the arc (the egg nest): [{ x, y, z }] */
  DR.floor_points = function (d) {
    const out = [], w = W();
    for (let q = 0; q < 12; q++) {
      const th = d.thm + (q / 11 - 0.5) * d.arc * 0.8, off = (q & 1 ? 0.7 : -0.7);
      const c = DR.to_world(d, (d.Rm + off) * M.cos(th), 0, (d.Rm + off) * M.sin(th));
      let y = c.y;
      if (w.sample(c.x, y, c.z) > 0) continue;
      for (let n = 0; n < 40 && w.sample(c.x, y, c.z) <= 0; n++) y -= 0.1;
      const gy = y + 0.05;
      if (w.sample(c.x, gy - 0.2, c.z) > 0 && w.sample(c.x, gy + 1.2, c.z) <= 0) out.push({ x: c.x, y: gy, z: c.z });
    }
    return out;
  };
  DR.sdf = function (d, x, y, z, out) {
    frame(d, x, y, z, FR);
    const px = FR.px, py = FR.py, pz = FR.pz, rho = M.len2(px, pz), th = M.atan2(pz, px), a = rho - d.Rm;
    const rp = 0.5 + 0.5 * M.cos(K.NR * (th - d.th0)), rib = rp * rp * rp * rp;
    const ro = d.r * (1 + K.RIB_O * rib), sOut = (1 - M.len2(a / (K.EX * ro), py / (K.EY * ro))) * ro * K.EY;
    const sArc = (d.arc / 2 - Math.abs(wrap(th - d.thm))) * rho;
    const rc = (d.r - K.WALL) - K.RIB_I * rp * rp * rp, qc = (1 - M.len2(a / (K.EX * rc), py / (K.EY * rc))) * rc * K.EY;
    const air = M.fast_min(M.fast_min(qc, py + K.FLOOR * ro * K.EY), sArc + 3);
    out.solid = M.fast_min(M.fast_min(sOut, sArc), -air);
    out.air = air;
    out.skirt = M.fast_min(M.fast_min(K.EX * d.r * 0.8 - Math.abs(a), sArc), -K.EY * d.r * 0.85 - py);
    return out;
  };

  /* ---------- placement ---------- */
  function ringGround(x, z, Rm) {
    const w = W();
    let lo = w.top_at(x, z), hi = lo, sum = lo, n = 1;
    for (let q = 0; q < 16; q++) {
      const a = q / 16 * M.TAU, t = w.top_at(x + M.cos(a) * Rm, z + M.sin(a) * Rm);
      lo = M.fast_min(lo, t);
      hi = hi > t ? hi : t;
      sum += t;
      n++;
    }
    return { lo, hi, mean: sum / n };
  }
  DR.populate = function (S, taken) {
    const w = W();
    if (S.biome !== 'volcanic' || w.under || w.dry) return;
    const seed = (Math.imul(S.settings.seed | 0, 7001) + 4099) >>> 0, rg = M.rng_make(seed || 1);
    const sea = w.SEA;
    let best = null, RM = K.RM, reach = 0;
    // P38-A4: the ring sizes in turn, first on level ground (FLAT), then - when no spot fits - on a rougher one
    // (FLAT_ROUGH: the basalt skirt fills the hollows under the hull, so a slope up to ~2x is still believable) instead
    // of skipping the ship
    for (const pass of [[K.RM, K.FLAT], [8.5, K.FLAT], [7, K.FLAT], [K.RM, K.FLAT_ROUGH], [8.5, K.FLAT_ROUGH], [7, K.FLAT_ROUGH]]) {
      RM = pass[0];
      const flat = pass[1];
      reach = RM + K.R * K.EX + 1;
      best = null;
      for (let z = K.EDGE; z <= w.SZ - K.EDGE; z += 4)
        for (let x = K.EDGE; x <= w.SX - K.EDGE; x += 4) {
          if (M.len2(x - w.MX, z - w.MZ) > 36 * w.SC) continue;
          const g = ringGround(x, z, RM);
          if (g.hi - g.lo > flat || g.lo < sea + 1.0) continue;
          let bad = false;
          for (const v of (w.features.volcanoes || []))
            if (M.len2(x - v.x, z - v.z) < v.Rc + reach + 2) bad = true;
          for (const t of taken)
            if (M.len2(t.x - x, t.z - z) < reach * 0.6) bad = true;
          for (const bk of (S.bunkers || []))
            if (M.len2(bk.x - x, bk.z - z) < reach + 4) bad = true;
          if (S.town)
            for (const bd of S.town.bld)
              if (M.len2(bd.x - x, bd.z - z) < reach + 3) bad = true;
          if (bad) continue;
          for (let q = 0; q < 17 && !bad; q++) {
            const a = q / 16 * M.TAU, px = q === 16 ? x : x + M.cos(a) * RM, pz = q === 16 ? z : z + M.sin(a) * RM;
            if (!SS.sim.near_lava ? false : SS.sim.near_lava(S, px, pz)) bad = true;
          }
          if (bad) continue;
          const sc = (g.hi - g.lo) + 1.5 * M.hash3(x | 0, z | 0, seed & 0xffff);
          if (!best || sc < best.sc) best = { x, z, g, sc };
        }
      if (best) break;
    }
    if (!best) return;
    const d = {
      x: best.x,
      z: best.z,
      y: best.g.mean + 0.2,
      Rm: RM,
      r: K.R * RM / K.RM,
      pitch: (M.rng_next(rg) - 0.5) * 0.24,
      roll: (M.rng_next(rg) - 0.5) * 0.18,
      th0: M.rng_next(rg) * M.TAU,
      thm: 0,
      arc: K.ARC,
      pods: []
    };
    d.thm = M.rng_next(rg) * M.TAU;
    const R = d.Rm + d.r * K.EX * (1 + K.RIB_O) + 2, bites = [];
    for (let n = 0, nb = 3 + M.rng_int(rg, 3); n < nb; n++) {
      const th = d.thm + (M.rng_next(rg) - 0.5) * d.arc * 0.9;
      bites.push({ th, y: 0.4 + M.rng_next(rg) * 1.6, r: 1.1 + M.rng_next(rg) * 1.2 });
    }
    const o = { solid: 0, air: 0, skirt: 0 }, H = w.H, NX = w.NX, NY = w.NY, NZ = w.NZ;
    const i0 = M.max(1, Math.floor((d.x - R) / H)),
      i1 = M.min(NX - 2, Math.ceil((d.x + R) / H)),
      k0 = M.max(1, Math.floor((d.z - R) / H)),
      k1 = M.min(NZ - 2, Math.ceil((d.z + R) / H));
    const j0 = M.max(1, Math.floor((d.y - d.r * 2.6 - 2) / H)), j1 = M.min(NY - 2, Math.ceil((d.y + d.r * 2.2 + 2) / H));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const q = (k * NY + j) * NX + i, x = i * H, y = j * H, z = k * H;
          DR.sdf(d, x, y, z, o);
          let s = o.solid;
          for (let b = 0; b < bites.length; b++) {                                          // the crash breaches (hull only)
            const t = bites[b], c = d.Rm * M.cos(t.th), e = d.Rm * M.sin(t.th);
            frame(d, x, y, z, FR); s = M.fast_min(s, M.len3(FR.px - c, FR.py - t.y, FR.pz - e) - t.r);
          }
          if (o.air > 0 && w.d[q] > -o.air) {
            w.d[q] = -M.clamp(o.air, 0.05, 1.5);
            w.mat[q] = MAT.AIR;
            w.heat[q] = 0;
          }
          if (s > -0.5 && s > w.d[q]) {
            w.d[q] = M.clamp(s, -0.6, 1.5);
            if (s > 0) {
              w.mat[q] = MAT.OBSIDIAN;
              w.heat[q] = 0;
            }
          }
          if (o.skirt > -0.5 && o.skirt > w.d[q] && o.air <= 0) {
            w.d[q] = M.clamp(o.skirt, -0.6, 1.5);
            if (o.skirt > 0) {
              w.mat[q] = MAT.BASALT;
              w.heat[q] = 0;
            }
          }
        }
    w.mark(i0, j0, k0, i1, j1, k1);
    // glow pods: along the ribs, inside the corridor (on the floor line, both sides) and on the outer crest
    const cp = M.cos(d.pitch), sp = M.sin(d.pitch), cr = M.cos(d.roll), sr = M.sin(d.roll);
    const toWorld = (px, py, pz) => {                                                  // local -> world (Rx(pitch), then Rz(roll))
      let qy = cp * py - sp * pz, qz = sp * py + cp * pz;
      const qx = px;
      const rx = cr * qx - sr * qy, ry = sr * qx + cr * qy;
      qy = ry;
      return { x: d.x + rx, y: d.y + qy, z: d.z + qz };
    };
    const rc = d.r - K.WALL - K.RIB_I;                                              // (the corridor is narrowest at a rib crest)
    for (let n = 0; n < K.NR && d.pods.length < 48; n++) {
      const th = d.th0 + n * M.TAU / K.NR;                                             // (the rib crests: cos(NR (th - th0)) = 1)
      if (Math.abs(wrap(th - d.thm)) > d.arc / 2 - 0.12) continue;
      const ct = M.cos(th), st = M.sin(th);
      // pod on the surface at tube coords (a, b), anchor in the wall (a2, b2)
      const add = (a, b, a2, b2, k) => {
        const p = toWorld((d.Rm + a) * ct, b, (d.Rm + a) * st), q = toWorld((d.Rm + a2) * ct, b2, (d.Rm + a2) * st);
        d.pods.push({ x: p.x, y: p.y, z: p.z, ax: q.x, ay: q.y, az: q.z, k });
      };
      for (const phi of [0.7, 1.5708, 2.44])
        add(
          K.EX * rc * 0.92 * M.cos(phi),
          K.EY * rc * 0.92 * M.sin(phi),
          K.EX * (rc + 0.9) * M.cos(phi),
          K.EY * (rc + 0.9) * M.sin(phi),
          0
        );
      const ro = d.r * (1 + K.RIB_O);
      add(0, K.EY * ro * 1.0, 0, K.EY * ro * 0.8, 1);
    }
    // (no props on the hull)
    for (let q = 0; q < 14; q++) {
      const th = d.thm + (q / 13 - 0.5) * d.arc;
      const p = DR.to_world(d, d.Rm * M.cos(th), 0, d.Rm * M.sin(th));
      taken.push({ x: p.x, y: p.y, z: p.z });
    }
    S.derelict = d;
    SS.sim.log(S, 'A crashed derelict ship lies on the island: black ribs and a faint green glow.', 0xa6ff3a);
  };
  DR.stats = S => S.derelict ? { x: S.derelict.x, z: S.derelict.z, pods: S.derelict.pods.length } : null;
})(window.SS = window.SS || {});
