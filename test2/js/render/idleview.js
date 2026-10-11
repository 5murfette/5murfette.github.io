/* render/idleview.js — P43: the bored worm, the three.js side (props, icons, face, hands, sound / fx cues). The logic is core/idle.js (a pure state
 * machine + keyframed programs); this file is the engine glue and presentation only:
 *   - pose(S, w, v, dt, c): once per worm and frame (actors.js syncWorms): reads the sim state READ-ONLY (calm? moving? visible? weather, biome, time of day),
 *     steps the machine and returns the output struct (null while the worm is not bored): muscle offsets (sx, sy, ox, oy), the head (look, wob), yaw, glow ...
 *   - face(v, o, zs): eyelids (a skin-coloured half sphere that rotates over each eye), the eyes' size, where the pupils look (eye roll!), the mouth;
 *   - hands(v, o, zs, out): the hand targets (root-local, mirrored for the facing) that actors.js hands to its qhand();
 *   - props(v, o, zs): three juggling grenades, a smartphone with a glowing, scrolling screen (a generic short-video app: gradient blocks, no brand),
 *     a wristwatch, a map, sunglasses, a paper fan, a snot bubble, and floating icons (Z z z, !, ?, notes, hearts, HA, counting digits, a glint);
 *     built ONCE into 3 pooled kits (lazily), parented to the worm's root while it has an antic;
 *   - sound / fx cues of the program: SS.audio.idleCue (platform/audioi.js: recordings with synth fallbacks or silence), breath puffs, sweat, dust.
 * LOD: a worm that is off screen or farther than 55 m skips the whole thing; at most 3 antics at a time (the pool); the option "Idle antics"
 * (settings.idle !== false) and ?idle=0 switch it off. Nothing here touches the simulation (no S writes); Math.random is not used for choices
 * (core/idle.js has the seeded per-worm LCG); effects use the particle system.
 * API (view.js W4V list): init(scene, tx), clear(), onEvent(S, e), frame(S, view, camera, dt); pose / face / hands / props (actors.js);
 * studio / tests: force(w, name), poke(w, cause), state(w), kits(). */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math, ID = SS.idle, IV = SS.idleView = {};
  const P = ID.P, SK = ID.SK, CUE = ID.CUE, K = ID.K;
  const MAXK = 3, FAR = 55;
  IV.enabled = !/[?&]idle=0/.test(window.location.search);
  IV.only = null;                                       // studio / tests: only this worm id may be bored
  let scene = null, glowTx = null, clock = 0;
  const sts = [];                                       // per worm id: { m (Idle struct), I (input), kit, px, py, pz, aim, wp, fac, pend, ... }
  const kitPool = [];                                   // built lazily: { grp, props[], inner[], sprites[], phone: { tex, glow, glowMat }, user }
  const OUT = ID.make_out();
  const H = new Float32Array(8);                        // the hand targets of the last face() / hands() call (root-local, mirrored)
  const tv = new T.Vector3(), tq = new T.Vector3();
  const rng = M.rng_make(12345);
  const TEX = {};                                       // glyph textures (shared)

  /* ---------- textures ---------- */
  function cvs(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function mkTex(c) { const t = new T.CanvasTexture(c); if (T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4; t.userData = { shared: true }; return t; }
  function glyph(txt, fill, stroke, font, w) {
    const c = cvs(w || 96, w || 96), g = c.getContext('2d'); g.font = font || 'bold 70px Impact, Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = 11; g.strokeStyle = stroke; g.strokeText(txt, c.width / 2, c.height / 2 + 4); g.fillStyle = fill; g.fillText(txt, c.width / 2, c.height / 2 + 4);
    return mkTex(c);
  }
  function starTex() {
    const c = cvs(96, 96), g = c.getContext('2d'), gr = g.createRadialGradient(48, 48, 0, 48, 48, 40);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 96, 96);
    g.fillStyle = '#fff'; g.beginPath(); for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 - Math.PI / 2, r = i % 2 ? 7 : 44; g.lineTo(48 + Math.cos(a) * r, 48 + Math.sin(a) * r); } g.closePath(); g.fill();
    return mkTex(c);
  }
  function buildTextures() {
    if (TEX.ready) return;
    TEX.ready = 1;
    TEX.k = [];
    TEX.k[SK.Z] = glyph('Z', '#e8f4ff', '#25406a');
    TEX.k[SK.BANG] = glyph('!', '#ffe14a', '#8a1e12');
    TEX.k[SK.QUEST] = glyph('?', '#fff6d8', '#3a2a10');
    TEX.k[SK.NOTE] = glyph('♪', '#ffffff', '#2c3a7a');
    TEX.k[SK.HEART] = glyph('♥', '#ff4a78', '#7a1030');
    TEX.k[SK.HA] = glyph('HA', '#ffe14a', '#7a3a08', 'bold 52px Impact, Arial Black, sans-serif');
    for (let i = 0; i < 4; i++) TEX.k[SK.N1 + i] = glyph(String(i + 1), '#ffffff', '#1b2a44');
    TEX.k[SK.GLINT] = starTex();
    // the video strip: 8 panels of 96 x 192 (one phone screen each)
    const W = 96, Hh = 192, c = cvs(W, Hh * 8), g = c.getContext('2d'), PAL = ID.PAL;
    for (let p = 0; p < 8; p++) {
      const y0 = p * Hh, q = PAL[p], gr = g.createLinearGradient(0, y0, 0, y0 + Hh), rgb = (a, b, cc) => `rgb(${Math.round(a * 255)},${Math.round(b * 255)},${Math.round(cc * 255)})`;
      gr.addColorStop(0, rgb(q[0], q[1], q[2])); gr.addColorStop(1, rgb(q[3], q[4], q[5])); g.fillStyle = gr; g.fillRect(0, y0, W, Hh);
      g.save(); g.beginPath(); g.rect(0, y0, W, Hh); g.clip();
      g.fillStyle = 'rgba(255,255,255,0.28)'; g.beginPath(); g.arc(W * (0.3 + 0.12 * (p % 3)), y0 + Hh * 0.42, 24 + (p % 4) * 5, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 5; g.beginPath(); for (let x = 0; x <= W; x += 4) { const yy = y0 + Hh * 0.68 + Math.sin(x * 0.12 + p * 1.7) * 9; x ? g.lineTo(x, yy) : g.moveTo(x, yy); } g.stroke();
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, y0 + Hh - 40, W, 40);                                                   // caption bar
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(8, y0 + Hh - 32, 42, 5); g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(8, y0 + Hh - 22, 60, 4); g.fillRect(8, y0 + Hh - 14, 30, 4);
      for (let i = 0; i < 3; i++) { g.fillStyle = 'rgba(255,255,255,0.92)'; g.beginPath(); g.arc(W - 12, y0 + Hh * 0.5 + i * 22, 7, 0, Math.PI * 2); g.fill(); }   // like / comment / share buttons
      g.fillStyle = 'rgba(255,80,110,0.95)'; g.beginPath(); g.arc(W - 12, y0 + Hh * 0.5, 4, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(6, y0 + 5, W - 12, 3);
      g.restore();
    }
    TEX.video = mkTex(c); TEX.video.wrapS = TEX.video.wrapT = T.RepeatWrapping;
    // the dial of the wristwatch
    { const d = cvs(64, 64), q = d.getContext('2d'); q.fillStyle = '#f4f1e6'; q.beginPath(); q.arc(32, 32, 30, 0, Math.PI * 2); q.fill(); q.strokeStyle = '#222'; q.lineWidth = 3;
      for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; q.beginPath(); q.moveTo(32 + Math.cos(a) * 24, 32 + Math.sin(a) * 24); q.lineTo(32 + Math.cos(a) * 29, 32 + Math.sin(a) * 29); q.stroke(); }
      q.lineWidth = 4; q.beginPath(); q.moveTo(32, 32); q.lineTo(32, 14); q.stroke(); q.lineWidth = 3; q.strokeStyle = '#c22'; q.beginPath(); q.moveTo(32, 32); q.lineTo(46, 36); q.stroke(); TEX.dial = mkTex(d); }
    // the map: paper, folds, a coast, a dotted route and a red X
    { const m = cvs(256, 184), q = m.getContext('2d'); q.fillStyle = '#ead9a8'; q.fillRect(0, 0, 256, 184);
      q.fillStyle = '#a9cfd8'; q.beginPath(); q.moveTo(0, 120); for (let x = 0; x <= 256; x += 8) q.lineTo(x, 118 + Math.sin(x * 0.07) * 14); q.lineTo(256, 184); q.lineTo(0, 184); q.fill();
      q.fillStyle = '#9cc47a'; q.beginPath(); q.arc(70, 60, 28, 0, Math.PI * 2); q.arc(95, 78, 22, 0, Math.PI * 2); q.fill();
      q.strokeStyle = '#7a5a2a'; q.lineWidth = 2; q.setLineDash([6, 5]); q.beginPath(); q.moveTo(30, 100); q.bezierCurveTo(80, 20, 140, 120, 215, 52); q.stroke(); q.setLineDash([]);
      q.strokeStyle = '#c0261a'; q.lineWidth = 6; q.beginPath(); q.moveTo(205, 42); q.lineTo(225, 62); q.moveTo(225, 42); q.lineTo(205, 62); q.stroke();
      q.fillStyle = '#5a4020'; q.beginPath(); q.moveTo(30, 150); q.lineTo(36, 170); q.lineTo(30, 164); q.lineTo(24, 170); q.closePath(); q.fill(); q.font = 'bold 14px Arial'; q.fillText('N', 26, 146);
      q.strokeStyle = 'rgba(80,60,30,0.35)'; q.lineWidth = 2; for (const x of [64, 128, 192]) { q.beginPath(); q.moveTo(x, 0); q.lineTo(x, 184); q.stroke(); } q.beginPath(); q.moveTo(0, 92); q.lineTo(256, 92); q.stroke();
      TEX.map = mkTex(m); }
    // the fan: pleated red paper with gold edge ribs
    { const f = cvs(128, 70), q = f.getContext('2d'); for (let i = 0; i < 14; i++) { q.fillStyle = i % 2 ? '#d83a2e' : '#f0705c'; q.fillRect(i * 128 / 14, 0, 128 / 14 + 1, 70); }
      q.fillStyle = '#f6d36a'; q.fillRect(0, 0, 128, 5); TEX.fan = mkTex(f); }
  }

  /* ---------- props (built once into the kits) ---------- */
  const std = (c, o) => { const m = new T.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.5 }, o || {})); m.userData.shared = true; return m; };
  const bas = (o) => { const m = new T.MeshBasicMaterial(o); m.userData.shared = true; return m; };
  let MATS = null;
  function mats() {
    if (MATS) return MATS;
    MATS = { phone: std(0x15171c, { roughness: 0.3, metalness: 0.6 }), steel: std(0xc8ccd4, { roughness: 0.3, metalness: 0.8 }), strap: std(0x4a2a18, { roughness: 0.7 }), lens: std(0x06080c, { roughness: 0.08, metalness: 0.5 }),
      frame: std(0x101216, { roughness: 0.4 }), bubble: std(0xdff0ff, { roughness: 0.05, metalness: 0, transparent: true, opacity: 0.42, depthWrite: false, emissive: 0x1a2630 }),
      stick: std(0x8a5a2a, { roughness: 0.6 }) };
    return MATS;
  }
  function roundRect(w, h, r) { const s = new T.Shape(); s.moveTo(-w / 2 + r, -h / 2); s.lineTo(w / 2 - r, -h / 2); s.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r); s.lineTo(w / 2, h / 2 - r); s.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2); s.lineTo(-w / 2 + r, h / 2); s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r); s.lineTo(-w / 2, -h / 2 + r); s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2); return s; }
  function mkPhone(kit) {
    const g = new T.Group(), MT = mats();
    const body = new T.Mesh(new T.ExtrudeGeometry(roundRect(0.1, 0.2, 0.014), { depth: 0.012, bevelEnabled: false }), MT.phone); body.position.z = -0.006; g.add(body);
    const tex = TEX.video.clone(); tex.needsUpdate = true; tex.repeat.set(1, 1 / 8); tex.userData = { shared: false };
    const smat = new T.MeshBasicMaterial({ map: tex, toneMapped: false }); smat.userData.shared = true;
    const screen = new T.Mesh(new T.PlaneGeometry(0.088, 0.182), smat); screen.position.z = 0.0065; g.add(screen);
    const notch = new T.Mesh(new T.CircleGeometry(0.0055, 10), bas({ color: 0x000000 })); notch.position.set(0, 0.083, 0.0068); g.add(notch);
    const gm = new T.SpriteMaterial({ map: glowTx, color: 0xff80c0, transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false }); gm.userData.shared = true;
    const glow = new T.Sprite(gm); glow.scale.set(0.55, 0.55, 1); glow.position.z = 0.05; g.add(glow);
    kit.phone = { tex, glow: gm };
    return g;
  }
  function mkWatch() {
    const g = new T.Group(), MT = mats();
    const strap = new T.Mesh(new T.TorusGeometry(0.052, 0.012, 6, 18), MT.strap); strap.scale.set(1, 1, 0.55); g.add(strap);
    const cs = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 0.016, 20), MT.steel); cs.rotation.x = Math.PI / 2; g.add(cs);
    const dm = bas({ map: TEX.dial }); const dial = new T.Mesh(new T.CircleGeometry(0.044, 20), dm); dial.position.z = 0.0085; g.add(dial);
    return g;
  }
  function mkMap() {
    const m = bas({ map: TEX.map, side: T.DoubleSide }); const g = new T.Group(); g.add(new T.Mesh(new T.PlaneGeometry(0.36, 0.26), m)); return g;
  }
  function mkShades() {
    const g = new T.Group(), MT = mats();
    for (const sg of [-1, 1]) {
      const lens = new T.Mesh(new T.CircleGeometry(0.052, 18), MT.lens); lens.scale.set(1.0, 0.78, 1); lens.position.set(0.012, 0, sg * 0.152); if (sg < 0) lens.rotation.y = Math.PI; g.add(lens);
      const rim = new T.Mesh(new T.TorusGeometry(0.052, 0.006, 6, 18), MT.frame); rim.scale.set(1.0, 0.78, 1); rim.position.set(0.012, 0, sg * 0.152); g.add(rim);
      const arm = new T.Mesh(new T.BoxGeometry(0.15, 0.008, 0.008), MT.frame); arm.position.set(-0.07, 0.008, sg * 0.154); g.add(arm);
    }
    const bridge = new T.Mesh(new T.CylinderGeometry(0.006, 0.006, 0.17, 6), MT.frame); bridge.rotation.x = Math.PI / 2; bridge.position.set(0.062, 0.012, 0); g.add(bridge);
    return g;
  }
  function mkFan() {
    const g = new T.Group(), MT = mats();
    const sector = new T.Mesh(new T.CircleGeometry(0.22, 28, Math.PI * 0.12, Math.PI * 0.76), bas({ map: TEX.fan, side: T.DoubleSide })); sector.position.y = 0.02; sector.rotation.z = 0.0; g.add(sector);
    // (a circle sector: its uv span is the whole circle's box: good enough for pleats)
    const stick = new T.Mesh(new T.CylinderGeometry(0.01, 0.012, 0.1, 8), MT.stick); stick.position.y = -0.03; g.add(stick);
    g.children.forEach(c => { c.position.y += 0.0; });
    return g;
  }
  function mkUmbrella() {
    const g = new T.Group(), MT = mats();
    const c = cvs(128, 8), q = c.getContext('2d'); for (let i = 0; i < 8; i++) { q.fillStyle = i % 2 ? '#f4d03a' : '#d8382e'; q.fillRect(i * 16, 0, 16, 8); }
    const tex = mkTex(c); tex.wrapS = T.RepeatWrapping;
    const canopy = new T.Mesh(new T.SphereGeometry(0.3, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), bas({ map: tex, side: T.DoubleSide })); canopy.scale.set(1, 0.75, 1); canopy.position.y = 0.0; g.add(canopy);
    const pole = new T.Mesh(new T.CylinderGeometry(0.01, 0.01, 0.45, 6), MT.stick); pole.position.y = -0.2; g.add(pole);
    const hook = new T.Mesh(new T.TorusGeometry(0.03, 0.009, 6, 10, Math.PI), MT.stick); hook.position.set(0.03, -0.42, 0); hook.rotation.z = Math.PI; g.add(hook);
    g.position.y = 0.1;
    const w = new T.Group(); w.add(g); return w;
  }
  function mkBubble() { const m = new T.Mesh(new T.SphereGeometry(0.1, 14, 10), mats().bubble); return m; }
  function makeKit() {
    const kit = { grp: new T.Group(), holders: [], inner: [], sprites: [], phone: null, user: null, id: kitPool.length };
    kit.grp.visible = false;
    for (let i = 0; i < P.N; i++) {
      const h = new T.Group(), inn = new T.Group(); h.add(inn); h.visible = false;
      let obj = null;
      if (i <= P.GREN2) { obj = SS.ordnance ? SS.ordnance.proj('grenade') : null; if (obj) obj.userData = {}; }
      else if (i === P.PHONE) obj = mkPhone(kit);
      else if (i === P.WATCH) obj = mkWatch();
      else if (i === P.MAP) obj = mkMap();
      else if (i === P.SHADES) obj = mkShades();
      else if (i === P.FAN) obj = mkFan();
      else if (i === P.BUBBLE) obj = mkBubble();
      else if (i === P.UMB) obj = mkUmbrella();
      if (obj) {
        // (transparent pass, after the x-ray silhouette: see actors.js FACE_RO; the grenade's materials are the ordnance's shared ones: cloned)
        obj.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; o.renderOrder = 9; if (!o.material.transparent) { o.material = o.material.clone(); o.material.transparent = true; o.material.userData = { shared: true }; } } });
        inn.add(obj);
      }
      kit.grp.add(h); kit.holders.push(h); kit.inner.push(inn);
    }
    for (let i = 0; i < ID.NSPR; i++) {
      const sm = new T.SpriteMaterial({ map: TEX.k[SK.Z], transparent: true, depthTest: false, depthWrite: false }); sm.userData.shared = true;
      const s = new T.Sprite(sm); s.visible = false; s.renderOrder = 22; kit.grp.add(s); kit.sprites.push(s);
    }
    kitPool.push(kit);
    return kit;
  }
  function grab(st, v) {
    let kit = null;
    for (const k of kitPool) if (!k.user) { kit = k; break; }
    if (!kit && kitPool.length < MAXK) kit = makeKit();
    if (!kit) return null;
    kit.user = st; v.root.add(kit.grp); kit.grp.visible = true; st.kit = kit; st.kitRoot = v.root;
    return kit;
  }
  function release(st) {
    const kit = st.kit; if (!kit) return;
    kit.grp.visible = false; if (kit.grp.parent) kit.grp.parent.remove(kit.grp);
    for (const h of kit.holders) h.visible = false; for (const s of kit.sprites) s.visible = false;
    kit.user = null; st.kit = null; st.kitRoot = null;
  }
  const kitsFree = () => { let n = 0; for (const k of kitPool) if (!k.user) n++; return n + (MAXK - kitPool.length); };

  /* ---------- lifecycle ---------- */
  IV.init = function (sc, tx) { scene = sc; glowTx = tx && tx.glow; buildTextures(); mats(); makeKit(); };        // (the first kit is built now: its programs are in the shader pre-warm)
  IV.clear = function () { for (const st of sts) if (st) release(st); sts.length = 0; clock = 0; };
  IV.kits = () => kitPool.length;
  function get(w, S) {
    let st = sts[w.id];
    if (!st) { st = sts[w.id] = { m: ID.make(w.id, (S && S.settings && S.settings.seed) | 0), I: ID.make_in(), kit: null, kitRoot: null, px: null, py: 0, pz: 0, aim: 0, wp: '', fac: 0, pend: 0, rig: { ex: 0.56, ey: 0.18, cx: 0.23, cy: 0.0, ha: -1.05 }, sweatT: 0, was: 0, tintOn: 0 }; }
    return st;
  }
  IV.state = w => { const st = sts[w.id]; return st ? { state: st.m.state, kind: st.m.kind, t: st.m.t, k: st.m.k, idleT: st.m.idleT, boredAt: ID.bored_at(st.m, st.I.active) } : null; };
  IV.force = (w, name) => { const st = sts[w.id]; if (!st) return false; const k = typeof name === 'number' ? name : ID.NAME.indexOf(name); if (k < 1) return false; st.force = k; return true; };
  IV.poke = (w, cause) => { const st = sts[w.id]; if (st) st.pend = Math.max(st.pend, cause | 0); };
  IV.onEvent = function (S, e) {
    if (e.type === 'hurt' && e.worm) { const st = sts[e.worm.id]; if (st) st.pend = 2; }
    else if (e.type === 'turn' && e.worm) { const st = sts[e.worm.id]; if (st) st.pend = Math.max(st.pend, 2); }
    else if (e.type === 'explode') for (const w of S.worms) { if (w.dead) continue; const st = sts[w.id]; if (!st) continue; const d = M.len3(w.pos.x - e.x, w.pos.y - e.y, w.pos.z - e.z); if (d < 3 * (e.R || 3)) st.pend = 2; }
    else if (e.type === 'switch' && e.worm) { const st = sts[e.worm.id]; if (st) st.pend = Math.max(st.pend, 1); }
  };
  IV.frame = function (S, view, camera, dt) { clock += dt; };

  /* ---------- the sim -> input struct (read only) ---------- */
  function context(S, I) {
    const wk = S.weather ? S.weather.kind : 'clear', bio = S.biome, tod = SS.sim.time_of_day ? SS.sim.time_of_day(S) : 'day';
    const snow = wk === 'snow' || wk === 'blizzard', wet = wk === 'rain' || wk === 'storm';
    I.cold = snow || bio === 'alpine' ? 1 : 0;
    I.hot = !snow && !wet && (bio === 'desert' || bio === 'volcanic' || (bio === 'canyon' && tod === 'day')) ? 1 : 0;
    I.sunny = tod === 'day' && (wk === 'clear' || wk === 'cloudy') && !I.cold && bio !== 'volcanic' ? 1 : 0;
    I.night = tod === 'night' ? 1 : 0;
    I.rain = wet ? 1 : 0;
  }
  const NDC = new T.Vector3();
  function onScreen(cam, x, y, z) {
    if (!cam) return true;
    NDC.set(x, y + 0.4, z); const dx = NDC.x - cam.position.x, dy = NDC.y - cam.position.y, dz = NDC.z - cam.position.z;
    if (dx * dx + dy * dy + dz * dz > FAR * FAR) return false;
    NDC.project(cam); return NDC.z < 1 && Math.abs(NDC.x) < 1.12 && Math.abs(NDC.y) < 1.12;
  }
  /* c = { air, aiming, f, inSec, active, crawl, burn, wet, zs } (actors.js); returns the output struct, or null while nothing is going on */
  IV.pose = function (S, w, v, dt, c) {
    const on = IV.enabled && !(S.settings && S.settings.idle === false) && (IV.only == null || IV.only === w.id);
    const st = get(w, S), I = st.I, m = st.m;
    if (!on) { if (st.m.state !== ID.ST.WAIT) { ID.reset(st.m); } if (st.kit) release(st); return null; }
    // --- motion / input detection
    const px = w.pos.x, py = w.pos.y, pz = w.pos.z;
    const sp = st.px == null || dt <= 0 ? 0 : M.len3(px - st.px, py - st.py, pz - st.pz) / dt; st.px = px; st.py = py; st.pz = pz;
    let dis = st.pend; st.pend = 0;
    if (c.active) {
      if (st.fac !== w.facing || Math.abs(st.aim - S.aim) > 0.0015 || st.wp !== S.weapon || S.charging) dis = Math.max(dis, 1);
      st.fac = w.facing; st.aim = S.aim; st.wp = S.weapon;
    }
    if (sp > 0.25) dis = Math.max(dis, 1);
    const calm = S.phase === 'play' && !w.dead && !c.air && !c.burn && !w.swim && !w.drowning && !(c.wet > 0) && !(w.dizzyUntil > S.time) && !(c.crawl > 0.05) && !w.slide
      && !(c.active && (S.rope || S.hook)) && !(c.active && S.charging) && w.hp > 0 && !(S.zip && S.zip.state === 2) && !(c.active && S.chute && S.chute.open);
    I.calm = calm ? 1 : 0; I.disturb = dis; I.active = c.active ? 1 : 0; I.mv = M.clamp(sp / 1.5, 0, 1);
    I.visible = c.inSec && onScreen(SS.view.camera(), px, py, pz) ? 1 : 0;
    I.allow = m.state !== ID.ST.WAIT || kitsFree() > 0 ? 1 : 0;
    I.force = st.force || 0; st.force = 0;
    context(S, I);
    const r = st.rig; I.ex = r.ex; I.ey = r.ey; I.cx = r.cx; I.cy = r.cy; I.ha = r.ha;
    const was = m.state;
    const o = ID.step(m, dt, I, OUT);
    if (m.state !== ID.ST.WAIT && !st.kit) { if (!grab(st, v)) { ID.reset(m); return null; } }
    if (st.kit && st.kitRoot !== v.root) { v.root.add(st.kit.grp); st.kitRoot = v.root; }              // (a replay restore built new worm views)
    if (m.state === ID.ST.WAIT && st.kit && o.pk <= 0.001) release(st);
    if (m.state === ID.ST.WAIT && !st.kit && o.k <= 0.001) { if (st.tintOn) st.tintOn = 0; return null; }
    cues(S, w, v, o, st, c.zs, dt);
    return o;
  };

  /* ---------- sound and fx cues ---------- */
  const CNAME = ['snore', 'yawn', 'panic', 'tap', 'laugh', 'sigh', 'whistle', 'clunk', 'pop', 'shiver', 'swipe', 'puff', 'sweat', 'plop'];
  function cues(S, w, v, o, st, zs, dt) {
    const F = SS.fx, A = SS.audio;
    for (let i = 0; i < o.ncue; i++) {
      const id = o.cue[i], vol = o.cvol[i];
      if (id === CUE.PUFF) {
        if (F && F.spawn) { v.root.updateMatrixWorld(); tv.set(st.rig.ex + 0.1, st.rig.ey - 0.07, 0.04 * zs).applyMatrix4(v.root.matrixWorld); F.spawn(F.KIND.STEAM, tv.x, tv.y, tv.z, { vx: 0.3, vy: 0.4, vz: 0, life: 1.7, s0: 0.07, s1: 0.4, a0: 0.8, c0: [0.96, 0.98, 1], drag: 0.9 }); }
        continue;
      }
      if (id === CUE.PLOP) { if (F && F.dustAt) F.dustAt(w.pos.x, w.pos.y - 0.45, w.pos.z, 3, 0.2); if (A && A.idleCue) A.idleCue('plop', w, vol); continue; }
      if (A && A.idleCue) A.idleCue(CNAME[id], w, vol);
    }
    if (o.sweat > 0.05 && F && F.splash) {
      st.sweatT -= dt; if (st.sweatT <= 0) { st.sweatT = (0.25 + 0.5 * M.rng_next(rng)) / o.sweat; F.splash(w.pos.x + (M.rng_next(rng) - 0.5) * 0.22, w.pos.y + 0.45, w.pos.z, 0.06); }
    }
  }

  /* ---------- apply: face, hands, props ---------- */
  const lerp = M.lerp;
  /* v.lids = [far-side lid (z -), near-side lid (z +)], v.glints (actors.js makeWorm). zs: the local z sign facing the camera. */
  IV.face = function (v, o, zs) {
    const k = o.k;
    if (!v.lids) return;
    if (k <= 0.001) { if (v.lidOn) { v.lidOn = false; for (const l of v.lids) { l.visible = false; l.rotation.x = 0; } } return; }
    v.lidOn = true;
    const eyes = v.eyes, mouth = v.mouth;
    eyes.scale.set(lerp(eyes.scale.x, o.eyeS, k), lerp(eyes.scale.y, o.eyeS, k), lerp(eyes.scale.z, o.eyeS, k));
    // the pupils: where they look (pgx forward / back, pgy up / down), on the eye sphere
    for (let q = 0; q < 2; q++) {
      const sg = q ? 1 : -1, p = v.pupils[q], gl = v.glints[q];
      let dx = 0.45 + 0.5 * o.pgx, dy = 0.6 * o.pgy; const l2 = dx * dx + dy * dy; if (l2 > 0.9) { const s = 0.95 / Math.sqrt(l2); dx *= s; dy *= s; }
      const dz = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy)), tx = 0.062 * dx, ty = 0.083 * dy, tz = sg * (0.075 + 0.062 * dz);
      p.position.set(lerp(p.position.x, tx, k), lerp(p.position.y, ty, k), lerp(p.position.z, tz, k));
      const ps = lerp(p.scale.x, o.pupS, k); p.scale.setScalar(ps);
      gl.position.set(p.position.x + 0.02, p.position.y + 0.02, p.position.z + sg * 0.012);
    }
    const mw = o.mw, mo = o.mo;
    mouth.scale.set(lerp(mouth.scale.x, mw * (1 + 0.1 * mo), k), lerp(mouth.scale.y, 0.28 + 1.45 * mo, k), lerp(mouth.scale.z, 0.8 + 0.3 * mo, k));
    // the eyelids: a skin half sphere that turns over each eye (near the camera = lidA)
    for (let q = 0; q < 2; q++) {
      const sg = q ? 1 : -1, c = (sg === zs ? o.lidA : o.lidB) * k, l = v.lids[q];
      l.visible = c > 0.01; l.rotation.x = sg * (-Math.PI / 2 + c * Math.PI);
    }
  };
  /* the hand targets: H[q * 4 + (on, x, y, z)] root-local with the camera side mirrored; the shoulder (sx, sy) is where an arm starts when pk is small */
  const E = new Float32Array(8);                        // the elbows of the last hands() call (on, x, y, z per hand)
  const REACH = 0.52;
  IV.hands = function (o, zs, shx, shy) {
    const pk = mn1(o.pk);
    for (let q = 0; q < 2; q++) {
      const i = q * 4, on = o.h[i] && pk > 0.02;
      H[i] = on ? 1 : 0; E[i] = 0;
      if (!on) continue;
      const hx = lerp(shx, o.h[i + 1], pk), hy = lerp(shy, o.h[i + 2], pk), hz = o.h[i + 3] * zs * pk, sz = (q ? -0.06 : 0.07) * zs;
      H[i + 1] = hx; H[i + 2] = hy; H[i + 3] = hz;
      // a bent arm: the elbow sits off the line shoulder - hand, down, back and out to the side, while the hand is within reach; beyond it the arm stretches straight
      const dx = hx - shx, dy = hy - shy, dz = hz - sz, d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-3;
      if (d < REACH * 0.97) {
        const ax = dx / d, ay = dy / d, az = dz / d, bx0 = -0.3, by0 = -1.0, bz0 = 0.7 * (sz < 0 ? -1 : 1) * (zs > 0 ? 1 : 1), dp = bx0 * ax + by0 * ay + bz0 * az;
        let bx = bx0 - dp * ax, by = by0 - dp * ay, bz = bz0 - dp * az; const bl = Math.sqrt(bx * bx + by * by + bz * bz) || 1; bx /= bl; by /= bl; bz /= bl;
        const h = Math.sqrt(Math.max(0, REACH * REACH - d * d)) * 0.5;
        E[i] = 1; E[i + 1] = shx + dx * 0.5 + bx * h; E[i + 2] = shy + dy * 0.5 + by * h; E[i + 3] = sz + dz * 0.5 + bz * h;
      }
    }
    return H;
  };
  const mn1 = x => (x > 1 ? 1 : x < 0 ? 0 : x);
  IV.props = function (v, o, st, zs, view) {
    const kit = st && st.kit; if (!kit) return;
    const pk = mn1(o.pk), zk = view && view.zoom ? view.zoom : 7, pK = M.clamp(Math.sqrt(zk / 6), 1, 1.9), iK = M.clamp(zk / 6, 1, 3.5);   // (props and icons grow a little when the camera is far)
    for (let i = 0; i < P.N; i++) {
      const b = i * 9, h = kit.holders[i], inn = kit.inner[i], vis = o.pr[b] && pk > 0.01;
      if (h.visible !== !!vis) h.visible = !!vis;
      if (!vis) continue;
      const s = o.pr[b + 7] * pk * pK;
      h.position.set(o.pr[b + 1], o.pr[b + 2], o.pr[b + 3] * zs); h.scale.set(s, s, s * zs);
      inn.rotation.set(o.pr[b + 4], o.pr[b + 5], o.pr[b + 6]); inn.scale.x = Math.max(0.04, o.pr[b + 8]);
    }
    // the phone: the screen scrolls through the video strip; the glow takes the colour of the panel
    if (kit.phone && kit.holders[P.PHONE].visible) {
      const sc = o.scr, ip = Math.floor(sc), fr = sc - ip, a = ID.PAL[ip & 7], b2 = ID.PAL[(ip + 1) & 7];
      kit.phone.tex.offset.y = 1 - (sc + 1) / 8;
      const mix = (j) => lerp((a[j] + a[j + 3]) * 0.5, (b2[j] + b2[j + 3]) * 0.5, fr);
      kit.phone.glow.color.setRGB(mix(0), mix(1), mix(2)); kit.phone.glow.opacity = 0.5 + 0.12 * Math.sin(clock * 9);
    }
    // the icons
    for (let i = 0; i < ID.NSPR; i++) {
      const b = i * 6, sp = kit.sprites[i], kind = o.sp[b], al = o.sp[b + 5] * pk;
      if (kind < 0 || al <= 0.01) { if (sp.visible) sp.visible = false; continue; }
      sp.visible = true; sp.material.map = TEX.k[kind]; sp.material.opacity = al; sp.position.set(o.sp[b + 1], o.sp[b + 2], o.sp[b + 3] * zs); const s = o.sp[b + 4] * iK; sp.scale.set(s, s, 1);
      if (kind === SK.Z) sp.material.rotation = 0.25 * Math.sin(clock * 2 + i); else sp.material.rotation = 0;
    }
  };
  /* the live rig anchors (root-local) for the next frame's programs: the eyes and the shoulder, from the live spine */
  IV.rig = function (st, ex, ey, cx, cy, ha) { const r = st.rig; r.ex = ex; r.ey = ey; r.cx = cx; r.cy = cy; r.ha = ha; };
  IV.st = w => sts[w.id] || null;
  IV.H = H; IV.E = E;
})(window.SS = window.SS || {});
