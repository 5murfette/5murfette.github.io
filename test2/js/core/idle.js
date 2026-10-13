/* core/idle.js — P43: the "bored worm" idle antics as a pure state machine + keyframed programs (no THREE, no DOM, no
 * wall clock, no Math.random).
 *
 * RENDER-ONLY. The simulation never sees this: render/idleview.js reads the sim state (read-only), fills an input
 * struct, calls step() and draws the result (muscle offsets, face, hands, props, floating icons, sound cues). The
 * random choices (which antic, when, its variant) come from a per-worm seeded LCG (SS.math rng), so a replay of the
 * same match picks the same antics.
 *
 * State machine per worm (struct Idle, enum ST):
 *   WAIT     counting how long the worm has been calm and visible; at boredAt seconds it starts an antic (kind picked
 *            by weight, never the last two)
 *   PLAY     the program of the kind runs for st.t seconds (dur); any disturbance (input / move / hit / blast / turn
 *            start) leaves it at once:
 *            to STARTLE for the sleeper (the "woke up, woo woo, looks around" reaction), to OUT (a 0.25 s snap-out,
 *            props shrink) for the rest
 *   STARTLE  program_startle for 1.9 s (the worm goes on to be controlled; it only overlays the face / head / a hop)
 *   OUT      the blend k fades 1 -> 0 over 0.25 s
 * Kinds: JUGGLE (3 grenades, one is fumbled, panic, grabbed, sigh), PHONE (eye roll, a smartphone, scrolling short
 * videos, laughs), SLEEP (yawn, nods off, snore breathing, Z z z, a snot bubble), WATCH (whistles, taps, checks a
 * wristwatch, shrugs), EXERCISE (jumping jacks, counted), MAP (reads a map upside down), SUN (sunglasses, sunbathing;
 * sunny), SHIVER (cold: chattering teeth, breath puffs), FAN (hot: fans itself), WAVE (waves at the camera).
 * Output struct (make_out): scalars + hands h[2 x (on, x, y, z)] + props pr[NPROP x (on, x, y, z, rx, ry, rz, s, u)] +
 * icon sprites sp[NSPR x (kind, x, y, z, size, alpha)] + sound / fx cues. Coordinates are root-local metres: x along
 * the facing, y up (origin = the sim disc centre, ground y = -0.5), z toward the CAMERA (the view mirrors it for a worm
 * facing the other way); yaw > 0 turns the worm toward the camera. Porting: plain structs + switch + math; the rig
 * anchors (eyes, shoulder) come from the live soft body in the input struct. */
