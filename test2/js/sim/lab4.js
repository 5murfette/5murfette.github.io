/* sim/lab4.js — P79 Lab batch 4: five physically grounded mechanics, each a flag of settings.labFlags (bits C.LAB.FLAG,
 * rules + constants C.LAB.L4).
 * With every one of them off nothing here runs (the hooks return neutral values, no RNG draw, no hash input): the game
 * is bit for bit the one without the batch. Own RNG stream S.lab.b4.rng. Portable and deterministic: sim time only, no
 * Map / Set, plain structs. Design: docs/notes/P79.md.
 *
 *   LIGHTNING  storm:   in a thunderstorm a leader reaches down at a point P and attaches to the highest grounded
 *              conductor within ZAP_REACH of P
 *              (rolling-sphere rule: steel girders / bridge trusses reach up best, then mines, barrels and metal props,
 *              a bare worm, a tree, bare ground). A static-crackle tell (corona + hiss) marks the chosen point ZAP_WARN
 *              s before the bolt, so a worm can run. The bolt zaps worms near the point (existing electrocute), sets a
 *              mine or barrel off, blows a supply crate, sets dry plants alight.
 *   SLICK      weather:  ground wetness (rain; snow cover) lowers the friction of loose ground (soil, sand, ash, scree,
 *              snow): mu_eff = mu (1 - 0.55 wet).
 *              A worm on a slope steeper than mu_eff slides; mud slows the walk and soaks up a fall. It dries by the
 *              weather model (about 5 min).
 *   RECOIL     weapons:  a heavy shot pushes the shooter back: dv = m v_exit k / WORM_KG, minus the static friction of
 *              the ground under it. Ice and mud
 *              barely hold; a ledge edge or the sea behind the worm becomes a risk (the CPU steps away from such an
 *              edge first).
 *   SCAVENGE   loot:     a worm's grave leaves one random item of its team's stock as a supply crate (at the next turn
 *              start).
 * C layout: struct Lab4 { u32 rng; f32 zapQ[2]; Zap zap[4]; i32 zapN; u16 scav;
 * f32 slipT[16]; i32 slipTurn; };
 *           struct Zap { i32 id; f32 t0, t, x, y, z; u8 kind; i32 tid; };   one worm field: f32 rv (recoil slide speed
 *           along the section, 0 unless RECOIL is on);  kinds: 0 ground 1 tree 2 worm 3 steel bridge 4 mine 5 barrel 6
 *           metal (girder plate, props) 7 crate.
 * API: init(S), turn_start(S, first), step(S, dt), hash(S, mix), badge(S, flag) -> text, pick(S, px, pz, hyp), wet(S),
 *   walk_k(S, w), slip(S, a, s, y) -> extra m/s, landing_k(S, w), recoil(S, a, key, power, aim), recoil_dist(S, a, key,
 *   power), magnet(S, x, y, z), zap_flee(S, a) -> dir, own_lightning(S). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, F = C.LAB, K = F.L4, FL = F.FLAG, MAT = C.MAT;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const L4 = SS.lab4 = {};
  const B4 = FL.LIGHTNING | FL.SLICK | FL.RECOIL | FL.SCAVENGE;
  L4.MASK = B4;
  const W = () => SS.world;
  const flags = S => (S.lab && S.settings ? ((S.settings.labFlags | 0) & B4) : 0);
  const on = (S, bit) => (flags(S) & bit) !== 0;
  const rnd = S => M.rng_next(S.lab.b4.rng);
  const rr = (S, a, b) => a + (b - a) * rnd(S);
  const KIND = ['ground', 'tree', 'worm', 'steel', 'mine', 'barrel', 'metal', 'crate'];
  const KIND_TEXT = ['the ground', 'a tree', 'a worm', 'a steel girder', 'a mine', 'a fuel barrel', 'a metal prop', 'a supply crate'];

  L4.make = function (seed) {
    const slip = [];
    for (let i = 0; i < C.LIMITS.WORMS; i++) slip.push(-9);
    return {
      rng: M.rng_make(((Math.imul(seed | 0, 69621) + 0x2d4f) >>> 0) || 1),
      zapQ: [],
      zap: [],
      zapN: 0,
      scav: 0,
      slipT: slip,
      slipTurn: -1
    };
  };
  L4.init = function (S) { S.lab.b4 = L4.make(S.settings.seed); };

  /* ---------- ground: wetness, friction ---------- */
  const LOOSE = new Uint8Array(C.MATS.length);
  LOOSE[MAT.SOIL] = 1;
  LOOSE[MAT.SAND] = 1;
  LOOSE[MAT.SNOW] = 1;
  LOOSE[MAT.ASH] = 1;
  LOOSE[MAT.SCREE] = 1;
  L4.wet = function (S) {
    const we = S.weather;
    if (!we) return 0;
    return M.max(we.wet || 0, K.SNOW_K * (we.snowCover || 0));
  };
  /* friction coefficient of the ground at (x, z): the material mu, lowered by wetness on loose ground; sliding sea ice
   * = the ice mu */
  function ground_mu(S, x, y, z, wet) {
    const wd = W();
    if (SS.ice && S.ice && SS.ice.top_at) {
      const it = SS.ice.top_at(S, x, z);
      if (it > -1e8 && SS.ice.slippery(S, x, z)) return C.MATS[MAT.ICE].mu;
    }
    const top = wd.top_at(x, z);
    if (top < -1e8) return 0.7;
    const m = wd.mat_at(x, top - 0.2, z), mu = C.MATS[m] ? C.MATS[m].mu : 0.7;
    return LOOSE[m] ? mu * (1 - K.MU_K * wet) : mu;
  }
  function loose_here(S, a) {
    const wd = W(), top = wd.top_at(a.pos.x, a.pos.z);
    if (top < -1e8 || Math.abs(a.pos.y - (a.foot || 0.5) - top) > 0.35) return false;
    return LOOSE[wd.mat_at(a.pos.x, top - 0.2, a.pos.z)] === 1;
  }
  L4.walk_k = function (S, w) {
    if (!on(S, FL.SLICK) || !w) return 1;
    const wet = L4.wet(S);
    if (wet < 0.05 || !loose_here(S, w)) return 1;
    return 1 - K.WALK_K * wet;
  };
  L4.landing_k = function (S, w) {
    if (!on(S, FL.SLICK)) return 1;
    const wet = L4.wet(S);
    if (wet < 0.05) return 1;
    const wd = W(), top = wd.top_at(w.pos.x, w.pos.z);
    if (top < -1e8 || !LOOSE[wd.mat_at(w.pos.x, top - 0.2, w.pos.z)]) return 1;
    return 1 - K.FALL_K * wet;
  };
  /* the active worm (step2D, plane coordinates s, y): extra horizontal speed (m/s) down a slope steeper than the
   * friction allows */
  L4.slip = function (S, a, s, y) {
    if (!on(S, FL.SLICK)) return 0;
    const wet = L4.wet(S);
    if (wet < 0.05) return 0;
    const wd = W(), P = SS.plane, d = P.dir(S), q = P.to_world(S, s, y), top = wd.top_at(q.x, q.z);
    if (top < -1e8 || Math.abs(y - (a.foot || 0.5) - top) > 0.35 || !LOOSE[wd.mat_at(q.x, top - 0.2, q.z)]) return 0;
    const h1 = wd.top_at(q.x + d.x * 0.5, q.z + d.z * 0.5), h0 = wd.top_at(q.x - d.x * 0.5, q.z - d.z * 0.5);
    if (h1 < -1e8 || h0 < -1e8) return 0;
    const gr = h1 - h0, ex = Math.abs(gr) - ground_mu(S, q.x, y, q.z, wet);
    if (!(ex > 0)) return 0;
    const v = M.min(K.SLIDE_MAX, K.SLIDE_K * ex), L = S.lab.b4;
    if (S.time - L.slipT[a.id] > 1.5) {
      L.slipT[a.id] = S.time; SS.sim.emit(S, EV.LABSLIDE, { wormId: a.id, x: q.x, y: top, z: q.z, v });
      if (L.slipTurn !== S.turnNo) {
        L.slipTurn = S.turnNo;
        SS.sim.log(S, `${a.name} slips on the wet ground.`, 0xb89a72);
      }
    }
    return gr > 0 ? -v : v;
  };
  /* inactive worms resting on a wet slope slide too (their own 3D step has no walking): the worm is carried down the
   * slope kinematically
   * (the same speed law as the active worm), over a cliff edge it is released to the normal fall */
  function slick_step(S, dt) {
    if (S.phase !== PHASE.PLAY && S.phase !== PHASE.ATTACK && S.phase !== PHASE.RESOLVE) return;
    const wet = L4.wet(S);
    if (wet < 0.05) return;
    const wd = W(), L = S.lab.b4;
    for (const w of S.worms) {
      if (w.dead || !w.rest || w.swim || w.drowning || w.rope || SS.sim.ctl(S, w)) continue;
      const x = w.pos.x, z = w.pos.z, top = wd.top_at(x, z);
      if (top < -1e8 || Math.abs(w.pos.y - (w.foot || 0.5) - top) > 0.35 || !LOOSE[wd.mat_at(x, top - 0.2, z)]) continue;
      const gx = wd.top_at(x + 0.5, z) - wd.top_at(x - 0.5, z), gz = wd.top_at(x, z + 0.5) - wd.top_at(x, z - 0.5), gr = M.len2(gx, gz);
      const ex = gr - ground_mu(S, x, w.pos.y, z, wet);
      if (!(ex > 0)) continue;
      const v = M.min(K.SLIDE_MAX, K.SLIDE_K * ex) * K.SLICK_PUSH,
        nx = x - gx / gr * v * dt,
        nz = z - gz / gr * v * dt,
        nt = wd.top_at(nx, nz);
      if (nt < -1e8) continue;
      // over an edge: falls
      if (nt < top - 0.6) {
        w.rest = false;
        w.slide = true;
        w.vel.x = -gx / gr * v;
        w.vel.z = -gz / gr * v;
        continue;
      }
      if (nt > top + 0.6 || wd.sample(nx, nt + (w.foot || 0.5) + 0.3, nz) > 0) continue;                                       // a wall
      w.pos.x = nx; w.pos.z = nz; w.pos.y = nt + (w.pos.y - top);
      if (S.time - L.slipT[w.id] > 1.5) {
        L.slipT[w.id] = S.time;
        SS.sim.emit(S, EV.LABSLIDE, { wormId: w.id, x, y: top, z, v });
      }
    }
  }

  /* ---------- LIGHTNING ---------- */
  const storm = S => !!(S.weather && S.weather.storm && !W().under);
  // weather.js: the natural strike is replaced while the flag is on
  L4.own_lightning = S => on(S, FL.LIGHTNING);
  /* the attachment point of a leader at (px, pz): the highest conductor (height + bonus) within ZAP_REACH. hyp: a
   * hypothetical worm { x, y, z } (the CPU) */
  L4.pick = function (S, px, pz, hyp) {
    const wd = W(), R = K.ZAP_REACH;
    let best = null;
    const take = (kind, id, x, y, z, bonus) => {
      if (M.len2(x - px, z - pz) > R) return;
      const e = y + bonus;
      if (!best || e > best.eff) best = { kind, id, x, y, z, eff: e };
    };
    if (SS.trees && S.trees)
      for (const t of S.trees) {
        if (!t.alive) continue;
        const p = SS.trees.top_point(t);
        if (p) take(1, t.id, p.x, p.y, p.z, 0);
      }
    if (S.structs)
      for (const st of S.structs) {
        if (st.fallen) continue;
        for (let i = 0; i < st.n; i++) {
          const t = (i + 0.5) / st.n * st.L,
            x = st.A.x + st.ux * t,
            z = st.A.z + st.uz * t,
            y = st.A.y + (st.B.y - st.A.y) * t / st.L + st.h;
          take(3, st.id, x, y, z, K.B_STEEL);
        }
      }
    for (const b of S.bodies) {
      if (!b.prop) continue;
      const y = b.pos.y + (b.rb || 0.3);
      if (b.prop === 'girder') take(6, b.id, b.pos.x, y, b.pos.z, K.B_STEEL);
      else if (b.prop === 'mine') {
        if (!b.disarmed) take(4, b.id, b.pos.x, y, b.pos.z, K.B_METAL);
      }
      else if (b.prop === 'barrel') take(5, b.id, b.pos.x, y, b.pos.z, K.B_METAL);
      else if (b.metal) take(6, b.id, b.pos.x, y, b.pos.z, K.B_METAL);
    }
    if (S.crates)
      for (const c of S.crates)
        if (c.landed && c.kind === 'weapon') take(7, c.id, c.pos.x, c.pos.y + 0.3, c.pos.z, K.B_CRATE);
    for (const w of S.worms) {
      if (w.dead) continue;
      if (wd.topHeight(w.pos.x, w.pos.z) > w.pos.y + 0.3) continue;                 // a roof over it
      take(2, w.id, w.pos.x, w.pos.y + 0.4, w.pos.z, K.B_WORM);
    }
    if (hyp) take(2, -1, hyp.x, hyp.y + 0.4, hyp.z, K.B_WORM);
    // bare ground: the highest land point of a 3 m grid
    for (let dz = -R; dz <= R; dz += 3)
      for (let dx = -R; dx <= R; dx += 3) {
        const x = px + dx, z = pz + dz;
        if (x < 1 || z < 1 || x > wd.SX - 1 || z > wd.SZ - 1) continue;
        const y = wd.topHeight(x, z);
        if (y > wd.SEA + 0.2) take(0, 0, x, y, z, 0);
      }
    return best;
  };
  /* would a worm standing at (x, y, z) be the attachment point of a leader right above it? (storm only) */
  L4.magnet = function (S, x, y, z) {
    if (!on(S, FL.LIGHTNING) || !storm(S)) return false;
    const w = L4.pick(S, x, z, { x, y, z });
    return !!w && w.kind === 2 && w.id === -1;
  };
  /* a tell is armed within 5 m of the active worm: the direction (+1 / -1 along the plane) away from it, else 0 */
  L4.zap_flee = function (S, a) {
    if (!S.lab || !S.lab.b4 || !S.lab.b4.zap.length) return 0;
    for (const z of S.lab.b4.zap) {
      if (M.len3(a.pos.x - z.x, a.pos.y - z.y, a.pos.z - z.z) > K.ZAP_R + 0.5) continue;
      const P = SS.plane, zs = P.to_plane(S, { x: z.x, y: z.y, z: z.z }).s, as = P.to_plane(S, a.pos).s;
      return as >= zs ? 1 : -1;
    }
    return 0;
  };
  function arm(S) {
    const L = S.lab.b4, wd = W(), O = S.O || { x: wd.MX, z: wd.MZ };
    const alive = [];
    for (const w of S.worms)
      if (!w.dead) alive.push(w);
    let px = 0, pz = 0, ok = false;
    for (let tries = 0; tries < 6 && !ok; tries++) {
      const u0 = rnd(S), u1 = rnd(S), u2 = rnd(S), u3 = rnd(S);
      if (u0 < K.ZAP_CELL && alive.length) {                                          // a storm cell over the action: near a random worm
        const w = alive[M.min(alive.length - 1, Math.floor(u1 * alive.length))];
        px = w.pos.x + (u2 * 2 - 1) * K.ZAP_CELL_R; pz = w.pos.z + (u3 * 2 - 1) * K.ZAP_CELL_R;
      } else {
        const a = u1 * M.TAU, r = K.ZAP_NEAR * Math.sqrt(u2);
        px = O.x + M.cos(a) * r;
        pz = O.z + M.sin(a) * r;
      }
      px = M.clamp(px, 2, wd.SX - 2); pz = M.clamp(pz, 2, wd.SZ - 2);
      ok = wd.topHeight(px, pz) > wd.SEA + 0.3 && SS.sim.in_play(S, px, pz);
    }
    return ok ? L4.arm_at(S, px, pz) : null;
  }
  /* arm a strike for a leader at (px, pz): the tell starts now, the bolt comes ZAP_WARN s later */
  L4.arm_at = function (S, px, pz) {
    const L = S.lab.b4;
    const tg = L4.pick(S, px, pz);
    if (!tg) return null;
    const z = { id: ++L.zapN, t0: S.time, t: S.time + K.ZAP_WARN, x: tg.x, y: tg.y, z: tg.z, kind: tg.kind, tid: tg.id };
    SS.sim.pool_push(L.zap, 4, z);
    SS.sim.emit(S, EV.LABSTATIC, { x: z.x, y: z.y, z: z.z, kind: KIND[z.kind], warn: K.ZAP_WARN, id: z.id });
    return z;
  };
  /* the bolt: re-check that the target is still there (a worm that ran away, a mine that was set off: the bolt hits the
   * ground at the point) */
  function strike(S, z) {
    const L = S.lab.b4, wd = W(), sim = SS.sim, WP = SS.weapons;
    let kind = z.kind;
    const p = { x: z.x, y: z.y, z: z.z };
    let body = null, worm = null, tree = null, crate = null;
    if (kind === 2) {
      worm = S.worms[z.tid];
      if (!worm || worm.dead || M.len3(worm.pos.x - p.x, worm.pos.y + 0.4 - p.y, worm.pos.z - p.z) > 1.6) {
        worm = null;
        kind = 0;
      }
    }
    else if (kind === 1) {
      tree = S.trees.find(t => t.id === z.tid);
      if (!tree || !tree.alive) {
        tree = null;
        kind = 0;
      }
    }
    else if (kind === 4 || kind === 5 || kind === 6) {
      body = SS.bodies.by_id(S, z.tid);
      if (!body) kind = 0;
    }
    else if (kind === 7) {
      crate = S.crates.find(c => c.id === z.tid);
      if (!crate) kind = 0;
    }
    if (kind === 0) {
      const gy = wd.topHeight(p.x, p.z);
      if (gy > wd.SEA) p.y = gy;
    }
    const seed = M.rng_int(L.rng, 1 << 30), wet = L4.wet(S), I = M.clamp(1 - K.ZAP_IGN_WET * wet, 0.2, 1);
    sim.emit(S, EV.LIGHTNING, { x: p.x, y: p.y, z: p.z, kind: KIND[kind], id: z.tid, seed });
    sim.emit(S, EV.THUNDER, { x: p.x, y: p.y, z: p.z });
    sim.log(S, `Lightning strikes ${KIND_TEXT[kind]}!`, 0xbfe0ff);
    S.lightning = 1;                                                                 // a tinfoil hat grounds it (sim.hurt takes 10 %)
    let boom = true;
    if (kind === 1 && SS.trees) SS.trees.strike(S, tree, { breakTop: M.rng_next(L.rng) < 0.5 });
    if (WP && WP.electrocute) {
      if (kind === 2) WP.electrocute(S, p, C.LIGHTNING.ZAP_R, K.ZAP_D_WORM, null);
      else if (kind === 3 || kind === 6 || kind === 4 || kind === 5) WP.electrocute(S, p, K.ZAP_R, K.ZAP_D_STEEL, null);
      else if (kind === 0 || kind === 1) WP.electrocute(S, p, C.LIGHTNING.ZAP_R, C.LIGHTNING.ZAP_D, null);
    }
    if ((kind === 4 || kind === 5) && body && SS.scatter && SS.scatter.set_off) {
      SS.scatter.set_off(S, body);
      boom = false;
    }
    if (kind === 7 && crate) {
      S.crates.splice(S.crates.indexOf(crate), 1); boom = false;
      sim.explode(S, crate.pos, { W: WP.CRATE.W, dmg: 30, name: 'crate' }, null);
    }
    if (boom) sim.explode(S, p, { W: C.LIGHTNING.W, dmg: 10, name: 'lightning' }, null);
    if (SS.veg && SS.veg.ignite_disc) SS.veg.ignite_disc(S, p.x, p.y, p.z, K.ZAP_IGN_R, I);
    S.lightning = 0;
    if (S.weather) S.weather.strikes++;
  }
  function lightning_turn(S, first) {
    const L = S.lab.b4;
    L.zapQ.length = 0;
    // (four draws a turn, storm or not: one stream, no branching on the weather)
    const r1 = rnd(S), r2 = rnd(S), t1 = rnd(S), t2 = rnd(S);
    if (!storm(S)) return;
    const T = S.settings.turnTime > 0 ? S.settings.turnTime : 45, tmax = M.max(K.ZAP_T0 + 1, T * 0.7);
    if (r1 < K.ZAP_P1) L.zapQ.push(S.time + K.ZAP_T0 + t1 * (tmax - K.ZAP_T0));
    if (S.round >= 4 && r2 < K.ZAP_P2) L.zapQ.push(S.time + K.ZAP_T0 + t2 * (tmax - K.ZAP_T0));
    if (first && L.zapQ.length) L.zapQ.length = 0;
  }
  function lightning_step(S) {
    const L = S.lab.b4;
    if (S.phase !== PHASE.PERK && S.phase !== PHASE.PLACE)
      for (let i = L.zapQ.length - 1; i >= 0; i--)
        if (S.time >= L.zapQ[i]) {
          L.zapQ.splice(i, 1);
          arm(S);
        }
    for (let i = L.zap.length - 1; i >= 0; i--) {
      const z = L.zap[i];
      if (S.time >= z.t) {
        L.zap.splice(i, 1);
        strike(S, z);
      }
    }
  }

  /* ---------- RECOIL ---------- */
  /* the kick: dv = m v_exit k / WORM_KG along the plane, opposite the horizontal part of the aim. A worm on the ground
   * then slides with Coulomb friction
   * (deceleration mu g): dry soil stops it in dv^2 / (2 mu g) = 0.9 m, mud 1.9 m, bare ice 12 m. Carried kinematically
   * along the section (w.rv, m/s, + = +s). */
  function recoil_dv(S, key, power) {
    const rc = K.RC[key];
    if (!rc) return 0;
    if (rc.imp != null) return rc.imp / K.WORM_KG;
    const d = C.ARSENAL[key] || {},
      pw = M.clamp(power != null ? power : S.power, 0, 1),
      speed = (d.vmax || 28) * M.max(C.WORM_DYN.MIN_POWER, pw);
    return rc.m * rc.k * speed / K.WORM_KG;
  }
  /* metres the worm would slide back (the CPU asks before it fires) */
  L4.recoil_dist = function (S, a, key, power, aim) {
    if (!on(S, FL.RECOIL) || a.air || S.rope) return 0;
    const v = recoil_dv(S, key, power) * Math.abs(M.cos(aim)), mu = M.max(0.03, ground_mu(S, a.pos.x, a.pos.y, a.pos.z, L4.wet(S)));
    return v * v / (2 * mu * K.RC_G);
  };
  /* weapons.use, after a shot: push the shooter back along the plane (opposite the horizontal part of the aim) */
  L4.recoil = function (S, a, key, power, aim) {
    if (!on(S, FL.RECOIL) || !a || a.dead || S.rope) return;
    const v = recoil_dv(S, key, power) * Math.abs(aim.s);
    if (!(v > 0.05)) return;
    const dir = aim.s >= 0 ? -1 : 1, sim = SS.sim, ctl = sim.ctl(S, a);
    // in the air: no friction, a plain change of velocity
    if (ctl ? a.air : !a.rest) {
      if (ctl) a.vs += v * dir;
      else {
        const d = SS.plane.dir(S);
        a.vel.x += d.x * v * dir;
        a.vel.z += d.z * v * dir;
      }
    } else a.rv = (a.rv || 0) + v * dir;
    sim.emit(S, EV.LABRECOIL, { wormId: a.id, dv: v, dir, weapon: key });
  };
  /* every step: carry the sliding worms along the section, slowed by friction; over an edge they are released into the
   * fall */
  function recoil_step(S, dt) {
    const wd = W(), d = SS.plane.dir(S), wet = L4.wet(S), sim = SS.sim;
    for (const w of S.worms) {
      let v = w.rv || 0;
      if (!v) continue;
      const ctl = sim.ctl(S, w);
      if (w.dead || w.swim || w.drowning || w.rope || (ctl ? w.air : !w.rest)) {
        w.rv = 0;
        continue;
      }
      const dec = ground_mu(S, w.pos.x, w.pos.y, w.pos.z, wet) * K.RC_G * dt,
        v1 = Math.abs(v) <= dec ? 0 : v - (v > 0 ? dec : -dec),
        vm = 0.5 * (v + v1);
      w.rv = v1;
      if (!vm) continue;
      const x = w.pos.x,
        z = w.pos.z,
        top = wd.top_at(x, z),
        nx = x + d.x * vm * dt,
        nz = z + d.z * vm * dt,
        nt = wd.top_at(nx, nz),
        foot = w.foot || 0.5;
      const onTop = top > -1e8 && Math.abs(w.pos.y - foot - top) <= 0.35;
      if (onTop && nt < -1e8) {
        w.rv = 0;
        continue;
      }
      // over the edge (the centre passed the lip): it leaves the ground with the speed it has
      if (onTop && nt < top - K.RC_LIP) {
        w.rv = 0;
        if (ctl) {
          w.air = true;
          w.vs = vm;
          w.vy = K.RC_HOP * Math.abs(vm);
          w.slide = true;
          w.vel.x = d.x * vm;
          w.vel.z = d.z * vm;
          w.vel.y = w.vy;
          w.rest = false;
        } else {
          w.rest = false;
          w.vel.x = d.x * vm;
          w.vel.z = d.z * vm;
          w.vel.y = K.RC_HOP * Math.abs(vm);
          w.slide = true;
        }
        continue;
      }
      // a wall stops it
      if (onTop ? (nt > top + 0.6 || wd.sample(nx, nt + foot + 0.3, nz) > 0) : wd.sample(nx, w.pos.y, nz) > 0) {
        w.rv = 0;
        continue;
      }
      w.pos.x = nx;
      w.pos.z = nz;
      if (onTop) w.pos.y = nt + (w.pos.y - top);
    }
  }

  /* ---------- SCAVENGE ---------- */
  function scavenge(S) {
    const L = S.lab.b4, WP = SS.weapons;
    for (const w of S.worms) {
      if (!w.dead || (L.scav & (1 << w.id))) continue;
      if (w.gravePending) continue;
      // drowned, eaten, blown away: the pack is lost
      if (!w.grave) {
        L.scav |= 1 << w.id;
        continue;
      }
      if (!(w.grave.landT >= 0)) continue;                                            // the grave has not settled yet
      L.scav |= 1 << w.id;
      const t = S.teams && S.teams[w.team];
      if (!t) continue;
      const list = [];
      for (const k of C.ARSENAL_ORDER) {
        const v = t.ammo[k];
        if (v !== Infinity && v > 0 && C.ARSENAL[k].crate) list.push(k);
      }
      if (!list.length || !WP.crate_room(S, false)) continue;
      const key = list[M.min(list.length - 1, Math.floor(rnd(S) * list.length))];
      t.ammo[key] -= 1;
      const g = w.grave, c = WP.crate_make(S, 'weapon', key, null, { x: g.x, y: g.y + 0.55, z: g.z });
      S.crates.push(c);
      SS.sim.emit(S, EV.LABSCAV, { wormId: w.id, weapon: key, x: g.x, y: g.y + 0.3, z: g.z });
      SS.sim.log(S, `${w.name}'s pack: a ${C.ARSENAL[key].name} lies by the grave.`, 0xffd890);
    }
  }

  /* ---------- hooks ---------- */
  L4.turn_start = function (S, first) {
    const fl = flags(S);
    if (!fl || !S.lab.b4) return;
    if (fl & FL.LIGHTNING) lightning_turn(S, first);
    if (fl & FL.SCAVENGE) scavenge(S);
  };
  L4.step = function (S, dt) {
    const fl = flags(S);
    if (!fl || !S.lab.b4 || S.phase === PHASE.OVER) return;
    if (fl & FL.LIGHTNING) lightning_step(S);
    if (fl & FL.SLICK) slick_step(S, dt);
    if (fl & FL.RECOIL) recoil_step(S, dt);
  };
  L4.hash = function (S, mix) {
    const fl = flags(S);
    if (!fl || !S.lab.b4) return;
    const L = S.lab.b4;
    mix(fl);
    mix(L.rng.s % 100003);
    mix(L.zapN);
    mix(L.scav);
    mix(L.zapQ.length);
    for (const t of L.zapQ) mix(t);
    for (const z of L.zap) {
      mix(z.t);
      mix(z.x);
      mix(z.z);
      mix(z.kind);
    }
    if (fl & FL.RECOIL)
      for (const w of S.worms) mix(w.rv || 0);
  };
  /* HUD badge suffix of one flag */
  L4.badge = function (S, name) {
    const L = S.lab && S.lab.b4;
    if (!L) return '';
    if (name === 'LIGHTNING') return !storm(S) ? ' (no storm)' : L.zap.length ? ' (!)' : '';
    if (name === 'SLICK') {
      const w = L4.wet(S);
      return w >= 0.05 ? ' (wet ' + Math.round(w * 100) + '%)' : ' (dry)';
    }
    return '';
  };
})(window.SS = window.SS || {});
