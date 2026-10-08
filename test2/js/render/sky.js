/* render/sky.js — procedural sky (Step K2; replaces the K1 painted panoramas; Three.js specific).
 * User 2026-10-07: "the sky looks like crap": a sky that follows the weather and the map (the volcanic map must not
 * have a nice blue sky), with gigantic, slowly drifting 3D clouds (render/clouds.js).
 * Model: single scattering in a spherical atmosphere (Nishita 1993; constants of Bruneton 2008 / Hillaire 2020):
 * Rayleigh β (5.802, 13.558, 33.1)e-6 /m, scale height 8 km; Mie (aerosols) β_s 3.996e-6 · turbidity, absorption
 * per map (desert dust: yellow-brown, volcanic ash: dark brown, single-scattering albedo down to ~0.6), scale height
 * 1.2 km, Cornette-Shanks phase g 0.8; ozone (0.650, 1.881, 0.085)e-6 in a tent at 25 km; plus a crude isotropic
 * multiple-scattering term. Weather adds an overcast layer (CIE overcast gradient (1 + 2 sin el) / 3, its colour per
 * kind). The scattering is integrated once per look change into a SKY-VIEW LUT (256 x 128, half float: azimuth x
 * elevation, rows packed toward the horizon, v = 0.5 + 0.5·sign(el)·sqrt(|el| / 90°)); the dome, the water
 * reflections and the fog read it, so the haze of the terrain meets the sky at the horizon with the same colour
 * (aerial perspective). The sun disc and its sharp aureole are analytic in the dome shader. The sun's light colour
 * follows the transmittance along its ray (JS, same constants): ash / dust dim and redden it.
 * Porting: one compute pass into a 2D LUT + a sky shader; the JS transmittance is plain C-like math. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const SK = SS.skyView = {};
  const LW = 256, LH = 128;
  // per map: turbidity (Mie scale), aerosol absorption colour (per channel, x β_s; 0 = clean, ~0.1 for sea salt),
  // ground albedo (rays below the horizon), overcast tint
  const BIOME = {
    // turb x 3.996e-6 /m x 1.2 km = aerosol optical depth: temperate 0.02, alpine 0.01, canyon 0.034, desert dust
    // 0.058, volcanic ash 0.14 (ashfall x 1.8)
    temperate: { turb: 4.0, abs: [0.11, 0.11, 0.11], alb: [0.06, 0.09, 0.1], ovc: [0.80, 0.82, 0.86] },
    alpine:    { turb: 2.0, abs: [0.08, 0.08, 0.08], alb: [0.3, 0.32, 0.36], ovc: [0.84, 0.86, 0.9] },
    canyon:    { turb: 7.0, abs: [0.12, 0.2, 0.34], alb: [0.2, 0.13, 0.08], ovc: [0.82, 0.78, 0.74] },
    desert:    { turb: 12.0, abs: [0.08, 0.16, 0.34], alb: [0.42, 0.33, 0.2], ovc: [0.86, 0.8, 0.7] },
    volcanic:  { turb: 30.0, abs: [0.3, 0.48, 0.75], alb: [0.05, 0.045, 0.04], ovc: [0.56, 0.46, 0.4] }
  };
  // per weather kind: overcast (0 clear .. 1 full deck), its brightness, extra turbidity, ash loading (multiplies the
  // absorption), storm flag (weather.js)
  const WEATHER = {
    clear:    { ov: 0.0, ovL: 1.0, turb: 1.0, ash: 1.0 },
    cloudy:   { ov: 0.3, ovL: 0.95, turb: 1.2, ash: 1.0 },
    rain:     { ov: 0.78, ovL: 0.62, turb: 1.6, ash: 1.0, deckH: 900 },
    storm:    { ov: 0.9, ovL: 0.4, turb: 2.0, ash: 1.0, storm: true, deckH: 1000 },
    snow:     { ov: 0.82, ovL: 0.85, turb: 1.5, ash: 1.0, deckH: 900 },
    blizzard: { ov: 0.95, ovL: 0.72, turb: 2.4, ash: 1.0, deckH: 500 },
    ashfall:  { ov: 0.8, ovL: 0.42, turb: 1.8, ash: 1.6, deckH: 1800 },
    fog:      { ov: 0.7, ovL: 0.8, turb: 3.5, ash: 1.0, deckH: 300 }
  };
  const VOLC_MIN = { ov: 0.45, ovL: 0.55 };        // the volcanic map is never clear: an ash veil at least
  const SKY_E = 22;                                // sun illuminance (scene units): sets the sky's brightness
  const OBS_H = 120;                               // m: observer height above the sea

  let renderer = null, rt = null, lutScene = null, lutCam = null, lutMat = null, domeMat = null, dome = null;
  // K2e: the sky + clouds as seen from the camera, in a small HDR cube map for the water's reflections (layer
  // ENV_LAYER holds only the dome and the clouds; re-rendered every ENV_DT s: the clouds drift slowly)
  const ENV_LAYER = 30, ENV_N = 128, ENV_DT = 1.0;
  let envRT = null, envCam = null, envT = -1, sceneRef = null;
  const P = {                                      // current look (uniform values, linear)
    sun: new T.Vector3(0, 1, 0), turb: 1, abs: new T.Vector3(0.1, 0.1, 0.1), alb: new T.Vector3(0.1, 0.1, 0.1),
    ov: 0, ovL: 1, ovc: new T.Vector3(0.8, 0.8, 0.8), sunT: new T.Vector3(1, 1, 1), storm: false
  };
  SK.info = { horizon: [0.8, 0.8, 0.8], avg: [0.6, 0.7, 0.9], top: [0.3, 0.5, 0.9], storm: false, phys: true, tex: null, ms: 0 };

  /* ---------- the scattering integral (GLSL, LUT pass) ---------- */
  const ATMO = /* glsl */`
    const float Rg = 6360e3, Rt = 6460e3, PI = 3.14159265;
    const vec3 bR = vec3(5.802e-6, 13.558e-6, 33.1e-6), bO = vec3(0.650e-6, 1.881e-6, 0.085e-6);
    const float HR = 8000.0, HM = 1200.0;
    uniform vec3 uSun, uAbs, uAlb, uOvc; uniform float uTurb, uOv, uOvL, uE, uObsH;
    vec2 raySphere(vec3 o, vec3 d, float R){ float b = dot(o, d), c = dot(o, o) - R * R, h = b * b - c; if (h < 0.0) return vec2(-1.0); h = sqrt(h); return vec2(-b - h, -b + h); }
    vec3 dens(float h){ return vec3(exp(-h / HR), exp(-h / HM), max(0.0, 1.0 - abs(h - 25e3) / 15e3)); }
    vec3 ext(vec3 dd){ vec3 bM = vec3(3.996e-6) * uTurb; return bR * dd.x + (bM + bM * uAbs) * dd.y + bO * dd.z; }
    // optical depth (R, M, O) from p to the top of the atmosphere along l (8 steps, 0 if the ground blocks: then huge)
    vec3 odToSun(vec3 p, vec3 l){
      vec2 tg = raySphere(p, l, Rg); if (tg.x > 0.0) return vec3(1e9);
      float tt = raySphere(p, l, Rt).y, st = tt / 8.0; vec3 od = vec3(0.0);
      for (int i = 0; i < 8; i++) { vec3 q = p + l * (float(i) + 0.5) * st; od += dens(length(q) - Rg) * st; }
      return od;
    }
    vec3 scatter(vec3 dir){
      vec3 o = vec3(0.0, Rg + uObsH, 0.0);
      float tEnd = raySphere(o, dir, Rt).y; vec2 tg = raySphere(o, dir, Rg); bool ground = tg.x > 0.0;
      if (ground) tEnd = tg.x;
      const int N = 32; float mu = dot(dir, uSun);
      float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
      const float g = 0.8; float pM = 3.0 / (8.0 * PI) * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
      vec3 bM = vec3(3.996e-6) * uTurb;
      vec3 L = vec3(0.0), odV = vec3(0.0); float prev = 0.0;
      for (int i = 0; i < N; i++) {
        // samples packed toward the observer (the dense low air matters most)
        float t1 = tEnd * pow((float(i) + 1.0) / float(N), 2.0), ds = t1 - prev, t = (prev + t1) * 0.5; prev = t1;
        vec3 q = o + dir * t; float h = length(q) - Rg; vec3 dd = dens(h) * ds;
        vec3 odS = odToSun(q, uSun);
        vec3 Tr = exp(-ext(odV + dd * 0.5 + odS));
        // single scattering + crude isotropic multiple scattering (0.12 x the in-scattered light, unphased)
        L += Tr * (bR * dd.x * (pR + 0.12 / (4.0 * PI)) + bM * dd.y * (pM + 0.12 / (4.0 * PI)));
        odV += dd;
      }
      L *= uE;
      if (ground) {                                    // lit ground seen through the air (below the horizon)
        vec3 q = o + dir * tEnd, n = normalize(q);
        L += exp(-ext(odV)) * uAlb / PI * uE * max(dot(n, uSun), 0.0) * exp(-ext(odToSun(q + n, uSun)));
      }
      return L;
    }
    // overcast deck (CIE overcast sky: (1 + 2 sin el) / 3), scaled to the clear sky's zenith brightness
    vec3 overcast(vec3 dir){
      float el = asin(clamp(dir.y, -1.0, 1.0));
      float k = el >= 0.0 ? (1.0 + 2.0 * sin(el)) / 3.0 : 0.33 * (1.0 + el);
      return uOvc * k * uOvL * uE * 0.05 * (0.35 + 0.65 * max(uSun.y, 0.0));
    }`;
  const LUT_F = /* glsl */`
    ${ATMO}
    void main(){
      vec2 uv = gl_FragCoord.xy / vec2(${LW}.0, ${LH}.0);
      float az = (uv.x - 0.5) * 2.0 * PI, s = (uv.y - 0.5) * 2.0, el = sign(s) * s * s * PI * 0.5;
      vec3 dir = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
      vec3 L = scatter(dir);
      L = mix(L, overcast(dir), uOv);
      gl_FragColor = vec4(L, 1.0);
    }`;
  /* dome: LUT + sun disc + sharp aureole + lightning flash; (uDark kept for weather.js, unused: the overcast is in
   * the LUT); dithered against banding */
  const DOME_F = /* glsl */`
    uniform sampler2D tLut, tNoise; uniform vec3 uSun, uSunC; uniform float uOv, uFlash, uDark, uDisc, uDeck, uDeckH, uVis; uniform vec2 uDrift;
    varying vec3 vD;
    vec2 lutUV(vec3 d){
      float el = asin(clamp(d.y, -1.0, 1.0));
      return vec2(atan(d.z, d.x) / 6.2831853 + 0.5, 0.5 + 0.5 * sign(el) * sqrt(abs(el) / 1.5707963));
    }
    void main(){
      vec3 d = normalize(vD);
      vec3 c = texture2D(tLut, lutUV(d)).rgb;
      float mu = dot(d, uSun), clr = (1.0 - uOv) * (1.0 - uOv) * (1.0 - uOv);
      // overcast deck (rain / storm / snow / ash): the LUT holds its mean colour; a plane at uDeckH textured with
      // drifting fbm gives it structure (thick dark masses, thinner brighter parts, a glow where the sun is behind
      // thin cloud), fading into the haze toward the horizon
      if (uDeck > 0.0 && d.y > 0.002) {
        float t = uDeckH / d.y; vec2 p = d.xz * t + uDrift;
        float dn = texture2D(tNoise, p / 11000.0).a * 0.5 + texture2D(tNoise, p / 3100.0 + 0.37).a * 0.32 + texture2D(tNoise, p / 900.0 + 0.71).r * 0.18;
        float thick = smoothstep(0.3, 0.75, dn), f = 1.0 - exp(-t / uVis * 2.6);
        float k = mix(1.0, 1.32 - 0.62 * thick + pow(max(mu, 0.0), 6.0) * (1.0 - thick) * 0.5, uDeck * (1.0 - f));
        c *= k;
      }
      float disc = smoothstep(0.99997, 0.999985, mu) * step(0.0, d.y + 0.01);
      float aur = pow(max(mu, 0.0), 900.0) * 0.6 + pow(max(mu, 0.0), 60.0) * 0.015;
      c += uSunC * (disc * uDisc + aur * 40.0) * clr;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c += uFlash * vec3(0.75, 0.8, 1.0) * (0.15 + 0.6 * l);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      gl_FragColor.rgb += (n - 0.5) / 255.0;
    }`;

  /* JS mirror of the transmittance along the sun's ray from the observer (same constants; 64 steps) */
  function sunTransmittance(sun, turb, abs) {
    const Rg = 6360e3, Rt = 6460e3, o = [0, Rg + OBS_H, 0];
    const b = o[1] * sun.y, c = o[1] * o[1] - Rt * Rt, tt = -b + Math.sqrt(b * b - c), n = 64, st = tt / n;
    let dR = 0, dM = 0, dO = 0;
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) * st, x = sun.x * t, y = o[1] + sun.y * t, z = sun.z * t, h = Math.hypot(x, y, z) - Rg;
      dR += Math.exp(-h / 8000) * st; dM += Math.exp(-h / 1200) * st; dO += Math.max(0, 1 - Math.abs(h - 25e3) / 15e3) * st;
    }
    const bM = 3.996e-6 * turb, R = [5.802e-6, 13.558e-6, 33.1e-6], O = [0.650e-6, 1.881e-6, 0.085e-6];
    return [0, 1, 2].map(k => Math.exp(-(R[k] * dR + (bM + bM * abs[k]) * dM + O[k] * dO)));
  }
  SK.sunTransmittance = sunTransmittance;

  SK.init = function (scene, tx, Q, rend) {
    renderer = rend;
    rt = new T.WebGLRenderTarget(LW, LH, { type: T.HalfFloatType, format: T.RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    rt.texture.minFilter = rt.texture.magFilter = T.LinearFilter; rt.texture.wrapS = T.RepeatWrapping; rt.texture.wrapT = T.ClampToEdgeWrapping;
    const U = { uSun: { value: P.sun }, uAbs: { value: P.abs }, uAlb: { value: P.alb }, uOvc: { value: P.ovc }, uTurb: { value: 1 }, uOv: { value: 0 }, uOvL: { value: 1 }, uE: { value: SKY_E }, uObsH: { value: OBS_H } };
    lutMat = new T.ShaderMaterial({ uniforms: U, vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }', fragmentShader: LUT_F, depthTest: false, depthWrite: false });
    lutScene = new T.Scene(); lutCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const q = new T.Mesh(new T.PlaneGeometry(2, 2), lutMat); q.frustumCulled = false; lutScene.add(q);
    domeMat = new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, fog: false,
      uniforms: { tLut: { value: rt.texture }, tNoise: { value: tx.noise }, uSun: { value: P.sun }, uSunC: { value: new T.Vector3(1, 1, 1) }, uOv: { value: 0 }, uFlash: { value: 0 }, uDark: { value: 0 }, uDisc: { value: 60 },
        uDeck: { value: 0 }, uDeckH: { value: 1000 }, uVis: { value: 40000 }, uDrift: { value: new T.Vector2() } },
      vertexShader: 'varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
      fragmentShader: DOME_F
    });
    dome = new T.Mesh(new T.SphereGeometry(500, 48, 24), domeMat); dome.renderOrder = -10; dome.frustumCulled = false; scene.add(dome);
    dome.layers.enable(ENV_LAYER);
    envRT = new T.WebGLCubeRenderTarget(ENV_N, { type: T.HalfFloatType, generateMipmaps: false, minFilter: T.LinearFilter });
    envCam = new T.CubeCamera(1, 1000, envRT); envCam.layers.set(ENV_LAYER); for (const c of envCam.children) c.layers.set(ENV_LAYER);
    sceneRef = scene;
    SK.info.tex = rt.texture;
    return { mesh: dome, mat: domeMat };
  };

  /* new look: biome + weather kind (+ the biome's sun direction); renders the LUT and reads back the ring colours */
  SK.look = function (biome, kind, sunDir) {
    const B = BIOME[biome] || BIOME.temperate, Wk = Object.assign({}, WEATHER[kind] || WEATHER.clear);
    if (biome === 'volcanic') { Wk.ov = Math.max(Wk.ov, VOLC_MIN.ov); Wk.ovL = Math.min(Wk.ovL, VOLC_MIN.ovL); }
    P.sun.set(sunDir[0], sunDir[1], sunDir[2]).normalize();
    P.turb = B.turb * Wk.turb; P.abs.set(B.abs[0] * Wk.ash, B.abs[1] * Wk.ash, B.abs[2] * Wk.ash);
    P.alb.set(B.alb[0], B.alb[1], B.alb[2]); P.ovc.set(B.ovc[0], B.ovc[1], B.ovc[2]); P.ov = Wk.ov; P.ovL = Wk.ovL;
    P.storm = !!Wk.storm;
    const u = lutMat.uniforms; u.uTurb.value = P.turb; u.uOv.value = P.ov; u.uOvL.value = P.ovL;
    domeMat.uniforms.uOv.value = P.ov;
    domeMat.uniforms.uDeck.value = P.ov > 0.4 ? P.ov : 0;
    domeMat.uniforms.uDeckH.value = Wk.deckH || 1000;
    // the sun's colour after its path through this air, relative to a clean reference (temperate clear) so the
    // biome's hand-tuned light keeps its character and only aerosols / ash shift it
    const tr = sunTransmittance(P.sun, P.turb, [P.abs.x, P.abs.y, P.abs.z]), t0 = sunTransmittance(P.sun, 4, [0.11, 0.11, 0.11]);
    P.sunT.set(tr[0] / t0[0], tr[1] / t0[1], tr[2] / t0[2]);
    domeMat.uniforms.uSunC.value.set(tr[0], tr[1], tr[2]).multiplyScalar(1);
    const t0ms = performance.now();
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.render(lutScene, lutCam); renderer.setRenderTarget(prev);
    // ring colours (linear radiance): horizon (el ~ +1.5°), sky average (5-25°), zenith (top rows)
    const buf = new Uint16Array(LW * 4), row = el => Math.round((0.5 + 0.5 * Math.sqrt(el / (Math.PI / 2))) * LH - 0.5);
    const ring = (r0, r1) => {
      const s = [0, 0, 0]; let n = 0;
      for (let r = r0; r <= r1; r++) {
        renderer.readRenderTargetPixels(rt, 0, Math.min(LH - 1, r), LW, 1, buf);
        for (let i = 0; i < LW; i++) for (let k = 0; k < 3; k++) s[k] += T.DataUtils.fromHalfFloat(buf[i * 4 + k]);
        n += LW;
      }
      return s.map(v => v / n);
    };
    const toS = c => c.map(v => { const x = Math.max(0, v); return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055; });
    const hz = ring(row(0.02), row(0.035)), av = ring(row(0.09), row(0.44)), tp = ring(LH - 3, LH - 1);
    envT = -1;
    SK.info = { horizon: toS(hz), avg: toS(av), top: toS(tp), horizonLin: hz, storm: P.storm, phys: true, tex: rt.texture, env: envRT.texture, sunT: [P.sunT.x, P.sunT.y, P.sunT.z], ov: P.ov, ms: +(performance.now() - t0ms).toFixed(1) };
    return SK.info;
  };
  SK.frame = function (camera, drift, vis, time) {
    if (!dome) return;
    dome.position.copy(camera.position);
    if (drift) domeMat.uniforms.uDrift.value.copy(drift);
    if (vis) domeMat.uniforms.uVis.value = vis;
    if (envT < 0 || time - envT > ENV_DT || time < envT) {
      envT = time;
      const fog = sceneRef.fog; sceneRef.fog = null;
      envCam.position.copy(camera.position); envCam.update(renderer, sceneRef);
      sceneRef.fog = fog;
      // the clouds live in the far pass's scene (render/farland.js): draw them into the same cube, no clear
      const fs = SS.farView && SS.farView.scene && SS.farView.scene();
      if (fs) { const ac = renderer.autoClear; renderer.autoClear = false; envCam.update(renderer, fs); renderer.autoClear = ac; }
    }
  };
  SK.ENV_LAYER = ENV_LAYER;
  SK.mat = () => domeMat;
  SK.params = () => P;
})(window.SS = window.SS || {});
