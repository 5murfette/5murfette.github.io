/* render/actors.js — worms, projectiles, graves, the ninja rope and the aim reticle (procedural geometry, Three.js).
 * init(scene, tx, Q) / clear() / sync(S, view, ctxA, insp, dt) / onEvent(S, e) / vis(w), called by render/view.js.
 * Props and rigid bodies are drawn by render/bodies.js. Feedback: a red flash on 'hurt', procedural flames on a worm
 * that is burning (sim.burn stamps w.burnT), shared with render/bodies.js (SS.bodyView.flame/unflame).
 * Porting: one engine prefab per worm / projectile; sync = copy transforms from S each frame. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, M = SS.math;
  const A = SS.actors = {};

  /* P8 (user, 2026-10-07): a real earthworm shaped like the number "2". Seen from the camera (facing -s it reads as
   * "2", facing +s as its mirror image): the tail and the lower body lie on the ground behind, the neck rises from the
   * front of that base leaning back, arcs over the top and the head curls forward and down. A soft tube of NS rings
   * around a spine built by integrating a curvature profile along the body (local frame: x = facing, y = up, z = side,
   * origin = the collision disc centre, ground at y = -0.5); every frame the rings are rebuilt on the CPU:
   *   - peristalsis: contraction waves run head -> tail while crawling (slowly at rest): a contracted ring is thicker
   *     and shorter, so the body parts move one after another (real earthworm locomotion: retrograde waves);
   *   - a slow sway wave travels up the neck; the head follows the aim quickly, the arc behind it slowly;
   *   - airborne / on the rope the curls open (a straighter body); on the ground the base tilts with the slope.
   * Ring annuli (segment grooves) and a team-coloured saddle (clitellum) are in the geometry; original design. */
  // user 2026-10-08: a worm, not a snake: ~38 bulging segments (annuli) along the body, smooth over the saddle
  const NS = 150, NR = 14, SEGS = 38, BODY = (() => {
    // arc lengths (m): tail + base, corner (turns up and back), neck, top arc (turns forward), head
    // (x 0.88: the worm stands ~1 m with its eyes, as the brief's metric scale wants; verify 'scale')
    const seg = [0.74, 0.34, 0.4, 0.56, 0.16].map(v => v * 0.88), L = seg.reduce((a, b) => a + b, 0), k = [0, 2.27 / seg[1], 0, -3.32 / seg[3], 0];
    const u = []; let acc = 0; for (const l of seg) { acc += l; u.push(acc / L); }
    return { L, seg, k, u, uBase: seg[0] / L, uNeck: (seg[0] + seg[1]) / L, uArc: (seg[0] + seg[1] + seg[2]) / L };
  })();
  const smooth01 = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // radius profile along the body (0 = tail tip, 1 = head tip)
  // user 2026-10-07: the lower body is the fattest, most at its front (u ~ 0.36, the corner where the neck rises), and
  // slims steadily back to a thin tail; the neck is slimmer again up to the bulbous head
  function radius(u) {
    const tip = Math.sqrt(Math.min(1, u / 0.035)), head = Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, u - 0.93) / 0.07, 2)));
    const low = 0.042 + 0.138 * Math.pow(smooth01(0, 0.36, u), 0.85);                   // tail 4 cm -> 18 cm at the front
    const body = u < 0.36 ? low : 0.18 - 0.064 * smooth01(0.36, 0.64, u);               // -> 11.6 cm up the neck
    return (body + 0.022 * Math.exp(-Math.pow((u - 0.9) / 0.05, 2))) * tip * head + 0.004;   // bulbous head
  }
  const R_FRONT = 0.18;
  const SADDLE0 = 0.56, SADDLE1 = 0.63;
  // ASSET: worm (docs/ASSET_PROMPTS.md: models/worm.glb, skinned; this procedural tube is the stand-in)
  function makeBody(teamRgb) {
    const g = new T.BufferGeometry(), nv = NS * NR + 2;
    const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), col = new Float32Array(nv * 3), idx = [];
    const skin = new T.Color(0xf5a898), groove = new T.Color(0xd8857a), band = new T.Color(teamRgb), belly = new T.Color(0xfbc9bb);
    for (let i = 0; i < NS; i++) {
      const u = i / (NS - 1), saddle = u > SADDLE0 && u < SADDLE1, ann = Math.pow(Math.abs(Math.sin(u * Math.PI * SEGS)), 0.5);
      for (let j = 0; j < NR; j++) {
        const o = (i * NR + j) * 3, under = Math.max(0, -Math.sin(j / NR * Math.PI * 2));
        const c = saddle ? band.clone().lerp(skin, 0.12) : skin.clone().lerp(groove, (1 - ann) * 0.55).lerp(belly, under * 0.45);
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
    }
    for (const q of [NS * NR, NS * NR + 1]) { col[q * 3] = skin.r; col[q * 3 + 1] = skin.g; col[q * 3 + 2] = skin.b; }
    for (let i = 0; i < NS - 1; i++) for (let j = 0; j < NR; j++) {
      const a = i * NR + j, b = i * NR + (j + 1) % NR, c = a + NR, d = b + NR;
      idx.push(a, c, b, b, c, d);
    }
    for (let j = 0; j < NR; j++) { idx.push(NS * NR, (j + 1) % NR, j); idx.push(NS * NR + 1, (NS - 1) * NR + j, (NS - 1) * NR + (j + 1) % NR); }
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('normal', new T.BufferAttribute(nrm, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.boundingSphere = new T.Sphere(new T.Vector3(0, 0, 0), 1.6);
    return g;
  }
  const SP = { x: new Float32Array(NS), y: new Float32Array(NS), a: new Float32Array(NS), r: new Float32Array(NS) };
  /* the spine for pose p {t, crawl (0..1 wave speed), air (0..1), headD (rad, fast), arcD (rad, slow)} */
  function spine(p) {
    const B = BODY, ds = B.L / (NS - 1), wph = p.wave;
    const kappa = u => {
      let k = 0;
      // piecewise curvature with soft joints
      const e = 0.035;
      k += B.k[1] * smooth01(B.uBase - e, B.uBase + e, u) * (1 - smooth01(B.uNeck - e, B.uNeck + e, u)) * (1 - 0.55 * p.air);
      k += B.k[3] * smooth01(B.uArc - e, B.uArc + e, u) * (1 - smooth01(B.u[3] - e, B.u[3] + e, u)) * (1 - 0.5 * p.air);
      // the aim: the head (fast) and the arc behind it (slow) turn toward it
      k += p.arcD / (B.seg[3] / B.L * B.L) * smooth01(B.uArc - e, B.uArc + e, u) * (1 - smooth01(B.u[3] - e, B.u[3] + e, u));
      k += p.headD / (0.22) * smooth01(0.88, 0.92, u);
      // a slow sway travelling up the neck (parts move one after another)
      k += 0.9 * Math.sin(2 * Math.PI * (u * 1.3 - p.t * 0.22)) * smooth01(B.uBase, 1, u) * (0.6 + 0.4 * (1 - p.crawl)) * (1 - p.air);
      // the tail tip curls up a little
      k += 2.2 * (1 - smooth01(0, 0.07, u)) * (0.4 + 0.6 * p.air);
      return k;
    };
    // integrate from the base's front corner (the anchor) both ways; contracted rings are shorter
    const iC = Math.round(B.uBase * (NS - 1)), bump = u => { const q = Math.sin(2 * Math.PI * (u * 3.2 + wph)); return q > 0 ? q * q : 0; };
    const len = u => ds * (1 - 0.2 * bump(u));
    SP.x[iC] = 0.14; SP.y[iC] = -0.5 + R_FRONT; SP.a[iC] = 0.04 * (1 - p.air);
    for (let i = iC + 1; i < NS; i++) {
      const u = (i - 0.5) / (NS - 1), a = SP.a[i - 1] + kappa(u) * len(u) * 0.5;
      SP.x[i] = SP.x[i - 1] + Math.cos(a) * len(u); SP.y[i] = SP.y[i - 1] + Math.sin(a) * len(u); SP.a[i] = a + kappa(u) * len(u) * 0.5;
    }
    for (let i = iC - 1; i >= 0; i--) {
      const u = (i + 0.5) / (NS - 1), a = SP.a[i + 1] - kappa(u) * len(u) * 0.5;
      SP.x[i] = SP.x[i + 1] - Math.cos(a) * len(u); SP.y[i] = SP.y[i + 1] - Math.sin(a) * len(u); SP.a[i] = a - kappa(u) * len(u) * 0.5;
    }
    // airborne: centre the body on the collision disc (no ground under the base)
    if (p.air > 0) { let cx = 0, cy = 0; for (let i = 0; i < NS; i++) { cx += SP.x[i]; cy += SP.y[i]; } cx /= NS; cy /= NS; for (let i = 0; i < NS; i++) { SP.x[i] -= cx * p.air; SP.y[i] -= (cy) * p.air; } }
    for (let i = 0; i < NS; i++) {
      const u = i / (NS - 1), seg = (u > SADDLE0 - 0.01 && u < SADDLE1 + 0.01) || u > 0.9 ? 1 : 0.9 + 0.1 * Math.pow(Math.abs(Math.sin(u * Math.PI * SEGS)), 0.45);   // annuli: bulges with grooves between
      SP.r[i] = radius(u) * seg * (1 + 0.16 * bump(u)) * (1 + 0.02 * Math.sin(p.t * 2.4));
    }
    // the lying part keeps its belly on the ground (its centre line rises and falls with its girth)
    if (p.air < 1) for (let i = 0; i < iC; i++) { const g = -0.5 + SP.r[i] + (SP.y[i] - (-0.5 + R_FRONT)); SP.y[i] += (g - SP.y[i]) * (1 - p.air); }
    return SP;
  }
  function updateBody(g, p) {
    const sp = spine(p), pos = g.attributes.position.array, nrm = g.attributes.normal.array;
    for (let i = 0; i < NS; i++) {
      const ca = Math.cos(sp.a[i]), sa = Math.sin(sp.a[i]), nx = -sa, ny = ca, r = sp.r[i];
      for (let j = 0; j < NR; j++) {
        const th = j / NR * Math.PI * 2, c = Math.cos(th), s = Math.sin(th), o = (i * NR + j) * 3;
        // ring around the tangent: n (in the body plane) and z (side)
        const dx = nx * c, dy = ny * c, dz = s;
        pos[o] = sp.x[i] + dx * r; pos[o + 1] = sp.y[i] + dy * r; pos[o + 2] = dz * r * 1.04;
        nrm[o] = dx; nrm[o + 1] = dy; nrm[o + 2] = dz;
      }
    }
    // end caps (tail tip, head tip) along the tangent
    const e0 = NS * NR * 3, e1 = e0 + 3, l = NS - 1;
    pos[e0] = sp.x[0] - Math.cos(sp.a[0]) * sp.r[0]; pos[e0 + 1] = sp.y[0] - Math.sin(sp.a[0]) * sp.r[0]; pos[e0 + 2] = 0;
    nrm[e0] = -Math.cos(sp.a[0]); nrm[e0 + 1] = -Math.sin(sp.a[0]); nrm[e0 + 2] = 0;
    pos[e1] = sp.x[l] + Math.cos(sp.a[l]) * sp.r[l]; pos[e1 + 1] = sp.y[l] + Math.sin(sp.a[l]) * sp.r[l]; pos[e1 + 2] = 0;
    nrm[e1] = Math.cos(sp.a[l]); nrm[e1 + 1] = Math.sin(sp.a[l]); nrm[e1 + 2] = 0;
    g.attributes.position.needsUpdate = true;
    g.computeVertexNormals();                                     // (the grooves tilt the normals: the segments catch the light)
    g.computeBoundingBox();                                       // (live shape: picking / tests read it)
    return sp;
  }
  A.wormSpine = p => spine(Object.assign({ t: 0, crawl: 0, air: 0, headD: 0, arcD: 0, wave: 0 }, p));   // tests / tools
  const HEAD_NAT = 2.27 - 3.32;                // the head's heading in the rest pose (rad, facing frame)
  const EYE_GEO = new T.SphereGeometry(0.075, 16, 12), PUPIL_GEO = new T.SphereGeometry(0.036, 10, 8), GLINT_GEO = new T.SphereGeometry(0.011, 6, 4);
  // shared by every worm / grave (one copy each; before, every new map leaked a set per worm and per grave)
  const SLAB_GEO = new T.BoxGeometry(0.46, 0.62, 0.16), CAP_GEO = new T.SphereGeometry(0.23, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  let STONE = null;
  const GHOST_GEO = new T.CapsuleGeometry(0.3, 0.38, 6, 14), RIM_GEO = new T.CapsuleGeometry(0.38, 0.38, 6, 14);
  const SKIN_FILL = new T.Color(0.11, 0.055, 0.045);
  const MOUTH_GEO = new T.SphereGeometry(0.048, 12, 8), MOUTH_MAT = new T.MeshStandardMaterial({ color: 0x3a0a0e, roughness: 0.6 });
  // ASSET: worm_hands (part of models/worm.glb)
  const HAND_GEO = new T.SphereGeometry(0.045, 10, 8), ARM_GEO = new T.CylinderGeometry(0.026, 0.03, 1, 8), HAND_MAT = new T.MeshStandardMaterial({ color: 0xf2a092, roughness: 0.55, emissive: 0x1c0c08 });   // a little self-light: a worm in shade stays pink, never black
  const SKIN = new T.MeshPhysicalMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.42, sheen: 0.7, sheenColor: new T.Color(0xffd0c4), sheenRoughness: 0.45, clearcoat: 0.45, clearcoatRoughness: 0.35 });
  const EYE = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15 });
  const PUPIL = new T.MeshStandardMaterial({ color: 0x111111, roughness: 0.1 });
  const GLINT = new T.MeshBasicMaterial({ color: 0xffffff });

  /* P29e (user 2026-10-08): a worm hit by lightning blinks x-ray-like back and forth for ZAP_T s: a translucent cyan
   * shell with small bones inside (vertebrae along the live spine, rib rings, a skull), light-blue electric arcs
   * crawling around it and a cyan glow. Render-only (Math.random is fine here); built on the worm's first zap.
   * ASSET: vfx_xray_skeleton (docs/ASSET_PROMPTS.md: a stylised worm skeleton mesh could replace the instances) */
  const ZAP_T = 1.2, NVERT = 24, NRIB = 9, ARCS = 7, ARC_SEG = 9;
  const BONE_GEO = new T.SphereGeometry(1, 8, 6), RIB_GEO = new T.TorusGeometry(1, 0.09, 4, 14);
  const BONE_MAT = new T.MeshBasicMaterial({ color: 0xe6fbff, transparent: true, opacity: 1, depthTest: false, depthWrite: false });   // (seen through the shell)
  const XR_MAT = new T.MeshBasicMaterial({ color: 0x0c3f7a, transparent: true, opacity: 0.62, depthWrite: false });   // x-ray: dark film, bright bones
  const ARC_MAT = new T.LineBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.95, blending: T.AdditiveBlending, depthWrite: false });
  for (const m of [BONE_MAT, XR_MAT, ARC_MAT]) m.userData.shared = true;   // (A.clear must not dispose them)
  const zm = new T.Matrix4(), zq = new T.Quaternion(), zs = new T.Vector3(), zp = new T.Vector3(), zAxis = new T.Vector3(0, 0, 1), RIB_Q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI / 2);
  function makeZap(v) {
    const z = { shell: new T.Mesh(v.geo, XR_MAT), bones: new T.InstancedMesh(BONE_GEO, BONE_MAT, NVERT + 1), ribs: new T.InstancedMesh(RIB_GEO, BONE_MAT, NRIB),
      arcs: new T.LineSegments(new T.BufferGeometry(), ARC_MAT), glow: new T.Sprite(new T.SpriteMaterial({ map: glowTx, color: 0x58cfff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false })) };
    z.arcs.geometry.setAttribute('position', new T.BufferAttribute(new Float32Array(ARCS * ARC_SEG * 2 * 3), 3).setUsage(T.DynamicDrawUsage));
    for (const m of [z.shell, z.bones, z.ribs, z.arcs]) { m.frustumCulled = false; m.visible = false; v.body.add(m); }
    z.shell.renderOrder = 9; z.bones.renderOrder = 10; z.ribs.renderOrder = 10; z.arcs.renderOrder = 11;
    z.glow.scale.set(1.5, 1.5, 1); z.glow.visible = false; v.body.add(z.glow);
    return z;
  }
  // per frame while zapped: k = 0..1 through the effect; sp = the live spine (body-local: x, y, angle a, radius r)
  function updateZap(v, sp, k) {
    const z = v.zap, on = k < 1, xr = on && (Math.floor(k * ZAP_T * 14) % 2 === 0 || Math.random() < 0.12);   // ~7 blinks/s
    v.mesh.visible = !xr; v.eyes.visible = !xr; v.mouth.visible = !xr;
    z.shell.visible = z.bones.visible = z.ribs.visible = xr; z.arcs.visible = on; z.glow.visible = on;
    if (!on) return;
    if (xr) {
      for (let n = 0; n < NVERT; n++) {                                   // vertebrae: tail to the neck top
        const i = Math.round((0.05 + 0.86 * n / (NVERT - 1)) * (NS - 1)), r = sp.r[i];
        zq.setFromAxisAngle(zAxis, sp.a[i]); zs.set(0.022, r * 0.22, r * 0.26); zp.set(sp.x[i], sp.y[i], 0);
        zm.compose(zp, zq, zs); z.bones.setMatrixAt(n, zm);
      }
      { const i = Math.round(0.955 * (NS - 1)), r = sp.r[i]; zq.setFromAxisAngle(zAxis, sp.a[i]); zs.set(r * 0.7, r * 0.62, r * 0.6); zp.set(sp.x[i], sp.y[i], 0); zm.compose(zp, zq, zs); z.bones.setMatrixAt(NVERT, zm); }   // skull
      for (let n = 0; n < NRIB; n++) {                                    // rib rings around the fat front of the body
        const i = Math.round((0.26 + 0.3 * n / (NRIB - 1)) * (NS - 1)), r = sp.r[i] * 0.66;
        zq.setFromAxisAngle(zAxis, sp.a[i]).multiply(RIB_Q);   // the ring's plane across the spine
        zs.set(r, r, r); zp.set(sp.x[i], sp.y[i], 0); zm.compose(zp, zq, zs); z.ribs.setMatrixAt(n, zm);
      }
      z.bones.instanceMatrix.needsUpdate = true; z.ribs.instanceMatrix.needsUpdate = true;
    }
    // electric arcs: jagged polylines hugging the body, re-rolled every frame (flicker)
    const pa = z.arcs.geometry.attributes.position.array; let o = 0;
    for (let q = 0; q < ARCS; q++) {
      let i = Math.floor(Math.random() * (NS - 20)) + 10, th = Math.random() * 6.283, x0 = 0, y0 = 0, z0 = 0;
      for (let s = 0; s <= ARC_SEG; s++) {
        i = Math.max(0, Math.min(NS - 1, i + Math.round((Math.random() * 2 - 0.4) * 5))); th += (Math.random() - 0.5) * 1.6;
        const r = sp.r[i] * (1.25 + Math.random() * 0.55), nx = -Math.sin(sp.a[i]), ny = Math.cos(sp.a[i]);
        const x1 = sp.x[i] + nx * Math.cos(th) * r, y1 = sp.y[i] + ny * Math.cos(th) * r, z1 = Math.sin(th) * r * 1.04;
        if (s > 0) { pa[o++] = x0; pa[o++] = y0; pa[o++] = z0; pa[o++] = x1; pa[o++] = y1; pa[o++] = z1; }
        x0 = x1; y0 = y1; z0 = z1;
      }
    }
    z.arcs.geometry.attributes.position.needsUpdate = true;
    const mid = Math.round(0.5 * (NS - 1)); z.glow.position.set(sp.x[mid], sp.y[mid] + 0.1, 0);
    z.glow.material.opacity = (0.18 + 0.2 * Math.random()) * (1 - k * 0.6);
  }

  A.makeWorm = function (scene, w) {
    const team = C.TEAMS[w.team];
    const root = new T.Group(), body = new T.Group();
    root.rotation.order = 'YXZ';
    const geo = makeBody(team.rgb);
    // receiveShadow off (user: worms went black in the desert sun when the cut face shaded them); a warm skin fill below
    const mesh = new T.Mesh(geo, SKIN.clone()); mesh.castShadow = true; mesh.receiveShadow = false; mesh.frustumCulled = false; body.add(mesh);
    const eyes = new T.Group(); body.add(eyes);
    const pupils = [];
    for (const z of [-0.075, 0.075]) {
      const e = new T.Mesh(EYE_GEO, EYE); e.position.set(0, 0, z); e.scale.set(0.85, 1.15, 0.85); eyes.add(e);
      const p = new T.Mesh(PUPIL_GEO, PUPIL); p.position.set(0.05, 0, z * 1.1); eyes.add(p); pupils.push(p);
      const gl = new T.Mesh(GLINT_GEO, GLINT); gl.position.set(0.075, 0.025, z * 1.1 + 0.012); eyes.add(gl);
    }
    // the mouth: a dark notch at the head tip; its shape is the expression (line / open 'whee' / scared O)
    const mouth = new T.Mesh(MOUTH_GEO, MOUTH_MAT); body.add(mouth);
    root.add(body);
    // held weapon (visible while aiming): one model per weapon (render/ordnance.js held(), made on first use)
    const held = new T.Group();
    root.add(held);
    // little worm hands on short arms (shown with a held weapon): skin-coloured, from the chest to the grips
    const hands = [0, 1].map(() => { const hand = new T.Mesh(HAND_GEO, HAND_MAT), arm = new T.Mesh(ARM_GEO, HAND_MAT); hand.castShadow = arm.castShadow = true; hand.visible = arm.visible = false; root.add(hand, arm); return { hand, arm }; });
    // x-ray silhouette when hidden behind terrain (same live geometry)
    const xray = new T.Mesh(geo, new T.MeshBasicMaterial({ color: team.rgb, transparent: true, opacity: 0.45, depthFunc: T.GreaterDepth, depthWrite: false }));
    xray.renderOrder = 8; xray.frustumCulled = false; body.add(xray);
    const ghost = new T.Group();
    const gBody = new T.Mesh(GHOST_GEO, new T.MeshBasicMaterial({ color: team.rgb, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false }));
    const gRim = new T.Mesh(RIM_GEO, new T.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, side: T.BackSide }));
    gBody.renderOrder = 11; gRim.renderOrder = 10; ghost.add(gRim, gBody);
    scene.add(root, ghost);
    const pose = { t: 0, crawl: 0, air: 0, headD: 0, arcD: 0, wave: (w.id || 0) * 0.37 };
    return { root, body, mesh, geo, eyes, pupils, mouth, held, hands, heldBy: {}, burrowT: 9, batT: 0, batA: 0, flinchT: 0, stars: null, ghost, ghostMats: [gBody.material, gRim.material], phase: (w.id || 0) * 1.7, flash: 0, flame: null, pose, tilt: 0, lastS: null };
  };

  A.makeGrave = function (scene, g, w) {
    if (SS.graveView) { const team = w && C.TEAMS[w.team] ? C.TEAMS[w.team].rgb : 0x888888, grp = SS.graveView.make(g, team, w && w.name); scene.add(grp); return grp; }
    const grp = new T.Group();
    const stoneMat = STONE || (STONE = new T.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85 }));
    const slab = new T.Mesh(SLAB_GEO, stoneMat); slab.position.y = 0.0;
    const cap = new T.Mesh(CAP_GEO, stoneMat); cap.scale.z = 0.35; cap.position.y = 0.31;
    grp.add(slab, cap);
    grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    grp.position.set(g.x, g.y, g.z);
    scene.add(grp);
    return grp;
  };

  A.projGeo = { grenade: new T.SphereGeometry(0.16, 16, 12), bazooka: new T.CylinderGeometry(0.08, 0.12, 0.6, 10) };
  A.projMat = {
    grenade: new T.MeshStandardMaterial({ color: 0x3d6b2a, roughness: 0.35, metalness: 0.3 }),
    bazooka: new T.MeshStandardMaterial({ color: 0xd06a2a, roughness: 0.4, metalness: 0.4, emissive: 0x401000 })
  };

  /* ---------- live scene objects ---------- */
  const P = SS.plane;
  let scene = null, rope, ropeKnot, reticle, trailT = 0, hookM = null, hookLine = null, glowTx = null;
  const teles = [];   // PoC teleFx: live beam effects
  const worms = new Map(), projs = new Map(), graves = new Map(), powerDots = [], keptRopes = [];
  const v4 = new T.Vector3(), ropeB = new T.Vector3(), yAxis = new T.Vector3(0, 1, 0), RED = new T.Color(0xff2a10);

  A.init = function (sc, tx) {
    scene = sc; glowTx = tx.glow;
    rope = new T.Mesh(new T.CylinderGeometry(0.025, 0.025, 1, 6, 1, true), new T.MeshStandardMaterial({ color: 0xe9d08a, roughness: 0.7 }));
    rope.castShadow = true; scene.add(rope);
    ropeKnot = new T.Mesh(new T.SphereGeometry(0.1, 10, 8), new T.MeshStandardMaterial({ color: 0xcfcfd6, metalness: 0.8, roughness: 0.3 })); scene.add(ropeKnot);
    // the grappling hook: flies out on its line (S.hook), then sits in the anchor pointing into the rock
    if (SS.ordnance) { hookM = SS.ordnance.hook(); hookM.scale.setScalar(1.4); hookM.visible = false; scene.add(hookM); }
    hookLine = new T.Mesh(rope.geometry, rope.material); hookLine.visible = false; scene.add(hookLine);
    reticle = new T.Sprite(new T.SpriteMaterial({ map: tx.ring, color: 0xffffff, depthTest: false, transparent: true }));
    reticle.scale.set(0.55, 0.55, 1); reticle.renderOrder = 12; scene.add(reticle);
    for (let i = 0; i < 14; i++) {
      const s = new T.Sprite(new T.SpriteMaterial({ map: tx.glow, depthTest: false, transparent: true, blending: T.AdditiveBlending }));
      s.renderOrder = 12; s.visible = false; scene.add(s); powerDots.push(s);
    }
  };
  A.clear = function () {
    // per-worm materials (team colours, held weapon, x-ray, ghost) are disposed; shared geometries / eye materials stay
    const keep = new Set([EYE, PUPIL, GLINT, STONE]);
    for (const v of worms.values()) {
      scene.remove(v.root, v.ghost);
      for (const g of [v.root, v.ghost]) g.traverse(o => { if (o.isMesh && o.material) for (const m of [].concat(o.material)) if (!keep.has(m) && !m.userData.shared) m.dispose(); });
      if (v.geo) v.geo.dispose();                                  // P8: each worm owns its live body geometry
      if (v.flame) SS.bodyView.unflame(v.flame);
      if (v.zap) { v.zap.arcs.geometry.dispose(); v.zap.bones.dispose(); v.zap.ribs.dispose(); v.zap.glow.material.dispose(); }
    }
    for (const v of projs.values()) scene.remove(v);
    for (const f of teles) scene.remove(f.grp); teles.length = 0;
    for (const v of graves.values()) { scene.remove(v); if (SS.graveView) SS.graveView.dispose(v); }
    worms.clear(); projs.clear(); graves.clear();
  };
  A.vis = w => { const v = worms.get(w); return v ? { group: v.root, body: v.mesh, ghost: v.ghost } : null; };
  /* PoC teleFx (game.js L3891, user: "the one from PoC was perfect"): beamed across: columns of light stand at both
   * ends; the worm dissolves at the source as it materialises at the destination (ghost copies of its body, the source
   * fading and stretching up, the destination fading in from a stretched pose); the real worm is hidden for the 1.5 s;
   * 42 flickering light streaks per beam (cyan / pale cyan, additive), glow motes rising; a deployment (arrival) has
   * no source and its ghost follows the worm. PoC px -> m x 0.0643. */
  const TELE_DUR = 1.5, PXM = 0.0643;
  function teleBeam(p) {
    const b = new T.Group(); b.position.set(p.x, p.y + 14 * PXM, p.z);
    for (let i = 0; i < 42; i++) {
      const sp = new T.Sprite(new T.SpriteMaterial({ map: glowTx, color: i % 3 ? 0x60dcff : 0xc7faff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false }));
      const r = (a, c) => a + Math.random() * (c - a);
      sp.position.set(r(-13, 13) * PXM, r(-18, 65) * PXM, r(-6, 6) * PXM);
      sp.scale.set(r(0.45, 1.6) * PXM * 2.2, r(35, 120) * PXM, 1);
      sp.userData = { start: r(0, 0.8), dur: r(0.06, 0.18), seed: r(0, 100) }; sp.renderOrder = 9; b.add(sp);
    }
    const motes = [];
    for (let i = 0; i < 18; i++) { const m = new T.Sprite(new T.SpriteMaterial({ map: glowTx, color: 0xbfe6ff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false })); m.scale.setScalar(0.09); m.userData = { ph: Math.random(), x: (Math.random() - 0.5) * 0.9, z: (Math.random() - 0.5) * 0.4, v: 0.6 + Math.random() * 2.2 }; b.add(m); motes.push(m); }
    b.userData.motes = motes;
    return b;
  }
  function teleGhost(v, p) {
    const g = new T.Group(); g.position.set(p.x, p.y, p.z); g.rotation.copy(v.root.rotation);
    const m = new T.Mesh(v.geo.clone(), new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.5, emissive: 0x2a6f8a, emissiveIntensity: 0.6, transparent: true, depthWrite: false, opacity: 0 }));
    m.frustumCulled = false; m.renderOrder = 8;
    const body = new T.Group(); body.add(m); g.add(body); g.userData.body = body; g.userData.mat = m.material; return g;
  }
  function teleStart(e) {
    const v = worms.get(e.worm); if (!v) return;
    const arrival = !!e.deploy, grp = new T.Group();
    const src = arrival ? null : teleGhost(v, e.from), dst = teleGhost(v, e.to), bs = arrival ? null : teleBeam(e.from), bd = teleBeam(e.to);
    for (const o of [src, dst, bs, bd]) if (o) grp.add(o);
    scene.add(grp);
    teles.push({ w: e.worm, grp, src, dst, bs, bd, arrival, t: 0 });
  }
  function teleStep(dt) {
    for (let i = teles.length - 1; i >= 0; i--) {
      const f = teles[i]; f.t += dt; const k = f.t / TELE_DUR;
      if (k >= 1 || f.w.dead) { scene.remove(f.grp); f.grp.traverse(o => { if (o.material) o.material.dispose(); if (o.isMesh && o.geometry) o.geometry.dispose(); }); teles.splice(i, 1); continue; }
      if (f.arrival) { f.dst.position.set(f.w.pos.x, f.w.pos.y, f.w.pos.z); f.bd.position.set(f.w.pos.x, f.w.pos.y + 14 * PXM, f.w.pos.z); }
      const cl = x => Math.max(0, Math.min(1, x)), out = cl((k - 0.1) / 0.6), inn = cl((k - 0.35) / 0.55), glow = Math.sin(Math.PI * cl(k));
      if (f.src) { f.src.userData.mat.opacity = 1 - out; f.src.userData.body.scale.y = 1 + out * 0.25; }
      f.dst.userData.mat.opacity = inn; f.dst.userData.body.scale.y = 1.25 - inn * 0.25;
      for (const b of [f.bs, f.bd]) if (b) {
        for (const c of b.children) {
          const u = c.userData; if (u.start == null) continue;
          const pulse = ((k + u.seed) % 0.24) / 0.24, vis = k > u.start && k < u.start + u.dur + 0.22 && pulse < 0.7;
          c.material.opacity = vis ? glow * (0.55 + 0.45 * Math.sin(pulse / 0.7 * Math.PI)) : 0;
        }
        for (const m of b.userData.motes) { const ph = (m.userData.ph + f.t * m.userData.v * 0.4) % 1; m.position.set(m.userData.x, -26 * PXM + ph * 2.4, m.userData.z); m.material.opacity = glow * (1 - ph) * 0.9; }
      }
    }
  }
  A.teleporting = w => teles.some(f => f.w === w);
  A.teleDebug = () => teles.map(f => { const g = f.dst, m = g.userData.body.children[0], bb = new T.Box3().setFromObject(g); return { k: +(f.t / TELE_DUR).toFixed(2), dst: g.position.toArray().map(v => +v.toFixed(2)), op: +g.userData.mat.opacity.toFixed(2), src: f.src ? +f.src.userData.mat.opacity.toFixed(2) : null, box: [bb.min.toArray().map(v => +v.toFixed(2)), bb.max.toArray().map(v => +v.toFixed(2))], vis: g.visible && f.grp.visible, inScene: !!f.grp.parent }; });
  A.onEvent = function (S, e) {
    if (e.type === 'teleport' && e.worm) teleStart(e);
    if (e.type === 'zap' && e.worm) { const v = worms.get(e.worm); if (v) { if (!v.zap) v.zap = makeZap(v); v.zapT = viewTime; v.flinchT = 0.9; } }
    if (e.type === 'hurt' && e.worm) {
      const v = worms.get(e.worm); if (!v) return;
      v.flash = Math.min(1, 0.45 + e.amount / 40);
      if (e.why === 'a baseball bat') { v.batT = 3; v.batW = 15 * (Math.random() < 0.5 ? -1 : 1); }   // sent spinning, terrified
      else v.flinchT = 0.5;                                                                          // a flinch, eyes shut
    }
    // a blast nearby makes every worm within reach flinch (eyes shut, a twitch) even when it was not hurt
    if (e.type === 'explode') for (const w of S.worms) { if (w.dead) continue; const d = Math.hypot(w.pos.x - e.x, w.pos.y - e.y, w.pos.z - e.z); if (d < 3 * (e.R || 3)) { const v = worms.get(w); if (v) v.flinchT = Math.max(v.flinchT, 0.45 * (1 - d / (3 * (e.R || 3))) + 0.15); } }
    // a hard landing: the worm burrows into the ground for a moment and pops back out (dust)
    if (e.type === 'land' && e.hard && e.worm && !e.worm.dead) { const v = worms.get(e.worm); if (v) { v.burrowT = 0; v.batT = 0; if (SS.fx && SS.fx.dust) SS.fx.dust(e.x, e.y, e.z, 12, 0.7, 0x8a6a48); } }
    if (e.type === 'land' && e.worm) { const v = worms.get(e.worm); if (v && v.batT > 0) v.batT = Math.min(v.batT, 0.3); }
  };
  let viewTime = 0;
  A.sync = function (S, view, ctxA, insp, dt) {
    dt = dt || 1 / 60;
    viewTime = view.time; if (SS.ordnance) SS.ordnance.tick(view.time);
    if (teles.length) teleStep(dt);
    const d = P.dir(S), a = S.active;
    syncWorms(S, view, d, insp, dt);
    syncProjectiles(S, dt);
    syncRopeAim(S, view, a);
  };

  function syncWorms(S, view, d, insp, dt) {
    const a = S.active;
    for (const w of S.worms) {
      let v = worms.get(w);
      if (!v) { v = A.makeWorm(scene, w); worms.set(w, v); }
      if (w.dead) {
        v.root.visible = false; v.ghost.visible = false;
        if (v.flame) { SS.bodyView.unflame(v.flame); v.flame = null; }
        if (w.grave && !graves.has(w)) graves.set(w, A.makeGrave(scene, w.grave, w));
        const gv = graves.get(w);
        if (gv) {
          if (!w.grave) { scene.remove(gv); graves.delete(w); continue; }
          gv.visible = SS.view.shownAt(S, w.grave, 0.5);                    // follows the section view
          if (gv.visible && SS.graveView) SS.graveView.frame(gv, w.grave, S, P.nrm(S), view.time, dt, w);
        }
        continue;
      }
      const inSec = SS.view.inSlab(S, w.pos) || w === a;
      v.root.visible = inSec && !teles.some(f => f.w === w);       // hidden while the beam carries it (ghosts stand in)
      v.root.position.set(w.pos.x, w.pos.y, w.pos.z);
      const f = w === a ? w.facing : 1;
      v.root.rotation.y = -Math.atan2(d.z * f, d.x * f);
      // P8: pose (crawl wave speed from the walking speed, air, the aim) -> live body, eyes and held weapon at the head
      const ps = v.pose, airborne = w === a ? a.air || !!S.rope : !w.rest, aiming = w === a && S.phase === 'play';
      const sNow = P.to_plane(S, w.pos).s, spd = v.lastS == null ? 0 : Math.abs(sNow - v.lastS) / Math.max(1e-3, dt); v.lastS = sNow;
      const crawlT = airborne ? 0 : Math.min(1, spd / C.WALK);
      ps.t = view.time + v.phase;
      ps.crawl += (crawlT - ps.crawl) * Math.min(1, dt * 5);
      ps.air += ((airborne ? 1 : 0) - ps.air) * Math.min(1, dt * 4);
      ps.wave += dt * (0.12 + 1.6 * ps.crawl);                       // contraction waves run head -> tail (u + wave)
      // P33: swimming / struggling in the water: fast contraction waves, the head thrown up and about
      if (w.swim || w.ropeWet) ps.wave += dt * 3.2;
      const look = aiming && !w.ropeWet ? S.aim : w.swim || w.ropeWet ? 1.1 + 0.5 * Math.sin(ps.t * 9.0) : 0.25 * Math.sin(ps.t * 0.37);
      // the head takes most of the turn (its tip may rotate a lot), the arc a little: the body stays ~1 m tall
      const want = M.clamp(look - HEAD_NAT, -0.5, 2.6);
      ps.headD += (Math.min(1.7, want * 0.75) - ps.headD) * Math.min(1, dt * 7);   // the head first ...
      ps.arcD += (want * 0.25 - ps.arcD) * Math.min(1, dt * 2.2);                // ... the arc behind it follows slowly
      if (inSec || insp > 0.01) {
        const sp = updateBody(v.geo, ps), hi = NS - 4, ha = sp.a[hi];
        if (v.zap) updateZap(v, sp, Math.min(1, (viewTime - v.zapT) / ZAP_T));
        // eyes on the front of the head, looking along it; blink now and then
        v.eyes.position.set(sp.x[hi] + Math.cos(ha) * 0.05 - Math.sin(ha) * 0.06, sp.y[hi] + Math.sin(ha) * 0.05 + Math.cos(ha) * 0.06, 0);
        v.eyes.rotation.z = ha;
        v.eyes.scale.y = (Math.sin(ps.t * 0.9) > 0.995) ? 0.15 : 1;
        const pl = aiming ? M.clamp(S.aim - ha, -0.8, 0.8) : 0;
        for (const p of v.pupils) { p.position.y = Math.sin(pl) * 0.03; p.position.x = 0.05 * Math.cos(pl) + 0.004; }
        v.held.visible = aiming && !S.rope && !S.hook && !w.air && !(w.dizzyUntil > S.time) && S.weapon !== 'skip';   // stowed in the air / while dizzy (no weapon then, PoC)
        if (v.held.visible) {
          let hm = v.heldBy[S.weapon];
          if (!hm && SS.ordnance) { hm = v.heldBy[S.weapon] = SS.ordnance.held(S.weapon); v.held.add(hm); }
          for (const k in v.heldBy) v.heldBy[k].visible = k === S.weapon;
          // on the shot line (the shots leave the worm's centre along the aim): the root is tilted with the slope,
          // so the aim in its frame is aim - tilt; in front of the body on the camera's side (local z sign)
          const a2 = S.aim - v.tilt, phi = v.root.rotation.y, nn = P.nrm(S), zs = Math.sign(Math.sin(phi) * nn.x + Math.cos(phi) * nn.z) || 1;
          const gr = hm.userData.grips || [];
          v.held.position.set(Math.cos(a2) * 0.14, Math.sin(a2) * 0.14 + 0.02, 0.17 * zs); v.held.rotation.set(0, 0, a2); v.held.scale.set(1, 1, zs);
          const ci = Math.round(NS * 0.55), cr = sp.r[ci], cx = sp.x[ci] + Math.cos(sp.a[ci] - Math.PI / 2) * cr * 0.5, cy = sp.y[ci] + Math.sin(sp.a[ci] - Math.PI / 2) * cr * 0.5;
          for (let q = 0; q < 2; q++) {
            const hd = v.hands[q], g0 = gr[q];
            hd.hand.visible = hd.arm.visible = !!g0; if (!g0) continue;
            const ca = Math.cos(a2), sa = Math.sin(a2), hx = v.held.position.x + ca * g0[0] - sa * g0[1], hy = v.held.position.y + sa * g0[0] + ca * g0[1], hz = v.held.position.z + g0[2] * zs;
            hd.hand.position.set(hx, hy, hz);
            const sx = cx, sy = cy, sz = (q ? -0.05 : 0.07) * zs + 0.06 * zs, dx = hx - sx, dy = hy - sy, dz = hz - sz, L = Math.hypot(dx, dy, dz) || 1e-3;
            hd.arm.position.set((hx + sx) / 2, (hy + sy) / 2, (hz + sz) / 2); hd.arm.scale.set(1, L, 1);
            hd.arm.quaternion.setFromUnitVectors(yAxis, v4.set(dx / L, dy / L, dz / L));
          }
        }
        if (!v.held.visible) for (const hd of v.hands) hd.hand.visible = hd.arm.visible = false;
        // expressions (user 2026-10-08: "all the usual behaviours as things happen"): rising = 'whee' (mouth open,
        // eyes up), falling fast / bat-spun = scared (wide eyes, tiny pupils, O mouth, hands flailing), skidding =
        // squint, flinch = eyes shut; else the blink and a small line of a mouth
        const vy = w === a ? (a.air ? a.vy : 0) : (!w.rest && w.vel ? w.vel.y : 0), slide = !!w.slide && !airborne;
        const scared = v.batT > 0 || (airborne && vy < -9), whee = airborne && vy > 2.5 && !scared, flinch = v.flinchT > 0;
        const tipx = sp.x[NS - 1] + Math.cos(ha) * 0.035 + Math.sin(ha) * 0.04, tipy = sp.y[NS - 1] + Math.sin(ha) * 0.035 - Math.cos(ha) * 0.04;
        v.mouth.position.set(tipx, tipy, 0); v.mouth.rotation.z = ha;
        if (scared) v.mouth.scale.set(0.9, 1.5, 1.1); else if (whee) v.mouth.scale.set(1.35, 1.0, 1.2); else if (flinch) v.mouth.scale.set(1.1, 0.35, 0.9); else v.mouth.scale.set(1.0, 0.28, 0.8);
        if (flinch) v.eyes.scale.set(1, 0.1, 1);
        else if (scared) { v.eyes.scale.set(1.25, 1.25, 1.25); for (const p of v.pupils) p.scale.setScalar(0.55); }
        else if (slide) v.eyes.scale.set(1, 0.5, 1);
        else v.eyes.scale.x = v.eyes.scale.z = 1;
        if (!scared) for (const p of v.pupils) p.scale.setScalar(1);
        if (whee) for (const p of v.pupils) p.position.y = 0.025;
        // hands flail while falling scared (no weapon then)
        if (!v.held.visible && airborne && (scared || vy < -4)) {
          const hx = sp.x[NS - 10], hy = sp.y[NS - 10];
          v.hands.forEach((hd, q) => {
            const fl = Math.sin(view.time * 22 + q * 2) * 0.12, sgn = q ? 1 : -1;
            hd.hand.visible = hd.arm.visible = true;
            const px = hx + 0.05 + fl * 0.5, py = hy + 0.18 + fl, pz = sgn * 0.17, sx0 = hx, sy0 = hy - 0.05, sz0 = sgn * 0.05;
            hd.hand.position.set(px, py, pz);
            const dx = px - sx0, dy = py - sy0, dz = pz - sz0, L = Math.hypot(dx, dy, dz);
            hd.arm.position.set((px + sx0) / 2, (py + sy0) / 2, (pz + sz0) / 2); hd.arm.scale.set(1, L, 1); hd.arm.quaternion.setFromUnitVectors(yAxis, v4.set(dx / L, dy / L, dz / L));
          });
        }
      }
      v.flinchT = Math.max(0, v.flinchT - dt); if (v.batT > 0) { v.batT -= dt; v.batA += v.batW * dt; } else v.batA *= Math.max(0, 1 - dt * 10);
      // PoC dynamics on screen: the back salto spins the whole body (13 rad/s, head over backwards, about the disc
      // centre); a landing / take-off squashes it for 0.28 s (feet stay on the ground); dizzy = stars round the head
      const flipA = w.flip && w.flipAt != null ? (S.time - w.flipAt) * 13 : 0;
      v.flipA = flipA ? flipA : (v.flipA || 0) * Math.max(0, 1 - dt * 14);
      const skid = !!w.slide && !(w === a ? a.air : !w.rest) ? -0.22 : 0;          // a skid leans back
      v.lean = (v.lean || 0) + (skid - (v.lean || 0)) * Math.min(1, dt * 8);
      v.body.rotation.z = v.flipA + v.batA + v.lean + (w.swim || w.ropeWet ? 0.32 * Math.sin(viewTime * 10.5) : 0);   // P33: thrashing
      if ((w.swim || w.ropeWet) && SS.fx && Math.random() < dt * 7) SS.fx.splash(w.pos.x + (Math.random() - 0.5) * 0.6, SS.sim.surface_at(S, w.pos.x, w.pos.z), w.pos.z + (Math.random() - 0.5) * 0.6, 0.22);
      const sqT = w.squash != null ? (S.time - w.squash) / 0.28 : 9, q = sqT >= 0 && sqT < 1 ? 0.24 * Math.sin(Math.PI * sqT) * (1 - sqT * 0.5) : 0;
      // rising: a little stretched; the burrow after a hard landing: down into the ground in 0.12 s, a beat under it,
      // then out with an overshoot (0.85 s in all)
      const vyb = w === a ? (a.air ? a.vy : 0) : (!w.rest && w.vel ? w.vel.y : 0), st = vyb > 2.5 ? Math.min(0.12, vyb * 0.012) : 0;
      v.burrowT += dt; const bt = v.burrowT, bur = bt < 0.12 ? bt / 0.12 : bt < 0.42 ? 1 : bt < 0.85 ? 1 - (bt - 0.42) / 0.43 * 1.15 : 0;
      v.body.scale.set(1 + q * 0.55 - st * 0.3, 1 - q + st, 1 + q * 0.55 - st * 0.3); v.body.position.y = -0.5 * q - 0.62 * Math.max(-0.12, bur);
      const dizzy = w.dizzyUntil > S.time && inSec;
      if (dizzy && !v.stars && SS.ordnance) { v.stars = new T.Group(); for (let i = 0; i < 3; i++) v.stars.add(SS.ordnance.star()); v.body.add(v.stars); }
      if (v.stars) {
        v.stars.visible = dizzy;
        if (dizzy) {
          const hp = v.eyes.position;
          v.stars.position.set(hp.x - 0.04, hp.y + 0.2, 0);
          v.stars.children.forEach((st, i) => { const a = view.time * 6 + i * 2.094; st.position.set(Math.cos(a) * 0.16, Math.sin(a * 2) * 0.02, Math.sin(a) * 0.16); st.rotation.set(0, a * 1.7, 0); });
        }
      }
      // on the ground the base follows the slope (in the facing frame)
      let tilt = 0;
      if (!airborne) { const nn = P.normal2(S, sNow, w.pos.y - 0.55); tilt = M.clamp(Math.atan2(-nn.s * (w === a ? w.facing : 1), nn.y), -0.5, 0.5); }
      v.tilt += (tilt - v.tilt) * Math.min(1, dt * 6); v.root.rotation.z = v.tilt;
      v.ghost.visible = !inSec && insp > 0.01;
      v.ghost.position.copy(v.root.position);
      v.ghostMats[0].opacity = 0.45 * insp; v.ghostMats[1].opacity = 0.6 * insp;
      // hurt flash (decays in ~0.4 s)
      v.flash = Math.max(0, v.flash - dt * 2.5);
      v.mesh.material.emissive.copy(RED).multiplyScalar(v.flash * 0.9).add(SKIN_FILL);
      // on fire (lava, burning oil, a burning prop): flames on the worm while sim.burn keeps stamping w.burnT
      const burning = S.time - (w.burnT == null ? -9 : w.burnT) < 0.3 && inSec;
      if (burning) {
        if (!v.flame) v.flame = SS.bodyView.flame((w.id * 0.37 + 0.11) % 1);
        // in front of the body (seen from the camera), else the worm hides its own flames
        const cp = SS.view.camera().position, dx = cp.x - w.pos.x, dy = cp.y - w.pos.y, dz = cp.z - w.pos.z, l = Math.hypot(dx, dy, dz) || 1;
        v.flame.position.set(w.pos.x + dx / l * 0.4, w.pos.y - C.WORM_H * 0.45 + dy / l * 0.4, w.pos.z + dz / l * 0.4); v.flame.scale.set(0.8, 1.35, 1);
      } else if (v.flame) { SS.bodyView.unflame(v.flame); v.flame = null; }
    }
  }

  function syncProjectiles(S, dt) {
    const seen = new Set(), OR = SS.ordnance, AV = SS.armsView;
    trailT += dt;
    for (const p of S.proj) {
      let m = projs.get(p);
      if (!m) {
        // render/ordnance.js: real rockets (fins, canards, roll, shader plume) and tumbling grenades; arms.js: the
        // walking sheep and the napalm flame blobs; a plain ball if a type has no model
        m = (OR && OR.proj(p.type)) || (AV && AV.projMesh(p.type)) || new T.Mesh(A.projGeo.grenade, A.projMat.grenade);
        m.castShadow = true; scene.add(m); projs.set(p, m);
      }
      seen.add(p);
      const wp = P.to_world(S, p.s, p.y); m.position.set(wp.x, wp.y, wp.z);
      if (m.userData.kind) {
        OR.update(m, p, S, dt, viewTime);
        // smoke behind the rockets (from the nozzle, not the centre)
        if (m.userData.kind === 'rocket' && trailT > 0.02 && !p.wet && p.type !== 'napalm') {
          const sp = Math.hypot(p.vs, p.vy) || 1, b = P.to_world(S, p.s - p.vs / sp * 0.4, p.y - p.vy / sp * 0.4);
          SS.fx.trail(b.x, b.y, b.z);
        }
        if (p.type === 'dynamite' && trailT > 0.02 && Math.random() < 0.5) SS.fx.spark(wp.x, wp.y + 0.25, wp.z);
      } else if (p.type === 'sheep') {                                     // walks: faces its way, legs swing
        m.rotation.set(0, -Math.atan2(P.dir(S).z * p.dir, P.dir(S).x * p.dir), 0, 'YXZ');
        const L = m.userData.legs; if (L) for (let i = 0; i < 4; i++) L[i].rotation.z = Math.sin(p.age * 14 + i * 1.6) * 0.5;
      } else if (p.type === 'flame' || p.type === 'fuel') { if (trailT > 0.02) SS.fx.spark(wp.x, wp.y, wp.z); }
      else { m.rotation.set(0, -S.theta, (m.rotation.z || 0) - p.vs * dt * 3, 'YXZ'); }
      if (p.wet && trailT > 0.02) SS.fx.bubble && SS.fx.bubble(wp.x, wp.y, wp.z);
    }
    if (trailT > 0.02) trailT = 0;
    for (const [p, m] of projs) if (!seen.has(p)) { scene.remove(m); projs.delete(p); SS.mat.disposeTree(m); }   // (each shot builds its own model)
  }

  function syncRopeAim(S, view, a) {
    if (S.rope && a) {
      const an = P.to_world(S, S.rope.s, S.rope.y), A0 = v4.set(a.pos.x, a.pos.y, a.pos.z), B = ropeB.set(an.x, an.y, an.z);
      const len = A0.distanceTo(B);
      rope.position.copy(A0).add(B).multiplyScalar(0.5); rope.scale.set(1, len, 1);
      rope.quaternion.setFromUnitVectors(yAxis, B.clone().sub(A0).normalize());
      rope.material.color.set(S.rope.hooked ? 0xe9d08a : 0xff8a3a);
      ropeKnot.position.copy(B);
      rope.visible = true; ropeKnot.visible = !hookM;
    } else rope.visible = ropeKnot.visible = false;
    if (hookM) hookM.visible = false;
    hookLine.visible = false;
    if (S.hook && a) {                         // in flight: the hook leads its line out at 109 m/s
      const hw = P.to_world(S, S.hook.s, S.hook.y), A0 = v4.set(a.pos.x, a.pos.y, a.pos.z), B = ropeB.set(hw.x, hw.y, hw.z), len = A0.distanceTo(B);
      if (len > 0.05) {
        hookLine.position.copy(A0).add(B).multiplyScalar(0.5); hookLine.scale.set(1, len, 1);
        hookLine.quaternion.setFromUnitVectors(yAxis, B.clone().sub(A0).normalize()); hookLine.visible = true;
      }
      if (hookM) { hookM.position.copy(B); hookM.rotation.set(0, -S.theta, Math.atan2(S.hook.dy, S.hook.ds), 'YXZ'); hookM.visible = true; }
    } else if (S.rope && a && hookM && S.rope.hooked) {
      // stuck in the rock where it first bit: with a wrapped rope that is pins[0] (S.rope is then the newest bend);
      // it points along the line it came in on (from the next bend / the worm)
      const pins = S.rope.pins || [], h = pins.length ? pins[0] : S.rope;
      const nx = pins.length > 1 ? pins[1] : pins.length ? S.rope : null, from = nx ? { s: nx.s, y: nx.y } : { s: P.to_plane(S, a.pos).s, y: a.pos.y };
      const an = P.to_world(S, h.s, h.y);
      hookM.position.set(an.x, an.y, an.z); hookM.rotation.set(0, -S.theta, Math.atan2(h.y - from.y, h.s - from.s), 'YXZ'); hookM.visible = true;
    }
    // a wrapped rope: the fixed segments between its bends (S.rope.pins, newest last)
    let k = 0;
    const seg = (A1, B1) => {
      let m = keptRopes[k]; if (!m) { m = rope.clone(); m.material = rope.material.clone(); scene.add(m); keptRopes.push(m); }
      const L1 = A1.distanceTo(B1); m.position.copy(A1).add(B1).multiplyScalar(0.5); m.scale.set(1, L1, 1); m.quaternion.setFromUnitVectors(yAxis, B1.clone().sub(A1).normalize()); m.visible = true; k++;
    };
    if (S.rope && a && S.rope.pins && S.rope.pins.length) {
      let prev = P.to_world(S, S.rope.s, S.rope.y);
      for (let i = S.rope.pins.length - 1; i >= 0; i--) { const q = P.to_world(S, S.rope.pins[i].s, S.rope.pins[i].y); seg(new T.Vector3(prev.x, prev.y, prev.z), new T.Vector3(q.x, q.y, q.z)); prev = q; }
    }
    // kept ropes (setup option): worms hanging between turns
    for (const w of S.worms) if (!w.dead && w.rope && w !== a) {
      seg(new T.Vector3(w.pos.x, w.pos.y, w.pos.z), new T.Vector3(w.rope.x, w.rope.y, w.rope.z));
    }
    for (; k < keptRopes.length; k++) keptRopes[k].visible = false;
    const aiming = S.phase === 'play' && a && !a.dead;
    reticle.visible = !!aiming;
    for (const s of powerDots) s.visible = false;
    if (aiming) {
      const ad = SS.sim.aim_dir(S), ap = P.to_plane(S, a.pos), qq = P.to_world(S, ap.s + ad.s * 2.4, a.pos.y + ad.y * 2.4);
      reticle.position.set(qq.x, qq.y, qq.z);
      reticle.material.rotation = view.time * 1.5;
      reticle.material.color.set(S.weapon === 'rope' ? 0xbfe6ff : 0xffffff);
      if (S.charging) {
        const nd = Math.ceil(S.power * powerDots.length);
        for (let i = 0; i < nd; i++) {
          const f = (i + 1) / powerDots.length, r = 0.55 + f * 1.7, w = P.to_world(S, ap.s + ad.s * r, a.pos.y + ad.y * r), s = powerDots[i];
          s.visible = true; s.position.set(w.x, w.y, w.z); s.scale.setScalar(0.18 + f * 0.32);
          s.material.color.setRGB(1.5, 1.4 - f * 1.1, 0.3 - f * 0.25);
        }
      }
    }
  }
})(window.SS = window.SS || {});
