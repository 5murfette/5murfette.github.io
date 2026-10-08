/* core/cmath.js — scalar/vector/quaternion helpers, deterministic RNG and value noise.
 * Porting note: plain functions over plain structs {x,y,z} / {x,y,z,w}; maps 1:1 to C (static inline)
 * or C# (static class). Nothing here touches the DOM, the renderer or the wall clock. */
(function (SS) {
  'use strict';
  const M = SS.math = {};
  M.PI = Math.PI;
  M.TAU = Math.PI * 2;
  /* Determinism / portability: every sim module computes lengths and transcendentals through these (never Math.*
   * directly; tools/dev/gen/portabilitytest.cjs checks it). Lengths use sqrt of the sum of squares: sqrt is correctly
   * rounded on every platform (Math.hypot is not, and is ~10x slower in V8). The transcendentals forward to Math.* in
   * JS; a native port implements them ONCE (e.g. fdlibm / CORE-MATH) so every build of the game gets identical bits. */
  M.len2 = (x, y) => Math.sqrt(x * x + y * y);
  M.len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
  M.len4 = (x, y, z, w) => Math.sqrt(x * x + y * y + z * z + w * w);
  M.sin = Math.sin; M.cos = Math.cos; M.tan = Math.tan; M.asin = Math.asin; M.acos = Math.acos; M.atan = Math.atan; M.atan2 = Math.atan2;
  M.exp = Math.exp; M.log = Math.log; M.log2 = Math.log2; M.pow = Math.pow; M.cbrt = Math.cbrt;
  M.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  M.sat = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  M.lerp = (a, b, t) => a + (b - a) * t;
  M.smooth = x => x * x * (3 - 2 * x);
  M.smoothstep = (a, b, x) => { const t = M.sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  M.wrap_angle = a => {
    if (!(a > -1e6 && a < 1e6)) return 0;            // NaN / Infinity / garbage input: never loop forever
    while (a > Math.PI) a -= M.TAU; while (a < -Math.PI) a += M.TAU; return a;
  };
  M.sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);

  /* ---------- vec3 (plain struct) ---------- */
  M.v3 = (x, y, z) => ({ x, y, z });
  M.v3_copy = a => ({ x: a.x, y: a.y, z: a.z });
  M.v3_set = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; return o; };
  M.v3_dist = (a, b) => M.len3(a.x - b.x, a.y - b.y, a.z - b.z);
  M.v3_len = a => M.len3(a.x, a.y, a.z);
  M.v3_sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  M.v3_dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  M.v3_cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

  /* ---------- quaternion (plain struct {x,y,z,w}) ---------- */
  M.q_ident = () => ({ x: 0, y: 0, z: 0, w: 1 });
  M.q_axis_angle = (ax, ay, az, ang) => { const s = M.sin(ang / 2); return { x: ax * s, y: ay * s, z: az * s, w: M.cos(ang / 2) }; };
  M.q_mul = (a, b) => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  });
  M.q_norm = q => { const l = M.len4(q.x, q.y, q.z, q.w) || 1; q.x /= l; q.y /= l; q.z /= l; q.w /= l; return q; };
  /* rotate vector (x,y,z) by q, written into out */
  M.q_rot = (q, x, y, z, out) => {
    const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
    out.x = x + q.w * tx + (q.y * tz - q.z * ty);
    out.y = y + q.w * ty + (q.z * tx - q.x * tz);
    out.z = z + q.w * tz + (q.x * ty - q.y * tx);
    return out;
  };
  M.q_rot_inv = (q, x, y, z, out) => M.q_rot({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, x, y, z, out);
  /* integrate orientation by world angular velocity w over dt */
  M.q_integrate = (q, wx, wy, wz, dt) => {
    const h = dt * 0.5;
    const x = q.x + h * (wx * q.w + wy * q.z - wz * q.y);
    const y = q.y + h * (wy * q.w + wz * q.x - wx * q.z);
    const z = q.z + h * (wz * q.w + wx * q.y - wy * q.x);
    const w = q.w + h * (-wx * q.x - wy * q.y - wz * q.z);
    q.x = x; q.y = y; q.z = z; q.w = w;
    return M.q_norm(q);
  };

  /* ---------- RNG: struct { u32 s; } (LCG, deterministic) ---------- */
  M.rng_make = seed => ({ s: seed >>> 0 });
  M.rng_seed = (r, seed) => { r.s = seed >>> 0; };
  M.rng_next = r => { r.s = (Math.imul(r.s, 1664525) + 1013904223) >>> 0; return r.s / 4294967296; };
  M.rng_range = (r, a, b) => a + (b - a) * M.rng_next(r);
  M.rng_int = (r, n) => Math.floor(M.rng_next(r) * n);

  /* ---------- integer hashes ---------- */
  M.hash3i = (i, j, k) => {
    let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(k | 0, 1274126177)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return h >>> 0;
  };
  M.hash3 = (i, j, k) => M.hash3i(i, j, k) / 4294967296;
  function h4(i, j, k, s) {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1274126177) + Math.imul(s, 144665)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }
  M.hash4 = h4;

  /* ---------- value noise (smoothstep-interpolated lattice hash), range [0,1] ---------- */
  M.noise3 = (x, y, z, seed) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let u = x - xi, v = y - yi, w = z - zi; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v); w = w * w * (3 - 2 * w);
    const a = h4(xi, yi, zi, seed), b = h4(xi + 1, yi, zi, seed), c = h4(xi, yi + 1, zi, seed), d = h4(xi + 1, yi + 1, zi, seed);
    const e = h4(xi, yi, zi + 1, seed), f = h4(xi + 1, yi, zi + 1, seed), g = h4(xi, yi + 1, zi + 1, seed), h = h4(xi + 1, yi + 1, zi + 1, seed);
    const x1 = a + (b - a) * u, x2 = c + (d - c) * u, x3 = e + (f - e) * u, x4 = g + (h - g) * u;
    const y1 = x1 + (x2 - x1) * v, y2 = x3 + (x4 - x3) * v;
    return y1 + (y2 - y1) * w;
  };
  M.noise2 = (x, z, seed) => {
    const xi = Math.floor(x), zi = Math.floor(z);
    let u = x - xi, w = z - zi; u = u * u * (3 - 2 * u); w = w * w * (3 - 2 * w);
    const a = h4(xi, 0, zi, seed), b = h4(xi + 1, 0, zi, seed), c = h4(xi, 0, zi + 1, seed), d = h4(xi + 1, 0, zi + 1, seed);
    const x1 = a + (b - a) * u, x2 = c + (d - c) * u;
    return x1 + (x2 - x1) * w;
  };
  /* fbm with a fixed orthonormal rotation between octaves: same value distribution as plain value noise,
   * but the octaves' lattices no longer line up (no square/diamond grid look on large amplitudes). */
  M.fbm3 = (x, y, z, seed, oct) => {
    let a = 0.5, s = 0, n = 0, px = x, py = y, pz = z;
    for (let o = 0; o < oct; o++) {
      s += a * M.noise3(px, py, pz, seed + o * 31); n += a; a *= 0.5;
      const qx = 0.0 * px + 0.8 * py + 0.6 * pz, qy = -0.8 * px + 0.36 * py - 0.48 * pz, qz = -0.6 * px - 0.48 * py + 0.64 * pz;
      px = qx * 2.03 + 1.7; py = qy * 2.03 + 9.2; pz = qz * 2.03 + 4.1;
    }
    return s / n;
  };
  M.fbm2 = (x, z, seed, oct) => {
    let a = 0.5, s = 0, n = 0, px = x, pz = z;
    for (let o = 0; o < oct; o++) {
      s += a * M.noise2(px, pz, seed + o * 31); n += a; a *= 0.5;
      const qx = 0.8 * px - 0.6 * pz, qz = 0.6 * px + 0.8 * pz;
      px = qx * 2.03 + 3.1; pz = qz * 2.03 + 7.7;
    }
    return s / n;
  };
  /* ridged multifractal-ish: sharp crests, range ~[0,1] */
  M.ridge2 = (x, z, seed, oct) => {
    let a = 0.5, f = 1, s = 0, n = 0;
    for (let o = 0; o < oct; o++) { const r = 1 - Math.abs(M.noise2(x * f, z * f, seed + o * 57) * 2 - 1); s += a * r * r; n += a; a *= 0.5; f *= 2.07; }
    return s / n;
  };
  /* distance from point to segment a->b (arrays [x,y,z]) */
  M.seg_dist = (px, py, pz, a, b) => {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const t = M.sat(((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / (abx * abx + aby * aby + abz * abz || 1));
    return M.len3(px - a[0] - abx * t, py - a[1] - aby * t, pz - a[2] - abz * t);
  };
})(window.SS = window.SS || {});
