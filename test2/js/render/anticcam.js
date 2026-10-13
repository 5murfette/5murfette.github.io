/* render/anticcam.js — P119b (Q-24): the antic camera. A worm's face acting (the eleven bored-worm antics of P43, the
 * pain and the daze of a hit) is unreadable at the default camera
 * (11 m: a worm is 60 px, an eye 3 px). While one plays and nobody is aiming or moving, the camera eases in on that
 * face and goes back when it is over. RENDER ONLY, a camera offset on top of the director (render/view.js interest()):
 * it reads the sim state and the view's own state, writes none of the sim, and never touches the section (S.O /
 * S.theta), so it cannot desync a lockstep game: every client decides for itself what its camera does. Two triggers:
 *   idle    the ACTIVE worm's antic is playing (render/idleview.js state PLAY: it only starts after 9-16 s of calm and
 *           any aim / walk / hit / turn change ends it at once, which is
 *           this module's "no input for a while"), the director is on that worm ('active'), the phase is play, nothing
 *           is charging / roped, no target weapon is selected (the player is looking for a point to click), the
 *           cinematic camera is not in a move (turn, kill cam, rise, victory), the overview is not on, the menu is
 *           closed, the player has not zoomed, panned or turned the section for 1.2 s and has not panned away;
 *   hurt    the director's 'hurt' visit of a worm (render/reactq.js: the camera visits the worms an attack affected,
 *           one after the other, while the player has no control) while that
 *           worm's face still shows the hit (pain or daze, render/react.js faceLeft), no shell in flight (the shells
 *           and their blasts are what the picture is about then), the worm not flying away (< 6 m/s to start, < 12 m/s
 * to hold). Result per frame (a reused struct): { k: 0 or 1 (engaged), dist: the camera distance (m) the shot wants
 * (the view takes the smaller of it and its own), dy: focus height offset (m, eased), rate: the zoom's own smoothing
 * (1/s, 0 = the view's default) }. In at 1.5 / s (an antic) or 3.5 / s (a hit), out at 7 / s for a second when the
 * PLAYER ended the antic (any input), at the view's own pace when it ran out by itself (<= 0.7 s left) or the hurt
 * visit is over. The view's pitch and focus height follow the distance (view.js closeK), so the face is seen side-on.
 * Setting: SS.anticCam.enabled (menu "Antic camera", default on; ?anticCam=0). Studio / tools: a pinned camera
 * (view.lock) switches it off. Porting: a camera-director rule; no engine types. */
