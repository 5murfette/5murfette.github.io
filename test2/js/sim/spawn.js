/* sim/spawn.js — where worms and objects may be placed: free spots on land away from lava, hot veins and hazards
 * (find_spot, cave spots, the fallback search), unburying worms that the map buried, the spawn audit (no worm starts
 * in a hazard), and the play area of a dry world (arena_r, in_play: beyond C.DRY.PLAY_R the sand is hot).
 * API: find_spot, fallback_spot, near_lava, unbury_worms, spawn_hazard, spawn_audit, arena_r, in_play.
 * Determinism: draws only from S.rng (find_spot, cave spots). */
(function (SS) {
  'use strict';
  const SP = SS.spawn;
  const C = SS.CFG;
  const M = SS.math;
  const MAT = C.MAT;
  const W = SS.world;
  const rand = S => M.rng_next(S.rng);
  const WM = SS.worm;

  /* ---------- setup ---------- */
  /* open lava (sim/lava.js layer) or a lava canal within ~2.5 m: no spawns, no props */
  function nearLava(S, x, z) {
    if (SS.lava && S.lava)
      for (let q = 0; q < 9; q++) {
        const dx = q === 0 ? 0 : M.cos(q * 0.785) * 2, dz = q === 0 ? 0 : M.sin(q * 0.785) * 2;
        if (SS.lava.depth_at(S, x + dx, z + dz) > 0.005) return true;
      }
    const cs = W.features.canals || [];
    for (let c = 0; c < cs.length; c++)
      for (const pt of cs[c].pts)
        if (M.len2(pt[0] - x, pt[2] - z) < pt[3] * 0.5 + 2.5) return true;
    if (S.eow && SS.eow.hot_near(S, x, W.topHeight(x, z), z)) return true;       // no spawn on or within 1.5 m of a hot vein
    return false;
  }
  SP.near_lava = nearLava;
  /* ---------- dry worlds (Step D, C.DRY): play area, hot sand ----------
   * No wall (D4): beyond the lattice the ground is the analytic far dunes (world.js W.sample -> W.far_at), so a worm
   * blasted out lands there, burns on the hot sand and has to walk back; beyond FAR_R it is lost in the desert. */
  const DRY = C.DRY;
  SP.arena_r = (x, z) => M.len2(x - DRY.CX, z - DRY.CZ);
  SP.in_play = (S, x, z) => !W.dry || SP.arena_r(x, z) <= S.playR;   // dry worlds: inside the (shrinking) play circle

  /* U: a standable cave floor (air with >= clear m of room above, a level floor, away from lava / others) */
  function caveSpot(S, minSep, taken, o) {
    const w = W;
    for (let tries = 0; tries < 6000; tries++) {
      const x = 6 + rand(S) * (w.SX - 12), z = w.zpick(rand(S), 6);
      let y = 2 + rand(S) * (w.SY - 6);
      if (w.sample(x, y, z) > 0) continue;
      while (y > 1 && w.sample(x, y - 0.1, z) <= 0) y -= 0.1;
      if (y <= 1.2) continue;
      let ok = w.sample(x, y + (o.clear || 1.6), z) <= 0 && w.sample(x, y + 0.8, z) <= 0;
      for (const [dx, dz] of [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) {
        if (!ok) break;
        if (w.sample(x + dx, y + 0.3, z + dz) > 0 || w.sample(x + dx, y - 0.4, z + dz) <= 0) ok = false;
      }
      if (!ok) continue;
      if (o.team != null && !SS.fort.spot_ok(x, z, y, o.team)) continue;           // the worm's own fort
      const m = w.mat_at(x, y - 0.2, z);
      if (m === MAT.LAVA || (m === MAT.ICE && !o.ice) || (o.mats && o.mats.indexOf(m) < 0)) continue;
      if (!w.flat && M.len2(x - w.MX, z - w.MZ) > w.PR) continue;                // (the round play area)
      if (taken.some(t => M.len3(t.x - x, t.z - z, (t.y - y) * 1.5) < minSep)) continue;
      return { x, y, z };
    }
    return null;
  }
  // last resort: the map centre's ground; underground (where topHeight is the roof) the floor of the first chamber
  function fallbackSpot(S) {
    const w = W, ch = w.under && w.features.caves && w.features.caves.chambers[0];
    if (ch) {
      let y = ch.y;
      while (y > 1 && w.sample(ch.x, y - 0.1, ch.z) <= 0) y -= 0.1;
      return { x: ch.x, y, z: ch.z };
    }
    return { x: w.MX, y: w.topHeight(w.MX, w.MZ), z: w.MZ };
  }
  SP.fallback_spot = fallbackSpot;
  SP.find_spot = function (S, minSep, taken, opts) {
    const w = W, o = opts || {};
    if (w.under) return caveSpot(S, minSep, taken, o);
    for (let tries = 0; tries < 5000; tries++) {
      const x = 8 + rand(S) * (w.SX - 16), z = w.zpick(rand(S), 8), top = w.topHeight(x, z);
      if (top < w.SEA + (o.minAlt || 1.5) || top > (o.maxAlt || 99)) continue;
      if (w.dry && SP.arena_r(x, z) > DRY.SPAWN_R) continue;                     // dry: everything starts in the play area
      if (!w.dry && !w.flat && M.len2(x - w.MX, z - w.MZ) > w.PR) continue;      // (the round play area)
      if (o.team != null && !SS.fort.spot_ok(x, z, top, o.team)) continue;        // the worm's own fort
      const m = w.mat_at(x, top - 0.2, z);
      if (m === MAT.LAVA || m === MAT.ICE && !o.ice || (o.mats && o.mats.indexOf(m) < 0)) continue;
      let ok = true;
      const off = [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]];
      for (let i = 0; i < 4; i++)
        if (Math.abs(w.topHeight(x + off[i][0], z + off[i][1]) - top) >= (o.slope || 0.8)) ok = false;
      if (!ok || w.sample(x, top + (o.clear || 1.3), z) > 0) continue;
      const F = w.features;
      if ((F.volcanoes || []).some(v => M.len2(x - v.x, z - v.z) < v.Rc + 3)) continue;
      // never on / beside a lava river (pre-filled, but they flow: keep 4 m from every canal centre line)
      if (F.canals && F.canals.some(cn => cn.pts.some(q => M.len2(q[0] - x, q[2] - z) < 4 + (q[3] || 0)))) continue;
      if (nearLava(S, x, z)) continue;
      let clash = false;
      for (let i = 0; i < taken.length; i++)
        if (M.len2(taken[i].x - x, taken[i].z - z) < minSep * w.sepk) {
          clash = true;
          break;
        }
      if (clash) continue;
      return { x, y: top, z };
    }
    return null;
  };
  function unbury_worms(S, taken) {
    const w = W;
    if (w.under) return 0;
    let moved = 0;
    for (const o of S.worms) {
      if (o.dead || WM.body_free(w, o.pos.x, o.pos.y, o.pos.z)) continue;
      let done = false;
      for (let r = 1.5; r <= 30 && !done; r += 1.5)
        for (let q = 0; q < 16 && !done; q++) {
          const a = q * M.TAU / 16, x = o.pos.x + M.cos(a) * r, z = w.flat ? o.pos.z : o.pos.z + M.sin(a) * r;
          if (x < 6 || x > w.SX - 6 || !w.zin(z, 6)) continue;
          const top = w.topHeight(x, z), y = top + 0.55;
          if (
            top < w.SEA + 0.8
            || (w.dry && !SP.in_play(S, x, z))
            || nearLava(S, x, z)
            || w.mat_at(x, top - 0.2, z) === MAT.LAVA
            || !WM.body_free(o, x, y, z)
          ) continue;
          if (SS.fort && SS.fort.is() && SS.fort.team_at(x, z, y) !== o.team) continue;      // stay on the worm's own fort
          if (!(w.sample(x, y - 0.6, z) > 0)) continue;                               // stand on something
          let clash = false;
          for (const p of S.worms)
            if (p !== o && !p.dead && M.len3(p.pos.x - x, p.pos.y - y, p.pos.z - z) < 3) clash = true;
          if (clash) continue;
          o.pos.x = x;
          o.pos.y = y;
          o.pos.z = z;
          o.vel.x = o.vel.y = o.vel.z = 0;
          o.rest = false;
          done = true;
          moved++;
          // (the spot list follows the lifted worm: props / boulders / trees placed later keep clear of the new
          // place)
          if (taken && taken[o.id]) taken[o.id] = { x, y: top, z };
        }
    }
    return moved;
  }
  SP.unbury_worms = unbury_worms;

  /* the spawn audit. A worm must never start where the environment hurts it at once: beyond the play circle of a
   * dry world (hot sand, 1 HP / 5 s from the first second),
   * in or beside lava, in water (the map's own pools). find_spot, the fort seats, the fall-back spot and the stamps'
   * lift each guard some of these; this is the one place that checks the finished layout and moves a worm that is still
   * on a hazard to the nearest clean spot find_spot gives (deterministic: the same RNG stream, taken = the others).
   * Returns the number moved. C: bool spawn_hazard(Game*, Worm*); i32 spawn_audit(Game*, Vec3 taken[]). */
  function spawn_hazard(S, o) {
    const w = W;
    if (w.under || S.eow) return false;
    if (w.dry && SP.arena_r(o.pos.x, o.pos.z) > S.playR - 1) return true;
    if (SS.lava && S.lava && SS.lava.depth_at(S, o.pos.x, o.pos.z) > 0.005) return true;
    if (w.mat_at(o.pos.x, o.pos.y - o.foot - 0.2, o.pos.z) === MAT.LAVA) return true;
    if (SS.water && S.water && SS.water.depth(S, o.pos.x, o.pos.z) > 0.3) return true;
    return false;
  }
  SP.spawn_hazard = spawn_hazard;
  function spawn_audit(S, taken) {
    let moved = 0;
    const fortOn = !!SS.fort && SS.fort.is();
    for (const o of S.worms) {
      if (o.dead || !spawn_hazard(S, o)) continue;
      const others = [];
      for (const p of S.worms)
        if (p !== o && !p.dead) others.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z });
      const fo = fortOn ? { team: o.team } : undefined, sp = SP.find_spot(S, 6, others, fo) || SP.find_spot(S, 3, others, fo);
      if (!sp) continue;
      o.pos.x = sp.x;
      o.pos.y = sp.y + 0.55;
      o.pos.z = sp.z;
      o.vel.x = o.vel.y = o.vel.z = 0;
      o.rest = false;
      moved++;
      if (taken && taken[o.id]) taken[o.id] = { x: sp.x, y: sp.y, z: sp.z };
    }
    return moved;
  }
  SP.spawn_audit = spawn_audit;
})(window.SS = window.SS || {});
