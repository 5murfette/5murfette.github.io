/* sim/state.js — the game state's data: the Input struct (its fields, defaults, copy and clamp table), the worm and
 * state
 * makers (worm_make; init_state: teams, worms, spawns, the first turn), snapshot / restore, and the state hash.
 * State: S itself (init_state declares every field; worm_make every worm field).
 * C layout: struct Input (INPUT_FIELDS order), struct Worm (worm_make), struct GameState (init_state).
 * API: INPUT_FIELDS, input_make, input_clear, input_copy, sanitize_input, worm_make, init_state, snapshot, restore,
 * hash. Determinism: hash mixes the hashed settings (HASH_SETTINGS) and then the state in one fixed order; no RNG here.
 * It also declares the namespaces of the sim core (state, spawn, damage, swim, worm, turn, sim): it loads first. */
(function (SS) {
  'use strict';
  // the namespaces of the sim core, one per file (index.html loads them in this order: state, spawn, damage, swim,
  // worm, turn, sim): declared here, before any of them, so that each file can bind the others at load time and call
  // them at run time
  SS.state = {};
  SS.spawn = {};
  SS.damage = {};
  SS.swim = {};
  SS.worm = {};
  SS.turn = {};
  SS.sim = {};
  const ST = SS.state;
  const C = SS.CFG;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const M = SS.math;
  const W = SS.world;
  const sim = SS.sim;
  const SP = SS.spawn;
  const TN = SS.turn;

  /* ---------- Input struct (filled by the platform layer or the network each step) ---------- */
  // the fields of the struct in declaration order (C: struct Input; input_copy is a plain struct assignment there)
  const INPUT_FIELDS = ['move', 'up', 'down', 'jump', 'backflip', 'fire_pressed', 'fire_held', 'weapon', 'rotate', 'rotate_mouse', 'fine',
    'align_step', 'align_crate', 'align_refocus', 'align_id',
    'end_turn', 'reset', 'inspect', 'fuse', 'tgt', 'ts', 'ty', 'sdir', 'gang', 'gturn', 'drop', 'wsel', 'aimset', 'aimv', 'face', 'adj',
    'gear', 'jet', 'dbk', 'dbp0', 'dbp1', 'dbs', 'dby', 'dbsky'];
  ST.INPUT_FIELDS = INPUT_FIELDS;
  /* reset an Input struct to its defaults in place (the CPU reuses one struct per step: no allocation) */
  ST.input_clear = inp => {
    for (let i = 0; i < INPUT_FIELDS.length; i++) inp[INPUT_FIELDS[i]] = 0;
    inp.weapon = '';
    return inp;
  };
  ST.input_copy = (dst, src) => {
    for (let i = 0; i < INPUT_FIELDS.length; i++) dst[INPUT_FIELDS[i]] = src[INPUT_FIELDS[i]];
    return dst;
  };
  ST.input_make = () => ({
    move: 0, up: 0, down: 0,          // held axes
    jump: 0, backflip: 0, jet: 0,     // edge-triggered (jet: the team's jetpack switch in space)
    fire_pressed: 0, fire_held: 0,
    weapon: '',                       // '' or weapon key to select
    rotate: 0, rotate_mouse: 0, fine: 0,
    // align_id = worm id + 1 (top map click)
    align_step: 0, align_crate: 0, align_refocus: 0, align_id: 0, end_turn: 0, reset: 0, inspect: 0,
    // (the PoC arsenal) fuse 1-5 (0 = unchanged); tgt = 1 sets the target point (ts, ty) in plane coords (target
    // weapons fire on it when fire_pressed comes with it; homing keeps it); sdir -1 / 1 strike side; gang +-1 girder
    // angle step; drop = drop the selected weapon from the rope
    fuse: 0, tgt: 0, ts: 0, ty: 0, sdir: 0, gang: 0, gturn: 0, drop: 0,
    wsel: 0,                          // PoC worm select: switch to the team's next worm (option, first 10 s)
    aimset: 0, aimv: 0, face: 0,      // PoC mouse aim: set the aim angle (rad) and facing (-1 / 1) from the cursor
    gear: 0,                          // toggle the active team's rescue gear kind + 1 (sim/gear.js: 1 = life jacket)
    // + / - step (+1 / -1) of the selected weapon's parameter: fuse 0.5-5 s, mortar burst height 1-5 m, planted
    // mine fuse 0-3 s
    adj: 0,
    // the debug toolbox (sim/debug.js; obeyed only while S.debugOn, never online): dbk = drop kind (DB.KIND, 0 none),
    // dbp0 / dbp1 = its parameters, (dbs, dby) = the clicked point on the section, dbsky = 1 drop from the sky
    dbk: 0, dbp0: 0, dbp1: 0, dbs: 0, dby: 0, dbsky: 0
  });

  /* 9b: a hash of the game state for the lockstep desync check (cheap: worms, bodies, time, turn, RNG, world
   * version) */
  /* instant replay support: a full copy of the deterministic state (S + the voxel world's arrays) and its
   * restore; the platform re-runs the recorded inputs from it. W.version is kept MONOTONIC across a restore (the
   * renderers rebuild what a version bump marks: restore marks the whole lattice) and S.verBase follows it, so hashes
   * (which use version - verBase) match. ~20 MB per snapshot (d f32 + mat + heat + tops). */
  const DIRTY_MODS = ['water', 'veg', 'weather'];      // sim modules with a pending edit rect (W.listeners)
  ST.snapshot = function (S) {
    const w = W;
    const dirty = {};
    for (const m of DIRTY_MODS)
      if (SS[m] && SS[m].dirty_get) dirty[m] = SS[m].dirty_get();
    return { S: structuredClone(S), d: w.d.slice(), mat: w.mat.slice(), heat: w.heat.slice(), top: w.top.slice(), topJ: w.topJ.slice(), crack: w.crack ? w.crack.slice() : null, sx: w.SX, sea: w.SEA, ver: w.version, dirty };   // R7-OK (replay snapshot: platform helper, never in a step)
  };
  ST.restore = function (S, snap) {
    const w = W, c = structuredClone(snap.S);   // R7-OK
    for (const k of Object.keys(S)) if (!(k in c)) delete S[k];   // R7-OK
    Object.assign(S, c);
    if (snap.sx && snap.sx !== w.SX) w.resize(snap.sx, snap.sx);                  // a snapshot of a map of another size
    w.d.set(snap.d);
    w.mat.set(snap.mat);
    w.heat.set(snap.heat);
    w.top.set(snap.top);
    w.topJ.set(snap.topJ);
    w.SEA = snap.sea;                                                 // (sudden death raises the sea)
    w.crack = snap.crack ? snap.crack.slice() : null;
    if (SS.cracks) SS.cracks.bump(w);
    // quiet: the renderers rebuild everything, the sim modules get their own pending rects back (a whole-lattice
    // refresh would re-derive every water column, and the replay's water / floes would drift off the live run)
    w.mark_all(true); S.verBase = (S.verBase || 0) + (w.version - snap.ver);   // hash: version - verBase unchanged
    for (const m of DIRTY_MODS)
      if (SS[m] && SS[m].dirty_set) SS[m].dirty_set(snap.dirty ? snap.dirty[m] : null);
    S.sectionDirty = true;
  };
  /* the hash accumulator: ONE module-level u32 (C: static u32 HH) and a plain function; the sub-module hash(S, mix)
   * calls receive `mix` (no closure over a local) */
  let HH = 0;
  // quantise to 1/1000: floor(v * 1000 + 0.5) (round half UP, the same in C: floorf), wrapped to an i32 by modular
  // arithmetic (no UB beyond +-2^31 in C), and NaN / +-Inf mix their own constants (before: NaN became 0 and hid a NaN
  // desync)
  const mix = v => {
    let q = Math.floor(v * 1000 + 0.5);
    if (q !== q) q = 0x7fc00001;
    else if (q === Infinity) q = 0x7f800001;
    else if (q === -Infinity) q = 0x7f800003;
    else q = (q - 4294967296 * Math.floor(q / 4294967296)) | 0;
    HH = Math.imul(HH ^ q, 16777619) >>> 0;
  };

  // a string's hash (the phase, the weapon, string settings)
  function str(v) {
    v = String(v);
    let t = 7;
    for (let i = 0; i < v.length; i++) t = Math.imul(t ^ v.charCodeAt(i), 16777619);
    return t >>> 0;
  }
  function sum(a) {
    let t = 0;
    for (let i = 0; i < a.length; i++) t += a[i];
    return t;
  }
  /* sim.hash: the whole game state in one fixed order, section by section (each section below keeps its mix order; a
   * module's own state is mixed by its hash(S, mix), some only once their feature acted, so the hashes of games without
   * it stay what they were) */
  ST.hash = function (S) {
    HH = 2166136261;
    hash_core(S);
    hash_weapons(S);
    hash_modules(S);
    hash_fluids(S);
    hash_turn(S);
    hash_world();
    return HH;
  };
  // time, turn, RNG, world version (relative: it counts across resets), section angle; worms, bodies, shells
  function hash_core(S) {
    mix(S.time);
    mix(S.turnNo || 0);
    mix(S.rng ? S.rng.s : 0);
    mix(W.version - (S.verBase || 0));
    mix(S.theta);
    for (const w of S.worms) {
      mix(w.pos.x);
      mix(w.pos.y);
      mix(w.pos.z);
      mix(w.hp);
    }
    for (const b of S.bodies) {
      mix(b.pos.x);
      mix(b.pos.y);
      mix(b.pos.z);
    }
    for (const p of S.proj) {
      mix(p.s);
      mix(p.y);
    }
  }
  // the weapon lists: devices, holes, strikes, bullets, zaps, moais, crates, fragments and the weapons-A state
  function hash_weapons(S) {
    if (S.devices)
      for (const d of S.devices) {
        mix(d.pos.x);
        mix(d.pos.y);
        mix(d.pos.z);
        mix(d.hp);
        mix(d.charges);
        mix(d.t);
      }
    if (S.holes)
      for (const q of S.holes) {
        mix(q.x);
        mix(q.y);
        mix(q.z);
        mix(q.t);
      }
    if (S.strikes)
      for (const q of S.strikes) {
        mix(q.s);
        mix(q.y);
        mix(q.k);
      }
    if (S.bullets)
      for (const q of S.bullets) {
        mix(q.s);
        mix(q.y);
        mix(q.vs);
        mix(q.vy);
      }
    if (S.zaps)
      for (const q of S.zaps) {
        mix(q.t);
        mix(q.s);
      }
    if (S.moais)
      for (const q of S.moais) {
        const mb = SS.bodies.by_id(S, q.body);
        mix(mb ? mb.pos.y : 0);
        mix(q.smash);
      }
    if (S.crates)
      for (const q of S.crates) {
        mix(q.pos.x);
        mix(q.pos.y);
        mix(q.pos.z);
        mix(q.landed ? 1 : 0);
      }
    if (S.frags) {
      mix(S.frags.length);
      for (const q of S.frags) {
        mix(q.x);
        mix(q.y);
        mix(q.z);
      }
    }
    if (S.wa) {
      const wa = S.wa;
      mix(wa.rng.s % 100003);
      mix(wa.stream ? wa.stream.t : -1);
      mix(wa.spots.length);
      mix(wa.acid.length);
      SS.weaponsA.hash_ws(S, mix);
      for (const c of wa.clouds) {
        mix(c.x);
        mix(c.y);
        mix(c.z);
        mix(c.r);
        if (c.pf) mix(c.pf[c.pf.length - 6]);
      }
      for (const b of wa.boom) {
        mix(b.s);
        mix(b.y);
        mix(b.vs);
        mix(b.vy);
      }
      for (const r of wa.ravens) {
        mix(r.s);
        mix(r.y);
      }
      for (const l of wa.letters) {
        mix(l.s);
        mix(l.y);
      }
      for (const w of S.worms) {
        mix(w.gas || 0);
        mix(w.stickT || 0);
      }
    }
  }
  // the modules with their own state: gadgets, force fields, weather (wind, whirlwinds, respawns), skills, the End of
  // the World (jetpacks, drifting crates), the Lab (only with a Lab flag on)
  function hash_modules(S) {
    if (SS.gadgets && S.dogs) SS.gadgets.hash(S, mix);
    if (SS.ffield && S.ffields) SS.ffield.hash(S, mix);
    if (SS.weather && S.weather && SS.weather.hash) SS.weather.hash(S, mix);
    if (SS.skills && S.skRng) SS.skills.hash(S, mix);
    if (S.eow) SS.eow.hash(S, mix);
    if (SS.lab && S.lab) SS.lab.hash(S, mix);
  }
  // the fluids and the ice, so a divergence there shows before it moves a worm (a sum per field: ~40k cells each), and
  // the alien life (eggs, face huggers, the parasite, aliens, acid)
  function hash_fluids(S) {
    for (const w of S.worms) {
      mix(w.swim ? 1 : 0);
      mix(w.iceV || 0);
    }
    if (S.water) {
      mix(sum(S.water.h));
      mix(S.water.pend.length);
    }
    if (S.ice) {
      mix(sum(S.ice.h));
      mix(sum(S.ice.snow));
      mix(S.ice.floes.length);
      mix(S.ice.waves.length);
      for (const f of S.ice.floes) {
        mix(f.x);
        mix(f.z);
      }
    }
    if (S.lava) {
      mix(sum(S.lava.h));
      mix(sum(S.lava.T));
    }
    if (S.alien && SS.alien) SS.alien.hash(S, mix);
  }
  // the turn machine and the weapon state, the rescue gear (once used), per-team ammo, worm motion / facing / base HP,
  // the hashed settings, the crate levels (away from the default only), fort mode and the 2D dimension (only when on)
  function hash_turn(S) {
    HH = Math.imul(HH ^ str(S.phase), 16777619) >>> 0; HH = Math.imul(HH ^ str(S.weapon), 16777619) >>> 0;
    mix(S.round || 0);
    mix(S.sdRound || 0);
    mix(S.sudden ? 1 : 0);
    mix(S.sdFinal || 0);
    if (S.sudden) mix(S.sdAcc || 0);
    mix(S.aim || 0);
    mix(S.power || 0);
    mix(S.charging ? 1 : 0);
    mix(S.shots || 0);
    mix(S.fuse || 0);
    mix(S.active ? S.active.id : -1);
    if (SS.gear) SS.gear.hash(S, mix);
    if (S.teams)
      for (const t of S.teams)
        if (t.ammo)
          for (const k of C.ARSENAL_ORDER) {
            const v = t.ammo[k];
            mix(v === Infinity ? -7 : v || 0);
          }
    for (const w of S.worms) {
      mix(w.vel.x);
      mix(w.vel.y);
      mix(w.vel.z);
      mix(w.vs || 0);
      mix(w.vy || 0);
      mix(w.facing || 0);
      mix(w.hp0 || 0);
      mix(w.air ? 1 : 0);
      mix(w.dead ? 1 : 0);
    }
    if (S.settings)
      for (const k of HASH_SETTINGS) {
        const v = S.settings[k];
        mix(typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'string' ? str(v) % 1000003 : -1);
      }
    if (S.settings)
      for (const k of C.CRATES.SLIDERS) {
        const v = S.settings[k];
        if (v != null && v !== C.CRATES.DEF) {
          mix(2100);
          mix(v);
        }
      }
    if (S.settings && S.settings.fort) mix(2003);
    if (S.settings && S.settings.dim === '2d') mix(2002);
  }
  // strided sums of the voxel arrays themselves (the version counter alone let a different crater with the same number
  // of edits pass), the sea level and the map size
  function hash_world() {
    const d = W.d, mt = W.mat;
    let t = 0, u = 0;
    for (let i = 0; i < d.length; i += 97) t += d[i];
    for (let i = 3; i < mt.length; i += 101) u += mt[i];
    mix(t);
    mix(u);
    mix(W.SEA);
    mix(W.SX);
  }
  /* the settings keys the guests receive (main.js 'start' whitelist + the menu's rule / density keys) and the sim
   * reads */
  // the hashed settings: the HASH rows of the settings schema, in their order (sim.hash mixes them in exactly this
  // order)
  const HASH_SETTINGS = C.setting_keys(C.SF.HASH);

  /* The worm struct: EVERY field exists from the first step with its default (the defaults below are exactly the
   * values the `||`, `== null` and `> 0` tests give a missing field: 0 / false / null). C: struct Worm { i16 id, team;
   *   char name[24]; f32 hp, hp0; u8 dead, facing(i8); Grave *grave; u8 cause; f32 dmgAcc, dmgT, hotT, fireT; i32
   * fireStep; f32 iceV; Swim *swim; Wet *ropeWet; Skills skills; vec3 pos, vel; f32 vs, vy, foot; u8 rest, air; ... }
   * (the `grave`, `swim`, `ropeWet`, `rope`, `batHit`, `hitDir` `pinProbe` pointers are inline structs there with a
   * `used` flag). Times are S.time stamps: 0 = never for the ones only tested `> S.time`; null = never for the ones the
   * view tests with `!= null` (squash, flipAt, flipRope, coughAt, acidT, mgKill); -1e9 for burnT (the view computes
   * `S.time - burnT < 0.3`: a 0 would read as "burning" in the first second), washT and waveT (S.time - t against a
   * cool-down). */
  ST.worm_make = function (id, team, name, hp, spot) {
    return {
      id, team, name, hp, hp0: hp, dead: false, facing: 1, grave: null, cause: 0, dmgAcc: 0, dmgT: 0, hotT: -9, fireT: -9, fireStep: -1,
      iceV: 0, swim: null, ropeWet: null,
      skills: { freerot: 0, laser: 0, fastwalk: 0, lowgrav: 0, tinfoil: 0 },
      pos: { x: spot.x, y: spot.y + 0.55, z: spot.z }, vel: { x: 0, y: 0, z: 0 }, rest: false, vs: 0, vy: 0, air: false, foot: 0.5,
      // movement / traversal (sim.js controlActive, traverse.js)
      windUp: 0, windFace: 0, walking: false, slide: false, hop: false, hopAt: 0, flip: false, flipAt: null, flipK: 0, flipW: 0,
      flipRope: null, squash: null, springFall: false, landDmg: 0,
      stillT: 0, pinT: 0, dizzyUntil: 0, shoveT: 0, bodyHitT: 0, washT: -1e9, waveT: -1e9, wdx: 0, wdz: 0, lsink: 0, pinProbe: null,
      rope: null, aimMem: null,
      reserve: false,
      // life cycle / damage (sim.js hurt, kill, drown)
      dying: false, drowning: 0, swimOuts: 0, gravePending: false, hitDir: null, burnT: -1e9, mgKill: null, batHit: null,
      // weapons A / aliens / shrapnel (weaponsa.js, alien.js, shrapnel.js)
      gas: 0, coughT: null, coughAt: null, stickT: 0, acidT: null, hopT: 0, hopDir: 0, hug: null, embryo: false, embT: 0, embNext: 0,
      embHit: -1, eaten: false, teleHold: 0, teleX: 0, teleY: 0, teleZ: 0, shrapT: null, shrapSum: 0
    };
  };

  /* a new match on the generated world: the per-game fields, the modules' state, the worms, everything that stands on
   * the map, then the first turn (or the placement) */
  function initState(S) {
    const st = S.settings;
    M.rng_seed(S.rng, (C.LAYOUT_SEED + Math.imul(st.seed | 0, 7919)) >>> 0);
    reset_fields(S);
    init_modules(S);
    const taken = [], fortOn = !!SS.fort && SS.fort.is();
    spawn_worms(S, taken, fortOn);
    populate_world(S, taken, fortOn);
    start_match(S);
  }
  /* Every per-game field, once, with its default (a rematch must equal a fresh start: lockstep peers and replays
   * compare them). Modules add their own state in their init (weapons, game, weather, water, veg, lava, ice). */
  function reset_fields(S) {
    Object.assign(S, {
      // lists and id counters
      worms: [], bodies: [], trees: [], proj: [], pending: [], planeBodies: [], flames: [], fx: [], frags: [], spat: [], log: [],
      bunkers: [],
      bodyId: 0, nextBodyId: 1, fragId: 0, spatId: 0, structId: 0, projN: 0, crateId: 0,
      // (a rematch starts from the same CPU memory and log throttle as a fresh game)
      fragRng: null, spatRng: null, spatAcc: 0, spatTick: 0, aiPlan: null, aiRng: null, aiMem: null, _treeLogT: null,
      // clock, phase, section
      tick: 0, time: 0, phase: PHASE.PLAY, theta: 0, O: { x: W.MX, z: W.MZ }, thetaGoal: null, sectionDirty: true, lastRotate: -99,
      // turn
      active: null, target: null, tgt: null, teamTurn: 1, firstTeam: 0, nextIdx: [0, 0], turnNo: 0, turnT: 0, turnStart: 0, selStart: 0,
      acted: false,
      retreatT: 0, attackStart: 0, resolveT: 0, quietT: 0, resolveBack: 0, shots: 0, over: null,
      weapon: 'grenade', aim: 0.45, power: 0, charging: false, rope: null, hook: null, ropeHopT: -9, mouseRot: 0,
      // the traverse state (SS.traverse; structs in its header): rope memory, parachute, zipline
      crateSel: -1,                                                // (the Shift+TAB crate cursor, rotlock.js: -1 = none)
      ropeMem: { aim: 0, chain: 0, relT: -9 }, chute: { open: 0, wid: -1, t: 0, sway: 0, steer: 0 },
      zip: { state: 0, wid: -1, as: 0, ay: 0, bs: 0, by: 0, len: 0, t: 0, v: 0, age: 0, bolt: null },

      // blasts, damage, dying beat, placement
      lastBoom: 0, slowUntil: 0, lastBlastT: -99, lastBlastW: 0, lastExplosion: null, lastCrater: null, hitDir: null,
      dyingW: null, dyingT: 0, dyingGrave: false, mapMinesUntil: 0, placeOrder: null, placeIdx: 0, placeT: 0, placeDone: -1,
      // presentation timers kept in S (see docs/PORTING.md: they move to the view in the port)
      ctx: 0, inspect: 0, lockMsgT: -9
    });
    S.events.length = 0;
    S.biome = W.biome;
  }
  // the modules' state, in this order (every RNG stream is created here: S.rng above, the modules' own streams in
  // their init)
  function init_modules(S) {
    if (SS.eow) SS.eow.init(S);                                    // the End of the World biome (S.eow = null elsewhere)
    if (SS.shrapnel) SS.shrapnel.init(S);
    if (SS.spatter) SS.spatter.init(S);
    if (SS.ai) SS.ai.init(S);
    if (SS.weapons) SS.weapons.init(S);                           // holes, strikes, devices, crates, fuse ...
    if (SS.lab) SS.lab.init(S);                                   // the Lab's state + RNG stream (settings.labFlags)
    if (SS.cracks) SS.cracks.init(S);                             // the damage field (only with the CRACKS flag)
    SS.game.setup(S);                                              // teams, rounds, sudden death (before subsystems / spawns)
    if (SS.weather) SS.weather.init(S);
    if (SS.water) SS.water.init(S);
    if (SS.veg) SS.veg.init(S);
    if (SS.lava) SS.lava.init(S);
    if (SS.veg && SS.lava && SS.veg.clear_hot) SS.veg.clear_hot(S);   // no grass on / near lava or vents
    if (SS.ice) SS.ice.init(S);                                   // sea / pool ice (after the water)
    sim.emit(S, EV.RESET, {});
  }
  // the worms, interleaved round-robin across the teams (PoC populate); in fort mode a team's first worm sits in its
  // bunker and the rest stand on the team's fort; nobody spawns on a beach hut's pad
  function spawn_worms(S, taken, fortOn) {
    const nT = S.teams.length, nW = nT * M.clamp(S.settings.worms | 0 || 3, 1, 4), names = SS.game.names(S, nW);
    const hp0 = M.clamp(S.settings.hp | 0 || 100, 1, 999), sep = nW > 8 ? 11 : 15;
    if (S.biome === 'beach' && !W.under && W.features && W.features.beach && W.features.beach.huts)
      for (const h of W.features.beach.huts) taken.push({ x: h.x, y: h.y, z: h.z });
    for (let i = 0; i < nW; i++) {
      const team = i % nT, fo = fortOn ? { team } : undefined;
      const spot = fortOn && i < nT
        ? SS.fort.seat(team)
        : SP.find_spot(S, sep, taken, fo)
          || SP.find_spot(S, 6, taken, fo)
          || SP.find_spot(S, 3, taken, fo)
          || (fortOn ? SS.fort.seat(team) : SP.fallback_spot(S));
      taken.push(spot);
      S.worms.push(ST.worm_make(i, team, names[i], hp0, spot));
    }
  }
  /* everything that stands on the map, in this order: the End of the World's suits, the forts (instead of the structure
   * stamps), buried rooms, then steel bridges, concrete bunkers, the derelict ship, the volcanic ruins and the alien
   * eggs (before props and trees: those avoid them; on the 2D slab the ship stays out and the others stamp their cross
   * section, whose floating pieces are removed), worms freed from the stamps, the spawn audit, props, room furniture,
   * trees (none underground), and the vegetation settled on the final ground */
  function populate_world(S, taken, fortOn) {
    const flat = W.flat;
    if (S.eow) SS.eow.spawned(S);
    if (fortOn) SS.fort.populate(S, taken);
    if (S.settings.rooms && !W.under && !flat) SS.game.rooms(S);
    else S.rooms = [];
    if (!S.eow) {
      if (SS.struct && !fortOn) SS.struct.populate(S, taken);
      if (SS.bunker && !fortOn) SS.bunker.populate(S, taken);
      if (SS.derelict && !flat && !fortOn) SS.derelict.populate(S, taken);
      if (SS.ruins && !fortOn) SS.ruins.populate(S, taken);
      if (SS.alien) SS.alien.populate(S, taken);
      if (flat && SS.collapse && SS.collapse.remove_floating_all(W) > 0) W.mark_all();
      SP.unbury_worms(S, taken);
      SP.spawn_audit(S, taken);                                           // no worm starts on sand / lava / water that hurts at once
    } else if (SS.alien) SS.alien.populate(S, taken);                 // (in space only the alien state is made)
    if (SS.scatter) SS.scatter.populate(S, taken);
    SS.game.furnish_rooms(S);
    if (SS.trees && !W.under && !S.eow) SS.trees.populate(S, taken);
    if (SS.veg && SS.veg.settle) SS.veg.settle(S);
  }
  // the first turn (or the players place their worms first), the hash's version base, the 2D pinning, the intro line
  function start_match(S) {
    const flat = W.flat;
    if (S.settings.placement === 'user') SS.game.begin_placement(S);
    else TN.next_turn(S, true);
    S.verBase = W.version;
    if (flat) SS.dim2d.constrain(S);
    const B = C.BIOMES.find(b => b.id === S.biome);
    if (flat)
      sim.log(S, `${B ? B.name : S.biome}: a ${W.SX} m side-on slice (2D). No rotation: everyone fights on the same plane.`, 0xfff3b0);
    else
      sim.log(
        S,
        W.under
          ? `${B ? B.name.replace(/ isle| island/i, '') : S.biome} caves: a cave system in ${W.SX} m × ${W.SZ} m × 40 m of rock. Rotate with Q / E; the rope is your friend.`
          : `${B ? B.name : S.biome}: a ${W.SX} m × ${W.SZ} m × 40 m volume. Rotate with Q / E.`,
        0xfff3b0
      );
  }
  ST.init_state = initState;
  /* Input sanitising: a hostile peer must not be able to freeze or poison the sim with one packet (move 1e9
   * made
   * ~1e9 sub-steps, ts 1e300 looped forever). Every numeric field is forced into its legal range (NaN / Infinity -> 0);
   * the weapon key must be an arsenal key. Table = { field, lo, hi, int }: in a port, clamp the fields of the Input
   * struct. Legit ranges: held axes / edge flags -1..1 (or 0..1), rotate_mouse = accumulated right-drag pixels * 0.6
   * (<< 200), fuse 0..5, align_id = worm id + 1, ts / ty = plane coordinates in metres (the world is < 2000 m wide). */
  const IN_LIM = [['move', -1, 1], ['up', -1, 1], ['down', -1, 1], ['jump', -1, 1], ['backflip', -1, 1],
    ['fire_pressed', -1, 1], ['fire_held', -1, 1],
    ['rotate', -1, 1], ['rotate_mouse', -200, 200], ['fine', -1, 1], ['align_step', -1, 1], ['align_crate', -1, 1],
    ['align_refocus', -1, 1], ['align_id', 0, 64],
    ['end_turn', -1, 1], ['reset', -1, 1], ['inspect', -1, 1], ['fuse', 0, 5], ['tgt', -1, 1], ['ts', -4000, 4000], ['ty', -4000, 4000],
    ['sdir', -1, 1],
    ['gang', -1, 1], ['gturn', -1, 1],
    ['drop', -1, 1], ['wsel', -1, 1], ['aimset', -1, 1], ['aimv', -4, 4], ['face', -1, 1], ['adj', -1, 1], ['gear', 0, 8], ['jet', -1, 1],
    ['dbk', 0, 99], ['dbp0', 0, 1000], ['dbp1', 0, 1000], ['dbs', -4000, 4000], ['dby', -4000, 4000], ['dbsky', 0, 1]];
  // the clamp table of the numeric Input fields, in struct order (a port generates its sanitize_input from it; the
  // weapon field is a key of the arsenal)
  ST.INPUT_LIMITS = IN_LIM;
  ST.sanitize_input = function (inp) {
    for (let i = 0; i < IN_LIM.length; i++) {
      const L = IN_LIM[i], k = L[0], v = inp[k];
      // (tests pass booleans)
      if (typeof v !== 'number') {
        inp[k] = v === true ? 1 : 0;
        continue;
      }
      if (v >= L[1] && v <= L[2]) continue;
      inp[k] = v < L[1] ? L[1] : v > L[2] ? L[2] : 0;       // (NaN fails both comparisons: 0)
    }
    if (typeof inp.weapon !== 'string' || (inp.weapon !== '' && !C.ARSENAL[inp.weapon])) inp.weapon = '';
    return inp;
  };

  /* the layout hash of a game just reset: FNV-1a over the bytes of the world's column tops and materials, the worms (x,
   * y,
   * z, hp as f64), the props (x + 7 z), the trees (x + 3 z + h), the water depths and the RNG state, in this order (the
   * baselines of tools/dev/gen/drytest.cjs; the port compares its own reset with it). C: u32 layout_hash(const
   * GameState*), the f64 written little-endian. */
  const lhF64 = new Float64Array(1), lhB = new Uint8Array(lhF64.buffer);
  function fnvBytes(h, u8) {
    for (let i = 0; i < u8.length; i++) {
      h ^= u8[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
  }
  function fnvF64(h, v) {
    lhF64[0] = v;
    return fnvBytes(h, lhB);
  }
  const bytesOf = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  ST.layout_hash = function (S) {
    let h = 2166136261;
    h = fnvBytes(h, bytesOf(W.top));
    h = fnvBytes(h, bytesOf(W.mat));
    for (let i = 0; i < S.worms.length; i++) {
      const w = S.worms[i];
      h = fnvF64(fnvF64(fnvF64(fnvF64(h, w.pos.x), w.pos.y), w.pos.z), w.hp);
    }
    for (let i = 0; i < S.bodies.length; i++) {
      const q = S.bodies[i];
      h = fnvF64(h, q.pos ? q.pos.x + q.pos.z * 7 : 0);
    }
    for (let i = 0; i < S.trees.length; i++) {
      const t = S.trees[i];
      h = fnvF64(h, t.x + t.z * 3 + t.h);
    }
    if (S.water && S.water.h) h = fnvBytes(h, bytesOf(S.water.h));
    return fnvF64(h, S.rng.s || 0);
  };
})(window.SS = window.SS || {});
