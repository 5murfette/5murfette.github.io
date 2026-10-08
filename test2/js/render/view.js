/* render/view.js — Three.js presentation of the sim state: renderer, camera, lights, sky, water, section outline
 * and event-driven effects; worms/projectiles/rope/reticle are render/actors.js, bodies and props render/bodies.js. Terrain meshes live in render/terrain.js, grass in
 * render/grass.js. Reads S (writes only presentation bookkeeping: S.section, S.sectionDirty, S.stats).
 * Porting: this file + materials/terrain/grass/actors/fx are the only Three.js-specific code. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, M = SS.math, P = SS.plane;
  const V = SS.view = {};
  let renderer, scene, camera, tx, Q, sun, hemi, fill, sky, skyMat, water, heightTex, surfTex, blankTex, outline, outlineMat, motes, lamp, stars = null;
  const view = {
    camT: null, camZ: 0, dir: { cur: null, since: 0 }, zoom: 19, time: 0, heightVer: 0, heightFor: -1, heightT: -99, heightmap: null, secWV: -1, secT: -99, edgeA: 0,
    pan: { s: 0, y: 0 }, orbit: { yaw: 0, tilt: 0 }, look: null, activeId: -1, surf: null, surfN: 0
  };
  V.state = view;
  const NS = 193;                         // surface / water height maps: one texel per lattice column

  /* Per-biome lighting and grading (sky panorama, sun, ambient, haze, vegetation and water tints). */
  const LOOKS = {
    temperate: { sky: 'sky', sun: 0xffe2b8, sunI: 3.0, hemiS: 0xcfe2ff, hemiG: 0x7a5a3a, hemiI: 1.15, fog: 0.0062, haze: 0xf1d9c0, exp: 1.05, grass: [1, 1, 1], dry: [1, 1, 1], gBase: 0x173a0c, gTip: 0x8cc840, gDry: 0xc8a85c, deep: 0x0d3a5c, shallow: 0x2fa7a8, sunDir: [-0.42, 0.62, 0.66] },
    alpine: { sky: 'sky_cold', sun: 0xfff3e6, sunI: 2.9, hemiS: 0xd8e8ff, hemiG: 0x6a7080, hemiI: 1.3, fog: 0.0070, haze: 0xdde8f5, exp: 1.0, grass: [0.86, 0.96, 0.92], dry: [0.95, 0.95, 0.9], gBase: 0x1a3418, gTip: 0x7aa860, gDry: 0xb8a878, deep: 0x123a58, shallow: 0x5fb0c8, sunDir: [-0.5, 0.5, 0.7] },
    canyon: { sky: 'sky', sun: 0xffd4a0, sunI: 3.2, hemiS: 0xffe2c4, hemiG: 0x8a4a2a, hemiI: 1.1, fog: 0.0058, haze: 0xf0c8a0, exp: 1.05, grass: [1.05, 0.95, 0.75], dry: [1.1, 0.98, 0.8], gBase: 0x2a3a12, gTip: 0xa8b050, gDry: 0xd8b070, deep: 0x1a3a48, shallow: 0x4a9a8a, sunDir: [-0.55, 0.55, 0.62] },
    desert: { sky: 'sky', sun: 0xfff0d2, sunI: 3.4, hemiS: 0xfff0d8, hemiG: 0xa07850, hemiI: 1.2, fog: 0.0055, haze: 0xf5dcb0, exp: 1.0, grass: [1.1, 1.0, 0.75], dry: [1.15, 1.0, 0.8], gBase: 0x3a3a14, gTip: 0xb8b060, gDry: 0xe0c080, deep: 0x0d4a66, shallow: 0x38c0c0, sunDir: [-0.35, 0.72, 0.6] },
    volcanic: { sky: 'sky_storm', skyTint: [1.7, 1.55, 1.6], sun: 0xffc896, sunI: 3.1, hemiS: 0xb8b4c4, hemiG: 0x5e463a, hemiI: 1.7, fog: 0.0072, haze: 0x8e7672, exp: 1.45, grass: [0.8, 0.85, 0.7], dry: [0.9, 0.85, 0.7], gBase: 0x1a2410, gTip: 0x6a7a40, gDry: 0x8a7a50, deep: 0x0a1a22, shallow: 0x2a5a5a, sunDir: [-0.5, 0.45, 0.72] }
  };
  V.LOOKS = LOOKS;

  V.init = function (canvas, textures, quality, opts) {
    tx = textures; Q = quality; opts = opts || {};
    renderer = new T.WebGLRenderer({ canvas, antialias: Q.name !== 'low', preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(Q.dpr, window.devicePixelRatio || 1));
    renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = Q.softShadow ? T.PCFSoftShadowMap : T.PCFShadowMap;
    scene = new T.Scene();
    scene.fog = new T.FogExp2(0xf1d9c0, 0.0065);
    camera = new T.PerspectiveCamera(42, 1, 0.1, 900);

    hemi = new T.HemisphereLight(0xcfe2ff, 0x7a5a3a, 1.15); scene.add(hemi);
    sun = new T.DirectionalLight(0xffe0b5, 3.0);
    sun.castShadow = true; sun.shadow.mapSize.set(Q.shadow, Q.shadow);
    const sc = sun.shadow.camera; sc.left = -36; sc.right = 36; sc.top = 36; sc.bottom = -36; sc.near = 1; sc.far = 170;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04; sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    fill = new T.DirectionalLight(0x9cc0ff, 0.45); fill.position.set(-30, 20, -40); scene.add(fill);

    if (SS.skyView) { const sv = SS.skyView.init(scene, tx, Q, renderer); sky = sv.mesh; skyMat = sv.mat; }   // K2: procedural
    if (SS.farView) SS.farView.init(scene, tx, Q, renderer);                                                // LS: far world pass
    if (SS.cloudView) SS.cloudView.init(SS.farView ? SS.farView.scene() : scene, tx);                       // K2: 3D clouds
    else {
      skyMat = SS.mat.sky(tx.skies.sky);
      sky = new T.Mesh(new T.SphereGeometry(500, 48, 24), skyMat); sky.renderOrder = -10; sky.frustumCulled = false; scene.add(sky);
    }

    blankTex = new T.DataTexture(new Uint8Array(4), 1, 1, T.RGBAFormat); blankTex.needsUpdate = true;
    heightTex = new T.DataTexture(new Uint8Array(NS * NS * 4), NS, NS, T.RGBAFormat);
    heightTex.magFilter = heightTex.minFilter = T.LinearFilter; heightTex.needsUpdate = true;
    surfTex = new T.DataTexture(new Uint8Array(NS * NS * 4), NS, NS, T.RGBAFormat);
    surfTex.magFilter = surfTex.minFilter = T.LinearFilter; surfTex.needsUpdate = true;


    SS.terrain.init(scene, tx, Q);
    // the sea: render/water.js (simulated surface) after the terrain (shares its uniforms), else the legacy still plane
    if (SS.waterView) SS.waterView.init(scene, tx, Q, renderer);
    else {
      const wm = SS.mat.water(tx, tx.skies.sky, heightTex);
      water = new T.Mesh(new T.PlaneGeometry(1400, 1400), wm);
      water.rotation.x = -Math.PI / 2; water.position.set(48, SS.world.SEA, 48); water.renderOrder = 6; scene.add(water);
    }
    if (SS.dunesView) SS.dunesView.init(scene);       // dry worlds: far dunes instead of the sea (Step D2)
    SS.terrain.uniforms.tSurf.value = surfTex;
    SS.terrain.uniforms.tWater.value = SS.waterView ? SS.waterView.texture : blankTex;
    SS.terrain.uniforms.uWaterTex.value = SS.waterView ? 1 : 0;
    if (SS.lavaView) SS.lavaView.init(scene, tx, Q);
    if (SS.bodyView) SS.bodyView.init(scene, tx);
    if (SS.treeView) SS.treeView.init(scene, tx, Q);   // after terrain (shared uniforms) and bodyView (flame shader)
    SS.grass.init(scene, tx, Q);
    SS.grass.material().userData.uniforms.tSurf.value = surfTex;
    SS.terrain.onChunk = (ci, c) => SS.grass.onChunk(ci, c);

    outlineMat = SS.mat.outline();
    outline = new T.Mesh(new T.BufferGeometry(), outlineMat); outline.renderOrder = 7; outline.frustumCulled = false; scene.add(outline);
    if (SS.edgeView) SS.edgeView.init(scene, tx, Q);   // material edge that replaces the outline once rotation stops

    // floating pollen / dust motes in the light (cosmetic, render-side randomness is fine)
    const mp = new Float32Array(Q.motes * 3);
    for (let i = 0; i < mp.length; i += 3) { mp[i] = (Math.random() - 0.5) * 50; mp[i + 1] = Math.random() * 18; mp[i + 2] = (Math.random() - 0.5) * 50; }
    const mg = new T.BufferGeometry(); mg.setAttribute('position', new T.BufferAttribute(mp, 3));
    motes = new T.Points(mg, new T.PointsMaterial({ map: tx.glow, size: 0.11, color: 0xffe2a8, transparent: true, opacity: 0.55, depthWrite: false, blending: T.AdditiveBlending }));
    motes.frustumCulled = false; scene.add(motes);

    // U: the worm's lamp underground (a warm point light on the active worm; off on the surface)
    lamp = new T.PointLight(0xffd9a8, 0, 26, 1.6); scene.add(lamp);
    // night sky: stars on the upper dome (procedural points; the glow sprite), shown at night (faintly at dusk)
    { const n = 1600, p = new Float32Array(n * 3), c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const u = Math.random() * 0.97 + 0.03, a = Math.random() * 6.283, r = Math.sqrt(1 - u * u), k = 0.55 + Math.random() * 0.45, warm = Math.random();
        p[i * 3] = Math.cos(a) * r * 700; p[i * 3 + 1] = u * 700; p[i * 3 + 2] = Math.sin(a) * r * 700; c[i * 3] = k; c[i * 3 + 1] = k * (0.92 + 0.08 * warm); c[i * 3 + 2] = k * (0.85 + 0.25 * (1 - warm)); }
      const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(p, 3)); g.setAttribute('color', new T.BufferAttribute(c, 3));
      stars = new T.Points(g, new T.PointsMaterial({ map: tx.glow, size: 2.6, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false, blending: T.AdditiveBlending }));
      stars.renderOrder = -5; stars.frustumCulled = false; scene.add(stars); }
    SS.fx.init(scene, tx, Q);
    if (SS.actors.init) SS.actors.init(scene, tx, Q);
    if (SS.armsView) SS.armsView.init(scene, tx);           // P7: the PoC arsenal's models and effects
    if (SS.ventsView) SS.ventsView.init(scene);             // P25: fumaroles
    if (SS.bloodView) SS.bloodView.init(scene);             // the PoC's optional gore (setup Blood: On)
    if (SS.weatherView) SS.weatherView.init(scene, tx, Q, { skyMat, sun, hemi, fill, motes, heightTex, renderer });
    if (SS.shrapView) SS.shrapView.init(scene);        // X2: luminous casing shrapnel
    if (SS.spatView) SS.spatView.init(scene);          // LV4: lava spatter clots
    if (SS.structView) SS.structView.init(scene);      // M: steel bridges
    if (SS.iceView) SS.iceView.init(scene);            // Step I: sea ice
    if (SS.post) SS.post.init(renderer, scene, camera, Q);
    return { renderer, scene, camera };
  };

  V.resize = function (w, h) {
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    if (SS.post) SS.post.resize(w, h, renderer.getPixelRatio());
  };
  V.camera = () => camera; V.scene = () => scene; V.renderer = () => renderer;
  V.vis = w => SS.actors.vis(w);
  /* P9: client (x, y) -> the point on the section plane under the cursor, {s, y} in plane coordinates (or null) */
  const rc = new T.Raycaster(), ndc = new T.Vector2();
  V.pickPlane = function (S, cx, cy) {
    if (!renderer || !camera) return null;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, camera);
    const o = rc.ray.origin, d = rc.ray.direction, n = SS.plane.nrm(S), den = d.x * n.x + d.z * n.z;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((S.O.x - o.x) * n.x + (S.O.z - o.z) * n.z) / den;
    if (t < 0) return null;
    const p = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
    return { s: SS.plane.to_plane(S, p).s, y: p.y };
  };
  /* P1 sudden death: the sea rose (sim/water.js raise): move the flat sea planes, the terrain's still-sea level */
  V.seaChanged = function (sea) {
    if (water) water.position.y = sea;
    SS.terrain.uniforms.uSea.value = sea;
    if (SS.waterView && SS.waterView.seaChanged) SS.waterView.seaChanged(sea);
  };
  /* traps (user 2026-10-07): who looks at the screen? online: my seat's team; hot seat: the human team whose turn it is
   * (the last one while a CPU plays); a CPU-only match: -2 = sees everything */
  let lastHuman = 0;
  V.viewerTeam = function (S) {
    if (SS.net && SS.net.active && SS.net.started) return SS.net.team;
    if (!S.teams || !SS.game) return 0;
    if (S.teams.every((t, i) => SS.game.is_cpu(S, i))) return -2;
    const a = S.active; if (a && !SS.game.is_cpu(S, a.team)) lastHuman = a.team;
    return lastHuman;
  };
  // a buried trap / mine is seen by its planter's team, by everybody while it is planted (PLANT_SEEN s) or once detected;
  // the map's own mines (team -1) by everybody until mapMinesUntil (they burrow when the match is under way)
  V.trapVisible = function (S, team, planted, revealed) {
    if (revealed) return true;
    const v = V.viewerTeam(S); if (v === -2) return true;
    if (team == null || team < 0) return !(S.mapMinesUntil >= 0) || S.time < S.mapMinesUntil;
    return v === team || S.time - (planted || -99) < SS.CFG.ARMS.TRAPS.PLANT_SEEN;
  };
  V.zoom = d => { view.zoom = M.clamp(view.zoom * Math.pow(1.1, M.clamp(d, -8, 8)), 8, 80); };   // d notches (the 🔍 button sends 6)
  V.snapCamera = () => { view.camT = null; view.dir.cur = null; };
  /* the director's interests (PoC interest(), px -> m: x 0.0643; d = the PoC camera distance in px) */
  const PX = 0.0643;
  let hurtId = -1, hurtT = -99;      // the last worm hurt (id: worm objects are replaced by a replay restore)
  function interest(S, a) {
    const P2 = SS.plane, at = (s, y) => P2.to_world(S, s, y);
    if (S.phase === 'place') return null;
    if (S.phase === 'dying' && S.dyingW) { const w = S.dyingW, g = S.dyingGrave && w.grave ? w.grave : w.pos; return { key: 'dying', x: g.x, y: g.y, z: g.z, d: 480, p: 9 }; }
    if (S.strikes && S.strikes.length) {
      const st = S.strikes[0], pl = at(st.s, st.y);
      if (st.k === 0 && Math.abs(st.s - st.tS) > 14) return { key: 'plane', x: pl.x, y: pl.y - 2, z: pl.z, d: 820, p: 8 };
      const gy = SS.weapons && SS.weapons.ground_below ? SS.weapons.ground_below(S, st.tS, st.y) : st.y - 8, tp = at(st.tS, gy + 3.9);
      return { key: 'strike', x: tp.x, y: tp.y, z: tp.z, d: 760, p: 8 };
    }
    // Thunder Strike: during its delay the camera looks at the TARGET on the ground (not the sky / cloud), then the
    // electrocuted worms take over (hurt, above)
    if (S.zaps && S.zaps.length) {
      const z = S.zaps[0], gy = SS.weapons && SS.weapons.ground_below ? SS.weapons.ground_below(S, z.s, SS.world.SY - 0.5) : 0, tp = at(z.s, Math.max(gy, SS.world.SEA) + 1.5);
      return { key: 'zap', x: tp.x, y: tp.y, z: tp.z, d: 600, p: 8 };
    }
    if (S.holes && S.holes.length) { const h = S.holes[0]; return { key: 'hole', x: h.x, y: h.y, z: h.z, d: 720, p: 8 }; }
    // P29 (user 2026-10-08): after the shot the camera follows the DAMAGE: the worm being hurt (fire, a late blast)
    // wins over falling shells / gel, explosions and the shooter ("most important")
    const hw = S.phase !== 'play' && hurtId >= 0 && view.time - hurtT < 1.6 ? S.worms[hurtId] : null;
    if (hw && !hw.dead) return { key: 'hurt' + hw.id, x: hw.pos.x, y: hw.pos.y, z: hw.pos.z, d: 520, p: 7.5 };
    if (S.proj.length) {
      if (S.proj.length > 1) {
        let s0 = 1e9, y0 = 1e9, s1 = -1e9, y1 = -1e9;
        for (const p of S.proj) { s0 = Math.min(s0, p.s); y0 = Math.min(y0, p.y); s1 = Math.max(s1, p.s); y1 = Math.max(y1, p.y); }
        const asp = camera ? camera.aspect : 1.5, dd = M.clamp((Math.max((s1 - s0) / asp, y1 - y0) / PX) * 1.25 + 380, 560, 1300), c = at((s0 + s1) / 2, (y0 + y1) / 2);
        return { key: 'projs', x: c.x, y: c.y, z: c.z, d: dd, p: 7 };
      }
      const p = S.proj[0], sp = Math.hypot(p.vs, p.vy), c = at(p.s + p.vs * 0.12, p.y + p.vy * 0.12);
      return { key: 'proj' + (p.id || 0), x: c.x, y: c.y, z: c.z, d: M.clamp(560 + sp / PX * 0.3, 560, 860), p: 7 };
    }
    if (S.moais) for (const m of S.moais) { const b = m.b; if (b && Math.hypot(b.vel.x, b.vel.y, b.vel.z) > 25 * PX) return { key: 'moai', x: b.pos.x, y: b.pos.y, z: b.pos.z, d: 640, p: 6 }; }
    const ex = S.lastExplosion;
    if (ex && S.time - (S.lastBlastT == null ? -99 : S.lastBlastT) < 1.4 && ex.R >= 14 * PX) return { key: 'boom' + S.lastBlastT.toFixed(2), x: ex.x, y: ex.y, z: ex.z, d: M.clamp(470 + ex.R / PX * 4.5, 540, 1050), p: 6 };
    if (S.phase === 'play' && a && !a.dead) return { key: 'active', x: a.pos.x, y: a.pos.y, z: a.pos.z, d: 0, p: 5 };
    let fw = null, fs = 150 * PX;                 // a thrown worm (PoC 150 px/s; worms fly at the PoC gravity here)
    for (const w of S.worms) if (!w.dead && !w.rest && w !== a && w.vel) { const sp = Math.hypot(w.vel.x, w.vel.y, w.vel.z); if (sp > fs) { fs = sp; fw = w; } }
    if (fw) return { key: 'fly' + fw.id, x: fw.pos.x, y: fw.pos.y, z: fw.pos.z, d: 640, p: 5 };
    for (const b of S.bodies) {
      if (b.asleep || !b.vel) continue; const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z); if (sp < 6) continue;
      for (const w of S.worms) {
        if (w.dead) continue; const dx = w.pos.x - b.pos.x, dy = w.pos.y - b.pos.y, dz = w.pos.z - b.pos.z, dd = Math.hypot(dx, dy, dz);
        if (dd < 10 && dx * b.vel.x + dy * b.vel.y + dz * b.vel.z > 0.5 * dd * sp) return { key: 'threat' + (b.id || 0), x: (w.pos.x + b.pos.x) / 2, y: (w.pos.y + b.pos.y) / 2, z: (w.pos.z + b.pos.z) / 2, d: M.clamp(440 + dd / PX * 1.6, 540, 820), p: 5 };
      }
    }
    // ... and else the burning area (napalm / oil flames: their centre and spread) until the fire is out
    if (S.phase !== 'play' && S.flames.length) {
      let x0 = 1e9, z0 = 1e9, y0 = 1e9, x1 = -1e9, z1 = -1e9, y1 = -1e9;
      for (const f of S.flames) { x0 = Math.min(x0, f.x); x1 = Math.max(x1, f.x); y0 = Math.min(y0, f.y); y1 = Math.max(y1, f.y); z0 = Math.min(z0, f.z); z1 = Math.max(z1, f.z); }
      const span = Math.max(x1 - x0, z1 - z0, y1 - y0);
      return { key: 'fire', x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 0.6, z: (z0 + z1) / 2, d: M.clamp(500 + span / PX * 0.9, 520, 900), p: 4 };
    }
    if (a && !a.dead) return { key: 'active', x: a.pos.x, y: a.pos.y, z: a.pos.z, d: 0, p: 3 };
    return null;
  }
  /* left-drag: pan along the section; while inspecting: orbit */
  V.drag = function (dx, dy, S) {
    if (S && S.inspect > 0.5) { view.orbit.yaw = M.clamp(view.orbit.yaw - dx * 0.006, -1.4, 1.4); view.orbit.tilt = M.clamp(view.orbit.tilt + dy * 0.004, -0.5, 0.7); return; }
    const k = view.zoom * 0.0016;
    view.pan.s = M.clamp(view.pan.s - dx * k, -60, 60); view.pan.y = M.clamp(view.pan.y + dy * k, -15, 25);
  };
  V.resetPan = () => { view.pan.s = view.pan.y = 0; view.orbit.yaw = view.orbit.tilt = 0; };

  V.clearActors = () => clearActors();          // (instant replay: the restored state has new object identities)
  function clearActors() {
    SS.fx.clear();
    if (SS.actors.clear) SS.actors.clear();
    if (SS.armsView) SS.armsView.clear();
    if (SS.bloodView) SS.bloodView.clear();
    if (SS.weatherView && SS.weatherView.clear) SS.weatherView.clear();
    if (SS.shrapView) SS.shrapView.clear();
    if (SS.spatView) SS.spatView.clear();
    if (SS.structView) SS.structView.clear();
    if (SS.iceView) SS.iceView.clear();
  }

  /* ---------- new map: look, surface map, height maps (terrain meshes are built by main via buildTerrain) ---------- */
  const tc = new T.Color();
  /* PoC "Time of day": day = the biome's sun; dusk = the sun 4° above the horizon (the physical sky turns to a sunset by
   * itself, warm low light, long shadows); night = the sun under the horizon (the sky goes dark), a cool moon light
   * (shadows still), stars, and the active worm carries its lamp. 'random' picks by seed. */
  V.timeOfDay = S => SS.sim.time_of_day(S);                // (the sim owns it: the ice temperature reads it)
  function applyLook(S) {
    let L = LOOKS[S.biome] || LOOKS.temperate, skyDir = null;
    const tod = SS.world.under ? 'day' : V.timeOfDay(S); view.tod = tod;
    if (tod !== 'day') {
      const sd = L.sunDir, az = Math.atan2(sd[2], sd[0]);
      if (tod === 'dusk') { const el = 0.07; L = Object.assign({}, L, { sunDir: [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)], sunI: L.sunI * 0.9, hemiI: L.hemiI * 0.7, exp: L.exp * 1.15 }); }
      else {
        skyDir = [Math.cos(az) * 0.99, -0.14, Math.sin(az) * 0.99];
        const m = [-Math.cos(az) * 0.6, 0.62, -Math.sin(az) * 0.6];
        view.moonDir = m;
        L = Object.assign({}, L, { sunDir: m, sun: 0x9fb4e8, sunI: 0.6, hemiS: 0x405074, hemiG: 0x17150f, hemiI: 0.5, exp: L.exp * 1.35, fog: L.fog * 0.8 });
      }
    }
    let sk;
    view.wxKind = S.weather ? S.weather.kind : null;
    view.look = L;
    if (SS.skyView) {
      // K2: the procedural sky for this biome + weather; the fog / haze is the sky's own horizon colour (aerial
      // perspective: the far terrain fades into exactly the sky behind it), a little of the biome's haze tint
      sk = SS.skyView.look(S.biome, S.weather ? S.weather.kind : 'clear', skyDir || L.sunDir);
      if (SS.cloudView) SS.cloudView.look(S, sk);
      if (SS.farView) SS.farView.look(S, sk, L);
    } else {
      const skyName = (S.weather && S.weather.sky) || L.sky; sk = tx.skies[skyName] || tx.skies.sky;
      skyMat.uniforms.tSky.value = sk.tex;
      skyMat.uniforms.uHorizon.value.setRGB(sk.avg[0], sk.avg[1], sk.avg[2], T.SRGBColorSpace);
      skyMat.uniforms.uZenith.value.setRGB(sk.top[0], sk.top[1], sk.top[2], T.SRGBColorSpace);
      const st = L.skyTint || [1, 1, 1]; skyMat.uniforms.uTint.value.setRGB(st[0], st[1], st[2]);
    }
    const haze = new T.Color().setRGB(sk.horizon[0], sk.horizon[1], sk.horizon[2], T.SRGBColorSpace).lerp(new T.Color(L.haze), sk.phys ? 0.15 : 0.45);
    scene.fog.color.copy(haze); scene.fog.density = L.fog;
    view.haze = haze.clone(); view.fogBase = L.fog;
    sun.color.set(L.sun); sun.intensity = L.sunI; hemi.color.set(L.hemiS); hemi.groundColor.set(L.hemiG); hemi.intensity = L.hemiI;
    if (sk.sunT) {                      // K2: ash / dust along the sun's path dim and redden it (relative to clean air)
      const t = sk.sunT, mx = Math.max(t[0], t[1], t[2]);
      sun.color.r *= t[0] / mx; sun.color.g *= t[1] / mx; sun.color.b *= t[2] / mx; sun.intensity *= Math.max(0.35, mx);
    }
    if (tod === 'night') { sun.color.set(L.sun); sun.intensity = L.sunI; }     // moonlight (not the reddened sun beam)
    if (stars) stars.material.opacity = tod === 'night' ? 0.95 : tod === 'dusk' ? 0.18 : 0;
    renderer.toneMappingExposure = L.exp;
    const U = SS.terrain.uniforms;
    U.uHaze.value.copy(haze);
    U.uGrassTint.value.setRGB(L.grass[0], L.grass[1], L.grass[2]); U.uDryTint.value.setRGB(L.dry[0], L.dry[1], L.dry[2]);
    const G = SS.grass.material().userData.uniforms;
    G.uBase.value.set(L.gBase); G.uTip.value.set(L.gTip); G.uDryTip.value.set(L.gDry);
    if (water) {
      const wu = water.material.uniforms;
      wu.tSky.value = sk.tex; wu.uDeep.value.set(L.deep); wu.uShallow.value.set(L.shallow); wu.uFog.value.copy(haze);
      wu.uHorizon.value.setRGB(sk.horizon[0], sk.horizon[1], sk.horizon[2], T.SRGBColorSpace);
    }
    if (SS.waterView) SS.waterView.look(L, sk, haze);
    if (SS.weatherView) SS.weatherView.look(L, sk, haze);
    if (SS.fx.look) SS.fx.look(L, sk);
    // U: underground: no sun, a dim cave ambient (rock-tinted bounce), dark fog; the sky world is hidden in V.render
    if (SS.world.under) {
      sun.intensity = 0; sun.castShadow = false; fill.intensity = 0; hemi.color.set(0x8a8f99); hemi.groundColor.set(0x3a3028); hemi.intensity = 0.32;
      scene.fog.color.set(0x0b0a09); scene.fog.density = 0.032; view.haze = scene.fog.color.clone(); U.uHaze.value.copy(scene.fog.color);
      renderer.setClearColor(0x050505, 1); renderer.toneMappingExposure = 1.15;
      if (SS.weatherView) SS.weatherView.look(Object.assign({}, L, { fog: 0.032, sunI: 0, hemiI: 0.32 }), sk, scene.fog.color);   // it re-applies these per frame
    } else { renderer.setClearColor(0x000000, 1); sun.castShadow = true; }   // (no shadow pass for a dark sun underground)
  }
  /* Surface state map (cover, dryness, char, burning). Owned by the sim (SS.veg) when present. */
  function surfaceBuffer(S) {
    if (S.veg && S.veg.surf) return { buf: S.veg.surf, n: S.veg.n };
    const W = SS.world, n = NS, buf = new Uint8Array(n * n * 4), seed = (S.settings.seed | 0) * 17 + 5;
    const dryBase = { temperate: 0.12, alpine: 0.3, canyon: 0.72, desert: 0.9, volcanic: 0.62 }[S.biome] || 0.2;
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
      const c = k * W.NX + i, j = W.topJ[c], x = i * W.H, z = k * W.H;
      let cover = 0;
      if (j > 0 && W.top[c] > W.SEA + 0.5) {
        const m = W.mat[(k * W.NY + j) * W.NX + i];
        cover = m === C.MAT.SOIL ? 1 : m === C.MAT.SCREE ? 0.12 : m === C.MAT.ASH ? 0.06 : 0;
        cover *= M.smoothstep(0.28, 0.5, M.fbm2(x / 9, z / 9, seed, 3));
      }
      const dry = M.clamp(dryBase + (M.fbm2(x / 14, z / 14, seed + 3, 3) - 0.5) * 0.7, 0, 1);
      buf[(k * n + i) * 4] = cover * 255; buf[(k * n + i) * 4 + 1] = dry * 255;
    }
    return { buf, n };
  }
  function uploadSurface(S) {
    const s = surfaceBuffer(S);
    view.surf = s.buf; view.surfN = s.n; view.surfVer = S.veg ? S.veg.surfVer : 0; view.surfUploads = (view.surfUploads | 0) + 1;
    surfTex.image.data.set(s.buf.subarray(0, NS * NS * 4)); surfTex.needsUpdate = true;
    SS.grass.setSurface(s.buf, s.n);
  }
  function buildHeights() {
    view.heightmap = SS.meshgen.heightmap(97); view.heightVer++;
    const h = SS.meshgen.heightmap(NS), d = heightTex.image.data;
    for (let i = 0; i < h.length; i++) { const v = Math.round(M.clamp(h[i] / 40, 0, 1) * 255); d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = 255; }
    heightTex.needsUpdate = true;
    view.heightFor = SS.world.version;
  }
  V.newWorld = function (S) {
    clearActors();
    applyLook(S);
    uploadSurface(S);
    buildHeights();
    SS.terrain.uniforms.uSea.value = SS.world.SEA;       // per world (dry worlds: below the floor)
    SS.terrain.uniforms.uCtxSolid.value = 1;   // D3 (dry) + CX1 (all worlds): the far context is drawn solid
    if (SS.dunesView) SS.dunesView.reset(S, view);
    view.camT = null; V.resetPan(); view.activeId = -1;
    if (SS.lavaView) SS.lavaView.reset(S);
    if (SS.ventsView) SS.ventsView.reset(S);
    if (SS.bodyView) SS.bodyView.clear();
    if (SS.edgeView) SS.edgeView.reset(S);
    S.sectionDirty = true;
  };
  V.buildTerrain = onProgress => SS.terrain.buildAll(renderer, onProgress);
  V.applyLook = applyLook;
  /* slice view: how much of the world behind slice zero stays solid (view-only setting) */
  V.SLICE = { thin: 1.5, thick: 6, full: 250 };
  /* drawn as part of the slab: from slice zero (plus a body radius) back to -uBack. A worm in front of slice zero
   * would float in front of the cut face (its ground is not drawn), so it is a ghost like the off-section ones. */
  /* user 2026-10-08: what lies ON the terrain (blood stains, gibs, ...) follows the terrain's section view: nothing in
   * front of slice zero (+margin), and beyond the slab (t < -uBack - margin) only as much as the context terrain is
   * drawn (uAlpha; 0 = hidden). Patches a material's shaders (instancing aware) with the terrain's own uniforms. */
  V.slabFade = function (mat, margin) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      if (prev) prev(sh, r);
      const U = SS.terrain.uniforms;
      Object.assign(sh.uniforms, { uO: U.uO, uN: U.uN, uBack: U.uBack, uAlpha: U.uAlpha, uSlabM: { value: margin || 0.5 } });
      sh.vertexShader = 'varying vec3 vSlabW;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 slabP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          slabP = instanceMatrix * slabP;
        #endif
        vSlabW = (modelMatrix * slabP).xyz;`);
      sh.fragmentShader = 'uniform vec3 uO, uN; uniform float uBack, uAlpha, uSlabM; varying vec3 vSlabW;\n' + sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        { float tS = dot(vSlabW - uO, uN);
          if (tS > uSlabM) discard;
          if (tS < -uBack - uSlabM) { if (uAlpha < 0.004) discard; gl_FragColor.a *= uAlpha; } }`);
    };
    const key = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
    mat.customProgramCacheKey = () => key() + 'slab';
    mat.transparent = true; mat.needsUpdate = true;
    return mat;
  };
  /* the rule of render/bodies.js for any object on the terrain: drawn where the ground under it is drawn (the slab,
   * the context while it shows, everything while inspecting) */
  V.shownAt = function (S, p, r) {
    if ((view.insp || 0) > 0.05) return true;
    const n = P.nrm(S), back = SS.terrain.uniforms.uBack.value, t = (p.x - S.O.x) * n.x + (p.z - S.O.z) * n.z;
    return t <= r && (t >= -back - r || ((view.ctxA || 0) > 0.004 && back < 200));
  };
  V.inSlab = (S, p) => { const t = P.to_plane(S, p).t; return t <= C.WORM_R && t >= -SS.terrain.uniforms.uBack.value - C.WORM_R; };
  // P29j (user 2026-10-08: "the slice view setting doesn't work, the full map behind is always shown"): the slab depth
  // (uBack) AND the haze of everything behind it: thin / thick = crisp to 1.5 / 6 m, the rest recedes; full = all crisp
  V.setSlice = function (name) { V.slice = V.SLICE[name] ? name : 'thin'; SS.terrain.setBack(V.SLICE[V.slice]); SS.terrain.uniforms.uCtxHaze.value = V.slice === 'full' ? 0 : 1; return V.slice; };

  /* ---------- section outline ribbon ---------- */
  function buildOutline(sec) {
    const L = sec.outline, n = L.length / 4, d = { x: Math.cos(sec.theta), z: Math.sin(sec.theta) }, nn = { x: -d.z, z: d.x };
    const pos = new Float32Array(n * 12), rib = new Float32Array(n * 8), idx = new Uint32Array(n * 6), w = 0.11, tf = 0.03;   // on the cut face (slice zero)
    for (let i = 0; i < n; i++) {
      const s0 = L[i * 4], y0 = L[i * 4 + 1], s1 = L[i * 4 + 2], y1 = L[i * 4 + 3];
      let ps = -(y1 - y0), py = s1 - s0; const l = Math.hypot(ps, py) || 1; ps /= l; py /= l;
      const pts = [[s0 + ps * w, y0 + py * w, s0, 1], [s0 - ps * w, y0 - py * w, s0, -1], [s1 + ps * w, y1 + py * w, s1, 1], [s1 - ps * w, y1 - py * w, s1, -1]];
      for (let k = 0; k < 4; k++) {
        const o = (i * 4 + k) * 3, s = pts[k][0], y = pts[k][1];
        pos[o] = sec.O.x + s * d.x + tf * nn.x; pos[o + 1] = y; pos[o + 2] = sec.O.z + s * d.z + tf * nn.z;
        rib[(i * 4 + k) * 2] = pts[k][2]; rib[(i * 4 + k) * 2 + 1] = pts[k][3];
      }
      const b = i * 4; idx.set([b, b + 1, b + 3, b, b + 3, b + 2], i * 6);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('rib', new T.BufferAttribute(rib, 2)); g.setIndex(new T.BufferAttribute(idx, 1));
    outline.geometry.dispose(); outline.geometry = g;
  }

  /* ---------- events ---------- */
  function onEvents(S) {
    const camDist = view.zoom;
    for (const e of S.events) {
      switch (e.type) {
        case 'reset': clearActors(); hurtId = -1; break;
        case 'hurt': if (e.worm) { hurtId = e.worm.id; hurtT = view.time; } break;   // the camera follows the damage (interest)
        case 'explode': SS.fx.explosion(e, camDist); break;
        case 'splash': SS.fx.splash(e.x, e.y, e.z, e.size); if (SS.waterView) SS.waterView.onEvent(e); break;
        case 'waterblast': SS.fx.waterBlast(e); if (SS.waterView) SS.waterView.onEvent(e); break;
        case 'lavaplop': SS.fx.lava(e.x, e.y, e.z, Math.min(1.4, 0.35 + (e.speed || 0) * 0.06)); break;
        case 'icebreak': SS.fx.dust(e.x, e.y + 0.05, e.z, Math.min(5, 2 + e.r | 0), 0.4 + 0.15 * e.r, 0xdbe6ee); if (SS.fx.steam) SS.fx.steam(e.x, e.y, e.z, 0.15); break;
        case 'steelcut': SS.fx.dust(e.x, e.y, e.z, 2, 0.35, 0x8a8580); break;
        case 'bridgefall': SS.fx.dust(e.x, e.y, e.z, 5, 1.2, 0x7a7068); break;
        case 'lavasplash': SS.fx.lava(e.x, e.y, e.z, Math.min(2.2, 0.6 + Math.sqrt(e.volume || 0))); break;
        case 'lavabreach': SS.fx.lava(e.x, e.y, e.z, 1.2); break;
        case 'steam': SS.fx.steam(e.x, e.y, e.z, e.power); break;
        case 'rubble': for (let i = 0; i < e.pts.length; i += 3) SS.fx.dust(e.pts[i].x, e.pts[i].y, e.pts[i].z, 2, 0.5); break;
        case 'collapse': SS.fx.dust(e.x, e.y, e.z, Math.min(14, 4 + e.pieces * 2), 1.2); break;
        case 'rebake': SS.fx.dust(e.x, e.y - 0.5, e.z, Math.min(12, 3 + (e.voxels / 60) | 0), 1.0); break;
        case 'bodyhit': SS.fx.dust(e.x, e.y, e.z, 4, 0.5); break;
        case 'propbreak': SS.fx.dust(e.x, e.y, e.z, e.why === 'burnt' ? 6 : 9, 0.6, e.why === 'burnt' ? 0x3a3330 : 0x8a6a48); break;
        case 'minedisarm': SS.fx.splash(e.x, e.y, e.z, 0.4); break;
        case 'oilfire': SS.fx.dust(e.x, e.y + 0.5, e.z, 8, 1.4, 0x2a2420); break;
        case 'grassfire': SS.fx.dust(e.x, e.y + 0.3, e.z, Math.min(5, 2 + e.cells / 10 | 0), 0.5, 0x3a3330); break;
        case 'land': SS.fx.dust(e.x, e.y, e.z, Math.min(10, 2 + e.speed | 0), 0.5); break;
        case 'bounce': SS.fx.dust(e.x, e.y, e.z, 3, 0.3); SS.fx.spark(e.x, e.y, e.z); break;
        case 'jump': SS.fx.dust(e.x, e.y - 0.45, e.z, 3, 0.35); break;
        case 'fire': SS.fx.dust(e.pos.x, e.pos.y, e.pos.z, 4, 0.4, 0xdddddd); break;
        case 'rope_hook': SS.fx.spark(e.x, e.y, e.z); break;
      }
      if (SS.fx.onEvent) SS.fx.onEvent(S, e, camDist);
      if (SS.actors.onEvent) SS.actors.onEvent(S, e);
      if (SS.armsView) SS.armsView.onEvent(S, e);
      if (SS.bloodView) SS.bloodView.onEvent(S, e);
      if (SS.audio) SS.audio.onEvent(S, e);                   // P10: procedural sound
      if (SS.weatherView && SS.weatherView.onEvent) SS.weatherView.onEvent(S, e);
      if (SS.shrapView) SS.shrapView.onEvent(S, e);
      if (SS.ui && SS.ui.onEvent) SS.ui.onEvent(S, e);
    }
    S.events.length = 0;
  }

  /* ---------- per-frame sync + render ---------- */
  const ease = x => x * x * (3 - 2 * x);
  const v4 = new T.Vector3(), yAxis = new T.Vector3(0, 1, 0);
  V.render = function (S, dt) {
    view.time += dt;
    onEvents(S);
    if (S.weather && view.wxKind !== undefined && S.weather.kind !== view.wxKind) applyLook(S);   // 5f: the weather turned
    const W = SS.world;
    SS.terrain.update(renderer, S, dt, Q.remeshMs);
    if (W.version !== view.heightFor && view.time - view.heightT > 0.4) { buildHeights(); view.heightT = view.time; }
    if (S.veg && S.veg.surfVer !== view.surfVer) uploadSurface(S);
    // the section also follows world edits that do not mark it dirty (collapse, rebake), at most ~3 times a second
    // (also whenever the plane moved without a dirty flag: the drawn section must always be the one the terrain is cut at)
    const moved = S.section && (S.section.O.x !== S.O.x || S.section.O.z !== S.O.z || S.section.theta !== S.theta);
    if (S.sectionDirty || !S.section || moved || (W.version !== view.secWV && view.time - view.secT > 0.3)) {
      S.section = SS.meshgen.section(S);
      buildOutline(S.section);
      S.sectionDirty = false; S.stats.slabBuilds++; view.secWV = W.version; view.secT = view.time;
      if (SS.ui && SS.ui.sectionChanged) SS.ui.sectionChanged(S);
    }
    const edgeA = SS.edgeView ? SS.edgeView.frame(S, view) : 0;
    view.edgeA = edgeA;
    const d = P.dir(S), n = P.nrm(S), a = S.active;
    const insp = ease(M.clamp(S.inspect, 0, 1)), ctxA = Math.max(ease(M.clamp(S.ctx, 0, 1)), insp * 0.9);
    // The terrain beyond the slab stays drawn, solid and without the ghost haze (uCtxSolid): it is the landscape
    // behind the cut. D3 did this for dry worlds (a 1 m stand-in grid used to replace it after the fade: it poked
    // through cliffs, filled arches and popped in at the end of the fade); CX1 (user, 2026-10-07: "i like how it is on
    // desert now, but keep the sea") for all worlds: on wet maps the faded state showed the flat outer sea plane over
    // the land behind the slab (a mirror sheet + the old shoreline foam as a white curve, "glass ground", also seen
    // from caves) and props hung in the sky during the fade (P1). Worms keep the fade (S.ctx, actors).
    const ctxF = 1;
    view.ctxA = ctxF; view.insp = insp;
    view.pxScale = renderer.domElement.height * camera.projectionMatrix.elements[5] * 0.5;
    SS.terrain.frame(S, view, ctxF, insp);
    const wind = S.wind || null;
    SS.grass.frame(S, view.time, wind ? wind.mean : null, wind ? wind.whirls : null, S.weather ? S.weather.snowCover : 0);
    outlineMat.uniforms.uTime.value = view.time; outlineMat.uniforms.uAlpha.value = (0.55 + 0.45 * (1 - insp)) * (1 - edgeA);
    outline.visible = edgeA < 0.999;
    if (water) water.material.uniforms.uTime.value = view.time;

    // camera: side-on from the +normal side with a slight downward tilt; inspection swings into a 3D overview.
    if (a && a.id !== view.activeId) { view.activeId = a.id; V.resetPan(); }
    // PoC: walking, jumping, charging or firing hands the camera back to the worm (a manual pan eases out)
    if (a && !a.dead && (a.walking || a.air || S.charging || S.proj.length) && (view.pan.s || view.pan.y)) { const k = Math.exp(-dt * 5); view.pan.s *= k; view.pan.y *= k; if (Math.abs(view.pan.s) + Math.abs(view.pan.y) < 0.05) view.pan.s = view.pan.y = 0; }
    // PoC camera director (interest() / updateCamera): the most interesting thing wins by priority, a new interest of
    // the same or lower priority takes over only after 1.2 s; zoom = the PoC distance / its default 640 px x the user's
    const it = interest(S, a), dr = view.dir;
    dr.since += dt;
    if (it && (!dr.cur || it.key === dr.cur.key || it.p > dr.cur.p || dr.since > 1.2 || (S.phase === 'play' && it.key === 'active'))) { if (!dr.cur || it.key !== dr.cur.key) dr.since = 0; dr.cur = it; }
    else if (!it && dr.cur && dr.since > 1.2) dr.cur = null;
    const cur = dr.cur || { key: 'active', x: a ? a.pos.x : 48, y: a ? a.pos.y : 10, z: a ? a.pos.z : 48, d: 0, p: 0 };
    const pk = cur.key === 'active' ? 1 : 0, fx = cur.x + d.x * view.pan.s * pk, fy = cur.y + 1.2 + view.pan.y * pk, fz = cur.z + d.z * view.pan.s * pk;
    const wantZ = cur.key === 'active' ? view.zoom : Math.max(view.zoom * 0.85, view.zoom * cur.d / 640);
    if (!view.camT) { view.camT = new T.Vector3(fx, fy, fz); view.camZ = wantZ; }
    const rate = cur.key === 'active' ? 6 : cur.p >= 7 ? 4.5 : 3.2;
    view.camT.lerp(v4.set(fx, fy, fz), 1 - Math.exp(-dt * rate));
    view.camZ += (wantZ - view.camZ) * (1 - Math.exp(-dt * 2.4));
    if (insp < 0.05) { view.orbit.yaw *= Math.exp(-dt * 4); view.orbit.tilt *= Math.exp(-dt * 4); }
    const tilt = 0.2 + insp * (0.5 + view.orbit.tilt), yaw = insp * (0.55 + view.orbit.yaw), dist = (view.camZ || view.zoom) * (1 + insp * 0.9);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), bx = n.x * cy + d.x * sy, bz = n.z * cy + d.z * sy;
    camera.position.set(view.camT.x + bx * dist * Math.cos(tilt), view.camT.y + dist * Math.sin(tilt), view.camT.z + bz * dist * Math.cos(tilt));
    camera.lookAt(view.camT);
    const sh = SS.fx.shake();
    if (sh > 0) { camera.position.x += (Math.random() - 0.5) * sh * 0.5; camera.position.y += (Math.random() - 0.5) * sh * 0.5; camera.position.z += (Math.random() - 0.5) * sh * 0.5; }
    sky.position.copy(camera.position);
    view.sky = sky;
    // sun follows the action so the shadow map stays dense around it
    const L = (view.look || LOOKS.temperate).sunDir;
    sun.target.position.copy(view.camT); sun.position.set(view.camT.x + L[0] * 80, view.camT.y + L[1] * 80, view.camT.z + L[2] * 80);
    SS.terrain.uniforms.uSunDir.value.set(L[0], L[1], L[2]).normalize();
    if (water) water.material.uniforms.uSun.value.set(L[0], L[1], L[2]).normalize();
    motes.position.set(view.camT.x, 0, view.camT.z);
    const mp = motes.geometry.attributes.position;
    for (let i = 0; i < mp.count; i++) {
      let y = mp.getY(i) + dt * 0.12; if (y > 20) y = 1 + Math.random() * 2;
      mp.setXYZ(i, mp.getX(i) + Math.sin(view.time * 0.3 + i) * dt * 0.15, y, mp.getZ(i) + Math.cos(view.time * 0.25 + i * 1.7) * dt * 0.15);
    }
    mp.needsUpdate = true;

    if (SS.actors.sync) SS.actors.sync(S, view, ctxA, insp, dt);
    if (SS.lavaView) SS.lavaView.frame(S, view);
    if (SS.bodyView) SS.bodyView.frame(S, view);
    if (SS.treeView) SS.treeView.frame(S, view);
    if (SS.waterView) SS.waterView.frame(S, view, camera);
    if (SS.dunesView) SS.dunesView.frame(S, view);
    if (SS.weatherView) SS.weatherView.frame(S, view, camera, dt);
    if (SS.farView) SS.farView.frame();
    if (SS.cloudView) { SS.cloudView.frame(S, view, camera, dt); if (SS.skyView) SS.skyView.frame(camera, SS.cloudView.drift(), SS.cloudView.uniforms.uVis.value, view.time); }
    if (SS.shrapView) SS.shrapView.frame(S, view, camera, dt);
    if (SS.spatView) SS.spatView.frame(S, view, camera);
    if (SS.structView) SS.structView.frame(S, view);
    if (SS.iceView) SS.iceView.frame(S, view);
    if (SS.armsView) SS.armsView.frame(S, view, camera, dt);
    if (SS.ventsView) SS.ventsView.frame(S, view, camera, dt);
    if (SS.bloodView) SS.bloodView.frame(S, dt);
    SS.fx.update(dt, camera);
    // U: underground maps hide the whole sky world (several modules re-enable their meshes per frame) and light the
    // active worm's lamp
    if (SS.world.under) {
      if (sky) sky.visible = false; if (motes) motes.visible = false;
      for (const m of [SS.cloudView && SS.cloudView.mesh && SS.cloudView.mesh(), SS.farView && SS.farView.quad && SS.farView.quad()]) if (m) m.visible = false;
      if (SS.waterView && SS.waterView.meshes) for (const m of SS.waterView.meshes()) if (m) m.visible = false;
      const a = S.active; lamp.intensity = a && !a.dead ? 34 : 0; if (a) lamp.position.set(a.pos.x, a.pos.y + 0.7, a.pos.z);
    } else {
      if (sky) sky.visible = true; if (motes) motes.visible = view.tod !== 'night';
      // night: the active worm's lamp lights its surroundings (as in the caves, a little weaker)
      const a = S.active; lamp.intensity = view.tod === 'night' && a && !a.dead ? 26 : 0; if (a) lamp.position.set(a.pos.x, a.pos.y + 0.7, a.pos.z);
    }
    if (stars) { stars.position.copy(camera.position); stars.visible = !SS.world.under && stars.material.opacity > 0; }
    if (SS.post && Q.bloom) SS.post.render(view);
    else if (SS.lens && S.holes && S.holes.length) {                       // P29c: gravitational lensing (render/lens.js)
      const HK = C.ARMS.HOLE;
      SS.lens.render(renderer, scene, camera, S.holes.map(h => ({ x: h.x, y: h.y, z: h.z, s: 0.25 + 0.55 * Math.min(1, h.t / HK.GROW) })));
    } else renderer.render(scene, camera);
  };

})(window.SS = window.SS || {});
