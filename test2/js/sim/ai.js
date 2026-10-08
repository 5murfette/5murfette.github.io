/* sim/ai.js — CPU opponent (Step 9a). Portable, deterministic (own RNG stream S.aiRng; it only reads the state and
 * produces an Input struct / calls sim.fire like a player would).
 * A CPU turn: THINK (AI_THINK s, for the eye) -> choose a target (enemies ordered by distance; up to TARGETS tried) ->
 * align the section with it (sim.align_to, wait until the rotation has arrived) -> SEARCH weapon x aim x power with a
 * lightweight copy of the 2D flight (gravity, the in-plane wind push of stepProjectiles with the weapon's windK, water
 * entry, terrain / body collisions, grenade bounces with the sim's restitution and its 3 s fuse, rocket contact with
 * worms), coarse grid then a fine grid around the best, spread over sim steps (EVAL_PER_STEP predictions per step)
 * -> score each burst point by the expected blast damage (blast.js worm_effect, capped by HP, +KILL bonus) to enemies
 * minus OWN_K x damage to the own team (the CPU itself included) -> aim noise by difficulty -> FIRE (sim.fire).
 * No positive shot: walk toward the target for WALK_T s and search again once, else end the turn.
 * Settings: S.settings.cpu = 'off' | 'easy' | 'normal' | 'hard' (team 1 is the CPU). Difficulty: search grid + noise.
 * API: is_cpu(S, team), control(S, a, dt) -> Input, stats(S). C layout: struct Ai { u8 phase; f32 t; Plan best;
 *   Cand cand[]; i32 next; Rng rng; }. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane;
  const AI = SS.ai = {};
  const W = () => SS.world;
  const K = { THINK: 0.8, TARGETS: 3, EVAL_PER_STEP: 40, OWN_K: 1.6, KILL: 25, WALK_T: 2.5, MAX_T: 7,
    // aim / power noise = the PoC's skills exactly (Rookie / Soldier / Sharpshooter, PoC aiStep: [0.1, 0.12], [0.04, 0.045],
    // [0.01, 0.012]); aim / pow = the search grid steps
    DIFF: { easy: { aim: 0.12, pow: 0.12, noiseA: 0.1, noiseP: 0.12 }, normal: { aim: 0.08, pow: 0.08, noiseA: 0.04, noiseP: 0.045 }, hard: { aim: 0.05, pow: 0.05, noiseA: 0.01, noiseP: 0.012 } } };
  AI.K = K;
  const rng = S => { if (!S.aiRng) S.aiRng = M.rng_make(((S.settings.seed | 0) * 40503 + 0xa1) >>> 0 || 1); return M.rng_next(S.aiRng); };
  const gauss = S => { const u = Math.max(1e-9, rng(S)), v = rng(S); return Math.sqrt(-2 * M.log(u)) * M.cos(6.283185 * v); };
  AI.is_cpu = (S, team) => SS.game.is_cpu(S, team);                     // P1: per-team control (sim/game.js)

  /* ---------- the flight copy ---------- */
  const wv = { x: 0, y: 0, z: 0 };
  function predict(S, weapon, aim, facing, power) {
    // P11: any charged projectile of the arsenal (impact vs bouncy, its speed, restitution, friction, fuse, wind)
    const a = S.active, def = C.WEAPONS[weapon], pd = C.PROJ[weapon] || def, w = W(), d = P.dir(S), ap = P.to_plane(S, a.pos);
    const imp = !!pd.impact, vmax = def.vmax || 28, speed = vmax * Math.max(C.WORM_DYN.MIN_POWER, power), ds = facing * M.cos(aim), dy = M.sin(aim);
    const rest = pd.rest != null ? pd.rest : 0.45, fric = pd.fric != null ? pd.fric : 0.9;
    let s = ap.s + ds * 0.7, y = a.pos.y + dy * 0.7, vs = ds * speed, vy = dy * speed, t = 0, wet = false;
    const fuse = pd.fuseSet ? S.fuse : (pd.fuse || 99), dt = 1 / 60, wk = pd.windK != null ? pd.windK : 1, k = C.WIND_GAIN * wk;
    while (t < K.MAX_T) {
      const wp0 = P.to_world(S, s, y);
      if (SS.weather && !wet && wk > 0) { SS.weather.wind_at(S, wp0.x, y, wp0.z, wv); const ws = wv.x * d.x + wv.z * d.z; vs += ws / C.WIND_UNIT * C.WIND_ACC * wk * dt; vy += (wv.y - vy) * k * dt * 0.04; }   // = stepProjectiles
      const n = Math.max(1, Math.ceil(M.len2(vs, vy) * dt / 0.12)), h = dt / n;
      for (let i = 0; i < n; i++) {
        if (wet) { const dr = M.exp(-2.6 * h); vs *= dr; vy = vy * dr - C.G * 0.55 * h; } else vy -= C.G * h;
        const ns = s + vs * h, ny = y + vy * h, wp = P.to_world(S, ns, ny);
        if ((w.dry ? SS.sim.arena_r(wp.x, wp.z) > C.DRY.FAR_R : wp.x < -120 || wp.z < -120 || wp.x > w.SX + 120 || wp.z > w.SZ + 120) || ny < 0.2) return null;   // (= sim.js OOB_SEA)
        // sea ice (as sim.js: before the water entry): a rocket bursts on it, a grenade bounces unless it punches through
        if (SS.ice && S.ice && !wet && vy < 0) {
          const it = SS.ice.top_at(S, wp.x, wp.z);
          if (it > -1e8 && ny < it && y >= it - 0.08) {
            const through = SS.ice.would_punch(S, wp.x, wp.z, def.mass || 0.6, -vy);       // (P30: the speed into the ice)
            if (!through && imp) return { x: wp.x, y: it + 0.05, z: wp.z, t, wet: false };
            if (!through) { vy = -vy > 1.5 ? -vy * 0.45 : 0; vs *= M.exp(-0.25 * h); if (Math.abs(vs) < 0.05) vs = 0; y = it + 0.001; s = ns; continue; }   // (= sim.js)
          }
        }
        if (!wet && ny < SS.sim.surface_at(S, wp.x, wp.z) && vy < 0) {
          if (imp) return { x: wp.x, y: ny, z: wp.z, t, wet: true };
          wet = true; vs *= 0.35; vy *= 0.3;
        }
        if (imp && t > 0.2) for (const o of S.worms) if (!o.dead && o !== a && M.len3(wp.x - o.pos.x, ny - o.pos.y, wp.z - o.pos.z) < C.WORM_R + 0.12) return { x: wp.x, y: ny, z: wp.z, t, wet };
        // a bouncing shell bounces off a worm's body (= sim.js wormBounce, P32)
        if (!imp && !pd.foam) {
          let hitO = null; for (const o of S.worms) { if (o.dead || o.drowning || o.swim || (o === a && t < 0.25)) continue; const q = P.to_plane(S, o.pos);   /* (= sim.js wormBounce: no swimmers) */ if (Math.abs(q.t) <= C.WORM_R && M.len2(ns - q.s, ny - o.pos.y) < C.WORM_R + (pd.r || 0.06)) { hitO = q; hitO.y = o.pos.y; break; } }
          if (hitO) {
            const rr = C.WORM_R + (pd.r || 0.06), dd = M.len2(ns - hitO.s, ny - hitO.y), ux = dd > 1e-4 ? (ns - hitO.s) / dd : 0, uy = dd > 1e-4 ? (ny - hitO.y) / dd : 1, vn = vs * ux + vy * uy;
            if (vn < 0) { vs -= 1.15 * vn * ux; vy -= 1.15 * vn * uy; vs *= 0.5; vy *= 0.5; }
            if (!P.solid2(S, hitO.s + ux * rr, hitO.y + uy * rr)) { s = hitO.s + ux * rr; y = hitO.y + uy * rr; }
            continue;
          }
        }
        const bi = S.planeBodies.length ? P.body_at2(S, ns, ny, true) : -1;
        const solid = P.solid2(S, ns, ny) || (bi >= 0 && !S.planeBodies[bi].ice);          // ice is handled above
        if (solid) {
          if (imp) return { x: wp.x, y: ny, z: wp.z, t, wet };
          const nn = P.normal2(S, ns, ny), vn = vs * nn.s + vy * nn.y;
          if (vn < 0) { vs -= (1 + rest) * vn * nn.s; vy -= (1 + rest) * vn * nn.y; vs *= fric; vy *= fric; if (M.len2(vs, vy) < 0.8) { vs = 0; vy = 0; } }
        } else { s = ns; y = ny; }
      }
      t += dt;
      if (t >= fuse) { const p = P.to_world(S, s, y); return { x: p.x, y, z: p.z, t, wet }; }
    }
    return null;
  }
  // value of a burst at c: blast damage (capped by HP) to enemies, + KILL per kill, - OWN_K x damage to the own team
  function score(S, c, W, split, dmg) {                              // dmg: the PoC damage of that blast (P24.1)
    const me = S.active.team; let v = 0;
    if (split) W += split.n * (C.PROJ[split.kind].W) * 0.35;           // bomblets scatter: a fraction of their charge counts
    // the bomblets can land anywhere within ~SCAT m (their throw at 0.65 v + jitter): own worms in that ring are at risk
    if (split) { const SCAT = split.jx * 1.1; for (const o of S.worms) if (!o.dead && o.team === me && M.len2(o.pos.x - c.x, o.pos.z - c.z) < SCAT) v -= (o === S.active ? 2.2 : K.OWN_K) * 30; }
    for (const o of S.worms) {
      if (o.dead) continue;
      const e = SS.blast.worm_effect(c, W, o.pos, dmg), dm = Math.min(o.hp, Math.round(e.dmg));
      // PoC evalBoom: own team x 1.5 (here OWN_K), the shooter itself x 2.2, + 60 per own worm killed
      if (o.team === me) v -= (o === S.active ? 2.2 : K.OWN_K) * dm + (dm >= o.hp ? 60 : 0);
      else v += dm + (dm >= o.hp ? K.KILL : 0);
    }
    return v;
  }

  /* ---------- the turn ---------- */
  function newPlan(S, a) {
    const diff = K.DIFF[SS.game.skill(S)];
    const foes = S.worms.filter(o => !o.dead && o.hp > 0 && !o.swim && !o.drowning && o.team !== a.team)   // (a worm in the water is lost or crawling out: not worth a shot)
     .sort((p, q) => M.v3_dist(p.pos, a.pos) - M.v3_dist(q.pos, a.pos)).slice(0, K.TARGETS);
    // P11 (PoC aiPlanGen): bazooka + grenade always; cluster 70 %, banana 50 %, holy 50 % of the turns when in stock
    const has = k => SS.game.ammo(S, a.team, k) > 0, wpns = ['bazooka', 'grenade'];
    if (has('cluster') && rng(S) < 0.7) wpns.push('cluster');
    if (has('banana') && rng(S) < 0.5) wpns.push('banana');
    if (has('holy') && rng(S) < 0.5) wpns.push('holy');
    return { phase: 'think', t: S.time + K.THINK, diff, foes, fi: 0, cand: null, next: 0, best: null, top: [], walked: false, turn: S.turnNo, wpns };
  }
  function grid(S, pl, center) {
    const a = S.active, tgt = pl.foes[pl.fi], ap = P.to_plane(S, a.pos), tp = P.to_plane(S, tgt.pos);
    const facing = tp.s >= ap.s ? 1 : -1, list = [];
    if (!center) {
      for (const wpn of pl.wpns) for (let aim = -0.5; aim <= 1.45; aim += pl.diff.aim * 1.5) for (let pw = 0.15; pw <= 1.0001; pw += pl.diff.pow * 1.5) list.push({ wpn, aim, facing, pw });
    } else {
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) list.push({ wpn: center.wpn, aim: center.aim + i * pl.diff.aim * 0.5, facing: center.facing, pw: M.clamp(center.pw + j * pl.diff.pow * 0.5, 0.05, 1) });
    }
    return list;
  }
  AI.control = function (S, a, dt) {
    const inp = {};
    let pl = S.aiPlan;
    if (!pl || pl.turn !== S.turnNo || pl.worm !== a.id) { pl = S.aiPlan = newPlan(S, a); pl.worm = a.id; }
    switch (pl.phase) {
      case 'think':
        if (S.time >= pl.t) {
          if (!pl.foes.length) { inp.end_turn = true; pl.phase = 'done'; break; }
          SS.sim.align_to(S, pl.foes[pl.fi]); pl.phase = 'align';
        }
        break;
      case 'align':
        if (S.thetaGoal == null) { pl.cand = grid(S, pl, null); pl.next = 0; pl.phase = 'search'; pl.fine = false; }
        break;
      case 'search': {
        const W3 = c => (C.PROJ[c.wpn] || C.WEAPONS[c.wpn]).W;
        for (let n = 0; n < K.EVAL_PER_STEP && pl.next < pl.cand.length; n++, pl.next++) {
          const c = pl.cand[pl.next], hit = predict(S, c.wpn, c.aim, c.facing, c.pw);
          if (!hit) continue;
          const v = score(S, hit, W3(c), (C.PROJ[c.wpn] || {}).split, (C.PROJ[c.wpn] || {}).dmg) * ((C.PROJ[c.wpn] || {}).split ? 1.0 : 1);
          if (!pl.best || v > pl.best.v) pl.best = Object.assign({ v, hit, fi: pl.fi }, c);
          if (v > 0) { pl.top.push(Object.assign({ v, hit, fi: pl.fi }, c)); pl.top.sort((p, q) => q.v - p.v); if (pl.top.length > 8) pl.top.length = 8; }
        }
        if (pl.next < pl.cand.length) break;
        if (!pl.fine && pl.best && pl.best.fi === pl.fi) { pl.cand = grid(S, pl, pl.best); pl.next = 0; pl.fine = true; break; }
        // next target, or shoot / walk
        if (pl.fi + 1 < pl.foes.length && (!pl.best || pl.best.v < 30)) { pl.fi++; SS.sim.align_to(S, pl.foes[pl.fi]); pl.phase = 'align'; break; }
        specials(S, pl, a);
        if (pl.best && pl.best.v > 0) {
          if (pl.best.fi !== pl.fi) { pl.fi = pl.best.fi; SS.sim.align_to(S, pl.foes[pl.fi]); pl.phase = 'realign'; break; }
          pl.phase = pl.best.special ? 'fire' : 'robust'; pl.rk = 0;
        } else if (!pl.walked) { pl.walked = true; pl.phase = 'walk'; pl.t = S.time + K.WALK_T; }
        else { inp.end_turn = true; pl.phase = 'done'; }
        break;
      }
      case 'realign':
        if (S.thetaGoal == null) { pl.phase = pl.best.special ? 'fire' : 'robust'; pl.rk = 0; }
        break;
      /* robustness (a CPU's aim and power have the difficulty's noise): the best plans of this plane are re-scored with
       * the aim / power pushed by 1.5 sigma each way; a plan that skims a ledge at the worm's feet or kills its own
       * team when slightly off loses to a safer one. Value = 0.5 x plan + 0.5 x worst perturbed outcome. */
      case 'robust': {
        const list = pl.top.filter(e => e.fi === pl.fi && !e.special), d = pl.diff, W3 = c => (C.PROJ[c.wpn] || C.WEAPONS[c.wpn]).W;
        for (let n = 0; n < 2 && pl.rk < list.length; n++, pl.rk++) {
          const c = list[pl.rk]; let worst = Infinity;
          for (const [da, dp] of [[1.5, 0], [-1.5, 0], [0, 1.5], [0, -1.5]]) {
            const h = predict(S, c.wpn, c.aim + da * d.noiseA, c.facing, M.clamp(c.pw + dp * d.noiseP, 0.05, 1));
            worst = Math.min(worst, h ? score(S, h, W3(c), (C.PROJ[c.wpn] || {}).split, (C.PROJ[c.wpn] || {}).dmg) : 0);
          }
          c.rv = 0.5 * c.v + 0.5 * worst;
        }
        if (pl.rk < list.length) break;
        let pick = null; for (const c of list) if (c.rv != null && (!pick || c.rv > pick.rv)) pick = c;
        if (pick && pick.rv > 0) { pl.best = pick; pl.phase = 'fire'; }
        else if (!pl.walked) { pl.walked = true; pl.best = null; pl.top = []; pl.phase = 'walk'; pl.t = S.time + K.WALK_T; }
        else { inp.end_turn = true; pl.phase = 'done'; }
        break;
      }
      case 'walk': {
        const tgt = pl.foes[pl.fi], ap = P.to_plane(S, a.pos), tp = P.to_plane(S, tgt.pos), dir = tp.s >= ap.s ? 1 : -1;
        // never walk into water (it costs the turn and 10 HP/s) or lava: stop at the shore (a deck or sea ice ahead is fine)
        const ah = P.to_world(S, ap.s + dir * 0.7, a.pos.y), surf = SS.sim.surface_at(S, ah.x, ah.z);
        const deck = SS.struct && SS.struct.floor_at ? SS.struct.floor_at(S, ah.x, a.pos.y, ah.z) : -1e9, ice = SS.ice && S.ice ? SS.ice.top_at(S, ah.x, ah.z) : -1e9;
        const wet = (SS.water && S.water && SS.water.depth(S, ah.x, ah.z) > 0.3 && deck < surf && ice < -1e8) || (SS.lava && S.lava && SS.lava.depth_at(S, ah.x, ah.z) > 0.02);
        if (!wet) inp.move = dir;
        if (wet || S.time >= pl.t) { pl.best = null; pl.top = []; pl.fi = 0; SS.sim.align_to(S, pl.foes[0]); pl.phase = 'align'; }
        break;
      }
      case 'fire': {
        const b = pl.best, d = pl.diff;
        if (b.special) { fireSpecial(S, pl, a, b); break; }
        S.weapon = b.wpn; a.facing = b.facing;
        // the skill noise must not point the muzzle into an adjacent wall (the shot spawns 0.7 m out and goes off in the
        // CPU's face: an easy CPU blew itself into the sea that way): keep the planned, predicted aim then
        const aimN = M.clamp(b.aim + gauss(S) * d.noiseA, -1.5, 1.5);
        S.aim = muzzleClear(S, P.to_plane(S, a.pos).s, a.pos.y, a.facing, aimN) ? aimN : b.aim;
        const pw = M.clamp(b.pw + gauss(S) * d.noiseP, 0.05, 1);
        pl.phase = 'done'; pl.fired = { wpn: b.wpn, aim: S.aim, pw, v: b.v, target: pl.foes[b.fi].id };
        SS.sim.fire(S, pw);
        break;
      }
    }
    return inp;
  };
  /* P11 (PoC): close-range and targeted alternatives to the ballistic search. Each candidate gets an expected value
   * comparable to score(); the best one replaces the ballistic plan when it is clearly better. */
  function specials(S, pl, a) {
    const has = k => SS.weapons.can_use(S, k), ap = P.to_plane(S, a.pos), tgt = pl.foes[pl.fi];
    if (!tgt) return;
    const tp = P.to_plane(S, tgt.pos), dist = M.len2(tp.s - ap.s, tgt.pos.y - a.pos.y), facing = tp.s >= ap.s ? 1 : -1;
    const aim = M.atan2(tgt.pos.y - a.pos.y, Math.abs(tp.s - ap.s)), clear = clearLine(S, ap.s, a.pos.y, tp.s, tgt.pos.y), own = tgt.team === a.team;
    const cands = [];
    if (!own && dist < 1.3 && has('bat')) cands.push({ special: 'bat', v: Math.min(tgt.hp, 30) + 20, aim: Math.max(0.2, aim), facing });
    if (!own && dist < 15 && clear && has('shotgun')) cands.push({ special: 'shotgun', v: Math.min(tgt.hp, 50) * 0.9, aim, facing });
    for (const k of ['airstrike', 'tesla', 'moai']) if (has(k)) {
      const W = k === 'airstrike' ? (C.PROJ.missile.W) * 2.2 : k === 'moai' ? C.ARMS.MOAI.W * 1.6 : C.ARMS.TESLA.W;
      let v = score(S, { x: tgt.pos.x, y: tgt.pos.y - 0.3, z: tgt.pos.z }, W, null, k === 'airstrike' ? 30 * 2.2 : k === 'moai' ? 28 * 1.6 : 10) * 0.85;
      if (k === 'tesla') v += zapValue(S, tgt.pos) * 0.85;                // the two shocks (no flat bonus)
      cands.push({ special: k, v, ts: tp.s, ty: tgt.pos.y, facing });
    }
    if (has('homing') && (!pl.best || pl.best.v < 25)) {
      // launch angle: the line to the target + 0.15, raised until the first 2 m are clear (a slope in front: the missile
      // went off in the CPU's face and blew it into the sea); no clear launch = no homing
      let ha = Math.max(0.15, aim + 0.15);
      while (ha < 1.45 && !muzzleClear(S, ap.s, a.pos.y, facing, ha)) ha += 0.12;
      if (ha < 1.45) cands.push({ special: 'homing', v: score(S, tgt.pos, C.PROJ.homing.W, null, C.PROJ.homing.dmg) * 0.75, aim: ha, facing, ts: tp.s, ty: tgt.pos.y, pw: 0.7 });
    }
    let best = null; for (const c of cands) if (c.v > 35 && (!best || c.v > best.v)) best = c;
    if (best && (!pl.best || best.v > pl.best.v * 1.25)) pl.best = Object.assign({ fi: pl.fi, wpn: best.special }, best);
  }
  // expected electric damage of a thunder strike at c (both pulses), enemies + / own team - OWN_K
  function zapValue(S, c) {
    const T = C.ARMS.TESLA, me = S.active.team; let v = 0;
    for (const o of S.worms) {
      if (o.dead || o.hp <= 0) continue;
      const d = M.len3(o.pos.x - c.x, o.pos.y - c.y, o.pos.z - c.z), dm = Math.min(o.hp, (d < T.R1 ? T.D1 : 0) + (d < T.R2 ? T.D2 : 0));
      v += o.team === me ? -K.OWN_K * dm : dm;
    }
    return v;
  }
  const MUZZLE = [0.7, 1.0, 1.4, 2.0];                // m along the aim that must be free when the CPU fires
  function muzzleClear(S, s, y, facing, aim) {
    for (let q = 0; q < MUZZLE.length; q++) { const r = MUZZLE[q]; if (P.blocked2(S, s + facing * M.cos(aim) * r, y + M.sin(aim) * r)) return false; }
    return true;
  }
  function clearLine(S, s0, y0, s1, y1) { const L = M.len2(s1 - s0, y1 - y0), n = Math.ceil(L / 0.2); for (let i = 2; i < n - 1; i++) { const f = i / n; if (P.solid2(S, s0 + (s1 - s0) * f, y0 + (y1 - y0) * f)) return false; } return true; }
  function fireSpecial(S, pl, a, b) {
    const WP = SS.weapons, d = pl.diff;
    S.weapon = b.special; a.facing = b.facing;
    pl.phase = 'done'; pl.fired = { wpn: b.special, v: b.v, target: pl.foes[b.fi].id };
    if (b.special === 'shotgun' || b.special === 'bat') {
      S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.5, -1.5, 1.5);
      WP.use(S, 0); if (b.special === 'shotgun' && S.phase === 'play') { S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.5, -1.5, 1.5); WP.use(S, 0); }
      return;
    }
    S.tgt = { s: b.ts, y: b.ty };                                    // targeted strikes are not perturbed (PoC)
    if (b.special === 'homing') { S.aim = b.aim; SS.sim.fire(S, b.pw); return; }
    if (b.special === 'airstrike') S.strikeDir = b.facing;
    WP.use(S, 0);
  }
  AI.stats = S => (S.aiPlan ? { phase: S.aiPlan.phase, best: S.aiPlan.best && { v: S.aiPlan.best.v, wpn: S.aiPlan.best.wpn }, fired: S.aiPlan.fired || null } : null);
  AI.predict = predict;                                  // tests
})(window.SS = window.SS || {});
