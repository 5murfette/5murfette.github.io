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
  const PLUME_H = 5.5, PLUME_W = 3.6;                      // m: the billboard that carries the wisp
  const plumeGeo = (() => { const g = new T.PlaneGeometry(2, 1, 1, 1); g.translate(0, 0.5, 0); return g; })();   // x -1..1, y 0..1
  /* P110 (user 2026-10-12: "the vents are too cpu consuming, just make a normal barely visible steam"): the P87 plume raymarched a
   * 3-D density field (up to 12 steps x 3-4 noise taps + a sun tap per pixel on a 9 x 7 m billboard). Now a flat wisp: two noise
   * taps per pixel, a soft column that widens and leans with the wind, at most ~16 % opacity, on a smaller billboard. */
  const PLUME_V = /* glsl */`
    uniform vec3 uBase; uniform float uH, uW;
    varying vec2 vUv;
    void main(){
      vec3 r = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));  // camera right, horizontal: the billboard faces the camera
      vec3 p = uBase + vec3(0.0, position.y * uH - 0.2, 0.0) + r * position.x * uW * 0.5;
      vUv = vec2(position.x, position.y);
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`;
  const PLUME_F = /* glsl */`
    uniform sampler2D tNoise; uniform float uRise, uSeed, uGlow, uLean; uniform vec3 uLight;
    varying vec2 vUv;
    void main(){
      float h = vUv.y, x = vUv.x;
      vec2 q = vec2(x * 0.45 + uSeed, h * 0.9 - uRise);
      float n = texture2D(tNoise, q).r * 0.65 + texture2D(tNoise, q * 2.3 + vec2(0.37, 0.71)).r * 0.35;
      float R = 0.14 + 0.6 * h;                                            // the column widens as it mixes
      float r = (x - uLean * h * h - (n - 0.5) * 0.5 * h) / R;
      float d = exp(-r * r * 2.2) * smoothstep(0.3, 0.72, n + 0.22 * (1.0 - h));
      d *= smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.4, 1.0, h));
      float a = d * 0.16;
      if (a < 0.004) discard;
      vec3 c = uLight * mix(vec3(0.97, 0.94, 0.8), vec3(0.95, 0.96, 0.97), smoothstep(0.0, 0.25, h)) + vec3(1.0, 0.42, 0.12) * uGlow * exp(-h * 7.0);
      gl_FragColor = vec4(c, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  function plume(v) {
    const m = new T.Mesh(plumeGeo, new T.ShaderMaterial({
      uniforms: { uBase: { value: new T.Vector3(v.x, v.y, v.z) }, uH: { value: PLUME_H }, uW: { value: PLUME_W }, tNoise: { value: SS.terrain.uniforms.tNoise.value },
        uRise: { value: 0 }, uSeed: { value: v.seed }, uLean: { value: 0 }, uLight: { value: new T.Color(1, 1, 1) }, uGlow: { value: 0 } },
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
      list.push({ x: v.x, y, z: v.z, pl, seed: seed * 0.1 + 0.03, shown: true, rise: 0 });
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
    const me = camera.matrixWorld.elements, rl = Math.hypot(me[0], me[2]) || 1, rx = me[0] / rl, rz = me[2] / rl;   // camera right, horizontal
    for (const v of list) {
      v.shown = SS.view.shownAt(S, v, 0.8);
      const near = v.shown && Math.hypot(v.x - cp.x, v.z - cp.z) <= 70;
      v.pl.visible = near;
      if (!near) continue;
      v.y = SS.world.top_at(v.x, v.z);                                  // follows the ground (a blast may lower it)
      v.rise += 0.16 * fdt;
      const U = v.pl.material.uniforms;
      U.uBase.value.set(v.x, v.y + 0.04, v.z); U.uRise.value = v.rise; U.uLight.value.copy(Lc); U.uGlow.value = 0.25 * night;
      U.uLean.value = M_clamp((sw.x * rx + sw.z * rz) * 0.09, -0.7, 0.7);   // the wind across the view leans the wisp
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
