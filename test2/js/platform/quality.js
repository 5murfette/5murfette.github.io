/* platform/quality.js — visual quality presets and device detection (presentation only; never affects the sim).
 * Low is picked automatically on phones/tablets and low-memory devices. */
(function (SS) {
  'use strict';
  const Q = SS.quality = {};

  Q.PRESETS = {
    low: { name: 'low', dpr: 1, msaa: 0, bloom: 0, shadow: 1024, softShadow: false, detail: false, nearCtx: false, tex: 'low', grass: 0.25, particles: 0.4, waterN: 97, remeshMs: 5, motes: 80 },
    medium: { name: 'medium', dpr: 1.5, msaa: 0, bloom: 0.5, shadow: 2048, softShadow: true, detail: true, nearCtx: true, tex: 'medium', grass: 0.5, particles: 0.7, waterN: 193, remeshMs: 8, motes: 180 },
    high: { name: 'high', dpr: 2, msaa: 4, bloom: 1, shadow: 4096, softShadow: true, detail: true, nearCtx: true, tex: 'high', grass: 1, particles: 1, waterN: 193, remeshMs: 10, motes: 260 }
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
