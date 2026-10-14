/* platform/replay.js — the instant replay: an attack that kills two or more worms, or the blow that ends the match, is
 * shown again in slow motion. While the worm aims, the deterministic state is snapshot (sim.snapshot: S and the voxel
 * world) every 2 s of sim time and every step's input recorded after it. When the next turn begins and enough worms
 * died, the end state is kept aside, the snapshot restored, the steps before the attack re-run unseen, and the rest
 * played back at 0.5 x (0.4 x for a final blow) under a banner; Space / Enter / Esc or a click skips. Then the end
 * state comes back. Local games only: a lockstep game would have to pause every peer.
 * C: struct Replay { Snapshot *snap; Input *inputs; int n, turn, at, killAt, dead0, deadN, lastKill; u8 armed,
 * final; Playback *play; }; replay_watch / replay_record / replay_step, the view refresh a callback. */
(function (SS) {
  'use strict';
  const C = SS.CFG, PHASE = C.PHASE, RY = SS.replay = {};
  // the snapshot is renewed every SNAP_S of aiming; a replay shows at most LEAD steps (3 s) before the second kill, up
  // to TAIL steps (1.5 s) after it, and records at most MAX_STEPS (2 min); a final blow FIN_LEAD / FIN_TAIL steps
  // (1.8 s / 1.2 s) and never the last FIN_CUT steps that made the match over
  const SNAP_S = 2, LEAD = 360, TAIL = 180, FIN_LEAD = 216, FIN_TAIL = 144, FIN_CUT = 3, MAX_STEPS = 120 * 60;
  const R = {
    snap: null, snapT: 0, inputs: null, turn: -1, armed: false, at: 0, killAt: -1, dead0: 0, deadN: 0, lastKill: -1,
    final: false, play: null
  };
  let refresh = null;
  // refresh(): the presentation after a snapshot is loaded (main.js: the view's actors, the HUD, the camera)
  RY.init = fn => { refresh = fn; };
  // the fatal moment is 0 HP (the dying beats come later); reserve worms never count
  const deadCount = S => S.worms.reduce((n, w) => n + ((w.dead || w.hp <= 0) && !w.reserve ? 1 : 0), 0);
  // a new world or a reset: nothing recorded, nothing playing
  RY.clear = () => {
    R.snap = R.inputs = R.play = null;
    R.armed = false;
  };
  RY.playing = () => R.play !== null;
  // the playback speed (1 when no replay is playing)
  RY.speed = () => (R.play ? R.play.slow : 1);
  // the playback position { i, n } for the tools, or null
  RY.progress = () => (R.play ? { i: R.play.i, n: R.play.inputs.length } : null);
  // before a local step: a fresh snapshot while the worm aims (every SNAP_S, or at a new turn), until the attack starts
  RY.watch = function (S) {
    if (S.phase !== PHASE.PLAY || (R.snap && (R.armed || (R.turn === S.turnNo && S.time - R.snapT <= SNAP_S)))) return;
    R.snap = SS.sim.snapshot(S);
    R.snapT = S.time;
    R.inputs = [];
    R.dead0 = R.deadN = deadCount(S);
    R.lastKill = -1;
    R.final = false;
    R.turn = S.turnNo;
    R.armed = false;
    R.at = 0;
  };
  /* after a local step with input inp: record it, arm at the attack, note the kills; at the next turn (or the match's
   * end) start the replay when it is worth one. true = a replay started. */
  RY.record = function (S, inp) {
    if (!R.snap) return false;
    R.inputs.push(Object.assign({}, inp));
    if (!R.armed && S.phase !== PHASE.PLAY && S.turnNo === R.turn) {
      R.armed = true;
      R.at = R.inputs.length - 1;
      R.killAt = -1;
    }
    const dead = deadCount(S);
    if (R.armed && R.killAt < 0 && dead - R.dead0 >= 2) R.killAt = R.inputs.length;
    if (R.armed && dead > R.deadN) {
      R.deadN = dead;
      R.lastKill = R.inputs.length;
    }
    if (S.turnNo === R.turn && S.phase !== PHASE.OVER) return false;
    const nd = dead - R.dead0, fin = S.phase === PHASE.OVER && S.over >= 0 && nd >= 1 && R.lastKill > 0;
    if (R.armed && (nd >= 2 || fin) && R.inputs.length < MAX_STEPS) {
      R.final = fin;
      if (fin) R.killAt = R.lastKill;
      start(S);
      return true;
    }
    R.snap = R.inputs = null;
    return false;
  };
  // the end state aside, the snapshot back, the lead-in re-run unseen, the playback armed
  function start(S) {
    const end = SS.sim.snapshot(S), fin = R.final;
    SS.sim.restore(S, R.snap);
    refresh();
    if (R.killAt > 0) R.at = Math.max(R.at, R.killAt - (fin ? FIN_LEAD : LEAD));
    for (let i = 0; i < R.at; i++) SS.sim.step(S, R.inputs[i], C.STEP);
    S.events.length = 0;
    const last = R.killAt > 0 ? Math.min(R.inputs.length - (fin ? FIN_CUT : 0), R.killAt + (fin ? FIN_TAIL : TAIL)) : R.inputs.length;
    R.play = { inputs: R.inputs.slice(0, last), i: R.at, end, slow: fin ? 0.4 : 0.5 };
    R.snap = R.inputs = null;
    SS.sim.emit(S, C.EV.BANNER, { title: fin ? 'Final blow' : 'Instant replay', sub: 'slow motion · Space skips' });
  }
  // the end state back; a match that ended gets its fanfare again (its event went with the replayed queue)
  function finish(S) {
    SS.sim.restore(S, R.play.end);
    R.play = null;
    refresh();
    S.events.length = 0;
    if (S.phase === PHASE.OVER) SS.sim.emit(S, C.EV.GAMEOVER, { team: S.over, round: S.round });
  }
  // one playback step; skip: the player asked to skip (the playback ends at once)
  RY.step = function (S, skip) {
    const p = R.play;
    if (skip || p.i >= p.inputs.length) finish(S);
    else SS.sim.step(S, p.inputs[p.i++], C.STEP);
  };
})(window.SS = window.SS || {});
