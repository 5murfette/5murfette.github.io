/* platform/loop.js — the frame loop. The display's frames (requestAnimationFrame, capped by the frame-rate setting)
 * drive the fixed-step sim through an accumulator. A local game steps sim time scaled for slow motion (the moment
 * after a blow, the cinematic camera, the instant replay). A lockstep match steps in real time, and a follower also
 * catches up on queued inputs. Each frame then draws, adapts the resolution and keeps the music and the ambience in
 * step. An exception in one frame is logged and never stops the loop.
 * C: the game's update: acc += dt * scale; while (acc >= STEP) step(); render(dt). */
(function (SS) {
  'use strict';
  const C = SS.CFG, LP = SS.loop = {};
  // a frame's dt is at most MAX_DT (a background tab must not run minutes of sim at once); a lockstep frame plays at
  // most CATCH_UP steps; a blow's slow motion runs at SLOW_K in its last SLOW_S seconds; frames that come CAP_SLACK ms
  // early still count for the frame-rate cap (the display's timing jitter); at most ERRS frame errors are logged; a
  // frame longer than ADAPT_MAX_MS is a stall, not a measure of the resolution's cost
  const MAX_DT = 0.1, CATCH_UP = 60, SLOW_K = 0.35, SLOW_S = 1.5, CAP_SLACK = 2, ERRS = 5, ADAPT_MAX_MS = 250;
  let A = null, H = null, acc = 0, last = 0, errs = 0, tscale = 1, adapt = null, adaptQ = null;

  // a lockstep frame: real time, a follower behind on received inputs plays them at once
  function netSteps(dt) {
    if (A.menuOpen) return;
    acc += dt;
    for (let n = 0; A.running && n < CATCH_UP && (acc >= C.STEP || SS.session.behind()); n++) {
      if (!SS.session.step()) {
        acc = Math.min(acc, C.STEP);
        break;
      }
      acc = Math.max(0, acc - C.STEP);
    }
    SS.net.flush();
  }
  // a local frame: sim time at the replay's speed, a blow's slow motion or the cinematic camera's
  function localSteps(dt) {
    const S = A.S, replay = SS.replay.playing();
    tscale = replay ? SS.replay.speed() : S.time < (S.slowUntil || 0) && S.slowUntil - S.time < SLOW_S ? SLOW_K : 1;
    if (!replay && SS.cine) tscale = Math.min(tscale, SS.cine.timeScale());
    acc += dt * tscale;
    while (acc >= C.STEP && A.running) {
      H.step();
      acc -= C.STEP;
    }
  }
  // adaptive resolution (platform/quality.js adapt_*): the render scale follows the frame time
  function adaptDpr(ms, nowS) {
    if (!H.adapt || !A.quality || A.menuOpen || A.busy || document.hidden || ms > ADAPT_MAX_MS) return;
    if (adaptQ !== A.quality) {
      adaptQ = A.quality;
      adapt = SS.quality.adapt_make(Math.min(A.quality.dpr, window.devicePixelRatio || 1));
    }
    const r = SS.quality.adapt_frame(adapt, ms, nowS);
    if (r) SS.view.setDpr(r);
  }
  function frame(now) {
    // the next frame is requested first: an exception in this one is logged, the loop goes on
    requestAnimationFrame(frame);
    // the frame-rate cap (Display > Frame rate): a frame that comes too soon is skipped whole; the next one steps the
    // sim for all the time since the last drawn frame
    if (SS.quality.capMs > 0 && now - last < SS.quality.capMs - CAP_SLACK) return;
    const rawMs = now - last, dt = Math.min(MAX_DT, Math.max(0, rawMs / 1000));
    last = now;
    try {
      if (SS.audio && SS.audio.hold) SS.audio.hold(A.paused || A.menuOpen);
      if (SS.music) SS.music.tick(A.running && !A.busy ? A.S : null, A.paused ? 'pause' : A.menuOpen ? 'menu' : null);
      if (SS.session.apply_resync()) acc = 0;
      if (!A.running || A.busy) return;
      if (SS.session.lockstep()) netSteps(dt);
      else if (!A.paused && !A.menuOpen) localSteps(dt);
      else acc = 0;
      if (A.paused) return;
      SS.view.timeScale = A.menuOpen ? 1 : tscale;
      SS.view.menuOpen = A.menuOpen;
      H.render(dt);
      adaptDpr(rawMs, now / 1000);
    } catch (e) {
      acc = 0;
      if (errs++ < ERRS) console.error('frame error:', e && e.stack || e);
    }
  }
  /* app: main.js's app record (S, running, paused, menuOpen, busy, quality); hooks: step() one local step,
   * render(dt), adapt (adaptive resolution on) */
  LP.start = function (app, hooks) {
    A = app;
    H = hooks;
    last = performance.now();
    requestAnimationFrame(frame);
  };
})(window.SS = window.SS || {});
