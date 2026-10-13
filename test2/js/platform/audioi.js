/* platform/audioi.js — P43: the sounds of the bored-worm antics (render/idleview.js calls SS.audio.idleCue(name, worm,
 * volume); presentation only, so
 * Math.random is fine). Each cue first asks for a recorded sample by id (assets/sfx/manifest.js; ids and prompts in
 * docs/SOUND_PROMPTS.md "P43 idle antics"), the worm VOICES through the team banks (SS.audio.voice: natural pitch, no
 * pitching) and the rest through SS.audio.play; without a file the synthesised fallback plays (snore, sigh, whistle,
 * taps, clunks, pops) or nothing (the voice lines "woo woo", laugh, yawn, shiver stay silent until delivered):
 *   name     id              kind    fallback
 *   snore    worm_snore      voice   a rasping inhale and a breathy exhale
 *   yawn     worm_yawn       voice   silent
 *   panic    worm_panic      voice   silent ("woo woo!")
 *   laugh    worm_laugh      voice   silent (a little giggle)
 *   sigh     worm_sigh       voice   a breath of noise
 *   whistle  worm_whistle    voice   a two-note whistle
 *   shiver   worm_shiver     voice   silent ("brrr")
 *   tap      phone_tap       sample  a soft screen tap
 *   swipe    phone_swipe     sample  a thumb swipe
 *   clunk    grenade_clunk   sample  a dull metal bounce (reuses bounce_metal)
 *   pop      idle_pop        sample  a small pop (a prop appears / the bubble pops)
 *   plop     worm_land_thud  sample  a soft landing (reuses the landing thud) */
(function (SS) {
  'use strict';
  const AU = SS.audio;
  if (!AU || !AU.synth) return;
  const { tone, noise } = AU.synth, rnd = (a, b) => a + Math.random() * (b - a);
  const VOICE = {
    snore: ['worm_snore', 2.5],
    yawn: ['worm_yawn', 1.5],
    panic: ['worm_panic', 0.5],
    laugh: ['worm_laugh', 1.0],
    sigh: ['worm_sigh', 1.5],
    whistle: ['worm_whistle', 0.5],
    shiver: ['worm_shiver', 1.5]
  };
  const SAMPLE = { tap: 'phone_tap', swipe: 'phone_swipe', clunk: 'grenade_clunk', pop: 'idle_pop', plop: 'worm_land_thud' };
  const FB = {
    snore(v) {
      noise(0.8, 'bandpass', 260, 1.2, 0.2 * v, 620);
      tone('sawtooth', 62, 48, 0.8, 0.06 * v, 0.2);
      noise(1.0, 'lowpass', 420, 0.8, 0.16 * v, 160, 1, 1.1);
    },
    sigh(v) { noise(0.7, 'bandpass', 700, 0.9, 0.12 * v, 350); },
    whistle(v) {
      tone('sine', 1250, 1500, 0.16, 0.07 * v, 0.02);
      tone('sine', 1500, 1100, 0.22, 0.07 * v, 0.02, 0.2);
    },
    tap(v) { tone('triangle', 900, 700, 0.04, 0.1 * v, 0.002); },
    swipe(v) { noise(0.12, 'bandpass', 2400, 1.2, 0.07 * v, 1500); },
    clunk(v) { AU.sfx.bounce(Math.min(1, 0.5 * v + 0.2)); },
    pop(v) {
      noise(0.07, 'bandpass', 1500, 1.4, 0.2 * v, 600);
      tone('triangle', 640, 220, 0.07, 0.12 * v);
    },
    plop(v) { AU.sfx.thud(0.25 * v + 0.1); }
  };
  AU.idleCue = function (name, w, vol) {
    vol = vol == null ? 1 : vol;
    const vo = VOICE[name];
    if (vo) {
      if (AU.voice(vo[0], w, 0.9 * vol, vo[1])) return;
      if (FB[name] && !AU.has(vo[0])) FB[name](vol);
      return;
    }
    const id = SAMPLE[name];
    if (id && AU.play(id, 0.8 * vol)) return;
    if (FB[name]) FB[name](vol);
  };
})(window.SS = window.SS || {});
