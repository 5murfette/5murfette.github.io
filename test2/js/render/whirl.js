/* Whirlwind view (P65a): what the player sees of S.wind.whirls (sim/weather.js, life cycle FORMING -> MATURE -> DECAYING).
 * Render-only (may use Math.random). Three procedural layers, all quality gated, one draw call each:
 *   1. funnel   — a tube (20 x 16 grid per whirl) along the sim axis (lean with the wind + a snaking sine, the SAME formula as
 *                 WE.whirl_axis), radius widening with height, its bottom ring hugging the terrain (y = ground under each vertex
 *                 blended to the straight column over the first 1.6 m); the fragment shader advects 3-D value noise around the
 *                 axis (spiral streaks rising with the updraft), soft limb, fades with the sim envelope.
 *   2. pall     — a polar sheet (48 rings x 48 around) laid on the terrain: every vertex samples the height map, so the base debris
 *                 skirt flares along the slope (height (1 - R/Rs)^2.2: a bell, not a flat disc); swirling noise density. During the
 *                 disband the same sheet carries the outgoing gust ring (radius rb = 1.5 rc0 + BURST_V bt, width as the sim).
 *   3. strokes  — instanced ribbons: column strokes spiralling up (leaves as tumbling cards), a low skirt of strokes whose every
 *                 vertex is conformed to the ground, and radial burst strokes that fly outward over the terrain when it disbands.
 * Colour by place: biome dust, snow white on snow cover, ash grey on ash cover. Budget <= 0.5 ms on high (CPU: 4 x 6 uniforms per frame).
 * P111 (user 2026-10-12: "they should be barely visible, instead they look like smoke tornadoes"): a dust devil is clear air: the
 * funnel is a faint dust hint (alpha x ~0.1), the pall a low skirt (no bell), the strokes fewer and half as opaque.
 * Porting: a particle system + two terrain-draped meshes sampling the height field; the fields in uWA.. are the whirl struct. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const WV = SS.whirlView = {};
  const MAXW = 4, WSEG = 8;
  let scene, parts = null, strokes, funnel, pall, wn = 0, nW = 0, lastMs = 0;
  const DUST = { temperate: [0.55, 0.47, 0.36], alpine: [0.7, 0.7, 0.72], canyon: [0.78, 0.52, 0.36], desert: [0.86, 0.7, 0.5], volcanic: [0.24, 0.22, 0.21] };
  const LEAVES = { temperate: 0.3, canyon: 0.08 };

  const OUT = /* glsl */`
    #include <tonemapping_fragment>
    #include <colorspace_fragment>`;
  /* shared prelude: uniforms of the four whirl slots, the height map, noise, the axis */
  const PRE = /* glsl */`
    uniform sampler2D tHeight;
    uniform vec4 uWA[4], uWB[4], uWC[4], uWD[4], uWE[4], uWF[4], uWG[4];   // G: x = swirl phase (integral of vmax / rc dt), y = rise phase (integral of up / h dt)  [P87: every time * rate product is an integral, so a changing rate never jumps the pattern]
       // A: x, z, rc, env; B: h, sign, vmax, rise m/s; C: dust rgb, leaf share; D: lean x, lean z, snake, age; E: perp x, perp z, ph2, grow; F: burst t, burst frac, state, rc0
    uniform float uTime, uPix, uFogD, uLit, uQ;
    float h1(float n){ return fract(sin(n) * 43758.5453); }
    float topAt(vec2 xz){ return texture2D(tHeight, (xz * 2.0 + 0.5) / float(textureSize(tHeight, 0).x)).r * 40.0; }   // view.js heightTex: top / 40
    vec3 side(vec3 ax, vec3 toC){ vec3 s = cross(ax, toC); float l = length(s); return l > 1e-4 ? s / l : vec3(1.0, 0.0, 0.0); }
    void hide(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }
    vec2 axisXZ(int i, float hh){                                  // = WE.whirl_axis: the lean (m per m) and the snake (a sine along the column)
      vec4 A = uWA[i], B = uWB[i], D = uWD[i], E = uWE[i];
      float k = min(1.0, hh / max(B.x, 1.0));
      float sn = D.z * k * sin(hh * 0.45 - D.w * 1.4 + E.z);
      return A.xy + D.xy * hh + E.xy * sn;
    }
    float gClamp(vec2 xz, float g0){ return min(topAt(xz), g0 + 2.5); }                // dust does not climb a cliff wall: the ground it hugs is capped 2.5 m above the whirl's base
    float burstB(int i){ return uWF[i].y * smoothstep(0.0, 0.25, uWF[i].x + 0.001); }
    float ringR(int i){ return uWF[i].w * 1.5 + 6.0 * uWF[i].x; }
    float ringW(int i){ return uWF[i].w + 1.5 + 0.8 * uWF[i].x; }`;
  const NOISE = /* glsl */`
    float vh(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
    float vn(vec3 p){
      vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(vh(i), vh(i + vec3(1,0,0)), f.x), mix(vh(i + vec3(0,1,0)), vh(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(vh(i + vec3(0,0,1)), vh(i + vec3(1,0,1)), f.x), mix(vh(i + vec3(0,1,1)), vh(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p, float q){ float s = 0.55 * vn(p) + 0.3 * vn(p * 2.03 + 3.1); if (q > 0.5) s += 0.15 * vn(p * 4.1 + 7.3); else s += 0.075; return s; }`;

  /* ---------- 1. funnel ---------- */
  const FN_V = /* glsl */`
    attribute float wi;
    ${PRE}
    varying float vA; varying float vH; varying vec3 vN; varying vec3 vV; varying vec3 vCol; varying float vAng; varying float vSg; varying float vRise; varying float vOm; varying vec2 vPh;
    void main(){
      int i = int(wi + 0.5);
      vec4 A = uWA[i], B = uWB[i], Cc = uWC[i], E = uWE[i];
      if (A.w < 0.01) { hide(); vA = 0.0; return; }
      float v = position.y, a = position.x * 6.2832;
      float hh = v * B.x;
      float rad = A.z * (0.55 + 0.3 * v + 0.9 * pow(v, 2.2)) * (1.0 + 0.1 * sin(v * 9.0 - uTime * 1.7 + E.z));
      vec2 ax = axisXZ(i, hh);
      vec2 xz = ax + rad * vec2(cos(a), sin(a));
      float gnd = topAt(A.xy), yg = topAt(xz) + 0.04;
      float y = max(mix(yg, gnd + hh, smoothstep(0.0, 1.6, hh)), yg);
      vec3 p = vec3(xz.x, y, xz.y);
      vec3 toC = cameraPosition - p; float d = length(toC);
      vN = vec3(cos(a), 0.0, sin(a)); vV = toC / max(d, 1e-3);
      vH = v; vAng = a; vSg = B.y; vOm = B.z / max(A.z * 1.1, 0.3) * 0.8; vRise = B.w / max(B.x, 2.0); vPh = uWG[i].xy;
      vCol = Cc.rgb * uLit;
      float fade = smoothstep(0.0, 0.1, v) * (1.0 - smoothstep(0.7, 1.0, v));
      vA = A.w * fade * exp(-uFogD * uFogD * d * d) * smoothstep(0.4, 2.5, d);
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`;
  const FN_F = /* glsl */`
    ${NOISE}
    uniform float uTime; uniform float uQ;
    varying float vA; varying float vH; varying vec3 vN; varying vec3 vV; varying vec3 vCol; varying float vAng; varying float vSg; varying float vRise; varying float vOm; varying vec2 vPh;
    void main(){
      float ang = vAng + vSg * (vPh.x * 0.727 * 0.6 - vH * 2.2);
      vec3 p = vec3(cos(ang) * 1.7, sin(ang) * 1.7, vH * 4.5 - vPh.y * 9.0);
      float n = fbm(p, step(0.85, uQ));
      float band = 0.5 + 0.5 * sin(vAng * 2.0 + vSg * (vH * 8.0 - vPh.x * 0.727 * 0.35) + 6.0 * n);          // spiral streaks that rotate with the funnel
      float limb = abs(dot(normalize(vN), normalize(vV)));
      float ero = 1.0 - limb;                                                                              // the limb erodes: a ragged outline, not a smooth cone
      float dens = smoothstep(0.3 + 0.35 * ero, 0.72 + 0.2 * ero, n * 0.7 + 0.3 * band);
      float a = vA * 0.11 * dens * (0.35 + 0.65 * smoothstep(0.0, 0.5, limb)) * (1.0 - 0.75 * smoothstep(0.0, 0.6, vH));   // P111: clear air; only a faint dust hint, thinning with height
      if (a < 0.003) discard;
      vec3 col = vCol * (0.4 + 0.3 * (1.0 - dens) + 0.3 * band + 0.25 * vH);
      gl_FragColor = vec4(col, a);
      ${OUT}
    }`;
  function funnelGeo() {
    const NA = 20, NV = 16, g = new T.InstancedBufferGeometry(), P = [], I = [];
    for (let k = 0; k <= NV; k++) for (let a = 0; a <= NA; a++) P.push(a / NA, k / NV, 0);
    for (let k = 0; k < NV; k++) for (let a = 0; a < NA; a++) { const v = k * (NA + 1) + a; I.push(v, v + 1, v + NA + 2, v, v + NA + 2, v + NA + 1); }
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(P), 3)); g.setIndex(I);
    g.setAttribute('wi', new T.InstancedBufferAttribute(new Float32Array([0, 1, 2, 3]), 1));
    g.instanceCount = 0; return g;
  }

  /* ---------- 2. pall: the terrain-draped skirt + gust ring ---------- */
  const PL_V = /* glsl */`
    attribute float wi;
    ${PRE}
    varying float vA; varying vec2 vQ; varying vec3 vCol; varying float vRho; varying float vSg;
    void main(){
      int i = int(wi + 0.5);
      vec4 A = uWA[i], B = uWB[i], Cc = uWC[i], F = uWF[i];
      float bB = burstB(i);
      if (A.w < 0.01 && bB < 0.02) { hide(); vA = 0.0; return; }
      float rho = position.x, a = position.y * 6.2832;
      float Rs = A.z * 3.4 * (0.55 + 0.45 * A.w);                      // skirt radius
      float rb = ringR(i), ww = ringW(i);
      float Rmax = bB > 0.02 ? max(Rs, rb + 2.2 * ww) : Rs;
      float R = A.z * 0.45 + (Rmax - A.z * 0.45) * rho;
      vec2 xz = uWA[i].xy + R * vec2(cos(a), sin(a));
      float rp = clamp(R / Rs, 0.0, 1.0);
      float flare = (0.25 + 0.15 * A.z) * pow(1.0 - rp, 1.7) * A.w;   // P111: a low dust skirt hugging the ground (it was a tall bell)
      float ring = exp(-pow((R - rb) / ww, 2.0)) * bB;
      float y = gClamp(xz, topAt(A.xy)) + 0.2 + flare + ring * (0.35 + 0.12 * ww);
      vec3 p = vec3(xz.x, y, xz.y);
      vec3 toC = cameraPosition - p; float d = length(toC);
      float dens = A.w * pow(1.0 - rp, 1.1) * smoothstep(0.0, 0.12, rp + 0.12) + ring * 1.3;
      vA = min(dens, 1.0) * exp(-uFogD * uFogD * d * d) * smoothstep(0.4, 2.5, d);
      vCol = Cc.rgb * uLit;
      vSg = B.y; vRho = R;
      float th = B.y * 0.9 * uWG[i].x / (1.0 + 0.5 * R);
      vQ = mat2(cos(th), sin(th), -sin(th), cos(th)) * (R * vec2(cos(a), sin(a)));
      gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    }`;
  const PL_F = /* glsl */`
    ${NOISE}
    uniform float uTime;
    varying float vA; varying vec2 vQ; varying vec3 vCol; varying float vRho; varying float vSg;
    void main(){
      float n = fbm(vec3(vQ * 0.8, uTime * 0.35 + vRho * 0.15), 0.0);
      float a = vA * 0.22 * smoothstep(0.15, 0.62, n);
      if (a < 0.004) discard;
      gl_FragColor = vec4(vCol * (0.8 + 0.4 * n), a);
      ${OUT}
    }`;
  function pallGeo() {
    const NR = 40, NA = 48, g = new T.InstancedBufferGeometry(), P = [], I = [];
    for (let r = 0; r <= NR; r++) for (let a = 0; a <= NA; a++) P.push(r / NR, a / NA, 0);
    for (let r = 0; r < NR; r++) for (let a = 0; a < NA; a++) { const v = r * (NA + 1) + a; I.push(v, v + 1, v + NA + 2, v, v + NA + 2, v + NA + 1); }
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(P), 3)); g.setIndex(I);
    g.setAttribute('wi', new T.InstancedBufferAttribute(new Float32Array([0, 1, 2, 3]), 1));
    g.instanceCount = 0; return g;
  }

  /* ---------- 3. strokes: column, skirt, burst ---------- */
  const ST_V = /* glsl */`
    attribute vec4 seed; attribute float wi;
    ${PRE}
    varying vec2 vUv; varying float vA; varying vec3 vCol; varying float vLeaf;
    void main(){
      int i = int(wi + 0.5);
      vec4 A = uWA[i], B = uWB[i], Cc = uWC[i], F = uWF[i];
      float z = seed.z;
      bool isSkirt = z < 0.24, isBurst = z >= 0.24 && z < 0.4;
      float bB = burstB(i);
      vLeaf = (isSkirt || isBurst) ? 0.0 : step(1.0 - Cc.w, seed.w);
      if ((isBurst && bB < 0.03) || (!isBurst && A.w < 0.01)) { hide(); vA = 0.0; vUv = vec2(0.0); vCol = vec3(0.0); return; }
      float u = position.y, hgt = max(B.x, 2.0);
      float sg = B.y;
      float kS = 0.8 + 0.6 * h1(seed.x * 13.0);
      float om = B.z / max(A.z * kS, 0.3) * sg * 0.8, omP = uWG[i].x * sg * 0.8 / kS;   // om: the rate (direction, lead); omP: the same rate as an integrated phase (angle = omP, never om * uTime)
      vec3 p, q, tg;
      float s, a;
      if (isBurst) {
        // outward over the terrain, in all directions: the particle decelerates, its stroke trails back toward the axis
        float ang = seed.y * 6.2832, tau = 1.6, bt = F.x;
        float vk = 0.6 + 0.7 * seed.w;
        float dist = F.w * (1.0 + seed.x) + 6.0 * tau * (1.0 - exp(-bt / tau)) * vk;
        vec2 rd = vec2(cos(ang), sin(ang));
        float Ls = (0.8 + 2.2 * exp(-bt / 1.2)) * (0.6 + 0.8 * seed.x) * (1.0 + 2.5 * (1.0 - smoothstep(0.0, 2.5, bt)));
        vec2 xz = A.xy + rd * (dist - Ls * u);
        float lift = 0.12 + (0.15 + 0.9 * seed.x) * (1.0 - exp(-bt * 0.9));
        q = vec3(xz.x, gClamp(xz, topAt(A.xy)) + 0.1 + lift, xz.y);
        tg = vec3(rd.x, 0.0, rd.y);
        s = (0.35 + 0.7 * seed.y) * (0.6 + 0.5 * smoothstep(0.0, 2.5, bt));
        a = bB * 0.2 * (1.0 - smoothstep(2.0, 4.5, bt));
        p = q;
      } else if (isSkirt) {
        float rr = A.z * (0.7 + 2.9 * pow(seed.y, 1.2)) * (0.55 + 0.45 * A.w);
        float rot = om / (1.0 + 0.8 * rr / max(A.z, 0.3));
        float ang = seed.x * 6.2832 + omP / (1.0 + 0.8 * (0.7 + 2.9 * pow(seed.y, 1.2)));
        float Ls = 1.6 * (1.0 + 0.8 * rr / max(A.z, 0.3));
        float dth = min(Ls / max(rr, 0.15), 2.4);
        float au = ang - (rot < 0.0 ? -1.0 : 1.0) * dth * u;
        vec2 xz = A.xy + rr * vec2(cos(au), sin(au));
        float fl = (0.5 + 0.4 * A.z) * pow(max(0.0, 1.0 - rr / (A.z * 3.6)), 2.0);
        q = vec3(xz.x, gClamp(xz, topAt(A.xy)) + 0.15 + fl * (0.3 + 0.7 * seed.w), xz.y);
        tg = vec3(-sin(au), 0.0, cos(au)) * (rot < 0.0 ? -1.0 : 1.0);
        s = 0.45 + 0.4 * seed.w;
        a = A.w * 0.16;
        p = vec3(A.x + rr * cos(ang), q.y, A.y + rr * sin(ang));
      } else {
        float rise = B.w / hgt * (0.6 + 0.8 * seed.y);
        float f = fract(seed.x + uWG[i].y * (0.6 + 0.8 * seed.y));
        float hh = f * hgt;
        float rr = A.z * (0.4 + 1.25 * pow(f, 1.4)) * (0.7 + 0.6 * h1(seed.w * 71.0));
        float ang = seed.y * 6.2832 + omP;
        float dth = 0.0;
        float sd = sg;
        s = mix(0.35, 0.9, f);
        float Ls = s * (5.0 + 4.0 * clamp(rr / max(A.z, 0.2), 0.0, 3.0));
        dth = min(Ls / max(rr, 0.15), 2.6);
        float au = ang - sd * dth * u * (vLeaf > 0.5 ? 0.0 : 1.0);
        float hu = hh - min(rise * hgt / max(abs(om), 0.2), 3.0) * dth * u * (vLeaf > 0.5 ? 0.0 : 1.0);
        hu = max(hu, 0.0);
        vec2 ax = axisXZ(i, hu), xz = ax + rr * vec2(cos(au), sin(au));
        float gnd = topAt(A.xy), yg = gClamp(xz, gnd) + 0.1;
        q = vec3(xz.x, max(mix(yg, gnd + hu, smoothstep(0.0, 1.6, hu)), yg), xz.y);
        tg = normalize(vec3(-sin(au), 0.0, cos(au)) * sd * rr + vec3(0.0, rise * hgt / max(abs(om), 0.2), 0.0));
        p = q;
        a = A.w * smoothstep(0.0, 0.1, f) * (1.0 - smoothstep(0.55, 1.0, f)) * (vLeaf > 0.5 ? 1.0 : 0.2);
        if (vLeaf > 0.5) { s = 0.08; a = A.w * smoothstep(0.0, 0.1, f) * (1.0 - smoothstep(0.55, 1.0, f)); }
      }
      vec3 toC = cameraPosition - p; float d = length(toC);
      s = max(s, uPix * d * 1.5);
      a *= exp(-uFogD * uFogD * d * d) * smoothstep(0.5, 2.0, d);
      vCol = (vLeaf > 0.5 ? mix(vec3(0.2, 0.24, 0.07), vec3(0.42, 0.27, 0.09), h1(seed.y * 9.1)) : Cc.rgb * (0.85 + 0.3 * h1(seed.z * 5.0))) * uLit;
      if (vLeaf > 0.5) {
        vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        vec2 c = vec2(position.x, position.y - 0.5);
        float ra = seed.w * 40.0 + uTime * (3.0 + 5.0 * seed.y);
        c = mat2(cos(ra), sin(ra), -sin(ra), cos(ra)) * c;
        vUv = vec2(position.x * 2.0, position.y * 2.0 - 1.0); vA = a;
        gl_Position = projectionMatrix * viewMatrix * vec4(p + (R * c.x + U * c.y) * s, 1.0);
        return;
      }
      float wk = 0.5 + 0.5 * sin(uTime * (0.08 + 0.12 * seed.z) + seed.w * 31.0) * sin(uTime * (0.11 + 0.19 * seed.y) + seed.x * 17.0 + 1.3);
      a *= (isBurst ? 1.0 : smoothstep(0.0, 1.0, wk) * 1.8);
      vec3 sdv = side(tg, normalize(cameraPosition - q));
      float wdt = s * 1.0 * (1.0 - 0.5 * u);
      vUv = vec2(position.x * 2.0, u); vA = a;
      gl_Position = projectionMatrix * viewMatrix * vec4(q + sdv * position.x * wdt, 1.0);
    }`;
  const ST_F = /* glsl */`
    varying vec2 vUv; varying float vA; varying vec3 vCol; varying float vLeaf;
    void main(){
      float a = vLeaf > 0.5 ? (1.0 - smoothstep(0.8, 1.0, length(vec2(vUv.x, vUv.y * 2.2))))
                            : exp(-vUv.x * vUv.x * 2.5) * smoothstep(0.0, 0.15, vUv.y + 0.05) * pow(max(1.0 - vUv.y, 0.0), 1.3);
      a *= vA * 0.5;
      if (a < 0.003) discard;
      gl_FragColor = vec4(vCol, a);
      ${OUT}
    }`;
  function stripGeo(n) {
    const g = new T.InstancedBufferGeometry(), P = [], I = [];
    for (let k = 0; k <= WSEG; k++) P.push(-0.5, k / WSEG, 0, 0.5, k / WSEG, 0);
    for (let k = 0; k < WSEG; k++) { const v = k * 2; I.push(v, v + 1, v + 3, v, v + 3, v + 2); }
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(P), 3)); g.setIndex(I);
    const sd = new Float32Array(n * 4); for (let i = 0; i < sd.length; i++) sd[i] = Math.random();
    g.setAttribute('seed', new T.InstancedBufferAttribute(sd, 4));
    const a = new Float32Array(n), per = n / MAXW; for (let i = 0; i < n; i++) a[i] = Math.floor(i / per);
    g.setAttribute('wi', new T.InstancedBufferAttribute(a, 1));
    g.instanceCount = 0; return g;
  }

  function uniforms() {
    const v4 = () => [0, 1, 2, 3].map(() => new T.Vector4());
    return { tHeight: { value: null }, uWA: { value: v4() }, uWB: { value: v4() }, uWC: { value: v4() }, uWD: { value: v4() }, uWE: { value: v4() }, uWF: { value: v4() }, uWG: { value: v4() },
      uTime: { value: 0 }, uPix: { value: 0.001 }, uFogD: { value: 0.006 }, uLit: { value: 1 }, uQ: { value: 1 } };
  }
  const shared = uniforms();
  function mat(vs, fs) {
    return new T.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, transparent: true, depthWrite: false, side: T.DoubleSide, uniforms: shared });
  }
  function mk(g, m, order) { const o = new T.Mesh(g, m); o.frustumCulled = false; o.renderOrder = order; o.visible = false; scene.add(o); return o; }

  WV.init = function (sc, Q, P) {
    scene = sc; parts = P || null;
    const q = Q.particles || 1;
    wn = Math.round(300 * q);                                         // P111: fewer strokes (barely visible air)
    strokes = mk(stripGeo(wn * MAXW), mat(ST_V, ST_F), 6);
    funnel = mk(funnelGeo(), mat(FN_V, FN_F), 6);
    pall = mk(pallGeo(), mat(PL_V, PL_F), 5);
    shared.uQ.value = q;
    funnel.userData.minQ = 0.5;
  };
  const held = [null, null, null, null], pW = [0, 0, 0, 0], pR = [0, 0, 0, 0], sW = [0, 0, 0, 0], sR = [0, 0, 0, 0], sL = [0, 1, 2, 3].map(() => [0, 0, 1, 0]), fresh = [1, 1, 1, 1];
  let lastT = -1;                    // P70: the whirl object in each uniform slot (MAXW)
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  /* per frame: pack the sim whirls into the uniform slots */
  WV.frame = function (S, wind, we, biome, ctx) {
    const t0 = performance.now(), wl = (wind && wind.whirls) || [], K = SS.CFG.WIND.WHIRL, N1 = SS.world.NX;
    nW = 0;
    let fdt = lastT < 0 ? 0 : Math.min(0.1, Math.max(0, ctx.time - lastT)); lastT = ctx.time;    // P87: dt of the render clock (slow-mo aware) for the phase integrals
    for (let i = 0; i < MAXW; i++) if (held[i] && wl.indexOf(held[i]) < 0) { held[i] = null; fresh[i] = 1; }                // P70: a whirl keeps its slot (its stroke seeds) while it lives, whichever whirls died before it
    for (let q = 0; q < wl.length; q++) if (held.indexOf(wl[q]) < 0) { const f = held.indexOf(null); if (f >= 0) { held[f] = wl[q]; fresh[f] = 1; } }
    for (let i = 0; i < MAXW; i++) {
      const w = held[i], A = shared.uWA.value[i], B = shared.uWB.value[i], Cc = shared.uWC.value[i], D = shared.uWD.value[i], E = shared.uWE.value[i], F = shared.uWF.value[i];
      const bf = w ? Math.min(1.1, w.bst / (K.BURST_K * w.vmax)) : 0;
      if (!w || !(w.env > 0.01 || bf > 0.03)) { A.w = 0; F.y = 0; continue; }
      nW = i + 1;
      A.set(w.x, w.z, w.rc, w.env); B.set(w.h, w.sign, w.vmax, w.up);
      // P87: phases = integrals of the (low-passed) rates; the lean / snake direction eases (a new turn's wind flips it at once in the sim)
      const kk = fresh[i] ? 1 : 1 - Math.exp(-fdt / 0.35), kl = fresh[i] ? 1 : 1 - Math.exp(-fdt / 1.5);
      if (fresh[i]) { pW[i] = 0; pR[i] = 0; fresh[i] = 0; }
      sW[i] += (w.vmax / Math.max(w.rc, 0.3) - sW[i]) * kk; sR[i] += (w.up / Math.max(w.h, 2) - sR[i]) * kk;
      pW[i] += sW[i] * fdt; pR[i] += sR[i] * fdt;
      const L = sL[i]; L[0] += (w.lx - L[0]) * kl; L[1] += (w.lz - L[1]) * kl; L[2] += (w.px - L[2]) * kl; L[3] += (w.pz - L[3]) * kl;
      const pl = Math.hypot(L[2], L[3]) || 1;
      shared.uWG.value[i].set(pW[i], pR[i], 0, 0);
      D.set(L[0], L[1], w.sa, w.age); E.set(L[2] / pl, L[3] / pl, w.ph2, w.grow); F.set(w.st === 2 ? w.bt : 0, bf, w.st, w.rc0);
      const ci = Math.min(N1 - 1, Math.max(0, Math.round(w.x * 2))), ck = Math.min(N1 - 1, Math.max(0, Math.round(w.z * 2)));
      const snowy = we && we.snowD && we.snowD[ck * N1 + ci] > 0.02, ashy = we && we.ashD && we.ashD[ck * N1 + ci] > 0.02;
      const dk = DUST[biome] || DUST.temperate;
      if (snowy) Cc.set(0.92, 0.94, 0.98, 0); else if (ashy) Cc.set(0.3, 0.29, 0.28, 0); else Cc.set(dk[0] * 0.85, dk[1] * 0.82, dk[2] * 0.8, LEAVES[biome] || 0);
    }
    const on = nW > 0, hq = shared.uQ.value >= funnel.userData.minQ;
    strokes.visible = on; strokes.geometry.instanceCount = nW * (wn);
    // (the stroke attribute wi spreads the instances over MAXW slots: draw the first nW slots' share)
    funnel.visible = on && hq; funnel.geometry.instanceCount = nW;
    pall.visible = on; pall.geometry.instanceCount = nW;
    if (on) {
      if (!shared.tHeight.value && parts) shared.tHeight.value = parts.heightTex;
      shared.uTime.value = ctx.time; shared.uPix.value = ctx.pix; shared.uFogD.value = ctx.fogD; shared.uLit.value = ctx.lum;
    }
    lastMs = performance.now() - t0;
  };
  WV.meshes = () => [strokes, funnel, pall];
  WV.stats = () => ({ whirls: nW, strokes: strokes && strokes.visible ? strokes.geometry.instanceCount : 0, ms: +lastMs.toFixed(3) });
})(window.SS = window.SS || {});
