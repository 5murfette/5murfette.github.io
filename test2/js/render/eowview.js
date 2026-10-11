/* render/eowview.js — P68c EXPERIMENTAL biome "End of the World": the space look (presentation only; sim/eow.js has the rules).
 * Everything is procedural (shaders and math, no images, fire included):
 *   - the sky dome: stars (three layers), a nebula band, a harsh sun with a corona, a dark moon lit by it, a thin asteroid belt, all slowly
 *     tumbling (the "rotation" of the world: the sim's chunks are static, the sky, the sun and the far debris turn);
 *   - the core: the glowing remnant of the planet, a lava ball (domain-warped noise, cracks, a hot rim) with a billboard halo and a
 *     flickering corona; it lights the chunks' broken faces with an orange point light (the view's `lamp`);
 *   - far debris: an asteroid ring around the core, big silhouettes and small drifting scrap (one InstancedMesh, flat shaded lumps);
 *   - the lights: a hard white sun, a very dark blue ambient, a violet rim light from the nebula side; the terrain haze is black.
 * Hooks (view.js): eowView.frame(...) each frame when S.eow, eowView.reset(S) on a new world (restores the normal look),
 * softview.js: eowView.goal (the muscle pose without the jelly solver), actors.js: eowView.orient (the worm lies along its surface).
 * Removal: delete this file and the hooks listed in docs/notes/P68c.md. Porting: shaders port 1:1; the rest is plain math. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math, C = SS.CFG;
  const EV = SS.eowView = {};
  let built = null, saved = null, lastGrade = -1;

  const NOISE = /* glsl */`
    float h13(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
    float vn(vec3 p){
      vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
  `;
  const SKY_V = 'varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }';
  const SKY_F = /* glsl */`
    uniform float uTime; uniform vec3 uSun, uMoon, uBeltN; uniform mat3 uRot;
    varying vec3 vD;
    ${NOISE}
    vec3 starLayer(vec3 d, float sc, float thr, float size, float gain){
      vec3 p = d * sc, i = floor(p), f = fract(p);
      float h = h13(i); if (h < thr) return vec3(0.0);
      vec3 o = vec3(h13(i + 7.1), h13(i + 13.7), h13(i + 3.3));
      float b = smoothstep(size, 0.0, length(f - (0.2 + 0.6 * o)));
      float t = h13(i + 1.7);
      b *= gain * (0.35 + 1.7 * pow(h13(i + 9.9), 3.0)) * (0.8 + 0.2 * sin(uTime * (1.0 + 3.0 * h13(i + 2.2)) + h * 40.0));
      return mix(vec3(0.62, 0.74, 1.0), vec3(1.0, 0.8, 0.58), t) * b;
    }
    void main(){
      vec3 d = normalize(vD), q = uRot * d;
      vec3 col = vec3(0.004, 0.005, 0.013);
      float band = exp(-pow(dot(q, normalize(vec3(0.3, 0.9, 0.25))) / 0.3, 2.0));
      float n1 = fbm(q * 2.1 + vec3(0.0, uTime * 0.003, 0.0)), n2 = fbm(q * 4.7 + 11.0), dust = 0.55 + 0.9 * fbm(q * 9.0 + 3.0);
      col += (mix(vec3(0.02, 0.03, 0.08), vec3(0.42, 0.09, 0.28), smoothstep(0.35, 0.8, n1)) * band * 1.1
            + vec3(0.04, 0.26, 0.34) * smoothstep(0.5, 0.9, n2) * band * 0.55
            + vec3(0.9, 0.33, 0.12) * pow(smoothstep(0.55, 0.95, n1 * n2 * 1.9), 2.0) * band * 0.45) * dust * 0.55;
      col += starLayer(q, 28.0, 0.93, 0.19, 2.2) + starLayer(q, 70.0, 0.945, 0.19, 1.5) + starLayer(q, 170.0, 0.965, 0.19, 1.1);
      col += vec3(0.03, 0.05, 0.1) * band * smoothstep(0.55, 0.9, vn(q * 120.0));
      // the asteroid belt: a thin great circle of specks and dust
      float bn = dot(d, uBeltN), bb = exp(-pow(bn / 0.04, 2.0));
      vec3 bp = d * 230.0, bi = floor(bp); float bh = h13(bi + 5.0);
      col += vec3(0.75, 0.62, 0.5) * bb * smoothstep(0.55, 0.9, bh) * smoothstep(0.3, 0.0, length(fract(bp) - 0.5)) * 2.2;
      col += vec3(0.16, 0.11, 0.08) * bb * (0.4 + fbm(d * 26.0)) * 0.5;
      // the moon: a dark body lit by the sun
      float cm = dot(d, uMoon), rad = 0.075, crad = cos(rad);
      if (cm > crad - 0.002) {
        vec3 t1 = normalize(cross(uMoon, vec3(0.0, 1.0, 0.1))), t2 = cross(uMoon, t1);
        vec2 uv = vec2(dot(d, t1), dot(d, t2)) / sin(rad); float r2 = dot(uv, uv);
        vec3 nr = normalize(t1 * uv.x + t2 * uv.y + uMoon * sqrt(max(0.0, 1.0 - r2)));
        float lit = max(dot(nr, uSun), 0.0), tex = fbm(nr * 5.0 + 3.0), cr = smoothstep(0.55, 0.7, fbm(nr * 11.0));
        vec3 mc = mix(vec3(0.05, 0.045, 0.05), vec3(0.62, 0.56, 0.5), tex) * (1.0 - 0.35 * cr) * lit * 1.5 + vec3(0.012, 0.014, 0.025);
        col = mix(col, mc, smoothstep(crad - 0.002, crad + 0.0007, cm));
      }
      // the sun: a disc, an aureole and a corona
      float mu = dot(d, uSun);
      col += vec3(1.0, 0.94, 0.82) * (smoothstep(0.99925, 0.99955, mu) * 70.0 + pow(max(mu, 0.0), 220.0) * 3.0 + pow(max(mu, 0.0), 14.0) * 0.1);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  const CORE_V = 'varying vec3 vP; varying vec3 vN; varying vec3 vV; void main(){ vP = position; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }';
  const CORE_F = /* glsl */`
    uniform float uTime; varying vec3 vP; varying vec3 vN; varying vec3 vV;
    ${NOISE}
    void main(){
      vec3 p = normalize(vP) * 2.2; float t = uTime * 0.12;
      vec3 w = vec3(fbm(p + vec3(t, 0.0, 0.0)), fbm(p + vec3(0.0, t, 3.1)), fbm(p + vec3(5.2, 0.0, t)));
      float n = fbm(p * 1.5 + w * 1.7 + t * 0.4);
      float crack = 1.0 - smoothstep(0.0, 0.11, abs(fbm(p * 2.3 + w * 1.3 - t * 0.2) - 0.5));
      float heat = clamp(0.3 + 0.95 * n + 1.35 * crack, 0.0, 2.2);
      vec3 col = mix(vec3(0.10, 0.015, 0.01), vec3(1.25, 0.26, 0.03), smoothstep(0.18, 0.85, heat));
      col = mix(col, vec3(2.6, 1.4, 0.4), smoothstep(0.95, 1.7, heat));
      float fr = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
      col += vec3(1.0, 0.34, 0.07) * fr * 1.4;
      gl_FragColor = vec4(col * vec3(0.5, 0.42, 0.36), 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  const HALO_V = 'varying vec2 vU; uniform float uSize; void main(){ vU = position.xy; vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); gl_Position = projectionMatrix * (c + vec4(position.xy * uSize, 0.0, 0.0)); }';
  const HALO_F = /* glsl */`
    uniform float uTime; varying vec2 vU;
    ${NOISE}
    void main(){
      float r = length(vU), a = atan(vU.y, vU.x);
      float rays = 0.55 + 0.45 * fbm(vec3(cos(a) * 2.2, sin(a) * 2.2, uTime * 0.25 + r * 0.6));
      float core = exp(-r * r * 9.0), glow = exp(-r * 2.6) * rays * 0.55, edge = smoothstep(1.0, 0.7, r);
      vec3 c = vec3(1.0, 0.42, 0.1) * (glow * 0.9) + vec3(1.0, 0.7, 0.3) * core * 0.35;
      gl_FragColor = vec4(c * edge, (glow + core * 0.4) * edge * 0.9);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  function lump(geo, seed) {                                    // a rock: an icosphere pushed about by value noise
    const p = geo.attributes.position, a = new T.Vector3();
    const h = (x, y, z) => { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed) * 43758.5453; return s - Math.floor(s); };
    for (let i = 0; i < p.count; i++) {
      a.fromBufferAttribute(p, i).normalize();
      const k = 0.78 + 0.45 * h(Math.round(a.x * 3), Math.round(a.y * 3), Math.round(a.z * 3)) + 0.12 * h(a.x * 9, a.y * 9, a.z * 9);
      p.setXYZ(i, a.x * k, a.y * k * 0.85, a.z * k);
    }
    geo.computeVertexNormals();
    return geo;
  }

  function build(ctx) {
    const scene = ctx.scene, G = { scene, objs: [] };
    // sky dome
    const skyMat = new T.ShaderMaterial({ side: T.BackSide, depthWrite: false, fog: false, uniforms: { uTime: { value: 0 }, uSun: { value: new T.Vector3(0.5, 0.4, 0.7).normalize() }, uMoon: { value: new T.Vector3(-0.5, 0.35, -0.6).normalize() }, uBeltN: { value: new T.Vector3(0.1, 1, 0.2).normalize() }, uRot: { value: new T.Matrix3() } }, vertexShader: SKY_V, fragmentShader: SKY_F });
    SS.section.exempt(skyMat, 'eow sky dome');
    G.dome = new T.Mesh(new T.SphereGeometry(500, 48, 24), skyMat); G.dome.renderOrder = -11; G.dome.frustumCulled = false; scene.add(G.dome); G.objs.push(G.dome);
    // the core
    const R = SS.eow.K.CORE_R;
    const coreMat = new T.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, vertexShader: CORE_V, fragmentShader: CORE_F });
    SS.section.exempt(coreMat, 'eow core: the remnant of the planet is a whole ball, not cut by the section');
    G.core = new T.Mesh(new T.SphereGeometry(R, 64, 40), coreMat); G.core.frustumCulled = false; scene.add(G.core); G.objs.push(G.core);
    const haloMat = new T.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uSize: { value: R * 3.6 } }, vertexShader: HALO_V, fragmentShader: HALO_F, transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false });
    SS.section.exempt(haloMat, 'eow core halo billboard');
    G.halo = new T.Mesh(new T.PlaneGeometry(2, 2), haloMat); G.halo.frustumCulled = false; G.halo.renderOrder = 8; scene.add(G.halo); G.objs.push(G.halo);
    // far debris: an asteroid ring about the core, far silhouettes, near scrap
    const rng = M.rng_make(0x5eed), rr = (a, b) => M.rng_range(rng, a, b);
    const N = 230, geo = lump(new T.IcosahedronGeometry(1, 2), 3), mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0.05, flatShading: true });
    const im = new T.InstancedMesh(geo, mat, N); im.frustumCulled = false; im.castShadow = false; im.receiveShadow = false;
    const col = new T.Color();
    G.deb = [];
    for (let i = 0; i < N; i++) {
      const kind = i < 130 ? 0 : i < 165 ? 1 : 2, d = { kind, ax: new T.Vector3(rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize(), w: rr(0.05, 0.5) * (rr(0, 1) < 0.5 ? -1 : 1), q0: rr(0, 6.28) };
      if (kind === 0) { d.r = rr(70, 150); d.th = rr(0, 6.2832); d.y = rr(-9, 9); d.sc = rr(0.5, 2.4) * (rr(0, 1) < 0.08 ? 2.5 : 1); d.om = rr(0.004, 0.011); }
      else if (kind === 1) { const u = rr(-1, 1), a = rr(0, 6.2832), s = Math.sqrt(1 - u * u), r = rr(70, 190); d.px = Math.cos(a) * s * r; d.py = u * r * 0.6; d.pz = Math.sin(a) * s * r; d.sc = rr(2.5, 8); d.om = 0; }
      else { d.px = rr(4, 92); d.py = rr(3, 38); d.pz = rr(4, 92); d.sc = rr(0.12, 0.45); d.vx = rr(-0.25, 0.25); d.vy = rr(-0.18, 0.18); d.vz = rr(-0.25, 0.25); d.om = 0; }
      const t = rr(0, 1);
      col.setRGB(0.28 + 0.2 * t, 0.23 + 0.14 * t, 0.2 + 0.1 * t); if (rr(0, 1) < 0.12) col.setRGB(0.32, 0.34, 0.38);
      im.setColorAt(i, col); G.deb.push(d);
    }
    scene.add(im); G.im = im; G.objs.push(im); G.dummy = new T.Object3D(); G.q = new T.Quaternion();
    return G;
  }

  /* the look */
  const LOOK = { sunDir: [0.5, 0.45, 0.7], sky: 'sky', sun: 0xfff1de, sunI: 4.4, hemiS: 0x1b2448, hemiG: 0x0b0710, hemiI: 0.42, fog: 0.0007, haze: 0x03040a, exp: 1.18, grass: [0.7, 0.62, 0.52], dry: [0.7, 0.62, 0.52], gBase: 0x2a1a10, gTip: 0x6a4a30, gDry: 0x6a5a40, deep: 0x000000, shallow: 0x000000 };
  const GRADE = { sat: 1.12, con: 0.3, vig: 0.34, sh: [0.0, 0.0, 0.016], hi: [1.02, 0.97, 0.93] };
  const v3 = new T.Vector3();
  EV.frame = function (S, view, camera, ctx) {
    const sun = ctx.sun, hemi = ctx.hemi, fill = ctx.fill, lamp = ctx.lamp, U = SS.terrain.uniforms, e = S.eow;
    if (!built) built = build(ctx);
    if (!saved) saved = { refs: { motes: ctx.motes, fill, lamp }, motes: ctx.motes.material.color.getHex(), moteO: ctx.motes.material.opacity, fill: [fill.color.getHex(), fill.intensity], lamp: [lamp.color.getHex(), lamp.distance, lamp.decay] };
    const G = built, t = S.time, K = SS.eow.K, W = SS.world;
    for (const o of G.objs) o.visible = true;
    // hide the world's sky, clouds, sea and far land (as under ground does), the pollen becomes cold dust
    if (ctx.sky) ctx.sky.visible = false; if (ctx.stars) ctx.stars.visible = false;
    for (const m of [SS.cloudView && SS.cloudView.mesh && SS.cloudView.mesh(), SS.farView && SS.farView.quad && SS.farView.quad()]) if (m) m.visible = false;
    if (SS.waterView && SS.waterView.meshes) for (const m of SS.waterView.meshes()) if (m) m.visible = false;
    ctx.motes.material.color.setHex(0xaab6d8); ctx.motes.material.opacity = 0.3; ctx.motes.visible = true;
    // the slow tumble: the sun, the moon and the stars turn about different axes (S.time: presentation, deterministic)
    const a = 0.55 + t * 0.006, el = 0.42 + 0.12 * M.sin(t * 0.0021);
    LOOK.sunDir[0] = M.cos(a) * M.cos(el); LOOK.sunDir[1] = M.sin(el); LOOK.sunDir[2] = M.sin(a) * M.cos(el);
    view.look = LOOK;
    const sd = LOOK.sunDir, su = G.dome.material.uniforms;
    su.uSun.value.set(sd[0], sd[1], sd[2]); su.uTime.value = view.time;
    { const b = -t * 0.0024; su.uMoon.value.set(M.cos(b) * 0.8, 0.35, M.sin(b) * 0.8).normalize(); su.uBeltN.value.set(0.12 * M.sin(t * 0.0011), 1, 0.18).normalize(); const r = t * 0.0035, c = M.cos(r), s = M.sin(r); su.uRot.value.set(c, 0, s, 0, 1, 0, -s, 0, c); }
    G.dome.position.copy(camera.position);
    // lights
    sun.color.setHex(LOOK.sun); sun.intensity = LOOK.sunI; sun.castShadow = true;
    hemi.color.setHex(LOOK.hemiS); hemi.groundColor.setHex(LOOK.hemiG); hemi.intensity = LOOK.hemiI;
    fill.color.setHex(0x6a4aa0); fill.intensity = 0.7; fill.position.set(-sd[0] * 60, 18, -sd[2] * 60);
    sun.position.set(view.camT.x + sd[0] * 80, view.camT.y + sd[1] * 80, view.camT.z + sd[2] * 80); sun.target.position.copy(view.camT);
    U.uSunDir.value.set(sd[0], sd[1], sd[2]).normalize();
    ctx.scene.fog.color.setHex(LOOK.haze); ctx.scene.fog.density = LOOK.fog; view.haze = ctx.scene.fog.color.clone(); view.fogBase = LOOK.fog; U.uHaze.value.copy(ctx.scene.fog.color);
    ctx.renderer.toneMappingExposure = LOOK.exp;
    if (SS.lens && SS.lens.grade && ctx.Q.grade && lastGrade !== S.tick >> 6) { lastGrade = S.tick >> 6; SS.lens.grade(GRADE); SS.lens.sun(null, [0, 0, 0], 0); }
    SS.terrain.capEow(true);
    // the core: a flickering orange point light (the view's lamp) and the halo
    const c = e.core, fl = 1 + 0.07 * M.sin(view.time * 7.1) + 0.05 * M.sin(view.time * 12.7 + 1.3) + 0.03 * M.sin(view.time * 31.0);
    G.core.position.set(c.x, c.y, c.z); G.core.rotation.y = view.time * 0.05; G.core.material.uniforms.uTime.value = view.time;
    G.halo.position.set(c.x, c.y, c.z); G.halo.material.uniforms.uTime.value = view.time; G.halo.material.uniforms.uSize.value = K.CORE_R * 3.6 * (0.95 + 0.07 * fl);
    lamp.color.setHex(0xff7a30); lamp.distance = 110; lamp.decay = 1.35; lamp.intensity = 380 * fl; lamp.position.set(c.x, c.y, c.z);
    // debris
    const d0 = G.dummy, im = G.im, q = G.q;
    for (let i = 0; i < G.deb.length; i++) {
      const d = G.deb[i];
      if (d.kind === 0) { const an = d.th + t * d.om; d0.position.set(c.x + M.cos(an) * d.r, c.y + d.y + M.sin(an * 1.7 + d.q0) * 1.5, c.z + M.sin(an) * d.r); }
      else if (d.kind === 1) d0.position.set(c.x + d.px, c.y + d.py, c.z + d.pz);
      else d0.position.set(d.px + d.vx * M.sin(t * 0.07 + d.q0) * 40, d.py + d.vy * M.sin(t * 0.05 + d.q0) * 40, d.pz + d.vz * M.sin(t * 0.06 + d.q0) * 40);
      q.setFromAxisAngle(d.ax, d.q0 + d.w * t); d0.quaternion.copy(q); d0.scale.set(d.sc, d.sc * (0.7 + 0.3 * M.sin(d.q0 * 3)), d.sc * 1.2);
      d0.updateMatrix(); im.setMatrixAt(i, d0.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    view.eowSun = LOOK.sunDir;
  };
  /* back to the normal look: a new world that is not the End of the World (applyLook restores the lights' colours and the fog; this puts back
   * what only this file changed: the pollen, the fill light, the worm lamp, the cap shader's switch) */
  EV.reset = function (S) {
    lastGrade = -1;
    if (typeof SS.terrain.capEow === 'function') SS.terrain.capEow(!!S.eow);
    if (!built || S.eow) return;
    for (const o of built.objs) o.visible = false;
    const r = saved && saved.refs; if (!r) return;
    r.motes.material.color.setHex(saved.motes); r.motes.material.opacity = saved.moteO;
    r.fill.color.setHex(saved.fill[0]); r.fill.intensity = saved.fill[1];
    r.lamp.color.setHex(saved.lamp[0]); r.lamp.distance = saved.lamp[1]; r.lamp.decay = saved.lamp[2];
  };

  /* ---------- worms ---------- */
  const gv = { x: 0, y: 0, z: 0 };
  // the soft solver is off in space: the animator's muscle pose, scaled like the solver's goal, is the drawn spine
  EV.goal = function (OUT, sp, c) {
    const N = OUT.x.length;
    for (let k = 0; k < N; k++) {
      OUT.x[k] = sp.x[k] * c.sx + c.ox; OUT.y[k] = -0.5 + (sp.y[k] + 0.5) * c.sy + c.oy; OUT.a[k] = sp.a[k]; OUT.r[k] = sp.r[k] * (c.sx + c.sy) * 0.5;
    }
    OUT.dx = 0; OUT.dy = 0;
    return OUT;
  };
  // the worm lies along the surface it is stuck to (grounded: its up; in flight: against the pull of the field)
  EV.orient = function (S, w, v, f, dt) {
    const e = w.eu2; if (!e || !S.eow) return;
    const d = SS.plane.dir(S), a = S.active;
    let us = e.s, uy = e.y;
    const flying = w === a ? w.air : !w.rest;
    if (flying) { SS.eow.field(S, w.pos.x, w.pos.y, w.pos.z, gv); const l = M.len3(gv.x, gv.y, gv.z); if (l > 0.05) { us = -(gv.x * d.x + gv.z * d.z) / l; uy = -gv.y / l; } }
    const tgt = M.atan2(-us, uy);
    let cur = v.eowA == null ? tgt : v.eowA, dd = M.wrap_angle(tgt - cur);
    cur += dd * (1 - Math.exp(-(dt || 1 / 60) * (flying ? 6 : 10))); v.eowA = cur;
    v.root.rotation.z = cur * f; v.tilt = cur * f;
  };
})(window.SS = window.SS || {});
