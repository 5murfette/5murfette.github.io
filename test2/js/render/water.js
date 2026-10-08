/* render/water.js — the simulated sea (sim/water.js) on screen (Three.js specific).
 *   - data texture tW (193 x 193 float RGBA, one texel per lattice column): r = water surface y (wet) or bed − 5 cm
 *     (dry, so the mesh dives under the beach and the shoreline is the exact intersection with the terrain),
 *     g = depth h, b = foam (render-side: fast water, blasts, splashes; decays; stored as −1 − foam for inland water
 *     not connected to the sea, S.water.sea = 0, and −1 on the dry banks around it: a still pool gets no swash
 *     foam and its own murky colour), a = wetness (1 while wet, then
 *     dries over WET_T seconds: dark run-up band on the terrain; groundwater seep columns, S.water.seep, ease to
 *     DAMP over DAMP_T s: a pit dug below the water table looks damp before the first water seeps in).
 *     Refilled whenever the simulation stepped.
 *     Also bound to the terrain as tWater (wet band, under-water tint and caustics follow the real surface);
 *   - inner grid: one vertex per column (or every second on low quality), displaced from tW in the vertex shader,
 *     normal from the simulated surface + procedural ripples; Fresnel sky reflection, sun specular, depth colour,
 *     shore / crest / simulated foam; eased to SEA along the map border, where the outer ocean plane (flat, deep,
 *     to the horizon) takes over;
 *   - the same rule as the terrain: nothing in front of slice zero (during inspection it fades in), so the collision
 *     section is never hidden. The cut through the water at slice zero is an aquarium face: from the rock (terrain
 *     cap, via the 3D density texture) up to the simulated surface, depth colour, sun shafts, a bright meniscus.
 * Porting: tW = a float texture updated per tick; the grid = a displaced plane (vertex texture fetch); the face =
 *   a camera-independent quad on the section plane with a density lookup. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const WV = SS.waterView = {};
  const N1 = 193, WETH = 0.004, WET_T = 9, FOAM_T = 2.6, DAMP = 0.9, DAMP_T = 2.5;
  let ms = 0, scene, tx, Q, U, tex, data, foam, wetA, grid, outer, face, gridMat, outerMat, faceMat, stateRef = null, ver = -1, lastT = 0;
  const own = {
    tW: { value: null }, tSky: { value: null }, tEnv: { value: null }, uEnv: { value: 0 }, uSun: { value: new T.Vector3(0.5, 0.6, 0.3).normalize() },
    uHorizon: { value: new T.Color(0xf6c89a) }, uDeep: { value: new T.Color(0x0d3a5c) }, uShallow: { value: new T.Color(0x2fa7a8) },
    uFog: { value: new T.Color(0xf3d2b0) }, uFogD: { value: 0.0026 }, uInsp: { value: 0 }, uWTime: { value: 0 }, uRain: { value: 0 },
    tShelf: { value: null },
    uRing: { value: [0, 1, 2, 3, 4, 5].map(() => new T.Vector4(0, 0, -99, 0)) }   // P29l: open-sea ring waves (x, z, start time, strength)
  };
  let ringN = 0;
  /* LS1 island shelf: the lattice sea is at most SEA (3 m) deep over a flat floor, the outer plane is the open ocean;
   * shading both by their real depth drew the lattice square on the sea (a light 3 m-deep floor inside, deep water
   * outside). Real islands: a turquoise shelf a few metres off the beach, then the slope drops to deep blue. Colour and
   * opacity use an APPARENT depth = real depth + SHELF_D·smoothstep(1.5, 12, coast distance·noise) (+ a ramp to deep
   * over the last 3 m before the lattice border); the outer plane starts at that deep value, opaque: no square. */
  const SHELF_D = 7, SHELF_T = 1;   // m extra apparent depth off the shelf; s between rebuilds of the coast distance
  let shelf = null, shelfTex = null, shelfT = -9, shelfD = null;
  const FOG_D = 0.0026;

  /* shared surface shading (inner grid and outer ocean) */
  const SURF = /* glsl */`
    uniform sampler2D tNoise, tSky; uniform samplerCube tEnv; uniform float uEnv, uWTime, uSea, uFogD, uInsp, uRain; uniform vec3 uSun, uHorizon, uDeep, uShallow, uFog, uO, uN;
    uniform vec4 uRing[6];
    // P29l (user 2026-10-08: "hitting water just outside the island makes no splash, no wave"): the open sea beyond the
    // simulated lattice has no wave field, so a splash / water blast there starts an expanding ring wave: a wave train
    // behind a front moving at ~5 m/s, decaying with age and radius; returns the slope (normal) and a crest-foam share
    vec3 seaRings(vec2 p){
      vec3 g = vec3(0.0);
      for (int i = 0; i < 6; i++){
        vec4 R = uRing[i]; float age = uWTime - R.z;
        if (age < 0.0 || age > 9.0 || R.w <= 0.0) continue;
        vec2 d = p - R.xy; float r = length(d), x = r - age * 5.0;
        if (x > 0.5 || x < -9.0) continue;
        float env = R.w * exp(-age * 0.35) * exp(x * 0.35) / (1.0 + r * 0.15) * smoothstep(0.5, 0.0, x);
        float s = cos(x * 2.4) * env;
        g.xy += d / max(r, 1e-3) * s;
        g.z = max(g.z, env * smoothstep(0.6, 1.0, sin(x * 2.4 + 1.57)) * smoothstep(-2.5, 0.0, x));
      }
      return g;
    }
    // rain rings (5e): three hashed cell layers (~0.25-0.4 m), one drop per active cell per cycle; the share of active
    // cells follows the rain intensity; returns the slope of the expanding ripple (normal perturbation)
    vec2 rainRings(vec2 p, float t){
      vec2 g = vec2(0.0);
      for (int l = 0; l < 3; l++){
        float sc = 2.6 + float(l) * 1.1;
        vec2 q = p * sc + vec2(float(l) * 3.7, float(l) * 1.3), c = floor(q), f = fract(q);
        vec3 h = fract(sin(vec3(dot(c, vec2(127.1, 311.7)), dot(c, vec2(269.5, 183.3)), dot(c, vec2(419.2, 371.9)))) * 43758.5453);
        float cyc = t * (0.9 + 0.4 * h.y) + h.z, ph = fract(cyc);
        if (fract(h.x * 7.13 + floor(cyc) * 0.618) > uRain * 0.85) continue;
        vec2 d = f - (0.3 + 0.4 * h.xy);
        float r = length(d), w = r - ph * 0.55;
        float a = (1.0 - ph) * (1.0 - ph) * exp(-w * w * 500.0) * sin(w * 70.0);
        g += d / max(r, 1e-3) * a;
      }
      return g;
    }
    varying vec3 vW; varying vec3 vNg; varying vec4 vD;
    float hgt(vec2 p){
      return texture2D(tNoise, p*0.045 + vec2(uWTime*0.010, uWTime*0.006)).a * 0.6
           + texture2D(tNoise, p*0.11 - vec2(uWTime*0.017, -uWTime*0.012)).a * 0.3
           + texture2D(tNoise, p*0.33 + vec2(-uWTime*0.03, uWTime*0.025)).g * 0.1;
    }
    vec4 shade(float depth, float foamS, float dA){          // dA: apparent depth (colour / opacity; LS1 shelf)
      float tD = dot(vW - uO, uN);
      if (tD > 0.0 && uInsp < 0.02) discard;                 // nothing in front of slice zero (inspection fades it in)
      if (depth < 0.006) discard;
      float inl = clamp(-foamS, 0.0, 1.0);                   // inland still water (foam channel stored as -1 - foam)
      foamS = max(foamS, 0.0) + max(-1.0 - foamS, 0.0);
      vec2 p = vW.xz; float e = 0.12;
      float h0 = hgt(p), hx = hgt(p + vec2(e, 0.0)), hz = hgt(p + vec2(0.0, e));
      float amp = 2.2 * smoothstep(0.0, 0.5, depth);         // ripples calm down in the shallows
      vec3 n = normalize(vNg + vec3((h0 - hx) * amp, 0.0, (h0 - hz) * amp));
      if (uRain > 0.01) { vec2 rr = rainRings(p, uWTime) * 0.45 * smoothstep(0.01, 0.15, depth); n = normalize(n + vec3(rr.x, 0.0, rr.y)); }
      vec3 rg = seaRings(p); n = normalize(n + vec3(rg.x, 0.0, rg.y) * 0.9);
      vec3 V = normalize(cameraPosition - vW);
      vec3 col = mix(mix(uShallow, uDeep, smoothstep(0.3, 4.5, dA)), mix(vec3(0.05, 0.048, 0.04), vec3(0.018, 0.026, 0.028), smoothstep(0.1, 1.5, depth)), inl);
      float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
      vec3 R = reflect(-V, n);
      // K2: the procedural sky-view LUT (render/sky.js: azimuth x elevation, rows packed toward the horizon; no mips)
      float rel = asin(clamp(R.y, 0.0, 1.0));
      vec3 refl = uEnv > 0.5 ? textureCube(tEnv, vec3(R.x, max(R.y, 0.002), R.z)).rgb   // K2e: sky + clouds (cube, render/sky.js)
                             : texture2D(tSky, vec2(atan(R.z, R.x) / 6.2831853 + 0.5, 0.5 + 0.5 * sqrt(rel / 1.5707963))).rgb;
      refl = mix(refl, uHorizon, 0.25);
      col = mix(col, refl, mix(0.08, 0.03, inl) + 0.72 * fres);
      vec3 H = normalize(uSun + V);
      float nh = max(dot(n, H), 0.0);
      col += vec3(1.0, 0.86, 0.66) * (pow(nh, 260.0) * 3.0 + pow(nh, 40.0) * 0.12);
      // foam: shore band (moving lines), the thin run-up film, simulated foam (fast water, blasts), steep crests
      float fn = texture2D(tNoise, p * 0.5 + uWTime * 0.03).b;
      float band = 0.5 + 0.5 * sin(depth * 9.0 - uWTime * 1.7 + fn * 4.0);
      float foam = (1.0 - smoothstep(0.0, 0.7, depth)) * smoothstep(0.35, 0.9, band * 0.6 + fn * 0.6);
      foam = max(foam, (1.0 - smoothstep(0.01, 0.07, depth)) * 0.75) * (1.0 - inl);       // swash: the sea only
      // simulated foam (blasts, fast water) as a lace: dense with holes while fresh, breaking into streaks as it fades
      float lace = fn * 0.6 + texture2D(tNoise, p * 1.9 - uWTime * 0.05).g * 0.5, fq = min(foamS, 1.5);
      foam = max(foam, smoothstep(0.05, 0.5, foamS) * smoothstep(0.78 - fq * 0.32, 0.98 - fq * 0.28, lace));
      foam = max(foam, (1.0 - smoothstep(0.82, 0.93, vNg.y)) * smoothstep(0.35, 0.75, fn));
      foam = max(foam, min(1.0, rg.z * 1.6) * smoothstep(0.25, 0.65, fn + 0.3));            // ring-wave crests
      col = mix(col, vec3(0.97, 0.98, 1.0), foam * 0.85);
      float a = smoothstep(0.006, 0.05, depth) * mix(mix(0.64, 0.93, smoothstep(0.0, 3.0, dA)), 1.0, smoothstep(4.0, 9.0, dA));
      a = mix(a, smoothstep(0.006, 0.06, depth) * mix(0.4, 0.9, smoothstep(0.0, 1.2, depth)), inl);   // a puddle shows its floor
      a = max(a, foam * smoothstep(0.006, 0.03, depth));
      if (tD > 0.0) a *= uInsp * 0.85;                       // inspection: the 3D overview shows the sea in front too
      float fd = length(cameraPosition - vW);
      // P29f: the distance fog goes to the real sky colour at the horizon in this direction (the fixed warm haze was
      // far brighter than the horizon: the near sea read as a bright layer under the far ocean / islands)
      vec3 Lk = normalize(vW - cameraPosition);
      vec3 hzSky = texture2D(tSky, vec2(atan(Lk.z, Lk.x) / 6.2831853 + 0.5, 0.5)).rgb;   // (the LUT, as render/farland.js: no seam)
      col = mix(col, mix(uFog, hzSky, 0.9) * 0.93, 1.0 - exp(-fd * fd * uFogD * uFogD));   // (a touch darker than the sky: a real sea horizon)
      return vec4(col, a);
    }
  `;
  const TAIL = `
    #include <tonemapping_fragment>
    #include <colorspace_fragment>`;

  function makeGrid(step) {
    const n = Math.floor((N1 - 1) / step) + 1, pos = new Float32Array(n * n * 3), idx = [];
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) { const o = (k * n + i) * 3; pos[o] = i * step * 0.5; pos[o + 2] = k * step * 0.5; }
    for (let k = 0; k < n - 1; k++) for (let i = 0; i < n - 1; i++) { const a = k * n + i, b = a + 1, c = a + n, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setIndex(idx);
    g.boundingSphere = new T.Sphere(new T.Vector3(48, 3, 48), 80);
    return g;
  }

  WV.init = function (sc, textures, quality, renderer) {
    scene = sc; tx = textures; Q = quality; U = SS.terrain.uniforms;
    const N = N1 * N1;
    data = new Float32Array(N * 4); foam = new Float32Array(N); wetA = new Float32Array(N);
    tex = new T.DataTexture(data, N1, N1, T.RGBAFormat, T.FloatType);
    const lin = !renderer || renderer.extensions.has('OES_texture_float_linear');
    tex.minFilter = tex.magFilter = lin ? T.LinearFilter : T.NearestFilter;
    tex.wrapS = tex.wrapT = T.ClampToEdgeWrapping; tex.generateMipmaps = false; tex.needsUpdate = true;
    own.tW.value = tex; own.tSky.value = tx.skies && tx.skies.sky ? tx.skies.sky.tex : null;   // (K2: set by look())
    WV.texture = tex;
    shelf = new Uint8Array(N1 * N1); shelfD = new Float32Array(N1 * N1);
    shelfTex = new T.DataTexture(shelf, N1, N1, T.RedFormat, T.UnsignedByteType);
    shelfTex.minFilter = shelfTex.magFilter = T.NearestFilter; shelfTex.generateMipmaps = false; shelfTex.needsUpdate = true;
    own.tShelf.value = shelfTex;
    const shared = () => Object.assign({}, own, { tNoise: U.tNoise, uSea: U.uSea, uO: U.uO, uN: U.uN, uBack: U.uBack, uAlpha: U.uAlpha });

    // inner grid
    gridMat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, uniforms: shared(),
      vertexShader: /* glsl */`
        uniform highp sampler2D tW; uniform sampler2D tShelf; uniform float uSea;
        varying vec3 vW; varying vec3 vNg; varying vec4 vD; varying vec2 vSh;
        float lvl(ivec2 q, float own){ q = clamp(q, ivec2(0), ivec2(${N1 - 1})); vec4 d = texelFetch(tW, q, 0); return d.g > ${WETH} ? d.r : own; }
        void main(){
          ivec2 ij = ivec2(floor(position.x * 2.0 + 0.5), floor(position.z * 2.0 + 0.5));
          vec4 d = texelFetch(tW, ij, 0);
          float y = d.r;
          float e = float(min(min(ij.x, ij.y), min(${N1 - 1} - ij.x, ${N1 - 1} - ij.y)));
          if (d.g > ${WETH}) y = mix(uSea, y, clamp(e / 3.0, 0.0, 1.0));      // meet the flat outer ocean at the border
          float hx = lvl(ij + ivec2(1, 0), y) - lvl(ij - ivec2(1, 0), y), hz = lvl(ij + ivec2(0, 1), y) - lvl(ij - ivec2(0, 1), y);
          vNg = normalize(vec3(-hx, 1.0, -hz));
          vD = d.gbag;
          vSh = vec2(texelFetch(tShelf, ij, 0).r * 255.0 / 8.0, e * 0.5);      // m to the coast, m to the lattice border
          vec4 w = modelMatrix * vec4(position.x, y, position.z, 1.0); vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: SURF + `varying vec2 vSh;
        void main(){
          float nz = texture2D(tNoise, vW.xz * 0.023 + 0.37).r;                     // irregular shelf edge (reefs, bars)
          float ex = ${SHELF_D}.0 * smoothstep(1.5, 12.0, vSh.x * (0.6 + 0.8 * nz));
          ex = max(ex, 9.0 * (1.0 - smoothstep(0.0, 3.0, vSh.y)));                // deep at the border (the outer plane)
          gl_FragColor = shade(vD.x, vD.y, vD.y < -0.5 ? vD.x : vD.x + ex); ${TAIL} }`
    });
    grid = new T.Mesh(makeGrid(Q.waterN && Q.waterN < 150 ? 2 : 1), gridMat);
    grid.renderOrder = 6; grid.frustumCulled = false; scene.add(grid);

    // outer ocean: flat, deep, to the horizon; the map square is the grid's
    outerMat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, uniforms: shared(),
      vertexShader: /* glsl */`
        varying vec3 vW; varying vec3 vNg; varying vec4 vD;
        void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vNg = vec3(0.0, 1.0, 0.0); vD = vec4(0.0); gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`uniform highp sampler2D tW; uniform float uBack, uAlpha;
` + SURF + /* glsl */`void main(){
          float vis = 1.0;
          if (vW.x > 0.0 && vW.z > 0.0 && vW.x < 96.0 && vW.z < 96.0) {
            // inside the map the grid draws the water; over dry land beyond the slab, while the surrounding world (the
            // terrain context) is hidden, the sea continues flat, so the slab stands in an unbroken sea
            if (texture2D(tW, (vW.xz * 2.0 + 0.5) / ${N1}.0).g > 0.0 || dot(vW - uO, uN) > -uBack) discard;
            vis = 1.0 - uAlpha;
            if (vis < 0.01) discard;
          }
          vec2 o = max(max(-vW.xz, vW.xz - 96.0), 0.0);
          // P29f (user 2026-10-08: "a strange cut-off at a distance, like an island in the air"): the plane fades out
          // over its last 150 m, beyond render/farland.js's R_IN (520 m), so the far ocean (drawn under it, the same
          // surface down to the true horizon) carries the horizon: before, the fogged edge of this plane lay as a pale
          // band over the far islands' bases
          vis *= 1.0 - smoothstep(540.0, 690.0, length(vW.xz - vec2(48.0)));
          vec4 c = shade(1.9 + length(o) * 0.12, 0.0, 9.0 + length(o) * 0.12);   // LS1: deep from the border on
          gl_FragColor = vec4(c.rgb, c.a * vis); ${TAIL} }`
    });
    outer = new T.Mesh(new T.PlaneGeometry(1400, 1400), outerMat);
    outer.rotation.x = -Math.PI / 2; outer.position.set(48, SS.world.SEA, 48); outer.renderOrder = 5.9; outer.frustumCulled = false; scene.add(outer);

    // the aquarium face at slice zero
    faceMat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, side: T.DoubleSide,
      uniforms: Object.assign(shared(), { tVol: { value: null }, uVolSize: { value: new T.Vector3(SS.world.NX, SS.world.NY, SS.world.NZ) } }),
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform highp sampler2D tW; uniform highp sampler3D tVol; uniform sampler2D tNoise;
        uniform vec3 uVolSize, uSun, uDeep, uShallow, uFog, uN; uniform float uWTime, uFogD, uSea;
        varying vec3 vW;
        void main(){
          vec2 g = vW.xz * 2.0;
          if (vW.y < 0.02) discard;
          float surf, inl = 0.0;
          if (g.x < 0.0 || g.y < 0.0 || g.x > ${N1 - 1}.0 || g.y > ${N1 - 1}.0) {
            // beyond the map: the open sea at rest over a seabed falling away to the diorama base
            vec2 o = max(max(-vW.xz, vW.xz - 96.0), 0.0);
            surf = uSea;
            if (vW.y > surf || vW.y < 1.08 - length(o) * 0.06) discard;
          } else {
            // simulated surface over the wet corners only (dry corners hold the bed)
            ivec2 i0 = ivec2(floor(g)); vec2 f = g - vec2(i0);
            float sw = 0.0, sh = 0.0, dep = 0.0;
            inl = 0.0;
            for (int q = 0; q < 4; q++) {
              ivec2 o = ivec2(q & 1, q >> 1);
              vec4 d = texelFetch(tW, min(i0 + o, ivec2(${N1 - 1})), 0);
              float w = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
              dep += d.g * w;
              if (d.g > ${WETH}) { sw += w; sh += w * d.r; inl += w * step(d.b, -0.5); }
            }
            if (sw < 1e-3 || dep < ${WETH}) discard;
            surf = sh / sw; inl /= sw;
            if (vW.y > surf) discard;
            if (texture(tVol, (vW / 0.5 + 0.5) / uVolSize).r > 0.0) discard;   // rock: the terrain cap
          }
          float dd = surf - vW.y;
          vec3 col = mix(uShallow * 1.08, uDeep * 0.7, smoothstep(0.0, 2.6, dd));
          col = mix(col, mix(vec3(0.16, 0.15, 0.11), vec3(0.05, 0.06, 0.055), smoothstep(0.0, 1.2, dd)), inl);   // groundwater pool: murky
          // sun shafts along the refracted sun direction, drifting, fading with depth
          vec2 dW = vec2(uN.z, -uN.x); float u = dot(vW.xz, dW);
          float sl = clamp(dot(uSun.xz, dW) / max(uSun.y, 0.2), -2.0, 2.0) * 0.75;
          float s = u + dd * sl;
          float r1 = texture2D(tNoise, vec2(s * 0.43 + uWTime * 0.02, 0.37)).r, r2 = texture2D(tNoise, vec2(s * 0.11 - uWTime * 0.008, 0.71)).g;
          float rays = smoothstep(0.55, 0.85, r1) * smoothstep(0.3, 0.7, r2);
          col += vec3(0.3, 0.48, 0.44) * rays * exp(-dd * 0.6) * 0.5;
          // suspended specks
          float sp = texture2D(tNoise, vec2(u * 0.9, vW.y * 0.9 + uWTime * 0.02)).b;
          col += vec3(0.1, 0.14, 0.13) * smoothstep(0.82, 0.95, sp) * exp(-dd * 0.4);
          // meniscus: a thin bright line at the surface
          float px = max(fwidth(vW.y), 1e-3);
          col = mix(col, vec3(0.82, 0.95, 1.0), (1.0 - smoothstep(0.0, px * 2.5, dd)) * 0.85);
          float a = mix(0.74, 0.95, smoothstep(0.0, 2.0, dd));
          float fd = length(cameraPosition - vW);
          col = mix(col, uFog, 1.0 - exp(-fd * fd * uFogD * uFogD));
          gl_FragColor = vec4(col, a);
          ${TAIL}
        }`
    });
    const SEA = SS.world.SEA;
    face = new T.Mesh(new T.PlaneGeometry(1, 1), faceMat);
    face.scale.set(3000, SEA + 4, 1); face.renderOrder = 6.2; face.frustumCulled = false; scene.add(face);   // 3 km wide: the section's rock reaches 1.5 km past the map (P29a)
  };

  // P1 sudden death: the sea level rose (uSea is the terrain's shared uniform, set by view.seaChanged)
  WV.seaChanged = function (sea) { if (outer) outer.position.y = sea; if (face) face.scale.y = sea + 4; };
  WV.look = function (L, sk, haze) {
    const set = m => {
      const u = m.uniforms;
      u.tSky.value = sk.tex; u.uDeep.value.set(L.deep);
      if (sk.env) { u.tEnv.value = sk.env; u.uEnv.value = 1; } u.uShallow.value.set(L.shallow); u.uFog.value.copy(haze);
      u.uHorizon.value.setRGB(sk.horizon[0], sk.horizon[1], sk.horizon[2], T.SRGBColorSpace);
    };
    // the three materials share the `own` uniform objects: one set is enough
    set(gridMat);
  };

  /* foam spots from events: blasts (ring + centre), splashes */
  function addFoam(x, z, r, amt, ring) {
    const i0 = Math.max(0, Math.floor((x - r) * 2)), i1 = Math.min(N1 - 1, Math.ceil((x + r) * 2));
    const k0 = Math.max(0, Math.floor((z - r) * 2)), k1 = Math.min(N1 - 1, Math.ceil((z + r) * 2));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i * 0.5 - x, k * 0.5 - z) / r; if (d >= 1) continue;
      const w = ring ? Math.max(1 - d, Math.exp(-Math.pow((d - 0.75) / 0.12, 2))) : 1 - d * d;
      const c = k * N1 + i; foam[c] = Math.min(3, foam[c] + amt * w);   // up to 3: a blast's churn lasts ~5 s
    }
  }
  WV.onEvent = function (e) {
    // the open sea (beyond the simulated lattice, or within 3 m of its border): a ring wave on the outer ocean
    if ((e.type === 'waterblast' || e.type === 'splash') && !SS.world.dry && (e.x < 3 || e.z < 3 || e.x > SS.world.SX - 3 || e.z > SS.world.SZ - 3)) {
      own.uRing.value[ringN].set(e.x, e.z, own.uWTime.value, e.type === 'waterblast' ? Math.min(1.6, 0.5 + (e.R || 1) * 0.35) : 0.45 + (e.size || 1) * 0.2);
      ringN = (ringN + 1) % own.uRing.value.length;
    }
    if (!foam) return;
    if (e.type === 'waterblast') { addFoam(e.x, e.z, e.R * 2.4, 2.2, true); addFoam(e.x, e.z, e.R * 0.9, 1.5, false); }   // P30g: a wide churned patch
    else if (e.type === 'splash') addFoam(e.x, e.z, 0.6 + (e.size || 1) * 0.9, 0.9, false);
  };

  /* Signed depth: a dry column next to water gets the neighbours' water level and depth = level − ground (< 0), so
   * the interpolated depth crosses zero at the real shoreline and the mesh stays flat instead of climbing the bank
   * (a cliff column's bed is metres above the sea). Dry columns away from water: bed − 5 cm, depth −1. */
  function refill(S, dt) {
    const st = S.water, h = st.h, bed = st.bed || st.b, ux = st.ux, uz = st.uz, seep = st.seep, NX = N1;
    const fd = Math.exp(-dt / FOAM_T), wd = dt / WET_T, wu = dt / DAMP_T;
    for (let c = 0, o = 0; c < st.N; c++, o += 4) {
      const hc = h[c], wet = hc > WETH;
      const sp2 = ux[c] * ux[c] + uz[c] * uz[c];
      let f = foam[c] * fd;
      if (wet && sp2 > 0.81) f = Math.max(f, Math.min(1.5, f + dt * (Math.sqrt(sp2) - 0.9) * 0.9));
      foam[c] = f;
      const wa = wetA[c];
      wetA[c] = wet ? 1 : seep && seep[c] ? (wa < DAMP ? Math.min(DAMP, wa + wu) : Math.max(DAMP, wa - wd)) : Math.max(0, wa - wd);
      data[o] = wet ? bed[c] + hc : bed[c] - 0.05;
      data[o + 1] = wet ? hc : -1;
      data[o + 2] = wet ? (st.sea && !st.sea[c] ? -1 - f : f) : 0;
      data[o + 3] = wetA[c];
    }
    for (let k = 0; k < N1; k++) for (let i = 0; i < N1; i++) {
      const c = k * NX + i; if (h[c] > WETH) continue;
      let sw = 0, sl = 0;
      if (i > 0 && h[c - 1] > WETH) { sw++; sl += data[(c - 1) * 4]; }
      if (i < N1 - 1 && h[c + 1] > WETH) { sw++; sl += data[(c + 1) * 4]; }
      if (k > 0 && h[c - NX] > WETH) { sw++; sl += data[(c - NX) * 4]; }
      if (k < N1 - 1 && h[c + NX] > WETH) { sw++; sl += data[(c + NX) * 4]; }
      if (!sw) continue;
      const lv = sl / sw, o = c * 4;
      data[o] = lv; data[o + 1] = Math.max(-2, Math.min(0, lv - bed[c]));
      if (st.sea && !st.sea[c]) data[o + 2] = -1;          // bank of an inland pool (its foam sign)
    }
    tex.needsUpdate = true;
  }

  /* coast distance (m) of every sea cell: 2-pass chamfer (0.5 m, diagonal 0.707 m) from the non-sea cells (land,
   * inland pools); stored x 8 in a byte (0.125 m steps, saturates at 31.9 m; the shelf ramp ends at ~12-20 m) */
  function buildShelf(st) {
    const d = shelfD, NX = N1, BIG = 1e4, A = 0.5, D = 0.7071;
    for (let c = 0; c < st.N; c++) d[c] = (st.sea ? st.sea[c] : st.h[c] > WETH) ? BIG : 0;
    for (let k = 0; k < N1; k++) for (let i = 0; i < N1; i++) {
      const c = k * NX + i; let v = d[c]; if (!v) continue;
      if (i > 0) v = Math.min(v, d[c - 1] + A);
      if (k > 0) { v = Math.min(v, d[c - NX] + A); if (i > 0) v = Math.min(v, d[c - NX - 1] + D); if (i < N1 - 1) v = Math.min(v, d[c - NX + 1] + D); }
      d[c] = v;
    }
    for (let k = N1 - 1; k >= 0; k--) for (let i = N1 - 1; i >= 0; i--) {
      const c = k * NX + i; let v = d[c]; if (!v) continue;
      if (i < N1 - 1) v = Math.min(v, d[c + 1] + A);
      if (k < N1 - 1) { v = Math.min(v, d[c + NX] + A); if (i < N1 - 1) v = Math.min(v, d[c + NX + 1] + D); if (i > 0) v = Math.min(v, d[c + NX - 1] + D); }
      d[c] = v;
    }
    for (let c = 0; c < st.N; c++) shelf[c] = Math.min(255, Math.round(d[c] * 8));
    shelfTex.needsUpdate = true;
  }

  WV.frame = function (S, view, camera) {
    const st = S.water;
    const on = !!st && !SS.world.dry;                    // dry worlds (Step D): no sea at all; render/dunes.js draws the far dunes
    grid.visible = face.visible = on; outer.visible = !SS.world.dry;
    own.uWTime.value = view.time;
    own.uInsp.value = view.insp || 0;
    const L = (view.look && view.look.sunDir) || [-0.42, 0.62, 0.66];
    own.uSun.value.set(L[0], L[1], L[2]).normalize();
    if (!faceMat.uniforms.tVol.value && SS.terrain.vol) faceMat.uniforms.tVol.value = SS.terrain.vol();
    if (!on) return;
    if (st !== stateRef) { stateRef = st; foam.fill(0); wetA.fill(0); ver = -1; shelfT = -9; }
    if (view.time - shelfT > SHELF_T || view.time < shelfT) { buildShelf(st); shelfT = view.time; }
    if (st.ver !== ver) { const t0 = performance.now(); refill(S, Math.min(0.5, Math.max(0, view.time - lastT))); ms = performance.now() - t0; ver = st.ver; lastT = view.time; }
    // the face lies on slice zero, exactly where the terrain clips (U.uO / U.uN, set by terrain.update)
    const o = U.uO.value, n = U.uN.value;
    face.position.set(o.x, (SS.world.SEA + 4) / 2, o.z);
    face.rotation.set(0, Math.atan2(n.x, n.z), 0);
    face.visible = !!faceMat.uniforms.tVol.value;
  };
  /* weather (render/weather.js): rain intensity for the rings, fog density multiplier */
  WV.weather = function (rain, fogMul, fogCol) { own.uRain.value = rain; own.uFogD.value = FOG_D * fogMul; if (fogCol) own.uFog.value.copy(fogCol); };
  WV.stats = () => ({ ver, tris: grid ? grid.geometry.index.count / 3 : 0, refillMs: +ms.toFixed(3) });
  WV.meshes = () => [grid, outer, face];
  WV.fog = () => ({ color: own.uFog.value, density: own.uFogD.value });   // (the far ocean continues it, farland.js)
})(window.SS = window.SS || {});
