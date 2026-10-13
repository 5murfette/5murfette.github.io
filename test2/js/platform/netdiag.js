/* platform/netdiag.js — P103 desync diagnostics (dev tool, also run on a real desync). fields(S) = { key: u32 } a
 * structural hash of every
 * top-level field of S plus the voxel world arrays ("W.d", "W.mat", ...), so two peers' dumps can be compared field by
 * field. diff(a, b) -> the names of the differing fields. dump(S) logs the table to the console. Read only: never
 * changes S. Not part of the sim hash. */
(function (SS) {
  'use strict';
  const ND = SS.netdiag = {};
  let H = 0;
  const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
  function mixn(v) {
    f64[0] = v;
    H = Math.imul(H ^ u32[0], 16777619) >>> 0;
    H = Math.imul(H ^ u32[1], 16777619) >>> 0;
  }
  function mixs(s) {
    for (let i = 0; i < s.length; i++) H = Math.imul(H ^ s.charCodeAt(i), 16777619) >>> 0;
    H = Math.imul(H ^ 0xff, 16777619) >>> 0;
  }
  function walk(v, depth) {
    if (v === null || v === undefined) {
      H = Math.imul(H ^ 0x1234, 16777619) >>> 0;
      return;
    }
    const t = typeof v;
    if (t === 'number') mixn(v);
    else if (t === 'boolean') mixn(v ? 1 : 0);
    else if (t === 'string') mixs(v);
    else if (t === 'function') return;
    else if (ArrayBuffer.isView(v)) {
      mixn(v.length);
      for (let i = 0; i < v.length; i++) mixn(v[i]);
    }
    else if (Array.isArray(v)) {
      mixn(v.length);
      if (depth < 12)
        for (let i = 0; i < v.length; i++) walk(v[i], depth + 1);
    }
    else if (t === 'object') {
      if (depth >= 12) return;
      const ks = Object.keys(v).sort();
      for (const k of ks) {
        if (typeof v[k] === 'function') continue;
        mixs(k);
        walk(v[k], depth + 1);
      }
    }
  }
  // presentation / render products (not sim state)
  const SKIP = { events: 1, log: 1, stats: 1, section: 1, sectionDirty: 1, verBase: 1 };
  ND.fields = function (S) {
    const out = {};
    for (const k of Object.keys(S).sort()) {
      if (SKIP[k]) continue;
      H = 2166136261;
      walk(S[k], 0);
      out[k] = H;
    }
    const W = SS.world;
    if (W)
      for (const k of ['d', 'mat', 'heat', 'top', 'topJ', 'crack'])
        if (W[k]) {
          H = 2166136261;
          walk(W[k], 0);
          out['W.' + k] = H;
        }
    return out;
  };
  ND.diff = function (a, b) {
    const r = [];
    const keys = Object.keys(a).concat(Object.keys(b).filter(k => !(k in a)));
    for (const k of keys)
      if (a[k] !== b[k]) r.push(k);
    return r;
  };
  ND.dump = function (S) {
    const f = ND.fields(S);
    console.log('netdiag fields', JSON.stringify(f));
    return f;
  };
})(window.SS = window.SS || {});
