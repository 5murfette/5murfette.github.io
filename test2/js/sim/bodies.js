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
  /* The body struct (P38 R7 / P3): every field of every body kind exists from the start with its default (before,
   * props, boulders, logs, floating bodies
   * and gadget targets added ~30 fields lazily). C: struct Body gets the fields below; `half` (box), `r` (ball), `grid`
   * / `com0` / `voxels` (chunk), `log` (tree log: a fixed-size segment list) are per-kind unions. prop = the prop kind
   * ('' = none; C: enum Prop, 0 = none). Time stamps are S.time. */
  B.body_make = function (S, kind, pos, mass, Ib, pts, mat) {
    let rb = 0;
    for (let i = 0; i < pts.length; i += 4) rb = M.max(rb, M.len3(pts[i], pts[i + 1], pts[i + 2]) + pts[i + 3]);
    const md = C.MATS[mat] || C.MATS[MAT.ROCK];
    const b = {
      id: S.bodyId = (S.bodyId || 0) + 1, kind, pos: { x: pos.x, y: pos.y, z: pos.z }, q: M.q_ident(), vel: v3(), w: v3(),
      mass, invM: 1 / mass, Ib: { x: Ib.x, y: Ib.y, z: Ib.z }, pts, np: pts.length / 4, rb, mat, mu: md.mu || 0.6,
      e: kind === 'chunk' ? 0.12 : 0.25, sleepT: 0, age: 0, asleep: false, grid: null, com0: null, acc: null,
      // kind data
      half: null, r: 0, voxels: 0, log: null, moai: false, members: null, look: null,
      // props (scatter.js add): wreck / fire / mine state, trap owner, paint
      prop: '', wreck: false, burn: -1, burnT: 0, det: -1, armed: false, disarmed: false, team: -1, planted: -99, revealed: false, armAt: 0,
      dropped: false, fuseSet: null,
      vol: 0, metal: false, paint: 0, shapeId: 0, thrown: 0, held: false,
      // contact / sleep / fluids (bodies.js step, ice.js, water, lava)
      ai: -1, acidT: 0, restP: null, restQ: null, touchAge: 0, wp: null, wpS: 0, wet: false, inLava: 0, floatT: 0, iceLock: false,
      seaY: -99, splashT: -9
    };
    b.acc = new Float32Array(b.np * 2);
    S.bodies.push(b);
    if (S.bodies.length > K.MAX) {                    // too many: drop the oldest sleeping loose body, never a prop if avoidable
      // (never the body being made: the caller keeps using it, and props get their 'prop' tag only after make)
      const n = S.bodies.length - 1;
      let k = -1;
      for (let i = 0; i < n && k < 0; i++) {
        const o = S.bodies[i];
        if (o.asleep && o.kind !== 'chunk' && !o.prop) k = i;
      }
      for (let i = 0; i < n && k < 0; i++)
        if (!S.bodies[i].prop) k = i;
      if (k < 0) k = 0;
      B.remove(S, S.bodies[k]);
    }
    return b;
  };
  /* detached terrain piece from SS.collapse.detach (local grid, com, mass, inertia about com, shell points) */
  B.from_piece = function (S, p) {
    const b = B.body_make(S, 'chunk', p.com, p.mass, p.inertia, p.pts, p.mat);
    b.grid = p.grid; b.com0 = { x: p.com.x, y: p.com.y, z: p.com.z }; b.voxels = p.voxels;
    return b;
  };
  B.add_box = function (S, pos, half, mass, mat) {
    const pts = [], r = M.min(M.min(half.x, half.y), half.z) * 0.35;
    for (let a = -1; a <= 1; a++)
      for (let c = -1; c <= 1; c++)
        for (let d = -1; d <= 1; d++) {
          if (!a && !c && !d) continue;
          pts.push(a * (half.x - r), c * (half.y - r), d * (half.z - r), r);
        }
    const Ib = {
      x: mass * (half.y * half.y + half.z * half.z) / 3,
      y: mass * (half.x * half.x + half.z * half.z) / 3,
      z: mass * (half.x * half.x + half.y * half.y) / 3
    };
    const b = B.body_make(S, 'box', pos, mass, Ib, new Float32Array(pts), mat);
    b.half = { x: half.x, y: half.y, z: half.z };
    return b;
  };
  B.add_ball = function (S, pos, r, mass, mat) {
    const I = 0.4 * mass * r * r;
    const b = B.body_make(S, 'ball', pos, mass, { x: I, y: I, z: I }, new Float32Array([0, 0, 0, r]), mat);
    b.r = r;
    return b;
  };
  /* generic body from shell spheres (props: barrels, mines, boulders); Ib = principal inertia in body space */
  /* a body by id (linear scan; S.bodies <= C.BODY.MAX = 64): null when it is gone. Entities that point at a body store
   * its id (moai, held / grabbed, plane section). */
  B.by_id = function (S, id) {
    const L = S.bodies;
    for (let i = 0; i < L.length; i++)
      if (L[i].id === id) return L[i];
    return null;
  };
  B.add_shape = function (S, kind, pos, mass, Ib, pts, mat) { return B.body_make(S, kind, pos, mass, Ib, new Float32Array(pts), mat); };
  B.remove = function (S, b) {
    const i = S.bodies.indexOf(b);
    if (i >= 0) S.bodies.splice(i, 1);
  };

  /* ---------- helpers ---------- */
  // signed distance into rock (> 0 inside) and outward normal at p
  function sdf(x, y, z, n) {
    const w = W(), s = w.sample(x, y, z), e = 0.2;
    const gx = w.sample(x + e, y, z) - w.sample(x - e, y, z),
      gy = w.sample(x, y + e, z) - w.sample(x, y - e, z),
      gz = w.sample(x, y, z + e) - w.sample(x, y, z - e);
    const l = M.len3(gx, gy, gz);
    if (l < 1e-6) {
      n.x = 0;
      n.y = 1;
      n.z = 0;
      return s / 0.7;
    }
    n.x = -gx / l; n.y = -gy / l; n.z = -gz / l;
    return s / (l / (2 * e));
  }
  // penetration of a sphere (centre p, radius r) into rock, normal -> n; <= 0 = no contact. The linear estimate
  // r + sdf alone is fooled by steep air-to-air gradients (a removed chunk leaves -0.6 inside, -3 around it), so the
  // sphere's deepest point (p - n r) must really be in rock.
  function contact(x, y, z, r, n) {
    const pen = sdf(x, y, z, n) + r;
    if (pen <= 0) return 0;
    return W().sample(x - n.x * r, y - n.y * r, z - n.z * r) > 0 ? M.max(pen, 0.005) : 0;
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
  function wake(b) {
    b.asleep = false;
    b.sleepT = -1;
  }

  /* P118a (Q-12): the support of a SLEEPING body. The wake-up probe used to look at the voxels only, so a body that
   * lies on another sleeping body (a log on a log, a crate on a
   * boulder, a branch on a tree's crown) woke every 0.25 s and fell asleep again 0.6 s later, and held every turn open
   * until the settle cap (6 of 12 sampled 2D matches had a log that never slept; the sleep rule itself counts a contact
   * with any body as support). Now it also counts a chain of touching sleepers that ends in a body with voxel contact,
   * searched breadth-first with each body visited once: a pile that holds itself up in the air (logs resting on each
   * other, the ground under all of them gone) reaches no ground and wakes; the lowest body that loses its ground wakes
   * at its own probe and the ones above it one probe (0.25 s) after it. C: bool sleeper_supported(Game*, Body*). */
  const SUP = [];
  function voxelTouch(S, b) {
    // P68c: the probe goes along the local down
    const ge = S.eow ? SS.eow.gdir(S, b.pos, gdv) : null, gx = ge ? ge.x : 0, gy = ge ? ge.y : -1, gz = ge ? ge.z : 0;
    for (let k = 0; k < b.np; k++) {
      M.q_rot(b.q, b.pts[k * 4], b.pts[k * 4 + 1], b.pts[k * 4 + 2], tp);
      if (contact(b.pos.x + tp.x + gx * 0.08, b.pos.y + tp.y + gy * 0.08, b.pos.z + tp.z + gz * 0.08, b.pts[k * 4 + 3], tn) > 0)
        return true;
    }
    return false;
  }
  function touching(a, o) {                          // any shell sphere of a within 0.1 m of one of o
    const R = a.rb + o.rb + 0.2, dx = o.pos.x - a.pos.x, dy = o.pos.y - a.pos.y, dz = o.pos.z - a.pos.z;
    if (dx * dx + dy * dy + dz * dz > R * R) return false;
    for (let k = 0; k < a.np; k++) {
      M.q_rot(a.q, a.pts[k * 4], a.pts[k * 4 + 1], a.pts[k * 4 + 2], tp);
      const ax = a.pos.x + tp.x, ay = a.pos.y + tp.y, az = a.pos.z + tp.z;
      for (let m = 0; m < o.np; m++) {
        M.q_rot(o.q, o.pts[m * 4], o.pts[m * 4 + 1], o.pts[m * 4 + 2], tq);
        const ex = o.pos.x + tq.x - ax, ey = o.pos.y + tq.y - ay, ez = o.pos.z + tq.z - az, r = a.pts[k * 4 + 3] + o.pts[m * 4 + 3] + 0.1;
        if (ex * ex + ey * ey + ez * ez < r * r) return true;
      }
    }
    return false;
  }
  function sleeperSupported(S, b) {
    if (voxelTouch(S, b)) return true;
    if (S.eow) return false;
    const L = S.bodies;
    SUP.length = 0; SUP.push(b);
    for (let h = 0; h < SUP.length; h++) {
      const a = SUP[h];
      for (let i = 0; i < L.length; i++) {
        const o = L[i];
        if (!o.asleep || SUP.indexOf(o) >= 0 || !touching(a, o)) continue;
        if (voxelTouch(S, o)) return true;
        // (a pile of 32 sleepers: not searched on, taken as held: a probe must not wake a heap for nothing)
        if (SUP.length >= 32) return true;
        SUP.push(o);
      }
    }
    return false;
  }

  /* ---------- simulation ---------- */
  /* One solver for the whole step (P105): forces -> contact generation for every awake body (terrain AND body pairs) ->
   * sequential impulses over the whole contact list -> position projection -> integration -> sleep. Before, each body
   * was solved against the terrain alone and the pairs were solved afterwards: two resting pieces pushed each other
   * into the ground and the ground pushed them back apart every step (the "wiggle"). A contact has a body P that
   * receives +J along the normal and an optional body Q (null = terrain) that receives -J. A static / sleeping partner
   * has pd / qd = false. 2D (world.flat): the integrator is a planar rigid body: linear z and the x / y spins are
   * locked inside the solver (inverse inertia, impulses, contact normals), so nothing has to be snapped back to the
   * plane afterwards (dim2d.constrain is a net). C layout: struct Contact { Body *P, *Q; bool pd, qd; vec3 rP, rQ, n,
   * t1, t2; f32 pen, vn0, jn, j1, j2, jw, r1, r2, rs, mu, e; i32 pair, ai; }. */
  const wv = { x: 0, y: 0, z: 0 };                 // water velocity scratch
  const lvb = { x: 0, y: 0, z: 0 };                // lava velocity scratch
  const CT_MAX = 3072;
  const CT = [];
  let nCT = 0, LOCK = false;
  function ct_new() {
    if (nCT >= CT_MAX) return null;
    if (nCT >= CT.length)
      CT.push({
        P: null, Q: null, pd: false, qd: false, ai: -1, pair: -1, prx: 0, pry: 0, prz: 0, qrx: 0, qry: 0, qrz: 0, nx: 0, ny: 0, nz: 0,
        t1x: 0, t1y: 0, t1z: 0, t2x: 0, t2y: 0, t2z: 0, pen: 0, vn0: 0, jn: 0, j1: 0, j2: 0, jw: 0, r1: 0, r2: 0, rs: 0, mu: 0.6, e: 0
      });
    return CT[nCT++];
  }
  // fixed tangent basis t1 ⟂ n, t2 = n × t1 (2D: t1 in the plane, t2 = z)
  function tangents(c) {
    if (LOCK) {
      c.t1x = -c.ny;
      c.t1y = c.nx;
      c.t1z = 0;
      c.t2x = 0;
      c.t2y = 0;
      c.t2z = 1;
      return;
    }
    const ax = Math.abs(c.nx) < 0.6 ? 1 : 0, ay = ax ? 0 : 1;
    let t1x = ay * c.nz, t1y = -ax * c.nz, t1z = ax * c.ny - ay * c.nx;
    const tl = M.nz(M.len3(t1x, t1y, t1z), 1);
    t1x /= tl; t1y /= tl; t1z /= tl;
    c.t1x = t1x; c.t1y = t1y; c.t1z = t1z;
    c.t2x = c.ny * t1z - c.nz * t1y; c.t2y = c.nz * t1x - c.nx * t1z; c.t2z = c.nx * t1y - c.ny * t1x;
  }
  // relative velocity of P over Q at the contact -> tq
  function relv(c) {
    const p = c.P, q = c.Q;
    let x = p.vel.x + p.w.y * c.prz - p.w.z * c.pry,
      y = p.vel.y + p.w.z * c.prx - p.w.x * c.prz,
      z = p.vel.z + p.w.x * c.pry - p.w.y * c.prx;
    if (q) {
      x -= q.vel.x + q.w.y * c.qrz - q.w.z * c.qry;
      y -= q.vel.y + q.w.z * c.qrx - q.w.x * c.qrz;
      z -= q.vel.z + q.w.x * c.qry - q.w.y * c.qrx;
    }
    tq.x = x; tq.y = y; tq.z = z;
  }
  function kC(c, dx, dy, dz) {
    return (c.pd ? kEff(c.P, c.prx, c.pry, c.prz, dx, dy, dz) : 0) + (c.Q && c.qd ? kEff(c.Q, c.qrx, c.qry, c.qrz, dx, dy, dz) : 0);
  }
  function imp(c, jx, jy, jz) {
    if (c.pd) applyImpulse(c.P, c.prx, c.pry, c.prz, jx, jy, jz);
    if (c.Q && c.qd) applyImpulse(c.Q, c.qrx, c.qry, c.qrz, -jx, -jy, -jz);
  }
  function spin(c, ax, ay, az, d) {                  // angular impulse d about the axis: P +, Q -
    if (c.pd) {
      invI(c.P, ax * d, ay * d, az * d, tr);
      c.P.w.x += tr.x;
      c.P.w.y += tr.y;
      c.P.w.z += tr.z;
    }
    if (c.Q && c.qd) {
      invI(c.Q, ax * d, ay * d, az * d, tr);
      c.Q.w.x -= tr.x;
      c.Q.w.y -= tr.y;
      c.Q.w.z -= tr.z;
    }
  }
  function kSpin(c, ax, ay, az) {
    let k = 0;
    if (c.pd) {
      invI(c.P, ax, ay, az, tr);
      k += tr.x * ax + tr.y * ay + tr.z * az;
    }
    if (c.Q && c.qd) {
      invI(c.Q, ax, ay, az, tr);
      k += tr.x * ax + tr.y * ay + tr.z * az;
    }
    return k;
  }
  function wAbout(c, ax, ay, az) {
    let s = c.P.w.x * ax + c.P.w.y * ay + c.P.w.z * az;
    if (c.Q) s -= c.Q.w.x * ax + c.Q.w.y * ay + c.Q.w.z * az;
    return s;
  }
  function solve_contact(c) {
    relv(c);
    const vn = tq.x * c.nx + tq.y * c.ny + tq.z * c.nz, kn = kC(c, c.nx, c.ny, c.nz);
    if (kn <= 0) return;
    const target = c.vn0 < -1 ? -c.e * c.vn0 : 0;     // no velocity bias: penetration is projected out separately
    let jn = (target - vn) / kn;
    const acc = M.max(0, c.jn + jn);
    jn = acc - c.jn;
    c.jn = acc;
    imp(c, jn * c.nx, jn * c.ny, jn * c.nz);
    // friction (B1): a 2D impulse in the fixed tangent basis, the ACCUMULATED vector clamped to the cone |jt| <= mu jn
    relv(c);
    const v1 = tq.x * c.t1x + tq.y * c.t1y + tq.z * c.t1z, v2 = tq.x * c.t2x + tq.y * c.t2y + tq.z * c.t2z;
    const k1 = kC(c, c.t1x, c.t1y, c.t1z), k2 = LOCK ? 0 : kC(c, c.t2x, c.t2y, c.t2z);
    let a1 = k1 > 0 ? c.j1 - v1 / k1 : 0, a2 = k2 > 0 ? c.j2 - v2 / k2 : 0;
    const lim = c.mu * c.jn, al = M.len2(a1, a2);
    if (al > lim) {
      a1 *= lim / al;
      a2 *= lim / al;
    }
    const d1 = a1 - c.j1, d2 = a2 - c.j2;
    c.j1 = a1;
    c.j2 = a2;
    imp(c, d1 * c.t1x + d2 * c.t2x, d1 * c.t1y + d2 * c.t2y, d1 * c.t1z + d2 * c.t2z);
    if (c.rs > 0) {
      // torsional friction: spin about the normal through a contact patch of radius ~TORSION_R x the sphere radius
      const kw = kSpin(c, c.nx, c.ny, c.nz);
      if (kw > 1e-9) {
        const limw = c.mu * c.jn * K.TORSION_R * c.rs;
        const aw = M.clamp(c.jw - wAbout(c, c.nx, c.ny, c.nz) / kw, -limw, limw), dw = aw - c.jw;
        c.jw = aw;
        spin(c, c.nx, c.ny, c.nz, dw);
      }
      // rolling resistance (Coulomb, soil deformation under the load) about t1 / t2
      const kr1 = kSpin(c, c.t1x, c.t1y, c.t1z), kr2 = kSpin(c, c.t2x, c.t2y, c.t2z), limr = K.ROLL_MU * c.jn * c.rs;
      if (kr1 > 1e-9 && kr2 > 1e-9) {
        let r1 = c.r1 - wAbout(c, c.t1x, c.t1y, c.t1z) / kr1, r2 = c.r2 - wAbout(c, c.t2x, c.t2y, c.t2z) / kr2;
        const rl = M.len2(r1, r2);
        if (rl > limr) {
          r1 *= limr / rl;
          r2 *= limr / rl;
        }
        const e1 = r1 - c.r1, e2 = r2 - c.r2;
        c.r1 = r1;
        c.r2 = r2;
        spin(c, c.t1x, c.t1y, c.t1z, e1); spin(c, c.t2x, c.t2y, c.t2z, e2);
      } else if (kr2 > 1e-9) {                      // 2D: the only spin left is about z
        const r2 = M.clamp(c.r2 - wAbout(c, c.t2x, c.t2y, c.t2z) / kr2, -limr, limr), e2 = r2 - c.r2;
        c.r2 = r2;
        spin(c, c.t2x, c.t2y, c.t2z, e2);
      }
    }
  }

  // per-step scratch of the awake bodies (index = position in the act list)
  const ACT = [], ACT_MAX = 128;
  const aSub = new Float64Array(ACT_MAX),
    aSubL = new Float64Array(ACT_MAX),
    aWx = new Float64Array(ACT_MAX),
    aWz = new Float64Array(ACT_MAX),
    aLx = new Float64Array(ACT_MAX),
    aLz = new Float64Array(ACT_MAX);
  const aBlk = new Uint8Array(ACT_MAX),
    aNc = new Int32Array(ACT_MAX),
    aN = new Int32Array(ACT_MAX),
    aDx = new Float64Array(ACT_MAX),
    aDy = new Float64Array(ACT_MAX),
    aDz = new Float64Array(ACT_MAX);

  /* forces, fluids, damping and terrain contacts of one awake body; returns false when the body is frozen (sea ice) */
  function prep(S, b, dt, ai) {
    const w = W(), G = C.G;
    b.age += dt;
    // Step I: frozen in
    if (b.iceLock) {
      b.vel.x = b.vel.y = b.vel.z = 0;
      b.w.x = b.w.y = b.w.z = 0;
      b.floatT = (b.floatT || 0) + dt;
      return false;
    }
    if (LOCK) {                                       // planar rigid body: z / x-y spin do not exist, the orientation is the in-plane angle
      b.vel.z = 0; b.w.x = 0; b.w.y = 0;
      const l = M.len2(b.q.z, b.q.w);
      if (l > 1e-9) {
        b.q.x = 0;
        b.q.y = 0;
        b.q.z /= l;
        b.q.w /= l;
      } else {
        b.q.x = 0;
        b.q.y = 0;
        b.q.z = 0;
        b.q.w = 1;
      }
    }
    // gravity, water (buoyancy of the submerged share + drag), air damping
    // P68c: the summed chunk fields
    if (S.eow) SS.eow.body_g(S, b, dt);
    else b.vel.y -= G * dt;
    const sea = SS.sim.surface_at ? SS.sim.surface_at(S, b.pos.x, b.pos.z) : w.SEA;
    let sub = 0;
    if (b.pos.y < sea + b.rb * 0.5) {
      sub = M.clamp((sea - (b.pos.y - b.rb * 0.5)) / M.max(0.2, b.rb), 0, 1);
      const rho = b.mass / M.max(1e-3, bodyVol(b));
      if (!b.wet && sub > 0.05) {
        // entering the water: splash and a dip in the surface (stronger for heavy, fast bodies); the dip itself can
        // briefly un-wet the body, so one splash per second at most
        b.wet = true;
        const sp = -b.vel.y;
        if (sp > 1.5 && S.time - b.splashT > 1) {
          b.splashT = S.time;
          const r = M.max(0.5, b.rb * 1.2), amp = M.min(0.5, 0.02 * sp * M.cbrt(b.mass));
          if (SS.water && SS.water.disturb) SS.water.disturb(S, b.pos.x, b.pos.z, r, -amp);
          SS.sim.emit(S, 'splash', { x: b.pos.x, y: sea, z: b.pos.z, size: M.min(1.6, 0.3 + 0.08 * sp * M.cbrt(b.mass / 20)), body: b.id });
        }
      }
      b.vel.y += G * M.min(1.5, 1000 / rho) * sub * dt;
      // drag toward the local water velocity (floating props drift with the flow, waves push wreckage around):
      // linear (WATER_DRAG) + quadratic 0.5 rho_w Cd A |v| v / m, integrated implicitly (a 25 kg crate hitting the
      // water at 7 m/s stops within centimetres, a rock keeps going)
      if (SS.water && S.water) SS.water.vel(S, b.pos.x, b.pos.z, wv);
      else wv.x = wv.z = 0;
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
        subL = M.clamp((ls - (b.pos.y - b.rb * 0.5)) / M.max(0.2, b.rb), 0, 1);
        const rho = b.mass / M.max(1e-3, bodyVol(b));
        const LA = C.LAVA, cool = M.clamp(1 - SS.lava.temp_at(S, b.pos.x, b.pos.z), 0, 1);
        b.vel.y += G * M.min(LA.BUOY_MAX, LA.RHO / rho) * subL * dt;
        SS.lava.vel_at(S, b.pos.x, b.pos.z, lvb); lvb.x *= 1.5; lvb.z *= 1.5;
        const k = M.exp(-3 * Math.PI * LA.MU_SURF * M.exp(LA.NU_K * cool) * 2 * b.rb / b.mass * subL * dt);   // Stokes, implicit
        b.vel.x = lvb.x + (b.vel.x - lvb.x) * k; b.vel.y *= k; b.vel.z = lvb.z + (b.vel.z - lvb.z) * k;
        b.w.x *= k; b.w.y *= k; b.w.z *= k;
      }
    }
    b.inLava = subL;
    let ld = K.LIN_DAMP, ad = K.ANG_DAMP;
    // P105: a piece that is touching and nearly still loses its last motion fast (rubble does not rock for seconds)
    if (b.kind === 'chunk' && b.age - b.touchAge < 0.1) {
      const sl = M.clamp(1 - M.len3(b.vel.x, b.vel.y, b.vel.z) / K.REST_V, 0, 1);
      ld += K.REST_LIN * sl; ad += K.REST_ANG * sl;
    }
    const la = M.exp(-ld * dt), aa = M.exp(-ad * dt);
    b.vel.x *= la;
    b.vel.y *= la;
    b.vel.z *= la;
    b.w.x *= aa;
    b.w.y *= aa;
    b.w.z *= aa;
    if (LOCK) {
      b.vel.z = 0;
      b.w.x = 0;
      b.w.y = 0;
    }
    aSub[ai] = sub;
    aSubL[ai] = subL;
    aWx[ai] = wv.x;
    aWz[ai] = wv.z;
    aLx[ai] = lvb.x;
    aLz[ai] = lvb.z;
    // terrain contacts
    const mat = w.mat_at(b.pos.x, b.pos.y - b.rb, b.pos.z), mu = Math.sqrt(b.mu * ((C.MATS[mat] && C.MATS[mat].mu) || 0.6));
    let nc = 0;
    for (let i = 0; i < b.np; i++) {
      M.q_rot(b.q, b.pts[i * 4], b.pts[i * 4 + 1], b.pts[i * 4 + 2], tp);
      const px = b.pos.x + tp.x, py = b.pos.y + tp.y, pz = b.pos.z + tp.z;
      let pen = contact(px, py, pz, b.pts[i * 4 + 3], tn);
      // Step I: sea ice carries a body that its thickness can bear (Gold), else it breaks under it; a body already
      // afloat is not a load on the ice that forms around it (it freezes in: ice.js iceLock)
      if (pen <= 0 && SS.ice && S.ice && !b.iceLock && !(sub > 0.02)) {
        const r = b.pts[i * 4 + 3], it = SS.ice.top_at(S, px, pz);
        if (it > -1e8 && py - r < it && py > it - 0.4) {
          if (SS.ice.supports(S, px, pz, b.mass)) {
            pen = it - (py - r);
            tn.x = 0;
            tn.y = 1;
            tn.z = 0;
          }
          else SS.ice.load(S, px, pz, b.mass, 'weight');
        }
      }
      if (pen <= 0) continue;
      // 2D: in-plane normal (the slab is z-invariant)
      if (LOCK) {
        const l = M.len2(tn.x, tn.y);
        if (l < 0.2) continue;
        tn.x /= l;
        tn.y /= l;
        tn.z = 0;
      }
      const c = ct_new();
      if (!c) break;
      c.P = b;
      c.Q = null;
      c.pd = true;
      c.qd = false;
      c.ai = ai;
      c.pair = -1;
      c.prx = tp.x;
      c.pry = tp.y;
      c.prz = LOCK ? 0 : tp.z;
      c.nx = tn.x;
      c.ny = tn.y;
      c.nz = tn.z;
      c.pen = pen;
      c.jn = 0;
      c.j1 = 0;
      c.j2 = 0;
      c.jw = 0;
      c.r1 = 0;
      c.r2 = 0;
      c.rs = b.pts[i * 4 + 3]; c.mu = mu; c.e = b.e;
      tangents(c);
      relv(c); c.vn0 = tq.x * c.nx + tq.y * c.ny + tq.z * c.nz;
      nc++;
    }
    aNc[ai] = nc;
    return true;
  }

  /* after the solver: position projection, rolling damping, integration, sleep timer. Returns the terrain contact
   * count. */
  function finish(S, b, dt, ai) {
    const nc = aNc[ai], sub = aSub[ai], subL = aSubL[ai];
    // position projection (instead of a Baumgarte velocity bias, which pumped energy into resting bodies through the
    // noisy penetration estimate): move out by BAUMGARTE x the mean excess penetration along the contact normals
    if (aN[ai]) {
      const k = K.BAUMGARTE / aN[ai], l = M.len3(aDx[ai], aDy[ai], aDz[ai]) * k, cap = l > K.MAX_PUSH * dt ? K.MAX_PUSH * dt / l : 1;
      b.pos.x += aDx[ai] * k * cap;
      b.pos.y += aDy[ai] * k * cap;
      if (!LOCK) b.pos.z += aDz[ai] * k * cap;
    }
    if (nc) b.touchAge = b.age;
    // rolling resistance (soil deformation): spin decays while the body touches ground; also kills contact rocking
    if (nc) {
      const rd = M.exp(-K.ROLL_DAMP * dt);
      b.w.x *= rd;
      b.w.y *= rd;
      b.w.z *= rd;
    }
    // afloat: in the water, touching nothing, riding with the flow and not bobbing hard -> counts as settled
    if (
      (sub > 0 || subL > 0)
      && !nc
      && M.len2(b.vel.x - (subL > 0 ? aLx[ai] : aWx[ai]), b.vel.z - (subL > 0 ? aLz[ai] : aWz[ai])) < 0.4
      && Math.abs(b.vel.y) < 0.5
    ) b.floatT = (b.floatT || 0) + dt;
    else b.floatT = 0;
    // integrate
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    if (!LOCK) b.pos.z += b.vel.z * dt;
    M.q_integrate(b.q, b.w.x, b.w.y, b.w.z, dt);
    // sleep: touching something and nearly static for SLEEP s. Judged by displacement over the window (moved < SLEEP_D,
    // turned < SLEEP_A), not by the instantaneous speed: with dozens of contacts and 6 iterations the solver leaves
    // ~0.1-0.25 m/s of noise on a resting piece, which reset an instantaneous test forever.
    if (!b.restP) {
      b.restP = v3();
      b.restQ = { x: 0, y: 0, z: 0, w: 1 };
      b.sleepT = -1;
    }
    const dq = Math.abs(b.q.x * b.restQ.x + b.q.y * b.restQ.y + b.q.z * b.restQ.z + b.q.w * b.restQ.w);
    // P105: a pile of big pieces creeps ~0.1 m/s on its contact noise
    const sd = b.kind === 'chunk' ? K.SLEEP_D_CH : K.SLEEP_D, sa = b.kind === 'chunk' ? K.SLEEP_A_CH : K.SLEEP_A;
    const still = M.len3(b.pos.x - b.restP.x, b.pos.y - b.restP.y, b.pos.z - b.restP.z) < sd && dq > M.cos(sa / 2);
    // a jammed pile of big pieces can keep creeping on its contact noise; after SETTLE_AGE s a touching chunk below
    // SETTLE_V m/s is done
    const settle = b.kind === 'chunk'
      && b.age > K.SETTLE_AGE
      && M.len3(b.vel.x, b.vel.y, b.vel.z) < K.SETTLE_V
      && M.len3(b.w.x, b.w.y, b.w.z) < K.SETTLE_W;
    if (b.age - (b.touchAge || -9) < 0.1 && (still || settle) && b.sleepT >= 0) b.sleepT += dt;
    else {
      b.sleepT = 0;
      b.restP.x = b.pos.x;
      b.restP.y = b.pos.y;
      b.restP.z = b.pos.z;
      b.restQ.x = b.q.x;
      b.restQ.y = b.q.y;
      b.restQ.z = b.q.z;
      b.restQ.w = b.q.w;
    }
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
        if (d < C.WORM_R + 0.1 && d < best) {
          best = d;
          hit = i;
        }
      }
      if (hit < 0) continue;
      // closing speed of the body toward the worm
      const l = M.nz(M.len3(dx, dy, dz), 1), nx = dx / l, ny = dy / l, nz = dz / l;
      const vc = b.vel.x * nx
        + b.vel.y * ny
        + b.vel.z * nz
        - ((wm.vel && wm.vel.x || 0) * nx + (wm.vel && wm.vel.y || 0) * ny + (wm.vel && wm.vel.z || 0) * nz);
      if (vc < K.HIT_V) continue;
      // PoC crushWorm (L1997): a big slab of falling ground landing on a worm that stands on something buries it
      const standing = SS.sim.ctl(S, wm) ? !wm.air : wm.rest;
      if (b.kind === 'chunk' && b.mass >= K.CRUSH_KG && b.vel.y < -3 && ny < -0.5 && standing) {
        SS.sim.emit(S, 'buried', { wormId: wm.id, x: wm.pos.x, y: wm.pos.y, z: wm.pos.z });
        SS.sim.log(S, `${wm.name} is buried!`, 0xff9a9a);
        SS.sim.kill_now(S, wm, 'crush');
        continue;
      }
      const me = M.min(b.mass, K.HIT_MASS), ke = 0.5 * me * vc * vc / 1000;               // kJ
      const dmg = M.min(K.HIT_MAX, Math.round(ke * K.HIT_PER_KJ));
      wm.bodyHitT = S.time;
      if (dmg > 0)
        if (b.kind === 'chunk') SS.sim.hurt(S, wm, dmg, C.DS.FALLING_ROCK);
        else if (b.prop === 'crate') SS.sim.hurt(S, wm, dmg, C.DS.FLY_CRATE);
        else SS.sim.hurt(S, wm, dmg, C.DS.FLY_PROP, 0, SS.sim.body_name_id(b));
      SS.sim.emit(S, 'bodyhit', { x: wm.pos.x, y: wm.pos.y, z: wm.pos.z, dmg, body: b.id });
      // knock the worm away (and let the body lose a little momentum to it)
      const kv = M.min(8, vc * 0.6);
      if (SS.sim.ctl(S, wm)) {
        const d = SS.plane.dir(S);
        S.active.air = true;
        S.active.vs += (nx * d.x + nz * d.z) * kv;
        S.active.vy = M.max(S.active.vy, ny * kv + 1.5);
      } else {
        wm.rest = false;
        wm.vel = wm.vel || v3();
        wm.vel.x += nx * kv;
        wm.vel.y += M.max(0, ny) * kv + 1.5;
        wm.vel.z += nz * kv;
      }
      const j = M.min(b.mass * vc, 80 * kv) * 0.5;
      b.vel.x -= nx * j * b.invM; b.vel.y -= ny * j * b.invM; b.vel.z -= nz * j * b.invM;
    }
  }
  /* body vs body (P105): contacts of one body's shell spheres against the other body's SHAPE. A detached chunk carries
   * its own local
   * density grid, so the other body's sphere centres are tested against that grid's signed distance exactly like they
   * are against the terrain (smooth normal from the grid gradient, deepest-point check, same penetration estimate). The
   * old rule tested sphere against sphere: a piece's sparse, bumpy shell spheres snagged on each other's, the normals
   * flipped between steps and resting pieces crept, rocked and never slept. Bodies without a grid (boxes, barrels,
   * balls) still use their spheres, sphere vs sphere. Contacts go into the same list as the terrain contacts and are
   * solved together with them. A sleeping body is a fixed obstacle unless it is struck (closing faster than 0.5 m/s: it
   * wakes). */
  // (P38 R1: the shell-point cache b.wp / b.wpS lives in the snapshotted body; pairs() clears every b.wpS first and the
  // cache key is the constant 1)
  const pairStamp = 1;
  function worldPts(b) {                           // shell sphere centres relative to b.pos (world axes), cached per call
    if (b.wpS === pairStamp) return b.wp;
    if (!b.wp || b.wp.length < b.np * 3) b.wp = new Float32Array(b.np * 3);
    for (let i = 0; i < b.np; i++) {
      M.q_rot(b.q, b.pts[i * 4], b.pts[i * 4 + 1], b.pts[i * 4 + 2], tp);
      b.wp[i * 3] = tp.x;
      b.wp[i * 3 + 1] = tp.y;
      b.wp[i * 3 + 2] = tp.z;
    }
    b.wpS = pairStamp; return b.wp;
  }
  const PAIR_MAX = 28, PR = [];
  let nPR = 0;
  const gn = v3(), gl = v3();
  const dyn = (pr, x) => x === pr.a ? pr.ad : pr.bd;
  // trilinear signed distance (m, > 0 inside) at lattice coords (grid-relative); outside the padded grid: 1 m of air
  function gsdf(g, fx, fy, fz) {
    if (fx < 0 || fy < 0 || fz < 0 || fx >= g.nx - 1 || fy >= g.ny - 1 || fz >= g.nz - 1) return -1;
    const a = Math.floor(fx),
      b = Math.floor(fy),
      c = Math.floor(fz),
      u = fx - a,
      v = fy - b,
      t = fz - c,
      d = g.s,
      o = (c * g.ny + b) * g.nx + a,
      sy = g.nx,
      sz = g.nx * g.ny;
    const x0 = d[o] + (d[o + 1] - d[o]) * u,
      x1 = d[o + sy] + (d[o + sy + 1] - d[o + sy]) * u,
      x2 = d[o + sz] + (d[o + sz + 1] - d[o + sz]) * u,
      x3 = d[o + sz + sy] + (d[o + sz + sy + 1] - d[o + sz + sy]) * u;
    const y0 = x0 + (x1 - x0) * v, y1 = x2 + (x3 - x2) * v;
    return y0 + (y1 - y0) * t;
  }
  // penetration of the sphere (world centre x, y, z, radius r) into chunk G's shape (the distance field g.s, built in
  // collapse.js); outward normal of G (world) -> n. 0 = no contact.
  function grid_contact(G, x, y, z, r, n) {
    const g = G.grid, ih = 1 / W().H;
    M.q_rot_inv(G.q, x - G.pos.x, y - G.pos.y, z - G.pos.z, gl);
    const fx = (G.com0.x + gl.x) * ih - g.i0, fy = (G.com0.y + gl.y) * ih - g.j0, fz = (G.com0.z + gl.z) * ih - g.k0;
    const s = gsdf(g, fx, fy, fz);
    if (s + r <= 0) return 0;
    const e = 0.5;                                   // lattice cells
    const gx = gsdf(g, fx + e, fy, fz) - gsdf(g, fx - e, fy, fz),
      gy = gsdf(g, fx, fy + e, fz) - gsdf(g, fx, fy - e, fz),
      gz = gsdf(g, fx, fy, fz + e) - gsdf(g, fx, fy, fz - e);
    const l = M.len3(gx, gy, gz);
    if (l < 1e-6) return 0;
    M.q_rot(G.q, -gx / l, -gy / l, -gz / l, gn);     // the field grows inward: outward normal = -grad
    n.x = gn.x; n.y = gn.y; n.z = gn.z;
    return M.max(s + r, 0.005);
  }
  function pair_add(pr, Pb, Qb, px, py, pz, r, n, pen) {   // contact of P's sphere (world centre p, radius r) with Q's shape
    let c;
    if (pr.n < PAIR_MAX) c = ct_new();
    else {
      let m = pr.start;
      for (let t = pr.start + 1; t < pr.start + pr.n; t++)
        if (CT[t].pen < CT[m].pen) m = t;
      if (CT[m].pen >= pen) return;
      c = CT[m];
      pr.n--;
    }
    if (!c) return;
    pr.n++;
    const cx = px - n.x * (r - pen * 0.5), cy = py - n.y * (r - pen * 0.5), cz = pz - n.z * (r - pen * 0.5);
    c.P = Pb;
    c.Q = Qb;
    c.pd = dyn(pr, Pb);
    c.qd = dyn(pr, Qb);
    c.ai = -1;
    c.pair = pr.id;
    c.prx = cx - Pb.pos.x;
    c.pry = cy - Pb.pos.y;
    c.prz = cz - Pb.pos.z;
    c.qrx = cx - Qb.pos.x;
    c.qry = cy - Qb.pos.y;
    c.qrz = cz - Qb.pos.z;
    c.nx = n.x;
    c.ny = n.y;
    c.nz = n.z;
    c.pen = pen;
    c.jn = 0;
    c.j1 = 0;
    c.j2 = 0;
    c.jw = 0;
    c.r1 = 0;
    c.r2 = 0;
    c.rs = 0;
    c.e = M.min(Pb.e, Qb.e);
    c.mu = pr.mu;
    pr.pmax = M.max(pr.pmax, pen);
  }
  const nrm = v3();
  function pairs(S) {
    const L = S.bodies;
    nPR = 0;
    for (let i = 0; i < L.length; i++) L[i].wpS = 0;
    for (let i = 0; i < L.length; i++)
      for (let k = i + 1; k < L.length; k++) {
        const a = L[i], b = L[k];
        if ((a.asleep && b.asleep) || a.iceLock && b.iceLock) continue;
        const dx = b.pos.x - a.pos.x, dy = b.pos.y - a.pos.y, dz = b.pos.z - a.pos.z, R = a.rb + b.rb;
        if (dx * dx + dy * dy + dz * dz >= R * R) continue;
        if (nPR >= PR.length) PR.push({ id: 0, a: null, b: null, start: 0, n: 0, pmax: 0, mu: 0.6, ad: false, bd: false });
        const pr = PR[nPR];
        pr.id = nPR;
        pr.a = a;
        pr.b = b;
        pr.start = nCT;
        pr.n = 0;
        pr.pmax = 0;
        pr.mu = Math.sqrt(a.mu * b.mu);
        pr.ad = !a.asleep && !a.held && !a.iceLock; pr.bd = !b.asleep && !b.held && !b.iceLock;
        const A = worldPts(a), Bp = worldPts(b), aG = a.kind === 'chunk' && a.grid, bG = b.kind === 'chunk' && b.grid;
        // a's spheres inside b's shape
        if (bG)
          for (let p = 0; p < a.np; p++) {
            const ax = a.pos.x + A[p * 3], ay = a.pos.y + A[p * 3 + 1], az = a.pos.z + A[p * 3 + 2], r = a.pts[p * 4 + 3];
            const pen = grid_contact(b, ax, ay, az, r, nrm);
            if (pen > 0) pair_add(pr, a, b, ax, ay, az, r, nrm, pen);
          }
        // b's spheres inside a's shape
        if (aG)
          for (let q = 0; q < b.np; q++) {
            const bx = b.pos.x + Bp[q * 3], by = b.pos.y + Bp[q * 3 + 1], bz = b.pos.z + Bp[q * 3 + 2], r = b.pts[q * 4 + 3];
            const pen = grid_contact(a, bx, by, bz, r, nrm);
            if (pen > 0) pair_add(pr, b, a, bx, by, bz, r, nrm, pen);
          }
        // two sphere clouds (boxes, barrels, balls)
        if (!aG && !bG)
          for (let p = 0; p < a.np; p++) {
            const ax = a.pos.x + A[p * 3], ay = a.pos.y + A[p * 3 + 1], az = a.pos.z + A[p * 3 + 2], ra = a.pts[p * 4 + 3];
            for (let q = 0; q < b.np; q++) {
              const ex = b.pos.x + Bp[q * 3] - ax,
                ey = b.pos.y + Bp[q * 3 + 1] - ay,
                ez = b.pos.z + Bp[q * 3 + 2] - az,
                rr = ra + b.pts[q * 4 + 3],
                e2 = ex * ex + ey * ey + ez * ez;
              if (e2 >= rr * rr || e2 < 1e-10) continue;
              const e = Math.sqrt(e2), pen = rr - e;
              nrm.x = -ex / e; nrm.y = -ey / e; nrm.z = -ez / e;          // outward normal of b at the touch point, pointing onto a
              pair_add(pr, a, b, ax, ay, az, ra, nrm, pen);
            }
          }
        if (!pr.n) continue;
        nPR++;
        // resting on another body counts as touching (a pile settles together, not from the bottom up)
        if (pr.ad) a.touchAge = a.age;
        if (pr.bd) b.touchAge = b.age;
        if (LOCK)
          for (let q = pr.start; q < pr.start + pr.n; q++) {
            const c = CT[q];
            const l = M.len2(c.nx, c.ny);
            if (l < 0.2) {
              c.nx = 0;
              c.ny = 1;
            } else {
              c.nx /= l;
              c.ny /= l;
            }
            c.nz = 0;
            c.prz = 0;
            c.qrz = 0;
          }
        for (let q = pr.start; q < pr.start + pr.n; q++) {
          const c = CT[q];
          tangents(c);
          relv(c);
          c.vn0 = tq.x * c.nx + tq.y * c.ny + tq.z * c.nz;
        }
        // a sleeping body joins in only when struck (closing faster than 0.5 m/s); else it is a fixed obstacle
        let closing = 0;
        for (let q = pr.start; q < pr.start + pr.n; q++) closing = M.min(closing, CT[q].vn0);
        if (closing < -0.5 && (a.asleep || b.asleep)) {
          if (a.asleep) {
            wake(a);
            pr.ad = true;
          }
          if (b.asleep) {
            wake(b);
            pr.bd = true;
          }
          for (let q = pr.start; q < pr.start + pr.n; q++) {
            CT[q].pd = dyn(pr, CT[q].P);
            CT[q].qd = dyn(pr, CT[q].Q);
          }
        }
      }
  }
  /* position projection of the pairs (along the mean contact normal, split by inverse mass, capped) */
  function pair_project(dt) {
    for (let p = 0; p < nPR; p++) {
      const pr = PR[p], ex = pr.pmax - K.SLOP;
      if (ex <= 0) continue;
      let nx = 0, ny = 0, nz = 0;
      for (let q = pr.start; q < pr.start + pr.n; q++) {
        const c = CT[q], sg = c.P === pr.b ? 1 : -1;
        nx += sg * c.nx * c.pen;
        ny += sg * c.ny * c.pen;
        nz += sg * c.nz * c.pen;
      }
      const nl = M.nz(M.len3(nx, ny, nz), 1), ia = pr.ad ? pr.a.invM : 0, ib = pr.bd ? pr.b.invM : 0, sum = ia + ib;
      if (sum <= 0) continue;
      const mv = M.min(K.BAUMGARTE * ex, K.MAX_PUSH * dt) / sum;
      if (pr.ad) {
        pr.a.pos.x -= nx / nl * mv * ia;
        pr.a.pos.y -= ny / nl * mv * ia;
        if (!LOCK) pr.a.pos.z -= nz / nl * mv * ia;
      }
      if (pr.bd) {
        pr.b.pos.x += nx / nl * mv * ib;
        pr.b.pos.y += ny / nl * mv * ib;
        if (!LOCK) pr.b.pos.z += nz / nl * mv * ib;
      }
    }
  }

  /* diagnostics (tools/dev/gen/rigidprobe.cjs): the contacts of the last step */
  B.last_contacts = () => CT.slice(0, nCT);
  const gdv = { x: 0, y: -1, z: 0 };
  B.step = function (S, dt) {
    if (!S.bodies.length) return;
    const w = W();
    LOCK = !!w.flat;
    nCT = 0; ACT.length = 0;
    // phase 1: sleepers (support re-check, EOW re-bake retry) and the forces + terrain contacts of every awake body
    for (let i = S.bodies.length - 1; i >= 0; i--) {
      const b = S.bodies[i];
      // P37 W4: a body held by the gravity gun is moved by sim/gadgets.js (kinematic)
      if (b.held) {
        b.sleepT = 0;
        continue;
      }
      if (b.asleep) {
        // P94: a piece that was declined (it rests on another piece) is tried again: a pile bakes from the bottom up
        if (
          S.eow
          && b.kind === 'chunk'
          && b.grid
          && S.tick % SS.eow.K.REBAKE_RETRY === b.id % SS.eow.K.REBAKE_RETRY
          && !w.outside(b.pos.x, b.pos.z)
        ) {
          const added = SS.eow.rebake(S, b);
          if (added >= 0) {
            SS.sim.emit(S, 'rebake', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, voxels: added });
            S.bodies.splice(i, 1);
            continue;
          }
        }
        // re-check support now and then: wake when the ground under it was blasted away
        if (S.tick % 30 === b.id % 30) {
          const touch = sleeperSupported(S, b);
          if (!touch) wake(b);
          // LV3: lava reached it (it rises over its base): it floats or is dragged along
          else if (SS.lava && S.lava && SS.lava.surface_at(S, b.pos.x, b.pos.z) > b.pos.y - b.rb * 0.7) wake(b);
          // water reached it: a floater lifts off, anything is shoved by a strong current
          else if (SS.water && S.water) {
            const sea = SS.sim.surface_at(S, b.pos.x, b.pos.z);
            if (sea > b.pos.y - b.rb * 0.5) {
              SS.water.vel(S, b.pos.x, b.pos.z, wv);
              const rose = sea > b.seaY + 0.15;   // above the swell at the shore
              if ((rose && b.mass / M.max(1e-3, bodyVol(b)) < 1000) || M.len2(wv.x, wv.z) > 1.2) wake(b);
            }
          }
        }
        continue;
      }
      if (ACT.length >= ACT_MAX) continue;
      const ai = ACT.length;
      ACT.push(b);
      b.ai = ai;
      aNc[ai] = 0; aN[ai] = 0; aDx[ai] = aDy[ai] = aDz[ai] = 0;
      if (!prep(S, b, dt, ai)) ACT.pop();
    }
    // phase 2: body pairs (contacts go into the same list)
    pairs(S);
    // phase 3: sequential impulses over every contact, alternating the sweep direction
    for (let it = 0; it < K.ITERS; it++) {
      if (it & 1)
        for (let q = nCT - 1; q >= 0; q--) solve_contact(CT[q]);
      else
        for (let q = 0; q < nCT; q++) solve_contact(CT[q]);
    }
    // terrain projection sums (per body) and pair projection
    for (let q = 0; q < nCT; q++) {
      const c = CT[q];
      if (c.Q || c.ai < 0) continue;
      const e = c.pen - K.SLOP;
      if (e > 0) {
        aDx[c.ai] += c.nx * e;
        aDy[c.ai] += c.ny * e;
        aDz[c.ai] += c.nz * e;
        aN[c.ai]++;
      }
    }
    pair_project(dt);
    // phase 4: integrate, hit worms, retire (act list is in reverse body order, so splicing is safe)
    for (let ai = 0; ai < ACT.length; ai++) finish(S, ACT[ai], dt, ai);
    // sleeping by neighbourhood: a chunk is held awake while another awake chunk that is not ready to sleep is close
    // (bounding spheres
    // + 0.4 m). A pile freezes as one, and a piece never bakes into the field under / inside a neighbour that is still
    // moving.
    for (let ai = 0; ai < ACT.length; ai++) aBlk[ai] = 0;
    for (let pass = 0; pass < 6; pass++) {
      let ch = false;
      for (let ai = 0; ai < ACT.length; ai++) {
        const a = ACT[ai];
        if (a.kind !== 'chunk' || aBlk[ai] || a.sleepT <= K.SLEEP) continue;
        for (let bi = 0; bi < ACT.length; bi++) {
          const c = ACT[bi];
          if (bi === ai || c.kind !== 'chunk' || (c.sleepT > K.SLEEP && !aBlk[bi])) continue;
          const R = a.rb + c.rb + 0.4, dx = c.pos.x - a.pos.x, dy = c.pos.y - a.pos.y, dz = c.pos.z - a.pos.z;
          if (dx * dx + dy * dy + dz * dz < R * R) {
            aBlk[ai] = 1;
            ch = true;
            break;
          }
        }
      }
      if (!ch) break;
    }
    for (let ai = 0; ai < ACT.length; ai++) {
      const b = ACT[ai];
      hitWorms(S, b);
      // gone: fell off the map (dry worlds, D4: the far dunes carry it out to FAR_R) or never settled
      const off = w.dry
        ? M.len2(b.pos.x - C.DRY.CX, b.pos.z - C.DRY.CZ) > C.DRY.FAR_R
        : b.pos.x < -10 || b.pos.z < -10 || b.pos.x > w.SX + 10 || b.pos.z > w.SZ + 10;
      if (b.pos.y < -4 || off || (b.age > K.MAX_AGE && !(b.floatT > 1))) {
        SS.sim.emit(S, 'bodygone', { body: b.id });
        const i = S.bodies.indexOf(b);
        if (i >= 0) S.bodies.splice(i, 1);
        continue;
      }
      if (b.sleepT > K.SLEEP && !aBlk[ai]) {
        b.asleep = true; b.vel.x = b.vel.y = b.vel.z = 0; b.w.x = b.w.y = b.w.z = 0;
        b.seaY = SS.sim.surface_at ? SS.sim.surface_at(S, b.pos.x, b.pos.z) : -99;
        if (b.kind === 'chunk' && SS.collapse && b.grid && !w.outside(b.pos.x, b.pos.z)) {   // beyond the lattice (dry) it stays a body
          // P94: in space a piece that would merge into another body or hang loose stays a rigid body (-1)
          const added = S.eow ? SS.eow.rebake(S, b) : SS.collapse.rebake(w, b.grid, b.com0, b.pos, b.q);
          if (added >= 0) {
            SS.sim.emit(S, 'rebake', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, voxels: added });
            const i = S.bodies.indexOf(b);
            if (i >= 0) S.bodies.splice(i, 1);
          }
          else SS.sim.emit(S, 'bodysleep', { body: b.id });
        } else SS.sim.emit(S, 'bodysleep', { body: b.id });
      }
    }
  };

  /* 2D cross-sections on the collision plane (worms and projectiles collide with them, plane.js) */
  B.plane_sections = function (S) {
    const PB = S.planeBodies;
    PB.length = 0;
    if (!S.bodies.length) return;
    const P = SS.plane, n = P.nrm(S), d = P.dir(S), ox = S.O.x, oz = S.O.z;
    for (const b of S.bodies) {
      const t = (b.pos.x - ox) * n.x + (b.pos.z - oz) * n.z;
      if (Math.abs(t) > b.rb + 0.1) continue;
      if (b.kind === 'ball') {
        const r2 = b.r * b.r - t * t;
        if (r2 > 0.01)
          P.pb_add(PB, 0, (b.pos.x - ox) * d.x + (b.pos.z - oz) * d.z, b.pos.y, 0, 0, Math.sqrt(r2), b.id, -1, -1, -1, -1, false);
        continue;
      }
      let s0 = 1e9, s1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let i = 0; i < b.np; i++) {
        M.q_rot(b.q, b.pts[i * 4], b.pts[i * 4 + 1], b.pts[i * 4 + 2], tp);
        const px = b.pos.x + tp.x, pz = b.pos.z + tp.z, r = b.pts[i * 4 + 3], tt = (px - ox) * n.x + (pz - oz) * n.z;
        if (Math.abs(tt) > r + 0.35) continue;
        const s = (px - ox) * d.x + (pz - oz) * d.z, y = b.pos.y + tp.y;
        s0 = M.min(s0, s - r);
        s1 = M.max(s1, s + r);
        y0 = M.min(y0, y - r);
        y1 = M.max(y1, y + r);
      }
      if (s1 > s0) P.pb_add(PB, 1, (s0 + s1) / 2, (y0 + y1) / 2, (s1 - s0) / 2, (y1 - y0) / 2, 0, b.id, -1, -1, -1, -1, false);
    }
  };
  /* impulse J (N s) along the world direction dir (normalised here), e.g. a grenade bouncing off */
  B.nudge = function (S, b, dir, J) {
    if (!b || !S.bodies.includes(b)) return;
    const l = M.nz(M.len3(dir.x, dir.y, dir.z), 1);
    wake(b);
    b.vel.x += dir.x / l * J * b.invM; b.vel.y += dir.y / l * J * b.invM; b.vel.z += dir.z / l * J * b.invM;
  };
  /* blast: impulse I(R, W) [Pa s] on the body's frontal area, plus a deterministic spin */
  B.blast = function (S, c, Wkg, only) {
    const BL = SS.blast;
    for (const b of only || S.bodies) {
      const dx = b.pos.x - c.x, dy = b.pos.y - c.y, dz = b.pos.z - c.z, dist = M.len3(dx, dy, dz);
      if (dist > 8 * M.cbrt(Wkg) + b.rb) continue;
      const R = M.max(0.3, dist - b.rb * 0.5), I = BL.impulse(R, Wkg), A = Math.PI * M.pow(M.min(b.rb, 2) * 0.7, 2);
      const dv = M.min(K.BLAST_DV, I * A * b.invM);
      if (dv < 0.05) continue;
      const l = dist || 1, ux = dx / l, uy = dy / l + 0.35, uz = dz / l, ul = M.len3(ux, uy, uz);
      wake(b);
      b.vel.x += ux / ul * dv; b.vel.y += uy / ul * dv; b.vel.z += uz / ul * dv;
      const hx = M.hash3(b.id, 1, 7) - 0.5, hy = M.hash3(b.id, 2, 7) - 0.5, hz = M.hash3(b.id, 3, 7) - 0.5;
      const sp = dv / M.max(0.4, b.rb) * 0.6;
      b.w.x += hx * sp; b.w.y += hy * sp; b.w.z += hz * sp;
    }
  };
  B.settled = S => S.bodies.every(b => b.asleep || b.floatT > 1);
})(window.SS = window.SS || {});
