/* sim/ai.js — CPU opponent (Step 9a). Portable, deterministic (own RNG stream S.aiRng; it only reads the state and
 * produces an Input struct / calls sim.fire like a player would).
 * A CPU turn: THINK (AI_THINK s, for the eye) -> choose a target (enemies ordered by distance; up to TARGETS tried) ->
 * align the section with it (sim.align_to, wait until the rotation has arrived) -> SEARCH weapon x aim x power with a
 * lightweight copy of the 2D flight (gravity, the in-plane wind push of stepProjectiles with the weapon's windK, water
 * entry, terrain / body collisions, grenade bounces with the sim's restitution and its 3 s fuse, rocket contact with
 * worms), coarse grid then a fine grid around the best, spread over sim steps (EVAL_PER_STEP predictions per step)
 * -> score each burst point by the expected blast damage (blast.js worm_effect, capped by HP, +KILL bonus) to enemies
 * minus OWN_K x damage to the own team (the CPU itself included) -> aim noise by difficulty -> FIRE (sim.fire).
 * No positive shot: walk toward the target for WALK_T s and search again once, else end the turn.
 * Settings: S.settings.cpu = 'off' | 'easy' | 'normal' | 'hard' (team 1 is the CPU). Difficulty: search grid + noise.
 * API: is_cpu(S, team), control(S, a, dt) -> Input, stats(S). C layout: struct Ai { u8 phase; f32 t; Plan best;
 *   Cand cand[]; i32 next; Rng rng; }. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane;
  const AI = SS.ai = {};
  const W = () => SS.world;
  const K = { TURN_MAX: 30, SPECIAL_MIN: 18, THINK: 0.8, TARGETS: 3, EVAL_PER_STEP: 14, OWN_K: 2.2, TAIL_K: 0.7, TAIL_FREE: 6, NEAR_D: 4.5,
    NEAR_PEN: 45, BREACH_K: 8, BREACH_MIN: 1.0, BREACH_OWN: 12, BREACH_R: 1.9, SEALED_N: 10, SELF_RISK: 500, SELF_DV: 7, KILL: 25,
    WALK_T: 2.5, MAX_T: 7,
    // aim / power noise = the PoC's skills exactly (Rookie / Soldier / Sharpshooter, PoC aiStep: [0.1, 0.12], [0.04,
    // 0.045], [0.01, 0.012]); aim / pow = the search grid steps
    DIFF: {
      easy: { aim: 0.12, pow: 0.12, noiseA: 0.1, noiseP: 0.12 },
      normal: { aim: 0.08, pow: 0.08, noiseA: 0.04, noiseP: 0.045 },
      hard: { aim: 0.05, pow: 0.05, noiseA: 0.01, noiseP: 0.012 }
    } };
  AI.K = K;
  const rng = S => M.rng_next(S.aiRng);
  /* CPU state created at every reset: the RNG stream, the memory across turns (struct AiMem { f32 recent[4] (decayed
   * shots at each team); struct { i32 id, turn; } bad[16]
   * (crates it could not reach) }) and no plan yet (S.aiPlan = null until the CPU's first turn; the plan struct is
   * plan_make). */
  AI.init = function (S) {
    S.aiRng = M.rng_make((Math.imul(S.settings.seed | 0, 40503) + 0xa1) >>> 0 || 1);
    S.aiMem = { recent: [0, 0, 0, 0], bad: [] };
    S.aiPlan = null;
  };
  const gauss = S => {
    const u = M.max(1e-9, rng(S)), v = rng(S);
    return Math.sqrt(-2 * M.log(u)) * M.cos(6.283185 * v);
  };
  AI.is_cpu = (S, team) => SS.game.is_cpu(S, team);                     // P1: per-team control (sim/game.js)

  /* ---------- the flight copy ---------- */
  const wv = { x: 0, y: 0, z: 0 }, wp0 = { x: 0, y: 0, z: 0 }, wp = { x: 0, y: 0, z: 0 };    // reused temporaries (C: static vec3)
  /* P38-R4: the worms' plane coordinates, computed once per predict call (their positions do not change within it; the
   * same
   * arithmetic as plane.js to_plane, so the values are bit-identical). C: struct PlaneWorm { Worm *o; f32 s, t;
   * }[MAXW]. */
  const PW = [];
  function planeWorms(S, c, sn) {
    const ws = S.worms;
    let n = 0;
    for (let i = 0; i < ws.length; i++) {
      const o = ws[i];
      if (o.dead) continue;
      const e = PW[n] || (PW[n] = { o: null, s: 0, t: 0 }), dx = o.pos.x - S.O.x, dz = o.pos.z - S.O.z;
      e.o = o;
      e.s = dx * c + dz * sn;
      e.t = -dx * sn + dz * c;
      n++;
    }
    PW.length = n; return PW;
  }
  const eg = { s: 0, y: 0 };                                  // (P68c: the chunk field's pull on a predicted shell)
  // the non-worm plane bodies of one predict call (worm discs are skipped anyway)
  const NB = [];
  // P99: distance of the shooter to the first ground / body contact of the last predict (a shell that touches down next
  // to the thrower rolls back on it; static f32)
  let firstD = 1e9;
  function predict(S, weapon, aim, facing, power, tgt) {      // tgt { s, y }: the homing missile's target (plane coordinates)
    // P11: any charged projectile of the arsenal (impact vs bouncy, its speed, restitution, friction, fuse, wind)
    const a = S.active,
      def = C.WEAPONS[weapon],
      pd = C.PROJ[weapon] || def,
      w = W(),
      d = P.dir(S),
      co = M.cos(S.theta),
      si = M.sin(S.theta),
      ap = P.to_plane(S, a.pos),
      pw = planeWorms(S, co, si),
      ox = S.O.x,
      oz = S.O.z,
      PB = S.planeBodies;
    NB.length = 0;
    for (let i = 0; i < PB.length; i++)
      if (PB[i].worm < 0) NB.push(PB[i]);
    const imp = !!pd.impact,
      vmax = def.vmax || 28,
      speed = vmax * M.max(C.WORM_DYN.MIN_POWER, power),
      ds = facing * M.cos(aim),
      dy = M.sin(aim);
    const rest = pd.rest != null ? pd.rest : 0.45, fric = pd.fric != null ? pd.fric : 0.9;
    let s = ap.s + ds * 0.7, y = a.pos.y + dy * 0.7, vs = ds * speed, vy = dy * speed, t = 0, wet = false;
    firstD = 1e9;
    const fuse = SS.weaponsA ? SS.weaponsA.fuse_of(S, weapon) : pd.fuseSet ? S.fuse : (pd.fuse || 99),
      dt = 1 / 60,
      wk = pd.windK != null ? pd.windK : 1,
      k = C.WIND_GAIN * wk;
    // homing (= weapons.js pre): lock phase (low gravity, little wind), then steering toward the target at `turn` rad/s
    // with the speed growing by `accel`, for `fuel` s, then a plain shell again
    const hm = pd.homing && tgt ? pd.homing : null, hd0 = hm ? M.len2(tgt.s - s, tgt.y - y) : 0, hv0 = speed;
    let gk = 1, wkk = 1, esc = 0;
    while (t < K.MAX_T) {
      if (hm && !wet) {
        const age = t + dt, lock = M.clamp(hd0 / M.max(1, hv0) * 0.5, hm.lock0, hm.lock1);
        if (age < lock) {
          gk = hm.gLock;
          wkk = hm.windLock;
        }
        else if (age < lock + hm.fuel) {
          const blend = M.min(1, (age - lock) / hm.blend), want = M.atan2(tgt.y - y, tgt.s - s), cur = M.atan2(vy, vs);
          const da = M.clamp(M.wrap_angle(want - cur), -hm.turn * blend * dt, hm.turn * blend * dt),
            sp = M.min(hm.vmax, M.len2(vs, vy) + hm.accel * dt);
          vs = M.cos(cur + da) * sp;
          vy = M.sin(cur + da) * sp;
          gk = hm.gFly;
          wkk = 0;
        } else {
          gk = 1;
          wkk = 1;
        }
      }
      wp0.x = ox + s * co;
      wp0.y = y;
      wp0.z = oz + s * si;
      const wke = wk * wkk;
      // P68g: a shot that leaves every gravity well is lost (the sim's rule): never planned
      if (S.eow && (esc = SS.eow.esc_step(S, wp0.x, y, wp0.z, vs, vy, d, esc, dt)) < 0) return null;
      // = stepProjectiles
      if (SS.weather && !wet && wke > 0) {
        SS.weather.wind_at(S, wp0.x, y, wp0.z, wv);
        const ws = wv.x * d.x + wv.z * d.z;
        vs += ws / C.WIND_UNIT * C.WIND_ACC * wke * dt;
        vy += (wv.y - vy) * C.WIND_GAIN * wke * dt * 0.04;
      }
      const n = M.max(1, Math.ceil(M.len2(vs, vy) * dt / 0.12)), h = dt / n;
      for (let i = 0; i < n; i++) {
        // P68c: the same fields as the real shell
        if (wet) {
          const dr = M.exp(-2.6 * h);
          vs *= dr;
          vy = vy * dr - C.G * 0.55 * h;
        } else if (S.eow) {
          SS.eow.proj_acc(S, wp0.x, y, wp0.z, d.x, d.z, eg);
          vs += eg.s * gk * h;
          vy += eg.y * gk * h;
        } else vy -= C.G * gk * h;
        const ns = s + vs * h, ny = y + vy * h;
        wp.x = ox + ns * co;
        wp.y = ny;
        wp.z = oz + ns * si;
        // (= sim.js OOB_SEA)
        if (
          (w.dry ? SS.sim.arena_r(wp.x, wp.z) > C.DRY.FAR_R : wp.x < -120 || wp.z < -120 || wp.x > w.SX + 120 || wp.z > w.SZ + 120)
          || ny < 0.2
        ) return null;
        // sea ice (as sim.js: before the water entry): a rocket bursts on it, a grenade bounces unless it punches
        // through
        if (SS.ice && S.ice && !wet && vy < 0) {
          const it = SS.ice.top_at(S, wp.x, wp.z);
          if (it > -1e8 && ny < it && y >= it - 0.08) {
            const through = SS.ice.would_punch(S, wp.x, wp.z, def.mass || 0.6, -vy);       // (P30: the speed into the ice)
            if (!through && imp) return { x: wp.x, y: it + 0.05, z: wp.z, t, wet: false };
            // (= sim.js)
            if (!through) {
              vy = -vy > 1.5 ? -vy * 0.45 : 0;
              vs *= M.exp(-0.25 * h);
              if (Math.abs(vs) < 0.05) vs = 0;
              y = it + 0.001;
              s = ns;
              continue;
            }
          }
        }
        if (!wet && ny < SS.sim.surface_at(S, wp.x, wp.z) && vy < 0) {
          if (imp) return { x: wp.x, y: ny, z: wp.z, t, wet: true };
          wet = true; vs *= 0.35; vy *= 0.3;
        }
        if (imp && t > 0.2)
          for (const o of S.worms)
            if (!o.dead && o !== a && M.len3(wp.x - o.pos.x, ny - o.pos.y, wp.z - o.pos.z) < C.WORM_R + 0.12)
              return { x: wp.x, y: ny, z: wp.z, t, wet };
        // a bouncing shell bounces off a worm's body (= sim.js wormBounce, P32)
        if (!imp && !pd.foam) {
          let hitO = null;
          for (let wi = 0; wi < pw.length; wi++) {
            const q = pw[wi], o = q.o;
            if (o.drowning || o.swim || (o === a && t < 0.25)) continue;   /* (= sim.js wormBounce: no swimmers) */ if (
              Math.abs(q.t) <= C.WORM_R && M.len2(ns - q.s, ny - o.pos.y) < C.WORM_R + (pd.r || 0.06)
            ) {
              hitO = { s: q.s, t: q.t, y: o.pos.y };
              break;
            }
          }
          if (hitO) {
            const rr = C.WORM_R + (pd.r || 0.06),
              dd = M.len2(ns - hitO.s, ny - hitO.y),
              ux = dd > 1e-4 ? (ns - hitO.s) / dd : 0,
              uy = dd > 1e-4 ? (ny - hitO.y) / dd : 1,
              vn = vs * ux + vy * uy;
            if (vn < 0) {
              vs -= 1.15 * vn * ux;
              vy -= 1.15 * vn * uy;
              vs *= 0.5;
              vy *= 0.5;
            }
            if (!P.solid2(S, hitO.s + ux * rr, hitO.y + uy * rr)) {
              s = hitO.s + ux * rr;
              y = hitO.y + uy * rr;
            }
            continue;
          }
        }
        // (= P.body_at2(S, ns, ny, true): the first non-worm body that holds the point)
        let hb = null;
        for (let bi = 0; bi < NB.length; bi++) {
          const b = NB[bi], bs = ns - b.s, by = ny - b.y;
          if (b.kind === 0 ? bs * bs + by * by < b.r * b.r : Math.abs(bs) < b.hs && Math.abs(by) < b.hy) {
            hb = b;
            break;
          }
        }
        const solid2 = w.sample(wp.x, ny, wp.z) > 0, solid = solid2 || (hb !== null && !hb.ice);          // ice is handled above
        if (solid) {
          if (imp) return { x: wp.x, y: ny, z: wp.z, t, wet };
          const nn = P.normal2(S, ns, ny), vn = vs * nn.s + vy * nn.y;
          if (firstD > 1e8) firstD = M.len2(ns - ap.s, ny - a.pos.y);
          if (vn < 0) {                                          // (= sim.js stepProjectiles: sand / snow / ash are soft, ice is slick)
            const mat = solid2 ? w.mat_at(wp.x, wp.y, wp.z) : 0,
              soft = mat === C.MAT.SNOW || mat === C.MAT.SAND || mat === C.MAT.ASH ? 0.55 : mat === C.MAT.ICE ? 1.15 : 1;
            const fr = mat === C.MAT.ICE ? 0.98 : fric * soft + 0.1 * (1 - soft);
            vs -= (1 + rest * soft) * vn * nn.s;
            vy -= (1 + rest * soft) * vn * nn.y;
            vs *= fr;
            vy *= fr;
            if (M.len2(vs, vy) < 0.8) {
              vs = 0;
              vy = 0;
            }
          }
        } else {
          s = ns;
          y = ny;
        }
      }
      t += dt;
      if (t >= fuse) { return { x: ox + s * co, y, z: oz + s * si, t, wet }; }
    }
    return null;
  }
  /* the charge / PoC damage the search scores a shot with. The black hole has none of its own: it pulls everything
   * within SUCK_R to the core and bursts there
   * (A.HOLE.W_END, 44 HP), so what it pulls in takes the full blast (x 1.3) */
  const burstW = k => {
    const pj = C.PROJ[k];
    return pj && pj.hole ? C.ARMS.HOLE.W_END : (pj || C.WEAPONS[k]).W;
  };
  const burstDmg = k => {
    const pj = C.PROJ[k] || {};
    return pj.hole ? 44 * 1.3 : pj.dmg;
  };
  // value of a burst at c: blast damage (capped by HP) to enemies, + KILL per kill, - OWN_K x damage to the own team
  function score(S, c, W, split, dmg) {                              // dmg: the PoC damage of that blast (P24.1)
    const me = S.active.team;
    let v = 0;
    if (split) W += split.n * (C.PROJ[split.kind].W) * 0.35;           // bomblets scatter: a fraction of their charge counts
    // the bomblets can land anywhere within ~SCAT m (their throw at 0.65 v + jitter): own worms in that ring are at
    // risk
    if (split) {
      const SCAT = split.jx * 1.1;
      for (const o of S.worms)
        if (!o.dead && o.team === me && M.len2(o.pos.x - c.x, o.pos.z - c.z) < SCAT) v -= (o === S.active ? 2.2 : K.OWN_K) * 30;
    }
    for (const o of S.worms) {
      if (o.dead) continue;
      const e = SS.blast.worm_effect(c, W, o.pos, dmg), dm = M.min(o.hp, Math.round(e.dmg));
      // PoC evalBoom: own team x 1.5 (here OWN_K), the shooter itself x 2.2, + 60 per own worm killed
      // (P38-R2: a nearly dead shooter must not risk its last HP)
      if (o.team === me) v -= (o === S.active ? 2.2 : K.OWN_K) * dm + (dm >= o.hp ? (o === S.active && o.hp <= 15 ? 120 : 60) : 0);
      else v += dm + (dm >= o.hp ? K.KILL : 0);
    }
    if (SS.alien && SS.alien.ai_value) v += SS.alien.ai_value(S, c, W, dmg);     // P37: hurting the alien is worth something
    const pr = S.aiPlan && S.aiPlan.props;                           // P38: a barrel / mine the blast sets off goes off where it lies
    if (pr)
      for (let i = 0; i < pr.length; i++) v += propValue(S, c, W, pr[i], me);
    return v;
  }
  // P38: value of a prop (barrel: set off by the overpressure above BARREL.KPA; mine: only inside the hole radius) that
  // the blast at c (charge W) reaches; its own explosion scored like the shot's (x 0.8: the delay lets the targets move
  // a little)
  function propValue(S, c, W, pr, me) {
    const P0 = C.PROPS || {}, B = P0.BARREL, Mi = P0.MINE;
    if (!B || !Mi) return 0;
    const d = M.len3(pr.x - c.x, pr.y - c.y, pr.z - c.z);
    if (d > 14 * M.cbrt(W)) return 0;
    let w2, dm2;
    if (pr.kind === 'barrel') {
      if (SS.blast.overpressure(M.max(0.2, d - 0.3), W) <= B.KPA) return 0;
      w2 = B.W;
      dm2 = B.DMG;
    }
    else {
      if (d - 0.2 >= Mi.HOLE_R * M.cbrt(W)) return 0;
      w2 = Mi.W;
      dm2 = Mi.DMG;
    }
    let v = 0;
    for (const o of S.worms) {
      if (o.dead) continue;
      const e = SS.blast.worm_effect(pr, w2, o.pos, dm2), dm = M.min(o.hp, Math.round(e.dmg));
      if (o.team === me) v -= (o === S.active ? 2.2 : K.OWN_K) * dm + (dm >= o.hp ? 60 : 0);
      else v += dm + (dm >= o.hp ? K.KILL : 0);
    }
    return v * 0.8;
  }
  // the barrels / mines within 7 m of any living worm (the only ones that can change a shot's value)
  function nearProps(S) {
    const out = [];
    for (const b of S.bodies) {
      if (!b.prop || (b.prop !== 'barrel' && b.prop !== 'mine') || b.held || (b.prop === 'mine' && b.disarmed)) continue;
      for (const o of S.worms)
        if (!o.dead && M.len3(o.pos.x - b.pos.x, o.pos.y - b.pos.y, o.pos.z - b.pos.z) < 7) {
          out.push({ x: b.pos.x, y: b.pos.y, z: b.pos.z, kind: b.prop });
          break;
        }
      if (out.length >= 12) break;
    }
    return out;
  }

  /* ---------- the turn ---------- */
  /* P38: the targets of a turn. Distance, but weighted: a weak worm is worth more, a team that was just attacked less
   * (so in a
   * 3-4 team game the CPU does not pile on one team forever), a team that is nearly out more; at most two of the three
   * come from one team when other teams exist. S.aiMem.recent[team] = decayed count of recent shots at that team. */
  function pickFoes(S, a) {
    const mem = S.aiMem, th = [0, 0, 0, 0];
    for (const o of S.worms)
      if (!o.dead && o.hp > 0) th[o.team] += o.hp;
    // (a worm in the water is lost or crawling out: not worth a shot)
    const all = S.worms.filter(o => !o.dead && o.hp > 0 && !o.swim && !o.drowning && o.team !== a.team)
      // (P37: a living alien within 22 m is a target too)
      .concat(SS.alien && SS.alien.ai_foes ? SS.alien.ai_foes(S, a) : []);
    const key = o => {
      const rc = o.team >= 0 ? mem.recent[o.team] || 0 : 0;
      return M.v3_dist(o.pos, a.pos)
        * (0.65 + 0.35 * M.min(1, o.hp / 100))
        * (1 + 0.18 * rc)
        * (o.team >= 0 && th[o.team] < 120 ? 0.85 : 1);
    };
    M.sort_stable(all, (p, q) => key(p) - key(q) || (p.id - q.id));
    const out = [], per = [0, 0, 0, 0, 0], multi = all.some(o => o.team !== all[0].team);
    for (const o of all) {
      if (out.length >= K.TARGETS) break;
      if (multi && o.team >= 0 && per[o.team] >= 2) continue;
      out.push(o);
      if (o.team >= 0) per[o.team]++;
    }
    for (const o of all) {
      if (out.length >= K.TARGETS) break;
      if (out.indexOf(o) < 0) out.push(o);
    }
    return out;
  }
  /* a target of the plan: the worm (live: its position follows it) or the alien snapshot; undefined when i is out of
   * range. foe_of takes an id from foes / foes0 */
  const foe_of = (S, pl, id) => (id === undefined ? undefined : id >= 0 ? S.worms[id] : pl.aliens[-2 - id]);
  const foe = (S, pl, i) => foe_of(S, pl, pl.foes[i]);
  const foe_wid = id => (id >= 0 ? id : -1);                          // the worm id of a target id for pl.fired.target (-1: an alien)
  AI.foe = foe; AI.foe_of = foe_of; AI.foe_wid = foe_wid;
  function noteTarget(S, o) {
    const mem = S.aiMem;
    if (o && o.team >= 0) mem.recent[o.team] = (mem.recent[o.team] || 0) + 1;
  }
  function newPlan(S, a) {
    const diff = K.DIFF[SS.game.skill(S)], mem = S.aiMem;
    for (let i = 0; i < mem.recent.length; i++) mem.recent[i] *= 0.7;
    // the targets as ids (i16): a worm = its id (>= 0); a living alien (SS.alien.ai_foes: a pseudo target snapshot with
    // .alien set) = -(2 + index in pl.aliens)
    const foeObjs = pickFoes(S, a), aliens = [], foes = [];
    for (let i = 0; i < foeObjs.length; i++) {
      if (foeObjs[i].alien) {
        aliens.push(foeObjs[i]);
        foes.push(-2 - (aliens.length - 1));
      } else foes.push(foeObjs[i].id);
    }
    // P11 (PoC aiPlanGen): bazooka + grenade always; cluster 70 %, banana 50 %, holy 50 % of the turns when in stock
    const has = k => SS.game.ammo(S, a.team, k) > 0, wpns = [];
    if (has('bazooka')) wpns.push('bazooka');
    if (has('grenade')) wpns.push('grenade');
    // (P38-R2: the random drops are kept on easy only: they cost normal / hard a good shot in 30-50 % of the turns)
    const easy = SS.game.skill(S) === 'easy';
    if (has('cluster') && (!easy || rng(S) < 0.7)) wpns.push('cluster');
    if (has('banana') && (!easy || rng(S) < 0.5)) wpns.push('banana');
    if (has('holy') && (!easy || rng(S) < 0.5)) wpns.push('holy');
    // (P38-R5: a crate-only weapon the CPU never threw: scored as a burst where it lands, like the others)
    if (has('blackhole')) wpns.push('blackhole');
    /* the plan struct (C: struct AiPlan; every field exists from the start): phase (enum AiPhase; strings in JS), t
     * (phase timer), diff (difficulty row), foes (the targets as ids, nearest
     * first; aliens = their snapshots in `aliens`, see AI.foe), fi (index of the target being planned), cand / next
     * (the shot candidate grid and the evaluation cursor), best / sbest / fbest (best shot, best special, fallback
     * special; null = none), top (the best 40 candidates, sorted), wpns, props (barrels / mines near worms), fine (the
     * fine grid pass), walked, moves (reposition attempts), worm (id), turn (S.turnNo it was made in), prepped,
     * regiven, noted, detour, fixed (rotation locked: foes0 keeps the unfiltered list), stage, scands (special
     * candidates), rk / rlist (robustness pass), doneT (time the plan finished, null), fired (what it fired: { wpn, v,
     * target id } or null), grav, mv (the movement sub-plan, null), badCrates (crate ids given up on this turn), navs
     * (P95: cave legs walked this turn), appr (1 once the CPU walked up to a foe for a close-range tool this turn), ret
     * (the retreat direction of this turn, 0 = not chosen yet). */
    return { phase: 'think', t: S.time + K.THINK, diff, foes, aliens, fi: 0, cand: null, next: 0, best: null, top: [], walked: false,
      turn: S.turnNo, wpns, props: nearProps(S), moves: 0,
      worm: a.id, sbest: null, fbest: null, fine: false, prepped: 0, regiven: 0, noted: 0, detour: 0, fixed: false, foes0: null, stage: 0,
      scands: null, rk: 0, rlist: null, appr: 0, ret: 0,
      doneT: null, fired: null, grav: null, mv: null, badCrates: [], navs: 0, collected: 0, far: 0, digA: 0, digBack: 0 };
  }
  /* a scored shot candidate (C: struct Cand { f32 v; Hit hit; i16 fi; u8 wpn; f32 aim; i8 facing; f32 pw; f32 rv
   * (robust value, NaN = not computed yet); }) */
  const cand_make = (v, hit, fi, c) => ({ v, hit, fi, wpn: c.wpn, aim: c.aim, facing: c.facing, pw: c.pw, rv: null });
  function grid(S, pl, center) {
    const a = S.active, tgt = foe(S, pl, pl.fi), ap = P.to_plane(S, a.pos), tp = P.to_plane(S, tgt.pos);
    const facing = tp.s >= ap.s ? 1 : -1, list = [];
    if (!center) {
      for (const wpn of pl.wpns)
        for (let aim = -0.5; aim <= 1.45; aim += pl.diff.aim * 1.5)
          for (let pw = 0.15; pw <= 1.0001; pw += pl.diff.pow * 1.5) list.push({ wpn, aim, facing, pw });
    } else {
      for (let i = -2; i <= 2; i++)
        for (let j = -2; j <= 2; j++)
          list.push({
            wpn: center.wpn,
            aim: center.aim + i * pl.diff.aim * 0.5,
            facing: center.facing,
            pw: M.clamp(center.pw + j * pl.diff.pow * 0.5, 0.05, 1)
          });
    }
    return list;
  }
  /* P37-6 rotation lock: the CPU turns the section like a human, only while rotation is allowed (sim/rotlock.js: the
   * first C.ROT_WINDOW s of the turn, before its worm moves). Once the view is fixed it plans on the plane it has: only
   * foes within 3 m of it are targets (none: it walks / ends the turn). */
  function alignAi(S, pl, fi, phase) {
    if (!SS.rotlock || SS.rotlock.allowed(S)) {
      SS.sim.align_to(S, foe(S, pl, fi));
      pl.phase = phase;
      return;
    }
    if (!pl.fixed) {
      pl.fixed = true;
      pl.foes0 = pl.foes;
      pl.best = null;
      pl.sbest = null;
      pl.top = [];
      pl.fi = 0;
      const keep = [];
      for (let q = 0; q < pl.foes.length; q++)
        if (Math.abs(P.to_plane(S, foe(S, pl, q).pos).t) < 3) keep.push(pl.foes[q]);
      pl.foes = keep;
    }
    pl.fi = 0; pl.cand = null;
    if (!pl.foes.length) {
      pl.phase = pl.walked ? 'endt' : 'walk';
      pl.walked = true;
      pl.t = S.time + K.WALK_T;
      return;
    }
    pl.phase = 'align';                                          // (thetaGoal is null: the search starts next step)
  }
  // the special candidate wins: fire it (realigning to its target first when the plane was turned to another one)
  function chooseSpecial(S, pl) {
    pl.best = pl.sbest;
    if (pl.best.fi !== pl.fi) {
      pl.fi = pl.best.fi;
      alignAi(S, pl, pl.fi, 'realign');
    } else pl.phase = 'fire';
  }
  // no shot worth taking from here: reposition (P38: rope / zipline / crate, SS.aib) or walk toward the target once,
  // else end the turn
  function giveUp(S, pl, a, inp) {
    // the plane is turned to the last target tried: go back to the nearest one first (while turning is still allowed)
    if (pl.fi !== 0 && !pl.regiven && (!SS.rotlock || SS.rotlock.allowed(S))) {
      pl.regiven = 1;
      pl.fi = 0;
      pl.best = null;
      pl.top = [];
      alignAi(S, pl, 0, 'regive');
      return;
    }
    // P95: in a cave (rock between the worms, no sky weapons) walk one straight leg along the path through it toward
    // the nearest foe, before the rope / zipline / crate fallbacks
    if (SS.world.under && !SS.world.flat && SS.nav && SS.aib && pl.navs < 1 && !a.air && !S.rope) {
      const g = SS.nav.leg(S, a);
      if (g && navStep(S, pl, a, g)) return;
    }
    // P68d: in the End of the World the hop planner (sim/eow.js)
    if (S.eow ? SS.eow.cpu_move(S, pl, a) : SS.aib && SS.aib.reposition(S, pl, a)) return;
    if (SS.aic && SS.aic.approach(S, pl, a, 0)) return;
    // P99: no shot and nothing else to try on an ordinary 3D map (rooms, bunkers, ruins, a ravine between two ledges):
    // the same path leg as in the caves toward the nearest foe by path, instead of a blind walk along the section (in
    // the soak two worms 10 m apart in different chambers stood still for 16 turns)
    if (!SS.world.under && !SS.world.flat && SS.nav && SS.aib && !S.eow && pl.navs < 1 && !a.air && !S.rope && straightBlocked(S, pl, a)) {
      const g = SS.nav.leg(S, a);
      if (g && !pl.fbest && navStep(S, pl, a, g)) return;           // (the fallbacks come first: a girder over a gap, the teleport)
    }
    if (!pl.walked && !pl.navs) {
      pl.walked = true;
      pl.best = null;
      pl.top = [];
      pl.sbest = null;
      pl.phase = 'walk';
      pl.t = S.time + K.WALK_T;
    }
    else if (pl.fbest) {
      pl.sbest = pl.fbest;
      pl.fbest = null;
      chooseSpecial(S, pl);
    }
    else {
      inp.end_turn = true;
      pl.phase = 'done';
    }
  }
  // P38-R2: the retreat window after a shot (the shot went toward the target: step the other way, if the ground is
  // safe). C: input struct, field move.
  const RETIN = {};
  // walking away pays only when something of the worm's own is about to go off near it: a fused / buried charge, fire,
  // gas, acid, or a shot at a foe within 14 m (a retreat after every shot sent the CPU downhill into the rising sea:
  // +40 % drowning in the matches)
  const RETWALK = { dynamite: 1, mine: 1, spring: 1, napalm: 1, gas: 1, acid: 1, magnet: 1, flamethrower: 1, blackhole: 1 };
  // is the blind walk along the section toward the target pointless: the ground on the way is not walkable (a wall, a
  // gap, a different chamber)? It is the plain case where a path leg helps
  function straightBlocked(S, pl, a) {
    const tgt = foe(S, pl, pl.fi) || (pl.foes0 && foe_of(S, pl, pl.foes0[0]));
    if (!tgt || !SS.aib.walk_reach) return false;
    const ap = P.to_plane(S, a.pos), tp = P.to_plane(S, tgt.pos);
    return Math.abs(tp.t) > 3 || !SS.aib.walk_reach(S, ap.s, ap.s + (tp.s >= ap.s ? 1 : -1) * M.min(12, Math.abs(tp.s - ap.s)), a.pos.y);
  }
  // one step of the path plan (caves, and any 3D map when nothing else is left): a leg toward the nearest foe by path,
  // or, with every foe cut off by rock, a walk to the thinnest spot and a blast toward them (breach); true when the
  // worm acted
  function navStep(S, pl, a, g) {
    if (g.dig) {
      if (g.rem > 0 && !pl.digBack && (pl.navs++, SS.aib.nav_walk(S, pl, a, g))) return true;
      return (g.rem === 0 || pl.digBack) && breach(S, pl, a, g);
    }
    return g.rem > 3 && (pl.navs++, SS.aib.nav_walk(S, pl, a, g));
  }
  /* P99: a bazooka shot that carves toward the far side of the rock (a cave pocket cut off from every foe: P95 left
   * such worms idle for the whole match and the final stand killed both teams).
   * The section is turned to the far cell while the rotation is free, then bazooka aim x power are scanned with the
   * flight copy: a burst nearer to the far cell is worth BREACH_K per metre, the own team's damage is charged (shooter
   * and allies, 2 HP-eq each); outside the final stand the own damage must stay below BREACH_OWN. true when it set up a
   * shot / a turn. */
  function breach(S, pl, a, g) {
    if (!has_bazooka(S, a)) return false;
    const ap = P.to_plane(S, a.pos), tb = P.to_plane(S, { x: g.bx, y: g.by, z: g.bz });
    if (Math.abs(tb.t) > 1.2) {
      if (pl.digA || (SS.rotlock && !SS.rotlock.allowed(S))) return false;
      pl.digA = 1;
      SS.sim.align_to_point(S, g.bx, g.bz);
      pl.phase = 'regive';
      return true;
    }
    const facing = tb.s >= ap.s ? 1 : -1,
      aim0 = M.atan2(g.by + 0.9 - a.pos.y, M.max(0.5, Math.abs(tb.s - ap.s))),
      D0 = M.len3(g.bx - a.pos.x, g.by + 0.9 - a.pos.y, g.bz - a.pos.z);
    const W3 = burstW('bazooka'),
      dm = burstDmg('bazooka'),
      bold = S.sudden || g.na <= K.SEALED_N,
      cap = bold ? M.max(K.BREACH_OWN, 0.4 * a.hp) : K.BREACH_OWN;
    let best = null;
    for (let da = -0.3; da <= 0.301; da += 0.05)
      for (let pw = 0.35; pw <= 1.001; pw += 0.13) {
        const aim = M.clamp(aim0 + da, -1.4, 1.4), h = predict(S, 'bazooka', aim, facing, pw);
        if (!h || h.wet) continue;
        // (a confined burst hurts more than the free-field estimate: 14 HP measured in P95)
        const prog = D0 - M.max(0, M.len3(h.x - g.bx, h.y - g.by - 0.9, h.z - g.bz) - K.BREACH_R),
          own = M.max(ownDamage(S, h, W3, null, dm), M.len3(h.x - a.pos.x, h.y - a.pos.y, h.z - a.pos.z) < 4 ? 14 : 0);
        if (prog < K.BREACH_MIN || own > cap) continue;
        const v = prog * K.BREACH_K - (bold ? 1 : 2) * own;
        if (v > 0 && (!best || v > best.v)) best = cand_make(v, h, 0, { wpn: 'bazooka', aim, facing, pw });
      }
    // too close to the wall (a burst within 4 m hurts the shooter): step back along the section and shoot from there
    if (!best) {
      if (pl.digBack || a.air || S.rope || !SS.aib || !SS.aib.walk_to) return false;
      for (let r = 6; r >= 3; r -= 1.5) {
        const s2 = ap.s - facing * r;
        if (SS.aib.walk_reach(S, ap.s, s2, a.pos.y) && SS.aib.safe_step(S, a, -facing)) {
          pl.digBack = 1;
          pl.navs++;
          return SS.aib.walk_to(S, pl, a, s2, 'dig', 6);
        }
      }
      return false;
    }
    pl.best = best; pl.phase = 'fire'; return true;
  }
  const has_bazooka = (S, a) => SS.game.ammo(S, a.team, 'bazooka') > 0;
  function needsRetreat(S, a, pl) {
    // (a flamethrower / minigun burst follows the worm's facing: walking away turned it round and sprayed the other
    // way)
    if (S.wa && S.wa.stream) return false;
    if (RETWALK[S.weapon]) return true;
    const t = pl && pl.fired ? S.worms[pl.fired.target] : null;
    return !!t && M.v3_dist(t.pos, a.pos) < 14;
  }
  AI.retreat = function (S, a, base) {
    SS.sim.input_copy(RETIN, base); RETIN.move = 0;
    if (SS.aic && SS.aic.retreat(S, a, RETIN)) return RETIN;       // P38-R5: the sheep next to its foe is set off
    if (!a.air && !S.rope && SS.aib && !(S.weapon === 'ninja' || S.weapon === 'rope')) {
      // (P38-R5: the direction is chosen once per turn: walking flips a.facing, and "-facing" evaluated every step made
      // the worm shuffle on the spot, so it never left its own blast: a dynamite 1.5 m ahead hit the thrower for 49 HP)
      const pl = S.aiPlan;
      let dir = SS.lab4 && S.settings.labFlags ? SS.lab4.zap_flee(S, a) : 0;       // P79: a static-crackle tell next to us: away from it
      if (!dir) dir = SS.aib.retreat_crate_dir(S, a);        // a crate within reach on the plane: collect it
      if (!dir && needsRetreat(S, a, pl)) {
        if (pl && pl.ret === 0) pl.ret = -a.facing;
        dir = pl && pl.ret !== 0 ? pl.ret : -a.facing;
      }
      if (SS.aib.safe_step(S, a, dir)) RETIN.move = dir;
    }
    return RETIN;
  };
  const AI_IN = SS.sim.input_make();                       // the CPU's input struct, reused every step (cleared at the top of control)
  AI.control = function (S, a, dt) {
    const inp = SS.sim.input_clear(AI_IN);
    let pl = S.aiPlan;
    if (!pl || pl.turn !== S.turnNo || pl.worm !== a.id) { pl = S.aiPlan = newPlan(S, a); }
    if (SS.aib && a.air) SS.aib.air(S, a);
    // P89: a switched-off life jacket goes on once the turn starts near water
    if (SS.gear && S.phase === 'play' && !pl.gearT) {
      pl.gearT = 1;
      const gj = SS.gear.get(S, a.team, SS.gear.JACKET);
      if (gj && !gj.on && gj.n > 0 && nearWater(S, a)) inp.gear = SS.gear.JACKET + 1;
    }
    // P79 LIGHTNING: run from a bolt's tell (1.4 s)
    if (SS.lab4 && S.settings.labFlags && S.phase === 'play' && !a.air && !S.rope && !S.charging) {
      const fd = SS.lab4.zap_flee(S, a);
      if (fd && SS.aib && SS.aib.safe_step(S, a, fd)) {
        inp.move = fd;
        return inp;
      }
    }
    // P38-R2 safeguard: a plan that has not shot 30 s into the turn ("No limit" turns never time out) ends it
    /* (P38 R3: also a worm stuck swinging / airborne, at twice the limit) */
    if (
      S.phase === 'play'
      && !S.charging
      && S.time - S.turnStart > K.TURN_MAX
      && ((!a.air && !S.rope) || S.time - S.turnStart > 2 * K.TURN_MAX)
    ) {
      inp.end_turn = true;
      pl.phase = 'done';
    }
    // (a weapon that refused to fire must not hang the turn)
    if (pl.phase === 'done') {
      if (pl.doneT == null) pl.doneT = S.time;
      else if (S.time - pl.doneT > 4 && !S.charging) inp.end_turn = true;
    }
    switch (pl.phase) {
      case 'think':
        if (S.time >= pl.t) {
          if (!pl.foes.length) {
            inp.end_turn = true;
            pl.phase = 'done';
            break;
          }
          // P38: hazards first (xeno, rising sea, a health crate)
          if (!pl.prepped) {
            pl.prepped = 1;
            if (SS.aib && SS.aib.prep(S, pl, a)) break;
          }
          alignAi(S, pl, pl.fi, 'align');
        }
        break;
      case 'align':
        if (S.thetaGoal == null) {
          pl.cand = grid(S, pl, null);
          pl.next = 0;
          pl.phase = 'search';
          pl.fine = false;
        }
        break;
      case 'search': {
        const W3 = c => burstW(c.wpn);
        for (let n = 0; n < K.EVAL_PER_STEP && pl.next < pl.cand.length; n++, pl.next++) {
          const c = pl.cand[pl.next], hit = predict(S, c.wpn, c.aim, c.facing, c.pw);
          if (!hit) continue;
          const v = score(S, hit, W3(c), (C.PROJ[c.wpn] || {}).split, burstDmg(c.wpn));
          if (!pl.best || v > pl.best.v) pl.best = cand_make(v, hit, pl.fi, c);
          if (v > 0) {
            pl.top.push(cand_make(v, hit, pl.fi, c));
            M.sort_stable(pl.top, (p, q) => q.v - p.v);
            if (pl.top.length > 40) pl.top.length = 40;
          }
        }
        if (pl.next < pl.cand.length) break;
        // refine around the best plan OF THIS TARGET (P38-R2: it was only done when the overall best was this target's)
        if (!pl.fine) {
          let bf = null;
          for (let i = 0; i < pl.top.length; i++)
            if (pl.top[i].fi === pl.fi) {
              bf = pl.top[i];
              break;
            }
          if (bf) {
            pl.cand = grid(S, pl, bf);
            pl.next = 0;
            pl.fine = true;
            break;
          }
        }
        // this target's specials (they need the plane aligned with it), then the next target, or shoot / move
        pl.phase = 'spec'; pl.stage = 0; pl.scands = null;
        break;
      }
      case 'spec': {
        if (!specials(S, pl, a, pl.stage++)) break;
        if (pl.fi + 1 < pl.foes.length && (!pl.best || pl.best.v < 30) && !(pl.sbest && pl.sbest.v > 60)) {
          // (P38-R2: with the rotation lock closed alignAi would reset fi = 0 -> endless align/search/spec loop: just
          // step on)
          pl.fi++;
          if (SS.rotlock && !SS.rotlock.allowed(S)) {
            pl.cand = null;
            pl.phase = 'align';
          } else alignAi(S, pl, pl.fi, 'align');
          break;
        }
        if (pl.best && pl.best.v > 0) {
          pl.rk = 0; pl.rlist = null;
          if (pl.best.fi !== pl.fi) {
            pl.fi = pl.best.fi;
            alignAi(S, pl, pl.fi, 'realign');
            break;
          }
          pl.phase = 'robust';
        } else if (pl.sbest && pl.sbest.v > K.SPECIAL_MIN) { chooseSpecial(S, pl); }
        else giveUp(S, pl, a, inp);
        break;
      }
      case 'endt': inp.end_turn = true; pl.phase = 'done'; break;
      case 'regive':
        if (S.thetaGoal == null) giveUp(S, pl, a, inp);
        break;
      // P38: a walk / crate fetch / rope swing / zipline ride (sim/aib.js); then search again from the new spot
      case 'move':
        if (S.eow && pl.mv && pl.mv.kind === 9 ? SS.eow.cpu_step(S, pl, a, inp) : SS.aib.move(S, pl, a, inp)) {   // P68d
          pl.best = null;
          pl.sbest = null;
          pl.fbest = null;
          pl.top = [];
          pl.fi = 0;
          pl.cand = null;
          pl.walked = false;
          pl.fine = false;
          if (a.air || S.rope) {
            pl.phase = 'settle';
            pl.t = S.time + 3;
          } else alignAi(S, pl, 0, 'align');
        }
        break;
      case 'settle':                                     // wait for the worm to land
        if (!a.air && !S.rope) alignAi(S, pl, 0, 'align');
        else if (S.time > pl.t) {
          inp.end_turn = true;
          pl.phase = 'done';
        }
        break;
      case 'grav':
        if (SS.aib.grav_throw(S, pl, a, pl.diff, gauss)) break;
        if (S.time - pl.grav.t > 3) { pl.phase = 'endt'; }
        break;
      case 'realign':
        if (S.thetaGoal == null) {
          if (pl.best.special) pl.phase = 'fire';
          else {
            pl.phase = 'robust';
            pl.rk = 0;
            pl.rlist = null;
          }
        }
        break;
      /* robustness (a CPU's aim and power have the difficulty's noise): the best plans of this plane (the best of each
       * weapon
       * and aim / power region, so they differ) are scored by their EXPECTED value under that noise: a 3 x 3
       * Gauss-Hermite rule over (aim, power), the same sigmas the shot gets when it is fired. A plan that skims a ledge
       * at the worm's feet, needs a long flat range or kills its own team when slightly off loses to a safer one (P38:
       * it was the worst of four 1.5 sigma points; a 45 m bazooka shot missed 68 % of the time with it). */
      case 'robust': {
        if (!pl.rlist) pl.rlist = diverse(pl.top.filter(e => e.fi === pl.fi && !e.special), 6);
        const list = pl.rlist, d = pl.diff;
        for (let n = 0; n < 2 && pl.rk < list.length; n++, pl.rk++) list[pl.rk].rv = expected(S, list[pl.rk], d);
        if (pl.rk < list.length) break;
        let pick = null;
        for (const c of list)
          if (c.rv != null && (!pick || c.rv > pick.rv)) pick = c;
        pl.rlist = null;
        const sb = pl.sbest;
        if (sb && sb.v > K.SPECIAL_MIN && sb.v > (pick && pick.rv > 0 ? pick.rv * 1.1 : 0)) {
          chooseSpecial(S, pl);
          break;
        }
        if (pl.fbest && pl.fbest.v > (pick && pick.rv > 0 ? pick.rv : 0)) {
          pl.sbest = pl.fbest;
          pl.fbest = null;
          chooseSpecial(S, pl);
          break;
        }
        // P38-R5: walk up to a foe for a close-range tool (bat, dynamite, ...) when that is worth more than the shot
        if (SS.aic && SS.aic.approach(S, pl, a, pick && pick.rv > 0 ? pick.rv : 0)) break;
        // P38-R2: a near weapon / tool crate first (within 10 m when the shot is weak)
        if (
          pick
          && pick.rv > 0
          && SS.aib
          && SS.aib.detour(
            S,
            pl,
            a,
            pick.rv < SS.aib.K.SHOT_OK ? SS.aib.K.DETOUR_R : SS.aib.K.DETOUR_NEAR,
            pick.rv < SS.aib.K.SHOT_WEAK,
            pick.rv
          )
        ) break;
        if (pick && pick.rv > 0) {
          pl.best = pick;
          pl.best.v = pick.rv;
          pl.phase = 'fire';
        }
        else giveUp(S, pl, a, inp);
        break;
      }
      case 'walk': {
        const tgt = (foe(S, pl, pl.fi) || (pl.foes0 && foe_of(S, pl, pl.foes0[0]))),
          ap = P.to_plane(S, a.pos),
          tp = P.to_plane(S, tgt.pos),
          dir = tp.s >= ap.s ? 1 : -1;
        // never walk into water (it costs the turn and 10 HP/s) or lava: stop at the shore (a deck or sea ice ahead is
        // fine)
        const ah = P.to_world(S, ap.s + dir * 0.7, a.pos.y), surf = SS.sim.surface_at(S, ah.x, ah.z);
        const deck = SS.struct && SS.struct.floor_at ? SS.struct.floor_at(S, ah.x, a.pos.y, ah.z) : -1e9,
          ice = SS.ice && S.ice ? SS.ice.top_at(S, ah.x, ah.z) : -1e9;
        const wet = (SS.water && S.water && SS.water.depth(S, ah.x, ah.z) > 0.3 && deck < surf && ice < -1e8)
          || (SS.lava && S.lava && SS.lava.depth_at(S, ah.x, ah.z) > 0.02);
        // (P38-R5: stop next to the foe: it walked through it, then swung the bat the wrong way)
        const near = Math.abs(tp.s - ap.s) < 1.3;
        if (!wet && !near && (!SS.aib || SS.aib.safe_step(S, a, dir))) inp.move = dir;
        else if (!wet) pl.t = 0;
        if (wet || near || S.time >= pl.t) {
          pl.best = null;
          pl.sbest = null;
          pl.fbest = null;
          pl.top = [];
          alignAi(S, pl, 0, 'align');
          pl.fi = 0;
        }
        break;
      }
      case 'fire': {
        const b = pl.best, d = pl.diff;
        if (b.special) {
          fireSpecial(S, pl, a, b);
          break;
        }
        // P79 RECOIL: the kick would slide us over an edge / into water: step forward first (up to 0.8 s)
        if (SS.lab4 && S.settings.labFlags && !a.air && SS.aib) {
          const back = SS.lab4.recoil_dist(S, a, b.wpn, b.pw, b.aim);
          if (back > 0.3 && (pl.rclT == null || S.time < pl.rclT)) {
            if (pl.rclT == null) pl.rclT = S.time + 0.8;
            const ap = P.to_plane(S, a.pos);
            let bad = false;
            for (let t = 0.5; t <= back + 0.6 && !bad; t += 0.5) {
              const s2 = ap.s - b.facing * t, g = SS.weapons.ground_below(S, s2, a.pos.y + 0.5);
              if (g < -1e8 || a.pos.y - g > 3 || SS.aib.wet_at(S, s2, g + 0.2)) bad = true;
            }
            if (bad && SS.aib.safe_step(S, a, b.facing)) {
              inp.move = b.facing;
              break;
            }
          }
        }
        S.weapon = b.wpn; a.facing = b.facing;
        // the skill noise must not point the muzzle into an adjacent wall (the shot spawns 0.7 m out and goes off in
        // the CPU's face: an easy CPU blew itself into the sea that way): keep the planned, predicted aim then
        const aimN = M.clamp(b.aim + gauss(S) * d.noiseA, -1.5, 1.5);
        S.aim = muzzleClear(S, P.to_plane(S, a.pos).s, a.pos.y, a.facing, aimN) ? aimN : b.aim;
        const pw = M.clamp(b.pw + gauss(S) * d.noiseP, 0.05, 1);
        pl.phase = 'done'; pl.fired = { wpn: b.wpn, aim: S.aim, pw, v: b.v, target: foe_wid(pl.foes[b.fi]) };
        SS.sim.fire(S, pw);
        break;
      }
    }
    if (pl.fired && !pl.noted) {
      pl.noted = 1;
      noteTarget(S, S.worms.find(w => w.id === pl.fired.target));
    }
    return inp;
  };
  /* P11 (PoC): close-range and targeted alternatives to the ballistic search. Each candidate gets an expected value
   * comparable to score(); the best one replaces the ballistic plan when it is clearly better. */
  // P38: the laser sight shows the exact path: longer bullet ranges, steadier aim
  const laserOn = a => !!(a.skills && a.skills.laser > 0);
  AI.laser_on = laserOn;
  // staged (P38: one stage per sim step keeps the planning spike under ~15 ms): 0 close-range + tools, 1 homing, 2-5
  // weapons A (basic / mortar / acid / gas), 6 the pick. Returns true when done.
  const SPEC_ONLY = [null, null, 'basic', 'mortar', 'acid', 'gas'];
  function specials(S, pl, a, stage) {
    const has = k => SS.weapons.can_use(S, k), ap = P.to_plane(S, a.pos), tgt = foe(S, pl, pl.fi);
    if (!tgt) return true;
    const tp = P.to_plane(S, tgt.pos), dist = M.len2(tp.s - ap.s, tgt.pos.y - a.pos.y), facing = tp.s >= ap.s ? 1 : -1;
    const aim = M.atan2(tgt.pos.y - a.pos.y, Math.abs(tp.s - ap.s)),
      clear = clearLine(S, ap.s, a.pos.y, tp.s, tgt.pos.y) && !ownInLine(S, a, ap, tp, tgt.pos.y),
      own = tgt.team === a.team;
    const cands = stage === 0 || !pl.scands ? (pl.scands = []) : pl.scands;
    if (stage === 0) {
      if (!own && dist < 1.3 && has('bat')) cands.push({ special: 'bat', v: M.min(tgt.hp, 30) + 20, aim: M.max(0.2, aim), facing });
      if (!own && dist < (laserOn(a) ? 24 : 15) && clear && has('shotgun') && !bodyInLine(S, ap.s, a.pos.y, tp.s, tgt.pos.y))
        cands.push({ special: 'shotgun', v: M.min(tgt.hp, 50) * 0.9, aim, facing });
      for (const k of ['airstrike', 'tesla', 'moai'])
        if (has(k)) {
          const W = k === 'airstrike' ? (C.PROJ.missile.W) * 2.2 : k === 'moai' ? C.ARMS.MOAI.W * 1.6 : C.ARMS.TESLA.W;
          let v = score(
            S,
            { x: tgt.pos.x, y: tgt.pos.y - 0.3, z: tgt.pos.z },
            W,
            null,
            k === 'airstrike' ? 30 * 2.2 : k === 'moai' ? 28 * 1.6 : 10
          )
            * 0.85;
          if (k === 'tesla') v += zapValue(S, tgt.pos) * 0.85;                // the two shocks (no flat bonus)
          cands.push({ special: k, v, ts: tp.s, ty: tgt.pos.y, facing });
        }
      // P84: an ally with a face hugger on: a shotgun pellet tears it off (the worm keeps the infection and takes the
      // pellet; a health crate cures it afterwards). Worth it when the ally can take the pellet and a health crate lies
      // on the map to cure it
      if (has('shotgun') && SS.alien)
        for (const o of S.worms) {
          if (o === a || o.dead || o.hp <= 0 || o.team !== a.team || !(o.hug != null && o.hug >= 0) || o.hp <= C.ARMS.SHOTGUN.DMG * 1.5)
            continue;
          const op = P.to_plane(S, o.pos), od = M.len2(op.s - ap.s, o.pos.y - a.pos.y);
          if (
            od > (laserOn(a) ? 24 : 15)
            || Math.abs(op.t) > C.HALF
            || !clearLine(S, ap.s, a.pos.y, op.s, o.pos.y)
            || bodyInLine(S, ap.s, a.pos.y, op.s, o.pos.y)
          ) continue;
          const crate = S.crates.some(c => c.kind === 'health' && c.landed);
          cands.push({
            special: 'shotgun',
            v: crate ? 30 : 14,
            aim: M.atan2(o.pos.y - a.pos.y, Math.abs(op.s - ap.s)),
            facing: op.s >= ap.s ? 1 : -1
          });
        }
      if (SS.aib) SS.aib.cands(S, pl, a, tgt, cands, { ap, tp, dist, facing, aim, clear });   // P38: force field, gravity gun, sniper
      if (SS.gadgets) SS.gadgets.ai_cands(S, pl, a, tgt, cands);       // P37 W4: robo dog, knockout punch, sentry gun, claymore
      // P38-R5: dynamite, mine, spring, sheep, napalm, bat, torch
      if (SS.aic) SS.aic.cands(S, pl, a, tgt, cands, { ap, tp, dist, facing, aim, clear });
    }
    if (stage === 1 && has('homing') && (!pl.best || pl.best.v < 40)) {
      // the missile's real flight (predict: lock phase, steering, fuel) is flown for a fan of launch angles x powers,
      // aimed at the target; the 3 best are re-scored by their expectation under the aim noise. A fan that starts
      // inside rock is skipped.
      const tg = { s: tp.s, y: tgt.pos.y }, all = [];
      // P68g: in space the fan also covers the other side (the field bends the way)
      for (let fc = facing, fn = S.eow ? 2 : 1; fn > 0; fn--, fc = -fc)
        for (let ha = S.eow ? -0.8 : -0.2; ha < 1.45; ha += S.eow && fc !== facing ? 0.2 : 0.1) {
          if (!muzzleClear(S, ap.s, a.pos.y, fc, ha)) continue;
          for (const pw of [0.5, 0.75, 1]) {
            const h = predict(S, 'homing', ha, fc, pw, tg);
            if (!h || h.wet) continue;
            all.push({ ha, pw, fc, v: score(S, h, C.PROJ.homing.W, null, C.PROJ.homing.dmg) });
          }
        }
      M.sort_stable(all, (p, q) => q.v - p.v);
      let bh = null;
      for (let i = 0; i < all.length && i < 3; i++) {
        if (all[i].v <= 0) break;
        const e = all[i],
          v = AI.expect_fn(S, pl, 'homing', e.ha, e.fc, e.pw, h => score(S, h, C.PROJ.homing.W, null, C.PROJ.homing.dmg), tg);
        if (!bh || v > bh.v) bh = { special: 'homing', v, aim: e.ha, facing: e.fc, ts: tp.s, ty: tgt.pos.y, pw: e.pw };
      }
      if (bh) cands.push(bh);
    }
    // P37-W3: weapons A
    if (stage >= 2 && stage <= 5) {
      if (SS.weaponsA && SS.weaponsA.ai_candidates)
        SS.weaponsA.ai_candidates(S, pl, a, tgt, cands, { ap, tp, dist, facing, aim, clear, own, only: SPEC_ONLY[stage] });
      return false;
    }
    // P38-R5: teleport, girder (fallbacks)
    if (stage === 6) {
      if (SS.aic) SS.aic.cands_late(S, pl, a, tgt, cands, { ap, tp, dist, facing, aim, clear });
      return false;
    }
    if (stage < 7) return false;
    let best = null, fb = null;
    for (const c of cands) {
      if (c.fb) {
        if (!fb || c.v > fb.v) fb = c;
      } else if (c.v > K.SPECIAL_MIN && (!best || c.v > best.v)) best = c;
    }
    // (P38-R2 fallback: a defensive tool, used when no shot is worth more)
    if (fb && (!pl.fbest || fb.v > pl.fbest.v)) pl.fbest = Object.assign({ fi: pl.fi, wpn: fb.special }, fb);
    if (best && (!pl.sbest || best.v > pl.sbest.v)) pl.sbest = Object.assign({ fi: pl.fi, wpn: best.special }, best);
    pl.scands = null;
    return true;
  }
  // expected electric damage of a thunder strike at c (both pulses), enemies + / own team - OWN_K
  function zapValue(S, c) {
    const T = C.ARMS.TESLA, me = S.active.team;
    let v = 0;
    for (const o of S.worms) {
      if (o.dead || o.hp <= 0) continue;
      const d = M.len3(o.pos.x - c.x, o.pos.y - c.y, o.pos.z - c.z), dm = M.min(o.hp, (d < T.R1 ? T.D1 : 0) + (d < T.R2 ? T.D2 : 0));
      v += o.team === me ? -K.OWN_K * dm : dm;
    }
    return v;
  }
  // 3 x 3 Gauss-Hermite nodes / weights of a normal noise (exact for the mean and variance and up to degree 5)
  const GH = [[-1.7320508, 1 / 6], [0, 2 / 3], [1.7320508, 1 / 6]];
  /* P99: the damage a burst at c does to the own team (the shooter included), capped by HP; a bomblet shell counts
   * every own worm inside its scatter ring as a 30 HP hit */
  function ownDamage(S, c, W, split, dmg) {
    const me = S.active.team;
    let sum = 0;
    const SCAT = split ? split.jx * 1.1 : 0;
    for (const o of S.worms) {
      if (o.dead || o.team !== me) continue;
      if (SCAT && M.len2(o.pos.x - c.x, o.pos.z - c.z) < SCAT) sum += 30;
      sum += M.min(o.hp, Math.round(SS.blast.worm_effect(c, W, o.pos, dmg).dmg));
    }
    return sum;
  }
  /* P99: the Gauss-Hermite mean says little about the noise tails (the +/- 1.7 sigma nodes weigh 1/36 each) and the own
   * team pays OWN_K x per HP only on average: the worst own-team
   * damage over the 9 nodes and four far axis points (+/- 2.5 sigma, wind and a late gust are inside that spread) costs
   * TAIL_K per HP above TAIL_FREE. A plan that usually hits but sometimes drops one on the squad loses to a plain safe
   * one. c.tail keeps the worst own damage for the diagnostics. */
  const FAR = [[2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]];
  function expected(S, c, d) {
    // (the End of the World keeps the plain expectation: the tail rules pushed the planner toward flat full-power shots
    // that leave every gravity well, 25 lost in 197 turns instead of 10)
    const pj = C.PROJ[c.wpn] || {},
      W3 = burstW(c.wpn),
      dm = burstDmg(c.wpn),
      bounce = !(pj.impact || (C.WEAPONS[c.wpn] || {}).impact),
      tails = !S.eow;
    let ev = 0, worst = 0;
    for (const [za, wa] of GH)
      for (const [zp, wp] of GH) {
        const h = predict(S, c.wpn, c.aim + za * d.noiseA, c.facing, M.clamp(c.pw + zp * d.noiseP, 0.05, 1));
        if (h) {
          ev += wa
            * wp
            * (score(S, h, W3, pj.split, dm) - selfRisk(S, h, W3, pj.split, dm) - (tails && bounce && firstD < K.NEAR_D ? K.NEAR_PEN : 0));
          if (tails) worst = M.max(worst, ownDamage(S, h, W3, pj.split, dm));
        }
      }
    if (tails)
      for (const [za, zp] of FAR) {
        const h = predict(S, c.wpn, c.aim + za * d.noiseA, c.facing, M.clamp(c.pw + zp * d.noiseP, 0.05, 1));
        if (h) worst = M.max(worst, ownDamage(S, h, W3, pj.split, dm));
      }
    c.tail = worst;
    return ev - K.TAIL_K * M.max(0, worst - K.TAIL_FREE);
  }
  /* P38 R9: the 3 x 3 rule weighs the +/- 1.7 sigma tails of the noise at 1/36 each, so a plan whose tail bursts on the
   * shooter looked fine
   * (an easy banana planned 22 m out fell 6 m short at -1.85 sigma and its bomblets killed the thrower: 100 HP). A node
   * that hurts the shooter badly (a bomblet shell: bursting within its scatter ring; otherwise >= 30 HP or a knock-back
   * >= SELF_DV m/s: the shooter is thrown off its ledge into the sea) costs SELF_RISK more: the CPU stays risk-averse
   * about itself. */
  // P89: is the worm within 6 m above the water (a knock-back could drop it in)?
  function nearWater(S, a) {
    if (!SS.water || !S.water) return false;
    const sf = SS.sim.surface_at(S, a.pos.x, a.pos.z);
    return sf > -90 && a.pos.y - sf < 6;
  }
  function selfRisk(S, c, W, split, dmg) {
    const a = S.active;
    if (!a || a.dead) return 0;
    if (split) {
      const R = split.jx * 1.1;
      return M.len3(a.pos.x - c.x, a.pos.y - c.y, a.pos.z - c.z) < R ? K.SELF_RISK : 0;
    }
    const e = SS.blast.worm_effect(c, W, a.pos, dmg);
    // (P89: with a life jacket a knock into the sea costs 6 HP, not the worm: bolder near water)
    return e.dmg >= M.min(a.hp, 30)
      || e.dv >= K.SELF_DV * (nearWater(S, a) && SS.gear && SS.gear.ready(S, a.team, SS.gear.JACKET) ? 1.6 : 1)
      ? K.SELF_RISK
      : 0;
  }
  AI.expected = expected;
  // the same expectation for any charged special: fn(hit) -> value of a burst (null / wet hit = 0)
  AI.expect_fn = function (S, pl, key, aim, facing, pw, fn, tgt) {
    const d = (pl && pl.diff) || K.DIFF.normal;
    let ev = 0;
    for (const [za, wa] of GH)
      for (const [zp, wp] of GH) {
        const h = predict(S, key, aim + za * d.noiseA, facing, M.clamp(pw + zp * d.noiseP, 0.05, 1), tgt);
        if (h && !h.wet) ev += wa * wp * fn(h);
      }
    return ev;
  };
  // the best entry of each (weapon, aim bucket, power bucket), then the n best of those
  function diverse(list, n) {
    const seen = {}, out = [];
    for (const e of list) {
      const k = e.wpn + ':' + Math.round(e.aim / 0.2) + ':' + Math.round(e.pw / 0.25);
      if (!seen[k]) {
        seen[k] = 1;
        out.push(e);
      }
    }
    return out.slice(0, n);
  }
  const MUZZLE = [0.7, 1.0, 1.4, 2.0];                // m along the aim that must be free when the CPU fires
  function muzzleClear(S, s, y, facing, aim) {
    for (let q = 0; q < MUZZLE.length; q++) {
      const r = MUZZLE[q];
      if (P.blocked2(S, s + facing * M.cos(aim) * r, y + M.sin(aim) * r)) return false;
    }
    return true;
  }
  /* P38-R5: a worm of the own team on the line of a bullet / stream (a hitscan stops at the first worm; the measured
   * shotgun self-damage of 12 HP per use): the line is not clear */
  function ownInLine(S, a, ap, tp, ty) {
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i];
      if (o.dead || o === a || o.team !== a.team) continue;
      const q = P.to_plane(S, o.pos);
      if (Math.abs(q.t) > 1.0 || (q.s - ap.s) * (q.s - tp.s) >= 0) continue;
      const f = (q.s - ap.s) / M.nz(tp.s - ap.s, 1), yl = a.pos.y + (ty - a.pos.y) * f;
      if (Math.abs(o.pos.y - yl) < 1.6) return true;
    }
    return false;
  }
  /* P95: a body (barrel, log, rock, crate ...) on a hitscan line: the shotgun's ray stops at the first one and only
   * nudges it (the CPU fired it into the same log, turn after
   * turn: 4 of 5 shotgun turns of a desert match; 14 % of its shots hit a worm). Same sampling as weapons.js shotgun():
   * 0.1 m steps from 0.7 m. */
  function bodyInLine(S, s0, y0, s1, y1) {
    if (!S.planeBodies || !S.planeBodies.length) return false;
    const L = M.len2(s1 - s0, y1 - y0), n = Math.ceil(L / 0.1);
    for (let i = 7; i < n - 3; i++) {
      const f = i / n;
      if (P.body_at2(S, s0 + (s1 - s0) * f, y0 + (y1 - y0) * f, true) >= 0) return true;
    }
    return false;
  }
  function clearLine(S, s0, y0, s1, y1) {
    const L = M.len2(s1 - s0, y1 - y0), n = Math.ceil(L / 0.2);
    for (let i = 2; i < n - 1; i++) {
      const f = i / n;
      if (P.solid2(S, s0 + (s1 - s0) * f, y0 + (y1 - y0) * f)) return false;
    }
    return true;
  }
  function fireSpecial(S, pl, a, b) {
    const WP = SS.weapons, d = pl.diff;
    if (SS.weaponsA && SS.weaponsA.ai_fire && SS.weaponsA.ai_fire(S, pl, a, b, d, gauss)) return;      // P37-W3
    if (SS.aib && SS.aib.fire(S, pl, a, b, d, gauss)) return;
    if (SS.aic && SS.aic.fire(S, pl, a, b, d, gauss)) return;
    S.weapon = b.special; a.facing = b.facing;
    pl.phase = 'done'; pl.fired = { wpn: b.special, v: b.v, target: foe_wid(pl.foes[b.fi]) };
    if (SS.gadgets && SS.gadgets.KEYS[b.special]) {
      SS.gadgets.ai_fire(S, a, b);
      return;
    }
    if (b.special === 'shotgun' || b.special === 'bat') {
      S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * (laserOn(a) ? 0.25 : 0.5), -1.5, 1.5);
      WP.use(S, 0);
      if (b.special === 'shotgun' && S.phase === 'play') {
        S.aim = M.clamp(b.aim + gauss(S) * d.noiseA * 0.5, -1.5, 1.5);
        WP.use(S, 0);
      }
      return;
    }
    // targeted strikes (P38-R2): the aim point has the difficulty's error too: sigma = 25 x the aim noise = 2.5 m easy,
    // 1 m normal, 0.25 m hard
    S.tgt = { s: b.ts + gauss(S) * d.noiseA * 25, y: b.ty };
    if (b.special === 'homing') {                                    // (the missile steers, but the launch still has the skill's noise)
      const an = M.clamp(b.aim + gauss(S) * d.noiseA, -1.5, 1.5);
      S.aim = muzzleClear(S, P.to_plane(S, a.pos).s, a.pos.y, a.facing, an) ? an : b.aim;
      SS.sim.fire(S, M.clamp(b.pw + gauss(S) * d.noiseP, 0.05, 1)); return;
    }
    if (b.special === 'airstrike') S.strikeDir = b.facing;
    WP.use(S, 0);
  }
  AI.stats = S => (
    S.aiPlan
    ? { phase: S.aiPlan.phase, best: S.aiPlan.best && { v: S.aiPlan.best.v, wpn: S.aiPlan.best.wpn }, fired: S.aiPlan.fired || null }
    : null
  );
  AI.specials_stage = specials;                          // tests
  AI.predict = predict;                                  // tests
})(window.SS = window.SS || {});
