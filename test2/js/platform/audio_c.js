/* platform/audio_c.js — P38-A4: sounds of the alien events (eggs, face huggers, the chest-burst alien and its acid), the acid
 * damage to trees / steel, and the thrown supply crate. Procedural WebAudio from the primitives platform/audio.js exports
 * (SS.audio.synth), driven only by sim events (presentation only: Math.random is fine). Every sound first asks for a recorded
 * sample by id (assets/sfx/manifest.js; ids below, prompts in docs/SOUND_PROMPTS.md "P38 alien events") and falls back to
 * the synthesised version:
 *   egg_open egg_hatch egg_break hugger_leap hugger_attach hugger_die alien_born alien_hiss alien_strike alien_wrap alien_bite
 *   alien_eat alien_hurt alien_burst acid_sizzle acid_hit acid_tree acid_steel crate_hit crate_drop
 *   P47: hugger_detach parasite_pulse chest_burst embryo_lost (the parasite: the face hugger lets go, the heartbeat-and-cough hit every minute,
 *   the burst out of the chest, the embryo that dies with its host)
 * Events -> ids: egg_open egg_hatch egg_break hugger_leap hugger_attach hugger_die alien_born alien_hiss alien_strike
 * alien_wrap alien_bite alien_eat alien_hurt alien_burst acid_land acid_hit treeacid steelcut{acid} cratehit cratedrop hugger_detach parasite_pulse
 * chest_burst embryo_lost. */
