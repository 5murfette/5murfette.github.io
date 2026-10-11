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
  const OUT = { sx: 1, sy: 1, ox: 0, oy: 0, pain: 0, scream: false, fear: 0, cheer: 0, yawn: 0, daze: false, wob: 0, flail: false, wet: 0, perk: 0 };
  const K = { FEAR_R: 4.6, FEAR_FUSE: 2.6, YAWN_T: 12, YAWN_D: 1.3 };

  function get(w) {
    let s = st[w.id];
    if (!s) s = st[w.id] = { painT: 0, painK: 0, dazeT: 0, fear: 0, fearT: 0, sweatT: 0, perkT: -9, lastActive: false, drownBub: 0, lastHurt: -9, src: 0, bubT: 0, hp: w.hp };
    return s;
  }
  RX.init = function () {};
  RX.clear = function () { st.length = 0; clock = 0; };

  RX.onEvent = function (S, e) {
    const F = SS.fx;
    if (e.type === 'hurt' && e.worm && !e.worm.dead) {
      const w = e.worm, s = get(w);
      s.lastHurt = clock; s.src = e.src | 0;
      if (e.dot) {                                                   // fire, acid, gas, lava, drowning: a wince, no dent
        if (C_.DS_CAUSE[e.src | 0] !== C_.CAUSE.DROWN) { s.painT = M.max(s.painT, 0.35); s.painK = M.max(s.painK, 0.25); }
        return;
      }
      const k = clamp(e.amount / 42, 0.14, 0.9);
      s.painT = 0.55 + 1.1 * k; s.painK = k;
      if (e.amount >= 26) s.dazeT = M.max(s.dazeT, 1.2 + 2.2 * k);
      if (F && F.addShake && e.amount >= 12) F.addShake(0.06 + 0.16 * k);
    } else if (e.type === 'land' && e.worm && !e.worm.dead) {
      const s = get(e.worm), sp = e.speed || 0;
      if (sp > 9 && F) F.dustAt(e.x, e.y + 0.05, e.z, 6 + M.round(sp), 0.35 + 0.02 * sp);
    } else if (e.type === 'zap' && e.worm) { const s = get(e.worm); s.painT = 1.2; s.painK = 0.8; s.dazeT = 3; }
    else if (e.type === 'kill' && e.worm) deathFx(S, e);
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
    // --- victory
    if (S.phase === 'over' && S.over >= 0 && w.team === S.over && !w.dead && !c.air) {
      const q = t * 5.2 + (w.id || 0) * 1.3, hop = M.abs(M.sin(q)); o.oy += 0.32 * hop; o.sy += 0.1 * M.cos(q * 2) * 0.5; o.sx -= 0.04 * M.cos(q * 2); o.cheer = 1; o.flail = true;
    }
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
