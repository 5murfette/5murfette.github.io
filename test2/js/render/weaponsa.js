/* render/weaponsa.js — P37-W3 weapons A on screen (Three.js; everything procedural: geometry + shaders, no images).
 *   - models of the shells (acid flask, gas canister, mortar shell, bomblet), the held weapons of the 8 new weapons
 *     (flamethrower, acid, gas, mortar, minigun with its rotating barrels + ammo box + belt, handgun, boomerang,
 *     raven), the flying boomerang (spin + sideways bank) and the mail raven (flapping wings, letter satchel,
 *     orbiting above the target), fluttering letters;
 *   - the FLAME JET of the flamethrower: a camera-facing ribbon through the in-flight droplets (one continuous,
 *     turbulent tongue of fire, hot white-yellow core at the nozzle, orange to dark red at the tip; no separate dots);
 *   - acid: bubbling green puddles on the ground (shader), droplets in flight, fizz;
 *   - gas: a cloud of ~40 soft noisy billboards per cloud, drifting with the sim's cloud, thinning with its density;
 *   - minigun: muzzle flashes at the barrel tips (they roll with the barrels) + blast puffs, brass casings (a pool with
 *     their own bounce), tracers to the impact points, impact sparks / dust;
 *   - worm animation hooks: coughing (infected), acid tint.
 * API: init(scene, tx), clear(), onEvent(S, e), frame(S, view, camera, dt), held(S, w, model, dt, t) (actors.js asks
 * per frame for the worm's held model), worm(S, w, v, dt, t) (cough / tint), orient(m, p, S, dt) (arms/actors:
 * projectile orientation), stats(). Presentation only (Math.random is fine). Porting: one prefab per model + a particle
 * system. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, P = SS.plane, A = C.ARMS;
  const WV = SS.weaponsView = {};
  let scene = null, tx = null, grp = null;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const hash1 = (n) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const std = (c, o) => new T.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.5, metalness: 0.2 }, o || {}));
  const MT = {
    olive: std(0x55673a, { metalness: 0.35 }), dark: std(0x26282b, { metalness: 0.55, roughness: 0.4 }),
    steel: std(0xb8bcc2, { metalness: 0.85, roughness: 0.3 }),
    brass: std(0xd9a93a, { metalness: 0.9, roughness: 0.28 }), red: std(0xc23b2a), wood: std(0x8a5a32, { roughness: 0.9 }),
    woodD: std(0x4a2e18, { roughness: 0.9 }),
    glass: std(0xbfe8d0, { transparent: true, opacity: 0.45, roughness: 0.08, metalness: 0.1 }),
    lime: new T.MeshBasicMaterial({ color: 0x8cf02a }),
    yellow: std(0xe8d030, { roughness: 0.55 }), cream: std(0xf0e8d0, { roughness: 0.9 }),
    black: std(0x121214, { roughness: 0.35, metalness: 0.3 }),
    gas: std(0x9bc43a, { metalness: 0.4, roughness: 0.45 }), grey: std(0x4a4c50, { metalness: 0.5 }),
    beak: std(0x3a3a3e, { roughness: 0.4 }), tank: std(0xc84a24, { metalness: 0.5, roughness: 0.4 })
  };
  const KEEP = new Set(Object.values(MT));
  const G = {
    sph: (r, a, b) => new T.SphereGeometry(r, a || 12, b || 9),
    cyl: (r0, r1, h, n) => new T.CylinderGeometry(r0, r1, h, n || 12),
    box: (x, y, z) => new T.BoxGeometry(x, y, z)
  };
  const add = (g, geo, mat, x, y, z, rx, ry, rz) => {
    const m = new T.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.rotation.set(rx || 0, ry || 0, rz || 0);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  const glowSprite = (col, s, op) => {
    const sp = new T.Sprite(
      new T.SpriteMaterial({
        map: tx && tx.glow,
        color: col,
        blending: T.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: op == null ? 1 : op
      })
    );
    sp.scale.set(s, s, 1);
    return sp;
  };

  const GLSL_NOISE = /* glsl */`
    ${SS.glsl.FBM2S}
    vec3 bbody(float t) {
      vec3 c = mix(vec3(0.3, 0.02, 0.0), vec3(0.95, 0.18, 0.01), smoothstep(0.0, 0.3, t));
      c = mix(c, vec3(1.0, 0.5, 0.06), smoothstep(0.3, 0.7, t));
      return mix(c, vec3(1.0, 0.88, 0.55), smoothstep(0.82, 1.0, t));
    }`;

  // a muzzle blast cone (base at x = 0, tip at x = 1, additive, white-yellow core to orange edge, fading to the tip)
  let _flashMat = null, _flashGeo = null;
  const flashCone = () => {
    if (!_flashMat) {
      _flashMat = new T.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, transparent: true, blending: T.AdditiveBlending,
        depthWrite: false, side: T.DoubleSide,
        vertexShader: 'varying float vx; varying vec3 vP; void main(){ vx = position.x; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: `uniform float uTime;
          varying float vx;
          varying vec3 vP;
          void main() {
            float k = 1.0 - vx;
            float r = length(vP.yz) / max(0.05, 0.5 * k + 0.02);
            float core = smoothstep(1.0, 0.0, r);
            vec3 c = mix(vec3(1.0, 0.45, 0.08), vec3(1.0, 0.95, 0.7), core * k);
            float a = k * k * (0.35 + 0.65 * core) * (0.75 + 0.25 * sin(uTime * 90.0 + vx * 14.0));
            gl_FragColor = vec4(c * (1.2 + core), clamp(a, 0.0, 1.0));
          }` });
      _flashGeo = new T.ConeGeometry(0.5, 1, 10, 1, true); _flashGeo.rotateZ(-Math.PI / 2); _flashGeo.translate(0.5, 0, 0);
      _flashGeo.getAttribute('position');
    }
    const m = new T.Mesh(_flashGeo, _flashMat);
    m.frustumCulled = false;
    m.renderOrder = 12;
    m.visible = false;
    return m;
  };
  /* ---------- shell models (local +x = flight) ---------- */
  function mk(fn) {
    return () => {
      const g = new T.Group();
      fn(g);
      return g;
    };
  }
  const MODEL = {
    flamedrop: () => new T.Group(),                                     // (drawn by the jet ribbon)
    acid: mk(g => {
      add(g, G.sph(0.1), MT.glass);
      const l = add(g, G.sph(0.085), MT.lime);
      l.scale.set(1, 0.72, 1);
      l.position.y = -0.015;
      add(g, G.cyl(0.03, 0.045, 0.1), MT.glass, 0, 0.13); add(g, G.cyl(0.032, 0.032, 0.04), MT.woodD, 0, 0.2);
    }),
    gas: mk(g => {
      add(g, G.cyl(0.09, 0.09, 0.26, 14), MT.gas);
      add(g, G.cyl(0.092, 0.092, 0.05, 14), MT.black, 0, 0.04);
      add(g, G.cyl(0.092, 0.092, 0.05, 14), MT.yellow, 0, -0.04);
      add(g, G.sph(0.09, 12, 5), MT.gas, 0, 0.13).scale.y = 0.5;
      add(g, G.cyl(0.02, 0.02, 0.06), MT.steel, 0, 0.19);
      add(g, G.box(0.1, 0.015, 0.02), MT.steel, 0, 0.225);
    }),
    mortar: mk(g => {
      add(g, G.cyl(0.055, 0.055, 0.3, 12), MT.olive, 0, 0, 0, 0, 0, Math.PI / 2);
      add(g, new T.ConeGeometry(0.055, 0.14, 12), MT.red, 0.22, 0, 0, 0, 0, -Math.PI / 2);
      add(g, G.cyl(0.058, 0.058, 0.025, 12), MT.brass, 0.05, 0, 0, 0, 0, Math.PI / 2);
      for (let i = 0; i < 4; i++) add(g, G.box(0.1, 0.012, 0.09), MT.dark, -0.18, 0, 0, i * Math.PI / 2, 0, 0);
    }),
    bomblet: mk(g => {
      add(g, G.sph(0.05), MT.dark);
      add(g, G.cyl(0.055, 0.055, 0.012, 10), MT.red, 0, 0, 0, 0, 0, Math.PI / 2);
      add(g, G.cyl(0.02, 0.02, 0.05), MT.steel, 0.05, 0, 0, 0, 0, Math.PI / 2);
    })
  };
  for (const k of ['acid', 'gas']) {
    const f = MODEL[k];
    MODEL[k] = () => {
      const g = f();
      g.userData.wa = k;
      return g;
    };
  }
  for (const k of ['mortar', 'bomblet']) {
    const f = MODEL[k];
    MODEL[k] = () => {
      const g = f();
      g.userData.wa = k;
      return g;
    };
  }
  const AV = SS.armsView;
  if (AV) {
    const orig = AV.projMesh;
    AV.projMesh = function (type) {
      const f = MODEL[type];
      return f ? f() : orig(type);
    };
  }
  // projectile orientation (actors.js): the mortar shell / bomblet along the flight, the flask / canister tumbling
  WV.orient = function (m, p, S, dt) {
    const k = m.userData && m.userData.wa;
    if (!k) return false;
    if (k === 'mortar' || k === 'bomblet') m.rotation.set(0, -S.theta, Math.atan2(p.vy, p.vs), 'YXZ');
    else m.rotation.set(0, -S.theta, (m.rotation.z || 0) - (p.vs * 2 + 3) * dt, 'YXZ');
    return true;
  };

  /* ---------- held models (local +x = the aim, origin = the grip; metres) ---------- */
  const HELD = {};
  HELD.flamethrower = mk(g => {
    add(g, G.cyl(0.028, 0.028, 0.62, 12), MT.steel, 0.28, 0.02, 0, 0, 0, Math.PI / 2);
    add(g, G.cyl(0.04, 0.034, 0.1, 12), MT.dark, 0.6, 0.02, 0, 0, 0, Math.PI / 2);                    // the nozzle
    add(g, G.cyl(0.075, 0.075, 0.46, 16), MT.tank, 0.12, -0.13, 0, 0, 0, Math.PI / 2);                // the fuel tank
    for (const x of [-0.06, 0.3]) add(g, G.cyl(0.08, 0.08, 0.02, 16), MT.dark, x, -0.13, 0, 0, 0, Math.PI / 2);
    // trigger group, carry bar
    add(g, G.box(0.06, 0.1, 0.05), MT.dark, 0.0, -0.07, 0); add(g, G.box(0.22, 0.03, 0.03), MT.dark, 0.2, 0.06, 0.0);
    add(g, G.cyl(0.012, 0.012, 0.14), MT.black, 0.36, -0.01, 0.045, 0, 0, Math.PI / 2 - 0.2);          // the feed hose
    const pilot = glowSprite(0xffa040, 0.14, 0.9);
    pilot.position.set(0.68, 0.04, 0);
    g.add(pilot);
    const jet = glowSprite(0xff7a20, 0.5, 0.0);
    jet.position.set(0.7, 0.03, 0);
    g.add(jet);
    g.userData.pilot = pilot; g.userData.jet = jet; g.userData.grips = [[0.0, -0.12, 0.06], [0.32, -0.04, -0.06]];
  });
  HELD.minigun = mk(g => {
    const bar = new T.Group();
    bar.position.set(0.32, 0.02, 0);
    g.add(bar);
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3, y = Math.cos(a) * 0.052, z = Math.sin(a) * 0.052;
      const b = new T.Mesh(G.cyl(0.0165, 0.0165, 0.78, 8), MT.dark);
      b.rotation.z = Math.PI / 2;
      b.position.set(0.39, y, z);
      b.castShadow = true;
      bar.add(b);
      const tip = new T.Mesh(G.cyl(0.021, 0.021, 0.05, 8), MT.steel);
      tip.rotation.z = Math.PI / 2;
      tip.position.set(0.77, y, z);
      bar.add(tip);
      const fl = flashCone();
      fl.position.set(0.8, y, z);
      bar.add(fl);
      (bar.userData.fl = bar.userData.fl || []).push(fl);
    }
    for (const x of [0.1, 0.42, 0.7]) {
      const r = new T.Mesh(new T.TorusGeometry(0.07, 0.014, 6, 14), MT.steel);
      r.rotation.y = Math.PI / 2;
      r.position.x = x;
      bar.add(r);
    }
    add(bar, G.cyl(0.055, 0.055, 0.04, 12), MT.steel, 0.02, 0, 0, 0, 0, Math.PI / 2);
    add(g, G.cyl(0.115, 0.115, 0.46, 16), MT.grey, 0.12, 0.02, 0, 0, 0, Math.PI / 2);                   // the housing
    add(g, G.cyl(0.12, 0.12, 0.04, 16), MT.steel, 0.3, 0.02, 0, 0, 0, Math.PI / 2);
    add(g, G.box(0.16, 0.08, 0.1), MT.dark, -0.06, 0.1, 0);                                              // motor
    add(g, new T.TorusGeometry(0.1, 0.012, 6, 14, Math.PI), MT.steel, 0.1, 0.14, 0, 0, 0, 0);           // carry handle
    add(g, G.box(0.05, 0.14, 0.05), MT.dark, -0.04, -0.14, 0, 0, 0, 0.25);                               // pistol grip
    add(g, G.box(0.04, 0.1, 0.04), MT.dark, 0.34, -0.1, 0, 0, 0, -0.2);                                  // fore grip
    // the big ammo box (hangs behind and below), a belt of brass rounds feeding the housing
    add(g, G.box(0.46, 0.3, 0.34), MT.olive, -0.2, -0.3, 0); add(g, G.box(0.47, 0.04, 0.35), MT.dark, -0.2, -0.16, 0);
    add(g, G.box(0.2, 0.03, 0.2), MT.yellow, -0.2, -0.3, 0.172).scale.set(1, 1, 0.1);
    for (const x of [-0.36, -0.04]) add(g, G.box(0.03, 0.32, 0.36), MT.dark, x, -0.3, 0);
    for (let i = 0; i < 16; i++) {
      const u = i / 15,
        x = -0.12 + u * 0.24,
        y = -0.14 + Math.sin(u * Math.PI) * 0.07 + u * 0.1,
        l = add(g, G.box(0.05, 0.03, 0.07), i % 2 ? MT.brass : MT.steel, x, y, 0.0, 0, 0, 0.5 + u * 0.4);
      l.scale.set(1, 1, 1);
    }
    g.userData.bar = bar; g.userData.grips = [[0.0, -0.1, 0.07], [0.34, -0.08, -0.07]];
    const core = flashCone();
    core.position.set(0.86, 0.02, 0);
    g.add(core);
    g.userData.core = core;
  });
  HELD.mortar = mk(g => {
    add(g, G.cyl(0.062, 0.07, 0.62, 14), MT.dark, 0.3, 0, 0, 0, 0, Math.PI / 2);
    add(g, G.cyl(0.078, 0.078, 0.05, 14), MT.steel, 0.58, 0, 0, 0, 0, Math.PI / 2);
    add(g, G.box(0.14, 0.14, 0.14), MT.steel, -0.04, 0, 0);
    add(g, G.box(0.04, 0.06, 0.03), MT.dark, 0.3, 0.09, 0.02); add(g, G.cyl(0.008, 0.008, 0.08), MT.steel, 0.3, 0.14, 0.02);
    for (const z of [-1, 1]) add(g, G.cyl(0.01, 0.01, 0.34), MT.steel, 0.25, -0.15, z * 0.07, z * 0.35, 0, -0.5);   // bipod
    g.userData.grips = [[0.05, -0.1, 0.07], [0.3, -0.08, -0.07]];
  });
  HELD.handgun = mk(g => {
    add(g, G.box(0.24, 0.05, 0.034), MT.dark, 0.1, 0.03, 0);
    add(g, G.cyl(0.013, 0.013, 0.07, 8), MT.steel, 0.25, 0.03, 0, 0, 0, Math.PI / 2);
    add(g, G.box(0.05, 0.12, 0.034), MT.wood, 0.0, -0.05, 0, 0, 0, 0.22); add(g, G.box(0.06, 0.02, 0.04), MT.dark, 0.04, -0.01, 0);
    add(g, G.box(0.02, 0.02, 0.02), MT.red, 0.2, 0.065, 0);
    g.userData.grips = [[0.0, -0.05, 0.0]];
  });
  HELD.acid = mk(g => {
    const m = MODEL.acid();
    m.scale.setScalar(1.1);
    m.position.set(0.05, 0.02, 0);
    g.add(m);
    g.userData.grips = [[0.03, -0.09, 0]];
    g.userData.thrown = 1;
  });
  HELD.gas = mk(g => {
    const m = MODEL.gas();
    m.position.set(0.05, 0.02, 0);
    g.add(m);
    g.userData.grips = [[0.03, -0.1, 0]];
    g.userData.thrown = 1;
  });
  function boomMesh() {                      // a V of two wooden arms (elbow at the origin, opening toward +x), red bands
    const g = new T.Group();
    for (const s of [-1, 1]) {
      const arm = new T.Group();
      arm.rotation.y = s * 0.62;
      g.add(arm);
      add(arm, G.box(0.3, 0.028, 0.065), MT.wood, 0.15, 0, 0);
      add(arm, G.box(0.05, 0.03, 0.067), MT.red, 0.24, 0, 0);
      add(arm, G.box(0.03, 0.03, 0.067), MT.woodD, 0.08, 0, 0);
    }
    return g;
  }
  HELD.boomerang = mk(g => {
    const m = boomMesh();
    m.scale.setScalar(1.25);
    m.position.set(0.12, 0, 0);
    m.rotation.set(Math.PI / 2, 0, 0.3);
    g.add(m);
    g.userData.grips = [[0.03, -0.07, 0]];
    g.userData.thrown = 1;
  });
  HELD.raven = mk(g => {
    const m = ravenMesh();
    m.scale.setScalar(0.8);
    m.position.set(0.12, 0.08, 0);
    g.add(m);
    g.userData.raven = m;
    g.userData.grips = [[0.05, -0.04, 0]];
    g.userData.thrown = 1;
  });
  const OR = SS.ordnance;
  if (OR && OR.held) {
    const origHeld = OR.held;
    OR.held = function (id) {
      const b = HELD[id];
      if (!b) return origHeld(id);
      const g = b();
      g.userData.id = id;
      if (g.userData.thrown) g.children.forEach(c => { c.position.x -= 0.09; });
      return g;
    };
  }
  // per frame for the worm's held model (actors.js): the minigun's barrels roll, the nozzle / muzzle glow
  WV.held = function (S, w, g, dt, t) {
    const u = g.userData, id = u.id, st = S.wa && S.wa.stream && S.wa.stream.owner === w.id ? S.wa.stream : null;
    if (id === 'minigun') {
      const k = st ? M_smooth(Math.min(1, st.t / A.MINIGUN.SPIN)) * M_smooth(Math.min(1, (A.MINIGUN.DUR - st.t) / A.MINIGUN.SPIN)) : 0;
      u.spin = (u.spin || 0) + dt * (4 + 62 * k);                                         // spins up with the stream, idles slowly
      u.bar.rotation.x = u.spin;
      for (let i = 0; i < 6; i++) {
        const f = u.bar.userData.fl[i], ph = (u.spin * 6 / (Math.PI * 2) + i / 6) % 1;       // each barrel flashes once per roll position
        const on = k > 0.15 && ph < 0.55;
        f.visible = on;
        if (on) {
          const L = (0.45 + 0.9 * Math.random()) * k;
          f.scale.set(L, 0.16 + 0.1 * Math.random(), 0.16 + 0.1 * Math.random());
        }
      }
      u.core.visible = k > 0.2;
      if (u.core.visible) {
        const L = (0.8 + 1.4 * Math.random()) * k;
        u.core.scale.set(L, 0.34 + 0.2 * Math.random(), 0.34 + 0.2 * Math.random());
      }
      _flashMat.uniforms.uTime.value = t;
    } else if (id === 'flamethrower') {
      u.pilot.material.opacity = 0.7 + 0.3 * Math.sin(t * 31);
      u.pilot.scale.setScalar(0.1 + 0.025 * Math.sin(t * 23));
      u.jet.material.opacity = st ? 0.55 + 0.4 * Math.random() : 0; u.jet.scale.setScalar(st ? 0.55 + 0.4 * Math.random() : 0.5);
    } else if (id === 'raven' && u.raven) { u.raven.userData.flap && u.raven.userData.flap(t * 5); }
  };
  const M_smooth = x => x * x * (3 - 2 * x);

  /* ---------- the boomerang and the raven ---------- */
  function ravenMesh() {
    const g = new T.Group(), body = new T.Group();
    g.add(body);
    const bd = add(body, G.sph(0.11, 14, 10), MT.black);
    bd.scale.set(1.7, 0.85, 0.85);
    add(body, G.sph(0.07, 12, 9), MT.black, 0.2, 0.04, 0);                                           // head
    add(body, new T.ConeGeometry(0.03, 0.12, 8), MT.beak, 0.3, 0.035, 0, 0, 0, -Math.PI / 2);        // beak
    for (const z of [-0.035, 0.035]) add(body, G.sph(0.014, 6, 5), MT.cream, 0.25, 0.07, z);          // eyes
    const tail = add(body, G.box(0.2, 0.012, 0.1), MT.black, -0.26, 0, 0);
    tail.rotation.z = 0.1;
    const wings = [];
    for (const s of [-1, 1]) {
      const pv = new T.Group();
      pv.position.set(0.0, 0.05, 0.07 * s);
      body.add(pv);
      const w1 = new T.Mesh(G.box(0.2, 0.008, 0.34), MT.black);
      w1.position.z = 0.17 * s;
      w1.castShadow = true;
      pv.add(w1);
      const w2 = new T.Mesh(G.box(0.14, 0.008, 0.22), MT.black);
      w2.position.set(-0.02, 0, 0.38 * s);
      pv.add(w2);
      w1.userData.tip = w2;
      wings.push({ pv, s });
    }
    // the satchel of letters under it
    const sat = new T.Group();
    sat.position.set(0.02, -0.14, 0);
    g.add(sat);
    add(sat, G.box(0.16, 0.1, 0.1), MT.woodD);
    const env = [];
    for (let i = 0; i < 5; i++) {
      const e = add(sat, G.box(0.1, 0.012, 0.075), MT.cream, -0.03 + i * 0.015, 0.06 + i * 0.011, 0, 0, 0, (i - 2) * 0.12);
      env.push(e);
    }
    add(g, G.cyl(0.004, 0.004, 0.1), MT.steel, 0.02, -0.07, 0.04); add(g, G.cyl(0.004, 0.004, 0.1), MT.steel, 0.02, -0.07, -0.04);
    g.userData.wings = wings; g.userData.env = env; g.userData.body = body;
    g.userData.flap = ph => {
      for (const w of wings) {
        const a = Math.sin(ph) * 0.75;
        w.pv.rotation.x = w.s * a;
        w.pv.children[1].rotation.x = w.s * a * 0.5;
      }
    };
    return g;
  }
  function letterMesh() {
    const g = new T.Group();
    add(g, G.box(0.17, 0.012, 0.11), MT.cream);
    add(g, G.box(0.04, 0.014, 0.03), MT.red, 0.04, 0, 0);
    add(g, G.box(0.1, 0.014, 0.004), MT.woodD, -0.02, 0, 0.02);
    return g;
  }

  /* ---------- live objects ---------- */
  const live = { boom: new Map(), raven: new Map(), letter: new Map() };
  function sync(map, list, make, upd) {
    const seen = new Set();
    for (const o of list) {
      let m = map.get(o);
      if (!m) {
        m = make(o);
        grp.add(m);
        map.set(o, m);
      }
      seen.add(o);
      upd(o, m);
    }
    for (const [o, m] of map)
      if (!seen.has(o)) {
        grp.remove(m);
        map.delete(o);
        SS.mat.disposeTree(m, KEEP);
      }
  }

  /* ---------- the flame jet (a ribbon through the in-flight gel droplets) ---------- */
  const JETN = 240;
  let jet = null, jetLight = null;
  const JET_FS = `
    uniform float uTime;
    varying vec2 vUv;
    ${GLSL_NOISE}
    void main() {
      float x = vUv.x, age = vUv.y;                                      // x across -1..1, age along 0 (nozzle) .. 1 (tip)
      float edge = 1.0 - pow(abs(x), 1.6);
      vec2 q = vec2(x * 1.4, age * 3.5 - uTime * 7.0);
      float n = sl_fbm2s(q + vec2(0.0, sl_fbm2s(q * 0.8 + 3.0)));
      float T = edge * (1.0 - age * 0.82) + (n - 0.5) * 0.55 * (0.3 + age);
      T = clamp(T * 1.15, 0.0, 1.0);
      if (T < 0.06) discard;
      float a = smoothstep(0.06, 0.5, T) * (1.0 - smoothstep(0.75, 1.0, age));
      gl_FragColor = vec4(bbody(T) * (0.55 + 1.5 * T), a);
    }`;
  function makeJet() {
    const g = new T.BufferGeometry(),
      pos = new Float32Array(JETN * 2 * 3),
      uv = new Float32Array(JETN * 2 * 2),
      idx = new Uint16Array((JETN - 1) * 6);
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2).setUsage(T.DynamicDrawUsage));
    g.setIndex(new T.BufferAttribute(idx, 1).setUsage(T.DynamicDrawUsage));
    const mat = new T.ShaderMaterial({ uniforms: { uTime: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: JET_FS, transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide });
    jet = new T.Mesh(g, mat);
    jet.frustumCulled = false;
    jet.renderOrder = 10;
    jet.visible = false;
    scene.add(jet);
    jetLight = new T.PointLight(0xff8a30, 0, 14, 1.6); scene.add(jetLight);
  }
  const jl = [], tv = new T.Vector3(), vv = new T.Vector3(), sv = new T.Vector3();
  function updateJet(S, camera, t) {
    jl.length = 0;
    for (const p of S.proj)
      if (p.type === 'flamedrop') jl.push(p);
    if (jl.length < 2) {
      jet.visible = false;
      jetLight.intensity = 0;
      return;
    }
    jl.sort((a, b) => a.age - b.age);
    const n = Math.min(JETN, jl.length),
      pa = jet.geometry.attributes.position.array,
      ua = jet.geometry.attributes.uv.array,
      ia = jet.geometry.index.array,
      cp = camera.position;
    const raw = [], pts = [];
    for (let i = 0; i < n; i++) {
      const p = jl[i], w = P.to_world(S, p.s, p.y);
      raw.push(w);
    }
    // the centre line: a moving average over the droplets (they leave with random spread: the raw chain zig-zags)
    for (let i = 0; i < n; i++) {
      const k = Math.min(5, i, n - 1 - i) + (i < 3 ? 0 : 0);
      let x = 0, y = 0, z = 0;
      for (let q = i - k; q <= i + k; q++) {
        x += raw[q].x;
        y += raw[q].y;
        z += raw[q].z;
      }
      const c = 2 * k + 1;
      pts.push({ x: x / c, y: y / c, z: z / c });
    }
    let nIdx = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], c = pts[i];
      tv.set(b.x - a.x, b.y - a.y, b.z - a.z);
      if (tv.lengthSq() < 1e-6) tv.set(1, 0, 0);
      vv.set(cp.x - c.x, cp.y - c.y, cp.z - c.z); sv.crossVectors(tv, vv).normalize();
      const age = jl[i].age, ag0 = Math.min(1, age / 0.72), half = 0.13 + 0.5 * Math.min(1, age / 0.6);
      // licking: the centre line wavers sideways and the cooler tail rises (buoyancy)
      const wob = Math.sin(age * 15 - t * 19 + i * 0.4) * 0.09 * ag0, rise = ag0 * ag0 * 0.5;
      c.x += sv.x * wob; c.y += sv.y * wob + rise; c.z += sv.z * wob;
      pa[i * 6] = c.x + sv.x * half; pa[i * 6 + 1] = c.y + sv.y * half; pa[i * 6 + 2] = c.z + sv.z * half;
      pa[i * 6 + 3] = c.x - sv.x * half; pa[i * 6 + 4] = c.y - sv.y * half; pa[i * 6 + 5] = c.z - sv.z * half;
      const ag = Math.min(1, age / 0.72);
      ua[i * 4] = -1;
      ua[i * 4 + 1] = ag;
      ua[i * 4 + 2] = 1;
      ua[i * 4 + 3] = ag;
      if (i + 1 < n) {
        const d = pts[i + 1];
        if ((d.x - c.x) ** 2 + (d.y - c.y) ** 2 + (d.z - c.z) ** 2 < 1.4) {
          const q = i * 2;
          ia[nIdx++] = q;
          ia[nIdx++] = q + 1;
          ia[nIdx++] = q + 2;
          ia[nIdx++] = q + 1;
          ia[nIdx++] = q + 3;
          ia[nIdx++] = q + 2;
        }
      }
      if (i === Math.min(n - 1, 12)) {
        cx = c.x;
        cy = c.y;
        cz = c.z;
      }
    }
    jet.geometry.setDrawRange(0, nIdx);
    jet.geometry.attributes.position.needsUpdate = true;
    jet.geometry.attributes.uv.needsUpdate = true;
    jet.geometry.index.needsUpdate = true;
    jet.material.uniforms.uTime.value = t; jet.visible = nIdx > 0 && !SS.flameView;
    // P45: the stream = procedural tongues along the droplets (render/flame.js)
    if (SS.flameView && nIdx > 0) {
      for (let i = 0; i < n; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], age = jl[i].age, ag0 = Math.min(1, age / 0.72);
        if (Math.random() > 0.55) continue;
        SS.flameView.tongue(
          pts[i].x,
          pts[i].y,
          pts[i].z,
          b.x - a.x,
          b.y - a.y + 0.05,
          b.z - a.z,
          0.3 + 0.55 * ag0,
          0.7 + 0.5 * ag0,
          rnd(0.2, 0.36),
          1.55 - 0.7 * ag0
        );
      }
    }
    jetLight.position.set(cx, cy + 0.3, cz); jetLight.intensity = 18 * (0.8 + 0.2 * Math.sin(t * 40));
    // embers and smoke off the jet
    if (Math.random() < 0.5) {
      const p = pts[Math.floor(Math.random() * n)];
      SS.fx.spawn(SS.fx.KIND.SPARK, p.x, p.y, p.z, {
        vx: rnd(-1, 1),
        vy: rnd(0.5, 2.5),
        vz: rnd(-1, 1),
        life: rnd(0.3, 0.7),
        s0: 0.08,
        s1: 0.03,
        c0: [2200, 1000, 0],
        grav: 2
      });
    }
    if (Math.random() < 0.25) {
      const p = pts[n - 1];
      SS.fx.spawn(SS.fx.KIND.SMOKE, p.x, p.y, p.z, {
        vx: rnd(-0.3, 0.3),
        vy: rnd(0.6, 1.4),
        vz: rnd(-0.3, 0.3),
        life: rnd(0.8, 1.4),
        s0: 0.2,
        s1: 0.8,
        a0: 0.3,
        c0: [0.25, 0.23, 0.22],
        c1: [0.4, 0.4, 0.4],
        drag: 1
      });
    }
  }

  /* ---------- acid puddles, droplets ---------- */
  const DROPN = 160;
  let dropsIM = null;
  const m4 = new T.Matrix4(),
    q4 = new T.Quaternion(),
    p3 = new T.Vector3(),
    s3 = new T.Vector3(1, 1, 1);
  function makeAcid() {
    // (P44: the puddles are render/acid.js now: a mesh that follows the ground)
    dropsIM = new T.InstancedMesh(new T.SphereGeometry(0.07, 8, 6), new T.MeshBasicMaterial({ color: 0x9cf02a }), DROPN);
    dropsIM.frustumCulled = false;
    dropsIM.count = 0;
    scene.add(dropsIM);
  }
  function updateAcid(S, t) {
    const wa = S.wa;
    if (!wa) {
      dropsIM.count = 0;
      return;
    }
    let n = 0;
    for (const s of wa.spots) {
      const fade = Math.min(1, s.t / 0.25, (s.life - s.t) / 1.0),
        r = s.r * (0.6 + 0.4 * Math.min(1, s.t / 0.6)) * (0.35 + 0.65 * Math.max(0, fade));
      if (!SS.view.shownAt(S, s, 0.8)) continue;
      if (Math.random() < 0.06)
        SS.fx.spawn(SS.fx.KIND.SMOKE, s.x + rnd(-r, r) * 0.6, s.y + 0.1, s.z + rnd(-r, r) * 0.6, {
          vy: rnd(0.4, 0.9),
          life: rnd(0.8, 1.5),
          s0: 0.12,
          s1: 0.5,
          a0: 0.28,
          c0: [0.45, 0.7, 0.18],
          c1: [0.62, 0.78, 0.35],
          drag: 0.8
        });
      if (Math.random() < 0.05)
        SS.fx.spawn(SS.fx.KIND.STEAM, s.x + rnd(-r, r) * 0.5, s.y + 0.06, s.z + rnd(-r, r) * 0.5, {
          vy: rnd(0.8, 1.6),
          vx: rnd(-0.2, 0.2),
          life: rnd(0.4, 0.8),
          s0: 0.05,
          s1: 0.09,
          a0: 0.8,
          c0: [0.7, 1, 0.3],
          grav: 4
        });
    }
    n = 0; s3.set(1, 1, 1); q4.identity();
    for (const d of wa.acid) {
      if (n >= DROPN) break;
      const w = P.to_world(S, d.s, d.y);
      p3.set(w.x, w.y, w.z);
      m4.compose(p3, q4, s3);
      dropsIM.setMatrixAt(n++, m4);
    }
    dropsIM.count = n; dropsIM.instanceMatrix.needsUpdate = true;
  }

  /* ---------- gas clouds ---------- */
  const GASN = 360, PUFF = 56;
  let gasIM = null, gasPos = null, gasA = null;
  function makeGas() {
    const base = new T.PlaneGeometry(1, 1), g = new T.InstancedBufferGeometry();
    g.index = base.index;
    g.attributes.position = base.attributes.position;
    g.attributes.uv = base.attributes.uv;
    gasPos = new T.InstancedBufferAttribute(new Float32Array(GASN * 4), 4).setUsage(T.DynamicDrawUsage);
    gasA = new T.InstancedBufferAttribute(new Float32Array(GASN * 4), 4).setUsage(T.DynamicDrawUsage);
    g.setAttribute('iPos', gasPos); g.setAttribute('iA', gasA); g.instanceCount = 0;
    const mat = new T.ShaderMaterial({ uniforms: { uTime: { value: 0 } }, transparent: true, depthWrite: false,
      vertexShader: `attribute vec4 iPos;
        attribute vec4 iA;
        varying vec2 vUv;
        varying vec4 vA;
        void main() {
          vUv = uv - 0.5;
          vA = iA;
          vec3 R = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]), U = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          float c = cos(iA.x), s = sin(iA.x);
          vec2 q = mat2(c, s, -s, c) * position.xy;
          gl_Position = projectionMatrix * viewMatrix * vec4(iPos.xyz + (R * q.x + U * q.y) * iPos.w, 1.0);
        }`,
      fragmentShader: `uniform float uTime;
        varying vec2 vUv;
        varying vec4 vA;
        ${GLSL_NOISE}
        void main() {
          float r = length(vUv) * 2.0;
          if (r > 1.0) discard;
          float n = sl_fbm2s(vUv * 3.0 + vA.y * 17.0 + vec2(uTime * 0.12, 0.0));
          float a = (1.0 - smoothstep(0.35, 1.0, r + (n - 0.5) * 0.5)) * vA.z;
          vec3 c = mix(vec3(0.42, 0.55, 0.14), vec3(0.78, 0.9, 0.38), n);
          gl_FragColor = vec4(c, a);
        }` });
    gasIM = new T.Mesh(g, mat);
    gasIM.frustumCulled = false;
    gasIM.renderOrder = 8;
    scene.add(gasIM);
  }
  function updateGas(S, t) {
    const wa = S.wa, g = gasIM.geometry;
    let n = 0;
    if (wa)
      for (const c of wa.clouds) {
        const dens = SS.weaponsA.cloud_density(c), grow = Math.min(1, c.t / 0.5);
        if (!SS.view.shownAt(S, c, c.r)) continue;
        const pf = c.pf;
        for (let i = 0; i < PUFF && n < GASN; i++, n++) {                  // the sim's puffs (they respect the terrain)
          const h1 = hash1(c.id * 31 + i), h2 = hash1(c.id * 17 + i * 3 + 1), h3 = hash1(c.id * 7 + i * 5 + 2), h4 = hash1(i * 13 + c.id);
          gasPos.array[n * 4] = pf[i * 6] + Math.sin(t * 0.5 + i) * 0.12;
          gasPos.array[n * 4 + 1] = pf[i * 6 + 1] + 0.1 + Math.sin(t * 0.4 + i * 1.7) * 0.1;
          gasPos.array[n * 4 + 2] = pf[i * 6 + 2] + Math.cos(t * 0.5 + i) * 0.12;
          gasPos.array[n * 4 + 3] = (1.2 + 1.3 * h4) * (0.5 + 0.5 * Math.min(1, c.t / 2.5));
          gasA.array[n * 4] = h1 * 6.283 + t * 0.05;
          gasA.array[n * 4 + 1] = h2;
          gasA.array[n * 4 + 2] = 0.3 * dens * grow * (0.6 + 0.4 * h3);
          gasA.array[n * 4 + 3] = 0;
        }
      }
    g.instanceCount = n;
    gasPos.needsUpdate = true;
    gasA.needsUpdate = true;
    gasIM.material.uniforms.uTime.value = t;
  }

  /* ---------- minigun: casings, tracers, flashes ---------- */
  const CASN = 200;
  let casIM = null;
  const cas = [], mg = { t: -9, pos: null, dir: null, n: 0, worm: null };
  const TRN = 64;
  let tracers = null, trT = [];
  function makeMinigun() {
    const geo = new T.CylinderGeometry(0.011, 0.011, 0.055, 6);
    geo.rotateZ(Math.PI / 2);
    casIM = new T.InstancedMesh(geo, new T.MeshStandardMaterial({ color: 0xd9a93a, metalness: 0.9, roughness: 0.3 }), CASN);
    casIM.frustumCulled = false;
    casIM.count = 0;
    casIM.castShadow = true;
    scene.add(casIM);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(TRN * 6), 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(TRN * 6), 3).setUsage(T.DynamicDrawUsage));
    tracers = new T.LineSegments(
      g,
      new T.LineBasicMaterial({ vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false })
    );
    tracers.frustumCulled = false;
    tracers.renderOrder = 11;
    scene.add(tracers);
  }
  const eul = new T.Euler();
  function updateMinigun(S, dt, t) {
    // spawn casings: ejected out to the side (the camera side of the plane) and up, from the housing
    if (mg.pos && t - mg.t < 0.12 && mg.n > 0) {
      const n = Math.min(8, Math.ceil(mg.n));
      mg.n = 0;
      const d = P.dir(S), nn = P.nrm(S), side = (mg.worm && mg.worm.facing >= 0 ? 1 : -1);
      for (let i = 0; i < n; i++) {
        if (cas.length >= CASN) cas.shift();
        const sp = rnd(2.5, 5.5), up = rnd(1.5, 4.2), bk = rnd(-1.5, 1.5);
        cas.push({
          x: mg.pos.x - mg.dir.x * 0.5 + rnd(-0.05, 0.05),
          y: mg.pos.y - mg.dir.y * 0.5 + 0.08,
          z: mg.pos.z - mg.dir.z * 0.5,
          vx: nn.x * sp * 0.9 + d.x * bk * side - mg.dir.x * 1.2,
          vy: up,
          vz: nn.z * sp * 0.9 + d.z * bk * side - mg.dir.z * 1.2,
          rx: rnd(0, 6),
          ry: rnd(0, 6),
          rz: rnd(0, 6),
          sx: rnd(-20, 20),
          sy: rnd(-20, 20),
          t: 0,
          rest: false
        });
      }
      // blast from the muzzle: fire puffs + smoke along the barrels' line
      const m = mg.pos;
      for (let i = 0; i < 2; i++) {
        const f = rnd(0, 0.5);
        SS.fx.spawn(SS.fx.KIND.FIRE, m.x + mg.dir.x * f, m.y + mg.dir.y * f, m.z + mg.dir.z * f, {
          vx: mg.dir.x * rnd(8, 18) + rnd(-0.5, 0.5),
          vy: mg.dir.y * rnd(8, 18) + rnd(-0.3, 0.5),
          vz: mg.dir.z * rnd(8, 18) + rnd(-0.5, 0.5),
          life: rnd(0.08, 0.16),
          s0: rnd(0.12, 0.24),
          s1: 0.06,
          c0: [1900, 1000, 0],
          drag: 3
        });
      }
      if (Math.random() < 0.7)
        SS.fx.spawn(SS.fx.KIND.SMOKE, m.x + mg.dir.x * 0.3, m.y + mg.dir.y * 0.3, m.z + mg.dir.z * 0.3, {
          vx: mg.dir.x * 3 + rnd(-0.6, 0.6),
          vy: rnd(0.2, 1),
          vz: mg.dir.z * 3 + rnd(-0.6, 0.6),
          life: rnd(0.8, 1.6),
          s0: 0.2,
          s1: 0.9,
          a0: 0.3,
          c0: [0.5, 0.49, 0.47],
          c1: [0.7, 0.7, 0.7],
          drag: 1.5
        });
      if (Math.random() < 0.5) SS.fx.spark(m.x + mg.dir.x * 0.5, m.y + mg.dir.y * 0.5, m.z + mg.dir.z * 0.5);
    }
    let c = 0;
    const W = SS.world;
    for (let i = cas.length - 1; i >= 0; i--) {
      const k = cas[i];
      k.t += dt;
      if (k.t > 6) {
        cas.splice(i, 1);
        continue;
      }
      if (!k.rest) {
        k.vy -= 9.81 * dt;
        const nx = k.x + k.vx * dt, ny = k.y + k.vy * dt, nz = k.z + k.vz * dt;
        if (W.sample(nx, ny - 0.02, nz) > 0) {
          k.vy = Math.abs(k.vy) * 0.35;
          k.vx *= 0.55;
          k.vz *= 0.55;
          k.sx *= 0.5;
          k.sy *= 0.5;
          if (k.vy < 0.5) k.rest = true;
          if (Math.random() < 0.3 && SS.audio && SS.audio.clinkA) SS.audio.clinkA();
        }
        else {
          k.x = nx;
          k.y = ny;
          k.z = nz;
          k.rx += k.sx * dt;
          k.ry += k.sy * dt;
        }
        if (k.y < SS.sim.surface_at(S, k.x, k.z) - 0.1) {
          cas.splice(i, 1);
          continue;
        }
      }
    }
    for (const k of cas) {
      if (c >= CASN) break;
      eul.set(k.rx, k.ry, k.rz);
      q4.setFromEuler(eul);
      p3.set(k.x, k.y, k.z);
      s3.setScalar(k.t > 5 ? Math.max(0.01, 6 - k.t) : 1);
      m4.compose(p3, q4, s3);
      casIM.setMatrixAt(c++, m4);
    }
    casIM.count = c; casIM.instanceMatrix.needsUpdate = true;
    // tracers fade
    const pos = tracers.geometry.attributes.position.array, col = tracers.geometry.attributes.color.array;
    let m = 0;
    for (let i = 0; i < trT.length && m < TRN; i++) {
      const k = trT[i], f = 1 - (t - k.t) / 0.07;
      if (f <= 0) continue;
      pos.set(k.p, m * 6);
      col[m * 6] = 1.4 * f;
      col[m * 6 + 1] = 1.0 * f;
      col[m * 6 + 2] = 0.4 * f;
      col[m * 6 + 3] = 0.3 * f;
      col[m * 6 + 4] = 0.2 * f;
      col[m * 6 + 5] = 0.05 * f;
      m++;
    }
    trT = trT.filter(k => t - k.t < 0.07);
    tracers.geometry.setDrawRange(0, m * 2);
    tracers.geometry.attributes.position.needsUpdate = true;
    tracers.geometry.attributes.color.needsUpdate = true;
  }

  /* ---------- events ---------- */
  let nowT = 0;
  WV.onEvent = function (S, e) {
    if (!scene) return;
    const FX = SS.fx, K = FX.KIND;
    switch (e.type) {
      case 'mgfire':
        mg.t = nowT;
        mg.pos = { x: e.x, y: e.y, z: e.z };
        mg.dir = { x: e.dx, y: e.dy, z: e.dz };
        mg.n += e.n;
        mg.worm = e.worm;
        break;
      case 'mgimpact': {
        if (mg.pos && trT.length < TRN && Math.random() < 0.6)
          trT.push({ t: nowT, p: [mg.pos.x + mg.dir.x * 0.8, mg.pos.y + mg.dir.y * 0.8, mg.pos.z + mg.dir.z * 0.8, e.x, e.y, e.z] });
        if (Math.random() < 0.6) FX.impact(e.x, e.y, e.z, e.nx, e.ny, e.nz, e.mat || null, 0.7);
        break;
      }
      case 'mortarburst':
        FX.spawn(K.SMOKE, e.x, e.y, e.z, { life: 1.6, s0: 0.6, s1: 2.6, a0: 0.35, c0: [0.3, 0.28, 0.27], c1: [0.55, 0.55, 0.55], drag: 1 });
        for (let i = 0; i < 8; i++)
          FX.spawn(K.SPARK, e.x, e.y, e.z, {
            vx: rnd(-4, 4),
            vy: rnd(-1, 4),
            vz: rnd(-4, 4),
            life: rnd(0.3, 0.6),
            s0: 0.1,
            s1: 0.04,
            c0: [2400, 1200, 0],
            grav: 6
          });
        break;
      case 'acidburst': case 'acideat':
        for (let i = 0; i < (e.type === 'acidburst' ? 26 : 5); i++) {
          const a = rnd(0, 6.283), sp = rnd(0.5, e.type === 'acidburst' ? 6 : 1.5);
          FX.spawn(K.STEAM, e.x, e.y + 0.1, e.z, {
            vx: Math.cos(a) * sp,
            vy: rnd(1, e.type === 'acidburst' ? 6 : 2.5),
            vz: Math.sin(a) * sp,
            life: rnd(0.5, 1.0),
            s0: 0.08,
            s1: 0.14,
            a0: 0.9,
            c0: [0.62, 0.95, 0.2],
            grav: 9.8,
            drag: 0.3
          });
        }
        if (e.type === 'acideat') {
          FX.dust(e.x, e.y, e.z, 2, 0.35, 0x7a5636);
          FX.spawn(K.SMOKE, e.x, e.y + 0.2, e.z, {
            vy: rnd(0.5, 1.2),
            life: rnd(1.2, 2.0),
            s0: 0.2,
            s1: 0.9,
            a0: 0.3,
            c0: [0.5, 0.75, 0.2],
            c1: [0.7, 0.8, 0.45],
            drag: 0.7
          });
        }
        break;
      case 'gasburst':
        for (let i = 0; i < 16; i++) {
          const a = rnd(0, 6.283), sp = rnd(0.5, 2.5);
          FX.spawn(K.SMOKE, e.x, e.y + 0.3, e.z, {
            vx: Math.cos(a) * sp,
            vy: rnd(0.2, 1.2),
            vz: Math.sin(a) * sp,
            life: rnd(1.2, 2.2),
            s0: 0.4,
            s1: 1.8,
            a0: 0.4,
            c0: [0.5, 0.65, 0.18],
            c1: [0.75, 0.88, 0.4],
            drag: 1.2
          });
        }
        break;
      case 'cough':
        if (e.worm)
          for (let i = 0; i < 4; i++)
            FX.spawn(K.SMOKE, e.x + rnd(-0.1, 0.1), e.y + 0.45, e.z + rnd(-0.1, 0.1), {
              vx: rnd(-0.5, 0.5),
              vy: rnd(0.2, 0.8),
              vz: rnd(-0.5, 0.5),
              life: rnd(0.6, 1.1),
              s0: 0.1,
              s1: 0.45,
              a0: 0.4,
              c0: [0.5, 0.62, 0.2],
              c1: [0.7, 0.8, 0.4],
              drag: 1.4
            });
        break;
      case 'ravencrash': case 'ravenbump':
        FX.dust(e.x, e.y, e.z, 8, 0.6, 0x8a7a6a);
        for (let i = 0; i < 14; i++)
          FX.spawn(K.SMOKE, e.x, e.y, e.z, {
            vx: rnd(-2, 2),
            vy: rnd(0, 2.5),
            vz: rnd(-2, 2),
            life: rnd(0.5, 1.0),
            s0: 0.06,
            s1: 0.1,
            a0: 0.9,
            c0: [0.1, 0.1, 0.11],
            grav: 8
          });
        break;
      case 'letterboom': break;
      case 'boombounce': FX.dust(e.x, e.y, e.z, 3, 0.3); FX.spark(e.x, e.y, e.z); break;
      case 'boomhit': FX.spark(e.x, e.y, e.z); break;
      case 'steam': break;
    }
  };

  /* ---------- worm hooks (actors.js) ---------- */
  WV.worm = function (S, w, v, dt, t) {
    if (w.gas) {
      const age = S.time - (w.coughAt == null ? -9 : w.coughAt), env = age < 0.8 ? Math.exp(-age * 2.6) : 0, f = Math.sin(age * 34) * env;
      v.root.rotation.z += 0.12 * f; v.root.position.y += 0.035 * Math.abs(f);
      // a sickly tint
      if (v.mesh && v.mesh.material && v.mesh.material.emissive) v.mesh.material.emissive.g += 0.045 + 0.03 * Math.sin(t * 2 + w.id);
    }
    if (w.acidT != null && S.time - w.acidT < 0.4 && v.mesh && v.mesh.material && v.mesh.material.emissive)
      v.mesh.material.emissive.g += 0.12 * (0.6 + 0.4 * Math.sin(t * 25));
  };

  /* ---------- the boomerang's swoosh: a camera-facing ribbon through its last positions (motion blur look), fading to
   * the tail ---------- */
  const BTN = 30, trails = new Map();
  const TRAIL_FS = 'varying vec2 vUv; void main() { float a = (1.0 - vUv.y); a *= a * a; float e = exp(-vUv.x * vUv.x * 3.2); gl_FragColor = vec4(vec3(0.92, 0.96, 1.0), a * e * 0.3); }';
  function makeTrail(b) {
    const g = new T.BufferGeometry(),
      pos = new Float32Array(BTN * 2 * 3),
      uv = new Float32Array(BTN * 2 * 2),
      idx = new Uint16Array((BTN - 1) * 6);
    for (let i = 0; i < BTN; i++) { uv.set([-1, i / (BTN - 1), 1, i / (BTN - 1)], i * 4); }
    for (let i = 0; i < BTN - 1; i++) idx.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setIndex(new T.BufferAttribute(idx, 1));
    const mat = new T.ShaderMaterial({
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: TRAIL_FS,
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide
    });
    const mesh = new T.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    grp.add(mesh);
    return { mesh, pts: [], still: 0 };
  }
  const tTan = new T.Vector3(), tView = new T.Vector3(), tSide = new T.Vector3();
  function updateTrails(S, camera, list, live) {
    const seen = new Set();
    for (const b of list) {
      let tr = trails.get(b);
      if (!tr) {
        tr = makeTrail(b);
        trails.set(b, tr);
      }
      seen.add(b);
      const m = live.get(b);
      if (!m) continue;
      tr.pts.unshift(m.position.x, m.position.y, m.position.z);
      if (tr.pts.length > BTN * 3) tr.pts.length = BTN * 3;
      tr.still = 0;
    }
    for (const [b, tr] of trails) {
      if (!seen.has(b)) {
        if (tr.pts.length >= 6) {
          tr.pts.length -= 6;
        } else {
          grp.remove(tr.mesh);
          tr.mesh.geometry.dispose();
          tr.mesh.material.dispose();
          trails.delete(b);
          continue;
        }
      }
      const n = tr.pts.length / 3, pa = tr.mesh.geometry.attributes.position.array;
      for (let i = 0; i < BTN; i++) {
        const k = M_clamp(i, 0, n - 1) * 3, k0 = M_clamp(i - 1, 0, n - 1) * 3, k1 = M_clamp(i + 1, 0, n - 1) * 3, q = tr.pts;
        tTan.set(q[k0] - q[k1], q[k0 + 1] - q[k1 + 1], q[k0 + 2] - q[k1 + 2]);
        tView.set(camera.position.x - q[k], camera.position.y - q[k + 1], camera.position.z - q[k + 2]);
        tSide.crossVectors(tTan, tView);
        const l = tSide.length();
        if (l > 1e-6) tSide.multiplyScalar(0.15 * (1 - i / BTN) / l);
        else tSide.set(0, 0.2, 0);
        pa[i * 6] = q[k] - tSide.x;
        pa[i * 6 + 1] = q[k + 1] - tSide.y;
        pa[i * 6 + 2] = q[k + 2] - tSide.z;
        pa[i * 6 + 3] = q[k] + tSide.x;
        pa[i * 6 + 4] = q[k + 1] + tSide.y;
        pa[i * 6 + 5] = q[k + 2] + tSide.z;
      }
      tr.mesh.geometry.attributes.position.needsUpdate = true; tr.mesh.visible = n >= 2;
    }
  }

  /* ---------- init / frame ---------- */
  WV.init = function (sc, textures) {
    scene = sc; tx = textures;
    grp = new T.Group(); scene.add(grp);
    makeJet();
    makeAcid();
    makeGas();
    makeMinigun();
  };
  WV.clear = function () {
    if (!scene) return;
    for (const k in live) {
      for (const o of live[k].values()) grp.remove(o);
      live[k].clear();
    }
    for (const tr of trails.values()) {
      grp.remove(tr.mesh);
      tr.mesh.geometry.dispose();
      tr.mesh.material.dispose();
    }
    trails.clear();
    cas.length = 0;
    trT.length = 0;
    mg.pos = null;
    mg.n = 0;
    if (jet) {
      jet.visible = false;
      jetLight.intensity = 0;
    }
    if (dropsIM) dropsIM.count = 0;
    if (gasIM) gasIM.geometry.instanceCount = 0;
    if (casIM) casIM.count = 0;
  };
  WV.frame = function (S, view, camera, dt) {
    if (!scene) return;
    const t = view.time || 0;
    nowT = t;
    const wa = S.wa, d = P.dir(S), nn = P.nrm(S);
    updateJet(S, camera, t);
    updateAcid(S, t);
    updateGas(S, t);
    updateMinigun(S, dt, t);
    sync(live.boom, wa ? wa.boom : [], () => {
      const g = new T.Group(), b = boomMesh();
      g.add(b);
      g.userData.b = b;
      return g;
    }, (b, m) => {
      const w = P.to_world(S, b.s, b.y), K = A.BOOM, u = M_clamp(b.age / K.T, 0, 1), bank = b.dead ? 0 : K.BANK * Math.sin(Math.PI * u);
      const sgn = b.face >= 0 ? 1 : -1;
      m.position.set(w.x + nn.x * bank * sgn, w.y, w.z + nn.z * bank * sgn);
      m.rotation.set(0, -S.theta, 0, 'YXZ');
      m.userData.b.rotation.set(
        Math.PI / 2 - 0.5 * Math.sin(Math.PI * u) * sgn,
        b.dead ? (m.userData.b.rotation.y || 0) : b.age * 24 * sgn,
        0
      );
      m.userData.b.scale.setScalar(1.6);
      m.visible = SS.view.shownAt(S, w, 3.5);
    });
    updateTrails(S, camera, wa ? wa.boom : [], live.boom);
    sync(live.raven, wa ? wa.ravens : [], () => ravenMesh(), (r, m) => {
      const w = P.to_world(S, r.s, r.y), u = m.userData, K = A.RAVEN;
      let z = 0, yaw = -S.theta, pitch = 0;
      if (r.phase === 1) {                                           // circling above the target: a horizontal circle seen from the side
        z = K.R_ORBIT * Math.sin(r.oa) * 1.0;
        const vs = -Math.sin(r.oa) * r.face, vn = Math.cos(r.oa) * r.face;
        yaw = -Math.atan2(d.z * vs + nn.z * vn, d.x * vs + nn.x * vn); pitch = 0;
      } else {
        const cs = Math.cos(r.ang), sn = Math.sin(r.ang);
        if (cs < 0) yaw += Math.PI;
        pitch = Math.atan2(sn, Math.abs(cs)) * (cs < 0 ? 1 : 1);
      }
      m.position.set(w.x + nn.x * z, w.y, w.z + nn.z * z);
      if (r.phase === 3) {
        m.rotation.set(0, yaw, (r.spin || 0), 'YXZ');
        u.flap(0.2);
      } else {
        m.rotation.set(0, yaw, pitch, 'YXZ');
        u.flap(t * (r.phase === 1 ? 14 : 20) + r.id);
      }
      const left = r.phase >= 1 ? Math.max(0, K.N - (r.dropped || 0)) : K.N;
      u.env.forEach((e, i) => { e.visible = i < left; });
      m.scale.setScalar(1.3);
      m.visible = SS.view.shownAt(S, w, 4);
    });
    sync(live.letter, wa ? wa.letters : [], () => letterMesh(), (l, m) => {
      const w = P.to_world(S, l.s, l.y);
      m.position.set(w.x, w.y, w.z); m.rotation.set(Math.sin(l.age * 6 + l.ph) * 0.8, l.age * 2.5 + l.ph, Math.cos(l.age * 5 + l.ph) * 0.6);
      m.scale.setScalar(2.0); m.visible = SS.view.shownAt(S, w, 1);
    });
  };
  const M_clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  WV.stats = () => ({ casings: cas.length, boom: live.boom.size, ravens: live.raven.size, letters: live.letter.size });
  /* P78: held models, jets, the muzzle cone are built on first use: pre-warm exemplars (render/prewarm.js) */
  if (SS.prewarm) SS.prewarm.exemplars(() => {
    const out = [];
    const tryAdd = f => {
      try {
        const g = f();
        if (g) out.push(g);
      } catch (e) { /* lazy */ }
    };
    for (const k of Object.keys(HELD)) tryAdd(() => HELD[k]());
    for (const f of [flashCone, boomMesh, ravenMesh, letterMesh]) tryAdd(f);
    return out;
  });
})(window.SS = window.SS || {});
