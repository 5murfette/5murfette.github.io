/* sim/swim.js — a worm in the water: it falls in (start: the nearest land to swim for), swims and loses HP over time
 * (step, water_damage), climbs out onto land or drowns (drown: it sinks for 2.2 s, sink_step); ensure_control gives the
 * active worm back its control after a swim or a fall.
 * State: w.swim (the swim record), w.drowning, w.swimOuts.
 * API: start, step, water_damage, drown, sink_step, ensure_control.
 * Determinism: no RNG. */
(function (SS) {
  'use strict';
  const SW = SS.swim;
  const C = SS.CFG;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const M = SS.math;
  const P = SS.plane;
  const W = SS.world;
  const DS = C.DS;
  const HF = C.HF;
  const sim = SS.sim;
  const DM = SS.damage;
  const WM = SS.worm;
  const TN = SS.turn;

  /* ---------- P33: in the water: swimming, struggling, back out ----------
   * (user 2026-10-08) A worm that falls in does not go under at once: it floats, struggling, losing SWIM_DPS HP/s.
   * Land (dry ground, or sea ice) within SWIM_R m and at most SWIM_CLIMB m above the water: it swims there and climbs
   * out (the active worm along the section only). No land in reach after SWIM_FLOAT_T s, too long swimming
   * (SWIM_MAX_T) or 0 HP: it drowns (the PoC sink, now resting on the bottom). Its turn ends as it falls in. */
  function landAt(S, x, z, surf) {
    const w = W, i = Math.round(x / w.H), k = Math.round(z / w.H), WD = C.WORM_DYN;
    if (i < 1 || k < 1 || i >= w.NX - 1 || k >= w.NZ - 1) return -1e9;
    if (SS.ice && S.ice) {
      const it = SS.ice.top_at(S, x, z);
      if (it > -1e8) return it;
    }
    if (SS.water && S.water && SS.water.depth(S, x, z) > 0.004) return -1e9;
    if (SS.lava && S.lava && SS.lava.depth_at(S, x, z) > 0.01) return -1e9;
    const t = w.top[k * w.NX + i];
    return t >= surf - 0.4 && t <= surf + WD.SWIM_CLIMB ? t : -1e9;
  }
  /* P91: the turn-start guarantee. The worm that gets the turn must be able to act. The rotation skips swimmers, but a
   * whole team in the water
   * (or a lone survivor) still hands the turn to one; and a stale swim state on dry ground (the water went away under a
   * jacket swimmer) blocks every input (controlActive, weapons, jumps all refuse a swimmer). Only states that really
   * block control are touched, so a normal turn changes nothing. Each recovery is counted (S.recov, never hashed) and
   * emitted ('recover' { wormId, why }) so it cannot hide a real bug. */
  function recovered(S, w, why) {
    S.recov = (S.recov | 0) + 1;
    sim.emit(S, EV.RECOVER, { wormId: w.id, why: why });
    sim.log(S, `${w.name} is back on its feet (${why}).`, 0xffa24a);
  }
  SW.ensure_control = function (S, w) {
    if (!w || w.dead || S.eow) return;
    // (weapon_ready refuses a worm in a flip)
    if (!w.swim && !w.air && !w.drowning && (w.flip || w.hop)) {
      w.flip = false;
      w.hop = false;
      recovered(S, w, 'stale jump flags');
    }
    if (w.swim) {
      const sw = w.swim, surf = sim.surface_at(S, w.pos.x, w.pos.z);
      // no water under it: a stale swim
      if (
        SS.water
        && S.water
        && !(SS.water.depth(S, w.pos.x, w.pos.z) > 0.004)
        && !(SS.lava && S.lava && SS.lava.depth_at(S, w.pos.x, w.pos.z) > 0.01)
      ) {
        w.swim = null;
        w.vel.x = w.vel.y = w.vel.z = 0;
        w.vs = w.vy = 0;
        w.air = true;
        w.rest = false;
        recovered(S, w, 'stale swim');
        return;
      }
      if (sw.jk) {
        if (SS.jacket.haul(S, w)) recovered(S, w, 'hauled ashore');
        return;
      }
      if (sw.land) {
        const t = landAt(S, sw.tx, sw.tz, surf);
        if (t > -1e8) {
          w.pos.x = sw.tx;
          w.pos.z = sw.tz;
          w.pos.y = t + w.foot + 0.02;
          w.swim = null;
          w.vel.x = w.vel.y = w.vel.z = 0;
          w.vs = w.vy = 0;
          w.air = true;
          w.rest = false;
          sim.emit(S, EV.SWIMOUT, { wormId: w.id });
          recovered(S, w, 'hauled ashore');
        }
      }
    }
  };
  function swimStart(S, w) {
    if (w.dead || w.drowning || w.swim) return;
    if (w.hp <= 0) {
      drown(S, w);
      return;
    }
    const WD = C.WORM_DYN, surf = sim.surface_at(S, w.pos.x, w.pos.z), d = P.dir(S), act = w === S.active;
    // P38 A5: the entry speed scales the splash (render only)
    const vin = Math.abs(act ? w.vy : w.vel.y);
    w.swim = { t0: S.time, acc: 0, tick: S.time, tx: 0, tz: 0, land: false, stuck: 0 };
    for (let r = 0.25; r <= WD.SWIM_R + 1e-6 && !w.swim.land; r += 0.25)
      for (let q = 0; q < (act ? 2 : 16); q++) {
        const ux = act ? (q ? -d.x : d.x) : M.cos(q * Math.PI / 8), uz = act ? (q ? -d.z : d.z) : M.sin(q * Math.PI / 8);
        const x = w.pos.x + ux * r, z = w.pos.z + uz * r;
        if (landAt(S, x, z, surf) > -1e8) {
          w.swim.tx = x;
          w.swim.tz = z;
          w.swim.land = true;
          break;
        }
      }
    w.vel.x = w.vel.y = w.vel.z = 0;
    w.rope = null;
    w.springFall = false;
    w.dying = false;
    // P37-4: a back salto ends on water entry (it spun on forever in the water)
    w.flip = false; w.hop = false; w.slide = false;
    // (end_retreat rebuilds vel from vs / vy)
    if (act) {
      if (S.phase === PHASE.PLAY) {
        S.charging = false;
        S.phase = PHASE.ATTACK;
        S.attackStart = S.time;
        S.lastBoom = S.time;
      }
      if (WM.ctl(S, w)) TN.end_retreat(S);
      S.rope = null;
      S.hook = null;
      w.vs = w.vy = 0;
      w.air = false;
      w.vel.x = w.vel.y = w.vel.z = 0;
    }
    const jk = SS.jacket ? SS.jacket.enter(S, w, surf) : false;                      // P89: a life jacket inflates (sim/lifejacket.js)
    sim.emit(S, EV.SPLASH, { x: w.pos.x, y: surf, z: w.pos.z, size: M.min(2.2, 0.8 + 0.07 * vin) });
    sim.emit(S, EV.SWIM, { wormId: w.id, land: w.swim.land, jk: jk ? 1 : 0 });
    if (!jk)
      sim.log(
        S,
        w.swim.land ? `${w.name} fell in the water and swims for the shore!` : `${w.name} fell in the water, far from land...`,
        0x7fc3ff
      );
  }
  SW.start = swimStart;
  // SWIM_DPS in SWIM_TICK chunks; returns false once it drowned. (No turn end: that happened as it fell in / a roping
  // worm keeps its turn.)
  function waterDamage(S, w, dt, acc) {
    const WD = C.WORM_DYN;
    acc.acc += WD.SWIM_DPS * dt;
    if (S.time - acc.tick < WD.SWIM_TICK || acc.acc < 1) return true;
    const n = Math.floor(acc.acc);
    acc.acc -= n;
    acc.tick = S.time;
    if (w.hp - n <= 0) {
      sim.emit(S, EV.HURT, { wormId: w.id, amount: w.hp, src: DS.DROWNING, arg: -1, dir: null, dot: true });
      w.hp = 0;
      w.swim = null;
      drown(S, w);
      return false;
    }
    DM.hurt(S, w, n, DS.DROWNING, HF.QUIET | HF.DOT);
    return true;
  }
  SW.water_damage = waterDamage;
  function swimStep(S, w, dt) {
    const WD = C.WORM_DYN, sw = w.swim;
    // the swim is scripted: no velocity survives it (a blast's push, the fall) to fling the worm on climb-out or drift
    // it while it sinks; a swimmer holds the turn (the resolve gate waits on S.lastBoom too)
    w.vel.x = w.vel.y = w.vel.z = 0; w.vs = 0; w.vy = 0;
    // P89: a life jacket swim (sim/lifejacket.js): no struggle, no HP drain, the turn does not wait for it for long
    if (sw.jk) {
      if (SS.jacket.holds(S, w)) S.lastBoom = S.time;
      SS.jacket.step(S, w, dt);
      return;
    }
    // (P99: not for ever: a hp-1 worm that crawls out and slides back into the sea on a slick bank held the turn for
    // 900 s in 2 of 40 lab soak matches; the 4th crawl-out of a turn stops the hold)
    if (w.swimOuts < 4) S.lastBoom = S.time;
    if (!waterDamage(S, w, dt, sw)) return;
    const surf = sim.surface_at(S, w.pos.x, w.pos.z);
    const ty = surf - WD.FLOAT_D + 0.06 * M.sin((S.time - sw.t0) * 7);           // up to the surface, bobbing
    const fy = w.pos.y + M.clamp(ty - w.pos.y, -2 * dt, 1.5 * dt);
    if (!(fy < w.pos.y && WM.blocked3(w.pos.x, fy, w.pos.z))) w.pos.y = fy;           // (resting on a shoal: not into it)
    if (sw.land) {
      const dx = sw.tx - w.pos.x, dz = sw.tz - w.pos.z, L = M.len2(dx, dz), st = M.min(L, WD.SWIM_V * dt);
      const nx = L > 1e-4 ? w.pos.x + dx / L * st : w.pos.x, nz = L > 1e-4 ? w.pos.z + dz / L * st : w.pos.z;
      // a submerged slope: step up over it (shallower); a real wall (the bank) close by: climb out there. (Before, any
      // slope blocked the first step and the worm snapped up to SWIM_R onto the bank.)
      let bank = WM.blocked3(nx, w.pos.y, nz);
      for (let up = 0.1; up <= 0.41 && bank; up += 0.1)
        if (!WM.blocked3(nx, w.pos.y + up, nz)) {
          w.pos.y += up;
          bank = false;
        }
      if (!bank) {
        w.pos.x = nx;
        w.pos.z = nz;
      }
      sw.stuck = bank ? (sw.stuck || 0) + dt : 0;                                 // (wedged on an outcrop short of the bank)
      if ((bank && (L < 0.9 || sw.stuck > 0.6)) || L < 0.3) {                    // at the bank: climb out
        const surf2 = sim.surface_at(S, sw.tx, sw.tz), t = landAt(S, sw.tx, sw.tz, surf2 > -90 ? surf2 : surf);
        if (t > -1e8) {
          w.pos.x = sw.tx;
          w.pos.z = sw.tz;
          w.pos.y = t + w.foot + 0.02;
          w.swim = null;
          // the time in the water not billed yet
          const left = Math.round(sw.acc);
          if (left > 0 && w.hp > left) DM.hurt(S, w, left, DS.DROWNING, HF.QUIET | HF.DOT);
          w.vel.x = w.vel.y = w.vel.z = 0; w.vs = 0; w.vy = 0;
          if (w === S.active) w.air = true;
          else w.rest = false;
          w.swimOuts++; sim.emit(S, EV.SWIMOUT, { wormId: w.id}); sim.log(S, `${w.name} crawled out of the water.`, 0x7fc3ff);
          return;
        }
      }
    }
    if (S.time - sw.t0 > (sw.land ? WD.SWIM_MAX_T : WD.SWIM_FLOAT_T)) {
      w.swim = null;
      drown(S, w);
    }
  }
  SW.step = swimStep;

  /* PoC drown (L3534 / L3559): the worm is lost at once (0 HP, its turn ends) but SINKS for 2.2 s at 26 px/s (1.67
   * m/s),
   * drifting on with its speed x 0.97 per step, then it is gone (no grave) */
  function drown(S, w) {
    if (w.dead || w.drowning) return;
    w.drowning = S.time;
    w.hp = 0;
    w.dying = false;
    w.springFall = false;
    w.flip = false;
    w.hop = false;
    if (w === S.active) {
      if (S.phase === PHASE.PLAY) {
        S.charging = false;
        S.phase = PHASE.ATTACK;
        S.attackStart = S.time;
        S.lastBoom = S.time;
      }
      if (WM.ctl(S, w)) TN.end_retreat(S);
      S.rope = null;
      S.hook = null;
    }
    w.rope = null; w.vel.y = 0;
    sim.emit(S, EV.SPLASH, { x: w.pos.x, y: sim.surface_at(S, w.pos.x, w.pos.z), z: w.pos.z, size: 1.4 });
    sim.emit(S, EV.DROWN, { wormId: w.id});
    sim.log(S, `${w.name} sank into the sea.`, 0x7fc3ff);
  }
  SW.drown = drown;
  // the ground under the water at x, z (the water bed; dry / beyond the lattice: the voxel top), for a sinking worm
  function bedAt(S, x, z) {
    if (SS.water && S.water) {
      const s = SS.water.surface(S, x, z);
      if (s > -90) return s - SS.water.depth(S, x, z);
    }
    const w = W, i = Math.round(x / w.H), k = Math.round(z / w.H);
    return i >= 0 && k >= 0 && i < w.NX && k < w.NZ ? w.top[k * w.NX + i] : -1e9;
  }
  function sinkStep(S, w, dt) {
    const WD = C.WORM_DYN;
    w.pos.y -= WD.DROWN_V * dt; w.vel.x *= 0.97; w.vel.z *= 0.97;
    // P33a: comes to rest on the bottom
    const fl = bedAt(S, w.pos.x, w.pos.z) + 0.3;
    if (w.pos.y < fl) {
      w.pos.y = fl;
      w.vel.x = w.vel.z = 0;
    }
    const nx = w.pos.x + w.vel.x * dt, nz = w.pos.z + w.vel.z * dt;
    if (!WM.blocked3(nx, w.pos.y, nz)) {
      w.pos.x = nx;
      w.pos.z = nz;
    }
    if (S.time - w.drowning >= WD.DROWN_T) {
      w.drowning = 0;
      DM.kill(S, w, 'drown');
      w.grave = null;
    }
  }
  SW.sink_step = sinkStep;
})(window.SS = window.SS || {});
