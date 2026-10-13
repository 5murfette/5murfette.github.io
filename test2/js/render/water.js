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
  let N1 = 193;                       // lattice columns per side (P38: per map, WV.resize)
  const WETH = 0.004, WET_T = 9, FOAM_T = 2.6, DAMP = 0.9, DAMP_T = 2.5;
  let ms = 0, scene, tx, Q, U, tex, data, foam, wetA, grid, outer, face, gridMat, outerMat, faceMat, stateRef = null, ver = -1, lastT = 0;
  const own = {
    tW: { value: null }, tSky: { value: null }, tEnv: { value: null }, uEnv: { value: 0 },
    uSun: { value: new T.Vector3(0.5, 0.6, 0.3).normalize() },
    uHorizon: { value: new T.Color(0xf6c89a) }, uDeep: { value: new T.Color(0x0d3a5c) }, uShallow: { value: new T.Color(0x2fa7a8) },
    // P65c: wind-driven chop: xy = distance the wind has carried the ripples (m), z = wind speed (m/s)
    uFog: { value: new T.Color(0xf3d2b0) }, uFogD: { value: 0.0026 }, uInsp: { value: 0 }, uWTime: { value: 0 }, uRain: { value: 0 },
    uCloud: { value: 0 }, uFaceT: { value: 0 }, uSunCol: { value: new T.Vector3(1, 0.86, 0.66) }, uWDir: { value: new T.Vector2(1, 0) },
    uWindD: { value: new T.Vector4(0, 0, 0, 0) },
    // P116: clear tropical water (uClear 1): the colour by apparent depth, near shore -> mid -> deep
    uClear: { value: 0 }, uWc0: { value: new T.Color(0x70602a) }, uWc1: { value: new T.Color(0x2c4a22) },
    uWc2: { value: new T.Color(0x0f2a24) },
    // lattice texels / map side (m) / map centre
    tShelf: { value: null }, uNW: { value: 193 }, uSW: { value: 96 }, uMC: { value: new T.Vector2(48, 48) },
    uRing: { value: [0, 1, 2, 3, 4, 5].map(() => new T.Vector4(0, 0, -99, 0)) }   // P29l: open-sea ring waves (x, z, start time, strength)
  };
  let ringN = 0, windT = 0, wsx = 0, wsz = 0, wAng = 0, wInit = false;
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
    uniform sampler2D tNoise, tSky;
    uniform samplerCube tEnv;
    uniform float uEnv, uWTime, uSea, uFogD, uInsp, uRain, uCloud, uFaceT;
    uniform vec2 uWDir;
    uniform vec3 uSunCol, uSun, uHorizon, uDeep, uShallow, uFog, uO, uN;
    uniform vec4 uRing[6], uWindD;
    uniform float uClear;
    uniform vec3 uWc0, uWc1, uWc2;
    // P29l (user 2026-10-08: "hitting water just outside the island makes no splash, no wave"): the open sea beyond the
    // simulated lattice has no wave field, so a splash / water blast there starts an expanding ring wave: a wave train
    // behind a front moving at ~5 m/s, decaying with age and radius; returns the slope (normal) and a crest-foam share
    vec3 seaRings(vec2 p){
      vec3 g = vec3(0.0);
      for (int i = 0; i < 6; i++){
        vec4 R = uRing[i];
        float age = uWTime - R.z;
        if (age < 0.0 || age > 9.0 || R.w <= 0.0) continue;
        vec2 d = p - R.xy;
        float r = length(d), x = r - age * 5.0;
        if (x > 1.4 || x < -9.5) continue;
        // P97: the front is not a perfect circle: its radius wanders with the angle (more as it travels) and its
        // strength is patchy
        float an = atan(d.y, d.x), sd = fract(R.z * 0.731) * 6.28,
          wob = (0.55 * sin(an * 3.0 + sd) + 0.35 * sin(an * 7.0 + sd * 2.3) + 0.2 * sin(an * 13.0 + sd * 3.1)) * (0.25 + min(age * 0.5, 1.0));
        x += wob;
        if (x > 0.5 || x < -9.0) continue;
        float env = R.w * (0.72 + 0.28 * sin(an * 5.0 + sd * 1.7 + 1.0)) * exp(-age * 0.35) * exp(x * 0.35) / (1.0 + r * 0.15) * smoothstep(0.5, 0.0, x);
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
    varying vec3 vW;
    varying vec3 vNg;
    varying vec4 vD;
    varying float vSl;
    // P65l: wind-driven chop is anisotropic: with the wind rising the crests stretch across the wind direction (short
    // wavelength along it, long across it) and ride downwind; in a calm the pattern is isotropic
    vec2 chopUV(vec2 u){
      float ky = 1.0 / (1.0 + 1.7 * (1.0 - exp(-uWindD.z / 5.0)));
      return vec2(dot(u, uWDir), dot(u, vec2(-uWDir.y, uWDir.x)) * ky);
    }
    float hgt(vec2 p){
      // P87: rotate about the lattice centre, drift = a scalar along the heading (no sweep when the wind turns)
      float D = uWindD.x;
      vec2 pc = p - vec2(48.0, 48.0);
      return texture2D(tNoise, chopUV(pc*0.045) - vec2(D*0.0040, 0.0)).a * 0.6
           + texture2D(tNoise, chopUV(pc*0.11) - vec2(D*0.0067, 0.0)).a * 0.3
           + texture2D(tNoise, chopUV(pc*0.33) - vec2(D*0.0130, 0.0)).g * 0.1;
    }
    // P101: finer ripple layers (cat's-paw): two small wavelengths riding on the chop, rotated against it so no lattice
    // shows. The wind scales the amplitude (calm = glassy, a gale = rough), the camera distance fades them (they alias
    // and are sub-pixel beyond ~80 m), and the drift is the same low-passed scalar D as the chop (no speed jump when
    // the wind changes).
    float hfine(vec2 p, float k){
      vec2 pc = p - vec2(48.0, 48.0);
      float D = uWindD.x;
      vec2 a = chopUV(vec2(pc.x * 0.8 - pc.y * 0.6, pc.x * 0.6 + pc.y * 0.8) * (0.7 * k)) - vec2(D * 0.0190 * sqrt(k), 0.0);
      return texture2D(tNoise, a).a;
    }
    vec4 shade(float depth, float foamS, float dA){          // dA: apparent depth (colour / opacity; LS1 shelf)
      float tD = dot(vW - uO, uN);
      if (depth < 0.006) discard;
      float inl = clamp(-foamS, 0.0, 1.0);                   // inland still water (foam channel stored as -1 - foam)
      // P116: the dry bank of the SEA carries the inland sign too (-1): across a rock's rim inl was a fraction, which
      // let the turquoise shallow colour (uShallow) show as a cyan outline; only a real pool counts
      inl = mix(inl, smoothstep(0.92, 1.0, inl), uClear);
      foamS = max(foamS, 0.0) + max(-1.0 - foamS, 0.0);
      vec2 p = vW.xz;
      float e = 0.12;
      float h0 = hgt(p), hx = hgt(p + vec2(e, 0.0)), hz = hgt(p + vec2(0.0, e));
      float wsp = uWindD.z, wk = (0.55 + 1.6 * (1.0 - exp(-wsp / 6.0))) / 1.18;   // chop height by wind speed (1 at a breeze)
      float amp = 2.2 * wk * smoothstep(0.0, 0.5, depth);    // ripples calm down in the shallows
      vec3 n = normalize(vNg + vec3((h0 - hx) * amp, 0.0, (h0 - hz) * amp));
      {
        float fdist = length(cameraPosition - vW), fk = 1.0 - smoothstep(30.0, 90.0, fdist);
        float fa = fk * (0.35 + 0.9 * (1.0 - exp(-wsp / 6.0))) * smoothstep(0.0, 0.35, depth);
        if (fa > 0.01) {
          float f0 = hfine(p, 1.0), fx = hfine(p + vec2(0.05, 0.0), 1.0), fz = hfine(p + vec2(0.0, 0.05), 1.0);
          vec2 g = vec2(f0 - fx, f0 - fz) * 1.6;
          float fb = 1.0 - smoothstep(12.0, 40.0, fdist);
          if (fb > 0.01) {
            float b0 = hfine(p, 2.7), bx = hfine(p + vec2(0.025, 0.0), 2.7), bz = hfine(p + vec2(0.0, 0.025), 2.7);
            g += vec2(b0 - bx, b0 - bz) * 0.9 * fb;
          }
          n = normalize(n + vec3(g.x, 0.0, g.y) * fa);
        }
      }
      if (uRain > 0.01) {
        vec2 rr = rainRings(p, uWTime) * 0.45 * smoothstep(0.01, 0.15, depth);
        n = normalize(n + vec3(rr.x, 0.0, rr.y));
      }
      vec3 rg = seaRings(p);
      n = normalize(n + vec3(rg.x, 0.0, rg.y) * 0.9);
      vec3 V = normalize(cameraPosition - vW);
      // P76: storm / ash murk: the shelf is no tropical turquoise under a black sky
      float turbS = clamp(uFaceT + uRain * 0.7 + uCloud * 0.45, 0.0, 1.0);
      vec3 shW = mix(uShallow, vec3(dot(uShallow, vec3(0.333))) * vec3(0.55, 0.6, 0.58), 0.62 * turbS) * (1.0 - 0.45 * turbS);
      vec3 col = mix(mix(shW, uDeep, smoothstep(0.3, 4.5, dA)), mix(vec3(0.05, 0.048, 0.04), vec3(0.018, 0.026, 0.028), smoothstep(0.1, 1.5, depth)), inl);
      // P116: clear tropical water: golden-olive turbid shallows -> green -> deep grey-green (the seabed shows through,
      // see the alpha below)
      if (uClear > 0.0) {
        vec3 cc = mix(mix(uWc0, uWc1, smoothstep(0.15, 2.4, dA)), uWc2, smoothstep(1.8, 7.0, dA));
        col = mix(col, mix(cc, col, inl), uClear);
      }
      // Schlick, F0 0.02 (n 1.33): the weight below keeps the sky tint of a deep sea
      float fres = pow(1.0 - max(dot(n, V), 0.0), 5.0);
      vec3 R = reflect(-V, n);
      // K2: the procedural sky-view LUT (render/sky.js: azimuth x elevation, rows packed toward the horizon; no mips)
      float rel = asin(clamp(R.y, 0.0, 1.0));
      vec3 refl = uEnv > 0.5 ? textureCube(tEnv, vec3(R.x, max(R.y, 0.002), R.z)).rgb   // K2e: sky + clouds (cube, render/sky.js)
                             : texture2D(tSky, vec2(atan(R.z, R.x) / 6.2831853 + 0.5, 0.5 + 0.5 * sqrt(rel / 1.5707963))).rgb;
      refl = mix(refl, uHorizon, 0.25);
      col = mix(col, refl, mix(0.07, 0.03, inl) + 0.85 * fres);
      vec3 H = normalize(uSun + V);
      float nh = max(dot(n, H), 0.0);
      // P65l: sun / moon colour; a clouded sun leaves no glint
      col += uSunCol * (1.0 - 0.9 * max(uRain, uCloud * 0.85)) * (pow(nh, 260.0) * 3.0 + pow(nh, 40.0) * 0.12);
      // P116: the glitter path: with the sun low a broad, sparkling streak runs from the sun across the sea towards the
      // viewer
      if (uClear > 0.0) {
        float low = 1.0 - smoothstep(0.08, 0.55, uSun.y);
        float spk = 0.55 + 0.9 * texture2D(tNoise, p * 2.7 + vec2(uWTime * 0.05, 0.0)).g * texture2D(tNoise, p * 0.9 - vec2(0.0, uWTime * 0.03)).r * 2.0;
        col += uClear * uSunCol * (1.0 - 0.9 * max(uRain, uCloud * 0.85)) * (pow(nh, 70.0) * 1.1 + pow(nh, 16.0) * 0.28 * low + pow(nh, 140.0) * 2.0 * spk) * (0.35 + 0.65 * low) * smoothstep(0.05, 0.4, depth);
      }
      // foam: shore band (moving lines), the thin run-up film, simulated foam (fast water, blasts), steep crests
      float fn = texture2D(tNoise, p * 0.5 + uWTime * 0.03).b;
      float band = 0.5 + 0.5 * sin(depth * 9.0 - uWTime * 1.7 + fn * 4.0);
      float foam = (1.0 - smoothstep(0.0, 0.7, depth)) * smoothstep(0.35, 0.9, band * 0.6 + fn * 0.6);
      // P61: wave lines travelling to the shore (sharp leading edge, lace trailing off-shore), fading with depth
      float swp = fract(depth * 1.7 + uWTime * 0.14 + fn * 0.45);
      float swl = smoothstep(0.0, 0.05, swp) * (1.0 - smoothstep(0.05, 0.36, swp)) * (1.0 - smoothstep(0.5, 1.7, depth));
      float swn = smoothstep(0.3, 0.72, fn * 0.55 + texture2D(tNoise, p * 2.3 + uWTime * 0.02).g * 0.65);
      foam = max(foam, swl * swn * 0.9);
      foam *= 1.0 - 0.6 * uClear;                            // P116: clear water: thin lines, not a white band
      // surf round rocks: where the bed climbs steeply under shallow water, lace and churn
      if (uClear > 0.0) {
        float dg = vSl;
        float lace2 = fn * 0.55 + texture2D(tNoise, p * 1.3 + vec2(uWTime * 0.04, 0.0)).g * 0.6 + texture2D(tNoise, p * 4.1 - uWTime * 0.03).b * 0.25;
        // the swell washes the stones: the surf breathes in and out
        float surge = 0.5 + 0.5 * sin(uWTime * 1.15 + p.x * 0.8 + p.y * 0.6 + fn * 3.0);
        foam = max(foam, uClear * smoothstep(0.12, 0.55, dg) * (1.0 - smoothstep(0.02, 0.07 + 0.09 * surge, depth)) * (0.4 + 0.6 * smoothstep(0.3 - 0.1 * surge, 0.7, lace2)) * (0.7 + 0.3 * surge));
        foam = max(foam, uClear * smoothstep(0.05, 0.4, dg) * (1.0 - smoothstep(0.05, 0.4, depth)) * smoothstep(0.55, 0.9, lace2) * 0.4);
      }
      foam = max(foam, (1.0 - smoothstep(0.01, 0.07, depth)) * mix(0.75, 0.0, uClear)) * (1.0 - inl);       // swash: the sea only
      // P116: the photo's foam: a thin crisp swash arc, broken wave-front lines that creep up the beach, a faint film
      // behind
      if (uClear > 0.0) {
        float brk = smoothstep(0.4, 0.72, fn * 0.6 + texture2D(tNoise, p * 0.9 + vec2(0.0, uWTime * 0.02)).r * 0.6);
        float ph = fract(depth * 1.25 - uWTime * 0.06 + fn * 0.6);
        float wl = smoothstep(0.0, 0.035, ph) * (1.0 - smoothstep(0.035, 0.11, ph)) * (1.0 - smoothstep(0.25, 1.4, depth)) * smoothstep(0.03, 0.12, depth);
        float arc = (1.0 - smoothstep(0.008, 0.024, depth)) * smoothstep(0.0015, 0.007, depth);
        float fb = max(wl * brk * 0.85, arc * (0.55 + 0.4 * brk)) * (1.0 - inl);
        fb = max(fb, (1.0 - smoothstep(0.0, 0.012, depth)) * 0.2 * (1.0 - inl));
        foam = mix(foam, max(foam * 0.3, fb), uClear);
      }
      // simulated foam (blasts, fast water) as a lace: dense with holes while fresh, breaking into streaks as it fades
      float lace = fn * 0.6 + texture2D(tNoise, p * 1.9 - uWTime * 0.05).g * 0.5, fq = min(foamS, 1.5);
      foam = max(foam, smoothstep(0.05, 0.5, foamS) * smoothstep(0.78 - fq * 0.32, 0.98 - fq * 0.28, lace));
      foam = max(foam, (1.0 - smoothstep(0.82, 0.93, vNg.y)) * smoothstep(0.35, 0.75, fn));
      foam = max(foam, min(1.0, rg.z * 1.6) * smoothstep(0.25, 0.65, fn + 0.3));            // ring-wave crests
      // whitecaps in a strong wind
      foam = max(foam, smoothstep(0.64, 0.8, h0 + (fn - 0.5) * 0.25) * smoothstep(5.5, 10.0, wsp) * smoothstep(0.3, 1.0, depth) * 0.7);
      // P65l: foam is lit like everything else: white in daylight, dark blue-grey under the moon
      float lk = smoothstep(0.05, 0.8, dot(uSunCol, vec3(0.333)));
      col = mix(col, mix(vec3(0.2, 0.25, 0.36), vec3(0.97, 0.98, 1.0), lk), foam * 0.85);
      float a = smoothstep(0.006, 0.05, depth) * mix(mix(0.64, 0.93, smoothstep(0.0, 3.0, dA)), 1.0, smoothstep(4.0, 9.0, dA));
      // P116: the seabed shows through the clear shallows
      a = mix(a, smoothstep(0.006, 0.035, depth) * mix(0.34, 1.0, smoothstep(0.0, 5.0, dA)), uClear);
      a = mix(a, smoothstep(0.006, 0.06, depth) * mix(0.4, 0.9, smoothstep(0.0, 1.2, depth)), inl);   // a puddle shows its floor
      a = max(a, foam * smoothstep(0.006, 0.03, depth));
      // inspection: the 3D overview shows the sea in front too. P118c (Q-OV5): at the SAME opacity as the sea behind
      // the plane (it was x 0.85: a lighter translucent sheet with a hard step along the whole cut line; the play view
      // still hides it all, uInsp = 0)
      if (tD > 0.0) a *= uInsp;
      float fd = length(cameraPosition - vW);
      // P29f: the distance fog goes to the real sky colour at the horizon in this direction (the fixed warm haze was
      // far brighter than the horizon: the near sea read as a bright layer under the far ocean / islands)
      vec3 Lk = normalize(vW - cameraPosition);
      vec3 hzSky = texture2D(tSky, vec2(atan(Lk.z, Lk.x) / 6.2831853 + 0.5, 0.5)).rgb;   // (the LUT, as render/farland.js: no seam)
      // (a touch darker than the sky: a real sea horizon)
      col = mix(col, mix(uFog, hzSky, 0.9) * 0.93, 1.0 - exp(-fd * fd * uFogD * uFogD));
      return vec4(col, a);
    }
  `;
  const TAIL = /* glsl */`
    #include <tonemapping_fragment>
    #include <colorspace_fragment>`;

  function makeGrid(step) {
    const n = Math.floor((N1 - 1) / step) + 1, pos = new Float32Array(n * n * 3), idx = [];
    for (let k = 0; k < n; k++)
      for (let i = 0; i < n; i++) {
        const o = (k * n + i) * 3;
        pos[o] = i * step * 0.5;
        pos[o + 2] = k * step * 0.5;
      }
    for (let k = 0; k < n - 1; k++)
      for (let i = 0; i < n - 1; i++) {
        const a = k * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setIndex(idx);
    g.boundingSphere = new T.Sphere(new T.Vector3(N1 / 4, 3, N1 / 4), N1 * 0.42);
    return g;
  }

  WV.init = function (sc, textures, quality, renderer) {
    scene = sc;
    tx = textures;
    Q = quality;
    U = SS.terrain.uniforms;
    N1 = SS.world.NX;
    own.uNW.value = N1; own.uSW.value = SS.world.SX; own.uMC.value.set(SS.world.MX, SS.world.MZ);
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
        uniform highp sampler2D tW;
        uniform sampler2D tShelf;
        uniform float uSea, uNW;
        varying vec3 vW;
        varying vec3 vNg;
        varying vec4 vD;
        varying vec2 vSh;
        varying float vSl;
        float lvl(ivec2 q, float own){
          q = clamp(q, ivec2(0), ivec2(int(uNW) - 1));
          vec4 d = texelFetch(tW, q, 0);
          return d.g > ${WETH} ? d.r : own;
        }
        void main(){
          ivec2 ij = ivec2(floor(position.x * 2.0 + 0.5), floor(position.z * 2.0 + 0.5));
          vec4 d = texelFetch(tW, ij, 0);
          float y = d.r;
          float e = float(min(min(ij.x, ij.y), min(int(uNW) - 1 - ij.x, int(uNW) - 1 - ij.y)));
          if (d.g > ${WETH}) y = mix(uSea, y, clamp(e / 3.0, 0.0, 1.0));      // meet the flat outer ocean at the border
          float hx = lvl(ij + ivec2(1, 0), y) - lvl(ij - ivec2(1, 0), y), hz = lvl(ij + ivec2(0, 1), y) - lvl(ij - ivec2(0, 1), y);
          vNg = normalize(vec3(-hx, 1.0, -hz));
          vD = d.gbag;
          {
            float dxp = texelFetch(tW, clamp(ij + ivec2(1, 0), ivec2(0), ivec2(int(uNW) - 1)), 0).g - texelFetch(tW, clamp(ij - ivec2(1, 0), ivec2(0), ivec2(int(uNW) - 1)), 0).g,
              dzp = texelFetch(tW, clamp(ij + ivec2(0, 1), ivec2(0), ivec2(int(uNW) - 1)), 0).g - texelFetch(tW, clamp(ij - ivec2(0, 1), ivec2(0), ivec2(int(uNW) - 1)), 0).g;
            // P116: slope of the bed under the water (m / m: 2 columns = 1 m), smooth across the grid: surf round rocks
            vSl = length(vec2(dxp, dzp)) * 1.0;
          }
          vSh = vec2(texelFetch(tShelf, ij, 0).r * 255.0 / 8.0, e * 0.5);      // m to the coast, m to the lattice border
          vec4 w = modelMatrix * vec4(position.x, y, position.z, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: SURF + `varying vec2 vSh;
        void main(){
          float nz = texture2D(tNoise, vW.xz * 0.023 + 0.37).r;                     // irregular shelf edge (reefs, bars)
          float ex = ${SHELF_D}.0 * smoothstep(mix(1.5, 4.0, uClear), mix(12.0, 30.0, uClear), vSh.x * (0.6 + 0.8 * nz));   // (P116: the clear shelf is wide)
          ex = max(ex, 9.0 * (1.0 - smoothstep(0.0, mix(3.0, 16.0, uClear), vSh.y)));                // deep at the border (the outer plane; P116: a long soft ramp on the clear sea: no hard line where the lattice ends)
          gl_FragColor = shade(vD.x, vD.y, vD.y < -0.5 ? vD.x : vD.x + ex); ${TAIL} }`
    });
    gridMat.userData.sectionMargin = 0;                    // P46: the water follows the terrain's front limit (render/section.js)
    grid = new T.Mesh(makeGrid(Q.waterN && Q.waterN < 150 ? 2 : 1), gridMat);
    grid.renderOrder = 6; grid.frustumCulled = false; scene.add(grid);

    // outer ocean: flat, deep, to the horizon; the map square is the grid's
    outerMat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false, uniforms: shared(),
      vertexShader: /* glsl */`
        varying vec3 vW;
        varying vec3 vNg;
        varying vec4 vD;
        varying float vSl;
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vNg = vec3(0.0, 1.0, 0.0);
          vD = vec4(0.0);
          vSl = 0.0;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`uniform highp sampler2D tW;
        uniform float uBack, uAlpha, uNW, uSW;
        uniform vec2 uMC;
` + SURF + /* glsl */`void main(){
          float vis = 1.0;
          if (vW.x > 0.0 && vW.z > 0.0 && vW.x < uSW && vW.z < uSW) {
            // inside the map the grid draws the water; over dry land beyond the slab, while the surrounding world (the
            // terrain context) is hidden, the sea continues flat, so the slab stands in an unbroken sea
            if (texture2D(tW, (vW.xz * 2.0 + 0.5) / uNW).g > 0.0 || dot(vW - uO, uN) > -uBack) discard;
            vis = 1.0 - uAlpha;
            if (vis < 0.01) discard;
          }
          vec2 o = max(max(-vW.xz, vW.xz - uSW), 0.0);
          // P29f (user 2026-10-08: "a strange cut-off at a distance, like an island in the air"): the plane fades out
          // over its last 150 m, beyond render/farland.js's R_IN (520 m), so the far ocean (drawn under it, the same
          // surface down to the true horizon) carries the horizon: before, the fogged edge of this plane lay as a pale
          // band over the far islands' bases
          vis *= 1.0 - smoothstep(540.0, 690.0, length(vW.xz - uMC));
          vec4 c = shade(1.9 + length(o) * 0.12, 0.0, 9.0 + length(o) * 0.12);   // LS1: deep from the border on
          gl_FragColor = vec4(c.rgb, c.a * vis); ${TAIL} }`
    });
    outerMat.userData.sectionMargin = 0;
    outer = new T.Mesh(new T.PlaneGeometry(1400, 1400), outerMat);
    outer.rotation.x = -Math.PI / 2;
    outer.position.set(SS.world.MX, SS.world.SEA, SS.world.MZ);
    outer.renderOrder = 5.9;
    outer.frustumCulled = false;
    scene.add(outer);

    // the aquarium face at slice zero
    // P76: the face is a section THROUGH the water body: Beer-Lambert absorption by depth (red goes first), suspended
    // ash / silt in drifting plumes and settling streaks (more under a storm sky and on the volcanic coast), a murky
    // bed layer, aerated rain bubbles under the surface, and a churned top edge (chop height + foam rim) instead of the
    // flat meniscus line
    faceMat = new T.ShaderMaterial({
      // P109: the face lies exactly on the terrain cap's plane: without the offset the two z-fight (flicker, stipple
      // along the rock edge)
      transparent: true, depthWrite: false, fog: false, side: T.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      uniforms: Object.assign(shared(), {
        tVol: { value: null },
        uVolSize: { value: new T.Vector3(SS.world.NX, SS.world.NY, SS.world.NZ) },
        uFaceK: { value: new T.Vector4(1, 1, 1, 1) },
        uFaceH: { value: 0 }
      }),
      vertexShader: `varying vec3 vW;
        void main(){
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */`
        uniform highp sampler2D tW;
        uniform highp sampler3D tVol;
        uniform sampler2D tNoise;
        uniform vec3 uVolSize, uSun, uDeep, uShallow, uFog, uN;
        uniform vec4 uFaceK;
        uniform float uWTime, uFogD, uSea, uNW, uSW, uFaceH, uFaceT, uRain, uCloud;
        varying vec3 vW;
        void main(){
          vec2 g = vW.xz * 2.0;
          if (vW.y < 0.02) discard;
          vec2 dW = vec2(uN.z, -uN.x);
          float u = dot(vW.xz, dW);
          float turb = clamp(uFaceT + uRain * 0.7 + uCloud * 0.45, 0.0, 1.0);          // storm / ash murk 0..1
          // chop on the top edge: along-face waves, finer ripples riding on them, wilder under rain and wind
          float rip = (0.015 + 0.075 * turb) * ((texture2D(tNoise, vec2(u * 0.8 + uWTime * 0.33, 0.13)).r - 0.5) * 1.3 + (texture2D(tNoise, vec2(u * 3.3 - uWTime * 0.8, 0.57)).g - 0.5) * 0.55);
          float surf, inl = 0.0, bedY = -1.0;
          if (g.x < 0.0 || g.y < 0.0 || g.x > uNW - 1.0 || g.y > uNW - 1.0) {
            // beyond the map: the open sea at rest over a seabed falling away to the diorama base
            vec2 o = max(max(-vW.xz, vW.xz - uSW), 0.0);
            surf = uSea; bedY = 1.08 - length(o) * 0.06;
            if (vW.y > surf + rip || vW.y < bedY) discard;
          } else {
            // simulated surface over the wet corners only (dry corners hold the bed)
            ivec2 i0 = ivec2(floor(g));
            vec2 f = g - vec2(i0);
            float sw = 0.0, sh = 0.0, dep = 0.0;
            inl = 0.0;
            for (int q = 0; q < 4; q++) {
              ivec2 o = ivec2(q & 1, q >> 1);
              vec4 d = texelFetch(tW, min(i0 + o, ivec2(int(uNW) - 1)), 0);
              float w = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
              dep += d.g * w;
              if (d.g > ${WETH}) {
                sw += w;
                sh += w * d.r;
                inl += w * step(d.b, -0.5);
              }
            }
            if (sw < 1e-3 || dep < ${WETH}) discard;
            surf = sh / sw; inl /= sw;
            if (vW.y > surf + rip) discard;
            // rock: the terrain cap (a hair of margin: no water sliver on the rock edge)
            if (texture(tVol, (vW / 0.5 + 0.5) / uVolSize).r > -0.04) discard;
          }
          float dd = surf + rip - vW.y;
          // bed proximity: rock a few decimetres below (inside the lattice), the sloping seabed beyond it
          float nearBed = bedY > -0.5 ? exp(-(vW.y - bedY) * 2.2) : max(step(0.0, texture(tVol, (vW - vec3(0.0, 0.3, 0.0)) / 0.5 / uVolSize + 0.5 / uVolSize).r) * 0.9, step(0.0, texture(tVol, (vW - vec3(0.0, 0.7, 0.0)) / 0.5 / uVolSize + 0.5 / uVolSize).r) * 0.45);
          // Beer-Lambert: the body keeps the blue-green, the red is absorbed first; murk shortens the visibility
          vec3 kAbs = vec3(0.78, 0.3, 0.17) * (1.0 + 1.1 * turb);
          vec3 col = uShallow * 0.95 * exp(-dd * kAbs) + uDeep * 0.62 * (1.0 - exp(-dd * (0.42 + 0.5 * turb)));
          col = mix(col, mix(vec3(0.16, 0.15, 0.11), vec3(0.05, 0.06, 0.055), smoothstep(0.0, 1.2, dd)), inl);   // groundwater pool: murky
          // sun shafts along the refracted sun direction, drifting, fading with depth; a cloud deck leaves none
          float sl = clamp(dot(uSun.xz, dW) / max(uSun.y, 0.2), -2.0, 2.0) * 0.75;
          float s = u + dd * sl;
          float r1 = texture2D(tNoise, vec2(s * 0.43 + uWTime * 0.02, 0.37)).r, r2 = texture2D(tNoise, vec2(s * 0.11 - uWTime * 0.008, 0.71)).g;
          float rays = smoothstep(0.55, 0.85, r1) * smoothstep(0.3, 0.7, r2);
          col += vec3(0.3, 0.48, 0.44) * rays * exp(-dd * 0.6) * 0.5 * (1.0 - clamp(uCloud * 1.3 + uFaceT * 0.6, 0.0, 1.0) * 0.92);
          // suspended ash / silt: slow plumes (two scales) + falling streaks (flocs settling), thicker with the murk
          // and toward the bed
          float pl = texture2D(tNoise, vec2(u * 0.62 + uWTime * 0.012, vW.y * 0.8 - uWTime * 0.02)).r * 0.55 + texture2D(tNoise, vec2(u * 1.7 - uWTime * 0.02, vW.y * 2.1 + 0.31)).g * 0.45;
          float stk = smoothstep(0.62, 0.9, texture2D(tNoise, vec2(u * 2.1, vW.y * 0.11 + uWTime * 0.012)).b);
          float ash = clamp(0.1 + 0.55 * turb, 0.0, 1.0) * (smoothstep(0.42, 0.66, pl) * 0.85 + stk * 0.5) * (1.0 - exp(-dd * 1.1));
          vec3 ashC = mix(vec3(0.075, 0.07, 0.065), vec3(0.2, 0.17, 0.12), 0.3 * (1.0 - turb));   // volcanic ash is dark; plain silt is tan
          col = mix(col, ashC * (0.55 + 1.0 * pl), clamp(ash, 0.0, 0.88));
          col *= mix(1.0, 0.62, smoothstep(0.0, 2.2, dd));                                              // daylight dies with depth
          col = mix(col, ashC * 0.8, nearBed * (0.25 + 0.4 * turb));                                   // the bed's resuspended mud
          // suspended specks
          float sp = texture2D(tNoise, vec2(u * 0.9, vW.y * 0.9 + uWTime * 0.02)).b;
          col += vec3(0.1, 0.14, 0.13) * smoothstep(0.82, 0.95, sp) * exp(-dd * 0.4) * (1.0 - 0.6 * turb);
          // rain bubbles: aerated water just under the surface (tiny bright specks rising)
          float bub = smoothstep(0.88, 0.98, texture2D(tNoise, vec2(u * 5.3 + 0.2, vW.y * 5.7 - uWTime * 0.35)).b);
          col += vec3(0.5, 0.56, 0.58) * bub * exp(-dd * 3.5) * (0.2 + 0.8 * clamp(uRain * 1.4 + turb * 0.5, 0.0, 1.0));
          // the top edge: a churned rim of foam / scum instead of a ruler line (width follows the chop)
          float fb = texture2D(tNoise, vec2(u * 2.1 + uWTime * 0.18, 0.2)).g;
          float fw = (0.03 + 0.11 * turb) * (0.35 + 1.3 * fb);
          float fm = 1.0 - smoothstep(0.0, fw, dd);
          col = mix(col, mix(vec3(0.74, 0.8, 0.82), vec3(0.45, 0.46, 0.45), 0.55 * turb), fm * (0.5 + 0.4 * turb));
          float px = max(fwidth(vW.y), 1e-3);
          col = mix(col, vec3(0.82, 0.95, 1.0), (1.0 - smoothstep(0.0, px * 1.8, dd)) * (0.8 - 0.35 * turb));
          // storm murk overall: darker, greyer
          col *= 1.0 - 0.38 * turb;
          col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))) * vec3(0.9, 1.0, 0.98), 0.3 * turb);
          // P65c: the face is the sea seen from the side: lit like the rest of the scene (dusk warm and dim, moonlight
          // cool and dark), overcast seas greyer
          col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uFaceK.w) * uFaceK.rgb;
          col = mix(col, uFog * 0.55, uFaceH * (1.0 - 0.5 * smoothstep(0.0, 4.0, dd)));
          float a = mix(0.8, 0.97, smoothstep(0.0, 1.6, dd)) + 0.03 * turb;
          float fd = length(cameraPosition - vW);
          col = mix(col, uFog, 1.0 - exp(-fd * fd * uFogD * uFogD));
          gl_FragColor = vec4(col, min(a, 1.0));
          ${TAIL}
        }`
    });
    const SEA = SS.world.SEA;
    faceMat.userData.sectionMargin = 0;
    face = new T.Mesh(new T.PlaneGeometry(1, 1), faceMat);
    // 3 km wide: the section's rock reaches 1.5 km past the map (P29a)
    face.scale.set(3000, SEA + 4, 1);
    face.renderOrder = 6.2;
    face.frustumCulled = false;
    scene.add(face);
  };

  /* P38: a map of another size: new lattice-sized arrays and textures (the texture objects stay, the terrain's tWater
   * uniform points at them), a new inner grid, the outer ocean and the section face re-centred. */
  WV.resize = function () {
    const W = SS.world;
    if (W.NX === N1) return;
    N1 = W.NX;
    const N = N1 * N1;
    data = new Float32Array(N * 4); foam = new Float32Array(N); wetA = new Float32Array(N);
    shelf = new Uint8Array(N); shelfD = new Float32Array(N);
    tex.dispose(); tex.image = { data, width: N1, height: N1 }; tex.needsUpdate = true;
    shelfTex.dispose(); shelfTex.image = { data: shelf, width: N1, height: N1 }; shelfTex.needsUpdate = true;
    own.uNW.value = N1; own.uSW.value = W.SX; own.uMC.value.set(W.MX, W.MZ);
    grid.geometry.dispose(); grid.geometry = makeGrid(Q.waterN && Q.waterN < 150 ? 2 : 1);
    outer.position.x = W.MX; outer.position.z = W.MZ;
    faceMat.uniforms.uVolSize.value.set(W.NX, W.NY, W.NZ);
    ver = -1; shelfT = -9; ringN = 0;
  };

  // P1 sudden death: the sea level rose (uSea is the terrain's shared uniform, set by view.seaChanged)
  WV.seaChanged = function (sea) {
    if (outer) outer.position.y = sea;
    if (face) face.scale.y = sea + 4;
  };
  /* P65c: the aquarium face's grade by time of day (view.js applyLook): tint x brightness and saturation, haze share
   * (overcast / ash seas) */
  // P76: turb = base murk of the water body (volcanic ash / silt)
  WV.faceLook = function (r, g, b, sat, haze, turb) {
    if (!faceMat) return;
    faceMat.uniforms.uFaceK.value.set(r, g, b, sat);
    faceMat.uniforms.uFaceH.value = haze;
    own.uFaceT.value = turb || 0;
  };
  WV.look = function (L, sk, haze) {
    const set = m => {
      const u = m.uniforms;
      u.tSky.value = sk.tex; u.uDeep.value.set(L.deep);
      // P65l: warm sun by day, cool dim moon at night
      {
        const sc = new T.Color(L.sun), k = Math.min(1, L.sunI / 3.0);
        u.uSunCol.value.set(sc.r * k + 0.0, sc.g * k, sc.b * k);
      }
      if (sk.env) {
        u.tEnv.value = sk.env;
        u.uEnv.value = 1;
      }
      u.uShallow.value.set(L.shallow);
      u.uFog.value.copy(haze);
      u.uHorizon.value.setRGB(sk.horizon[0], sk.horizon[1], sk.horizon[2], T.SRGBColorSpace);
      const wc = L.water;
      u.uClear.value = wc ? 1 : 0;
      if (wc) {
        u.uWc0.value.set(wc.near);
        u.uWc1.value.set(wc.mid);
        u.uWc2.value.set(wc.deep);
      }
    };
    // the three materials share the `own` uniform objects: one set is enough
    set(gridMat);
  };

  /* foam spots from events: blasts (ring + centre), splashes */
  function addFoam(x, z, r, amt, ring) {
    const i0 = Math.max(0, Math.floor((x - r) * 2)), i1 = Math.min(N1 - 1, Math.ceil((x + r) * 2));
    const k0 = Math.max(0, Math.floor((z - r) * 2)), k1 = Math.min(N1 - 1, Math.ceil((z + r) * 2));
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i * 0.5 - x, k * 0.5 - z) / r;
        if (d >= 1) continue;
        // P87: a broken, wobbling front, not a clean hoop
        const an = Math.atan2(k * 0.5 - z, i * 0.5 - x),
          pat = 0.3 + 0.7 * Math.max(0, 0.5 + 0.5 * Math.sin(an * 4 + x * 3.1) * 0.6 + 0.5 * Math.sin(an * 9 + z * 2.3) * 0.4),
          dd = d * (1 - 0.08 * Math.sin(an * 3 + x) - 0.05 * Math.sin(an * 7 + z));
        // P118c (Q-18): a splash is not a clean disc either: the radius wanders with the angle (lobes that only bite
        // INTO the disc) and the strength is patchy, so the foam of a worm that hits the sea reads as torn, wavy clumps
        // and bands, not a round (at the grazing camera: flat) white patch
        const lob = 1
          + Math.max(
            0,
            0.34 * Math.sin(an * 3 + x * 1.7) + 0.22 * Math.sin(an * 5 + z * 2.3 + 1.0) + 0.14 * Math.sin(an * 9 + x + z) + 0.1
          );
        const w = ring
          ? Math.max(1 - d, 0.8 * pat * Math.exp(-Math.pow((dd - 0.75) / 0.18, 2)))
          : Math.max(0, 1 - d * d * lob * lob) * (0.6 + 0.4 * pat);
        // up to 3: a blast's churn lasts ~5 s
        const c = k * N1 + i;
        foam[c] = Math.min(3, foam[c] + amt * w);
      }
  }
  WV.onEvent = function (e) {
    // the open sea (beyond the simulated lattice, or within 3 m of its border): a ring wave on the outer ocean
    // P65l: a splash anywhere starts a visible ring wave whose strength follows the entry (size = f(speed x mass)); the
    // lattice's own dip of a worm / body adds the real wave on top; blasts inside the lattice have the simulated one
    // no sea, no ring wave and no foam (what the sim calls a splash there is something leaving the world:
    // view.js)
    if (!SS.world.has_sea()) return;
    const rim = e.x < 3 || e.z < 3 || e.x > SS.world.SX - 3 || e.z > SS.world.SZ - 3;
    if (e.type === 'waterblast' && rim || e.type === 'splash') {
      own.uRing.value[ringN].set(
        e.x,
        e.z,
        own.uWTime.value,
        e.type === 'waterblast' ? Math.min(1.6, 0.5 + (e.R || 1) * 0.35) : (rim ? 0.45 : 0.3) + (e.size || 1) * (rim ? 0.2 : 0.3)
      );
      ringN = (ringN + 1) % own.uRing.value.length;
    }
    if (!foam) return;
    // P30g: a wide churned patch
    if (e.type === 'waterblast') {
      addFoam(e.x, e.z, e.R * 2.4, 2.2, true);
      addFoam(e.x, e.z, e.R * 0.9, 1.5, false);
    }
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
    for (let k = 0; k < N1; k++)
      for (let i = 0; i < N1; i++) {
        const c = k * NX + i;
        if (h[c] > WETH) continue;
        let sw = 0, sl = 0;
        if (i > 0 && h[c - 1] > WETH) {
          sw++;
          sl += data[(c - 1) * 4];
        }
        if (i < N1 - 1 && h[c + 1] > WETH) {
          sw++;
          sl += data[(c + 1) * 4];
        }
        if (k > 0 && h[c - NX] > WETH) {
          sw++;
          sl += data[(c - NX) * 4];
        }
        if (k < N1 - 1 && h[c + NX] > WETH) {
          sw++;
          sl += data[(c + NX) * 4];
        }
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
    for (let k = 0; k < N1; k++)
      for (let i = 0; i < N1; i++) {
        const c = k * NX + i;
        let v = d[c];
        if (!v) continue;
        if (i > 0) v = Math.min(v, d[c - 1] + A);
        if (k > 0) {
          v = Math.min(v, d[c - NX] + A);
          if (i > 0) v = Math.min(v, d[c - NX - 1] + D);
          if (i < N1 - 1) v = Math.min(v, d[c - NX + 1] + D);
        }
        d[c] = v;
      }
    for (let k = N1 - 1; k >= 0; k--)
      for (let i = N1 - 1; i >= 0; i--) {
        const c = k * NX + i;
        let v = d[c];
        if (!v) continue;
        if (i < N1 - 1) v = Math.min(v, d[c + 1] + A);
        if (k < N1 - 1) {
          v = Math.min(v, d[c + NX] + A);
          if (i < N1 - 1) v = Math.min(v, d[c + NX + 1] + D);
          if (i > 0) v = Math.min(v, d[c + NX - 1] + D);
        }
        d[c] = v;
      }
    for (let c = 0; c < st.N; c++) shelf[c] = Math.min(255, Math.round(d[c] * 8));
    shelfTex.needsUpdate = true;
  }

  WV.frame = function (S, view, camera) {
    if (SS.world.NX !== N1) WV.resize();
    const st = S.water;
    // no sea level (the deserts, caves, space): nothing of the sea is drawn; render/dunes.js draws the dunes. Live:
    // sudden death raises a 2D desert's sea into the slab. The data texture the terrain reads (tWater) is kept for
    // every world that had it (not the 3D desert's), whether the sea is drawn or not
    const sea = SS.world.has_sea(), on = !!st && !SS.world.dry;
    grid.visible = face.visible = on && sea; outer.visible = sea;
    own.uWTime.value = view.time;
    // the wind (smoothed: a new turn's wind must not make the ripples jump) carries the chop along
    {
      const wm = S.wind && S.wind.mean ? S.wind.mean : { x: 0, z: 0 },
        w = own.uWindD.value,
        dt = Math.max(0, Math.min(0.1, view.time - windT));
      windT = view.time;
      // P87: speed low-passed with a long time constant (10 s); the heading is an ANGLE slewed at <= 0.04 rad/s (a wind
      // that flips between turns swings the chop over ~1 min, never in a snap) and the drift is a scalar distance along
      // that heading
      wsx += (wm.x - wsx) * (1 - Math.exp(-dt / 10)); wsz += (wm.z - wsz) * (1 - Math.exp(-dt / 10));
      const sp = Math.hypot(wsx, wsz), tgt = Math.atan2(wsz, wsx);
      if (!wInit) {
        wAng = sp > 0.05 ? tgt : 0;
        wInit = true;
      }
      if (sp > 0.05) {
        let d = tgt - wAng;
        d -= Math.round(d / 6.2831853) * 6.2831853;
        const m = 0.04 * dt;
        wAng += Math.max(-m, Math.min(m, d));
      }
      own.uWDir.value.set(Math.cos(wAng), Math.sin(wAng));
      w.x += Math.min(6, Math.max(sp, 0.8)) * dt; w.z = sp;
    }
    own.uInsp.value = view.insp || 0;
    const L = (view.look && view.look.sunDir) || [-0.42, 0.62, 0.66];
    own.uSun.value.set(L[0], L[1], L[2]).normalize();
    // P109: the face must test the SAME volume texture the terrain cap uses, at the size of THAT texture (not of
    // SS.world: a 2D <-> 3D switch of the same map width changes only NZ and the lookup then hit the wrong slice: water
    // filled rock, user's side-on shots)
    if (SS.terrain.vol) {
      const v = SS.terrain.vol();
      faceMat.uniforms.tVol.value = v;
      const im = v && v.image;
      if (im) {
        const us = faceMat.uniforms.uVolSize.value;
        if (us.x !== im.width || us.y !== im.height || us.z !== im.depth) us.set(im.width, im.height, im.depth);
      }
    }
    if (!on) return;
    if (st !== stateRef) {
      stateRef = st;
      foam.fill(0);
      wetA.fill(0);
      ver = -1;
      shelfT = -9;
    }
    if (view.time - shelfT > SHELF_T || view.time < shelfT) {
      buildShelf(st);
      shelfT = view.time;
    }
    if (st.ver !== ver) {
      const t0 = performance.now();
      refill(S, Math.min(0.5, Math.max(0, view.time - lastT)));
      ms = performance.now() - t0;
      ver = st.ver;
      lastT = view.time;
    }
    // the face lies on slice zero, exactly where the terrain clips (U.uO / U.uN, set by terrain.update)
    const o = U.uO.value, n = U.uN.value;
    face.position.set(o.x, (SS.world.SEA + 4) / 2, o.z);
    face.rotation.set(0, Math.atan2(n.x, n.z), 0);
    // P118c (Q-OV2): the aquarium face is the cut through the water of the half-cut play view; in the overview (the
    // whole sea is drawn) it is a 3 km wide plane that drew a line (teal on temperate, a thick twisted green-white rope
    // on the beach) across the entire sea
    face.visible = sea && !!faceMat.uniforms.tVol.value && (view.insp || 0) < 0.05;
  };
  /* weather (render/weather.js): rain intensity for the rings, fog density multiplier */
  WV.weather = function (rain, fogMul, fogCol, cloud) {
    own.uRain.value = rain;
    own.uCloud.value = cloud || 0;
    own.uFogD.value = FOG_D * fogMul;
    if (fogCol) own.uFog.value.copy(fogCol);
  };
  WV.stats = () => ({ ver, tris: grid ? grid.geometry.index.count / 3 : 0, refillMs: +ms.toFixed(3) });
  WV.meshes = () => [grid, outer, face];
  WV.fog = () => ({ color: own.uFog.value, density: own.uFogD.value });   // (the far ocean continues it, farland.js)
})(window.SS = window.SS || {});
