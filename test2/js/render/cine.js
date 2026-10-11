/* render/cine.js — P63 cinematic camera layer (render only: nothing here is read by js/sim, nothing enters the hash).
 * The camera director (view.js interest()) decides WHAT the camera looks at; this module adds the MOVES on top of it:
 *   turn move   a 0.5-0.75 s ease-in-out travel from the previous focus to the new active worm (a small pull-back arc)
 *   hit punch   a short (0.3 s) slow motion + slight push-in when a blast hurts a worm
 *   kill cam    (the dying beat / a drowning) a 1.7 s push-in with a small dutch angle and orbit, slowed at first, when a worm dies from a hit
 *   rise        a pull-back that looks down at the waterline when sudden death raises the sea
 *   victory     a slow orbit around the winning team
 *   air strike  a gentle orbit drift while the plane flies over
 * Everything is skippable: any key / pointer press / wheel calls skip() and the camera is the player's again at once.
 * Slow motion only scales the render clock and the pace at which main.js feeds the fixed sim step (never the step itself),
 * and never runs online (each client's camera is local) or during an instant replay.
 * out (per frame): k = distance factor, yaw / roll = radians, dy = focus height offset. */
(function (SS) {
  'use strict';
  const CN = SS.cine = {};
  CN.enabled = true;
  const M = Math;
  const cl = (x, a, b) => (x < a ? a : x > b ? b : x);
  const ease = x => { x = cl(x, 0, 1); return x * x * (3 - 2 * x); };
  const out = { k: 1, yaw: 0, roll: 0, dy: 0 };
  const turn = { on: false, t: 0, dur: 0.6, x: 0, y: 0, z: 0, dist: 0 };
  const slow = { t: 0, f: 1, ramp: 0 };
  const kill = { t: -1, side: 1 };
  const punch = { t: -1 };
  const rise = { t: -1 };
  let styleYaw = 0, vicT = -1, vicSkip = false, cool = 0, seaLast = null, turnNo = -1;
  const KILL_T = 1.7, PUNCH_T = 0.45, RISE_T = 2.2, TURN_MIN_DIST = 3.5;

  CN.setEnabled = function (v) { CN.enabled = v !== false; if (!CN.enabled) CN.reset(); };
  CN.reset = function () { turn.on = false; slow.t = 0; kill.t = -1; punch.t = -1; rise.t = -1; styleYaw = 0; vicT = -1; vicSkip = false; cool = 0; seaLast = null; };
  /* the player does anything: the camera is theirs at once (the director's exponential follow takes over from where it is) */
  CN.skip = function () { turn.on = false; slow.t = 0; kill.t = -1; punch.t = -1; rise.t = -1; if (vicT >= 0) vicSkip = true; };
  if (typeof addEventListener === 'function') for (const ev of ['keydown', 'pointerdown', 'wheel']) addEventListener(ev, () => CN.skip(), { capture: true, passive: true });

  /* main.js: the pace of the fixed sim step while the camera dwells on a hit (1 = real time) */
  CN.timeScale = function () {
    if (!CN.enabled || slow.t <= 0) return 1;
    if (SS.net && SS.net.active && SS.net.started) return 1;
    return slow.f;
  };
  CN.turnDelay = () => (turn.on ? turn.dur * 0.3 : 0);
  CN.moving = () => turn.on;
  CN.victory = () => CN.enabled && vicT >= 0 && !vicSkip;

  /* view.js onEvents(S, e) (the view's clock: events arrive once per frame, in step order) */
  CN.onEvent = function (S, e, cam) {
    if (e.type === 'reset') { CN.reset(); return; }
    if (e.type === 'land' && e.worm && e.speed > 12) {                      // a heavy fall: a small kick, whatever the option says (P58 shake)
      const dist = cam.focusDist(e);
      if (SS.fx && SS.fx.addShake) SS.fx.addShake(cl((e.speed - 12) * 0.03, 0.05, 0.3) * M.max(0.25, 1 - dist / 40));
    }
    if (!CN.enabled) return;
    if (e.type === 'turn' && e.worm && S.turnNo !== turnNo) {
      turnNo = S.turnNo; kill.t = -1; punch.t = -1;
      const c = cam.camT();
      if (c) {
        const d = M.hypot(e.worm.pos.x - c.x, e.worm.pos.y + 1.2 - c.y, e.worm.pos.z - c.z);
        if (d > TURN_MIN_DIST) { turn.on = true; turn.t = 0; turn.x = c.x; turn.y = c.y; turn.z = c.z; turn.dist = d; turn.dur = cl(0.5 + d * 0.008, 0.5, 0.75); }
      }
    }
    if (e.type === 'hurt' && !e.dot && e.worm && e.amount >= 18 && S.phase !== 'play' && cool <= 0 && !(S.free3d && S.free3d.length)) {
      punch.t = 0; cool = 2.2;
      if (slow.t <= 0 || slow.f > 0.45) { slow.t = 0.32; slow.f = 0.42; slow.ramp = 0.12; }
    }
    if ((e.type === 'kill' || e.type === 'dying') && e.worm && S.phase !== 'play' && e.how !== 'gib' && (e.how || '') !== 'eaten' && kill.t < 0) {
      kill.t = 0; kill.side = (e.worm.id & 1) ? 1 : -1; punch.t = -1;
      slow.t = 0.7; slow.f = 0.5; slow.ramp = 0.3;
    }
  };

  /* per frame (view.render, real dt): updates the envelopes, returns the offsets. cur = the director's interest key */
  CN.frame = function (S, dtU, key, cam) {
    out.k = 1; out.yaw = 0; out.roll = 0; out.dy = 0;
    if (!CN.enabled) return out;
    cool -= dtU;
    if (slow.t > 0) slow.t -= dtU;
    if (turn.on) { turn.t += dtU; if (turn.t >= turn.dur || key !== 'active') turn.on = false; }
    if (punch.t >= 0) { punch.t += dtU; if (punch.t > PUNCH_T) punch.t = -1; else out.k *= 1 - 0.1 * M.sin(M.PI * punch.t / PUNCH_T); }
    if (kill.t >= 0) {
      kill.t += dtU;
      if (kill.t > KILL_T) kill.t = -1;
      else {
        const t = kill.t, env = ease(t / 0.4) * (1 - ease((t - (KILL_T - 0.55)) / 0.55));
        out.k *= 1 - 0.36 * env; out.roll += 0.055 * env * kill.side; out.yaw += 0.22 * env * kill.side * (0.6 + 0.4 * t / KILL_T);
      }
    }
    if (S.phase === 'over' && S.over >= 0) { if (vicT < 0) { vicT = 0; vicSkip = false; } vicT += dtU; } else { vicT = -1; vicSkip = false; }
    if (vicT >= 0 && !vicSkip) { const e = ease(vicT / 1.4); out.k *= 1 - 0.22 * e; out.yaw += e * 0.6 * M.sin(vicT * 0.45); out.dy += 0.4 * e; }
    const W = SS.world;
    if (W && !W.under) {
      if (seaLast != null && W.SEA > seaLast + 0.15 && S.sudden && rise.t < 0) rise.t = 0;
      seaLast = W.SEA;
    }
    if (rise.t >= 0) {
      rise.t += dtU;
      if (rise.t > RISE_T) rise.t = -1;
      else { const env = ease(rise.t / 0.5) * (1 - ease((rise.t - (RISE_T - 0.8)) / 0.8)); out.k *= 1 + 0.14 * env; out.dy -= 1.6 * env; }
    }
    const want = key === 'plane' ? 0.16 : key === 'strike' ? 0.06 : 0;
    styleYaw += (want - styleYaw) * (1 - M.exp(-dtU * 1.6));
    out.yaw += styleYaw;
    out.yaw = cl(out.yaw, -0.9, 0.9);
    return out;
  };
  /* the turn move: where the camera focus is while it travels (null when no move runs) */
  CN.turnPos = function (tx, ty, tz, o) {
    if (!turn.on) return null;
    const e = ease(turn.t / turn.dur);
    o.x = turn.x + (tx - turn.x) * e; o.y = turn.y + (ty - turn.y) * e; o.z = turn.z + (tz - turn.z) * e;
    out.k *= 1 + 0.1 * M.sin(M.PI * cl(turn.t / turn.dur, 0, 1)) * cl(turn.dist / 25, 0.3, 1);
    return o;
  };
  CN.state = () => ({ turn: turn.on, slow: slow.t, kill: kill.t, punch: punch.t, rise: rise.t, vic: vicT, enabled: CN.enabled });
})(window.SS = window.SS || {});
