/* sim/gadgets.js — P37 W4 weapons B: robotic dog, knockout punch, sentry gun, claymore, gravity gun.
 * Portable and deterministic: own RNG stream S.gdRng (seeded from settings.seed), sim time only, fixed step, plain
 * arrays of plain structs (no Map / Set, ids are integers), pools with hard caps. Everything the player sees goes out
 * as events (sim.emit) that render/gadgets.js and the audio layer consume.
 *
 * C layout (all state lives in S, so snapshot / replay / sim.hash cover it):
 *   struct Dog      { i32 id; u8 team; i32 owner; f32 s, y, vs, vy; i8 dir; f32 life, age, dist, bark, retarget, blockT;
 *                     i32 target; u8 hop, state /0 run, 1 blocked, 2 airborne/; }                      S.dogs[MAX_DOGS]
 *                     (the dog lives in the attack plane like a sheep: the section is locked until it is gone)
 *   struct Punch    { i32 id, wid, victim; f32 t0; i8 dir; u8 done; }                                  S.punches[4]
 *   struct Sentry   { i32 id; u8 team; i32 owner; vec3 pos; f32 vy, yaw, pitch, spin, tilt, tiltAz; i16 ammo; f32 hp;
 *                     u8 state /0 live, 1 knocked over (erratic fire), 2 spent or destroyed/; f32 cool, erT, deadT, beamLen;
 *                     struct { i16 left; f32 t; i32 target; } burst; u8 turns; }                      S.sentries[MAX_SENTRIES]
 *   struct Claymore { i32 id; u8 team; i32 owner; vec3 pos; vec3 dir /unit, inside the plane it was planted in/; vec2 pdir;
 *                     f32 armAt, hp, vy; u8 attach /0 ground, 1 wall, 2 tree/; i32 tree, seg; u8 turns; }  S.claymores[MAX_CLAY]
 *   struct Grab     { i32 body; i32 wid; }                                                              S.grab (or null)
 *   Body += { u8 held; }  (bodies.js skips a held body: this module moves it)
 * API: init(S), use(S, a, key, power) -> bool, step(S, dt), blast(S, c, Wkg, dmg), turn_start(S), busy(S), hash(S, mix),
 *   grabbables(S, a, out) (render / HUD outline), ray(S, o, d, maxD, opts) -> hit, round(S, o, d, owner, dmg) (one bullet),
 *   ai_cands(S, pl, a, tgt, cands), ai_fire(S, a, b), stats(S).
 * Keys that go through use(): dog, punch, sentry, claymore, gravgun (the force field is sim/ffield.js). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane, MAT = C.MAT;
  const GD = SS.gadgets = {};
  const W = () => SS.world;
  const sim = () => SS.sim;
  const WPN = () => SS.weapons;
  const hypot3 = (a, b) => M.len3(a.x - b.x, a.y - b.y, a.z - b.z);

  /* ---------- constants ---------- */
  const K = C.TOOLB = C.TOOLB || {};
  K.DOG = { SPEED: 5.2, ACC: 14, R: 0.36, TIMER: 8, REACH: 1.05, HOP_MAX: 0.95, STEP_UP: 0.28, DMG: 55, W: 1.5, BARK0: 1.2, BARK1: 3.0, MAX: 4 };
  K.PUNCH = { REACH: 1.8, DY: 1.3, DT: 0.9, VY: 11, HIT_T: 0.16, DMG: 30, V_OUT: 20, V_UP: 12, SPIN: 14 };
  K.SENTRY = { AMMO: 100, HP: 60, RANGE: 14, SPIN: 1.7, BEAM_Y: 0.5, BURST: 6, ROUND_T: 0.09, SPREAD: 0.03, DMG: 4, ROUND_RANGE: 30, PUSH: 0.6,
    TURNS: 12, COOL: 0.6, TURN: 12, ER0: 0.05, ER1: 0.2, KNOCK_F: 0.15, FALL_T: 0.5, MAX: 6, ALIGN: 0.08 };
  K.CLAY = { ARM: 10, LASER: 3, PELLETS: 140, CONE: 0.9, RANGE: 9, DMG: 5, PUSH: 0.3, HP: 30, TURNS: 12, REACH: 1.8, W_CORE: 0.1, MAX: 8 };
  K.GRAV = { CRATE_LOCK: 1.5, CRATE_DMG_K: 0.9, CRATE_DMG_MAX: 22, CRATE_DMG_MIN_V: 4, RANGE: 9, HOLD: 1.6, FOLLOW: 14, PULL_V: 30, MASS_MAX: 60, MINE_FUSE: 3, AIM_COS: 0.35 };
  GD.KEYS = { dog: 1, punch: 1, sentry: 1, claymore: 1, gravgun: 1 };

  const rng = S => M.rng_next(S.gdRng);
  const rr = (S, a, b) => a + (b - a) * rng(S);
  const norm3 = v => { const l = M.nz(M.len3(v.x, v.y, v.z), 1); v.x /= l; v.y /= l; v.z /= l; return v; };

  GD.init = function (S) {
    S.gdRng = M.rng_make(((Math.imul(S.settings.seed | 0, 2246822519) + 0x6d1) >>> 0) || 1);
    S.gdId = 0; S.dogs = []; S.punches = []; S.sentries = []; S.claymores = []; S.grab = null;
  };

  /* ---------- 3D helpers ---------- */
  const tmpN = { x: 0, y: 0, z: 0 };
  /* first thing on the ray o + t d (d unit), t in [0, maxD]: a living worm (sphere WORM_R) or the terrain.
   * opts.skip = worm id to ignore, opts.team = ignore that team's worms (-1: none), opts.step (m). Returns
   * { t, x, y, z, worm (object or null), nx, ny, nz } or null. */
  GD.ray = function (S, o, d, maxD, opts) {
    const op = opts || {}, w = W(), step = op.step || 0.2;
    let tw = 1e9, worm = null;
    for (const m of S.worms) {
      if (m.dead || m.id === op.skip || (op.team != null && op.team >= 0 && m.team === op.team) || m.reserve) continue;
      const ex = m.pos.x - o.x, ey = m.pos.y - o.y, ez = m.pos.z - o.z, tc = ex * d.x + ey * d.y + ez * d.z;
      if (tc < 0 || tc > maxD + C.WORM_R) continue;
      const dd = ex * ex + ey * ey + ez * ez - tc * tc;
      if (dd >= C.WORM_R * C.WORM_R) continue;
      const t = tc - Math.sqrt(C.WORM_R * C.WORM_R - dd);
      if (t < tw) { tw = t; worm = m; }
    }
    const lim = M.min(maxD, tw);
    let tp = 0, hit = -1;
    for (let t = 0; t <= lim; t += step) {
      if (w.sample(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t) > 0) { hit = t; break; }
      tp = t;
    }
    if (hit >= 0) {                                                   // bisect the surface
      let a = tp, b = hit;
      for (let i = 0; i < 5; i++) { const mid = (a + b) / 2; if (w.sample(o.x + d.x * mid, o.y + d.y * mid, o.z + d.z * mid) > 0) b = mid; else a = mid; }
      const x = o.x + d.x * b, y = o.y + d.y * b, z = o.z + d.z * b;
      w.normal(x, y, z, tmpN);
      return { t: b, x, y, z, worm: null, nx: tmpN.x, ny: tmpN.y, nz: tmpN.z };
    }
    if (worm && tw <= maxD) return { t: tw, x: o.x + d.x * tw, y: o.y + d.y * tw, z: o.z + d.z * tw, worm, nx: -d.x, ny: -d.y, nz: -d.z };
    return null;
  };
  // a bullet: W3's SS.weaponsA.minigun_round when it exists, else a local one with the same signature
  GD.round = function (S, o, d, owner, dmg) {
    const SK = K.SENTRY;
    if (SS.weaponsA && SS.weaponsA.minigun_round) { SS.weaponsA.minigun_round(S, o, d, owner, { dmg: dmg != null ? dmg : SK.DMG, range: SK.ROUND_RANGE, src: C.DS.SENTRY }); sim().emit(S, 'sgshot', { x: o.x, y: o.y, z: o.z, dx: d.x, dy: d.y, dz: d.z, len: 18 }); return; }
    const h = GD.ray(S, o, d, SK.ROUND_RANGE, { skip: -1, team: -1 });
    const end = h ? { x: h.x, y: h.y, z: h.z } : { x: o.x + d.x * SK.ROUND_RANGE, y: o.y + d.y * SK.ROUND_RANGE, z: o.z + d.z * SK.ROUND_RANGE };
    sim().emit(S, 'sgshot', { x: o.x, y: o.y, z: o.z, dx: d.x, dy: d.y, dz: d.z, len: h ? h.t : SK.ROUND_RANGE, hit: h ? 1 : 0 });
    if (!h) return;
    if (h.worm) {
      S.hitDir = { x: d.x, y: d.y, z: d.z };
      sim().hurt(S, h.worm, dmg || SK.DMG, C.DS.SENTRY);
      WPN().shove(S, h.worm, d.x * SK.PUSH, d.y * SK.PUSH + 0.1, d.z * SK.PUSH);
    } else {
      W().carve(h.x + d.x * 0.05, h.y + d.y * 0.05, h.z + d.z * 0.05, 0.13); S.sectionDirty = true;
      sim().emit(S, 'sparks', { x: h.x, y: h.y, z: h.z, mode: 'torch' });
    }
  };
  // the support under a point (ground voxels or a bridge deck)
  function supported(S, x, y, z) {
    if (W().sample(x, y - 0.07, z) > 0) return true;
    return !!(SS.struct && SS.struct.floor_at && SS.struct.floor_at(S, x, y, z) > y - 0.12);
  }
  // push a point up out of the ground (max lift m); false when it is still inside
  function liftOut(S, p, max) {
    let l = 0; while (W().sample(p.x, p.y, p.z) > 0 && l < max) { p.y += 0.05; l += 0.05; }
    return W().sample(p.x, p.y, p.z) <= 0;
  }
  function inWater(S, p) { return p.y < sim().surface_at(S, p.x, p.z) - 0.05; }
  const nextId = S => ++S.gdId;
  const foesOf = (S, team) => S.worms.filter(o => !o.dead && o.hp > 0 && !o.reserve && !o.drowning && o.team !== team);

  /* ---------- use ---------- */
  GD.use = function (S, a, key, power) {
    const ap = P.to_plane(S, a.pos);
    switch (key) {
      case 'dog': return useDog(S, a, ap);
      case 'punch': return usePunch(S, a, ap);
      case 'sentry': return useSentry(S, a, ap);
      case 'claymore': return useClay(S, a, ap);
      case 'gravgun': return useGrav(S, a, ap, power);
    }
    return false;
  };
  const refuse = (S, txt) => { sim().log(S, txt, 0xffb27a); return false; };

  /* ===================== robotic dog ===================== */
  function useDog(S, a, ap) {
    const KD = K.DOG;
    if (a.air || S.rope) return refuse(S, 'Stand on the ground to release the dog.');
    if (S.dogs.length >= KD.MAX) return refuse(S, 'Too many dogs.');
    const f = a.facing, s0 = ap.s + f * 0.75;
    let y0 = a.pos.y - 0.5 + KD.R + 0.05, up = 0;
    while (P.blocked2(S, s0, y0) && up < 0.7) { y0 += 0.05; up += 0.05; }
    if (P.blocked2(S, s0, y0)) return refuse(S, 'No room for the dog here.');
    S.dogs.push({ id: nextId(S), team: a.team, owner: a.id, s: s0, y: y0, vs: 0, vy: 0, dir: f, life: KD.TIMER, age: 0, dist: 0, bark: rr(S, KD.BARK0, KD.BARK1), retarget: 0, blockT: 0, target: -1, hop: 0, state: 0 });
    sim().emit(S, 'dogstart', { wormId: a.id, x: a.pos.x, y: a.pos.y, z: a.pos.z });
    sim().log(S, `${a.name} lets the robo dog off the leash.`, sim().team_rgb(S, a.team));
    WPN().used(S, 'dog'); return true;
  }
  function dogBoom(S, d, why) {
    const KD = K.DOG, wp = P.to_world(S, d.s, d.y);
    const i = S.dogs.indexOf(d); if (i >= 0) S.dogs.splice(i, 1);
    sim().emit(S, 'dogboom', { x: wp.x, y: wp.y, z: wp.z, why: why || '' });
    sim().explode(S, { x: wp.x, y: wp.y + 0.1, z: wp.z }, { W: KD.W, dmg: KD.DMG, name: 'a robo dog' }, d.owner);
    S.lastBoom = S.time;
  }
  function stepDog(S, d, dt) {
    const KD = K.DOG, R = KD.R, G = C.G;
    d.age += dt; d.life -= dt; d.retarget -= dt; d.bark -= dt;
    const wp = P.to_world(S, d.s, d.y);
    // steer to the nearest foe (3D distance, those on the section first), re-evaluated 4 x a second
    if (d.retarget <= 0) {
      d.retarget = 0.25;
      let best = null, bd = 1e9;
      for (const o of foesOf(S, d.team)) {
        const q = P.to_plane(S, o.pos), dd = hypot3(o.pos, wp) + (Math.abs(q.t) > C.HALF + 0.3 ? 40 : 0);
        if (dd < bd) { bd = dd; best = o; }
      }
      d.target = best ? best.id : -1;
      if (best) { const q = P.to_plane(S, best.pos); if (Math.abs(q.s - d.s) > 0.45) d.dir = q.s > d.s ? 1 : -1; }
    }
    // reached a foe: explode
    for (const o of foesOf(S, d.team)) if (hypot3(o.pos, wp) < KD.REACH + C.WORM_R * 0.5) { dogBoom(S, d, 'reached'); return; }
    if (d.life <= 0) { dogBoom(S, d, 'timer'); return; }
    if (inWater(S, wp)) { d.life = M.min(d.life, 0.8); d.vs *= 0.3; }
    if (d.bark <= 0) { d.bark = rr(S, KD.BARK0, KD.BARK1); sim().emit(S, 'dogbark', { x: wp.x, y: wp.y, z: wp.z }); }
    const grounded = P.blocked2(S, d.s, d.y - R - 0.06) && d.vy <= 0.01;
    // horizontal speed: accelerate to the run speed (a little in the air)
    const want = d.dir * KD.SPEED, k = M.min(1, (grounded ? KD.ACC : 2) * dt);
    d.vs += (want - d.vs) * k;
    // the obstacle ahead: how far up must the dog get to clear it? (probe the front at foot and head height)
    const px = d.s + d.dir * (R + 0.06 + Math.abs(d.vs) * dt);
    let need = 0;
    while (need <= KD.HOP_MAX + 0.01 && (P.blocked2(S, px, d.y - R + 0.1 + need) || P.blocked2(S, px, d.y + R * 0.6 + need))) need += 0.07;
    d.state = grounded ? 0 : 2;
    if (need > 0.001 && grounded) {
      if (need <= KD.STEP_UP) { d.y += need; d.vy = 0; }                                  // a kerb: just step up
      else if (need <= KD.HOP_MAX) {                                                    // hop it
        d.vy = Math.sqrt(2 * G * (need + 0.35)); d.hop = 0.3; d.state = 2;
        sim().emit(S, 'doghop', { x: wp.x, y: wp.y, z: wp.z });
      } else { d.vs = 0; d.state = 1; d.blockT += dt; }                                // too high: stuck until the timer ends
    } else if (need > 0.001) d.vs = M.min(Math.abs(d.vs), 1.2) * d.dir * 0.5;       // in the air against a wall
    if (d.state !== 1) d.blockT = 0;
    d.hop = M.max(0, d.hop - dt);
    d.vy -= G * dt;
    let ns = d.s + d.vs * dt, ny = d.y + d.vy * dt;
    if (P.blocked2(S, ns + d.dir * R, ny) && !(need <= 0.001)) ns = d.s;               // (the hop clears it next step)
    if (d.vy <= 0 && P.blocked2(S, ns, ny - R)) {                                        // land: stand on the surface
      let lift = 0; while (P.blocked2(S, ns, ny - R + 0.02) && lift < 0.6) { ny += 0.02; lift += 0.02; }
      d.vy = 0;
    }
    if (d.vy > 0 && P.blocked2(S, ns, ny + R)) d.vy = 0;                                 // bumped its head
    d.s = ns; d.y = ny;
    if (grounded) d.dist += Math.abs(d.vs) * dt;
    if (d.y < 0.4 || d.s < -200 || d.s > 400) { const i = S.dogs.indexOf(d); if (i >= 0) S.dogs.splice(i, 1); }   // fell off the world
  }

  /* ===================== knockout punch ===================== */
  function usePunch(S, a, ap) {
    const KP = K.PUNCH;
    let best = null, bd = 1e9;
    for (const o of S.worms) {
      if (o.dead || o === a || o.reserve || o.drowning) continue;
      const q = P.to_plane(S, o.pos), ds = (q.s - ap.s) * a.facing, dy = o.pos.y - a.pos.y;
      if (ds < -0.2 || ds > KP.REACH || Math.abs(dy) > KP.DY || Math.abs(q.t) > KP.DT) continue;
      const dd = M.len2(ds, dy); if (dd < bd) { bd = dd; best = o; }
    }
    if (!best) return refuse(S, 'No worm within reach of the punch.');
    S.punches.push({ id: nextId(S), wid: a.id, victim: best.id, t0: S.time, dir: a.facing, done: 0 });
    a.vy = KP.VY; a.vs = 0; a.air = true; a.hop = false; a.slide = false; a.squash = S.time; if (S.rope) S.rope = null;
    sim().emit(S, 'punch', { wormId: a.id, victimId: best.id, dir: a.facing });
    sim().log(S, `${a.name} winds up an uppercut at ${best.name}.`, sim().team_rgb(S, a.team));
    WPN().used(S, 'punch'); return true;
  }
  function stepPunches(S, dt) {
    const KP = K.PUNCH;
    for (let i = S.punches.length - 1; i >= 0; i--) {
      const p = S.punches[i];
      if (p.done) { if (S.time - p.t0 > 3) S.punches.splice(i, 1); continue; }
      if (S.time - p.t0 < KP.HIT_T) continue;
      p.done = 1;
      const a = S.worms.find(o => o.id === p.wid), v = S.worms.find(o => o.id === p.victim);
      if (!a || !v || a.dead || v.dead) continue;
      const ap = P.to_plane(S, a.pos), q = P.to_plane(S, v.pos), ds = (q.s - ap.s) * p.dir;
      if (ds < -0.6 || ds > KP.REACH + 0.5 || Math.abs(q.t) > KP.DT + 0.3) { sim().emit(S, 'punchmiss', { wormId: a.id}); continue; }   // it moved away
      const d = P.dir(S), n = { x: d.x * p.dir, y: 0, z: d.z * p.dir };
      S.hitDir = { x: n.x, y: 0.5, z: n.z };
      sim().hurt(S, v, KP.DMG, C.DS.PUNCH);
      // flung away in the punch direction (and up), tumbling
      v.slide = true; v.flip = false;
      WPN().shove(S, v, n.x * KP.V_OUT, KP.V_UP, n.z * KP.V_OUT);
      sim().emit(S, 'punchhit', { wormId: a.id, victimId: v.id, x: v.pos.x, y: v.pos.y, z: v.pos.z, dx: n.x, dz: n.z, spin: KP.SPIN * (rng(S) < 0.5 ? -1 : 1) });
      S.lastBoom = S.time;
    }
  }

  /* ===================== sentry gun ===================== */
  /* a planted sentry gun (the worm's use and the debug toolbox share it): p = world position, already clear of the ground */
  GD.make_sentry = function (S, team, owner, p) {
    const KS = K.SENTRY, q = { id: nextId(S), team, owner, pos: p, vy: 0, yaw: rr(S, 0, 6.28), pitch: 0, spin: rng(S) < 0.5 ? KS.SPIN : -KS.SPIN, tilt: 0, tiltAz: 0,
      ammo: KS.AMMO, hp: KS.HP, state: 0, cool: 1.0, erT: 0, deadT: 0, beamLen: KS.RANGE, burst: { left: 0, t: 0, target: -1 }, turns: KS.TURNS, planted: S.time };
    S.sentries.push(q); return q;
  };
  /* a claymore lying on the ground at pos facing -1 / 1 along the section (the debug toolbox; the worm's own plant is useClay) */
  GD.make_claymore_ground = function (S, team, owner, pos, facing) {
    const KC = K.CLAY, d3 = P.dir(S), nn = P.nrm(S), q = { id: nextId(S), team, owner, pos, dir: { x: d3.x * facing, y: 0, z: d3.z * facing }, nrm: { x: 0, y: 1, z: 0 }, pdir: { x: d3.x, z: d3.z }, pn: { x: nn.x, z: nn.z },
      armAt: S.time + KC.ARM, hp: KC.HP, vy: 0, attach: 0, tree: -1, seg: -1, turns: KC.TURNS, planted: S.time, armed: 0 };
    q.pos.y += 0.1; S.claymores.push(q); return q;
  };
  function useSentry(S, a, ap) {
    const KS = K.SENTRY;
    if (a.air || S.rope) return refuse(S, 'Stand on the ground to set up the sentry gun.');
    if (S.sentries.filter(q => q.state !== 2).length >= KS.MAX) return refuse(S, 'Too many sentry guns.');
    const w = P.to_world(S, ap.s + a.facing * 0.9, a.pos.y - 0.45), p = { x: w.x, y: w.y, z: w.z };
    if (!liftOut(S, p, 0.7)) return refuse(S, 'No room for the sentry gun here.');
    GD.make_sentry(S, a.team, a.id, p);
    sim().emit(S, 'sentryplant', { x: p.x, y: p.y, z: p.z });
    sim().log(S, `${a.name} sets up a sentry gun.`, sim().team_rgb(S, a.team));
    WPN().used(S, 'sentry'); return true;
  }
  function knock(S, s, dir) {
    if (s.state !== 0) return;
    s.state = 1; s.burst.left = 0; s.tiltAz = M.atan2(dir.z, dir.x); s.erT = 0.15;
    sim().emit(S, 'sentrydown', { x: s.pos.x, y: s.pos.y, z: s.pos.z });
    sim().log(S, 'A sentry gun is knocked over and fires wildly!', 0xffb27a);
  }
  function sentryBreak(S, s) {
    const i = S.sentries.indexOf(s); if (i >= 0) S.sentries.splice(i, 1);
    sim().emit(S, 'devbreak', { x: s.pos.x, y: s.pos.y, z: s.pos.z, kind: 'sentry' });
    sim().explode(S, { x: s.pos.x, y: s.pos.y + 0.3, z: s.pos.z }, { W: 0.06, dmg: 6, name: 'a sentry gun' }, null);
  }
  const wrapA = a => M.wrap_angle(a);
  function stepSentry(S, s, dt) {
    const KS = K.SENTRY, w = W();
    // gravity: settles onto the ground (and into the water: shorts out)
    if (!supported(S, s.pos.x, s.pos.y, s.pos.z)) { s.vy -= C.G * dt; s.pos.y += s.vy * dt; if (s.pos.y < 0.3) { S.sentries.splice(S.sentries.indexOf(s), 1); return; } }
    else { s.vy = 0; let l = 0; while (w.sample(s.pos.x, s.pos.y - 0.02, s.pos.z) > 0 && l < 0.5) { s.pos.y += 0.02; l += 0.02; } }
    if (inWater(S, { x: s.pos.x, y: s.pos.y + 0.2, z: s.pos.z }) && s.state !== 2) { s.state = 2; sim().emit(S, 'steam', { x: s.pos.x, y: s.pos.y, z: s.pos.z, power: 0.4 }); }
    s.tilt += ((s.state === 1 || s.state === 2 && s.tilt > 0.1 ? 1.45 : 0) - s.tilt) * M.min(1, dt / KS.FALL_T * 3);
    if (s.hp <= 0) { sentryBreak(S, s); return; }
    // knocked over by falling things: any heavy body moving fast into it
    if (s.state === 0 && (S.tick + s.id) % 4 === 0) {
      for (const b of S.bodies) {
        if (b.asleep || b.held || b.mass < 15) continue;
        const sp = M.len3(b.vel.x, b.vel.y, b.vel.z); if (sp < 3) continue;
        if (hypot3(b.pos, { x: s.pos.x, y: s.pos.y + 0.4, z: s.pos.z }) < b.rb + 0.5) { knock(S, s, { x: b.vel.x, y: 0, z: b.vel.z }); s.hp -= M.min(30, b.mass * sp * 0.02); break; }
      }
    }
    if (s.state === 2) { s.deadT += dt; return; }
    const o = { x: s.pos.x, y: s.pos.y + KS.BEAM_Y, z: s.pos.z };
    s.cool = M.max(0, s.cool - dt);
    if (s.state === 1) {                                                              // erratic fire until the rounds are out
      s.erT -= dt;
      if (s.erT <= 0) {
        s.erT = rr(S, KS.ER0, KS.ER1);
        s.yaw = rr(S, -3.14159, 3.14159); s.pitch = rr(S, -0.25, 0.7);
        const d = { x: M.cos(s.yaw) * M.cos(s.pitch), y: M.sin(s.pitch), z: M.sin(s.yaw) * M.cos(s.pitch) };
        GD.round(S, { x: o.x, y: o.y - 0.25, z: o.z }, d, s.owner, KS.DMG); s.ammo--;
        sim().emit(S, 'sentryshot', { x: o.x, y: o.y, z: o.z });
        if (s.ammo <= 0) { s.state = 2; sim().log(S, 'The toppled sentry gun runs out of rounds.', 0xdfe8f1); }
      }
      return;
    }
    // live: the beam turns with the gun; a foe in the sheet of the beam is shot at
    const b = s.burst;
    if (b.left > 0) {
      const tw = S.worms.find(q => q.id === b.target);
      const tp = tw ? { x: tw.pos.x, y: tw.pos.y, z: tw.pos.z } : null;
      if (!tw || tw.dead || w.solid_len(o.x, o.y, o.z, tp.x, tp.y, tp.z) > 0.4 || M.len2(tp.x - o.x, tp.z - o.z) > KS.RANGE + 2) { b.left = 0; s.cool = KS.COOL; }
      else {
        const wantY = M.atan2(tp.z - o.z, tp.x - o.x), wantP = M.atan2(tp.y - o.y, M.len2(tp.x - o.x, tp.z - o.z));
        const dy = wrapA(wantY - s.yaw), st = KS.TURN * dt; s.yaw += Math.abs(dy) < st ? dy : Math.sign(dy) * st; s.pitch += (wantP - s.pitch) * M.min(1, 10 * dt);
        b.t -= dt;
        if (b.t <= 0 && Math.abs(dy) < KS.ALIGN) {
          b.t = KS.ROUND_T; b.left--; s.ammo--;
          const sp = KS.SPREAD, d = norm3({ x: tp.x - o.x + rr(S, -sp, sp) * 6, y: tp.y - o.y + rr(S, -sp, sp) * 4, z: tp.z - o.z + rr(S, -sp, sp) * 6 });
          GD.round(S, o, d, s.owner, KS.DMG);
          sim().emit(S, 'sentryshot', { x: o.x, y: o.y, z: o.z });
          if (b.left <= 0) s.cool = KS.COOL;
          if (s.ammo <= 0) { s.state = 2; b.left = 0; sim().log(S, 'The sentry gun is out of rounds.', 0xdfe8f1); }
        }
      }
      s.beamLen = KS.RANGE; return;
    }
    s.yaw = wrapA(s.yaw + s.spin * dt); s.pitch += (0 - s.pitch) * M.min(1, 6 * dt);
    // beam length (to the first terrain) for the render
    { const d = { x: M.cos(s.yaw), y: 0, z: M.sin(s.yaw) }, h = GD.ray(S, o, d, KS.RANGE, { skip: -2, team: s.team, step: 0.3 }); s.beamLen = h && !h.worm ? h.t : KS.RANGE; }
    if (s.cool > 0) return;
    for (const f of foesOf(S, s.team)) {
      const dx = f.pos.x - o.x, dz = f.pos.z - o.z, r = M.len2(dx, dz);
      if (r > KS.RANGE || r < 0.3) continue;
      if (Math.abs(f.pos.y - o.y) > C.WORM_R + 0.12) continue;                            // the beam is a flat sheet: hop over it
      const diff = Math.abs(wrapA(M.atan2(dz, dx) - s.yaw)), half = M.atan2(C.WORM_R, r) + 0.5 * Math.abs(s.spin) * dt;
      if (diff > half) continue;
      if (w.solid_len(o.x, o.y, o.z, f.pos.x, f.pos.y, f.pos.z) > 0.3) continue;          // behind cover
      b.left = KS.BURST; b.t = 0; b.target = f.id;
      sim().emit(S, 'sentrydetect', { x: o.x, y: o.y, z: o.z, wormId: f.id});
      break;
    }
  }

  /* ===================== claymore ===================== */
  function useClay(S, a, ap) {
    const KC = K.CLAY, w = W();
    if (S.claymores.length >= KC.MAX) return refuse(S, 'Too many claymores.');
    const ad = sim().aim_dir(S), d3 = P.dir(S);
    // 1. the surface in reach along the aim: terrain, else a tree trunk
    let pos = null, nrm = null, attach = 0, tree = -1, seg = -1;
    const o = { x: a.pos.x, y: a.pos.y, z: a.pos.z }, dv = { x: d3.x * ad.s, y: ad.y, z: d3.z * ad.s };
    for (let t = 0.5; t <= KC.REACH && !pos; t += 0.08) {
      const x = o.x + dv.x * t, y = o.y + dv.y * t, z = o.z + dv.z * t;
      if (w.sample(x, y, z) > 0) { const n = w.normal(x, y, z, { x: 0, y: 0, z: 0 }); pos = { x, y, z }; nrm = n; attach = n.y > 0.75 ? 0 : 1; break; }
      if (SS.trees && S.trees) {
        for (const tr of S.trees) {
          if (!tr.alive) continue;
          for (let q = 0; q < tr.seg.length; q++) {
            const sg = tr.seg[q]; if (!sg.on || sg.kind !== 1) continue;
            const abx = sg.b.x - sg.a.x, aby = sg.b.y - sg.a.y, abz = sg.b.z - sg.a.z, u = M.sat(((x - sg.a.x) * abx + (y - sg.a.y) * aby + (z - sg.a.z) * abz) / (abx * abx + aby * aby + abz * abz || 1));
            const cx = sg.a.x + abx * u, cy = sg.a.y + aby * u, cz = sg.a.z + abz * u, rad = sg.r0 + (sg.r1 - sg.r0) * u, dd = M.len3(x - cx, y - cy, z - cz);
            if (dd < rad + 0.04) { const l = dd || 1; pos = { x, y, z }; nrm = { x: (x - cx) / l, y: (y - cy) / l, z: (z - cz) / l }; attach = 2; tree = tr.id; seg = q; break; }
          }
          if (pos) break;
        }
      }
    }
    // 2. nothing in reach: on the ground in front of the worm, facing the way it faces
    if (!pos) {
      const g = P.to_world(S, ap.s + a.facing * 0.8, a.pos.y - 0.45); pos = { x: g.x, y: g.y, z: g.z }; if (!liftOut(S, pos, 0.7)) return refuse(S, 'No room for the claymore here.');
      nrm = { x: 0, y: 1, z: 0 }; attach = 0;
    } else {
      pos = { x: pos.x + nrm.x * 0.1, y: pos.y + nrm.y * 0.1, z: pos.z + nrm.z * 0.1 };
      if (w.sample(pos.x, pos.y, pos.z) > 0) return refuse(S, 'No room for the claymore here.');
    }
    // 3. the laser / blast direction stays in the planting section: the surface normal projected onto the plane;
    //    ground (or a normal across the section) -> horizontal, the way the worm faces
    const nn = P.nrm(S);
    let ls = nrm.x * d3.x + nrm.z * d3.z, ly = nrm.y;
    const l2 = M.len2(ls, ly);
    if (attach === 0 || l2 < 0.45 || (attach === 1 && Math.abs(nrm.y) > 0.8)) { ls = a.facing; ly = 0; } else { ls /= l2; ly /= l2; }
    const dir = { x: d3.x * ls, y: ly, z: d3.z * ls };
    if (attach === 0) pos.y += 0.1;
    S.claymores.push({ id: nextId(S), team: a.team, owner: a.id, pos, dir, nrm: { x: nrm.x, y: nrm.y, z: nrm.z }, pdir: { x: d3.x, z: d3.z }, pn: { x: nn.x, z: nn.z }, armAt: S.time + KC.ARM, hp: KC.HP, vy: 0, attach, tree, seg,
      turns: KC.TURNS, planted: S.time, armed: 0 });
    sim().emit(S, 'claymoreplant', { x: pos.x, y: pos.y, z: pos.z });
    sim().log(S, `${a.name} plants a claymore.`, sim().team_rgb(S, a.team));
    WPN().used(S, 'claymore'); return true;
  }
  function claymoreBoom(S, c, why) {
    const KC = K.CLAY, w = W(), i = S.claymores.indexOf(c); if (i >= 0) S.claymores.splice(i, 1);
    const o = { x: c.pos.x + c.dir.x * 0.15, y: c.pos.y + c.dir.y * 0.15, z: c.pos.z + c.dir.z * 0.15 };
    sim().emit(S, 'claymoreblast', { x: o.x, y: o.y, z: o.z, dx: c.dir.x, dy: c.dir.y, dz: c.dir.z, why: why || '' });
    // a cone of pellets: random directions within CONE of the blast direction (deterministic stream), each stopped by
    // the first worm or surface it meets; worms take the sum of their hits, the ground is pitted
    const up = Math.abs(c.dir.y) > 0.95 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const ux = norm3({ x: c.dir.y * up.z - c.dir.z * up.y, y: c.dir.z * up.x - c.dir.x * up.z, z: c.dir.x * up.y - c.dir.y * up.x });
    const uy = { x: c.dir.y * ux.z - c.dir.z * ux.y, y: c.dir.z * ux.x - c.dir.x * ux.z, z: c.dir.x * ux.y - c.dir.y * ux.x };
    const dmg = new Float64Array(16), push = [];
    let bx0 = 1e9, by0 = 1e9, bz0 = 1e9, bx1 = -1e9, by1 = -1e9, bz1 = -1e9, pits = 0;
    for (let n = 0; n < KC.PELLETS; n++) {
      const cs = 1 - rng(S) * (1 - M.cos(KC.CONE)), sn = Math.sqrt(1 - cs * cs), ph = rng(S) * 6.2832;
      const d = { x: c.dir.x * cs + (ux.x * M.cos(ph) + uy.x * M.sin(ph)) * sn, y: c.dir.y * cs + (ux.y * M.cos(ph) + uy.y * M.sin(ph)) * sn, z: c.dir.z * cs + (ux.z * M.cos(ph) + uy.z * M.sin(ph)) * sn };
      const h = GD.ray(S, o, d, KC.RANGE, { skip: -2, team: -1, step: 0.25 });
      if (!h) continue;
      if (h.worm) {
        const k = 1 - 0.6 * h.t / KC.RANGE; if (!push[h.worm.id]) push[h.worm.id] = { x: 0, y: 0, z: 0 };
        dmg[h.worm.id] += KC.DMG * k;
        const pp = push[h.worm.id]; pp.x += d.x; pp.y += d.y; pp.z += d.z;
      } else if (pits < 40) {
        pits++; w.carve(h.x + d.x * 0.04, h.y + d.y * 0.04, h.z + d.z * 0.04, 0.12);
        bx0 = M.min(bx0, h.x); by0 = M.min(by0, h.y); bz0 = M.min(bz0, h.z); bx1 = M.max(bx1, h.x); by1 = M.max(by1, h.y); bz1 = M.max(bz1, h.z);
      }
    }
    if (pits) { S.sectionDirty = true; const H = w.H; if (S.settings.collapse && SS.collapse_hook) SS.collapse_hook(S, { i0: M.max(0, Math.floor(bx0 / H) - 1), i1: M.min(w.NX - 1, Math.ceil(bx1 / H) + 1), j0: M.max(0, Math.floor(by0 / H) - 1), j1: M.min(w.NY - 1, Math.ceil(by1 / H) + 1), k0: M.max(0, Math.floor(bz0 / H) - 1), k1: M.min(w.NZ - 1, Math.ceil(bz1 / H) + 1) }); }
    for (let id = 0; id < 16; id++) {                                             // (worm ids in id order, as the old object keys iterated)
      if (!push[id]) continue; const m = S.worms.find(q => q.id === id); if (!m || m.dead) continue;
      const pp = push[id], l = M.nz(M.len3(pp.x, pp.y, pp.z), 1);
      S.hitDir = { x: pp.x / l, y: pp.y / l, z: pp.z / l };
      sim().hurt(S, m, M.max(1, Math.round(dmg[id])), C.DS.CLAYMORE);
      WPN().shove(S, m, pp.x / l * 4 * M.min(1.5, dmg[id] / 30), pp.y / l * 3 + 2, pp.z / l * 4 * M.min(1.5, dmg[id] / 30));
    }
    sim().explode(S, { x: c.pos.x + c.dir.x * 0.3, y: c.pos.y + c.dir.y * 0.3, z: c.pos.z + c.dir.z * 0.3 }, { W: KC.W_CORE, dmg: 0, name: 'a claymore' }, c.owner);
    S.lastBoom = S.time;
  }
  function stepClay(S, c, dt) {
    const KC = K.CLAY, w = W();
    if (c.hp <= 0) { claymoreBoom(S, c, 'shot'); return; }
    // support: a wall / tree keeps it up; with no support it falls to the ground
    let ok = true;
    if (c.attach === 1) ok = w.sample(c.pos.x - c.nrm.x * 0.14, c.pos.y - c.nrm.y * 0.14, c.pos.z - c.nrm.z * 0.14) > 0;
    else if (c.attach === 2) { const t = S.trees && S.trees.find(q => q.id === c.tree); ok = !!(t && t.alive && t.seg[c.seg] && t.seg[c.seg].on); }
    else ok = supported(S, c.pos.x, c.pos.y - 0.1, c.pos.z);
    if (!ok) {
      c.vy -= C.G * dt; c.pos.y += c.vy * dt;
      if (supported(S, c.pos.x, c.pos.y - 0.1, c.pos.z)) { c.attach = 0; c.vy = 0; c.nrm = { x: 0, y: 1, z: 0 }; }
      if (c.pos.y < 0.3) { S.claymores.splice(S.claymores.indexOf(c), 1); return; }
    }
    // (P38 R1) electronics short out in the water like the sentry: a claymore under the surface is a dud (it is removed, steam, no blast)
    if (inWater(S, { x: c.pos.x, y: c.pos.y + 0.1, z: c.pos.z })) {
      sim().emit(S, 'steam', { x: c.pos.x, y: c.pos.y, z: c.pos.z, power: 0.4 });
      S.claymores.splice(S.claymores.indexOf(c), 1); return;
    }
    if (!c.armed && S.time >= c.armAt) { c.armed = 1; sim().emit(S, 'claymorearm', { x: c.pos.x, y: c.pos.y, z: c.pos.z }); }
    if (!c.armed) return;
    // the laser: a segment LASER m long along dir, in the section of the planting. A worm's body (sphere) on it fires it
    const e = { x: c.pos.x + c.dir.x * KC.LASER, y: c.pos.y + c.dir.y * KC.LASER, z: c.pos.z + c.dir.z * KC.LASER };
    const sa = [c.pos.x, c.pos.y, c.pos.z], sb = [e.x, e.y, e.z];
    for (const m of S.worms) {
      if (m.dead || m.reserve) continue;
      if (M.seg_dist(m.pos.x, m.pos.y, m.pos.z, sa, sb) < C.WORM_R) { sim().log(S, `${m.name} walks into a claymore laser!`, 0xff8060); claymoreBoom(S, c, 'tripped'); return; }
    }
  }

  /* ===================== gravity gun ===================== */
  const grabbable = b => !b.held && b.mass <= K.GRAV.MASS_MAX && (b.prop === 'mine' || b.prop === 'barrel' || b.prop === 'crate' || b.kind === 'chunk' || b.kind === 'log');
  /* what the gun can take hold of from worm a: bodies within RANGE (3D) of its muzzle, the one best aligned with the aim
   * first. out = [{ b, d, cos }] */
  // P38 R3: the beam needs a line of sight (no grabbing through rock) and stays near the section plane (the 2D game plane): C.HALF
  function gunReach(S, a, p) {
    if (Math.abs(P.to_plane(S, p).t) > C.HALF) return false;
    return W().solid_len(a.pos.x, a.pos.y + 0.2, a.pos.z, p.x, p.y, p.z) <= 0.3;
  }
  GD.grabbables = function (S, a, out) {
    const KG = K.GRAV, ad = sim().aim_dir(S), d3 = P.dir(S), dv = { x: d3.x * ad.s, y: ad.y, z: d3.z * ad.s };
    out.length = 0;
    for (const b of S.bodies) {
      if (!grabbable(b) || (b.prop === 'mine' && b.disarmed)) continue;
      const vx = b.pos.x - a.pos.x, vy = b.pos.y - a.pos.y, vz = b.pos.z - a.pos.z, d = M.len3(vx, vy, vz);
      if (d > KG.RANGE || !gunReach(S, a, b.pos)) continue;
      out.push({ b, d, cos: d > 1e-3 ? (vx * dv.x + vy * dv.y + vz * dv.z) / d : 1 });
    }
    for (const c of S.crates) {                                                // P38-A4: supply crates (weapon / health / tool) too
      if (c.held) continue;
      const vx = c.pos.x - a.pos.x, vy = c.pos.y - a.pos.y, vz = c.pos.z - a.pos.z, d = M.len3(vx, vy, vz);
      if (d > KG.RANGE || !gunReach(S, a, c.pos)) continue;
      out.push({ b: c, d, cos: d > 1e-3 ? (vx * dv.x + vy * dv.y + vz * dv.z) / d : 1, crate: true });
    }
    const key = e => (e.cos > KG.AIM_COS ? -e.cos * 100 + e.d * 0.01 : 1000 + e.d);
    M.sort_stable(out, (p, q) => key(p) - key(q));
    return out;
  };
  const tmpList = [];
  function useGrav(S, a, ap, power) {
    const KG = K.GRAV;
    if (S.grab && S.grab.crate) {                                              // P38-A4: throw the held supply crate
      const c = S.crates.find(q => q.id === S.grab.body); S.grab = null;
      if (c) {
        const ad = sim().aim_dir(S), d3 = P.dir(S), pw = M.clamp(power != null ? power : S.power, 0, 1), v = 4 + (C.ARSENAL.gravgun.vmax || 24) * pw;
        c.held = false; c.thrown = 1; c.landed = false; c.by = a.id; c.pickT = S.time + KG.CRATE_LOCK;
        c.vel = { x: d3.x * ad.s * v, y: ad.y * v, z: d3.z * ad.s * v }; c.spin = rr(S, -4, 4);
        sim().emit(S, 'gravthrow', { wormId: a.id, x: c.pos.x, y: c.pos.y, z: c.pos.z, power: pw, crate: 1 });
        sim().log(S, `${a.name} hurls a supply crate with the gravity gun.`, sim().team_rgb(S, a.team));
      }
      WPN().used(S, 'gravgun'); return true;
    }
    if (S.grab) {                                                              // throw what is held
      const b = S.bodies.find(q => q.id === S.grab.body); S.grab = null;
      if (b) {
        b.held = false; b.asleep = false; b.sleepT = 0;
        const ad = sim().aim_dir(S), d3 = P.dir(S), pw = M.clamp(power != null ? power : S.power, 0, 1), v = 4 + (C.ARSENAL.gravgun.vmax || 24) * pw;
        b.vel.x = d3.x * ad.s * v; b.vel.y = ad.y * v; b.vel.z = d3.z * ad.s * v;
        b.w.x = rr(S, -3, 3); b.w.y = rr(S, -3, 3); b.w.z = rr(S, -3, 3);
        sim().emit(S, 'gravthrow', { wormId: a.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, power: pw });
        sim().log(S, `${a.name} hurls it with the gravity gun.`, sim().team_rgb(S, a.team));
      }
      WPN().used(S, 'gravgun'); return true;
    }
    const list = GD.grabbables(S, a, tmpList);
    if (!list.length) { S.charging = false; S.power = 0; return refuse(S, 'Nothing in range to grab.'); }
    const b = list[0].b;
    if (list[0].crate) {                                                       // a supply crate: it comes off its chute / the ground
      b.held = true; b.thrown = 0; b.landed = false; b.vel = null; b.by = -1;
      S.grab = { body: b.id, wid: a.id, crate: 1 }; S.charging = false; S.power = 0;
      sim().emit(S, 'grab', { wormId: a.id, body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, crate: 1 });
      return true;
    }
    b.held = true; b.asleep = false; b.sleepT = 0;
    if (b.prop === 'mine' && !b.disarmed) {                                    // a grabbed mine starts its countdown
      const mf = S.settings.mineFuse, fuse = typeof mf === 'number' ? mf : (mf === 'random' ? rr(S, 1, 3) : KG.MINE_FUSE);
      b.armed = true; if (b.det < 0 || b.det > S.time + fuse) b.det = S.time + fuse;
      sim().emit(S, 'minearm', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, fuse });
      sim().log(S, 'The mine is live: throw it!', 0xff8060);
    }
    S.grab = { body: b.id, wid: a.id, crate: 0 };
    S.charging = false; S.power = 0;
    sim().emit(S, 'grab', { wormId: a.id, body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z });
    return true;                                                               // (free: no ammo, the turn goes on)
  }
  // let go of what the gun holds without throwing it (turn over / worm dead): a body falls, a crate drops (and lands: it can be picked up)
  function releaseHeld(S, b, crate) {
    if (crate) { b.held = false; b.thrown = 1; b.landed = false; b.vel = { x: 0, y: 0, z: 0 }; b.by = -1; b.pickT = 0; b.spin = 0; }
    else { b.held = false; b.asleep = false; b.sleepT = 0; }
  }
  function stepGrab(S, dt) {
    const g = S.grab; if (!g) return;
    const KG = K.GRAV, a = S.worms.find(q => q.id === g.wid), b = g.crate ? S.crates.find(q => q.id === g.body) : S.bodies.find(q => q.id === g.body);
    if (!a || !b || a.dead || S.active !== a || S.phase !== 'play') { if (b) releaseHeld(S, b, g.crate); S.grab = null; return; }
    if (g.crate) {                                                             // the crate follows the muzzle (no physics while held)
      const ad = sim().aim_dir(S), ap = P.to_plane(S, a.pos), tp = P.to_world(S, ap.s + ad.s * KG.HOLD, a.pos.y + ad.y * KG.HOLD + 0.1), k = M.min(1, KG.FOLLOW * dt);
      let dx = (tp.x - b.pos.x) * k, dy = (tp.y - b.pos.y) * k, dz = (tp.z - b.pos.z) * k;
      const st = M.len3(dx, dy, dz), cap = KG.PULL_V * dt; if (st > cap) { const f = cap / st; dx *= f; dy *= f; dz *= f; }
      b.pos.x += dx; b.pos.y += dy; b.pos.z += dz; return;
    }
    const ad = sim().aim_dir(S), ap = P.to_plane(S, a.pos), tp = P.to_world(S, ap.s + ad.s * KG.HOLD, a.pos.y + ad.y * KG.HOLD + 0.1);
    const k = M.min(1, KG.FOLLOW * dt);
    let dx = (tp.x - b.pos.x) * k, dy = (tp.y - b.pos.y) * k, dz = (tp.z - b.pos.z) * k;
    const st = M.len3(dx, dy, dz), cap = KG.PULL_V * dt;                       // pulled in at 30 m/s at most
    if (st > cap) { const f = cap / st; dx *= f; dy *= f; dz *= f; }
    b.pos.x += dx; b.pos.y += dy; b.pos.z += dz;
    b.vel.x = dx / dt; b.vel.y = dy / dt; b.vel.z = dz / dt;                  // (carried momentum: a flick of the aim throws it a little)
    b.w.x *= 0.9; b.w.y *= 0.9; b.w.z *= 0.9; b.asleep = false; b.sleepT = 0;
  }

  /* ---------- per step / turn ---------- */
  GD.step = function (S, dt) {
    if (S.dogs.length) for (const d of S.dogs.slice()) if (S.dogs.indexOf(d) >= 0) stepDog(S, d, dt);
    if (S.punches.length) stepPunches(S, dt);
    if (S.sentries.length) for (const s of S.sentries.slice()) if (S.sentries.indexOf(s) >= 0) stepSentry(S, s, dt);
    if (S.claymores.length) for (const c of S.claymores.slice()) if (S.claymores.indexOf(c) >= 0) stepClay(S, c, dt);
    if (S.grab) stepGrab(S, dt);
  };
  GD.busy = S => S.dogs.length > 0 || S.punches.some(p => !p.done);
  GD.turn_start = function (S) {
    if (S.grab) { const b = S.grab.crate ? S.crates.find(q => q.id === S.grab.body) : S.bodies.find(q => q.id === S.grab.body); if (b) releaseHeld(S, b, S.grab.crate); S.grab = null; }
    for (let i = S.sentries.length - 1; i >= 0; i--) { const s = S.sentries[i]; if (--s.turns <= 0 || (s.state === 2 && s.deadT > 8)) { S.sentries.splice(i, 1); sim().emit(S, 'devbreak', { x: s.pos.x, y: s.pos.y, z: s.pos.z, kind: 'sentry', expired: 1 }); } }
    for (let i = S.claymores.length - 1; i >= 0; i--) { const c = S.claymores[i]; if (--c.turns <= 0) { S.claymores.splice(i, 1); sim().emit(S, 'devbreak', { x: c.pos.x, y: c.pos.y, z: c.pos.z, kind: 'claymore', expired: 1 }); } }
  };
  // blasts (WP.blast -> here): hurt / knock over sentries, set off claymores and dogs. Same pressure factor as devices
  GD.blast = function (S, c, Wkg, dmg) {
    const BL = SS.blast, R = 2.83 * M.cbrt(Wkg), dP = dmg != null ? dmg : 50 * M.pow(Wkg, 0.28);
    for (const s of S.sentries.slice()) {
      const d = hypot3({ x: s.pos.x, y: s.pos.y + 0.3, z: s.pos.z }, c), f = BL.poc_factor(d, R);
      if (f <= 0) continue;
      s.hp -= dP * f * 0.6;
      if (f >= K.SENTRY.KNOCK_F) knock(S, s, { x: s.pos.x - c.x, y: 0, z: s.pos.z - c.z });
    }
    for (const q of S.claymores.slice()) { const f = BL.poc_factor(hypot3(q.pos, c), R); if (f > 0) q.hp -= dP * f; }
    for (const d of S.dogs.slice()) { const wp = P.to_world(S, d.s, d.y), f = BL.poc_factor(hypot3(wp, c), R); if (f > 0.4) d.life = M.min(d.life, 0.05); }
  };
  GD.hash = function (S, mix) {
    for (const d of S.dogs) { mix(d.s); mix(d.y); }
    for (const s of S.sentries) { mix(s.pos.y); mix(s.yaw); mix(s.ammo); mix(s.state); }
    for (const c of S.claymores) { mix(c.pos.x); mix(c.pos.y); mix(c.armed); }
    if (S.grab) mix(S.grab.body);
    for (const c of S.crates) { mix(c.pos.x); mix(c.pos.y); mix(c.pos.z); mix(c.held ? 1 : 0); }
    mix(S.gdRng ? S.gdRng.s : 0);
  };
  GD.stats = S => ({ dogs: S.dogs.length, sentries: S.sentries.length, claymores: S.claymores.length, grab: !!S.grab });

  /* ---------- CPU ---------- */
  // candidate plans for sim/ai.js specials(): comparable to its score() (expected damage; kill bonus)
  // can a dog run from plane s0 to s1: walk the ground every 0.4 m, no step higher than the hop, no drop over 3 m, no water
  function dogPathOk(S, s0, s1, y0) {
    const KD = K.DOG, dir = s1 >= s0 ? 1 : -1, WPm = WPN();
    let gy = WPm.ground_below(S, s0, y0 + 1);
    for (let s = s0 + dir * 0.4; (s1 - s) * dir > 0.5; s += dir * 0.4) {
      const g = WPm.ground_below(S, s, gy + KD.HOP_MAX + 1.2), wp = P.to_world(S, s, g);
      if (g < -1e8 || g > gy + KD.HOP_MAX || g < gy - 3 || g < sim().surface_at(S, wp.x, wp.z) + 0.05) return false;
      gy = g;
    }
    return true;
  }
  GD.ai_cands = function (S, pl, a, tgt, cands) {
    const can = k => SS.weapons.can_use(S, k), ap = P.to_plane(S, a.pos), tp = P.to_plane(S, tgt.pos);
    const ds = tp.s - ap.s, dist = M.len2(ds, tgt.pos.y - a.pos.y), facing = ds >= 0 ? 1 : -1, onSec = Math.abs(tp.t) < C.HALF;
    if (tgt.team === a.team) return;
    if (can('punch') && Math.abs(ds) < 1.5 && Math.abs(tgt.pos.y - a.pos.y) < 1.1 && Math.abs(tp.t) < 0.7) cands.push({ special: 'punch', v: M.min(tgt.hp, 30) + 30 + (tgt.hp <= 30 ? 25 : 0), aim: 0.3, facing });
    // the dog: worth it when the foe is on the section within ~30 m and the ground between is runnable (no wall over the dog's
    // 0.95 m hop, no cliff or water): it then beats most lobbed shots at a distant, covered or entrenched worm
    if (can('dog') && onSec && dist > 3 && dist < 32 && Math.abs(tgt.pos.y - a.pos.y) < 6 && dogPathOk(S, ap.s, tp.s, a.pos.y)) cands.push({ special: 'dog', v: M.min(tgt.hp, K.DOG.DMG) * 0.55 + (tgt.hp <= K.DOG.DMG ? 8 : 0), aim: 0, facing });   // (P38: measured, the dog got there in 40 % of the runs: x 1.35 was 3 x too high)
    // (P38-R2: v 66 -> 20: the gun fires ~4 s at a foe in its view; needs a clear line, any shot worth >= ~18 beats it)
    if (can('sentry') && onSec && dist < 12 && dist > 4 && SS.world.solid_len(a.pos.x, a.pos.y + 0.5, a.pos.z, tgt.pos.x, tgt.pos.y + 0.3, tgt.pos.z) < 0.3) cands.push({ special: 'sentry', v: 20, aim: 0, facing });
    if (can('claymore') && onSec && dist < 7 && dist > 2.5) cands.push({ special: 'claymore', v: 34, aim: 0, facing });
  };
  GD.ai_fire = function (S, a, b) {
    S.weapon = b.special; a.facing = b.facing; S.aim = b.aim || 0;
    if (b.special === 'claymore') S.aim = -0.2;
    SS.weapons.use(S, 0);
  };
})(window.SS = window.SS || {});
