/* render/life.js — P62 ambient life (Three.js specific, presentation only; reads the sim state, never writes it; its own SS.math RNG).
 * Small pooled, instanced, CPU-animated systems (a few dozen instances each, flapping / tail wiggle in the vertex shader), all standard materials
 * so the automatic section clip (render/section.js) applies; every system is gated by biome, time of day and weather, and Q.life (0 = nothing on low).
 *   - bird flocks circling far behind the slice (temperate / canyon / alpine, day + dusk), seagulls over the shore, bats at dusk / night;
 *   - perched birds in the crowns near the slice: they take off and scatter when a blast goes off nearby (event 'explode') or a worm walks under them;
 *     the far flocks panic and fly away too, then a new flock arrives;
 *   - butterflies over the flowers (temperate / canyon, calm sunny days);
 *   - lizards scurrying on desert / canyon ground (they run from worms and blasts);
 *   - a fish now and then jumping out of the sea (+ splash rings);
 *   - fireflies at night (temperate, a few in canyon): blinking glow points over the grass;
 *   - volcanic: embers rising from the ground and ash flakes drifting down;
 *   - falling leaves from the crowns (snow flakes sloughing off the spruce in alpine), tied to the wind and shaken loose by blasts.
 * Placement is world-anchored in the slice frame (s along the plane, t depth, negative = behind the slice, y up); anything that drifts out of the view
 * range or in front of the slice is faded out (scaled to nothing) and re-spawned elsewhere.
 * API: init(scene, tx, quality), onEvent(S, e), frame(S, view, camera, dt), clear(), stats(). */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math, P = SS.plane;
  const LV = SS.lifeView = {};
  let scene = null, Q = null, tx = null, rg = null, on = false;
  const uT = { value: 0 };
  const R = () => M.rng_next(rg), RR = (a, b) => a + (b - a) * M.rng_next(rg);
  const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const F = { ox: 0, oz: 0, dx: 1, dz: 0, nx: 0, nz: 1, cs: 0, fy: 10, tod: 'day', biome: 'temperate', rain: 0, wx: 0, wz: 0, wsp: 0, sea: 0, day: true, night: false, dt: 0.016, time: 0, S: null };
  const toS = (x, z) => (x - F.ox) * F.dx + (z - F.oz) * F.dz;
  const toT = (x, z) => (x - F.ox) * F.nx + (z - F.oz) * F.nz;
  const toX = (s, t) => F.ox + s * F.dx + t * F.nx;
  const toZ = (s, t) => F.oz + s * F.dz + t * F.nz;
  const W = () => SS.world;

  /* ---------- flap material: wings flap (aW = distance from the body), tails wiggle (mode 1) ---------- */
  function flapMat(mode, flat) {
    const m = new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.85, side: T.DoubleSide, flatShading: !!flat });
    m.onBeforeCompile = sh => {
      sh.uniforms.uT = uT;
      sh.vertexShader = 'attribute float aW; attribute float aPh; attribute float aAmp; attribute float aFr; uniform float uT;\n' + sh.vertexShader.replace('#include <begin_vertex>', mode === 0 ? `
        #include <begin_vertex>
        { float fo = mix(0.25, 1.0, clamp(aAmp * 4.0, 0.0, 1.0)); transformed.x *= fo; transformed.y += aW * aAmp * sin(uT * aFr + aPh) * (1.0 + 0.4 * abs(transformed.x)); }` : `
        #include <begin_vertex>
        { transformed.x += aW * aAmp * sin(uT * aFr + aPh + transformed.z * 9.0) * 0.07; transformed.y += aW * aAmp * 0.01 * sin(uT * aFr * 0.5 + aPh); }`);
    };
    m.customProgramCacheKey = () => 'life_flap' + mode;
    return m;
  }
  /* geometry with the attributes of flapMat: tri(a, b, c, wa, wb, wc, colour a, b, c) */
  function GB() {
    const o = { p: [], w: [], c: [] };
    o.tri = (a, b, c, wa, wb, wc, ca, cb, cc) => { o.p.push(...a, ...b, ...c); o.w.push(wa, wb, wc); o.c.push(...ca, ...cb, ...cc); };
    o.build = () => {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.Float32BufferAttribute(o.p, 3)); g.setAttribute('aW', new T.Float32BufferAttribute(o.w, 1)); g.setAttribute('color', new T.Float32BufferAttribute(o.c, 3));
      g.computeVertexNormals(); return g;
    };
    return o;
  }
  function birdGeo() {
    const g = GB(), W1 = [1, 1, 1], D = [0.35, 0.35, 0.35], B = [0.8, 0.8, 0.8];
    for (const sx of [-1, 1]) {
      g.tri([0, 0, 0.14], [0, 0, -0.14], [sx * 0.3, 0.015, -0.02], 0, 0, 0.5, W1, W1, W1);
      g.tri([sx * 0.3, 0.015, -0.02], [0, 0, -0.14], [sx * 0.32, 0, -0.2], 0.5, 0, 1, W1, W1, D);
      g.tri([sx * 0.3, 0.015, -0.02], [sx * 0.32, 0, -0.2], [sx * 0.62, -0.01, -0.12], 0.5, 1, 1, W1, D, D);
      g.tri([sx * 0.3, 0.015, -0.02], [sx * 0.62, -0.01, -0.12], [sx * 0.55, 0.005, 0.0], 0.5, 1, 1, W1, D, D);
    }
    g.tri([0, 0.02, 0.26], [-0.04, 0, 0.04], [0.04, 0, 0.04], 0, 0, 0, B, B, B); g.tri([0, 0.02, 0.26], [0.04, 0, 0.04], [0, -0.03, 0.06], 0, 0, 0, B, B, B);
    g.tri([-0.04, 0, 0.04], [0.04, 0, 0.04], [0, 0.01, -0.3], 0, 0, 0, B, B, B); g.tri([-0.03, 0, -0.1], [0.03, 0, -0.1], [0, 0, -0.34], 0, 0, 0, D, D, D);
    return g.build();
  }
  function butterflyGeo() {
    const g = GB(), W1 = [1, 1, 1], D = [0.25, 0.2, 0.2], E = [0.55, 0.5, 0.5];
    for (const sx of [-1, 1]) {
      g.tri([0, 0, 0.04], [sx * 0.07, 0, 0.14], [sx * 0.2, 0, 0.05], 0, 0.6, 1, W1, W1, E);
      g.tri([0, 0, 0.04], [sx * 0.2, 0, 0.05], [sx * 0.15, 0, -0.04], 0, 1, 0.8, W1, E, W1);
      g.tri([0, 0, -0.02], [sx * 0.15, 0, -0.04], [sx * 0.1, 0, -0.14], 0, 0.8, 0.6, W1, W1, W1);
    }
    g.tri([0, 0.005, 0.12], [-0.008, 0, -0.01], [0.008, 0, -0.01], 0, 0, 0, D, D, D); g.tri([-0.008, 0, -0.01], [0.008, 0, -0.01], [0, 0, -0.12], 0, 0, 0, D, D, D);
    return g.build();
  }
  function lizardGeo() {
    const g = GB(), sp = [[0.15, 0.012, 0.0], [0.09, 0.022, 0.4], [0.02, 0.036, 0.6], [-0.06, 0.034, 0.65], [-0.14, 0.022, 0.4], [-0.27, 0.012, 0.25], [-0.42, 0.004, 0.08]];
    const bw = [0.015, 0.024, 0.04, 0.036, 0.024, 0.014, 0.004];
    for (let i = 0; i < sp.length - 1; i++) {
      const a = sp[i], b = sp[i + 1], wa = bw[i], wb = bw[i + 1], ta = Math.max(0, (-a[0] - 0.06) / 0.36), tb = Math.max(0, (-b[0] - 0.06) / 0.36);
      const ca = [0.8 + 0.2 * (i % 2), 0.8, 0.75], cb = [0.8 + 0.2 * ((i + 1) % 2), 0.8, 0.75];
      g.tri([-wa, a[1], a[0]], [wa, a[1], a[0]], [wb, b[1], b[0]], ta, ta, tb, ca, ca, cb);
      g.tri([-wa, a[1], a[0]], [wb, b[1], b[0]], [-wb, b[1], b[0]], ta, tb, tb, ca, cb, cb);
    }
    for (const sx of [-1, 1]) for (const z of [0.1, -0.1]) g.tri([sx * 0.03, 0.02, z], [sx * 0.1, 0.0, z + 0.05], [sx * 0.09, 0.0, z - 0.03], 0, 0, 0, [0.7, 0.7, 0.7], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    return g.build();
  }
  function fishGeo() {
    const g = GB(), A = [0.5, 0.6, 0.65], B = [1, 1, 1], C = [0.85, 0.9, 0.95];
    g.tri([0, 0, 0.2], [-0.05, 0, 0], [0, 0.06, 0], 0, 0, 0, B, C, A); g.tri([0, 0, 0.2], [0.05, 0, 0], [0, 0.06, 0], 0, 0, 0, B, C, A);
    g.tri([0, 0, 0.2], [-0.05, 0, 0], [0, -0.05, 0], 0, 0, 0, B, C, C); g.tri([0, 0, 0.2], [0.05, 0, 0], [0, -0.05, 0], 0, 0, 0, B, C, C);
    g.tri([-0.05, 0, 0], [0, 0.06, 0], [0, 0, -0.2], 0, 0, 1, C, A, A); g.tri([0.05, 0, 0], [0, 0.06, 0], [0, 0, -0.2], 0, 0, 1, C, A, A);
    g.tri([-0.05, 0, 0], [0, -0.05, 0], [0, 0, -0.2], 0, 0, 1, C, C, C); g.tri([0.05, 0, 0], [0, -0.05, 0], [0, 0, -0.2], 0, 0, 1, C, C, C);
    g.tri([0, 0, -0.18], [0, 0.09, -0.3], [0, -0.08, -0.3], 1, 1, 1, A, A, A);
    return g.build();
  }
  function leafGeo() {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute([0, 0, 0.1, 0.06, 0, 0, 0, 0, -0.1, 0, 0, 0.1, 0, 0, -0.1, -0.06, 0, 0], 3));
    g.computeVertexNormals(); return g;
  }

  /* ---------- pools ---------- */
  const dummy = new T.Object3D(), col = new T.Color();
  dummy.rotation.order = 'YXZ';
  let wings = null, wingN = 0, wPh, wAmp, wFr;                 // birds / gulls / bats / perched
  let flies = null, flyN = 0, fPh, fAmp, fFr;                  // butterflies
  let liz = null, lizN = 0, lPh, lAmp, lFr;
  let leaves = null, leafList = [];
  let fishM = null, fish = null;
  let ffP = null, embP = null, ashP = null;
  let flocks = [], perched = [], bflies = [], lizards = [], leafN = 0, trees = [], treeT = 0, blasts = [], nextFish = 4, nextShore = 0;

  function instMesh(geo, mat, n) {
    const im = new T.InstancedMesh(geo, mat, n);
    const ph = new T.InstancedBufferAttribute(new Float32Array(n), 1), am = new T.InstancedBufferAttribute(new Float32Array(n), 1), fr = new T.InstancedBufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('aPh', ph); geo.setAttribute('aAmp', am); geo.setAttribute('aFr', fr);
    im.count = 0; im.frustumCulled = false; im.castShadow = false; im.receiveShadow = false;
    for (let i = 0; i < n; i++) { col.setRGB(1, 1, 1); im.setColorAt(i, col); }
    scene.add(im);
    return { im, ph, am, fr };
  }
  function pointsPool(n, size, additive, color) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('color', new T.BufferAttribute(new Float32Array(n * 3), 3));
    const p = new T.Points(g, new T.PointsMaterial({ map: tx.glow, size, vertexColors: true, transparent: true, depthWrite: false, blending: additive ? T.AdditiveBlending : T.NormalBlending, sizeAttenuation: true, opacity: 1 }));
    p.frustumCulled = false; p.visible = false; scene.add(p);
    return { p, n, pos: g.attributes.position.array, col: g.attributes.color.array, st: new Float32Array(n * 6), alive: 0 };
  }

  LV.init = function (sc, textures, quality) {
    scene = sc; Q = quality; tx = textures; on = false;
    if (!(Q.life > 0)) return;
    on = true; rg = M.rng_make(0x6d2f1);
    const k = Q.life;
    const nW = Math.round(56 * k), w = instMesh(birdGeo(), flapMat(0, true), nW); wings = w.im; wPh = w.ph; wAmp = w.am; wFr = w.fr; wings.userData.cap = nW;
    const b = instMesh(butterflyGeo(), flapMat(0, false), 12); flies = b.im; fPh = b.ph; fAmp = b.am; fFr = b.fr;
    const l = instMesh(lizardGeo(), flapMat(1, false), 6); liz = l.im; lPh = l.ph; lAmp = l.am; lFr = l.fr;
    const lf = new T.InstancedMesh(leafGeo(), new T.MeshStandardMaterial({ color: 0xffffff, emissive: 0x0f1a06, roughness: 0.9, side: T.DoubleSide, flatShading: true }), Math.round(48 * k));
    lf.count = 0; lf.frustumCulled = false; for (let i = 0; i < lf.instanceMatrix.count; i++) { col.setRGB(1, 1, 1); lf.setColorAt(i, col); } scene.add(lf); leaves = lf;
    fishM = new T.Mesh(fishGeo(), flapMat(1, false)); fishM.geometry.setAttribute('aPh', new T.BufferAttribute(new Float32Array(fishM.geometry.attributes.position.count), 1)); fishM.geometry.setAttribute('aAmp', new T.BufferAttribute(new Float32Array(fishM.geometry.attributes.position.count).fill(2.5), 1)); fishM.geometry.setAttribute('aFr', new T.BufferAttribute(new Float32Array(fishM.geometry.attributes.position.count).fill(22), 1));
    fishM.scale.setScalar(1.6); fishM.visible = false; fishM.frustumCulled = false; scene.add(fishM); fish = { t: -1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, d: 0 };
    ffP = pointsPool(Math.round(70 * k), 0.8, true); embP = pointsPool(Math.round(70 * k), 0.3, true); ashP = pointsPool(Math.round(60 * k), 0.16, true);
    LV.clear();
  };
  LV.clear = function () {
    flocks = []; perched = []; bflies = []; lizards = []; leafList = []; trees = []; treeT = 0; blasts = []; nextFish = 4; nextShore = 0;
    if (!on) return;
    for (const p of [ffP, embP, ashP]) { p.alive = 0; p.p.visible = false; p.st.fill(0); }
    if (wings) wings.count = 0; if (flies) flies.count = 0; if (liz) liz.count = 0; if (leaves) leaves.count = 0; if (fishM) fishM.visible = false; if (fish) fish.t = -1;
  };
  LV.stats = () => on ? { wings: wings.count, flocks: flocks.length, perched: perched.filter(p => p.mode === 0).length, flies: flies.count, lizards: liz.count, leaves: leaves.count, fireflies: ffP.alive, embers: embP.alive, ash: ashP.alive, fish: fish.t >= 0 ? 1 : 0 } : null;

  LV.debug = () => ({ liz: lizards.map(z => [z.x, z.y, z.z, z.vis, z.placed, z.mode]), flocks: flocks.map(f => [f.kind, f.cx, f.cy, f.cz, f.vis, f.placed]), ff: Array.from(ffP.pos.slice(0, 30)), fc: Array.from(ffP.col.slice(0, 30)), vis: ffP.p.visible, F, });
  LV.onEvent = function (S, e) {
    if (!on) return;
    if (e.type === 'explode') blasts.push({ x: e.x, y: e.y, z: e.z, R: e.R || 3, t: 0 });
  };

  /* ---------- helpers ---------- */
  function groundAt(x, z) { return W().top_at(x, z); }
  function wingsInst(i, x, y, z, yaw, pitch, roll, sc, r, g, b) {
    dummy.position.set(x, y, z); dummy.rotation.set(pitch, yaw, roll); dummy.scale.setScalar(sc); dummy.updateMatrix(); wings.setMatrixAt(i, dummy.matrix);
    col.setRGB(r, g, b, T.SRGBColorSpace); wings.setColorAt(i, col);
  }
  function inView(x, z, sMax, tMin, tMax) { const s = toS(x, z) - F.cs, t = toT(x, z); return Math.abs(s) < sMax && t > tMin && t < tMax; }

  /* ---------- flocks: birds, gulls, bats ---------- */
  function newFlock(kind) {
    const f = { kind, n: kind === 'gull' ? Math.round(RR(4, 6) * Q.life) : kind === 'bat' ? Math.round(RR(5, 8) * Q.life) : Math.round(RR(5, 9) * Q.life), cx: 0, cz: 0, cy: 0, rad: 10, w: 0.8, dir: R() < 0.5 ? -1 : 1, vis: 0, ph: R() * 6.28, placed: 0, panic: 0, units: [], retry: 0 };
    f.n = Math.max(2, f.n);
    for (let i = 0; i < f.n; i++) f.units.push({ a: R() * 6.28, r: RR(0.6, 1.3), dy: RR(-1.8, 1.8), ph: R() * 6.28, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, glide: R() * 6.28 });
    return f;
  }
  function placeFlock(f) {
    for (let tr = 0; tr < 14; tr++) {
      const s = F.cs + RR(-34, 34), t = -RR(f.kind === 'bat' ? 20 : 26, f.kind === 'bat' ? 50 : 60), x = toX(s, t), z = toZ(s, t);
      let y;
      if (f.kind === 'gull') { const g = groundAt(x, z); if (g > F.sea + 2.5 || g < F.sea - 7) continue; y = F.sea + RR(4, 11); f.rad = RR(6, 11); }
      else { y = Math.max(F.fy + RR(1, 15), groundAt(x, z) + 8); f.rad = RR(7, 13); }
      f.cx = x; f.cz = z; f.cy = y; f.w = RR(0.55, 0.85) / (f.rad / 9) * f.dir; f.placed = 1; f.panic = 0; f.vis = 0; return true;
    }
    f.placed = 0; f.retry = 1.5; return false;
  }
  function updateFlocks(dt) {
    const want = [];
    const birdsOK = (F.day || F.tod === 'dusk') && F.rain < 0.45 && (F.biome === 'temperate' || F.biome === 'canyon' || F.biome === 'alpine');
    const gullsOK = (F.day || F.tod === 'dusk') && F.rain < 0.6 && F.biome !== 'volcanic';
    const batsOK = (F.tod === 'dusk' || F.night) && F.rain < 0.3 && (F.biome === 'temperate' || F.biome === 'canyon');
    const nb = birdsOK ? Math.max(1, Math.round(2 * Q.life)) : 0, ng = gullsOK ? 1 : 0, nt = batsOK ? 1 : 0;
    const have = { bird: 0, gull: 0, bat: 0 };
    for (const f of flocks) have[f.kind]++;
    const lim = { bird: nb, gull: ng, bat: nt };
    for (const k in lim) while (have[k] < lim[k]) { flocks.push(newFlock(k)); have[k]++; }
    for (let i = flocks.length - 1; i >= 0; i--) {
      const f = flocks[i];
      if (have[f.kind] > lim[f.kind]) { f.vis -= dt * 0.7; if (f.vis <= 0) { flocks.splice(i, 1); have[f.kind]--; continue; } }
      if (!f.placed) { f.retry -= dt; if (f.retry <= 0 && F.cs === F.cs) placeFlock(f); continue; }
      const s = toS(f.cx, f.cz) - F.cs, t = toT(f.cx, f.cz);
      const ok = t < -16 && t > -140 && Math.abs(s) < 75 && f.panic <= 0;
      if (f.panic > 0) { f.panic -= dt; if (f.panic <= 0) { f.placed = 0; f.retry = RR(6, 14); f.vis = 0; continue; } f.vis = Math.min(f.vis, sm(0, 1.4, f.panic)); }
      else if (ok) f.vis = Math.min(1, f.vis + dt * 0.6); else { f.vis -= dt * 0.8; if (f.vis <= 0) { f.vis = 0; placeFlock(f); } }
      f.ph += dt;
      if (f.panic <= 0) { f.cx += F.dx * Math.sin(f.ph * 0.07) * 0.6 * dt; f.cz += F.dz * Math.sin(f.ph * 0.07) * 0.6 * dt; }
    }
  }
  function drawFlocks(dt) {
    let n = 0; const cap = wings.userData.cap;
    for (const f of flocks) {
      if (!f.placed || f.vis < 0.02) continue;
      const bat = f.kind === 'bat', gull = f.kind === 'gull';
      for (let i = 0; i < f.units.length && n < cap; i++) {
        const u = f.units[i]; let x, y, z, yaw, roll = 0, pitch = 0, amp, fr;
        if (f.panic > 0) {
          u.px += u.vx * dt; u.py += u.vy * dt; u.pz += u.vz * dt; u.vy += (0.4 - u.vy * 0.05) * dt;
          x = u.px; y = u.py; z = u.pz; yaw = Math.atan2(u.vx, u.vz); pitch = -0.3; amp = 0.34; fr = 24;
        } else {
          u.a += f.w * dt * (bat ? 1.6 : 1) * (0.9 + 0.2 * u.r);
          const rr = f.rad * u.r, ca = Math.cos(u.a), sa = Math.sin(u.a);
          let ox = ca * rr, oz = sa * rr * 0.9, wob = bat ? Math.sin(f.ph * 3.1 + u.ph) * 1.4 : 0;
          x = f.cx + F.dx * ox + F.nx * oz; z = f.cz + F.dz * ox + F.nz * oz;
          y = f.cy + u.dy + Math.sin(f.ph * 0.7 + u.ph) * 0.9 + wob;
          const sgn = f.w >= 0 ? 1 : -1, tx2 = -sa * sgn, tz2 = ca * 0.9 * sgn;
          yaw = Math.atan2(F.dx * tx2 + F.nx * tz2, F.dz * tx2 + F.nz * tz2); roll = -0.35 * sgn * (bat ? 1.6 : 1); pitch = Math.cos(f.ph * 0.7 + u.ph) * 0.12;
          u.px = x; u.py = y; u.pz = z; u.vx = Math.sin(yaw) * 8; u.vz = Math.cos(yaw) * 8;
          const gl = Math.sin(f.ph * 0.5 + u.glide);
          amp = bat ? 0.55 : gull ? 0.1 + 0.2 * sm(-0.2, 0.5, gl) : 0.08 + 0.26 * sm(-0.3, 0.4, gl); fr = bat ? 20 : gull ? 7.5 : 11;
        }
        const sc = (bat ? 1.3 : gull ? 2.6 : 2.4) * (0.85 + 0.15 * u.r) * f.vis;
        if (bat) wingsInst(n, x, y, z, yaw, pitch, roll, sc, 0.1, 0.08, 0.09);
        else if (gull) wingsInst(n, x, y, z, yaw, pitch, roll, sc, 1, 1, 1);
        else wingsInst(n, x, y, z, yaw, pitch, roll, sc, 0.13 + 0.06 * u.r, 0.12, 0.12);
        wPh.array[n] = u.ph; wAmp.array[n] = amp; wFr.array[n] = fr; n++;
      }
    }
    return n;
  }
  function panicFlock(f, b) {
    if (f.panic > 0 || !f.placed) return;
    f.panic = 4.2;
    for (const u of f.units) {
      let dx = u.px - b.x, dz = u.pz - b.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const sp = RR(7, 11); u.vx = dx * sp + RR(-2, 2); u.vz = dz * sp + RR(-2, 2); u.vy = RR(1.5, 4.5);
    }
  }

  /* ---------- perched birds (in the crowns near the slice): scatter on blasts / worms ---------- */
  function refreshTrees() {
    trees = [];
    const S = F.S; if (!S || !S.trees) return;
    for (const t of S.trees) {
      if (!t.alive || (t.sp !== 0 && t.sp !== 2) || !t.leaf.length) continue;
      const tt = toT(t.x, t.z), s = toS(t.x, t.z) - F.cs;
      if (tt > -1.2 || tt < -13 || Math.abs(s) > 26) continue;
      trees.push(t);
    }
  }
  function pickPerch(p) {
    if (!trees.length) return false;
    for (let k = 0; k < 6; k++) {
      const t = trees[Math.floor(R() * trees.length)]; let best = null;
      for (const l of t.leaf) if (l.f > 0.4 && (!best || l.y > best.y - R() * 0.8)) best = l;
      if (!best || perched.some(q => q !== p && q.tree === t && q.mode === 0)) continue;
      p.tree = t; p.x = best.x + RR(-0.3, 0.3); p.y = best.y + best.r * 0.7; p.z = best.z + RR(-0.3, 0.3); p.yaw = R() * 6.28; p.mode = 0; p.t = 0; p.vis = 0; return true;
    }
    return false;
  }
  function updatePerched(dt) {
    const wantN = (F.day) && F.rain < 0.5 && (F.biome === 'temperate' || F.biome === 'canyon') ? Math.round(3 * Q.life) : 0;
    while (perched.length < wantN) perched.push({ mode: 2, t: RR(0, 3), cool: 0, tree: null, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, vis: 0, col: R() });
    while (perched.length > wantN) perched.pop();
    for (const p of perched) {
      if (p.mode === 2) { p.t -= dt; if (p.t <= 0) { if (!pickPerch(p)) p.t = 2; } continue; }
      if (p.mode === 0) {
        p.vis = Math.min(1, p.vis + dt * 1.5);
        let scare = !p.tree.alive || (p.tree.burn >= 0) || toT(p.tree.x, p.tree.z) > -0.6;
        for (const b of blasts) if (Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z) < 22 + b.R * 3) scare = b;
        const S = F.S;
        if (S && !scare) for (const w of S.worms) if (!w.dead && Math.hypot(w.pos.x - p.x, w.pos.z - p.z) < 2.6 && Math.abs(w.pos.y - p.y) < 6 && w.vs !== undefined && (Math.abs(w.vs) > 0.5 || w.air)) { scare = w.pos; break; }
        if (scare) {
          const o = scare === true ? { x: p.x - 1, z: p.z } : scare; let dx = p.x - o.x, dz = p.z - o.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
          p.mode = 1; p.t = 0; p.vx = dx * RR(3, 6) + RR(-1, 1); p.vz = dz * RR(3, 6) + RR(-1, 1); p.vy = RR(2.5, 4.5); p.cool = RR(20, 40);
        }
      } else {
        p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vy += (1.2 - p.vy) * dt * 0.5; p.vx *= 1 + dt * 0.25; p.vz *= 1 + dt * 0.25;
        p.yaw = Math.atan2(p.vx, p.vz); p.vis = 1 - sm(2.2, 4.5, p.t);
        if (p.t > 4.6) { p.mode = 2; p.t = p.cool; }
      }
    }
  }
  function drawPerched(n) {
    const cap = wings.userData.cap;
    for (const p of perched) {
      if (p.mode === 2 || n >= cap) continue;
      const fly = p.mode === 1, pc = p.col;
      wingsInst(n, p.x, p.y + (fly ? 0 : 0.04), p.z, p.yaw, fly ? -0.35 : 0.2, 0, 1.3 * p.vis, 0.16 + 0.12 * pc, 0.13 + 0.08 * pc, 0.11);
      wPh.array[n] = pc * 6; wAmp.array[n] = fly ? 0.36 : 0; wFr.array[n] = 26; n++;
    }
    return n;
  }

  /* ---------- butterflies ---------- */
  function updateButterflies(dt) {
    const ok = F.day && F.rain < 0.1 && F.wsp < 5 && (F.biome === 'temperate' || F.biome === 'canyon');
    const want = ok ? Math.round((F.biome === 'temperate' ? 9 : 4) * Q.life) : 0;
    while (bflies.length < want) bflies.push({ x: 0, z: 0, y: 0, h: R() * 6.28, sp: RR(0.5, 1.1), vis: 0, ph: R() * 6.28, hov: RR(0.5, 1.7), c: Math.floor(R() * 5), placed: 0 });
    while (bflies.length > want) bflies.pop();
    const g = F.S;
    for (const b of bflies) {
      if (!b.placed) {
        const s = F.cs + RR(-14, 14), t = -RR(1.5, 9); b.x = toX(s, t); b.z = toZ(s, t); b.placed = 1; b.vis = 0; continue;
      }
      b.h += (Math.sin(F.time * 1.3 + b.ph) * 1.6 + Math.sin(F.time * 0.37 + b.ph * 2) * 1.2) * dt;
      b.x += Math.sin(b.h) * b.sp * dt + F.wx * 0.1 * dt; b.z += Math.cos(b.h) * b.sp * dt + F.wz * 0.1 * dt;
      const s = toS(b.x, b.z) - F.cs, t = toT(b.x, b.z);
      const keep = Math.abs(s) < 22 && t < -0.9 && t > -12;
      if (keep) b.vis = Math.min(1, b.vis + dt * 0.8); else { b.vis -= dt * 0.8; if (b.vis <= 0) b.placed = 0; }
      if (t > -0.9) { b.x -= F.nx * dt * 1.2; b.z -= F.nz * dt * 1.2; }
      b.y = Math.max(groundAt(b.x, b.z), F.sea + 0.2) + b.hov + Math.sin(F.time * 2.2 + b.ph) * 0.18;
    }
    let n = 0; const PAL = [[1, 0.6, 0.15], [1, 1, 1], [0.95, 0.85, 0.2], [0.5, 0.65, 1], [0.95, 0.4, 0.55]];
    for (const b of bflies) {
      if (!b.placed || b.vis < 0.02 || n >= flies.instanceMatrix.count) continue;
      dummy.position.set(b.x, b.y, b.z); dummy.rotation.set(0.15, b.h, Math.sin(F.time * 1.7 + b.ph) * 0.25); dummy.scale.setScalar(1.9 * b.vis); dummy.updateMatrix(); flies.setMatrixAt(n, dummy.matrix);
      const c = PAL[b.c]; col.setRGB(c[0], c[1], c[2], T.SRGBColorSpace); flies.setColorAt(n, col); fPh.array[n] = b.ph; fAmp.array[n] = 0.12; fFr.array[n] = 17; n++;
    }
    flies.count = n; flies.instanceMatrix.needsUpdate = true; if (flies.instanceColor) flies.instanceColor.needsUpdate = true; fPh.needsUpdate = fAmp.needsUpdate = fFr.needsUpdate = true;
  }

  /* ---------- lizards ---------- */
  const lq = new T.Quaternion(), lq2 = new T.Quaternion(), upv = new T.Vector3(0, 1, 0), nvv = new T.Vector3(), lsc = new T.Vector3(), lpos = new T.Vector3(), lm = new T.Matrix4();
  function updateLizards(dt) {
    const ok = (F.day || F.tod === 'dusk') && F.rain < 0.4 && (F.biome === 'desert' || F.biome === 'canyon');
    const want = ok ? Math.round(5 * Q.life) : 0;
    while (lizards.length < want) lizards.push({ x: 0, z: 0, y: 0, yaw: R() * 6.28, mode: 0, t: RR(0.5, 3), vis: 0, placed: 0, ph: R() * 6.28, spd: 0, flee: 0, nx: 0, ny: 1, nz: 0, c: R() });
    while (lizards.length > want) lizards.pop();
    const Wd = W();
    for (const z of lizards) {
      if (!z.placed) {
        for (let tr = 0; tr < 8; tr++) {
          const s = F.cs + RR(-12, 12), t = -RR(1.2, 6), x = toX(s, t), zz = toZ(s, t), g = Wd.topHeight(x, zz);
          if (g < F.sea + 0.5) continue;
          const g2 = Wd.topHeight(x + 0.3, zz), g3 = Wd.topHeight(x, zz + 0.3);
          if (Math.abs(g2 - g) > 0.25 || Math.abs(g3 - g) > 0.25) continue;
          z.x = x; z.z = zz; z.y = g; z.placed = 1; z.vis = 0; z.mode = 0; z.t = RR(0.3, 2); break;
        }
        continue;
      }
      z.t -= dt;
      const S = F.S; let scare = null;
      if (S) for (const w of S.worms) if (!w.dead && Math.hypot(w.pos.x - z.x, w.pos.z - z.z) < 2.3 && Math.abs(w.pos.y - z.y) < 2) scare = w.pos;
      for (const b of blasts) if (Math.hypot(b.x - z.x, b.z - z.z) < 14 + b.R * 2) scare = b;
      if (scare) { z.yaw = Math.atan2(z.x - scare.x, z.z - scare.z) + RR(-0.5, 0.5); z.mode = 1; z.t = RR(1.2, 2.2); z.flee = 1; }
      else if (z.t <= 0) {
        if (z.mode === 0) { z.mode = 1; z.t = RR(0.5, 1.4); z.flee = 0; const sd = R() < 0.6 ? Math.atan2(F.dx, F.dz) * 1 : Math.atan2(F.nx, F.nz); z.yaw = sd + (R() < 0.5 ? Math.PI : 0) + RR(-0.6, 0.6); }
        else { z.mode = 0; z.t = RR(1, 4); }
      }
      const run = z.mode === 1; z.spd += ((run ? (z.flee ? 3.6 : 2.2) : 0) - z.spd) * Math.min(1, dt * 9);
      z.x += Math.sin(z.yaw) * z.spd * dt; z.z += Math.cos(z.yaw) * z.spd * dt;
      const s = toS(z.x, z.z) - F.cs, t = toT(z.x, z.z);
      if (t > -0.9) { z.x -= F.nx * 0.05; z.z -= F.nz * 0.05; if (z.mode === 1) z.yaw = Math.atan2(-F.nx, -F.nz) + RR(-1, 1); }
      const keep = Math.abs(s) < 20 && t < -0.7 && t > -9;
      if (keep) z.vis = Math.min(1, z.vis + dt * 1.2); else { z.vis -= dt * 1.2; if (z.vis <= 0) z.placed = 0; }
      const g = Wd.topHeight(z.x, z.z); z.y += (g - z.y) * Math.min(1, dt * 12);
      const gx = Wd.topHeight(z.x + 0.25, z.z) - Wd.topHeight(z.x - 0.25, z.z), gz = Wd.topHeight(z.x, z.z + 0.25) - Wd.topHeight(z.x, z.z - 0.25);
      z.nx += (-gx * 1.0 - z.nx) * Math.min(1, dt * 10); z.nz += (-gz * 1.0 - z.nz) * Math.min(1, dt * 10);
    }
    let n = 0; const cap = liz.instanceMatrix.count;
    for (const z of lizards) {
      if (!z.placed || z.vis < 0.02 || n >= cap) continue;
      nvv.set(z.nx, 1, z.nz).normalize(); lq.setFromUnitVectors(upv, nvv); lq2.setFromAxisAngle(upv, z.yaw); lq.multiply(lq2);
      lpos.set(z.x, z.y - 0.02, z.z); lsc.setScalar(2.3 * z.vis); lm.compose(lpos, lq, lsc); liz.setMatrixAt(n, lm);
      if (F.biome === 'canyon') col.setRGB(0.3 + 0.12 * z.c, 0.17 + 0.06 * z.c, 0.1, T.SRGBColorSpace); else col.setRGB(0.36 + 0.14 * z.c, 0.27 + 0.1 * z.c, 0.15, T.SRGBColorSpace);
      liz.setColorAt(n, col); lPh.array[n] = z.ph; lAmp.array[n] = 0.4 + z.spd * 0.5; lFr.array[n] = 10 + z.spd * 5; n++;
    }
    liz.count = n; liz.instanceMatrix.needsUpdate = true; if (liz.instanceColor) liz.instanceColor.needsUpdate = true; lPh.needsUpdate = lAmp.needsUpdate = lFr.needsUpdate = true;
  }

  /* ---------- a fish jumping out of the sea ---------- */
  function splashAt(x, y, z, size) {
    SS.fx.splash(x, y, z, size);
    if (SS.waterView) SS.waterView.onEvent({ type: 'splash', x, y, z, size });
  }
  function updateFish(dt) {
    if (F.rain > 0.6 || F.S.weather && F.S.weather.storm) { fishM.visible = false; fish.t = -1; return; }
    if (fish.t < 0) {
      nextFish -= dt;
      if (nextFish > 0) return;
      nextFish = RR(5, 13);
      for (let tr = 0; tr < 10; tr++) {
        const s = F.cs + RR(-26, 26), t = -RR(7, 34), x = toX(s, t), z = toZ(s, t);
        if (groundAt(x, z) > F.sea - 1.8) continue;
        fish.x = x; fish.z = z; fish.y = SS.sim.surface_at(F.S, x, z); fish.d = RR(0.8, 1.05); fish.t = 0;
        const a = Math.atan2(F.dx, F.dz) + (R() < 0.5 ? 0 : Math.PI) + RR(-0.5, 0.5), v = RR(2.6, 3.4);
        fish.vx = Math.sin(a) * v; fish.vz = Math.cos(a) * v; fish.vy = fish.d * 4.9; fish.yaw = a; splashAt(x, fish.y, z, 0.28); break;
      }
      return;
    }
    fish.t += dt; fish.x += fish.vx * dt; fish.z += fish.vz * dt; fish.y += fish.vy * dt; fish.vy -= 9.8 * dt;
    const sy = SS.sim.surface_at(F.S, fish.x, fish.z);
    if (fish.t > 0.15 && fish.y < sy) { splashAt(fish.x, sy, fish.z, 0.38); fish.t = -1; fishM.visible = false; return; }
    fishM.visible = true; fishM.position.set(fish.x, fish.y, fish.z); fishM.rotation.set(-Math.atan2(fish.vy, Math.hypot(fish.vx, fish.vz)) * 0.9, fish.yaw, Math.sin(fish.t * 14) * 0.3);
  }

  /* ---------- point clouds: fireflies, embers, ash ---------- */
  function updateFireflies(dt) {
    const ok = F.night && F.rain < 0.3 && (F.biome === 'temperate' || F.biome === 'canyon');
    const p = ffP, want = ok ? Math.round((F.biome === 'temperate' ? 70 : 24) * Q.life) : 0;
    p.p.visible = want > 0;
    p.alive = Math.min(p.n, want);
    for (let i = 0; i < p.n; i++) {
      const o = i * 6, c = i * 3;
      if (i >= p.alive) { p.col[c] = p.col[c + 1] = p.col[c + 2] = 0; p.st[o + 5] = 0; continue; }
      const st = p.st; let fadeIn = st[o + 5];
      const s = toS(st[o], st[o + 1]) - F.cs, t = toT(st[o], st[o + 1]);
      if (!st[o + 4] || Math.abs(s) > 22 || t > -0.8 || t < -11) {
        if (st[o + 4] && fadeIn > 0) { fadeIn = Math.max(0, fadeIn - dt * 1.5); st[o + 5] = fadeIn; if (fadeIn > 0) { p.col[c] = p.col[c + 1] = p.col[c + 2] = 0; continue; } }
        const ss = F.cs + RR(-20, 20), tt = -RR(1.2, 9); st[o] = toX(ss, tt); st[o + 1] = toZ(ss, tt); st[o + 2] = RR(0.4, 2.4); st[o + 3] = R() * 6.28; st[o + 4] = RR(1.2, 2.6); st[o + 5] = 0.001;
      }
      st[o + 3] += dt * (0.8 + 0.3 * st[o + 4]);
      st[o] += Math.sin(st[o + 3] * 1.3 + i) * 0.35 * dt; st[o + 1] += Math.cos(st[o + 3] * 0.9 + i * 2) * 0.35 * dt;
      st[o + 5] = Math.min(1, st[o + 5] + dt * 0.7);
      const x = st[o], z = st[o + 1], y = Math.max(groundAt(x, z), F.sea + 0.1) + st[o + 2] + Math.sin(st[o + 3] * 1.7) * 0.25;
      p.pos[c] = x; p.pos[c + 1] = y; p.pos[c + 2] = z;
      const bl = Math.pow(Math.max(0, Math.sin(F.time * st[o + 4] + i * 1.7)), 3) * st[o + 5];
      p.col[c] = 0.8 * bl; p.col[c + 1] = 1.3 * bl; p.col[c + 2] = 0.3 * bl;
    }
    p.p.geometry.attributes.position.needsUpdate = true; p.p.geometry.attributes.color.needsUpdate = true;
  }
  function updateEmbers(dt) {
    const ok = F.biome === 'volcanic' && F.rain < 0.6, p = embP, want = ok ? p.n : 0;
    p.p.visible = want > 0; p.alive = want;
    const boost = F.night ? 1 : 1.6;
    for (let i = 0; i < p.n; i++) {
      const o = i * 6, c = i * 3, st = p.st;
      if (i >= want) { p.col[c] = p.col[c + 1] = p.col[c + 2] = 0; continue; }
      st[o + 3] -= dt;
      if (st[o + 3] <= 0 || toT(st[o], st[o + 2]) > -0.7) {
        const ss = F.cs + RR(-24, 24), tt = -RR(1.5, 14), x = toX(ss, tt), z = toZ(ss, tt);
        st[o] = x; st[o + 2] = z; st[o + 1] = Math.max(groundAt(x, z), F.sea) + RR(0.1, 1.2); st[o + 3] = RR(2.5, 6); st[o + 4] = st[o + 3]; st[o + 5] = RR(1.0, 2.6);
      }
      const age = 1 - st[o + 3] / st[o + 4];
      st[o] += (F.wx * 1.8 + Math.sin(F.time * 1.1 + i) * 0.5) * dt; st[o + 2] += (F.wz * 1.8 + Math.cos(F.time * 0.9 + i * 3) * 0.5) * dt; st[o + 1] += st[o + 5] * (1 - age * 0.5) * dt;
      p.pos[c] = st[o]; p.pos[c + 1] = st[o + 1]; p.pos[c + 2] = st[o + 2];
      const a = Math.sin(Math.PI * Math.min(1, age * 1.05)) * (0.7 + 0.3 * Math.sin(F.time * 17 + i * 5)) * boost, k = 1 - age * 0.6;
      p.col[c] = 1.0 * a; p.col[c + 1] = 0.5 * k * a; p.col[c + 2] = 0.1 * k * k * a;
    }
    p.p.geometry.attributes.position.needsUpdate = true; p.p.geometry.attributes.color.needsUpdate = true;
  }
  function updateAsh(dt) {
    const ok = F.biome === 'volcanic', p = ashP, wxk = F.S.weather ? F.S.weather.ash || 0 : 0, want = ok ? Math.round(p.n * (wxk > 0.2 ? 0.4 : 1)) : 0;
    p.p.visible = want > 0; p.alive = want;
    for (let i = 0; i < p.n; i++) {
      const o = i * 6, c = i * 3, st = p.st;
      if (i >= want) { p.col[c] = p.col[c + 1] = p.col[c + 2] = 0; continue; }
      const s = toS(st[o], st[o + 2]) - F.cs, t = toT(st[o], st[o + 2]);
      if (!st[o + 4] || st[o + 1] < F.sea - 1 || Math.abs(s) > 26 || t > -0.6 || t < -16) {
        const ss = F.cs + RR(-24, 24), tt = -RR(1, 13);
        st[o] = toX(ss, tt); st[o + 2] = toZ(ss, tt); st[o + 1] = F.fy + RR(-2, 12); st[o + 3] = R() * 6.28; st[o + 4] = RR(0.35, 0.8); st[o + 5] = 0;
      }
      st[o + 3] += dt * 1.6; st[o + 5] = Math.min(1, st[o + 5] + dt * 0.8);
      st[o] += (F.wx * 1.2 + Math.sin(st[o + 3]) * 0.4) * dt; st[o + 2] += (F.wz * 1.2 + Math.cos(st[o + 3] * 0.8) * 0.4) * dt; st[o + 1] -= st[o + 4] * dt;
      p.pos[c] = st[o]; p.pos[c + 1] = st[o + 1]; p.pos[c + 2] = st[o + 2];
      const a = 0.5 * st[o + 5] * (0.7 + 0.3 * Math.sin(st[o + 3] * 2.3));
      p.col[c] = 0.5 * a; p.col[c + 1] = 0.44 * a; p.col[c + 2] = 0.4 * a;
    }
    p.p.geometry.attributes.position.needsUpdate = true; p.p.geometry.attributes.color.needsUpdate = true;
  }

  /* ---------- falling leaves / snow flakes ---------- */
  function spawnLeaf(t, burst) {
    const cap = leaves.instanceMatrix.count;
    if (leafList.length >= cap || !t.leaf.length) return;
    let l = null; for (let k = 0; k < 4 && !l; k++) { const c = t.leaf[Math.floor(R() * t.leaf.length)]; if (c.f > 0.25) l = c; }
    if (!l) return;
    const a = R() * 6.28, rr = l.r * Math.sqrt(R()) * 0.8, alp = F.biome === 'alpine';
    const c = alp ? [0.94, 0.97, 1] : F.biome === 'canyon' ? [0.45 + 0.2 * R(), 0.45 + 0.1 * R(), 0.15] : R() < 0.2 ? [0.85, 0.7, 0.18] : [0.25 + 0.2 * R(), 0.5 + 0.2 * R(), 0.12];
    leafList.push({ x: l.x + Math.cos(a) * rr, y: l.y + (R() - 0.3) * l.r * 0.5, z: l.z + Math.sin(a) * rr, vx: burst ? RR(-2, 2) : 0, vy: burst ? RR(0, 1.5) : 0, vz: burst ? RR(-2, 2) : 0, ph: R() * 6.28, rot: R() * 6.28, spin: RR(-3, 3), sz: alp ? RR(0.6, 1.1) : RR(0.8, 1.4), c, rest: 0, age: 0, snow: alp });
  }
  function updateLeaves(dt) {
    const cap = leaves.instanceMatrix.count;
    const okBiome = F.biome === 'temperate' || F.biome === 'canyon' || F.biome === 'alpine';
    if (F.time - treeT > 1) { treeT = F.time; refreshTrees(); }
    const pool = okBiome ? trees.filter(t => F.biome === 'alpine' ? t.sp === 1 : t.sp !== 1) : [];
    let atrees = pool;
    if (F.biome === 'alpine') { atrees = []; const S = F.S; if (S && S.trees) for (const t of S.trees) if (t.alive && t.sp === 1) { const tt = toT(t.x, t.z), s = toS(t.x, t.z) - F.cs; if (tt < -1.2 && tt > -13 && Math.abs(s) < 26) atrees.push(t); } }
    if (atrees.length) {
      const rate = (F.rain > 0.5 ? 0.1 : 0.12) * Math.min(4, 0.3 + F.wsp * 0.45) * (F.biome === 'alpine' ? 0.8 : 1) * Q.life;
      let acc = (updateLeaves.acc || 0) + rate * dt;
      while (acc >= 1) { spawnLeaf(atrees[Math.floor(R() * atrees.length)], false); acc -= 1; }
      updateLeaves.acc = acc;
      for (const b of blasts) for (const t of atrees) if (Math.hypot(b.x - t.x, b.y - (t.y + t.h * 0.6), b.z - t.z) < 10 + b.R * 2.5) for (let k = 0; k < 7; k++) spawnLeaf(t, true);
    }
    for (let i = leafList.length - 1; i >= 0; i--) {
      const l = leafList[i]; l.age += dt;
      if (l.rest > 0) { l.rest += dt; if (l.rest > 9) { leafList.splice(i, 1); } continue; }
      const fall = l.snow ? 1.3 : 0.85, flutter = l.snow ? 0.3 : 1.1;
      l.vy += (-fall - l.vy) * Math.min(1, dt * 1.6);
      l.vx += (F.wx * 1.1 + Math.sin(F.time * 2.1 + l.ph) * flutter - l.vx) * Math.min(1, dt * 1.4); l.vz += (F.wz * 1.1 + Math.cos(F.time * 1.7 + l.ph) * flutter - l.vz) * Math.min(1, dt * 1.4);
      l.x += l.vx * dt; l.y += l.vy * dt; l.z += l.vz * dt; l.rot += l.spin * dt;
      if (l.y <= groundAt(l.x, l.z) + 0.03 || l.y < F.sea) { if (l.y < F.sea + 0.02) { leafList.splice(i, 1); continue; } l.rest = 0.001; l.y = W().topHeight(l.x, l.z) + 0.02; }
    }
    let n = 0;
    for (const l of leafList) {
      if (n >= cap) break;
      const fade = l.rest > 0 ? 1 - sm(8, 9, l.rest) : sm(0, 0.4, l.age);
      const tilt = l.rest > 0 ? 0.0 : Math.sin(F.time * 3 + l.ph) * 0.9;
      dummy.position.set(l.x, l.y, l.z); dummy.rotation.set(tilt, l.rot, l.rest > 0 ? 0 : Math.cos(F.time * 2.6 + l.ph) * 0.8); dummy.scale.setScalar(l.sz * fade); dummy.updateMatrix(); leaves.setMatrixAt(n, dummy.matrix);
      col.setRGB(l.c[0], l.c[1], l.c[2], T.SRGBColorSpace); leaves.setColorAt(n, col); n++;
    }
    leaves.count = n; leaves.instanceMatrix.needsUpdate = true; if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  }

  /* ---------- per frame ---------- */
  LV.frame = function (S, view, camera, dt) {
    if (!on) return;
    if (SS.world.under || SS.world.eow || !S.wind) { wings.count = flies.count = liz.count = leaves.count = 0; fishM.visible = false; for (const p of [ffP, embP, ashP]) p.p.visible = false; return; }
    dt = Math.min(dt, 0.1);
    const d = P.dir(S), n = P.nrm(S), ft = view.camT, a = S.active;
    F.S = S; F.ox = S.O.x; F.oz = S.O.z; F.dx = d.x; F.dz = d.z; F.nx = n.x; F.nz = n.z; F.dt = dt; F.time = view.time;
    const fx = ft ? ft.x : a ? a.pos.x : S.O.x, fz = ft ? ft.z : a ? a.pos.z : S.O.z;
    F.cs = toS(fx, fz); F.fy = ft ? ft.y : a ? a.pos.y : 10; F.tod = view.tod; F.day = view.tod === 'day'; F.night = view.tod === 'night'; F.biome = S.biome || 'temperate';
    F.rain = S.weather ? Math.min(1, (S.weather.rain || 0) + (S.weather.snow || 0) * 0.6) : 0; F.sea = SS.world.SEA;
    const wm = S.wind.mean || { x: 0, z: 0 }; F.wx = wm.x; F.wz = wm.z; F.wsp = Math.hypot(wm.x, wm.z);
    uT.value = view.time;
    for (const b of blasts) b.t += dt;
    for (const b of blasts) for (const f of flocks) if (f.placed && Math.hypot(b.x - f.cx, b.y - f.cy, b.z - f.cz) < 60 + b.R * 6) panicFlock(f, b);
    updateFlocks(dt); updatePerched(dt);
    let k = drawFlocks(dt); k = drawPerched(k);
    wings.count = k; wings.instanceMatrix.needsUpdate = true; if (wings.instanceColor) wings.instanceColor.needsUpdate = true; wPh.needsUpdate = wAmp.needsUpdate = wFr.needsUpdate = true;
    updateButterflies(dt); updateLizards(dt); updateFish(dt); updateFireflies(dt); updateEmbers(dt); updateAsh(dt); updateLeaves(dt);
    blasts.length = 0;
  };
})(window.SS = window.SS || {});
