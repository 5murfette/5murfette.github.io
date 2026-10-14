/* sim/game.js — match rules ported from the PoC "Burrow Brawl" (docs/poc-gameplay.md §1): 2-4 teams of 1-4
 * worms, worm HP, per-team control (human / CPU) and names, round-robin turns that skip dead teams, the turn timer,
 * the RETREAT window after an attack (the worm may still move, the section stays locked), sudden death after
 * sdRound rounds, per-team ammo. Portable and deterministic: sim time only, names from their own RNG stream (so the
 * layout RNG S.rng, and with it every pinned map hash, is untouched).
 * C layout: struct Team { char name[20]; u32 rgb; u8 ctl; i8 wi; i16 ammo[NWEAPONS]; u8 lastWeapon; WeaponSet ws; };
 *           ws = { f32 fz[NFUSE], mortarH, mineF } per team
 *           GameState += { u16 sdStart; f32 sdAcc, sdRise; CratePlan crPlan {u16 round; i8 kind; u8 at, n;} }
 *           GameState += { Team teams[4]; u8 nTeams; u16 round, sdRound, sdFinal; bool sudden; f32 turnT, retreatT; }.
 * API: setup(S), team_count(S), is_cpu(S, team), skill(S), next_team(S) -> team, names(S, n), step(S, dt),
 *      retreat_for(weaponKey), ammo(S, team, weaponKey), use_ammo(S, team, weaponKey). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const G = SS.game = {};
  const K = C.GAME;

  G.team_count = S => (S.teams ? S.teams.length : 2);
  G.skill = S => (
    K.SKILLS.indexOf(S.settings.cpu) >= 0 ? S.settings.cpu : K.SKILLS.indexOf(S.settings.skill) >= 0 ? S.settings.skill : 'normal'
  );
  // legacy settings (poc3: cpu = off | easy | normal | hard drives team 1); settings.ctl = ['human', 'cpu', ...] wins
  function ctlOf(st, i) {
    if (Array.isArray(st.ctl) && st.ctl[i]) return st.ctl[i] === 'cpu' ? 'cpu' : 'human';
    return i === 1 && K.SKILLS.indexOf(st.cpu) >= 0 ? 'cpu' : 'human';
  }
  G.is_cpu = (S, team) => !!(S.teams && S.teams[team] && S.teams[team].ctl === 'cpu');

  G.setup = function (S) {
    const st = S.settings, n = M.clamp(st.teams | 0 || 2, 2, 4);
    S.teams = [];
    for (let i = 0; i < n; i++) {
      const d = C.TEAMS[i],
        nm = Array.isArray(st.names) && typeof st.names[i] === 'string' && st.names[i].trim() ? st.names[i].trim().slice(0, 18) : d.name;
      const ammo = {};
      if (C.ARSENAL)
        for (const k of C.ARSENAL_ORDER) ammo[k] = C.ARSENAL[k].ammo;
      S.teams.push({
        id: i,
        name: nm,
        rgb: d.rgb,
        ctl: ctlOf(st, i),
        wi: 0,
        ammo,
        lastWeapon: null,
        ws: SS.weaponsA && SS.weaponsA.ws_make ? SS.weaponsA.ws_make() : null
      });
      if (SS.gear) S.teams[i].gear = SS.gear.setup(S);                  // rescue gear (life jackets): charges + toggle per team
    }
    const wpt = M.clamp(st.worms | 0 || 3, 1, 4);
    S.round = 1;
    S.sudden = false;
    S.sdFinal = 0;
    S.sdStart = 0;
    S.sdAcc = 0;
    S.sdRise = 0;
    S.crPlan = null;
    S.turnT = 0;
    S.retreatT = 0;
    // PoC beginMatch: ~7-9 rounds (a round earlier with 4 teams: a round is 4 turns, the matches ran 60 turns)
    S.sdRound = 6 + M.max(0, 4 - wpt) + (n > 3 ? -1 : n > 2 ? 0 : 1);
    // PoC beginMatch: a random team starts (settings.first: 'random' (default) or a team index; own seeded stream)
    const fr = st.first == null || st.first === 'random'
      ? Math.floor(M.rng_next(M.rng_make((Math.imul(st.seed | 0, 2654435761) + 977) >>> 0)) * n)
      : M.clamp(st.first | 0, 0, n - 1);
    S.teamTurn = (fr + n - 1) % n; S.firstTeam = fr; S.nextIdx = new Array(n).fill(0);
    S.playR = C.DRY.PLAY_R;          // dry worlds: the play circle (game state: sudden death shrinks it; C stays const)
  };
  /* worm names: the PoC pool shuffled per seed (own stream, never S.rng) */
  G.names = function (S, count) {
    const r = M.rng_make((Math.imul(S.settings.seed | 0, 2654435761) + 0x5eed) >>> 0 || 1), pool = C.NAMES.slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(M.rng_next(r) * (i + 1));
      const t = pool[i];
      pool[i] = pool[j];
      pool[j] = t;
    }
    const out = [];
    for (let i = 0; i < count; i++) out.push(pool[i % pool.length] + (i >= pool.length ? ' ' + (1 + Math.floor(i / pool.length)) : ''));
    return out;
  };
  /* round-robin over teams with a living worm; a wrap starts a new round (PoC pickNextTurn / startTurn) */
  // a round ends where the FIRST mover's turn would come again (seat order counted from S.firstTeam): every
  // team has had the same number of turns when sudden death starts (it used to depend on the seat of the first mover:
  // up to one turn apart)
  G.peek_team = function (S) {
    const n = G.team_count(S), from = S.teamTurn;
    // (= sim.living: a 0-HP worm is dying: no turn)
    for (let k = 1; k <= n; k++) {
      const t = (from + k) % n;
      if (SS.worm.team_alive(S, t)) return t;
    }
    return -1;
  };
  G.wraps = function (S, t) {
    const n = G.team_count(S), ft = S.firstTeam | 0;
    return S.turnNo > 0 && (t - ft + n) % n <= (S.teamTurn - ft + n) % n;
  };
  G.next_team = function (S) {
    const t = G.peek_team(S);
    if (t >= 0 && G.wraps(S, t)) S.round++;
    return t;
  };
  G.retreat_for = key => {
    const d = (C.ARSENAL && C.ARSENAL[key]) || C.WEAPONS[key];
    return d && d.retreat != null ? d.retreat : K.RETREAT;
  };
  G.ammo = (S, team, key) => {
    const t = S.teams && S.teams[team];
    if (!t || t.ammo[key] == null) return Infinity;
    return t.ammo[key];
  };
  G.use_ammo = (S, team, key) => {
    const t = S.teams && S.teams[team];
    if (t && t.ammo[key] != null && t.ammo[key] !== Infinity) t.ammo[key] = M.max(0, t.ammo[key] - 1);
  };

  /* sudden death begins at the turn change after round sdRound (if enabled). from then on the sea rises
   * CONTINUOUSLY (G.sd_step, every sim
   * step, a constant small rate: nothing jumps at a turn or round change, the turn timer is untouched; a player may end
   * a turn early to buy the next worm time). The turn change only starts it and checks for the final stand (sim.js
   * next_turn calls G.turn_change). */
  G.turn_change = function (S) {
    if (!S.settings.sd) return;
    const nt = G.peek_team(S);
    // (right where round sdRound ends)
    if (!S.sudden && (S.round > S.sdRound || (S.round === S.sdRound && nt >= 0 && G.wraps(S, nt)))) {
      S.sudden = true;
      S.sdStart = S.round;
      S.sdAcc = 0;
      S.sdRise = 0;
      SS.sim.emit(S, EV.BANNER, {
        title: 'Sudden death',
        sub: SS.world.dry ? 'The hot sand closes in' : SS.world.under || SS.world.eow ? 'The air turns foul' : 'The water keeps rising'
      });
      SS.sim.log(
        S,
        SS.world.dry
          ? 'Sudden death: the hot sand closes in, slowly.'
          : SS.world.under || SS.world.eow
          ? 'Sudden death: the air turns foul.'
          : 'Sudden death: the water rises, slowly and without pause.',
        0xff9a6a
      );
    }
    if (S.sudden) {
      const d = SS.world;
      // the final stage: nothing is left to take (caves / the End of the World have no sea to rise, the sea is at its
      // cap, the dry play circle is at its minimum) or sudden death has run SD_MAX_ROUNDS rounds (so slow a rise may
      // not get there within a match)
      const late = S.round >= (S.sdStart | 0) + K.SD_MAX_ROUNDS;
      const spent = d.under || d.eow || late || (d.dry ? S.playR <= K.SD_DRY_MIN + 1e-6 : d.SEA >= d.SY - K.SD_SEA_GAP - 1e-6);
      if (spent) {
        if (S.sdFinal === 0) {
          SS.sim.emit(S, EV.BANNER, {
            title: 'Final stand',
            sub: d.eow
              ? 'The planet\'s radiation floods the wreck'
              : d.under
              ? 'The cave air turns foul'
              : d.dry
              ? 'The heat is unbearable'
              : 'The cold sea has risen as far as it will'
          });
          SS.sim.log(S, 'Final stand: every worm now loses health, a little more every turn.', 0xff7a5a);
        }
        S.sdFinal++;
      }
    }
  };
  /* the constant rate of sudden death, m/s of sea level: SD_RISE_K per metre of map height, a little more with
   * fewer worms per team (the PoC's
   * 26 px per turn became ~0.5 m per turn of 45 s on a 40 m map, with no jumps). Deterministic: map height + settings
   * only. */
  G.sd_rate = function (S) {
    const d = SS.world, wpt = M.clamp(S.settings.worms | 0 || 3, 1, 4);
    return K.SD_RISE_K * d.SY * (1 + K.SD_RISE_WORMS * (4 - wpt));
  };
  /* one sim step of sudden death: the sea (or, in dry worlds, the play circle) moves a hair; the sea level is handed to
   * water.raise in SD_QUANT quanta */
  G.sd_step = function (S, dt) {
    if (!S.sudden || S.phase === PHASE.OVER || S.phase === PHASE.PLACE || S.phase === PHASE.PERK) return;
    const d = SS.world;
    if (d.dry) {
      S.playR = M.max(K.SD_DRY_MIN, S.playR - K.SD_DRY_RATE * dt);
      return;
    }
    if (d.under || d.eow || !SS.water || !SS.water.raise) return;
    const room = d.SY - K.SD_SEA_GAP - d.SEA;                       // (the sea stops at the cap)
    if (room <= 1e-6) {
      S.sdAcc = 0;
      return;
    }
    S.sdAcc = (S.sdAcc || 0) + G.sd_rate(S) * dt;
    for (let n = 0; S.sdAcc >= K.SD_QUANT && n < 4; n++) {
      const dh = M.min(K.SD_QUANT, d.SY - K.SD_SEA_GAP - d.SEA);
      if (!(dh > 0)) break;
      S.sdAcc -= K.SD_QUANT; SS.water.raise(S, dh); S.sdRise = (S.sdRise || 0) + dh;
    }
  };
  /* the drain of the final stage, HP per second for every living worm (0 = not yet): GAME.SD_DRAIN in the first
   * turn, +SD_DRAIN_RAMP per
   * further turn, at most SD_DRAIN_MAX. Called from sim.js hazards. */
  G.final_drain = function (S) {
    if (!(S.sdFinal > 0) || S.phase === PHASE.OVER) return 0;
    return M.min(K.SD_DRAIN_MAX, K.SD_DRAIN + K.SD_DRAIN_RAMP * (S.sdFinal - 1));
  };

  /* (PoC user placement) teams take turns placing one worm each (setup order), 15 s each on SIM time (lockstep
   * safe; the PoC used real time); a click on the section places it (lifted out of shallow ground, never into another
   * worm), Enter or the timeout auto-places, CPU teams place themselves after a short think. Reserve worms have no
   * physical presence (they are kept `dead` + `reserve` until placed, so every system ignores them). The section can
   * be rotated (about the last placed worm). After the last worm: a short settle, then the first turn. */
  const PL = { T: 15, CPU_T: 1.6, AFTER: 1.6, SEP: 1.0 };
  G.PLACE = PL;
  G.begin_placement = function (S) {
    S.placeOrder = [];
    const n = S.teams.length,
      per = S.teams.reduce((m, t, i) => M.max(m, S.worms.filter(w => w.team === i).length), 0),
      fort = !!SS.fort && SS.fort.is();
    // the first worm of each team already sits in its fort's bunker
    const seated = w => fort && w.id < n;
    for (let k = 0; k < per; k++)
      for (let t = 0; t < n; t++) {
        const w = S.worms.filter(o => o.team === t)[k];
        if (w && !seated(w)) S.placeOrder.push(w);
      }
    for (const w of S.worms) {
      if (seated(w)) continue;
      w.reserve = true;
      w.dead = true;
      w.grave = null;
    }
    S.placeIdx = 0;
    S.phase = PHASE.PLACE;
    S.placeT = PL.T;
    S.placeDone = -1;
    nextPlace(S);
  };
  function nextPlace(S) {
    const w = S.placeOrder[S.placeIdx];
    if (!w) {
      S.placeDone = S.time;
      S.active = null;
      SS.sim.emit(S, EV.BANNER, { title: 'Deployment complete', sub: 'Brace yourselves' });
      return;
    }
    S.active = w; S.placeT = PL.T; S.target = null;
    // the reserve sits at the section origin (the last placed worm / the map centre): rotation turns about it
    w.pos.x = S.O.x; w.pos.z = S.O.z;
    SS.sim.emit(S, EV.BANNER, {
      title: `${SS.sim.team_name(S, w.team)} · ${w.name}`,
      sub: G.is_cpu(S, w.team) ? 'CPU places its worm' : 'Click a spot on the section to place this worm'
    });
  }
  // a valid spot near (s, y) in the plane: lifted out of shallow ground (<= 0.6 m), above water, clear of other worms
  G.place_point = function (S, s, y) {
    const P = SS.plane, w = SS.world;
    for (let l = 0; l <= 0.6 + 1e-6; l += 0.05) {
      const yy = y + l, p = P.to_world(S, s, yy);
      if (yy < 0.6 || yy > w.SY - 1 || P.overlap2(S, s, yy) > 0) continue;
      if (yy - 0.5 < SS.sim.surface_at(S, p.x, p.z)) return null;
      // only on the team's own fort
      if (S.active && SS.fort && SS.fort.is() && !SS.fort.spot_ok(p.x, p.z, yy, S.active.team)) return null;
      if (w.dry && !SS.sim.in_play(S, p.x, p.z)) return null;
      if (S.worms.some(o => !o.dead && M.len3(o.pos.x - p.x, o.pos.y - yy, o.pos.z - p.z) < PL.SEP)) return null;
      return { x: p.x, y: yy, z: p.z };
    }
    return null;
  };
  function put(S, w, p, how) {
    w.reserve = false; w.dead = false; w.hp = w.hp0 || w.hp;
    w.pos.x = p.x;
    w.pos.y = p.y;
    w.pos.z = p.z;
    w.vel = { x: 0, y: 0, z: 0 };
    w.rest = false;
    w.vs = 0;
    w.vy = 0;
    // the section jumps to the new worm: rebuild it and treat the jump like a turn of the section (the material edge
    // fades out and is rebuilt here, else the old outline stays while a CPU places elsewhere)
    S.O.x = p.x;
    S.O.z = p.z;
    S.sectionDirty = true;
    S.lastRotate = S.time;
    // hangs until the beam has built it
    if (SS.weapons && SS.weapons.tele_hold) SS.weapons.tele_hold(w, p.x, p.y, p.z);
    SS.sim.emit(S, EV.TELEPORT, { wormId: w.id, from: { x: p.x, y: p.y + 30, z: p.z }, to: { x: p.x, y: p.y, z: p.z }, deploy: 1 });
    SS.sim.log(S, `${w.name} ${how}.`, SS.sim.team_rgb(S, w.team));
    S.placeIdx++; nextPlace(S);
  }
  function autoSpot(S) {
    const taken = S.worms.filter(o => !o.dead).map(o => ({ x: o.pos.x, z: o.pos.z }));
    const fo = S.active && SS.fort && SS.fort.is() ? { team: S.active.team } : undefined;     // (fort mode: its own fort)
    const sp = SS.sim.find_spot(S, 8, taken, fo) || SS.sim.find_spot(S, 3, taken, fo);
    return sp ? { x: sp.x, y: sp.y + 0.55, z: sp.z } : null;
  }
  // deaths during deployment are immediate (PoC: no beat while placing)
  G.flush_dying = function (S) {
    for (let k = 0; k < 8; k++) {
      const d = S.worms.find(w => !w.dead && w.dying);
      const g = S.worms.find(w => w.dead && w.gravePending);
      if (d) SS.sim.die_now(S, d);
      else if (g) {
        g.gravePending = false;
        if (g.grave) {
          g.grave.landT = -1;
          g.grave.blown = true;
        }
        if (g.grave)
          SS.sim.explode(
            S,
            { x: g.grave.x, y: g.grave.y + 0.2, z: g.grave.z },
            { W: M.pow(26 / 44, 3), dmg: 18, name: 'an exploding grave' },
            null
          );
      } else break;
    }
  };
  G.place_step = function (S, inp, dt) {
    if (S.placeDone >= 0) {
      if (S.time - S.placeDone >= PL.AFTER) {
        S.phase = PHASE.PLAY;
        for (const w of S.worms) { w.reserve = false; }
        SS.sim.next_turn(S, true);
      }
      return;
    }
    const w = S.active;
    if (!w) return;
    S.placeT -= dt;
    const cpu = G.is_cpu(S, w.team);
    if (!cpu && inp.tgt && inp.fire_pressed) {
      const p = G.place_point(S, inp.ts, inp.ty);
      if (p) return put(S, w, p, 'is deployed');
      SS.sim.log(S, SS.fort && SS.fort.is() ? 'No room there (place the worm on your own fort).' : 'No room there.', 0xffb27a);
    }
    if ((!cpu && inp.jump) || (cpu && S.placeT <= PL.T - PL.CPU_T) || S.placeT <= 0) {
      const p = autoSpot(S);
      if (p) put(S, w, p, S.placeT <= 0 ? 'is deployed (time up)' : 'is deployed');
      else {
        S.placeIdx++;
        nextPlace(S);
      }
    }
  };

  /* PoC "Buried rooms" (setup option): two chambers deep in solid ground (PoC: 70-100 x 34-44 px brick rooms, 4.5-15 m
   * down; here 4.4-6 m x 2.8-3.6 m x 2.4 m, walls of sandstone 'brick' 0.5 m thick, 3-9 m of ground above), each with
   * two crates and a fuel barrel and a torch (render light). Reached by digging (torch / drill) or blasting.
   * S.rooms[]. */
  G.rooms = function (S) {
    const w = SS.world, H = w.H, rnd = () => M.rng_next(S.rng), out = [];
    for (let k = 0, tries = 0; k < 2 && tries < 600; tries++) {
      const rx = 2.2 + rnd() * 0.8,
        rz = 1.4 + rnd() * 0.4,
        rh = 2.4,
        cx = 12 + rnd() * (w.SX - 24),
        cz = 12 + rnd() * (w.SZ - 24),
        top = w.topHeight(cx, cz);
      const y0 = top - 3 - rnd() * 6 - rh;
      if (y0 < 2 || y0 < w.SEA + 0.5 || (w.dry && !SS.sim.in_play(S, cx, cz))) continue;
      if (out.some(r => M.len2(r.x - cx, r.z - cz) < 12)) continue;
      let ok = true;
      for (let x = cx - rx - 0.8; x <= cx + rx + 0.8 && ok; x += 0.5)
        for (let z = cz - rz - 0.8; z <= cz + rz + 0.8 && ok; z += 0.5)
          for (let y = y0 - 0.8; y <= y0 + rh + 0.8; y += 0.5) {
            if (w.sample(x, y, z) <= 0 || w.mat_at(x, y, z) === C.MAT.LAVA) {
              ok = false;
              break;
            }
          }
      if (!ok || S.worms.some(o => M.len2(o.pos.x - cx, o.pos.z - cz) < rx + 2 && Math.abs(o.pos.y - y0) < 4)) continue;
      const i0 = Math.floor((cx - rx - 1) / H),
        i1 = Math.ceil((cx + rx + 1) / H),
        k0 = Math.floor((cz - rz - 1) / H),
        k1 = Math.ceil((cz + rz + 1) / H);
      const j0 = Math.floor((y0 - 1) / H), j1 = Math.ceil((y0 + rh + 1) / H);
      for (let kk = k0; kk <= k1; kk++)
        for (let j = j0; j <= j1; j++)
          for (let i = i0; i <= i1; i++) {
            const o = (kk * w.NY + j) * w.NX + i, x = i * H, y = j * H, z = kk * H;
            const d = M.max(M.max(Math.abs(x - cx) - rx, Math.abs(z - cz) - rz), M.max(y0 - y, y - (y0 + rh)));   // box SDF (+ outside)
            if (d < 0) {
              w.d[o] = M.max(-0.6, d);
              w.mat[o] = C.MAT.AIR;
              w.heat[o] = 0;
            }
            else if (d < 0.5 && w.d[o] > 0) {
              w.d[o] = M.max(0.2, d);
              w.mat[o] = C.MAT.SANDSTONE;
            }
          }
      w.mark(i0, j0, k0, i1, j1, k1);
      out.push({ x: cx, y: y0, z: cz, rx, rz, rh }); k++;
    }
    S.rooms = out;
  };
  G.furnish_rooms = function (S) {
    if (!SS.scatter) return;
    for (const r of S.rooms || []) {
      SS.scatter.add(S, 'crate', { x: r.x - r.rx * 0.5, y: r.y + 0.4, z: r.z - 0.3 }, 0.3);
      SS.scatter.add(S, 'crate', { x: r.x - r.rx * 0.5 + 0.8, y: r.y + 0.4, z: r.z + 0.4 }, 1.1);
      SS.scatter.add(S, 'barrel', { x: r.x + r.rx * 0.5, y: r.y + 0.6, z: r.z }, 0);
    }
  };

  /* per step: the turn clock (play phase only; 0 = no limit) and the retreat window */
  G.step = function (S, dt) {
    G.sd_step(S, dt);                                                 // sudden death, every step
    if (S.phase === PHASE.PLAY && S.settings.turnTime > 0 && S.active && !S.active.dead) {
      S.turnT -= dt;
      if (S.turnT <= 0) {
        S.turnT = 0;
        if (S.charging) SS.sim.fire(S);                                 // a charging shot is released (PoC)
        else {
          SS.sim.log(S, `Time's up for ${S.active.name}.`, 0xffb27a);
          SS.sim.end_turn(S, 0.3);
        }
      }
    }
    if (S.phase === PHASE.ATTACK && S.retreatT > 0 && !S.dig) {               // (the torch / drill runs first)
      S.retreatT -= dt;
      if (S.retreatT <= 0 || !S.active || S.active.dead) SS.sim.end_retreat(S);
    }
  };
})(window.SS = window.SS || {});
