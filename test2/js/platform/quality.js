/* platform/quality.js — visual quality presets and device detection (presentation only; never affects the sim).
 * Low is picked automatically on phones/tablets and low-memory devices. */
(function (SS) {
  'use strict';
  const Q = SS.quality = {};

  Q.PRESETS = {
    // dpr: the highest pixel ratio (the adaptive resolution steps down from it, see Q.adapt_*); msaa: samples of the canvas (0 = no
    // antialiasing) and of the lens target; farScale: the far-world pass resolution relative to the canvas; far pass: no MSAA (soft haze)
    low: { name: 'low', dpr: 1, msaa: 0, farScale: 0.4, shadow: 1024, softShadow: false, detail: false, nearCtx: false, tex: 'low', grass: 0.25, particles: 0.4, waterN: 97, remeshMs: 5, motes: 80, clutter: 0, life: 0, trail: 0.3, haze: false, grade: false, bloom: false },
    medium: { name: 'medium', dpr: 1.5, msaa: 2, farScale: 0.5, shadow: 2048, softShadow: true, detail: true, nearCtx: true, tex: 'medium', grass: 0.5, particles: 0.7, waterN: 193, remeshMs: 8, motes: 180, clutter: 0.5, life: 0.5, trail: 0.7, haze: false, grade: true, bloom: true },
    high: { name: 'high', dpr: 2, msaa: 4, farScale: 0.5, shadow: 4096, softShadow: true, detail: true, nearCtx: true, tex: 'high', grass: 1, particles: 1, waterN: 193, remeshMs: 10, motes: 260, clutter: 1, life: 1, trail: 1, grade: true, bloom: true, haze: typeof location !== 'undefined' && /[?&]haze=1/.test(location.search) }
  };

  /* P38-R4 adaptive resolution (presentation only). The canvas pixel ratio steps down while the frame interval cannot keep the
   * display's refresh and back up after a calm stretch. State (C: struct Adapt { f32 ladder[4]; i32 n, level; f32 buf[32]; i32 nb;
   * f32 base, calm, lockUntil, lastDown; }): adapt_make(max_dpr) -> ad; adapt_frame(ad, dt_ms, now_s) -> the new pixel ratio, or 0
   * (unchanged). A window of 30 frame intervals: median > max(1.3 x the best median seen (the refresh), 19 ms) -> one level down;
   * 12 s of medians within 1.1 x the refresh -> one level up (not for 60 s when the step up was undone within 10 s). */
  Q.adapt_make = function (maxDpr) {
    const lad = [maxDpr];
    for (const r of [1.5, 1.25, 1]) if (r < maxDpr - 0.01) lad.push(r);
    return { ladder: lad, level: 0, buf: new Float32Array(30), nb: 0, base: 1e9, calm: 0, lockUntil: 0, lastUp: -99 };
  };
  Q.adapt_frame = function (ad, dtMs, now) {
    ad.buf[ad.nb++] = dtMs;
    if (ad.nb < ad.buf.length) return 0;
    ad.nb = 0;
    const a = Array.prototype.slice.call(ad.buf).sort((x, y) => x - y), med = a[a.length >> 1];
    if (med < ad.base) ad.base = Math.max(med, 4);
    if (med > Math.max(ad.base * 1.3, 19) && ad.level < ad.ladder.length - 1) {
      if (now - ad.lastUp < 10) ad.lockUntil = now + 60;                         // the step up did not hold: stay down for a while
      ad.level++; ad.calm = 0; return ad.ladder[ad.level];
    }
    if (med <= ad.base * 1.1 && ad.level > 0) {
      ad.calm += a.length * med / 1000;
      if (ad.calm > 12 && now > ad.lockUntil) { ad.level--; ad.calm = 0; ad.lastUp = now; return ad.ladder[ad.level]; }
    } else ad.calm = 0;
    return 0;
  };

  Q.detect = function () {
    const nav = window.navigator || {};
    const touch = ('ontouchstart' in window) || (nav.maxTouchPoints || 0) > 1;
    const small = Math.min(screen.width || 1920, screen.height || 1080) < 820;
    const mem = nav.deviceMemory || 8, cores = nav.hardwareConcurrency || 8;
    if ((touch && small) || mem <= 3 || cores <= 2) return 'low';
    if (touch || mem <= 4 || cores <= 4) return 'medium';
    return 'high';
  };
  /* 'auto' | 'low' | 'medium' | 'high' -> preset object */
  Q.resolve = function (name) {
    const n = Q.PRESETS[name] ? name : Q.detect();
    return Object.assign({}, Q.PRESETS[n]);
  };
})(window.SS = window.SS || {});
