/* render/clouds.js — gigantic 3D clouds (Step K2d; view-only, seeded, no sim state; Three.js specific).
 * User 2026-10-07: real, random clouds, 3D puffy objects, GIGANTIC, moving slowly and realistically like weather
 * patterns, not cartoon clouds. Built the way flight simulators do it (Niniane Wang, "Realistic and Fast Cloud
 * Rendering", MS Flight Simulator 2004): a cloud = an ellipsoid (flat base at the condensation level) filled with
 * camera-facing puff sprites; here the puffs are volumetric renders (Blender Cycles, tools/clouds_blender.py) with
 * SIX-WAY lighting (lit from ±X ±Y ±Z of the sprite), so every puff is relit by the real sun direction: bright
 * tops, dark flat bases, silver linings when the sun is behind. Each puff also gets a precomputed sun visibility
 * through its own cloud (Beer-Lambert over the puffs between it and the sun) and a height factor for the ambient.
 * Real sizes and distances: cumulus bases 1.2-2.5 km, clouds 0.4-2 km wide, the field 26 km around the island;
 * cumulonimbus towers to 9 km with anvils; a volcanic ash plume on the volcanic map. Earth curvature (d² / 2R) and
 * aerial perspective (the sky LUT behind each puff, extinction over the visibility of the biome / weather) make
 * the far clouds sink into the haze at the horizon. Motion: the whole field drifts with the wind aloft (2x the
 * surface wind, wraps around the camera with an edge fade), every cloud lives 12-25 min (grows from its core,
 * matures, dissipates) so the sky slowly changes; the camera never sees a pop.
 * Drawn after the sky dome and before everything else transparent, at the far plane (depth = 1): terrain, water and
 * the far dunes cover them. One instanced draw (premultiplied alpha), sorted far-to-near on the CPU every 0.5 s.
 * Porting: an instanced billboard pass + a CPU sort; the cloud layout is plain seeded math. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const CL = SS.cloudView = {};
  const FIELD = 26000;           // m: half-size of the square cloud field around the camera (wraps)
  const RE = 6371e3;             // m: earth radius (curvature drop d² / 2R)
  const MAXN = 6000;
  // per weather kind: cumulus count (per field) and size, base height, tops; scud (low ragged pieces under a deck);
  // cumulonimbus towers; the 2D deck (sky.js) handles the overcast layer itself
  const KIND = {
    clear:    { cu: 34, w: [380, 1100], base: 1500, top: [0.35, 0.7], scud: 0, cb: 0, dark: 0.0 },
    cloudy:   { cu: 70, w: [700, 2200], base: 1200, top: [0.45, 1.3], scud: 0, cb: 0, dark: 0.12 },
    rain:     { cu: 26, w: [900, 2600], base: 800, top: [0.4, 0.9], scud: 46, cb: 0, dark: 0.5 },
    storm:    { cu: 22, w: [900, 2600], base: 900, top: [0.5, 1.2], scud: 54, cb: 4, dark: 0.62 },
    snow:     { cu: 18, w: [900, 2400], base: 800, top: [0.3, 0.7], scud: 30, cb: 0, dark: 0.25 },
    blizzard: { cu: 8, w: [900, 2400], base: 500, top: [0.3, 0.6], scud: 50, cb: 0, dark: 0.35 },
    ashfall:  { cu: 14, w: [900, 2400], base: 1500, top: [0.4, 0.9], scud: 20, cb: 0, dark: 0.45 },
    fog:      { cu: 6, w: [900, 2400], base: 400, top: [0.2, 0.4], scud: 30, cb: 0, dark: 0.2 }
  };
  const BIOME = {             // multipliers / overrides per map: dry desert air has few, high clouds
    desert: { cuK: 0.35, baseK: 1.7 }, canyon: { cuK: 0.7, baseK: 1.3 }, alpine: { cuK: 1.1, baseK: 0.9 },
    temperate: { cuK: 1, baseK: 1 }, volcanic: { cuK: 0.8, baseK: 1, plume: true, tint: [0.62, 0.55, 0.5] }
  };
  // visibility (m) for the aerial perspective, per biome x weather
  const VIS = { temperate: 45000, alpine: 70000, canyon: 32000, desert: 20000, volcanic: 14000 };
  const VIS_W = { clear: 1, cloudy: 0.85, rain: 0.35, storm: 0.3, snow: 0.3, blizzard: 0.12, ashfall: 0.6, fog: 0.03 };

  let mesh = null, geo = null, mat = null, cam = null, n = 0, sortT = -1, order = null;
  let I = null;                 // instance arrays (CPU copy, sorted into the attributes)
  const U = {
    tA: { value: null }, tB: { value: null }, tC: { value: null }, tLut: { value: null },
    uSun: { value: new T.Vector3(0, 1, 0) }, uSunC: { value: new T.Vector3(1, 1, 1) }, uAmb: { value: new T.Vector3(0.3, 0.35, 0.45) },
    uE: { value: 1.6 }, uVis: { value: 40000 }, uTime: { value: 0 }, uDrift: { value: new T.Vector2() }, uCam: { value: new T.Vector3() },
    uF: { value: FIELD }, uFarZ: { value: 1 }, uWind: { value: new T.Vector2(1, 0) }, uTint: { value: new T.Vector3(1, 1, 1) }, uDark: { value: 0 }, uOv: { value: 0 }
  };

  const VERT = /* glsl */`
    attribute vec4 iPos;        // xyz (m, field coords; y = height above the sea), w = sprite half-size (m)
    attribute vec4 iA;          // x = atlas cell, y = rotation, z = cloud phase (0..1), w = life period (s; 0 = static)
    attribute vec4 iS;          // x = height in its cloud (0 base .. 1 top), y = sun visibility, z = rank (0 core .. 1 rim), w = darkness
    attribute vec2 iV;          // vertical motion (m/s, plume puffs rise) and growth with age (plume)
    uniform vec3 uSun, uCam; uniform vec2 uDrift, uWind; uniform float uF, uTime, uFarZ;
    varying vec2 vUv; varying vec3 vL; varying vec4 vS; varying float vA, vD; varying vec3 vDir;
    void main(){
      vec3 c = iPos.xyz; float sz = iPos.w;
      // life: grows from the core outward, matures, dissipates (period iA.w); the rim puffs come last / go first
      float a = 1.0;
      if (iA.w > 0.0) {
        float ph = fract(uTime / iA.w + iA.z), env = smoothstep(0.0, 0.3, ph) * (1.0 - smoothstep(0.72, 1.0, ph));
        float r0 = iS.z * 0.75; a = smoothstep(r0, r0 + 0.25, env); sz *= 0.55 + 0.45 * a;
      }
      if (iV.x != 0.0) {          // plume puffs: rise and spread through their own cycle (iA.w), recycled at the vent
        float ph = fract(uTime / iA.w + iA.z);
        c.y += iV.x * ph * iA.w; sz *= 1.0 + iV.y * ph; c.xz += uWind * iV.x * ph * iA.w * smoothstep(0.4, 1.0, ph) * 1.5;
        a = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.75, 1.0, ph));
      } else c.xz += uDrift;                                          // (the volcano stays put; its ash drifts)
      vec2 rel = mod(c.xz - uCam.xz + uF, 2.0 * uF) - uF;          // wrap around the camera
      a *= 1.0 - smoothstep(0.78, 1.0, max(abs(rel.x), abs(rel.y)) / uF);
      c.xz = uCam.xz + rel;
      float d2 = dot(rel, rel);
      c.y -= d2 / (2.0 * ${RE.toFixed(1)});                         // earth curvature
      vec3 vc = (viewMatrix * vec4(c, 1.0)).xyz;
      float ca = cos(iA.y), sa = sin(iA.y);
      vec2 q = position.xy;
      vc.xy += mat2(ca, sa, -sa, ca) * q * sz;
      gl_Position = projectionMatrix * vec4(vc, 1.0);
      if (uFarZ > 0.5) gl_Position.z = gl_Position.w;                // env cube: at the far plane (far pass: real depth)
      int cell = int(iA.x + 0.5);
      vUv = (vec2(float(cell % 4), float(3 - cell / 4)) + (q * 0.5 + 0.5)) / 4.0;
      // the sun in the sprite's frame (camera right / up / back, turned by the sprite's rotation)
      vec3 r = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), u = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]), b = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
      vec2 l2 = vec2(dot(uSun, r), dot(uSun, u));
      vL = vec3(mat2(ca, -sa, sa, ca) * l2, dot(uSun, b));
      // per-corner view direction in world space (the sky behind each fragment, not behind the sprite's centre: near
      // the horizon the sky changes fast and a centre lookup left big sprites brighter than the sky around them)
      // haze sits in the boundary layer: the optical distance shrinks with the path's mean height (aerosol scale
      // height 1.2 km), so high cloud tops / the plume stay crisp while low distant clouds melt into the horizon
      vS = iS; vA = a; vD = length(c - cameraPosition) * exp(-0.5 * max(c.y + cameraPosition.y, 0.0) / 1200.0); vDir = (vec4(normalize(vc), 0.0) * viewMatrix).xyz;
    }`;
  const FRAG = /* glsl */`
    uniform sampler2D tA, tB, tC, tLut; uniform vec3 uSunC, uAmb, uTint; uniform float uE, uVis, uDark, uOv;
    varying vec2 vUv; varying vec3 vL; varying vec4 vS; varying float vA, vD; varying vec3 vDir;
    vec2 lutUV(vec3 d){ float el = asin(clamp(d.y, -1.0, 1.0)); return vec2(atan(d.z, d.x) / 6.2831853 + 0.5, 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963)); }
    void main(){
      float al = texture2D(tC, vUv).r * vA;
      if (al < 0.003) discard;
      vec3 A = texture2D(tA, vUv).rgb, B = texture2D(tB, vUv).rgb;
      // six-way: each axis map weighted by the sun's component along it (maps are premultiplied by the opacity)
      float lit = max(vL.x, 0.0) * A.r + max(-vL.x, 0.0) * A.g + max(vL.y, 0.0) * A.b + max(-vL.y, 0.0) * B.r + max(vL.z, 0.0) * B.g + max(-vL.z, 0.0) * B.b;
      float sunVis = vS.y * pow(1.0 - uOv, 1.5);                        // through its own cloud, and under a deck (ov 0.9: 3 %)
      vec3 col = uSunC * lit * uE * sunVis;
      // ambient sky light: stronger on the upper parts, dark flat bases; storm clouds darker
      float amb = mix(0.32, 1.0, smoothstep(0.0, 0.8, vS.x)) * (1.0 - 0.6 * vS.w);
      col += uAmb * al * amb;
      col *= uTint * (1.0 - 0.45 * uDark * (1.0 - vS.x));
      // aerial perspective: toward the sky behind it with distance (extinction over the visibility)
      float f = 1.0 - exp(-vD / uVis * 2.6);
      vec3 sky = texture2D(tLut, lutUV(normalize(vDir))).rgb;
      col = mix(col, sky * al, f);
      // tone mapping and the sRGB encode are non-linear: apply them to the un-premultiplied colour, then premultiply
      // (encoding premultiplied colour lifted every soft rim into a bright outline)
      float aOut = al;                 // (a lower alpha with the full haze colour brightened far clouds above the sky)
      gl_FragColor = vec4(col / max(al, 1e-4), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      gl_FragColor = vec4(gl_FragColor.rgb * aOut, aOut);
    }`;

  CL.init = function (scene, tx) {
    if (!tx.clouds) return;
    U.tA.value = tx.clouds.a; U.tB.value = tx.clouds.b; U.tC.value = tx.clouds.c;
    geo = new T.InstancedBufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    I = { pos: new Float32Array(MAXN * 4), a: new Float32Array(MAXN * 4), s: new Float32Array(MAXN * 4), v: new Float32Array(MAXN * 2) };
    for (const [k, w] of [['iPos', 4], ['iA', 4], ['iS', 4], ['iV', 2]]) {
      const at = new T.InstancedBufferAttribute(new Float32Array(MAXN * w), w); at.setUsage(T.DynamicDrawUsage); geo.setAttribute(k, at);
    }
    geo.instanceCount = 0;
    mat = new T.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true,
      blending: T.CustomBlending, blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, blendSrcAlpha: T.OneFactor, blendDstAlpha: T.OneMinusSrcAlphaFactor });
    mesh = new T.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = -9; scene.add(mesh);
    if (SS.skyView && SS.skyView.ENV_LAYER) mesh.layers.enable(SS.skyView.ENV_LAYER);   // also in the water's reflections
  };

  /* ---------- layout (seeded) ---------- */
  let rng = null;
  const R = () => M.rng_next(rng), RR = (a, b) => a + (b - a) * M.rng_next(rng);
  // puffs of one cloud: an ellipsoid (rx, h, rz) above a flat base at y0; the puffs' sun visibility from the puffs
  // between it and the sun (Beer-Lambert, k per overlap)
  function addCloud(cx, cz, y0, rx, h, rz, kind, opt) {
    const puffR = Math.max(90, Math.min(rx, rz, h * 1.4) * RR(0.32, 0.45));
    const vol = rx * rz * h, np = Math.min(140, Math.max(6, Math.round(vol / (puffR * puffR * puffR) * 1.6)));
    const first = n, sun = U.uSun.value, ph = R(), per = opt.static ? 0 : RR(720, 1500), dark = opt.dark || 0;
    for (let k = 0; k < np && n < MAXN; k++) {
      let x, y, z;
      for (let t = 0; t < 30; t++) {           // inside the upper half-ellipsoid, denser toward the core
        x = RR(-1, 1); y = Math.pow(R(), 1.3); z = RR(-1, 1);
        if (x * x + y * y + z * z <= 1) break;
      }
      const px = cx + x * rx, py = y0 + y * h + puffR * 0.35, pz = cz + z * rz, o = n * 4;
      I.pos[o] = px; I.pos[o + 1] = py; I.pos[o + 2] = pz; I.pos[o + 3] = puffR * RR(2.6, 3.2);
      const flat = y < 0.25;                    // base puffs use the flat-bottomed renders (cells 2, 3 of each 8)
      I.a[o] = flat ? [2, 3, 10, 11][M.rng_int(rng, 4)] : M.rng_int(rng, 16); I.a[o + 1] = flat ? RR(-0.12, 0.12) : RR(-0.5, 0.5);
      I.a[o + 2] = ph; I.a[o + 3] = per;
      I.s[o] = y; I.s[o + 1] = 1; I.s[o + 2] = Math.min(1, Math.hypot(x, y * 0.7, z)); I.s[o + 3] = dark;
      I.v[n * 2] = 0; I.v[n * 2 + 1] = 0;
      n++;
    }
    // sun visibility: count the cloud's puffs within ~1 puff radius of the ray from each puff toward the sun
    for (let p = first; p < n; p++) {
      let od = 0; const ax = I.pos[p * 4], ay = I.pos[p * 4 + 1], az = I.pos[p * 4 + 2];
      for (let q = first; q < n; q++) {
        if (q === p) continue;
        const dx = I.pos[q * 4] - ax, dy = I.pos[q * 4 + 1] - ay, dz = I.pos[q * 4 + 2] - az, t = dx * sun.x + dy * sun.y + dz * sun.z;
        if (t <= 0) continue;
        const ex = dx - sun.x * t, ey = dy - sun.y * t, ez = dz - sun.z * t, d2 = ex * ex + ey * ey + ez * ez, rr = puffR * 1.1;
        if (d2 < rr * rr) od += 1 - Math.sqrt(d2) / rr;
      }
      I.s[p * 4 + 1] = Math.max(0.12, Math.exp(-0.55 * od));
    }
  }
  // cumulonimbus: a tower of puffs to ~9 km with an anvil spreading downwind at the top
  function addCb(cx, cz, base) {
    const top = RR(7500, 9500), rx = RR(2500, 4000);
    addCloud(cx, cz, base, rx, top * 0.45, rx * 0.9, 'cb', { dark: 0.55 });
    addCloud(cx, cz, base + top * 0.4, rx * 0.65, top * 0.45, rx * 0.6, 'cb', { dark: 0.35 });
    addCloud(cx + rx * 0.9, cz + rx * 0.3, top - 900, rx * 2.4, 900, rx * 1.6, 'anvil', { dark: 0.3 });
  }
  // volcanic ash plume: puffs rising from a vent beyond the horizon, recycled; dark, spreading downwind at the top
  let plumeAt = null;
  function addPlume(cx, cz) {
    const np = 160;
    plumeAt = { x: cx, z: cz };
    for (let k = 0; k < np && n < MAXN; k++) {
      const o = n * 4, per = RR(240, 420);
      I.pos[o] = cx + RR(-250, 250); I.pos[o + 1] = 600 + RR(0, 300); I.pos[o + 2] = cz + RR(-250, 250); I.pos[o + 3] = RR(350, 550);
      I.a[o] = M.rng_int(rng, 16); I.a[o + 1] = RR(-3, 3); I.a[o + 2] = k / np; I.a[o + 3] = per;
      I.s[o] = 0.4; I.s[o + 1] = RR(0.25, 0.5); I.s[o + 2] = 0; I.s[o + 3] = 0.85;
      I.v[n * 2] = RR(7500, 9000) / per; I.v[n * 2 + 1] = RR(2.5, 4.5);
      n++;
    }
  }

  /* new look: biome + weather; seed from the map */
  CL.look = function (S, sky) {
    if (!mesh) return;
    const kind = S.weather ? S.weather.kind : 'clear', K = KIND[kind] || KIND.clear, B = BIOME[S.biome] || BIOME.temperate;
    rng = M.rng_make(((S.settings.seed | 0) * 7349 + 1777) >>> 0 || 1);
    const sp = SS.skyView ? SS.skyView.params() : null;
    if (sp) U.uSun.value.copy(sp.sun);
    n = 0; plumeAt = null;
    const base = K.base * (B.baseK || 1), cnt = Math.round(K.cu * (B.cuK || 1));
    for (let c = 0; c < cnt; c++) {
      const w = RR(K.w[0], K.w[1]), h = w * RR(K.top[0], K.top[1]);
      addCloud(RR(-FIELD, FIELD), RR(-FIELD, FIELD), base * RR(0.9, 1.15), w * 0.5, h, w * RR(0.35, 0.55), 'cu', { dark: K.dark });
    }
    for (let c = 0; c < K.scud; c++) {         // low ragged pieces under the deck
      const w = RR(300, 900);
      addCloud(RR(-FIELD, FIELD), RR(-FIELD, FIELD), base * RR(0.45, 0.7), w * 0.5, w * RR(0.15, 0.3), w * 0.4, 'scud', { dark: K.dark + 0.15 });
    }
    for (let c = 0; c < K.cb; c++) { const a = RR(0, 6.283), d = RR(9000, 20000); addCb(Math.cos(a) * d, Math.sin(a) * d, base); }
    if (B.plume) { const a = RR(0, 6.283); addPlume(Math.cos(a) * 15000, Math.sin(a) * 15000); }
    geo.instanceCount = n; order = new Uint32Array(n); for (let i = 0; i < n; i++) order[i] = i;
    sortT = -1;
    U.uTint.value.set(...(B.tint || [1, 1, 1]));
    U.uDark.value = K.dark; U.uOv.value = sp ? sp.ov : 0;   // under a deck the sun barely reaches the clouds
    U.uVis.value = (VIS[S.biome] || 40000) * (VIS_W[kind] || 1);
    if (sky) {
      U.tLut.value = sky.tex;
      const t = sky.sunT || [1, 1, 1], tp = sky.top || [0.3, 0.5, 0.9], av = sky.avg || tp;
      const lin = v => Math.pow(Math.max(0, v), 2.2);
      U.uSunC.value.set(t[0], t[1], t[2]);
      U.uAmb.value.set(lin(av[0]) * 0.55 + lin(tp[0]) * 0.45, lin(av[1]) * 0.55 + lin(tp[1]) * 0.45, lin(av[2]) * 0.55 + lin(tp[2]) * 0.45).multiplyScalar(1.1);
    }
    // night: moonlit clouds (the sky's sun is under the horizon)
    const vs = SS.view && SS.view.state;
    if (vs && vs.tod === 'night' && vs.moonDir) { U.uSun.value.set(vs.moonDir[0], vs.moonDir[1], vs.moonDir[2]).normalize(); U.uSunC.value.set(0.12, 0.15, 0.24); U.uAmb.value.set(0.03, 0.04, 0.065); }
    CL.count = n;
  };

  /* per frame: drift with the wind aloft (2x the surface wind), time, sort far-to-near every 0.5 s */
  let drift = new T.Vector2();
  CL.frame = function (S, view, camera, dt) {
    if (!mesh || !n) return;
    const w = S.wind, sp = w ? Math.max(2, w.speed) * 2 : 4, dir = w ? w.dir : 0.7;
    drift.x += Math.cos(dir) * sp * dt; drift.y += Math.sin(dir) * sp * dt;
    U.uDrift.value.copy(drift); U.uTime.value = view.time; U.uWind.value.set(Math.cos(dir), Math.sin(dir)); U.uCam.value.copy(camera.position);
    if (view.time - sortT > 0.5 || sortT < 0) { sortT = view.time; sortNow(camera.position); }
  };
  const dist = new Float32Array(MAXN);
  function sortNow(cp) {
    const F = FIELD, dx0 = drift.x, dz0 = drift.y;
    for (let i = 0; i < n; i++) {
      const pl = I.v[i * 2] !== 0;
      let rx = I.pos[i * 4] + (pl ? 0 : dx0) - cp.x, rz = I.pos[i * 4 + 2] + (pl ? 0 : dz0) - cp.z;
      rx = ((rx + F) % (2 * F) + 2 * F) % (2 * F) - F; rz = ((rz + F) % (2 * F) + 2 * F) % (2 * F) - F;
      const ry = I.pos[i * 4 + 1] - cp.y; dist[i] = rx * rx + ry * ry + rz * rz;
    }
    order.sort((a, b) => dist[b] - dist[a]);
    const P = geo.attributes.iPos.array, A = geo.attributes.iA.array, Sx = geo.attributes.iS.array, V = geo.attributes.iV.array;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      for (let c = 0; c < 4; c++) { P[k * 4 + c] = I.pos[i * 4 + c]; A[k * 4 + c] = I.a[i * 4 + c]; Sx[k * 4 + c] = I.s[i * 4 + c]; }
      V[k * 2] = I.v[i * 2]; V[k * 2 + 1] = I.v[i * 2 + 1];
    }
    for (const k of ['iPos', 'iA', 'iS', 'iV']) geo.attributes[k].needsUpdate = true;
  }
  CL.stats = () => ({ n, vis: U.uVis.value });
  CL.drift = () => drift;
  CL.plume = () => plumeAt;          // the volcanic plume's vent (far volcano, render/farland.js)
  CL.mesh = () => mesh;
  CL.uniforms = U;
})(window.SS = window.SS || {});
