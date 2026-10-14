/* render/traverse.js — P37 W2: the ninja rope (taut or slack with a sag, bends with knots, kept ropes of other worms),
 * the
 * parachute (a procedural canopy with gores, shroud lines, an opening pop, sway) and the zipline (bolt in flight, the
 * anchor, the line with a little sag under the rider, the trolley, the bolt in the far surface).
 * Procedural meshes only. Pools of unit cylinders (no per-frame allocation after warm-up). Called from
 * render/actors.js: init(scene) / sync(S, view, a, dt) / clear(); hang_pose(S, w, sNow) gives the body tilt for a
 * hanging worm. Porting: a spline / cable component for the rope and the line, a skinned or procedural cloth mesh for
 * the canopy. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math, P = SS.plane;
  const V = SS.travView = {};
  let scene = null, root = null, canopy = null, bolt = null, trolley = null, stake = null, boltEnd = null;
  const pools = {};                                           // name -> { meshes[], n, mat }
  const yAxis = new T.Vector3(0, 1, 0), va = new T.Vector3(), vb = new T.Vector3(), vd = new T.Vector3();
  const SAG_N = 12;
  const GRIP_UP = 0.56;                                      // the zipline handle bar: m above the worm's centre
  const qy = new T.Quaternion(), qz = new T.Quaternion(), zAxis = new T.Vector3(0, 0, 1);

  function pool(name, mat, geo) {
    return pools[name] || (pools[name] = { m: [], n: 0, mat, geo: geo || new T.CylinderGeometry(1, 1, 1, 6, 1, true) });
  }
  function begin() {
    for (const k in pools) pools[k].n = 0;
  }
  function finish() {
    for (const k in pools) {
      const p = pools[k];
      for (let i = p.n; i < p.m.length; i++) p.m[i].visible = false;
    }
  }
  // a unit cylinder from A to B with radius r
  function seg(p, ax, ay, az, bx, by, bz, r) {
    let m = p.m[p.n];
    if (!m) {
      m = new T.Mesh(p.geo, p.mat);
      m.castShadow = true;
      root.add(m);
      p.m.push(m);
    }
    p.n++;
    va.set(ax, ay, az);
    vb.set(bx, by, bz);
    vd.subVectors(vb, va);
    const L = vd.length();
    if (L < 1e-4) {
      m.visible = false;
      return;
    }
    m.visible = true;
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.scale.set(r, L, r);
    m.quaternion.setFromUnitVectors(yAxis, vd.multiplyScalar(1 / L));
  }
  function ball(p, x, y, z, r) {
    let m = p.m[p.n];
    if (!m) {
      m = new T.Mesh(p.geo, p.mat);
      root.add(m);
      p.m.push(m);
    }
    p.n++;
    m.visible = true;
    m.position.set(x, y, z);
    m.scale.setScalar(r);
  }

  V.init = function (sc) {
    scene = sc;
    root = new T.Group();
    root.name = 'traverse';
    scene.add(root);
    const ropeMat = new T.MeshStandardMaterial({ color: 0xe2c887, roughness: 0.75 }),
      steel = new T.MeshStandardMaterial({ color: 0xaab3bd, metalness: 0.85, roughness: 0.35 });
    pool('rope', ropeMat);
    pool('line', steel);
    pool('knot', new T.MeshStandardMaterial({ color: 0xcfcfd6, metalness: 0.8, roughness: 0.3 }), new T.SphereGeometry(1, 8, 6));
    pool('kept', ropeMat);
    // parachute canopy: a flattened dome with 12 gores (team colour / white), shroud lines to a harness point
    const g = new T.SphereGeometry(1, 36, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
      pos = g.attributes.position,
      col = new Float32Array(pos.count * 3);
    g.userData.gore = new Uint8Array(pos.count);                                           // 0 = tinted gore, 1 = white gore
    for (let i = 0; i < pos.count; i++) {
      const ph = Math.atan2(pos.getZ(i), pos.getX(i)), gi = Math.floor(((ph + Math.PI) / (Math.PI * 2)) * 12 + 1e-4);
      g.userData.gore[i] = gi % 2; col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 1;
    }
    g.setAttribute('color', new T.BufferAttribute(col, 3));
    canopy = new T.Group();
    const dome = new T.Mesh(g, new T.MeshStandardMaterial({ vertexColors: true, side: T.DoubleSide, roughness: 0.85, color: 0xffffff }));
    dome.scale.set(2.1, 1.25, 2.1);
    dome.position.y = 3.1;
    dome.castShadow = true;
    canopy.add(dome);
    canopy.userData.dome = dome;
    const lm = new T.MeshBasicMaterial({ color: 0xcbbfa6 }), lg = new T.CylinderGeometry(0.02, 0.02, 1, 4, 1, true);
    // P38-A4: two risers (straps) from the harness up to two toggles at +-RZ across the section plane; the 10 shroud
    // lines gather in them (the rim point's side picks the riser), the worm holds a riser in each hand (V.grips)
    const rm = new T.MeshBasicMaterial({ color: 0x8a7f66 }), RZ = 0.34, RY = 0.95;
    for (const sg of [-1, 1]) {
      const p0 = new T.Vector3(0, 0.12, sg * 0.04), p1 = new T.Vector3(0, RY, sg * RZ), d = p1.clone().sub(p0), L = d.length();
      const m = new T.Mesh(lg, rm);
      m.position.copy(p0).add(p1).multiplyScalar(0.5);
      m.scale.set(2.2, L, 2.2);
      m.quaternion.setFromUnitVectors(yAxis, d.normalize());
      canopy.add(m);
      canopy.userData['riser' + (sg > 0 ? 'P' : 'M')] = { a: new T.Vector3(0, 0.12, sg * 0.04), b: new T.Vector3(0, RY, sg * RZ) };
    }
    for (let k = 0; k < 10; k++) {
      const a = k / 10 * Math.PI * 2,
        x = Math.cos(a) * 2.0,
        z = Math.sin(a) * 2.0,
        p0 = new T.Vector3(x, 3.1, z),
        p1 = new T.Vector3(0, RY, (z >= 0 ? 1 : -1) * RZ),
        d = p1.clone().sub(p0),
        L = d.length();
      const m = new T.Mesh(lg, lm);
      m.position.copy(p0).add(p1).multiplyScalar(0.5);
      m.scale.set(1, L, 1);
      m.quaternion.setFromUnitVectors(yAxis, d.normalize());
      canopy.add(m);
    }
    canopy.visible = false; scene.add(canopy);
    // zipline bolt (flying and stuck) and trolley, stake
    bolt = new T.Group();
    const bm = new T.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.8, roughness: 0.3 }),
      fm = new T.MeshStandardMaterial({ color: 0xd9423a, roughness: 0.6 });
    const shaft = new T.Mesh(new T.CylinderGeometry(0.035, 0.035, 0.7, 6), bm);
    shaft.rotation.z = Math.PI / 2;
    bolt.add(shaft);
    const tip = new T.Mesh(new T.ConeGeometry(0.07, 0.2, 8), bm);
    tip.rotation.z = -Math.PI / 2;
    tip.position.x = 0.45;
    bolt.add(tip);
    for (let k = 0; k < 3; k++) {
      const f = new T.Mesh(new T.BoxGeometry(0.2, 0.01, 0.12), fm);
      f.position.x = -0.3;
      f.rotation.x = k / 3 * Math.PI;
      bolt.add(f);
    }
    bolt.visible = false; scene.add(bolt);
    boltEnd = bolt.clone(); boltEnd.visible = false; scene.add(boltEnd);
    trolley = new T.Group();
    const tb = new T.Mesh(new T.BoxGeometry(0.34, 0.12, 0.2), bm);
    trolley.add(tb);
    for (const x of [-0.12, 0.12]) {
      const w = new T.Mesh(new T.CylinderGeometry(0.07, 0.07, 0.05, 12), fm);
      w.rotation.x = Math.PI / 2;
      w.position.set(x, 0.1, 0);
      trolley.add(w);
    }
    // P38-A4: the hanger drops to a handle bar across the plane (V.sync sizes the hanger so the bar sits just above the
    // worm's head)
    const hg = new T.Mesh(new T.CylinderGeometry(0.02, 0.02, 1, 5), bm);
    hg.position.y = -0.15;
    trolley.add(hg);
    trolley.userData.hanger = hg;
    const bar = new T.Mesh(new T.CylinderGeometry(0.026, 0.026, 0.34, 8), fm);
    bar.rotation.x = Math.PI / 2;
    bar.position.y = -0.3;
    trolley.add(bar);
    trolley.userData.bar = bar;
    trolley.visible = false; scene.add(trolley);
    stake = new T.Group();
    const sp = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 1.0, 8), bm);
    sp.position.y = -0.5;
    stake.add(sp);
    const sh = new T.Mesh(new T.TorusGeometry(0.1, 0.025, 6, 12), bm);
    sh.rotation.y = Math.PI / 2;
    stake.add(sh);
    stake.visible = false; scene.add(stake);
  };
  // (the objects live as long as the scene)
  V.clear = function () {
    if (!root) return;
    for (const k in pools)
      for (const m of pools[k].m) m.visible = false;
    canopy.visible = bolt.visible = boltEnd.visible = trolley.visible = stake.visible = false;
  };

  // a rope drawn from A to B in world space: straight when taut, a parabolic sag when slack (chord d, free length len)
  function rope(p, ax, ay, az, bx, by, bz, len, r) {
    const d = Math.hypot(bx - ax, by - ay, bz - az),
      slack = len - d,
      h = slack > 0.06 ? Math.min(len * 0.45, Math.sqrt(3 * d * slack / 8)) : 0;
    if (h < 0.02) {
      seg(p, ax, ay, az, bx, by, bz, r);
      return;
    }
    let px = ax, py = ay, pz = az;
    for (let i = 1; i <= SAG_N; i++) {
      const u = i / SAG_N, x = ax + (bx - ax) * u, y = ay + (by - ay) * u - h * 4 * u * (1 - u), z = az + (bz - az) * u;
      seg(p, px, py, pz, x, y, z, r);
      px = x;
      py = y;
      pz = z;
    }
  }
  const HEAD = 0.42;           // the rope leaves the worm at its head (m above its centre)

  V.sync = function (S, view, a, dt) {
    if (!root) return;
    begin();
    const t = view.time;
    // ---- the ninja rope ----
    if (S.rope && a && !a.dead) {
      const r = S.rope, an = P.to_world(S, r.s, r.y), pins = r.pins || [];
      rope(pools.rope, a.pos.x, a.pos.y + HEAD, a.pos.z, an.x, an.y, an.z, r.len, 0.028);
      let prev = an;
      for (let i = pins.length - 1; i >= 0; i--) {
        const q = P.to_world(S, pins[i].s, pins[i].y);
        seg(pools.rope, prev.x, prev.y, prev.z, q.x, q.y, q.z, 0.028);
        ball(pools.knot, prev.x, prev.y, prev.z, 0.07);
        prev = q;
      }
      ball(pools.knot, a.pos.x, a.pos.y + HEAD, a.pos.z, 0.05);
    }
    // kept ropes: worms left hanging between turns (straight; they are pendulums on a fixed anchor)
    // (P38-R2: drawn only where the worm itself is: it was hidden by the section clip, its rope was not)
    for (const w of S.worms)
      if (!w.dead && w.rope && w !== a && (SS.view.inSlab(S, w.pos) || (view.insp || 0) > 0.05)) {
        seg(
          pools.kept, w.pos.x, w.pos.y + HEAD, w.pos.z, w.rope.x, w.rope.y, w.rope.z, 0.028);
        ball(pools.knot, w.rope.x, w.rope.y, w.rope.z, 0.07);
      }
    // ---- the zipline ----
    const z = S.zip;
    let showBolt = false, showStake = false, showEnd = false, showTrolley = false;
    if (z && z.state > 0) {
      const A = P.to_world(S, z.as, z.ay);
      showStake = true; stake.position.set(A.x, A.y, A.z); stake.rotation.set(0, -S.theta, 0);
      if (z.state === 1 && z.bolt) {
        const Bp = P.to_world(S, z.bolt.s, z.bolt.y);
        showBolt = true;
        bolt.position.set(Bp.x, Bp.y, Bp.z); bolt.rotation.set(0, -S.theta, Math.atan2(z.bolt.dy, z.bolt.ds), 'YXZ');
        seg(pools.line, A.x, A.y, A.z, Bp.x, Bp.y, Bp.z, 0.012);
      } else if (z.state >= 2) {
        const B = P.to_world(S, z.bs, z.by), L = z.len || 1, us = (z.bs - z.as) / L, uy = (z.by - z.ay) / L;
        showEnd = true; boltEnd.position.set(B.x, B.y, B.z); boltEnd.rotation.set(0, -S.theta, Math.atan2(uy, us), 'YXZ');
        if (z.state === 2 && a) {
          // the rider's weight bends the line a little at the trolley
          const u = z.t / L, tp = P.to_world(S, z.as + us * z.t, z.ay + uy * z.t), sag = 0.18 * 4 * u * (1 - u) + 0.04;
          seg(pools.line, A.x, A.y, A.z, tp.x, tp.y - sag, tp.z, 0.014); seg(pools.line, tp.x, tp.y - sag, tp.z, B.x, B.y, B.z, 0.014);
          showTrolley = true; trolley.position.set(tp.x, tp.y - sag + 0.08, tp.z);
          const hl = M.clamp(trolley.position.y - (a.pos.y + GRIP_UP), 0.12, 0.9), tu = trolley.userData;     // hanger down to the bar
          tu.hanger.scale.y = hl;
          tu.hanger.position.y = -hl / 2;
          tu.bar.position.y = -hl;
          trolley.rotation.set(0, -S.theta, Math.atan2(uy, us), 'YXZ');
        } else seg(pools.line, A.x, A.y, A.z, B.x, B.y, B.z, 0.014);
      }
    }
    bolt.visible = showBolt;
    boltEnd.visible = showEnd;
    stake.visible = showStake;
    trolley.visible = showTrolley;
    // ---- the parachute ----
    const c = S.chute;
    if (c && c.open && a && !a.dead) {
      canopy.visible = true; canopy.position.set(a.pos.x, a.pos.y + HEAD, a.pos.z);
      const f = M.clamp(c.t / 0.45, 0, 1),
        ease = 1 - Math.pow(1 - f, 3),
        over = f < 1 ? 0 : Math.max(0, 1 - (c.t - 0.45) * 2.5) * 0.1 * Math.sin((c.t - 0.45) * 14);
      const sx = 0.3 + 0.7 * ease, sy = (0.15 + 0.85 * ease) * (1 + over), br = 1 + 0.025 * Math.sin(t * 3.1) + (c.steer ? 0.03 : 0);
      canopy.scale.set(sx * br, sy, sx * br);
      // the tilt about the section normal: the canopy lags behind the worm's drift, plus a slow wobble
      // yaw by the section (local x along the plane, local z across it: the risers) and the sway about the section
      // normal
      qy.setFromAxisAngle(yAxis, -S.theta);
      qz.setFromAxisAngle(zAxis, -(c.sway * 1.2 + 0.04 * Math.sin(t * 1.7)) * Math.sign(P.nrm(S).z || 1));
      canopy.quaternion.copy(qy).multiply(qz); canopy.updateMatrixWorld(true);
      const tint = SS.sim.team_rgb(S, a.team);
      if (canopy.userData.tint !== tint) {                                                 // gores: the team colour and white
        canopy.userData.tint = tint;
        const g = canopy.userData.dome.geometry, ca = g.attributes.color, gr = g.userData.gore, tc = new T.Color(tint);
        for (let i = 0; i < ca.count; i++) {
          if (gr[i]) ca.setXYZ(i, 0.95, 0.94, 0.9);
          else ca.setXYZ(i, tc.r, tc.g, tc.b);
        }
        ca.needsUpdate = true;
      }
    } else if (canopy) canopy.visible = false;
    finish();
  };
  /* P38-A4: where the worm's two hands grip. Fills out[0..5] with the world points (hand 0, hand 1) and returns 1, or
   * returns 0
   * when the worm holds nothing: the ninja rope (one hand above the other on the rope, just over the head; also the
   * kept ropes of the hanging worms), the parachute risers, the zipline handle bar (the two ends of the bar). */
  V.grips = function (S, w, a, out) {
    if (w.dead) return 0;
    if (w === a && S.rope) {
      const r = S.rope, an = P.to_world(S, r.s, r.y);
      return ropeGrips(w.pos.x, w.pos.y + HEAD, w.pos.z, an.x, an.y, an.z, r.len, out);
    }
    if (w !== a && w.rope && !w.swim) return ropeGrips(w.pos.x, w.pos.y + HEAD, w.pos.z, w.rope.x, w.rope.y, w.rope.z, 0, out);
    if (w === a && S.chute && S.chute.open && canopy && canopy.visible) {
      const f = M.clamp(S.chute.t / 0.45, 0, 1), u = 0.22;
      let q = 0;
      for (const k of ['riserM', 'riserP']) {
        const r = canopy.userData[k];
        va.set(r.a.x + (r.b.x - r.a.x) * u, r.a.y + (r.b.y - r.a.y) * u, r.a.z + (r.b.z - r.a.z) * u);
        canopy.localToWorld(va);
        out[q * 3] = va.x;
        out[q * 3 + 1] = va.y;
        out[q * 3 + 2] = va.z;
        q++;
      }
      return f > 0.3 ? 1 : 0;
    }
    if (w === a && S.zip && S.zip.state === 2 && trolley && trolley.visible) {
      const bar = trolley.userData.bar;
      for (let q = 0; q < 2; q++) {
        va.set(0, 0, (q ? -1 : 1) * 0.13);
        bar.localToWorld(va);
        out[q * 3] = va.x;
        out[q * 3 + 1] = va.y;
        out[q * 3 + 2] = va.z;
      }
      return 1;
    }
    return 0;
  };
  // two points on the rope as drawn by rope() (the same sag), 0.2 and 0.4 m from the head
  function ropeGrips(hx, hy, hz, tx, ty, tz, len, out) {
    const dx = tx - hx,
      dy = ty - hy,
      dz = tz - hz,
      d = Math.hypot(dx, dy, dz) || 1,
      slack = len - d,
      h = slack > 0.06 ? Math.min(len * 0.45, Math.sqrt(3 * d * slack / 8)) : 0;
    for (let q = 0; q < 2; q++) {
      const u = Math.min(q ? 0.4 : 0.2, d * 0.9) / d;
      out[q * 3] = hx + dx * u; out[q * 3 + 1] = hy + dy * u - h * 4 * u * (1 - u); out[q * 3 + 2] = hz + dz * u;
    }
    return 1;
  }
  // the body tilt (rad) of a worm that hangs: its head toward the rope pivot (ninja rope), upright on a zipline with a
  // lean back along the ride, a small sway under the parachute. w: the worm, sNow its in-plane s, f its facing
  V.hang_pose = function (S, w, a, sNow, f) {
    if (w !== a) return 0;
    if (S.rope) return Math.atan2(-f * (S.rope.s - sNow), S.rope.y - w.pos.y);
    if (S.zip && S.zip.state === 2) return -0.18 * f * M.clamp(S.zip.v / 12, 0, 1.2);
    if (S.chute && S.chute.open) return -0.12 * f * M.clamp(S.chute.sway * 4, -1, 1);
    return 0;
  };
})(window.SS = window.SS || {});
