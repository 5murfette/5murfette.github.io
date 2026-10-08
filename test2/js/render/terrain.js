/* render/terrain.js — voxel terrain presentation (Three.js specific).
 *   - one full-resolution surface-nets mesh per 16 m world chunk (SS.meshgen.chunk), remeshed on edit
 *     under a per-frame time budget (slab chunks first);
 *   - each chunk geometry is drawn by up to 4 meshes: the section SLAB behind "slice zero" (clipped to
 *     -uBack <= t <= 0 in the fragment shader, opaque, casts shadows; nothing in front of slice zero is drawn,
 *     so the collision section is never hidden), and the surrounding CONTEXT (far side t < -uBack: depth
 *     pre-pass + single-layer blend, so it can be fairly opaque without self-overlap mess; near side t > 0:
 *     faint, inspection only);
 *   - the slab's cut face is a CAP plane at t = 0 (slice zero, exactly the collision section and its
 *     outline) that samples a 3D density+material texture of the world (strata, topsoil, glowing lava where
 *     the cut crosses a pocket);
 *   - lava inside the rock is drawn as an x-ray glow when the 3D context or inspection is visible; open lava (the
 *     fluid layer S.lava) is drawn by render/lava.js, its cross-section on the cap from tLavaS.
 * Porting: chunk meshes = engine meshes; the clip/cap trick = a material keyword + a 3D texture. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, M = SS.math;
  const TR = SS.terrain = {};
  const capN = { value: null };   // world-space lighting normal of the cut face (see capMaterial)
  /* D5: dry worlds — the cap also draws the cut face BEYOND the lattice (the far dunes' section; the D2 curtain is
   * gone: it z-fought the cap in the 1 m the cap reached past the border, where the cap smeared the clamped volume, and
   * used its own layering / scale / lighting). Beyond the border the cap reads a 1D strip along the section (tFar,
   * FAR_N texels over the lattice exits ± FAR_S m): r = top (worldgen far_height), g = sand base (top − sand −
   * SAND_EXTRA), b = rock top (top − ROCK_DV): RULES.desert's layering, the same rule the lattice voxels got, so the
   * strata continue; within 1 m inside the border the volume's material weights blend into the strip's. */
  const FAR_N = 2048, FAR_S = 420;
  const FAR = { tFar: { value: null }, uFar: { value: null }, uLat: { value: null } };
  const CAP_DEEP = 400, CAP_EXT = 1500;   // m: the section's rock body below the lattice / beyond it on wet worlds (P29a)
  // C1: the cut face's 3D noise and pinned-coordinate offset (τ = s + uS0, see the cap shader); MORPH_CELL = the world
  // cell size (m) of the texture-offset grid: a face point that moves ~one cell while the section turns has fully
  // changed its texture (at s = 20 m a 7° turn; under the worm never)
  const CAPU = { tN3: { value: null }, uS0: { value: 0 } };
  const MORPH_CELL = 2.5;
  let capPivot = null;
  let farData = null, farKey = '', farRange = null;
  let scene, tx, Q, chunks = [], volTex, volData, slabMat, slabDepth, ctxPre, ctxFar, ctxNear, bodyMats = null, cap, capMat;
  const U = {};               // shared uniforms
  TR.uniforms = U;

  /* per-material shading table (slot = mat id - 1): x = triplanar scale (1/m), y = roughness, z = emissive, w = porosity (rain darkening) */
  const MATP = [
    [0.14, 0.95, 0, 0.3], [0.16, 0.9, 0, 0.35], [0.28, 0.97, 0, 0.8], [0.22, 0.95, 0, 0.6], [0.15, 0.9, 0, 0.5], [0.2, 0.55, 0, 0.1],
    [0.12, 0.12, 0, 0.0], [0.17, 0.85, 0, 0.3], [0.13, 0.6, 1, 0.0], [0.17, 0.9, 0.12, 0.3], [0.25, 0.98, 0, 0.7], [0.24, 0.92, 0, 0.5]];
  /* LV2 relief amplitudes (m) per material slot of the 2 m / 0.5 m (+0.25 m) / 9 cm / 5 cm octaves (render-only
   * normals; the mesh is 0.5 m): rock lumps and fractures, soil clods and grains, fine sand, soft snow, smooth ice,
   * vesicular basalt, fluid lava 0 (it glows), ropy / clinker crust, fine ash, blocky scree */
  const RELIEF = [
    [0.12, 0.05, 0.012, 0.006], [0.15, 0.06, 0.015, 0.007], [0.05, 0.02, 0.008, 0.006], [0.03, 0.006, 0.002, 0.001],
    [0.1, 0.035, 0.01, 0.004], [0.06, 0.012, 0.003, 0.001], [0.02, 0.004, 0.0008, 0], [0.12, 0.05, 0.02, 0.01],
    [0, 0, 0, 0], [0.08, 0.05, 0.02, 0.008], [0.03, 0.008, 0.003, 0.002], [0.1, 0.08, 0.012, 0.005]];
  /* LV2 sun glints: share of 2.5 cm facets per slot that are mirror-like (snow / ice crystals, quartz grains, glassy
   * basalt rinds and fragments, glassy crust, volcanic glass in ash); wet ground adds film beads (shader) */
  const GLINT = [0.004, 0.006, 0, 0.015, 0.008, 0.06, 0, 0.03, 0, 0.06, 0.01, 0.006];
  // three's lights_fragment_begin with a glint lobe after the directional lights' RE_Direct (directLight.color
  // already carries intensity and shadow: no glints in shadow)
  const LFB_GLINT = (() => {
    const L = T.ShaderChunk.lights_fragment_begin, DK = 'directionalLight = directionalLights[ i ];',
      RE = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
    const di = L.indexOf(DK), ri = di < 0 ? -1 : L.indexOf(RE, di);
    if (ri < 0) { console.warn('terrain: glints off (lights chunk changed)'); return null; }
    return L.slice(0, ri + RE.length) + '\n\t\treflectedLight.directSpecular += directLight.color * glintLobe(directLight.direction, geometryViewDir);' + L.slice(ri + RE.length);
  })();
  // linear multipliers per material slot. Basalt/ash textures average ~0.21 sRGB (~0.035 linear), darker than real
  // basalt (~0.08-0.1 linear albedo), so they are lifted; crust stays darker than basalt.
  const TINT = [
    [0.52, 0.5, 0.5], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1.02, 1.04, 1.08],
    [1, 1, 1], [2.0, 1.95, 1.9], [1, 1, 1], [1.2, 1.12, 1.1], [1.9, 1.85, 1.8], [1, 1, 1]];

  /* Dry worlds (Step D): the sand beyond the play area (radius uPlayR about the map centre; 0 = off) is hot: sun-
   * bleached (a little paler, the same yellow hue: D4, the dunes stay yellow), and a steady dashed glowing heat line
   * marks the edge. Nothing animates (D4: the old brightness shimmer and the pulsing line read as flicker).
   * Shared with render/dunes.js (needs uniform uPlayR). */
  const HOT = /* glsl */`
    vec3 hotSand(vec3 col, vec3 p, float up, inout vec3 emis){
      if (uPlayR <= 0.0) return col;
      vec2 d = p.xz - vec2(48.0);
      float r = length(d), hot = smoothstep(uPlayR - 0.3, uPlayR + 5.0, r);
      col = mix(col, col * vec3(1.1, 1.06, 0.9) + vec3(0.02, 0.015, 0.0), hot * 0.85);
      float ring = (1.0 - smoothstep(0.1, 0.38, abs(r - uPlayR))) * step(0.42, fract(atan(d.y, d.x) * uPlayR / 1.6)) * smoothstep(0.4, 0.75, up);
      col = mix(col, vec3(0.62, 0.16, 0.03), ring * 0.8);
      emis += ring * vec3(0.5, 0.12, 0.02) * 0.85;
      return col;
    }`;
  TR.HOT_GLSL = HOT;

  const COMMON = /* glsl */`
    uniform highp sampler2DArray tMats; uniform sampler2D tNoise; uniform sampler2D tSurf; uniform sampler2D tWater; uniform sampler2D tCover; uniform float uPlayR;
    uniform vec3 uO, uN, uHaze, uGrassTint, uDryTint, uSunDir;
    uniform float uHalf, uBack, uAlpha, uTime, uSea, uWet, uSnow, uCaustic, uDetail, uWaterTex, uDbgBack, uCtxSolid, uCtxHaze;
    // the landscape behind the slab (mode 1, ad = m beyond its back face): the old ghost haze while it fades
    // (uCtxSolid 0); drawn solid (CX1) it still recedes into the haze with the slice-view setting (P29j, uCtxHaze)
    #define CTX_HAZE(ad) ((0.12 + 0.4 * smoothstep(0.0, 50.0, ad)) * (1.0 - uCtxSolid) + (0.3 + 0.38 * smoothstep(0.0, 40.0, ad)) * uCtxSolid * uCtxHaze)
    uniform vec4 uMatP[12]; uniform vec3 uMatTint[12]; uniform vec3 uLatR; uniform vec4 uRelief[12]; uniform highp sampler3D tRel; uniform float uGlint[12];
    varying vec3 vW; varying vec3 vWN; varying float vDepth; varying vec4 vMA; varying vec4 vMB; varying vec4 vMC; varying vec4 vMD;
    varying vec3 vT; varying vec3 vTN;      // texture space: = world for terrain; where the rock came from for bodies
    vec3 triA(float L, vec3 p, vec3 w, float sc){
      return texture(tMats, vec3(p.zy*sc, L)).rgb*w.x + texture(tMats, vec3(p.xz*sc, L)).rgb*w.y + texture(tMats, vec3(p.xy*sc, L)).rgb*w.z;
    }
    vec3 triAT(float L, vec3 p, vec3 w, float sc){
      vec3 a = triA(L, p, w, sc);
      if (uDetail < 0.5) return a;
      float n = texture(tNoise, p.xz*0.011 + p.y*0.004).a;
      vec3 b = triA(L, p*0.61 + vec3(13.1, 7.7, 3.3), w, sc*0.83);
      return mix(a, b, smoothstep(0.38, 0.62, n));
    }
    float caustic(vec3 p){
      vec2 q = p.xz*0.55;
      float a = texture(tNoise, q*0.31 + vec2(uTime*0.031, uTime*0.017)).g;
      float b = texture(tNoise, q*0.27 - vec2(uTime*0.024, -uTime*0.029) + 0.37).g;
      return pow(1.0 - abs(a - b), 9.0);
    }
    // Exposed voxel lava (a breached pocket before it drains; open lava is the fluid layer, render/lava.js): the
    // crust-cell texture with a slow churn. Explicit gradients (uniform control flow around the fetches).
    float lavaTex(vec2 uv, vec2 gx, vec2 gy){ return textureGrad(tMats, vec3(uv, 8.0), gx, gy).r; }
    float lavaFlow(vec3 p, vec2 dpx, vec2 dpy){
      vec2 uv = p.xz * 0.13;
      return mix(lavaTex(uv + vec2(0.0019, 0.0011) * uTime, dpx * 0.13, dpy * 0.13),
                 lavaTex(uv * 1.09 + vec2(-0.0012, 0.0016) * uTime + 0.37, dpx * 0.142, dpy * 0.142), 0.3);
    }
    // low-frequency triplanar noise in [-0.5, 0.5] with a per-material offset (material boundary wobble, ~2 m)
    float matNoise(vec3 p, vec3 bw, float m){
      vec2 o = vec2(m * 0.373, m * 0.719);
      if (uDetail < 0.5) {                                  // Low: one planar fetch (wall-ish projection)
        vec2 q = vec2(p.x + p.z, p.y + 0.4 * (p.x - p.z));
        vec4 n = texture(tNoise, q * 0.11 + o);
        return n.r - 0.5 + (texture(tNoise, q * 0.035 - o).g - 0.5) * 0.5;
      }
      vec3 q = p * 0.11;
      float a = texture(tNoise, q.yz + o).r * bw.x + texture(tNoise, q.xz + o).r * bw.y + texture(tNoise, q.xy + o).r * bw.z;
      vec3 q2 = p * 0.035;
      float b = texture(tNoise, q2.yz - o).g * bw.x + texture(tNoise, q2.xz - o).g * bw.y + texture(tNoise, q2.xy - o).g * bw.z;
      return a - 0.5 + (b - 0.5) * 0.5;
    }
    // LV2 relief height (m) from the 3D noise at the texture position p (moves with a rock piece). A = amplitudes of
    // the octaves with cells 2 m (R of an 8 m tile), 0.5 + 0.25 m (G + B), 9.4 cm and 4.7 cm (G, B of a 1.5 m tile).
    // Each octave fades out once the pixel footprint fw (m) passes 0.15-0.45 of its cell (the noise has no mipmaps:
    // fade before it aliases into sparkle); its slope variance goes to sv instead (added to roughness²: relief too fine
    // to resolve still spreads the highlight; Toksvig 2005).
    float reliefH(vec3 p, vec4 A, float fw, out float sv){
      vec4 c = texture(tRel, p * 0.125), f = texture(tRel, p * 0.6667 + 0.31);
      vec4 k = vec4(1.0) - vec4(smoothstep(0.3, 0.9, fw), smoothstep(0.075, 0.225, fw), smoothstep(0.014, 0.042, fw), smoothstep(0.007, 0.021, fw));
      vec4 sl = A / vec4(2.0, 0.5, 0.094, 0.047);                       // octave slopes (m/m)
      sv = dot((vec4(1.0) - k) * sl * sl, vec4(1.5));
      return A.x * (c.r - 0.5) * k.x + A.y * ((c.g - 0.5) + 0.5 * (c.b - 0.5)) * k.y + A.z * (f.g - 0.5) * k.z + A.w * (f.b - 0.5) * k.w;
    }
    // LV2 sun glints: sparse mirror-like facets, one per 2.5 cm cell of texture space where hash < density (stable:
    // the pattern is fixed in the rock), a disc around a jittered centre, tilted at random by up to ~0.3 rad; a facet
    // flashes only when it mirrors a light into the eye (glintLobe, in the lights loop). Faded below ~1 px (the
    // Toksvig roughness carries the unresolved part). pcg3d hash: Jarzynski & Olano 2020.
    uvec3 pcgG(uvec3 v){ v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u;
      v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v; }
    vec4 glintFacet(vec3 p, float fw, float dens){
      const float CS = 0.025;
      vec3 q = p / CS, c = floor(q);
      uvec3 ci = uvec3(ivec3(c) + 65536);
      vec3 h = vec3(pcgG(ci)) / 4294967295.0, h2 = vec3(pcgG(ci + 7919u)) / 4294967295.0;
      float d = length(q - c - (0.25 + 0.5 * h2));
      float m = step(h.x, dens) * (1.0 - smoothstep(0.2, 0.3, d)) * (1.0 - smoothstep(CS * 0.4, CS * 1.0, fw));
      return vec4((h.yzx * 2.0 - 1.0) * 0.3, m);
    }
    vec3 gFacetV = vec3(0.0, 0.0, 1.0); float gMask = 0.0;
    float glintLobe(vec3 Lv, vec3 Vv){
      if (gMask <= 0.0) return 0.0;
      vec3 R = reflect(-Vv, gFacetV);
      return gMask * pow(max(dot(R, Lv), 0.0), 150.0) * 12.0 * smoothstep(0.0, 0.1, dot(gFacetV, Lv));
    }
    ${HOT}
    vec3 terrainColor(vec3 nW, out float rough, out vec3 emis, out float relief, out float glintD){
      vec3 bw = pow(abs(nW), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
      vec2 dPx = dFdx(vT.xz), dPy = dFdy(vT.xz);           // uniform control flow (used by the lava branch)
      float fw = max(length(dFdx(vT)), length(dFdy(vT)));   // pixel footprint (m), for the relief octaves
      float Wt[12];
      Wt[0]=vMA.x; Wt[1]=vMA.y; Wt[2]=vMA.z; Wt[3]=vMA.w; Wt[4]=vMB.x; Wt[5]=vMB.y; Wt[6]=vMB.z; Wt[7]=vMB.w; Wt[8]=vMC.x; Wt[9]=vMC.y; Wt[10]=vMC.z; Wt[11]=vMC.w;
      int i1 = 1; float w1 = -1.0; int i2 = 1; float w2 = -1.0; float sum = 0.0;
      for (int i = 0; i < 12; i++){ float v = Wt[i]; sum += v; if (v > w1){ w2 = w1; i2 = i1; w1 = v; i1 = i; } else if (v > w2){ w2 = v; i2 = i; } }
      float nb = texture(tNoise, vT.xz*0.21 + vT.y*0.09).b, nz = texture(tNoise, vT.xz*0.05 + vT.y*0.02).g;
      // symmetric blend: each material's score = its share + its own noise; swapping i1/i2 gives 1 - t, so there is
      // no seam where the ranking flips (adding noise to t itself left a lattice-shaped seam = stair steps)
      vec3 bwn = pow(abs(nW), vec3(2.0)); bwn /= (bwn.x + bwn.y + bwn.z);
      float dsc = (w2 - w1) / (w1 + w2 + 1e-4) + (matNoise(vT, bwn, float(i2)) - matNoise(vT, bwn, float(i1))) * 0.9;
      float t = w2 > 1e-3 ? smoothstep(-0.22, 0.22, dsc) : 0.0;
      vec4 P1 = uMatP[i1], P2 = uMatP[i2];
      vec3 c1 = triAT(float(i1), vT, bw, P1.x) * uMatTint[i1];
      vec3 c2 = triAT(float(i2), vT, bw, P2.x) * uMatTint[i2];
      vec3 col = mix(c1, c2, t);
      col *= mix(vec3(0.94, 0.9, 0.86), vec3(1.07, 1.03, 0.97), nz);
      // volcanic ground (basalt 7, crust 9, ash 10) is black rock and tephra (user 2026-10-08: "black rocky ground,
      // not shiny plastic"): the source textures' red scoria specks and brown cast are muted toward charcoal
      float wv = (Wt[7] + Wt[9] + Wt[10]) / max(sum, 1e-3);
      col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))) * vec3(0.9, 0.93, 1.0) * 0.82, 0.6 * wv);
      // ice (slot 6): the source texture is a saturated ultramarine (user 2026-10-08, the shore ice "garish"); real
      // glacier / shore ice is pale blue-white with only a little blue in it
      float wi = Wt[6] / max(sum, 1e-3);
      col = mix(col, mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.3) * vec3(0.9, 0.97, 1.05) * 1.25 + vec3(0.06, 0.07, 0.08), 0.8 * wi);
      rough = mix(P1.y, P2.y, t);
      float poro = mix(P1.w, P2.w, t);
      vec4 RA = mix(uRelief[i1], uRelief[i2], t);
      float GD = mix(uGlint[i1], uGlint[i2], t);
      // surface state from the simulation (grass cover, dryness, char, burning)
      vec4 sf = texture(tSurf, (vT.xz * 2.0 + 0.5) / 193.0);   // 193 columns, texel centres at x = i * 0.5
      float up = nW.y, sky = (1.0 - smoothstep(0.05, 0.35, vDepth));
      float cover = sf.r * smoothstep(0.55, 0.8, up + (nb - 0.5) * 0.25) * sky;
      vec3 gT = triA(12.0, vT, bw, 0.33), dT = triA(13.0, vT, bw, 0.3);
      vec3 grass = mix(gT * uGrassTint, dT * uDryTint, smoothstep(0.35, 0.8, sf.g + (nz - 0.5) * 0.3));
      col = mix(col, grass, smoothstep(0.15, 0.6, cover));
      // weather cover (5e): per-column snow / ash depth from the sim (render/weather.js tCover: r / g = depth / 0.4 m)
      // on up-facing, sky-exposed surfaces; full from ~5 cm snow / ~3 cm ash, patchy below; uSnow = a uniform floor
      vec2 cvr = texture(tCover, (vT.xz * 2.0 + 0.5) / 193.0).rg * 0.4;
      float upM = smoothstep(0.45, 0.75, up + (nb - 0.5) * 0.3) * sky;
      float sn = max(uSnow, cvr.x > 0.002 ? smoothstep(0.2, 0.8, cvr.x / 0.05 + (nb - 0.5) * 0.6) : 0.0) * upM;
      col = mix(col, triA(5.0, vT, bw, 0.2) * vec3(1.0, 1.02, 1.06), sn);
      rough = mix(rough, 0.6, sn); RA = mix(RA, uRelief[5], sn); GD = mix(GD, uGlint[5], sn);
      float ashC = (cvr.y > 0.002 ? smoothstep(0.2, 0.8, cvr.y / 0.03 + (nz - 0.5) * 0.6) : 0.0) * upM;
      col = mix(col, vec3(0.085, 0.08, 0.078) * (0.8 + 0.4 * nb), ashC);
      rough = mix(rough, 0.95, ashC); RA = mix(RA, uRelief[10], ashC); GD = mix(GD, uGlint[10], ashC);
      // char / scorch
      col = mix(col, vec3(0.045, 0.04, 0.038) + col * 0.12, sf.b * (0.65 + 0.35 * nb));
      // overhangs / cave ceilings: darker, cooler
      col *= mix(1.0, 0.6, (1.0 - smoothstep(-0.8, -0.2, up)));
      // rain (LV2; Lagarde 2013 "Water drop 2b"): water fills the pores of porous ground (darker; little film on top,
      // so it stays fairly matte: ~0.55-0.6), a film runs on dense rock (~0.35-0.4), always over the rock's relief
      // (the normals below): many small broken highlights, never one smooth lobe. Mirror-like only in puddles (film).
      // (Before: 0.18 + 0.3 (1 - poro) on the smooth mesh normals: soil 0.24 = a plastic bag.)
      float wet = uWet * (0.25 + 0.75 * smoothstep(-0.3, 0.6, up));
      col *= 1.0 - wet * poro * 0.42; rough = mix(rough, min(rough, mix(0.3, 0.62, poro)), wet);
      GD = max(GD, wet * (0.04 + 0.1 * (1.0 - poro)));    // film beads on wet ground, more on dense rock
      // water: wet band, depth tint and caustics below the (simulated) surface
      // tWater: render/water.js map (one texel per column: r surface or bed, g depth, b foam, a wetness) or a blank
      // texture (legacy: still sea at uSea)
      vec4 wt = texture(tWater, uWaterTex > 0.5 ? (vW.xz * 2.0 + 0.5) / 193.0 : vW.xz / 96.0);
      float surf = uWaterTex > 0.5 ? (wt.g > -0.6 ? wt.r : -99.0) : (wt.r > 0.0 ? wt.r : uSea);   // g < 0: dry bank next to water (signed depth)
      float under = surf - vW.y;
      float wetB = smoothstep(-0.45, 0.0, under);
      if (uWaterTex > 0.5) wetB = max(wetB, wt.a * smoothstep(-0.7, -0.1, wt.r - vW.y));   // recent run-up dries slowly
      col *= mix(1.0, 0.62, wetB * (0.45 + 0.55 * poro));     // wet sand loses ~40 % albedo; wet rock darkens too (film fills its micro-relief)
      rough = mix(rough, 0.3 + 0.3 * (1.0 - poro), wetB * 0.7 * smoothstep(-0.45, 0.0, under));   // a sheen near the water only; damp ground stays matte
      // water film: the smoothed mesh lies a few cm above the simulated bed in concave floors (one vertex per cell),
      // so a shallow pool's water is under it: terrain just above the surface of a wet column reads as a film
      float film = 0.0;
      if (uWaterTex > 0.5) { film = smoothstep(0.0, 0.02, wt.g) * smoothstep(-0.07, -0.005, under); col *= mix(1.0, 0.8, film); rough = mix(rough, 0.07, film); }
      RA *= (1.0 - film) * uDetail;                       // a puddle's water surface is flat (and Low has no relief)
      GD *= (1.0 - film) * (1.0 - smoothstep(-0.05, 0.05, under)) * uDetail * sky;   // none in puddles, under water, caves
      if (under > 0.0) {
        col *= mix(vec3(1.0), vec3(0.42, 0.66, 0.72), smoothstep(0.0, 2.0, under));
        col += uCaustic * caustic(vW) * vec3(0.55, 0.7, 0.62) * smoothstep(0.0, 0.35, under) * exp(-under * 0.6) * max(up, 0.2);
        rough = 0.4;
      }
      // lava glow (fresh lava = slot 8, crust = slot 9 with faint cracks)
      float wl = Wt[8] / max(sum, 1e-3), wc = Wt[9] / max(sum, 1e-3);
      emis = vec3(0.0);
      if (wl + wc > 0.01) {
        float lf = lavaFlow(vT, dPx, dPy);
        float pulse = 0.88 + 0.12 * sin(uTime * 0.6 + vT.x * 0.5 + vT.z * 0.4);
        // crust: only a faint dull-red residual heat in the deepest cracks (it is cold rock; open lava is render/lava.js)
        emis = wl * pow(lf, 1.9) * 3.8 * pulse * vec3(1.0, 0.34, 0.06) + wc * pow(lf, 5.0) * 0.45 * vec3(1.0, 0.2, 0.03);
        col = mix(col, vec3(0.12, 0.06, 0.04), wl * 0.6);
      }
      // burning grass: glowing embers in the cover band (S.veg.surf a)
      if (sf.a > 0.01) emis += sf.a * sky * smoothstep(0.35, 0.7, nb + 0.25 * sin(uTime * 3.0 + vT.x * 2.0 + vT.z * 1.7)) * 1.4 * vec3(1.0, 0.3, 0.05);
      col = hotSand(col, vW, up, emis);
      // P7 (PoC materials): girder steel = painted orange-brown plate with darker truss bars and rivet rows; foam-mortar
      // foam = pale, bubbly, matte (vMD: their weights, 0..1, outside the 12 texture slots)
      float xs = vMD.x, xf = vMD.y, xc = vMD.z, xo = vMD.w;
      // P31 obsidian (lava quenched by water): black volcanic glass, glossy, with faint conchoidal (shell-fracture)
      // ripples and a grey sheen; no grain
      if (xo > 0.02) {
        float cf = texture(tNoise, vT.xz * 0.9 + vT.y * 0.7).r, rip = 0.5 + 0.5 * sin(cf * 26.0 + vT.y * 3.0);
        vec3 obs = vec3(0.028, 0.026, 0.032) * (0.85 + 0.3 * rip) + vec3(0.02, 0.022, 0.026) * smoothstep(0.6, 0.9, cf);
        float ko = smoothstep(0.2, 0.55, xo);
        col = mix(col, obs, ko); rough = mix(rough, 0.16, ko); RA *= 1.0 - ko * 0.6; GD *= 1.0 - ko; emis *= 1.0 - ko;
      }
      // ASSET: tex_concrete (docs/ASSET_PROMPTS.md: textures/concrete_*.png, board-formed; this procedural look is the stand-in)
      // P29d bunker concrete: weathered grey cast concrete, horizontal board-formwork lines (0.3 m lifts), fine
      // aggregate speckle, darker rain-streaked stains running down from edges and a damp darker foot
      if (xc > 0.02) {
        float lift = 1.0 - smoothstep(0.012, 0.03, abs(fract(vT.y / 0.3) - 0.5) - 0.47);
        float agg = texture(tNoise, vT.xz * 6.3 + vT.y * 5.1).r, mot = texture(tNoise, vT.xz * 0.35 + vT.y * 0.2).g;
        float streak = smoothstep(0.55, 0.9, texture(tNoise, vec2(dot(vT.xz, vec2(0.83, 0.56)) * 1.7, vT.y * 0.08)).b);
        vec3 conc = vec3(0.245, 0.24, 0.225) * (0.82 + 0.3 * mot) * (0.93 + 0.12 * agg);   // weathered grey (albedo ~0.24: in this sun 0.4 read near-white)
        conc *= 1.0 - 0.13 * lift - 0.22 * streak * (1.0 - smoothstep(-0.3, 0.6, up));
        float kc = smoothstep(0.2, 0.55, xc);
        col = mix(col, conc, kc); rough = mix(rough, 0.9, kc); RA *= 1.0 - kc * 0.7; GD *= 1.0 - kc; emis *= 1.0 - kc;
      }
      if (xs + xf > 0.02) {
        vec2 q = vec2(dot(vT.xz, vec2(0.7071)), vT.y) * 2.2;
        float bar = 1.0 - smoothstep(0.06, 0.12, min(abs(fract(q.x + q.y) - 0.5), abs(fract(q.x - q.y) - 0.5)));
        float rv = 1.0 - smoothstep(0.08, 0.13, length(fract(q * 2.0) - 0.5));
        vec3 steel = vec3(0.47, 0.24, 0.12) * (0.85 + 0.3 * nb) * (1.0 - 0.38 * bar) + vec3(0.12, 0.1, 0.08) * rv;
        float bub = texture(tNoise, vT.xz * 3.1 + vT.y * 1.7).r;
        vec3 foam = vec3(0.86, 0.9, 0.95) * (0.82 + 0.18 * smoothstep(0.3, 0.7, bub));
        float ks = smoothstep(0.2, 0.55, xs), kf = smoothstep(0.2, 0.55, xf);
        col = mix(mix(col, steel, ks), foam, kf);
        rough = mix(mix(rough, 0.42, ks), 0.9, kf); RA *= 1.0 - max(ks, kf); GD *= 1.0 - max(ks, kf); emis *= 1.0 - max(ks, kf);
      }
      float sv; relief = reliefH(vT, RA, fw, sv); glintD = GD;
      rough = min(1.0, sqrt(rough * rough + sv));
      return col;
    }
  `;

  function patchVertex(sh, body) {
    sh.vertexShader = 'attribute float depth; attribute vec4 mA; attribute vec4 mB; attribute vec4 mC; attribute vec4 mD;\nvarying vec3 vW; varying vec3 vWN; varying float vDepth; varying vec4 vMA; varying vec4 vMB; varying vec4 vMC; varying vec4 vMD;\nvarying vec3 vT; varying vec3 vTN;\n' +
      (body ? 'attribute vec3 tpos;\n' : '') +
      sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal); vDepth = depth; vMA = mA; vMB = mB; vMC = mC; vMD = mD;
        ${body ? 'vT = tpos; vTN = normalize(objectNormal);' : 'vT = vW; vTN = vWN;'}`);
  }
  /* mode 0 slab, 1 context far colour, 2 context far depth pre-pass, 3 context near */
  /* body = true: material for a detached rock piece (render/bodies.js): textured in the piece's own frame (tpos) */
  function terrainMaterial(mode, body) {
    const opts = { roughness: 0.92, metalness: 0, side: mode === 0 ? T.DoubleSide : T.FrontSide };
    if (mode === 1 || mode === 3) Object.assign(opts, { transparent: true, depthWrite: false });
    if (mode === 2) Object.assign(opts, { colorWrite: false });
    const m = new T.MeshStandardMaterial(opts);
    if (mode === 0) m.shadowSide = T.DoubleSide;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U);
      patchVertex(sh, body);
      // slice zero (t = 0) is the collision section: the slab is everything from -uBack up to it, nothing in front
      // D6: a dry world's lattice is drawn only inside the disc uLatR (x, z, r; r 0 = off): the far grid beyond it
      // (render/dunes.js); rock pieces (body) are never clipped
      const clip = (mode === 0 ? 'if (tD > 0.0 || tD < -uBack) discard;' : mode === 3 ? 'if (tD < 0.0) discard;' : 'if (tD > -uBack) discard;') +
        (body ? '' : ' if (uLatR.z > 0.0 && distance(vW.xz, uLatR.xy) > uLatR.z) discard;');
      sh.fragmentShader = COMMON + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          float tD = dot(vW - uO, uN);
          ${clip}`)
        .replace('#include <map_fragment>', /* glsl */`
          vec3 nW = normalize(vWN);
          float tRough, tRelief, tGlint; vec3 tEmis;
          vec3 col = terrainColor(normalize(vTN), tRough, tEmis, tRelief, tGlint);
          ${mode === 0 ? `if (!gl_FrontFacing) { col = texture(tMats, vec3(vT.xz*0.1 + vT.y*0.07, 14.0)).rgb * 0.35; tEmis = vec3(0.0);
            if (uDbgBack > ${body ? '0.5' : '1.5'}) { col = vec3(0.0); tEmis = vec3(4.0, 0.0, 4.0); } }` : ''}
          diffuseColor.rgb = col;
          ${mode === 1 || mode === 3 ? /* glsl */`
            float ad = ${mode === 1 ? '-tD - uBack' : 'tD'};
            float a = ${mode === 1 ? 'mix(uAlpha * mix(0.96, 0.42, smoothstep(0.0, 46.0, ad)), 1.0, uCtxSolid)' : 'uAlpha * 0.26 * exp(-ad / 12.0) * smoothstep(7.0, 22.0, distance(vW, cameraPosition))'};
            diffuseColor.a = a;
            diffuseColor.rgb = mix(col, uHaze, ${mode === 1 ? 'CTX_HAZE(ad)' : '(0.12 + 0.4 * smoothstep(0.0, 50.0, ad))'});` : ''}
        `)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          roughnessFactor = tRough;`)
        // LV2 relief normals: Mikkelsen 2010 surface gradient from screen-space derivatives of the relief height (m)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
            float bx = dFdx(tRelief), by = dFdy(tRelief);
            vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx); float det = dot(dpx, r1);
            normal = normalize(abs(det) * normal - sign(det) * (bx * r1 + by * r2));
            float fwG = max(length(dFdx(vT)), length(dFdy(vT)));
            vec4 gf = glintFacet(vT, fwG, tGlint); gMask = gf.w;
            gFacetV = normalize(normal + (viewMatrix * vec4(gf.xyz, 0.0)).xyz);
          }`)
        .replace('#include <lights_fragment_begin>', LFB_GLINT || '#include <lights_fragment_begin>')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += tEmis;`);
    };
    m.customProgramCacheKey = () => 'terrain' + mode + (body ? 'b' : '') + (U.uDetail.value > 0.5 ? 'd' : '');
    return m;
  }
  /* shadow pass for the slab: same clip */
  function slabDepthMaterial() {
    const m = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, side: T.DoubleSide });
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { uO: U.uO, uN: U.uN, uBack: U.uBack, uLatR: U.uLatR });
      sh.vertexShader = 'varying vec3 vW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = 'uniform vec3 uO, uN, uLatR; uniform float uBack; varying vec3 vW;\n' + sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n float tD = dot(vW - uO, uN); if (tD > 0.0 || tD < -uBack) discard;' +
        ' if (uLatR.z > 0.0 && distance(vW.xz, uLatR.xy) > uLatR.z) discard;');
    };
    m.customProgramCacheKey = () => 'slabdepth2';
    return m;
  }

  /* The cut face: a plane at t = 0 (slice zero) coloured from the 3D world texture.
   * Material weights come from the lattice points around a noise-jittered position: a quadratic B-spline over 27
   * points (C1, so a voxel staircase becomes a smooth curve) or, on Low, trilinear over 8 (C0: corners at every
   * lattice point). The jitter is low-frequency (~1-2 m) so boundaries wander instead of growing teeth. */
  function capMaterial() {
    const m = new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0, side: T.DoubleSide });
    const bspline = Q.name !== 'low';
    m.onBeforeCompile = sh => {
      if (bspline) sh.fragmentShader = '#define CAP_BSPLINE 1\n' + sh.fragmentShader;
      Object.assign(sh.uniforms, U, FAR, CAPU, { tVol: { value: volTex }, uVolSize: { value: new T.Vector3(SS.world.NX, SS.world.NY, SS.world.NZ) }, uCapN: capN });
      // the plane mesh sits 2 mm behind slice zero; everything is sampled ON slice zero (t = 0: the collision plane, O1)
      sh.vertexShader = 'uniform vec3 uO, uN; varying vec3 vW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vW -= uN * dot(vW - uO, uN);');
      sh.fragmentShader = /* glsl */`
        uniform highp sampler3D tVol; uniform highp sampler2DArray tMats; uniform sampler2D tNoise; uniform sampler2D tSurf; uniform sampler2D tCover; uniform highp sampler2D tLavaS;
        uniform vec3 uVolSize, uO, uN, uGrassTint; uniform float uTime, uSea, uHalf, uVolc; uniform vec3 uMatTint[12];
        uniform highp sampler2D tFar; uniform vec4 uFar; uniform vec2 uLat; uniform vec3 uLatR;   // D5 far strip: u0, du, n, on; lattice size; D6 disc
        uniform highp sampler3D tN3; uniform float uS0;
        varying vec3 vW;
        // C1 (user: the face must not SCROLL while the section turns; each spot morphs into another random part of the
        // texture, faster the further from the worm): textures are pinned to the face, pu = (τ, y), τ = s + uS0 (s =
        // distance from the pivot along the face; uS0 absorbs pivot moves on the same plane); the variety comes from a
        // 3D world grid of MORPH cells (simplex corners, MORPH_CELL m): each corner holds a random texture offset and the
        // face pixel blends the texture at the offsets of the corners around its WORLD point (variance-preserving, Heitz &
        // Neyret 2018 / Deliot & Heitz 2019). Turning moves that point by |s|·Δθ through the grid: no change under the
        // worm, a full change after ~one cell further out, and turning back restores the look. Noise: tN3 at the world
        // point (a 3D field behaves the same way).
        vec4 cW4; vec2 cO4[4]; float cNrm; vec2 cGx, cGy;
        uvec3 pcg3(uvec3 v){ v = v * 1664525u + 1013904223u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; v ^= v >> 16u; v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y; return v; }
        vec2 cellOff(vec3 c){ uvec3 h = pcg3(uvec3(ivec3(c) + 4096)); return vec2(h.xy & 0xffffu) / 65536.0; }
        void morphCells(vec3 p){
          const float F3 = 1.0 / 3.0, G3 = 1.0 / 6.0;
          vec3 i = floor(p + dot(p, vec3(F3)));
          vec3 x0 = p - i + dot(i, vec3(G3));
          vec3 g = step(x0.yzx, x0.xyz), l = 1.0 - g;
          vec3 i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy);
          vec3 x1 = x0 - i1 + G3, x2 = x0 - i2 + 2.0 * G3, x3 = x0 - 1.0 + 3.0 * G3;
          vec4 w = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);   // compact: 0 where a corner changes
          w = w * w * w; w /= max(w.x + w.y + w.z + w.w, 1e-6);
          cW4 = w; cNrm = inversesqrt(max(dot(w, w), 1e-6));
          cO4[0] = cellOff(i); cO4[1] = cellOff(i + i1); cO4[2] = cellOff(i + i2); cO4[3] = cellOff(i + 1.0);
        }
        // the material layer L at face coords pu·sc through the morph cells (msk (1, 1); strata (1, 0): offsets along the
        // face only, so the layers keep their heights); explicit gradients (offsets jump where their weight is 0)
        vec3 texM(vec2 pu, vec2 sc, float L, vec2 msk){
          vec2 uv = pu * sc, gx = cGx * sc, gy = cGy * sc;
          vec3 mean = textureLod(tMats, vec3(0.5, 0.5, L), 12.0).rgb, acc = vec3(0.0);
          for (int k = 0; k < 4; k++) if (cW4[k] > 0.003) acc += cW4[k] * (textureGrad(tMats, vec3(uv + cO4[k] * msk, L), gx, gy).rgb - mean);
          return max(mean + acc * cNrm, vec3(0.0));
        }
        vec4 n3(vec3 p){ return texture(tN3, p); }
        // far strip at section coordinate u (= dot(xz, dir)): top, sand base, rock top (linear between texels)
        vec4 farAt(float u){
          float t = clamp((u - uFar.x) / uFar.y, 0.0, uFar.z - 1.001); int i = int(t);
          return mix(texelFetch(tFar, ivec2(i, 0), 0), texelFetch(tFar, ivec2(i + 1, 0), 0), t - float(i));
        }
        vec3 vuv(vec3 p){ return (p / 0.5 + 0.5) / uVolSize; }
        float gLava;                                   // lava share of the local material weights (1 deep inside a pocket)
        float dens(vec3 p){ return texture(tVol, vuv(p)).r; }   // raw half-float density: the sim's iso-line (O1)
        // open lava layer (render/lava.js): bilinear over the columns of rgba = surface y, depth, T, bed y
        vec4 lavaCol(vec2 xz){
          vec2 g = xz / 0.5; ivec2 b = ivec2(floor(g)); vec2 f = g - vec2(b); ivec2 mx = textureSize(tLavaS, 0) - 1;
          vec4 a = texelFetch(tLavaS, clamp(b, ivec2(0), mx), 0), c = texelFetch(tLavaS, clamp(b + ivec2(1, 0), ivec2(0), mx), 0);
          vec4 d = texelFetch(tLavaS, clamp(b + ivec2(0, 1), ivec2(0), mx), 0), e = texelFetch(tLavaS, clamp(b + ivec2(1, 1), ivec2(0), mx), 0);
          return mix(mix(a, c, f.x), mix(d, e, f.x), f.y);
        }
        // section through open lava: incandescent melt with slow convection, a dark crust skin with glowing cracks at
        // the surface, a chilled orange base against the ground; colours as the voxel pockets (ACES-sized)
        vec3 lavaSection(vec2 pu, float dTop, float dBot, float Tm, out float skinF){
          float heat = clamp((Tm - 0.12) / 0.88, 0.0, 1.0);
          vec2 wq = (texture(tNoise, pu * 0.07 + vec2(0.0009, -0.0026) * uTime).rg - 0.5) * 1.4;
          float cv = texture(tNoise, pu * 0.16 + wq + vec2(-0.004, -0.002) * uTime).r * 0.65 + texture(tNoise, pu * 0.41 - wq * 0.5 + vec2(0.002, -0.009) * uTime).g * 0.35;
          float core = smoothstep(0.05, 0.4, min(dTop, dBot) + (cv - 0.5) * 0.15) * heat;
          vec3 hot = mix(vec3(1.0, 0.11, 0.01), vec3(1.8, 0.52, 0.05), core) * (0.62 + 0.76 * cv) * (0.35 + 0.65 * heat);
          float sk = 0.03 + 0.05 * (1.0 - heat) + (texture(tNoise, vec2(pu.x * 0.9, 0.3)).r - 0.5) * 0.03;
          float crack = smoothstep(0.82, 0.95, texture(tNoise, vec2(pu.x * 0.7 + uTime * 0.002, 0.71)).g);
          skinF = (1.0 - smoothstep(sk * 0.5, sk, dTop)) * (1.0 - crack);
          return hot * (1.0 - skinF);
        }
        vec3 capCol(int mat, vec2 pu, vec3 strata, float dd, vec4 sf, float heat, out vec3 em){
          em = vec3(0.0);
          // P7: girder steel (13): the beam's cut, a painted plate with a dark web line; foam (14): bubbly pale cells
          if (mat == 13) { float web = 1.0 - smoothstep(0.03, 0.06, abs(fract(pu.y * 1.6) - 0.5)); return vec3(0.47, 0.24, 0.12) * (1.0 - 0.45 * web) * (0.9 + 0.2 * texture(tNoise, pu * 0.5).r); }
          if (mat == 14) { float b = texture(tNoise, pu * 1.7).r; return vec3(0.86, 0.9, 0.95) * (0.78 + 0.22 * smoothstep(0.35, 0.65, b)); }
          // P31 obsidian cut: black glass, curved conchoidal fracture lines, a faint grey flow banding
          if (mat == 16) { float cf = texture(tNoise, pu * 0.8).r, rip = 0.5 + 0.5 * sin(cf * 30.0); float band = texture(tNoise, vec2(pu.x * 0.15, pu.y * 2.2)).g;
            return vec3(0.03, 0.028, 0.034) * (0.8 + 0.4 * rip) + vec3(0.025) * smoothstep(0.62, 0.8, band); }
          // P29d concrete cut: grey matrix, coarse aggregate stones, rebar cut ends every 0.2 m (rust-brown dots)
          if (mat == 15) {
            float ag = texture(tNoise, pu * 3.7 + vec2(0.13, 0.71)).r * 0.6 + texture(tNoise, pu * 9.1 + 0.3).g * 0.4, ag2 = texture(tNoise, pu * 1.1).b;
            vec3 c = vec3(0.36, 0.355, 0.335) * (0.9 + 0.14 * ag2);
            c = mix(c, vec3(0.43, 0.41, 0.39) * (0.85 + 0.3 * ag), smoothstep(0.62, 0.72, ag) * 0.45);   // aggregate stones (two scales: no tiling)
            float rb = 1.0 - smoothstep(0.012, 0.022, length(fract(pu / 0.2) - 0.5));
            return mix(c, vec3(0.32, 0.17, 0.09), rb * 0.9);
          }
          int L = mat - 1;
          vec3 own = texM(pu, vec2(0.16), float(L), vec2(1.0)) * uMatTint[L];
          vec3 col = own; em = vec3(0.0);
          if (mat == 8 || mat == 10 || (mat == 1 && uVolc > 0.5)) {
            // basalt / crust (and a volcanic island's bedrock): black volcanic rock, not the sedimentary strata (user
            // 2026-10-08: "black rocky ground, not shiny plastic"; 65 % red-orange strata read as smooth painted clay).
            // The basalt texture's grain, desaturated to charcoal; the strata only add flow-unit banding in brightness
            // (no hue), plus blocky joint shading. Slightly cool, so under the warm sun / brown ground bounce it reads
            // as neutral charcoal, not brown.
            vec3 bas = texM(pu, vec2(0.16), 7.0, vec2(1.0)) * uMatTint[7];
            float bl = dot(bas, vec3(0.299, 0.587, 0.114)), sl = dot(strata, vec3(0.299, 0.587, 0.114));
            float jn = texture(tNoise, vec2(pu.x * 0.55, pu.y * 0.9)).g;               // jointed blocks
            col = mix(vec3(bl), bas, 0.12) * vec3(0.84, 0.9, 1.0) * 0.55 * mix(0.72, 1.18, smoothstep(0.12, 0.42, sl)) * mix(0.8, 1.08, smoothstep(0.3, 0.7, jn));
            if (mat == 10) col *= 0.85;                                                 // chilled margin: glassier, darker
          } else if (mat == 11) {
            // ash / tephra: dark grey cinders, a few dull red scoria grains (muted like the surface)
            col = mix(own, vec3(dot(own, vec3(0.299, 0.587, 0.114))) * vec3(0.9, 0.93, 1.0), 0.65) * 0.75;
          } else if (mat == 1 || mat == 2 || mat == 5 || mat == 12) {
            vec3 tint = mat == 5 ? vec3(1.12, 0.78, 0.62) : mat == 1 ? vec3(0.5) : vec3(1.0);
            col = mix(strata * tint, own, mat == 12 ? 0.75 : 0.35);
          } else if (mat == 9) {
            // Lava sealed in rock is an incandescent liquid (no crust): yellow-white core with slow, low-contrast
            // convection, orange-red only in the thin chilled margin against the host rock. The crust-plate texture
            // (cooled skin floating on the melt) only appears within ~0.35 m of air.
            col = vec3(0.0);                                          // self-lit: no diffuse (it washed the glow out)
            // slow convection: domain-warped noise drifting upward (~1-2 cm/s)
            vec2 wq = (texture(tNoise, pu * 0.07 + vec2(0.0009, -0.0026) * uTime).rg - 0.5) * 1.4;
            float cv = texture(tNoise, pu * 0.16 + wq + vec2(0.0, -0.0045) * uTime).r * 0.65 + texture(tNoise, pu * 0.41 - wq * 0.5 + vec2(0.002, -0.009) * uTime).g * 0.35;
            float core = smoothstep(0.5, 0.95, gLava + (cv - 0.5) * 0.3);
            // sized for ACES (its input matrix desaturates; more green/blue washes out to cream): core -> sRGB
            // ~(250, 199, 99) golden yellow, margin -> deep orange
            // LV1: was (1.8, 0.52, 0.05) x up to 1.4: ACES flattened the whole pocket to one cream colour (sRGB ~244,
            // 214, 136, std 10) = the "flat lava wall"; now orange-yellow with visible convection cells and plumes
            float plume = smoothstep(0.6, 0.85, texture(tNoise, vec2(pu.x * 0.21, pu.y * 0.16 - uTime * 0.004) + wq * 0.5).b);
            // (three's ACES multiplies by exposure / 0.6 first: keep the melt below ~1 so the cells survive the curve)
            vec3 hot = mix(vec3(0.42, 0.04, 0.004), vec3(0.72, 0.2, 0.018), core) * (0.35 + 1.2 * cv + 0.4 * plume * core) * (0.7 + 0.3 * heat);
            float skin = (1.0 - smoothstep(0.1, 0.35, dd));
            float lf = texture(tMats, vec3(pu * 0.11 + vec2(0.0011, -0.0035) * uTime, 8.0)).r;
            em = mix(hot, pow(lf, 1.3) * vec3(5.0, 1.7, 0.35), skin);
          }
          if (mat == 10) {
            // LV1: crust = glassy chilled margin / old flow rind: dark, no strata; against hot lava (gLava, the lava
            // share of this cell) a dull red contact glow with brighter thermal-contraction cracks
            col = own * 0.55;
            float rc = 1.0 - abs(2.0 * texture(tNoise, pu * 0.55 + 0.13).g - 1.0), rc2 = 1.0 - abs(2.0 * texture(tNoise, pu * 1.3 + 0.61).r - 1.0);
            float crk = max(smoothstep(0.9, 0.98, rc), smoothstep(0.93, 0.99, rc2) * 0.7);
            float hotC = smoothstep(0.0, 0.35, gLava);
            em = (vec3(0.11, 0.012, 0.0) + vec3(0.55, 0.07, 0.006) * crk) * hotC;
          }
          if (mat == 3) {
            vec3 turf = mix(texM(pu, vec2(0.33), 12.0, vec2(1.0)) * uGrassTint * 0.7, own * 0.55, smoothstep(0.04, 0.16, dd));
            col = mix(mix(turf, own * 0.9, smoothstep(0.16, 0.4, dd)), own * 0.9, 1.0 - sf.r);
          }
          if (mat == 6) col = mix(col, col * vec3(0.8, 0.9, 1.05), smoothstep(0.3, 2.0, dd));
          if (mat == 7) {                                                                  // ice: pale, bluer with depth
            col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.35) * 1.2 + vec3(0.05, 0.06, 0.07);
            col = mix(col * vec3(1.0, 1.04, 1.08), col * vec3(0.62, 0.8, 1.0), smoothstep(0.2, 1.5, dd));
          }
          return col;
        }
        ` + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', /* glsl */`#include <clipping_planes_fragment>
          vec2 dW = vec2(uN.z, -uN.x);
          float u = dot(vW.xz, dW);                      // absolute along-plane coordinate: GEOMETRY only (far strip)
          float tau = dot(vW.xz - uO.xz, dW) + uS0;      // C1: pinned face coordinate for every texture
          morphCells(vW / ${MORPH_CELL.toFixed(2)});
          cGx = dFdx(vec2(tau, vW.y)); cGy = dFdy(vec2(tau, vW.y));
          // D5: beyond the lattice (dry worlds) the far strip is the ground; eB = distance inside the border
          float eB = min(min(vW.x, vW.z), min(uLat.x - vW.x, uLat.y - vW.z));
          if (uLatR.z > 0.0) eB = min(eB, uLatR.z - distance(vW.xz, uLatR.xy));   // D6: the disc's edge
          bool farOn = uFar.w > 0.5, outL = farOn && eB < 0.0;
          vec4 fl = farOn && eB < 1.0 ? farAt(u) : vec4(0.0);
          // P29a (user 2026-10-08: "below the map there should be endless soil, not empty space, under the sea as well"):
          // the section never ends in a void. Below the lattice floor (y < 0.02) it is bedrock; beyond the lattice on wet
          // worlds it is rock under the open sea's bed line (the same line as render/water.js's aquarium face), water above
          // it (drawn by that face). The cap plane reaches DEEP m down and EXT m sideways (TR.update).
          bool wetOut = !farOn && eB < 0.0;
          vec2 oL = max(max(-vW.xz, vW.xz - uLat), 0.0);
          if (wetOut && vW.y >= max(1.08 - length(oL) * 0.06, 0.02)) discard;
          bool deepR = vW.y < 0.02 || wetOut;
          float d0 = deepR ? 1.0 : outL ? fl.x - vW.y : dens(vW);
          vec4 cLv = d0 > 0.0 || outL ? vec4(0.0) : lavaCol(vW.xz);
          // only the air between the bed (the column's highest solid) and the lava surface holds layer lava. Air BELOW
          // the bed is a cave under the flow, not lava (user 2026-10-08 "lava pillar": a cave under a lava river was
          // drawn as a solid orange column inside the rock). 0.3 m covers the bilinear bed blend at the flow's edges.
          bool capLava = d0 <= 0.0 && cLv.g > 0.004 && vW.y < cLv.r && vW.y > cLv.a - 0.3;
          // weather cover (5e): air within the column's snow + ash depth above solid ground, open to the sky
          // (nothing solid within 4 m above), is drawn as the cover layer lying on the section's ground line
          float capCv = 0.0, capAsh = 0.0;
          if (d0 <= 0.0 && !capLava && !outL) {
            vec2 cq = texture(tCover, (vW.xz * 2.0 + 0.5) / 193.0).rg * 0.4;
            float cT = cq.x + cq.y;
            if (cT > 0.004 && dens(vW - vec3(0.0, cT, 0.0)) > 0.0) {
              capCv = 1.0; capAsh = cq.y / cT;
              for (int k = 1; k <= 8; k++) { if (dens(vW + vec3(0.0, float(k) * 0.5, 0.0)) > 0.0) { capCv = 0.0; break; } }
            }
          }
          if (!deepR && ((d0 <= 0.0 && !capLava && capCv < 0.5) || vW.y < 0.02)) discard;
          // .r has 4 cells per tile: at 0.11-0.13 /m that is ~2 m features; .g (16 cells) adds a little ~1 m wobble
          // (C1: 3D noise at the world point, so the boundary wobble stays under the worm and morphs further out)
          vec2 jn = vec2(n3(vW * vec3(0.11, 0.13, 0.11)).r, n3(vW * vec3(0.13, 0.11, 0.13) + vec3(0.5, 0.3, 0.7)).r) - 0.5;
          jn += (vec2(n3(vW * vec3(0.031, 0.037, 0.031)).g, n3(vW * vec3(0.037, 0.031, 0.037) + vec3(0.4, 0.7, 0.2)).g) - 0.5) * 0.45;
          vec3 jp = vW + vec3(dW.x, 0.0, dW.y) * jn.x * 0.9 + vec3(0.0, jn.y * 0.8, 0.0);
          vec3 gg = jp / 0.5;
          ivec3 vmax = ivec3(uVolSize) - 1;
          float Wm[17];            // materials 1-16 (13 girder steel, 14 foam, 15 concrete, 16 obsidian: their own cap colours, capCol)
          for (int i = 0; i < 17; i++) Wm[i] = 0.0;
          float hs = 0.0, hw = 0.0;
          if (!outL && !deepR) {                         // (beyond the lattice the clamped volume would smear the border)
        #ifdef CAP_BSPLINE
          ivec3 c = ivec3(floor(gg + 0.5)); vec3 f = gg - vec3(c);
          vec3 wa = 0.5 * (0.5 - f) * (0.5 - f), wb = 0.75 - f * f, wc = 0.5 * (0.5 + f) * (0.5 + f);
          for (int q = 0; q < 27; q++) {
            ivec3 oq = ivec3(q % 3, (q / 3) % 3, q / 9) - 1;
            vec2 tv = texelFetch(tVol, clamp(c + oq, ivec3(0), vmax), 0).rg;
            int g = int(tv.g + 0.5), mq = g & 31;
            if (mq == 0 || mq > 16 || tv.r <= 0.0) continue;
            float w = (oq.x < 0 ? wa.x : oq.x == 0 ? wb.x : wc.x) * (oq.y < 0 ? wa.y : oq.y == 0 ? wb.y : wc.y) * (oq.z < 0 ? wa.z : oq.z == 0 ? wb.z : wc.z) + 1e-4;
            Wm[mq] += w; hs += float(g >> 5) * w; hw += w;
          }
        #else
          ivec3 b = ivec3(floor(gg)); vec3 fr = fract(gg);
          for (int q = 0; q < 8; q++) {
            ivec3 oq = ivec3(q & 1, (q >> 1) & 1, q >> 2);
            vec2 tv = texelFetch(tVol, clamp(b + oq, ivec3(0), vmax), 0).rg;
            int g = int(tv.g + 0.5), mq = g & 31;
            if (mq == 0 || mq > 16 || tv.r <= 0.0) continue;
            vec3 t = vec3(oq);
            float w = mix(1.0 - fr.x, fr.x, t.x) * mix(1.0 - fr.y, fr.y, t.y) * mix(1.0 - fr.z, fr.z, t.z) + 1e-3;
            Wm[mq] += w; hs += float(g >> 5) * w; hw += w;
          }
        #endif
          }
          // D5: the far layering (RULES.desert from the strip) at the jittered point, blended in over the last metre
          // inside the border (k: 0 on / beyond the border -> 1 one metre inside)
          if (farOn && eB < 1.0) {
            float k = outL ? 0.0 : smoothstep(0.0, 1.0, eB), ws = 0.0;
            for (int i = 1; i < 17; i++) ws += Wm[i];
            float nv = ws > 0.0 ? k / ws : 0.0;
            for (int i = 1; i < 17; i++) Wm[i] *= nv;
            vec4 fj = farAt(dot(jp.xz, dW));
            float wS = smoothstep(fj.y - 0.3, fj.y + 0.3, jp.y), wD = 1.0 - smoothstep(fj.z - 0.3, fj.z + 0.3, jp.y), wBd = 1.0 - smoothstep(0.7, 1.3, jp.y), o = 1.0 - k;
            Wm[4] += o * wS; Wm[5] += o * (1.0 - wS) * (1.0 - wD); Wm[2] += o * (1.0 - wS) * wD * (1.0 - wBd); Wm[1] += o * (1.0 - wS) * wD * wBd;
          }
          if (deepR) Wm[1] = 1.0;                        // the deep body: bedrock (charcoal basalt on a volcanic island)
          int m1 = 2, m2 = 2; float w1 = -1.0, w2 = -1.0;
          for (int i = 1; i < 17; i++) { float v = Wm[i]; if (v > w1) { w2 = w1; m2 = m1; w1 = v; m1 = i; } else if (v > w2) { w2 = v; m2 = i; } }
          float heat = hw > 0.0 ? hs / hw / 15.0 : 0.0;
          { float ws = 0.0; for (int i = 1; i < 17; i++) ws += Wm[i]; gLava = Wm[9] / max(ws, 1e-4); }
          // depth below the nearest air above (march up the column)
          float depthB = 6.0;
          if (deepR) depthB = 6.0;
          else if (outL) depthB = clamp(fl.x - vW.y, 0.0, 6.0);
          else for (int k = 1; k <= 12; k++) { if (dens(vW + vec3(0.0, float(k) * 0.5, 0.0)) <= 0.0) { depthB = float(k) * 0.5 - 0.25; break; } }
        `)
        .replace('#include <map_fragment>', /* glsl */`
          float nb = n3(vW * vec3(0.21, 0.09, 0.21)).b, nz = n3(vW * vec3(0.05, 0.02, 0.05)).g;
          float warp = (n3(vW * vec3(0.012, 0.0, 0.012) + vec3(0.0, 0.37, 0.0)).a - 0.5) * 3.5 + (nz - 0.5) * 0.6;
          vec2 pu = vec2(tau, vW.y);
          vec3 strata = texM(vec2(tau, vW.y + warp), vec2(0.11, 0.085), 14.0, vec2(1.0, 0.0)) * mix(vec3(0.92), vec3(1.08), nb);
          float dd = depthB + (nb - 0.5) * 0.25;
          vec4 sf = outL || deepR ? vec4(0.0) : texture(tSurf, (vW.xz * 2.0 + 0.5) / 193.0);
          vec3 e1, e2;
          vec3 col = capCol(m1, pu, strata, dd, sf, heat, e1);
          float tb = w2 > 0.0 ? smoothstep(-0.24, 0.24, (w2 - w1) / (w1 + w2) + (n3(vW * vec3(0.09, 0.1, 0.09) + float(m2) * 0.37).r - n3(vW * vec3(0.09, 0.1, 0.09) + float(m1) * 0.37).r) * 0.25) : 0.0;
          if (tb > 0.002) col = mix(col, capCol(m2, pu, strata, dd, sf, heat, e2), tb); else e2 = vec3(0.0);
          vec3 cEmis = mix(e1, e2, tb);
          col *= mix(1.0, 0.68, smoothstep(1.0, 8.0, dd));                                // deeper = darker
          col *= mix(1.0, 0.42, smoothstep(0.0, 70.0, -vW.y));                           // P29a: the deep body fades darker
          col *= mix(1.0, 0.62, (1.0 - smoothstep(uSea - 1.0, uSea + 0.3, vW.y)));               // waterlogged base
          col = mix(col, vec3(0.05, 0.045, 0.04), sf.b * (1.0 - smoothstep(0.0, 0.35, dd)) * 0.8); // charred surface
          if (capLava) { float skinF; cEmis = lavaSection(pu, cLv.r - vW.y, vW.y - cLv.a, cLv.b, skinF); col = vec3(0.034, 0.03, 0.028) * skinF; }
          if (capCv > 0.5) { col = mix(vec3(0.84, 0.87, 0.93) * (0.92 + 0.12 * nb), vec3(0.085, 0.08, 0.078) * (0.8 + 0.4 * nb), smoothstep(0.4, 0.6, capAsh)); cEmis = vec3(0.0); }
          diffuseColor.rgb = col;
        `)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += cEmis;')
        // the cut face is an open section (nothing is drawn in front of it): light it from the sun's side of the
        // plane with a slight upward tilt (uCapN), so it reads the same whether the sun is in front or behind
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n normal = normalize((viewMatrix * vec4(uCapN, 0.0)).xyz);');
      sh.fragmentShader = 'uniform vec3 uCapN;\n' + sh.fragmentShader;
    };
    m.customProgramCacheKey = () => bspline ? 'cap5b' : 'cap5';
    return m;
  }

  TR.init = function (sc, textures, quality) {
    scene = sc; tx = textures; Q = quality;
    const W = SS.world;
    Object.assign(U, {
      tMats: { value: tx.mats }, tNoise: { value: tx.noise }, tSurf: { value: null }, tWater: { value: null },
      tLavaS: { value: null }, tCover: { value: null }, uDbgBack: { value: 0 },   // tools: 1 body / 2 all slab back faces magenta
      uCtxSolid: { value: 0 },  // D3: 1 = far context opaque, no ghost haze (dry worlds; set by view.js newWorld)
      uCtxHaze: { value: 1 },   // P29j: the slice-view setting: 1 (thin / thick) = the landscape behind the slab recedes into haze; 0 (full) = crisp
      uO: { value: new T.Vector3() }, uN: { value: new T.Vector3(0, 0, 1) }, uHaze: { value: new T.Color(0xf3d2b0) },
      uGrassTint: { value: new T.Color(1, 1, 1) }, uDryTint: { value: new T.Color(1, 1, 1) }, uSunDir: { value: new T.Vector3(0, 1, 0) },
      uHalf: { value: C.HALF }, uBack: { value: C.HALF }, uAlpha: { value: 0 }, uTime: { value: 0 }, uSea: { value: W.SEA }, uWaterTex: { value: 0 }, uWet: { value: 0 }, uSnow: { value: 0 },
      uCaustic: { value: 1 }, uDetail: { value: Q.detail ? 1 : 0 }, uPlayR: { value: 0 }, uVolc: { value: 0 },
      uLatR: { value: new T.Vector3(48, 48, 0) },   // D6: dry worlds' lattice disc (x, z, r; r 0 = off, set per frame)
      uMatP: { value: MATP.map(p => new T.Vector4(p[0], p[1], p[2], p[3])) },
      uMatTint: { value: TINT.map(c => new T.Vector3(c[0], c[1], c[2])) },
      uRelief: { value: RELIEF.map(c => new T.Vector4(c[0], c[1], c[2], c[3])) }, tRel: { value: tx.noise3 }, uGlint: { value: GLINT.slice() }
    });
    // 3D world texture RG16F: R = density (raw, linear filtering = the sim's trilinear W.sample; 8-bit put the cap's
    // edge up to 15 cm off the collision line, O1), G = material | heat << 5 as an integer (texelFetch; P31: 5 material bits for obsidian, 16)
    volData = new Uint16Array(W.N * 2);
    volTex = new T.Data3DTexture(volData, W.NX, W.NY, W.NZ);
    volTex.format = T.RGFormat; volTex.type = T.HalfFloatType; volTex.unpackAlignment = 1;
    volTex.minFilter = volTex.magFilter = T.LinearFilter; volTex.wrapS = volTex.wrapT = volTex.wrapR = T.ClampToEdgeWrapping;
    volTex.generateMipmaps = false; volTex.needsUpdate = true;
    slabMat = terrainMaterial(0); ctxFar = terrainMaterial(1); ctxPre = terrainMaterial(2); ctxNear = terrainMaterial(3);
    bodyMats = { slab: terrainMaterial(0, true), far: terrainMaterial(1, true), pre: terrainMaterial(2, true), near: terrainMaterial(3, true) };
    slabDepth = slabDepthMaterial();
    farData = new Float32Array(FAR_N * 4);
    FAR.tFar.value = new T.DataTexture(farData, FAR_N, 1, T.RGBAFormat, T.FloatType);
    FAR.tFar.value.minFilter = FAR.tFar.value.magFilter = T.NearestFilter; FAR.tFar.value.needsUpdate = true;
    FAR.uFar.value = new T.Vector4(0, 1, FAR_N, 0); FAR.uLat.value = new T.Vector2(W.SX, W.SZ);
    CAPU.tN3.value = tx.noise3;
    capMat = capMaterial();
    capN.value = new T.Vector3(0, 0, 1);
    cap = new T.Mesh(new T.PlaneGeometry(1, 1), capMat); cap.frustumCulled = false; scene.add(cap);   // no shadows: open section
    // (user 2026-10-08: buried lava must NOT glow through the rock: the old 'lava x-ray' sprites are gone; lava shows
    //  where it is open or cut by the section)
  };
  TR.dispose = function () {
    chunks.forEach((c, ci) => { if (c) { for (const m of c.meshes) scene.remove(m); c.geo.dispose(); if (TR.onChunk) TR.onChunk(ci, null); } });
    chunks = [];
  };

  /* ---------- volume texture ---------- */
  /* float -> IEEE half (round to nearest; |v| < 65504, subnormals kept): C would use _cvtss_sh / a cast to _Float16 */
  const hF = new Float32Array(1), hU = new Uint32Array(hF.buffer), HALF_INT = new Uint16Array(512);
  function toHalf(v) {
    hF[0] = v; const x = hU[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112;
    let m = x & 0x7fffff;
    if (e <= 0) { if (e < -10) return sign; m = (m | 0x800000) >>> (1 - e); return sign | ((m + 0x1000) >>> 13); }
    if (e >= 31) return sign | 0x7c00;
    return sign | ((e << 10) + ((m + 0x1000) >>> 13));
  }
  for (let q = 0; q < 512; q++) HALF_INT[q] = toHalf(q);
  function packBox(i0, j0, k0, i1, j1, k1) {
    const W = SS.world, D = W.d, Mt = W.mat, Ht = W.heat;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      let o = (k * W.NY + j) * W.NX + i0;
      for (let i = i0; i <= i1; i++, o++) {
        volData[o * 2] = toHalf(D[o]);
        volData[o * 2 + 1] = HALF_INT[Mt[o] | ((Ht[o] >> 4) << 5)];
      }
    }
  }
  TR.toHalf = toHalf;
  function uploadVolumeBox(renderer, b) {
    const W = SS.world;
    packBox(b.i0, b.j0, b.k0, b.i1, b.j1, b.k1);
    const props = renderer.properties.get(volTex), gl = renderer.getContext();
    if (!props.__webglTexture || !gl.texSubImage3D) { volTex.needsUpdate = true; return; }
    renderer.state.bindTexture(gl.TEXTURE_3D, props.__webglTexture);
    // Three leaves UNPACK_FLIP_Y / PREMULTIPLY_ALPHA from its last 2D upload; both are invalid for 3D uploads
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W.NX); gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, W.NY);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, b.i0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, b.j0); gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, b.k0);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, b.i0, b.j0, b.k0, b.i1 - b.i0 + 1, b.j1 - b.j0 + 1, b.k1 - b.k0 + 1, gl.RG, gl.HALF_FLOAT, volData);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0); gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
  }

  /* ---------- chunks ---------- */
  function buildChunk(ci) {
    const W = SS.world, cx = ci % W.CX, cy = Math.floor(ci / W.CX) % W.CY, cz = Math.floor(ci / (W.CX * W.CY));
    const m = SS.meshgen.chunk(cx, cy, cz);
    let c = chunks[ci];
    if (!m.idx.length) {
      if (c) { for (const mm of c.meshes) scene.remove(mm); c.geo.dispose(); chunks[ci] = null; if (TR.onChunk) TR.onChunk(ci, null); }
      return { ver: W.chunkVer[ci], empty: true };
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(m.pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(m.nrm, 3));
    g.setAttribute('mA', new T.BufferAttribute(m.mA, 4, true));
    g.setAttribute('mB', new T.BufferAttribute(m.mB, 4, true));
    g.setAttribute('mC', new T.BufferAttribute(m.mC, 4, true));
    g.setAttribute('mD', new T.BufferAttribute(m.mD || new Uint8Array(m.mC.length), 4, true));
    g.setAttribute('depth', new T.BufferAttribute(m.depth, 1));
    g.setIndex(new T.BufferAttribute(m.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    if (!c) {
      const slab = new T.Mesh(g, slabMat); slab.castShadow = true; slab.receiveShadow = true; slab.customDepthMaterial = slabDepth;
      const pre = new T.Mesh(g, ctxPre); pre.renderOrder = 4;
      const far = new T.Mesh(g, ctxFar); far.renderOrder = 5;
      const near = new T.Mesh(g, ctxNear); near.renderOrder = 7;
      c = chunks[ci] = { meshes: [slab, pre, far, near], slab, pre, far, near, geo: g };
      scene.add(slab, pre, far, near);
    } else {
      c.geo.dispose(); c.geo = g;
      for (const mm of c.meshes) mm.geometry = g;
    }
    c.ver = W.chunkVer[ci]; c.tris = m.idx.length / 3; c.data = m;
    c.box = g.boundingBox;
    if (TR.onChunk) TR.onChunk(ci, c);
    return c;
  }
  const built = [];
  /* full build at load (async, reports progress) */
  TR.buildAll = async function (renderer, onProgress) {
    const W = SS.world, n = W.CX * W.CY * W.CZ;
    TR.dispose();
    built.length = n;
    packBox(0, 0, 0, W.NX - 1, W.NY - 1, W.NZ - 1); volTex.needsUpdate = true;
    let t0 = performance.now();
    for (let ci = 0; ci < n; ci++) {
      const c = buildChunk(ci); built[ci] = c.ver;
      if (performance.now() - t0 > 40) { onProgress && onProgress((ci + 1) / n); await new Promise(r => setTimeout(r, 0)); t0 = performance.now(); }
    }
    W.dirtyBox = null;
    onProgress && onProgress(1);
  };
  TR.chunks = () => chunks;
  /* per frame: remesh changed chunks under a time budget, slab chunks first */
  TR.update = function (renderer, S, dt, budgetMs) {
    const W = SS.world, n = W.CX * W.CY * W.CZ;
    if (W.dirtyBox) { uploadVolumeBox(renderer, W.dirtyBox); W.dirtyBox = null; }
    const t0 = performance.now(), n0 = SS.plane.nrm(S);
    const order = [];
    for (let ci = 0; ci < n; ci++) if (built[ci] !== W.chunkVer[ci]) order.push(ci);
    if (order.length) {
      const pr = ci => { const c = chunks[ci]; if (!c || !c.box) return 1; return slabHits(c.box, S, n0) ? 0 : 1; };
      order.sort((a, b) => pr(a) - pr(b));
      for (const ci of order) {
        const c = buildChunk(ci); built[ci] = c.ver;
        if (performance.now() - t0 > budgetMs) break;
      }
    }
    // visibility: slab only for chunks that intersect the band
    for (const c of chunks) if (c) c.slab.visible = slabHits(c.box, S, n0);
    U.uO.value.set(S.O.x, 0, S.O.z); U.uN.value.set(n0.x, 0, n0.z);
    { const c = W.circ; U.uLatR.value.set(c ? c.x : 48, c ? c.z : 48, c ? c.r : 0); }
    // cap plane at slice zero (t = -0.002); dry worlds: out to FAR_S m beyond the lattice exits (D5 far strip)
    const d = SS.plane.dir(S), r = W.dry && SS.worldgen.far_layers ? buildFar(S, d) : SS.plane.range(S);
    // C1: a new pivot on the same plane (rotate_by re-centres O on the worm) must not shift the face's texture:
    // uS0 += (O' − O)·d keeps τ = s + uS0 of every face point; turning about a fixed O leaves τ alone
    if (capPivot && (capPivot.x !== S.O.x || capPivot.z !== S.O.z)) CAPU.uS0.value += (S.O.x - capPivot.x) * d.x + (S.O.z - capPivot.z) * d.z;
    capPivot = { x: S.O.x, z: S.O.z };
    if (!W.dry) FAR.uFar.value.w = 0;
    // P29a: down to CAP_DEEP below the lattice floor; wet worlds also CAP_EXT beyond the lattice exits (rock under the sea)
    const ext = W.dry ? 0 : CAP_EXT, mid = (r[0] + r[1]) / 2, L = r[1] - r[0] + 2 * ext;
    cap.position.set(S.O.x + d.x * mid - n0.x * 0.002, (W.SY - CAP_DEEP) / 2, S.O.z + d.z * mid - n0.z * 0.002);
    cap.scale.set(L, W.SY + CAP_DEEP, 1);
    cap.rotation.set(0, Math.atan2(n0.x, n0.z), 0);
    { const L = U.uSunDir.value, sd = n0.x * L.x + n0.z * L.z >= 0 ? 1 : -1; capN.value.set(n0.x * sd, 0.35, n0.z * sd).normalize(); }
  };
  /* D5: the far strip along the section (dry worlds), rebuilt when the section moves; returns the cap's [s0, s1] */
  const farO = [0, 0];
  function buildFar(S, d) {
    const W = SS.world, G = SS.worldgen, key = S.O.x + ',' + S.O.z + ',' + S.theta + ',' + W.SX;
    if (key === farKey && farRange) return farRange;
    let sA = -1e9, sB = 1e9;
    for (const [o, v, Lx] of [[S.O.x, d.x, W.SX], [S.O.z, d.z, W.SZ]]) {
      if (Math.abs(v) < 1e-9) continue;
      const a = -o / v, b = (Lx - o) / v; sA = Math.max(sA, Math.min(a, b)); sB = Math.min(sB, Math.max(a, b));
    }
    if (sA > sB) sA = sB = 0;                              // D6: the line misses the lattice: around the worm only
    sA = Math.min(sA, 0); sB = Math.max(sB, 0);              // (and always covering the rotation centre)
    const s0 = sA - FAR_S, s1 = sB + FAR_S, ds = (s1 - s0) / (FAR_N - 1);
    for (let i = 0; i < FAR_N; i++) {
      const s = s0 + i * ds; G.far_layers(S.O.x + d.x * s, S.O.z + d.z * s, farO);
      farData[i * 4] = farO[0]; farData[i * 4 + 1] = farO[0] - farO[1] - G.SAND_EXTRA; farData[i * 4 + 2] = farO[0] - G.ROCK_DV; farData[i * 4 + 3] = 1;
    }
    FAR.tFar.value.needsUpdate = true;
    FAR.uFar.value.set(S.O.x * d.x + S.O.z * d.z + s0, ds, FAR_N, 1);
    farKey = key; farRange = [s0, s1];
    return farRange;
  }
  TR.capMesh = () => cap;                                  // (tools: hide the section face)
  function slabHits(box, S, n0) {
    if (!box) return false;
    let lo = 1e9, hi = -1e9;
    for (let q = 0; q < 4; q++) {
      const x = q & 1 ? box.max.x : box.min.x, z = q & 2 ? box.max.z : box.min.z, t = (x - S.O.x) * n0.x + (z - S.O.z) * n0.z;
      lo = Math.min(lo, t); hi = Math.max(hi, t);
    }
    return lo <= 0.5 && hi >= -U.uBack.value - 0.5;
  }
  /* per frame visual uniforms */
  TR.frame = function (S, view, ctxA, inspect) {
    U.uTime.value = view.time;
    U.uAlpha.value = ctxA;
    U.uVolc.value = S.biome === 'volcanic' ? 1 : 0;          // volcanic island: the deep bedrock is black basalt too
    // far context only exists beyond the slab; near context (in front of slice zero) only while inspecting
    const far = ctxA > 0.004 && U.uBack.value < 200;
    for (const c of chunks) if (c) { c.pre.visible = c.far.visible = far; c.near.visible = inspect > 0.05 && Q.nearCtx; }
  };
  TR.stats = () => ({ chunks: chunks.filter(Boolean).length, tris: chunks.reduce((s, c) => s + (c ? c.tris : 0), 0), slabChunks: chunks.filter(c => c && c.slab.visible).length });
  /* how far behind slice zero the slab stays solid (m); >= 200 = everything behind */
  TR.setBack = function (m) { U.uBack.value = m; };
  TR.vol = () => volTex;                     // 3D density + material texture (render/water.js: the aquarium face skips rock)
  TR.slabMaterial = () => slabMat;
  TR.capN = capN;                                // debug/tests
  TR.ctxMaterial = () => ctxFar;
  TR.slabDepthMaterial = () => slabDepth;
  TR.ctxPreMaterial = () => ctxPre;
  TR.ctxNearMaterial = () => ctxNear;
  TR.bodyMaterials = () => bodyMats;     // {slab, far, pre, near}: chunk-body variants (need a 'tpos' attribute)
  TR.nearCtx = () => !!Q.nearCtx;
})(window.SS = window.SS || {});
