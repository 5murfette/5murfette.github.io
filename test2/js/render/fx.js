/* render/fx.js — explosion / impact effects, 100 % procedural (Step 7; hard rule: fire, flames and fireballs are
 * shaders, never images). Purely cosmetic (Math.random is fine), driven by sim events through view.js.
 * One particle pool (typed arrays) drawn as two instanced camera-facing quads: ADDITIVE (fireball, afterburn
 * flames, sparks, glowing lava) and ALPHA (soot smoke, crater dust, steam, spray). The fragment shader builds every
 * puff from analytic 3D value noise (fbm, no texture): a turbulent, evolving edge; fire is coloured by its
 * temperature with a black-body approximation (Helland fit -> linear, radiance ~ (T / T0)^4, hot core); smoke is lit
 * from the sun side (uSun) with the sky / ground light (uSky / uGnd).
 * Physical picture (research §8 "Explosion effects (7)"): a TNT detonation's fireball (detonation products + afterburn
 * of the oxygen-poor products in air) reaches ~R_FB W^(1/3) m within milliseconds and stays luminous ~0.1-0.2 s
 * (core ~3000 K -> orange ~1500 K), then black soot smoke rises as a puffy column (buoyant, dispersing, greying over
 * seconds); the crater throws dust of the ground's own colour; water blasts throw spray.
 * API (unchanged): init(scene, textures, quality), look(L, sky), clear(), explosion(e, camDist), dust(x, y, z, n, size,
 * col), splash(x, y, z, size), trail(x, y, z), spark(x, y, z), lava(x, y, z, size), steam(x, y, z, power),
 * bubble(x, y, z), shake(), update(dt, camera), stats(). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const FX = SS.fx = {};
  const MAX = 2400, R_FB = 1.1;
  const P = { x: new Float32Array(MAX), y: new Float32Array(MAX), z: new Float32Array(MAX), vx: new Float32Array(MAX), vy: new Float32Array(MAX), vz: new Float32Array(MAX),
    age: new Float32Array(MAX), life: new Float32Array(MAX), s0: new Float32Array(MAX), s1: new Float32Array(MAX), rot: new Float32Array(MAX), spin: new Float32Array(MAX),
    kind: new Uint8Array(MAX), seed: new Float32Array(MAX), c0: new Float32Array(MAX * 3), c1: new Float32Array(MAX * 3), a0: new Float32Array(MAX), drag: new Float32Array(MAX),
    grav: new Float32Array(MAX), buoy: new Float32Array(MAX) };
  const KEYS = Object.keys(P);
  let n = 0, scene = null, flash = null, flashT = 9, shake = 0, add = null, alp = null;
  const K_FIRE = 0, K_SPARK = 1, K_SMOKE = 2, K_DUST = 3, K_STEAM = 4, K_LAVA = 5;
  const ADDITIVE = k => k === K_FIRE || k === K_SPARK || k === K_LAVA;
  const own = { uSun: { value: new T.Vector3(-0.4, 0.7, 0.6) }, uSunC: { value: new T.Color(1, 0.95, 0.85) }, uSky: { value: new T.Color(0.55, 0.6, 0.7) }, uGnd: { value: new T.Color(0.3, 0.27, 0.24) }, uTime: { value: 0 } };

  const VS = /* glsl */`
    attribute vec4 iPos;      // xyz, size
    attribute vec4 iA;        // rot, phase (age / life), kind, seed
    attribute vec3 iC; attribute float iAl;
    varying vec2 vUv; varying vec4 vA; varying vec3 vC; varying float vAl;
    void main(){
      vUv = position.xy * 2.0; vA = iA; vC = iC; vAl = iAl;
      vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      float c = cos(iA.x), s = sin(iA.x); vec2 q = mat2(c, s, -s, c) * position.xy;
      gl_Position = projectionMatrix * viewMatrix * vec4(iPos.xyz + (R * q.x + U * q.y) * iPos.w, 1.0);
    }`;
  const FS = /* glsl */`
    uniform vec3 uSun, uSunC, uSky, uGnd; uniform float uTime;
    varying vec2 vUv; varying vec4 vA; varying vec3 vC; varying float vAl;
    float h3(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
    float vn(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
    float fbm(vec3 p){ return 0.55 * vn(p) + 0.28 * vn(p * 2.03 + 1.7) + 0.17 * vn(p * 4.11 + 3.1); }
    // black body (Helland's fit of the Planck locus, sRGB) -> linear RGB, normalised
    vec3 bb(float K){
      float t = K / 100.0, r, g, b;
      r = t <= 66.0 ? 1.0 : clamp(1.2929 * pow(t - 60.0, -0.1332), 0.0, 1.0);
      g = t <= 66.0 ? clamp(0.3901 * log(t) - 0.6318, 0.0, 1.0) : clamp(1.1299 * pow(t - 60.0, -0.0755), 0.0, 1.0);
      b = t >= 66.0 ? 1.0 : t <= 19.0 ? 0.0 : clamp(0.5432 * log(t - 10.0) - 1.1963, 0.0, 1.0);
      return pow(vec3(r, g, b), vec3(2.2));
    }
    void main(){
      float r = length(vUv); if (r > 1.0) discard;
      float ph = vA.y, kind = vA.z, sd = vA.w;
      vec3 q = vec3(vUv * 1.6, sd * 17.0 + ph * 1.3);
      float nz = fbm(q + vec3(0.0, -ph * 1.5, 0.0));
      if (kind < 0.5) {                                    // fire: turbulent puff, hot core
        float edge = 1.0 - smoothstep(0.35 + 0.45 * nz, 0.95, r);
        if (edge < 0.01) discard;
        float Tk = mix(vC.x, vC.y, ph) * (0.78 + 0.32 * (1.0 - r) + 0.18 * (nz - 0.5));
        float L = pow(Tk / 2200.0, 4.0) * 1.6;
        gl_FragColor = vec4(bb(Tk) * L * edge * vAl, 1.0);
      } else if (kind < 1.5 || kind > 4.5) {               // spark / glowing lava blob: small, round, hot
        float a = exp(-r * r * 5.0);
        float Tk = mix(vC.x, vC.y, ph);
        gl_FragColor = vec4(bb(Tk) * pow(Tk / 2000.0, 4.0) * 2.0 * a * vAl, 1.0);
      } else {                                             // smoke / dust / steam: lit puff
        float dens = (1.0 - smoothstep(0.25 + 0.5 * nz, 0.98, r)) * (0.65 + 0.7 * nz);
        if (dens < 0.01) discard;
        vec3 nrm = normalize(vec3(vUv, sqrt(max(0.0, 1.0 - r * r)) + 0.3));
        vec3 sunV = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
        float lam = 0.55 + 0.45 * dot(nrm, sunV);
        vec3 amb = mix(uGnd, uSky, 0.5 + 0.5 * vUv.y);
        float sc = kind > 3.5 ? 0.9 : kind > 2.5 ? 0.55 : 0.25;                 // steam scatters, soot absorbs
        vec3 c = vC * (amb * 0.6 + uSunC * lam * sc + uSunC * 0.15);
        gl_FragColor = vec4(c, dens * vAl);
      }
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  function system(additive) {
    const g = new T.InstancedBufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const at = (name, k) => { const a = new T.InstancedBufferAttribute(new Float32Array(MAX * k), k).setUsage(T.DynamicDrawUsage); g.setAttribute(name, a); return a; };
    const iPos = at('iPos', 4), iA = at('iA', 4), iC = at('iC', 3), iAl = at('iAl', 1);
    g.instanceCount = 0;
    // DoubleSide: camera-facing quads from the view matrix are front-facing, but keep them safe from any winding flip
    const m = new T.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: T.DoubleSide,
      blending: additive ? T.AdditiveBlending : T.NormalBlending, uniforms: own });
    const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = additive ? 9 : 8; mesh.visible = false; scene.add(mesh);
    return { g, mesh, iPos, iA, iC, iAl };
  }

  FX.init = function (sc) {
    scene = sc;
    flash = new T.PointLight(0xffa850, 0, 16, 2); scene.add(flash);
    add = system(true); alp = system(false);
  };
  FX.look = function (L, sk) {
    if (!L) return;
    if (L.sunDir) own.uSun.value.set(L.sunDir[0], L.sunDir[1], L.sunDir[2]).normalize();
    if (L.sun) own.uSunC.value.set(L.sun).multiplyScalar(Math.min(1.2, (L.sunI || 3) / 3));
    if (sk && sk.horizon) own.uSky.value.setRGB(sk.horizon[0], sk.horizon[1], sk.horizon[2], T.SRGBColorSpace);
    if (L.hemiG) own.uGnd.value.set(L.hemiG);
  };
  FX.clear = function () { n = 0; later.length = 0; shake = 0; flashT = 9; if (flash) flash.intensity = 0; };   // a new map starts calm

  const rnd = (a, b) => a + Math.random() * (b - a);
  function sphereDir() { const u = rnd(-1, 1), a = rnd(0, 6.283), r = Math.sqrt(1 - u * u); return [r * Math.cos(a), u, r * Math.sin(a)]; }
  // o: {vx, vy, vz, life, s0, s1, c0 [3], c1 [3], a0, drag, grav, buoy}; fire / spark / lava colours are [T0, T1, 0] in K
  function spawn(kind, x, y, z, o) {
    let i = n;
    if (n >= MAX) { let best = 0, bf = -1; for (let k = 0; k < MAX; k += 7) { const f = P.age[k] / P.life[k]; if (f > bf) { bf = f; best = k; } } i = best; }
    else n++;
    P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = o.vx || 0; P.vy[i] = o.vy || 0; P.vz[i] = o.vz || 0;
    P.age[i] = 0; P.life[i] = o.life || 1; P.s0[i] = o.s0 || 0.5; P.s1[i] = o.s1 || 1; P.rot[i] = rnd(0, 6.283); P.spin[i] = rnd(-0.6, 0.6);
    P.kind[i] = kind; P.seed[i] = Math.random() * 100; P.a0[i] = o.a0 == null ? 1 : o.a0; P.drag[i] = o.drag || 0; P.grav[i] = o.grav || 0; P.buoy[i] = o.buoy || 0;
    const c0 = o.c0 || [1, 1, 1], c1 = o.c1 || c0;
    P.c0[i * 3] = c0[0]; P.c0[i * 3 + 1] = c0[1]; P.c0[i * 3 + 2] = c0[2]; P.c1[i * 3] = c1[0]; P.c1[i * 3 + 1] = c1[1]; P.c1[i * 3 + 2] = c1[2];
  }
  const hex = h => { const c = new T.Color(h); return [c.r, c.g, c.b]; };

  FX.explosion = function (e, camDist) {
    const W3 = Math.cbrt(e.W || Math.pow((e.R || 3) / 3, 3)), Rf = R_FB * W3;
    // P30g: a charge under the water makes no fireball or soot (the water quenches it): a dim green-white glow under
    // the surface and a burst of bubbles; the surface show (dome, crown, jet, base surge, foam) is FX.waterBlast
    if (e.wet != null && e.wet > 0.25) {
      for (let i = 0; i < 18; i++) { const d = sphereDir(), sp = rnd(0.5, 2.5) * W3; spawn(K_STEAM, e.x + d[0] * 0.3, e.y + d[1] * 0.3, e.z + d[2] * 0.3, { vx: d[0] * sp, vy: rnd(1.5, 4), vz: d[2] * sp, drag: 3, life: Math.min(1.2, 0.25 + e.wet * 0.4), s0: 0.08, s1: rnd(0.15, 0.4) * W3, a0: 0.7, c0: [0.8, 0.92, 0.95] }); }
      flash.position.set(e.x, e.y + e.wet, e.z); flash.intensity = 14 * Rf * Math.exp(-e.wet / 1.5); flashT = 0;
      shake = Math.min(1.2, shake + (e.R || 3) * 0.3 * Math.max(0.3, 1 - camDist / 60));
      return;
    }
    const wet = e.wet != null;                         // a contact burst on the water: a smaller, short fireball, little soot
    if (wet) { const k = 0.6; spawn(K_FIRE, e.x, e.y + 0.15, e.z, { life: 0.1 + 0.05 * W3, s0: Rf * 0.5 * k, s1: Rf * 1.5 * k, c0: [3000, 1500, 0], a0: 1 });
      for (let i = 0; i < 5; i++) { const d = sphereDir(), sp = rnd(3, 7) * W3; spawn(K_FIRE, e.x, e.y + 0.2, e.z, { vx: d[0] * sp, vy: Math.abs(d[1]) * sp + 2, vz: d[2] * sp, drag: 10, life: rnd(0.15, 0.3), s0: Rf * 0.3, s1: Rf * 0.8, c0: [2400, 1000, 0], a0: 0.9 }); }
      for (let i = 0; i < 5; i++) { const sp = rnd(0.3, 1.2) * W3, a = rnd(0, 6.283); spawn(K_SMOKE, e.x, e.y + 0.6, e.z, { vx: Math.cos(a) * sp, vy: rnd(1, 2.5) * W3, vz: Math.sin(a) * sp, drag: 1.2, buoy: 0.6, life: rnd(1.5, 2.5), s0: Rf * 0.4, s1: Rf * 2, c0: [0.12, 0.11, 0.1], c1: [0.45, 0.45, 0.45], a0: 0.5 }); }
      flash.position.set(e.x, e.y + 0.5, e.z); flash.intensity = 40 * Rf; flashT = 0;
      shake = Math.min(1.2, shake + (e.R || 3) * 0.25 * Math.max(0.3, 1 - camDist / 60));
      return;
    }
    // fireball: a hot core puff + turbulent lobes (detonation products + afterburn), luminous ~0.1-0.2 W^1/3 s
    spawn(K_FIRE, e.x, e.y + 0.1, e.z, { life: 0.12 + 0.08 * W3, s0: Rf * 0.6, s1: Rf * 2.1, c0: [3200, 1500, 0], a0: 1 });
    for (let i = 0; i < 9; i++) {
      const d = sphereDir(), sp = rnd(3, 9) * W3;
      spawn(K_FIRE, e.x + d[0] * 0.2, e.y + 0.15 + Math.abs(d[1]) * 0.2, e.z + d[2] * 0.2, { vx: d[0] * sp, vy: Math.abs(d[1]) * sp + 1, vz: d[2] * sp, drag: 9,
        life: rnd(0.25, 0.5) * (0.7 + 0.3 * W3), s0: Rf * 0.4, s1: Rf * rnd(0.9, 1.4), c0: [rnd(2200, 2700), rnd(900, 1100), 0], a0: 0.9, buoy: 2 });
    }
    // soot: TNT is oxygen-poor, its smoke is black; a buoyant puffy column that greys as it thins
    for (let i = 0; i < 14; i++) {
      const d = sphereDir(), sp = rnd(0.5, 2.5) * W3;
      spawn(K_SMOKE, e.x + d[0] * Rf * 0.4, e.y + 0.2 + Math.abs(d[1]) * Rf * 0.3, e.z + d[2] * Rf * 0.4, { vx: d[0] * sp, vy: rnd(1.5, 3.5) * W3, vz: d[2] * sp, drag: 1.2, buoy: 0.8,
        life: rnd(2.5, 4.5), s0: Rf * 0.5, s1: Rf * rnd(2.2, 3.4), c0: [0.06, 0.055, 0.05], c1: [0.32, 0.31, 0.3], a0: 0.8 });
    }
    // crater dust of the ground's own colour (the material that dominated the crater)
    let m = 0, best = 0; if (e.byMat) for (let k = 1; k < e.byMat.length; k++) if (e.byMat[k] > best) { best = e.byMat[k]; m = k; }
    if (best > 0) {
      const mat = SS.CFG.MATS[m], col = hex(mat.rgb || 0x8a7d70), nd = Math.min(16, 6 + best / 40 | 0);
      for (let i = 0; i < nd; i++) {
        const a = rnd(0, 6.283), sp = rnd(1.5, 5) * W3;
        spawn(K_DUST, e.x + Math.cos(a) * 0.4, e.y + 0.1, e.z + Math.sin(a) * 0.4, { vx: Math.cos(a) * sp, vy: rnd(2, 6) * W3, vz: Math.sin(a) * sp, drag: 2.2, grav: 2.5,
          life: rnd(1.5, 2.8), s0: 0.5 * W3, s1: rnd(1.5, 2.6) * W3, c0: col, c1: col.map(v => v * 1.1 + 0.05), a0: 0.65 });
      }
    }
    // burning bits (the casing's hot fragments are drawn by render/shrapnel.js): a few slow sparks
    for (let i = 0; i < 10; i++) { const d = sphereDir(), sp = rnd(4, 10); spawn(K_SPARK, e.x, e.y + 0.1, e.z, { vx: d[0] * sp, vy: Math.abs(d[1]) * sp + 2, vz: d[2] * sp, life: rnd(0.4, 0.9), s0: 0.12, s1: 0.06, c0: [2200, 1100, 0], grav: 9.8, drag: 0.6 }); }
    flash.position.set(e.x, e.y + 0.5, e.z); flash.intensity = 55 * Rf; flashT = 0;
    shake = Math.min(1.2, shake + (e.R || 3) * 0.25 * Math.max(0.3, 1 - camDist / 60));
  };
  FX.dust = function (x, y, z, cnt, size, col) {
    const c = hex(col == null ? 0xb8a080 : col);
    for (let i = 0; i < cnt; i++) {
      const a = rnd(0, 6.283), sp = rnd(0.6, 1.8);
      spawn(K_DUST, x, y + 0.05, z, { vx: Math.cos(a) * sp, vy: rnd(0.2, 0.9), vz: Math.sin(a) * sp, life: rnd(0.8, 1.5), s0: size * 0.4, s1: size * rnd(1, 1.6), a0: 0.5, c0: c, c1: c.map(v => v * 1.08 + 0.04), drag: 2.5 });
    }
  };
  FX.splash = function (x, y, z, size) {
    for (let i = 0; i < 22 * size; i++) {
      const a = rnd(0, 6.283), sp = rnd(0.5, 3) * size;
      spawn(K_STEAM, x, y, z, { vx: Math.cos(a) * sp, vy: rnd(3, 7) * size, vz: Math.sin(a) * sp, life: rnd(0.6, 1.1), s0: 0.14 * size, s1: 0.22 * size, a0: 0.8, c0: [0.92, 0.96, 1], grav: 9.8, drag: 0.3 });
    }
    for (let i = 0; i < 7; i++) spawn(K_STEAM, x + rnd(-0.5, 0.5), y + 0.2, z + rnd(-0.5, 0.5), { vy: rnd(0.4, 1.2), life: rnd(0.8, 1.4), s0: 0.6 * size, s1: 1.8 * size, a0: 0.5, c0: [0.95, 0.97, 1], drag: 2 });
  };
  /* P30g: a blast in / on the water (the 'waterblast' event; e.R cavity radius, e.under, e.tJet, e.jetH):
   *   - the dome / crown: a ring of spray thrown up and out of the opening cavity at once;
   *   - the implosion jet: the cavity's walls converge and throw a column of water up the centre (after tJet), which
   *     falls back as rain of spray;
   *   - the base surge: a low ring of mist rolling out over the water;
   *   (the ring wave and the foam are the water sim and render/water.js) */
  const later = [];
  function spray(x, y, z, vx, vy, vz, s, life) { spawn(K_STEAM, x, y, z, { vx, vy, vz, life, s0: s, s1: s * 1.6, a0: 0.9, c0: [0.93, 0.97, 1], c1: [0.96, 0.98, 1], grav: 9.8, drag: 0.25 }); }
  FX.waterBlast = function (e) {
    const sz = Math.min(2.4, Math.max(0.6, e.R / 2.8)), R = e.R, jet = e.jetH || 3 * sz;
    const nC = Math.round(46 * sz), crownV = Math.sqrt(2 * 9.8 * jet * (e.under ? 0.45 : 0.7));
    for (let i = 0; i < nC; i++) {                                  // crown: a cone of spray from the cavity rim
      const a = rnd(0, 6.283), r0 = R * rnd(0.15, 0.5), out = rnd(1.5, 4.5) * sz;
      spray(e.x + Math.cos(a) * r0, e.y + 0.05, e.z + Math.sin(a) * r0, Math.cos(a) * out, crownV * rnd(0.55, 1.05), Math.sin(a) * out, rnd(0.12, 0.26) * sz, rnd(0.9, 1.6));
    }
    later.push({ t: e.tJet || 0.25, fn: () => {                     // the jet column
      const v0 = Math.sqrt(2 * 9.8 * jet), nJ = Math.round(80 * sz), rj = R * 0.16;
      for (let i = 0; i < nJ; i++) {                                // a dense core (fast, narrow) inside a looser sheath
        const a = rnd(0, 6.283), r0 = rj * Math.sqrt(Math.random()), f = Math.sqrt(Math.random()) * 0.75 + 0.25, core = i % 3 !== 0;
        spray(e.x + Math.cos(a) * r0, e.y + 0.1, e.z + Math.sin(a) * r0, Math.cos(a) * rnd(0.1, core ? 0.5 : 1.4), v0 * f, Math.sin(a) * rnd(0.1, core ? 0.5 : 1.4),
          rnd(0.3, 0.6) * sz, 2 * v0 * f / 9.8 + rnd(0.3, 0.6));
      }
      for (let i = 0; i < 8; i++) spawn(K_STEAM, e.x + rnd(-rj, rj), e.y + jet * rnd(0.3, 0.9), e.z + rnd(-rj, rj), { vy: rnd(0.2, 1.0), life: rnd(1.6, 2.6), s0: 0.5 * sz, s1: rnd(1.6, 2.6) * sz, a0: 0.45, c0: [0.95, 0.97, 1], drag: 1.5 });
    } });
    later.push({ t: (e.tJet || 0.25) + 0.15, fn: () => {            // base surge: mist rolling out low over the water
      const nS = Math.round(16 * sz);
      for (let i = 0; i < nS; i++) { const a = i / nS * 6.283 + rnd(-0.2, 0.2), v = rnd(2, 4) * sz;
        spawn(K_STEAM, e.x + Math.cos(a) * R * 0.4, e.y + 0.3, e.z + Math.sin(a) * R * 0.4, { vx: Math.cos(a) * v, vy: rnd(0.1, 0.5), vz: Math.sin(a) * v, drag: 1.1, life: rnd(2.2, 3.6), s0: 0.6 * sz, s1: rnd(2.2, 3.2) * sz, a0: 0.5, c0: [0.93, 0.95, 0.98], c1: [0.9, 0.92, 0.95] }); }
    } });
  };
  FX.trail = function (x, y, z) {
    spawn(K_SMOKE, x, y, z, { vx: rnd(-0.2, 0.2), vy: rnd(0.1, 0.5), vz: rnd(-0.2, 0.2), life: rnd(0.8, 1.4), s0: 0.16, s1: 0.9, a0: 0.45, c0: [0.75, 0.73, 0.7], c1: [0.8, 0.8, 0.8], drag: 1.2 });
    spawn(K_FIRE, x, y, z, { life: 0.1, s0: 0.3, s1: 0.12, c0: [2600, 1600, 0] });
  };
  FX.spark = function (x, y, z) {
    for (let i = 0; i < 8; i++) { const d = sphereDir(), sp = rnd(1.5, 4); spawn(K_SPARK, x, y, z, { vx: d[0] * sp, vy: Math.abs(d[1]) * sp, vz: d[2] * sp, life: rnd(0.2, 0.4), s0: 0.1, s1: 0.04, c0: [2400, 1200, 0], grav: 9.8 }); }
  };
  FX.bubble = function (x, y, z) { spawn(K_STEAM, x + rnd(-0.1, 0.1), y, z + rnd(-0.1, 0.1), { vy: rnd(0.6, 1.2), life: rnd(0.4, 0.8), s0: 0.06, s1: 0.1, a0: 0.5, c0: [0.85, 0.95, 1] }); };
  /* molten lava thrown up (projectile entry, blast splash, pocket breach): glowing blobs that arc and dim, dark fume */
  FX.lava = function (x, y, z, size) {
    const k = Math.round(10 + 18 * size);
    for (let i = 0; i < k; i++) {
      const a = rnd(0, 6.283), sp = rnd(0.4, 2.2) * size;
      spawn(K_LAVA, x, y + 0.05, z, { vx: Math.cos(a) * sp, vy: rnd(1.5, 4.5) * Math.sqrt(size), vz: Math.sin(a) * sp, life: rnd(0.7, 1.4), s0: rnd(0.1, 0.22) * Math.sqrt(size), s1: 0.06, c0: [1450, 900, 0], grav: 9.8, drag: 0.4 });
    }
    for (let i = 0; i < 4 + 4 * size; i++) spawn(K_SMOKE, x + rnd(-0.4, 0.4) * size, y + 0.3, z + rnd(-0.4, 0.4) * size, { vy: rnd(0.4, 1.0), life: rnd(1.2, 2.2), s0: 0.5 * size, s1: 1.8 * size, a0: 0.35, c0: [0.2, 0.18, 0.17], c1: [0.45, 0.44, 0.43], drag: 1.5, buoy: 0.3 });
  };
  /* lava meeting the sea: white steam billows */
  FX.steam = function (x, y, z, power) {
    // P31: a strong quench contact (power up to ~6) boils hard: more and bigger billows, fast-rising vapour jets
    const p = Math.min(6, power || 1), k = Math.round(2 + p * 1.6), sp = 0.6 + p * 0.25, sz = 1 + p * 0.15;
    for (let i = 0; i < k; i++) spawn(K_STEAM, x + rnd(-sp, sp), y + 0.1, z + rnd(-sp, sp), { vx: rnd(-0.3, 0.3), vy: rnd(0.6, 1.4) + p * 0.25, vz: rnd(-0.3, 0.3), life: rnd(1.6, 2.8) + p * 0.15, s0: 0.5 * sz, s1: rnd(2.2, 3.4) * sz, a0: 0.42 + p * 0.04, c0: [0.95, 0.95, 0.96], c1: [0.88, 0.89, 0.92], drag: 0.8, buoy: 0.4 });
    for (let i = 0; i < p - 1; i++) spawn(K_STEAM, x + rnd(-sp, sp), y + 0.05, z + rnd(-sp, sp), { vy: rnd(3, 5), life: rnd(0.5, 0.9), s0: 0.2, s1: 0.9, a0: 0.6, c0: [0.97, 0.97, 0.98], drag: 2.2 });
  };

  FX.shake = () => shake;
  let nAdd = 0, nAlp = 0;
  FX.update = function (dt) {
    own.uTime.value += dt;
    for (let q = later.length - 1; q >= 0; q--) if ((later[q].t -= dt) <= 0) { const L = later[q]; later.splice(q, 1); L.fn(); }
    let i = 0;
    while (i < n) {
      P.age[i] += dt;
      if (P.age[i] >= P.life[i]) {                         // swap-remove
        const j = --n;
        if (j !== i) for (const key of KEYS) { const a = P[key]; if (a.length === MAX * 3) { a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; } else a[i] = a[j]; }
        continue;
      }
      const dr = Math.exp(-P.drag[i] * dt);
      P.vx[i] *= dr; P.vz[i] *= dr; P.vy[i] = P.vy[i] * dr + (P.buoy[i] - P.grav[i]) * dt;
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt; P.rot[i] += P.spin[i] * dt;
      i++;
    }
    nAdd = 0; nAlp = 0;
    for (let k = 0; k < n; k++) {
      const hot = ADDITIVE(P.kind[k]), s = hot ? add : alp, q = hot ? nAdd++ : nAlp++;
      const f = P.age[k] / P.life[k], sz = P.s0[k] + (P.s1[k] - P.s0[k]) * (1 - (1 - f) * (1 - f));
      const ip = s.iPos.array, ia = s.iA.array, ic = s.iC.array;
      ip[q * 4] = P.x[k]; ip[q * 4 + 1] = P.y[k]; ip[q * 4 + 2] = P.z[k]; ip[q * 4 + 3] = sz;
      ia[q * 4] = P.rot[k]; ia[q * 4 + 1] = f; ia[q * 4 + 2] = P.kind[k]; ia[q * 4 + 3] = P.seed[k];
      if (hot) { ic[q * 3] = P.c0[k * 3]; ic[q * 3 + 1] = P.c0[k * 3 + 1]; ic[q * 3 + 2] = 0; }
      else for (let c = 0; c < 3; c++) ic[q * 3 + c] = P.c0[k * 3 + c] + (P.c1[k * 3 + c] - P.c0[k * 3 + c]) * f;
      s.iAl.array[q] = P.a0[k] * (hot ? (1 - f) : Math.min(1, f * 6) * (1 - f) * (1 - f));
    }
    for (const [s, c] of [[add, nAdd], [alp, nAlp]]) {
      s.g.instanceCount = c; s.mesh.visible = c > 0;
      if (c) { s.iPos.needsUpdate = true; s.iA.needsUpdate = true; s.iC.needsUpdate = true; s.iAl.needsUpdate = true; }
    }
    flashT += dt; flash.intensity = flashT < 0.4 ? flash.intensity * Math.exp(-dt * 9) : 0;
    shake = Math.max(0, shake - dt * 2.2);
  };
  FX.stats = () => ({ n, add: nAdd, alpha: nAlp });
})(window.SS = window.SS || {});
