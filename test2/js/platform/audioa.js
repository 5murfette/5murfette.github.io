/* platform/audioa.js — P37-W3: the sounds of weapons A. Each id below can be replaced by a recorded file (assets/sfx,
 * docs/SOUND_PROMPTS.md "P37 weapons A"); without one the synthesised version (WebAudio, from SS.audio.synth) plays.
 * Driven only by sim events (rows and code of audio.js's event table); presentation only. */
(function (SS) {
  'use strict';
  const AU = SS.audio;
  if (!AU || !AU.synth) return;
  const Y = AU.synth, rand = Math.random;
  const last = {};
  const gate = (k, ms) => {
    const n = performance.now();
    if (n - (last[k] || 0) < ms) return false;
    last[k] = n;
    return true;
  };
  const smp = (id, vol, rate, fb) => {
    if (!AU.play(id, vol, rate) && fb) fb();
  };
  const S = {
    flame() {
      Y.noise(0.22, 'bandpass', 700 + rand() * 500, 0.7, 0.32, 380);
      Y.noise(0.2, 'lowpass', 300, 0.6, 0.35, 120);
    },
    ignite() {
      Y.noise(0.12, 'highpass', 3500, 0.5, 0.18);
      Y.tone('square', 220, 90, 0.06, 0.08);
    },
    mg() {
      Y.noise(0.05, 'highpass', 1800, 0.6, 0.42, 600);
      Y.tone('square', 110 + rand() * 20, 55, 0.05, 0.2);
      Y.noise(0.045, 'bandpass', 380, 1.2, 0.35, 200);
    },
    spinup() {
      Y.tone('sawtooth', 70, 520, 0.5, 0.12, 0.02);
      Y.tone('square', 35, 260, 0.5, 0.08, 0.02);
    },
    spindown() { Y.tone('sawtooth', 480, 60, 0.7, 0.11, 0.02); },
    clink() {
      if (gate('clink', 55)) Y.tone('triangle', 2400 + rand() * 900, 1500, 0.07, 0.07);
    },
    hand() {
      Y.noise(0.12, 'highpass', 1500, 0.6, 0.55, 500);
      Y.tone('square', 520, 90, 0.1, 0.25);
      Y.noise(0.2, 'lowpass', 500, 0.8, 0.3, 120);
    },
    mortar() {
      Y.tone('sine', 120, 38, 0.3, 0.5);
      Y.noise(0.25, 'lowpass', 700, 0.8, 0.5, 120);
      Y.noise(0.12, 'bandpass', 1500, 1, 0.2, 700);
    },
    pop() {
      Y.noise(0.1, 'bandpass', 1800, 1.5, 0.35, 700);
      Y.tone('triangle', 700, 200, 0.08, 0.2);
    },
    fizz() {
      Y.noise(0.5, 'highpass', 3800, 0.6, 0.18, 6000);
      Y.noise(0.4, 'bandpass', 2200, 1.4, 0.1, 3600);
    },
    hiss() {
      Y.noise(0.9, 'highpass', 3000, 0.5, 0.3, 5200);
      Y.noise(0.7, 'bandpass', 1500, 0.8, 0.12);
    },
    cough() {
      for (let i = 0; i < 2; i++) {
        Y.noise(0.11, 'bandpass', 520 + rand() * 200, 2.2, 0.38, 340, 1, i * 0.17);
        Y.tone('sawtooth', 190 - i * 25, 120, 0.09, 0.1, 0.01, i * 0.17);
      }
    },
    whoosh() { Y.noise(0.5, 'bandpass', 500, 1.2, 0.3, 2000); },
    thwack() {
      Y.tone('triangle', 420, 140, 0.1, 0.35);
      Y.noise(0.07, 'bandpass', 1500, 2, 0.4, 700);
    },
    clack() { Y.tone('triangle', 800, 300, 0.07, 0.25); },
    caw() {
      for (let i = 0; i < 2; i++) {
        Y.tone('sawtooth', 680 - i * 70, 380, 0.18, 0.09, 0.012, i * 0.24);
        Y.noise(0.18, 'bandpass', 1300, 2.5, 0.1, 800, 1, i * 0.24);
      }
    },
    flutter() { Y.noise(0.12, 'bandpass', 3300 + rand() * 1200, 1.5, 0.07); },
    thud() {
      Y.tone('sine', 90, 40, 0.18, 0.4);
      Y.noise(0.15, 'lowpass', 600, 0.8, 0.3, 200);
    },
    gasp() { Y.noise(0.35, 'bandpass', 900, 1.2, 0.2, 500); }
  };
  // the weapons' own launch / shot / stream entries replace the type's (audio.js AU.dispatch)
  AU.rows([
    ['fire:mortar', 'mortar_fire', 1, 1, S.mortar],
    ['fire:boomerang', 'boomerang_throw', 0.9, 1, S.whoosh],
    ['shot:handgun', 'handgun_shot', 1, 1, S.hand],
    ['streamstart', 'flame_ignite', 0.9, 1, S.ignite],
    ['streamstart:minigun', 'minigun_spinup', 0.9, 1, S.spinup],
    ['streamend:minigun', 'minigun_spindown', 0.8, 1, S.spindown],
    ['flamejet', 'flame_loop', 0.55, 1, S.flame, 70],
    ['mgfire', 'minigun_burst', 0.8, 1, S.mg, 55],
    ['mortarburst', 'mortar_burst', 0.8, 1, S.pop],
    ['acidburst', 'acid_burst', 0.9, 1, S.fizz],
    ['acideat', 'acid_hiss', 0.5, 1, S.fizz, 220],
    ['gasburst', 'gas_release', 0.9, 1, S.hiss],
    ['infect', 'worm_gasp', 0.7, 1, S.gasp],
    ['boomthrow', 'boomerang_whirr', 0.8, 1, S.whoosh],
    ['boombounce', 'boomerang_bounce', 0.7, 1, S.clack],
    ['boomcatch', 'boomerang_catch', 0.8, 1, S.pop],
    ['ravenrelease', 'raven_caw', 0.9, 1, S.caw],
    [
      'ravencrash',
      'raven_crash',
      1,
      1,
      () => {
        S.thud();
        S.caw();
      }
    ],
    ['letterdrop', 'letter_flutter', 0.5, 1, S.flutter, 120],
    ['stick', 'flame_ignite', 0.5, 1.3, S.ignite]
  ]);
  AU.on('mgfire', () => {
    if (gate('mgc', 70)) S.clink();
  });
  AU.on('mgimpact', () => {
    if (gate('mgi', 90)) Y.noise(0.04, 'bandpass', 2400, 2, 0.12);
  });
  AU.on('cough', (S0, e) => {
    if (!AU.voice('worm_cough', e.worm, 0.9, 0.5) && !AU.has('worm_cough')) S.cough();
  });
  AU.on('ouch', (S0, e) => {
    if (e.acid && !AU.voice('worm_ouch', e.worm, 1, 0.25) && !AU.has('worm_ouch')) {
      Y.voice(310 + rand() * 90, 0.2, [9, 15], [[650, 4], [1150, 5]], 0.24, 0, 210);
      Y.noise(0.15, 'highpass', 3500, 0.5, 0.1);
    }
  });
  // the boomerang's whirr: the pitch follows the speed
  AU.on('boomwhoosh', (S0, e) => {
    if (gate('bw', 120)) smp('boomerang_whirr', 0.35, 0.75 + e.speed / 40, S.whoosh);
  });
  // (a blast follows: the thwack is for a worm hit head-on)
  AU.on('boomhit', (S0, e) => {
    if (e.wormId >= 0) smp('boomerang_hit', 1, 1, S.thwack);
  });
  AU.on('ravenbump', () => S.thud());
  AU.clinkA = S.clink;
})(window.SS = window.SS || {});
