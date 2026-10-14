/* platform/audio_c.js — P38-A4: sounds of the alien events (eggs, face huggers, the chest-burst alien and its acid),
 * the acid
 * damage to trees / steel, and the thrown supply crate. Procedural WebAudio from the primitives platform/audio.js
 * exports (SS.audio.synth), driven only by sim events (presentation only: Math.random is fine). Every sound first asks
 * for a recorded sample by id (assets/sfx/manifest.js; ids below, prompts in docs/SOUND_PROMPTS.md "P38 alien events")
 * and falls back to the synthesised version:
 *   egg_open egg_hatch egg_break hugger_leap hugger_attach hugger_die alien_born alien_hiss alien_strike alien_wrap
 *   alien_bite alien_eat alien_sleep alien_wake alien_hurt alien_burst acid_sizzle acid_hit acid_tree acid_steel
 *   crate_hit crate_drop P47: hugger_detach parasite_pulse chest_burst embryo_lost (the parasite: the face hugger lets
 *   go, the heartbeat-and-cough hit every minute, the burst out of the chest, the embryo that dies with its host)
 * Events -> ids: egg_open egg_hatch egg_break hugger_leap hugger_attach hugger_die alien_born alien_hiss alien_strike
 * alien_wrap alien_bite alien_eat alien_sleep alien_wake alien_hurt alien_burst acid_land acid_hit treeacid
 * steelcut{acid} cratehit cratedrop hugger_detach parasite_pulse chest_burst embryo_lost. */
