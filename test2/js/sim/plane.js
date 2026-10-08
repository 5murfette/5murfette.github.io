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

  P.dir = S => ({ x: M.cos(S.theta), z: M.sin(S.theta) });
  P.nrm = S => ({ x: -M.sin(S.theta), z: M.cos(S.theta) });
  P.to_world = (S, s, y) => ({ x: S.O.x + s * M.cos(S.theta), y, z: S.O.z + s * M.sin(S.theta) });
  P.to_plane = (S, p) => {
    const c = M.cos(S.theta), sn = M.sin(S.theta), dx = p.x - S.O.x, dz = p.z - S.O.z;
    return { s: dx * c + dz * sn, t: -dx * sn + dz * c };
  };
  P.sample2 = (S, s, y) => W().sample(S.O.x + s * M.cos(S.theta), y, S.O.z + s * M.sin(S.theta));
  P.solid2 = (S, s, y) => P.sample2(S, s, y) > 0;
  /* terrain or a body cross-section on the plane */
  P.blocked2 = (S, s, y) => P.sample2(S, s, y) > 0 || (S.planeBodies && S.planeBodies.length > 0 && P.body_at2(S, s, y) >= 0);
  P.normal2 = (S, s, y) => {
    const e = 0.15, gs = P.sample2(S, s + e, y) - P.sample2(S, s - e, y), gy = P.sample2(S, s, y + e) - P.sample2(S, s, y - e);
    const l = M.len2(gs, gy);
    return l < 1e-6 ? { s: 0, y: 1 } : { s: -gs / l, y: -gy / l };
  };

  /* ---------- solid bodies on the plane: S.planeBodies = [{s, y, kind, hs, hy, r, ref}] (2D cross-sections) ----------
   * kind 0 = disc radius r centred at (s,y); kind 1 = box half extents (hs, hy). Rebuilt each step by sim. */
  P.body_at2 = (S, s, y, noWorms) => {                     // noWorms: skip the worm discs (projectiles test worms apart)
    const B = S.planeBodies;
    for (let i = 0; i < B.length; i++) {
      const b = B[i], ds = s - b.s, dy = y - b.y;
      if (noWorms && b.worm) continue;
      if (b.kind === 0) { if (ds * ds + dy * dy < b.r * b.r) return i; }
      else if (Math.abs(ds) < b.hs && Math.abs(dy) < b.hy) return i;
    }
    return -1;
  };
  P.body_normal2 = (S, i, s, y) => {
    const b = S.planeBodies[i], ds = s - b.s, dy = y - b.y;
    if (b.kind === 0) { const l = M.len2(ds, dy) || 1; return { s: ds / l, y: dy / l }; }
    const px = b.hs - Math.abs(ds), py = b.hy - Math.abs(dy);
    return px < py ? { s: Math.sign(ds) || 1, y: 0 } : { s: 0, y: Math.sign(dy) || 1 };
  };

  // Worm collision disc: 12 rim points + centre.
  const CP = [];
  for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; CP.push(M.cos(a) * SS.CFG.WORM_R, M.sin(a) * SS.CFG.WORM_R); }
  CP.push(0, 0);
  P.overlap2 = (S, s, y) => { let c = 0; for (let i = 0; i < CP.length; i += 2) if (P.blocked2(S, s + CP[i], y + CP[i + 1])) c++; return c; };
  P.grounded2 = (S, s, y) => P.blocked2(S, s, y - 0.53) || P.blocked2(S, s - 0.25, y - 0.47) || P.blocked2(S, s + 0.25, y - 0.47);
  P.in_section = (S, p, r) => Math.abs(P.to_plane(S, p).t) <= SS.CFG.HALF + (r || 0);
  // [s0, s1] range of the plane that lies inside the world box.
  P.range = S => {
    const d = P.dir(S), w = W(); let s0 = -1e9, s1 = 1e9;
    const ax = [[S.O.x, d.x, w.SX], [S.O.z, d.z, w.SZ]];
    for (let i = 0; i < 2; i++) {
      const o = ax[i][0], v = ax[i][1], L = ax[i][2];
      if (Math.abs(v) < 1e-6) continue;
      const a = -o / v, b = (L - o) / v;
      s0 = Math.max(s0, Math.min(a, b)); s1 = Math.min(s1, Math.max(a, b));
    }
    return [Math.floor(s0) - 1, Math.ceil(s1) + 1];
  };
})(window.SS = window.SS || {});
