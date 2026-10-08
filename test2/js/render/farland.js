/* render/farland.js — the world beyond the island (Step LS; replaces CX2; Three.js specific, view-only).
 * User 2026-10-07: the island maps keep the sea, and far away there are other lands, sometimes only sea at the
 * horizon; the horizon slightly curved like in reality; the "infinite" landscape is another very large circle with
 * random landscape, then the procedural sky.
 * A polar mesh around the map centre from R_IN (inside the main scene's outer sea plane) to R_OUT 60 km: one mesh
 * for the far ocean and the far lands (no seam between them): heights from a seeded per-biome function (coast mask
 * from large-scale fbm with whole empty sectors, hills / mountain ranges / mesas / volcanic cones), sunk by the
 * earth's curvature d² / 2R from the camera (7.8 m at 10 km, 70 m at 30 km, 280 m at 60 km: far coasts sink below
 * the horizon, the sea's horizon is a true horizon). Lands: biome palette by height and slope, sun + sky light;
 * ocean: deep colour + sky / sun reflection; both fade into the sky behind them (the K2 LUT colour) over the
 * visibility (aerial perspective) — near the island the ocean uses the main water's own fog, so it continues the
 * outer sea plane without a seam. The clouds (render/clouds.js) are drawn in the same pass, so a mountain hides
 * the clouds behind it.
 * The camera's far plane is 900 m: everything here is rendered by a FAR camera (same view, near 30 m, far 150 km)
 * into a render target before the main scene (scene.onBeforeRender, any camera that sees layer 0, so tools that
 * call renderer.render(scene, camera) get it too); a full-screen quad at the far plane composites it over the sky
 * dome; every main-scene object covers it. Wet maps only (the desert has its own far dunes).
 * Porting: one extra camera + render target + a composite pass; the far mesh is plain seeded math. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const FL = SS.farView = {};
  const R_IN = 520, R_OUT = 60000, NA = 512, GROW = 1.016, RE = 6371e3;   // LS4: 1.028 -> 1.016 (radial step 1.6 % of r: a 250 m islet at 8 km was one dome)
  // per biome: land share (mask threshold), heights (m), mountain ranges, palette (linear-ish sRGB 0..1), cones
  const BIOME = {
    temperate: { thr: 0.56, h: 220, peak: 900, ridge: 0.3, cliff: 0.8, isl: [30, 140], sand: [0.72, 0.66, 0.5], low: [0.2, 0.32, 0.12], mid: [0.16, 0.24, 0.1], rock: [0.4, 0.38, 0.34], snow: 2400 },
    alpine:    { thr: 0.52, h: 500, peak: 3200, ridge: 0.9, cliff: 1, isl: [60, 380], sand: [0.55, 0.53, 0.5], low: [0.16, 0.24, 0.13], mid: [0.22, 0.26, 0.2], rock: [0.42, 0.42, 0.44], snow: 1300 },
    canyon:    { thr: 0.55, h: 300, peak: 700, ridge: 0.2, mesa: true, cliff: 1, isl: [60, 220], sand: [0.78, 0.6, 0.42], low: [0.62, 0.36, 0.22], mid: [0.55, 0.3, 0.18], rock: [0.6, 0.38, 0.26], snow: 9e9 },
    volcanic:  { thr: 0.6, h: 260, peak: 1400, ridge: 0.25, cones: true, cliff: 0.6, isl: [40, 260], sand: [0.16, 0.15, 0.14], low: [0.12, 0.13, 0.1], mid: [0.1, 0.09, 0.09], rock: [0.14, 0.12, 0.11], snow: 9e9 }
  };
  let renderer = null, rt = null, farScene = null, farCam = null, quad = null, mesh = null, mat = null, on = false, mainScene = null;
  const U = {
    tLut: { value: null }, uSun: { value: new T.Vector3(0, 1, 0) }, uSunC: { value: new T.Vector3(1, 1, 1) }, uAmb: { value: new T.Vector3(0.3, 0.35, 0.45) },
    uVis: { value: 40000 }, uSea: { value: 3 }, uCam: { value: new T.Vector3() }, uFog: { value: new T.Color() }, uFogD: { value: 0.0026 },
    uDeep: { value: new T.Color(0x0d3a5c) }, uSnow: { value: 2400 }, uSand: { value: new T.Vector3() }, uLow: { value: new T.Vector3() },
    uMid: { value: new T.Vector3() }, uRock: { value: new T.Vector3() }, uE: { value: 1.0 }
  };

  const VERT = /* glsl */`
    attribute float aH; attribute vec3 aN;
    uniform vec3 uCam; uniform float uSea;
    varying vec3 vW; varying float vH; varying vec3 vN; varying float vD;
    void main(){
      vec3 p = position; vec2 rel = p.xz - uCam.xz; float d2 = dot(rel, rel);
      p.y = max(aH, uSea) - d2 / (2.0 * ${RE.toFixed(1)});          // the earth's curvature from the viewer
      vW = p; vH = aH; vN = aH > uSea ? aN : vec3(0.0, 1.0, 0.0); vD = sqrt(d2);
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`;
  const FRAG = /* glsl */`
    uniform sampler2D tLut; uniform vec3 uSun, uSunC, uAmb, uFog, uDeep, uSand, uLow, uMid, uRock, uCam;
    uniform float uVis, uSea, uFogD, uSnow, uE;
    varying vec3 vW; varying float vH; varying vec3 vN; varying float vD;
    vec2 lutUV(vec3 d){ float el = asin(clamp(d.y, -1.0, 1.0)); return vec2(atan(d.z, d.x) / 6.2831853 + 0.5, 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963)); }
    void main(){
      vec3 V = normalize(vW - cameraPosition);
      vec3 sky = texture2D(tLut, lutUV(normalize(vec3(V.x, max(V.y, 0.0), V.z)))).rgb;   // P29f: haze = the horizon colour (below it the LUT is dark ground)
      vec3 col;
      if (vH <= uSea + 0.5) {
        // far ocean: deep colour lit by the sky, Fresnel sky reflection (LUT), the sun's glitter path
        vec3 R = reflect(V, vec3(0.0, 1.0, 0.0));
        float fres = 0.02 + 0.98 * pow(1.0 - max(-V.y, 0.0), 5.0);
        vec3 refl = texture2D(tLut, lutUV(vec3(R.x, max(R.y, 0.002), R.z))).rgb;
        col = mix(uDeep * (uAmb * 0.6 + uSunC * max(uSun.y, 0.0) * 0.15), refl, fres);
        float g = pow(max(dot(R, uSun), 0.0), 300.0);
        col += uSunC * g * 6.0;
        // near the island: the main water's own fog (continues the outer sea plane without a seam). P29f: its colour is
        // the horizon sky (LUT) x 0.93 with a tenth of the warm haze, as in render/water.js: the old fixed warm haze was
        // far brighter than the horizon, so the fogged sea lay as a bright layer under the far islands ("an island in the
        // air"); now near sea, far ocean and horizon converge on a sea a touch darker than the sky
        vec3 hzC = mix(uFog, texture2D(tLut, lutUV(normalize(vec3(V.x, 0.0, V.z)))).rgb, 0.9) * 0.93;   // = render/water.js's fog colour
        col = mix(col, hzC, 1.0 - exp(-vD * vD * uFogD * uFogD));
      } else {
        vec3 n = normalize(vN);
        float h = vH - uSea, slope = 1.0 - n.y;
        vec3 c = mix(uSand, uLow, smoothstep(2.0, 18.0, h));
        c = mix(c, uMid, smoothstep(80.0, 400.0, h));
        c = mix(c, uRock, smoothstep(0.25, 0.55, slope) * smoothstep(20.0, 120.0, h));
        c = mix(c, vec3(0.86, 0.88, 0.92), smoothstep(uSnow, uSnow + 300.0, h) * (1.0 - smoothstep(0.55, 0.8, slope)));
        float diff = max(dot(n, uSun), 0.0);
        col = c * (uSunC * diff * uE * 1.1 + uAmb * (0.55 + 0.45 * n.y));
      }
      // aerial perspective: toward the sky behind it over the visibility; the haze sits low (aerosol scale height
      // 1.2 km): a path's optical distance shrinks with its mean height, so peaks stand out above hazy coasts
      float f = 1.0 - exp(-vD * exp(-0.5 * max(vW.y + cameraPosition.y - 2.0 * uSea, 0.0) / 1200.0) / uVis * 2.6);
      if (vH <= uSea + 0.5) f = min(f, 0.82);      // P29f: the sea stays a touch darker than the sky to the horizon
      col = mix(col, sky, f);
      gl_FragColor = vec4(col, 1.0);
    }`;
  // composite: the far render target (linear, premultiplied) over the sky dome; tone map + encode the un-premultiplied
  // colour like every other material, then premultiply
  const QUAD_F = /* glsl */`
    uniform sampler2D tFar; varying vec2 vUv;
    void main(){
      vec4 c = texture2D(tFar, vUv);
      if (c.a < 0.002) discard;
      gl_FragColor = vec4(c.rgb / c.a, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      gl_FragColor = vec4(gl_FragColor.rgb * c.a, c.a);
    }`;

  FL.init = function (scene, tx, Q, rend) {
    renderer = rend; mainScene = scene;
    farScene = new T.Scene();
    farCam = new T.PerspectiveCamera(42, 1, 30, 150000);
    const sz = rend.getDrawingBufferSize(new T.Vector2());
    rt = new T.WebGLRenderTarget(sz.x, sz.y, { type: T.HalfFloatType, samples: Q && Q.name === 'low' ? 0 : 4 });
    // the polar mesh (radii growing x GROW from R_IN), heights filled per map by look()
    const rad = []; for (let r = R_IN; r < R_OUT; r *= GROW) rad.push(r); rad.push(R_OUT);
    const NR = rad.length, N = NR * NA, pos = new Float32Array(N * 3), aH = new Float32Array(N), aN = new Float32Array(N * 3);
    for (let k = 0; k < NR; k++) for (let a = 0; a < NA; a++) { const o = (k * NA + a) * 3, th = a / NA * Math.PI * 2; pos[o] = 48 + Math.cos(th) * rad[k]; pos[o + 2] = 48 + Math.sin(th) * rad[k]; aN[o + 1] = 1; }
    const idx = new Uint32Array((NR - 1) * NA * 6); let q = 0;
    for (let k = 0; k < NR - 1; k++) for (let a = 0; a < NA; a++) {
      const a1 = (a + 1) % NA, i0 = k * NA + a, i1 = k * NA + a1, i2 = (k + 1) * NA + a, i3 = (k + 1) * NA + a1;
      idx[q++] = i0; idx[q++] = i1; idx[q++] = i2; idx[q++] = i1; idx[q++] = i3; idx[q++] = i2;   // CCW from above (P29f: it was
      // wound facing DOWN with FrontSide: the far ocean was culled from every viewpoint above it and never drawn, so the
      // sky dome's dark below-horizon band showed under the far islands, which were only seen by their inside flanks)
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aH', new T.BufferAttribute(aH, 1)); g.setAttribute('aN', new T.BufferAttribute(aN, 3));
    g.setIndex(new T.BufferAttribute(idx, 1));
    mat = new T.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: FRAG, side: T.FrontSide });
    mesh = new T.Mesh(g, mat); mesh.frustumCulled = false; farScene.add(mesh);
    FL.rad = rad;
    const qm = new T.ShaderMaterial({
      uniforms: { tFar: { value: rt.texture } }, transparent: true, depthWrite: false, depthTest: true,
      blending: T.CustomBlending, blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, blendSrcAlpha: T.OneFactor, blendDstAlpha: T.OneMinusSrcAlphaFactor,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }',
      fragmentShader: QUAD_F
    });
    quad = new T.Mesh(new T.PlaneGeometry(2, 2), qm); quad.frustumCulled = false; quad.renderOrder = -9.5; quad.visible = false; scene.add(quad);
    const prevBR = scene.onBeforeRender;
    scene.onBeforeRender = function (r, sc, cam, target) { if (prevBR) prevBR.call(this, r, sc, cam, target); FL.before(r, cam, target); };
  };
  FL.scene = () => farScene;

  /* render the far world for this camera (main camera or any free camera that sees layer 0) */
  const sz = new T.Vector2();
  FL.before = function (r, cam, target) {
    if (!on || !quad.visible || !cam.isPerspectiveCamera || !cam.layers.test(farCam.layers)) return;
    if (target) { if (target.isWebGLCubeRenderTarget) return; sz.set(target.width, target.height); } else r.getDrawingBufferSize(sz);
    if (rt.width !== sz.x || rt.height !== sz.y) rt.setSize(sz.x, sz.y);
    farCam.position.copy(cam.position); farCam.quaternion.copy(cam.quaternion);
    farCam.fov = cam.fov; farCam.aspect = cam.aspect; farCam.zoom = cam.zoom; farCam.view = cam.view ? Object.assign({}, cam.view) : null;
    farCam.updateProjectionMatrix(); farCam.updateMatrixWorld();
    U.uCam.value.copy(cam.position);
    const cu = SS.cloudView && SS.cloudView.uniforms; if (cu) { cu.uFarZ.value = 0; cu.uCam.value.copy(cam.position); }
    const ac = r.autoClear, cc = r.getClearColor(new T.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.autoClear = true;
    r.render(farScene, farCam);
    r.setRenderTarget(target || null); r.setClearColor(cc, ca); r.autoClear = ac;
    if (cu) cu.uFarZ.value = 1;
  };

  /* fields */
  let seed = 1;
  const fbm = (x, z, s, o) => M.fbm2(x, z, seed + s, o);
  /* LS4: per-seed variation P = { thr, hs, isl: [{x, z, r, h, k}] } (look()): the land threshold +-0.05 (more or less
   * land; biased toward less), relief x 0.75-1.35 (mountains <= x 1.1), and 1-4 near islands 2-6 km out (r 150-600
   * m, steep sides): the foreground layer of
   * a real seascape, darker / crisper than the ranges behind (less air in front). Relief: base hills x eroded ridged
   * detail (700 m: spurs and valleys, so a skyline is notched, not a whale-back), cliff-coast stretches (the land
   * rises within ~1/5 of the usual distance from the shore: sea cliffs), alpine / temperate ranges inland; canyon =
   * a dissected plateau: cap-rock levels 150 / 300 / 450 m with ~120 m wide escarpments and buttes (no slopes between:
   * mesa country is flat tops and cliffs). */
  function islet(P, x, z) {
    let h = 0;
    for (const q of P.isl) {
      const d = Math.hypot(x - q.x, z - q.z); if (d >= q.r) continue;
      const u = 1 - d / q.r;                                       // 0 at the shore, 1 at the centre
      // steep sides (stack / cliff island), a rounded or flat top (k: 0 rounded hill, 1 flat-topped butte: walls over
      // the outer 8 % of the radius, a cap-rock top with only 4 % relief)
      const side = Math.min(1, u / (0.22 - 0.14 * q.k)), top = (1 - q.k) * (0.55 + 0.45 * u) + q.k;
      h = Math.max(h, q.h * Math.pow(side, 0.7 - 0.4 * q.k) * top * (1 + (0.4 - 0.36 * q.k) * (fbm(x / 260, z / 260, 41, 2) - 0.5)));
    }
    return h;
  }
  // coast mask: big landmasses (~8 km features), whole empty sectors (pure sea at the horizon there)
  function landMask(x, z) {
    const dx = x - 48, dz = z - 48, r = Math.hypot(dx, dz), th = Math.atan2(dz, dx);
    const sector = M.fbm2(Math.cos(th) * 1.6 + 5.1, Math.sin(th) * 1.6 + 2.3, seed + 41, 3);
    const m = fbm(x / 9000, z / 9000, 11, 4) * 0.75 + fbm(x / 2500, z / 2500, 12, 3) * 0.25 + (sector - 0.5) * 0.5;
    return m - Math.max(0, 1 - (r - 2500) / 3500) * 0.5;          // open sea around the island (none within ~3 km)
  }
  function heightAt(B, P, x, z, plume) {
    const m = landMask(x, z);
    let h = 0;
    const t = (m - P.thr) / 0.16;
    if (t > 0) {
      // cliff-coast stretches: the land reaches its height within a fifth of the usual distance from the shore
      const cl = M.clamp((fbm(x / 4000, z / 4000, 21, 2) - 0.45) * 4, 0, 1) * B.cliff;
      const rise = Math.min(1, t * (1 + 4 * cl));
      if (B.mesa) {
        // dissected plateau: cap-rock levels (sharp steps in the plateau field p), buttes from the finer octave
        // the step width is set in METRES (ESC_W, via |grad p|): a fixed width in p made a broad rounded dome wherever p
        // barely crests a level (|grad p| ~ 0); cap rock breaks off at a sharp rim however gently the field rises
        const pf = (u, v) => fbm(u / 5000, v / 5000, 31, 3) * 0.7 + fbm(u / 1200, v / 1200, 32, 2) * 0.3;
        const p = pf(x, z), gp = Math.hypot(pf(x + 60, z) - p, pf(x, z + 60) - p) / 60, wp = Math.max(1e-4, gp * 120);
        let hm = 0;
        for (let i = 0; i < 3; i++) hm += 150 * M.smooth(M.clamp((p - (0.43 + 0.075 * i)) / wp + 0.5, 0, 1));
        // the plateau ends at the sea in an escarpment ~150 m wide (min(1, 3t) rose as a dome where the mask barely
        // crests the threshold)
        const gm = Math.hypot(landMask(x + 60, z) - m, landMask(x, z + 60) - m) / 60;
        const rs = M.smooth(M.clamp((m - P.thr) / Math.max(1e-5, gm * 150), 0, 1));
        h = rs * (25 + hm * P.hs) + 6 * fbm(x / 400, z / 400, 33, 2);
      } else {
        const det = 1 - Math.abs(fbm(x / 700, z / 700, 15, 3) * 2 - 1);          // ridged: spurs (1) and valleys (0)
        const base = rise * B.h * P.hs * (0.45 + 0.55 * fbm(x / 1500, z / 1500, 13, 4)) * (0.6 + 0.6 * det);
        // mountain ranges: ridged noise, only well inland (t > 1)
        const rd = 1 - Math.abs(fbm(x / 6000, z / 6000, 14, 3) * 2 - 1);
        const mount = Math.pow(Math.max(0, rd - 0.45) / 0.55, 2) * B.peak * Math.min(1.1, P.hs) * B.ridge * M.clamp(t - 0.8, 0, 1.5) * (0.75 + 0.5 * det);
        h = base + mount + 4 * t;
      }
    }
    h = Math.max(h, islet(P, x, z));
    if (B.cones) for (const c of plume) {                       // volcanic cones (the plume's vent on the biggest)
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < c.r) h = Math.max(h, c.h * Math.pow(1 - d / c.r, 1.6) - (d < c.r * 0.06 ? (c.r * 0.06 - d) * 3 : 0));
    }
    return h;
  }

  /* new map: wet worlds only; build the heights (~40 ms) */
  FL.look = function (S, sky, L) {
    if (!mesh) return;
    // the pass always runs (it carries the clouds); the far ocean + lands only on wet maps (the desert has its dunes)
    on = true; quad.visible = true; mesh.visible = !SS.world.dry;
    if (SS.world.dry) return;
    const B = BIOME[S.biome] || BIOME.temperate, W = SS.world;
    seed = ((S.settings.seed | 0) * 9137 + 71) | 0;
    const t0 = performance.now(), plume = [];
    // per-seed variation (own rng: the cone list below keeps its sequence)
    const pr = M.rng_make(((seed * 31 + 7) >>> 0) || 1), P = { thr: B.thr + M.rng_range(pr, -0.03, 0.07), hs: M.rng_range(pr, 0.75, 1.35), isl: [] };
    const nI = 1 + Math.floor(M.rng_next(pr) * 4);
    for (let k = 0; k < nI; k++) {
      const a = M.rng_range(pr, 0, 6.283), d = M.rng_range(pr, 2000, 6000), rI = Math.max(0.05 * d, M.rng_range(pr, 150, 600));   // r >= ~3 radial steps
      P.isl.push({ x: 48 + Math.cos(a) * d, z: 48 + Math.sin(a) * d, r: rI, h: M.rng_range(pr, B.isl[0], B.isl[1]) * (0.5 + rI / 800), k: B.mesa ? 1 : M.rng_next(pr) * 0.6 });
    }
    FL.params = P;
    if (B.cones) {
      const p = SS.cloudView && SS.cloudView.plume ? SS.cloudView.plume() : null;
      if (p) plume.push({ x: p.x, z: p.z, r: 7000, h: 2600 });
      const rr = M.rng_make((seed >>> 0) || 1);
      for (let k = 0; k < 4; k++) { const a = M.rng_range(rr, 0, 6.283), d = M.rng_range(rr, 9000, 40000); plume.push({ x: 48 + Math.cos(a) * d, z: 48 + Math.sin(a) * d, r: M.rng_range(rr, 2500, 5000), h: M.rng_range(rr, 700, 1600) }); }
    }
    const g = mesh.geometry, pos = g.attributes.position.array, aH = g.attributes.aH.array, aN = g.attributes.aN.array, rad = FL.rad, NR = rad.length;
    for (let k = 0; k < NR; k++) for (let a = 0; a < NA; a++) {
      const v = k * NA + a; aH[v] = W.SEA + heightAt(B, P, pos[v * 3], pos[v * 3 + 2], plume);
      if (aH[v] <= W.SEA + 0.01) aH[v] = W.SEA - 1;
    }
    // normals from the polar neighbours
    for (let k = 0; k < NR; k++) for (let a = 0; a < NA; a++) {
      const v = k * NA + a, kp = Math.min(NR - 1, k + 1), km = Math.max(0, k - 1), ap = (a + 1) % NA, am = (a + NA - 1) % NA;
      const ax = pos[(kp * NA + a) * 3] - pos[(km * NA + a) * 3], az = pos[(kp * NA + a) * 3 + 2] - pos[(km * NA + a) * 3 + 2], ay = aH[kp * NA + a] - aH[km * NA + a];
      const bx = pos[(k * NA + ap) * 3] - pos[(k * NA + am) * 3], bz = pos[(k * NA + ap) * 3 + 2] - pos[(k * NA + am) * 3 + 2], by = aH[k * NA + ap] - aH[k * NA + am];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx; if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
      const l = Math.hypot(nx, ny, nz) || 1; aN[v * 3] = nx / l; aN[v * 3 + 1] = ny / l; aN[v * 3 + 2] = nz / l;
    }
    g.attributes.aH.needsUpdate = true; g.attributes.aN.needsUpdate = true;
    U.uSea.value = W.SEA; U.uSnow.value = B.snow;
    U.uSand.value.set(...B.sand); U.uLow.value.set(...B.low); U.uMid.value.set(...B.mid); U.uRock.value.set(...B.rock);
    for (const k of ['uSand', 'uLow', 'uMid', 'uRock']) { const v = U[k].value; v.set(Math.pow(v.x, 2.2), Math.pow(v.y, 2.2), Math.pow(v.z, 2.2)); }
    if (L) U.uDeep.value.set(L.deep);
    if (sky) {
      U.tLut.value = sky.tex;
      const t = sky.sunT || [1, 1, 1], tp = sky.top || [0.3, 0.5, 0.9], av = sky.avg || tp, lin = v => Math.pow(Math.max(0, v), 2.2);
      U.uSunC.value.set(t[0], t[1], t[2]).multiplyScalar(1 - 0.85 * (sky.ov || 0));
      U.uAmb.value.set(lin(av[0]) * 0.5 + lin(tp[0]) * 0.5, lin(av[1]) * 0.5 + lin(tp[1]) * 0.5, lin(av[2]) * 0.5 + lin(tp[2]) * 0.5);
    }
    if (SS.skyView) U.uSun.value.copy(SS.skyView.params().sun);
    // night (view.js time of day): the far lands are lit by the moon, not by the sun under the horizon (else: black)
    const vs = SS.view && SS.view.state;
    if (vs && vs.tod === 'night' && vs.moonDir) { U.uSun.value.set(vs.moonDir[0], vs.moonDir[1], vs.moonDir[2]).normalize(); U.uSunC.value.set(0.16, 0.2, 0.32); U.uAmb.value.set(0.035, 0.045, 0.075); }
    if (SS.cloudView) U.uVis.value = SS.cloudView.uniforms.uVis.value;
    FL.buildMs = +(performance.now() - t0).toFixed(1);
  };
  /* per frame: the main water's fog (weather changes it) */
  FL.frame = function () {
    if (!on || !SS.waterView || !SS.waterView.fog) return;
    const f = SS.waterView.fog(); U.uFog.value.copy(f.color); U.uFogD.value = f.density;
  };
  FL.stats = () => ({ on, verts: mesh ? mesh.geometry.attributes.aH.count : 0, buildMs: FL.buildMs || 0 });
  FL.mesh = () => mesh;
  FL.quad = () => quad;                                     // U: hidden underground
})(window.SS = window.SS || {});
