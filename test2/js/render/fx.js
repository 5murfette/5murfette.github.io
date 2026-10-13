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
  let CAP = MAX, QN = 1;                                   // CAP: the particle budget of the quality (Q.particles), QN: its share (counts of the optional layers)
  const P = { x: new Float32Array(MAX), y: new Float32Array(MAX), z: new Float32Array(MAX), vx: new Float32Array(MAX), vy: new Float32Array(MAX), vz: new Float32Array(MAX),
    age: new Float32Array(MAX), life: new Float32Array(MAX), s0: new Float32Array(MAX), s1: new Float32Array(MAX), rot: new Float32Array(MAX), spin: new Float32Array(MAX),
    kind: new Uint8Array(MAX), seed: new Float32Array(MAX), c0: new Float32Array(MAX * 3), c1: new Float32Array(MAX * 3), a0: new Float32Array(MAX), drag: new Float32Array(MAX),
    grav: new Float32Array(MAX), buoy: new Float32Array(MAX), fld: new Float32Array(MAX), hug: new Float32Array(MAX), y0: new Float32Array(MAX), ang: new Float32Array(MAX), trf: new Float32Array(MAX), trl: new Float32Array(MAX) };   // trf / trl: a chunk that drags a thin dust trail (interval s, timer); hug: > 0 = a ground-hugging dust that follows the terrain at that height; y0: where it was born (wind shear grows with height); ang: how angular a chunk is (0 clod .. 1 broken rock)
  const KEYS = Object.keys(P);
  let n = 0, scene = null, flash = null, flashK = 9, flashT = 9, glowT = 9, glowI = 0, shake = 0, add = null, alp = null;
  const K_FIRE = 0, K_SPARK = 1, K_SMOKE = 2, K_DUST = 3, K_STEAM = 4, K_LAVA = 5, K_CHUNK = 6, K_FLASH = 7, K_RING = 8, K_RINGG = 9, K_SHELL = 10, K_DROP = 11, K_DOME = 12, K_GGLOW = 13, K_CONF = 14, K_GLINT = 15;   // K_CONF (P118d): a confetti flake (alpha, tumbles); K_GLINT: a coloured firework streak (additive, colour from c0 -> c1)   // K_FLASH: the blast's white flash (additive, 4 rays); K_RING: a camera-facing shock ring; K_RINGG: a ring lying on the ground (a dust / foam shock front)
  // K_CHUNK: a solid rock / clod / ice shard (alpha pass, bounces on the ground)
  const ADDITIVE = k => k === K_FIRE || k === K_SPARK || k === K_LAVA || (k >= K_FLASH && k !== K_DROP && k !== K_CONF);   // K_DROP (P87): a water droplet streak, alpha-blended
  const own = { tHeight: { value: null }, uSoft: { value: 0 }, uCliff: { value: 1 }, uSeaY: { value: -99 }, uSun: { value: new T.Vector3(-0.4, 0.7, 0.6) }, uSunC: { value: new T.Color(1, 0.95, 0.85) }, uGlow: { value: new T.Vector4(0, 0, 0, 0) }, uGlowC: { value: new T.Color(1, 0.45, 0.12) }, uSky: { value: new T.Color(0.55, 0.6, 0.7) }, uGnd: { value: new T.Color(0.3, 0.27, 0.24) }, uTime: { value: 0 } };

  const VS = /* glsl */`
    attribute vec4 iPos;      // xyz, size
    attribute vec4 iA;        // rot, phase (age / life), kind, seed
    attribute vec3 iC; attribute float iAl;
    attribute vec3 iV;        // velocity (sparks draw a short motion streak along it)
    varying vec2 vUv; varying vec4 vA; varying vec3 vC; varying float vAl; varying vec3 vP; varying vec4 vW;
    void main(){
      vUv = position.xy * 2.0; vA = iA; vC = iC; vAl = iAl; vP = iPos.xyz; vW = vec4(iPos.xyz, iPos.w);
      vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      if ((iA.z > 0.5 && iA.z < 1.5) || iA.z > 14.5) {                                 // P71 spark (and the P118d firework glint): a streak from the tail (where it was ~50 ms ago) to the head, bright at the head
        vec3 hv = (viewMatrix * vec4(iPos.xyz, 1.0)).xyz, vv = (viewMatrix * vec4(iV, 0.0)).xyz;
        float sp = length(iV), lt = max(min(sp * 0.05, 0.9), iPos.w * 0.5);
        vec3 tl = hv - vv * (lt / max(sp, 1e-3)), sg = hv - tl; float sl = length(sg);
        vec3 ext = sl > 1e-5 ? sg / sl * iPos.w * 0.5 : vec3(0.0);
        vec3 pr = length(sg.xy) > 1e-5 ? vec3(-sg.y, sg.x, 0.0) / length(sg.xy) : vec3(1.0, 0.0, 0.0);
        vec3 vp = tl + (sg + ext) * (position.x + 0.5) + pr * position.y * iPos.w * 1.3;
        gl_Position = projectionMatrix * vec4(vp, 1.0); return;
      }
      if (iA.z > 10.5 && iA.z < 11.5) {                                                // P87 water droplet: a motion-blurred streak (exposure ~ 40 ms) along its velocity, head forward
        vec3 hv = (viewMatrix * vec4(iPos.xyz, 1.0)).xyz, vv = (viewMatrix * vec4(iV, 0.0)).xyz;
        float sp = length(iV), lt = clamp(sp * 0.04, iPos.w * 0.9, 1.4);
        vec3 tl = hv - vv * (lt / max(sp, 1e-3)), sg = hv - tl; float sl = length(sg);
        vec3 pr = length(sg.xy) > 1e-5 ? vec3(-sg.y, sg.x, 0.0) / length(sg.xy) : vec3(1.0, 0.0, 0.0);
        vec3 vp = tl + sg * (position.x + 0.5) + pr * position.y * max(iPos.w * 0.42, 0.012);
        gl_Position = projectionMatrix * vec4(vp, 1.0); return;
      }
      float c = cos(iA.x), s = sin(iA.x); vec2 q = mat2(c, s, -s, c) * position.xy;
      if (iA.z > 8.5 && iA.z < 9.5) { R = vec3(1.0, 0.0, 0.0); U = vec3(0.0, 0.0, 1.0); }          // a ground ring lies in the horizontal plane
      vW = vec4(iPos.xyz + (R * q.x + U * q.y) * iPos.w, iPos.w);
      gl_Position = projectionMatrix * viewMatrix * vec4(iPos.xyz + (R * q.x + U * q.y) * iPos.w, 1.0);
    }`;
  const FS = /* glsl */`
    uniform mat4 projectionMatrix; uniform vec3 uSun, uSunC, uSky, uGnd, uGlowC; uniform vec4 uGlow; uniform float uTime, uSoft, uSeaY, uCliff; uniform sampler2D tHeight;
    varying vec2 vUv; varying vec4 vA; varying vec3 vC; varying float vAl; varying vec3 vP; varying vec4 vW;
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
    float ptop(vec2 xz){ return uSoft > 0.5 ? texture2D(tHeight, (xz * 2.0 + 0.5) / float(textureSize(tHeight, 0).x)).r * 40.0 : -1000.0; }
    void main(){
      gl_FragDepth = gl_FragCoord.z;
      float r = length(vUv); if (r > 1.0) discard;
      float ph = vA.y, kind = vA.z, sd = vA.w;
      vec3 q = vec3(vUv * 1.6, sd * 17.0 + ph * 1.3);
      float nz = fbm(q + vec3(0.0, -ph * 1.5, 0.0));
      if (kind > 14.5) {                                   // P118d firework glint (15): a coloured streak with a bright head and a fading tail
        float ax = clamp(vUv.x * 0.5 + 0.5, 0.0, 1.0);
        float a = exp(-vUv.y * vUv.y * 4.5) * (0.1 + 0.9 * ax * ax) * (1.0 - smoothstep(0.9, 1.0, ax));
        a = max(a, exp(-pow((1.0 - ax) * 7.0, 2.0)) * exp(-vUv.y * vUv.y * 3.0));
        gl_FragColor = vec4(vC * a * vAl, 1.0);
      } else if (kind > 13.5) {                            // P118d confetti (14): a thin flake that tumbles: it turns edge-on twice per flip and catches the sun when it is square to the eye
        float fl = ph * (16.0 + 12.0 * fract(sd * 3.7)) + sd * 6.2831, cf = cos(fl), f = abs(cf);
        vec2 qf = vec2(vUv.x * 1.55 / max(f, 0.12), vUv.y);                          // a flake is about 1 : 1.8
        float m = (1.0 - smoothstep(0.78, 0.92, abs(qf.x))) * (1.0 - smoothstep(0.84, 1.0, abs(qf.y)));
        if (m < 0.02) discard;
        float lit = 0.6 + 0.4 * f + 0.3 * pow(f, 8.0) * step(0.0, cf);
        vec3 ambf = mix(uGnd, uSky, 0.55);
        gl_FragColor = vec4(vC * (ambf * 0.6 + uSunC * 0.6 * lit + 0.16 + 0.1 * lit) * 1.3, m * vAl);                 // (+ a floor: at night the flakes still read, as party confetti does under the lamps)
      } else if (kind > 11.5) {                            // P108 flash dome (12): an incandescent ball, a hemisphere where it meets the ground; ground glow (13): the light the flash throws on the terrain around it
        vec3 ro = cameraPosition, rd = normalize(vW.xyz - ro), cc = vP; float Rs = vW.w * 0.5;
        vec3 oc = ro - cc; float bb2 = dot(oc, rd), d2 = bb2 * bb2 - (dot(oc, oc) - Rs * Rs);
        if (d2 <= 0.0) discard;
        float sq = sqrt(d2), t0 = max(-bb2 - sq, 0.0), t1 = -bb2 + sq, tz = t0, I = 0.0;
        if (t1 <= t0) discard;
        if (kind < 12.5) {
          float mf = -1.0, gh = 0.0, cov = 0.0;                                                          // P108: a crisp lumpy shell (threshold of the noise), hottest where it touches the ground
          float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;      // P118d (Q-08): the 10 samples are jittered per pixel: no stair-step contours (the polygonal edge of the ember lump)
          for (int k = 0; k < 10; k++) {
            float tt = mix(t0, t1, (float(k) + 0.5 + 0.8 * jit) / 10.0); vec3 p = ro + rd * tt; vec3 dp = p - cc; float tu = fbm(p * (3.2 / Rs) + vec3(sd * 17.0, ph * 1.5, 0.0));
            float hh = p.y - ptop(p.xz);
            float rr = length(vec3(dp.x, max(dp.y, 0.0) * 1.5 + min(dp.y, 0.0), dp.z)) / Rs;           // flattened: it spreads over the ground
            float f = (1.0 - rr) + 0.55 * (tu - 0.5) * (1.0 - 0.4 * rr);
            f *= smoothstep(-0.04, 0.05, hh);                                                          // the terrain clips it
            if (f > mf) { mf = f; gh = exp(-max(hh, 0.0) / (0.22 * Rs)); }
          }
          cov = smoothstep(0.0, 0.07 + 0.42 * smoothstep(0.15, 0.85, ph), mf); if (cov < 0.02) discard;      // P118d: the edge softens as the ball cools
          float Tt = clamp(mf * 1.5 + 0.45 * gh * smoothstep(0.0, 0.3, mf), 0.0, 1.0) * (1.0 - 0.8 * smoothstep(0.3, 1.0, ph));
          vec3 cE = vec3(0.12, 0.035, 0.015), cR = vec3(0.75, 0.2, 0.04), cO = vec3(1.0, 0.55, 0.12), cY = vec3(1.0, 0.93, 0.65);
          vec3 col = Tt < 0.3 ? mix(cE, cR, Tt / 0.3) : Tt < 0.62 ? mix(cR, cO, (Tt - 0.3) / 0.32) : mix(cO, cY, min(1.0, (Tt - 0.62) / 0.3));
          col = pow(col, vec3(1.7)) * 1.35 * cov * (1.0 - smoothstep(0.4, 0.85, ph)) / max(1.0 - ph, 0.05);       // (the pipeline multiplies by 1 - ph: cancelled; colours stay saturated, no HDR blow-out); P118d: the ember phase is gone by 85 % of the life: it never lingers as a dark red lump
          vec4 cp = projectionMatrix * viewMatrix * vec4(ro + rd * mix(t0, t1, 0.25), 1.0); gl_FragDepth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
          gl_FragColor = vec4(col * vAl, 1.0);
        } else {
          float hit = -1.0;
          for (int k = 0; k < 20; k++) { float tt = mix(t0, t1, float(k) / 19.0); vec3 p = ro + rd * tt; if (p.y < ptop(p.xz)) { hit = tt; break; } }
          if (hit < 0.0) discard;
          vec3 p = ro + rd * hit; float rr = length(p - cc) / Rs;
          float tu = fbm(p * (1.6 / Rs) + vec3(sd * 17.0, 0.0, ph));
          float g = pow(max(1.0 - rr, 0.0), 2.2) * (0.5 + 0.9 * tu) * (0.8 + 1.6 * exp(-rr * rr * 14.0));
          vec4 cp = projectionMatrix * viewMatrix * vec4(p, 1.0); gl_FragDepth = clamp(cp.z / cp.w * 0.5 + 0.5, 0.0, 1.0);
          gl_FragColor = vec4(vC * g * vAl, 1.0);
        }
      } else if (kind > 10.5) {                            // P87 water droplet: a lens-shaped streak, glassy white-blue, a bright rim light on the head
        float ax = clamp(vUv.x * 0.5 + 0.5, 0.0, 1.0), body = exp(-vUv.y * vUv.y * 3.0) * (0.3 + 0.7 * smoothstep(0.0, 0.9, ax));
        vec3 sunV = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
        vec3 amb = mix(uGnd, uSky, 0.6);
        vec3 lit = vC * (0.5 * amb + 0.45 * uSunC);
        vec3 c = mix(vec3(0.88, 0.94, 1.0) * (0.35 + 0.65 * dot(lit, vec3(0.34))), lit, 0.3) + vec3(1.0) * 0.35 * pow(ax, 4.0) * (0.4 + 0.6 * max(0.0, sunV.y));   // clear water: sky-tinted, a glint on the leading edge
        gl_FragColor = vec4(c, body * vAl * 0.6);
      } else if (kind > 6.5) {                                    // flash (7): a hard white core with four short rays; shock ring (8, 9): a thin bright front, torn by noise
        float a;
        if (kind > 9.5) { float fi = smoothstep(0.0, 0.2, ph); float an2 = atan(vUv.y, vUv.x), r2 = r * (1.0 - 0.05 * sin(an2 * 5.0 + sd * 9.0) - 0.03 * sin(an2 * 9.0 + sd * 3.0)); a = (0.16 * smoothstep(0.25, 0.92, r2) + 0.45 * exp(-pow((r2 - 0.9) / 0.06, 2.0))) * (0.4 + 0.9 * nz * nz) * fi * (1.0 - smoothstep(0.96, 1.0, r)); }     // P73: the condensation shell: a faint milky sphere with a thin brighter rim
        else if (kind < 7.5) { float ang = atan(vUv.y, vUv.x); a = exp(-r * r * 9.0) + 0.55 * pow(abs(cos(ang * 2.0 + sd)), 24.0) * exp(-r * 3.2) + 0.9 * exp(-r * r * 40.0); }
        else { float w = 0.03 + 0.07 * ph; float rr = 0.9 - 0.04 * ph; float an = atan(vUv.y, vUv.x), wob = 0.06 * sin(an * 3.0 + sd * 9.0) + 0.04 * sin(an * 7.0 + sd * 21.0) + 0.025 * sin(an * 13.0 + sd * 5.0), pat = smoothstep(-0.5, 0.6, sin(an * 5.0 + sd * 13.0) * 0.55 + sin(an * 11.0 + sd * 7.0) * 0.45) * 0.75 + 0.25;   // P87: broken, wobbling front, never a clean hoop
        a = exp(-pow((r * (1.0 - wob) - rr) / w, 2.0)) * (0.3 + 1.0 * nz * nz) * pat; if (kind > 8.5) a += 0.22 * (1.0 - smoothstep(0.1, rr, r)) * nz * (1.0 - ph) * pat; }
        gl_FragColor = vec4(vC * a * vAl, 1.0);
      } else if (kind < 0.5) {                             // fire: turbulent puff, hot core
        float edge = 1.0 - smoothstep(0.35 + 0.45 * nz, 0.95, r);
        if (edge < 0.01) discard;
        float Tk = mix(vC.x, vC.y, ph) * (0.78 + 0.32 * (1.0 - r) + 0.18 * (nz - 0.5));
        float L = pow(Tk / 2200.0, 4.0) * 1.6;
        gl_FragColor = vec4(bb(Tk) * L * edge * vAl, 1.0);
      } else if (kind > 5.5) {                               // debris chunk: a hard-edged lumpy solid (clod) or a faceted broken rock (angular), lit from the sun
        float angK = clamp((kind - 6.0) / 0.4, 0.0, 1.0);
        float ang = atan(vUv.y, vUv.x); float lump = 0.5 + 0.28 * nz + 0.14 * sin(ang * 3.0 + sd * 40.0) + 0.08 * sin(ang * 5.0 + sd * 17.0);
        float nS = 4.0 + floor(fract(sd * 7.3) * 3.0), sec = 6.2832 / nS, th = ang + sd * 6.28 + 20.0 * 6.2832, fi = floor(th / sec), ph2 = th - fi * sec - sec * 0.5;
        float poly = 0.6 * cos(sec * 0.5) / cos(ph2) * (0.85 + 0.3 * fract(sin((fi + sd) * 12.9898) * 43758.5453));
        lump = mix(lump, poly, angK);
        float a = 1.0 - smoothstep(lump, lump + 0.12 - 0.08 * angK, r); if (a < 0.02) discard;
        vec3 nrm = normalize(vec3(vUv * 0.9, sqrt(max(0.0, 1.0 - r * r)) + 0.15));
        float fsh = 0.72 + 0.5 * fract(sin((fi + sd) * 78.233) * 43758.5453);
        nrm = normalize(mix(nrm, normalize(vec3(cos(th - ph2) * 0.8, sin(th - ph2) * 0.8, 0.6)), angK * 0.7));
        vec3 sunV = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
        float lam = clamp(dot(nrm, sunV) * 0.6 + 0.5, 0.0, 1.0);
        vec3 amb = mix(uGnd, uSky, 0.5 + 0.5 * vUv.y);
        gl_FragColor = vec4(vC * (0.6 * amb + uSunC * lam * 0.8) * 1.15 * mix(0.7 + 0.6 * nz, fsh, angK), a * vAl);
      } else if (kind < 1.5 || kind > 4.5) {               // spark / glowing lava blob: small, round, hot
        float a = exp(-r * r * 5.0);
        if (kind < 1.5) { float ax = clamp(vUv.x * 0.5 + 0.5, 0.0, 1.0); a = exp(-vUv.y * vUv.y * 4.5) * (0.1 + 0.9 * ax * ax) * (1.0 - smoothstep(0.9, 1.0, ax)); a = max(a, exp(-pow((1.0 - ax) * 7.0, 2.0)) * exp(-vUv.y * vUv.y * 3.0)); }
        float Tk = mix(vC.x, vC.y, ph) * (kind < 1.5 ? 0.8 + 0.2 * clamp(vUv.x * 0.5 + 0.5, 0.0, 1.0) : 1.0);
        gl_FragColor = vec4(bb(Tk) * pow(Tk / 2000.0, 4.0) * 2.0 * a * vAl, 1.0);
      } else {                                             // smoke / dust / steam: lit puff
        float nz2 = fbm(q * 1.9 + vec3(3.3, 1.1, 0.0));
        float dt3 = fbm(vec3(vUv * 4.6 + sd * 7.0, ph * 0.9 + sd));                // P87: a second, finer octave erodes the silhouette: ragged wisps, never a flat round disc
        float dens = (1.0 - smoothstep(0.1 + 0.5 * nz, 0.9, r + 0.22 * (dt3 - 0.5))) * (0.3 + 1.0 * nz2) * (0.9 + 0.4 * nz) * (0.35 + 1.1 * dt3);
        if (uSoft > 0.5) {                                                        // P87: soft particles: fade toward the terrain top / the sea under the fragment (no hard intersection line)
          float tp = texture2D(tHeight, (vW.xz * 2.0 + 0.5) / float(textureSize(tHeight, 0).x)).r * 40.0;
          float fw = clamp(0.25 + 0.55 * vW.w, 0.25, 1.1);
          dens *= smoothstep(0.0, fw, vW.y - tp) * smoothstep(0.0, fw * 0.6, vW.y - uSeaY);
          if (uCliff > 0.5) {                                                      // P90: cliffs. The quad plane meets a vertical face along a line the height fade cannot see: march 4 taps along the view ray behind the fragment through the same height map; a tap inside the rock fades the puff by how close it is
            vec3 rd = normalize(vW.xyz - cameraPosition); float cf = 1.0;
            for (int k = 1; k <= 4; k++){ float sk = fw * 0.3 * float(k); vec3 pk = vW.xyz + rd * sk;
              float tk = texture2D(tHeight, (pk.xz * 2.0 + 0.5) / float(textureSize(tHeight, 0).x)).r * 40.0;
              cf *= 1.0 - 0.8 * smoothstep(0.0, 0.25, tk - pk.y) * (1.0 - 0.18 * float(k)); }
            dens *= cf;
          }
        }
        if (dens < 0.01) discard;
        vec3 nrm = normalize(vec3(vUv, sqrt(max(0.0, 1.0 - r * r)) + 0.3));
        vec3 sunV = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
        float lam = 0.55 + 0.45 * dot(nrm, sunV);
        vec3 amb = mix(kind > 3.5 ? (0.2 * uGnd + 0.8 * uSky) : uGnd, uSky, 0.5 + 0.5 * vUv.y);   // (spray / steam are lit by the sky: not the brown ground tint)
        float sc = kind > 3.5 ? 0.9 : kind > 2.5 ? 0.85 : 0.25;                 // steam scatters, soot absorbs
        vec3 c = vC * (amb * 0.6 + uSunC * lam * sc + uSunC * 0.15);
        float gd = length(vP - uGlow.xyz);                                      // the fireball's afterglow lights the smoke / dust around it (night, dusk, storm)
        c += uGlowC * uGlow.w * (0.6 + 0.4 * (1.0 - vUv.y * 0.5)) / (1.0 + gd * gd * 0.18) * (0.25 + vC.r * 0.9) * (1.0 - 0.7 * clamp(dot(vC, vec3(0.33)), 0.0, 1.0));
        if (kind > 3.5) { c *= 0.92 + 0.3 * lam; c = mix(c, vec3(dot(c, vec3(0.34))) * vec3(0.97, 1.0, 1.04), 0.8); dens = min(1.0, dens * 1.6); }               // spray and steam: denser, with a shaded side
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
    const iPos = at('iPos', 4), iA = at('iA', 4), iC = at('iC', 3), iAl = at('iAl', 1), iV = at('iV', 3);
    g.instanceCount = 0;
    // DoubleSide: camera-facing quads from the view matrix are front-facing, but keep them safe from any winding flip
    const m = new T.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: T.DoubleSide,
      blending: additive ? T.AdditiveBlending : T.NormalBlending, uniforms: own });
    const mesh = new T.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = additive ? 9 : 8; mesh.visible = false; scene.add(mesh);
    return { g, mesh, iPos, iA, iC, iAl, iV };
  }

  FX.init = function (sc, tx, quality, heightTex) {
    scene = sc; own.tHeight.value = heightTex || null; own.uSoft.value = heightTex ? 1 : 0; QN = Math.max(0.4, quality && quality.particles != null ? quality.particles : 1); CAP = Math.round(MAX * Math.min(1, 0.45 + 0.55 * QN));
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
  FX.clear = function () { n = 0; glowI = 0; own.uGlow.value.w = 0; later.length = 0; blasts.length = 0; shake = 0; flashT = 9; if (flash) flash.intensity = 0; };   // a new map starts calm

  const rnd = (a, b) => a + Math.random() * (b - a);
  function sphereDir() { const u = rnd(-1, 1), a = rnd(0, 6.283), r = Math.sqrt(1 - u * u); return [r * Math.cos(a), u, r * Math.sin(a)]; }
  // o: {vx, vy, vz, life, s0, s1, c0 [3], c1 [3], a0, drag, grav, buoy}; fire / spark / lava colours are [T0, T1, 0] in K
  function spawn(kind, x, y, z, o) {
    let i = n;
    if (n >= CAP) { let best = 0, bf = -1; for (let k = 0; k < CAP; k += 7) { const f = P.age[k] / P.life[k]; if (f > bf) { bf = f; best = k; } } i = best; }
    else n++;
    P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = o.vx || 0; P.vy[i] = o.vy || 0; P.vz[i] = o.vz || 0;
    P.age[i] = 0; P.life[i] = o.life || 1; P.s0[i] = o.s0 || 0.5; P.s1[i] = o.s1 || 1; P.rot[i] = rnd(0, 6.283); P.spin[i] = rnd(-0.6, 0.6);
    P.kind[i] = kind; P.seed[i] = Math.random() * 100; P.a0[i] = o.a0 == null ? 1 : o.a0; P.drag[i] = o.drag || 0; P.grav[i] = o.grav || 0; P.buoy[i] = o.buoy || 0; P.fld[i] = o.fld || 0; P.hug[i] = o.hug || 0; P.y0[i] = y; P.ang[i] = o.ang || 0; P.trf[i] = o.trail || 0; P.trl[i] = o.trail || 0;
    if (o.spin != null) P.spin[i] = o.spin;
    const c0 = o.c0 || [1, 1, 1], c1 = o.c1 || c0;
    P.c0[i * 3] = c0[0]; P.c0[i * 3 + 1] = c0[1]; P.c0[i * 3 + 2] = c0[2]; P.c1[i * 3] = c1[0]; P.c1[i * 3 + 1] = c1[1]; P.c1[i * 3 + 2] = c1[2];
  }
  const hex = h => { const c = new T.Color(h); return [c.r, c.g, c.b]; };
  FX.spawn = spawn; FX.hex = hex; FX.KIND = { CHUNK: K_CHUNK, FLASH: K_FLASH, RING: K_RING, RINGG: K_RINGG, FIRE: K_FIRE, SPARK: K_SPARK, SMOKE: K_SMOKE, DUST: K_DUST, STEAM: K_STEAM, LAVA: K_LAVA, SHELL: K_SHELL };   // P37-W3: custom puffs (acid, gas, minigun)

  /* P73 the blast wave as the eye sees it (high-speed footage, schlieren): not a white hoop but a thin moving band that bends the background (render/lens.js
   * SS.lens.shock, high quality); where that pass is not running (low quality) a plain faint ring stands in. Humid air (temperate, alpine) adds, for a big charge,
   * a faint Wilson shell: the rarefaction behind the front cools the air below its dew point for a moment (never in a dry biome). */
  const HUMID = { temperate: 1, alpine: 0.8 };
  FX.shockWave = function (x, y, z, W3, Rf, he, huge, rain, camDist, tint) {
    const env = FX.env, lensOK = !!(SS.lens && SS.lens.shock && SS.view && SS.view.msaa && SS.view.msaa() >= 4);
    const reach = (3.5 + 3 * W3) * (huge ? 1.7 : 1) * (he ? 1.25 : 1);
    if (lensOK) { if (!env.under && W3 > (he ? 0.4 : 0.75) && camDist < 60) SS.lens.shock(x, y, z, reach, (1.0 + 0.5 * (1 - rain)) * (he ? 1.35 : 1), 0.18 + 0.045 * Math.min(3, W3)); }
    else if (W3 > 0.3) spawn(K_RING, x, y + 0.1, z, { life: 0.16 + 0.04 * W3, s0: Rf * 1.2, s1: reach * 0.9, c0: tint || [0.9, 0.92, 0.95], c1: [0.6, 0.62, 0.68], a0: 0.16 + 0.04 * Math.min(2, W3) });
    const hum = (HUMID[env.biome] || 0) * (0.7 + 0.5 * rain);
    if (hum > 0 && !env.under && !env.vac && W3 > 1.3) spawn(K_SHELL, x, y + 0.4, z, { life: 0.22 + 0.05 * W3, s0: reach * 0.45, s1: reach * 0.95, c0: [0.95, 0.97, 1], c1: [0.9, 0.93, 0.98], a0: Math.min(0.4, 0.17 * W3) * hum });
  };
  FX.env = { tod: 'day', rain: 0, snow: 0, under: false, wx: 0, wz: 0 };            // set by view.js each frame (time of day, precipitation 0..1)
  /* per material: dust colour (rgb 0..1), fines amount, puff size, lift of the fountain, chunk count, chunk colour, 'hardness' (sparks, fast chunks),
   * loft (how much the dirt masks the soot), cold (white powder mist), scorch (how much the ground blackens) */
  const MFX = {};
  function mfx(id, dust, amt, puff, lift, chunks, hard, loft, cold, scorch, chunkc) { MFX[id] = { dust, amt, puff, lift, chunks, hard, loft, cold, scorch, chunk: chunkc || dust, grain: 0 }; }
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
    MFX[M2.SAND].grain = 1.3; MFX[M2.SNOW].grain = 0.6; MFX[M2.ASH].grain = 0.5; MFX[M2.SOIL].grain = 0.35; MFX[M2.FOAM].grain = 0.3;
  })();
  /* the blast's ground: blend of the materials the crater removed (e.byMat), weighted by voxel count */
  function matMix(e) {
    const o = { best: 0, dust: [0.55, 0.5, 0.45], chunk: [0.4, 0.36, 0.32], amt: 1, puff: 1, lift: 1, chunks: 1, hard: 0.5, loft: 0.5, cold: 0, scorch: 0.8 };
    if (!e.byMat) return o;
    let tot = 0; for (let k = 1; k < e.byMat.length; k++) tot += e.byMat[k] || 0;
    if (tot <= 0) return o;
    o.best = tot; o.dust = [0, 0, 0]; o.chunk = [0, 0, 0]; o.amt = o.puff = o.lift = o.chunks = o.hard = o.loft = o.cold = o.scorch = o.grain = 0;
    for (let k = 1; k < e.byMat.length; k++) {
      const c = e.byMat[k]; if (!c) continue;
      const f = MFX[k] || MFX[SS.CFG.MAT.ROCK], w = c / tot;
      for (let q = 0; q < 3; q++) { o.dust[q] += f.dust[q] * w; o.chunk[q] += f.chunk[q] * w; }
      o.amt += f.amt * w; o.puff += f.puff * w; o.lift += f.lift * w; o.chunks += f.chunks * w; o.hard += f.hard * w; o.loft += f.loft * w; o.cold += f.cold * w; o.scorch += f.scorch * w; o.grain += f.grain * w;
    }
    return o;
  }
  /* the blast's surface frame, read from the carved lattice: the free-space direction the crater opens to (outward normal n, tilt from the vertical), probed with
   * 26 rays; flat ground gives up, a slope leans downhill, a wall gives the horizontal (the blast vents sideways). t1, t2 span the plane across n. */
  const DIRS = (function () { const a = []; for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) if (x || y || z) { const l = Math.hypot(x, y, z); a.push([x / l, y / l, z / l]); } return a; })();
  const FR = { nx: 0, ny: 1, nz: 0, t1x: 1, t1y: 0, t1z: 0, t2x: 0, t2y: 0, t2z: 1, tilt: 0, hx: 1, hz: 0 };
  function frame(e, D) {
    const W = SS.world; FR.nx = 0; FR.ny = 1; FR.nz = 0; FR.tilt = 0;
    if (W && W.raycast) {
      D = Math.min(8, D); let sx = 0, sy = 0, sz = 0;
      for (let q = 0; q < DIRS.length; q++) { const d = DIRS[q], r = W.raycast(e.x, e.y, e.z, d[0], d[1], d[2], D), f = r < 0 ? 1 : r / D; sx += d[0] * f; sy += d[1] * f; sz += d[2] * f; }
      const l = Math.hypot(sx, sy, sz);
      if (l > 1.2) { FR.nx = sx / l; FR.ny = sy / l; FR.nz = sz / l; }
    }
    FR.tilt = Math.acos(Math.max(-1, Math.min(1, FR.ny)));
    const rx = Math.abs(FR.ny) < 0.9 ? 0 : 1, ry = rx ? 0 : 1;                       // t1 = n x ref, t2 = n x t1
    let ax = FR.ny * 0 - FR.nz * ry, ay = FR.nz * rx - FR.nx * 0, az = FR.nx * ry - FR.ny * rx; const al = Math.hypot(ax, ay, az) || 1; ax /= al; ay /= al; az /= al;
    FR.t1x = ax; FR.t1y = ay; FR.t1z = az; FR.t2x = FR.ny * az - FR.nz * ay; FR.t2y = FR.nz * ax - FR.nx * az; FR.t2z = FR.nx * ay - FR.ny * ax;
    const hl = Math.hypot(FR.nx, FR.nz); FR.hx = hl > 0.05 ? FR.nx / hl : 1; FR.hz = hl > 0.05 ? FR.nz / hl : 0;
    return FR;
  }
  const dirv = [0, 0, 0];
  /* a unit direction inside the ejecta cone around the frame's normal, polar angle phi0..phi1 from it (denser toward phi0) */
  function cone(phi0, phi1) {
    const ph = phi0 + (phi1 - phi0) * Math.pow(Math.random(), 0.85), a = rnd(0, 6.2832), sp = Math.sin(ph), c = Math.cos(ph), u = Math.cos(a) * sp, w = Math.sin(a) * sp;
    dirv[0] = FR.nx * c + FR.t1x * u + FR.t2x * w; dirv[1] = FR.ny * c + FR.t1y * u + FR.t2y * w; dirv[2] = FR.nz * c + FR.t1z * u + FR.t2z * w;
    return dirv;
  }
  FX.explosion = function (e, camDist) {
    if (FX.env.vac && SS.eowView && SS.eowView.explosion(e)) return;       // P68d: vacuum: flash, sparks, ejecta, no smoke / shock ring (render/eowview.js)
    const W3 = Math.cbrt(e.W || Math.pow((e.R || 3) / 3, 3)), Rf = R_FB * W3 * (W3 > 1.8 ? 1 + 0.2 * Math.min(2, W3 - 1.8) : 1) * (W3 > 2.2 ? 1.3 : 1);   // (a big one reads bigger; P61: the holy grenade bigger still)
    // P30g: a charge under the water makes no fireball or soot (the water quenches it): a dim green-white glow under
    // the surface and a burst of bubbles; the surface show (dome, crown, jet, base surge, foam) is FX.waterBlast
    if (e.wet != null && e.wet > 0.25) {
      for (let i = 0; i < 18; i++) { const d = sphereDir(), sp = rnd(0.5, 2.5) * W3; spawn(K_STEAM, e.x + d[0] * 0.3, e.y + d[1] * 0.3, e.z + d[2] * 0.3, { vx: d[0] * sp, vy: rnd(1.5, 4), vz: d[2] * sp, drag: 3, life: Math.min(1.2, 0.25 + e.wet * 0.4), s0: 0.08, s1: rnd(0.15, 0.4) * W3, a0: 0.7, c0: [0.8, 0.92, 0.95] }); }
      flash.position.set(e.x, e.y + e.wet, e.z); flash.intensity = 14 * Rf * Math.exp(-e.wet / 1.5); flashT = 0; flashK = 9;
      shake = Math.min(1.2, shake + (e.R || 3) * 0.3 * Math.max(0.3, 1 - camDist / 60));
      return;
    }
    const cnt0 = v => Math.max(1, Math.round(v * QN)), wet = e.wet != null;                         // a contact burst on the water: a smaller, short fireball, little soot
    if (wet) { const k = 0.6, heW = !e.boom, rain0 = FX.env.rain;                      // P71: a high explosive over the water is a white flash, a pressure ring and spray, no fire
      if (heW) {
        spawn(K_FLASH, e.x, e.y + 0.3, e.z, { life: 0.04 + 0.012 * W3, s0: Rf * 1.3, s1: Rf * (2.6 + 0.5 * W3), c0: [6.0, 6.0, 5.4], c1: [2.6, 2.7, 2.4], a0: 1 });
        FX.shockWave(e.x, e.y + 0.3, e.z, W3, Rf, true, false, rain0, camDist, [0.9, 0.97, 1.0]);
        spawn(K_RINGG, e.x, e.y + 0.12, e.z, { life: 0.3 + 0.05 * W3, s0: Rf * 0.5, s1: Rf * (6 + 1.5 * W3), c0: [0.95, 0.99, 1.0], c1: [0.5, 0.6, 0.7], a0: 0.7 });      // the shock front racing over the water
        for (let i = 0, nw = cnt0(16 + 10 * W3); i < nw; i++) { const a = rnd(0, 6.283), sp = rnd(1.5, 4.5) * W3, up = rnd(5, 10) * Math.sqrt(W3); spray(e.x + Math.cos(a) * 0.3, e.y + 0.1, e.z + Math.sin(a) * 0.3, Math.cos(a) * sp, up, Math.sin(a) * sp, rnd(0.14, 0.3) * W3, 2 * up / 9.8); }
        for (let i = 0; i < 6; i++) { const a = rnd(0, 6.283), sp = rnd(0.3, 1.2) * W3; spawn(K_SMOKE, e.x, e.y + 0.6, e.z, { vx: Math.cos(a) * sp, vy: rnd(1, 2.5) * W3, vz: Math.sin(a) * sp, drag: 1.2, buoy: 0.3, life: rnd(1.5, 2.5), s0: Rf * 0.5, s1: Rf * 2, c0: [0.55, 0.57, 0.58], c1: [0.7, 0.72, 0.74], a0: 0.4 }); }
        flash.color.setRGB(1, 0.96, 0.88); flash.position.set(e.x, e.y + 0.5, e.z); flash.intensity = 60 * Rf; flashT = 0; flashK = 26;
      } else {
      spawn(K_FIRE, e.x, e.y + 0.15, e.z, { life: 0.1 + 0.05 * W3, s0: Rf * 0.5 * k, s1: Rf * 1.5 * k, c0: [3000, 1500, 0], a0: 1 });
      for (let i = 0; i < 5; i++) { const d = sphereDir(), sp = rnd(3, 7) * W3; spawn(K_FIRE, e.x, e.y + 0.2, e.z, { vx: d[0] * sp, vy: Math.abs(d[1]) * sp + 2, vz: d[2] * sp, drag: 10, life: rnd(0.15, 0.3), s0: Rf * 0.3, s1: Rf * 0.8, c0: [2400, 1000, 0], a0: 0.9 }); }
      for (let i = 0; i < 5; i++) { const sp = rnd(0.3, 1.2) * W3, a = rnd(0, 6.283); spawn(K_SMOKE, e.x, e.y + 0.6, e.z, { vx: Math.cos(a) * sp, vy: rnd(1, 2.5) * W3, vz: Math.sin(a) * sp, drag: 1.2, buoy: 0.6, life: rnd(1.5, 2.5), s0: Rf * 0.4, s1: Rf * 2, c0: [0.12, 0.11, 0.1], c1: [0.45, 0.45, 0.45], a0: 0.3 }); }
      flash.position.set(e.x, e.y + 0.5, e.z); flash.intensity = 40 * Rf; flashT = 0; flashK = 9; }
      shake = Math.min(1.2, shake + (e.R || 3) * 0.25 * Math.max(0.3, 1 - camDist / 60));
      return;
    }
    // fireball: a hot core puff + turbulent lobes (detonation products + afterburn), luminous ~0.1-0.2 W^1/3 s
    const he = !e.boom;                                 // P66a: C.BOOM.HE (0) = a detonation: white flash + shock wave + dust and soot, NO fireball; FUEL (1) keeps the rolling fireball
    const mf = matMix(e), env = FX.env, rain = env.rain, hard = mf.hard, kd = String(e.kind || ''), isBarrel = /barrel/.test(kd), isCar = /car/.test(kd), isMine = /mine/.test(kd), big = W3 > 2.0;
    const wx = env.wx || 0, wz = env.wz || 0, cnt = v => Math.max(1, Math.round(v * QN));
    if (he) { /* no fireball: a detonation's products are dark and the flash lasts a few frames */ }
    else if (SS.flameView) SS.flameView.fireball(e.x, e.y, e.z, Rf, W3, isBarrel || isCar ? 1.25 : 1);              // P45: rolling procedural fireball (render/flame.js)
    else {
      spawn(K_FIRE, e.x, e.y + 0.1, e.z, { life: 0.12 + 0.08 * W3, s0: Rf * 0.6, s1: Rf * 2.1, c0: [3200, 1500, 0], a0: 1 });
      for (let i = 0; i < 9; i++) {
        const d = sphereDir(), sp = rnd(3, 9) * W3;
        spawn(K_FIRE, e.x + d[0] * 0.2, e.y + 0.15 + Math.abs(d[1]) * 0.2, e.z + d[2] * 0.2, { vx: d[0] * sp, vy: Math.abs(d[1]) * sp + 1, vz: d[2] * sp, drag: 9,
          life: rnd(0.25, 0.5) * (0.7 + 0.3 * W3), s0: Rf * 0.4, s1: Rf * rnd(0.9, 1.4), c0: [rnd(2200, 2700), rnd(900, 1100), 0], a0: 0.9, buoy: 2 });
      }
    }
    const hit = mf.best > 0, cave = env.under ? 1.35 : 1, wetK = 1 - 0.35 * rain, Rr = Math.min(7, 0.9 + 0.62 * e.R);
    const fr = frame(e, Rr * 2 + 1.5), ventK = hit ? Math.max(0, Math.min(1, (fr.tilt - 0.5) / 0.7)) : 0, nx = fr.nx, ny = fr.ny, nz = fr.nz;      // P65k: which way the ground opens (up on the flat, downhill on a slope, sideways at a wall)
    // P58 the flash: a hard white core with rays (a few frames), then a wider orange bloom, and the shock front: a thin ring (camera-facing) and, over ground, a ring lying on it
    const hk = he && !env.under ? 0.12 : 1;              // P108: the dome carries the flash now; the old flat sprites are only a hot core and a faint glare
    if (he) {                                           // HE: an extremely short, very bright white-yellow flash (3-4 frames), a pale glare, a fast pressure front
      spawn(K_FLASH, e.x, e.y + 0.3, e.z, { life: 0.04 + 0.012 * W3, s0: Math.min(Rf * 1.5, 2.5), s1: Math.min(Rf * (3.0 + 0.6 * W3), 4), c0: [6.5, 6.0, 4.8], c1: [3.0, 2.5, 1.5], a0: hk });
      spawn(K_FLASH, e.x, e.y + 0.3, e.z, { life: 0.028, s0: Rf * 0.9, s1: Rf * 1.5, c0: [11, 10.5, 9], c1: [5, 4.5, 3.5], a0: hk });                    // P71: a tiny blinding core for the first two frames
      spawn(K_FLASH, e.x, e.y + 0.4, e.z, { life: 0.09 + 0.02 * W3, s0: Rf * 2.0, s1: Rf * 3.6, c0: [1.5, 1.35, 0.95], c1: [0.5, 0.46, 0.34], a0: 0.5 * hk });
      // P108: the detonation's incandescent flash ball (0.12-0.25 s, white-yellow cooling to orange, procedural): it wraps the ground (a hemisphere clipped by the terrain) and a glow on the crater surface
      if (!env.under) {
        spawn(K_DOME, e.x, e.y + 0.1, e.z, { life: 0.15 + 0.03 * Math.min(W3, 2), s0: Math.min(Rf * 2.2, 3.4), s1: Math.min(Rf * (5.6 + 0.9 * W3), 6.6), c0: [1, 1, 1], c1: [1, 1, 1], a0: 1 });
        spawn(K_GGLOW, e.x, e.y + 0.1, e.z, { life: 0.22 + 0.06 * W3, s0: Math.min(Rf * 4, 5), s1: Math.min(Rf * (7 + 1.6 * W3), 10), c0: [0.9, 0.42, 0.1], c1: [0.3, 0.1, 0.03], a0: 1 });
      }
    } else {
      spawn(K_FLASH, e.x, e.y + 0.3, e.z, { life: 0.07 + 0.025 * W3, s0: Rf * 1.7, s1: Rf * (3.2 + 0.6 * W3), c0: big ? [5, 4.6, 3.8] : [4.2, 3.2, 1.7], c1: [2.0, 1.0, 0.4], a0: 1 });
      spawn(K_FLASH, e.x, e.y + 0.4, e.z, { life: 0.2 + 0.05 * W3, s0: Rf * 2.2, s1: Rf * 4.2, c0: [1.1, 0.5, 0.16], c1: [0.4, 0.14, 0.04], a0: 0.55 });
      if (!env.under) spawn(K_GGLOW, e.x, e.y + 0.1, e.z, { life: 0.35 + 0.08 * W3, s0: Rf * 4, s1: Rf * (7 + 1.6 * W3), c0: [1.5, 0.7, 0.2], c1: [0.4, 0.12, 0.03], a0: 1 });
    }
    // the shock wave (lens refraction band / faint ring) and the Wilson shell: see FX.shockWave (P73)
    // P61: the holy grenade (the biggest blast, W3 > 2.2) reads big at the game camera: a wide golden-white wash, two slow shock rings
    // (camera-facing and on the ground), a second pulse and a crown of sparks
    const huge = /holy/.test(kd) || W3 > 2.2;
    if (huge) {
      if (hk > 0.5) { spawn(K_FLASH, e.x, e.y + 0.5, e.z, { life: 0.16, s0: Rf * 2.6, s1: Rf * 7, c0: [3.4, 2.9, 1.9], c1: [1.2, 0.8, 0.3], a0: 0.85 * hk });
      spawn(K_FLASH, e.x, e.y + 0.6, e.z, { life: he ? 0.3 : 0.55, s0: Rf * 3, s1: Rf * 6.5, c0: he ? [1.3, 1.1, 0.7] : [1.0, 0.62, 0.22], c1: he ? [0.4, 0.34, 0.2] : [0.3, 0.15, 0.05], a0: 0.5 * hk }); }
      later.push({ t: 0.14, fn: () => {
        if (hit && !env.under) spawn(K_RINGG, e.x, e.y + 0.25, e.z, { life: 0.9, s0: Rr, s1: Rr * 7.5, c0: [1.0, 0.85, 0.55], c1: [0.55, 0.45, 0.3], a0: 0.55 });
      } });
      for (let i = 0; i < cnt(26); i++) { const a = rnd(0, 6.283), sp = rnd(8, 18), up = rnd(0.2, 1.1); spawn(K_SPARK, e.x, e.y + 0.4, e.z, { vx: Math.cos(a) * sp, vy: up * sp + 4, vz: Math.sin(a) * sp, life: rnd(0.6, 1.3), s0: 0.14, s1: 0.05, c0: [5200, 4200, 1200], grav: 14, drag: 0.5 }); }
    }
    if (hit && !env.under) {
      const gc = mf.dust.map(v => Math.min(1, v * 0.75 + 0.25));
      spawn(K_RINGG, e.x, e.y + 0.22, e.z, { life: 0.5 + 0.1 * W3, s0: Rr * 0.7, s1: Rr * 4.6, c0: gc.map(v => v * 0.9), c1: gc.map(v => v * 0.45), a0: 0.7 });
      if (he) spawn(K_RINGG, e.x, e.y + 0.3, e.z, { life: 0.3 + 0.05 * W3, s0: Rr * 0.5, s1: Rr * (6 + 1.2 * W3), c0: [1.0, 0.95, 0.85], c1: gc.map(v => v * 0.6), a0: 0.85 });   // the shock front racing along the ground, pale, ahead of the dust
      else if (W3 > 0.9) spawn(K_RINGG, e.x, e.y + 0.3, e.z, { life: 0.34, s0: Rr * 0.4, s1: Rr * 3.4, c0: [1.1, 0.8, 0.45], c1: [0.4, 0.25, 0.1], a0: 0.45 });
    }
    // soot: TNT is oxygen-poor, its smoke is black; a buoyant puffy column that greys as it thins. Over loose ground the
    // dirt it lofts mixes in (browner, lighter); over snow / ice / foam the vapour is white; rain beats it down and greys it.
    // P58: the column is built in waves (a stem of puffs rising from the crater, a mushroom cap for a big one) and drifts with the wind
    const sootK = Math.max(0.35, 1 - mf.loft * 0.55), oil = isBarrel || isCar ? 0.6 : 1, heK = he ? 1 : 0;
    const sc0 = [(0.06 + mf.dust[0] * 0.18 * (1 - sootK) + heK * (0.07 + mf.dust[0] * 0.14)) * oil, (0.055 + mf.dust[1] * 0.18 * (1 - sootK) + heK * (0.065 + mf.dust[1] * 0.14)) * oil, (0.05 + mf.dust[2] * 0.18 * (1 - sootK) + heK * (0.06 + mf.dust[2] * 0.14)) * oil];   // HE: dark grey-brown (soil mixed into the soot), not black oil smoke
    const sc1 = [0.32 + (mf.dust[0] - 0.32) * 0.35 * mf.loft, 0.31 + (mf.dust[1] - 0.31) * 0.35 * mf.loft, 0.3 + (mf.dust[2] - 0.3) * 0.35 * mf.loft];
    const nSmoke = cnt(14 * (0.8 + 0.2 * wetK)), colH = Rf * (1.5 + 0.6 * W3) * (isBarrel || isCar ? 1.3 : 1);
    for (let i = 0; i < nSmoke; i++) {
      const d = sphereDir(), sp = rnd(0.5, 2.5) * W3;
      spawn(K_SMOKE, e.x + d[0] * Rf * 0.4, e.y + 0.2 + Math.abs(d[1]) * Rf * 0.3, e.z + d[2] * Rf * 0.4, { vx: d[0] * sp + wx * 0.2 + nx * ventK * 2.2 * W3, vy: rnd(1.5, 3.5) * W3 * wetK * (1 - 0.45 * ventK), vz: d[2] * sp + wz * 0.2 + nz * ventK * 2.2 * W3, drag: 1.2 + rain * 0.6, buoy: (he ? 0.5 : 0.8) * wetK,
        life: rnd(2.8, 5.0) * (1 - 0.25 * rain) * cave, s0: Rf * 0.5, s1: Rf * rnd(2.2, 3.4), c0: sc0, c1: sc1, a0: 0.8 });
    }
    if (he) {                                            // P66a: the detonation's dust and soot cloud: a dark grey-brown billow punched out of the crater at once (it carries the picture once the flash is gone)
      const nb = cnt(14 + 7 * W3), bc0 = sc0.map((v, q) => v * 0.55 + mf.dust[q] * 0.3 * mf.loft * 0.8), bc1 = sc1.map((v, q) => v * 0.75 + mf.dust[q] * 0.25 * mf.loft);      // P71: the billow is dark soil / rock dust, sized by the charge
      for (let i = 0; i < nb; i++) {
        const d = cone(0.1, 1.35), sp = rnd(2.5, 7.5) * Math.sqrt(W3);
        spawn(K_SMOKE, e.x + nx * 0.3 + d[0] * Rf * 0.25, e.y + ny * 0.3 + d[1] * Rf * 0.25, e.z + nz * 0.3 + d[2] * Rf * 0.25, { vx: d[0] * sp + wx * 0.2, vy: d[1] * sp * 0.8 + 0.8, vz: d[2] * sp + wz * 0.2, drag: 2.2 + rain * 0.6, buoy: 0.3 * wetK,
          life: rnd(2.4, 4.4) * (1 - 0.25 * rain) * cave, s0: Math.min(5, Rf * 0.8), s1: Math.min(9, Rf * rnd(2.3, 3.6)), c0: bc0, c1: bc1, a0: 0.93 });
      }
    }
    const nStem = cnt(4 + 3 * W3);
    for (let w = 1; w <= 3; w++) later.push({ t: 0.12 + 0.2 * w, fn: () => {
      for (let i = 0; i < nStem; i++) {
        const a = rnd(0, 6.283), rr = rnd(0, Rf * 0.35);
        spawn(K_SMOKE, e.x + Math.cos(a) * rr, e.y + 0.3 + colH * 0.22 * w * rnd(0.6, 1), e.z + Math.sin(a) * rr, { vx: rnd(-0.5, 0.5) + wx * 0.25, vy: rnd(2.2, 3.8) * (0.8 + 0.3 * W3) * wetK, vz: rnd(-0.5, 0.5) + wz * 0.25, drag: 1.0 + rain * 0.5, buoy: 0.9 * wetK,
          life: rnd(3.4, 6.0) * (1 - 0.25 * rain) * cave, s0: Rf * 0.5, s1: Rf * rnd(1.6, 2.6), c0: sc0, c1: sc1.map(v => v * 0.95), a0: 0.7 - 0.08 * w });
      }
    } });
    if (W3 > 1.5) later.push({ t: 0.75, fn: () => {                                  // the mushroom: a ring of puffs rolling out at the top of the column
      const nc = cnt(10 + 4 * W3), hc = e.y + colH * 1.5;
      for (let i = 0; i < nc; i++) { const a = i / nc * 6.283 + rnd(-0.2, 0.2), v = rnd(1.6, 3) * Math.sqrt(W3);
        spawn(K_SMOKE, e.x + Math.cos(a) * Rf * 0.5, hc + rnd(-0.4, 0.4), e.z + Math.sin(a) * Rf * 0.5, { vx: Math.cos(a) * v + wx * 0.2, vy: rnd(0.2, 1.2), vz: Math.sin(a) * v + wz * 0.2, drag: 1.3, buoy: 0.45,
          life: rnd(3.5, 5.5), s0: Rf * 0.9, s1: Rf * rnd(2.2, 3.2), c0: sc1.map(v => v * 0.7), c1: sc1, a0: 0.65 }); }
    } });
    if (isBarrel || isCar) later.push({ t: 0.16, fn: () => { if (SS.flameView) SS.flameView.fireball(e.x + rnd(-0.4, 0.4), e.y + Rf * 0.7, e.z + rnd(-0.3, 0.3), Rf * 0.75, W3 * 0.8, 0.8); } });      // the fuel / oil goes up a moment later
    // a blast that reached the ground throws it: dust of the crater's own colours (blend of the removed materials), a
    // ground-hugging shock skirt, a fountain of fines, solid chunks (clods / rock / ice shards), pebbles and a rain of dirt, all by material
    const amt = hit ? Math.min(2.2, 0.35 + mf.best / 160) * (1 - 0.6 * rain) : 0;
    if (hit) {
      const col = mf.dust, nd = cnt(Math.min(22, 4 + mf.best / 30) * mf.amt * (1 - 0.5 * rain));
      for (let i = 0; i < nd; i++) {
        const d = cone(0.05, 1.2), sp = rnd(2.5, 7) * W3 * mf.lift;
        spawn(K_DUST, e.x + nx * 0.2 + d[0] * 0.3, e.y + ny * 0.2 + d[1] * 0.3, e.z + nz * 0.2 + d[2] * 0.3, { vx: d[0] * sp + wx * 0.15, vy: d[1] * sp, vz: d[2] * sp + wz * 0.15, drag: 2.2, grav: 2.5,
          life: rnd(1.5, 2.8) * cave, s0: 0.5 * W3, s1: rnd(1.5, 2.6) * W3 * mf.puff, c0: col, c1: col.map(v => v * 1.1 + 0.05), a0: 0.62 + 0.2 * mf.amt });
      }
      // P71 the dust skirt: the ground shock lifts a low wall of dust that races out along the ground. The section hides what runs BEHIND its plane, so most of it
      // runs along the plane itself (left and right, hugging the real profile: it reads as the classic side-on dust wave) and toward the camera, over the cut face's lip
      const nr = cnt(Math.min(52, 20 + 16 * W3) * Math.min(1.4, mf.amt) * (1 - 0.4 * rain)), Sx = env.S, pl = Sx && SS.plane && SS.plane.nrm ? SS.plane : null, pn = pl ? pl.nrm(Sx) : { x: 0, z: 1 }, pdr = pl ? pl.dir(Sx) : { x: 1, z: 0 }, skW = Math.min(1.9, W3);
      for (let i = 0; i < nr; i++) {
        const u = i / nr, sgn = i % 2 ? 1 : -1; let dx, dz;
        if (u < 0.5) { const j = rnd(-0.3, 0.3); dx = pdr.x * sgn + pn.x * j; dz = pdr.z * sgn + pn.z * j; }                       // along the plane, both ways
        else if (u < 0.82) { const j = rnd(-1.0, 1.0); dx = pn.x * Math.cos(j) + pdr.x * Math.sin(j); dz = pn.z * Math.cos(j) + pdr.z * Math.sin(j); }       // toward the viewer
        else { const a = rnd(0, 6.283); dx = Math.cos(a); dz = Math.sin(a); }
        const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
        const into = dx * fr.hx + dz * fr.hz; if (ventK > 0 && into < 0) { dx -= 2 * into * fr.hx * ventK; dz -= 2 * into * fr.hz * ventK; }                    // at a wall the skirt cannot go into the rock: it is turned back out along it
        const v = rnd(7, 14) * Math.sqrt(W3) * mf.puff, front = u >= 0.5 && u < 0.82;
        spawn(K_DUST, e.x + dx * Rr * 0.3, e.y + 0.18, e.z + dz * Rr * 0.3, { vx: dx * v, vy: 0, vz: dz * v, hug: rnd(0.3, 0.7), drag: 1.5,
          life: rnd(1.4, 2.4), s0: 0.6 * skW, s1: rnd(1.9, 3.1) * skW * mf.puff, c0: col.map(v2 => v2 * 0.95), c1: col.map(v2 => v2 * 1.12 + 0.06), a0: (front ? 0.5 : 0.75) * Math.min(1.2, mf.amt) });
      }
      const wood = isBarrel || /crate/.test(kd), mcol = isBarrel || isCar ? [0.28, 0.27, 0.27] : wood ? [0.5, 0.33, 0.18] : null;
      const ncz = FX.env.noChunks ? 0 : cnt(Math.min(52, (6 + mf.best / 18) * mf.chunks * (0.8 + 0.5 * W3)));
      for (let i = 0; i < ncz; i++) {
        const d = cone(0.12, 1.1), sp = rnd(3.5, 11) * Math.sqrt(W3) * (0.7 + 0.3 * hard) + 2, sh = rnd(0.5, 1.05), bigC = i % 6 === 0 ? 2.0 : 1, base = mcol && i % 3 === 0 ? mcol : mf.chunk, c = base.map(v2 => Math.min(1, v2 * sh));
        const vx = d[0] * sp, vy = d[1] * sp, vz = d[2] * sp, sz = Math.min(0.95, rnd(0.22, 0.42) * (0.75 + 0.55 * W3) * bigC), angK = Math.min(1, hard * 1.15) * (0.7 + 0.3 * Math.random());      // rock / concrete break into faceted shards that tumble, soil into rounded clods
        spawn(K_CHUNK, e.x + nx * 0.3 + d[0] * 0.2, e.y + ny * 0.3 + d[1] * 0.2, e.z + nz * 0.3 + d[2] * 0.2, { vx, vy, vz, grav: 17, drag: 0.1, life: rnd(1.6, 2.6), s0: sz, s1: sz, c0: c, a0: 1, ang: angK, spin: rnd(-1, 1) * (1.5 + 7 * hard), trail: bigC > 1 || i % 4 === 1 ? 0.05 : 0 });
        if (bigC > 1 && mf.amt > 0.3 && !isMine) spawn(K_DUST, e.x + nx * 0.3, e.y + ny * 0.3, e.z + nz * 0.3, { vx: vx * 0.9, vy: vy * 0.9, vz: vz * 0.9, grav: 11, drag: 0.9, life: rnd(0.9, 1.5), s0: 0.15 * W3, s1: 0.55 * W3 * mf.puff, c0: col, c1: col.map(v2 => v2 * 1.1 + 0.05), a0: 0.4 });   // the dust a big clod drags behind it
      }
      const npb = FX.env.noChunks ? 0 : cnt((12 + 10 * W3) * (0.5 + 0.5 * mf.chunks) * (isMine ? 1.6 : 1));          // pebbles and crumbs thrown far and high: they come down as a rain of dirt
      for (let i = 0; i < npb; i++) {
        const d = cone(0.05, 0.75), sp = rnd(5, 14) * Math.sqrt(W3) + 3, sh = rnd(0.55, 1.1), c = (mcol && i % 5 === 0 ? mcol : mf.chunk).map(v2 => Math.min(1, v2 * sh)), sz = rnd(0.09, 0.17);
        spawn(K_CHUNK, e.x + nx * 0.4, e.y + ny * 0.4, e.z + nz * 0.4, { vx: d[0] * sp, vy: d[1] * sp, vz: d[2] * sp, grav: 15, drag: 0.15, life: rnd(1.6, 2.8), s0: sz, s1: sz, c0: c, a0: 1, ang: Math.min(1, hard * 1.1), spin: rnd(-1, 1) * 10 });
      }
      if (mf.cold > 0.3) for (let i = 0; i < cnt(6 + 6 * W3); i++) { const d = sphereDir(); spawn(K_STEAM, e.x, e.y + 0.2, e.z, { vx: d[0] * 2, vy: Math.abs(d[1]) * 3 + 1, vz: d[2] * 2, drag: 1.6, life: rnd(0.8, 1.6), s0: 0.2 * W3, s1: rnd(0.8, 1.4) * W3, a0: 0.45 * mf.cold, c0: [0.96, 0.98, 1] }); }   // powder / frost mist
      if (mf.cold > 0.3 && mf.hard > 0.3) for (let i = 0; i < cnt(10 + 8 * W3); i++) { const a = rnd(0, 6.283), sp = rnd(2, 7) * Math.sqrt(W3); spawn(K_SPARK, e.x, e.y + 0.2, e.z, { vx: Math.cos(a) * sp, vy: rnd(3, 9), vz: Math.sin(a) * sp, life: rnd(0.4, 0.9), s0: 0.07, s1: 0.04, c0: [5200, 4200, 0], grav: 12, drag: 0.4 }); }   // ice glints
    }
    if (hit && !env.under) {
      // P65k: a blast against a wall / steep face vents out along the opening: a tongue of fire and dust jetting out of the notch (the column still rises, but leans out)
      if (ventK > 0.05) {
        const nv = cnt(7 + 9 * W3 * ventK), col = mf.dust;
        for (let i = 0; i < nv; i++) { const d = cone(0, 0.55), v = rnd(4, 11) * Math.sqrt(W3) * (0.5 + 0.5 * ventK);
          spawn(K_DUST, e.x + nx * 0.3, e.y + ny * 0.3, e.z + nz * 0.3, { vx: d[0] * v, vy: d[1] * v, vz: d[2] * v, drag: 2.4, grav: 1.2, life: rnd(1.2, 2.2), s0: 0.35 * W3, s1: rnd(1.2, 2.0) * W3 * mf.puff, c0: col, c1: col.map(v2 => v2 * 1.1 + 0.05), a0: 0.55 * ventK + 0.15 });
          if (!he && i % 2 === 0) spawn(K_FIRE, e.x + nx * 0.3, e.y + ny * 0.3, e.z + nz * 0.3, { vx: d[0] * v * 0.8, vy: d[1] * v * 0.8, vz: d[2] * v * 0.8, drag: 6, life: rnd(0.18, 0.35), s0: Rf * 0.3, s1: Rf * 0.75, c0: [rnd(2000, 2600), 1000, 0], a0: 0.85 * ventK }); }
      }
      // granular spray: sand throws a fine bright curtain of grains, snow a powder puff with soft clumps, ash a dark feathery cloud
      const gr = mf.grain || 0;
      if (gr > 0.05 && !FX.env.noChunks) {
        const ng = cnt(Math.min(40, 14 * gr * (0.6 + 0.6 * W3))), gc = mf.chunk;
        for (let i = 0; i < ng; i++) { const d = cone(0.08, 1.0), sp = rnd(4, 12) * Math.sqrt(W3), sh = rnd(0.85, 1.12), sz = rnd(0.03, 0.06);
          spawn(K_CHUNK, e.x + nx * 0.3, e.y + ny * 0.3, e.z + nz * 0.3, { vx: d[0] * sp, vy: d[1] * sp, vz: d[2] * sp, grav: 13, drag: 0.6, life: rnd(1.0, 1.8), s0: sz, s1: sz, c0: gc.map(v2 => Math.min(1, v2 * sh)), a0: 0.9, spin: rnd(-4, 4) }); }
      }
    }
    // P71: the blast wave lays the grass flat around it and it springs back (grass.js reads FX.blastField); never in a cave / vacuum
    if (!env.under && W3 > 0.3) { blasts.push({ x: e.x, z: e.z, R: 2.4 + 3.2 * W3, t: 0 }); if (blasts.length > 4) blasts.shift(); }
    // P71: a blast beside the water (not in it) throws a splash column from the nearest water and a foam ring races out; only when the shock is strong there
    if (!env.under && !env.vac && SS.water && env.S && env.S.water) {
      const Sx = env.S, pl = SS.plane, pn = pl && pl.nrm ? pl.nrm(Sx) : { x: 0, z: 1 }, pdr = pl && pl.dir ? pl.dir(Sx) : { x: 1, z: 0 }; let bd = 1e9, bs = 1e9, bx = 0, bz = 0, bl = 0;
      for (let ri = 0; ri < 4; ri++) for (let ai = 0, na = ri ? 12 : 1; ai < na; ai++) {
        const r = [0, 0.9, 1.8, 2.8][ri] * Rr, a = ai / 12 * 6.283, ca = Math.cos(a), sa = Math.sin(a), x = e.x + (pdr.x * ca + pn.x * sa) * r, z = e.z + (pdr.z * ca + pn.z * sa) * r;
        const sf = SS.water.surface(Sx, x, z); if (!(sf > -90) || SS.water.depth(Sx, x, z) < 0.25 || Math.abs(sf - e.y) > 3.5) continue;
        const sc = r * (sa < -0.3 ? 1.6 : 1);                      // water behind the section plane is hidden by the slab: prefer what the camera sees
        if (sc < bs) { bs = sc; bd = r; bx = e.x + (pdr.x * ca) * r + pn.x * Math.max(0, sa) * r * 0.5; bz = e.z + (pdr.z * ca) * r + pn.z * Math.max(0, sa) * r * 0.5; bl = sf; }      // (the splash is drawn on the plane or just in front of it)
      }
      const kw = bd < 1e8 ? W3 * Math.max(0, 1 - bd / (3.4 * Rr)) : 0;
      if (kw > 0.22) later.push({ t: bd / 22, fn: () => {
        FX.waterBlast({ x: bx, y: bl, z: bz, R: Math.min(4.2, 1.6 + 1.8 * kw), jetH: 3.4 + 4.0 * kw, tJet: 0.1 + bd * 0.015, under: false, vis: 1.7 });
      } });
    }
    // burning bits (the casing's hot fragments are drawn by render/shrapnel.js): sparks; hard ground (rock, concrete, steel) and metal props strike more
    const metal = isBarrel || isCar ? 1 : 0, nsp = cnt((he ? 9 : 22) * (0.6 + 0.9 * Math.max(hard, metal) * Math.max(hard, metal)) * (1 + 0.5 * W3));      // P118d (Q-13): a fireball throws many more burning streaks than a detonation
    for (let i = 0; i < nsp; i++) { const d = sphereDir(), sp = rnd(5, 13) * (he ? 1 : 1.3) * (0.8 + 0.5 * Math.max(hard, metal)); spawn(K_SPARK, e.x, e.y + 0.1, e.z, { vx: d[0] * sp, vy: Math.abs(d[1]) * sp + 2, vz: d[2] * sp, life: rnd(0.4, 1.0), s0: 0.14, s1: 0.07, c0: [rnd(2200, 2900), 1100, 0], grav: 9.8, drag: 0.6 }); }
    // light: warm for fire, whiter on steel / concrete (sparks), cool over ice / snow; a weak daylight flash is hidden by the sun, at dusk / night it lights the land
    const lt = env.tod === 'night' ? 1.5 : env.tod === 'dusk' ? 1.2 : 1;
    if (he) flash.color.setRGB(1, 0.93 + 0.05 * mf.cold, 0.76 + 0.2 * hard * hard + 0.2 * mf.cold); else flash.color.setRGB(1 + 0 * mf.cold, 0.66 + 0.2 * hard * hard + 0.12 * mf.cold, 0.32 + 0.4 * hard * hard + 0.4 * mf.cold);
    own.uGlow.value.set(e.x, e.y + 0.6, e.z, 0); glowI = (env.tod === 'night' ? 0.75 : env.tod === 'dusk' ? 0.4 : 0.1 + 0.3 * env.rain) * Math.min(2, 0.6 + W3); glowT = 0; own.uGlowC.value.setRGB(1, (he ? 0.8 : 0.42) + 0.3 * mf.hard * mf.hard, (he ? 0.5 : 0.12) + 0.35 * mf.cold); if (he) glowI *= 0.4;
    flash.position.set(e.x, e.y + 0.5, e.z); flash.intensity = (he ? 85 : 55) * Rf * lt * (1.0 + 0.3 * Math.min(2, W3)) * (huge ? 1.9 : 1); flashK = he ? 26 : 9; flash.distance = 16 + 8 * (lt - 1) + 4 * W3 + (huge ? 14 : 0); flashT = 0;
    FX.shockWave(e.x, e.y + 0.3, e.z, W3, Rf, he, huge, rain, camDist, he ? [1.0, 0.95, 0.85] : [0.8, 0.72, 0.6]);
    // camera shake: the charge (W^1/3) over the distance to the camera's focus (camDist = metres), none when far away
    const d = Math.max(0, camDist), amp = 0.62 * W3 / (1 + (d / (5 * W3 + 2)) * (d / (5 * W3 + 2)));
    shake = Math.min(huge ? 1.25 : 1.0, shake + (amp < 0.02 ? 0 : amp * (huge ? 1.3 : 1)));       // P71: capped lower (a holy grenade's 1.6 swung the camera by ~1 m)
    if (SS.view && SS.view.scorch && hit && !env.under) SS.view.scorch(e.x, e.z, 0.6 + 0.55 * e.R, Math.min(1, 0.55 + 0.25 * W3) * mf.scorch * (1 - 0.7 * rain), e.y, Math.min(1, 0.35 + 0.7 * mf.loft) * (1 - 0.5 * rain));
  };
  /* P118d: in vacuum nothing billows. A "puff of dust" (a landing, a collapse, a bullet strike) is a few dark specks that fly out and fall on the local gravity of the pieces (render/eowview.js
   * sets FX.field; view.js sets FX.env.vac every frame); a spark or a chip uses the field instead of -y. */
  function vacSpecks(x, y, z, n, size, c) {
    for (let i = 0, k = Math.min(10, Math.max(2, Math.round(n * 1.5 * QN))); i < k; i++)
      spawn(K_CHUNK, x + rnd(-0.15, 0.15), y + 0.05, z + rnd(-0.1, 0.1), { vx: rnd(-1.4, 1.4), vy: rnd(0.3, 2.4), vz: rnd(-0.6, 0.6), fld: 1, life: rnd(1.3, 2.4), s0: Math.max(0.03, size * rnd(0.06, 0.14)), s1: 0.05, c0: c.map(v => Math.min(1, v * rnd(0.7, 1.0))), a0: 1, ang: 0.8, spin: rnd(-4, 4) });
  }
  FX.dust = function (x, y, z, cnt, size, col) {
    const c = hex(col == null ? 0xb8a080 : col);
    if (FX.env.vac) { vacSpecks(x, y, z, cnt, size, c); return; }
    for (let i = 0; i < cnt; i++) {
      const a = rnd(0, 6.283), sp = rnd(0.6, 1.8);
      spawn(K_DUST, x, y + 0.05, z, { vx: Math.cos(a) * sp, vy: rnd(0.2, 0.9), vz: Math.sin(a) * sp, life: rnd(0.8, 1.5), s0: size * 0.4, s1: size * rnd(1, 1.6), a0: 0.5, c0: c, c1: c.map(v => v * 1.08 + 0.04), drag: 2.5 });
    }
  };
  /* solid chips thrown out of a smashed thing (wood splinters, bricks, ice shards): n chunks of colour col (rgb 0..1), speed sp m/s; they fall and bounce on the ground */
  FX.chips = function (x, y, z, col, n, sp, size) {
    for (let i = 0; i < n; i++) {
      const a = rnd(0, 6.283), v = rnd(0.4, 1) * sp, sh = rnd(0.6, 1.1);
      spawn(K_CHUNK, x + rnd(-0.2, 0.2), y + rnd(0, 0.3), z + rnd(-0.1, 0.1), { vx: Math.cos(a) * v, vy: rnd(0.5, 1) * sp * 0.9 + 1.5, vz: Math.sin(a) * v * 0.5, fld: FX.env.vac ? 1 : 0, grav: FX.env.vac ? 0 : 17, drag: 0.1, life: rnd(1.2, 2.2),
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
    if (FX.env.vac) { vacSpecks(x, y, z, n * 0.6, size, c); return; }
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
      spawn(K_DROP, x + Math.cos(a) * r0, y + 0.03, z + Math.sin(a) * r0, { vx: Math.cos(a) * out, vy: up, vz: Math.sin(a) * out, life: rnd(0.55, 0.95), s0: 0.05 * sz + 0.04, s1: 0.05 * sz + 0.04, a0: 0.92, c0: [0.95, 0.98, 1], grav: 9.8, drag: 0.15 });
    }
    for (let i = 0; i < 14 * sz; i++) {                             // droplets flung higher and wider
      const a = rnd(0, 6.283), sp = rnd(0.4, 3) * sz;
      spawn(K_DROP, x, y + 0.03, z, { vx: Math.cos(a) * sp, vy: rnd(3.5, 7) * Math.sqrt(sz), vz: Math.sin(a) * sp, life: rnd(0.6, 1.1), s0: 0.03 * sz + 0.03, s1: 0.03 * sz + 0.03, a0: 0.9, c0: [0.92, 0.96, 1], grav: 9.8, drag: 0.2 });
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
  const later = [], blasts = [];
  /* P87: a droplet streak (ballistic, motion-blurred, makes a small impact where it lands) and, now and then, a puff of fine mist that the wind carries off */
  function spray(x, y, z, vx, vy, vz, s, life) {
    s *= sprayK;
    spawn(K_DROP, x, y, z, { vx, vy, vz, life: Math.max(0.5, life), s0: Math.min(0.32, 0.07 + s * 0.55), s1: Math.min(0.32, 0.07 + s * 0.55), a0: 0.95, c0: [0.93, 0.97, 1], grav: 9.8, drag: 0.12 });
    if (Math.random() < 0.3) spawn(K_STEAM, x, y, z, { vx: vx * 0.5, vy: vy * 0.55, vz: vz * 0.5, life: life * 1.3 + 0.6, s0: s * 0.7, s1: s * 2.2, a0: 0.2, c0: [0.95, 0.98, 1], c1: [0.9, 0.94, 0.98], grav: 2, drag: 1.2 });
  }
  let sprayK = 1;                                                    // P73: spray size multiplier (a splash beside a blast must read at the game camera)
  FX.waterBlast = function (e) {
    sprayK = e.vis || 1; const vs = sprayK;
    const sz = Math.min(2.4, Math.max(0.6, e.R / 2.8)), R = e.R, jet = (e.jetH || 3 * sz) * 1.8, wx = FX.env.wx || 0, wz = FX.env.wz || 0, cnt = v => Math.max(1, Math.round(v * QN));
    const nC = cnt(46 * sz * (1 + 0.5 * (vs - 1))), crownV = Math.sqrt(2 * 9.8 * jet * (e.under ? 0.45 : 0.7));
    // P58: the foam ring: a bright front racing out over the water at once, a second slower one behind it, a flash of white where the cavity opens
    spawn(K_RINGG, e.x, e.y + 0.07, e.z, { life: 0.9 + 0.3 * sz, s0: R * 0.9, s1: R * (5.2 + 1.2 * sz), c0: [0.85, 0.93, 1.0], c1: [0.4, 0.5, 0.6], a0: 0.45 });
    later.push({ t: 0.3, fn: () => spawn(K_RINGG, e.x, e.y + 0.07, e.z, { life: 1.2, s0: R * 0.8, s1: R * 4.2, c0: [0.6, 0.72, 0.82], c1: [0.25, 0.33, 0.42], a0: 0.25 }) });
    spawn(K_FLASH, e.x, e.y + 0.4, e.z, { life: 0.1, s0: R * 0.8, s1: R * 1.8, c0: [1.6, 2.0, 2.2], c1: [0.5, 0.8, 1.0], a0: 0.8 });
    // P87: the crown is a SHEET that breaks into ligaments (Rayleigh-Plateau fingers, ~even spacing round the rim); each finger sheds 3-4 droplets
    // at slightly different speeds (a streak chain), then the loose droplets and the fines
    for (let i = 0, nL = cnt(12 + 8 * sz); i < nL; i++) {
      const a = i / nL * 6.283 + rnd(-0.12, 0.12), r0 = R * rnd(0.3, 0.55), out = rnd(2.5, 5) * sz, up = crownV * rnd(0.7, 1.05);
      for (let k = 0; k < 4; k++) { const f = 1 + 0.12 * k + rnd(-0.04, 0.04);
        spray(e.x + Math.cos(a) * r0, e.y + 0.05, e.z + Math.sin(a) * r0, Math.cos(a) * out * f, up * (1 - 0.06 * k) * f, Math.sin(a) * out * f, rnd(0.24, 0.5) * sz * (1 - 0.15 * k), rnd(0.9, 1.6)); }
    }
    for (let i = 0; i < nC; i++) {                                  // loose droplets: a cone from the cavity rim
      const a = rnd(0, 6.283), r0 = R * rnd(0.15, 0.5), out = rnd(1.5, 4.5) * sz;
      spray(e.x + Math.cos(a) * r0, e.y + 0.05, e.z + Math.sin(a) * r0, Math.cos(a) * out, crownV * rnd(0.55, 1.05), Math.sin(a) * out, rnd(0.12, 0.3) * sz, rnd(0.9, 1.6));
    }
    for (let i = 0, nd = cnt(14 * sz); i < nd; i++) {               // the dome: the cavity's wall, a sheet of dense white puffs thrown up and out
      const a = i / nd * 6.283 + rnd(-0.2, 0.2), r0 = R * rnd(0.45, 0.7), out = rnd(2.2, 4) * sz;
      spawn(K_STEAM, e.x + Math.cos(a) * r0, e.y + 0.1, e.z + Math.sin(a) * r0, { vx: Math.cos(a) * out, vy: crownV * rnd(0.5, 0.8), vz: Math.sin(a) * out, drag: 0.5, grav: 8, life: rnd(0.8, 1.3), s0: 0.2 * sz, s1: 0.55 * sz, a0: 0.3, c0: [0.95, 0.98, 1], c1: [0.85, 0.9, 0.95] });
    }
    sprayK = 1;
    later.push({ t: e.tJet || 0.25, fn: () => {                     // the jet column
      const v0 = Math.sqrt(2 * 9.8 * jet), nJ = cnt(170 * sz * vs), rj = R * 0.3;
      sprayK = 1 + 0.25 * (vs - 1);
      for (let i = 0; i < nJ; i++) {                                // a dense core (fast, narrow) inside a looser sheath
        const a = rnd(0, 6.283), r0 = rj * Math.sqrt(Math.random()), f = Math.sqrt(Math.random()) * 0.75 + 0.25, core = i % 3 !== 0;
        spray(e.x + Math.cos(a) * r0, e.y + 0.1, e.z + Math.sin(a) * r0, Math.cos(a) * rnd(0.1, core ? 0.5 : 1.4) + wx * 0.1, v0 * f, Math.sin(a) * rnd(0.1, core ? 0.5 : 1.4) + wz * 0.1,
          rnd(0.3, 0.7) * sz, 2 * v0 * f / 9.8 + rnd(0.3, 0.6));
      }
      sprayK = 1;
      for (let i = 0, nb = cnt(26 * vs); i < nb; i++) {                   // the column's body: white billows stacked up it, the cap spreading at the top and drifting off in the wind
        const f = (i + 0.5) / nb;
        spawn(K_STEAM, e.x + rnd(-rj, rj), e.y + jet * (0.25 + 0.75 * f), e.z + rnd(-rj, rj), { vx: rnd(-0.3, 0.3) + wx * 0.2, vy: rnd(0.5, 1.6) * (0.5 + f), vz: rnd(-0.3, 0.3) + wz * 0.2, life: rnd(1.6, 2.7), s0: (0.4 + 0.5 * f) * sz * vs, s1: rnd(1.1, 1.8) * sz * (0.7 + 0.6 * f) * vs, a0: 0.35, c0: [0.98, 0.99, 1], c1: [0.9, 0.93, 0.97], drag: 1.2 });
      }
    } });
    later.push({ t: (e.tJet || 0.25) + 0.15, fn: () => {            // base surge: mist rolling out low over the water
      const nS = cnt(18 * sz);
      for (let i = 0; i < nS; i++) { const a = i / nS * 6.283 + rnd(-0.2, 0.2), v = rnd(2, 4.5) * sz;
        spawn(K_STEAM, e.x + Math.cos(a) * R * 0.4, e.y + 0.3, e.z + Math.sin(a) * R * 0.4, { vx: Math.cos(a) * v, vy: rnd(0.1, 0.5), vz: Math.sin(a) * v, drag: 1.1, life: rnd(2.2, 3.6), s0: 0.6 * sz, s1: rnd(2.2, 3.2) * sz, a0: 0.5, c0: [0.93, 0.95, 0.98], c1: [0.9, 0.92, 0.95] }); }
    } });
  };
  FX.trail = function (x, y, z) {
    if (FX.env.vac) return;                                                  // P68d: no smoke in vacuum
                                  // a rocket's exhaust: a white-grey smoke ribbon that swells, thins and drifts with the wind; a hot lick at the nozzle; now and then a spark
    if (SS.trailView && SS.trailView.smoke) SS.trailView.smoke(x, y, z);                  // P118d (Q-17): the smoke is one continuous ribbon (render/trails.js), not a puff per frame
    else spawn(K_SMOKE, x, y, z, { vx: rnd(-0.25, 0.25), vy: rnd(0.15, 0.55), vz: rnd(-0.25, 0.25), life: rnd(1.2, 2.1), s0: 0.14, s1: rnd(0.9, 1.3), a0: 0.5, c0: [0.78, 0.76, 0.72], c1: [0.88, 0.88, 0.9], drag: 1.0, buoy: 0.12 });
    spawn(K_FIRE, x, y, z, { life: 0.1, s0: 0.34, s1: 0.12, c0: [2800, 1500, 0] });
    if (Math.random() < 0.3 * QN) spawn(K_SPARK, x, y, z, { vx: rnd(-1.5, 1.5), vy: rnd(-1, 1.5), vz: rnd(-1.5, 1.5), life: rnd(0.2, 0.45), s0: 0.07, s1: 0.03, c0: [2500, 1300, 0], grav: 6, drag: 0.5 });
  };
  /* P58: a bullet / grenade-bounce / small strike on a surface (normal nx, ny, nz; mat = the material id or null to look it up; k = strength ~1 for a bullet):
   * a puff of the material's own dust kicked out along the normal, crumbs of it flying, sparks off hard ground / metal, a powder puff off snow */
  FX.impact = function (x, y, z, nx, ny, nz, mat, k) {
    k = k || 1;
    const W = SS.world; let m = mat;
    if (m == null) m = W && W.mat_at ? W.mat_at(x - nx * 0.15, y - ny * 0.15, z - nz * 0.15) : 0;
    const f = MFX[m] || MFX[SS.CFG.MAT.ROCK], dry = 1 - 0.7 * FX.env.rain, cnt = v => Math.max(0, Math.round(v * QN));
    const vac = FX.env.vac, nd = vac ? 0 : cnt(2 * f.amt * k * dry + Math.random());
    const col = f.dust.map(v => Math.min(1, v * 1.05 + 0.03));
    for (let i = 0; i < nd; i++) spawn(K_DUST, x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, { vx: nx * rnd(0.6, 1.6) + rnd(-0.5, 0.5), vy: ny * rnd(0.6, 1.6) + rnd(0.2, 0.9) * f.lift, vz: nz * rnd(0.6, 1.6) + rnd(-0.5, 0.5), drag: 3, life: rnd(0.5, 1.0), s0: 0.1 * k, s1: rnd(0.3, 0.5) * k * f.puff, c0: col, c1: col.map(v => v * 1.08 + 0.04), a0: 0.5 });
    const nc = cnt((1 + 3 * f.chunks) * k * 0.7);
    for (let i = 0; i < nc; i++) { const sh = rnd(0.55, 1.1), sp = rnd(2, 5), c = f.chunk.map(v => Math.min(1, v * sh)), sz = rnd(0.025, 0.055) * (0.6 + 0.4 * k);
      spawn(K_CHUNK, x, y, z, { vx: nx * sp + rnd(-1.5, 1.5), vy: ny * sp + rnd(0.8, 3), vz: nz * sp + rnd(-1.5, 1.5), fld: vac ? 1 : 0, grav: vac ? 0 : 15, drag: 0.2, life: vac ? rnd(1.2, 2.0) : rnd(0.6, 1.1), s0: sz, s1: sz, c0: c, a0: 1 }); }
    if (f.hard > 0.55) for (let i = 0, ns = cnt((3 + 5 * f.hard) * k); i < ns; i++) { const sp = rnd(2, 6) * (0.7 + 0.5 * f.hard);
      spawn(K_SPARK, x + nx * 0.03, y + ny * 0.03, z + nz * 0.03, { vx: nx * sp * 0.7 + rnd(-2, 2), vy: ny * sp * 0.7 + rnd(0, 2.5), vz: nz * sp * 0.7 + rnd(-2, 2), life: rnd(0.15, 0.4), s0: 0.07, s1: 0.03, c0: [rnd(2400, 3200), 1300, 0], fld: vac ? 1 : 0, grav: vac ? 0 : 9.8, drag: vac ? 0 : 0.5 }); }
    if (f.hard > 0.55 && k > 0.5) spawn(K_FLASH, x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, { life: 0.04, s0: 0.1 * k, s1: 0.3 * k, c0: [3, 2.4, 1.4], c1: [1, 0.5, 0.2], a0: 0.9 });
    if (f.cold > 0.3 && !vac) spawn(K_STEAM, x, y, z, { vy: rnd(0.3, 0.9), life: rnd(0.5, 0.9), s0: 0.12 * k, s1: 0.4 * k, a0: 0.4, c0: [0.96, 0.98, 1], drag: 2 });
  };
  FX.spark = function (x, y, z) {
    for (let i = 0; i < 8; i++) { const d = sphereDir(), sp = rnd(1.5, 4), v = FX.env.vac; spawn(K_SPARK, x, y, z, { vx: d[0] * sp, vy: (v ? d[1] : Math.abs(d[1])) * sp, vz: d[2] * sp, life: rnd(0.2, 0.4), s0: 0.1, s1: 0.04, c0: [2400, 1200, 0], fld: v ? 1 : 0, grav: v ? 0 : 9.8 }); }
  };
  FX.bubble = function (x, y, z) { spawn(K_STEAM, x + rnd(-0.1, 0.1), y, z + rnd(-0.1, 0.1), { vy: rnd(0.6, 1.2), life: rnd(0.4, 0.8), s0: 0.06, s1: 0.1, a0: 0.5, c0: [0.85, 0.95, 1] }); };
  /* molten lava thrown up (projectile entry, blast splash, pocket breach): glowing blobs that arc and dim, dark fume */
  FX.lava = function (x, y, z, size) {
    const k = Math.round((10 + 18 * size) * Math.max(0.6, QN)), sq = Math.sqrt(size);
    // P58: a white-orange flash, a glowing ring running out over the pool, thick blobs on arcs with a cooling tail, dark scoria, a gout of fume
    spawn(K_FLASH, x, y + 0.2, z, { life: 0.14, s0: 0.5 * size, s1: 1.7 * size + 0.4, c0: [2.6, 1.3, 0.5], c1: [0.8, 0.25, 0.05], a0: 0.8 });
    spawn(K_RINGG, x, y + 0.08, z, { life: 0.7, s0: 0.6 * size, s1: 3.6 * size + 0.8, c0: [1.2, 0.45, 0.1], c1: [0.35, 0.08, 0.02], a0: 0.7 });
    if (flash && size > 0.5) { flash.color.setRGB(1, 0.42, 0.1); flash.position.set(x, y + 0.6, z); flash.intensity = Math.max(flash.intensity, 22 * size); flashT = 0.2; flashK = 9; }
    for (let i = 0; i < k; i++) {
      const a = rnd(0, 6.283), sp = rnd(0.4, 2.4) * size, vy = rnd(1.8, 5.2) * sq, s = rnd(0.12, 0.3) * sq;
      spawn(K_LAVA, x, y + 0.05, z, { vx: Math.cos(a) * sp, vy, vz: Math.sin(a) * sp, life: rnd(0.8, 1.6), s0: s, s1: 0.07, c0: [1500, 850, 0], grav: 9.8, drag: 0.4 });
      if (i % 3 === 0) spawn(K_LAVA, x, y + 0.05, z, { vx: Math.cos(a) * sp * 0.93, vy: vy * 0.93, vz: Math.sin(a) * sp * 0.93, life: rnd(0.5, 0.9), s0: s * 0.7, s1: 0.04, c0: [1250, 800, 0], grav: 9.8, drag: 1.2 });      // a cooling tail
    }
    for (let i = 0, n2 = Math.round((3 + 4 * size) * QN); i < n2; i++) { const a = rnd(0, 6.283), sp = rnd(1, 4) * sq; spawn(K_CHUNK, x, y + 0.1, z, { vx: Math.cos(a) * sp, vy: rnd(3, 7) * sq, vz: Math.sin(a) * sp, grav: 17, drag: 0.1, life: rnd(1.0, 1.8), s0: rnd(0.08, 0.16) * sq, s1: 0.1, c0: [0.1, 0.085, 0.08], a0: 1 }); }
    for (let i = 0; i < 4 + 4 * size; i++) spawn(K_SMOKE, x + rnd(-0.4, 0.4) * size, y + 0.3, z + rnd(-0.4, 0.4) * size, { vx: (FX.env.wx || 0) * 0.15, vy: rnd(0.6, 1.4), life: rnd(1.4, 2.6), s0: 0.5 * size, s1: 1.9 * size, a0: 0.4, c0: [0.2, 0.18, 0.17], c1: [0.45, 0.44, 0.43], drag: 1.5, buoy: 0.35 });
  };
  /* lava meeting the sea: white steam billows */
  FX.steam = function (x, y, z, power) {
    // P31: a strong quench contact (power up to ~6) boils hard: more and bigger billows, fast-rising vapour jets
    const p = Math.min(6, power || 1), k = Math.round(2 + p * 1.6), sp = 0.6 + p * 0.25, sz = 1 + p * 0.15;
    for (let i = 0; i < k; i++) spawn(K_STEAM, x + rnd(-sp, sp), y + 0.1, z + rnd(-sp, sp), { vx: rnd(-0.3, 0.3), vy: rnd(0.6, 1.4) + p * 0.25, vz: rnd(-0.3, 0.3), life: rnd(1.6, 2.8) + p * 0.15, s0: 0.5 * sz, s1: rnd(2.2, 3.4) * sz, a0: 0.42 + p * 0.04, c0: [0.95, 0.95, 0.96], c1: [0.88, 0.89, 0.92], drag: 0.8, buoy: 0.4 });
    for (let i = 0; i < p - 1; i++) spawn(K_STEAM, x + rnd(-sp, sp), y + 0.05, z + rnd(-sp, sp), { vy: rnd(3, 5), life: rnd(0.5, 0.9), s0: 0.2, s1: 0.9, a0: 0.6, c0: [0.97, 0.97, 0.98], drag: 2.2 });
  };

  /* a chunk meets the real terrain (solid lattice, not only the column tops: it bounces off a wall, rolls down a slope, lies still where the ground is flat enough) */
  const cn = { x: 0, y: 1, z: 0 };
  function chunkHit(i, px, py, pz, dt) {
    const W = SS.world, x = P.x[i], y = P.y[i], z = P.z[i], r = P.s0[i] * 0.4;
    if (W.sample(x, y - r, z) <= 0) return;
    let hx = px, hy = py, hz = pz;
    if (W.sample(px, py - r, pz) > 0) {                                                                         // born inside the ground: stand on the nearest air above it (P70: not the column top, a cave roof is above)
      hx = x; hz = z; hy = y;
      for (let q = 0; q < 50 && W.sample(hx, hy - r, hz) > 0; q++) hy += 0.12;
      if (W.sample(hx, hy - r, hz) > 0) hy = W.top_at(x, z) + r + 0.01;
    }
    W.normal(x, y - r, z, cn);
    P.x[i] = hx; P.y[i] = hy; P.z[i] = hz;
    const vx = P.vx[i], vy = P.vy[i], vz = P.vz[i], vn = vx * cn.x + vy * cn.y + vz * cn.z;
    if (vn >= 0) return;
    const sp = -vn, e = 0.36, mu = 0.62;
    const tx = vx - vn * cn.x, ty = vy - vn * cn.y, tz = vz - vn * cn.z;
    P.vx[i] = tx * mu + cn.x * sp * e; P.vy[i] = ty * mu + cn.y * sp * e; P.vz[i] = tz * mu + cn.z * sp * e; P.spin[i] *= 0.6;
    if (sp < 2.0 || P.age[i] > 1.8) {
      if (cn.y > 0.62) { const gy = W.top_at(P.x[i], P.z[i]) + r; if (Math.abs(P.y[i] - gy) < 0.3) P.y[i] = gy; P.vx[i] = P.vy[i] = P.vz[i] = 0; P.grav[i] = 0; P.spin[i] = 0; if (P.life[i] - P.age[i] > 0.9) P.life[i] = P.age[i] + 0.9; }    // flat enough: lies still and fades
      else { P.vx[i] *= 0.9; P.vz[i] *= 0.9; P.vy[i] = Math.min(P.vy[i], 0.5); }                                                                   // too steep: keeps sliding down
    }
  }
  /* the blast impulse field for the grass: up to 4 recent blasts as (x, z, flatten radius, age in s) or (0, 0, 1, -1) when the slot is free */
  FX.blastField = function (arr) {
    for (let i = 0; i < 4; i++) { const b = blasts[blasts.length - 1 - i]; if (b) arr[i].set(b.x, b.z, b.R, b.t); else arr[i].set(0, 0, 1, -1); }
  };
  FX.shake = () => shake;
  FX.addShake = v => { shake = Math.min(1.2, shake + v); };           // P38 A5: small kicks (a bat hit, a bazooka shot)
  let nAdd = 0, nAlp = 0;
  const fv = { x: 0, y: 0, z: 0 }, celeb = { S: null };
  FX.field = null;                                                    // P118d: (x, y, z, out) -> out = the acceleration in m/s2 at a point (set by render/eowview.js in the End of the World); particles spawned with fld = 1 follow it
  FX.qn = () => QN;                                                   // the quality's share of the optional effect layers (counts scale with it)
  FX.update = function (dt) {
    own.uTime.value += dt; own.uSeaY.value = SS.world && SS.world.SEA != null && !SS.world.under ? SS.world.SEA : -99;
    for (let q = blasts.length - 1; q >= 0; q--) if ((blasts[q].t += dt) > 9) blasts.splice(q, 1);
    for (let q = later.length - 1; q >= 0; q--) if ((later[q].t -= dt) <= 0) { const L = later[q]; later.splice(q, 1); L.fn(); }
    let i = 0;
    while (i < n) {
      P.age[i] += dt;
      if (P.age[i] >= P.life[i]) {                         // swap-remove
        const j = --n;
        if (j !== i) for (const key of KEYS) { const a = P[key]; if (a.length === MAX * 3) { a[i * 3] = a[j * 3]; a[i * 3 + 1] = a[j * 3 + 1]; a[i * 3 + 2] = a[j * 3 + 2]; } else a[i] = a[j]; }
        continue;
      }
      const dr = Math.exp(-P.drag[i] * dt), kk = P.kind[i];
      if (kk >= K_SMOKE && kk <= K_STEAM && P.age[i] > 0.25) {           // the wind carries smoke, dust and steam along; it blows harder with height (shear: the column bends over, the cap runs ahead)
        const sh = 0.55 + 0.9 * Math.min(1.2, Math.max(0, P.y[i] - P.y0[i]) / 7), wk = (1 - Math.exp(-0.4 * dt)) * (kk === K_SMOKE ? 1 : 0.7);
        P.vx[i] += (FX.env.wx * 0.9 * sh - P.vx[i]) * wk; P.vz[i] += (FX.env.wz * 0.9 * sh - P.vz[i]) * wk; }
      const px = P.x[i], py = P.y[i], pz = P.z[i];
      P.vx[i] *= dr; P.vz[i] *= dr; P.vy[i] = P.vy[i] * dr + (P.buoy[i] - P.grav[i]) * dt;
      if (kk === K_CONF) {                                                   // P118d: a flake flutters (a side to side sway), drifts with the wind and stays within the section's front margin (render/section.js would cut it)
        const a = P.age[i] * 5.5 + P.seed[i], wk2 = 1 - Math.exp(-0.45 * dt);
        P.vx[i] += Math.sin(a) * 1.5 * dt + ((FX.env.wx || 0) * 0.9 - P.vx[i]) * wk2; P.vz[i] += Math.cos(a * 0.8) * 0.5 * dt + ((FX.env.wz || 0) * 0.9 - P.vz[i]) * wk2;
        if (celeb.S) { const S3 = celeb.S, N3 = SS.plane.nrm(S3), t3 = (P.x[i] - S3.O.x) * N3.x + (P.z[i] - S3.O.z) * N3.z; if (t3 > 0.35) { P.x[i] -= N3.x * (t3 - 0.35); P.z[i] -= N3.z * (t3 - 0.35); } }
      }
      if (P.fld[i] > 0 && FX.field) { FX.field(px, py, pz, fv); const fk = P.fld[i] * dt; P.vx[i] += fv.x * fk; P.vy[i] += fv.y * fk; P.vz[i] += fv.z * fk; }     // P118d: vacuum (End of the World): the summed gravity field of the pieces instead of -y
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt; P.rot[i] += P.spin[i] * dt;
      if (P.fld[i] > 0 && P.age[i] > 0.04 && SS.world && SS.world.sample && SS.world.sample(P.x[i], P.y[i], P.z[i]) > 0) {     // it reaches the rock: a spark goes out, a chunk or a glowing fragment lies still (the chunk fades, the fragment cools in place)
        if (kk === K_SPARK) P.age[i] = P.life[i];
        else { P.vx[i] = P.vy[i] = P.vz[i] = 0; P.fld[i] = 0; P.spin[i] = 0; if (kk === K_CHUNK && P.life[i] - P.age[i] > 1.3) P.life[i] = P.age[i] + 1.3; }
      }
      if (P.hug[i] > 0 && SS.world && SS.world.top_at) {                 // a dust skirt hugs the ground: climbs the rim, pours down a slope (a dense dust cloud is a gravity current), thickens as it ages
        const W = SS.world, x = P.x[i], z = P.z[i], gx = (W.top_at(x + 0.6, z) - W.top_at(x - 0.6, z)) / 1.2, gz = (W.top_at(x, z + 0.6) - W.top_at(x, z - 0.6)) / 1.2;
        P.vx[i] -= gx * 5 * dt; P.vz[i] -= gz * 5 * dt;
        const f = P.age[i] / P.life[i], ty = W.top_at(x, z) + P.hug[i] * (1 + 2.2 * f);
        P.y[i] += (ty - P.y[i]) * Math.min(1, 12 * dt); P.vy[i] = 0;
      }
      if (kk === K_CHUNK && P.trf[i] > 0 && n < CAP - 80 && (P.vx[i] * P.vx[i] + P.vy[i] * P.vy[i] + P.vz[i] * P.vz[i]) > 9) {        // P71: a big clod in flight drags a thin trail of its own dust
        if ((P.trl[i] -= dt) <= 0) { P.trl[i] = P.trf[i]; const c = P.c0[i * 3], c1 = P.c0[i * 3 + 1], c2 = P.c0[i * 3 + 2], sz = P.s0[i];
          spawn(K_DUST, P.x[i], P.y[i], P.z[i], { vx: P.vx[i] * 0.05, vy: 0.3, vz: P.vz[i] * 0.05, drag: 2, life: rnd(0.5, 0.8), s0: sz * 0.7, s1: sz * rnd(2.2, 3.2), c0: [c * 1.25 + 0.08, c1 * 1.25 + 0.07, c2 * 1.25 + 0.06], a0: 0.3 }); }
      }
      if (kk === K_CHUNK && SS.world && SS.world.sample && P.grav[i] > 0) chunkHit(i, px, py, pz, dt);
      if (kk === K_DROP && P.vy[i] < 0 && P.y[i] < P.y0[i] - 0.02 && P.age[i] > 0.04) {        // P87: a falling droplet reaches the water: a tiny rebound of fines (the big ones only) and it is gone
        if (P.s0[i] > 0.04 && n < CAP - 12 && Math.random() < 0.55) for (let m = 0, nm = 2 + (Math.random() * 2 | 0); m < nm; m++) { const a = rnd(0, 6.283), sp = rnd(0.3, 1.1);
          spawn(K_DROP, P.x[i], P.y0[i] + 0.01, P.z[i], { vx: Math.cos(a) * sp, vy: rnd(0.9, 2.1), vz: Math.sin(a) * sp, life: 0.6, s0: 0.018, s1: 0.018, c0: [P.c0[i * 3], P.c0[i * 3 + 1], P.c0[i * 3 + 2]], grav: 9.8, a0: 0.7 }); }
        P.age[i] = P.life[i];
      }
      i++;
    }
    nAdd = 0; nAlp = 0;
    for (let k = 0; k < n; k++) {
      const hot = ADDITIVE(P.kind[k]), s = hot ? add : alp, q = hot ? nAdd++ : nAlp++;
      const f = P.age[k] / P.life[k], sz = P.s0[k] + (P.s1[k] - P.s0[k]) * (1 - (1 - f) * (1 - f));
      const ip = s.iPos.array, ia = s.iA.array, ic = s.iC.array;
      ip[q * 4] = P.x[k]; ip[q * 4 + 1] = P.y[k]; ip[q * 4 + 2] = P.z[k]; ip[q * 4 + 3] = sz;
      if (P.kind[k] === K_SPARK || P.kind[k] === K_DROP || P.kind[k] === K_GLINT) { const iv = s.iV.array; iv[q * 3] = P.vx[k]; iv[q * 3 + 1] = P.vy[k]; iv[q * 3 + 2] = P.vz[k]; }
      ia[q * 4] = P.rot[k]; ia[q * 4 + 1] = f; ia[q * 4 + 2] = P.kind[k] + (P.kind[k] === K_CHUNK ? 0.4 * P.ang[k] : 0); ia[q * 4 + 3] = P.seed[k];
      if (hot && P.kind[k] >= K_FLASH) for (let c = 0; c < 3; c++) ic[q * 3 + c] = P.c0[k * 3 + c] + (P.c1[k * 3 + c] - P.c0[k * 3 + c]) * f;
      else if (hot) { ic[q * 3] = P.c0[k * 3]; ic[q * 3 + 1] = P.c0[k * 3 + 1]; ic[q * 3 + 2] = 0; }
      else for (let c = 0; c < 3; c++) ic[q * 3 + c] = P.c0[k * 3 + c] + (P.c1[k * 3 + c] - P.c0[k * 3 + c]) * f;
      s.iAl.array[q] = P.a0[k] * (hot ? (1 - f) : P.kind[k] === K_CHUNK || P.kind[k] === K_CONF ? Math.min(1, f * 20) * Math.min(1, (1 - f) * 6) : P.kind[k] === K_DROP ? Math.min(1, f * 30) * Math.min(1, (1 - f) * 8) : Math.min(1, f * 6) * (1 - f) * (1 - f));
    }
    for (const [s, c] of [[add, nAdd], [alp, nAlp]]) {
      s.g.instanceCount = c; s.mesh.visible = c > 0;
      if (c) { s.iPos.needsUpdate = true; s.iA.needsUpdate = true; s.iC.needsUpdate = true; s.iAl.needsUpdate = true; s.iV.needsUpdate = true; }
    }
    flashT += dt; flash.intensity = flashT < 0.4 ? flash.intensity * Math.exp(-dt * flashK) : 0;
    glowT += dt; own.uGlow.value.w = glowI * Math.exp(-glowT * 3.2) * (glowT < 2 ? 1 : 0);
    shake = Math.max(0, shake - dt * 2.2);
  };
  /* P118d (Q-25): the win celebration. render/cine.js tick() starts it once when the match is over; presentation only (Math.random is fine). Confetti cannons at the surviving winners
   * (the team's colours, a pale tint, white, gold) and a few firework shells that burst a few metres above them, on a timeline of view seconds; it stops spawning as soon as the
   * player skips (cine.celebrating()). Everything stays in the section plane's picture (the confetti is held in the plane's front margin, the bursts are drawn in the plane).
   * Contexts: in the End of the World there is no air (flakes would neither fall slowly nor flutter): no confetti, the bursts are free spherical shells (no drag, no gravity);
   * in a cave there is no sky: confetti only; elsewhere both. Night and dusk: the bursts light the land (the shared point light). */
  FX.celebrate = function (S, team) {
    if (!S || team == null || team < 0 || !flash) return;
    celeb.S = S;
    const rgb = hex(SS.sim.team_rgb(S, team)), W = SS.world, vac = !!(W && W.eow), cave = !!(W && W.under), cin = SS.cine, tod = SS.view && SS.view.state && SS.view.state.tod || FX.env.tod;      // (view.tod, not FX.env.tod: that is only refreshed by a blast)
    const gold = [1.0, 0.72, 0.18], white = [1, 1, 1], dirv = SS.plane.dir(S), nrm = SS.plane.nrm(S), cnt = v => Math.max(1, Math.round(v * QN));
    const going = () => !cin || !cin.celebrating || cin.celebrating();
    const winners = () => S.worms.filter(w => !w.dead && w.hp > 0 && w.team === team);
    const pickC = () => { const r = Math.random(); return r < 0.6 ? rgb.map(v => Math.min(1, v * rnd(0.8, 1.2))) : r < 0.8 ? rgb.map(v => v * 0.45 + 0.55) : r < 0.92 ? white : gold; };
    function cannon(w, n) {                                                                  // confetti thrown up and out of a worm: it slows at once (drag) and flutters down at ~1 m/s
      for (let i = 0, k = cnt(n); i < k; i++) {
        const a = rnd(-1.05, 1.05), sp = rnd(5.5, 12.5), up = Math.cos(a) * sp * rnd(0.75, 1.1) + 2.5, side = Math.sin(a) * sp, nz = rnd(-0.35, 0.1) * sp * 0.3;
        spawn(K_CONF, w.pos.x, w.pos.y + 0.55, w.pos.z, { vx: dirv.x * side + nrm.x * nz, vy: up, vz: dirv.z * side + nrm.z * nz, drag: 2.0, grav: 2.2, life: rnd(4.2, 6.2), s0: 0.24, s1: 0.24, c0: pickC(), a0: 1, spin: rnd(-5, 5) });
      }
    }
    function burst(x, y, z, kind) {                                                          // a firework: coloured streaks on a sphere (peony), a ring facing the camera, or a slow golden willow
      const gold1 = kind === 'willow', hot = gold1 ? [3.4, 2.4, 0.9] : rgb.map(v => v * 2.4 + 0.35), cool = gold1 ? [1.6, 0.8, 0.12] : rgb.map(v => v * 1.7);
      const n = cnt(kind === 'ring' ? 38 : kind === 'willow' ? 46 : 72), v0 = (kind === 'willow' ? 5.5 : 9) * (vac ? 1.15 : 1);
      for (let i = 0; i < n; i++) {
        let dx, dy, dz;
        if (kind === 'ring') { const a = i / n * 6.2832; dx = dirv.x * Math.cos(a); dy = Math.sin(a); dz = dirv.z * Math.cos(a); }
        else { const yy = 1 - 2 * (i + 0.5) / n, r = Math.sqrt(1 - yy * yy), ph = i * 2.39996; dx = dirv.x * r * Math.cos(ph) + nrm.x * r * Math.sin(ph) * 0.6; dy = yy; dz = dirv.z * r * Math.cos(ph) + nrm.z * r * Math.sin(ph) * 0.6; }
        const v = v0 * rnd(0.82, 1.1);
        spawn(K_GLINT, x, y, z, { vx: dx * v, vy: dy * v, vz: dz * v, drag: vac ? 0 : (gold1 ? 1.1 : 1.7), grav: vac ? 0 : (gold1 ? 4.2 : 2.6), life: gold1 ? rnd(1.9, 2.7) : rnd(1.1, 1.7), s0: 0.2, s1: 0.1, c0: hot, c1: cool, a0: 1 });
      }
      flash.color.setRGB(gold1 ? 1 : 0.5 + 0.5 * rgb[0], gold1 ? 0.8 : 0.5 + 0.5 * rgb[1], gold1 ? 0.3 : 0.5 + 0.5 * rgb[2]); flash.position.set(x, y, z); flash.distance = 20;
      flash.intensity = (tod === 'night' ? 70 : tod === 'dusk' ? 45 : 22); flashK = 6; flashT = 0;
    }
    function shell(kind) {                                                                  // a rising streak, then the burst at its tip
      const ws = winners(); if (!ws.length || cave) return;
      const up = vac && ws[0].eup ? ws[0].eup : { x: 0, y: 1, z: 0 };                       // (the local up: in space a shell leaves along the surface normal of the winner's piece, not along the world's +y)
      let cx = 0, cy = vac ? 0 : -1e9, cz = 0; for (const w of ws) { cx += w.pos.x / ws.length; cz += w.pos.z / ws.length; cy = vac ? cy + w.pos.y / ws.length : Math.max(cy, w.pos.y); }
      const off = rnd(-1, 1) * (2.5 + 1.2 * ws.length), sx = cx + dirv.x * off - nrm.x * 0.3 + up.x * 0.4, sz = cz + dirv.z * off - nrm.z * 0.3 + up.z * 0.4, sy = cy + up.y * 0.4, rise = rnd(9, 10.5), tr = 0.5, g = vac ? 0 : 4;
      spawn(K_SPARK, sx, sy, sz, { vx: up.x * rise, vy: up.y * rise, vz: up.z * rise, life: tr, s0: 0.16, s1: 0.1, c0: [3000, 1500, 0], grav: g, drag: 0.05 });
      const bx = sx + up.x * rise * tr, bz = sz + up.z * rise * tr, by = sy + up.y * rise * tr - 0.5 * g * tr * tr;
      later.push({ t: tr, fn: () => { if (going()) burst(bx, by, bz, kind); } });
    }
    const TL = [[0.15, 'c', 44], [0.2, 's', 'peony'], [0.9, 's', 'ring'], [1.4, 'c', 34], [1.9, 's', 'peony'], [2.6, 'c', 30], [2.7, 's', 'willow'], [3.4, 's', 'peony'], [4.0, 'c', 24]];
    for (const [t, k, a] of TL) later.push({ t, fn: () => {
      if (!going()) return;
      if (k === 'c') { const ws = winners(), per = Math.max(10, Math.round(a * 2 / (ws.length + 1))); if (!vac) for (const w of ws) cannon(w, per); }
      else shell(a);
    } });
  };
  FX.cliffSoft = on => { own.uCliff.value = on ? 1 : 0; };
  FX.uniforms = own;                                                                    // the light uniforms the effects share (sun, sky, ground): the smoke ribbon of render/trails.js reads them too
  FX.stats = () => ({ n, add: nAdd, alpha: nAlp });
})(window.SS = window.SS || {});
