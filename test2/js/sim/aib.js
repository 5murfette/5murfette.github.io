/* sim/aib.js — P38 A3: the CPU's movement and tools (sub-module of sim/ai.js; hooks: prep / reposition / move / cands / fire / air).
 * Portable and deterministic: reads the state only, no RNG of its own, sim time and the fixed step; all plan state lives in
 * S.aiPlan.mv (plain data, one struct).
 *
 * C layout
 *   struct AiMove { u8 kind; /0 walk, 1 fetch (crate), 2 rope, 3 zipline/
 *                   u8 st;   /per kind: see below/
 *                   f32 t0, tmax, goalS, goalY; i8 dir; i32 crate;
 *                   Goal goal; Cand cand[16]; i16 ci; Cand best; f32 tAttach, tRel, lvMin; f32 lastS, stuckT; u8 jumps; }
 *   struct Goal   { u8 type /0 foe, 1 high/; f32 s, y, dangerY; }
 *   struct Cand   { f32 aim; i8 dir; f32 as, ay, len, v, tRel; }
 *
 * Behaviours
 *   prep(S, pl, a)          before the search: flee a xeno within its range + 2.5 m; climb away from the rising sea in sudden death
 *                           (walk to higher ground, else a rope); fetch a health crate when low on HP and one is near.
 *   reposition(S, pl, a)    no shot from here: fetch a near crate, ride a zipline toward the target, swing on the ninja rope toward it
 *                           (a swing is planned by simulating the pendulum + the ballistic landing, one candidate per sim step).
 *   move(S, pl, a, inp)     runs the current move; true when it is over (the AI then searches again from the new spot).
 *   cands(...)              force field (exposed / hurt), gravity gun (throw a mine / barrel at a foe), sniper.
 *   fire(...)               executes those candidates.    air(S, a)  the parachute when a fall would hurt.
 * Landing / spot values are in HP-like points; a move is only started when it gets clearly closer to the target or clears the line. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane;
  const AB = SS.aib = {};
  const K = AB.K = { WALK_TOL: 0.45, FETCH_R: 16, FETCH_HP: 55, MOVE_MIN: 6, SWING_T: 5, LAND_V: 26, XENO_PAD: 2.5, ROPE_AIMS: 9, MAX_MOVES: 2, FF_THREAT_R: 35, BAD_TURNS: 8, DETOUR_R: 10, DETOUR_NEAR: 4, SHOT_OK: 45, FETCH_HP_NOFOE: 25, RETREAT_R: 9, BONUS_K: 0.6, WALK_V: 2.0, BIG_WORTH: 37 };
  const sim = () => SS.sim, WPm = () => SS.weapons, W = () => SS.world;
  const canK = (S, k) => WPm().can_use(S, k);
  const hasSkill = (a, k) => !!(a.skills && a.skills[k] > 0);

  /* ---------- shared helpers ---------- */
  function clearLine(S, s0, y0, s1, y1) { const L = M.len2(s1 - s0, y1 - y0), n = Math.ceil(L / 0.25); for (let i = 2; i < n - 1; i++) { const f = i / n; if (P.solid2(S, s0 + (s1 - s0) * f, y0 + (y1 - y0) * f)) return false; } return true; }
  function wetAt(S, s, y) {
    const wp = P.to_world(S, s, y), surf = sim().surface_at(S, wp.x, wp.z);
    const deck = SS.struct && SS.struct.floor_at ? SS.struct.floor_at(S, wp.x, y, wp.z) : -1e9, ice = SS.ice && S.ice ? SS.ice.top_at(S, wp.x, wp.z) : -1e9;
    if (SS.lava && S.lava && SS.lava.depth_at(S, wp.x, wp.z) > 0.02) return true;
    return !!(SS.water && S.water && SS.water.depth(S, wp.x, wp.z) > 0.3 && deck < surf && ice < -1e8);
  }
  function xenoNear(S, x, y, z, pad) {
    if (!S.alien) return null;
    for (const X of S.alien.xenos) {
      if (X.hp <= 0) continue;
      for (const nd of X.n) if (M.len3(nd.x - x, nd.y - y, nd.z - z) < X.range + pad) return X;
    }
    return null;
  }
  // may the worm take a step in `dir`? (no water / lava, no xeno within its range, no drop over 4.5 m)
  AB.safe_step = function (S, a, dir) {
    const ap = P.to_plane(S, a.pos), ah = ap.s + dir * 0.7, wp = P.to_world(S, ah, a.pos.y);
    if (wetAt(S, ah, a.pos.y)) return false;
    if (xenoNear(S, wp.x, a.pos.y, wp.z, 0.5)) return false;
    // (P38 R3: also not into a live mine, a flame or a gas puff: the retreat walked the worm into its own napalm / gas)
    for (const b of S.bodies) if (b.prop === 'mine' && !b.disarmed && M.len3(b.pos.x - wp.x, b.pos.y - a.pos.y, b.pos.z - wp.z) < 1.4) return false;
    for (const f of S.flames) if (S.time < f.t1 && M.len2(f.x - wp.x, f.z - wp.z) < f.r + 0.5 && Math.abs(f.y - a.pos.y) < 2.5) return false;
    if (SS.weaponsA && SS.weaponsA.gas_at && SS.weaponsA.gas_at(S, wp.x, a.pos.y + 0.3, wp.z) > 0) return false;
    // (P38-R5: nor into a claymore's laser, its own either: the walk of a CPU worm set off its team's claymore, 700 HP of damage in one match)
    for (let i = 0; S.claymores && i < S.claymores.length; i++) {
      const c = S.claymores[i], L = C.TOOLB.CLAY.LASER, sa = [c.pos.x, c.pos.y, c.pos.z], sb = [c.pos.x + c.dir.x * L, c.pos.y + c.dir.y * L, c.pos.z + c.dir.z * L];
      if (M.seg_dist(wp.x, a.pos.y, wp.z, sa, sb) < C.WORM_R + 0.6) return false;
    }
    const g = WPm().ground_below(S, ah, a.pos.y + 0.5);
    if (g < -1e8 || a.pos.y - g > 4.5) return false;
    return true;
  };
  // can the worm walk from s0 to s1 (every 0.4 m: a step up <= 0.7, a drop <= 2.5, no water)
  function walkable(S, s0, s1, y0) {
    const dir = s1 >= s0 ? 1 : -1; let gy = WPm().ground_below(S, s0, y0 + 0.6);
    if (gy < -1e8) return false;
    for (let s = s0 + dir * 0.4; (s1 - s) * dir > 0; s += dir * 0.4) {
      const g = WPm().ground_below(S, s, gy + 1.0);
      if (g < -1e8 || g > gy + 0.7 || g < gy - 2.5 || wetAt(S, s, g + 0.3)) return false;
      gy = g;
    }
    return true;
  }
  // where a worm released with (vs, vy) from (s, y) comes down: { s, y, vy, wet, t } (the ballistic flight under the worm gravity)
  AB.walkable = (S, s0, s1, y0) => walkable(S, s0, s1, y0);
  AB.walk_to = (S, pl, a, goalS, why, tmax) => startWalk(S, pl, a, goalS, why, tmax, 0, null);
  AB.wet_at = (S, s, y) => wetAt(S, s, y);
  function landing(S, a, s, y, vs, vy, out) {
    const g = C.G_WORM * (sim().gravity_k ? sim().gravity_k(S, a) : 1), dt = 1 / 30;
    out.wet = false; out.t = 0;
    for (let t = 0; t < 5; t += dt) {
      vy -= g * dt; let ns = s + vs * dt;
      const ny = y + vy * dt;
      if (P.overlap2(S, ns, y) > P.overlap2(S, s, y) + 1) { vs = 0; ns = s; }
      if (vy < 0 && P.grounded2(S, ns, ny)) { out.s = ns; out.y = ny; out.vy = vy; out.t = t; return out; }
      if (ny < 0.6 || wetAt(S, ns, ny - 0.5)) { out.s = ns; out.y = ny; out.vy = vy; out.wet = true; out.t = t; return out; }
      s = ns; y = ny;
    }
    out.s = s; out.y = y; out.vy = vy; out.wet = true; out.t = 5;       // never came down: treat as lost
    return out;
  }
  // value of standing at (s, y) for a goal: foe: closer, a clear line, a good range, a little height; high: height above the danger
  function spotValue(S, goal, s0, s, y, ld) {
    if (ld && (ld.wet || -ld.vy > K.LAND_V)) return -100;
    if (goal.type === 1) return M.min(y - goal.dangerY, 8) * 2;
    const d = Math.abs(goal.s - s), d0 = Math.abs(goal.s - s0), clear = clearLine(S, s, y + 0.4, goal.s, goal.y);
    let v = (d0 - d) * 1.2 + (clear ? 12 : 0) + (d > 5 && d < 26 ? 4 : 0) + M.clamp((y - goal.y) * 0.5, -3, 5);
    if (d < 1.5) v -= 8;
    return v;
  }

  /* ---------- the moves ---------- */
  function startWalk(S, pl, a, goalS, why, tmax, kind, crate) {
    const ap = P.to_plane(S, a.pos);
    pl.mv = { kind: kind || 0, st: 'go', why, t0: S.time, tmax: tmax || 6, goalS, dir: goalS >= ap.s ? 1 : -1, crate: crate == null ? -1 : crate, lastS: ap.s, stuckT: 0, jumps: 0, tChk: S.time };
    pl.phase = 'move'; return true;
  }
  /* P38-R5 (B9): what a crate is worth to the CPU, in HP-eq. A weapon crate by its rarity band (the balance table: 10 + U / 2, clamped 10..60:
   * common ~20, uncommon ~32, rare ~45, super ~60), a tool crate 14 (overload 26), a health crate by the HP it would restore. */
  const crateWorth = (S, a, c) => {
    if (c.kind === 'health') return a.hp < 70 ? 24 + (100 - a.hp) * 0.4 : 6;
    if (c.kind === 'tool') return c.tool === 'overload' ? 26 : 14;
    const B = SS.balance, r = B && c.weapon ? B.row(c.weapon) : null;
    return r ? M.clamp(10 + 0.5 * B.value(r), 10, 60) : 22;
  };
  AB.crate_worth = crateWorth;
  const crateValue = crateWorth;
  /* crates the worm could not reach: remembered per match in S.aiMem.bad (i32 crate ids + turn numbers), K.BAD_TURNS turns
   * (a crate behind a ledge was retried every turn: the plan reset them). C: struct { i32 id, turn; } bad[16]. */
  function markBad(S, pl, id) {
    pl.badCrates.push(id);
    const b = S.aiMem.bad;
    b.push({ id, turn: S.turnNo }); if (b.length > 16) b.shift();
  }
  function isBad(S, pl, id) {
    if (pl && pl.badCrates.indexOf(id) >= 0) return true;
    const b = S.aiMem.bad;
    for (let i = 0; i < b.length; i++) if (b[i].id === id && S.turnNo - b[i].turn < K.BAD_TURNS) return true;
    return false;
  }
  // is a foe within 3 m of the vertical plane through the worm and the crate? (fetching turns the section to the crate; the shot
  // after it needs a target on that plane, the rotation lock being closed by the walk)
  function foeOnCratePlane(S, a, c) {
    const dx = c.pos.x - a.pos.x, dz = c.pos.z - a.pos.z, L = M.nz(M.len2(dx, dz), 1);
    for (const o of S.worms) {
      if (o.dead || o.hp <= 0 || o.team === a.team) continue;
      if (Math.abs((o.pos.x - a.pos.x) * dz - (o.pos.z - a.pos.z) * dx) / L < 3) return true;
    }
    return false;
  }
  /* P38-R5 (B9): a crate worth more than an average one (22 HP-eq) is worth a longer walk: + (worth - 22) x BONUS_K m (super ~ +23 m, rare ~ +14, uncommon ~ +6) */
  const bonusR = (S, a, c) => M.max(0, crateWorth(S, a, c) - 22) * K.BONUS_K;
  // the best crate to fetch: landed, within FETCH_R m (3D), not tried before this turn; value / (distance + 6)
  function crateGoal(S, pl, a, minHp) {
    let best = null;
    for (const c of S.crates) {
      if (!c.landed || isBad(S, pl, c.id)) continue;
      const d = M.len3(c.pos.x - a.pos.x, c.pos.y - a.pos.y, c.pos.z - a.pos.z);
      if (d > K.FETCH_R + bonusR(S, a, c) || Math.abs(c.pos.y - a.pos.y) > 4) continue;
      if (minHp != null && !(c.kind === 'health' && a.hp <= minHp)) continue;
      if (minHp != null && a.hp > K.FETCH_HP_NOFOE && !foeOnCratePlane(S, a, c)) continue;      // (P38-R2: else the walk ends with no target on the new plane: 48 % of those turns had no shot)
      const sc = crateValue(S, a, c) / (d + 6);
      if (!best || sc > best.sc) best = { c, sc, d };
    }
    return best;
  }
  function bigCrate(S, pl, a) {
    let best = null;
    for (let i = 0; i < S.crates.length; i++) {
      const c = S.crates[i]; if (!c.landed || c.kind !== 'weapon' || isBad(S, pl, c.id)) continue;
      const w = crateWorth(S, a, c); if (w < K.BIG_WORTH) continue;
      const d = M.len3(c.pos.x - a.pos.x, c.pos.y - a.pos.y, c.pos.z - a.pos.z);
      if (d > K.FETCH_R + bonusR(S, a, c) || Math.abs(c.pos.y - a.pos.y) > 4) continue;
      const sc = w / (d + 6); if (!best || sc > best.sc) best = { c, sc, d };
    }
    return best;
  }
  function startFetch(S, pl, a, g, keep) {
    const rot = !keep && (!SS.rotlock || SS.rotlock.allowed(S));
    const dist = M.len3(g.c.pos.x - a.pos.x, g.c.pos.y - a.pos.y, g.c.pos.z - a.pos.z);
    pl.mv = { kind: 1, st: rot ? 'align' : 'go', why: 'crate', t0: S.time, tmax: M.clamp(4 + dist / K.WALK_V, 9, 20), crate: g.c.id, goalS: 0, dir: 1, lastS: 0, stuckT: 0, jumps: 0, tChk: S.time };
    if (rot) sim().align_to_point(S, g.c.pos.x, g.c.pos.z);
    pl.phase = 'move'; return true;
  }

  // before the search of a turn: hazards, a health crate when hurt
  AB.prep = function (S, pl, a) {
    const ap = P.to_plane(S, a.pos);
    const X = xenoNear(S, a.pos.x, a.pos.y, a.pos.z, K.XENO_PAD);
    if (X) {
      let bs = null, bd = 1e9; for (const nd of X.n) { const d = M.len3(nd.x - a.pos.x, nd.y - a.pos.y, nd.z - a.pos.z); if (d < bd) { bd = d; bs = P.to_plane(S, nd).s; } }
      const dir = bs > ap.s ? -1 : 1;
      if (AB.safe_step(S, a, dir)) return startWalk(S, pl, a, ap.s + dir * (X.range + 7 - bd), 'xeno', 5);
    }
    if (S.sudden && !W().dry && SS.water) {                                  // the sea rises after every turn: climb away from it
      const surf = M.max(sim().surface_at(S, a.pos.x, a.pos.z), W().SEA), danger = surf + C.GAME.SD_RISE * 3;      // (the sea floods the low ground a little more every turn)
      if (a.pos.y - 0.5 < danger) {
        let bestS = null, bestD = 1e9;
        for (let o = -30; o <= 30; o += 1) {
          const s = ap.s + o, g = WPm().ground_below(S, s, a.pos.y + 6);
          if (g < danger + 1.5 || Math.abs(o) >= bestD || !walkable(S, ap.s, s, a.pos.y)) continue;
          bestS = s; bestD = Math.abs(o);
        }
        if (bestS != null) return startWalk(S, pl, a, bestS, 'sea', 9);
        if (pl.moves < K.MAX_MOVES && ropeStart(S, pl, a, { type: 1, s: ap.s, y: a.pos.y, dangerY: danger }, [1, -1])) { pl.moves++; return true; }
        if (SS.aic && SS.aic.escape(S, pl, a, danger)) return true;                // P38-R5: the teleport, when nothing else gets it out of the sea
      }
    }
    if (a.hp <= K.FETCH_HP && pl.moves < K.MAX_MOVES) { const g = crateGoal(S, pl, a, K.FETCH_HP); if (g) { pl.moves++; return startFetch(S, pl, a, g); } }
    /* P38-R5 (B9): a rare / super weapon crate (worth >= BIG_WORTH HP-eq) is worth more than this turn's shot (the CPU's shots average 15-35 HP): go and get it,
     * turning the section to it while the rotation is free; the turn goes on from the new spot with whatever targets are on that plane */
    if (pl.moves < K.MAX_MOVES) { const g = bigCrate(S, pl, a); if (g) { pl.moves++; return startFetch(S, pl, a, g); } }
    return false;
  };

  /* P38-R2: a shot exists but is weak (< SHOT_OK): first pick up a weapon / tool crate lying within DETOUR_R m on the shot's own
   * plane (no realign: the target stays on it; any shot: a crate within K.DETOUR_NEAR m), then search again from there. Crates were picked in 3 % of the turns. */
  AB.mark_bad = markBad; AB.is_bad = isBad;
  AB.detour = function (S, pl, a, maxD) {
    if (pl.moves >= K.MAX_MOVES || a.air || S.rope || pl.detour) return false;
    let best = null; const rot = !SS.rotlock || SS.rotlock.allowed(S);
    for (const c of S.crates) {
      if (!c.landed || c.kind === 'health' || isBad(S, pl, c.id)) continue;
      const d = M.len3(c.pos.x - a.pos.x, c.pos.y - a.pos.y, c.pos.z - a.pos.z), cp = P.to_plane(S, c.pos);
      if (d > maxD + bonusR(S, a, c) || Math.abs(c.pos.y - a.pos.y) > 3) continue;
      const on = Math.abs(cp.t) <= 1.2;                                   // on the shot's plane, or (rotation still free) a plane that has a foe on it
      if (!on && !(rot && foeOnCratePlane(S, a, c))) continue;
      if (on && !walkable(S, P.to_plane(S, a.pos).s, cp.s, a.pos.y)) continue;     // (an off-plane crate is checked after the turn to it: moveWalk 'align')
      if (!best || d < best.d) best = { c, d, sc: 1, on };
    }
    if (!best) return false;
    pl.detour = 1; pl.moves++; return startFetch(S, pl, a, best, best.on);
  };

  /* P38-R2: the retreat window after a shot: toward a crate lying on the view plane within RETREAT_R m (any kind: weapon / tool, a health
   * crate when below 80 HP), else 0. (The plane is fixed after the shot, the crate must be on it; walkable: no water / drop.) */
  // one of the worm's own shells / sheep still in flight within 8 m of that spot of the plane: the retreat must not walk into its own blast
  function shellNear(S, a, s) { for (let i = 0; i < S.proj.length; i++) { const p = S.proj[i]; if (p.owner === a.id && Math.abs(p.s - s) < 8) return true; } return false; }
  AB.retreat_crate_dir = function (S, a) {
    let best = null; const ap = P.to_plane(S, a.pos);
    for (const c of S.crates) {
      if (!c.landed || isBad(S, null, c.id) || (c.kind === 'health' && a.hp >= 80)) continue;
      const d = M.len3(c.pos.x - a.pos.x, c.pos.y - a.pos.y, c.pos.z - a.pos.z), cp = P.to_plane(S, c.pos);
      if (d > M.min(K.RETREAT_R + bonusR(S, a, c), S.retreatT > 0 ? K.WALK_V * S.retreatT : 1e9) || Math.abs(c.pos.y - a.pos.y) > 3 || Math.abs(cp.t) > 1.0 || Math.abs(cp.s - ap.s) < K.WALK_TOL) continue;
      if (!walkable(S, ap.s, cp.s, a.pos.y) || shellNear(S, a, cp.s)) continue;
      if (!best || d < best.d) best = { d, dir: cp.s > ap.s ? 1 : -1 };
    }
    return best ? best.dir : 0;
  };

  // no shot from here
  AB.reposition = function (S, pl, a) {
    if (pl.moves >= K.MAX_MOVES || a.air || S.rope) return false;
    const AIx = SS.ai, tgt = AIx.foe(S, pl, pl.fi) || (pl.foes0 && AIx.foe_of(S, pl, pl.foes0[0])); if (!tgt) return false;
    const g = crateGoal(S, pl, a, null);
    if (g && g.sc * 20 > 8 && (!SS.rotlock || SS.rotlock.allowed(S) || Math.abs(P.to_plane(S, g.c.pos).t) < 0.8)) { pl.moves++; return startFetch(S, pl, a, g); }
    const tp = P.to_plane(S, tgt.pos);
    if (Math.abs(tp.t) > 3) return false;                                     // the target is not on this section: rope / zip only work in it
    const goal = { type: 0, s: tp.s, y: tgt.pos.y, dangerY: 0 }, dir = tp.s >= P.to_plane(S, a.pos).s ? 1 : -1;
    if (canK(S, 'zipline') && zipStart(S, pl, a, goal, dir)) { pl.moves++; return true; }
    if (ropeStart(S, pl, a, goal, [dir])) { pl.moves++; return true; }
    return false;
  };

  /* ----- rope ----- */
  const RP = () => C.TRAV.ROPE;
  function hookRay(S, s0, y0, aim, dir) {
    const ds = dir * M.cos(aim), dy = M.sin(aim);
    let s = s0 + ds * 0.4, y = y0 + dy * 0.4;
    for (let d = 0.4; d < C.ROPE_MAX; d += 0.1) {
      s += ds * 0.1; y += dy * 0.1;
      if (P.solid2(S, s, y) || (S.planeBodies.length && P.body_at2(S, s, y, true) >= 0)) return { s, y, len: M.max(C.ROPE_MIN, M.len2(s - s0, y - y0)) };
      if (y < 0.2 || y > W().SY + 2) return null;
    }
    return null;
  }
  // candidates: a few spots along the walk (0 .. 10 m toward each direction, the swing needs room: a worm standing on the ledge's
  // foot would scrape the ground) x launch angles; each is a hook ray + (later, one per step) a swing simulation
  function ropeStart(S, pl, a, goal, dirs) {
    if (a.air || S.rope) return false;
    const cands = [], ap = P.to_plane(S, a.pos), g0 = WPm().ground_below(S, ap.s, a.pos.y + 0.6), lift = g0 > -1e8 ? a.pos.y - g0 : 0.5;
    for (const dir of dirs) for (let off = 0; off <= 12; off += 1) {
      const s0 = ap.s + dir * off; let y0 = a.pos.y;
      if (off > 0) { if (!walkable(S, ap.s, s0, a.pos.y)) break; const g = WPm().ground_below(S, s0, a.pos.y + 1); if (g < -1e8) break; y0 = g + lift; }
      for (let i = 0; i < 5; i++) {
        const aim = 0.45 + i * 0.2, h = hookRay(S, s0, y0, aim, dir);
        if (h && h.len >= 4 && h.y > y0 + 1.5) cands.push({ aim, dir, as: h.s, ay: h.y, len: h.len, s0, y0, off, v: -1e9, tRel: 0 });
      }
    }
    if (!cands.length) return false;
    pl.mv = { kind: 2, st: 'plan', why: 'rope', t0: S.time, tmax: 30, goal, cand: cands, ci: 0, best: null, lvMin: 0, s00: ap.s };
    pl.phase = 'move'; return true;
  }
  const lz = { s: 0, y: 0, vy: 0, wet: false, t: 0 };
  // simulate the swing of a candidate (the rope_step pendulum without bends) and the flight after each possible release
  function swingPlan(S, a, goal, c) {
    const R = RP(), ap = { s: c.s0 }, gk = sim().gravity_k ? sim().gravity_k(S, a) : 1, GW = C.G_WORM * gk, dt = 1 / 60, NS = 8, h = dt / NS;
    let s = c.s0, y = c.y0, vs = 0, vy = 0; const base = P.overlap2(S, s, y); let best = null;
    for (let i = 0; i < K.SWING_T / dt; i++) {
      const mv = Math.abs(vs) > 0.8 ? (vs > 0 ? 1 : -1) : c.dir;
      let ns = s, ny = y;
      for (let k = 0; k < NS; k++) {
        vy -= GW * h;
        let dx = ns - c.as, dy = ny - c.ay, L = M.nz(M.len2(dx, dy), 1);
        if (mv && L > c.len - 0.35) {
          let ts = -dy / L, ty = dx / L;
          if (Math.abs(ts) > 0.12) { if (ts * mv < 0) { ts = -ts; ty = -ty; } } else if (ty < 0) { ts = -ts; ty = -ty; }
          vs += ts * R.PUMP_K * C.G_WORM * h; vy += ty * R.PUMP_K * C.G_WORM * h;
        }
        const dm = M.exp(-R.DAMP * h); vs *= dm; vy *= dm;
        ns += vs * h; ny += vy * h; dx = ns - c.as; dy = ny - c.ay; L = M.len2(dx, dy);
        if (L > c.len) { ns = c.as + dx / L * c.len; ny = c.ay + dy / L * c.len; const rv = (vs * dx + vy * dy) / L; if (rv > 0) { vs -= rv * dx / L; vy -= rv * dy / L; } }
      }
      if (P.overlap2(S, ns, ny) > base + 5) return best;                      // it would scrape the ground / a wall: stop here
      s = ns; y = ny;
      if (i > 18 && i % 4 === 0 && vs * c.dir > 2) {
        landing(S, a, s, y, vs, vy, lz);
        const v = spotValue(S, goal, c.sBase, lz.s, lz.y, lz);
        if (!best || v > best.v) best = { v, tRel: i * dt };
      }
    }
    return best;
  }
  AB._swing = swingPlan; AB._landing = landing; AB._spot = spotValue;
  function moveRope(S, pl, a, inp) {
    const m = pl.mv;
    switch (m.st) {
      case 'plan': {
        if (m.ci < m.cand.length) {                                           // one candidate per step
          const c = m.cand[m.ci++]; c.sBase = m.s00; const r = swingPlan(S, a, m.goal, c);
          if (r) { c.v = r.v; c.tRel = r.tRel; if (!m.best || c.v > m.best.v) m.best = c; }
          return false;
        }
        if (!m.best || m.best.v < K.MOVE_MIN) return true;
        m.st = m.best.off > 0 ? 'approach' : 'fire'; m.lvMin = m.best.v * 0.7; return false;
      }
      case 'approach': {
        const ds = m.best.s0 - P.to_plane(S, a.pos).s, dir = ds > 0 ? 1 : -1;
        if (Math.abs(ds) < 0.3) { m.st = 'fire'; return false; }
        if (!AB.safe_step(S, a, dir) && Math.abs(ds) > 1) return true;
        inp.move = dir; return false;
      }
      case 'fire':
        S.weapon = 'rope'; S.aim = m.best.aim; a.facing = m.best.dir; inp.fire_pressed = 1; m.st = 'hook'; m.t1 = S.time; return false;
      case 'hook':
        if (S.rope && S.rope.hooked) { m.st = 'swing'; m.tAttach = S.time; }
        else if (!S.hook && S.time - m.t1 > 0.05) return true;                // the hook found nothing: give up
        return false;
      case 'swing': {
        if (!S.rope) { m.st = 'fly'; return false; }
        const t = S.time - m.tAttach, dir = m.best.dir;
        inp.move = Math.abs(a.vs) > 0.8 ? (a.vs > 0 ? 1 : -1) : dir;
        if (t >= m.best.tRel - 0.05) {
          const ap = P.to_plane(S, a.pos); landing(S, a, ap.s, a.pos.y, a.vs, a.vy, lz);
          const v = spotValue(S, m.goal, m.s00, lz.s, lz.y, lz);
          if (v >= m.lvMin || t > m.best.tRel + 2.5) {
            if (-lz.vy > 13 && canK(S, 'parachute')) S.weapon = 'parachute';   // a long fall: the canopy opens by itself when it gets fast
            inp.jump = 1; m.st = 'fly'; m.t2 = S.time;                         // (jump = let go)
          }
        }
        if (t > K.SWING_T + 3) { inp.jump = 1; m.st = 'fly'; m.t2 = S.time; }
        return false;
      }
      case 'fly':
        if (S.rope) { inp.jump = 1; return false; }
        if (!a.air && S.time - (m.t2 || m.t0) > 0.2) return true;
        return false;
    }
    return true;
  }

  /* ----- zipline ----- */
  function zipStart(S, pl, a, goal, dir) {
    if (a.air || a.walking || S.rope) return false;
    const Z = C.TRAV.ZIP, ap = P.to_plane(S, a.pos), g0 = WPm().ground_below(S, ap.s, a.pos.y + 0.6), lift = g0 > -1e8 ? a.pos.y - g0 : 0.5; let best = null;
    for (let off = 0; off <= 12; off += 1.5) {                                // from here or a few metres on (the brink of a ledge)
      const s0 = ap.s + dir * off; let y0 = a.pos.y;
      if (off > 0) { if (!walkable(S, ap.s, s0, a.pos.y)) break; const g = WPm().ground_below(S, s0, a.pos.y + 1); if (g < -1e8) break; y0 = g + lift; }
      for (let aim = -0.15; aim >= -0.95; aim -= 0.1) {
        const ds = dir * M.cos(aim), dy = M.sin(aim), ay = y0 + Z.HANG;
        let s = s0 + ds * 0.4, y = y0 + dy * 0.4, hit = null;
        for (let d = 0.4; d < Z.RANGE; d += 0.1) { s += ds * 0.1; y += dy * 0.1; if (P.solid2(S, s, y) || (S.planeBodies.length && P.body_at2(S, s, y, true) >= 0)) { hit = { s: s - ds * 0.1, y: y - dy * 0.1 }; break; } if (y < 0.2) break; }
        if (!hit) continue;
        const L = M.len2(hit.s - s0, hit.y - ay);
        if (L < Z.MIN_LEN || ay - hit.y < Z.MIN_DROP || P.solid2(S, s0, ay) || !clearLine(S, s0, ay, hit.s, hit.y)) continue;
        const gy = WPm().ground_below(S, hit.s, hit.y + 0.5);
        if (gy < -1e8 || hit.y - gy > 6 || wetAt(S, hit.s, gy + 0.3)) continue;
        const v = spotValue(S, goal, ap.s, hit.s, gy) - off * 0.3;
        if (!best || v > best.v) best = { aim, dir, v, s0, off };
      }
    }
    if (!best || best.v < K.MOVE_MIN) return false;
    pl.mv = { kind: 3, st: best.off > 0 ? 'approach' : 'fire', why: 'zip', t0: S.time, tmax: 24, best, goal };
    pl.phase = 'move'; return true;
  }
  function moveZip(S, pl, a, inp) {
    const m = pl.mv, b = m.best, z = S.zip;
    if (m.st === 'approach') {
      const ds = b.s0 - P.to_plane(S, a.pos).s, dir = ds > 0 ? 1 : -1;
      if (Math.abs(ds) < 0.3) { m.st = 'fire'; return false; }
      if (!AB.safe_step(S, a, dir) && Math.abs(ds) > 1) return true;
      inp.move = dir; return false;
    }
    if (m.st === 'fire') {
      if (a.air || a.walking) return false;
      S.weapon = 'zipline'; S.aim = b.aim; a.facing = b.dir; inp.fire_pressed = 1; m.st = 'ride'; m.t1 = S.time; return false;
    }
    if (z && z.state === 2) inp.move = b.dir;                                  // a push along the line
    if (S.time - m.t1 > 0.3 && (!z || z.state === 0 || z.state === 3) && !a.air) return true;
    return false;
  }

  /* ----- walk / fetch ----- */
  function moveWalk(S, pl, a, inp) {
    const m = pl.mv, ap = P.to_plane(S, a.pos);
    if (m.st === 'align') {
      if (S.thetaGoal != null) return false;
      const c = S.crates.find(q => q.id === m.crate); if (!c) return true;
      const cp = P.to_plane(S, c.pos);
      if (Math.abs(cp.t) > 0.9 || !walkable(S, ap.s, cp.s, a.pos.y)) { markBad(S, pl, m.crate); return true; }
      m.goalS = cp.s; m.st = 'go'; m.t0 = S.time; m.lastS = ap.s; m.tChk = S.time; return false;
    }
    if (m.kind === 1) { const c = S.crates.find(q => q.id === m.crate); if (!c) return true; if (m.st === 'go') m.goalS = P.to_plane(S, c.pos).s; }
    const ds = m.goalS - ap.s;
    if (Math.abs(ds) < K.WALK_TOL || S.time - m.t0 > m.tmax) return true;
    const dir = ds > 0 ? 1 : -1;
    if (!AB.safe_step(S, a, dir)) { if (m.kind === 1) markBad(S, pl, m.crate); return true; }
    inp.move = dir;
    if (S.time - m.tChk > 0.8) {                                               // no progress for 0.8 s: hop once or twice, then give up
      if (Math.abs(ap.s - m.lastS) < 0.25) { if (m.jumps++ >= 2) { if (m.kind === 1) markBad(S, pl, m.crate); return true; } inp.jump = 1; }
      m.lastS = ap.s; m.tChk = S.time;
    }
    return false;
  }
  AB.move = function (S, pl, a, inp) {
    const m = pl.mv; if (!m) return true;
    if (S.time - m.t0 > m.tmax + 8) return true;
    const r = m.kind === 2 ? moveRope(S, pl, a, inp) : m.kind === 3 ? moveZip(S, pl, a, inp) : moveWalk(S, pl, a, inp);
    if (r) pl.mv = null;
    return r;
  };

  // the parachute: a fall that would hurt (AI.control, every step while the worm flies free)
  AB.air = function (S, a) {
    if (!a.air || S.rope || S.weapon === 'parachute' || !canK(S, 'parachute') || a.vy > -6) return;
    const ap = P.to_plane(S, a.pos); landing(S, a, ap.s, a.pos.y, a.vs, a.vy, lz);
    if (-lz.vy > 13) S.weapon = 'parachute';
  };

  /* ---------- candidates: force field, gravity gun, sniper ---------- */
  const tmpList = [];
  AB.cands = function (S, pl, a, tgt, cands, ctx) {
    if (tgt.team === a.team) return;
    // force field: hurt or exposed to several enemies, nothing better to do
    if (canK(S, 'ffield') && SS.ffield && !S.ffields.some(f => f.state === 0 && f.team === a.team) && !a.air && P.grounded2(S, ctx.ap.s, a.pos.y) && !SS.ffield.inside(S, a.pos, 0)) {
      // P38-R2: the value is the damage the field would prevent, not a flat 14+: only enemies that can really hit us count (within 35 m,
      // clear 3D line); a fallback candidate (fb): it is used only when no shot is worth more (ai.js: giveUp / robust)
      let thr = 0; for (const o of S.worms) if (!o.dead && o.hp > 0 && o.team !== a.team && M.len3(o.pos.x - a.pos.x, o.pos.y - a.pos.y, o.pos.z - a.pos.z) < K.FF_THREAT_R && W().solid_len(o.pos.x, o.pos.y + 0.3, o.pos.z, a.pos.x, a.pos.y + 0.3, a.pos.z) < 0.5) thr++;
      if (thr >= 1 && a.hp <= 65) cands.push({ special: 'ffield', fb: 1, v: M.min(8, 2 + (100 - a.hp) * 0.06 + 1.5 * M.min(thr, 3)), aim: 0, facing: ctx.facing });
    }
    // gravity gun: a mine / barrel within reach, thrown at the target
    if (canK(S, 'gravgun') && SS.gadgets && !S.grab && !a.air) gravCand(S, pl, a, tgt, cands, ctx);
    // sniper: a long clear shot (the real bullet path incl. drop)
    if (canK(S, 'sniper') && SS.skills && ctx.dist > 12 && ctx.dist < 60) {
      const A = C.ARMS.SNIPER, out = { pts: [], hit: null }, a0 = S.aim, f0 = a.facing; let ok = null;
      a.facing = ctx.facing;
      for (let da = -0.12; da <= 0.35 && !ok; da += 0.01) {
        S.aim = ctx.aim + da; SS.skills.laser_path(S, a, 'sniper', out);
        if (out.hit && out.hit.kind === 'worm' && M.len3(out.hit.x - tgt.pos.x, out.hit.y - tgt.pos.y, out.hit.z - tgt.pos.z) < 0.7) ok = S.aim;
      }
      S.aim = a0; a.facing = f0;
      if (ok != null) cands.push({ special: 'sniper', v: M.min(tgt.hp, A.DMG) * 1.0 + (tgt.hp <= A.DMG ? 12 : 0), aim: ok, facing: ctx.facing });
    }
  };
  function gravCand(S, pl, a, tgt, cands, ctx) {
    const GD = SS.gadgets, KG = C.TOOLB.GRAV, list = GD.grabbables(S, a, tmpList); let body = null;
    for (const e of list) if ((e.b.prop === 'mine' || e.b.prop === 'barrel') && e.d < KG.RANGE - 0.5) { body = e.b; break; }
    if (!body) return;
    if ((P.to_plane(S, body.pos).s - ctx.ap.s) * ctx.facing < 0.3) return;       // it must lie on the target's side: turning round would drag it through the thrower
    // throw search: aim x power; the body flies as a point mass from the hold point to the first rock / the first worm
    const g = C.G, me = a.team; let best = null; const ap = ctx.ap;
    for (let aim = -0.3; aim <= 1.4; aim += 0.05) for (let pw = 0.3; pw <= 1.0001; pw += 0.1) {
      const v = 4 + (C.ARSENAL.gravgun.vmax || 24) * pw, ds = ctx.facing * M.cos(aim), dy = M.sin(aim);
      let s = ap.s + ds * KG.HOLD, y = a.pos.y + dy * KG.HOLD + 0.1, vs = ds * v, vy = dy * v, hitW = null, end = null;
      if (P.solid2(S, s, y)) continue;
      for (let t = 0; t < 4 && !end; t += 1 / 30) {
        vy -= g / 30; s += vs / 30; y += vy / 30;
        if (P.solid2(S, s, y)) { end = { s, y }; break; }
        if (body.prop === 'barrel') for (const o of S.worms) { if (o.dead || o === a) continue; const q = P.to_plane(S, o.pos); if (Math.abs(q.t) < 0.5 && M.len2(s - q.s, y - o.pos.y) < C.WORM_R + 0.4) { hitW = o; break; } }
        if (hitW) break;
      }
      if (!end && !hitW) continue;
      let val = 0;
      if (body.prop === 'mine') { const wp = P.to_world(S, end.s, end.y + 0.1); val = scoreAt(S, wp, C.PROPS.MINE.W, C.PROPS.MINE.DMG) * 0.7; }
      else if (hitW) { const sp = M.len2(vs, vy), ke = 0.5 * M.min(body.mass, C.BODY.HIT_MASS) * sp * sp / 1000, dmg = M.min(hitW.hp, Math.round(ke * C.BODY.HIT_PER_KJ));
        val = (hitW.team === me ? -1.6 : 1) * dmg * 0.8; }
      if (!best || val > best.v) best = { special: 'gravgun', v: val, aim, pw, facing: ctx.facing, body: body.id };
    }
    if (best) cands.push(best);
  }
  function scoreAt(S, c, Wkg, dmg) {
    const me = S.active.team; let v = 0;
    for (const o of S.worms) {
      if (o.dead) continue;
      const e = SS.blast.worm_effect(c, Wkg, o.pos, dmg), dm = M.min(o.hp, Math.round(e.dmg));
      v += o.team === me ? -(o === S.active ? 2.2 : 1.6) * dm : dm + (dm >= o.hp ? 25 : 0);
    }
    return v;
  }

  // execute a candidate of ours (true when handled)
  AB.fire = function (S, pl, a, b, d, gauss, inp) {
    const k = b.special;
    if (k === 'ffield') { S.weapon = 'ffield'; a.facing = b.facing; pl.phase = 'done'; pl.fired = { wpn: k, v: b.v, target: SS.ai.foe_wid(pl.foes[b.fi]) }; WPm().use(S, 0); return true; }
    if (k === 'sniper') {
      S.weapon = 'sniper'; a.facing = b.facing; S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.3 * (hasSkill(a, 'laser') ? 0.5 : 1), -1.5, 1.5);
      pl.phase = 'done'; pl.fired = { wpn: k, v: b.v, target: SS.ai.foe_wid(pl.foes[b.fi]) }; WPm().use(S, 0); return true;
    }
    if (k === 'gravgun') {                                                       // 1: aim at the body and grab (free), 2: wait for it to come, throw
      S.weapon = 'gravgun'; a.facing = b.facing;
      const body = S.bodies.find(q => q.id === b.body); if (!body) { pl.phase = 'endt'; return true; }
      const ap = P.to_plane(S, a.pos), bp = P.to_plane(S, body.pos), bf = bp.s >= ap.s ? 1 : -1;
      a.facing = bf; S.aim = M.atan2(body.pos.y - a.pos.y, Math.abs(bp.s - ap.s) + 1e-3);
      WPm().use(S, 0);
      if (S.grab) { pl.grav = { b, t: S.time }; pl.phase = 'grav'; pl.fired = null; }
      else pl.phase = 'endt';
      return true;
    }
    return false;
  };
  AB.grav_throw = function (S, pl, a, d, gauss) {
    const g = pl.grav; if (!g || S.time - g.t < 0.5) return false;
    const b = g.b; a.facing = b.facing; S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.5, -1.5, 1.5);
    pl.phase = 'done'; pl.fired = { wpn: 'gravgun', v: b.v, target: SS.ai.foe_wid(pl.foes[b.fi]) };
    SS.sim.fire(S, M.clamp(b.pw + gauss(S) * d.noiseP * 0.5, 0.05, 1));
    return true;
  };
})(window.SS = window.SS || {});
