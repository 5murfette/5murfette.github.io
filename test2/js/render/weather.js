/* Weather view (Step 5e): what the player sees of SS.weather (sim/weather.js). Render-only (may use Math.random).
 *   - precipitation: rain streaks / snow or ash flakes = one instanced quad per particle, animated in the vertex
 *     shader: seeds in a camera-local box (world-anchored, wrapped), moved by an offset the CPU integrates from the
 *     mean wind and the fall speed (wind changes never make the field jump); hidden below the top-height map
 *     (overhangs shelter), near / box-edge / fog fades; thin streaks keep >= 1.2 px and lose alpha instead.
 *   - rain splashes on the ground behind slice zero; rain rings on water (render/water.js `weather`).
 *   - whirlwinds: render/whirl.js (funnel, terrain-draped skirt and gust ring, spiral strokes).
 *   - lightning: a branched ribbon bolt per 'lightning' event (midpoint displacement seeded by the event), additive,
 *     2-4 return strokes in ~0.4 s; flash = sky uFlash + hemisphere boost + the fill light turned toward the bolt;
 *     thunder ('thunder' event) = WebAudio brown noise through low-pass filters, delayed by distance / 343 m/s,
 *     only once a user gesture has unlocked audio (never in headless tests).
 *   - overcast: sky uDark, sun dimmed / ambient raised by cloud cover; fog thickens with precipitation.
 *   - ground: terrain uWet = S.weather.wet; tCover (193², r = snow depth, g = ash depth, / COVER_MAX m) for the
 *     terrain surface and the cover layer on the cut face.
 * Porting: GPU particle systems (wrap-in-box), a ribbon mesh, light / sky parameters, an audio cue. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const WX = SS.weatherView = {};
  let N1 = 193;                          // lattice columns per side (P38: per map)
  const COVER_MAX = 0.4;
  // P102: was 34000 / 30000 / 1600 (a white wall, and the fill cost lagged the game)
  const RAIN_N = 14000, FLAKE_N = 9000, SPLASH_N = 400;
  let scene, Q, P = null, rain, flake, splash, coverTex, coverData, coverRef = null, coverVer = -1, coverUploads = 0;
  // (the lights' bases: set by look())
  const base = { sun: 3, hemi: 1.15, fill: 0, fog: 0.006, motes: 0.55, storm: false, fillPos: new T.Vector3(), fillCol: new T.Color(),
    haze: new T.Color(0xf1d9c0), skyH: new T.Color(0x9aa0a8), ov: -1, sunEl: 0.6, hemiC: new T.Color(), hemiG: new T.Color() };
  const NIGHT_C = new T.Color(0.2, 0.3, 0.52),
    LAVA_G = new T.Color(0.62, 0.2, 0.06),
    DUSK_C = new T.Color(1.0, 0.6, 0.36),
    DUSK_G = new T.Color(0.5, 0.2, 0.1),
    cA = new T.Color();
  const fogC = new T.Color(), FLASH_C = new T.Color(0.75, 0.8, 1.0);
  const offR = new T.Vector3(), offF = new T.Vector3(), tmp = new T.Vector3();
  const bolts = [];
  let flash = 0, flashDir = new T.Vector3(0, 1, 0), cpuMs = 0, biome = 'temperate';
  WX.audio = true;

  /* ---------- shared GLSL ---------- */
  const HASH = /* glsl */`
    float h1(float n){ return fract(sin(n) * 43758.5453); }
    // view.js heightTex: top / 40
    float topAt(vec2 xz){ return texture2D(tHeight, (xz * 2.0 + 0.5) / float(textureSize(tHeight, 0).x)).r * 40.0; }
    vec3 side(vec3 ax, vec3 toC){
      vec3 s = cross(ax, toC);
      float l = length(s);
      return l > 1e-4 ? s / l : vec3(1.0, 0.0, 0.0);
    }
    void hide(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }`;
  const OUT = /* glsl */`
    #include <tonemapping_fragment>
    #include <colorspace_fragment>`;

  function quadGeo(n, extra) {
    const g = new T.InstancedBufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const s = new Float32Array(n * 4);
    for (let i = 0; i < s.length; i++) s[i] = Math.random();
    g.setAttribute('seed', new T.InstancedBufferAttribute(s, 4));
    if (extra) extra(g, n);
    g.instanceCount = 0;
    return g;
  }
  function mesh(g, m, order) {
    const o = new T.Mesh(g, m);
    o.frustumCulled = false;
    o.renderOrder = order;
    o.visible = false;
    scene.add(o);
    return o;
  }

  /* ---------- precipitation: rain streaks (round 0) and snow / ash flakes (round 1) ---------- */
  const PREC_V = /* glsl */`
    attribute vec4 seed;
    uniform sampler2D tHeight;
    uniform vec3 uC, uB, uOff, uVel, uO, uN;
    uniform vec2 uNear;
    uniform float uTime, uSize, uExpo, uSway, uFallVar, uPix, uFogD, uFlick, uRound, uInsp;
    varying vec2 vUv;
    varying float vA;
    ${HASH}
    void main(){
      float k = mix(1.0 - uFallVar, 1.0 + uFallVar, seed.w);
      vec3 lo = uC - 0.5 * uB;
      vec3 p = lo + mod(seed.xyz * uB + vec3(uOff.x, uOff.y * k, uOff.z) - lo, uB);
      float ph = seed.w * 37.0 + seed.x * 17.0;
      p.xz += uSway * vec2(sin(uTime * (0.6 + seed.y) + ph), cos(uTime * (0.5 + seed.z) + ph * 1.3));
      vec3 v = vec3(uVel.x, uVel.y * k, uVel.z);
      float spd = length(v);
      vec3 ax = spd > 0.01 ? v / spd : vec3(0.0, -1.0, 0.0);
      vec3 toC = cameraPosition - p;
      float d = max(length(toC), 1e-3);
      // P74: near fade 2.2-7 m (a streak a few m from the lens was a fat white bar)
      float a = smoothstep(uNear.x, uNear.y, d) * exp(-uFogD * uFogD * d * d);
      vec2 e = abs(p.xz - uC.xz) / (0.5 * uB.xz);
      a *= (1.0 - smoothstep(0.8, 1.0, max(e.x, e.y))) * (1.0 - smoothstep(uC.y + 0.3 * uB.y, uC.y + 0.5 * uB.y, p.y));
      a *= mix(1.0, 0.45 + 0.55 * sin(uTime * (5.0 + 4.0 * seed.y) + ph), uFlick);
      // in front of slice zero the ground is cut away in the game view: rain there ends at the section's ground line
      // (the particle projected onto slice zero), as the player sees it; inspecting shows the real ground again
      float tD = dot(p - uO, uN);
      vec2 gq = tD > 0.0 && uInsp < 0.5 ? p.xz - uN.xz * tD : p.xz;
      if (p.y < topAt(gq) + 0.03 || a < 0.003) {
        hide();
        vA = 0.0;
        vUv = vec2(0.0);
        return;
      }
      vec3 sd = side(ax, toC / d);
      float w = uSize * (0.75 + 0.5 * seed.w), wp = uPix * d * 1.0;
      a *= min(1.0, w / wp); w = max(w, wp);
      float len = max(w * uRound, spd * uExpo);
      vec3 Pq = p + sd * position.x * w - ax * len * position.y;
      vUv = vec2(position.x * 2.0, position.y); vA = a;
      gl_Position = projectionMatrix * viewMatrix * vec4(Pq, 1.0);
    }`;
  const PREC_F = /* glsl */`
    uniform vec3 uCol;
    uniform float uRound, uFlash, uAlpha;
    varying vec2 vUv;
    varying float vA;
    void main(){
      float u = vUv.x, t = vUv.y;
      float a = uRound > 0.5 ? (1.0 - smoothstep(0.25, 1.0, length(vec2(u, t * 2.0 - 1.0))))
                             : (1.0 - u * u) * smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.35, 1.0, t));
      a *= vA * uAlpha;
      if (a < 0.002) discard;
      gl_FragColor = vec4(uCol + uFlash * vec3(0.55, 0.6, 0.75), a);
      ${OUT}
    }`;
  function precipMat(round) {
    return new T.ShaderMaterial({
      // DoubleSide: the quad spans sd = ax × toC and −ax, which winds CLOCKWISE seen from the camera (normal ≈ −toC):
      // with the default FrontSide every streak / flake was culled = the "invisible rain" (same as the X2 shrapnel)
      vertexShader: PREC_V, fragmentShader: PREC_F, transparent: true, depthWrite: false, side: T.DoubleSide,
      uniforms: {
        tHeight: { value: null }, uC: { value: new T.Vector3() }, uB: { value: new T.Vector3(56, 34, 56) },
        uOff: { value: new T.Vector3() }, uVel: { value: new T.Vector3(0, -8, 0) }, uTime: { value: 0 },
        uO: { value: new T.Vector3() }, uN: { value: new T.Vector3(0, 0, 1) }, uInsp: { value: 0 },
        uSize: { value: round ? 0.045 : 0.012 }, uExpo: { value: round ? 0.022 : 0.055 }, uSway: { value: round ? 0.35 : 0 },
        uFallVar: { value: round ? 0.35 : 0.15 }, uPix: { value: 0.001 }, uFogD: { value: 0.006 }, uFlick: { value: 0 },
        uNear: { value: round ? new T.Vector2(3.0, 9.0) : new T.Vector2(9.0, 22.0) }, uRound: { value: round ? 1 : 0 },
        uCol: { value: new T.Color(0.7, 0.74, 0.8) }, uFlash: { value: 0 }, uAlpha: { value: round ? 0.6 : 0.5 }
      }
    });
  }

  /* ---------- rain splashes: short-lived rings on the top surface (hashed position per cycle) ---------- */
  const SPL_V = /* glsl */`
    attribute vec4 seed;
    uniform sampler2D tHeight;
    uniform vec3 uC, uO, uN;
    uniform float uR, uTime, uRate, uAmt, uInsp, uSea, uPix;
    varying vec2 vUv;
    varying float vA;
    ${HASH}
    void main(){
      float ph = uTime * uRate * (0.8 + 0.4 * seed.w) + seed.z, cyc = floor(ph), f = ph - cyc;
      vec2 q = vec2(h1(seed.x * 91.7 + cyc * 7.13), h1(seed.y * 53.3 + cyc * 3.71));
      vec2 xz = uC.xz + (q - 0.5) * 2.0 * uR;
      float g = topAt(xz);
      vec3 p = vec3(xz.x, g + 0.015, xz.y);
      float tD = dot(p - uO, uN);
      if (h1(seed.w * 13.1 + cyc) > uAmt || f > 0.3 || g < uSea + 0.05 || (tD > 0.15 && uInsp < 0.02) || (tD < -3.0 && uInsp < 0.02)) {
        hide();
        vA = 0.0;
        vUv = vec2(0.0);
        return;
      }
      f /= 0.3;
      vec3 toC = cameraPosition - p;
      float d = length(toC);
      vec3 sd = side(vec3(0.0, 1.0, 0.0), toC / d);
      float s = max((0.05 + 0.13 * f) * (0.7 + 0.6 * seed.y), uPix * d * 2.0);
      vec3 Pq = p + sd * position.x * s * 2.0 + vec3(0.0, 1.0, 0.0) * (position.y - 0.25) * s * 0.9;
      vUv = vec2(position.x * 2.0, position.y); vA = (1.0 - f) * (1.0 - f) * smoothstep(1.0, 4.0, d) * (tD > 0.0 ? uInsp : 1.0);
      gl_Position = projectionMatrix * viewMatrix * vec4(Pq, 1.0);
    }`;
  const SPL_F = /* glsl */`
    uniform vec3 uCol;
    uniform float uAlpha;
    varying vec2 vUv;
    varying float vA;
    void main(){
      vec2 c = vec2(vUv.x, vUv.y * 2.0 - 0.5);
      float r = length(c);
      float ra = (r - 0.62) / 0.16;
      float a = exp(-ra * ra) * smoothstep(-0.5, 0.1, c.y) + (1.0 - smoothstep(0.0, 0.35, length(vec2(c.x * 3.0, c.y - 0.2)))) * 0.5;
      a *= vA * uAlpha;
      if (a < 0.003) discard;
      gl_FragColor = vec4(uCol, a);
      ${OUT}
    }`;

  /* whirlwinds: render/whirl.js (SS.whirlView, P65a) */

  /* ---------- lightning bolt: camera-facing ribbon per segment, two layers (core, glow), additive ---------- */
  const BOLT_V = /* glsl */`
    // aS: side +-1, end 0/1, half width (m), brightness
attribute vec3 a0, a1;
    attribute vec4 aS;
    attribute float aL;                            // 0 main channel, 1 branch
    uniform float uPix;
    varying float vU;
    varying float vB;
    varying float vL;
    void main(){
      vec3 dv = a1 - a0;
      float L = length(dv);
      vec3 ax = L > 1e-4 ? dv / L : vec3(0.0, 1.0, 0.0);
      vec3 p = mix(a0, a1, aS.y) + ax * (aS.y * 2.0 - 1.0) * aS.z * 0.5;   // overlap the joints
      vec3 toC = cameraPosition - p;
      float d = max(length(toC), 1e-3);
      vec3 cr = cross(ax, toC / d);
      float cl = length(cr);
      vec3 sd = cl > 1e-4 ? cr / cl : vec3(1.0, 0.0, 0.0);
      float w = max(aS.z, uPix * d * 1.0);
      vU = aS.x; vB = aS.w * min(1.0, aS.z / w); vL = aL;
      gl_Position = projectionMatrix * viewMatrix * vec4(p + sd * aS.x * w, 1.0);
    }`;
  const BOLT_F = /* glsl */`
    uniform float uI, uBr;
    uniform vec3 uCol;
    varying float vU;
    varying float vB;
    varying float vL;
    void main(){
      float a = exp(-vU * vU * 3.0) * vB * uI * mix(1.0, uBr, vL);
      gl_FragColor = vec4(uCol * a, 1.0);
      ${OUT}
    }`;
  function rngOf(seed) {
    let s = ((seed >>> 0) ^ 0x9e3779b9) >>> 0 || 1;
    return () => {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      return s / 4294967296;
    };
  }
  // midpoint displacement: every level splits each segment and pushes the midpoint sideways (perpendicular)
  function jag(a, b, rough, levels, rnd) {
    let pts = [a, b], amp = a.distanceTo(b) * rough;
    for (let l = 0; l < levels; l++) {
      const out = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i], q = pts[i + 1], m = p.clone().add(q).multiplyScalar(0.5), dir = q.clone().sub(p).normalize();
        const r = new T.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5);
        r.addScaledVector(dir, -r.dot(dir));
        out.push(m.addScaledVector(r, amp * 2), q);
      }
      pts = out; amp *= 0.6;                                   // > 0.5: stays jagged at every scale
    }
    return pts;
  }
  function boltGeometry(x, y, z, seed) {
    const rnd = rngOf(seed), segs = [];
    const top = new T.Vector3(x + (rnd() - 0.5) * 30, Math.max(y + 70, 80), z + (rnd() - 0.5) * 30), hit = new T.Vector3(x, y, z);
    const main = jag(top, hit, 0.09, 8, rnd);
    const add = (pts, w, br, br1, lvl) => {
      for (let i = 0; i < pts.length - 1; i++) segs.push({ a: pts[i], b: pts[i + 1], w, br: br + (br1 - br) * i / (pts.length - 1), lvl });
    };
    add(main, 0.04, 1, 1, 0);
    const nb = 3 + Math.floor(rnd() * 4);
    for (let k = 0; k < nb; k++) {
      const i = Math.floor(main.length * (0.08 + 0.62 * rnd())), s = main[i], dn = main[i + 1].clone().sub(s).normalize();
      const d = dn.add(new T.Vector3((rnd() - 0.5) * 1.8, -0.3 * rnd(), (rnd() - 0.5) * 1.8)).normalize();
      const br = jag(s, s.clone().addScaledVector(d, 8 + rnd() * 20), 0.18, 4, rnd);
      add(br, 0.022, 0.6, 0.12, 1);
      if (rnd() < 0.5) {                                        // one sub-branch
        const j = 3 + Math.floor(rnd() * (br.length - 6)), s2 = br[j];
        const d2 = d.clone().add(new T.Vector3((rnd() - 0.5) * 1.5, -0.2, (rnd() - 0.5) * 1.5)).normalize();
        add(jag(s2, s2.clone().addScaledVector(d2, 4 + rnd() * 8), 0.2, 3, rnd), 0.016, 0.35, 0.08, 1);
      }
    }
    // two layers per segment: core and glow (8 vertices, 4 triangles)
    const n = segs.length * 8,
      A0 = new Float32Array(n * 3),
      A1 = new Float32Array(n * 3),
      AS = new Float32Array(n * 4),
      AL = new Float32Array(n),
      idx = [];
    let v = 0;
    for (const s of segs)
      for (let layer = 0; layer < 2; layer++) {
        const w = layer ? s.w * 8 : s.w, br = layer ? s.br * 0.05 : s.br;
        for (let c = 0; c < 4; c++) {
          A0.set([s.a.x, s.a.y, s.a.z], v * 3); A1.set([s.b.x, s.b.y, s.b.z], v * 3);
          AS.set([c & 1 ? 1 : -1, c >> 1, w, br], v * 4); AL[v] = s.lvl; v++;
        }
        const b0 = v - 4;
        idx.push(b0, b0 + 1, b0 + 3, b0, b0 + 3, b0 + 2);
      }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 3), 3));   // unused (three requires it)
    g.setAttribute('a0', new T.BufferAttribute(A0, 3)); g.setAttribute('a1', new T.BufferAttribute(A1, 3));
    g.setAttribute('aS', new T.BufferAttribute(AS, 4)); g.setAttribute('aL', new T.BufferAttribute(AL, 1));
    g.setIndex(idx);
    // return strokes: 2-4 pulses in ~0.35 s, each a fast exponential decay
    const strokes = [{ t: 0, s: 1 }], ns = 1 + Math.floor(rnd() * 3);
    let t = 0;
    for (let k = 0; k < ns; k++) {
      t += 0.05 + rnd() * 0.09;
      strokes.push({ t, s: 0.5 + rnd() * 0.45 });
    }
    return { g, strokes, life: t + 0.3, segs: segs.length };
  }
  function boltIntensity(b) {
    let I = 0;
    for (const s of b.strokes)
      if (b.t >= s.t) I += s.s * Math.exp(-(b.t - s.t) / 0.045);
    return I + 0.12 * Math.exp(-b.t / 0.25);                 // continuing current glow
  }

  /* ---------- thunder (WebAudio; unlocked by the first pointer / key gesture, so never in headless tests)
   * ---------- */
  let ac = null, noise = null, master = null;
  function unlockAudio() {
    if (ac || !WX.audio) return;
    const A = window.AudioContext || window.webkitAudioContext;
    if (!A) return;
    try {
      ac = new A();
    } catch (e) {
      ac = null;
      return;
    }
    const len = Math.floor(ac.sampleRate * 6), b = ac.createBuffer(1, len, ac.sampleRate), d = b.getChannelData(0);
    let last = 0;
    // brown noise
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
    noise = b;
    const comp = ac.createDynamicsCompressor();
    master = ac.createGain();
    master.gain.value = 0.7;
    master.connect(comp); comp.connect(ac.destination);
  }
  function thunder(dist) {
    // a delivered sample (docs/SOUND_PROMPTS.md thunder_close / thunder_far) replaces the synthesis, delayed by
    // distance
    if (SS.audio && SS.audio.has && (SS.audio.has('thunder_close') || SS.audio.has('thunder_far'))) {
      const id = dist < 40 && SS.audio.has('thunder_close')
        ? 'thunder_close'
        : SS.audio.has('thunder_far')
        ? 'thunder_far'
        : 'thunder_close';
      setTimeout(() => SS.audio.play(id, Math.min(1, 45 / (dist + 25))), dist / 343 * 1000); return;
    }
    if (!ac || !noise || !WX.audio || (SS.audio && SS.audio.muted)) return;     // (the game's mute covers the thunder too)
    if (ac.state === 'suspended') ac.resume();
    const t0 = ac.currentTime + dist / 343, vol = Math.min(1, 45 / (dist + 25));
    // crack: the noise sped up through a low-pass falling from ~3 kHz (close strikes crack, far ones only rumble)
    const s1 = ac.createBufferSource();
    s1.buffer = noise;
    s1.playbackRate.value = 2.5;
    const f1 = ac.createBiquadFilter();
    f1.type = 'lowpass';
    f1.frequency.setValueAtTime(300 + 3000 * vol, t0); f1.frequency.exponentialRampToValueAtTime(250, t0 + 0.5);
    const g1 = ac.createGain();
    g1.gain.setValueAtTime(0.0001, t0);
    g1.gain.exponentialRampToValueAtTime(vol * 1.2, t0 + 0.008);
    g1.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
    s1.connect(f1);
    f1.connect(g1);
    g1.connect(master);
    s1.start(t0, Math.random() * 3);
    s1.stop(t0 + 0.7);
    // rumble: low-passed noise with irregular swells over 3-5 s
    const s2 = ac.createBufferSource();
    s2.buffer = noise;
    s2.loop = true;
    const f2 = ac.createBiquadFilter();
    f2.type = 'lowpass';
    f2.frequency.value = 140 + 120 * vol;
    f2.Q.value = 0.8;
    const g2 = ac.createGain(), dur = 3 + Math.random() * 2;
    let t = t0 + 0.05;
    g2.gain.setValueAtTime(0.0001, t0); g2.gain.exponentialRampToValueAtTime(vol * 1.6, t);
    while (t < t0 + dur - 0.6) {
      t += 0.25 + Math.random() * 0.5;
      g2.gain.setTargetAtTime(vol * (0.4 + Math.random() * 1.2) * Math.max(0.05, 1 - (t - t0) / dur), t, 0.12);
    }
    g2.gain.setTargetAtTime(0.0001, t0 + dur - 0.5, 0.35);
    s2.connect(f2);
    f2.connect(g2);
    g2.connect(master);
    s2.start(t0, Math.random() * 1.5);
    s2.stop(t0 + dur + 1.0);
  }

  /* ---------- per-column snow / ash cover for the terrain (tCover) ---------- */
  function refillCover(we) {
    const sD = we.snowD, aD = we.ashD, d = coverData, k = 255 / COVER_MAX, n = Math.min(N1 * N1, sD.length);
    for (let c = 0; c < n; c++) {
      d[c * 4] = Math.min(255, sD[c] * k + 0.5);
      d[c * 4 + 1] = Math.min(255, aD[c] * k + 0.5);
    }
    coverTex.needsUpdate = true; coverUploads++;
  }

  /* ---------- public hooks (view.js) ---------- */
  let txRef = null, camRef = null, nBolts = 0, fogMul = 1, oc = 0;
  WX.init = function (sc, textures, quality, parts) {
    scene = sc;
    txRef = textures;
    Q = quality;
    P = parts || null;
    const q = Q.particles || 1;
    // P46: the one documented weather exemption
    const AMB = 'ambient precipitation: the streaks fill the view and end at the section ground line (own rule in PREC_V)';
    rain = mesh(quadGeo(Math.round(RAIN_N * q)), SS.section.exempt(precipMat(false), AMB), 7);
    flake = mesh(quadGeo(Math.round(FLAKE_N * q)), SS.section.exempt(precipMat(true), AMB), 7);
    splash = mesh(quadGeo(Math.round(SPLASH_N * q)), new T.ShaderMaterial({
      vertexShader: SPL_V, fragmentShader: SPL_F, transparent: true, depthWrite: false, side: T.DoubleSide,
      uniforms: {
        tHeight: { value: null }, uC: { value: new T.Vector3() }, uO: { value: new T.Vector3() }, uN: { value: new T.Vector3(0, 0, 1) },
        uR: { value: 20 }, uTime: { value: 0 }, uRate: { value: 3.3 }, uAmt: { value: 0 }, uInsp: { value: 0 }, uSea: { value: 3 },
        uPix: { value: 0.001 }, uCol: { value: new T.Color(0.8, 0.84, 0.9) }, uAlpha: { value: 0.2 }
      }
    }), 6);
    if (SS.whirlView) SS.whirlView.init(scene, Q, P);
    N1 = SS.world.NX;
    coverData = new Uint8Array(N1 * N1 * 4);
    coverTex = new T.DataTexture(coverData, N1, N1, T.RGBAFormat);
    coverTex.magFilter = coverTex.minFilter = T.LinearFilter; coverTex.needsUpdate = true;
    if (SS.terrain.uniforms.tCover) SS.terrain.uniforms.tCover.value = coverTex;
    if (P && P.motes) base.motes = P.motes.material.opacity;
    addEventListener('pointerdown', unlockAudio, true); addEventListener('keydown', unlockAudio, true);
  };
  /* P38: a map of another size: the cover texture follows the lattice (the height texture is view.js's) */
  WX.resize = function () {
    const n = SS.world.NX;
    if (n === N1) return;
    N1 = n; coverData = new Uint8Array(N1 * N1 * 4);
    coverTex.dispose(); coverTex.image = { data: coverData, width: N1, height: N1 }; coverTex.needsUpdate = true;
    coverRef = null; coverVer = -1;
  };
  /* the bases are what applyLook (view.js) finally set on the lights: the time of day, the sun dimmed and reddened by
   * the ash or dust along its path, no sun and no fill
   * underground. Weather only modulates them (cloud deck, lightning flash) and never owns a copy of its own */
  WX.look = function (L, sk, haze) {
    base.sun = P.sun.intensity;
    base.hemi = P.hemi.intensity;
    base.hemiC.copy(P.hemi.color);
    base.hemiG.copy(P.hemi.groundColor);
    base.fill = P.fill.intensity; base.fillCol.copy(P.fill.color); base.fillPos.copy(P.fill.position);
    base.fog = L.fog;
    if (haze) base.haze.copy(haze);
    if (sk && sk.horizon) base.skyH.setRGB(sk.horizon[0], sk.horizon[1], sk.horizon[2], T.SRGBColorSpace);
    base.storm = sk && sk.phys ? !!sk.storm : !!(txRef && txRef.skies && sk === txRef.skies.sky_storm);
    base.phys = !!(sk && sk.phys);      // K2: the procedural sky already contains the overcast (no extra darkening)
    base.ov = sk && sk.phys && sk.ov !== undefined ? sk.ov : -1;
    if (L.sunDir) base.sunEl = Math.max(0.15, L.sunDir[1] / Math.hypot(L.sunDir[0], L.sunDir[1], L.sunDir[2]));
  };
  WX.bolt = function (x, y, z, seed) {
    const b = boltGeometry(x, y, z, seed | 0);
    const m = new T.ShaderMaterial({
      // max blending: overlapping joints and glow layers do not add up (additive showed stacked blocks)
      vertexShader: BOLT_V, fragmentShader: BOLT_F, transparent: true, depthWrite: false, blending: T.CustomBlending,
      blendEquation: T.MaxEquation,
      uniforms: { uI: { value: 0 }, uBr: { value: 1 }, uPix: { value: 0.001 }, uCol: { value: new T.Color(0.78, 0.82, 1.0) } }
    });
    const o = new T.Mesh(b.g, m);
    o.frustumCulled = false;
    o.renderOrder = 8;
    scene.add(o);
    const d = camRef ? Math.hypot(x - camRef.x, y - camRef.y, z - camRef.z) : 40;
    bolts.push({ mesh: o, t: 0, strokes: b.strokes, life: b.life, near: 1 / (1 + d / 80), x, y, z, segs: b.segs });
    while (bolts.length > 3) drop(0);
    nBolts++;
  };
  function drop(i) {
    const b = bolts[i];
    scene.remove(b.mesh);
    b.mesh.geometry.dispose();
    b.mesh.material.dispose();
    bolts.splice(i, 1);
  }
  WX.onEvent = function (S, e) {
    if (e.type === 'lightning') WX.bolt(e.x, e.y, e.z, e.seed);
    else if (e.type === 'thunder' && ac) thunder(camRef ? Math.hypot(e.x - camRef.x, e.y - camRef.y, e.z - camRef.z) : 40);
  };
  WX.clear = function () {
    while (bolts.length) drop(0);
    flash = 0;
  };

  function setPrecip(o, amt, n, cx, cy, cz, off, vx, vy, vz, time, pix, fogD, view) {
    const u = o.material.uniforms, k = Math.round(n * Math.min(1, amt));
    o.visible = k > 0; o.geometry.instanceCount = k;
    if (!k) return;
    u.uC.value.set(cx, cy, cz); u.uOff.value.copy(off); u.uVel.value.set(vx, vy, vz);
    u.uTime.value = time;
    u.uPix.value = pix;
    u.uFogD.value = fogD;
    u.uFlash.value = flash * 0.6;
    const TU = SS.terrain.uniforms;
    u.uO.value.copy(TU.uO.value);
    u.uN.value.copy(TU.uN.value);
    u.uInsp.value = view.insp || 0;
    if (!u.tHeight.value && P) u.tHeight.value = P.heightTex;
  }
  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
  WX.frame = function (S, view, camera, dt) {
    if (SS.world.NX !== N1) WX.resize();
    const t0 = performance.now();
    const we = S.weather || null, wind = S.wind || null, U = SS.terrain.uniforms, time = view.time;
    const rainA = we ? we.rain || 0 : 0, snowA = we ? we.snow || 0 : 0, ashA = we ? we.ash || 0 : 0, cloud = we ? we.cloud || 0 : 0;
    const mx = wind && wind.mean ? wind.mean.x : 0, mz = wind && wind.mean ? wind.mean.z : 0, ws = Math.hypot(mx, mz);
    biome = S.biome || 'temperate'; camRef = camera.position;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    oc = clamp01((cloud - 0.2) / 0.8);
    fogMul = 1 + 0.6 * rainA + (1 + 0.08 * ws) * snowA + 0.8 * ashA + (we && we.kind === 'fog' ? 7 : 0);   // PoC fog: ~8 x the haze
    const fogD = base.fog * fogMul * (view.fogK == null ? 1 : view.fogK);   // P85: not thicker with zoom (view.js fogK)
    const ct = view.camT, cp = camera.position;
    const cx = ct.x + (cp.x - ct.x) * 0.4, cz = ct.z + (cp.z - ct.z) * 0.4, cy = ct.y + 6;
    const pix = 2 * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, P && P.renderer ? P.renderer.domElement.height : 800);
    // P74: drops / flakes are lit by the scene (they glowed white at night)
    const tk = view.tod === 'night' ? 0.2 : view.tod === 'dusk' ? 0.72 : 1;
    const lum = (0.55 + 0.45 * (1 - 0.5 * oc)) * (SS.world.under ? 0.5 : tk);

    // rain: drops follow the wind (0.85 of the 10 m mean near the ground), 6.5-9 m/s fall
    const fallR = 6.5 + 2.5 * rainA;
    offR.x += mx * 0.85 * dt; offR.y -= fallR * dt; offR.z += mz * 0.85 * dt;
    if (Math.abs(offR.y) > 1e5) offR.set(0, 0, 0);
    rain.material.uniforms.uCol.value.setRGB(0.86 * lum, 0.9 * lum, 0.98 * lum);
    setPrecip(rain, rainA, rain.geometry.attributes.seed.count, cx, cy, cz, offR, mx * 0.85, -fallR, mz * 0.85, time, pix, fogD, view);

    // snow / ash flakes (one system; colour, fall speed, sway and flicker by the ash share)
    const fA = snowA + ashA, ashS = fA > 0 ? ashA / fA : 0, fallF = 1.0 - 0.3 * ashS;
    offF.x += mx * 0.9 * dt; offF.y -= fallF * dt; offF.z += mz * 0.9 * dt;
    if (Math.abs(offF.y) > 1e5) offF.set(0, 0, 0);
    const fu = flake.material.uniforms;
    // ash: grey grains / aggregates lit by the sky (albedo ~0.25 x the sky light ~1.4) = mid grey; at (0.17, 0.16,
    // 0.155) they matched the dark ash sky and sea and could not be seen at all
    fu.uCol.value.setRGB(
      0.92 * lum + (0.36 * lum - 0.92 * lum) * ashS,
      0.94 * lum + (0.34 * lum - 0.94 * lum) * ashS,
      1.0 * lum + (0.32 * lum - lum) * ashS
    );
    fu.uSize.value = 0.05 - 0.015 * ashS; fu.uSway.value = 0.35 + 0.15 * ashS; fu.uFlick.value = ashS;
    setPrecip(flake, fA, flake.geometry.attributes.seed.count, cx, cy, cz, offF, mx * 0.9, -fallF, mz * 0.9, time, pix, fogD, view);

    // splashes on the ground near the target
    const su = splash.material.uniforms,
      sk = rainA > 0.05 ? Math.round(splash.geometry.attributes.seed.count * Math.min(1, rainA * 1.5)) : 0;
    splash.visible = sk > 0; splash.geometry.instanceCount = sk;
    if (sk) {
      if (!su.tHeight.value && P) su.tHeight.value = P.heightTex;
      su.uC.value.set(ct.x + (cp.x - ct.x) * 0.25, 0, ct.z + (cp.z - ct.z) * 0.25);
      su.uO.value.copy(U.uO.value); su.uN.value.copy(U.uN.value); su.uSea.value = SS.world.SEA;
      su.uTime.value = time;
      su.uAmt.value = Math.min(1, rainA * 1.2);
      su.uInsp.value = view.insp || 0;
      su.uPix.value = pix;
      su.uCol.value.setRGB(0.8 * lum, 0.84 * lum, 0.9 * lum);
    }

    // whirlwind columns, funnels and skirts (render/whirl.js)
    if (SS.whirlView) SS.whirlView.frame(S, wind, we, biome, { time, pix, fogD, lum });

    // lightning bolts and the flash
    flash = 0;
    for (let i = bolts.length - 1; i >= 0; i--) {
      const b = bolts[i];
      b.t += dt;
      if (b.t > b.life) {
        drop(i);
        continue;
      }
      const I = boltIntensity(b), bu = b.mesh.material.uniforms;
      bu.uI.value = I * 6; bu.uBr.value = Math.exp(-b.t / 0.12); bu.uPix.value = pix;
      if (I * b.near > flash) tmp.set(b.x - ct.x, b.y + 40 - ct.y, b.z - ct.z).normalize().multiplyScalar(50);
      flash += I * b.near;
    }
    flash = Math.min(1.5, flash);
    // P118b: the cut face is lit by the flash too (terrain.js capFlash, from view.js)
    view.flash = flash;
    if (flash > 0.01) flashDir.copy(tmp);

    // sky, lights, fog, motes
    if (P) {
      // LV2: under a cloud DECK (K2 sky ov >= 0.7: rain, storm, snow, blizzard, ashfall; nimbostratus optical depth
      // 20+) the direct beam is nearly gone: sun x (1 - ov)^1.5 (rain 10 %, storm 3 %), the same factor the K2 clouds
      // use; ~25 % of the blocked beam reaches the ground as diffuse skylight through the cloud (hemi). The old
      // sun x (1 - 0.5 oc) kept 59 % of the sun in rain: its specular lobe on wet ground was the "plastic bag" sheen.
      // Broken cloud (cloudy, the volcanic ash veil) keeps the sun most of the time: 1 - 0.5 ov.
      const ovK = base.ov >= 0 ? base.ov : oc * 0.9;
      const fs = ovK >= 0.7 ? Math.pow(1 - ovK, 1.5) : 1 - 0.5 * ovK;
      P.sun.intensity = base.sun * fs;
      P.hemi.intensity = base.hemi * (1 + 0.15 * oc) + base.sun * base.sunEl * (1 - fs) * 0.25 + flash * 2.5;
      // P74: a rainy night kept almost no light (floor); P76: the floor is lower and the colours follow the time of day
      // under the deck: night cool and dark with the lava glow bouncing warm from below (hemisphere ground colour),
      // dusk warm; a lightning flash lights the night harder (the eye is dark-adapted)
      const tod = view.tod, deck = ovK > 0.5 ? Math.min(1, (ovK - 0.5) / 0.3) : 0, lavaOn = !!(S.lava && S.lava.vent);
      P.hemi.color.copy(base.hemiC); P.hemi.groundColor.copy(base.hemiG);
      if (tod === 'night' && ovK > 0.5)
        P.hemi.intensity = Math.max(P.hemi.intensity * 0.55, base.hemi * 0.9 + base.sun * base.sunEl * 0.35);
      if (deck > 0 && !SS.world.under) {
        if (tod === 'night') {
          P.hemi.color.lerp(NIGHT_C, 0.55 * deck);
          if (lavaOn) P.hemi.groundColor.lerp(LAVA_G, 0.75 * deck);
          else P.hemi.groundColor.lerp(NIGHT_C, 0.3 * deck);
        }
        else if (tod === 'dusk') {
          P.hemi.color.lerp(DUSK_C, 0.6 * deck);
          P.hemi.groundColor.lerp(DUSK_G, 0.6 * deck);
        }
        if (tod === 'night') P.hemi.intensity += flash * 1.2;
      }
      if (flash > 0.01) {
        P.fill.intensity = base.fill + flash * 4;
        P.fill.color.setRGB(0.8, 0.85, 1);
        P.fill.position.copy(flashDir);
      }
      else {
        P.fill.intensity = base.fill;
        P.fill.color.copy(base.fillCol);
        P.fill.position.copy(base.fillPos);
      }
      const sm = P.skyMat.uniforms;
      sm.uDark.value = base.phys ? 0 : oc * (base.storm ? 0.3 : 0.6);
      sm.uFlash.value = flash * 0.8;
      if (P.motes) P.motes.material.opacity = base.motes * Math.max(0, 1 - 2 * (rainA + snowA + ashA));
    }
    // fog colour: toward the sky's horizon under cloud, graded like the sky shader's uDark (a warm haze under a dark
    // storm sky left a hard horizon line once the thicker fog swallowed the sea), lit by the flash
    const dk = base.phys ? 0 : oc * (base.storm ? 0.3 : 0.6), ovK2 = base.ov >= 0 ? base.ov : oc * 0.9;
    fogC.copy(base.haze).lerp(base.skyH, oc * 0.7);
    const fl = 0.2126 * fogC.r + 0.7152 * fogC.g + 0.0722 * fogC.b;
    fogC.setRGB((fogC.r + (fl * 0.55 - fogC.r) * dk * 0.75) * (1 - dk * 0.45),
      (fogC.g + (fl * 0.58 - fogC.g) * dk * 0.75) * (1 - dk * 0.45),
      (fogC.b + (fl * 0.64 - fogC.b) * dk * 0.75) * (1 - dk * 0.45));
    // P76: the fog / haze under the storm deck carries the time of day (night: cold and dark; dusk: the underside of
    // the deck glows warm)
    if (ovK2 > 0.5 && !SS.world.under) {
      const dk2 = Math.min(1, (ovK2 - 0.5) / 0.3);
      if (view.tod === 'night') fogC.multiply(cA.setRGB(1 - 0.5 * dk2, 1 - 0.42 * dk2, 1 - 0.18 * dk2));
      else if (view.tod === 'dusk') fogC.multiply(cA.setRGB(1 + 0.22 * dk2, 1 - 0.04 * dk2, 1 - 0.32 * dk2));
    }
    if (flash > 0.01) fogC.lerp(FLASH_C, Math.min(0.5, flash * 0.3));
    if (scene.fog) {
      scene.fog.density = fogD;
      scene.fog.color.copy(fogC);
    }
    if (U.uHaze) U.uHaze.value.copy(fogC);
    U.uWet.value = we ? we.wet || 0 : 0;
    if (SS.waterView && SS.waterView.weather) SS.waterView.weather(rainA, fogMul * (view.fogK == null ? 1 : view.fogK), fogC, cloud);

    // cover texture (uploaded when the sim's cover grids change)
    if (we && we.snowD) {
      if (we !== coverRef || we.coverVer !== coverVer) {
        refillCover(we);
        coverRef = we;
        coverVer = we.coverVer;
      }
    } else if (coverRef !== null) {
      coverData.fill(0);
      coverTex.needsUpdate = true;
      coverRef = null;
    }
    cpuMs = performance.now() - t0;
  };
  WX.stats = () => ({
    rain: rain.visible ? rain.geometry.instanceCount : 0, flakes: flake.visible ? flake.geometry.instanceCount : 0,
    splash: splash.visible ? splash.geometry.instanceCount : 0, whirl: SS.whirlView ? SS.whirlView.stats().strokes : 0,
    bolts: bolts.length, boltsTotal: nBolts, flash: +flash.toFixed(3), coverUploads, overcast: +oc.toFixed(3), fogMul: +fogMul.toFixed(3),
    audio: !!ac, ms: +cpuMs.toFixed(3)
  });
  WX.meshes = () => [rain, flake, splash].concat(SS.whirlView ? SS.whirlView.meshes() : []);
  WX.cover = () => coverTex;
})(window.SS = window.SS || {});
