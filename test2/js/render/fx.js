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
  let n = 0, scene = null, flash = null, flashT = 9, glowT = 9, glowI = 0, shake = 0, add = null, alp = null;
  const K_FIRE = 0, K_SPARK = 1, K_SMOKE = 2, K_DUST = 3, K_STEAM = 4, K_LAVA = 5, K_CHUNK = 6;   // K_CHUNK: a solid rock / clod / ice shard (alpha pass, bounces on the ground)
  const ADDITIVE = k => k === K_FIRE || k === K_SPARK || k === K_LAVA;
  const own = { uSun: { value: new T.Vector3(-0.4, 0.7, 0.6) }, uSunC: { value: new T.Color(1, 0.95, 0.85) }, uGlow: { value: new T.Vector4(0, 0, 0, 0) }, uGlowC: { value: new T.Color(1, 0.45, 0.12) }, uSky: { value: new T.Color(0.55, 0.6, 0.7) }, uGnd: { value: new T.Color(0.3, 0.27, 0.24) }, uTime: { value: 0 } };

  const VS = /* glsl */`
    attribute vec4 iPos;      // xyz, size
    attribute vec4 iA;        // rot, phase (age / life), kind, seed
    attribute vec3 iC; attribute float iAl;
    varying vec2 vUv; varying vec4 vA; varying vec3 vC; varying float vAl; varying vec3 vP;
    void main(){
      vUv = position.xy * 2.0; vA = iA; vC = iC; vAl = iAl; vP = iPos.xyz;
      vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      float c = cos(iA.x), s = sin(iA.x); vec2 q = mat2(c, s, -s, c) * position.xy;
      gl_Position = projectionMatrix * viewMatrix * vec4(iPos.xyz + (R * q.x + U * q.y) * iPos.w, 1.0);
    }`;
  const FS = /* glsl */`
    uniform vec3 uSun, uSunC, uSky, uGnd, uGlowC; uniform vec4 uGlow; uniform float uTime;
    varying vec2 vUv; varying vec4 vA; varying vec3 vC; varying float vAl; varying vec3 vP;
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
      } else if (kind > 5.5) {                               // debris chunk: a hard-edged lumpy solid, lit from the sun
        float ang = atan(vUv.y, vUv.x); float lump = 0.5 + 0.28 * nz + 0.14 * sin(ang * 3.0 + sd * 40.0) + 0.08 * sin(ang * 5.0 + sd * 17.0);
        float a = 1.0 - smoothstep(lump, lump + 0.12, r); if (a < 0.02) discard;
        vec3 nrm = normalize(vec3(vUv * 0.9, sqrt(max(0.0, 1.0 - r * r)) + 0.15));
        vec3 sunV = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
        float lam = clamp(dot(nrm, sunV) * 0.6 + 0.5, 0.0, 1.0);
        vec3 amb = mix(uGnd, uSky, 0.5 + 0.5 * vUv.y);
        gl_FragColor = vec4(vC * (0.4 * amb + uSunC * lam * 0.55) * (0.7 + 0.6 * nz), a * vAl);
      } else if (kind < 1.5 || kind > 4.5) {               // spark / glowing lava blob: small, round, hot
        float a = exp(-r * r * 5.0);
        float Tk = mix(vC.x, vC.y, ph);
        gl_FragColor = vec4(bb(Tk) * pow(Tk / 2000.0, 4.0) * 2.0 * a * vAl, 1.0);
      } else {                                             // smoke / dust / steam: lit puff
        float nz2 = fbm(q * 1.9 + vec3(3.3, 1.1, 0.0));
        float dens = (1.0 - smoothstep(0.12 + 0.55 * nz, 0.98, r)) * (0.35 + 1.0 * nz2) * (0.9 + 0.4 * nz);
        if (dens < 0.01) discard;
        vec3 nrm = normalize(vec3(vUv, sqrt(max(0.0, 1.0 - r * r)) + 0.3));
        vec3 sunV = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
        float lam = 0.55 + 0.45 * dot(nrm, sunV);
        vec3 amb = mix(uGnd, uSky, 0.5 + 0.5 * vUv.y);
        float sc = kind > 3.5 ? 0.9 : kind > 2.5 ? 0.55 : 0.25;                 // steam scatters, soot absorbs
        vec3 c = vC * (amb * 0.6 + uSunC * lam * sc + uSunC * 0.15);
        float gd = length(vP - uGlow.xyz);                                      // the fireball's afterglow lights the smoke / dust around it (night, dusk, storm)
        c += uGlowC * uGlow.w * (0.6 + 0.4 * (1.0 - vUv.y * 0.5)) / (1.0 + gd * gd * 0.18) * (0.25 + vC.r * 0.9) * (1.0 - 0.7 * clamp(dot(vC, vec3(0.33)), 0.0, 1.0));
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
  FX.clear = function () { n = 0; glowI = 0; own.uGlow.value.w = 0; later.length = 0; shake = 0; flashT = 9; if (flash) flash.intensity = 0; };   // a new map starts calm

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
  FX.spawn = spawn; FX.hex = hex; FX.KIND = { CHUNK: K_CHUNK, FIRE: K_FIRE, SPARK: K_SPARK, SMOKE: K_SMOKE, DUST: K_DUST, STEAM: K_STEAM, LAVA: K_LAVA };   // P37-W3: custom puffs (acid, gas, minigun)

  FX.env = { tod: 'day', rain: 0, snow: 0, under: false };            // set by view.js each frame (time of day, precipitation 0..1)
  /* per material: dust colour (rgb 0..1), fines amount, puff size, lift of the fountain, chunk count, chunk colour, 'hardness' (sparks, fast chunks),
   * loft (how much the dirt masks the soot), cold (white powder mist), scorch (how much the ground blackens) */
  const MFX = {};
  function mfx(id, dust, amt, puff, lift, chunks, hard, loft, cold, scorch, chunkc) { MFX[id] = { dust, amt, puff, lift, chunks, hard, loft, cold, scorch, chunk: chunkc || dust }; }
  (function () {
    const M2 = SS.CFG.MAT, h = SS.fx.hex, mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
    const g = (id, k) => mix(h(SS.CFG.MATS[id].rgb), [0.55, 0.53, 0.5], k);      // dust: the material's colour dulled toward a dry grey
    mfx(M2.SOIL, g(M2.SOIL, 0.1), 1.3, 1.1, 1.1, 1.1, 0.35, 0.8, 0, 1.0);
    mfx(M2.SAND, g(M2.SAND, 0.05), 1.5, 1.35, 1.3, 0.15, 0.1, 0.9, 0, 0.55, g(M2.SAND, 0.0));
    mfx(M2.ROCK, g(M2.ROCK, 0.45), 0.8, 0.9, 0.9, 1.5, 0.85, 0.35, 0, 0.85);
    mfx(M2.SANDSTONE, g(M2.SANDSTONE, 0.25), 1.0, 1.0, 1.0, 1.3, 0.7, 0.5, 0, 0.8);
    mfx(M2.SNOW, [0.95, 0.97, 1], 1.8, 1.5, 1.2, 0.35, 0.05, 0.8, 1.0, 0.55, [0.92, 0.95, 0.98]);
    mfx(M2.ICE, [0.8, 0.92, 1], 0.5, 0.8, 1.0, 1.7, 0.6, 0.1, 0.5, 0.2, [0.75, 0.92, 1.0]);
    mfx(M2.BASALT, g(M2.BASALT, 0.55), 0.7, 0.9, 0.9, 1.4, 0.9, 0.3, 0, 0.3, [0.2, 0.19, 0.18]);
    mfx(M2.CRUST, g(M2.CRUST, 0.55), 0.8, 0.9, 0.9, 1.4, 0.8, 0.3, 0, 0.25, [0.17, 0.15, 0.14]);
    mfx(M2.ASH, [0.34, 0.32, 0.3], 2.0, 1.5, 1.0, 0.1, 0.0, 0.9, 0, 0.6, [0.25, 0.23, 0.22]);
    mfx(M2.SCREE, g(M2.SCREE, 0.3), 1.0, 1.0, 1.0, 1.5, 0.7, 0.5, 0, 0.7);
    mfx(M2.STEEL, [0.4, 0.38, 0.36], 0.25, 0.6, 0.8, 0.45, 1.0, 0.0, 0, 0.5, [0.3, 0.3, 0.32]);
    mfx(M2.FOAM, [0.93, 0.96, 0.99], 1.6, 1.4, 1.2, 0.3, 0.0, 0.6, 0.5, 0.45, [0.9, 0.94, 0.98]);
    mfx(M2.CONCRETE, [0.6, 0.59, 0.57], 1.0, 1.1, 0.9, 1.6, 0.9, 0.4, 0, 0.8, [0.55, 0.54, 0.52]);
    mfx(M2.OBSIDIAN, [0.2, 0.19, 0.2], 0.5, 0.8, 0.8, 1.8, 1.0, 0.1, 0, 0.2, [0.12, 0.11, 0.13]);
    mfx(M2.BEDROCK, g(M2.BEDROCK, 0.4), 0.7, 0.9, 0.9, 1.2, 0.9, 0.3, 0, 0.5);
  })();
  const MIXR = { dust: [0, 0, 0], chunk: [0, 0, 0] };
  /* the blast's ground: blend of the materials the crater removed (e.byMat), weighted by voxel count */
  function matMix(e) {
    const o = { best: 0, dust: [0.55, 0.5, 0.45], chunk: [0.4, 0.36, 0.32], amt: 1, puff: 1, lift: 1, chunks: 1, hard: 0.5, loft: 0.5, cold: 0, scorch: 0.8 };
    if (!e.byMat) return o;
    let tot = 0; for (let k = 1; k < e.byMat.length; k++) tot += e.byMat[k] || 0;
    if (tot <= 0) return o;
    o.best = tot; o.dust = [0, 0, 0]; o.chunk = [0, 0, 0]; o.amt = o.puff = o.lift = o.chunks = o.hard = o.loft = o.cold = o.scorch = 0;
    for (let k = 1; k < e.byMat.length; k++) {
      const c = e.byMat[k]; if (!c) continue;
      const f = MFX[k] || MFX[SS.CFG.MAT.ROCK], w = c / tot;
      for (let q = 0; q < 3; q++) { o.dust[q] += f.dust[q] * w; o.chunk[q] += f.chunk[q] * w; }
      o.amt += f.amt * w; o.puff += f.puff * w; o.lift += f.lift * w; o.chunks += f.chunks * w; o.hard += f.hard * w; o.loft += f.loft * w; o.cold += f.cold * w; o.scorch += f.scorch * w;
    }
    return o;
  }
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
    const mf = matMix(e), env = FX.env, rain = env.rain, hard = mf.hard;
    if (SS.flameView) SS.flameView.fireball(e.x, e.y, e.z, Rf, W3, 1);              // P45: rolling procedural fireball (render/flame.js)
    else {
      spawn(K_FIRE, e.x, e.y + 0.1, e.z, { life: 0.12 + 0.08 * W3, s0: Rf * 0.6, s1: Rf * 2.1, c0: [3200, 1500, 0], a0: 1 });
      for (let i = 0; i < 9; i++) {
        const d = sphereDir(), sp = rnd(3, 9) * W3;
        spawn(K_FIRE, e.x + d[0] * 0.2, e.y + 0.15 + Math.abs(d[1]) * 0.2, e.z + d[2] * 0.2, { vx: d[0] * sp, vy: Math.abs(d[1]) * sp + 1, vz: d[2] * sp, drag: 9,
          life: rnd(0.25, 0.5) * (0.7 + 0.3 * W3), s0: Rf * 0.4, s1: Rf * rnd(0.9, 1.4), c0: [rnd(2200, 2700), rnd(900, 1100), 0], a0: 0.9, buoy: 2 });
      }
    }
    // soot: TNT is oxygen-poor, its smoke is black; a buoyant puffy column that greys as it thins. Over loose ground the
    // dirt it lofts mixes in (browner, lighter); over snow / ice / foam the vapour is white; rain beats it down and greys it.
    const cave = env.under ? 1.35 : 1;                                       // a cave holds its smoke and dust (no sky to rise into, no wind)
    const sootK = Math.max(0.35, 1 - mf.loft * 0.55), wetK = 1 - 0.35 * rain;
    const sc0 = [0.06 + mf.dust[0] * 0.18 * (1 - sootK), 0.055 + mf.dust[1] * 0.18 * (1 - sootK), 0.05 + mf.dust[2] * 0.18 * (1 - sootK)];
    const sc1 = [0.32 + (mf.dust[0] - 0.32) * 0.35 * mf.loft, 0.31 + (mf.dust[1] - 0.31) * 0.35 * mf.loft, 0.3 + (mf.dust[2] - 0.3) * 0.35 * mf.loft];
    const nSmoke = Math.round(14 * (0.8 + 0.2 * wetK));
    for (let i = 0; i < nSmoke; i++) {
      const d = sphereDir(), sp = rnd(0.5, 2.5) * W3;
      spawn(K_SMOKE, e.x + d[0] * Rf * 0.4, e.y + 0.2 + Math.abs(d[1]) * Rf * 0.3, e.z + d[2] * Rf * 0.4, { vx: d[0] * sp, vy: rnd(1.5, 3.5) * W3 * wetK, vz: d[2] * sp, drag: 1.2 + rain * 0.6, buoy: 0.8 * wetK,
        life: rnd(2.5, 4.5) * (1 - 0.25 * rain) * cave, s0: Rf * 0.5, s1: Rf * rnd(2.2, 3.4), c0: sc0, c1: sc1, a0: 0.8 });
    }
    // a blast that reached the ground throws it: dust of the crater's own colours (blend of the removed materials), a
    // ground-hugging shock ring, a fountain of fines and solid chunks (clods / rock / ice shards), all by material
    const hit = mf.best > 0, amt = hit ? Math.min(2.2, 0.35 + mf.best / 160) * (1 - 0.6 * rain) : 0;
    if (hit) {
      const col = mf.dust, nd = Math.round(Math.min(22, 4 + mf.best / 30) * mf.amt * (1 - 0.5 * rain));
      for (let i = 0; i < nd; i++) {
        const a = rnd(0, 6.283), sp = rnd(1.5, 5) * W3;
        spawn(K_DUST, e.x + Math.cos(a) * 0.4, e.y + 0.1, e.z + Math.sin(a) * 0.4, { vx: Math.cos(a) * sp, vy: rnd(2, 6) * W3 * mf.lift, vz: Math.sin(a) * sp, drag: 2.2, grav: 2.5,
          life: rnd(1.5, 2.8) * cave, s0: 0.5 * W3, s1: rnd(1.5, 2.6) * W3 * mf.puff, c0: col, c1: col.map(v => v * 1.1 + 0.05), a0: 0.62 + 0.2 * mf.amt });
      }
      const nr = Math.round(Math.min(18, 6 + 8 * W3) * Math.min(1.4, mf.amt) * (1 - 0.4 * rain)), Rr = Math.min(3.2, 0.9 + 0.55 * e.R);      // shock ring: dust rolling out along the ground
      for (let i = 0; i < nr; i++) {
        const a = i / nr * 6.283 + rnd(-0.2, 0.2), v = rnd(5, 9) * Math.sqrt(W3) * mf.puff;
        spawn(K_DUST, e.x + Math.cos(a) * Rr * 0.3, e.y + 0.15, e.z + Math.sin(a) * Rr * 0.3, { vx: Math.cos(a) * v, vy: rnd(0.2, 0.9), vz: Math.sin(a) * v, drag: 2.8,
          life: rnd(0.9, 1.6), s0: 0.35 * W3, s1: rnd(1.1, 1.8) * W3 * mf.puff, c0: col.map(v2 => v2 * 1.05), c1: col.map(v2 => v2 * 1.12 + 0.06), a0: 0.5 * Math.min(1.2, mf.amt) });
      }
      const ncz = FX.env.noChunks ? 0 : Math.round(Math.min(26, (4 + mf.best / 22) * mf.chunks * (0.7 + 0.5 * W3)));
      for (let i = 0; i < ncz; i++) {
        const a = rnd(0, 6.283), sp = rnd(3.5, 11) * Math.sqrt(W3) * (0.7 + 0.3 * hard), up = rnd(0.55, 1.25), sh = rnd(0.5, 1.05), c = mf.chunk.map(v2 => Math.min(1, v2 * sh));
        spawn(K_CHUNK, e.x + Math.cos(a) * 0.3, e.y + 0.1, e.z + Math.sin(a) * 0.3, { vx: Math.cos(a) * sp * (1.1 - 0.5 * up), vy: sp * up + 2, vz: Math.sin(a) * sp * (1.1 - 0.5 * up), grav: 17, drag: 0.1,
          life: rnd(1.4, 2.4), s0: rnd(0.09, 0.2) * (0.7 + 0.6 * W3), s1: rnd(0.09, 0.2) * (0.7 + 0.6 * W3), c0: c, a0: 1 });
      }
      if (mf.cold > 0.3) for (let i = 0; i < 6 + 6 * W3; i++) { const d = sphereDir(); spawn(K_STEAM, e.x, e.y + 0.2, e.z, { vx: d[0] * 2, vy: Math.abs(d[1]) * 3 + 1, vz: d[2] * 2, drag: 1.6, life: rnd(0.8, 1.6), s0: 0.2 * W3, s1: rnd(0.8, 1.4) * W3, a0: 0.45 * mf.cold, c0: [0.96, 0.98, 1] }); }   // powder / frost mist
    }
    // burning bits (the casing's hot fragments are drawn by render/shrapnel.js): a few slow sparks; hard ground (rock, concrete, steel) strikes more
    const nsp = Math.round(10 * (0.6 + 0.9 * hard * hard));
    for (let i = 0; i < nsp; i++) { const d = sphereDir(), sp = rnd(4, 10) * (0.8 + 0.5 * hard); spawn(K_SPARK, e.x, e.y + 0.1, e.z, { vx: d[0] * sp, vy: Math.abs(d[1]) * sp + 2, vz: d[2] * sp, life: rnd(0.4, 0.9), s0: 0.12, s1: 0.06, c0: [2200, 1100, 0], grav: 9.8, drag: 0.6 }); }
    // light: warm for fire, whiter on steel / concrete (sparks), cool over ice / snow; a weak daylight flash is hidden by the sun, at dusk / night it lights the land
    const lt = env.tod === 'night' ? 1.5 : env.tod === 'dusk' ? 1.2 : 1;
    flash.color.setRGB(1 + 0 * mf.cold, 0.66 + 0.2 * hard * hard + 0.12 * mf.cold, 0.32 + 0.4 * hard * hard + 0.4 * mf.cold);
    own.uGlow.value.set(e.x, e.y + 0.6, e.z, 0); glowI = (env.tod === 'night' ? 0.75 : env.tod === 'dusk' ? 0.4 : 0.1 + 0.3 * env.rain) * Math.min(2, 0.6 + W3); glowT = 0; own.uGlowC.value.setRGB(1, 0.42 + 0.3 * mf.hard * mf.hard, 0.12 + 0.35 * mf.cold);
    flash.position.set(e.x, e.y + 0.5, e.z); flash.intensity = 55 * Rf * lt; flash.distance = 16 + 8 * (lt - 1) + 2 * W3; flashT = 0;
    if (SS.lens && SS.lens.shock && SS.view.msaa && SS.view.msaa() >= 4 && !env.under && W3 > 0.75 && camDist < 60) SS.lens.shock(e.x, e.y + 0.3, e.z, 3.5 + 3 * W3, 0.8 + 0.5 * (1 - rain));   // the refraction front of the blast wave
    // camera shake: the charge (W^1/3) over the distance to the camera's focus (camDist = metres), none when far away
    const d = Math.max(0, camDist), amp = 0.62 * W3 / (1 + (d / (5 * W3 + 2)) * (d / (5 * W3 + 2)));
    shake = Math.min(1.2, shake + (amp < 0.02 ? 0 : amp));
    if (SS.view && SS.view.scorch && hit && !env.under) SS.view.scorch(e.x, e.z, 0.6 + 0.55 * e.R, Math.min(1, 0.55 + 0.25 * W3) * mf.scorch * (1 - 0.7 * rain));
  };
  FX.dust = function (x, y, z, cnt, size, col) {
    const c = hex(col == null ? 0xb8a080 : col);
    for (let i = 0; i < cnt; i++) {
      const a = rnd(0, 6.283), sp = rnd(0.6, 1.8);
      spawn(K_DUST, x, y + 0.05, z, { vx: Math.cos(a) * sp, vy: rnd(0.2, 0.9), vz: Math.sin(a) * sp, life: rnd(0.8, 1.5), s0: size * 0.4, s1: size * rnd(1, 1.6), a0: 0.5, c0: c, c1: c.map(v => v * 1.08 + 0.04), drag: 2.5 });
    }
  };
  /* solid chips thrown out of a smashed thing (wood splinters, bricks, ice shards): n chunks of colour col (rgb 0..1), speed sp m/s; they fall and bounce on the ground */
  FX.chips = function (x, y, z, col, n, sp, size) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, 6.283), v = rnd(0.4, 1) * sp, sh = rnd(0.6, 1.1);
      spawn(K_CHUNK, x + rnd(-0.2, 0.2), y + rnd(0, 0.3), z + rnd(-0.1, 0.1), { vx: Math.cos(a) * v, vy: rnd(0.5, 1) * sp * 0.9 + 1.5, vz: Math.sin(a) * v * 0.5, grav: 17, drag: 0.1, life: rnd(1.2, 2.2),
        s0: (size || 0.1) * rnd(0.6, 1.3), s1: (size || 0.1) * rnd(0.6, 1.3), c0: col.map(c => Math.min(1, c * sh)), a0: 1 });
    }
  };
  /* dust of the ground under (x, y, z): colour and amount follow the material (sand lifts a lot, rock little, snow a white powder, steel none), rain
   * keeps it down; used by landings, jumps, bounces, rubble (view.js) */
  FX.dustAt = function (x, y, z, cnt, size) {
    const W = SS.world; let m = W && W.mat_at ? W.mat_at(x, Math.min(y, W.top_at(x, z) + 0.05) - 0.12, z) : 0;
    const f = MFX[m]; if (!f) { FX.dust(x, y, z, cnt, size); return; }
    const k = f.amt * (1 - 0.7 * FX.env.rain), n = Math.round(cnt * k);
    if (n < 1) return;
    const c = f.dust.map(v => Math.min(1, v * 1.05 + 0.03));
    for (let i = 0; i < n; i++) {
      const a = rnd(0, 6.283), sp = rnd(0.6, 1.8);
      spawn(K_DUST, x, y + 0.05, z, { vx: Math.cos(a) * sp, vy: rnd(0.2, 0.9) * f.lift, vz: Math.sin(a) * sp, life: rnd(0.8, 1.5), s0: size * 0.4, s1: size * rnd(1, 1.6) * f.puff, a0: 0.5, c0: c, c1: c.map(v => v * 1.08 + 0.04), drag: 2.5 });
    }
  };
  /* a body (or round) entering the water, by entry size (0.3 small .. 2.2 a worm falling fast): a crown of fine spray thrown up and out of a ring,
   * scattered droplets, then (size > 0.7, a blunt body at speed) the Worthington jet up the middle after ~0.14 s, and a low breath of mist */
  FX.splash = function (x, y, z, size) {
    const sz = Math.max(0.05, size), nC = Math.round(3 + 20 * sz), r0 = 0.12 + 0.2 * sz;
    for (let i = 0; i < nC; i++) {                                  // the crown: a thin sheet breaking into droplets, flaring out
      const a = i / nC * 6.283 + rnd(-0.2, 0.2), out = rnd(1.2, 2.6) * sz, up = rnd(3.2, 5.2) * Math.sqrt(sz);
      spawn(K_STEAM, x + Math.cos(a) * r0, y + 0.03, z + Math.sin(a) * r0, { vx: Math.cos(a) * out, vy: up, vz: Math.sin(a) * out, life: rnd(0.55, 0.95), s0: 0.06 * sz + 0.03, s1: 0.1 * sz + 0.04, a0: 0.85, c0: [0.95, 0.98, 1], grav: 9.8, drag: 0.25 });
    }
    for (let i = 0; i < 14 * sz; i++) {                             // droplets flung higher and wider
      const a = rnd(0, 6.283), sp = rnd(0.4, 3) * sz;
      spawn(K_STEAM, x, y + 0.03, z, { vx: Math.cos(a) * sp, vy: rnd(3.5, 7) * Math.sqrt(sz), vz: Math.sin(a) * sp, life: rnd(0.6, 1.1), s0: 0.04 * sz + 0.02, s1: 0.07 * sz + 0.03, a0: 0.8, c0: [0.92, 0.96, 1], grav: 9.8, drag: 0.3 });
    }
    if (sz > 0.7) later.push({ t: 0.12, fn: () => {                  // the rebound jet: a narrow dense column that falls back in drops
      const nJ = Math.round(12 * sz), v0 = rnd(5.5, 7.5) * Math.sqrt(sz);
      for (let i = 0; i < nJ; i++) { const a = rnd(0, 6.283), rr = rnd(0, 0.12) * sz, f = rnd(0.45, 1);
        spray(x + Math.cos(a) * rr, y + 0.05, z + Math.sin(a) * rr, Math.cos(a) * rnd(0, 0.5), v0 * f, Math.sin(a) * rnd(0, 0.5), rnd(0.08, 0.16) * sz, 2 * v0 * f / 9.8 + 0.1); }
    } });
    for (let i = 0; i < 3 + 2 * sz; i++) spawn(K_STEAM, x + rnd(-0.4, 0.4) * sz, y + 0.15, z + rnd(-0.4, 0.4) * sz, { vx: rnd(-0.6, 0.6), vy: rnd(0.3, 0.9), vz: rnd(-0.6, 0.6), life: rnd(0.7, 1.2), s0: 0.3 * sz, s1: 0.9 * sz, a0: 0.28, c0: [0.95, 0.97, 1], drag: 2 });
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
  FX.addShake = v => { shake = Math.min(1.2, shake + v); };           // P38 A5: small kicks (a bat hit, a bazooka shot)
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
      if (P.kind[i] === K_CHUNK && P.vy[i] < 0 && SS.world) {            // a chunk lands: bounces twice, then lies still and fades
        const gy = SS.world.top_at(P.x[i], P.z[i]) + P.s0[i] * 0.5;
        if (P.y[i] < gy) {
          P.y[i] = gy; const sp = Math.abs(P.vy[i]);
          if (sp < 2.2 || P.age[i] > 1.6) { P.vx[i] = P.vy[i] = P.vz[i] = 0; P.grav[i] = 0; P.spin[i] = 0; if (P.life[i] - P.age[i] > 0.9) P.life[i] = P.age[i] + 0.9; }
          else { P.vy[i] = sp * 0.38; P.vx[i] *= 0.55; P.vz[i] *= 0.55; }
        }
      }
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
      s.iAl.array[q] = P.a0[k] * (hot ? (1 - f) : P.kind[k] === K_CHUNK ? Math.min(1, f * 20) * Math.min(1, (1 - f) * 6) : Math.min(1, f * 6) * (1 - f) * (1 - f));
    }
    for (const [s, c] of [[add, nAdd], [alp, nAlp]]) {
      s.g.instanceCount = c; s.mesh.visible = c > 0;
      if (c) { s.iPos.needsUpdate = true; s.iA.needsUpdate = true; s.iC.needsUpdate = true; s.iAl.needsUpdate = true; }
    }
    flashT += dt; flash.intensity = flashT < 0.4 ? flash.intensity * Math.exp(-dt * 9) : 0;
    glowT += dt; own.uGlow.value.w = glowI * Math.exp(-glowT * 3.2) * (glowT < 2 ? 1 : 0);
    shake = Math.max(0, shake - dt * 2.2);
  };
  FX.stats = () => ({ n, add: nAdd, alpha: nAlp });
})(window.SS = window.SS || {});
