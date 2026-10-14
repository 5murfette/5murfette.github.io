/* sim/flight.js — the shells in flight on the gameplay plane: the sim's projectile step (FL.step: the forces of a
 * step, sub-steps of at most 0.06 m through sea ice, the water entry, open lava and what the shell meets, then the
 * fuse) and the rules it shares with the CPU's shot prediction (ai.js predict), which sub-steps to 0.12 m at 1/60 s: a
 * primitive does the same arithmetic for both, so a predicted shell and a real one follow one rule. Portable,
 * deterministic: S state, the world arrays, no allocation in the primitives.
 * A flight is any struct with { vs, vy, wet } (plane speed along / up, m/s; under water): the projectile itself in the
 * sim, a scratch struct in the prediction. A guided shell also carries { gk, wk } (its gravity and wind factors, 1 =
 * full).
 * C: struct Flight { f32 vs, vy; u8 wet; };
 *   void flight_gravity(Game *, Flight *, f32 x, f32 y, f32 z, f32 dx, f32 dz, f32 gk, f32 h);
 *   void flight_wind(Game *, Flight *, f32 x, f32 y, f32 z, f32 wk, f32 dt);  void flight_plunge(Flight *);
 *   bool flight_out(const Game *, f32 x, f32 z, f32 y);  f32 flight_soft(u8 mat);
 *   void flight_bounce(Flight *, vec2 n, f32 vn, u8 mat, f32 rest, f32 fric);  void flight_ice_skid(Flight *, f32 h);
 *   bool flight_worm_normal(vec2 worm, vec2 shell, f32 rr, vec2 *n);  void flight_worm_bounce(Flight *, vec2 n, f32
 *   vn);
 *   void flight_homing(Flight *, const Homing *, f32 age, vec2 shell, vec2 target, f32 dist0, f32 v0, f32 dt);
 *   void flight_step(Game *, f32 dt);  void flight_remove(Game *, Proj *).
 * API: step, remove, gravity, wind, plunge, out_of_field, soft, bounce, ice_skid, worm_normal, worm_bounce, homing,
 *   OOB, ICE_SKID, REST, FRIC. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT;
  const FL = SS.flight = {};
  const W = () => SS.world;
  FL.OOB = 120;                       // m beyond the lattice of a world with a sea: the shell left the battlefield
  FL.ICE_SKID = 0.25;                 // 1/s: the speed a shell keeps skidding on ice (exp(-ICE_SKID t))
  FL.REST = 0.4;                      // the restitution and friction of a shell whose weapon names none
  FL.FRIC = 0.9;
  const EG = { s: 0, y: 0 }, WV = { x: 0, y: 0, z: 0 };
  // a shell against a worm's soft body: restitution 0.15 (x (1 + 0.15) of the speed into it), then half the speed kept
  const WORM_K = 1.15, WORM_KEEP = 0.5;

  /* one sub-step h of gravity on flight f at (x, y, z) (dx, dz: the plane's direction): under water a drag and 55 % of
   * gravity (the rest is buoyancy), in space the summed pull of the chunks, else the plain pull C.G x gk */
  FL.gravity = function (S, f, x, y, z, dx, dz, gk, h) {
    if (f.wet) {
      const dr = M.exp(-2.6 * h);
      f.vs *= dr;
      f.vy = f.vy * dr - C.G * 0.55 * h;
    } else if (S.eow) {
      SS.eow.proj_acc(S, x, y, z, dx, dz, EG);
      f.vs += EG.s * gk * h;
      f.vy += EG.y * gk * h;
    } else f.vy -= C.G * gk * h;
  };
  // the point left the battlefield: more than margin m beyond the lattice of a world with a sea (a shell: FL.OOB), past
  // a dry world's far disc, or under the floor
  FL.out_of_field = function (S, x, z, y, margin) {
    const w = W();
    return (w.dry ? SS.spawn.arena_r(x, z) > C.DRY.FAR_R : x < -margin || z < -margin || x > w.SX + margin || z > w.SZ + margin)
      || y < 0.2;
  };
  // how a material takes a bouncing shell: sand, snow and ash soak the bounce up, ice is slick, the rest is 1
  FL.soft = mat => (mat === MAT.SNOW || mat === MAT.SAND || mat === MAT.ASH ? 0.55 : mat === MAT.ICE ? 1.15 : 1);
  /* the bounce of flight f off a surface (normal n, vn = the speed into it, < 0) of material mat (0: a body, not the
   * ground): restitution rest and friction fric by the material; a shell that is left slower than 0.8 m/s stops */
  FL.bounce = function (f, n, vn, mat, rest, fric) {
    const soft = FL.soft(mat), fr = mat === MAT.ICE ? 0.98 : fric * soft + 0.1 * (1 - soft);
    f.vs -= (1 + rest * soft) * vn * n.s;
    f.vy -= (1 + rest * soft) * vn * n.y;
    f.vs *= fr;
    f.vy *= fr;
    if (M.len2(f.vs, f.vy) < 0.8) {
      f.vs = 0;
      f.vy = 0;
    }
  };
  /* the homing missile's guidance, once a step (hm: its C.PROJ homing row): a lock phase (low gravity, little wind)
   * that
   * lasts longer the farther the target was at launch (dist0 / v0), then steering toward the target (ts, ty) at
   * hm.turn rad/s, blended in, with the speed growing by hm.accel up to hm.vmax for hm.fuel s, then a plain shell
   * again. (s, y): the shell; age: the time flown, this step included. Writes f.vs / vy and f.gk / wk. */
  FL.homing = function (f, hm, age, s, y, ts, ty, dist0, v0, dt) {
    const lock = M.clamp(dist0 / M.max(1, v0) * 0.5, hm.lock0, hm.lock1);
    if (age < lock) {
      f.gk = hm.gLock;
      f.wk = hm.windLock;
    }
    else if (age < lock + hm.fuel) {
      const blend = M.min(1, (age - lock) / hm.blend), want = M.atan2(ty - y, ts - s), cur = M.atan2(f.vy, f.vs);
      const da = M.clamp(M.wrap_angle(want - cur), -hm.turn * blend * dt, hm.turn * blend * dt),
        sp = M.min(hm.vmax, M.len2(f.vs, f.vy) + hm.accel * dt);
      f.vs = M.cos(cur + da) * sp;
      f.vy = M.sin(cur + da) * sp;
      f.gk = hm.gFly;
      f.wk = 0;
    } else {
      f.gk = 1;
      f.wk = 1;
    }
  };
  // a shell that did not punch through sea ice: it bounces (down faster than 1.5 m/s) or lies on it, and skids on
  FL.ice_skid = function (f, h) {
    f.vy = -f.vy > 1.5 ? -f.vy * 0.45 : 0;
    f.vs *= M.exp(-FL.ICE_SKID * h);
    if (Math.abs(f.vs) < 0.05) f.vs = 0;
  };
  /* the in-plane push of the local wind on flight f at (x, y, z) for one step dt (PoC stepProj L3396: wind x 230 px/s2
   * x
   * the shell's wind factor wk; PoC wind 1 = a storm's max ~ a 12 m/s gale here): the air velocity's component along
   * the plane (the shot never leaves its plane) and a little of its updraft; nothing under water or for wk 0 (the
   * bouncing shells, as in the PoC) */
  FL.wind = function (S, f, x, y, z, wk, dt) {
    if (!SS.weather || f.wet || !(wk > 0)) return;
    SS.weather.wind_at(S, x, y, z, WV);
    const d = SS.plane.dir(S), ws = WV.x * d.x + WV.z * d.z;
    f.vs += ws / C.WIND_UNIT * C.WIND_ACC * wk * dt;
    f.vy += (WV.y - f.vy) * C.WIND_GAIN * wk * dt * 0.04;
  };
  // the water entry of a shell that does not burst on it: it is under water and the water takes most of its speed
  FL.plunge = function (f) {
    f.wet = true;
    f.vs *= 0.35;
    f.vy *= 0.3;
  };
  /* a shell at (s, y) against a worm's soft body, a disc of radius rr about (ws, wy) on the plane: false when apart,
   * else the unit normal out of the body into n (straight up at its centre) */
  FL.worm_normal = function (ws, wy, s, y, rr, n) {
    const ds = s - ws, dy = y - wy, d2 = ds * ds + dy * dy;
    if (d2 >= rr * rr) return false;
    const d = Math.sqrt(d2);
    n.s = d > 1e-4 ? ds / d : 0;
    n.y = d > 1e-4 ? dy / d : 1;
    return true;
  };
  // the bounce of flight f off a worm's body (normal n, vn = the speed into it, < 0): the soft body absorbs most of it
  FL.worm_bounce = function (f, n, vn) {
    f.vs -= WORM_K * vn * n.s;
    f.vy -= WORM_K * vn * n.y;
    f.vs *= WORM_KEEP;
    f.vy *= WORM_KEEP;
  };

  /* ---------- the sim's step of the shells in flight ---------- */
  const P = SS.plane, sim = SS.sim, WM = SS.worm, DM = SS.damage, EV = C.EV, DS = C.DS;
  const LC = { sub: 0, heat: 0, surf: 0 }, NW = { s: 0, y: 1 };
  // what a phase of a sub-step hands on: go on with this sub-step, go to the next one, the shell is gone
  const GO = 0, NEXT = 1, GONE = 2;
  FL.remove = function (S, p) {
    const i = S.proj.indexOf(p);
    if (i >= 0) S.proj.splice(i, 1);
    S.lastBoom = S.time;
  };
  // a contact-fused shell meets a worm (the shooter's own worm is no target while the shell leaves it, 0.25 s)
  const hitWorm = (S, pt, p) => WM.first_near(S, pt.x, pt.y, pt.z, C.WORM_R + 0.12, p.age < 0.25 ? p.owner : -1, WM.NEAR.ANY);
  /* a thrown / bouncing shell (grenade, cluster, banana, holy, dynamite...) does not pass through a worm: it hits the
   * soft body (a disc of WORM_R + the shell's radius about w.pos, in the plane, worms within WORM_R of it), bounces off
   * with most of its speed absorbed and drops next to it; a hit faster than 3 m/s into the body costs the worm 1 HP,
   * once per shell and worm (p.hitW: bit mask of worm ids). Returns true on contact. */
  function wormBounce(S, p, def, ns, ny) {
    for (const w of S.worms) {
      if (w.dead || w.drowning || w.swim || (w.id === p.owner && p.age < 0.25)) continue;
      const q = P.to_plane(S, w.pos);
      if (Math.abs(q.t) > C.WORM_R) continue;
      const rr = C.WORM_R + (def.r || 0.06);
      if (!FL.worm_normal(q.s, w.pos.y, ns, ny, rr, NW)) continue;
      const ux = NW.s, uy = NW.y, vn = p.vs * ux + p.vy * uy;
      if (vn < 0) {
        FL.worm_bounce(p, NW, vn);
        p.bounces++;
        const bit = 1 << (w.id & 31);
        if (-vn > 3 && !((p.hitW | 0) & bit)) {
          p.hitW = (p.hitW | 0) | bit;
          const dd = P.dir(S);
          S.hitDir = { x: -ux * dd.x, y: -uy, z: -ux * dd.z };
          DM.hurt(
            S,
            w,
            1,
            def.hitDs != null ? def.hitDs : DS.PROJ_HIT,
            0,
            DM.weapon_name_id(p.type)
          );
        }
      }
      if (!P.solid2(S, q.s + ux * rr, w.pos.y + uy * rr)) {
        p.s = q.s + ux * rr;
        p.y = w.pos.y + uy * rr;
      }
      return true;
    }
    return false;
  }
  /* sea ice under a falling shell (before the water entry: the ice lies on the water). The speed INTO the ice decides
   * (punching work, SS.ice.impact): a fast, steep shell goes through (and goes off in the water under it), a gentle,
   * shallow or vertical slow drop does not: a rocket's contact fuse fires on the ice, a grenade bounces and skids on
   * (ice: next to no friction) */
  function ice(S, p, def, imp, ns, ny, wp, h) {
    if (!(SS.ice && S.ice && !p.wet && !p.subm && !p.pierced && p.vy < 0)) return GO;
    const it = SS.ice.top_at(S, wp.x, wp.z);
    if (!(it > -1e8 && ny < it && p.y >= it - 0.08)) return GO;
    if (SS.ice.impact(S, wp.x, wp.z, def.mass || 0.6, -p.vy)) {
      p.pierced = true;
      return GO;
    }
    if (imp) {
      SS.weapons.detonate(S, p, { x: wp.x, y: it + 0.05, z: wp.z });
      FL.remove(S, p);
      return GONE;
    }
    // a real bounce, or (slow) it lies on the ice and skids on
    if (-p.vy > 1.5) {
      if (p.vy < -2) sim.emit(S, EV.BOUNCE, { x: wp.x, y: it, z: wp.z, speed: -p.vy, mat: MAT.ICE });
      p.bounces++;
    }
    FL.ice_skid(p, h);
    p.y = it + 0.001; p.s = ns;
    return NEXT;
  }
  /* the water entry: the rocket's contact fuse fires on impact, a grenade plunges and keeps its fuse (homing flies on
   * through the water, foam builds an island at the surface, fire fizzles); a shell that punched through ice goes off
   * in the water under it */
  function water(S, p, def, wp, ny) {
    const surf = sim.surface_at(S, wp.x, wp.z);
    if (p.subm && ny > surf) p.subm = false;
    if (!(!p.wet && !p.subm && ny < surf && p.vy < 0)) return GO;
    sim.emit(S, EV.SPLASH, { x: wp.x, y: surf, z: wp.z, size: M.min(1.6, 0.4 + M.len2(p.vs, p.vy) * 0.05), proj: 1 });
    if (SS.water) SS.water.disturb(S, wp.x, wp.z, 0.6, -0.25 * M.min(1, M.len2(p.vs, p.vy) / 15));
    const r = SS.weapons.water(S, p, def, wp, surf);
    if (r === 'gone') {
      FL.remove(S, p);
      return GONE;
    }
    if (r === 'burst') {
      SS.weapons.detonate(S, p, {
        x: wp.x,
        y: surf - (p.pierced ? M.clamp(SS.water ? SS.water.depth(S, wp.x, wp.z) * 0.6 : 0.6, 0.2, 0.8) : 0.15),
        z: wp.z
      });
      FL.remove(S, p);
      return GONE;
    }
    if (def.impact) p.subm = true;
    else FL.plunge(p);
    return GO;
  }
  // open lava (2.6 t/m3, very viscous): the rocket's fuse fires on contact, a grenade floats on it and cooks off
  function lava(S, p, def, imp, ns, ny, wp, h) {
    if (!(SS.lava && S.lava)) return GO;
    const lp = sim.lava_contact(S, wp.x, ny, wp.z, LC);
    if (lp.sub > 0 && !p.lava && p.vy < 0) {
      sim.emit(S, EV.LAVAPLOP, { x: wp.x, y: lp.surf, z: wp.z, speed: M.len2(p.vs, p.vy) });
      if (def.foam || def.burst === C.BURST.FLAME || def.homing) {
        sim.emit(S, EV.STEAM, { x: wp.x, y: lp.surf, z: wp.z, power: 0.4 });
        FL.remove(S, p);
        return GONE;
      }
      if (imp) {
        SS.weapons.detonate(S, p, { x: wp.x, y: lp.surf, z: wp.z });
        FL.remove(S, p);
        return GONE;
      }
      p.lava = true; p.vs *= 0.15; p.vy = 0;
    }
    if (p.lava) {
      if (lp.sub <= -0.3) p.lava = false;                                  // drifted off / lava gone
      else {
        const k = M.exp(-8 * h);
        p.vs *= k;
        if (lp.sub > 0) {
          p.y = lp.surf;
          p.vy = M.max(0, p.vy) * k;
          p.hot += h * (0.4 + 1.6 * lp.heat);
          if (!P.solid2(S, ns, lp.surf)) p.s = ns;
          return NEXT;
        }
      }
    }
    return GO;
  }
  /* what the shell meets at (ns, ny): a contact-fused one bursts on the ground, a body, a worm (a crate it hits is
   * smashed), a bouncing one bounces off a worm's soft body, the ground or a body (the body is nudged; hard bounces
   * count for the bank shot), else it moves on */
  function contact(S, p, def, imp, ns, ny, wp) {
    const WP = SS.weapons;
    let bi = S.planeBodies.length ? P.body_at2(S, ns, ny, true) : -1;
    if (bi >= 0 && S.planeBodies[bi].ice) bi = -1;                       // (the ice is handled above)
    const solid = P.solid2(S, ns, ny);
    if (imp && SS.crates.hit(S, p, wp)) {
      FL.remove(S, p);
      return GONE;
    }
    if (imp) {
      if (solid || bi >= 0 || hitWorm(S, wp, p)) {
        WP.detonate(S, p, wp);
        FL.remove(S, p);
        return GONE;
      }
      p.s = ns;
      p.y = ny;
      return GO;
    }
    if (!def.foam && wormBounce(S, p, def, ns, ny)) return NEXT;
    if (solid || bi >= 0) {
      const nn = bi >= 0 ? P.body_normal2(S, bi, ns, ny) : P.normal2(S, ns, ny), vn = p.vs * nn.s + p.vy * nn.y;
      if (vn < 0) {
        const mat = solid ? W().mat_at(wp.x, wp.y, wp.z) : 0;
        if (vn < -2) sim.emit(S, EV.BOUNCE, { x: wp.x, y: wp.y, z: wp.z, speed: -vn, mat });
        FL.bounce(p, nn, vn, mat, def.rest != null ? def.rest : FL.REST, def.fric != null ? def.fric : FL.FRIC);
        p.bounces++;
        if (vn < -C.LAB.BANK_SPEED) p.bank++;
        if (bi >= 0 && SS.bodies) {
          const dd = P.dir(S);
          SS.bodies.nudge(
            S,
            SS.bodies.by_id(S, S.planeBodies[bi].body),
            { x: -dd.x * nn.s, y: -nn.y, z: -dd.z * nn.s },
            -vn * (def.mass || 0.6) * 1.4
          );
        }
        if (mat === MAT.LAVA) p.hot += 0.35;
      }
      if (P.blocked2(S, p.s, p.y)) {
        p.s += nn.s * 0.05;
        p.y += nn.y * 0.05;
      }
      return GO;
    }
    p.s = ns;
    p.y = ny;
    return GO;
  }
  /* the sub-steps of one step (at most 0.06 m each): gravity, then the battlefield's edge, a force field's dome (it
   * throws the shell off into a random 3D direction, out of the plane), sea ice, the water, open lava and what the
   * shell meets. Returns true when the shell is gone */
  function substeps(S, p, def, wp0, dt) {
    const gk = p.gk != null ? p.gk : 1, imp = !!def.impact && !(def.arm && p.age < def.arm);
    const ddx = M.cos(S.theta), ddz = M.sin(S.theta);               // (the plane direction for the field)
    const n = M.max(1, Math.ceil(M.len2(p.vs, p.vy) * dt / 0.06)), h = dt / n;
    for (let i = 0; i < n; i++) {
      FL.gravity(S, p, wp0.x, p.y, wp0.z, ddx, ddz, gk, h);
      const ns = p.s + p.vs * h, ny = p.y + p.vy * h, wp = P.to_world(S, ns, ny);
      if (FL.out_of_field(S, wp.x, wp.z, ny, FL.OOB)) {
        FL.remove(S, p);
        sim.log(S, `${C.WEAPONS[p.type].name} left the battlefield.`);
        return true;
      }
      if (S.ffields && S.ffields.length && SS.ffield.proj_hit(S, p, P.to_world(S, p.s, p.y), wp, def)) {
        FL.remove(S, p);
        return true;
      }
      let r = ice(S, p, def, imp, ns, ny, wp, h);
      if (r === NEXT) continue;
      if (r === GONE) return true;
      if (water(S, p, def, wp, ny) === GONE) return true;
      r = lava(S, p, def, imp, ns, ny, wp, h);
      if (r === NEXT) continue;
      if (r === GONE) return true;
      if (contact(S, p, def, imp, ns, ny, wp) === GONE) return true;
    }
    return false;
  }
  // a bouncing shell's fuse runs down; resting in lava cooks the charge off
  function fuse(S, p, def, dt) {
    if (!def.bouncy) return;
    p.fuse -= dt;
    const wpp = P.to_world(S, p.s, p.y);
    if (W().mat_at(wpp.x, p.y - 0.2, wpp.z) === MAT.LAVA) p.hot += dt;
    if (p.fuse <= 0 || p.hot > 0.5) {
      SS.weapons.detonate(S, p, P.to_world(S, p.s, p.y));
      FL.remove(S, p);
    }
  }
  /* one fixed step of every shell in flight: the weapon's specials first (homing steering, napalm airburst, the walking
   * sheep: weapons.js pre), the escape from every gravity well (space), the step's forces (the wind, the shell's own
   * drag), the sub-steps, the fuse */
  FL.step = function (S, dt) {
    const WP = SS.weapons;
    for (const p of S.proj.slice()) {
      if (S.proj.indexOf(p) < 0) continue;                      // (detonated by another one this step)
      p.age += dt;
      const def = C.PROJ[p.type] || C.WEAPONS[p.type];
      const pre = WP.pre(S, p, dt);
      if (pre === 'gone') {
        FL.remove(S, p);
        continue;
      }
      if (pre === true) continue;
      const wp0 = P.to_world(S, p.s, p.y);
      if (S.eow && SS.eow.proj_escape(S, p, dt)) {
        FL.remove(S, p);
        continue;
      }
      FL.wind(S, p, wp0.x, p.y, wp0.z, (def.windK != null ? def.windK : 1) * (p.wk != null ? p.wk : 1), dt);
      if (def.drag) {
        const dr = M.exp(-def.drag * dt);
        p.vs *= dr;
        p.vy *= dr;
      }
      if (!substeps(S, p, def, wp0, dt)) fuse(S, p, def, dt);
    }
  };
})(window.SS = window.SS || {});
