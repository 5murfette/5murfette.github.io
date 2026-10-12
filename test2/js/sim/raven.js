/* sim/raven.js — P37-W3: the boomerang and the mail raven (sub-module of sim/weaponsa.js; data: C.ARMS.BOOM / RAVEN).
 * Both fly in the section plane (s, y) like the other shells; portable, deterministic (S.wa.rng), state in S.wa.
 *
 * Boomerang (S.wa.boom[]): P93 flight = a harmonic orbit about an off-axis centre (see WA.boom_acc), lift GK, drag, a sink; it leaves on the aim vector, curls
 * round and comes back LOWER and past the thrower (never homing). Any contact (terrain, prop / mine / barrel / bridge body, device, landed crate, a worm
 * other than the thrower) blows it up like ONE cluster bomblet (C.PROJ.clusterlet W / dmg, the normal HE crater), and a worm hit head-on is punched along the
 * flight. Past T x END s it is a spent piece of wood: it drops, thuds and vanishes (no blast). The thrower catches it near them (no damage, no refund); a contact within SAFE_R m of the thrower after ARM_OWN s is a dud (a thud, no blast), so a return pass never blasts its own thrower.
 * Mail raven (S.wa.ravens[], S.wa.letters[]): see RAVEN in sim/arsenala.js. Phases: fly (fast launch, then cruise with
 * probe-based path finding around / over terrain), orbit (circles ALT m above the target, drops N letters), leave, crash
 * (a launch into something above CRASH_V m/s: it bumps, falls, lies and blows up after CRASH_FUSE s).
 * C layout: struct Boom { f32 s, y, s0, y0, vs, vy, cs, cy, sk, bk, age, rest; i8 face; i16 owner; u8 dead, bounces; };
 *           struct Raven { f32 s, y, ang, v, ts, ty, age, oa, orbitT, dropT, bestD, stuckT, fuse, off, offT; u8 phase, dropped, rest; i16 owner; };
 *           struct Letter { f32 s, y, vs, vy, age, ph; i16 owner; }; */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane, A = C.ARMS;
  const WA = SS.weaponsA;
  if (!WA) return;
  const sim = () => SS.sim, WPm = () => SS.weapons, W = () => SS.world;
  const rr = WA.rr;
  const hyp3 = (a, b) => M.len3(a.x - b.x, a.y - b.y, a.z - b.z);

  /* ---------- the boomerang ---------- */
  // P93: the flight is a harmonic orbit (a boomerang's banked, precessing circle seen in the section plane) about a centre CTR that is NOT the
  // thrower: it sits KL x V / om from the throw point at KAP rad to the aim's lifting side (up for a throw to the right, mirrored with
  // the facing). Thrown at V m/s along the aim it leaves on the aim vector, curls over, and comes back along a reflected arc that,
  // because the lift (GK of g is carried by the wings, the rest pulls it down) and the drag bleed it, passes lower than the throw
  // (about SINK m) and never homes in on the worm: it flies on past, round the corner into caves and under overhangs.
  // WA.boom_acc is the one force law (the real flight and the CPU's forward run both call it).
  WA.boom_make = function (K, s0, y0, vs, vy, face) {
    const sp = M.len2(vs, vy), om = 2 * Math.PI / K.T, th = M.atan2(vy, vs), L = K.KL * sp / om, ac = th + (face >= 0 ? 1 : -1) * K.KAP;
    return { s: s0, y: y0, vs, vy, cs: s0 + L * M.cos(ac), cy: y0 + L * M.sin(ac), sk: K.SINK * L, bk: K.BACK * L, age: 0, face: face >= 0 ? 1 : -1 };
  };
  WA.boom_acc = function (K, b, out) {
    const om = 2 * Math.PI / K.T, f = M.smooth(M.clamp(b.age / (K.T * K.SINK_T), 0, 1)), cy = b.cy - b.sk * f, cs = b.cs - b.face * b.bk * f;
    out.s = -om * om * (b.s - cs) - K.DRAG * b.vs;
    out.y = -om * om * (b.y - cy) - K.DRAG * b.vy - C.G * K.GK;
  };
  const bacc = { s: 0, y: 0 };
  WA.mod_charge = function (S, key, a, ap, aim, speed) {
    if (key !== 'boomerang') return false;
    const wa = S.wa, K = A.BOOM, face = a.facing >= 0 ? 1 : -1;
    const b = WA.boom_make(K, ap.s + aim.s * 0.7, a.pos.y + aim.y * 0.7, aim.s * speed, aim.y * speed, face);
    b.id = ++wa.n; b.owner = a.id; b.rest = 0; b.dead = false; b.bounces = 0; b.s0 = ap.s; b.y0 = a.pos.y;
    wa.boom.push(b);
    sim().emit(S, 'boomthrow', { wormId: a.id});
    return true;
  };
  function endBoom(S, i, why) { const b = S.wa.boom[i]; S.wa.boom.splice(i, 1); sim().emit(S, 'boomend', { x: P.to_world(S, b.s, b.y).x, y: b.y, z: P.to_world(S, b.s, b.y).z, why }); }
  // the blast of ONE cluster bomblet (C.PROJ.clusterlet: W, dmg); a worm hit head-on is also punched along the flight
  function boomBlast(S, i, wp, hitWorm, dx, dy) {
    const b = S.wa.boom[i], pd = C.PROJ.clusterlet, K = A.BOOM;
    S.wa.boom.splice(i, 1);
    sim().emit(S, 'boomhit', { wormId: hitWorm ? hitWorm.id : -1, x: wp.x, y: wp.y, z: wp.z });
    if (hitWorm && !hitWorm.dead) { const v = pw(S, dx * K.PUSH, dy * K.PUSH + K.PUSH_UP); WPm().shove(S, hitWorm, v.x, v.y, v.z); }
    sim().explode(S, wp, { W: pd.W, dmg: pd.dmg, name: 'a boomerang' }, b.owner);
    S.lastBoom = S.time;
  }
  function stepBoom(S, dt) {
    const wa = S.wa, K = A.BOOM, w = W(), wv = { x: 0, y: 0, z: 0 };
    for (let i = wa.boom.length - 1; i >= 0; i--) {
      const b = wa.boom[i]; b.age += dt;
      const owner = S.worms[b.owner];
      if (b.age > K.LIFE) { endBoom(S, i, 'life'); continue; }
      if (!b.dead) {
        WA.boom_acc(K, b, bacc);
        b.vs += bacc.s * dt; b.vy += bacc.y * dt;
        if (SS.weather) {                                              // light: the wind nudges it (in-plane part of the air velocity)
          const wp0 = P.to_world(S, b.s, b.y); SS.weather.wind_at(S, wp0.x, b.y, wp0.z, wv);
          const d = P.dir(S); b.vs += (wv.x * d.x + wv.z * d.z) / C.WIND_UNIT * C.WIND_ACC * K.WIND_K * dt;
        }
        if (Math.floor(b.age / K.WHOOSH) !== Math.floor((b.age - dt) / K.WHOOSH)) { const wq = P.to_world(S, b.s, b.y); sim().emit(S, 'boomwhoosh', { x: wq.x, y: b.y, z: wq.z, speed: M.len2(b.vs, b.vy) }); }   // audio: one whoosh per WHOOSH s, pitched by the speed
        if (b.age > K.T * K.END) b.dead = true;                        // the flight is over: a spent piece of wood, it drops
      } else { b.vy -= C.G * dt; b.vs *= M.exp(-0.6 * dt); }
      const sp = M.len2(b.vs, b.vy), n = M.max(1, Math.ceil(sp * dt / 0.1)), hh = dt / n;
      let gone = false;
      for (let q = 0; q < n && !gone; q++) {
        const ns = b.s + b.vs * hh, ny = b.y + b.vy * hh, wp = P.to_world(S, ns, ny);
        if (ny < sim().surface_at(S, wp.x, wp.z) || ny < 0.3) { sim().emit(S, 'splash', { x: wp.x, y: sim().surface_at(S, wp.x, wp.z), z: wp.z, size: 0.5 }); endBoom(S, i, 'water'); gone = true; break; }
        if (wp.x < -30 || wp.z < -30 || wp.x > w.SX + 30 || wp.z > w.SZ + 30) { endBoom(S, i, 'oob'); gone = true; break; }
        if (!b.dead) {
          const l = sp || 1, dx = b.vs / l, dy = b.vy / l;
          for (const o of S.worms) {
            if (o.dead || o.drowning) continue;
            const d = hyp3(o.pos, wp);
            if (o === owner) {
              if (b.age > K.ARM_OWN && d < K.CATCH_R) { sim().emit(S, 'boomcatch', { wormId: o.id}); sim().log(S, `${o.name} catches the boomerang.`, sim().team_rgb(S, o.team)); endBoom(S, i, 'caught'); gone = true; break; }
              continue;
            }
            if (d < C.WORM_R + 0.18) { S.hitDir = pw(S, dx, dy); boomBlast(S, i, wp, o, dx, dy); gone = true; break; }
          }
          if (gone) break;
          // devices and landed crates are objects too
          for (const dv of S.devices) if (dv.hp > 0 && hyp3(dv.pos, wp) < K.OBJ_R) { boomBlast(S, i, wp, null, dx, dy); gone = true; break; }
          if (gone) break;
          for (const c of S.crates) if (c.landed && hyp3(c.pos, wp) < K.OBJ_R) { boomBlast(S, i, wp, null, dx, dy); gone = true; break; }
          if (gone) break;
        }
        const solid = P.solid2(S, ns, ny), bi = S.planeBodies.length ? P.body_at2(S, ns, ny, true) : -1;
        if (solid || bi >= 0) {
          if (!b.dead) {
            if (owner && !owner.dead && b.age > K.ARM_OWN && hyp3(owner.pos, wp) < K.SAFE_R) {         // back home: it fizzles next to its own thrower (a thud, no blast)
              sim().emit(S, 'boombounce', { x: wp.x, y: wp.y, z: wp.z, speed: sp }); S.lastBoom = S.time; endBoom(S, i, 'dud'); gone = true; break;
            }
            boomBlast(S, i, wp, null, 0, 0); gone = true; break;                       // terrain, prop, crate, mine, barrel, bridge: it goes off
          }
          const nn = bi >= 0 ? P.body_normal2(S, bi, ns, ny) : P.normal2(S, ns, ny), vn = b.vs * nn.s + b.vy * nn.y;
          if (vn < 0) {                                                                 // a spent piece of wood: a thud, no blast
            const spd = M.len2(b.vs, b.vy);
            b.vs -= (1 + K.REST) * vn * nn.s; b.vy -= (1 + K.REST) * vn * nn.y; b.vs *= 0.7; b.vy *= 0.7; b.bounces++;
            sim().emit(S, 'boombounce', { x: wp.x, y: wp.y, z: wp.z, speed: spd });
            S.lastBoom = S.time;
          }
          if (P.solid2(S, b.s + nn.s * 0.05, b.y + nn.y * 0.05) === false) { b.s += nn.s * 0.05; b.y += nn.y * 0.05; }
          if (M.len2(b.vs, b.vy) < 0.7) { b.vs = 0; b.vy = 0; }
          continue;
        }
        b.s = ns; b.y = ny;
      }
      if (gone) continue;
      if (b.dead && sp < 1.2) { b.rest += dt; if (b.rest > 1.2) endBoom(S, i, 'rest'); }
      S.lastBoom = S.time;
    }
  }
  const pw = (S, ds, dy) => { const d = P.dir(S); return { x: d.x * ds, y: dy, z: d.z * ds }; };

  /* ---------- the mail raven ---------- */
  WA.mod_use = function (S, key, a, ap, aim) {
    if (key !== 'raven') return null;
    const K = A.RAVEN, wa = S.wa;
    if (!S.tgt) { sim().log(S, 'Click the target first.', 0xffb27a); return false; }
    wa.ravens.push({ id: ++wa.n, s: ap.s + aim.s * 0.8, y: a.pos.y + aim.y * 0.8 + 0.2, ang: M.atan2(aim.y, aim.s), v: K.V_FAST, vs: aim.s * K.V_FAST, vy: aim.y * K.V_FAST, phase: 0, age: 0, ts: S.tgt.s, ty: S.tgt.y, owner: a.id,
      dropped: 0, oa: 0, orbitT: 0, dropT: 0, bestD: 1e9, stuckT: 0, fuse: 0, off: 0, offT: 0, face: a.facing >= 0 ? 1 : -1, cs: 0, cy: 0, leaveT: 0, rest: false, bounces: 0 });
    let gy = WPm().ground_below(S, S.tgt.s, W().SY - 0.5); if (gy < -1e8) gy = S.tgt.y;
    wa.ravens[wa.ravens.length - 1].gy = gy;
    S.tgt = null;
    sim().emit(S, 'ravenrelease', { wormId: a.id});
    sim().log(S, `${a.name} releases the mail raven.`, sim().team_rgb(S, a.team));
    WPm().used(S, 'raven');
    return true;
  };
  // phases: 0 fly, 1 orbit, 2 leave, 3 crash
  const probeClear = (S, s, y, ang, L) => {
    for (let d = 0.8; d <= L; d += 0.7) if (P.blocked2(S, s + M.cos(ang) * d, y + M.sin(ang) * d)) return false;
    return true;
  };
  const OFFS = [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.1, -2.1];
  function crash(S, r) {
    r.phase = 3; r.fuse = A.RAVEN.CRASH_FUSE; r.rest = false;
    r.vs = -M.cos(r.ang) * r.v * 0.25; r.vy = 3.5; r.v = 0;
    const wp = P.to_world(S, r.s, r.y);
    sim().emit(S, 'ravencrash', { x: wp.x, y: r.y, z: wp.z });
    sim().log(S, 'The raven smashes into the wall!', 0xffb27a);
  }
  /* phase 0 (the flight to the target), one step: returns 0 flying, 1 enters the orbit (r.phase = 1), 2 smashed into something
   * too fast (the caller crashes it). A pure function of r and the terrain, so the CPU (WA.raven_probe) flies the same path. */
  function fly0(S, r, dt) {
    const K = A.RAVEN;
    const spd = K.V_CRUISE + (K.V_FAST - K.V_CRUISE) * M.exp(-r.age / K.TAU);
    const cs = r.ts, cy = M.max(r.ty, r.gy) + K.ALT, dist = M.len2(cs - r.s, cy - r.y);
    if (dist < K.R_ORBIT * 1.4 || r.stuckT > 3.5) {
      r.phase = 1; r.cs = r.stuckT > 3.5 ? r.s : cs; r.cy = r.stuckT > 3.5 ? r.y : cy; r.oa = M.atan2(r.y - r.cy, r.s - r.cs); r.dropT = 0.15; return 1;
    }
    if (dist < r.bestD - 0.5) { r.bestD = dist; r.stuckT = 0; } else if (r.age > 1) r.stuckT += dt;
    // path finding: the heading toward the goal, else the nearest free deviation (re-picked every 0.15 s, kept between)
    const want = M.atan2(cy - r.y, cs - r.s);
    r.offT -= dt;
    if (r.offT <= 0) {
      r.offT = 0.15;
      const L = K.PROBE * (0.6 + 0.4 * spd / K.V_CRUISE);
      let pick = null;
      for (let k = 0; k < OFFS.length && pick == null; k++) if (probeClear(S, r.s, r.y, want + OFFS[k], L)) pick = OFFS[k];
      r.off = pick == null ? 2.4 : pick;
    }
    const goal = want + r.off, lim = K.TURN * (r.age < 0.6 ? 0.2 : 1) * dt;
    r.ang += M.clamp(M.wrap_angle(goal - r.ang), -lim, lim);
    r.v = spd;
    const ns = r.s + M.cos(r.ang) * spd * dt, ny = r.y + M.sin(r.ang) * spd * dt;
    const nw = P.to_world(S, ns, ny);
    if (P.blocked2(S, ns, ny) || ny < sim().surface_at(S, nw.x, nw.z) + 0.2) {
      if (spd > K.CRASH_V) return 2;
      r.ang += 0.9 * (r.off >= 0 ? 1 : -1) + 0.4; r.offT = 0.4;           // bumped something slowly: turn away, go up
      r.y += 0.05;
    } else { r.s = ns; r.y = ny; }
    return 0;
  }
  /* CPU (sim/aia.js): fly a raven released from the worm's hand along `aim` toward the target (ts, ty) without touching the
   * state: { ok: reaches the orbit above the target, crash, t: flight time, cs, cy: the orbit centre } */
  WA.raven_probe = function (S, a, ap, aimS, aimY, ts, ty) {
    const K = A.RAVEN;
    let gy = WPm().ground_below(S, ts, W().SY - 0.5); if (gy < -1e8) gy = ty;
    const r = { s: ap.s + aimS * 0.8, y: a.pos.y + aimY * 0.8 + 0.2, ang: M.atan2(aimY, aimS), v: K.V_FAST, phase: 0, age: 0, ts, ty, bestD: 1e9, stuckT: 0, off: 0, offT: 0, cs: 0, cy: 0, oa: 0, dropT: 0, gy };
    const dt = C.STEP;
    for (let i = 0; i < K.LIFE / dt; i++) {
      r.age += dt;
      const st = fly0(S, r, dt);
      if (st === 2) return { ok: false, crash: true, t: r.age };
      if (st === 1) return { ok: r.cs === ts, crash: false, t: r.age, cs: r.cs, cy: r.cy };
    }
    return { ok: false, crash: false, t: r.age };
  };
  function stepRavens(S, dt) {
    const wa = S.wa, K = A.RAVEN, w = W();
    for (let i = wa.ravens.length - 1; i >= 0; i--) {
      const r = wa.ravens[i]; r.age += dt; S.lastBoom = S.time;
      const owner = S.worms[r.owner];
      const wp = P.to_world(S, r.s, r.y);
      if (r.age > K.LIFE || wp.x < -40 || wp.z < -40 || wp.x > w.SX + 40 || wp.z > w.SZ + 40 || r.y > w.SY + 30) { sim().emit(S, 'ravenend', { x: wp.x, y: r.y, z: wp.z }); wa.ravens.splice(i, 1); continue; }
      if (r.phase === 3) {                                                    // crashed: bumps, falls, lies, blows up
        r.vy -= C.G * dt; r.vs *= M.exp(-0.7 * dt);
        const ns = r.s + r.vs * dt, ny = r.y + r.vy * dt;
        if (P.blocked2(S, ns, ny) || ny < sim().surface_at(S, wp.x, wp.z)) {
          if (r.vy < -1.5) { r.vy *= -0.3; r.vs *= 0.6; sim().emit(S, 'ravenbump', { x: wp.x, y: r.y, z: wp.z }); } else { r.vy = 0; r.vs *= 0.5; r.rest = true; }
        } else { r.s = ns; r.y = ny; }
        r.spin = (r.spin || 0) + dt * 9;
        if (r.rest || r.age > 4) r.fuse -= dt;
        if (r.fuse <= 0) {
          sim().emit(S, 'ravenend', { x: wp.x, y: r.y, z: wp.z, boom: 1 });
          sim().explode(S, { x: wp.x, y: r.y + 0.1, z: wp.z }, { W: K.CRASH_W, dmg: K.CRASH_DMG, name: 'the mail raven' }, r.owner);
          wa.ravens.splice(i, 1);
        }
        continue;
      }
      if (r.phase === 2) {                                                    // leaves: up and away
        r.leaveT += dt; r.v = K.V_CRUISE * 1.5;
        const ang = M.atan2(0.55, r.face); r.ang = ang;
        r.s += M.cos(ang) * r.v * dt; r.y += M.sin(ang) * r.v * dt;
        if (r.leaveT > 1.4) { sim().emit(S, 'ravenend', { x: wp.x, y: r.y, z: wp.z }); wa.ravens.splice(i, 1); }
        continue;
      }
      if (r.phase === 1) {                                                    // circles above the target, drops the letters
        r.v = K.V_CRUISE; r.oa += (r.v / K.R_ORBIT) * r.face * dt; r.orbitT += dt;
        const ns = r.cs + K.R_ORBIT * M.cos(r.oa), ny = r.cy + 0.35 * K.R_ORBIT * M.sin(r.oa);
        r.ang = M.atan2(ny - r.y, ns - r.s); r.s = ns; r.y = ny;
        r.dropT -= dt;
        if (r.dropT <= 0 && r.dropped < K.N) {
          r.dropT = K.DROP_GAP; r.dropped++;
          wa.letters.push({ id: ++wa.n, s: r.s, y: r.y - 0.2, vs: -M.sin(r.oa) * r.face * 1.2, vy: -0.5, age: 0, ph: rr(S, 0, 6.28), owner: r.owner });
          sim().emit(S, 'letterdrop', { x: wp.x, y: r.y, z: wp.z, n: r.dropped });
        }
        if (r.dropped >= K.N && r.dropT < -0.3) { r.phase = 2; r.leaveT = 0; }
        continue;
      }
      // phase 0: the flight to the target
      const st = fly0(S, r, dt);
      if (st === 2) crash(S, r);
    }
  }
  function stepLetters(S, dt) {
    const wa = S.wa, K = A.RAVEN;
    for (let i = wa.letters.length - 1; i >= 0; i--) {
      const l = wa.letters[i]; l.age += dt; S.lastBoom = S.time;
      const wp = P.to_world(S, l.s, l.y);
      if (SS.weather && SS.weather.wind_at) { const v = { x: 0, y: 0, z: 0 }; SS.weather.wind_at(S, wp.x, l.y, wp.z, v); const d = P.dir(S); l.wsx = v.x * d.x + v.z * d.z; l.wsy = v.y; } else { l.wsx = 0; l.wsy = 0; }
      const ts = l.wsx + K.FLUTTER * M.sin(l.age * 3.7 + l.ph), tv = -K.FALL * (0.7 + 0.3 * M.sin(l.age * 4.3 + l.ph * 1.3)) + 0.8 * l.wsy;
      l.vs += (ts - l.vs) * 1.8 * dt; l.vy += (tv - l.vy) * 3 * dt;
      l.s += l.vs * dt; l.y += l.vy * dt;
      const np = P.to_world(S, l.s, l.y);
      const sea = sim().surface_at(S, np.x, np.z);
      let boom = false;
      if (l.y < sea || l.y < 0.3) { sim().emit(S, 'splash', { x: np.x, y: sea, z: np.z, size: 0.3 }); wa.letters.splice(i, 1); continue; }
      if (l.age > 0.25) {
        if (P.solid2(S, l.s, l.y) || (S.planeBodies.length && P.body_at2(S, l.s, l.y, true) >= 0)) boom = true;
        else for (const o of S.worms) if (!o.dead && hyp3(o.pos, np) < C.WORM_R + 0.25) { boom = true; break; }
      }
      if (l.age > 40) boom = true;
      if (boom) {
        wa.letters.splice(i, 1);
        sim().emit(S, 'letterboom', { x: np.x, y: np.y, z: np.z });
        sim().explode(S, np, { W: K.LETTER_W, dmg: K.LETTER_DMG, name: 'an explosive letter' }, l.owner);
      }
    }
  }

  WA.mods.push({
    init(S) { S.wa.boom = []; S.wa.ravens = []; S.wa.letters = []; },
    step(S, dt) { const wa = S.wa; if (wa.boom.length) stepBoom(S, dt); if (wa.ravens.length) stepRavens(S, dt); if (wa.letters.length) stepLetters(S, dt); },
    busy(S) { const wa = S.wa; return !!(wa.boom.length || wa.ravens.length || wa.letters.length); }
  });
})(window.SS = window.SS || {});
