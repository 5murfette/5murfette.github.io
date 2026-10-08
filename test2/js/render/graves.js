/* render/graves.js — tombstones (user 2026-10-08: "fix the tombstones, they float in the air, make them nicer and land
 * on the ground, get incorporated to the soil nicely, some flowers should grow around them and some grass, maybe some
 * butterflies should appear and fly away"). Presentation only (Math.random is fine); the grave's position, its fall and
 * its landing time (g.landT) come from the sim (sim.js stepGraves).
 *   - an arched headstone on a low plinth, 6 cm sunk in the soil, a slight random lean, a team-coloured plaque and
 *     engraved lines, moss at its foot, a low soil mound (the plot) BEHIND it: the ground only exists at / behind
 *     slice zero (the cut face is the front), so nothing may stand in front of the stone;
 *   - after it lands: grass blades and small flowers grow around it over ~4 s;
 *   - ~1.2 s after landing 2-3 butterflies rise from the flowers, flutter and fly away (gone after ~8 s).
 *   - a grave that will still go off (blood on: PoC grave blast) carries a charge: three red sticks, tape, a timer box with
 *     a red display (ARM blinking, then its dying beat counting down) and an LED; after the blast the stone is scorched;
 *   - the face: granite, an engraved border, R.I.P. and the worm's NAME, a team-coloured emblem.
 * API: SS.graveView.make(g, teamRgb, name) -> Group; frame(grp, g, S, nrm, t, dt, worm); dispose(grp). */
