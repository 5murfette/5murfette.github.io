/* sim/devices.js — what a worm sets down that stays in the world: the pocket magnet and the spring trap (S.devices,
 * dropped by weapons.js), and the rule every set-down device follows (also the sentry gun and the claymore of
 * gadgets.js and the force-field generator of ffield.js): held by what it stands on it rests, held by nothing it falls
 * straight down under C.G (in space along the field of the chunks: eow.dev_fall), and below FLOOR it is lost.
 * Portable and deterministic: no RNG, sim time only.
 * C layout: struct Device { u8 kind (magnet, spring), team; f32 s, y, vy; vec3 pos; f32 theta; vec2 O; f32 ds, dy;
 *   u8 turns, charges; f32 cool, t, hp; i32 id; f32 planted; u8 revealed; f32 gv; vec3 *eu (space: its local up) }
 * API: FLOOR, make(S, kind, team, s, y), fall(S, d, dt, held), drop(d, dt), lift(d, probe, step, max), hit(S, wp, dmg),
 *   step(S, dt), turn_start(S), blast(S, c, R, dP). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane, A = C.ARMS;
  const EV = C.EV;
  const DV = SS.devices = {};
  const W = () => SS.world;
  const sim = () => SS.sim;
  DV.FLOOR = 0.3;                     // m: a device that falls below this height has left the world

  // a magnet or a spring trap set down at (s, y) on the current plane, which it keeps
  DV.make = function (S, kind, team, s, y) {
    const aim = sim().aim_dir(S), l = M.len2(aim.s, M.max(0.25, aim.y));
    return { kind, team, s, y, vy: 0, pos: P.to_world(S, s, y), theta: S.theta, O: { x: S.O.x, z: S.O.z }, ds: aim.s / l,
      dy: M.max(0.25, aim.y) / l, turns: kind === 'magnet' ? A.MAGNET.TURNS : A.SPRING.TURNS, charges: A.SPRING.CHARGES, cool: 0, t: 0,
      hp: 35, id: S.devices.length + S.turnNo * 16, planted: S.time, revealed: false, gv: 0, eu: null };
  };
  /* one step of set-down device d { pos, vy } that what it stands on holds (held) or not: in space it falls along the
   * field and rests on any side of a chunk (eow.dev_fall: gv, eu); on a world held it rests (vy 0), else it falls
   * straight down. false: it is lost (off the world, below FLOOR). */
  DV.fall = function (S, d, dt, held) {
    if (S.eow) return SS.eow.dev_fall(S, d, dt);
    if (held) {
      d.vy = 0;
      return true;
    }
    return DV.drop(d, dt);
  };
  // one step of the straight fall under C.G; false below FLOOR
  DV.drop = function (d, dt) {
    d.vy -= C.G * dt;
    d.pos.y += d.vy * dt;
    return d.pos.y >= DV.FLOOR;
  };
  // a resting device that sank into the ground rises in steps of step m while the lattice probe m under it is solid,
  // at most max m
  DV.lift = function (d, probe, step, max) {
    const w = W();
    for (let l = 0; w.sample(d.pos.x, d.pos.y - probe, d.pos.z) > 0 && l < max; l += step) d.pos.y += step;
  };
  // a round at wp hits the first device within 0.4 m of it: dmg HP; true when it hit one
  DV.hit = function (S, wp, dmg) {
    for (const d of S.devices)
      if (M.v3_dist(d.pos, wp) < 0.4) {
        d.hp -= dmg;
        return true;
      }
    return false;
  };
  const METAL = p => !!(C.PROJ[p.type] || {}).metal;
  // the armed magnet pulls the metal shells in its plane and the metal props around it
  function magnet(S, d, dt) {
    const K = A.MAGNET, dp = P.to_plane(S, d.pos);
    for (const p of S.proj)
      if (METAL(p)) {
        const ds = dp.s - p.s, dy = d.pos.y - p.y, r = M.len2(ds, dy);
        if (r > 0.8 && r < K.R && Math.abs(dp.t) < C.HALF + 1) {
          const a = K.A * (1 - r / K.R) * dt;
          p.vs += ds / r * a;
          p.vy += dy / r * a;
        }
      }
    for (const b of S.bodies)
      if (b.prop === 'mine' || b.prop === 'barrel' || b.prop === 'girder') {
        const r = M.v3_dist(b.pos, d.pos);
        if (r > 0.8 && r < K.R)
          SS.bodies.nudge(
            S,
            b,
            { x: d.pos.x - b.pos.x, y: d.pos.y - b.pos.y, z: d.pos.z - b.pos.z },
            M.min(b.mass, K.KG_CAP) * K.A * (1 - r / K.R) * dt
          );
      }
  }
  /* the spring trap: buried, for WORMS only (no props, shells or branches); an enemy worm stepping on
   * it is thrown high: DMG HP for the jolt, and its landing hurts at least FALL_MIN (w.springFall, worm.js landings).
   * The planting team knows where it lies and walks over it safely. true: its last charge is spent */
  function spring(S, d) {
    const K = A.SPRING, side = { x: M.cos(d.theta) * Math.sign(d.ds || 1), z: M.sin(d.theta) * Math.sign(d.ds || 1) };
    let fired = false;
    for (const o of S.worms)
      if (!o.dead && o.hp > 0 && o.team !== d.team && M.v3_dist(o.pos, d.pos) < K.R + C.WORM_R && o.pos.y - d.pos.y < 1.2) {
        sim().hurt(S, o, K.DMG, C.DS.SPRING);
        o.springFall = true; o.pos.y += 0.1;
        if (sim().ctl(S, o)) {
          const pd = P.dir(S);
          o.vs = (side.x * pd.x + side.z * pd.z) * K.V_SIDE;
          o.vy = K.V_UP;
          o.air = true;
          S.rope = null;
        }
        else {
          o.rest = false;
          o.vel.x = side.x * K.V_SIDE;
          o.vel.y = K.V_UP;
          o.vel.z = side.z * K.V_SIDE;
        }
        fired = true; d.revealed = true;
        sim().log(S, `${o.name} steps on a spring trap!`, 0xffb27a);
      }
    if (!fired) return false;
    d.charges--;
    d.cool = K.COOL;
    S.lastBoom = S.time;
    sim().emit(S, EV.SPRING, { x: d.pos.x, y: d.pos.y, z: d.pos.z });
    return d.charges <= 0;
  }
  DV.step = function (S, dt) {
    const w = W();
    for (let i = S.devices.length - 1; i >= 0; i--) {
      const d = S.devices[i];
      if (d.hp <= 0) {
        S.devices.splice(i, 1);
        sim().emit(S, EV.DEVBREAK, { x: d.pos.x, y: d.pos.y, z: d.pos.z, kind: d.kind });
        continue;
      }
      // it rests on the ground or a floor under it, else it falls (in its own plane); sunk 0.5 m into water it is lost
      const below = S.eow
        ? !(d.gv > 0)
        : w.sample(d.pos.x, d.pos.y - 0.18, d.pos.z) > 0 || (SS.struct && SS.struct.floor_at(S, d.pos.x, d.pos.y, d.pos.z) > d.pos.y - 0.2);
      if (!DV.fall(S, d, dt, below) || (!S.eow && !below && d.pos.y < sim().surface_at(S, d.pos.x, d.pos.z) - 0.5)) {
        S.devices.splice(i, 1);
        continue;
      }
      if (below && !S.eow) DV.lift(d, 0.1, 0.05, w.SY);
      d.t += dt; d.cool = M.max(0, d.cool - dt);
      if (d.kind === 'magnet' && d.t > A.MAGNET.ARM && below) magnet(S, d, dt);
      if (d.kind === 'spring' && d.cool <= 0 && d.charges > 0 && d.t > A.SPRING.ARM && below && spring(S, d)) S.devices.splice(i, 1);
    }
  };
  // each turn a device has one turn less to live
  DV.turn_start = function (S) {
    for (let i = S.devices.length - 1; i >= 0; i--) {
      const d = S.devices[i];
      if (--d.turns <= 0) {
        S.devices.splice(i, 1);
        sim().emit(S, EV.DEVBREAK, { x: d.pos.x, y: d.pos.y, z: d.pos.z, kind: d.kind, expired: 1 });
      }
    }
  };
  // a blast (weapons.blast: R = blast.poc_R, dP = blast.poc_dmg) takes dP x the PoC pressure factor HP off a device
  DV.blast = function (S, c, R, dP) {
    for (const d of S.devices) {
      const f = SS.blast.poc_factor(M.v3_dist(d.pos, c), R);
      if (f > 0) d.hp -= dP * f;
    }
  };
})(window.SS = window.SS || {});
