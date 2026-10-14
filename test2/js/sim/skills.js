/* sim/skills.js — tool deliveries (a third kind of supply crate) and the skills they grant.
 * Every worm has w.skills = { freerot, laser, fastwalk, lowgrav, tinfoil } = turns left (tinfoil 1 = for the rest of
 * the game). W1 creates the field and reads freerot / fastwalk / lowgrav (sim.walk_speed, sim.gravity_k, the rotation
 * lock); this module grants, counts down, shows and uses the rest:
 *   freerot   the section can be turned freely (W1's rotation lock is lifted)                       2 turns (this + the
 *             next)
 *   laser     a dotted line along the exact path of a bullet weapon (shotgun, sniper, handgun, minigun, ...), unlimited
 *             range; the crosshair snaps to the first thing it meets (laser_path, used by render + CPU)    4 turns
 *   fastwalk  C.SKILL.FASTWALK_K x walk speed                                                         3 turns
 *   lowgrav   C.SKILL.LOWGRAV_K x gravity: higher, longer jumps                                       3 turns
 *   tinfoil   a tinfoil hat: lightning (the Thunder Strike weapon and the storm's strikes) does TINFOIL_K (10 %) damage
 *             (S.lightning is set around those strikes, sim.hurt applies the factor)                  for the game
 *   overload  not a skill: a rare delivery that drops 10 different crates around the whole map, in 3D
 * Tool crates: S.crates[] entries { kind: 'tool', tool }, dropped like weapon crates (WP.turn_start -> turn_start here)
 * no longer a roll per turn: one plan per ROUND (SK.crate_plan, levels crateW / crateH / crateT 0..10, C.CRATES),
 * at most one crate per round.
 * C layout: struct Skills { u8 freerot, laser, fastwalk, lowgrav, tinfoil; };  Crate += { u8 tool; }.
 * API: init(S), crate_plan(S, first), crate_level(S, kind), crate_chances(S), drop_tool(S), turn_end(S, w), pickup(S,
 *   a, crate), grant(S, w, tool), has(w, k), walk_k(S, w), gravity_k(S, w), is_bullet(key), laser_path(S, a, key, out),
 *   overload(S, a), hash(S, mix). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane;
  const EV = C.EV;
  const SK = SS.skills = {};
  const W = () => SS.world;
  const sim = () => SS.sim;
  const KS = C.SKILL = Object.assign({ FASTWALK_K: 1.6, LOWGRAV_K: 0.45, TINFOIL_K: 0.1 }, C.SKILL || {});
  KS.TURNS = { freerot: 2, laser: 4, fastwalk: 3, lowgrav: 3, tinfoil: 1 };
  // delivery table: [tool, weight]; the overload is rare (= SS.balance.TOOLS, the balance table; r7test checks they
  // agree: no load-time overwrite)
  KS.POOL = [['freerot', 14], ['laser', 20], ['fastwalk', 18], ['lowgrav', 18], ['tinfoil', 15], ['overload', 7]];
  KS.NAMES = {
    freerot: 'Free Rotation',
    laser: 'Laser Sight',
    fastwalk: 'Fast Walk',
    lowgrav: 'Low Gravity',
    tinfoil: 'Tinfoil Hat',
    overload: 'Crate Overload'
  };
  KS.INFO = {
    freerot: 'Turn the view freely, ignoring the rotation lock',
    laser: 'A dotted line shows the exact path of bullet weapons',
    fastwalk: 'Walk much faster',
    lowgrav: 'Low gravity: jump higher and further',
    tinfoil: 'Lightning does only 10 % damage, for the rest of the game',
    overload: 'Ten crates rain down all over the map'
  };
  KS.OVERLOAD_N = 10;
  KS.OVERLOAD_TOOL = 0.25;      // share of the non-health overload crates that are tools
  KS.LASER_KEYS = { shotgun: 1, sniper: 1, handgun: 1, minigun: 1, uzi: 1, mgun: 1 };
  KS.LASER_RANGE = 600;
  const rng = S => M.rng_next(S.skRng);
  const rr = (S, a, b) => a + (b - a) * rng(S);

  SK.init = function (S) { S.skRng = M.rng_make(((Math.imul(S.settings.seed | 0, 1274126177) + 0x51ed) >>> 0) || 1); };
  const sk = w => w.skills || (w.skills = { freerot: 0, laser: 0, fastwalk: 0, lowgrav: 0, tinfoil: 0 });
  SK.skills_of = sk;
  SK.has = (w, k) => !!(w && w.skills && w.skills[k] > 0);
  SK.walk_k = (S, w) => (SK.has(w, 'fastwalk') ? KS.FASTWALK_K : 1);
  SK.gravity_k = (S, w) => (SK.has(w, 'lowgrav') ? KS.LOWGRAV_K : 1);
  SK.is_bullet = key => !!(KS.LASER_KEYS[key] || (C.ARSENAL[key] && C.ARSENAL[key].bullet));

  /* ---------- granting and counting down ---------- */
  SK.grant = function (S, w, tool) {
    const s = sk(w);
    if (tool === 'overload') {
      SK.overload(S, w);
      return;
    }
    if (tool === 'tinfoil') s.tinfoil = 1;
    else s[tool] = M.max(s[tool] | 0, KS.TURNS[tool]);
    sim().emit(S, EV.SKILLGET, { wormId: w.id, tool });
    sim().log(S, `${w.name}: ${KS.NAMES[tool]}${tool === 'tinfoil' ? ' (for the rest of the game)' : ` (${s[tool]} turns)`}.`, 0x9fe8ff);
  };
  SK.pickup = function (S, a, c) {
    sim().emit(S, EV.PICKUP, { wormId: a.id, kind: 'tool', tool: c.tool });
    SK.grant(S, a, c.tool);
  };
  SK.turn_end = function (S, w) {
    const s = w.skills;
    if (!s) return;
    for (const k of ['freerot', 'laser', 'fastwalk', 'lowgrav'])
      if (s[k] > 0 && --s[k] === 0) sim().emit(S, EV.SKILLEND, { wormId: w.id, tool: k });
  };

  /* ---------- tool crates ---------- */
  const pick = S => {
    let tot = 0;
    for (const e of KS.POOL) tot += e[1];
    let u = rng(S) * tot;
    for (const e of KS.POOL) {
      u -= e[1];
      if (u < 0) return e[0];
    }
    return KS.POOL[0][0];
  };
  /* ---------- when does a crate fall? One plan per ROUND, not a roll per turn ---------- */
  /* level 0..10 of a crate kind ('weapon' | 'health' | 'tool'): settings crateW / crateH / crateT. The legacy
   * toolCrates ('off' | 'low' | 'normal' | 'high')
   * still works while crateT is at its default (the old tests, URL parameters and saved settings): it maps through
   * C.CRATES.LEGACY_TOOL. */
  SK.crate_level = function (S, kind) {
    const CR = C.CRATES, st = S.settings, i = CR.KINDS.indexOf(kind);
    if (i < 0) return 0;
    let v = st[CR.SLIDERS[i]];
    if (kind === 'tool' && (v == null || v === CR.DEF) && st.toolCrates != null && CR.LEGACY_TOOL[st.toolCrates] != null)
      v = CR.LEGACY_TOOL[st.toolCrates];
    v = v == null ? CR.DEF : +v;
    return Number.isFinite(v) ? M.clamp(Math.round(v), 0, CR.MAX) : CR.DEF;
  };
  /* the chances of a round: { any, weapon, health, tool }: any = P_LEVEL x the highest level (5 -> 0.2, 10 -> 0.4),
   * split over the kinds in proportion to their levels */
  SK.crate_chances = function (S) {
    const CR = C.CRATES, lv = CR.KINDS.map(k => SK.crate_level(S, k));
    let mx = 0, sum = 0;
    for (const v of lv) {
      mx = M.max(mx, v);
      sum += v;
    }
    const any = sum > 0 ? M.min(1, CR.P_LEVEL * mx) : 0, out = { any };
    for (let i = 0; i < CR.KINDS.length; i++) out[CR.KINDS[i]] = sum > 0 ? any * lv[i] / sum : 0;
    return out;
  };
  /* called at every turn start (after the round counter moved): the first turn of a round draws the plan - whether this
   * round has a crate, of which kind and
   * at which of the round's turns (3 draws of the own stream, always, so it stays in step) - and a plan's turn returns
   * the kind to drop, else null. At most one crate per round. Nothing falls in the match's first turn, in caves (no
   * sky) or while the plan says no. */
  SK.crate_plan = function (S, first) {
    const CR = C.CRATES, r = S.round | 0;
    if (first) return null;                                       // (the match's first turn: no draw, the stream stays where reset left it)
    if (!S.crPlan || S.crPlan.round !== r) {
      const ch = SK.crate_chances(S), u = rng(S), v = rng(S), at = rng(S);
      let kind = null;
      if (u < ch.any) {
        let acc = 0;
        const tot = ch.weapon + ch.health + ch.tool;
        for (const k of CR.KINDS) {
          acc += ch[k];
          if (v * tot < acc) {
            kind = k;
            break;
          }
        }
      }
      let alive = 0;
      for (let t = 0; t < (S.teams ? S.teams.length : 2); t++)
        if (SS.worm.team_alive(S, t)) alive++;
      // (the match's first turn draws nothing, so round 1's plan is drawn one turn late: skip that turn so
      // the slot always lies ahead and round 1 keeps the full chance; every later round starts at n 0)
      const n0 = !S.crPlan && r === 1 ? 1 : 0, span = M.max(1, alive - n0);
      S.crPlan = { round: r, kind, at: M.min(M.max(alive - 1, n0), n0 + Math.floor(at * span)), n: n0 };
    }
    const p = S.crPlan, hit = p.kind && p.n === p.at && !first && S.turnNo >= 2 && S.active && !W().under;
    p.n++;
    if (hit) {
      const k = p.kind;
      p.kind = null;
      return k;
    }
    return null;
  };
  /* a tool delivery (the plan said 'tool') */
  SK.drop_tool = function (S) {
    const tool = pick(S), WP = SS.weapons;
    if (!WP.crate_room(S, true)) return;     // (the tool crates' own cap, the oldest landed one makes room)
    // random spot in space, no parachute
    if (S.eow) {
      if (SS.eow.crate_add(S, 'tool', null, tool))
        sim().emit(S, EV.BANNER, { title: 'Tool delivery', sub: 'A crate drifts in from the dark' });
      return;
    }
    for (let tries = 0; tries < 12; tries++) {
      const s = rr(S, -25, 25), gy = WP.ground_below(S, s, W().SY - 0.5), at = P.to_world(S, s, gy);
      if (gy < -1e8 || gy < sim().surface_at(S, at.x, at.z) + 0.3 || (W().dry && !sim().in_play(S, at.x, at.z))) continue;
      S.crates.push(SS.weapons.crate_make(S, 'tool', null, tool, P.to_world(S, s, M.min(W().SY - 1, gy + 14))));
      sim().emit(S, EV.BANNER, {
        title: 'Tool delivery',
        sub: KS.NAMES[tool] === 'Crate Overload' ? 'Something big is coming' : 'It drifts with the wind'
      });
      return;
    }
  };
  /* crate overload: OVERLOAD_N crates of different kinds fall from random heights over the whole map (3D, not only the
   * section): health, weapon and tool crates, no two the same */
  SK.overload = function (S, a) {
    const w = W(), n = KS.OVERLOAD_N, used = {}, kinds = [], B = SS.balance, WPN = SS.weapons;
    // drawn like the normal supply: the health share, the rarity-weighted weapon draw (B.crate_pick) and some
    // tools; no two weapons / tools the same
    const hs = WPN.CRATE.HEALTH;
    for (let guard = 0; kinds.length < n && guard < 400; guard++) {
      const u = rng(S);
      if (u < hs) {
        kinds.push({ kind: 'health' });
        continue;
      }
      if (u < hs + (1 - hs) * KS.OVERLOAD_TOOL) {
        const t = pick(S);
        if (t === 'overload' || used['t' + t]) continue;
        used['t' + t] = 1;
        kinds.push({ kind: 'tool', tool: t });
        continue;
      }
      const k = B ? B.crate_pick(rng(S)) : C.CRATE_POOL[Math.floor(rng(S) * C.CRATE_POOL.length)];
      if (used['w' + k]) continue;
      used['w' + k] = 1;
      kinds.push({ kind: 'weapon', weapon: k });
    }
    let made = 0;
    // space: at random spots, drifting
    if (S.eow)
      for (const e of kinds) {
        if (WPN.crate_room(S, e.kind === 'tool') && SS.eow.crate_add(S, e.kind, e.weapon || null, e.tool || null)) made++;
      }
    else
      for (const e of kinds) {
        // (the caps; the oldest landed crate of the class makes room)
        if (!WPN.crate_room(S, e.kind === 'tool')) continue;
        for (let tries = 0; tries < 20; tries++) {
          const x = rr(S, 6, w.SX - 6), zr = rr(S, 6, w.SZ - 6), z = w.flat ? w.MZ : zr, top = M.max(w.top_at(x, z), w.SEA);
          if (w.dry && !sim().in_play(S, x, z)) continue;
          if (top < sim().surface_at(S, x, z) + 0.2) continue;                                      // not over the sea
          const y = M.min(w.SY - 1, top + rr(S, 10, 24));
          S.crates.push(SS.weapons.crate_make(S, e.kind, e.weapon || null, e.tool || null, { x, y, z })); made++;
          break;
        }
      }
    sim().emit(S, EV.OVERLOAD, { wormId: a.id, n: made });
    sim().emit(S, EV.BANNER, {
      title: 'Crate overload!',
      sub: S.eow ? `${made} crates are adrift in space` : `${made} crates are falling all over the map`
    });
    sim().log(S, `${a.name} triggers a crate overload: ${made} crates drop around the map!`, 0xffd27a);
  };

  /* ---------- laser sight ---------- */
  /* The exact path of a bullet of weapon `key` from worm a along its aim: out = { pts: [x, y, z, ...] (world),
   * hit: {x, y, z, kind: 'ground' | 'worm' | 'prop' | 'end'} }. Straight lines for the hitscan weapons, the sniper's
   * drop for the sniper; W3's SS.weaponsA.bullet_path(S, weapon, s, y, {s, y}) wins for the handgun / minigun (it may
   * return [{s, y}] or [[s, y]] or [{x, y, z}]). The range is unlimited (to the edge of the world). */
  SK.laser_path = function (S, a, key, out) {
    out.pts = []; out.hit = null;
    const ad = sim().aim_dir(S), ap = P.to_plane(S, a.pos);
    const s0 = ap.s + ad.s * 0.6, y0 = a.pos.y + ad.y * 0.6;
    // (bullet_path takes the aim DIRECTION {s, y} (before it got S.aim, a number: NaN path) and only knows the
    // handgun / minigun rounds; the sniper (drop) and the shotgun / others take the generic path below)
    if ((key === 'handgun' || key === 'minigun') && SS.weaponsA && SS.weaponsA.bullet_path) {
      const r = SS.weaponsA.bullet_path(S, key, s0, y0, ad);
      if (Array.isArray(r) && r.length > 1) {
        for (const q of r) {
          const x = Array.isArray(q) ? P.to_world(S, q[0], q[1]) : q.x != null ? q : P.to_world(S, q.s, q.y);
          out.pts.push(x.x, x.y, x.z);
        }
        const n = out.pts.length;
        out.hit = { x: out.pts[n - 3], y: out.pts[n - 2], z: out.pts[n - 1], kind: 'ground' };
        return out;
      }
    }
    const A = C.ARMS.SNIPER, sniper = key === 'sniper';
    let s = s0, y = y0, vs = ad.s, vy = ad.y, v = 1;
    if (sniper) {
      vs = ad.s * A.V;
      vy = ad.y * A.V;
      v = A.V;
    }
    const step = sniper ? 0.4 : 0.3, h = step / v, w = W();
    out.pts.push(...(() => {
      const p = P.to_world(S, s, y);
      return [p.x, p.y, p.z];
    })());
    let kind = 'end', n = 0, lastPush = 0;
    for (let L = 0; L < KS.LASER_RANGE; L += step) {
      if (sniper) {
        vy -= C.G * A.G * h;
        s += vs * h;
        y += vy * h;
      } else {
        s += vs * step;
        y += vy * step;
      }
      const p = P.to_world(S, s, y);
      if (
        y < 0.2
        || y > w.SY + 30
        || (w.dry ? sim().arena_r(p.x, p.z) > C.DRY.FAR_R : (p.x < -50 || p.z < -50 || p.x > w.SX + 50 || p.z > w.SZ + 50))
      ) break;
      if (P.solid2(S, s, y)) {
        kind = 'ground';
        break;
      }
      let hit = false;
      for (const o of S.worms)
        if (!o.dead && o !== a && M.v3_dist(o.pos, p) < C.WORM_R) {
          kind = 'worm';
          hit = true;
          break;
        }
      if (hit) break;
      if (S.planeBodies.length && P.body_at2(S, s, y, true) >= 0) {
        kind = 'prop';
        break;
      }
      if (sniper && ++n % 2 === 0) out.pts.push(p.x, p.y, p.z), lastPush = L;
    }
    const e = P.to_world(S, s, y);
    out.pts.push(e.x, e.y, e.z);
    out.hit = { x: e.x, y: e.y, z: e.z, kind };
    return out;
  };

  SK.hash = function (S, mix) {
    mix(S.skRng ? S.skRng.s : 0);
    for (const w of S.worms)
      if (w.skills) {
        const s = w.skills;
        mix(s.freerot * 1 + s.laser * 2 + s.fastwalk * 4 + s.lowgrav * 8 + s.tinfoil * 16);
      }
  };
})(window.SS = window.SS || {});
