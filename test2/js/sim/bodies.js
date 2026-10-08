/* sim/bodies.js — rigid bodies against the voxel field (portable, deterministic; no DOM / Three.js).
 *
 * Bodies are point-sampled: each carries a few dozen collision spheres (local x, y, z, r) on its shell. A sphere is in
 * contact when the world density there says it is inside rock: signed distance ~ sample / |grad sample| (the density
 * field is ~0.7 per metre on flat ground, steeper on cut faces). Contacts are solved with sequential impulses
 * (accumulated normal impulse >= 0, Coulomb friction mu, restitution only above 1 m/s, Baumgarte position bias), then
 * the body is integrated (semi-implicit Euler, quaternion orientation). A body that stays slow for SLEEP s sleeps;
 * detached terrain chunks re-bake into the field when they sleep (settled rubble is real terrain afterwards).
 * Bodies hit worms (damage ~ kinetic energy of the impact), take blast impulses, and expose 2D cross-sections on the
 * collision plane for worm / projectile collisions (S.planeBodies, see plane.js).
 *
 * C layout: struct Body { i32 id; u8 kind; vec3 pos; quat q; vec3 vel, w; f32 mass, invM; vec3 Ib; f32 *pts (x,y,z,r);
 *   i32 np; f32 rb, mu, e, sleepT, age; u8 asleep, mat; Grid *grid; vec3 com0; };
 * API: from_piece(S, piece), add_box(S, pos, half, mass, mat), add_ball(S, pos, r, mass, mat),
 *   add_shape(S, kind, pos, mass, Ib, pts, mat), step(S, dt),
 *   plane_sections(S), nudge(S, b, dir, J), blast(S, c, W), settled(S), remove(S, b).
 */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT;
  const B = SS.bodies = {};
  const W = () => SS.world;
  const K = C.BODY;
  const v3 = () => ({ x: 0, y: 0, z: 0 });
  const tp = v3(), tn = v3(), tr = v3(), tq = v3();

  /* ---------- creation ---------- */
  function make(S, kind, pos, mass, Ib, pts, mat) {
    let rb = 0;
    for (let i = 0; i < pts.length; i += 4) rb = Math.max(rb, M.len3(pts[i], pts[i + 1], pts[i + 2]) + pts[i + 3]);
    const md = C.MATS[mat] || C.MATS[MAT.ROCK];
    const b = {
      id: S.bodyId = (S.bodyId || 0) + 1, kind, pos: { x: pos.x, y: pos.y, z: pos.z }, q: M.q_ident(), vel: v3(), w: v3(),
      mass, invM: 1 / mass, Ib: { x: Ib.x, y: Ib.y, z: Ib.z }, pts, np: pts.length / 4, rb, mat, mu: md.mu || 0.6,
      e: kind === 'chunk' ? 0.12 : 0.25, sleepT: 0, age: 0, asleep: false, grid: null, com0: null, acc: null
    };
    b.acc = new Float32Array(b.np * 2);
    S.bodies.push(b);
    if (S.bodies.length > K.MAX) {                    // too many: drop the oldest sleeping loose body, never a prop if avoidable
      // (never the body being made: the caller keeps using it, and props get their 'prop' tag only after make)
      const n = S.bodies.length - 1;
      let k = -1;
      for (let i = 0; i < n && k < 0; i++) { const o = S.bodies[i]; if (o.asleep && o.kind !== 'chunk' && !o.prop) k = i; }
      for (let i = 0; i < n && k < 0; i++) if (!S.bodies[i].prop) k = i;
      if (k < 0) k = 0;
      B.remove(S, S.bodies[k]);
    }
    return b;
  }
  /* detached terrain piece from SS.collapse.detach (local grid, com, mass, inertia about com, shell points) */
  B.from_piece = function (S, p) {
    const b = make(S, 'chunk', p.com, p.mass, p.inertia, p.pts, p.mat);
    b.grid = p.grid; b.com0 = { x: p.com.x, y: p.com.y, z: p.com.z }; b.voxels = p.voxels;
    return b;
  };
  B.add_box = function (S, pos, half, mass, mat) {
    const pts = [], r = Math.min(half.x, half.y, half.z) * 0.35;
    for (let a = -1; a <= 1; a++) for (let c = -1; c <= 1; c++) for (let d = -1; d <= 1; d++) {
      if (!a && !c && !d) continue;
      pts.push(a * (half.x - r), c * (half.y - r), d * (half.z - r), r);
    }
    const Ib = { x: mass * (half.y * half.y + half.z * half.z) / 3, y: mass * (half.x * half.x + half.z * half.z) / 3, z: mass * (half.x * half.x + half.y * half.y) / 3 };
    const b = make(S, 'box', pos, mass, Ib, new Float32Array(pts), mat);
    b.half = { x: half.x, y: half.y, z: half.z };
    return b;
  };
  B.add_ball = function (S, pos, r, mass, mat) {
    const I = 0.4 * mass * r * r;
    const b = make(S, 'ball', pos, mass, { x: I, y: I, z: I }, new Float32Array([0, 0, 0, r]), mat);
    b.r = r;
    return b;
  };
  /* generic body from shell spheres (props: barrels, mines, boulders); Ib = principal inertia in body space */
  B.add_shape = function (S, kind, pos, mass, Ib, pts, mat) { return make(S, kind, pos, mass, Ib, new Float32Array(pts), mat); };
  B.remove = function (S, b) { const i = S.bodies.indexOf(b); if (i >= 0) S.bodies.splice(i, 1); };

  /* ---------- helpers ---------- */
  // signed distance into rock (> 0 inside) and outward normal at p
  function sdf(x, y, z, n) {
    const w = W(), s = w.sample(x, y, z), e = 0.2;
    const gx = w.sample(x + e, y, z) - w.sample(x - e, y, z), gy = w.sample(x, y + e, z) - w.sample(x, y - e, z), gz = w.sample(x, y, z + e) - w.sample(x, y, z - e);
    const l = M.len3(gx, gy, gz);
    if (l < 1e-6) { n.x = 0; n.y = 1; n.z = 0; return s / 0.7; }
    n.x = -gx / l; n.y = -gy / l; n.z = -gz / l;
    return s / (l / (2 * e));
  }
  // penetration of a sphere (centre p, radius r) into rock, normal -> n; <= 0 = no contact. The linear estimate
  // r + sdf alone is fooled by steep air-to-air gradients (a removed chunk leaves -0.6 inside, -3 around it), so the
  // sphere's deepest point (p - n r) must really be in rock.
  function contact(x, y, z, r, n) {
    const pen = sdf(x, y, z, n) + r;
    if (pen <= 0) return 0;
    return W().sample(x - n.x * r, y - n.y * r, z - n.z * r) > 0 ? Math.max(pen, 0.005) : 0;
  }
  // world inverse inertia times v (R diag(1/Ib) R^T v) -> out
  function invI(b, vx, vy, vz, out) {
    M.q_rot_inv(b.q, vx, vy, vz, tq);
    tq.x /= b.Ib.x; tq.y /= b.Ib.y; tq.z /= b.Ib.z;
    return M.q_rot(b.q, tq.x, tq.y, tq.z, out);
  }
  function applyImpulse(b, rx, ry, rz, jx, jy, jz) {
    b.vel.x += jx * b.invM; b.vel.y += jy * b.invM; b.vel.z += jz * b.invM;
    invI(b, ry * jz - rz * jy, rz * jx - rx * jz, rx * jy - ry * jx, tr);
    b.w.x += tr.x; b.w.y += tr.y; b.w.z += tr.z;
  }
  // effective inverse mass along direction (dx, dy, dz) at arm r
  function kEff(b, rx, ry, rz, dx, dy, dz) {
    const cx = ry * dz - rz * dy, cy = rz * dx - rx * dz, cz = rx * dy - ry * dx;
    invI(b, cx, cy, cz, tr);
    const ax = tr.y * rz - tr.z * ry, ay = tr.z * rx - tr.x * rz, az = tr.x * ry - tr.y * rx;
    return b.invM + ax * dx + ay * dy + az * dz;
  }
  function wake(b) { b.asleep = false; b.sleepT = -1; }

  /* ---------- simulation ---------- */
  const wv = { x: 0, y: 0, z: 0 };                 // water velocity scratch
  const lvb = { x: 0, y: 0, z: 0 };                // lava velocity scratch
  // contact scratch: arm r, normal n, fixed tangent basis t1 / t2 (B1), penetration, approach speed, accumulated
  // normal / tangent (2D) / torsional impulses, contact sphere radius
  const CT = [];
  for (let i = 0; i < 64; i++) CT.push({ rx: 0, ry: 0, rz: 0, nx: 0, ny: 0, nz: 0, t1x: 0, t1y: 0, t1z: 0, t2x: 0, t2y: 0, t2z: 0, pen: 0, vn0: 0, jn: 0, j1: 0, j2: 0, jw: 0, r1: 0, r2: 0, rs: 0 });
  function stepBody(S, b, dt) {
    const w = W(), G = C.G;
    b.age += dt;
    if (b.iceLock) { b.vel.x = b.vel.y = b.vel.z = 0; b.w.x = b.w.y = b.w.z = 0; b.floatT = (b.floatT || 0) + dt; return 0; }   // Step I: frozen in
    // gravity, water (buoyancy of the submerged share + drag), air damping
    b.vel.y -= G * dt;
    const sea = SS.sim.surface_at ? SS.sim.surface_at(S, b.pos.x, b.pos.z) : w.SEA;
    let sub = 0;
    if (b.pos.y < sea + b.rb * 0.5) {
      sub = M.clamp((sea - (b.pos.y - b.rb * 0.5)) / Math.max(0.2, b.rb), 0, 1);
      const rho = b.mass / Math.max(1e-3, bodyVol(b));
      if (!b.wet && sub > 0.05) {
        // entering the water: splash and a dip in the surface (stronger for heavy, fast bodies); the dip itself can
        // briefly un-wet the body, so one splash per second at most
        b.wet = true;
        const sp = -b.vel.y;
        if (sp > 1.5 && S.time - (b.splashT === undefined ? -9 : b.splashT) > 1) {
          b.splashT = S.time;
          const r = Math.max(0.5, b.rb * 1.2), amp = Math.min(0.5, 0.02 * sp * M.cbrt(b.mass));
          if (SS.water && SS.water.disturb) SS.water.disturb(S, b.pos.x, b.pos.z, r, -amp);
          SS.sim.emit(S, 'splash', { x: b.pos.x, y: sea, z: b.pos.z, size: Math.min(1.6, 0.3 + 0.08 * sp * M.cbrt(b.mass / 20)), body: b.id });
        }
      }
      b.vel.y += G * Math.min(1.5, 1000 / rho) * sub * dt;
      // drag toward the local water velocity (floating props drift with the flow, waves push wreckage around):
      // linear (WATER_DRAG) + quadratic 0.5 rho_w Cd A |v| v / m, integrated implicitly (a 25 kg crate hitting the
      // water at 7 m/s stops within centimetres, a rock keeps going)
      if (SS.water && S.water) SS.water.vel(S, b.pos.x, b.pos.z, wv); else wv.x = wv.z = 0;
      const rx = b.vel.x - wv.x, ry = b.vel.y, rz = b.vel.z - wv.z, vr = Math.sqrt(rx * rx + ry * ry + rz * rz);
      const cq = 500 * K.WATER_CD * Math.PI * b.rb * b.rb / b.mass;
      const k = M.exp(-K.WATER_DRAG * sub * dt) / (1 + cq * sub * vr * dt);
      b.vel.x = wv.x + rx * k; b.vel.y = ry * k; b.vel.z = wv.z + rz * k;
      b.w.x *= k; b.w.y *= k; b.w.z *= k;
    } else if (b.pos.y > sea + b.rb) b.wet = false;
    // LV3 open lava (2600 kg/m3, very viscous): buoyancy of the immersed share (a crate or a drum rides high, rock
    // hangs near neutral and sinks slowly) and a strong viscous drag toward the surface velocity (1.5 x the mean)
    let subL = 0;
    if (SS.lava && S.lava) {
      const ls = SS.lava.surface_at(S, b.pos.x, b.pos.z);
      if (ls > 0 && b.pos.y < ls + b.rb * 0.5 && b.pos.y + b.rb > w.top_at(b.pos.x, b.pos.z) - 0.5) {   // (not in a cave under the column)
        subL = M.clamp((ls - (b.pos.y - b.rb * 0.5)) / Math.max(0.2, b.rb), 0, 1);
        const rho = b.mass / Math.max(1e-3, bodyVol(b));
        const LA = C.LAVA, cool = M.clamp(1 - SS.lava.temp_at(S, b.pos.x, b.pos.z), 0, 1);
        b.vel.y += G * Math.min(LA.BUOY_MAX, LA.RHO / rho) * subL * dt;
        SS.lava.vel_at(S, b.pos.x, b.pos.z, lvb); lvb.x *= 1.5; lvb.z *= 1.5;
        const k = M.exp(-3 * Math.PI * LA.MU_SURF * M.exp(LA.NU_K * cool) * 2 * b.rb / b.mass * subL * dt);   // Stokes, implicit
        b.vel.x = lvb.x + (b.vel.x - lvb.x) * k; b.vel.y *= k; b.vel.z = lvb.z + (b.vel.z - lvb.z) * k;
        b.w.x *= k; b.w.y *= k; b.w.z *= k;
      }
    }
    b.inLava = subL;
    const la = M.exp(-K.LIN_DAMP * dt), aa = M.exp(-K.ANG_DAMP * dt);
    b.vel.x *= la; b.vel.y *= la; b.vel.z *= la; b.w.x *= aa; b.w.y *= aa; b.w.z *= aa;
    // contacts
    let nc = 0;
    for (let i = 0; i < b.np && nc < CT.length; i++) {
      M.q_rot(b.q, b.pts[i * 4], b.pts[i * 4 + 1], b.pts[i * 4 + 2], tp);
      const px = b.pos.x + tp.x, py = b.pos.y + tp.y, pz = b.pos.z + tp.z;
      let pen = contact(px, py, pz, b.pts[i * 4 + 3], tn);
      // Step I: sea ice carries a body that its thickness can bear (Gold), else it breaks under it; a body already
      // afloat is not a load on the ice that forms around it (it freezes in: ice.js iceLock)
      if (pen <= 0 && SS.ice && S.ice && !b.iceLock && !(sub > 0.02)) {
        const r = b.pts[i * 4 + 3], it = SS.ice.top_at(S, px, pz);
        if (it > -1e8 && py - r < it && py > it - 0.4) {
          if (SS.ice.supports(S, px, pz, b.mass)) { pen = it - (py - r); tn.x = 0; tn.y = 1; tn.z = 0; }
          else SS.ice.load(S, px, pz, b.mass, 'weight');
        }
      }
      if (pen <= 0) continue;
      const c = CT[nc++];
      c.rx = tp.x; c.ry = tp.y; c.rz = tp.z; c.nx = tn.x; c.ny = tn.y; c.nz = tn.z; c.pen = pen; c.jn = 0; c.j1 = 0; c.j2 = 0; c.jw = 0; c.r1 = 0; c.r2 = 0;
      c.rs = b.pts[i * 4 + 3];
      // tangent basis: t1 ⟂ n (from the axis least aligned with n), t2 = n × t1
      let ax = Math.abs(tn.x) < 0.6 ? 1 : 0, ay = ax ? 0 : 1;
      let t1x = ay * tn.z, t1y = -ax * tn.z, t1z = ax * tn.y - ay * tn.x; const tl = M.len3(t1x, t1y, t1z) || 1;
      t1x /= tl; t1y /= tl; t1z /= tl;
      c.t1x = t1x; c.t1y = t1y; c.t1z = t1z;
      c.t2x = tn.y * t1z - tn.z * t1y; c.t2y = tn.z * t1x - tn.x * t1z; c.t2z = tn.x * t1y - tn.y * t1x;
      c.vn0 = (b.vel.x + b.w.y * c.rz - b.w.z * c.ry) * c.nx + (b.vel.y + b.w.z * c.rx - b.w.x * c.rz) * c.ny + (b.vel.z + b.w.x * c.ry - b.w.y * c.rx) * c.nz;
    }
    if (nc) {
      const mat = w.mat_at(b.pos.x, b.pos.y - b.rb, b.pos.z), mu = Math.sqrt(b.mu * ((C.MATS[mat] && C.MATS[mat].mu) || 0.6));
      for (let it = 0; it < K.ITERS; it++) for (let q = 0; q < nc; q++) {
        const c = CT[q];
        let vx = b.vel.x + b.w.y * c.rz - b.w.z * c.ry, vy = b.vel.y + b.w.z * c.rx - b.w.x * c.rz, vz = b.vel.z + b.w.x * c.ry - b.w.y * c.rx;
        const vn = vx * c.nx + vy * c.ny + vz * c.nz;
        const target = c.vn0 < -1 ? -b.e * c.vn0 : 0;     // no velocity bias: penetration is projected out below
        let jn = (target - vn) / kEff(b, c.rx, c.ry, c.rz, c.nx, c.ny, c.nz);
        const acc = Math.max(0, c.jn + jn); jn = acc - c.jn; c.jn = acc;
        applyImpulse(b, c.rx, c.ry, c.rz, jn * c.nx, jn * c.ny, jn * c.nz);
        // friction (B1): a 2D impulse in the fixed tangent basis, the ACCUMULATED vector clamped to the cone |jt| <= mu jn.
        // (Accumulating one scalar along a direction re-taken every iteration let the summed impulse leave the cone and
        // overshoot: a resting body on a slope kept being kicked.)
        vx = b.vel.x + b.w.y * c.rz - b.w.z * c.ry; vy = b.vel.y + b.w.z * c.rx - b.w.x * c.rz; vz = b.vel.z + b.w.x * c.ry - b.w.y * c.rx;
        const v1 = vx * c.t1x + vy * c.t1y + vz * c.t1z, v2 = vx * c.t2x + vy * c.t2y + vz * c.t2z;
        let a1 = c.j1 - v1 / kEff(b, c.rx, c.ry, c.rz, c.t1x, c.t1y, c.t1z), a2 = c.j2 - v2 / kEff(b, c.rx, c.ry, c.rz, c.t2x, c.t2y, c.t2z);
        const lim = mu * c.jn, al = M.len2(a1, a2);
        if (al > lim) { a1 *= lim / al; a2 *= lim / al; }
        const d1 = a1 - c.j1, d2 = a2 - c.j2; c.j1 = a1; c.j2 = a2;
        applyImpulse(b, c.rx, c.ry, c.rz, d1 * c.t1x + d2 * c.t2x, d1 * c.t1y + d2 * c.t2y, d1 * c.t1z + d2 * c.t2z);
        // torsional friction: spin about the normal through a contact patch of radius ~TORSION_R x the sphere radius
        // (a point contact cannot resist it, so a body could yaw in place forever)
        invI(b, c.nx, c.ny, c.nz, tr);
        const kw = tr.x * c.nx + tr.y * c.ny + tr.z * c.nz;
        if (kw > 1e-9) {
          const wn = b.w.x * c.nx + b.w.y * c.ny + b.w.z * c.nz, limw = mu * c.jn * K.TORSION_R * c.rs;
          const aw = M.clamp(c.jw - wn / kw, -limw, limw), dw = aw - c.jw; c.jw = aw;
          invI(b, c.nx * dw, c.ny * dw, c.nz * dw, tr); b.w.x += tr.x; b.w.y += tr.y; b.w.z += tr.z;
          // rolling resistance (Coulomb, soil deformation under the load): the rolling spin (about t1 / t2) is opposed by
          // at most ROLL_MU jn rs, so a round body only rolls where the slope's tan exceeds ~ROLL_MU
          invI(b, c.t1x, c.t1y, c.t1z, tr); const k1 = tr.x * c.t1x + tr.y * c.t1y + tr.z * c.t1z;
          invI(b, c.t2x, c.t2y, c.t2z, tr); const k2 = tr.x * c.t2x + tr.y * c.t2y + tr.z * c.t2z;
          const w1 = b.w.x * c.t1x + b.w.y * c.t1y + b.w.z * c.t1z, w2 = b.w.x * c.t2x + b.w.y * c.t2y + b.w.z * c.t2z;
          let r1 = c.r1 - w1 / k1, r2 = c.r2 - w2 / k2; const limr = K.ROLL_MU * c.jn * c.rs, rl = M.len2(r1, r2);
          if (rl > limr) { r1 *= limr / rl; r2 *= limr / rl; }
          const e1 = r1 - c.r1, e2 = r2 - c.r2; c.r1 = r1; c.r2 = r2;
          invI(b, e1 * c.t1x + e2 * c.t2x, e1 * c.t1y + e2 * c.t2y, e1 * c.t1z + e2 * c.t2z, tr); b.w.x += tr.x; b.w.y += tr.y; b.w.z += tr.z;
        }
      }
    }
    // position projection (instead of a Baumgarte velocity bias, which pumped energy into resting bodies through the
    // noisy penetration estimate): move out by BAUMGARTE x the mean excess penetration along the contact normals
    if (nc) {
      let dx = 0, dy = 0, dz = 0, n = 0;
      for (let q = 0; q < nc; q++) { const c = CT[q], e = c.pen - K.SLOP; if (e > 0) { dx += c.nx * e; dy += c.ny * e; dz += c.nz * e; n++; } }
      if (n) { const k = K.BAUMGARTE / n, l = M.len3(dx, dy, dz) * k, cap = l > K.MAX_PUSH * dt ? K.MAX_PUSH * dt / l : 1; b.pos.x += dx * k * cap; b.pos.y += dy * k * cap; b.pos.z += dz * k * cap; }
      b.touchAge = b.age;
    }
    // rolling resistance (soil deformation): spin decays while the body touches ground; also kills contact rocking
    if (nc) { const rd = M.exp(-K.ROLL_DAMP * dt); b.w.x *= rd; b.w.y *= rd; b.w.z *= rd; }
    // afloat: in the water, touching nothing, riding with the flow and not bobbing hard -> counts as settled
    if ((sub > 0 || subL > 0) && !nc && M.len2(b.vel.x - (subL > 0 ? lvb.x : wv.x), b.vel.z - (subL > 0 ? lvb.z : wv.z)) < 0.4 && Math.abs(b.vel.y) < 0.5) b.floatT = (b.floatT || 0) + dt;
    else b.floatT = 0;
    // integrate
    b.pos.x += b.vel.x * dt; b.pos.y += b.vel.y * dt; b.pos.z += b.vel.z * dt;
    M.q_integrate(b.q, b.w.x, b.w.y, b.w.z, dt);
    // sleep: touching something and nearly static for SLEEP s. Judged by displacement over the window (moved < SLEEP_D,
    // turned < SLEEP_A), not by the instantaneous speed: with dozens of contacts and 6 iterations the solver leaves
    // ~0.1-0.25 m/s of noise on a resting piece, which reset an instantaneous test forever.
    if (!b.restP) { b.restP = v3(); b.restQ = { x: 0, y: 0, z: 0, w: 1 }; b.sleepT = -1; }
    const dq = Math.abs(b.q.x * b.restQ.x + b.q.y * b.restQ.y + b.q.z * b.restQ.z + b.q.w * b.restQ.w);
    const still = M.len3(b.pos.x - b.restP.x, b.pos.y - b.restP.y, b.pos.z - b.restP.z) < K.SLEEP_D && dq > M.cos(K.SLEEP_A / 2);
    if (b.age - (b.touchAge || -9) < 0.1 && still && b.sleepT >= 0) b.sleepT += dt;
    else { b.sleepT = 0; b.restP.x = b.pos.x; b.restP.y = b.pos.y; b.restP.z = b.pos.z; b.restQ.x = b.q.x; b.restQ.y = b.q.y; b.restQ.z = b.q.z; b.restQ.w = b.q.w; }
    return nc;
  }
  function bodyVol(b) {
    if (b.vol) return b.vol;
    if (b.kind === 'chunk') return (b.voxels || 1) * M.pow(W().H, 3);
    if (b.kind === 'box') return 8 * b.half.x * b.half.y * b.half.z;
    if (b.kind === 'ball') return 4.18879 * b.r * b.r * b.r;
    return b.mass / 2600;
  }

  /* body vs worms: impact damage ~ KE, knock-back; bodies pass through worms otherwise (worms are not solid to them) */
  function hitWorms(S, b) {
    const sp = M.len3(b.vel.x, b.vel.y, b.vel.z);
    if (sp < K.HIT_V || S.settling) return;
    for (const wm of S.worms) {
      if (wm.dead || S.time - (wm.bodyHitT || -9) < K.HIT_COOL) continue;
      const dx = wm.pos.x - b.pos.x, dy = wm.pos.y - b.pos.y, dz = wm.pos.z - b.pos.z;
      if (dx * dx + dy * dy + dz * dz > (b.rb + C.WORM_R) * (b.rb + C.WORM_R)) continue;
      let hit = -1, best = 1e9;
      for (let i = 0; i < b.np; i++) {
        M.q_rot(b.q, b.pts[i * 4], b.pts[i * 4 + 1], b.pts[i * 4 + 2], tp);
        const d = M.len3(b.pos.x + tp.x - wm.pos.x, b.pos.y + tp.y - wm.pos.y, b.pos.z + tp.z - wm.pos.z) - b.pts[i * 4 + 3];
        if (d < C.WORM_R + 0.1 && d < best) { best = d; hit = i; }
      }
      if (hit < 0) continue;
      // closing speed of the body toward the worm
      const l = M.len3(dx, dy, dz) || 1, nx = dx / l, ny = dy / l, nz = dz / l;
      const vc = b.vel.x * nx + b.vel.y * ny + b.vel.z * nz - ((wm.vel && wm.vel.x || 0) * nx + (wm.vel && wm.vel.y || 0) * ny + (wm.vel && wm.vel.z || 0) * nz);
      if (vc < K.HIT_V) continue;
      // PoC crushWorm (L1997): a big slab of falling ground landing on a worm that stands on something buries it
      const standing = SS.sim.ctl(S, wm) ? !wm.air : wm.rest;
      if (b.kind === 'chunk' && b.mass >= K.CRUSH_KG && b.vel.y < -3 && ny < -0.5 && standing) {
        SS.sim.emit(S, 'buried', { worm: wm, x: wm.pos.x, y: wm.pos.y, z: wm.pos.z });
        SS.sim.log(S, `${wm.name} is buried!`, 0xff9a9a);
        SS.sim.kill_now(S, wm, 'crush');
        continue;
      }
      const me = Math.min(b.mass, K.HIT_MASS), ke = 0.5 * me * vc * vc / 1000;               // kJ
      const dmg = Math.min(K.HIT_MAX, Math.round(ke * K.HIT_PER_KJ));
      wm.bodyHitT = S.time;
      if (dmg > 0) SS.sim.hurt(S, wm, dmg, b.kind === 'chunk' ? 'falling rock' : 'a flying ' + (b.prop || b.kind));
      SS.sim.emit(S, 'bodyhit', { x: wm.pos.x, y: wm.pos.y, z: wm.pos.z, dmg, body: b.id });
      // knock the worm away (and let the body lose a little momentum to it)
      const kv = Math.min(8, vc * 0.6);
      if (SS.sim.ctl(S, wm)) {
        const d = SS.plane.dir(S); S.active.air = true; S.active.vs += (nx * d.x + nz * d.z) * kv; S.active.vy = Math.max(S.active.vy, ny * kv + 1.5);
      } else { wm.rest = false; wm.vel = wm.vel || v3(); wm.vel.x += nx * kv; wm.vel.y += Math.max(0, ny) * kv + 1.5; wm.vel.z += nz * kv; }
      const j = Math.min(b.mass * vc, 80 * kv) * 0.5;
      b.vel.x -= nx * j * b.invM; b.vel.y -= ny * j * b.invM; b.vel.z -= nz * j * b.invM;
    }
  }
  /* body vs body: bounding spheres shrunk to 0.8 rb (rough; enough for a few pieces of rubble) */
  /* body vs body (X1): the shell spheres of both bodies (narrow phase inside the bounding spheres), contact-point
   * impulses with restitution only above 1 m/s and Coulomb friction (like the terrain contacts), then a capped
   * position projection. The old rule pushed bounding spheres apart with a velocity bias every step: two pieces of
   * one detached spire (bounding radii 7.6 + 4.7 m, centres 5 m apart) "overlapped" by metres from the first step
   * and gained ~1 m/s per 1/120 s step: a 93 t block shot up 20 m. Sleeping bodies stay fixed unless hit hard. */
  const PC = [];                                   // pair contacts: {ax, ay, az (arm on a), bx, by, bz, nx, ny, nz, pen, vn0, jn, jt}
  for (let i = 0; i < 32; i++) PC.push({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, nx: 0, ny: 0, nz: 0, pen: 0, vn0: 0, jn: 0, jt: 0 });
  let pairStamp = 0;
  function worldPts(b) {                           // shell sphere centres relative to b.pos (world axes), cached per call
    if (b.wpS === pairStamp) return b.wp;
    if (!b.wp || b.wp.length < b.np * 3) b.wp = new Float32Array(b.np * 3);
    for (let i = 0; i < b.np; i++) { M.q_rot(b.q, b.pts[i * 4], b.pts[i * 4 + 1], b.pts[i * 4 + 2], tp); b.wp[i * 3] = tp.x; b.wp[i * 3 + 1] = tp.y; b.wp[i * 3 + 2] = tp.z; }
    b.wpS = pairStamp; return b.wp;
  }
  const relVn = (a, b, c) => {
    const vax = a.vel.x + a.w.y * c.az - a.w.z * c.ay, vay = a.vel.y + a.w.z * c.ax - a.w.x * c.az, vaz = a.vel.z + a.w.x * c.ay - a.w.y * c.ax;
    const vbx = b.vel.x + b.w.y * c.bz - b.w.z * c.by, vby = b.vel.y + b.w.z * c.bx - b.w.x * c.bz, vbz = b.vel.z + b.w.x * c.by - b.w.y * c.bx;
    tq.x = vbx - vax; tq.y = vby - vay; tq.z = vbz - vaz;
    return tq.x * c.nx + tq.y * c.ny + tq.z * c.nz;
  };
  function pairs(S, dt) {
    const L = S.bodies; pairStamp++;
    for (let i = 0; i < L.length; i++) for (let k = i + 1; k < L.length; k++) {
      const a = L[i], b = L[k];
      if (a.asleep && b.asleep) continue;
      const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z, R = a.rb + b.rb;
      if (dx * dx + dy * dy + dz * dz >= R * R) continue;
      const A = worldPts(a), Bp = worldPts(b);
      let nc = 0, pmax = 0;
      for (let p = 0; p < a.np; p++) {
        const ax = a.pos.x + A[p * 3], ay = a.pos.y + A[p * 3 + 1], az = a.pos.z + A[p * 3 + 2], ra = a.pts[p * 4 + 3];
        for (let q = 0; q < b.np; q++) {
          const ex = b.pos.x + Bp[q * 3] - ax, ey = b.pos.y + Bp[q * 3 + 1] - ay, ez = b.pos.z + Bp[q * 3 + 2] - az, rr = ra + b.pts[q * 4 + 3], e2 = ex * ex + ey * ey + ez * ez;
          if (e2 >= rr * rr || e2 < 1e-10) continue;
          const e = Math.sqrt(e2), pen = rr - e;
          let c;
          if (nc < PC.length) c = PC[nc++];
          else { let m = 0; for (let t = 1; t < nc; t++) if (PC[t].pen < PC[m].pen) m = t; if (PC[m].pen >= pen) continue; c = PC[m]; }
          // contact point midway between the sphere surfaces; arms from each centre of mass
          const mx = ax + ex / e * (ra - pen * 0.5), my = ay + ey / e * (ra - pen * 0.5), mz = az + ez / e * (ra - pen * 0.5);
          c.ax = mx - a.pos.x; c.ay = my - a.pos.y; c.az = mz - a.pos.z; c.bx = mx - b.pos.x; c.by = my - b.pos.y; c.bz = mz - b.pos.z;
          c.nx = ex / e; c.ny = ey / e; c.nz = ez / e; c.pen = pen; c.jn = 0; c.jt = 0;
          pmax = Math.max(pmax, pen);
        }
      }
      if (!nc) continue;
      for (let q = 0; q < nc; q++) { const c = PC[q]; c.vn0 = relVn(a, b, c); }
      // a sleeping body joins in only when struck (closing faster than 0.5 m/s); else it is a fixed obstacle
      let closing = 0; for (let q = 0; q < nc; q++) closing = Math.min(closing, PC[q].vn0);
      if (a.asleep && closing < -0.5) wake(a); if (b.asleep && closing < -0.5) wake(b);
      const da = !a.asleep, db = !b.asleep, e = Math.min(a.e, b.e), mu = Math.sqrt(a.mu * b.mu);
      for (let it = 0; it < K.ITERS; it++) for (let q = 0; q < nc; q++) {
        const c = PC[q];
        const kn = (da ? kEff(a, c.ax, c.ay, c.az, c.nx, c.ny, c.nz) : 0) + (db ? kEff(b, c.bx, c.by, c.bz, c.nx, c.ny, c.nz) : 0);
        if (kn <= 0) continue;
        const vn = relVn(a, b, c), target = c.vn0 < -1 ? -e * c.vn0 : 0;
        let jn = (target - vn) / kn;
        const acc = Math.max(0, c.jn + jn); jn = acc - c.jn; c.jn = acc;
        if (da) applyImpulse(a, c.ax, c.ay, c.az, -jn * c.nx, -jn * c.ny, -jn * c.nz);
        if (db) applyImpulse(b, c.bx, c.by, c.bz, jn * c.nx, jn * c.ny, jn * c.nz);
        // friction
        const vn2 = relVn(a, b, c); let tx = tq.x - vn2 * c.nx, ty = tq.y - vn2 * c.ny, tz = tq.z - vn2 * c.nz;
        const vt = M.len3(tx, ty, tz);
        if (vt > 1e-5) {
          tx /= vt; ty /= vt; tz /= vt;
          const kt = (da ? kEff(a, c.ax, c.ay, c.az, tx, ty, tz) : 0) + (db ? kEff(b, c.bx, c.by, c.bz, tx, ty, tz) : 0);
          if (kt > 0) {
            let jt = -vt / kt; const lim = mu * c.jn, at = M.clamp(c.jt + jt, -lim, lim); jt = at - c.jt; c.jt = at;
            if (da) applyImpulse(a, c.ax, c.ay, c.az, -jt * tx, -jt * ty, -jt * tz);
            if (db) applyImpulse(b, c.bx, c.by, c.bz, jt * tx, jt * ty, jt * tz);
          }
        }
      }
      // position projection along the mean contact normal, split by inverse mass (no velocity bias)
      const ex = pmax - K.SLOP;
      if (ex > 0) {
        let nx = 0, ny = 0, nz = 0; for (let q = 0; q < nc; q++) { nx += PC[q].nx * PC[q].pen; ny += PC[q].ny * PC[q].pen; nz += PC[q].nz * PC[q].pen; }
        const nl = M.len3(nx, ny, nz) || 1, ia = da ? a.invM : 0, ib = db ? b.invM : 0, sum = ia + ib;
        if (sum > 0) {
          const mv = Math.min(K.BAUMGARTE * ex, K.MAX_PUSH * dt) / sum;
          if (da) { a.pos.x -= nx / nl * mv * ia; a.pos.y -= ny / nl * mv * ia; a.pos.z -= nz / nl * mv * ia; }
          if (db) { b.pos.x += nx / nl * mv * ib; b.pos.y += ny / nl * mv * ib; b.pos.z += nz / nl * mv * ib; }
        }
      }
    }
  }

  B.step = function (S, dt) {
    if (!S.bodies.length) return;
    const w = W();
    for (let i = S.bodies.length - 1; i >= 0; i--) {
      const b = S.bodies[i];
      if (b.asleep) {
        // re-check support now and then: wake when the ground under it was blasted away
        if (S.tick % 30 === b.id % 30) {
          let touch = false;
          for (let k = 0; k < b.np && !touch; k++) { M.q_rot(b.q, b.pts[k * 4], b.pts[k * 4 + 1], b.pts[k * 4 + 2], tp); if (contact(b.pos.x + tp.x, b.pos.y + tp.y - 0.08, b.pos.z + tp.z, b.pts[k * 4 + 3], tn) > 0) touch = true; }
          if (!touch) wake(b);
          // LV3: lava reached it (it rises over its base): it floats or is dragged along
          else if (SS.lava && S.lava && SS.lava.surface_at(S, b.pos.x, b.pos.z) > b.pos.y - b.rb * 0.7) wake(b);
          // water reached it: a floater lifts off, anything is shoved by a strong current
          else if (SS.water && S.water) {
            const sea = SS.sim.surface_at(S, b.pos.x, b.pos.z);
            if (sea > b.pos.y - b.rb * 0.5) {
              SS.water.vel(S, b.pos.x, b.pos.z, wv);
              const rose = sea > (b.seaY === undefined ? -99 : b.seaY) + 0.15;   // above the swell at the shore
              if ((rose && b.mass / Math.max(1e-3, bodyVol(b)) < 1000) || M.len2(wv.x, wv.z) > 1.2) wake(b);
            }
          }
        }
        continue;
      }
      stepBody(S, b, dt);
      hitWorms(S, b);
      // gone: fell off the map (dry worlds, D4: the far dunes carry it out to FAR_R) or never settled
      const off = w.dry ? M.len2(b.pos.x - C.DRY.CX, b.pos.z - C.DRY.CZ) > C.DRY.FAR_R : b.pos.x < -10 || b.pos.z < -10 || b.pos.x > w.SX + 10 || b.pos.z > w.SZ + 10;
      if (b.pos.y < -4 || off || (b.age > K.MAX_AGE && !(b.floatT > 1))) {
        SS.sim.emit(S, 'bodygone', { body: b.id }); S.bodies.splice(i, 1); continue;
      }
      if (b.sleepT > K.SLEEP) {
        b.asleep = true; b.vel.x = b.vel.y = b.vel.z = 0; b.w.x = b.w.y = b.w.z = 0;
        b.seaY = SS.sim.surface_at ? SS.sim.surface_at(S, b.pos.x, b.pos.z) : -99;
        if (b.kind === 'chunk' && SS.collapse && b.grid && !w.outside(b.pos.x, b.pos.z)) {   // beyond the lattice (dry) it stays a body
          const added = SS.collapse.rebake(w, b.grid, b.com0, b.pos, b.q);
          SS.sim.emit(S, 'rebake', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, voxels: added });
          S.bodies.splice(i, 1);
        } else SS.sim.emit(S, 'bodysleep', { body: b.id });
      }
    }
    pairs(S, dt);
  };

  /* 2D cross-sections on the collision plane (worms and projectiles collide with them, plane.js) */
  B.plane_sections = function (S) {
    const PB = S.planeBodies; PB.length = 0;
    if (!S.bodies.length) return;
    const P = SS.plane, n = P.nrm(S), d = P.dir(S), ox = S.O.x, oz = S.O.z;
    for (const b of S.bodies) {
      const t = (b.pos.x - ox) * n.x + (b.pos.z - oz) * n.z;
      if (Math.abs(t) > b.rb + 0.1) continue;
      if (b.kind === 'ball') {
        const r2 = b.r * b.r - t * t;
        if (r2 > 0.01) PB.push({ s: (b.pos.x - ox) * d.x + (b.pos.z - oz) * d.z, y: b.pos.y, kind: 0, hs: 0, hy: 0, r: Math.sqrt(r2), ref: b });
        continue;
      }
      let s0 = 1e9, s1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let i = 0; i < b.np; i++) {
        M.q_rot(b.q, b.pts[i * 4], b.pts[i * 4 + 1], b.pts[i * 4 + 2], tp);
        const px = b.pos.x + tp.x, pz = b.pos.z + tp.z, r = b.pts[i * 4 + 3], tt = (px - ox) * n.x + (pz - oz) * n.z;
        if (Math.abs(tt) > r + 0.35) continue;
        const s = (px - ox) * d.x + (pz - oz) * d.z, y = b.pos.y + tp.y;
        s0 = Math.min(s0, s - r); s1 = Math.max(s1, s + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r);
      }
      if (s1 > s0) PB.push({ s: (s0 + s1) / 2, y: (y0 + y1) / 2, kind: 1, hs: (s1 - s0) / 2, hy: (y1 - y0) / 2, r: 0, ref: b });
    }
  };
  /* impulse J (N s) along the world direction dir (normalised here), e.g. a grenade bouncing off */
  B.nudge = function (S, b, dir, J) {
    if (!b || !S.bodies.includes(b)) return;
    const l = M.len3(dir.x, dir.y, dir.z) || 1;
    wake(b);
    b.vel.x += dir.x / l * J * b.invM; b.vel.y += dir.y / l * J * b.invM; b.vel.z += dir.z / l * J * b.invM;
  };
  /* blast: impulse I(R, W) [Pa s] on the body's frontal area, plus a deterministic spin */
  B.blast = function (S, c, Wkg, only) {
    const BL = SS.blast;
    for (const b of only || S.bodies) {
      const dx = b.pos.x - c.x, dy = b.pos.y - c.y, dz = b.pos.z - c.z, dist = M.len3(dx, dy, dz);
      if (dist > 8 * M.cbrt(Wkg) + b.rb) continue;
      const R = Math.max(0.3, dist - b.rb * 0.5), I = BL.impulse(R, Wkg), A = Math.PI * M.pow(Math.min(b.rb, 2) * 0.7, 2);
      const dv = Math.min(K.BLAST_DV, I * A * b.invM);
      if (dv < 0.05) continue;
      const l = dist || 1, ux = dx / l, uy = dy / l + 0.35, uz = dz / l, ul = M.len3(ux, uy, uz);
      wake(b);
      b.vel.x += ux / ul * dv; b.vel.y += uy / ul * dv; b.vel.z += uz / ul * dv;
      const hx = M.hash3(b.id, 1, 7) - 0.5, hy = M.hash3(b.id, 2, 7) - 0.5, hz = M.hash3(b.id, 3, 7) - 0.5;
      const sp = dv / Math.max(0.4, b.rb) * 0.6;
      b.w.x += hx * sp; b.w.y += hy * sp; b.w.z += hz * sp;
    }
  };
  B.settled = S => S.bodies.every(b => b.asleep || b.floatT > 1);
})(window.SS = window.SS || {});
