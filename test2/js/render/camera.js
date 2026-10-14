/* render/camera.js — the camera director, the second file of the view module (SS.view, render/view.js). The zoom
 * the player chooses (the wheel, a pinch, the 🔍 toggle) within ZMIN..ZMAX, the pan along the section and the
 * overview's orbit; the director that picks what the camera frames (interest(): the active worm, a shell in flight
 * with its landing point, a blast, a death, the winners at the end), and V.directCamera, run by V.render each frame,
 * which places the camera. Reads the sim state; its state lives in the view record (SS.view.state).
 * C: the engine's camera rig and a director component. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, M = SS.math, P = SS.plane;
  const V = SS.view, view = V.state;
  const VPD = { x: 0, z: 0, r: 0 };                                // (scratch: the round play area, world.js play_disc)
  const v4 = new T.Vector3(), v5 = new T.Vector3();
  const WORM_H = 0.46;
  /* The camera distance (m) the player may choose runs from ZMIN to ZMAX.
   * The old floor of 8 m was reached after 3 wheel notches from the default
   * (11 m at 1280 x 800: 91 px per metre; 8.3 m: 120 px per metre, -3 to -8 notches all looked the same), so a worm and
   * a blast could never be seen from close by. ZMIN = 5 m is about 200 px per metre at any window height (a metre is a
   * quarter of the picture height there: the distance, not the window, decides). Close up the camera also drops to a
   * low pitch and centres on the worm's head (closeK below), so the face is seen side-on and the worm does not sit in
   * the lower third of the picture. */
  const ZMIN = 5, ZMAX = 80, WHEEL_K = 1.1, FAR_NOTCHES = 6;
  V.ZOOM_MIN = ZMIN; V.ZOOM_MAX = ZMAX;
  // camera pitch (rad above the horizon) and the focus height over the worm's centre (m): the default, and at the
  // tightest
  const TILT0 = 0.2, TILT_CLOSE = 0.05, FOCUS0 = 1.2, FOCUS_CLOSE = 0.35, CLOSE_FROM = 8.5, CLOSE_TO = 5.2;
  V.autoZoom = function () {
    const h = view.vh || 800, w = view.vw || 1280, W = SS.world, tgt = M.clamp(h * 0.056, 34, 60);
    let z = (h * 0.5 / Math.tan(V.camera().fov * Math.PI / 360)) * WORM_H / tgt;
    z *= Math.pow(M.clamp(W && W.SC ? W.SC : 1, 0.7, 2.2), 0.3);
    const asp = w / h;
    if (asp < 1.25) z *= Math.min(1.7, Math.pow(1.25 / asp, 0.5));
    return M.clamp(z, 8, 40);
  };
  function applyAutoZoom() {
    const z = V.autoZoom();
    if (!view.autoZ || Math.abs(view.zoom - view.autoZ) < 1e-6) view.zoom = z;
    // a window resize keeps the player's own factor
    else if (Math.abs(z - view.autoZ) > 1e-6) view.zoom = M.clamp(view.zoom * z / view.autoZ, ZMIN, ZMAX);
    view.autoZ = z;
  }
  /* d wheel notches (+ = out): the wheel, a pinch (one notch per 15 %) and the 🔍 button all end here, so they agree on
   * the range. Changing the zoom by hand puts the 🔍 toggle back to "near"; a missing d leaves the zoom alone (it
   * would be NaN for every later frame) */
  V.zoom = d => {
    if (!Number.isFinite(d)) return;
    view.zoom = M.clamp(view.zoom * Math.pow(WHEEL_K, M.clamp(d, -8, 8)), ZMIN, ZMAX);
    view.zoomBack = 0;
    view.userT = 0;
  };
  /* the 🔍 button (touch pad): far = FAR_NOTCHES notches out, near = back to EXACTLY the zoom it left (a relative +-6
   * drifted when the range clamp cut the first press short) */
  V.zoomToggle = () => {
    if (view.zoomBack) {
      view.zoom = view.zoomBack;
      view.zoomBack = 0;
    }
    else {
      view.zoomBack = view.zoom;
      view.zoom = M.clamp(view.zoom * Math.pow(WHEEL_K, FAR_NOTCHES), ZMIN, ZMAX);
    }
    view.userT = 0;
  };
  /* how tight the camera is: 0 at the loose end (the default distance and everything farther), 1 at ZMIN. The loose end
   * is CLOSE_FROM m, or 0.8 of the window's default distance on a small
   * window (the default look never changes). Drives the pitch and the focus height of the camera block below. */
  function closeK(z) { return M.smoothstep(Math.min(CLOSE_FROM, (view.autoZ || CLOSE_FROM) * 0.8), CLOSE_TO, z); }
  V.closeK = closeK;
  V.camKey = () => (view.dir.cur ? view.dir.cur.key : '');      // (tools: the director's current interest)
  V.snapCamera = () => {
    view.camT = null;
    view.dir.cur = null;
  };
  /* the director's interests (PoC interest(), px -> m: x 0.0643; d = the PoC camera distance in px) */
  const PX = 0.0643;
  /* The children of a cluster / banana bomb and the missiles of an air strike go off on first contact:
   * where a shell in flight will land is a ballistic
   * line on the plane (cached per shell for 0.3 s, 40 steps of 0.08 s at most). The director frames the shells AND
   * their landing points, in metres of camera distance (dm), so the payoff blasts are inside the picture; afterwards
   * the normal 'boom' / 'active' interests bring the camera back. */
  const landC = new WeakMap();
  function landing(S, p) {
    let c = landC.get(p);
    if (c && view.time - c.t < 0.3) return c;
    if (!c) {
      c = { t: 0, s: p.s, y: p.y };
      landC.set(p, c);
    }
    c.t = view.time;
    let s = p.s, y = p.y, vy = p.vy;
    const vs = p.vs, g = S.eow ? 0 : C.G, sea = SS.world.under ? -99 : SS.world.SEA;
    for (let i = 0; i < 40; i++) {
      s += vs * 0.08;
      y += vy * 0.08;
      vy -= g * 0.08;
      if (y < sea || P.solid2(S, s, y)) break;
    }
    c.s = s; c.y = y; return c;
  }
  function projBox(S, ex) {
    let s0 = 1e9, y0 = 1e9, s1 = -1e9, y1 = -1e9;
    const add = (s, y) => {
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    };
    // (in space there is no -y fall: no landing line, and the camera never chases bomblets that leave the wells)
    for (const p of S.proj) {
      add(p.s, p.y);
      if (!S.eow) {
        const l = landing(S, p);
        add(l.s, l.y);
      }
    }
    if (ex) add(ex[0], ex[1]);
    const camera = V.camera(), t2 = Math.tan((camera ? camera.fov : 42) * Math.PI / 360),
      asp = camera ? camera.aspect : 1.5,
      c = P.to_world(S, (s0 + s1) / 2, (y0 + y1) / 2);
    return {
      x: c.x,
      y: c.y,
      z: c.z,
      dm: Math.min(S.eow ? 48 : 110, Math.max((s1 - s0) * 1.3 / (2 * t2 * asp), (y1 - y0) * 1.5 / (2 * t2)))
    };
  }
  function interest(S, a) {
    const camera = V.camera();
    const P2 = SS.plane, at = (s, y) => P2.to_world(S, s, y);
    if (S.phase === 'place') return null;
    // the player has control: nothing but its own worm and its own shot may take the camera (edge indicators,
    // ui/offscreen.js, point at the rest)
    const ctl = S.phase === 'play';
    // the winners, for the whole end of the match: the surviving worms of the winning team in the
    // picture (the old interest framed one worm and was dropped by the first click)
    if (S.phase === 'over' && S.over >= 0) {
      // (a winner outside the slab is hidden by the section rule: in 3D the camera frames those that can be seen; if
      // none can, the winners all the same (sim.victory_align turned the section to them, so most are on it). [2]
      // = the active worm: the one who fired)
      const pts = [], all = [];
      for (const w of S.worms)
        if (!w.dead && w.hp > 0 && w.team === S.over) {
          const q = P2.to_plane(S, w.pos), p = [q.s, w.pos.y, w === a ? 1 : 0];
          all.push(p);
          if (V.inSlab(S, w.pos)) pts.push(p);
        }
      if (!pts.length)
        for (const q of all) pts.push(q);
      const t2 = Math.tan((camera ? camera.fov : 42) * Math.PI / 360), asp = camera ? camera.aspect : 1.5;
      let s0, s1, y0, y1, need;
      const box = () => {
        s0 = 1e9;
        y0 = 1e9;
        s1 = -1e9;
        y1 = -1e9;
        for (const q of pts) {
          s0 = Math.min(s0, q[0]);
          s1 = Math.max(s1, q[0]);
          y0 = Math.min(y0, q[1]);
          y1 = Math.max(y1, q[1]);
        }
        need = Math.max((s1 - s0 + 6) * 1.2 / (2 * t2 * asp), (y1 - y0 + 9) * 1.1 / (2 * t2));
      };
      box();
      // winners too far apart to celebrate in one picture: the farthest are left out of the frame (they dance anyway).
      // farthest from the ANCHOR (the active worm when it is a winner, else the first), which always stays
      while (pts.length > 1 && need > 34) {
        let ai = 0;
        for (let i = 0; i < pts.length; i++)
          if (pts[i][2]) {
            ai = i;
            break;
          }
        let mx = -1, bi = -1;
        for (let i = 0; i < pts.length; i++) {
          if (i === ai) continue;
          const d = Math.abs(pts[i][0] - pts[ai][0]) + 0.5 * Math.abs(pts[i][1] - pts[ai][1]);
          if (d > mx) {
            mx = d;
            bi = i;
          }
        }
        pts.splice(bi, 1); box();
      }
      // (the camera adds 1.5 m: the worm sits a little under the middle of the picture, the sky above it is for the
      // fireworks and the confetti)
      if (pts.length) {
        const c = at((s0 + s1) / 2, (y0 + y1) / 2 - 0.8);
        return { key: 'victory', x: c.x, y: c.y, z: c.z, d: 520, dm: Math.min(80, Math.max(view.zoom * 1.6, need)), p: 9 };
      }
    }
    // a shell bounced off a force field flies in 3D
    if (S.free3d && S.free3d.length) {
      const q = S.free3d[0];
      return { key: 'free3d', x: q.pos.x, y: q.pos.y, z: q.pos.z, d: 900, p: 9 };
    }
    if (S.phase === 'dying' && S.dyingW) {
      const w = S.dyingW, g = S.dyingGrave && w.grave ? w.grave : w.pos;
      return { key: 'dying', x: g.x, y: g.y, z: g.z, d: 480, p: 9 };
    }
    if (!ctl && S.strikes && S.strikes.length) {
      const st = S.strikes[0], pl = at(st.s, st.y);
      if (st.k === 0 && Math.abs(st.s - st.tS) > 14) return { key: 'plane', x: pl.x, y: pl.y - 2, z: pl.z, d: 820, p: 8 };
      const gy = SS.weapons && SS.weapons.ground_below ? SS.weapons.ground_below(S, st.tS, st.y) : st.y - 8, tp = at(st.tS, gy + 3.9);
      // the falling missiles and their landing points stay in the picture
      if (S.proj.length) {
        const b = projBox(S, [st.tS, gy + 3.9]);
        return { key: 'strike', x: b.x, y: b.y, z: b.z, d: 760, dm: Math.max(b.dm, view.zoom * 1.66), p: 8 };
      }
      return { key: 'strike', x: tp.x, y: tp.y, z: tp.z, d: 760, p: 8 };
    }
    // Thunder Strike: during its delay the camera looks at the TARGET on the ground (not the sky / cloud), then the
    // electrocuted worms take over (hurt, above)
    if (!ctl && S.zaps && S.zaps.length) {
      const z = S.zaps[0],
        gy = SS.weapons && SS.weapons.ground_below ? SS.weapons.ground_below(S, z.s, SS.world.SY - 0.5) : 0,
        tp = at(z.s, Math.max(gy, SS.world.SEA) + 1.5);
      return { key: 'zap', x: tp.x, y: tp.y, z: tp.z, d: 600, p: 8 };
    }
    // the alien strikes / a face hugger leaps
    if (!ctl && SS.alien && SS.alien.camera) {
      const ac = SS.alien.camera(S);
      if (ac) return ac;
    }
    // the camera runs with the robo dog
    if (S.dogs && S.dogs.length) {
      const d = S.dogs[0], c = at(d.s, d.y);
      return { key: 'dog' + d.id, x: c.x, y: c.y, z: c.z, d: 560, p: 7 };
    }
    if (!ctl && S.holes && S.holes.length) {
      const h = S.holes[0];
      return { key: 'hole', x: h.x, y: h.y, z: h.z, d: 720, p: 8 };
    }
    // after the shot the camera follows the DAMAGE: the worm being hurt (fire, a late blast) wins over falling
    // shells / gel, explosions and the shooter
    // the affected worms, one after the other, in the order they speak
    const rv = SS.reactq && !ctl ? SS.reactq.visit(S) : null, rw = rv ? S.worms[rv.id] : null;
    if (rw && rw.dead) {
      const g = rw.grave || rw.pos;
      return { key: 'death' + rw.id, x: g.x, y: g.y, z: g.z, d: 520, p: 7.6 };
    }
    // shells still in flight (the children of a bomb whose first blast hurt a worm): the hurt worm AND
    // the payoff blasts stay in the picture
    if (rw && S.proj.length) {
      const hp = P2.to_plane(S, rw.pos), b = projBox(S, [hp.s, rw.pos.y + 0.6]);
      return { key: 'hurt' + rw.id, wid: rw.id, x: b.x, y: b.y, z: b.z, d: 520, dm: Math.max(b.dm, view.zoom * 1.0), p: 7.5 };
    }
    if (rw) return { key: 'hurt' + rw.id, wid: rw.id, x: rw.pos.x, y: rw.pos.y, z: rw.pos.z, d: 520, p: 7.5 };
    // a shell lost to space: the camera holds
    if (S.eow && SS.eowView) {
      const lf = SS.eowView.lostFocus(S);
      if (lf) return lf;
    }
    if (S.proj.length) {
      // the children and where they land, in metres of camera distance (the old px formula clamped at
      // 1300 and ignored the landing)
      if (S.proj.length > 1) {
        const b = projBox(S);
        return { key: 'projs', x: b.x, y: b.y, z: b.z, d: 640, dm: Math.max(b.dm, view.zoom * 1.1), p: 7 };
      }
      const p = S.proj[0],
        sp = Math.hypot(p.vs, p.vy),
        cin = SS.cine && SS.cine.enabled,
        ld = cin ? 0.2 : 0.12,
        c = at(p.s + p.vs * ld, p.y + p.vy * ld);
      // a long shot zooms out a little more
      return { key: 'proj' + (p.id || 0), x: c.x, y: c.y, z: c.z, d: M.clamp(560 + sp / PX * 0.3, 560, cin ? 980 : 860), p: 7 };
    }
    // no camera interest for falling crates (the camera never leaves the player for one): ui/offscreen.js shows an
    // edge arrow instead
    if (!ctl && S.moais)
      for (const m of S.moais) {
        const b = SS.bodies.by_id(S, m.body);
        if (b && Math.hypot(b.vel.x, b.vel.y, b.vel.z) > 25 * PX) return { key: 'moai', x: b.pos.x, y: b.pos.y, z: b.pos.z, d: 640, p: 6 };
      }
    const ex = S.lastExplosion;
    if (!ctl && ex && S.time - (S.lastBlastT == null ? -99 : S.lastBlastT) < 1.4 && ex.R >= 14 * PX)
      return { key: 'boom' + S.lastBlastT.toFixed(2), x: ex.x, y: ex.y, z: ex.z, d: M.clamp(470 + ex.R / PX * 4.5, 540, 1050), p: 6 };
    if (S.phase === 'play' && a && !a.dead) return { key: 'active', x: a.pos.x, y: a.pos.y, z: a.pos.z, d: 0, p: 5 };
    let fw = null, fs = 150 * PX;                 // a thrown worm (PoC 150 px/s; worms fly at the PoC gravity here)
    for (const w of S.worms)
      if (!w.dead && !w.rest && w !== a && w.vel) {
        const sp = Math.hypot(w.vel.x, w.vel.y, w.vel.z);
        if (sp > fs) {
          fs = sp;
          fw = w;
        }
      }
    if (fw) return { key: 'fly' + fw.id, x: fw.pos.x, y: fw.pos.y, z: fw.pos.z, d: 640, p: 5 };
    for (const b of S.bodies) {
      if (b.asleep || !b.vel) continue;
      const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
      if (sp < 6) continue;
      for (const w of S.worms) {
        if (w.dead) continue;
        const dx = w.pos.x - b.pos.x, dy = w.pos.y - b.pos.y, dz = w.pos.z - b.pos.z, dd = Math.hypot(dx, dy, dz);
        if (dd < 10 && dx * b.vel.x + dy * b.vel.y + dz * b.vel.z > 0.5 * dd * sp)
          return {
            key: 'threat' + (b.id || 0),
            x: (w.pos.x + b.pos.x) / 2,
            y: (w.pos.y + b.pos.y) / 2,
            z: (w.pos.z + b.pos.z) / 2,
            d: M.clamp(440 + dd / PX * 1.6, 540, 820),
            p: 5
          };
      }
    }
    // ... and else the burning area (napalm / oil flames: their centre and spread) until the fire is out
    if (S.phase !== 'play' && S.flames.length) {
      let x0 = 1e9, z0 = 1e9, y0 = 1e9, x1 = -1e9, z1 = -1e9, y1 = -1e9;
      for (const f of S.flames) {
        x0 = Math.min(x0, f.x);
        x1 = Math.max(x1, f.x);
        y0 = Math.min(y0, f.y);
        y1 = Math.max(y1, f.y);
        z0 = Math.min(z0, f.z);
        z1 = Math.max(z1, f.z);
      }
      const span = Math.max(x1 - x0, z1 - z0, y1 - y0);
      return { key: 'fire', x: (x0 + x1) / 2, y: (y0 + y1) / 2 + 0.6, z: (z0 + z1) / 2, d: M.clamp(500 + span / PX * 0.9, 520, 900), p: 4 };
    }
    if (a && !a.dead) return { key: 'active', x: a.pos.x, y: a.pos.y, z: a.pos.z, d: 0, p: 3 };
    return null;
  }
  /* left-drag: pan along the section; while inspecting: orbit */
  V.drag = function (dx, dy, S) {
    if (S && S.inspect > 0.5) {
      view.orbit.yaw = M.clamp(view.orbit.yaw - dx * 0.006, -1.4, 1.4);
      view.orbit.tilt = M.clamp(view.orbit.tilt + dy * 0.004, -0.5, 0.7);
      return;
    }
    const k = view.zoom * 0.0016;
    view.pan.s = M.clamp(view.pan.s - dx * k, -60, 60); view.pan.y = M.clamp(view.pan.y + dy * k, -15, 25); view.userT = 0;
  };
  V.resetPan = () => {
    view.pan.s = view.pan.y = 0;
    view.orbit.yaw = view.orbit.tilt = 0;
  };

  /* each frame: the camera framing what the director picked (or the cinematic / anticipation cameras' moves), at the
   * player's zoom, a side-on pitch from the plane's camera side (the overview swings into a 3D orbit of the whole map),
   * never inside the terrain, shaken by the blasts */
  V.directCamera = function (S, dtU, insp) {
    const camera = V.camera(), a = S.active, d = P.dir(S), n = P.nrm(S);
    // camera: side-on from the +normal side with a slight downward tilt; inspection swings into a 3D overview.
    if (a && a.id !== view.activeId) {
      view.activeId = a.id;
      V.resetPan();
    }
    // PoC: walking, jumping, charging or firing hands the camera back to the worm (a manual pan eases out)
    if (a && !a.dead && (a.walking || a.air || S.charging || S.proj.length) && (view.pan.s || view.pan.y)) {
      const k = Math.exp(-dtU * 5);
      view.pan.s *= k;
      view.pan.y *= k;
      if (Math.abs(view.pan.s) + Math.abs(view.pan.y) < 0.05) view.pan.s = view.pan.y = 0;
    }
    // the camera director (interest() / updateCamera): the most interesting thing wins by priority, a new interest of
    // the same or lower priority takes over only after 1.2 s; zoom = the interest's distance / its default 640 px x the
    // player's own zoom
    if (SS.reactq) SS.reactq.frame(S, dtU);
    // the end-of-match clock (celebration, results card), whatever the cine option says
    if (SS.cine) SS.cine.tick(S, dtU);
    const it = interest(S, a), dr = view.dir, cin = SS.cine && SS.cine.enabled, prevKey = dr.cur ? dr.cur.key : '';
    dr.since += dtU;
    if (
      it
      && (
        !dr.cur
        || it.key === dr.cur.key
        || it.p > dr.cur.p
        || dr.since > 1.2
        || (dr.cur.key.startsWith('proj') && (it.key.startsWith('boom') || it.key.startsWith('proj')))
        || (S.phase === 'play' && it.key === 'active')
      )
    ) {
      if (!dr.cur || it.key !== dr.cur.key) dr.since = 0;
      dr.cur = it;
    }
    else if (!it && dr.cur && dr.since > 1.2) dr.cur = null;
    const cur = view.lock
      || dr.cur
      || { key: 'active', x: a ? a.pos.x : SS.world.MX, y: a ? a.pos.y : 10, z: a ? a.pos.z : SS.world.MZ, d: 0, p: 0 };
    const co = cin ? SS.cine.frame(S, dtU, cur.key, view) : null;                    // the cinematic moves on top of the director
    // the overview (V) frames the WHOLE map: the focus slides to the world centre, the distance grows to fit it
    const pk = cur.key === 'active' || cur.key === 'victory' ? 1 : 0, Wd = SS.world, oi = Wd && !Wd.flat ? insp : 0;
    applyAutoZoom();
    // a worm's face acting (an idle antic, a hit) pulls the camera in on it
    const ac = SS.anticCam ? SS.anticCam.frame(S, dtU, cur, co, view, insp) : null;
    // active: a charging shot / a target pick pulls the view back a little so the flight and the target stay in frame;
    // an event (shell, blast, death) frames x1.4 of the default
    const pull = cur.key === 'active' && a && S.phase === 'play'
      ? (SS.CFG.ARSENAL[S.weapon] && SS.CFG.ARSENAL[S.weapon].kind === 'target' ? 1.6 : S.charging ? 1.35 : 1)
      : 1;
    // (cur.zk = how close an interest may zoom: the face hugger latching, the burst)
    const wantZ0 = cur.key === 'active'
      ? view.zoom * pull
      : cur.dm
      ? Math.max(view.zoom * (cur.zk || 0.85), cur.dm)
      : Math.max(view.zoom * (cur.zk || 0.85), view.zoom * 1.4 * cur.d / 640),
      wantZ = ac && ac.k ? Math.min(wantZ0, ac.dist) : wantZ0;
    // the camera jumps to this interest this frame (the first frame, a snap, an instant cut with the cinematic camera
    // off): the distance is set BEFORE the pitch and the focus height read it, so the jump frame is the picture the
    // next frames hold (it used the old distance's closeK: a pitch pop, and two studio shots of one scene differed)
    const cut = !view.camT || (!cin && SS.cine && cur.key !== prevKey && prevKey && !view.lock);
    if (cut) view.camZ = wantZ;
    // how tight the camera is (the pitch and the focus height below); the overview (V) fades it out over its
    // first quarter
    const zc = view.camZ || view.zoom, ck = closeK(zc) * M.sat(1 - insp * 4);
    const fx = cur.x + d.x * view.pan.s * pk + (Wd ? (Wd.MX - cur.x) * oi : 0),
      fy = cur.y
        + FOCUS0
        + (FOCUS_CLOSE - FOCUS0) * ck
        + view.pan.y * pk
        + (co ? co.dy : 0)
        + (ac ? ac.dy : 0)
        + (Wd ? (Wd.SY * 0.3 - cur.y) * oi : 0),
      fz = cur.z + d.z * view.pan.s * pk + (Wd ? (Wd.MZ - cur.z) * oi : 0);
    if (!view.camT) view.camT = new T.Vector3(fx, fy, fz);
    else if (cut) view.camT.set(fx, fy, fz);
    const rate = cur.key === 'active' ? 6 : cur.p >= 7 ? 4.5 : 3.2;
    const tp = co ? SS.cine.turnPos(fx, fy, fz, v5) : null;
    if (tp) view.camT.copy(tp);
    else view.camT.lerp(v4.set(fx, fy, fz), 1 - Math.exp(-dtU * rate));
    /* The focus never lags off the section plane. The sim puts a new plane through the new worm at once (a new
     * turn, a worm switch, the end of the match), but the focus
     * the camera had moves on from where it was: the camera hangs off the plane's normal at that focus, so with the old
     * focus 10-50 m BEHIND the new plane it sat inside the hill (a full-frame rock close-up for the first 0.4 s of the
     * turn move: 218 of 71 572 frames inside rock and 798 behind the plane in 192 turns, tools/dev/qa/camsweep.cjs).
     * What lies in front of the plane is never drawn: only the part of the focus beyond the slab (C.HALF) is taken out
     * along the normal, so the picture always shows the cut face from the viewer's side. The overview (insp) and the 3D
     * interest of a shell bounced off a force field (free3d) keep their own focus. */
    if (insp < 0.02 && cur.key !== 'free3d') {
      const tF = (view.camT.x - S.O.x) * n.x + (view.camT.z - S.O.z) * n.z, ex = tF > C.HALF ? tF - C.HALF : tF < -C.HALF ? tF + C.HALF : 0;
      if (ex) {
        view.camT.x -= n.x * ex;
        view.camT.z -= n.z * ex;
      }
    }
    view.camZ += (wantZ - view.camZ) * (1 - Math.exp(-dtU * (ac && ac.rate ? ac.rate : cur.dm && wantZ > view.camZ ? 4.5 : 2.4)));
    if (insp < 0.05) {
      view.orbit.yaw *= Math.exp(-dtU * 4);
      view.orbit.tilt *= Math.exp(-dtU * 4);
    }
    const tilt = TILT0 + (TILT_CLOSE - TILT0) * ck + insp * (0.5 + view.orbit.tilt),
      yaw = insp * (0.55 + view.orbit.yaw) + (co && insp < 0.05 ? co.yaw : 0),
      dist0 = M.max(co ? M.min(7, zc) : 0, (view.camZ || view.zoom) * (1 + insp * 0.9) * (co ? co.k : 1)),
      // (the overview frames the round play area: its diameter; a 2D slab / the End of the World: the box's diagonal)
      fitD = oi > 0 && Wd
        ? 0.52 * (Wd.play_disc(VPD) ? 2 * VPD.r : Math.hypot(Wd.SX, Wd.SZ)) / Math.tan(camera.fov * Math.PI / 360)
          * (camera.aspect < 1.3 ? 1.3 / camera.aspect : 1)
        : 0,
      dist = dist0 + (M.max(dist0, fitD) - dist0) * oi;
    // zooming out shows more of the map, not more fog:
    // the fog / haze / weather density is keyed to the DEFAULT camera distance, not the real one: fogK = default /
    // actual distance, so the play area looks the same at any zoom (only what lies farther than the focus fades more);
    // the overview (V) clears the haze fully
    if (SS.secCut) SS.secCut.frame(S, view, camera, insp, dist);
    view.fogK = M.clamp((view.autoZ || view.zoom) / Math.max(dist, 1), 0.04, 1) * (1 - 0.9 * insp);
    SS.terrain.uniforms.uCtxHaze.value = (V.slice === 'full' ? 0 : 1) * (1 - insp);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), bx = n.x * cy + d.x * sy, bz = n.z * cy + d.z * sy;
    camera.position.set(
      view.camT.x + bx * dist * Math.cos(tilt),
      view.camT.y + dist * Math.sin(tilt),
      view.camT.z + bz * dist * Math.cos(tilt)
    );
    /* Wherever terrain is drawn at the camera (the whole world while the overview is on, or the section's far
     * side) the camera is never inside it: a few frames at the start of the overview
     * (the section rule switches off while the camera still hangs 5-11 m in front of the plane, inside a hill that has
     * just appeared; 5 of 1620 frames at the closest zoom) are lifted out. Not in caves (a block of rock whose near
     * half is a ghost by design: the camera is inside it on purpose). */
    if (!Wd.under && (insp > 0.05 || (camera.position.x - S.O.x) * n.x + (camera.position.z - S.O.z) * n.z <= 0.5)) {
      const px = camera.position.x, pz = camera.position.z;
      let py = camera.position.y, k = 0;
      while (k < 80 && Wd.sample(px, py, pz) > 0) {
        py += 0.5;
        k++;
      }
      if (k > 0) camera.position.y = py + 0.3;
    }
    camera.lookAt(view.camT);
    if (V.camHook) V.camHook(camera, view);                                   // tools only: a free camera (top-down comparison shots)
    if (co && co.roll && insp < 0.05) camera.rotateZ(co.roll);
    const sh = SS.fx.shake();
    // a smooth, damped rattle (a few mixed frequencies, mostly vertical and along the slab), not white noise
    if (sh > 0) {
      const q = view.time,
        k = sh * sh * 0.3 + sh * 0.12,
        ox = Math.sin(q * 43.0) * 0.6 + Math.sin(q * 71.0 + 1.3) * 0.4,
        oy = Math.sin(q * 51.0 + 0.7) * 0.7 + Math.sin(q * 29.0) * 0.3,
        oz = Math.sin(q * 37.0 + 2.1) * 0.5 + Math.sin(q * 83.0) * 0.5;
      camera.position.x += ox * k * 0.5; camera.position.y += oy * k * 0.6; camera.position.z += oz * k * 0.5;
    }
  };
})(window.SS = window.SS || {});
