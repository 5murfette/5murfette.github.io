/* render/eowview.js — P68c EXPERIMENTAL biome "End of the World": the space look (presentation only; sim/eow.js has the rules).
 * Everything is procedural (shaders and math, no images, fire included):
 *   - the sky dome: stars (three layers), a nebula band, a harsh sun with a corona, a dark moon lit by it, a thin asteroid belt, all slowly
 *     tumbling (the "rotation" of the world: the sim's chunks are static, the sky, the sun and the far debris turn);
 *   - heat: no core ball (P68d). The pieces themselves glow (lava veins, see sim/eow.js heatVeins; the terrain shader draws them); the 4 hot regions
 *     nearest the camera get a slow flickering orange point light, the only fill light on a night side;
 *   - vacuum effects: explosions = a flash, a glow sphere, straight sparks and a conical ejecta curtain on gravity arcs (no smoke, no shock ring),
 *     breached magma pockets release floating globules, the ship vents ice-crystal plumes, a shell lost to space gets an edge arrow with its distance;
 *   - far debris: an asteroid ring around the core, big silhouettes and small drifting scrap (one InstancedMesh, flat shaded lumps);
 *   - the lights: a hard white sun, a very dark blue ambient, a violet rim light from the nebula side; the terrain haze is black.
 * Hooks (view.js): eowView.frame(...) each frame when S.eow, eowView.reset(S) on a new world (restores the normal look),
 * softview.js: eowView.goal (the muscle pose without the jelly solver), actors.js: eowView.orient (the worm lies along its surface).
 * Removal: delete this file and the hooks listed in docs/notes/P68c.md. Porting: shaders port 1:1; the rest is plain math. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math, C = SS.CFG, TAU = M.TAU;
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
  /* ---------- the ship hull's look (shared by the terrain surface and the cap shader: render/terrain.js has one-line hooks) ----------
   * In this world steel and concrete are only the wreck's gunmetal plates and decks: panel grid with seams and rivets, grime and soot
   * streaks, scorch round the breaches (uEowB: xyz, radius), torn-open bays with live wiring, flickering emergency strips. */
  EV.U = { uEowB: { value: [new T.Vector4(0, 0, 0, 0), new T.Vector4(0, 0, 0, 0), new T.Vector4(0, 0, 0, 0), new T.Vector4(0, 0, 0, 0), new T.Vector4(0, 0, 0, 0), new T.Vector4(0, 0, 0, 0)] } };
  /* P68g: per-texel temperature. Hot regions (sim pl.hot: centre, radius, seam-centre temperature in deg C) and magma pockets (pl.pockets) go to the shader
   * as two vec4 arrays (a: xyz r, b: peak T, kind 0 region / 1 pocket); eoTemp cools a region from its peak toward 480 C at the rim, eoBB is the blackbody table of
   * docs/notes/EOW_RESEARCH.md (600 dull red, 700 cherry, 800 orange-red, 900 orange, 1000-1200 yellow). */
  const HN = 28;
  EV.HN = HN;
  EV.U.uEowHa = { value: [] }; EV.U.uEowHb = { value: [] };
  for (let i = 0; i < HN; i++) { EV.U.uEowHa.value.push(new T.Vector4(0, 0, 0, 0)); EV.U.uEowHb.value.push(new T.Vector4(0, 0, 0, 0)); }
  EV.GLSL = /* glsl */`
    uniform vec4 uEowB[6];
    uniform vec4 uEowHa[${HN}];
    uniform vec4 uEowHb[${HN}];
    vec3 eoBB(float T){
      vec3 c = vec3(0.0);
      c = mix(c, vec3(0.45, 0.03, 0.0), smoothstep(520.0, 600.0, T));
      c = mix(c, vec3(1.2, 0.08, 0.01), smoothstep(600.0, 700.0, T));
      c = mix(c, vec3(1.9, 0.38, 0.03), smoothstep(700.0, 800.0, T));
      c = mix(c, vec3(2.8, 0.95, 0.08), smoothstep(800.0, 900.0, T));
      c = mix(c, vec3(3.2, 1.5, 0.2), smoothstep(900.0, 1000.0, T));
      c = mix(c, vec3(3.5, 2.2, 0.4), smoothstep(1000.0, 1150.0, T));
      return c;
    }
    // x: the temperature of the seams here (deg C: the hottest region or pocket magma that reaches this point, cooling toward its rim), y: pocket crust heat (0..1)
    vec2 eoTemp(vec3 p){
      float T = 0.0, pc = 0.0;
      for (int i = 0; i < ${HN}; i++) {
        vec4 a = uEowHa[i]; if (a.w <= 0.0) continue;
        vec4 b = uEowHb[i]; float d = length(p - a.xyz) / a.w;
        if (b.y > 0.5) {
          T = max(T, mix(b.x, 760.0, smoothstep(0.55, 1.1, d)) * step(d, 1.15));
          pc = max(pc, 1.0 - smoothstep(1.0, 1.9, d));
        } else if (d < 1.0) T = max(T, 470.0 + (b.x - 470.0) * pow(1.0 - d, 0.85));
      }
      return vec2(T, pc);
    }
    float eoH(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
    float eoN(vec3 p){
      vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(eoH(i), eoH(i + vec3(1,0,0)), f.x), mix(eoH(i + vec3(0,1,0)), eoH(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(eoH(i + vec3(0,0,1)), eoH(i + vec3(1,0,1)), f.x), mix(eoH(i + vec3(0,1,1)), eoH(i + vec3(1,1,1)), f.x), f.y), f.z);
    }
    // the glow of lava (wl) and crust (wc) voxels at p: lf = the cell texture (1 = the middle of a plate's crack, 0 = chilled plate), k = flicker
    vec3 eoLava(vec3 p, float wl, float wc, float lf, float k){
      vec2 h = eoTemp(p);
      float nz = eoN(p * 0.9) - 0.5;
      // the crack pattern in 3D (the terrain's lavaFlow is a top-down texture: it smears into vertical bars on a wall): ridged noise, drifting slowly
      vec3 pq = p + vec3(0.0, uTime * 0.012, uTime * 0.008);
      lf = smoothstep(0.3, 0.95, 0.6 * (1.0 - abs(2.0 * eoN(pq * 1.1 + 7.0) - 1.0)) + 0.4 * (1.0 - abs(2.0 * eoN(pq * 2.7 + 3.0) - 1.0)));
      float Tl = h.x + 150.0 * (lf - 0.55) + 90.0 * nz;                         // inside a seam: hotter where the crack is open
      float Tc = max(h.x - 260.0, 0.0) + 90.0 * nz;                             // crust seams run cooler than the lava beside them
      vec3 e = wl * eoBB(Tl) * (0.3 + 0.7 * pow(lf, 1.2)) * k + wc * eoBB(Tc) * pow(lf, 3.0) * 0.9;
      e += wc * h.y * eoBB(560.0 + 110.0 * h.y + 60.0 * nz) * 0.55;             // thin crust over a magma pocket: dull red all over
      return e;
    }
    // the cut face through lava (mat 9) or crust (mat 10): the texture's brightness, the blackbody colour of the temperature here
    vec3 eoCapHeat(vec3 em, vec3 p, int mat){
      vec2 h = eoTemp(p); float k = clamp(dot(em, vec3(0.3, 0.6, 0.1)) / 0.45, 0.0, 1.6), nz = eoN(p * 0.9) - 0.5;
      if (mat == 9) return eoBB(h.x + 70.0 * nz) * (0.25 + 0.33 * k);
      return eoBB(max(h.x - 260.0, 0.0) + 90.0 * nz) * min(k, 1.0) * 0.6 + h.y * eoBB(560.0 + 110.0 * h.y) * 0.5;
    }
    // x: scorch (0..1, 3 radii round a breach), y: the white-hot torn rim
    vec2 eoBreach(vec3 p){
      vec2 r = vec2(0.0);
      for (int i = 0; i < 6; i++) {
        vec4 b = uEowB[i]; if (b.w <= 0.0) continue;
        float d = length(p - b.xyz) / b.w;
        r.x = max(r.x, 1.0 - smoothstep(1.0, 3.4, d));
        r.y = max(r.y, 1.0 - smoothstep(1.0, 1.22, d));
      }
      return r;
    }
    float eoFlick(float id, float rate){ float a = eoH(vec3(id, floor(uTime * rate), 3.0)); return step(0.22, a) * (0.7 + 0.3 * eoH(vec3(id, floor(uTime * rate * 3.0), 8.0))); }
    void eoHull(vec3 p, vec3 n, float ks, float kc, inout vec3 col, inout float rough, inout vec3 emis, inout vec4 RA, inout float GD){
      float k = smoothstep(0.2, 0.55, max(ks, kc));
      vec3 an = abs(n); bool top = an.y > max(an.x, an.z);
      vec2 uv = top ? p.xz : (an.x > an.z ? p.zy : p.xy); float ax = top ? 1.0 : (an.x > an.z ? 2.0 : 3.0);
      vec2 PW = vec2(2.5, 1.25), g = uv / PW, cell = floor(g), f = fract(g);
      float h = eoH(vec3(cell, ax)), h2 = eoH(vec3(cell * 1.7 + 4.0, ax + 9.0));
      float ex = min(f.x, 1.0 - f.x) * PW.x, ey = min(f.y, 1.0 - f.y) * PW.y, sd = min(ex, ey);
      float seam = 1.0 - smoothstep(0.012, 0.055, sd);
      float along = ex < ey ? uv.y : uv.x;
      float rivet = 1.0 - smoothstep(0.028, 0.05, length(vec2((fract(along / 0.45) - 0.5) * 0.45, sd - 0.16)));
      float brush = eoN(vec3(uv * vec2(0.8, 20.0), ax)), gr = eoN(p * 0.55 + 3.0), gr2 = eoN(p * 2.7);
      vec3 metal = vec3(0.30, 0.315, 0.345) * (0.62 + 0.55 * h) * (0.86 + 0.22 * brush) * (0.82 + 0.34 * gr2);
      if (h > 0.9) metal = mix(metal, vec3(0.5, 0.52, 0.55), 0.65);
      if (h < 0.07) metal = mix(metal, vec3(0.07, 0.2, 0.27), 0.85);
      float soot = smoothstep(0.45, 0.85, eoN(vec3(p.x * 0.9 + p.z * 0.9, p.y * 0.11, 7.0))) * 0.6 + smoothstep(0.55, 0.85, gr) * 0.3;
      metal *= 1.0 - soot;
      vec2 bh = eoBreach(p);
      metal = mix(metal, vec3(0.03, 0.026, 0.024), bh.x * (0.55 + 0.4 * gr2));
      metal *= 1.0 - 0.45 * seam;
      metal += vec3(0.1) * rivet;
      vec3 em = vec3(0.0);
      // a torn-open bay: dark, with live cables
      if (h > 0.55 && h < 0.66 && sd > 0.12 && n.y < 0.7) {
        metal = vec3(0.025, 0.026, 0.03);
        float cy = uv.y * 9.0 + 0.6 * sin(uv.x * 2.4 + h * 40.0), cid = floor(cy);
        float cab = 1.0 - smoothstep(0.07, 0.17, abs(fract(cy) - 0.5));
        float ch = eoH(vec3(cid, cell.x, 5.0));
        vec3 cc = ch < 0.33 ? vec3(0.1, 0.6, 1.0) : ch < 0.66 ? vec3(1.0, 0.55, 0.12) : vec3(1.0, 0.12, 0.1);
        float pulse = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(uTime * (3.0 + 5.0 * ch) + uv.x * 3.5 + cid * 2.1), 3.0);
        em += cc * cab * pulse * 1.5 * (0.4 + 0.6 * eoFlick(h * 77.0 + cid, 5.0));
        metal += cc * cab * 0.05;
      }
      // emergency strips: a red lamp that stutters
      if (h2 > 0.88 && abs(f.x - 0.5) < 0.3 && abs(f.y - 0.5) < 0.055) { em += vec3(1.5, 0.1, 0.04) * eoFlick(h2 * 91.0, 7.0); metal = vec3(0.2, 0.03, 0.02); }
      // the white-hot torn rim of a breach
      float rimN = eoN(p * 3.1 + uTime * 0.15);
      em += vec3(1.2, 0.4, 0.09) * bh.y * (0.25 + 0.6 * rimN) * (0.75 + 0.25 * eoH(vec3(floor(uTime * 9.0), 1.0, 2.0)));
      // decks: a grating on the upward faces
      if (kc > ks && n.y > 0.5) {
        vec2 q = abs(fract(p.xz / 0.32 + 0.5) - 0.5);
        float hole = (1.0 - smoothstep(0.1, 0.16, q.x)) * (1.0 - smoothstep(0.1, 0.16, q.y));
        metal = mix(metal * 0.75, vec3(0.012, 0.012, 0.015), hole * 0.85);
      }
      col = mix(col, metal, k); rough = mix(rough, 0.4 + 0.35 * gr2 + 0.2 * soot, k); RA *= 1.0 - 0.5 * k; GD *= 1.0 - k;
      emis = mix(emis, em, k);
    }
    // the cut through a plate: layered dark steel, scorched near the breaches
    vec3 eoCap(vec2 pu, vec3 p, out vec3 em){
      float lam = fract(pu.y * 3.1 + eoN(vec3(pu * 0.7, 1.0)) * 0.4);
      vec3 c = vec3(0.26, 0.27, 0.3) * (0.78 + 0.34 * eoN(vec3(pu * vec2(2.0, 7.0), 2.0))) * (1.0 - 0.28 * step(0.93, lam));
      c += vec3(0.12) * smoothstep(0.82, 0.95, eoN(vec3(pu * 5.0, 4.0)));
      vec2 bh = eoBreach(p);
      c = mix(c, vec3(0.03, 0.026, 0.024), bh.x * 0.8);
      em = vec3(1.7, 0.55, 0.12) * bh.y * (0.35 + 0.9 * eoN(p * 3.1 + uTime * 0.15));
      return c;
    }
  `;

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
    // far debris: an asteroid ring about the core, far silhouettes, near scrap
    const rng = M.rng_make(0x5eed), rr = (a, b) => M.rng_range(rng, a, b);
    const N = 230 + 48, geo = lump(new T.IcosahedronGeometry(1, 2), 3), mat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96, metalness: 0.05, flatShading: true });
    const im = new T.InstancedMesh(geo, mat, N); im.frustumCulled = false; im.castShadow = false; im.receiveShadow = false;
    const col = new T.Color();
    G.deb = [];
    for (let i = 0; i < N; i++) {
      const kind = i < 130 ? 0 : i < 165 ? 1 : i < 230 ? 2 : 3, d = { kind, ax: new T.Vector3(rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize(), w: rr(0.05, 0.5) * (rr(0, 1) < 0.5 ? -1 : 1), q0: rr(0, 6.28) };
      if (kind === 0) { d.r = rr(70, 150); d.th = rr(0, 6.2832); d.y = rr(-9, 9); d.sc = rr(0.5, 2.4) * (rr(0, 1) < 0.08 ? 2.5 : 1); d.om = rr(0.004, 0.011); }
      else if (kind === 1) { const u = rr(-1, 1), a = rr(0, 6.2832), s = Math.sqrt(1 - u * u), r = rr(70, 190); d.px = Math.cos(a) * s * r; d.py = u * r * 0.6; d.pz = Math.sin(a) * s * r; d.sc = rr(2.5, 8); d.om = 0; }
      else if (kind === 3) { d.ax.set(rr(-0.45, 0.45), 1, rr(-0.45, 0.45)).normalize(); d.rf = rr(1.0, 1.4); d.sc = rr(0.22, 0.75); d.w = rr(0.12, 0.34) * (rr(0, 1) < 0.5 ? -1 : 1); d.om = rr(0, 6.28); d.spin = new T.Vector3(rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize(); d.spinW = rr(0.2, 0.9); }
      else { d.px = rr(4, 92); d.py = rr(3, 38); d.pz = rr(4, 92); d.sc = rr(0.12, 0.45); d.vx = rr(-0.25, 0.25); d.vy = rr(-0.18, 0.18); d.vz = rr(-0.25, 0.25); d.om = 0; }
      const t = rr(0, 1);
      col.setRGB(0.28 + 0.2 * t, 0.23 + 0.14 * t, 0.2 + 0.1 * t); if (rr(0, 1) < 0.12) col.setRGB(0.32, 0.34, 0.38);
      im.setColorAt(i, col); G.deb.push(d);
    }
    scene.add(im); G.im = im; G.objs.push(im); G.dummy = new T.Object3D(); G.q = new T.Quaternion();
    return G;
  }


  /* ---------- the wreck's effects: venting gas jets from the breaches, sparks, flickering emergency lights, lava drips ----------
   * One Points object; every particle is a pure function of (time, its emitter, its random numbers) evaluated in the vertex shader
   * (no state, nothing to keep deterministic). Emitters are found from the world: breach holes of the hull (plan), torn edges, lamps in the
   * corridors and magma pockets whose wall was blown open (re-checked once a second against the lattice). */
  const FX_E = 24, FX_N = 1500, KIND_N = [56, 30, 26, 1];
  const FX_V = /* glsl */`
    uniform float uTime, uScale, uDry; uniform vec4 uEmP[${FX_E}]; uniform vec4 uEmD[${FX_E}];
    attribute float aE; attribute vec4 aR; varying vec4 vC; varying float vK;
    float hh(float a, float b){ return fract(sin(a * 127.1 + b * 311.7) * 43758.5453); }
    void main(){
      if (aE < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vC = vec4(0.0); vK = 0.0; return; }
      int e = int(aE + 0.5); vec4 P = uEmP[e], D = uEmD[e]; float kind = P.w; vK = kind;
      float life = kind < 0.5 ? 2.1 : kind < 1.5 ? 0.85 : kind < 2.5 ? 6.0 : 1.0;
      float tt = uTime / life + aR.x, cyc = floor(tt), a = fract(tt);
      vec3 r = vec3(hh(aR.y, cyc), hh(aR.z, cyc + 3.1), hh(aR.w, cyc + 7.7)) * 2.0 - 1.0;
      vec3 pos = P.xyz; float size = 0.2; vec4 col = vec4(0.0);
      if (kind < 0.5) {                                              // venting gas: a widening cone of cold vapour
        float spd = 5.0 + 2.5 * r.x; vec3 dir = normalize(D.xyz + r * 0.3);
        pos += dir * spd * a * life + r * 0.15; size = D.w * (0.5 + 4.2 * a);
        float puff = (0.75 + 0.25 * sin(uTime * 1.7 + float(e) * 2.3)) * uDry, glit = 0.55 + 1.5 * pow(hh(aR.y * 7.0 + cyc, floor(uTime * 9.0)), 5.0);
        col = vec4(vec3(0.82, 0.9, 1.0) * glit, pow(1.0 - a, 1.6) * smoothstep(0.0, 0.05, a) * 0.16 * puff);                 // ice crystals: white, sparkling in the sun, running dry
      } else if (kind < 1.5) {                                       // sparks: bursts of hot specks that fly straight (no air, no gravity)
        float gate = step(0.5, hh(float(e) * 1.7, floor(uTime * 2.6 + 0.3)));
        float spd = 3.0 + 7.0 * (r.y * 0.5 + 0.5); vec3 dir = normalize(D.xyz * 0.8 + r);
        pos += dir * spd * a * life; size = 0.09 + 0.05 * r.z;
        col = vec4(mix(vec3(1.0, 0.95, 0.6), vec3(1.0, 0.25, 0.04), a) * 2.4, (1.0 - a) * gate);
      } else if (kind < 2.5) {                                       // lava drips: slow glowing blobs drifting out of a breached pocket, cooling
        vec3 dir = normalize(D.xyz + r * 0.45); float spd = 0.7 + 0.9 * (r.x * 0.5 + 0.5);
        pos += dir * spd * a * life; size = D.w * (0.55 + 0.45 * (r.y * 0.5 + 0.5)) * (1.0 - 0.3 * a);
        col = vec4(mix(vec3(1.0, 0.62, 0.12), vec3(0.4, 0.05, 0.0), a) * 1.6, 1.0 - a * a);
      } else {                                                       // lamps: a flickering emergency glow
        float f = step(0.2, hh(float(e), floor(uTime * 10.0 + float(e) * 3.0))) * step(0.1, hh(float(e) * 3.3, floor(uTime * 0.7)));
        size = D.w * (0.7 + 0.3 * f); col = vec4(vec3(1.0, 0.14, 0.06) * 2.2, 0.55 * f);
      }
      vec4 mv = viewMatrix * vec4(pos, 1.0);
      gl_Position = projectionMatrix * mv; gl_PointSize = clamp(size * uScale / max(-mv.z, 0.1), 1.0, 160.0); vC = col;
    }`;
  const FX_F = /* glsl */`
    varying vec4 vC; varying float vK;
    void main(){
      vec2 q = gl_PointCoord * 2.0 - 1.0; float r2 = dot(q, q); if (r2 > 1.0) discard;
      float f = vK < 0.5 ? exp(-r2 * 2.4) : vK < 1.5 ? exp(-r2 * 3.0) : vK < 2.5 ? smoothstep(1.0, 0.4, r2) : exp(-r2 * 3.2);
      gl_FragColor = vec4(vC.rgb, vC.a * f);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  const LIGHT_N = 3;
  function buildFx(G, scene) {
    const g = new T.BufferGeometry(), aE = new Float32Array(FX_N).fill(-1), aR = new Float32Array(FX_N * 4), rng = M.rng_make(0xfa11);
    for (let i = 0; i < aR.length; i++) aR[i] = M.rng_range(rng, 0, 1);
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(FX_N * 3), 3)); g.setAttribute('aE', new T.BufferAttribute(aE, 1)); g.setAttribute('aR', new T.BufferAttribute(aR, 4));
    const emP = [], emD = []; for (let i = 0; i < FX_E; i++) { emP.push(new T.Vector4(0, 0, 0, 0)); emD.push(new T.Vector4(0, 1, 0, 1)); }
    const mat = new T.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uScale: { value: 600 }, uDry: { value: 1 }, uEmP: { value: emP }, uEmD: { value: emD } }, vertexShader: FX_V, fragmentShader: FX_F, transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false });
    G.fx = new T.Points(g, mat); G.fx.frustumCulled = false; G.fx.renderOrder = 9; scene.add(G.fx); G.objs.push(G.fx);
    G.fxKey = null; G.em = []; G.lights = G.lights || []; G.hullL = [];
    for (let i = 0; i < LIGHT_N; i++) { const l = new T.PointLight(0xff3018, 0, 20, 2); scene.add(l); G.lights.push(l); G.hullL.push(l); }
    G.fxNext = 0;
  }
  const wp = { x: 0, y: 0, z: 0 };
  // hull-local (u along the axis, lat sideways in the plane, ly up) -> world
  const hullPt = (h, u, lat, ly) => { wp.x = h.x + h.ax * u - h.az * lat; wp.y = h.y + ly; wp.z = h.z + h.az * u + h.ax * lat; return wp; };
  const airAt = (w, x, y, z) => w.sample(x, y, z) < -0.2;
  function hullEmitters(G, pl, w) {
    const h = pl.hull, em = G.em; if (!h) return;
    const lamps = [];
    for (const b of h.breach) {
      const p = hullPt(h, b.u, b.lat, b.ly), ol = b.lat / h.wz, oy = b.ly / h.wy, l = M.len2(ol, oy) || 1, dl = ol / l, dy = oy / l;
      if (!airAt(w, p.x, p.y, p.z)) continue;
      const dx = -h.az * dl, dz = h.ax * dl;
      em.push({ kind: 0, x: p.x, y: p.y, z: p.z, dx, dy, dz, w: b.r * 0.5 });
      em.push({ kind: 1, x: p.x + dx * b.r * 0.7, y: p.y + dy * b.r * 0.7, z: p.z + dz * b.r * 0.7, dx, dy, dz, w: 1 });
      if (G.breachU.length < 6) G.breachU.push([p.x, p.y, p.z, b.r]);
    }
    // the torn stern: sparks where the ring of the skin ends (marched from the stern inward until solid)
    for (let k = 0; k < 6; k++) {
      const f = k / 6 * TAU + 0.4;
      for (let u = -h.HL * 0.98; u < 0; u += 0.5) {
        const p = hullPt(h, u, M.cos(f) * h.wz * 0.93, M.sin(f) * h.wy * 0.93);
        if (w.sample(p.x, p.y, p.z) > 0.2) { em.push({ kind: 1, x: p.x - h.ax * 0.6, y: p.y, z: p.z - h.az * 0.6, dx: -h.ax * 0.6, dy: 0, dz: -h.az * 0.6, w: 1 }); break; }
      }
    }
    // emergency lamps in the corridor between the lower and the upper deck
    for (const u of [-7.5, -1.5, 3.2, 9, 12]) for (const ly of [1.2, 0.4, -0.4]) {
      const p = hullPt(h, u, 0, ly);
      if (airAt(w, p.x, p.y, p.z) && airAt(w, p.x, p.y + 0.6, p.z)) { lamps.push({ x: p.x, y: p.y, z: p.z }); break; }
    }
    for (const L of lamps) em.push({ kind: 3, x: L.x, y: L.y, z: L.z, dx: 0, dy: 1, dz: 0, w: 1.3 });
    for (let i = 1; i < lamps.length; i += 2) em.push({ kind: 1, x: lamps[i].x, y: lamps[i].y, z: lamps[i].z, dx: 0, dy: -0.3, dz: 0, w: 1 });   // a shorting lamp
    G.lampPos = lamps;
  }
  const DIRS = [];
  { const r = M.rng_make(0x70c); for (let i = 0; i < 18; i++) { const u = M.rng_range(r, -1, 1), a = M.rng_range(r, 0, TAU), s = Math.sqrt(1 - u * u); DIRS.push([s * M.cos(a), u, s * M.sin(a)]); } }
  // magma pockets whose wall is breached: the first air along a few rays from the pocket's centre
  function lavaEmitters(G, pl, w) {
    const out = [];
    for (const p of pl.pockets || []) {
      if (w.mat_at(p.x, p.y, p.z) !== SS.CFG.MAT.LAVA) continue;
      const rp = M.max(p.rx, p.rz), found = [];
      for (const d of DIRS) {
        if (found.length >= 3) break;
        let hit = null;
        for (let r = rp * 0.6; r < rp + 3.2; r += 0.4) { const x = p.x + d[0] * r, y = p.y + d[1] * r * 0.9, z = p.z + d[2] * r; if (w.sample(x, y, z) <= 0 && w.mat_at(x, y, z) !== SS.CFG.MAT.LAVA && r > rp * 0.85) { hit = [x, y, z]; break; } }
        if (!hit) continue;
        let near = false; for (const f of found) if (f.d[0] * d[0] + f.d[1] * d[1] + f.d[2] * d[2] > 0.5) near = true;
        if (!near) found.push({ d, p: hit });
      }
      for (const f of found) out.push({ kind: 2, x: f.p[0], y: f.p[1], z: f.p[2], dx: f.d[0], dy: f.d[1], dz: f.d[2], w: 0.42 });
    }
    return out;
  }
  function applyEmitters(G, list) {
    const mat = G.fx.material.uniforms, aE = G.fx.geometry.attributes.aE.array; aE.fill(-1);
    let n = 0, ei = 0;
    for (const e of list) {
      if (ei >= FX_E) break;
      mat.uEmP.value[ei].set(e.x, e.y, e.z, e.kind); const l = M.len3(e.dx, e.dy, e.dz) || 1; mat.uEmD.value[ei].set(e.dx / l, e.dy / l, e.dz / l, e.w);
      for (let k = 0; k < KIND_N[e.kind] && n < FX_N; k++) aE[n++] = ei;
      ei++;
    }
    G.fx.geometry.attributes.aE.needsUpdate = true;
  }
  // the hot regions and the magma pockets to the temperature shader (one new world: they never change; a blast only removes the voxels)
  function heatUniforms(S, pl) {
    const A = EV.U.uEowHa.value, B = EV.U.uEowHb.value, hot = pl.hot || [], pk = pl.pockets || []; let n = 0;
    for (const g of hot) if (n < EV.HN) { A[n].set(g.x, g.y, g.z, g.r); B[n].set(g.T, 0, 0, 0); n++; }
    for (const g of pk) if (n < EV.HN) { A[n].set(g.x, g.y, g.z, g.r * 1.05); B[n].set(g.T, 1, 0, 0); n++; }
    for (; n < EV.HN; n++) { A[n].set(0, 0, 0, 0); B[n].set(0, 0, 0, 0); }
  }
  function fxFrame(S, view, camera, ctx, G) {
    const w = SS.world, pl = w.features && w.features.eow; if (!pl) return;
    if (!G.fx) buildFx(G, ctx.scene);
    const t = view.time;
    if (G.fxKey !== pl) {                                              // a new world
      G.fxKey = pl; G.em = []; G.breachU = []; G.lampPos = []; G.lava = []; G.fxNext = 0;
      hullEmitters(G, pl, w);
      heatUniforms(S, pl);
      for (let i = 0; i < 6; i++) { const b = G.breachU[i]; EV.U.uEowB.value[i].set(b ? b[0] : 0, b ? b[1] : 0, b ? b[2] : 0, b ? b[3] : 0); }
    }
    if (t >= G.fxNext || t < G.fxNext - 3) {                           // once a second: which pockets are open (a blast can open one)
      G.fxNext = t + 1; G.lava = lavaEmitters(G, pl, w); applyEmitters(G, G.em.concat(G.lava));
    }
    const u = G.fx.material.uniforms; u.uDry.value = 1 - 0.85 * M.smoothstep(0, 900, S.time); u.uTime.value = t; u.uScale.value = camera.projectionMatrix.elements[5] * ctx.renderer.domElement.height * 0.5;
    for (let i = 0; i < G.hullL.length; i++) {
      const L = G.hullL[i], p = G.lampPos && G.lampPos[Math.min(G.lampPos.length - 1, i * 2)]; L.visible = true;
      if (!p) { L.intensity = 0; continue; }
      const f = (Math.sin(t * 9 + i * 5) > -0.6 ? 1 : 0.1) * (0.75 + 0.25 * Math.sin(t * 23 + i * 1.7)) * (Math.sin(t * 0.7 + i * 2.1) > -0.9 ? 1 : 0.2);
      L.color.setHex(i === 1 ? 0xff7a30 : 0xff2a18); L.position.set(p.x, p.y, p.z); L.intensity = 70 * f;
    }
  }

  /* ---------- menu preview (ui/mappreview.js hooks call these when the biome is eow): chunks floating over a starfield, no ground ---------- */
  const PV = SS.eowPreview = {};
  const hsh = (a, b, c) => { let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  function space(ctx, w, h, seed, glowX, glowY) {
    const g = ctx.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#04050d'); g.addColorStop(0.55, '#150f2a'); g.addColorStop(1, '#2b1233'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    for (const [fx, fy, r, c] of [[0.72, 0.28, 0.5, 'rgba(120,40,110,0.30)'], [0.2, 0.75, 0.45, 'rgba(30,90,120,0.22)'], [0.5, 0.5, 0.6, 'rgba(255,120,40,0.10)']]) {
      const q = ctx.createRadialGradient(w * fx, h * fy, 0, w * fx, h * fy, w * r); q.addColorStop(0, c); q.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = q; ctx.fillRect(0, 0, w, h);
    }
    for (let i = 0; i < 110; i++) { const x = hsh(seed, 1, i) * w, y = hsh(seed, 2, i) * h, b = hsh(seed, 3, i); ctx.fillStyle = `rgba(${200 + 55 * b | 0},${210 + 40 * b | 0},255,${0.25 + 0.7 * b * b})`; const r = 0.5 + 1.1 * b * b * b; ctx.fillRect(x, y, r, r); }
  }
  function glow(ctx, x, y, r) {
    const q = ctx.createRadialGradient(x, y, 0, x, y, r * 2.6); q.addColorStop(0, 'rgba(255,230,160,1)'); q.addColorStop(0.28, 'rgba(255,150,50,0.95)'); q.addColorStop(0.5, 'rgba(255,90,20,0.35)'); q.addColorStop(1, 'rgba(255,60,10,0)');
    ctx.fillStyle = q; ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, TAU); ctx.fill();
  }
  // a rock: a noisy ellipse (top) with strata bands, or in a side view
  function rock(ctx, x, y, rx, ry, seed, depthTint) {
    const n = 22, pts = [];
    for (let i = 0; i < n; i++) { const a = i / n * TAU, k = 0.84 + 0.3 * hsh(seed, i, 5); pts.push([x + M.cos(a) * rx * k, y + M.sin(a) * ry * k]); }
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < n; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath();
    const g = ctx.createLinearGradient(x - rx * 0.6, y - ry, x + rx * 0.6, y + ry); const k = depthTint;
    g.addColorStop(0, `rgb(${150 * k | 0},${106 * k | 0},${74 * k | 0})`); g.addColorStop(0.5, `rgb(${112 * k | 0},${70 * k | 0},${52 * k | 0})`); g.addColorStop(1, `rgb(${40 * k | 0},${30 * k | 0},${34 * k | 0})`);
    ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.save(); ctx.clip(); ctx.strokeStyle = 'rgba(30,14,8,0.35)'; for (let i = -3; i <= 3; i++) { ctx.beginPath(); ctx.moveTo(x - rx, y + i * ry * 0.3); ctx.quadraticCurveTo(x, y + i * ry * 0.3 + ry * 0.12, x + rx, y + i * ry * 0.3 - ry * 0.05); ctx.stroke(); } ctx.restore();
  }
  PV.top = function (cv, d) {
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, pl = d.eow, k = w / d.sx; space(ctx, w, h, d.seed | 0, 0.5, 0.5);
    if (!pl) return;
    const items = [];
    for (const c of pl.chunks) items.push({ y: c.y, f: () => { rock(ctx, c.x * k, c.z * k, c.rx * k, c.rz * k, c.seed, 0.7 + 0.5 * c.y / 40); for (let i = 0; i < 3; i++) { const a = hsh(c.seed, i, 9) * TAU, r = 0.35 + 0.45 * hsh(c.seed, i, 3), x = c.x * k + M.cos(a) * c.rx * k * r, z = c.z * k + M.sin(a) * c.rz * k * r, q = ctx.createRadialGradient(x, z, 0, x, z, 5); q.addColorStop(0, 'rgba(255,170,60,0.95)'); q.addColorStop(1, 'rgba(255,80,10,0)'); ctx.fillStyle = q; ctx.beginPath(); ctx.arc(x, z, 5, 0, TAU); ctx.fill(); } } });
    for (const q of pl.debris) items.push({ y: q.y, f: () => rock(ctx, q.x * k, q.z * k, q.R * (q.plate ? 1.9 : 1) * k, q.R * (q.plate ? 1.1 : 1) * k, q.seed, 0.8) });
    if (pl.hull) items.push({ y: pl.hull.y, f: () => { const h2 = pl.hull; ctx.lineCap = 'round'; ctx.strokeStyle = '#2b2f38'; ctx.lineWidth = h2.wz * 2 * k; ctx.beginPath(); ctx.moveTo(h2.A[0] * k, h2.A[2] * k); ctx.lineTo(h2.B[0] * k, h2.B[2] * k); ctx.stroke(); ctx.strokeStyle = '#8c94a3'; ctx.lineWidth = h2.wz * 1.5 * k; ctx.stroke(); ctx.strokeStyle = '#ff3a22'; ctx.lineWidth = 1.6; ctx.setLineDash([2, 5]); ctx.stroke(); ctx.setLineDash([]); } });
    items.sort((a, b) => a.y - b.y); for (const it of items) it.f();
    ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.arc(w / 2, h / 2, (d.sx / 2 - 3.5) * k, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
  };
  PV.side = function (cv, d) {
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, pl = d.eow, k = w / d.sx, Y = y => h - 4 - y / 40 * (h - 8); space(ctx, w, h, (d.seed | 0) + 7, 0.5, 0.5);
    if (!pl) return;
    const items = [];
    for (const c of pl.chunks) items.push({ z: -c.z, f: () => rock(ctx, c.x * k, Y(c.y), c.rx * k, c.ry * (h - 8) / 40, c.seed, 0.7 + 0.3 * (1 - c.z / d.sx)) });
    for (const q of pl.debris) items.push({ z: -q.z, f: () => rock(ctx, q.x * k, Y(q.y), q.R * k, q.R * k * 0.8, q.seed, 0.8) });
    if (pl.hull) items.push({ z: -pl.hull.z, f: () => { const h2 = pl.hull; ctx.lineCap = 'round'; ctx.strokeStyle = '#2b2f38'; ctx.lineWidth = h2.wy * 2 * k * 0.9; ctx.beginPath(); ctx.moveTo(h2.A[0] * k, Y(h2.y)); ctx.lineTo(h2.B[0] * k, Y(h2.y)); ctx.stroke(); ctx.strokeStyle = '#8c94a3'; ctx.lineWidth = h2.wy * 1.4 * k; ctx.stroke(); } });
    items.sort((a, b) => a.z - b.z); for (const it of items) it.f();
  };
  PV.hero = function (cv, d) {
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, pl = d.eow, k = w / d.sx * 0.95; space(ctx, w, h, (d.seed | 0) + 13, 0.5, 0.5);
    if (!pl) return;
    const P = (x, y, z) => [w / 2 + (x - d.sx / 2) * k, h * 0.52 - (y - 20) * k * 0.55 + (z - d.sx / 2) * k * 0.36, 0.7 + 0.5 * z / d.sx];   // an oblique view: x right, y up, z toward the viewer
    const items = [];
    for (const c of pl.chunks) items.push({ z: c.z, f: () => {
      const p = P(c.x, c.y, c.z), rx = c.rx * k * p[2], ry = c.rz * k * 0.36 * p[2] * 1.5, th = c.ry * k * 1.1 * p[2];
      ctx.fillStyle = 'rgba(0,0,0,0.0)';
      ctx.beginPath(); ctx.moveTo(p[0] - rx, p[1]);                                                           // the ragged underside: a cone of rock below the top disc
      for (let i = 0; i <= 8; i++) { const a = i / 8, xx = p[0] - rx + 2 * rx * a, dep = th * (0.5 + 1.3 * Math.sin(a * Math.PI)) * (0.7 + 0.5 * hsh(c.seed, i, 2)); ctx.lineTo(xx, p[1] + dep * 0.9); }
      ctx.lineTo(p[0] + rx, p[1]); ctx.closePath(); const g = ctx.createLinearGradient(0, p[1], 0, p[1] + th * 1.8); g.addColorStop(0, '#5a3a2a'); g.addColorStop(1, '#161015'); ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.stroke();
      rock(ctx, p[0], p[1], rx, ry, c.seed, 1.0 + 0.1 * (c.y / 40));
      if (c.lava) { ctx.fillStyle = 'rgba(255,130,30,0.9)'; ctx.beginPath(); ctx.ellipse(p[0] + rx * 0.25, p[1] + th * 0.55, rx * 0.16, th * 0.2, 0, 0, TAU); ctx.fill(); }
    } });
    for (const q of pl.debris) items.push({ z: q.z, f: () => { const p = P(q.x, q.y, q.z); rock(ctx, p[0], p[1], q.R * k * p[2] * (q.plate ? 1.8 : 1), q.R * k * p[2] * (q.plate ? 0.6 : 0.9), q.seed, 0.75); } });
    if (pl.hull) items.push({ z: pl.hull.z, f: () => { const a = P(pl.hull.A[0], pl.hull.y, pl.hull.A[2]), b = P(pl.hull.B[0], pl.hull.y, pl.hull.B[2]); ctx.lineCap = 'round'; ctx.strokeStyle = '#23262e'; ctx.lineWidth = pl.hull.wy * 2.1 * k * a[2]; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); ctx.strokeStyle = '#8f97a6'; ctx.lineWidth = pl.hull.wy * 1.5 * k * a[2]; ctx.stroke(); ctx.strokeStyle = '#ff3a22'; ctx.lineWidth = 2; ctx.setLineDash([2, 6]); ctx.stroke(); ctx.setLineDash([]); } });
    items.sort((a, b) => a.z - b.z); for (const it of items) it.f();
  };

  /* ---------- the heat of the pieces: point lights on the hot regions nearest the camera ---------- */
  const HOT_N = 4, tc3 = [0, 0, 0];
  // blackbody colour of a temperature in deg C (the table of docs/notes/EOW_RESEARCH.md; same stops as eoBB in the shader), normalised to a light colour (max channel 1)
  const BB = [[600, 0.45, 0.03, 0], [700, 1.2, 0.08, 0.01], [800, 1.9, 0.38, 0.03], [900, 2.8, 0.95, 0.08], [1000, 3.2, 1.5, 0.2], [1150, 3.5, 2.2, 0.4]];
  function bbRGB(T, out) {
    let r = 0, g = 0, b = 0;
    if (T >= BB[0][0]) { let i = 0; while (i < BB.length - 2 && T > BB[i + 1][0]) i++; const a = BB[i], c = BB[i + 1], f = M.clamp((T - a[0]) / (c[0] - a[0]), 0, 1); r = a[1] + (c[1] - a[1]) * f; g = a[2] + (c[2] - a[2]) * f; b = a[3] + (c[3] - a[3]) * f; }
    const m = M.max(M.max(r, g), M.max(b, 1e-3)); out[0] = r / m; out[1] = g / m; out[2] = b / m; return out;
  }
  EV.bbRGB = bbRGB;
  function hotLights(S, view, ctx, G) {
    G.lights = G.lights || [];
    if (!G.hotL) { G.hotL = []; for (let i = 0; i < HOT_N; i++) { const l = new T.PointLight(0xff6a20, 0, 40, 2); ctx.scene.add(l); G.hotL.push(l); } G.boomL = new T.PointLight(0xfff0d0, 0, 60, 1.5); ctx.scene.add(G.boomL); G.lights.push(...G.hotL, G.boomL); }
    const hot = S.eow.hot || [], pk = S.eow.pockets || [], f = view.camT, n = SS.terrain.uniforms.uN.value, list = [];
    for (let i = 0; i < hot.length; i++) { const h = hot[i], d = M.len3(h.x - f.x, h.y - f.y, h.z - f.z); list.push({ h, d, T: h.T * 0.82, k: 1 }); }
    for (let i = 0; i < pk.length; i++) { const h = pk[i], d = M.len3(h.x - f.x, h.y - f.y, h.z - f.z); list.push({ h, d, T: 640, k: 0.5 }); }      // a sealed pocket: its crust glows dull red
    list.sort((a, b) => a.d - b.d);
    for (let i = 0; i < HOT_N; i++) {
      const l = G.hotL[i], q = list[i]; l.visible = true;
      if (!q) { l.intensity = 0; continue; }
      const h = q.h, fl = 0.85 + 0.1 * M.sin(view.time * 0.9 + i * 2.1) + 0.05 * M.sin(view.time * 2.3 + h.x), tk = M.clamp((q.T - 450) / 700, 0, 1.2);
      bbRGB(q.T, tc3);
      l.position.set(h.x + n.x * 3, h.y + n.y * 3 + 1, h.z + n.z * 3);
      l.color.setRGB(tc3[0], tc3[1], tc3[2]); l.distance = 12 + h.r * 3; l.intensity = 110 * tk * tk * q.k * fl * (1 - M.smoothstep(34, 80, q.d));
    }
    if (G.boom) { G.boom.t += 1 / 60; G.boomL.visible = true; G.boomL.intensity = G.boom.i * Math.exp(-G.boom.t * 16); if (G.boom.t > 0.6) G.boom = null; } else { G.boomL.visible = true; G.boomL.intensity = 0; }
  }

  /* ---------- vacuum explosions, escaping sparks, floating lava globules ----------
   * Particles are simulated on the CPU (a few hundred): sparks fly straight and cool yellow -> red -> dark (1-3 s); grains of the chunk's own material leave the
   * crater in a cone and follow the summed gravity field, landing where the rock is (> ~90 % within a few crater radii) or leaving for good when fast enough;
   * globules of molten rock (a breached magma pocket, a fuel splash) wobble, drift in the field, cool and settle as black beads. No smoke, no dust cloud, no shock ring. */
  const DYN_MAX = 700;
  const DYN_V = /* glsl */`
    uniform float uScale; attribute vec4 aC; attribute float aS; varying vec4 vC;
    void main(){ vec4 mv = viewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = clamp(aS * uScale / max(-mv.z, 0.1), 1.0, 420.0); vC = aC; }`;
  const DYN_F = /* glsl */`
    varying vec4 vC; uniform float uSoft;
    void main(){ vec2 q = gl_PointCoord * 2.0 - 1.0; float r2 = dot(q, q); if (r2 > 1.0) discard;
      float f = mix(smoothstep(1.0, 0.55, r2), exp(-r2 * 3.0), uSoft);
      gl_FragColor = vec4(vC.rgb, vC.a * f);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  function makeDyn(scene, additive, soft) {
    const g = new T.BufferGeometry(), pos = new Float32Array(DYN_MAX * 3), col = new Float32Array(DYN_MAX * 4), sz = new Float32Array(DYN_MAX);
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('aC', new T.BufferAttribute(col, 4)); g.setAttribute('aS', new T.BufferAttribute(sz, 1));
    const mat = new T.ShaderMaterial({ uniforms: { uScale: { value: 600 }, uSoft: { value: soft } }, vertexShader: DYN_V, fragmentShader: DYN_F, transparent: true, depthWrite: false, blending: additive ? T.AdditiveBlending : T.NormalBlending, fog: false });
    const pts = new T.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = additive ? 10 : 6; scene.add(pts);
    const D = { pts, pos, col, sz, n: 0, list: [] };
    return D;
  }
  const fieldv = { x: 0, y: 0, z: 0 };
  // kinds: 0 spark, 1 grain, 2 globule, 3 flash (a fixed glow that fades)
  function dynPush(D, p) { if (D.list.length >= DYN_MAX) D.list.shift(); D.list.push(p); }
  const tempCol = (k, out) => {                       // k 1 (hot) -> 0 (cold): white-yellow, yellow, orange, cherry, dull red, dark
    if (k > 0.8) { out[0] = 2.4; out[1] = 1.5 + 0.6 * (k - 0.8) * 5; out[2] = 0.45 + 0.5 * (k - 0.8) * 5; }
    else if (k > 0.55) { const t = (k - 0.55) / 0.25; out[0] = 2.6; out[1] = 0.8 + 1.4 * t; out[2] = 0.15 + 0.4 * t; }
    else if (k > 0.3) { const t = (k - 0.3) / 0.25; out[0] = 1.2 + 1.4 * t; out[1] = 0.12 + 0.68 * t; out[2] = 0.02 * t; }
    else { const t = k / 0.3; out[0] = 0.9 * t; out[1] = 0.08 * t; out[2] = 0; }
    return out;
  };
  const tc = [0, 0, 0];
  function dynStep(S, G, dt) {
    const W = SS.world, E = SS.eow;
    for (const D of [G.dynA, G.dynN]) {
      let n = 0;
      for (let i = D.list.length - 1; i >= 0; i--) {
        const p = D.list[i]; p.age += dt;
        if (p.age > p.life) { D.list.splice(i, 1); continue; }
      }
      for (let i = 0; i < D.list.length; i++) {
        const p = D.list[i], a = p.age / p.life;
        if (p.kind !== 3 && !p.rest) {
          if (p.kind !== 0) { E.field(S, p.x, p.y, p.z, fieldv); const g = C.G * (p.kind === 2 ? 0.25 : 0.7) * dt; p.vx += fieldv.x * g; p.vy += fieldv.y * g; p.vz += fieldv.z * g; }
          const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
          if (p.kind !== 0 && W.sample(nx, ny, nz) > 0) { p.rest = true; p.vx = p.vy = p.vz = 0; if (p.kind === 1) p.life = Math.min(p.life, p.age + 2.5); }
          else { p.x = nx; p.y = ny; p.z = nz; }
          if (p.kind === 0 && W.sample(p.x, p.y, p.z) > 0) { p.rest = true; p.life = Math.min(p.life, p.age + 0.25); }
        }
        const o = n * 3, c4 = n * 4;
        D.pos[o] = p.x; D.pos[o + 1] = p.y; D.pos[o + 2] = p.z;
        if (p.kind === 0) { tempCol(1 - a * 0.95, tc); const al = (1 - a) * (1 - a); D.col[c4] = tc[0]; D.col[c4 + 1] = tc[1]; D.col[c4 + 2] = tc[2]; D.col[c4 + 3] = al; D.sz[n] = p.size * (1 - 0.5 * a); }
        else if (p.kind === 1) { D.col[c4] = p.r; D.col[c4 + 1] = p.g; D.col[c4 + 2] = p.b; D.col[c4 + 3] = 1 - M.smoothstep(0.8, 1, a) + (p.rest ? -0.0 : 0); D.sz[n] = p.size; }
        else if (p.kind === 2) {                        // globule: cools yellow -> red -> a black bead (the glow is the additive system, the bead the opaque one)
          const k = M.max(0, 1 - p.age / 9);
          if (D === G.dynA) { tempCol(k, tc); D.col[c4] = tc[0] * 0.8; D.col[c4 + 1] = tc[1] * 0.8; D.col[c4 + 2] = tc[2] * 0.8; D.col[c4 + 3] = k > 0.05 ? 0.9 : 0; D.sz[n] = p.size * (1 + 0.12 * M.sin(S.time * 7 + p.ph)); }
          else { D.col[c4] = 0.03; D.col[c4 + 1] = 0.028; D.col[c4 + 2] = 0.035; D.col[c4 + 3] = 1 - M.smoothstep(0.85, 1, a); D.sz[n] = p.size * 0.8; }
        } else { const f = 1 - a; tempCol(0.4 + 0.6 * f, tc); D.col[c4] = tc[0] * f * 2; D.col[c4 + 1] = tc[1] * f * 2; D.col[c4 + 2] = tc[2] * f * 2; D.col[c4 + 3] = f * f; D.sz[n] = p.size * (0.6 + a * 0.8); }
        n++;
      }
      D.n = n; D.pts.geometry.setDrawRange(0, n);
      D.pts.geometry.attributes.position.needsUpdate = true; D.pts.geometry.attributes.aC.needsUpdate = true; D.pts.geometry.attributes.aS.needsUpdate = true;
    }
  }
  function dynInit(G, ctx) { if (!G.dynA) { G.dynA = makeDyn(ctx.scene, true, 1); G.dynN = makeDyn(ctx.scene, false, 0); G.objs.push(G.dynA.pts, G.dynN.pts); } }
  const MATCOL = {};
  { const MT = C.MAT; MATCOL[MT.SOIL] = [0.3, 0.2, 0.14]; MATCOL[MT.SANDSTONE] = [0.5, 0.36, 0.25]; MATCOL[MT.ROCK] = [0.34, 0.32, 0.31]; MATCOL[MT.BASALT] = [0.14, 0.14, 0.16]; MATCOL[MT.CRUST] = [0.1, 0.09, 0.1]; MATCOL[MT.STEEL] = [0.35, 0.37, 0.4]; MATCOL[MT.CONCRETE] = [0.35, 0.35, 0.34]; MATCOL[MT.ICE] = [0.6, 0.75, 0.9]; MATCOL[MT.BEDROCK] = [0.2, 0.2, 0.22]; MATCOL[MT.LAVA] = [0.1, 0.05, 0.04]; }
  const rnd = (a, b) => a + (b - a) * Math.random();
  // called by render/fx.js FX.explosion when the world is the End of the World: true = handled
  EV.explosion = function (e) {
    const G = built, S = EV.S; if (!G || !S || !S.eow || !G.dynA) return false;
    const W3 = Math.cbrt(e.W || Math.pow((e.R || 3) / 3, 3)), R = Math.max(1, e.R || 3), W = SS.world, nv = { x: 0, y: 1, z: 0 };
    W.normal(e.x, e.y, e.z, nv); if (M.len3(nv.x, nv.y, nv.z) < 0.3) { nv.x = 0; nv.y = 1; nv.z = 0; }
    const A = G.dynA, N = G.dynN, byMat = e.byMat || [];
    let bm = 0, bc = 0; for (let i = 0; i < byMat.length; i++) if (i !== C.MAT.LAVA && byMat[i] > bc) { bc = byMat[i]; bm = i; }
    const mc = MATCOL[bm] || MATCOL[C.MAT.ROCK], lavaN = byMat[C.MAT.LAVA] || 0, fuel = !!e.boom;
    // a hard flash and a glow sphere (0.1-0.2 s)
    dynPush(A, { kind: 3, x: e.x, y: e.y, z: e.z, vx: 0, vy: 0, vz: 0, age: 0, life: 0.1 + 0.03 * W3, size: R * 1.2, r: 1, g: 1, b: 1, ph: 0 });
    dynPush(A, { kind: 3, x: e.x, y: e.y, z: e.z, vx: 0, vy: 0, vz: 0, age: 0, life: 0.2 + 0.05 * W3, size: R * 2.1, r: 1, g: 1, b: 1, ph: 0 });
    G.boom = { t: 0, i: 700 * W3 };
    const dirOut = (spread) => { let x = rnd(-1, 1), y = rnd(-1, 1), z = rnd(-1, 1); const l = Math.hypot(x, y, z) || 1; x = x / l + nv.x * spread; y = y / l + nv.y * spread; z = z / l + nv.z * spread; const m = Math.hypot(x, y, z) || 1; return [x / m, y / m, z / m]; };
    // sparks: incandescent bits that fly straight and cool
    for (let i = 0, n = Math.round(26 + 22 * W3 + (fuel ? 30 : 0)); i < n; i++) { const d = dirOut(0.9), v = rnd(4, 16) * (0.7 + 0.3 * W3); dynPush(A, { kind: 0, x: e.x, y: e.y, z: e.z, vx: d[0] * v, vy: d[1] * v, vz: d[2] * v, age: 0, life: rnd(1, 3), size: rnd(0.05, 0.11), ph: 0 }); }
    // ejecta: a conical curtain of grains (mostly 3-9 m/s: back on the piece within a few crater radii), a few fast ones leave
    for (let i = 0, n = Math.round(50 + 40 * W3); i < n; i++) {
      const d = dirOut(2.2), v = 2.5 + Math.pow(Math.random(), 1.7) * 18 * (0.55 + 0.45 * W3), sh = rnd(0.6, 1.2);
      dynPush(N, { kind: 1, x: e.x + nv.x * 0.3, y: e.y + nv.y * 0.3, z: e.z + nv.z * 0.3, vx: d[0] * v, vy: d[1] * v, vz: d[2] * v, age: 0, life: rnd(5, 9), size: rnd(0.15, 0.34) * (0.7 + 0.3 * W3), r: mc[0] * sh * 1.7, g: mc[1] * sh * 1.7, b: mc[2] * sh * 1.7, ph: 0 });
    }
    // molten globules: from a breached pocket (its lava voxels were in the crater) or a fuel splash: slow, glowing, they drift and cool
    const ng = Math.min(36, Math.round(lavaN / 10) + (fuel ? 14 : 0));
    for (let i = 0; i < ng; i++) { const d = dirOut(0.7), v = rnd(0.8, fuel ? 6 : 3.2), q = { kind: 2, x: e.x, y: e.y, z: e.z, vx: d[0] * v, vy: d[1] * v, vz: d[2] * v, age: 0, life: 9 + rnd(0, 6), size: rnd(0.35, 0.7), ph: rnd(0, 6), r: 0, g: 0, b: 0 }; dynPush(A, q); dynPush(N, Object.assign({}, q)); }
    return true;
  };

  /* ---------- a shell lost to space: the camera holds, an edge arrow shows where it flies and how far ---------- */
  EV.lostFocus = function (S) {
    const L = S.eow && S.eow.shots; if (!L || !L.length) return null;
    const q = L[L.length - 1]; if (S.time - q.t0 > SS.eow.K.LOST_T - 0.2) return null;
    return { key: 'eowlost' + q.t0.toFixed(2), x: q.x0, y: q.y0, z: q.z0, d: 760, p: 7.2 };
  };
  let arrowEl = null;
  function arrow(S, camera, ctx) {
    const L = S.eow && S.eow.shots, q = L && L.length ? L[L.length - 1] : null;
    if (!arrowEl) {
      arrowEl = document.createElement('div'); arrowEl.id = 'eowArrow';
      arrowEl.style.cssText = 'position:fixed;left:0;top:0;z-index:30;pointer-events:none;display:none;font:700 14px/1.1 "Barlow Semi Condensed",system-ui,sans-serif;color:#cfe6ff;text-shadow:0 1px 3px #000,0 0 8px #000;text-align:center;transform-origin:50% 50%';
      arrowEl.innerHTML = '<svg width="54" height="54" viewBox="-27 -27 54 54" style="display:block;margin:0 auto"><path d="M-14 -13 L16 0 L-14 13 L-7 0 Z" fill="#9fd0ff" stroke="#06101c" stroke-width="2" stroke-linejoin="round"/></svg><div id="eowArrowT"></div>';
      document.body.appendChild(arrowEl);
    }
    if (!q || S.time - q.t0 > SS.eow.K.LOST_T) { arrowEl.style.display = 'none'; return; }
    const cv = ctx.renderer.domElement, r = cv.getBoundingClientRect(), v = new T.Vector3(q.x, q.y, q.z).project(camera), v2 = new T.Vector3(q.x + q.vx * 0.5, q.y + q.vy * 0.5, q.z + q.vz * 0.5).project(camera);
    let sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
    if (v.z > 1) { sx = r.width - sx; sy = r.height - sy; }
    let dx = (v2.x - v.x) * r.width, dy = -(v2.y - v.y) * r.height; const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
    const m = 70, cx = r.width / 2, cy = r.height / 2;
    if (sx < m || sx > r.width - m || sy < m * 1.6 || sy > r.height - m * 2.2 || v.z > 1) {     // off the edge: clamp to the screen's rim along the line from the centre
      const ox = sx - cx, oy = sy - cy, k = Math.min((cx - m) / (Math.abs(ox) || 1e-3), (cy - m * 1.8) / (Math.abs(oy) || 1e-3));
      sx = cx + ox * Math.min(k, 1e3); sy = cy + oy * Math.min(k, 1e3);
    }
    const o = S.worms[q.owner] || S.active, from = o ? o.pos : { x: q.x0, y: q.y0, z: q.z0 }, dist = Math.hypot(q.x - from.x, q.y - from.y, q.z - from.z), ang = Math.atan2(dy, dx) * 180 / Math.PI;
    arrowEl.style.display = 'block'; arrowEl.style.opacity = String(Math.min(1, (SS.eow.K.LOST_T - (S.time - q.t0)) * 2));
    arrowEl.style.transform = `translate(${(r.left + sx - 27).toFixed(0)}px,${(r.top + sy - 27).toFixed(0)}px)`;
    arrowEl.firstChild.style.transform = `rotate(${ang.toFixed(0)}deg)`;
    arrowEl.lastChild.textContent = `${dist.toFixed(0)} m`;
  }

  /* ---------- sound in vacuum (platform/audiospace.js hook): only what reaches the suit through the rock or the hands ---------- */
  SS.eowAudio = {
    eval(out, p, d, o, L) {
      const E = SS.eow, S = L && L.S; if (!E || !S || !S.eow) return out;
      const bl = E.body_of(S, L.fx, L.fy, L.fz), bs = E.body_of(S, p.x, p.y, p.z), loud = o && o.cls === 'loud';
      out.delay = 0; out.wet = 0.02;
      if (d < 2.6) { out.gain *= 0.7; out.fc = 900; }                                    // the suit: footsteps, the gun's mechanism through the hands
      else if (bl >= 0 && bl === bs) { out.gain *= (loud ? 1.0 : 0.45) / (1 + d / 28); out.fc = loud ? 320 : 600; }   // through the rock under the boots: a low thump
      else out.gain *= loud ? 0.012 : 0.0;                                                 // another piece: silence (a faint radio crackle)
      out.pan = 0; out.muffle = Math.min(1, Math.max(0, 1 - out.fc / 20000));
      return out;
    }
  };

  /* the look */
  const LOOK = { sunDir: [0.5, 0.45, 0.7], sky: 'sky', sun: 0xfff1de, sunI: 4.4, hemiS: 0x0c1020, hemiG: 0x050408, hemiI: 0.05, fog: 0, haze: 0x03040a, exp: 1.18, grass: [0.7, 0.62, 0.52], dry: [0.7, 0.62, 0.52], gBase: 0x2a1a10, gTip: 0x6a4a30, gDry: 0x6a5a40, deep: 0x000000, shallow: 0x000000 };
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
    ctx.motes.visible = false;                                        // no air, no pollen, no dust
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
    fill.color.setHex(0x331a10); fill.intensity = 0; fill.position.set(-sd[0] * 60, 18, -sd[2] * 60);
    sun.position.set(view.camT.x + sd[0] * 80, view.camT.y + sd[1] * 80, view.camT.z + sd[2] * 80); sun.target.position.copy(view.camT);
    U.uSunDir.value.set(sd[0], sd[1], sd[2]).normalize();
    ctx.scene.fog.color.setHex(LOOK.haze); ctx.scene.fog.density = LOOK.fog; if (view.haze && view.haze.isColor) view.haze.copy(ctx.scene.fog.color); else view.haze = ctx.scene.fog.color.clone(); view.fogBase = LOOK.fog; U.uHaze.value.copy(ctx.scene.fog.color);
    ctx.renderer.toneMappingExposure = LOOK.exp;
    if (SS.lens && SS.lens.grade && ctx.Q.grade && lastGrade !== S.tick >> 6) { lastGrade = S.tick >> 6; SS.lens.grade(GRADE); SS.lens.sun(null, [0, 0, 0], 0); }
    SS.terrain.capEow(true);
    lamp.intensity = 0; hotLights(S, view, ctx, G);
    const c = e.core;
    // debris: the far ring precesses (its plane wobbles slowly), the far silhouettes turn about the core, small scrap drifts, and orbiters circle the chunks
    // (all presentation: the chunks themselves stay in the sim's lattice, see docs/notes/P68c.md "Rotation")
    const d0 = G.dummy, im = G.im, q = G.q, pl = SS.world.features && SS.world.features.eow, nch = pl ? pl.chunks.length : 0;
    const pa = 0.075 * M.sin(t * 0.011), pb = 0.09 * M.sin(t * 0.0083 + 1.0), ca = M.cos(pa), sa = M.sin(pa), cb = M.cos(pb), sb = M.sin(pb), yaw = t * 0.0016, cy = M.cos(yaw), sy = M.sin(yaw);
    for (let i = 0; i < G.deb.length; i++) {
      const d = G.deb[i]; let vis = 1;
      if (d.kind === 0) {
        const an = d.th + t * d.om; let x = M.cos(an) * d.r, y = d.y + M.sin(an * 1.7 + d.q0) * 1.5, z = M.sin(an) * d.r;
        const y1 = y * ca - z * sa, z1 = y * sa + z * ca; y = y1 * cb - x * sb; x = y1 * sb + x * cb; z = z1;   // tilt about x, then about z
        d0.position.set(c.x + x, c.y + y, c.z + z);
      } else if (d.kind === 1) d0.position.set(c.x + d.px * cy - d.pz * sy, c.y + d.py, c.z + d.px * sy + d.pz * cy);
      else if (d.kind === 2) d0.position.set(d.px + d.vx * M.sin(t * 0.07 + d.q0) * 40, d.py + d.vy * M.sin(t * 0.05 + d.q0) * 40, d.pz + d.vz * M.sin(t * 0.06 + d.q0) * 40);
      else {
        if (!nch) vis = 0;
        else {
          const ch = pl.chunks[i % nch], ro = d.rf * (M.max(ch.rx, ch.rz) + 4.4), a = d.om + t * d.w, n = d.ax;
          let ux = n.y, uy = -n.x; const uz = 0, ul = M.len3(ux, uy, uz) || 1; ux /= ul; uy /= ul;   // u = n x (0,0,1) normalised
          const vx = n.y * uz - n.z * uy, vy = n.z * ux - n.x * uz, vz = n.x * uy - n.y * ux, ca2 = M.cos(a) * ro, sa2 = M.sin(a) * ro;
          const px = ch.x + ux * ca2 + vx * sa2, py = ch.y + uy * ca2 + vy * sa2, pz = ch.z + uz * ca2 + vz * sa2;
          d0.position.set(px, py, pz);
          vis = 1 - M.smoothstep(-1.5, 0.3, SS.world.sample(px, py, pz));            // a piece that dives into rock shrinks away
        }
      }
      if (d.kind === 3) q.setFromAxisAngle(d.spin, d.q0 + d.spinW * t); else q.setFromAxisAngle(d.ax, d.q0 + d.w * t);
      d0.quaternion.copy(q); d0.scale.set(d.sc * vis, d.sc * vis * (0.7 + 0.3 * M.sin(d.q0 * 3)), d.sc * vis * 1.2);
      d0.updateMatrix(); im.setMatrixAt(i, d0.matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    fxFrame(S, view, camera, ctx, G);
    EV.S = S; dynInit(G, ctx); { const dtp = M.clamp(view.time - (G.dynT == null ? view.time : G.dynT), 0, 0.1); G.dynT = view.time; dynStep(S, G, dtp); }
    G.dynA.pts.material.uniforms.uScale.value = G.dynN.pts.material.uniforms.uScale.value = camera.projectionMatrix.elements[5] * ctx.renderer.domElement.height * 0.5;
    arrow(S, camera, ctx);
    view.eowSun = LOOK.sunDir;
  };
  /* back to the normal look: a new world that is not the End of the World (applyLook restores the lights' colours and the fog; this puts back
   * what only this file changed: the pollen, the fill light, the worm lamp, the cap shader's switch) */
  EV.reset = function (S) {
    lastGrade = -1; if (arrowEl) arrowEl.style.display = 'none';
    if (typeof SS.terrain.capEow === 'function') SS.terrain.capEow(!!S.eow);
    if (!built || S.eow) return;
    for (const o of built.objs) o.visible = false;
    for (const l of built.lights || []) { l.visible = false; l.intensity = 0; }
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
