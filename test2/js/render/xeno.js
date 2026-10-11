/* render/xeno.js — the black snake alien (P47, redone in P48): a glossy black WORM that slithers like a snake. Presentation only (Math.random is fine).
 *   body     ONE smooth segmented tube (64 rings x 14, the game's worm skin style: MeshPhysicalMaterial with vertex colours, sheen and clear-coat, but black
 *            with a dark green-blue sheen and wet speculars), a modest rounded head (a touch wider than the neck), two tiny glossy eyes, a thin mouth
 *            line, a small lower jaw that opens ONLY to bite (a mere gape for a hiss), tiny dorsal ridges, a tail that tapers to a point. Double-sided:
 *            where the section plane cuts it the inside is black, never a see-through shell.
 *   path     the rings follow the sim's TRACK (sim/alien.js: the breadcrumbs the head leaves; the sim's head wiggles its heading, so the track is a sine
 *            on the ground and the body follows it like a real snake: a lateral S-wave travelling from head to tail IN THE GROUND PLANE). Every ring sits
 *            ON the ground there (AL.ground_y), resting on its own radius; nothing oscillates vertically. A wrap / bite / eat uses the sim's coil nodes.
 *   poses    hiss and the strike wind-up: only the front third lifts into a level-headed cobra rise (the head pitches forward a little); idle: a slow
 *            sway while it holds; the bite shoots the small inner jaw. The newborn is squeezed out of the host's chest (rings emerge one after the other,
 *            the head arcs up out of the chest, drops, shakes the slime off).
 *   slime    a glistening green trail on the ground behind it (a ribbon draped on the terrain), fading out in ~5 s.
 *   section  the whole snake is drawn or hidden as ONE object (the section rule of the head; materials get a margin that covers the whole body), so the
 *            cut never shows a hollow body.
 *   eating   the victim is cloned from the worm's live body (headless, the cut stump red) and dragged into the coils, shrinking, while a swallowed lump
 *            runs down the body; the severed head flies into the jaws (blood on).
 * Materials (built-in MeshPhysical / MeshStandard only): skin, head, wet, palate, tooth, drool, gore, eye, slime (cloned per alien: the section margin).
 * API (used by render/alien.js): xenoInit(root), xenoMake(root), xenoFrame(S, X, o, dt, t, camera), xenoDispose(o), xenoEvent(S, e), xenoFx(S, dt, t). */
