/* render/jumpview.js — P112: the choreography of the worm's own jumps (render only: a function of the sim worm's flags
 * and velocity; nothing here is in S).
 *
 *   FORWARD JUMP  (sim: Enter -> a.windUp = S.time + JUMP_WIND, the worm stands still and springs when it ends; the
 *   wind-up IS a sim state, so the time counts
 *                  for the turn and for the AI; jump_vs makes the whole cycle as fast as walking the same distance)
 *     anticipation  wind 0..1: the body coils back (lower, wider, an extra S in the neck, leaning back) in the first
 *                   half, then holds the tension
 *     spring        the first 0.14 s of the flight: the body is straight along the launch direction, stretched thin
 *                   (squash and stretch); the pose swings from
 *                   "leaning back" to "along the velocity" in a few frames, the jelly tail lags and whips after it
 *     arc           the neck re-bends a little at the top (a soft tuck), the nose follows the velocity (0.8 of its
 *                   angle)
 *     landing       a squash that recovers without overshoot (no wobble), the jelly solver adds the crumple of the
 *                   impact
 *   BACK FLIP     (sim: Backspace = a back hop, a second Backspace while it rises = the salto: higher; both set a.hop /
 *   a.flip)
 *     a REAL rotation, 360 degrees about the body's side axis, backwards: the frame angle phi(t) is integrated with an
 *     acceleration limit and a brake so that it is complete about 0.14 s before the predicted landing (time to go from
 *     vy and the height above the take-off point: a ceiling hit shortens it, the rate adapts), in the same step the
 *     body tucks into a ball (curvature of the spine), opens again and lands upright. The solver gets the frame
 *     (in.extTh, extW = 1) AND the rate (in.spin), so the nodes really rotate; the camera / label do not follow it
 *     (they ride the sim position). Early landing (a ledge, a worm below): the rest of the rotation goes to the NEAREST
 *   whole turn within ~0.2 s on the ground; water / rope / burning end it at once. Space (End of the World): no soft
 * solver; the flip angle goes to the root's local z rotation (the worm's own side axis) in eowview.orient. Porting: one
 * JumpState per worm; pure functions of (S, worm, dt). */
