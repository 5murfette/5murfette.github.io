/* render/polish.js — P38 A5: small readability / feel layers found by the studio audit (presentation only; Math.random
 * is fine).
 *   - muzzle flash + smoke + recoil for the firearms that had none: shotgun, sniper, bazooka / homing (with a
 *     back-blast), the thrown shells get a tiny release puff; `kick(w)` is the worm's recoil 0..1 (actors.js pushes the
 *     held weapon back and lifts the muzzle);
 *   - the baseball-bat SWING: `swing(w)` gives the held bat's extra angle / visibility for 0.5 s after the 'swing'
 *     event (actors.js draws the bat through the swing although the turn phase has already left 'play'); the impact (a
 *     spark star, a white flash, a short shake) lands 0.07 s into the swing, where the bat meets the worm;
 *   - the bellows gust: a fan of fast white wisps over the detector cone (was 10 dust puffs);
 *   - `shudder(S, w)`: the dying worm's last beat (S.phase 'dying'): it trembles and swells before it bursts.
 *   - the FUSE COUNTDOWN: a digit floating over every live timed shell (grenade, cluster, banana, holy, dynamite): the
 *     whole seconds left, red for the last one (readability at the default zoom, where a 0.2 m shell is a few pixels);
 *   - FIRE smoke and EMBERS (P38-R8): every burning thing (napalm / oil / gel patches, grass fire cells, burning props,
 *     trees and worms) feeds a rising smoke column (wind-sheared, darker and thicker for oil / trees, grey-white for
 * grass) and a few embers lifted by the heat; API (view.js W4V list): init(scene, tx), clear(), onEvent(S, e), frame(S,
 * view, camera, dt); kick(w), swing(w), shudder(S, w). Porting: all of it is per-worm timers + calls into the particle
 * system (SS.fx.spawn); no state shared with the simulation. */
