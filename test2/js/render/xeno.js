/* render/xeno.js — the black snake-like alien (P47): a glossy chitin snake with a swept xenomorph head, drawn on the sim's follow-the-leader
 * chain (S.alien.xenos[].n). Presentation only (Math.random is fine).
 *   body     a tapering tube along the chain: 48 rings x 14, parallel-transport frames, segment ribs (profile + bump map), a dorsal row of
 *            curved spines, a scythe blade at the tail. A SLITHER wave runs down the body (a lateral sine on the chain: stronger and faster
 *            the faster it moves), the front rears up for a hiss / the bite / the wrap, the whole chain grows with the kills (the sim's size).
 *   head     a lofted, elongated, swept-back dome with a dorsal ridge, a hinged lower jaw, two rows of teeth, a dark wet palate, and the small
 *            INNER JAW that shoots out when it bites; no eyes. Drool drips from the jaws (lime, glowing).
 *   skin     MeshPhysicalMaterial: black chitin, metalness + clear-coat + a thin oil-sheen iridescence, a procedural studio environment map with
 *            a lime strip light, a ribs-and-scales bump map. Newborn: coated in a wet red film (an overlay mesh) that dries off.
 *   eating   the victim is cloned from the worm's live body (headless, the cut stump red) and dragged into the coils, shrinking, while a
 *            swallowed lump runs down the alien's body; the severed head flies into the jaws (blood on).
 * Materials (built-in MeshPhysical / MeshStandard / MeshBasic only): chitin, wet, palate, tooth, drool, gore.
 * API (used by render/alien.js): xenoInit(root), xenoMake(root), xenoFrame(S, X, o, dt, t, camera), xenoDispose(o), xenoEvent(S, e), xenoFx(S, dt, t). */