(function (SS) {
  'use strict';
  const AC = SS.anticCam = {};
  const M = Math;
  AC.enabled = true;
  AC.setEnabled = v => { AC.enabled = v !== false; };
  /* the shot per antic kind (core/idle.js K): the camera distance (m) and how much higher than the head the focus sits
   * (juggled grenades fly up, the umbrella is overhead) */
  const KIND = [null,
    { d: 4.6, dy: 0.45 },    // JUGGLE
    { d: 3.9, dy: 0.05 },    // PHONE
    { d: 3.9, dy: 0.0 },     // SLEEP
    { d: 4.1, dy: 0.05 },    // WATCH
    { d: 5.0, dy: 0.2 },     // EXERCISE
    { d: 4.1, dy: 0.05 },    // MAP
    { d: 4.1, dy: 0.05 },    // SUN
    { d: 3.9, dy: 0.0 },     // SHIVER
    { d: 4.1, dy: 0.1 },     // FAN
    { d: 3.9, dy: 0.05 },    // WAVE
    { d: 4.4, dy: 0.3 }];    // UMBRELLA
  const HURT = { d: 5.4, dy: 0.1 };
  // (a hit is over in a second: its push-in is quick; a hurt shot starts only when the face will show the hit for a
  // while)
  const IN_RATE = 1.5,
    HURT_RATE = 3.5,
    OUT_RATE = 7,
    OUT_HOLD = 1.2,
    DY_RATE = 3,
    USER_HOLD = 1.2,
    PAN_MAX = 0.3,
    HURT_START = 0.4,
    SOFT_END = 0.7,
    HURT_V0 = 6,
    HURT_V1 = 12;
  const out = AC.out = { k: 0, dist: 0, dy: 0, rate: 0 };
  /* why it is (not) engaged, as a small code (no strings per frame): 0 none, 1 off, 2 pinned (or the menu is open), 3
   * overview, 4 over, 5 cine, 6 user, 7 panned, 8 free3d, 9 no worm, 10 busy, 11 no antic, 13 hurt,
   * 14 no face, 15 other interest, 20 + kind = an idle antic of that kind */
  const WHY = [
    '', 'off', 'pinned', 'overview', 'over', 'cine', 'user', 'panned', 'free3d', 'no worm', 'busy', 'no antic', '', 'hurt', 'no face',
    'interest'
  ];
  let on = 0, dyE = 0, dyT = 0, hold = 0, hurtW = -1, inRate = IN_RATE, endIn = 0, code = 0;
  // (tests / tools: what kept it off / on in the last frame)
  AC.why = () => (code >= 20 ? 'idle ' + SS.idle.NAME[code - 20] : WHY[code]);
  AC.engaged = () => on === 1;

  /* a target weapon is selected (air strike, teleport, napalm ...): the player is looking over the map for a point to
   * click, the camera stays wide */
  function pickingTarget(S) {
    const d = SS.CFG.ARSENAL[S.weapon];
    return !!d && (d.kind === 'target' || !!d.target);
  }

  /* the frame: cur = the director's interest, view = the view state, insp = the overview blend, co = the cine frame (or
   * null) */
  AC.frame = function (S, dt, cur, co, view, insp) {
    let want = 0, d = 0, dy = 0, left = 0;
    code = 0;
    if (!AC.enabled) code = 1;
    else if (view.lock || SS.view.menuOpen) code = 2;
    else if (insp > 0.02) code = 3;
    else if (S.phase === 'over') code = 4;
    else if (SS.cine && SS.cine.busy && SS.cine.busy()) code = 5;
    // (the player zoomed / panned, or turned the section, a moment ago)
    else if (view.userT < USER_HOLD || S.time - S.lastRotate < USER_HOLD) code = 6;
    else if (M.abs(view.pan.s) + M.abs(view.pan.y) > PAN_MAX) code = 7;
    else if (S.free3d && S.free3d.length) code = 8;
    else if (cur.key === 'active' && S.phase === 'play') {
      const a = S.active, IV = SS.idleView;
      if (!a || a.dead || !IV || !IV.enabled) code = 9;
      else if (S.charging || S.rope || S.hook || a.air || a.walking || pickingTarget(S)) code = 10;
      else {
        const kind = IV.antic(a);
        if (kind > 0) {
          const q = KIND[kind] || KIND[2];
          want = 1;
          d = q.d;
          dy = q.dy;
          inRate = IN_RATE;
          code = 20 + kind;
          left = IV.anticLeft(a);
        }
        else code = 11;
      }
    } else if (cur.wid != null && S.phase !== 'play' && !S.proj.length && cur.key.startsWith('hurt')) {
      const w = S.worms[cur.wid], RX = SS.reactView, face = w && RX && RX.faceLeft ? RX.faceLeft(w) : 0;
      // (a worm thrown across the map would leave a close frame at once: the focus lags 1.3 m at 6 m/s, 4 m at 20: the
      // director's wide visit follows the fast ones)
      const sp2 = w ? w.vel.x * w.vel.x + w.vel.y * w.vel.y + w.vel.z * w.vel.z : 1e9, holding = on && hurtW === (w ? w.id : -1);
      // (once it has begun, the shot lasts as long as the director's visit: the face relaxing is part of the reaction)
      if (w && !w.dead && sp2 < (holding ? HURT_V1 * HURT_V1 : HURT_V0 * HURT_V0) && (holding || face > HURT_START)) {
        want = 1;
        d = HURT.d;
        dy = HURT.dy;
        inRate = HURT_RATE;
        code = 13;
        hurtW = w.id;
        left = 0;
      } else code = 14;
    } else code = 15;
    if (want) endIn = left;
    // (it was engaged: when the player ended it the way back is quick for a second, whatever else the view does with
    // the zoom; an antic that ran out by itself, or a hurt visit that is over, lets the camera drift back at the view's
    // own pace)
    if (on && !want) hold = endIn >= 0 && endIn < SOFT_END ? 0 : OUT_HOLD;
    on = want;
    if (hold > 0) hold -= dt;
    dyT = want ? dy : 0; out.rate = want ? inRate : hold > 0 ? OUT_RATE : 0;
    dyE += (dyT - dyE) * (1 - M.exp(-dt * DY_RATE));
    if (!want && dyE < 0.005) dyE = 0;
    out.k = on; out.dist = d; out.dy = dyE;
    return out;
  };
})(window.SS = window.SS || {});