(function (SS) {
  'use strict';
  const PV = SS.polishView = {};
  const rnd = (a, b) => a + Math.random() * (b - a);
  let clock = 0;
  const kicks = [];                  // { id, t, k }: the latest recoil per worm id
  const swings = [];                 // { id, t }
  const later = [];                  // { t, fn }
  const BAT_SWING = { RAISE: 1.5, FOLLOW: -0.6, T_HIT: 0.07, T_SWING: 0.12, T_LOWER: 0.4, T_END: 0.5 };   // rad / s of the bat swing

  /* ---------- the fuse digits: a pool of sprites, one canvas texture per digit 0..9 ---------- */
  const NDIG = 24;
  let grp = null;
  const digTex = [], dig = [];
  function digitTex(n, red) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 50px Impact, Arial Black, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(10,10,12,0.9)';
    g.strokeText(String(n), 32, 35);
    g.fillStyle = red ? '#ff5a3c' : '#fff6d8';
    g.fillText(String(n), 32, 35);
    const t = new window.THREE.CanvasTexture(c);
    t.minFilter = window.THREE.LinearFilter;
    return t;
  }
  PV.init = function (scene) {
    const T = window.THREE;
    grp = new T.Group();
    grp.renderOrder = 20;
    scene.add(grp);
    for (let n = 0; n < 10; n++) digTex.push([digitTex(n, false), digitTex(n, true)]);
    for (let i = 0; i < NDIG; i++) {
      const m = new T.Sprite(new T.SpriteMaterial({ map: digTex[3][0], transparent: true, depthTest: false, depthWrite: false }));
      m.visible = false;
      m.renderOrder = 20;
      grp.add(m);
      dig.push(m);
    }
  };
  PV.clear = function () {
    kicks.length = 0;
    swings.length = 0;
    later.length = 0;
    for (const m of dig) m.visible = false;
  };
  function fuseDigits(S, view) {
    let n = 0;
    const P = SS.plane, C = SS.CFG;
    for (const p of S.proj) {
      const def = C.PROJ[p.type];
      if (!def || !def.bouncy || !(p.fuse > 0) || p.fuse > 9.5 || n >= NDIG) continue;
      const wp = P.to_world(S, p.s, p.y);
      if (!SS.view.inSlab(S, wp)) continue;
      const m = dig[n++], sec = Math.max(0, Math.ceil(p.fuse - 1e-3)), t = digTex[Math.min(9, sec)];
      // a small pop as the digit changes
      m.material.map = t[p.fuse <= 1 ? 1 : 0];
      const pop = 1 + 0.4 * Math.max(0, 1 - (sec - p.fuse) / 0.15);
      const sz = Math.max(0.5, view.zoom * 0.042) * pop;
      m.scale.set(sz, sz, 1);
      m.position.set(wp.x, wp.y + 0.35 + sz * 0.55, wp.z);
      m.visible = true;
    }
    for (let i = n; i < NDIG; i++) dig[i].visible = false;
  }

  /* ---------- fire smoke + embers: emitters sampled per frame (budget: ~40 smoke + ~25 embers per second in all)
   * ---------- */
  let fireAcc = 0;
  // one smoke puff of a column rising from (x, y, z): tone 0 = grey-white (grass), 1 = black (oil, napalm, trees)
  function emit1(F, x, y, z, big, tone, wx, wz) {
    const K = F.KIND, g0 = 0.42 - 0.34 * tone, g1 = 0.62 - 0.28 * tone;
    F.spawn(K.SMOKE, x + rnd(-0.25, 0.25) * big, y, z + rnd(-0.25, 0.25) * big, { vx: wx * 0.5 + rnd(-0.25, 0.25),
      vy: rnd(1.1, 1.9) * (0.7 + 0.4 * big), vz: wz * 0.5 + rnd(-0.25, 0.25), drag: 0.5, buoy: 0.7,
      life: rnd(2.8, 4.6), s0: 0.3 * big, s1: rnd(1.6, 2.5) * big, a0: 0.26 + 0.14 * tone, c0: [g0, g0 * 0.97, g0 * 0.94],
      c1: [g1, g1, g1] });
  }
  function ember1(F, x, y, z, wx, wz, spread) {
    F.spawn(F.KIND.SPARK, x + rnd(-spread, spread), y, z + rnd(-spread, spread), {
      vx: wx * 0.6 + rnd(-0.6, 0.6),
      vy: rnd(1.4, 3.2),
      vz: wz * 0.6 + rnd(-0.6, 0.6),
      life: rnd(1.0, 2.2),
      s0: 0.07,
      s1: 0.025,
      c0: [1900, 800, 0],
      buoy: 3.0,
      grav: 0,
      drag: 0.5
    });
  }
  function fireFx(S, view, dt) {
    // P45: the fire system (render/flame.js) makes its own smoke and embers
    const F = SS.fx;
    if (!F || !S.time || dt <= 0 || SS.flameView) return;
    const ct = view.camT, W = SS.world, wx = S.wind && S.wind.mean ? S.wind.mean.x : 0, wz = S.wind && S.wind.mean ? S.wind.mean.z : 0;
    const near = (x, z) => !ct || (x - ct.x) * (x - ct.x) + (z - ct.z) * (z - ct.z) < 2500;
    // smoke puffs this frame (carried when < 1)
    let budget = Math.min(6, 40 * dt + fireAcc);
    fireAcc = 0;
    const take = (rate) => {
      let k = rate * dt + Math.random();
      k = Math.floor(k);
      k = Math.min(k, Math.floor(budget));
      budget -= k;
      return k;
    };
    let eb = Math.min(4, 25 * dt + 0.5);
    const embers = (p) => {
      if (eb >= 1 && Math.random() < p) {
        eb -= 1;
        return true;
      }
      return false;
    };
    for (const f of S.flames || []) {                                                // napalm / oil / gel patches
      if (f.t1 - S.time <= 0.3 || !near(f.x, f.z)) continue;
      const y = (W.top_at(f.x, f.z) > -1e8 ? W.top_at(f.x, f.z) : f.y) + 0.9,
        k = take(1.6 + 1.2 * f.r),
        a = Math.min(1, (f.t1 - S.time) / 1.5);
      for (let i = 0; i < k; i++)
        emit1(F, f.x + rnd(-f.r, f.r) * 0.6, y + rnd(0, 0.5), f.z + rnd(-f.r, f.r) * 0.6, (0.9 + 0.5 * f.r) * a, 1, wx, wz);
      if (embers(0.25 * f.r)) ember1(F, f.x, y - 0.2, f.z, wx, wz, f.r * 0.6);
    }
    const V = S.veg;                                                                   // grass fire: a few burning cells per frame
    if (V && V.nAct > 0) {
      const n = V.n, H = W.H, k = take(Math.min(5, 1 + V.nAct * 0.04));
      for (let i = 0; i < k + 1; i++) {
        const c = V.act[(Math.random() * V.nAct) | 0];
        if (!(V.burnT[c] > 0.4)) continue;
        const x = (c % n) * H, z = ((c / n) | 0) * H;
        if (!near(x, z)) continue;
        const y = W.top_at(x, z) + 0.8;
        if (i < k) emit1(F, x, y, z, 0.7 + 0.35 * Math.min(1, V.burnI[c]), 0, wx, wz);
        if (embers(0.35)) ember1(F, x, y - 0.3, z, wx, wz, 0.2);
      }
    }
    for (const b of S.bodies || []) {                                                  // burning props (barrels, crates, car wrecks)
      if (!(b.burn >= 0) || !b.pos || !near(b.pos.x, b.pos.z)) continue;
      const k = take(2.2), big = b.prop === 'barrel' ? 1.3 : b.prop === 'car' ? 1.6 : 1;
      for (let i = 0; i < k; i++) emit1(F, b.pos.x, b.pos.y + 0.9, b.pos.z, big, 0.85, wx, wz);
      if (embers(0.4)) ember1(F, b.pos.x, b.pos.y + 0.5, b.pos.z, wx, wz, 0.3);
    }
    for (const t of S.trees || []) {                                                   // burning trees: a thick dark column from the crown
      if (!t.alive || !(t.burn >= 0) || !near(t.x, t.z)) continue;
      const k = take(3.0), top = t.y + (t.h || 5) * 0.8;
      for (let i = 0; i < k; i++) emit1(F, t.x + rnd(-0.6, 0.6), top, t.z + rnd(-0.6, 0.6), 1.9, 0.75, wx, wz);
      if (embers(0.6)) ember1(F, t.x, top - 0.6, t.z, wx, wz, 0.7);
    }
    for (const w of S.worms || []) {                                                   // a burning worm: a thin dark plume
      if (w.dead || !(S.time - w.burnT < 0.4) || !near(w.pos.x, w.pos.z)) continue;
      if (take(3.5)) emit1(F, w.pos.x, w.pos.y + 0.3, w.pos.z, 0.55, 0.9, wx, wz);
      if (embers(0.3)) ember1(F, w.pos.x, w.pos.y, w.pos.z, wx, wz, 0.2);
    }
    fireAcc = budget > 0 && budget < 1 ? budget : 0;
  }
  PV.frame = function (S, view, camera, dt) {
    clock += dt;
    fireFx(S, view, dt);
    if (grp) fuseDigits(S, view);
    for (let i = later.length - 1; i >= 0; i--)
      if (clock >= later[i].t) {
        const L = later[i];
        later.splice(i, 1);
        L.fn();
      }
    for (let i = kicks.length - 1; i >= 0; i--)
      if (clock - kicks[i].t > 0.6) kicks.splice(i, 1);
    for (let i = swings.length - 1; i >= 0; i--)
      if (clock - swings[i].t > BAT_SWING.T_END + 0.1) swings.splice(i, 1);
  };
  const find = (list, w) => {
    for (let i = list.length - 1; i >= 0; i--)
      if (list[i].id === w.id) return list[i];
    return null;
  };

  /* the recoil of worm w now (0..1, decays in ~0.1 s) */
  PV.kick = function (w) {
    const e = w && find(kicks, w);
    return e ? e.k * Math.exp(-(clock - e.t) / 0.09) : 0;
  };
  /* the bat swing of worm w: null or { ang (extra aim angle, rad), vis (0..1 scale of the held bat) } */
  PV.swing = function (w) {
    const e = w && find(swings, w);
    if (!e) return null;
    const t = clock - e.t, B = BAT_SWING;
    if (t < 0 || t > B.T_END) return null;
    let ang;
    // accelerates into the hit
    if (t < B.T_SWING) {
      const u = t / B.T_SWING;
      ang = B.RAISE + (B.FOLLOW - B.RAISE) * Math.pow(u, 1.6);
    }
    else if (t < B.T_LOWER) {
      const u = (t - B.T_SWING) / (B.T_LOWER - B.T_SWING);
      ang = B.FOLLOW + (-1.1 - B.FOLLOW) * u * u * (3 - 2 * u);
    }
    else ang = -1.1;
    return { ang, vis: t < 0.38 ? 1 : Math.max(0.02, (B.T_END - t) / (B.T_END - 0.38)) };
  };
  /* the dying beat: { dx, sc } (a tremble in the body's x and a swell), or null. beat = DIE.BEAT of sim.js */
  PV.shudder = function (S, w) {
    if (S.phase !== 'dying' || S.dyingW !== w || S.dyingGrave) return null;
    const k = Math.min(1, Math.max(0, 1 - S.dyingT / 1.1)), tr = k * k;
    return { dx: Math.sin(clock * 70) * 0.035 * tr, sc: 1 + 0.16 * tr + 0.02 * Math.sin(clock * 40) * tr };
  };

  /* world direction of the shooter's aim */
  function aimDir(S) {
    const a = S.active;
    if (!a) return null;
    const ad = SS.sim.aim_dir(S), d = SS.plane.dir(S), n = SS.plane.nrm(S);
    return { a, x: d.x * ad.s, y: ad.y, z: d.z * ad.s, nx: n.x, nz: n.z };
  }
  function muzzle(S, len, big, smoke) {
    const q = aimDir(S);
    if (!q || !SS.fx) return;
    const p = q.a.pos, F = SS.fx, K = F.KIND;
    const mx = p.x + q.x * len + q.nx * 0.17, my = p.y + 0.02 + q.y * len, mz = p.z + q.z * len + q.nz * 0.17;
    kicks.push({ id: q.a.id, t: clock, k: big });
    F.spawn(K.FIRE, mx, my, mz, {
      vx: q.x * 3,
      vy: q.y * 3,
      vz: q.z * 3,
      life: 0.07,
      s0: 0.12 * big + 0.1,
      s1: 0.34 * big + 0.2,
      c0: [3300, 2000, 0],
      a0: 1,
      drag: 8
    });
    for (let i = 0; i < 4 + big * 4; i++) {
      const sp = rnd(5, 14) * (0.6 + 0.4 * big), sx = rnd(-0.18, 0.18), sy = rnd(-0.18, 0.18);
      F.spawn(K.SPARK, mx, my, mz, {
        vx: (q.x + sx) * sp,
        vy: (q.y + sy) * sp,
        vz: (q.z + sx) * sp,
        life: rnd(0.08, 0.2),
        s0: 0.07,
        s1: 0.03,
        c0: [2600, 1300, 0],
        grav: 4
      });
    }
    for (let i = 0; i < smoke; i++) {
      F.spawn(K.SMOKE, mx + q.x * i * 0.12, my + q.y * i * 0.12, mz + q.z * i * 0.12, {
        vx: q.x * rnd(1, 3) + rnd(-0.3, 0.3),
        vy: rnd(0.2, 0.9),
        vz: q.z * rnd(1, 3) + rnd(-0.3, 0.3),
        life: rnd(0.8, 1.6),
        s0: 0.1,
        s1: rnd(0.45, 0.8),
        a0: 0.35,
        c0: [0.7, 0.68, 0.64],
        c1: [0.8, 0.8, 0.8],
        drag: 1.6,
        buoy: 0.25
      });
    }
  }
  function backblast(S, len) {         // the rocket's rear venturi: a flash + a dust / smoke cloud behind the worm's shoulder
    const q = aimDir(S);
    if (!q || !SS.fx) return;
    const p = q.a.pos,
      F = SS.fx,
      K = F.KIND,
      bx = p.x - q.x * len + q.nx * 0.17,
      by = p.y + 0.02 - q.y * len,
      bz = p.z - q.z * len + q.nz * 0.17;
    F.spawn(K.FIRE, bx, by, bz, {
      vx: -q.x * 4,
      vy: -q.y * 4,
      vz: -q.z * 4,
      life: 0.09,
      s0: 0.1,
      s1: 0.4,
      c0: [2600, 1400, 0],
      a0: 0.8,
      drag: 6
    });
    for (let i = 0; i < 6; i++)
      F.spawn(K.SMOKE, bx, by, bz, {
        vx: -q.x * rnd(2, 5) + rnd(-0.6, 0.6),
        vy: rnd(0.1, 0.8),
        vz: -q.z * rnd(2, 5) + rnd(-0.6, 0.6),
        life: rnd(0.8, 1.5),
        s0: 0.15,
        s1: rnd(0.7, 1.1),
        a0: 0.4,
        c0: [0.62, 0.6, 0.57],
        c1: [0.78, 0.78, 0.78],
        drag: 1.8,
        buoy: 0.2
      });
    F.dust(p.x - q.x * 0.5, p.y - 0.45, p.z - q.z * 0.5, 3, 0.4, 0xc8bca8);
  }
  function batImpact(e) {              // where the bat meets the worm: a white flash, a spark star, a short shake
    const F = SS.fx;
    if (!F) return;
    F.spawn(F.KIND.FIRE, e.x, e.y, e.z, { life: 0.07, s0: 0.15, s1: 0.55, c0: [6500, 3500, 0], a0: 1 });
    for (let i = 0; i < 12; i++) {
      const a = rnd(0, 6.283), b = rnd(-1, 1), sp = rnd(3, 8), r = Math.sqrt(1 - b * b);
      F.spawn(F.KIND.SPARK, e.x, e.y, e.z, {
        vx: Math.cos(a) * r * sp,
        vy: b * sp,
        vz: Math.sin(a) * r * sp,
        life: rnd(0.15, 0.35),
        s0: 0.09,
        s1: 0.03,
        c0: [3200, 1800, 0],
        grav: 9
      });
    }
    if (F.addShake) F.addShake(0.45);
  }

  PV.onEvent = function (S, e) {
    const F = SS.fx;
    if (e.type === 'shot' && e.weapon === 'shotgun') muzzle(S, 0.78, 1.0, 3);
    else if (e.type === 'shot' && e.weapon === 'sniper' && !e.end) muzzle(S, 1.2, 1.2, 4);
    else if (e.type === 'fire' && (e.weapon === 'bazooka' || e.weapon === 'homing')) {
      muzzle(S, 0.7, 1.0, 3);
      backblast(S, 0.5);
      if (F && F.addShake) F.addShake(0.12);
    }
    else if (e.type === 'swing' && e.worm) {
      swings.push({ id: e.worm.id, t: clock });
      if (e.hit > 0) {
        const hx = e.x, hy = e.y, hz = e.z;
        later.push({ t: clock + BAT_SWING.T_HIT, fn: () => batImpact({ x: hx, y: hy, z: hz }) });
      }
    } else if (e.type === 'blow' && F) {
      // bellows: a fan of fast white wisps over the cone (range 10.9 m, 35 deg half angle)
      const d = SS.plane.dir(S), n = SS.plane.nrm(S);
      for (let i = 0; i < 34; i++) {
        // a small angle off the axis (in the plane) and across it
        const sp = rnd(8, 22), sp2 = rnd(-0.33, 0.33), la = e.ds, lb = e.dy;
        const c = Math.cos(sp2), s2 = Math.sin(sp2), dx = la * c - lb * s2, dy = la * s2 + lb * c, cr = rnd(-0.25, 0.25);
        F.spawn(F.KIND.STEAM, e.x + d.x * e.ds * 0.5, e.y + e.dy * 0.5, e.z + d.z * e.ds * 0.5, {
          vx: d.x * dx * sp + n.x * cr * sp * 0.4,
          vy: dy * sp,
          vz: d.z * dx * sp + n.z * cr * sp * 0.4,
          drag: 2.6,
          life: rnd(0.35, 0.7),
          s0: 0.1,
          s1: rnd(0.4, 0.8),
          a0: 0.45,
          c0: [0.95, 0.97, 1],
          c1: [0.9, 0.94, 1]
        });
      }
    }
  };
})(window.SS = window.SS || {});
