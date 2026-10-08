/* sim/arsenal.js — the PoC's 28 weapons and tools as data (P2; docs/poc-weapons.md has every PoC rule with line numbers).
 * Converted with the P.4 scale rules (HANDOFF §P.4): launch speeds by the poc5 anchors (thrown 821 px/s and rocket
 * 1026 px/s = 28 m/s, so every weapon keeps its PoC speed ratio), accelerations k_A = 9.81 / 520, effect zones by the
 * worm (k_L = 0.45 / 7 m per px, long ranges by their share of the map), times unchanged, blasts by cube-root scaling
 * W = (R / 44)^3 x 1 kg (grenade = 1 kg; the bazooka keeps poc5's 0.8 kg), HP numbers unchanged.
 * Fields: kind charge | drop | target | hitscan | melee | dig | utility | rope | skip; ammo per team (Infinity = no
 * limit); key (PoC hotkey, informational: the platform maps keys); proj (projectile model, below); retreat (s);
 * payload (may be dropped from the rope); crate (in the supply-crate pool).
 * Projectile model (p.type = weapon or sub-munition key, all in C.PROJ): impact (bursts on contact) | bouncy (rest =
 * restitution, fric = tangential retention per bounce, fuse s, fuseSet = F key sets it) ; W (kg TNT-eq), windK, drag
 * (1/s), arm (s before terrain contact counts), split {kind, n, jx, vy0, vy1} (m/s), fire (burning patches), metal
 * (magnets pull it), special handlers: homing | sheep | hole | foam | napalm | flame.
 * C layout: const WeaponDef ARSENAL[NWEAPONS]; const ProjDef PROJ[NPROJ]. */
