/* render/ground.js — P65b: how things SIT on the terrain (Three.js; presentation only, no sim state, no Math.random).
 * The sim rests props on a few contact spheres; the drawn models are boxes, plinths and rims wider than that, so on a slope the downhill
 * edge hung in the air and the uphill edge sank into the hill. This module owns the shared fix:
 *   - ground(x, yref, z): the ground height under a point (a short density march, the same one the aliens use), null = none;
 *   - conform(b, it, dt, time): a prop standing upright (fridge, vending machine, phone booth, column, obelisk) leans a little toward the
 *     ground (0.55 of the slope, at most 12 deg) about the centre of its base and sinks until its lowest base corner touches the ground
 *     (the uphill corners are buried, as in a real foundation). A prop that lies or tumbles (crate, barrel, car, girder) is only lowered
 *     when its lowest hull corner floats (at most 12 cm, never raised: the sim's contact spheres are right when it rests on them).
 *     Targets are re-fitted every 0.3 s while the body rests and eased in (exp, 8 / s), so nothing pops; a moving body eases back to 0;
 *   - contact shadows: a few soft "foot" blobs (centre on the ground, radius) are sent to the terrain shader (uCon, see terrain.js
 *     conAO) which darkens the ground within that distance in 3D, so the shadow wraps a slope, a ridge or a crater rim by construction
 *     (no flat decal, no z-fight). 24 blobs, the ones closest to the section plane win. blob(x, y, z, r, k) any module may call per frame;
 * API: begin(), blob(x, y, z, r, k), conform(b, it, dt, time), upload(S), ground(x, yref, z), stats().
 * Porting: ground() + plane fit are plain math (a native engine uses its physics ray casts); the blobs are a decal / AO term in the terrain material. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const GV = SS.groundView = {};
  const MAXB = 24, SINK = 0.015, DY_MAX = 0.5, LOW_MAX = 0.12, REFIT = 0.3, EASE = 8;
  const NONE = -1e9;
  const nb = []; let nUsed = 0, nFit = 0;
  const UP = new T.Vector3(0, 1, 0), v0 = new T.Vector3(), v1 = new T.Vector3(), nn = new T.Vector3(), qb = new T.Quaternion(), qb2 = new T.Quaternion();

  GV.ground = function (x, yref, z) {
    const gy = SS.alien && SS.alien.ground_y ? SS.alien.ground_y(x, yref, z, 26) : SS.world.top_at(x, z);
    return gy > NONE * 0.5 ? gy : null;
  };

  /* ---------- contact shadows (terrain uniform) ---------- */
  GV.begin = function () { nUsed = 0; };
  GV.blob = function (x, y, z, r, k) {
    let o = nb[nUsed]; if (!o) o = nb[nUsed] = { x: 0, y: 0, z: 0, r: 0, k: 0, t: 0 };
    o.x = x; o.y = y; o.z = z; o.r = r; o.k = k == null ? 1 : k; nUsed++;
  };
  GV.upload = function (S) {
    const U = SS.terrain && SS.terrain.uniforms; if (!U || !U.uCon) return;
    for (const w of S.worms || []) if (!w.dead && !w.reserve && w.pos) GV.blob(w.pos.x, w.pos.y - 0.38, w.pos.z, 0.8, 1);
    const n = SS.plane.nrm(S), O = S.O;
    for (let i = 0; i < nUsed; i++) nb[i].t = Math.abs((nb[i].x - O.x) * n.x + (nb[i].z - O.z) * n.z);
    const L = nb.slice(0, nUsed); if (L.length > MAXB) L.sort((a, b) => a.t - b.t);
    const m = Math.min(MAXB, L.length);
    for (let i = 0; i < m; i++) U.uCon.value[i].set(L[i].x, L[i].y, L[i].z, L[i].r * (L[i].k > 0 ? 1 : 0));
    U.uNCon.value = m;
  };

  /* ---------- hull points of the props (body frame, y up; the same dimensions the models are fitted to) ---------- */
  const UPRIGHT = { fridge: 1, vending: 1, phonebooth: 1, column: 1, obelisk: 1 };
  const HULL = {};
  function hull(kind) {
    let h = HULL[kind]; if (h) return h;
    const C = SS.CFG, P = C.PROPS; h = { base: null, pts: [], r: 0.5, tall: !!UPRIGHT[kind], lk: 0.3, lm: 0.09 };
    if (kind === 'column' || kind === 'obelisk') { h.lk = 0; h.lm = 0; }
    if (kind === 'crate') { const k = P.CRATE.HALF; for (const x of [-k, k]) for (const y of [-k, k]) for (const z of [-k, k]) h.pts.push([x, y, z]); h.r = 0.95; }
    else if (P.JUNK[kind]) {
      const [w, hh, d] = P.JUNK[kind]; h.base = []; for (const x of [-w / 2, w / 2]) for (const z of [-d / 2, d / 2]) h.base.push([x, -hh / 2, z]);
      for (const x of [-w / 2, w / 2]) for (const y of [-hh / 2, hh / 2]) for (const z of [-d / 2, d / 2]) h.pts.push([x, y, z]); h.r = Math.max(w, d) * 0.8; h.hb = hh / 2;
    } else if (P.STONE[kind]) {
      const [r0, hh] = P.STONE[kind], k = kind === 'column' ? 1.15 * r0 : r0; h.base = []; for (const x of [-k, k]) for (const z of [-k, k]) h.base.push([x, -hh / 2, z]);
      h.pts = h.base.slice(); h.r = k * 1.9; h.hb = hh / 2;
    } else if (kind === 'barrel') { const R = P.BARREL.R, H = P.BARREL.H / 2; for (let i = 0; i < 8; i++) for (const y of [-H, H]) h.pts.push([Math.cos(i * Math.PI / 4) * R, y, Math.sin(i * Math.PI / 4) * R]); h.r = 0.7; }
    else if (kind === 'car') { for (const x of [-1.28, 1.28]) for (const z of [-0.7, 0.7]) h.pts.push([x, -0.72, z]); h.r = 1.5; h.two = 1.0; }
    else h = null;
    HULL[kind] = h || false; return h || false;
  }
  const wp = [0, 0, 0], tmpO = { x: 0, y: 0, z: 0 };
  function world(b, q, p, out) { SS.math.q_rot(q, p[0], p[1], p[2], tmpO); out[0] = b.pos.x + tmpO.x; out[1] = b.pos.y + tmpO.y; out[2] = b.pos.z + tmpO.z; return out; }

  /* ---------- P65d: what holds a prop over a pit ----------
   * The sim keeps a prop / grave / crate while a contact point under it still touches ground, but the drawn base is wider than that: next to a blast crater
   * a corner can hang over the hole. Where a base corner (or the lowest hull corner of a lying prop) floats more than SK_GAP above the real ground, a small tapered
   * post of the local soil / rock (a stub of the same ledge the prop is sitting on) is drawn from the corner down to the ground below it. The posts are one merged
   * child mesh of the object (so they follow its lean, its visibility and the section clip), rebuilt only when a refit finds a new set. */
  const SK_GAP = 0.13, SK_MAX = 4, SK_HALF = 0.2;
  const SKC = { 2: [0.34, 0.31, 0.28], 3: [0.3, 0.21, 0.14], 4: [0.62, 0.52, 0.36], 5: [0.55, 0.42, 0.3], 6: [0.82, 0.86, 0.9], 7: [0.6, 0.72, 0.82], 8: [0.11, 0.1, 0.1], 10: [0.1, 0.09, 0.09], 11: [0.2, 0.19, 0.19], 12: [0.28, 0.26, 0.24], 15: [0.4, 0.39, 0.37], 16: [0.05, 0.05, 0.06] };
  let skMat = null; const vtmp = new T.Vector3();
  function skMaterial() { if (!skMat) { skMat = new T.MeshLambertMaterial({ vertexColors: true, flatShading: true }); skMat.userData.shared = true; } return skMat; }
  function postsFrom(cf, list) {                       // list = [[x, topY, z, groundY], ...] (world)
    const W = SS.world; const out = [];
    list.sort((a, b) => (b[1] - b[3]) - (a[1] - a[3]));
    for (let i = 0; i < list.length && out.length < SK_MAX; i++) {
      const q = list[i], gap = q[1] - q[3]; if (gap < SK_GAP || gap > 1.6) continue;
      const m = W && W.mat_at ? W.mat_at(q[0], q[3] - 0.25, q[2]) : 3, c = SKC[m] || SKC[3];
      out.push([q[0], q[1], q[2], q[3], c]);
    }
    if (out.length || cf.posts) {
      const o = cf.posts; let same = !!o && o.length === out.length;
      for (let i = 0; same && i < out.length; i++) for (let k = 0; k < 4; k++) if (Math.abs(out[i][k] - o[i][k]) > 0.01) same = false;
      if (!same) { cf.posts = out.length ? out : null; cf.pdirty = true; }       // (a refit that finds the same posts must not rebuild the geometry)
    }
  }
  function buildPosts(cf, g) {
    cf.pdirty = false;
    if (!cf.posts) { if (cf.pmesh) cf.pmesh.visible = false; return; }
    g.updateMatrixWorld(true);
    const n = cf.posts.length, pos = new Float32Array(n * 8 * 3), col = new Float32Array(n * 8 * 3), idx = [];
    for (let k = 0; k < n; k++) {
      const q = cf.posts[k], hs = SK_HALF, hb = SK_HALF * 1.5, yb = q[3] - 0.2, h = (k * 0.37) % 1;
      for (let c = 0; c < 8; c++) {
        const top = c < 4, sx = (c & 1) ? 1 : -1, sz = (c & 2) ? 1 : -1, r = top ? hs : hb;
        vtmp.set(q[0] + sx * r * (0.85 + 0.3 * ((c * 7 + k * 3) % 5) / 5), top ? q[1] + 0.03 : yb, q[2] + sz * r * (0.85 + 0.3 * ((c * 5 + k) % 5) / 5));
        g.worldToLocal(vtmp);
        const o = (k * 8 + c) * 3, sh = top ? 1 : 0.62 + 0.1 * h;
        pos[o] = vtmp.x; pos[o + 1] = vtmp.y; pos[o + 2] = vtmp.z;
        col[o] = q[4][0] * sh; col[o + 1] = q[4][1] * sh; col[o + 2] = q[4][2] * sh;
      }
      const b = k * 8;
      for (const f of [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]]) { idx.push(b + f[0], b + f[1], b + f[2], b + f[0], b + f[2], b + f[3]); }
    }
    let geo = cf.pmesh ? cf.pmesh.geometry : null; if (geo) geo.dispose();
    geo = new T.BufferGeometry(); geo.setAttribute('position', new T.BufferAttribute(pos, 3)); geo.setAttribute('color', new T.BufferAttribute(col, 3)); geo.setIndex(idx); geo.computeVertexNormals(); geo.userData.own = true;
    if (!cf.pmesh) { cf.pmesh = new T.Mesh(geo, skMaterial()); cf.pmesh.frustumCulled = false; cf.pmesh.castShadow = false; cf.pmesh.receiveShadow = true; cf.pmesh.userData.skirt = true; g.add(cf.pmesh); }
    else cf.pmesh.geometry = geo;
    cf.pmesh.visible = true; cf.pn = n;
  }

  /* fit a set of base points (world) to the ground: cf.tq = the lean about the base centre bc, cf.tdy = the sink (<= 0) that puts the
   * floating corners on the ground (the buried uphill ones stay buried), cf.piv = bc. false = no ground under a corner (kept as it was) */
  function fitBase(cf, ps, bc, lk, lm) {
    const n = ps.length, hs = []; let sx = 0, sz = 0, sh = 0;
    for (let i = 0; i < n; i++) { const g = GV.ground(ps[i][0], ps[i][1] + 0.2, ps[i][2]); if (g == null) return false; hs.push(g); sx += ps[i][0]; sz += ps[i][2]; sh += g; }
    const mx = sx / n, mz = sz / n, mh = sh / n; let sxx = 0, szz = 0, sxh = 0, szh = 0;
    for (let i = 0; i < n; i++) { const dx = ps[i][0] - mx, dz = ps[i][2] - mz, dh = hs[i] - mh; sxx += dx * dx; szz += dz * dz; sxh += dx * dh; szh += dz * dh; }
    const bx = sxx > 1e-6 ? sxh / sxx : 0, bz = szz > 1e-6 ? szh / szz : 0;
    nn.set(-bx, 1, -bz).normalize();
    const phi = Math.acos(Math.min(1, nn.y)), lean = Math.min(phi * lk, lm);
    if (phi > 1e-3 && lean > 1e-4) { v0.crossVectors(UP, nn).normalize(); cf.tq.setFromAxisAngle(v0, lean); } else cf.tq.identity();
    let mg = -1e9, sg = 0;
    for (let i = 0; i < n; i++) { v1.set(ps[i][0] - bc[0], ps[i][1] - bc[1], ps[i][2] - bc[2]).applyQuaternion(cf.tq); const g = bc[1] + v1.y - hs[i]; mg = Math.max(mg, g); sg += g; }
    mg = Math.min(mg, sg / n + 0.15);
    cf.tdy = Math.max(-DY_MAX, Math.min(0, -mg - SINK)); cf.piv = bc; cf.slope = phi;
    const L = [];                                                                                    // corners left hanging after the fit: posts under them (pulled 0.15 m toward the base centre)
    for (let i = 0; i < n; i++) {
      v1.set(ps[i][0] - bc[0], ps[i][1] - bc[1], ps[i][2] - bc[2]).applyQuaternion(cf.tq);
      const dx = bc[0] - ps[i][0], dz = bc[2] - ps[i][2], dl = Math.hypot(dx, dz) || 1, k = Math.min(0.15, dl * 0.5) / dl;
      L.push([ps[i][0] + dx * k, bc[1] + v1.y + cf.tdy, ps[i][2] + dz * k, hs[i]]);
    }
    postsFrom(cf, L);
    return true;
  }
  function newCf(id) { return { lq: new T.Quaternion(), tq: new T.Quaternion(), dy: 0, tdy: 0, t: (id * 0.137) % REFIT, gy: null, piv: null, slope: 0, posts: null, pdirty: false, pmesh: null, pn: 0 }; }
  /* ease the state and write it to the group g: (px, py, pz) + qb = the sim's position and orientation of the object */
  function applyCf(cf, g, px, py, pz, q, dt) {
    if (cf.pdirty) buildPosts(cf, g);
    const k = 1 - Math.exp(-EASE * dt);
    cf.dy += (cf.tdy - cf.dy) * k; cf.lq.slerp(cf.tq, k);
    if (cf.piv && (cf.dy < -1e-4 || cf.lq.w < 0.99999)) {
      v0.set(px - cf.piv[0], py - cf.piv[1], pz - cf.piv[2]).applyQuaternion(cf.lq);
      g.position.set(cf.piv[0] + v0.x, cf.piv[1] + v0.y + cf.dy, cf.piv[2] + v0.z);
      qb.copy(q); g.quaternion.copy(cf.lq).multiply(qb);
    } else if (cf.dy < -1e-4) g.position.y = py + cf.dy;
  }
  /* small standing objects: (x, y, z) = the centre of the base (the pivot), ho = how far the group's origin sits above it (0 = the origin IS the base centre),
   * hw / hd = base half sizes, lk / lm = lean share of the slope / its limit (rad): GV.seat(cf, g, x, y, z, yaw, hw, hd, lk, lm, dt, time, ho) (graves, devices, supply crates) */
  GV.cf = newCf;
  GV.seat = function (cf, g, x, y, z, yaw, hw, hd, lk, lm, dt, time, ho) {
    if (time >= cf.t) {
      cf.t = time + REFIT * 1.5;
      const c = Math.cos(yaw), s = Math.sin(yaw), ps = [];
      for (const [lx, lz] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) ps.push([x + lx * c + lz * s, y, z - lx * s + lz * c]);
      fitBase(cf, ps, [x, y, z], lk, lm);
    }
    qb.setFromAxisAngle(UP, yaw); applyCf(cf, g, x, y + (ho || 0), z, qb, dt);
  };

  /* refit the targets of one body: it.cf */
  function refit(b, it, H) {
    const cf = it.cf;
    const up = SS.math.q_rot(b.q, 0, 1, 0, tmpO); const upY = up.y;
    const gc = GV.ground(b.pos.x, b.pos.y, b.pos.z); if (gc != null) cf.gy = gc;
    if (H.tall && H.base && upY > 0.985) {
      const ps = []; for (const p of H.base) ps.push(world(b, b.q, p, [0, 0, 0]));
      fitBase(cf, ps, world(b, b.q, [0, -H.hb, 0], [0, 0, 0]), H.lk, H.lm);
    } else if (H.pts.length) {
      // a lying / tumbling prop: lower it when its lowest hull corner floats
      let mg = 1e9, lowY = 1e9;
      for (const p of H.pts) { const w = world(b, b.q, p, wp); if (w[1] > lowY + 0.45) continue; const g = GV.ground(w[0], w[1] + 0.2, w[2]); if (g == null) continue; if (w[1] < lowY) lowY = w[1]; mg = Math.min(mg, w[1] - g); }
      cf.tq.identity(); cf.tdy = mg > 0.02 && mg < 1 ? -Math.min(LOW_MAX, mg - 0.01) : 0; cf.piv = null;
      const L = []; for (const p of H.pts) { const w = world(b, b.q, p, wp); if (w[1] > lowY + 0.45) continue; const g = GV.ground(w[0], w[1] + 0.2, w[2]); if (g != null) L.push([w[0] + (b.pos.x - w[0]) * 0.12, w[1] + cf.tdy, w[2] + (b.pos.z - w[2]) * 0.12, g]); }
      postsFrom(cf, L);
    }
    nFit++;
  }
  GV.conform = function (b, it, dt, time) {
    const H = hull(b.prop); if (!H) return;
    let cf = it.cf; if (!cf) cf = it.cf = newCf(b.id);
    const sp = b.vel ? Math.hypot(b.vel.x, b.vel.y, b.vel.z) : 0, rest = b.asleep || sp < 0.25;
    if (rest) { if (time >= cf.t) { cf.t = time + REFIT * (b.asleep ? 2.5 : 1) + ((b.id * 0.071) % 0.1); refit(b, it, H); } }
    else { cf.tq.identity(); cf.tdy = 0; cf.t = time + 0.1; }
    qb2.set(b.q.x, b.q.y, b.q.z, b.q.w); applyCf(cf, it.g, b.pos.x, b.pos.y, b.pos.z, qb2, dt);
    // the contact shadow under the foot (a long prop: two blobs along its length)
    if (cf.gy != null && it.g.visible) {
      const r = H.r, gx = b.pos.x, gz = b.pos.z;
      if (H.two) { SS.math.q_rot(b.q, 1.0, 0, 0, tmpO); GV.blob(gx + tmpO.x, cf.gy - 0.03, gz + tmpO.z, r, 1); GV.blob(gx - tmpO.x, cf.gy - 0.03, gz - tmpO.z, r, 1); }
      else GV.blob(gx, cf.gy - 0.02, gz, r, 1);
    }
  };
  GV.stats = () => ({ blobs: nUsed, fits: nFit });
})(window.SS = window.SS || {});
