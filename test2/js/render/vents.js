/* render/vents.js — fumaroles / thermal vents of the volcanic island (P25; positions from worldgen F.vents): a low
 * mound of sulphur-crusted rock (yellow-white crust, a dark throat) and a continuous gas plume. P29g (user 2026-10-08:
 * "make the gas coming from the vents more realistic"; it was a few steam puffs per second, popping): a procedural plume
 * per vent, a camera-facing ribbon PLUME_H m tall whose density is noise advected upward (domain-warped, 3 octaves),
 * narrow and faintly sulphur-yellow at the throat, widening, thinning and bending with the wind as it rises, lit by the
 * scene's sun + sky (the old fx.steam puffs on top read as dark blotches at dusk: dropped). Only within 70 m of the camera.
 * Presentation only (Math.random is fine). Porting: one billboard + a noise shader per vent (or a particle VFX).
 * API: SS.ventsView.init(scene), reset(S), frame(S, view, camera, dt). */
(function (SS) {
  'use strict';
  const T = window.THREE, VV = SS.ventsView = {};
  const M_clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  let lastT = -1; const sw = { x: 0.4, z: 0.1 }, smooth = (a, b, x) => { const t = M_clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  let scene = null, group = null, list = [], MAT = null, THROAT = null, hemi = null, sun = null;
  const PLUME_H = 9, PLUME_W = 7;                          // m: the billboard that carries the raymarched plume
  const plumeGeo = (() => { const g = new T.PlaneGeometry(2, 1, 1, 1); g.translate(0, 0.5, 0); return g; })();   // x -1..1, y 0..1
  /* P87 (user 2026-10-12: "volcanic vents steam needs to be more realistic, better textured"): the old plume was a flat ribbon of
   * 2-D noise. Now a short raymarch through a procedural 3-D density field on a camera-facing billboard: a buoyant column whose
   * radius grows with height (entrainment of cool air), billowing lobes (domain-warped 3-D value noise), the pattern rising at a
   * constant buoyant speed and carried by the (smoothed, integrated) wind, which also shears the axis; the condensate thins out
   * as it mixes (density threshold rises with height); lit by sun + sky with one self-shadow tap toward the sun; sulphur-yellow
   * at the throat; a faint warm glow over the throat at night. Phases are CPU integrals (no time * rate products). */
  const PLUME_V = /* glsl */`
    uniform vec3 uBase; uniform float uH, uW;
    varying vec3 vP;
    void main(){
      vec3 r = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));  // camera right, horizontal: the billboard faces the camera
      vec3 p = uBase + vec3(0.0, position.y * uH - 0.3, 0.0) + r * position.x * uW * 0.5;
      vP = p;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`;
  const PLUME_F = /* glsl */`
    uniform sampler2D tNoise; uniform float uRise, uSeed, uH, uGlow; uniform vec2 uAdv, uShear; uniform vec3 uBase, uLight, uSun;
    varying vec3 vP;
    float n3(vec3 q){                                                       // 3-D value noise from the 2-D noise texture: two slices, lerped in y
      float y = q.y, fy = fract(y), iy = floor(y); fy = fy * fy * (3.0 - 2.0 * fy);
      float a = texture2D(tNoise, q.xz * 0.37 + vec2(0.37, 0.71) * iy).r, b = texture2D(tNoise, q.xz * 0.37 + vec2(0.37, 0.71) * (iy + 1.0)).r;
      return mix(a, b, fy);
    }
    float dens(vec3 p, bool full){
      float hh = p.y - uBase.y, hn = clamp(hh / uH, 0.0, 1.0);
      if (hh < -0.1 || hh > uH) return 0.0;
      vec2 ax = uBase.xz + uShear * hh * hh * 0.06;                         // wind shear: the axis leans harder with height
      float R = 0.2 + 0.19 * pow(max(hh, 0.0), 0.92);                       // entrainment: the plume widens roughly linearly
      vec3 q = vec3(p.x - uAdv.x, p.y * 1.0 - uRise, p.z - uAdv.y) * 1.15 + uSeed;
      float w1 = n3(q * 0.7) - 0.5;
      vec2 off = vec2(w1, n3(q * 0.7 + 5.2) - 0.5) * (0.4 + 1.1 * hn);      // meander, growing with height
      float r = length(p.xz - ax - off * 0.9);
      float n = n3(q + w1 * 1.6) * 0.62 + n3(q * 2.1 + 3.7) * 0.3 + (full ? n3(q * 4.3 + 9.1) * 0.18 : 0.09);   // billows + fine wisps
      float core = exp(-(r * r) / (R * R) * 1.7);
      float thr = 0.27 + 0.5 * hn;                                          // condensation: the vapour re-evaporates as it mixes
      float d = core * smoothstep(thr, thr + 0.34, n + 0.22 * (1.0 - hn) * core);
      return d * (1.0 - smoothstep(0.55, 1.0, hn)) * smoothstep(-0.1, 0.12, hh);
    }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec3 ro = cameraPosition, rd = normalize(vP - ro);
      float t0 = length(vP - ro), hz = 2.6, st = 2.0 * hz / float(STEPS);
      float T = 1.0; vec3 acc = vec3(0.0);
      float jit = hash(gl_FragCoord.xy);
      for (int i = 0; i < STEPS; i++){
        vec3 p = ro + rd * (t0 - hz + (float(i) + jit) * st);
        float d = dens(p, STEPS > 6);
        if (d < 0.01) continue;
        float hn = clamp((p.y - uBase.y) / uH, 0.0, 1.0);
        float dl = dens(p + uSun * 0.8, false);                              // one tap toward the sun: the lit side of a billow, the shaded belly
        float sh = exp(-2.4 * dl);
        vec3 c = uLight * (0.5 + 0.75 * sh) * mix(vec3(0.98, 0.93, 0.7), vec3(0.94, 0.95, 0.97), smoothstep(0.0, 0.2, hn));
        c *= 1.0 - 0.18 * smoothstep(0.0, 1.0, d) * (1.0 - sh);              // a dense core is greyer than its edges
        c += vec3(1.0, 0.42, 0.12) * uGlow * exp(-hn * 7.0) * 0.9;           // hot glow over the throat at night
        float sg = 2.1 * d * st;
        float a = 1.0 - exp(-sg);
        acc += T * a * c; T *= 1.0 - a;
        if (T < 0.03) break;
      }
      float al = 1.0 - T;
      if (al < 0.004) discard;
      gl_FragColor = vec4(acc / max(al, 1e-3), al * 0.92);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  /* sulphur deposits on the ground around the vent mouth: a terrain-draped polar patch, noisy broken edge, crystalline specks */
  const DEP_V = /* glsl */`
    attribute float rho; varying float vR; varying vec2 vXZ;
    void main(){ vR = rho; vXZ = (modelMatrix * vec4(position, 1.0)).xz; gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); }`;
  const DEP_F = /* glsl */`
    uniform sampler2D tNoise; uniform vec3 uLight; uniform float uSeed; varying float vR; varying vec2 vXZ;
    void main(){
      float n1 = texture2D(tNoise, vXZ * 0.55 + uSeed).r, n2 = texture2D(tNoise, vXZ * 1.7 + 0.31).g, n3 = texture2D(tNoise, vXZ * 5.3).b, n4 = texture2D(tNoise, vXZ * 13.0 + 0.7).r;
      float crack = smoothstep(0.035, 0.0, abs(n2 - 0.5));                          // thin cracks in the crust
      float cover = (1.0 - smoothstep(0.08, 0.95, vR)) * (0.55 + 0.9 * n1) - 0.38 * n3 - 0.2 * crack;   // dense at the rim, breaking up into patches outward
      float a = smoothstep(0.05, 0.4, cover) * (0.35 + 0.4 * n4) ;
      if (a < 0.02) discard;
      vec3 ochre = vec3(0.62, 0.45, 0.12), pale = vec3(0.82, 0.76, 0.42), ash = vec3(0.3, 0.29, 0.27), white = vec3(0.9, 0.88, 0.8);
      vec3 col = mix(ochre, pale, smoothstep(0.3, 0.8, n4 * 0.6 + n2 * 0.5));
      col = mix(col, ash, smoothstep(0.6, 0.85, n1) * 0.18 + 0.08 * smoothstep(0.5, 1.0, vR));           // part mixed with grey ash
      col = mix(col, white, smoothstep(0.8, 0.95, n3 * 0.5 + n4 * 0.5) * 0.5);                           // white efflorescence specks
      col *= 0.8 + 0.4 * n4;
      gl_FragColor = vec4(col * uLight * 0.7, a * 0.5);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  function depositGeo(x, z, R) {
    const NR = 7, NA = 28, P = [], H = [], I = [];
    for (let r = 0; r <= NR; r++) for (let a = 0; a <= NA; a++) {
      const rho = r / NR, ang = a / NA * 6.2832, px = x + Math.cos(ang) * rho * R, pz = z + Math.sin(ang) * rho * R;
      P.push(px - x, SS.world.top_at(px, pz) + 0.04, pz - z); H.push(rho);
    }
    for (let r = 0; r < NR; r++) for (let a = 0; a < NA; a++) { const v = r * (NA + 1) + a; I.push(v, v + 1, v + NA + 2, v, v + NA + 2, v + NA + 1); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array(P), 3)); g.setAttribute('rho', new T.BufferAttribute(new Float32Array(H), 1)); g.setIndex(I);
    return g;
  }
  function plume(v) {
    const q = QQ && QQ.particles || 1, steps = q >= 0.95 ? 12 : q >= 0.6 ? 8 : 5;
    const m = new T.Mesh(plumeGeo, new T.ShaderMaterial({
      uniforms: { uBase: { value: new T.Vector3(v.x, v.y, v.z) }, uH: { value: PLUME_H }, uW: { value: PLUME_W }, tNoise: { value: SS.terrain.uniforms.tNoise.value },
        uRise: { value: 0 }, uSeed: { value: v.seed }, uAdv: { value: new T.Vector2() }, uShear: { value: new T.Vector2() }, uSun: { value: new T.Vector3(0, 1, 0) },
        uLight: { value: new T.Color(1, 1, 1) }, uGlow: { value: 0 } },
      defines: { STEPS: steps },
      vertexShader: PLUME_V, fragmentShader: PLUME_F, transparent: true, depthWrite: false, side: T.DoubleSide }));
    m.frustumCulled = false; m.renderOrder = 7.2;
    return m;
  }
  function deposit(v) {
    const m = new T.Mesh(depositGeo(v.x, v.z, 1.5), new T.ShaderMaterial({
      uniforms: { tNoise: { value: SS.terrain.uniforms.tNoise.value }, uLight: { value: new T.Color(1, 1, 1) }, uSeed: { value: v.seed } },
      vertexShader: DEP_V, fragmentShader: DEP_F, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.position.set(v.x, 0, v.z); m.frustumCulled = false; m.renderOrder = 3;
    return m;
  }
  let QQ = null;
  VV.init = function (sc, Q) { scene = sc; QQ = Q || null; };
  // ASSET: fumarole (models/fumarole.glb; the steam stays VFX)
  function mound() {
    if (!MAT) {
      MAT = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: false, side: T.DoubleSide });
      THROAT = new T.MeshStandardMaterial({ color: 0x1a1612, roughness: 1, emissive: 0x3a1a06, emissiveIntensity: 0.6 });
    }
    // a crater: raised crusty rim, a dark throat. Lathe profile (r, y), irregular rim radius / height, rock-coloured with ochre crust and soot / heat staining
    const prof = [[0.95, -0.06], [0.78, 0.0], [0.6, 0.05], [0.46, 0.08], [0.36, 0.06], [0.28, -0.02], [0.2, -0.14], [0.11, -0.26], [0.001, -0.3]].map(q => new T.Vector2(q[0], q[1]));
    const g = new T.LatheGeometry(prof, 56), pa = g.attributes.position, col = new Float32Array(pa.count * 3), ph = Math.random() * 6;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i), a = Math.atan2(z, x), r = Math.hypot(x, z), jit = 1 + 0.12 * Math.sin(a * 3 + ph) + 0.08 * Math.sin(a * 7 + ph * 2) + 0.05 * (Math.random() - 0.5);
      pa.setX(i, x * jit); pa.setZ(i, z * jit); pa.setY(i, y + (r > 0.25 && r < 0.9 ? 0.025 * Math.sin(a * 5 + ph) + 0.03 * Math.random() : 0));
      const rim = Math.max(0, 1 - Math.abs(r - 0.46) / 0.3), thr = Math.max(0, 1 - r / 0.3), n = 0.8 + 0.4 * Math.random();
      let cr = 0.035 + 0.01 * rim, cg = 0.034 + 0.01 * rim, cb = 0.036;                       // basalt
      { const p = Math.max(0, Math.sin(a * 4 + ph) * Math.sin(a * 9 + ph * 3) + 0.2 * Math.random()); cr += rim * 0.1 * p; cg += rim * 0.07 * p; cb += rim * 0.01 * p; }   // an ochre sulphur crust on the rim, in patches
      cr *= 1 - 0.7 * thr; cg *= 1 - 0.7 * thr; cb *= 1 - 0.6 * thr;                      // sooty, heat-stained throat
      col[i * 3] = cr * n; col[i * 3 + 1] = cg * n; col[i * 3 + 2] = cb * n;
    }
    g.setAttribute('color', new T.BufferAttribute(col, 3)); g.computeVertexNormals();
    const m = new T.Group(), body = new T.Mesh(g, MAT); body.receiveShadow = true; m.add(body);
    return m;
  }
  VV.reset = function (S) {
    lastT = -1;
    if (group) { scene.remove(group); group.traverse(o => { if (o.isMesh && o.geometry && o.geometry !== plumeGeo) o.geometry.dispose(); if (o.isMesh && o.material && o.material.isShaderMaterial) o.material.dispose(); }); }
    group = new T.Group(); scene.add(group); list = [];
    const F = SS.world.features || {};
    for (const v of F.vents || []) {
      if (v.kind !== 'fumarole') continue;
      const y = SS.world.top_at(v.x, v.z), m = mound(); m.position.set(v.x, y - 0.06, v.z); group.add(m);
      const seed = Math.random() * 10, pl = plume({ x: v.x, y: y + 0.12, z: v.z, seed }); group.add(pl);
      const dp = deposit({ x: v.x, z: v.z, seed }); group.add(dp);
      list.push({ x: v.x, y, z: v.z, m, pl, dp, rise: 0, ax: 0, az: 0 });
    }
  };
  VV.frame = function (S, view, camera, dt) {
    if (!list.length || !SS.fx) return;
    const cp = camera.position;
    // the plume's light: sky (hemisphere) + a share of the sun (day / dusk / night follow the scene's lights)
    if (!hemi) scene.traverse(o => { if (o.isHemisphereLight && !hemi) hemi = o; if (o.isDirectionalLight && !sun) sun = o; });
    const Lc = new T.Color(0.5, 0.5, 0.5);
    if (hemi) Lc.copy(hemi.color).multiplyScalar(hemi.intensity * 0.8);   // (steam scatters a lot: it is never darker than the sky behind)
    if (sun) Lc.add(sun.color.clone().multiplyScalar(sun.intensity * 0.25));
    const wm = S.wind && S.wind.mean, t = (view && view.time) || 0;
    const fdt = lastT < 0 ? 0 : Math.min(0.1, Math.max(0, t - lastT)); lastT = t;          // render clock (slow-mo aware)
    // the wind felt by the plume: low-passed (tc 4 s), capped; its integral is the downwind advection of the billows
    const kw = 1 - Math.exp(-fdt / 4); sw.x += ((wm ? M_clamp(wm.x, -8, 8) : 0.4) - sw.x) * kw; sw.z += ((wm ? M_clamp(wm.z, -8, 8) : 0.1) - sw.z) * kw;
    const lum = (Lc.r + Lc.g + Lc.b) / 3, night = 1 - smooth(0.12, 0.5, lum);
    for (const v of list) {
      v.m.visible = SS.view.shownAt(S, v, 0.8);
      const near = v.m.visible && Math.hypot(v.x - cp.x, v.z - cp.z) <= 70;
      v.pl.visible = near; v.dp.visible = v.m.visible && Math.hypot(v.x - cp.x, v.z - cp.z) <= 90;
      if (v.dp.visible) v.dp.material.uniforms.uLight.value.copy(Lc);
      if (!near) continue;
      v.y = SS.world.top_at(v.x, v.z); v.m.position.y = v.y - 0.06;     // follows the ground (a blast may lower it)
      v.rise += 1.05 * fdt; v.ax += sw.x * 0.5 * fdt; v.az += sw.z * 0.5 * fdt;
      const U = v.pl.material.uniforms;
      U.uBase.value.set(v.x, v.y + 0.04, v.z); U.uRise.value = v.rise; U.uLight.value.copy(Lc);
      U.uAdv.value.set(v.ax, v.az); U.uShear.value.set(sw.x * 0.5, sw.z * 0.5); U.uGlow.value = 0.35 * night;
      if (sun) U.uSun.value.copy(sun.position).sub(sun.target.position).normalize();
    }
  };
  /* heat haze over the vents (render/lens.js list: x, y, z, strength): the two nearest vents in view, high quality with ?haze=1 only */
  const hz = { n: 0, d: new Float32Array(8) };
  VV.haze = function (camera) {
    hz.n = 0;
    for (const v of list) if (v.pl.visible && hz.n < 2 && Math.hypot(v.x - camera.position.x, v.z - camera.position.z) < 40) { hz.d.set([v.x, v.y + 0.7, v.z, 0.45], hz.n * 4); hz.n++; }
    return hz;
  };
})(window.SS = window.SS || {});