(function (SS) {
  'use strict';
  const AU = SS.audio;
  if (!AU || !AU.synth) return;
  const { tone, noise, S2 } = AU.synth;
  const rnd = (a, b) => a + Math.random() * (b - a);
  // wet squelch: a bandpass sweep over noise plus a short falling "blup"
  const squelch = (v, f0, f1, d) => {
    noise(0.16, 'bandpass', f0, 4, 0.3 * v, f1, 1, d || 0);
    tone('sine', 260 * v + 80, 70, 0.14, 0.2 * v, 0.004, d || 0);
  };
  const FX = {
    egg_open() {
      noise(0.7, 'bandpass', 500, 2.5, 0.22, 140);
      [0, 0.17, 0.34].forEach(d => {
        noise(0.05, 'highpass', 2500, 1, 0.3, 900, 1, d);
        tone('square', 150, 70, 0.06, 0.16, 0.002, d);
      });
      squelch(1, 700, 180, 0.45);
      tone('sawtooth', 70, 38, 0.8, 0.12, 0.05, 0.1);
    },
    egg_hatch() {
      squelch(1.3, 900, 150);
      noise(0.3, 'lowpass', 700, 1, 0.35, 120, 1, 0.04);
      tone('triangle', 520, 260, 0.2, 0.12, 0.004, 0.08);
    },
    egg_break() {
      noise(0.14, 'highpass', 1800, 0.8, 0.4, 700);
      squelch(1.1, 800, 200, 0.02);
      tone('sine', 130, 50, 0.25, 0.35);
    },
    hugger_leap() {
      noise(0.22, 'bandpass', 900, 1.5, 0.28, 3500);
      [1700, 2300].forEach((f, i) => tone('square', f, f * 1.4, 0.05, 0.09, 0.004, i * 0.07));
      tone('sawtooth', 340, 900, 0.16, 0.09, 0.004);
    },
    hugger_attach() {
      noise(0.09, 'lowpass', 1500, 1, 0.5, 400);
      squelch(1, 1000, 250, 0.03);
      tone('sawtooth', 1300, 520, 0.25, 0.1, 0.004, 0.06);
      noise(0.3, 'bandpass', 1800, 3, 0.1, 900, 1, 0.1);
    },
    hugger_die() {
      tone('sawtooth', 1500, 380, 0.3, 0.14, 0.003);
      tone('square', 900, 250, 0.2, 0.07, 0.003, 0.03);
      squelch(0.9, 700, 150, 0.14);
    },
    alien_born() {
      noise(0.45, 'bandpass', 1200, 1.6, 0.4, 250);
      [0, 0.07, 0.13, 0.22].forEach(d => noise(0.06, 'highpass', 2200, 0.8, 0.35, 800, 1, d));
      tone('sine', 90, 35, 0.5, 0.5, 0.01, 0.0);
      tone('sawtooth', 700, 1900, 0.5, 0.17, 0.05, 0.25);
      tone('sawtooth', 1050, 2600, 0.5, 0.09, 0.05, 0.25);
      noise(0.5, 'bandpass', 3000, 2, 0.12, 4200, 1, 0.3);
      squelch(1.2, 900, 120, 0.05);
    },
    alien_hiss() {
      noise(1.0, 'highpass', 3400, 0.6, 0.26, 7000);
      noise(0.9, 'bandpass', 5200, 1.2, 0.14, 3000, 1, 0.05);
      tone('sawtooth', 180, 120, 0.9, 0.05, 0.1);
      [0, 0.25, 0.5].forEach(d => noise(0.14, 'bandpass', 2500, 2, 0.08, 1500, 1, d));
    },
    alien_sleep() {
      noise(0.9, 'lowpass', 500, 0.8, 0.12, 180);
      tone('sine', 110, 60, 0.9, 0.1, 0.2);
      tone('sine', 82, 50, 1.1, 0.08, 0.3, 0.5);
    },
    alien_wake() {
      noise(0.7, 'bandpass', 900, 1.2, 0.3, 2800, 1, 0.1);
      tone('sawtooth', 70, 190, 0.9, 0.2, 0.05);
      tone('sawtooth', 105, 260, 0.8, 0.1, 0.05, 0.05);
      squelch(0.8, 700, 150, 0.2);
    },
    alien_strike() {
      noise(0.18, 'bandpass', 1200, 1.2, 0.4, 5200);
      tone('sawtooth', 600, 1800, 0.35, 0.2, 0.004, 0.02);
      tone('sawtooth', 900, 2700, 0.35, 0.09, 0.004, 0.02);
      noise(0.35, 'highpass', 3500, 0.8, 0.22, 6500, 1, 0.05);
    },
    alien_wrap() {
      noise(0.6, 'bandpass', 600, 3, 0.2, 280);
      [0, 0.15, 0.3, 0.45].forEach(d => tone('triangle', 130 + d * 100, 80, 0.12, 0.07, 0.004, d));
    },
    alien_bite() {
      [0, 0.06].forEach(d => {
        noise(0.07, 'highpass', 1500, 0.9, 0.5, 600, 1, d);
        tone('square', 210, 80, 0.05, 0.2, 0.002, d);
      });
      tone('triangle', 2600, 1600, 0.1, 0.1, 0.002, 0.03);
      noise(0.4, 'bandpass', 700, 2, 0.2, 200, 1, 0.08);
    },
    alien_eat() {
      for (let i = 0; i < 4; i++) {
        noise(0.1, 'bandpass', rnd(500, 900), 3, 0.28, 250, 1, i * 0.16);
        tone('sine', rnd(160, 230), 70, 0.09, 0.12, 0.004, i * 0.16);
      }
    },
    alien_hurt() {
      tone('sawtooth', 1900, 700, 0.4, 0.16, 0.004);
      tone('sawtooth', 1250, 450, 0.4, 0.1, 0.004, 0.02);
      noise(0.35, 'bandpass', 3500, 2.5, 0.14, 1600);
    },
    alien_burst() {
      noise(0.5, 'lowpass', 1500, 0.8, 0.55, 150);
      tone('sine', 100, 34, 0.55, 0.55);
      noise(0.7, 'highpass', 3500, 0.6, 0.3, 7500, 1, 0.02);
      tone('sawtooth', 1500, 300, 0.5, 0.15, 0.004, 0.02);
    },
    hugger_detach() {
      tone('sawtooth', 900, 260, 0.35, 0.1, 0.004);
      squelch(0.9, 1100, 250, 0.04);
      noise(0.25, 'bandpass', 2200, 2, 0.12, 900, 1, 0.1);
      tone('sine', 120, 60, 0.3, 0.25, 0.01, 0.2);
    },
    parasite_pulse() {
      [0, 0.16].forEach(d => tone('sine', 62, 38, 0.18, 0.5, 0.004, d));
      noise(0.22, 'bandpass', 700, 2.5, 0.3, 260, 1, 0.34);
      tone('sawtooth', 240, 120, 0.28, 0.1, 0.01, 0.36);
      squelch(0.7, 600, 200, 0.5);
    },
    chest_burst() {
      noise(0.5, 'lowpass', 1400, 0.8, 0.6, 130);
      [0, 0.05, 0.12, 0.2].forEach(d => {
        noise(0.05, 'highpass', 2200, 0.8, 0.4, 700, 1, d);
        tone('square', 180 - d * 200, 70, 0.05, 0.22, 0.002, d);
      });
      squelch(1.4, 900, 160, 0.02);
      tone('sine', 85, 34, 0.6, 0.55);
    },
    // P84: a health crate cured the infection
    cure() {
      tone('sine', 520, 880, 0.35, 0.16);
      tone('sine', 780, 1320, 0.3, 0.1, 0.003, 0.1);
      noise(0.2, 'highpass', 4000, 0.6, 0.06, 7000, 1, 0.05);
    },
    embryo_lost() {
      squelch(0.9, 700, 140);
      tone('sawtooth', 700, 180, 0.4, 0.09, 0.004, 0.05);
      noise(0.3, 'lowpass', 600, 1, 0.2, 140, 1, 0.1);
    },
    acid_sizzle() {
      noise(0.55, 'highpass', 4200, 0.5, 0.2, 7000);
      noise(0.45, 'bandpass', 2600, 1.5, 0.1, 4200);
      for (let i = 0; i < 4; i++) noise(0.03, 'highpass', 5000, 0.8, 0.18, 8000, 1, rnd(0, 0.45));
    },
    acid_hit() {
      noise(0.4, 'highpass', 3800, 0.6, 0.28, 7500);
      tone('sawtooth', 1700, 500, 0.22, 0.08, 0.004);
      squelch(0.8, 1200, 300, 0.01);
    },
    acid_tree() {
      noise(0.6, 'highpass', 3600, 0.6, 0.2, 7000);
      [0, 0.2, 0.42].forEach(d => {
        noise(0.06, 'bandpass', 700, 2, 0.35, 300, 1, d);
        tone('triangle', 220 - d * 120, 90, 0.07, 0.15, 0.002, d);
      });
      noise(0.5, 'lowpass', 500, 1, 0.3, 120, 1, 0.55);
    },
    acid_steel() {
      noise(0.5, 'highpass', 4500, 0.6, 0.18, 8000);
      tone('sawtooth', 260, 140, 0.5, 0.1, 0.02);
      tone('square', 90, 60, 0.35, 0.08, 0.01, 0.1);
      tone('triangle', 1800, 900, 0.25, 0.1, 0.003, 0.2);
    },
    crate_hit() {
      tone('sine', 150, 60, 0.18, 0.45);
      noise(0.1, 'bandpass', 900, 1.5, 0.4, 400);
      noise(0.08, 'highpass', 2500, 0.8, 0.22, 900, 1, 0.02);
    },
    crate_drop() {
      tone('sine', 110, 45, 0.15, 0.4);
      noise(0.1, 'lowpass', 600, 0.9, 0.3, 160);
    }
  };
  AU.rows([
    ['egg_open', 'egg_open', 0.9, 1, FX.egg_open],
    ['egg_hatch', 'egg_hatch', 0.9, 1, FX.egg_hatch],
    ['egg_break', 'egg_break', 0.9, 1, FX.egg_break],
    ['hugger_leap', 'hugger_leap', 0.8, 1, FX.hugger_leap],
    ['hugger_attach', 'hugger_attach', 0.9, 1, FX.hugger_attach],
    ['hugger_detach', 'hugger_detach', 0.85, 1, FX.hugger_detach],
    ['parasite_pulse', 'parasite_pulse', 0.9, 1, FX.parasite_pulse],
    ['chest_burst', 'chest_burst', 1, 1, FX.chest_burst],
    ['embryo_lost', 'embryo_lost', 0.8, 1, FX.embryo_lost],
    ['cure', 'crate_pickup', 0.8, 1.25, FX.cure],
    ['alien_born', 'alien_born', 1, 1, FX.alien_born],
    ['alien_hiss', 'alien_hiss', 0.8, 1, FX.alien_hiss],
    ['alien_sleep', 'alien_sleep', 0.5, 1, FX.alien_sleep],
    ['alien_wake', 'alien_wake', 0.9, 1, FX.alien_wake],
    ['alien_strike', 'alien_strike', 0.9, 1, FX.alien_strike],
    ['alien_wrap', 'alien_wrap', 0.7, 1, FX.alien_wrap],
    ['alien_bite', 'alien_bite', 1, 1, FX.alien_bite],
    ['alien_eat', 'alien_eat', 0.7, 1, FX.alien_eat],
    ['alien_burst', 'alien_burst', 1, 1, FX.alien_burst],
    ['acid_hit', 'acid_hit', 0.8, 1, FX.acid_hit],
    ['treeacid', 'acid_tree', 0.9, 1, FX.acid_tree],
    ['cratehit', 'crate_hit', 0.9, 1, FX.crate_hit],
    ['hugger_die', 'hugger_die', 0.8, 1, FX.hugger_die, 90],
    ['alien_hurt', 'alien_hurt', 0.8, 1, FX.alien_hurt, 120],
    ['acid_land', 'acid_sizzle', 0.5, 1, FX.acid_sizzle, 80]
  ]);
  // acid cutting steel sizzles (a blast cutting it: audio.js metal_cut)
  AU.on('steelcut', (S, e) => {
    if (e.acid) S2('acid_steel', 0.8, 1, FX.acid_steel);
  });
  // a crate landing hard thumps, louder the faster
  AU.on('cratedrop', (S, e) => {
    if (e.v > 3) S2('crate_drop', Math.min(0.9, 0.3 + e.v * 0.04), 1, FX.crate_drop);
  });
})(window.SS = window.SS || {});
