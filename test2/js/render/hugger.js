/* render/hugger.js — the face hugger (P47): eggs-to-face life cycle of a procedural creature. Presentation only
 * (Math.random is fine); it reads
 * the sim's S.alien.huggers (sim/alien.js) every frame.
 *   model    a ribbed leathery carapace (a displaced sphere: transverse ribs, a dorsal crest, vein texture, wet
 *            clear-coat), eight finger legs
 *            (nine beads each, knuckles at the joints, a claw tip), a long tapering tail (16 beads). Legs and tail are
 *            two InstancedMeshes (cylinders + beads), their poses are POINT LISTS blended between: run (a crab-like
 *            gait), leap (reaching forward), grip (the fingers clasp the worm's head), dead (curled up on its back),
 *            emerge (unfolding).
 *   on the face   while the sim says st 3 the whole creature is a CHILD of the worm's body group (render/actors.js
 *   v.body), placed from the
 *            live head frame (v.af, written by SS.alienView.worm_post from the soft body's spine): the carapace lies on
 *            the face side of the head ball, the fingers run along meridians of that ball (so they cannot float), the
 *            tail winds round the neck samples. It follows every wobble, turn, jump and knock because it lives in the
 *            same space as the skin; it is visible exactly when the worm is (section rules), never a loose object in
 *            the air. If the worm is not drawn (off section) nothing of the hugger is drawn.
 *   leap     the sim's guided arc, bent onto the real face (the sim only knows the disc centre) during the last 45 % of
 *            the flight.
 *   let go   the creature pops off the face (a hop in world space), flips on its back, curls up and lies dead; after a
 *   while it shrinks away.
 * P47b look: Alien-style pale ochre skin with dark ribbed segments (vertex colours), a wet clear-coat, dark ink hulls
 *   (silhouette against the bright sky), a thin pulsing lime fresnel rim (onBeforeCompile on the standard material:
 *   pops against dark soil and in the night biome), breathing air sacs, SC = 1.4 times bigger than the first version,
 *   thicker finger legs that wrap right round the head ball, a tail wound twice round the neck, a smear trail on the
 * leap. Materials (all built-in MeshPhysical / MeshStandard / MeshBasic, so the automatic section clipping covers
 * them): body, limb, claw, sac, ink. */
