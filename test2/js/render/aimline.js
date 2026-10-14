/* render/aimline.js — P104 the aim guide (Three.js specific, presentation only; reads the sim state, never writes it,
 * nothing enters the hash).
 * User 2026-10-12: "aiming crosshair, do you see it? maybe, but barely, it should be clearly visible and a dotted line
 * pointing from weapon to it".
 *   - the reticle: a ring + four ticks + a centre dot, every stroke white inside a dark outline (textures.js
 *     reticleCanvas), at a FIXED ON-SCREEN size (about 8.5 % of the window height, 46..80 px) whatever the zoom, so it
 *     reads on bright sky, snow, lava, dark rock and at night;
 *   - the dotted line: evenly spaced round dots (white with a dark outline, tinted to the team colour) from the
 *     weapon's muzzle to the ring. A STRAIGHT line along the aim only: no trajectory prediction (the charge arc, wind
 *     and bounces stay for the player to judge);
 *   - shown only while the active worm is aiming a weapon that aims (S.phase 'play'; charge / hitscan / stream / rope /
 *     dig / zipline and the thrown-along-the-aim devices; not the cursor weapons, melee, drops at the feet, tools),
 *     hidden in flight (phase 'attack'), in the camera cinematics and in the kill cam.
 *   - the section rule does not clip it (the guide sits on the plane, exempt like the other overlay quads); depthTest
 *     off, renderOrder 12 (above worms and the terrain): it is an overlay on the plane, also when the aim points into
 * rock (a cut face). Everything lives in the slice frame (s along the plane, y up): the same code in 2D and 3D.
 * Porting: a HUD overlay (two textures + N quads). API: init(scene, tx), frame(S, camera), aims(S), muzzle(weapon). */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, P = SS.plane, AV = SS.aimView = {};
  const NDOT = 28, R_AIM = 3.6;                                    // dot pool; reticle distance from the worm (m)
  let ret = null, dots = [], tint = null;
  /* weapon -> muzzle distance along the aim (m): the held model's tip */
  const MUZ = { bazooka: 0.7, homing: 0.7, shotgun: 0.78, sniper: 1.2, gravgun: 0.6, zipline: 0.55, drill: 0.5, rope: 0.3 };
  AV.muzzle = w => (MUZ[w] != null ? MUZ[w] : 0.45);
  AV.aims = S => {
    const wd = C.ARSENAL[S.weapon];
    if (!wd) return false;
    const k = wd.kind;
    return k === 'charge' || k === 'hitscan' || k === 'rope' || k === 'dig' || k === 'zip' || k === 'stream' || (k === 'drop' && !!wd.vec);
  };
  function mk(map, order) {
    const m = new T.SpriteMaterial({ map, color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, toneMapped: false });
    if (SS.section) SS.section.exempt(m, 'aim guide: overlay on the plane (P104)');
    const s = new T.Sprite(m);
    s.renderOrder = order;
    s.visible = false;
    s.frustumCulled = false;
    return s;
  }
  AV.init = function (sc, tx) {
    ret = mk(tx.reticle, 12); sc.add(ret);
    for (let i = 0; i < NDOT; i++) {
      const d = mk(tx.aimdot, 11.9);
      sc.add(d);
      dots.push(d);
    }
    tint = new T.Color();
  };
  AV.hide = function () {
    if (!ret) return;
    ret.visible = false;
    for (const d of dots) d.visible = false;
  };
  /* pixels per metre at the point p (perspective or orthographic camera) */
  function ppm(cam, p) {
    const H = window.innerHeight || 600;
    if (cam.isPerspectiveCamera) return H / (2 * Math.max(0.5, cam.position.distanceTo(p)) * Math.tan(cam.fov * Math.PI / 360));
    return H / ((cam.top - cam.bottom) / (cam.zoom || 1));
  }
  AV.frame = function (S, camera) {
    if (!ret) return;
    const a = S.active;
    const on = S.phase === 'play'
      && a
      && !a.dead
      && AV.aims(S)
      && !SS.actors.walkStowed(S)
      && !(SS.cine && SS.cine.moving && SS.cine.moving())
      && !(SS.cine && SS.cine.victory && SS.cine.victory());
    if (!on) {
      AV.hide();
      return;
    }
    const ad = SS.sim.aim_dir(S), ap = P.to_plane(S, a.pos), y0 = a.pos.y + 0.02;
    const rp = P.to_world(S, ap.s + ad.s * R_AIM, a.pos.y + ad.y * R_AIM);
    ret.position.set(rp.x, rp.y, rp.z);
    // the laser sight skill: the reticle snaps to the first surface on the path
    const lh = SS.wornView && SS.wornView.laserHit && SS.wornView.laserHit();
    if (lh) ret.position.set(lh.x, lh.y, lh.z);
    const k = ppm(camera, ret.position), H = window.innerHeight || 600, px = Math.max(46, Math.min(80, H * 0.085));
    const size = px / k;
    ret.scale.set(size, size, 1); ret.visible = true;
    ret.material.color.set(S.weapon === 'rope' ? 0xcfeaff : 0xffffff);
    /* the dotted line, in the plane: from the muzzle to the ring's edge */
    const mz = AV.muzzle(S.weapon), rpl = P.to_plane(S, ret.position);
    const sM = ap.s + ad.s * mz, yM = y0 + ad.y * mz, ds = rpl.s - sM, dy = ret.position.y - yM, L = Math.hypot(ds, dy);
    const ux = L > 1e-4 ? ds / L : 0, uy = L > 1e-4 ? dy / L : 0, stop = L - size * 0.46, step = 25 / k, dsz = 11 / k;
    const rgb = (C.TEAMS[a.team] || C.TEAMS[0]).rgb;
    tint.setHex(rgb, T.SRGBColorSpace);
    let n = 0;
    if (L > 1e-3 && ad.s * (rpl.s - ap.s) >= -1e-3)
      for (let q = 0; n < NDOT; q++) {
        const t = (q + 0.5) * step;
        if (t > stop) break;
        const w = P.to_world(S, sM + ux * t, yM + uy * t), d = dots[n++];
        d.position.set(w.x, w.y, w.z);
        d.scale.set(dsz, dsz, 1);
        d.material.color.copy(tint);
        d.visible = true;
      }
    for (let i = n; i < NDOT; i++) dots[i].visible = false;
  };
})(window.SS = window.SS || {});