(function (SS) {
  'use strict';
  const T = window.THREE, AV = SS.alienView = SS.alienView || {};
  const RINGS = 48, RAD = 14, NSP = 22;
  let G = null, M_ = null, rootG = null, drool = null, dr = [], carcass = [], flyHead = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const sat = x => Math.min(1, Math.max(0, x));
  const v0 = new T.Vector3(), v1 = new T.Vector3(), v2 = new T.Vector3(), v3 = new T.Vector3(), q0 = new T.Quaternion(), q1 = new T.Quaternion(), m4 = new T.Matrix4(), sc3 = new T.Vector3();
  const UP = new T.Vector3(0, 1, 0), FWD = new T.Vector3(0, 0, 1);

  /* ---------- textures / geometry ---------- */
  function scaleBump() {                                                  // ribs (rows across) and scales: the bump map of the chitin
    const c = document.createElement('canvas'); c.width = 128; c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, 128, 256);
    for (let r = 0; r < 16; r++) { const y = r * 16; const gr = g.createLinearGradient(0, y, 0, y + 16); gr.addColorStop(0, '#d0d0d0'); gr.addColorStop(0.5, '#808080'); gr.addColorStop(1, '#303030'); g.fillStyle = gr; g.fillRect(0, y, 128, 16); }
    g.globalAlpha = 0.35; g.strokeStyle = '#202020';
    for (let y = 0; y < 256; y += 8) for (let x = ((y / 8) & 1) * 4; x < 128; x += 8) { g.beginPath(); g.arc(x, y, 4, 0, 3.15); g.stroke(); }
    const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 4; return t;
  }
  function loft(rings, N, fn) {                                           // a generic loft: rings along z, N points each; fn(zi, a) -> [x, y]
    const pos = [], idx = [], uv = [];
    for (let i = 0; i < rings; i++) for (let j = 0; j <= N; j++) { const a = j / N * Math.PI * 2, p = fn(i / (rings - 1), a); pos.push(p[0], p[1], p[2]); uv.push(j / N, i / (rings - 1)); }
    for (let i = 0; i < rings - 1; i++) for (let j = 0; j < N; j++) { const a = i * (N + 1) + j, b = a + 1, c = a + N + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals(); return g;
  }
  const sx = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), 2 / e);
  function headGeo() {                                                    // axis +z; the neck joint at z = 0, the snout at z = 1 (unit lengths)
    const Z0 = -0.2;
    return loft(24, 18, (u, a) => {
      const z = Z0 + u * (1 - Z0), s = (z - Z0) / (1 - Z0);
      const wid = 0.14 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(s, 0.7) * 0.97 + 0.015)), 0.75) + 0.012;
      const hu = 0.04 + 0.17 * Math.exp(-Math.pow((z - 0.05) / 0.32, 2)) + 0.1 * (1 - sm(0.45, 1, z)) * sm(-0.3, 0.2, z) - 0.1 * sm(0.78, 1, z), hd = 0.04 + 0.05 * (1 - sm(0.2, 1, z));
      const c = Math.cos(a), sn = Math.sin(a), up = sn > 0;
      let x = sx(c, 2.3) * wid, y = up ? sx(sn, 2.1) * Math.max(0.01, hu) : sx(sn, 2.1) * hd;
      if (up && z < 0.55) y += 0.035 * Math.exp(-x * x / 0.0035) * (1 - sm(0.1, 0.55, z));          // the dorsal ridge
      return [x, y, z];
    });
  }
  function jawGeo() {                                                     // the lower jaw: pivot at the origin, along +z
    return loft(14, 12, (u, a) => {
      const z = 0.02 + u * 0.86, w = 0.085 * Math.pow(Math.sin(Math.PI * (0.06 + 0.88 * Math.pow(1 - u, 0.8))), 0.8) * (u > 0.9 ? 1 - (u - 0.9) * 8 : 1) + 0.008, c = Math.cos(a), sn = Math.sin(a);
      return [c * w, (sn > 0 ? sn * 0.03 : sn * 0.05) * (1 - 0.5 * u) - 0.015, z];
    });
  }
  function res(env) {
    if (G) return;
    const bump = scaleBump();
    G = {
      head: headGeo(), jaw: jawGeo(), cone: new T.ConeGeometry(1, 1, 5), sph: new T.SphereGeometry(1, 10, 8), cyl: new T.CylinderGeometry(1, 1, 1, 6),
      blade: new T.ConeGeometry(1, 1, 4)
    };
    G.cone.translate(0, 0.5, 0); G.cyl.translate(0, 0.5, 0); G.blade.translate(0, 0.5, 0);
    M_ = {
      chitin: new T.MeshPhysicalMaterial({ color: 0x08090b, metalness: 0.78, roughness: 0.27, clearcoat: 1, clearcoatRoughness: 0.08, bumpMap: bump, bumpScale: 1.1, iridescence: 0.4, iridescenceIOR: 1.35, iridescenceThicknessRange: [120, 420], envMap: env, envMapIntensity: 1.5, emissive: 0x010503 }),
      head: new T.MeshPhysicalMaterial({ color: 0x050608, metalness: 0.85, roughness: 0.17, clearcoat: 1, clearcoatRoughness: 0.05, iridescence: 0.5, iridescenceIOR: 1.4, iridescenceThicknessRange: [100, 480], envMap: env, envMapIntensity: 1.9, emissive: 0x010503 }),
      wet: new T.MeshStandardMaterial({ color: 0x5a0508, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false }),
      palate: new T.MeshStandardMaterial({ color: 0x4a0a10, roughness: 0.15, emissive: 0x200408 }),
      tooth: new T.MeshStandardMaterial({ color: 0xe6e2d0, roughness: 0.22, metalness: 0.1 }),
      drool: new T.MeshStandardMaterial({ color: 0xbaff5a, roughness: 0.05, emissive: 0x6fc018, emissiveIntensity: 0.9, transparent: true, opacity: 0.85 }),
      gore: new T.MeshStandardMaterial({ color: 0x7a0a10, roughness: 0.2, metalness: 0 }),
      head2: new T.MeshStandardMaterial({ color: 0xf2a898, roughness: 0.45 })
    };
    for (const m of Object.values(M_)) m.userData.shared = true;
  }
  AV.xenoInit = function (root) {
    const r = AV.res(); res(r.env);
    if (M_.chitin.envMap !== r.env) { M_.chitin.envMap = M_.head.envMap = r.env; M_.chitin.needsUpdate = M_.head.needsUpdate = true; }
    rootG = root; dr.length = 0; for (const c of carcass) { c.mesh.parent && c.mesh.parent.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.dispose(); } carcass.length = 0; flyHead.length = 0;
    drool = new T.InstancedMesh(G.sph, M_.drool, 48); drool.frustumCulled = false; drool.count = 0; root.add(drool);
  };

  /* ---------- build ---------- */
  AV.xenoMake = function (root) {
    const g = new T.Group();
    const geo = new T.BufferGeometry(), pos = new Float32Array(RINGS * (RAD + 1) * 3), uv = new Float32Array(RINGS * (RAD + 1) * 2), idx = [];
    for (let i = 0; i < RINGS; i++) for (let j = 0; j <= RAD; j++) { uv[(i * (RAD + 1) + j) * 2] = j / RAD * 2; uv[(i * (RAD + 1) + j) * 2 + 1] = i / (RINGS - 1) * 16; }
    for (let i = 0; i < RINGS - 1; i++) for (let j = 0; j < RAD; j++) { const a = i * (RAD + 1) + j, b = a + 1, c = a + RAD + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    geo.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage)); geo.setAttribute('uv', new T.BufferAttribute(uv, 2)); geo.setIndex(idx);
    const body = new T.Mesh(geo, M_.chitin); body.frustumCulled = false; body.castShadow = true; g.add(body);
    const wetM = new T.Mesh(geo, M_.wet.clone()); wetM.frustumCulled = false; wetM.renderOrder = 1; wetM.material.userData.shared = false; g.add(wetM);
    const head = new T.Mesh(G.head, M_.head); head.frustumCulled = false; head.castShadow = true; g.add(head);
    const jaw = new T.Mesh(G.jaw, M_.head); jaw.frustumCulled = false; g.add(jaw);
    const palate = new T.Mesh(G.sph, M_.palate); palate.frustumCulled = false; g.add(palate);
    const inner = new T.Group(), ij = new T.Mesh(G.sph, M_.head); ij.scale.set(0.034, 0.03, 0.13); ij.position.z = 0.06; inner.add(ij); g.add(inner);
    const innerTeeth = []; for (let i = 0; i < 4; i++) { const t = new T.Mesh(G.cone, M_.tooth); t.scale.set(0.01, 0.034, 0.01); t.rotation.x = Math.PI / 2; t.position.set((i & 1 ? 1 : -1) * 0.018, 0, 0.17 + (i >> 1) * 0.02); inner.add(t); innerTeeth.push(t); }
    const teeth = new T.InstancedMesh(G.cone, M_.tooth, 28); teeth.frustumCulled = false; g.add(teeth);
    const spines = new T.InstancedMesh(G.cone, M_.chitin, NSP * 2); spines.frustumCulled = false; g.add(spines);
    const blade = new T.Mesh(G.blade, M_.head); blade.frustumCulled = false; g.add(blade);
    root.add(g);
    const curve = new T.CatmullRomCurve3([new T.Vector3(), new T.Vector3(1, 0, 0)]);
    return { g, geo, body, wetM, head, jaw, palate, inner, innerTeeth, teeth, spines, blade, curve, pts: null, open: 0, rear: 0, wph: Math.random() * 6.28, spd: 0, last: new T.Vector3(), hissT: -9, biteT: -9, swallowT: -9, droolT: 0, born: -1 };
  };
  AV.xenoDispose = function (o) {
    if (o.g.parent) o.g.parent.remove(o.g);
    o.geo.dispose(); o.wetM.material.dispose(); o.teeth.dispose(); o.spines.dispose();
  };

  /* ---------- per frame ---------- */
  const RA = (t, R0, R1) => (t < 0.05 ? R0 * (0.7 + 6 * t) : t < 0.3 ? R0 + (R1 - R0) * Math.sin((t - 0.05) / 0.25 * 1.5708) : R1 * Math.pow(1 - (t - 0.3) / 0.7, 0.82) + 0.01);
  function frameXeno(S, X, o, dt, t) {
    const n = X.n, N = n.length, sz = X.size;
    if (!o.pts || o.pts.length !== N) { o.pts = n.map(() => new T.Vector3()); o.curve.points = o.pts; }
    const pts = o.pts, hx = n[0].x, hz = n[0].z;
    // speed of the head (smoothed): drives the slither
    const mv = Math.hypot(hx - o.last.x, hz - o.last.z) / Math.max(dt, 1e-3); o.last.set(hx, 0, hz); o.spd += (Math.min(14, mv) - o.spd) * Math.min(1, dt * 6);
    const coil = X.st === 2 || X.st === 3 || X.st === 4;
    const amp = coil ? 0 : sz * (0.03 + 0.07 * sat(o.spd / 4)), freq = 3.4 + 1.1 * o.spd;
    o.wph += dt * freq;
    // rearing: a hiss, the wrap and the bite lift the front, the strike keeps the head low
    const sinceHiss = t - o.hissT;
    let rearT = 0.12 + 0.05 * Math.sin(t * 1.3 + o.wph * 0.1);
    if (sinceHiss < 1.4) rearT = 0.2 + 0.8 * Math.sin(sat(sinceHiss / 1.4) * Math.PI) * 0.95 + 0.1;
    if (X.st === 1) rearT = 0.22; else if (X.st === 2) rearT = 0.75; else if (X.st === 3) rearT = 0.95 - 0.5 * sat((t - o.biteT) * 3); else if (X.st === 4) rearT = 0.55;
    if (X.st === 6) rearT = 0.2 + 0.6 * sm(0.1, 0.9, (S.time - X.t0) / 1.4);
    o.rear += (rearT - o.rear) * Math.min(1, dt * (X.st === 3 ? 18 : 5));
    for (let i = 0; i < N; i++) {
      pts[i].set(n[i].x, n[i].y, n[i].z);
      if (i > 0 && i < N - 1 && amp > 0) {
        v0.set(n[i - 1].x - n[i + 1].x, 0, n[i - 1].z - n[i + 1].z); if (v0.lengthSq() > 1e-8) { v0.normalize(); const s = i / (N - 1), env = 0.35 + 0.65 * sm(0, 0.35, s), ph = o.wph - i * 0.85; pts[i].x += -v0.z * amp * env * Math.sin(ph); pts[i].z += v0.x * amp * env * Math.sin(ph); }
      }
      pts[i].y += o.rear * 0.5 * sz * Math.exp(-i * 0.5) * (i === 0 ? 1.05 : 1);
    }
    // the newborn grows out of the corpse: the tail is still inside
    let reveal = 1;
    if (X.st === 6) { reveal = sat((S.time - X.t0) / 1.4); for (let i = 1; i < N; i++) { const k = sm(i / N - 0.1, i / N + 0.25, reveal); pts[i].lerp(pts[0], 1 - k); } }
    // the swallowed lump (the eaten worm travels down the body)
    const swallow = X.st === 4 ? sat((S.time - X.t0) / 2.6) : -1;
    const R0 = 0.088 * sz, R1 = 0.135 * sz, pos = o.geo.getAttribute('position');
    const sp = o.curve.getSpacedPoints(RINGS - 1);
    let prevN = v1.set(0, 1, 0).clone();
    for (let i = 0; i < RINGS; i++) {
      const tt = i / (RINGS - 1), p = sp[i], a = sp[Math.min(RINGS - 1, i + 1)], b = sp[Math.max(0, i - 1)];
      v0.subVectors(a, b); if (v0.lengthSq() < 1e-8) v0.set(1, 0, 0); v0.normalize();
      v1.copy(prevN).addScaledVector(v0, -prevN.dot(v0)); if (v1.lengthSq() < 1e-6) v1.set(0, 1, 0).addScaledVector(v0, -v0.y); v1.normalize(); prevN.copy(v1);
      v2.crossVectors(v0, v1);
      let r = RA(tt, R0, R1) * (1 + 0.04 * Math.sin(tt * 70));
      if (swallow >= 0) r *= 1 + 0.9 * Math.exp(-Math.pow((tt - 0.06 - swallow * 0.6) / 0.07, 2)) * (1 - swallow * 0.35);
      for (let j = 0; j <= RAD; j++) { const an = j / RAD * 6.2832, cx = Math.cos(an) * r, cy = Math.sin(an) * r * 0.94; pos.setXYZ(i * (RAD + 1) + j, p.x + v1.x * cx + v2.x * cy, p.y + v1.y * cx + v2.y * cy, p.z + v1.z * cx + v2.z * cy); }
    }
    pos.needsUpdate = true; o.geo.computeVertexNormals();
    // the wet red film of the newborn dries off
    const film = X.st === 6 ? 0.92 : sat(1 - (S.time - (X.born != null ? X.born : X.t0) - 1.4) / 7) * 0.8; o.wetM.visible = film > 0.02; o.wetM.material.opacity = film;
    // ---- the head
    const h = pts[0], n1 = pts[1], dir = v0.set(h.x - n1.x, h.y - n1.y, h.z - n1.z).normalize().clone();
    // the bite and the wrap look down at the prey
    if (X.st === 2 || X.st === 3) dir.y -= 0.35; if (X.st === 1) dir.y -= 0.1; dir.normalize();
    q0.setFromUnitVectors(FWD, dir);
    const bite = X.st === 3 ? 1 : X.st === 1 ? 0.35 + 0.25 * Math.sin(t * 24) : X.st === 4 ? 0.12 + 0.15 * Math.sin(t * 9) : X.st === 2 ? 0.55 : sinceHiss < 1.2 ? 0.75 + 0.15 * Math.sin(t * 40) : X.st === 0 ? 0.05 : 0.2;
    o.open += (bite - o.open) * Math.min(1, dt * 16);
    const hl = 0.62 * sz;
    o.head.position.copy(h).addScaledVector(dir, 0.04 * sz); o.head.quaternion.copy(q0); o.head.scale.set(hl, hl, hl);
    // jaw: pivots under the head, rotating down by the opening
    o.jaw.position.copy(h).addScaledVector(dir, 0.04 * sz); v3.set(0, -0.05 * hl, 0).applyQuaternion(q0); o.jaw.position.add(v3); o.jaw.quaternion.copy(q0); o.jaw.rotateX(0.55 * o.open); o.jaw.scale.set(hl, hl, hl);
    o.palate.visible = o.open > 0.12; o.palate.position.copy(h).addScaledVector(dir, 0.04 * sz + hl * 0.5); v3.set(0, -0.045 * hl - 0.03 * o.open * hl, 0).applyQuaternion(q0); o.palate.position.add(v3); o.palate.quaternion.copy(q0); o.palate.scale.set(hl * 0.12, hl * 0.02 + hl * 0.04 * o.open, hl * 0.4);
    // the inner jaw shoots out on the bite
    const shoot = X.st === 3 ? sm(0, 0.15, t - o.biteT) * (1 - 0.25 * sm(0.2, 0.34, t - o.biteT)) : 0; o.inner.visible = shoot > 0.02;
    if (o.inner.visible) { o.inner.position.copy(h).addScaledVector(dir, 0.04 * sz + hl * (0.5 + 0.55 * shoot)); v3.set(0, -0.03 * hl, 0).applyQuaternion(q0); o.inner.position.add(v3); o.inner.quaternion.copy(q0); o.inner.scale.setScalar(hl * 2); }
    // teeth: two rows along the upper edge, two along the jaw
    let ti = 0;
    for (let k = 0; k < 7; k++) for (const sd of [-1, 1]) {
      const z = 0.3 + k * 0.095, w = 0.14 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow((z + 0.2) / 1.2, 0.7) * 0.97 + 0.015)), 0.75) * 0.74;
      v3.set(sd * w * hl, -0.056 * hl, (z + 0.04) * hl).applyQuaternion(q0); o.teeth.setMatrixAt(ti++, m4.compose(v1.copy(h).add(v3), q1.copy(q0).multiply(q1.setFromAxisAngle(sc3.set(1, 0, 0), Math.PI)), sc3.set(0.012 * hl * 2, 0.07 * hl, 0.012 * hl * 2)));
    }
    for (let k = 0; k < 7; k++) for (const sd of [-1, 1]) {
      const z = 0.22 + k * 0.1, w = 0.075 * hl * (1 - k * 0.09);
      v3.set(sd * w, 0.04 * hl, z * hl); v3.applyQuaternion(q1.copy(q0).multiply(q1.setFromAxisAngle(sc3.set(1, 0, 0), 0.55 * o.open))); v3.add(o.jaw.position);
      o.teeth.setMatrixAt(ti++, m4.compose(v3, q1.copy(q0).multiply(q1.setFromAxisAngle(sc3.set(1, 0, 0), 0.55 * o.open)), sc3.set(0.011 * hl * 2, 0.06 * hl, 0.011 * hl * 2)));
    }
    o.teeth.count = ti; o.teeth.instanceMatrix.needsUpdate = true;
    // dorsal spines (two rows) along the first 70 % of the body
    for (let i = 0; i < NSP; i++) for (let r = 0; r < 2; r++) {
      const tt = 0.1 + i / NSP * 0.62, k = Math.min(RINGS - 1, Math.round(tt * (RINGS - 1))), p = sp[k], pa = sp[Math.min(RINGS - 1, k + 1)], pb = sp[Math.max(0, k - 1)];
      v0.subVectors(pb, pa).normalize(); v1.copy(UP).addScaledVector(v0, -UP.dot(v0)).normalize(); v2.crossVectors(v0, v1);
      const rr = RA(tt, R0, R1) * 0.93, off = (r ? 1 : -1) * 0.38, ln = (0.06 - tt * 0.05 + 0.015) * sz;
      v3.copy(p).addScaledVector(v1, rr * Math.cos(off)).addScaledVector(v2, rr * Math.sin(off));
      // leaning back along the body and outwards
      v1.addScaledVector(v0, 0.9).addScaledVector(v2, Math.sin(off) * 0.5).normalize(); q1.setFromUnitVectors(UP, v1);
      o.spines.setMatrixAt(i * 2 + r, m4.compose(v3, q1, sc3.set(0.013 * sz, ln, 0.013 * sz)));
    }
    o.spines.instanceMatrix.needsUpdate = true;
    // the tail blade
    const tl = sp[RINGS - 1], tp = sp[RINGS - 4]; v0.subVectors(tl, tp).normalize(); q1.setFromUnitVectors(UP, v0);
    o.blade.position.copy(tl); o.blade.quaternion.copy(q1); o.blade.scale.set(0.02 * sz, 0.26 * sz, 0.05 * sz);
    // drool from the mouth, more when it hisses
    o.droolT -= dt;
    if (o.droolT <= 0 && drool && X.st !== 6) {
      o.droolT = (sinceHiss < 1.6 ? 0.07 : 0.55) + Math.random() * 0.3;
      if (dr.length < 48) { v3.copy(h).addScaledVector(dir, 0.04 * sz + hl * rnd(0.55, 0.95)); v3.y -= 0.06 * sz; dr.push({ x: v3.x + rnd(-0.03, 0.03), y: v3.y, z: v3.z + rnd(-0.03, 0.03), vx: dir.x * 0.2, vy: -0.1, vz: dir.z * 0.2, life: rnd(1, 2), r: rnd(0.012, 0.022) * sz }); }
    }
  }
  AV.xenoFrame = function (S, X, o, dt, t) { frameXeno(S, X, o, dt, t); };

  /* ---------- drool, flying heads, carcasses ---------- */
  AV.xenoFx = function (S, dt) {
    if (drool) {
      let n = 0;
      for (let i = dr.length - 1; i >= 0; i--) {
        const d = dr[i]; d.life -= dt; d.vy -= 9.81 * 0.7 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        if (d.life <= 0 || SS.world.sample(d.x, d.y, d.z) > 0) { dr.splice(i, 1); continue; }
      }
      for (const d of dr) { v3.set(d.x, d.y, d.z); const s = d.r * Math.min(1, d.life * 2.5); sc3.set(s, s * 1.5, s); m4.compose(v3, q0.identity(), sc3); drool.setMatrixAt(n++, m4); }
      drool.count = n; drool.instanceMatrix.needsUpdate = true;
    }
    // the severed head flying into the jaws
    for (let i = flyHead.length - 1; i >= 0; i--) {
      const f = flyHead[i], u = (S.time - f.t0) / 0.55; const X = S.alien.xenos.find(q => q.id === f.xid);
      if (u >= 1 || !X) { f.mesh.parent && f.mesh.parent.remove(f.mesh); f.mesh.geometry.dispose(); flyHead.splice(i, 1); continue; }
      const h = X.n[0], k = u * u; f.mesh.position.set(f.x + (h.x - f.x) * k, f.y + (h.y + 0.15 - f.y) * k + 0.5 * Math.sin(u * Math.PI), f.z + (h.z - f.z) * k); f.mesh.rotation.x += dt * 9; f.mesh.scale.setScalar(1 - 0.5 * k);
    }
    // the eaten body: dragged into the coils, shrinking
    for (let i = carcass.length - 1; i >= 0; i--) {
      const c = carcass[i], u = (S.time - c.t0) / 2.6, X = S.alien.xenos.find(q => q.id === c.xid);
      if (u >= 1 || !X) { c.mesh.parent && c.mesh.parent.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.dispose(); carcass.splice(i, 1); continue; }
      const k = sm(0.1, 1, u), h = X.n[0];
      v3.set(c.p.x + (h.x - c.p.x) * k * k, c.p.y + (h.y + 0.2 - c.p.y) * k * k + 0.15 * Math.sin(u * 9) * (1 - u), c.p.z + (h.z - c.p.z) * k * k);
      c.mesh.matrix.compose(v3, c.q, sc3.copy(c.s).multiplyScalar(Math.max(0.01, 1 - k))); c.mesh.matrixWorldNeedsUpdate = true;
    }
  };
  /* a headless clone of a worm's live body (positions as drawn this frame), the neck stump red */
  function makeCarcass(S, w, xid) {
    const q = SS.actors.vis(w), v = q && q.v; if (!v || !v.geo || !rootG) return;
    v.root.updateMatrixWorld(true);
    const geo = v.geo.clone(), pos = geo.attributes.position, col = geo.attributes.color, NS = 150, NR = 14, cut = 126;
    let cx = 0, cy = 0, cz = 0; for (let j = 0; j < NR; j++) { cx += pos.getX(cut * NR + j); cy += pos.getY(cut * NR + j); cz += pos.getZ(cut * NR + j); } cx /= NR; cy /= NR; cz /= NR;
    for (let i = cut; i < NS; i++) for (let j = 0; j < NR; j++) { const o = i * NR + j; pos.setXYZ(o, cx, cy, cz); }
    for (let i = cut - 5; i <= cut; i++) for (let j = 0; j < NR; j++) { const o = i * NR + j, k = (i - (cut - 5)) / 5; col.setXYZ(o, col.getX(o) * (1 - k) + 0.55 * k, col.getY(o) * (1 - k) + 0.04 * k, col.getZ(o) * (1 - k) + 0.05 * k); }
    pos.needsUpdate = true; col.needsUpdate = true; geo.computeBoundingSphere();
    const mat = v.mesh.material.clone(); mat.userData.shared = false;
    const mesh = new T.Mesh(geo, mat); mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; rootG.add(mesh);
    const p = new T.Vector3(), qq = new T.Quaternion(), s = new T.Vector3(); v.body.matrixWorld.decompose(p, qq, s);
    carcass.push({ mesh, p, q: qq, s, t0: S.time, xid });
    if (S.settings.blood) {                                              // the severed head
      const hm = new T.Mesh(new T.SphereGeometry(0.125, 12, 9), M_.head2); hm.frustumCulled = false; rootG.add(hm);
      const af = v.af; if (af) { v3.set(af.cx, af.cy, 0).applyMatrix4(v.body.matrixWorld); hm.position.copy(v3); }
      flyHead.push({ mesh: hm, t0: S.time, xid, x: hm.position.x, y: hm.position.y, z: hm.position.z });
    }
  }
  AV.xenoEvent = function (S, e) {
    if (e.type === 'alien_hiss') { const o = findO(e.id); if (o) o.hissT = tNowX(); steam(e, 5); }
    else if (e.type === 'alien_strike') { const o = findO(e.id); if (o) o.hissT = tNowX() - 0.2; }
    else if (e.type === 'alien_bite') {
      const o = findO(e.id); if (o) o.biteT = tNowX();
      if (e.worm) makeCarcass(S, e.worm, e.id);
      spray(e, 14, [0.5, 0.03, 0.04]);
    } else if (e.type === 'chest_burst') { spray(e, 26, [0.45, 0.02, 0.03]); steam(e, 4); }
    else if (e.type === 'alien_burst') { steam(e, 10); }
  };
  const tNowX = () => AV.clock(), findO = id => AV.xenoView(id);
  function steam(e, n) {
    const F = SS.fx; if (!F || !F.spawn) return;
    for (let i = 0; i < n; i++) F.spawn(F.KIND.STEAM, e.x + rnd(-0.1, 0.1), e.y + rnd(0, 0.2), e.z + rnd(-0.1, 0.1), { vx: rnd(-0.4, 0.4), vy: rnd(0.5, 1.4), vz: rnd(-0.2, 0.2), life: rnd(0.7, 1.3), s0: 0.1, s1: 0.5, a0: 0.45, c0: [0.7, 0.9, 0.6], drag: 0.8 });
  }
  function spray(e, n, col) {
    const F = SS.fx; if (!F || !F.spawn) return;
    for (let i = 0; i < n; i++) { const a = rnd(0, 6.283), sp = rnd(1.2, 4.2); F.spawn(F.KIND.CHUNK, e.x, e.y + 0.1, e.z, { vx: Math.cos(a) * sp, vy: rnd(1.5, 4.5), vz: Math.sin(a) * sp * 0.4, grav: 14, life: rnd(0.7, 1.4), s0: 0.05, s1: 0.04, c0: col }); }
  }
})(window.SS = window.SS || {});
