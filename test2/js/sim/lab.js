/* sim/lab.js — P42 "Lab": experimental game mechanics, each a flag of settings.labFlags (int bit mask, OFF = 0 by default).
 * With every flag off nothing here changes a single number of the simulation (the hooks return neutral values, no RNG
 * draws, no hash input), so a match without the Lab equals the pre-Lab game bit for bit. The mask travels with the match
 * settings (menu NET_KEYS -> the net 'start' message), so both lockstep peers run the same rules. Portable and
 * deterministic: sim time only, its own RNG stream S.lab.rng, no Map / Set, a capped pool (C.LIMITS.LAB_METEORS).
 *
 *   BANK      bank shot:  a bouncing shell (grenade, banana, ...) that hit terrain / props with a hard bounce (> 2 m/s) before it
 *             goes off deals +20 % blast damage per such bounce (up to +60 %) to worms of the other teams.
 *   UNDERDOG  comeback:   a team whose living worms hold half the HP (or less) of the strongest other team deals +35 % blast damage.
 *   GUSTS     weather:    during a turn (aiming) the wind shifts every 6-12 s (heading +-0.9 rad, speed -4..+5 m/s, 0..11 m/s).
 *   METEORS   hazard:     from turn 3 on, every 3rd turn 2-3 meteors are announced (red rings on the ground) and hit 2.2 s later
 *             (blast W METEOR_W, within MET_R m of the section origin, never in water).
 *   CLOCK     overtime:   the turn clock shrinks 10 % per round (down to CLOCK_MIN s); only with a turn time set.
 *   MOON      low gravity: every 3rd round worms and props fall with MOON_K x gravity (shells are not affected).
 * C layout: struct Lab { u32 rng; f32 gustT; i32 meteorN; Meteor met[LAB_METEORS]; u8 moon, bankN; f32 bankK; i32 evTick; };
 *           struct Meteor { i32 id; f32 t, x, y, z; };  settings.labFlags: u8.
 * API: init(S), flags(S), on(S, bit), turn_start(S, first), step(S, dt), gravity_k(S), bank_set(S, n), dmg_k(S, ownerId, w),
 *   underdog(S, team), badge(S) -> text, hash(S, mix). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const LB = SS.lab = {};
  const F = C.LAB;                      // (the constants live in config.js: sim.js reads BANK_SPEED even where this module is not loaded)
  const rng = S => M.rng_next(S.lab.rng);
  const rr = (S, a, b) => a + (b - a) * rng(S);

  LB.flags = S => ((S.settings.labFlags | 0) & F.ALL);
  LB.on = (S, bit) => (LB.flags(S) & bit) !== 0;
  LB.lab_make = S => ({ rng: M.rng_make(((Math.imul(S.settings.seed | 0, 48271) + 0x1ab5) >>> 0) || 1), gustT: 0, met: [], metN: 0, moon: false, bankN: 0, bankK: 1, evTick: -1, underAnn: -1 });
  LB.init = function (S) { S.lab = LB.lab_make(S); S.lab.gustT = F.GUST_T0; };

  /* strength of a team = HP of its living worms */
  function teamHp(S, t) { let h = 0; for (const w of S.worms) if (!w.dead && w.team === t) h += w.hp; return h; }
  LB.underdog = function (S, team) {
    if (!LB.on(S, F.FLAG.UNDERDOG) || !S.teams) return false;
    const mine = teamHp(S, team); if (mine <= 0) return false;
    let best = 0; for (let t = 0; t < S.teams.length; t++) if (t !== team) best = M.max(best, teamHp(S, t));
    return mine <= best * F.UNDER_RATIO;
  };

  /* ---------- hooks ---------- */
  LB.gravity_k = S => (S.lab && S.lab.moon ? F.MOON_K : 1);
  LB.bank_set = function (S, n) { if (S.lab) { S.lab.bankN = n | 0; } };
  /* the blast damage factor for worm w hit by a blast of owner ownerId (a worm id, null / -1 = none: a meteor, a barrel) */
  LB.dmg_k = function (S, ownerId, w) {
    const fl = LB.flags(S); if (!fl || !S.lab || ownerId == null || ownerId < 0) return 1;
    const o = S.worms[ownerId]; if (!o || o.team === w.team) return 1;
    let k = 1;
    if ((fl & F.FLAG.BANK) && S.lab.bankN > 0) {
      const kb = 1 + F.BANK_K * M.min(S.lab.bankN, F.BANK_MAX); k *= kb;
      if (S.lab.evTick !== S.tick) { S.lab.evTick = S.tick; SS.sim.emit(S, 'labbank', { wormId: ownerId, bounces: S.lab.bankN, k: kb }); SS.sim.log(S, `Bank shot x${kb.toFixed(1)}!`, 0xffe08a); }
    }
    if ((fl & F.FLAG.UNDERDOG) && LB.underdog(S, o.team)) k *= F.UNDER_K;
    return k;
  };

  /* turn start (sim.next_turn, after the turn clock is set) */
  LB.turn_start = function (S, first) {
    const fl = LB.flags(S); if (!fl || !S.lab) return;
    const L = S.lab, sim = SS.sim;
    if (fl & F.FLAG.CLOCK) {
      if (S.settings.turnTime > 0) {
        const t0 = S.settings.turnTime, lo = M.min(t0, F.CLOCK_MIN), pct = M.max(0, 100 - F.CLOCK_PCT * M.max(0, S.round - 1)), t = M.max(lo, Math.floor(t0 * pct / 100 + 0.5));   // (integer percent: 45 s at round 4 is exactly 31.5 -> 32)
        S.turnT = t;
      }
    }
    if (fl & F.FLAG.MOON) {
      const moon = S.round % F.MOON_EVERY === 0;
      if (moon !== L.moon) {
        L.moon = moon;
        if (moon) { sim.emit(S, 'banner', { title: 'Moon phase', sub: 'Low gravity this round' }); sim.log(S, 'Moon phase: low gravity this round.', 0xb8c8ff); }
      }
    } else L.moon = false;
    L.gustT = rr(S, F.GUST_T0, F.GUST_T1) * ((fl & F.FLAG.GUSTS) ? 1 : 0);
    if ((fl & F.FLAG.UNDERDOG) && S.active && LB.underdog(S, S.active.team) && L.underAnn !== S.turnNo) {
      L.underAnn = S.turnNo; sim.emit(S, 'labunder', { team: S.active.team }); sim.log(S, `${sim.team_name(S, S.active.team)} are the underdogs: +${Math.round((F.UNDER_K - 1) * 100)} % blast damage.`, 0xffc08a);
    }
    if ((fl & F.FLAG.METEORS) && !first && S.turnNo % F.MET_EVERY === 0 && S.phase !== 'place') spawn_meteors(S);
  };

  function spawn_meteors(S) {
    const wd = SS.world, L = S.lab, n = 2 + (S.round >= 5 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 8; tries++) {
        const x = M.clamp(S.O.x + rr(S, -F.MET_R, F.MET_R), 2, wd.SX - 2), z = M.clamp(S.O.z + rr(S, -F.MET_R, F.MET_R), 2, wd.SZ - 2), y = wd.topHeight(x, z);
        if (y <= wd.SEA + 0.3 || !SS.sim.in_play(S, x, z)) continue;
        SS.sim.pool_push(L.met, C.LIMITS.LAB_METEORS, { id: ++L.metN, t: S.time + F.MET_WARN, t0: S.time, x, y, z });
        SS.sim.emit(S, 'labmeteor', { x, y, z, warn: F.MET_WARN });
        break;
      }
    }
    if (L.met.length) SS.sim.log(S, 'Meteors incoming!', 0xff9a6a);
  }

  /* per step: gusts (while the worm is aiming) and the meteors' impacts */
  LB.step = function (S, dt) {
    const fl = LB.flags(S); if (!fl || !S.lab || S.phase === 'over') return;
    const L = S.lab;
    if ((fl & F.FLAG.GUSTS) && S.phase === 'play' && S.wind && SS.weather) {
      L.gustT -= dt;
      if (L.gustT <= 0) {
        L.gustT = rr(S, F.GUST_T0, F.GUST_T1);
        const w = S.wind, lo = w.lo, hi = w.hi, ga = w.gustA;
        let dir = w.dir + rr(S, -F.GUST_DIR, F.GUST_DIR); if (dir > M.PI) dir -= M.TAU; else if (dir < -M.PI) dir += M.TAU;
        const sp = M.clamp(w.speed + rr(S, F.GUST_V0, F.GUST_V1), 0, F.GUST_MAX);
        SS.weather.set_wind(S, dir, sp, ga); w.lo = lo; w.hi = hi;
        SS.sim.emit(S, 'labgust', { speed: sp, dir });
        SS.sim.log(S, `A gust shifts the wind (${sp.toFixed(1)} m/s).`, 0xb8d8ff);
      }
    }
    for (let i = L.met.length - 1; i >= 0; i--) {
      const m = L.met[i];
      if (S.time >= m.t) {
        L.met.splice(i, 1);
        SS.sim.emit(S, 'labmeteorhit', { x: m.x, y: m.y, z: m.z });
        SS.sim.explode(S, { x: m.x, y: m.y + 0.1, z: m.z }, { W: F.MET_W, dmg: F.MET_DMG, name: 'meteor' }, null);
      }
    }
  };

  /* HUD badge text: the active mechanics; the live state (moon, underdog) in brackets */
  const NAMES = [['BANK', 'Bank'], ['UNDERDOG', 'Underdog'], ['GUSTS', 'Gusts'], ['METEORS', 'Meteors'], ['CLOCK', 'Clock'], ['MOON', 'Moon']];
  LB.badge = function (S) {
    const fl = LB.flags(S); if (!fl) return '';
    const out = [];
    for (const n of NAMES) if (fl & F.FLAG[n[0]]) {
      let s = n[1];
      if (n[0] === 'MOON' && S.lab && S.lab.moon) s += ' (low g)';
      else if (n[0] === 'UNDERDOG' && S.active && LB.underdog(S, S.active.team)) s += ' (+' + Math.round((F.UNDER_K - 1) * 100) + '%)';
      else if (n[0] === 'METEORS' && S.lab && S.lab.met.length) s += ' (!)';
      out.push(s);
    }
    return out.join(' · ');
  };

  LB.hash = function (S, mix) {
    const fl = LB.flags(S); if (!fl || !S.lab) return;
    const L = S.lab; mix(fl); mix(L.rng.s % 100003); mix(L.gustT); mix(L.moon ? 1 : 0); mix(L.met.length); mix(L.metN);
    for (const m of L.met) { mix(m.t); mix(m.x); mix(m.z); }
    if (S.wind) { mix(S.wind.speed); mix(S.wind.dir); }
  };
})(window.SS = window.SS || {});
