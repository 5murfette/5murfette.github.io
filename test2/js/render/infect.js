/* render/infect.js — the worm side of the alien business (P47): the head frame the face hugger sits on, and the look of an INFECTED worm.
 *   worm_post   (hook in render/actors.js, once per worm and frame, after the soft body's tube is built): writes v.af = the face frame in
 *               body-local space { cx, cy, ca, R } (the head ball: the spine sample at u = 0.93, its tangent angle and radius) plus the neck
 *               samples (nx, ny, na, nr, nn) the hugger's tail winds round; covers the worm's eyes / mouth while a hugger is on its face.
 *   worm_pre    (hook before the tube is built) the chest of an infected worm: a swelling that pulses like a heartbeat and now and then
 *               THRASHES (something moves inside); both grow with the severity (the sim's AL.infection: time to the death).
 *   skin        a sickly pallor over the worm's skin (a second, lit mesh on the same live geometry: a pale yellow-green at up to ~60 % opacity,
 *               stronger towards the death) - independent of the soot / wet / flash colour logic of the actors.
 *   symptoms    sweat drops sliding off the head (instanced beads), now and then a cough (the head jerks, a lime puff) and a shiver.
 * Presentation only (Math.random is fine). Materials: one MeshBasicMaterial (multiply blended), one MeshStandardMaterial (sweat). */
