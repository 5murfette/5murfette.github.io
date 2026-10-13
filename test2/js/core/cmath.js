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
   * rounded on every platform (Math.hypot is not, and is ~10x slower in V8). The transcendentals are the pure
   * fdlibm port below (bit-identical in every JS engine and in a C port); Math.sin etc. are NOT used. */
  M.len2 = (x, y) => Math.sqrt(x * x + y * y);
  M.len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
  M.len4 = (x, y, z, w) => Math.sqrt(x * x + y * y + z * z + w * w);
  /* ===================================================================================================================
   * Deterministic transcendentals (fdlibm / FreeBSD msun port).
   *
   * WHY: Math.sin / pow / exp ... are implementation defined: V8, JavaScriptCore, SpiderMonkey and a native libm differ
   * by 1 ulp on a few percent of the inputs, which desynchronises a lockstep match between different browsers (and from
   * a future native port). The functions below use ONLY + - * / , Math.sqrt (correctly rounded by IEEE 754), integer
   * ops and bit access to the IEEE-754 double, so every conforming engine / C compiler (no FMA contraction, no
   * fast-math, strict double rounding, i.e. SSE2 / ARM64 and not x87) returns bit-identical results. Port 1:1 to C
   * (docs/PORTING.md, "math contract"): the same algorithms and constants, NOT libm.
   *
   * Source: FreeBSD lib/msun (fdlibm 5.3 + Sun's later fixes): s_sin s_cos s_tan k_sin k_cos k_tan e_rem_pio2
   * k_rem_pio2 s_atan e_atan2 e_asin e_acos e_exp e_log e_log2 (+k_log.h) e_pow s_cbrt. Error < 1 ulp everywhere
   * (measured by tools/dev/gen/mathtest.cjs). Scratch typed arrays below are NOT sim state: they only live between
   * the first and the last line of one call (C: a local union { double d; uint32_t w[2]; }).
   * =================================================================================================================== */
  const FB = new Float64Array(1), UB = new Uint32Array(FB.buffer);
  const HI = (() => {
    FB[0] = 1;
    return UB[1] === 0x3ff00000 ? 1 : 0;
  })(),
    LO = 1 - HI;
  // rem_pio2 output y[0], y[1] (C: out parameters; a typed array: a captured `let` double would allocate)
  const RY = new Float64Array(2);
  const KQ = new Float64Array(20),
    KF = new Float64Array(20),
    KFQ = new Float64Array(20),
    KIQ = new Int32Array(20),
    KTX = new Float64Array(3);
  /* high word (as int32) / low word (as uint32) of a double */
  function hiw(x) {
    FB[0] = x;
    return UB[HI] | 0;
  }
  function low(x) {
    FB[0] = x;
    return UB[LO];
  }
  /* x with its high / low word replaced */
  function sethi(x, h) {
    FB[0] = x;
    UB[HI] = h;
    return FB[0];
  }
  function setlo0(x) {
    FB[0] = x;
    UB[LO] = 0;
    return FB[0];
  }
  function mkw(h, l) {
    UB[HI] = h;
    UB[LO] = l;
    return FB[0];
  }
  /* 2^n for -1022 <= n <= 1023 */
  function p2(n) { return mkw((n + 1023) << 20, 0); }
  function scalbn(x, n) {
    while (n > 1023) {
      x *= p2(1023);
      n -= 1023;
    }
    while (n < -1022) {
      x *= p2(-969);
      n += 969;
    }
    return x * p2(n);
  }
  const TWO54 = 1.80143985094819840000e+16, TWO24 = 1.67772160000000000000e+07, TWON24 = 5.96046447753906250000e-08;
  const PI_O_2 = 1.5707963267948965580E+00,
    PI_O_4 = 7.8539816339744827900E-01,
    PI = 3.1415926535897931160E+00,
    PI_LO = 1.2246467991473531772E-16;

  /* ---------- argument reduction x mod pi/2 ---------- */
  const IPIO2 = new Int32Array([
    0xA2F983, 0x6E4E44, 0x1529FC, 0x2757D1, 0xF534DD, 0xC0DB62,
    0x95993C, 0x439041, 0xFE5163, 0xABDEBB, 0xC561B7, 0x246E3A,
    0x424DD2, 0xE00649, 0x2EEA09, 0xD1921C, 0xFE1DEB, 0x1CB129,
    0xA73EE8, 0x8235F5, 0x2EBB44, 0x84E99C, 0x7026B4, 0x5F7E41,
    0x3991D6, 0x398353, 0x39F49C, 0x845F8B, 0xBDF928, 0x3B1FF8,
    0x97FFDE, 0x05980F, 0xEF2F11, 0x8B5A0A, 0x6D1F6D, 0x367ECF,
    0x27CB09, 0xB74F46, 0x3F669E, 0x5FEA2D, 0x7527BA, 0xC7EBE5,
    0xF17B3D, 0x0739F7, 0x8A5292, 0xEA6BFB, 0x5FB11F, 0x8D5D08,
    0x560330, 0x46FC7B, 0x6BABF0, 0xCFBC20, 0x9AF436, 0x1DA9E3,
    0x91615E, 0xE61B08, 0x659985, 0x5F14A0, 0x68408D, 0xFFD880,
    0x4D7327, 0x310606, 0x1556CA, 0x73A8C9, 0x60E27B, 0xC08C6B
  ]);
  const PIO2 = new Float64Array([
    1.57079625129699707031e+00, 7.54978941586159635335e-08, 5.39030252995776476554e-15, 3.28200341580791294123e-22,
    1.27065575308067607349e-29, 1.22933308981111328932e-36, 2.73370053816464559624e-44, 2.16741683877804819444e-51
  ]);
  /* Payne-Hanek for huge |x|: x[0..nx-1] are 24-bit chunks of |x| scaled by 2^-e0, result y[0]+y[1] in RY (precision 1:
   * jk = 4).
   * Returns n mod 8. */
  function kernel_rem_pio2(x, e0, nx) {
    const jk = 4, jp = 4, q = KQ, f = KF, fq = KFQ, iq = KIQ;
    let jz, jx, jv, q0, ih, n, i, j, k, m, carry, z, fw;
    jx = nx - 1;
    jv = ((e0 - 3) / 24) | 0;
    if (jv < 0) jv = 0;
    q0 = e0 - 24 * (jv + 1);
    j = jv - jx; m = jx + jk;
    for (i = 0; i <= m; i++, j++) f[i] = (j < 0) ? 0.0 : IPIO2[j];
    for (i = 0; i <= jk; i++) {
      for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j] * f[jx + i - j];
      q[i] = fw;
    }
    jz = jk;
    for (;;) {
      for (i = 0, j = jz, z = q[jz]; j > 0; i++, j--) {
        fw = ((TWON24 * z) | 0);
        iq[i] = (z - TWO24 * fw) | 0;
        z = q[j - 1] + fw;
      }
      z = scalbn(z, q0);
      z -= 8.0 * Math.floor(z * 0.125);
      n = z | 0;
      z -= n;
      ih = 0;
      if (q0 > 0) {
        i = (iq[jz - 1] >> (24 - q0)); n += i;
        iq[jz - 1] -= i << (24 - q0);
        ih = iq[jz - 1] >> (23 - q0);
      } else if (q0 === 0) ih = iq[jz - 1] >> 23;
      else if (z >= 0.5) ih = 2;
      if (ih > 0) {
        n += 1; carry = 0;
        for (i = 0; i < jz; i++) {
          j = iq[i];
          if (carry === 0) {
            if (j !== 0) {
              carry = 1;
              iq[i] = 0x1000000 - j;
            }
          } else iq[i] = 0xffffff - j;
        }
        if (q0 > 0) {
          if (q0 === 1) iq[jz - 1] &= 0x7fffff;
          else if (q0 === 2) iq[jz - 1] &= 0x3fffff;
        }
        if (ih === 2) {
          z = 1.0 - z;
          if (carry !== 0) z -= scalbn(1.0, q0);
        }
      }
      if (z === 0) {
        j = 0;
        for (i = jz - 1; i >= jk; i--) j |= iq[i];
        if (j === 0) {
          for (k = 1; iq[jk - k] === 0; k++);
          for (i = jz + 1; i <= jz + k; i++) {
            f[jx + i] = IPIO2[jv + i];
            for (j = 0, fw = 0.0; j <= jx; j++) fw += x[j] * f[jx + i - j];
            q[i] = fw;
          }
          jz += k;
          continue;
        }
      }
      break;
    }
    if (z === 0.0) {
      jz -= 1; q0 -= 24;
      while (iq[jz] === 0) {
        jz--;
        q0 -= 24;
      }
    } else {
      z = scalbn(z, -q0);
      if (z >= TWO24) {
        fw = ((TWON24 * z) | 0);
        iq[jz] = (z - TWO24 * fw) | 0;
        jz += 1; q0 += 24;
        iq[jz] = fw | 0;
      } else iq[jz] = z | 0;
    }
    fw = scalbn(1.0, q0);
    for (i = jz; i >= 0; i--) {
      q[i] = fw * iq[i];
      fw *= TWON24;
    }
    for (i = jz; i >= 0; i--) {
      for (fw = 0.0, k = 0; k <= jp && k <= jz - i; k++) fw += PIO2[k] * q[i + k];
      fq[jz - i] = fw;
    }
    fw = 0.0;
    for (i = jz; i >= 0; i--) fw += fq[i];
    RY[0] = (ih === 0) ? fw : -fw;
    fw = fq[0] - fw;
    for (i = 1; i <= jz; i++) fw += fq[i];
    RY[1] = (ih === 0) ? fw : -fw;
    return n & 7;
  }
  const INVPIO2 = 6.36619772367581382433e-01, PIO2_1 = 1.57079632673412561417e+00, PIO2_1T = 6.07710050650619224932e-11,
    PIO2_2 = 6.07710050630396597660e-11, PIO2_2T = 2.02226624879595063154e-21, PIO2_3 = 2.02226624871116645580e-21,
    PIO2_3T = 8.47842766036889956997e-32, RINT = 6755399441055744.0, MEDIUM_MAX = 1647099.0, Q_3PI4 = 2.3561954498291016,
    Q_5PI4 = 3.926992416381836, Q_7PI4 = 5.497791290283203, Q_9PI4 = 7.0685882568359375, P16 = 1.52587890625e-05,
    P48 = 3.552713678800501e-15;
  /* x = n*pi/2 + (RY[0] + RY[1]), |RY[0]| <= pi/4; returns n (the low bits are what the callers use). Caller handles
   * |x| < pi/4, NaN, Inf.
   * |x| < 2^20*pi/2: three-stage Cody-Waite (pi/2 in 33 + 33 + 33 + 53 bits, 151 bits good): one stage when no
   * cancellation, the next stages only when the result lost more than 16 / 49 bits (tested on magnitudes, not on
   * exponent words). Bigger |x|: Payne-Hanek (kernel_rem_pio2). */
  function rem_pio2(x) {
    const ax = x < 0 ? -x : x;
    if (ax < Q_9PI4) {
      /* |x| < 9pi/4: x - n*pio2_1 is exact (33-bit constant); pio2_1t adds 53 more bits. Not used when the result is
       * tiny. */
      let n, z, a, b;
      if (ax < Q_3PI4) {
        n = 1;
        a = PIO2_1;
        b = PIO2_1T;
      }
      else if (ax < Q_5PI4) {
        n = 2;
        a = 2 * PIO2_1;
        b = 2 * PIO2_1T;
      }
      else if (ax < Q_7PI4) {
        n = 3;
        a = 3 * PIO2_1;
        b = 3 * PIO2_1T;
      }
      else {
        n = 4;
        a = 4 * PIO2_1;
        b = 4 * PIO2_1T;
      }
      if (x > 0) {
        z = x - a;
        const y0 = z - b;
        if ((y0 < 0 ? -y0 : y0) > 9.5367431640625e-07) {
          RY[0] = y0;
          RY[1] = (z - y0) - b;
          return n;
        }
      } else {
        z = x + a;
        const y0 = z + b;
        if ((y0 < 0 ? -y0 : y0) > 9.5367431640625e-07) {
          RY[0] = y0;
          RY[1] = (z - y0) + b;
          return -n;
        }
      }
    }
    if (ax < MEDIUM_MAX) {
      const fn = (x * INVPIO2 + RINT) - RINT, n = fn | 0;
      let r = x - fn * PIO2_1, w = fn * PIO2_1T, y0 = r - w, t;
      let ay = y0 < 0 ? -y0 : y0;
      if (ay < ax * P16) {
        t = r;
        w = fn * PIO2_2;
        r = t - w;
        w = fn * PIO2_2T - ((t - r) - w);
        y0 = r - w;
        ay = y0 < 0 ? -y0 : y0;
        if (ay < ax * P48) {
          t = r;
          w = fn * PIO2_3;
          r = t - w;
          w = fn * PIO2_3T - ((t - r) - w);
          y0 = r - w;
        }
      }
      RY[0] = y0; RY[1] = (r - y0) - w;
      return n;
    }
    const hx = hiw(x), ix = hx & 0x7fffffff, e0 = (ix >> 20) - 1046;
    let z = mkw((ix - (e0 << 20)) | 0, low(x)), i;
    for (i = 0; i < 2; i++) {
      KTX[i] = z | 0;
      z = (z - KTX[i]) * TWO24;
    }
    KTX[2] = z;
    let nx = 3;
    while (KTX[nx - 1] === 0) nx--;
    const n = kernel_rem_pio2(KTX, e0, nx);
    if (hx < 0) {
      RY[0] = -RY[0];
      RY[1] = -RY[1];
      return -n;
    }
    return n;
  }

  /* ---------- sin / cos / tan kernels, |x| <= pi/4 ---------- */
  const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
    S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  function k_sin(x, y, iy) {
    const z = x * x, w = z * z, r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6), v = z * x;
    if (iy === 0) return x + v * (S1 + z * r);
    return x - ((z * (0.5 * y - v * r) - y) - v * S1);
  }
  const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
    C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;
  function k_cos(x, y) {
    const z = x * x, w0 = z * z, r = z * (C1 + z * (C2 + z * C3)) + w0 * w0 * (C4 + z * (C5 + z * C6)), hz = 0.5 * z, w = 1.0 - hz;
    return w + (((1.0 - w) - hz) + (z * r - x * y));
  }
  const T0 = 3.33333333333334091986e-01, T1 = 1.33333333333201242699e-01, T2 = 5.39682539762260521377e-02,
    T3 = 2.18694882948595424599e-02, T4 = 8.86323982359930005737e-03, T5 = 3.59207910759131235356e-03,
    T6 = 1.45620945432529025516e-03, T7 = 5.88041240820264096874e-04, T8 = 2.46463134818469906812e-04,
    T9 = 7.81794442939557092300e-05, T10 = 7.14072491382608190305e-05, T11 = -1.85586374855275456654e-05,
    T12 = 2.59073051863633712884e-05, PIO4 = 7.85398163397448278999e-01, PIO4LO = 3.06161699786838301793e-17;
  function k_tan(x, y, iy) {
    let z, r, v, w, s;
    const big = (x < 0 ? -x : x) >= 0.6743354797363281, neg = x < 0;
    if (big) {
      if (neg) {
        x = -x;
        y = -y;
      }
      z = PIO4 - x;
      w = PIO4LO - y;
      x = z + w;
      y = 0.0;
    }
    z = x * x; w = z * z;
    r = T1 + w * (T3 + w * (T5 + w * (T7 + w * (T9 + w * T11))));
    v = z * (T2 + w * (T4 + w * (T6 + w * (T8 + w * (T10 + w * T12)))));
    s = z * x;
    r = y + z * (s * (r + v) + y);
    r += T0 * s;
    w = x + r;
    if (big) {
      v = iy;
      return (neg ? -1 : 1) * (v - 2.0 * (x - (w * w / (w + v) - r)));
    }
    if (iy === 1) return w;
    z = setlo0(w);
    v = r - (z - x);
    const a = -1.0 / w;
    const t = setlo0(a);
    s = 1.0 + t * z;
    return t + a * (s + t * v);
  }

  /* thresholds of the fdlibm high-word tests as magnitudes: |x| < 0x3fe921fc00000000 (pi/4) etc. (exact, no bit access
   * needed) */
  const T_PIO4 = 0.7853984832763672,
    T_2M26 = 1.4901161193847656e-08,
    T_COS_TINY = 1.0536709282860102e-08,
    T_TAN_TINY = 7.450580596923828e-09,
    T_INF = Infinity;
  function f_sin(x) {
    const ax = x < 0 ? -x : x;
    if (ax < T_PIO4) {
      if (ax < T_2M26) return x;
      return k_sin(x, 0.0, 0);
    }
    if (!(ax < T_INF)) return x - x;
    const n = rem_pio2(x), y0 = RY[0], y1 = RY[1];
    switch (n & 3) {
      case 0: return k_sin(y0, y1, 1);
      case 1: return k_cos(y0, y1);
      case 2: return -k_sin(y0, y1, 1);
      default: return -k_cos(y0, y1);
    }
  }
  function f_cos(x) {
    const ax = x < 0 ? -x : x;
    if (ax < T_PIO4) {
      if (ax < T_COS_TINY) return 1.0;
      return k_cos(x, 0.0);
    }
    if (!(ax < T_INF)) return x - x;
    const n = rem_pio2(x), y0 = RY[0], y1 = RY[1];
    switch (n & 3) {
      case 0: return k_cos(y0, y1);
      case 1: return -k_sin(y0, y1, 1);
      case 2: return -k_cos(y0, y1);
      default: return k_sin(y0, y1, 1);
    }
  }
  function f_tan(x) {
    const ax = x < 0 ? -x : x;
    if (ax < T_PIO4) {
      if (ax < T_TAN_TINY) return x;
      return k_tan(x, 0.0, 1);
    }
    if (!(ax < T_INF)) return x - x;
    const n = rem_pio2(x);
    return k_tan(RY[0], RY[1], 1 - ((n & 1) << 1));
  }

  /* ---------- atan / atan2 / asin / acos ---------- */
  const ATANHI = new Float64Array([
    4.63647609000806093515e-01, 7.85398163397448278999e-01, 9.82793723247329054082e-01, 1.57079632679489655800e+00
  ]);
  const ATANLO = new Float64Array([
    2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17
  ]);
  const AT = new Float64Array([
    3.33333333333329318027e-01, -1.99999999998764832476e-01, 1.42857142725034663711e-01, -1.11111104054623557880e-01,
    9.09088713343650656196e-02, -7.69187620504482999495e-02, 6.66107313738753120669e-02, -5.83357013379057348645e-02,
    4.97687799461593236017e-02, -3.65315727442169155270e-02, 1.62858201153657823623e-02
  ]);
  function f_atan(x) {
    let w, s1, s2, z, id;
    const neg = x < 0, ax = neg ? -x : x;
    if (ax >= 7.378697629483821e+19) {
      if (x !== x) return x + x;
      return neg ? -ATANHI[3] - ATANLO[3] : ATANHI[3] + ATANLO[3];
    }
    if (ax < 0.4375) {
      if (ax < 7.450580596923828e-09) return x;
      id = -1;
    } else {
      x = ax;
      if (ax < 1.1875) {
        if (ax < 0.6875) {
          id = 0;
          x = (2.0 * x - 1.0) / (2.0 + x);
        }
        else {
          id = 1;
          x = (x - 1.0) / (x + 1.0);
        }
      } else if (ax < 2.4375) {
        id = 2;
        x = (x - 1.5) / (1.0 + 1.5 * x);
      }
      else {
        id = 3;
        x = -1.0 / x;
      }
    }
    z = x * x; w = z * z;
    s1 = z * (AT[0] + w * (AT[2] + w * (AT[4] + w * (AT[6] + w * (AT[8] + w * AT[10])))));
    s2 = w * (AT[1] + w * (AT[3] + w * (AT[5] + w * (AT[7] + w * AT[9]))));
    if (id < 0) return x - x * (s1 + s2);
    z = ATANHI[id] - ((x * (s1 + s2) - ATANLO[id]) - x);
    return neg ? -z : z;
  }
  function f_atan2(y, x) {
    let z, k, m;
    const hx = hiw(x), lx = low(x), ix = hx & 0x7fffffff, hy = hiw(y), ly = low(y), iy = hy & 0x7fffffff;
    if (x !== x || y !== y) return x + y;
    if (hx === 0x3ff00000 && lx === 0) return f_atan(y);
    m = ((hy >> 31) & 1) | ((hx >> 30) & 2);
    if ((iy | ly) === 0) {
      switch (m) {
        case 0: case 1: return y;
        case 2: return PI;
        default: return -PI;
      }
    }
    if ((ix | lx) === 0) return hy < 0 ? -PI_O_2 : PI_O_2;
    if (ix === 0x7ff00000) {
      if (iy === 0x7ff00000) {
        switch (m) {
          case 0: return PI_O_4;
          case 1: return -PI_O_4;
          case 2: return 3.0 * PI_O_4;
          default: return -3.0 * PI_O_4;
        }
      }
      switch (m) {
        case 0: return 0.0;
        case 1: return -0.0;
        case 2: return PI;
        default: return -PI;
      }
    }
    if (iy === 0x7ff00000) return hy < 0 ? -PI_O_2 : PI_O_2;
    k = (iy - ix) >> 20;
    if (k > 60) {
      z = PI_O_2 + 0.5 * PI_LO;
      m &= 1;
    }
    else if (hx < 0 && k < -60) z = 0.0;
    else z = f_atan(Math.abs(y / x));
    switch (m) {
      case 0: return z;
      case 1: return -z;
      case 2: return PI - (z - PI_LO);
      default: return (z - PI_LO) - PI;
    }
  }
  const PIO2_HI = 1.57079632679489655800e+00, PIO2_LO = 6.12323399573676603587e-17, PIO4_HI = 7.85398163397448278999e-01,
    PS0 = 1.66666666666666657415e-01, PS1 = -3.25565818622400915405e-01, PS2 = 2.01212532134862925881e-01,
    PS3 = -4.00555345006794114027e-02, PS4 = 7.91534994289814532176e-04, PS5 = 3.47933107596021167570e-05,
    QS1 = -2.40339491173441421878e+00, QS2 = 2.02094576023350569471e+00, QS3 = -6.88283971605453293030e-01,
    QS4 = 7.70381505559019352791e-02;
  function f_asin(x) {
    let t = 0.0, w, p, q, c, r, s;
    const hx = hiw(x), ix = hx & 0x7fffffff;
    if (ix >= 0x3ff00000) {
      if (((ix - 0x3ff00000) | low(x)) === 0) return x * PIO2_HI + x * PIO2_LO;
      return (x - x) / (x - x);
    } else if (ix < 0x3fe00000) {
      if (ix < 0x3e500000) return x;
      t = x * x;
      p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
      q = 1.0 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
      w = p / q;
      return x + x * w;
    }
    w = 1.0 - Math.abs(x);
    t = w * 0.5;
    p = t * (PS0 + t * (PS1 + t * (PS2 + t * (PS3 + t * (PS4 + t * PS5)))));
    q = 1.0 + t * (QS1 + t * (QS2 + t * (QS3 + t * QS4)));
    s = Math.sqrt(t);
    if (ix >= 0x3FEF3333) {
      w = p / q;
      t = PIO2_HI - (2.0 * (s + s * w) - PIO2_LO);
    } else {
      w = setlo0(s);
      c = (t - w * w) / (s + w);
      r = p / q;
      p = 2.0 * s * r - (PIO2_LO - 2.0 * c);
      q = PIO4_HI - 2.0 * w;
      t = PIO4_HI - (p - q);
    }
    return hx > 0 ? t : -t;
  }
  function f_acos(x) {
    let z, p, q, r, w, s, c, df;
    const hx = hiw(x), ix = hx & 0x7fffffff;
    if (ix >= 0x3ff00000) {
      if (((ix - 0x3ff00000) | low(x)) === 0) {
        if (hx > 0) return 0.0;
        return PI + 2.0 * PIO2_LO;
      }
      return (x - x) / (x - x);
    }
    if (ix < 0x3fe00000) {
      if (ix <= 0x3c600000) return PIO2_HI + PIO2_LO;
      z = x * x;
      p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
      q = 1.0 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
      r = p / q;
      return PIO2_HI - (x - (PIO2_LO - x * r));
    } else if (hx < 0) {
      z = (1.0 + x) * 0.5;
      p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
      q = 1.0 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
      s = Math.sqrt(z);
      r = p / q;
      w = r * s - PIO2_LO;
      return PI - 2.0 * (s + w);
    }
    z = (1.0 - x) * 0.5;
    s = Math.sqrt(z);
    df = setlo0(s);
    c = (z - df * df) / (s + df);
    p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5)))));
    q = 1.0 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
    r = p / q;
    w = r * s + c;
    return 2.0 * (df + w);
  }

  /* ---------- exp / log / log2 / pow / cbrt ---------- */
  const O_THRESHOLD = 7.09782712893383973096e+02, U_THRESHOLD = -7.45133219101941108420e+02,
    LN2HI = 6.93147180369123816490e-01, LN2LO = 1.90821492927058770002e-10, INVLN2 = 1.44269504088896338700e+00,
    EP1 = 1.66666666666666019037e-01, EP2 = -2.77777777770155933842e-03, EP3 = 6.61375632143793436117e-05,
    EP4 = -1.65339022054652515390e-06, EP5 = 4.13813679705723846039e-08,
    HUGE = 1.0e+300, TINY = 1.0e-300, TWOM1000 = 9.33263618503218878990e-302;
  function f_exp(x) {
    let y, hi = 0.0, lo = 0.0, c, t, twopk, k = 0;
    const hx0 = hiw(x), xsb = (hx0 >>> 31) & 1, hx = hx0 & 0x7fffffff;
    if (hx >= 0x40862E42) {
      if (hx >= 0x7ff00000) {
        if (x !== x) return x + x;
        return xsb === 0 ? x : 0.0;
      }
      if (x > O_THRESHOLD) return HUGE * HUGE;
      if (x < U_THRESHOLD) return TWOM1000 * TWOM1000;
    }
    if (hx > 0x3fd62e42) {
      if (hx < 0x3FF0A2B2) {
        if (xsb === 0) {
          hi = x - LN2HI;
          lo = LN2LO;
          k = 1;
        }
        else {
          hi = x + LN2HI;
          lo = -LN2LO;
          k = -1;
        }
      } else {
        k = (INVLN2 * x + (xsb === 0 ? 0.5 : -0.5)) | 0;
        t = k;
        hi = x - t * LN2HI;
        lo = t * LN2LO;
      }
      x = hi - lo;
    } else if (hx < 0x3e300000) {
      return 1.0 + x;
    } else k = 0;
    t = x * x;
    if (k >= -1021) twopk = mkw((0x3ff + k) << 20, 0);
    else twopk = mkw((0x3ff + (k + 1000)) << 20, 0);
    c = x - t * (EP1 + t * (EP2 + t * (EP3 + t * (EP4 + t * EP5))));
    if (k === 0) return 1.0 - ((x * c) / (c - 2.0) - x);
    y = 1.0 - ((lo - (x * c) / (2.0 - c)) - hi);
    if (k >= -1021) {
      if (k === 1024) return y * 2.0 * p2(1023);
      return y * twopk;
    }
    return y * twopk * TWOM1000;
  }
  const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01,
    LG4 = 2.222219843214978396e-01, LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01,
    LG7 = 1.479819860511658591e-01;
  function f_log(x) {
    let hfsq, f, s, z, R, w, t1, t2, dk, k = 0, i, j, hx = hiw(x);
    const lx = low(x);
    if (hx < 0x00100000) {
      if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
      if (hx < 0) return (x - x) / 0.0;
      k -= 54; x *= TWO54;
      hx = hiw(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    i = (hx + 0x95f64) & 0x100000;
    x = sethi(x, hx | (i ^ 0x3ff00000));
    k += (i >> 20);
    f = x - 1.0;
    if ((0x000fffff & (2 + hx)) < 3) {
      if (f === 0) {
        if (k === 0) return 0.0;
        dk = k;
        return dk * LN2HI + dk * LN2LO;
      }
      R = f * f * (0.5 - 0.33333333333333333 * f);
      if (k === 0) return f - R;
      dk = k;
      return dk * LN2HI - ((R - dk * LN2LO) - f);
    }
    s = f / (2.0 + f);
    dk = k;
    z = s * s;
    i = hx - 0x6147a;
    w = z * z;
    j = 0x6b851 - hx;
    t1 = w * (LG2 + w * (LG4 + w * LG6));
    t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    i |= j;
    R = t2 + t1;
    if (i > 0) {
      hfsq = 0.5 * f * f;
      if (k === 0) return f - (hfsq - s * (hfsq + R));
      return dk * LN2HI - ((hfsq - (s * (hfsq + R) + dk * LN2LO)) - f);
    }
    if (k === 0) return f - s * (f - R);
    return dk * LN2HI - ((s * (f - R) - dk * LN2LO) - f);
  }
  const IVLN2HI = 1.44269504072144627571e+00, IVLN2LO = 1.67517131648865118353e-10;
  function f_log2(x) {
    let f, hfsq, hi, lo, r, val_hi, val_lo, w, y, k = 0, i, hx = hiw(x), s, z, t1, t2, R;
    const lx = low(x);
    if (hx < 0x00100000) {
      if (((hx & 0x7fffffff) | lx) === 0) return -Infinity;
      if (hx < 0) return (x - x) / 0.0;
      k -= 54; x *= TWO54;
      hx = hiw(x);
    }
    if (hx >= 0x7ff00000) return x + x;
    if (hx === 0x3ff00000 && lx === 0) return 0.0;
    k += (hx >> 20) - 1023;
    hx &= 0x000fffff;
    i = (hx + 0x95f64) & 0x100000;
    x = sethi(x, hx | (i ^ 0x3ff00000));
    k += (i >> 20);
    y = k;
    f = x - 1.0;
    hfsq = 0.5 * f * f;
    s = f / (2.0 + f);
    z = s * s;
    w = z * z;
    t1 = w * (LG2 + w * (LG4 + w * LG6));
    t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
    R = t2 + t1;
    r = s * (hfsq + R);
    hi = setlo0(f - hfsq);
    lo = (f - hi) - hfsq + r;
    val_hi = hi * IVLN2HI;
    val_lo = (lo + hi) * IVLN2LO + lo * IVLN2HI;
    w = y + val_hi;
    val_lo += (y - w) + val_hi;
    val_hi = w;
    return val_lo + val_hi;
  }
  const DP_H1 = 5.84962487220764160156e-01, DP_L1 = 1.35003920212974897128e-08,
    PL1 = 5.99999999999994648725e-01, PL2 = 4.28571428578550184252e-01, PL3 = 3.33333329818377432918e-01,
    PL4 = 2.72728123808534006489e-01, PL5 = 2.30660745775561754067e-01, PL6 = 2.06975017800338417784e-01,
    LG2C = 6.93147180559945286227e-01, LG2_H = 6.93147182464599609375e-01, LG2_L = -1.90465429995776804525e-09,
    OVT = 8.0085662595372944372e-0017, CP = 9.61796693925975554329e-01, CP_H = 9.61796700954437255859e-01,
    CP_L = -7.02846165095275826516e-09, IVLN2_H = 1.44269502162933349609e+00, IVLN2_L = 1.92596299112661746887e-08,
    TWO53 = 9007199254740992.0;
  function f_pow(x, y) {
    let z, ax, z_h, z_l, p_h, p_l, y1, t1, t2, r, s, t, u, v, w, i, j, k, yisint, n;
    const hx = hiw(x), lx = low(x), hy = hiw(y), ly = low(y);
    let ix = hx & 0x7fffffff;
    const iy = hy & 0x7fffffff;
    if ((iy | ly) === 0) return 1.0;
    if (hx === 0x3ff00000 && lx === 0) return 1.0;
    if (ix > 0x7ff00000 || (ix === 0x7ff00000 && lx !== 0) || iy > 0x7ff00000 || (iy === 0x7ff00000 && ly !== 0)) return x + y;
    yisint = 0;
    if (hx < 0) {
      if (iy >= 0x43400000) yisint = 2;
      else if (iy >= 0x3ff00000) {
        k = (iy >> 20) - 0x3ff;
        if (k > 20) {
          j = ly >>> (52 - k);
          if (((j << (52 - k)) >>> 0) === ly) yisint = 2 - (j & 1);
        } else if (ly === 0) {
          j = iy >> (20 - k);
          if ((j << (20 - k)) === iy) yisint = 2 - (j & 1);
        }
      }
    }
    if (ly === 0) {
      if (iy === 0x7ff00000) {
        if (((ix - 0x3ff00000) | lx) === 0) return 1.0;
        else if (ix >= 0x3ff00000) return hy >= 0 ? y : 0.0;
        return hy < 0 ? -y : 0.0;
      }
      if (iy === 0x3ff00000) { return hy < 0 ? 1.0 / x : x; }
      if (hy === 0x40000000) return x * x;
      if (hy === 0x3fe00000) {
        if (hx >= 0) return Math.sqrt(x);
      }
    }
    ax = Math.abs(x);
    if (lx === 0) {
      if (ix === 0x7ff00000 || ix === 0 || ix === 0x3ff00000) {
        z = ax;
        if (hy < 0) z = 1.0 / z;
        if (hx < 0) {
          if (((ix - 0x3ff00000) | yisint) === 0) z = (z - z) / (z - z);
          else if (yisint === 1) z = -z;
        }
        return z;
      }
    }
    n = (hx >>> 31) - 1;
    if ((n | yisint) === 0) return (x - x) / (x - x);
    s = 1.0;
    if ((n | (yisint - 1)) === 0) s = -1.0;
    if (iy > 0x41e00000) {
      if (iy > 0x43f00000) {
        if (ix <= 0x3fefffff) return hy < 0 ? HUGE * HUGE : TINY * TINY;
        if (ix >= 0x3ff00000) return hy > 0 ? HUGE * HUGE : TINY * TINY;
      }
      if (ix < 0x3fefffff) return hy < 0 ? s * HUGE * HUGE : s * TINY * TINY;
      if (ix > 0x3ff00000) return hy > 0 ? s * HUGE * HUGE : s * TINY * TINY;
      t = ax - 1.0;
      w = (t * t) * (0.5 - t * (3.3333333333333331e-01 - t * 0.25));
      u = IVLN2_H * t;
      v = t * IVLN2_L - w * INVLN2;
      t1 = setlo0(u + v);
      t2 = v - (t1 - u);
    } else {
      let ss, s2, s_h, s_l, t_h, t_l;
      n = 0;
      if (ix < 0x00100000) {
        ax *= TWO53;
        n -= 53;
        ix = hiw(ax);
      }
      n += (ix >> 20) - 0x3ff;
      j = ix & 0x000fffff;
      ix = j | 0x3ff00000;
      if (j <= 0x3988E) k = 0;
      else if (j < 0xBB67A) k = 1;
      else {
        k = 0;
        n += 1;
        ix -= 0x00100000;
      }
      ax = sethi(ax, ix);
      const bpk = k === 0 ? 1.0 : 1.5;
      u = ax - bpk;
      v = 1.0 / (ax + bpk);
      ss = u * v;
      s_h = setlo0(ss);
      t_h = mkw(((ix >> 1) | 0x20000000) + 0x00080000 + (k << 18), 0);
      t_l = ax - (t_h - bpk);
      s_l = v * ((u - s_h * t_h) - s_h * t_l);
      s2 = ss * ss;
      r = s2 * s2 * (PL1 + s2 * (PL2 + s2 * (PL3 + s2 * (PL4 + s2 * (PL5 + s2 * PL6)))));
      r += s_l * (s_h + ss);
      s2 = s_h * s_h;
      t_h = setlo0(3.0 + s2 + r);
      t_l = r - ((t_h - 3.0) - s2);
      u = s_h * t_h;
      v = s_l * t_h + t_l * ss;
      p_h = setlo0(u + v);
      p_l = v - (p_h - u);
      z_h = CP_H * p_h;
      z_l = CP_L * p_h + p_l * CP + (k === 0 ? 0.0 : DP_L1);
      t = n;
      t1 = setlo0(((z_h + z_l) + (k === 0 ? 0.0 : DP_H1)) + t);
      t2 = z_l - (((t1 - t) - (k === 0 ? 0.0 : DP_H1)) - z_h);
    }
    y1 = setlo0(y);
    p_l = (y - y1) * t1 + y * t2;
    p_h = y1 * t1;
    z = p_l + p_h;
    j = hiw(z); i = low(z);
    if (j >= 0x40900000) {
      if (((j - 0x40900000) | i) !== 0) return s * HUGE * HUGE;
      if (p_l + OVT > z - p_h) return s * HUGE * HUGE;
    } else if ((j & 0x7fffffff) >= 0x4090cc00) {
      if (((j - 0xc090cc00) | i) !== 0) return s * TINY * TINY;
      if (p_l <= z - p_h) return s * TINY * TINY;
    }
    i = j & 0x7fffffff;
    k = (i >> 20) - 0x3ff;
    n = 0;
    if (i > 0x3fe00000) {
      n = j + (0x00100000 >> (k + 1));
      k = ((n & 0x7fffffff) >> 20) - 0x3ff;
      t = mkw(n & ~(0x000fffff >> k), 0);
      n = ((n & 0x000fffff) | 0x00100000) >> (20 - k);
      if (j < 0) n = -n;
      p_h -= t;
    }
    t = setlo0(p_l + p_h);
    u = t * LG2_H;
    v = (p_l - (t - p_h)) * LG2C + t * LG2_L;
    z = u + v;
    w = v - (z - u);
    t = z * z;
    t1 = z - t * (EP1 + t * (EP2 + t * (EP3 + t * (EP4 + t * EP5))));
    r = (z * t1) / (t1 - 2.0) - (w + z * w);
    z = 1.0 - (r - z);
    j = hiw(z);
    j += (n << 20);
    if ((j >> 20) <= 0) z = scalbn(z, n);
    else z = sethi(z, j);
    return s * z;
  }
  const CB_B1 = 715094163, CB_B2 = 696219795, CB_P0 = 1.87595182427177009643, CB_P1 = -1.88497979543377169875,
    CB_P2 = 1.621429720105354466140, CB_P3 = -0.758397934778766047437, CB_P4 = 0.145996192886612446982;
  function f_cbrt(x) {
    let hx = hiw(x), r, s, t = 0.0, w, high, lo, hi2;
    const lw = low(x), sign = hx & 0x80000000;
    hx ^= sign;
    if (hx >= 0x7ff00000) return x + x;
    if (hx < 0x00100000) {
      if ((hx | lw) === 0) return x;
      t = mkw(0x43500000, 0);
      t *= x;
      high = hiw(t);
      t = mkw(sign | (((high & 0x7fffffff) / 3 | 0) + CB_B2), 0);
    } else t = mkw(sign | ((hx / 3 | 0) + CB_B1), 0);
    r = (t * t) * (t / x);
    t = t * ((CB_P0 + r * (CB_P1 + r * CB_P2)) + ((r * r) * r) * (CB_P3 + r * CB_P4));
    FB[0] = t;
    lo = UB[LO] + 2147483648; hi2 = UB[HI];
    if (lo >= 4294967296) {
      lo -= 4294967296;
      hi2 = (hi2 + 1) >>> 0;
    }
    UB[LO] = (lo & 0xc0000000) >>> 0; UB[HI] = hi2;
    t = FB[0];
    s = t * t;
    r = x / s;
    w = t + t;
    r = (r - t) / (w + r);
    t = t + t * r;
    return t;
  }
  M.sin = f_sin;
  M.cos = f_cos;
  M.tan = f_tan;
  M.asin = f_asin;
  M.acos = f_acos;
  M.atan = f_atan;
  M.atan2 = f_atan2;
  M.exp = f_exp;
  M.log = f_log;
  M.log2 = f_log2;
  M.pow = f_pow;
  M.cbrt = f_cbrt;
  /* min / max with C fminf / fmaxf semantics: a NaN operand loses (the other one is returned; both NaN -> NaN). JS
   * Math.min / Math.max
   * return NaN if either is NaN, C's fmin does not, and the sim must not depend on which engine it runs on, so the sim
   * never calls Math.min / Math.max (portabilitytest). The sign of zero is not specified (Math.min(0, -0) is -0 here, 0
   * in C): never branch on it. */
  M.min = (a, b) => (a !== a ? b : b !== b ? a : b < a ? b : a);
  M.max = (a, b) => (a !== a ? b : b !== b ? a : b > a ? b : a);
  // the plain compare (signed-distance-field code, where no NaN occurs): the other argument on a tie (+0 against -0)
  // and on a NaN; use M.min / M.max wherever a NaN may reach the call
  M.fast_min = (a, b) => (a < b ? a : b);
  M.fast_max = (a, b) => (a > b ? a : b);
  /* zero / NaN guard: v if it is a usable non-zero number, else d (what `v || d` did in JS; in C: (v != 0 && v == v) ?
   * v : d). Used for the
   * divisor of a normalisation (M.nz(M.len3(x, y, z), 1)). A NaN here is a bug upstream; the hash shows it (sim.hash
   * mixes NaN as its own constant). */
  M.nz = (v, d) => (v !== 0 && v === v ? v : d);
  M.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  M.sat = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  M.lerp = (a, b, t) => a + (b - a) * t;
  M.smooth = x => x * x * (3 - 2 * x);
  M.smoothstep = (a, b, x) => {
    const t = M.sat((x - a) / (b - a));
    return t * t * (3 - 2 * t);
  };
  M.wrap_angle = a => {
    if (!(a > -1e6 && a < 1e6)) return 0;            // NaN / Infinity / garbage input: 0 (C: fmod would give NaN)
    let n = 0;                                       // a few turns (the normal case): repeated subtraction, as always
    while (a > Math.PI && n < 8) {
      a -= M.TAU;
      n++;
    }
    while (a < -Math.PI && n < 8) {
      a += M.TAU;
      n++;
    }
    // many turns: bounded cost (<= 1e6 rad)
    if (a > Math.PI || a < -Math.PI) {
      a -= M.TAU * Math.floor((a + Math.PI) / M.TAU);
      if (a > Math.PI) a = Math.PI;
      else if (a < -Math.PI) a = -Math.PI;
    }
    return a;
  };
  /* Stable insertion sort (the contract for every sim ordering that is not already a total order: equal keys keep their
   * input order, so the result does not depend on the sort algorithm; C qsort is unstable, std::sort too). cmp(a, b) >
   * 0 means a goes after b. A NaN compare result counts as equal. In C: a loop over the array (n <= ~100 everywhere it
   * is used). */
  M.sort_stable = (a, cmp) => {
    for (let i = 1; i < a.length; i++) {
      const x = a[i];
      let j = i - 1;
      while (j >= 0 && cmp(a[j], x) > 0) {
        a[j + 1] = a[j];
        j--;
      }
      a[j + 1] = x;
    }
    return a;
  };
  M.sign = v => (v > 0 ? 1 : v < 0 ? -1 : 0);

  /* ---------- vec3 (plain struct) ---------- */
  M.v3 = (x, y, z) => ({ x, y, z });
  M.v3_copy = a => ({ x: a.x, y: a.y, z: a.z });
  M.v3_set = (o, x, y, z) => {
    o.x = x;
    o.y = y;
    o.z = z;
    return o;
  };
  M.v3_dist = (a, b) => M.len3(a.x - b.x, a.y - b.y, a.z - b.z);
  M.v3_len = a => M.len3(a.x, a.y, a.z);
  M.v3_sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
  M.v3_dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  M.v3_cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

  /* ---------- quaternion (plain struct {x,y,z,w}) ---------- */
  M.q_ident = () => ({ x: 0, y: 0, z: 0, w: 1 });
  M.q_axis_angle = (ax, ay, az, ang) => {
    const s = M.sin(ang / 2);
    return { x: ax * s, y: ay * s, z: az * s, w: M.cos(ang / 2) };
  };
  M.q_mul = (a, b) => ({
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z
  });
  M.q_norm = q => {
    const l = M.len4(q.x, q.y, q.z, q.w) || 1;
    q.x /= l;
    q.y /= l;
    q.z /= l;
    q.w /= l;
    return q;
  };
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
    q.x = x;
    q.y = y;
    q.z = z;
    q.w = w;
    return M.q_norm(q);
  };

  /* ---------- RNG: struct { u32 s; } (LCG, deterministic) ---------- */
  M.rng_make = seed => ({ s: seed >>> 0 });
  M.rng_seed = (r, seed) => { r.s = seed >>> 0; };
  M.rng_next = r => {
    r.s = (Math.imul(r.s, 1664525) + 1013904223) >>> 0;
    return r.s / 4294967296;
  };
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
    let u = x - xi, v = y - yi, w = z - zi;
    u = u * u * (3 - 2 * u);
    v = v * v * (3 - 2 * v);
    w = w * w * (3 - 2 * w);
    const a = h4(xi, yi, zi, seed), b = h4(xi + 1, yi, zi, seed), c = h4(xi, yi + 1, zi, seed), d = h4(xi + 1, yi + 1, zi, seed);
    const e = h4(xi, yi, zi + 1, seed),
      f = h4(xi + 1, yi, zi + 1, seed),
      g = h4(xi, yi + 1, zi + 1, seed),
      h = h4(xi + 1, yi + 1, zi + 1, seed);
    const x1 = a + (b - a) * u, x2 = c + (d - c) * u, x3 = e + (f - e) * u, x4 = g + (h - g) * u;
    const y1 = x1 + (x2 - x1) * v, y2 = x3 + (x4 - x3) * v;
    return y1 + (y2 - y1) * w;
  };
  M.noise2 = (x, z, seed) => {
    const xi = Math.floor(x), zi = Math.floor(z);
    let u = x - xi, w = z - zi;
    u = u * u * (3 - 2 * u);
    w = w * w * (3 - 2 * w);
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
    for (let o = 0; o < oct; o++) {
      const r = 1 - Math.abs(M.noise2(x * f, z * f, seed + o * 57) * 2 - 1);
      s += a * r * r;
      n += a;
      a *= 0.5;
      f *= 2.07;
    }
    return s / n;
  };
  /* distance from point to segment a->b (arrays [x,y,z]) */
  M.seg_dist = (px, py, pz, a, b) => {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const t = M.sat(((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / (abx * abx + aby * aby + abz * abz || 1));
    return M.len3(px - a[0] - abx * t, py - a[1] - aby * t, pz - a[2] - abz * t);
  };
})(window.SS = window.SS || {});