(function (SS) {
  'use strict';
  const M = SS.math, C = SS.CFG, WD = C.WORM_DYN, JV = SS.jumpView = {};
  const TAU = Math.PI * 2,
    K = JV.K = {
      // anticipation: share of the wind-up spent coiling, the pose at full coil
      COIL_T: 0.55, COIL_SY: 0.74, COIL_SX: 0.12, COIL_LEAN: -0.4, COIL_STR: -0.25, HOLD_SY: 0.06,
      // the spring: duration, straightness, stretch
      SPRING_T: 0.14, SPRING_STR: 0.85, SPRING_SY: 0.14, SPRING_SX: -0.09,
      // flight: nose along the velocity (weight, share of its angle)
      FLY_W: 1, FLY_A: 0.8, FLY_STR: 0.7, FIRM: 1.7,
      // flip: finish this long before landing; accel / brake rad/s^2, max rate
      OPEN_T: 0.14, ACC: 140, BRAKE: 90, WMAX: 18,
      // landing squash (jump, flip), how fast it goes down (ramp s), recovery rate (1/s)
      LAND_J: 0.2, LAND_F: 0.26, LAND_UP: 0.08, LAND_DN: 9
    };
  const R = {
    act: 0, sx: 1, sy: 1, oy: 0, lean: 0, curl: 0, str: 0, fly: false, fa: 0, fw: 0, flip: false, firm: 1, wf: 0, ang: 0, om: 0, loc: 0
  };
  JV.R = R;
  const ss = (a, b, x) => {
    const t = M.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const st = v => v.jv
    || (
      v.jv = {
        air: 0, kind: 0, tl: 0, wind: 0, y0: 0, s0: 0, fAt: null, on: 0, phi: 0, om: 0, tgt: 0, nrev: 1, land: 9, landK: 0, wf: 0, base: 0,
        v0: 0, g: 0
      }
    );

  /* c = { air, f, s (plane s), vs, vy (plane velocity), slope, lean, hang, swim, burn }. Returns R (shared, valid until
   * the next call). */
  JV.pose = function (S, w, v, dt, c) {
    const J = st(v);
    dt = M.clamp(dt, 0, 0.05);
    R.act = 0;
    R.sx = 1;
    R.sy = 1;
    R.oy = 0;
    R.lean = 0;
    R.curl = 0;
    R.str = 0;
    R.fly = false;
    R.flip = false;
    R.firm = 1;
    R.wf = 0;
    R.ang = 0;
    R.om = 0;
    R.loc = 0;
    const me = w === S.active && !w.dead && !c.hang && !c.swim && !w.drowning && !c.burn;
    if (!me) {
      J.air = c.air ? 1 : 0;
      J.kind = 0;
      J.on = 0;
      J.wind = 0;
      J.land = 9;
      J.om = 0;
      J.phi = 0;
      J.wf = 0;
      return R;
    }
    const f = c.f, wp = !c.air && w.windUp > 0 ? M.clamp(1 - (w.windUp - S.time) / WD.JUMP_WIND, 0, 1) : 0;
    const eow = !!(S.eow && w.eu2), gk = SS.sim.gravity_k(S, w);
    const vUp = eow ? c.vs * w.eu2.s + c.vy * w.eu2.y : c.vy;
    if (c.air && !J.air) {                                                    // take-off
      J.tl = 0;
      J.land = 9;
      J.y0 = w.pos.y;
      J.s0 = c.s;
      J.kind = w.hop || (w.flip && w.flipAt != null && w.flipRope !== w.flipAt) ? 2 : J.wind > 0 ? 1 : 0;
      J.on = 0;
      J.om = 0;
      J.phi = 0;
      J.wf = 1;
      J.fAt = w.flipAt;
      J.nrev = 1;
      J.base = c.slope + f * c.lean; J.v0 = vUp; J.g = C.G_WORM * gk * (eow ? 0.55 : 1);
      if (J.kind === 2) {
        J.on = 1;
        J.tgt = TAU;
      }
    } else if (!c.air && J.air && J.kind) {
      // landing
      J.land = 0;
      J.landK = J.kind;
    }
    J.air = c.air ? 1 : 0; J.wind = wp;
    if (c.air) {
      J.tl += dt;
      // the salto (2nd press): same turn, a longer arc
      if (J.kind === 2 && w.flip && w.flipAt != null && w.flipRope !== w.flipAt && w.flipAt !== J.fAt) {
        J.fAt = w.flipAt;
        J.nrev = 2;
        J.tgt = TAU * J.nrev;
        J.on = 1;
        J.wf = 1;
      }
    } else J.land += dt;
    // time to the predicted landing (flat ground at the take-off height; a ceiling hit shortens it)
    let trem = 0;
    if (c.air) {
      let g = J.g;
      if (eow && J.tl > 0.1) g = M.clamp((J.v0 - vUp) / J.tl, 3, 80);
      const h = eow ? (c.s - J.s0) * w.eu2.s + (w.pos.y - J.y0) * w.eu2.y : w.pos.y - J.y0, disc = vUp * vUp + 2 * g * h;
      trem = disc > 0 ? (vUp + Math.sqrt(disc)) / g : 0;
    }
    // ---- the rotation of a back flip ----
    let q = 0;
    if (J.on) {
      let rem, tgo;
      if (c.air) {
        rem = J.tgt - J.phi; tgo = M.max(0.06, trem - K.OPEN_T);
      } else {
        // on the ground again: finish (or unwind) to the nearest whole turn
        J.tgt = TAU * Math.round(J.phi / TAU);
        rem = J.tgt - J.phi;
        tgo = 0.18;
      }
      let wd = M.clamp(rem / tgo, -K.WMAX, K.WMAX);
      const br = Math.sqrt(2 * K.BRAKE * Math.abs(rem));
      if (Math.abs(wd) > br) wd = wd < 0 ? -br : br;
      if (c.air && J.tl < 0.03) wd = 0;
      const am = K.ACC * dt, dw = wd - J.om;
      J.om += M.clamp(dw, -am, am);
      J.phi += J.om * dt;
      if ((J.om >= 0 && J.phi >= J.tgt - 1e-3) || (J.om < 0 && J.phi <= J.tgt + 1e-3 && !c.air)) {
        J.phi = J.tgt;
        if (!c.air) J.om = 0;
        else J.om = M.min(J.om, 0);
      }
      q = M.clamp(J.phi / (J.tgt || TAU), 0, 1);
      const done = Math.abs(J.tgt - J.phi) < 0.02 && Math.abs(J.om) < 0.5;
      if (!c.air) {
        J.wf = done || J.land > 0.45 ? M.max(0, J.wf - 9 * dt) : 1;
        if (J.wf <= 0.001) {
          J.on = 0;
          J.phi = 0;
          J.om = 0;
        }
      }
      R.flip = J.wf > 0.001; R.om = f * J.om; R.loc = J.phi;
      R.ang = f * J.phi + J.base * M.exp(-J.tl * 12) * 1;
    }
    R.wf = J.on ? M.min(1, J.wf) : 0;
    // ---- the poses ----
    if (wp > 0) {                                                              // anticipation
      const e1 = ss(0, K.COIL_T, wp), e2 = ss(K.COIL_T, 1, wp);
      R.sy = 1 - (1 - K.COIL_SY) * e1 - K.HOLD_SY * e2;
      R.sx = 1 + K.COIL_SX * e1;
      R.lean = K.COIL_LEAN * e1;
      R.str = K.COIL_STR * e1;
      R.act = 1;
    } else if (c.air && J.kind === 1) {                                        // the spring forward, the arc, the reach for the ground
      const ls = 1 - ss(0, K.SPRING_T, J.tl), vf = Math.sqrt(c.vs * c.vs + c.vy * c.vy), lp = 1 - ss(0.0, 0.3, trem);
      R.act = 1;
      R.str = (K.SPRING_STR * ls + K.FLY_STR * (1 - ls)) * (1 - 0.95 * lp);
      R.sy = 1 + K.SPRING_SY * ls;
      R.sx = 1 + K.SPRING_SX * ls;
      R.curl = 0.1 * ss(-3, 0, -Math.abs(c.vy)) * (1 - ls);                    // a soft tuck at the top of the arc
      if (vf > 1) {
        R.fly = true;
        R.fa = f * M.atan2(c.vy, c.vs * f) * K.FLY_A * (1 - lp);
        R.fw = M.min(1, K.FLY_W * (0.3 + 0.7 * ss(0, 0.06, J.tl)));
      }
    } else if (c.air && J.kind === 2 && J.on) {                                // the flip: launch stretch, tuck, open
      R.act = 1;
      const ls = 1 - ss(0, K.SPRING_T, J.tl), tk = ss(0.04, 0.26, q) * (1 - ss(0.66, 0.92, q)), op = ss(0.62, 0.98, q) * (1 - tk);
      R.str = M.max(0.85 * ls, 0.85 * tk, 0.45 * op);
      R.curl = tk * 1.3;
      R.sy = 1 + 0.12 * ls + 0.06 * op - 0.1 * tk;
      R.sx = 1 - 0.07 * ls + 0.05 * tk;
    } else if (!c.air && J.land < 0.5 && J.landK) {                            // landing: squash, recover without overshoot
      const t = J.land, amp = J.landK === 2 ? K.LAND_F : K.LAND_J, A = t < K.LAND_UP ? t / K.LAND_UP : M.exp(-(t - K.LAND_UP) * K.LAND_DN);
      R.act = 1; R.sy = 1 - amp * A; R.sx = 1 + 0.55 * amp * A;
    }
    if (R.flip) R.act = 1;
    if (c.air && J.kind) R.firm = K.FIRM;
    return R;
  };
})(window.SS = window.SS || {});
