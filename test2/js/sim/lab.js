/* sim/lab.js — P42 "Lab": experimental game mechanics, each a flag of settings.labFlags (int bit mask, OFF = 0 by
 * default).
 * With every flag off nothing here changes a single number of the simulation (the hooks return neutral values, no RNG
 * draws, no hash input), so a match without the Lab equals the pre-Lab game bit for bit. The mask travels with the
 * match settings (the NET rows of the settings schema -> the net 'start' message), so both lockstep peers run the same
 * rules. Portable and deterministic: sim time only, its own RNG stream S.lab.rng, no Map / Set, a capped pool
 * (C.LIMITS.LAB_METEORS).
 *
 *   BANK      bank shot:  a bouncing shell (grenade, banana, ...) that hit terrain / props with a hard bounce (> 2 m/s)
 *             before it
 *             goes off deals +20 % blast damage per such bounce (up to +60 %) to worms of the other teams.
 *   UNDERDOG  comeback:   a team whose living worms hold half the HP (or less) of the strongest other team deals +35 %
 *             blast damage.
 *   GUSTS     weather:    during a turn (aiming) the wind shifts every 6-12 s (heading +-0.9 rad, speed -4..+5 m/s,
 *             0..11 m/s).
 *   METEORS   hazard:     from turn 3 on, every 3rd turn 2-3 meteors are announced (red rings on the ground) and hit
 *             2.2 s later
 *             (blast W METEOR_W, within MET_R m of the section origin, never in water).
 *   CLOCK     overtime:   the turn clock shrinks 10 % per round (down to CLOCK_MIN s); only with a turn time set.
 *   MOON      low gravity: every 3rd round worms and props fall with MOON_K x gravity (shells are not affected).
 * Batch 2 (P50):
 *   PERKS     draft:      at the start of the match and of every 3rd round (rounds 1, 4, 7 ...) each living team in
 *             seat order is offered 3 of
 *             the 6 perks it does not own yet and keeps 1 for the rest of the match: RADIUS (+15 % blast radius of its
 *             shells), PADDED (-20 % landing damage), SPRING (+20 % jump speed), THICK (-15 % blast damage taken),
 *             MAGNET (crates are picked up from 2.5 x farther), TIME (+10 s on its turn clock). The draft is the phase
 *             'perk' (C.PH.PERK): the picking team owns S.active, so lockstep routes its input (Input.fuse 1..3 = the
 *             card, no new Input field); a CPU team picks by a fixed score table after PERK_CPU_T s, a human on
 *             time-out too.
 *   STREAK    momentum:   a team that damaged an enemy worm with a blast during its turn gains a streak step (max 4):
 *             +10 % blast damage per step;
 *             a turn without a hit resets it.
 *   LONGSHOT  sniping:    a blast that hurts an enemy worm more than 25 m (3D) from the shooter deals +25 %, more than
 *             40 m +50 %, with a banner.
 *   FATIGUE   stamina:    the metres a worm walked / swung / fell while it was the active worm in its turn (max 25 m)
 *             make ITS next shot sway:
 *             a random aim error of up to +-0.1 rad (5.7 deg) x metres / 25, drawn at fire time from the Lab stream.
 *             Standing still = a fresh aim.
 *   CRACKS    terrain:    (P66b, rules in sim/cracks.js) blasts leave persistent 3D cracks (W.crack) that weaken the
 *             ground; after a blast the land around it
 *             is weighed (voxels, worms, bodies) against the bonds that still hold it, and a cut-off ledge or a block
 * on a thin neck falls. C layout: struct Lab { u32 rng; f32 gustT; i32 meteorN; Meteor met[LAB_METEORS]; u8 moon,
 *             bankN; f32 bankK; i32 evTick; u8 perks[4]; u8 streak[4]; u8 dealt; i8 curTeam; i16 draftRound; Draft
 *           draft; f32 moved[16], tired[16]; f32 lx, ly, lz; i16 lid; i32 longTick; }; struct Draft { bool on, first;
 *           u8 n, idx, team, nopt; u8 order[4]; u8 opts[3]; f32 t; };
 *           struct Meteor { i32 id; f32 t, x, y, z; };  settings.labFlags: u16.
 * API: init(S), flags(S), on(S, bit), turn_start(S, first), step(S, dt), gravity_k(S), bank_set(S, n), dmg_k(S,
 *   ownerId, w), underdog(S, team), badge(S) -> text, hash(S, mix); batch 2: draft_begin(S, first) -> bool,
 *   perk_step(S, inp, dt), has(S, team, perk), blast_w(S, W, ownerId), landing_dmg(S, w, dmg), jump_k(S, w), pick_k(S,
 *   w), hit(S, ownerId, w, dmg), sway(S, a, aim) -> aim, tired(S, id), streak_k(S, team). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const LB = SS.lab = {};
  const F = C.LAB;                      // (the constants live in config.js: sim.js reads BANK_SPEED even where this module is not loaded)
  const rng = S => M.rng_next(S.lab.rng);
  const rr = (S, a, b) => a + (b - a) * rng(S);

  // the active mechanics: the settings' bit mask limited to the defined flags (C.LAB.ALL)
  LB.flags = S => (S.settings.labFlags | 0) & F.ALL;
  LB.on = (S, bit) => (LB.flags(S) & bit) !== 0;
  LB.lab_make = S => ({ rng: M.rng_make(((Math.imul(S.settings.seed | 0, 48271) + 0x1ab5) >>> 0) || 1), gustT: 0, met: [], metN: 0,
    moon: false, bankN: 0, bankK: 1, evTick: -1, underAnn: -1,
    perks: [0, 0, 0, 0], streak: [0, 0, 0, 0], dealt: 0, curTeam: -1, draftRound: -1, longTick: -1, lx: 0, ly: 0, lz: 0, lid: -1, moved: [],
    tired: [],
    draft: { on: false, first: false, n: 0, idx: 0, team: -1, order: [0, 0, 0, 0], opts: [0, 0, 0], nopt: 0, t: 0 } });
  LB.init = function (S) {
    S.lab = LB.lab_make(S); S.lab.gustT = F.GUST_T0;
    if (SS.lab4) SS.lab4.init(S);                                       // P79: batch 4 state (own RNG stream)
    for (let i = 0; i < C.LIMITS.WORMS; i++) {
      S.lab.moved.push(0);
      S.lab.tired.push(0);
    }
  };

  /* strength of a team = HP of its living worms */
  LB.underdog = function (S, team) {
    if (!LB.on(S, F.FLAG.UNDERDOG) || !S.teams) return false;
    const mine = SS.worm.team_hp(S, team);
    if (mine <= 0) return false;
    let best = 0;
    for (let t = 0; t < S.teams.length; t++)
      if (t !== team) best = M.max(best, SS.worm.team_hp(S, t));
    return mine <= best * F.UNDER_RATIO;
  };

  /* ---------- hooks ---------- */
  LB.gravity_k = S => (S.lab && S.lab.moon ? F.MOON_K : 1);
  LB.bank_set = function (S, n) {
    if (S.lab) { S.lab.bankN = n | 0; }
  };
  LB.has = (S, team, perk) => !!(S.lab && LB.on(S, F.FLAG.PERKS) && team >= 0 && team < 4 && (S.lab.perks[team] & (1 << perk)));
  LB.streak_k = (S, team) => (S.lab && LB.on(S, F.FLAG.STREAK) && team >= 0 && team < 4 ? 1 + F.STREAK_K * S.lab.streak[team] : 1);
  LB.tired = (S, id) => (S.lab && LB.on(S, F.FLAG.FATIGUE) && id >= 0 && id < S.lab.tired.length ? S.lab.tired[id] : 0);
  /* the blast damage factor for worm w hit by a blast of owner ownerId (a worm id, null / -1 = none: a meteor, a
   * barrel) */
  LB.dmg_k = function (S, ownerId, w) {
    const fl = LB.flags(S);
    if (!fl || !S.lab) return 1;
    let k = 1;
    if (LB.has(S, w.team, F.PERK.THICK)) k *= F.THICK_K;
    if (ownerId == null || ownerId < 0) return k;
    const o = S.worms[ownerId];
    if (!o || o.team === w.team) return k;
    if ((fl & F.FLAG.BANK) && S.lab.bankN > 0) {
      const kb = 1 + F.BANK_K * M.min(S.lab.bankN, F.BANK_MAX);
      k *= kb;
      if (S.lab.evTick !== S.tick) {
        S.lab.evTick = S.tick;
        SS.sim.emit(S, EV.LABBANK, { wormId: ownerId, bounces: S.lab.bankN, k: kb });
        SS.sim.log(S, `Bank shot x${kb.toFixed(1)}!`, 0xffe08a);
      }
    }
    if ((fl & F.FLAG.UNDERDOG) && LB.underdog(S, o.team)) k *= F.UNDER_K;
    if (fl & F.FLAG.STREAK) k *= LB.streak_k(S, o.team);
    if (fl & F.FLAG.LONGSHOT) {
      const d = M.len3(o.pos.x - w.pos.x, o.pos.y - w.pos.y, o.pos.z - w.pos.z),
        kl = d > F.LONG2_M ? F.LONG2_K : d > F.LONG_M ? F.LONG_K : 1;
      if (kl > 1) {
        k *= kl;
        if (S.lab.longTick !== S.tick) {
          S.lab.longTick = S.tick;
          SS.sim.emit(S, EV.LABLONG, { wormId: ownerId, victim: w.id, dist: d, k: kl });
          SS.sim.emit(S, EV.BANNER, { title: 'Long shot!', sub: `${Math.round(d)} m: +${Math.round((kl - 1) * 100)} % damage` });
          SS.sim.log(S, `Long shot, ${Math.round(d)} m: x${kl.toFixed(2)} damage.`, 0xffe08a);
        }
      }
    }
    return k;
  };
  /* a blast that hurt worm w (blast.js, after sim.hurt): the streak bookkeeping (the shooter's team dealt damage this
   * turn) */
  LB.hit = function (S, ownerId, w, dmg) {
    if (!S.lab || !LB.on(S, F.FLAG.STREAK) || ownerId == null || ownerId < 0 || dmg < 1) return;
    const o = S.worms[ownerId];
    if (o && o.team !== w.team && o.team < 4) S.lab.dealt |= 1 << o.team;
  };
  /* sim.explode: the charge W of a shell of a team with the RADIUS perk (radius x RADIUS_K = W x K^3) */
  LB.blast_w = function (S, Wkg, ownerId) {
    if (!S.lab || ownerId == null || ownerId < 0 || !LB.on(S, F.FLAG.PERKS)) return Wkg;
    const o = S.worms[ownerId];
    return o && LB.has(S, o.team, F.PERK.RADIUS) ? Wkg * F.RADIUS_K * F.RADIUS_K * F.RADIUS_K : Wkg;
  };
  LB.landing_dmg = function (S, w, dmg) {
    if (LB.has(S, w.team, F.PERK.PADDED)) dmg = M.max(1, Math.round(dmg * F.PADDED_K));
    // P79 SLICK: mud soaks up a fall
    if (SS.lab4 && dmg > 0 && S.lab && S.lab.b4) {
      const k = SS.lab4.landing_k(S, w);
      if (k < 1) dmg = M.max(1, Math.round(dmg * k));
    }
    return dmg;
  };
  LB.jump_k = (S, w) => (LB.has(S, w.team, F.PERK.SPRING) ? F.SPRING_K : 1);
  LB.pick_k = (S, w) => (LB.has(S, w.team, F.PERK.MAGNET) ? F.MAGNET_K : 1);
  /* weapons.use: the tired worm's aim error (one draw from the Lab stream per shot; the aim vector is rotated) */
  LB.sway = function (S, a, aim) {
    const t = LB.tired(S, a.id);
    if (!(t > 0)) return aim;
    const e = (rng(S) * 2 - 1) * F.FAT_RAD * M.min(1, t / F.FAT_M), c = M.cos(e), sn = M.sin(e);
    SS.sim.emit(S, EV.LABSWAY, { wormId: a.id, err: e });
    return { s: aim.s * c - aim.y * sn * a.facing, y: aim.y * c + aim.s * sn * a.facing };
  };

  /* ---------- the perk draft ---------- */
  const PERK_NAMES = ['Wide blasts', 'Padded boots', 'Spring legs', 'Thick skin', 'Crate magnet', 'Extra time'];
  LB.PERK_NAMES = PERK_NAMES;
  LB.PERK_TEXT = [
    '+15 % blast radius for your shells',
    '-20 % landing damage',
    '+20 % jump speed',
    '-15 % blast damage taken',
    'crates are picked up from 2.5 x farther',
    '+10 s on your turn clock'
  ];
  /* the perks of a team as text (names, or 2-letter initials with short = true) */
  LB.perk_list = function (S, team, short) {
    if (!S.lab || team < 0 || team > 3) return '';
    const out = [];
    for (let p = 0; p < F.PERK_COUNT; p++)
      if (S.lab.perks[team] & (1 << p)) out.push(short ? PERK_NAMES[p].slice(0, 2).toUpperCase() : PERK_NAMES[p]);
    return out.join(short ? ' ' : ', ');
  };
  /* the CPU's choice: a fixed score per perk (no RNG), ties to the first card; a team behind in HP values THICK /
   * PADDED more */
  const SCORE = [5, 2, 3, 4, 2, 1];
  LB.cpu_pick = function (S, team, opts, n) {
    let best = 0, bs = -1;
    const mine = SS.worm.team_hp(S, team);
    let top = 0;
    for (let t = 0; t < S.teams.length; t++) top = M.max(top, SS.worm.team_hp(S, t));
    for (let i = 0; i < n; i++) {
      const p = opts[i];
      let sc = SCORE[p] * 10;
      if (mine < top * 0.7 && (p === F.PERK.THICK || p === F.PERK.PADDED)) sc += 15;
      if (p === F.PERK.TIME && S.settings.turnTime <= 0) sc = 0;
      if (sc > bs) {
        bs = sc;
        best = i;
      }
    }
    return best;
  };
  function open_pick(S) {
    const D = S.lab.draft, L = S.lab;
    while (D.idx < D.n) {
      const team = D.order[D.idx], pool = [];
      for (let p = 0; p < F.PERK_COUNT; p++)
        if (!(L.perks[team] & (1 << p))) pool.push(p);
      if (!pool.length) {
        D.idx++;
        continue;
      }
      D.team = team; D.nopt = M.min(F.PERK_OPTS, pool.length);
      for (let i = 0; i < D.nopt; i++) {
        const j = i + Math.floor(rng(S) * (pool.length - i));
        const t = pool[i];
        pool[i] = pool[j];
        pool[j] = t;
        D.opts[i] = pool[i];
      }
      D.t = F.PERK_T;
      const w = S.worms.find(o => !o.dead && o.hp > 0 && o.team === team);
      if (w) S.active = w;
      S.phase = PHASE.PERK; S.charging = false; S.power = 0;
      SS.sim.emit(S, EV.LABPERKOFFER, { team, opts: D.opts.slice(0, D.nopt) });
      return;
    }
    D.on = false; D.team = -1; S.phase = PHASE.PLAY;
    SS.sim.next_turn(S, D.first);
  }
  /* sim.next_turn, before the team rotation: true = a draft is starting (next_turn is re-entered when it ends) */
  LB.draft_begin = function (S, first) {
    if (!S.lab || !LB.on(S, F.FLAG.PERKS)) return false;
    const G = SS.game;
    let round = S.round;
    if (!first) {
      const nt = G.peek_team(S);
      if (nt < 0) return false;
      if (G.wraps(S, nt)) round++;
    }
    if (round % F.PERK_EVERY !== 1 || S.lab.draftRound === round) return false;
    const D = S.lab.draft, n = S.teams.length;
    D.n = 0;
    const ft = S.firstTeam | 0;
    for (let k = 0; k < n; k++) {
      const t = (ft + k) % n;
      if (SS.worm.team_alive(S, t)) D.order[D.n++] = t;
    }
    if (!D.n) return false;
    S.lab.draftRound = round;
    D.on = true;
    D.first = !!first;
    D.idx = 0;
    open_pick(S);
    return D.on;
  };
  function take(S, i) {
    const D = S.lab.draft, perk = D.opts[i], team = D.team, cpu = SS.game.is_cpu(S, team);
    S.lab.perks[team] |= 1 << perk;
    SS.sim.emit(S, EV.LABPERK, { team, perk, cpu });
    SS.sim.log(S, `${SS.sim.team_name(S, team)} take ${PERK_NAMES[perk]}.`, SS.sim.team_rgb(S, team));
    D.idx++; open_pick(S);
  }
  /* sim.step in phase 'perk': inp.fuse 1..3 picks a card for a human team; the CPU (and a time-out) use cpu_pick */
  LB.perk_step = function (S, inp, dt) {
    const D = S.lab && S.lab.draft;
    if (!D || !D.on || S.phase !== PHASE.PERK) return;
    D.t -= dt;
    if (SS.game.is_cpu(S, D.team)) {
      if (D.t <= F.PERK_T - F.PERK_CPU_T) take(S, LB.cpu_pick(S, D.team, D.opts, D.nopt));
      return;
    }
    const f = (inp && inp.fuse) | 0;
    if (f >= 1 && f <= D.nopt) take(S, f - 1);
    else if (D.t <= 0) take(S, LB.cpu_pick(S, D.team, D.opts, D.nopt));
  };

  /* turn start (sim.next_turn, after the turn clock is set) */
  LB.turn_start = function (S, first) {
    const fl = LB.flags(S);
    if (!fl || !S.lab) return;
    const L = S.lab, sim = SS.sim;
    if (fl & F.FLAG.CLOCK) {
      if (S.settings.turnTime > 0) {
        // (integer percent: 45 s at round 4 is exactly 31.5 -> 32)
        const t0 = S.settings.turnTime,
          lo = M.min(t0, F.CLOCK_MIN),
          pct = M.max(0, 100 - F.CLOCK_PCT * M.max(0, S.round - 1)),
          t = M.max(lo, Math.floor(t0 * pct / 100 + 0.5));
        S.turnT = t;
      }
    }
    if (fl & F.FLAG.MOON) {
      const moon = S.round % F.MOON_EVERY === 0;
      if (moon !== L.moon) {
        L.moon = moon;
        if (moon) {
          sim.emit(S, EV.BANNER, { title: 'Moon phase', sub: 'Low gravity this round' });
          sim.log(S, 'Moon phase: low gravity this round.', 0xb8c8ff);
        }
      }
    } else L.moon = false;
    if (S.active) {
      const id = S.active.id, team = S.active.team;
      if (fl & F.FLAG.STREAK) {
        const p = L.curTeam;
        if (p >= 0 && p < 4 && !first) {
          const was = L.streak[p];
          if (L.dealt & (1 << p)) L.streak[p] = M.min(F.STREAK_MAX, was + 1);
          else L.streak[p] = 0;
          if (L.streak[p] !== was) {
            sim.emit(S, EV.LABSTREAK, { team: p, streak: L.streak[p] });
            if (L.streak[p] > 0)
              sim.log(
                S,
                `${sim.team_name(S, p)} streak x${L.streak[p]}: +${Math.round(L.streak[p] * F.STREAK_K * 100)} % blast damage.`,
                0xffc08a
              );
            else sim.log(S, `${sim.team_name(S, p)} lost their streak.`, 0xb8b8b8);
          }
        }
        L.dealt = 0;
      }
      L.curTeam = team;
      if (fl & F.FLAG.FATIGUE) {
        L.tired[id] = L.moved[id];
        L.moved[id] = 0;
        L.lx = S.active.pos.x;
        L.ly = S.active.pos.y;
        L.lz = S.active.pos.z;
        L.lid = id;
        if (L.tired[id] > 0.5)
          sim.log(
            S,
            `${S.active.name} is tired: aim sways up to ${(F.FAT_RAD * M.min(1, L.tired[id] / F.FAT_M) * 180 / M.PI).toFixed(1)} deg.`,
            0xd8c0a0
          );
      }
      if ((fl & F.FLAG.PERKS) && S.turnT > 0 && LB.has(S, team, F.PERK.TIME)) S.turnT += F.TIME_S;
    }
    L.gustT = rr(S, F.GUST_T0, F.GUST_T1) * ((fl & F.FLAG.GUSTS) ? 1 : 0);
    if ((fl & F.FLAG.UNDERDOG) && S.active && LB.underdog(S, S.active.team) && L.underAnn !== S.turnNo) {
      L.underAnn = S.turnNo;
      sim.emit(S, EV.LABUNDER, { team: S.active.team });
      sim.log(S, `${sim.team_name(S, S.active.team)} are the underdogs: +${Math.round((F.UNDER_K - 1) * 100)} % blast damage.`, 0xffc08a);
    }
    if ((fl & F.FLAG.METEORS) && !first && S.turnNo % F.MET_EVERY === 0 && S.phase !== PHASE.PLACE) spawn_meteors(S);
    if (SS.lab4 && (fl & SS.lab4.MASK)) SS.lab4.turn_start(S, first);        // lightning, scavenge
  };

  function spawn_meteors(S) {
    const wd = SS.world, L = S.lab, n = 2 + (S.round >= 5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 8; tries++) {
        const x = M.clamp(S.O.x + rr(S, -F.MET_R, F.MET_R), 2, wd.SX - 2),
          z = M.clamp(S.O.z + rr(S, -F.MET_R, F.MET_R), 2, wd.SZ - 2),
          y = wd.topHeight(x, z);
        if (y <= wd.SEA + 0.3 || !SS.sim.in_play(S, x, z)) continue;
        SS.sim.pool_push(L.met, C.LIMITS.LAB_METEORS, { id: ++L.metN, t: S.time + F.MET_WARN, t0: S.time, x, y, z });
        SS.sim.emit(S, EV.LABMETEOR, { x, y, z, warn: F.MET_WARN });
        break;
      }
    }
    if (L.met.length) SS.sim.log(S, 'Meteors incoming!', 0xff9a6a);
  }

  /* per step: gusts (while the worm is aiming) and the meteors' impacts */
  LB.step = function (S, dt) {
    const fl = LB.flags(S);
    if (!fl || !S.lab || S.phase === PHASE.OVER) return;
    const L = S.lab;
    if (SS.lab4 && (fl & SS.lab4.MASK)) SS.lab4.step(S, dt);                    // lightning strikes, slick slopes, recoil
    if ((fl & F.FLAG.FATIGUE) && S.phase === PHASE.PLAY && S.active && !S.active.dead) {
      const a = S.active;
      if (L.lid !== a.id) {
        L.lid = a.id;
        L.lx = a.pos.x;
        L.ly = a.pos.y;
        L.lz = a.pos.z;
      }
      const d = M.len3(a.pos.x - L.lx, a.pos.y - L.ly, a.pos.z - L.lz);
      L.lx = a.pos.x; L.ly = a.pos.y; L.lz = a.pos.z;
      L.moved[a.id] = M.min(F.FAT_M, L.moved[a.id] + M.min(d, F.FAT_STEP));
    }
    if ((fl & F.FLAG.GUSTS) && S.phase === PHASE.PLAY && S.wind && SS.weather) {
      L.gustT -= dt;
      if (L.gustT <= 0) {
        L.gustT = rr(S, F.GUST_T0, F.GUST_T1);
        const w = S.wind, lo = w.lo, hi = w.hi, ga = w.gustA;
        let dir = w.dir + rr(S, -F.GUST_DIR, F.GUST_DIR);
        if (dir > M.PI) dir -= M.TAU;
        else if (dir < -M.PI) dir += M.TAU;
        const sp = M.clamp(w.speed + rr(S, F.GUST_V0, F.GUST_V1), 0, F.GUST_MAX);
        SS.weather.set_wind(S, dir, sp, ga); w.lo = lo; w.hi = hi;
        SS.sim.emit(S, EV.LABGUST, { speed: sp, dir });
        SS.sim.log(S, `A gust shifts the wind (${sp.toFixed(1)} m/s).`, 0xb8d8ff);
      }
    }
    for (let i = L.met.length - 1; i >= 0; i--) {
      const m = L.met[i];
      if (S.time >= m.t) {
        L.met.splice(i, 1);
        SS.sim.emit(S, EV.LABMETEORHIT, { x: m.x, y: m.y, z: m.z });
        SS.sim.explode(S, { x: m.x, y: m.y + 0.1, z: m.z }, { W: F.MET_W, dmg: F.MET_DMG, name: 'meteor' }, null);
      }
    }
  };

  /* HUD badge text: the active mechanics; the live state (moon, underdog) in brackets */
  const NAMES = [
    ['BANK', 'Bank'], ['UNDERDOG', 'Underdog'], ['GUSTS', 'Gusts'], ['METEORS', 'Meteors'], ['CLOCK', 'Clock'], ['MOON', 'Moon'],
    ['PERKS', 'Perks'], ['STREAK', 'Streak'], ['LONGSHOT', 'Long shot'], ['FATIGUE', 'Fatigue'], ['CRACKS', 'Cracks'],
    ['LIGHTNING', 'Lightning'], ['SLICK', 'Slick'], ['RECOIL', 'Recoil'], ['SCAVENGE', 'Scavenge']
  ];
  LB.badge = function (S) {
    const fl = LB.flags(S);
    if (!fl) return '';
    const out = [];
    for (const n of NAMES)
      if (fl & F.FLAG[n[0]]) {
        let s = n[1];
        if (n[0] === 'MOON' && S.lab && S.lab.moon) s += ' (low g)';
        else if (n[0] === 'UNDERDOG' && S.active && LB.underdog(S, S.active.team)) s += ' (+' + Math.round((F.UNDER_K - 1) * 100) + '%)';
        else if (n[0] === 'METEORS' && S.lab && S.lab.met.length) s += ' (!)';
        else if (n[0] === 'STREAK' && S.active && S.lab && S.lab.streak[S.active.team] > 0) s += ' (x' + S.lab.streak[S.active.team] + ')';
        else if (n[0] === 'FATIGUE' && S.active && LB.tired(S, S.active.id) > 0.5)
          s += ' (tired ' + (F.FAT_RAD * M.min(1, LB.tired(S, S.active.id) / F.FAT_M) * 180 / M.PI).toFixed(1) + ' deg)';
        else if (SS.lab4 && (SS.lab4.MASK & F.FLAG[n[0]])) s += SS.lab4.badge(S, n[0]);
        out.push(s);
      }
    return out.join(' · ');
  };

  LB.hash = function (S, mix) {
    const fl = LB.flags(S);
    if (!fl || !S.lab) return;
    const L = S.lab;
    mix(fl);
    mix(L.rng.s % 100003);
    mix(L.gustT);
    mix(L.moon ? 1 : 0);
    mix(L.met.length);
    mix(L.metN);
    for (const m of L.met) {
      mix(m.t);
      mix(m.x);
      mix(m.z);
    }
    if (S.wind) {
      mix(S.wind.speed);
      mix(S.wind.dir);
    }
    if ((fl & F.FLAG.CRACKS) && SS.cracks) SS.cracks.hash(S, mix);                     // P66b: the damage field
    if (SS.lab4 && (fl & SS.lab4.MASK)) SS.lab4.hash(S, mix);                           // P79
    if (fl & (F.FLAG.PERKS | F.FLAG.STREAK | F.FLAG.FATIGUE)) {
      for (let i = 0; i < 4; i++) {
        mix(L.perks[i]);
        mix(L.streak[i]);
      }
      mix(L.dealt);
      mix(L.draftRound);
      mix(L.draft.on ? L.draft.idx + 1 : 0);
      mix(L.draft.t);
      for (let i = 0; i < L.moved.length; i++) {
        mix(L.moved[i]);
        mix(L.tired[i]);
      }
    }
  };
})(window.SS = window.SS || {});
