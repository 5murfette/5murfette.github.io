/* sim/rotlock.js — the rotation lock (setting `rotLock`, default ON) and the section-aiming rules. Portable,
 * deterministic: only S state, S.rng (the sim stream) and the fixed step.
 * Rule (free rotation would make obstacles too easy to pass): a turn opens with the section aimed at a
 * RANDOM worm of the enemy team with the highest total HP (the classic idea: aim at the strongest enemy; the active
 * player's own team never counts, so when it is the strongest the opponent team with the highest HP is used). The
 * player may rotate for C.ROT_WINDOW s (the HUD shows a "ROTATE NOW" countdown); the view is fixed for the rest of the
 * turn as soon as the window is over or the worm moves / acts (S.acted). rotLock OFF, or the skill w.skills.freerot > 0
 * (tool crate), = free rotation all turn. The deployment phase is always free.
 * Everything derives from sim state (S.turnStart, S.acted, S.time, the setting): lockstep multiplayer and replay see
 * the same decisions; the CPU (ai.js) asks allowed() / left() like a human.
 * TAB = the next OPPONENT worm (teams by total HP, then worms by HP: highest first); Shift+TAB = the next crate,
 * nearest first (input align_step / align_crate; sim.align_next / sim.align_crate); both only while rotation is
 * allowed. Worm select (setting `select`, sim.can_switch) moved off TAB to the backslash key (every letter is taken by
 * a weapon / move key; platform/input.js). API: enabled(S), free(S), allowed(S), left(S) (s of the window left, -1 = no
 *      countdown: free / over), opponents(S, w) (sorted list), pick_start_target(S, w),
 * next_opponent(S, step), next_crate(S). C layout: no new state; reads struct Game { f32 time, turnStart; bool acted;
 *   Worm *active, *target; Settings.rotLock }. S.crateSel (i32 crate id, -1 none) is the Shift+TAB cursor. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const PHASE = C.PHASE;
  const RL = SS.rotlock = {};

  RL.enabled = S => !SS.world.flat && S.settings.rotLock !== false && S.settings.rotLock !== 0 && S.settings.rotLock !== 'off';
  RL.free = S => !RL.enabled(S) || !!(S.active && S.active.skills && S.active.skills.freerot > 0);
  RL.allowed = S => {
    if (S.phase === PHASE.PLACE) return true;
    if (RL.free(S)) return true;
    return !S.acted && S.time - S.turnStart < C.ROT_WINDOW;
  };
  RL.left = S => {
    if (S.phase !== PHASE.PLAY || !S.active || RL.free(S) || S.acted) return -1;
    const l = C.ROT_WINDOW - (S.time - S.turnStart);
    return l > 0 ? l : -1;
  };

  // the living enemy worms of w: the team with the highest total HP first, inside it the worm with the highest HP
  RL.opponents = (S, w) => {
    const out = [];
    for (const o of S.worms)
      if (!o.dead && o.hp > 0 && o.team !== w.team) out.push(o);
    const th = [];
    for (let t = 0; t < S.teams.length; t++) th.push(SS.worm.team_hp(S, t));
    out.sort((p, q) => (th[q.team] - th[p.team]) || (p.team - q.team) || (q.hp - p.hp) || (p.id - q.id));
    return out;
  };
  // turn start: a random worm of the strongest enemy team
  RL.pick_start_target = (S, w) => {
    const list = RL.opponents(S, w);
    if (!list.length) return null;
    const team = list[0].team;
    let n = 0;
    while (n < list.length && list[n].team === team) n++;
    return list[M.rng_int(S.rng, n)];
  };
  RL.next_opponent = (S, step) => {
    const a = S.active;
    if (!a) return null;
    const list = RL.opponents(S, a);
    if (!list.length) return null;
    const i = list.indexOf(S.target);
    return list[((i < 0 ? (step > 0 ? -1 : 0) : i) + (step || 1) + list.length * 2) % list.length];
  };
  RL.next_crate = S => {
    const a = S.active;
    if (!a || !S.crates || !S.crates.length) return null;
    const list = S.crates.slice()
      .sort((p, q) => M.len2(p.pos.x - a.pos.x, p.pos.z - a.pos.z) - M.len2(q.pos.x - a.pos.x, q.pos.z - a.pos.z) || p.id - q.id);
    let i = -1;
    for (let k = 0; k < list.length; k++)
      if (list[k].id === S.crateSel) i = k;
    const c = list[(i + 1) % list.length];
    S.crateSel = c.id;
    return c;
  };
})(window.SS = window.SS || {});
