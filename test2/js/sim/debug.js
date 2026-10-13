/* sim/debug.js — P49: the debug toolbox's side of the simulation (portable, deterministic; no DOM / Three.js).
 *
 * A drop is an INPUT command: the platform fills the Input fields { dbk, dbp0, dbp1, dbs, dby, dbsky } for ONE step,
 * sim.step calls DB.apply(S, inp) at a fixed point (right after the input is sanitised) and the sim creates the object
 * through the same functions the game itself uses (SC.add, WP.crate_make, AL.spawn_*, GD.make_*, FF.make, sim.explode
 * ...). The sim never reads the UI. A drop is only applied while S.debugOn is set (platform: local / CPU matches and
 * the studio; never an online match), so replays and the instant-replay snapshot stay bit-identical and a hostile peer
 * cannot spawn anything.
 *
 *   dbk   drop kind (DB.KIND, 0 = none)      dbsky 1 = drop from the sky (props, crates) instead of at the clicked
 *         point
 *   dbp0, dbp1   kind parameters (below)     dbs, dby  the clicked point on the section plane (plane coordinates,
 *   metres)
 *   param use: CRATE_WEAPON p0 = index in C.CRATE_POOL; CRATE_TOOL p0 = index in DB.TOOLS; SNAKE p0 = HP (0 = default),
 *              p1 = size (0 = a newborn that grows up by itself); EXPLODE p0 = radius m; FIRE p0 = radius m; ACID p0 =
 * radius m; W_HP p0 = HP. C layout: enum DropKind { ... }; const char *DROP_NAME[]; the Input struct carries 6 numbers
 * (i8 / f32); no closures, no allocation beyond the spawned object.
 */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane;
  const DB = SS.debug = {};
  const KIND =
    DB.KIND = { NONE: 0, BARREL: 1, CRATE: 2, MINE: 3, BOULDER: 4, CAR: 5, FRIDGE: 6, VENDING: 7, PHONEBOOTH: 8, COLUMN: 9, OBELISK: 10,
      GIRDER: 11,
      CRATE_WEAPON: 20, CRATE_HEALTH: 21, CRATE_TOOL: 22, EGG: 30, EGG_HATCH: 31, HUGGER: 32, SNAKE: 33, SENTRY: 40, CLAYMORE: 41,
      FFIELD: 42,
      EXPLODE: 50, FIRE: 51, ACID: 52, W_TELEPORT: 60, W_HP: 61, W_KILL: 62, W_INFECT: 63 };
  const NAME = DB.NAME = {};
  NAME[KIND.BARREL] = 'barrel';
  NAME[KIND.CRATE] = 'wooden crate';
  NAME[KIND.MINE] = 'mine';
  NAME[KIND.BOULDER] = 'boulder';
  NAME[KIND.CAR] = 'car';
  NAME[KIND.FRIDGE] = 'fridge';
  NAME[KIND.VENDING] = 'vending machine';
  NAME[KIND.PHONEBOOTH] = 'phone booth';
  NAME[KIND.COLUMN] = 'column';
  NAME[KIND.OBELISK] = 'obelisk';
  NAME[KIND.GIRDER] = 'girder';
  NAME[KIND.CRATE_WEAPON] = 'weapon supply crate';
  NAME[KIND.CRATE_HEALTH] = 'health crate';
  NAME[KIND.CRATE_TOOL] = 'tool crate';
  NAME[KIND.EGG] = 'alien egg';
  NAME[KIND.EGG_HATCH] = 'alien egg about to hatch';
  NAME[KIND.HUGGER] = 'face hugger';
  NAME[KIND.SNAKE] = 'snake alien';
  NAME[KIND.SENTRY] = 'sentry gun';
  NAME[KIND.CLAYMORE] = 'claymore';
  NAME[KIND.FFIELD] = 'force field';
  NAME[KIND.EXPLODE] = 'explosion';
  NAME[KIND.FIRE] = 'fire patch';
  NAME[KIND.ACID] = 'acid pool';
  NAME[KIND.W_TELEPORT] = 'teleport of the active worm';
  NAME[KIND.W_HP] = 'worm HP';
  NAME[KIND.W_KILL] = 'worm kill';
  NAME[KIND.W_INFECT] = 'worm infection';
  const PROP_OF = {};
  PROP_OF[KIND.BARREL] = 'barrel';
  PROP_OF[KIND.CRATE] = 'crate';
  PROP_OF[KIND.MINE] = 'mine';
  PROP_OF[KIND.BOULDER] = 'boulder';
  PROP_OF[KIND.CAR] = 'car';
  PROP_OF[KIND.FRIDGE] = 'fridge';
  PROP_OF[KIND.VENDING] = 'vending';
  PROP_OF[KIND.PHONEBOOTH] = 'phonebooth';
  PROP_OF[KIND.COLUMN] = 'column';
  PROP_OF[KIND.OBELISK] = 'obelisk';
  PROP_OF[KIND.GIRDER] = 'girder';
  DB.TOOLS = ['freerot', 'laser', 'fastwalk', 'lowgrav', 'tinfoil', 'overload'];
  const SKY_LIFT = 22, PROP_LIFT = 1.2, PICK_R = 5;
  const W = () => SS.world;
  const r1 = v => Math.floor(v * 10 + 0.5) / 10;

  /* the sim only obeys a drop while this is set (the platform sets it for local matches, never online) */
  DB.enable = function (S, on) { S.debugOn = on ? 1 : 0; };

  /* the ground under the plane point (s, y): up out of rock first, then down to the first solid; null = none within the
   * map */
  function ground_at(S, s, y) {
    const w = W();
    let p = P.to_world(S, s, y), n = 0;
    while (w.sample(p.x, p.y, p.z) > 0 && n++ < 120) p.y += 0.25;
    if (p.y >= w.SY - 1 || w.outside(p.x, p.z)) return null;
    const gy = SS.weapons.ground_below(S, s, p.y);
    if (gy < -1e8) return null;
    return P.to_world(S, s, gy);
  }
  /* a point at the click, lifted out of rock (props and crates fall from there) or, with sky, high above the ground
   * there */
  function air_at(S, s, y, sky, lift) {
    const w = W();
    let p = P.to_world(S, s, y), n = 0;
    while (w.sample(p.x, p.y, p.z) > 0 && n++ < 120) p.y += 0.25;
    const g = ground_at(S, s, y);
    if (sky) p.y = M.min(w.SY - 1.5, (g ? g.y : p.y) + SKY_LIFT);
    else if (g && p.y < g.y + lift) p.y = g.y + lift;
    if (p.y >= w.SY - 1 || w.outside(p.x, p.z)) return null;
    return p;
  }
  function nearest_worm(S, s, y) {
    let best = null, bd = PICK_R;
    for (const w of S.worms) {
      if (w.dead || w.reserve) continue;
      const q = P.to_plane(S, w.pos), d = M.len2(q.s - s, w.pos.y - y);
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best;
  }
  function done(S, kind, s, y) {
    SS.sim.log(S, 'DEBUG: dropped ' + NAME[kind] + ' at s=' + r1(s) + ' y=' + r1(y), 0xffd27a);
    return true;
  }
  function fail(S, kind, why) {
    SS.sim.log(S, 'DEBUG: cannot drop ' + NAME[kind] + ': ' + why, 0xffb27a);
    return false;
  }

  /* apply one drop command; true when something was created / changed */
  DB.apply = function (S, inp) {
    const kind = inp.dbk | 0,
      s = inp.dbs,
      y = inp.dby,
      p0 = inp.dbp0,
      p1 = inp.dbp1,
      sky = inp.dbsky | 0,
      A = S.alien,
      K = SS.alien ? SS.alien.K : null;
    if (!S.debugOn || kind <= 0 || !NAME[kind] || !Number.isFinite(s) || !Number.isFinite(y)) return false;
    const team = S.active ? S.active.team : 0, owner = S.active ? S.active.id : -1;
    let p;
    if (PROP_OF[kind]) {
      p = air_at(S, s, y, sky, PROP_LIFT);
      if (!p) return fail(S, kind, 'no room there');
      SS.scatter.add(S, PROP_OF[kind], p, (S.tick % 628) * 0.01);
      return done(S, kind, s, y);
    }
    switch (kind) {
      case KIND.CRATE_WEAPON: case KIND.CRATE_HEALTH: case KIND.CRATE_TOOL: {
        const tool = kind === KIND.CRATE_TOOL;
        if (!SS.weapons.crate_room(S, tool)) return fail(S, kind, 'too many crates in the air');
        p = air_at(S, s, y, sky, 6);
        if (!p) return fail(S, kind, 'no room there');
        const wk = C.CRATE_POOL[M.clamp(p0 | 0, 0, C.CRATE_POOL.length - 1)], tk = DB.TOOLS[M.clamp(p0 | 0, 0, DB.TOOLS.length - 1)];
        S.crates.push(
          SS.weapons.crate_make(
            S,
            tool ? 'tool' : kind === KIND.CRATE_HEALTH ? 'health' : 'weapon',
            kind === KIND.CRATE_WEAPON ? wk : null,
            tool ? tk : null,
            p
          )
        );
        return done(S, kind, s, y);
      }
      case KIND.EGG: case KIND.EGG_HATCH: {
        p = ground_at(S, s, y);
        if (!p || !A || !K) return fail(S, kind, 'no ground there');
        if (A.eggs.length >= K.MAX_EGG) return fail(S, kind, 'too many eggs');
        const e = { id: A.nextId++, x: p.x, y: p.y, z: p.z, yaw: (S.tick % 628) * 0.01, st: 0, t0: 0, vy: 0 };
        if (kind === KIND.EGG_HATCH) {
          e.st = 1;
          e.t0 = S.time - (K.OPEN_T - 4);
        }
        A.eggs.push(e); return done(S, kind, s, y);
      }
      case KIND.HUGGER: {
        p = ground_at(S, s, y);
        if (!p || !A) return fail(S, kind, 'no ground there');
        return SS.alien.spawn_hugger(S, p.x, p.y + 0.1, p.z, 1) ? done(S, kind, s, y) : fail(S, kind, 'too many huggers');
      }
      case KIND.SNAKE: {
        p = ground_at(S, s, y);
        if (!p || !A) return fail(S, kind, 'no ground there');
        const X = SS.alien.spawn_xeno(S, p.x, p.y + 0.15, p.z, p0 > 0 ? p0 : 0);
        if (!X) return fail(S, kind, 'too many aliens');
        // a grown snake of that size (p1 = 0: a newborn that grows, the game's own birth)
        if (p1 > 0) {
          X.st = 0;
          X.size = p1;
          X.hiss = S.time + 0.4;
        }
        return done(S, kind, s, y);
      }
      case KIND.SENTRY: case KIND.CLAYMORE: {
        p = ground_at(S, s, y);
        if (!p) return fail(S, kind, 'no ground there');
        p.y += kind === KIND.SENTRY ? 0.35 : 0.05;
        if (kind === KIND.SENTRY) SS.gadgets.make_sentry(S, team, owner, p);
        else SS.gadgets.make_claymore_ground(S, team, owner, p, S.active && S.active.facing < 0 ? -1 : 1);
        return done(S, kind, s, y);
      }
      case KIND.FFIELD: {
        p = ground_at(S, s, y);
        if (!p) return fail(S, kind, 'no ground there');
        p.y += 0.1; SS.ffield.make(S, team, owner, p); return done(S, kind, s, y);
      }
      case KIND.EXPLODE: {
        p = P.to_world(S, s, y);
        const R = M.clamp(p0 > 0 ? p0 : 3, 0.5, 40);
        SS.sim.explode(S, p, { W: M.pow(R / 3, 3), dmg: 50, name: 'a debug blast' }, null); return done(S, kind, s, y);
      }
      case KIND.FIRE: {
        p = ground_at(S, s, y);
        if (!p) return fail(S, kind, 'no ground there');
        SS.weapons.fire_patch(S, p, M.clamp(p0 > 0 ? p0 : 1.6, 0.4, 8)); return done(S, kind, s, y);
      }
      case KIND.ACID: {
        p = ground_at(S, s, y);
        if (!p || !A || !K) return fail(S, kind, 'no ground there');
        if (A.acid.length >= K.MAX_ACID) return fail(S, kind, 'too many acid pools');
        A.acid.push({
          x: p.x,
          y: p.y + 0.05,
          z: p.z,
          vx: 0,
          vy: 0,
          vz: 0,
          st: 1,
          t0: S.time,
          life: K.ACID_LIFE,
          r: M.clamp(p0 > 0 ? p0 : K.ACID_R0, 0.2, 0.8),
          depth: 0,
          tick: S.time
        });
        return done(S, kind, s, y);
      }
      case KIND.W_TELEPORT: {
        const a = S.active;
        if (!a || a.dead) return fail(S, kind, 'no active worm');
        p = ground_at(S, s, y);
        if (!p) return fail(S, kind, 'no ground there');
        if (!SS.sim.in_play(S, p.x, p.z)) return fail(S, kind, 'out of the play area');
        a.pos.x = p.x;
        a.pos.y = p.y + 0.55;
        a.pos.z = p.z;
        a.vs = 0;
        a.vy = 0;
        a.air = true;
        a.rest = false;
        S.rope = null;
        if (a.vel) {
          a.vel.x = 0;
          a.vel.y = 0;
          a.vel.z = 0;
        }
        return done(S, kind, s, y);
      }
      default: break;
    }
    const w = nearest_worm(S, s, y);
    if (!w) return fail(S, kind, 'no worm within ' + PICK_R + ' m');
    if (kind === KIND.W_HP) {
      w.hp = M.clamp(p0 | 0, 1, 999);
      return done(S, kind, s, y);
    }
    if (kind === KIND.W_KILL) {
      SS.sim.hurt(S, w, w.hp + 1000, C.DS.BLAST, 0);
      return done(S, kind, s, y);
    }
    if (kind === KIND.W_INFECT && K) {
      if (w.embryo) return fail(S, kind, 'already infected');
      w.hug = -1;
      w.embryo = true;
      w.embT = S.time;
      w.embNext = S.time + K.PARA_T;
      return done(S, kind, s, y);
    }
    return false;
  };
})(window.SS = window.SS || {});
