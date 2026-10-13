/* render/worn.js — P37 W4 what a worm wears and uses, on screen (Three.js; procedural geometry + shaders, no images):
 *   - the tinfoil hat (skill "grounding"): a crumpled foil cone on the head (flat-shaded polished metal) with a
 *     crinkled tip; it takes a bright glint when lightning hits (event zap);
 *   - the welding mask of the blowtorch / drill: a hinged dark visor with a green-black glass slit and a head band; it
 *     flips DOWN while the torch lights (sim S.dig.warm) and back UP when the cut is over (animated, ~0.45 s);
 *   - the blowtorch fire: a flame jet along the cut (a noise-shader cone: blue-white core, orange sheath, flicker,
 *     grows in over the warm-up), a string of flame billboards (render/bodies.js flame), a flickering point light, a
 *     stream of sparks, smoke and a glowing hot spot where it bites;
 *   - the laser sight skill: a dotted line (points) along the exact path of the selected bullet weapon, unlimited range
 *     (sim/skills.js laser_path), a ring where it ends; the aim reticle snaps there (laserHit);
 * API: init(scene, textures), clear(), frame(S, view, camera, dt), onEvent(S, e), laserHit() -> {x, y, z} | null. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, P = SS.plane;
  const WV = SS.wornView = {};
  let scene = null, tx = null, root = null;
  const hats = new Map(), masks = new Map();
  let torch = null, laser = null, laserRing = null, hit = null, light = null;
  const TV = { dir: new T.Vector3(), toCam: new T.Vector3(), yy: new T.Vector3(), zz: new T.Vector3(), m4: new T.Matrix4() };
  const noise = (x, y, z) => {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    return s - Math.floor(s);
  };

  /* ---------- the hat ---------- */
  const FOIL = new T.MeshStandardMaterial({ color: 0xe3e8ee, metalness: 0.95, roughness: 0.26, flatShading: true });
  const HAT_GEO = (() => {
    const g = new T.ConeGeometry(0.135, 0.28, 9, 5, false), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {                                           // crumple: jitter every vertex, ridged round the cone
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), k = 0.55 + 0.45 * (1 - (y + 0.14) / 0.28);
      p.setXYZ(i, x + (noise(x, y, z) - 0.5) * 0.03 * k, y + (noise(z, x, y) - 0.5) * 0.02, z + (noise(y, z, x) - 0.5) * 0.03 * k);
    }
    g.computeVertexNormals(); g.userData = { shared: true }; return g;
  })();
  FOIL.userData = { shared: true };
  // (P38-R2: module-level geometries: a hat / mask made per use leaked them)
  const sh = g => {
    g.userData = { shared: true };
    return g;
  };
  const TIP_GEO = sh(new T.IcosahedronGeometry(0.03, 0)), RIM_GEO = sh(new T.TorusGeometry(0.13, 0.012, 5, 14));
  function makeHat() {
    const g = new T.Group(), cone = new T.Mesh(HAT_GEO, FOIL);
    cone.position.y = 0.14;
    cone.castShadow = true;
    g.add(cone);
    const tip = new T.Mesh(TIP_GEO, FOIL);
    tip.position.y = 0.3;
    g.add(tip);
    const rim = new T.Mesh(RIM_GEO, FOIL);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.01;
    g.add(rim);
    const glint = new T.Sprite(
      new T.SpriteMaterial({
        map: tx.glow,
        color: 0xffffff,
        transparent: true,
        blending: T.AdditiveBlending,
        depthWrite: false,
        opacity: 0
      })
    );
    glint.scale.set(0.5, 0.5, 1);
    glint.position.y = 0.2;
    g.add(glint);
    g.scale.setScalar(1.3); g.userData.glint = glint; return g;
  }
  /* ---------- the welding mask ---------- */
  const DARK = new T.MeshStandardMaterial({ color: 0x23272b, metalness: 0.6, roughness: 0.4 }),
    GLASS = new T.MeshBasicMaterial({ color: 0x0b2a14 }),
    STRAP = new T.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 });
  DARK.userData = GLASS.userData = STRAP.userData = { shared: true };
  const PLATE_GEO = sh(new T.BoxGeometry(0.06, 0.24, 0.27)),
    SLIT_GEO = sh(new T.BoxGeometry(0.012, 0.045, 0.2)),
    SIDE_GEO = sh(new T.BoxGeometry(0.1, 0.2, 0.025));
  const BAR_GEO = sh(new T.CylinderGeometry(0.014, 0.014, 0.3, 6)), BAND_GEO = sh(new T.TorusGeometry(0.15, 0.018, 6, 20));
  function makeMask() {
    const g = new T.Group(), hinge = new T.Group();
    g.add(hinge);
    const plate = new T.Mesh(PLATE_GEO, DARK);
    plate.position.set(0.11, -0.12, 0);
    plate.castShadow = true;
    hinge.add(plate);
    const slit = new T.Mesh(SLIT_GEO, GLASS);
    slit.position.set(0.145, -0.09, 0);
    hinge.add(slit);
    for (const z of [-0.14, 0.14]) {
      const side = new T.Mesh(SIDE_GEO, DARK);
      side.position.set(0.06, -0.11, z);
      hinge.add(side);
    }
    const bar = new T.Mesh(BAR_GEO, DARK);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(0.02, 0, 0);
    hinge.add(bar);
    const band = new T.Mesh(BAND_GEO, STRAP);
    band.rotation.y = Math.PI / 2;
    band.position.set(-0.02, -0.04, 0);
    g.add(band);
    g.userData = { hinge, band, t: 0 };
    return g;
  }
  /* ---------- the torch jet ---------- */
  const JET_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const JET_FS = `varying vec2 vUv;
    uniform float uT, uK;
    float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n2(vec2 p){
      vec2 i = floor(p), f = fract(p);
      f = f*f*(3.0-2.0*f);
      return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y);
    }
    void main(){
      // v: 0 at the nozzle -> 1 at the tip; r: 0 axis -> 1 edge
      float v = vUv.x, r = abs(vUv.y - 0.5) * 2.0;
      float n = n2(vec2(vUv.y * 5.0 + uT * 3.0, v * 7.0 - uT * 26.0)) * 0.6 + n2(vec2(vUv.y * 11.0 - uT * 2.0, v * 15.0 - uT * 40.0)) * 0.4;
      float width = (0.55 + 0.45 * sin(v * 3.14159)) * (1.0 - v * 0.55);
      float body = (1.0 - smoothstep(width * 0.35, width + 0.1 * n, r)) * (1.0 - smoothstep(0.62, 1.0, v + n * 0.28));
      float core = (1.0 - smoothstep(0.0, width * 0.5, r)) * (1.0 - smoothstep(0.1, 0.72, v));
      vec3 col = mix(vec3(1.0, 0.36, 0.05), vec3(1.0, 0.82, 0.38), core);
      // a blue-white core near the nozzle
      col = mix(col, vec3(0.55, 0.78, 1.0), smoothstep(0.35, 0.8, core) * (1.0 - smoothstep(0.0, 0.5, v)));
      float a = body * uK;
      gl_FragColor = vec4(col * (1.0 + 0.7 * core) * a, a);
    }`;
  function makeTorch() {
    // x = along the jet (0 nozzle .. 1 tip), y = across; turned to face the camera every frame
    const g = new T.Group(), geo = new T.PlaneGeometry(1, 1, 1, 1);
    geo.translate(0.5, 0, 0);
    const mat = new T.ShaderMaterial({
      vertexShader: JET_VS,
      fragmentShader: JET_FS,
      uniforms: { uT: { value: 0 }, uK: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: T.CustomBlending,
      blendEquation: T.AddEquation,
      blendSrc: T.OneFactor,
      blendDst: T.OneFactor,
      side: T.DoubleSide
    });
    const jet = new T.Mesh(geo, mat);
    jet.renderOrder = 15;
    jet.frustumCulled = false;
    g.add(jet);
    const tip = new T.Sprite(
      new T.SpriteMaterial({ map: tx.glow, color: 0xffb060, transparent: true, blending: T.AdditiveBlending, depthWrite: false })
    );
    tip.scale.set(1.6, 1.6, 1);
    tip.renderOrder = 15;
    g.add(tip);
    g.userData = { jet, mat, tip, bills: [] }; g.visible = false; return g;
  }

  WV.init = function (sc, textures) {
    scene = sc;
    tx = textures;
    root = new T.Group();
    scene.add(root);
    torch = makeTorch(); root.add(torch);
    light = new T.PointLight(0xffa860, 0, 8, 1.6); root.add(light);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(2200 * 3), 3).setUsage(T.DynamicDrawUsage));
    // a crisp round dot with a dark rim: reads on a bright sky and on dark soil
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const cx = cv.getContext('2d');
    cx.fillStyle = 'rgba(40,0,0,0.9)';
    cx.beginPath();
    cx.arc(16, 16, 15, 0, 7);
    cx.fill();
    cx.fillStyle = '#ff3a24';
    cx.beginPath();
    cx.arc(16, 16, 11, 0, 7);
    cx.fill();
    cx.fillStyle = '#ffc8b8';
    cx.beginPath();
    cx.arc(14, 14, 4, 0, 7);
    cx.fill();
    laser = new T.Points(
      g,
      new T.PointsMaterial({
        color: 0xffffff,
        size: 0.26,
        map: new T.CanvasTexture(cv),
        transparent: true,
        depthTest: false,
        depthWrite: false,
        alphaTest: 0.05
      })
    );
    laser.renderOrder = 12;
    laser.frustumCulled = false;
    laser.visible = false;
    root.add(laser);
    laserRing = new T.Sprite(new T.SpriteMaterial({ map: tx.ring, color: 0xff3a24, depthTest: false, transparent: true }));
    laserRing.scale.set(0.6, 0.6, 1);
    laserRing.renderOrder = 12;
    laserRing.visible = false;
    root.add(laserRing);
  };
  WV.clear = function () {
    for (const [, h] of hats)
      if (h.parent) h.parent.remove(h);
    hats.clear();
    for (const [, m] of masks)
      if (m.parent) m.parent.remove(m);
    masks.clear();
    if (torch) {
      torch.visible = false;
      for (const b of torch.userData.bills) SS.bodyView.unflame(b);
      torch.userData.bills.length = 0;
    }
    if (laser) laser.visible = false;
    if (laserRing) laserRing.visible = false;
    hit = null;
  };
  const glints = new Map();
  WV.onEvent = function (S, e) {
    if (e.type === 'zap' && e.worm) glints.set(e.worm.id, 1);
    if (e.type === 'skillget' && e.worm && e.tool === 'tinfoil') glints.set(e.worm.id, 1);
  };
  WV.laserHit = () => hit;
  WV.debug = () => ({ torch, light, laser });
  let wasDig = false, digEndT = -9, sparkT = 0;

  WV.frame = function (S, view, camera, dt) {
    if (!scene) return;
    const t = view.time || 0, a = S.active;
    // ----- hats + masks: attached to the live head of each worm (actors.js keeps eyes / heading per worm) -----
    const digging = !!(S.dig && a);
    if (wasDig && !digging) digEndT = t;
    wasDig = digging;
    for (const w of S.worms) {
      const vis = SS.actors.vis(w), v = vis && vis.v;
      if (!v) continue;
      const wantHat = !w.dead && w.skills && w.skills.tinfoil > 0;
      let hat = hats.get(w.id);
      if (wantHat && !hat) {
        hat = makeHat();
        v.body.add(hat);
        hats.set(w.id, hat);
      }
      if (hat && (!wantHat || hat.parent !== v.body)) {
        if (hat.parent) hat.parent.remove(hat);
        hats.delete(w.id);
        hat = null;
        if (wantHat) {
          hat = makeHat();
          v.body.add(hat);
          hats.set(w.id, hat);
        }
      }
      const ep = v.eyes.position, ha = v.eyes.rotation.z, ux = -Math.sin(ha), uy = Math.cos(ha), fx = Math.cos(ha), fy = Math.sin(ha);
      if (hat) {
        hat.position.set(ep.x + ux * 0.1 - fx * 0.03, ep.y + uy * 0.1 - fy * 0.03, 0); hat.rotation.z = ha - 0.15;
        const gl = glints.get(w.id) || 0;
        hat.userData.glint.material.opacity = gl + 0.12 * Math.max(0, Math.sin(t * 3 + w.id));
        glints.set(w.id, Math.max(0, gl - dt * 1.6));
      }
      // the mask: down while this worm uses the torch / drill (S.dig, incl. its warm-up), up again over COOL s
      // afterwards
      const using = w === a && digging, K = C.ARMS.DIG;
      let mk = masks.get(w.id);
      if (using && !mk) {
        mk = makeMask();
        v.body.add(mk);
        masks.set(w.id, mk);
      }
      if (mk) {
        const tgt = using ? 1 : 0, rate = using ? 1 / (K.WARM * 0.8) : 1 / K.COOL;
        mk.userData.t += M_clamp(tgt - mk.userData.t, -rate * dt, rate * dt);
        const k = mk.userData.t, e = k * k * (3 - 2 * k);
        mk.position.set(ep.x + ux * 0.1 + fx * 0.0, ep.y + uy * 0.1 + fy * 0.0, 0); mk.rotation.z = ha;
        mk.userData.hinge.rotation.z = (1 - e) * 2.6; mk.userData.band.visible = k > 0.02;
        if (!using && k <= 0) {
          v.body.remove(mk);
          masks.delete(w.id);
        }
      }
    }
    for (const [id, h] of hats)
      if (!S.worms.some(w => w.id === id && SS.actors.vis(w))) {
        if (h.parent) h.parent.remove(h);
        hats.delete(id);
      }
    // ----- the torch fire -----
    const tu = torch.userData;
    if (digging && S.dig) {
      const g = S.dig, ap = P.to_plane(S, a.pos), d = P.dir(S), ds = g.ds, dy = g.dy;
      const k = Math.min(1, Math.max(0, 1 - Math.max(0, g.warm) / C.ARMS.DIG.WARM)), cut = g.warm <= 0;
      const start = P.to_world(S, ap.s + ds * 0.5, a.pos.y + dy * 0.5 - (g.mode === 'drill' ? 0.0 : 0.05));
      torch.visible = k > 0.02; torch.position.set(start.x, start.y, start.z);
      const dir = TV.dir.set(d.x * ds, dy, d.z * ds).normalize();
      const L = (g.mode === 'drill' ? 1.4 : 1.7) * (0.4 + 0.6 * k) * (0.92 + 0.08 * Math.sin(t * 50)), Wd = 0.7 * (0.5 + 0.5 * k);
      // an axis-aligned billboard: x along the jet, the quad faces the camera (scratch vectors: no per-frame
      // allocation, P38 R1)
      const toCam = TV.toCam.subVectors(camera.position, torch.position).normalize(),
        yy = TV.yy.crossVectors(toCam, dir).normalize(),
        zz = TV.zz.crossVectors(dir, yy);
      tu.jet.quaternion.setFromRotationMatrix(TV.m4.makeBasis(dir, yy, zz));
      tu.jet.scale.set(L, Wd, 1); tu.mat.uniforms.uT.value = t; tu.mat.uniforms.uK.value = 0.4 + 0.6 * k;
      tu.tip.position.copy(dir).multiplyScalar(L * 0.95);
      tu.tip.scale.setScalar(1.3 + 0.5 * Math.sin(t * 31) + 0.6 * k);
      tu.tip.material.opacity = 0.5 + 0.4 * k;
      // flame billboards along the jet (the shared procedural flame), a point light, sparks, smoke
      const nb = 3;
      while (tu.bills.length < nb) tu.bills.push(SS.bodyView.flame(Math.random()));
      tu.bills.forEach((b, i) => {
        const f = (0.45 + 0.28 * i) * L;
        b.position.set(start.x + dir.x * f, start.y + dir.y * f, start.z + dir.z * f);
        const s = (0.75 - 0.1 * i) * (0.4 + 0.6 * k);
        b.scale.set(0.7 * s, 0.9 * s, 1);
      });
      light.position.set(start.x + dir.x * L * 0.5, start.y + dir.y * L * 0.5, start.z + dir.z * L * 0.5);
      light.intensity = (8 + 5 * Math.sin(t * 37) + 3 * Math.sin(t * 13)) * k;
      sparkT += dt;
      if (sparkT > 0.03) {
        sparkT = 0;
        const hx = start.x + dir.x * L, hy = start.y + dir.y * L, hz = start.z + dir.z * L;
        for (let i = 0; i < (cut ? 3 : 1); i++) SS.fx.spark(hx, hy, hz);
        if (cut && Math.random() < 0.3) SS.fx.dust(hx, hy + 0.2, hz, 1, 0.35, 0x2a2622);
      }
    } else {
      torch.visible = false; light.intensity = 0;
      if (tu.bills.length) {
        for (const b of tu.bills) SS.bodyView.unflame(b);
        tu.bills.length = 0;
      }
    }
    // ----- the laser sight -----
    hit = null; laser.visible = laserRing.visible = false;
    const human = a && !a.dead && S.phase === 'play' && !SS.game.is_cpu(S, a.team);
    if (human && a.skills && a.skills.laser > 0 && SS.skills.is_bullet(S.weapon) && !S.rope) {
      const out = WV._out || (WV._out = {});
      SS.skills.laser_path(S, a, S.weapon, out);
      const pts = out.pts, n = pts.length / 3, pos = laser.geometry.attributes.position.array;
      let m = 0;
      // dots every ~0.32 m along the polyline (the path is a straight segment or a sampled curve)
      let carry = 0;
      for (let i = 1; i < n && m < 2190; i++) {
        const x0 = pts[i * 3 - 3],
          y0 = pts[i * 3 - 2],
          z0 = pts[i * 3 - 1],
          x1 = pts[i * 3],
          y1 = pts[i * 3 + 1],
          z1 = pts[i * 3 + 2],
          L = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
        if (L < 1e-4) continue;
        for (let s = carry; s < L && m < 2190; s += 0.36) {
          const f = s / L;
          pos[m * 3] = x0 + (x1 - x0) * f;
          pos[m * 3 + 1] = y0 + (y1 - y0) * f;
          pos[m * 3 + 2] = z0 + (z1 - z0) * f;
          m++;
          carry = s + 0.36 - L;
        }
        carry = Math.max(0, carry);
      }
      laser.geometry.setDrawRange(0, m); laser.geometry.attributes.position.needsUpdate = true; laser.visible = m > 1;
      if (out.hit) {
        hit = out.hit;
        laserRing.visible = true;
        laserRing.position.set(out.hit.x, out.hit.y, out.hit.z);
        laserRing.material.rotation = t * 2;
        laserRing.material.color.setHex(out.hit.kind === 'worm' ? 0xff9a2a : 0xff3a24);
      }
    }
  };
  const M_clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
})(window.SS = window.SS || {});
