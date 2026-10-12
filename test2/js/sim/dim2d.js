/* sim/dim2d.js — P68a: the 2D ("classic worms") dimension. Portable, deterministic: only the world arrays, S state and the fixed step.
 * setting `dim`: '3d' (the default: everything as before, bit-identical) | '2d'.
 * Design (one central rule, not scattered checks): a 2D match is the ordinary generator's map cut down to ONE slice and
 * extruded into a thin slab (C.DIM2.SZ m = NZ lattice slices, the middle slice kz is the gameplay plane). The plane never
 * turns (theta = 0, S.O.z = the slab's middle z), so every in-plane system (worm physics, projectiles, rope, bullets,
 * devices) is 2D by construction; the few genuinely 3D things (rigid bodies, loose worms, shrapnel, spatter, crates) are
 * pinned to the plane once per step by constrain(). The lattice stays z-invariant: W.mark calls flatten() after every edit,
 * which copies the middle slice over all slices (so a blast's sphere becomes a prism, a collapse piece a slab).
 * World flags (sim/world.js): W.flat (bool), W.kz (middle slice index), W.zpick(r, m) / W.zin(z, m) (z margins that
 * vanish in 2D: spawn code asks them instead of reading SZ).
 * C mapping: bool world.flat; i32 world.kz; void dim_crop(World*, Job*), void dim_flatten(World*, i0, j0, i1, j1),
 *   void dim_constrain(Game*); every loop is over fixed arrays.
 * API: is(settings), on(S), crop(W, job), flatten(W, i0, j0, i1, j1), constrain(S), z0(W). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const D = SS.dim2d = {};

  D.is = st => !!st && st.dim === '2d';
  D.on = S => !!S && !!S.settings && S.settings.dim === '2d' && SS.world.flat;
  D.z0 = W => W.MZ;

  /* which slice of the generated square map becomes the 2D map: the volcano's cross-section on volcanic maps, the slice with the
   * most cave air on underground maps (scan every 2 m, first maximum), else the centre slice (an island's diameter) */
  function pick_slice(W) {
    const H = W.H, NX = W.NX, NY = W.NY, NZ = W.NZ, F = W.features || {};
    const lo = Math.round(14 / H), hi = NZ - 1 - lo;
    if (F.fort) return Math.round(F.fort.sliceZ / H);                  // P68b: fort mode lays its forts along this slice
    if (W.under) {
      let best = -1, bk = Math.round(W.MZ / H);
      for (let k = lo; k <= hi; k += 4) {
        let n = 0;
        for (let j = 2; j < NY - 2; j++) for (let i = 2; i < NX - 2; i++) if (W.d[(k * NY + j) * NX + i] <= 0) n++;
        if (n > best) { best = n; bk = k; }
      }
      return bk;
    }
    const v = F.volcano;
    if (v) return M.clamp(Math.round(v.z / H), lo, hi);
    return Math.round(W.MZ / H);
  }

  /* shift the generator's features (world z) into the new slab frame; each shared object once */
  function shift_features(F, dz) {
    const seen = [];
    const once = o => { if (!o || seen.indexOf(o) >= 0) return false; seen.push(o); return true; };
    const sz = o => { if (once(o) && typeof o.z === 'number') o.z += dz; };
    for (const v of F.volcanoes || []) sz(v);
    sz(F.volcano);
    for (const c of F.canals || []) for (const q of c.pts || []) if (once(q)) q[2] += dz;
    for (const v of F.vents || []) sz(v);
    for (const p of F.pockets || []) { sz(p); for (const q of p.vein || []) if (once(q)) q[2] += dz; }
    for (const s of F.spires || []) if (once(s)) s[1] += dz;
    for (const b of F.bridges || []) { for (let e = 0; e < 2; e++) if (once(b[e])) b[e][2] += dz; }
    if (F.caves) for (const c of F.caves.chambers || []) sz(c);
  }

  /* crop the finished square lattice to the slab (world.js gen_step calls it before the column tops are built) */
  D.crop = function (W) {
    const H = W.H, NXo = W.NX, NYo = W.NY, NZo = W.NZ, SXY = NXo * NYo;
    const ko = pick_slice(W), z0 = ko * H;
    const d0 = W.d, m0 = W.mat, h0 = W.heat, F = W.features || {}, li0 = F.lavaInit;
    W.resize(W.SX, C.DIM2.SZ);
    const NX = W.NX, NY = W.NY, NZ = W.NZ, kz = (NZ - 1) >> 1;
    for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) {
      const a = ko * SXY + j * NXo, b = (k * NY + j) * NX;
      for (let i = 0; i < NX; i++) { W.d[b + i] = d0[a + i]; W.mat[b + i] = m0[a + i]; W.heat[b + i] = h0[a + i]; }
    }
    if (li0) {
      const li = new Float32Array(NX * NZ);
      for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) li[k * NX + i] = li0[ko * NXo + i];
      F.lavaInit = li;
    }
    shift_features(F, W.MZ - z0);
    W.flat = true; W.kz = kz; W.sepk = C.DIM2.SEP_K;
    if (SS.collapse) SS.collapse.remove_floating_all(W);               // P72: the slice cuts 3D arches / bridges / lips whose support was sideways: nothing may float in the section
    W.dry = false; W.far = null; W.circ = null; W.frz = null;          // a finite slab: no endless dunes, no frozen ring (the desert's hot-sand rules are 3D)
  };

  /* copy the middle slice over every slice inside the lattice box [i0..i1] x [j0..j1] (world.js mark) */
  D.flatten = function (W, i0, j0, i1, j1) {
    const NX = W.NX, NY = W.NY, NZ = W.NZ, SXY = NX * NY, kz = W.kz, d = W.d, mt = W.mat, ht = W.heat, ck = W.crack;
    for (let j = j0; j <= j1; j++) {
      const a = kz * SXY + j * NX;
      for (let i = i0; i <= i1; i++) {
        const dv = d[a + i], mv = mt[a + i], hv = ht[a + i], cv = ck ? ck[a + i] : 0;
        for (let k = 0; k < NZ; k++) {
          if (k === kz) continue;
          const o = k * SXY + j * NX + i; d[o] = dv; mt[o] = mv; ht[o] = hv;
          if (ck) ck[o] = cv;                                          // P66b cracks: the damage field is z-invariant too
        }
      }
    }
  };

  /* once per step, after every subsystem: pin everything that can leave the plane back onto it. The plane itself is fixed. */
  D.constrain = function (S) {
    const W = SS.world, z0 = W.MZ;
    S.theta = 0; S.thetaGoal = null; S.O.z = z0; S.ctx = 0; S.inspect = 0;
    for (let i = 0; i < S.worms.length; i++) { const w = S.worms[i]; w.pos.z = z0; if (w.vel) w.vel.z = 0; if (w.rope) w.rope.z = z0; }
    for (let i = 0; i < S.bodies.length; i++) {
      const b = S.bodies[i];
      b.pos.z = z0; b.vel.z = 0; b.w.x = 0; b.w.y = 0;
      const l = M.len2(b.q.z, b.q.w);                               // orientation: a rotation about z only (the in-plane angle)
      if (l > 1e-9) { b.q.x = 0; b.q.y = 0; b.q.z /= l; b.q.w /= l; } else { b.q.x = 0; b.q.y = 0; b.q.z = 0; b.q.w = 1; }
    }
    for (let i = 0; i < S.crates.length; i++) { const c = S.crates[i]; c.pos.z = z0; if (c.vel) c.vel.z = 0; }
    for (let i = 0; i < S.frags.length; i++) { const f = S.frags[i]; f.z = z0; f.vz = 0; }
    for (let i = 0; i < S.spat.length; i++) { const f = S.spat[i]; f.z = z0; f.vz = 0; }
  };
})(window.SS = window.SS || {});
