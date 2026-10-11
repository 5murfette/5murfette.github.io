/* sim/aia.js — P37-W3: the CPU's use of weapons A (sub-module of sim/weaponsa.js; hooks in sim/ai.js specials() /
 * fireSpecial()). Every weapon contributes candidates { special: key, v: expected value, ... } comparable to the
 * ballistic search's scores (expected HP taken off enemies, minus OWN_K x own-team damage); the best one wins when it beats
 * the plan by 25 %. Values:
 *   flamethrower  foe within 11 m on a clear line: min(hp, 45) x 0.8       (stream along the aim)
 *   minigun       foe within 28 m on a clear line: min(hp, 80) x 0.95
 *   handgun       foe within 17 m on a clear line: min(hp, 30) x 0.85       (two rounds)
 *   mortar        AI.predict at full power over a fan of angles: the bomblets (22 HP) within 3.2 m of the burst
 *   acid / gas    AI.predict over angles x powers: acid within 2.6 m of the flask (min(hp, 30)), gas within 3.6 m (18 per foe)
 *   boomerang     the harmonic flight model run forward 1.4 s over angles x powers: the first foe on the way (26 HP)
 *   raven         five letters (18 HP) on the target when a clear 22 m launch line exists (the first 19 m are flown straight)
 * Deterministic: reads the state only; the aim noise comes from the AI's own stream (the gauss passed in). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane, A = C.ARMS;
  const WA = SS.weaponsA;
  if (!WA) return;
  const OWN_K = 1.6;
  const val = (S, me, cx, cy, cz, R, per, cap) => {                    // enemies within R of the point: per-foe value (capped by HP), own team negative
    let v = 0;
    for (const o of S.worms) {
      if (o.dead) continue;
      const d = M.len3(o.pos.x - cx, o.pos.y - cy, o.pos.z - cz); if (d > R) continue;
      const k = 1 - 0.5 * d / R, dm = M.min(o.hp, per * k * (cap || 1));
      v += o.team === me ? -(o === S.active ? 2.2 : OWN_K) * dm : dm;
    }
    return v;
  };
  const clearLine = (S, s0, y0, s1, y1) => { const L = M.len2(s1 - s0, y1 - y0), n = Math.ceil(L / 0.25); for (let i = 2; i < n; i++) { const f = i / n; if (P.solid2(S, s0 + (s1 - s0) * f, y0 + (y1 - y0) * f)) return false; } return true; };
  // the boomerang's flight (as sim/raven.js, terrain only): the first foe within reach in the first 1.4 s
  function boomHit(S, a, aim, facing, pw) {
    const K = A.BOOM, ap = P.to_plane(S, a.pos), v0 = C.WEAPONS.boomerang.vmax * M.max(C.WORM_DYN.MIN_POWER, pw), om = Math.PI / K.T, dt = 1 / 60;
    const ds = facing * M.cos(aim), dy = M.sin(aim);
    let s = ap.s + ds * 0.7, y = a.pos.y + dy * 0.7, vs = ds * v0, vy = dy * v0; const s0 = ap.s, y0 = y;
    for (let t = 0; t < 1.4; t += dt) {
      const f = M.smooth(M.clamp(t / K.T, 0, 1)), yt = y0 - K.LOW * f;
      vs += (-om * om * (s - s0) - K.DRAG * vs) * dt; vy += (-om * om * (y - yt) - K.DRAG * vy) * dt; s += vs * dt; y += vy * dt;
      if (P.solid2(S, s, y)) return null;
      for (const o of S.worms) {
        if (o.dead || o === a) continue;
        const q = P.to_plane(S, o.pos); if (Math.abs(q.t) > C.WORM_R) continue;
        if (M.len2(s - q.s, y - o.pos.y) < C.WORM_R + 0.2) return o;
      }
    }
    return null;
  }
  // how much the CPU values each weapon relative to its raw expected damage (limited-ammo specials, like the PoC's cluster / air strike
  // picks: two handgun rounds, a poison that keeps hurting, five letters, bomblets that scatter all weigh more than one blast)
  const RAVEN_K = 0.35;                    // letters that actually land on the target (measured, P38)
  const BIAS = { flamethrower: 1.0, minigun: 1.15, handgun: 1.0, mortar: 0.8, acid: 1.2, gas: 0.6, boomerang: 1.0, raven: 1.0 };   // P38: measured real damage / predicted (CPU-vs-CPU runs, docs/notes/P38-A3.md)
  WA.ai_candidates = function (S, pl, a, tgt, cands, c) {
    const n0 = cands.length;
    const me = a.team;
    if (c.own) return;
    const can = k => SS.weapons.can_use(S, k);
    const on = k => !c.only || c.only === k;
    if (c.clear && on('basic')) {
      if (can('flamethrower') && c.dist < 11) cands.push({ special: 'flamethrower', v: M.min(tgt.hp, 45) * 0.8, aim: c.aim, facing: c.facing });
      if (can('minigun') && c.dist < (SS.ai.laser_on(a) ? 38 : 28)) cands.push({ special: 'minigun', v: M.min(tgt.hp, 80) * 0.95, aim: c.aim, facing: c.facing });
      if (can('handgun') && c.dist < (SS.ai.laser_on(a) ? 24 : 17)) cands.push({ special: 'handgun', v: M.min(tgt.hp, 30) * 0.85, aim: c.aim, facing: c.facing });
    }
    // a fan of (aim, power) shots of a charged weapon: the 3 best (nominal, distinct) are re-scored by their expected value
    // under the difficulty's aim / power noise (AI.expect_fn); the best expectation is the candidate
    const fan = (key, aims, pws, score) => {
      const all = [];
      for (const aim of aims) for (const pw of pws) {
        const h = SS.ai.predict(S, key, aim, c.facing, pw); if (!h || h.wet) continue;
        all.push({ aim, pw, v: score(h) });
      }
      M.sort_stable(all, (p, q) => q.v - p.v);
      let best = null, n = 0;
      for (const e of all) {
        if (n >= 3 || e.v <= 0) break;
        if (best && n && Math.abs(e.aim - best.aim0) < 0.12 && Math.abs(e.pw - best.pw0) < 0.2 && n < 2) continue;
        n++;
        const v = SS.ai.expect_fn(S, pl, key, e.aim, c.facing, e.pw, score);
        if (!best || v > best.v) best = { special: key, v, aim: e.aim, pw: e.pw, facing: c.facing, aim0: e.aim, pw0: e.pw };
      }
      if (best) cands.push(best);
    };
    const aimsA = [], aimsM = [];
    for (let q = -0.2; q <= 1.45; q += 0.1) aimsA.push(q);
    for (let q = 0.55; q <= 1.5; q += 0.05) aimsM.push(q);
    if (on('mortar') && can('mortar')) fan('mortar', aimsM, [1], h => val(S, me, h.x, h.y + 1.5, h.z, 3.6, 45));
    if (on('acid') && can('acid')) fan('acid', aimsA, [0.3, 0.45, 0.6, 0.8, 1], h => val(S, me, h.x, h.y, h.z, 2.9, 30));
    if (on('gas') && can('gas')) { const g0 = cands.length; fan('gas', aimsA, [0.3, 0.45, 0.6, 0.8, 1], h => val(S, me, h.x, h.y + 0.5, h.z, 4.0, 26) * 0.9); if (cands.length > g0) cands[cands.length - 1].fb = 1; }     // (P38-R5: a poison is a fallback: it was never worth more than 18, the threshold of a special, so it was never thrown)
    if (on('basic') && can('boomerang')) {
      let best = null;
      for (let aim = -0.1; aim <= 0.9; aim += 0.1) for (const pw of [0.35, 0.5, 0.65, 0.8, 1]) { const o = boomHit(S, a, aim, c.facing, pw); if (!o) continue; const v = (o.team === me ? -OWN_K : 1) * M.min(o.hp, A.BOOM.DMG) * 1.1; if (!best || v > best.v) best = { special: 'boomerang', v, aim, pw, facing: c.facing }; }
      if (best) cands.push(best);
    }
    if (on('basic') && can('raven') && c.dist > 6) {
      // five letters on the target. The raven's real flight (WA.raven_probe = the sim's own path finding) is flown for a fan of
      // launch angles: the ones that reach the orbit above the target count, the quickest wins (a straight line check was wrong:
      // the launch turns toward the target at 0.9 rad/s and smashed into the hillside half of the time)
      let bestR = null;
      for (const da of [0.25, 0.45, 0.05, 0.65, 0.9, -0.15, 1.2]) {
        const ang = M.min(1.45, M.max(-0.3, M.max(c.aim, 0) + da)), pr = WA.raven_probe(S, a, c.ap, c.facing * M.cos(ang), M.sin(ang), c.tp.s, tgt.pos.y);
        if (pr.ok && (!bestR || pr.t < bestR.t)) bestR = { ang, t: pr.t, cs: pr.cs, cy: pr.cy };
      }
      if (bestR) cands.push({ special: 'raven', v: val(S, me, tgt.pos.x, tgt.pos.y, tgt.pos.z, 3.4, 40) * RAVEN_K, aim: bestR.ang, facing: c.facing, ts: c.tp.s, ty: tgt.pos.y });
    }
    // variety (like the PoC's per-turn weapon picks): on ~40 % of the turns one weapon of the set is the favourite (x 1.35; it was x 4: it made the CPU pick weak weapons); a hash of the
    // turn and the worm, so no RNG stream is consumed and the choice is the same on every peer
    const hf = M.hash3(S.turnNo | 0, a.id | 0, 77), fav = hf < 0.4 ? KEYS[Math.floor(hf / 0.4 * KEYS.length)] : null;
    for (let i = n0; i < cands.length; i++) cands[i].raw = cands[i].v;
    for (let i = n0; i < cands.length; i++) if (BIAS[cands[i].special]) cands[i].v *= BIAS[cands[i].special] * (cands[i].special === fav ? 1.35 : 1);
  };
  // fire a candidate of ours (returns true when it was one of ours)
  const KEYS = ['flamethrower', 'minigun', 'handgun', 'mortar', 'acid', 'gas', 'boomerang', 'raven'];
  const OURS = { flamethrower: 1, minigun: 1, handgun: 1, mortar: 1, acid: 1, gas: 1, boomerang: 1, raven: 1 };
  WA.ai_fire = function (S, pl, a, b, d, gauss) {
    const k = b.special; if (!OURS[k]) return false;
    pl.phase = 'done'; pl.fired = { wpn: k, v: b.v, raw: b.raw, target: pl.foes && pl.foes[b.fi] !== undefined ? SS.ai.foe_wid(pl.foes[b.fi]) : -1 };
    S.weapon = k; a.facing = b.facing;
    if (k === 'flamethrower' || k === 'minigun') { S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.3, -1.5, 1.5); SS.weapons.use(S, 0); return true; }
    if (k === 'handgun') {
      S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.5, -1.5, 1.5); SS.weapons.use(S, 0);
      if (S.phase === 'play') { S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.5, -1.5, 1.5); SS.weapons.use(S, 0); }
      return true;
    }
    if (k === 'raven') { S.aim = b.aim; S.tgt = { s: b.ts, y: b.ty }; SS.weapons.use(S, 0); return true; }
    // charged kinds: the planned angle / power with the difficulty's noise (the mortar ignores the power)
    S.aim = M.clamp(b.aim + gauss(S) * d.noiseA, -1.5, 1.5);
    SS.sim.fire(S, M.clamp(b.pw + gauss(S) * d.noiseP, 0.05, 1));
    return true;
  };
})(window.SS = window.SS || {});
