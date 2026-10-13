/* sim/turn.js — the turn cycle and the section plane. Whose turn it is (next_turn, switch_worm), when a turn may end
 * (settled, fire_active), the retreat and the end of a turn, worms dying at the turn's end (begin_dying, step_dying,
 * die_now) and their graves, the heading of the section plane (rotate_by, align_to, align_to_point, align_next,
 * align_crate, the heading window, locked) and the match end (victory_align); time of day, team names and colours.
 * API: next_turn, switch_worm, can_switch, end_turn, end_retreat, settled, fire_active, begin_dying, step_dying,
 *   step_graves, die_now, rotate_by, align_to, align_to_point, align_next, align_crate, heading_window, clamp_heading,
 *   locked, victory_align, time_of_day, team_name, team_rgb.
 * Determinism: no RNG. */
(function (SS) {
  'use strict';
  const TN = SS.turn;
  const C = SS.CFG;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const M = SS.math;
  const P = SS.plane;
  const W = SS.world;
  const WD = C.WORM_DYN;
  const CAUSE_NAME = C.CAUSE_NAME;
  const sim = SS.sim;
  const DM = SS.damage;
  const SW = SS.swim;
  const WM = SS.worm;

  /* the time of day (settings.time: day / dusk / night, 'random' = by the seed). Sim-side: the ice temperature reads
   * it; render/view.js uses the same for the light */
  TN.time_of_day = S => {
    const t = S.settings.time;
    if (t === 'day' || t === 'dusk' || t === 'night') return t;
    if (t === 'random') return ['day', 'day', 'dusk', 'night'][(Math.imul(S.settings.seed | 0, 2654435761) >>> 7) % 4];
    return 'day';
  };

  TN.team_name = (S, t) => (S.teams && S.teams[t] ? S.teams[t].name : C.TEAMS[t].name);
  TN.team_rgb = (S, t) => (S.teams && S.teams[t] ? S.teams[t].rgb : C.TEAMS[t].rgb);
  TN.next_turn = function (S, first) {
    S.rope = null;
    S.charging = false;
    S.power = 0;
    S.proj.length = 0;
    S.retreatT = 0;
    S.resolveBack = 0;
    for (const w of S.worms) w.swimOuts = 0;
    // P1: N teams: the match ends when at most one team has a living worm (none = a draw)
    const alive = S.teams.map((t, i) => WM.living(S, i).length), standing = alive.filter(n => n > 0).length;
    if (standing <= 1) {
      S.over = alive.findIndex(n => n > 0); S.phase = PHASE.OVER;
      TN.victory_align(S);                                              // P119b: the section turns to the winners (3D)
      // (P119b: "after 1 round", not "1 rounds")
      sim.log(
        S,
        S.over >= 0
          ? `${TN.team_name(S, S.over)} win after ${S.round} round${S.round === 1 ? '' : 's'}. Press R for a new map.`
          : 'Nobody survived. Press R for a new map.',
        0xfff3b0
      );
      sim.emit(S, EV.GAMEOVER, { team: S.over, round: S.round });
      return;
    }
    if (SS.lab && SS.lab.draft_begin(S, first)) return;           // P50: the perk draft (phase 'perk'); next_turn runs again when it ends
    if (!first) SS.game.turn_change(S);
    S.teamTurn = SS.game.next_team(S);
    // never hand a turn to a worm that is swimming / sinking: the rotation goes on past it (it keeps its place in the
    // order: indexing a shorter list reordered the team); a whole team in the water: the last one tried
    const team = WM.living(S, S.teamTurn).sort((a, b) => a.id - b.id);
    let w, left = team.length;
    // (P38 R3: nextIdx[team] = the id after the worm that moved last: the next living id, wrapping; a death no longer
    // reindexes the rotation: a worm got 2 turns in 3)
    do {
      const nx = S.nextIdx[S.teamTurn] | 0;
      w = team.find(q => q.id >= nx) || team[0];
      S.nextIdx[S.teamTurn] = w.id + 1;
    } while ((w.swim || w.drowning) && --left > 0);
    // (P38 R1: a jump wind-up begun in the last moments of the turn does not outlive it)
    if (S.active) {
      S.active.aimMem = S.aim;
      S.active.windUp = 0;
    }
    if (S.active && SS.skills) SS.skills.turn_end(S, S.active);           // P37 W4: skills count their turns down
    S.active = w;
    if (SS.weaponsA && SS.weaponsA.turn_sync) SS.weaponsA.turn_sync(S);
    w.rest = false;
    S.turnNo++;
    S.hook = null;
    w.windUp = 0;
    if (SS.traverse) SS.traverse.reset(S);
    S.turnT = S.settings.turnTime > 0 ? S.settings.turnTime : 0;
    S.turnStart = S.time;
    S.selStart = S.time;
    S.acted = false;
    const tm = S.teams[w.team];
    // the team's last weapon (PoC)
    if (tm && tm.lastWeapon && C.WEAPONS[tm.lastWeapon] && SS.game.ammo(S, w.team, tm.lastWeapon) > 0) S.weapon = tm.lastWeapon;
    else if (!(SS.game.ammo(S, w.team, S.weapon) > 0)) S.weapon = 'bazooka';
    // the worm's own aim (PoC: per worm)
    S.phase = PHASE.PLAY;
    S.sectionDirty = true;
    S.lastRotate = S.time;
    S.aim = w.aimMem != null ? w.aimMem : WD.AIM0;
    if (SS.weather) {
      SS.weather.new_turn(S);
      SS.weather.turn_lightning(S);
    }
    if (SS.water && !first) SS.water.new_turn(S);
    if (SS.ice && !first) SS.ice.new_turn(S);
    focusActive(S, w);
    // a worm hanging on a kept rope: the section turns to contain the rope, the worm swings on (in-plane rope again)
    if (w.rope) {
      const r = w.rope;
      w.rope = null;
      if (M.len2(r.x - w.pos.x, r.z - w.pos.z) > 0.15) {
        S.theta = W.flat ? 0 : clamp_heading(S, M.atan2(r.z - w.pos.z, r.x - w.pos.x), S.theta);
        S.O.x = w.pos.x;
        S.O.z = w.pos.z;
      }
      const q = P.to_plane(S, r), dd = P.dir(S);
      S.rope = SS.traverse.rope_make(q.s, r.y, r.len, Math.abs(q.t) < 0.5);
      w.air = true;
      w.vs = w.vel.x * dd.x + w.vel.z * dd.z;
      w.vy = w.vel.y;
    }
    if (SS.weapons) SS.weapons.turn_start(S, first);              // P2: device lifetimes, supply drops
    if (SS.lab) SS.lab.turn_start(S, first);                      // P42: pressure clock, moon phase, underdog notice, meteors
    if (first) S.mapMinesUntil = S.time + C.ARMS.TRAPS.MAP_MINES_SEEN;   // the map's mines: seen by all, then they burrow
    SW.ensure_control(S, w);                                     // P91: whatever happened before, the worm that starts a turn can act
    sim.emit(S, EV.TURN, { wormId: w.id});
    if (!first) sim.log(S, `${TN.team_name(S, w.team)} · ${w.name}'s turn. Section aligned with ${S.target.name}.`, TN.team_rgb(S, w.team));
  };

  /* PoC worm select (setup option): in the first SELECT_T s of a turn, before the worm acts, the player may hand the
   * turn to the team's next living worm (the clock keeps running) */
  const SELECT_T = 10;
  // (selStart: the turn's start; switching restarts turnStart (rotation window) but not this)
  TN.can_switch = S => !!(
    S.settings.select
    && S.phase === PHASE.PLAY
    && S.active
    && !S.acted
    && S.time - (S.selStart != null ? S.selStart : S.turnStart) < SELECT_T
  );
  TN.switch_worm = function (S) {
    if (!TN.can_switch(S)) return false;
    // (not a swimmer: review)
    const a = S.active, team = WM.living(S, a.team).filter(o => o === a || (!o.swim && !o.drowning)).sort((p, q) => p.id - q.id);
    if (team.length < 2) return false;
    const w = team[(team.indexOf(a) + 1) % team.length];
    a.vel = { x: 0, y: 0, z: 0 }; a.rest = false;
    S.active = w;
    w.rest = false;
    S.rope = null;
    S.charging = false;
    if (SS.traverse) SS.traverse.reset(S);
    // (P38 R1: the new worm gets its own rotation window; nobody keeps a jump wind-up)
    a.windUp = 0; w.windUp = 0; S.turnStart = S.time;
    a.aimMem = S.aim; focusActive(S, w); S.aim = w.aimMem != null ? w.aimMem : WD.AIM0;
    sim.emit(S, EV.SWITCH, { wormId: w.id});
    sim.log(S, `${w.name} takes over.`, TN.team_rgb(S, w.team));
    return true;
  };
  // the section / target / momentum set-up for the worm whose turn it is (next_turn, worm select)
  function focusActive(S, w) {
    S.O.x = w.pos.x;
    S.O.z = w.pos.z;
    // P37-6: the section opens on a RANDOM worm of the strongest enemy team (sim/rotlock.js); without the module: the
    // nearest foe
    const foes = M.sort_stable(
      WM.living(S).filter(o => o.team !== w.team),
      (a, b) => M.len2(a.pos.x - w.pos.x, a.pos.z - w.pos.z) - M.len2(b.pos.x - w.pos.x, b.pos.z - w.pos.z)
    );
    S.target = SS.rotlock ? SS.rotlock.pick_start_target(S, w) || foes[0] : foes[0];
    S.theta = M.atan2(S.target.pos.z - w.pos.z, S.target.pos.x - w.pos.x);
    S.theta = clamp_heading(S, S.theta, S.theta);     // D6: a worm out in the hot sand faces a plane through the play area
    if (W.flat) S.theta = 0;                        // P68a: the 2D plane never turns (+x is to the right)
    S.thetaGoal = null; w.facing = 1; S.tgt = null;   // (a target belongs to the old plane)
    // a worm that takes over in mid-air keeps its momentum (in the new plane)
    const dd = P.dir(S), vx = w.vel ? w.vel.x : 0, vz = w.vel ? w.vel.z : 0, vy = w.vel ? w.vel.y : 0;
    w.air = !P.grounded2(S, 0, w.pos.y) || Math.abs(vy) > 0.5;
    w.vs = w.air ? vx * dd.x + vz * dd.z : 0; w.vy = w.air ? vy : 0;
  }
  function locked(S) {
    if (W.flat) return true;                        // P68a: the 2D view never turns (no message: there is nothing to wait for)
    if (S.phase === PHASE.PLACE) return false;
    // P37-6: the rotation lock (sim/rotlock.js): a free window at the turn start, then fixed
    if (S.phase === PHASE.PLAY) {
      if (!SS.rotlock || SS.rotlock.allowed(S)) return false;
      if (S.time - S.lockMsgT > 1.5) {
        S.lockMsgT = S.time;
        sim.log(S, 'View locked: rotating is only possible in the first seconds of a turn, before the worm moves.', 0xffb27a);
      }
      return true;
    }
    if (S.time - S.lockMsgT > 1.5) {
      S.lockMsgT = S.time;
      sim.log(S, 'Section locked until the attack and its aftermath resolve.', 0xffb27a);
    }
    return true;
  }
  TN.locked = locked;

  /* D6 heading window (dry worlds): a worm out on the hot sand (beyond the play circle PLAY_R about the map centre)
   * may only turn the section to planes that still cross the play circle: wrap(θ − φ) or wrap(θ − φ − π) within
   * [lo, hi], φ = heading to the centre, ±α = ±asin(PLAY_R / dist) (θ and θ + π are the same plane seen from the
   * other side; α -> 90° at the edge, so walking out never makes the heading jump). The window is WIDENED to the
   * plane through every other living worm (+ AIM_MARGIN or the worm's own angular size): a worm out there can always
   * be aimed at (user: "couldnt find any rotation angle to aim at that worm"). Inside the play circle (and on wet
   * worlds) every heading is free: null (a ROT_R 30 < PLAY_R once stopped full turns at r 30..34). */
  const AIM_MARGIN = 0.06;     // rad (3.4°) past a worm's plane, so it can be centred and passed slightly
  function heading_window(S) {
    const a = S.active;
    if (!SS.world.dry || !a) return null;
    const D = C.DRY, dx = D.CX - a.pos.x, dz = D.CZ - a.pos.z, dist = M.len2(dx, dz);
    if (dist <= S.playR) return null;
    const phi = M.atan2(dz, dx), al = M.asin(S.playR / dist);
    let lo = -al, hi = al;
    for (let q = 0; q < S.worms.length; q++) {
      const w = S.worms[q];
      if (w === a || w.dead) continue;
      const ex = w.pos.x - a.pos.x, ez = w.pos.z - a.pos.z, l = M.len2(ex, ez);
      if (l < 0.5) continue;
      let r = M.wrap_angle(M.atan2(ez, ex) - phi);                     // the plane through w, relative to φ ...
      // ... as a line: in [-90°, 90°]
      if (r > Math.PI / 2) r -= Math.PI;
      else if (r < -Math.PI / 2) r += Math.PI;
      const mg = M.max(AIM_MARGIN, M.atan(1.5 / l));
      if (r - mg < lo) lo = r - mg;
      if (r + mg > hi) hi = r + mg;
    }
    if (hi - lo >= Math.PI) return null;                                   // every plane is allowed
    return { c0: phi, c1: M.wrap_angle(phi + Math.PI), lo, hi };
  }
  /* th clamped into the window arc nearest to `from` (the current heading: rotation stops at the window's edge
   * instead of crossing forbidden headings; at a turn start from = th itself) */
  const arc_dist = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  function clamp_heading(S, th, from) {
    const w = heading_window(S);
    if (!w) return th;
    const c = arc_dist(M.wrap_angle(from - w.c0), w.lo, w.hi) <= arc_dist(M.wrap_angle(from - w.c1), w.lo, w.hi) ? w.c0 : w.c1;
    return M.wrap_angle(c + M.clamp(M.wrap_angle(th - c), w.lo, w.hi));
  }
  TN.heading_window = heading_window; TN.clamp_heading = clamp_heading;

  /* Rotate about the vertical axis through the active worm. The worm's world position is untouched. */
  TN.rotate_by = function (S, da) {
    if (locked(S) || !S.active || !da) return false;
    if (SS.traverse && SS.traverse.riding(S)) return false;            // no turning the section on a zipline
    const a = S.active, th = clamp_heading(S, M.wrap_angle(S.theta + da), S.theta);
    if (th === S.theta) return false;                 // at the edge of the heading window (D6)
    const ap = P.to_plane(S, a.pos);
    if (S.rope) {
      S.rope.s -= ap.s;
      S.rope.hooked = false;
    }
    S.tgt = null;                                     // a target is a point on the old plane: pick it again
    S.O.x = a.pos.x;
    S.O.z = a.pos.z;
    S.theta = th;
    S.lastRotate = S.time; S.sectionDirty = true;
    return true;
  };
  TN.align_to = function (S, w) {
    if (!w || w.dead || locked(S) || !S.active) return;
    // (P38 R1: the CPU's alien pseudo-targets (SS.alien.ai_foes) are no worm: the HUD / the log read name and team off
    // S.target)
    if (!w.alien) S.target = w;
    TN.align_to_point(S, w.pos.x, w.pos.z);
  };
  // turn the section (thetaGoal) so that it contains the world point (x, z)
  TN.align_to_point = function (S, x, z) {
    if (locked(S) || !S.active) return;
    let g = M.wrap_angle(M.atan2(z - S.active.pos.z, x - S.active.pos.x));
    // D6: of the two headings of that plane (g, g + π) take the one in the current window, clamped (never across
    // forbidden headings, so the turn toward the goal always arrives)
    if (heading_window(S)) {
      const g2 = M.wrap_angle(g + Math.PI), a = clamp_heading(S, g, S.theta), b = clamp_heading(S, g2, S.theta);
      g = Math.abs(M.wrap_angle(a - g)) <= Math.abs(M.wrap_angle(b - g2)) ? a : b;
    }
    S.thetaGoal = g;
  };
  /* TAB: the next OPPONENT worm (strongest team first, then its strongest worm: sim/rotlock.js); Shift+TAB: the next
   * crate, nearest first. (Before: every other worm in id order.) */
  TN.align_next = function (S, step) {
    if (locked(S) || !S.active) return;
    if (SS.rotlock) {
      const w = SS.rotlock.next_opponent(S, step);
      if (w) TN.align_to(S, w);
      return;
    }
    const others = S.worms.filter(w => !w.dead && w !== S.active);
    if (!others.length) return;
    const i = others.indexOf(S.target);
    TN.align_to(S, others[((i < 0 ? -1 : i) + step + others.length) % others.length]);
  };
  TN.align_crate = function (S) {
    if (locked(S) || !S.active || !SS.rotlock) return;
    const c = SS.rotlock.next_crate(S);
    if (c) TN.align_to_point(S, c.pos.x, c.pos.z);
  };
  /* P119b (Q-25 in 3D, "the winners outside the section are not framed"): the match is over (next_turn: one team left):
   * the section is turned so that the celebration shows as many of the
   * winners as one picture can. A winner is SHOWN when it lies in the visible slab of the thinnest slice view: t in
   * [-VIC_BACK, VIC_FRONT] (the section rule hides everything in front of the plane, the slab ends 1.5 m behind it, a
   * worm stands 0.45 m in); the shown winners FIT when they lie within VIC_FIT metres along the plane (what
   * render/view.js frames in one picture: it drops the farthest of winners that are further apart). Candidates: the
   * plane through a winner with the heading kept (the only move for a lone survivor: the plane slides along its normal)
   * and the plane through every pair of winners (their heading, of its two directions the one nearer the current
   * heading: the view keeps its side). The plane with the most fitting winners wins, then the most shown, then the one
   * that keeps the active worm (when it is a winner: the one who fired) nearest to it, then the smaller turn of the
   * heading, then the closer pair, then the lower ids (the loops run in id order and only a strictly better plane
   * replaces the best). Nothing moves when no candidate is better than the plane the match ended on (the usual case:
   * the worm that fired the last shot stands on it). Sim state (S.O, S.theta), so every peer and every replay gets the
   * same plane; once, at the end of the match, not per step. Not in 2D (the plane never turns). Returns true when the
   * plane moved. */
  const VIC_BACK = 1.4, VIC_FRONT = 0.4, VIC_FIT = 22, VIC_EPS = 1e-9;
  // a candidate plane for the victory picture: its origin and heading, then the ranking keys (best first): the winners
  // that fit in one picture, the winners it shows, the active winner's distance from it, the turn of the heading, the
  // distance of the pair that made it
  const vicCand = () => ({ ox: 0, oz: 0, th: 0, fit: 0, shown: 0, actT: 0, rot: 0, dist: 0 });
  const vicTry = vicCand(), vicBest = vicCand(), vicSv = [0, 0, 0, 0, 0, 0, 0, 0];      // (vicSv: along-plane positions, up to 8)
  // scores the plane of c: c.shown = the winners in the visible slab, c.fit = the largest group of them within VIC_FIT
  // m of each other along the plane, c.actT = the active winner's distance from it (0 when the active worm lost)
  function vicScore(c, win, act) {
    const nx = -M.sin(c.th), nz = M.cos(c.th), dx = M.cos(c.th), dz = M.sin(c.th);
    let shown = 0;
    for (let i = 0; i < win.length && shown < 8; i++) {
      const p = win[i].pos, t = (p.x - c.ox) * nx + (p.z - c.oz) * nz;
      if (t <= VIC_FRONT && t >= -VIC_BACK) {
        const s = (p.x - c.ox) * dx + (p.z - c.oz) * dz;
        let k = shown++;
        while (k > 0 && vicSv[k - 1] > s) {
          vicSv[k] = vicSv[k - 1];
          k--;
        }
        vicSv[k] = s;
      }
    }
    let fit = 0;
    for (let i = 0; i < shown; i++) {
      let j = i;
      while (j + 1 < shown && vicSv[j + 1] - vicSv[i] <= VIC_FIT) j++;
      if (j - i + 1 > fit) fit = j - i + 1;
    }
    c.shown = shown;
    c.fit = fit;
    c.actT = act < 0 ? 0 : Math.abs((win[act].pos.x - c.ox) * nx + (win[act].pos.z - c.oz) * nz);
  }
  // a strictly better victory plane: more winners fit, then more are shown, then the active winner is nearer, then the
  // heading turns less, then the pair is closer (keys within VIC_EPS count as equal)
  function vicBetter(a, b) {
    if (a.fit !== b.fit) return a.fit > b.fit;
    if (a.shown !== b.shown) return a.shown > b.shown;
    if (Math.abs(a.actT - b.actT) > VIC_EPS) return a.actT < b.actT;
    if (Math.abs(a.rot - b.rot) > VIC_EPS) return a.rot < b.rot;
    return a.dist < b.dist - VIC_EPS;
  }
  // offers candidate c: it counts only when it beats the plane the match ended on (more fit, or as many and more
  // shown); returns whether a best exists now
  function vicOffer(c, best, have, fit0, shown0) {
    if (c.fit < fit0 || (c.fit === fit0 && c.shown <= shown0)) return have;
    if (have && !vicBetter(c, best)) return have;
    best.ox = c.ox;
    best.oz = c.oz;
    best.th = c.th;
    best.fit = c.fit;
    best.shown = c.shown;
    best.actT = c.actT;
    best.rot = c.rot;
    best.dist = c.dist;
    return true;
  }
  TN.victory_align = function (S) {
    if (W.flat || !(S.over >= 0) || !S.O) return false;
    const win = WM.living(S, S.over), n = win.length;
    if (!n) return false;
    const act = win.indexOf(S.active), c = vicTry, best = vicBest;
    c.ox = S.O.x;
    c.oz = S.O.z;
    c.th = S.theta;
    vicScore(c, win, act);
    const fit0 = c.fit, shown0 = c.shown;
    let have = false;
    // the plane through winner i, heading kept
    for (let i = 0; i < n; i++) {
      c.ox = win[i].pos.x;
      c.oz = win[i].pos.z;
      c.th = S.theta;
      c.rot = 0;
      c.dist = 0;
      vicScore(c, win, act);
      have = vicOffer(c, best, have, fit0, shown0);
    }
    // the plane through winners i and j: their heading, of its two directions the one nearer the current heading
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const p = win[i].pos, q = win[j].pos, dx = q.x - p.x, dz = q.z - p.z, dist = M.len2(dx, dz);
        if (dist < 0.5) continue;
        const g = M.atan2(dz, dx),
          g2 = M.wrap_angle(g + M.PI),
          da = Math.abs(M.wrap_angle(g - S.theta)),
          db = Math.abs(M.wrap_angle(g2 - S.theta));
        c.ox = p.x;
        c.oz = p.z;
        c.th = da <= db ? g : g2;
        c.rot = M.min(da, db);
        c.dist = dist;
        vicScore(c, win, act);
        have = vicOffer(c, best, have, fit0, shown0);
      }
    if (!have) return false;
    S.O.x = best.ox;
    S.O.z = best.oz;
    S.theta = best.th;
    S.thetaGoal = null;
    S.tgt = null;
    S.lastRotate = S.time;
    S.sectionDirty = true;
    return true;
  };
  // the retreat ends (time, hurt, dead): the worm becomes a 3D body with its in-plane velocity
  TN.end_retreat = function (S) {
    S.retreatT = 0;
    const a = S.active;
    if (!a) return;
    if (SS.traverse) SS.traverse.on_end(S);                       // a worm on a zipline drops off, the parachute folds
    const dd = P.dir(S);
    a.vel = { x: dd.x * a.vs * (a.air ? 1 : 0), y: a.air ? a.vy : 0, z: dd.z * a.vs * (a.air ? 1 : 0) }; a.rest = false;
    // PoC "keep ropes between turns": a hooked worm keeps hanging (world anchor + length; body3D swings it)
    if (S.settings.keepRope && S.rope && S.rope.hooked && !a.dead) {
      const p = P.to_world(S, S.rope.s, S.rope.y);
      a.rope = { x: p.x, y: p.y, z: p.z, len: S.rope.len };
    }
    S.rope = null;
  };
  // end the turn now (input, timer, the active worm hurt): settle, then the next turn
  TN.end_turn = function (S, wait) {
    if (S.phase === PHASE.PLAY) {
      S.charging = false;
      S.power = 0;
      TN.end_retreat(S);
      S.phase = PHASE.RESOLVE;
      S.resolveT = S.time - 0.8 + (wait || 0);
    }
  };

  function settled(S) {
    if (S.pending.length) return false;
    if (
      !S.worms.every(
        w => w.dead
          || (w.swim && w.swim.jk && !SS.jacket.holds(S, w))
          || (!w.drowning && !w.swim && (w.rest || (w === S.active && !w.air) || (w.rope && M.len3(w.vel.x, w.vel.y, w.vel.z) < 0.4)))
      )
    ) return false;
    if (S.hook) return false;
    if (SS.bodies && !SS.bodies.settled(S)) return false;
    if (SS.scatter && !SS.scatter.settled(S)) return false;
    if (SS.shrapnel && !SS.shrapnel.settled(S)) return false;
    if (SS.spatter && !SS.spatter.settled(S)) return false;
    if (SS.weapons && !SS.weapons.settled(S)) return false;
    if (SS.alien && SS.alien.busy(S)) return false;                // P37: a face hugger / alien on the move
    if (fire_active(S)) return false;
    return S.fx.length === 0;
  }
  TN.settled = settled;
  /* P29 (user 2026-10-08: "the round ends before the napalm damage is done"): the turn stays open while fire can
   * still hurt: a napalm / oil / car flame burns, or a worm burned within FIRE_HOLD s (w.fireT: flames, oil, burning
   * grass ON the worm). A grass / tree fire that touches no worm does not hold it (it can creep for a long time: the
   * lockstep test waited out the 16 s cap for one). Lava and hot sand are steady hazards: they never hold the turn.
   * Bounded by the SETTLE_CAP since the last blast, like everything else. */
  const FIRE_HOLD = 0.7;
  function fire_active(S) {
    if (S.flames.length) return true;
    for (const w of S.worms)
      if (!w.dead && S.time - w.fireT < FIRE_HOLD) return true;
    return false;
  }
  TN.fire_active = fire_active;

  /* PoC dying beat (afterSettle / 'dying'): one at a time, a pending grave goes off (blood on: R 26 px = W 0.21 kg) or
   * a
   * worm at 0 HP dies with its own small blast (R 24 px = W 0.16 kg) and leaves a grave; the blast may hurt others, so
   * the aftermath settles again and the next beat (or turn) follows. */
  // PoC explode(.., 24, 16) / (.., 26, 18)
  const DIE = { BEAT: 1.1, GRAVE_BEAT: 1.0, W_WORM: M.pow(24 / 44, 3), W_GRAVE: M.pow(26 / 44, 3), D_WORM: 16, D_GRAVE: 18 };
  function beginDying(S) {
    const g = S.worms.find(w => w.dead && w.gravePending);
    if (g) {
      S.phase = PHASE.DYING;
      S.dyingW = g;
      S.dyingT = DIE.GRAVE_BEAT;
      S.dyingGrave = true;
      return true;
    }
    const d = S.worms.find(w => !w.dead && w.dying);
    if (d) {
      S.phase = PHASE.DYING;
      S.dyingW = d;
      S.dyingT = DIE.BEAT;
      S.dyingGrave = false;
      sim.emit(S, EV.DYING, { wormId: d.id});
      return true;
    }
    return false;
  }
  TN.begin_dying = beginDying;
  function stepDying(S, dt) {
    S.dyingT -= dt;
    if (S.dyingT > 0) return;
    const w = S.dyingW;
    S.dyingW = null;
    if (S.dyingGrave) {
      w.gravePending = false;
      if (w.grave) {
        w.grave.landT = -1;
        w.grave.blown = true;
      }
      if (w.grave)
        sim.explode(
          S,
          { x: w.grave.x, y: w.grave.y + 0.2, z: w.grave.z },
          { W: DIE.W_GRAVE, dmg: DIE.D_GRAVE, name: 'an exploding grave' },
          null
        );
    }
    else TN.die_now(S, w);
    S.phase = PHASE.ATTACK;
    S.attackStart = S.time;
    S.lastBoom = S.time;
    S.retreatT = 0;
  }
  TN.step_dying = stepDying;
  /* graves are small falling objects: they drop (worm gravity), land on the ground / a deck / the sea floor, sit 6 cm
   * sunk in
   * the soil, and fall again when the ground under them is blown away */
  function stepGraves(S, dt) {
    const w = W;
    for (const o of S.worms) {
      const g = o.grave;
      if (!o.dead || !g) continue;
      // P68c: graves float where the worm died
      if (S.eow) {
        SS.eow.grave(S, o, g);
        continue;
      }
      if (g.rest) {
        const df = WM.deck_floor(S, g.x, g.y + 0.1, g.z);
        if (w.sample(g.x, g.y - 0.12, g.z) > 0 || Math.abs(df - g.y) < 0.12) continue;
        g.rest = false; g.vy = 0;
      }
      const wet = g.y < sim.surface_at(S, g.x, g.z);
      g.vy = M.max(wet ? -1.5 : -45, g.vy - C.G_WORM * dt);   // the worms' (PoC) gravity: at 9.81 it looked weightless next to them
      const n = M.max(1, Math.ceil(Math.abs(g.vy) * dt / 0.05)), h = dt / n;
      for (let i = 0; i < n && !g.rest; i++) {
        const ny = g.y + g.vy * h, df = WM.deck_floor(S, g.x, g.y + 0.05, g.z);
        if (df > -1e8 && ny <= df) {
          g.y = df;
          g.rest = true;
          break;
        }
        if (w.sample(g.x, ny + 0.06, g.z) > 0 || ny < 0.3) {          // ground: settle with the base 6 cm in the soil
          let y = M.max(ny, 0.3);
          for (let k = 0; k < 40 && w.sample(g.x, y + 0.06, g.z) > 0; k++) y += 0.05;
          g.y = y; g.rest = true; break;
        }
        g.y = ny;
      }
      // landT: settled for good (no charge left on it): the plants grow from then (user: only after the grave blast)
      if (g.rest) {
        g.vy = 0;
        if (g.landT < 0 && !o.gravePending) g.landT = S.time;
      }
    }
  }
  TN.step_graves = stepGraves;         // 1/s: a shell skidding on bare sea ice slows this little (P30)
  // the dying beat's end (blood off): the PoC's small blast ('a dying worm') for the gib causes, a cause collapse
  // otherwise
  TN.die_now = function (S, w) {
    if (w.dead) return;
    const c = { x: w.pos.x, y: w.pos.y, z: w.pos.z }, gib = DM.cause_gibs(w.cause | 0) || !w.cause;
    DM.kill(S, w, gib ? 'beat' : CAUSE_NAME[w.cause]);
    if (gib) sim.explode(S, c, { W: DIE.W_WORM, dmg: DIE.D_WORM, name: 'a dying worm' }, null);
  };
})(window.SS = window.SS || {});
