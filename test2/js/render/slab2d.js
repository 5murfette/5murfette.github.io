/* render/slab2d.js — P113: the top of the 2D slab as ground, not as an extruded profile (render only, the sim stays a prism).
 * User 2026-10-12: "when in 2d mode, make the extended surface of the 2d terrain nice and unique in 3d ... slightly varied, with tiny
 * ups and downs, grass, some textures".
 * Geometry of the problem: a 2D match draws only the slab BEHIND the gameplay plane (z = S.O.z, uBack = 1.5 m deep); the cut face at the plane is
 * the exact collision profile. The top surface behind it used to be that profile copied 1.5 m back. Now:
 *   - the chunk meshes are subdivided to ~0.125 m inside the visible band (subdivide), so there is geometry to move;
 *   - one shared height function s2H (GLSL, below) displaces the terrain vertices, the grass blades and the clutter instances, so everything
 *     that stands on the ground follows the same bumps: lumps of 0.3 - 1 m, dips, a soft rolled-over back rim with an irregular edge.
 *     It is ZERO within 0.3 m of the plane (the visible surface at the gameplay plane is the sim profile EXACTLY) and grows with the depth;
 *   - it is a function of (x, depth) and the CURRENT vertex height / normal, so it follows the edited sim surface (craters, collapse): nothing
 *     is baked. Water, lava and non-ground (girders, foam, concrete) are not displaced.
 * Nothing is drawn in front of the plane, so nothing here can occlude a worm, a projectile or the crosshair.
 * API: init(noiseTexture), update(S), on(), GLSL, U (shared uniforms), subdivide(meshdata, z0, z1, levels). */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const S2 = SS.slab2d = {};
  S2.U = { uS2D: { value: 0 }, uSlab: { value: new T.Vector4(0, 0.16, 1.5, 3) }, tS2N: { value: null } };
  S2.AMP = { temperate: 0.3, alpine: 0.28, canyon: 0.34, desert: 0.3, volcanic: 0.34 };   // m of relief at full depth, per biome
  S2.on = () => { const W = SS.world; return !!(W && W.flat && !W.eow && !(window.P113_SLAB === 0)); };
  S2.init = function (noise) { S2.U.tS2N.value = noise; };
  /* once per frame: on in a 2D match on ground (not End of the World: a steel hull), amplitude of the biome, depth = the terrain's uBack, sea level */
  S2.update = function (S, back) {
    const W = SS.world, on = S2.on() && SS.dim2d.on(S);
    const v = S2.U.uSlab.value, bio = (W && W.features && W.features.biome) || S.biome || 'temperate';
    S2.U.uS2D.value = window.P113_DBG || 0;
    v.set(on && !window.P113_NOSHADE ? 1 : 0, (S2.AMP[bio] || 0.16) * (window.P113_AMP != null ? window.P113_AMP : 1), back, W ? W.SEA : 3);
  };

  /* ---- shared GLSL (vertex + fragment). d = metres behind the gameplay plane. Uses its own noise sampler so it never clashes with a material's tNoise. ---- */
  S2.GLSL = /* glsl */`
    uniform vec4 uSlab; uniform sampler2D tS2N; uniform float uS2D;
    float s2Edge(float x){ return uSlab.z - 0.24 * texture2D(tS2N, vec2(x * 0.29, 0.37)).g - 0.08 * texture2D(tS2N, vec2(x * 1.7, 0.11)).b; }
    float s2Field(vec2 xz, float d){
      float a = texture2D(tS2N, vec2(xz.x * 0.083, d * 0.083 + 0.21)).g - 0.5;
      float b = texture2D(tS2N, vec2(xz.x * 0.11 + 0.5, d * 0.11)).b - 0.5;
      float c = texture2D(tS2N, vec2(xz.x * 0.021, d * 0.05 + 0.7)).r - 0.5;
      float e = texture2D(tS2N, vec2(xz.x * 0.37 + 0.2, d * 0.37 + 0.55)).b - 0.5;
      return a * 1.3 + b * 0.9 + c * 1.4 + e * 0.3;
    }
    float s2Clear(float d){ return uSlab.x > 0.5 ? smoothstep(0.12, 0.62, d) : 1.0; }   // plants / stones stay low at the gameplay plane (worms are 0.3 m deep): nothing grows in front of a worm, the crosshair or a shot
    float s2K(float y, float ny){ return smoothstep(uSlab.w + 0.12, uSlab.w + 0.65, y) * smoothstep(0.4, 0.78, ny); }
    float s2H(vec2 xz, float d, float k){
      float e = s2Edge(xz.x), lump = smoothstep(0.3, 1.0, d) * s2Field(xz, d), dr = smoothstep(e - 0.7, e, d);
      return uSlab.y * k * (lump - 0.8 * dr);
    }`;

  /* ---- vertex: displacement + tilted normal for the terrain (needs uO, uN, tLavaS, uLavaOn declared by the caller) ---- */
  S2.VERT = /* glsl */`
    float s2Lava(vec2 xz){
      if (uLavaOn < 0.5) return 1.0;
      ivec2 lb = ivec2(floor(xz / 0.5)), lmx = textureSize(tLavaS, 0) - 1; float lh = 0.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        ivec2 lc = lb + ivec2(i, j); vec4 q = texelFetch(tLavaS, clamp(lc, ivec2(0), lmx), 0);
        if (q.y > 0.012) lh = max(lh, 1.0 - smoothstep(0.3, 1.1, length(vec2(lc) * 0.5 + 0.25 - xz)));
      }
      return 1.0 - lh;
    }
    void s2Vert(vec3 p, vec4 md, inout vec3 n, out float h){
      float d = dot(uO - p, uN);
      float k = s2K(p.y, n.y) * (1.0 - clamp(md.x + md.y + 0.7 * md.z, 0.0, 1.0));      // girders and foam stay flat, concrete settles a little
      h = 0.0;
      if (k < 0.002 || d < 0.0) return;
      k *= s2Lava(p.xz);
      h = s2H(p.xz, d, k);
      float hx = (s2H(p.xz + vec2(0.06, 0.0), d, k) - h) / 0.06, hd = (s2H(p.xz, d + 0.06, k) - h) / 0.06;
      n = normalize(n / max(n.y, 0.3) + vec3(-hx, 0.0, hd) * step(0.0, n.y));
    }`;

  S2.GRASS_K = 2.2;                                           // blade density factor in the 2D band (the band is thin and seen close: a 3D meadow density reads as bald)
  S2.CLUTTER_K = 1.8;
  /* the visible band of a 2D slab: z in [MZ - depth, MZ + 0.05]. band(meshdata) = the same arrays with the triangle list cut down to it (grass / clutter place on it) */
  S2.zlo = () => SS.world.MZ - S2.U.uSlab.value.z - 0.1;
  S2.zhi = () => SS.world.MZ + 0.05;
  S2.band = function (m) {
    const P = m.pos, I = m.idx, lo = S2.zlo(), hi = S2.zhi(), out = [];
    for (let i = 0; i < I.length; i += 3) {
      const za = P[I[i] * 3 + 2], zb = P[I[i + 1] * 3 + 2], zc = P[I[i + 2] * 3 + 2];
      if (Math.max(za, zb, zc) >= lo && Math.min(za, zb, zc) <= hi) out.push(I[i], I[i + 1], I[i + 2]);
    }
    return Object.assign({}, m, { idx: out.length > 65535 ? new Uint32Array(out) : new Uint16Array(out) });
  };

  /* the surface map (r = grass cover, g = dryness) of the sim has one texel per lattice column and row; the slab is a prism, so every row repeats the plane's cover. Render-only
   * copy with the rows behind the plane varied: grass patches that open and close with the depth (on soil), bare gaps, a few thin tufts on the rest of the ground. The row at the plane
   * and its neighbour are untouched (window 0), so the cut face agrees with what the sim says. Returns buf itself when there is nothing to change. */
  const CM = SS.CFG.MAT;
  let snap = null;
  S2.reset = function () { snap = null; };                       // a new world: the next shapeSurf takes a fresh snapshot of the column tops
  S2.shapeSurf = function (buf, n) {
    const W = SS.world; if (!S2.on() || !buf || n !== W.NX) return buf;
    if (!snap || snap.top.length !== W.top.length) snap = { top: new Float32Array(W.top) };      // the first upload of a world comes before any edit: columns whose top moved since (a crater, a dig) or that carry char never grow render-only grass
    const out = new Uint8Array(buf), NX = W.NX, NY = W.NY, H = W.H, kz = W.kz, bio = (W.features && W.features.biome) || '';
    const seed = 91 + ((SS.state && SS.state.settings && SS.state.settings.seed) | 0);
    const k0 = Math.max(0, kz - Math.round(S2.U.uSlab.value.z / H) - 1);
    for (let k = k0; k < kz; k++) {
      const d = (kz - k) * H, w = M.smoothstep(0.25, 1.0, d);
      if (w <= 0) continue;
      for (let i = 0; i < NX; i++) {
        const c = k * NX + i, j = W.topJ[c];
        if (j <= 0 || W.top[c] < W.SEA + 0.5) continue;
        const m = W.mat[(k * NY + j) * NX + i];
        if (m !== CM.SOIL && m !== CM.SAND) continue;
        if (Math.abs(W.top[c] - snap.top[c]) > 0.12 || out[c * 4 + 2] > 6) continue;
        const x = i * H, z = k * H, cov = out[c * 4] / 255;
        const f1 = M.fbm2(x / 3.2, z / 0.9, seed, 3), f2 = M.fbm2(x / 11, z / 4, seed + 5, 2);
        if (m === CM.SOIL) {
          const gr = M.smoothstep(0.42, 0.62, f1 + 0.3 * (f2 - 0.5)) * (bio === 'desert' || bio === 'volcanic' ? 0.0 : 1.0);
          const v = cov > 0.04 ? cov * (1 - w * 0.55 * (1 - M.smoothstep(0.3, 0.55, f1))) : gr * 0.85 * w;       // covered: thinner in places; bare: patches that start behind the plane
          out[c * 4] = Math.round(M.clamp(v, 0, 1) * 255);
        }
      }
    }
    return out;
  };

  /* ---- CPU: split every triangle that touches the visible band z in [z0, z1] into 4^levels (vertices not shared: the displacement is a pure function of the
   * position, so a shared edge moves identically on both sides). meshdata = SS.meshgen.chunk output { pos, nrm, mA, mB, mC, mD, depth, idx }. Returns a new set of arrays. ---- */
  S2.subdivide = function (m, z0, z1, levels) {
    const P = m.pos, N = m.nrm, A = m.mA, B = m.mB, Cc = m.mC, D = m.mD, DP = m.depth, I = m.idx, nT = I.length / 3, n = 1 << levels;
    let sel = 0; const pick = new Uint8Array(nT);
    for (let t = 0; t < nT; t++) {
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2], za = P[a * 3 + 2], zb = P[b * 3 + 2], zc = P[c * 3 + 2];
      if (Math.max(za, zb, zc) >= z0 && Math.min(za, zb, zc) <= z1) { pick[t] = 1; sel++; }
    }
    const vPer = (n + 1) * (n + 2) / 2, tPer = n * n, nv = (P.length / 3) + sel * vPer, ni = (nT - sel) * 3 + sel * tPer * 3;
    const oP = new Float32Array(nv * 3), oN = new Float32Array(nv * 3), oDP = new Float32Array(nv);
    const oA = new Uint8Array(nv * 4), oB = new Uint8Array(nv * 4), oC = new Uint8Array(nv * 4), oD = new Uint8Array(nv * 4);
    oP.set(P); oN.set(N); oDP.set(DP); oA.set(A); oB.set(B); oC.set(Cc); if (D) oD.set(D);
    const oI = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
    let nvv = P.length / 3, nii = 0;
    for (let t = 0; t < nT; t++) {
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      if (!pick[t]) { oI[nii++] = a; oI[nii++] = b; oI[nii++] = c; continue; }
      const base = nvv, row = [];
      for (let r = 0, q = 0; r <= n; r++) {
        row.push(q);
        for (let s = 0; s <= n - r; s++, q++) {
          const wb = s / n, wc = r / n, wa = 1 - wb - wc, v = base + q;
          for (let e = 0; e < 3; e++) { oP[v * 3 + e] = P[a * 3 + e] * wa + P[b * 3 + e] * wb + P[c * 3 + e] * wc; oN[v * 3 + e] = N[a * 3 + e] * wa + N[b * 3 + e] * wb + N[c * 3 + e] * wc; }
          const nl = Math.hypot(oN[v * 3], oN[v * 3 + 1], oN[v * 3 + 2]) || 1; oN[v * 3] /= nl; oN[v * 3 + 1] /= nl; oN[v * 3 + 2] /= nl;
          oDP[v] = DP[a] * wa + DP[b] * wb + DP[c] * wc;
          for (let e = 0; e < 4; e++) {
            oA[v * 4 + e] = Math.round(A[a * 4 + e] * wa + A[b * 4 + e] * wb + A[c * 4 + e] * wc);
            oB[v * 4 + e] = Math.round(B[a * 4 + e] * wa + B[b * 4 + e] * wb + B[c * 4 + e] * wc);
            oC[v * 4 + e] = Math.round(Cc[a * 4 + e] * wa + Cc[b * 4 + e] * wb + Cc[c * 4 + e] * wc);
            if (D) oD[v * 4 + e] = Math.round(D[a * 4 + e] * wa + D[b * 4 + e] * wb + D[c * 4 + e] * wc);
          }
        }
      }
      nvv += vPer;
      for (let r = 0; r < n; r++) for (let s = 0; s < n - r; s++) {
        const i0 = base + row[r] + s, i1 = i0 + 1, i2 = base + row[r + 1] + s;
        oI[nii++] = i0; oI[nii++] = i1; oI[nii++] = i2;
        if (s < n - r - 1) { oI[nii++] = i1; oI[nii++] = base + row[r + 1] + s + 1; oI[nii++] = i2; }
      }
    }
    return { pos: oP, nrm: oN, mA: oA, mB: oB, mC: oC, mD: oD, depth: oDP, idx: oI.subarray(0, nii) };
  };
})(window.SS = window.SS || {});
