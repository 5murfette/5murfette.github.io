/* render/arms.js — the PoC arsenal on screen (P7; Three.js). Everything procedural (geometry + shaders; the only
 * textures are the canvas-made glow / ring sprites): projectile models (actors.js asks projMesh(type)), the walking
 * sheep, devices (pocket magnet, spring mine), black holes (dark core + a swirling additive accretion disc), the
 * strike plane, parachute supply crates, sniper streaks and shotgun tracers, lightning arcs between zapped worms,
 * teleport beams, the moai head (bodies.js asks moaiGroup()), and the aim helpers: the target cross on S.tgt, the
 * cursor cross for target weapons, the strike side arrow and the girder ghost (green = valid, red = too far).
 * API: init(scene, tx), clear(), frame(S, view, camera, dt), onEvent(S, e), projMesh(type), moaiGroup(), cursor
 * (main.js sets {x, y} client px), stats(). */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, P = SS.plane;
  const AV = SS.armsView = {};
  let scene = null, tx = null, groupDyn = null;
  const std = (c, o) => new T.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.5, metalness: 0.2 }, o || {}));
  const M = {
    olive: std(0x55673a, { metalness: 0.35 }), red: std(0xc23b2a), dark: std(0x26282b, { metalness: 0.5 }), steel: std(0xb8bcc2, { metalness: 0.85, roughness: 0.3 }),
    gold: std(0xe0b84a, { metalness: 0.9, roughness: 0.25, emissive: 0x3a2800 }), yellow: std(0xf0d23a, { roughness: 0.55 }), blue: std(0x3b6fd0, { metalness: 0.4 }),
    white: std(0xf2f0ea, { roughness: 0.8 }), wool: std(0xf4f1e8, { roughness: 1 }), black: std(0x161616, { roughness: 0.6 }), orange: std(0xe0782a, { emissive: 0x401400 }),
    cream: std(0xe9e1cc, { roughness: 0.9 }), wood: std(0x8a5a32, { roughness: 0.9 }), cloth: std(0xe8e2d0, { roughness: 1, side: T.DoubleSide }), stone: std(0x8d857a, { roughness: 0.95, metalness: 0 }),
    stoneD: std(0x6e665c, { roughness: 1, metalness: 0 }), magnet: std(0xd23a2a, { metalness: 0.5 }), coil: std(0xc9cdd2, { metalness: 0.9, roughness: 0.25 }), plate: std(0xf0c030),
    plane: std(0x6f7a68, { metalness: 0.4 }), foam: std(0xf6fbff, { roughness: 0.9 })
  };
  const KEEP = new Set(Object.values(M));                  // the shared materials above survive a removed object's dispose
  const G = {
    sph: r => new T.SphereGeometry(r, 14, 10), cyl: (r0, r1, h, n) => new T.CylinderGeometry(r0, r1, h, n || 12), box: (x, y, z) => new T.BoxGeometry(x, y, z)
  };
  const add = (g, geo, mat, x, y, z, rx, ry, rz) => { const m = new T.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); m.rotation.set(rx || 0, ry || 0, rz || 0); m.castShadow = true; g.add(m); return m; };

  /* ---------- projectile models (local +x = flight direction for rockets) ---------- */
  function rocket(bodyMat, s) {
    const g = new T.Group(); s = s || 1;
    add(g, G.cyl(0.07 * s, 0.07 * s, 0.5 * s), bodyMat, 0, 0, 0, 0, 0, Math.PI / 2);
    add(g, new T.ConeGeometry(0.07 * s, 0.16 * s, 12), M.red, 0.33 * s, 0, 0, 0, 0, -Math.PI / 2);
    for (let i = 0; i < 3; i++) add(g, G.box(0.12 * s, 0.01, 0.12 * s), M.dark, -0.22 * s, 0, 0, i * 2.09, 0, 0);
    return g;
  }
  const BUILD = {
    cluster: () => { const g = new T.Group(); add(g, G.sph(0.13), M.red); for (let i = 0; i < 6; i++) add(g, G.sph(0.03), M.yellow, Math.cos(i) * 0.12, Math.sin(i * 2) * 0.06, Math.sin(i) * 0.12); return g; },
    clusterlet: () => { const g = new T.Group(); add(g, G.sph(0.07), M.dark); return g; },
    banana: () => { const g = new T.Group(); add(g, new T.TorusGeometry(0.16, 0.055, 8, 16, Math.PI * 0.9), M.yellow, 0, 0, 0, 0, 0, 0.6); add(g, G.sph(0.025), M.black, 0.16, 0.02, 0); return g; },
    bananalet: () => { const g = BUILD.banana(); g.scale.setScalar(0.65); return g; },
    // an original orb: gilded sphere with a band and a little crown of studs (no cross)
    holy: () => { const g = new T.Group(); add(g, G.sph(0.15), M.gold); add(g, new T.TorusGeometry(0.152, 0.018, 6, 24), M.steel, 0, 0, 0, Math.PI / 2); for (let i = 0; i < 5; i++) add(g, G.sph(0.03), M.blue, Math.cos(i * 1.257) * 0.08, 0.14, Math.sin(i * 1.257) * 0.08); return g; },
    homing: () => rocket(M.blue), missile: () => rocket(M.plane, 0.8), napalm: () => { const g = rocket(M.orange, 0.9); return g; },
    flame: () => { const s = new T.Sprite(new T.SpriteMaterial({ map: tx.glow, color: 0x8a3a0a, blending: T.AdditiveBlending, depthWrite: false, transparent: true })); s.scale.set(0.38, 0.38, 1); const g = new T.Group(); g.add(s); return g; },
    fuel: () => BUILD.flame(),
    dynamite: () => { const g = new T.Group(); for (const z of [-0.06, 0, 0.06]) add(g, G.cyl(0.035, 0.035, 0.32), M.red, 0, 0, z); add(g, G.box(0.04, 0.06, 0.2), M.cream, 0, 0.05, 0); add(g, G.cyl(0.008, 0.008, 0.12), M.dark, 0, 0.2, 0); return g; },
    blackhole: () => { const g = new T.Group(); add(g, G.sph(0.11), M.black); add(g, new T.TorusGeometry(0.12, 0.02, 6, 20), M.steel, 0, 0, 0, Math.PI / 2); return g; },
    foam: () => { const g = new T.Group(); add(g, G.sph(0.11), M.foam); add(g, new T.SphereGeometry(0.115, 12, 6, 0, Math.PI * 2, 0, 1.0), M.blue); return g; },
    // ASSET: proj_sheep (models/proj_sheep.glb, clips walk / hop)
    sheep: () => {
      const g = new T.Group(), body = new T.Group(); g.add(body);
      for (let i = 0; i < 9; i++) add(body, G.sph(0.11 + 0.03 * ((i * 7) % 3) / 2), M.wool, Math.cos(i * 2.4) * 0.12, 0.06 + Math.sin(i * 1.7) * 0.07, Math.sin(i * 2.4) * 0.1);
      add(body, G.box(0.12, 0.12, 0.1), M.black, 0.24, 0.12, 0); add(body, G.box(0.05, 0.03, 0.12), M.black, 0.22, 0.17, 0);
      const legs = []; for (const [x, z] of [[-0.1, -0.06], [-0.1, 0.06], [0.1, -0.06], [0.1, 0.06]]) legs.push(add(body, G.cyl(0.018, 0.018, 0.16), M.black, x, -0.12, z));
      g.userData.legs = legs; return g;
    }
  };
  const cache = {};
  AV.projMesh = function (type) { const f = BUILD[type]; if (!f) return null; return f(); };
  const ROCKET = { homing: 1, missile: 1, napalm: 1 };
  AV.isRocket = type => !!ROCKET[type];

  /* ---------- the moai head (a stone body from weapons.js; local y up, 2.2 m tall) ---------- */
  // ASSET: moai (models/moai.glb)
  AV.moaiGroup = function () {
    const g = new T.Group();
    add(g, G.box(0.95, 1.9, 0.85), M.stone, 0, -0.1, 0);
    add(g, G.box(1.05, 0.22, 0.95), M.stoneD, 0, 0.62, 0);                // brow ridge
    add(g, G.box(0.22, 0.75, 0.3), M.stone, 0, 0.1, 0.5);                  // the long nose
    add(g, G.box(0.6, 0.12, 0.12), M.stoneD, 0, -0.45, 0.45);              // pressed lips
    for (const x of [-0.53, 0.53]) add(g, G.box(0.12, 0.9, 0.3), M.stoneD, x, 0.05, -0.05);   // long ears
    add(g, G.box(0.85, 0.35, 0.8), M.stoneD, 0, -1.12, 0);                 // chin / neck
    return { group: g, meshes: g.children };
  };

  /* ---------- live objects ---------- */
  const live = { devices: new Map(), holes: new Map(), strikes: new Map(), crates: new Map(), bullets: new Map() };
  const fx = [];                        // short-lived: tracers, arcs, beams {obj, t, life, fade}
  let tgtCross = null, curCross = null, arrow = null, ghost = null, sniperLine = null;
  AV.cursor = null;
  AV.init = function (sc, textures) {
    scene = sc; tx = textures;
    groupDyn = new T.Group(); scene.add(groupDyn);
    const cross = col => { const s = new T.Sprite(new T.SpriteMaterial({ map: tx.ring, color: col, depthTest: false, transparent: true })); s.renderOrder = 12; s.scale.set(0.9, 0.9, 1); s.visible = false; scene.add(s); return s; };
    tgtCross = cross(0xff5b4f); curCross = cross(0x79d98b);
    arrow = new T.Mesh(new T.ConeGeometry(0.35, 0.9, 3), new T.MeshBasicMaterial({ color: 0xffb02e, depthTest: false, transparent: true, opacity: 0.85 }));
    arrow.renderOrder = 12; arrow.visible = false; scene.add(arrow);
    ghost = new T.Mesh(G.box(1, 1, 1), new T.MeshBasicMaterial({ color: 0x79d98b, transparent: true, opacity: 0.35, depthWrite: false }));
    ghost.renderOrder = 11; ghost.visible = false; scene.add(ghost);
    { const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array(80 * 3), 3).setUsage(T.DynamicDrawUsage));
      sniperLine = new T.Line(g, new T.LineDashedMaterial({ color: 0xffe08a, dashSize: 0.35, gapSize: 0.25, transparent: true, opacity: 0.8, depthTest: false }));
      sniperLine.renderOrder = 12; sniperLine.frustumCulled = false; sniperLine.visible = false; scene.add(sniperLine); }
  };
  const torches = [];
  function roomTorches(S, t) {
    const R = S.rooms || [];
    for (let i = 0; i < R.length; i++) {
      let L = torches[i]; if (!L) { L = new T.PointLight(0xffa860, 0, 9, 1.8); scene.add(L); torches.push(L); }
      L.position.set(R[i].x, R[i].y + R[i].rh - 0.5, R[i].z); L.intensity = 9 * (0.85 + 0.15 * Math.sin(t * 13 + i * 2) * Math.sin(t * 7.3 + i));
    }
    for (let i = R.length; i < torches.length; i++) torches[i].intensity = 0;
  }
  AV.clear = function () {
    for (const k in live) { for (const o of live[k].values()) groupDyn.remove(o); live[k].clear(); }
    for (const f of fx) groupDyn.remove(f.obj); fx.length = 0;
  };
  function addFx(obj, life) { groupDyn.add(obj); fx.push({ obj, t: 0, life }); }
  // a thin additive line (tracer, beam) between two world points
  function streak(a, b, col, w, life) {
    const d = new T.Vector3(b.x - a.x, b.y - a.y, b.z - a.z), L = d.length() || 0.01;
    const m = new T.Mesh(G.cyl(w, w, L, 6), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false }));
    m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), d.normalize());
    addFx(m, life); return m;
  }
  // a jagged electric arc (midpoint displacement; Math.random is fine: presentation only)
  function arc(a, b, life) {
    const pts = [new T.Vector3(a.x, a.y, a.z), new T.Vector3(b.x, b.y, b.z)];
    for (let it = 0; it < 4; it++) for (let i = pts.length - 1; i > 0; i--) {
      const p = pts[i - 1].clone().add(pts[i]).multiplyScalar(0.5), L = pts[i - 1].distanceTo(pts[i]) * 0.25;
      p.x += (Math.random() - 0.5) * L; p.y += (Math.random() - 0.5) * L; p.z += (Math.random() - 0.5) * L; pts.splice(i, 0, p);
    }
    const line = new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: 0xbfe6ff, transparent: true, blending: T.AdditiveBlending, depthWrite: false }));
    addFx(line, life);
  }
  AV.onEvent = function (S, e) {
    if (e.type === 'shot' && e.weapon === 'shotgun' && e.from && e.to) { streak(e.from, e.to, 0xffe9a0, 0.025, 0.16); SS.fx.spark(e.to.x, e.to.y, e.to.z); }
    if (e.type === 'shot' && e.end && e.to) SS.fx.spark(e.to.x, e.to.y, e.to.z);
    if (e.type === 'zap') arc(e.from, e.to, 0.3);
    // (teleport: the PoC beams + ghosts live in render/actors.js teleStart)
    if (e.type === 'airburst') SS.fx.explosion({ x: e.x, y: e.y, z: e.z, W: 0.05, R: 1 }, 20);
    if (e.type === 'sparks') SS.fx.spark(e.x, e.y, e.z);
    if (e.type === 'shatter') { SS.fx.dust(e.x, e.y, e.z, 14, 1.0, 0x8d857a); SS.fx.dust(e.x, e.y + 0.8, e.z, 8, 0.6, 0x6e665c); }
    if (e.type === 'foam') SS.fx.dust(e.x, e.y, e.z, 8, 0.5, 0xf0f6ff);
    if (e.type === 'blow') { const d = P.dir(S); for (let i = 0; i < 10; i++) SS.fx.dust(e.x + d.x * e.ds * i * 0.5, e.y + e.dy * i * 0.5, e.z + d.z * e.ds * i * 0.5, 1, 0.4, 0xe8eef2); }
    if (e.type === 'devbreak') SS.fx.spark(e.x, e.y, e.z);
    if (e.type === 'spring') SS.fx.dust(e.x, e.y, e.z, 4, 0.3, 0xf0c030);
    if (e.type === 'searise' && SS.view.seaChanged) SS.view.seaChanged(e.sea);
  };

  // ASSET: device_magnet / device_spring (models/device_*.glb)
  function deviceMesh(kind) {
    const g = new T.Group();
    if (kind === 'magnet') { add(g, G.box(0.36, 0.06, 0.24), M.dark, 0, -0.1, 0); add(g, new T.TorusGeometry(0.11, 0.045, 8, 16, Math.PI), M.magnet, 0, 0.0, 0, 0, 0, Math.PI); for (const x of [-0.11, 0.11]) add(g, G.box(0.09, 0.06, 0.09), M.steel, x, -0.03, 0);
      const ring = new T.Mesh(new T.RingGeometry(C.ARMS.MAGNET.R - 0.05, C.ARMS.MAGNET.R, 64), new T.MeshBasicMaterial({ color: 0xff5b4f, transparent: true, opacity: 0.18, side: T.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.y = -0.12; g.add(ring); }
    else { add(g, G.box(0.3, 0.05, 0.3), M.dark, 0, -0.1, 0); const coil = add(g, new T.TorusKnotGeometry(0.08, 0.015, 48, 6, 1, 6), M.coil, 0, 0.02, 0, Math.PI / 2); coil.scale.z = 1.6; add(g, G.box(0.24, 0.03, 0.24), M.plate, 0, 0.15, 0); g.userData.arrow = add(g, new T.ConeGeometry(0.06, 0.18, 8), M.orange, 0, 0.3, 0); }
    return g;
  }
  function holeMesh() {
    const g = new T.Group();
    // the black core (render/lens.js draws the event horizon itself: the sphere would be lensed into a black donut over
    // the Einstein ring, so it shows only without the lens pass)
    g.userData.core = add(g, G.sph(1), new T.MeshBasicMaterial({ color: 0x000000 }));
    const disc = new T.Mesh(new T.RingGeometry(1.1, 3.2, 64, 1), new T.ShaderMaterial({
      uniforms: { uT: { value: 0 } }, transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide,
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uT; varying vec2 vP;
        void main(){ float r = length(vP), a = atan(vP.y, vP.x);
          float sw = 0.5 + 0.5 * sin(a * 3.0 + 6.0 / r - uT * 6.0);                       // spiral arms
          float k = (1.0 - smoothstep(1.1, 3.2, r)) * smoothstep(1.05, 1.3, r);
          vec3 c = mix(vec3(0.35, 0.1, 0.8), vec3(1.0, 0.75, 1.0), pow(1.0 - (r - 1.1) / 2.1, 3.0));
          gl_FragColor = vec4(c * k * (0.35 + 0.9 * sw), k * (0.4 + 0.6 * sw)); }`
    }));
    disc.rotation.x = -Math.PI / 2.4; g.add(disc); g.userData.disc = disc;
    return g;
  }
  // ASSET: strike_plane (models/strike_plane.glb)
  function planeMesh() {
    const g = new T.Group();
    add(g, G.cyl(0.35, 0.25, 5.2, 12), M.plane, 0, 0, 0, 0, 0, Math.PI / 2);
    add(g, G.box(1.2, 0.08, 7.5), M.plane, 0.3, 0, 0); add(g, G.box(0.6, 0.06, 2.6), M.plane, -2.4, 0.1, 0); add(g, G.box(0.6, 1.1, 0.06), M.plane, -2.4, 0.55, 0);
    const props = []; for (const z of [-2.8, -1.4, 1.4, 2.8]) { add(g, G.cyl(0.14, 0.14, 0.6, 8), M.dark, 0.6, -0.1, z, 0, 0, Math.PI / 2); props.push(add(g, G.box(0.04, 0.9, 0.1), M.dark, 0.95, -0.1, z)); }
    g.userData.props = props; return g;
  }
  /* supply crate (user 2026-10-08: textured crates, the parachute properly rigged and alive): a planked crate (canvas
   * texture: boards, grain, nailed battens; weapon = a hazard band + stencilled "?", health = white with a GREEN
   * first-aid cross, never the protected red-cross emblem); a canopy of 8 alternating gores that breathes and ripples at
   * the rim, swinging as a pendulum over the crate; 8 suspension lines from the rim to the four top corners, rebuilt
   * every frame from the deformed canopy */
  const crateTex = {};
  // ASSET: crate_weapon / crate_health textures (models/crate_*.glb)
  function crateTexture(kind) {
    if (crateTex[kind]) return crateTex[kind];
    const N = 128, cv = document.createElement('canvas'); cv.width = cv.height = N; const x = cv.getContext('2d');
    const health = kind === 'health';
    x.fillStyle = health ? '#e9e4d8' : '#9a6a3c'; x.fillRect(0, 0, N, N);
    for (let p = 0; p < 4; p++) {                                   // four boards with grain and gaps
      const y0 = p * N / 4;
      x.fillStyle = health ? (p % 2 ? '#e2ddcf' : '#ece8de') : (p % 2 ? '#8e6034' : '#a77443'); x.fillRect(0, y0 + 1, N, N / 4 - 2);
      x.strokeStyle = health ? 'rgba(120,110,95,0.25)' : 'rgba(60,35,15,0.45)'; x.lineWidth = 1;
      for (let g = 0; g < 5; g++) { x.beginPath(); const gy = y0 + 4 + g * 6 + Math.random() * 2; x.moveTo(0, gy); for (let gx = 0; gx <= N; gx += 16) x.lineTo(gx, gy + Math.sin(gx * 0.08 + p * 3 + g) * 1.5); x.stroke(); }
      x.fillStyle = health ? '#b8b0a0' : '#3e2612'; x.fillRect(0, y0, N, 1.5);
    }
    x.fillStyle = health ? '#c9c2b2' : '#5a3a1e';                  // battens round the face, nail heads
    x.fillRect(0, 0, N, 10); x.fillRect(0, N - 10, N, 10); x.fillRect(0, 0, 10, N); x.fillRect(N - 10, 0, 10, N);
    x.fillStyle = '#2a2a2a'; for (const [nx, ny] of [[5, 5], [N - 5, 5], [5, N - 5], [N - 5, N - 5], [N / 2, 5], [N / 2, N - 5]]) { x.beginPath(); x.arc(nx, ny, 1.6, 0, 7); x.fill(); }
    if (health) {
      x.fillStyle = '#1f9a4a'; x.fillRect(N / 2 - 30, N / 2 - 30, 60, 60);
      x.fillStyle = '#ffffff'; x.fillRect(N / 2 - 7, N / 2 - 22, 14, 44); x.fillRect(N / 2 - 22, N / 2 - 7, 44, 14);
    } else {
      x.save(); x.beginPath(); x.rect(10, N / 2 - 13, N - 20, 26); x.clip();
      for (let k = -4; k < 12; k++) { x.fillStyle = k % 2 ? '#1b1b1b' : '#f2c21a'; x.beginPath(); x.moveTo(k * 16, N / 2 - 13); x.lineTo(k * 16 + 16, N / 2 - 13); x.lineTo(k * 16 + 4, N / 2 + 13); x.lineTo(k * 16 - 12, N / 2 + 13); x.fill(); }
      x.restore();
      x.fillStyle = 'rgba(20,20,20,0.85)'; x.font = 'bold 34px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('?', N / 2, N / 2 - 34); x.fillText('?', N / 2, N / 2 + 34);
    }
    const t = new T.CanvasTexture(cv); t.anisotropy = 4; if (T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace;
    return (crateTex[kind] = t);
  }
  const CANOPY_R = 1.15, CANOPY_H = 0.75, CANOPY_UP = 2.0;
  // ASSET: crate_weapon / crate_health + parachute (models/crate_*.glb, models/parachute.glb)
  function crateMesh(c) {
    const g = new T.Group(), kind = c && c.kind === 'health' ? 'health' : 'weapon';
    const box = add(g, G.box(0.6, 0.6, 0.6), new T.MeshStandardMaterial({ map: crateTexture(kind), roughness: 0.85, metalness: 0 }));
    box.receiveShadow = true;
    // canopy: a dome of 8 gores (vertex colours), pivoting above the crate
    const pivot = new T.Group(); pivot.position.set(0, 0.3, 0); g.add(pivot);
    const geo = new T.SphereGeometry(1, 24, 7, 0, Math.PI * 2, 0, 1.25), pa = geo.attributes.position, col = new Float32Array(pa.count * 3);
    for (let i = 0; i < pa.count; i++) { const gore = Math.floor(((Math.atan2(pa.getZ(i), pa.getX(i)) + Math.PI) / (Math.PI * 2)) * 8 + 0.5) % 2; const c3 = gore ? [0.86, 0.16, 0.12] : [0.95, 0.92, 0.84]; col[i * 3] = c3[0]; col[i * 3 + 1] = c3[1]; col[i * 3 + 2] = c3[2]; }
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    const base = Float32Array.from(pa.array);
    const canopy = new T.Mesh(geo, new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, side: T.DoubleSide }));
    canopy.position.y = CANOPY_UP; canopy.castShadow = true; pivot.add(canopy);
    const lines = new T.LineSegments(new T.BufferGeometry(), new T.LineBasicMaterial({ color: 0x3a3530 }));
    lines.geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(16 * 3), 3)); lines.frustumCulled = false; g.add(lines);
    g.userData = { box, pivot, canopy, base, lines, seed: Math.random() * 10, kind };
    return g;
  }
  const cv3 = new T.Vector3();
  function crateFrame(m, c, t, dt) {
    const u = m.userData, flying = !c.landed;
    u.pivot.visible = u.lines.visible = flying;
    if (!flying) { m.rotation.set(0, m.rotation.y, 0); return; }
    // pendulum: the canopy sways (wind + slow oscillation), the crate lags behind it under the lines
    const sw = Math.sin(t * 1.1 + u.seed) * 0.13 + Math.sin(t * 2.7 + u.seed * 2) * 0.04, sw2 = Math.sin(t * 0.9 + u.seed * 3) * 0.08;
    u.pivot.rotation.set(sw2, 0, sw); m.rotation.z = -sw * 0.45; m.rotation.x = -sw2 * 0.45;
    // canopy: breathing (inflate / deflate) + travelling ripples growing toward the rim
    const pa = u.canopy.geometry.attributes.position, b = u.base, br = 1 + 0.045 * Math.sin(t * 2.3 + u.seed);
    for (let i = 0; i < pa.count; i++) {
      const x = b[i * 3], y = b[i * 3 + 1], z = b[i * 3 + 2], a = Math.atan2(z, x), rim = Math.pow(1 - Math.max(0, y), 2);
      const k = br * (1 + rim * (0.06 * Math.sin(a * 8 + t * 5.3 + u.seed) + 0.035 * Math.sin(a * 3 - t * 2.1)));
      pa.setXYZ(i, x * CANOPY_R * k, y * CANOPY_H * (2 - br) + rim * 0.05 * Math.sin(a * 5 + t * 4), z * CANOPY_R * k);
    }
    pa.needsUpdate = true; u.canopy.geometry.computeVertexNormals();
    // lines: 8 rim points (every 3rd of the 24 segments on the lowest ring) to the crate's top corners
    u.pivot.updateMatrix(); u.canopy.updateMatrix();
    const lp = u.lines.geometry.attributes.position, ring = 7 * 25;   // last ring index base (widthSegments + 1 per ring)
    for (let q = 0; q < 8; q++) {
      const vi = ring + q * 3; cv3.set(pa.getX(vi), pa.getY(vi), pa.getZ(vi)).applyMatrix4(u.canopy.matrix).applyMatrix4(u.pivot.matrix);
      const corner = [[0.3, 0.3], [0.3, -0.3], [-0.3, -0.3], [-0.3, 0.3]][Math.floor(((q + 0.5) / 8) * 4) % 4];
      lp.setXYZ(q * 2, cv3.x, cv3.y, cv3.z); lp.setXYZ(q * 2 + 1, corner[0], 0.3, corner[1]);
    }
    lp.needsUpdate = true;
  }
  function sync(map, list, make, upd) {
    const seen = new Set();
    for (const o of list) { let m = map.get(o); if (!m) { m = make(o); groupDyn.add(m); map.set(o, m); } seen.add(o); upd(o, m); }
    for (const [o, m] of map) if (!seen.has(o)) { groupDyn.remove(m); map.delete(o); SS.mat.disposeTree(m, KEEP); }   // devices, holes, crates, ... (shared M.* materials kept)
  }
  AV.frame = function (S, view, camera, dt) {
    if (!scene) return;
    const t = view.time || 0, d = P.dir(S);
    roomTorches(S, t);
    sync(live.devices, S.devices || [], o => deviceMesh(o.kind), (o, m) => {
      m.position.set(o.pos.x, o.pos.y + 0.1, o.pos.z); m.rotation.y = -o.theta;
      // a spring trap burrows (seen by its team, by all while planted / once detected); sunk a little when buried
      m.visible = SS.view.shownAt(S, o.pos, 0.6) && (o.kind !== 'spring' || SS.view.trapVisible(S, o.team, o.planted, o.revealed));
      if (o.kind === 'spring') m.position.y -= Math.min(1, Math.max(0, (S.time - o.planted - 1) / 1.5)) * 0.12;
      if (m.userData.arrow) { m.userData.arrow.rotation.z = -Math.atan2(o.ds, o.dy); m.userData.arrow.position.set(o.ds * 0.12, 0.3, 0); }
    });
    sync(live.holes, S.holes || [], () => holeMesh(), (h, m) => {
      const k = Math.min(1, h.t / C.ARMS.HOLE.GROW), sc = 0.25 + 0.55 * k * (1 + 0.06 * Math.sin(t * 20));
      m.position.set(h.x, h.y, h.z); m.scale.setScalar(sc); m.userData.disc.material.uniforms.uT.value = t; m.userData.disc.rotation.z = t * 2;
      if (m.userData.core) m.userData.core.visible = !SS.lens;
    });
    sync(live.strikes, S.strikes || [], () => planeMesh(), (st, m) => {
      const p = P.to_world(S, st.s, st.y); m.position.set(p.x, p.y, p.z); m.rotation.y = -Math.atan2(d.z * st.dir, d.x * st.dir);
      for (const pr of m.userData.props) pr.rotation.x = t * 40;
    });
    sync(live.crates, S.crates || [], c => crateMesh(c), (c, m) => {
      m.position.set(c.pos.x, c.pos.y, c.pos.z); m.rotation.y = c.id * 0.7;
      m.visible = SS.view.shownAt(S, c.pos, 0.6);
      if (m.visible) crateFrame(m, c, t, dt);
    });
    sync(live.bullets, S.bullets || [], () => new T.Mesh(G.cyl(0.02, 0.02, 1.6, 5), new T.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false })), (b, m) => {
      const p = P.to_world(S, b.s, b.y); m.position.set(p.x, p.y, p.z);
      const v = new T.Vector3(d.x * b.vs, b.vy, d.z * b.vs).normalize(); m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), v);
    });
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i]; f.t += dt;
      if (f.t >= f.life) { groupDyn.remove(f.obj); if (f.obj.geometry) f.obj.geometry.dispose(); if (f.obj.material) f.obj.material.dispose(); fx.splice(i, 1); continue; }
      if (f.obj.material) f.obj.material.opacity = (f.obj.material.opacity > 0.6 ? 0.9 : 0.5) * (1 - f.t / f.life);
    }
    // aim helpers (only on a human turn)
    const a = S.active, wd = (a && C.ARSENAL[S.weapon]) || {}, play = S.phase === 'play' && a && !a.dead;
    tgtCross.visible = false; curCross.visible = false; arrow.visible = false; ghost.visible = false; sniperLine.visible = false;
    if (!play) return;
    // sniper (PoC traceBullet): the exact bullet path with its drop, to the first hit
    if (S.weapon === 'sniper' && !SS.game.is_cpu(S, a.team)) {
      const K = C.ARMS.SNIPER, ad = SS.sim.aim_dir(S), ap = P.to_plane(S, a.pos); let s = ap.s + ad.s * 0.6, y = a.pos.y + ad.y * 0.6, vs = ad.s * K.V, vy = ad.y * K.V, n = 0;
      const pts = sniperLine.geometry.attributes.position.array;
      for (let i = 0; i < 160 && n < 80; i++) {
        const h = 0.006; vy -= C.G * K.G * h; s += vs * h; y += vy * h;
        if (i % 2 === 0) { const p = P.to_world(S, s, y); pts[n * 3] = p.x; pts[n * 3 + 1] = p.y; pts[n * 3 + 2] = p.z; n++; }
        if (P.solid2(S, s, y) || S.worms.some(o => !o.dead && o !== a && Math.hypot(o.pos.x - P.to_world(S, s, y).x, o.pos.y - y, o.pos.z - P.to_world(S, s, y).z) < C.WORM_R)) break;
      }
      sniperLine.geometry.setDrawRange(0, n); sniperLine.geometry.attributes.position.needsUpdate = true; sniperLine.computeLineDistances(); sniperLine.visible = n > 1;
      if (n > 1) { tgtCross.visible = true; tgtCross.position.set(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1], pts[(n - 1) * 3 + 2]); }
    }
    if (S.tgt && wd.target) { const p = P.to_world(S, S.tgt.s, S.tgt.y); tgtCross.position.set(p.x, p.y, p.z); tgtCross.visible = true; tgtCross.material.rotation = -t * 2; }
    let cur = null;
    if (AV.cursor && (wd.kind === 'target' || wd.target)) cur = SS.view.pickPlane(S, AV.cursor.x, AV.cursor.y);
    if (cur) {
      const p = P.to_world(S, cur.s, cur.y);
      if (S.weapon === 'girder') {
        const K = C.ARMS.GIRDER, ang = (S.girderA || 0) * Math.PI / K.ANGLES, ap = P.to_plane(S, a.pos), ok = Math.hypot(cur.s - ap.s, cur.y - a.pos.y) <= K.REACH;
        ghost.visible = true; ghost.scale.set(K.L, K.T, K.D * 2); ghost.position.set(p.x, p.y, p.z); ghost.rotation.set(0, -S.theta, ang, 'YXZ');
        ghost.material.color.set(ok ? 0x79d98b : 0xff5b4f);
      } else { curCross.visible = true; curCross.position.set(p.x, p.y, p.z); curCross.material.rotation = t; }
      if (wd.strike) { arrow.visible = true; arrow.position.set(p.x - d.x * S.strikeDir * 3, p.y + 4, p.z - d.z * S.strikeDir * 3); arrow.rotation.set(0, -S.theta, -Math.PI / 2 * S.strikeDir - 0.5 * S.strikeDir, 'YXZ'); }
    }
  };
  AV.stats = () => ({ devices: live.devices.size, holes: live.holes.size, strikes: live.strikes.size, crates: live.crates.size, fx: fx.length });
})(window.SS = window.SS || {});
