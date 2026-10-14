/* sim/sim.js — the orchestration of a game: create, reset (begin_reset, reset_step), the fixed step (step) that drives
 * every subsystem in a fixed order, the event queue (emit, log, the pools), scheduled explosions (explode, schedule)
 * and the shells in flight (stepProjectiles; a later round moves them to their own flight module).
 *
 * Contract (C-style):
 *   GameState* S = sim_create();
 *   job = sim_begin_reset(S, &settings); while (sim_reset_step(S, job) < 1) {...progress bar...}
 *   each fixed step: sim_step(S, const Input* in, STEP);
 *   presentation reads S and drains S.events[] (explosions, splashes, lightning, collapses ...).
 * The rules live in the sim core files (state, spawn, damage, swim, worm, turn) and the subsystems (blast, bodies,
 * collapse, water, veg, weather, lava ...), each a module of plain functions over S. All randomness comes from S.rng
 * (deterministic, so a host can be the authoritative judge in multiplayer and clients can re-simulate). */
(function (SS) {
  'use strict';
  const sim = SS.sim;
  const C = SS.CFG;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const M = SS.math;
  const P = SS.plane;
  const MAT = C.MAT;
  const W = SS.world;
  const DRY = C.DRY;
  const DS = C.DS;
  const lc = { sub: 0, heat: 0, surf: 0 };
  const ST = SS.state;
  const SP = SS.spawn;
  const DM = SS.damage;
  const SW = SS.swim;
  const WM = SS.worm;
  const TN = SS.turn;

  /* ---------- events for presentation ---------- */
  function emit(S, type, data) {
    data.type = type;
    data.t = S.time;
    S.events.push(data);
    return data;
  }
  function log(S, text, rgb) {
    S.log.unshift({ text, rgb: rgb == null ? 0xdfe8f1 : rgb, t: S.time });
    if (S.log.length > 7) S.log.length = 7;
  }
  sim.emit = emit; sim.log = log;
  /* push with a cap (C.LIMITS): a full list drops its oldest entry first. Returns the item. */
  sim.pool_push = function (list, cap, item) {
    if (list.length >= cap) list.shift();
    list.push(item);
    return item;
  };
  /* Presentation helper (NOT used by the sim): events name worms by id (`wormId`, `victimId`, `pushes[].wormId`: i16,
   * -1 = none). The view code (render / audio / ui)
   * is written against worm objects, so main loop's event dispatch resolves the ids once per event: e.worm / e.victim /
   * e.pushes[].worm. In an engine port this is the lookup `Worm *w = &S.worms[e.wormId]` at the top of each handler. */
  sim.event_bind = function (S, e) {
    if (e.wormId !== undefined) e.worm = e.wormId >= 0 ? S.worms[e.wormId] : null;
    if (e.victimId !== undefined) e.victim = e.victimId >= 0 ? S.worms[e.victimId] : null;
    if (e.pushes)
      for (let i = 0; i < e.pushes.length; i++) e.pushes[i].worm = S.worms[e.pushes[i].wormId];
    return e;
  };

  sim.create = function () {
    return {
      debugOn: 0,
      events: [],
      log: [],
      worms: [],
      bodies: [],
      trees: [],
      proj: [],
      pending: [],
      planeBodies: [],
      flames: [],
      fx: [],
      frags: [],
      spat: [],
      stats: { slabBuilds: 0 },
      rng: M.rng_make(1),
      settings: Object.assign({}, C.SETTINGS)
    };
  };
  /* immersion of a body in open lava: depth of its bottom under the lava surface (m, <= 0 = not in lava) and heat
   * 0..1 */
  sim.lava_contact = function (S, x, bottom, z, out) {
    out.sub = 0; out.heat = 0;
    if (!SS.lava || !S.lava) return out;
    const ls = SS.lava.surface_at(S, x, z);
    if (ls < 0 || bottom < W.top_at(x, z) - 0.5) return out;          // under the column's bed: a cave under rock, not lava
    out.sub = ls - bottom; out.surf = ls;
    out.heat = M.clamp((SS.lava.temp_at(S, x, z) - C.LAVA.T_SOLID) / 0.4, 0, 1);
    return out;
  };

  /* Resumable reset (drives the loading progress bar): world generation, then subsystems, then actors. */
  // the settings a game runs with: the defaults under the given ones, the seed as an i32 (every seed mix is Math.imul /
  // u32 wrap-around, identical in C; ?seed= and net settings are unbounded), the Lab mask limited to the defined flags
  // (whatever path the settings came by: URL, menu, a host's start message), space never sliced and without forts
  function normalizeSettings(given) {
    const st = Object.assign({}, C.SETTINGS, given);
    if (typeof st.seed !== 'number' || st.seed !== (st.seed | 0)) st.seed = st.seed | 0;
    st.labFlags = (st.labFlags | 0) & C.LAB.ALL;
    // (space: floating chunks with their own layout)
    if (st.biome === 'eow') {
      st.dim = '3d';
      st.fort = false;
    }
    return st;
  }
  sim.begin_reset = function (S, settings) {
    S.settings = normalizeSettings(settings || S.settings);
    return { stage: 0, gen: W.gen_begin(S.settings), label: 'Shaping the land' };
  };
  /* the world alone, exactly as the first stage of a reset builds it (terrain, materials, features, the sea level) for
   * these settings, without a game state: tools and the port compare worlds with it. Returns the normalised settings.
   * C: void generate_world(const Settings*, Settings* out). */
  sim.generate_world = function (settings) {
    const st = normalizeSettings(settings), gen = W.gen_begin(st);
    while (W.gen_step(gen) < 1);
    return st;
  };
  sim.reset_step = function (S, job) {
    if (job.stage === 0) {
      const p = W.gen_step(job.gen);
      job.label = job.gen.label;
      if (p >= 1) {
        job.stage = 1;
        job.label = 'Water, weather and wildlife';
      }
      return 0.85 * p;
    }
    if (job.stage === 1) {
      ST.init_state(S);
      job.stage = 2;
      job.label = 'Ready';
      return 1;
    }
    return 1;
  };
  sim.reset = function (S, settings) {
    const job = sim.begin_reset(S, settings);
    while (sim.reset_step(S, job) < 1);
  };


  /* ninja rope, parachute, zipline: sim/traverse.js. Thin delegates keep the old API for tools and tests. */
  sim.shoot_rope = S => SS.traverse.rope_fire(S);
  sim.hook_resolve = S => SS.traverse.hook_resolve(S);
  sim.ROPE_TUNE = SS.CFG.TRAV ? SS.CFG.TRAV.ROPE : null;

  /* fire the charged weapon (UI, AI, timer); every weapon goes through sim/weapons.js */
  sim.fire = function (S, power) { return SS.weapons.use(S, power); };

  /* ---------- projectiles: confined to the attack plane until they explode ---------- */
  // (the shooter's own worm is no target while the shell leaves it, 0.25 s)
  const hitWorm = (S, pt, p) => WM.first_near(S, pt.x, pt.y, pt.z, C.WORM_R + 0.12, p.age < 0.25 ? p.owner : -1, WM.NEAR.ANY);
  /* a thrown / bouncing shell (grenade, cluster, banana, holy, dynamite...) does not pass through a worm: it hits
   * the soft body (a disc of WORM_R + the shell's radius about w.pos, in the plane, worms within WORM_R of it), bounces
   * off with most of its speed absorbed (restitution 0.15, then x0.5) and drops next to it; a hit faster than 3 m/s
   * into the body costs the worm 1 HP, once per shell and worm (p.hitW: bit mask of worm ids). Returns true on
   * contact. */
  function wormBounce(S, p, def, ns, ny) {
    for (const w of S.worms) {
      if (w.dead || w.drowning || w.swim || (w.id === p.owner && p.age < 0.25)) continue;
      const q = P.to_plane(S, w.pos);
      if (Math.abs(q.t) > C.WORM_R) continue;
      const rr = C.WORM_R + (def.r || 0.06), ds = ns - q.s, dy = ny - w.pos.y, d2 = ds * ds + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2), ux = d > 1e-4 ? ds / d : 0, uy = d > 1e-4 ? dy / d : 1, vn = p.vs * ux + p.vy * uy;
      if (vn < 0) {
        p.vs -= 1.15 * vn * ux;
        p.vy -= 1.15 * vn * uy;
        p.vs *= 0.5;
        p.vy *= 0.5;
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
            p.type === 'napalm' ? DS.PROJ_NAPALM : p.type === 'acid' ? DS.PROJ_ACID : p.type === 'gas' ? DS.PROJ_GAS : DS.PROJ_HIT,
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
  function removeProj(S, p) {
    const i = S.proj.indexOf(p);
    if (i >= 0) S.proj.splice(i, 1);
    S.lastBoom = S.time;
  }
  sim.surface_at = (S, x, z) => (SS.water && S.water ? SS.water.surface(S, x, z) : W.SEA);
  const wv = { x: 0, y: 0, z: 0 }, eg = { s: 0, y: 0 };
  function stepProjectiles(S, dt) {
    const w = W;
    const WP = SS.weapons;
    for (const p of S.proj.slice()) {
      if (S.proj.indexOf(p) < 0) continue;                      // (detonated by another one this step)
      p.age += dt;
      const def = C.PROJ[p.type] || C.WEAPONS[p.type];
      // specials first (homing steering, napalm airburst, the walking sheep)
      const pre = WP.pre(S, p, dt);
      if (pre === 'gone') {
        removeProj(S, p);
        continue;
      }
      if (pre === true) continue;
      const wp0 = P.to_world(S, p.s, p.y);
      // left every gravity well
      if (S.eow && SS.eow.proj_escape(S, p, dt)) {
        removeProj(S, p);
        continue;
      }
      // wind (PoC stepProj L3396: a push of wind x 230 px/s2 x the shell's wind factor; PoC wind 1 = a storm's max ~
      // a 12 m/s gale here): in-plane component of the local air velocity only (the shot never leaves its plane); the
      // bouncing shells take no wind (windK 0), as in the PoC; whirlwind updrafts still lift a little
      const wk = (def.windK != null ? def.windK : 1) * (p.wk != null ? p.wk : 1);
      if (SS.weather && !p.wet && wk > 0) {
        SS.weather.wind_at(S, wp0.x, p.y, wp0.z, wv);
        const d = P.dir(S), ws = wv.x * d.x + wv.z * d.z;
        p.vs += ws / C.WIND_UNIT * C.WIND_ACC * wk * dt; p.vy += (wv.y - p.vy) * C.WIND_GAIN * wk * dt * 0.04;
      }
      if (def.drag) {
        const dr = M.exp(-def.drag * dt);
        p.vs *= dr;
        p.vy *= dr;
      }
      const gk = p.gk != null ? p.gk : 1, imp = !!def.impact && !(def.arm && p.age < def.arm);
      const ddx = M.cos(S.theta), ddz = M.sin(S.theta);               // (the plane direction for the field)
      const n = M.max(1, Math.ceil(M.len2(p.vs, p.vy) * dt / 0.06)), h = dt / n;
      let done = false;
      for (let i = 0; i < n && !done; i++) {
        if (p.wet) {
          const dr = M.exp(-2.6 * h);
          p.vs *= dr;
          p.vy = p.vy * dr - C.G * 0.55 * h;
        }
        // the summed chunk fields
        else if (S.eow) {
          SS.eow.proj_acc(S, wp0.x, p.y, wp0.z, ddx, ddz, eg);
          p.vs += eg.s * gk * h;
          p.vy += eg.y * gk * h;
        }
        else p.vy -= C.G * gk * h;
        const ns = p.s + p.vs * h, ny = p.y + p.vy * h, wp = P.to_world(S, ns, ny);
        if (
          (
            w.dry
            ? SP.arena_r(wp.x, wp.z) > DRY.FAR_R
            : wp.x < -OOB_SEA || wp.z < -OOB_SEA || wp.x > w.SX + OOB_SEA || wp.z > w.SZ + OOB_SEA
          )
          || ny < 0.2
        ) {
          removeProj(S, p);
          log(S, `${C.WEAPONS[p.type].name} left the battlefield.`);
          done = true;
          break;
        }
        // a force field's dome throws the shell off into a random 3D direction (it leaves the plane)
        if (S.ffields && S.ffields.length && SS.ffield.proj_hit(S, p, P.to_world(S, p.s, p.y), wp, def)) {
          removeProj(S, p);
          done = true;
          break;
        }
        // dry worlds (D4): beyond the lattice W.sample is the analytic far dunes, so shots bounce / hit there as inside
        // sea ice over the water. The speed INTO the ice decides (punching work, SS.ice.impact): a fast,
        // steep shell goes through (and goes off in the water under it), a gentle, shallow or vertical slow drop does
        // not: a rocket's contact fuse fires on the ice, a grenade bounces and skids on (ice: next to no friction)
        if (SS.ice && S.ice && !p.wet && !p.subm && !p.pierced && p.vy < 0) {
          const it = SS.ice.top_at(S, wp.x, wp.z);
          if (it > -1e8 && ny < it && p.y >= it - 0.08) {
            if (SS.ice.impact(S, wp.x, wp.z, def.mass || 0.6, -p.vy)) p.pierced = true;
            else if (imp) {
              WP.detonate(S, p, { x: wp.x, y: it + 0.05, z: wp.z });
              removeProj(S, p);
              done = true;
              break;
            }
            else {
              // a real bounce, or (slow) it lies on the ice and skids on: next to no friction
              if (-p.vy > 1.5) {
                if (p.vy < -2) emit(S, EV.BOUNCE, { x: wp.x, y: it, z: wp.z, speed: -p.vy, mat: MAT.ICE });
                p.vy = -p.vy * 0.45;
                p.bounces++;
              }
              else p.vy = 0;
              p.vs *= M.exp(-ICE_SKID * h);
              if (Math.abs(p.vs) < 0.05) p.vs = 0;
              p.y = it + 0.001; p.s = ns;
              continue;
            }
          }
        }
        const surf = sim.surface_at(S, wp.x, wp.z);
        if (p.subm && ny > surf) p.subm = false;
        if (!p.wet && !p.subm && ny < surf && p.vy < 0) {
          // water entry: the rocket's contact fuse fires on impact, a grenade plunges and keeps its fuse (homing
          // flies on through the water, foam builds an island at the surface, fire fizzles)
          emit(S, EV.SPLASH, { x: wp.x, y: surf, z: wp.z, size: M.min(1.6, 0.4 + M.len2(p.vs, p.vy) * 0.05), proj: 1 });
          if (SS.water) SS.water.disturb(S, wp.x, wp.z, 0.6, -0.25 * M.min(1, M.len2(p.vs, p.vy) / 15));
          const r = WP.water(S, p, def, wp, surf);
          if (r === 'gone') {
            removeProj(S, p);
            done = true;
            break;
          }
          // (a shell that punched through ice goes off in the water under it)
          if (r === 'burst') {
            WP.detonate(S, p, {
              x: wp.x,
              y: surf - (p.pierced ? M.clamp(SS.water ? SS.water.depth(S, wp.x, wp.z) * 0.6 : 0.6, 0.2, 0.8) : 0.15),
              z: wp.z
            });
            removeProj(S, p);
            done = true;
            break;
          }
          if (def.impact) p.subm = true;
          else {
            p.wet = true;
            p.vs *= 0.35;
            p.vy *= 0.3;
          }
        }
        // open lava (2.6 t/m3, very viscous): the rocket's fuse fires on contact, a grenade floats on it and cooks off
        if (SS.lava && S.lava) {
          const lp = sim.lava_contact(S, wp.x, ny, wp.z, lc);
          if (lp.sub > 0 && !p.lava && p.vy < 0) {
            emit(S, EV.LAVAPLOP, { x: wp.x, y: lp.surf, z: wp.z, speed: M.len2(p.vs, p.vy) });
            if (def.foam || def.flame || def.homing) {
              emit(S, EV.STEAM, { x: wp.x, y: lp.surf, z: wp.z, power: 0.4 });
              removeProj(S, p);
              done = true;
              break;
            }
            if (imp) {
              WP.detonate(S, p, { x: wp.x, y: lp.surf, z: wp.z });
              removeProj(S, p);
              done = true;
              break;
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
                continue;
              }
            }
          }
        }
        let bi = S.planeBodies.length ? P.body_at2(S, ns, ny, true) : -1;
        if (bi >= 0 && S.planeBodies[bi].ice) bi = -1;            // Step I: the ice is handled above (before the water entry)
        const solid = P.solid2(S, ns, ny);
        if (imp && WP.crate_hit(S, p, wp)) {
          removeProj(S, p);
          done = true;
          break;
        }
        if (imp) {
          if (solid || bi >= 0 || hitWorm(S, wp, p)) {
            WP.detonate(S, p, wp);
            removeProj(S, p);
            done = true;
          }
          else {
            p.s = ns;
            p.y = ny;
          }
        } else if (!def.foam && wormBounce(S, p, def, ns, ny)) {
          continue;
        } else if (solid || bi >= 0) {
          const nn = bi >= 0 ? P.body_normal2(S, bi, ns, ny) : P.normal2(S, ns, ny), vn = p.vs * nn.s + p.vy * nn.y;
          if (vn < 0) {
            const mat = solid ? w.mat_at(wp.x, wp.y, wp.z) : 0;
            const soft = mat === MAT.SNOW || mat === MAT.SAND || mat === MAT.ASH ? 0.55 : mat === MAT.ICE ? 1.15 : 1;
            if (vn < -2) emit(S, EV.BOUNCE, { x: wp.x, y: wp.y, z: wp.z, speed: -vn, mat });
            const rest = def.rest != null ? def.rest : 0.4, fric = def.fric != null ? def.fric : 0.9;
            p.vs -= (1 + rest * soft) * vn * nn.s; p.vy -= (1 + rest * soft) * vn * nn.y;
            const fr = mat === MAT.ICE ? 0.98 : fric * soft + 0.1 * (1 - soft);
            // (hard bounces, the bank shot)
            p.vs *= fr;
            p.vy *= fr;
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
            if (M.len2(p.vs, p.vy) < 0.8) {
              p.vs = 0;
              p.vy = 0;
            }
            if (mat === MAT.LAVA) p.hot += 0.35;
          }
          if (P.blocked2(S, p.s, p.y)) {
            p.s += nn.s * 0.05;
            p.y += nn.y * 0.05;
          }
        } else {
          p.s = ns;
          p.y = ny;
        }
      }
      if (done) continue;
      if (def.bouncy) {
        p.fuse -= dt;
        // resting in lava cooks the charge off
        const wpp = P.to_world(S, p.s, p.y);
        if (w.mat_at(wpp.x, p.y - 0.2, wpp.z) === MAT.LAVA) p.hot += dt;
        if (p.fuse <= 0 || p.hot > 0.5) {
          WP.detonate(S, p, P.to_world(S, p.s, p.y));
          removeProj(S, p);
        }
      }
    }
  }

  /* Explosion entry point. wp: weapon def ({W} TNT-equivalent kg; legacy {R} accepted). */
  sim.explode = function (S, c, wp, ownerId) {
    let Wkg = wp.W != null ? wp.W : M.pow((wp.R || 3) / 3, 3);
    if (SS.lab) Wkg = SS.lab.blast_w(S, Wkg, ownerId);              // the RADIUS perk
    // a blast inside a force field is contained
    const Wfull = Wkg, ffx = SS.ffield && S.ffields && S.ffields.length ? SS.ffield.contain_pre(S, c, Wkg, wp) : null;
    if (ffx) Wkg = ffx.W;
    S.lastBoom = S.time;
    S.lastExplosion = { x: c.x, y: c.y, z: c.z, R: 3 * M.cbrt(Wkg) };
    S.lastBlastW = Wkg;
    S.lastBlastT = S.time;
    let ev;
    if (SS.blast)
      ev = SS.blast.explode(S, c, Wkg, { owner: ownerId, kind: wp.name || 'blast', dmg: wp.dmg, boom: wp.boom || 0, push: wp.push });
    else {
      W.carve(c.x, c.y, c.z, 3 * M.cbrt(Wkg));
      ev = emit(S, EV.EXPLODE, { x: c.x, y: c.y, z: c.z, R: 3 * M.cbrt(Wkg), W: Wkg });
    }
    S.sectionDirty = true;
    sim.pool_push(S.fx, C.LIMITS.FX, { x: c.x, y: c.y, z: c.z, t: 0 });
    if (SS.weapons) SS.weapons.blast(S, c, Wkg, wp.dmg);          // devices, supply crates
    if (wp.frag && SS.shrapnel) SS.shrapnel.spawn(S, c, Wkg);       // X2: casing fragments (grenade, bazooka)
    if (ffx) SS.ffield.contain_post(S, c, Wfull, wp, ffx);
    return ev;
  };
  /* schedule a delayed explosion (chain reactions: barrels, mines) */
  sim.schedule = function (S, delay, c, Wkg, kind, src, dmg) {
    sim.pool_push(S.pending, C.LIMITS.PENDING, { t: S.time + delay, c: M.v3_copy(c), W: Wkg, kind, src, dmg });
    S.lastBoom = S.time;
  };
  /* on wet worlds a shot flies on over the open sea (beyond the lattice the world samples as air, the sea surface
   * is W.SEA) and splashes / blasts in the water like inside; it is dropped only this far out (it was 6 m: shells
   * vanished just off the coast without a splash) */
  const OOB_SEA = 120;
  const ICE_SKID = 0.25;
  const NOINPUT = ST.input_make();
  /* ---------- main fixed step ---------- */
  sim.step = function (S, inp, dt) {
    S.tick++; S.time += dt;       // tick: the integer step count (stagger keys, once-per-step guards; exact in a port)
    let a = S.active;
    // the human's input keeps its debug drop even when a CPU worm's plan replaces `inp` below
    const dbgInp = inp;
    // 9a: a CPU team's worm is driven by sim/ai.js (deterministic; the human input is ignored on its turn)
    // (a cleared Input struct, filled by the plan)
    if (S.phase === PHASE.PLAY && a && !a.dead && SS.ai && SS.game.is_cpu(S, a.team)) inp = SS.ai.control(S, a, dt);
    ST.sanitize_input(inp);
    if (inp.reset) {
      sim.reset(S, S.settings);
      return;
    }
    if (inp.gear && SS.gear) SS.gear.input(S, inp);               // the rescue gear toggle (HUD button / key)
    // the debug toolbox's drop (only while S.debugOn)
    if (dbgInp.dbk && SS.debug) {
      if (dbgInp !== inp) ST.sanitize_input(dbgInp);
      SS.debug.apply(S, dbgInp);
    }
    if (S.phase === PHASE.PERK && SS.lab) {                           // the perk draft (a pick may start the first turn)
      SS.lab.perk_step(S, inp, dt); a = S.active;
      // (the key / click that picked a card (1 / 2 / 3 are weapon keys too) is spent: it must not also act in the
      // first turn that the last pick starts)
      inp.weapon = '';
      inp.fuse = 0;
      inp.adj = 0;
      inp.fire_pressed = 0;
      inp.fire_held = 0;
      inp.jump = 0;
      inp.backflip = 0;
      inp.end_turn = 0;
      inp.wsel = 0;
      inp.drop = 0;
    }
    if (S.phase === PHASE.PLACE) {                                    // deployment (the world runs, worms are placed)
      if (inp.rotate || inp.rotate_mouse) TN.rotate_by(S, (inp.rotate + inp.rotate_mouse) * (inp.fine ? 0.25 : 1) * C.ROT_SPEED * dt);
      SS.game.place_step(S, inp, dt);                             // (the world steps below; control needs 'play')
    }
    if (S.phase === PHASE.PLAY && a && !a.dead) {
      if (inp.align_step) TN.align_next(S, inp.align_step);
      if (inp.align_crate) TN.align_crate(S);
      if (inp.align_refocus) TN.align_to(S, S.target);
      if (inp.align_id) TN.align_to(S, S.worms.find(w => w.id === inp.align_id - 1));
      if (inp.end_turn) {
        log(S, `${a.name} ends the turn.`);
        TN.end_turn(S, 0.3);
      }
      // re-read the active worm after a switch: the old one must not be driven in the new worm's section (its
      // plane (s, y) mapped onto the new plane teleported it tens of metres, into a river on volcanic 6721)
      if (inp.wsel && TN.switch_worm(S)) a = S.active;
    } else if (inp.align_step || inp.align_crate || inp.align_refocus || (inp.rotate && S.phase !== PHASE.OVER)) TN.locked(S);
    let rot = 0;
    if (S.phase === PHASE.PLAY) rot = inp.rotate + inp.rotate_mouse;
    if (S.thetaGoal != null && S.phase === PHASE.PLAY) {
      const diff = M.wrap_angle(S.thetaGoal - S.theta), st = C.ALIGN_SPEED * dt;
      // (window edge, D6)
      if (Math.abs(diff) <= st) {
        TN.rotate_by(S, diff);
        S.thetaGoal = null;
      } else if (!TN.rotate_by(S, Math.sign(diff) * st)) S.thetaGoal = null;
    }
    if (rot) {
      S.thetaGoal = null;
      TN.rotate_by(S, rot * (inp.fine ? 0.25 : 1) * C.ROT_SPEED * dt);
    }

    // world subsystems
    if (SS.weather) SS.weather.step(S, dt);
    if (SS.lab) SS.lab.step(S, dt);                               // wind gusts, meteor impacts
    if (SS.bodies) SS.bodies.plane_sections(S);
    if (SS.trees) SS.trees.plane_sections(S);
    if (SS.struct) SS.struct.plane_sections(S);
    if (SS.ice) SS.ice.plane_sections(S);
    // PoC worm-worm contacts: the other worms near the section are solid discs for the active worm (it is blocked by
    // them, stands on them, climbs over them, lands on their heads); projectiles ignore these discs (worm hits are
    // their own test)
    for (const o of S.worms) {
      if (o.dead || o === S.active || o.drowning || o.swim) continue;
      const q = P.to_plane(S, o.pos);
      if (Math.abs(q.t) > C.WORM_R) continue;
      P.pb_add(S.planeBodies, 0, q.s, o.pos.y, 0, 0, C.WORM_R, -1, -1, -1, -1, o.id, false);
    }
    WM.unpin_others(S);                                               // a prop on a worm that is not under control
    if (S.phase === PHASE.PLAY && a && !a.dead && !a.swim) WM.control_active(S, a, dt, inp, false);
    else if (S.phase === PHASE.ATTACK && S.retreatT > 0 && a && !a.dead && !a.swim && !S.dig)
      WM.control_active(
        S,
        a,
        dt,
        SS.game.is_cpu(S, a.team) ? (SS.ai && SS.ai.retreat ? SS.ai.retreat(S, a, NOINPUT) : NOINPUT) : inp,
        true
      );
    // a worm afloat in a life jacket is a playable worm
    else if (
      a && !a.dead && a.swim && a.swim.jk && SS.jacket && (S.phase === PHASE.PLAY || (S.phase === PHASE.ATTACK && S.retreatT > 0 && !S.dig))
    ) {
      if (S.phase === PHASE.PLAY) SS.jacket.control(S, a, dt, inp, false);
      else
        SS.jacket.control(
          S,
          a,
          dt,
          SS.game.is_cpu(S, a.team) ? (SS.ai && SS.ai.retreat ? SS.ai.retreat(S, a, NOINPUT) : NOINPUT) : inp,
          true
        );
    }
    SS.game.step(S, dt);
    stepProjectiles(S, dt);
    if (SS.weapons) SS.weapons.step(S, dt);                       // holes, planes, lightning, moai, dig, bullets, devices, crates
    if (SS.shrapnel) SS.shrapnel.step(S, dt);
    if (SS.spatter) SS.spatter.step(S, dt);
    for (let i = S.pending.length - 1; i >= 0; i--) {
      const e = S.pending[i];
      if (S.time >= e.t) {
        S.pending.splice(i, 1);
        sim.explode(S, e.c, { W: e.W, dmg: e.dmg, name: e.kind }, null);
      }
    }
    if (SS.bodies) SS.bodies.step(S, dt);
    TN.step_graves(S, dt);
    if (SS.scatter) SS.scatter.step(S, dt);
    if (SS.water) SS.water.step(S, dt);
    if (SS.ice) SS.ice.step(S, dt);
    if (SS.veg) SS.veg.step(S, dt);
    if (S.eow) SS.eow.step(S, dt);                                  // shots lost to space keep drifting for the view
    if (SS.lava && !S.eow) SS.lava.step(S, dt);                    // (the magma pockets stay put in space)
    if (SS.alien) SS.alien.step(S, dt);                           // eggs, face huggers, the alien, acid
    for (const w of S.worms) {
      if (w.dead) continue;
      WM.unentomb(S, w);                                             // buried at rest
      if (w.dead) continue;
      if (w.drowning) {
        SW.sink_step(S, w, dt);
        continue;
      }
      if (w.swim) {
        SW.step(S, w, dt);
        continue;
      }
      if (!WM.ctl(S, w)) WM.body_3d(S, w, dt);
      WM.hazards(S, w, dt);
    }
    for (let i = S.fx.length - 1; i >= 0; i--) {
      S.fx[i].t += dt;
      if (S.fx[i].t > 0.65) S.fx.splice(i, 1);
    }
    // PoC settle (L5107): the next beat once everything has been quiet for 0.6 s in a row (16 s at most)
    if (S.phase === PHASE.ATTACK && !(S.retreatT > 0)) {
      const quiet = !S.proj.length && !SS.weapons.busy(S) && TN.settled(S);
      S.quietT = quiet ? S.quietT + dt : 0;
      if (S.quietT >= C.WORM_DYN.SETTLE_QUIET || S.time - S.lastBoom > C.WORM_DYN.SETTLE_CAP) {
        S.phase = PHASE.RESOLVE;
        S.resolveT = S.time - 0.6;
        S.quietT = 0;
      }
    } else S.quietT = 0;
    if (S.phase === PHASE.RESOLVE && S.time - S.resolveT > 0.8) {
      // something moved again during the wait (a trap, a late blast): settle first (PoC startTurn waits for landings)
      // (at most 3 bounces back per turn: a hp-1 worm that crawls out of the sea and slides back in forever (lab
      // SLICK mud, 2 of 40 soak matches) held the turn for 900 s)
      if (!TN.settled(S) && S.time - S.lastBoom < 10 && S.resolveBack < 3) {
        S.resolveBack++;
        S.phase = PHASE.ATTACK;
        S.lastBoom = S.time;
        S.retreatT = 0;
      }
      else if (!TN.begin_dying(S)) TN.next_turn(S);
    }
    if (S.phase === PHASE.DYING) TN.step_dying(S, dt);
    // Surrounding world: revealed while rotating, faded out a few seconds after rotation stops.
    const want = S.time - S.lastRotate < C.CTX_HOLD ? 1 : 0;
    S.ctx += M.clamp(want - S.ctx, -dt / C.CTX_FADE, dt / 0.25);
    // (S.forceInspect = the force field's full 3D view)
    S.inspect += M.clamp((inp.inspect || S.time < (S.forceInspect || 0) ? 1 : 0) - S.inspect, -dt / 0.35, dt / 0.35);
    if (W.flat) SS.dim2d.constrain(S);               // everything that can leave the plane goes back onto it (and no 3D inspection)
  };

  /* ---------- compatibility: the names the sim core had on SS.sim before it was split into files. The callers outside
   * the
   * core move to the home modules as they are touched; the block goes when the last one has moved. ---------- */
  sim.INPUT_FIELDS = ST.INPUT_FIELDS;
  sim.input_clear = ST.input_clear;
  sim.input_copy = ST.input_copy;
  sim.input_make = ST.input_make;
  sim.snapshot = ST.snapshot;
  sim.restore = ST.restore;
  sim.hash = ST.hash;
  sim.worm_make = ST.worm_make;
  sim.sanitize_input = ST.sanitize_input;
  sim.INPUT_LIMITS = ST.INPUT_LIMITS;
  sim.layout_hash = ST.layout_hash;
  sim.near_lava = SP.near_lava;
  sim.find_spot = SP.find_spot;
  sim.unbury_worms = SP.unbury_worms;
  sim.spawn_hazard = SP.spawn_hazard;
  sim.spawn_audit = SP.spawn_audit;
  sim.arena_r = SP.arena_r;
  sim.in_play = SP.in_play;
  sim.CAUSE = DM.CAUSE;
  sim.CAUSE_NAME = DM.CAUSE_NAME;
  sim.cause_gibs = DM.cause_gibs;
  sim.BODY_NAMES = DM.BODY_NAMES;
  sim.body_name_id = DM.body_name_id;
  sim.weapon_name_id = DM.weapon_name_id;
  sim.src_text = DM.src_text;
  sim.hit_ends_turn = DM.hit_ends_turn;
  sim.hurt = DM.hurt;
  sim.burn = DM.burn;
  sim.kill = DM.kill;
  sim.kill_now = DM.kill_now;
  sim.ensure_control = SW.ensure_control;
  sim.drown = SW.drown;
  sim.wedge_free = WM.wedge_free;
  sim.living = WM.living;
  sim.aim_dir = WM.aim_dir;
  sim.walk_speed = WM.walk_speed;
  sim.gravity_k = WM.gravity_k;
  sim.jump_vs = WM.jump_vs;
  sim.weapon_ready = WM.weapon_ready;
  sim.control_pre = WM.control_pre;
  sim.control_fire = WM.control_fire;
  sim.ctl = WM.ctl;
  sim.lava_floor = WM.lava_floor;
  sim.blocked3 = WM.blocked3;
  sim.in_band = WM.in_band;
  sim.plane_lock = WM.plane_lock;
  sim.worm_under = WM.worm_under;
  sim.time_of_day = TN.time_of_day;
  sim.team_name = TN.team_name;
  sim.team_rgb = TN.team_rgb;
  sim.next_turn = TN.next_turn;
  sim.can_switch = TN.can_switch;
  sim.switch_worm = TN.switch_worm;
  sim.locked = TN.locked;
  sim.heading_window = TN.heading_window;
  sim.clamp_heading = TN.clamp_heading;
  sim.rotate_by = TN.rotate_by;
  sim.align_to = TN.align_to;
  sim.align_to_point = TN.align_to_point;
  sim.align_next = TN.align_next;
  sim.align_crate = TN.align_crate;
  sim.victory_align = TN.victory_align;
  sim.end_retreat = TN.end_retreat;
  sim.end_turn = TN.end_turn;
  sim.fire_active = TN.fire_active;
  sim.die_now = TN.die_now;
})(window.SS = window.SS || {});