(function (SS) {
  'use strict';
  const M = SS.math, ID = SS.idle = {};
  const sin = M.sin, cos = M.cos, PI = M.PI, TAU = M.TAU, atan2 = M.atan2;
  const clamp = M.clamp, lerp = M.lerp, mn = M.min, mx = M.max;
  const sstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const win = (t, a, b, c, d) => sstep(a, b, t) * (1 - sstep(c, d, t));              // a trapezoid window: up a..b, down c..d
  const frac = x => x - Math.floor(x);

  /* ---------- enums ---------- */
  const ST = ID.ST = { WAIT: 0, PLAY: 1, STARTLE: 2, OUT: 3 };
  const K =
    ID.K = {
      NONE: 0, JUGGLE: 1, PHONE: 2, SLEEP: 3, WATCH: 4, EXERCISE: 5, MAP: 6, SUN: 7, SHIVER: 8, FAN: 9, WAVE: 10, UMBRELLA: 11, N: 12
    };
  ID.NAME = ['none', 'juggle', 'phone', 'sleep', 'watch', 'exercise', 'map', 'sun', 'shiver', 'fan', 'wave', 'umbrella'];
  const P = ID.P = { GREN0: 0, GREN1: 1, GREN2: 2, PHONE: 3, WATCH: 4, MAP: 5, SHADES: 6, FAN: 7, BUBBLE: 8, UMB: 9, N: 10 };
  const SK = ID.SK = { NONE: -1, Z: 0, BANG: 1, QUEST: 2, NOTE: 3, HEART: 4, HA: 5, N1: 6, N2: 7, N3: 8, N4: 9, GLINT: 10, N: 11 };
  const CUE =
    ID.CUE = {
      SNORE: 0, YAWN: 1, PANIC: 2, TAP: 3, LAUGH: 4, SIGH: 5, WHISTLE: 6, CLUNK: 7, POP: 8, SHIVER: 9, SWIPE: 10, PUFF: 11, SWEAT: 12,
      PLOP: 13, N: 14
    };
  const NSPR = ID.NSPR = 8, PSTRIDE = 9, SSTRIDE = 6, NCUE = 8;
  const HEAD_NAT = -1.05;
  const BORED = { LO: 6, HI: 12, ALO: 9, AHI: 16, CLO: 5, CHI: 9, OUT: 0.25, STARTLE: 1.9 };
  ID.BORED = BORED;
  ID.PAL = [[1.0, 0.25, 0.55, 0.2, 0.5, 1.0], [1.0, 0.8, 0.1, 1.0, 0.3, 0.1], [0.2, 0.9, 0.9, 0.3, 0.2, 0.9],
    [0.6, 1.0, 0.3, 0.1, 0.6, 0.4],
    // video panel gradients: top rgb, bottom rgb
    [1.0, 0.4, 0.2, 0.9, 0.1, 0.5], [0.3, 0.5, 1.0, 0.9, 0.8, 0.3], [0.9, 0.3, 1.0, 0.2, 0.9, 0.7], [1.0, 0.95, 0.5, 0.2, 0.6, 1.0]];

  /* ---------- structs ---------- */
  ID.make = function (id, seed) {
    const s = (Math.imul((id | 0) + 1, 2654435761) ^ Math.imul((seed | 0) + 7, 40503)) >>> 0;
    const st = { id: id | 0, state: ST.WAIT, kind: K.NONE, t: 0, tPrev: -1, tOut: 0, idleT: 0, boredAt: 0, dur: 0, rng: M.rng_make(s),
      last: [0, 0], count: 0,
      v: new Float32Array(8), k: 0, cause: 0, calmT: 0, boredU: 0, cool: 0, startled: 0 };
    st.boredU = M.rng_next(st.rng);
    return st;
  };
  ID.make_out = function () {
    return { k: 0, pk: 0, yaw: 0, sx: 1, sy: 1, ox: 0, oy: 0, look: HEAD_NAT, lookW: 0, wob: 0, lidA: 0, lidB: 0, eyeS: 1, pupS: 1, pgx: 0,
      pgy: 0, mo: 0, mw: 1,
      gr: 0, gg: 0, gb: 0, tint: 0, sweat: 0, scr: 0, kind: 0, state: 0, t: 0, hideHeld: 0,
      h: new Float32Array(8), pr: new Float32Array(P.N * PSTRIDE), sp: new Float32Array(NSPR * SSTRIDE), cue: new Int32Array(NCUE),
      cvol: new Float32Array(NCUE), ncue: 0 };
  };
  ID.make_in = function () {
    return {
      calm: 1, disturb: 0, visible: 1, active: 0, allow: 1, force: 0, mv: 0, cold: 0, hot: 0, sunny: 0, night: 0, rain: 0, ex: 0.56,
      ey: 0.18, cx: 0.23, cy: 0, gy: -0.5, ha: -1.05
    };
  };
  function clear_out(o) {
    o.pk = 0;
    o.yaw = 0;
    o.sx = 1;
    o.sy = 1;
    o.ox = 0;
    o.oy = 0;
    o.look = HEAD_NAT;
    o.lookW = 0;
    o.wob = 0;
    o.lidA = o.lidB = 0;
    o.eyeS = 1;
    o.pupS = 1;
    o.pgx = o.pgy = 0;
    o.mo = 0;
    o.mw = 1;
    o.gr = o.gg = o.gb = 0;
    o.tint = 0;
    o.sweat = 0;
    o.scr = 0;
    o.hideHeld = 0;
    o.ncue = 0;
    o.h.fill(0);
    o.pr.fill(0);
    for (let i = 0; i < NSPR; i++) o.sp[i * SSTRIDE] = -1;
  }
  const hnd = (o, q, x, y, z) => {
    const i = q * 4;
    o.h[i] = 1;
    o.h[i + 1] = x;
    o.h[i + 2] = y;
    o.h[i + 3] = z;
  };
  const prp = (o, id, x, y, z, rx, ry, rz, s, u) => {
    const i = id * PSTRIDE;
    o.pr[i] = 1;
    o.pr[i + 1] = x;
    o.pr[i + 2] = y;
    o.pr[i + 3] = z;
    o.pr[i + 4] = rx;
    o.pr[i + 5] = ry;
    o.pr[i + 6] = rz;
    o.pr[i + 7] = s;
    o.pr[i + 8] = u == null ? 1 : u;
  };
  const spr = (o, slot, kind, x, y, z, size, a) => {
    const i = slot * SSTRIDE;
    o.sp[i] = kind;
    o.sp[i + 1] = x;
    o.sp[i + 2] = y;
    o.sp[i + 3] = z;
    o.sp[i + 4] = size;
    o.sp[i + 5] = a;
  };
  const cue = (o, id, vol) => {
    if (o.ncue < NCUE) {
      o.cue[o.ncue] = id;
      o.cvol[o.ncue] = vol;
      o.ncue++;
    }
  };
  const face = (o, lid, eyeS, pupS, pgx, pgy, mo, mw) => {
    o.lidA = o.lidB = lid;
    o.eyeS = eyeS;
    o.pupS = pupS;
    o.pgx = pgx;
    o.pgy = pgy;
    o.mo = mo;
    o.mw = mw;
  };
  const blink = (t, period, phase) => {
    const u = frac((t + phase) / period) * period;
    return u < 0.16 ? sin(PI * u / 0.16) : 0;
  };
  // a pop-in with a little overshoot
  const popk = x => (x <= 0 ? 0 : x >= 0.28 ? 1 : (x < 0.18 ? sstep(0, 0.18, x) * 1.25 : lerp(1.25, 1, sstep(0.18, 0.28, x))));
  const xing = (st, t0) => st.tPrev < t0 && st.t >= t0;
  const V = { x: 0, y: 0, z: 0, rz: 0, s: 0 };
  /* an icon that lives a while: alpha in / out and a pop; returns its age fraction (0..1) or -1 when it is not alive at
   * st.t */
  function life(t, t0, d) { return t < t0 || t > t0 + d ? -1 : (t - t0) / d; }
  function icon(o, slot, kind, t, t0, d, x, y, z, size, rise, sway) {
    const u = life(t, t0, d);
    if (u < 0) return;
    const a = sstep(0, 0.1, u) * (1 - sstep(0.7, 1, u)), pop = 1 + 0.35 * (1 - sstep(0, 0.2, u));
    spr(o, slot, kind, x + sway * sin(u * 7 + slot), y + rise * u, z, size * pop * (0.7 + 0.3 * sstep(0, 0.35, u)), a);
  }

  /* ================= programs: p_x(st, t, o, I) writes the pose at program time t (the state's t) ================= */

  /* ---------- JUGGLE: 3 grenades, a cascade, one throw goes wrong, panic, a quick grab, a sigh (v0 = the failed beat)
   * ---------- */
  const J = { B: 0.40, TJ: 1.0 };
  function jtimes(st) {
    const nf = st.v[0], Tn = J.TJ + nf * J.B;
    return { nf, Tn, TL: Tn + 1.1, TG: Tn + 1.95, TR: Tn + 2.9, dur: Tn + 4.8 };
  }
  function jh(st, I, q, T) {                            // hand q (0 = near the camera) at time T -> V
    const jt = jtimes(st), B = J.B, TJ = J.TJ, Tn = jt.Tn, TG = jt.TG, TR = jt.TR;
    let x = q ? I.cx + 0.34 : I.cx - 0.12, y = I.cy + 0.50, z = q ? -0.04 : 0.16;
    const up = sstep(0, 0.7, T) * (1 - sstep(jt.dur - 0.45, jt.dur, T));
    if (T > TJ - 0.2 && T < Tn + 0.3) {
      const a = sstep(TJ - 0.2, TJ + 0.2, T) * (1 - sstep(Tn, Tn + 0.3, T));
      y += 0.05 * a * sin(TAU * (T - TJ) / (2 * B) + q * PI);
      x += 0.03 * a * cos(TAU * (T - TJ) / (2 * B) + q * PI);
    }
    if (T > Tn) {
      const pan = sstep(Tn + 0.25, Tn + 0.6, T) * (1 - sstep(TG - 0.1, TG, T));
      y += 0.08 * pan;
      x += (q ? -0.05 : 0.0) * pan;
      x += 0.012 * sin(T * 55 + q) * pan;
      y += 0.012 * sin(T * 47 + q * 2) * pan;
    }
    if (q === 0 && T > TG && T < TG + 0.66) {            // the lunge: the near hand dives for the ball and brings it back
      const w = sstep(TG, TG + 0.26, T) * (1 - sstep(TG + 0.36, TG + 0.62, T)), gx = I.cx + 0.40 + 0.30 - 0.03, gy = I.gy + 0.2;
      x = lerp(x, gx, w); y = lerp(y, gy, w); z = lerp(z, 0.12, w);
    }
    if (T > TR + 0.4 && T < TR + 1.5 && q === 0) {       // wipes the brow
      const w = win(T, TR + 0.4, TR + 0.7, TR + 1.2, TR + 1.5), wp = sin((T - TR - 0.5) * 14);
      x = lerp(x, I.ex - 0.05 + 0.07 * wp, w); y = lerp(y, I.ey + 0.2, w); z = lerp(z, 0.1, w);
    }
    V.x = lerp(I.cx, x, up); V.y = lerp(I.cy + 0.05, y, up); V.z = lerp(q ? -0.07 : 0.07, z, up);
  }
  function jb(st, I, i, T) {                            // ball i at time T -> V (x, y, z, rz, s); s = 0: not there
    const jt = jtimes(st), B = J.B, TJ = J.TJ, nf = jt.nf, Tn = jt.Tn, TL = jt.TL, TG = jt.TG, TR = jt.TR;
    V.s = 1.25 * popk(T - (0.30 + 0.18 * i)); V.rz = 0;
    if (V.s <= 0) return;
    const gx = I.cx + 0.40, gy = I.gy + 0.125;
    let px, py, pz, rz = 0;
    if (T < TJ + i * B) {
      jh(st, I, i === 1 ? 1 : 0, T);
      px = V.x;
      py = V.y + 0.06 + (i === 2 ? 0.08 : 0);
      pz = V.z + (i === 2 ? 0.02 : 0);
    } else {
      let m = Math.floor((T - TJ - i * B) / (3 * B));
      const mmax = Math.floor((nf - i) / 3);
      if (m > mmax) m = mmax;
      const n = i + 3 * m, Tt = TJ + n * B, q0 = n & 1;
      if (n === nf) {                                   // the fumble: a wild lob forward, two bounces, a roll
        if (T < TL) {
          const u = (T - Tn) / (TL - Tn);
          jh(st, I, q0, Tn);
          const x0 = V.x, y0 = V.y + 0.06, z0 = V.z;
          px = lerp(x0, gx, u);
          py = lerp(y0, gy, u) + 4 * 0.9 * u * (1 - u);
          pz = lerp(z0, 0.12, u);
          rz = 7 * (T - Tn);
        } else if (T < TL + 0.38) {
          const w = (T - TL) / 0.38;
          px = gx + 0.12 * w;
          py = gy + 0.2 * 4 * w * (1 - w);
          pz = 0.12;
          rz = 7 * (T - Tn);
        }
        else if (T < TL + 0.62) {
          const w = (T - TL - 0.38) / 0.24;
          px = gx + 0.12 + 0.06 * w;
          py = gy + 0.06 * 4 * w * (1 - w);
          pz = 0.12;
          rz = 7 * (T - Tn);
        }
        else {
          const w = clamp((T - TL - 0.62) / 0.5, 0, 1);
          px = gx + 0.18 + 0.12 * (1 - (1 - w) * (1 - w));
          py = gy;
          pz = 0.12;
          rz = 7 * (TL + 0.62 - Tn) + 4 * w;
        }
        if (T >= TG + 0.30) {
          jh(st, I, 0, T);
          px = V.x + 0.02;
          py = V.y - 0.03;
          pz = V.z;
          rz = 0.3;
        }
      } else {
        const u = (T - Tt) / (2.5 * B);
        if (u < 1) {
          jh(st, I, q0, Tt);
          const x0 = V.x, y0 = V.y + 0.06, z0 = V.z;
          jh(st, I, 1 - q0, Tt + 2.5 * B);
          const x1 = V.x, y1 = V.y + 0.06, z1 = V.z;
          px = lerp(x0, x1, u);
          py = lerp(y0, y1, u) + 4 * 0.5 * u * (1 - u);
          pz = lerp(z0, z1, u);
          rz = (q0 ? -1 : 1) * 5 * (T - Tt);
        } else {
          let qh = 1 - q0;
          jh(st, I, qh, T);
          px = V.x;
          py = V.y + 0.06;
          pz = V.z;
          if (m === mmax && T > Tn + 1.7) {              // both caught ones end up in the far hand (the near one is free to grab)
            const w = sstep(Tn + 1.7, Tn + 1.95, T), x0 = px, y0 = py, z0 = pz;
            jh(st, I, 1, T);
            const rank = i === ((nf % 3) + 1) % 3 ? 0 : 1;
            px = lerp(x0, V.x + 0.03 * rank, w); py = lerp(y0, V.y + 0.06 + 0.09 * rank, w); pz = lerp(z0, V.z, w);
          }
        }
      }
    }
    if (T > TR) {
      const w = sstep(TR, TR + 0.35, T);
      px = lerp(px, I.cx + 0.1, w);
      py = lerp(py, I.cy + 0.1, w);
      pz = lerp(pz, 0.05, w);
      V.s *= 1 - w;
    }
    V.x = px;
    V.y = py;
    V.z = pz;
    V.rz = rz;
  }
  function p_juggle(st, t, o, I) {
    const jt = jtimes(st), B = J.B, TJ = J.TJ, nf = jt.nf, Tn = jt.Tn, TL = jt.TL, TG = jt.TG, TR = jt.TR, bf = nf % 3;
    o.yaw = 0.6 * sstep(0, 0.6, t) * (1 - sstep(jt.dur - 0.7, jt.dur, t));
    for (let q = 0; q < 2; q++) {
      jh(st, I, q, t);
      hnd(o, q, V.x, V.y, V.z);
    }
    let up = 0;
    for (let i = 0; i < 3; i++) {
      jb(st, I, i, t);
      if (V.s > 0.01) {
        prp(o, P.GREN0 + i, V.x, V.y, V.z, 0, 0, V.rz, V.s);
        if (i !== bf || t < Tn + 0.3) up = mx(up, clamp((V.y - (I.cy + 0.5)) / 0.5, 0, 1));
      }
      if (xing(st, 0.30 + 0.18 * i)) cue(o, CUE.POP, 0.5);
    }
    const pan = sstep(Tn + 0.1, Tn + 0.3, t) * (1 - sstep(TG - 0.15, TG, t)), tj = t - TJ;
    // body: anticipation squash, the bounce of the cascade, panic shake, the lunge, the sigh
    o.sy = 1 - 0.05 * win(t, 0.1, 0.3, 0.3, 0.5) + 0.04 * win(t, 0.5, 0.7, 0.8, 1.0);
    if (t > TJ && t < Tn + 0.3) {
      const ph = TAU * tj / B, a = 1 - sstep(Tn, Tn + 0.3, t);
      o.sy += 0.015 * sin(ph) * a;
      o.oy = 0.012 * (1 + sin(ph * 0.5)) * a;
      o.ox = 0.02 * sin(ph * 0.5) * a;
    }
    o.ox += 0.014 * sin(t * 60) * pan; o.sy -= 0.04 * pan;
    const lunge = win(t, TG, TG + 0.25, TG + 0.4, TG + 0.65);
    o.ox += 0.09 * lunge; o.sx = 1 + 0.06 * lunge; o.sy -= 0.03 * lunge;
    const sg = win(t, TR, TR + 0.35, TR + 0.7, TR + 1.6);
    o.sy -= 0.08 * sg; o.sx += 0.03 * sg;
    // gaze and head
    o.lookW = 1; o.look = -1.0;
    if (t >= TJ) o.look = -0.9 + 0.7 * up;
    if (t >= Tn + 0.05) {
      jb(st, I, bf, t);
      const a = atan2(V.y - I.ey, V.x - I.ex);
      const tr = clamp(a, -1.6, 0.9);
      o.look = lerp(o.look, tr, sstep(Tn + 0.05, Tn + 0.25, t));
    }
    if (t > TG + 0.7) o.look = lerp(o.look, -1.0, sstep(TG + 0.7, TG + 0.9, t));
    if (t > TR) o.look = lerp(o.look, -1.3, sstep(TR, TR + 0.4, t)) + 0.3 * sstep(TR + 1.3, TR + 1.8, t);
    o.wob = 0.1 * sin(t * 40) * pan;
    // face
    face(o, 0, 1.05, 1, 0, 0, 0.1, 1.6);
    if (t > TJ) face(o, 0.12, 1.0, 1, 0, 0.8 * up - 0.2, 0.04, 1.3);
    if (pan > 0) {
      const e = pan;
      o.eyeS = lerp(o.eyeS, 1.45, e);
      o.pupS = lerp(o.pupS, 0.45, e);
      o.lidA = o.lidB = lerp(o.lidA, 0, e);
      o.mo = lerp(o.mo, 0.95, e);
      o.mw = lerp(o.mw, 0.8, e);
      o.pgy = lerp(o.pgy, -0.4, e);
    }
    if (lunge > 0) {
      o.lidA = o.lidB = lerp(o.lidA, 0.3, lunge);
      o.mo = lerp(o.mo, 0.3, lunge);
      o.mw = lerp(o.mw, 1.3, lunge);
    }
    if (t > TR) {
      const e = sstep(TR, TR + 0.2, t) * (1 - sstep(TR + 1.5, TR + 2.0, t));
      o.lidA = o.lidB = lerp(o.lidA, 0.85, e);
      o.mo = lerp(o.mo, 0.6, e);
      o.mw = lerp(o.mw, 1.2, e);
      o.eyeS = lerp(o.eyeS, 1.0, e);
      o.pupS = 1;
    }
    o.pgx = pan > 0 ? 0 : o.pgx;
    o.sweat = 0.3 * win(t, TJ + 1.0, TJ + 2.0, Tn, Tn + 0.2) + 0.9 * pan + 0.5 * sg;
    // icons and cues
    icon(o, 0, SK.BANG, t, Tn + 0.2, 1.0, I.ex - 0.1, I.ey + 0.5, 0.05, 0.5, 0.1, 0);
    if (xing(st, Tn + 0.2)) cue(o, CUE.PANIC, 0.9);
    if (xing(st, TL)) cue(o, CUE.CLUNK, 0.9);
    if (xing(st, TL + 0.38)) cue(o, CUE.CLUNK, 0.55);
    if (xing(st, TL + 0.62)) cue(o, CUE.CLUNK, 0.3);
    if (xing(st, TG + 0.3)) cue(o, CUE.POP, 0.6);
    if (xing(st, TR + 0.1)) cue(o, CUE.SIGH, 0.9);
  }

  /* ---------- PHONE: bored sigh, an eye roll, a smartphone, scrolling short videos, laughs (v0, v1 = the laugh times,
   * v2 = the double tap) ---------- */
  function p_phone(st, t, o, I) {
    const dur = st.dur, TP = 3.6, TE = dur - 1.9, scrollT = 4.0, sw = 0.9;
    o.yaw = 0.5 * sstep(2.9, 3.7, t) * (1 - sstep(dur - 0.9, dur - 0.1, t));
    const slump = win(t, 0, 0.8, 2.6, 3.4), roll = sstep(1.4, 2.5, t) * (1 - sstep(2.6, 2.7, t));
    o.sy = 1 - 0.04 * slump; o.ox = 0.03 * sin(t * 1.5) * slump;
    o.lookW = 1; o.look = -1.25 * slump + HEAD_NAT * (1 - slump);
    if (roll > 0) o.look = lerp(o.look, -0.55, sin(PI * clamp((t - 1.4) / 1.1, 0, 1)));
    const using = win(t, TP - 0.4, TP, TE, TE + 0.4);
    o.look = lerp(o.look, -1.2, using);
    face(o, 0.45 * slump, 1.0, 1, 0, 0, 0, 1.2);
    if (t >= 1.4 && t < 2.6) {
      const a = TAU * sstep(1.4, 2.5, t);
      face(o, 0, 1.25, 0.9, 0.95 * cos(a), 0.95 * sin(a), 0.0, 1.3);
    }
    // phone and hands
    const ph = { x: I.ex + 0.34, y: I.ey - 0.08, z: 0.2 };
    let hx = I.cx - 0.12, hy = I.cy - 0.18, hz = 0.12, hand1 = 0;
    const grab = sstep(2.7, 3.0, t) * (1 - sstep(3.0, 3.6, t));
    const raise = sstep(3.1, 3.6, t) * (1 - sstep(TE, TE + 0.7, t));
    hx = lerp(hx, ph.x - 0.02, raise); hy = lerp(hy, ph.y - 0.1, raise); hz = lerp(hz, ph.z + 0.03, raise);
    const handOn = win(t, 2.6, 3.0, dur - 0.6, dur - 0.2);
    if (handOn > 0) hnd(o, 0, lerp(I.cx, hx, handOn), lerp(I.cy, hy, handOn), lerp(0.07, hz, handOn));
    // swipes: the thumb (hand 1) flicks up the screen
    let swipe = 0, sIdx = 0;
    if (t > scrollT) {
      sIdx = Math.floor((t - scrollT) / sw);
      const u = ((t - scrollT) - sIdx * sw) / sw;
      swipe = u < 0.3 ? sstep(0, 0.3, u) : 0;
      o.scr = sIdx + sstep(0.04, 0.34, u);
      if (t > TE) o.scr = sIdx;
    }
    const thumbY = ph.y - 0.07 + 0.09 * swipe, ts = win(t, TP, TP + 0.3, TE - 0.2, TE + 0.2);
    if (ts > 0) hnd(o, 1, lerp(I.cx, ph.x + 0.0, ts), lerp(I.cy, thumbY, ts), lerp(-0.07, ph.z + 0.06, ts));
    const pv = popk(t - 3.0) * (1 - sstep(TE + 0.3, TE + 0.65, t));
    const kick = sstep(0.3, 1.0, swipe) * 0.05;
    if (pv > 0)
      prp(
        o,
        P.PHONE,
        lerp(hx, ph.x, sstep(3.0, 3.6, t)),
        lerp(hy + 0.06, ph.y, sstep(3.0, 3.6, t)),
        hz,
        0,
        0.1,
        0.12 + 0.1 * sstep(3.0, 3.6, t) - kick + 0.015 * sin(t * 1.7),
        1.5 * pv
      );
    // laughs and a like
    const L0 = st.v[0], L1 = st.v[1], LK = st.v[2];
    const lau = win(t, L0, L0 + 0.1, L0 + 0.8, L0 + 1.0) + win(t, L1, L1 + 0.1, L1 + 0.8, L1 + 1.0);
    if (lau > 0 && using > 0.5) {
      o.sy += 0.045 * lau * sin(t * 32);
      o.ox += 0.012 * lau * sin(t * 19);
      face(o, lerp(o.lidA, 0.55, lau), 1.0, 1, 0, 0, lerp(o.mo, 0.8 + 0.2 * sin(t * 32), lau), lerp(o.mw, 1.5, lau));
    }
    else if (using > 0.5) {
      face(o, blink(t, 2.4, st.id * 0.3), 1.0, 1, 0.5, -0.3 - 0.4 * swipe, 0.0, 1.25);
      o.pgy -= 0.3;
    }
    icon(o, 0, SK.HA, t, L0 + 0.15, 0.9, I.ex - 0.05, I.ey + 0.45, 0.05, 0.45, 0.25, 0.04);
    icon(o, 1, SK.HA, t, L1 + 0.15, 0.9, I.ex + 0.08, I.ey + 0.5, 0.05, 0.45, 0.25, 0.04);
    icon(o, 2, SK.HEART, t, LK, 1.3, ph.x + 0.1, ph.y + 0.2, 0.15, 0.4, 0.5, 0.05);
    if (xing(st, 0.2)) cue(o, CUE.SIGH, 0.7);
    if (xing(st, 1.8)) cue(o, CUE.SIGH, 0.4);
    if (xing(st, TP)) cue(o, CUE.TAP, 0.6);
    for (let j = 0; j < 12; j++)
      if (xing(st, scrollT + j * sw + 0.08) && st.t < TE) cue(o, CUE.SWIPE, 0.35);
    if (xing(st, L0 + 0.05) || xing(st, L1 + 0.05)) cue(o, CUE.LAUGH, 0.9);
    if (xing(st, LK)) cue(o, CUE.TAP, 0.5);
    // the glow of the screen on the face
    if (using > 0) {
      const pi = Math.floor(o.scr) & 7, c = ID.PAL[pi], g = 0.05 * using * (0.85 + 0.15 * sin(t * 9));
      o.gr = g * c[0];
      o.gg = g * c[1];
      o.gb = g * c[2];
    }
    if (t > TE + 0.2 && t < TE + 1.5) face(o, 0.2, 1.0, 1, 0, 0, 0.1, 1.2);
  }

  /* ---------- SLEEP: a yawn, the head bobs, then asleep: breathing inflates the body, Z z z, a snot bubble; the
   * startle is the next state ---------- */
  const SL = { T0: 4.2, BR: 3.0 };
  function p_sleep(st, t, o, I) {
    const dur = st.dur, ts = SL.T0, wake = sstep(dur - 2.2, dur - 1.6, t);
    const yawn = win(t, 0.3, 0.9, 1.1, 1.6);
    // lids and head: the yawn, drowsy nods, a jerk awake, the final slump
    let lid = 0, look = HEAD_NAT;
    if (t < 1.6) {
      lid = 0.55 * yawn;
      look = HEAD_NAT + 0.25 * yawn;
    }
    else if (t < 2.6) {
      lid = lerp(0.1, 0.65, sstep(1.6, 2.5, t));
      look = lerp(HEAD_NAT, -1.7, sstep(1.6, 2.5, t));
    }
    else if (t < 2.85) {
      lid = lerp(0.65, 0.05, sstep(2.6, 2.7, t));
      look = lerp(-1.7, -0.95, sstep(2.6, 2.75, t));
    }
    else if (t < ts) {
      lid = lerp(0.05, 1.0, sstep(2.9, 3.9, t));
      look = lerp(-0.95, -1.9, sstep(2.9, 3.9, t));
    }
    else {
      lid = 1.0;
      look = -1.9 + 0.03 * sin(t * 0.7);
    }
    const u = frac((t - ts) / SL.BR), asleep = sstep(ts - 0.3, ts + 0.3, t), inh = sstep(0, 0.42, u) * (1 - sstep(0.42, 0.62, u));
    const br = asleep * (inh * 1.0 - 0.18 * sstep(0.62, 0.95, u) * (1 - sstep(0.95, 1, u)));
    o.sy = 1 + 0.07 * yawn + 0.08 * br;
    o.sx = 1 - 0.045 * br - 0.02 * yawn;
    o.oy = 0.0;
    o.ox = 0.01 * sin(t * 0.5) * asleep;
    if (t < 3.9) o.sy -= 0.03 * sstep(1.6, 3.6, t);
    o.yaw = 0.3 * sstep(2.5, 4.0, t) * (1 - sstep(dur - 1.0, dur - 0.2, t));
    o.lookW = 1; o.look = look; o.wob = 0.04 * sin(t * 0.9) * asleep;
    if (wake > 0) {
      lid = lerp(lid, 0.2, wake);
      look = lerp(look, HEAD_NAT, wake);
      o.look = look;
      o.sy += 0.05 * win(t, dur - 2.2, dur - 1.8, dur - 1.6, dur - 1.1);
    }
    const mo = 1.0 * yawn + asleep * (0.22 + 0.12 * sstep(0.45, 0.6, u) * (1 - sstep(0.6, 0.95, u)) * sin(t * 38));
    face(o, lid, 1.0, 1, 0, -0.3, mo, 1.0 + 0.3 * asleep - 0.2 * yawn);
    if (yawn > 0.2) {
      o.eyeS = 1.0;
      o.lidA = o.lidB = mx(lid, 0.8 * yawn);
    }
    // a hand covers the yawn
    const hy = win(t, 0.5, 0.9, 1.2, 1.6);
    if (hy > 0) hnd(o, 0, lerp(I.cx, I.ex + 0.1, hy), lerp(I.cy, I.ey - 0.05, hy), lerp(0.07, 0.2, hy));
    // the snot bubble: grows on the exhale, shrinks on the inhale, pops at the end of every third exhale
    if (asleep > 0.5 && t < dur - 2.3) {
      const m = Math.floor((t - ts) / SL.BR), pop = m % 3 === 2, prevPop = m > 0 && (m - 1) % 3 === 2;
      let r = 0;
      if (u < 0.4) {
        if (m > 0 && !prevPop) r = 0.07 * (1 - sstep(0, 0.4, u));
      }
      else if (u >= 0.45) {
        r = (pop ? 0.13 : 0.07) * sstep(0.45, 0.97, u);
        if (pop && u > 0.97) r = 0;
      }
      if (r > 0.012) prp(o, P.BUBBLE, I.ex + 0.06, I.ey - 0.075, 0.03, 0, 0, 0, r / 0.1);
    }
    // Z z z: two per breath, from the exhale
    if (t > ts) {
      for (let j = 0; j < 2; j++) {
        const mm = Math.floor((t - ts - 1.3 - 0.45 * j) / SL.BR);
        if (mm < 0) continue;
        const t0 = ts + 1.3 + 0.45 * j + mm * SL.BR;
        const slot = ((mm & 1) * 2 + j);
        if (t < dur - 2.0) icon(o, slot, SK.Z, t, t0, 2.9, I.ex - 0.05 + 0.15 * j, I.ey + 0.3, 0.08, 0.3 + 0.12 * j, 0.85 + 0.2 * j, 0.1);
      }
    }
    for (let m = 0; m < 10; m++) {
      const tb = ts + m * SL.BR;
      if (xing(st, tb + 0.02)) cue(o, CUE.SNORE, 0.7);
      if (m % 3 === 2 && xing(st, tb + 0.97 * SL.BR)) cue(o, CUE.POP, 0.5);
    }
    if (xing(st, 0.4)) cue(o, CUE.YAWN, 0.8);
    if (xing(st, dur - 2.0)) cue(o, CUE.YAWN, 0.6);
  }
  /* the sleeper is startled: a hop, wide eyes, "woo woo", looks left and right, a sheepish blink (t 0..1.9) */
  function p_startle(st, t, o, I) {
    const mv = 1 - 0.7 * I.mv;
    const hop = clamp(t / 0.55, 0, 1),
      arc = 4 * hop * (1 - hop),
      land = win(t, 0.5, 0.58, 0.62, 0.85),
      look = sstep(0.6, 0.8, t) * (1 - sstep(1.6, 1.9, t));
    o.oy = 0.32 * arc * mv * (t < 0.55 ? 1 : 0);
    o.sy = 1 + 0.22 * win(t, 0.0, 0.1, 0.1, 0.4) * mv - 0.14 * land * mv;
    o.sx = 1 - 0.05 * win(t, 0.0, 0.1, 0.1, 0.4) * mv + 0.07 * land * mv;
    o.ox = 0.025 * sin(t * 40) * win(t, 0.1, 0.2, 0.5, 0.7) * mv + 0.012 * sin(t * 27) * look * mv;
    o.yaw = (0.95 * sin((t - 0.6) * 8.0) * look) * (1 - 0.5 * I.mv);
    o.lookW = 1; o.look = lerp(-0.4, HEAD_NAT, sstep(0.0, 0.5, t)) + 0.35 * sin(t * 14) * look;
    const calm = sstep(1.55, 1.9, t);
    face(o, 0.0, lerp(1.45, 1.0, calm), lerp(0.42, 1.0, calm), 0, 0, lerp(1.0, 0.1, sstep(0.9, 1.5, t)), lerp(0.85, 1.2, calm));
    o.pgx = 1.0 * sin(t * 16) * look; o.pgy = 0.25 * sin(t * 11) * look;
    if (t > 1.55) {
      const b = blink(t - 1.55, 0.25, 0);
      o.lidA = o.lidB = b;
    }
    // both hands flail up while it is in the air
    const fl = win(t, 0.05, 0.15, 0.75, 1.2);
    if (fl > 0)
      for (let q = 0; q < 2; q++) {
        const sg = q ? -1 : 1;
        hnd(
          o,
          q,
          lerp(I.cx, I.cx + 0.12 + 0.08 * sin(t * 24 + q * 2), fl),
          lerp(I.cy, I.cy + 0.62 + 0.06 * cos(t * 22 + q), fl),
          sg * lerp(0.07, 0.2, fl)
        );
      }
    o.sweat = 0.8 * win(t, 0.1, 0.3, 1.2, 1.6);
    icon(o, 0, SK.BANG, t, 0.05, 1.0, I.ex - 0.1, I.ey + 0.5, 0.05, 0.55, 0.1, 0);
    icon(o, 1, SK.QUEST, t, 0.85, 0.9, I.ex - 0.25, I.ey + 0.5, 0.05, 0.42, 0.12, 0.02);
    icon(o, 2, SK.QUEST, t, 1.2, 0.9, I.ex + 0.1, I.ey + 0.55, 0.05, 0.42, 0.12, 0.02);
    if (xing(st, 0.05)) cue(o, CUE.PANIC, 1.0);
    if (xing(st, 0.8)) cue(o, CUE.PANIC, 0.8);
    if (xing(st, 1.15)) cue(o, CUE.PANIC, 0.7);
    if (xing(st, 0.58)) cue(o, CUE.PLOP, 0.7);
  }

  /* ---------- WATCH: whistles and taps its foot, checks a wristwatch, holds it to the ear, shrugs ---------- */
  function p_watch(st, t, o, I) {
    const dur = st.dur;
    o.yaw = 0.5 * sstep(0.3, 0.9, t) * (1 - sstep(dur - 0.8, dur - 0.1, t));
    const wh = win(t, 0.6, 0.9, 3.4, 3.7), beat = frac(t * 2.0), tap = wh * (0.5 + 0.5 * sin(TAU * t * 2.0));
    o.sy = 1 - 0.03 * tap; o.oy = 0.01 * tap; o.ox = 0.015 * sin(TAU * t * 1.0) * wh;
    o.lookW = 1; o.look = HEAD_NAT + 0.18 * sin(TAU * t * 1.5) * wh + 0.35 * win(t, 3.7, 4.0, 4.2, 4.5);
    o.wob = 0.1 * sin(TAU * t * 1.5) * wh;
    face(
      o,
      0.05 + 0.4 * win(t, 0, 0.3, 0.5, 0.9),
      1.0,
      1,
      0.3 * sin(t * 1.3) * wh,
      0,
      0.3 * wh * (0.7 + 0.3 * sin(t * 12)),
      1.0 - 0.45 * wh
    );
    for (let j = 0; j < 4; j++) icon(o, j, SK.NOTE, t, 0.8 + j * 0.65, 1.6, I.ex + 0.15, I.ey + 0.15, 0.1, 0.32, 0.7, 0.1);
    // the wristwatch: up to the face, two taps, up to the ear, a shake, then a shrug
    const chk = win(t, 3.9, 4.4, 5.9, 6.3), ear = win(t, 5.0, 5.3, 5.8, 6.1), shrug = win(t, 6.2, 6.6, 7.6, 8.0);
    const tp = 0.012 * (win(t, 4.55, 4.6, 4.65, 4.7) + win(t, 4.85, 4.9, 4.95, 5.0));
    let hx = lerp(I.ex + 0.08, I.ex - 0.18, ear), hy = lerp(I.ey + 0.22, I.ey + 0.02, ear) - tp * 8, hz = lerp(0.16, 0.1, ear);
    hx += 0.03 * sin(t * 36) * win(t, 5.3, 5.4, 5.7, 5.8);
    if (chk > 0 && shrug < 0.5) {
      hnd(o, 0, lerp(I.cx, hx, chk), lerp(I.cy, hy, chk), lerp(0.07, hz, chk));
      prp(o, P.WATCH, lerp(I.cx, hx - 0.02, chk), lerp(I.cy, hy + 0.04, chk), lerp(0.07, hz + 0.05, chk), 0, 0.1, 0.2, chk);
    }
    if (shrug > 0) {
      hnd(o, 0, I.cx + 0.1, I.cy + 0.32 + 0.1 * shrug, 0.3 * shrug);
      hnd(o, 1, I.cx + 0.1, I.cy + 0.32 + 0.1 * shrug, -0.3 * shrug);
      o.sy += 0.05 * shrug; o.wob += 0.15 * sin(t * 5) * shrug;
    }
    if (chk > 0) {
      o.pgy = 0.3;
      o.look = lerp(o.look, -0.8 + 0.2 * ear, chk);
      face(o, mx(o.lidA, 0.35 * ear), 1.0 + 0.05 * (1 - ear), 1, -0.5 * ear, -0.5 * (1 - ear), 0.0, 1.2);
    }
    if (shrug > 0) {
      face(o, 0.6 * shrug, 1.0, 1, 0, 0, 0.5 * shrug, 1.3);
      o.look = lerp(o.look, -0.9, shrug);
    }
    if (t > 5.0 && t < 5.9) o.lidA = o.lidB = mx(o.lidA, 0.5 * ear);
    icon(o, 5, SK.QUEST, t, 6.4, 1.0, I.ex, I.ey + 0.55, 0.05, 0.42, 0.1, 0.02);
    for (let j = 0; j < 4; j++)
      if (xing(st, 0.8 + j * 0.65)) cue(o, CUE.WHISTLE, 0.7);
    if (xing(st, 4.55) || xing(st, 4.85)) cue(o, CUE.TAP, 0.6);
    if (xing(st, 6.3)) cue(o, CUE.SIGH, 0.8);
    if (xing(st, 0.2)) cue(o, CUE.SIGH, 0.5);
  }

  /* ---------- EXERCISE: warm up, 4 jumping jacks (counted), a stretch, panting, a brow wipe ---------- */
  function p_exercise(st, t, o, I) {
    const dur = st.dur, TJ = 0.9, PER = 0.78, NJ = 4;
    o.yaw = 0.5 * sstep(0, 0.6, t) * (1 - sstep(dur - 0.7, dur - 0.1, t));
    const act = win(t, TJ, TJ + 0.1, TJ + NJ * PER, TJ + NJ * PER + 0.1);
    const ph = clamp((t - TJ) / PER, 0, NJ), fr = ph - Math.floor(ph), jump = act * sin(PI * clamp(fr / 0.85, 0, 1));
    const rep = Math.floor(ph);
    o.oy = 0.3 * jump;
    o.sy = 1 + 0.1 * jump - 0.12 * act * (fr > 0.85 ? sin(PI * (fr - 0.85) / 0.15) : 0) - 0.06 * win(t, 0.2, 0.7, 0.7, TJ);
    o.sx = 1 - 0.04 * jump; o.ox = 0.01 * sin(t * 9) * act;
    o.lookW = 1; o.look = HEAD_NAT + 0.4 * jump;
    const st2 = TJ + NJ * PER,
      str = win(t, st2 + 0.1, st2 + 0.8, st2 + 1.6, st2 + 2.2),
      pant = win(t, st2 + 1.2, st2 + 1.8, dur - 1.2, dur - 0.5);
    o.sy += 0.14 * str + 0.03 * sin(t * 12) * pant; o.ox += 0.07 * sin((t - st2) * 2.4) * str; o.wob = 0.2 * sin((t - st2) * 2.4) * str;
    face(o, 0.18, 1.1, 0.9, 0.0, 0.0, 0.25 + 0.35 * jump, 1.15);
    if (pant > 0) face(o, lerp(o.lidA, 0.5, pant), 1.0, 1, 0, -0.3, 0.4 + 0.2 * sin(t * 12), 1.2);
    // hands: out and up with each hop; up high for the stretch; a brow wipe
    const hu = act * (0.25 + 0.75 * jump), pre = win(t, 0.4, 0.8, TJ + 0.05, TJ + 0.2);
    let hx = I.cx + 0.1, hy = lerp(I.cy - 0.12, I.cy + 0.6, hu), hz = lerp(0.2, 0.12, hu);
    if (str > 0) {
      hy = lerp(hy, I.cy + 0.85, str);
      hz = lerp(hz, 0.08, str);
    }
    const on = mx(mx(act, pre), mx(str, 0)) * (1 - sstep(st2 + 2.2, st2 + 2.4, t));
    if (on > 0)
      for (let q = 0; q < 2; q++) {
        const sg = q ? -1 : 1;
        hnd(o, q, lerp(I.cx, hx + 0.02 * sg, on), lerp(I.cy, hy, on), lerp(0.07 * sg, hz * sg, on));
      }
    const wipe = win(t, dur - 2.0, dur - 1.7, dur - 1.0, dur - 0.7);
    if (wipe > 0) hnd(o, 0, lerp(I.cx, I.ex - 0.05 + 0.07 * sin(t * 14), wipe), lerp(I.cy, I.ey + 0.2, wipe), 0.1);
    if (act > 0 && rep < NJ && fr > 0.2 && fr < 0.9)
      icon(o, 0, SK.N1 + rep, t, TJ + rep * PER + 0.2, 0.55, I.ex - 0.1, I.ey + 0.5, 0.05, 0.5, 0.12, 0);
    o.sweat = 0.1 + 0.7 * sstep(TJ, st2, t) * (1 - sstep(dur - 1.5, dur - 0.5, t) * 0.5);
    for (let j = 0; j < NJ; j++)
      if (xing(st, TJ + (j + 1) * PER - 0.02)) cue(o, CUE.PLOP, 0.5);
    if (xing(st, dur - 1.9)) cue(o, CUE.SIGH, 0.9);
  }

  /* ---------- MAP: looks lost, unfolds a map, reads it upside down, scratches its head, turns it round, "aha", points
   * the way ---------- */
  function p_map(st, t, o, I) {
    const dur = st.dur;
    o.yaw = 0.45 * sstep(0.8, 1.6, t) * (1 - sstep(dur - 1.0, dur - 0.2, t)) + 0.25 * sin(t * 3.5) * win(t, 0, 0.3, 0.7, 0.9);
    const unf = sstep(0.9, 2.0, t) * (1 - sstep(dur - 1.9, dur - 1.0, t)), rd = win(t, 1.7, 2.2, dur - 2.0, dur - 1.4);
    const rot = PI * (1 - sstep(5.1, 5.9, t));
    o.lookW = 1; o.look = HEAD_NAT + 0.5 * sin(t * 4) * win(t, 0, 0.2, 0.8, 1.0);
    o.look = lerp(o.look, -0.85 + 0.12 * sin(t * 3), rd);
    const tilt = win(t, 3.3, 3.6, 4.9, 5.1);
    o.wob = 0.25 * tilt;
    const aha = win(t, 5.9, 6.0, 6.5, 7.0), point = win(t, 6.3, 6.8, 7.9, 8.4);
    face(o, 0.1, 1.0, 1, 0.8 * sin(t * 2.2) * win(t, 0, 0.1, 0.8, 1.0), 0, 0.0, 1.1);
    if (rd > 0) face(o, 0.2 * rd, 1.0, 1, 0.7 * sin(t * 3.1) * rd, -0.4, 0.0, 1.05);
    if (tilt > 0) face(o, 0.3, 1.0, 1, 0.4, 0.3, 0.1, 0.9);
    if (aha > 0) {
      o.eyeS = lerp(o.eyeS, 1.3, aha);
      o.lidA = o.lidB = lerp(o.lidA, 0, aha);
      o.mo = lerp(o.mo, 0.6, aha);
      o.mw = lerp(o.mw, 1.3, aha);
      o.look = lerp(o.look, -0.5, aha);
    }
    if (point > 0) {
      o.look = lerp(o.look, -0.7, point);
      o.mo = lerp(o.mo, 0.15, point);
      o.mw = lerp(o.mw, 1.7, point);
      o.lidA = o.lidB = lerp(o.lidA, 0.15, point);
      o.sy += 0.03 * sin(t * 6) * point;
    }
    // hands: hand 1 pulls the map out, then holds it; hand 0 scratches / points
    const mapP = { x: I.ex + 0.28, y: I.ey - 0.02, z: 0.14 };
    const pull = win(t, 0.8, 1.3, dur - 1.7, dur - 1.0);
    const h1x = lerp(I.cx - 0.1, mapP.x + 0.0, sstep(1.1, 1.9, t)), h1y = lerp(I.cy - 0.15, mapP.y - 0.08, sstep(1.1, 1.9, t));
    if (pull > 0) hnd(o, 1, lerp(I.cx, h1x, pull), lerp(I.cy, h1y, pull), lerp(-0.07, 0.12, pull));
    const scr = win(t, 3.7, 4.0, 4.7, 5.0), h0on = mx(win(t, 1.6, 2.0, 3.6, 3.9), mx(scr, mx(point, win(t, 5.0, 5.2, 5.6, 5.9))));
    let h0x = mapP.x - 0.12, h0y = mapP.y - 0.06, h0z = 0.2;
    if (scr > 0) {
      h0x = lerp(h0x, I.ex - 0.08 + 0.04 * sin(t * 13), scr);
      h0y = lerp(h0y, I.ey + 0.26 + 0.02 * cos(t * 13), scr);
      h0z = lerp(h0z, 0.12, scr);
    }
    if (point > 0) {
      h0x = lerp(h0x, I.ex + 0.6, point);
      h0y = lerp(h0y, I.ey - 0.05, point);
    }
    if (h0on > 0) hnd(o, 0, lerp(I.cx, h0x, mn(1, h0on * 1.2)), lerp(I.cy, h0y, mn(1, h0on * 1.2)), lerp(0.07, h0z, mn(1, h0on * 1.2)));
    if (unf > 0.01)
      prp(
        o,
        P.MAP,
        lerp(I.cx, mapP.x, sstep(0.9, 1.9, t)),
        lerp(I.cy - 0.1, mapP.y, sstep(0.9, 1.9, t)),
        mapP.z,
        0,
        0.1,
        rot + 0.04 * sin(t * 2.3),
        1.0,
        unf
      );
    icon(o, 0, SK.QUEST, t, 0.5, 0.9, I.ex - 0.05, I.ey + 0.55, 0.05, 0.42, 0.1, 0.02);
    icon(o, 1, SK.QUEST, t, 3.5, 1.0, I.ex - 0.2, I.ey + 0.5, 0.05, 0.42, 0.1, 0.02);
    icon(o, 2, SK.QUEST, t, 4.3, 0.9, I.ex + 0.05, I.ey + 0.55, 0.05, 0.38, 0.1, 0.02);
    icon(o, 3, SK.BANG, t, 5.95, 1.0, I.ex - 0.05, I.ey + 0.55, 0.05, 0.55, 0.1, 0);
    if (xing(st, 0.2)) cue(o, CUE.SIGH, 0.5);
    if (xing(st, 1.1)) cue(o, CUE.POP, 0.4);
    if (xing(st, 5.95)) cue(o, CUE.PANIC, 0.7);
  }

  /* ---------- SUN: slips on sunglasses and sunbathes, head back, hands behind the head ---------- */
  function p_sun(st, t, o, I) {
    const dur = st.dur,
      on = sstep(0.9, 1.5, t) * (1 - sstep(dur - 1.9, dur - 1.3, t)),
      chill = sstep(1.6, 2.6, t) * (1 - sstep(dur - 1.9, dur - 1.2, t));
    o.yaw = 0.55 * sstep(0.2, 1.0, t) * (1 - sstep(dur - 0.9, dur - 0.1, t));
    o.sx = 1 + 0.04 * chill; o.sy = 1 - 0.05 * chill + 0.01 * sin(t * 1.1) * chill; o.ox = 0.02 * sin(t * 0.8) * chill;
    o.lookW = 1; o.look = lerp(HEAD_NAT, -0.25 + 0.04 * sin(t * 0.9), chill);
    const sg = popk((t - 0.5) / 1.4);
    const drop = sstep(0.5, 1.1, t), glx = I.ex + 0.01, gly = lerp(I.ey + 0.4, I.ey + 0.0, drop);
    if (t > 0.5 && t < dur - 1.1)
      prp(o, P.SHADES, glx, gly, 0, 0, 0, I.ha + 0.0, 1.0 * mn(1, sg + 0.001) * (1 - sstep(dur - 1.6, dur - 1.1, t)));
    face(o, 0.0, 1.0, 1, 0, 0, 0.0, 1.0);
    if (chill > 0) face(o, 0.3 * chill, 1.0, 1, 0, 0.5, 0.06 * chill, 1.0 + 0.6 * chill);
    const hh = chill;
    if (hh > 0)
      for (let q = 0; q < 2; q++) {
        const sg2 = q ? -1 : 1;
        hnd(o, q, lerp(I.cx, I.cx + 0.17, hh), lerp(I.cy, I.cy + 0.08, hh), sg2 * lerp(0.07, 0.15, hh));
      }
    const off = win(t, dur - 1.9, dur - 1.4, dur - 0.9, dur - 0.5);
    if (off > 0) {
      o.lidA = o.lidB = lerp(o.lidA, 0.65, off);
      o.look = lerp(o.look, HEAD_NAT, off);
      hnd(o, 0, lerp(I.cx, I.ex + 0.02, off), lerp(I.cy, I.ey + 0.12, off), 0.14);
    }
    icon(o, 0, SK.GLINT, t, 2.0, 0.5, I.ex + 0.06, I.ey + 0.04, 0.1, 0.38, 0.0, 0);
    icon(o, 1, SK.GLINT, t, 5.2, 0.5, I.ex + 0.05, I.ey + 0.05, 0.1, 0.38, 0.0, 0);
    icon(o, 2, SK.NOTE, t, 3.4, 1.6, I.ex + 0.15, I.ey + 0.2, 0.1, 0.3, 0.6, 0.1);
    if (xing(st, 1.6)) cue(o, CUE.SIGH, 0.6);
    if (xing(st, 0.7)) cue(o, CUE.POP, 0.3);
    if (xing(st, 3.4)) cue(o, CUE.WHISTLE, 0.4);
  }

  /* ---------- SHIVER: cold: a sudden hunch, chattering teeth, breath puffs, hugging itself, rubbing hands
   * ---------- */
  function p_shiver(st, t, o, I) {
    const dur = st.dur,
      sh = sstep(0.1, 0.5, t) * (1 - sstep(dur - 1.4, dur - 0.6, t)),
      warm = win(t, dur - 1.6, dur - 1.2, dur - 0.5, dur - 0.2);
    o.yaw = 0.4 * sstep(0, 0.6, t) * (1 - sstep(dur - 0.7, dur - 0.1, t));
    o.sy = 1 - 0.12 * sh;
    o.sx = 1 + 0.05 * sh;
    o.ox = 0.02 * sin(TAU * 20 * t) * sh;
    o.oy = 0.006 * sin(TAU * 17 * t) * sh;
    o.lookW = 1; o.look = HEAD_NAT - 0.3 * sh; o.wob = 0.06 * sin(TAU * 16 * t) * sh;
    o.tint = 0.55 * sh * (1 - 0.7 * warm);
    face(o, 0.35 * sh, 1.0, 1, 0.2 * sin(t * 25), -0.2, 0.2 + 0.18 * sh * (0.5 + 0.5 * sin(TAU * 15 * t)), 1.5);
    if (t % 1.7 < 0.18) o.lidA = o.lidB = mx(o.lidA, 0.9);
    // hug itself; rub the hands at the end
    const hug = sh * (1 - warm);
    if (hug > 0)
      for (let q = 0; q < 2; q++) {
        const sg = q ? -1 : 1;
        hnd(o, q, I.cx + 0.12 + 0.015 * sin(t * 40 + q), lerp(I.cy, I.cy + 0.05, hug) + 0.012 * sin(t * 33), sg * lerp(0.07, 0.13, hug));
      }
    if (warm > 0)
      for (let q = 0; q < 2; q++) {
        const sg = q ? -1 : 1;
        hnd(o, q, I.ex + 0.1 + 0.04 * sin(t * 18 + q * PI), I.ey - 0.05, sg * 0.14);
      }
    if (warm > 0.2) {
      o.mo = lerp(o.mo, 0.4, warm);
      o.look = lerp(o.look, -1.15, warm);
    }
    for (let j = 0; j < 6; j++)
      if (xing(st, 0.7 + j * 1.05)) cue(o, CUE.PUFF, 0.8);
    if (xing(st, 0.15)) cue(o, CUE.SHIVER, 0.9);
    if (xing(st, dur - 1.5)) cue(o, CUE.PUFF, 1.0);
    o.sweat = 0;
  }

  /* ---------- FAN: hot: wilts, whips out a paper fan, fans itself with relief, wipes its brow ---------- */
  function p_fan(st, t, o, I) {
    const dur = st.dur, wilt = sstep(0.1, 0.7, t) * (1 - sstep(dur - 1.2, dur - 0.4, t)), fn = win(t, 1.3, 1.6, dur - 2.0, dur - 1.5);
    o.yaw = 0.45 * sstep(0, 0.6, t) * (1 - sstep(dur - 0.7, dur - 0.1, t));
    o.sy = 1 - 0.06 * wilt + 0.012 * sin(t * 6) * wilt; o.sx = 1 + 0.05 * wilt; o.ox = 0.015 * sin(t * 1.3) * wilt;
    o.lookW = 1; o.look = lerp(HEAD_NAT, -1.3, wilt); o.wob = 0.05 * sin(t * 2.3) * wilt + 0.04 * sin(TAU * 3.5 * t) * fn;
    face(o, 0.5 * wilt + 0.25 * fn, 1.0, 1, 0, -0.3, 0.3 * wilt * (1 - fn) + 0.07 * fn, 1.2 + 0.4 * fn);
    const fp = popk(t - 1.0), ang = 0.55 * sin(TAU * 3.5 * t) * fn;
    const hx = I.ex + 0.2 + 0.03 * sin(TAU * 3.5 * t) * fn, hy = I.ey + 0.2;
    const handOn = win(t, 0.9, 1.4, dur - 1.8, dur - 1.3);
    if (handOn > 0) hnd(o, 0, lerp(I.cx, hx, handOn), lerp(I.cy, hy, handOn), lerp(0.07, 0.16, handOn));
    if (fp > 0 && t < dur - 1.3) prp(o, P.FAN, hx - 0.02, hy + 0.02, 0.18, 0, 0.1, 0.5 + ang, 1.0 * mn(1, fp), 1);
    const wipe = win(t, dur - 1.8, dur - 1.5, dur - 0.7, dur - 0.4);
    if (wipe > 0) hnd(o, 1, lerp(I.cx, I.ex - 0.05 + 0.07 * sin(t * 14), wipe), lerp(I.cy, I.ey + 0.2, wipe), lerp(-0.07, 0.1, wipe));
    o.sweat = 0.7 * wilt * (1 - 0.6 * fn);
    if (xing(st, 0.3)) cue(o, CUE.SIGH, 0.9);
    if (xing(st, 1.1)) cue(o, CUE.POP, 0.3);
    if (xing(st, 2.6)) cue(o, CUE.SIGH, 0.4);
  }

  /* ---------- WAVE: spots the camera, turns to it, waves, winks ---------- */
  function p_wave(st, t, o, I) {
    const dur = st.dur, turn = sstep(0.1, 0.7, t) * (1 - sstep(dur - 0.9, dur - 0.2, t)), wv = win(t, 0.6, 0.9, dur - 1.4, dur - 1.1);
    o.yaw = 0.95 * turn; o.oy = 0.02 * abs1(sin(TAU * 2.2 * t)) * wv; o.sy = 1 + 0.03 * sin(TAU * 2.2 * t) * wv;
    o.lookW = 1; o.look = lerp(HEAD_NAT, -0.55, turn);
    face(o, 0, 1.1 * (1 + 0.15 * win(t, 0, 0.1, 0.2, 0.5)), 1, -0.85 * turn, 0.1, 0.1 + 0.05 * wv, 1.0 + 0.7 * turn);
    const wink = win(t, 2.65, 2.8, 3.0, 3.1);
    o.lidA = mx(o.lidA, wink);
    o.mo = lerp(o.mo, 0.25, wink);
    if (wv > 0) hnd(o, 0, lerp(I.cx, I.cx + 0.12 + 0.1 * sin(TAU * 4.5 * t), wv), lerp(I.cy, I.cy + 0.46, wv), lerp(0.07, 0.22, wv));
    icon(o, 0, SK.HEART, t, 2.9, 1.2, I.ex + 0.1, I.ey + 0.3, 0.2, 0.38, 0.5, 0.05);
    if (xing(st, 0.15)) cue(o, CUE.POP, 0.4);
    if (xing(st, 0.9)) cue(o, CUE.WHISTLE, 0.3);
  }

  /* ---------- UMBRELLA: rain: a drop on the nose, a tiny umbrella, content under it, a stomp in a puddle, shakes it
   * dry and puts it away ---------- */
  function p_umbrella(st, t, o, I) {
    const dur = st.dur, up = win(t, 1.0, 1.5, dur - 2.2, dur - 1.7), shake = win(t, dur - 1.7, dur - 1.5, dur - 0.9, dur - 0.7);
    o.yaw = 0.5 * sstep(0.3, 1.0, t) * (1 - sstep(dur - 0.8, dur - 0.1, t));
    const drop = win(t, 0.2, 0.4, 0.8, 1.1);
    o.sy = 1 - 0.05 * drop - 0.03 * win(t, 0, 0.4, 0.8, 1.2) + 0.03 * up * sin(t * 2.2);
    o.lookW = 1; o.look = lerp(HEAD_NAT, -0.35, drop) + 0.12 * sin(t * 1.7) * up;
    o.oy = 0.1 * win(t, 4.1, 4.2, 4.3, 4.45) + 0.03 * sin(TAU * 8 * t) * shake;
    o.wob = 0.25 * sin(TAU * 7 * t) * shake;
    face(o, 0.45 * drop + 0.15 * up, 1.0, 1, 0.3 * sin(t * 1.3) * up, 0.4 * up, 0.15 * up + 0.2 * shake, 1.2 + 0.4 * up);
    const pop = popk(t - 1.0) * (1 - sstep(dur - 1.0, dur - 0.7, t));
    const hx = I.ex - 0.08, hy = I.ey + 0.12, sway = 0.05 * sin(t * 1.4) * up;
    const handOn = win(t, 0.8, 1.2, dur - 1.1, dur - 0.7);
    if (handOn > 0) hnd(o, 0, lerp(I.cx, hx, handOn), lerp(I.cy, hy, handOn), lerp(0.07, 0.18, handOn));
    if (pop > 0)
      prp(o, P.UMB, hx, hy, 0.18, 0, 0.1, sway - 0.1 * shake * sin(TAU * 7 * t), mn(1, pop), 1 - 0.7 * sstep(dur - 1.7, dur - 1.3, t));
    o.sweat = 0;
    icon(o, 1, SK.NOTE, t, 3.0, 1.6, I.ex + 0.1, I.ey + 0.25, 0.1, 0.3, 0.6, 0.1);
    if (xing(st, 0.3)) cue(o, CUE.SIGH, 0.5);
    if (xing(st, 1.0)) cue(o, CUE.POP, 0.5);
    if (xing(st, 4.15)) cue(o, CUE.PLOP, 0.6);
    if (xing(st, 3.0)) cue(o, CUE.WHISTLE, 0.4);
    if (xing(st, dur - 1.6)) cue(o, CUE.SHIVER, 0.5);
    for (let j = 0; j < 4; j++)
      if (xing(st, dur - 1.6 + j * 0.15)) cue(o, CUE.SWEAT, 0.5);
  }
  function abs1(x) { return x < 0 ? -x : x; }

  /* ================= the machine ================= */
  const DUR = [0, 0, 12.5, 24, 8.6, 9.4, 10.4, 9.2, 7.4, 8.2, 4.6, 8.4];
  ID.dur_of = function (st, kind) { return kind === K.JUGGLE ? jtimes(st).dur : DUR[kind]; };
  function weight(kind, I) {
    switch (kind) {
      case K.JUGGLE: return 1.0;
      case K.PHONE: return 1.0;
      case K.SLEEP: return 0.9 + 1.4 * I.night;
      case K.WATCH: return 0.8;
      case K.EXERCISE: return I.cold > 0.5 ? 0.3 : 0.7;
      case K.MAP: return 0.7;
      case K.SUN: return I.sunny > 0.5 && I.cold < 0.5 ? 1.8 * I.sunny : 0;
      case K.SHIVER: return I.cold > 0.5 ? 3.5 : 0;
      case K.FAN: return I.hot > 0.5 ? 3.5 : 0;
      case K.WAVE: return 0.6;
      case K.UMBRELLA: return I.rain > 0.5 ? 3.5 : 0;
      default: return 0;
    }
  }
  function pick(st, I) {
    let tot = 0;
    const w = [];
    for (let k = 1; k < K.N; k++) {
      const q = (k === st.last[0] || k === st.last[1]) ? 0 : weight(k, I);
      w[k] = q;
      tot += q;
    }
    if (tot <= 0) return K.PHONE;
    let r = M.rng_next(st.rng) * tot;
    for (let k = 1; k < K.N; k++) {
      r -= w[k];
      if (r <= 0 && w[k] > 0) return k;
    }
    return K.PHONE;
  }
  function start(st, kind) {
    const r = st.rng, v = st.v;
    v.fill(0);
    if (kind === K.JUGGLE) v[0] = 9 + M.rng_int(r, 4);
    else if (kind === K.PHONE) {
      v[0] = 6.0 + M.rng_range(r, 0, 0.8);
      v[1] = 9.0 + M.rng_range(r, 0, 0.8);
      v[2] = 7.6 + M.rng_range(r, 0, 0.6);
    }
    st.state = ST.PLAY;
    st.kind = kind;
    st.t = 0;
    st.tPrev = -1;
    st.count++;
    st.startled = 0;
    st.dur = ID.dur_of(st, kind);
    if (kind === K.SLEEP) st.dur = 20 + M.rng_range(r, 0, 6);
    if (kind === K.PHONE) st.dur = 12.5 + M.rng_range(r, 0, 1.5);
  }
  /* the boredom threshold (s): a random point (boredU) of 6..12 s for a waiting worm, 9..16 s for the active one, 5..9
   * s after an antic */
  ID.bored_at = function (st, active) {
    const u = st.boredU;
    return active ? lerp(BORED.ALO, BORED.AHI, u) : st.cool ? lerp(BORED.CLO, BORED.CHI, u) : lerp(BORED.LO, BORED.HI, u);
  };
  function schedule(st, cool) {
    st.boredU = M.rng_next(st.rng);
    st.cool = cool;
    st.idleT = 0;
  }
  function finish(st, I) {
    st.last[1] = st.last[0];
    st.last[0] = st.kind;
    st.kind = K.NONE;
    st.state = ST.WAIT;
    st.t = 0;
    schedule(st, 1);
  }
  function run(st, t, o, I) {
    switch (st.kind) {
      case K.JUGGLE: p_juggle(st, t, o, I); break;
      case K.PHONE: p_phone(st, t, o, I); break;
      case K.SLEEP: p_sleep(st, t, o, I); break;
      case K.WATCH: p_watch(st, t, o, I); break;
      case K.EXERCISE: p_exercise(st, t, o, I); break;
      case K.MAP: p_map(st, t, o, I); break;
      case K.SUN: p_sun(st, t, o, I); break;
      case K.SHIVER: p_shiver(st, t, o, I); break;
      case K.FAN: p_fan(st, t, o, I); break;
      case K.WAVE: p_wave(st, t, o, I); break;
      case K.UMBRELLA: p_umbrella(st, t, o, I); break;
      default: break;
    }
  }
  /* one step: I = input struct (make_in), o = output struct (make_out; filled every call; o.ncue cues to consume) */
  ID.step = function (st, dt, I, o) {
    clear_out(o);
    st.tPrev = st.t;
    if (I.force > 0 && I.force < K.N) {
      start(st, I.force | 0);
      st.idleT = 0;
    }
    switch (st.state) {
      case ST.WAIT: {
        if (!I.calm || I.disturb) st.idleT = 0;
        else if (I.visible) st.idleT += dt;
        if (st.idleT >= ID.bored_at(st, I.active) && I.allow && I.calm && I.visible) {
          st.idleT = 0;
          start(st, pick(st, I));
        }
        st.tPrev = -1; st.t = 0;
        break;
      }
      case ST.PLAY: {
        if (I.disturb || !I.calm || !I.visible) {
          if (st.kind === K.SLEEP && st.t > 1.2 && I.visible && I.disturb !== 3) {
            st.state = ST.STARTLE;
            st.t = 0;
            st.tPrev = -1;
            st.cause = I.disturb;
            st.startled = 1;
          }
          else {
            st.state = ST.OUT;
            st.tOut = 0;
          }
        } else {
          st.t += dt;
          if (st.t >= st.dur) { finish(st, I); }
        }
        break;
      }
      case ST.STARTLE: {
        if (I.disturb === 2 || !I.visible) {
          st.state = ST.OUT;
          st.tOut = 0;
          break;
        }
        st.t += dt;
        if (st.t >= BORED.STARTLE) finish(st, I);
        break;
      }
      case ST.OUT: {
        st.tOut += dt;
        if (st.tOut >= BORED.OUT) {
          st.state = ST.WAIT;
          st.kind = K.NONE;
          st.t = 0;
          st.tPrev = -1;
          schedule(st, 1);
        }
        break;
      }
      default: break;
    }
    // the blend weight k and the program pose
    o.kind = st.kind; o.state = st.state; o.t = st.t;
    if (st.state === ST.PLAY) {
      const kin = sstep(0, 0.35, st.t), kout = 1 - sstep(st.dur - 0.35, st.dur, st.t);
      st.k = mn(kin, kout < 0.001 ? 0 : kout);
      run(st, st.t, o, I); o.pk = 1;
    } else if (st.state === ST.STARTLE) {
      st.k = 1 - sstep(BORED.STARTLE - 0.3, BORED.STARTLE, st.t);
      p_startle(st, st.t, o, I); o.pk = 1;
    } else if (st.state === ST.OUT) {
      const f = 1 - st.tOut / BORED.OUT;
      st.k = f * f * (3 - 2 * f);
      st.tPrev = st.t;
      if (st.startled) p_startle(st, st.t, o, I);
      else run(st, st.t, o, I);
      o.ncue = 0; o.pk = mx(0, 1 - st.tOut / (BORED.OUT * 0.6));
    } else st.k = 0;
    const k = st.k;
    o.k = k;
    o.sx = 1 + (o.sx - 1) * k;
    o.sy = 1 + (o.sy - 1) * k;
    o.ox *= k;
    o.oy *= k;
    o.yaw *= k;
    o.lookW *= k;
    o.wob *= k;
    o.hideHeld = st.state !== ST.WAIT ? 1 : 0;
    return o;
  };
  /* a studio / test helper: start a given kind now (even when not bored) */
  ID.force = function (st, kind) {
    st.state = ST.WAIT;
    st.idleT = 0;
    start(st, kind);
  };
  ID.reset = function (st) {
    st.state = ST.WAIT;
    st.kind = K.NONE;
    st.t = 0;
    st.tPrev = -1;
    st.idleT = 0;
    st.k = 0;
  };
})(window.SS = window.SS || {});