(function (SS) {
  'use strict';
  const AU = SS.audio;
  if (!AU || !AU.synth) return;
  const { tone, noise, S2 } = AU.synth;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const last = {};
  const gate = (k, ms) => { const n = performance.now(); if (last[k] != null && n - last[k] < ms) return false; last[k] = n; return true; };
  // wet squelch: a bandpass sweep over noise plus a short falling "blup"
  const squelch = (v, f0, f1, d) => { noise(0.16, 'bandpass', f0, 4, 0.3 * v, f1, 1, d || 0); tone('sine', 260 * v + 80, 70, 0.14, 0.2 * v, 0.004, d || 0); };
  const FX = {
    egg_open() { noise(0.7, 'bandpass', 500, 2.5, 0.22, 140); [0, 0.17, 0.34].forEach(d => { noise(0.05, 'highpass', 2500, 1, 0.3, 900, 1, d); tone('square', 150, 70, 0.06, 0.16, 0.002, d); }); squelch(1, 700, 180, 0.45); tone('sawtooth', 70, 38, 0.8, 0.12, 0.05, 0.1); },
    egg_hatch() { squelch(1.3, 900, 150); noise(0.3, 'lowpass', 700, 1, 0.35, 120, 1, 0.04); tone('triangle', 520, 260, 0.2, 0.12, 0.004, 0.08); },
    egg_break() { noise(0.14, 'highpass', 1800, 0.8, 0.4, 700); squelch(1.1, 800, 200, 0.02); tone('sine', 130, 50, 0.25, 0.35); },
    hugger_leap() { noise(0.22, 'bandpass', 900, 1.5, 0.28, 3500); [1700, 2300].forEach((f, i) => tone('square', f, f * 1.4, 0.05, 0.09, 0.004, i * 0.07)); tone('sawtooth', 340, 900, 0.16, 0.09, 0.004); },
    hugger_attach() { noise(0.09, 'lowpass', 1500, 1, 0.5, 400); squelch(1, 1000, 250, 0.03); tone('sawtooth', 1300, 520, 0.25, 0.1, 0.004, 0.06); noise(0.3, 'bandpass', 1800, 3, 0.1, 900, 1, 0.1); },
    hugger_die() { tone('sawtooth', 1500, 380, 0.3, 0.14, 0.003); tone('square', 900, 250, 0.2, 0.07, 0.003, 0.03); squelch(0.9, 700, 150, 0.14); },
    alien_born() { noise(0.45, 'bandpass', 1200, 1.6, 0.4, 250); [0, 0.07, 0.13, 0.22].forEach(d => noise(0.06, 'highpass', 2200, 0.8, 0.35, 800, 1, d)); tone('sine', 90, 35, 0.5, 0.5, 0.01, 0.0);
      tone('sawtooth', 700, 1900, 0.5, 0.17, 0.05, 0.25); tone('sawtooth', 1050, 2600, 0.5, 0.09, 0.05, 0.25); noise(0.5, 'bandpass', 3000, 2, 0.12, 4200, 1, 0.3); squelch(1.2, 900, 120, 0.05); },
    alien_hiss() { noise(1.0, 'highpass', 3400, 0.6, 0.26, 7000); noise(0.9, 'bandpass', 5200, 1.2, 0.14, 3000, 1, 0.05); tone('sawtooth', 180, 120, 0.9, 0.05, 0.1); [0, 0.25, 0.5].forEach(d => noise(0.14, 'bandpass', 2500, 2, 0.08, 1500, 1, d)); },
    alien_strike() { noise(0.18, 'bandpass', 1200, 1.2, 0.4, 5200); tone('sawtooth', 600, 1800, 0.35, 0.2, 0.004, 0.02); tone('sawtooth', 900, 2700, 0.35, 0.09, 0.004, 0.02); noise(0.35, 'highpass', 3500, 0.8, 0.22, 6500, 1, 0.05); },
    alien_wrap() { noise(0.6, 'bandpass', 600, 3, 0.2, 280); [0, 0.15, 0.3, 0.45].forEach(d => tone('triangle', 130 + d * 100, 80, 0.12, 0.07, 0.004, d)); },
    alien_bite() { [0, 0.06].forEach(d => { noise(0.07, 'highpass', 1500, 0.9, 0.5, 600, 1, d); tone('square', 210, 80, 0.05, 0.2, 0.002, d); }); tone('triangle', 2600, 1600, 0.1, 0.1, 0.002, 0.03); noise(0.4, 'bandpass', 700, 2, 0.2, 200, 1, 0.08); },
    alien_eat() { for (let i = 0; i < 4; i++) { noise(0.1, 'bandpass', rnd(500, 900), 3, 0.28, 250, 1, i * 0.16); tone('sine', rnd(160, 230), 70, 0.09, 0.12, 0.004, i * 0.16); } },
    alien_hurt() { tone('sawtooth', 1900, 700, 0.4, 0.16, 0.004); tone('sawtooth', 1250, 450, 0.4, 0.1, 0.004, 0.02); noise(0.35, 'bandpass', 3500, 2.5, 0.14, 1600); },
    alien_burst() { noise(0.5, 'lowpass', 1500, 0.8, 0.55, 150); tone('sine', 100, 34, 0.55, 0.55); noise(0.7, 'highpass', 3500, 0.6, 0.3, 7500, 1, 0.02); tone('sawtooth', 1500, 300, 0.5, 0.15, 0.004, 0.02); },
    hugger_detach() { tone('sawtooth', 900, 260, 0.35, 0.1, 0.004); squelch(0.9, 1100, 250, 0.04); noise(0.25, 'bandpass', 2200, 2, 0.12, 900, 1, 0.1); tone('sine', 120, 60, 0.3, 0.25, 0.01, 0.2); },
    parasite_pulse() { [0, 0.16].forEach(d => tone('sine', 62, 38, 0.18, 0.5, 0.004, d)); noise(0.22, 'bandpass', 700, 2.5, 0.3, 260, 1, 0.34); tone('sawtooth', 240, 120, 0.28, 0.1, 0.01, 0.36); squelch(0.7, 600, 200, 0.5); },
    chest_burst() { noise(0.5, 'lowpass', 1400, 0.8, 0.6, 130); [0, 0.05, 0.12, 0.2].forEach(d => { noise(0.05, 'highpass', 2200, 0.8, 0.4, 700, 1, d); tone('square', 180 - d * 200, 70, 0.05, 0.22, 0.002, d); }); squelch(1.4, 900, 160, 0.02); tone('sine', 85, 34, 0.6, 0.55); },
    embryo_lost() { squelch(0.9, 700, 140); tone('sawtooth', 700, 180, 0.4, 0.09, 0.004, 0.05); noise(0.3, 'lowpass', 600, 1, 0.2, 140, 1, 0.1); },
    acid_sizzle() { noise(0.55, 'highpass', 4200, 0.5, 0.2, 7000); noise(0.45, 'bandpass', 2600, 1.5, 0.1, 4200); for (let i = 0; i < 4; i++) noise(0.03, 'highpass', 5000, 0.8, 0.18, 8000, 1, rnd(0, 0.45)); },
    acid_hit() { noise(0.4, 'highpass', 3800, 0.6, 0.28, 7500); tone('sawtooth', 1700, 500, 0.22, 0.08, 0.004); squelch(0.8, 1200, 300, 0.01); },
    acid_tree() { noise(0.6, 'highpass', 3600, 0.6, 0.2, 7000); [0, 0.2, 0.42].forEach(d => { noise(0.06, 'bandpass', 700, 2, 0.35, 300, 1, d); tone('triangle', 220 - d * 120, 90, 0.07, 0.15, 0.002, d); }); noise(0.5, 'lowpass', 500, 1, 0.3, 120, 1, 0.55); },
    acid_steel() { noise(0.5, 'highpass', 4500, 0.6, 0.18, 8000); tone('sawtooth', 260, 140, 0.5, 0.1, 0.02); tone('square', 90, 60, 0.35, 0.08, 0.01, 0.1); tone('triangle', 1800, 900, 0.25, 0.1, 0.003, 0.2); },
    crate_hit() { tone('sine', 150, 60, 0.18, 0.45); noise(0.1, 'bandpass', 900, 1.5, 0.4, 400); noise(0.08, 'highpass', 2500, 0.8, 0.22, 900, 1, 0.02); },
    crate_drop() { tone('sine', 110, 45, 0.15, 0.4); noise(0.1, 'lowpass', 600, 0.9, 0.3, 160); }
  };
  const prev = AU.extra;
  AU.extra = function (S, e) {
    if (prev) prev(S, e);
    switch (e.type) {
      case 'egg_open': S2('egg_open', 0.9, 1, FX.egg_open); break;
      case 'egg_hatch': S2('egg_hatch', 0.9, 1, FX.egg_hatch); break;
      case 'egg_break': S2('egg_break', 0.9, 1, FX.egg_break); break;
      case 'hugger_leap': S2('hugger_leap', 0.8, 1, FX.hugger_leap); break;
      case 'hugger_attach': S2('hugger_attach', 0.9, 1, FX.hugger_attach); break;
      case 'hugger_die': if (gate('hdie', 90)) S2('hugger_die', 0.8, 1, FX.hugger_die); break;
      case 'hugger_detach': S2('hugger_detach', 0.85, 1, FX.hugger_detach); break;
      case 'parasite_pulse': S2('parasite_pulse', 0.9, 1, FX.parasite_pulse); break;
      case 'chest_burst': S2('chest_burst', 1, 1, FX.chest_burst); break;
      case 'embryo_lost': S2('embryo_lost', 0.8, 1, FX.embryo_lost); break;
      case 'alien_born': S2('alien_born', 1, 1, FX.alien_born); break;
      case 'alien_hiss': S2('alien_hiss', 0.8, 1, FX.alien_hiss); break;
      case 'alien_strike': S2('alien_strike', 0.9, 1, FX.alien_strike); break;
      case 'alien_wrap': S2('alien_wrap', 0.7, 1, FX.alien_wrap); break;
      case 'alien_bite': S2('alien_bite', 1, 1, FX.alien_bite); break;
      case 'alien_eat': S2('alien_eat', 0.7, 1, FX.alien_eat); break;
      case 'alien_hurt': if (gate('ahurt', 120)) S2('alien_hurt', 0.8, 1, FX.alien_hurt); break;
      case 'alien_burst': S2('alien_burst', 1, 1, FX.alien_burst); break;
      case 'acid_land': if (gate('aland', 80)) S2('acid_sizzle', 0.5, 1, FX.acid_sizzle); break;
      case 'acid_hit': S2('acid_hit', 0.8, 1, FX.acid_hit); break;
      case 'treeacid': S2('acid_tree', 0.9, 1, FX.acid_tree); break;
      case 'steelcut': if (e.acid) S2('acid_steel', 0.8, 1, FX.acid_steel); break;
      case 'cratehit': S2('crate_hit', 0.9, 1, FX.crate_hit); break;
      case 'cratedrop': if (e.v > 3) S2('crate_drop', Math.min(0.9, 0.3 + e.v * 0.04), 1, FX.crate_drop); break;
    }
  };
})(window.SS = window.SS || {});
