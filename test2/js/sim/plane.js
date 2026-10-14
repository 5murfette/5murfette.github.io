/* sim/plane.js — the gameplay plane: a vertical plane through S.O with bearing S.theta.
 * (s, y) are in-plane coordinates (s along the bearing), t is the signed distance from the plane.
 * Pure functions over the game state struct; no engine types.
 * Collision on the plane = terrain at t = 0 plus the cross-sections of solid bodies (props, tree trunks)
 * that actually intersect the plane (SS.bodies registers them through S.planeBodies). */
(function (SS) {
  'use strict';
  const M = SS.math;
  const P = SS.plane = {};
  const W = () => SS.world;

  /* the plane's frame: cos / sin of S.theta, recomputed only when the angle changes (M.cos / M.sin are exact software
   * functions, slow; the angle changes a few times a turn, the plane is asked thousands of times a step). The values
   * are the same numbers either way. C: static f64 FT, FC, FS. */
  let FT = NaN, FC = 1, FS = 0;
  const frame = th => {
    if (!Object.is(th, FT)) {
      FT = th;
      FC = M.cos(th);
      FS = M.sin(th);
    }
  };
  P.dir = S => {
    frame(S.theta);
    return { x: FC, z: FS };
  };
  P.nrm = S => {
    frame(S.theta);
    return { x: -FS, z: FC };
  };
  P.to_world = (S, s, y) => {
    frame(S.theta);
    return { x: S.O.x + s * FC, y, z: S.O.z + s * FS };
  };
  P.to_plane = (S, p) => {
    frame(S.theta);
    const dx = p.x - S.O.x, dz = p.z - S.O.z;
    return { s: dx * FC + dz * FS, t: -dx * FS + dz * FC };
  };
  P.sample2 = (S, s, y) => {
    frame(S.theta);
    return W().sample(S.O.x + s * FC, y, S.O.z + s * FS);
  };
  P.solid2 = (S, s, y) => P.sample2(S, s, y) > 0;
  /* terrain or a body cross-section on the plane */
  P.blocked2 = (S, s, y) => P.sample2(S, s, y) > 0 || (S.planeBodies && S.planeBodies.length > 0 && P.body_at2(S, s, y) >= 0);
  P.normal2 = (S, s, y) => {
    const e = 0.15, gs = P.sample2(S, s + e, y) - P.sample2(S, s - e, y), gy = P.sample2(S, s, y + e) - P.sample2(S, s, y - e);
    const l = M.len2(gs, gy);
    return l < 1e-6 ? { s: 0, y: 1 } : { s: -gs / l, y: -gy / l };
  };

  /* ---------- solid bodies on the plane: S.planeBodies = [PlaneBody] (2D cross-sections) ----------
   * Rebuilt each step by sim. Every shape is centred at (s, y) and has a unit axis (ax, ay) in the plane:
   *   DISC     radius r (a worm, a ball);
   *   BOX      half extents hs along the axis and hy across it (axis (1, 0): a box aligned with the plane);
   *   CAPSULE  the segment (s, y) +- hs (ax, ay), radius r (a trunk, a branch, a log, a girder: a round rod cut along
   *            its length).
   * A shape covers only what is drawn: a slanted rod is a slanted capsule, never the box around it.
   * C: struct PlaneBody { f32 s, y, hs, hy, r, ax, ay; u8 kind, ice; i32 body (the rigid body's id, -1), tree, seg
   * (tree id / segment), struct (bridge id), i16 worm (worm id: a worm's disc, -1) } */
  const PB = P.PB = { DISC: 0, BOX: 1, CAPSULE: 2 };
  function pb_push(L, kind, s, y, hs, hy, r, ax, ay, body, tree, seg, st, worm, ice) {
    if (L.length >= SS.CFG.LIMITS.PLANE_BODIES) return;
    L.push({ s, y, kind, hs, hy, r, ax, ay, body, tree, seg, struct: st, worm, ice });
  }
  // a disc (kind DISC) or a box aligned with the plane (kind BOX)
  P.pb_add = (L, kind, s, y, hs, hy, r, body, tree, seg, st, worm, ice) =>
    pb_push(L, kind, s, y, hs, hy, r, 1, 0, body, tree, seg, st, worm, ice);
  // a box turned to the unit axis (ax, ay)
  P.pb_box = (L, s, y, hs, hy, ax, ay, body) => pb_push(L, PB.BOX, s, y, hs, hy, 0, ax, ay, body, -1, -1, -1, -1, false);
  // a capsule along (s0, y0) .. (s1, y1)
  P.pb_capsule = (L, s0, y0, s1, y1, r, body, tree, seg, st) => {
    const ds = s1 - s0, dy = y1 - y0, l = M.len2(ds, dy), ax = l > 1e-6 ? ds / l : 1, ay = l > 1e-6 ? dy / l : 0;
    pb_push(L, PB.CAPSULE, (s0 + s1) / 2, (y0 + y1) / 2, l / 2, 0, r, ax, ay, body, tree, seg, st, -1, false);
  };
  /* the cut of a rod (world segment a..b) by the plane, as a capsule: the part of the rod that reaches the plane. A
   * round rod (w = 0) has radius r: the cut's half width is the chord at the middle of that part. A flat-sided beam
   * (w > 0: half width w across, half height r) keeps r. A rod that crosses the plane at an angle cuts an ellipse, so
   * the capsule is no longer than that (2 w / sin(angle)). Nothing when the rod misses the plane. */
  P.pb_rod = (S, L, a, b, r, w, body, tree, seg, st) => {
    const n = P.nrm(S), d = P.dir(S), ox = S.O.x, oz = S.O.z, ext = w > 0 ? w : r;
    const ta = (a.x - ox) * n.x + (a.z - oz) * n.z, tb = (b.x - ox) * n.x + (b.z - oz) * n.z;
    let u0 = 0, u1 = 1;
    if (Math.abs(ta - tb) < 1e-4) {
      if (Math.abs(ta) >= ext) return;
    }
    else {
      const ua = (ta - ext) / (ta - tb), ub = (ta + ext) / (ta - tb);
      u0 = M.max(0, M.min(ua, ub));
      u1 = M.min(1, M.max(ua, ub));
      if (u1 <= u0) return;
    }
    const tm = M.min(Math.abs(ta + (tb - ta) * (u0 + u1) / 2), ext * 0.95), hw = w > 0 ? r : Math.sqrt(r * r - tm * tm);
    const xa = a.x + (b.x - a.x) * u0, za = a.z + (b.z - a.z) * u0, xb = a.x + (b.x - a.x) * u1, zb = a.z + (b.z - a.z) * u1;
    const sa = (xa - ox) * d.x + (za - oz) * d.z, sb = (xb - ox) * d.x + (zb - oz) * d.z;
    const ya = a.y + (b.y - a.y) * u0, yb = a.y + (b.y - a.y) * u1;
    const cs = (sa + sb) / 2, cy = (ya + yb) / 2, l = M.len2(sb - sa, yb - ya);
    const sinA = Math.abs(tb - ta) / M.nz(M.len3(b.x - a.x, b.y - a.y, b.z - a.z), 1);
    const h = sinA > 1e-4 ? M.min(l / 2, M.max(0, ext / sinA - hw)) : l / 2, k = l > 1e-6 ? h / l : 0;
    P.pb_capsule(L, cs - (sb - sa) * k, cy - (yb - ya) * k, cs + (sb - sa) * k, cy + (yb - ya) * k, hw, body, tree, seg, st);
  };
  // (s, y) inside plane body b
  P.pb_inside = (b, s, y) => {
    const ds = s - b.s, dy = y - b.y;
    if (b.kind === PB.DISC) return ds * ds + dy * dy < b.r * b.r;
    const ls = ds * b.ax + dy * b.ay;
    if (b.kind === PB.BOX) return Math.abs(ls) < b.hs && Math.abs(dy * b.ax - ds * b.ay) < b.hy;
    const u = M.clamp(ls, -b.hs, b.hs), es = ds - u * b.ax, ey = dy - u * b.ay;
    return es * es + ey * ey < b.r * b.r;
  };
  // the outward normal at (s, y) (a point inside: the way out of the nearest face)
  P.pb_normal = (b, s, y) => {
    const ds = s - b.s, dy = y - b.y;
    if (b.kind === PB.DISC) {
      const l = M.nz(M.len2(ds, dy), 1);
      return { s: ds / l, y: dy / l };
    }
    const ls = ds * b.ax + dy * b.ay;
    if (b.kind === PB.BOX) {
      const lv = dy * b.ax - ds * b.ay;
      if (b.hs - Math.abs(ls) < b.hy - Math.abs(lv)) {
        const g = Math.sign(ls) || 1;
        return { s: g * b.ax, y: g * b.ay };
      }
      const g = Math.sign(lv) || 1;
      return { s: -g * b.ay, y: g * b.ax };
    }
    const u = M.clamp(ls, -b.hs, b.hs), es = ds - u * b.ax, ey = dy - u * b.ay, l = M.len2(es, ey);
    return l > 1e-6 ? { s: es / l, y: ey / l } : { s: -b.ay, y: b.ax };
  };
  // how deep (s, y) is inside b (m; < 0 outside: minus the distance, exact for discs and capsules)
  P.pb_depth = (b, s, y) => {
    const ds = s - b.s, dy = y - b.y;
    if (b.kind === PB.DISC) return b.r - M.len2(ds, dy);
    const ls = ds * b.ax + dy * b.ay;
    if (b.kind === PB.BOX) return M.min(b.hs - Math.abs(ls), b.hy - Math.abs(dy * b.ax - ds * b.ay));
    const u = M.clamp(ls, -b.hs, b.hs);
    return b.r - M.len2(ds - u * b.ax, dy - u * b.ay);
  };
  // the largest half extent of b (a size for search radii and culling)
  P.pb_size = b => b.kind === PB.DISC ? b.r : b.kind === PB.BOX ? M.max(b.hs, b.hy) : b.hs + b.r;
  P.body_at2 = (S, s, y, noWorms) => {                     // noWorms: skip the worm discs (projectiles test worms apart)
    const B = S.planeBodies;
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      if (noWorms && b.worm >= 0) continue;
      if (P.pb_inside(b, s, y)) return i;
    }
    return -1;
  };
  P.body_normal2 = (S, i, s, y) => P.pb_normal(S.planeBodies[i], s, y);

  // Worm collision disc: 12 rim points + centre.
  const CP = [];
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    CP.push(M.cos(a) * SS.CFG.WORM_R, M.sin(a) * SS.CFG.WORM_R);
  }
  CP.push(0, 0);
  P.overlap2 = (S, s, y) => {
    let c = 0;
    for (let i = 0; i < CP.length; i += 2)
      if (P.blocked2(S, s + CP[i], y + CP[i + 1])) c++;
    return c;
  };
  // the bottom of the disc (its three rim points within 30 degrees of straight down: 240, 270, 300): what the worm can
  // stand on (a contact further up its flank is too steep to hold it)
  P.under2 = (S, s, y) => {
    let c = 0;
    for (let i = 16; i < 22; i += 2)
      if (P.blocked2(S, s + CP[i], y + CP[i + 1])) c++;
    return c;
  };
  P.grounded2 = (S, s, y) => P.blocked2(S, s, y - 0.53) || P.blocked2(S, s - 0.25, y - 0.47) || P.blocked2(S, s + 0.25, y - 0.47);
  P.in_section = (S, p, r) => Math.abs(P.to_plane(S, p).t) <= SS.CFG.HALF + (r || 0);
  // [s0, s1] range of the plane inside the round play area (W.play_disc: the chord; null when the plane misses it),
  // or inside the world box (P.range) on a 2D slab / in the End of the World
  const PD = { x: 0, z: 0, r: 0 };
  P.chord = S => {
    const c = W().play_disc(PD);
    if (!c) return P.range(S);
    const d = P.dir(S), ox = S.O.x - c.x, oz = S.O.z - c.z, b = ox * d.x + oz * d.z, D = b * b - (ox * ox + oz * oz - c.r * c.r);
    if (D <= 0) return null;
    const sq = Math.sqrt(D);
    return [-b - sq, -b + sq];
  };
  // [s0, s1] range of the plane that lies inside the world box.
  P.range = S => {
    const d = P.dir(S), w = W();
    let s0 = -1e9, s1 = 1e9;
    const ax = [[S.O.x, d.x, w.SX], [S.O.z, d.z, w.SZ]];
    for (let i = 0; i < 2; i++) {
      const o = ax[i][0], v = ax[i][1], L = ax[i][2];
      if (Math.abs(v) < 1e-6) continue;
      const a = -o / v, b = (L - o) / v;
      s0 = M.max(s0, M.min(a, b)); s1 = M.min(s1, M.max(a, b));
    }
    return [Math.floor(s0) - 1, Math.ceil(s1) + 1];
  };
})(window.SS = window.SS || {});
