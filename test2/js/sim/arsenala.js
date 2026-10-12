/* sim/arsenala.js — P37-W3: weapons A (flamethrower, acid bomb, gas bomb, mortar, minigun, handgun, boomerang, mail
 * raven) as DATA, plus the global +100 % range upgrade. Loaded right AFTER sim/arsenal.js (it extends C.ARSENAL /
 * C.PROJ / C.ARMS in place and rebuilds the derived tables); sim/weaponsa.js (+ minigun.js, raven.js) holds the rules.
 *
 * RANGE UPGRADE (user 2026-10-10: "more range to all weapons, 100 % more"). What "range" means per weapon class:
 *   - charged / thrown shells (bazooka, grenade, cluster, banana, holy, homing, boulder, black hole, foam, the new
 *     acid / gas / mortar / boomerang): ballistic range ~ v^2 / g, so the launch speed is x sqrt(2) (C.RANGE.VK):
 *     the range at the same angle and power is exactly x 2. Homing keeps its steering limits (speed, acceleration, turn rate) x sqrt(2) as well;
 *   - dropped items (dynamite, mine, sheep, magnet, spring): NOT scaled (a drop has no range: set down at the feet);
 *   - hitscan: shotgun RANGE 25 -> 50 m, sniper RANGE 60 -> 120 m (its flight time x 2: the same speed);
 *   - melee / short tools: baseball bat REACH 1.2 -> 2.4 m, bellows RANGE x 2, girder REACH 14 -> 28 m, scrambler and
 *     pocket magnet radius x 2, torch / drill run time x 2 (twice the tunnel);
 *   - NOT changed (no range): air strike / napalm / thunder / moai / teleport (click anywhere on the section), the
 *     rope (W2), blast radii, mine / spring trigger radii, the sheep's walk speed.
 * C.RANGE = { K: 2, VK: sqrt(2) } is the single knob (set K = 1 for the original ranges: C.RANGE.apply() is run once
 * at load; tests that pin the original numbers use C.RANGE.orig).
 * The new weapons are written with their BASE numbers; the same factors are applied to them (flame speed, minigun and
 * handgun reach, ...), so "base" below x 2 = what plays.
 * Keys: all letters are taken (hotkeys + A D W S Q E F V M), so the new weapons use the numpad: N1..N8 (Numpad1..8). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, A = C.ARSENAL;
  if (!A || C.ARSENAL_A_DONE) return;
  C.ARSENAL_A_DONE = true;
  const VK = M.sqrt ? M.sqrt(2) : Math.sqrt(2), kV = C.SCALE.kV, kT = C.SCALE.kT, kL = C.SCALE.kL;
  const Wr = R => M.pow(R / 44, 3);
  C.RANGE = { K: 2, VK, orig: {} };         // (K: reach factor, VK: launch speed factor, orig: filled below with the numbers before the factors)

  /* ---------- projectile models of the new weapons ---------- */
  Object.assign(C.PROJ, {
    // sticky gel droplet (flamethrower): bursts into a burning patch (1-3 s) on terrain / props, sticks to a worm
    flamedrop: { boom: C.BOOM.FUEL, dmg: 2, impact: 1, arm: 0.03, W: 0, windK: 1.3, drag: 0.55, r: 0.04, wa: 1, flamedrop: 1, fire: 1 },
    // acid flask: bursts on contact into acid drops that eat the ground and burn worms
    acid: { dmg: 8, impact: 1, arm: 0.05, W: Wr(14), windK: 0.3, r: 0.1, wa: 1, acid: 1 },
    // gas canister: bounces like a grenade, the fuse (+ / -) opens it; the cloud infects
    gas: { dmg: 0, bouncy: 1, rest: 0.35, fric: 0.85, fuse: 3, fuseSet: 1, W: 0, windK: 0, r: 0.1, wa: 1, gas: 1 },
    // mortar shell: ballistic, bursts burstH m above the ground into bomblets
    mortar: { dmg: 22, impact: 1, arm: 0.25, W: Wr(26), windK: 0.5, r: 0.07, wa: 1, mortar: 1, metal: 1 },
    bomblet: { dmg: 14, impact: 1, arm: 0.1, W: Wr(20), windK: 0.3, r: 0.045, wa: 1, metal: 1 }
  });
  // the timed throwables get the +/- fuse; dynamite and the holy grenade join them (their old fixed fuses = the defaults)
  C.PROJ.holy.fuseSet = 1; C.PROJ.dynamite.fuseSet = 1;
  C.FUSE_DEFAULT = { grenade: 3, cluster: 3, banana: 3, holy: 3, dynamite: 5, gas: 3 };
  C.FUSE_KEYS = ['grenade', 'cluster', 'banana', 'holy', 'dynamite', 'gas'];      // (a fixed order for the hash: P84)
  C.PARAM = { FUSE_MIN: 0.5, FUSE_MAX: 5, FUSE_STEP: 0.5, BURST_MIN: 1, BURST_MAX: 5, BURST_STEP: 1, BURST_DEF: 3, MINE_MIN: 0, MINE_MAX: 3, MINE_STEP: 0.5, MINE_DEF: 1.5 };

  /* ---------- constants of the weapons ---------- */
  Object.assign(C.ARMS, {
    // Flamethrower: FLAME.RATE droplets / s for DUR s along the aim (muzzle V m/s, base reach ~ 6 m x 2); each droplet
    // that lands burns LIFE0..LIFE1 s (merged within MERGE m: the patch grows and keeps burning); on a worm it sticks
    // STICK0..STICK1 s (7 HP/s: C.FIRE_DPS)
    FLAME: { DUR: 2.2, RATE: 62, V: 15 * VK, SPREAD: 0.075, MUZZLE: 0.75, LIFE0: 1, LIFE1: 3, R: 0.36, MERGE: 0.3, CAP: 90, STICK0: 1, STICK1: 3, DPS: 7 },
    // Acid bomb: N drops thrown out radially; a drop that lands becomes a spot eating DEPTH m into the ground over its
    // LIFE; worms in a spot take DPS HP/s and hop (HOP_VS / HOP_VY, every HOP0..HOP1 s, alternating sides, "ouch")
    ACID: { N: 16, V0: 3, V1: 9, UP: 5, R: 0.5, LIFE0: 6, LIFE1: 9, DEPTH: 1.9, TICK: 0.75, CARVE_R: 0.45, DPS: 6, HOP_VS: 3.4, HOP_VY: 7.2, HOP0: 0.5, HOP1: 0.85, MERGE: 0.35, CAP: 70, BLAST_W: Wr(14), DEVICE_DPS: 14, PROP_T: 1.6, GIRDER_T: 10, CAR_T: 4 },
    // Gas bomb: a cloud growing to R_MAX over GROW s, drifting with the wind (WIND_K), thinning over LIFE s; a worm in
    // it (density >= DENS_MIN) is infected for good: it coughs every COUGH0..COUGH1 s and, at the first turn of every
    // new ROUND (S.round), loses DMG0..DMG1 HP (never cured except by a health crate)
    GAS: { R0: 0.7, R_MAX: 4.4, GROW: 3.5, LIFE: 16, FADE: 6, WIND_K: 0.8, SINK: 0.25, DENS_MIN: 0.25, COUGH0: 2.2, COUGH1: 5, PUF: 56, DIFF: 2.4, RELAX: 3, INF_R: 1.9, INF_N: 2, DMG0: 2, DMG1: 4, CAP: 6 },
    // Mortar: always full power (MORTAR.V m/s); bursts BURST_DEF m above the ground (1-5 m, + / -) into N bomblets
    // that land within SPREAD m of the burst point
    MORTAR: { V: 20, N: 8, SPREAD: 3.0, JY0: -1.5, JY1: 1.5 },
    // Minigun: DUR s burst at RATE rounds / s (spin-up SPIN s, spin-down SPIN s), hitscan to RANGE m with a SPREAD cone;
    // a worm takes DMG per round, terrain is chipped (CHIP m radius) and worms within SPLASH m of an impact take SPLASH_DMG
    MINIGUN: { DUR: 2.0, RATE: 38, SPIN: 0.45, RANGE: 26, SPREAD: 0.035, DMG: 2, PUSH: 5 * kL, CHIP: 0.3, SPLASH: 1.0, SPLASH_DMG: 1, GIB_HP: 0, MUZZLE: 0.9, BODY_W: Wr(10) },
    // Handgun: HITSCAN, 2 shots, explosive rounds (a small blast at the first thing hit)
    HANDGUN: { RANGE: 9, SHOTS: 2, DMG: 15, W: Wr(15), BLAST_DMG: 16, MUZZLE: 0.6 },
    // Boomerang: thrown at V m/s x power along the aim. The curved flight of a real one (it banks round in a plane that
    // precesses) seen in the section: a pull back toward the throw point in s and y (harmonic, return time T s) while the
    // throw altitude sags by LOW m over the flight, so it leaves, climbs, comes back to the thrower and passes LOW m lower
    // (the renderer draws the sideways bank; the sim stays in the section plane). DRAG 1/s thins the amplitude slightly.
    BOOM: { V: 22, T: 2.8, LOW: 1.4, DRAG: 0.12, DMG: 26, PUSH: 300 * kL, PUSH_UP: 90 * kL, R: 0.5, LIFE: 9, ARM_OWN: 1.0, CATCH_R: 1.3, DENT_V: 10, DENT_R: 0.3, REST: 0.5, BANK: 2.6 },
    // Mail raven: released at the aim, fast phase (V_FAST -> V_CRUISE, time constant TAU); striking something above
    // CRASH_V m/s crashes it (it drops and blows up after CRASH_FUSE s); else it flies (path-finding probes PROBE m ahead)
    // to ALT m above the target, circles it (R_ORBIT) and drops N letters (flutter, wind, contact fuse), then leaves
    RAVEN: { V_FAST: 38, V_CRUISE: 14, TAU: 0.35, CRASH_V: 16, CRASH_FUSE: 1.0, CRASH_W: Wr(38), CRASH_DMG: 34, ALT: 5, R_ORBIT: 2.4, N: 5, TURN: 4.5, PROBE: 5.5, LETTER_W: Wr(20), LETTER_DMG: 18, FALL: 2.2, FLUTTER: 1.2, LIFE: 25, DROP_GAP: 0.3, BLOCK_STICKY: 0.3 }
  });

  /* ---------- the weapons (ammo defaults: crates can add more) ---------- */
  const NEW = {
    flamethrower: { name: 'Flamethrower', kind: 'stream', ammo: 3, key: 'N1', code: 'Numpad1', retreat: 5, crate: 1, wa: 1, info: 'Sprays sticky burning gel that burns 1-3 s wherever it lands (aim ↑↓ while it runs)' },
    acid: { name: 'Acid Bomb', kind: 'charge', ammo: 1, key: 'N2', code: 'Numpad2', vmax: 20, payload: 1, crate: 1, wa: 1, info: 'Bursts into green acid that eats through the ground; worms in it hop and scream' },
    gas: { name: 'Gas Bomb', kind: 'charge', ammo: 2, key: 'N3', code: 'Numpad3', vmax: 20, payload: 1, crate: 1, wa: 1, info: 'A drifting gas cloud infects worms: they cough and lose 1-3 HP every round (+ / -: fuse)' },
    mortar: { name: 'Mortar', kind: 'charge', fixed: 1, ammo: 3, key: 'N4', code: 'Numpad4', vmax: 20, payload: 1, crate: 1, wa: 1, info: 'Always full power; bursts into bomblets above the target (+ / -: burst height 1-5 m)' },
    minigun: { name: 'Minigun', kind: 'stream', ammo: 0, key: 'N5', code: 'Numpad5', retreat: 4, crate: 1, wa: 1, info: 'Six barrels, a hail of rounds that chew the ground and tear worms apart (aim ↑↓ while it spins)' },
    handgun: { name: 'Handgun', kind: 'hitscan', ammo: 4, key: 'N6', code: 'Numpad6', retreat: 3, crate: 1, wa: 1, info: 'Two explosive rounds at short range' },
    boomerang: { name: 'Boomerang', kind: 'charge', ammo: 3, key: 'N7', code: 'Numpad7', vmax: 22, crate: 1, wa: 1, info: 'Flies out, curls and comes back lower; hits the first worm on the way' },
    raven: { name: 'Mail Raven', kind: 'target', twostep: 1, ammo: 1, key: 'N8', code: 'Numpad8', retreat: 4, crate: 1, wa: 1, info: 'Click the target; the raven leaves along your aim, circles above it and drops five explosive letters' }
  };
  C.ARSENAL_A = NEW;

  /* ---------- merge into the arsenal tables (before 'skip'), then the range upgrade ---------- */
  const skipAt = C.ARSENAL_ORDER.indexOf('skip');
  const keys = Object.keys(NEW);
  for (const k of keys) { A[k] = NEW[k]; }
  C.ARSENAL_ORDER = C.ARSENAL_ORDER.filter(k => keys.indexOf(k) < 0);
  C.ARSENAL_ORDER.splice(skipAt < 0 ? C.ARSENAL_ORDER.length : skipAt, 0, ...keys);
  C.CRATE_POOL = C.ARSENAL_ORDER.filter(k => A[k].crate);
  for (const k of keys) C.WEAPONS[k] = Object.assign({}, C.PROJ[k] || {}, C.WEAPONS[k] || {}, A[k]);
  for (const k in C.PROJ) if (!C.WEAPONS[k]) C.WEAPONS[k] = Object.assign({ name: k }, C.PROJ[k]);
  C.WEAPON_ORDER = C.ARSENAL_ORDER.slice();
  /* P38 R7: the weapon index (C: enum WeaponId): every C.WEAPONS key in ONE explicit order = the arsenal order, then the projectile-only keys.
   * Used wherever an event / struct names a weapon by number (hurt's arg) instead of by string. Checked by tools/dev/gen/r7test.cjs. */
  C.WEAPON_KEYS = C.ARSENAL_ORDER.concat(['clusterlet', 'bananalet', 'missile', 'flame', 'fuel', 'flamedrop', 'bomblet']);
  for (const k of ['holy', 'dynamite']) { C.WEAPONS[k].fuseSet = 1; }

  /* The range upgrade as DATA (P38 R7: no apply(), no flag, no in-place scaling; the numbers below are the final ones = the base number x K / x VK, written out).
   * Applied here as plain assignments (this file extends the tables of arsenal.js); C.RANGE.orig keeps the numbers before the factor for tests and docs.
   * A native port takes the final tables from `node tools/dev/gen/bakeweapons.cjs` (docs/weapondefs.json), which tools/dev/gen/r7test.cjs keeps current. */
  const RK = C.RANGE.K, VKf = C.RANGE.VK, o = C.RANGE.orig = {}, AR = C.ARMS;
  // charged shells: launch speed x VK (range x 2); the merged views C.WEAPONS copy vmax, so both get the value
  for (const k of ['bazooka', 'grenade', 'cluster', 'homing', 'banana', 'holy', 'boulder', 'blackhole', 'foam', 'gravgun', 'acid', 'gas', 'mortar', 'boomerang']) { o[k] = A[k].vmax; A[k].vmax = o[k] * VKf; C.WEAPONS[k].vmax = A[k].vmax; }
  { const h = C.PROJ.homing.homing; o.homing_v = h.vmax; h.vmax = h.vmax * VKf; h.accel = h.accel * VKf; h.turn = h.turn * VKf; }     // (the turn rate too: the turning circle stays the same size relative to the speed)
  // dropped items are NOT scaled (a drop is set down at the worm's feet; x sqrt 2 tossed dynamite ~4 m down a slope: lead's merge fix, replaytest)
  o.shotgun = AR.SHOTGUN.RANGE; AR.SHOTGUN.RANGE = o.shotgun * RK;
  o.sniper = [AR.SNIPER.RANGE, AR.SNIPER.LIFE]; AR.SNIPER.RANGE = o.sniper[0] * RK; AR.SNIPER.LIFE = o.sniper[1] * RK;
  o.bat = AR.BAT.REACH; AR.BAT.REACH = o.bat * RK;
  o.bellows = AR.BELLOWS.RANGE; AR.BELLOWS.RANGE = o.bellows * RK;
  o.girder = AR.GIRDER.REACH; AR.GIRDER.REACH = o.girder * RK;
  o.scrambler = AR.SCRAMBLER.R; AR.SCRAMBLER.R = o.scrambler * RK;
  o.magnet = AR.MAGNET.R; AR.MAGNET.R = o.magnet * RK;
  o.dig = [AR.DIG.TORCH_T, AR.DIG.DRILL_T]; AR.DIG.TORCH_T = o.dig[0] * RK; AR.DIG.DRILL_T = o.dig[1] * RK;
  o.minigun = AR.MINIGUN.RANGE; AR.MINIGUN.RANGE = o.minigun * RK;
  o.handgun = AR.HANDGUN.RANGE; AR.HANDGUN.RANGE = o.handgun * RK;
})(window.SS = window.SS || {});