(function (SS) {
  'use strict';
  const T = window.THREE, AV = SS.alienView = SS.alienView || {};
  const NS = 150, IH = 139, NN = 16;
  const INF = { stage: 0, left: 0, ttd: 0, sev: 0, pulses: 0 };
  let M_SICK = null, sweatMesh = null, sweat = [];
  const SWEAT_N = 72, g9 = 9.81;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const v3 = new T.Vector3(), m4 = new T.Matrix4(), q0 = new T.Quaternion(), sc = new T.Vector3();

  function res() {
    if (M_SICK) return;
    M_SICK = new T.MeshStandardMaterial({ color: 0xa9c46a, roughness: 0.55, metalness: 0, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    M_SICK.userData.shared = true;
  }
  AV.inf_init = function (root) {
    res();
    sweat.length = 0;
    if (sweatMesh) { sweatMesh.parent && sweatMesh.parent.remove(sweatMesh); sweatMesh.geometry.dispose(); sweatMesh.material.dispose(); }
    sweatMesh = new T.InstancedMesh(new T.SphereGeometry(1, 7, 5), new T.MeshStandardMaterial({ color: 0xdff4ff, roughness: 0.06, metalness: 0, transparent: true, opacity: 0.82, emissive: 0x20303a }), SWEAT_N);
    sweatMesh.frustumCulled = false; sweatMesh.count = 0; root.add(sweatMesh);
  };

  /* ---------- the head frame ---------- */
  function frameOf(v, sp) {
    let af = v.af;
    if (!af) { af = v.af = { cx: 0, cy: 0, ca: 0, R: 0.13, nx: new Float32Array(NN), ny: new Float32Array(NN), na: new Float32Array(NN), nr: new Float32Array(NN), nn: NN }; }
    af.cx = sp.x[IH]; af.cy = sp.y[IH]; af.ca = sp.a[IH]; af.R = Math.max(0.09, sp.r[IH] * 1.03);
    for (let j = 0; j < NN; j++) { const i = IH - 8 - 2 * j; af.nx[j] = sp.x[i]; af.ny[j] = sp.y[i]; af.na[j] = sp.a[i]; af.nr[j] = sp.r[i]; }
    return af;
  }

  /* ---------- the chest ---------- */
  function heart(t, sev) {                                          // 0..1: a beat (two thumps) whose rate climbs with the severity
    const w = 1.4 + 1.8 * sev, p = (t * w) % 1;
    return Math.max(Math.exp(-Math.pow((p - 0.1) / 0.06, 2)), 0.65 * Math.exp(-Math.pow((p - 0.32) / 0.07, 2)));
  }
  function thrash(t, sev) {                                         // 0..1: bursts of movement inside, rare at first
    const a = Math.max(0, Math.sin(t * 0.83 + 1.3) * Math.sin(t * 2.1)), b = Math.max(0, Math.sin(t * 1.7 + 0.4) * Math.sin(t * 3.3 + 2.0));
    return Math.pow(Math.max(a, b * 0.8), 2) * (0.35 + 0.65 * sev);
  }
  /* a hugged worm goes limp (P47b): the neck gives way and the head nods forward onto the chest, a slow sag with now and then a twitch / shudder
   * that runs down the body (non-gory: no blood, nothing is shown of the face). The spine arrays are bent from the neck up by a growing angle,
   * so the face frame the hugger sits on (worm_post) follows. */
  const OX = new Float32Array(NS), OY = new Float32Array(NS);
  function limp(S, w, v, sp, dt) {
    const hugged = w.hug != null && w.hug >= 0 && !w.dead;
    v.hugK = (v.hugK || 0) + ((hugged ? 1 : 0) - (v.hugK || 0)) * Math.min(1, dt * 3);
    if (v.hugK < 0.004) { v.hugK = 0; return; }
    const k = v.hugK, t = (v.hugT = (v.hugT || 0) + dt), id = (w.id || 0) * 2.7;
    const tw = Math.pow(Math.max(0, Math.sin(t * 6.1 + id) * Math.sin(t * 1.7 + id * 1.3)), 2), tw2 = Math.pow(Math.max(0, Math.sin(t * 9.3 + id * 0.6) * Math.sin(t * 2.3 + 0.8)), 3);
    const d = k * (0.5 + 0.06 * Math.sin(t * 0.9 + id)) + k * 0.2 * tw, i0 = 70;
    for (let i = 0; i < NS; i++) { OX[i] = sp.x[i]; OY[i] = sp.y[i]; }
    let cx = sp.x[i0], cy = sp.y[i0];
    for (let i = i0 + 1; i < NS; i++) {
      const u = (i - i0) / (NS - 1 - i0), c = d * Math.pow(u, 0.8) + 0.05 * k * tw2 * Math.sin(t * 31 + i * 0.1), ca = Math.cos(c), sa = Math.sin(c), dx = OX[i] - OX[i - 1], dy = OY[i] - OY[i - 1];
      cx += dx * ca - dy * sa; cy += dx * sa + dy * ca; sp.x[i] = cx; sp.y[i] = cy; sp.a[i] += c;
    }
    for (let i = 0; i < NS; i++) { const u = i / (NS - 1); sp.r[i] *= 1 - 0.06 * k * (0.5 + 0.5 * Math.sin(t * 2.4 - u * 6)) * tw2 + 0.015 * k * Math.sin(t * 1.3 - u * 5); }
    v.hugTw = tw2;
  }
  /* P51: the worm in the snake's coils: squeezed (the radii shrink, a little more between the turns), coated in green slime (a glossy overlay on the same live
   * geometry, fading slowly after the kill / the release), and its spine is copied (v.spc: body-local x, y, a, r at NS samples) for the snake's coils (render/xeno.js).
   * WRAP = the spine range the coils cover (sample indices, tail .. neck). */
  const WRAP = AV.WRAP = { jT: 22, jH: 128, jHead: 140 };
  let M_SLIME = null;
  function squeeze(S, w, v, sp, dt) {
    let want = 0;
    for (const X of S.alien.xenos) if (X.target === w.id && X.st >= 2 && X.st <= 4) { want = X.st === 2 ? M.sat((S.time - X.t0) / SS.alien.K.WRAP_T) : 1; break; }
    v.wrapK = (v.wrapK || 0) + (want - (v.wrapK || 0)) * Math.min(1, dt * (want > 0 ? 5 : 1.5));
    v.slimeK = want > 0 ? Math.max(v.slimeK || 0, M.sat(((v.slimeK || 0) + dt * 0.9))) : Math.max(0, (v.slimeK || 0) - dt * 0.2);
    const k = v.wrapK; if (k < 0.004) { v.wrapK = 0; return; }
    const n = v.wrapN || 2.2, ph = (v.hugT = v.hugT || 0);
    for (let i = WRAP.jT - 8; i <= WRAP.jH + 8; i++) {
      const u = (WRAP.jH - i) / (WRAP.jH - WRAP.jT), e = M.sat(Math.min((i - (WRAP.jT - 8)) / 8, (WRAP.jH + 8 - i) / 8));
      sp.r[i] *= 1 - k * e * (0.11 + 0.05 * Math.cos(6.2832 * n * u));
    }
  }
  const M = { sat: x => Math.min(1, Math.max(0, x)) };
  AV.worm_pre = function (S, w, v, sp, dt) {
    if (!SS.alien) return;
    squeeze(S, w, v, sp, dt);
    limp(S, w, v, sp, dt);
    SS.alien.infection(S, w, INF);
    const sev = INF.stage === 2 ? 0.12 + 0.88 * INF.sev : 0;
    v.infK = (v.infK || 0) + (sev - (v.infK || 0)) * Math.min(1, dt * 2.2);
    if (v.infK < 0.004) { v.infK = 0; return; }
    const t = (v.infT = (v.infT || 0) + dt), k = v.infK, hb = heart(t + (w.id || 0), k), th = thrash(t + (w.id || 0) * 3, k);
    const uc = 0.39 + 0.045 * Math.sin(t * 0.7), amp = 0.2 + 0.5 * k;
    v.infBulge = hb * 0.5 + th;
    for (let i = 0; i < NS; i++) {
      const u = i / (NS - 1), d = (u - uc) / 0.075, bump = Math.exp(-d * d), d2 = (u - (uc + 0.07)) / 0.04, bump2 = Math.exp(-d2 * d2);
      if (bump < 0.01 && bump2 < 0.01) continue;
      sp.r[i] *= 1 + amp * (0.5 + 0.5 * hb) * bump + 0.7 * amp * th * bump2 + 0.2 * k * bump;
    }
  };

  /* ---------- per frame, after the tube ---------- */
  const puff = (v, k) => {                                          // a lime cough puff at the face
    const F = SS.fx; if (!F || !F.spawn || !v.root.visible) return;
    v.root.updateMatrixWorld(true); const af = v.af; if (!af) return;
    v3.set(af.cx + Math.cos(af.ca) * af.R, af.cy + Math.sin(af.ca) * af.R, 0).applyMatrix4(v.body.matrixWorld);
    const n = 4 + Math.round(5 * k);
    for (let i = 0; i < n; i++) F.spawn(F.KIND.SMOKE, v3.x + rnd(-0.08, 0.08), v3.y + rnd(-0.05, 0.1), v3.z + rnd(-0.08, 0.08), { vx: rnd(-0.5, 0.9), vy: rnd(0.2, 0.9), vz: rnd(-0.3, 0.3), life: rnd(0.9, 1.7), s0: 0.1, s1: rnd(0.4, 0.7), c0: [0.35, 0.62, 0.12], c1: [0.5, 0.72, 0.3], a0: 0.5, buoy: 0.25, drag: 0.9 });
  };
  AV.worm_post = function (S, w, v, sp, dt, view) {
    const af = frameOf(v, sp);
    if (v.wrapK > 0.004) {                                              // (the snake's coils read it)
      let c = v.spc; if (!c) c = v.spc = new Float32Array(NS * 4);
      for (let i = 0; i < NS; i++) { c[i * 4] = sp.x[i]; c[i * 4 + 1] = sp.y[i]; c[i * 4 + 2] = sp.a[i]; c[i * 4 + 3] = sp.r[i]; }
    }
    // the slime coat
    const sk = v.slimeK || 0;
    if (sk > 0.01 && !v.slimeM) {
      if (!M_SLIME) { M_SLIME = new T.MeshPhysicalMaterial({ color: 0x4fd414, roughness: 0.1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, emissive: 0x0f5a02, emissiveIntensity: 0.8, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }); M_SLIME.userData.shared = true; }
      v.slimeM = new T.Mesh(v.geo, M_SLIME.clone()); v.slimeM.frustumCulled = false; v.slimeM.renderOrder = 2; v.slimeM.material.userData.shared = false; v.body.add(v.slimeM);
    }
    if (v.slimeM) {
      v.slimeM.visible = sk > 0.01 && v.root.visible && !w.eaten;
      if (v.slimeM.visible) { const gl = 0.9 + 0.1 * Math.sin((v.hugT = (v.hugT || 0) + dt) * 3.1); v.slimeM.material.opacity = Math.min(0.66, sk * 0.66) * gl; }
    }
    // a hugger on the face covers the eyes and the mouth
    const hugged = w.hug != null && w.hug >= 0 && !w.dead;
    if (hugged || v.hugHide) { v.eyes.visible = !hugged; v.mouth.visible = !hugged; v.hugHide = hugged; }
    // the skin
    const k = v.infK || 0;
    if (k > 0 && !v.sick) {
      res(); v.sick = new T.Mesh(v.geo, M_SICK.clone()); v.sick.frustumCulled = false; v.sick.renderOrder = 1; v.sick.material.userData.shared = false; v.body.add(v.sick);
    }
    if (v.sick) {
      v.sick.visible = k > 0 && v.root.visible;
      if (k > 0) {
        const pulse = 0.5 + 0.5 * (v.infBulge || 0), tk = Math.min(1, 0.3 + 0.7 * k);
        v.sick.material.opacity = (0.2 + 0.4 * tk) * (0.88 + 0.12 * pulse);
        v.sick.material.color.setRGB(0.36 - 0.2 * k, 0.36 + 0.03 * k, 0.12 - 0.05 * k); v.sick.material.emissive.setRGB(0.02 * k, 0.07 * tk * k, 0.0);
      }
    }
    if (k <= 0 && v.sick && v.infK === 0) { v.sick.visible = false; }
    if (k <= 0) return;
    // symptoms: a cough every few seconds (the head jerks, a puff), more often as it gets worse
    v.coughIn = (v.coughIn == null ? rnd(2, 5) : v.coughIn) - dt;
    if (v.coughIn <= 0 && v.root.visible) {
      v.coughIn = rnd(7, 12) * (1.3 - 0.8 * k);
      v.flinchT = Math.max(v.flinchT || 0, 0.45);                       // (eyes screwed shut: render/actors.js flinch)
      puff(v, k);
    }
    // sweat: beads that form on the head and run off
    if (sweatMesh && v.root.visible && (S.phase !== 'over')) {
      v.sweatAcc = (v.sweatAcc || 0) + dt * (1.2 + 5.5 * k);
      while (v.sweatAcc >= 1 && sweat.length < SWEAT_N) {
        v.sweatAcc -= 1;
        const a = rnd(-1.2, 1.2), rr = af.R * rnd(0.85, 1.0);
        v3.set(af.cx + Math.cos(af.ca + 1.57 + a * 0.6) * rr * 0.9, af.cy + Math.sin(af.ca + 1.57 + a * 0.6) * rr * 0.9 + rnd(-0.02, 0.05), rnd(-0.11, 0.11)).applyMatrix4(v.body.matrixWorld);
        sweat.push({ x: v3.x, y: v3.y, z: v3.z, vx: rnd(-0.1, 0.1), vy: rnd(0, 0.2), vz: rnd(-0.1, 0.1), life: rnd(0.7, 1.3), r: rnd(0.016, 0.028) });
      }
    }
  };
  AV.inf_frame = function (S, dt) {
    if (!sweatMesh) return;
    let n = 0;
    for (let i = sweat.length - 1; i >= 0; i--) {
      const d = sweat[i]; d.life -= dt; d.vy -= g9 * 0.6 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      if (d.life <= 0 || SS.world.sample(d.x, d.y, d.z) > 0) { sweat.splice(i, 1); continue; }
    }
    for (const d of sweat) { if (n >= SWEAT_N) break; v3.set(d.x, d.y, d.z); const s = d.r * Math.min(1, d.life * 3); sc.set(s, s * 1.3, s); m4.compose(v3, q0.identity(), sc); sweatMesh.setMatrixAt(n++, m4); }
    sweatMesh.count = n; sweatMesh.instanceMatrix.needsUpdate = true;
  };
  /* a pulse of the parasite: the worm doubles over (the hurt flinch comes with the sim's hit), a big puff; the chest thrashes */
  AV.inf_pulse = function (S, e, vOf) {
    const v = vOf(e.worm); if (!v) return;
    v.flinchT = Math.max(v.flinchT || 0, 0.9); puff(v, 1); v.infT = (v.infT || 0) + 0.3;
  };
})(window.SS = window.SS || {});
