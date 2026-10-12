/* render/reactq.js — P85: who may speak, and where the camera goes after an attack (presentation only, never writes sim state).
 *
 * Rules (user 2026-10-12: "only the currently playing worm can say things, and after the attack only worms affected by the attack
 * can say something back, and camera should go to them"):
 *   - the ACTIVE worm speaks for itself (turn opener, aim / fire lines, hop, pass, pickup): platform/audio.js AU.voice and ui/hud.js
 *     say() pass those straight through when the speaker is S.active, and drop them for everybody else (bystanders are silent);
 *   - AFFECTED worms (hurt, killed, knocked about, washed off, shocked) do not speak when the event arrives: they are submitted here.
 *     A short window (WINDOW) collects the whole blast, then the lines play ONE AT A TIME (no overlapping voices), the most dramatic
 *     first (prio 3 death > 2 big damage > 1 small damage / burn / dizzy), at most MAXV lines per attack, and a worm that already spoke
 *     in this turn is not heard again unless its new line is more dramatic;
 *   - the camera visits the speaker of each line while it speaks (visit(): the director's 'hurt' / 'death' interest), in the same order,
 *     for SLOT seconds each, only while the player has no control (S.phase !== 'play'), then the next turn's camera takes over;
 *   - the active worm hurt while it still has control (a mine, a flame) speaks at once and the camera does not move.
 * Listeners (audio, HUD bubbles) are called with (S, item) at the moment a line starts. RQ.log keeps the lines spoken (tests). */
(function (SS) {
  'use strict';
  const RQ = SS.reactq = {};
  const WINDOW = 0.6, SLOT = 1.4, MAXV = 2, IDLE = 2.5, DIRECT_GAP = 0.6;
  let clock = 0, pending = [], slot = null, spoken = 0, batchT = -1, lastEnd = -99;
  const said = new Map(), direct = new Map(), lis = [];
  RQ.WINDOW = WINDOW; RQ.SLOT = SLOT; RQ.MAXV = MAXV;
  RQ.log = []; RQ.dropped = 0;
  RQ.listen = fn => { lis.push(fn); };
  RQ.reset = function () { pending.length = 0; slot = null; spoken = 0; batchT = -1; lastEnd = -99; said.clear(); direct.clear(); };
  RQ.busy = () => !!slot || pending.length > 0;
  function speak(S, it, how) {
    RQ.log.push({ t: clock, st: S.time, wid: it.wid, id: it.id, kind: it.kind, prio: it.prio, how });
    if (RQ.log.length > 400) RQ.log.splice(0, 200);
    for (let i = 0; i < lis.length; i++) lis[i](S, it);
  }
  /* it: { id: audio line or null, kind: speech-bubble kind or null, vol, prio 0..3, cam: the camera may visit, amt } */
  RQ.submit = function (S, w, it) {
    if (!w || !S) return false;
    it.wid = w.id; if (it.vol == null) it.vol = 1; if (it.prio == null) it.prio = 1;
    const have = said.get(w.id);
    if (have != null && it.prio <= have) { RQ.dropped++; return false; }                 // already heard from this worm this turn
    if (S.active && w.id === S.active.id && S.phase === 'play') {                           // the player's own worm: at once, no camera
      const l = direct.get(w.id); if (l != null && clock - l < DIRECT_GAP) { RQ.dropped++; return false; }
      direct.set(w.id, clock); said.set(w.id, it.prio); speak(S, it, 'direct'); return true;
    }
    for (let i = 0; i < pending.length; i++) if (pending[i].wid === w.id) {             // one line per worm: the more dramatic wins
      if (it.prio >= pending[i].prio) pending[i] = it; return true;
    }
    if (slot && slot.item.wid === w.id) return false;
    pending.push(it); if (batchT < 0) batchT = clock; return true;
  };
  RQ.onEvent = function (S, e) {
    const w = e.worm, C = SS.CFG;
    if (e.type === 'turn' || e.type === 'reset') { RQ.reset(); return; }
    if (!w) return;
    switch (e.type) {
      case 'hurt': {
        const lethal = w.hp <= 0 || w.dead, fx = C.DS_FLAGS[e.src | 0] || 0;
        if (e.dot && !lethal) { if (fx & C.DSF.FX_HOT) RQ.submit(S, w, { id: 'worm_burn', kind: 'hot', vol: 0.9, prio: 1, cam: false, amt: e.amount }); break; }
        if (!lethal && !(e.amount >= 3)) break;
        const id = lethal && e.src === C.DS.DROWNING ? 'worm_drown' : e.src === C.DS.BAT ? 'worm_bat_hit' : (fx & C.DSF.FX_HOT) ? 'worm_burn' : (lethal || e.amount >= 25) ? 'worm_hurt_big' : 'worm_hurt_small';
        RQ.submit(S, w, { id, kind: lethal ? 'die' : (fx & C.DSF.FX_HOT) ? 'hot' : 'ouch', vol: 1, prio: lethal ? 3 : e.amount >= 25 ? 2 : 1, cam: true, amt: e.amount });
        break; }
      case 'dying': RQ.submit(S, w, { id: 'worm_dying', kind: 'die', vol: 1, prio: 3, cam: false, amt: 99 }); break;
      case 'wash': RQ.submit(S, w, { id: 'worm_wash', kind: 'wash', vol: 0.9, prio: 1, cam: true, amt: 1 }); break;
      case 'dizzy': RQ.submit(S, w, { id: 'worm_dizzy', kind: null, vol: 0.9, prio: 1, cam: false, amt: 1 }); break;
      case 'zap': if (!w.dead) RQ.submit(S, w, { id: null, kind: 'shock', vol: 1, prio: 1, cam: true, amt: 1 }); break;
    }
  };
  RQ.frame = function (S, dt) {
    clock += Math.min(dt || 0, 0.1);
    if (slot && clock - slot.t0 >= SLOT) { slot = null; lastEnd = clock; }
    if (!slot && pending.length) {
      if (spoken >= MAXV) { RQ.dropped += pending.length; pending.length = 0; }
      else if (clock - batchT >= WINDOW) {
        let bi = 0;
        for (let i = 1; i < pending.length; i++) { const a = pending[i], b = pending[bi]; if (a.prio > b.prio || (a.prio === b.prio && (a.amt || 0) > (b.amt || 0))) bi = i; }
        const it = pending.splice(bi, 1)[0];
        slot = { item: it, t0: clock }; spoken++; said.set(it.wid, it.prio); speak(S, it, 'queue');
      }
    }
    if (!slot && !pending.length && batchT >= 0 && clock - lastEnd > IDLE) { batchT = -1; spoken = 0; }
  };
  /* the worm the camera should be looking at now (null: none): { id, dead } */
  RQ.visit = function (S) {
    if (!slot || !slot.item.cam || S.phase === 'play') return null;
    return { id: slot.item.wid, dead: !!(S.worms[slot.item.wid] && S.worms[slot.item.wid].dead) };
  };
})(window.SS = window.SS || {});
