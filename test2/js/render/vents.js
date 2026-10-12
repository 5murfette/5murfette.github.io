/* render/vents.js — fumaroles / thermal vents of the volcanic island (P25; positions from worldgen F.vents): a
 * crater in the terrain shader (P90) and a continuous gas plume. P29g (user 2026-10-08:
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
      return d * (1.0 - smoothstep(0.55, 1.0, hn)) * smoothstep(0.0, 0.55, hh);
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
  let QQ = null;
  VV.init = function (sc, Q) { scene = sc; QQ = Q || null; };
  VV.reset = function (S) {
    lastT = -1;
    if (SS.terrain && SS.terrain.uniforms && SS.terrain.uniforms.uNVent) SS.terrain.uniforms.uNVent.value = 0;
    if (group) { scene.remove(group); group.traverse(o => { if (o.isMesh && o.geometry && o.geometry !== plumeGeo) o.geometry.dispose(); if (o.isMesh && o.material && o.material.isShaderMaterial) o.material.dispose(); }); }
    group = new T.Group(); scene.add(group); list = [];
    const F = SS.world.features || {};
    for (const v of F.vents || []) {
      if (v.kind !== 'fumarole') continue;
      const y = SS.world.top_at(v.x, v.z);
      const seed = Math.random() * 10, pl = plume({ x: v.x, y: y + 0.12, z: v.z, seed }); group.add(pl);
      list.push({ x: v.x, y, z: v.z, pl, seed: seed * 0.1 + 0.03, shown: true, rise: 0, ax: 0, az: 0 });
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
      v.shown = SS.view.shownAt(S, v, 0.8);
      const near = v.shown && Math.hypot(v.x - cp.x, v.z - cp.z) <= 70;
      v.pl.visible = near;
      if (!near) continue;
      v.y = SS.world.top_at(v.x, v.z);                                  // follows the ground (a blast may lower it)
      v.rise += 1.05 * fdt; v.ax += sw.x * 0.5 * fdt; v.az += sw.z * 0.5 * fdt;
      const U = v.pl.material.uniforms;
      U.uBase.value.set(v.x, v.y + 0.04, v.z); U.uRise.value = v.rise; U.uLight.value.copy(Lc);
      U.uAdv.value.set(v.ax, v.az); U.uShear.value.set(sw.x * 0.5, sw.z * 0.5); U.uGlow.value = 0.35 * night;
      if (sun) U.uSun.value.copy(sun.position).sub(sun.target.position).normalize();
    }
    /* P90: the crater / heat stain / sulphur dusting live in the terrain shader: hand it the vents within 90 m of the camera */
    const TU = SS.terrain && SS.terrain.uniforms; if (!TU || !TU.uVent) return;
    let nv = 0;
    for (const v of list) {
      if (nv >= 8 || !v.shown || Math.hypot(v.x - cp.x, v.z - cp.z) > 90) continue;
      TU.uVent.value[nv++].set(v.x, SS.world.top_at(v.x, v.z), v.z, v.seed);
    }
    TU.uNVent.value = nv; TU.uVentHot.value = 0.08 * night;
  };
  /* heat haze over the vents (render/lens.js list: x, y, z, strength): the two nearest vents in view, high quality with ?haze=1 only */
  const hz = { n: 0, d: new Float32Array(8) };
  VV.haze = function (camera) {
    hz.n = 0;
    for (const v of list) if (v.pl.visible && hz.n < 2 && Math.hypot(v.x - camera.position.x, v.z - camera.position.z) < 40) { hz.d.set([v.x, v.y + 0.7, v.z, 0.45], hz.n * 4); hz.n++; }
    return hz;
  };
})(window.SS = window.SS || {});
