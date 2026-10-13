/* render/react.js — P38 S1 / P39: how a worm REACTS (presentation only; Math.random is fine). The worm's BODY reaction (dents, wobble, tumble,
 * crumple, lying along a slope) is the soft-body solver's since P39 (core/softworm.js, render/softview.js): this module keeps what is not
 * physics:
 *   - FACE: pain (eyes screwed shut, mouth open by the damage, a scream for a big hit), fear (a lit fuse / a live mine close by: wide eyes,
 *     shiver, sweat), daze (stars, head wobble after a big hit), yawn (idle), cheer (victory), a gasp (turn start);
 *   - MUSCLES: low HP = heavy breathing and sweat; every ~12 s a stretch + yawn; a perk-up at turn start; the victory hop (these only change the
 *     goal pose the soft body holds: sx, sy, oy);
 *   - WATER: a worm below the surface is drawn AFTER the water face with a depth tint (see actors.js wet mode), struggles (hands up) and breathes
 *     out a stream of bubbles; the last breath is a burst;
 *   - DEATH: the burning worm's end leaves a soot cloud with embers; the drowned one a burst of bubbles; landing dust.
 * API: init(), clear(), onEvent(S, e), frame(S, view, camera, dt); pose(S, w, v, dt, c) -> the per-worm result struct (reused, read at once):
 *   c = { air, vloc (m/s along the facing, signed), vy, speed, f (facing sign), burn, active, crawl, aiming }
 *   result = { sx, sy (goal scale), ox, oy (goal offset, m), pain 0..1, scream, fear 0..1, cheer 0..1, yawn 0..1, daze (bool), wob (rad: head wobble),
 *              flail (bool: hands up), wet 0..1, perk }
 * Porting: per-worm timers keyed by the worm id (an array of small structs); calls into the particle system only. No simulation state. */
