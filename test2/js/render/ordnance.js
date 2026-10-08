/* render/ordnance.js — projectile and held-weapon models (Three.js, all procedural geometry + shaders; user 2026-10-08:
 * "the projectile (bazooka for example) model should also look nice when in the air, also spin, have flaps, like real
 * projectile").
 *   rockets (bazooka, homing, missile, napalm shell): lathe-turned motor body with a boat-tail and a nozzle, a tangent
 *     ogive warhead with a fuze tip, a stripe band, four swept tail fins canted 4 deg (that is why a real rocket ROLLS:
 *     the model spins about its axis with the airspeed), steering canard flaps on the guided ones that deflect with
 *     the turn rate, and a procedural exhaust plume (ShaderMaterial, additive, flickering noise; never an image);
 *   grenades: a lathe-turned "pineapple" with segment grooves, the fuze head, the spoon lever and the pin ring; it
 *     tumbles about the section normal with its speed (spin = v / r, as if rolling through the air) and wobbles;
 *   cluster, banana, holy orb, dynamite (fizzing fuse spark), black hole, foam, sheep: models + tumble / spin;
 *   held weapons (port of the PoC makeHeldMesh, PoC px x 0.045 m): local +x = the aim, origin = the worm's grip.
 * API: SS.ordnance.proj(type) -> Group | null; update(group, p, S, dt, t) per frame (orientation, roll, tumble,
 *      plume); held(id) -> Group; tick(t) updates the shared shader clocks.
 * Porting: one prefab per projectile type / held weapon; the update maps to a tiny per-instance script. */
