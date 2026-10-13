/* sim/gear.js — P89: per-team "rescue gear": a small stock of charges per team plus an ON / OFF toggle the team's
 * player
 * sets in the HUD. The gear is used by itself (nobody presses anything) when its trigger happens, also off-turn.
 * First user: the life jacket (sim/lifejacket.js, kind JACKET). The EOW jetpack (branch p86-eow) has the same shape and
 * can take the next kind id: append a row to GR.TABLE (+ its settings keys) and call SS.gear.ready / use from its
 * trigger.
 *
 * Settings (all per match; the per-team state lives in the team struct):
 *   settings.jackets   0..9 charges every team starts with (default 3)
 *   settings.jacketOn  the toggle every team starts with (default true)
 * Team struct (game.js setup): team.gear[kind] = struct Gear { i8 n; u8 on; u16 ch; }   n = charges left, on = enabled,
 *   ch = number of changes since the start (a use or a toggle): the hash mixes the gear only once ch > 0, so a match
 *   that never touches it hashes exactly as before the feature existed.
 * Input: Input.gear = kind + 1 toggles that kind of the ACTIVE team's gear (0 = nothing); a CPU team's toggle comes
 *   from the AI plan, a human may not toggle a CPU team's gear. Event 'gear' { team, kind, on, n } (HUD pulse, a click
 * sound). C layout: struct Gear { i8 n; u8 on; u16 ch; }; Team += Gear gear[GEAR_N]; enum GearKind { GEAR_JACKET = 0 };
 * API: setup(S), get(S, team, kind), charges, enabled, ready(S, team, kind), use(S, team, kind), toggle(S, team, kind),
 *   input(S, inp), hash(S, mix).
 */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const GR = SS.gear = {};
  GR.JACKET = 0;
  /* one row per kind: id, display name, the setting with the start charges (+ max), the setting with the start toggle,
   * the default charges */
  GR.TABLE = [
    {
      id: 'jacket',
      name: 'Life jacket',
      stock: 'jackets',
      on: 'jacketOn',
      def: 3,
      max: 9,
      info: 'Inflates by itself when the worm lands in water: it floats and swims back to the shore. 6 HP per rescue.'
    }
  ];
  GR.N = GR.TABLE.length;
  const gearOf = (S, team) => {
    const t = S.teams && S.teams[team];
    return t && t.gear ? t.gear : null;
  };
  GR.setup = function (S) {
    const st = S.settings, out = [];
    for (let k = 0; k < GR.N; k++) {
      const r = GR.TABLE[k],
        v = st[r.stock],
        n = typeof v === 'number' || (typeof v === 'string' && v !== '') ? M.clamp(parseInt(v, 10) | 0, 0, r.max) : r.def;
      out.push({ n, on: st[r.on] === false || st[r.on] === 0 || st[r.on] === '0' || st[r.on] === 'off' ? 0 : 1, ch: 0 });
    }
    return out;
  };
  GR.get = (S, team, kind) => {
    const g = gearOf(S, team);
    return g && g[kind] ? g[kind] : null;
  };
  GR.charges = (S, team, kind) => {
    const g = GR.get(S, team, kind);
    return g ? g.n : 0;
  };
  GR.enabled = (S, team, kind) => {
    const g = GR.get(S, team, kind);
    return !!(g && g.on);
  };
  GR.ready = (S, team, kind) => {
    const g = GR.get(S, team, kind);
    return !!(g && g.on && g.n > 0);
  };
  GR.use = function (S, team, kind) {
    const g = GR.get(S, team, kind);
    if (!g || g.n <= 0) return false;
    g.n--; g.ch++;
    SS.sim.emit(S, EV.GEAR, { team, kind, on: g.on, n: g.n, used: 1 });
    return true;
  };
  GR.toggle = function (S, team, kind) {
    const g = GR.get(S, team, kind);
    if (!g) return false;
    g.on = g.on ? 0 : 1; g.ch++;
    SS.sim.emit(S, EV.GEAR, { team, kind, on: g.on, n: g.n, used: 0 });
    return true;
  };
  /* Input.gear: the active team's toggle (not in the placement / game over; a CPU team only through its own plan) */
  GR.input = function (S, inp) {
    const k = (inp.gear | 0) - 1;
    if (k < 0 || k >= GR.N) return;
    const a = S.active;
    if (!a || a.dead || S.phase === PHASE.OVER || S.phase === PHASE.PLACE || S.phase === PHASE.PERK) return;
    if (SS.game.is_cpu(S, a.team) && S.phase !== PHASE.PLAY) return;
    GR.toggle(S, a.team, k);
  };
  GR.hash = function (S, mix) {
    if (!S.teams) return;
    for (const t of S.teams)
      if (t.gear)
        for (let k = 0; k < t.gear.length; k++) {
          const g = t.gear[k];
          if (g.ch > 0) {
            mix(g.n * 2 + g.on);
            mix(g.ch);
          }
        }
  };
})(window.SS = window.SS || {});
