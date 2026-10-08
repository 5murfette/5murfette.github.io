/* sim/bunker.js — concrete bunkers (P29d; user 2026-10-08: "add some bunkers: 3D objects that look like they were built
 * for defence, 1 entrance and a window big enough to shoot from, a dome on top, thick concrete walls").
 * A bunker is a round pillbox stamped into the voxel world as MAT.CONCRETE, from signed distances (metres, > 0 inside):
 *   shell  = cylinder r R_OUT from the footing up to H_WALL, plus a dome cap (a sphere through the wall top's rim,
 *            centred DOME_K R_OUT below it), minus the cavity (the same shapes WALL thinner, floor at y0);
 *   door   = a DOOR_W x DOOR_H passage through the wall at angle phi + pi (the rear), with a short cut through any
 *            ground in front of it;
 *   window = an embrasure toward the map centre (angle phi): SLIT_W_IN wide inside, splayed to SLIT_W_OUT outside,
 *            from SLIT_Y0 to SLIT_Y1 above the floor (a worm inside can aim and shoot through it);
 *   footing = the shell reaches FOUND below the floor and down to the lowest ground under its rim (never floats).
 * Placement: deterministic (no RNG; a seeded hash breaks ties): a 4 m grid over the land, the rim's ground within FLAT
 * m, above the sea, no lava / ice / steel under it, CLEAR m from the worm spots, APART m from each other, EDGE m from the
 * lattice border (dry worlds: inside the play circle), no bridge nearby; a second pass at 2.5 x FLAT for steep maps.
 * Concrete is destructible but tough (strength 2600: a grenade digs ~0.63 m, a 0.9 m wall takes several hits).
 * State: S.bunkers [{ x, z, y0, phi }] (render / AI / tools). API: populate(S, taken), sdf(b, x, y, z) (concrete > 0).
 * C layout: struct Bunker { f32 x, z, y0, phi; }; populate = the grid search + one voxel pass per bunker. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT, K = C.BUNKER;
  const BK = SS.bunker = {};
  const W = () => SS.world;
  const smin = (a, b) => (a < b ? a : b), smax = (a, b) => (a > b ? a : b);

  /* signed distances of one bunker at local (dx, y, dz) (y above the floor y0): concrete > 0, the air it cuts > 0 */
  function shape(b, dx, y, dz, out) {
    const r = M.len2(dx, dz), Rin = K.R_OUT - K.WALL, cyD = K.H_WALL - K.DOME_K * K.R_OUT, Rd = M.len2(K.R_OUT, K.DOME_K * K.R_OUT);
    const dd = M.len3(dx, y - cyD, dz);
    const sCyl = smin(smin(K.R_OUT - r, y + b.foot), K.H_WALL - y);
    const sDome = smin(Rd - dd, y - K.H_WALL + 0.01);
    const sOuter = smax(sCyl, sDome);
    const sCav = smax(smin(smin(Rin - r, y), K.H_WALL - y), smin(Rd - K.WALL - dd, y - K.H_WALL + 0.01));
    // door (rear) and window (front): local axes along the opening (a) and across it (c)
    const ux = M.cos(b.phi), uz = M.sin(b.phi);
    const aD = -(dx * ux + dz * uz), cD = -dx * uz + dz * ux;                     // rear: phi + pi
    const sDoor = smin(smin(smin(K.DOOR_W / 2 - Math.abs(cD), y), K.DOOR_H - y), smin(aD - (Rin - 0.4), K.R_OUT + 2.5 - aD));
    const aW = dx * ux + dz * uz, cW = -dx * uz + dz * ux, kW = M.clamp((aW - Rin) / K.WALL, 0, 1.5);
    const half = K.SLIT_W_IN / 2 + kW * (K.SLIT_W_OUT - K.SLIT_W_IN) / 2;
    const sWin = smin(smin(smin(half - Math.abs(cW), y - K.SLIT_Y0 + kW * 0.12), K.SLIT_Y1 + kW * 0.2 - y), smin(aW - (Rin - 0.4), K.R_OUT + 0.6 - aW));
    const sAir = smax(smax(sCav, sDoor), sWin);
    out.conc = smin(sOuter, -sAir); out.air = sAir;
    return out;
  }
  const tmp = { conc: 0, air: 0 };
  BK.sdf = (b, x, y, z) => shape(b, x - b.x, y - b.y0, z - b.z, tmp).conc;

  /* the rim ground: min / max of the top over 16 points at R_OUT + 0.5 (-1e9 when unusable) */
  function rimGround(x, z) {
    const w = W(); let lo = 1e9, hi = -1e9;
    for (let q = 0; q < 16; q++) {
      const a = q / 16 * M.TAU, px = x + M.cos(a) * (K.R_OUT + 0.5), pz = z + M.sin(a) * (K.R_OUT + 0.5);
      if (w.outside(px, pz)) return null;
      const t = w.top_at(px, pz), m = w.mat_at(px, t - 0.3, pz);
      if (m === MAT.LAVA || m === MAT.ICE || m === MAT.STEEL || m === MAT.CONCRETE) return null;
      if (t < lo) lo = t; if (t > hi) hi = t;
    }
    return { lo, hi };
  }

  BK.populate = function (S, taken) {
    S.bunkers = [];
    const w = W();
    if (!K || !(K.N > 0) || w.under) return;
    const sea = w.SEA, seed = (S.settings.seed | 0) >>> 0;
    // flat ground first; steep maps (alpine) get a second pass at 2.5 x FLAT (the footing reaches the low side)
    for (const flat of [K.FLAT, K.FLAT * 2.5]) if (S.bunkers.length < K.N) place(S, taken, flat, sea, seed);
    if (S.bunkers.length) SS.sim.log(S, `${S.bunkers.length} concrete bunker${S.bunkers.length > 1 ? 's' : ''} on the map: get in through the back door, shoot through the slit.`, 0xc8ccd0);
  };
  function place(S, taken, flat, sea, seed) {
    const w = W(), cands = [];
    for (let z = K.EDGE; z <= w.SZ - K.EDGE; z += 4) for (let x = K.EDGE; x <= w.SX - K.EDGE; x += 4) {
      if (w.dry && SS.sim.arena_r(x, z) > S.playR - K.R_OUT - 2) continue;
      const g = rimGround(x, z); if (!g || g.hi - g.lo > flat || g.lo < sea + 0.8) continue;
      let ok = true;
      for (const t of taken) if (M.len2(t.x - x, t.z - z) < K.CLEAR) { ok = false; break; }
      if (!ok || (SS.struct && SS.struct.near && SS.struct.near(S, x, z, K.R_OUT + 3, g.hi + 3))) continue;
      cands.push({ x, z, g, v: (g.hi - g.lo) + 2.5 * M.hash3(x | 0, z | 0, seed & 0xffff) });   // flat first, varied
    }
    cands.sort((a, b) => a.v - b.v || a.z - b.z || a.x - b.x);                      // total order
    for (const c of cands) {
      if (S.bunkers.length >= K.N) break;
      if (S.bunkers.some(b => M.len2(b.x - c.x, b.z - c.z) < K.APART)) continue;
      if (taken.some(t => M.len2(t.x - c.x, t.z - c.z) < K.CLEAR)) continue;   // (the first pass's bunkers are taken too)
      const y0 = (c.g.lo + c.g.hi) / 2 + 0.05, phi = M.atan2(48 - c.z, 48 - c.x);   // the embrasure faces the map centre
      const b = { x: c.x, z: c.z, y0, phi, foot: K.FOUND + (y0 - c.g.lo) + 0.3 };
      stamp(b);
      S.bunkers.push({ x: b.x, z: b.z, y0: b.y0, phi: b.phi });
      taken.push({ x: b.x, y: y0, z: b.z });
    }
  }

  /* write the shell into the lattice: concrete where conc > 0, air where the bunker cuts (cavity, door, window) */
  function stamp(b) {
    const w = W(), H = w.H, NX = w.NX, NY = w.NY, NZ = w.NZ, R = K.R_OUT + 2.8;
    const i0 = Math.max(1, Math.floor((b.x - R) / H)), i1 = Math.min(NX - 2, Math.ceil((b.x + R) / H));
    const k0 = Math.max(1, Math.floor((b.z - R) / H)), k1 = Math.min(NZ - 2, Math.ceil((b.z + R) / H));
    const j0 = Math.max(1, Math.floor((b.y0 - b.foot - 1) / H)), j1 = Math.min(NY - 2, Math.ceil((b.y0 + K.H_WALL + K.R_OUT) / H));
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const o = (k * NY + j) * NX + i;
      shape(b, i * H - b.x, j * H - b.y0, k * H - b.z, tmp);
      if (tmp.conc > -0.5) {                                                       // the shell (and its smooth skin)
        if (tmp.conc > 0 || w.d[o] <= 0) { w.d[o] = M.clamp(tmp.conc, -0.6, 1.5); w.mat[o] = tmp.conc > 0 ? MAT.CONCRETE : MAT.AIR; w.heat[o] = 0; }
      } else if (tmp.air > 0) { w.d[o] = M.clamp(-tmp.air, -1.5, -0.05); w.mat[o] = MAT.AIR; w.heat[o] = 0; }
    }
    w.mark(i0, j0, k0, i1, j1, k1);
  }
})(window.SS = window.SS || {});