(function (SS) {
  'use strict';
  const T = window.THREE, PI = Math.PI;
  const OR = SS.ordnance = {};
  const std = (c, o) => new T.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.45, metalness: 0.3 }, o || {}));
  const MAT = {
    olive: std(0x55673a, { metalness: 0.35, roughness: 0.55 }), olive2: std(0x3f4d2b, { roughness: 0.6 }), blue: std(0x2f63c8, { metalness: 0.45, roughness: 0.35 }),
    steel: std(0xb8bcc2, { metalness: 0.85, roughness: 0.28 }), dark: std(0x24262a, { metalness: 0.55, roughness: 0.45 }), red: std(0xc8321f, { roughness: 0.4 }),
    white: std(0xf0eee8, { roughness: 0.5, metalness: 0.1 }), yellow: std(0xf0c82a, { roughness: 0.5 }), orange: std(0xd8701f, { roughness: 0.5 }),
    gold: std(0xe0b84a, { metalness: 0.9, roughness: 0.22, emissive: 0x3a2800 }), green: std(0x3d5a26, { roughness: 0.55, metalness: 0.25 }),
    wood: std(0x8a5a32, { roughness: 0.85, metalness: 0 }), brass: std(0xc8a040, { metalness: 0.8, roughness: 0.3 }), black: std(0x141414, { roughness: 0.7 }),
    tape: std(0xd8cfb8, { roughness: 0.9, metalness: 0 }), nozzle: std(0x1a1a1c, { metalness: 0.6, roughness: 0.5, side: T.DoubleSide }),
    glass: std(0x113322, { emissive: 0x33ff88, emissiveIntensity: 1 }), girder: std(0xbe5c34, { roughness: 0.6 }), wool: std(0xf4f1e8, { roughness: 1, metalness: 0 }),
    foam: std(0xf6fbff, { roughness: 0.9, metalness: 0 }), ash: std(0xc89a5a, { roughness: 0.55, metalness: 0 }), stone: std(0x8d857a, { roughness: 0.95, metalness: 0 }),
    banana: std(0xffe330, { roughness: 0.35, metalness: 0.05, emissive: 0x4a3a00, emissiveIntensity: 1 }),   // user: brighter
    star: std(0xffe24a, { emissive: 0xffc020, emissiveIntensity: 0.9, roughness: 0.4, metalness: 0 })
  };
  for (const k in MAT) MAT[k].userData.shared = true;          // actors.clear() disposes per-worm materials, never these
  const mesh = (geo, mat, x, y, z) => { const m = new T.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); m.castShadow = true; return m; };

  /* ---------- the exhaust plume: procedural fire (shader), cone along -x from the nozzle ---------- */
  const CLOCK = { value: 0 };
  const PLUME_VS = 'varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }';
  const PLUME_FS = [
    'uniform float uTime; uniform float uSeed; uniform float uHot; varying vec2 vUv; varying vec3 vN; varying vec3 vV;',
    'float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }',
    'void main(){',
    '  float t = vUv.y;                                         // 0 at the nozzle, 1 at the plume tip',
    '  float rim = abs(dot(normalize(vN), normalize(vV)));      // 1 = facing the camera (the plume core)',
    '  float fl = n(vec2(vUv.x * 6.0 + uSeed, t * 7.0 - uTime * 38.0)) * 0.6 + n(vec2(vUv.x * 13.0, t * 15.0 - uTime * 61.0)) * 0.4;',
    '  float body = pow(1.0 - t, 1.4) * smoothstep(0.0, 0.06, t + 0.02);',
    '  float a = clamp(body * pow(rim, 1.2) * (0.65 + 0.75 * fl) * uHot, 0.0, 1.0);',
    '  float core = pow(max(0.0, 1.0 - t * 2.2), 2.0) * pow(rim, 3.0);',
    '  vec3 c = mix(vec3(1.0, 0.32, 0.06), vec3(1.0, 0.78, 0.35), clamp(1.0 - t * 1.6 + fl * 0.3, 0.0, 1.0));',
    '  c = mix(c, vec3(1.0, 0.97, 0.85), core);',
    '  gl_FragColor = vec4(c * a * 3.0, a);',
    '}'].join('\n');
  function plume(len, r, hot) {
    // the wide base sits at the nozzle (x = 0), the apex trails behind at x = -len (+y -> -x); uv.y: 0 base, 1 apex
    const geo = new T.ConeGeometry(r, len, 18, 1, true); geo.translate(0, len / 2, 0); geo.rotateZ(PI / 2);
    const mat = new T.ShaderMaterial({
      uniforms: { uTime: CLOCK, uSeed: { value: Math.random() * 50 }, uHot: { value: hot || 1 } }, vertexShader: PLUME_VS, fragmentShader: PLUME_FS,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide
    });
    mat.userData.shared = true; const m = new T.Mesh(geo, mat); m.renderOrder = 6; m.castShadow = false;
    return m;
  }
  // a fizzing spark (dynamite fuse, the grenade's fuze is silent): a small additive billboard-ish sphere, shader noise
  const SPARK_FS = 'uniform float uTime; uniform float uSeed; varying vec2 vUv; varying vec3 vN; varying vec3 vV; void main(){ float rim = abs(dot(normalize(vN), normalize(vV))); float f = 0.6 + 0.4 * sin(uTime * 47.0 + uSeed) * sin(uTime * 31.0 + uSeed * 2.0); float a = pow(rim, 2.5) * f; gl_FragColor = vec4(vec3(1.0, 0.75, 0.3) * a * 2.5, a); }';
  function spark(r) {
    const m = new T.Mesh(new T.SphereGeometry(r, 10, 8), new T.ShaderMaterial({ uniforms: { uTime: CLOCK, uSeed: { value: Math.random() * 9 } }, vertexShader: PLUME_VS, fragmentShader: SPARK_FS, transparent: true, depthWrite: false, blending: T.AdditiveBlending }));
    m.material.userData.shared = true; m.castShadow = false; m.renderOrder = 6; return m;
  }

  /* ---------- rockets: local +x = the nose ---------- */
  // lathe profiles are built along +y, then turned so +y -> +x
  const toX = g => { g.rotateZ(-PI / 2); return g; };
  function lathe(pts, seg) { return toX(new T.LatheGeometry(pts.map(p => new T.Vector2(p[0], p[1])), seg || 20)); }
  function ogive(R, L, y0, n) {               // tangent ogive from radius R at y0 to a point at y0 + L
    const rho = (R * R + L * L) / (2 * R), out = [];
    for (let i = 0; i <= n; i++) { const x = L * i / n; out.push([Math.max(0.0005, Math.sqrt(Math.max(0, rho * rho - x * x)) + R - rho), y0 + x]); }
    return out;
  }
  // a swept-back fin in the x-y plane: root chord x in [0, root] (x = 0 the trailing edge, +x toward the nose), span
  // along +y, the tip chord set back by `sweep`; thickness along z
  function finGeo(root, tip, span, sweep, th) {
    const s = new T.Shape(), tx = -sweep * 0.4;
    s.moveTo(0, 0); s.lineTo(root, 0); s.lineTo(tx + tip, span); s.lineTo(tx, span); s.lineTo(0, 0);
    const g = new T.ExtrudeGeometry(s, { depth: th, bevelEnabled: false }); g.translate(0, 0, -th / 2);
    return g;
  }
  const ROCKETS = {
    bazooka: { L: 0.62, R: 0.055, body: 'olive', nose: 'olive2', tip: 'red', band: 'yellow', canards: false, plume: [0.75, 0.075] },
    homing: { L: 0.66, R: 0.052, body: 'blue', nose: 'white', tip: 'dark', band: 'white', canards: true, plume: [0.8, 0.07] },
    missile: { L: 0.55, R: 0.045, body: 'steel', nose: 'dark', tip: 'red', band: 'red', canards: true, plume: [0.6, 0.06] },
    napalm: { L: 0.5, R: 0.06, body: 'orange', nose: 'dark', tip: 'dark', band: 'black', canards: false, plume: null }
  };
  // ASSET: proj_rocket / proj_homing / proj_missile / proj_napalm (models/proj_*.glb; the plume() shader stays procedural)
  function rocket(type) {
    const d = ROCKETS[type], L = d.L, R = d.R, g = new T.Group(), roll = new T.Group(); g.add(roll);
    const y0 = -L / 2, yN = y0 + L * 0.62;                    // motor from the tail to 62 %, then the warhead
    // motor: nozzle lip, boat-tail, body tube
    roll.add(mesh(lathe([[R * 0.55, y0], [R * 0.72, y0 + L * 0.03], [R * 0.9, y0 + L * 0.08], [R, y0 + L * 0.14], [R, yN]], 22), MAT[d.body]));
    // warhead: a tangent ogive + a fuze tip
    roll.add(mesh(lathe(ogive(R * 1.02, L * 0.34, yN, 12), 22), MAT[d.nose]));
    roll.add(mesh(new T.SphereGeometry(R * 0.2, 10, 8), MAT[d.tip], yN + L * 0.34 - R * 0.05));
    // stripe band where the warhead meets the motor, and a raised ring behind it
    const band = mesh(new T.CylinderGeometry(R * 1.035, R * 1.035, L * 0.035, 22), MAT[d.band], yN - L * 0.03); band.rotation.z = -PI / 2; roll.add(band);
    const ring = mesh(new T.CylinderGeometry(R * 1.06, R * 1.06, L * 0.02, 22), MAT.dark, y0 + L * 0.3); ring.rotation.z = -PI / 2; roll.add(ring);
    // nozzle bell (open, dark inside)
    const nz = mesh(new T.CylinderGeometry(R * 0.55, R * 0.42, L * 0.05, 16, 1, true), MAT.nozzle, y0 - L * 0.02); nz.rotation.z = -PI / 2; roll.add(nz);
    // four swept tail fins, canted 4 deg (the roll), trailing edge flush with the tail
    const fg = finGeo(L * 0.24, L * 0.1, R * 1.5, L * 0.1, Math.max(0.004, R * 0.08));
    for (let k = 0; k < 4; k++) {
      const arm = new T.Group(); arm.rotation.x = k * PI / 2 + PI / 4; roll.add(arm);
      const f = mesh(fg, MAT.dark, y0 + L * 0.02, R * 0.92, 0); f.rotation.y = 0.07; arm.add(f);
    }
    // canard flaps near the nose (guided rockets): deflected by update() with the turn rate
    const flaps = [];
    if (d.canards) {
      const cg = finGeo(L * 0.07, L * 0.04, R * 0.85, L * 0.025, Math.max(0.003, R * 0.06));
      for (let k = 0; k < 4; k++) {
        const arm = new T.Group(); arm.rotation.x = k * PI / 2; roll.add(arm);
        const hinge = new T.Group(); hinge.position.set(yN - L * 0.06, R * 0.95, 0); arm.add(hinge);
        const f = mesh(cg, MAT.dark, -L * 0.035, 0, 0); hinge.add(f); flaps.push({ hinge, sgn: k < 2 ? 1 : -1, horiz: k % 2 === 1 });
      }
    }
    let fire = null;
    if (d.plume) { fire = plume(d.plume[0], d.plume[1], 1); fire.position.x = y0 - L * 0.04; g.add(fire); const inner = plume(d.plume[0] * 0.45, d.plume[1] * 0.55, 1.4); inner.position.x = fire.position.x; g.add(inner); g.userData.inner = inner; }
    g.userData = Object.assign(g.userData, { kind: 'rocket', roll, flaps, fire, R, rollA: Math.random() * 6.28, lastA: null, defl: 0 });
    return g;
  }

  /* ---------- grenades and other thrown things: tumble about the section normal ---------- */
  function pineapple(mat, R, H) {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const a = -PI / 2 + i / 24 * PI, groove = 1 - 0.07 * Math.pow(Math.abs(Math.sin(i / 24 * PI * 5)), 0.5) * (i > 1 && i < 23 ? 1 : 0);
      pts.push([Math.max(0.001, Math.cos(a) * R * groove), Math.sin(a) * H / 2]);
    }
    const geo = new T.LatheGeometry(pts.map(p => new T.Vector2(p[0], p[1])), 28), pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) {                 // longitudinal grooves: 8 segments around
      const x = pa.getX(i), z = pa.getZ(i), ph = Math.atan2(z, x), k = 1 - 0.06 * Math.pow(Math.abs(Math.cos(ph * 4)), 8);
      pa.setX(i, x * k); pa.setZ(i, z * k);
    }
    geo.computeVertexNormals();
    return mesh(geo, mat);
  }
  // ASSET: proj_grenade / proj_cluster (models/proj_grenade.glb, proj_cluster.glb)
  function grenade(bodyMat, R, extra) {
    const g = new T.Group(), spin = new T.Group(); g.add(spin);
    const H = R * 2.3;
    spin.add(pineapple(bodyMat, R, H));
    spin.add(mesh(new T.CylinderGeometry(R * 0.32, R * 0.36, R * 0.42, 14), MAT.steel, 0, H / 2 + R * 0.14));
    // the spoon lever down the side, and the pin ring
    const lever = mesh(new T.BoxGeometry(R * 0.28, R * 1.3, R * 0.07), MAT.steel, R * 0.55, H / 2 - R * 0.3, 0); lever.rotation.z = -0.42; spin.add(lever);
    const pin = mesh(new T.TorusGeometry(R * 0.26, R * 0.05, 6, 14), MAT.steel, -R * 0.38, H / 2 + R * 0.2, R * 0.12); pin.rotation.y = 0.5; spin.add(pin);
    if (extra) extra(spin, R, H);
    g.userData = { kind: 'tumble', spin, R: R, a: Math.random() * 6.28, wob: Math.random() * 6.28 };
    return g;
  }
  function tumbleOf(build, R) { return () => { const g = new T.Group(), spin = new T.Group(); g.add(spin); build(spin); g.userData = { kind: 'tumble', spin, R, a: Math.random() * 6.28, wob: Math.random() * 6.28 }; return g; }; }

  // ASSET: proj_clusterlet, proj_banana, proj_holy, proj_dynamite, proj_blackhole, proj_foam (models/proj_*.glb)
  const BUILD = {
    bazooka: () => rocket('bazooka'), homing: () => rocket('homing'), missile: () => rocket('missile'), napalm: () => rocket('napalm'),
    grenade: () => grenade(MAT.green, 0.1),
    cluster: () => grenade(MAT.red, 0.11, (s, R, H) => {
      const b = mesh(new T.CylinderGeometry(R * 1.02, R * 1.02, R * 0.25, 24), MAT.yellow); s.add(b);
      for (let i = 0; i < 8; i++) { const st = mesh(new T.CylinderGeometry(R * 0.12, R * 0.12, R * 0.14, 8), MAT.steel, Math.cos(i * 0.785) * R * 0.97, -H * 0.2, Math.sin(i * 0.785) * R * 0.97); st.rotation.set(0, -i * 0.785, PI / 2); s.add(st); }
    }),
    clusterlet: tumbleOf(s => { s.add(mesh(new T.SphereGeometry(0.06, 10, 8), MAT.dark)); s.add(mesh(new T.ConeGeometry(0.035, 0.05, 8), MAT.red, 0, 0.065, 0)); }, 0.06),
    banana: tumbleOf(s => {
      const b = mesh(new T.TorusGeometry(0.15, 0.055, 10, 20, PI * 0.95), MAT.banana); b.rotation.z = PI * 1.02; s.add(b);
      s.add(mesh(new T.SphereGeometry(0.03, 8, 6), MAT.black, -0.15, -0.015)); s.add(mesh(new T.CylinderGeometry(0.018, 0.022, 0.05, 6), MAT.wood, 0.155, -0.02));
    }, 0.12),
    bananalet: () => { const g = BUILD.banana(); g.userData.spin.scale.setScalar(0.65); g.userData.R = 0.08; return g; },
    // (both bananas tumble freely on all three axes: FREE3 in OR.proj)
    // an original orb: gilded sphere with a band and a little crown of studs (no cross; LEGAL.md)
    holy: tumbleOf(s => {
      s.add(mesh(new T.SphereGeometry(0.15, 22, 16), MAT.gold));
      const band = mesh(new T.TorusGeometry(0.152, 0.018, 6, 28), MAT.steel); band.rotation.x = PI / 2; s.add(band);
      for (let i = 0; i < 5; i++) s.add(mesh(new T.SphereGeometry(0.028, 8, 6), MAT.blue, Math.cos(i * 1.257) * 0.08, 0.135, Math.sin(i * 1.257) * 0.08));
    }, 0.15),
    dynamite: () => {
      const g = tumbleOf(s => {
        for (const [x, z] of [[-0.045, 0], [0.045, 0], [0, 0.04]]) { const st = mesh(new T.CylinderGeometry(0.036, 0.036, 0.3, 12), MAT.red, x, 0, z); s.add(st); }
        for (const y of [-0.08, 0.08]) s.add(mesh(new T.CylinderGeometry(0.088, 0.088, 0.04, 16), MAT.tape, 0, y, 0.01));
        const fuse = mesh(new T.CylinderGeometry(0.006, 0.006, 0.14, 5), MAT.dark, 0.01, 0.2, 0.04); fuse.rotation.z = -0.3; s.add(fuse);
      }, 0.1)();
      const sp = spark(0.03); sp.position.set(0.03, 0.27, 0.04); g.userData.spin.add(sp);
      return g;
    },
    blackhole: () => {
      const g = tumbleOf(s => {
        s.add(mesh(new T.SphereGeometry(0.1, 16, 12), MAT.black));
        const r = mesh(new T.TorusGeometry(0.125, 0.016, 6, 24), MAT.steel); r.rotation.x = PI / 2.3; s.add(r);
      }, 0.1)();
      return g;
    },
    foam: tumbleOf(s => {
      s.add(mesh(new T.SphereGeometry(0.1, 16, 12), MAT.foam)); s.add(mesh(new T.CylinderGeometry(0.035, 0.035, 0.06, 10), MAT.blue, 0, 0.11, 0));
      const t = mesh(new T.TorusGeometry(0.102, 0.014, 6, 20), MAT.blue); s.add(t);
    }, 0.1)
  };
  const FREE3 = { banana: 1, bananalet: 1 };
  OR.proj = function (type) {
    const f = BUILD[type]; if (!f) return null;
    const g = f(), u = g.userData;
    if (FREE3[type] && u.kind === 'tumble') { u.free3 = [(4 + Math.random() * 5) * (Math.random() < 0.5 ? -1 : 1), (3 + Math.random() * 6) * (Math.random() < 0.5 ? -1 : 1)]; u.ax = Math.random() * 6.28; u.ay = Math.random() * 6.28; }
    return g;
  };
  OR.isRocket = type => !!ROCKETS[type];

  /* per frame: g in the section frame (local +x = +s ... yaw), orientation from the velocity, roll / tumble / plume */
  OR.update = function (g, p, S, dt, t) {
    const u = g.userData; if (!u || !u.kind) return;
    const sp = Math.hypot(p.vs || 0, p.vy || 0);
    if (u.kind === 'rocket') {
      const ang = Math.atan2(p.vy || 0, p.vs || 0);
      g.rotation.set(0, -S.theta, ang, 'YXZ');
      // roll: canted fins spin the round with the airspeed (~2.5 turns per 10 m)
      u.rollA += dt * (1.6 * sp + 4); u.roll.rotation.x = u.rollA;
      // canards follow the turn rate (homing steering; ballistic arcs give a small trim)
      let rate = 0; if (u.lastA != null) { let da = ang - u.lastA; da = Math.atan2(Math.sin(da), Math.cos(da)); rate = da / Math.max(1e-3, dt); }
      u.lastA = ang; u.defl += (Math.max(-0.45, Math.min(0.45, rate * 0.18)) - u.defl) * Math.min(1, dt * 10);
      for (const f of u.flaps) f.hinge.rotation.y = (f.horiz ? 0.5 : 1) * f.sgn * u.defl * Math.cos(u.rollA);   // about the span
      if (u.fire) {
        const on = !p.wet, fl = 0.85 + 0.15 * Math.sin(t * 53 + u.rollA) + 0.08 * Math.sin(t * 91);
        u.fire.visible = u.inner.visible = on;
        u.fire.scale.set(fl * (0.75 + Math.min(0.45, sp * 0.012)), 1, 1); u.inner.scale.set(fl, 1, 1);
      }
    } else if (u.kind === 'tumble') {
      // yaw into the section, then spin about the section normal with the speed; resting = no spin
      g.rotation.set(0, -S.theta, 0, 'YXZ');
      const w = sp > 0.3 ? -(p.vs || 0) / Math.max(0.05, u.R) * 0.55 : 0;
      u.a += w * dt; u.wob += dt * Math.min(9, sp * 0.8);
      if (u.free3) {
        // user 2026-10-08: a thrown banana tumbles on ALL three axes (incommensurate rates per banana, from its speed)
        const k = sp > 0.3 ? Math.min(1, sp / 6) : 0, r3 = u.free3;
        u.ax += r3[0] * k * dt; u.ay += r3[1] * k * dt;
        u.spin.rotation.set(u.ax, u.ay, u.a, 'XYZ');
      } else u.spin.rotation.set(Math.sin(u.wob) * 0.25 * Math.min(1, sp * 0.2), 0, u.a);
    }
  };
  OR.tick = function (t) { CLOCK.value = t; };

  /* ---------- held weapons (PoC makeHeldMesh, px x K m): local +x along the aim, origin = grip ---------- */
  const K = 0.045;
  // ASSET: held_<weapon> (models/held_*.glb; grips = hand attachment points)
  OR.held = function (id) {
    const g = new T.Group();
    const add = (m, x, y, z) => { m.position.set((x || 0) * K, (y || 0) * K, (z || 0) * K); m.castShadow = true; g.add(m); return m; };
    const box = (w, h, d, m) => new T.Mesh(new T.BoxGeometry(w * K, h * K, d * K), m);
    const cyl = (r0, r1, h, mat, seg) => { const c = new T.Mesh(new T.CylinderGeometry(r0 * K, r1 * K, h * K, seg || 14), mat); c.rotation.z = -PI / 2; return c; };
    if (id === 'bazooka' || id === 'homing') {
      const m = id === 'homing' ? MAT.blue : MAT.olive;
      add(cyl(1.35, 1.35, 15, m), 3); add(cyl(1.9, 1.5, 2.6, MAT.olive2), 10.8); add(cyl(1.6, 1.9, 2, MAT.olive2), -4.8);
      add(box(1.4, 2.6, 1.2, MAT.dark), 2, -2.2); add(box(2.4, 1.2, 1, MAT.dark), 4, 1.9); add(box(0.6, 1.2, 0.6, MAT.dark), 4.8, 2.9);
      for (const x of [-1, 6]) add(cyl(1.42, 1.42, 0.7, MAT.dark), x);
      // the round's ogive peeks out of the muzzle
      const nose = new T.Mesh(lathe(ogive(1.2 * K, 2.4 * K, 0, 8), 14), id === 'homing' ? MAT.white : MAT.olive2); nose.position.x = 11.6 * K; g.add(nose);
    } else if (id === 'bat') {
      const bat = new T.Mesh(new T.CylinderGeometry(1.15 * K, 0.42 * K, 16 * K, 12), MAT.ash);
      bat.rotation.z = -PI / 2; add(bat, 7);
      add(cyl(0.55, 0.55, 3.2, MAT.dark), 0.4); add(new T.Mesh(new T.SphereGeometry(0.75 * K, 8, 6), MAT.dark), -1.3);
    } else if (id === 'sniper') {
      add(box(8, 2.3, 2, MAT.wood), -1, -0.5); add(cyl(0.65, 0.65, 24, MAT.dark), 10, 0.5);
      add(cyl(1.1, 1.1, 7, MAT.steel), 4, 3); add(box(2, 2.2, 1.5, MAT.dark), 4, 1.8); add(box(2.5, 3.2, 1.3, MAT.wood), 0, -2);
    } else if (id === 'shotgun') {
      add(cyl(0.65, 0.65, 15, MAT.dark), 5.5, 0.7); add(cyl(0.65, 0.65, 13, MAT.dark), 4.5, -0.5);
      add(box(4, 1.6, 1.5, MAT.wood), 6, -1.3); add(box(6, 2.4, 1.4, MAT.wood), -3, -0.6).rotation.z = -0.25;
    } else if (id === 'bellows') {
      add(cyl(2, 2.8, 8, MAT.blue), 3); add(cyl(3, 1.7, 4, MAT.steel), 9); add(box(2, 4, 2, MAT.dark), 1, -2);
    } else if (id === 'drill') {
      add(box(4, 7, 3, MAT.yellow), 3, 2); const bit = add(new T.Mesh(new T.CylinderGeometry(0.7 * K, 0.2 * K, 7 * K, 6), MAT.steel), 3, -4.5); bit.castShadow = true;
      add(box(7, 1.2, 1.2, MAT.dark), 3, 5.5);
    } else if (['airstrike', 'napalm', 'moai', 'tesla'].includes(id)) {
      add(box(4, 6, 2.4, MAT.dark), 4, 0); add(box(3, 1.6, 0.4, MAT.glass), 4, 1.4, 1.3);
      add(new T.Mesh(new T.CylinderGeometry(0.25 * K, 0.25 * K, 7 * K, 5), MAT.steel), 5.4, 6);
      add(new T.Mesh(new T.SphereGeometry(0.6 * K, 6, 5), id === 'tesla' ? MAT.glass : MAT.red), 5.4, 9.5);
    } else if (id === 'teleport') { add(box(3, 5, 2, MAT.steel), 4); add(new T.Mesh(new T.TorusGeometry(2.2 * K, 0.5 * K, 6, 16), MAT.glass), 4, 4); }
    else if (id === 'scrambler') { add(cyl(3, 3, 2, MAT.gold), 4); add(new T.Mesh(new T.SphereGeometry(1 * K, 8, 6), MAT.glass), 6, 4); }
    else if (id === 'girder') { add(box(12, 1.6, 2, MAT.girder), 5).rotation.z = 0.2; }
    else if (id === 'rope') {
      add(new T.Mesh(new T.TorusGeometry(2.2 * K, 0.7 * K, 6, 14), MAT.wood), 3);
      const h = hookMesh(); h.position.x = 6.5 * K; h.scale.setScalar(0.8); g.add(h);
    } else if (id === 'mine') { const b = add(new T.Mesh(new T.SphereGeometry(3 * K, 12, 8), MAT.dark), 5); b.scale.y = 0.6; add(new T.Mesh(new T.SphereGeometry(0.8 * K, 6, 5), MAT.red), 5, 1.8); }
    else if (id === 'magnet') { add(new T.Mesh(new T.TorusGeometry(3 * K, 1.1 * K, 8, 16, PI), MAT.red), 5, 0).rotation.z = PI / 2; for (const y of [-3, 3]) add(box(2, 2.2, 2.2, MAT.steel), 4.2, y); }
    else if (id === 'spring') { add(cyl(4, 4, 1.4, MAT.dark), 5); for (let i = 0; i < 3; i++) add(new T.Mesh(new T.TorusGeometry(2.6 * K, 0.45 * K, 6, 12), MAT.steel), 5 + 1.2 + i * 1.1).rotation.y = PI / 2; }
    else if (id === 'boulder') add(new T.Mesh(new T.DodecahedronGeometry(3.4 * K, 0), MAT.stone), 5.5);
    else if (id === 'sheep') { const b = add(new T.Mesh(new T.SphereGeometry(3 * K, 10, 8), MAT.wool), 5); b.scale.set(1.3, 1, 1); add(new T.Mesh(new T.SphereGeometry(1.5 * K, 8, 6), MAT.black), 8.6, 1); }
    else if (BUILD[id]) { const k = BUILD[id](); k.position.x = 5 * K; k.scale.setScalar(0.85); g.add(k); }
    // where the worm's hands hold it (held-local metres): a gun two-handed (the grip and the fore-end), a thrown or
    // dropped item in one hand under it
    const thrown = ['grenade', 'cluster', 'banana', 'holy', 'dynamite', 'sheep', 'blackhole', 'boulder', 'mine', 'magnet', 'spring', 'foam'].includes(id);
    if (thrown) g.children.forEach(c => { c.position.x -= 2 * K; });       // closer to the body
    g.userData.grips = thrown ? [[3 * K, -2.6 * K, 0]] : [[2 * K, -2.4 * K, 1.2 * K], [7 * K, -1.6 * K, -1.2 * K]];
    g.userData.id = id;
    return g;
  };

  /* the grappling hook: a shank, three curved tines and an eye (for the flying hook and the held rope) */
  // ASSET: hook (models/hook.glb)
  function hookMesh() {
    const g = new T.Group();
    const shank = mesh(new T.CylinderGeometry(0.012, 0.012, 0.13, 8), MAT.steel); shank.rotation.z = -PI / 2; g.add(shank);
    for (let k = 0; k < 3; k++) {
      const arm = new T.Group(); arm.rotation.x = k * 2.094; g.add(arm);
      const tine = mesh(new T.TorusGeometry(0.045, 0.009, 6, 10, PI * 0.75), MAT.steel, 0.035, 0.045, 0); tine.rotation.z = -PI * 0.5; arm.add(tine);
    }
    const eye = mesh(new T.TorusGeometry(0.018, 0.006, 6, 10), MAT.steel, -0.075, 0, 0); eye.rotation.y = PI / 2; g.add(eye);
    return g;
  }
  OR.hook = hookMesh;
  // a small five-point star (the dizzy stars over a stunned worm)
  OR.star = function () {
    const sh = new T.Shape();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.018 : 0.042, a = PI / 2 + i * PI / 5; i ? sh.lineTo(Math.cos(a) * r, Math.sin(a) * r) : sh.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
    const g = new T.ExtrudeGeometry(sh, { depth: 0.012, bevelEnabled: false }); g.translate(0, 0, -0.006);
    return new T.Mesh(g, MAT.star);
  };
})(window.SS = window.SS || {});