(function (SS) {
  'use strict';
  const RX = SS.reactView = {};
  const C_ = SS.CFG, M = Math, TAU = 6.2831853;
  const rnd = (a, b) => a + M.random() * (b - a), clamp = (a, lo, hi) => (a < lo ? lo : a > hi ? hi : a);
  let clock = 0;
  const st = [];                               // per worm id: the reaction state
  const OUT = { sx: 1, sy: 1, ox: 0, oy: 0, pain: 0, scream: false, fear: 0, cheer: 0, yawn: 0, daze: false, wob: 0, flail: false, wet: 0, perk: 0,
    lean: 0, lookW: 0, look: 0, sad: 0, happy: 0, relief: 0, watch: 0, wx: 0, wy: 0, arms: 0, panic: 0, thrash: 0, struggle: 0 };
  const K = { FEAR_R: 4.6, FEAR_FUSE: 2.6, YAWN_T: 12, YAWN_D: 1.3, WATCH_R: 11, NEAR_R: 7.5, SAD_T: 2.6, CHEER_T: 1.5, PHEW_DELAY: 0.55, PHEW_T: 1.3 };
  const ROCKETS = { bazooka: 1, homing: 1, mortar: 1, airstrike: 1 };
  const smoothstep = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

  function get(w) {
    let s = st[w.id];
    if (!s) s = st[w.id] = { painT: 0, painK: 0, dazeT: 0, fear: 0, fearT: 0, sweatT: 0, perkT: -9, lastActive: false, drownBub: 0, lastHurt: -9, src: 0, bubT: 0, hp: w.hp,
      hitT: -9, hitK: 0, fireT: -9, fireK: 0, fireKind: 0, sadT: -9, cheerT: -9, duckT: -9, phewT: -9, watchK: 0, wlook: 0, chargeK: 0 };
    return s;
  }
  RX.init = function () {};
  RX.clear = function () { st.length = 0; clock = 0; };
  /* seconds the worm's face still shows a hit (pain, or the daze after a big one): read-only, for the antic camera (render/anticcam.js) */
  RX.faceLeft = w => { const s = st[w.id]; return s ? M.max(s.painT, s.dazeT > 0.25 ? s.dazeT : 0) : 0; };

  RX.onEvent = function (S, e) {
    const F = SS.fx;
    if (e.type === 'hurt' && e.worm && !e.worm.dead) {
      const w = e.worm, s = get(w);
      s.lastHurt = clock; s.src = e.src | 0;
      if (e.dot) {                                                   // fire, acid, gas, lava, drowning: a wince, no dent
        if (C_.DS_CAUSE[e.src | 0] !== C_.CAUSE.DROWN) { s.painT = M.max(s.painT, 0.35); s.painK = M.max(s.painK, 0.25); }
        return;
      }
      s.hitT = clock; s.hitK = clamp(e.amount / 26, 0.35, 1);
      const k = clamp(e.amount / 42, 0.14, 0.9);
      s.painT = 0.55 + 1.1 * k; s.painK = k;
      if (e.amount >= 26) s.dazeT = M.max(s.dazeT, 1.2 + 2.2 * k);
      if (F && F.addShake && e.amount >= 12) F.addShake(0.06 + 0.16 * k);
    } else if (e.type === 'land' && e.worm && !e.worm.dead) {
      const s = get(e.worm), sp = e.speed || 0;
      if (sp > 9 && F) F.dustAt(e.x, e.y + 0.05, e.z, 6 + M.round(sp), 0.35 + 0.02 * sp);
    } else if (e.type === 'zap' && e.worm) { const s = get(e.worm); s.painT = 1.2; s.painK = 0.8; s.dazeT = 3; }
    else if (e.type === 'kill' && e.worm) { deathFx(S, e); mourn(S, e.worm); }
    else if (e.type === 'fire' && S.active) { const s = get(S.active); s.fireT = clock; s.fireKind = ROCKETS[e.weapon] ? 1 : 2; s.fireK = ROCKETS[e.weapon] ? 1 : M.min(1, 0.45 + (e.speed || 10) / 40); }
    else if (e.type === 'shot' && S.active && (e.weapon === 'shotgun' || e.weapon === 'sniper' || e.weapon === 'handgun') && !e.end) { const s = get(S.active); s.fireT = clock; s.fireKind = 1; s.fireK = e.weapon === 'shotgun' ? 1 : e.weapon === 'sniper' ? 1.1 : 0.45; }
    else if (e.type === 'swing' && e.worm) { const s = get(e.worm); s.fireT = clock; s.fireKind = 3; s.fireK = 1; }
    else if (e.type === 'explode') nearMiss(S, e);
    else if (e.type === 'drown' && e.worm) { const s = get(e.worm); s.drownBub = clock; }
  };

  /* the end of a non-gib death by cause: a burned worm leaves a soot cloud with embers, a drowned one a burst of bubbles */
  function deathFx(S, e) {
    const F = SS.fx, w = e.worm; if (!F) return;
    const c = e.cause | 0, X = w.pos.x, Y = w.pos.y, Z = w.pos.z;
    if (e.how === 'drown' || c === C_.CAUSE.DROWN) { for (let i = 0; i < 14; i++) F.bubble(X + rnd(-0.3, 0.3), Y + rnd(0, 0.6), Z + rnd(-0.2, 0.2)); return; }
    const K2 = F.KIND, soot = (n, big, tone) => { for (let i = 0; i < n; i++) F.spawn(K2.SMOKE, X + rnd(-0.25, 0.25), Y + rnd(-0.1, 0.5) + i * 0.05, Z + rnd(-0.2, 0.2), { vx: rnd(-0.4, 0.4), vy: rnd(1.3, 2.8), vz: rnd(-0.2, 0.2), drag: 0.6, life: rnd(2.2, 3.8), s0: 0.25 * big, s1: rnd(0.9, 1.5) * big, c0: [0.05 + tone * 0.1, 0.048 + tone * 0.1, 0.045 + tone * 0.1], c1: [0.3, 0.29, 0.28], a0: 0.8, buoy: 0.9 }); };
    // burn (4), lava (5): a charred collapse: a flash of flame, a tall black column, a shower of embers, a blackened patch of ground
    if (c === C_.CAUSE.BURN || c === C_.CAUSE.LAVA) {
      F.spawn(K2.FIRE, X, Y + 0.3, Z, { life: 0.35, s0: 0.3, s1: 1.1, c0: [2600, 1100, 0], a0: 0.9, buoy: 1.5 });
      soot(14, 1.1, 0);
      for (let i = 0; i < 16; i++) F.spawn(K2.SPARK, X + rnd(-0.2, 0.2), Y + 0.2, Z, { vx: rnd(-1.6, 1.6), vy: rnd(2, 6), vz: rnd(-1, 1), life: rnd(0.7, 1.6), s0: 0.06, s1: 0.015, c0: [2300, 900, 0], grav: 5, buoy: 1.2 });
      if (c === C_.CAUSE.LAVA) F.steam && F.steam(X, Y, Z, 0.6);
      if (SS.view && SS.view.scorch) SS.view.scorch(X, Z, 0.9, 0.9);
      return;
    }
    // shock (8): a white-blue flash, forking arcs thrown from the worm, a thin wisp of smoke and a scorch mark
    if (c === C_.CAUSE.SHOCK) {
      F.spawn(K2.FIRE, X, Y + 0.3, Z, { life: 0.2, s0: 0.3, s1: 0.9, c0: [4600, 3000, 0], a0: 0.8 });
      for (let i = 0; i < 26; i++) { const a = rnd(0, 6.283), sp = rnd(3, 9); F.spawn(K2.SPARK, X, Y + 0.3, Z, { vx: Math.cos(a) * sp, vy: rnd(-1, 5), vz: Math.sin(a) * sp * 0.4, life: rnd(0.15, 0.5), s0: 0.07, s1: 0.015, c0: [7500, 4200, 0], grav: 6 }); }
      soot(5, 0.7, 0.3);
      if (SS.view && SS.view.scorch) SS.view.scorch(X, Z, 0.8, 0.85);
      if (F.addShake) F.addShake(0.2);
      return;
    }
    // poison (6), acid (11): a green cough / a hissing fizz of vapour and drops, and a slow slump
    if (c === C_.CAUSE.POISON || c === C_.CAUSE.ACID) {
      for (let i = 0; i < 11; i++) F.spawn(K2.SMOKE, X + rnd(-0.25, 0.25), Y + rnd(0, 0.5), Z + rnd(-0.2, 0.2), { vx: rnd(-0.35, 0.35), vy: rnd(0.4, 1.2), vz: rnd(-0.15, 0.15), life: rnd(1.6, 2.8), s0: 0.2, s1: rnd(0.8, 1.3), c0: [0.2, 0.5, 0.1], c1: [0.4, 0.62, 0.25], a0: 0.62, buoy: 0.4, drag: 0.8 });
      if (c === C_.CAUSE.ACID) {
        for (let i = 0; i < 7; i++) F.spawn(K2.STEAM, X + rnd(-0.3, 0.3), Y + rnd(0, 0.3), Z, { vx: rnd(-0.3, 0.3), vy: rnd(1.0, 2.2), vz: rnd(-0.1, 0.1), life: rnd(0.9, 1.6), s0: 0.15, s1: 0.7, a0: 0.5, c0: [0.85, 0.95, 0.8], drag: 0.8 });
        for (let i = 0; i < 12; i++) F.spawn(K2.SPARK, X, Y + 0.2, Z, { vx: rnd(-1.4, 1.4), vy: rnd(1.5, 4), vz: rnd(-0.5, 0.5), life: rnd(0.3, 0.7), s0: 0.05, s1: 0.015, c0: [3600, 3000, 1800], grav: 9 });
      }
      return;
    }
    // fall (9): a ring of dust where it lands and a few clods
    if (c === C_.CAUSE.FALL) {
      F.dustAt(X, Y + 0.05, Z, 12, 0.6);
      for (let i = 0; i < 6; i++) { const a = rnd(0, 6.283), sp = rnd(1.5, 3.5); F.spawn(K2.CHUNK, X, Y + 0.1, Z, { vx: Math.cos(a) * sp, vy: rnd(2, 4), vz: Math.sin(a) * sp * 0.4, grav: 17, life: rnd(1, 1.6), s0: 0.08, s1: 0.08, c0: [0.3, 0.2, 0.12], a0: 1 }); }
    }
  }

  /* a worm died: its team mates are sad for a while (head down, slow breath); the active worm, when it was the enemy, cheers */
  function mourn(S, victim) {
    for (const w of S.worms) {
      if (w === victim || w.dead || w.eaten) continue;
      const s = get(w);
      if (w.team === victim.team) s.sadT = clock + 0.6;
      else if (w === S.active && S.phase !== 'over') s.cheerT = clock + 0.5;
    }
  }
  /* an explosion that did not touch a worm close to it: it ducks at once, then lets out a breath ("phew") */
  function nearMiss(S, e) {
    const hit = e.pushes || [];
    for (const w of S.worms) {
      if (w.dead || w.eaten) continue;
      const d = M.hypot(w.pos.x - e.x, w.pos.y - e.y, w.pos.z - e.z);
      if (d > K.NEAR_R || d < 0.01) continue;
      let pushed = false;
      for (const q of hit) if (q.worm === w) pushed = true;
      if (pushed) continue;
      const s = get(w); s.duckT = clock; s.phewT = clock + K.PHEW_DELAY;
    }
  }

  /* fear: the nearest live fuse / armed mine within reach (0..1) */
  function fearOf(S, w) {
    let best = 0; const P = SS.plane, C = SS.CFG;
    for (const p of S.proj) {
      const def = C.PROJ[p.type]; if (!def || !def.bouncy || !(p.fuse > 0) || p.fuse > K.FEAR_FUSE) continue;
      const q = P.to_world(S, p.s, p.y), d = M.hypot(q.x - w.pos.x, q.y - w.pos.y, q.z - w.pos.z);
      if (d < K.FEAR_R) best = M.max(best, (1 - d / K.FEAR_R) * clamp((K.FEAR_FUSE - p.fuse) / 1.2 + 0.35, 0, 1));
    }
    return best;
  }

  RX.frame = function (S, view, camera, dt) { clock += dt; };

  /* the reaction pose of worm w this frame (see the header); v = its render struct (actors.js), c = the context */
  RX.pose = function (S, w, v, dt, c) {
    const s = get(w), F = SS.fx, o = OUT, t = clock;
    o.sx = o.sy = 1; o.ox = o.oy = 0; o.pain = 0; o.scream = false; o.fear = 0; o.cheer = 0; o.yawn = 0; o.daze = false; o.wob = 0; o.flail = false; o.wet = 0; o.perk = 0;
    o.lean = 0; o.lookW = 0; o.look = 0; o.sad = 0; o.happy = 0; o.relief = 0; o.watch = 0; o.arms = 0; o.panic = 0; o.thrash = 0; o.struggle = 0;
    if (w.drowning) o.flail = true;
    // --- face: pain, daze
    s.painT = M.max(0, s.painT - dt);
    if (s.painT > 0) { o.pain = M.min(1, s.painT / 0.4) * (0.35 + 0.65 * s.painK); o.scream = s.painK > 0.45 && s.painT > 0.3; }
    s.dazeT = M.max(0, s.dazeT - dt);
    if (s.dazeT > 0 && !c.air) { o.daze = true; o.wob = 0.3 * M.sin(t * 8.2) * M.min(1, s.dazeT); }
    // --- fear of a lit fuse / mine
    const fr = c.burn || w.dead ? 0 : fearOf(S, w); s.fear += (fr - s.fear) * M.min(1, dt * 6); o.fear = s.fear;
    if (s.fear > 0.25) {
      o.ox += 0.018 * M.sin(t * 43 + w.id) * s.fear;
      s.sweatT -= dt; if (s.sweatT <= 0 && F && c.inSec) { s.sweatT = rnd(0.35, 0.7) / s.fear; F.splash(w.pos.x + rnd(-0.1, 0.1), w.pos.y + 0.45, w.pos.z, 0.08); }
    }
    // --- turn start: a perk-up (a small stretch and a gasp)
    const isA = w === S.active && S.phase === 'play' && !w.dead;
    if (isA && !s.lastActive && t > 0.5) s.perkT = t;
    s.lastActive = isA;
    { const q = t - s.perkT; if (q >= 0 && q < 0.55 && !c.air) { const k = M.sin(q / 0.55 * M.PI); o.sy += 0.09 * k; o.sx -= 0.04 * k; o.oy += 0.0; o.perk = k; } }
    // --- victory: a dance (hops with a squash before each landing and a stretch in the air, a swaying lean, both arms up)
    const won = S.phase === 'over' && S.over >= 0 && w.team === S.over && !w.dead && !c.air;
    if (won) {
      const q = t * 5.2 + (w.id || 0) * 1.3, hop = M.abs(M.sin(q)), sqz = M.pow(1 - hop, 5);
      o.oy += 0.3 * hop; o.sy += 0.1 * hop - 0.13 * sqz; o.sx += 0.08 * sqz - 0.04 * hop; o.lean += 0.2 * M.sin(q * 0.5); o.cheer = 1; o.arms = 1; o.happy = 1; o.wob += 0.25 * M.sin(q);
    }
    const airQ = c.air || w.dead;
    // --- the shot: recoil (rockets, guns: the body is thrown back, a squash, a springy return), the throw (a wind-up that leans back with the power,
    // then a forward whip on release), the bat (a lunge into the swing)
    { const q = t - s.fireT;
      if (q >= 0 && q < 0.7 && !airQ) {
        const k = s.fireK, e1 = M.exp(-q / 0.11), e2 = M.exp(-q / 0.2), re = q > 0.12 ? M.sin((q - 0.12) / 0.4 * M.PI * 1.5) * M.exp(-(q - 0.12) / 0.2) : 0;
        if (s.fireKind === 1) { o.lean -= 0.42 * k * e1 - 0.06 * k * re; o.ox -= 0.07 * k * e1; o.sy -= 0.06 * k * e1; o.sx += 0.04 * k * e1; o.wob -= 0.35 * k * e2; }
        else if (s.fireKind === 2) { o.lean += 0.5 * k * smoothstep(q / 0.05) * e2 - 0.05 * re; o.ox += 0.1 * k * e1; o.sx += 0.07 * k * e1; o.sy -= 0.03 * k * e2; }
        else if (s.fireKind === 3) { o.lean += 0.5 * smoothstep(q / 0.06) * M.exp(-q / 0.24); o.ox += 0.12 * M.exp(-q / 0.15); o.sx += 0.06 * M.exp(-q / 0.15); o.sy -= 0.05 * M.exp(-q / 0.3); }
      }
      const wk = S.charging && w === S.active && S.phase === 'play' && !ROCKETS[S.weapon] && !c.air ? clamp(S.power || 0, 0, 1) : 0;
      s.chargeK += (wk - s.chargeK) * M.min(1, dt * 12);
      if (s.chargeK > 0.01) { o.lean -= 0.4 * s.chargeK; o.sy -= 0.04 * s.chargeK; o.ox -= 0.05 * s.chargeK; }
    }
    // --- a blast close by that missed it: a duck, then a sigh of relief ("phew")
    if (!airQ && !c.burn) {
      const qd = t - s.duckT, qp = t - s.phewT, hurtRecent = t - s.lastHurt < 1.2;
      if (qd >= 0 && qd < 0.6 && !hurtRecent) { const k = M.exp(-qd / 0.13); o.sy -= 0.1 * k; o.sx += 0.05 * k; o.fear = M.max(o.fear, 0.7 * k); }
      if (qp >= 0 && qp < K.PHEW_T && !hurtRecent) {
        const u = qp / K.PHEW_T, inh = M.sin(M.PI * M.min(1, u / 0.4)) * (u < 0.4 ? 1 : 0), exh = u >= 0.4 ? M.sin(M.PI * (u - 0.4) / 0.6) : 0;
        o.sy += 0.07 * inh - 0.06 * exh; o.sx -= 0.03 * inh; o.relief = u < 0.85 ? 1 : 0; o.lookW = M.max(o.lookW, 0.6 * exh); o.look = -0.5;
        if (u > 0.4 && u < 0.5 && F && c.inSec && s.sweatT < 0) { s.sweatT = 0.3; F.splash(w.pos.x + 0.1, w.pos.y + 0.5, w.pos.z, 0.07); }
      }
    }
    // --- sad: a team mate died: the head sinks, the body sags and breathes slowly, the eyes look down
    { const q = t - s.sadT;
      if (q >= 0 && q < K.SAD_T && !airQ && !c.burn && !o.pain && !won && !c.aiming) {
        const k = smoothstep(q / 0.5) * (1 - smoothstep((q - (K.SAD_T - 0.7)) / 0.7));
        o.sad = k; o.lookW = M.max(o.lookW, 0.9 * k); o.look = -0.8 + 0.05 * M.sin(t * 2.5); o.sy -= 0.07 * k - 0.012 * k * M.sin(t * 3.1); o.lean -= 0.12 * k; o.ox -= 0.03 * k;
      }
    }
    // --- celebration after a kill: two hops with a fist pump
    { const q = t - s.cheerT;
      if (q >= 0 && q < K.CHEER_T && !airQ && !c.burn && !o.pain && !won) {
        const u = q / K.CHEER_T, ph = u * 2 * M.PI * 2 - M.PI * 0.5, hop = M.max(0, M.sin(ph)), sqz = u < 0.9 ? M.pow(M.max(0, -M.sin(ph)), 3) : 0, fade = 1 - smoothstep((u - 0.8) / 0.2);
        o.oy += 0.26 * hop * fade; o.sy += (0.09 * hop - 0.1 * sqz) * fade; o.sx += (0.06 * sqz - 0.03 * hop) * fade; o.lean += 0.18 * M.sin(u * 8) * fade; o.happy = fade; o.arms = fade; o.cheer = M.max(o.cheer, 0.6);
      }
    }
    // --- dizzy: it staggers (a slow sway of the whole body, the head rolls: see o.wob)
    if ((o.daze || w.dizzyUntil > S.time) && !c.air && !c.burn) {
      const k = o.daze ? M.min(1, s.dazeT) : 1, ph = t * 2.4 + (w.id || 0);
      o.lean += 0.2 * M.sin(ph) * k; o.ox += 0.07 * M.sin(ph - 0.8) * k; o.sy -= 0.02 + 0.02 * M.sin(ph * 2) * k; o.wob += 0.2 * M.sin(ph * 1.7) * k;
    }
    // --- on fire: a panic (a frantic jig: stamping hops, a whipping lean and head)
    if (c.burn && !c.air && !w.dead) {
      const q = t * 8.5 + (w.id || 0) * 2.1, hop = M.abs(M.sin(q));
      o.panic = 1; o.oy += 0.1 * hop; o.lean += 0.3 * M.sin(q * 0.75); o.sy += 0.05 * M.sin(q * 2) - 0.04 * M.pow(1 - hop, 4); o.wob += 0.45 * M.sin(q * 1.6); o.ox += 0.05 * M.sin(q * 0.75 + 1);
    }
    // --- a projectile coming at it: the head turns to follow it (only a worm that is not busy)
    {
      let best = null, bd = K.WATCH_R;
      if (!c.air && !c.aiming && !c.burn && !w.dead && !c.wet && !won && S.proj.length) {
        const sw0 = SS.plane.to_plane(S, w.pos);
        for (const p of S.proj) {
          if (p.owner === w.id && p.age < 1.2) continue;
          const dx = (p.s - sw0.s) * c.f, dy = p.y - (w.pos.y + 0.3), d = M.hypot(dx, dy);
          if (d < bd && M.hypot(p.vs, p.vy) > 1 && p.vs * c.f * dx + p.vy * dy < 0) { bd = d; best = { dx, dy, d }; }
        }
      }
      s.watchK += ((best ? 1 : 0) - s.watchK) * M.min(1, dt * (best ? 9 : 3));
      if (best) s.wlook = M.atan2(best.dy, best.dx);
      if (s.watchK > 0.02) { o.watch = s.watchK; o.lookW = M.max(o.lookW, s.watchK); o.look = s.wlook; o.perk = M.max(o.perk, 0.5 * s.watchK); }
    }
    // --- thrown by a blow: the airborne body thrashes (a wave of curvature runs along it, it rocks back and forth), dying away with the flight
    if (c.air && !w.dead && !c.wet && c.speed > 3) {
      const age = t - s.hitT, th = age >= 0 && age < 4 ? s.hitK * M.exp(-age / 1.3) * M.min(1, (c.speed - 3) / 4) * smoothstep(age / 0.06) : 0;
      if (th > 0.02) { o.thrash = th; o.flail = true; o.pain = M.max(o.pain, 0.3 * th); }
    }
    // --- in the water: a drowning worm fights (writhing, rocking) until it is too weak, a swimming one paddles
    if (c.wet > 0.12 || w.drowning) {
      const weak = w.drowning ? M.min(1, M.max(0.25, (w.hp || 0) / 40)) : 1;
      if (w.swim && w.swim.jk && !w.drowning) o.struggle = 0.06;                      // P89: afloat in a life jacket: no struggle, no flailing
      else { o.struggle = (w.drowning ? 0.9 : 0.4) * weak; o.flail = true; }
    }
    // --- the dying beat (the last 1.1 s before the worm is gone): by cause. Fire, gas, acid, current, a hard fall: it sags and folds, the head sinks, the eyes shut;
    // a blast or a bullet: it freezes, the eyes bulge, it shivers (and swells: polish.js shudder)
    if (S.phase === 'dying' && S.dyingW === w && !S.dyingGrave && !c.air) {
      const k = clamp(1 - S.dyingT / 1.1, 0, 1), cz = w.cause | 0, CA = C_.CAUSE;
      if (cz === CA.BURN || cz === CA.LAVA || cz === CA.POISON || cz === CA.ACID || cz === CA.SHOCK || cz === CA.FALL || cz === CA.DROWN) {
        const kk = smoothstep(k / 0.85);
        o.sy -= 0.46 * kk; o.sx += 0.14 * kk; o.lean -= 0.45 * kk; o.ox -= 0.08 * kk; o.lookW = 1; o.look = -1.15; o.pain = M.max(o.pain, 0.5 + 0.4 * kk); o.wob += 0.15 * M.sin(t * 17) * (1 - kk);
      } else {
        o.fear = M.max(o.fear, 0.4 + 0.6 * k); o.sy += 0.03 * M.sin(t * 33) * k; o.sx -= 0.02 * M.sin(t * 29) * k;
      }
    }
    // --- the crawl: an inchworm stretch (the body lengthens and contracts with the wave, a small bob); a breathing idle
    if (!c.air && c.crawl > 0.12 && !c.burn && !w.swim) { const ph = TAU * v.pose.wave * 0.5; o.sx += 0.05 * c.crawl * M.sin(ph); o.oy += 0.012 * c.crawl * M.abs(M.sin(ph)); }
    else if (!c.air && c.crawl < 0.05 && !c.burn && !w.dead) { const br = M.sin(t * 2.1 + (w.id || 0) * 1.9); o.sy += 0.018 * br; o.sx -= 0.007 * br; }
    // --- low HP: heavy breathing, sweat; an idle stretch + yawn
    const calm = !c.air && !c.burn && !w.drowning && !w.swim && (c.crawl || 0) < 0.15 && s.fear < 0.1 && !o.pain && !o.cheer && !c.aiming;
    if (calm && w.hp > 0 && w.hp <= 25) {
      const br = 0.5 + 0.5 * M.sin(t * 5.4 + w.id); o.sy += 0.035 * br; o.sx -= 0.015 * br; o.pain = M.max(o.pain, 0.12);
      s.sweatT -= dt; if (s.sweatT <= 0 && F && c.inSec) { s.sweatT = rnd(0.9, 1.8); F.splash(w.pos.x + rnd(-0.1, 0.1), w.pos.y + 0.5, w.pos.z, 0.07); }
    } else if (calm) {
      const cyc = (t + (w.id || 0) * 3.7) % K.YAWN_T;
      if (cyc < K.YAWN_D) { const k = M.sin(cyc / K.YAWN_D * M.PI); o.yawn = k; o.sy += 0.07 * k; o.sx -= 0.03 * k; }
    }
    // --- water: below the surface: depth tint + bubbles; struggling at the surface
    if (c.wet > 0) {
      o.wet = c.wet; o.flail = true;
      s.bubT -= dt; if (s.bubT <= 0 && F && c.inSec) { s.bubT = (w.drowning ? 0.07 : 0.16) * rnd(0.6, 1.4); F.bubble(w.pos.x + rnd(-0.12, 0.12), w.pos.y + 0.25 + rnd(0, 0.2), w.pos.z + rnd(-0.1, 0.1)); }
    }
    return o;
  };
})(window.SS = window.SS || {});