(function (SS) {
  'use strict';
  const T = window.THREE, AV = SS.alienView = SS.alienView || {};
  const RINGS = 64, RAD = 14, NSP = 18, MAXP = 110;
  let G = null, M_ = null, rootG = null, drool = null, dr = [], carcass = [], flyHead = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const sat = x => Math.min(1, Math.max(0, x));
  const v0 = new T.Vector3(), v1 = new T.Vector3(), v2 = new T.Vector3(), v3 = new T.Vector3(), q0 = new T.Quaternion(), q1 = new T.Quaternion(), m4 = new T.Matrix4(), sc3 = new T.Vector3();
  const UP = new T.Vector3(0, 1, 0), FWD = new T.Vector3(0, 0, 1), MARGINS = [0.5, 0.8, 1.2, 1.8, 2.6, 4, 6];

  /* ---------- textures / geometry ---------- */
  function scaleBump() {                                                  // soft rib bands and fine pores: the wet bump of the skin
    const c = document.createElement('canvas'); c.width = 128; c.height = 256; const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, 128, 256);
    for (let r = 0; r < 16; r++) { const y = r * 16; const gr = g.createLinearGradient(0, y, 0, y + 16); gr.addColorStop(0, '#a0a0a0'); gr.addColorStop(0.5, '#808080'); gr.addColorStop(1, '#606060'); g.fillStyle = gr; g.fillRect(0, y, 128, 16); }
    g.globalAlpha = 0.12; g.fillStyle = '#ffffff'; for (let i = 0; i < 260; i++) { g.beginPath(); g.arc(Math.random() * 128, Math.random() * 256, 1 + Math.random() * 1.6, 0, 6.3); g.fill(); }
    const t = new T.CanvasTexture(c); t.wrapS = t.wrapT = T.RepeatWrapping; t.anisotropy = 4; return t;
  }
  function res(env) {
    if (G) return;
    const bump = scaleBump();
    G = { cone: new T.ConeGeometry(1, 1, 5), sph: new T.SphereGeometry(1, 12, 9), slimeTex: null };
    G.cone.translate(0, 0.5, 0);
    const dark = { metalness: 0, roughness: 0.4, clearcoat: 0.8, clearcoatRoughness: 0.05, sheen: 0.3, sheenColor: new T.Color(0x0a3a30), sheenRoughness: 0.5, envMap: env, envMapIntensity: 0.45, emissive: 0x000302, side: T.DoubleSide };
    M_ = {
      skin: new T.MeshPhysicalMaterial(Object.assign({ color: 0xffffff, vertexColors: true, bumpMap: bump, bumpScale: 0.5 }, dark)),
      head: new T.MeshPhysicalMaterial(Object.assign({ color: 0x07090a }, dark)),
      wet: new T.MeshStandardMaterial({ color: 0x5a0508, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.9, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false }),
      palate: new T.MeshStandardMaterial({ color: 0x4a0a10, roughness: 0.15, emissive: 0x200408 }),
      tooth: new T.MeshStandardMaterial({ color: 0xe6e2d0, roughness: 0.22, metalness: 0.1 }),
      drool: new T.MeshStandardMaterial({ color: 0xbaff5a, roughness: 0.05, emissive: 0x6fc018, emissiveIntensity: 0.9, transparent: true, opacity: 0.85 }),
      eye: new T.MeshPhysicalMaterial({ color: 0x030505, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02, emissive: 0x1d7a4c, emissiveIntensity: 0.22, envMap: env, envMapIntensity: 2 }),
      gore: new T.MeshStandardMaterial({ color: 0x7a0a10, roughness: 0.2, metalness: 0 }),
      head2: new T.MeshStandardMaterial({ color: 0xf2a898, roughness: 0.45 }),
      slime: new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, side: T.DoubleSide, roughness: 0.2, metalness: 0, emissive: 0x23780c, emissiveIntensity: 0.9, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1, envMap: env, envMapIntensity: 0.25 })
    };
    for (const m of Object.values(M_)) m.userData.shared = true;
  }
  AV.xenoInit = function (root) {
    const r = AV.res(); res(r.env);
    if (M_.skin.envMap !== r.env) { for (const k of ['skin', 'head', 'eye', 'slime']) { M_[k].envMap = r.env; M_[k].needsUpdate = true; } }
    for (const k in births) delete births[k];
    rootG = root; dr.length = 0; for (const c of carcass) { c.mesh.parent && c.mesh.parent.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.dispose(); } carcass.length = 0; flyHead.length = 0;
    drool = new T.InstancedMesh(G.sph, M_.drool, 48); drool.frustumCulled = false; drool.count = 0; root.add(drool);
  };

  /* ---------- build ---------- */
  AV.xenoMake = function (root) {
    const g = new T.Group(), mats = {};
    for (const k of Object.keys(M_)) { mats[k] = M_[k].clone(); mats[k].userData.shared = false; }
    const geo = new T.BufferGeometry(), pos = new Float32Array(RINGS * (RAD + 1) * 3), uv = new Float32Array(RINGS * (RAD + 1) * 2), col = new Float32Array(RINGS * (RAD + 1) * 3), idx = [];
    for (let i = 0; i < RINGS; i++) for (let j = 0; j <= RAD; j++) { uv[(i * (RAD + 1) + j) * 2] = j / RAD * 2; uv[(i * (RAD + 1) + j) * 2 + 1] = i / (RINGS - 1) * 16; }
    for (let i = 0; i < RINGS - 1; i++) for (let j = 0; j < RAD; j++) { const a = i * (RAD + 1) + j, b = a + 1, c = a + RAD + 1, d = c + 1; idx.push(a, c, b, b, c, d); }
    geo.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage)); geo.setAttribute('uv', new T.BufferAttribute(uv, 2)); geo.setAttribute('color', new T.BufferAttribute(col, 3)); geo.setIndex(idx);
    const body = new T.Mesh(geo, mats.skin); body.frustumCulled = false; body.castShadow = true; g.add(body);
    const wetM = new T.Mesh(geo, mats.wet); wetM.frustumCulled = false; wetM.renderOrder = 1; g.add(wetM);
    const jaw = new T.Mesh(G.sph, mats.head); jaw.frustumCulled = false; g.add(jaw);
    const mouth = new T.Mesh(G.sph, mats.palate); mouth.frustumCulled = false; g.add(mouth);
    const palate = new T.Mesh(G.sph, mats.palate); palate.frustumCulled = false; g.add(palate);
    const eyes = [0, 1].map(() => { const e = new T.Mesh(G.sph, mats.eye); e.frustumCulled = false; g.add(e); return e; });
    const inner = new T.Group(), ij = new T.Mesh(G.sph, mats.head); ij.scale.set(0.034, 0.03, 0.13); ij.position.z = 0.06; inner.add(ij); g.add(inner);
    for (let i = 0; i < 4; i++) { const t = new T.Mesh(G.cone, mats.tooth); t.scale.set(0.01, 0.034, 0.01); t.rotation.x = Math.PI / 2; t.position.set((i & 1 ? 1 : -1) * 0.018, 0, 0.17 + (i >> 1) * 0.02); inner.add(t); }
    const teeth = new T.InstancedMesh(G.cone, mats.tooth, 24); teeth.frustumCulled = false; g.add(teeth);
    const spines = new T.InstancedMesh(G.cone, mats.head, NSP); spines.frustumCulled = false; g.add(spines);
    root.add(g);
    // the slime trail: a ribbon of up to MAXP stamps draped on the terrain
    const sg = new T.BufferGeometry(), sp = new T.BufferAttribute(new Float32Array(MAXP * 2 * 3), 3).setUsage(T.DynamicDrawUsage), sc = new T.BufferAttribute(new Float32Array(MAXP * 2 * 4), 4).setUsage(T.DynamicDrawUsage), si = [];
    for (let i = 0; i < MAXP - 1; i++) { const a = i * 2; si.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    const sn = new Float32Array(MAXP * 2 * 3); for (let i = 0; i < MAXP * 2; i++) sn[i * 3 + 1] = 1;
    sg.setAttribute('position', sp); sg.setAttribute('normal', new T.BufferAttribute(sn, 3)); sg.setAttribute('color', sc); sg.setIndex(si); sg.setDrawRange(0, 0);
    const slime = new T.Mesh(sg, mats.slime); slime.frustumCulled = false; slime.renderOrder = 4; root.add(slime);
    return { g, mats, geo, body, wetM, jaw, mouth, palate, eyes, inner, teeth, spines, slime, sg, st: [], last: new T.Vector3(1e9, 0, 1e9), rb: new Float32Array(RINGS * 2), gyb: new Float32Array(RINGS), rp: new Float32Array(RINGS * 3), rn: new Float32Array(RINGS * 3),
      open: 0, rear: 0, spd: 0, hissT: -9, biteT: -9, droolT: 0, born: -1, birth: null, shake: 0, hidden: false, lastH: new T.Vector3(), swayT: Math.random() * 6 };
  };
  AV.xenoDispose = function (o) {
    if (o.g.parent) o.g.parent.remove(o.g);
    if (o.slime.parent) o.slime.parent.remove(o.slime);
    o.geo.dispose(); o.sg.dispose(); o.teeth.dispose(); o.spines.dispose(); for (const m of Object.values(o.mats)) m.dispose();
  };

  /* ---------- per frame ---------- */
  /* the radius of the tube s metres (in units of the size) behind the head tip: a rounded head, a neck, the thick middle, a long taper to a point */
  const RH = 0.076, RN = 0.06, RB = 0.088;
  function radius(s, Lb) {
    if (s < 0.2) { const u = s / 0.2; return 0.004 + RH * Math.pow(Math.sqrt(Math.max(0, 1 - (1 - u) * (1 - u))), 0.9); }
    let r = RH + (RN - RH) * sm(0.2, 0.46, s);
    r += (RB - RN) * sm(0.46, 1.5, s) * (s > 0.46 ? 1 : 0);
    if (s > 1.5) r = RB * Math.pow(Math.max(0, 1 - (s - 1.5) / Math.max(0.1, Lb - 1.5)), 1.35) + 0.004;
    return r;
  }
  function slimeStamp(S, X, o, t, sz) {
    const h = X.n[0]; if (X.st === 2 || X.st === 3 || X.st === 4 || X.st === 7 || X.st === 8) return;
    const dx = h.x - o.last.x, dz = h.z - o.last.z, d = Math.hypot(dx, dz);
    if (d < 0.11) return;
    const AL = SS.alien; let gy = AL.ground_y(h.x, h.y, h.z, 25); if (gy < -1e8) return;
    const ux = o.last.x > 1e8 ? Math.cos(X.yaw) : dx / d, uz = o.last.x > 1e8 ? Math.sin(X.yaw) : dz / d, w = 0.125 * sz, px = -uz * w, pz = ux * w;
    const gl = AL.ground_y(h.x + px, gy + 0.2, h.z + pz, 20), gr = AL.ground_y(h.x - px, gy + 0.2, h.z - pz, 20);
    o.st.push({ x: h.x, z: h.z, yl: (gl > -1e8 ? gl : gy) + 0.02, yr: (gr > -1e8 ? gr : gy) + 0.02, px, pz, t, w: 0.85 + 0.3 * Math.random() });
    if (o.st.length > MAXP) o.st.shift();
    o.last.set(h.x, 0, h.z);
  }
  const SLIME_LIFE = 5.5;
  function slimeFrame(S, X, o, t, show) {
    const sg = o.sg, pa = sg.getAttribute('position'), ca = sg.getAttribute('color'); let n = 0;
    while (o.st.length && t - o.st[0].t > SLIME_LIFE) o.st.shift();
    for (let i = 0; i < o.st.length; i++) {
      const p = o.st[i], age = t - p.t, k = sat(1 - age / SLIME_LIFE), a = Math.min(1, age * 5 + 0.15) * Math.pow(k, 0.7) * 0.85, ww = p.w * (0.55 + 0.45 * k), b = i * 2;
      pa.setXYZ(b, p.x + p.px * ww, p.yl, p.z + p.pz * ww); pa.setXYZ(b + 1, p.x - p.px * ww, p.yr, p.z - p.pz * ww);
      const gl = 0.55 + 0.45 * k; ca.setXYZW(b, 0.09 * gl, 0.55 * gl, 0.02, a); ca.setXYZW(b + 1, 0.09 * gl, 0.55 * gl, 0.02, a);
      n++;
    }
    pa.needsUpdate = true; ca.needsUpdate = true; sg.setDrawRange(0, n > 1 ? (n - 1) * 6 : 0); o.slime.visible = show && n > 1;
  }
  /* ---------- the tight wrap (P51) ---------- */
  /* the coils hug the victim's REAL body: the worm view keeps its live spine (v.spc, body-local x, y, tangent a, radius r; the radii already squeezed,
   * render/infect.js), the coils are a helix round it: ring f of the snake sits on the spine at the fraction f of the way down from the neck to the
   * tail, at the angle th0 + 2 pi n f round the spine, at the distance (the worm's radius there) + (the snake's own radius): tube against skin, no gap,
   * the head ending at the victim's head, the head ring on the camera side. n turns (1.3 .. 3.2) so the whole snake length is used. The spine is
   * snapshotted while the snake is in the wrap state (the eaten worm is no longer drawn: the coils tighten on the shrinking carcass). */
  const HP3 = new T.Vector3(), CUM = new Float32Array(160);
  function wrapHelix(S, X, o, camera, rr, sz, Lb) {
    const K = SS.alien.K, w = S.worms[X.target], WR = AV.WRAP; if (!w || !WR) return false;
    if (X.st === 2) {
      const q = SS.actors && SS.actors.vis(w), v = q && q.v;
      if (v && v.spc && v.wrapK > 0.004) {
        v.root.updateMatrixWorld(true); v.wrapN = o.wrapN || 2.2;
        if (!o.snap) o.snap = { c: new Float32Array(v.spc.length), m: new T.Matrix4() };
        o.snap.c.set(v.spc); o.snap.m.copy(v.body.matrixWorld); o.snapOk = true;
      }
    }
    if (!o.snap || !o.snapOk) return false;
    const c = o.snap.c, m = o.snap.m, el = m.elements, sc = m.getMaxScaleOnAxis(), jT = WR.jT, jH = WR.jHead;
    let zs = 1; if (camera && camera.position) zs = ((camera.position.x - el[12]) * el[8] + (camera.position.y - el[13]) * el[9] + (camera.position.z - el[14]) * el[10]) >= 0 ? 1 : -1;
    CUM[jH] = 0; let ra = 0;
    for (let j = jH - 1; j >= jT; j--) { CUM[j] = CUM[j + 1] + Math.hypot(c[j * 4] - c[(j + 1) * 4], c[j * 4 + 1] - c[(j + 1) * 4 + 1]); ra += c[j * 4 + 3]; }
    const Lu = CUM[jT] * sc, Rm = ra / (jH - jT) * sc + RB * sz, Ls = Lb * sz * 0.95;
    const n = Math.min(3.2, Math.max(1.3, Math.sqrt(Math.max(0, Ls * Ls - Lu * Lu)) / (6.2832 * Rm))); o.wrapN = n;
    const shrink = X.st === 4 ? 1 - 0.7 * sm(0.1, 1, (S.time - X.t0) / K.EAT_T) : 1;
    const kb = X.st === 2 ? sm(0, 1, (S.time - X.t0) / (K.WRAP_T * 0.85)) : 1;
    if (!o.hp) { o.hp = new Float32Array(RINGS * 3); o.hw = new Float32Array(RINGS); }
    let j = jH;
    for (let i = 0; i < RINGS; i++) {
      const f = i / (RINGS - 1), arc = f * CUM[jT];
      while (j > jT && CUM[j - 1] < arc) j--;
      const j0 = Math.min(jH, j), j1 = Math.max(jT, j0 - 1), span = CUM[j1] - CUM[j0], u = span > 1e-6 ? Math.min(1, Math.max(0, (arc - CUM[j0]) / span)) : 0;
      const lx = c[j0 * 4] + (c[j1 * 4] - c[j0 * 4]) * u, ly = c[j0 * 4 + 1] + (c[j1 * 4 + 1] - c[j0 * 4 + 1]) * u, la = c[j0 * 4 + 2] + (c[j1 * 4 + 2] - c[j0 * 4 + 2]) * u, lr = c[j0 * 4 + 3] + (c[j1 * 4 + 3] - c[j0 * 4 + 3]) * u;
      const th = zs * 1.5708 + 6.2832 * n * f, R = lr * shrink + rr[i] / sc, ct = Math.cos(th) * R, st = Math.sin(th) * R;
      HP3.set(lx - Math.sin(la) * ct, ly + Math.cos(la) * ct, st * zs * zs).applyMatrix4(m);
      o.hp[i * 3] = HP3.x; o.hp[i * 3 + 1] = HP3.y; o.hp[i * 3 + 2] = HP3.z;
      o.hw[i] = sat(kb * 1.8 - f * 0.8);
    }
    return true;
  }
  function frameXeno(S, X, o, dt, t, camera) {
    if (!o.birth && births[X.id]) o.birth = births[X.id];
    const AL = SS.alien, K = AL.K, n = X.n, N = n.length, sz = X.size, hd = n[0];
    const wrapping = X.st === 2 || X.st === 3 || X.st === 4, slp = X.st === 7 || X.st === 8, born = X.st === 6, wu = X.st === 8 ? sat((S.time - X.t0) / K.WAKE_T) : 0;
    if (!wrapping) o.snapOk = false;
    // is it on the visible side of the section? (one decision for the whole body; the head decides)
    const Sx = SS.view && SS.view.shownAt ? SS.view.shownAt(S, hd, 0.5) : true;
    o.hidden = !Sx; o.g.visible = Sx;
    // speed of the head (smoothed): the wave frequency itself is in the sim's track
    const mv = Math.hypot(hd.x - o.lastH.x, hd.z - o.lastH.z) / Math.max(dt, 1e-3); o.lastH.set(hd.x, 0, hd.z); o.spd += (Math.min(14, mv) - o.spd) * Math.min(1, dt * 6);
    slimeStamp(S, X, o, t, sz);
    slimeFrame(S, X, o, t, true);
    if (!Sx) return;
    // rear: a hiss and the strike wind-up lift the front third; the wrap / bite keep it up
    const sinceHiss = t - o.hissT, age = S.time - X.t0;
    let rearT = 0;
    if (sinceHiss < K.HISS_T + 0.1) rearT = Math.sin(sat(sinceHiss / (K.HISS_T + 0.1)) * Math.PI) * 1.4;
    rearT = Math.min(1, rearT);
    if (X.st === 1) rearT = age < K.WIND_T ? 1 : 0.04; else if (wrapping) rearT = 0; else if (X.st === 7) rearT = 0; else if (X.st === 8) rearT = 2.2 * sm(0.1, 0.45, wu) * (1 - sm(0.72, 1, wu));
    if (born) rearT = 0;
    o.rear += (rearT - o.rear) * Math.min(1, dt * (X.st === 3 ? 18 : X.st === 8 ? 9 : 7));
    const Lb = (N - 1) * K.SEG + 0.15, ds = Lb * sz / (RINGS - 1), P = o.rp, Nn = o.rn, gy = o.gyb;
    // ---- the centre line: the sim's track with every ring on the ground there, or the coil nodes
    let endI = RINGS;
    if (slp) {                                                           // curled up (a coiled rope, the head on top) / stretching out
      const sb = o.sb || (o.sb = new Float32Array(RINGS * 3));
      AL.sleep_fill(X, ds, RINGS, sb, X.st === 8 ? sm(0.15, 0.85, wu) : 0);
      for (let i = 0; i < RINGS; i++) {
        const x = sb[i * 3], z = sb[i * 3 + 1]; let g = AL.ground_y(x, hd.y + 0.5, z, 40); if (g < -1e8 || Math.abs(g - (hd.y - K.HOVER * sz)) > 1.2) g = hd.y - K.HOVER * sz - sb[i * 3 + 2] * 0.5;
        gy[i] = g; P[i * 3] = x; P[i * 3 + 2] = z;
      }
      { let a = gy[0]; for (let i = 1; i < RINGS - 1; i++) { const b = gy[i]; gy[i] = 0.25 * a + 0.5 * b + 0.25 * gy[i + 1]; a = b; } }
      for (let i = 0; i < RINGS; i++) P[i * 3 + 1] = gy[i] + sb[i * 3 + 2];
    } else {
      AL.track_fill(X, ds, RINGS, o.rb); endI = RINGS;
      for (let i = 2; i < RINGS; i++) if (Math.hypot(o.rb[i * 2] - o.rb[i * 2 - 2], o.rb[i * 2 + 1] - o.rb[i * 2 - 1]) < 0.3 * ds) { endI = i; break; }      // (a short track: the rings past its end would pile up on one spot; they are not grown yet)
      for (let i = 0; i < RINGS; i++) {
        const x = o.rb[i * 2], z = o.rb[i * 2 + 1], sN = i * ds / (K.SEG * sz), k = Math.min(N - 2, Math.floor(sN)), f = Math.min(1, sN - k), yref = n[k].y + (n[k + 1].y - n[k].y) * f - K.HOVER * sz;
        let g = AL.ground_y(x, yref + 0.3, z, 30); if (g < -1e8 || Math.abs(g - yref) > 0.5) g = yref; gy[i] = g;
      }
      for (let pass = 0; pass < 2; pass++) { let a = gy[0]; for (let i = 1; i < RINGS - 1; i++) { const b = gy[i]; gy[i] = 0.25 * a + 0.5 * b + 0.25 * gy[i + 1]; a = b; } }
      for (let i = 0; i < RINGS; i++) { P[i * 3] = o.rb[i * 2]; P[i * 3 + 1] = gy[i]; P[i * 3 + 2] = o.rb[i * 2 + 1]; }
    }
    // the radius of every ring (born: the rings come out of the chest one after the other; eating: the swallowed lump)
    const swallow = X.st === 4 ? sat((S.time - X.t0) / 2.6) : -1, emerged = born ? sat(age / (K.BORN_T * 0.55)) * Lb * sz : 1e9;
    const rr = o.rr || (o.rr = new Float32Array(RINGS));
    for (let i = 0; i < RINGS; i++) {
      const s = i * ds / sz; let r = radius(s, Lb) * sz * (1 + 0.025 * Math.sin(s * 62));
      if (swallow >= 0) r *= 1 + 0.9 * Math.exp(-Math.pow((i / (RINGS - 1) - 0.1 - swallow * 0.6) / 0.07, 2)) * (1 - swallow * 0.35);
      if (born) r *= sm(emerged, emerged - 0.5, s * sz);
      if (X.st === 7) r *= 1 + 0.035 * Math.sin(t * 1.5 - i * 0.05);                // (slow breathing)
      if (i >= endI - 8) r *= sm(endI, endI - 8, i);
      rr[i] = r;
    }
    // the birth: the head arcs up out of the host's chest, drops to the ground, shakes the slime off
    let bk = 0, shake = 0, bx = 0, by = 0, bz = 0;
    if (born) {
      const u = sat(age / K.BORN_T), c = o.birth || { x: hd.x, y: hd.y + 0.2, z: hd.z };
      bk = 1 - sm(0.0, 0.42, u); bx = (c.x - hd.x) * bk; by = (c.y - gy[0]) * bk; bz = (c.z - hd.z) * bk;
      shake = sm(0.4, 0.55, u) * (1 - sm(0.6, 1, u));
    }
    if (X.st === 8) shake = sm(0.35, 0.5, wu) * (1 - sm(0.8, 1, wu));
    // ---- lift of the front third (a level head on top of a short S-rise), the birth arc, the shake
    const lift = o.rear * 0.5 * sz, srr = 0.3 * Lb * sz, arc = born ? 0.32 * Math.sin(Math.PI * sat(age / (K.BORN_T * 0.5))) * sz : 0;
    o.swayT += dt * (1.2 + 0.2 * o.rear);
    for (let i = 0; i < RINGS; i++) {
      const s = i * ds, ry = rr[i] * 0.84, w = 1 - sm(0, srr, s), wb = born ? Math.exp(-s / (0.9 * sz)) : 0;
      P[i * 3 + 1] += ry + (lift + arc * wb) * w + (born ? by * (1 - 0.5 * sm(0, Lb * sz, s)) : 0);
      if (born) { P[i * 3] += bx; P[i * 3 + 2] += bz; }
    }
    // the lateral sway of a held pose / the shake (perpendicular to the track, in the ground plane)
    const still = 1 - sat(o.spd / 0.6), swayA = (o.rear > 0.1 ? 0.05 * o.rear : 0.012) * sz * still + 0.07 * sz * shake;
    if (swayA > 1e-4) for (let i = 1; i < RINGS - 1; i++) {
      const tx = P[(i + 1) * 3] - P[(i - 1) * 3], tz = P[(i + 1) * 3 + 2] - P[(i - 1) * 3 + 2], tl = Math.hypot(tx, tz) || 1, f = Math.sin(o.swayT * (shake > 0.01 ? 9 : 1) - i * 0.28) * swayA * (0.3 + 0.7 * sm(0, 0.5, i / (RINGS - 1)));
      P[i * 3] += -tz / tl * f; P[i * 3 + 2] += tx / tl * f;
    }
    // ---- the tight wrap: blend the coils onto the victim's body; a sleeper settles from the last pose of the wrap into its curl
    const hx = wrapping && wrapHelix(S, X, o, camera, rr, sz, Lb);
    if (hx) for (let i = 0; i < RINGS; i++) { const k = o.hw[i]; if (k <= 0) continue; P[i * 3] += (o.hp[i * 3] - P[i * 3]) * k; P[i * 3 + 1] += (o.hp[i * 3 + 1] - P[i * 3 + 1]) * k; P[i * 3 + 2] += (o.hp[i * 3 + 2] - P[i * 3 + 2]) * k; }
    if (!o.hold) o.hold = new Float32Array(RINGS * 3);
    if (X.st === 7 && o.holdOk) { const k = sm(0, 1.2, S.time - X.t0); if (k < 1) for (let i = 0; i < RINGS * 3; i++) P[i] = o.hold[i] + (P[i] - o.hold[i]) * k; }
    else if (X.st !== 7 && X.st !== 8) { for (let i = 0; i < RINGS * 3; i++) o.hold[i] = P[i]; o.holdOk = true; }
    if (hx && o.dripT <= 0) {                                                          // slime dripping off the coils
      o.dripT = 0.07 + Math.random() * 0.08; const F = SS.fx, i = 3 + Math.floor(Math.random() * (RINGS - 8));
      if (F && F.spawn) F.spawn(F.KIND.CHUNK, P[i * 3] + rnd(-0.03, 0.03), P[i * 3 + 1] - rr[i] * 0.6, P[i * 3 + 2], { vx: rnd(-0.05, 0.05), vy: rnd(-0.1, 0.1), vz: rnd(-0.05, 0.05), grav: 5, life: rnd(0.6, 1.1), s0: 0.035, s1: 0.012, c0: [0.3, 0.8, 0.06] });
    }
    o.dripT = (o.dripT || 0) - dt;
    // ---- the tube: rings with parallel-transport-like frames biased to the world up
    const pos = o.geo.getAttribute('position'), cola = o.geo.getAttribute('color'); let px = 0, py = 1, pz = 0;
    for (let i = 0; i < RINGS; i++) {
      const a = Math.min(RINGS - 1, i + 1), b = Math.max(0, i - 1);
      v0.set(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]); if (v0.lengthSq() < 1e-10) v0.set(1, 0, 0); v0.normalize();
      v1.copy(UP).addScaledVector(v0, -v0.y); if (v1.lengthSq() < 0.04) v1.set(px, py, pz).addScaledVector(v0, -(px * v0.x + py * v0.y + pz * v0.z)); v1.normalize(); px = v1.x; py = v1.y; pz = v1.z;
      v2.crossVectors(v0, v1); Nn[i * 3] = v1.x; Nn[i * 3 + 1] = v1.y; Nn[i * 3 + 2] = v1.z;
      const r = rr[i], fy = 0.86 + 0.08 * sm(0.3, 0.7, i * ds / sz);
      for (let j = 0; j <= RAD; j++) {
        const an = j / RAD * 6.2832, c = Math.cos(an), sn = Math.sin(an), cx = c * r, cy = sn * r * fy, o3 = (i * (RAD + 1) + j);
        pos.setXYZ(o3, P[i * 3] + v1.x * cx + v2.x * cy, P[i * 3 + 1] + v1.y * cx + v2.y * cy, P[i * 3 + 2] + v1.z * cx + v2.z * cy);
        const bel = (1 - c) * 0.5, tone = 0.55 + 0.75 * bel + 0.12 * Math.abs(sn), sh = i * ds / sz;
        if (sh > 0.015 && sh < 0.17 && Math.abs(c + 0.5) < 0.2) { const ml = 1 - Math.abs(c + 0.5) / 0.2; cola.setXYZ(o3, tone * 0.012 + 0.06 * ml, tone * 0.017 * (1 - ml) + 0.004, tone * 0.019 * (1 - ml) + 0.005); }     // (the mouth line)
        else cola.setXYZ(o3, tone * 0.012 + 0.004, tone * 0.017 + 0.006, tone * 0.019 + 0.007);
      }
    }
    pos.needsUpdate = true; cola.needsUpdate = true; o.geo.computeVertexNormals();
    // ---- the section margin: the whole body is on the visible side or none of it
    const pl = SS.plane, nrm = pl.nrm(S); let mt = -9;
    for (let i = 0; i < RINGS; i += 2) mt = Math.max(mt, (P[i * 3] - S.O.x) * nrm.x + (P[i * 3 + 2] - S.O.z) * nrm.z + rr[i] + 0.05);
    let mg = MARGINS[MARGINS.length - 1]; for (const m of MARGINS) if (m >= mt) { mg = m; break; }
    for (const m of Object.values(o.mats)) m.userData.sectionMargin = mg;
    // the wet red film of the newborn dries off
    const film = born ? 0.92 : sat(1 - (S.time - (X.born != null ? X.born : X.t0) - K.BORN_T) / 7) * 0.8; o.wetM.visible = film > 0.02; o.wetM.material.opacity = film;
    // ---- the head
    const h0 = v3.set(P[0], P[1], P[2]).clone(), r4 = Math.min(RINGS - 1, 8), dir = v0.set(P[0] - P[r4 * 3], P[1] - P[r4 * 3 + 1], P[2] - P[r4 * 3 + 2]).normalize().clone();
    dir.y -= 0.22 * o.rear; if (X.st === 1 && age < K.WIND_T) dir.y -= 0.1;
    if (o.rear > 0.25) { const yw = Math.sin(o.swayT * 1.3) * 0.18 * o.rear, c = Math.cos(yw), sn = Math.sin(yw), dx = dir.x * c - dir.z * sn; dir.z = dir.x * sn + dir.z * c; dir.x = dx; }
    dir.normalize();
    const up = v1.copy(UP).addScaledVector(dir, -dir.y); if (up.lengthSq() < 1e-4) up.set(0, 0, 1); up.normalize(); const side = v2.crossVectors(up, dir).normalize();
    m4.makeBasis(side, up, dir); q0.setFromRotationMatrix(m4);
    const hs = sz, bite = X.st === 3 ? 1 : X.st === 4 ? 0.1 + 0.1 * Math.sin(t * 9) : X.st === 8 ? (wu > 0.25 && wu < 0.9 ? 0.55 + 0.15 * Math.sin(t * 28) : 0) : sinceHiss < K.HISS_T ? 0.3 + 0.1 * Math.sin(t * 30) : 0;
    o.open += (bite - o.open) * Math.min(1, dt * 16);
    const op = o.open, hp = h0;                                          // (hp: the tip of the head)
    // eyes: two tiny glossy beads on the sides of the head
    for (let k = 0; k < 2; k++) { const e = o.eyes[k]; e.position.copy(hp).addScaledVector(dir, -0.115 * hs).addScaledVector(side, (k ? 1 : -1) * 0.067 * hs).addScaledVector(up, 0.03 * hs); e.scale.setScalar(0.016 * hs); e.visible = (!born || age > 0.3) && X.st !== 7; }
    // the mouth line (a thin dark-red slit under the snout) and the small lower jaw that drops to bite
    o.mouth.visible = false;
    o.jaw.visible = op > 0.06; o.jaw.position.copy(hp).addScaledVector(dir, -0.17 * hs).addScaledVector(up, -0.03 * hs); o.jaw.quaternion.copy(q0); o.jaw.rotateX(0.75 * op); o.jaw.translateZ(0.075 * hs); o.jaw.translateY(-0.012 * hs);
    o.jaw.scale.set(0.036 * hs, 0.014 * hs, 0.082 * hs);
    o.palate.visible = op > 0.12; o.palate.position.copy(hp).addScaledVector(dir, -0.085 * hs).addScaledVector(up, -0.036 * hs); o.palate.quaternion.copy(q0); o.palate.scale.set(0.03 * hs, 0.008 * hs + 0.012 * hs * op, 0.05 * hs);
    // the inner jaw shoots out on the bite
    const shoot = X.st === 3 ? sm(0, 0.15, t - o.biteT) * (1 - 0.25 * sm(0.2, 0.34, t - o.biteT)) : 0; o.inner.visible = shoot > 0.02;
    if (o.inner.visible) { o.inner.position.copy(hp).addScaledVector(dir, -0.1 * hs + 0.13 * hs * shoot).addScaledVector(up, -0.045 * hs); o.inner.quaternion.copy(q0); o.inner.scale.setScalar(hs * 0.5); }
    // teeth: tiny, along the upper lip, visible when the mouth opens
    let ti = 0;
    for (let k = 0; k < 6 && op > 0.2; k++) for (const sd of [-1, 1]) {
      const z = 0.04 + k * 0.017, w = (0.03 + k * 0.004) * hs;
      v3.copy(hp).addScaledVector(dir, -z * hs).addScaledVector(side, sd * w).addScaledVector(up, -0.03 * hs - k * 0.0015 * hs);
      o.teeth.setMatrixAt(ti++, m4.compose(v3, q1.copy(q0).multiply(q1.setFromAxisAngle(sc3.set(1, 0, 0), Math.PI)), sc3.set(0.005 * hs, 0.016 * hs * op, 0.005 * hs)));
    }
    o.teeth.count = ti; o.teeth.instanceMatrix.needsUpdate = true;
    // tiny dorsal ridges: a row of small cones along the neck and the first half of the body
    for (let i = 0; i < NSP; i++) {
      const k = Math.min(RINGS - 2, 5 + Math.round(i * (RINGS * 0.55) / NSP)), tx = P[(k + 1) * 3] - P[(k - 1) * 3], ty = P[(k + 1) * 3 + 1] - P[(k - 1) * 3 + 1], tz = P[(k + 1) * 3 + 2] - P[(k - 1) * 3 + 2];
      v0.set(tx, ty, tz).normalize(); v1.set(Nn[k * 3], Nn[k * 3 + 1], Nn[k * 3 + 2]);
      v3.set(P[k * 3], P[k * 3 + 1], P[k * 3 + 2]).addScaledVector(v1, rr[k] * 0.95); v1.addScaledVector(v0, 0.8).normalize(); q1.setFromUnitVectors(UP, v1);
      const fade = rr[k] > 0.02 ? 1 : 0; o.spines.setMatrixAt(i, m4.compose(v3, q1, sc3.set(0.0065 * sz * fade, 0.024 * sz * fade, 0.0065 * sz * fade)));
    }
    o.spines.instanceMatrix.needsUpdate = true;
    // drool from the mouth while it hisses
    o.droolT -= dt;
    if (o.droolT <= 0 && drool && !born) {
      o.droolT = (sinceHiss < K.HISS_T ? 0.1 : 0.9) + Math.random() * 0.4;
      if (dr.length < 48) { v3.copy(hp).addScaledVector(dir, -0.04 * hs).addScaledVector(up, -0.05 * hs); dr.push({ x: v3.x + rnd(-0.02, 0.02), y: v3.y, z: v3.z + rnd(-0.02, 0.02), vx: dir.x * 0.2, vy: -0.1, vz: dir.z * 0.2, life: rnd(1, 2), r: rnd(0.008, 0.014) * sz }); }
    }
  }
  AV.xenoFrame = function (S, X, o, dt, t, camera) { frameXeno(S, X, o, dt, t, camera); };

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
      if (u >= 1 || !X) { if (c.slime) { c.slime.parent && c.slime.parent.remove(c.slime); c.slime.material.dispose(); } c.mesh.parent && c.mesh.parent.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.dispose(); carcass.splice(i, 1); continue; }
      const k = sm(0.1, 1, u), h = X.n[0];
      v3.copy(c.p); if (c.slime) c.slime.material.opacity = 0.8 * (1 - k);
      c.mesh.matrix.compose(v3, c.q, sc3.copy(c.s).multiplyScalar(Math.max(0.01, 1 - k))); c.mesh.matrixWorldNeedsUpdate = true; if (c.slime) { c.slime.matrix.copy(c.mesh.matrix); c.slime.matrixWorldNeedsUpdate = true; }
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
    const slime = new T.Mesh(geo, new T.MeshPhysicalMaterial({ color: 0x4fd414, roughness: 0.1, clearcoat: 1, emissive: 0x0f5a02, emissiveIntensity: 0.8, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    slime.frustumCulled = false; slime.matrixAutoUpdate = false; slime.material.userData.shared = false; rootG.add(slime); mesh.userData.slime = slime;
    carcass.push({ mesh, p, q: qq, s, t0: S.time, xid, slime });
    if (S.settings.blood) {                                              // the severed head
      const hm = new T.Mesh(new T.SphereGeometry(0.125, 12, 9), M_.head2); hm.frustumCulled = false; rootG.add(hm);
      const af = v.af; if (af) { v3.set(af.cx, af.cy, 0).applyMatrix4(v.body.matrixWorld); hm.position.copy(v3); }
      flyHead.push({ mesh: hm, t0: S.time, xid, x: hm.position.x, y: hm.position.y, z: hm.position.z });
    }
  }
  AV.xenoEvent = function (S, e) {
    if (e.type === 'alien_hiss') { const o = findO(e.id); if (o) o.hissT = tNowX(); }
    else if (e.type === 'alien_strike') { const o = findO(e.id); if (o) o.hissT = tNowX() - 0.2; }
    else if (e.type === 'alien_bite') {
      const o = findO(e.id); if (o) o.biteT = tNowX();
      if (e.worm) makeCarcass(S, e.worm, e.id);
      spray(e, 14, [0.5, 0.03, 0.04]);
    } else if (e.type === 'chest_burst') { births[e.xenoId] = { x: e.x, y: e.y + 0.12, z: e.z }; spray(e, 22, [0.5, 0.03, 0.04]); spray(e, 12, [0.3, 0.7, 0.08]); steam(e, 5); }
    else if (e.type === 'alien_burst') { steam(e, 10); }
  };
  const births = {};
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
