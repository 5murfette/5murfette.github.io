/* render/decorkit.js — P96 decor kit: the geometry of the biome set dressing placed by render/clutter.js (Three.js
 * specific, presentation only).
 * Meshes are built once in code: smooth normals with a crease angle, noise-displaced blobs, lathes and sweeps, no UVs
 * (the clutter material maps them TRIPLANAR from the shared PBR atlas assets/decor.js). Per vertex: position, normal,
 * colour (tint, sRGB intent) and `tl` = (tile A, tile B, blend 0..1): the atlas tile ids are in K.TILE (-1 =
 * untextured, the tint alone). The geometry's base sits at y = 0 (the clutter material darkens it near the ground).
 * Fern fronds are alpha cards (uv) with a canvas-drawn leaf texture (K.fernTexture()). API: SS.decorKit = { TILE, GF: {
 * kind: () => BufferGeometry }, fernTexture() }. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const K = SS.decorKit = {};
  const TAU = 6.2832;
  const TILE =
    K.TILE = {
      bark: 0, moss: 1, cactus: 2, bone: 3, sandstone: 4, obsidian: 5, pumice: 6, frost: 7, rust: 8, mushcap: 9, endgrain: 10, limestone: 11
    };
  const h3 = (a, b, c) => M.hash3(a * 13 + 1, b * 7 + 3, c * 5 + 2);
  const clamp = M.clamp,
    sstep = (a, b, x) => {
      const t = clamp((x - a) / (b - a), 0, 1);
      return t * t * (3 - 2 * t);
    };
  /* value noise + fbm (deterministic, hashed lattice) */
  function vn(x, y, z) {
    const ix = Math.floor(x),
      iy = Math.floor(y),
      iz = Math.floor(z),
      fx = x - ix,
      fy = y - iy,
      fz = z - iz,
      u = fx * fx * (3 - 2 * fx),
      v = fy * fy * (3 - 2 * fy),
      w = fz * fz * (3 - 2 * fz);
    const g = (a, b, c) => M.hash3(ix + a + 91, iy + b + 17, iz + c + 3);
    const l = (a, b, t) => a + (b - a) * t;
    return l(
      l(l(g(0, 0, 0), g(1, 0, 0), u), l(g(0, 1, 0), g(1, 1, 0), u), v),
      l(l(g(0, 0, 1), g(1, 0, 1), u), l(g(0, 1, 1), g(1, 1, 1), u), v),
      w
    );
  }
  const fbm = (x, y, z) => vn(x, y, z) * 0.55 + vn(x * 2.07, y * 2.07, z * 2.07) * 0.3 + vn(x * 4.3, y * 4.3, z * 4.3) * 0.15;

  /* ---------- builder ---------- */
  /* b.A / b.B: current tile ids, b.wf(x, y, z) -> blend weight of tile B for a vertex (default 0), b.tint: multiplies
   * the colours given */
  const mk = () => ({ p: [], c: [], t: [], A: -1, B: -1, wf: null });
  const push = (b, p, c) => {
    b.p.push(p[0], p[1], p[2]);
    b.c.push(c[0], c[1], c[2]);
    b.t.push(b.A, b.B, b.wf ? b.wf(p[0], p[1], p[2]) : 0);
  };
  const tri = (b, a, d, e, ca, cd, ce) => {
    push(b, a, ca);
    push(b, d, cd || ca);
    push(b, e, ce || ca);
  };
  const quad = (b, a, d, e, f, ca, cd, ce, cf) => {
    tri(b, a, d, e, ca, cd, ce);
    tri(b, a, e, f, ca, ce, cf);
  };
  const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const COS_CREASE = 0.55;
  /* finish: smooth normals welded by position with a crease angle (flat = true keeps every face flat), colours ->
   * linear */
  function fin(b, flat) {
    const g = new T.BufferGeometry(), n = b.p.length / 3, P = b.p, nr = new Float32Array(n * 3), fn = new Float32Array(n * 3);
    for (let f = 0; f < n; f += 3) {
      const ax = P[f * 3],
        ay = P[f * 3 + 1],
        az = P[f * 3 + 2],
        ux = P[f * 3 + 3] - ax,
        uy = P[f * 3 + 4] - ay,
        uz = P[f * 3 + 5] - az,
        vx = P[f * 3 + 6] - ax,
        vy = P[f * 3 + 7] - ay,
        vz = P[f * 3 + 8] - az;
      const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
      for (let k = 0; k < 3; k++) {
        fn[(f + k) * 3] = x;
        fn[(f + k) * 3 + 1] = y;
        fn[(f + k) * 3 + 2] = z;
      }
    }
    if (flat) {
      for (let i = 0; i < n; i++) {
        const l = Math.hypot(fn[i * 3], fn[i * 3 + 1], fn[i * 3 + 2]) || 1;
        nr[i * 3] = fn[i * 3] / l;
        nr[i * 3 + 1] = fn[i * 3 + 1] / l;
        nr[i * 3 + 2] = fn[i * 3 + 2] / l;
      }
    }
    else {
      const map = new Map(),
        key = i => Math.round(P[i * 3] * 4000) + ',' + Math.round(P[i * 3 + 1] * 4000) + ',' + Math.round(P[i * 3 + 2] * 4000);
      for (let i = 0; i < n; i++) {
        const k = key(i);
        let l = map.get(k);
        if (!l) map.set(k, l = []);
        l.push(i);
      }
      for (let i = 0; i < n; i++) {
        const l = map.get(key(i)),
          il = Math.hypot(fn[i * 3], fn[i * 3 + 1], fn[i * 3 + 2]) || 1,
          ix = fn[i * 3] / il,
          iy = fn[i * 3 + 1] / il,
          iz = fn[i * 3 + 2] / il;
        let sx = 0, sy = 0, sz = 0;
        for (let q = 0; q < l.length; q++) {
          const j = l[q], jl = Math.hypot(fn[j * 3], fn[j * 3 + 1], fn[j * 3 + 2]) || 1;
          if ((fn[j * 3] * ix + fn[j * 3 + 1] * iy + fn[j * 3 + 2] * iz) / jl > COS_CREASE) {
            sx += fn[j * 3];
            sy += fn[j * 3 + 1];
            sz += fn[j * 3 + 2];
          }
        }
        const sl = Math.hypot(sx, sy, sz) || 1;
        nr[i * 3] = sx / sl;
        nr[i * 3 + 1] = sy / sl;
        nr[i * 3 + 2] = sz / sl;
      }
    }
    g.setAttribute('position', new T.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new T.BufferAttribute(nr, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(b.c.map(v => Math.pow(Math.max(v, 0), 2.2)), 3));
    g.setAttribute('tl', new T.Float32BufferAttribute(b.t, 3));
    return g;
  }
  /* a surface of revolution about +y: prof = [[radius, y, colour | fn(i)]], n sides, centre (ox, oy, oz), jit(i, j)
   * scales the radius */
  function lathe(b, prof, n, ox, oy, oz, jit, jy) {
    const ring = (j, i) => {
      const k = i % n, r = prof[j][0] * (jit ? jit(k, j) : 1), a = k / n * TAU;
      return [ox + Math.cos(a) * r, oy + prof[j][1] + (jy ? jy(k, j) : 0), oz + Math.sin(a) * r];
    };
    const col = (j, i) => {
      const c = prof[j][2];
      return typeof c === 'function' ? c(i % n) : c;
    };
    for (let j = 0; j < prof.length - 1; j++)
      for (let i = 0; i < n; i++) {
        const a = ring(j, i),
          d = ring(j, i + 1),
          e = ring(j + 1, i + 1),
          f = ring(j + 1, i),
          z0 = prof[j][0] <= 0,
          z1 = prof[j + 1][0] <= 0;
        if (z0 && z1) continue;
        if (z0) tri(b, a, e, f, col(j, i), col(j + 1, i + 1), col(j + 1, i));
        else if (z1) tri(b, a, d, e, col(j, i), col(j, i + 1), col(j + 1, i));
        else quad(b, a, d, e, f, col(j, i), col(j, i + 1), col(j + 1, i + 1), col(j + 1, i));
      }
  }
  /* a tube along a polyline: rad[j] per point, n sides, colour fn(j, i), cap colours (or null) close the ends */
  function tube(b, pts, rad, n, colf, c0, c1, jit) {
    const rings = [];
    let pux = 0, puy = 0, puz = 0;
    for (let j = 0; j < pts.length; j++) {
      const p0 = pts[Math.max(j - 1, 0)], p1 = pts[Math.min(j + 1, pts.length - 1)];
      let tx = p1[0] - p0[0], ty = p1[1] - p0[1], tz = p1[2] - p0[2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      let ux, uy, uz;
      if (j === 0) {
        const rf = Math.abs(ty) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        ux = ty * rf[2] - tz * rf[1];
        uy = tz * rf[0] - tx * rf[2];
        uz = tx * rf[1] - ty * rf[0];
      }
      // parallel transport: no twist at bends
      else {
        const d = pux * tx + puy * ty + puz * tz;
        ux = pux - tx * d;
        uy = puy - ty * d;
        uz = puz - tz * d;
      }
      const ul = Math.hypot(ux, uy, uz) || 1;
      ux /= ul;
      uy /= ul;
      uz /= ul;
      pux = ux;
      puy = uy;
      puz = uz;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux, ring = [];
      for (let i = 0; i < n; i++) {
        const a = i / n * TAU, r = rad[j] * (jit ? jit(i, j) : 1), ca = Math.cos(a) * r, sa = Math.sin(a) * r;
        ring.push([pts[j][0] + ux * ca + vx * sa, pts[j][1] + uy * ca + vy * sa, pts[j][2] + uz * ca + vz * sa]);
      }
      rings.push(ring);
    }
    for (let j = 0; j < pts.length - 1; j++)
      for (let i = 0; i < n; i++) {
        const i2 = (i + 1) % n;
        quad(b, rings[j][i], rings[j][i2], rings[j + 1][i2], rings[j + 1][i], colf(j, i), colf(j, i2), colf(j + 1, i2), colf(j + 1, i));
      }
    const cap = (ring, c, p) => {
      for (let i = 0; i < n; i++) tri(b, p, ring[i], ring[(i + 1) % n], c, c, c);
    };
    if (c0) cap(rings[0], c0, pts[0]);
    if (c1) cap(rings[pts.length - 1], c1, pts[pts.length - 1]);
    return rings;
  }
  /* copy a sub-mesh into b through a rotation (euler x, y, z), uniform scale and translation */
  const tm = new T.Matrix4(), te = new T.Euler(), tq = new T.Quaternion(), tv = new T.Vector3(), ts = new T.Vector3();
  function place(b, sub, px, py, pz, rx, ry, rz, s) {
    te.set(rx, ry, rz); tq.setFromEuler(te); tm.compose(tv.set(px, py, pz), tq, ts.set(s, s, s));
    for (let i = 0; i < sub.p.length; i += 3) {
      tv.set(sub.p[i], sub.p[i + 1], sub.p[i + 2]).applyMatrix4(tm);
      b.p.push(tv.x, tv.y, tv.z);
    }
    for (let i = 0; i < sub.c.length; i++) b.c.push(sub.c[i]);
    for (let i = 0; i < sub.t.length; i++) b.t.push(sub.t[i]);
  }
  /* a noise-displaced ellipsoid (icosphere of `det` subdivisions): amp = relative bump, sq > 0 squares it up (blocky
   * stones), flat clips the bottom, wfn(dir) = blend weight */
  const ICO = [];
  function icoSphere(det) {
    if (ICO[det]) return ICO[det];
    const g = new T.IcosahedronGeometry(1, det), p = g.attributes.position, out = [];
    for (let i = 0; i < p.count; i++) out.push(p.getX(i), p.getY(i), p.getZ(i));
    return (ICO[det] = out);
  }
  function blob(b, cx, cy, cz, rx, ry, rz, det, amp, seed, col, o) {
    o = o || {};
    const P = icoSphere(det), sq = o.sq || 0, fl = o.flat != null ? o.flat : -2;
    const dp = (x, y, z) => {
      const l = Math.hypot(x, y, z), dx = x / l, dy = y / l, dz = z / l;
      let r = 1
        + amp * (fbm(dx * 1.7 + seed, dy * 1.7 + seed * 0.7, dz * 1.7 - seed) - 0.5) * 2
        + (o.ridge || 0) * (vn(dx * 5 + seed, dy * 5, dz * 5) - 0.5);
      let X = dx, Y = dy, Z = dz;
      if (sq) {
        const e = 1 - sq;
        X = Math.sign(dx) * Math.pow(Math.abs(dx), e);
        Y = Math.sign(dy) * Math.pow(Math.abs(dy), e);
        Z = Math.sign(dz) * Math.pow(Math.abs(dz), e);
      }
      return [cx + X * r * rx, cy + Math.max(Y * r, fl) * ry, cz + Z * r * rz, dy];
    };
    const oldWf = b.wf;
    for (let i = 0; i < P.length; i += 9) {
      const v0 = dp(P[i], P[i + 1], P[i + 2]), v1 = dp(P[i + 3], P[i + 4], P[i + 5]), v2 = dp(P[i + 6], P[i + 7], P[i + 8]);
      const c = typeof col === 'function' ? col : () => col;
      if (o.wfn) {
        const sA = b.A;
        b.wf = null;
        push2(b, v0, c(v0), o.wfn(v0, seed));
        push2(b, v1, c(v1), o.wfn(v1, seed));
        push2(b, v2, c(v2), o.wfn(v2, seed));
        b.A = sA;
      }
      else tri(b, v0, v1, v2, c(v0), c(v1), c(v2));
    }
    b.wf = oldWf;
  }
  const push2 = (b, p, c, w) => {
    b.p.push(p[0], p[1], p[2]);
    b.c.push(c[0], c[1], c[2]);
    b.t.push(b.A, b.B, w);
  };
  /* a pointed hexagonal crystal (axis +y), w = half width, hh = height */
  function crystal(b, w, hh, c0, c1, n) {
    lathe(
      b,
      [[w * 0.9, 0, c0], [w, hh * 0.12, i => i % 2 ? c0 : c1], [w, hh * 0.7, i => i % 2 ? c1 : mixc(c0, c1, 0.5)], [0, hh, c1]],
      n || 6,
      0,
      0,
      0,
      (i, j) => 1 - 0.1 * (i % 3 === 0 ? 1 : 0)
    );
  }
  function cluster(b, nC, spread, hMin, hMax, w, c0, c1, seed, lean) {
    for (let k = 0; k < nC; k++) {
      const sub = mk();
      sub.A = b.A;
      sub.B = b.B;
      const a = k / nC * TAU + h3(k, seed, 1) * 1.2,
        rr = k === 0 ? 0 : spread * (0.5 + 0.7 * h3(k, seed, 2)),
        hh = hMin + (hMax - hMin) * (k === 0 ? 1 : h3(k, seed, 3)),
        ln = (k === 0 ? 0.1 : lean) * (0.6 + 0.8 * h3(k, seed, 4));
      crystal(sub, w * (0.7 + 0.5 * h3(k, seed, 5)), hh, c0, c1);
      place(b, sub, Math.cos(a) * rr, -0.02, Math.sin(a) * rr, Math.sin(a) * ln, h3(k, seed, 6) * TAU, -Math.cos(a) * ln, 1);
    }
  }
  const rotY = (p, a) => [p[0] * Math.cos(a) + p[2] * Math.sin(a), p[1], -p[0] * Math.sin(a) + p[2] * Math.cos(a)];

  /* ---------- the kinds ---------- */
  function mushroom(b, x, z, h, r, tint, spots, seed) {
    b.A = TILE.bone; b.B = -1; b.wf = null;
    lathe(
      b,
      [
        [r * 0.42, 0, [0.75, 0.7, 0.6]],
        [r * 0.3, h * 0.2, [0.95, 0.92, 0.82]],
        [r * 0.24, h * 0.55, [0.95, 0.92, 0.82]],
        [r * 0.27, h * 0.95, [0.9, 0.86, 0.76]]
      ],
      8,
      x,
      0,
      z,
      (i, j) => 0.93 + 0.14 * h3(i, j, seed)
    );
    b.A = TILE.mushcap;
    const sp = i => spots && h3(i, 3, seed) > 0.55 ? [2.2, 2.2, 2.0] : tint;
    lathe(
      b,
      [
        [r * 0.28, h * 0.9, [0.9, 0.85, 0.72]],
        [r * 0.9, h * 0.94, [0.85, 0.8, 0.68]],
        [r, h * 1.05, tint],
        [r * 0.95, h * 1.18, sp],
        [r * 0.75, h * 1.36, sp],
        [r * 0.4, h * 1.5, tint],
        [0, h * 1.56, tint]
      ],
      12,
      x,
      0,
      z,
      (i, j) => 0.94 + 0.12 * h3(i, j, seed + 3)
    );
  }
  function mushGeo(v) {
    const b = mk();
    if (v === 0) {
      let k = 0;
      for (const d of [[0, 0, 0.19, 0.09], [0.15, 0.06, 0.11, 0.058], [-0.11, 0.1, 0.14, 0.07], [0.04, -0.13, 0.075, 0.042]])
        mushroom(b, d[0], d[1], d[2], d[3], [1.55, 0.3, 0.24], true, ++k);
    }
    else
      for (let k = 0; k < 6; k++) {
        const a = k * 2.1 + 0.4, rr = k ? 0.05 + 0.07 * h3(k, 1, 7) : 0, hh = 0.07 + 0.07 * h3(k, 2, 7);
        mushroom(b, Math.cos(a) * rr, Math.sin(a) * rr, hh, 0.035 + 0.03 * h3(k, 3, 7), [0.95, 0.62, 0.38], false, k + 9);
      }
    return fin(b);
  }
  /* fern: alpha cards (a curved strip per frond, uv = across / along) textured with the canvas leaf; fake upward
   * normals like the grass blades */
  function fernGeo() {
    const pos = [], col = [], uv = [], nr = [], nf = 13;
    for (let f = 0; f < nf; f++) {
      const a = f / nf * TAU + h3(f, 1, 1) * 0.5,
        len = 0.8 * (0.7 + 0.5 * h3(f, 2, 1)),
        ca = Math.cos(a),
        sa = Math.sin(a),
        px = -sa,
        pz = ca,
        wid = 0.1 * len / 0.6 + 0.04,
        SG = 6;
      const P = t => [ca * len * t * 0.95, len * (1.15 * t - 0.95 * t * t) + 0.02, sa * len * t * 0.95];
      for (let s = 0; s < SG; s++) {
        const t0 = s / SG,
          t1 = (s + 1) / SG,
          p0 = P(t0),
          p1 = P(t1),
          w0 = wid * (1 - 0.25 * t0),
          w1 = wid * (1 - 0.25 * t1),
          g0 = mixc([0.3, 0.55, 0.22], [0.75, 1.0, 0.5], t0),
          g1 = mixc([0.3, 0.55, 0.22], [0.75, 1.0, 0.5], t1);
        const A = [p0[0] - px * w0, p0[1], p0[2] - pz * w0],
          B = [p0[0] + px * w0, p0[1], p0[2] + pz * w0],
          C = [p1[0] + px * w1, p1[1] - 0.012, p1[2] + pz * w1],
          D = [p1[0] - px * w1, p1[1] - 0.012, p1[2] - pz * w1];
        const vt = [[A, 0, t0, g0], [B, 1, t0, g0], [C, 1, t1, g1], [A, 0, t0, g0], [C, 1, t1, g1], [D, 0, t1, g1]];
        for (const q of vt) {
          pos.push(q[0][0], q[0][1], q[0][2]);
          uv.push(q[1], q[2]);
          col.push(Math.pow(q[3][0], 2.2), Math.pow(q[3][1], 2.2), Math.pow(q[3][2], 2.2));
          nr.push(0, 1, 0);
        }
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.setAttribute('normal', new T.Float32BufferAttribute(nr, 3));
    return g;
  }
  let fernTex = null;
  K.fernTexture = function () {
    if (fernTex) return fernTex;
    const cv = document.createElement('canvas');
    cv.width = 128;
    cv.height = 256;
    const x = cv.getContext('2d');
    x.clearRect(0, 0, 128, 256);
    const gr = x.createLinearGradient(0, 256, 0, 0);
    gr.addColorStop(0, '#5b8a3a');
    gr.addColorStop(1, '#a8d070');
    // midrib (v = 0 at the base: canvas y 256 is uv v = 0 with flipY)
    x.strokeStyle = '#5a7f35';
    x.lineWidth = 3;
    x.beginPath();
    x.moveTo(64, 256);
    x.lineTo(64, 6);
    x.stroke();
    // pinnae: lanceolate leaflets, longest at 1/3, shorter to the tip
    for (let k = 0; k < 20; k++) {
      const t = k / 20, y = 250 - t * 236, L = 56 * Math.sin(Math.PI * (0.12 + 0.88 * (1 - t) * 1.0)) * (0.55 + 0.45 * (1 - t)) + 8;
      for (const sg of [-1, 1]) {
        x.fillStyle = gr;
        x.beginPath();
        x.moveTo(64, y);
        x.quadraticCurveTo(64 + sg * L * 0.6, y - 14, 64 + sg * L, y - 22 - 6 * (1 - t));
        x.quadraticCurveTo(64 + sg * L * 0.55, y - 3, 64, y + 6);
        x.fill();
        x.strokeStyle = 'rgba(40,70,25,0.55)';
        x.lineWidth = 1;
        x.beginPath();
        x.moveTo(64, y);
        x.lineTo(64 + sg * L * 0.9, y - 19);
        x.stroke();
      }
    }
    fernTex = new T.CanvasTexture(cv);
    fernTex.colorSpace = T.SRGBColorSpace;
    fernTex.anisotropy = 4;
    return fernTex;
  };
  function logGeo() {
    const b = mk(), pts = [], rad = [], n = 14, L = 12, BARK = [0.95, 0.9, 0.85];
    for (let j = 0; j <= L; j++) {
      pts.push([(j / L - 0.5) * 1.7, 0.17 + 0.012 * Math.sin(j * 1.3), 0.03 * Math.sin(j * 0.9)]);
      rad.push(0.17 * (1 - 0.12 * j / L));
    }
    b.A = TILE.bark; b.B = TILE.moss;
    b.wf = (x, y, z) => {
      const top = (y - 0.17) / 0.17;
      return clamp((top - 0.1) * 1.9 + (fbm(x * 6, y * 6, z * 6) - 0.5) * 1.1, 0, 1);
    };
    const jit = (i, j) => 0.9
      + 0.2 * fbm(Math.cos(i / n * TAU) * 1.6 + 5, Math.sin(i / n * TAU) * 1.6, j * 0.4)
      + (i % 2 ? 0.015 : 0)
      + (j === L ? 0.1 * h3(i, 4, 4) : 0);
    const rings = tube(b, pts, rad, n, () => BARK, null, null, jit);
    b.wf = null; b.A = b.B = TILE.endgrain;                                                    // one clean sawn end, one splintered break
    const e0 = rings[0], c0 = pts[0];
    for (let i = 0; i < n; i++) tri(b, c0, e0[i], e0[(i + 1) % n], [0.95, 0.85, 0.7]);
    const e1 = rings[L];
    for (let i = 0; i < n; i += 1) {
      const sp = (i % 3 === 0 ? 0.16 : 0.03) * (0.5 + h3(i, 6, 6)), a0 = e1[i], a1 = e1[(i + 1) % n];
      tri(b, a0, a1, [(a0[0] + a1[0]) / 2 + sp, (a0[1] + a1[1]) / 2 + 0.01, (a0[2] + a1[2]) / 2], [1.0, 0.9, 0.75], [1.0, 0.9, 0.75], [
        0.8,
        0.65,
        0.5
      ]);
    }
    b.A = TILE.bark; b.B = TILE.moss;
    for (const br of [[0.2, 0.7, 0.4], [-0.3, -0.5, 0.32]]) {
      const x = br[0],
        s = Math.sign(br[1]),
        q = [[x, 0.2, 0], [x + 0.03, 0.2 + 0.1 * Math.abs(br[1]) + 0.06, s * 0.14], [x + 0.06, 0.34, s * 0.24]];
      tube(b, q, [0.055, 0.042, 0.034], 7, () => BARK, null, null);
      b.A = b.B = TILE.endgrain;
      tube(b, [q[2], [q[2][0] + 0.005, q[2][1] + 0.01, q[2][2] + s * 0.01]], [0.034, 0.03], 7, () => [0.95, 0.85, 0.7], null, [
        0.95,
        0.85,
        0.7
      ]);
      b.A = TILE.bark;
      b.B = TILE.moss;
    }
    b.A = TILE.moss; b.B = -1;                                                                   // moss cushions on top
    for (let k = 0; k < 5; k++) {
      const x = (h3(k, 1, 21) - 0.5) * 1.3, r = 0.06 + 0.06 * h3(k, 2, 21);
      blob(b, x, 0.17 + 0.17 * 0.88 + 0.01, (h3(k, 3, 21) - 0.5) * 0.07, r * 1.6, r * 0.7, r, 1, 0.3, k + 2, [0.75, 1.05, 0.55], {
        flat: -0.2
      });
    }
    // built along x (up = y); stored along +y so the triplanar bark runs along the log, the clutter instance turns it
    // back by +90 deg about z
    for (let i = 0; i < b.p.length; i += 3) {
      const x = b.p[i], y = b.p[i + 1];
      b.p[i] = y;
      b.p[i + 1] = -x;
    }
    return fin(b);
  }
  function stumpGeo() {
    const b = mk(), n = 14, BK = [1, 0.95, 0.9];
    b.A = TILE.bark; b.B = TILE.moss; b.wf = (x, y, z) => clamp((y - 0.2) * 1.2 * (fbm(x * 7, y * 7, z * 7) - 0.25), 0, 0.8);
    const jy = (i, j) => j === 4 ? 0.22 * h3(i, 5, 2) * (i % 3 === 0 ? 1.5 : 1) : 0;
    lathe(
      b,
      [[0.4, -0.05, BK], [0.27, 0.07, BK], [0.2, 0.2, BK], [0.19, 0.34, BK], [0.18, 0.48, BK]],
      n,
      0,
      0,
      0,
      (i, j) => (j < 2 ? 1 + 0.15 * Math.sin(i * 2.6 + 1) * (2 - j) / 2 : 1)
        * (0.9 + 0.22 * fbm(Math.cos(i / n * TAU) * 2 + 7, Math.sin(i / n * TAU) * 2, j * 0.5)),
      jy
    );
    b.wf = null; b.A = b.B = TILE.endgrain;
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU,
        a2 = (i + 1) / n * TAU,
        r = 0.18 * (0.9 + 0.22 * fbm(Math.cos(a) * 2 + 7, Math.sin(a) * 2, 2)),
        r2 = 0.18 * (0.9 + 0.22 * fbm(Math.cos(a2) * 2 + 7, Math.sin(a2) * 2, 2));
      tri(
        b,
        [0, 0.5, 0],
        [Math.cos(a) * r, 0.48 + jy(i, 4), Math.sin(a) * r],
        [Math.cos(a2) * r2, 0.48 + jy((i + 1) % n, 4), Math.sin(a2) * r2],
        [0.95, 0.85, 0.7]
      );
    }
    return fin(b);
  }
  function cactusGeo() {
    const b = mk(), G = [0.85, 0.95, 0.68], rib = (i, j, nr, k) => 1 + 0.15 * Math.cos(i / nr * TAU * k);
    b.A = TILE.cactus; b.B = -1;
    tube(
      b,
      [[0, -0.05, 0], [0, 0.2, 0], [0, 0.55, 0], [0, 0.95, 0], [0, 1.3, 0], [0, 1.46, 0], [0, 1.52, 0]],
      [0.12, 0.145, 0.14, 0.135, 0.12, 0.08, 0.025],
      24,
      () => G,
      null,
      G,
      (i, j) => rib(i, j, 24, 8)
    );
    for (const arm of [[0.6, 0.78, 0.42, 0.5], [3.7, 0.55, 0.3, 0.38]]) {
      const y0 = arm[1],
        o = arm[2],
        u = arm[3],
        q = [
          [0.05, y0, 0],
          [o, y0 + 0.03, 0],
          [o + 0.14, y0 + 0.13, 0],
          [o + 0.18, y0 + 0.14 + u * 0.6, 0],
          [o + 0.18, y0 + 0.2 + u, 0],
          [o + 0.18, y0 + 0.25 + u, 0]
        ].map(p => rotY(p, arm[0]));
      tube(b, q, [0.09, 0.085, 0.085, 0.08, 0.065, 0.02], 18, () => G, null, G, (i, j) => rib(i, j, 18, 6));
    }
    b.A = b.B = -1;
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * TAU, x = Math.cos(a) * 0.045, z = Math.sin(a) * 0.045;
      tri(b, [x, 1.5, z], [x * 2.4, 1.6, z * 2.4], [x * 0.2 + 0.015, 1.65, z * 0.2], [1.0, 0.6, 0.75], [1, 0.85, 0.9], [1, 0.92, 0.92]);
    }
    return fin(b);
  }
  function barrelGeo() {
    const b = mk(), G = [0.85, 0.95, 0.7], n = 20;
    b.A = TILE.cactus; b.B = -1;
    lathe(
      b,
      [
        [0.02, -0.02, G], [0.12, 0.0, G], [0.19, 0.08, G], [0.22, 0.2, G], [0.2, 0.3, G], [0.13, 0.36, G], [0.06, 0.385, G], [0.02, 0.37, G]
      ],
      n,
      0,
      0,
      0,
      (i, j) => 1 + 0.13 * Math.cos(i / n * TAU * 10) * (j > 0 && j < 6 ? 1 : 0.3)
    );
    b.A = -1;
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * TAU + 0.2;
      tri(
        b,
        [Math.cos(a) * 0.04, 0.37, Math.sin(a) * 0.04],
        [Math.cos(a) * 0.1, 0.43, Math.sin(a) * 0.1],
        [Math.cos(a + 0.5) * 0.065, 0.41, Math.sin(a + 0.5) * 0.065],
        [1, 0.6, 0.15],
        [1, 0.85, 0.3],
        [1, 0.75, 0.2]
      );
    }
    return fin(b);
  }
  function pearGeo() {
    const b = mk(),
      G = [0.85, 1.05, 0.95],
      pad = (px, py, pz, rx, ry, rz, s) => {
        const sub = mk();
        sub.A = TILE.cactus;
        blob(sub, 0, 0, 0, 0.19 * 0.9, 0.05, 0.22 * 1.1, 2, 0.06, px * 9 + py * 5, G, { flat: -2 });
        place(b, sub, px, py, pz, rx, ry, rz, s);
      };
    pad(0, 0.17, 0, 1.45, 0.3, 0, 1.0);
    pad(-0.08, 0.38, 0.02, 1.2, 1.1, 0.5, 0.85);
    pad(0.14, 0.34, -0.03, 1.7, 2.0, -0.4, 0.8);
    pad(0.02, 0.5, 0.1, 1.0, 0.2, 0.2, 0.62);
    b.A = -1;
    for (const f of [[0.02, 0.62, 0.08], [-0.13, 0.5, 0.03], [0.18, 0.42, -0.04]])
      lathe(
        b,
        [[0.001, f[1], [0.85, 0.15, 0.3]], [0.028, f[1] + 0.02, [0.85, 0.15, 0.3]], [0.001, f[1] + 0.055, [0.95, 0.35, 0.35]]],
        7,
        f[0],
        0,
        f[2]
      );
    return fin(b);
  }
  const BONE = [1.0, 0.97, 0.9];
  function skullGeo() {
    const b = mk();
    b.A = TILE.bone;
    b.B = -1;
    blob(b, -0.03, 0.075, 0, 0.1, 0.075, 0.085, 2, 0.08, 11, BONE, { flat: -0.6 });
    blob(b, 0.12, 0.05, 0, 0.12, 0.045, 0.05, 2, 0.1, 12, BONE, { flat: -0.5 });
    b.A = -1;
    for (const s of [-1, 1]) blob(b, 0.03, 0.085, s * 0.07, 0.025, 0.028, 0.02, 1, 0.05, 13, [0.15, 0.12, 0.1]);
    b.A = TILE.bone;
    for (const s of [-1, 1])
      tube(
        b,
        [[-0.06, 0.1, s * 0.07], [-0.09, 0.115, s * 0.14], [-0.08, 0.16, s * 0.22], [-0.04, 0.23, s * 0.25]],
        [0.03, 0.024, 0.016, 0.004],
        8,
        j => mixc(BONE, [0.55, 0.5, 0.42], j / 3),
        BONE,
        null
      );
    return fin(b);
  }
  function ribsGeo() {
    const b = mk();
    b.A = TILE.bone;
    b.B = -1;
    for (let k = 0; k < 6; k++) {
      const R = 0.2 - Math.abs(k - 2.2) * 0.012, pts = [];
      for (let q = 0; q <= 8; q++) {
        const ph = 0.1 + q / 8 * 0.8;
        pts.push([k * 0.065 - 0.17, Math.sin(ph * Math.PI) * R - 0.02, Math.cos(ph * Math.PI) * R]);
      }
      tube(b, pts, [0.02, 0.017, 0.015, 0.014, 0.013, 0.013, 0.012, 0.01, 0.007], 8, () => BONE, BONE, BONE);
    }
    tube(b, [[-0.21, 0.0, 0], [0.0, 0.012, 0.005], [0.23, 0.0, 0]], [0.024, 0.026, 0.024], 8, () => BONE, BONE, BONE);
    return fin(b);
  }
  function boneGeo() {
    const b = mk();
    b.A = TILE.bone;
    b.B = -1;
    tube(
      b,
      [
        [-0.23, 0.03, 0], [-0.19, 0.03, 0.005], [-0.15, 0.025, 0.008], [-0.09, 0.02, 0.01], [0.09, 0.02, 0.01], [0.15, 0.025, 0.008],
        [0.19, 0.03, 0.005], [0.23, 0.03, 0]
      ],
      [0.016, 0.034, 0.024, 0.016, 0.016, 0.024, 0.034, 0.016],
      10,
      () => BONE,
      BONE,
      BONE
    );
    tube(b, [[-0.05, 0.015, -0.1], [0.02, 0.015, -0.13], [0.09, 0.015, -0.17]], [0.015, 0.012, 0.012], 7, () => BONE, BONE, BONE);
    return fin(b);
  }
  function tumbleGeo() {
    const b = mk(), TW = [0.85, 0.72, 0.5], TW2 = [0.6, 0.48, 0.3], R0 = 0.3;
    b.A = TILE.bark;
    b.B = -1;
    const rings = [[0, 0, 0], [1.571, 0, 0], [0, 0, 1.571], [0.8, 0.8, 0], [-0.8, 0.6, 0.5], [0.4, 1.2, 1.0], [1.2, 0.3, 0.7]];
    rings.forEach((rt, k) => {
      const pts = [], N = 14, r = R0 * (0.82 + 0.2 * h3(k, 1, 9)), ph = h3(k, 2, 9) * 6;
      for (let q = 0; q <= N; q++) {
        const a = q / N * TAU + ph, w = 1 + 0.12 * Math.sin(q * 2.3 + k);
        pts.push([Math.cos(a) * r * w, Math.sin(a) * r * w, 0.05 * Math.sin(q * 1.7 + k)]);
      }
      const sub = mk();
      sub.A = TILE.bark;
      tube(sub, pts, new Array(pts.length).fill(0.013), 4, (j) => j % 3 ? TW : TW2, null, null);
      place(b, sub, 0, 0, 0, rt[0], rt[1], rt[2], 1);
    });
    for (let i = 0; i < b.p.length; i += 3) b.p[i + 1] += R0 * 0.85;
    return fin(b);
  }
  function rubbleGeo() {
    const b = mk();
    b.A = TILE.sandstone;
    b.B = TILE.pumice;
    b.wf = null;
    const S = [1, 0.97, 0.92];
    blob(b, 0, 0, 0, 0.26, 0.15, 0.19, 3, 0.16, 31, S, { sq: 0.35, flat: -0.35, ridge: 0.2 });
    blob(b, 0.34, 0, 0.14, 0.14, 0.09, 0.12, 1, 0.2, 32, [0.95, 0.9, 0.85], { sq: 0.3, flat: -0.3, ridge: 0.2 });
    blob(b, -0.26, 0, -0.2, 0.11, 0.075, 0.14, 1, 0.2, 33, [1, 0.95, 0.9], { sq: 0.3, flat: -0.3, ridge: 0.2 });
    return fin(b);
  }
  /* hero: a canyon hoodoo, 20 sides x 30 rings, layered neck + cap rock, terraced strata and noise erosion, tile
   * sandstone with warm bands in the tint */
  function pillarGeo() {
    const b = mk(), n = 24, rings = 36, Hh = 1.9, prof = [];
    b.A = TILE.sandstone; b.B = TILE.pumice;
    const base = y => {
      const t = y / Hh;
      return 0.4 - 0.2 * sstep(0, 0.5, t) + 0.05 * sstep(0.45, 0.7, t) + 0.2 * sstep(0.7, 0.88, t) - 0.18 * sstep(0.93, 1, t);
    };
    for (let j = 0; j <= rings; j++) {
      const y = j / rings * Hh,
        band = Math.floor(y * 5.5),
        tcol = band % 3 === 0 ? [1.02, 0.86, 0.72] : band % 3 === 1 ? [1.0, 0.94, 0.86] : [0.92, 0.78, 0.66];
      prof.push([j === rings ? 0.001 : base(y) * (1 + 0.05 * Math.sin(y * 19)), y + (j === rings ? 0.04 : 0), tcol]);
    }
    lathe(
      b,
      prof,
      n,
      0,
      0,
      0,
      (i, j) => 0.78
        + 0.5 * fbm(Math.cos(i / n * TAU) * 1.6 + 3, Math.sin(i / n * TAU) * 1.6, j * 0.19 + 2)
        + 0.09 * Math.cos(i / n * TAU * 5 + j * 0.3)
    );
    return fin(b);
  }
  function obsidianGeo() {
    const b = mk();
    b.A = TILE.obsidian;
    cluster(b, 6, 0.12, 0.2, 0.42, 0.05, [0.55, 0.55, 0.65], [0.9, 0.95, 1.1], 3, 0.55);
    return fin(b);
  }
  function iceGeo() {
    const b = mk();
    b.A = TILE.frost;
    cluster(b, 6, 0.1, 0.22, 0.5, 0.055, [0.65, 0.88, 1.0], [0.95, 1.0, 1.05], 5, 0.45);
    return fin(b);
  }
  function crysGeo() {
    const b = mk();
    b.A = -1;
    cluster(b, 7, 0.12, 0.2, 0.5, 0.05, [0.55, 0.6, 0.9], [0.95, 0.95, 1], 8, 0.6);
    return fin(b);
  }
  /* rounded irregular boulder: 1280-face icosphere displaced by 3-octave noise, flat bottom, frosted top (blend weight
   * by the surface direction) */
  function boulderGeo() {
    const b = mk();
    b.A = TILE.pumice;
    b.B = TILE.frost;
    blob(b, 0, 0, 0, 1.1, 0.78, 1.0, 5, 0.22, 41, [1, 1, 1], {
      flat: -0.45,
      ridge: 0.12,
      wfn: (v, s) => clamp((v[3] - 0.05) * 2.4 + (vn(v[0] * 4, v[1] * 4 + s, v[2] * 4) - 0.5) * 1.1, 0, 1)
    });
    return fin(b);
  }
  function stalagGeo() {
    const b = mk();
    b.A = TILE.limestone;
    b.B = -1;
    for (let k = 0; k < 4; k++) {
      const a = k / 4 * TAU + 0.5,
        rr = k ? 0.15 + 0.1 * h3(k, 1, 12) : 0,
        hh = k ? 0.3 + 0.35 * h3(k, 2, 12) : 0.95,
        w = k ? 0.07 + 0.03 * h3(k, 3, 12) : 0.17;
      lathe(
        b,
        [
          [w * 1.6, -0.05, [1, 0.95, 0.85]],
          [w * 1.15, hh * 0.12, [1, 0.95, 0.85]],
          [w * 0.8, hh * 0.35, [1, 0.97, 0.9]],
          [w * 0.5, hh * 0.6, [1, 0.97, 0.9]],
          [w * 0.25, hh * 0.85, [1.05, 1, 0.95]],
          [0.001, hh, [1.1, 1.05, 1]]
        ],
        12,
        Math.cos(a) * rr,
        0,
        Math.sin(a) * rr,
        (i, j) => 0.88 + 0.24 * fbm(Math.cos(i / 12 * TAU) * 2 + k * 3, Math.sin(i / 12 * TAU) * 2, j * 0.5)
      );
    }
    return fin(b);
  }
  function fungiGeo() {
    const b = mk();
    b.A = -1;
    b.B = -1;
    for (let k = 0; k < 6; k++) {
      const a = k * 2.3,
        rr = k ? 0.05 + 0.08 * h3(k, 1, 14) : 0,
        hh = 0.08 + 0.11 * h3(k, 2, 14),
        r = 0.045 + 0.04 * h3(k, 3, 14),
        x = Math.cos(a) * rr,
        z = Math.sin(a) * rr,
        cap = [0.35, 0.9, 0.85],
        rim = [0.9, 1.0, 0.95];
      lathe(b, [[r * 0.22, 0, [0.15, 0.3, 0.3]], [r * 0.18, hh * 0.9, [0.4, 0.7, 0.7]]], 6, x, 0, z);
      lathe(
        b,
        [
          [r * 0.2, hh * 0.9, [0.2, 0.5, 0.5]],
          [r, hh * 0.96, rim],
          [r * 0.9, hh * 1.1, cap],
          [r * 0.6, hh * 1.3, cap],
          [0.001, hh * 1.42, [0.2, 0.7, 0.7]]
        ],
        12,
        x,
        0,
        z
      );
    }
    return fin(b);
  }
  function plateGeo() {
    const b = mk(), A = [1, 1, 1], S = 6, W = 0.34, D = 0.24;
    b.A = TILE.rust;
    b.B = -1;
    const P = (i, k, t) => [
      (i / S - 0.5) * 2 * W,
      0.03 + 0.07 * Math.sin(i / S * 2.6) + t + (k === 2 && i > 3 ? 0.04 * (i - 3) : 0),
      (k / 3 - 0.5) * 2 * D * (1 - 0.15 * (i % 2))
    ];
    for (let i = 0; i < S; i++)
      for (let k = 0; k < 3; k++) {
        quad(b, P(i, k, 0.014), P(i + 1, k, 0.014), P(i + 1, k + 1, 0.014), P(i, k + 1, 0.014), A, A, A, A);
        quad(b, P(i, k, 0), P(i + 1, k, 0), P(i + 1, k + 1, 0), P(i, k + 1, 0), [0.5, 0.45, 0.45], [0.5, 0.45, 0.45], [0.5, 0.45, 0.45], [
          0.5,
          0.45,
          0.45
        ]);
      }
    for (const x of [-0.7, 0.7])
      lathe(b, [[0.025, 0.105, [0.5, 0.5, 0.5]], [0.025, 0.125, [1, 1, 1]], [0.001, 0.13, [1, 1, 1]]], 8, x * W, 0, 0.0);
    return fin(b);
  }
  function cableGeo() {
    const b = mk(), pts = [], N = 26;
    b.A = -1;
    for (let q = 0; q <= N; q++) {
      const t = q / N, a = t * 3.1 * TAU * 0.5 + 0.3;
      if (t < 0.8) {
        const r = 0.16 - 0.06 * t;
        pts.push([Math.cos(a) * r, 0.02 + 0.03 * Math.sin(t * 12), Math.sin(a) * r]);
      } else {
        const e = (t - 0.8) / 0.2;
        pts.push([pts[Math.floor(N * 0.8)][0] + e * 0.5, 0.02 + 0.015 * Math.sin(e * 6), pts[Math.floor(N * 0.8)][2] + e * 0.15]);
      }
    }
    tube(b, pts, new Array(pts.length).fill(0.015), 8, (j) => j % 7 < 2 ? [0.9, 0.7, 0.1] : [0.12, 0.12, 0.14], [0.8, 0.5, 0.2], [
      0.8,
      0.5,
      0.2
    ]);
    return fin(b);
  }
  /* hero: a torn section of ship hull, a curved double-skin panel with three ribs and a ragged edge (End of the World
   * wrecks) */
  function wreckGeo() {
    const b = mk(), A = [1, 1, 1], R = 1.3, NA = 12, NL = 6, LEN = 1.5;
    b.A = TILE.rust;
    b.B = TILE.pumice;
    b.wf = (x, y, z) => clamp((fbm(x * 3 + 4, y * 3, z * 3) - 0.55) * 4, 0, 0.8);
    const P = (a, k, t) => {
      const ang = -0.9 + a / NA * 1.8, jag = (a === 0 || a === NA) ? 0.12 * h3(k, a, 7) * (k > 0 ? 1 : 0.2) : 0, r = R + t;
      return [Math.sin(ang) * r, Math.cos(ang) * r - R + (k / NL) * 0 + jag * 0, (k / NL - 0.5) * LEN + jag * 0.4 * (a === 0 ? -1 : 1)];
    };
    const dent = (a, k) => 0.035 * (fbm(a * 0.8 + 2, k * 0.8, 5) - 0.5) * 2;
    for (let a = 0; a < NA; a++)
      for (let k = 0; k < NL; k++) {
        const q = (aa, kk, t) => {
          const v = P(aa, kk, t + dent(aa, kk));
          return v;
        };
        quad(b, q(a, k, 0.03), q(a + 1, k, 0.03), q(a + 1, k + 1, 0.03), q(a, k + 1, 0.03), A, A, A, A);
        quad(b, q(a, k, 0), q(a, k + 1, 0), q(a + 1, k + 1, 0), q(a + 1, k, 0), [0.45, 0.4, 0.4], [0.45, 0.4, 0.4], [0.45, 0.4, 0.4], [
          0.45,
          0.4,
          0.4
        ]);
      }
    for (const kk of [1, 3, 5]) {
      const pts = [];
      for (let a = 0; a <= NA; a++) {
        const v = P(a, kk, -0.07);
        pts.push([v[0], v[1], v[2]]);
      }
      tube(b, pts, new Array(pts.length).fill(0.035), 6, () => [0.85, 0.8, 0.78], null, null);
    }
    return fin(b);
  }
  K.B = { mk, tri, quad, blob, fin, lathe, vn, fbm, mixc, TILE };      // (P116: the builders, for render/beachdecor.js)
  K.GF = {
    wreck: wreckGeo,
    mushA: () => mushGeo(0),
    mushB: () => mushGeo(1),
    fern: fernGeo,
    log: logGeo,
    stump: stumpGeo,
    cactus: cactusGeo,
    barrel: barrelGeo,
    pear: pearGeo,
    skull: skullGeo,
    ribs: ribsGeo,
    bone: boneGeo,
    tumble: tumbleGeo,
    rubble: rubbleGeo,
    pillar: pillarGeo,
    obsidian: obsidianGeo,
    ice: iceGeo,
    crystal: crysGeo,
    boulder: boulderGeo,
    stalag: stalagGeo,
    fungi: fungiGeo,
    plate: plateGeo,
    cable: cableGeo
  };
})(window.SS = window.SS || {});
