/* sim/alien.js — face-hugger eggs, face huggers, the parasite, the chest-burst alien and its acid blood (P37 W5,
 * overhauled in P47;
 * volcanic island). The spec (docs/changes_req.txt line 20): "eggs whose openings activate when a worm comes close (or
 * lands nearby); the egg opens slowly over 2 minutes with a dim lime light inside; fully open: a face hugger jumps out,
 * runs to the closest worm, jumps on its face, stays for a round, then detaches and dies; that worm loses 20 HP per
 * minute and when it dies a small alien bursts out: 200 HP, CPU controlled, black shiny snake-like (no legs / arms,
 * shiny elongated head, acid blood); it stays put moving in circles and hissing; when a worm enters its range (2.5 m
 * since P51, clear 3D line of sight) it quickly slithers to it, wraps round it and bites its head off (instant death),
 * eats it, goes to sleep for a minute, wakes bigger (+50 HP, +1 m range), then waits again; killed, it explodes in
 * glowing lime acid blood that burns through terrain for quite a while and hurts whoever is splattered."
 * DEFINITIONS (sim time only, deterministic; own rng stream S.alien.rng from the map seed; no wall clock). The
 * decisions P47 took are written out in docs/notes/P47.md; the short version:
 *   Egg      st 0 closed -> (a living worm within TRIG_R m (3D), or a worm LANDING within LAND_R m) -> st 1 opening for
 *            exactly
 *            OPEN_T = 120 s of sim time (progress p = (S.time - t0) / OPEN_T: the render opens the petals, raises the
 *            glow, the HUD draws the hatching bar) -> st 3 spent: a face hugger came out. A blast within EGG_BLAST_R x
 *            W^1/3 breaks it (st 4); a blast that finds it at p >= EGG_RELEASE_P lets the hugger spill out as it
 *            breaks, below that the embryo dies with the shell. An egg whose ground is blasted away falls (faster than
 *            EGG_FALL_BREAK m/s it breaks); one that ends up under water or lava breaks.
 *   Hugger   0 emerging (EMERGE_T: hops out of the egg) -> 1 running at RUN_V m/s over the ground (follows slopes,
 *            climbs <= 1.4 m/m, slides
 *            round obstacles, never enters water / lava / an up force field) to the nearest free living worm (no hugger
 *            on it yet, not infected, not swimming) -> within LEAP_R it leaps (a GUIDED ballistic arc, LEAP_T s) ->
 *            reaches the face (< HIT_R): 3 attached. It holds on for ONE ROUND: until every team still in the game has
 *            had a turn since the attachment (S.turnNo - turn0 >= teams) or HUG_MAX_T s, whichever comes first, then
 *            LETS GO and dies (4). P84: the host is INFECTED (w.embryo = true) the moment the hugger LATCHES ON (the
 *            pulse clock runs from then, also while it is on). A shotgun pellet or any single hit over HUG_HIT 30 HP
 *            kills and removes the hugger (AL.on_hit, from sim.hurt; the worm keeps the damage and the infection); a
 *            health crate cures the infection only once the hugger is off (AL.cure; with it on the crate only gives
 *            HP). A blast within 1.5 x W^1/3 x 3 m kills it (x 1 while it is clamped on a face: the host's body shields
 *            it), so do flames (S.flames) and acid pools. If the host dies first (any cause) it falls off dead and
 *   nothing is implanted (it implants when it lets go). Parasite from the moment of the latch (P84; was: the
 *            detachment) the host loses PARA_HP = 20 HP every PARA_T = 60 s of sim time ("match time": every step of
 *            the simulation counts, whoever's turn it is, retreat and settle time included; a replay or a lockstep peer
 *            steps the same, a pause does not). The pulse is a discrete quiet hit (w.embNext = the sim time of the next
 *            one; the HUD counts down to it); it never ends the host's turn. The infection is cured only by a health
 *            crate with the hugger off (P84). The host's death, from ANY cause (the pulse that kills it, a blast, a
 *            bite, a fall) bursts a XENO out at its place: AL.burst (hook in sim.js kill()). If there is no dry ground
 *            for it (the host died in water / lava / the void), or the alien cap is reached, the embryo dies with the
 *            host (event embryo_lost). A worm the alien eats takes its embryo with it (no second alien).
 *   Xeno     hp 200 (XENO_HP), range 2.5 m (XENO_RANGE; P51: was 5). A SNAKE (P48): the head slithers over the ground
 *            (turn-rate limited heading + a lateral wave
 *            of the heading, WAVE_* rad / LAM_* m of track; snaps to the surface HOVER x size above it, falls under
 *            gravity where the ground is gone, climbs <= 1.4 m/m, slides round obstacles) and the NN nodes (SEG x size
 *            apart) FOLLOW ITS TRACK (a ring of breadcrumbs X.tr), each exactly on the ground at its place: nothing
 *            swims up and down. The coil of a wrap / bite / meal moves the nodes itself. 6 born (BORN_T: squeezed out
 *            of the host, crawls off), 0 idle (patrols legs of PATROL m along the section just behind the plane, a
 *            U-turn at each end, at IDLE_V; every HISS0..HISS1 s it stops and hisses for HISS_T), 1 strike (rears up
 *            WIND_T s, then slithers at STRIKE_V toward the worm it sees: clear 3D sight within range of its head;
 *            gives up after LOSE_T s without sight or XENO_STUCK_T s without progress), 2 wrap (WRAP_T: coils round the
 *            worm), 3 bite (the worm's HP -> 0: instant death, head off), 4 eat (EAT_T), then kills++ and 7 SLEEP (P51:
 *            SLEEP_T = 60 s of sim time, curled up on the ground at that spot, breathing slowly, ignores every worm in
 *            range; it still takes damage (blast / lava / fire / water): a hit wakes it after HIT_WAKE_T 1.2 s, ANGRY
 *            (no growth: the sleep was cut short, the meal is not digested, coolT 0 so it strikes at once), the floor
 *            going away wakes it too), 8 WAKE (WAKE_T 1.8 s: stretches out and rears, shakes, hisses; the growth is
 *            applied HERE and only after a full sleep: hp / hpMax += GROW_HP 50, range += GROW_RANGE 1, size x
 *            GROW_SIZE 1.12, eased over the animation), then idle with POST_COOL 3 s of grace (no chain kill). A
 *            newborn gets BORN_GRACE 1.5 s of grace after BORN_T. P84: it never drowns: water makes it swim (state 9,
 *            nearest land in 3D, see swimStep); lava (LAVA_DPS) and flames (FLAME_DPS) burn it, a missing floor drops
 *            it, a blast hurts it (AL.blast); it is no team and no worm: a match ends when one TEAM is left whatever
 *            lives on. hp <= 0: it bursts into N_ACID drops of acid blood (ballistic); the drops hurt worms they hit
 *            (ACID_HIT HP + a burn of ACID_DPS for ACID_BURN s) and where they land they become POOLS that eat the
 *            terrain (carve a growing sphere downward ACID_EAT m/s, up to ACID_DEPTH deep, for ACID_LIFE s), burn worms
 *            standing within ACID_POOL_R (ACID_POOL_DPS) and kill huggers and break eggs near them. The alien itself is
 * immune to its own blood. Settings: dEggs (none / low / medium / high = 0 / 2 / 4 / 8 eggs). Placement: half in the
 *   derelict ship's corridor (nest) when there is one, the rest on dry ground 6-24 m from the ship / the town, >= 7 m
 * from worms. State S.alien = { rng, nextId, air[], eggs[], huggers[], xenos[], acid[], spot, spotN } (plain data, in
 * snapshots):
 *   Egg { id, x, y, z (the base), yaw, st, t0, vy }          Hugger { id, x, y, z, vx, vy, vz, yaw, st, t0, host,
 *   round0, turn0, t, tg, bd, bt, why }
 *   Xeno { id, hp, hpMax, size, range, kills, st, t0, yaw, home{x,z}, phi, target, hiss, lastSee, bd, bt, coolT, hurtT,
 *   fall, born, vy, ph, wa, pauseT, pa, tr[2 TRN], th, tn, n[NN] of {x,y,z} } Acid { x, y, z, vx, vy, vz, st (0 fly, 1
 *   pool), t0, life, r, depth, tick } spot { key, kind (0 none, 1 worm, 2 hugger, 3 xeno, 4 point), id, x, y, z, until,
 *   d, zk, p }: what the camera director shows Worm fields (sim.worm_make): hug (hugger id on its face, -1 / null
 *   none), embryo (bool), embT (sim time of the implantation), embNext (sim time of the next pulse), embHit (the sim
 * time of the last parasite hit), eaten (the alien bit it: no grave, the renderer draws no more of it). Events:
 * egg_open, egg_hatch, egg_break, hugger_leap, hugger_attach, hugger_detach, hugger_die, parasite_pulse, chest_burst,
 *   embryo_lost, alien_born, alien_hiss, alien_strike, alien_wrap, alien_bite, alien_eat, alien_sleep, alien_wake,
 * alien_hurt, alien_burst, acid_land, acid_hit. C layout: struct Egg { i32 id; vec3 p; f32 yaw, t0, vy; u8 st; };
 *   struct Hugger { i32 id; vec3 p, v; f32 yaw, t0, t, bd, bt; u8 st, why; i16 host, tg; i32 round0, turn0; }; struct
 *   Xeno { i32 id; f32 hp, hpMax, size, range; i32 kills; u8 st; f32 t0, yaw, phi, hiss, lastSee, coolT, hurtT, fall,
 *   born, wkT, szT, hpL; u8 gp; vec2 home; i16 target; f32 vy, ph, wa, pauseT, pa; i16 th, tn; vec2 tr[300]; vec3
 *   n[12]; }; struct Acid { vec3 p, v; u8 st; f32 t0, life, r, depth, tick; }; struct Spot { i32 key; u8 kind, p; i16
 *   id;
 *   vec3 pos; f32 until, d, zk; };   pools: fixed caps MAX_EGG 12, MAX_HUG 12, MAX_XENO 8, MAX_ACID 96.
 * (sleep_fill(X, ds, cnt, out, e): the curled / stretched body as x, z, lift triples, sim + render.)
 * API: populate(S, taken), step(S, dt), blast(S, c, Wkg, dmg), burst(S, w) (sim.kill hook), busy(S), ai_foes(S, a),
 *   ai_value(S, c, Wkg, dmg), camera(S), stats(S), spawn_xeno(S, x, y, z, hp), spawn_hugger(S, x, y, z, st),
 *   infection(S, w, out), egg_progress(S, e), face_target(w, out), ground_y(x, yref, z, steps) (render too),
 *   track_fill(X, ds, count, out) (the snake's track, sampled for the renderer), hash(S, mix). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const EV = C.EV;
  const AL = SS.alien = {};
  const W = () => SS.world;
  const K = AL.K = {
    TRIG_R: 3.0, LAND_R: 7.0, OPEN_T: 120, EGG_BLAST_R: 3.2, EGG_RELEASE_P: 0.6, EGG_FALL_BREAK: 9, MAX_EGG: 12, MAX_HUG: 12, MAX_XENO: 8,
    MAX_ACID: 96,
    EMERGE_T: 0.9, RUN_V: 3.4, LEAP_R: 2.6, LEAP_T: 0.35, HIT_R: 0.6, HIT_MISS: 1.1, DEAD_T: 25, HUG_MAX_T: 300, FACE_Y: 0.25,
    PARA_T: 60, PARA_HP: 20, HUG_HIT: 30,
    XENO_HP: 200, XENO_RANGE: 2.5, NN: 12, SEG: 0.3, CIRC: 1.3, PATROL: 1.9, PAT_R: 0.4, PAT_T: -0.55, IDLE_V: 0.9, HOVER: 0.09, TRN: 300,
    CRUMB: 0.04, TURN: 2.6, TURN_S: 6, WAVE_IDLE: 0.85, WAVE_RUN: 0.5, LAM_IDLE: 1.5, LAM_RUN: 2.0, WIND_T: 0.5, HISS_T: 1.3, DROP_MAX: 3,
    HISS0: 3.5, HISS1: 7, STRIKE_V: 10, LOSE_T: 2.5, WRAP_T: 0.9, EAT_T: 2.6,
    GROW_HP: 50, GROW_RANGE: 1, GROW_SIZE: 1.12, BORN_T: 2.0, BORN_GRACE: 1.5, SLEEP_T: 60, WAKE_T: 1.8, HIT_WAKE_T: 1.2, POST_COOL: 3,
    CURL_R: 0.36, CURL_B: 0.012, CURL_MIN: 0.2, CURL_LIFT: 0.3, LAVA_DPS: 140, FLAME_DPS: 30, FALL_T: 1.5, HURT_GATE: 0.5,
    N_ACID: 40, ACID_HIT: 12, ACID_DPS: 2, ACID_BURN: 4, ACID_POOL_R: 0.9, ACID_POOL_DPS: 5,
    ACID_EAT: 0.05, ACID_DEPTH: 1.6, ACID_LIFE: 32, ACID_TICK: 0.5, ACID_R0: 0.32,
    // P38 R1: no closer than PROG m in HUG_STUCK_T s: the hugger dies; XENO_STUCK_T s: the alien gives up and ignores
    // prey for XENO_COOL s
    PROG: 0.3, HUG_STUCK_T: 8, XENO_STUCK_T: 6, XENO_COOL: 20,
    // P84: it never drowns: flooded (water over the ground it stands on by more than SWIM_DEPTH m) it SWIMS at SWIM_V
    // m/s along the surface (state 9) to the nearest land in 3D (SWIM_R m: a bank within SWIM_LOW m above the water
    // first, any higher ground if there is none) and climbs out; the search is redone every SWIM_T s
    SWIM_V: 3.2, SWIM_R: 28, SWIM_LOW: 2.0, SWIM_DEPTH: 0.15, SWIM_FLOAT: 0.1, SWIM_T: 0.8, SWIM_RING: 1.5,
    SPOT_LEAP: 1.4, SPOT_ATTACH: 3.0, SPOT_DETACH: 2.6, SPOT_PULSE: 1.8, SPOT_BORN: 4.2, SPOT_BURST: 3.0, SLOW_T: 0.8
  };
  // why a hugger died (hugger_die.why)
  const WHY = AL.WHY = { DETACH: 0, BLAST: 1, HOST_DIED: 2, STUCK: 3, ACID: 4, FIRE: 5, SHOT: 6, HIT: 7 };
  // (the Lab's moon makes the hugger's leap, the falling egg and the acid drops floaty too)
  const grav = S => C.G * SS.sim.gravity_k(S, null);
  const rnd = S => M.rng_next(S.alien.rng);

  /* ---------- ground following (shared by huggers and xenos) ---------- */
  /* the ground height under (x, z) near yref: from 0.9 m above downwards (up to `steps` x 0.1 m, default 4.4 m) or up
   * out of a solid, refined by the
   * density values at the surface crossing; -1e9 = none within reach */
  function ground_y(x, yref, z, steps) {
    const w = W();
    let y = yref + 0.9, d = w.sample(x, y, z), up = 0;
    if (d > 0) {
      while (d > 0 && up < 14) {
        y += 0.1;
        d = w.sample(x, y, z);
        up++;
      }
      if (d > 0) return -1e9;
      const d1 = w.sample(x, y - 0.1, z);
      return d1 > 0 ? y - 0.1 + 0.1 * d1 / (d1 - d) : y;
    }
    for (let n = 0, nn = steps || 44; n < nn; n++) {
      const y1 = y - 0.1, d1 = w.sample(x, y1, z);
      if (d1 > 0) return y1 + 0.1 * d1 / (d1 - d);
      y = y1; d = d1;
    }
    return -1e9;
  }
  const lv = { sub: 0, heat: 0, surf: 0 };
  // (any molten film: a cooled crust is ground)
  const inLava = (S, x, y, z) => {
    SS.sim.lava_contact(S, x, y, z, lv);
    return lv.sub > 0.004 && lv.heat > 0.02;
  };
  const wet = (S, x, y, z) => y < SS.sim.surface_at(S, x, z) + 0.05;
  const hazard = (S, x, y, z) => wet(S, x, y, z) || inLava(S, x, y, z);
  // (napalm, car fires, burning props: S.flames)
  const fireAt = (S, x, y, z) => {
    for (const f of S.flames)
      if (S.time < f.t1 && M.len2(f.x - x, f.z - z) < f.r + 0.2 && Math.abs(f.y - y) < 1.6) return true;
    return false;
  };
  const fieldAt = (S, x, y, z) => !!(SS.ffield && S.ffields && S.ffields.length && SS.ffield.inside(S, { x, y, z }, 0));
  /* move p (x, y, z) toward (tx, tz) by v dt along the ground; true when moved */
  const ANG = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6];
  function crawl(S, p, tx, tz, v, dt, noWater) {
    const dx = tx - p.x, dz = tz - p.z, a0 = M.atan2(dz, dx), step = v * dt, inF = fieldAt(S, p.x, p.y, p.z);
    for (let q = 0; q < ANG.length; q++) {
      const a = a0 + ANG[q], nx = p.x + M.cos(a) * step, nz = p.z + M.sin(a) * step, gy = ground_y(nx, p.y, nz);
      if (gy < -1e8 || gy - p.y > step * 1.4 + 0.06 || p.y - gy > 1.2) continue;
      if (noWater && hazard(S, nx, gy, nz)) continue;
      // a force field dome keeps the aliens out (it does not stop worms)
      if (noWater && !inF && fieldAt(S, nx, gy, nz)) continue;
      p.x = nx;
      p.z = nz;
      p.y += (gy - p.y) * M.fast_min(1, 24 * dt);
      p.yaw = a;
      return true;
    }
    return false;
  }
  function seen(from, to) {                                      // clear 3D line of sight (no solid between)
    return W().solid_len(from.x, from.y, from.z, to.x, to.y, to.z) < 0.01;
  }
  /* the camera spot: what the director shows for a while (hugger leap / latching, the cough, the burst ...) */
  function spot(S, kind, id, x, y, z, dur, d, zk, p) {
    const A = S.alien;
    A.spotN = (A.spotN | 0) + 1;
    A.spot = { key: A.spotN, kind, id, x, y, z, until: S.time + dur, d, zk, p };
  }

  /* ---------- state / placement ---------- */
  function blank(S) {
    return {
      rng: M.rng_make(((Math.imul(S.settings.seed | 0, 6151) + 977) >>> 0) || 1),
      nextId: 1,
      air: [],
      eggs: [],
      huggers: [],
      xenos: [],
      acid: [],
      spot: null,
      spotN: 0
    };
  }
  AL.blank = blank;
  function addEgg(S, x, y, z) {
    if (S.alien.eggs.length >= K.MAX_EGG) return null;
    const e = { id: S.alien.nextId++, x, y, z, yaw: rnd(S) * M.TAU, st: 0, t0: 0, vy: 0 };
    S.alien.eggs.push(e); return e;
  }
  /* a free hugger at (x, y, z) in state st (default: running); the nest hatches through stepEggs, tests / the studio
   * call this */
  AL.spawn_hugger = function (S, x, y, z, st) {
    const A = S.alien;
    if (A.huggers.length >= K.MAX_HUG) return null;
    const h = {
      id: A.nextId++,
      x,
      y,
      z,
      vx: 0,
      vy: 0,
      vz: 0,
      yaw: 0,
      st: st == null ? 1 : st,
      t0: S.time,
      host: -1,
      round0: 0,
      turn0: 0,
      t: S.time,
      tg: -1,
      bd: 0,
      bt: null,
      why: 0
    };
    A.huggers.push(h); return h;
  };
  AL.populate = function (S, taken) {
    S.alien = blank(S);
    const w = W();
    if (S.biome !== 'volcanic' || w.under || w.dry || w.flat) return;       // (P68a: no eggs in the 2D slab)
    const n = C.density_count(S.settings, 'dEggs', 4);
    if (n <= 0) return;
    let placed = 0;
    const D = S.derelict;
    if (D && SS.derelict.floor_points) {                         // the nest: eggs on the corridor floor of the wreck
      const fp = SS.derelict.floor_points(D), want = Math.ceil(n / 2);
      for (let q = 0; q < fp.length && placed < want; q++) {
        const p = fp[(q * 5 + 1) % fp.length];                  // (spread along the arc)
        if (S.alien.eggs.some(e => M.len3(e.x - p.x, e.y - p.y, e.z - p.z) < 2.2)) continue;
        if (addEgg(S, p.x, p.y, p.z)) placed++;
      }
    }
    const ctr = S.town && S.town.bld.length ? S.town : D;
    for (let tries = 0; tries < 800 && placed < n; tries++) {
      const a = rnd(S) * M.TAU, d = 6 + rnd(S) * 18;
      const x = ctr ? ctr.x + M.cos(a) * d : 8 + rnd(S) * (w.SX - 16), z = ctr ? ctr.z + M.sin(a) * d : 8 + rnd(S) * (w.SZ - 16);
      if (M.len2(x - w.MX, z - w.MZ) > 40 * w.SC || w.outside(x, z)) continue;
      const g = w.top_at(x, z);
      if (g < w.SEA + 1.2 || SS.sim.near_lava(S, x, z) || w.sample(x, g + 1.2, z) > 0) continue;
      let slope = 0;
      for (let q = 0; q < 4; q++) slope = M.max(slope, Math.abs(w.top_at(x + M.cos(q * 1.57) * 0.6, z + M.sin(q * 1.57) * 0.6) - g));
      if (slope > 0.5) continue;
      if ((w.features.volcanoes || []).some(v => M.len2(x - v.x, z - v.z) < v.Rc + 3)) continue;
      if (taken.some(t => M.len2(t.x - x, t.z - z) < 7) || S.alien.eggs.some(e => M.len2(e.x - x, e.z - z) < 3.5)) continue;
      if (S.worms.some(o => M.len2(o.pos.x - x, o.pos.z - z) < 7)) continue;
      if (addEgg(S, x, g, z)) placed++;
    }
    if (placed) SS.sim.log(S, `${placed} strange egg${placed > 1 ? 's' : ''} on the island...`, 0xa6ff3a);
  };

  /* ---------- helpers on worms ---------- */
  const livingWorm = o => SS.worm.active(o);
  /* the point a hugger leaps at: the face of the worm. The sim does not know the section direction the worm is drawn
   * in: the drawn face is
   * ~0.5 m ahead of the disc centre along the section; the renderer closes the last bit of the leap onto the real face
   * (render/alien.js) */
  AL.face_target = (o, out) => {
    out.x = o.pos.x;
    out.y = o.pos.y + K.FACE_Y;
    out.z = o.pos.z;
    return out;
  };
  const FT = { x: 0, y: 0, z: 0 };
  const airborne = o => !!(o.air || (!o.rest && !o.rope && o.vel && M.len3(o.vel.x, o.vel.y, o.vel.z) > 1));
  const teamsLeft = S => {
    let n = 0;
    for (let t = 0; t < S.teams.length; t++)
      for (let i = 0; i < S.worms.length; i++)
        if (S.worms[i].team === t && !S.worms[i].dead) {
          n++;
          break;
        }
    return n;
  };

  /* ---------- eggs ---------- */
  function wake(S, e) {
    e.st = 1; e.t0 = S.time; SS.sim.emit(S, EV.EGG_OPEN, { id: e.id, x: e.x, y: e.y + 0.5, z: e.z });
    SS.sim.log(S, `An egg stirs and starts to open (${K.OPEN_T} s).`, 0xa6ff3a);
  }
  /* an egg breaks: released = the hugger inside spills out (it was nearly ripe) */
  function breakEgg(S, e, released) {
    const p = AL.egg_progress(S, e);
    e.st = 4; SS.sim.emit(S, EV.EGG_BREAK, { id: e.id, x: e.x, y: e.y + 0.4, z: e.z, p });
    if (released) {
      const h = AL.spawn_hugger(S, e.x, e.y + 0.5, e.z, 0);
      if (h) h.yaw = e.yaw;
    }
  }
  function stepEggs(S, dt) {
    const A = S.alien, w = W();
    for (const o of S.worms) {                                   // landing detection (a worm that was airborne and is not)
      const was = A.air[o.id] | 0, now = livingWorm(o) && airborne(o) ? 1 : 0;
      A.air[o.id] = now;
      if (was && !now && livingWorm(o))
        for (const e of A.eggs)
          if (e.st === 0 && M.len3(e.x - o.pos.x, e.y - o.pos.y, e.z - o.pos.z) < K.LAND_R) wake(S, e);
    }
    for (const e of A.eggs) {
      if (e.st >= 3) continue;
      // the ground under it: blasted away, it falls; in water / lava it is lost
      if (w.sample(e.x, e.y - 0.1, e.z) <= 0) {
        e.vy -= grav(S) * dt; e.y += e.vy * dt;
        if (w.sample(e.x, e.y - 0.05, e.z) > 0) {
          const gy = ground_y(e.x, e.y + 0.2, e.z);
          if (gy > -1e8) e.y = gy;
          if (e.vy < -K.EGG_FALL_BREAK) {
            breakEgg(S, e, false);
            continue;
          }
          e.vy = 0;
        }
        else if (e.y < w.SEA - 8) {
          breakEgg(S, e, false);
          continue;
        }
      }
      if (hazard(S, e.x, e.y + 0.1, e.z)) {
        breakEgg(S, e, false);
        continue;
      }
      if (e.st === 0) {
        if (SS.worm.first_near(S, e.x, e.y + 0.5, e.z, K.TRIG_R, -1, SS.worm.NEAR.ACTIVE)) wake(S, e);
      } else if (e.st === 1 && S.time - e.t0 >= K.OPEN_T) {
        e.st = 3;
        SS.sim.emit(S, EV.EGG_HATCH, { id: e.id, x: e.x, y: e.y + 0.7, z: e.z });
        const h = AL.spawn_hugger(S, e.x, e.y + 0.7, e.z, 0);
        if (h) h.yaw = e.yaw;
      }
    }
  }
  AL.egg_progress = (S, e) => (e.st === 0 ? 0 : e.st === 1 ? M.sat((S.time - e.t0) / K.OPEN_T) : e.st === 3 ? 1 : 0);

  /* ---------- face huggers ---------- */
  function nearestFree(S, p, self) {
    let best = null, bd = 1e9;
    for (const o of S.worms) {
      if (!livingWorm(o) || (o.hug != null && o.hug >= 0) || o.embryo || o.swim) continue;
      let taken = false;                                                     // (another hugger already leaps at it)
      for (const q of S.alien.huggers)
        if (q !== self && q.st === 2 && q.host === o.id) {
          taken = true;
          break;
        }
      if (taken) continue;
      const d = M.len3(o.pos.x - p.x, o.pos.y - p.y, o.pos.z - p.z);
      if (d < bd || (d === bd && best && o.id < best.id)) {
        bd = d;
        best = o;
      }
    }
    return best;
  }
  function huggerDie(S, h, why, hostId) {
    h.st = 4;
    h.t0 = S.time;
    h.why = why;
    h.bt = null;
    SS.sim.emit(S, EV.HUGGER_DIE, { id: h.id, x: h.x, y: h.y, z: h.z, host: hostId, why });
  }
  /* it lands dead on the ground beside its host (0.7 m ahead of it along the section: not under the body that would
   * hide it) */
  function settleDead(S, h, o) {
    if (o) {
      const d = SS.plane.dir(S), f = o.facing || 1;
      h.x = o.pos.x + d.x * f * 0.7;
      h.z = o.pos.z + d.z * f * 0.7;
    }
    const gy = ground_y(h.x, h.y + 0.3, h.z);
    if (gy > -1e8) h.y = gy + 0.1;
  }
  function stepHuggers(S, dt) {
    const A = S.alien, g = grav(S);
    for (let i = A.huggers.length - 1; i >= 0; i--) {
      const h = A.huggers[i];
      if (h.st === 4) {
        if (S.time - h.t0 > K.DEAD_T) A.huggers.splice(i, 1);
        continue;
      }
      if (h.st === 0) {
        if (S.time - h.t0 >= K.EMERGE_T) {
          h.st = 1;
          h.t = S.time;
          h.bt = null;
          const gy = ground_y(h.x, h.y, h.z);
          if (gy > -1e8) h.y = gy + 0.12;
        }
        continue;
      }
      if (h.st === 3) {                                          // on a face
        const o = S.worms[h.host];
        if (!o || !livingWorm(o)) {                              // the host died / drowned: it falls off dead (no implant yet)
          if (o) {
            o.hug = -1;
            h.x = o.pos.x;
            h.y = o.pos.y;
            h.z = o.pos.z;
          }
          settleDead(S, h, o); huggerDie(S, h, WHY.HOST_DIED, h.host); continue;
        }
        h.x = o.pos.x; h.y = o.pos.y + K.FACE_Y; h.z = o.pos.z;
        // a round has passed: it lets go and dies (P84: the host has been infected since the latch)
        if ((S.turnNo | 0) - h.turn0 >= teamsLeft(S) || S.time - h.t > K.HUG_MAX_T) {
          o.hug = -1;
          SS.sim.emit(S, EV.HUGGER_DETACH, { id: h.id, wormId: o.id, x: h.x, y: h.y, z: h.z });
          SS.sim.log(S, `The face hugger lets go of ${o.name}, who is still infected: only a health crate cures it.`, 0xa6ff3a);
          spot(S, 1, o.id, h.x, h.y, h.z, K.SPOT_DETACH, 400, 0.5, 8);
          h.y = o.pos.y - 0.2; settleDead(S, h, o); huggerDie(S, h, WHY.DETACH, o.id);
        }
        continue;
      }
      if (h.st === 2) {                                          // the leap (guided: it corrects its course towards the face)
        if (fireAt(S, h.x, h.y, h.z)) {
          huggerDie(S, h, WHY.FIRE, h.host);
          continue;
        }
        const o = S.worms[h.host], tl = K.LEAP_T - (S.time - h.t);
        h.vy -= g * dt;
        if (o && livingWorm(o) && tl > 0.02) {
          AL.face_target(o, FT);
          h.vx += ((FT.x - h.x) / tl - h.vx) * M.fast_min(1, 18 * dt); h.vz += ((FT.z - h.z) / tl - h.vz) * M.fast_min(1, 18 * dt);
          h.vy += ((FT.y - h.y + 0.5 * g * tl * tl) / tl - h.vy) * M.fast_min(1, 10 * dt);
        }
        h.x += h.vx * dt; h.y += h.vy * dt; h.z += h.vz * dt;
        if (o && livingWorm(o) && (o.hug == null || o.hug === -1) && !o.embryo) {
          AL.face_target(o, FT);
          const d = M.len3(FT.x - h.x, FT.y - h.y, FT.z - h.z);
          if (d < K.HIT_R || (tl <= 0.02 && d < K.HIT_MISS)) {
            h.st = 3;
            o.hug = h.id;
            h.round0 = S.round;
            h.turn0 = S.turnNo | 0;
            h.t = S.time;
            h.x = FT.x;
            h.y = FT.y;
            h.z = FT.z;
            o.embryo = true; o.embT = S.time; o.embNext = S.time + K.PARA_T;                  // P84: infected the moment it latches on
            SS.sim.emit(S, EV.HUGGER_ATTACH, { id: h.id, wormId: o.id, x: h.x, y: h.y, z: h.z });
            SS.sim.log(S, `${o.name} was face-hugged and is infected! The parasite takes ${K.PARA_HP} HP every ${K.PARA_T} s.`, 0xa6ff3a);
            spot(S, 1, o.id, h.x, h.y, h.z, K.SPOT_ATTACH, 360, 0.42, 9.2);
            S.slowUntil = S.time + K.SLOW_T;
            continue;
          }
        }
        if ((h.vy < 0 && S.time - h.t > 0.12 && W().sample(h.x, h.y - 0.05, h.z) > 0) || S.time - h.t > K.LEAP_T + 0.5) {
          h.st = 1;
          h.t = S.time;
          h.bt = null;
          const gy = ground_y(h.x, h.y + 0.5, h.z);
          // (no floor under the landing: it is gone)
          if (gy > -1e8) h.y = gy + 0.12;
          else huggerDie(S, h, WHY.STUCK, -1);
        }
        continue;
      }
      // (it runs / leaps into flames: it burns)
      if (fireAt(S, h.x, h.y, h.z)) {
        huggerDie(S, h, WHY.FIRE, h.st === 2 ? h.host : -1);
        continue;
      }
      // st 1: running to the nearest free worm
      const o = nearestFree(S, h, h);
      // (P38 R3: no free worm: the progress timer restarts when one appears)
      if (!o) {
        h.bt = null;
        h.tg = -1;
        continue;
      }
      // (the progress is measured towards ONE target: a nearer worm resets it)
      if (h.tg !== o.id) {
        h.tg = o.id;
        h.bt = null;
      }
      AL.face_target(o, FT);
      const d3 = M.len3(FT.x - h.x, FT.y - h.y, FT.z - h.z);
      if (d3 < K.LEAP_R && S.time - h.t > 0.3 && seen(h, FT)) {
        const T = K.LEAP_T;
        h.vx = (FT.x - h.x) / T; h.vz = (FT.z - h.z) / T; h.vy = (FT.y - h.y + 0.5 * g * T * T) / T;
        h.st = 2;
        h.t = S.time;
        h.host = o.id;
        h.yaw = M.atan2(FT.z - h.z, FT.x - h.x);
        SS.sim.emit(S, EV.HUGGER_LEAP, { id: h.id, wormId: o.id, x: h.x, y: h.y, z: h.z });
        spot(S, 2, h.id, h.x, h.y, h.z, K.SPOT_LEAP, 420, 0.55, 8.6);
        continue;
      }
      // (P38 R1: a hugger that cannot get closer - a wall, a pit, water - dies after HUG_STUCK_T s: before it kept
      // AL.busy true for ever and every attack turn waited out the settle cap)
      if (h.bt == null || d3 < h.bd - K.PROG) {
        h.bd = d3;
        h.bt = S.time;
      }
      else if (S.time - h.bt > K.HUG_STUCK_T) {
        huggerDie(S, h, WHY.STUCK, -1);
        continue;
      }
      crawl(S, h, o.pos.x, o.pos.z, K.RUN_V, dt, true);
    }
  }

  /* ---------- the parasite: a pulse every PARA_T s of sim time ---------- */
  function stepParasite(S) {
    for (const o of S.worms) {
      if (!o.embryo || o.dead || !(o.hp > 0)) continue;
      if (S.time < o.embNext) continue;
      o.embNext += K.PARA_T;
      const lethal = o.hp <= K.PARA_HP;
      SS.sim.emit(S, EV.PARASITE_PULSE, {
        wormId: o.id,
        amount: K.PARA_HP,
        left: M.max(0, o.hp - K.PARA_HP),
        lethal: lethal ? 1 : 0,
        x: o.pos.x,
        y: o.pos.y,
        z: o.pos.z
      });
      if (!lethal) spot(S, 1, o.id, o.pos.x, o.pos.y, o.pos.z, K.SPOT_PULSE, 460, 0.6, 4);
      S.hitDir = null; o.embHit = S.time;
      SS.sim.hurt(S, o, K.PARA_HP, C.DS.PARASITE, C.HF.QUIET);
    }
  }
  /* P84: damage to a worm with a face hugger on (called from sim.hurt after the damage is applied): a shotgun pellet,
   * or any single hit of more than
   * HUG_HIT HP, kills and removes the hugger (it falls off dead beside the worm). The worm keeps the damage AND the
   * infection. */
  AL.on_hit = function (S, w, dmg, src) {
    if (!S.alien || !w || !(w.hug != null && w.hug >= 0) || !(w.hp > 0)) return false;
    const shot = src === C.DS.SHOTGUN;
    if (!shot && !(dmg > K.HUG_HIT)) return false;
    const h = S.alien.huggers.find(q => q.id === w.hug);
    w.hug = -1;
    if (!h) return false;
    h.x = w.pos.x;
    h.y = w.pos.y + K.FACE_Y;
    h.z = w.pos.z;
    settleDead(S, h, w);
    huggerDie(S, h, shot ? WHY.SHOT : WHY.HIT, w.id);
    SS.sim.log(
      S,
      `${w.name}'s face hugger is torn off${shot ? ' by the shot' : ''}. The infection stays: a health crate cures it.`,
      0xa6ff3a
    );
    return true;
  };
  /* P84: a health crate cures the infection once the hugger is OFF (with it still on, the crate only gives HP: time) */
  AL.cure = function (S, w) {
    if (!w || !w.embryo || (w.hug != null && w.hug >= 0)) return false;
    w.embryo = false; w.embNext = 0;
    SS.sim.emit(S, EV.CURE, { wormId: w.id });
    SS.sim.log(S, `${w.name} is cured of the parasite.`, 0x79d98b);
    return true;
  };
  /* what the HUD / the render show of a worm's infection: out = { stage (0 clean, 1 hugged, 2 infected), left (s to the
   * next pulse), pulses (hits
   * left until it dies), ttd (s to the death if nothing else happens), sev (0..1, grows towards the death) } */
  AL.infection = function (S, w, out) {
    out.stage = 0;
    out.left = 0;
    out.ttd = 0;
    out.sev = 0;
    out.pulses = 0;
    if (!w || w.dead) return out;
    const hug = w.hug != null && w.hug >= 0;
    if (!w.embryo) {
      if (hug) out.stage = 1;
      return out;
    }
    out.stage = hug ? 1 : 2; out.left = M.max(0, w.embNext - S.time);
    out.pulses = M.max(1, Math.ceil(M.max(1, w.hp) / K.PARA_HP));
    out.ttd = (out.pulses - 1) * K.PARA_T + out.left;
    out.sev = M.sat(1 - (out.ttd - K.PARA_T * 0.5) / (K.PARA_T * 3));
    return out;
  };

  /* ---------- the xeno ---------- */
  AL.spawn_xeno = function (S, x, y, z, hp) {
    const A = S.alien;
    if (A.xenos.length >= K.MAX_XENO) return null;
    const X = {
      id: A.nextId++,
      hp: hp || K.XENO_HP,
      hpMax: hp || K.XENO_HP,
      size: 0.6,
      range: K.XENO_RANGE,
      kills: 0,
      st: 6,
      t0: S.time,
      yaw: (S.theta || 0) + (rnd(S) < 0.5 ? 0 : Math.PI),
      home: { x, z },
      phi: rnd(S) * M.TAU,
      target: -1,
      hiss: S.time + 1.5 + rnd(S) * 2,
      lastSee: S.time,
      bd: 0,
      bt: null,
      coolT: 0,
      hurtT: -9,
      fall: 0,
      born: S.time,
      gp: 0,
      wkT: 0,
      szT: 0,
      hpL: 0,
      swT: 0,
      sx: 0,
      sz: 0,
      sf: 0,
      vy: 0,
      ph: 0,
      wa: 0,
      pauseT: 0,
      pa: S.theta || 0,
      tr: [],
      th: 0,
      tn: 1,
      n: []
    };
    for (let i = 0; i < K.NN; i++) X.n.push({ x, y, z });
    for (let i = 0; i < K.TRN * 2; i++) X.tr.push(i & 1 ? z : x);
    A.xenos.push(X);
    SS.sim.emit(S, EV.ALIEN_BORN, { id: X.id, x, y, z });
    return X;
  };
  /* a dry spot for a newborn at (x, z): the ground there, else a ring of tries round it */
  function bornSpot(S, x, y, z) {
    for (let q = 0; q < 9; q++) {
      const a = q * 0.7, r = q === 0 ? 0 : 0.5 + 0.35 * q, px = x + M.cos(a) * r, pz = z + M.sin(a) * r;
      if (W().outside(px, pz)) continue;
      const gy = ground_y(px, y, pz, 160);                       // (a host blown to bits above a crater: the floor may be 16 m down)
      if (gy < -1e8 || hazard(S, px, gy + 0.1, pz)) continue;
      return { x: px, y: gy + 0.15, z: pz };
    }
    return null;
  }
  AL.burst = function (S, w) {                                   // the host died: a small alien bursts out of the chest
    if (!S.alien || !(w.embryo || (w.hug != null && w.hug >= 0))) return;
    // (the hugger was still on: nothing implanted yet; stepHuggers lets it fall off dead)
    if (!w.embryo) {
      w.hug = -1;
      return;
    }
    w.embryo = false; w.hug = -1;
    // (a poison death of a worm the parasite has hit: the burst line tells it, not a gas death)
    if (w.embHit >= 0 && w.cause === C.CAUSE.POISON) w.cause = C.CAUSE.ALIEN;
    // (0.6 m ahead of the corpse: it comes out beside the tombstone, not behind it)
    const d = SS.plane.dir(S), f = w.facing || 1, sp = bornSpot(S, w.pos.x + d.x * f * 0.6, w.pos.y, w.pos.z + d.z * f * 0.6);
    const X = sp && SS.sim.in_play(S, sp.x, sp.z) ? AL.spawn_xeno(S, sp.x, sp.y, sp.z, K.XENO_HP) : null;
    if (!X) {
      SS.sim.emit(S, EV.EMBRYO_LOST, { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z });
      SS.sim.log(S, `The embryo in ${w.name} does not survive.`, 0xa6ff3a);
      return;
    }
    SS.sim.emit(S, EV.CHEST_BURST, { wormId: w.id, xenoId: X.id, x: w.pos.x, y: w.pos.y + 0.1, z: w.pos.z, cause: w.cause | 0 });
    SS.sim.log(S, `Something bursts out of ${w.name}!`, 0xa6ff3a);
    // (the chest bursts: the gore of the blood setting)
    if (S.settings.blood && !SS.sim.cause_gibs(w.cause))
      SS.sim.emit(S, EV.GIB, { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z, dir: null });
    spot(S, 3, X.id, X.n[0].x, X.n[0].y + 0.4, X.n[0].z, K.SPOT_BORN, 380, 0.5, 9.4);
    S.slowUntil = S.time + K.SLOW_T;
  };
  const xhead = X => X.n[0];
  /* ---- the snake's body (P48): the head slithers (a lateral wave in its heading, the track is a sine on the ground),
   * the body FOLLOWS THE TRACK
   * of the head: X.tr is a ring of breadcrumbs (x, z) the head left, X.th the newest, X.tn the count; node i of X.n
   * sits i x SEG x size along that track and ON the ground there (surface + HOVER x size: exact, no lerp: no swimming
   * up and down). The coil (wrap / bite / eat) drives the nodes by itself; when it ends the track is rebuilt from the
   * nodes. */
  function trailPush(X, x, z) {
    X.th = (X.th + 1) % K.TRN;
    X.tr[X.th * 2] = x;
    X.tr[X.th * 2 + 1] = z;
    if (X.tn < K.TRN) X.tn++;
  }
  function trailReset(X, x, z) {
    X.tn = 0;
    X.th = K.TRN - 1;
    trailPush(X, x, z);
  }
  function trailFromNodes(X) {                                   // after the coil: the track is the nodes, tail first
    const n = X.n;
    trailReset(X, n[n.length - 1].x, n[n.length - 1].z);
    for (let i = n.length - 2; i >= 0; i--) trailPush(X, n[i].x, n[i].z);
    X.yaw = M.atan2(n[0].z - n[1].z, n[0].x - n[1].x);
  }
  /* the point s metres behind the head along the track (the live head is the zero point); a track shorter than s ends
   * at its oldest crumb */
  const TP = { x: 0, z: 0 };
  function bodyFollow(S, X) {
    const n = X.n, hd = n[0], seg = K.SEG * X.size;
    // (teleported / blasted head: the track starts again)
    const ci = (X.th) * 2;
    if (M.len2(X.tr[ci] - hd.x, X.tr[ci + 1] - hd.z) > 1.2) trailReset(X, hd.x, hd.z);
    let k = X.th, cnt = 0, px = hd.x, pz = hd.z, acc = 0, i = 1;
    while (i < n.length) {
      const cx = X.tr[k * 2], cz = X.tr[k * 2 + 1], dl = M.len2(cx - px, cz - pz);
      const want = i * seg;
      if (acc + dl >= want && dl > 1e-9) {
        const f = (want - acc) / dl;
        TP.x = px + (cx - px) * f;
        TP.z = pz + (cz - pz) * f;
        place(S, X, n[i], TP.x, TP.z);
        i++;
        continue;
      }
      acc += dl;
      px = cx;
      pz = cz;
      cnt++;
      if (cnt >= X.tn) {
        while (i < n.length) {
          place(S, X, n[i], px, pz);
          i++;
        }
        break;
      }
      k = (k + K.TRN - 1) % K.TRN;
    }
  }
  /* the track sampled for the renderer: out[2 i], out[2 i + 1] = the (x, z) of the point i x ds metres behind the head
   * (a short track ends at its oldest crumb) */
  AL.track_fill = function (X, ds, cnt, out) {
    const hd = X.n[0];
    let k = X.th, c = 0, px = hd.x, pz = hd.z, acc = 0, i = 0;
    while (i < cnt) {
      const cx = X.tr[k * 2], cz = X.tr[k * 2 + 1], dl = M.len2(cx - px, cz - pz), want = i * ds;
      if (acc + dl >= want && (dl > 1e-9 || want === acc)) {
        const f = dl > 1e-9 ? (want - acc) / dl : 0;
        out[i * 2] = px + (cx - px) * f;
        out[i * 2 + 1] = pz + (cz - pz) * f;
        i++;
        continue;
      }
      acc += dl;
      px = cx;
      pz = cz;
      c++;
      if (c >= X.tn) {
        while (i < cnt) {
          out[i * 2] = px;
          out[i * 2 + 1] = pz;
          i++;
        }
        break;
      }
      k = (k + K.TRN - 1) % K.TRN;
    }
    return out;
  };
  AL.ground_y = ground_y;
  function place(S, X, nd, x, z) {                               // a body node on the ground at (x, z)
    const gy = ground_y(x, nd.y, z);
    nd.x = x;
    nd.z = z;
    if (gy > -1e8) nd.y = gy + K.HOVER * X.size;
  }
  /* the head stays on the ground: snaps to the surface (HOVER above: a descent of up to snap m in one step follows the
   * slope), falls under gravity where the ground is gone / drops away faster */
  function hold(S, X, dt, snap) {
    const h = xhead(X), gy = ground_y(h.x, h.y, h.z, 100), g = grav(S);
    if (gy < -1e8) {
      X.vy -= g * dt;
      h.y += X.vy * dt;
      return;
    }
    const ty = gy + K.HOVER * X.size;
    if (h.y > ty + (snap || 0.15)) {
      X.vy -= g * dt;
      h.y += X.vy * dt;
      if (h.y <= ty) {
        h.y = ty;
        X.vy = 0;
      }
    } else {
      h.y = ty;
      X.vy = 0;
    }
  }
  /* one step of slithering towards the heading `want` at speed v: turns at most `turn` rad/s, the heading wobbles by wa
   * x sin(ph) (ph runs with the
   * distance travelled: wavelength lam), steps round obstacles; true when it moved */
  function slither(S, X, want, v, wa, lam, turn, dt, noWater) {
    const h = xhead(X), step = v * dt, da = M.wrap_angle(want - X.yaw), tmax = turn * dt;
    X.yaw += da > tmax ? tmax : da < -tmax ? -tmax : da;
    X.wa += (wa - X.wa) * M.fast_min(1, 5 * dt);
    const inF = fieldAt(S, h.x, h.y, h.z), w0 = X.wa * M.sin(X.ph), g0 = h.y - K.HOVER * X.size;
    for (let q = 0; q < ANG.length; q++) {
      const a = X.yaw + w0 + ANG[q], nx = h.x + M.cos(a) * step, nz = h.z + M.sin(a) * step, gy = ground_y(nx, h.y, nz);
      if (gy < -1e8 || gy - g0 > step * 1.4 + 0.06 || g0 - gy > K.DROP_MAX) continue;
      if (noWater && hazard(S, nx, gy, nz)) continue;
      if (noWater && !inF && fieldAt(S, nx, gy, nz)) continue;
      h.x = nx;
      h.z = nz;
      if (q) X.yaw = a - w0;
      X.ph += step * M.TAU / lam;
      const ci = X.th * 2;
      if (M.len2(h.x - X.tr[ci], h.z - X.tr[ci + 1]) >= K.CRUMB) trailPush(X, h.x, h.z);
      hold(S, X, dt, step * 2.2 + 0.1); return true;
    }
    hold(S, X, dt); return false;
  }
  function chain(S, X, dt, coilAt) {
    const n = X.n;
    if (coilAt) {                                                // wrapped round a worm: a spiral, the head on top, the tail at the bottom
      for (let i = 0; i < n.length; i++) {
        const a = X.phi + i * 0.95,
          r = 0.3 + 0.04 * (i & 1),
          tx = coilAt.x + M.cos(a) * r,
          tz = coilAt.z + M.sin(a) * r,
          ty = coilAt.y + 0.38 - i * 0.055;
        const k = M.fast_min(1, 14 * dt);
        n[i].x += (tx - n[i].x) * k;
        n[i].y += (ty - n[i].y) * k;
        n[i].z += (tz - n[i].z) * k;
      }
      return;
    }
    bodyFollow(S, X);
  }
  function foeInRange(S, X) {
    const h = xhead(X), hp = { x: h.x, y: h.y + 0.25, z: h.z };
    let best = null, bd = 1e9;
    for (const o of S.worms) {
      if (!livingWorm(o) || o.swim) continue;
      const d = M.len3(o.pos.x - hp.x, o.pos.y + 0.28 - hp.y, o.pos.z - hp.z);
      if (d > X.range || d >= bd) continue;
      if (!seen(hp, { x: o.pos.x, y: o.pos.y + 0.1, z: o.pos.z }) && !seen(hp, { x: o.pos.x, y: o.pos.y + 0.28, z: o.pos.z })) continue;
      bd = d; best = o;
    }
    return best;
  }
  const idle = (S, X, h) => {
    if (X.st >= 2 && X.st <= 4) {
      trailFromNodes(X);
      const gy = ground_y(h.x, h.y, h.z, 100);
      if (gy > -1e8) {
        h.y = gy + K.HOVER * X.size;
        X.vy = 0;
      }
    }
    X.phi = 1;
    X.pa = S.theta;
    X.st = 0;
    X.home.x = h.x;
    X.home.z = h.z;
    X.target = -1;
    X.bt = null;
  };
  /* P84: water no longer hurts it (it swims, see swim_*); lava and flames burn it, no floor drops it: the hp loss (the
   * cry of pain is gated) */
  function xenoHazard(S, X, dt) {
    const h = xhead(X);
    let dmg = 0;
    if (inLava(S, h.x, h.y, h.z)) dmg += K.LAVA_DPS * dt;
    if (fireAt(S, h.x, h.y, h.z)) dmg += K.FLAME_DPS * dt;
    if (X.st !== 9 && ground_y(h.x, h.y, h.z) < -1e8) {
      X.fall += dt;
      if (X.fall > K.FALL_T) dmg += X.hp;
    } else X.fall = 0;
    if (dmg > 0) {
      X.hp -= dmg;
      if (S.time - X.hurtT > K.HURT_GATE) {
        X.hurtT = S.time;
        SS.sim.emit(S, EV.ALIEN_HURT, { id: X.id, x: h.x, y: h.y, z: h.z, amount: dmg });
      }
    }
  }
  /* ---------- P84: swimming (state 9) ---------- */
  const surfOf = (S, x, z) => SS.sim.surface_at(S, x, z);
  // flooded: the water over the ground under the head is deeper than SWIM_DEPTH (or there is no ground at all under it)
  function flooded(S, X, h) {
    const sf = surfOf(S, h.x, h.z);
    if (!(sf > -50) || h.y >= sf + 0.05) return false;
    const gy = ground_y(h.x, h.y, h.z, 100);
    return gy < -1e8 || sf - gy > K.SWIM_DEPTH;
  }
  /* the closest land in 3D from the head: rings of 1.5 m round it, the first ring that holds dry ground within reach
   * (3D distance: horizontal + the height above
   * the water) ends the search one ring later. Pass 0: a bank at most SWIM_LOW m above the water (a beach it can
   * slither up); pass 1: any ground above the water (a cliff: it swims to its foot). out = { x, z, y }; false when
   * there is none within SWIM_R. */
  function findLand(S, h, sf, out) {
    const w = W(), st = K.SWIM_RING;
    let best = 1e9, found = false;
    for (let pass = 0; pass < 2 && !found; pass++) {
      for (let r = st; r <= K.SWIM_R && r <= best + st; r += st) {
        const n = M.max(8, Math.floor(M.TAU * r / st));
        for (let k = 0; k < n; k++) {
          const a = M.TAU * k / n, x = h.x + M.cos(a) * r, z = h.z + M.sin(a) * r;
          if (x < 1 || z < 1 || x > w.SX - 1 || z > w.SZ - 1) continue;
          let g;
          if (pass === 0) {
            g = ground_y(x, sf - 0.4, z, 40);
            if (g < -1e8 || g < sf + 0.05 || g > sf + K.SWIM_LOW) continue;
          }
          else {
            g = w.top_at(x, z);
            if (g < sf + 0.05) continue;
          }
          if (inLava(S, x, g, z)) continue;
          const d = M.len3(x - h.x, g - sf, z - h.z);
          if (d < best) {
            best = d;
            out.x = x;
            out.z = z;
            out.y = g;
            found = true;
          }
        }
      }
    }
    return found;
  }
  function swimStart(S, X, h) {
    if (X.st === 7 || X.st === 8) {
      X.gp = 0;
      trailFromNodes(X);
    }
    X.st = 9;
    X.t0 = S.time;
    X.swT = 0;
    X.target = -1;
    X.bt = null;
    X.vy = 0;
    X.sf = 0;
  }
  const SL = { x: 0, z: 0, y: 0 };
  function swimStep(S, X, dt) {
    const h = xhead(X), w = W();
    const sf = surfOf(S, h.x, h.z);
    // no water here any more: dry ground
    if (!(sf > -50)) {
      idle(S, X, h);
      const gy = ground_y(h.x, h.y, h.z, 100);
      if (gy > -1e8) h.y = gy + K.HOVER * X.size;
      return;
    }
    if (S.time >= X.swT) {
      const ok = findLand(S, h, sf, SL);
      if (ok) {
        X.sx = SL.x;
        X.sz = SL.z;
        X.sf = SL.y;
        X.swT = S.time + K.SWIM_T;
      } else {
        X.sf = 0;
        X.swT = S.time + 2;
      }
    }
    const fy = sf - K.SWIM_FLOAT * X.size;
    const want = X.sf ? M.atan2(X.sz - h.z, X.sx - h.x) : X.yaw, da = M.wrap_angle(want - X.yaw), tmax = K.TURN_S * dt;
    X.yaw += da > tmax ? tmax : da < -tmax ? -tmax : da;
    X.wa += (K.WAVE_RUN - X.wa) * M.fast_min(1, 5 * dt);
    const step = K.SWIM_V * dt, w0 = X.wa * M.sin(X.ph);
    for (let q = 0; q < ANG.length; q++) {
      const a = X.yaw + w0 + ANG[q], nx = h.x + M.cos(a) * step, nz = h.z + M.sin(a) * step;
      if (nx < 0.5 || nz < 0.5 || nx > w.SX - 0.5 || nz > w.SZ - 0.5) continue;
      if (w.sample(nx, fy, nz) > 0) {                                  // a bank at the surface: climb out if it is a slope it can take
        const g = ground_y(nx, sf, nz, 30);
        if (g > -1e8 && g - sf <= K.SWIM_LOW && !inLava(S, nx, g, nz)) {
          h.x = nx;
          h.z = nz;
          h.y = g + K.HOVER * X.size;
          X.yaw = a - w0;
          X.vy = 0;
          const ci = X.th * 2;
          if (M.len2(h.x - X.tr[ci], h.z - X.tr[ci + 1]) >= K.CRUMB) trailPush(X, h.x, h.z);
          trailFromNodes(X); idle(S, X, h); return;
        }
        continue;
      }
      h.x = nx;
      h.z = nz;
      if (q) X.yaw = a - w0;
      X.ph += step * M.TAU / (K.LAM_RUN * X.size);
      const ci = X.th * 2;
      if (M.len2(h.x - X.tr[ci], h.z - X.tr[ci + 1]) >= K.CRUMB) trailPush(X, h.x, h.z);
      break;
    }
    const sf2 = surfOf(S, h.x, h.z), fy2 = (sf2 > -50 ? sf2 : sf) - K.SWIM_FLOAT * X.size;
    h.y += (fy2 - h.y) * M.fast_min(1, 12 * dt);
    bodyFollow(S, X);
    for (let i = 1; i < X.n.length; i++)
      X.n[i].y = X.n[i].y > fy2 + 0.5 || X.n[i].y < fy2 - 3 ? fy2 : X.n[i].y + (fy2 - X.n[i].y) * M.fast_min(1, 12 * dt);
  }
  /* ---------- sleep (P51) ---------- */
  const sm01 = (u, a, b) => {
    const t = u <= a ? 0 : u >= b ? 1 : (u - a) / (b - a);
    return t * t * (3 - 2 * t);
  };
  /* the curled-up (e = 0) or stretched-out (e = 1, the wake-up) body as x, z, lift triples: cnt points ds apart from
   * the head. The curl is a coiled rope round X.home (radius CURL_R x size
   * shrinking CURL_B x size per rad down to CURL_MIN, rising CURL_LIFT x size over the whole length: the head rests on
   * top); the stretch runs on from the head along the tail direction */
  AL.sleep_fill = function (X, ds, cnt, out, e) {
    const sz = X.size,
      th0 = X.yaw + M.TAU * 0.25,
      cx = X.home.x,
      cz = X.home.z,
      rmin = K.CURL_MIN * sz,
      m = M.max(1, Math.ceil(ds / (0.025 * sz))),
      hs = ds / m,
      tot = (cnt - 1) * ds;
    let r = K.CURL_R * sz, th = th0;
    const hx = cx + M.cos(th0) * r, hz = cz + M.sin(th0) * r, tx = -M.sin(th0), tz = M.cos(th0);
    for (let i = 0; i < cnt; i++) {
      out[i * 3] = hx + (cx + M.cos(th) * r - hx) * (1 - e) + tx * i * ds * e;
      out[i * 3 + 1] = hz + (cz + M.sin(th) * r - hz) * (1 - e) + tz * i * ds * e;
      out[i * 3 + 2] = K.CURL_LIFT * sz * (1 - i * ds / tot) * (1 - e);
      for (let q = 0; q < m; q++) {
        const dth = hs / M.max(r, rmin);
        th += dth;
        r = M.max(rmin, r - K.CURL_B * sz * dth);
      }
    }
  };
  const SLP = new Array(K.NN * 3).fill(0);
  // the sim nodes follow the curl / stretch (they ease in: it curls up over ~0.5 s)
  function sleepNodes(S, X, e, dt) {
    const n = X.n, k = M.fast_min(1, 6 * dt);
    AL.sleep_fill(X, K.SEG * X.size, n.length, SLP, e);
    for (let i = 0; i < n.length; i++) {
      const nd = n[i], tx = SLP[i * 3], tz = SLP[i * 3 + 1], gy = ground_y(tx, nd.y, tz, 40);
      nd.x += (tx - nd.x) * k; nd.z += (tz - nd.z) * k;
      if (gy > -1e8) {
        const ty = gy + K.HOVER * X.size + SLP[i * 3 + 2];
        nd.y += (ty - nd.y) * k;
      }
    }
  }
  function sleepStart(S, X, h) {
    X.st = 7;
    X.t0 = S.time;
    X.wkT = S.time + K.SLEEP_T;
    X.hpL = X.hp;
    X.target = -1;
    X.bt = null;
    X.vy = 0;
    X.home.x = h.x; X.home.z = h.z;
    // (it curls up just BEHIND the section plane, like the idle patrol: the whole coil stays on the visible side)
    {
      const pn = SS.plane.nrm(S), tt = (h.x - S.O.x) * pn.x + (h.z - S.O.z) * pn.z;
      if (tt > K.PAT_T) {
        const nx = h.x + pn.x * (K.PAT_T - tt), nz = h.z + pn.z * (K.PAT_T - tt);
        if (!W().outside(nx, nz) && ground_y(nx, h.y, nz, 60) > -1e8 && !hazard(S, nx, h.y, nz)) {
          X.home.x = nx;
          X.home.z = nz;
        }
      }
    }
    SS.sim.emit(S, EV.ALIEN_SLEEP, { id: X.id, x: h.x, y: h.y, z: h.z });
    SS.sim.log(S, 'The alien is full and curls up to sleep...', 0xa6ff3a);
  }
  function wakeStart(S, X, h) {
    X.st = 8; X.t0 = S.time; X.hiss = S.time + 99;
    if (X.gp) {
      X.hpMax += K.GROW_HP;
      X.hp += K.GROW_HP;
      X.range += K.GROW_RANGE;
      X.szT = X.size * K.GROW_SIZE;
    }
    X.hpL = X.hp;
    SS.sim.emit(S, EV.ALIEN_WAKE, { id: X.id, x: h.x, y: h.y + 0.3, z: h.z, grown: X.gp });
    SS.sim.emit(S, EV.ALIEN_HISS, { id: X.id, x: h.x, y: h.y + 0.3, z: h.z });
    SS.sim.log(S, X.gp ? 'The alien wakes up bigger and stronger!' : 'The alien is woken, furious!', X.gp ? 0xa6ff3a : 0xff8a5a);
  }
  function stepXenos(S, dt) {
    const A = S.alien;
    for (let i = A.xenos.length - 1; i >= 0; i--) {
      const X = A.xenos[i], h = xhead(X);
      if (X.st !== 3 && X.st !== 4) xenoHazard(S, X, dt);
      if (X.hp <= 0) {
        acidBurst(S, X);
        A.xenos.splice(i, 1);
        continue;
      }
      const target = X.target >= 0 ? S.worms[X.target] : null;
      if (X.st !== 9 && X.st !== 2 && X.st !== 3 && X.st !== 4 && flooded(S, X, h)) swimStart(S, X, h);
      switch (X.st) {
        case 9: swimStep(S, X, dt); break;                       // P84: swimming to the nearest land
        case 6:                                                  // hatched: rests, growing out of the corpse
          X.size = 0.6 + 0.4 * M.sat((S.time - X.t0) / K.BORN_T);
          if (S.time - X.t0 >= K.BORN_T) {
            X.st = 0;
            X.size = 1;
            X.hiss = S.time + 0.4;
            X.coolT = S.time + K.BORN_GRACE;
          }
          slither(S, X, X.yaw, 0.7 * X.size, K.WAVE_IDLE, K.LAM_IDLE * X.size, K.TURN, dt, true);
          chain(S, X, dt, null); break;
        case 0: {                                                // idle: circles round home, hisses; looks for prey
          if (S.time < X.pauseT) hold(S, X, dt);                  // (rearing up and hissing: it holds still)
          else {
            // it patrols along the section (the line the player sees it on) just BEHIND the plane, so it reads as lying
            // on the ground beyond the cut edge: legs of PATROL m to either side of home, a U-turn at each end (the
            // line is pulled at most 1 m sideways towards t = PAT_T per leg end)
            const pn = SS.plane.nrm(S);
            let lx = X.home.x + M.cos(X.pa) * X.phi * K.PATROL, lz = X.home.z + M.sin(X.pa) * X.phi * K.PATROL;
            const tt = (lx - S.O.x) * pn.x + (lz - S.O.z) * pn.z, sh = M.clamp(K.PAT_T - tt, -1, 1);
            lx += pn.x * sh;
            lz += pn.z * sh;
            if (M.len2(lx - h.x, lz - h.z) < K.PAT_R) {
              X.phi = -X.phi;
              X.pa = S.theta;
            }
            slither(S, X, M.atan2(lz - h.z, lx - h.x), K.IDLE_V * X.size, K.WAVE_IDLE, K.LAM_IDLE * X.size, K.TURN, dt, true);
          }
          chain(S, X, dt, null);
          if (S.time >= X.hiss) {
            X.hiss = S.time + K.HISS0 + rnd(S) * (K.HISS1 - K.HISS0);
            X.pauseT = S.time + K.HISS_T;
            SS.sim.emit(S, EV.ALIEN_HISS, { id: X.id, x: h.x, y: h.y + 0.3, z: h.z });
          }
          const o = S.time >= (X.coolT || 0) ? foeInRange(S, X) : null;
          if (o) {
            X.st = 1;
            X.target = o.id;
            X.lastSee = S.time;
            X.t0 = S.time;
            X.bt = null;
            SS.sim.emit(S, EV.ALIEN_STRIKE, { id: X.id, x: h.x, y: h.y + 0.3, z: h.z, wormId: o.id });
            SS.sim.log(S, 'The alien hisses and strikes!', 0xa6ff3a);
          }
          break;
        }
        case 1: {                                                // strike: slither to the target
          if (!target || !livingWorm(target)) {
            idle(S, X, h);
            break;
          }
          const hd = { x: target.pos.x, y: target.pos.y + 0.28, z: target.pos.z }, hp = { x: h.x, y: h.y + 0.25, z: h.z };
          if (seen(hp, hd)) X.lastSee = S.time;
          if (S.time - X.lastSee > K.LOSE_T) {
            idle(S, X, h);
            break;
          }
          // (P38 R1: no progress toward the prey for XENO_STUCK_T s - a pit, a wall: it gives up and leaves it be for
          // XENO_COOL s)
          {
            const dd = M.len2(h.x - target.pos.x, h.z - target.pos.z);
            if (X.bt == null || dd < X.bd - K.PROG) {
              X.bd = dd;
              X.bt = S.time;
            }
            else if (S.time - X.bt > K.XENO_STUCK_T) {
              idle(S, X, h);
              X.coolT = S.time + K.XENO_COOL;
              break;
            }
          }
          {
            const aim = M.atan2(target.pos.z - h.z, target.pos.x - h.x);
            // (rears up and hisses first: the front third lifts, it faces the prey)
            if (S.time - X.t0 < K.WIND_T) { slither(S, X, aim, 0, 0, K.LAM_RUN, K.TURN_S, dt, true); }
            else slither(S, X, aim, K.STRIKE_V * M.pow(X.size, 0.5), K.WAVE_RUN, K.LAM_RUN * X.size, K.TURN_S, dt, true);
          }
          chain(S, X, dt, null);
          if (M.len2(h.x - target.pos.x, h.z - target.pos.z) < 0.9 && Math.abs(h.y - target.pos.y) < 1.8) {
            X.st = 2;
            X.t0 = S.time;
            SS.sim.emit(S, EV.ALIEN_WRAP, { id: X.id, x: target.pos.x, y: target.pos.y, z: target.pos.z, wormId: target.id });
          }
          break;
        }
        case 2: {                                                // wrap
          if (!target || !livingWorm(target)) {
            idle(S, X, h);
            break;
          }
          X.phi += 9 * dt;
          h.x = target.pos.x;
          h.y = target.pos.y + 0.3;
          h.z = target.pos.z;
          chain(S, X, dt, { x: target.pos.x, y: target.pos.y, z: target.pos.z });
          if (S.time - X.t0 >= K.WRAP_T) {
            X.st = 3; X.t0 = S.time;
            target.embryo = false; target.eaten = true;        // (eaten with it: no second alien, no tombstone, not drawn any more)
            S.hitDir = { x: M.cos(X.yaw), y: 0.3, z: M.sin(X.yaw) };
            SS.sim.emit(S, EV.ALIEN_BITE, { id: X.id, wormId: target.id, x: target.pos.x, y: target.pos.y + 0.3, z: target.pos.z });
            SS.sim.hurt(S, target, M.max(1, target.hp), C.DS.ALIEN_BITE);
            SS.sim.log(S, `The alien bites ${target.name}'s head off!`, 0xff6a6a);
          }
          break;
        }
        case 3: case 4: {                                        // bite / eat
          const x = target ? target.pos.x : h.x, y = target ? target.pos.y : h.y, z = target ? target.pos.z : h.z;
          X.phi += 3 * dt;
          chain(S, X, dt, { x, y, z });
          if (X.st === 3 && S.time - X.t0 > 0.35) {
            X.st = 4;
            X.t0 = S.time;
            SS.sim.emit(S, EV.ALIEN_EAT, { id: X.id, x, y, z });
          }
          if (X.st === 4 && S.time - X.t0 >= K.EAT_T) {
            X.kills++; X.gp = 1;                                 // (the growth is applied when it WAKES: a full sleep digests the meal)
            if (target && target.dead) target.grave = null;     // eaten: no tombstone
            sleepStart(S, X, h);
          }
          break;
        }
        // sleep: curled up, ignores worms; a hit wakes it angry (and it does not grow)
        case 7: {
          if (X.hp < X.hpL - 1e-6 && X.wkT > S.time + K.HIT_WAKE_T) {
            X.wkT = S.time + K.HIT_WAKE_T;
            X.gp = 0;
          }
          X.hpL = X.hp;
          // (the floor is gone: it wakes and falls like any snake)
          if (ground_y(X.home.x, h.y, X.home.z, 100) < -1e8) {
            X.wkT = S.time;
            X.gp = 0;
          }
          sleepNodes(S, X, 0, dt);
          if (S.time >= X.wkT) wakeStart(S, X, h);
          break;
        }
        // wake-up: stretches out (the render rears, shakes, hisses), the growth shows
        case 8: {
          const u = M.sat((S.time - X.t0) / K.WAKE_T), e = sm01(u, 0.15, 0.85);
          if (X.szT > 0) X.size = X.szT / K.GROW_SIZE * (1 + (K.GROW_SIZE - 1) * sm01(u, 0, 0.9));
          sleepNodes(S, X, e, dt);
          X.hpL = X.hp;
          if (u >= 1) {
            if (X.szT > 0) {
              X.size = X.szT;
              X.szT = 0;
            }
            sleepNodes(S, X, 1, 1);
            trailFromNodes(X);
            {
              const gy = ground_y(h.x, h.y, h.z, 100);
              if (gy > -1e8) h.y = gy + K.HOVER * X.size;
            }
            X.vy = 0;
            X.phi = 1;
            X.pa = S.theta;
            X.st = 0;
            X.home.x = h.x;
            X.home.z = h.z;
            X.target = -1;
            X.bt = null;
            // (a hit-woken one is angry at once)
            X.hiss = S.time + 1.5; X.coolT = X.gp ? S.time + K.POST_COOL : 0; X.gp = 0;
          }
          break;
        }
        default: X.st = 0;
      }
    }
  }
  /* the blast: nearest node of each xeno takes the worm-style effect; huggers die, eggs break (or release a hugger) */
  AL.blast = function (S, c, Wkg, dmgPoC) {
    const A = S.alien;
    if (!A) return;
    for (const X of A.xenos) {
      let bd = 1e9, bp = null;
      for (const nd of X.n) {
        const d = M.len3(nd.x - c.x, nd.y - c.y, nd.z - c.z);
        if (d < bd) {
          bd = d;
          bp = nd;
        }
      }
      if (!bp) continue;
      const e = SS.blast.worm_effect(c, Wkg, bp, dmgPoC);
      if (e.dmg >= 1) {
        X.hp -= e.dmg;
        X.hurtT = S.time;
        SS.sim.emit(S, EV.ALIEN_HURT, { id: X.id, x: bp.x, y: bp.y, z: bp.z, amount: e.dmg });
      }
    }
    // (clamped on a face the host's body shields it: a third of the reach)
    for (const h of A.huggers)
      if (h.st !== 4 && M.len3(h.x - c.x, h.y - c.y, h.z - c.z) < 1.5 * M.cbrt(Wkg) * (h.st === 3 ? 1 : 3)) {
        const o = S.worms[h.host];
        if (o && o.hug === h.id) o.hug = -1;
        huggerDie(S, h, WHY.BLAST, h.host);
      }
    for (const e of A.eggs)
      if (e.st < 3 && M.len3(e.x - c.x, e.y + 0.4 - c.y, e.z - c.z) < K.EGG_BLAST_R * M.cbrt(Wkg))
        breakEgg(S, e, e.st === 1 && AL.egg_progress(S, e) >= K.EGG_RELEASE_P);
  };

  /* ---------- acid blood ---------- */
  function acidBurst(S, X) {
    const A = S.alien, h = xhead(X);
    SS.sim.emit(S, EV.ALIEN_BURST, { id: X.id, x: h.x, y: h.y + 0.3, z: h.z, size: X.size });
    SS.sim.log(S, 'The alien explodes in a fountain of acid!', 0xa6ff3a);
    for (let q = 0; q < K.N_ACID && A.acid.length < K.MAX_ACID; q++) {
      const nd = X.n[q % X.n.length], a = rnd(S) * M.TAU, up = 2 + rnd(S) * 6, out = 1.5 + rnd(S) * 4.5 * M.pow(X.size, 0.5);
      A.acid.push({
        x: nd.x,
        y: nd.y + 0.2,
        z: nd.z,
        vx: M.cos(a) * out,
        vy: up,
        vz: M.sin(a) * out,
        st: 0,
        t0: S.time,
        life: 6,
        r: K.ACID_R0,
        depth: 0,
        tick: 0
      });
    }
    spot(S, 4, 0, h.x, h.y + 0.3, h.z, K.SPOT_BURST, 480, 0.6, 8.4);
    // a small pop (the worm-style burst)
    if (SS.sim.explode) SS.sim.explode(S, { x: h.x, y: h.y + 0.2, z: h.z }, { W: 0.15, dmg: 14, name: 'alienburst' }, null);
  }
  function stepAcid(S, dt) {
    const A = S.alien, w = W();
    let carved = 0;
    for (let i = A.acid.length - 1; i >= 0; i--) {
      const a = A.acid[i];
      if (a.st === 0) {                                          // a drop in flight
        a.vy -= grav(S) * dt;
        a.x += a.vx * dt;
        a.y += a.vy * dt;
        a.z += a.vz * dt;
        let hit = false;
        const o = SS.worm.first_near(S, a.x, a.y, a.z, 0.6, -1, SS.worm.NEAR.ACTIVE);
        if (o) {
          S.hitDir = { x: a.vx * 0.1, y: 0.2, z: a.vz * 0.1 };
          SS.sim.hurt(S, o, K.ACID_HIT, C.DS.ACID_BLOOD); o.acidT = S.time + K.ACID_BURN; hit = true;
          SS.sim.emit(S, EV.ACID_HIT, { x: a.x, y: a.y, z: a.z, wormId: o.id });
        }
        if (hit) {
          A.acid.splice(i, 1);
          continue;
        }
        if (w.sample(a.x, a.y, a.z) > 0 || a.y < SS.sim.surface_at(S, a.x, a.z)) {
          // in the sea: diluted
          if (a.y < SS.sim.surface_at(S, a.x, a.z) + 0.1 && w.sample(a.x, a.y, a.z) <= 0) {
            A.acid.splice(i, 1);
            continue;
          }
          // merge into a pool nearby, else become one
          let m = null;
          for (const q of A.acid)
            if (q.st === 1 && M.len3(q.x - a.x, q.y - a.y, q.z - a.z) < 0.55) {
              m = q;
              break;
            }
          if (m) {
            m.life = M.max(m.life, S.time - m.t0 + K.ACID_LIFE * 0.6);
            m.r = M.fast_min(0.8, m.r + 0.03);
            A.acid.splice(i, 1);
            continue;
          }
          a.st = 1;
          a.t0 = S.time;
          a.life = K.ACID_LIFE;
          a.vx = a.vy = a.vz = 0;
          a.tick = S.time + rnd(S) * K.ACID_TICK;
          a.depth = 0;
          SS.sim.emit(S, EV.ACID_LAND, { x: a.x, y: a.y, z: a.z });
          continue;
        }
        if (S.time - a.t0 > a.life) A.acid.splice(i, 1);
        continue;
      }
      // a pool: burns what stands in it, eats the ground
      if (S.time - a.t0 > a.life) {
        A.acid.splice(i, 1);
        continue;
      }
      if (SS.struct && S.structs && S.structs.length) SS.struct.acid(S, a, a.r, dt);          // P38-A4: steel bridges, trunks
      if (SS.trees && S.trees && S.trees.length) SS.trees.acid_at(S, a.x, a.y, a.z, a.r, dt);
      for (const o of S.worms)
        if (livingWorm(o) && M.len2(o.pos.x - a.x, o.pos.z - a.z) < K.ACID_POOL_R && Math.abs(o.pos.y - 0.4 - a.y) < 1.1)
          SS.sim.burn(S, o, K.ACID_POOL_DPS, dt, C.DS.ACID_BLOOD);
      for (const h of A.huggers)
        if (h.st !== 4 && h.st !== 3 && M.len2(h.x - a.x, h.z - a.z) < K.ACID_POOL_R && Math.abs(h.y - a.y) < 1.0)
          huggerDie(S, h, WHY.ACID, -1);
      for (const e of A.eggs)
        if (e.st < 3 && M.len2(e.x - a.x, e.z - a.z) < K.ACID_POOL_R + 0.3 && Math.abs(e.y - a.y) < 1.0) breakEgg(S, e, false);
      if (S.time >= a.tick && carved < 6) {
        a.tick = S.time + K.ACID_TICK; carved++;
        if (a.depth < K.ACID_DEPTH) {
          const step = K.ACID_EAT * K.ACID_TICK;
          a.depth += step;
          a.y -= step;
          a.r = M.fast_min(0.7, a.r + 0.004);
          const rem = w.carve(a.x, a.y, a.z, a.r);
          if (rem > 0 && S.settings.collapse && SS.collapse_hook) {
            const H = w.H, r = a.r + 1;
            SS.collapse_hook(S, {
              i0: Math.floor((a.x - r) / H),
              j0: Math.floor((a.y - r) / H),
              k0: Math.floor((a.z - r) / H),
              i1: Math.ceil((a.x + r) / H),
              j1: Math.ceil((a.y + r) / H),
              k1: Math.ceil((a.z + r) / H)
            });
          }
        }
      }
    }
    for (const o of S.worms)
      if (o.acidT > S.time && livingWorm(o)) SS.sim.burn(S, o, K.ACID_DPS, dt, C.DS.ACID);
  }

  /* ---------- step / queries ---------- */
  AL.step = function (S, dt) {
    const A = S.alien;
    if (!A) return;
    if (A.eggs.length) stepEggs(S, dt);
    if (A.huggers.length) stepHuggers(S, dt);
    stepParasite(S);
    if (A.xenos.length) stepXenos(S, dt);
    if (A.acid.length) stepAcid(S, dt);
  };
  /* the turn waits while something alien is moving at a worm */
  AL.busy = S => {
    const A = S.alien;
    if (!A) return false;
    for (const h of A.huggers)
      if (h.st === 1 || h.st === 2) return true;
    for (const X of A.xenos)
      if (X.st >= 1 && X.st <= 4) return true;
    for (const a of A.acid)
      if (a.st === 0) return true;
    return false;
  };
  /* CPU AI: living aliens near the active worm are extra targets, and a blast that hurts them is worth something */
  AL.ai_foes = (S, a) => {
    const out = [];
    if (!S.alien) return out;
    for (const X of S.alien.xenos) {
      const nd = xhead(X), d = M.len3(nd.x - a.pos.x, nd.y - a.pos.y, nd.z - a.pos.z);
      if (d < 22 && X.hp > 0)
        out.push({
          pos: { x: nd.x, y: nd.y + 0.2, z: nd.z },
          hp: X.hp,
          team: -1,
          id: -1,
          dead: false,
          alien: true,
          swim: null,
          drowning: false
        });
    }
    return out;
  };
  AL.ai_value = (S, c, Wkg, dmg) => {
    let v = 0;
    if (!S.alien) return 0;
    for (const X of S.alien.xenos) {
      let bd = 1e9, bp = null;
      for (const nd of X.n) {
        const d = M.len3(nd.x - c.x, nd.y - c.y, nd.z - c.z);
        if (d < bd) {
          bd = d;
          bp = nd;
        }
      }
      if (!bp) continue;
      const dm = SS.blast.hp_loss(c, Wkg, bp, X.hp, dmg);
      v += 0.6 * dm + (dm >= X.hp ? 40 : 0);
    }
    return v;
  };
  /* the camera follows the alien business: { key, x, y, z, d, p, zk } or null. A running spot (leap, latching,
   * detaching, the burst) first, then the
   * alien on the move */
  AL.camera = S => {
    const A = S.alien;
    if (!A) return null;
    const sp = A.spot;
    if (sp && S.time < sp.until) {
      let x = sp.x, y = sp.y, z = sp.z;
      if (sp.kind === 1) {
        const o = S.worms[sp.id];
        if (o) {
          x = o.pos.x;
          y = o.pos.y + 0.3;
          z = o.pos.z;
        }
      }
      else if (sp.kind === 2) {
        const h = A.huggers.find(q => q.id === sp.id);
        if (h) {
          x = h.x;
          y = h.y;
          z = h.z;
        }
      }
      else if (sp.kind === 3) {
        const X = A.xenos.find(q => q.id === sp.id);
        if (X) {
          x = X.n[0].x;
          y = X.n[0].y + 0.4;
          z = X.n[0].z;
        }
      }
      return { key: 'alienspot' + sp.key, x, y, z, d: sp.d, zk: sp.zk, p: sp.p };
    }
    for (const X of A.xenos)
      if ((X.st >= 1 && X.st <= 4) || X.st === 8) {
        const h = xhead(X);
        return { key: 'alien' + X.id + '_' + X.st, x: h.x, y: h.y + 0.5, z: h.z, d: 440, p: 8 };
      }
    for (const h of A.huggers)
      if (h.st === 2) return { key: 'leap' + h.id, x: h.x, y: h.y, z: h.z, d: 420, p: 8 };
    return null;
  };
  AL.stats = S => S.alien
    ? {
      eggs: S.alien.eggs.length,
      open: S.alien.eggs.filter(e => e.st === 1).length,
      huggers: S.alien.huggers.length,
      xenos: S.alien.xenos.length,
      acid: S.alien.acid.length
    }
    : null;
  /* the hash of the alien state (sim.hash): everything that moves or counts */
  AL.hash = function (S, mix) {
    const A = S.alien;
    if (!A) return;
    for (const e of A.eggs) {
      mix(e.st);
      mix(e.t0);
      if (e.vy) {
        mix(e.y);
        mix(e.vy);
      }
    }
    for (const q of A.huggers) {
      mix(q.st);
      mix(q.x);
      mix(q.y);
      mix(q.z);
      if (q.st === 3 || q.st === 2) {
        mix(q.host);
        mix(q.turn0 | 0);
      }
    }
    for (const q of A.xenos) {
      mix(q.hp);
      mix(q.st);
      mix(q.n[0].x);
      mix(q.n[0].y);
      mix(q.n[0].z);
      mix(q.kills);
      mix(q.size);
      mix(q.yaw);
      mix(q.ph);
      mix(q.n[q.n.length - 1].x);
      mix(q.n[q.n.length - 1].z);
      mix(q.gp);
      mix(q.wkT);
      mix(q.szT);
      mix(q.hpL);
      mix(q.range);
      mix(q.coolT);
    }
    mix(A.acid.length);
    for (const a of A.acid) {
      mix(a.x);
      mix(a.y);
      mix(a.z);
    }
    for (const o of S.worms)
      if (o.embryo || (o.hug != null && o.hug >= 0)) {
        mix(o.embryo ? 1 : 0);
        mix(o.hug | 0);
        mix(o.embNext || 0);
      }
  };
})(window.SS = window.SS || {});
