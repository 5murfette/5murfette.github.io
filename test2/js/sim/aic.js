/* sim/aic.js — P38 R5 (B8): the CPU's rules for the weapons it never used. Sub-module of sim/ai.js (hooks: cands / cands_late / fire /
 * retreat / approach / escape / teleport_fb, see ai.js specials(), fireSpecial(), AI.retreat, robust, giveUp and aib.js prep).
 * Portable and deterministic: reads the state only, no RNG of its own (the aim noise comes from the gauss function passed in),
 * all plan state lives in S.aiPlan (the `appr` counter) and in the candidates; bounded planning cost (a few world probes per call).
 *
 * C layout (candidates are the same struct Cand as ai.js / aia.js: { special, v, aim, facing, ts, ty, pw, fb, ... } + the fields below)
 *   struct AcSpot { f32 s, y, v; }                    a teleport / girder place on the plane (s along the section, y absolute), v its value
 *   struct AcClose { u8 tool; f32 stop, ev; }         a close-range tool: how far from the foe the worm must stand, its expected value
 *
 * Values (HP-eq, comparable with ai.js score(): enemies' damage capped by HP + KILL, own team x OWN_K, the shooter x 2.2)
 *   dynamite   a blast 1.5 m in front of the worm (the toss), the worm walks away FLEE m during the 5 s fuse (it is scored there)
 *   mine       as dynamite with the mine's charge, a foe within 2 m of the spot (it arms in 3 s, the stationary foe sets it off), x 0.85
 *   spring     a foe within 1.1 m of the device 0.6 m ahead: 20 HP + the throw (x 1.6 = the measured 40 HP), x 0.8
 *   sheep      a foe 6..26 m away on walkable ground: the blast at the foe x 0.65 (it may hop wrong); fired again by retreat()
 *   napalm     fire on the target: 50 HP per foe within 4.5 m (falls off with the distance), the sky must be open, own worms >= 8 m away
 *   bat        a foe within the swing (1.8 m): 30 + 20, + the foe's HP when the knock (about 14 m) lands in the water
 *   drill      the torch (3.3 m tunnel, 15 HP and a push) when the foe is within 3.4 m behind rock: 23 (a weak last resort)
 *   teleport   fallback (value 3: only when nothing else is possible, walking included) to a free spot with a clear line to the foe
 *              8..16 m away; escape: out of the rising sea when no walk or rope reaches high ground
 *   girder     fallback (value 6): a horizontal plate across a gap (water / a drop of more than 3 m, at most 4.9 m wide) toward the foe
 *   approach   walk toward a foe (<= 28 m: 14 s) to the stop distance of the best close tool (bat 1.3, punch 1.3, spring 1.7, dynamite / mine 2.5,
 *              flamethrower 5, handgun 6) when 0.75 x its expected value beats the current shot by 8 and is >= 20 (once per turn; in a 'close combat' mood on 35 %
 *              of the turns, chosen by a hash: by -8 and >= 16) */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane;
  const AC = SS.aic = {};
  const AB = () => SS.aib;
  const K = AC.K = { OWN_K: 1.6, KILL: 25, FLEE: 9, DYN_REACH: 5.5, TOSS: 1.5, MINE_R: 2.0, SPRING_R: 1.1, SHEEP_MIN: 6, SHEEP_MAX: 26, SHEEP_K: 0.65, NAPALM_R: 4.5, NAPALM_DMG: 50,
    NAPALM_OWN: 8, BAT_REACH: 1.8, BAT_KNOCK: 14, DRILL_REACH: 3.4, TP_MIN: 8, TP_MAX: 16, TP_EDGE: 10, GAP_MAX: 4.9, APPROACH_MAX: 28, APPROACH_GAIN: 8, APPROACH_MIN: 20, CLOSE_K: 0.75, MOOD_P: 0.35, MOOD_GAIN: -8 };

  /* value of a blast of charge W / PoC damage dmg at world point c: enemies' damage capped by HP (+ KILL per kill), own team x OWN_K (+ 60 per kill),
   * the active worm x 2.2 standing `shift` m along the section behind its facing (where it will be when a fused charge goes off) */
  function blastVal(S, a, c, Wkg, dmg, shift, f) {
    const me = a.team, ap = shift ? P.to_plane(S, a.pos) : null; let v = 0;
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i]; if (o.dead) continue;
      const pos = o === a && shift ? P.to_world(S, ap.s - f * shift, a.pos.y) : o.pos;
      const e = SS.blast.worm_effect(c, Wkg, pos, dmg), dm = M.min(o.hp, Math.round(e.dmg));
      if (o.team === me) v -= (o === a ? 2.2 : K.OWN_K) * dm + (dm >= o.hp ? 60 : 0);
      else v += dm + (dm >= o.hp ? K.KILL : 0);
    }
    return v;
  }
  // enemies within R of the point: per-foe value (capped by HP, falling to half at R), own team negative (as aia.js val)
  function areaVal(S, a, cx, cy, cz, R, per) {
    let v = 0;
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i]; if (o.dead) continue;
      const d = M.len3(o.pos.x - cx, o.pos.y - cy, o.pos.z - cz); if (d > R) continue;
      const dm = M.min(o.hp, per * (1 - 0.5 * d / R));
      v += o.team === a.team ? -(o === a ? 2.2 : K.OWN_K) * dm : dm;
    }
    return v;
  }
  const hasW = (S, k) => SS.weapons.can_use(S, k);
  // an own-team worm (not the shooter) within r m of the plane segment s0..s1 (in the plane, |t| < 1.5): the path of a sheep / the fall of a drop
  function ownOnPath(S, a, s0, s1, r) {
    const lo = M.min(s0, s1) - r, hi = M.max(s0, s1) + r;
    for (let i = 0; i < S.worms.length; i++) { const o = S.worms[i]; if (o.dead || o === a || o.team !== a.team) continue; const q = P.to_plane(S, o.pos); if (Math.abs(q.t) < 1.5 && q.s > lo && q.s < hi) return true; }
    return false;
  }
  const fleeOk = (S, a, ap, f) => AB().walkable(S, ap.s, ap.s - f * K.FLEE, a.pos.y) && AB().safe_step(S, a, -f);

  /* ---------- close-range tools: the expected value of each against the foe at distance ds along the section (>= 0 = in front) ---------- */
  // returns the best { tool, stop, ev } over what the CPU holds, or null; used by approach() with the foe as it stands
  function closeBest(S, a, tgt, ap, tp, facing) {       // (ap: the worm's plane position)
    let best = null;
    const push = (tool, stop, ev) => { if (!best || ev > best.ev) best = { tool, stop, ev }; };
    if (Math.abs(tgt.pos.y - a.pos.y) > 2.5 || Math.abs(tp.s - ap.s) > K.APPROACH_MAX) return null;
    if (hasW(S, 'bat')) push('bat', 1.3, M.min(tgt.hp, C.ARMS.BAT.DMG) + 20);
    if (hasW(S, 'punch')) push('punch', 1.3, M.min(tgt.hp, 30) + 30);
    if (hasW(S, 'spring')) push('spring', 1.7, M.min(tgt.hp, 40) * 0.8);
    if (hasW(S, 'dynamite')) {                                       // the charge lands 1 m from the foe (the toss is 1.5 m), the worm walks off
      const pj = C.PROJ.dynamite, c = P.to_world(S, tp.s - facing * 1.0, tgt.pos.y + 0.3);
      push('dynamite', K.TOSS + 1.0, blastVal(S, a, c, pj.W, pj.dmg, K.FLEE, facing) * 0.9);
    }
    if (hasW(S, 'mine')) push('mine', K.TOSS + 0.5, M.min(tgt.hp, C.PROPS.MINE.DMG) * 0.85);
    if (hasW(S, 'flamethrower')) push('flamethrower', 5, M.min(tgt.hp, 45) * 0.8);
    if (hasW(S, 'handgun')) push('handgun', 6, M.min(tgt.hp, 30) * 0.85);
    return best;
  }

  /* ---------- candidates ---------- */
  // stage 0 (cheap, tied to the target `tgt` the plane is aligned with): ctx = { ap, tp, dist, facing, aim, clear }
  AC.cands = function (S, pl, a, tgt, cands, ctx) {
    if (tgt.team === a.team || a.air || S.rope) return;
    const ap = ctx.ap, tp = ctx.tp, f = ctx.facing, ds = Math.abs(tp.s - ap.s), dy = tgt.pos.y - a.pos.y, onSec = Math.abs(tp.t) < 1.2;
    if (!onSec) return;
    const grounded = P.grounded2(S, ap.s, a.pos.y);
    // bat: the swing reaches 1.2 m around a point 0.6 m ahead; the foe must be in front and in line of sight
    if (hasW(S, 'bat') && ds < K.BAT_REACH && Math.abs(dy) < 1.4 && ctx.clear) {
      let v = M.min(tgt.hp, C.ARMS.BAT.DMG) + 20;
      const land = tp.s + f * K.BAT_KNOCK;                            // the knock (measured ~14 m on flat ground): into the water = the foe is lost
      if (AB().wet_at(S, land, tgt.pos.y)) v += M.min(tgt.hp, 100);
      cands.push({ special: 'bat', v, aim: M.max(0.2, ctx.aim), facing: f });
    }
    if (!grounded) return;
    // dynamite: dropped 1.5 m ahead, 5 s fuse: the foe within DYN_REACH m of the worm, an escape route behind
    if (hasW(S, 'dynamite') && ds < K.DYN_REACH && Math.abs(dy) < 4 && fleeOk(S, a, ap, f)) {
      const pj = C.PROJ.dynamite, c = P.to_world(S, ap.s + f * K.TOSS, a.pos.y + 0.3), v = blastVal(S, a, c, pj.W, pj.dmg, K.FLEE, f) * 0.9;
      if (v > 0) cands.push({ special: 'dynamite', v, aim: 0.1, facing: f });
    }
    // mine: the stationary foe within MINE_R of where it lands; it arms in 3 s and goes off 1.6 s after the foe is within its trigger radius
    if (hasW(S, 'mine') && Math.abs(ds - K.TOSS) < K.MINE_R && Math.abs(dy) < 2 && fleeOk(S, a, ap, f)) {
      const e = C.PROPS.MINE, c = P.to_world(S, ap.s + f * K.TOSS, a.pos.y + 0.2), v = blastVal(S, a, c, e.W, e.DMG, K.FLEE, f) * 0.85;
      if (v > 0) cands.push({ special: 'mine', v, aim: 0.1, facing: f });
    }
    // spring trap: set 0.6 m ahead, throws any enemy within 1.1 m high (20 HP + the fall): the foe right in front of the worm
    if (hasW(S, 'spring') && Math.abs(ds - 0.6) < K.SPRING_R && Math.abs(dy) < 1.5 && ctx.clear) cands.push({ special: 'spring', v: M.min(tgt.hp, 40) * 0.8, aim: 0.1, facing: f });
    // torch: a foe within 3.4 m behind rock (no clear line): the tunnel reaches it (15 HP + a push), the worm arrives next to it
    if (hasW(S, 'drill') && ds < K.DRILL_REACH && Math.abs(dy) < 1.6 && !ctx.clear) {
      const aim = M.clamp(M.atan2(dy, ds), -0.3, 0.8);
      cands.push({ special: 'drill', v: M.min(tgt.hp, C.ARMS.DIG.DMG) + 8, aim, facing: f });
    }
    // sheep: it walks to the foe on a walkable path with no own worm on it; fired again by retreat() when it is next to the foe
    if (hasW(S, 'sheep') && ds > K.SHEEP_MIN && ds < K.SHEEP_MAX && Math.abs(dy) < 5 && AB().walkable(S, ap.s, tp.s - f * 1.0, a.pos.y) && !ownOnPath(S, a, ap.s, tp.s, 3)) {
      const pj = C.PROJ.sheep, c = { x: tgt.pos.x, y: tgt.pos.y - 0.2, z: tgt.pos.z };
      let v = 0;
      for (let i = 0; i < S.worms.length; i++) {
        const o = S.worms[i]; if (o.dead) continue;
        const e = SS.blast.worm_effect(c, pj.W, o.pos, pj.dmg), dm = M.min(o.hp, Math.round(e.dmg));
        if (o.team === a.team) v -= K.OWN_K * dm + (dm >= o.hp ? 60 : 0); else v += dm + (dm >= o.hp ? K.KILL : 0);
      }
      v *= K.SHEEP_K;
      if (v > 0) cands.push({ special: 'sheep', v, aim: 0.1, facing: f });
    }
    // napalm: fire on the target (open sky, no own worm within NAPALM_OWN m of the aim point)
    if (hasW(S, 'napalm') && ds > 3) {
      let near = false;
      for (let i = 0; i < S.worms.length; i++) { const o = S.worms[i]; if (!o.dead && o.team === a.team && M.len3(o.pos.x - tgt.pos.x, o.pos.y - tgt.pos.y, o.pos.z - tgt.pos.z) < K.NAPALM_OWN) near = true; }
      if (!near) {
        const v = areaVal(S, a, tgt.pos.x, tgt.pos.y, tgt.pos.z, K.NAPALM_R, K.NAPALM_DMG) * 0.85;
        if (v > 0) cands.push({ special: 'napalm', v, ts: tp.s, ty: tgt.pos.y, facing: f });
      }
    }
  };
  // heavier / fallback candidates (stage 6 of ai.js specials): teleport, girder
  AC.cands_late = function (S, pl, a, tgt, cands, ctx) {
    if (tgt.team === a.team || a.air || S.rope) return;
    const ap = ctx.ap, tp = ctx.tp, f = ctx.facing;
    if (hasW(S, 'teleport') && !ctx.clear) {
      const sp = teleportSpot(S, a, tgt, ap, tp, f);
      if (sp) cands.push({ special: 'teleport', fb: 1, v: 3, ts: sp.s, ty: sp.y, aim: 0, facing: f });
    }
    if (hasW(S, 'girder') && Math.abs(tp.t) < 1.2 && ctx.dist > 8) {
      const g = bridgeSpot(S, a, ap, f);
      if (g) cands.push({ special: 'girder', fb: 1, v: 6, ts: g.s, ty: g.y, aim: 0, facing: f });
    }
  };

  /* ---------- teleport ---------- */
  // is (s, y) a place the teleport accepts and a worm can stand: inside the map margin, free, above the water, open to the sky, nobody within 2.5 m
  function spotFree(S, s, y) {
    const w = SS.world, q = P.to_world(S, s, y), EM = 10;
    if (q.x < EM || !w.zin(q.z, EM) || q.x > w.SX - EM || !SS.sim.in_play(S, q.x, q.z)) return false;
    if (P.overlap2(S, s, y) > 0 || y < SS.sim.surface_at(S, q.x, q.z) + 0.5 || y > w.SY - 1) return false;
    for (let i = 0; i < S.worms.length; i++) { const o = S.worms[i]; if (!o.dead && M.len3(o.pos.x - q.x, o.pos.y - y, o.pos.z - q.z) < 2.5) return false; }
    return SS.weapons.open_air(q.x, y, q.z);
  }
  function standAt(S, s, y0) {                                         // ground under (s, y0 + 6): the standing height of a worm, or null
    const g = SS.weapons.ground_below(S, s, y0 + 6); if (g < -1e8 || AB().wet_at(S, s, g + 0.3)) return null;
    return g + 0.7;
  }
  // a spot 8..16 m from the foe on the worm's side with a clear line to it (the highest value: nearest to 10 m, a little height)
  function teleportSpot(S, a, tgt, ap, tp, f) {
    let best = null;
    for (let d = K.TP_MIN; d <= K.TP_MAX; d += 2) for (let side = 0; side < 2; side++) {
      const ss = tp.s + (side === 0 ? -f : f) * d, y = standAt(S, ss, tgt.pos.y);
      if (y == null || !spotFree(S, ss, y) || !clearLine(S, ss, y + 0.4, tp.s, tgt.pos.y + 0.3)) continue;
      const v = 10 - Math.abs(d - K.TP_EDGE) * 0.5 + M.clamp((y - tgt.pos.y) * 0.5, -2, 3) + (side === 0 ? 1 : 0);
      if (!best || v > best.v) best = { s: ss, y, v };
    }
    return best;
  }
  function clearLine(S, s0, y0, s1, y1) { const L = M.len2(s1 - s0, y1 - y0), n = Math.ceil(L / 0.25); for (let i = 2; i < n - 1; i++) { const f = i / n; if (P.solid2(S, s0 + (s1 - s0) * f, y0 + (y1 - y0) * f)) return false; } return true; }
  /* escape from the rising sea: the best standing place on the plane within +-24 m whose ground is above `danger`, nearest first.
   * Called by aib.prep when neither a walk nor the rope gets the worm up; fires at once (returns true when it did). */
  AC.escape = function (S, pl, a, danger) {
    if (!hasW(S, 'teleport') || a.air || S.rope) return false;
    const ap = P.to_plane(S, a.pos); let best = null;
    for (let o = -24; o <= 24; o += 2) {
      const s = ap.s + o, y = standAt(S, s, a.pos.y + 10); if (y == null || y < danger + 1.5 || Math.abs(o) >= (best ? best.d : 1e9) || !spotFree(S, s, y)) continue;
      best = { s, y, d: Math.abs(o) };
    }
    if (!best) return false;
    return doTeleport(S, pl, a, best.s, best.y, 40);
  };
  function doTeleport(S, pl, a, s, y, v) {
    S.weapon = 'teleport'; S.tgt = { s, y };
    const ok = SS.weapons.use(S, 0);
    pl.phase = 'done'; pl.fired = ok ? { wpn: 'teleport', v, target: -1 } : null;
    return ok;
  }

  /* ---------- girder bridge ---------- */
  // toward the foe: the first gap (water / a drop of more than 3 m) within 6 m and the far side within GAP_MAX m of its edge at a similar height:
  // the plate (5.9 m long) laid flat with its top flush with the near ground, centred on the gap
  function bridgeSpot(S, a, ap, f) {
    const WP = SS.weapons, y0 = WP.ground_below(S, ap.s, a.pos.y + 0.6); if (y0 < -1e8) return null;
    let xs = -1;
    for (let x = 0.5; x <= 6; x += 0.5) {
      const g = WP.ground_below(S, ap.s + f * x, y0 + 1.0);
      if (g < -1e8 || g < y0 - 3 || AB().wet_at(S, ap.s + f * x, g + 0.3)) { xs = x; break; }
      if (Math.abs(g - y0) > 1.2 && g > y0) return null;               // a wall: not a gap
    }
    if (xs < 0) return null;
    const Gd = C.ARMS.GIRDER, half = Gd.L / 2, e0 = xs - 0.25;
    for (let x2 = xs + 0.5; x2 <= xs + K.GAP_MAX + 0.5; x2 += 0.5) {
      const g = WP.ground_below(S, ap.s + f * x2, y0 + 1.5);
      if (g > -1e8 && Math.abs(g - y0) < 1.2 && !AB().wet_at(S, ap.s + f * x2, g + 0.3)) {
        const e1 = x2 - 0.25, cx = M.max(half + 0.6, (e0 + e1) / 2);      // the plate must not overlap the worm (it refuses: "a worm is in the way"), nor leave more than 0.5 m of the near edge or any of the far edge uncovered
        if (cx - half > e0 + 0.5 || cx + half < e1 + 0.3 || cx > Gd.REACH - 1) return null;
        return { s: ap.s + f * cx, y: y0 - Gd.T / 2 };
      }
    }
    return null;
  }

  /* ---------- approach: walk toward a foe to use a close-range tool ---------- */
  // called when the best shot is worth pickV (0 = none): true when a walk was started (ai.js then searches again from the new spot)
  AC.approach = function (S, pl, a, pickV) {
    if (pl.appr || pl.moves >= (AB().K.MAX_MOVES) || a.air || S.rope) return false;
    const AIx = SS.ai, tgt = AIx.foe(S, pl, pl.fi); if (!tgt || tgt.team === a.team || tgt.hp <= 0) return false;
    const ap = P.to_plane(S, a.pos), tp = P.to_plane(S, tgt.pos), f = tp.s >= ap.s ? 1 : -1, ds = Math.abs(tp.s - ap.s);
    if (Math.abs(tp.t) > 1.2 || ds > K.APPROACH_MAX || ds < 2.2) return false;
    const cb = closeBest(S, a, tgt, ap, tp, f); if (!cb) return false;
    const ev = cb.ev * K.CLOSE_K;
    // variety (like the PoC's per-turn weapon picks, and aia.js): on ~35 % of the turns (a hash of the turn and the worm: the same on every peer) the CPU is in a
    // "close combat" mood and walks up for a close tool even when the shot is about as good; limited tools would otherwise stay in the kit while the bazooka is free
    const mood = M.hash3(S.turnNo | 0, a.id | 0, 91) < K.MOOD_P, gain = mood ? K.MOOD_GAIN : K.APPROACH_GAIN;
    if (ev < K.APPROACH_MIN * (mood ? 0.8 : 1) || ev < pickV + gain || ds <= cb.stop + 0.3) return false;
    const goal = tp.s - f * cb.stop;
    if (!AB().walkable(S, ap.s, goal, a.pos.y) || !AB().safe_step(S, a, f)) return false;
    pl.appr = 1; pl.moves++;
    return AB().walk_to(S, pl, a, goal, 'close', 4 + ds / AB().K.WALK_V);
  };

  /* ---------- firing ---------- */
  const DROPS = { dynamite: 1, mine: 1, spring: 1, sheep: 1 };
  AC.fire = function (S, pl, a, b, d, gauss) {
    const k = b.special;
    const mark = () => { pl.phase = 'done'; pl.fired = { wpn: k, v: b.v, target: SS.ai.foe_wid(pl.foes[b.fi]) }; S.weapon = k; a.facing = b.facing; };
    if (DROPS[k]) { mark(); S.aim = 0.1; SS.weapons.use(S, 0); return true; }
    if (k === 'bat') { mark(); S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.5, -1.5, 1.5); SS.weapons.use(S, 0); return true; }
    if (k === 'drill') { mark(); S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.3, -0.5, 1.0); SS.weapons.use(S, 0); return true; }
    if (k === 'napalm') { mark(); S.tgt = { s: b.ts + gauss(S) * d.noiseA * 25, y: b.ty }; S.strikeDir = b.facing; SS.weapons.use(S, 0); return true; }
    if (k === 'teleport' || k === 'girder') { mark(); S.tgt = { s: b.ts, y: b.ty }; if (k === 'girder') S.plateAng = 0; SS.weapons.use(S, 0); return true; }
    return false;
  };

  /* ---------- retreat window: set the sheep off next to its foe ---------- */
  // called every retreat step with the input being built; true when it pressed fire. The sheep goes off when an enemy is within 2 m of it and
  // the charge there is worth >= 25 with the own team counted (otherwise it walks on; its 10 s fuse sets it off by itself).
  AC.retreat = function (S, a, inp) {
    if (S.weapon !== 'sheep') return false;
    const pj = C.PROJ.sheep;
    for (let i = 0; i < S.proj.length; i++) {
      const p = S.proj[i]; if (p.type !== 'sheep' || p.owner !== a.id) continue;
      const c = P.to_world(S, p.s, p.y);
      for (let k = 0; k < S.worms.length; k++) {                  // next to an enemy (within 2 m: the sheep's full blast) and a charge here worth it with the own team counted
        const o = S.worms[k]; if (o.dead || o.team === a.team || M.len3(o.pos.x - c.x, o.pos.y - c.y, o.pos.z - c.z) > 2.0) continue;
        if (blastVal(S, a, c, pj.W, pj.dmg, 0, 1) >= 25) { inp.fire_pressed = 1; return true; }
      }
    }
    return false;
  };

  AC.closeBest = closeBest;                                            // tests
  AC.teleport_spot = teleportSpot; AC.bridge_spot = bridgeSpot;        // tests
})(window.SS = window.SS || {});
