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
   * Ring annuli (segment grooves) and a team-coloured saddle (clitellum) are in the geometry; original design.
   *
   * P39 (user: "imagine they are jello worm shaped"): the spine above is only the MUSCLE GOAL pose. The drawn body is
   * the soft-body solver's (core/softworm.js, driven through render/softview.js): the goal is sampled at 16 nodes, the
   * solver deforms / wobbles / crumples / lies along the slope under real terrain contact and friction, and the tube is
   * skinned from the live nodes (buildRings). No rigid rotation, tumble, roll, dent or scale of the whole body is
   * applied any more: a salto is a muscle torque, a bat hit / blast / landing are impulses on the nodes. */
  // user 2026-10-08: a worm, not a snake: ~38 bulging segments (annuli) along the body, smooth over the saddle
  const NS = 150,
    NR = 14,
    SEGS = 38,
    BODY = (() => {
      // arc lengths (m): tail + base, corner (turns up and back), neck, top arc (turns forward), head
      // (x 0.88: the worm stands ~1 m with its eyes, as the brief's metric scale wants; verify 'scale')
      const seg = [0.74, 0.34, 0.4, 0.56, 0.16].map(v => v * 0.88),
        L = seg.reduce((a, b) => a + b, 0),
        k = [0, 2.27 / seg[1], 0, -3.32 / seg[3], 0];
      const u = [];
      let acc = 0;
      for (const l of seg) {
        acc += l;
        u.push(acc / L);
      }
      return { L, seg, k, u, uBase: seg[0] / L, uNeck: (seg[0] + seg[1]) / L, uArc: (seg[0] + seg[1] + seg[2]) / L };
    })();
  const smooth01 = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
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
    for (const q of [NS * NR, NS * NR + 1]) {
      col[q * 3] = skin.r;
      col[q * 3 + 1] = skin.g;
      col[q * 3 + 2] = skin.b;
    }
    for (let i = 0; i < NS - 1; i++)
      for (let j = 0; j < NR; j++) {
        const a = i * NR + j, b = i * NR + (j + 1) % NR, c = a + NR, d = b + NR;
        idx.push(a, c, b, b, c, d);
      }
    for (let j = 0; j < NR; j++) {
      idx.push(NS * NR, (j + 1) % NR, j);
      idx.push(NS * NR + 1, (NS - 1) * NR + j, (NS - 1) * NR + (j + 1) % NR);
    }
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('normal', new T.BufferAttribute(nrm, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.boundingSphere = new T.Sphere(new T.Vector3(0, 0, 0), 1.6);
    return g;
  }
  // b = the contraction (0..1) of the peristaltic wave at the sample
  const SP = {
    x: new Float32Array(NS),
    y: new Float32Array(NS),
    a: new Float32Array(NS),
    r: new Float32Array(NS),
    b: new Float32Array(NS)
  };
  /* the spine for pose p {t, crawl (0..1 wave speed), air (0..1), headD (rad, fast), arcD (rad, slow)} */
  function spine(p) {
    const B = BODY, ds = B.L / (NS - 1), wph = p.wave;
    const kappa = u => {
      let k = 0;
      // piecewise curvature with soft joints
      const e = 0.035;
      k += B.k[1] * smooth01(B.uBase - e, B.uBase + e, u) * (1 - smooth01(B.uNeck - e, B.uNeck + e, u)) * (1 - 0.2 * p.air);
      k += B.k[3] * smooth01(B.uArc - e, B.uArc + e, u) * (1 - smooth01(B.u[3] - e, B.u[3] + e, u)) * (1 - 0.15 * p.air);
      // the aim: the head (fast) and the arc behind it (slow) turn toward it
      k += p.arcD / (B.seg[3] / B.L * B.L) * smooth01(B.uArc - e, B.uArc + e, u) * (1 - smooth01(B.u[3] - e, B.u[3] + e, u));
      k += (p.headD + (p.wob || 0)) / (0.22) * smooth01(0.88, 0.92, u);
      // a slow sway travelling up the neck (parts move one after another)
      k += 0.9 * Math.sin(2 * Math.PI * (u * 1.3 - p.t * 0.22)) * smooth01(B.uBase, 1, u) * (0.6 + 0.4 * (1 - p.crawl)) * (1 - p.air);
      // P65h: the head and neck ride the wave (each passing hump nods the neck), the lying part ripples a little: a
      // visible crawl, not a sliding rigid shape
      if (cw > 0.02)
        k += (1.7 * smooth01(B.uBase, 1, u) + 0.9 * (1 - smooth01(B.uBase, B.uBase + 0.1, u)))
          * cw
          * (1 - p.air)
          * Math.sin(2 * Math.PI * (u * 3.2 + wph));
      // the tail tip curls up a little
      k += 2.2 * (1 - smooth01(0, 0.07, u)) * (0.4 + 0.6 * p.air);
      // P57: writhing in the air after a blow
      if (p.thr > 0.02) k += p.thr * 5 * Math.sin(2 * Math.PI * (u * 1.5 - p.t * 2.6)) * smooth01(0.04, 0.25, u);
      // P112: str 1 = straight (the spring), < 0 = coiled; curl = the tuck of a flip (a ball: the belly inside)
      if (p.str || p.curl) k = k * (1 - (p.str || 0)) - (p.curl || 0) * 2.9;
      return k;
    };
    // integrate from the base's front corner (the anchor) both ways; contracted rings are shorter
    // P65h: while crawling the contraction waves are bolder (a contracted ring is shorter and fatter and grips; the
    // extended ones between lift and stretch forward)
    const cw = p.crawl || 0, ef = p.eff || 0, lenK = 0.2 + 0.2 * cw + 0.08 * ef, bulK = 0.16 + 0.14 * cw + 0.06 * ef;
    const iC = Math.round(B.uBase * (NS - 1)),
      bump = u => {
        const q = Math.sin(2 * Math.PI * (u * 3.2 + wph));
        return q > 0 ? q * q : 0;
      };
    const len = u => ds * (1 - lenK * bump(u));
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
    if (p.air > 0) {
      let cx = 0, cy = 0;
      for (let i = 0; i < NS; i++) {
        cx += SP.x[i];
        cy += SP.y[i];
      }
      cx /= NS;
      cy /= NS;
      for (let i = 0; i < NS; i++) {
        SP.x[i] -= cx * p.air;
        SP.y[i] -= (cy) * p.air;
      }
    }
    for (let i = 0; i < NS; i++) {
      // annuli: bulges with grooves between
      const u = i / (NS - 1),
        seg = (u > SADDLE0 - 0.01 && u < SADDLE1 + 0.01) || u > 0.9
          ? 1
          : 0.9 + 0.1 * Math.pow(Math.abs(Math.sin(u * Math.PI * SEGS)), 0.45);
      SP.r[i] = radius(u) * seg * (1 + bulK * bump(u)) * (1 + 0.02 * Math.sin(p.t * 2.4)); SP.b[i] = bump(u);
    }
    // the lying part keeps its belly on the ground (its centre line rises and falls with its girth)
    // P65h: the moving (extended) rings lift a little, the gripping ones stay down
    if (p.air < 1)
      for (let i = 0; i < iC; i++) {
        const g = -0.5 + SP.r[i] + (SP.y[i] - (-0.5 + R_FRONT));
        SP.y[i] += (g - SP.y[i]) * (1 - p.air);
        SP.y[i] += 0.05 * cw * (1 - bump(i / (NS - 1))) * Math.min(1, i / 12) * (1 - p.air);
      }
    return SP;
  }
  /* P38-R4: BufferGeometry.computeVertexNormals without its per-triangle Vector3 work and attribute accessors (it was
   * ~40 % of the
   * allocation and ~1 ms per frame for 16 worms): the area-weighted average of the face normals, on the raw typed
   * arrays. C: void face_normals(const f32 *pos, const u32 *idx, u32 ntri, f32 *nrm, u32 nvert). */
  function faceNormals(g) {
    const pos = g.attributes.position.array, nrm = g.attributes.normal.array, idx = g.index.array, n = idx.length;
    nrm.fill(0);
    for (let t = 0; t < n; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const cx = pos[c] - pos[b],
        cy = pos[c + 1] - pos[b + 1],
        cz = pos[c + 2] - pos[b + 2],
        ax = pos[a] - pos[b],
        ay = pos[a + 1] - pos[b + 1],
        az = pos[a + 2] - pos[b + 2];
      const nx = cy * az - cz * ay, ny = cz * ax - cx * az, nz = cx * ay - cy * ax;
      nrm[a] += nx;
      nrm[a + 1] += ny;
      nrm[a + 2] += nz;
      nrm[b] += nx;
      nrm[b + 1] += ny;
      nrm[b + 2] += nz;
      nrm[c] += nx;
      nrm[c + 1] += ny;
      nrm[c + 2] += nz;
    }
    for (let i = 0; i < nrm.length; i += 3) {
      const l = Math.sqrt(nrm[i] * nrm[i] + nrm[i + 1] * nrm[i + 1] + nrm[i + 2] * nrm[i + 2]) || 1;
      nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
    }
    g.attributes.normal.needsUpdate = true;
  }
  /* the tube mesh from a spine (SP-shaped arrays: body-local x, y, tangent angle a, radius r at NS samples) */
  function buildRings(g, sp) {
    const pos = g.attributes.position.array, nrm = g.attributes.normal.array;
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
    faceNormals(g);                                               // (the grooves tilt the normals: the segments catch the light)
    g.computeBoundingBox();                                       // (live shape: picking / tests read it)
    return sp;
  }
  A.faceNormals = faceNormals;                                  // (tests)
  A.wormSpine = p => spine(Object.assign({ t: 0, crawl: 0, air: 0, headD: 0, arcD: 0, wave: 0 }, p));   // tests / tools
  const HEAD_NAT = 2.27 - 3.32;                // the head's heading in the rest pose (rad, facing frame)
  const EYE_GEO = new T.SphereGeometry(0.075, 16, 12),
    PUPIL_GEO = new T.SphereGeometry(0.043, 12, 8),
    GLINT_GEO = new T.SphereGeometry(0.011, 6, 4);
  // P43: an eyelid = a skin half sphere (pole up) a little bigger than the eye; rotated about the head axis it covers
  // the eye from the top (render/idleview.js face())
  const LID_GEO = new T.SphereGeometry(0.075, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    LID_MAT = new T.MeshStandardMaterial({ color: 0xf0a291, roughness: 0.45, emissive: 0x1c0e0b });
  const IDLE_OFF = { k: 0 },
    IDLE_CTX = { air: false, aiming: false, f: 1, inSec: true, active: false, crawl: 0, burn: false, wet: 0, zs: 1 };
  // shared by every worm / grave (one copy each; before, every new map leaked a set per worm and per grave)
  const SLAB_GEO = new T.BoxGeometry(0.46, 0.62, 0.16), CAP_GEO = new T.SphereGeometry(0.23, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  let STONE = null;
  const GHOST_GEO = new T.CapsuleGeometry(0.3, 0.38, 6, 14), RIM_GEO = new T.CapsuleGeometry(0.38, 0.38, 6, 14);
  const SKIN_FILL = new T.Color(0.11, 0.055, 0.045);
  const MOUTH_GEO = new T.SphereGeometry(0.048, 12, 8), MOUTH_MAT = new T.MeshStandardMaterial({ color: 0x3a0a0e, roughness: 0.6 });
  // ASSET: worm_hands (part of models/worm.glb)
  const GRIPW = new Float32Array(6), v4g = new T.Vector3();
  // a little self-light: a worm in shade stays pink, never black
  const ELBOW_GEO = new T.SphereGeometry(0.031, 8, 6),
    HAND_GEO = new T.SphereGeometry(0.045, 10, 8),
    ARM_GEO = new T.CylinderGeometry(0.026, 0.03, 1, 8),
    HAND_MAT = new T.MeshStandardMaterial({ color: 0xf2a092, roughness: 0.55, emissive: 0x1c0c08 });
  const SKIN = new T.MeshPhysicalMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.42,
    sheen: 0.7,
    sheenColor: new T.Color(0xffd0c4),
    sheenRoughness: 0.45,
    clearcoat: 0.45,
    clearcoatRoughness: 0.35
  });
  const EYE = new T.MeshStandardMaterial({ color: 0xf3f0ee, roughness: 0.2 });
  const PUPIL = new T.MeshStandardMaterial({ color: 0x111111, roughness: 0.1 });
  const GLINT = new T.MeshBasicMaterial({ color: 0xffffff });

  /* P29e (user 2026-10-08): a worm hit by lightning blinks x-ray-like back and forth for ZAP_T s: a translucent cyan
   * shell with small bones inside (vertebrae along the live spine, rib rings, a skull), light-blue electric arcs
   * crawling around it and a cyan glow. Render-only (Math.random is fine here); built on the worm's first zap.
   * ASSET: vfx_xray_skeleton (docs/ASSET_PROMPTS.md: a stylised worm skeleton mesh could replace the instances) */
  const ZAP_T = 1.2, NVERT = 24, NRIB = 9, ARCS = 7, ARC_SEG = 9;
  const BONE_GEO = new T.SphereGeometry(1, 8, 6), RIB_GEO = new T.TorusGeometry(1, 0.09, 4, 14);
  // (seen through the shell)
  const BONE_MAT = new T.MeshBasicMaterial({ color: 0xe6fbff, transparent: true, opacity: 1, depthTest: false, depthWrite: false });
  // x-ray: dark film, bright bones
  const XR_MAT = new T.MeshBasicMaterial({ color: 0x0c3f7a, transparent: true, opacity: 0.62, depthWrite: false });
  const ARC_MAT = new T.LineBasicMaterial({
    color: 0x9fe8ff,
    transparent: true,
    opacity: 0.95,
    blending: T.AdditiveBlending,
    depthWrite: false
  });
  for (const m of [BONE_MAT, XR_MAT, ARC_MAT, MOUTH_MAT, HAND_MAT, LID_MAT]) m.userData.shared = true;
  /* P43: the face and the hands are drawn in the transparent pass AFTER the x-ray silhouette (renderOrder 8): an eye or
   * a hand in front of the body surface wrote
   * its depth in the opaque pass and the x-ray film (the body "behind" it) tinted it pink; now the body alone is in the
   * depth buffer when the film is drawn */
  const FACE_RO = 9;
  for (const m of [EYE, PUPIL, GLINT, MOUTH_MAT, HAND_MAT, LID_MAT]) m.transparent = true;   // (A.clear must not dispose them)
  const zm = new T.Matrix4(),
    zq = new T.Quaternion(),
    zs = new T.Vector3(),
    zp = new T.Vector3(),
    zAxis = new T.Vector3(0, 0, 1),
    RIB_Q = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), Math.PI / 2);
  function makeZap(v) {
    const z = { shell: new T.Mesh(v.geo, XR_MAT), bones: new T.InstancedMesh(BONE_GEO, BONE_MAT, NVERT + 1),
      ribs: new T.InstancedMesh(RIB_GEO, BONE_MAT, NRIB),
      arcs: new T.LineSegments(new T.BufferGeometry(), ARC_MAT),
      glow: new T.Sprite(
        new T.SpriteMaterial({
          map: glowTx,
          color: 0x58cfff,
          transparent: true,
          opacity: 0,
          blending: T.AdditiveBlending,
          depthWrite: false
        })
      ) };
    z.arcs.geometry.setAttribute(
      'position',
      new T.BufferAttribute(new Float32Array(ARCS * ARC_SEG * 2 * 3), 3).setUsage(T.DynamicDrawUsage)
    );
    for (const m of [z.shell, z.bones, z.ribs, z.arcs]) {
      m.frustumCulled = false;
      m.visible = false;
      v.body.add(m);
    }
    z.shell.renderOrder = 9;
    z.bones.renderOrder = 10;
    z.ribs.renderOrder = 10;
    z.arcs.renderOrder = 11;
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
      // skull
      {
        const i = Math.round(0.955 * (NS - 1)), r = sp.r[i];
        zq.setFromAxisAngle(zAxis, sp.a[i]);
        zs.set(r * 0.7, r * 0.62, r * 0.6);
        zp.set(sp.x[i], sp.y[i], 0);
        zm.compose(zp, zq, zs);
        z.bones.setMatrixAt(NVERT, zm);
      }
      for (let n = 0; n < NRIB; n++) {                                    // rib rings around the fat front of the body
        const i = Math.round((0.26 + 0.3 * n / (NRIB - 1)) * (NS - 1)), r = sp.r[i] * 0.66;
        zq.setFromAxisAngle(zAxis, sp.a[i]).multiply(RIB_Q);   // the ring's plane across the spine
        zs.set(r, r, r);
        zp.set(sp.x[i], sp.y[i], 0);
        zm.compose(zp, zq, zs);
        z.ribs.setMatrixAt(n, zm);
      }
      z.bones.instanceMatrix.needsUpdate = true; z.ribs.instanceMatrix.needsUpdate = true;
    }
    // electric arcs: jagged polylines hugging the body, re-rolled every frame (flicker)
    const pa = z.arcs.geometry.attributes.position.array;
    let o = 0;
    for (let q = 0; q < ARCS; q++) {
      let i = Math.floor(Math.random() * (NS - 20)) + 10, th = Math.random() * 6.283, x0 = 0, y0 = 0, z0 = 0;
      for (let s = 0; s <= ARC_SEG; s++) {
        i = Math.max(0, Math.min(NS - 1, i + Math.round((Math.random() * 2 - 0.4) * 5))); th += (Math.random() - 0.5) * 1.6;
        const r = sp.r[i] * (1.25 + Math.random() * 0.55), nx = -Math.sin(sp.a[i]), ny = Math.cos(sp.a[i]);
        const x1 = sp.x[i] + nx * Math.cos(th) * r, y1 = sp.y[i] + ny * Math.cos(th) * r, z1 = Math.sin(th) * r * 1.04;
        if (s > 0) {
          pa[o++] = x0;
          pa[o++] = y0;
          pa[o++] = z0;
          pa[o++] = x1;
          pa[o++] = y1;
          pa[o++] = z1;
        }
        x0 = x1; y0 = y1; z0 = z1;
      }
    }
    z.arcs.geometry.attributes.position.needsUpdate = true;
    const mid = Math.round(0.5 * (NS - 1));
    z.glow.position.set(sp.x[mid], sp.y[mid] + 0.1, 0);
    z.glow.material.opacity = (0.18 + 0.2 * Math.random()) * (1 - k * 0.6);
  }

  A.makeWorm = function (scene, w) {
    const team = C.TEAMS[w.team];
    const root = new T.Group(), body = new T.Group();
    root.rotation.order = 'YXZ';
    const geo = makeBody(team.rgb);
    // receiveShadow off (user: worms went black in the desert sun when the cut face shaded them); a warm skin fill
    // below
    const mesh = new T.Mesh(geo, SKIN.clone());
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    body.add(mesh);
    const eyes = new T.Group();
    body.add(eyes);
    const pupils = [], lids = [], glints = [];
    for (const z of [-0.075, 0.075]) {
      const e = new T.Mesh(EYE_GEO, EYE);
      e.position.set(0, 0, z);
      e.scale.set(0.85, 1.15, 0.85);
      eyes.add(e);
      const p = new T.Mesh(PUPIL_GEO, PUPIL);
      p.position.set(0.05, 0, z * 1.1);
      eyes.add(p);
      pupils.push(p);
      const gl = new T.Mesh(GLINT_GEO, GLINT);
      gl.position.set(0.075, 0.025, z * 1.1 + 0.012);
      eyes.add(gl);
      glints.push(gl);
      const lid = new T.Mesh(LID_GEO, LID_MAT);
      lid.position.set(0, 0, z);
      lid.scale.set(0.96, 1.29, 0.96);
      lid.visible = false;
      eyes.add(lid);
      lids.push(lid);
    }
    // the mouth: a dark notch at the head tip; its shape is the expression (line / open 'whee' / scared O)
    const mouth = new T.Mesh(MOUTH_GEO, MOUTH_MAT);
    body.add(mouth);
    mouth.renderOrder = FACE_RO; eyes.traverse(o => { o.renderOrder = FACE_RO; });
    root.add(body);
    // held weapon (visible while aiming): one model per weapon (render/ordnance.js held(), made on first use)
    const held = new T.Group();
    root.add(held);
    // little worm hands on short arms (shown with a held weapon): skin-coloured, from the chest to the grips
    const hands = [0, 1].map(() => {
      // P43: fore + elbow = a bent arm for the idle antics
      const hand = new T.Mesh(HAND_GEO, HAND_MAT),
        arm = new T.Mesh(ARM_GEO, HAND_MAT),
        fore = new T.Mesh(ARM_GEO, HAND_MAT),
        elbow = new T.Mesh(ELBOW_GEO, HAND_MAT);
      hand.castShadow = arm.castShadow = fore.castShadow = elbow.castShadow = true;
      hand.renderOrder = arm.renderOrder = fore.renderOrder = elbow.renderOrder = FACE_RO;
      hand.visible = arm.visible = fore.visible = elbow.visible = false;
      root.add(hand, arm, fore, elbow);
      return { hand, arm, fore, elbow, elbOn: false, ex: 0, ey: 0, ez: 0 };
    });
    // x-ray silhouette when hidden behind terrain (same live geometry)
    const xray = new T.Mesh(
      geo,
      new T.MeshBasicMaterial({ color: team.rgb, transparent: true, opacity: 0.45, depthFunc: T.GreaterDepth, depthWrite: false })
    );
    xray.renderOrder = 8; xray.frustumCulled = false; body.add(xray);
    const ghost = new T.Group();
    const gBody = new T.Mesh(
      GHOST_GEO,
      new T.MeshBasicMaterial({ color: team.rgb, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false })
    );
    const gRim = new T.Mesh(
      RIM_GEO,
      new T.MeshBasicMaterial({ color: 0xff2020, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, side: T.BackSide })
    );
    gBody.renderOrder = 11; gRim.renderOrder = 10; ghost.add(gRim, gBody);
    // the cave overview keeps the section rule on: a marker in front of the plane must still show
    SS.section.exempt(gBody.material, 'overview marker of a worm off the section');
    SS.section.exempt(gRim.material, 'overview marker of a worm off the section');
    scene.add(root, ghost);
    const pose = { t: 0, crawl: 0, eff: 0, air: 0, headD: 0, arcD: 0, wave: (w.id || 0) * 0.37 };
    return {
      root,
      body,
      mesh,
      geo,
      eyes,
      pupils,
      lids,
      glints,
      mouth,
      held,
      hands,
      heldBy: {},
      batT: 0,
      flinchT: 0,
      stars: null,
      ghost,
      ghostMats: [gBody.material, gRim.material],
      phase: (w.id || 0) * 1.7,
      flash: 0,
      flame: null,
      pose,
      tilt: 0,
      lastS: null
    };
  };

  A.makeGrave = function (scene, g, w) {
    if (SS.graveView) {
      const team = w && C.TEAMS[w.team] ? C.TEAMS[w.team].rgb : 0x888888, grp = SS.graveView.make(g, team, w && w.name);
      scene.add(grp);
      return grp;
    }
    const grp = new T.Group();
    const stoneMat = STONE || (STONE = new T.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85 }));
    const slab = new T.Mesh(SLAB_GEO, stoneMat);
    slab.position.y = 0.0;
    const cap = new T.Mesh(CAP_GEO, stoneMat);
    cap.scale.z = 0.35;
    cap.position.y = 0.31;
    grp.add(slab, cap);
    grp.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
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
  let scene = null, rope, ropeKnot, trailT = 0, hookM = null, hookLine = null, glowTx = null;
  const teles = [];   // PoC teleFx: live beam effects
  const worms = new Map(), projs = new Map(), graves = new Map(), powerDots = [], keptRopes = [];
  /* P38 A5: hands + arms are children of the root, but the body they hang on is rotated / squashed / flipped on its own
   * (salto, lean, bat
   * spin): the early pose code queues each hand as (hand point, shoulder point, in which frame each is) and
   * flushHands() resolves the body-local points with the body's matrix of THIS frame once it is final, so an arm never
   * detaches from a flipping worm. */
  const hq = [], hv = new T.Vector3(), sv = new T.Vector3();
  function qhand(hd, px, py, pz, sx, sy, sz, handBody, shBody) { hq.push(hd, px, py, pz, sx, sy, sz, handBody, shBody); }
  function armSeg(m, ax, ay, az, bx, by, bz) {                 // a cylinder arm segment from a to b
    const dx = bx - ax, dy = by - ay, dz = bz - az, L = Math.hypot(dx, dy, dz) || 1e-3;
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.scale.set(1, L, 1);
    m.quaternion.setFromUnitVectors(yAxis, v4.set(dx / L, dy / L, dz / L));
  }
  function flushHands(v) {
    for (const hd of v.hands) { hd.fore.visible = hd.elbow.visible = false; }
    for (let i = 0; i < hq.length; i += 9) {
      const hd = hq[i];
      hv.set(hq[i + 1], hq[i + 2], hq[i + 3]);
      sv.set(hq[i + 4], hq[i + 5], hq[i + 6]);
      if (hq[i + 7]) hv.applyMatrix4(v.body.matrix);
      if (hq[i + 8]) sv.applyMatrix4(v.body.matrix);
      hd.hand.position.copy(hv);
      if (hd.elbOn) {                                           // P43: a bent arm (shoulder - elbow - hand)
        armSeg(hd.arm, sv.x, sv.y, sv.z, hd.ex, hd.ey, hd.ez);
        armSeg(hd.fore, hd.ex, hd.ey, hd.ez, hv.x, hv.y, hv.z);
        hd.elbow.position.set(hd.ex, hd.ey, hd.ez);
        hd.fore.visible = hd.elbow.visible = hd.arm.visible;
        hd.elbOn = false;
      } else armSeg(hd.arm, sv.x, sv.y, sv.z, hv.x, hv.y, hv.z);
    }
    hq.length = 0;
  }
  const v4 = new T.Vector3(), ropeB = new T.Vector3(), yAxis = new T.Vector3(0, 1, 0), RED = new T.Color(0xff2a10);

  A.init = function (sc, tx) {
    scene = sc; glowTx = tx.glow;
    rope = new T.Mesh(new T.CylinderGeometry(0.025, 0.025, 1, 6, 1, true), new T.MeshStandardMaterial({ color: 0xe9d08a, roughness: 0.7 }));
    rope.castShadow = true; scene.add(rope);
    ropeKnot = new T.Mesh(
      new T.SphereGeometry(0.1, 10, 8),
      new T.MeshStandardMaterial({ color: 0xcfcfd6, metalness: 0.8, roughness: 0.3 })
    );
    scene.add(ropeKnot);
    // the grappling hook: flies out on its line (S.hook), then sits in the anchor pointing into the rock
    if (SS.ordnance) {
      hookM = SS.ordnance.hook();
      hookM.scale.setScalar(1.4);
      hookM.visible = false;
      scene.add(hookM);
    }
    hookLine = new T.Mesh(rope.geometry, rope.material); hookLine.visible = false; scene.add(hookLine);
    if (SS.travView) SS.travView.init(scene);                            // P37 W2: rope / parachute / zipline drawing
    if (SS.aimView) SS.aimView.init(scene, tx);                          // P104: the reticle + the dotted aim line (render/aimline.js)
    for (let i = 0; i < 14; i++) {
      const s = new T.Sprite(new T.SpriteMaterial({ map: tx.glow, depthTest: false, transparent: true, blending: T.AdditiveBlending }));
      s.renderOrder = 12;
      s.visible = false;
      scene.add(s);
      powerDots.push(s);
    }
  };
  A.clear = function () {
    if (SS.aimView) SS.aimView.hide();
    // per-worm materials (team colours, held weapon, x-ray, ghost) are disposed; shared geometries / eye materials stay
    const keep = new Set([EYE, PUPIL, GLINT, STONE]);
    for (const v of worms.values()) {
      scene.remove(v.root, v.ghost);
      for (const g of [v.root, v.ghost]) g.traverse(o => {
        if (o.isMesh && o.material)
          for (const m of [].concat(o.material))
            if (!keep.has(m) && !m.userData.shared) m.dispose();
      });
      if (v.geo) v.geo.dispose();                                  // P8: each worm owns its live body geometry
      SS.mat.disposeTree(v.held); SS.mat.disposeTree(v.stars);     // P38-R2: held weapon models and the dizzy stars own geometries
      if (v.flame) SS.bodyView.unflame(v.flame);
      if (v.wm)
        for (const m of v.wm.values()) m.dispose();
      if (v.zap) {
        v.zap.arcs.geometry.dispose();
        v.zap.bones.dispose();
        v.zap.ribs.dispose();
        v.zap.glow.material.dispose();
      }
    }
    for (const v of projs.values()) scene.remove(v);
    // (P38-R2: ghost clones of the body geometry, beam sprites)
    for (const f of teles) {
      scene.remove(f.grp);
      SS.mat.disposeTree(f.grp);
    }
    teles.length = 0;
    for (const v of graves.values()) {
      scene.remove(v);
      if (SS.graveView) SS.graveView.dispose(v);
    }
    worms.clear(); projs.clear(); graves.clear();
    if (SS.travView) SS.travView.clear();
  };
  /* P37: the world position of a worm's face (the eyes group) and its heading: out = { x, y, z, yaw, ha } (the face
   * hugger sits there) */
  A.head_world = (w, out) => {
    const v = worms.get(w);
    if (!v || !v.eyes) return false;
    v.root.updateMatrixWorld(true);
    const e = v.eyes.matrixWorld.elements;
    out.x = e[12];
    out.y = e[13];
    out.z = e[14];
    out.yaw = v.root.rotation.y;
    out.ha = v.eyes.rotation.z;
    return true;
  };
  // (P37: v = the whole view record: render/worn.js attaches hats / masks to its body group)
  A.vis = w => {
    const v = worms.get(w);
    return v ? { group: v.root, body: v.mesh, ghost: v.ghost, v } : null;
  };
  // P37 W4 (knockout punch): the worm spins head over tail (rate rad/s) until it lands (the same mechanism as the
  // bat's)
  A.tumble = (w, rate) => {
    const v = worms.get(w);
    if (v) {
      v.batT = 3;
      if (SS.softView) SS.softView.twist(w, rate);
    }
  };
  /* PoC teleFx (game.js L3891, user: "the one from PoC was perfect"): beamed across: columns of light stand at both
   * ends; the worm dissolves at the source as it materialises at the destination (ghost copies of its body, the source
   * fading and stretching up, the destination fading in from a stretched pose); the real worm is hidden for the 1.5 s;
   * 42 flickering light streaks per beam (cyan / pale cyan, additive), glow motes rising; a deployment (arrival) has
   * no source and its ghost follows the worm. PoC px -> m x 0.0643. */
  const TELE_DUR = 1.5, PXM = 0.0643;
  function teleBeam(p) {
    const b = new T.Group();
    b.position.set(p.x, p.y + 14 * PXM, p.z);
    for (let i = 0; i < 42; i++) {
      const sp = new T.Sprite(
        new T.SpriteMaterial({
          map: glowTx,
          color: i % 3 ? 0x60dcff : 0xc7faff,
          transparent: true,
          opacity: 0,
          blending: T.AdditiveBlending,
          depthWrite: false
        })
      );
      const r = (a, c) => a + Math.random() * (c - a);
      sp.position.set(r(-13, 13) * PXM, r(-18, 65) * PXM, r(-6, 6) * PXM);
      sp.scale.set(r(0.45, 1.6) * PXM * 2.2, r(35, 120) * PXM, 1);
      sp.userData = { start: r(0, 0.8), dur: r(0.06, 0.18), seed: r(0, 100) }; sp.renderOrder = 9; b.add(sp);
    }
    const motes = [];
    for (let i = 0; i < 18; i++) {
      const m = new T.Sprite(
        new T.SpriteMaterial({
          map: glowTx,
          color: 0xbfe6ff,
          transparent: true,
          opacity: 0,
          blending: T.AdditiveBlending,
          depthWrite: false
        })
      );
      m.scale.setScalar(0.09);
      m.userData = { ph: Math.random(), x: (Math.random() - 0.5) * 0.9, z: (Math.random() - 0.5) * 0.4, v: 0.6 + Math.random() * 2.2 };
      b.add(m);
      motes.push(m);
    }
    b.userData.motes = motes;
    return b;
  }
  function teleGhost(v, p) {
    const g = new T.Group();
    g.position.set(p.x, p.y, p.z);
    g.rotation.copy(v.root.rotation);
    const m = new T.Mesh(
      v.geo.clone(),
      new T.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.5, emissive: 0x2a6f8a, emissiveIntensity: 0.6, transparent: true,
        depthWrite: false, opacity: 0
      })
    );
    m.frustumCulled = false; m.renderOrder = 8;
    const body = new T.Group();
    body.add(m);
    g.add(body);
    g.userData.body = body;
    g.userData.mat = m.material;
    return g;
  }
  function teleStart(e) {
    const v = worms.get(e.worm);
    if (!v) return;
    const arrival = !!e.deploy, grp = new T.Group();
    const src = arrival ? null : teleGhost(v, e.from),
      dst = teleGhost(v, e.to),
      bs = arrival ? null : teleBeam(e.from),
      bd = teleBeam(e.to);
    for (const o of [src, dst, bs, bd])
      if (o) grp.add(o);
    scene.add(grp);
    teles.push({ w: e.worm, grp, src, dst, bs, bd, arrival, t: 0 });
  }
  function teleStep(dt) {
    for (let i = teles.length - 1; i >= 0; i--) {
      const f = teles[i];
      f.t += dt;
      const k = f.t / TELE_DUR;
      if (k >= 1 || f.w.dead) {
        scene.remove(f.grp);
        f.grp.traverse(o => {
          if (o.material) o.material.dispose();
          if (o.isMesh && o.geometry) o.geometry.dispose();
        });
        teles.splice(i, 1);
        continue;
      }
      if (f.arrival) {
        f.dst.position.set(f.w.pos.x, f.w.pos.y, f.w.pos.z);
        f.bd.position.set(f.w.pos.x, f.w.pos.y + 14 * PXM, f.w.pos.z);
      }
      const cl = x => Math.max(0, Math.min(1, x)), out = cl((k - 0.1) / 0.6), inn = cl((k - 0.35) / 0.55), glow = Math.sin(Math.PI * cl(k));
      if (f.src) {
        f.src.userData.mat.opacity = 1 - out;
        f.src.userData.body.scale.y = 1 + out * 0.25;
      }
      f.dst.userData.mat.opacity = inn; f.dst.userData.body.scale.y = 1.25 - inn * 0.25;
      for (const b of [f.bs, f.bd])
        if (b) {
          for (const c of b.children) {
            const u = c.userData;
            if (u.start == null) continue;
            const pulse = ((k + u.seed) % 0.24) / 0.24, vis = k > u.start && k < u.start + u.dur + 0.22 && pulse < 0.7;
            c.material.opacity = vis ? glow * (0.55 + 0.45 * Math.sin(pulse / 0.7 * Math.PI)) : 0;
          }
          for (const m of b.userData.motes) {
            const ph = (m.userData.ph + f.t * m.userData.v * 0.4) % 1;
            m.position.set(m.userData.x, -26 * PXM + ph * 2.4, m.userData.z);
            m.material.opacity = glow * (1 - ph) * 0.9;
          }
        }
    }
  }
  A.teleporting = w => teles.some(f => f.w === w);
  A.teleDebug = () => teles.map(f => {
    const g = f.dst, m = g.userData.body.children[0], bb = new T.Box3().setFromObject(g);
    return {
      k: +(f.t / TELE_DUR).toFixed(2),
      dst: g.position.toArray().map(v => +v.toFixed(2)),
      op: +g.userData.mat.opacity.toFixed(2),
      src: f.src ? +f.src.userData.mat.opacity.toFixed(2) : null,
      box: [bb.min.toArray().map(v => +v.toFixed(2)), bb.max.toArray().map(v => +v.toFixed(2))],
      vis: g.visible && f.grp.visible,
      inScene: !!f.grp.parent
    };
  });
  A.onEvent = function (S, e) {
    if (e.type === 'teleport' && e.worm) teleStart(e);
    if (e.type === 'zap' && e.worm) {
      const v = worms.get(e.worm);
      if (v) {
        if (!v.zap) v.zap = makeZap(v);
        v.zapT = viewTime;
        v.flinchT = 0.9;
      }
    }
    if (e.type === 'hurt' && e.worm) {
      const v = worms.get(e.worm);
      if (!v) return;
      v.flash = Math.min(1, 0.45 + e.amount / 40);
      // P37-8: the soft body dents along the hit vector first (softview.js; the throw follows: 'batfly')
      if (e.src === C.DS.BAT) {
        v.hitFly = true; v.flinchT = 0.3;
      }
      else v.flinchT = 0.5;                                                                          // a flinch, eyes shut
    }
    if (e.type === 'batfly' && e.worm) {                                  // thrown: terrified
      // (terrified face while it flies; the flight itself is the soft body's)
      const v = worms.get(e.worm);
      if (v) v.batT = 3;
    }
    // a blast nearby makes every worm within reach flinch (eyes shut, a twitch) even when it was not hurt
    if (e.type === 'explode')
      for (const w of S.worms) {
        if (w.dead) continue;
        const d = Math.hypot(w.pos.x - e.x, w.pos.y - e.y, w.pos.z - e.z);
        if (d < 3 * (e.R || 3)) {
          const v = worms.get(w);
          if (v) v.flinchT = Math.max(v.flinchT, 0.45 * (1 - d / (3 * (e.R || 3))) + 0.15);
        }
      }
    // a hard landing: the worm burrows into the ground for a moment and pops back out (dust)
    if (e.type === 'land' && e.hard && e.worm && !e.worm.dead) {
      const v = worms.get(e.worm);
      if (v) {
        v.batT = 0;
        if (SS.fx && SS.fx.dust) SS.fx.dust(e.x, e.y, e.z, 12, 0.7, 0x8a6a48);
      }
    }
    // P37-8: landed after the bat: a headache
    if (e.type === 'land' && e.worm) {
      const v = worms.get(e.worm);
      if (v && v.batT > 0) {
        v.batT = Math.min(v.batT, 0.3);
        if (v.hitFly) {
          v.hitFly = false;
          v.ache = 3.4;
        }
      }
    }
  };
  let viewTime = 0;
  A.sync = function (S, view, ctxA, insp, dt) {
    dt = dt || 1 / 60;
    viewTime = view.time;
    if (SS.ordnance) SS.ordnance.tick(view.time);
    if (teles.length) teleStep(dt);
    const d = P.dir(S), a = S.active;
    syncRopeAim(S, view, a);
    // (it draws the rope, kept ropes, chute, zipline)   // (before the worms: their hands grip the rope / risers /
    // handle)
    if (SS.travView) {
      rope.visible = ropeKnot.visible = false;
      for (const m of keptRopes) m.visible = false;
      SS.travView.sync(S, view, a, dt);
    }
    syncWorms(S, view, d, insp, dt);
    syncProjectiles(S, dt);
  };

  /* P38 S1: the underwater mode. The water's section face is a translucent quad drawn AFTER the opaque pass, so a
   * sunken worm sat
   * under 75-95 % water colour while its (shared, bright) eye materials did not: a flat leaf with a floating eye. A
   * submerged worm is drawn in the transparent pass after the face (renderOrder 6.6, depth-tested) with its own copies
   * of the shared materials. */
  const WET_FILL = new T.Color(0.02, 0.075, 0.1), WET_RO = 6.6;
  function wetMode(v, on) {
    if (!!v.wetOn === on) return;
    v.wetOn = on;
    if (on && !v.wm)
      v.wm = new Map([
        [EYE, EYE.clone()],
        [PUPIL, PUPIL.clone()],
        [GLINT, GLINT.clone()],
        [MOUTH_MAT, MOUTH_MAT.clone()],
        [HAND_MAT, HAND_MAT.clone()]
      ]);
    const swap = o => {
      if (!o.isMesh) return;
      if (on) {
        const c = v.wm.get(o.material);
        if (c) {
          o.userData.dry = o.material;
          o.material = c;
        }
      } else if (o.userData.dry) {
        o.material = o.userData.dry;
        o.userData.dry = null;
      }
    };
    const flag = o => {
      if (!o.isMesh) return;
      o.renderOrder = on ? WET_RO : FACE_RO;
      for (const m of [].concat(o.material)) { m.transparent = true; }
    };
    for (const g of [v.eyes, v.mouth]) {
      g.traverse(swap);
      g.traverse(flag);
    }
    for (const hd of v.hands)
      for (const o of [hd.hand, hd.arm]) {
        swap(o);
        flag(o);
      }
    v.mesh.renderOrder = on ? WET_RO : 0; v.mesh.material.transparent = on;
  }
  /* the pull on a hanging worm's head (unit, plane): toward the rope anchor, straight up under the canopy / on the
   * zipline handle */
  const PULL_UP = { x: 0, y: 1 }, PULL = { x: 0, y: 1 };
  function ropePull(S, w, s0) {
    const dx = S.rope.s - s0, dy = S.rope.y - w.pos.y, l = M.len2(dx, dy) || 1;
    PULL.x = dx / l;
    PULL.y = dy / l;
    return PULL;
  }
  /* P47: the infected body (a chest that swells and pulses) edits the live spine's radii before the tube is built
   * (render/infect.js) */
  function alienPre(S, w, v, dt, spl) {
    if (SS.alienView && SS.alienView.worm_pre) SS.alienView.worm_pre(S, w, v, spl, dt);
    return spl;
  }
  function syncWorms(S, view, d, insp, dt) {
    const a = S.active;
    for (const w of S.worms) {
      let v = worms.get(w);
      if (!v) {
        v = A.makeWorm(scene, w);
        worms.set(w, v);
      }
      // (P47: an eaten worm is gone at the bite: the alien's own carcass clone is dragged into its coils)
      if (w.dead || w.eaten) {
        v.root.visible = false; v.ghost.visible = false;
        if (v.flame) {
          SS.bodyView.unflame(v.flame);
          v.flame = null;
        }
        if (w.grave && !graves.has(w)) graves.set(w, A.makeGrave(scene, w.grave, w));
        const gv = graves.get(w);
        if (gv) {
          // (R11: the alien ate the body: the tombstone's geometry / materials / textures are freed too)
          if (!w.grave) {
            scene.remove(gv);
            if (SS.graveView) SS.graveView.dispose(gv);
            graves.delete(w);
            continue;
          }
          gv.visible = SS.view.shownAt(S, w.grave, 0.5);                    // follows the section view
          if (gv.visible && SS.graveView) SS.graveView.frame(gv, w.grave, S, P.nrm(S), view.time, dt, w);
        }
        continue;
      }
      const inSec = SS.view.inSlab(S, w.pos) || w === a;
      v.root.visible = inSec && !teles.some(f => f.w === w);       // hidden while the beam carries it (ghosts stand in)
      v.root.position.set(w.pos.x, w.pos.y, w.pos.z);
      // P86: End of the World: drawn along its own tangent (the walk cycle must not run backwards on the underside)
      const fs = w === a ? w.facing : 1, f = S.eow && SS.eowView ? SS.eowView.face(S, w, v, fs) : fs;
      // zsw: the local z sign that faces the camera
      const phiw = -Math.atan2(d.z * f, d.x * f), nnw = P.nrm(S), zsw = Math.sign(Math.sin(phiw) * nnw.x + Math.cos(phiw) * nnw.z) || 1;
      v.root.rotation.y = phiw;
      // P8: pose (crawl wave speed from the walking speed, air, the aim) -> live body, eyes and held weapon at the head
      // P38 A5: a burning worm panics (scared face, hands up, writhing) and chars
      const burnNow = S.time - (w.burnT == null ? -9 : w.burnT) < 0.3 && SS.view.inSlab(S, w.pos);
      const sw = SS.polishView ? SS.polishView.swing(w) : null;                          // P38 A5: the bat swing outlives the 'play' phase
      // (P37: the held flamethrower / minigun stays up while it fires)
      const ps = v.pose,
        airborne = w === a ? a.air || !!S.rope : !w.rest,
        aiming = w === a && (S.phase === 'play' || !!sw || (SS.weaponsA && SS.weaponsA.streaming(S, w)));
      const sNow = P.to_plane(S, w.pos).s, spd = v.lastS == null ? 0 : Math.abs(sNow - v.lastS) / Math.max(1e-3, dt);
      v.lastS = sNow;
      const crawlT = airborne ? 0 : Math.min(1, spd / (SS.sim.walk_speed ? SS.sim.walk_speed(S, w) : C.WALK));
      ps.t = view.time + v.phase;
      // P38 S1 (render/react.js): impact dents, tumble, faces, idle / victory moments, the underwater mode
      let rx = null, wet = 0, surfY = -1e9;
      const vsP = w === a ? a.vs || 0 : (w.vel ? w.vel.x * d.x + w.vel.z * d.z : 0),
        vyP = w === a ? (a.air ? a.vy || 0 : 0) : (w.vel && !w.rest ? w.vel.y : 0);
      if (inSec && SS.water && S.water && SS.water.depth(S, w.pos.x, w.pos.z) > 0.06) {
        const surf = SS.water.surface(S, w.pos.x, w.pos.z);
        surfY = surf;
        wet = w.drowning || surf - w.pos.y > 0.45 ? M.clamp((surf - w.pos.y) / 1.4, 0.15, 1) : (w.swim ? 0.01 : 0);
      }
      if (SS.reactView) {
        rx = SS.reactView.pose(S, w, v, dt, {
          air: airborne,
          vloc: vsP * f,
          vy: vyP,
          speed: airborne ? Math.hypot(vsP, vyP) : 0,
          f,
          burn: burnNow,
          active: w === a,
          crawl: crawlT,
          aiming,
          inSec,
          wet
        });
        v.wetK = wet > 0.05 ? wet : 0;
      }
      // P43 (render/idleview.js, core/idle.js): the bored-worm antics: muscle offsets, head, yaw toward the camera, the
      // face / hands / props below (null = not bored)
      IDLE_CTX.air = airborne;
      IDLE_CTX.aiming = aiming;
      IDLE_CTX.f = f;
      IDLE_CTX.inSec = inSec;
      IDLE_CTX.active = w === a;
      IDLE_CTX.crawl = crawlT;
      IDLE_CTX.burn = burnNow;
      IDLE_CTX.wet = wet;
      IDLE_CTX.zs = zsw;
      const idl = SS.idleView ? SS.idleView.pose(S, w, v, dt, IDLE_CTX) : null;
      if (idl && idl.yaw) v.root.rotation.y = phiw - zsw * idl.yaw;
      if (v.handsBig && !(idl && idl.pk > 0.02)) {
        for (const hd of v.hands) hd.hand.scale.setScalar(1);
        v.handsBig = false;
      }
      ps.crawl += (crawlT - ps.crawl) * Math.min(1, dt * 5);
      ps.air += ((airborne ? 1 : 0) - ps.air) * Math.min(1, dt * 4);
      // P65h: effort: climbing a slope (bigger contractions, a slower cadence)
      ps.eff += (M.clamp((v.slope || 0) * f / 0.6, 0, 1) * ps.crawl - ps.eff) * Math.min(1, dt * 4);
      // contraction waves run head -> tail (u + wave); P65h: the cadence follows the measured ground speed (the hump
      // pattern moves back at ~0.75 of the walk speed)
      ps.wave += dt * (0.12 + 2.6 * ps.crawl * (1 - 0.15 * ps.eff));
      // P33: swimming / struggling in the water: fast contraction waves, the head thrown up and about
      // P89: in a life jacket: a calm stroke, no thrashing
      const jkSwim = !!(w.swim && w.swim.jk);
      if (w.swim || w.ropeWet) ps.wave += dt * (jkSwim ? 0.9 : 3.2);
      // P86: the screen aim in the worm's own frame
      const aimV = S.eow && SS.eowView ? SS.eowView.aim(S, w, v, fs, f) - (v.tilt || 0) : S.aim;
      let look = aiming && !w.ropeWet
        ? aimV
        : jkSwim
        ? 0.9 + 0.1 * Math.sin(ps.t * 1.7)
        : w.swim || w.ropeWet
        ? 1.1 + 0.5 * Math.sin(ps.t * 9.0)
        : 0.25 * Math.sin(ps.t * 0.37);
      // the head takes most of the turn (its tip may rotate a lot), the arc a little: the body stays ~1 m tall
      if (idl && idl.lookW > 0.001) look += (idl.look - look) * idl.lookW;
      // P57: watching a projectile, sad, relieved
      if (rx && rx.lookW > 0.001) look += (rx.look - look) * rx.lookW;
      const want = M.clamp(look - HEAD_NAT, idl ? -0.9 : -0.5, 2.6);
      ps.headD += (Math.min(1.7, want * 0.75) - ps.headD) * Math.min(1, dt * 7);   // the head first ...
      ps.arcD += (want * 0.25 - ps.arcD) * Math.min(1, dt * 2.2);                // ... the arc behind it follows slowly
      // P37-8: the headache wobble (the bat dent is the soft body's now: softview.js)
      v.ache = Math.max(0, (v.ache || 0) - dt);
      ps.thr = rx ? Math.max(rx.thrash > 0 && !P.grounded2(S, sNow, w.pos.y) ? rx.thrash : 0, rx.struggle) : 0;
      ps.wob = (v.ache > 0 ? 0.32 * Math.sin(viewTime * 8.5) * Math.min(1, v.ache) : (rx ? rx.wob : 0)) + (idl ? idl.wob : 0);
      // P39: the MUSCLES (goal pose of the soft body: crouch before a jump, take-off stretch, breathing, the dying
      // tremble) and the posture frame; the solver turns them into motion. Nothing here rotates or scales the drawn
      // body any more. P112: the choreography of the worm's own jumps / flips (render/jumpview.js)
      const jm = SS.jumpView
        ? SS.jumpView.pose(S, w, v, dt, {
          air: w === a && !!a.air && !S.rope,
          f,
          s: sNow,
          vs: vsP,
          vy: vyP,
          slope: v.slope || 0,
          lean: v.lean || 0,
          hang: w === a && !!(S.rope || (S.zip && S.zip.state === 2) || (S.chute && S.chute.open)),
          swim: !!(w.swim || w.ropeWet),
          burn: burnNow
        })
        : null,
        jmA = jm && jm.act;
      v.jflip = jm && jm.flip ? jm.loc : 0;
      const wind = !jmA && w === a && w.windUp > 0 ? M.clamp(1 - (w.windUp - S.time) / C.WORM_DYN.JUMP_WIND, 0, 1) : 0,
        windE = wind * wind * (3 - 2 * wind);
      // a skid leans back; the wind-up crouches back
      const skid = jmA ? jm.lean : windE > 0 ? -0.62 * windE : !!w.slide && !(w === a ? a.air : !w.rest) ? -0.22 : 0;
      v.lean = (v.lean || 0) + (skid - (v.lean || 0)) * Math.min(1, dt * 8);
      // hanging on the rope / line / canopy
      v.hangA = (v.hangA || 0) + ((SS.travView ? SS.travView.hang_pose(S, w, a, sNow, f) : 0) - (v.hangA || 0)) * Math.min(1, dt * 10);
      // (P40: was 0.24: the crumple and the rebound are the soft body's now, the muscles only brace a little)
      const sqT = w.squash != null && !jmA ? (S.time - w.squash) / 0.28 : 9,
        sq = sqT >= 0 && sqT < 1 ? 0.08 * Math.sin(Math.PI * sqT) * (1 - sqT * 0.5) : 0;
      const vyb = w === a ? (a.air ? a.vy : 0) : (!w.rest && w.vel ? w.vel.y : 0),
        stch = jmA ? 0 : vyb > 2.5 ? Math.min(0.2, vyb * 0.02) : vyb < -6 && airborne ? Math.min(0.14, -vyb * 0.009) : 0,
        crch = 0.2 * windE;
      // P65h: turning round: the body bunches up, rises and the head swings over
      if (v.lastF != null && v.lastF !== f && w === a && !airborne) v.turnT = 0.34;
      v.lastF = f; v.turnT = Math.max(0, (v.turnT || 0) - dt);
      const tk = v.turnT > 0 ? Math.sin(Math.PI * (1 - v.turnT / 0.34)) : 0;
      let gsx = 1 + sq * 0.55 - stch * 0.3 + crch * 0.4 - 0.2 * tk, gsy = 1 - sq + stch - crch + 0.1 * tk, gox = 0, goy = 0;
      if (jmA) {
        gsx *= jm.sx;
        gsy *= jm.sy;
        goy += jm.oy;
      }
      if (rx) {
        gsx *= rx.sx;
        gsy *= rx.sy;
        goy += rx.oy;
        gox += rx.ox;
      }
      if (idl) {
        gsx *= idl.sx;
        gsy *= idl.sy;
        goy += idl.oy;
        gox += idl.ox;
      }
      // P38 A5: the dying beat: it trembles and swells
      {
        const sh = SS.polishView ? SS.polishView.shudder(S, w) : null;
        if (sh) {
          gox += sh.dx;
          gsx *= sh.sc;
          gsy *= sh.sc;
        }
      }
      const rs = w.flipRope != null && w.flipRope === w.flipAt;
      // a salto / rope release = a muscle torque on the body, not a drawn rotation
      let spin = w.flip && w.flipAt != null && airborne ? f * (rs ? w.flipW * w.flipK : 13) : 0;
      // P112: a back flip: the solver's frame follows the prescribed angle (jm.ang), the rate is the torque
      if (jm && jm.flip) spin = jm.om;
      // P57: a thrown worm rocks and thrashes
      if (ps.thr > 0.02) spin += f * 2.6 * ps.thr * M.cos(viewTime * 6.5 + v.phase);
      // P89: a gentle sway on the vest
      if (jkSwim) spin += f * 0.35 * M.cos(viewTime * 1.9);
      // thrashing in the water
      else if (w.swim || w.ropeWet) spin += f * 3.4 * M.cos(viewTime * 10.5);
      if (burnNow) spin += f * 2.8 * M.cos(viewTime * 23 + v.phase);                                           // a burning worm writhes
      const hanging = w === a && !!(S.rope || (S.zip && S.zip.state === 2) || (S.chute && S.chute.open));
      // the ground frame: the slope under it
      {
        const nn = P.normal2(S, sNow, w.pos.y - 0.55);
        v.slope = M.clamp(M.atan2(-nn.s, nn.y), -1.2, 1.2);
      }
      // (a sliding worm is on the ground, whatever its rest flag says)
      const grounded = (!airborne || P.grounded2(S, sNow, w.pos.y)) && !w.swim && !w.ropeWet;
      // P65h: a worm that jumped by itself flies along its velocity (stretched, nose up on the way up, nose down on the
      // way down); a blast / bat victim keeps the soft body's own tumble
      if (grounded) v.selfJump = false;
      else if (v.wasGr && w === a && !(v.flinchT > 0) && !(v.batT > 0) && vyP > 2 && !w.swim) v.selfJump = true;
      v.wasGr = grounded;
      const flyW = !jmA && v.selfJump && !hanging && !spin && !burnNow && Math.hypot(vsP, vyP) > 2.5
        ? 0.6 * M.clamp((Math.hypot(vsP, vyP) - 2.5) / 4, 0, 1)
        : 0;
      const flyA = flyW > 0 ? M.atan2(vyP, vsP) - (f < 0 ? Math.PI : 0) : 0;
      if (inSec || insp > 0.01) {
        const sp = buildRings(
          v.geo,
          alienPre(
            S,
            w,
            v,
            dt,
            SS.softView.update(S, w, v, (ps.curl = jmA ? jm.curl : 0, ps.str = jmA ? jm.str : 0, spine(ps)), { f, sNow, grounded,
              slope: v.slope || 0, lean: v.lean + (rx ? rx.lean : 0), spin, hang: hanging ? v.hangA : null,
              pull: hanging ? (S.rope ? ropePull(S, w, sNow) : PULL_UP) : null, swim: !!(w.swim || w.ropeWet) && !grounded,
              speed: Math.hypot(vsP, vyP), fly: jm && jm.fly ? { a: jm.fa, w: jm.fw } : flyW > 0 ? { a: flyA, w: flyW } : null,
              flip: jm && jm.flip ? { a: jm.ang, w: jm.wf } : null, surf: surfY, vs: crawlT > 0.1 && !w.slide ? vsP : 0,
              sx: gsx, sy: gsy, ox: gox, oy: goy, dt: M.clamp(dt, 0, 0.05), dizzy: w.dizzyUntil > S.time, firm: jmA ? jm.firm : 1 })
          )
        ),
          hi = NS - 4,
          ha = sp.a[hi];
        // P47: the face frame (a hugger sits on it), the infected look
        if (SS.alienView && SS.alienView.worm_post) SS.alienView.worm_post(S, w, v, sp, dt, view);
        if (v.zap) updateZap(v, sp, Math.min(1, (viewTime - v.zapT) / ZAP_T));
        // eyes on the front of the head, looking along it; blink now and then
        // P89: the life jacket collar
        if (SS.jacketView) SS.jacketView.vest(S, w, v, sp, dt);
        v.eyes.position.set(sp.x[hi] + Math.cos(ha) * 0.05 - Math.sin(ha) * 0.06, sp.y[hi] + Math.sin(ha) * 0.05 + Math.cos(ha) * 0.06, 0);
        v.eyes.rotation.z = ha;
        v.eyes.scale.y = (Math.sin(ps.t * 0.9) > 0.995) ? 0.15 : 1;
        const pl = aiming
          ? M.clamp(aimV - ha, -0.8, 0.8)
          : rx && rx.watch > 0.1
          ? M.clamp(rx.look - ha, -0.8, 0.8) * rx.watch
          : rx && rx.sad > 0.1
          ? -0.55 * rx.sad
          : 0;
        // P57: the pupils sit on the eye towards the camera (they were on the front edge: a blank white eye from the
        // side)
        {
          const dx0 = 0.34 + 0.4 * Math.cos(pl), dy0 = 0.62 * Math.sin(pl), dz0 = Math.sqrt(Math.max(0.05, 1 - dx0 * dx0 - dy0 * dy0));
          for (let q = 0; q < 2; q++) {
            const p = v.pupils[q], sg = q ? 1 : -1;
            p.position.set(0.05 * dx0, 0.067 * dy0, sg * (0.075 + 0.05 * dz0));
            v.glints[q].position.set(p.position.x + 0.02, p.position.y + 0.02, p.position.z + sg * 0.012);
          }
        }
        const wkey = sw ? 'bat' : S.weapon;
        // stowed in the air / while dizzy (no weapon then, PoC)
        v.held.visible = aiming
          && !S.rope
          && !S.hook
          && !w.air
          && !(S.zip && S.zip.state === 2)
          && !(w.dizzyUntil > S.time)
          && wkey !== 'skip'
          && !(idl && idl.hideHeld);
        if (v.held.visible) {
          let hm = v.heldBy[wkey];
          if (!hm && SS.ordnance) {
            hm = v.heldBy[wkey] = SS.ordnance.held(wkey);
            v.held.add(hm);
          }
          for (const k in v.heldBy) v.heldBy[k].visible = k === wkey;
          if (SS.weaponsView) SS.weaponsView.held(S, w, hm, dt, view.time);        // P37-W3: rolling barrels, nozzle glow
          // on the shot line (the shots leave the worm's centre along the aim): the root is tilted with the slope,
          // so the aim in its frame is aim - tilt; in front of the body on the camera's side (local z sign)
          const kk = SS.polishView ? SS.polishView.kick(w) : 0,
            a2 = (S.eow ? aimV : S.aim - v.tilt) + (sw ? sw.ang : 0) + 0.14 * kk,
            phi = v.root.rotation.y,
            nn = P.nrm(S),
            zs = Math.sign(Math.sin(phi) * nn.x + Math.cos(phi) * nn.z) || 1;
          const gr = hm.userData.grips || [];
          // recoil: the weapon is pushed back into the shoulder
          const rk = 0.14 - 0.09 * kk;
          // (rides with the soft shoulder)
          v.held.position.set(Math.cos(a2) * rk + SS.softView.OUT.dx, Math.sin(a2) * rk + 0.02 + SS.softView.OUT.dy, 0.17 * zs);
          // (R3: these were swallowed by the comment above since P39)
          v.held.rotation.set(0, 0, a2);
          const hs = sw ? sw.vis : 1;
          v.held.scale.set(hs, hs, zs * hs);
          const ci = Math.round(NS * 0.55),
            cr = sp.r[ci],
            cx = sp.x[ci] + Math.cos(sp.a[ci] - Math.PI / 2) * cr * 0.5,
            cy = sp.y[ci] + Math.sin(sp.a[ci] - Math.PI / 2) * cr * 0.5;
          for (let q = 0; q < 2; q++) {
            const hd = v.hands[q], g0 = gr[q];
            hd.hand.visible = hd.arm.visible = !!g0;
            if (!g0) continue;
            const ca = Math.cos(a2),
              sa = Math.sin(a2),
              hx = v.held.position.x + ca * g0[0] - sa * g0[1],
              hy = v.held.position.y + sa * g0[0] + ca * g0[1],
              hz = v.held.position.z + g0[2] * zs;
            qhand(hd, hx, hy, hz, cx, cy, (q ? -0.05 : 0.07) * zs + 0.06 * zs, false, true);
          }
        }
        if (!v.held.visible && !(v.ache > 0) && !(aiming && S.weapon === 'skip' && !S.rope && !w.air))
          for (const hd of v.hands) hd.hand.visible = hd.arm.visible = false;
        // expressions (user 2026-10-08: "all the usual behaviours as things happen"): rising = 'whee' (mouth open,
        // eyes up), falling fast / bat-spun = scared (wide eyes, tiny pupils, O mouth, hands flailing), skidding =
        // squint, flinch = eyes shut; else the blink and a small line of a mouth
        const vy = w === a ? (a.air ? a.vy : 0) : (!w.rest && w.vel ? w.vel.y : 0), slide = !!w.slide && !airborne;
        const scared = v.batT > 0 || (airborne && vy < -9) || burnNow, whee = airborne && vy > 2.5 && !scared, flinch = v.flinchT > 0;
        const tipx = sp.x[NS - 1] + Math.cos(ha) * 0.035 + Math.sin(ha) * 0.04,
          tipy = sp.y[NS - 1] + Math.sin(ha) * 0.035 - Math.cos(ha) * 0.04;
        v.mouth.position.set(tipx, tipy, 0); v.mouth.rotation.z = ha;
        if (scared) v.mouth.scale.set(0.9, 1.5, 1.1);
        else if (whee) v.mouth.scale.set(1.35, 1.0, 1.2);
        else if (flinch) v.mouth.scale.set(1.1, 0.35, 0.9);
        else v.mouth.scale.set(1.0, 0.28, 0.8);
        // P37-8: headache: eyes screwed shut, a wince
        if (v.ache > 0) {
          v.eyes.scale.set(1.1, 0.28, 1.1);
          v.mouth.scale.set(1.2, 0.5 + 0.15 * Math.sin(view.time * 9), 0.9);
        }
        else if (flinch) v.eyes.scale.set(1, 0.1, 1);
        else if (scared) {
          v.eyes.scale.set(1.25, 1.25, 1.25);
          for (const p of v.pupils) p.scale.setScalar(0.55);
        }
        else if (slide) v.eyes.scale.set(1, 0.5, 1);
        else v.eyes.scale.x = v.eyes.scale.z = 1;
        if (!scared)
          for (const p of v.pupils) p.scale.setScalar(1);
        if (whee)
          for (const p of v.pupils) p.position.y = 0.025;
        if (rx && !(v.ache > 0)) {                                                   // P38 S1: pain / fear / yawn / cheer faces
          if (rx.pain > 0.12 && !rx.cheer) {
            v.eyes.scale.set(1.1, 0.1, 1.1);
            v.mouth.scale.set(1.05 + 0.45 * rx.pain, 0.45 + (rx.scream ? 1.7 : 0.9) * rx.pain, 1.0 + 0.4 * rx.pain);
          }
          else if (rx.fear > 0.12) {
            v.eyes.scale.set(1.2 + 0.2 * rx.fear, 1.2 + 0.25 * rx.fear, 1.2);
            for (const p of v.pupils) p.scale.setScalar(0.55 - 0.2 * rx.fear);
            v.mouth.scale.set(0.9, 0.5 + 0.9 * rx.fear + 0.2 * Math.sin(view.time * 30), 1.0);
          }
          else if (rx.yawn > 0.05) {
            v.eyes.scale.set(1.05, 0.12 + 0.3 * (1 - rx.yawn), 1.05);
            v.mouth.scale.set(1.2, 0.35 + 1.5 * rx.yawn, 1.1);
          }
          else if (rx.cheer > 0.5) {
            v.eyes.scale.set(1.1, 0.42, 1.1);
            v.mouth.scale.set(1.8, 0.9 + 0.3 * Math.sin(view.time * 11), 1.2);
          }
          else if (rx.perk > 0.2) v.eyes.scale.set(1.12, 1.2, 1.12);
          if (rx.happy > 0.3) {
            v.eyes.scale.set(1.1, 0.36, 1.1);
            v.mouth.scale.set(2.0, 0.7 + 0.35 * Math.abs(Math.sin(view.time * 9)), 1.2);
          }
          else if (rx.sad > 0.1) {
            v.eyes.scale.set(1.0, 1 - 0.5 * rx.sad, 1.0);
            v.mouth.scale.set(1 - 0.35 * rx.sad, 0.22, 0.8);
          }
          else if (rx.relief > 0.5) {
            v.eyes.scale.set(1.05, 0.12, 1.05);
            v.mouth.scale.set(0.8, 1.1, 1.0);
          }
        }
        // P43: the live anchors for the next frame's programs
        {
          const ci0 = Math.round(NS * 0.55), stI = SS.idleView && SS.idleView.st(w);
          if (stI) SS.idleView.rig(stI, v.eyes.position.x, v.eyes.position.y, sp.x[ci0], sp.y[ci0], ha);
        }
        // P43: eyelids, eye roll, the bored / sleepy / panicked face
        if (SS.idleView) SS.idleView.face(v, idl || IDLE_OFF, zsw);
        // P57: heavy upper lids for sadness / relief
        if (rx && v.lids && (rx.sad > 0.08 || rx.relief > 0.5) && !(idl && idl.k > 0.001)) {
          const lc = rx.relief > 0.5 ? 0.7 : 0.5 * rx.sad;
          v.lidOn = true;
          for (let q = 0; q < 2; q++) {
            const sg = q ? 1 : -1, l = v.lids[q];
            l.visible = lc > 0.01;
            l.rotation.x = sg * (-Math.PI / 2 + lc * Math.PI);
          }
        }
        // P37-8: a headache: one hand presses the head, rubbing; Skip Go selected: both hands up, waving "no, no" (the
        // turn ends on fire)
        const skipG = aiming && S.weapon === 'skip' && !S.rope && !w.air;
        if (!v.held.visible && (v.ache > 0 || skipG)) {
          const hx = sp.x[NS - 6], hy = sp.y[NS - 6];
          v.hands.forEach((hd, q) => {
            const sgn = q ? 1 : -1;
            let px, py, pz;
            if (v.ache > 0) {
              if (q) {
                hd.hand.visible = hd.arm.visible = false;
                return;
              }
              px = hx + 0.02 + 0.03 * Math.sin(view.time * 9);
              py = hy + 0.2 + 0.02 * Math.cos(view.time * 9);
              pz = 0.12;
            }
            else {
              px = hx + 0.1 + 0.12 * Math.sin(view.time * 7 + q * 2.6);
              py = hy + 0.3 + 0.05 * Math.cos(view.time * 7 + q * 2.6);
              pz = sgn * 0.2;
            }
            const sx0 = sp.x[NS - 10], sy0 = sp.y[NS - 10] - 0.05, sz0 = sgn * 0.05;
            hd.hand.visible = hd.arm.visible = true; qhand(hd, px, py, pz, sx0, sy0, sz0, true, true);
          });
        }
        // hands flail while falling scared (no weapon then)
        if (!v.held.visible && ((airborne && (scared || vy < -4)) || burnNow || (rx && (rx.flail || rx.arms > 0.3)))) {
          const hx = sp.x[NS - 10], hy = sp.y[NS - 10];
          v.hands.forEach((hd, q) => {
            const cheer = rx && rx.arms > 0.3,
              fl = Math.sin(view.time * (cheer ? 8 : 22) + q * (cheer ? 3.1 : 2)) * (cheer ? 0.1 : 0.12),
              sgn = q ? 1 : -1;
            hd.hand.visible = hd.arm.visible = true;
            const px = hx + 0.05 + fl * 0.5 + (cheer ? 0.05 : 0),
              py = hy + (cheer ? 0.34 : 0.18) + fl,
              pz = sgn * 0.17,
              sx0 = hx,
              sy0 = hy - 0.05,
              sz0 = sgn * 0.05;
            qhand(hd, px, py, pz, sx0, sy0, sz0, true, true);
          });
        }
        // P43: the hands of an antic (juggling, the phone, the watch, the fan ...)
        if (idl && idl.pk > 0.02 && !v.held.visible) {
          const ci0 = Math.round(NS * 0.55), hh = SS.idleView.hands(idl, zsw, sp.x[ci0], sp.y[ci0]);
          const ee = SS.idleView.E;
          v.hands.forEach((hd, q) => {
            if (!hh[q * 4]) return;
            hd.hand.visible = hd.arm.visible = true;
            qhand(hd, hh[q * 4 + 1], hh[q * 4 + 2], hh[q * 4 + 3], sp.x[ci0], sp.y[ci0], (q ? -0.06 : 0.07) * zsw, false, false);
            hd.elbOn = !!ee[q * 4];
            hd.ex = ee[q * 4 + 1];
            hd.ey = ee[q * 4 + 2];
            hd.ez = ee[q * 4 + 3];
            hd.hand.scale.setScalar(1.35);
          });
          v.handsBig = true;
        }
        // P38-A4: hanging: both hands grip the rope / the parachute risers / the zipline handle bar (render/traverse.js
        // V.grips)
        if (inSec && SS.travView && SS.travView.grips(S, w, a, GRIPW)) {
          v.root.updateMatrixWorld(true);
          const ci2 = Math.round(NS * 0.55),
            cr2 = sp.r[ci2],
            cx2 = sp.x[ci2] + Math.cos(sp.a[ci2] - Math.PI / 2) * cr2 * 0.5,
            cy2 = sp.y[ci2] + Math.sin(sp.a[ci2] - Math.PI / 2) * cr2 * 0.5;
          const shx = cx2, shy = cy2;
          for (let q = 0; q < 2; q++) {
            const hd = v.hands[q], side = q ? -1 : 1;
            v4g.set(GRIPW[q * 3], GRIPW[q * 3 + 1], GRIPW[q * 3 + 2]); v.root.worldToLocal(v4g);
            const hx = v4g.x,
              hy = v4g.y,
              hz = v4g.z,
              sz = side * 0.07,
              dx = hx - shx,
              dy = hy - shy,
              dz = hz - sz,
              L = Math.hypot(dx, dy, dz) || 1e-3;
            hd.hand.visible = hd.arm.visible = true; hd.hand.position.set(hx, hy, hz);
            hd.arm.position.set((hx + shx) / 2, (hy + shy) / 2, (hz + sz) / 2); hd.arm.scale.set(1, L, 1);
            hd.arm.quaternion.setFromUnitVectors(yAxis, v4.set(dx / L, dy / L, dz / L));
          }
        }
      }
      v.flinchT = Math.max(0, v.flinchT - dt);
      // (the flag of the scared face after a bat hit; the tumble itself is the soft body's)
      v.batT = Math.max(0, v.batT - dt);
      // the body is drawn exactly as the solver made it
      v.body.position.set(0, 0, 0); v.body.rotation.set(0, 0, 0); v.body.scale.set(1, 1, 1);
      v.body.updateMatrix(); flushHands(v);
      const dizzy = (w.dizzyUntil > S.time || v.ache > 0 || (rx && rx.daze)) && inSec;
      if (dizzy && !v.stars && SS.ordnance) {
        v.stars = new T.Group();
        for (let i = 0; i < 3; i++) v.stars.add(SS.ordnance.star());
        v.body.add(v.stars);
      }
      if (v.stars) {
        v.stars.visible = dizzy;
        if (dizzy) {
          const hp = v.eyes.position;
          v.stars.position.set(hp.x - 0.04, hp.y + 0.2, 0);
          v.stars.children.forEach((st, i) => {
            const a = view.time * 6 + i * 2.094;
            st.position.set(Math.cos(a) * 0.16, Math.sin(a * 2) * 0.02, Math.sin(a) * 0.16);
            st.rotation.set(0, a * 1.7, 0);
          });
        }
      }
      // (the body lies along the slope by itself: contact + the ground frame)
      v.tilt = 0; v.root.rotation.z = 0;
      if (S.eow && SS.eowView) SS.eowView.orient(S, w, v, f, dt);          // P68c: lies along the surface it is stuck to
      v.ghost.visible = !inSec && insp > 0.01;
      // in a cave world the marker is the only sign of a worm inside the rock: 3 x as big in the overview (about 10 px
      // instead of 4)
      v.ghost.position.copy(v.root.position); v.ghost.scale.setScalar(SS.world.under ? 1 + 2.0 * insp : 1);
      v.ghostMats[0].opacity = 0.45 * insp; v.ghostMats[1].opacity = 0.6 * insp;
      // hurt flash (decays in ~0.4 s)
      v.flash = Math.max(0, v.flash - dt * 2.5);
      v.mesh.material.emissive.copy(RED).multiplyScalar(v.flash * 0.9).add(SKIN_FILL);
      // P43: the glow of a phone screen, the chill of the cold
      if (idl && (idl.gr || idl.gg || idl.gb || idl.tint)) {
        const e = v.mesh.material.emissive, kk = idl.k;
        e.r += idl.gr * kk + 0.01 * idl.tint;
        e.g += idl.gg * kk + 0.05 * idl.tint;
        e.b += idl.gb * kk + 0.16 * idl.tint;
      }
      if (idl) SS.idleView.props(v, idl, SS.idleView.st(w), zsw, view);                        // P43: the props and icons of the antic
      if (SS.weaponsView) SS.weaponsView.worm(S, w, v, dt, viewTime);              // P37-W3: coughing, acid tint
      // on fire (lava, burning oil, a burning prop): flames on the worm while sim.burn keeps stamping w.burnT
      const burning = burnNow;
      // charred skin while it burns, recovering very slowly
      v.soot = M.clamp((v.soot || 0) + (burning ? dt * 0.22 : -dt * 0.012), 0, 0.75);
      if (v.soot > 0.001 || v.sootOn) {
        const k = 1 - v.soot * 0.78;
        v.mesh.material.color.setRGB(k, k * 0.93, k * 0.9);
        v.sootOn = v.soot > 0.001;
      }
      // P65f: a worm in / on molten lava glows from the melt below (heat x immersion) and the skin blackens fast: char
      // with an orange under-light
      {
        const sim = SS.sim, lcv = v.lcv || (v.lcv = { sub: 0, heat: 0, surf: 0 });
        let tk = 0;
        if (SS.lava && S.lava && !w.dead) {
          sim.lava_contact(S, w.pos.x, w.pos.y - C.WORM_H * 0.5, w.pos.z, lcv);
          tk = M.clamp(lcv.sub / 0.4, 0, 1) * lcv.heat;
        }
        v.lavaK = (v.lavaK || 0) + (tk - (v.lavaK || 0)) * M.min(1, dt * (tk > v.lavaK ? 3 : 0.7));
        if (v.lavaK > 0.004) {
          const g = v.lavaK, em = v.mesh.material.emissive;
          em.r += 0.9 * g;
          em.g += 0.2 * g * (0.6 + 0.4 * Math.sin(viewTime * 5 + w.id));
          em.b += 0.015 * g;
          v.soot = M.clamp(v.soot + dt * 0.45 * g, 0, 0.88);
          const k = 1 - v.soot * 0.78;
          v.mesh.material.color.setRGB(k, k * 0.93, k * 0.9);
          v.sootOn = true;
        }
      }
      // P38 S1: below the surface: drawn after the water face, tinted by depth (a drowned worm no longer vanishes)
      if (v.wetK > 0 || v.wetOn) {
        wetMode(v, v.wetK > 0);
        if (v.wetK > 0) {
          const k0 = 1 - v.soot * 0.78, k = v.wetK;
          v.mesh.material.color.setRGB(k0 * (1 - 0.42 * k), k0 * 0.93 * (1 - 0.16 * k), k0 * 0.9 * (1 - 0.04 * k));
          v.sootOn = true;
          v.mesh.material.emissive.add(WET_FILL.clone().multiplyScalar(k));
        }
      }
      if (burning) {
        if (!v.flame) v.flame = SS.bodyView.flame((w.id * 0.37 + 0.11) % 1);
        // in front of the body (seen from the camera), else the worm hides its own flames
        const cp = SS.view.camera().position,
          dx = cp.x - w.pos.x,
          dy = cp.y - w.pos.y,
          dz = cp.z - w.pos.z,
          l = Math.hypot(dx, dy, dz) || 1;
        v.flame.position.set(w.pos.x + dx / l * 0.4, w.pos.y - C.WORM_H * 0.45 + dy / l * 0.4, w.pos.z + dz / l * 0.4);
        v.flame.scale.set(0.8, 1.35, 1);
      } else if (v.flame) {
        SS.bodyView.unflame(v.flame);
        v.flame = null;
      }
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
      const wp = P.to_world(S, p.s, p.y);
      m.position.set(wp.x, wp.y, wp.z);
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
        if (p.euy != null) m.rotation.z = p.dir * Math.atan2(-p.eus, p.euy);                // P68g: End of the World: along its surface
        const L = m.userData.legs;
        if (L)
          for (let i = 0; i < 4; i++) L[i].rotation.z = Math.sin(p.age * 14 + i * 1.6) * 0.5;
        const wd = m.userData.waddle;
        // P59: a waddle of the baked sheep
        if (wd) {
          const ph = p.age * 14;
          wd.position.y = 0.03 + Math.abs(Math.sin(ph)) * 0.025;
          wd.rotation.x = Math.sin(ph) * 0.07;
          wd.rotation.z = Math.sin(ph * 2) * 0.03;
        }
      } else if (p.type === 'flame' || p.type === 'fuel') {
        if (trailT > 0.02) SS.fx.spark(wp.x, wp.y, wp.z);
      }
      else if (SS.weaponsView && SS.weaponsView.orient(m, p, S, dt)) { /* P37-W3 shells */ }
      else { m.rotation.set(0, -S.theta, (m.rotation.z || 0) - p.vs * dt * 3, 'YXZ'); }
      if (p.wet && trailT > 0.02) SS.fx.bubble && SS.fx.bubble(wp.x, wp.y, wp.z);
    }
    if (trailT > 0.02) trailT = 0;
    // (each shot builds its own model)
    for (const [p, m] of projs)
      if (!seen.has(p)) {
        scene.remove(m);
        projs.delete(p);
        SS.mat.disposeTree(m);
      }
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
      const hw = P.to_world(S, S.hook.s, S.hook.y),
        A0 = v4.set(a.pos.x, a.pos.y, a.pos.z),
        B = ropeB.set(hw.x, hw.y, hw.z),
        len = A0.distanceTo(B);
      if (len > 0.05) {
        hookLine.position.copy(A0).add(B).multiplyScalar(0.5); hookLine.scale.set(1, len, 1);
        hookLine.quaternion.setFromUnitVectors(yAxis, B.clone().sub(A0).normalize()); hookLine.visible = true;
      }
      if (hookM) {
        hookM.position.copy(B);
        hookM.rotation.set(0, -S.theta, Math.atan2(S.hook.dy, S.hook.ds), 'YXZ');
        hookM.visible = true;
      }
    } else if (S.rope && a && hookM && S.rope.hooked) {
      // stuck in the rock where it first bit: with a wrapped rope that is pins[0] (S.rope is then the newest bend);
      // it points along the line it came in on (from the next bend / the worm)
      const pins = S.rope.pins || [], h = pins.length ? pins[0] : S.rope;
      const nx = pins.length > 1 ? pins[1] : pins.length ? S.rope : null,
        from = nx ? { s: nx.s, y: nx.y } : { s: P.to_plane(S, a.pos).s, y: a.pos.y };
      const an = P.to_world(S, h.s, h.y);
      hookM.position.set(an.x, an.y, an.z);
      hookM.rotation.set(0, -S.theta, Math.atan2(h.y - from.y, h.s - from.s), 'YXZ');
      hookM.visible = true;
    }
    // a wrapped rope: the fixed segments between its bends (S.rope.pins, newest last)
    let k = 0;
    const seg = (A1, B1) => {
      let m = keptRopes[k];
      if (!m) {
        m = rope.clone();
        m.material = rope.material.clone();
        scene.add(m);
        keptRopes.push(m);
      }
      const L1 = A1.distanceTo(B1);
      m.position.copy(A1).add(B1).multiplyScalar(0.5);
      m.scale.set(1, L1, 1);
      m.quaternion.setFromUnitVectors(yAxis, B1.clone().sub(A1).normalize());
      m.visible = true;
      k++;
    };
    if (S.rope && a && S.rope.pins && S.rope.pins.length) {
      let prev = P.to_world(S, S.rope.s, S.rope.y);
      for (let i = S.rope.pins.length - 1; i >= 0; i--) {
        const q = P.to_world(S, S.rope.pins[i].s, S.rope.pins[i].y);
        seg(new T.Vector3(prev.x, prev.y, prev.z), new T.Vector3(q.x, q.y, q.z));
        prev = q;
      }
    }
    // kept ropes (setup option): worms hanging between turns
    for (const w of S.worms)
      if (!w.dead && w.rope && w !== a) {
        seg(new T.Vector3(w.pos.x, w.pos.y, w.pos.z), new T.Vector3(w.rope.x, w.rope.y, w.rope.z));
      }
    for (; k < keptRopes.length; k++) keptRopes[k].visible = false;
    const aiming = S.phase === 'play' && a && !a.dead;
    // P104: reticle + dotted line (only while aiming a weapon that aims)
    if (SS.aimView) SS.aimView.frame(S, SS.view.camera());
    for (const s of powerDots) s.visible = false;
    if (aiming) {
      const ad = SS.sim.aim_dir(S), ap = P.to_plane(S, a.pos);
      if (S.charging) {
        const nd = Math.ceil(S.power * powerDots.length);
        for (let i = 0; i < nd; i++) {
          const f = (i + 1) / powerDots.length,
            r = 0.55 + f * 1.7,
            w = P.to_world(S, ap.s + ad.s * r, a.pos.y + ad.y * r),
            s = powerDots[i];
          s.visible = true; s.position.set(w.x, w.y, w.z); s.scale.setScalar(0.18 + f * 0.32);
          s.material.color.setRGB(1.5, 1.4 - f * 1.1, 0.3 - f * 0.25);
        }
      }
    }
  }
  /* P78: a worm skin that fades (death, teleport, burial) switches to transparent: another program, compiled at load
   * (render/prewarm.js) */
  if (SS.prewarm) SS.prewarm.exemplars(() => {
    const m = SKIN.clone();
    m.transparent = true;
    m.opacity = 0.5;
    return [new T.Mesh(SS.prewarm.tri(), m), new T.Mesh(SS.prewarm.tri(), SKIN.clone())];
  });
})(window.SS = window.SS || {});