(function (SS) {
  'use strict';
  const T = window.THREE, AV = SS.alienView = SS.alienView || {};
  const K = () => SS.alien.K;
  let M_BODY = null, M_LIMB = null, M_CLAW = null, M_SAC = null, M_INK = null, M_SMEAR = null, G = null;
  const SC = 1.4, FREE = 1.22, INK = 0.0085, RIM = { uRim: { value: 0.5 }, uRimCol: { value: new T.Color(0xaaff3a) } };
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sm = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  /* ---------- resources ---------- */
  function veinTexture() {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#d8c090'; g.fillRect(0, 0, 256, 128);
    let s = 7;
    const r = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 700; i++) {
      g.fillStyle = `rgba(${150 + r() * 60 | 0},${110 + r() * 50 | 0},${80 + r() * 40 | 0},0.10)`;
      g.beginPath();
      g.arc(r() * 256, r() * 128, 2 + r() * 7, 0, 6.3);
      g.fill();
    }
    g.lineCap = 'round';
    for (let i = 0; i < 46; i++) {                                // branching veins
      let x = r() * 256, y = r() * 128, a = r() * 6.3;
      const w = 1 + r() * 1.6;
      for (let k = 0; k < 14; k++) {
        g.strokeStyle = `rgba(150,70,70,${0.22 - k * 0.012})`;
        g.lineWidth = w * (1 - k / 18);
        g.beginPath();
        g.moveTo(x, y);
        a += (r() - 0.5) * 0.9;
        x += Math.cos(a) * 9;
        y += Math.sin(a) * 9;
        g.lineTo(x, y);
        g.stroke();
        if (r() < 0.12) {
          const b = a + (r() - 0.5) * 2;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x + Math.cos(b) * 12, y + Math.sin(b) * 12);
          g.stroke();
        }
      }
    }
    const t = new T.CanvasTexture(c);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  }
  // a ribbed ellipsoid: transverse ribs, a dorsal crest, a pinched rear; vertex colours = dark valleys between pale
  // ribs
  function bodyGeometry() {
    const g = new T.SphereGeometry(1, 56, 28),
      p = g.attributes.position,
      A = 0.15 * SC,
      B = 0.058 * SC * 1.12,
      Cz = 0.115 * SC,
      col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const rr = Math.abs(Math.sin(x * 11)),
        rib = Math.pow(rr, 0.6) * 0.09,
        crest = Math.exp(-z * z * 9) * Math.max(0, y) * 0.5,
        pinch = x < -0.6 ? 1 - 0.28 * (-0.6 - x) : 1;
      const k = 1 + rib * Math.max(0, y) + crest * 0.25;
      x = x * A; y = y * B * k * (1 + 0.15 * Math.max(0, y)); z = z * Cz * pinch;
      if (y < 0) y *= 0.7;
      p.setXYZ(i, x, y, z);
      const top = Math.min(1, Math.max(0, 0.35 + 1.1 * Math.max(0, p.getY(i) / B))),
        ridge = Math.pow(rr, 1.4),
        t = Math.min(1, (0.25 + 0.75 * ridge) * (0.55 + 0.45 * top));
      col[i * 3] = 0.16 + 0.84 * t; col[i * 3 + 1] = 0.09 + 0.88 * t; col[i * 3 + 2] = 0.03 + 0.72 * t;
    }
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.computeVertexNormals(); return g;
  }
  /* a lime fresnel rim added to the emission of a standard material (the built-in section clipping stays: only the
   * emissive chunk is extended) */
  function rimmed(m) {
    m.onBeforeCompile = sh => {
      sh.uniforms.uRim = RIM.uRim; sh.uniforms.uRimCol = RIM.uRimCol;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uRim;\nuniform vec3 uRimCol;')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n{ float fr = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0); totalEmissiveRadiance += uRimCol * fr * uRim; }'
        );
    };
    m.customProgramCacheKey = () => 'hugrim';
    return m;
  }
  function res() {
    if (G) return;
    G = {
      body: bodyGeometry(),
      cyl: new T.CylinderGeometry(1, 1, 1, 7),
      sph: new T.SphereGeometry(1, 8, 6),
      claw: new T.ConeGeometry(1, 1, 6)
    };
    G.cyl.translate(0, 0.5, 0); G.claw.translate(0, 0.5, 0);
    M_BODY = rimmed(
      new T.MeshPhysicalMaterial({
        map: veinTexture(),
        vertexColors: true,
        color: 0xdcaa4c,
        roughness: 0.34,
        metalness: 0,
        clearcoat: 0.8,
        clearcoatRoughness: 0.1,
        sheen: 0.2,
        sheenColor: new T.Color(0xffe8b0),
        sheenRoughness: 0.5,
        emissive: 0x2c1c08
      })
    );
    M_LIMB = rimmed(
      new T.MeshPhysicalMaterial({
        color: 0xd4a450,
        roughness: 0.34,
        clearcoat: 0.8,
        clearcoatRoughness: 0.14,
        sheen: 0.2,
        sheenColor: new T.Color(0xffe8b0),
        emissive: 0x2c1c08
      })
    );
    M_CLAW = new T.MeshStandardMaterial({ color: 0x5a3f22, roughness: 0.3, emissive: 0x1c1206 });
    M_SAC = rimmed(
      new T.MeshPhysicalMaterial({
        color: 0xf2b894, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08, emissive: 0x6a2a14, transmission: 0
      })
    );
    M_INK = new T.MeshBasicMaterial({ color: 0x120a04, side: T.BackSide });
    M_SMEAR = new T.MeshBasicMaterial({
      color: 0xe8ffb0,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      blending: T.AdditiveBlending
    });
    for (const m of [M_BODY, M_LIMB, M_CLAW, M_SAC, M_INK, M_SMEAR]) m.userData.shared = true;
  }

  /* ---------- build ---------- */
  const NL = 9, NT = 16, MAXI = 8 * (NL - 1) + (NT - 1) + 2, MAXB = 8 * NL + NT + 2, NG = 10;
  AV.hugMake = function (root) {
    res();
    const g = new T.Group(), rig = new T.Group();
    g.add(rig);
    const body = new T.Mesh(G.body, M_BODY);
    body.castShadow = true;
    rig.add(body);
    const hull = new T.Mesh(G.body, M_INK);
    hull.scale.set(1.045, 1.09, 1.06);
    rig.add(hull);
    const segs = new T.InstancedMesh(G.cyl, M_LIMB, MAXI),
      balls = new T.InstancedMesh(G.sph, M_LIMB, MAXB),
      claws = new T.InstancedMesh(G.claw, M_CLAW, 8);
    const iSegs = new T.InstancedMesh(G.cyl, M_INK, MAXI), iBalls = new T.InstancedMesh(G.sph, M_INK, MAXB);
    for (const m of [segs, balls, claws, iSegs, iBalls]) {
      m.frustumCulled = false;
      m.castShadow = m !== iSegs && m !== iBalls;
      m.count = 0;
      rig.add(m);
    }
    balls.setColorAt(0, new T.Color(1, 1, 1)); claws.setColorAt(0, new T.Color(1, 1, 1));
    // two air sacs on the back of the carapace (they swell and sink: the creature breathes) and a pale proboscis under
    // the front
    const sacs = [];
    for (let i = 0; i < 2; i++) {
      const m = new T.Mesh(G.sph, M_SAC);
      m.position.set(-0.11 * SC, 0.05 * SC, (i ? -1 : 1) * 0.062 * SC);
      m.castShadow = true;
      rig.add(m);
      sacs.push(m);
    }
    const prob = new T.Mesh(G.cyl, M_LIMB);
    prob.scale.set(0.02, 0.14, 0.02);
    prob.position.set(0.14, -0.04, 0);
    prob.rotation.z = 2.2;
    rig.add(prob);
    // the smear of a leap: stretched pale ghosts of the last positions (drawn in the rig's frame)
    const ghosts = new T.InstancedMesh(G.sph, M_SMEAR, NG);
    ghosts.frustumCulled = false;
    ghosts.count = 0;
    rig.add(ghosts);
    root.add(g);
    const legs = [];
    for (let i = 0; i < 8; i++) legs.push({ side: i < 4 ? 1 : -1, k: i & 3, p: [], tip: new T.Vector3(), dir: new T.Vector3() });
    for (const L of legs)
      for (let j = 0; j < NL; j++) L.p.push(new T.Vector3());
    const tail = [];
    for (let j = 0; j < NT; j++) tail.push(new T.Vector3());
    return {
      g,
      rig,
      body,
      hull,
      sacs,
      iSegs,
      iBalls,
      ghosts,
      hist: [],
      segs,
      balls,
      claws,
      prob,
      legs,
      tail,
      ph: Math.random() * 6.28,
      mode: 'run',
      gripT: 0,
      prev: null,
      pitch: 0,
      hold: 0,
      fall: null,
      dropT: -1,
      tilt: 0,
      vis: true,
      parent: root
    };
  };

  /* ---------- poses: point lists in the rig's frame (x forward, y up, z side) ---------- */
  const v3 = new T.Vector3();
  const HIP = k => 0.075 - 0.05 * k;
  const scl = (out, n) => {
    for (let j = 0; j < n; j++) out[j].multiplyScalar(SC);
  };
  function bez(out, j, n, H, Kp, F) {                                    // a curve through H, ~Kp (the knee), F: out[j] for j = 0..n-1
    const t = j / (n - 1), a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
    out.set(
      a * H.x + b * (2 * Kp.x - 0.5 * (H.x + F.x)) + c * F.x,
      a * H.y + b * (2 * Kp.y - 0.5 * (H.y + F.y)) + c * F.y,
      a * H.z + b * (2 * Kp.z - 0.5 * (H.z + F.z)) + c * F.z
    );
  }
  const H = new T.Vector3(), Kn = new T.Vector3(), F = new T.Vector3(), tmp = new T.Vector3();
  function poseRun(L, ph, run, out) {
    const k = L.k, s = L.side, ay = 0.7 - 0.45 * k, dx = Math.sin(ay), dz = s * Math.cos(ay);
    H.set(HIP(k), 0, s * 0.085);
    const sw = Math.sin(ph), lift = Math.max(0, Math.cos(ph)) * 0.055 * run;
    F.set(HIP(k) + dx * 0.3 + sw * 0.075 * run, -0.092 + lift, s * 0.085 + dz * 0.3);
    Kn.set(HIP(k) + dx * 0.16 + sw * 0.03 * run, 0.045 + lift * 0.8, s * 0.085 + dz * 0.16);
    for (let j = 0; j < NL; j++) bez(out[j], j, NL, H, Kn, F);
  }
  function poseLeap(L, spread, out) {
    const k = L.k, s = L.side, a = 0.3 + 0.2 * k + 0.25 * spread, dx = Math.cos(a), dz = s * Math.sin(a);
    H.set(HIP(k), 0, s * 0.085);
    F.set(HIP(k) + dx * 0.4, 0.035 - 0.012 * k, s * 0.085 + dz * 0.4);
    Kn.set(HIP(k) + dx * 0.19, 0.075, s * 0.085 + dz * 0.19);
    for (let j = 0; j < NL; j++) bez(out[j], j, NL, H, Kn, F);
  }
  // legs drawn up over the belly (the rig is flipped on its back: -y is the belly side, up in the world)
  function poseDead(L, out) {
    const k = L.k, s = L.side, ay = 0.7 - 0.45 * k, dx = Math.sin(ay), dz = s * Math.cos(ay);
    H.set(HIP(k), 0, s * 0.085);
    F.set(HIP(k) * 0.5 + 0.02 * (k - 1.5), -0.15 - 0.015 * k, s * 0.045);
    Kn.set(HIP(k) + dx * 0.15, -0.1, s * 0.085 + dz * 0.15);
    for (let j = 0; j < NL; j++) bez(out[j], j, NL, H, Kn, F);
  }
  /* the fingers clasp the head ball: meridians of the sphere about the face axis y; c = the sphere centre (rig frame),
   * R its radius */
  function poseGrip(L, R, sq, out) {
    const k = L.k,
      s = L.side,
      phi = s > 0 ? Math.PI / 2 - (1.02 - 0.68 * k) : -Math.PI / 2 + (1.02 - 0.68 * k),
      th0 = 0.45,
      th1 = k === 0 ? 2.25 : k === 3 ? 2.6 : 2.8,
      Rg = R * (1.0 - 0.02 * sq) + 0.036;
    const cx = Math.cos(phi), cz = Math.sin(phi), sy = -0.9 * R;
    for (let j = 0; j < NL; j++) {
      const u = j / (NL - 1),
        th = th0 + (th1 - th0) * u,
        kn = 1 + 0.07 * Math.exp(-Math.pow((u - 0.34) / 0.07, 2)) + 0.07 * Math.exp(-Math.pow((u - 0.68) / 0.07, 2));
      const r = Rg * kn, st = Math.sin(th);
      out[j].set(st * cx * r, sy + Math.cos(th) * r, st * cz * r);
    }
    // the first point is the hip on the carapace rim
    out[0].set(HIP(k) * SC, 0, s * 0.085 * SC);
    out[1].lerp(tmp.set(out[1].x * 0.5 + out[0].x * 0.5, out[1].y * 0.6 + out[0].y * 0.4, out[1].z * 0.6 + out[0].z * 0.4), 0.5);
  }
  function tailFree(o, t, kind, out) {                                  // a whip trailing behind
    const run = kind.run, lift = kind.lift;
    for (let j = 0; j < NT; j++) {
      const u = j / (NT - 1),
        x = -0.15 - u * 0.62 * (kind.curl ? 0.55 : 1),
        w = Math.sin(t * 7 - u * 6.5 + o.ph) * (0.03 + 0.09 * run) * u * 1.6;
      let y = 0.01 + lift * u * u * 0.3 + (kind.curl ? Math.sin(u * 4) * 0.08 : 0) - (kind.rest ? 0.045 * (1 - Math.exp(-u * 3)) : 0);
      let z = w + (kind.curl ? Math.cos(u * 4.5) * 0.09 * u : 0);
      out[j].set(x * SC, y * SC, z * SC);
    }
  }

  /* ---------- drawing the limbs from point lists ---------- */
  const q0 = new T.Quaternion(),
    m4 = new T.Matrix4(),
    q4 = new T.Quaternion(),
    sc3 = new T.Vector3(),
    up3 = new T.Vector3(0, 1, 0),
    pp = new T.Vector3(),
    dd = new T.Vector3();
  let ni = 0, nb = 0, nc = 0;
  const cc = new T.Color();
  function addBall(o, p, r, dark) {
    if (nb >= MAXB) return;
    sc3.set(r, r, r);
    m4.compose(p, q4.identity(), sc3);
    o.balls.setMatrixAt(nb, m4);
    sc3.set(r + INK, r + INK, r + INK); m4.compose(p, q4.identity(), sc3); o.iBalls.setMatrixAt(nb, m4);
    const d = dark || 0;
    cc.setRGB(1 - 0.5 * d, 1 - 0.58 * d, 1 - 0.7 * d);
    o.balls.setColorAt(nb, cc);
    nb++;
  }
  function addSeg(o, a, b, r) {
    if (ni >= MAXI) return;
    dd.subVectors(b, a);
    const l = dd.length();
    if (l < 1e-5) return;
    q4.setFromUnitVectors(up3, dd.multiplyScalar(1 / l));
    sc3.set(r, l, r);
    m4.compose(a, q4, sc3);
    o.segs.setMatrixAt(ni, m4);
    sc3.set(r + INK, l, r + INK);
    m4.compose(a, q4, sc3);
    o.iSegs.setMatrixAt(ni, m4);
    ni++;
  }
  function drawLimb(o, pts, n, r0, r1, knuckle, claw) {
    for (let j = 0; j < n; j++) {
      const u = j / (n - 1),
        r = r0 + (r1 - r0) * u,
        kb = knuckle ? 1 + 0.35 * (Math.exp(-Math.pow((u - 0.34) / 0.05, 2)) + Math.exp(-Math.pow((u - 0.68) / 0.05, 2))) : 1;
      addBall(o, pts[j], r * kb * 1.02, kb > 1.12 ? Math.min(1, (kb - 1) * 3) : (j === n - 1 ? 0.7 : 0));
      if (j < n - 1) addSeg(o, pts[j], pts[j + 1], r * 0.98);
    }
    if (claw) {                                                         // a hooked claw continuing the last segment
      const a = pts[n - 2], b = pts[n - 1];
      dd.subVectors(b, a).normalize();
      q4.setFromUnitVectors(up3, dd);
      sc3.set(r1 * 1.25, 0.09, r1 * 1.25);
      m4.compose(b, q4, sc3);
      o.claws.setMatrixAt(nc++, m4);
    }
  }

  /* ---------- the face frame of a worm (body-local, from render/infect.js worm_post) ---------- */
  const FACE = { ok: false, ox: 0, oy: 0, a: 0, R: 0.13 };
  function faceFrame(af) {
    if (!af) return false;
    const R = af.R, a = af.ca, nx = -Math.sin(a), ny = Math.cos(a);
    FACE.ox = af.cx + nx * R * 0.88;
    FACE.oy = af.cy + ny * R * 0.88;
    FACE.a = a;
    FACE.R = R;
    return true;
  }
  /* the neck samples (body-local) -> rig-local, for the tail's turns round the neck */
  function tailWrap(af, out) {
    const ca = Math.cos(-FACE.a), sa = Math.sin(-FACE.a), M_ = af.nn, turns = 2.2;
    for (let j = 0; j < NT; j++) {
      const u = j / (NT - 1), f = u * (M_ - 1), i0 = Math.min(M_ - 2, Math.floor(f)), w = f - i0;
      const cx = af.nx[i0] + (af.nx[i0 + 1] - af.nx[i0]) * w,
        cy = af.ny[i0] + (af.ny[i0 + 1] - af.ny[i0]) * w,
        ang = af.na[i0] + (af.na[i0 + 1] - af.na[i0]) * w,
        r = af.nr[i0] + (af.nr[i0 + 1] - af.nr[i0]) * w + 0.022;
      const psi = 0.4 + turns * 6.2832 * u, nxl = -Math.sin(ang), nyl = Math.cos(ang), cp = Math.cos(psi), sp = Math.sin(psi);
      const bx = cx + nxl * r * cp - FACE.ox, by = cy + nyl * r * cp - FACE.oy;
      out[j].set(bx * ca - by * sa, bx * sa + by * ca, sp * r * 1.04);
    }
    // the root of the tail leaves the carapace's rear
    for (let j = 0; j < 3; j++) {
      const k = 1 - j / 3;
      out[j].x += (-0.15 * SC - out[j].x) * k * 0.6;
      out[j].y += (0 - out[j].y) * k * 0.6;
      out[j].z += (0 - out[j].z) * k * 0.6;
    }
  }

  /* ---------- per frame ---------- */
  const PL = [], PT = [];
  for (let i = 0; i < 4; i++) {
    PL.push([]);
    for (let j = 0; j < NL; j++) PL[i].push(new T.Vector3());
  }
  for (let j = 0; j < NT; j++) PT.push(new T.Vector3());
  const TA = [], TB = [];
  for (let j = 0; j < NT; j++) {
    TA.push(new T.Vector3());
    TB.push(new T.Vector3());
  }
  const worldPos = new T.Vector3(),
    worldQ = new T.Quaternion(),
    basis = new T.Matrix4(),
    ex = new T.Vector3(),
    ey = new T.Vector3(),
    ez = new T.Vector3();
  /* world transform of the attach pose for a host view v: the rig origin and orientation (null when the host is not
   * drawn) */
  AV.hugFacePose = function (v, outPos, outQ) {
    if (!v || !v.af || !faceFrame(v.af)) return false;
    v.root.updateMatrixWorld(true);
    outPos.set(FACE.ox, FACE.oy, 0).applyMatrix4(v.body.matrixWorld);
    v.body.getWorldQuaternion(outQ); q4.setFromAxisAngle(new T.Vector3(0, 0, 1), FACE.a); outQ.multiply(q4);
    return true;
  };

  /* hugger h (sim) drawn into o; ctx = { host view (or null), hostVisible, clock, root } */
  AV.hugFrame = function (S, h, o, dt, clock, hv, root) {
    const KK = K(), g = o.g, rig = o.rig;
    let mode = h.st === 0 ? 'emerge' : h.st === 1 ? 'run' : h.st === 2 ? 'leap' : h.st === 3 ? 'grip' : 'dead';
    // ---- the host's face: only a hugger on a face needs the worm view
    const onFace = h.st === 3 && !!(hv && hv.af);
    // ---- parent: the worm's body while on the face, else the scene root
    const wantParent = onFace ? hv.body : root;
    // capture the world pose when leaving a face (the drop / hop starts from there)
    if (o.parent !== wantParent) {
      if (o.parent !== root && wantParent === root) {                    // let go: from the face into the world
        g.updateWorldMatrix(true, false); g.matrixWorld.decompose(worldPos, worldQ, sc3);
        o.parent.remove(g);
        root.add(g);
        g.position.copy(worldPos);
        g.quaternion.copy(worldQ);
        g.scale.setScalar(1);
        o.fall = {
          x: worldPos.x,
          y: worldPos.y,
          z: worldPos.z,
          vy: 2.4,
          vx: 0,
          vz: 0,
          t: 0,
          q: worldQ.clone(),
          spin: rnd(-6, 6),
          land: false
        };
        o.dropT = clock;
      } else {
        o.parent.remove(g);
        wantParent.add(g);
      }
      o.parent = wantParent;
    }
    // (on a face: exactly as visible as the worm; a face whose worm has no view yet: not drawn)
    g.visible = o.parent === root ? h.st !== 3 : hv.root.visible;
    // (a replay restore can bring a dead one back to life)
    if (mode !== 'dead') {
      o.fall = null;
      o.hold = 0;
    }
    if (mode !== 'grip') o.gripT = 0;
    // ---- weights of the poses
    let wRun = 0, wLeap = 0, wGrip = 0, wDead = 0, run = 0, spread = 0, curlTail = false, stretch = 1;
    const age = S.time - h.t0;
    if (mode === 'emerge') {
      const u = Math.min(1, age / KK.EMERGE_T);
      g.position.set(h.x, h.y - 0.34 * (1 - sm(0, 0.8, u)) + 0.22 * Math.sin(Math.min(1, u * 1.25) * Math.PI), h.z);
      g.rotation.set(0, -h.yaw, 0);
      g.scale.setScalar(0.55 + 0.45 * sm(0, 0.7, u));
      wLeap = 1 - sm(0.2, 0.9, u);
      wRun = sm(0.2, 0.9, u);
      run = 0.35;
      rig.rotation.set(0, 0, 0);
      spread = 0.5 * (1 - u);
    } else if (mode === 'run') {
      // heading, a smoothed pitch from the climb, the gait
      const pv = o.prev;
      let sp = 0, pit = 0;
      if (pv) {
        const dx = h.x - pv.x, dy = h.y - pv.y, dz = h.z - pv.z, hl = Math.hypot(dx, dz);
        sp = hl / Math.max(1e-3, dt);
        pit = hl > 1e-4 ? Math.atan2(dy, hl) : 0;
      }
      o.pitch += (pit - o.pitch) * Math.min(1, dt * 10);
      run = Math.min(1, sp / 2.4); wRun = 1; o.gait = (o.gait || 0) + dt * (6 + 12 * run);
      g.scale.setScalar(FREE);
      g.position.set(h.x, h.y + 0.02 * run * Math.abs(Math.sin(o.gait * 1.0)), h.z);
      g.rotation.set(0, -h.yaw, 0);
      rig.rotation.set(Math.sin(o.gait * 2) * 0.07 * run, Math.sin(o.gait) * 0.16 * run, o.pitch);
    } else if (mode === 'leap') {
      const u = Math.min(1, (S.time - h.t) / KK.LEAP_T), vel = v3.set(h.vx, h.vy, h.vz), sp = vel.length() || 1;
      g.scale.setScalar(FREE); g.position.set(h.x, h.y, h.z);
      // closing onto the real face over the last part of the flight
      let tgt = null;
      if (hv && hv.af && AV.hugFacePose(hv, worldPos, worldQ)) tgt = worldPos;
      ex.copy(vel).multiplyScalar(1 / sp);
      ey.set(0, 1, 0).addScaledVector(ex, -ex.y);
      if (ey.lengthSq() < 1e-4) ey.set(0, 0, 1);
      ey.normalize();
      ez.crossVectors(ex, ey);
      basis.makeBasis(ex, ey, ez); q4.setFromRotationMatrix(basis); g.quaternion.copy(q4);
      if (tgt) {
        // (the sim's goal vs the drawn face: the offset closes with k)
        const k = sm(0.5, 1, u), S0 = AV.hugLeapGoal(S, h, hv);
        if (S0) {
          g.position.x += (tgt.x - S0.x) * k;
          g.position.y += (tgt.y - S0.y) * k;
          g.position.z += (tgt.z - S0.z) * k;
        }
        g.quaternion.slerp(worldQ, k * k);
      }
      wLeap = 1;
      spread = 0.5 + 0.5 * Math.sin(u * Math.PI);
      rig.rotation.set(0, 0, 0);
      run = 0.4;
      stretch = 1 + 0.35 * Math.sin(Math.min(1, u * 1.2) * Math.PI);
    } else if (mode === 'grip') {
      if (onFace) {
        faceFrame(hv.af);
        g.position.set(FACE.ox, FACE.oy, 0);
        g.rotation.set(0, 0, FACE.a);
        g.scale.setScalar(1);
        rig.rotation.set(0, 0, 0);
        o.gripT = Math.min(1, (o.gripT || 0) + dt / 0.22); wGrip = sm(0, 1, o.gripT); wLeap = 1 - wGrip;
      }
    } else {                                                           // dead / falling
      wDead = 1; curlTail = true;
      if (o.fall) {
        const f = o.fall;
        f.t += dt;
        if (!f.land) {
          f.vy -= 9.81 * dt;
          f.x += f.vx * dt;
          f.y += f.vy * dt;
          f.z += f.vz * dt;
          const gy = h.y;                                              // (the sim put the dead creature on the ground)
          if (f.y <= gy && f.vy < 0) {
            f.y = gy;
            f.land = true;
            f.vy = 0;
            o.landT = clock;
          }
          q4.setFromAxisAngle(ez.set(0.3, 0.2, 1).normalize(), f.spin * dt); f.q.premultiply(q4);
          g.position.set(f.x, f.y, f.z); g.quaternion.copy(f.q); g.scale.setScalar(1);
        } else {
          // settle onto the back: ease the orientation to belly-up facing the old heading
          const yaw = Math.atan2(2 * (f.q.w * f.q.y + f.q.x * f.q.z), 1 - 2 * (f.q.y * f.q.y + f.q.z * f.q.z));
          q4.setFromEuler(new T.Euler(Math.PI, yaw, 0)); g.quaternion.slerp(q4, Math.min(1, dt * 9)); g.position.set(f.x, h.y + 0.02, f.z);
        }
        rig.rotation.set(0, 0, 0);
      } else {
        if (!o.fall && o.hold === 0) {
          o.hold = 1;
          o.flipT = clock;
        }
        const fl = sm(0, 0.35, clock - (o.flipT || clock));
        g.position.set(h.x, h.y + 0.03 + 0.05 * Math.sin(fl * Math.PI), h.z);
        g.rotation.set(Math.PI * fl, -h.yaw, 0);
        g.scale.setScalar(1);
        rig.rotation.set(0, 0, 0);
      }
      // shrinks away at the end of its time lying there
      const left = KK.DEAD_T - (S.time - h.t0);
      if (left < 3) g.scale.setScalar(Math.max(0.01, left / 3));
      // a last twitch
      if (S.time - h.t0 < 0.8) rig.position.y = 0;
      else rig.position.y = 0;
    }
    // ---- breathing: the carapace and the air sacs swell and sink (slow on a face, quick when it runs), a thin lime
    // rim pulses
    {
      const br = Math.sin(clock * (mode === 'grip' ? 3.3 : mode === 'run' ? 11 : 6) + o.ph),
        bs = 0.5 + 0.5 * br,
        sk = mode === 'grip' ? 1 : 0.5;
      o.body.scale.set(1 - 0.012 * br * sk, 1 + 0.07 * br * sk, 1 + 0.035 * br * sk);
      o.hull.scale.set(1.045 - 0.012 * br * sk, 1.09 + 0.07 * br * sk, 1.06 + 0.035 * br * sk);
      for (let i = 0; i < 2; i++) {
        const q = 0.85 + 0.42 * (0.5 + 0.5 * Math.sin(clock * (mode === 'grip' ? 3.3 : 9) + o.ph + i * 1.3)), a = 0.052 * SC;
        o.sacs[i].scale.set(a * 1.15 * q, a * 0.8 * q, a * q);
      }
      RIM.uRim.value = 0.9 + 0.7 * (0.5 + 0.5 * Math.sin(clock * 3.1)); M_SAC.emissive.setRGB(0.3 + 0.2 * bs, 0.12 + 0.06 * bs, 0.06);
      if (mode !== 'grip') {
        rig.scale.set(stretch, 1 / Math.sqrt(stretch), 1 / Math.sqrt(stretch));
      } else rig.scale.set(1, 1, 1);
    }
    // ---- the limbs
    ni = nb = nc = 0;
    const ph = o.gait || 0, R = onFace ? FACE.R : 0.13;
    for (let li = 0; li < 8; li++) {
      const L = o.legs[li], out = L.p, ph2 = ph + L.k * 1.9 + (L.side > 0 ? 0 : Math.PI);
      for (let j = 0; j < NL; j++) out[j].set(0, 0, 0);
      let wsum = 0;
      const acc = (fn, wt) => {
        if (wt <= 0.001) return;
        fn(PL[0]);
        for (let j = 0; j < NL; j++) out[j].addScaledVector(PL[0][j], wt);
        wsum += wt;
      };
      acc(p => {
        poseRun(L, ph2, run, p);
        scl(p, NL);
      }, wRun);
      acc(p => {
        poseLeap(L, spread, p);
        scl(p, NL);
      }, wLeap);
      acc(p => poseGrip(L, R, 0.5 + 0.5 * Math.sin(clock * 3 + L.k), p), wGrip);
      acc(p => {
        poseDead(L, p);
        scl(p, NL);
      }, wDead);
      if (wsum > 0)
        for (let j = 0; j < NL; j++) out[j].multiplyScalar(1 / wsum);
      drawLimb(o, out, NL, (0.024 - 0.002 * L.k) * SC, 0.012 * SC, true, true);
    }
    // ---- the tail
    {
      const tt = clock, T0 = TA, T1 = TB;
      let wt = 0;
      for (let j = 0; j < NT; j++) PT[j].set(0, 0, 0);
      const addT = (arr, w) => {
        if (w <= 0.001) return;
        for (let j = 0; j < NT; j++) PT[j].addScaledVector(arr[j], w);
        wt += w;
      };
      const free = wRun + wLeap + wDead;
      if (free > 0.001) {
        tailFree(
          o,
          tt,
          { run: wRun * run, lift: wLeap * 1.2 + (mode === 'leap' ? 0.5 : 0), curl: curlTail, rest: wRun > 0.5 && run < 0.2 },
          T0
        );
        addT(T0, free);
      }
      if (wGrip > 0.001 && onFace) {
        tailWrap(hv.af, T1);
        addT(T1, wGrip);
      }
      if (wt > 0)
        for (let j = 0; j < NT; j++) PT[j].multiplyScalar(1 / wt);
      for (let j = 0; j < NT; j++) {
        const u = j / (NT - 1), r = (0.026 * (1 - u) + 0.008) * (1 + 0.12 * Math.sin(u * 40));
        addBall(o, PT[j], r * 1.05, 0);
        if (j < NT - 1) addSeg(o, PT[j], PT[j + 1], r);
      }
    }
    o.segs.count = o.iSegs.count = ni; o.balls.count = o.iBalls.count = nb; o.claws.count = nc;
    o.segs.instanceMatrix.needsUpdate =
      o.balls.instanceMatrix.needsUpdate =
      o.claws.instanceMatrix.needsUpdate = o.iSegs.instanceMatrix.needsUpdate = o.iBalls.instanceMatrix.needsUpdate = true;
    if (o.balls.instanceColor) o.balls.instanceColor.needsUpdate = true;
    // ---- the smear of a leap: ghosts of the last positions, stretched along the flight
    {
      let ng = 0;
      if (mode === 'leap') {
        o.hist.unshift(g.position.x, g.position.y, g.position.z);
        if (o.hist.length > NG * 3) o.hist.length = NG * 3;
        q4.copy(g.quaternion).invert();
        for (let i = 1; i < o.hist.length / 3; i++) {
          v3.set(o.hist[i * 3] - g.position.x, o.hist[i * 3 + 1] - g.position.y, o.hist[i * 3 + 2] - g.position.z).applyQuaternion(q4);
          const f = 1 - i / NG, sz = 0.16 * f * SC;
          sc3.set(sz * 1.6, sz * 0.38, sz * 0.7);
          pp.copy(v3);
          m4.compose(pp, q0.identity(), sc3);
          o.ghosts.setMatrixAt(ng++, m4);
        }
        M_SMEAR.opacity = 0.34;
      } else o.hist.length = 0;
      o.ghosts.count = ng; o.ghosts.instanceMatrix.needsUpdate = true;
    }
    o.prev = o.prev || { x: 0, y: 0, z: 0 };
    o.prev.x = h.x;
    o.prev.y = h.y;
    o.prev.z = h.z;
    o.mode = mode;
  };
  /* the sim's own goal of a leap (the face point it aimed at) for the drawn-face correction */
  const GOAL = { x: 0, y: 0, z: 0 };
  AV.hugLeapGoal = function (S, h, hv) {
    const o = S.worms[h.host];
    if (!o) return null;
    return SS.alien.face_target(o, GOAL);
  };
})(window.SS = window.SS || {});
