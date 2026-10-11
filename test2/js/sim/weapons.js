/* sim/weapons.js — the PoC arsenal on the poc5 engine (P2-P6; data in sim/arsenal.js, PoC rules in docs/poc-weapons.md).
 * Portable and deterministic: own RNG stream S.armRng, sim time only, in-plane (s, y) rules as in the PoC (its world
 * IS a section), real 3D distances for blasts / pulls / zaps.
 * Pieces:
 *   use(S, power)         the active worm uses S.weapon (charge / drop / target / hitscan / melee / dig / utility / skip)
 *   launch(S, key, ...)    a projectile in the plane (generic flight in sim.js stepProjectiles; specials here)
 *   pre(S, p, dt)          per-projectile behaviour before the generic flight (homing steering, napalm airburst);
 *                          returns true when it moved the projectile itself (sheep)
 *   detonate(S, p, pos)    blast + specials (split, fire, black hole, foam, napalm)
 *   step(S, dt)            holes, planes (air strike / napalm), lightning, moai, dig (torch / drill), sniper bullets,
 *                          devices (magnet / spring), supply crates
 *   turn_start(S)          device lifetimes, supply drops; settled(S); blast(S, c, W) (devices / crates in a blast)
 * C layout: struct Hole { vec3 c; f32 t, carveT; }; struct Strike { u8 kind; i8 dir; f32 s, y, tS, rel[5]; u8 k; };
 *   struct Device { u8 kind, team; vec3 pos; f32 ds, dy, cool; u8 turns, charges, hp; }; struct Crate { vec3 pos;
 *   u8 kind; u8 weapon; bool landed; }; struct Bullet { f32 s, y, vs, vy, dmg, pen, life; }; struct Dig { ... }. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane, MAT = C.MAT, A = C.ARMS;
  const WP = SS.weapons = {};
  const W = () => SS.world;
  const sim = () => SS.sim;
  const G = () => SS.game;
  const rng = S => M.rng_next(S.armRng);
  const rr = (S, a, b) => a + (b - a) * rng(S);
  const def = key => C.WEAPONS[key] || {};
  const hypot3 = (a, b) => M.len3(a.x - b.x, a.y - b.y, a.z - b.z);

  WP.init = function (S) {
    Object.assign(S, { holes: [], strikes: [], devices: [], crates: [], bullets: [], zaps: [], moais: [], dig: null, armRng: M.rng_make((Math.imul(S.settings.seed | 0, 69069) + 0xa53) >>> 0 || 1),
      fuse: 3, strikeDir: 1, girderA: 0, plateAng: 0, plates: [], tgt: null, shots: 0, teleT: 0 });
    if (SS.weaponsA) SS.weaponsA.init(S);                          // P37-W3: weapons A (flamethrower, acid, gas, mortar, minigun, ...)
    for (const m of ['gadgets', 'ffield', 'skills']) if (SS[m] && SS[m].init) SS[m].init(S);     // P37 W4: weapons B, force field, skills + tool crates
  };
  /* ---------- small helpers ---------- */
  // velocity change on a worm: in-plane while it is controlled (its turn / retreat), else its 3D body velocity
  function shove(S, w, dx, dy, dz, airborne) {
    if (sim().ctl(S, w)) { const d = P.dir(S); w.vs += dx * d.x + dz * d.z; w.vy += dy; w.air = true; if (S.rope) S.rope = null; }
    else { w.rest = false; w.vel.x += dx; w.vel.y += dy; w.vel.z += dz; }
  }
  WP.shove = shove;
  // the plane direction as a world vector from (ds, dy)
  const pw = (S, ds, dy) => { const d = P.dir(S); return { x: d.x * ds, y: dy, z: d.z * ds }; };
  // line of sight in the plane (terrain only), stepping 0.15 m
  function clear2(S, s0, y0, s1, y1) {
    const L = M.len2(s1 - s0, y1 - y0), n = Math.ceil(L / 0.15);
    for (let i = 1; i < n; i++) { const f = i / n; if (P.solid2(S, s0 + (s1 - s0) * f, y0 + (y1 - y0) * f)) return false; }
    return true;
  }
  // first ground under (s, y) in the plane (y of the surface), or -1e9
  function groundBelow(S, s, y) { for (let q = y; q > 0.2; q -= 0.1) if (P.blocked2(S, s, q)) return q + 0.1; return -1e9; }
  // the highest ground on the section around s (± span m): planes fly above it
  function highest(S, s, span) { const w = W(); let h = w.SEA; if (!(Math.abs(s) < 1e5 && span >= 0 && span < 1e3)) return h; for (let q = s - span; q <= s + span; q += 1) for (let y = w.SY - 0.5; y > h; y -= 0.5) if (P.solid2(S, q, y)) { h = y; break; } return h; }
  WP.ground_below = groundBelow;
  WP.edited = (S, x, y, z, R) => edited(S, x, y, z, R);
  // after a non-blast edit (black hole, drill, foam): cut out what lost its support (settings.collapse), struct check
  function edited(S, x, y, z, R) {
    const w = W(), H = w.H, box = { i0: M.max(0, Math.floor((x - R) / H) - 1), i1: M.min(w.NX - 1, Math.ceil((x + R) / H) + 1),
      j0: M.max(0, Math.floor((y - R) / H) - 1), j1: M.min(w.NY - 1, Math.ceil((y + R) / H) + 1), k0: M.max(0, Math.floor((z - R) / H) - 1), k1: M.min(w.NZ - 1, Math.ceil((z + R) / H) + 1) };
    S.sectionDirty = true;
    if (S.settings.collapse && SS.collapse_hook) SS.collapse_hook(S, box);
    if (SS.struct && SS.struct.on_edit) SS.struct.on_edit(S);
  }

  /* ---------- using a weapon ---------- */
  // ammo, the team's last weapon, the attack phase and the retreat window (PoC used())
  function used(S, key, retreat, keepPlay) {
    const a = S.active;
    // (P38 R1: ammo per USE: the second round of a two-shot weapon (shotgun, handgun; S.shots counts the rounds fired) is free. Before each
    // round spent one, so with 1 left the follow-up was refused while the weapon stayed locked: a stuck turn)
    if (!(S.shots > 1)) G().use_ammo(S, a.team, key);
    if (S.teams[a.team]) S.teams[a.team].lastWeapon = key;
    if (keepPlay) return;
    S.charging = false; S.power = 0; S.thetaGoal = null;
    S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time;
    S.retreatT = retreat != null ? retreat : G().retreat_for(key);
    if (!(S.retreatT > 0)) sim().end_retreat(S);
    sim().emit(S, 'use', { weapon: key, wormId: a.id});
  }
  WP.used = used;
  // the Thunder Strike calls the storm's own lightning: only usable during a thunderstorm (user 2026-10-07)
  WP.needs_storm = key => key === 'tesla';
  // (P38 R1) the sky weapons (air strike, napalm, moai drop, thunder) need open sky: not in the cave maps (their "sky" is a rock ceiling
  // 40 m up: the planes / the rock spawned inside it and the charge was wasted)
  WP.needs_sky = key => key === 'airstrike' || key === 'napalm' || key === 'moai' || key === 'tesla';
  WP.can_use = (S, key) => (G().ammo(S, S.active.team, key) > 0 || (S.shots > 0 && key === S.weapon)) && !(WP.needs_storm(key) && !(S.weather && S.weather.storm)) && !(WP.needs_sky(key) && W().under);
  // fire / use the selected weapon. power: charge 0..1 (charge kinds); target: S.tgt {s, y} (target kinds, homing)
  WP.use = function (S, power) {
    const a = S.active, key = S.weapon, d = def(key);
    if (!a || a.dead || !WP.can_use(S, key)) { S.charging = false; return false; }   // (before any read of a: none in 'place')
    const aim = sim().aim_dir(S), ap = P.to_plane(S, a.pos);
    if (SS.lab && S.settings.labFlags) { const sw = SS.lab.sway(S, a, aim); aim.s = sw.s; aim.y = sw.y; }      // P50: a tired worm's aim sways
    if (d.wa && d.kind !== 'charge' && SS.weaponsA) return SS.weaponsA.use(S, key, a, ap, aim);      // stream / hitscan / target weapons of P37-W3
    if (SS.gadgets && SS.gadgets.KEYS[key]) return SS.gadgets.use(S, a, key, power);          // P37 W4: dog, punch, sentry, claymore, gravity gun
    if (key === 'ffield' && SS.ffield) return SS.ffield.use(S, a);
    switch (d.kind) {
      case 'charge': {
        if (d.target && !S.tgt) { sim().log(S, 'Click a target first.', 0xffb27a); S.charging = false; return false; }
        const pw = M.clamp(power != null ? power : S.power, 0, 1), vmax = d.vmax || 28, speed = vmax * M.max(C.WORM_DYN.MIN_POWER, pw);   // PoC launch: speed x max(0.08, power)
        if (key === 'boulder') launchBoulder(S, a, ap, aim, speed);
        else if (d.wa && SS.weaponsA && SS.weaponsA.charge(S, key, a, ap, aim, speed)) { /* its own flight (boomerang) */ }
        else {
          const p = WP.launch(S, key, ap.s + aim.s * 0.7, a.pos.y + aim.y * 0.7, aim.s * speed, aim.y * speed, a.id);
          if (d.wa && SS.weaponsA) SS.weaponsA.launched(S, key, p);
          if (d.target && S.tgt) { p.ts = S.tgt.s; p.ty = S.tgt.y; p.dist = M.len2(S.tgt.s - p.s, S.tgt.y - p.y); p.v0 = speed; S.tgt = null; }   // (PoC: the target is used up)
        }
        sim().emit(S, 'fire', { weapon: key, pos: P.to_world(S, ap.s + aim.s * 0.7, a.pos.y + aim.y * 0.7), speed });
        sim().log(S, `${d.name} fired at ${speed.toFixed(1)} m/s, ${Math.round(S.aim * 180 / Math.PI)}° elevation.`, sim().team_rgb(S, a.team));
        used(S, key); return true;
      }
      case 'drop': return drop(S, a, key, ap, d);
      case 'target':
        if (!S.tgt) { sim().log(S, 'Click a point on the section.', 0xffb27a); return false; }
        return target(S, a, key, S.tgt.s, S.tgt.y, d);
      case 'hitscan': return key === 'sniper' ? sniper(S, a, ap, aim) : shotgun(S, a, ap, aim);
      case 'melee': return bat(S, a, ap, aim);
      case 'dig': return dig(S, a, ap, aim);
      case 'utility': return key === 'bellows' ? bellows(S, a, ap, aim) : scrambler(S, a, ap);
      case 'skip': sim().log(S, `${a.name} skips the turn.`); sim().end_turn(S, 0.2); return true;
    }
    return false;
  };

  /* ---------- projectiles ---------- */
  /* The projectile struct (P38 R7 / P3): one shape for every kind, every field present with its default (before, ~22 of them were added lazily).
   * C: struct Proj { i32 id; u8 type (WeaponId); f32 s, y, vs, vy, fuse, age; i16 owner (-1 none); i16 bounces; u8 wet, hot, subm, pierced, lava, scr;
   *   u32 hitW (bit mask of worm ids already hit by a bouncing shell); f32 ts, ty (homing target, ts = NaN none), dist, v0; f32 bank (hard bounces, P42); f32 gk, wk (gravity / wind
   *   factor, 1 = full); f32 burstY (napalm airburst height, NaN none), burstH, armB (mortar); i8 dir; f32 hopT, block (sheep); }.
   * `type` is a weapon key string in JS = the enum name (C.WEAPON_KEYS gives the index). */
  WP.proj_make = function (S, key, s, y, vs, vy, owner) {
    const pd = C.PROJ[key] || def(key);
    return { id: ++S.projN, type: key, s, y, vs, vy, fuse: SS.weaponsA ? SS.weaponsA.fuse_of(S, key) : pd.fuseSet ? S.fuse : (pd.fuse || 99), age: 0, owner, bounces: 0, wet: false, hot: 0,
      subm: false, pierced: false, lava: false, scr: false, hitW: 0, bank: 0, ts: null, ty: 0, dist: 0, v0: 0, gk: 1, wk: 1, burstY: null, burstH: 0, armB: 0, dir: 0, hopT: 0, block: 0 };
  };
  WP.launch = function (S, key, s, y, vs, vy, owner) {
    const pd = C.PROJ[key] || def(key);
    const p = WP.proj_make(S, key, s, y, vs, vy, owner);
    if (pd.sheep) { p.dir = vs >= 0 ? 1 : -1; p.hopT = rr(S, pd.hop0, pd.hop1); p.block = 0; }
    sim().pool_push(S.proj, C.LIMITS.PROJ, p);
    return p;
  };
  /* The supply crate struct: C: struct Crate { i32 id; f32 t0; u8 kind (0 weapon, 1 health, 2 tool); u8 weapon, tool (ids, 255 none); vec3 pos; u8 landed, held;
   * u8 thrown; i16 by (the worm that threw it, -1 none); f32 pickT (that worm may not pick it up before), spin; vec3 vel (valid while thrown); } */
  WP.crate_make = function (S, kind, weapon, tool, pos) {
    return { id: ++S.crateId, t0: S.time, kind, tool, weapon, pos, landed: false, held: false, thrown: 0, by: -1, pickT: 0, spin: 0, vel: null };
  };
  // per projectile, before the generic flight: homing steering, napalm airburst, sheep walking
  WP.pre = function (S, p, dt) {
    const pd = C.PROJ[p.type] || {};
    if (pd.homing && p.ts != null && !p.wet) {
      const h = pd.homing, lock = M.clamp(p.dist / M.max(1, p.v0) * 0.5, h.lock0, h.lock1);
      if (p.age < lock) { p.gk = h.gLock; p.wk = h.windLock; }
      else if (p.age < lock + h.fuel) {
        const blend = M.min(1, (p.age - lock) / h.blend), want = M.atan2(p.ty - p.y, p.ts - p.s), cur = M.atan2(p.vy, p.vs);
        const da = M.clamp(M.wrap_angle(want - cur), -h.turn * blend * dt, h.turn * blend * dt), sp = M.min(h.vmax, M.len2(p.vs, p.vy) + h.accel * dt);
        p.vs = M.cos(cur + da) * sp; p.vy = M.sin(cur + da) * sp; p.gk = h.gFly; p.wk = 0;
      } else { p.gk = 1; p.wk = 1; }
    }
    if (pd.wa && SS.weaponsA) { const r = SS.weaponsA.pre(S, p, dt, pd); if (r) return r; }
    if (pd.napalm && p.burstY != null && p.vy < 0 && p.y <= p.burstY) { napalmBurst(S, p); return 'gone'; }
    if (pd.sheep) return sheepStep(S, p, dt, pd);
    return false;
  };
  // the burst: blast + specials. pos = world point. Returns nothing; the caller removes p.
  WP.detonate = function (S, p, pos) {
    const pd = C.PROJ[p.type] || def(p.type), name = (def(p.type).name || p.type);
    if (pd.wa && SS.weaponsA && SS.weaponsA.detonate(S, p, pos)) return;      // flame droplets, acid, gas (mortar / bomblets: the generic blast below)
    if (pd.hole) { spawnHole(S, pos); return; }
    if (pd.foam) { growFoam(S, pos, p); return; }
    if (pd.flame) { firePatch(S, pos, A.NAPALM.PATCH_R); return; }
    if (SS.lab) SS.lab.bank_set(S, p.bank);                                   // P42: the bank shot's hard bounces
    if (pd.W > 0) sim().explode(S, pos, { W: pd.W, dmg: pd.dmg, name, frag: pd.frag, boom: pd.boom }, p.owner);
    if (SS.lab) SS.lab.bank_set(S, 0);
    if (pd.big) { sim().emit(S, 'holy', { x: pos.x, y: pos.y, z: pos.z }); S.slowUntil = S.time + 0.7; }   // PoC slowmo(0.7)
    if (pd.fire) for (let i = 0; i < pd.fire; i++) firePatch(S, { x: pos.x + rr(S, -1, 1), y: pos.y, z: pos.z + rr(S, -1, 1) * 0.3 }, A.NAPALM.PATCH_R);
    if (pd.split) {
      const sp = pd.split, ap = P.to_plane(S, pos);
      for (let i = 0; i < sp.n; i++) WP.launch(S, sp.kind, ap.s, pos.y + 0.3, 0.65 * p.vs + rr(S, -1, 1) * sp.jx, 0.65 * p.vy + rr(S, sp.vy0, sp.vy1), -1);   // PoC L3404: signed 0.65 vy (a falling shell throws them lower)
    }
  };
  WP.water = function (S, p, pd, wp, surf) {           // at water entry; returns 'keep' | 'gone' | 'burst'
    if (pd.wa && SS.weaponsA) return SS.weaponsA.water(S, p, pd, wp, surf);
    if (pd.homing) return 'keep';                       // PoC: homing missiles fly through water
    if (pd.foam) { growFoam(S, { x: wp.x, y: surf - 0.2, z: wp.z }, p); return 'gone'; }
    if (pd.flame || pd.napalm) { sim().emit(S, 'steam', { x: wp.x, y: surf, z: wp.z, power: 0.4 }); return 'gone'; }
    return pd.impact ? 'burst' : 'keep';
  };

  /* sheep (PoC stepProj sheep branch): a walker in the plane; hops every 0.7-1.5 s, turns at walls */
  function sheepStep(S, p, dt, pd) {
    const R = 0.3;
    p.vy -= C.G * dt;
    let ns = p.s + p.vs * dt, ny = p.y + p.vy * dt;
    const below = P.blocked2(S, p.s, p.y - R - 0.04);
    if (P.blocked2(S, ns, ny - R) && p.vy < 0) { ny = p.y; p.vy = 0; }                 // landed
    if (P.blocked2(S, ns, ny + 0.1) || P.blocked2(S, ns + p.dir * R, ny)) {             // something ahead
      let up = 0; while (up < 0.5 && P.blocked2(S, ns + p.dir * R, ny + up)) up += 0.1;
      if (up < 0.5 && below) { ny += up; } else { ns = p.s; p.vs = 0; p.block += dt; }
    } else p.block = 0;
    if (below || p.vy === 0) {
      p.vs = p.dir * pd.walk;
      p.hopT -= dt;
      if (p.block > 0.35) { p.dir = -p.dir; p.block = 0; p.vs = p.dir * pd.walk; }
      if (p.hopT <= 0) { p.vy = pd.hopVy; p.vs = p.dir * pd.hopVx; p.hopT = rr(S, pd.hop0, pd.hop1); if (rng(S) < 0.4) sim().emit(S, 'baa', { x: P.to_world(S, p.s, p.y).x, y: p.y, z: P.to_world(S, p.s, p.y).z }); }
    }
    while (P.blocked2(S, ns, ny - R * 0.6) && ny < W().SY) ny += 0.05;                  // never sink into the ground
    p.s = ns; p.y = ny;
    if (p.y < 0.5) return 'gone';
    const wp = P.to_world(S, p.s, p.y);
    if (p.y < sim().surface_at(S, wp.x, wp.z) - 0.2) p.fuse = M.min(p.fuse, 1);    // drowning sheep go off soon
    p.fuse -= dt;
    if (p.fuse <= 0) { WP.detonate(S, p, wp); return 'gone'; }
    return true;
  }
  // a live sheep of the active worm (re-fire detonates it, PoC beginFire)
  WP.detonate_own = function (S) {
    const a = S.active; let n = 0;
    for (const p of S.proj.slice()) if (p.type === 'sheep' && p.owner === a.id) { WP.detonate(S, p, P.to_world(S, p.s, p.y)); S.proj.splice(S.proj.indexOf(p), 1); n++; }
    if (n) S.lastBoom = S.time;
    return n > 0;
  };

  /* ---------- drop kinds: dynamite, sheep, mine, magnet, spring ---------- */
  function drop(S, a, key, ap, d) {
    const T = A.DROP_TOSS, f = a.facing, air = a.air || !!S.rope;
    const vs = f * (air ? T.AIR_VS : T.GROUND_VS) + 0.4 * (a.air ? a.vs : 0), vy = air ? T.AIR_VY * 0.3 + 0.15 * a.vy : T.GROUND_VY;
    const s0 = ap.s + f * 0.6, y0 = a.pos.y + 0.2;
    if (key === 'mine') {
      const b = SS.scatter.add(S, 'mine', P.to_world(S, s0, y0), 0);
      const v = pw(S, vs, vy); b.vel.x = v.x; b.vel.y = v.y; b.vel.z = v.z; b.armAt = S.time + A.MINE.ARM; b.dropped = true; b.team = a.team; b.planted = S.time; if (SS.weaponsA && S.wa) b.fuseSet = S.wa.mineF;
    } else if (key === 'magnet' || key === 'spring') {
      if (S.devices.filter(o => o.kind === key).length >= A.MAGNET.MAX) { sim().log(S, `Device limit: ${A.MAGNET.MAX} ${key === 'magnet' ? 'magnets' : 'spring traps'}.`, 0xffb27a); return false; }   // PoC: 4 per kind
      const aim = sim().aim_dir(S); let ds = aim.s, dy = M.max(0.25, aim.y); const l = M.len2(ds, dy); ds /= l; dy /= l;
      sim().pool_push(S.devices, C.LIMITS.DEVICES, { kind: key, team: a.team, s: s0, y: y0, vy: 0, pos: P.to_world(S, s0, y0), theta: S.theta, O: { x: S.O.x, z: S.O.z }, ds, dy,
        turns: key === 'magnet' ? A.MAGNET.TURNS : A.SPRING.TURNS, charges: A.SPRING.CHARGES, cool: 0, t: 0, hp: 35, id: S.devices.length + S.turnNo * 16, planted: S.time, revealed: false });
    } else WP.launch(S, key, s0, y0, key === 'sheep' ? f * 1.9 : vs, key === 'sheep' ? 3.8 : vy, a.id);
    if (key === 'dynamite' || key === 'mine') sim().emit(S, 'fuse', { weapon: key, x: a.pos.x, y: a.pos.y, z: a.pos.z });
    sim().log(S, `${a.name} drops a ${d.name.toLowerCase()}.`, sim().team_rgb(S, a.team));
    used(S, key); return true;
  }

  /* ---------- rope payloads (PoC dropFromRope): the selected weapon leaves with the swing's velocity ---------- */
  WP.rope_drop = function (S) {
    const a = S.active, key = S.weapon, d = def(key), ap = P.to_plane(S, a.pos);
    if (d.kind === 'drop') return drop(S, a, key, ap, d);
    if (d.target && !S.tgt) { sim().log(S, 'Click a target first.', 0xffb27a); return false; }
    const sp = M.len2(a.vs, a.vy), ds = sp > 0.1 ? a.vs / sp : a.facing, dy = sp > 0.1 ? a.vy / sp : 0;
    if (key === 'boulder') launchBoulder(S, a, ap, { s: ds, y: dy }, sp);
    else {
      const boost = key === 'bazooka' || key === 'homing' ? 0.08 * (d.vmax || 28) : 0;
      const p = WP.launch(S, key, ap.s, a.pos.y - 0.55, a.vs + ds * boost, a.vy + dy * boost, a.id);
      if (d.wa && SS.weaponsA) SS.weaponsA.launched(S, key, p);     // (P38 R1: the mortar's burst height / the gas fuse also apply to a payload dropped from the rope)
      if (d.target && S.tgt) { p.ts = S.tgt.s; p.ty = S.tgt.y; p.dist = M.len2(S.tgt.s - p.s, S.tgt.y - p.y); p.v0 = M.max(5, sp); }
    }
    sim().log(S, `${a.name} drops a ${d.name.toLowerCase()} from the rope.`, sim().team_rgb(S, a.team));
    used(S, key); return true;
  };

  /* ---------- boulder: a 500 kg rolling rock (scatter's boulder body) ---------- */
  function launchBoulder(S, a, ap, aim, speed) {
    const pos = P.to_world(S, ap.s + aim.s * 1.0, a.pos.y + aim.y * 1.0 + 0.2), b = SS.scatter.add(S, 'boulder', pos, 0);
    const v = pw(S, aim.s * speed, aim.y * speed), n = P.nrm(S);
    b.vel.x = v.x; b.vel.y = v.y; b.vel.z = v.z; b.w.x = n.x * a.facing * -4; b.w.z = n.z * a.facing * -4; b.thrown = S.time;
  }

  /* P38 R3: is the point connected to open air? A breadth-first flood fill through air cells (grid TP_STEP m, 6-neighbours, at most
   * TP_R m from the point) must reach a cell above the local ground top: a teleport into a sealed rock pocket is refused ("No room"). */
  const TP_STEP = 0.7, TP_R = 6, TP_N = 2 * Math.floor(TP_R / TP_STEP) + 1, tpSeen = new Uint8Array(TP_N * TP_N * TP_N), tpQ = new Int32Array(TP_N * TP_N * TP_N);
  WP.open_air = function (x, y, z) {
    const w = W(), c = (TP_N - 1) >> 1; tpSeen.fill(0);
    let h = 0, t = 0; const id = (i, j, k) => (k * TP_N + j) * TP_N + i;
    tpQ[t++] = id(c, c, c); tpSeen[tpQ[0]] = 1;
    while (h < t) {
      const q = tpQ[h++], i = q % TP_N, j = ((q / TP_N) | 0) % TP_N, k = (q / (TP_N * TP_N)) | 0;
      const px = x + (i - c) * TP_STEP, py = y + (j - c) * TP_STEP, pz = z + (k - c) * TP_STEP;
      if (py >= w.top_at(px, pz) + 0.3 || py >= w.SY - 1) return true;
      for (let n = 0; n < 6; n++) {
        const ni = i + (n === 0 ? 1 : n === 1 ? -1 : 0), nj = j + (n === 2 ? 1 : n === 3 ? -1 : 0), nk = k + (n === 4 ? 1 : n === 5 ? -1 : 0);
        if (ni < 0 || nj < 0 || nk < 0 || ni >= TP_N || nj >= TP_N || nk >= TP_N) continue;
        const nq = id(ni, nj, nk); if (tpSeen[nq]) continue; tpSeen[nq] = 1;
        if (M.len3((ni - c) * TP_STEP, (nj - c) * TP_STEP, (nk - c) * TP_STEP) > TP_R) continue;
        if (w.sample(x + (ni - c) * TP_STEP, y + (nj - c) * TP_STEP, z + (nk - c) * TP_STEP) > 0) continue;
        tpQ[t++] = nq;
      }
    }
    return false;
  };

  /* ---------- target kinds ---------- */
  function target(S, a, key, s, y, d) {
    if (key === 'teleport') {
      // (P38 R1: PoC 10 < x < W - 10: not outside the map / the play area, and not on the very edge; refused before the charge is spent)
      const tw = P.to_world(S, s, y), EM = 10;     // m from every map border (PoC)
      if (tw.x < EM || tw.z < EM || tw.x > W().SX - EM || tw.z > W().SZ - EM || !sim().in_play(S, tw.x, tw.z)) { sim().log(S, 'Out of bounds.', 0xffb27a); return false; }
      if (P.overlap2(S, s, y) > 0 || y < sim().surface_at(S, P.to_world(S, s, y).x, P.to_world(S, s, y).z) + 0.5 || y > W().SY - 1) { sim().log(S, 'No room there.', 0xffb27a); return false; }
      { const q = P.to_world(S, s, y); if (!WP.open_air(q.x, y, q.z)) { sim().log(S, 'No room there: sealed in rock.', 0xffb27a); return false; } }
      const from = { x: a.pos.x, y: a.pos.y, z: a.pos.z }, to = P.to_world(S, s, y);
      a.pos.x = to.x; a.pos.y = y; a.pos.z = to.z; a.vs = 0; a.vy = 0; a.air = true; S.rope = null; S.teleT = A.TELEPORT.BEAM;
      WP.tele_hold(a, to.x, y, to.z);
      sim().emit(S, 'teleport', { wormId: a.id, from, to: { x: to.x, y, z: to.z } });
      used(S, key); return true;
    }
    if (key === 'girder') return girder(S, a, s, y);
    if (key === 'airstrike' || key === 'napalm') {
      const Pl = A.PLANE, dir = S.strikeDir || 1, gy = M.max(W().SEA, groundBelow(S, s, W().SY - 0.5)), alt = M.min(W().SY - 1, highest(S, s, 20) + Pl.ALT);
      // release points: missiles leave the plane at (DROP_VS, DROP_VY) and fall alt - gy; they land GAP apart around s
      const h = M.max(1, alt - gy), v0 = -Pl.DROP_VY, tf = (-v0 + Math.sqrt(v0 * v0 + 2 * C.G * h)) / C.G, lead = Pl.DROP_VS * tf;
      const rel = []; for (let k = 0; k < Pl.N; k++) rel.push(s - dir * lead + (k - (Pl.N - 1) / 2) * Pl.GAP * dir);
      if (P.solid2(S, s, alt)) { sim().log(S, 'No room for the plane there.', 0xffb27a); return false; }     // (P38 R1: capped under a rock top)
      sim().pool_push(S.strikes, C.LIMITS.STRIKES, { kind: key, dir, s: s - dir * Pl.START, y: alt, tS: s, rel, k: 0, burstY: key === 'napalm' ? (alt + gy) / 2 : null, owner: a.id });
      sim().emit(S, 'plane', { kind: key, dir, y: alt });
      sim().log(S, `${d.name} called in from the ${dir > 0 ? 'left' : 'right'}.`, sim().team_rgb(S, a.team));
      used(S, key); return true;
    }
    if (key === 'tesla') { sim().pool_push(S.zaps, C.LIMITS.ZAPS, { t: S.time + A.TESLA.DELAY, s, owner: a.id }); sim().emit(S, 'charge', { x: P.to_world(S, s, y).x, y: W().SY, z: P.to_world(S, s, y).z }); used(S, key); return true; }
    if (key === 'moai') {
      const gy = M.max(W().SEA, groundBelow(S, s, W().SY - 0.5)), pos = P.to_world(S, s, M.min(W().SY - 1, gy + A.MOAI.ALT));
      const m = A.MOAI.KG, pts = []; for (let i = 0; i < 6; i++) pts.push(0, -1.1 + i * 0.44, 0, 0.55 - Math.abs(i - 2.5) * 0.04);
      const b = SS.bodies.add_shape(S, 'moai', pos, m, { x: m * 0.8, y: m * 0.25, z: m * 0.8 }, pts, MAT.ROCK);
      b.vel.y = -A.MOAI.V0; b.w.y = rr(S, -1.5, 1.5) * 0.3; b.e = 0.03; b.mu = 0.95; b.moai = true;
      sim().pool_push(S.moais, C.LIMITS.MOAIS, { body: b.id, smash: 0, t0: S.time, v: A.MOAI.V0, owner: a.id });
      sim().emit(S, 'moai', { body: b.id });
      used(S, key); return true;
    }
    return false;
  }
  /* girder plate (P37 W4): a steel plate GIRDER.L x T in the plane at the free angle S.plateAng (rad), D deep each side of the plane */
  function girder(S, a, s, y) {
    const Gd = A.GIRDER, ap = P.to_plane(S, a.pos), ang = S.plateAng || 0;
    if (M.len2(s - ap.s, y - a.pos.y) > Gd.REACH) { sim().log(S, 'Too far away.', 0xffb27a); return false; }
    const cs = M.cos(ang), sn = M.sin(ang);
    for (const w of S.worms) {
      if (w.dead) continue;
      const q = P.to_plane(S, w.pos); if (Math.abs(q.t) > Gd.D + 0.5) continue;
      const u = (q.s - s) * cs + (w.pos.y - y) * sn, v = -(q.s - s) * sn + (w.pos.y - y) * cs;
      if (Math.abs(u) < Gd.L / 2 + 0.45 && Math.abs(v) < Gd.T / 2 + 0.45) { sim().log(S, 'A worm is in the way.', 0xffb27a); return false; }
    }
    const w = W(), H = w.H, d = P.dir(S), n = P.nrm(S), R = Gd.L / 2 + Gd.D + 1;
    const c = P.to_world(S, s, y), i0 = M.max(1, Math.floor((c.x - R) / H)), i1 = M.min(w.NX - 2, Math.ceil((c.x + R) / H));
    const k0 = M.max(1, Math.floor((c.z - R) / H)), k1 = M.min(w.NZ - 2, Math.ceil((c.z + R) / H));
    const j0 = M.max(1, Math.floor((y - Gd.L / 2 - 1) / H)), j1 = M.min(w.NY - 2, Math.ceil((y + Gd.L / 2 + 1) / H));
    let n0 = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = i * H - c.x, z = k * H - c.z, yy = j * H - y, ss = x * d.x + z * d.z, tt = x * n.x + z * n.z;
      const u = ss * cs + yy * sn, v = -ss * sn + yy * cs;
      // signed distance to the beam box (u, v, tt): solid inside, so the meshed surface sits on the box faces
      const qu = Math.abs(u) - Gd.L / 2, qv = Math.abs(v) - Gd.T / 2, qt = Math.abs(tt) - Gd.D;
      const sd = M.max(M.max(qu, qv), qt);
      const o = (k * w.NY + j) * w.NX + i;
      // (P37: the exact signed distance out to 0.8 m, so every cell the surface crosses interpolates a PERFECTLY flat face; before only
      // 0.25 m outside were set and the neighbours kept their old air value: a wobbly plate)
      if (sd < 0.8 && -sd > w.d[o] - 1e-6) { if (sd < 0 && w.d[o] <= 0) n0++; w.d[o] = M.max(w.d[o], M.max(-0.8, -sd)); if (w.d[o] > 0) { w.mat[o] = MAT.STEEL; w.heat[o] = 0; } }
    }
    w.mark(i0, j0, k0, i1, j1, k1);
    S.sectionDirty = true;
    // the plate registry (render only: the shader draws the frame / sheet / bolt look in plate-local coordinates): centre,
    // long axis U (in the plane, at ang), plane normal n, half sizes (L / 2, T / 2, D)
    S.plates.push({ id: ++S.projN, cx: c.x, cy: y, cz: c.z, ux: d.x * cs, uy: sn, uz: d.z * cs, nx: n.x, nz: n.z, hl: Gd.L / 2, ht: Gd.T / 2, hd: Gd.D, ang });
    if (S.plates.length > 24) S.plates.shift();
    sim().emit(S, 'girder', { x: c.x, y, z: c.z, ang, theta: S.theta, n: n0 });
    used(S, 'girder'); return true;
  }

  /* ---------- hitscan / melee ---------- */
  function shotgun(S, a, ap, aim) {
    const K = A.SHOTGUN;
    let s = ap.s + aim.s * 0.6, y = a.pos.y + aim.y * 0.6, hit = null;
    for (let L = 0; L < K.RANGE && !hit; L += 0.1) {
      s += aim.s * 0.1; y += aim.y * 0.1;
      const wp = P.to_world(S, s, y);
      for (const w of S.worms) if (!w.dead && w !== a && hypot3(w.pos, wp) < C.WORM_R + 0.05) { hit = { w, wp }; break; }
      if (hit) break;
      for (const b of S.bodies) if (b.prop === 'mine' && !b.disarmed && hypot3(b.pos, wp) < b.rb + 0.05) { b.armed = true; if (b.det < 0 || b.det > S.time + 0.2) b.det = S.time + 0.2; hit = { wp }; break; }
      if (hit) break;
      if (devHit(S, wp, 25)) { hit = { wp }; break; }
      const bi = S.planeBodies.length ? P.body_at2(S, s, y, true) : -1;
      if (bi >= 0) { const d = P.dir(S); SS.bodies.nudge(S, SS.bodies.by_id(S, S.planeBodies[bi].body), { x: d.x * aim.s, y: aim.y, z: d.z * aim.s }, 60); hit = { wp }; break; }
      if (P.solid2(S, s, y)) { hit = { wp, ground: true }; break; }
    }
    const end = hit ? hit.wp : P.to_world(S, s, y);
    sim().emit(S, 'shot', { weapon: 'shotgun', from: P.to_world(S, ap.s + aim.s * 0.6, a.pos.y + aim.y * 0.6), to: end });
    if (hit && hit.w) { S.hitDir = pw(S, aim.s, aim.y); sim().hurt(S, hit.w, K.DMG, C.DS.SHOTGUN); const v = pw(S, aim.s * K.PUSH, aim.y * K.PUSH + K.PUSH_UP); shove(S, hit.w, v.x, v.y, v.z); }
    if (hit && hit.ground) sim().explode(S, end, { W: K.W, dmg: 0, name: 'shotgun' }, a.id);         // PoC (.., 12, 0): a crater only
    S.shots++;
    used(S, 'shotgun', null, S.shots < K.SHOTS);
    if (S.shots < K.SHOTS) sim().log(S, 'One more shot.', sim().team_rgb(S, a.team));
    return true;
  }
  function sniper(S, a, ap, aim) {
    const K = A.SNIPER;
    sim().pool_push(S.bullets, C.LIMITS.BULLETS, { s: ap.s + aim.s * 0.6, y: a.pos.y + aim.y * 0.6, vs: aim.s * K.V, vy: aim.y * K.V, dmg: K.DMG, pen: 0, life: K.LIFE, owner: a.id, path: 0, inSolid: false });
    sim().emit(S, 'shot', { weapon: 'sniper', from: P.to_world(S, ap.s + aim.s * 0.6, a.pos.y + aim.y * 0.6) });
    used(S, 'sniper'); return true;
  }
  function stepBullets(S, dt) {
    const K = A.SNIPER, w = W();
    for (let i = S.bullets.length - 1; i >= 0; i--) {
      const b = S.bullets[i]; b.life -= dt;
      const n = Math.ceil(M.len2(b.vs, b.vy) * dt / 0.05), h = dt / n;
      let done = b.life <= 0;
      for (let q = 0; q < n && !done; q++) {
        b.vy -= C.G * K.G * h; b.s += b.vs * h; b.y += b.vy * h; b.path += M.len2(b.vs, b.vy) * h;
        const wp = P.to_world(S, b.s, b.y);
        if (b.path > K.RANGE || b.y < 0.2 || b.y < sim().surface_at(S, wp.x, wp.z)) { done = true; break; }
        for (const o of S.worms) if (!o.dead && o.id !== b.owner && hypot3(o.pos, wp) < C.WORM_R) {
          S.hitDir = pw(S, b.vs / K.V, b.vy / K.V); sim().hurt(S, o, M.max(1, Math.round(b.dmg)), C.DS.SNIPER); const v = pw(S, b.vs / K.V * K.PUSH, b.vy / K.V * K.PUSH); shove(S, o, v.x, v.y, v.z); done = true; break;
        }
        if (done) break;
        if (devHit(S, wp, 45)) { done = true; break; }
        for (const o of S.bodies) if (o.prop === 'mine' && !o.disarmed && hypot3(o.pos, wp) < o.rb) { o.armed = true; o.det = S.time + 0.2; done = true; break; }
        if (done) break;
        if (P.solid2(S, b.s, b.y)) {
          const m = w.mat_at(wp.x, wp.y, wp.z);
          if (m === MAT.BEDROCK || m === MAT.STEEL || (b.pen += 0.05) > K.PEN) { sim().explode(S, wp, { W: 0.004, dmg: 0, name: 'sniper' }, b.owner); done = true; break; }
          const k = M.pow(K.KEEP, 0.05 * K.PEN_STEP); b.vs *= k; b.vy *= k; b.dmg *= k;
          if (!b.inSolid) { b.inSolid = true; w.carve(wp.x, wp.y, wp.z, 0.3); S.sectionDirty = true; }
        } else if (b.inSolid) { b.inSolid = false; w.carve(wp.x, wp.y, wp.z, 0.3); }
      }
      if (done) { sim().emit(S, 'shot', { weapon: 'sniper', to: P.to_world(S, b.s, b.y), end: 1 }); S.bullets.splice(i, 1); S.lastBoom = S.time; }
    }
  }
  function bat(S, a, ap, aim) {
    const K = A.BAT, c = P.to_world(S, ap.s + aim.s * 0.6, a.pos.y + aim.y * 0.6);
    let n = 0;
    // (P38 R1: a swing hits what is in FRONT of the batter (along the aim, not behind) and in line of sight: before the sphere also took
    // worms behind the batter and behind walls, worst with the range upgrade)
    const front = (p) => { const q = P.to_plane(S, p); return (q.s - ap.s) * aim.s + (p.y - a.pos.y) * aim.y > 0.05 && clear2(S, ap.s, a.pos.y, q.s, p.y); };
    for (const w of S.worms) if (!w.dead && w !== a && hypot3(w.pos, c) < K.REACH && front(w.pos)) {
      S.hitDir = pw(S, aim.s, aim.y); sim().hurt(S, w, K.DMG, C.DS.BAT); const v = pw(S, aim.s * K.PUSH, aim.y * K.PUSH + K.PUSH_UP);
      // P37-8: hit-stop: the worm is dented along the hit vector for K.DELAY s (render), THEN it is thrown (WP.step)
      if (!w.dead) { w.batHit = { t: S.time + K.DELAY, x: v.x, y: v.y, z: v.z }; w.rest = true; w.vel.x = w.vel.y = w.vel.z = 0; } else shove(S, w, v.x, v.y, v.z);
      n++;
    }
    for (const b of S.bodies) if (hypot3(b.pos, c) < K.REACH + b.rb && front(b.pos)) { const v = pw(S, aim.s, aim.y); SS.bodies.nudge(S, b, v, M.min(b.mass, 300) * 6); n++; }
    sim().emit(S, 'swing', { wormId: a.id, hit: n, x: c.x, y: c.y, z: c.z });
    used(S, 'bat'); return true;
  }

  /* ---------- utilities ---------- */
  function bellows(S, a, ap, aim) {
    const K = A.BELLOWS, s0 = ap.s + aim.s * 0.5, y0 = a.pos.y + aim.y * 0.5;
    const inCone = (s, y) => { const ds = s - s0, dy = y - y0, d = M.len2(ds, dy); return d < K.RANGE && d > 1e-3 && (ds * aim.s + dy * aim.y) / d >= K.COS ? d : -1; };
    const f = d => K.V0 * (1 - d / K.RANGE) + K.V1, fp = d => K.PV0 * (1 - d / K.RANGE) + K.PV1;   // worms (kL) / shells + props (kT)
    for (const w of S.worms) {
      if (w.dead || w === a) continue;
      const q = P.to_plane(S, w.pos); if (Math.abs(q.t) > C.HALF + 0.5) continue;
      const d = inCone(q.s, w.pos.y); if (d < 0 || !clear2(S, s0, y0, q.s - aim.s * 0.5, w.pos.y - aim.y * 0.5)) continue;
      const v = pw(S, aim.s * f(d), aim.y * f(d) + K.UP); shove(S, w, v.x, v.y, v.z);
    }
    for (const b of S.bodies) {
      const q = P.to_plane(S, b.pos); if (Math.abs(q.t) > C.HALF + b.rb) continue;
      const d = inCone(q.s, b.pos.y); if (d < 0) continue;
      SS.bodies.nudge(S, b, pw(S, aim.s, aim.y + 0.2), fp(d) * b.mass * M.clamp(100 / M.max(30, b.mass), 0.12, 1.5));
    }
    for (const p of S.proj) { const d = inCone(p.s, p.y); if (d >= 0) { p.vs += aim.s * fp(d); p.vy += aim.y * fp(d) + K.PUP * 0.5; } }
    for (let i = S.flames.length - 1; i >= 0; i--) { const q = P.to_plane(S, S.flames[i]); if (inCone(q.s, S.flames[i].y) >= 0) S.flames.splice(i, 1); }
    // the detector (user 2026-10-07): everything buried or ticking in the cone (planes 2 m either side) is revealed and
    // set off: mines go off after a short fuse, spring traps snap empty, bombs in flight burst soon
    // (P38 R1: and in the line of sight: the blast of air does not reach a trap behind a wall; the point tested is 0.3 m above the trap)
    const TR = A.TRAPS, inCone3 = p => { const q = P.to_plane(S, p); return Math.abs(q.t) < 2 && inCone(q.s, p.y) >= 0 && clear2(S, s0, y0, q.s, p.y + 0.3); };
    let found = 0;
    for (const b of S.bodies) if (b.prop === 'mine' && !b.disarmed && inCone3(b.pos)) { b.revealed = true; b.armed = true; const t = S.time + rr(S, TR.DETECT_FUSE0, TR.DETECT_FUSE1); if (b.det < 0 || b.det > t) b.det = t; found++; }
    for (let i = S.devices.length - 1; i >= 0; i--) { const d = S.devices[i]; if (d.kind === 'spring' && inCone3(d.pos)) { d.revealed = true; S.devices.splice(i, 1); sim().emit(S, 'spring', { x: d.pos.x, y: d.pos.y, z: d.pos.z }); found++; } }
    for (const p of S.proj) { const pd = C.PROJ[p.type] || {}; if (pd.bouncy && inCone(p.s, p.y) >= 0 && clear2(S, s0, y0, p.s, p.y)) { p.fuse = M.min(p.fuse, 0.3); found++; } }
    if (found) sim().log(S, `The bellows set off ${found} trap${found > 1 ? 's' : ''}!`, 0xffb27a);
    sim().emit(S, 'blow', { wormId: a.id, x: a.pos.x, y: a.pos.y, z: a.pos.z, ds: aim.s, dy: aim.y });
    used(S, 'bellows'); return true;
  }
  function scrambler(S, a, ap) {
    const K = A.SCRAMBLER; let n = 0;
    for (const p of S.proj) {
      const pd = C.PROJ[p.type] || {}; if (!pd.bouncy || p.scr || M.len2(p.s - ap.s, p.y - a.pos.y) > K.R || !clear2(S, ap.s, a.pos.y, p.s, p.y)) continue;
      p.fuse += K.ADD; p.scr = true; n++;
    }
    for (const b of S.bodies) if (b.prop === 'mine' && b.det >= 0 && !b.scr && hypot3(b.pos, a.pos) < K.R) { b.det += K.ADD; b.scr = true; n++; }
    sim().emit(S, 'scramble', { wormId: a.id, n, x: a.pos.x, y: a.pos.y, z: a.pos.z });
    sim().log(S, n ? `${n} fuse${n > 1 ? 's' : ''} +2 s.` : 'No fuse nearby.', sim().team_rgb(S, a.team));
    used(S, 'scrambler'); return true;
  }

  /* ---------- torch / drill (PoC torchStep / drillStep): the worm moves with the cut ---------- */
  function dig(S, a, ap, aim) {
    if (a.air || S.rope) { sim().log(S, 'Stand on the ground to dig.', 0xffb27a); return false; }
    const K = A.DIG, down = S.aim < -Math.PI / 4;
    const ds = down ? 0 : a.facing * M.cos(S.aim), dy = down ? -1 : M.sin(S.aim);
    S.dig = { mode: down ? 'drill' : 'torch', ds, dy, t: down ? K.DRILL_T : K.TORCH_T, v: down ? K.DRILL_V : K.TORCH_V, tick: 0, hit: [], warm: K.WARM, t0: S.time };
    sim().emit(S, 'dig', { wormId: a.id, mode: S.dig.mode });
    used(S, 'drill');
    return true;
  }
  function stepDig(S, dt) {
    const g = S.dig, a = S.active, K = A.DIG, w = W();
    if (!a || a.dead) { S.dig = null; return; }
    const ap = P.to_plane(S, a.pos);
    if (g.warm > 0) { g.warm -= dt; return; }                    // P37 W4: the mask goes down, the torch lights (render: render/worn.js), then it cuts
    g.t -= dt; g.tick -= dt;
    const ahead = P.to_world(S, ap.s + g.ds * (K.R + 0.35), a.pos.y + g.dy * (K.R + 0.35)), m = w.mat_at(ahead.x, ahead.y, ahead.z);
    if (g.t <= 0 || m === MAT.BEDROCK || m === MAT.STEEL || ahead.y < 0.8) { S.dig = null; sim().emit(S, 'digend', { wormId: a.id}); return; }
    if (g.tick <= 0) {
      g.tick = K.TICK;
      const c = P.to_world(S, ap.s + g.ds * 0.35, a.pos.y + g.dy * 0.35);
      if (w.carve(c.x, c.y, c.z, K.R) > 0) { edited(S, c.x, c.y, c.z, K.R); sim().emit(S, 'sparks', { x: ahead.x, y: ahead.y, z: ahead.z, mode: g.mode }); }
      for (const o of S.worms) if (!o.dead && o !== a && g.hit.indexOf(o.id) < 0 && hypot3(o.pos, c) < K.R + C.WORM_R) {
        g.hit.push(o.id); sim().hurt(S, o, K.DMG, C.DS.TORCH); const v = pw(S, g.ds * K.PUSH, g.dy * K.PUSH + K.PUSH * 0.5); shove(S, o, v.x, v.y, v.z);
      }
      for (const b of S.bodies) if (b.prop && (b.prop === 'crate' || b.prop === 'barrel') && hypot3(b.pos, c) < K.R + b.rb) SS.scatter.ignite(S, b);
    }
    // move with the cut where there is room
    const ns = ap.s + g.ds * g.v * dt, ny = a.pos.y + g.dy * g.v * dt;
    if (P.overlap2(S, ns, ny) <= 1) { const p = P.to_world(S, ns, ny); a.pos.x = p.x; a.pos.y = ny; a.pos.z = p.z; a.vs = 0; a.vy = 0; a.air = false; }
  }

  /* ---------- black hole (PoC spawnHole / updateHoles) ---------- */
  function spawnHole(S, pos) { sim().pool_push(S.holes, C.LIMITS.HOLES, { x: pos.x, y: pos.y, z: pos.z, t: 0, carveT: 0, breakT: 0, broken: 0 }); sim().emit(S, 'hole', { x: pos.x, y: pos.y, z: pos.z }); }
  /* Black hole. PoC: a weak pull on worms, bodies and shells, a small carve at the core, a blast at the end.
   * P29c (user 2026-10-08: "the black hole should suck in nearby worms and objects, and break apart some ground near
   * by"): within SUCK_R the pull overcomes the ground (gravity is cancelled progressively toward the core, so things
   * float up and fall IN); at the core worms are held (burning) until the end blast throws them out; rock chunks and
   * loose debris reaching the core are consumed; every BREAK_T s a ~1 m blob of the nearby ground (within BREAK_R)
   * breaks off as a rigid rock chunk and falls in (BREAK_MAX per hole). Deterministic (armRng). */
  function stepHoles(S, dt) {
    const K = A.HOLE;
    for (let i = S.holes.length - 1; i >= 0; i--) {
      const h = S.holes[i]; h.t += dt; const k = M.min(1, h.t / K.GROW);
      holeWorms(S, h, k, dt);
      holeBodies(S, h, k, dt);
      const hp = P.to_plane(S, h), acc = d => M.min(K.A_MAX, K.A_K / (d * d + K.A_D2)) * k;
      for (const p of S.proj) { const ds = hp.s - p.s, dy = h.y - p.y, d = M.len2(ds, dy); if (d > K.PULL_R || d < 1e-3) continue; const a = acc(d) * dt; p.vs += ds / d * a; p.vy += dy / d * a; }
      h.carveT -= dt;
      if (h.carveT <= 0) { h.carveT = K.CARVE_T; const R = K.CARVE_R0 + (K.CARVE_R1 - K.CARVE_R0) * k; if (W().carve(h.x, h.y, h.z, R) > 0) edited(S, h.x, h.y, h.z, R); }
      holeBreak(S, h, k, dt);
      if (h.t >= K.LIFE) { S.holes.splice(i, 1); sim().explode(S, h, { W: K.W_END, dmg: 44, name: 'black hole' }, null); }   // PoC (.., 64, 44)
      S.lastBoom = S.time;
    }
  }
  // suction acceleration (m/s²) at distance d, and the share of gravity cancelled there (1 at the core, 0 at SUCK_R)
  const suckA = (K, d, k) => K.SUCK_K / (d * d + 1) * k;
  const suckLev = (K, d, k) => k * M.clamp((K.SUCK_R - d) / (K.SUCK_R - K.CAPTURE_R), 0, 1);
  function holeWorms(S, h, k, dt) {
    const K = A.HOLE;
    for (const w of S.worms) {
      if (w.dead) continue;
      const dx = h.x - w.pos.x, dy = h.y - w.pos.y, dz = h.z - w.pos.z, d = M.len3(dx, dy, dz);
      if (d > K.W_PULL_R || d < 1e-3) continue;
      if (d < K.SUCK_R && h.t >= K.GROW) {
        // suction (kinematic: small per-step kicks were eaten by the ground contact / rest state, a worm 3 m away moved
        // 0.8 m in the hole's whole life): off the ground, gravity cancelled, the velocity eases toward an inward speed
        // that grows toward the core; captured (held, burning) inside CAPTURE_R until the end blast throws it out
        const vIn = d < K.CAPTURE_R ? 0 : K.SUCK_V * (1 - d / K.SUCK_R) + 1.0, bl = 1 - M.exp(-K.SUCK_BLEND * dt);
        const tx = dx / d * vIn, ty = dy / d * vIn + 0.4, tz = dz / d * vIn;
        if (sim().ctl(S, w)) {
          const pd = P.dir(S), ts = tx * pd.x + tz * pd.z;
          w.vs += (ts - w.vs) * bl; w.vy += (ty - w.vy) * bl + C.G_WORM * (sim().gravity_k ? sim().gravity_k(S, w) : 1) * dt; w.air = true; if (S.rope) S.rope = null;
        } else {
          w.rest = false;
          w.vel.x += (tx - w.vel.x) * bl; w.vel.y += (ty - w.vel.y) * bl + C.G_WORM * (sim().gravity_k ? sim().gravity_k(S, w) : 1) * dt; w.vel.z += (tz - w.vel.z) * bl;
        }
      } else {
        const a = M.min(K.W_A_MAX, K.W_A_K / (d * d + K.W_A_D2)) * k * dt;    // the PoC pull (whole range)
        shove(S, w, dx / d * a, dy / d * a, dz / d * a);
      }
      if (d < K.CORE) sim().burn(S, w, K.CORE_DPS, dt, C.DS.BLACK_HOLE);
    }
  }
  function holeBodies(S, h, k, dt) {
    const K = A.HOLE;
    for (let j = S.bodies.length - 1; j >= 0; j--) {
      const b = S.bodies[j], dx = h.x - b.pos.x, dy = h.y - b.pos.y, dz = h.z - b.pos.z, d = M.len3(dx, dy, dz);
      if (d > K.PULL_R * 0.92 || d < 1e-3) continue;
      // consumed: loose rock / debris that reaches the core (props stay for the end blast: mines, barrels, crates)
      if (d < K.CAPTURE_R * 0.8 && !b.prop && h.t > K.GROW) { SS.bodies.remove(S, b); sim().emit(S, 'consumed', { x: b.pos.x, y: b.pos.y, z: b.pos.z, m: b.mass }); continue; }
      let a = M.min(900 * C.SCALE.kA * 30, M.min(K.A_MAX, K.A_K / (d * d + K.A_D2)) * k) * 0.7;
      let up = 0;
      if (d < K.SUCK_R) { a += suckA(K, d, k); up = C.G * suckLev(K, d, k); }
      // a little swirl about the vertical (things spiral in)
      const sw = d < K.SUCK_R ? K.SWIRL * a : 0, tx = -dz / d, tz = dx / d;
      SS.bodies.nudge(S, b, { x: dx / d * a + tx * sw, y: dy / d * a + up, z: dz / d * a + tz * sw }, M.len3(a, up, sw) * dt * b.mass);
    }
  }
  // the ground near the hole breaks up: a ~BREAK_BLOB m blob of the solid surface within BREAK_R becomes a rock chunk
  function holeBreak(S, h, k, dt) {
    const K = A.HOLE;
    if (h.t < K.GROW || (h.broken | 0) >= K.BREAK_MAX || !SS.collapse || !SS.bodies) return;
    h.breakT -= dt;
    if (h.breakT > 0) return;
    h.breakT = K.BREAK_T;
    const w = W(), H = w.H, NX = w.NX, NY = w.NY, NZ = w.NZ;
    // a direction from the hole (mostly downward / sideways: the ground), march to the first solid point
    const th = rr(S, 0, 6.2832), el = rr(S, -1.2, 0.35), dx = M.cos(th) * M.cos(el), dy = M.sin(el), dz = M.sin(th) * M.cos(el);
    let hit = -1;
    for (let r = K.CAPTURE_R; r <= K.BREAK_R; r += 0.25) if (w.sample(h.x + dx * r, h.y + dy * r, h.z + dz * r) > 0) { hit = r; break; }
    if (hit < 0) return;
    const cx = h.x + dx * (hit + K.BREAK_BLOB * 0.5), cy = h.y + dy * (hit + K.BREAK_BLOB * 0.5), cz = h.z + dz * (hit + K.BREAK_BLOB * 0.5), R = K.BREAK_BLOB;
    const comp = [];
    for (let kk = M.max(1, Math.floor((cz - R) / H)); kk <= M.min(NZ - 2, Math.ceil((cz + R) / H)); kk++)
      for (let jj = M.max(1, Math.floor((cy - R) / H)); jj <= M.min(NY - 2, Math.ceil((cy + R) / H)); jj++)
        for (let ii = M.max(1, Math.floor((cx - R) / H)); ii <= M.min(NX - 2, Math.ceil((cx + R) / H)); ii++) {
          const o = (kk * NY + jj) * NX + ii, ex = ii * H - cx, ey = jj * H - cy, ez = kk * H - cz;
          if (w.d[o] > 0 && w.mat[o] !== C.MAT.LAVA && w.mat[o] !== C.MAT.STEEL && ex * ex + ey * ey + ez * ez < R * R) comp.push(o);
        }
    if (comp.length < 22) return;                                              // (detach makes rigid pieces from >= 22)
    const r = SS.collapse.detach(w, comp, S.armRng || S.rng);
    let n = 0;
    for (const pc of r.pieces) {
      const b = SS.bodies.from_piece(S, pc); n++;
      const ex = h.x - b.pos.x, ey = h.y - b.pos.y, ez = h.z - b.pos.z, l = M.nz(M.len3(ex, ey, ez), 1);
      b.vel.x += ex / l * K.BREAK_V; b.vel.y += ey / l * K.BREAK_V + 1.5; b.vel.z += ez / l * K.BREAK_V;
    }
    if (r.rubble.length) sim().emit(S, 'rubble', { pts: r.rubble.slice(0, 24) });
    edited(S, cx, cy, cz, R + 0.5);
    h.broken = (h.broken | 0) + n;
    if (n) sim().emit(S, 'holebreak', { x: cx, y: cy, z: cz, pieces: n });
  }

  /* ---------- foam (PoC growFoam): an ellipsoid of FOAM in air only; never entombs a worm / body / shell ---------- */
  function growFoam(S, pos, p) {
    const F = (C.PROJ.foam.foam), w = W(), H = w.H, d = P.dir(S), n = P.nrm(S), keep = [];
    for (const o of S.worms) if (!o.dead && hypot3(o.pos, pos) < F.rx + 1.5) keep.push([o.pos, C.WORM_R + 0.35]);
    for (const b of S.bodies) if (hypot3(b.pos, pos) < F.rx + b.rb + 1) keep.push([b.pos, b.rb + 0.3]);
    for (const q of S.proj) if (q !== p) { const qp = P.to_world(S, q.s, q.y); if (hypot3(qp, pos) < F.rx + 1) keep.push([qp, 0.4]); }
    const sea = sim().surface_at(S, pos.x, pos.z);
    const i0 = M.max(1, Math.floor((pos.x - F.rx - F.rz) / H)), i1 = M.min(w.NX - 2, Math.ceil((pos.x + F.rx + F.rz) / H));
    const j0 = M.max(1, Math.floor((pos.y - F.ry) / H)), j1 = M.min(w.NY - 2, Math.ceil((pos.y + F.ry) / H));
    const k0 = M.max(1, Math.floor((pos.z - F.rx - F.rz) / H)), k1 = M.min(w.NZ - 2, Math.ceil((pos.z + F.rx + F.rz) / H));
    let nf = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const o = (k * w.NY + j) * w.NX + i; if (w.d[o] > 0) continue;
      const x = i * H, y = j * H, z = k * H, ds = (x - pos.x) * d.x + (z - pos.z) * d.z, dt = (x - pos.x) * n.x + (z - pos.z) * n.z;
      const ea = ds / F.rx, eb = (y - pos.y) / F.ry, ec = dt / F.rz, e = Math.sqrt(ea * ea + eb * eb + ec * ec);
      if (e > 1.15 || y < sea - 0.6) continue;
      let blocked = false; for (const [c, r] of keep) if (M.len3(x - c.x, y - c.y, z - c.z) < r) { blocked = true; break; }
      if (blocked) continue;
      const v = (1 - e) * 1.2;                                     // ~ signed distance (m) to the ellipsoid surface
      if (v > w.d[o]) { w.d[o] = v; if (v > 0) { w.mat[o] = MAT.FOAM; w.heat[o] = 0; nf++; } }
    }
    w.mark(i0, j0, k0, i1, j1, k1);
    sim().emit(S, 'foam', { x: pos.x, y: pos.y, z: pos.z, n: nf });
    edited(S, pos.x, pos.y, pos.z, F.rx + F.rz);
  }

  /* ---------- fire (napalm, flames): burning patches = scatter's S.flames (they burn worms, light props) + grass ---------- */
  function firePatch(S, pos, r) {
    const w = W(); let y = pos.y;
    const top = w.top_at(pos.x, pos.z); if (top > -1e8 && Math.abs(top - y) < 2.5) y = top;
    if (y < sim().surface_at(S, pos.x, pos.z) + 0.05) { sim().emit(S, 'steam', { x: pos.x, y, z: pos.z, power: 0.3 }); return; }
    sim().pool_push(S.flames, C.LIMITS.FLAMES, { x: pos.x, y, z: pos.z, r, t1: S.time + rr(S, A.NAPALM.LIFE0, A.NAPALM.LIFE1), napalm: 1 });
    if (SS.veg && SS.veg.ignite_disc) SS.veg.ignite_disc(S, pos.x, y, pos.z, r + 0.4, 1);
  }
  WP.fire_patch = firePatch;
  function napalmBurst(S, p) {
    const pd = C.PROJ.napalm, wp = P.to_world(S, p.s, p.y);
    sim().emit(S, 'airburst', { x: wp.x, y: p.y, z: wp.z });
    for (let i = 0; i < pd.napalm.n; i++) {
      const a = rr(S, 0, Math.PI * 2), v = rr(S, pd.napalm.v0, pd.napalm.v1);
      WP.launch(S, 'flame', p.s, p.y, M.cos(a) * v + 0.3 * p.vs, M.sin(a) * v + 0.3 * p.vy, -1);
    }
  }

  /* ---------- planes (air strike, napalm) ---------- */
  function stepStrikes(S, dt) {
    const Pl = A.PLANE;
    for (let i = S.strikes.length - 1; i >= 0; i--) {
      const st = S.strikes[i], prev = st.s; st.s += st.dir * Pl.SPEED * dt;
      while (st.k < st.rel.length && (st.s - st.rel[st.k]) * st.dir >= 0 && (prev - st.rel[st.k]) * st.dir < 0 + 1e-9) {
        const p = WP.launch(S, st.kind === 'napalm' ? 'napalm' : 'missile', st.rel[st.k], st.y - 0.4, st.dir * Pl.DROP_VS, Pl.DROP_VY, st.owner);
        if (st.burstY != null) p.burstY = st.burstY;
        st.k++;
      }
      if (st.k >= st.rel.length && (st.s - st.tS) * st.dir > Pl.START) S.strikes.splice(i, 1);
      S.lastBoom = S.time;
    }
  }

  /* ---------- thunder strike (PoC lightningStrike + electrocute) ---------- */
  WP.electrocute = (S, c, R, D, owner) => electrocute(S, c, R, D, owner);
  function electrocute(S, c, R, D, owner) {
    const K = A.TESLA; let zapped = 0;                                          // (bit mask of the worm ids already zapped)
    const zap = (w, dmg, from) => {
      if ((zapped & (1 << w.id)) || w.dead) return; zapped |= 1 << w.id;
      sim().hurt(S, w, M.max(1, Math.round(dmg)), C.DS.LIGHTNING);
      shove(S, w, rr(S, -1, 1) * 1.6, K.PUSH_UP, rr(S, -1, 1) * 1.6);
      sim().emit(S, 'zap', { wormId: w.id, from: { x: from.x, y: from.y, z: from.z }, to: { x: w.pos.x, y: w.pos.y, z: w.pos.z } });
      if (dmg > 4) for (const o of S.worms) if (!o.dead && !(zapped & (1 << o.id)) && hypot3(o.pos, w.pos) < K.CHAIN_R) zap(o, dmg / 2, w.pos);
    };
    for (const w of S.worms) if (!w.dead && hypot3(w.pos, c) < R) zap(w, D, c);
    // metal props conduct (mines, barrels, girders): worms touching them take 70 %
    for (const b of S.bodies) if ((b.prop === 'mine' || b.prop === 'barrel' || b.prop === 'girder' || b.metal) && hypot3(b.pos, c) < R + b.rb) {
      for (const w of S.worms) if (!w.dead && hypot3(w.pos, b.pos) < b.rb + K.CONDUCT_R) zap(w, D * 0.7, b.pos);
      if (b.prop === 'barrel') SS.scatter.ignite(S, b);
    }
  }
  function stepZaps(S) {
    const K = A.TESLA, w = W();
    for (let i = S.zaps.length - 1; i >= 0; i--) {
      const z = S.zaps[i]; if (S.time < z.t) continue;
      S.zaps.splice(i, 1);
      let y = groundBelow(S, z.s, w.SY - 0.5); if (y < -1e8) y = w.SEA;
      const sea = sim().surface_at(S, P.to_world(S, z.s, y).x, P.to_world(S, z.s, y).z); if (y < sea) y = sea;
      // a worm standing in the column is hit first
      const top = P.to_world(S, z.s, y);
      for (const o of S.worms) if (!o.dead && Math.abs(P.to_plane(S, o.pos).s - z.s) < 0.6 && Math.abs(P.to_plane(S, o.pos).t) < C.HALF && o.pos.y > y - 0.2) { top.y = M.max(top.y, o.pos.y + 0.5); }
      sim().emit(S, 'lightning', { x: top.x, y: top.y, z: top.z, seed: (S.turnNo * 7919 + i) >>> 0, weapon: 1 });
      S.lightning = 1;                                                // (tinfoil hats take 10 %: sim.hurt)
      sim().explode(S, top, { W: K.W, dmg: 10, name: 'lightning' }, z.owner);   // PoC (.., 24, 10)
      electrocute(S, top, K.R1, K.D1, z.owner);
      electrocute(S, top, K.R2, K.D2, z.owner);
      S.lightning = 0;
      for (let q = 0; q < 3; q++) firePatch(S, { x: top.x + rr(S, -1, 1), y: top.y, z: top.z + rr(S, -0.4, 0.4) }, 0.4);
      S.lastBoom = S.time;
    }
  }

  /* ---------- moai: smashes on its first two hard impacts, shatters (PoC bodyImpactEffects) ---------- */
  function stepMoais(S, dt) {
    const K = A.MOAI;
    for (let i = S.moais.length - 1; i >= 0; i--) {
      const m = S.moais[i], b = SS.bodies.by_id(S, m.body), alive = b !== null;
      const v = alive ? M.len3(b.vel.x, b.vel.y, b.vel.z) : 0;
      if (alive && m.v > K.SMASH_V && m.v - v > K.SMASH_V * 0.6 && m.smash < K.SMASH_N) {
        m.smash++; sim().explode(S, { x: b.pos.x, y: b.pos.y - 1.0, z: b.pos.z }, { W: K.W, dmg: 28, name: 'the moai' }, m.owner);   // PoC (.., 32, 28)
        b.w.x *= 0.2; b.w.y *= 0.2; b.w.z *= 0.2;
      }
      m.v = v;
      if (!alive || m.smash >= K.SMASH_N || S.time - m.t0 > K.LIFE || b.asleep) {
        if (alive) { SS.bodies.remove(S, b); sim().emit(S, 'shatter', { x: b.pos.x, y: b.pos.y, z: b.pos.z, kind: 'moai' }); }
        S.moais.splice(i, 1);
      }
      S.lastBoom = S.time;
    }
  }

  /* ---------- devices: pocket magnet, spring mine ---------- */
  function devHit(S, wp, dmg) {
    for (const d of S.devices) if (hypot3(d.pos, wp) < 0.4) { d.hp -= dmg; return true; }
    return false;
  }
  const METAL = p => !!(C.PROJ[p.type] || {}).metal;
  function stepDevices(S, dt) {
    const w = W();
    for (let i = S.devices.length - 1; i >= 0; i--) {
      const d = S.devices[i];
      if (d.hp <= 0) { S.devices.splice(i, 1); sim().emit(S, 'devbreak', { x: d.pos.x, y: d.pos.y, z: d.pos.z, kind: d.kind }); continue; }
      // falls to the ground below (in its own plane: devices keep the plane they were dropped in)
      const below = w.sample(d.pos.x, d.pos.y - 0.18, d.pos.z) > 0 || (SS.struct && SS.struct.floor_at(S, d.pos.x, d.pos.y, d.pos.z) > d.pos.y - 0.2);
      if (!below) { d.vy -= C.G * dt; d.pos.y += d.vy * dt; if (d.pos.y < 0.3 || d.pos.y < sim().surface_at(S, d.pos.x, d.pos.z) - 0.5) { S.devices.splice(i, 1); continue; } }
      else { d.vy = 0; while (w.sample(d.pos.x, d.pos.y - 0.1, d.pos.z) > 0 && d.pos.y < w.SY) d.pos.y += 0.05; }
      d.t += dt; d.cool = M.max(0, d.cool - dt);
      if (d.kind === 'magnet' && d.t > A.MAGNET.ARM && below) {
        const K = A.MAGNET, dp = P.to_plane(S, d.pos);
        for (const p of S.proj) if (METAL(p)) { const ds = dp.s - p.s, dy = d.pos.y - p.y, r = M.len2(ds, dy); if (r > 0.8 && r < K.R && Math.abs(dp.t) < C.HALF + 1) { const a = K.A * (1 - r / K.R) * dt; p.vs += ds / r * a; p.vy += dy / r * a; } }
        for (const b of S.bodies) if (b.prop === 'mine' || b.prop === 'barrel' || b.prop === 'girder') { const r = hypot3(b.pos, d.pos); if (r > 0.8 && r < K.R) SS.bodies.nudge(S, b, { x: d.pos.x - b.pos.x, y: d.pos.y - b.pos.y, z: d.pos.z - b.pos.z }, M.min(b.mass, K.KG_CAP) * K.A * (1 - r / K.R) * dt); }
      }
      // the spring trap (user 2026-10-07): buried, for WORMS only (no props, shells or branches); a worm stepping on
      // it is thrown high: 20 HP for the jolt, and its landing hurts at least 20 (w.springFall, sim.js landings)
      if (d.kind === 'spring' && d.cool <= 0 && d.charges > 0 && d.t > A.SPRING.ARM && below) {
        const K = A.SPRING, side = { x: M.cos(d.theta) * Math.sign(d.ds || 1), z: M.sin(d.theta) * Math.sign(d.ds || 1) };
        let fired = false;
        // (P38 R1: the trap is the planting TEAM's: it knows where it lies (info: "only your team sees", "an enemy worm"), so the planter and its
        // teammates walk over it safely; before it threw its own worm the moment the 1.5 s arming passed)
        for (const o of S.worms) if (!o.dead && o.hp > 0 && o.team !== d.team && hypot3(o.pos, d.pos) < K.R + C.WORM_R && o.pos.y - d.pos.y < 1.2) {
          sim().hurt(S, o, K.DMG, C.DS.SPRING);
          o.springFall = true; o.pos.y += 0.1;
          if (sim().ctl(S, o)) { const pd = P.dir(S); o.vs = (side.x * pd.x + side.z * pd.z) * K.V_SIDE; o.vy = K.V_UP; o.air = true; S.rope = null; }
          else { o.rest = false; o.vel.x = side.x * K.V_SIDE; o.vel.y = K.V_UP; o.vel.z = side.z * K.V_SIDE; }
          fired = true; d.revealed = true;
          sim().log(S, `${o.name} steps on a spring trap!`, 0xffb27a);
        }
        if (fired) { d.charges--; d.cool = K.COOL; S.lastBoom = S.time; sim().emit(S, 'spring', { x: d.pos.x, y: d.pos.y, z: d.pos.z }); if (d.charges <= 0) S.devices.splice(i, 1); }
      }
    }
  }

  /* ---------- supply crates (PoC dropCrate / collectCrate): parachute, wind drift, health or a weapon ---------- */
  const CR = { CHANCE: 0.3, HEALTH: 0.45, HP: 30, FALL: 55 * C.SCALE.kT, DRIFT: 0.35, PICK: 1.1, HOLD: 4, W: M.pow(34 / 44, 3), MAX: 24, MAX_TOOL: 10 };     // MAX: P38 R1 cap on S.crates (landed crates were never removed: 80 after a long chaos match)
  WP.CRATE = CR;
  /* P38 R3: room for one more crate of a class: weapon + health crates share CR.MAX, tool crates have their own CR.MAX_TOOL (they
   * used to crowd the weapon crates out). When the class is full the OLDEST landed crate of it is removed (propbreak) instead of
   * refusing, so unreachable crates never stop the supply for good. false: full of crates still in the air / held / thrown. */
  WP.crate_room = function (S, tool) {
    const cap = tool ? CR.MAX_TOOL : CR.MAX; let n = 0, old = -1;
    for (let i = 0; i < S.crates.length; i++) {
      const c = S.crates[i]; if ((c.kind === 'tool') !== !!tool) continue; n++;
      if (c.landed && !c.held && !c.thrown && (old < 0 || c.t0 < S.crates[old].t0)) old = i;
    }
    if (n < cap) return true;
    if (old < 0) return false;
    const k = S.crates[old]; S.crates.splice(old, 1); sim().emit(S, 'propbreak', { x: k.pos.x, y: k.pos.y, z: k.pos.z, kind: 'crate', why: 'expired' });
    return true;
  };
  WP.turn_start = function (S, first) {
    for (let i = S.devices.length - 1; i >= 0; i--) { const d = S.devices[i]; if (--d.turns <= 0) { S.devices.splice(i, 1); sim().emit(S, 'devbreak', { x: d.pos.x, y: d.pos.y, z: d.pos.z, kind: d.kind, expired: 1 }); } }
    S.shots = 0; S.tgt = null; S.dig = null;
    if (SS.weaponsA) SS.weaponsA.turn_start(S);
    if (SS.gadgets) SS.gadgets.turn_start(S);
    if (SS.ffield) SS.ffield.turn_start(S);
    if (SS.skills) SS.skills.turn_start(S, first);                  // P37 W4: tool deliveries
    // PoC applyTurnStart: the strike side resets to downwind every turn (the in-plane wind at the worm)
    if (S.active && SS.weather && SS.weather.wind_at) { const wv = { x: 0, y: 0, z: 0 }, a = S.active, d = P.dir(S); SS.weather.wind_at(S, a.pos.x, a.pos.y + 6, a.pos.z, wv); S.strikeDir = wv.x * d.x + wv.z * d.z >= 0 ? 1 : -1; }
    if (first || S.turnNo < 2 || rng(S) >= CR.CHANCE || !S.active || W().under) return;
    if (!WP.crate_room(S, false)) return;                            // (P38 R3: full -> the oldest landed crate goes; only crates still in the air refuse)
    // a crate falls onto the new turn's section, somewhere it can be reached (± 25 m along it)
    for (let tries = 0; tries < 12; tries++) {
      const s = rr(S, -25, 25), gy = groundBelow(S, s, W().SY - 0.5), at = P.to_world(S, s, gy);
      if (gy < -1e8 || gy < sim().surface_at(S, at.x, at.z) + 0.3 || (W().dry && !sim().in_play(S, at.x, at.z))) continue;
      const kind = rng(S) < CR.HEALTH ? 'health' : 'weapon', weapon = kind === 'weapon' ? (SS.balance ? SS.balance.crate_pick(rng(S)) : C.CRATE_POOL[Math.floor(rng(S) * C.CRATE_POOL.length)]) : null;   // P38 A2: weighted by rarity band (sim/balance.js)
      S.crates.push(WP.crate_make(S, kind, weapon, null, P.to_world(S, s, M.min(W().SY - 1, gy + 14))));
      sim().emit(S, 'banner', { title: 'Supply drop', sub: 'It drifts with the wind' });
      return;
    }
  };
  /* P38-A4: a crate thrown with the gravity gun flies ballistically (c.vel, c.thrown), tumbling; it hurts the worm it hits
   * (CRATE_DMG_K HP per m/s, at most CRATE_DMG_MAX, nothing under CRATE_DMG_MIN_V) and stops dead on it, then lands on the ground
   * where whoever's turn it is picks it up (not the thrower for CRATE_LOCK s). Returns false when it fell into the sea / out. */
  function flyCrate(S, c, dt) {
    const w = W(), KG = (C.TOOLB && C.TOOLB.GRAV) || { CRATE_DMG_K: 0.9, CRATE_DMG_MAX: 22, CRATE_DMG_MIN_V: 4 };
    c.vel.y -= C.G * dt;
    const n = M.max(1, Math.ceil(M.len3(c.vel.x, c.vel.y, c.vel.z) * dt / 0.15)), h = dt / n;
    for (let q = 0; q < n; q++) {
      const nx = c.pos.x + c.vel.x * h, ny = c.pos.y + c.vel.y * h, nz = c.pos.z + c.vel.z * h, sp = M.len3(c.vel.x, c.vel.y, c.vel.z);
      for (const o of S.worms) {
        if (o.dead || o.drowning || o.id === c.by && S.time < c.pickT - 1.0) continue;
        if (M.len3(o.pos.x - nx, o.pos.y - ny, o.pos.z - nz) < C.WORM_R + 0.35 && sp > KG.CRATE_DMG_MIN_V) {
          const dmg = M.min(KG.CRATE_DMG_MAX, Math.round(KG.CRATE_DMG_K * sp));
          S.hitDir = { x: c.vel.x / sp, y: 0.25, z: c.vel.z / sp };
          sim().hurt(S, o, dmg, C.DS.FLY_SUPPLY_CRATE, C.HF.DOT);
          sim().emit(S, 'cratehit', { x: nx, y: ny, z: nz, wormId: o.id, dmg });
          c.vel.x *= 0.15; c.vel.y = Math.abs(c.vel.y) * 0.1; c.vel.z *= 0.15; c.by = -1;
          break;
        }
      }
      if (w.sample(nx, ny - 0.3, nz) > 0 || w.sample(nx, ny, nz) > 0) {                          // lands
        if (c.vel.y < -1) sim().emit(S, 'cratedrop', { x: c.pos.x, y: c.pos.y, z: c.pos.z, v: -c.vel.y });
        c.landed = true; c.thrown = 0; c.vel = null; c.pos.y = M.max(c.pos.y, 0);
        for (let k = 0; k < 40 && w.sample(c.pos.x, c.pos.y - 0.3, c.pos.z) > 0; k++) c.pos.y += 0.05;
        return true;
      }
      c.pos.x = nx; c.pos.y = ny; c.pos.z = nz;
      if (c.pos.y < sim().surface_at(S, c.pos.x, c.pos.z) || c.pos.y < 0.3) { sim().emit(S, 'splash', { x: c.pos.x, y: c.pos.y, z: c.pos.z, size: 0.8 }); return false; }
    }
    return true;
  }
  const wv = { x: 0, y: 0, z: 0 };
  function stepCrates(S, dt) {
    const w = W(), a = S.active;
    for (let i = S.crates.length - 1; i >= 0; i--) {
      const c = S.crates[i];
      if (c.held) continue;                                                                      // P38-A4: in the gravity gun's beam
      if (c.thrown && !c.landed) { if (!flyCrate(S, c, dt)) S.crates.splice(i, 1); continue; }
      if (!c.landed) {
        if (SS.weather) SS.weather.wind_at(S, c.pos.x, c.pos.y, c.pos.z, wv); else { wv.x = wv.z = 0; }
        c.pos.x += wv.x * CR.DRIFT * dt; c.pos.z += wv.z * CR.DRIFT * dt; c.pos.y -= CR.FALL * dt;
        if (w.sample(c.pos.x, c.pos.y - 0.35, c.pos.z) > 0) { c.landed = true; while (w.sample(c.pos.x, c.pos.y - 0.3, c.pos.z) > 0) c.pos.y += 0.05; }
        if (c.pos.y < sim().surface_at(S, c.pos.x, c.pos.z) || c.pos.y < 0.3) { S.crates.splice(i, 1); sim().emit(S, 'splash', { x: c.pos.x, y: c.pos.y, z: c.pos.z, size: 0.8 }); continue; }
      } else if (w.sample(c.pos.x, c.pos.y - 0.4, c.pos.z) <= 0) c.landed = false;                 // ground blasted away
      if (c.landed && a && !a.dead && sim().ctl(S, a) && hypot3(a.pos, c.pos) < CR.PICK * (SS.lab ? SS.lab.pick_k(S, a) : 1) && !(c.by === a.id && S.time < (c.pickT || 0))) {   // (PoC: not while it still hangs on its chute)
        S.crates.splice(i, 1);
        if (c.kind === 'tool' && SS.skills) SS.skills.pickup(S, a, c);
        else if (c.kind === 'health') { a.hp += CR.HP; if (SS.weaponsA && a.gas) SS.weaponsA.cure(S, a); sim().emit(S, 'pickup', { wormId: a.id, kind: 'health', amount: CR.HP }); sim().log(S, `${a.name} picks up +${CR.HP} HP.`, 0x79d98b); }
        else { const t = S.teams[a.team]; if (t.ammo[c.weapon] !== Infinity) t.ammo[c.weapon] = (t.ammo[c.weapon] || 0) + 1; sim().emit(S, 'pickup', { wormId: a.id, kind: 'weapon', weapon: c.weapon }); sim().log(S, `${a.name} finds a ${C.ARSENAL[c.weapon].name}.`, 0xffb02e); }
      }
    }
  }
  /* PoC: an impact shell meeting a parachuting supply crate bursts on it; an air-strike missile turns it into a
   * "napalm crate" (a small blast + 26 burning fuel gobs: PoC napalmCrate) */
  WP.crate_hit = function (S, p, wp) {
    if (!S.crates.length || p.type !== 'missile') return false;
    for (let i = 0; i < S.crates.length; i++) {
      const c = S.crates[i]; if (c.landed || hypot3(c.pos, wp) > 0.75) continue;
      if (p.type === 'missile') {
        S.crates.splice(i, 1);
        sim().explode(S, c.pos, { W: M.pow(16 / 44, 3), dmg: 10, name: 'a napalm crate', boom: C.BOOM.FUEL }, p.owner);   // PoC (.., 16, 10)
        const cp = P.to_plane(S, c.pos);
        for (let k = 0; k < 26; k++) { const a = rr(S, 0, Math.PI * 2), v = rr(S, 1.5, 7); WP.launch(S, 'fuel', cp.s, c.pos.y, M.cos(a) * v, M.sin(a) * v * 0.6 + 1.5, -1); }
        sim().emit(S, 'banner', { title: 'Napalm crate!', sub: 'The missile lit the supply drop' });
        return true;
      }
      return false;            // P24.7 (PoC L3380): only air-strike missiles meet a falling crate; other shells pass by
    }
    return false;
  };
  // blasts reach devices and crates (sim.explode calls this)
  // PoC explode(): every object within the pressure range 2.1 R (R = 44 px W^1/3 = 2.83 m W^1/3): a gadget loses
  // dmg x pressureFactor HP, a crate is removed (a weapon crate goes off 0.12 s later: R34 dmg 30)
  WP.blast = function (S, c, Wkg, dmg) {
    const R = 2.83 * M.cbrt(Wkg), dP = dmg != null ? dmg : 50 * M.pow(Wkg, 0.28);
    for (const d of S.devices) { const f = SS.blast.poc_factor(hypot3(d.pos, c), R); if (f > 0) d.hp -= dP * f; }
    if (SS.gadgets) SS.gadgets.blast(S, c, Wkg, dmg);
    if (SS.ffield) SS.ffield.blast(S, c, Wkg, dmg);
    for (let i = S.crates.length - 1; i >= 0; i--) {
      const k = S.crates[i]; if (hypot3(k.pos, c) > 2.1 * R) continue;
      S.crates.splice(i, 1);
      if (k.kind === 'weapon') sim().schedule(S, 0.12, k.pos, CR.W, 'crate', null, 30);
      else sim().emit(S, 'propbreak', { x: k.pos.x, y: k.pos.y, z: k.pos.z, kind: 'crate', why: 'blast' });
    }
  };

  WP.tele_hold = function (w, x, y, z) { w.teleHold = A.TELEPORT.HOLD; w.teleX = x; w.teleY = y; w.teleZ = z; };
  WP.step = function (S, dt) {
    if (S.teleT > 0) S.teleT -= dt;
    /* teleport / placement: a worm hangs where it rematerialises until the beam has fully built it (A.TELEPORT.HOLD s;
     * render/actors.js fades it in over the same time); only then gravity takes it (WP.step runs after the worm
     * physics, so the hold overrides this step's fall) */
    for (const w of S.worms) if (w.teleHold > 0) {
      if (!w.dead) { w.pos.x = w.teleX; w.pos.y = w.teleY; w.pos.z = w.teleZ; w.vs = 0; w.vy = 0; w.air = true; if (w.vel) { w.vel.x = 0; w.vel.y = 0; w.vel.z = 0; } }
      w.teleHold -= dt;
    }
    for (const w of S.worms) if (w.batHit && S.time >= w.batHit.t) {           // P37-8: the bat hit's delayed throw
      const h = w.batHit; w.batHit = null; S.lastBoom = S.time;
      if (!w.dead) { shove(S, w, h.x, h.y, h.z); sim().emit(S, 'batfly', { wormId: w.id}); }
    }
    if (S.dig) stepDig(S, dt);
    if (S.bullets.length) stepBullets(S, dt);
    if (S.holes.length) stepHoles(S, dt);
    if (S.strikes.length) stepStrikes(S, dt);
    if (S.zaps.length) stepZaps(S);
    if (S.moais.length) stepMoais(S, dt);
    if (S.devices.length) stepDevices(S, dt);
    if (S.crates.length) stepCrates(S, dt);
    if (SS.weaponsA) SS.weaponsA.step(S, dt);
    if (SS.gadgets) SS.gadgets.step(S, dt);
    if (SS.ffield) SS.ffield.step(S, dt);
  };
  WP.busy = S => !!(S.dig || S.bullets.length || S.holes.length || S.strikes.length || S.zaps.length || S.moais.length || (SS.weaponsA && SS.weaponsA.busy(S)) || (SS.gadgets && SS.gadgets.busy(S)) || (SS.ffield && SS.ffield.busy(S)));
  // a falling crate holds the turn's end only in its first HOLD s: a long drop (over the sea, a strong drift) kept the
  // turn open to the 16 s settle cap (the lockstep test's second turn); later it just keeps falling into the next turn
  WP.settled = S => !WP.busy(S) && !S.crates.some(c => !c.landed && S.time - (c.t0 == null ? -99 : c.t0) < CR.HOLD);
  WP.stats = S => ({ holes: S.holes.length, strikes: S.strikes.length, devices: S.devices.length, crates: S.crates.length, bullets: S.bullets.length, dig: !!S.dig, moais: S.moais.length });
})(window.SS = window.SS || {});
