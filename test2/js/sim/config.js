/* sim/config.js — every gameplay/physics constant and data table in one place (C: #define / const tables).
 * Units: metres, seconds, kilograms, kilopascals (kPa) for overpressure, Pa·s for blast impulse. */
(function (SS) {
  'use strict';
  const M = SS.math;

  /* ---------- terrain materials (C: enum MatId + const MatDef MATS[]) ----------
   * strength: peak blast overpressure (kPa) the material survives — sets crater size per material.
   * granular: loose material that slides when unsupported/steeper than its angle of repose.
   * liquid: flows under gravity (lava).  buoyant: floats on sea water (ice).
   * layer: texture-array slot in the renderer (render may map it to a texture + tint). */
  const MAT = { AIR: 0, BEDROCK: 1, ROCK: 2, SOIL: 3, SAND: 4, SANDSTONE: 5, SNOW: 6, ICE: 7, BASALT: 8, LAVA: 9, CRUST: 10, ASH: 11, SCREE: 12, STEEL: 13, FOAM: 14, CONCRETE: 15, OBSIDIAN: 16 };
  /* strength tuned so a 1 kg grenade digs ≈ rock 2.0 m, soil 2.8 m, sand 3.2 m, snow 3.7 m, basalt 1.75 m (radius) */
  const MATS = [
    { name: 'air', strength: 0, rho: 1.2, rgb: 0x000000, mu: 0 },
    { name: 'bedrock', strength: 1e9, rho: 2900, rgb: 0x4a4440, mu: 0.7 },
    { name: 'rock', strength: 200, rho: 2600, rgb: 0x8a7d70, mu: 0.65 },
    { name: 'soil', strength: 90, rho: 1600, rgb: 0x7a5636, mu: 0.8 },
    { name: 'sand', strength: 70, rho: 1700, rgb: 0xd8c08a, granular: 1, repose: 1, mu: 0.75 },
    { name: 'sandstone', strength: 140, rho: 2300, rgb: 0xc0704a, mu: 0.7 },
    { name: 'snow', strength: 50, rho: 450, rgb: 0xf2f6fa, granular: 1, repose: 2, melts: 1, mu: 0.35 },
    { name: 'ice', strength: 160, rho: 917, rgb: 0x9fd2f0, buoyant: 1, melts: 1, mu: 0.06 },
    { name: 'basalt', strength: 280, rho: 2900, rgb: 0x34302e, mu: 0.7 },
    { name: 'lava', strength: 40, rho: 2600, rgb: 0xff5a10, liquid: 1, hot: 1, mu: 0.9 },
    { name: 'crust', strength: 180, rho: 2500, rgb: 0x2a2523, mu: 0.75 },
    { name: 'ash', strength: 60, rho: 1000, rgb: 0x55504c, granular: 1, repose: 1, mu: 0.7 },
    { name: 'scree', strength: 100, rho: 1900, rgb: 0x8d8780, granular: 1, repose: 1, mu: 0.6 },
    // P2 (PoC): girder steel (indestructible like bedrock, anchors what it touches) and foam-mortar foam (the weakest
    // solid, floats where it touches the sea surface)
    { name: 'steel', strength: 1e9, rho: 7850, rgb: 0xa0663a, mu: 0.5, fixed: 1 },
    { name: 'foam', strength: 25, rho: 60, rgb: 0xe4eef8, buoyant: 1, mu: 0.6 },
    // P29d bunkers: reinforced concrete (a 1 kg grenade digs ~0.66 m: a 0.9 m wall is scarred, not breached; it takes
    // several hits in one place; strength 800 gave 1.11 m and one grenade 0.3 m off the wall breached it)
    { name: 'concrete', strength: 2600, rho: 2400, rgb: 0x8c8a84, mu: 0.7 },
    // P31: volcanic glass, lava quenched where it meets water (lava.js quench): hard, brittle, glossy black
    { name: 'obsidian', strength: 240, rho: 2400, rgb: 0x141216, mu: 0.55 }
  ];

  SS.CFG = {
    STEP: 1 / 120,          // fixed simulation step (s)
    G: 9.81,                // gravity (m/s^2)
    HALF: 1.5,              // half thickness of the visible slab (m) — visual only
    WORM_R: 0.45,           // collision radius of a worm in the plane (m)
    WORM_H: 0.98,           // visual height of a worm (m)
    WORM_MASS: 6,           // kg (game-scale, sets blast knock-back)
    WORM_AREA: 0.42,        // m^2 presented to a blast wave
    WALK: 2.96,             // walk speed (m/s) (PoC walkWorm 46 px/s; 1 px = 0.0643 m: a worm 14 px wide = 0.9 m)
    /* Worm dynamics = the PoC's exactly (user 2026-10-07: "the way worms jump"), converted by LENGTH only (1 px =
     * 0.0643 m, times unchanged), so jumps, landings, skids and rope swings keep their PoC shapes AND timings. That
     * makes the worms' own gravity G_WORM = 520 px/s^2 = 33.44 m/s^2 (worm bodies only; projectiles, props, water and
     * terrain keep g = 9.81). Every value below cites the PoC game.js line it comes from. */
    G_WORM: 33.44,
    WORM_DYN: {
      JUMP_VS: 12.86, JUMP_VY: 10.67,          // jump L3664: vx facing x 200, vy -166 px/s -> 8.2 m long, 1.7 m high, 0.64 s
      HOP_VS: -2.19, HOP_VY: 12.47,            // back hop L3663: vx -34, vy -194 -> 2.3 m high, 1.6 m back, 0.75 s
      SALTO_WIN: 0.5, SALTO_VMIN: -3.86, SALTO_BASE: 6.43, SALTO_ADD: 9.64, SALTO_VS: -4.5,   // L3656: 2nd Backspace while rising
      STEP_UP: 0.64, STEP_UP_WORM: 1.16, STEP_DOWN: 0.64, LEDGE_VS: 2.57,   // walkWorm L3635: 10 / 18 px, ledge vx 40 px/s
      FALL_SAFE: 30.2,                          // FALL_HURT L3543: 470 px/s along the contact normal (a 13.6 m drop is safe)
      HEAD_ALONG: 0.18, HEAD_K: 3.11, HEAD_ADD: 6, HEAD_MAX: 55, GLANCE_K: 2.22, GLANCE_MAX: 40,   // L3574-3585
      HEAD_UP_K: 0.42, HEAD_UP_MAX: 21.2, HEAD_SIDE: 1.16, DIZZY: 1.8,   // head-on bounce and dizziness L3578-3581
      BOUNCE: 0.3, FRIC: 0.72,                  // integrateBody(w, dt, 0.3, 0.72) per contact
      FIRM_NY: 0.34, SOFT_NY: 0.55, SOFT_V: 3.5, STILL_V: 1.29, STILL_T: 0.45,   // land / soft landing / still rest
      READY_V: 0.77,                            // weaponReady L4342: speed < 12 px/s
      HEAD_SHOVE_V: 11.3, SHOVE_K: 0.28, SHOVE_MIN: 2.6, SHOVE_MAX: 6.4, SHOVE_UP: 2.25, SHOVE_COOL: 0.45,   // L3611-3634
      DROWN_T: 2.2, DROWN_V: 1.67,              // drown L3534 / L3559: sinks 26 px/s for 2.2 s
      // P33 (user 2026-10-08, over the PoC's instant drowning): a worm in the water floats struggling SWIM_FLOAT_T s,
      // losing SWIM_DPS HP/s (in SWIM_TICK s chunks); land within SWIM_R m whose ground is at most SWIM_CLIMB m above
      // the water: it swims there at SWIM_V (SWIM_MAX_T s at most) and climbs out. Floats FLOAT_D m under the surface
      // (body centre). On the ninja rope it stays in control under water, losing SWIM_DPS too.
      SWIM_DPS: 10, SWIM_TICK: 0.5, SWIM_FLOAT_T: 2.5, SWIM_R: 2, SWIM_CLIMB: 1.0, SWIM_V: 0.9, SWIM_MAX_T: 4, FLOAT_D: 0.3,
      WASH_V: 1.2, WASH_VS: 4.5, WASH_VY: 3.86, WASH_K: 0.8, WASH_KY: 0.4, WASH_COOL: 1.2,   // washWorms L6283
      AIM_RATE: 1.5, CHARGE_T: 1.15, MIN_POWER: 0.08, AIM0: 0.35,   // L5154, L5160, launch L4305, makeWorm aim 0.35
      SETTLE_QUIET: 0.6, SETTLE_CAP: 16         // settle L5107-5110
    },
    ROPE_MAX: 33.4, ROPE_MIN: 0.9,       // PoC ROPE_MAX 520 px, attach min 14 px
    FALL_SAFE: 30.2,        // (= WORM_DYN.FALL_SAFE; kept for older readers)
    SEED: 7, LAYOUT_SEED: 4242,
    CTX_HOLD: 2.5, CTX_FADE: 1.2,
    ROT_SPEED: 0.9, ALIGN_SPEED: Math.PI * 2,
    /* P1: teams and worm names from the PoC (TEAM_DEF, NAMES); settings.names overrides a team's name */
    TEAMS: [{ name: 'Red Rebels', rgb: 0xff5b4f }, { name: 'Blue Moles', rgb: 0x4ea8ff }, { name: 'Gold Diggers', rgb: 0xffd23f }, { name: 'Green Grubs', rgb: 0x6fd884 }],
    NAMES: ['Spud', 'Noodle', 'Clod', 'Gristle', 'Boris', 'Squirm', 'Pip', 'Mulch', 'Slick', 'Fang', 'Doris', 'Kevin', 'Biscuit', 'Turnip', 'Nugget', 'Wiggles', 'Gus', 'Mabel', 'Pickles', 'Rusty', 'Sprout', 'Taffy', 'Dobbs', 'Mort'],
    /* P1 match rules (PoC): retreat after an attack (s; per weapon `retreat`), CPU skills, sudden death steps */
    GAME: { RETREAT: 5, SKILLS: ['easy', 'normal', 'hard'], SD_RISE: 1.05,   // PoC: 26 px per sudden-death turn = 2.6 % of its map height (~40 m here)
            SD_DRY_STEP: 2, SD_DRY_MIN: 14 },

    /* Weapons (C: enum WeaponId + const WeaponDef[]). W = TNT-equivalent charge (kg, game-scale). */
    WEAPONS: {
      grenade: { id: 0, name: 'Grenade', W: 1.0, fuse: 3, windK: 0.6, frag: true },     // frag: casing shrapnel (X2)
      bazooka: { id: 1, name: 'Bazooka', W: 0.8, windK: 1.0, frag: true },
      rope: { id: 2, name: 'Ninja rope' }
    },
    WEAPON_ORDER: ['grenade', 'bazooka', 'rope'],

    /* Blast physics (Kinney–Graham free-air overpressure/impulse, Hopkinson–Cranz cube-root scaling).
     * Far from the charge the energy flux falls with the inverse square of distance and the overpressure with its
     * square root (~1/R); worm damage goes with the square of the pressure ratio, i.e. ~1/R^2 far out. */
    BLAST: {
      P0: 101.325,          // ambient pressure (kPa)
      DMG_MAX: 70,          // HP at zero distance
      P_HALF: 180,          // reflected overpressure (kPa) where damage is 1/4 of DMG_MAX
      REFLECT: 2.2,         // reflection factor on a body facing the wave
      AREA_K: 0.92,         // worm frontal area * reflection (m^2) for knock-back
      WORM_KG: 6,           // worm mass (kg) for knock-back
      FRICTION_DV: 2.0,     // speed (m/s) eaten by ground friction / inertia before a worm is shoved
      VMAX: 17,             // knock-back speed cap (m/s)
      SHIELD_L: 0.5,        // metres of rock that cut the wave to 1/e of its unshielded part
      LEAF_I: 20,           // impulse (Pa·s) where leaves start to strip (W 1: Z ~ 9 m; was 8 -> stripped within ~20 m)
      LEAF_SPAN: 80,        // ...and are fully stripped at LEAF_I + LEAF_SPAN (W 1: ~83 % at 2 m, 24 % at 5 m)
      FIRE_R: 1.25,         // fireball radius / W^(1/3) (m): ignites dry fuel
      R_MAX: 7              // never edit terrain farther than this (m)
    },
    MAT, MATS,

    /* Map types. Each one is a generator in sim/worldgen.js plus a look preset in render. */
    BIOMES: [
      { id: 'temperate', name: 'Temperate isle', lavaChance: 0.35, storm: 0.3 },
      { id: 'alpine', name: 'Alpine ice', lavaChance: 0.15, storm: 0.45 },
      { id: 'canyon', name: 'Red canyon', lavaChance: 0.3, storm: 0.2 },
      { id: 'desert', name: 'Desert dunes', lavaChance: 0.25, storm: 0.1, dry: true },   // dry: no sea (C.DRY, Step D)
      { id: 'volcanic', name: 'Volcano', lavaChance: 1, storm: 0.6 }
    ],
    /* Weather patterns (C: enum Weather). */
    WEATHER: ['clear', 'cloudy', 'rain', 'storm', 'snow', 'blizzard', 'ashfall', 'fog'],
    /* Per kind (sim/weather.js): precipitation targets 0..1, cloud cover, lightning, sky panorama (null = the biome's)
     * and the 'auto' wind band at 10 m (m/s). */
    WEATHER_KIND: {
      clear:    { rain: 0, snow: 0, ash: 0, cloud: 0.1, storm: false, sky: null, wind: [1, 5] },
      cloudy:   { rain: 0, snow: 0, ash: 0, cloud: 0.6, storm: false, sky: null, wind: [2, 6] },
      rain:     { rain: 0.6, snow: 0, ash: 0, cloud: 0.85, storm: false, sky: 'sky_storm', wind: [3, 8] },
      storm:    { rain: 1, snow: 0, ash: 0, cloud: 1, storm: true, sky: 'sky_storm', wind: [7, 13] },
      snow:     { rain: 0, snow: 0.6, ash: 0, cloud: 0.8, storm: false, sky: 'sky_cold', wind: [2, 6] },
      blizzard: { rain: 0, snow: 1, ash: 0, cloud: 1, storm: false, sky: 'sky_cold', wind: [10, 15] },
      ashfall:  { rain: 0, snow: 0, ash: 0.7, cloud: 0.9, storm: false, sky: 'sky_storm', wind: [2, 6] },
      fog:      { rain: 0, snow: 0, ash: 0, cloud: 0.7, storm: false, sky: null, wind: [0, 2], fog: 1 }   // PoC 'Fog': calm, grey, short sight
    },
    WEATHER_CHANGE: 0.2,    // 5f: chance per turn that 'auto' weather proposes a neighbour kind (Metropolis, see weather.js)
    WEATHER_NAME: { clear: 'clear', cloudy: 'cloudy', rain: 'rain', storm: 'thunderstorm', snow: 'snow', blizzard: 'blizzard', ashfall: 'ash fall', fog: 'fog' },
    /* 'auto' weather: kind probabilities per biome (drawn from the weather RNG, not the layout RNG); the key order is
     * the severity chain the weather walks along between turns (5f). */
    WEATHER_AUTO: {
      temperate: { clear: 0.35, cloudy: 0.25, rain: 0.25, storm: 0.15 },
      alpine: { clear: 0.2, cloudy: 0.15, snow: 0.45, blizzard: 0.2 },
      canyon: { clear: 0.5, cloudy: 0.25, rain: 0.1, storm: 0.15 },
      desert: { clear: 0.7, cloudy: 0.2, storm: 0.1 },
      volcanic: { cloudy: 0.2, storm: 0.35, ashfall: 0.45 }
    },
    /* Wind classes (menu / URL 'wind'): speed at 10 m (m/s) and gust amplitude (fraction). */
    WIND: {
      CLASSES: { calm: [0, 0], breeze: [3, 0.25], strong: [7, 0.3], gale: [12, 0.35] },
      DESERT_AUTO: [4, 9],  // clear desert: steadier, stronger trade wind
      Z0: 0.05,             // roughness length (m) of the log profile u(h) = u10 ln((h + z0)/z0) / ln((10 + z0)/z0)
      H_MIN: 0.3,           // profile evaluated at >= this height above the ground (m)
      P_MAX: 1.6,           // profile cap (high above the ground)
      SHELTER: 0.15,        // factor under the terrain top (caves, overhangs)
      DRIFT_DIR: 1.2,       // per-turn heading random walk (rad, uniform +-; PoC re-rolls the wind every turn)
      DRIFT_V: 0.25,        // (old per-turn speed change; the speed is now re-rolled: triangular inside the band)
      GUST_W: [0.21, 0.53, 1.37],   // gust noise angular frequencies (rad/s): 30 s, 12 s, 4.6 s periods
      /* terrain factors on a GRID m lattice (rebuilt when the heading changes or the world is edited) */
      GRID: 2,
      MEAN_R: 10,           // neighbourhood radius (m) for the exposure e = ground - mean ground
      RIDGE_K: 0.08,        // speed-up per metre of exposure (Jackson-Hunt dS ~ 2 H / L with L ~ 25 m), clamped:
      RIDGE_MIN: -0.35, RIDGE_MAX: 0.6,
      LEE_SCAN: 10,         // upwind scan (m) for a sheltering wall
      LEE_DH: [3, 6],       // wall height above the cell (m): lee weight 0 .. 1 (smoothstep)
      LEE_REV: 0.3,         // reversed flow in a full lee (fraction of the free wind, back toward the wall)
      CHAN: [1.5, 5],       // valley depth (-e, m) where channelling starts / is full
      CHAN_MIX: 0.8,        // how far the flow turns toward the valley axis
      /* whirlwinds (dust / snow / leaf devils): Lamb-Oseen vortex v(r) = G/(2 pi r) (1 - exp(-r^2/rc^2)) + core updraft */
      WHIRL: { MAX: 4, RATE: 0.08, NEAR: 30, MIN_WIND: 2, RC: [0.7, 1.6], VMAX: [4, 9], UP: [2, 5], H: [6, 18], LIFE: [6, 15] }
    },
    /* Precipitation and surface state (sim/weather.js, 5c). Game-time rates (visual cover, no collision). */
    PRECIP: {
      RAMP: 1 / 30,         // 1/s: rain / snow / ash intensities move toward the kind's targets
      WET_UP: 0.05,         // 1/s ground wetness gain per unit rain (wet in ~20 s of full rain)
      WET_DRY: 0.003,       // 1/s drying without rain (x (1 + 0.1 wind m/s)): ~5 min
      TREE_WET: 1.5,        // tree ignition threshold x (1 + TREE_WET wet)
      SNOW_RATE: 0.004, SNOW_MAX: 0.3, SNOW_INIT: 0.08, SNOW_MELT: 0.0002,   // m/s at snow 1, cap, start x snow, sun melt
      ASH_RATE: 0.001, ASH_MAX: 0.15, ASH_INIT: 0.03,                        // m/s at ash 1, cap, start x ash
      TICK: 0.5,            // s between grid updates
      CLEAR_D: 0.05,        // a column whose top moved more than this (crater, spoil) loses its snow / ash
      COVER_R: 15, COVER_D: 0.05    // snowCover = mean min(1, depth / COVER_D) within COVER_R of the section origin
    },
    /* Lightning (sim/weather.js, 5d; §3): storm only, one strike every GAP s (weather RNG), target drawn by
     * (top - SEA)^2 x the kind's factor within NEAR m of the section origin; a W burst at the strike point. */
    // storm lightning (PoC lightningStrike): per turn TURN_P chance of one strike; blast W (PoC R 24 px) + a shock ZAP_R / ZAP_D
    LIGHTNING: { TURN_P: 0.6, NEAR: 35, W: M.pow(24 / 44, 3), ZAP_R: 3.9, ZAP_D: 16, K_TREE: 3, K_SPIRE: 1, K_BARREL: 1, K_WORM: 0.2, SPIRE_E: 2, BREAK_P: 0.5 },

    /* Settings the player can change (map menu). 'auto' = picked from the biome/seed. */
    /* Settings (the sim's defaults; the menu starts from the PoC defaults: turnTime 45, sd on, ctl human / cpu).
     * P1: teams 2-4, worms per team 1-4, hp, turnTime (s, 0 = no limit), ctl[] per team 'human' | 'cpu' (null =
     * legacy: cpu != 'off' makes team 1 a CPU of that skill), names[] per team, skill (CPU), sd (sudden death). */
    SETTINGS: { first: 0, volcanoes: 'auto', biome: 'temperate', seed: 7,   // first: the team that starts (0..3 or 'random' = PoC; the menu default)
                collapse: true, weather: 'auto', lava: 'auto', wind: 'auto', quality: 'auto', slice: 'thin', under: 'off', cpu: 'off',
      teams: 2, worms: 3, hp: 100, turnTime: 0, ctl: null, names: null, skill: 'normal', sd: false, placement: 'random',
      blood: false, select: false, keepRope: false, rooms: false, time: 'day', art: 'painted', shape: 'island' },

    WIND_UNIT: 12, WIND_ACC: 230 * 9.81 / 520,   // PoC WIND_ACC 230 px/s2 per wind unit (12 m/s) on the projectile scale
    WIND_GAIN: 0.55,        // projectile drag coupling to the wind component in the plane (1/s)
    FIRE_TICK: 0.1,         // surface fire automaton step (s)
    FLOW_TICK: 0.12,        // granular/lava automaton step (s)
    LAVA_P: 0.22,           // per-tick move probability of a lava voxel (slow, viscous)
    /* Dry worlds (Step D, desert): no sea at all, dunes to the horizon. SEA sits below the lattice floor, so every
     * sea / seep / beach / drowning rule switches itself off. The play area is a circle of PLAY_R about the map
     * centre (spawns within SPAWN_R); beyond it the sand is hot: HOT_DPS (1 HP / 5 s) while touching the ground.
     * No wall (D4): beyond the lattice the ground is the analytic far dunes (SS.worldgen.far_height via W.sample);
     * worms, bodies and projectiles land and walk there. Beyond FAR_R (inside the drawn, still opaque far grid) a
     * projectile leaves the game, a worm is lost and a body removed. */
    DRY: { SEA: -1, CX: 48, CZ: 48, PLAY_R: 34, SPAWN_R: 30, HOT_DPS: 0.2, FAR_R: 300,
           // D6 (user: "everything should be a circle"): the lattice is used only inside the disc LAT_R (beyond it the
           // analytic far dunes: sim W.far, render far grid, cap far strip); terrain edits only reach lattice columns
           // within EDIT_R (the ring EDIT_R..LAT_R keeps its generated state, so the crater wall ends inside the disc)
           LAT_R: 46, EDIT_R: 45 },
    /* Casing shrapnel of grenade / bazooka blasts (Step X2, sim/shrapnel.js): a ~0.6 g steel fragment at ~800 m/s,
     * quadratic drag KD = rho Cd A / 2m (1.2 x 1.2 x 2e-5 m2 / 1.2e-3 kg = 0.024 /m: 800 -> 300 m/s after 40 m). */
    SHRAPNEL: {
      V0: 800, V_SPREAD: 0.25, KD: 0.024, MASS: 0.0006,   // m/s, ±fraction, 1/m, kg
      FREE_PER_KG: 36,      // simulated free fragments per kg TNT-eq (the visible burst)
      N_REAL_PER_KG: 450,   // fragments of a real casing per kg: expected worm hits = N A_WORM / (2 pi r^2)
      A_WORM: 0.45,         // m2, a worm's cross-section
      LOS_SOLID: 0.25,      // m of solid between the blast and a worm that stops all fragments
      REACH: 25,            // m: worms farther away get no aimed hits (expected hits < 0.06 there)
      WORM_HIT_R: 0.45,     // m: fragment-worm hit sphere about the worm's centre
      J_PER_HP: 100,        // J of kinetic energy per HP (~170 J at 2 m -> 2 HP, ~95 J at 15 m -> 1), HIT_MAX HP per
      CAP: 10,              // HP of shrapnel per worm per burst (0.5 s), on top of the PoC blast damage
      HIT_MAX: 4,           // fragment: shrapnel adds ~17 / 4 / 0.5 HP at 2 / 4 / 8 m to the blast's 36 / 9 / 1
      V_STOP: 60, LIFE: 1.5, SUB: 0.2, MAX: 200   // m/s cooled + dropped, s, m per sub-step, fragments alive
    },
    /* Lava spatter (Step LV4, sim/spatter.js): a blast in / next to open lava throws glowing clots that fly, stick and
     * cool. Sizes log-normal (median D50, sigma SIG_LN, clamped DMIN-DMAX: "fist-size" clasts, USGS Halemaumau 2016);
     * launch speed V_REF * W^(1/6) * (D / D50)^-0.5 (small clasts are faster) x log-normal noise; steep cone (TH0-TH1
     * from the vertical) leaning away from the blast. Cooling: radial finite differences over NS shells (geometric,
     * outer skin ~0.4-4 mm), emissivity EPS radiation + convection HC (HC_FLY in flight) from the skin, transient
     * contact conduction into the ground EG / sqrt(pi t) over the contact share, latent heat LAT released between
     * T_SOL and T_LIQ; vesicular spatter (k 0.3-0.8, rho 1500-2500). In the game (lv4test) a 6 cm clot on rock: skin
     * < 650 C (dull red) at ~100 s, < 600 C (black in daylight) at ~170 s, core < 700 C at ~12 min; clots < 8 cm of
     * a lake blast: median skin 647 / 574 / 526 C at 1 / 2 / 3 min, none glowing at 4 min (§8 "Lava spatter (LV4)"). */
    SPATTER: {
      D50: 0.06, SIG_LN: 0.55, DMIN: 0.03, DMAX: 0.30,       // m (diameter)
      FRAC: 0.08,           // share of the thrown lava volume flown as clots (the rest lands as the near ring sheet)
      N_MAX: 48, N_MIN: 6,  // clots per blast (when any lava is thrown)
      V_REF: 11, V_SIG: 0.3, V_MIN: 3, V_MAX: 22,            // m/s
      TH0: 0.17, TH1: 0.96, // launch angle from the vertical (rad, 10-55 deg)
      T_LAUNCH: 1150, T_DROP: 300,                           // C at lava T 1, C cooler per (1 - T)
      RHO: 2100, CP: 1150, K: 0.8, EPS: 0.92, LAT: 3.5e5, T_SOL: 1000, T_LIQ: 1150,   // vesicular basalt clot
      HC: 10, HC_FLY: 40, EG: 1600, T_AIR: 20, NS: 6, Q_SH: 1.8,   // W/m2K, W s^0.5/m2K, C, shells, thickness ratio
      TDT: 0.25,            // s between thermal updates (sub-stepped for stability)
      FLAT_MIN: 0.45,       // height / width of the flattest splat (a hot, fast clot); cooler / slower stay rounder
      SUB: 0.1, LIFE: 12,   // m per flight sub-step, s max flight
      WORM_R: 0.45, BURN_HP: 4, BURN_MAX: 12,                // a hit burns BURN_HP x heat x (D / D50)^1.5 HP
      IGNITE_T: 650,        // C: a landing clot this hot lights dry grass under it
      COLD_T: 60,           // C core: stop the thermal update
      MAX: 360              // clots alive (oldest landed removed first)
    },
    /* Steel structures (Step M, sim/struct.js): Warren through-truss footbridges over gaps found per map */
    STRUCT: {
      SPAN_MIN: 8, SPAN_MAX: 22, DY_MAX: 1.2, GAP_MIN: 2.2,   // m: span, end height difference, gap under the deck
      WIDTH: 2.0, PANEL: 2.4, DEPTH_MIN: 1.2, DEPTH_MAX: 2.0, DECK_LIFT: 0.12,   // m: deck width, panel, truss depth
      GRID: 2.5, PLACE_R: 40, MAX_PER_MAP: 2, SEPARATE: 22,   // search grid / radius about the centre, bridges, spacing
      CUT_L: 0.18,          // m: contact-charge efficiency falls as exp(-standoff / CUT_L)
      DECK_R: 0.6           // m: a deck panel is holed only by a charge this close
    },
    /* Sea / pool ice (Step I, sim/ice.js; research §8 "Ice (I)"): Stefan growth, Gold bearing capacity, blasts */
    ICE: {
      ALWAYS: { alpine: true },                                   // freezes whatever the weather (cold climate)
      T_AIR: {                                                    // air temperature (°C) by biome x weather kind
        alpine: { clear: -10, cloudy: -8, rain: 1, storm: -2, snow: -12, blizzard: -20 },
        other: { clear: 4, cloudy: 3, rain: 5, storm: 4, snow: -4, blizzard: -9, ashfall: 6 }
      },
      T_TOD: { dusk: -2, night: -5 },  // °C: colder at dusk / at night (sim.time_of_day)
      TURN_H: 2,            // hours of frost per turn (a match spans a few days of ice growth)
      A_GROW: 2.2,          // cm / sqrt(°C day): sea ice, a little snow (Ashton / Lebedev; bare lake ice 3.3)
      NEW_K: 0.8,           // new ice at a freezing edge: this share of one turn's Stefan growth from 0
      MELT: 0.6,            // cm per °C per turn above 0 °C
      MELT_SUN: 0.5,        // cm per turn more on a clear day (sunshine melts the thin new ice first)
      PRE_TURNS: 16,        // turns of frost run at load (an old band along the shores, thinner outward) ...
      PRE_TURN_H: 12,       // ... each PRE_TURN_H hours long (days of winter before the match: ~20 cm at the shore)
      WET: 0.15,            // m of water needed under ice
      H_MIN: 0.5,           // cm: thinner is slush (no support, not drawn as ice)
      FREEBOARD: 0.12,      // ice top above the water = this x the thickness
      A_FAIL: 9,            // kg / cm²: Gold P = A h² at failure for sea ice (~60 % of clear fresh ice, 15-20)
      WORM_KG: 14,          // a worm's load on the ice (game scale, P30: one-turn ice ~1.5 cm carries a standing worm; a hard
                            // landing breaks it; 2-turn ice ~2.5 cm takes a 1 m drop)
      STOP_D: 0.05,         // m: stopping distance of a landing (F = m g (1 + sqrt(1 + 2 H / d)))
      HOLE_R: 0.45,         // m: hole where a load breaks through
      CRACK_K: 1.5,         // cracked floes out to this x the characteristic length l
      CRACK_TURNS: 3,       // turns until cracked floes have frozen back into the sheet
      E: 3e9,               // Pa: effective Young's modulus of sea ice (characteristic length)
      PUNCH: 2.2e5,         // J / m²: punching work ~ tau pi D h x h (tau 0.7 MPa, D 0.1 m): x h² (m)
      K_SURF: 1.2, K_UNDER: 3.5, H_REF: 20, HOLE_F: 0.45,       // blast: R = k W^1/3 / (1 + h / H_REF cm), hole HOLE_F R
      LOCK_H: 1.5,          // cm: a floating body is frozen in once its cell's ice is this thick
      // P30 floes, blast waves, snow on the ice, slipperiness
      FLOE_SIZE: 1.1,       // m: broken ice comes apart in pieces about this big
      FLOE_MAX: 320,        // floating floes at most (the oldest goes; a grenade's wave in 4 cm ice makes ~150)
      FLOE_DRAG: 0.5,       // 1/s: a floe takes up the water's velocity (low: a sheet on water keeps its momentum)
      FLOE_WIND: 0.05,      // share of the wind a floe drifts with
      WAVE_K: 7,            // m / kg^(1/3): a blast wave's breaking reach in ice of zero thickness (/ (1 + h / H_REF))
      SNOW_RATE: 0.02,      // cm/s of snow settling on the ice at full snowfall
      SNOW_MAX: 6,          // cm
      SNOW_GRIP: 0.5,       // cm of snow on the ice: the worm has grip again
      GRIP: 1.4             // 1/s: on bare ice a worm's speed eases to the walk speed this fast (slides when it stops)
    },
    LAVA_DPS: 22,           // HP/s while touching lava (open lava: x heat x (0.5 + immersion / 0.4 m))
    LAVA_WADE: 0.35,        // walk speed factor while wading in open lava
    // rigid bodies (sim/bodies.js): solver, sleep, impacts on worms
    BODY: { CRUSH_KG: 1500,       // PoC 'Buried!': a falling rock slab this heavy kills a standing worm under it
     
      MAX: 64, ITERS: 6, BAUMGARTE: 0.25, SLOP: 0.01, MAX_PUSH: 2.0,   // contact solver (projection: 25 %/step of pen - slop, <= 2 m/s)
      LIN_DAMP: 0.05, ANG_DAMP: 0.3, WATER_DRAG: 1.5, WATER_CD: 0.8,                  // 1/s
      ROLL_DAMP: 2.5,                                                  // 1/s on spin while touching ground (rolling resistance)
      ROLL_MU: 0.25,                                                   // B1: Coulomb rolling resistance coefficient (rock on soil)
      TORSION_R: 0.3,                                                  // B1: contact patch radius / sphere radius (torsional friction)
      SLEEP: 0.6, SLEEP_D: 0.04, SLEEP_A: 0.05, MAX_AGE: 40,   // moved < 4 cm, turned < 0.05 rad in
                                                                       // SLEEP s while touching -> sleep / re-bake
      HIT_V: 2.5, HIT_COOL: 0.6, HIT_MASS: 400, HIT_PER_KJ: 6, HIT_MAX: 60,   // worm hit: dmg = KE(kJ, mass <= 400) x 6
      BLAST_DV: 25                                                     // max blast velocity change (m/s)
    },
    /* Sea and shallow water (sim/water.js): virtual pipes on the lattice columns. */
    WATER: {
      DT: 1 / 60,           // fixed sub-step (s)
      DAMP: 0.15,           // 1/s flux decay (wave energy loss in open water)
      FRICTION: 0.02,       // bottom friction: extra decay FRICTION / depth (1/s per 1/m): shallow run-up dies fast
      RING: 8,              // sponge cells along the map edge (reservoir at SEA + swell)
      SPONGE: 1.5,          // 1/s relaxation toward the reservoir level at the outer edge
      SWELL_A: 0.12,        // swell amplitude (m) entering from the upwind edges
      SWELL_L: 14,          // swell wavelength (m)
      SWELL_DIR: 0.6,       // swell heading (rad, travel direction in xz); the weather step will drive these
      WET: 0.004,           // depth (m) below which a column counts as dry
      FR_MAX: 1.5, VMAX: 6, // reported velocity cap: Froude number and absolute (m/s); fluxes are not limited
      /* groundwater (water table = SEA): a pit dug below the table into permeable ground fills from below at SEEP m
       * per ROUND (every team moved once): each turn change releases SEEP / teams over SEEP_T s into the seeping
       * cells that are wet or a local low point of the surface, so the pool level (not each cell) rises ~2 cm/round */
      SEEP: 0.02,           // m of level rise per round
      SEEP_T: 4,            // s over which a turn's share seeps in after the turn change (unreleased rest carries, max 2 turns)
      // ground water seeps through (fractured rock, jointed basalt and loose ground); frozen ground (ice, snow), bedrock
      // and lava / crust are sealed. Below SEA inland temperate is all rock, so rock must seep or nothing ever does.
      SEEP_MATS: ['ROCK', 'SOIL', 'SAND', 'SANDSTONE', 'BASALT', 'ASH', 'SCREE']
    },
    /* Surface vegetation and grass fire (sim/veg.js). Heat rate into a neighbour = SPREAD_V f(dry) fuel I
     * exp(WIND_K wind.dir) phi(slope) / dist; a straight front on flat dry grass then moves ~0.25 m/s in calm air,
     * ~1.4 m/s with 5 m/s of wind behind it (McArthur: cured grass ~1 m/s at 18 km/h), faster uphill; a backing
     * fire upwind stalls; green grass (dry < DRY0) does not carry a fire. */
    VEG: {
      SPREAD_V: 0.1, WIND_K: 0.42,
      SLOPE_K: 5.0,         // uphill x(1 + K tan^2): 2.2x at 25 deg, 6x at 45 deg; downhill /(1 + K tan^2 / 3)
      BURN_T: 6.0,          // s a fully fuelled cell burns (flaming residence; an isolated cell lights its neighbours)
      RAIN_OUT: 0.5,        // rain above this douses burning cells (extra burn-down 6 (rain - 0.4) per s, partial char)
      DRY0: 0.15, DRY1: 0.85,
      IGNITE_DRY: 0.3,      // a fireball lights cells at least this dry; greener ones are only scorched
      HEAT_K: 2.8,          // fireball heat lights dry grass out to HEAT_K x BLAST.FIRE_R W^(1/3) (3.5 m at W 1;
                            // a W 1 crater in soil is ~1.9 m (eq.) / 2.5 m (max) wide, so the rim burns)
      STRIP_R: 3.5,         // blast flattening radius / W^(1/3) (m)
      CLEAR_D: 0.05,        // a column dug or buried by more than this (m) loses its turf (no regrowth in a match)
      EJECTA_K: 0.14,       // crater spoil blanket t(r) = K Rc^0.74 (r / Rc)^-3 m (McGetchin et al. 1973) out to EJECTA_R Rc;
      EJECTA_R: 2.5,        // Rc = equivalent radius of the columns dug deeper than EJECTA_D (the bowl, not its fringe)
      EJECTA_D: 0.25,
      EJECTA_T: 0.05,       // m of spoil that hides 63 % of the turf (cover x exp(-t / EJECTA_T); per-cell clumps x 0.4..1.6)
      EJECTA_FUEL_T: 0.3,    // fuel x exp(-t / this): the spoil lands in clods, dry stems between them still burn (a W 1
                            // crater is about as wide as the fireball's ignition reach; burying all fuel ended blast fires)
      FIRE_H: 1.2,          // flames reach this high above the ground (worm centre)
      DRY_BASE: { temperate: 0.12, alpine: 0.3, canyon: 0.72, desert: 0.9, volcanic: 0.62 }
    },
    /* Trees made of parts (sim/trees.js). Wood 600 kg/m^3 (floats). A segment snaps when the bending angular impulse
     * about its base, times its natural angular frequency, exceeds its strength MOR pi r0^3 / 4 (T2 dynamic response,
     * see sim/trees.js), or is cut by a burst within CUT_K W^(1/3) + r (if no thicker than CUT_D sqrt(W)). */
    TREES: {
      COUNT: { temperate: 22, alpine: 16, canyon: 9, desert: 4, volcanic: 6 },
      SPECIES: { temperate: 'oak', alpine: 'spruce', canyon: 'juniper', desert: 'snag', volcanic: 'snag' },
      SPEC: {                 // h, r (trunk base) ranges; nT trunk segments up to top x h; taper (top / base radius);
                              // lean (rad per m), wob (m of trunk wobble); dry = a + b x (grass dryness at the root)
        oak:     { h: [5.5, 8], r: [0.16, 0.24], nT: 3, top: 0.72, taper: 0.45, lean: 0.06, wob: 0.3, dry: [0.12, 0.5] },
        spruce:  { h: [6, 9.5], r: [0.13, 0.2], nT: 4, top: 1.0, taper: 0.15, lean: 0.02, wob: 0.08, dry: [0.3, 0.5] },
        juniper: { h: [2.6, 4], r: [0.1, 0.15], nT: 2, top: 0.72, taper: 0.55, lean: 0.25, wob: 0.4, dry: [0.45, 0.45] },
        snag:    { h: [3, 5.5], r: [0.12, 0.18], nT: 3, top: 0.9, taper: 0.4, lean: 0.1, wob: 0.3, dry: [0.95, 0] }
      },
      SEP: 3.5, WORM_SEP: 3,  // m between trees (and worm / prop spots), from worms
      WOOD_KG: 600, LEAF_KG: 6, MIN_KG: 2,   // wood density; leaf cluster kg / m^3 of r^3; lighter pieces vanish
      WOOD_E: 10e9, WOOD_MOR: 60e6,          // T2: green wood bending stiffness / modulus of rupture (Pa): dynamic break
      CUT_K: 0.55, POROSITY: 0.5, CHAR_WEAK: 0.6, SOLID_R: 0.06,  // cut radius x W^(1/3); crown porosity; charred
                              // wood strength loss; segments at least this thick are solid on the plane
      BURN_T: 25, LEAF_BURN_T: 8,            // s to char the wood / to burn the leaves off
      STRIKE_STRIP: 0.7, STRIKE_BREAK_R: 0.12, // lightning: leaf fraction stripped; the top segment snaps if thinner (m)
      IGNITE: 0.6, IGNITE_GREEN: 1.2,        // ignition heat = IGNITE + IGNITE_GREEN (1 - dry)
      FIREBALL_HEAT: 1.5, GRASS_HEAT: 0.06, TREE_HEAT: 0.35, COOL: 0.05,   // heat per fireball / per s per burning
                              // grass cell within 1.5 m of the root / per s from a burning neighbour; loss per s
      FIRE_R: 1.2,            // worms within this of a burning trunk burn
      // T1/T2: roots hold (plate radius ROOT_R_K x crown >= ROOT_R_MIN, ROOT_D deep; falls below ROOT_HOLD of it in
      // ground); a direct hit within the cut radius of the stem up to STEM_LOW m destroys stump + roots; torn-off
      // leaves pass LEAF_HOLD of their impulse on to the branch
      ROOT_R_K: 1.5, ROOT_R_MIN: 2.0, ROOT_D: 0.8, TAP_D: 1.5, ROOT_HOLD: 0.1, STEM_LOW: 1.0, LEAF_HOLD: 0.5,
      DRAG_CD: 1.2, JOINT: 0.6, // blast-wind drag coefficient (cylinder); branch junction strength vs clear wood
      CUT_D: 0.7                // a burst within CUT_K W^(1/3) + r cuts wood up to CUT_D sqrt(W) m thick
    },
    /* Props (sim/scatter.js): rigid bodies with a little state. Overpressure thresholds in kPa (blast.overpressure). */
    PROPS: {
      CRATE: { KG: 25, HALF: 0.5, BREAK_KPA: 70, BURN: 8 },               // wooden crate: shatters / burns out
      BARREL: { KG: 40, R: 0.3, H: 0.9, KPA: 150, DELAY0: 0.05, DELAY1: 0.15, BURN0: 3, BURN1: 6, W: M.pow(46 / 44, 3), DMG: 38,   // PoC explode(.., 46, 38)
               
                OIL_R: 2.4, OIL_T: 8 },                                    // fuel drum: W 1.5 + burning oil ring (m, s)
      MINE: { KG: 2, R: 0.2, PROX: 2.31, FUSE: 1.6, KPA: 100, W: M.pow(40 / 44, 3), DMG: 42, LAVA_T: 0.5, HOLE_R: 2.83, CHAIN0: 0.15, CHAIN1: 0.4, THROW: 380 * 0.0643, THROW_UP: 0.6 },   // PoC: a worm within 36 px (2.31 m) lights it, 1.6 s fuse, explode(.., 40, 42)
      BOULDER: { KG: 500, R: 0.42 },
      IGNITE_T: 1.5,        // a burning prop sets props within SPREAD m alight after this long
      SPREAD: 0.9,
      FIRE_R: 0.8,          // worms within this of a burning prop take FIRE_DPS
      SETTLE: 4,            // s of body simulation at load so props rest on the ground
      // per biome: crates, barrels, mines, boulders
      GIRDER: { L: 5, KG: 210, H: 0.3, B: 0.15 },          // M: loose steel I-beam (IPE 300, 42 kg/m)
      COUNT: { temperate: [3, 4, 6, 3, 1], alpine: [2, 3, 6, 5, 1], canyon: [2, 4, 6, 6, 2], desert: [3, 4, 6, 4, 3], volcanic: [2, 3, 6, 5, 2] },   // mines: 6 per match (PoC populate)
      // P24.10 (PoC PROPS): explosive cars (a strong blast or fire sets one off: R54 dmg 44 + burning fuel, a wreck stays),
      // metal junk (fridge, vending machine, phone booth: break under a blast, conduct lightning), stone monuments
      // (column, obelisk: heavy, never break). Size: PoC px x 0.0643. Placed after the classic props (own stream).
      CAR: { KG: 1100, L: 4.0, W: 1.65, H: 1.45, KPA: 110, DELAY0: 0.15, DELAY1: 0.45, W_BLAST: M.pow(54 / 44, 3), DMG: 44, FIRES: 3, BURN: 7 },
      JUNK: { fridge: [0.9, 1.75, 0.85, 90], vending: [1.15, 2.0, 0.95, 260], phonebooth: [0.95, 2.35, 0.95, 220], KPA: 85 },   // w, h, d (m), kg
      STONE: { column: [0.42, 3.0, 1800], obelisk: [0.5, 3.6, 1600] },   // r (base), h (m), kg
      EXTRA: { temperate: { car: 1, fridge: 1, vending: 1, phonebooth: 1, column: 1 }, alpine: { phonebooth: 1, obelisk: 1 }, canyon: { car: 1, column: 2, obelisk: 1 }, desert: { car: 2, vending: 1, column: 1, obelisk: 1 }, volcanic: { car: 1, obelisk: 1, column: 1 } },
    },
    /* Open lava = 2.5D viscous Bingham layer on the lattice columns (sim/lava.js). Mean velocity of a sheet of depth h on
     * surface slope s: u = g h^2 s / (3 nu) (1 - 1.5 r + 0.5 r^3), r = hc / h, hc = Y / s. nu = NU_HOT e^(NU_K (1 - T)),
     * Y = YIELD e^(YIELD_K (1 - T)), T = 1 eruption ... 0 solidus. NU_HOT 50 m^2/s = mu 1.3e5 Pa s (cooling basalt to
     * andesite), Y 0.006 m = yield stress ~150 Pa: a 0.7 m canal on a 0.3-0.6 slope creeps at ~1 m/min. */
    /* P29d bunkers (user 2026-10-08: "3D objects that look like they were built for defence: 1 entrance, a window big enough
     * to shoot from, a dome on top, thick concrete walls"): a round reinforced-concrete pillbox stamped into the voxel
     * world (MAT.CONCRETE: solid for worms and shots, destructible but tough, cut by the section like any rock).
     * N per map on flat open land; the embrasure faces the map centre, the door the other way. Metres. */
    BUNKER: { N: 2, R_OUT: 3.2, WALL: 0.9, H_WALL: 2.3, DOME_K: 0.9, FOUND: 0.6, DOOR_W: 1.7, DOOR_H: 2.0,
      SLIT_W_IN: 1.4, SLIT_W_OUT: 2.4, SLIT_Y0: 0.8, SLIT_Y1: 1.6, FLAT: 1.6, CLEAR: 7, APART: 20, EDGE: 12 },
      // (openings >= 3 lattice cells: the 0.5 m lattice and the cut face's smoothing close anything thinner)
    LAVA: {
      DT: 0.1,              // fixed sub-step (s)
      NU_HOT: 50,           // kinematic viscosity at T = 1 (m^2/s)
      NU_K: 4,              // viscosity growth with cooling
      YIELD: 0.006,         // yield length tau_y / (rho g) at T = 1 (m; ~150 Pa)
      YIELD_K: 4,           // yield growth with cooling (T 0.5: 0.044 m, T 0.2: 0.15 m)
      HMIN: 0.002,          // thinner sheets do not flow (m)
      COOL: 0.00006,        // dT/dt = -COOL / max(h, 0.1) * (1 + STILL_K * still): a fed channel stays hot over ~1 h of
                            // transit, a stagnant 0.5 m lobe bakes in ~15 min, a 0.1 m sheet in ~3 min (m/s)
      STILL_K: 8,           // a stagnant sheet grows a crust and cools this much faster
      STILL_V: 0.00017,     // below this mean speed (m/s, 1 cm/min) a column counts as still
      // P31 (user: lava against water "should be steaming A LOT and cool down on the connection pretty quickly, turning
      // into obsidian"): open lava under water or with water against its flank cools QUENCH_SIDE / h per s (1 m deep:
      // ~3 s to T_SOLID; before P31 the sea took QUENCH 0.02, ~45 s)
      // and bakes into OBSIDIAN; voxel lava touching water-filled cells turns into OBSIDIAN at once (one voxel: the
      // glass skin insulates the melt behind it), boiling QV_BOIL m of water off that column per voxel and hissing
      // steam for STEAM_T s. Swept QV_ROWS lattice rows every QV_EVERY s (a full map sweep ~0.5 s).
      QUENCH_SIDE: 0.3, QV_EVERY: 0.05, QV_ROWS: 20, QV_BOIL: 0.01, STEAM_T: 5, HISS_MAX: 12,
      T_SOLID: 0.12,        // colder lava stops and bakes into CRUST voxels
      BAKE_EVERY: 2,        // s between solidification passes
      LEAK_EVERY: 0.5,      // s between cave-leak passes (layer lava beside open cave air pours into the cave)
      LEAK_VOX: 4096,       // max cave voxels one leak pass explores (bounded work)
      VENT_Q: 0.035,        // vent supply (m^3/s) while the lake is below its level; with canals the lake settles where the
                            // notch outflow matches it (~15-35 l/s per canal -> ~0.6 m deep, ~1 m/min on the cone)
      VENT_R: 1.6,          // vent radius (m)
      DEEP: 2.5,            // m under a lava surface: deeper = inside a lava column, a worm / body rises at 1.5 m/s (no snap)
      LAKE_HEAT: 0.2,       // 1/s relaxation of the crater lake towards T = 1 (boiling, stirred)
      DRAIN_Q: 0.04,        // a breached pocket pours out at this rate (m^3/s) under DRAIN_HEAD m of lava above the hole
      DRAIN_HEAD: 2,        // (LV1: Q = DRAIN_Q x head / DRAIN_HEAD, 0.15-2x; only the lava above the hole drains)
      SPLASH_K: 0.6,        // a blast throws out lava within SPLASH_K * crater radius in lava
      PREROLL: 30,          // s simulated at load so the initial state has settled lobes
      /* LV3: a dense liquid. Molten basalt 2600 kg/m3 (2500-2800 with vesicles), surface tension ~0.35 N/m; a worm
       * (~1000 kg/m3, like a body) floats: at rest it sinks to RHO_WORM / RHO of its height (0.37), less where the
       * cooler skin's yield stress carries part of its weight, and gets there slowly (viscous: SINK_TAU at T = 1,
       * x exp(NU_K (1 - T)) cooler). Bodies: buoyancy of the immersed share + strong viscous drag toward the surface
       * velocity (Stokes, MU_SURF): wood and steel drums ride high, rock (~2600-2700) hangs and sinks slowly. */
      RHO: 2600,            // kg/m3
      RHO_WORM: 1000,       // kg/m3
      SINK_TAU: 3,          // s (worm immersion time constant at T = 1)
      MU_SURF: 1000,        // Pa s: hot surface lava a body moves through (fluid basalt 1e2-1e4). Stokes drag rate
                            // 3 pi mu d / m (x exp(NU_K (1 - T)) cooler): 22/s for a 170 kg, 0.4 m rock block (terminal
                            // sink speed of 2700 kg/m3 rock ~1.6 cm/s), >200/s for a crate (captured at once)
      BUOY_MAX: 6           // cap of the buoyancy ratio rho_lava / rho_body (stiffness; light props float at <= 1/6)
    },
    FIRE_DPS: 7             // HP/s while standing in flames
  };
  SS.CFG.css = rgb => '#' + rgb.toString(16).padStart(6, '0');
})(window.SS = window.SS || {});
