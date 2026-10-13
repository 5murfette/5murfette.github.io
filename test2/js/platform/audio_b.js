/* platform/audio_b.js — P37 W4 sounds of the new weapons, skills and the force field: procedural WebAudio built on the
 * primitives platform/audio.js exports (AU.synth: tone, noise, S2), driven only by sim events. Every sound first asks
 * for a recorded sample by id (assets/sfx/manifest.js, ids below, the same S2 path as the rest) and falls back to the
 * synthesised version, so recordings can replace them one by one:
 *   dog_start dog_bark dog_hop dog_boom punch_swing punch_hit sentry_plant sentry_lock sentry_shot sentry_down
 *   claymore_plant claymore_arm claymore_blast ff_plant ff_ripple ff_bounce ff_contain ff_break ff_release grav_grab
 *   grav_throw skill_get skill_end overload torch_ignite
 * Math.random is fine here: presentation only. */
(function (SS) {
  'use strict';
  const AU = SS.audio;
  if (!AU || !AU.synth) return;
  const { tone, noise, S2 } = AU.synth;
  const rnd = (a, b) => a + Math.random() * (b - a);
  let lastShot = 0;
  const FX = {
    dog_start() {
      tone('sawtooth', 90, 260, 0.35, 0.12);
      tone('square', 900, 1400, 0.07, 0.1, 0.005, 0.28);
      noise(0.25, 'bandpass', 1800, 2, 0.1, 600);
    },
    dog_bark() {
      const f = rnd(300, 380);
      tone('square', f, f * 0.55, 0.11, 0.16);
      tone('sawtooth', f * 1.5, f * 0.6, 0.09, 0.08);
      noise(0.1, 'bandpass', 1500, 1.5, 0.18, 500);
    },
    dog_hop() {
      tone('triangle', 200, 110, 0.1, 0.18);
      noise(0.06, 'highpass', 3000, 0.7, 0.12);
    },
    dog_boom() {
      tone('square', 1200, 300, 0.2, 0.15);
      noise(0.18, 'highpass', 2500, 0.8, 0.3);
    },
    punch_swing() { noise(0.25, 'bandpass', 500, 1.2, 0.35, 2600); },
    punch_hit() {
      AU.sfx.bat();
      tone('sine', 100, 40, 0.3, 0.5);
      noise(0.14, 'lowpass', 900, 1, 0.5, 200);
    },
    sentry_plant() {
      AU.sfx.clank();
      tone('sawtooth', 120, 300, 0.3, 0.08, 0.01, 0.1);
    },
    sentry_lock() {
      tone('square', 1500, 1500, 0.06, 0.12);
      tone('square', 1900, 1900, 0.06, 0.12, 0.005, 0.09);
    },
    sentry_shot() {
      const n = performance.now();
      if (n - lastShot < 45) return;
      lastShot = n;
      noise(0.07, 'highpass', 1800, 0.6, 0.35, 700);
      tone('square', 160, 80, 0.05, 0.18);
    },
    sentry_down() {
      AU.sfx.metal(0.9);
      noise(0.3, 'lowpass', 600, 1, 0.4, 150);
    },
    claymore_plant() {
      tone('square', 900, 900, 0.03, 0.1);
      tone('square', 900, 900, 0.03, 0.1, 0.005, 0.07);
      tone('square', 1100, 1100, 0.03, 0.1, 0.005, 0.14);
    },
    claymore_arm() {
      for (let i = 0; i < 3; i++) tone('square', 1500, 1500, 0.07, 0.12, 0.005, i * 0.13);
    },
    claymore_blast() {
      noise(0.35, 'highpass', 1200, 0.7, 0.7, 300);
      tone('sine', 120, 40, 0.4, 0.55);
      noise(0.5, 'lowpass', 900, 0.8, 0.5, 120, 1, 0.03);
    },
    ff_plant() {
      tone('sine', 110, 420, 0.7, 0.18, 0.1);
      tone('triangle', 220, 840, 0.7, 0.08, 0.1);
      tone('sine', 1600, 1600, 0.12, 0.08, 0.005, 0.65);
    },
    ff_ripple() { [1318, 1760, 2349].forEach((f, i) => tone('sine', f, f * 0.99, 0.5, 0.08 / (i + 1), 0.004, i * 0.03)); },
    ff_bounce() {
      tone('sine', 2200, 280, 0.32, 0.25);
      noise(0.22, 'bandpass', 3000, 1.5, 0.22, 900);
      [1568, 2093].forEach((f, i) => tone('sine', f, f, 0.5, 0.07, 0.004, 0.05 + i * 0.04));
    },
    ff_contain() {
      tone('sine', 70, 38, 0.8, 0.5);
      [880, 1175, 1568].forEach((f, i) => tone('sine', f, f * 0.98, 0.7, 0.07, 0.004, i * 0.05));
    },
    ff_break() {
      for (let i = 0; i < 6; i++) noise(0.14, 'highpass', 3500 + i * 300, 0.8, 0.22, 2000, 1, i * 0.05);
      [2093, 2637, 3136].forEach((f, i) => tone('sine', f, f * 0.9, 0.4, 0.06, 0.004, i * 0.06));
    },
    ff_release() {
      tone('sine', 90, 28, 1.0, 0.55);
      noise(0.9, 'lowpass', 600, 0.8, 0.45, 80);
    },
    grav_grab() {
      tone('sine', 180, 900, 0.22, 0.2);
      tone('triangle', 360, 1500, 0.22, 0.08);
    },
    grav_throw() {
      noise(0.3, 'bandpass', 600, 1.2, 0.3, 3000);
      tone('sine', 900, 150, 0.25, 0.22);
    },
    skill_get() { [523, 659, 784, 988, 1319].forEach((f, i) => tone('triangle', f, f, 0.14, 0.17, 0.005, i * 0.06)); },
    skill_end() { [784, 587, 440].forEach((f, i) => tone('triangle', f, f, 0.14, 0.1, 0.005, i * 0.08)); },
    overload() {
      for (let i = 0; i < 10; i++) tone('triangle', 500 + i * 90, 500 + i * 90, 0.14, 0.13, 0.005, i * 0.07);
    },
    torch_ignite() {
      noise(0.35, 'bandpass', 400, 1.4, 0.4, 2400);
      tone('sine', 70, 45, 0.4, 0.25);
    }
  };
  const prev = AU.extra;
  AU.extra = function (S, e) {
    if (prev) prev(S, e);
    switch (e.type) {
      case 'dogstart': S2('dog_start', 0.8, 1, FX.dog_start); break;
      case 'dogbark': S2('dog_bark', 0.8, 1, FX.dog_bark); break;
      case 'doghop': S2('dog_hop', 0.6, 1, FX.dog_hop); break;
      case 'dogboom': S2('dog_boom', 0.7, 1, FX.dog_boom); break;
      case 'punch': S2('punch_swing', 0.8, 1, FX.punch_swing); break;
      case 'punchhit': S2('punch_hit', 1, 1, FX.punch_hit); break;
      case 'sentryplant': S2('sentry_plant', 0.8, 1, FX.sentry_plant); break;
      case 'sentrydetect': S2('sentry_lock', 0.8, 1, FX.sentry_lock); break;
      case 'sgshot': S2('sentry_shot', 0.5, 1, FX.sentry_shot); break;
      case 'sentrydown': S2('sentry_down', 0.9, 1, FX.sentry_down); break;
      case 'claymoreplant': S2('claymore_plant', 0.7, 1, FX.claymore_plant); break;
      case 'claymorearm': S2('claymore_arm', 0.7, 1, FX.claymore_arm); break;
      case 'claymoreblast': S2('claymore_blast', 1, 1, FX.claymore_blast); break;
      case 'ffplant': S2('ff_plant', 0.8, 1, FX.ff_plant); break;
      case 'ffripple': S2('ff_ripple', 0.5, 1, FX.ff_ripple); break;
      case 'ffbounce': S2('ff_bounce', 0.9, 1, FX.ff_bounce); break;
      case 'ffcontain': S2('ff_contain', 0.9, 1, FX.ff_contain); break;
      case 'ffbreak': S2('ff_break', 0.9, 1, FX.ff_break); break;
      case 'ffrelease': S2('ff_release', 1, 1, FX.ff_release); break;
      case 'grab': S2('grav_grab', 0.7, 1, FX.grav_grab); break;
      case 'gravthrow': S2('grav_throw', 0.8, 1, FX.grav_throw); break;
      case 'skillget': S2('skill_get', 0.8, 1, FX.skill_get); break;
      case 'skillend': S2('skill_end', 0.6, 1, FX.skill_end); break;
      case 'overload': S2('overload', 0.9, 1, FX.overload); break;
      case 'dig': S2('torch_ignite', 0.8, 1, FX.torch_ignite); break;
    }
  };
})(window.SS = window.SS || {});
