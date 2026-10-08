/* sim/sim.js — game rules and orchestration of all world subsystems. No DOM, no renderer, no wall clock.
 *
 * Contract (C-style):
 *   GameState* S = sim_create();
 *   job = sim_begin_reset(S, &settings); while (sim_reset_step(S, job) < 1) {...progress bar...}
 *   each fixed step: sim_step(S, const Input* in, STEP);
 *   presentation reads S and drains S.events[] (explosions, splashes, lightning, collapses ...).
 * Subsystems (each a module of plain functions over S): blast, bodies (rigid), collapse, water, veg (trees,
 * grass, fire), weather (wind, rain/snow, lightning), lava. All randomness comes from S.rng (deterministic,
 * so a host can be the authoritative judge in multiplayer and clients can re-simulate).
 * Commands callable from UI/tests/network: rotate_by, align_to, align_next, fire, explode, shoot_rope, next_turn. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane, MAT = C.MAT;
  const W = () => SS.world;
  const sim = SS.sim = {};
  const rand = S => M.rng_next(S.rng);

  /* ---------- Input struct (filled by the platform layer or the network each step) ---------- */
  sim.input_make = () => ({
    move: 0, up: 0, down: 0,          // held axes
    jump: 0, backflip: 0,             // edge-triggered
    fire_pressed: 0, fire_held: 0,
    weapon: '',                       // '' or weapon key to select
    rotate: 0, rotate_mouse: 0, fine: 0,
    align_step: 0, align_refocus: 0, align_id: 0, end_turn: 0, reset: 0, inspect: 0,  // align_id = worm id + 1 (top map click)
    // P2 (PoC arsenal): fuse 1-5 (0 = unchanged); tgt = 1 sets the target point (ts, ty) in plane coords (target
    // weapons fire on it when fire_pressed comes with it; homing keeps it); sdir -1 / 1 strike side; gang +-1 girder
    // angle step; drop = drop the selected weapon from the rope
    fuse: 0, tgt: 0, ts: 0, ty: 0, sdir: 0, gang: 0, drop: 0,
    wsel: 0,                          // PoC worm select: switch to the team's next worm (option, first 10 s)
    aimset: 0, aimv: 0, face: 0       // PoC mouse aim: set the aim angle (rad) and facing (-1 / 1) from the cursor
  });

  /* 9b: a hash of the game state for the lockstep desync check (cheap: worms, bodies, time, turn, RNG, world version) */
  /* instant replay support (P22a): a full copy of the deterministic state (S + the voxel world's arrays) and its
   * restore; the platform re-runs the recorded inputs from it. W.version is kept MONOTONIC across a restore (the
   * renderers rebuild what a version bump marks: restore marks the whole lattice) and S.verBase follows it, so hashes
   * (which use version - verBase) match. ~20 MB per snapshot (d f32 + mat + heat + tops). */
  const DIRTY_MODS = ['water', 'veg', 'weather'];      // sim modules with a pending edit rect (W.listeners)
  sim.snapshot = function (S) {
    const w = W();
    const dirty = {}; for (const m of DIRTY_MODS) if (SS[m] && SS[m].dirty_get) dirty[m] = SS[m].dirty_get();
    return { S: structuredClone(S), d: w.d.slice(), mat: w.mat.slice(), heat: w.heat.slice(), top: w.top.slice(), topJ: w.topJ.slice(), sea: w.SEA, ver: w.version, dirty };
  };
  sim.restore = function (S, snap) {
    const w = W(), c = structuredClone(snap.S);
    for (const k of Object.keys(S)) if (!(k in c)) delete S[k];
    Object.assign(S, c);
    w.d.set(snap.d); w.mat.set(snap.mat); w.heat.set(snap.heat); w.top.set(snap.top); w.topJ.set(snap.topJ); w.SEA = snap.sea;   // (sudden death raises the sea)
    // quiet: the renderers rebuild everything, the sim modules get their own pending rects back (a whole-lattice
    // refresh re-derived every water column and the replay's water / floes drifted off the live run: review P36)
    w.mark_all(true); S.verBase = (S.verBase || 0) + (w.version - snap.ver);   // hash: version - verBase unchanged
    for (const m of DIRTY_MODS) if (SS[m] && SS[m].dirty_set) SS[m].dirty_set(snap.dirty ? snap.dirty[m] : null);
    S.sectionDirty = true;
  };
  sim.hash = function (S) {
    let h = 2166136261;
    const mix = v => { h = Math.imul(h ^ (Math.round(v * 1000) | 0), 16777619) >>> 0; };
    mix(S.time); mix(S.turnNo || 0); mix(S.rng ? S.rng.s : 0); mix(W().version - (S.verBase || 0)); mix(S.theta);   // version counts across resets: relative
    for (const w of S.worms) { mix(w.pos.x); mix(w.pos.y); mix(w.pos.z); mix(w.hp); }
    for (const b of S.bodies) { mix(b.pos.x); mix(b.pos.y); mix(b.pos.z); }
    for (const p of S.proj) { mix(p.s); mix(p.y); }
    // (review P36: the fluid / ice state too, so a divergence there shows before it moves a worm; a sum per field,
    // every HASH_EVERY steps in a match: ~40k cells each)
    for (const w of S.worms) { mix(w.swim ? 1 : 0); mix(w.iceV || 0); }
    const sum = a => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t; };
    if (S.water) { mix(sum(S.water.h)); mix(S.water.pend.length); }
    if (S.ice) { mix(sum(S.ice.h)); mix(sum(S.ice.snow)); mix(S.ice.floes.length); mix(S.ice.waves.length); for (const f of S.ice.floes) { mix(f.x); mix(f.z); } }
    if (S.lava) { mix(sum(S.lava.h)); mix(sum(S.lava.T)); }
    return h;
  };

  /* ---------- events for presentation ---------- */
  function emit(S, type, data) { data.type = type; data.t = S.time; S.events.push(data); return data; }
  function log(S, text, rgb) {
    S.log.unshift({ text, rgb: rgb == null ? 0xdfe8f1 : rgb, t: S.time });
    if (S.log.length > 7) S.log.length = 7;
  }
  sim.emit = emit; sim.log = log;

  sim.create = function () {
    return { events: [], log: [], worms: [], bodies: [], trees: [], proj: [], pending: [], planeBodies: [], flames: [], fx: [], frags: [], spat: [], stats: { slabBuilds: 0 }, rng: M.rng_make(1), settings: Object.assign({}, C.SETTINGS) };
  };

  /* ---------- setup ---------- */
  /* open lava (sim/lava.js layer) or a lava canal within ~2.5 m: no spawns, no props */
  function nearLava(S, x, z) {
    if (SS.lava && S.lava) for (let q = 0; q < 9; q++) {
      const dx = q === 0 ? 0 : M.cos(q * 0.785) * 2, dz = q === 0 ? 0 : M.sin(q * 0.785) * 2;
      if (SS.lava.depth_at(S, x + dx, z + dz) > 0.005) return true;
    }
    const cs = W().features.canals || [];
    for (let c = 0; c < cs.length; c++) for (const pt of cs[c].pts) if (M.len2(pt[0] - x, pt[2] - z) < pt[3] * 0.5 + 2.5) return true;
    return false;
  }
  sim.near_lava = nearLava;
  /* immersion of a body in open lava: depth of its bottom under the lava surface (m, <= 0 = not in lava) and heat 0..1 */
  sim.lava_contact = function (S, x, bottom, z, out) {
    out.sub = 0; out.heat = 0;
    if (!SS.lava || !S.lava) return out;
    const ls = SS.lava.surface_at(S, x, z);
    if (ls < 0 || bottom < W().top_at(x, z) - 0.5) return out;          // under the column's bed: a cave under rock, not lava
    out.sub = ls - bottom; out.surf = ls;
    out.heat = M.clamp((SS.lava.temp_at(S, x, z) - C.LAVA.T_SOLID) / 0.4, 0, 1);
    return out;
  };
  const lc = { sub: 0, heat: 0, surf: 0 };
  const lvv = { x: 0, y: 0, z: 0 };
  /* LV3: a worm floats on open lava (2600 kg/m3 vs ~1000): its foot rests at the lava surface minus its immersion
   * wm.lsink (hazards() relaxes it toward the buoyancy equilibrium); -1e9 = no open lava under it */
  // (user 2026-10-08: worms were "teleported to the top": the 2.5D lava column's surface was used whatever the worm's
  // height, so a worm in a cave under a lava-covered column snapped up through the rock: below the column's bed there
  // is no lava for it)
  function lavaFloor(S, x, z, wm) {
    if (!SS.lava || !S.lava) return -1e9;
    const ls = SS.lava.surface_at(S, x, z);
    if (ls < 0 || wm.pos.y - wm.foot < W().top_at(x, z) - 0.5) return -1e9;
    return ls - (wm.lsink || 0);
  }
  sim.lava_floor = lavaFloor;
  /* ---------- dry worlds (Step D, C.DRY): play area, hot sand ----------
   * No wall (D4): beyond the lattice the ground is the analytic far dunes (world.js W.sample -> W.far), so a worm
   * blasted out lands there, burns on the hot sand and has to walk back; beyond FAR_R it is lost in the desert. */
  const DRY = C.DRY;
  sim.arena_r = (x, z) => M.len2(x - DRY.CX, z - DRY.CZ);
  sim.in_play = (S, x, z) => !W().dry || sim.arena_r(x, z) <= S.playR;   // dry worlds: inside the (shrinking) play circle

  /* U: a standable cave floor (air with >= clear m of room above, a level floor, away from lava / others) */
  function caveSpot(S, minSep, taken, o) {
    const w = W();
    for (let tries = 0; tries < 6000; tries++) {
      const x = 6 + rand(S) * 84, z = 6 + rand(S) * 84;
      let y = 2 + rand(S) * (w.SY - 6);
      if (w.sample(x, y, z) > 0) continue;
      while (y > 1 && w.sample(x, y - 0.1, z) <= 0) y -= 0.1;
      if (y <= 1.2) continue;
      let ok = w.sample(x, y + (o.clear || 1.6), z) <= 0 && w.sample(x, y + 0.8, z) <= 0;
      for (const [dx, dz] of [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) { if (!ok) break; if (w.sample(x + dx, y + 0.3, z + dz) > 0 || w.sample(x + dx, y - 0.4, z + dz) <= 0) ok = false; }
      if (!ok) continue;
      const m = w.mat_at(x, y - 0.2, z);
      if (m === MAT.LAVA || (m === MAT.ICE && !o.ice) || (o.mats && o.mats.indexOf(m) < 0)) continue;
      if (taken.some(t => M.len3(t.x - x, t.z - z, (t.y - y) * 1.5) < minSep)) continue;
      return { x, y, z };
    }
    return null;
  }
  // last resort: the map centre's ground; underground (where topHeight is the roof) the floor of the first chamber
  function fallbackSpot(S) {
    const w = W(), ch = w.under && w.features.caves && w.features.caves.chambers[0];
    if (ch) { let y = ch.y; while (y > 1 && w.sample(ch.x, y - 0.1, ch.z) <= 0) y -= 0.1; return { x: ch.x, y, z: ch.z }; }
    return { x: 48, y: w.topHeight(48, 48), z: 48 };
  }
  sim.find_spot = function (S, minSep, taken, opts) {
    const w = W(), o = opts || {};
    if (w.under) return caveSpot(S, minSep, taken, o);
    for (let tries = 0; tries < 5000; tries++) {
      const x = 8 + rand(S) * 80, z = 8 + rand(S) * 80, top = w.topHeight(x, z);
      if (top < w.SEA + (o.minAlt || 1.5) || top > (o.maxAlt || 99)) continue;
      if (w.dry && sim.arena_r(x, z) > DRY.SPAWN_R) continue;                     // dry: everything starts in the play area
      const m = w.mat_at(x, top - 0.2, z);
      if (m === MAT.LAVA || m === MAT.ICE && !o.ice || (o.mats && o.mats.indexOf(m) < 0)) continue;
      let ok = true;
      const off = [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]];
      for (let i = 0; i < 4; i++) if (Math.abs(w.topHeight(x + off[i][0], z + off[i][1]) - top) >= (o.slope || 0.8)) ok = false;
      if (!ok || w.sample(x, top + (o.clear || 1.3), z) > 0) continue;
      const F = w.features;
      if ((F.volcanoes || []).some(v => M.len2(x - v.x, z - v.z) < v.Rc + 3)) continue;
      // P25: never on / beside a lava river (pre-filled, but they flow: keep 4 m from every canal centre line)
      if (F.canals && F.canals.some(cn => cn.pts.some(q => M.len2(q[0] - x, q[2] - z) < 4 + (q[3] || 0)))) continue;
      if (nearLava(S, x, z)) continue;
      let clash = false;
      for (let i = 0; i < taken.length; i++) if (M.len2(taken[i].x - x, taken[i].z - z) < minSep) { clash = true; break; }
      if (clash) continue;
      return { x, y: top, z };
    }
    return null;
  };

  /* Resumable reset (drives the loading progress bar): world generation, then subsystems, then actors. */
  sim.begin_reset = function (S, settings) {
    S.settings = Object.assign({}, C.SETTINGS, settings || S.settings);
    return { stage: 0, gen: W().gen_begin(S.settings), label: 'Shaping the land' };
  };
  sim.reset_step = function (S, job) {
    if (job.stage === 0) {
      const p = W().gen_step(job.gen); job.label = job.gen.label;
      if (p >= 1) { job.stage = 1; job.label = 'Water, weather and wildlife'; }
      return 0.85 * p;
    }
    if (job.stage === 1) { initState(S); job.stage = 2; job.label = 'Ready'; return 1; }
    return 1;
  };
  sim.reset = function (S, settings) { const job = sim.begin_reset(S, settings); while (sim.reset_step(S, job) < 1); };

  function initState(S) {
    const st = S.settings;
    M.rng_seed(S.rng, (C.LAYOUT_SEED + st.seed * 7919) >>> 0);
    // Every per-game field, once, with its default (a rematch must equal a fresh start: lockstep peers and replays
    // compare them). Modules add their own state in their init (weapons, game, weather, water, veg, lava, ice).
    Object.assign(S, {
      // lists and id counters
      worms: [], bodies: [], trees: [], proj: [], pending: [], planeBodies: [], flames: [], fx: [], frags: [], spat: [], log: [], bunkers: [],
      bodyId: 0, nextBodyId: 1, fragId: 0, spatId: 0, structId: 0, projN: 0, crateId: 0,
      fragRng: null, spatRng: null, spatAcc: 0, spatTick: 0, aiPlan: null, aiRng: null,
      // clock, phase, section
      tick: 0, time: 0, phase: 'play', theta: 0, O: { x: 48, z: 48 }, thetaGoal: null, sectionDirty: true, lastRotate: -99,
      // turn
      active: null, target: null, tgt: null, teamTurn: 1, nextIdx: [0, 0], turnNo: 0, turnT: 0, turnStart: 0, acted: false,
      retreatT: 0, attackStart: 0, resolveT: 0, quietT: 0, shots: 0, over: null,
      weapon: 'grenade', aim: 0.45, power: 0, charging: false, rope: null, hook: null, ropeHopT: -9, mouseRot: 0,
      // blasts, damage, dying beat, placement
      lastBoom: 0, slowUntil: 0, lastBlastT: -99, lastBlastW: 0, lastExplosion: null, lastCrater: null, hitDir: null,
      dyingW: null, dyingT: 0, dyingGrave: false, mapMinesUntil: 0, placeOrder: null, placeIdx: 0, placeT: 0, placeDone: -1,
      // presentation timers kept in S (see docs/PORTING.md: they move to the view in the port)
      ctx: 0, inspect: 0, lockMsgT: -9
    });
    S.events.length = 0;
    S.biome = W().biome;
    if (SS.weapons) SS.weapons.init(S);                           // P2: holes, strikes, devices, crates, fuse ...
    SS.game.setup(S);                                              // P1: teams, rounds, sudden death (before subsystems / spawns)
    if (SS.weather) SS.weather.init(S);
    if (SS.water) SS.water.init(S);
    if (SS.veg) SS.veg.init(S);
    if (SS.lava) SS.lava.init(S);
    if (SS.ice) SS.ice.init(S);                                   // Step I: sea / pool ice (after the water)
    emit(S, 'reset', {});
    const taken = [], nT = S.teams.length, nW = nT * M.clamp(S.settings.worms | 0 || 3, 1, 4), names = SS.game.names(S, nW);
    const hp0 = M.clamp(S.settings.hp | 0 || 100, 1, 999), sep = nW > 8 ? 11 : 15;
    for (let i = 0; i < nW; i++) {                                   // interleaved round-robin across the teams (PoC populate)
      const team = i % nT, spot = sim.find_spot(S, sep, taken) || sim.find_spot(S, 6, taken) || sim.find_spot(S, 3, taken) || fallbackSpot(S);
      taken.push(spot);
      S.worms.push({
        id: i, team, name: names[i], hp: hp0, hp0, dead: false, facing: 1, grave: null, dmgAcc: 0, dmgT: 0, hotT: -9, fireT: -9, fireStep: -1, iceV: 0, swim: null, ropeWet: null,
        pos: { x: spot.x, y: spot.y + 0.55, z: spot.z }, vel: { x: 0, y: 0, z: 0 }, rest: false, vs: 0, vy: 0, air: false, foot: 0.5
      });
    }
    if (S.settings.rooms && !W().under) SS.game.rooms(S); else S.rooms = [];   // PoC buried rooms (option)
    if (SS.struct) SS.struct.populate(S, taken);                  // M: steel bridges (before props / trees: they avoid the abutments)
    if (SS.bunker) SS.bunker.populate(S, taken);                  // P29d: concrete bunkers (before props / trees too)
    if (SS.scatter) SS.scatter.populate(S, taken);
    SS.game.furnish_rooms(S);
    if (SS.trees && !W().under) SS.trees.populate(S, taken);           // U: no trees (no light) underground
    if (S.settings.placement === 'user') SS.game.begin_placement(S);  // P13: the players place their worms first
    else sim.next_turn(S, true);
    S.verBase = W().version;
    const B = C.BIOMES.find(b => b.id === S.biome);
    log(S, W().under ? `${B ? B.name.replace(/ isle| island/i, '') : S.biome} caves: a cave system in 96 m × 96 m × 40 m of rock. Rotate with Q / E; the rope is your friend.`
      : `${B ? B.name : S.biome}: a 96 m × 96 m × 40 m volume. Rotate with Q / E.`, 0xfff3b0);
  }

  /* ---------- turn flow ---------- */
  function living(S, team) { return S.worms.filter(w => !w.dead && w.hp > 0 && (team === undefined || w.team === team)); }   // (a worm at 0 HP is dying)
  sim.living = living;
  /* the time of day (settings.time: day / dusk / night, 'random' = by the seed). Sim-side: the ice temperature reads
   * it; render/view.js uses the same for the light */
  sim.time_of_day = S => { const t = S.settings.time; if (t === 'day' || t === 'dusk' || t === 'night') return t; if (t === 'random') return ['day', 'day', 'dusk', 'night'][(Math.imul(S.settings.seed | 0, 2654435761) >>> 7) % 4]; return 'day'; };

  sim.team_name = (S, t) => (S.teams && S.teams[t] ? S.teams[t].name : C.TEAMS[t].name);
  sim.team_rgb = (S, t) => (S.teams && S.teams[t] ? S.teams[t].rgb : C.TEAMS[t].rgb);
  sim.next_turn = function (S, first) {
    S.rope = null; S.charging = false; S.power = 0; S.proj.length = 0; S.retreatT = 0;
    // P1: N teams: the match ends when at most one team has a living worm (none = a draw)
    const alive = S.teams.map((t, i) => living(S, i).length), standing = alive.filter(n => n > 0).length;
    if (standing <= 1) {
      S.over = alive.findIndex(n => n > 0); S.phase = 'over';
      log(S, S.over >= 0 ? `${sim.team_name(S, S.over)} win after ${S.round} rounds. Press R for a new map.` : 'Nobody survived. Press R for a new map.', 0xfff3b0);
      emit(S, 'gameover', { team: S.over, round: S.round });
      return;
    }
    if (!first) SS.game.turn_change(S);
    S.teamTurn = SS.game.next_team(S);
    // never hand a turn to a worm that is swimming / sinking: the rotation goes on past it (it keeps its place in the
    // order: indexing a shorter list reordered the team); a whole team in the water: the last one tried
    const team = living(S, S.teamTurn).sort((a, b) => a.id - b.id);
    let w, left = team.length;
    do { w = team[S.nextIdx[S.teamTurn] % team.length]; S.nextIdx[S.teamTurn]++; } while ((w.swim || w.drowning) && --left > 0);
    if (S.active) S.active.aimMem = S.aim;
    S.active = w; w.rest = false; S.turnNo++; S.hook = null;
    S.turnT = S.settings.turnTime > 0 ? S.settings.turnTime : 0; S.turnStart = S.time; S.acted = false;
    const tm = S.teams[w.team];
    if (tm && tm.lastWeapon && C.WEAPONS[tm.lastWeapon] && SS.game.ammo(S, w.team, tm.lastWeapon) > 0) S.weapon = tm.lastWeapon;   // the team's last weapon (PoC)
    else if (!(SS.game.ammo(S, w.team, S.weapon) > 0)) S.weapon = 'bazooka';
    S.phase = 'play'; S.sectionDirty = true; S.lastRotate = S.time; S.aim = w.aimMem != null ? w.aimMem : WD.AIM0;   // the worm's own aim (PoC: per worm)
    if (SS.weather) { SS.weather.new_turn(S); SS.weather.turn_lightning(S); }
    if (SS.water && !first) SS.water.new_turn(S);
    if (SS.ice && !first) SS.ice.new_turn(S);
    focusActive(S, w);
    // a worm hanging on a kept rope: the section turns to contain the rope, the worm swings on (in-plane rope again)
    if (w.rope) {
      const r = w.rope; w.rope = null;
      if (M.len2(r.x - w.pos.x, r.z - w.pos.z) > 0.15) { S.theta = clamp_heading(S, M.atan2(r.z - w.pos.z, r.x - w.pos.x), S.theta); S.O = { x: w.pos.x, z: w.pos.z }; }
      const q = P.to_plane(S, r), dd = P.dir(S);
      S.rope = { s: q.s, y: r.y, len: r.len, hooked: Math.abs(q.t) < 0.5 }; w.air = true; w.vs = w.vel.x * dd.x + w.vel.z * dd.z; w.vy = w.vel.y;
    }
    if (SS.weapons) SS.weapons.turn_start(S, first);              // P2: device lifetimes, supply drops
    if (first) S.mapMinesUntil = S.time + C.ARMS.TRAPS.MAP_MINES_SEEN;   // the map's mines: seen by all, then they burrow
    emit(S, 'turn', { worm: w });
    if (!first) log(S, `${sim.team_name(S, w.team)} · ${w.name}'s turn. Section aligned with ${S.target.name}.`, sim.team_rgb(S, w.team));
  };

  /* PoC worm select (setup option): in the first SELECT_T s of a turn, before the worm acts, the player may hand the
   * turn to the team's next living worm (the clock keeps running) */
  const SELECT_T = 10;
  sim.can_switch = S => !!(S.settings.select && S.phase === 'play' && S.active && !S.acted && S.time - S.turnStart < SELECT_T);
  sim.switch_worm = function (S) {
    if (!sim.can_switch(S)) return false;
    const a = S.active, team = living(S, a.team).filter(o => o === a || (!o.swim && !o.drowning)).sort((p, q) => p.id - q.id);   // (not a swimmer: review)
    if (team.length < 2) return false;
    const w = team[(team.indexOf(a) + 1) % team.length];
    a.vel = { x: 0, y: 0, z: 0 }; a.rest = false;
    S.active = w; w.rest = false; S.rope = null; S.charging = false;
    a.aimMem = S.aim; focusActive(S, w); S.aim = w.aimMem != null ? w.aimMem : WD.AIM0;
    emit(S, 'switch', { worm: w });
    log(S, `${w.name} takes over.`, sim.team_rgb(S, w.team));
    return true;
  };
  // the section / target / momentum set-up for the worm whose turn it is (next_turn, worm select)
  function focusActive(S, w) {
    S.O = { x: w.pos.x, z: w.pos.z };
    const foes = living(S).filter(o => o.team !== w.team).sort((a, b) => M.len2(a.pos.x - w.pos.x, a.pos.z - w.pos.z) - M.len2(b.pos.x - w.pos.x, b.pos.z - w.pos.z));
    S.target = foes[0];
    S.theta = M.atan2(S.target.pos.z - w.pos.z, S.target.pos.x - w.pos.x);
    S.theta = clamp_heading(S, S.theta, S.theta);     // D6: a worm out in the hot sand faces a plane through the play area
    S.thetaGoal = null; w.facing = 1; S.tgt = null;   // (a target belongs to the old plane)
    // a worm that takes over in mid-air keeps its momentum (in the new plane)
    const dd = P.dir(S), vx = w.vel ? w.vel.x : 0, vz = w.vel ? w.vel.z : 0, vy = w.vel ? w.vel.y : 0;
    w.air = !P.grounded2(S, 0, w.pos.y) || Math.abs(vy) > 0.5;
    w.vs = w.air ? vx * dd.x + vz * dd.z : 0; w.vy = w.air ? vy : 0;
  }
  // PoC sniperAimRate: aim slows near what the scope points at (2.06 / max(1.41, dist) rad/s, 0.025 .. 1.5)
  function sniperRate(S, a) {
    const ad = sim.aim_dir(S), ap = P.to_plane(S, a.pos);
    for (let d = 0.6; d < 40; d += 0.25) { const s = ap.s + ad.s * d, y = a.pos.y + ad.y * d, p = P.to_world(S, s, y); if (P.solid2(S, s, y) || S.worms.some(o => !o.dead && o !== a && M.len3(o.pos.x - p.x, o.pos.y - y, o.pos.z - p.z) < C.WORM_R)) return M.clamp(2.06 / Math.max(1.41, d), 0.025, WD.AIM_RATE); }
    return WD.AIM_RATE;
  }
  function locked(S) {
    if (S.phase === 'play' || S.phase === 'place') return false;
    if (S.time - S.lockMsgT > 1.5) { S.lockMsgT = S.time; log(S, 'Section locked until the attack and its aftermath resolve.', 0xffb27a); }
    return true;
  }
  sim.locked = locked;

  /* D6 heading window (dry worlds): a worm out on the hot sand (beyond the play circle PLAY_R about the map centre)
   * may only turn the section to planes that still cross the play circle: wrap(θ − φ) or wrap(θ − φ − π) within
   * [lo, hi], φ = heading to the centre, ±α = ±asin(PLAY_R / dist) (θ and θ + π are the same plane seen from the
   * other side; α -> 90° at the edge, so walking out never makes the heading jump). The window is WIDENED to the
   * plane through every other living worm (+ AIM_MARGIN or the worm's own angular size): a worm out there can always
   * be aimed at (user: "couldnt find any rotation angle to aim at that worm"). Inside the play circle (and on wet
   * worlds) every heading is free: null (a ROT_R 30 < PLAY_R once stopped full turns at r 30..34). */
  const AIM_MARGIN = 0.06;     // rad (3.4°) past a worm's plane, so it can be centred and passed slightly
  function heading_window(S) {
    const a = S.active;
    if (!SS.world.dry || !a) return null;
    const D = C.DRY, dx = D.CX - a.pos.x, dz = D.CZ - a.pos.z, dist = M.len2(dx, dz);
    if (dist <= S.playR) return null;
    const phi = M.atan2(dz, dx), al = M.asin(S.playR / dist);
    let lo = -al, hi = al;
    for (let q = 0; q < S.worms.length; q++) {
      const w = S.worms[q];
      if (w === a || w.dead) continue;
      const ex = w.pos.x - a.pos.x, ez = w.pos.z - a.pos.z, l = M.len2(ex, ez);
      if (l < 0.5) continue;
      let r = M.wrap_angle(M.atan2(ez, ex) - phi);                     // the plane through w, relative to φ ...
      if (r > Math.PI / 2) r -= Math.PI; else if (r < -Math.PI / 2) r += Math.PI;   // ... as a line: in [-90°, 90°]
      const mg = Math.max(AIM_MARGIN, M.atan(1.5 / l));
      if (r - mg < lo) lo = r - mg;
      if (r + mg > hi) hi = r + mg;
    }
    if (hi - lo >= Math.PI) return null;                                   // every plane is allowed
    return { c0: phi, c1: M.wrap_angle(phi + Math.PI), lo, hi };
  }
  /* th clamped into the window arc nearest to `from` (the current heading: rotation stops at the window's edge
   * instead of crossing forbidden headings; at a turn start from = th itself) */
  const arc_dist = (v, lo, hi) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  function clamp_heading(S, th, from) {
    const w = heading_window(S);
    if (!w) return th;
    const c = arc_dist(M.wrap_angle(from - w.c0), w.lo, w.hi) <= arc_dist(M.wrap_angle(from - w.c1), w.lo, w.hi) ? w.c0 : w.c1;
    return M.wrap_angle(c + M.clamp(M.wrap_angle(th - c), w.lo, w.hi));
  }
  sim.heading_window = heading_window; sim.clamp_heading = clamp_heading;

  /* Rotate about the vertical axis through the active worm. The worm's world position is untouched. */
  sim.rotate_by = function (S, da) {
    if (locked(S) || !S.active || !da) return false;
    const a = S.active, th = clamp_heading(S, M.wrap_angle(S.theta + da), S.theta);
    if (th === S.theta) return false;                 // at the edge of the heading window (D6)
    const ap = P.to_plane(S, a.pos);
    if (S.rope) { S.rope.s -= ap.s; S.rope.hooked = false; }
    S.tgt = null;                                     // a target is a point on the old plane: pick it again
    S.O = { x: a.pos.x, z: a.pos.z };
    S.theta = th;
    S.lastRotate = S.time; S.sectionDirty = true;
    return true;
  };
  sim.align_to = function (S, w) {
    if (!w || w.dead || locked(S) || !S.active) return;
    S.target = w;
    let g = M.wrap_angle(M.atan2(w.pos.z - S.active.pos.z, w.pos.x - S.active.pos.x));
    // D6: of the two headings of that plane (g, g + π) take the one in the current window, clamped (never across
    // forbidden headings, so the turn toward the goal always arrives)
    if (heading_window(S)) {
      const g2 = M.wrap_angle(g + Math.PI), a = clamp_heading(S, g, S.theta), b = clamp_heading(S, g2, S.theta);
      g = Math.abs(M.wrap_angle(a - g)) <= Math.abs(M.wrap_angle(b - g2)) ? a : b;
    }
    S.thetaGoal = g;
  };
  sim.align_next = function (S, step) {
    if (locked(S) || !S.active) return;
    const others = S.worms.filter(w => !w.dead && w !== S.active);
    if (!others.length) return;
    const i = others.indexOf(S.target);
    sim.align_to(S, others[((i < 0 ? -1 : i) + step + others.length) % others.length]);
  };

  /* ---------- active worm: 2D in the section ---------- */
  sim.aim_dir = S => ({ s: S.active.facing * M.cos(S.aim), y: M.sin(S.aim) });
  function setActive2D(S, a, s, y) { const p = P.to_world(S, s, y); a.pos.x = p.x; a.pos.y = y; a.pos.z = p.z; }

  /* ---------- PoC worm dynamics (C.WORM_DYN; game.js walkWorm / updateWorm / integrateBody) ---------- */
  const WD = C.WORM_DYN, GW = C.G_WORM;
  const RIM = []; for (let i = 0; i < 12; i++) { const t = i / 12 * Math.PI * 2; RIM.push(M.cos(t) * C.WORM_R, M.sin(t) * C.WORM_R); }
  // contact normal of the worm disc at (s, y): away from the blocked rim points (null = no contact)
  function rimNormal(S, s, y) {
    let ns = 0, ny = 0, n = 0;
    for (let i = 0; i < RIM.length; i += 2) if (P.blocked2(S, s + RIM[i], y + RIM[i + 1])) { ns -= RIM[i]; ny -= RIM[i + 1]; n++; }
    if (!n) return null;
    const l = M.len2(ns, ny); return l < 1e-6 ? { s: 0, y: 1 } : { s: ns / l, y: ny / l };
  }
  // the worm disc overlaps another worm (walkWorm: then it may climb 18 px instead of 10)
  const onWorm = (S, a, s, y) => { for (const b of S.planeBodies) if (b.worm && b.worm !== a && M.len2(b.s - s, b.y - y) < 2 * C.WORM_R - 0.02) return b; return null; };
  // landing damage (PoC: head-on / glancing, both only on floors and slopes), the spring trap's minimum
  function landHurt(S, w, dmg) {
    if (w.springFall) { w.springFall = false; dmg = Math.max(dmg, C.ARMS.SPRING.FALL_MIN); }
    if (dmg > 0) hurt(S, w, dmg, 'a hard landing');
  }
  function landNow(S, a, impact) {
    a.iceV = SS.ice && S.ice && SS.ice.slippery(S, a.pos.x, a.pos.z) ? a.vs : 0;   // P30: lands sliding on bare ice
    a.air = false; a.vs = 0; a.vy = 0; a.flip = false; a.hop = false; a.slide = false; a.stillT = 0;
    if (a.springFall) landHurt(S, a, 0);
    if (impact > 2) emit(S, 'land', { worm: a, x: a.pos.x, y: a.pos.y - 0.45, z: a.pos.z, speed: impact, mat: W().mat_at(a.pos.x, a.pos.y - 0.7, a.pos.z) });
    if (impact > 9.6) a.squash = S.time;
  }
  sim.weapon_ready = function (S, a) {                 // PoC weaponReady L4342
    return !a.walking && !a.air && !S.rope && !a.flip && !(a.dizzyUntil > S.time) && !(S.teleT > 0) && !a.drowning && !a.swim && M.len2(a.vs || 0, a.vy || 0) < WD.READY_V;
  };
  /* PoC recoverPinnedWorm (L2009): a worm inside a resting prop (a crate landed on it, a boulder settled into it) moves
   * to the nearest spot where the WHOLE disc is free (up, sideways, the diagonals; up to 2 x the prop + the worm,
   * at most 110 px = 7.07 m), else the prop breaks (never a soft-locked worm); a worm "in the air" but slow, not
   * sliding / hopping / flipping and touching ground that stays within 2 px (0.13 m) for 0.18 s lands */
  const PIN_ANG = [Math.PI / 2, 0, Math.PI, Math.PI / 4, 3 * Math.PI / 4, -Math.PI / 4, -3 * Math.PI / 4];
  function pinningBody(S, s, y) {
    for (const b of S.planeBodies) {
      if (!b.ref || !b.ref.asleep) continue;
      const inside = (ps, py) => b.kind === 0 ? M.len2(ps - b.s, py - b.y) < b.r : Math.abs(ps - b.s) < b.hs && Math.abs(py - b.y) < b.hy;
      if (inside(s, y)) return b;
      for (let k = 0; k < 12; k++) { const t = k / 12 * Math.PI * 2; if (inside(s + M.cos(t) * (C.WORM_R - PX), y + M.sin(t) * (C.WORM_R - PX))) return b; }
    }
    return null;
  }
  function recoverPinned(S, a, dt) {
    if (S.rope || S.hook || S.dig || a.drowning || a.swim || a.dead || !sim.ctl(S, a)) return;
    const s = P.to_plane(S, a.pos).s, y = a.pos.y, pin = pinningBody(S, s, y);
    if (pin) {
      const size = pin.kind === 0 ? pin.r : Math.max(pin.hs, pin.hy), maxR = Math.min(110 * PX, size * 2 + C.WORM_R);
      let found = null;
      for (let r = PX; r <= maxR + 1e-6 && !found; r += PX) for (const t of PIN_ANG) {
        const ns = s + M.cos(t) * r, ny = y + M.sin(t) * r, wq = P.to_world(S, ns, ny);
        if (ny - C.WORM_R < sim.surface_at(S, wq.x, wq.z) || P.overlap2(S, ns, ny) > 0) continue;
        found = { s: ns, y: ny }; break;
      }
      if (!found) {                                       // remove the obstruction rather than soft-lock the worm
        const b = pin.ref; SS.bodies.remove(S, b);
        emit(S, 'propbreak', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, kind: b.prop || 'rubble', why: 'pinned' });
        return;
      }
      setActive2D(S, a, found.s, found.y);
      a.vs = a.vy = 0; a.flip = false; a.hop = false; a.slide = false;
      a.air = !P.grounded2(S, found.s, found.y); if (!a.air) landNow(S, a, 0);
      a.pinProbe = null;
    } else if (a.air && !a.slide && !a.hop && !a.flip && M.len2(a.vs, a.vy) < 70 * PX && P.grounded2(S, s, y)) {
      const p = a.pinProbe || (a.pinProbe = { s, y, t: 0 });
      if (M.len2(s - p.s, y - p.y) < 2 * PX) p.t += dt; else { p.s = s; p.y = y; p.t = 0; }
      if (p.t > 0.18) { landNow(S, a, 0); p.t = 0; }
    } else a.pinProbe = null;
  }
  function step2D(S, a, dt, mv) {
    let s = P.to_plane(S, a.pos).s, y = a.pos.y;
    a.walking = false;
    if (!a.air && mv) a.facing = mv;
    let wq = P.to_world(S, s, y), lf = lavaFloor(S, wq.x, wq.z, a);
    if (!a.air) {
      // walking: 2.96 m/s, step up 0.64 m (1.16 m over another worm), follow the ground down 0.64 m, else drop off
      let hs = mv * C.WALK;
      if (hs && sim.lava_contact(S, a.pos.x, a.pos.y - a.foot, a.pos.z, lc).sub > 0.05) hs *= C.LAVA_WADE;   // wading in viscous lava
      // P30: bare sea ice is slippery: the speed eases toward the walk speed (C.ICE.GRIP 1/s) and slides on when the key
      // is let go; a thin snow cover on the ice gives grip again (SS.ice.slippery)
      const it = SS.ice && S.ice ? SS.ice.top_at(S, a.pos.x, a.pos.z) : -1e9;
      const onIce = it > -1e8 && Math.abs(a.pos.y - a.foot - it) < 0.15 && SS.ice.slippery(S, a.pos.x, a.pos.z);
      if (onIce) { a.iceV += (hs - a.iceV) * (1 - M.exp(-C.ICE.GRIP * dt)); hs = Math.abs(a.iceV) < 0.04 && !mv ? 0 : a.iceV; } else a.iceV = 0;
      if (hs) {
        const base = P.overlap2(S, s, y), ns = s + hs * dt, top = onWorm(S, a, s, y) ? WD.STEP_UP_WORM : WD.STEP_UP;
        let moved = false;
        for (let l = 0; l <= top + 1e-6; l += 0.04) if (P.overlap2(S, ns, y + l) <= base) { s = ns; y += l; a.walking = true; moved = true; break; }
        if (!moved) a.iceV = 0;                                                  // slid into something
      }
      let snapped = P.grounded2(S, s, y);
      if (!snapped) for (let l = 0.04; l <= WD.STEP_DOWN + 1e-6; l += 0.04) if (P.grounded2(S, s, y - l) || P.overlap2(S, s, y - l) > P.overlap2(S, s, y)) { y -= l - (P.overlap2(S, s, y - l) > P.overlap2(S, s, y) ? 0.04 : 0); snapped = true; break; }
      wq = P.to_world(S, s, y); lf = lavaFloor(S, wq.x, wq.z, a);
      const onLava = lf > -1e8 && a.pos.y - a.foot <= lf + 0.08;
      if (onLava) {
        // floats (sinks with lsink), or a bank holds it; deep in a lava column it RISES (viscous, 1.5 m/s), never jumps
        const yf = lf + a.foot; y = y < yf - C.LAVA.DEEP ? y + 1.5 * dt : snapped ? Math.max(y, yf) : yf;   // (lakes / canals < DEEP: as before)
        SS.lava.vel_at(S, wq.x, wq.z, lvv);
        const d = P.dir(S), ds = 1.5 * (lvv.x * d.x + lvv.z * d.z) * dt;
        if (ds && P.overlap2(S, s + ds, y) <= P.overlap2(S, s, y)) s += ds;
      }
      if (!snapped && !onLava) { a.air = true; a.vs = mv ? mv * WD.LEDGE_VS : 0; a.vy = 0; }      // ledge: drops off at 40 px/s
      else { a.vs = 0; a.vy = 0; }
    }
    if (a.air) {
      const sp0 = M.len2(a.vs, a.vy), nsub = Math.max(1, Math.ceil(sp0 * dt / 0.08)), h = dt / nsub;
      let contact = null;
      for (let k = 0; k < nsub && a.air; k++) {
        a.vy -= GW * h;
        let ns = s + a.vs * h, ny = y + a.vy * h;
        wq = P.to_world(S, ns, ny); lf = lavaFloor(S, wq.x, wq.z, a);
        if (lf > -1e8 && a.vy < 0 && ny - a.foot <= lf && y - a.foot > lf - C.LAVA.DEEP) {   // lands on the lava (crossing its surface): it floats
          if (a.vy < -2) emit(S, 'lavaplop', { x: wq.x, y: lf + (a.lsink || 0), z: wq.z, speed: -a.vy });
          y = lf + a.foot; s = ns; landNow(S, a, 0); break;
        }
        if (P.overlap2(S, ns, ny) <= P.overlap2(S, s, y) && !rimNormal(S, ns, ny)) { s = ns; y = ny; continue; }
        const n = rimNormal(S, ns, ny) || { s: 0, y: 1 }, vn = a.vs * n.s + a.vy * n.y;
        contact = n;
        if (vn >= 0) { if (P.overlap2(S, ns, ny) <= P.overlap2(S, s, y)) { s = ns; y = ny; } continue; }
        const imp = -vn, sp = M.len2(a.vs, a.vy), ts = -n.y, ty = n.s, vt = a.vs * ts + a.vy * ty, along = Math.abs(vt) / Math.max(1e-6, sp);
        // landing on another worm's head (PoC resolveWormContacts): it is shoved aside, the lander stops on top
        const lower = n.y > 0.5 ? onWorm(S, a, ns, ny - 0.1) : null;
        if (lower && imp >= WD.HEAD_SHOVE_V && !(lower.worm.shoveT > S.time)) {
          const o = lower.worm, d = P.dir(S), dir = Math.abs(o.s - ns) > 0.06 ? Math.sign(lower.s - ns) : a.facing, v = M.clamp(imp * WD.SHOVE_K, WD.SHOVE_MIN, WD.SHOVE_MAX);
          o.rest = false; o.vel.x += d.x * dir * v; o.vel.z += d.z * dir * v; o.vel.y = Math.max(o.vel.y, WD.SHOVE_UP); o.slide = true; o.shoveT = S.time + WD.SHOVE_COOL;
          if (o.rope) o.rope = null;
          landNow(S, a, imp); a.vs *= 0.25; a.squash = S.time; break;
        }
        if (imp > WD.FALL_SAFE && n.y > 0.2) {                                // a hard landing on a floor or slope
          const head = along < WD.HEAD_ALONG;
          // the rebound first: the damage ends the turn and hands the worm (with this velocity) to the 3D body step
          if (head) { const up = Math.min(WD.HEAD_UP_MAX, WD.HEAD_UP_K * imp); a.vs = n.s * up + a.facing * WD.HEAD_SIDE; a.vy = n.y * up; a.dizzyUntil = S.time + WD.DIZZY; a.squash = S.time; emit(S, 'dizzy', { worm: a }); }
          else { a.vs = ts * vt * WD.FRIC - n.s * vn * WD.BOUNCE; a.vy = ty * vt * WD.FRIC - n.y * vn * WD.BOUNCE; }
          a.slide = true; a.flip = false; a.hop = false;
          emit(S, 'land', { worm: a, x: a.pos.x, y: a.pos.y - 0.45, z: a.pos.z, speed: imp, mat: W().mat_at(a.pos.x, a.pos.y - 0.7, a.pos.z), hard: 1 });
          setActive2D(S, a, s, y);
          landHurt(S, a, head ? Math.min(WD.HEAD_MAX, Math.round((imp - WD.FALL_SAFE) * WD.HEAD_K) + WD.HEAD_ADD) : Math.min(WD.GLANCE_MAX, Math.round((imp - WD.FALL_SAFE) * WD.GLANCE_K)));
          if (!sim.ctl(S, a)) return;                                         // (the turn ended: the 3D body step takes over)
        } else if (!a.slide && n.y > WD.FIRM_NY) { landNow(S, a, imp); break; }   // a firm landing stops dead (PoC land())
        else { a.vs = ts * vt * WD.FRIC - n.s * vn * WD.BOUNCE; a.vy = ty * vt * WD.FRIC - n.y * vn * WD.BOUNCE; }   // skid / wall / ceiling
      }
      // a skidding worm comes to rest: slow and supported for 0.45 s, or a soft touch on a floor
      if (a.air && contact) {
        const sp = M.len2(a.vs, a.vy);
        if (contact.y > WD.SOFT_NY && sp < WD.SOFT_V && !a.slide) landNow(S, a, sp);
        else if (sp < WD.STILL_V && contact.y > 0.2) { a.stillT = (a.stillT || 0) + dt; if (a.stillT > WD.STILL_T) landNow(S, a, sp); }
        else a.stillT = 0;
      }
    }
    setActive2D(S, a, s, y);
  }


  /* PoC fireRope / updateHook: the hook FLIES (1700 px/s = 109 m/s) from the hand along the aim, up to ROPE_MAX, and
   * catches the first solid (terrain or a prop on the section); the worm is attached when it bites */
  sim.shoot_rope = function (S) {
    const a = S.active, ap = P.to_plane(S, a.pos), d = sim.aim_dir(S);
    S.hook = { s: ap.s + d.s * 0.4, y: a.pos.y + d.y * 0.4, ds: d.s, dy: d.y, dist: 0.4 };
    emit(S, 'rope_fire', P.to_world(S, S.hook.s, S.hook.y));
  };
  // fly the hook to its end at once (tests / tools: same steps as the live flight, the worm does not move meanwhile)
  sim.hook_resolve = function (S) { for (let i = 0; S.hook && i < 1000; i++) stepHook(S, S.active, C.STEP); };
  function stepHook(S, a, dt) {
    const k = S.hook, step = 0.1, n = Math.ceil(RT.HOOK_V * dt / step);
    for (let i = 0; i < n; i++) {
      k.s += k.ds * step; k.y += k.dy * step; k.dist += step;
      if (P.solid2(S, k.s, k.y) || (S.planeBodies.length && P.body_at2(S, k.s, k.y, true) >= 0)) {   // terrain or a prop (not a worm)
        const ap = P.to_plane(S, a.pos), L = M.len2(k.s - ap.s, k.y - a.pos.y);
        S.rope = { s: k.s, y: k.y, len: Math.max(C.ROPE_MIN, L), hooked: true, pins: [], fixed: 0 }; a.air = true; S.hook = null;
        log(S, `Rope attached ${L.toFixed(1)} m away.`);
        emit(S, 'rope_hook', P.to_world(S, k.s, k.y));
        return;
      }
      if (k.dist >= C.ROPE_MAX || k.y < 0.2 || k.y > W().SY + 2) { S.hook = null; log(S, `Nothing within ${C.ROPE_MAX.toFixed(0)} m on this section for the rope.`, 0xffb27a); return; }
    }
  }
  function releaseRope(S) { S.rope = null; S.active.air = true; }

  /* While the plane rotates, the rope keeps its in-plane offset (it turns with the plane).
   * When rotation settles, it re-hooks on the new section along that same line, or is released. */
  function reseatRope(S) {
    const a = S.active, r = S.rope, ap = P.to_plane(S, a.pos);
    const dx = r.s - ap.s, dy = r.y - a.pos.y, L = M.len2(dx, dy) || 1;
    for (let q = 0.5; q <= C.ROPE_MAX; q += 0.1) {
      const s = ap.s + dx / L * q, y = a.pos.y + dy / L * q;
      if (P.solid2(S, s, y)) {
        r.s = s; r.y = y; r.len = Math.max(C.ROPE_MIN, q); r.hooked = true; r.pins = []; r.fixed = 0;
        log(S, `Rope re-hooked on the new section (${q.toFixed(1)} m).`, 0xfff3b0);
        emit(S, 'rope_hook', P.to_world(S, s, y));
        return;
      }
    }
    log(S, 'No terrain on the rope line in this section – rope released.', 0xffb27a);
    releaseRope(S);
  }
  /* PoC ninja rope (ropeStep, ROPE_TUNE scaled: accelerations x 9.81 / 520, speeds x 28 / 1026): pumping adds a
   * tangential acceleration while taut (+ a little air control), fast reeling, a speed cap; the rope WRAPS around
   * corners (pins: earlier pivots, the free length shrinks by each fixed segment) and unwraps when the worm swings back */
  const PX = 0.0643, RT = { SWING: 1050 * PX, AIR: 210 * PX, REEL_IN: 340 * PX, REEL_OUT: 460 * PX, VMAX: 1150 * PX, HOP_UP: 220 * PX, HOP_SIDE: 145 * PX, HOP_PAY: 24 * PX, HOP_COOL: 0.38, HOOK_V: 1700 * PX };   // ROPE_TUNE x 1 px = 0.0643 m (times kept)
  sim.ROPE_TUNE = RT;
  function lineBlocked(S, s0, y0, s1, y1, skip0, skip1) {
    const L = M.len2(s1 - s0, y1 - y0); if (L < 1e-3) return false;
    for (let d = skip0; d < L - skip1; d += 0.12) { const f = d / L; if (P.solid2(S, s0 + (s1 - s0) * f, y0 + (y1 - y0) * f)) return true; }
    return false;
  }
  // the corner the rope now bends around: sweep the line's end from where the worm was to where it is, take the first
  // blocked line, then its first solid sample from the pivot, backed off out of the rock
  function ropeCorner(S, r, ps, py, s, y) {
    for (let k = 1; k <= 8; k++) {
      const es = ps + (s - ps) * k / 8, ey = py + (y - py) * k / 8, L = M.len2(es - r.s, ey - r.y);
      if (!lineBlocked(S, r.s, r.y, es, ey, 0.15, 0.3)) continue;
      for (let d = 0.15; d < L; d += 0.06) {
        const f = d / L, qs = r.s + (es - r.s) * f, qy = r.y + (ey - r.y) * f;
        if (P.solid2(S, qs, qy)) { const n = P.normal2(S, qs, qy), b = Math.max(0, d - 0.06) / L; return { s: r.s + (es - r.s) * b + n.s * 0.12, y: r.y + (ey - r.y) * b + n.y * 0.12 }; }
      }
    }
    return null;
  }
  function stepRope(S, a, dt, mv, up, down) {
    const r = S.rope; let s = P.to_plane(S, a.pos).s, y = a.pos.y;
    if (!r.pins) { r.pins = []; r.fixed = 0; }
    const len0 = r.len;
    if (up) r.len = Math.max(0.64, r.len - RT.REEL_IN * dt);
    if (down) r.len = Math.min(C.ROPE_MAX - r.fixed, r.len + RT.REEL_OUT * dt);
    if (mv) a.facing = mv;
    a.vy -= GW * dt;
    // pumping (PoC ropeStep L3775-3782): a tangential push toward the pressed side, taut or slack (an upward push when
    // the rope is nearly horizontal-tangent), plus a little horizontal air control
    if (mv) {
      const dx = s - r.s, dy = y - r.y, L = M.len2(dx, dy) || 1; let ts = -dy / L, ty = dx / L;
      if (Math.abs(ts) > 0.12) { if (ts * mv < 0) { ts = -ts; ty = -ty; } } else if (ty < 0) { ts = -ts; ty = -ty; }
      a.vs += (ts * RT.SWING + mv * RT.AIR) * dt; a.vy += ty * RT.SWING * dt;
    }
    const reelV = (r.len - len0) / dt;                            // < 0 while reeling in: the rope pulls the worm in (PoC L3801)
    const sp = M.len2(a.vs, a.vy); if (sp > RT.VMAX) { a.vs *= RT.VMAX / sp; a.vy *= RT.VMAX / sp; }
    let ns = s + a.vs * dt, ny = y + a.vy * dt;
    const dx = ns - r.s, dy = ny - r.y, L = M.len2(dx, dy);
    if (L > r.len) {
      ns = r.s + dx / L * r.len; ny = r.y + dy / L * r.len;
      const rv = (a.vs * dx + a.vy * dy) / L, lim = Math.min(0, reelV);
      if (rv > lim) { a.vs -= (rv - lim) * dx / L; a.vy -= (rv - lim) * dy / L; }
    }
    const base = P.overlap2(S, s, y);
    if (P.overlap2(S, ns, ny) <= base) { s = ns; y = ny; }
    else if (P.overlap2(S, ns, y) <= base) { s = ns; a.vy *= -0.3; }
    else if (P.overlap2(S, s, ny) <= base) { y = ny; a.vs *= -0.3; }
    else { a.vs *= -0.3; a.vy *= -0.3; }
    const ps = P.to_plane(S, a.pos).s, py = a.pos.y;
    setActive2D(S, a, s, y);
    // wrap around a corner the line to the pivot now cuts through
    if (r.pins.length < 50 && lineBlocked(S, r.s, r.y, s, y, 0.15, 0.3)) {
      const c = ropeCorner(S, r, ps, py, s, y);
      if (c) {
        const seg = M.len2(c.s - r.s, c.y - r.y), side = Math.sign((c.s - r.s) * (y - c.y) - (c.y - r.y) * (s - c.s)) || 1;
        if (seg > 0.2 && r.len - seg > C.ROPE_MIN * 0.5) { r.pins.push({ s: r.s, y: r.y, side }); r.fixed += seg; r.len -= seg; r.s = c.s; r.y = c.y; emit(S, 'rope_wrap', P.to_world(S, c.s, c.y)); }
      }
    }
    // unwrap: the worm swung back past the bend and sees the previous pivot again
    if (r.pins.length) {
      const q = r.pins[r.pins.length - 1], side = Math.sign((r.s - q.s) * (y - r.y) - (r.y - q.y) * (s - r.s));
      if (side && side !== q.side && !lineBlocked(S, q.s, q.y, s, y, 0.15, 0.3)) {
        const seg = M.len2(r.s - q.s, r.y - q.y); r.pins.pop(); r.fixed -= seg; r.len += seg; r.s = q.s; r.y = q.y;
      }
    }
  }

  function controlActive(S, a, dt, inp, retreat) {
    const mv = inp.move || 0, WP = SS.weapons;                 // (partial Input structs from tools / tests: 0)
    if (mv || inp.jump || inp.backflip || inp.fire_pressed || inp.drop) S.acted = true;     // (worm select: only before acting)
    // P2: weapon choice (only with ammo; locked after the first shotgun shot), fuse, strike side, girder angle, target
    // PoC: choosing Skip Go ends the turn at once (it never stays selected; the rope is kept if that option is on)
    if (!retreat && inp.weapon === 'skip') { log(S, `${a.name} skips the turn.`); sim.end_turn(S, 0.2); return; }
    if (!retreat && !S.charging && inp.weapon && C.WEAPONS[inp.weapon] && C.ARSENAL[inp.weapon] && !(S.shots > 0) && WP.can_use(S, inp.weapon)) S.weapon = inp.weapon;
    if (inp.fuse >= 1 && inp.fuse <= 5) S.fuse = inp.fuse | 0;
    if (inp.sdir) S.strikeDir = inp.sdir > 0 ? 1 : -1;
    if (inp.gang) S.girderA = ((S.girderA || 0) + (inp.gang > 0 ? 1 : -1) + C.ARMS.GIRDER.ANGLES) % C.ARMS.GIRDER.ANGLES;
    if (inp.tgt && Number.isFinite(inp.ts) && Number.isFinite(inp.ty)) S.tgt = { s: inp.ts, y: inp.ty };
    // aim: 1.5 rad/s up to +-90° (PoC L5154); the sniper aims finer when pointed at something near (features-ballistics)
    if (!S.rope) {
      const rate = S.weapon === 'sniper' ? sniperRate(S, a) : WD.AIM_RATE;
      if (inp.up) S.aim = Math.min(Math.PI / 2, S.aim + rate * dt); if (inp.down) S.aim = Math.max(-Math.PI / 2, S.aim - rate * dt);
      // PoC torch / drill: the torch aims within ±45°; pressing on down past -45° picks the drill (straight down), up
      // from there comes back to the torch at -45°
      if (S.weapon === 'drill' && (inp.up || inp.down)) { if (S.aim > Math.PI / 4) S.aim = Math.PI / 4; else if (S.aim < -Math.PI / 4 && S.aim > -Math.PI / 2 + 1e-3) S.aim = inp.down ? -Math.PI / 2 : -Math.PI / 4; else if (S.aim <= -Math.PI / 2 + 1e-3 && inp.up) S.aim = -Math.PI / 4; }
    }
    // mouse aim (PoC aimAt): only with the weapon ready, never for the girder (its keys turn it) or on the rope; the
    // torch / drill: pointing well below 45° picks the drill (straight down), anything else is the torch within ±45°
    if (inp.aimset && Number.isFinite(inp.aimv) && !S.rope && S.weapon !== 'girder' && sim.weapon_ready(S, a)) {
      let v = M.clamp(inp.aimv, -Math.PI / 2, Math.PI / 2);
      if (S.weapon === 'drill') v = v < -1.15 ? -Math.PI / 2 : M.clamp(v, -Math.PI / 4, Math.PI / 4);
      S.aim = v; if (inp.face) a.facing = inp.face > 0 ? 1 : -1;
    }
    if (retreat && inp.fire_pressed) WP.detonate_own(S);                     // PoC: fire again sets the sheep off
    // on the rope (PoC): Enter drops a payload weapon (else "cannot drop"), Space releases (no boost), Backspace hops
    // off the ground while still attached (ropeHop: only when grounded, 0.38 s cooldown, the rope pays out 1.54 m)
    if (S.rope && (inp.drop || inp.jump) && !retreat) {
      if (C.WEAPONS[S.weapon].payload && WP.can_use(S, S.weapon)) WP.rope_drop(S);
      else log(S, `Cannot drop the ${C.WEAPONS[S.weapon].name.toLowerCase()} from the rope.`, 0xffb27a);
    } else if (S.rope) {
      if (inp.fire_pressed) releaseRope(S);
      else if ((inp.backflip || (mv && inp.down)) && S.time - S.ropeHopT > RT.HOP_COOL && P.grounded2(S, P.to_plane(S, a.pos).s, a.pos.y)) {   // (PoC ropeStep: also arrow + down)
        const dir = mv || -a.facing;
        a.vy = Math.max(a.vy, RT.HOP_UP); a.vs += dir * RT.HOP_SIDE; a.air = true; S.ropeHopT = S.time; a.squash = S.time;
        S.rope.len = Math.min(Math.max(C.ROPE_MIN, C.ROPE_MAX - (S.rope.fixed || 0)), S.rope.len + RT.HOP_PAY);
        emit(S, 'jump', M.v3_copy(a.pos));
      }
      else {
        if (!S.rope.hooked && S.time - S.lastRotate > 0.25 && S.thetaGoal == null) reseatRope(S);
        if (S.rope) stepRope(S, a, dt, mv, inp.up, inp.down);
      }
    } else {
      if (S.hook) stepHook(S, a, dt);
      // PoC jumps (L3649-3664): Enter = forward jump, Backspace = back hop; Backspace again while the hop still rises
      // (within 0.5 s) = back salto (a flip; no weapon until it lands). No jump in the air, no steering in the air.
      if (!a.air && inp.jump) { a.vy = WD.JUMP_VY; a.vs = a.facing * WD.JUMP_VS; a.air = true; a.hop = false; a.slide = false; a.squash = S.time; emit(S, 'jump', M.v3_copy(a.pos)); }
      else if (!a.air && inp.backflip) { a.vy = WD.HOP_VY; a.vs = a.facing * WD.HOP_VS; a.air = true; a.hop = true; a.hopAt = S.time; a.slide = false; a.squash = S.time; emit(S, 'jump', M.v3_copy(a.pos)); }
      else if (a.air && inp.backflip && a.hop && S.time - a.hopAt < WD.SALTO_WIN && a.vy > WD.SALTO_VMIN) {
        a.vy = Math.max(a.vy, WD.SALTO_BASE) + WD.SALTO_ADD; a.vs = a.facing * WD.SALTO_VS; a.flip = true; a.flipAt = S.time; a.hop = false;
        emit(S, 'salto', { worm: a });
      }
      // no walking while charging a shot (PoC L5148)
      step2D(S, a, dt, a.air || S.charging ? 0 : mv);
      recoverPinned(S, a, dt);
      const kind = C.WEAPONS[S.weapon].kind, ready = sim.weapon_ready(S, a);
      if (retreat || S.teleT > 0) { /* P1 retreat: move, jump, keep swinging; no new attack */ }
      else if (S.weapon === 'rope') { if (inp.fire_pressed && !S.hook) sim.shoot_rope(S); }
      else if (kind === 'charge') {
        if (inp.fire_pressed && !S.charging && ready && WP.can_use(S, S.weapon) && !(C.WEAPONS[S.weapon].target && !S.tgt)) { S.charging = true; S.power = 0; }
        else if (inp.fire_pressed && C.WEAPONS[S.weapon].target && !S.tgt) log(S, 'Click a target first.', 0xffb27a);
        if (S.charging) {
          S.power = Math.min(1, S.power + dt / WD.CHARGE_T);
          // PoC releaseFire: a shot released while the worm is not ready (jumped, knocked, flipping) is cancelled, no ammo
          if (!inp.fire_held || S.power >= 1) { if (sim.weapon_ready(S, a)) sim.fire(S); else { S.charging = false; S.power = 0; } }
        }
      } else if (inp.fire_pressed && (ready || kind === 'drop' || kind === 'skip')) WP.use(S, 0);   // drops work anywhere (PoC)
    }
  }

  /* fire the charged weapon (UI, AI, timer); P2: every weapon goes through sim/weapons.js */
  sim.fire = function (S, power) { return SS.weapons.use(S, power); };

  /* P1: in-plane control of the active worm: its turn, or the retreat window after an attack */
  sim.ctl = (S, w) => w === S.active && (S.phase === 'play' || (S.phase === 'attack' && S.retreatT > 0));
  // the retreat ends (time, hurt, dead): the worm becomes a 3D body with its in-plane velocity
  sim.end_retreat = function (S) {
    S.retreatT = 0;
    const a = S.active; if (!a) return;
    const dd = P.dir(S);
    a.vel = { x: dd.x * a.vs * (a.air ? 1 : 0), y: a.air ? a.vy : 0, z: dd.z * a.vs * (a.air ? 1 : 0) }; a.rest = false;
    // PoC "keep ropes between turns": a hooked worm keeps hanging (world anchor + length; body3D swings it)
    if (S.settings.keepRope && S.rope && S.rope.hooked && !a.dead) { const p = P.to_world(S, S.rope.s, S.rope.y); a.rope = { x: p.x, y: p.y, z: p.z, len: S.rope.len }; }
    S.rope = null;
  };
  // end the turn now (input, timer, the active worm hurt): settle, then the next turn
  sim.end_turn = function (S, wait) {
    if (S.phase === 'play') { S.charging = false; S.power = 0; sim.end_retreat(S); S.phase = 'resolve'; S.resolveT = S.time - 0.8 + (wait || 0); }
  };

  /* ---------- projectiles: confined to the attack plane until they explode ---------- */
  function hitWorm(S, pt, p) {
    for (const w of S.worms) if (!w.dead && !(w === p.owner && p.age < 0.25) && M.v3_dist(pt, w.pos) < C.WORM_R + 0.12) return w;
    return null;
  }
  /* P32: a thrown / bouncing shell (grenade, cluster, banana, holy, dynamite...) does not pass through a worm: it hits
   * the soft body (a disc of WORM_R + the shell's radius about w.pos, in the plane, worms within WORM_R of it), bounces
   * off with most of its speed absorbed (restitution 0.15, then x0.5) and drops next to it; a hit faster than 3 m/s
   * into the body costs the worm 1 HP, once per shell and worm (p.hitW: bit mask of worm ids). Returns true on contact. */
  function wormBounce(S, p, def, ns, ny) {
    for (const w of S.worms) {
      if (w.dead || w.drowning || w.swim || (w === p.owner && p.age < 0.25)) continue;
      const q = P.to_plane(S, w.pos); if (Math.abs(q.t) > C.WORM_R) continue;
      const rr = C.WORM_R + (def.r || 0.06), ds = ns - q.s, dy = ny - w.pos.y, d2 = ds * ds + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2), ux = d > 1e-4 ? ds / d : 0, uy = d > 1e-4 ? dy / d : 1, vn = p.vs * ux + p.vy * uy;
      if (vn < 0) {
        p.vs -= 1.15 * vn * ux; p.vy -= 1.15 * vn * uy; p.vs *= 0.5; p.vy *= 0.5; p.bounces++;
        const bit = 1 << (w.id & 31);
        if (-vn > 3 && !((p.hitW | 0) & bit)) { p.hitW = (p.hitW | 0) | bit; const dd = P.dir(S); S.hitDir = { x: -ux * dd.x, y: -uy, z: -ux * dd.z }; hurt(S, w, 1, `a ${C.WEAPONS[p.type] ? C.WEAPONS[p.type].name.toLowerCase() : 'shell'} hit`); }
      }
      if (!P.solid2(S, q.s + ux * rr, w.pos.y + uy * rr)) { p.s = q.s + ux * rr; p.y = w.pos.y + uy * rr; }
      return true;
    }
    return false;
  }
  function removeProj(S, p) { const i = S.proj.indexOf(p); if (i >= 0) S.proj.splice(i, 1); S.lastBoom = S.time; }
  sim.surface_at = (S, x, z) => (SS.water && S.water ? SS.water.surface(S, x, z) : W().SEA);
  const wv = { x: 0, y: 0, z: 0 };
  function stepProjectiles(S, dt) {
    const w = W();
    const WP = SS.weapons;
    for (const p of S.proj.slice()) {
      if (S.proj.indexOf(p) < 0) continue;                      // (detonated by another one this step)
      p.age += dt;
      const def = C.PROJ[p.type] || C.WEAPONS[p.type];
      // P2: specials first (homing steering, napalm airburst, the walking sheep)
      const pre = WP.pre(S, p, dt);
      if (pre === 'gone') { removeProj(S, p); continue; }
      if (pre === true) continue;
      const wp0 = P.to_world(S, p.s, p.y);
      // wind (PoC stepProj L3396: a push of wind x 230 px/s2 x the shell's wind factor; PoC wind 1 = a storm's max ~
      // a 12 m/s gale here): in-plane component of the local air velocity only (the shot never leaves its plane); the
      // bouncing shells take no wind (windK 0), as in the PoC; whirlwind updrafts still lift a little
      const wk = (def.windK != null ? def.windK : 1) * (p.wk != null ? p.wk : 1);
      if (SS.weather && !p.wet && wk > 0) {
        SS.weather.wind_at(S, wp0.x, p.y, wp0.z, wv);
        const d = P.dir(S), ws = wv.x * d.x + wv.z * d.z;
        p.vs += ws / C.WIND_UNIT * C.WIND_ACC * wk * dt; p.vy += (wv.y - p.vy) * C.WIND_GAIN * wk * dt * 0.04;
      }
      if (def.drag) { const dr = M.exp(-def.drag * dt); p.vs *= dr; p.vy *= dr; }
      const gk = p.gk != null ? p.gk : 1, imp = !!def.impact && !(def.arm && p.age < def.arm);
      const n = Math.max(1, Math.ceil(M.len2(p.vs, p.vy) * dt / 0.06)), h = dt / n;
      let done = false;
      for (let i = 0; i < n && !done; i++) {
        if (p.wet) { const dr = M.exp(-2.6 * h); p.vs *= dr; p.vy = p.vy * dr - C.G * 0.55 * h; }
        else p.vy -= C.G * gk * h;
        const ns = p.s + p.vs * h, ny = p.y + p.vy * h, wp = P.to_world(S, ns, ny);
        if ((w.dry ? sim.arena_r(wp.x, wp.z) > DRY.FAR_R : wp.x < -OOB_SEA || wp.z < -OOB_SEA || wp.x > w.SX + OOB_SEA || wp.z > w.SZ + OOB_SEA) || ny < 0.2) {
          removeProj(S, p); log(S, `${C.WEAPONS[p.type].name} left the battlefield.`); done = true; break;
        }
        // dry worlds (D4): beyond the lattice W.sample is the analytic far dunes, so shots bounce / hit there as inside
        // Step I / P30: sea ice over the water. The speed INTO the ice decides (punching work, SS.ice.impact): a fast, steep
        // shell goes through (and goes off in the water under it), a gentle, shallow or vertical slow drop does not: a
        // rocket's contact fuse fires on the ice, a grenade bounces and skids on (ice: next to no friction)
        if (SS.ice && S.ice && !p.wet && !p.subm && !p.pierced && p.vy < 0) {
          const it = SS.ice.top_at(S, wp.x, wp.z);
          if (it > -1e8 && ny < it && p.y >= it - 0.08) {
            if (SS.ice.impact(S, wp.x, wp.z, def.mass || 0.6, -p.vy)) p.pierced = true;
            else if (imp) { WP.detonate(S, p, { x: wp.x, y: it + 0.05, z: wp.z }); removeProj(S, p); done = true; break; }
            else {
              // a real bounce, or (slow) it lies on the ice and skids on: next to no friction
              if (-p.vy > 1.5) { if (p.vy < -2) emit(S, 'bounce', { x: wp.x, y: it, z: wp.z, speed: -p.vy, mat: MAT.ICE }); p.vy = -p.vy * 0.45; p.bounces++; }
              else p.vy = 0;
              p.vs *= M.exp(-ICE_SKID * h); if (Math.abs(p.vs) < 0.05) p.vs = 0;
              p.y = it + 0.001; p.s = ns;
              continue;
            }
          }
        }
        const surf = sim.surface_at(S, wp.x, wp.z);
        if (p.subm && ny > surf) p.subm = false;
        if (!p.wet && !p.subm && ny < surf && p.vy < 0) {
          // water entry: the rocket's contact fuse fires on impact, a grenade plunges and keeps its fuse (P2: homing flies
          // on through the water, foam builds an island at the surface, fire fizzles)
          emit(S, 'splash', { x: wp.x, y: surf, z: wp.z, size: Math.min(1.6, 0.4 + M.len2(p.vs, p.vy) * 0.05), proj: 1 });
          if (SS.water) SS.water.disturb(S, wp.x, wp.z, 0.6, -0.25 * Math.min(1, M.len2(p.vs, p.vy) / 15));
          const r = WP.water(S, p, def, wp, surf);
          if (r === 'gone') { removeProj(S, p); done = true; break; }
          // (a shell that punched through ice goes off in the water under it: P30)
          if (r === 'burst') { WP.detonate(S, p, { x: wp.x, y: surf - (p.pierced ? M.clamp(SS.water ? SS.water.depth(S, wp.x, wp.z) * 0.6 : 0.6, 0.2, 0.8) : 0.15), z: wp.z }); removeProj(S, p); done = true; break; }
          if (def.impact) p.subm = true; else { p.wet = true; p.vs *= 0.35; p.vy *= 0.3; }
        }
        // open lava (2.6 t/m3, very viscous): the rocket's fuse fires on contact, a grenade floats on it and cooks off
        if (SS.lava && S.lava) {
          const lp = sim.lava_contact(S, wp.x, ny, wp.z, lc);
          if (lp.sub > 0 && !p.lava && p.vy < 0) {
            emit(S, 'lavaplop', { x: wp.x, y: lp.surf, z: wp.z, speed: M.len2(p.vs, p.vy) });
            if (def.foam || def.flame || def.homing) { emit(S, 'steam', { x: wp.x, y: lp.surf, z: wp.z, power: 0.4 }); removeProj(S, p); done = true; break; }
            if (imp) { WP.detonate(S, p, { x: wp.x, y: lp.surf, z: wp.z }); removeProj(S, p); done = true; break; }
            p.lava = true; p.vs *= 0.15; p.vy = 0;
          }
          if (p.lava) {
            if (lp.sub <= -0.3) p.lava = false;                                  // drifted off / lava gone
            else { const k = M.exp(-8 * h); p.vs *= k; if (lp.sub > 0) { p.y = lp.surf; p.vy = Math.max(0, p.vy) * k; p.hot += h * (0.4 + 1.6 * lp.heat); if (!P.solid2(S, ns, lp.surf)) p.s = ns; continue; } }
          }
        }
        let bi = S.planeBodies.length ? P.body_at2(S, ns, ny, true) : -1;
        if (bi >= 0 && S.planeBodies[bi].ice) bi = -1;            // Step I: the ice is handled above (before the water entry)
        const solid = P.solid2(S, ns, ny);
        if (imp && WP.crate_hit(S, p, wp)) { removeProj(S, p); done = true; break; }
        if (imp) {
          if (solid || bi >= 0 || hitWorm(S, wp, p)) { WP.detonate(S, p, wp); removeProj(S, p); done = true; }
          else { p.s = ns; p.y = ny; }
        } else if (!def.foam && wormBounce(S, p, def, ns, ny)) {
          continue;
        } else if (solid || bi >= 0) {
          const nn = bi >= 0 ? P.body_normal2(S, bi, ns, ny) : P.normal2(S, ns, ny), vn = p.vs * nn.s + p.vy * nn.y;
          if (vn < 0) {
            const mat = solid ? w.mat_at(wp.x, wp.y, wp.z) : 0;
            const soft = mat === MAT.SNOW || mat === MAT.SAND || mat === MAT.ASH ? 0.55 : mat === MAT.ICE ? 1.15 : 1;
            if (vn < -2) emit(S, 'bounce', { x: wp.x, y: wp.y, z: wp.z, speed: -vn, mat });
            const rest = def.rest != null ? def.rest : 0.4, fric = def.fric != null ? def.fric : 0.9;
            p.vs -= (1 + rest * soft) * vn * nn.s; p.vy -= (1 + rest * soft) * vn * nn.y;
            const fr = mat === MAT.ICE ? 0.98 : fric * soft + 0.1 * (1 - soft);
            p.vs *= fr; p.vy *= fr; p.bounces++;
            if (bi >= 0 && SS.bodies) { const dd = P.dir(S); SS.bodies.nudge(S, S.planeBodies[bi].ref, { x: -dd.x * nn.s, y: -nn.y, z: -dd.z * nn.s }, -vn * (def.mass || 0.6) * 1.4); }
            if (M.len2(p.vs, p.vy) < 0.8) { p.vs = 0; p.vy = 0; }
            if (mat === MAT.LAVA) p.hot += 0.35;
          }
          if (P.blocked2(S, p.s, p.y)) { p.s += nn.s * 0.05; p.y += nn.y * 0.05; }
        } else { p.s = ns; p.y = ny; }
      }
      if (done) continue;
      if (def.bouncy) {
        p.fuse -= dt;
        // resting in lava cooks the charge off
        const wpp = P.to_world(S, p.s, p.y);
        if (w.mat_at(wpp.x, p.y - 0.2, wpp.z) === MAT.LAVA) p.hot += dt;
        if (p.fuse <= 0 || p.hot > 0.5) { WP.detonate(S, p, P.to_world(S, p.s, p.y)); removeProj(S, p); }
      }
    }
  }

  /* ---------- damage ---------- */
  function hurt(S, w, dmg, why, quiet, dot) {
    if (w.dead || dmg <= 0) { S.hitDir = null; return; }        // (S.hitDir is set by the caller for this hit only)
    w.hp -= dmg;
    emit(S, 'hurt', { worm: w, amount: dmg, why, dir: S.hitDir || null });   // dir: where the hit pushed (blood sprays that way)
    w.hitDir = S.hitDir || null; S.hitDir = null;
    // P1 (PoC activeHurt): a hit on the active worm ends its turn / its retreat; so does FIRE (user 2026-10-08, PoC: napalm,
    // burning oil / grass / props); the poc5-only steady hazards (lava, hot sand, the black hole's core) do not
    if (w === S.active && !quiet && (!dot || /fire|oil|grass/.test(why || '')) && !w.dead) {
      if (S.phase === 'play') { S.charging = false; S.power = 0; S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; sim.end_retreat(S); log(S, `${w.name} got hurt: the turn ends.`, 0xffb27a); }
      else if (S.phase === 'attack' && S.retreatT > 0) sim.end_retreat(S);
    }
    const t = P.to_plane(S, w.pos).t;
    if (quiet) { /* steady hazards (hot sand) log once on entry, not per point */ }
    else if (Math.abs(t) > C.HALF) log(S, `${w.name} took ${dmg} off-section (${Math.abs(t).toFixed(1)} m from the plane).`, 0xff9a9a);
    else if (why) log(S, `${w.name} took ${dmg} from ${why}.`);
    // PoC death model: with blood on the worm bursts at once (its grave goes off in the dying beat); else it stays,
    // at 0 HP, until the aftermath settles, then dies in its own beat with a small blast (sim.step 'dying')
    if (w.hp <= 0) {
      w.hp = 0;
      if (S.settings.blood) { kill(S, w, 'gib'); w.gravePending = true; }
      else if (!w.dying) { w.dying = true; if (w === S.active && S.phase === 'play') { S.charging = false; S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; sim.end_retreat(S); } }
      if (S.phase === 'place') SS.game.flush_dying && SS.game.flush_dying(S);
    }
  }
  sim.hurt = hurt;
  /* continuous damage (fire, lava): accumulate, apply in whole points at most twice per second */
  sim.burn = function (S, w, dps, dt, why, quiet) {
    if (w.dead) return;
    if (!quiet) w.burnT = S.time;                      // presentation: flames on the worm while this keeps happening
    w.dmgAcc += dps * dt;
    if (w.dmgAcc >= 1 && S.time - w.dmgT > 0.5) { const n = Math.floor(w.dmgAcc); w.dmgAcc -= n; w.dmgT = S.time; hurt(S, w, n, why, quiet, true); }
  };
  sim.kill_now = (S, w, how) => { if (!w.dead) { kill(S, w, how); if (S.settings.blood) emit(S, 'gib', { worm: w, x: w.pos.x, y: w.pos.y, z: w.pos.z }); } };
  function kill(S, w, how) {
    // the grave: its BASE (ground contact) under the worm; it falls / settles in stepGraves (user 2026-10-08: graves
    // floated where a worm died in the air or once the ground under them was blown away)
    w.dead = true; w.hp = 0; w.dying = false; w.grave = { x: w.pos.x, y: w.pos.y - (w.foot || 0.5), z: w.pos.z, vy: 0, rest: false, landT: -1 };
    emit(S, 'kill', { worm: w, how: how || '' });
    // PoC slow motion: a kill by a big blast (R >= 30 px = W >= 0.32 kg) slows the action for 0.9 s (presentation)
    if (S.lastBlastT === S.time && S.lastBlastW >= 0.32) S.slowUntil = S.time + 0.9;
    if (how === 'gib') emit(S, 'gib', { worm: w, x: w.pos.x, y: w.pos.y, z: w.pos.z, dir: w.hitDir || null });
    log(S, `${w.name} is out.`, 0xff9a9a);
    if (w === S.active && S.phase === 'play') { S.phase = 'resolve'; S.resolveT = S.time; }
    if (w === S.active && S.retreatT > 0) sim.end_retreat(S);
  }
  function lost(S, w) {
    if (w.dead) return;
    log(S, `${w.name} wandered off into the open desert.`, 0xffb27a); kill(S, w); w.grave = null;
  }
  /* ---------- P33: in the water: swimming, struggling, back out ----------
   * (user 2026-10-08) A worm that falls in does not go under at once: it floats, struggling, losing SWIM_DPS HP/s.
   * Land (dry ground, or sea ice) within SWIM_R m and at most SWIM_CLIMB m above the water: it swims there and climbs
   * out (the active worm along the section only). No land in reach after SWIM_FLOAT_T s, too long swimming
   * (SWIM_MAX_T) or 0 HP: it drowns (the PoC sink, now resting on the bottom). Its turn ends as it falls in. */
  function landAt(S, x, z, surf) {
    const w = W(), i = Math.round(x / w.H), k = Math.round(z / w.H), WD = C.WORM_DYN;
    if (i < 1 || k < 1 || i >= w.NX - 1 || k >= w.NZ - 1) return -1e9;
    if (SS.ice && S.ice) { const it = SS.ice.top_at(S, x, z); if (it > -1e8) return it; }
    if (SS.water && S.water && SS.water.depth(S, x, z) > 0.004) return -1e9;
    if (SS.lava && S.lava && SS.lava.depth_at(S, x, z) > 0.01) return -1e9;
    const t = w.top[k * w.NX + i];
    return t >= surf - 0.4 && t <= surf + WD.SWIM_CLIMB ? t : -1e9;
  }
  function swimStart(S, w) {
    if (w.dead || w.drowning || w.swim) return;
    if (w.hp <= 0) { drown(S, w); return; }
    const WD = C.WORM_DYN, surf = sim.surface_at(S, w.pos.x, w.pos.z), d = P.dir(S), act = w === S.active;
    w.swim = { t0: S.time, acc: 0, tick: S.time, tx: 0, tz: 0, land: false, stuck: 0 };
    for (let r = 0.25; r <= WD.SWIM_R + 1e-6 && !w.swim.land; r += 0.25) for (let q = 0; q < (act ? 2 : 16); q++) {
      const ux = act ? (q ? -d.x : d.x) : M.cos(q * Math.PI / 8), uz = act ? (q ? -d.z : d.z) : M.sin(q * Math.PI / 8);
      const x = w.pos.x + ux * r, z = w.pos.z + uz * r;
      if (landAt(S, x, z, surf) > -1e8) { w.swim.tx = x; w.swim.tz = z; w.swim.land = true; break; }
    }
    w.vel.x = w.vel.y = w.vel.z = 0; w.rope = null; w.springFall = false; w.dying = false;
    if (act) { if (S.phase === 'play') { S.charging = false; S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; } if (sim.ctl(S, w)) sim.end_retreat(S); S.rope = null; S.hook = null; w.vs = w.vy = 0; w.air = false; w.vel.x = w.vel.y = w.vel.z = 0; }   // (end_retreat rebuilds vel from vs / vy)
    emit(S, 'splash', { x: w.pos.x, y: surf, z: w.pos.z, size: 1.2 });
    emit(S, 'swim', { worm: w, land: w.swim.land });
    log(S, w.swim.land ? `${w.name} fell in the water and swims for the shore!` : `${w.name} fell in the water, far from land...`, 0x7fc3ff);
  }
  // SWIM_DPS in SWIM_TICK chunks; returns false once it drowned. (No turn end: that happened as it fell in / a roping
  // worm keeps its turn.)
  function waterDamage(S, w, dt, acc) {
    const WD = C.WORM_DYN;
    acc.acc += WD.SWIM_DPS * dt;
    if (S.time - acc.tick < WD.SWIM_TICK || acc.acc < 1) return true;
    const n = Math.floor(acc.acc); acc.acc -= n; acc.tick = S.time;
    if (w.hp - n <= 0) { emit(S, 'hurt', { worm: w, amount: w.hp, why: 'drowning', dir: null }); w.hp = 0; w.swim = null; drown(S, w); return false; }
    hurt(S, w, n, 'drowning', true, true);
    return true;
  }
  function swimStep(S, w, dt) {
    const WD = C.WORM_DYN, sw = w.swim;
    // the swim is scripted: no velocity survives it (a blast's push, the fall) to fling the worm on climb-out or drift
    // it while it sinks; a swimmer holds the turn (the resolve gate waits on S.lastBoom too)
    w.vel.x = w.vel.y = w.vel.z = 0; w.vs = 0; w.vy = 0; S.lastBoom = S.time;
    if (!waterDamage(S, w, dt, sw)) return;
    const surf = sim.surface_at(S, w.pos.x, w.pos.z);
    const ty = surf - WD.FLOAT_D + 0.06 * M.sin((S.time - sw.t0) * 7);           // up to the surface, bobbing
    const fy = w.pos.y + M.clamp(ty - w.pos.y, -2 * dt, 1.5 * dt);
    if (!(fy < w.pos.y && blocked3(w.pos.x, fy, w.pos.z))) w.pos.y = fy;           // (resting on a shoal: not into it)
    if (sw.land) {
      const dx = sw.tx - w.pos.x, dz = sw.tz - w.pos.z, L = M.len2(dx, dz), st = Math.min(L, WD.SWIM_V * dt);
      const nx = L > 1e-4 ? w.pos.x + dx / L * st : w.pos.x, nz = L > 1e-4 ? w.pos.z + dz / L * st : w.pos.z;
      // a submerged slope: step up over it (shallower); a real wall (the bank) close by: climb out there. (Before, any
      // slope blocked the first step and the worm snapped up to SWIM_R onto the bank.)
      let bank = blocked3(nx, w.pos.y, nz);
      for (let up = 0.1; up <= 0.41 && bank; up += 0.1) if (!blocked3(nx, w.pos.y + up, nz)) { w.pos.y += up; bank = false; }
      if (!bank) { w.pos.x = nx; w.pos.z = nz; }
      sw.stuck = bank ? (sw.stuck || 0) + dt : 0;                                 // (wedged on an outcrop short of the bank)
      if ((bank && (L < 0.9 || sw.stuck > 0.6)) || L < 0.3) {                    // at the bank: climb out
        const surf2 = sim.surface_at(S, sw.tx, sw.tz), t = landAt(S, sw.tx, sw.tz, surf2 > -90 ? surf2 : surf);
        if (t > -1e8) {
          w.pos.x = sw.tx; w.pos.z = sw.tz; w.pos.y = t + w.foot + 0.02; w.swim = null;
          const left = Math.round(sw.acc); if (left > 0 && w.hp > left) hurt(S, w, left, 'drowning', true, true);   // the time in the water not billed yet
          w.vel.x = w.vel.y = w.vel.z = 0; w.vs = 0; w.vy = 0;
          if (w === S.active) w.air = true; else w.rest = false;
          emit(S, 'swimout', { worm: w }); log(S, `${w.name} crawled out of the water.`, 0x7fc3ff);
          return;
        }
      }
    }
    if (S.time - sw.t0 > (sw.land ? WD.SWIM_MAX_T : WD.SWIM_FLOAT_T)) { w.swim = null; drown(S, w); }
  }

  /* PoC drown (L3534 / L3559): the worm is lost at once (0 HP, its turn ends) but SINKS for 2.2 s at 26 px/s (1.67 m/s),
   * drifting on with its speed x 0.97 per step, then it is gone (no grave) */
  function drown(S, w) {
    if (w.dead || w.drowning) return;
    w.drowning = S.time; w.hp = 0; w.dying = false; w.springFall = false;
    if (w === S.active) { if (S.phase === 'play') { S.charging = false; S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; } if (sim.ctl(S, w)) sim.end_retreat(S); S.rope = null; S.hook = null; }
    w.rope = null; w.vel.y = 0;
    emit(S, 'splash', { x: w.pos.x, y: sim.surface_at(S, w.pos.x, w.pos.z), z: w.pos.z, size: 1.4 });
    emit(S, 'drown', { worm: w });
    log(S, `${w.name} sank into the sea.`, 0x7fc3ff);
  }
  // the ground under the water at x, z (the water bed; dry / beyond the lattice: the voxel top), for a sinking worm
  function bedAt(S, x, z) {
    if (SS.water && S.water) { const s = SS.water.surface(S, x, z); if (s > -90) return s - SS.water.depth(S, x, z); }
    const w = W(), i = Math.round(x / w.H), k = Math.round(z / w.H);
    return i >= 0 && k >= 0 && i < w.NX && k < w.NZ ? w.top[k * w.NX + i] : -1e9;
  }
  function sinkStep(S, w, dt) {
    const WD = C.WORM_DYN;
    w.pos.y -= WD.DROWN_V * dt; w.vel.x *= 0.97; w.vel.z *= 0.97;
    const fl = bedAt(S, w.pos.x, w.pos.z) + 0.3; if (w.pos.y < fl) { w.pos.y = fl; w.vel.x = w.vel.z = 0; }   // P33a: comes to rest on the bottom
    const nx = w.pos.x + w.vel.x * dt, nz = w.pos.z + w.vel.z * dt; if (!blocked3(nx, w.pos.y, nz)) { w.pos.x = nx; w.pos.z = nz; }
    if (S.time - w.drowning >= WD.DROWN_T) { w.drowning = 0; kill(S, w, 'drown'); w.grave = null; }
  }

  /* Explosion entry point. wp: weapon def ({W} TNT-equivalent kg; legacy {R} accepted). */
  sim.explode = function (S, c, wp, owner) {
    const Wkg = wp.W != null ? wp.W : M.pow((wp.R || 3) / 3, 3);
    S.lastBoom = S.time; S.lastExplosion = { x: c.x, y: c.y, z: c.z, R: 3 * M.cbrt(Wkg) }; S.lastBlastW = Wkg; S.lastBlastT = S.time;
    let ev;
    if (SS.blast) ev = SS.blast.explode(S, c, Wkg, { owner, kind: wp.name || 'blast', dmg: wp.dmg });
    else { W().carve(c.x, c.y, c.z, 3 * M.cbrt(Wkg)); ev = emit(S, 'explode', { x: c.x, y: c.y, z: c.z, R: 3 * M.cbrt(Wkg), W: Wkg }); }
    S.sectionDirty = true;
    S.fx.push({ x: c.x, y: c.y, z: c.z, t: 0 });
    if (SS.weapons) SS.weapons.blast(S, c, Wkg, wp.dmg);          // P2: devices, supply crates
    if (wp.frag && SS.shrapnel) SS.shrapnel.spawn(S, c, Wkg);       // X2: casing fragments (grenade, bazooka)
    return ev;
  };
  /* schedule a delayed explosion (chain reactions: barrels, mines) */
  sim.schedule = function (S, delay, c, Wkg, kind, src, dmg) { S.pending.push({ t: S.time + delay, c: M.v3_copy(c), W: Wkg, kind, src, dmg }); S.lastBoom = S.time; };

  /* ---------- inactive worms: 3D bodies ---------- */
  function blocked3(x, y, z) {
    const w = W();
    return w.sample(x, y, z) > 0 || w.sample(x + 0.4, y, z) > 0 || w.sample(x - 0.4, y, z) > 0 || w.sample(x, y, z + 0.4) > 0 || w.sample(x, y, z - 0.4) > 0;
  }
  // M / Step I: walkable surfaces that are not voxels: a bridge deck, sea ice (intact, under yTop + 0.05)
  const deckFloor = (S, x, y, z) => {
    let f = SS.struct ? SS.struct.floor_at(S, x, y, z) : -1e9;
    if (SS.ice && S.ice) { const t = SS.ice.top_at(S, x, z); if (t > f && t <= y + 0.05) f = t; }
    return f;
  };
  /* a kept rope (inactive worm): a 3D pendulum on the anchor; it drops when the anchor's rock is gone */
  function hangOnRope(S, b, dt) {
    const r = b.rope, w = W();
    if (w.sample(r.x, r.y, r.z) <= 0 && w.sample(r.x, r.y + 0.25, r.z) <= 0 && w.sample(r.x, r.y - 0.25, r.z) <= 0) { b.rope = null; b.rest = false; return false; }
    const n = 4, h = dt / n;
    for (let i = 0; i < n; i++) {
      b.vel.y -= GW * h; const k = M.exp(-0.4 * h); b.vel.x *= k; b.vel.y *= k; b.vel.z *= k;
      let nx = b.pos.x + b.vel.x * h, ny = b.pos.y + b.vel.y * h, nz = b.pos.z + b.vel.z * h;
      const dx = nx - r.x, dy = ny - r.y, dz = nz - r.z, d = M.len3(dx, dy, dz);
      if (d > r.len) {                                   // taut: back onto the sphere, drop the outward speed
        const ux = dx / d, uy = dy / d, uz = dz / d; nx = r.x + ux * r.len; ny = r.y + uy * r.len; nz = r.z + uz * r.len;
        const vr = b.vel.x * ux + b.vel.y * uy + b.vel.z * uz; if (vr > 0) { b.vel.x -= vr * ux; b.vel.y -= vr * uy; b.vel.z -= vr * uz; }
      }
      if (blocked3(nx, ny, nz)) { b.vel.x *= -0.3; b.vel.y *= -0.3; b.vel.z *= -0.3; continue; }
      b.pos.x = nx; b.pos.y = ny; b.pos.z = nz;
    }
    b.rest = false;
    return true;
  }
  function body3D(S, b, dt) {
    const w = W(), foot = b.foot;
    // LV3: afloat on open lava: ride the surface flow, held at the lava floor (never 'at rest': the lava moves)
    const lf0 = lavaFloor(S, b.pos.x, b.pos.z, b);
    if (lf0 > -1e8 && b.pos.y - foot < lf0 - C.LAVA.DEEP) {                  // deep in a lava column: rises slowly (viscous)
      b.rest = false; b.vel.x = b.vel.z = 0; b.vel.y = 0; b.pos.y = Math.min(lf0 + foot, b.pos.y + 1.5 * dt); return;
    }
    if (lf0 > -1e8 && b.pos.y - foot <= lf0 + 0.08 && b.vel.y <= 0.5) {
      if (b.vel.y < -2) emit(S, 'lavaplop', { x: b.pos.x, y: lf0 + (b.lsink || 0), z: b.pos.z, speed: -b.vel.y });
      b.rest = false; SS.lava.vel_at(S, b.pos.x, b.pos.z, lvv);
      const k = M.exp(-20 * dt);                                           // viscous capture of any slide
      b.vel.x = 1.5 * lvv.x + (b.vel.x - 1.5 * lvv.x) * k; b.vel.z = 1.5 * lvv.z + (b.vel.z - 1.5 * lvv.z) * k; b.vel.y = 0;
      const nx = b.pos.x + b.vel.x * dt, nz = b.pos.z + b.vel.z * dt;
      if (!blocked3(nx, b.pos.y, nz)) { b.pos.x = nx; b.pos.z = nz; } else { b.vel.x = b.vel.z = 0; }
      const lf1 = lavaFloor(S, b.pos.x, b.pos.z, b);
      if (lf1 > -1e8) b.pos.y = M.clamp(lf1 + foot, b.pos.y - 1.5 * dt, b.pos.y + 3 * dt);   // follows the surface (never jumps)
      return;
    }
    if (b.rope && hangOnRope(S, b, dt)) return;
    if (b.rest) { if (w.sample(b.pos.x, b.pos.y - foot - 0.06, b.pos.z) > 0 || Math.abs(deckFloor(S, b.pos.x, b.pos.y - foot, b.pos.z) - (b.pos.y - foot)) < 0.08) return; b.rest = false; }
    // PoC dynamics in 3D (worm gravity, head-on / glancing landings, dizziness, skids with bounce 0.3 / friction 0.72)
    const n = Math.max(1, Math.ceil(M.len3(b.vel.x, b.vel.y, b.vel.z) * dt / 0.08)), h = dt / n, nv = { x: 0, y: 0, z: 0 };
    let touched = false;
    for (let i = 0; i < n && !b.rest; i++) {
      b.vel.y -= GW * h;
      const nx = b.pos.x + b.vel.x * h, nz = b.pos.z + b.vel.z * h, ny = b.pos.y + b.vel.y * h;
      const lf = lavaFloor(S, nx, nz, b);
      if (b.vel.y <= 0 && lf > -1e8 && ny - foot <= lf && b.pos.y - foot > lf - C.LAVA.DEEP) {   // LV3: lands on lava (crossing its surface) and floats
        if (b.vel.y < -2) emit(S, 'lavaplop', { x: b.pos.x, y: lf + (b.lsink || 0), z: b.pos.z, speed: -b.vel.y });
        b.pos.x = nx; b.pos.z = nz; b.pos.y = lf + foot; b.vel.y = 0; b.vel.x *= 0.3; b.vel.z *= 0.3; b.slide = false; landHurt(S, b, 0); break;
      }
      const df = deckFloor(S, nx, b.pos.y - foot + 0.05, nz);                    // M: a bridge deck (a flat floor)
      let hit = false;
      if (b.vel.y <= 0 && df > -1e8 && ny - foot <= df) { nv.x = 0; nv.y = 1; nv.z = 0; hit = true; }
      else if (w.sample(nx, ny - foot, nz) > 0 || blocked3(nx, ny, nz)) {
        // the contact point: below the feet when falling onto ground, else the body's side
        if (w.sample(nx, ny - foot, nz) > 0) w.normal(nx, ny - foot, nz, nv); else w.normal(nx, ny, nz, nv);
        hit = true;
      }
      if (!hit) { b.pos.x = nx; b.pos.y = ny; b.pos.z = nz; continue; }
      touched = true;
      const vn = b.vel.x * nv.x + b.vel.y * nv.y + b.vel.z * nv.z;
      if (vn >= 0) { b.pos.x = nx; b.pos.z = nz; continue; }
      const imp = -vn, sp = M.len3(b.vel.x, b.vel.y, b.vel.z), tx = b.vel.x - vn * nv.x, ty = b.vel.y - vn * nv.y, tz = b.vel.z - vn * nv.z;
      const along = M.len3(tx, ty, tz) / Math.max(1e-6, sp);
      if (imp > WD.FALL_SAFE && nv.y > 0.2) {
        const head = along < WD.HEAD_ALONG, dmg = head ? Math.min(WD.HEAD_MAX, Math.round((imp - WD.FALL_SAFE) * WD.HEAD_K) + WD.HEAD_ADD) : Math.min(WD.GLANCE_MAX, Math.round((imp - WD.FALL_SAFE) * WD.GLANCE_K));
        emit(S, 'land', { worm: b, x: b.pos.x, y: b.pos.y - foot, z: b.pos.z, speed: imp, mat: w.mat_at(b.pos.x, b.pos.y - foot - 0.2, b.pos.z), hard: 1 });
        b.landDmg = dmg;                                                         // (applied after the rebound below)
        if (head) { const up = Math.min(WD.HEAD_UP_MAX, WD.HEAD_UP_K * imp); b.vel.x = nv.x * up; b.vel.y = nv.y * up; b.vel.z = nv.z * up; b.dizzyUntil = S.time + WD.DIZZY; b.squash = S.time; emit(S, 'dizzy', { worm: b }); }
        else { b.vel.x = tx * WD.FRIC - nv.x * vn * WD.BOUNCE; b.vel.y = ty * WD.FRIC - nv.y * vn * WD.BOUNCE; b.vel.z = tz * WD.FRIC - nv.z * vn * WD.BOUNCE; }
        b.slide = true;
        landHurt(S, b, b.landDmg);
      } else if (!b.slide && nv.y > WD.FIRM_NY) {                              // a firm landing stops dead
        if (imp > 3) emit(S, 'land', { worm: b, x: b.pos.x, y: b.pos.y - foot, z: b.pos.z, speed: imp, mat: w.mat_at(b.pos.x, b.pos.y - foot - 0.2, b.pos.z) });
        b.vel.x = b.vel.y = b.vel.z = 0; b.rest = true; b.stillT = 0; landHurt(S, b, 0);
      } else { b.vel.x = tx * WD.FRIC - nv.x * vn * WD.BOUNCE; b.vel.y = ty * WD.FRIC - nv.y * vn * WD.BOUNCE; b.vel.z = tz * WD.FRIC - nv.z * vn * WD.BOUNCE; }
      // stand on top of the ground (never inside it)
      let y = b.pos.y; for (let k = 0; k < 30 && (w.sample(b.pos.x, y - foot, b.pos.z) > 0 || (df > -1e8 && y - foot < df)); k++) y += 0.04;
      b.pos.y = y;
    }
    // a skidding worm comes to rest when slow and supported for 0.45 s (PoC still), or a soft touch
    if (!b.rest && touched) {
      const sp = M.len3(b.vel.x, b.vel.y, b.vel.z);
      if (sp < WD.STILL_V) { b.stillT = (b.stillT || 0) + dt; if (b.stillT > WD.STILL_T || (!b.slide && sp < WD.SOFT_V)) { b.vel.x = b.vel.y = b.vel.z = 0; b.rest = true; b.slide = false; b.stillT = 0; landHurt(S, b, 0); } }
      else b.stillT = 0;
    }
  }

  /* environmental hazards for every worm: water (waves, drowning), lava, fire */
  function hazards(S, wm, dt) {
    const w = W();
    const surf = sim.surface_at(S, wm.pos.x, wm.pos.z);
    if (wm.pos.y < surf - 0.1) {
      // P33c: on the ninja rope the worm stays in control under water (it can climb back out), losing SWIM_DPS
      if (wm === S.active && S.rope && S.rope.hooked) { if (!wm.ropeWet) wm.ropeWet = { acc: 0, tick: S.time }; waterDamage(S, wm, dt, wm.ropeWet); return; }
      swimStart(S, wm); return;
    }
    wm.ropeWet = null;
    if (SS.water && S.water && wm.pos.y - 0.5 < surf) {
      // a wave running over the worm: drag it along with the water
      const v = SS.water.vel(S, wm.pos.x, wm.pos.z, wv), sub = M.clamp((surf - (wm.pos.y - 0.5)) / 0.6, 0, 1), sp = M.len2(v.x, v.z);
      // PoC washWorms (L6283): a wave of >= 1.6 m/s (here 1.2: the shallow-water surge of a 0.7 m wave runs 1.5-1.7 m/s at
      // the waterline, the ambient swell never wets a beach worm) over the feet of a standing worm THROWS it along the flow
      // (vx = 70 + 0.8 v px/s, vy = 60 + 0.4 v up; it skids), at most every 1.2 s
      const WD = C.WORM_DYN, grounded = sim.ctl(S, wm) ? !wm.air : wm.rest;
      if (sub > 0.05 && sp >= WD.WASH_V && grounded && S.time - (wm.washT || -9) > WD.WASH_COOL) {
        const ux = v.x / sp, uz = v.z / sp, hv = WD.WASH_VS + WD.WASH_K * sp, vy = WD.WASH_VY + WD.WASH_KY * sp;
        if (sim.ctl(S, wm)) { const d = P.dir(S); wm.air = true; wm.vs = (ux * d.x + uz * d.z) * hv; wm.vy = vy; }
        else { wm.rest = false; wm.vel.x = ux * hv; wm.vel.z = uz * hv; wm.vel.y = vy; }
        wm.slide = true; wm.washT = S.time;
        emit(S, 'wash', { worm: wm, x: wm.pos.x, y: surf, z: wm.pos.z }); log(S, `A wave throws ${wm.name} off the shore!`, 0x7fc3ff);
      }
    }
    // dry worlds: lost far out in the open desert (beyond FAR_R; no blast throws a worm that far, a safety net)
    if (w.dry && sim.arena_r(wm.pos.x, wm.pos.z) > DRY.FAR_R) { lost(S, wm); return; }
    // dry worlds: the sand beyond the play area is hot (1 HP / 5 s while touching it; one log line per visit)
    if (w.dry && sim.arena_r(wm.pos.x, wm.pos.z) > S.playR && w.sample(wm.pos.x, wm.pos.y - wm.foot - 0.15, wm.pos.z) > 0) {
      if (!(S.time - wm.hotT < 2)) {
        emit(S, 'hotsand', { worm: wm, x: wm.pos.x, y: wm.pos.y, z: wm.pos.z });
        log(S, `${wm.name} is on hot sand: -1 HP every 5 s until back in the dunes' heart.`, 0xffb27a);
      }
      wm.hotT = S.time;
      sim.burn(S, wm, DRY.HOT_DPS, dt, 'hot sand', true);
    }
    const m = w.mat_at(wm.pos.x, wm.pos.y - 0.62, wm.pos.z);
    if (m === MAT.LAVA) sim.burn(S, wm, C.LAVA_DPS, dt, 'lava');
    // open lava (LV3): the worm floats. Its immersion relaxes toward the buoyancy equilibrium RHO_WORM / RHO of its
    // height, minus the share of its weight the skin's yield stress carries (cool crust holds it up), at a viscous
    // rate; it burns by immersion and temperature (a cold crust does not). Nothing light is engulfed any more.
    const LA = C.LAVA, dep = SS.lava && S.lava ? SS.lava.depth_at(S, wm.pos.x, wm.pos.z) : 0;
    if (dep > 0.01 && wm.pos.y - wm.foot <= lavaFloor(S, wm.pos.x, wm.pos.z, wm) + 0.1) {     // resting on the lava
      const T = SS.lava.temp_at(S, wm.pos.x, wm.pos.z), cool = M.clamp(1 - T, 0, 1);
      const yl = LA.YIELD * M.exp(LA.YIELD_K * cool), sup = M.clamp(LA.RHO * yl / (LA.RHO_WORM * C.WORM_H), 0, 1);
      const eq = Math.min(dep, LA.RHO_WORM / LA.RHO * C.WORM_H * (1 - sup)), tau = LA.SINK_TAU * M.exp(LA.NU_K * cool);
      wm.lsink = (wm.lsink || 0) + (eq - (wm.lsink || 0)) * Math.min(1, dt / tau);
    } else wm.lsink = 0;
    const lv = sim.lava_contact(S, wm.pos.x, wm.pos.y - wm.foot, wm.pos.z, lc);
    if (lv.sub > 0 && lv.heat > 0) sim.burn(S, wm, C.LAVA_DPS * lv.heat * (0.5 + M.clamp(lv.sub / 0.4, 0, 1)), dt, 'lava');
    // burning grass (same once-per-step rule as scatter's scorch: oil + grass do not stack)
    if (SS.veg && SS.veg.fire_at(S, wm.pos.x, wm.pos.y, wm.pos.z) > 0) {
      const k = S.tick;
      if (wm.fireStep !== k) { wm.fireStep = k; wm.fireT = S.time; sim.burn(S, wm, C.FIRE_DPS, dt, 'burning grass'); }
    }
  }

  function settled(S) {
    if (S.pending.length) return false;
    if (!S.worms.every(w => w.dead || (!w.drowning && !w.swim && (w.rest || (w === S.active && !w.air) || (w.rope && M.len3(w.vel.x, w.vel.y, w.vel.z) < 0.4))))) return false;
    if (S.hook) return false;
    if (SS.bodies && !SS.bodies.settled(S)) return false;
    if (SS.scatter && !SS.scatter.settled(S)) return false;
    if (SS.shrapnel && !SS.shrapnel.settled(S)) return false;
    if (SS.spatter && !SS.spatter.settled(S)) return false;
    if (SS.weapons && !SS.weapons.settled(S)) return false;
    if (fire_active(S)) return false;
    return S.fx.length === 0;
  }
  /* P29 (user 2026-10-08: "the round ends before the napalm damage is done"): the turn stays open while fire can
   * still hurt: a napalm / oil / car flame burns, or a worm burned within FIRE_HOLD s (w.fireT: flames, oil, burning
   * grass ON the worm). A grass / tree fire that touches no worm does not hold it (it can creep for a long time: the
   * lockstep test waited out the 16 s cap for one). Lava and hot sand are steady hazards: they never hold the turn.
   * Bounded by the SETTLE_CAP since the last blast, like everything else. */
  const FIRE_HOLD = 0.7;
  function fire_active(S) {
    if (S.flames.length) return true;
    for (const w of S.worms) if (!w.dead && S.time - w.fireT < FIRE_HOLD) return true;
    return false;
  }
  sim.fire_active = fire_active;

  /* PoC dying beat (afterSettle / 'dying'): one at a time, a pending grave goes off (blood on: R 26 px = W 0.21 kg) or a
   * worm at 0 HP dies with its own small blast (R 24 px = W 0.16 kg) and leaves a grave; the blast may hurt others, so
   * the aftermath settles again and the next beat (or turn) follows. */
  const DIE = { BEAT: 1.1, GRAVE_BEAT: 1.0, W_WORM: M.pow(24 / 44, 3), W_GRAVE: M.pow(26 / 44, 3), D_WORM: 16, D_GRAVE: 18 };   // PoC explode(.., 24, 16) / (.., 26, 18)
  function beginDying(S) {
    const g = S.worms.find(w => w.dead && w.gravePending);
    if (g) { S.phase = 'dying'; S.dyingW = g; S.dyingT = DIE.GRAVE_BEAT; S.dyingGrave = true; return true; }
    const d = S.worms.find(w => !w.dead && w.dying);
    if (d) { S.phase = 'dying'; S.dyingW = d; S.dyingT = DIE.BEAT; S.dyingGrave = false; emit(S, 'dying', { worm: d }); return true; }
    return false;
  }
  function stepDying(S, dt) {
    S.dyingT -= dt;
    if (S.dyingT > 0) return;
    const w = S.dyingW; S.dyingW = null;
    if (S.dyingGrave) { w.gravePending = false; if (w.grave) { w.grave.landT = -1; w.grave.blown = true; } if (w.grave) sim.explode(S, { x: w.grave.x, y: w.grave.y + 0.2, z: w.grave.z }, { W: DIE.W_GRAVE, dmg: DIE.D_GRAVE, name: 'an exploding grave' }, null); }
    else { const c = { x: w.pos.x, y: w.pos.y, z: w.pos.z }; kill(S, w, 'beat'); sim.explode(S, c, { W: DIE.W_WORM, dmg: DIE.D_WORM, name: 'a dying worm' }, null); }
    S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; S.retreatT = 0;
  }
  /* graves are small falling objects: they drop (worm gravity), land on the ground / a deck / the sea floor, sit 6 cm sunk in
   * the soil, and fall again when the ground under them is blown away */
  function stepGraves(S, dt) {
    const w = W();
    for (const o of S.worms) {
      const g = o.grave; if (!o.dead || !g) continue;
      if (g.rest) {
        const df = deckFloor(S, g.x, g.y + 0.1, g.z);
        if (w.sample(g.x, g.y - 0.12, g.z) > 0 || Math.abs(df - g.y) < 0.12) continue;
        g.rest = false; g.vy = 0;
      }
      const wet = g.y < sim.surface_at(S, g.x, g.z);
      g.vy = Math.max(wet ? -1.5 : -45, g.vy - C.G_WORM * dt);   // the worms' (PoC) gravity: at 9.81 it looked weightless next to them
      const n = Math.max(1, Math.ceil(Math.abs(g.vy) * dt / 0.05)), h = dt / n;
      for (let i = 0; i < n && !g.rest; i++) {
        const ny = g.y + g.vy * h, df = deckFloor(S, g.x, g.y + 0.05, g.z);
        if (df > -1e8 && ny <= df) { g.y = df; g.rest = true; break; }
        if (w.sample(g.x, ny + 0.06, g.z) > 0 || ny < 0.3) {          // ground: settle with the base 6 cm in the soil
          let y = Math.max(ny, 0.3); for (let k = 0; k < 40 && w.sample(g.x, y + 0.06, g.z) > 0; k++) y += 0.05;
          g.y = y; g.rest = true; break;
        }
        g.y = ny;
      }
      // landT: settled for good (no charge left on it): the plants grow from then (user: only after the grave blast)
      if (g.rest) { g.vy = 0; if (g.landT < 0 && !o.gravePending) g.landT = S.time; }
    }
  }
  /* P29l: on wet worlds a shot flies on over the open sea (beyond the lattice the world samples as air, the sea surface
   * is W.SEA) and splashes / blasts in the water like inside; it is dropped only this far out (it was 6 m: shells vanished
   * just off the coast without a splash) */
  const OOB_SEA = 120;
  const ICE_SKID = 0.25;         // 1/s: a shell skidding on bare sea ice slows this little (P30)
  sim.die_now = function (S, w) { if (w.dead) return; const c = { x: w.pos.x, y: w.pos.y, z: w.pos.z }; kill(S, w, 'beat'); sim.explode(S, c, { W: DIE.W_WORM, dmg: DIE.D_WORM, name: 'a dying worm' }, null); };
  const NOINPUT = sim.input_make();
  /* ---------- main fixed step ---------- */
  sim.step = function (S, inp, dt) {
    S.tick++; S.time += dt;       // tick: the integer step count (stagger keys, once-per-step guards; exact in a port)
    let a = S.active;
    // 9a: a CPU team's worm is driven by sim/ai.js (deterministic; the human input is ignored on its turn)
    if (S.phase === 'play' && a && !a.dead && SS.ai && SS.game.is_cpu(S, a.team)) inp = Object.assign({ rotate: 0, rotate_mouse: 0 }, SS.ai.control(S, a, dt));
    if (inp.reset) { sim.reset(S, S.settings); return; }
    if (S.phase === 'place') {                                    // P13: deployment (the world runs, worms are placed)
      if (inp.rotate || inp.rotate_mouse) sim.rotate_by(S, (inp.rotate + inp.rotate_mouse) * (inp.fine ? 0.25 : 1) * C.ROT_SPEED * dt);
      SS.game.place_step(S, inp, dt);                             // (the world steps below; control needs 'play')
    }
    if (S.phase === 'play' && a && !a.dead) {
      if (inp.align_step) sim.align_next(S, inp.align_step);
      if (inp.align_refocus) sim.align_to(S, S.target);
      if (inp.align_id) sim.align_to(S, S.worms.find(w => w.id === inp.align_id - 1));
      if (inp.end_turn) { log(S, `${a.name} ends the turn.`); sim.end_turn(S, 0.3); }
      // P34: re-read the active worm after a switch: the old one must not be driven in the new worm's section (its
      // plane (s, y) mapped onto the new plane teleported it tens of metres, into a river on volcanic 6721)
      if (inp.wsel && sim.switch_worm(S)) a = S.active;
    } else if (inp.align_step || inp.align_refocus || (inp.rotate && S.phase !== 'over')) locked(S);
    let rot = 0;
    if (S.phase === 'play') rot = inp.rotate + inp.rotate_mouse;
    if (S.thetaGoal != null && S.phase === 'play') {
      const diff = M.wrap_angle(S.thetaGoal - S.theta), st = C.ALIGN_SPEED * dt;
      if (Math.abs(diff) <= st) { sim.rotate_by(S, diff); S.thetaGoal = null; } else if (!sim.rotate_by(S, Math.sign(diff) * st)) S.thetaGoal = null;   // (window edge, D6)
    }
    if (rot) { S.thetaGoal = null; sim.rotate_by(S, rot * (inp.fine ? 0.25 : 1) * C.ROT_SPEED * dt); }

    // world subsystems
    if (SS.weather) SS.weather.step(S, dt);
    if (SS.bodies) SS.bodies.plane_sections(S);
    if (SS.trees) SS.trees.plane_sections(S);
    if (SS.struct) SS.struct.plane_sections(S);
    if (SS.ice) SS.ice.plane_sections(S);
    // PoC worm-worm contacts: the other worms near the section are solid discs for the active worm (it is blocked by
    // them, stands on them, climbs over them, lands on their heads); projectiles ignore these discs (worm hits are
    // their own test)
    for (const o of S.worms) {
      if (o.dead || o === S.active || o.drowning || o.swim) continue;
      const q = P.to_plane(S, o.pos); if (Math.abs(q.t) > C.WORM_R) continue;
      S.planeBodies.push({ s: q.s, y: o.pos.y, kind: 0, r: C.WORM_R, ref: null, worm: o });
    }
    if (S.phase === 'play' && a && !a.dead && !a.swim) controlActive(S, a, dt, inp, false);
    else if (S.phase === 'attack' && S.retreatT > 0 && a && !a.dead && !a.swim && !S.dig) controlActive(S, a, dt, SS.game.is_cpu(S, a.team) ? NOINPUT : inp, true);
    SS.game.step(S, dt);
    stepProjectiles(S, dt);
    if (SS.weapons) SS.weapons.step(S, dt);                       // P2: holes, planes, lightning, moai, dig, bullets, devices, crates
    if (SS.shrapnel) SS.shrapnel.step(S, dt);
    if (SS.spatter) SS.spatter.step(S, dt);
    for (let i = S.pending.length - 1; i >= 0; i--) {
      const e = S.pending[i];
      if (S.time >= e.t) { S.pending.splice(i, 1); sim.explode(S, e.c, { W: e.W, dmg: e.dmg, name: e.kind }, null); }
    }
    if (SS.bodies) SS.bodies.step(S, dt);
    stepGraves(S, dt);
    if (SS.scatter) SS.scatter.step(S, dt);
    if (SS.water) SS.water.step(S, dt);
    if (SS.ice) SS.ice.step(S, dt);
    if (SS.veg) SS.veg.step(S, dt);
    if (SS.lava) SS.lava.step(S, dt);
    for (const w of S.worms) {
      if (w.dead) continue;
      if (w.drowning) { sinkStep(S, w, dt); continue; }
      if (w.swim) { swimStep(S, w, dt); continue; }
      if (!sim.ctl(S, w)) body3D(S, w, dt);
      hazards(S, w, dt);
    }
    for (let i = S.fx.length - 1; i >= 0; i--) { S.fx[i].t += dt; if (S.fx[i].t > 0.65) S.fx.splice(i, 1); }
    // PoC settle (L5107): the next beat once everything has been quiet for 0.6 s in a row (16 s at most)
    if (S.phase === 'attack' && !(S.retreatT > 0)) {
      const quiet = !S.proj.length && !SS.weapons.busy(S) && settled(S);
      S.quietT = quiet ? S.quietT + dt : 0;
      if (S.quietT >= C.WORM_DYN.SETTLE_QUIET || S.time - S.lastBoom > C.WORM_DYN.SETTLE_CAP) { S.phase = 'resolve'; S.resolveT = S.time - 0.6; S.quietT = 0; }
    } else S.quietT = 0;
    if (S.phase === 'resolve' && S.time - S.resolveT > 0.8) {
      // something moved again during the wait (a trap, a late blast): settle first (PoC startTurn waits for landings)
      if (!settled(S) && S.time - S.lastBoom < 10) { S.phase = 'attack'; S.lastBoom = S.time; S.retreatT = 0; }
      else if (!beginDying(S)) sim.next_turn(S);
    }
    if (S.phase === 'dying') stepDying(S, dt);
    // Surrounding world: revealed while rotating, faded out a few seconds after rotation stops.
    const want = S.time - S.lastRotate < C.CTX_HOLD ? 1 : 0;
    S.ctx += M.clamp(want - S.ctx, -dt / C.CTX_FADE, dt / 0.25);
    S.inspect += M.clamp((inp.inspect ? 1 : 0) - S.inspect, -dt / 0.35, dt / 0.35);
  };
})(window.SS = window.SS || {});
