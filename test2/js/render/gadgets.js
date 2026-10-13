/* render/gadgets.js — P37 W4 weapons B on screen (Three.js; all procedural geometry + shaders, no images):
 *   - the robotic dog: a low-poly robot (armoured torso, head with red visor eyes, ears, an explosive pack with a
 *     blinking timer LED, an antenna tail) with a real gait: diagonal legs swing from the distance it ran (hip + knee),
 *     the body bobs, legs spread in a hop and scramble in place against a wall;
 *   - the sentry gun: tripod, turret with a three-barrel cluster and an ammo drum, a red laser ring; the scanning beam
 *     (a thin sheet at beam height ending where the terrain stops it) with a fading fan behind it, muzzle flashes and
 *     tracers (events sgshot), toppled with sparks when knocked over (state 1), dark when spent;
 *   - the claymore: a curved olive case on scissor legs, an amber LED that blinks while it arms, then a red laser 3 m
 *     long that is drawn only while the view's section is (nearly) the one it was planted in; the directional blast
 *     (event claymoreblast): a cone flash, sparks and dust along the pellets;
 *   - the gravity gun: cyan outlines on everything grabbable in range (bodies.js BV.outline, the aimed one stronger),
 *     the held object with a wavering energy beam and pulse rings, a thrown object's wake;
 *   - the knockout punch: a boxing glove that swings up from below on the worm, a ring + stars at the hit.
 * API: init(scene, textures), clear(), frame(S, view, camera, dt), onEvent(S, e), heldModel(id) (ordnance.js: the held
 * models of the new weapons), stats(). Math.random is fine here: presentation only. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, P = SS.plane;
  const GV = SS.gadgetView = {};
  let scene = null, tx = null, root = null, clock = 0;
  const std = (c, o) => new T.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.5, metalness: 0.3 }, o || {}));
  const MT = {
    dark: std(0x2b2f33, { metalness: 0.65, roughness: 0.38 }), steel: std(0xaab0b8, { metalness: 0.85, roughness: 0.28 }),
    gunmetal: std(0x4a5057, { metalness: 0.75, roughness: 0.35 }),
    orange: std(0xe0782a, { roughness: 0.45, metalness: 0.25 }), olive: std(0x55673a, { roughness: 0.55, metalness: 0.2 }),
    oliveL: std(0x6e8247, { roughness: 0.55, metalness: 0.2 }),
    red: std(0xb52a1e, { roughness: 0.5 }), eye: new T.MeshBasicMaterial({ color: 0xff3a24 }),
    led: new T.MeshBasicMaterial({ color: 0xffb02e }), lens: new T.MeshBasicMaterial({ color: 0xff2a1a }),
    black: std(0x141414, { roughness: 0.6 }), glove: std(0xc42a24, { roughness: 0.55 }), cuff: std(0xeeeeee, { roughness: 0.8 }),
    yellow: std(0xe6c02c, { roughness: 0.5 }),
    cyan: new T.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.8, blending: T.AdditiveBlending, depthWrite: false })
  };
  const KEEP = new Set(Object.values(MT));
  const box = (x, y, z) => new T.BoxGeometry(x, y, z),
    cyl = (a, b, h, n) => new T.CylinderGeometry(a, b, h, n || 10),
    sph = r => new T.SphereGeometry(r, 10, 8);
  function part(g, geo, mat, x, y, z, rx, ry, rz) {
    const m = new T.Mesh(geo, mat);
    m.position.set(x || 0, y || 0, z || 0);
    m.rotation.set(rx || 0, ry || 0, rz || 0);
    m.castShadow = true;
    g.add(m);
    return m;
  }

  /* ---------- the robotic dog (P82: the baked rigged model gadget_dog; local +x = forward, y up, origin = the
   * collision centre, the feet 0.345 m below) ----------
   * parts (pivots at the joints): head (neck), tail, antenna, pack (explosive pack), hip<FL|FR|RL|RR> (thigh) >
   * knee<..> (shin + foot). Render only: the pose is a function of the sim state (distance run -> gait phase, airborne
   * -> hop pose, blocked -> scramble). The LED / eyes are emissive overlays so they can blink. */
  const glowMat = c => new T.MeshBasicMaterial({ color: c, toneMapped: false });
  function dogMesh() {
    const g = new T.Group(), body = new T.Group(), mo = SS.models.mesh('gadget_dog'), P = mo.userData.parts;
    g.add(body);
    body.add(mo);
    const legs = [];
    for (const k of ['FL', 'FR', 'RL', 'RR']) legs.push({ hip: P['hip' + k], knee: P['knee' + k], front: k[0] === 'F' });
    const led = new T.Mesh(sph(0.021), glowMat(0xff3a24));
    led.position.set(-0.05, 0.185, 0);
    P.pack.add(led);
    const eyes = [-1, 1].map(sg => {
      const e = new T.Mesh(box(0.012, 0.036, 0.046), glowMat(0xff3a24));
      e.position.set(0.1935, 0.09, sg * 0.055);
      P.head.add(e);
      return e;
    });
    const tip = new T.Mesh(sph(0.019), glowMat(0xff3a24));
    tip.position.set(-0.1, 0.215, 0);
    P.antenna.add(tip);
    g.userData = { body, led, legs, head: P.head, tail: P.tail, antenna: P.antenna, eyes, tip, model: mo };
    return g;
  }
  function dogFrame(S, d, m, t) {
    const u = m.userData, dir = P.dir(S), wp = P.to_world(S, d.s, d.y);
    const ph = d.dist * Math.PI * 2 / 0.95 + (d.state === 1 ? d.age * 22 : 0);
    const air = d.state === 2, blocked = d.state === 1;
    m.position.set(wp.x, wp.y, wp.z);
    m.rotation.set(0, -Math.atan2(dir.z * d.dir, dir.x * d.dir), 0, 'YXZ');
    // P68g: lies along its surface (End of the World)
    if (d.euy != null) m.rotation.z = d.dir * Math.atan2(-d.eus, d.euy);
    u.body.position.y = air ? 0.02 : 0.018 * Math.abs(Math.sin(ph)) - (blocked ? 0.01 : 0);
    u.body.rotation.z = air ? M_clamp(Math.atan2(d.vy, 6), -0.5, 0.5) * 0.6 : 0.04 * Math.sin(ph * 2);
    u.legs.forEach((l, i) => {
      const off = (i === 0 || i === 3) ? 0 : Math.PI;                                   // trot: FL + RR together
      if (air) {
        l.hip.rotation.z = l.front ? 0.85 : -0.8;
        l.knee.rotation.z = l.front ? -0.1 : -0.35;
      }
      else {
        const p = ph + off;
        l.hip.rotation.z = 0.7 * Math.sin(p);
        l.knee.rotation.z = -0.15 - 0.95 * Math.max(0, Math.cos(p)) * (l.front ? 0.7 : 1);
      }
    });
    u.head.rotation.z = 0.12 * Math.sin(ph) + (air ? -0.1 : 0);
    const urg = 1 - Math.max(0, d.life) / C.TOOLB.DOG.TIMER;
    // the stub wags faster as the fuse runs down
    u.tail.rotation.y = (0.35 + 0.5 * urg) * Math.sin(t * (9 + 10 * urg) + d.id);
    u.antenna.rotation.z = 0.10 * Math.sin(ph * 2 + 1) - 0.05 * M_clamp(d.vs || 0, -6, 6) * 0.1 * d.dir;
    u.antenna.rotation.x = 0.07 * Math.sin(t * 7 + d.id);
    // the LED blinks faster as the timer runs down; the eyes pulse
    const rate = 3 + 14 * urg;
    u.led.material.color.setHex(Math.sin(t * rate * 2.2) > 0 ? 0xff3a24 : 0x4a1208);
    const ey = 0.75 + 0.25 * Math.sin(t * 5 + d.id);
    for (const e of u.eyes) e.material.color.setRGB(1.0 * ey, 0.23 * ey, 0.14 * ey);
    u.tip.material.color.setHex(Math.sin(t * rate * 2.2 + 1.6) > 0 ? 0xff3a24 : 0x4a1208);
  }
  const M_clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ---------- the sentry gun ---------- */
  const BEAM_VS = `varying float vA;
    attribute float a;
    void main(){
      vA = a;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const BEAM_FS = `varying float vA;
    uniform float uA;
    void main(){ gl_FragColor = vec4(1.0, 0.12, 0.08, vA * uA); }`;
  // a fan of N segments in the xz plane, +x = the beam, alpha 1 at the beam fading behind (towards -angle)
  function fanGeo() {
    const N = 14, pos = [], al = [], idx = [], span = 0.7;
    pos.push(0, 0, 0); al.push(0);
    for (let i = 0; i <= N; i++) {
      const a = -span * i / N;
      pos.push(Math.cos(a), 0, Math.sin(a));
      al.push(Math.pow(1 - i / N, 2) * 0.45);
    }
    for (let i = 1; i <= N; i++) idx.push(0, i, i + 1);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('a', new T.Float32BufferAttribute(al, 1));
    g.setIndex(idx);
    return g;
  }
  let FAN = null;
  function sentryMesh() {
    const g = new T.Group(), tilt = new T.Group(), mo = SS.models.mesh('gadget_sentry'), P = mo.userData.parts;
    g.add(tilt);
    tilt.add(mo);
    // the sensor eye's glass (blinks)
    const lens = new T.Mesh(cyl(0.024, 0.024, 0.004, 14).rotateZ(Math.PI / 2), MT.lens.clone());
    lens.position.set(0.0525, 0.06, 0);
    P.eye.add(lens);
    // the scanning beam (a thin additive bar) + the fading fan behind it, both horizontal at turret height
    FAN = FAN || fanGeo();
    const bgeo = cyl(0.016, 0.016, 1, 6);
    bgeo.rotateZ(Math.PI / 2);
    bgeo.translate(0.5, 0, 0);
    const beam = new T.Mesh(
      bgeo,
      new T.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false })
    );
    // afterimages trailing the sweep
    const echoes = [1, 2, 3].map(i => {
      const e = new T.Mesh(
        bgeo,
        new T.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.5 / i, blending: T.AdditiveBlending, depthWrite: false })
      );
      e.rotation.y = 0.05 * i;
      return e;
    });
    const spot = new T.Sprite(
      new T.SpriteMaterial({ map: tx.glow, color: 0xff3a24, transparent: true, blending: T.AdditiveBlending, depthWrite: false })
    );
    spot.scale.set(0.5, 0.5, 1);
    const fan = new T.Mesh(
      FAN,
      new T.ShaderMaterial({
        vertexShader: BEAM_VS,
        fragmentShader: BEAM_FS,
        uniforms: { uA: { value: 1 } },
        transparent: true,
        depthWrite: false,
        side: T.DoubleSide,
        blending: T.AdditiveBlending
      })
    );
    const scan = new T.Group();
    scan.add(beam, fan, spot, ...echoes);
    g.add(scan);
    // the muzzle flash: a procedural additive burst (a long cone + a short fat one + a core) at the tip of the cluster,
    // drawn only for a few frames after each round
    const flash = new T.Group();
    flash.position.set(0.43, 0, 0);
    P.barrel.add(flash);
    const fm = (c, o) => new T.MeshBasicMaterial({
      color: c,
      transparent: true,
      opacity: o,
      blending: T.AdditiveBlending,
      depthWrite: false,
      toneMapped: false
    });
    const c1 = new T.Mesh(new T.ConeGeometry(0.07, 0.55, 8, 1, true).rotateZ(-Math.PI / 2).translate(0.275, 0, 0), fm(0xffb24a, 0.9)),
      c2 = new T.Mesh(new T.ConeGeometry(0.12, 0.2, 8, 1, true).rotateZ(-Math.PI / 2).translate(0.1, 0, 0), fm(0xff7a1e, 0.7)),
      c3 = new T.Mesh(new T.SphereGeometry(0.06, 8, 6), fm(0xfff2c0, 1));
    flash.add(c1, c2, c3); flash.userData.mats = [c1.material, c2.material, c3.material]; flash.visible = false;
    g.userData = { tilt, P, lens, beam, fan, scan, flash, echoes, spot, fireT: -9, spinA: 0, spinV: 0, model: mo };
    return g;
  }
  const sFr = {}, tiltAx = new T.Vector3(), ringZ = new T.Vector3(0, 0, 1), ringN = new T.Vector3();       // scratch (P38 R1)
  function sentryFrame(S, s, m, t, view) {
    const u = m.userData;
    m.position.set(s.pos.x, s.pos.y, s.pos.z);
    // P86: End of the World: the tripod stands on its local up (the pull's opposite), not the camera's
    if (S.eow) {
      const F = SS.eow.frame(s.eu, sFr);
      mBasis.makeBasis(vX.set(F.e1x, F.e1y, F.e1z), vY.set(F.ux, F.uy, F.uz), vZ.set(F.e2x, F.e2y, F.e2z));
      m.quaternion.setFromRotationMatrix(mBasis);
    } else if (SS.groundView && s.state === 0) {
      // P65b: the tripod leans with the slope (<= 11 deg) and sinks to its lowest foot; a contact shadow
      const GR = SS.groundView;
      if (!u.cf) u.cf = GR.cf(s.id);
      m.quaternion.identity();
      GR.seat(u.cf, m, s.pos.x, s.pos.y, s.pos.z, 0, 0.36, 0.36, 0.55, 0.19, dtG, t);
      GR.blob(s.pos.x, s.pos.y - 0.02, s.pos.z, 0.8, 1);
    }
    // tilt over about the base in the direction of the fall
    u.tilt.quaternion.setFromAxisAngle(tiltAx.set(Math.sin(s.tiltAz), 0, -Math.cos(s.tiltAz)), s.tilt);
    // P82: the rigged turret: ring yaws, the cradle pitches
    u.P.yaw.rotation.y = -s.yaw; u.P.pitch.rotation.z = s.pitch;
    const fireAge = t - u.fireT, firing = fireAge < 0.3 && (s.state === 0 || s.state === 1);
    // the cluster spins up while it fires, then winds down
    u.spinV += ((firing ? 38 : s.state === 0 ? 0 : 0) - u.spinV) * Math.min(1, dtG * (firing ? 14 : 3)); u.spinA += u.spinV * dtG;
    // recoil
    u.P.barrel.rotation.x = u.spinA; u.P.barrel.position.x = u.P.barrel.userData.rest.x - 0.035 * Math.max(0, 1 - fireAge / 0.09);
    u.P.pitch.position.x = u.P.pitch.userData.rest.x - 0.006 * Math.max(0, 1 - fireAge / 0.09);
    // the sensor eye looks about while it scans
    u.P.eye.rotation.y = s.state === 0 && !firing ? 0.55 * Math.sin(t * 1.7 + s.id) : 0;
    const live = s.state === 0;
    u.scan.visible = live; u.scan.position.set(0, 0.5, 0);
    if (live) {
      u.scan.rotation.set(0, -s.yaw, 0);
      const L = s.burst.left > 0 ? Math.min(s.beamLen, 14) : s.beamLen;
      u.beam.scale.set(L, 1, 1);
      u.fan.scale.set(L, 1, L);
      u.spot.position.set(L, 0, 0);
      u.spot.material.opacity = 0.6 + 0.4 * Math.sin(t * 30);
      u.echoes.forEach((e, i) => {
        e.scale.set(L, 1, 1);
        e.rotation.y = (s.spin > 0 ? 1 : -1) * 0.05 * (i + 1);
      });
      u.beam.material.opacity = 0.75 + 0.2 * Math.sin(t * 40);
      // the fan trails behind the sweep (mirrored for the other direction)
      u.fan.material.uniforms.uA.value = s.spin > 0 ? 1 : 0;
      u.fan.scale.z = s.spin > 0 ? L : -L;
    }
    u.lens.material.color.setHex(live ? (Math.sin(t * 9) > 0 ? 0xff2a1a : 0x7a1208) : 0x2a0a08);
    const fk = Math.max(0, 1 - fireAge / 0.07) * (live || s.state === 1 ? 1 : 0);
    u.flash.visible = fk > 0.02;
    u.flash.rotation.x = t * 40;
    u.flash.scale.set(0.7 + 0.5 * fk, 0.8 + 0.4 * Math.sin(t * 90), 0.8 + 0.4 * Math.cos(t * 70));
    for (const m_ of u.flash.userData.mats) m_.opacity = fk;
    if (s.state === 1 && Math.random() < 0.25) SS.fx.spark(s.pos.x, s.pos.y + 0.3, s.pos.z);
    if (s.state === 2 && s.deadT < 4 && Math.random() < 0.05) SS.fx.dust(s.pos.x, s.pos.y + 0.4, s.pos.z, 1, 0.3, 0x333333);
  }

  /* ---------- the claymore (local +x = the blast / laser direction, y up) ---------- */
  function claymoreMesh() {
    const g = new T.Group();
    // a curved case: five slabs along an arc, convex towards the enemy
    for (let i = -2; i <= 2; i++)
      part(g, box(0.07, 0.17, 0.1), i === 0 ? MT.oliveL : MT.olive, 0.03 - 0.014 * i * i, 0, i * 0.085, 0, -i * 0.22, 0);
    part(g, box(0.02, 0.03, 0.34), MT.dark, -0.04, 0.1, 0);                         // the sight along the top
    // scissor legs
    for (const z of [-0.12, 0.12]) part(g, cyl(0.007, 0.007, 0.22, 5), MT.steel, -0.04, -0.12, z, 0, 0, z > 0 ? 0.35 : -0.35);
    const led = part(g, sph(0.022), MT.led.clone(), 0.0, 0.1, 0.04);
    led.castShadow = false;
    const lens = part(g, cyl(0.014, 0.014, 0.03, 8), MT.lens.clone(), 0.07, 0.03, 0, 0, 0, Math.PI / 2);
    lens.castShadow = false;
    const laser = new T.Mesh(
      cyl(0.008, 0.008, 1, 5),
      new T.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false })
    );
    laser.geometry.rotateZ(Math.PI / 2);
    laser.geometry.translate(0.5, 0, 0);
    laser.position.set(0.08, 0.03, 0);
    g.add(laser);
    g.userData = { led, laser, lens };
    return g;
  }
  const vUp = new T.Vector3(0, 1, 0), mBasis = new T.Matrix4(), vX = new T.Vector3(), vY = new T.Vector3(), vZ = new T.Vector3();
  function claymoreFrame(S, c, m, t) {
    const u = m.userData;
    m.position.set(c.pos.x, c.pos.y, c.pos.z); m.scale.setScalar(1.5);
    vX.set(c.dir.x, c.dir.y, c.dir.z);
    vZ.set(c.pn.x, 0, c.pn.z);
    vY.crossVectors(vZ, vX).normalize();
    vZ.crossVectors(vX, vY).normalize();
    // P65b: lying on the ground: the case sits on the slope (its up = the ground normal), not upright on it (P86: in
    // space on any side: up = its surface's, nothing pulled toward the world's up)
    if (c.attach === 0 && c.nrm && (c.nrm.y > 0.75 || S.eow)) {
      vY.set(c.nrm.x, c.nrm.y, c.nrm.z).lerp(vUp, S.eow ? 0 : 0.2).normalize();
      if (S.eow) vX.set(c.dir.x, c.dir.y, c.dir.z);
      else vX.set(c.dir.x, 0, c.dir.z);
      vX.addScaledVector(vY, -vX.dot(vY)).normalize();
      vZ.crossVectors(vX, vY);
    }
    mBasis.makeBasis(vX, vY, vZ); m.quaternion.setFromRotationMatrix(mBasis);
    if (c.attach === 0 && SS.groundView) SS.groundView.blob(c.pos.x, c.pos.y - 0.12, c.pos.z, 0.55, 1);
    // (visible to the planter's team, and to all while planted / armed)
    const hid = !SS.view.trapVisible(S, c.team, c.planted, c.armed);
    m.visible = SS.view.shownAt(S, c.pos, 0.7) && !hid;
    // the laser shows only while the view's section is (nearly) the planting section
    const d = P.dir(S), same = Math.abs(d.x * c.pdir.x + d.z * c.pdir.z), k = Math.max(0, Math.min(1, (same - 0.93) / 0.05));
    u.laser.visible = !!c.armed && k > 0.02;
    u.laser.scale.set(C.TOOLB.CLAY.LASER - 0.08, 1, 1);
    u.laser.material.opacity = 0.35 + 0.55 * k * (0.7 + 0.3 * Math.sin(t * 50));
    u.led.material.color.setHex(c.armed ? (Math.sin(t * 14) > 0 ? 0xff2a1a : 0xaa1a10) : (Math.sin(t * 6) > 0 ? 0xffb02e : 0x3a2808));
  }

  /* ---------- live objects ---------- */
  const live = { dogs: new Map(), sentries: new Map(), claymores: new Map() };
  const fxs = [];
  const addFx = (obj, life, fn) => {
    root.add(obj);
    fxs.push({ obj, t: 0, life, fn });
    return obj;
  };
  function syncId(map, list, make, upd) {
    const seen = new Set();
    for (const o of list) {
      let m = map.get(o.id);
      if (!m) {
        m = make(o);
        root.add(m);
        map.set(o.id, m);
      }
      seen.add(o.id);
      upd(o, m);
    }
    for (const [id, m] of map)
      if (!seen.has(id)) {
        root.remove(m);
        map.delete(id);
        SS.mat.disposeTree(m, KEEP);
      }
  }
  GV.init = function (sc, textures) {
    scene = sc;
    tx = textures;
    root = new T.Group();
    scene.add(root);
  };
  GV.clear = function () {
    for (const k in live) {
      for (const m of live[k].values()) {
        root.remove(m);
        SS.mat.disposeTree(m, KEEP);
      }
      live[k].clear();
    }
    for (const f of fxs) {
      root.remove(f.obj);
      SS.mat.disposeTree(f.obj, KEEP);
    }
    fxs.length = 0;
    if (gloves.length) {
      for (const g of gloves)
        if (g.parent) g.parent.remove(g);
      gloves.length = 0;
    }
    if (beamLine) beamLine.visible = false;
  };

  /* ---------- events ---------- */
  const tr = new T.Vector3(), up = new T.Vector3(0, 1, 0);
  function tracer(e) {
    const len = Math.max(0.5, e.len || 18),
      m = new T.Mesh(
        cyl(0.012, 0.012, 1, 5),
        new T.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false })
      );
    const l = Math.min(len, 4);                                                        // a short streak flying out, not the whole line
    m.scale.set(1, l, 1); tr.set(e.dx, e.dy, e.dz).normalize(); m.quaternion.setFromUnitVectors(up, tr);
    m.position.set(e.x + tr.x * (l / 2 + 0.4), e.y + tr.y * (l / 2 + 0.4), e.z + tr.z * (l / 2 + 0.4));
    addFx(m, 0.07, (o, k) => { o.material.opacity = 0.95 * (1 - k); });
    if (e.hit) SS.fx.spark(e.x + tr.x * len, e.y + tr.y * len, e.z + tr.z * len);
  }
  // P38-R2: ring / cone effects follow the section clip like the objects (they showed on the hidden part of the map)
  let evS = null;
  const shown = (x, y, z) => !evS || (evS.inspect || 0) > 0.05 || SS.view.inSlab(evS, { x, y, z });
  function ring(x, y, z, col, r0, r1, life, nx, ny, nz) {
    if (!shown(x, y, z)) return;
    const m = new T.Mesh(
      new T.RingGeometry(0.85, 1, 40),
      new T.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0.9,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide,
        depthTest: false
      })
    );
    m.position.set(x, y, z); m.renderOrder = 11;
    if (nx != null) m.quaternion.setFromUnitVectors(ringZ, ringN.set(nx, ny, nz).normalize());
    addFx(m, life, (o, k) => {
      const s = r0 + (r1 - r0) * Math.sqrt(k);
      o.scale.set(s, s, s);
      o.material.opacity = 0.9 * (1 - k);
      if (nx == null) o.quaternion.copy(SS.view.camera().quaternion);
    });
  }
  /* P82: the baked model breaks into its chunks + the interior parts (battery, board, gears, wiring ...) at the pose of
   * the live mesh (render-only debris, models.js shatter) */
  function breakUp(id, e, map) {
    if (!SS.models || !SS.models.hasChunks(id)) return;
    let src = null, bd = 0.7;
    for (const m of map.values()) {
      const d = Math.hypot(m.position.x - e.x, m.position.y - e.y, m.position.z - e.z);
      if (d < bd) {
        bd = d;
        src = m;
      }
    }
    const g = new T.Group();
    g.position.set(e.x, e.y, e.z);
    if (src) g.quaternion.copy(src.quaternion);
    SS.models.shatter(id, g, (Math.round(e.x * 97) * 31 + Math.round(e.z * 89)) | 0);
  }
  GV.onEvent = function (S, e) {
    evS = S;
    switch (e.type) {
      case 'sgshot': tracer(e); break;
      case 'sentryshot':
        for (const m of live.sentries.values())
          if (Math.hypot(m.position.x - e.x, m.position.z - e.z) < 0.2) m.userData.fireT = clock;
        break;
      case 'sentryplant': case 'claymoreplant': SS.fx.dust(e.x, e.y, e.z, 5, 0.4, 0xb8a080); break;
      case 'sentrydown':
        SS.fx.dust(e.x, e.y + 0.2, e.z, 7, 0.6, 0xb8a080);
        for (let i = 0; i < 3; i++) SS.fx.spark(e.x, e.y + 0.4, e.z);
        break;
      case 'claymorearm': ring(e.x, e.y, e.z, 0xff5b4f, 0.1, 0.6, 0.5); break;
      case 'dogstart': SS.fx.dust(e.x, e.y - 0.4, e.z, 4, 0.35, 0xb8a080); break;
      case 'doghop': SS.fx.dust(e.x, e.y - 0.25, e.z, 3, 0.3, 0xb8a080); break;
      case 'dogboom':
        for (let i = 0; i < 4; i++) SS.fx.spark(e.x, e.y + 0.2, e.z);
        breakUp('gadget_dog', e, live.dogs);
        break;
      case 'devbreak':
        if (e.kind === 'sentry') breakUp('gadget_sentry', e, live.sentries);
        break;
      case 'claymoreblast': claymoreBlast(e); break;
      case 'punchhit': {
        ring(e.x, e.y, e.z, 0xfff0b0, 0.2, 1.8, 0.35); SS.fx.dust(e.x, e.y, e.z, 6, 0.5, 0xeeeeee);
        for (let i = 0; i < 5; i++) SS.fx.spark(e.x, e.y + 0.1, e.z);
        if (SS.actors.tumble && e.victim) SS.actors.tumble(e.victim, e.spin);
        break;
      }
      case 'punch': SS.fx.dust(e.worm.pos.x, e.worm.pos.y - 0.45, e.worm.pos.z, 4, 0.4, 0xb8a080); break;
      case 'grab': ring(e.x, e.y, e.z, 0x9fe8ff, 0.2, 1.4, 0.45); break;
      // P38-A4: a thrown supply crate hits a worm
      case 'cratehit':
        for (let i = 0; i < 10; i++) SS.fx.spark(e.x, e.y, e.z);
        SS.fx.dust(e.x, e.y, e.z, 5, 0.5, 0xb89a6a);
        break;
      case 'cratedrop':
        if (!SS.world.eow) SS.fx.dust(e.x, e.y - 0.3, e.z, Math.min(8, 2 + Math.floor(e.v * 0.4)), 0.5, 0xb8a080);
        break;
      case 'gravthrow': ring(e.x, e.y, e.z, 0x9fe8ff, 0.3, 2.0, 0.4); SS.fx.dust(e.x, e.y, e.z, 4, 0.3, 0xcfefff); break;
    }
  };
  function claymoreBlast(e) {
    if (!shown(e.x, e.y, e.z)) return;
    // a cone of light along the blast direction
    // apex at the claymore, opening along +x
    const g = new T.ConeGeometry(2.6, 6, 20, 1, true);
    g.translate(0, -3, 0);
    g.rotateZ(Math.PI / 2);
    const m = new T.Mesh(
      g,
      new T.MeshBasicMaterial({
        color: 0xffc870,
        transparent: true,
        opacity: 0.8,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide
      })
    );
    m.position.set(e.x, e.y, e.z); tr.set(e.dx, e.dy, e.dz).normalize(); m.quaternion.setFromUnitVectors(new T.Vector3(1, 0, 0), tr);
    addFx(m, 0.22, (o, k) => {
      o.material.opacity = 0.8 * (1 - k) * (1 - k);
      o.scale.set(1 + k * 0.5, 1 + k * 0.6, 1 + k * 0.6);
    });
    for (let i = 0; i < 18; i++) {
      const r = 0.6 + Math.random() * 6;
      SS.fx.spark(
        e.x + e.dx * r + (Math.random() - 0.5) * r * 0.6,
        e.y + e.dy * r + (Math.random() - 0.5) * r * 0.6,
        e.z + e.dz * r + (Math.random() - 0.5) * r * 0.6
      );
    }
    SS.fx.dust(e.x + e.dx, e.y + e.dy, e.z + e.dz, 8, 0.7, 0xb8a080);
  }

  /* ---------- gravity gun: outlines, the beam to the held object ---------- */
  let beamLine = null, lastOut = [], lastOutC = [], gloves = [];
  const gl = [];
  const tmpList = [];
  function gravity(S, view, t) {
    const a = S.active, human = a && !SS.game.is_cpu(S, a.team) && S.phase === 'play' && !a.dead;
    const want = new Map(), wantC = new Map();
    if (human && S.weapon === 'gravgun' && SS.bodyView.outline) {
      const list = SS.gadgets.grabbables(S, a, tmpList);
      list.forEach((e, i) => {
        if (e.crate) wantC.set(e.b, S.grab ? 0 : (i === 0 ? 1 : 0.45));
        else want.set(e.b.id, S.grab ? 0 : (i === 0 ? 1 : 0.45));
      });
      if (S.grab && !S.grab.crate) want.set(S.grab.body, 1.5);
      else if (S.grab) {
        const hc = S.crates.find(q => q.id === S.grab.body);
        if (hc) wantC.set(hc, 1.5);
      }
    }
    for (const id of lastOut)
      if (!want.has(id)) SS.bodyView.outline(id, 0);
    for (const [id, lv] of want)
      if (lv > 0) SS.bodyView.outline(id, lv, t);
    lastOut = [...want.keys()];
    if (SS.armsView && SS.armsView.crateGlow) {                                 // P38-A4: supply crates (their own meshes in arms.js)
      for (const c of lastOutC)
        if (!wantC.has(c)) SS.armsView.crateGlow(c, 0);
      for (const [c, lv] of wantC) SS.armsView.crateGlow(c, lv, t);
      lastOutC = [...wantC.keys()];
    }
    // the energy beam to the held object
    if (!beamLine) {
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(new Float32Array(24 * 3), 3).setUsage(T.DynamicDrawUsage));
      beamLine = new T.Line(
        g,
        new T.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false })
      );
      beamLine.frustumCulled = false;
      beamLine.renderOrder = 10;
      root.add(beamLine);
    }
    const b = S.grab ? (S.grab.crate ? S.crates.find(q => q.id === S.grab.body) : S.bodies.find(q => q.id === S.grab.body)) : null;
    if (b && a) {
      const p = beamLine.geometry.attributes.position.array, ax = a.pos.x, ay = a.pos.y + 0.15, az = a.pos.z, N = 24;
      for (let i = 0; i < N; i++) {
        const f = i / (N - 1), w = Math.sin(f * Math.PI) * 0.12 * Math.sin(t * 22 + f * 14);
        p[i * 3] = ax + (b.pos.x - ax) * f + w * 0.6;
        p[i * 3 + 1] = ay + (b.pos.y - ay) * f + w;
        p[i * 3 + 2] = az + (b.pos.z - az) * f + w * 0.6;
      }
      beamLine.geometry.attributes.position.needsUpdate = true; beamLine.visible = true;
      if (Math.random() < 0.3) SS.fx.spark(b.pos.x, b.pos.y, b.pos.z);
    } else beamLine.visible = false;
  }

  /* ---------- the punch glove ---------- */
  function punchFrame(S) {
    const need = [];
    for (const p of S.punches) {
      const k = (S.time - p.t0) / 0.5;
      if (k < 0 || k > 1) continue;
      const a = S.worms.find(w => w.id === p.wid);
      if (a) need.push([a, p, k]);
    }
    while (gloves.length < need.length) {
      const g = new T.Group();
      part(g, sph(0.15), MT.glove, 0, 0, 0);
      part(g, cyl(0.1, 0.1, 0.12, 12), MT.cuff, -0.17, 0, 0, 0, 0, Math.PI / 2);
      part(g, sph(0.07), MT.glove, 0.08, 0.1, 0.05);
      root.add(g);
      gloves.push(g);
    }
    for (let i = 0; i < gloves.length; i++) {
      const g = gloves[i];
      if (i >= need.length) {
        g.visible = false;
        continue;
      }
      const [a, p, k] = need[i], d = P.dir(S), f = p.dir;
      // from low behind the body to high in front (the uppercut), then back
      const out = Math.min(1, k / 0.32) * (1 - Math.max(0, (k - 0.5) / 0.5)), x = 0.1 + 0.8 * out, y = -0.35 + 1.05 * out;
      g.visible = true; g.position.set(a.pos.x + d.x * f * x, a.pos.y + y, a.pos.z + d.z * f * x);
      g.rotation.set(0, -Math.atan2(d.z * f, d.x * f), 1.1 * out, 'YXZ'); g.scale.setScalar(1.25);
    }
  }

  let dtG = 0.016;
  GV.frame = function (S, view, camera, dt) {
    if (!scene) return;
    dtG = dt || 0.016;
    const t = clock = view.time || 0;
    syncId(live.dogs, S.dogs || [], () => dogMesh(), (d, m) => {
      m.visible = SS.view.shownAt(S, P.to_world(S, d.s, d.y), 0.6);
      if (m.visible) dogFrame(S, d, m, t);
    });
    syncId(live.sentries, S.sentries || [], () => sentryMesh(), (s, m) => {
      m.visible = SS.view.shownAt(S, s.pos, 0.8);
      if (m.visible) sentryFrame(S, s, m, t, view);
    });
    syncId(live.claymores, S.claymores || [], () => claymoreMesh(), (c, m) => claymoreFrame(S, c, m, t));
    for (let i = fxs.length - 1; i >= 0; i--) {
      const f = fxs[i];
      f.t += dt;
      if (f.t >= f.life) {
        root.remove(f.obj);
        SS.mat.disposeTree(f.obj, KEEP);
        fxs.splice(i, 1);
        continue;
      }
      if (f.fn) f.fn(f.obj, f.t / f.life);
    }
    gravity(S, view, t);
    punchFrame(S);
  };

  /* held models of the new weapons (ordnance.js held(): local +x = the aim, origin = the grip, metres) */
  GV.heldModel = function (id) {
    const g = new T.Group();
    if (id === 'dog') {
      const d = dogMesh();
      d.scale.setScalar(0.62);
      d.position.set(0.05, 0.12, 0);
      g.add(d);
    }
    else if (id === 'sentry') {
      const s = sentryMesh();
      s.scale.setScalar(0.42);
      s.userData.scan.visible = false;
      s.position.set(0, -0.2, 0);
      g.add(s);
    }
    else if (id === 'claymore') {
      const c = claymoreMesh();
      c.scale.setScalar(1.3);
      c.userData.laser.visible = false;
      c.position.set(0.05, 0.05, 0);
      g.add(c);
    }
    else if (id === 'ffield') {
      part(g, cyl(0.12, 0.16, 0.08, 12), MT.dark, 0.1, -0.05, 0);
      part(g, sph(0.09), MT.cyan, 0.1, 0.06, 0);
      for (let i = 0; i < 3; i++)
        part(
          g,
          cyl(0.012, 0.012, 0.14, 5),
          MT.steel,
          0.1 + Math.cos(i * 2.094) * 0.1,
          0.03,
          Math.sin(i * 2.094) * 0.1,
          0,
          0,
          Math.cos(i * 2.094) * 0.5
        );
    }
    else if (id === 'gravgun') {
      part(g, box(0.26, 0.09, 0.07), MT.gunmetal, 0.12, 0, 0); part(g, box(0.07, 0.15, 0.06), MT.dark, 0.02, -0.1, 0, 0, 0, -0.25);
      part(g, cyl(0.045, 0.06, 0.12, 14), MT.steel, 0.3, 0, 0, 0, 0, Math.PI / 2);
      part(g, new T.TorusGeometry(0.058, 0.011, 6, 18), MT.cyan, 0.36, 0, 0, 0, Math.PI / 2, 0);
      part(g, sph(0.035), MT.cyan, 0.27, 0.07, 0);
    } else if (id === 'punch') {
      const gl = new T.Group();
      part(gl, sph(0.1), MT.glove, 0.1, 0, 0);
      part(gl, cyl(0.07, 0.07, 0.09, 12), MT.cuff, 0.0, 0, 0, 0, 0, Math.PI / 2);
      g.add(gl);
    }
    else return null;
    g.traverse(o => {
      if (o.isMesh) o.castShadow = false;
    });
    return g;
  };
  GV.stats = () => ({ dogs: live.dogs.size, sentries: live.sentries.size, claymores: live.claymores.size, fx: fxs.length });
  /* P78: gadget meshes are built on first use: pre-warm exemplars (render/prewarm.js) */
  if (SS.prewarm) SS.prewarm.exemplars(() => {
    const out = [];
    for (const f of [dogMesh, sentryMesh, claymoreMesh]) {
      try {
        out.push(f());
      } catch (e) { /* lazy */ }
    }
    return out;
  });
})(window.SS = window.SS || {});
