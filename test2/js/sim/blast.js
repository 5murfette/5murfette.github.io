/* sim/blast.js — explosions: blast wave, material-aware craters, damage and knock-back. Portable, deterministic.
 *
 * Physics (see HANDOFF §3):
 *   scaled distance  Z = R / W^(1/3)   (R metres, W kg TNT-equivalent; Hopkinson–Cranz)
 *   overpressure     Kinney–Graham:  dP/P0 = 808 [1 + (Z/4.5)^2] / sqrt([1 + (Z/0.048)^2][1 + (Z/0.32)^2][1 + (Z/1.35)^2])
 *   impulse          Kinney–Graham:  I = 6.7 W^(1/3) sqrt(1 + (Z/0.23)^4) / (Z^2 cbrt(1 + (Z/1.55)^3))   (Pa·s)
 *   crater           a lattice point fails where dP(r) exceeds its material strength: r_mat = Zcrit(strength) W^(1/3)
 *                    (bisection on Z, cached per material). Soft topsoil blows out wider than the rock under it;
 *                    bedrock never fails.
 *   worms            Peff = dP · shield · REFLECT, dmg = DMG_MAX (Peff / (Peff + P_HALF))^2; far out dP ~ 1/R
 *                    (energy flux ~ 1/R^2, pressure ~ its square root) so damage ~ 1/R^2.
 *                    shield = 0.25 + 0.75 exp(-L / SHIELD_L), L = metres of solid on the centre→target line.
 *                    knock-back dv = I · shield · AREA_K / WORM_KG − FRICTION_DV (capped at VMAX), radial + upward.
 * Other subsystems react through optional hooks (feature-detected, so this module works alone):
 *   SS.bodies.blast(S, c, W), SS.veg.blast(S, c, W), SS.veg.ignite(S, c, r), SS.water.blast(S, c, W), SS.lava.blast(S, c, W),
 *   SS.scatter.blast(S, c, W) — props: shatter crates, set off barrels / mines, ignite.
 *   SS.collapse_hook(S, box) — called with the edited lattice box when settings.collapse is on.
 * C port: plain functions over (GameState*, World*); the per-material Zcrit table is a static array. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, B = C.BLAST, MAT = C.MAT;
  const BL = SS.blast = {};
  const W = () => SS.world;

  /* ---------- free-air blast curves ---------- */
  BL.overpressure_z = function (Z) {                  // kPa at scaled distance Z (m/kg^(1/3))
    const z = Math.max(Z, 0.05);
    const num = 808 * (1 + (z / 4.5) * (z / 4.5));
    const den = Math.sqrt((1 + (z / 0.048) * (z / 0.048)) * (1 + (z / 0.32) * (z / 0.32)) * (1 + (z / 1.35) * (z / 1.35)));
    return B.P0 * num / den;
  };
  BL.overpressure = (R, Wkg) => BL.overpressure_z(R / M.cbrt(Wkg));
  BL.impulse = function (R, Wkg) {                    // Pa·s
    const w3 = M.cbrt(Wkg), z = Math.max(R / w3, 0.05);
    return 6.7 * w3 * Math.sqrt(1 + M.pow(z / 0.23, 4)) / (z * z * M.cbrt(1 + M.pow(z / 1.55, 3)));
  };
  /* scaled distance where the overpressure falls to p (kPa); overpressure_z is monotonic decreasing */
  BL.z_for_pressure = function (p) {
    let lo = 0.05, hi = 60;
    if (BL.overpressure_z(hi) >= p) return hi;
    for (let it = 0; it < 48; it++) { const mid = 0.5 * (lo + hi); if (BL.overpressure_z(mid) > p) lo = mid; else hi = mid; }
    return 0.5 * (lo + hi);
  };
  const ZCRIT = new Float32Array(C.MATS.length);      // per material; 0 = never fails (air, bedrock)
  let zMaxSolid = 0;
  for (let m = 1; m < C.MATS.length; m++) {
    if (C.MATS[m].strength >= 1e9) continue;          // bedrock, girder steel: never fail
    ZCRIT[m] = BL.z_for_pressure(C.MATS[m].strength);
    zMaxSolid = Math.max(zMaxSolid, ZCRIT[m]);
  }
  BL.ZCRIT = ZCRIT;
  BL.crater_radius = (m, Wkg) => ZCRIT[m] * M.cbrt(Wkg);
  // PoC pressureFactor (L2799): 1 at the centre, 0.35 at the hole's edge R, 0 beyond 2.1 R
  BL.poc_factor = function (d, R) {
    if (R <= 0 || d >= R * 2.1) return 0;
    if (d <= R) return 1 - 0.65 * Math.sqrt(Math.max(0, d) / R);
    return 0.35 * (1 - Math.sqrt(M.clamp((d - R) / (R * 1.1), 0, 1)));
  };

  /* ---------- crater ----------
   * Each solid lattice point within reach gets d = min(d, r - r_mat(its material)): a sphere SDF per material, so
   * the crater wall steps where the material changes. Air points take the smallest r_mat among their solid face
   * neighbours (no recession of untouched surfaces); with no solid neighbour they take the largest radius.
   * Returns { removed, byMat[], box } (box = edited lattice range, for collapse and remeshing). */
  BL.crater = function (c, Wkg) {
    const w = W(), H = w.H, NX = w.NX, NY = w.NY, NZ = w.NZ, SXY = NX * NY, D = w.d, Mt = w.mat, Ht = w.heat;
    const w3 = M.cbrt(Wkg), rBig = Math.min(B.R_MAX, zMaxSolid * w3);
    const i0 = Math.max(1, Math.floor((c.x - rBig) / H) - 1), i1 = Math.min(NX - 2, Math.ceil((c.x + rBig) / H) + 1);
    const j0 = Math.max(1, Math.floor((c.y - rBig) / H) - 1), j1 = Math.min(NY - 2, Math.ceil((c.y + rBig) / H) + 1);
    const k0 = Math.max(1, Math.floor((c.z - rBig) / H) - 1), k1 = Math.min(NZ - 2, Math.ceil((c.z + rBig) / H) + 1);
    const byMat = new Int32Array(C.MATS.length);
    let removed = 0;
    if (i1 < i0 || j1 < j0 || k1 < k0) return { removed, byMat, box: null };       // wholly outside the lattice (dry far dunes)
    // pass 1: targets from the unedited field (air points must see the original neighbours)
    const nx = i1 - i0 + 1, ny = j1 - j0 + 1, nz = k1 - k0 + 1, tgt = new Float32Array(nx * ny * nz);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const o = (k * NY + j) * NX + i, q = ((k - k0) * ny + (j - j0)) * nx + (i - i0);
      const r = M.len3(i * H - c.x, j * H - c.y, k * H - c.z);
      tgt[q] = 1e9;
      if (r > rBig + H) continue;
      const m = Mt[o];
      let rm;
      if (D[o] > 0) { if (!ZCRIT[m]) continue; rm = ZCRIT[m] * w3; }
      else {
        rm = 1e9;
        const nb = [o - 1, o + 1, o - NX, o + NX, o - SXY, o + SXY];
        for (let t = 0; t < 6; t++) { const n = nb[t]; if (D[n] > 0) rm = Math.min(rm, ZCRIT[Mt[n]] * w3); }
        if (rm === 1e9) rm = rBig;
      }
      tgt[q] = r - Math.min(rm, rBig);
    }
    // pass 2: apply (never to the frozen ring of a dry world, D6)
    const fz = w.frz ? w.frz.slot : null;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const o = (k * NY + j) * NX + i, v = tgt[((k - k0) * ny + (j - j0)) * nx + (i - i0)];
      if (v >= D[o] || (fz && fz[k * NX + i] >= 0)) continue;
      if (D[o] > 0 && v <= 0) { removed++; byMat[Mt[o]]++; Mt[o] = MAT.AIR; Ht[o] = 0; }
      D[o] = Math.max(v, -3);
    }
    w.mark(i0, j0, k0, i1, j1, k1);
    return { removed, byMat, box: { i0, j0, k0, i1, j1, k1 } };
  };

  /* ---------- effect on worms ---------- */
  // dmgPoC: the weapon's PoC damage (explode(x, y, R, dmg)); the worm takes round(dmgPoC x pressureFactor x cover) and
  // is thrown with (dmgPoC f 6.5 + 50 f) px/s, as in the PoC (P24.1: before, every charge did ~70 x f(W)^2 from the
  // overpressure, so a dying worm's or a grave's small pop hurt like a bazooka)
  BL.worm_effect = function (c, Wkg, pos, dmgPoC) {   // pure: { dmg, dv, dir[3], dP, shield }
    const w = W(), dx = pos.x - c.x, dy = pos.y - c.y, dz = pos.z - c.z, r = M.len3(dx, dy, dz);
    const re = Math.max(0.25, r - 0.35);                // to the body surface (worm radius ~0.35 m)
    const L = w.solid_len(c.x, c.y, c.z, pos.x, pos.y, pos.z);
    const shield = 0.25 + 0.75 * M.exp(-L / B.SHIELD_L);
    const dP = BL.overpressure(re, Wkg), pe = dP * shield * B.REFLECT, f = pe / (pe + B.P_HALF);
    // knock-back = the PoC's (explode L2845-2856, 1 px = 0.0643 m): f = pressureFactor(d, R) with d = dist - 0.6 worm
    // radius and R the PoC crater radius (44 px x W^1/3), x its cover factor beyond R; dv = (dmg f 6.5 + 50 f) px/s
    // with the PoC damage of a charge that size (~50 W^0.28); the direction is away from the blast + 0.45 up (a worm
    // under a blast is pushed partly down). The worms' own gravity (C.G_WORM) makes the flights the PoC's.
    const Rk = 2.83 * M.cbrt(Wkg), dk = Math.max(0, r - 0.6 * C.WORM_R);
    let fk = dk <= Rk ? 1 - 0.65 * Math.sqrt(dk / Rk) : dk < 2.1 * Rk ? 0.35 * (1 - Math.sqrt((dk - Rk) / (1.1 * Rk))) : 0;
    if (dk > Rk) fk *= Math.max(0.12, M.exp(-L / 1.16));
    const dmgP = dmgPoC != null ? dmgPoC : 50 * M.pow(Wkg, 0.28), dv = (dmgP * fk * 6.5 + 50 * fk) * 0.0643, dmg = dmgP * fk;
    let ux = r > 1e-4 ? dx / r : 0, uy = r > 1e-4 ? dy / r : 1, uz = r > 1e-4 ? dz / r : 0;
    uy += 0.45;
    const ul = M.len3(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    return { dmg, dv, dir: [ux, uy, uz], dP, shield, r };
  };

  /* ---------- entry point ---------- */
  BL.explode = function (S, c, Wkg, opts) {
    const o = opts || {}, sim = SS.sim;
    // P30g: a charge in the water is tamped by it: the bed crater shrinks with the water between the charge and the
    // bed (standoff; e^(-standoff / 0.6 W^1/3) of the charge reaches the bed), a surface burst over deep water leaves
    // the bed untouched; the water itself takes the blast (water.js: cavity, implosion jet, ring wave)
    // (a puddle or a seep film is not water to burst in: WET_D 0.15 m of depth at least)
    let Wc = Wkg, wet = null;
    if (SS.water && S.water && Wkg > 0) {
      const surf = SS.water.surface(S, c.x, c.z), deep = SS.water.depth(S, c.x, c.z) > 0.15;
      if (deep && surf > -90 && surf > c.y - 0.6) wet = surf - c.y;         // the charge's depth under the water (render)
      if (deep && surf > -90 && surf > c.y - 0.1) { const so = Math.max(0, c.y - (surf - SS.water.depth(S, c.x, c.z))); Wc = Wkg * M.exp(-so / (0.6 * M.cbrt(Wkg))); }
    }
    const cr = BL.crater(c, Wc);
    S.lastCrater = cr.box;
    const ev = sim.emit(S, 'explode', { x: c.x, y: c.y, z: c.z, R: 3 * M.cbrt(Wkg), W: Wkg, kind: o.kind || 'blast', removed: cr.removed, byMat: Array.from(cr.byMat), wet });
    // worms (after the crater: the wave travels through the opened hole)
    const d = SS.plane.dir(S);
    let hits = 0;
    for (const w of S.worms) {
      if (w.dead) continue;
      const e = BL.worm_effect(c, Wkg, w.pos, o.dmg);
      if (e.r > 14) continue;
      if (e.dv > 0.01) {                // any blast that reaches a worm throws it, cuts its rope and makes it skid (PoC)
        if (SS.sim.ctl(S, w)) {         // in-plane controlled: project the shove onto the plane
          w.air = true; w.vs += e.dv * (e.dir[0] * d.x + e.dir[2] * d.z); w.vy += e.dv * e.dir[1];
          if (S.rope) S.rope = null; S.hook = null;
        } else {
          w.rest = false; w.vel.x += e.dv * e.dir[0]; w.vel.y += e.dv * e.dir[1]; w.vel.z += e.dv * e.dir[2];
          if (w.rope) w.rope = null;
        }
        w.slide = true; w.flip = false; w.hop = false;
      }
      const dmg = Math.round(e.dmg);
      if (dmg >= 1) { const l = e.r || 1; S.hitDir = e.r > 0.05 ? { x: (w.pos.x - c.x) / l, y: (w.pos.y - c.y) / l, z: (w.pos.z - c.z) / l } : { x: 0, y: -1, z: 0 }; sim.hurt(S, w, dmg, 'the blast'); hits++; }
    }
    ev.hits = hits;
    // other subsystems
    if (SS.bodies && SS.bodies.blast) SS.bodies.blast(S, c, Wkg);
    if (SS.scatter && SS.scatter.blast) SS.scatter.blast(S, c, Wkg);
    if (SS.veg && SS.veg.blast) SS.veg.blast(S, c, Wkg);
    if (SS.veg && SS.veg.ignite) SS.veg.ignite(S, c, B.FIRE_R * M.cbrt(Wkg));
    if (SS.ice) SS.ice.blast(S, c, Wkg);                     // Step I: holes / floes in sea ice (wider under water; BEFORE the water cavity lowers the surface it measures the charge's depth from)
    if (SS.water && SS.water.blast) SS.water.blast(S, c, Wkg);
    if (SS.struct) SS.struct.blast(S, c, Wkg);               // M: steel members cut by close charges, spans fall
    if (SS.spatter) SS.spatter.blast(S, c, Wkg);             // LV4: loosen landed clots (before lava.blast throws new ones)
    if (SS.lava && SS.lava.blast) SS.lava.blast(S, c, Wkg);
    if (S.settings.collapse && SS.collapse_hook && cr.removed > 0) SS.collapse_hook(S, cr.box);
    if (SS.struct && SS.struct.on_edit && cr.removed > 0) SS.struct.on_edit(S);    // an abutment undermined (or collapsed away)
    return ev;
  };
})(window.SS = window.SS || {});
