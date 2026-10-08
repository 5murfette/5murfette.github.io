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
  let scene = null, group = null, list = [], MAT = null, THROAT = null, hemi = null, sun = null;
  const PLUME_H = 7;                                        // m
  const plumeGeo = (() => { const g = new T.PlaneGeometry(2, 1, 1, 24); g.translate(0, 0.5, 0); return g; })();   // x -1..1, y 0..1
  const PLUME_V = /* glsl */`
    uniform vec3 uBase; uniform vec2 uWind; uniform float uH;
    varying vec2 vUv; varying float vW;
    void main(){
      float h = position.y * uH, w = 0.16 + h * 0.11;                     // the plume widens as it rises
      vec2 drift = uWind * h * h / uH * 0.4;                              // and bends downwind
      vec3 r = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));  // camera right, horizontal: faces the camera
      vec3 p = uBase + vec3(drift.x, h, drift.y) + r * position.x * w * 2.2;
      vUv = vec2(position.x, position.y); vW = w;
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`;
  const PLUME_F = /* glsl */`
    uniform sampler2D tNoise; uniform float uTime, uSeed; uniform vec3 uLight;
    varying vec2 vUv; varying float vW;
    void main(){
      float h = vUv.y, x = vUv.x;
      // noise advected upward (faster near the hot throat), domain-warped: billows and wisps, never repeating puffs
      vec2 q = vec2(x * vW * 1.4 + uSeed, h * 5.5 - uTime * (0.55 - 0.25 * h));
      vec2 wq = (texture2D(tNoise, q * 0.11 + vec2(0.0, uTime * 0.02)).rg - 0.5) * 1.1;
      float n = texture2D(tNoise, q * 0.19 + wq).r * 0.55 + texture2D(tNoise, q * 0.43 - wq * 0.6).g * 0.3 + texture2D(tNoise, q * 0.97).b * 0.15;
      // the column meanders (turbulent eddies grow with height) and breaks into wisps
      float sway = (texture2D(tNoise, vec2(h * 0.9 - uTime * 0.12, uSeed * 0.37)).r - 0.5) * 1.6 * h + (texture2D(tNoise, vec2(h * 2.3 - uTime * 0.3, uSeed * 0.71)).g - 0.5) * 0.5 * h;
      float xs = x - sway;
      float prof = exp(-xs * xs * (3.2 - 1.8 * h));                       // a tight core at the throat, diffuse higher up
      float d = prof * smoothstep(0.0, 0.04, h) * (1.0 - smoothstep(0.18, 0.7, h)) * smoothstep(0.28, 0.7, n + 0.34 * (1.0 - h) - 0.12 * h);
      float a = d * (0.68 - 0.62 * h);
      if (a < 0.004) discard;
      vec3 c = mix(vec3(0.96, 0.92, 0.74), vec3(0.93, 0.94, 0.96), smoothstep(0.0, 0.25, h));   // sulphur-tinged at the throat
      gl_FragColor = vec4(c * uLight * (0.85 + 0.3 * n), a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  function plume(v) {
    const m = new T.Mesh(plumeGeo, new T.ShaderMaterial({
      uniforms: { uBase: { value: new T.Vector3(v.x, v.y, v.z) }, uWind: { value: new T.Vector2() }, uH: { value: PLUME_H }, tNoise: { value: SS.terrain.uniforms.tNoise.value },
        uTime: { value: 0 }, uSeed: { value: Math.random() * 10 }, uLight: { value: new T.Color(1, 1, 1) } },
      vertexShader: PLUME_V, fragmentShader: PLUME_F, transparent: true, depthWrite: false, side: T.DoubleSide }));
    m.frustumCulled = false; m.renderOrder = 7.2;
    return m;
  }
  VV.init = function (sc) { scene = sc; };
  // ASSET: fumarole (models/fumarole.glb; the steam stays VFX)
  function mound() {
    if (!MAT) {
      MAT = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
      THROAT = new T.MeshStandardMaterial({ color: 0x1a1612, roughness: 1, emissive: 0x3a1a06, emissiveIntensity: 0.6 });
    }
    const g = new T.ConeGeometry(0.75, 0.32, 18, 3, true), pa = g.attributes.position, col = new Float32Array(pa.count * 3);
    for (let i = 0; i < pa.count; i++) {
      const y = pa.getY(i), rim = (y + 0.16) / 0.32, n = Math.random();
      pa.setX(i, pa.getX(i) * (0.85 + 0.3 * n)); pa.setZ(i, pa.getZ(i) * (0.85 + 0.3 * n));
      const c = rim > 0.6 ? [0.93, 0.86, 0.35] : rim > 0.3 ? [0.82, 0.74, 0.42] : [0.36, 0.32, 0.27];   // sulphur crust at the mouth
      col[i * 3] = c[0] * (0.85 + 0.25 * n); col[i * 3 + 1] = c[1] * (0.85 + 0.25 * n); col[i * 3 + 2] = c[2] * (0.85 + 0.25 * n);
    }
    g.setAttribute('color', new T.BufferAttribute(col, 3)); g.computeVertexNormals();
    const m = new T.Group(), body = new T.Mesh(g, MAT); body.receiveShadow = true; m.add(body);
    const th = new T.Mesh(new T.CircleGeometry(0.16, 12), THROAT); th.rotation.x = -Math.PI / 2; th.position.y = 0.155; m.add(th);
    return m;
  }
  VV.reset = function (S) {
    if (group) { scene.remove(group); group.traverse(o => { if (o.isMesh && o.geometry && o.geometry !== plumeGeo) o.geometry.dispose(); if (o.isMesh && o.material && o.material.isShaderMaterial) o.material.dispose(); }); }
    group = new T.Group(); scene.add(group); list = [];
    const F = SS.world.features || {};
    for (const v of F.vents || []) {
      if (v.kind !== 'fumarole') continue;
      const y = SS.world.top_at(v.x, v.z), m = mound(); m.position.set(v.x, y - 0.12, v.z); group.add(m);
      const pl = plume({ x: v.x, y: y + 0.12, z: v.z }); group.add(pl);
      list.push({ x: v.x, y, z: v.z, m, pl });
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
    for (const v of list) {
      v.m.visible = SS.view.shownAt(S, v, 0.8);
      const near = v.m.visible && Math.hypot(v.x - cp.x, v.z - cp.z) <= 70;
      v.pl.visible = near;
      if (!near) continue;
      v.y = SS.world.top_at(v.x, v.z); v.m.position.y = v.y - 0.12;     // follows the ground (a blast may lower it)
      const U = v.pl.material.uniforms;
      U.uBase.value.set(v.x, v.y + 0.04, v.z); U.uTime.value = t; U.uLight.value.copy(Lc);
      U.uWind.value.set(wm ? M_clamp(wm.x, -6, 6) * 0.25 : 0.15, wm ? M_clamp(wm.z, -6, 6) * 0.25 : 0.05);
    }
  };
})(window.SS = window.SS || {});
