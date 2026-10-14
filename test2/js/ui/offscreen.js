/* ui/offscreen.js — edge indicators for things happening off screen. The camera never leaves the player's worm for
 * them while the player has control (a camera that wanders off to a crate in the middle of the player's turn is a
 * nuisance); instead a small arrow + icon sits on the screen edge pointing at them: a falling supply crate, an awake
 * alien, a whirlwind, a lightning strike (2.5 s). Hidden while the target is on screen. Reads the sim state only. */
(function (SS) {
  'use strict';
  const OS = SS.offscreen = {};
  const T = window.THREE, PHASE = SS.CFG.PHASE, EV = SS.CFG.EV, D = SS.dom;
  let host = null, camera = null, canvas = null, v3 = null, pool = null, strikes = [];
  OS.targets = [];                                    // (tests) what was shown this frame: { key, kind, x, y }
  OS.init = function (labels, cam, cv) {
    host = labels;
    camera = cam;
    canvas = cv;
    v3 = new T.Vector3();
    pool = D.pool(host, 'edgeind', '<i class="ar"></i><b></b>');
  };
  OS.onEvent = function (S, e) {
    if (e.type === EV.LIGHTNING && e.x != null) {
      strikes.push({ x: e.x, y: e.y, z: e.z, t: S.time });
      if (strikes.length > 4) strikes.shift();
    }
    if (e.type === EV.RESET) strikes.length = 0;
  };
  OS.draw = function (S) {
    if (!host || !camera || !canvas) return;
    const vs = D.view_size(canvas), W = vs.w || innerWidth, H = vs.h || innerHeight, list = OS.targets;
    list.length = 0;
    if (S.phase !== PHASE.PLACE && S.phase !== PHASE.OVER) {
      if (S.crates)
        for (const c of S.crates)
          if (!c.landed && !c.held && c.pos) list.push({ key: 'c' + c.id, icon: '\u{1F4E6}', p: c.pos });
      if (S.alien && S.alien.xenos)
        for (const X of S.alien.xenos)
          if (X.n && X.n[0] && X.st !== 7) list.push({ key: 'x' + X.id, icon: '\u{1F47D}', p: X.n[0] });
      if (S.wind && S.wind.whirls) {
        let k = 0;
        for (const w of S.wind.whirls)
          if (k < 2 && w.age < w.life && SS.world) {
            k++;
            list.push({ key: 'w' + k, icon: '\u{1F32A}', p: { x: w.x, y: w.h != null ? w.h : S.active ? S.active.pos.y : 0, z: w.z } });
          }
      }
      for (let i = strikes.length - 1; i >= 0; i--) {
        if (S.time - strikes[i].t > 2.5 || S.time < strikes[i].t) strikes.splice(i, 1);
        else list.push({ key: 'l' + i, icon: '⚡', p: strikes[i] });
      }
    }
    let n = 0;
    for (let i = 0; i < list.length && n < 8; i++) {
      const t = list[i];
      v3.set(t.p.x, t.p.y, t.p.z).project(camera);
      let sx = v3.x, sy = v3.y;
      const behind = v3.z > 1;
      if (behind) {
        sx = -sx;
        sy = -sy;
      }
      const m = 0.9, inside = !behind && Math.abs(sx) < m && Math.abs(sy) < m;
      if (inside) continue;
      let dx = sx, dy = sy;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      // the box the arrows sit on (NDC): inside the screen border; on a phone also below the top strip and above the
      // touch controls and the weapon line (assets/hud.css body.phone: upright, the strip has two rows and the weapon
      // line sits above the small button row)
      const cl = document.body.classList, phone = cl.contains('phone'), up = cl.contains('portrait'), my = m * (H > 90 ? 0.88 : 1);
      const top = phone ? 1 - 2 * (up ? 84 : 64) / H : my, bot = phone ? 1 - 2 * (up ? 210 : 140) / H : my;
      const k = Math.min(m / (Math.abs(dx) || 1e-6), (dy > 0 ? top : bot) / (Math.abs(dy) || 1e-6));
      const px = (dx * k + 1) / 2 * W, py = (1 - dy * k) / 2 * H, q = pool.at(n++);
      t.x = px; t.y = py;
      D.show(q, true, 'flex');
      D.place(q, px, py, D.CENTER);
      D.style(q.firstChild, 'transform', `rotate(${Math.round(Math.atan2(-dy, dx) * 180 / Math.PI + 90)}deg)`);
      D.text(q.lastChild, t.icon);
      if (q.dataset.key !== t.key) q.dataset.key = t.key;
    }
    pool.end(n);
    OS.shown = n;
  };
  OS.shown = 0;
})(window.SS = window.SS || {});