(function (SS) {
  'use strict';
  const T = window.THREE, GV = SS.graveView = {};
  const r = (a, b) => a + Math.random() * (b - a);
  let STONE = null, DARK = null, SOIL = null, MOSS = null, STEM = null, GRASS = [];
  const FLOWER = [0xffffff, 0xffd84a, 0xb07cff, 0xff5a7a, 0x6fa8ff, 0xffa040];
  function mats() {
    if (STONE) return;
    STONE = new T.MeshStandardMaterial({ color: 0x8f9398, roughness: 0.82, metalness: 0.02 });
    DARK = new T.MeshStandardMaterial({ color: 0x55595e, roughness: 0.9 });
    SOIL = new T.MeshStandardMaterial({ color: 0x5b4130, roughness: 1 });
    MOSS = new T.MeshStandardMaterial({ color: 0x4f7a32, roughness: 1 });
    STEM = new T.MeshStandardMaterial({ color: 0x3f7a2a, roughness: 0.9 });
    GRASS = [0x4d8a2e, 0x5f9b35, 0x3f7426].map(c => new T.MeshStandardMaterial({ color: c, roughness: 0.9, side: T.DoubleSide }));
  }
  let STONE_GEO = null, PLINTH_GEO = null, MOUND_GEO = null, BLADE_GEO = null, PETAL_GEO = null, STEMG = null, CORE_GEO = null, WING_GEO = null;
  function geos() {
    if (STONE_GEO) return;
    // arched headstone: 0.44 wide, 0.46 straight + a 0.22 arch, 0.11 thick, bevelled
    const s = new T.Shape(), w = 0.22, h = 0.46;
    s.moveTo(-w, 0); s.lineTo(w, 0); s.lineTo(w, h); s.absarc(0, h, w, 0, Math.PI, false); s.lineTo(-w, 0);
    STONE_GEO = new T.ExtrudeGeometry(s, { depth: 0.09, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 2, curveSegments: 16 });
    STONE_GEO.translate(0, 0, -0.045);
    PLINTH_GEO = new T.BoxGeometry(0.58, 0.08, 0.26);
    MOUND_GEO = new T.SphereGeometry(1, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    BLADE_GEO = new T.ConeGeometry(0.012, 1, 3); BLADE_GEO.translate(0, 0.5, 0);
    PETAL_GEO = new T.SphereGeometry(0.018, 6, 4);
    CORE_GEO = new T.SphereGeometry(0.012, 6, 4);
    STEMG = new T.CylinderGeometry(0.004, 0.005, 1, 4); STEMG.translate(0, 0.5, 0);
    WING_GEO = new T.CircleGeometry(0.07, 10); WING_GEO.scale(1, 1.35, 1); WING_GEO.translate(0.06, 0, 0);
  }
  const mesh = (geo, mat, x, y, z) => { const m = new T.Mesh(geo, mat); m.position.set(x || 0, y || 0, z || 0); m.castShadow = true; m.receiveShadow = true; return m; };

  /* the stone's face: granite (speckles, a soft vignette), an engraved border, "R.I.P.", the worm's name and a small team
   * emblem; engraving = a dark cut with a light lower lip. UVs of the extruded caps are the shape's (x, y) in metres. */
  // ASSET: grave face (models/grave.glb has a blank panel; the name is drawn at runtime)
  function faceTexture(name, teamRgb) {
    const Wd = 256, Ht = 384, cv = document.createElement('canvas'); cv.width = Wd; cv.height = Ht; const x = cv.getContext('2d');
    const gr = x.createRadialGradient(Wd / 2, Ht * 0.45, 20, Wd / 2, Ht * 0.45, Ht * 0.7); gr.addColorStop(0, '#b9bcc0'); gr.addColorStop(1, '#8a8e93');
    x.fillStyle = gr; x.fillRect(0, 0, Wd, Ht);
    for (let i = 0; i < 2600; i++) { const v = Math.random(); x.fillStyle = v < 0.5 ? 'rgba(60,62,66,0.35)' : v < 0.85 ? 'rgba(230,232,235,0.35)' : 'rgba(150,110,90,0.3)'; x.fillRect(Math.random() * Wd, Math.random() * Ht, 1 + Math.random() * 2, 1 + Math.random() * 2); }
    const cut = (draw) => { x.save(); x.translate(0, 2); x.globalAlpha = 0.55; x.fillStyle = x.strokeStyle = '#e8eaec'; draw(); x.restore(); x.save(); x.fillStyle = x.strokeStyle = '#3c3f43'; draw(); x.restore(); };
    // border following the arch (the face spans x -0.22..0.22, y 0..0.68 m -> 256 x 384 px, arch from y 0.46)
    cut(() => { x.lineWidth = 4; x.beginPath(); const m = 18, ay = Ht - 0.46 / 0.68 * Ht; x.moveTo(m, Ht - 12); x.lineTo(m, ay); x.arc(Wd / 2, ay, Wd / 2 - m, Math.PI, 0); x.lineTo(Wd - m, Ht - 12); x.stroke(); });
    cut(() => { x.font = 'bold 30px Georgia, serif'; x.textAlign = 'center'; x.fillText('R.I.P.', Wd / 2, 118); });
    let fs = 40; x.font = `bold ${fs}px Georgia, serif`; while (x.measureText(name).width > Wd - 50 && fs > 16) { fs -= 2; x.font = `bold ${fs}px Georgia, serif`; }
    cut(() => { x.font = `bold ${fs}px Georgia, serif`; x.textAlign = 'center'; x.fillText(name, Wd / 2, 190); });
    cut(() => { x.fillRect(Wd / 2 - 60, 214, 120, 3); });
    const c = '#' + new T.Color(teamRgb).getHexString(); x.fillStyle = c; x.beginPath(); x.arc(Wd / 2, 262, 17, 0, 7); x.fill();
    x.strokeStyle = '#3c3f43'; x.lineWidth = 3; x.stroke();
    const t = new T.CanvasTexture(cv); if (T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
    t.repeat.set(1 / 0.44, 1 / 0.68); t.offset.set(0.5, -0.02 / 0.68);
    return t;
  }
  // the timer of a charged grave: red seven-segment-ish digits on a black display (redrawn when the shown value changes)
  function timerTexture() {
    const cv = document.createElement('canvas'); cv.width = 96; cv.height = 40; const t = new T.CanvasTexture(cv); t.userData = { cv, last: '' }; return t;
  }
  function drawTimer(t, text, on) {
    if (t.userData.last === text + on) return; t.userData.last = text + on;
    const x = t.userData.cv.getContext('2d'); x.fillStyle = '#120404'; x.fillRect(0, 0, 96, 40);
    x.font = 'bold 30px monospace'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = 'rgba(255,40,30,0.15)'; x.fillText('8:88', 48, 21);
    if (on) { x.shadowColor = '#ff2a1a'; x.shadowBlur = 8; x.fillStyle = '#ff3a26'; x.fillText(text, 48, 21); }
    t.needsUpdate = true;
  }

  // ASSET: grave, grave_charge, grave_plants (models/grave*.glb)
  GV.make = function (g, teamRgb, name) {
    mats(); geos();
    const grp = new T.Group(), body = new T.Group(); body.position.z = -0.08; grp.add(body);
    body.rotation.z = r(-0.06, 0.06); body.rotation.x = r(-0.05, 0.02);       // a slight lean, settled in the soil
    const faceMat = new T.MeshStandardMaterial({ map: faceTexture(name || 'Worm', teamRgb), roughness: 0.78, metalness: 0.02 });
    const sideMat = new T.MeshStandardMaterial({ color: 0x8c9095, roughness: 0.85 });
    const stone = new T.Mesh(STONE_GEO, [faceMat, sideMat]); stone.position.y = 0.02; stone.castShadow = stone.receiveShadow = true; body.add(stone);
    body.add(mesh(PLINTH_GEO, sideMat, 0, -0.02, 0));
    for (let i = 0; i < 7; i++) { const m = mesh(PETAL_GEO, MOSS, r(-0.28, 0.28), 0.02, r(-0.12, 0.02)); m.scale.set(r(2, 4), 1.2, r(2, 4)); body.add(m); }
    const mound = mesh(MOUND_GEO, SOIL, 0, -0.04, -0.42); mound.scale.set(0.32, 0.1, 0.4); grp.add(mound);
    // the charge (graves that will go off): three sticks strapped to the stone's foot, a timer box, wires
    const charge = new T.Group(); charge.position.set(0, 0.12, 0.075); body.add(charge);
    const red = new T.MeshStandardMaterial({ color: 0xc0261b, roughness: 0.55 }), tape = new T.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.8 });
    for (const dx of [-0.075, 0, 0.075]) { const st = mesh(new T.CylinderGeometry(0.035, 0.035, 0.26, 12), red, dx, 0, 0.0); st.rotation.z = Math.PI / 2 * 0; charge.add(st); }
    for (const dy of [-0.07, 0.07]) charge.add(mesh(new T.BoxGeometry(0.25, 0.03, 0.085), tape, 0, dy, 0));
    const tt = timerTexture(), disp = new T.Mesh(new T.PlaneGeometry(0.17, 0.07), new T.MeshBasicMaterial({ map: tt, toneMapped: false }));
    const box = mesh(new T.BoxGeometry(0.2, 0.1, 0.05), tape, 0, 0.0, 0.055); charge.add(box); disp.position.set(0, 0.0, 0.082); charge.add(disp);
    const led = new T.Mesh(new T.SphereGeometry(0.014, 8, 6), new T.MeshBasicMaterial({ color: 0xff2a1a, toneMapped: false })); led.position.set(0.085, 0.05, 0.08); charge.add(led);
    const wire = new T.Mesh(new T.TorusGeometry(0.07, 0.006, 5, 14, Math.PI), new T.MeshStandardMaterial({ color: 0x2a6fd0 })); wire.position.set(0, 0.06, 0.06); charge.add(wire);
    charge.visible = false;
    // greenery (after the grave has settled for good): blades and flowers beside / behind the stone (readable at play
    // distance: blades 0.15-0.32 m, flowers 0.18-0.34 m with 5 cm petals)
    const green = new T.Group(); grp.add(green);
    const plants = [];
    for (let i = 0; i < 34; i++) {
      const a = r(0, Math.PI * 2), d = r(0.22, 0.65), b = mesh(BLADE_GEO, GRASS[i % 3], Math.cos(a) * d, -0.03, -Math.abs(Math.sin(a)) * d * 0.8 - 0.02);
      b.scale.set(1.8, 0.001, 1.8); b.rotation.set(r(-0.35, 0.35), r(0, 3), r(-0.35, 0.35)); b.userData.h = r(0.15, 0.32); b.userData.rz = b.rotation.z; green.add(b); plants.push(b);
    }
    for (let i = 0; i < 8; i++) {
      const a = r(0, Math.PI * 2), d = r(0.25, 0.6), f = new T.Group(); f.position.set(Math.cos(a) * d, -0.03, -Math.abs(Math.sin(a)) * d * 0.8 - 0.05);
      const h = r(0.18, 0.34), stem = mesh(STEMG, STEM); stem.scale.set(2, h, 2); f.add(stem);
      const head = new T.Group(); head.position.y = h; const pm = new T.MeshStandardMaterial({ color: FLOWER[Math.floor(r(0, FLOWER.length))], roughness: 0.6 });
      for (let k = 0; k < 5; k++) { const p = mesh(PETAL_GEO, pm, Math.cos(k * 1.257) * 0.045, 0, Math.sin(k * 1.257) * 0.045); p.scale.set(2.6, 1.0, 2.6); head.add(p); }
      const core = mesh(CORE_GEO, new T.MeshStandardMaterial({ color: 0xffc21a, roughness: 0.5 })); core.scale.setScalar(2.2); head.add(core);
      head.rotation.x = -0.5; f.add(head); f.userData.h = 1; f.scale.setScalar(0.001); green.add(f); plants.push(f);
    }
    grp.userData = { body, green, plants, flies: null, seed: r(0, 10), charge, tt, led, faceMat, sideMat, blown: false };
    grp.position.set(g.x, g.y, g.z);
    return grp;
  };

  // ASSET: butterfly (models/butterfly.glb, clip flap)
  function butterflies(grp) {
    const out = [];
    for (let i = 0, n = 2 + (Math.random() < 0.5 ? 1 : 0); i < n; i++) {
      const b = new T.Group(), col = [0xffe066, 0xff8a3a, 0x9fd0ff, 0xffffff, 0xe070ff][Math.floor(r(0, 5))];
      const m = new T.MeshStandardMaterial({ color: col, roughness: 0.6, side: T.DoubleSide, transparent: true, emissive: col, emissiveIntensity: 0.15 });
      const L = new T.Mesh(WING_GEO, m), R = new T.Mesh(WING_GEO, m); R.scale.x = -1;
      const wl = new T.Group(), wr = new T.Group(); wl.add(L); wr.add(R); b.add(wl, wr);
      b.add(mesh(new T.CylinderGeometry(0.004, 0.004, 0.05, 4), DARK));
      b.position.set(r(-0.3, 0.3), 0.15, r(-0.5, -0.1)); b.userData = { wl, wr, mat: m, dir: r(0, Math.PI * 2), sp: r(0.35, 0.6), ph: r(0, 6), t: -r(0, 0.6) };
      grp.add(b); out.push(b);
    }
    return out;
  }

  GV.frame = function (grp, g, S, nrm, t, dt, w) {
    const u = grp.userData;
    // the charge: shown while the grave will still go off; its timer counts the dying beat down (before the beat starts:
    // a blinking ARM); after the blast the stone is scorched
    const armed = !!(w && w.gravePending);
    u.charge.visible = armed;
    if (armed) {
      const mine = S.phase === 'dying' && S.dyingW === w && S.dyingGrave, left = mine ? Math.max(0, S.dyingT) : -1;
      const blink = mine ? Math.sin(t * 18) > -0.2 : Math.sin(t * 6) > 0;
      drawTimer(u.tt, left >= 0 ? left.toFixed(1) : 'ARM', blink || left >= 0);
      u.led.visible = blink;
    }
    if (g.blown && !u.blown) { u.blown = true; u.faceMat.color.setRGB(0.62, 0.6, 0.58); u.sideMat.color.setRGB(0.42, 0.41, 0.4); }
    grp.position.set(g.x, g.y, g.z);
    grp.rotation.y = Math.atan2(nrm.x, nrm.z);                               // the face (local +z) turns to the camera side
    const age = g.rest && g.landT >= 0 ? S.time - g.landT : -1;
    // grass and flowers grow (ease-out over ~4 s from 0.4 s after landing; a falling grave keeps none)
    const k = age < 0.4 ? 0 : Math.min(1, (age - 0.4) / 4), e = 1 - Math.pow(1 - k, 3);
    u.green.visible = k > 0;
    for (let i = 0; i < u.plants.length; i++) {
      const p = u.plants[i], ki = Math.max(0.001, Math.min(1, e * 1.25 - (i % 5) * 0.05));
      if (p.userData.h !== 1) { p.scale.set(1, p.userData.h * ki, 1); p.rotation.z = p.userData.rz + Math.sin(t * 1.7 + i) * 0.08; }   // blades (sway a little)
      else p.scale.setScalar(ki);
    }
    // butterflies: once, 1.2 s after landing; they flutter up and away and fade
    if (age > 1.2 && !u.flies && !u.done) { u.flies = butterflies(grp); u.done = true; }
    if (u.flies) {
      let alive = 0;
      for (const b of u.flies) {
        const d = b.userData; d.t += dt; if (d.t < 0) { b.visible = false; alive++; continue; }
        b.visible = true;
        const flap = Math.sin((t + d.ph) * 26) * 1.1; d.wl.rotation.y = flap; d.wr.rotation.y = -flap;
        d.dir += Math.sin(t * 1.3 + d.ph) * dt * 1.6;
        b.position.x += Math.cos(d.dir) * d.sp * dt; b.position.z += Math.sin(d.dir) * d.sp * dt * 0.6;
        b.position.y += (0.22 + Math.sin((t + d.ph) * 3.1) * 0.5) * dt;
        b.rotation.set(0.5, -d.dir, 0);
        d.mat.opacity = Math.max(0, Math.min(1, (8 - d.t) / 1.5));
        if (d.t < 8) alive++;
      }
      if (!alive) { for (const b of u.flies) { grp.remove(b); b.traverse(o => { if (o.material) o.material.dispose(); }); } u.flies = null; }
    }
  };
  const SHARED = () => [STONE, DARK, SOIL, MOSS, STEM].concat(GRASS);
  GV.dispose = function (grp) { const sh = SHARED(); grp.traverse(o => { if (!o.isMesh || !o.material) return; for (const m of [].concat(o.material)) if (!sh.includes(m)) { if (m.map) m.map.dispose(); m.dispose(); } }); };   // (the stone has a material ARRAY: face + sides)
})(window.SS = window.SS || {});
