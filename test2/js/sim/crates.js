/* sim/crates.js — supply crates (PoC dropCrate / collectCrate): the round's weapon or health crate dropped on the
 * turn's
 * section (tool crates: skills.js), the parachute fall with the wind drift, the pick-up by the worm whose turn it is, a
 * crate thrown with the gravity gun, a falling crate hit by an air-strike missile, crates in a blast. In space (End of
 * the World) eow.js moves them instead (no parachute: they drift in the field and land on any side of a chunk).
 * Portable and deterministic: the weapons' RNG stream S.armRng, sim time only.
 * C layout: struct Crate { i32 id; f32 t0; u8 kind (0 weapon, 1 health, 2 tool); u8 weapon, tool (ids, 255 none);
 *   vec3 pos; u8 landed, held; u8 thrown; i16 by (the worm that threw it, -1 none); f32 pickT (that worm may not pick
 *   it up before), spin; vec3 vel (valid while thrown); }
 * API: K, make(S, kind, weapon, tool, pos), room(S, tool), drop(S, kind), step(S, dt), hit(S, p, wp), blast(S, c, R),
 *   falling(S). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane;
  const EV = C.EV;
  const CT = SS.crates = {};
  const W = () => SS.world;
  const sim = () => SS.sim;
  const rng = S => M.rng_next(S.armRng);
  const rr = (S, a, b) => a + (b - a) * rng(S);
  /* the share of health crates and the HP one gives (= the balance table's B.ECON, r7test checks it), the parachute's
   * fall speed and wind drift, the pick-up reach, how long a falling crate holds the turn's end, a weapon crate's blast
   * (W kg, DMG HP: the PoC's radius 34 px blast), the caps on S.crates: weapon + health crates share MAX, tool crates
   * have MAX_TOOL */
  const K = CT.K = { HEALTH: 0.45, HP: 30, FALL: 55 * C.SCALE.kT, DRIFT: 0.35, PICK: 1.1, HOLD: 4, W: M.pow(34 / 44, 3), DMG: 30, MAX: 24,
    MAX_TOOL: 10 };

  CT.make = function (S, kind, weapon, tool, pos) {
    const c = {
      id: ++S.crateId,
      t0: S.time,
      kind,
      tool,
      weapon,
      pos,
      landed: false,
      held: false,
      thrown: 0,
      by: -1,
      pickT: 0,
      spin: 0,
      vel: null
    };
    // in space a crate is free-floating (no parachute): velocity + local up
    return S.eow ? SS.eow.crate_init(c) : c;
  };
  /* room for one more crate of a class (tool: the tool crates' own cap). When the class is full the OLDEST landed crate
   * of it is removed (propbreak) instead of refusing, so unreachable crates never stop the supply for good. false: full
   * of crates still in the air / held / thrown. */
  CT.room = function (S, tool) {
    const cap = tool ? K.MAX_TOOL : K.MAX;
    let n = 0, old = -1;
    for (let i = 0; i < S.crates.length; i++) {
      const c = S.crates[i];
      if ((c.kind === 'tool') !== !!tool) continue;
      n++;
      if (c.landed && !c.held && !c.thrown && (old < 0 || c.t0 < S.crates[old].t0)) old = i;
    }
    if (n < cap) return true;
    if (old < 0) return false;
    const k = S.crates[old];
    S.crates.splice(old, 1);
    sim().emit(S, EV.PROPBREAK, { x: k.pos.x, y: k.pos.y, z: k.pos.z, kind: 'crate', why: 'expired' });
    return true;
  };
  /* the round's planned weapon / health crate (weapons.turn_start; skills.crate_plan decides the kind): it falls onto
   * the new turn's section somewhere it can be reached (± 25 m along it); in space it appears at random and drifts */
  CT.drop = function (S, kind) {
    if (S.eow) {
      SS.eow.crate_drop(S, kind);
      return;
    }
    // (full: the oldest landed crate goes; only crates still in the air refuse)
    if (!CT.room(S, false)) return;
    for (let tries = 0; tries < 12; tries++) {
      const s = rr(S, -25, 25), gy = SS.weapons.ground_below(S, s, W().SY - 0.5), at = P.to_world(S, s, gy);
      if (gy < -1e8 || gy < sim().surface_at(S, at.x, at.z) + 0.3 || (W().dry && !sim().in_play(S, at.x, at.z))) continue;
      // a weapon crate: weighted by rarity band (sim/balance.js)
      const weapon = kind === 'weapon'
        ? (SS.balance ? SS.balance.crate_pick(rng(S)) : C.CRATE_POOL[Math.floor(rng(S) * C.CRATE_POOL.length)])
        : null;
      S.crates.push(CT.make(S, kind, weapon, null, P.to_world(S, s, M.min(W().SY - 1, gy + 14))));
      sim().emit(S, EV.BANNER, { title: 'Supply drop', sub: 'It drifts with the wind' });
      return;
    }
  };
  /* a crate thrown with the gravity gun flies ballistically (c.vel, c.thrown), tumbling; it hurts the worm it hits
   * (CRATE_DMG_K HP per m/s, at most CRATE_DMG_MAX, nothing under CRATE_DMG_MIN_V) and stops dead on it, then lands on
   * the ground where whoever's turn it is picks it up (not the thrower for CRATE_LOCK s). Returns false when it fell
   * into the sea / out. */
  function fly(S, c, dt) {
    const w = W(), KG = C.TOOLB.GRAV;
    // (space: the field of the chunks)
    if (S.eow) SS.eow.body_g(S, c, dt);
    else c.vel.y -= C.G * dt;
    const n = M.max(1, Math.ceil(M.len3(c.vel.x, c.vel.y, c.vel.z) * dt / 0.15)), h = dt / n;
    for (let q = 0; q < n; q++) {
      const nx = c.pos.x + c.vel.x * h, ny = c.pos.y + c.vel.y * h, nz = c.pos.z + c.vel.z * h, sp = M.len3(c.vel.x, c.vel.y, c.vel.z);
      for (const o of S.worms) {
        if (o.dead || o.drowning || o.id === c.by && S.time < c.pickT - 1.0) continue;
        if (M.len3(o.pos.x - nx, o.pos.y - ny, o.pos.z - nz) < C.WORM_R + 0.35 && sp > KG.CRATE_DMG_MIN_V) {
          const dmg = M.min(KG.CRATE_DMG_MAX, Math.round(KG.CRATE_DMG_K * sp));
          S.hitDir = { x: c.vel.x / sp, y: 0.25, z: c.vel.z / sp };
          sim().hurt(S, o, dmg, C.DS.FLY_SUPPLY_CRATE, C.HF.DOT);
          sim().emit(S, EV.CRATEHIT, { x: nx, y: ny, z: nz, wormId: o.id, dmg });
          c.vel.x *= 0.15;
          c.vel.y = Math.abs(c.vel.y) * 0.1;
          c.vel.z *= 0.15;
          c.by = -1;
          break;
        }
      }
      if (w.sample(nx, ny - 0.3, nz) > 0 || w.sample(nx, ny, nz) > 0) {                          // lands
        if (c.vel.y < -1) sim().emit(S, EV.CRATEDROP, { x: c.pos.x, y: c.pos.y, z: c.pos.z, v: -c.vel.y });
        c.landed = true;
        c.thrown = 0;
        c.vel = null;
        c.pos.y = M.max(c.pos.y, 0);
        if (S.eow) SS.eow.crate_settle(S, c);
        else
          for (let k = 0; k < 40 && w.sample(c.pos.x, c.pos.y - 0.3, c.pos.z) > 0; k++) c.pos.y += 0.05;
        return true;
      }
      c.pos.x = nx; c.pos.y = ny; c.pos.z = nz;
      if (S.eow) {
        if (SS.eow.crate_out(S, c)) return false;
      } else if (c.pos.y < sim().surface_at(S, c.pos.x, c.pos.z) || c.pos.y < 0.3) {
        sim().emit(S, EV.SPLASH, { x: c.pos.x, y: c.pos.y, z: c.pos.z, size: 0.8 });
        return false;
      }
    }
    return true;
  }
  // the active worm takes crate c: a tool (skills.js), 30 HP (it also cures gas and the alien embryo) or one more round
  function pick(S, a, c) {
    if (c.kind === 'tool' && SS.skills) SS.skills.pickup(S, a, c);
    else if (c.kind === 'health') {
      a.hp += K.HP;
      if (SS.weaponsA && a.gas) SS.weaponsA.cure(S, a);
      if (SS.alien && a.embryo) SS.alien.cure(S, a);
      sim().emit(S, EV.PICKUP, { wormId: a.id, kind: 'health', amount: K.HP });
      sim().log(S, `${a.name} picks up +${K.HP} HP.`, 0x79d98b);
    }
    else {
      const t = S.teams[a.team];
      if (t.ammo[c.weapon] !== Infinity) t.ammo[c.weapon] = (t.ammo[c.weapon] || 0) + 1;
      sim().emit(S, EV.PICKUP, { wormId: a.id, kind: 'weapon', weapon: c.weapon });
      sim().log(S, `${a.name} finds a ${C.ARSENAL[c.weapon].name}.`, 0xffb02e);
    }
  }
  const wv = { x: 0, y: 0, z: 0 };
  CT.step = function (S, dt) {
    const w = W(), a = S.active;
    for (let i = S.crates.length - 1; i >= 0; i--) {
      const c = S.crates[i];
      if (c.held) continue;                                                                      // in the gravity gun's beam
      if (c.thrown && !c.landed) {
        if (!fly(S, c, dt)) S.crates.splice(i, 1);
        continue;
      }
      if (!c.landed) {
        if (SS.weather) SS.weather.wind_at(S, c.pos.x, c.pos.y, c.pos.z, wv);
        else { wv.x = wv.z = 0; }
        // space: free-floating, caught by the field, lands on any side (no parachute, no wind)
        if (S.eow) {
          if (!SS.eow.crate_step(S, c, dt)) S.crates.splice(i, 1);
          continue;
        }
        c.pos.x += wv.x * K.DRIFT * dt; c.pos.z += wv.z * K.DRIFT * dt; c.pos.y -= K.FALL * dt;
        if (w.sample(c.pos.x, c.pos.y - 0.35, c.pos.z) > 0) {
          c.landed = true;
          while (w.sample(c.pos.x, c.pos.y - 0.3, c.pos.z) > 0) c.pos.y += 0.05;
        }
        if (c.pos.y < sim().surface_at(S, c.pos.x, c.pos.z) || c.pos.y < 0.3) {
          S.crates.splice(i, 1);
          sim().emit(S, EV.SPLASH, { x: c.pos.x, y: c.pos.y, z: c.pos.z, size: 0.8 });
          continue;
        }
        // the ground under a landed crate blasted away (space: along the field)
      } else if (S.eow ? SS.eow.crate_loose(S, c) : w.sample(c.pos.x, c.pos.y - 0.4, c.pos.z) <= 0) c.landed = false;
      // (PoC: not while it still hangs on its chute)
      if (
        c.landed
        && a
        && !a.dead
        && sim().ctl(S, a)
        && M.v3_dist(a.pos, c.pos) < K.PICK * (SS.lab ? SS.lab.pick_k(S, a) : 1)
        && !(c.by === a.id && S.time < (c.pickT || 0))
      ) {
        S.crates.splice(i, 1);
        pick(S, a, c);
      }
    }
  };
  /* an impact shell meeting a parachuting crate (PoC L3380: only air-strike missiles meet one, other shells pass by):
   * the missile turns it into a "napalm crate", a small blast + 26 burning fuel gobs (PoC napalmCrate). true: the
   * shell is spent. */
  CT.hit = function (S, p, wp) {
    if (!S.crates.length || p.type !== 'missile') return false;
    for (let i = 0; i < S.crates.length; i++) {
      const c = S.crates[i];
      if (c.landed || M.v3_dist(c.pos, wp) > 0.75) continue;
      S.crates.splice(i, 1);
      // PoC (.., 16, 10)
      sim().explode(S, c.pos, { W: M.pow(16 / 44, 3), dmg: 10, name: 'a napalm crate', boom: C.BOOM.FUEL }, p.owner);
      const cp = P.to_plane(S, c.pos);
      for (let k = 0; k < 26; k++) {
        const a = rr(S, 0, Math.PI * 2), v = rr(S, 1.5, 7);
        SS.weapons.launch(S, 'fuel', cp.s, c.pos.y, M.cos(a) * v, M.sin(a) * v * 0.6 + 1.5, -1);
      }
      sim().emit(S, EV.BANNER, { title: 'Napalm crate!', sub: 'The missile lit the supply drop' });
      return true;
    }
    return false;
  };
  // a blast (weapons.blast; R = blast.poc_R) removes every crate within 2.1 R; a weapon crate goes off 0.12 s later
  CT.blast = function (S, c, R) {
    for (let i = S.crates.length - 1; i >= 0; i--) {
      const k = S.crates[i];
      if (M.v3_dist(k.pos, c) > 2.1 * R) continue;
      S.crates.splice(i, 1);
      if (k.kind === 'weapon') sim().schedule(S, 0.12, k.pos, K.W, 'crate', null, K.DMG);
      else sim().emit(S, EV.PROPBREAK, { x: k.pos.x, y: k.pos.y, z: k.pos.z, kind: 'crate', why: 'blast' });
    }
  };
  /* a falling crate holds the turn's end only in its first HOLD s: a long drop (over the sea, a strong drift) kept the
   * turn open to the 16 s settle cap; later it just keeps falling into the next turn */
  CT.falling = S => S.crates.some(c => !c.landed && S.time - (c.t0 == null ? -99 : c.t0) < K.HOLD);
})(window.SS = window.SS || {});