(function (SS) {
  'use strict';
  const M = SS.math;
  const C = SS.CFG;
  const kV = 28 / 1026, kT = 28 / 821, kA = 9.81 / 520, kL = 0.45 / 7;
  const Wr = R => M.pow(R / 44, 3);
  C.SCALE = { kV, kT, kA, kL };

  /* projectile models (dmg: the PoC explode() damage, PROJ table L3258: HP at the centre x pressureFactor x cover) */
  C.PROJ = {
    bazooka: { dmg: 50, impact: 1, W: 0.8, windK: 1, frag: 1, metal: 1, r: 0.06 },
    grenade: { dmg: 50, bouncy: 1, rest: 0.45, fric: 0.9, fuse: 3, fuseSet: 1, W: 1.0, windK: 0, frag: 1, metal: 1, r: 0.09 },
    cluster: { dmg: 25, bouncy: 1, rest: 0.4, fric: 0.9, fuse: 3, fuseSet: 1, W: Wr(30), windK: 0, metal: 1, r: 0.09,
      split: { kind: 'clusterlet', n: 5, jx: 170 * kT, vy0: 220 * kT, vy1: 430 * kT } },
    clusterlet: { dmg: 18, impact: 1, arm: 0.08, W: Wr(22), windK: 0, metal: 1, r: 0.05 },
    banana: { dmg: 70, bouncy: 1, rest: 0.68, fric: 0.94, fuse: 3, fuseSet: 1, W: Wr(56), windK: 0, r: 0.1,
      // user 2026-10-08: the sub-bananas flew too far (PoC jx 250, vy 220-430 px/s): 150 / 180-320
      split: { kind: 'bananalet', n: 5, jx: 150 * kT, vy0: 180 * kT, vy1: 320 * kT } },
    bananalet: { dmg: 42, impact: 1, arm: 0.12, W: Wr(42), windK: 0, r: 0.07 },
    holy: { dmg: 100, bouncy: 1, rest: 0.3, fric: 0.8, fuse: 3, W: Wr(110), windK: 0, metal: 1, r: 0.12, big: 1 },
    homing: { dmg: 50, impact: 1, W: 0.8, windK: 1, frag: 1, metal: 1, r: 0.06, homing: { turn: 3.0, accel: 100 * kV, vmax: 1100 * kV, fuel: 4, gLock: 0.3, gFly: 0.08, windLock: 0.25, blend: 0.3, lock0: 0.4, lock1: 1.2 } },   // turn / lock: PoC 1.2 rad/s, 0.8-1.8 s, made 2.5 x as agile: poc5 speeds are lower relative to the map (P.4), so PoC values loop 25 m wide
    dynamite: { dmg: 75, bouncy: 1, rest: 0.12, fric: 0.6, fuse: 5, W: Wr(72), windK: 0, metal: 1, r: 0.1 },
    sheep: { dmg: 75, sheep: 1, fuse: 10, W: Wr(64), r: 0.3, walk: 85 * kT, hopVy: 215 * kT, hopVx: 95 * kT, hop0: 0.7, hop1: 1.5 },
    blackhole: { dmg: 0, bouncy: 1, rest: 0.35, fric: 0.85, fuse: 2.5, W: 0, windK: 0, metal: 1, r: 0.1, hole: 1 },
    foam: { dmg: 0, impact: 1, W: 0, windK: 0.6, r: 0.1, foam: { rx: 2.7, ry: 1.9, rz: 1.5 } },
    missile: { dmg: 30, impact: 1, W: Wr(34), windK: 0.6, metal: 1, r: 0.06 },
    napalm: { dmg: 12, impact: 1, W: Wr(18), windK: 0.4, r: 0.07, napalm: { n: 9, v0: 30 * kT, v1: 120 * kT }, fire: 5 },
    flame: { dmg: 3, impact: 1, arm: 0.05, W: 0, windK: 2.6, drag: 2.6, r: 0.04, flame: 1, fire: 1 },
    fuel: { dmg: 6, impact: 1, arm: 0.12, W: 0, windK: 1.8, drag: 1.25, r: 0.03, flame: 1, fire: 1 }   // PoC napalm-crate fuel gobs (R9 dmg 6)
  };
  /* black hole, sheep, napalm, sniper, tools: constants of the special handlers */
  C.ARMS = {
    // P24.3: what pushes WORMS is on the worm scale kL (they fly under G_WORM = 520 px/s2 x kL); projectiles and bodies
    // keep kT / kA. Hole on worms: PoC min(1400, 6e5 / (d2 + 600)) px/s2 within 260 px -> 159.5 / (d2 + 2.48) m/s2, 90 max, 16.7 m
    HOLE: { LIFE: 3.2, GROW: 0.6, PULL_R: 10,
      // P29c suction / break-up (poc5, user 2026-10-08): worms within SUCK_R m are drawn in kinematically (velocity eased at
      // SUCK_BLEND 1/s toward SUCK_V (1 - d / SUCK_R) + 1 m/s inward, gravity cancelled), held inside CAPTURE_R; bodies get
      // SUCK_K / (d² + 1) m/s² (gravity cancelled toward the core; CAPTURE_DAMP unused by worms), SWIRL share; the ground within
      // BREAK_R m breaks off in BREAK_BLOB m blobs every BREAK_T s (BREAK_MAX pieces), thrown in at BREAK_V m/s
      SUCK_R: 6, SUCK_K: 55, SUCK_V: 7, SUCK_BLEND: 4, CAPTURE_R: 1.2, CAPTURE_DAMP: 5, SWIRL: 0.35, BREAK_R: 4.5, BREAK_BLOB: 1.0, BREAK_T: 0.3, BREAK_MAX: 6, BREAK_V: 3, A_MAX: 1400 * kA, A_K: 16.8, A_D2: 0.89, W_PULL_R: 260 * kL, W_A_MAX: 1400 * kL, W_A_K: 6e5 * kL * kL * kL, W_A_D2: 600 * kL * kL, CORE: 1.0, CORE_DPS: 12, CARVE_T: 0.12, CARVE_R0: 0.5, CARVE_R1: 1.5, W_END: Wr(64) },
    PLANE: { SPEED: 560 * kT, START: 40, ALT: 9, N: 5, GAP: 1.8, DROP_VS: 170 * kT, DROP_VY: -90 * kT },
    NAPALM: { PATCH_R: 0.55, LIFE0: 4, LIFE1: 7, SHELL_FIRE: 6 },
    TESLA: { DELAY: 0.7, W: Wr(24), R1: 3.9, D1: 16, R2: 5.5, D2: 26, BOLT_D: 10, CHAIN_R: 3.9, CONDUCT_R: 1.4, PUSH_UP: 120 * kL },
    MOAI: { V0: 260 * kT, SMASH_V: 170 * kT, SMASH_N: 2, W: Wr(32), LIFE: 3.5, ALT: 14, KG: 900 },
    SHOTGUN: { RANGE: 25, DMG: 25, PUSH: 240 * kL, PUSH_UP: 90 * kL, W: 0.012, SHOTS: 2 },
    SNIPER: { V: 3600 * kV, G: 0.5, RANGE: 60, PEN: 0.45, DMG: 45, PUSH: 120 * kL, KEEP: 0.92, PEN_STEP: 7 / 0.45, LIFE: 1.2 },
    BAT: { REACH: 1.2, DMG: 30, PUSH: 640 * kL, PUSH_UP: 60 * kL },
    DIG: { TORCH_V: 30 * kT, TORCH_T: 3.2, DRILL_V: 36 * kT, DRILL_T: 2.6, R: 0.62, TICK: 0.05, DMG: 15, PUSH: 160 * kL },
    TELEPORT: { BEAM: 1.5 },
    GIRDER: { L: 5.9, T: 0.6, D: 1.5, REACH: 14, ANGLES: 8 },
    // PoC bellows: 460 (1 - d / R) + 60 px/s within 170 px (10.9 m); worms on kL, shells on kT
    BELLOWS: { RANGE: 170 * kL, COS: 0.82, V0: 460 * kL, V1: 60 * kL, UP: 65 * kL, PV0: 460 * kT, PV1: 60 * kT, PUP: 65 * kT },
    MAGNET: { R: 9.3, A: 650 * kA, TURNS: 4, MAX: 4, ARM: 1, KG_CAP: 180 },
    // user 2026-10-07: a buried trap for worms only; throws the worm high (V_UP 30 m/s under the worms' gravity 33.4:
    // ~13 m up): 20 HP for the sudden launch + at least 20 from the landing
    SPRING: { R: 1.2, V_UP: 30, V_SIDE: 3.5, DMG: 20, FALL_MIN: 20, TURNS: 8, CHARGES: 3, COOL: 1.2, ARM: 1.5 },
    // user 2026-10-07: traps / mines burrow: planters' team sees them; everyone sees the planting for PLANT_SEEN s; the
    // map's own mines are shown to all (+ red arrows on the top map) for MAP_MINES_SEEN s from the first turn
    TRAPS: { PLANT_SEEN: 2.5, MAP_MINES_SEEN: 12, DETECT_FUSE0: 0.4, DETECT_FUSE1: 0.9 },
    SCRAMBLER: { R: 7.7, ADD: 2 },
    MINE: { ARM: 3 },
    DROP_TOSS: { GROUND_VS: 40 * kT, GROUND_VY: 60 * kT, AIR_VS: 115 * kT, AIR_VY: 45 * kT }
  };

  /* the weapons (PoC order); the bar / grid shows them in this order */
  const A = C.ARSENAL = {
    bazooka: { name: 'Bazooka', kind: 'charge', ammo: Infinity, key: '1', vmax: 28, payload: 1, info: 'Rocket: bursts on contact; the wind pushes it' },
    grenade: { name: 'Grenade', kind: 'charge', ammo: Infinity, key: '2', vmax: 28, payload: 1, info: 'Bounces, bursts when its fuse runs out (F: 1-5 s)' },
    cluster: { name: 'Cluster', kind: 'charge', ammo: 3, key: '3', vmax: 28, payload: 1, crate: 1, info: 'Bursts into five bomblets' },
    shotgun: { name: 'Shotgun', kind: 'hitscan', ammo: Infinity, key: '4', info: 'Two shots per turn' },
    bat: { name: 'Baseball Bat', kind: 'melee', ammo: 2, key: 'Z', retreat: 3, info: 'Knocks a worm far away' },
    homing: { name: 'Homing', kind: 'charge', target: 1, ammo: 2, key: '5', vmax: 1050 * kV, payload: 1, crate: 1, info: 'Click a target, then fire: the missile steers to it' },
    dynamite: { name: 'Dynamite', kind: 'drop', ammo: 2, key: '6', payload: 1, crate: 1, info: 'Drop it and run: 5 s fuse, big blast' },
    banana: { name: 'Banana', kind: 'charge', ammo: 1, key: '7', vmax: 28, payload: 1, crate: 1, info: 'Very bouncy; splits into five heavy bomblets' },
    airstrike: { name: 'Air Strike', kind: 'target', ammo: 1, key: '8', retreat: 4, strike: 1, crate: 1, info: 'Click the target; ← → choose the side the plane comes from' },
    holy: { name: 'Holy Grenade', kind: 'charge', ammo: 1, key: '9', vmax: 775 * kT, payload: 1, crate: 1, info: 'Fixed 3 s fuse, the biggest blast' },
    sheep: { name: 'Sheep', kind: 'drop', ammo: 2, key: '0', retreat: 10, payload: 1, crate: 1, info: 'Walks and hops; fire again to set it off' },
    boulder: { name: 'Boulder', kind: 'charge', ammo: 2, key: 'B', vmax: 730 * kT, payload: 1, crate: 1, info: 'A heavy rock that rolls and crushes' },
    blackhole: { name: 'Black Hole', kind: 'charge', ammo: 1, key: 'H', vmax: 730 * kT, payload: 1, crate: 1, info: 'Pulls everything in for 3 s, then bursts' },
    tesla: { name: 'Thunder Strike', kind: 'target', ammo: 1, key: 'L', retreat: 4, crate: 1, info: 'Thunderstorms only: lightning on the target; arcs jump between worms and metal' },
    napalm: { name: 'Napalm', kind: 'target', ammo: 1, key: 'N', retreat: 4, strike: 1, crate: 1, info: 'Fire bombs burst in the air and rain burning gel' },
    moai: { name: 'Moai Drop', kind: 'target', ammo: 1, key: 'O', retreat: 4, crate: 1, info: 'A stone head falls from the sky' },
    mine: { name: 'Mine', kind: 'drop', ammo: 2, key: 'X', payload: 1, crate: 1, info: 'Buried: only your team sees it; arms after 3 s, any worm close by sets it off' },
    drill: { name: 'Torch / Drill', kind: 'dig', ammo: 2, key: 'Y', retreat: 4, crate: 1, info: 'Aim level to burn a tunnel, down to drill' },
    rope: { name: 'Ninja Rope', kind: 'rope', ammo: Infinity, key: 'R', info: 'Swing; Enter drops the selected weapon' },
    teleport: { name: 'Teleport', kind: 'target', ammo: 2, key: 'T', retreat: 3, crate: 1, info: 'Click a free spot on the section' },
    girder: { name: 'Girder', kind: 'target', ammo: 3, key: 'G', retreat: 3, crate: 1, info: 'Indestructible steel beam; ↑ ↓ turn it' },
    bellows: { name: 'Bellows', kind: 'utility', ammo: 3, key: '-', retreat: 3, crate: 1, info: 'A detector blast: sets off and reveals mines, traps and bombs in its cone, blows worms away, puts out fire' },
    sniper: { name: 'Sniper Rifle', kind: 'hitscan', ammo: 3, key: 'C', retreat: 4, crate: 1, info: 'Fast bullet with drop; goes through thin cover' },
    foam: { name: 'Foam Mortar', kind: 'charge', ammo: 3, key: 'P', vmax: 730 * kT, payload: 1, crate: 1, info: 'Builds a block of weak foam (floats on water)' },
    magnet: { name: 'Pocket Magnet', kind: 'drop', ammo: 2, key: 'I', retreat: 3, payload: 1, crate: 1, info: 'Pulls metal shells and mines for 4 turns' },
    spring: { name: 'Spring Mine', kind: 'drop', ammo: 2, key: 'J', retreat: 3, payload: 1, crate: 1, info: 'Buried trap only your team sees: throws an enemy worm high (20 HP + a hard fall)' },
    scrambler: { name: 'Fuse Scrambler', kind: 'utility', ammo: 2, key: 'U', retreat: 3, crate: 1, info: 'Adds 2 s to the fuses around you' },
    skip: { name: 'Skip Go', kind: 'skip', ammo: Infinity, key: 'K', info: 'End the turn' }
  };
  C.ARSENAL_ORDER = Object.keys(A);
  C.CRATE_POOL = C.ARSENAL_ORDER.filter(k => A[k].crate);
  // the poc5 core keeps C.WEAPONS (name, W, fuse, windK, frag ...) for every weapon key: merged views
  for (const k of C.ARSENAL_ORDER) C.WEAPONS[k] = Object.assign({}, C.PROJ[k] || {}, C.WEAPONS[k] || {}, A[k]);
  for (const k in C.PROJ) if (!C.WEAPONS[k]) C.WEAPONS[k] = Object.assign({ name: k }, C.PROJ[k]);
  C.WEAPON_ORDER = C.ARSENAL_ORDER.slice();
})(window.SS = window.SS || {});
