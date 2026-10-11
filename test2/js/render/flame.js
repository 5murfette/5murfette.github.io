/* render/flame.js — P45 unified FIRE SYSTEM (user 2026-10-11: "fire needs total remaking, it's not realistic, looks like a game from
 * the 1990s, it should be super realistic and scary looking, dynamic, but efficient"). 100 % procedural: every pixel is computed in a
 * shader from analytic 3D noise and a black-body ramp (hard rule: no fire images / textures, none generated either).
 * One module draws EVERY fire of the game: burning ground (napalm / oil / gel, grass), trees, props and car wrecks, worms, the
 * flamethrower stream, rocket exhaust, the blowtorch and the explosion fireball. Callers only submit SOURCES; the module spawns,
 * moves and draws the particles:
 *   FL.src(x, y, z, R, H, I, soot)   a flame source this frame: ground radius R (m), flame height H (m), intensity I (0..1.5), soot 0..1
 *                                    (how much dark smoke the fire makes); called every frame while it burns (immediate mode)
 *   FL.handle(seed) -> h             a persistent source (position.set / scale.set shims = the old pooled flame mesh): bodies.js flame()
 *   FL.free(h)                       drop a handle
 *   FL.tongue(x,y,z, dx,dy,dz, w, len, life, I)  one tongue along a direction (flamethrower droplets, rocket exhaust, torch)
 *   FL.fireball(x, y, z, Rf, W3)     the blast fireball: rolling white-yellow puffs that cool into soot, embers, a lingering lick
 *   FL.update(S, dt, camera)         once per frame (render/view.js): culls, spawns, integrates, uploads, lights, haze list
 * Look (what makes it read as real fire, not a sprite): the flame is a FIELD, not a picture: each particle is a tall tongue quad
 * (cylindrical billboard, leaning with the wind) whose density is carved by 3D fbm sampled in WORLD space, domain-warped and scrolled
 * up the flame axis, so neighbouring tongues share one continuous turbulent body; temperature falls with height and age and maps
 * to a black-body colour (dark red rim ~800 K, orange, yellow-white core ~1900 K, radiance ~ (T / 1500)^3.2: HDR, ACES tonemapped);
 * blended PREMULTIPLIED (emission + occlusion) so the cool edges and the soot-black tips darken what is behind them instead of
 * washing it out; above the flames dark soot smoke rolls up lit from below by the fire's glow; embers rise with curl-noise wander;
 * the strongest two fire clusters drive flickering point lights; the biggest fires feed the heat-haze list (render/lens.js).
 * Presentation only (Math.random is fine: not in the sim). Porting: a GPU particle system (Niagara / VFX Graph / Box3D demo
 * renderer): the pools below are the particle buffers, the shaders the particle materials.
 * Data: struct-of-arrays pools capped by the quality (Q.particles): FIRE (tongues / puffs), SMOKE, EMBER; 3 draw calls. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const FL = SS.flameView = {};
  const CAP_F = 3200, CAP_S = 900, CAP_E = 520, CAP_B = 190, MAXSRC = 640;
  let capF = CAP_F, capS = CAP_S, capE = CAP_E, capB = CAP_B, lightN = 2;
  let scene = null, Q = null, meshF = null, meshS = null, meshE = null, meshB = null, lights = [], time = 0;
  const U = { uTime: { value: 0 }, uWind: { value: new T.Vector2() }, uSun: { value: new T.Vector3(-0.4, 0.7, 0.6) }, uSunC: { value: new T.Color(1, 0.95, 0.85) },
    uSky: { value: new T.Color(0.55, 0.6, 0.7) }, uGnd: { value: new T.Color(0.3, 0.25, 0.2) }, uDay: { value: 1 } };

  /* ---------- pools (struct of arrays) ---------- */
  const mk = n => new Float32Array(n);
  const F = { x: mk(CAP_F), y: mk(CAP_F), z: mk(CAP_F), vx: mk(CAP_F), vy: mk(CAP_F), vz: mk(CAP_F), age: mk(CAP_F), life: mk(CAP_F), w: mk(CAP_F), h: mk(CAP_F),
    seed: mk(CAP_F), kind: mk(CAP_F), I: mk(CAP_F), ax: mk(CAP_F), ay: mk(CAP_F), az: mk(CAP_F), drag: mk(CAP_F), grow: mk(CAP_F) };
  const Sm = { x: mk(CAP_S), y: mk(CAP_S), z: mk(CAP_S), vx: mk(CAP_S), vy: mk(CAP_S), vz: mk(CAP_S), age: mk(CAP_S), life: mk(CAP_S), s0: mk(CAP_S), s1: mk(CAP_S),
    seed: mk(CAP_S), a: mk(CAP_S), glow: mk(CAP_S), tone: mk(CAP_S), rot: mk(CAP_S) };
  const Em = { x: mk(CAP_E), y: mk(CAP_E), z: mk(CAP_E), vx: mk(CAP_E), vy: mk(CAP_E), vz: mk(CAP_E), age: mk(CAP_E), life: mk(CAP_E), s: mk(CAP_E), seed: mk(CAP_E), T0: mk(CAP_E) };
  const Bd = { x: mk(CAP_B), y: mk(CAP_B), z: mk(CAP_B), nx: mk(CAP_B), ny: mk(CAP_B), nz: mk(CAP_B), age: mk(CAP_B), life: mk(CAP_B), r: mk(CAP_B), seed: mk(CAP_B), I: mk(CAP_B) };
  let nF = 0, nS = 0, nE = 0, nB = 0;
  const KB = Object.keys(Bd);
  const KF = Object.keys(F), KS = Object.keys(Sm), KE = Object.keys(Em);
  function compact(P, keys, n, alive) {                 // keep the order (stable draw order = no flicker)
    let w = 0;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      if (w !== i) for (let k = 0; k < keys.length; k++) { const a = P[keys[k]]; a[w] = a[i]; }
      w++;
    }
    return w;
  }
  const rnd = (a, b) => a + Math.random() * (b - a);

  /* ---------- sources of this frame ---------- */
  const S0 = { x: mk(MAXSRC), y: mk(MAXSRC), z: mk(MAXSRC), R: mk(MAXSRC), H: mk(MAXSRC), I: mk(MAXSRC), soot: mk(MAXSRC), bed: mk(MAXSRC) };
  let nSrc = 0;
  FL.src = function (x, y, z, R, H, I, soot, bed) {
    if (nSrc >= MAXSRC) return;
    const i = nSrc++; S0.x[i] = x; S0.y[i] = y; S0.z[i] = z; S0.R[i] = R; S0.H[i] = H; S0.I[i] = I; S0.soot[i] = soot == null ? 0.8 : soot; S0.bed[i] = bed || 0;
  };
  const handles = [];
  FL.handle = function (seed) {
    const h = { seed: seed || 0, I: 1, soot: 0.8, live: true, x: 0, y: 0, z: 0, sx: 1, sy: 1,
      position: { set(x, y, z) { h.x = x; h.y = y; h.z = z; } }, scale: { set(a, b) { h.sx = a; h.sy = b; } } };
    handles.push(h); return h;
  };
  FL.free = function (h) { h.live = false; const i = handles.indexOf(h); if (i >= 0) handles.splice(i, 1); };

  /* ---------- spawners ---------- */
  // one tongue: base (x,y,z), velocity, width w, length len along axis (default up), life s, brightness I; kind 0 (rising tongue) / 2 (directed jet)
  function tongue(x, y, z, vx, vy, vz, w, len, life, I, kind, ax, ay, az, drag) {
    if (nF >= capF) return;
    const i = nF++;
    F.x[i] = x; F.y[i] = y; F.z[i] = z; F.vx[i] = vx; F.vy[i] = vy; F.vz[i] = vz; F.age[i] = 0; F.life[i] = life; F.w[i] = w; F.h[i] = len;
    F.seed[i] = Math.random(); F.kind[i] = kind; F.I[i] = I; F.ax[i] = ax; F.ay[i] = ay; F.az[i] = az; F.drag[i] = drag || 0; F.grow[i] = 0;
  }
  FL.tongue = function (x, y, z, dx, dy, dz, w, len, life, I) {
    const l = Math.hypot(dx, dy, dz) || 1; tongue(x, y, z, 0, 0, 0, w, len, life, I, 2, dx / l, dy / l, dz / l, 0);
  };
  function puff(x, y, z, vx, vy, vz, r, life, T0, drag, grow) {
    if (nF >= capF) return;
    const i = nF++;
    F.x[i] = x; F.y[i] = y; F.z[i] = z; F.vx[i] = vx; F.vy[i] = vy; F.vz[i] = vz; F.age[i] = 0; F.life[i] = life; F.w[i] = 0; F.h[i] = r;
    F.seed[i] = Math.random(); F.kind[i] = 1; F.I[i] = T0 / 1000; F.ax[i] = 0; F.ay[i] = 1; F.az[i] = 0; F.drag[i] = drag; F.grow[i] = grow;
  }
  function smoke(x, y, z, vx, vy, vz, s0, s1, life, a, glow, tone) {
    if (nS >= capS) return;
    const i = nS++;
    Sm.x[i] = x; Sm.y[i] = y; Sm.z[i] = z; Sm.vx[i] = vx; Sm.vy[i] = vy; Sm.vz[i] = vz; Sm.age[i] = 0; Sm.life[i] = life; Sm.s0[i] = s0; Sm.s1[i] = s1;
    Sm.seed[i] = Math.random(); Sm.a[i] = a; Sm.glow[i] = glow; Sm.tone[i] = tone; Sm.rot[i] = rnd(0, 6.283);
  }
  FL.smoke = smoke;
  function ember(x, y, z, vx, vy, vz, s, life, T0) {
    if (nE >= capE) return;
    const i = nE++;
    Em.x[i] = x; Em.y[i] = y; Em.z[i] = z; Em.vx[i] = vx; Em.vy[i] = vy; Em.vz[i] = vz; Em.age[i] = 0; Em.life[i] = life; Em.s[i] = s; Em.seed[i] = Math.random(); Em.T0[i] = T0;
  }
  FL.ember = ember;
  /* a burst of sparks (something just caught fire): n embers thrown out and up */
  FL.sparks = function (x, y, z, n, sp) {
    const qn = Math.max(0.4, Q ? Q.particles : 1); n = Math.round(n * qn);
    for (let i = 0; i < n; i++) { const d = rnd(0, 6.283), v = rnd(0.5, 1.0) * sp; ember(x, y, z, Math.cos(d) * v, rnd(1.5, 4.5) * sp * 0.5, Math.sin(d) * v, rnd(0.03, 0.07), rnd(0.8, 2.2), rnd(1700, 2200)); }
  };
  /* the glowing / charred bed: a disc lying on the ground (tilted to the surface normal from the density field), it glows while the
   * fire is young, cools to dull coals and ends as a charred patch that fades out */
  const nrmTmp = { x: 0, y: 1, z: 0 };
  function bed(x, y, z, r, life, I) {
    if (nB >= capB) return;
    const i = nB++, W = SS.world;
    nrmTmp.x = 0; nrmTmp.y = 1; nrmTmp.z = 0; if (W && W.normal) W.normal(x, y - 0.05, z, nrmTmp);
    if (nrmTmp.y < 0.35) { nrmTmp.x = 0; nrmTmp.y = 1; nrmTmp.z = 0; }
    Bd.x[i] = x + nrmTmp.x * 0.035; Bd.y[i] = y + nrmTmp.y * 0.035; Bd.z[i] = z + nrmTmp.z * 0.035; Bd.nx[i] = nrmTmp.x; Bd.ny[i] = nrmTmp.y; Bd.nz[i] = nrmTmp.z;
    Bd.age[i] = 0; Bd.life[i] = life; Bd.r[i] = r; Bd.seed[i] = Math.random(); Bd.I[i] = I;
  }
  const bedT = new Map();
  /* a moving jet (rocket exhaust): tongues along the nozzle's path since the last call, pointing back along dir (unit); key = the owner */
  FL.exhaust = function (key, x, y, z, dx, dy, dz, len, w, I, dt) {
    const last = jetLast.get(key); jetLast.set(key, [x, y, z, time]);
    if (!Q || dt <= 0) return;
    const qn = Math.max(0.4, Q.particles), px = last && time - last[3] < 0.3 ? last[0] : x, py = last && time - last[3] < 0.3 ? last[1] : y, pz = last && time - last[3] < 0.3 ? last[2] : z;
    let k = 95 * I * qn * dt + Math.random(); k = Math.floor(k);
    for (let j = 0; j < k; j++) {
      const t = Math.random(), ox = px + (x - px) * t, oy = py + (y - py) * t, oz = pz + (z - pz) * t, rr = w * 0.18;
      tongue(ox + rnd(-rr, rr), oy + rnd(-rr, rr), oz + rnd(-rr, rr), dx * 2.5, dy * 2.5, dz * 2.5, w * rnd(0.7, 1.2), len * rnd(0.7, 1.2), rnd(0.16, 0.3), I * rnd(0.9, 1.2), 2, dx, dy, dz, 1.2);
    }
    puff(x + dx * w * 0.5, y + dy * w * 0.5, z + dz * w * 0.5, dx * 2, dy * 2, dz * 2, w * 0.75, 0.09, 2900, 6, 0.4);                      // the white-hot core at the nozzle
    let ks = 26 * qn * dt + Math.random(); ks = Math.floor(ks);
    for (let j = 0; j < ks; j++) { const t = Math.random(); smoke(px + (x - px) * t + dx * 0.4, py + (y - py) * t + dy * 0.4, pz + (z - pz) * t + dz * 0.4, dx * 1.2 + rnd(-0.3, 0.3), dy * 1.2 + rnd(0.2, 0.7), dz * 1.2 + rnd(-0.3, 0.3), w * 0.5, w * rnd(2.2, 3.6), rnd(1.2, 2.2), 0.2, 0.5, 0.1); }
  };
  /* the blast fireball (render/fx.js explosion): Rf = fireball radius (m), W3 = charge^(1/3). A hot white core, rolling lobes that
   * cool through orange to soot-brown, a rising afterburn lick, embers. fade < 1 for a small / wet one. */
  FL.fireball = function (x, y, z, Rf, W3, k) {
    k = k == null ? 1 : k; const qn = Math.max(0.4, Q ? Q.particles : 1);
    puff(x, y + 0.05, z, 0, 0.6, 0, Rf * 1.25, 0.22 + 0.1 * W3, 3300, 2, 1.0);                          // the white-hot core flash
    const n = Math.round((14 + 16 * W3) * qn * k);
    for (let i = 0; i < n; i++) {                                                                       // lobes thrown out and up, braked by the air
      const a = rnd(0, 6.283), u = rnd(-0.15, 1), r = Math.sqrt(1 - u * u), sp = rnd(2.5, 7.5) * (0.6 + 0.5 * W3);
      puff(x + Math.cos(a) * r * Rf * 0.2, y + 0.1 + Math.max(0, u) * Rf * 0.2, z + Math.sin(a) * r * Rf * 0.2, Math.cos(a) * r * sp, u * sp * 0.9 + 1.2, Math.sin(a) * r * sp,
        Rf * rnd(0.55, 1.15), rnd(0.6, 1.3) * (0.8 + 0.3 * W3), rnd(2300, 3000), 3.0, rnd(1.0, 1.8));
    }
    for (let i = 0; i < Math.round(5 * W3 * qn * k); i++) {                                              // afterburn: tall licks rising from the crater
      const a = rnd(0, 6.283), rr = rnd(0, Rf * 0.6);
      tongue(x + Math.cos(a) * rr, y + 0.05, z + Math.sin(a) * rr, rnd(-0.3, 0.3), rnd(1.5, 3.5), rnd(-0.3, 0.3), Rf * rnd(0.5, 0.8), Rf * rnd(1.4, 2.6), rnd(0.7, 1.3), 1.5, 0, 0, 1, 0, 0);
    }
    for (let i = 0; i < Math.round(26 * W3 * qn * k); i++) {                                             // embers thrown out
      const d = rnd(0, 6.283), sp = rnd(2, 9) * (0.6 + 0.4 * W3);
      ember(x, y + 0.2, z, Math.cos(d) * sp, rnd(2, 8), Math.sin(d) * sp, rnd(0.04, 0.09), rnd(1.0, 2.8), rnd(1700, 2300));
    }
    for (let i = 0; i < Math.round(8 * W3 * qn * k); i++) {                                              // the dark rolling column the ball turns into, lit from below
      const a = rnd(0, 6.283), rr = rnd(0, Rf * 0.5);
      smoke(x + Math.cos(a) * rr, y + Rf * 0.5, z + Math.sin(a) * rr, rnd(-0.6, 0.6), rnd(1.4, 3.2), rnd(-0.6, 0.6), Rf * 0.6, Rf * rnd(1.8, 2.8), rnd(2.4, 4.0), 0.62, 1.2, 1);
    }
  };

  /* ---------- shaders ---------- */
  /* the black-body colour ramp, evaluated here from the physics (Helland's fit of the Planck locus -> linear sRGB, radiance law
   * ~ (T / 1500 K)^3.2) at 300 K steps from 600 K to 3900 K and baked into the shader as constants: no pow / log per pixel */
  function bbRGB(K) {
    const t = K / 100, c = (v) => Math.max(0, Math.min(1, v));
    const r = t <= 66 ? 1 : c(1.2929 * Math.pow(t - 60, -0.1332));
    const g = t <= 66 ? c(0.3901 * Math.log(t) - 0.6318) : c(1.1299 * Math.pow(t - 60, -0.0755));
    const b = t >= 66 ? 1 : t <= 19 ? 0 : c(0.5432 * Math.log(t - 10) - 1.1963);
    const L = Math.min(3.0, Math.pow(K / 1500, 3.2) * 1.55), gg = Math.pow(g, 2.2), bb = Math.min(Math.pow(b, 2.2), gg * 0.62);
    return [Math.pow(Math.max(r, g), 2.2) * L, gg * L, bb * L];
  }
  const RAMP = (() => { const v = []; for (let K = 600; K <= 3900; K += 300) v.push('vec3(' + bbRGB(K).map(x => x.toFixed(4)).join(', ') + ')'); return 'const vec3 RAMP[12] = vec3[12](' + v.join(', ') + ');'; })();
  const NOISE = /* glsl */`
    float h2(vec2 p){ p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.x); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      return mix(mix(h2(i), h2(i + vec2(1.0, 0.0)), f.x), mix(h2(i + vec2(0.0, 1.0)), h2(i + vec2(1.0, 1.0)), f.x), f.y); }
    ${RAMP}
    vec3 emis(float K){ float u = clamp((K - 600.0) / 300.0, 0.0, 10.999); int i = int(u); return mix(RAMP[i], RAMP[i + 1], fract(u)); }`;
  const VS_F = /* glsl */`
    attribute vec2 corner; attribute vec4 iA, iB, iC;      // iA: xyz, width; iB: phase, seed, kind, intensity; iC: axis xyz, length / radius
    uniform vec2 uWind;
    varying vec2 vUv; varying vec4 vB; varying vec3 vWP; varying vec3 vAx; varying vec3 vRt;
    void main(){
      float ph = iB.x, kind = iB.z; vec3 wp, ax;
      if (kind > 0.5 && kind < 1.5) {                           // fireball puff: spherical billboard that swells and slows
        vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), Uu = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float s = iC.w * (0.3 + 0.7 * (1.0 - pow(1.0 - min(ph * 1.25, 1.0), 2.2)));
        wp = iA.xyz + (R * corner.x + Uu * corner.y) * s; ax = vec3(0.0, 1.0, 0.0); vUv = corner; vRt = R;
      } else {                                                  // tongue / jet: cylindrical billboard along its axis, bent by the wind with height
        ax = kind > 1.5 ? iC.xyz : normalize(vec3(uWind.x * 0.075 * (0.35 + ph), 1.0, uWind.y * 0.075 * (0.35 + ph)));
        vec3 tc = cameraPosition - iA.xyz; vec3 rt = cross(ax, tc); float rl = length(rt); rt = rl > 1e-4 ? rt / rl : vec3(1.0, 0.0, 0.0);
        float env = smoothstep(0.0, 0.22, ph);
        float wS = iA.w * (0.5 + 0.5 * env) * (1.0 - 0.4 * smoothstep(0.6, 1.0, ph));
        float hS = iC.w * (0.3 + 0.7 * env) * (1.0 - 0.3 * smoothstep(0.65, 1.0, ph));
        float v = corner.y * 0.5 + 0.5;
        wp = iA.xyz + rt * corner.x * 0.5 * wS * 1.5 + ax * v * hS; vUv = vec2(corner.x, v); vRt = rt;
      }
      vB = iB; vWP = wp; vAx = ax;
      gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
    }`;
  const FS_F = /* glsl */`
    uniform float uTime;
    varying vec2 vUv; varying vec4 vB; varying vec3 vWP; varying vec3 vAx; varying vec3 vRt;
    ${NOISE}
    void main(){
      float ph = vB.x, sd = vB.y, kind = vB.z, I = vB.w;
      float tm = uTime;
      vec3 col; float dens, alpha;
      if (kind > 0.5 && kind < 1.5) {                           // ---- fireball puff: rolling turbulent lobe, hot core -> soot edge
        float r = length(vUv); if (r > 1.0) discard;
        vec2 q = vUv * 2.5 + vec2(sd * 23.0, -ph * 2.6 + sd * 7.0);
        vec2 w = vec2(vn(q * 0.6 + 4.1), vn(q * 0.6 + 8.7)) - 0.5;
        float n = 0.6 * vn(q + w * 2.4) + 0.4 * vn(q * 2.1 + w * 3.0 + 3.7);
        float edge = 1.0 - smoothstep(0.1 + 0.6 * n, 1.0 - 0.6 * ph, r);
        if (edge < 0.012) discard;
        float cool = mix(1.0, 0.27, smoothstep(0.0, 0.85, ph));
        float K = I * 1000.0 * cool * (0.55 + 0.5 * (1.0 - r) + 0.5 * (n - 0.5));
        float soot = smoothstep(0.35, 0.95, 0.9 * n + ph * 0.75 - (1.0 - r) * 0.45);
        col = emis(K) * (1.0 - 0.92 * soot);
        float fade = 1.0 - smoothstep(0.32, 0.92, ph);
        dens = edge * fade; alpha = min(1.0, dens * (0.5 + 0.45 * soot));
      } else {                                                  // ---- tongue / jet
        float y = vUv.y, u = vUv.x;
        if (abs(u) > 0.985 || y > 0.985) discard;
        float along = dot(vWP, vAx), across = dot(vWP, vRt) + 0.5 * dot(vWP, cross(vRt, vAx));
        vec2 P = vec2(across * 1.7, along * 0.62 - tm * 2.7);                                              // world-space streak field: stretched along the flow, shared by all neighbours
        float w = vn(P * 0.5 + vec2(3.1, -tm * 0.35)) - 0.5;                                              // slow large warp: the whole body writhes
        float n1 = vn(P + vec2(w * 2.4, w * 0.9));
        float n2 = vn(P * vec2(2.4, 1.9) + vec2(w * 2.0 + 5.7, -tm * 1.1));
        float n3 = vn(P * vec2(5.3, 3.7) + vec2(w * 3.5 + 1.3, -tm * 2.3));
        float n = 0.5 * n1 + 0.3 * n2 + 0.2 * n3 + (sd - 0.5) * 0.12;
        float uu = u - w * 1.1 * y;                                                                         // sway, more at the tip
        float lw = 1.0 - (kind > 1.5 ? 0.2 : 0.5) * y, ul = uu / lw;
        float body = (n - 0.5) * 1.7 + 0.62 - y * y * 0.6 - y * 0.55 - ul * ul * 0.55;
        float rootF = kind < 0.1 ? 0.22 : 0.55;
        if (kind > 1.5) { body += 0.3; rootF = 0.12; }
        dens = smoothstep(-0.1, 0.7, body) * smoothstep(0.0, rootF, y) * (1.0 - smoothstep(0.55, 1.0, y)) * exp(-3.2 * ul * ul);
        float env = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.5, 1.0, ph));
        dens *= env;
        if (dens < 0.012) discard;
        float hot = clamp(body * 1.1 + (1.0 - y) * 0.3 - ph * 0.4 - 0.12 + (n - 0.5) * 0.5, 0.0, 1.3);
        float K = mix(760.0, 2050.0 + 300.0 * (I - 1.0), pow(clamp(hot * (0.45 + 0.55 * I), 0.0, 1.0), 1.9));
        col = emis(K);
        float soot = smoothstep(0.5, 1.1, y + (0.5 - n) * 0.9 + ph * 0.4) * 0.9;                           // soot-black tips: the flame is not fully burnt
        col *= 1.0 - 0.9 * soot;
        alpha = min(1.0, dens * (0.8 + 0.25 * soot));
      }
      gl_FragColor = vec4(col * dens, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  const VS_S = /* glsl */`
    attribute vec2 corner; attribute vec4 iA, iB, iC;      // iA: xyz, size; iB: phase, seed, alpha, glow; iC: rot, tone
    varying vec2 vUv; varying vec4 vB; varying vec3 vP; varying float vTone;
    void main(){
      vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), Uu = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      float c = cos(iC.x), s = sin(iC.x); vec2 q = mat2(c, s, -s, c) * corner;
      vUv = corner; vB = iB; vP = iA.xyz; vTone = iC.y;
      vB.z *= smoothstep(0.4, 1.3, length(cameraPosition - iA.xyz) / iA.w);                  // the camera inside a puff: it thins out instead of filling the screen
      gl_Position = projectionMatrix * viewMatrix * vec4(iA.xyz + (R * q.x + Uu * q.y) * iA.w, 1.0);
    }`;
  const FS_S = /* glsl */`
    uniform float uTime, uDay; uniform vec3 uSun, uSunC, uSky, uGnd;
    varying vec2 vUv; varying vec4 vB; varying vec3 vP; varying float vTone;
    ${NOISE}
    void main(){
      float r = length(vUv); if (r > 1.0) discard;
      float ph = vB.x, sd = vB.y;
      vec2 q = vUv * 1.5 + vec2(sd * 19.0, ph * 1.3);
      vec2 w = vec2(vn(q * 0.8 + 2.0), vn(q * 0.8 + 6.0)) - 0.5;
      float n = 0.65 * vn(q + w * 1.4) + 0.35 * vn(q * 2.1 + w * 2.0 + 3.3);
      float dens = (1.0 - smoothstep(0.1 + 0.55 * n, 1.0, r)) * (0.45 + 0.9 * n);
      float fade = smoothstep(0.0, 0.12, ph) * (1.0 - smoothstep(0.55, 1.0, ph));
      float a = dens * vB.z * fade; if (a < 0.006) discard;
      vec3 nrm = normalize(vec3(vUv, sqrt(max(0.0, 1.0 - r * r)) + 0.3));
      vec3 sunV = normalize((viewMatrix * vec4(uSun, 0.0)).xyz);
      float lam = 0.5 + 0.5 * dot(nrm, sunV);
      vec3 base = mix(vec3(0.5), vec3(0.045, 0.04, 0.038), vTone);
      vec3 amb = mix(uGnd, uSky, 0.5 + 0.5 * vUv.y);
      vec3 c = base * (amb * 0.75 + uSunC * lam * 0.45);
      float g = vB.w * pow(1.0 - ph, 3.0);                                          // lit from below by the fire it rises from
      c += vec3(1.0, 0.36, 0.07) * g * pow(0.5 - 0.5 * vUv.y, 1.5) * (0.3 + 0.9 * n) * (0.8 + 0.8 * (1.0 - uDay));
      gl_FragColor = vec4(c, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  const VS_E = /* glsl */`
    attribute vec2 corner; attribute vec4 iA, iB;          // iA: xyz, size; iB: phase, seed, T, 0
    varying vec2 vUv; varying vec4 vB;
    void main(){
      vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), Uu = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vUv = corner; vB = iB;
      gl_Position = projectionMatrix * viewMatrix * vec4(iA.xyz + (R * corner.x + Uu * corner.y) * iA.w, 1.0);
    }`;
  const FS_E = /* glsl */`
    uniform float uTime; varying vec2 vUv; varying vec4 vB;
    ${NOISE}
    void main(){
      float r2 = dot(vUv, vUv); if (r2 > 1.0) discard;
      float ph = vB.x, fl = 0.55 + 0.45 * sin(uTime * (17.0 + 23.0 * vB.y) + vB.y * 80.0) * sin(uTime * 9.0 + vB.y * 31.0);
      float K = vB.z * (1.0 - 0.45 * ph);
      float a = exp(-r2 * 3.2) * fl * (1.0 - smoothstep(0.6, 1.0, ph));
      gl_FragColor = vec4(emis(K) * a * 1.6, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  const VS_B = /* glsl */`
    attribute vec2 corner; attribute vec4 iA, iB, iC;      // iA: xyz, radius; iB: phase, seed, intensity; iC: surface normal
    varying vec2 vUv; varying vec4 vB;
    void main(){
      vec3 n = normalize(iC.xyz), t1 = normalize(cross(n, vec3(0.0, 0.0, 1.0))), t2 = cross(n, t1);
      vUv = corner; vB = iB;
      gl_Position = projectionMatrix * viewMatrix * vec4(iA.xyz + (t1 * corner.x + t2 * corner.y) * iA.w, 1.0);
    }`;
  const FS_B = /* glsl */`
    uniform float uTime; varying vec2 vUv; varying vec4 vB;
    ${NOISE}
    void main(){
      float r = length(vUv); if (r > 1.0) discard;
      float ph = vB.x, sd = vB.y, I = vB.z;
      vec2 P = vUv * 2.2 + sd * 37.0;
      float w = vn(P * 0.7 + 2.0) - 0.5;
      float edge = vn(P * 1.4 + w * 2.0 + 9.0);
      float mask = 1.0 - smoothstep(0.45 + 0.3 * edge, 1.0, r);
      if (mask < 0.01) discard;
      float c1 = abs(vn(P * 1.9 + w * 1.6) - 0.5), c2 = abs(vn(P * 4.1 + 7.0 + w) - 0.5);
      float crack = ((1.0 - smoothstep(0.0, 0.1, c1)) + 0.55 * (1.0 - smoothstep(0.0, 0.07, c2))) * smoothstep(0.22, 0.62, vn(P * 1.1 + 3.0 + w));
      float fl = 0.6 + 0.6 * vn(P * 2.6 + vec2(uTime * 1.2, -uTime * 0.8) + sd * 5.0);
      float heat = smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.3, 0.8, ph));
      float K = 650.0 + 800.0 * heat * fl * I * (0.45 + 0.55 * crack);
      vec3 e = emis(K) * (0.14 + 0.95 * crack) * heat * mask * 1.5;
      float a = mask * 0.8 * smoothstep(0.0, 0.05, ph) * (1.0 - smoothstep(0.82, 1.0, ph));
      gl_FragColor = vec4(e, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  function system(vs, fs, cap, nAttr, order, premult, additive) {
    const g = new T.InstancedBufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(12), 3));
    g.setAttribute('corner', new T.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const at = {};
    for (const nm of nAttr) { at[nm] = new T.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(T.DynamicDrawUsage); g.setAttribute(nm, at[nm]); }
    g.instanceCount = 0;
    const mat = new T.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: U, transparent: true, depthWrite: false, side: T.DoubleSide,
      blending: additive ? T.AdditiveBlending : T.NormalBlending, premultipliedAlpha: !!premult });
    mat.userData.sectionMargin = 2.0;
    const mesh = new T.Mesh(g, mat); mesh.frustumCulled = false; mesh.renderOrder = order; mesh.visible = false; scene.add(mesh);
    return { g, mesh, at };
  }
  FL.init = function (sc, quality) {
    scene = sc; Q = quality || { particles: 1 };
    const k = Q.particles == null ? 1 : Q.particles;
    capF = Math.max(300, Math.round(CAP_F * k)); capS = Math.max(120, Math.round(CAP_S * k)); capE = Math.max(80, Math.round(CAP_E * k)); capB = Math.max(60, Math.round(CAP_B * k)); lightN = k >= 0.99 ? 2 : k >= 0.6 ? 1 : 0;
    meshS = system(VS_S, FS_S, CAP_S, ['iA', 'iB', 'iC'], 8, false, false);
    meshF = system(VS_F, FS_F, CAP_F, ['iA', 'iB', 'iC'], 9, true, false);
    meshE = system(VS_E, FS_E, CAP_E, ['iA', 'iB'], 10, false, true);
    meshB = system(VS_B, FS_B, CAP_B, ['iA', 'iB', 'iC'], 7, true, false);
    meshB.mesh.material.polygonOffset = true; meshB.mesh.material.polygonOffsetFactor = -2; meshB.mesh.material.polygonOffsetUnits = -2;
    for (let i = 0; i < lightN; i++) { const l = new T.PointLight(0xff7a2a, 0, 14, 2); scene.add(l); lights.push(l); }
  };
  FL.look = function (L, sk) {
    if (!L) return;
    if (L.sunDir) U.uSun.value.set(L.sunDir[0], L.sunDir[1], L.sunDir[2]).normalize();
    if (L.sun) U.uSunC.value.set(L.sun).multiplyScalar(Math.min(1.2, (L.sunI || 3) / 3));
    if (sk && sk.horizon) U.uSky.value.setRGB(sk.horizon[0], sk.horizon[1], sk.horizon[2], T.SRGBColorSpace);
    if (L.hemiG) U.uGnd.value.set(L.hemiG);
    U.uDay.value = Math.min(1, (L.sunI || 3) / 3);
  };
  FL.clear = function () {
    nF = nS = nE = nB = 0; nSrc = 0; bedT.clear(); burnSeen.clear(); bareT.clear(); wormT.clear(); handles.length = 0; jetLast.clear();
    for (const l of lights) l.intensity = 0;
    for (const m of [meshF, meshS, meshE, meshB]) if (m) { m.g.instanceCount = 0; m.mesh.visible = false; }
    hazeN = 0;
  };

  /* ---------- per-frame: sources -> particles ---------- */
  const fr = new T.Frustum(), pm = new T.Matrix4(), sph = new T.Sphere();
  const jetLast = new Map();
  let hazeN = 0; const haze = new Float32Array(8 * 4);
  FL.haze = () => ({ n: FL.hide ? 0 : hazeN, d: haze });                // the strongest fires on screen: x, y, z, strength (render/lens.js)
  let flick = 0;
  /* pass 1: the wanted spawn rates of a source (per second) -> RT / RS / RE; pass 2 spawns them scaled to the budgets, so a huge fire
   * (hundreds of cells) costs what a medium one does: fewer, wider tongues instead of ever more overdraw */
  const RT = mk(MAXSRC), RS = mk(MAXSRC), RE = mk(MAXSRC), WT = mk(MAXSRC), LF = mk(MAXSRC);
  let totT = 0, totS = 0, totE = 0;
  function rates(i, cam) {
    const R = S0.R[i], H = S0.H[i], I = S0.I[i], soot = S0.soot[i];
    const dx = S0.x[i] - cam.x, dz = S0.z[i] - cam.z, dy = S0.y[i] - cam.y, dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const lod = Math.min(1, 1.4 - dist / 120); if (lod <= 0.05) { RT[i] = RS[i] = RE[i] = 0; return; }
    const qn = Math.max(0.4, Q.particles);
    const wT = Math.max(0.45, Math.min(H * 0.8, R * 2.0 + 0.3)), life0 = 0.7 + 0.25 * Math.sqrt(H);
    WT[i] = wT; LF[i] = life0;
    RT[i] = I * (2.4 + 3.2 * R * R / (wT * wT)) * lod / (0.55 + 0.45 * life0);
    RS[i] = soot * (0.5 + 1.6 * R) * (0.5 + 0.5 * I) * lod * Math.min(1.5, 0.6 + H * 0.4) * 0.6;
    RE[i] = I * (0.9 + 2.2 * R) * 0.9 * lod * qn;
    totT += RT[i]; totS += RS[i]; totE += RE[i];
  }
  function spawnFromSource(i, dt, kT, kS, kE) {
    const x = S0.x[i], y = S0.y[i], z = S0.z[i], R = S0.R[i], H = S0.H[i], I = S0.I[i], soot = S0.soot[i], wT = WT[i] * Math.min(1.8, 1 + 0.5 * (1 / kT - 1)), life0 = LF[i];
    const wx = U.uWind.value.x, wz = U.uWind.value.y;
    let k = RT[i] * kT * dt + Math.random(); k = Math.floor(k);
    for (let j = 0; j < k; j++) {
      const a = rnd(0, 6.283), rr = R * Math.sqrt(Math.random()) * 0.85, life = life0 * rnd(0.75, 1.3), hh = H * rnd(0.8, 1.3) * (0.6 + 0.4 * Math.min(1.4, I));
      tongue(x + Math.cos(a) * rr, y + rnd(-0.02, 0.1), z + Math.sin(a) * rr, wx * 0.18 + rnd(-0.15, 0.15), 0.4 * hh / life, wz * 0.18 + rnd(-0.15, 0.15), Math.min(1.6, wT * rnd(0.8, 1.35)), hh, life, Math.min(1.5, I * rnd(0.85, 1.1)), 0, 0, 1, 0, 0);
    }
    // detached licks: short fast tongues torn off the upper body, they rise and thin out as separate wisps
    let kw = RT[i] * kT * dt * 0.28 + Math.random(); kw = Math.floor(kw);
    for (let j = 0; j < kw; j++) {
      const a = rnd(0, 6.283), rr = R * Math.sqrt(Math.random()) * 0.7, hh = H * rnd(0.35, 0.6), life = life0 * rnd(0.5, 0.85);
      tongue(x + Math.cos(a) * rr, y + H * rnd(0.45, 0.8), z + Math.sin(a) * rr, wx * 0.25 + rnd(-0.3, 0.3), rnd(1.6, 2.8) * (0.6 + 0.4 * H), wz * 0.25 + rnd(-0.3, 0.3), Math.min(0.7, wT * rnd(0.35, 0.55)), hh, life, Math.min(1.3, I * rnd(0.7, 0.95)), 0.25, 0, 1, 0, 0);
    }
    // ground bed: one disc per ~1.5 m cell every ~7 s while it burns (embers, cracks, char)
    if (S0.bed[i] > 0.05) {
      const key = (Math.floor(x / 1.5) + 4096) * 8192 + Math.floor(z / 1.5) + 4096, lt = bedT.get(key);
      if (lt === undefined || time - lt > 7.0) { bedT.set(key, time); bed(x + rnd(-0.2, 0.2), y, z + rnd(-0.2, 0.2), Math.min(2.3, 1.1 + R * 0.5) * rnd(0.85, 1.2), rnd(10, 14), Math.min(1.3, S0.bed[i] * (0.6 + 0.5 * I))); }
    }
    // soot smoke from the flame tops (alpha, rolling, lit from below by the fire)
    let ks = RS[i] * kS * dt + Math.random(); ks = Math.floor(ks);
    for (let j = 0; j < ks; j++) {
      const a = rnd(0, 6.283), rr = R * Math.sqrt(Math.random()) * 0.6, big = (0.5 + 0.6 * R + 0.25 * H) * Math.min(1.6, 1 + 0.5 * (1 / kS - 1));
      smoke(x + Math.cos(a) * rr, y + H * rnd(0.75, 1.2), z + Math.sin(a) * rr, wx * 0.45 + rnd(-0.2, 0.2), rnd(1.0, 1.8) * (0.7 + 0.4 * I), wz * 0.45 + rnd(-0.2, 0.2),
        0.4 * big, rnd(1.1, 1.8) * big, rnd(3.4, 5.8), (0.3 + 0.3 * soot) * Math.min(1.2, I + 0.3), Math.min(1.3, I * 0.9), 0.6 + 0.4 * soot);
    }
    // embers lifted by the heat
    let ke = RE[i] * kE * dt + Math.random(); ke = Math.floor(ke);
    for (let j = 0; j < ke; j++) {
      const a = rnd(0, 6.283), rr = R * Math.sqrt(Math.random());
      ember(x + Math.cos(a) * rr, y + rnd(0.1, 0.5) * H, z + Math.sin(a) * rr, wx * 0.5 + rnd(-0.5, 0.5), rnd(1.2, 3.4) * (0.6 + 0.4 * H), wz * 0.5 + rnd(-0.5, 0.5), rnd(0.03, 0.07), rnd(1.1, 2.8), rnd(1500, 1950));
    }
  }

  /* FILL BUDGET: the cost of fire is its overdraw (pixels x layers), not its particle count, and that grows with the zoom. Every frame
   * the projected area (device px) of the live sprites is summed; the spawn rates are steered (a slow controller) so the sum stays
   * under the quality's budget: a huge or very close fire gets fewer, wider tongues / puffs instead of a slower frame. */
  let fillF = 0, fillS = 0, gF = 1, gS = 1, pxH = 1000, tanH = 0.4, camX = 0, camY = 0, camZ = 0;
  const bsz = new T.Vector2();
  const BUD_F = 16e6, BUD_S = 8e6;                           // device px of overdraw (flame quads, smoke discs) at Q.particles = 1
  FL.update = function (S, dt, camera) {
    if (!meshF) return;
    if (jetLast.size > 24) for (const [k, v] of jetLast) if (time - v[3] > 1) jetLast.delete(k);
    dt = Math.min(0.1, Math.max(0, dt || 0)); time += dt; U.uTime.value = time;
    if (S && S.wind && S.wind.mean) U.uWind.value.set(S.wind.mean.x || 0, S.wind.mean.z || 0);
    const cp = camera.position; camX = cp.x; camY = cp.y; camZ = cp.z;
    { const r = SS.view && SS.view.renderer && SS.view.renderer(); if (r) { r.getDrawingBufferSize(bsz); pxH = bsz.y; } tanH = Math.tan(camera.fov * Math.PI / 360); }
    { const qb = Math.max(0.4, Q.particles); gF = Math.max(0.12, Math.min(1, gF * Math.pow(Math.min(4, BUD_F * qb / Math.max(1, fillF)), 0.12))); gS = Math.max(0.1, Math.min(1, gS * Math.pow(Math.min(4, BUD_S * qb / Math.max(1, fillS)), 0.12))); }
    fillF = fillS = 0;
    for (const h of handles) FL.src(h.x, h.y, h.z, Math.max(0.14, h.sx * 0.58) * (h.big ? 1.3 : h.sx >= 2 ? 1.25 : 1), Math.max(0.3, h.sy * 1.1) * (h.big ? 1.5 : h.sx >= 2 ? 1.45 : 1), h.I * 1.15, h.soot, h.sx >= 2 ? 0.6 : 0);
    if (S) { bodyFires(S); bareTrees(S); }
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); fr.setFromProjectionMatrix(pm);
    // --- spawn (only sources that are on screen, with a margin: the flame is tall and the smoke drifts), within the per-second budgets
    if (dt > 0) {
      totT = totS = totE = 0;
      for (let i = 0; i < nSrc; i++) {
        sph.center.set(S0.x[i], S0.y[i] + S0.H[i] * 0.6, S0.z[i]); sph.radius = S0.R[i] + S0.H[i] * 1.3 + 3;
        if (FL.noCull || fr.intersectsSphere(sph)) rates(i, cp); else RT[i] = RS[i] = RE[i] = 0;
      }
      const qn = Math.max(0.4, Q.particles), kT = Math.min(1, 480 * qn * gF / Math.max(1, totT)), kS = Math.min(1, 34 * qn * gS / Math.max(1, totS)), kE = Math.min(1, 60 * qn / Math.max(1, totE));
      for (let i = 0; i < nSrc; i++) if (RT[i] > 0 || RS[i] > 0) spawnFromSource(i, dt, kT, kS, kE);
    }
    // --- lights: the two strongest clusters (8 m grid), flickering
    if (lightN > 0) lightsFrom(cp);
    nSrc = 0;
    // --- integrate + upload
    const wx = U.uWind.value.x, wz = U.uWind.value.y;
    {
      const aF = meshF.at.iA.array, bF = meshF.at.iB.array, cF = meshF.at.iC.array; let w = 0;
      const alive = integ;
      let cnt = 0;
      for (let i = 0; i < nF; i++) {
        const age = F.age[i] + dt, life = F.life[i];
        if (age >= life) { alive[i] = 0; continue; }
        alive[i] = 1; F.age[i] = age;
        const kind = F.kind[i], sd = F.seed[i];
        if (kind === 1) {                                                           // fireball puff: ballistic, drag, buoyant
          const dk = Math.exp(-F.drag[i] * dt); F.vx[i] *= dk; F.vz[i] *= dk; F.vy[i] = F.vy[i] * dk + 1.6 * dt;
        } else if (kind < 0.5) {                                                    // tongue: wind drift + curl-ish lateral wander
          const t = age + sd * 40;
          F.vx[i] += (wx * 0.35 - F.vx[i]) * Math.min(1, dt * 2) + Math.sin(F.y[i] * 2.1 + t * 3.3) * 0.9 * dt;
          F.vz[i] += (wz * 0.35 - F.vz[i]) * Math.min(1, dt * 2) + Math.sin(F.y[i] * 1.7 - t * 2.7 + 2.0) * 0.9 * dt;
        } else { const dk = Math.exp(-F.drag[i] * dt); F.vx[i] *= dk; F.vy[i] = F.vy[i] * dk; F.vz[i] *= dk; }
        F.x[i] += F.vx[i] * dt; F.y[i] += F.vy[i] * dt; F.z[i] += F.vz[i] * dt;
        const ph = age / life, ddx = F.x[i] - camX, ddy = F.y[i] - camY, ddz = F.z[i] - camZ, pxm = pxH / (2 * tanH * Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) + 1e-3);
        fillF += kind === 1 ? 3.14 * F.h[i] * F.h[i] * pxm * pxm * 0.8 : F.w[i] * 1.5 * F.h[i] * pxm * pxm * 0.55;
        cnt++;
        // compacted write below (after the loop), index i -> its final slot is the running count - 1
        const o = (cnt - 1) * 4;
        aF[o] = F.x[i]; aF[o + 1] = F.y[i]; aF[o + 2] = F.z[i]; aF[o + 3] = kind === 1 ? 0 : F.w[i];
        bF[o] = ph; bF[o + 1] = sd; bF[o + 2] = kind; bF[o + 3] = F.I[i];
        cF[o] = F.ax[i]; cF[o + 1] = F.ay[i]; cF[o + 2] = F.az[i]; cF[o + 3] = F.h[i];
      }
      nF = compact(F, KF, nF, alive); w = nF;
      meshF.g.instanceCount = w; meshF.mesh.visible = w > 0;
      if (w) for (const k in meshF.at) { const a = meshF.at[k]; a.clearUpdateRanges(); a.addUpdateRange(0, w * 4); a.needsUpdate = true; }
    }
    {
      const aS = meshS.at.iA.array, bS = meshS.at.iB.array, cS = meshS.at.iC.array; let cnt = 0;
      for (let i = 0; i < nS; i++) {
        const age = Sm.age[i] + dt, life = Sm.life[i];
        if (age >= life) { integ[i] = 0; continue; }
        integ[i] = 1; Sm.age[i] = age;
        const ph = age / life, t = age + Sm.seed[i] * 30, ddx = Sm.x[i] - camX, ddy = Sm.y[i] - camY, ddz = Sm.z[i] - camZ;
        Sm.vx[i] += ((wx * 0.7 - Sm.vx[i]) * 0.6 + Math.sin(Sm.y[i] * 0.9 + t * 1.3) * 0.5) * dt; Sm.vz[i] += ((wz * 0.7 - Sm.vz[i]) * 0.6 + Math.sin(Sm.y[i] * 0.8 - t * 1.1 + 1.0) * 0.5) * dt;
        Sm.vy[i] += (1.1 * (1 - ph) - 0.12) * dt;
        Sm.x[i] += Sm.vx[i] * dt; Sm.y[i] += Sm.vy[i] * dt; Sm.z[i] += Sm.vz[i] * dt; Sm.rot[i] += 0.12 * dt * (Sm.seed[i] - 0.5);
        const o = cnt * 4; cnt++;
        aS[o] = Sm.x[i]; aS[o + 1] = Sm.y[i]; aS[o + 2] = Sm.z[i]; aS[o + 3] = Sm.s0[i] + (Sm.s1[i] - Sm.s0[i]) * Math.sqrt(ph);
        { const dd = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz), pxm = pxH / (2 * tanH * dd + 1e-3), nf = Math.min(1, Math.max(0, (dd / aS[o + 3] - 0.4) / 0.9)); fillS += Math.min(pxH * pxH * 1.8, 3.14 * aS[o + 3] * aS[o + 3] * pxm * pxm) * 0.7 * nf; }
        bS[o] = ph; bS[o + 1] = Sm.seed[i]; bS[o + 2] = Sm.a[i]; bS[o + 3] = Sm.glow[i];
        cS[o] = Sm.rot[i]; cS[o + 1] = Sm.tone[i]; cS[o + 2] = 0; cS[o + 3] = 0;
      }
      nS = compact(Sm, KS, nS, integ);
      meshS.g.instanceCount = nS; meshS.mesh.visible = nS > 0;
      if (nS) for (const k in meshS.at) { const a = meshS.at[k]; a.clearUpdateRanges(); a.addUpdateRange(0, nS * 4); a.needsUpdate = true; }
    }
    {
      const aE = meshE.at.iA.array, bE = meshE.at.iB.array; let cnt = 0;
      for (let i = 0; i < nE; i++) {
        const age = Em.age[i] + dt, life = Em.life[i];
        if (age >= life) { integ[i] = 0; continue; }
        integ[i] = 1; Em.age[i] = age;
        const t = age * 4 + Em.seed[i] * 50;
        Em.vx[i] += ((wx * 0.6 - Em.vx[i]) * 0.8 + Math.sin(t * 1.9 + Em.y[i]) * 3.0) * dt; Em.vz[i] += ((wz * 0.6 - Em.vz[i]) * 0.8 + Math.sin(t * 1.5 - Em.y[i] + 2.0) * 3.0) * dt;
        Em.vy[i] += (1.1 - 0.5 * Em.vy[i] * 0.2) * dt * (age < life * 0.8 ? 1 : 0.2) - 0.0;
        Em.x[i] += Em.vx[i] * dt; Em.y[i] += Em.vy[i] * dt; Em.z[i] += Em.vz[i] * dt;
        const o = cnt * 4; cnt++;
        aE[o] = Em.x[i]; aE[o + 1] = Em.y[i]; aE[o + 2] = Em.z[i]; aE[o + 3] = Em.s[i];
        bE[o] = age / life; bE[o + 1] = Em.seed[i]; bE[o + 2] = Em.T0[i]; bE[o + 3] = 0;
      }
      nE = compact(Em, KE, nE, integ);
      meshE.g.instanceCount = nE; meshE.mesh.visible = nE > 0;
      if (nE) for (const k in meshE.at) { const a = meshE.at[k]; a.clearUpdateRanges(); a.addUpdateRange(0, nE * 4); a.needsUpdate = true; }
    }
    {
      const aB = meshB.at.iA.array, bB = meshB.at.iB.array, cB = meshB.at.iC.array; let cnt = 0;
      for (let i = 0; i < nB; i++) {
        const age = Bd.age[i] + dt, life = Bd.life[i];
        if (age >= life) { integ[i] = 0; continue; }
        integ[i] = 1; Bd.age[i] = age;
        const o = cnt * 4; cnt++;
        aB[o] = Bd.x[i]; aB[o + 1] = Bd.y[i]; aB[o + 2] = Bd.z[i]; aB[o + 3] = Bd.r[i];
        bB[o] = age / life; bB[o + 1] = Bd.seed[i]; bB[o + 2] = Bd.I[i]; bB[o + 3] = 0;
        cB[o] = Bd.nx[i]; cB[o + 1] = Bd.ny[i]; cB[o + 2] = Bd.nz[i]; cB[o + 3] = 0;
      }
      nB = compact(Bd, KB, nB, integ);
      meshB.g.instanceCount = nB; meshB.mesh.visible = nB > 0;
      if (nB) for (const k in meshB.at) { const a = meshB.at[k]; a.clearUpdateRanges(); a.addUpdateRange(0, nB * 4); a.needsUpdate = true; }
      if (bedT.size > 3000) bedT.clear();
    }
    if (FL.hide === true || FL.hide === 1) meshF.mesh.visible = meshS.mesh.visible = meshE.mesh.visible = meshB.mesh.visible = false;
    else if (FL.hide === 2) meshS.mesh.visible = false; else if (FL.hide === 3) meshF.mesh.visible = false; else if (FL.hide === 4) meshE.mesh.visible = false; else if (FL.hide === 5) meshB.mesh.visible = false;
  };
  const integ = new Uint8Array(CAP_F);

  /* burning worms and trees: the fire is submitted from here (worm positions and tree leaf clusters read straight from the sim state), much bigger than the
   * old handle flame: a worm is a torch, a crown is a bonfire. A new ignition throws a burst of sparks. */
  const burnSeen = new Map();
  function ignite(key, t, x, y, z, n) {
    const last = burnSeen.get(key); burnSeen.set(key, t);
    if (last === undefined || t - last > 0.6) FL.sparks(x, y, z, n, 2.2);
  }
  function bodyFires(S) {
    const SV = SS.view, WH = (SS.CFG && SS.CFG.WORM_H) || 0.7;
    for (const w of S.worms) {
      if (w.dead || !(S.time - (w.burnT == null ? -9 : w.burnT) < 0.3) || !(SV && SV.inSlab ? SV.inSlab(S, w.pos) : true)) continue;
      const dx = camX - w.pos.x, dz = camZ - w.pos.z, l = Math.hypot(dx, dz) || 1, ox = dx / l * 0.3, oz = dz / l * 0.3, key = 'w' + w.id, last = burnSeen.get(key);
      if (last === undefined || S.time - last > 0.6) wormT.set(w.id, S.time);
      ignite(key, S.time, w.pos.x, w.pos.y, w.pos.z, 26);
      const k = Math.min(1, 0.35 + (S.time - wormT.get(w.id)) * 0.9);
      const tj = S.time * 9 + w.id * 3.1, jx = Math.sin(tj) * 0.12, jz = Math.cos(tj * 0.8) * 0.12;
      FL.src(w.pos.x + ox + jx, w.pos.y - WH * 0.5, w.pos.z + oz + jz, 0.2 * k, 0.65 * k, 1.1, 0.95, 0);
      FL.src(w.pos.x + ox * 0.7 - oz * 0.5 - jx, w.pos.y - WH * 0.1, w.pos.z + oz * 0.7 + ox * 0.5 + jz, 0.14 * k, 0.55 * k, 1.1, 0.95, 0);
      FL.src(w.pos.x + ox * 0.7 + oz * 0.5 + jz, w.pos.y + WH * 0.25, w.pos.z + oz * 0.7 - ox * 0.5 - jx, 0.13 * k, 0.5 * k, 1.05, 0.95, 0);
      if (Math.random() < 0.25) FL.smoke(w.pos.x + jx, w.pos.y + WH * 0.5, w.pos.z + jz, rnd(-0.2, 0.2), rnd(0.8, 1.4), rnd(-0.2, 0.2), 0.15, 0.7, rnd(1.5, 2.4), 0.3, 0.6, 1);
    }
  }
  const wormT = new Map(), bareT = new Map();
  /* a tree whose leaves the sim has burnt off keeps burning on the bare branches for ~5 s (render only): small flames and embers along the branches, fading, then charred */
  function bareTrees(S) {
    const vis = SS.fireView && SS.fireView.vis;
    for (const t of S.trees || []) {
      if (!t.alive) continue;
      let t0 = bareT.get(t.id);
      if (t0 === undefined) {
        if (!(t.burn >= 0) || !(t.leaf0 > 0)) continue;
        let a = 0; for (const l of t.leaf) if (l.s >= 0) a += l.f * l.r * l.r;
        if (a / t.leaf0 > 0.3) continue;
        t0 = S.time; bareT.set(t.id, t0);
      }
      const k = 1 - (S.time - t0) / 5; if (k <= 0) continue;
      let n = 0;
      for (const sg of t.seg) {
        if (sg.kind !== 2 || !sg.on || ++n > 14) continue;
        const x = (sg.a.x + sg.b.x) * 0.5, y = (sg.a.y + sg.b.y) * 0.5, z = (sg.a.z + sg.b.z) * 0.5;
        if (vis && !vis(x, z)) continue;
        FL.src(x, y - 0.1, z, 0.22 + 0.2 * k, 0.5 + 0.7 * k, 0.8 + 0.5 * k, 0.9, 0);
        if (Math.random() < 0.08 * k) ember(x, y, z, rnd(-0.4, 0.4), rnd(0.6, 1.8), rnd(-0.4, 0.4), rnd(0.03, 0.06), rnd(0.8, 1.8), rnd(1500, 1900));
      }
    }
  }

  function lightsFrom(cp) {
    // 8 m grid accumulation of the intensity-weighted sources (a handful of cells: no allocation beyond a tiny array)
    const cells = lightCells; cells.length = 0;
    for (let i = 0; i < nSrc; i++) {
      const wgt = S0.I[i] * (0.25 + S0.R[i] * S0.R[i] + S0.H[i] * 0.25); if (wgt < 0.05) continue;
      const gx = Math.floor(S0.x[i] / 8), gz = Math.floor(S0.z[i] / 8);
      let c = null; for (let k = 0; k < cells.length; k++) if (cells[k].gx === gx && cells[k].gz === gz) { c = cells[k]; break; }
      if (!c) { c = { gx, gz, w: 0, x: 0, y: 0, z: 0, ymax: -1e9 }; cells.push(c); }
      c.w += wgt; c.x += S0.x[i] * wgt; c.y += S0.y[i] * wgt; c.z += S0.z[i] * wgt; c.ymax = Math.max(c.ymax, S0.y[i] + S0.H[i]);
    }
    cells.sort((a, b) => b.w - a.w);
    flick = time;
    for (let l = 0; l < lights.length; l++) {
      const L = lights[l], c = cells[l];
      if (!c) { L.intensity += (0 - L.intensity) * 0.2; if (L.intensity < 0.05) L.intensity = 0; continue; }
      const x = c.x / c.w, y = c.y / c.w, z = c.z / c.w;
      const f = 0.8 + 0.12 * Math.sin(flick * 13.1 + l * 2.0) + 0.08 * Math.sin(flick * 27.7 + l) + 0.06 * Math.sin(flick * 51.3);
      const tgt = Math.min(60, 9 * Math.sqrt(c.w)) * (f + 0.05 * Math.sin(flick * 97.0 + l * 5.0)) * (1.15 - 0.55 * U.uDay.value);
      L.position.set(x, y + 0.9 + Math.min(2, c.ymax - y) * 0.4, z);
      L.color.setRGB(1.0, 0.43 + 0.08 * Math.sin(flick * 9.0 + l), 0.14);
      L.distance = 10 + 4 * Math.sqrt(c.w);
      L.intensity += (tgt - L.intensity) * 0.35;
    }
    // heat haze list: the 4 strongest clusters
    hazeN = 0; for (let k = 0; k < Math.min(4, cells.length); k++) { const c = cells[k]; if (c.w < 2.0) break; haze[hazeN * 4] = c.x / c.w; haze[hazeN * 4 + 1] = c.ymax; haze[hazeN * 4 + 2] = c.z / c.w; haze[hazeN * 4 + 3] = Math.min(1, (c.w - 1.5) / 3); hazeN++; }
  }
  const lightCells = [];
  FL.dbg = () => { const o = []; for (let i = 0; i < Math.min(nS, 12); i++) o.push([+Sm.x[i].toFixed(1), +Sm.y[i].toFixed(1), +Sm.z[i].toFixed(1), +(Sm.s0[i] + (Sm.s1[i] - Sm.s0[i]) * Math.sqrt(Sm.age[i] / Sm.life[i])).toFixed(2), +Math.hypot(Sm.x[i] - camX, Sm.y[i] - camY, Sm.z[i] - camZ).toFixed(1)]); return { cam: [camX, camY, camZ].map(v => +v.toFixed(1)), pxH, tanH, o }; };
  FL.hide = false;                                         // tools: skip the draws (cost isolation)
  FL.stats = () => ({ fillF: +(fillF / 1e6).toFixed(1), fillS: +(fillS / 1e6).toFixed(1), gF: +gF.toFixed(2), gS: +gS.toFixed(2), fire: nF, smoke: nS, embers: nE, beds: nB, src: nSrc, handles: handles.length, lights: lights.map(l => +l.intensity.toFixed(1)) });
})(window.SS = window.SS || {});
