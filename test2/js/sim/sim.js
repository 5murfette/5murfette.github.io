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
  // the fields of the struct in declaration order (C: struct Input; input_copy is a plain struct assignment there)
  const INPUT_FIELDS = ['move', 'up', 'down', 'jump', 'backflip', 'fire_pressed', 'fire_held', 'weapon', 'rotate', 'rotate_mouse', 'fine', 'align_step', 'align_crate', 'align_refocus', 'align_id',
    'end_turn', 'reset', 'inspect', 'fuse', 'tgt', 'ts', 'ty', 'sdir', 'gang', 'gturn', 'drop', 'wsel', 'aimset', 'aimv', 'face', 'adj', 'gear', 'dbk', 'dbp0', 'dbp1', 'dbs', 'dby', 'dbsky'];
  sim.INPUT_FIELDS = INPUT_FIELDS;
  /* reset an Input struct to its defaults in place (the CPU reuses one struct per step: no allocation) */
  sim.input_clear = inp => { for (let i = 0; i < INPUT_FIELDS.length; i++) inp[INPUT_FIELDS[i]] = 0; inp.weapon = ''; return inp; };
  sim.input_copy = (dst, src) => { for (let i = 0; i < INPUT_FIELDS.length; i++) dst[INPUT_FIELDS[i]] = src[INPUT_FIELDS[i]]; return dst; };
  sim.input_make = () => ({
    move: 0, up: 0, down: 0,          // held axes
    jump: 0, backflip: 0, jet: 0,     // edge-triggered (jet: P86, the team's jetpack switch in space)
    fire_pressed: 0, fire_held: 0,
    weapon: '',                       // '' or weapon key to select
    rotate: 0, rotate_mouse: 0, fine: 0,
    align_step: 0, align_crate: 0, align_refocus: 0, align_id: 0, end_turn: 0, reset: 0, inspect: 0,  // align_id = worm id + 1 (top map click)
    // P2 (PoC arsenal): fuse 1-5 (0 = unchanged); tgt = 1 sets the target point (ts, ty) in plane coords (target
    // weapons fire on it when fire_pressed comes with it; homing keeps it); sdir -1 / 1 strike side; gang +-1 girder
    // angle step; drop = drop the selected weapon from the rope
    fuse: 0, tgt: 0, ts: 0, ty: 0, sdir: 0, gang: 0, gturn: 0, drop: 0,
    wsel: 0,                          // PoC worm select: switch to the team's next worm (option, first 10 s)
    aimset: 0, aimv: 0, face: 0,      // PoC mouse aim: set the aim angle (rad) and facing (-1 / 1) from the cursor
    gear: 0,                          // P89: toggle the active team's rescue gear kind + 1 (sim/gear.js: 1 = life jacket)
    adj: 0,                           // P37: + / - step (+1 / -1) of the selected weapon's parameter: fuse 0.5-5 s, mortar burst height 1-5 m, planted mine fuse 0-3 s
    // P49 debug toolbox (sim/debug.js; obeyed only while S.debugOn, never online): dbk = drop kind (DB.KIND, 0 none), dbp0 / dbp1 = its parameters, (dbs, dby) = the clicked point on the section, dbsky = 1 drop from the sky
    dbk: 0, dbp0: 0, dbp1: 0, dbs: 0, dby: 0, dbsky: 0
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
    return { S: structuredClone(S), d: w.d.slice(), mat: w.mat.slice(), heat: w.heat.slice(), top: w.top.slice(), topJ: w.topJ.slice(), crack: w.crack ? w.crack.slice() : null, sx: w.SX, sea: w.SEA, ver: w.version, dirty };   // R7-OK (replay snapshot: platform helper, never in a step)
  };
  sim.restore = function (S, snap) {
    const w = W(), c = structuredClone(snap.S);   // R7-OK
    for (const k of Object.keys(S)) if (!(k in c)) delete S[k];   // R7-OK
    Object.assign(S, c);
    if (snap.sx && snap.sx !== w.SX) w.resize(snap.sx, snap.sx);                  // P38: a snapshot of a map of another size
    w.d.set(snap.d); w.mat.set(snap.mat); w.heat.set(snap.heat); w.top.set(snap.top); w.topJ.set(snap.topJ); w.SEA = snap.sea;
    w.crack = snap.crack ? snap.crack.slice() : null; if (SS.cracks) SS.cracks.bump(w);   // P66b   // (sudden death raises the sea)
    // quiet: the renderers rebuild everything, the sim modules get their own pending rects back (a whole-lattice
    // refresh re-derived every water column and the replay's water / floes drifted off the live run: review P36)
    w.mark_all(true); S.verBase = (S.verBase || 0) + (w.version - snap.ver);   // hash: version - verBase unchanged
    for (const m of DIRTY_MODS) if (SS[m] && SS[m].dirty_set) SS[m].dirty_set(snap.dirty ? snap.dirty[m] : null);
    S.sectionDirty = true;
  };
  /* the hash accumulator: ONE module-level u32 (C: static u32 HH) and a plain function; the sub-module hash(S, mix) calls receive `mix` (no closure over a local) */
  let HH = 0;
    // quantise to 1/1000: floor(v * 1000 + 0.5) (round half UP, the same in C: floorf), wrapped to an i32 by modular arithmetic
    // (no UB beyond +-2^31 in C), and NaN / +-Inf mix their own constants (before: NaN became 0 and hid a NaN desync)
  const mix = v => {
      let q = Math.floor(v * 1000 + 0.5);
      if (q !== q) q = 0x7fc00001; else if (q === Infinity) q = 0x7f800001; else if (q === -Infinity) q = 0x7f800003;
      else q = (q - 4294967296 * Math.floor(q / 4294967296)) | 0;
      HH = Math.imul(HH ^ q, 16777619) >>> 0;
    };

  sim.hash = function (S) {
    HH = 2166136261;
    mix(S.time); mix(S.turnNo || 0); mix(S.rng ? S.rng.s : 0); mix(W().version - (S.verBase || 0)); mix(S.theta);   // version counts across resets: relative
    for (const w of S.worms) { mix(w.pos.x); mix(w.pos.y); mix(w.pos.z); mix(w.hp); }
    for (const b of S.bodies) { mix(b.pos.x); mix(b.pos.y); mix(b.pos.z); }
    for (const p of S.proj) { mix(p.s); mix(p.y); }
    // P38 R1: the weapons.js lists too (a desync in a device, a hole, a plane, a bullet, a zap, a crate, a moai or a fragment showed late)
    if (S.devices) for (const d of S.devices) { mix(d.pos.x); mix(d.pos.y); mix(d.pos.z); mix(d.hp); mix(d.charges); mix(d.t); }
    if (S.holes) for (const q of S.holes) { mix(q.x); mix(q.y); mix(q.z); mix(q.t); }
    if (S.strikes) for (const q of S.strikes) { mix(q.s); mix(q.y); mix(q.k); }
    if (S.bullets) for (const q of S.bullets) { mix(q.s); mix(q.y); mix(q.vs); mix(q.vy); }
    if (S.zaps) for (const q of S.zaps) { mix(q.t); mix(q.s); }
    if (S.moais) for (const q of S.moais) { const mb = SS.bodies.by_id(S, q.body); mix(mb ? mb.pos.y : 0); mix(q.smash); }
    if (S.crates) for (const q of S.crates) { mix(q.pos.x); mix(q.pos.y); mix(q.pos.z); mix(q.landed ? 1 : 0); }
    if (S.frags) { mix(S.frags.length); for (const q of S.frags) { mix(q.x); mix(q.y); mix(q.z); } }
    if (S.wa) {                                                       // P37-W3: weapons A
      const wa = S.wa; mix(wa.rng.s % 100003); mix(wa.stream ? wa.stream.t : -1); mix(wa.spots.length); mix(wa.acid.length); SS.weaponsA.hash_ws(S, mix);
      for (const c of wa.clouds) { mix(c.x); mix(c.y); mix(c.z); mix(c.r); if (c.pf) mix(c.pf[c.pf.length - 6]); }
      for (const b of wa.boom) { mix(b.s); mix(b.y); mix(b.vs); mix(b.vy); }
      for (const r of wa.ravens) { mix(r.s); mix(r.y); }
      for (const l of wa.letters) { mix(l.s); mix(l.y); }
      for (const w of S.worms) { mix(w.gas || 0); mix(w.stickT || 0); }
    }
    if (SS.gadgets && S.dogs) SS.gadgets.hash(S, mix);                         // P37 W4: dogs, sentries, claymores, ...
    if (SS.ffield && S.ffields) SS.ffield.hash(S, mix);
    if (SS.weather && S.weather && SS.weather.hash) SS.weather.hash(S, mix);   // P65a: wind, whirlwind life cycle, respawn queue
    if (SS.skills && S.skRng) SS.skills.hash(S, mix);
    if (S.eow) SS.eow.hash(S, mix);                                            // P86: jetpack charges / switches, free crates' drift (End of the World only)
    if (SS.lab && S.lab) SS.lab.hash(S, mix);                                  // P42: only with a Lab flag on (baseline hashes unchanged)
    // (review P36: the fluid / ice state too, so a divergence there shows before it moves a worm; a sum per field,
    // every HASH_EVERY steps in a match: ~40k cells each)
    for (const w of S.worms) { mix(w.swim ? 1 : 0); mix(w.iceV || 0); }
    const sum = a => { let t = 0; for (let i = 0; i < a.length; i++) t += a[i]; return t; };
    if (S.water) { mix(sum(S.water.h)); mix(S.water.pend.length); }
    if (S.ice) { mix(sum(S.ice.h)); mix(sum(S.ice.snow)); mix(S.ice.floes.length); mix(S.ice.waves.length); for (const f of S.ice.floes) { mix(f.x); mix(f.z); } }
    if (S.lava) { mix(sum(S.lava.h)); mix(sum(S.lava.T)); }
    if (S.alien && SS.alien) SS.alien.hash(S, mix);              // P37 / P47: eggs, face huggers, the parasite, aliens, acid
    /* P38 D6 (coverage found by the round-4 review, silent.cjs): the turn machine and the weapon state, per-team ammo,
     * worm motion / facing / base HP, the sim-relevant settings, and strided sums of the voxel arrays themselves (before:
     * only the version counter, so a different crater with the same number of edits passed). */
    const str = v => { v = String(v); let t = 7; for (let i = 0; i < v.length; i++) t = Math.imul(t ^ v.charCodeAt(i), 16777619); return t >>> 0; };
    HH = Math.imul(HH ^ str(S.phase), 16777619) >>> 0; HH = Math.imul(HH ^ str(S.weapon), 16777619) >>> 0;
    mix(S.round || 0); mix(S.sdRound || 0); mix(S.sudden ? 1 : 0); mix(S.sdFinal || 0); if (S.sudden) mix(S.sdAcc || 0); mix(S.aim || 0); mix(S.power || 0); mix(S.charging ? 1 : 0); mix(S.shots || 0); mix(S.fuse || 0);
    mix(S.active ? S.active.id : -1);
    if (SS.gear) SS.gear.hash(S, mix);                                         // P89: rescue gear (only once a charge was used / a toggle changed: baseline hashes unchanged)
    if (S.teams) for (const t of S.teams) if (t.ammo) for (const k of C.ARSENAL_ORDER) { const v = t.ammo[k]; mix(v === Infinity ? -7 : v || 0); }
    for (const w of S.worms) { mix(w.vel.x); mix(w.vel.y); mix(w.vel.z); mix(w.vs || 0); mix(w.vy || 0); mix(w.facing || 0); mix(w.hp0 || 0); mix(w.air ? 1 : 0); mix(w.dead ? 1 : 0); }
    if (S.settings) for (const k of HASH_SETTINGS) { const v = S.settings[k]; mix(typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' ? str(v) % 1000003 : -1); }
    if (S.settings) for (const k of C.CRATES.SLIDERS) { const v = S.settings[k]; if (v != null && v !== C.CRATES.DEF) { mix(2100); mix(v); } }   // P84: crate levels (at the default: the hashes stay what they were)
    if (S.settings && S.settings.fort) mix(2003);                          // P68b: fort mode (off: the hashes stay what they were)
    if (S.settings && S.settings.dim === '2d') mix(2002);                  // P68a: the dimension, only while it is 2D (3D hashes stay what they were)
    { const wd = W(), d = wd.d, mt = wd.mat; let t = 0, u = 0; for (let i = 0; i < d.length; i += 97) t += d[i]; for (let i = 3; i < mt.length; i += 101) u += mt[i]; mix(t); mix(u); mix(wd.SEA); mix(wd.SX); }
    return HH;
  };
  /* the settings keys the guests receive (main.js 'start' whitelist + the menu's rule / density keys) and the sim reads */
  const HASH_SETTINGS = ['biome', 'seed', 'weather', 'lava', 'wind', 'under', 'collapse', 'teams', 'worms', 'hp', 'turnTime', 'skill', 'sd', 'placement', 'first', 'volcanoes', 'time',
    'shape', 'blood', 'select', 'keepRope', 'rooms', 'rotLock', 'mineFuse', 'teamBlood', 'toolCrates', 'mapSize'].concat(C.DENSITY ? C.DENSITY.KEYS : []);

  /* ---------- events for presentation ---------- */
  function emit(S, type, data) { data.type = type; data.t = S.time; S.events.push(data); return data; }
  function log(S, text, rgb) {
    S.log.unshift({ text, rgb: rgb == null ? 0xdfe8f1 : rgb, t: S.time });
    if (S.log.length > 7) S.log.length = 7;
  }
  sim.emit = emit; sim.log = log;
  /* push with a cap (C.LIMITS): a full list drops its oldest entry first. Returns the item. */
  sim.pool_push = function (list, cap, item) { if (list.length >= cap) list.shift(); list.push(item); return item; };
  /* Presentation helper (NOT used by the sim): events name worms by id (`wormId`, `victimId`, `pushes[].wormId`: i16, -1 = none). The view code (render / audio / ui)
   * is written against worm objects, so main loop's event dispatch resolves the ids once per event: e.worm / e.victim / e.pushes[].worm. In an engine port this is
   * the lookup `Worm *w = &S.worms[e.wormId]` at the top of each handler. */
  sim.event_bind = function (S, e) {
    if (e.wormId !== undefined) e.worm = e.wormId >= 0 ? S.worms[e.wormId] : null;
    if (e.victimId !== undefined) e.victim = e.victimId >= 0 ? S.worms[e.victimId] : null;
    if (e.pushes) for (let i = 0; i < e.pushes.length; i++) e.pushes[i].worm = S.worms[e.pushes[i].wormId];
    return e;
  };

  sim.create = function () {
    return { debugOn: 0, events: [], log: [], worms: [], bodies: [], trees: [], proj: [], pending: [], planeBodies: [], flames: [], fx: [], frags: [], spat: [], stats: { slabBuilds: 0 }, rng: M.rng_make(1), settings: Object.assign({}, C.SETTINGS) };
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
    if (S.eow && SS.eow.hot_near(S, x, W().topHeight(x, z), z)) return true;       // P68g: no spawn on or within 1.5 m of a hot vein
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
      const x = 6 + rand(S) * (w.SX - 12), z = w.zpick(rand(S), 6);
      let y = 2 + rand(S) * (w.SY - 6);
      if (w.sample(x, y, z) > 0) continue;
      while (y > 1 && w.sample(x, y - 0.1, z) <= 0) y -= 0.1;
      if (y <= 1.2) continue;
      let ok = w.sample(x, y + (o.clear || 1.6), z) <= 0 && w.sample(x, y + 0.8, z) <= 0;
      for (const [dx, dz] of [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]]) { if (!ok) break; if (w.sample(x + dx, y + 0.3, z + dz) > 0 || w.sample(x + dx, y - 0.4, z + dz) <= 0) ok = false; }
      if (!ok) continue;
      if (o.team != null && !SS.fort.spot_ok(x, z, y, o.team)) continue;           // P68b: the worm's own fort
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
    return { x: w.MX, y: w.topHeight(w.MX, w.MZ), z: w.MZ };
  }
  sim.find_spot = function (S, minSep, taken, opts) {
    const w = W(), o = opts || {};
    if (w.under) return caveSpot(S, minSep, taken, o);
    for (let tries = 0; tries < 5000; tries++) {
      const x = 8 + rand(S) * (w.SX - 16), z = w.zpick(rand(S), 8), top = w.topHeight(x, z);
      if (top < w.SEA + (o.minAlt || 1.5) || top > (o.maxAlt || 99)) continue;
      if (w.dry && sim.arena_r(x, z) > DRY.SPAWN_R) continue;                     // dry: everything starts in the play area
      if (o.team != null && !SS.fort.spot_ok(x, z, top, o.team)) continue;        // P68b: the worm's own fort
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
      for (let i = 0; i < taken.length; i++) if (M.len2(taken[i].x - x, taken[i].z - z) < minSep * w.sepk) { clash = true; break; }
      if (clash) continue;
      return { x, y: top, z };
    }
    return null;
  };

  /* Resumable reset (drives the loading progress bar): world generation, then subsystems, then actors. */
  sim.begin_reset = function (S, settings) {
    S.settings = Object.assign({}, C.SETTINGS, settings || S.settings);
    // P38 R7 (P5): the seed is an i32 from here on (every seed mix is Math.imul / u32 wrap-around, identical in C); ?seed= and net settings are unbounded
    if (typeof S.settings.seed !== 'number' || S.settings.seed !== (S.settings.seed | 0)) S.settings.seed = S.settings.seed | 0;
    if (S.settings.biome === 'eow') { S.settings.dim = '3d'; S.settings.fort = false; }   // P68c: space is never sliced and has no forts (floating chunks, own layout)
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

  /* The worm struct (P38 R7 / P3): EVERY field exists from the first step with its default (before, ~40 of them appeared lazily; a missing field
   * read as undefined, which `||`, `== null` and `> 0` tests turned into 0 / false / null: the defaults below are exactly those values).
   * C: struct Worm { i16 id, team; char name[24]; f32 hp, hp0; u8 dead, facing(i8); Grave *grave; u8 cause; f32 dmgAcc, dmgT, hotT, fireT; i32 fireStep; f32 iceV;
   *   Swim *swim; Wet *ropeWet; Skills skills; vec3 pos, vel; f32 vs, vy, foot; u8 rest, air; ... } (the `grave`, `swim`, `ropeWet`, `rope`, `batHit`, `hitDir`
   * `pinProbe` pointers are inline structs there with a `used` flag). Times are S.time stamps: 0 = never for the ones only tested `> S.time`; null = never for the ones the view
   * tests with `!= null` (squash, flipAt, flipRope, coughAt, acidT, mgKill); -1e9 for burnT (the view computes `S.time - burnT < 0.3`: a 0 would read as "burning" in the first second). */
  sim.worm_make = function (id, team, name, hp, spot) {
    return {
      id, team, name, hp, hp0: hp, dead: false, facing: 1, grave: null, cause: 0, dmgAcc: 0, dmgT: 0, hotT: -9, fireT: -9, fireStep: -1, iceV: 0, swim: null, ropeWet: null,
      skills: { freerot: 0, laser: 0, fastwalk: 0, lowgrav: 0, tinfoil: 0 },
      pos: { x: spot.x, y: spot.y + 0.55, z: spot.z }, vel: { x: 0, y: 0, z: 0 }, rest: false, vs: 0, vy: 0, air: false, foot: 0.5,
      // movement / traversal (sim.js controlActive, traverse.js)
      windUp: 0, windFace: 0, walking: false, slide: false, hop: false, hopAt: 0, flip: false, flipAt: null, flipK: 0, flipW: 0, flipRope: null, squash: null, springFall: false, landDmg: 0,
      stillT: 0, pinT: 0, dizzyUntil: 0, shoveT: 0, bodyHitT: 0, washT: 0, lsink: 0, pinProbe: null, rope: null, aimMem: null, reserve: false,
      // life cycle / damage (sim.js hurt, kill, drown)
      dying: false, drowning: 0, gravePending: false, hitDir: null, burnT: -1e9, mgKill: null, batHit: null,
      // weapons A / aliens / shrapnel (weaponsa.js, alien.js, shrapnel.js)
      gas: 0, coughT: null, coughAt: null, stickT: 0, acidT: null, hopT: 0, hopDir: 0, hug: null, embryo: false, embT: 0, embNext: 0, embHit: -1, eaten: false, teleHold: 0, teleX: 0, teleY: 0, teleZ: 0, shrapT: null, shrapSum: 0
    };
  };

  function initState(S) {
    const st = S.settings;
    M.rng_seed(S.rng, (C.LAYOUT_SEED + Math.imul(st.seed | 0, 7919)) >>> 0);
    // Every per-game field, once, with its default (a rematch must equal a fresh start: lockstep peers and replays
    // compare them). Modules add their own state in their init (weapons, game, weather, water, veg, lava, ice).
    Object.assign(S, {
      // lists and id counters
      worms: [], bodies: [], trees: [], proj: [], pending: [], planeBodies: [], flames: [], fx: [], frags: [], spat: [], log: [], bunkers: [],
      bodyId: 0, nextBodyId: 1, fragId: 0, spatId: 0, structId: 0, projN: 0, crateId: 0,
      fragRng: null, spatRng: null, spatAcc: 0, spatTick: 0, aiPlan: null, aiRng: null, aiMem: null, _treeLogT: null,    // (P38 R1: a rematch starts from the same CPU memory / log throttle as a fresh game)
      // clock, phase, section
      tick: 0, time: 0, phase: 'play', theta: 0, O: { x: W().MX, z: W().MZ }, thetaGoal: null, sectionDirty: true, lastRotate: -99,
      // turn
      active: null, target: null, tgt: null, teamTurn: 1, firstTeam: 0, nextIdx: [0, 0], turnNo: 0, turnT: 0, turnStart: 0, selStart: 0, acted: false,
      retreatT: 0, attackStart: 0, resolveT: 0, quietT: 0, shots: 0, over: null,
      weapon: 'grenade', aim: 0.45, power: 0, charging: false, rope: null, hook: null, ropeHopT: -9, mouseRot: 0,
      // P37 W2 / P38 R7: the traverse state (SS.traverse; structs in its header), all present from the reset: S.ropeMem, S.chute, S.zip
      crateSel: -1,                                                // (P38 R9: the Shift+TAB crate cursor, rotlock.js: -1 = none)
      ropeMem: { aim: 0, chain: 0, relT: -9 }, chute: { open: 0, wid: -1, t: 0, sway: 0, steer: 0 },
      zip: { state: 0, wid: -1, as: 0, ay: 0, bs: 0, by: 0, len: 0, t: 0, v: 0, age: 0, bolt: null },
     
      // blasts, damage, dying beat, placement
      lastBoom: 0, slowUntil: 0, lastBlastT: -99, lastBlastW: 0, lastExplosion: null, lastCrater: null, hitDir: null,
      dyingW: null, dyingT: 0, dyingGrave: false, mapMinesUntil: 0, placeOrder: null, placeIdx: 0, placeT: 0, placeDone: -1,
      // presentation timers kept in S (see docs/PORTING.md: they move to the view in the port)
      ctx: 0, inspect: 0, lockMsgT: -9
    });
    S.events.length = 0;
    S.biome = W().biome;
    if (SS.eow) SS.eow.init(S);                                    // P68c: the End of the World biome (S.eow = null elsewhere)
    if (SS.shrapnel) SS.shrapnel.init(S);                         // P38 R7: every RNG stream is created here (S.rng above; weapons.init: armRng, ...)
    if (SS.spatter) SS.spatter.init(S);
    if (SS.ai) SS.ai.init(S);
    if (SS.weapons) SS.weapons.init(S);                           // P2: holes, strikes, devices, crates, fuse ...
    if (SS.lab) SS.lab.init(S);                                   // P42: the Lab's state + RNG stream (settings.labFlags)
    if (SS.cracks) SS.cracks.init(S);                             // P66b: the damage field (only with the CRACKS flag)
    SS.game.setup(S);                                              // P1: teams, rounds, sudden death (before subsystems / spawns)
    if (SS.weather) SS.weather.init(S);
    if (SS.water) SS.water.init(S);
    if (SS.veg) SS.veg.init(S);
    if (SS.lava) SS.lava.init(S);
    if (SS.ice) SS.ice.init(S);                                   // Step I: sea / pool ice (after the water)
    emit(S, 'reset', {});
    const taken = [], nT = S.teams.length, nW = nT * M.clamp(S.settings.worms | 0 || 3, 1, 4), names = SS.game.names(S, nW);
    const hp0 = M.clamp(S.settings.hp | 0 || 100, 1, 999), sep = nW > 8 ? 11 : 15, fortOn = !!SS.fort && SS.fort.is();
    for (let i = 0; i < nW; i++) {                                   // interleaved round-robin across the teams (PoC populate)
      const team = i % nT, fo = fortOn ? { team } : undefined;                       // P68b: fort mode: worm t (the team's first) sits in its bunker, the rest on the team's fort
      const spot = fortOn && i < nT ? SS.fort.seat(team) : sim.find_spot(S, sep, taken, fo) || sim.find_spot(S, 6, taken, fo) || sim.find_spot(S, 3, taken, fo) || (fortOn ? SS.fort.seat(team) : fallbackSpot(S));
      taken.push(spot);
      S.worms.push(sim.worm_make(i, team, names[i], hp0, spot));
    }
    const flat = W().flat;                                         // P68a: the 2D slab: derelict ship / alien nest stay 3D (P72: bridges, bunkers, ruins stamp their cross section)
    if (S.eow) SS.eow.spawned(S);                                  // P68c: the worms' suit state (no bridges, bunkers, ruins, aliens, trees in space)
    if (fortOn) SS.fort.populate(S, taken);                        // P68b: the forts' bunkers (+ the bunker worms), instead of the structure stamps below
    if (S.settings.rooms && !W().under && !flat) SS.game.rooms(S); else S.rooms = [];   // PoC buried rooms (option)
    if (!S.eow) {
    if (SS.struct && !fortOn) SS.struct.populate(S, taken);                  // M: steel bridges (before props / trees: they avoid the abutments; P72: 2D: one truss on the plane)
    if (SS.bunker && !fortOn) SS.bunker.populate(S, taken);                  // P29d: concrete bunkers (before props / trees too)
    if (SS.derelict && !flat && !fortOn) SS.derelict.populate(S, taken);              // P37: the crashed derelict alien ship (voxel stamp)
    if (SS.ruins && !fortOn) SS.ruins.populate(S, taken);                    // P37: volcanic ruined town + rocks (voxel stamps, before the props)
    if (SS.alien) SS.alien.populate(S, taken);                    // P37: face-hugger eggs (after the ship: the nest)
    if (flat && SS.collapse && SS.collapse.remove_floating_all(W()) > 0) W().mark_all();   // P72: 2D stamps (wall fragments, rubble, a cut footing) that hold on nothing are removed, nothing floats
    sim.unbury_worms(S, taken);                                          // P38 R1: lift a worm the hull / rubble stamps entombed (before the props use taken)
    sim.spawn_audit(S, taken);                                           // P95: no worm starts on sand / lava / water that hurts at once
    } else if (SS.alien) SS.alien.populate(S, taken);                 // (P68c: in space only the alien state is made)
    if (SS.scatter) SS.scatter.populate(S, taken);
    SS.game.furnish_rooms(S);
    if (SS.trees && !W().under && !S.eow) SS.trees.populate(S, taken);           // U: no trees (no light) underground
    if (S.settings.placement === 'user') SS.game.begin_placement(S);  // P13: the players place their worms first
    else sim.next_turn(S, true);
    S.verBase = W().version;
    if (flat) SS.dim2d.constrain(S);
    const B = C.BIOMES.find(b => b.id === S.biome);
    if (flat) log(S, `${B ? B.name : S.biome}: a ${W().SX} m side-on slice (2D). No rotation: everyone fights on the same plane.`, 0xfff3b0);
    else log(S, W().under ? `${B ? B.name.replace(/ isle| island/i, '') : S.biome} caves: a cave system in ${W().SX} m × ${W().SZ} m × 40 m of rock. Rotate with Q / E; the rope is your friend.`
      : `${B ? B.name : S.biome}: a ${W().SX} m × ${W().SZ} m × 40 m volume. Rotate with Q / E.`, 0xfff3b0);
  }

  /* P38 R1: after all the voxel stamps (derelict hull, ruined town, rocks) a worm whose body overlaps solid rock (spawned before the
   * stamps, which ignore it) is lifted to the nearest free standing spot: a ring search of 1.5 m steps out to 30 m. Body test: the centre,
   * the head and four mid-body rim points (a worm on an ordinary slope never trips it). Layout-neutral on maps without a stamp: nothing moves. */
  function bodyFree(w, x, y, z) {
    const R = C.WORM_R, d = W();
    return !(d.sample(x, y, z) > 0 || d.sample(x, y + R * 0.9, z) > 0 || d.sample(x + R * 0.9, y + 0.1, z) > 0 || d.sample(x - R * 0.9, y + 0.1, z) > 0 ||
      d.sample(x, y + 0.1, z + R * 0.9) > 0 || d.sample(x, y + 0.1, z - R * 0.9) > 0);
  }
  function unbury_worms(S, taken) {
    const w = W(); if (w.under) return 0;
    let moved = 0;
    for (const o of S.worms) {
      if (o.dead || bodyFree(w, o.pos.x, o.pos.y, o.pos.z)) continue;
      let done = false;
      for (let r = 1.5; r <= 30 && !done; r += 1.5) for (let q = 0; q < 16 && !done; q++) {
        const a = q * M.TAU / 16, x = o.pos.x + M.cos(a) * r, z = w.flat ? o.pos.z : o.pos.z + M.sin(a) * r;
        if (x < 6 || x > w.SX - 6 || !w.zin(z, 6)) continue;
        const top = w.topHeight(x, z), y = top + 0.55;
        if (top < w.SEA + 0.8 || (w.dry && !sim.in_play(S, x, z)) || nearLava(S, x, z) || w.mat_at(x, top - 0.2, z) === MAT.LAVA || !bodyFree(o, x, y, z)) continue;
        if (SS.fort && SS.fort.is() && SS.fort.team_at(x, z, y) !== o.team) continue;      // P68b: stay on the worm's own fort
        if (!(w.sample(x, y - 0.6, z) > 0)) continue;                               // stand on something
        let clash = false; for (const p of S.worms) if (p !== o && !p.dead && M.len3(p.pos.x - x, p.pos.y - y, p.pos.z - z) < 3) clash = true;
        if (clash) continue;
        o.pos.x = x; o.pos.y = y; o.pos.z = z; o.vel.x = o.vel.y = o.vel.z = 0; o.rest = false; done = true; moved++;
        if (taken && taken[o.id]) taken[o.id] = { x, y: top, z };          // (P38 R3: the spot list follows the lifted worm: props / boulders / trees placed later keep clear of the new place)
      }
    }
    return moved;
  }
  sim.unbury_worms = unbury_worms;

  /* P95: the spawn audit. A worm must never start where the environment hurts it at once: beyond the play circle of a dry world (hot sand, 1 HP / 5 s from the first second),
   * in or beside lava, in water (the map's own pools). find_spot, the fort seats, the fall-back spot and the stamps' lift each guard some of these; this is the one place that
   * checks the finished layout and moves a worm that is still on a hazard to the nearest clean spot find_spot gives (deterministic: the same RNG stream, taken = the others).
   * Returns the number moved. C: bool spawn_hazard(Game*, Worm*); i32 spawn_audit(Game*, Vec3 taken[]). */
  function spawn_hazard(S, o) {
    const w = W(); if (w.under || S.eow) return false;
    if (w.dry && sim.arena_r(o.pos.x, o.pos.z) > S.playR - 1) return true;
    if (SS.lava && S.lava && SS.lava.depth_at(S, o.pos.x, o.pos.z) > 0.005) return true;
    if (w.mat_at(o.pos.x, o.pos.y - o.foot - 0.2, o.pos.z) === MAT.LAVA) return true;
    if (SS.water && S.water && SS.water.depth(S, o.pos.x, o.pos.z) > 0.3) return true;
    return false;
  }
  sim.spawn_hazard = spawn_hazard;
  function spawn_audit(S, taken) {
    let moved = 0; const fortOn = !!SS.fort && SS.fort.is();
    for (const o of S.worms) {
      if (o.dead || !spawn_hazard(S, o)) continue;
      const others = []; for (const p of S.worms) if (p !== o && !p.dead) others.push({ x: p.pos.x, y: p.pos.y, z: p.pos.z });
      const fo = fortOn ? { team: o.team } : undefined, sp = sim.find_spot(S, 6, others, fo) || sim.find_spot(S, 3, others, fo);
      if (!sp) continue;
      o.pos.x = sp.x; o.pos.y = sp.y + 0.55; o.pos.z = sp.z; o.vel.x = o.vel.y = o.vel.z = 0; o.rest = false; moved++;
      if (taken && taken[o.id]) taken[o.id] = { x: sp.x, y: sp.y, z: sp.z };
    }
    return moved;
  }
  sim.spawn_audit = spawn_audit;

  /* P38 R9: the wedge resolver (a safety net: the causes are fixed where they arise, see body3D). A worm that is airborne yet has not moved
   * vertically for WD.PIN_T s while its vertical speed says it falls is stuck inside rock (a blast threw it into a slot, the ground rose around it).
   * It is moved to the nearest spot (cube shells of PIN_STEP m out to PIN_R m, scan order x, y, z: deterministic) where its whole body is free,
   * not in lava, inside the play circle; none: it is crushed. C: bool pin_step(Game*, Worm*, f32 y0, f32 dt), called at the end of body3D / step2D. */
  function wedge_free(S, o) {
    const w = W(), st = WD.PIN_STEP, nmax = Math.round(WD.PIN_R / st);
    for (let n = 1; n <= nmax; n++) for (let iy = -n; iy <= n; iy++) for (let ix = -n; ix <= n; ix++) for (let iz = -n; iz <= n; iz++) {
      if (M.max(Math.abs(ix), M.max(Math.abs(iy), Math.abs(iz))) !== n || (w.flat && iz !== 0)) continue;
      const x = o.pos.x + ix * st, y = o.pos.y + iy * st, z = o.pos.z + iz * st;
      if (x < 2 || x > w.SX - 2 || !w.zin(z, 2) || y < 1 || y > w.SY - 2) continue;
      if (!bodyFree(o, x, y, z) || w.sample(x, y - o.foot, z) > 0 || w.mat_at(x, y, z) === MAT.LAVA || nearLava(S, x, z)) continue;
      if (w.dry && !sim.in_play(S, x, z)) continue;
      return { x, y, z };
    }
    return null;
  }
  sim.wedge_free = wedge_free;
  /* P88: a worm AT REST or walking inside solid ground (rubble / a collapse / a stamp landed on it, a hole closed over it): its centre and its head both deep in rock.
   * rest / the ground checks only look below the feet, so it stayed there for good, and the soft body, buried in the rock's field, went wild. Same rule as the
   * runaway-speed wedge: the nearest free spot (wedge_free), else it is crushed. Staggered (every 8th step per worm). */
  function unentomb(S, o) {
    if (S.eow || o.dead || o.drowning || o.swim || o.rope || ((S.tick + o.id * 5) & 7) !== 0) return;
    const w = W(); if (!(w.sample(o.pos.x, o.pos.y, o.pos.z) > 0.3 && w.sample(o.pos.x, o.pos.y + 0.4, o.pos.z) > 0.3)) return;
    const f = wedge_free(S, o);
    if (!f) { log(S, `${o.name} is buried in the rock.`, 0xff9a9a); kill(S, o, 'crush'); return; }
    o.pos.x = f.x; o.pos.y = f.y; o.pos.z = f.z; o.vel.x = o.vel.y = o.vel.z = 0; o.vs = 0; o.vy = 0; o.rest = false; o.slide = false; o.stillT = 0; o.air = true; o.flip = false; o.hop = false;
    emit(S, 'unwedge', { wormId: o.id, x: f.x, y: f.y, z: f.z });
  }
  function pin_step(S, o, y0, vyNow, dt) {
    if (Math.abs(o.pos.y - y0) < 1e-4 && Math.abs(vyNow) > 2) o.pinT += dt; else { o.pinT = 0; return false; }
    if (o.pinT < WD.PIN_T) return false;
    o.pinT = 0;
    const f = wedge_free(S, o);
    if (!f) { log(S, `${o.name} is buried in the rock.`, 0xff9a9a); kill(S, o, 'crush'); return true; }
    o.pos.x = f.x; o.pos.y = f.y; o.pos.z = f.z; o.vel.x = o.vel.y = o.vel.z = 0; o.vs = 0; o.vy = 0; o.rest = false; o.slide = false; o.stillT = 0;
    o.air = true; o.flip = false; o.hop = false;
    emit(S, 'unwedge', { wormId: o.id, x: f.x, y: f.y, z: f.z });
    return true;
  }

  /* ---------- turn flow ---------- */
  /* the worms still in the game (a worm at 0 HP is dying), optionally of one team: once per turn change (not per step); a plain loop into a fresh array (C: fills a caller array) */
  function living(S, team) {
    const out = [];
    for (let i = 0; i < S.worms.length; i++) { const w = S.worms[i]; if (!w.dead && w.hp > 0 && (team === undefined || w.team === team)) out.push(w); }
    return out;
  }
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
    if (SS.lab && SS.lab.draft_begin(S, first)) return;           // P50: the perk draft (phase 'perk'); next_turn runs again when it ends
    if (!first) SS.game.turn_change(S);
    S.teamTurn = SS.game.next_team(S);
    // never hand a turn to a worm that is swimming / sinking: the rotation goes on past it (it keeps its place in the
    // order: indexing a shorter list reordered the team); a whole team in the water: the last one tried
    const team = living(S, S.teamTurn).sort((a, b) => a.id - b.id);
    let w, left = team.length;
    // (P38 R3: nextIdx[team] = the id after the worm that moved last: the next living id, wrapping; a death no longer reindexes the rotation: a worm got 2 turns in 3)
    do { const nx = S.nextIdx[S.teamTurn] | 0; w = team.find(q => q.id >= nx) || team[0]; S.nextIdx[S.teamTurn] = w.id + 1; } while ((w.swim || w.drowning) && --left > 0);
    if (S.active) { S.active.aimMem = S.aim; S.active.windUp = 0; }       // (P38 R1: a jump wind-up begun in the last moments of the turn does not outlive it)
    if (S.active && SS.skills) SS.skills.turn_end(S, S.active);           // P37 W4: skills count their turns down
    S.active = w; if (SS.weaponsA && SS.weaponsA.turn_sync) SS.weaponsA.turn_sync(S); w.rest = false; S.turnNo++; S.hook = null; w.windUp = 0; if (SS.traverse) SS.traverse.reset(S);
    S.turnT = S.settings.turnTime > 0 ? S.settings.turnTime : 0; S.turnStart = S.time; S.selStart = S.time; S.acted = false;
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
      if (M.len2(r.x - w.pos.x, r.z - w.pos.z) > 0.15) { S.theta = W().flat ? 0 : clamp_heading(S, M.atan2(r.z - w.pos.z, r.x - w.pos.x), S.theta); S.O = { x: w.pos.x, z: w.pos.z }; }
      const q = P.to_plane(S, r), dd = P.dir(S);
      S.rope = SS.traverse.rope_make(q.s, r.y, r.len, Math.abs(q.t) < 0.5); w.air = true; w.vs = w.vel.x * dd.x + w.vel.z * dd.z; w.vy = w.vel.y;
    }
    if (SS.weapons) SS.weapons.turn_start(S, first);              // P2: device lifetimes, supply drops
    if (SS.lab) SS.lab.turn_start(S, first);                      // P42: pressure clock, moon phase, underdog notice, meteors
    if (first) S.mapMinesUntil = S.time + C.ARMS.TRAPS.MAP_MINES_SEEN;   // the map's mines: seen by all, then they burrow
    sim.ensure_control(S, w);                                     // P91: whatever happened before, the worm that starts a turn can act
    emit(S, 'turn', { wormId: w.id});
    if (!first) log(S, `${sim.team_name(S, w.team)} · ${w.name}'s turn. Section aligned with ${S.target.name}.`, sim.team_rgb(S, w.team));
  };

  /* PoC worm select (setup option): in the first SELECT_T s of a turn, before the worm acts, the player may hand the
   * turn to the team's next living worm (the clock keeps running) */
  const SELECT_T = 10;
  sim.can_switch = S => !!(S.settings.select && S.phase === 'play' && S.active && !S.acted && S.time - (S.selStart != null ? S.selStart : S.turnStart) < SELECT_T);   // (selStart: the turn's start; switching restarts turnStart (rotation window) but not this)
  sim.switch_worm = function (S) {
    if (!sim.can_switch(S)) return false;
    const a = S.active, team = living(S, a.team).filter(o => o === a || (!o.swim && !o.drowning)).sort((p, q) => p.id - q.id);   // (not a swimmer: review)
    if (team.length < 2) return false;
    const w = team[(team.indexOf(a) + 1) % team.length];
    a.vel = { x: 0, y: 0, z: 0 }; a.rest = false;
    S.active = w; w.rest = false; S.rope = null; S.charging = false; if (SS.traverse) SS.traverse.reset(S);
    a.windUp = 0; w.windUp = 0; S.turnStart = S.time;           // (P38 R1: the new worm gets its own rotation window; nobody keeps a jump wind-up)
    a.aimMem = S.aim; focusActive(S, w); S.aim = w.aimMem != null ? w.aimMem : WD.AIM0;
    emit(S, 'switch', { wormId: w.id});
    log(S, `${w.name} takes over.`, sim.team_rgb(S, w.team));
    return true;
  };
  // the section / target / momentum set-up for the worm whose turn it is (next_turn, worm select)
  function focusActive(S, w) {
    S.O = { x: w.pos.x, z: w.pos.z };
    // P37-6: the section opens on a RANDOM worm of the strongest enemy team (sim/rotlock.js); without the module: the nearest foe
    const foes = M.sort_stable(living(S).filter(o => o.team !== w.team), (a, b) => M.len2(a.pos.x - w.pos.x, a.pos.z - w.pos.z) - M.len2(b.pos.x - w.pos.x, b.pos.z - w.pos.z));
    S.target = SS.rotlock ? SS.rotlock.pick_start_target(S, w) || foes[0] : foes[0];
    S.theta = M.atan2(S.target.pos.z - w.pos.z, S.target.pos.x - w.pos.x);
    S.theta = clamp_heading(S, S.theta, S.theta);     // D6: a worm out in the hot sand faces a plane through the play area
    if (W().flat) S.theta = 0;                        // P68a: the 2D plane never turns (+x is to the right)
    S.thetaGoal = null; w.facing = 1; S.tgt = null;   // (a target belongs to the old plane)
    // a worm that takes over in mid-air keeps its momentum (in the new plane)
    const dd = P.dir(S), vx = w.vel ? w.vel.x : 0, vz = w.vel ? w.vel.z : 0, vy = w.vel ? w.vel.y : 0;
    w.air = !P.grounded2(S, 0, w.pos.y) || Math.abs(vy) > 0.5;
    w.vs = w.air ? vx * dd.x + vz * dd.z : 0; w.vy = w.air ? vy : 0;
  }
  // PoC sniperAimRate: aim slows near what the scope points at (2.06 / max(1.41, dist) rad/s, 0.025 .. 1.5)
  function sniperRate(S, a) {
    const ad = sim.aim_dir(S), ap = P.to_plane(S, a.pos);
    for (let d = 0.6; d < 40; d += 0.25) { const s = ap.s + ad.s * d, y = a.pos.y + ad.y * d, p = P.to_world(S, s, y); if (P.solid2(S, s, y) || S.worms.some(o => !o.dead && o !== a && M.len3(o.pos.x - p.x, o.pos.y - y, o.pos.z - p.z) < C.WORM_R)) return M.clamp(2.06 / M.max(1.41, d), 0.025, WD.AIM_RATE); }
    return WD.AIM_RATE;
  }
  function locked(S) {
    if (W().flat) return true;                        // P68a: the 2D view never turns (no message: there is nothing to wait for)
    if (S.phase === 'place') return false;
    if (S.phase === 'play') {                         // P37-6: the rotation lock (sim/rotlock.js): a free window at the turn start, then fixed
      if (!SS.rotlock || SS.rotlock.allowed(S)) return false;
      if (S.time - S.lockMsgT > 1.5) { S.lockMsgT = S.time; log(S, 'View locked: rotating is only possible in the first seconds of a turn, before the worm moves.', 0xffb27a); }
      return true;
    }
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
      const mg = M.max(AIM_MARGIN, M.atan(1.5 / l));
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
    if (SS.traverse && SS.traverse.riding(S)) return false;            // no turning the section on a zipline
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
    if (!w.alien) S.target = w;                       // (P38 R1: the CPU's alien pseudo-targets (SS.alien.ai_foes) are no worm: the HUD / the log read name and team off S.target)
    sim.align_to_point(S, w.pos.x, w.pos.z);
  };
  // turn the section (thetaGoal) so that it contains the world point (x, z)
  sim.align_to_point = function (S, x, z) {
    if (locked(S) || !S.active) return;
    let g = M.wrap_angle(M.atan2(z - S.active.pos.z, x - S.active.pos.x));
    // D6: of the two headings of that plane (g, g + π) take the one in the current window, clamped (never across
    // forbidden headings, so the turn toward the goal always arrives)
    if (heading_window(S)) {
      const g2 = M.wrap_angle(g + Math.PI), a = clamp_heading(S, g, S.theta), b = clamp_heading(S, g2, S.theta);
      g = Math.abs(M.wrap_angle(a - g)) <= Math.abs(M.wrap_angle(b - g2)) ? a : b;
    }
    S.thetaGoal = g;
  };
  /* TAB: the next OPPONENT worm (strongest team first, then its strongest worm: sim/rotlock.js); Shift+TAB: the next
   * crate, nearest first. (Before: every other worm in id order.) */
  sim.align_next = function (S, step) {
    if (locked(S) || !S.active) return;
    if (SS.rotlock) { const w = SS.rotlock.next_opponent(S, step); if (w) sim.align_to(S, w); return; }
    const others = S.worms.filter(w => !w.dead && w !== S.active);
    if (!others.length) return;
    const i = others.indexOf(S.target);
    sim.align_to(S, others[((i < 0 ? -1 : i) + step + others.length) % others.length]);
  };
  sim.align_crate = function (S) {
    if (locked(S) || !S.active || !SS.rotlock) return;
    const c = SS.rotlock.next_crate(S); if (c) sim.align_to_point(S, c.pos.x, c.pos.z);
  };

  /* ---------- active worm: 2D in the section ---------- */
  sim.aim_dir = S => ({ s: S.active.facing * M.cos(S.aim), y: M.sin(S.aim) });
  function setActive2D(S, a, s, y) { const p = P.to_world(S, s, y); a.pos.x = p.x; a.pos.y = y; a.pos.z = p.z; }

  /* ---------- PoC worm dynamics (C.WORM_DYN; game.js walkWorm / updateWorm / integrateBody) ---------- */
  const WD = C.WORM_DYN, GW = C.G_WORM;
  /* P37-7: a worm's walking speed (m/s) and gravity factor; the tool-crate skills (worm.skills: fastwalk / lowgrav, turns
   * left) act here and nowhere else. sim.jump_vs: the horizontal speed of a forward jump. */
  sim.walk_speed = (S, w) => C.WALK * (w && w.skills && w.skills.fastwalk > 0 ? C.SKILL.FASTWALK_K : 1) * (SS.lab4 && S.lab ? SS.lab4.walk_k(S, w) : 1);   // (P79 SLICK: mud slows the walk)
  sim.gravity_k = (S, w) => (w && w.skills && w.skills.lowgrav > 0 ? C.SKILL.LOWGRAV_K : 1) * (SS.lab ? SS.lab.gravity_k(S) : 1);
  // the forward jump covers what walking covers in the whole time (wind-up + flat flight 2 vy / g): spring speed = walk x (T_w + T_air) / T_air
  sim.jump_vs = (S, w) => { const ta = 2 * WD.JUMP_VY / (GW * sim.gravity_k(S, w)); return sim.walk_speed(S, w) * (WD.JUMP_WIND + ta) / ta; };
  const RIM = []; for (let i = 0; i < 12; i++) { const t = i / 12 * Math.PI * 2; RIM.push(M.cos(t) * C.WORM_R, M.sin(t) * C.WORM_R); }
  // contact normal of the worm disc at (s, y): away from the blocked rim points (null = no contact)
  function rimNormal(S, s, y) {
    let ns = 0, ny = 0, n = 0;
    for (let i = 0; i < RIM.length; i += 2) if (P.blocked2(S, s + RIM[i], y + RIM[i + 1])) { ns -= RIM[i]; ny -= RIM[i + 1]; n++; }
    if (!n) return null;
    const l = M.len2(ns, ny); return l < 1e-6 ? { s: 0, y: 1 } : { s: ns / l, y: ny / l };
  }
  // the worm disc overlaps another worm (walkWorm: then it may climb 18 px instead of 10)
  const onWorm = (S, a, s, y, m) => { for (const b of S.planeBodies) if (b.worm >= 0 && b.worm !== a.id && M.len2(b.s - s, b.y - y) < 2 * C.WORM_R - 0.02 + (m || 0)) return b; return null; };   // (m: P88 reach margin)
  // landing damage (PoC: head-on / glancing, both only on floors and slopes), the spring trap's minimum
  function landHurt(S, w, dmg) {
    if (w.springFall) { w.springFall = false; dmg = M.max(dmg, C.ARMS.SPRING.FALL_MIN); }
    if (dmg > 0 && SS.lab) dmg = SS.lab.landing_dmg(S, w, dmg);      // (P50: the PADDED perk)
    if (dmg > 0) hurt(S, w, dmg, DS.LANDING);
  }
  function landNow(S, a, impact) {
    a.iceV = SS.ice && S.ice && SS.ice.slippery(S, a.pos.x, a.pos.z) ? a.vs : 0;   // P30: lands sliding on bare ice
    a.air = false; a.vs = 0; a.vy = 0; a.flip = false; a.hop = false; a.slide = false; a.stillT = 0;
    if (a.springFall) landHurt(S, a, 0);
    if (impact > 2) emit(S, 'land', { wormId: a.id, x: a.pos.x, y: a.pos.y - 0.45, z: a.pos.z, speed: impact, mat: W().mat_at(a.pos.x, a.pos.y - 0.7, a.pos.z) });
    if (impact > 9.6) a.squash = S.time;
  }
  sim.weapon_ready = function (S, a) {                 // PoC weaponReady L4342
    return !a.walking && !a.air && !(a.windUp > 0) && !S.rope && !(S.zip && S.zip.state === 2) && !a.flip && !(a.dizzyUntil > S.time) && !(S.teleT > 0) && !a.drowning && !a.swim && M.len2(a.vs || 0, a.vy || 0) < WD.READY_V;
  };
  /* PoC recoverPinnedWorm (L2009): a worm inside a resting prop (a crate landed on it, a boulder settled into it) moves
   * to the nearest spot where the WHOLE disc is free (up, sideways, the diagonals; up to 2 x the prop + the worm,
   * at most 110 px = 7.07 m), else the prop breaks (never a soft-locked worm); a worm "in the air" but slow, not
   * sliding / hopping / flipping and touching ground that stays within 2 px (0.13 m) for 0.18 s lands */
  const PIN_ANG = [Math.PI / 2, 0, Math.PI, Math.PI / 4, 3 * Math.PI / 4, -Math.PI / 4, -3 * Math.PI / 4];
  function pinningBody(S, s, y) {
    for (const b of S.planeBodies) {
      const rb = b.body >= 0 ? SS.bodies.by_id(S, b.body) : null; if (!rb || !rb.asleep) continue;
      const inside = (ps, py) => b.kind === 0 ? M.len2(ps - b.s, py - b.y) < b.r : Math.abs(ps - b.s) < b.hs && Math.abs(py - b.y) < b.hy;
      if (inside(s, y)) return b;
      for (let k = 0; k < 12; k++) { const t = k / 12 * Math.PI * 2; if (inside(s + M.cos(t) * (C.WORM_R - PX), y + M.sin(t) * (C.WORM_R - PX))) return b; }
    }
    return null;
  }
  // the nearest spot where the whole disc is free of the pinning prop (null: none within reach)
  function pinFree(S, pin, s, y) {
    const size = pin.kind === 0 ? pin.r : M.max(pin.hs, pin.hy), maxR = M.min(110 * PX, size * 2 + C.WORM_R);
    for (let r = PX; r <= maxR + 1e-6; r += PX) for (const t of PIN_ANG) {
      const ns = s + M.cos(t) * r, ny = y + M.sin(t) * r, wq = P.to_world(S, ns, ny);
      if (ny - C.WORM_R < sim.surface_at(S, wq.x, wq.z) || P.overlap2(S, ns, ny) > 0) continue;
      return { s: ns, y: ny };
    }
    return null;
  }
  function breakPin(S, pin) {
    const b = SS.bodies.by_id(S, pin.body); SS.bodies.remove(S, b);
    emit(S, 'propbreak', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, kind: b.prop || 'rubble', why: 'pinned' });
  }
  /* P88: the worms that are NOT under control are pinned by a prop too (a crate landed on a resting worm: its body stayed inside the prop until its turn, and the
   * soft body, buried in the prop's field, exploded). Same rule as the active worm: the nearest free spot, else the prop breaks. Worms in the plane band only (the
   * only ones that have prop cross-sections); runs once per step before the active worm moves. */
  function unpinOthers(S) {
    if (S.eow) return;
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i]; if (o.dead || o.drowning || o.swim || o.rope || sim.ctl(S, o)) continue;      // (a worm under control frees itself: recoverPinned)
      const q = P.to_plane(S, o.pos); if (Math.abs(q.t) > C.WORM_R) continue;
      const pin = pinningBody(S, q.s, o.pos.y); if (!pin) continue;
      const f = pinFree(S, pin, q.s, o.pos.y);
      if (!f) { breakPin(S, pin); continue; }
      const wq = P.to_world(S, f.s, f.y), n = P.nrm(S);
      o.pos.x = wq.x + n.x * q.t; o.pos.y = wq.y; o.pos.z = wq.z + n.z * q.t; o.vel.x = o.vel.y = o.vel.z = 0; o.rest = false; o.slide = false; o.stillT = 0;
    }
  }
  function recoverPinned(S, a, dt) {
    if (S.rope || S.hook || S.dig || a.drowning || a.swim || a.dead || !sim.ctl(S, a)) return;
    const s = P.to_plane(S, a.pos).s, y = a.pos.y, pin = pinningBody(S, s, y);
    if (pin) {
      const found = pinFree(S, pin, s, y);
      if (!found) { breakPin(S, pin); return; }          // remove the obstruction rather than soft-lock the worm
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
    if (S.eow) return SS.eow.step2d(S, a, dt, mv);                 // P68c: planetoid gravity, a magnetic suit on any surface
    let s = P.to_plane(S, a.pos).s, y = a.pos.y;
    a.walking = false;
    if (!a.air && mv) a.facing = mv;
    let wq = P.to_world(S, s, y), lf = lavaFloor(S, wq.x, wq.z, a);
    if (!a.air) {
      // walking: sim.walk_speed (PoC 2.96 m/s x 0.7), step up 0.64 m (1.16 m over another worm), follow the ground down 0.64 m, else drop off
      let hs = mv * sim.walk_speed(S, a);
      if (hs && sim.lava_contact(S, a.pos.x, a.pos.y - a.foot, a.pos.z, lc).sub > 0.05) hs *= C.LAVA_WADE;   // wading in viscous lava
      // P30: bare sea ice is slippery: the speed eases toward the walk speed (C.ICE.GRIP 1/s) and slides on when the key
      // is let go; a thin snow cover on the ice gives grip again (SS.ice.slippery)
      const it = SS.ice && S.ice ? SS.ice.top_at(S, a.pos.x, a.pos.z) : -1e9;
      const onIce = it > -1e8 && Math.abs(a.pos.y - a.foot - it) < 0.15 && SS.ice.slippery(S, a.pos.x, a.pos.z);
      if (onIce) { a.iceV += (hs - a.iceV) * (1 - M.exp(-C.ICE.GRIP * dt)); hs = Math.abs(a.iceV) < 0.04 && !mv ? 0 : a.iceV; } else a.iceV = 0;
      if (SS.lab4 && S.lab && S.settings.labFlags) hs += SS.lab4.slip(S, a, s, y);   // P79 SLICK: a wet slope steeper than the friction lets go
      if (hs) {
        const base = P.overlap2(S, s, y), ns = s + hs * dt, top = onWorm(S, a, s, y) || onWorm(S, a, ns, y, WD.STACK_REACH) ? WD.STEP_UP_WORM : WD.STEP_UP;   // P88: a worm right ahead can be climbed too (on a slope the disc stopped 0.01 m short of 'on it')
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
        const yf = lf + a.foot; y = y < yf - C.LAVA.DEEP ? y + 1.5 * dt : snapped ? M.max(y, yf) : yf;   // (lakes / canals < DEEP: as before)
        SS.lava.vel_at(S, wq.x, wq.z, lvv);
        const d = P.dir(S), ds = 1.5 * (lvv.x * d.x + lvv.z * d.z) * dt;
        if (ds && P.overlap2(S, s + ds, y) <= P.overlap2(S, s, y)) s += ds;
      }
      if (!snapped && !onLava) { a.air = true; a.vs = mv ? mv * WD.LEDGE_VS * (sim.walk_speed(S, a) / C.WALK) : 0; a.vy = 0; }      // ledge: drops off at 40 px/s
      else { a.vs = 0; a.vy = 0; }
    }
    if (a.air) {
      const sp0 = M.len2(a.vs, a.vy), nsub = M.max(1, Math.ceil(sp0 * dt / 0.08)), h = dt / nsub;
      let contact = null;
      const yStart = y;
      if (sp0 > WD.V_MAX) { const kk = WD.V_MAX / sp0; a.vs *= kk; a.vy *= kk; }       // P38 R9: terminal velocity
      for (let k = 0; k < nsub && a.air; k++) {
        a.vy -= GW * sim.gravity_k(S, a) * h;
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
        const imp = -vn, sp = M.len2(a.vs, a.vy), ts = -n.y, ty = n.s, vt = a.vs * ts + a.vy * ty, along = Math.abs(vt) / M.max(1e-6, sp);
        // landing on another worm's head (PoC resolveWormContacts): it is shoved aside, the lander stops on top
        const lower = n.y > 0.5 ? onWorm(S, a, ns, ny - 0.1) : null;
        if (lower && imp >= WD.HEAD_SHOVE_V && !(S.worms[lower.worm].shoveT > S.time)) {
          const o = S.worms[lower.worm], d = P.dir(S), dir = Math.abs(o.s - ns) > 0.06 ? Math.sign(lower.s - ns) : a.facing;
          shoveWorm(S, o, d.x * dir, d.z * dir, imp);
          landNow(S, a, imp); a.vs *= 0.25; a.squash = S.time; break;
        }
        if (imp > WD.FALL_SAFE && n.y > 0.2) {                                // a hard landing on a floor or slope
          const head = along < WD.HEAD_ALONG;
          // the rebound first: the damage ends the turn and hands the worm (with this velocity) to the 3D body step
          if (head) { const up = M.min(WD.HEAD_UP_MAX, WD.HEAD_UP_K * imp); a.vs = n.s * up + a.facing * WD.HEAD_SIDE; a.vy = n.y * up; a.dizzyUntil = S.time + WD.DIZZY; a.squash = S.time; emit(S, 'dizzy', { wormId: a.id}); }
          else { a.vs = ts * vt * WD.FRIC - n.s * vn * WD.BOUNCE; a.vy = ty * vt * WD.FRIC - n.y * vn * WD.BOUNCE; }
          a.slide = true; a.flip = false; a.hop = false;
          emit(S, 'land', { wormId: a.id, x: a.pos.x, y: a.pos.y - 0.45, z: a.pos.z, speed: imp, mat: W().mat_at(a.pos.x, a.pos.y - 0.7, a.pos.z), hard: 1 });
          setActive2D(S, a, s, y);
          landHurt(S, a, head ? M.min(WD.HEAD_MAX, Math.round((imp - WD.FALL_SAFE) * WD.HEAD_K) + WD.HEAD_ADD) : M.min(WD.GLANCE_MAX, Math.round((imp - WD.FALL_SAFE) * WD.GLANCE_K)));
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
      if (a.air && !S.rope && !a.dead) { setActive2D(S, a, s, y); if (pin_step(S, a, yStart, a.vy, dt)) return; }   // P38 R9: wedged in rock
    }
    setActive2D(S, a, s, y);
  }


  /* ninja rope, parachute, zipline: sim/traverse.js (P37). Thin delegates keep the old API for tools and tests. */
  sim.shoot_rope = S => SS.traverse.rope_fire(S);
  sim.hook_resolve = S => SS.traverse.hook_resolve(S);
  sim.ROPE_TUNE = SS.CFG.TRAV ? SS.CFG.TRAV.ROPE : null;
  const PX = 0.0643;

  function controlActive(S, a, dt, inp, retreat) {
    const mv = inp.move || 0, WP = SS.weapons;                 // (partial Input structs from tools / tests: 0)
    if (inp.jet && S.eow) SS.eow.jet_toggle(S, a);                // P86: the team's jetpack switch (J)
    if (mv || inp.jump || inp.backflip || inp.fire_pressed || inp.drop) S.acted = true;     // (worm select: only before acting)
    // P2: weapon choice (only with ammo; locked after the first shotgun shot), fuse, strike side, girder angle, target
    // P37-8: choosing Skip Go only SELECTS it (the worm shows a hand gesture); the turn ends when fire is pressed (WP.use 'skip')
    if (!retreat && !S.charging && inp.weapon && C.WEAPONS[inp.weapon] && C.ARSENAL[inp.weapon] && !(S.shots > 0) && WP.can_use(S, inp.weapon)) S.weapon = inp.weapon;
    if (inp.fuse >= 1 && inp.fuse <= 5) { S.fuse = inp.fuse | 0; if (SS.weaponsA) SS.weaponsA.set_fuse(S, S.weapon, S.fuse); }
    if (inp.adj && SS.weaponsA && !retreat) SS.weaponsA.adjust(S, inp.adj);
    if (inp.sdir) S.strikeDir = inp.sdir > 0 ? 1 : -1;
    // girder plate (P37 W4): free angle: held keys turn it continuously (gturn -1..1, Shift = fine), gang = one 22.5° step
    if (inp.gang) S.plateAng = M.wrap_angle((S.plateAng || 0) + (inp.gang > 0 ? 1 : -1) * C.ARMS.GIRDER.STEP);
    if (inp.gturn) S.plateAng = M.wrap_angle((S.plateAng || 0) + M.clamp(inp.gturn, -1, 1) * C.ARMS.GIRDER.TURN * (inp.fine ? 0.25 : 1) * dt);
    if (inp.tgt && Number.isFinite(inp.ts) && Number.isFinite(inp.ty)) S.tgt = { s: inp.ts, y: inp.ty };
    // aim: 1.5 rad/s up to +-90° (PoC L5154); the sniper aims finer when pointed at something near (features-ballistics)
    if (!S.rope) {
      const rate = S.weapon === 'sniper' ? sniperRate(S, a) : WD.AIM_RATE;
      if (inp.up) S.aim = M.min(Math.PI / 2, S.aim + rate * dt); if (inp.down) S.aim = M.max(-Math.PI / 2, S.aim - rate * dt);
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
    if (SS.traverse) SS.traverse.clamp_aim(S);                                   // the zipline aims level or down only
    if (retreat && inp.fire_pressed) WP.detonate_own(S);                     // PoC: fire again sets the sheep off
    // on the rope: SS.traverse.rope_control (Space / Enter let go, Enter drops a payload, Backspace hops, arrows pump / reel)
    if (S.rope) {
      if (inp.fire_pressed && S.weapon === 'skip' && !retreat) WP.use(S, 0);    // (P37-8: Skip Go selected: fire skips, the rope is kept)
      else SS.traverse.rope_control(S, a, dt, inp, mv, retreat);
    } else if (SS.traverse && SS.traverse.riding(S)) {
      SS.traverse.zip_control(S, a, dt, inp, mv);                 // on a zipline: it slides, left / right nudge, a jump drops off
    } else {
      if (S.hook) SS.traverse.hook_step(S, a, dt);
      if (SS.traverse) { SS.traverse.step(S, a, dt); SS.traverse.air_pre(S, a, dt, inp, mv); }
      // PoC jumps (L3649-3664): Enter = forward jump, Backspace = back hop; Backspace again while the hop still rises
      // (within 0.5 s) = back salto (a flip; no weapon until it lands). No jump in the air, no steering in the air.
      // P37-7: the forward jump: stop, tilt back for JUMP_WIND s (a.windUp = the time of the spring), then spring forward
      if (a.windUp > 0 && (a.air || S.rope || a.swim || a.drowning)) a.windUp = 0;               // knocked off its feet / roped: no spring
      if (!a.air && inp.jump && !(a.windUp > 0)) { a.windUp = S.time + WD.JUMP_WIND; a.windFace = a.facing; a.walking = false; }
      else if (a.windUp > 0 && !a.air && S.time >= a.windUp) {
        a.windUp = 0; a.vy = WD.JUMP_VY * (SS.lab ? SS.lab.jump_k(S, a) : 1); a.vs = a.windFace * sim.jump_vs(S, a); a.air = true; a.hop = false; a.slide = false; a.squash = S.time; emit(S, 'jump', M.v3_copy(a.pos));
      }
      else if (!a.air && inp.backflip && !(a.windUp > 0)) { a.vy = WD.HOP_VY; a.vs = a.facing * WD.HOP_VS; a.air = true; a.hop = true; a.hopAt = S.time; a.slide = false; a.squash = S.time; emit(S, 'jump', M.v3_copy(a.pos)); }
      else if (a.air && inp.backflip && a.hop && S.time - a.hopAt < WD.SALTO_WIN && a.vy > WD.SALTO_VMIN) {
        a.vy = M.max(a.vy, WD.SALTO_BASE) + WD.SALTO_ADD; a.vs = a.facing * WD.SALTO_VS; a.flip = true; a.flipAt = S.time; a.hop = false;
        emit(S, 'salto', { wormId: a.id});
      }
      // no walking while charging a shot (PoC L5148)
      if (S.eow) SS.eow.jump_fix(S, a);                                   // P68c: a jump leaves along the worm's own up
      step2D(S, a, dt, a.air || S.charging || a.windUp > 0 ? 0 : mv);
      recoverPinned(S, a, dt);
      const kind = C.WEAPONS[S.weapon].kind, ready = sim.weapon_ready(S, a);
      if (kind === 'chute' || kind === 'zip') SS.traverse.tool(S, a, dt, inp, retreat || S.teleT > 0);   // parachute / zipline (also in the retreat)
      else if (retreat || S.teleT > 0) { /* P1 retreat: move, jump, keep swinging; no new attack */ }
      else if (S.weapon === 'rope') { if (inp.fire_pressed && !S.hook) sim.shoot_rope(S); }
      else if (kind === 'charge') {
        if (inp.fire_pressed && !S.charging && ready && WP.can_use(S, S.weapon) && !(C.WEAPONS[S.weapon].target && !S.tgt)) { S.charging = true; S.power = C.WEAPONS[S.weapon].fixed ? 1 : 0; }   // (fixed: the mortar always fires at full power)
        else if (inp.fire_pressed && C.WEAPONS[S.weapon].target && !S.tgt) log(S, 'Click a target first.', 0xffb27a);
        if (S.charging) {
          S.power = M.min(1, S.power + dt / WD.CHARGE_T);
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
    if (SS.traverse) SS.traverse.on_end(S);                       // a worm on a zipline drops off, the parachute folds
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
    for (const w of S.worms) if (!w.dead && !(w.id === p.owner && p.age < 0.25) && M.v3_dist(pt, w.pos) < C.WORM_R + 0.12) return w;
    return null;
  }
  /* P32: a thrown / bouncing shell (grenade, cluster, banana, holy, dynamite...) does not pass through a worm: it hits
   * the soft body (a disc of WORM_R + the shell's radius about w.pos, in the plane, worms within WORM_R of it), bounces
   * off with most of its speed absorbed (restitution 0.15, then x0.5) and drops next to it; a hit faster than 3 m/s
   * into the body costs the worm 1 HP, once per shell and worm (p.hitW: bit mask of worm ids). Returns true on contact. */
  function wormBounce(S, p, def, ns, ny) {
    for (const w of S.worms) {
      if (w.dead || w.drowning || w.swim || (w.id === p.owner && p.age < 0.25)) continue;
      const q = P.to_plane(S, w.pos); if (Math.abs(q.t) > C.WORM_R) continue;
      const rr = C.WORM_R + (def.r || 0.06), ds = ns - q.s, dy = ny - w.pos.y, d2 = ds * ds + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2), ux = d > 1e-4 ? ds / d : 0, uy = d > 1e-4 ? dy / d : 1, vn = p.vs * ux + p.vy * uy;
      if (vn < 0) {
        p.vs -= 1.15 * vn * ux; p.vy -= 1.15 * vn * uy; p.vs *= 0.5; p.vy *= 0.5; p.bounces++;
        const bit = 1 << (w.id & 31);
        if (-vn > 3 && !((p.hitW | 0) & bit)) { p.hitW = (p.hitW | 0) | bit; const dd = P.dir(S); S.hitDir = { x: -ux * dd.x, y: -uy, z: -ux * dd.z }; hurt(S, w, 1, p.type === 'napalm' ? DS.PROJ_NAPALM : p.type === 'acid' ? DS.PROJ_ACID : p.type === 'gas' ? DS.PROJ_GAS : DS.PROJ_HIT, 0, sim.weapon_name_id(p.type)); }
      }
      if (!P.solid2(S, q.s + ux * rr, w.pos.y + uy * rr)) { p.s = q.s + ux * rr; p.y = w.pos.y + uy * rr; }
      return true;
    }
    return false;
  }
  function removeProj(S, p) { const i = S.proj.indexOf(p); if (i >= 0) S.proj.splice(i, 1); S.lastBoom = S.time; }
  sim.surface_at = (S, x, z) => (SS.water && S.water ? SS.water.surface(S, x, z) : W().SEA);
  const wv = { x: 0, y: 0, z: 0 }, eg = { s: 0, y: 0 };
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
      if (S.eow && SS.eow.proj_escape(S, p, dt)) { removeProj(S, p); continue; }     // P68d: left every gravity well
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
      const ddx = M.cos(S.theta), ddz = M.sin(S.theta);               // (P68c: the plane direction for the field)
      const n = M.max(1, Math.ceil(M.len2(p.vs, p.vy) * dt / 0.06)), h = dt / n;
      let done = false;
      for (let i = 0; i < n && !done; i++) {
        if (p.wet) { const dr = M.exp(-2.6 * h); p.vs *= dr; p.vy = p.vy * dr - C.G * 0.55 * h; }
        else if (S.eow) { SS.eow.proj_acc(S, wp0.x, p.y, wp0.z, ddx, ddz, eg); p.vs += eg.s * gk * h; p.vy += eg.y * gk * h; }   // P68c: the summed chunk fields
        else p.vy -= C.G * gk * h;
        const ns = p.s + p.vs * h, ny = p.y + p.vy * h, wp = P.to_world(S, ns, ny);
        if ((w.dry ? sim.arena_r(wp.x, wp.z) > DRY.FAR_R : wp.x < -OOB_SEA || wp.z < -OOB_SEA || wp.x > w.SX + OOB_SEA || wp.z > w.SZ + OOB_SEA) || ny < 0.2) {
          removeProj(S, p); log(S, `${C.WEAPONS[p.type].name} left the battlefield.`); done = true; break;
        }
        // P37 W4: a force field's dome throws the shell off into a random 3D direction (it leaves the plane)
        if (S.ffields && S.ffields.length && SS.ffield.proj_hit(S, p, P.to_world(S, p.s, p.y), wp, def)) { removeProj(S, p); done = true; break; }
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
          emit(S, 'splash', { x: wp.x, y: surf, z: wp.z, size: M.min(1.6, 0.4 + M.len2(p.vs, p.vy) * 0.05), proj: 1 });
          if (SS.water) SS.water.disturb(S, wp.x, wp.z, 0.6, -0.25 * M.min(1, M.len2(p.vs, p.vy) / 15));
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
            else { const k = M.exp(-8 * h); p.vs *= k; if (lp.sub > 0) { p.y = lp.surf; p.vy = M.max(0, p.vy) * k; p.hot += h * (0.4 + 1.6 * lp.heat); if (!P.solid2(S, ns, lp.surf)) p.s = ns; continue; } }
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
            p.vs *= fr; p.vy *= fr; p.bounces++; if (vn < -C.LAB.BANK_SPEED) p.bank++;   // (P42: hard bounces, the bank shot)
            if (bi >= 0 && SS.bodies) { const dd = P.dir(S); SS.bodies.nudge(S, SS.bodies.by_id(S, S.planeBodies[bi].body), { x: -dd.x * nn.s, y: -nn.y, z: -dd.z * nn.s }, -vn * (def.mass || 0.6) * 1.4); }
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
  /* event 'hurt' { worm, amount, src, arg, dir, dot }: src = DamageSrc (C.DS, config.js: the table gives the cause / turn rule / text), arg = i16 name
   * index for the `a % hit` / `a flying %` rows (-1 none); dot = damage over time (drowning, lava, fire, gas ...): presentation only (blood,
   * flash, shouts); the camera director never follows it (P37-3), a discrete hit (blast, shot, landing) it does */
  // a discrete hit on the active worm ends its turn (play) / its retreat (attack); P38 R1: also called by the shrapnel pass (its hurt is quiet)
  /* P38 R3: the cause of a death. hurt() stores the code of the last damage in w.cause (int); kill() logs / animates by it (C.CAUSE, config.js).
   * Blood on: only BLAST / SHOT / CRUSH / SHRED burst into gibs; the rest collapse by cause. Blood off: the dying beat's small
   * blast (PoC) only for the gib causes, the rest collapse quietly (cause FX in render/react.js). */
  const CAUSE = C.CAUSE, CAUSE_NAME = C.CAUSE_NAME, CAUSE_LOG = C.CAUSE_LOG, DS = C.DS, DSF = C.DSF, HF = C.HF;
  sim.CAUSE = CAUSE; sim.CAUSE_NAME = CAUSE_NAME;
  sim.cause_gibs = function (c) { return c === CAUSE.BLAST || c === CAUSE.SHOT || c === CAUSE.CRUSH || c === CAUSE.SHRED; };
  /* names for the `%` of a row: a projectile / weapon (index in C.WEAPON_KEYS) or a body (BODY_NAMES: prop tag or body kind) */
  const BODY_NAMES = ['barrel', 'mine', 'crate', 'girder', 'boulder', 'car', 'fridge', 'vending', 'phonebooth', 'column', 'obelisk', 'log', 'moai', 'struct', 'box', 'ball'];
  sim.BODY_NAMES = BODY_NAMES;
  sim.body_name_id = b => BODY_NAMES.indexOf(b.prop || b.kind);
  sim.weapon_name_id = key => (C.WEAPON_KEYS ? C.WEAPON_KEYS.indexOf(key) : -1);
  /* the log / presentation text of a damage source (never read by the sim itself) */
  sim.src_text = function (src, arg) {
    const t = C.DS_TEXT[src | 0] || C.DS_TEXT[0], i = t.indexOf('%');
    if (i < 0) return t;
    let nm = 'object';
    if (src === DS.FLY_PROP) nm = arg >= 0 && arg < BODY_NAMES.length ? BODY_NAMES[arg] : 'object';
    else { const k = arg >= 0 && C.WEAPON_KEYS ? C.WEAPON_KEYS[arg] : null, d = k ? C.WEAPONS[k] : null; nm = d && d.name ? d.name.toLowerCase() : 'shell'; }
    return t.slice(0, i) + nm + t.slice(i + 1);
  };
  sim.hit_ends_turn = function (S, w) {
    if (w !== S.active || w.dead) return;
    if (S.phase === 'play') { S.charging = false; S.power = 0; S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; sim.end_retreat(S); log(S, `${w.name} got hurt: the turn ends.`, 0xffb27a); }
    else if (S.phase === 'attack' && S.retreatT > 0) sim.end_retreat(S);
  };
  function hurt(S, w, dmg, src, flags, arg) {
    if (w.dead || dmg <= 0) { S.hitDir = null; return; }        // (S.hitDir is set by the caller for this hit only)
    flags = flags | 0; src = src | 0; arg = arg === undefined ? -1 : arg;
    const sf = C.DS_FLAGS[src], quiet = (flags & HF.QUIET) !== 0, dot = (flags & HF.DOT) !== 0 || (sf & DSF.DOT) !== 0;
    if (S.lightning && w.skills && w.skills.tinfoil) dmg = M.max(1, Math.round(dmg * ((C.SKILL && C.SKILL.TINFOIL_K) || 0.1)));   // P37 W4: the tinfoil hat grounds lightning
    w.hp -= dmg; w.cause = C.DS_CAUSE[src];
    emit(S, 'hurt', { wormId: w.id, amount: dmg, src, arg, dir: S.hitDir || null, dot });   // dir: where the hit pushed (blood sprays that way)
    w.hitDir = S.hitDir || null; S.hitDir = null;
    if (w.hug != null && w.hug >= 0 && SS.alien) SS.alien.on_hit(S, w, dmg, src);   // P84: a shotgun pellet / a hit over 30 HP tears a face hugger off
    // P1 (PoC activeHurt): a hit on the active worm ends its turn / its retreat; so does FIRE (user 2026-10-08, PoC: napalm,
    // burning oil / grass / props); the poc5-only steady hazards (lava, hot sand, the black hole's core) do not
    if (w === S.active && !quiet && (!dot || (sf & DSF.FIRE) !== 0) && !w.dead && !(S.phase === 'play' && (sf & DSF.NOEND_PLAY) !== 0)) sim.hit_ends_turn(S, w);   // (P38 R3: a sentry gun hit does not end the turn in play: turn denial)
    const t = P.to_plane(S, w.pos).t;
    if (quiet) { /* steady hazards (hot sand) log once on entry, not per point */ }
    else if (Math.abs(t) > C.HALF) log(S, `${w.name} took ${dmg} off-section (${Math.abs(t).toFixed(1)} m from the plane).`, 0xff9a9a);
    else log(S, `${w.name} took ${dmg} from ${sim.src_text(src, arg)}.`);
    // PoC death model: with blood on the worm bursts at once (its grave goes off in the dying beat); else it stays,
    // at 0 HP, until the aftermath settles, then dies in its own beat with a small blast (sim.step 'dying')
    if (w.hp <= 0) {
      w.hp = 0;
      if (S.settings.blood && sim.cause_gibs(w.cause)) { kill(S, w, 'gib'); w.gravePending = true; }
      else if (S.settings.blood) kill(S, w, CAUSE_NAME[w.cause] || 'beat');          // P38 R3: burn / lava / poison / fall / shock ... collapse by cause: no gib, no grave blast
      else if (!w.dying) { w.dying = true; if (w === S.active && S.phase === 'play') { S.charging = false; S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; sim.end_retreat(S); } }
      if (S.phase === 'place') SS.game.flush_dying && SS.game.flush_dying(S);
    }
  }
  sim.hurt = hurt;
  sim.blocked3 = blocked3; sim.drown = drown;                      // P89: the life jacket swim (sim/lifejacket.js) moves a floating worm and ends it
  /* continuous damage (fire, lava): accumulate, apply in whole points at most twice per second */
  sim.burn = function (S, w, dps, dt, src, flags) {
    if (w.dead) return;
    flags = flags | 0;
    if (!(flags & HF.QUIET)) w.burnT = S.time;                      // presentation: flames on the worm while this keeps happening
    w.dmgAcc += dps * dt;
    if (w.dmgAcc >= 1 && S.time - w.dmgT > 0.5) { const n = Math.floor(w.dmgAcc); w.dmgAcc -= n; w.dmgT = S.time; hurt(S, w, n, src, flags | HF.DOT); }
  };
  sim.kill = (S, w, how) => kill(S, w, how);                      // P68c (eow.js: lost in the void)
  sim.kill_now = (S, w, how) => { if (!w.dead) { kill(S, w, how); if (S.settings.blood) emit(S, 'gib', { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z }); } };
  function kill(S, w, how) {
    // the grave: its BASE (ground contact) under the worm; it falls / settles in stepGraves (user 2026-10-08: graves
    // floated where a worm died in the air or once the ground under them was blown away)
    if (SS.alien && SS.alien.burst) SS.alien.burst(S, w);          // P37: an embryo bursts out of the host
    w.dead = true; w.hp = 0; w.dying = false; w.grave = w.eaten ? null : { x: w.pos.x, y: w.pos.y - (w.foot || 0.5), z: w.pos.z, vy: 0, rest: false, landT: -1 };   // (P47: a worm the alien ate leaves no tombstone)
    if (how === 'drown') w.cause = CAUSE.DROWN; else if (how === 'crush') w.cause = CAUSE.CRUSH;
    emit(S, 'kill', { wormId: w.id, how: how || '', cause: w.cause | 0 });
    // PoC slow motion: a kill by a big blast (R >= 30 px = W >= 0.32 kg) slows the action for 0.9 s (presentation)
    if (S.lastBlastT === S.time && S.lastBlastW >= 0.32) S.slowUntil = S.time + 0.9;
    if (how === 'gib') emit(S, 'gib', { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z, dir: w.hitDir || null });
    if (w.cause !== CAUSE.ALIEN) log(S, `${w.name} ${CAUSE_LOG[w.cause | 0] || CAUSE_LOG[0]}`, 0xff9a9a);   // (alien.js logs its own line)
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
  /* P91: the turn-start guarantee. The worm that gets the turn must be able to act. The rotation skips swimmers, but a whole team in the water
   * (or a lone survivor) still hands the turn to one; and a stale swim state on dry ground (the water went away under a jacket swimmer) blocks every input
   * (controlActive, weapons, jumps all refuse a swimmer). Only states that really block control are touched, so a normal turn changes nothing. Each recovery is
   * counted (S.recov, never hashed) and emitted ('recover' { wormId, why }) so it cannot hide a real bug. */
  function recovered(S, w, why) { S.recov = (S.recov | 0) + 1; emit(S, 'recover', { wormId: w.id, why: why }); log(S, `${w.name} is back on its feet (${why}).`, 0xffa24a); }
  sim.ensure_control = function (S, w) {
    if (!w || w.dead || S.eow) return;
    if (!w.swim && !w.air && !w.drowning && (w.flip || w.hop)) { w.flip = false; w.hop = false; recovered(S, w, 'stale jump flags'); }     // (weapon_ready refuses a worm in a flip)
    if (w.swim) {
      const sw = w.swim, surf = sim.surface_at(S, w.pos.x, w.pos.z);
      if (SS.water && S.water && !(SS.water.depth(S, w.pos.x, w.pos.z) > 0.004) && !(SS.lava && S.lava && SS.lava.depth_at(S, w.pos.x, w.pos.z) > 0.01)) {   // no water under it: a stale swim
        w.swim = null; w.vel.x = w.vel.y = w.vel.z = 0; w.vs = w.vy = 0; w.air = true; w.rest = false; recovered(S, w, 'stale swim'); return;
      }
      if (sw.jk) { if (SS.jacket.haul(S, w)) recovered(S, w, 'hauled ashore'); return; }
      if (sw.land) {
        const t = landAt(S, sw.tx, sw.tz, surf);
        if (t > -1e8) { w.pos.x = sw.tx; w.pos.z = sw.tz; w.pos.y = t + w.foot + 0.02; w.swim = null; w.vel.x = w.vel.y = w.vel.z = 0; w.vs = w.vy = 0; w.air = true; w.rest = false; emit(S, 'swimout', { wormId: w.id }); recovered(S, w, 'hauled ashore'); }
      }
    }
  };
  function swimStart(S, w) {
    if (w.dead || w.drowning || w.swim) return;
    if (w.hp <= 0) { drown(S, w); return; }
    const WD = C.WORM_DYN, surf = sim.surface_at(S, w.pos.x, w.pos.z), d = P.dir(S), act = w === S.active;
    const vin = Math.abs(act ? w.vy : w.vel.y);                                          // P38 A5: the entry speed scales the splash (render only)
    w.swim = { t0: S.time, acc: 0, tick: S.time, tx: 0, tz: 0, land: false, stuck: 0 };
    for (let r = 0.25; r <= WD.SWIM_R + 1e-6 && !w.swim.land; r += 0.25) for (let q = 0; q < (act ? 2 : 16); q++) {
      const ux = act ? (q ? -d.x : d.x) : M.cos(q * Math.PI / 8), uz = act ? (q ? -d.z : d.z) : M.sin(q * Math.PI / 8);
      const x = w.pos.x + ux * r, z = w.pos.z + uz * r;
      if (landAt(S, x, z, surf) > -1e8) { w.swim.tx = x; w.swim.tz = z; w.swim.land = true; break; }
    }
    w.vel.x = w.vel.y = w.vel.z = 0; w.rope = null; w.springFall = false; w.dying = false;
    w.flip = false; w.hop = false; w.slide = false;                                  // P37-4: a back salto ends on water entry (it spun on forever in the water)
    if (act) { if (S.phase === 'play') { S.charging = false; S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; } if (sim.ctl(S, w)) sim.end_retreat(S); S.rope = null; S.hook = null; w.vs = w.vy = 0; w.air = false; w.vel.x = w.vel.y = w.vel.z = 0; }   // (end_retreat rebuilds vel from vs / vy)
    const jk = SS.jacket ? SS.jacket.enter(S, w, surf) : false;                      // P89: a life jacket inflates (sim/lifejacket.js)
    emit(S, 'splash', { x: w.pos.x, y: surf, z: w.pos.z, size: M.min(2.2, 0.8 + 0.07 * vin) });
    emit(S, 'swim', { wormId: w.id, land: w.swim.land, jk: jk ? 1 : 0 });
    if (!jk) log(S, w.swim.land ? `${w.name} fell in the water and swims for the shore!` : `${w.name} fell in the water, far from land...`, 0x7fc3ff);
  }
  // SWIM_DPS in SWIM_TICK chunks; returns false once it drowned. (No turn end: that happened as it fell in / a roping
  // worm keeps its turn.)
  function waterDamage(S, w, dt, acc) {
    const WD = C.WORM_DYN;
    acc.acc += WD.SWIM_DPS * dt;
    if (S.time - acc.tick < WD.SWIM_TICK || acc.acc < 1) return true;
    const n = Math.floor(acc.acc); acc.acc -= n; acc.tick = S.time;
    if (w.hp - n <= 0) { emit(S, 'hurt', { wormId: w.id, amount: w.hp, src: DS.DROWNING, arg: -1, dir: null, dot: true }); w.hp = 0; w.swim = null; drown(S, w); return false; }
    hurt(S, w, n, DS.DROWNING, HF.QUIET | HF.DOT);
    return true;
  }
  function swimStep(S, w, dt) {
    const WD = C.WORM_DYN, sw = w.swim;
    // the swim is scripted: no velocity survives it (a blast's push, the fall) to fling the worm on climb-out or drift
    // it while it sinks; a swimmer holds the turn (the resolve gate waits on S.lastBoom too)
    w.vel.x = w.vel.y = w.vel.z = 0; w.vs = 0; w.vy = 0;
    if (sw.jk) { if (SS.jacket.holds(S, w)) S.lastBoom = S.time; SS.jacket.step(S, w, dt); return; }   // P89: a life jacket swim (sim/lifejacket.js): no struggle, no HP drain, the turn does not wait for it for long
    S.lastBoom = S.time;
    if (!waterDamage(S, w, dt, sw)) return;
    const surf = sim.surface_at(S, w.pos.x, w.pos.z);
    const ty = surf - WD.FLOAT_D + 0.06 * M.sin((S.time - sw.t0) * 7);           // up to the surface, bobbing
    const fy = w.pos.y + M.clamp(ty - w.pos.y, -2 * dt, 1.5 * dt);
    if (!(fy < w.pos.y && blocked3(w.pos.x, fy, w.pos.z))) w.pos.y = fy;           // (resting on a shoal: not into it)
    if (sw.land) {
      const dx = sw.tx - w.pos.x, dz = sw.tz - w.pos.z, L = M.len2(dx, dz), st = M.min(L, WD.SWIM_V * dt);
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
          const left = Math.round(sw.acc); if (left > 0 && w.hp > left) hurt(S, w, left, DS.DROWNING, HF.QUIET | HF.DOT);   // the time in the water not billed yet
          w.vel.x = w.vel.y = w.vel.z = 0; w.vs = 0; w.vy = 0;
          if (w === S.active) w.air = true; else w.rest = false;
          emit(S, 'swimout', { wormId: w.id}); log(S, `${w.name} crawled out of the water.`, 0x7fc3ff);
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
    w.drowning = S.time; w.hp = 0; w.dying = false; w.springFall = false; w.flip = false; w.hop = false;
    if (w === S.active) { if (S.phase === 'play') { S.charging = false; S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; } if (sim.ctl(S, w)) sim.end_retreat(S); S.rope = null; S.hook = null; }
    w.rope = null; w.vel.y = 0;
    emit(S, 'splash', { x: w.pos.x, y: sim.surface_at(S, w.pos.x, w.pos.z), z: w.pos.z, size: 1.4 });
    emit(S, 'drown', { wormId: w.id});
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
  sim.explode = function (S, c, wp, ownerId) {
    let Wkg = wp.W != null ? wp.W : M.pow((wp.R || 3) / 3, 3);
    if (SS.lab) Wkg = SS.lab.blast_w(S, Wkg, ownerId);              // P50: the RADIUS perk
    const Wfull = Wkg, ffx = SS.ffield && S.ffields && S.ffields.length ? SS.ffield.contain_pre(S, c, Wkg, wp) : null;   // P37 W4: a blast inside a force field is contained
    if (ffx) Wkg = ffx.W;
    S.lastBoom = S.time; S.lastExplosion = { x: c.x, y: c.y, z: c.z, R: 3 * M.cbrt(Wkg) }; S.lastBlastW = Wkg; S.lastBlastT = S.time;
    let ev;
    if (SS.blast) ev = SS.blast.explode(S, c, Wkg, { owner: ownerId, kind: wp.name || 'blast', dmg: wp.dmg, boom: wp.boom || 0 });
    else { W().carve(c.x, c.y, c.z, 3 * M.cbrt(Wkg)); ev = emit(S, 'explode', { x: c.x, y: c.y, z: c.z, R: 3 * M.cbrt(Wkg), W: Wkg }); }
    S.sectionDirty = true;
    sim.pool_push(S.fx, C.LIMITS.FX, { x: c.x, y: c.y, z: c.z, t: 0 });
    if (SS.weapons) SS.weapons.blast(S, c, Wkg, wp.dmg);          // P2: devices, supply crates
    if (wp.frag && SS.shrapnel) SS.shrapnel.spawn(S, c, Wkg);       // X2: casing fragments (grenade, bazooka)
    if (ffx) SS.ffield.contain_post(S, c, Wfull, wp, ffx);
    return ev;
  };
  /* schedule a delayed explosion (chain reactions: barrels, mines) */
  sim.schedule = function (S, delay, c, Wkg, kind, src, dmg) { sim.pool_push(S.pending, C.LIMITS.PENDING, { t: S.time + delay, c: M.v3_copy(c), W: Wkg, kind, src, dmg }); S.lastBoom = S.time; };

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
      b.vel.y -= GW * sim.gravity_k(S, b) * h; const k = M.exp(-0.4 * h); b.vel.x *= k; b.vel.y *= k; b.vel.z *= k;
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
  /* P37-2: worms inside the visible section band (|t| <= C.SECT_BAND, t = distance from the gameplay plane) move ON the
   * section: the velocity component along the plane normal is dropped (blasts, slides, falls, waves), so nothing
   * slides "off view" sideways. Worms farther out (other sections, unseen) keep full 3D physics. The band is the slab
   * half thickness plus the worm radius, so every worm that is drawn in the slab (or touches it) is constrained. */
  sim.in_band = (S, p) => S.O != null && Math.abs(P.to_plane(S, p).t) <= C.SECT_BAND;
  function planeLock(S, b) {
    if (!S.O || S.phase === 'place' || !sim.in_band(S, b.pos)) return;
    const n = P.nrm(S), vn = b.vel.x * n.x + b.vel.z * n.z;
    b.vel.x -= vn * n.x; b.vel.z -= vn * n.z;
  }
  sim.plane_lock = planeLock;
  /* ---------- P88 worm-worm contact (3D bodies): a worm is a solid ball of WORM_R for every other worm ----------
   * The ACTIVE worm already met the others as discs in its plane (planeBodies: it climbs over a worm, stands on it, lands on its head). The worms that are not
   * under control (body3D) used to ignore each other completely: a worm that stood on another when its turn ended fell THROUGH it, and worms that bunched up
   * overlapped for good. Now every worm obeys the same ball contact: it lands on / rolls off / rests on a head (contact normal.y >= STACK_NY), is pushed out of a
   * flank, and resting worms that overlap side by side slide apart (gently, never into rock, never off their footing). Presentation (the fold under the weight, the
   * feet on the back) reads sim.worm_under(S, w): the worm a worm stands on. No state of its own: pure geometry over the worm positions, so it is the same on every peer.
   * (EOW has its own body step: p86's eow.js may call these.) */
  function wormUnder(S, b) {
    if (S.eow || b.dead || b.drowning || b.swim) return null;
    const R2 = 2 * C.WORM_R;
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i]; if (o === b || o.dead || o.drowning || o.swim) continue;
      const dx = b.pos.x - o.pos.x, dy = b.pos.y - o.pos.y, dz = b.pos.z - o.pos.z, d = M.len3(dx, dy, dz);
      if (dy > 0.3 && d > 1e-6 && dy / d >= WD.STACK_NY && Math.abs(d - R2) <= WD.STACK_GAP) return o;
    }
    return null;
  }
  sim.worm_under = wormUnder;
  // the contact of a point (the body centre) with the worm balls: fills nv (unit normal away from the worm) and returns that worm, or null
  function wormHit(S, b, x, y, z, nv) {
    const R2 = 2 * C.WORM_R;
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i]; if (o === b || o.dead || o.drowning || o.swim) continue;
      const dx = x - o.pos.x, dy = y - o.pos.y, dz = z - o.pos.z, d = M.len3(dx, dy, dz);
      if (d >= R2) continue;
      if (d < 1e-6) { nv.x = 0; nv.y = 1; nv.z = 0; } else { nv.x = dx / d; nv.y = dy / d; nv.z = dz / d; }
      return o;
    }
    return null;
  }
  // PoC resolveWormContacts: a hard landing on a head shoves the lower worm aside (dir = the horizontal direction in the world)
  function shoveWorm(S, o, dx, dz, imp) {
    if (o.shoveT > S.time) return;
    const v = M.clamp(imp * WD.SHOVE_K, WD.SHOVE_MIN, WD.SHOVE_MAX);
    o.rest = false; o.vel.x += dx * v; o.vel.z += dz * v; o.vel.y = M.max(o.vel.y, WD.SHOVE_UP); o.slide = true; o.shoveT = S.time + WD.SHOVE_COOL;
    if (o.rope) o.rope = null;
  }
  // resting worms that overlap side by side slide apart (b is moved; the other, if it is a resting worm too, moves by the same amount in its own turn)
  function wormSeparate(S, b, dt) {
    const w = W(), R2 = 2 * C.WORM_R;
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i]; if (o === b || o.dead || o.drowning || o.swim) continue;
      const dx = b.pos.x - o.pos.x, dy = b.pos.y - o.pos.y, dz = b.pos.z - o.pos.z, hh = M.len2(dx, dz);
      if (M.len3(dx, dy, dz) >= WD.SEP_D || Math.abs(dy) >= C.WORM_R) continue;
      let ux, uz; if (hh > 1e-3) { ux = dx / hh; uz = dz / hh; } else { const a = b.id * 2.399963; ux = M.cos(a); uz = M.sin(a); }
      const need = Math.sqrt(M.max(0, R2 * R2 - dy * dy)) - hh, share = o.rest && o !== S.active ? 0.5 : 1, m = M.min(WD.SEP_V * dt, need * share + 0.002);
      const nx = b.pos.x + ux * m, nz = b.pos.z + uz * m; let y = b.pos.y;
      for (let k = 0; k < 4 && w.sample(nx, y - b.foot, nz) > 0; k++) y += 0.03;                // a rising slope: follow it a little
      if (w.sample(nx, y - b.foot, nz) > 0 || blocked3(nx, y, nz) || !(w.sample(nx, y - b.foot - 0.06, nz) > 0)) continue;   // rock in the way, or no footing there: stay
      b.pos.x = nx; b.pos.y = y; b.pos.z = nz;
    }
  }
  // b meets worm o with the contact normal nv (away from o): leaves, rolls off, or rests on its head. True = b is at rest (the substep loop ends).
  function wormLand(S, b, o, nv, vn, nx, ny, nz) {
    const w = W(), R2 = 2 * C.WORM_R;
    if (vn >= 0) { b.pos.x = nx; b.pos.y = ny; b.pos.z = nz; return false; }              // moving apart already
    const px = o.pos.x + nv.x * R2, py = o.pos.y + nv.y * R2, pz = o.pos.z + nv.z * R2;    // pushed out to touching (unless that is rock)
    if (!(w.sample(px, py - b.foot, pz) > 0) && !blocked3(px, py, pz)) { b.pos.x = px; b.pos.y = py; b.pos.z = pz; }
    const imp = -vn;
    if (nv.y >= WD.STACK_NY) {                                                             // on the head: a hard landing shoves the lower worm, then stops dead (no damage: PoC)
      if (imp >= WD.HEAD_SHOVE_V) { const hh = M.len2(nv.x, nv.z); shoveWorm(S, o, hh > 1e-3 ? -nv.x / hh : 1, hh > 1e-3 ? -nv.z / hh : 0, imp); }
      if (imp > 3) emit(S, 'land', { wormId: b.id, x: b.pos.x, y: b.pos.y - b.foot, z: b.pos.z, speed: imp, mat: w.mat_at(o.pos.x, o.pos.y - o.foot - 0.2, o.pos.z) });
      b.vel.x = b.vel.y = b.vel.z = 0; b.rest = true; b.slide = false; b.stillT = 0; b.squash = S.time;
      return true;
    }
    // a flank / the shoulder: no bounce, the tangential velocity is kept (it rolls off the ball and lands beside it)
    const tx = b.vel.x - vn * nv.x, ty = b.vel.y - vn * nv.y, tz = b.vel.z - vn * nv.z;
    b.vel.x = tx * WD.FRIC; b.vel.y = ty * WD.FRIC; b.vel.z = tz * WD.FRIC; b.slide = true;
    return false;
  }
  function body3D(S, b, dt) {
    if (S.eow) return SS.eow.body3d(S, b, dt);                     // P68c
    const w = W(), foot = b.foot;
    // LV3: afloat on open lava: ride the surface flow, held at the lava floor (never 'at rest': the lava moves)
    const lf0 = lavaFloor(S, b.pos.x, b.pos.z, b);
    if (lf0 > -1e8 && b.pos.y - foot < lf0 - C.LAVA.DEEP) {                  // deep in a lava column: rises slowly (viscous)
      b.rest = false; b.vel.x = b.vel.z = 0; b.vel.y = 0; b.pos.y = M.min(lf0 + foot, b.pos.y + 1.5 * dt); return;
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
    if (b.rest) {
      if (w.sample(b.pos.x, b.pos.y - foot - 0.06, b.pos.z) > 0 || Math.abs(deckFloor(S, b.pos.x, b.pos.y - foot, b.pos.z) - (b.pos.y - foot)) < 0.08) { if (b !== S.active) wormSeparate(S, b, dt); return; }
      if (wormUnder(S, b)) return;                                             // P88: standing on another worm
      b.rest = false;
    }
    // PoC dynamics in 3D (worm gravity, head-on / glancing landings, dizziness, skids with bounce 0.3 / friction 0.72)
    const sp0 = M.len3(b.vel.x, b.vel.y, b.vel.z), y0 = b.pos.y;
    if (sp0 > WD.V_MAX) { const k = WD.V_MAX / sp0; b.vel.x *= k; b.vel.y *= k; b.vel.z *= k; }   // P38 R9: terminal velocity
    const n = M.max(1, Math.ceil(M.len3(b.vel.x, b.vel.y, b.vel.z) * dt / 0.08)), h = dt / n, nv = { x: 0, y: 0, z: 0 };
    let touched = false;
    for (let i = 0; i < n && !b.rest; i++) {
      planeLock(S, b);
      b.vel.y -= GW * sim.gravity_k(S, b) * h;
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
      const wo = hit ? null : wormHit(S, b, nx, ny, nz, nv);                    // P88: another worm's ball
      if (!hit && !wo) { b.pos.x = nx; b.pos.y = ny; b.pos.z = nz; continue; }
      touched = true;
      const vn = b.vel.x * nv.x + b.vel.y * nv.y + b.vel.z * nv.z;
      if (wo) { if (wormLand(S, b, wo, nv, vn, nx, ny, nz)) break; continue; }
      if (vn >= 0) { b.pos.x = nx; b.pos.z = nz; continue; }
      const imp = -vn, sp = M.len3(b.vel.x, b.vel.y, b.vel.z), tx = b.vel.x - vn * nv.x, ty = b.vel.y - vn * nv.y, tz = b.vel.z - vn * nv.z;
      const along = M.len3(tx, ty, tz) / M.max(1e-6, sp);
      if (imp > WD.FALL_SAFE && nv.y > 0.2) {
        const head = along < WD.HEAD_ALONG, dmg = head ? M.min(WD.HEAD_MAX, Math.round((imp - WD.FALL_SAFE) * WD.HEAD_K) + WD.HEAD_ADD) : M.min(WD.GLANCE_MAX, Math.round((imp - WD.FALL_SAFE) * WD.GLANCE_K));
        emit(S, 'land', { wormId: b.id, x: b.pos.x, y: b.pos.y - foot, z: b.pos.z, speed: imp, mat: w.mat_at(b.pos.x, b.pos.y - foot - 0.2, b.pos.z), hard: 1 });
        b.landDmg = dmg;                                                         // (applied after the rebound below)
        if (head) { const up = M.min(WD.HEAD_UP_MAX, WD.HEAD_UP_K * imp); b.vel.x = nv.x * up; b.vel.y = nv.y * up; b.vel.z = nv.z * up; b.dizzyUntil = S.time + WD.DIZZY; b.squash = S.time; emit(S, 'dizzy', { wormId: b.id}); }
        else { b.vel.x = tx * WD.FRIC - nv.x * vn * WD.BOUNCE; b.vel.y = ty * WD.FRIC - nv.y * vn * WD.BOUNCE; b.vel.z = tz * WD.FRIC - nv.z * vn * WD.BOUNCE; }
        b.slide = true;
        landHurt(S, b, b.landDmg);
      } else if (!b.slide && nv.y > WD.FIRM_NY) {                              // a firm landing stops dead
        if (imp > 3) emit(S, 'land', { wormId: b.id, x: b.pos.x, y: b.pos.y - foot, z: b.pos.z, speed: imp, mat: w.mat_at(b.pos.x, b.pos.y - foot - 0.2, b.pos.z) });
        b.vel.x = b.vel.y = b.vel.z = 0; b.rest = true; b.stillT = 0; landHurt(S, b, 0);
      } else { b.vel.x = tx * WD.FRIC - nv.x * vn * WD.BOUNCE; b.vel.y = ty * WD.FRIC - nv.y * vn * WD.BOUNCE; b.vel.z = tz * WD.FRIC - nv.z * vn * WD.BOUNCE; }
      // stand on top of the ground (never inside it)
      // (P38 R9: only while the lift does not push the body centre deeper into the rock: a worm thrown into a slot used to climb 1.2 m per step into the ceiling)
      let y = b.pos.y; const c0 = w.sample(b.pos.x, y, b.pos.z);
      for (let k = 0; k < 30 && (w.sample(b.pos.x, y - foot, b.pos.z) > 0 || (df > -1e8 && y - foot < df)); k++) { if (w.sample(b.pos.x, y + 0.04, b.pos.z) > M.max(c0, 0) + 0.15) break; y += 0.04; }
      b.pos.y = y;
    }
    // a skidding worm comes to rest when slow and supported for 0.45 s (PoC still), or a soft touch
    if (!b.rest && touched) {
      const sp = M.len3(b.vel.x, b.vel.y, b.vel.z);
      if (sp < WD.STILL_V) { b.stillT = (b.stillT || 0) + dt; if (b.stillT > WD.STILL_T || (!b.slide && sp < WD.SOFT_V)) { b.vel.x = b.vel.y = b.vel.z = 0; b.rest = true; b.slide = false; b.stillT = 0; landHurt(S, b, 0); } }
      else b.stillT = 0;
    }
    if (!b.rest && !b.dead) pin_step(S, b, y0, b.vel.y, dt);          // P38 R9: wedged in rock (see pin_step)
  }

  /* environmental hazards for every worm: water (waves, drowning), lava, fire */
  function hazards(S, wm, dt) {
    const w = W();
    if (S.eow) SS.eow.hazard(S, wm, dt);                           // P68c: the core and the void
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
        emit(S, 'wash', { wormId: wm.id, x: wm.pos.x, y: surf, z: wm.pos.z }); log(S, `A wave throws ${wm.name} off the shore!`, 0x7fc3ff);
      }
    }
    // dry worlds: lost far out in the open desert (beyond FAR_R; no blast throws a worm that far, a safety net)
    if (w.dry && sim.arena_r(wm.pos.x, wm.pos.z) > DRY.FAR_R) { lost(S, wm); return; }
    // dry worlds: the sand beyond the play area is hot (1 HP / 5 s while touching it; one log line per visit)
    if (w.dry && sim.arena_r(wm.pos.x, wm.pos.z) > S.playR && w.sample(wm.pos.x, wm.pos.y - wm.foot - 0.15, wm.pos.z) > 0) {
      if (!(S.time - wm.hotT < 2)) {
        emit(S, 'hotsand', { wormId: wm.id, x: wm.pos.x, y: wm.pos.y, z: wm.pos.z });
        log(S, `${wm.name} is on hot sand: -1 HP every 5 s until back in the dunes' heart.`, 0xffb27a);
      }
      wm.hotT = S.time;
      sim.burn(S, wm, DRY.HOT_DPS, dt, DS.HOT_SAND, HF.QUIET);
    }
    const sdd = SS.game.final_drain(S);                            // P38 R9: the final stage of sudden death (game.js)
    if (sdd > 0) sim.burn(S, wm, sdd, dt, DS.SUDDEN_DEATH, HF.QUIET);
    const m = w.mat_at(wm.pos.x, wm.pos.y - 0.62, wm.pos.z);
    if (m === MAT.LAVA) sim.burn(S, wm, C.LAVA_DPS, dt, DS.LAVA);
    // open lava (LV3): the worm floats. Its immersion relaxes toward the buoyancy equilibrium RHO_WORM / RHO of its
    // height, minus the share of its weight the skin's yield stress carries (cool crust holds it up), at a viscous
    // rate; it burns by immersion and temperature (a cold crust does not). Nothing light is engulfed any more.
    const LA = C.LAVA, dep = SS.lava && S.lava ? SS.lava.depth_at(S, wm.pos.x, wm.pos.z) : 0;
    if (dep > 0.01 && wm.pos.y - wm.foot <= lavaFloor(S, wm.pos.x, wm.pos.z, wm) + 0.1) {     // resting on the lava
      const T = SS.lava.temp_at(S, wm.pos.x, wm.pos.z), cool = M.clamp(1 - T, 0, 1);
      const yl = LA.YIELD * M.exp(LA.YIELD_K * cool), sup = M.clamp(LA.RHO * yl / (LA.RHO_WORM * C.WORM_H), 0, 1);
      const eq = M.min(dep, LA.RHO_WORM / LA.RHO * C.WORM_H * (1 - sup)), tau = LA.SINK_TAU * M.exp(LA.NU_K * cool);
      wm.lsink = (wm.lsink || 0) + (eq - (wm.lsink || 0)) * M.min(1, dt / tau);
    } else wm.lsink = 0;
    const lv = sim.lava_contact(S, wm.pos.x, wm.pos.y - wm.foot, wm.pos.z, lc);
    if (lv.sub > 0 && lv.heat > 0) sim.burn(S, wm, C.LAVA_DPS * lv.heat * (0.5 + M.clamp(lv.sub / 0.4, 0, 1)), dt, DS.LAVA);
    // burning grass (same once-per-step rule as scatter's scorch: oil + grass do not stack)
    if (SS.veg && SS.veg.fire_at(S, wm.pos.x, wm.pos.y, wm.pos.z) > 0) {
      const k = S.tick;
      if (wm.fireStep !== k) { wm.fireStep = k; wm.fireT = S.time; sim.burn(S, wm, C.FIRE_DPS, dt, DS.BURNING_GRASS); }
    }
  }

  function settled(S) {
    if (S.pending.length) return false;
    if (!S.worms.every(w => w.dead || (w.swim && w.swim.jk && !SS.jacket.holds(S, w)) || (!w.drowning && !w.swim && (w.rest || (w === S.active && !w.air) || (w.rope && M.len3(w.vel.x, w.vel.y, w.vel.z) < 0.4))))) return false;
    if (S.hook) return false;
    if (SS.bodies && !SS.bodies.settled(S)) return false;
    if (SS.scatter && !SS.scatter.settled(S)) return false;
    if (SS.shrapnel && !SS.shrapnel.settled(S)) return false;
    if (SS.spatter && !SS.spatter.settled(S)) return false;
    if (SS.weapons && !SS.weapons.settled(S)) return false;
    if (SS.alien && SS.alien.busy(S)) return false;                // P37: a face hugger / alien on the move
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
    if (d) { S.phase = 'dying'; S.dyingW = d; S.dyingT = DIE.BEAT; S.dyingGrave = false; emit(S, 'dying', { wormId: d.id}); return true; }
    return false;
  }
  function stepDying(S, dt) {
    S.dyingT -= dt;
    if (S.dyingT > 0) return;
    const w = S.dyingW; S.dyingW = null;
    if (S.dyingGrave) { w.gravePending = false; if (w.grave) { w.grave.landT = -1; w.grave.blown = true; } if (w.grave) sim.explode(S, { x: w.grave.x, y: w.grave.y + 0.2, z: w.grave.z }, { W: DIE.W_GRAVE, dmg: DIE.D_GRAVE, name: 'an exploding grave' }, null); }
    else sim.die_now(S, w);
    S.phase = 'attack'; S.attackStart = S.time; S.lastBoom = S.time; S.retreatT = 0;
  }
  /* graves are small falling objects: they drop (worm gravity), land on the ground / a deck / the sea floor, sit 6 cm sunk in
   * the soil, and fall again when the ground under them is blown away */
  function stepGraves(S, dt) {
    const w = W();
    for (const o of S.worms) {
      const g = o.grave; if (!o.dead || !g) continue;
      if (S.eow) { SS.eow.grave(S, o, g); continue; }                 // P68c: graves float where the worm died
      if (g.rest) {
        const df = deckFloor(S, g.x, g.y + 0.1, g.z);
        if (w.sample(g.x, g.y - 0.12, g.z) > 0 || Math.abs(df - g.y) < 0.12) continue;
        g.rest = false; g.vy = 0;
      }
      const wet = g.y < sim.surface_at(S, g.x, g.z);
      g.vy = M.max(wet ? -1.5 : -45, g.vy - C.G_WORM * dt);   // the worms' (PoC) gravity: at 9.81 it looked weightless next to them
      const n = M.max(1, Math.ceil(Math.abs(g.vy) * dt / 0.05)), h = dt / n;
      for (let i = 0; i < n && !g.rest; i++) {
        const ny = g.y + g.vy * h, df = deckFloor(S, g.x, g.y + 0.05, g.z);
        if (df > -1e8 && ny <= df) { g.y = df; g.rest = true; break; }
        if (w.sample(g.x, ny + 0.06, g.z) > 0 || ny < 0.3) {          // ground: settle with the base 6 cm in the soil
          let y = M.max(ny, 0.3); for (let k = 0; k < 40 && w.sample(g.x, y + 0.06, g.z) > 0; k++) y += 0.05;
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
  // the dying beat's end (blood off): the PoC's small blast ('a dying worm') for the gib causes, a cause collapse otherwise
  sim.die_now = function (S, w) {
    if (w.dead) return; const c = { x: w.pos.x, y: w.pos.y, z: w.pos.z }, gib = sim.cause_gibs(w.cause | 0) || !w.cause;
    kill(S, w, gib ? 'beat' : CAUSE_NAME[w.cause]);
    if (gib) sim.explode(S, c, { W: DIE.W_WORM, dmg: DIE.D_WORM, name: 'a dying worm' }, null);
  };
  const NOINPUT = sim.input_make();
  /* Input sanitising (P38 D2): a hostile peer must not be able to freeze or poison the sim with one packet (move 1e9 made
   * ~1e9 sub-steps, ts 1e300 looped forever). Every numeric field is forced into its legal range (NaN / Infinity -> 0);
   * the weapon key must be an arsenal key. Table = { field, lo, hi, int }: in a port, clamp the fields of the Input struct.
   * Legit ranges: held axes / edge flags -1..1 (or 0..1), rotate_mouse = accumulated right-drag pixels * 0.6 (<< 200),
   * fuse 0..5, align_id = worm id + 1, ts / ty = plane coordinates in metres (the world is < 2000 m wide). */
  const IN_LIM = [['move', -1, 1], ['up', -1, 1], ['down', -1, 1], ['jump', -1, 1], ['backflip', -1, 1], ['jet', -1, 1], ['fire_pressed', -1, 1], ['fire_held', -1, 1],
    ['rotate', -1, 1], ['rotate_mouse', -200, 200], ['fine', -1, 1], ['align_step', -1, 1], ['align_crate', -1, 1], ['align_refocus', -1, 1], ['align_id', 0, 64],
    ['end_turn', -1, 1], ['inspect', -1, 1], ['fuse', 0, 5], ['tgt', -1, 1], ['ts', -4000, 4000], ['ty', -4000, 4000], ['sdir', -1, 1], ['gang', -1, 1], ['gturn', -1, 1],
    ['drop', -1, 1], ['wsel', -1, 1], ['aimset', -1, 1], ['aimv', -4, 4], ['face', -1, 1], ['adj', -1, 1], ['gear', 0, 8],
    ['dbk', 0, 99], ['dbp0', 0, 1000], ['dbp1', 0, 1000], ['dbs', -4000, 4000], ['dby', -4000, 4000], ['dbsky', 0, 1]];
  sim.sanitize_input = function (inp) {
    for (let i = 0; i < IN_LIM.length; i++) {
      const L = IN_LIM[i], k = L[0], v = inp[k];
      if (typeof v !== 'number') { inp[k] = v === true ? 1 : 0; continue; }      // (tests pass booleans)
      if (v >= L[1] && v <= L[2]) continue;
      inp[k] = v < L[1] ? L[1] : v > L[2] ? L[2] : 0;       // (NaN fails both comparisons: 0)
    }
    if (typeof inp.weapon !== 'string' || (inp.weapon !== '' && !C.ARSENAL[inp.weapon])) inp.weapon = '';
    return inp;
  };
  /* ---------- main fixed step ---------- */
  sim.step = function (S, inp, dt) {
    S.tick++; S.time += dt;       // tick: the integer step count (stagger keys, once-per-step guards; exact in a port)
    let a = S.active;
    const dbgInp = inp;                                           // P49: the human's input keeps its debug drop even when a CPU worm's plan replaces `inp` below
    // 9a: a CPU team's worm is driven by sim/ai.js (deterministic; the human input is ignored on its turn)
    if (S.phase === 'play' && a && !a.dead && SS.ai && SS.game.is_cpu(S, a.team)) inp = SS.ai.control(S, a, dt);                                // (a cleared Input struct, filled by the plan)
    sim.sanitize_input(inp);
    if (inp.reset) { sim.reset(S, S.settings); return; }
    if (inp.gear && SS.gear) SS.gear.input(S, inp);               // P89: the rescue gear toggle (HUD button / key)
    if (dbgInp.dbk && SS.debug) { if (dbgInp !== inp) sim.sanitize_input(dbgInp); SS.debug.apply(S, dbgInp); }     // P49: the debug toolbox's drop (only while S.debugOn)
    if (S.phase === 'perk' && SS.lab) {                           // P50: the perk draft (a pick may start the first turn)
      SS.lab.perk_step(S, inp, dt); a = S.active;
      inp.weapon = ''; inp.fuse = 0; inp.adj = 0; inp.fire_pressed = 0; inp.fire_held = 0; inp.jump = 0; inp.backflip = 0; inp.end_turn = 0; inp.wsel = 0; inp.drop = 0;   // (R11: the key / click that picked a card (1 / 2 / 3 are weapon keys too) is spent: it must not also act in the first turn that the last pick starts)
    }
    if (S.phase === 'place') {                                    // P13: deployment (the world runs, worms are placed)
      if (inp.rotate || inp.rotate_mouse) sim.rotate_by(S, (inp.rotate + inp.rotate_mouse) * (inp.fine ? 0.25 : 1) * C.ROT_SPEED * dt);
      SS.game.place_step(S, inp, dt);                             // (the world steps below; control needs 'play')
    }
    if (S.phase === 'play' && a && !a.dead) {
      if (inp.align_step) sim.align_next(S, inp.align_step);
      if (inp.align_crate) sim.align_crate(S);
      if (inp.align_refocus) sim.align_to(S, S.target);
      if (inp.align_id) sim.align_to(S, S.worms.find(w => w.id === inp.align_id - 1));
      if (inp.end_turn) { log(S, `${a.name} ends the turn.`); sim.end_turn(S, 0.3); }
      // P34: re-read the active worm after a switch: the old one must not be driven in the new worm's section (its
      // plane (s, y) mapped onto the new plane teleported it tens of metres, into a river on volcanic 6721)
      if (inp.wsel && sim.switch_worm(S)) a = S.active;
    } else if (inp.align_step || inp.align_crate || inp.align_refocus || (inp.rotate && S.phase !== 'over')) locked(S);
    let rot = 0;
    if (S.phase === 'play') rot = inp.rotate + inp.rotate_mouse;
    if (S.thetaGoal != null && S.phase === 'play') {
      const diff = M.wrap_angle(S.thetaGoal - S.theta), st = C.ALIGN_SPEED * dt;
      if (Math.abs(diff) <= st) { sim.rotate_by(S, diff); S.thetaGoal = null; } else if (!sim.rotate_by(S, Math.sign(diff) * st)) S.thetaGoal = null;   // (window edge, D6)
    }
    if (rot) { S.thetaGoal = null; sim.rotate_by(S, rot * (inp.fine ? 0.25 : 1) * C.ROT_SPEED * dt); }

    // world subsystems
    if (SS.weather) SS.weather.step(S, dt);
    if (SS.lab) SS.lab.step(S, dt);                               // P42: wind gusts, meteor impacts
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
      P.pb_add(S.planeBodies, 0, q.s, o.pos.y, 0, 0, C.WORM_R, -1, -1, -1, -1, o.id, false);
    }
    unpinOthers(S);                                               // P88: a prop on a worm that is not under control
    if (S.phase === 'play' && a && !a.dead && !a.swim) controlActive(S, a, dt, inp, false);
    else if (S.phase === 'attack' && S.retreatT > 0 && a && !a.dead && !a.swim && !S.dig) controlActive(S, a, dt, SS.game.is_cpu(S, a.team) ? (SS.ai && SS.ai.retreat ? SS.ai.retreat(S, a, NOINPUT) : NOINPUT) : inp, true);
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
    if (S.eow) SS.eow.step(S, dt);                                  // P68d: shots lost to space keep drifting for the view
    if (SS.lava && !S.eow) SS.lava.step(S, dt);                    // (P68c: the magma pockets stay put in space)
    if (SS.alien) SS.alien.step(S, dt);                           // P37: eggs, face huggers, the alien, acid
    for (const w of S.worms) {
      if (w.dead) continue;
      unentomb(S, w);                                             // P88: buried at rest
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
    S.inspect += M.clamp((inp.inspect || S.time < (S.forceInspect || 0) ? 1 : 0) - S.inspect, -dt / 0.35, dt / 0.35);   // (P37 W4: S.forceInspect = the force field's full 3D view)
    if (W().flat) SS.dim2d.constrain(S);               // P68a: everything that can leave the plane goes back onto it (and no 3D inspection)
  };
})(window.SS = window.SS || {});
