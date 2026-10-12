/* sim/balance.js — P38 A2: the BALANCE TABLE. One row per weapon / tool of C.ARSENAL plus one per tool-crate delivery.
 * The table is the source of truth for: starting ammo per team (cross-checked against C.ARSENAL[k].ammo by
 * tools/dev/gen/baltest.cjs), the supply-crate weight of every weapon (SS.balance.crate_pick: the weighted draw that
 * replaced the uniform one in weapons.js), the tool-crate weights (skills.js reads B.TOOLS), the crate economy (B.ECON)
 * and the derived value / rarity band of each row. docs/BALANCE.md is generated from it (node tools/dev/balance.cjs),
 * with the measurements of tools/dev/balanceharness.cjs (docs/balance_shots.json, docs/balance_matches.json).
 *
 * Row fields (C: struct BalRow, 56 bytes, const BalRow BAL[NWEAPONS]):
 *   k        char[12]  arsenal key
 *   ammo     i16       starting ammo per team (Infinity -> -1 = unlimited), equals C.ARSENAL[k].ammo
 *   dmg      f32       HP taken off ONE 100-HP foe by one use, perfect shot on flat ground, a 12 m range (measured: balshots 'one')
 *   dmgN     f32       HP in total off THREE foes standing 1.5 m apart (measured 'three'); the group bonus is weighted 25 %
 *   dot      f32       HP of poison / burn that arrives later than the shot's 20 s window (gas: 6 rounds)
 *   knock    f32       m the hardest-hit foe was thrown (measured; into the sea = a kill)
 *   terr     f32       m3 of terrain removed (measured, soil)
 *   range    f32       reach in m (0 = set down at the feet, 999 = anywhere on the section)
 *   hits     u8        separate damaging hits one use can deliver (bomblets, rounds, missiles)
 *   aim tim exp u8     difficulty 0..3: aim = precision needed (0 = click / no aim), tim = timing / fuse / waiting for
 *                      the victim, exp = exposure of the shooter (self damage, standing in the open, turn delay)
 *   util     u8        utility points 0..6 for non-damage effect (escape, cover, mobility, denial): 1 point = UTIL_HP HP
 *   cond     f32       0..1 share of uses whose nominal effect really lands (storm-only, traps need a victim to walk in)
 *   prem     f32       HP-equivalent premium for effects the shots cannot measure (denial, area control); documented per row
 *   delay    f32       seconds of retreat after the use (= C.ARSENAL[k].retreat, default C.GAME.RETREAT)
 *   crateW   f32       weight in the supply-crate draw (= the weight of its band; 0 = not in the crate pool)
 *   counter  char[]    how the victim plays against it
 * Derived (B.value): P = min(dmg,100) + GROUP_K * max(0, min(dmgN,300) - min(dmg,100)) + dot + UTIL_HP * util + prem,
 *   E = 1 - EASE_K * (aim + tim + exp),  U = P * E * cond   ("usable value", HP-eq per use). Band by U:
 *   common < 30 <= uncommon < 55 <= rare < 85 <= super. Rules (checked by baltest): start ammo <= BAND.ammoMax,
 *   crateW = BAND.w, crate-only (ammo 0) or 1 per team for rare / super, basic (unlimited) rows are the three PoC staples.
 * API: SS.balance = { ROWS, TOOLS, BAND, ECON, row(k), value(row), band_of(U), crate_pick(u), tool_pick(u) }. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const B = SS.balance = {};
  B.GROUP_K = 0.25; B.UTIL_HP = 8; B.EASE_K = 0.07;
  /* bands: U range, max starting ammo, crate weight. 'basic' = unlimited staple (not in crates) */
  B.BAND = {
    basic:    { lo: -1, hi: 1e9, ammoMax: Infinity, w: 0 },
    common:   { lo: 0, hi: 30, ammoMax: 5, w: 10 },
    uncommon: { lo: 30, hi: 55, ammoMax: 3, w: 6 },
    rare:     { lo: 55, hi: 85, ammoMax: 1, w: 4 },
    super:    { lo: 85, hi: 1e9, ammoMax: 1, w: 3 }
  };
  B.ORDER = ['common', 'uncommon', 'rare', 'super'];
  /* crate economy (weapons.js WP.CRATE reads these). P84: crateRound = the default chance of ONE crate in a round (all crate levels at 5, C.CRATES: P_LEVEL x level);
   * healthShare = the health share of a Crate Overload's mix; the per-turn chances (0.3, tool 0.12 / 0.22 / 0.4) are gone */
  B.ECON = { crateRound: 0.2, healthShare: 0.45, healthHP: 30 };

  const R = (k, ammo, dmg, dmgN, dot, knock, terr, range, hits, aim, tim, exp, util, cond, prem, counter) => ({ k, ammo, dmg, dmgN, dot, knock, terr, range, hits, aim, tim, exp, util, cond, prem, counter });
  B.ROWS = [
    //  key           ammo  dmg dmgN dot knock terr  range hits a t e  u  cond prem counter
    R('bazooka',      Infinity, 50, 82, 0, 5, 22, 160, 1, 2, 0, 1, 0, 1, 0, 'cover, distance, wind'),
    R('grenade',      Infinity, 51, 105, 0, 7, 47, 160, 1, 2, 1, 1, 0, 1, 0, 'cover, distance'),
    R('cluster',      3, 25, 40, 0, 3, 48, 160, 6, 2, 1, 1, 0, 1, 0, 'cover; bomblets scatter'),
    R('shotgun',      Infinity, 50, 50, 0, 11, 0, 50, 2, 1, 0, 1, 0, 1, 0, 'cover, range'),
    R('bat',          2, 30, 90, 0, 15, 0, 2.4, 1, 1, 0, 3, 1, 1, 0, 'do not stand beside the enemy'),
    R('homing',       1, 49, 84, 0, 2, 19, 167, 1, 0, 0, 1, 0, 1, 0, 'cover; the missile can be out-run by a wall'),
    R('dynamite',     2, 41, 123, 0, 39, 212, 0, 1, 0, 2, 3, 1, 1, 0, 'distance, a tunnel; the thrower must flee'),
    R('banana',       1, 82, 170, 0, 11, 308, 160, 6, 2, 1, 2, 0, 1, 0, 'cover, distance'),
    R('airstrike',    1, 59, 176, 0, 5, 95, 999, 5, 0, 1, 0, 0, 0.9, 0, 'roofs / tunnels, spreading the team'),
    R('holy',         0, 75, 228, 0, 42, 705, 142, 1, 3, 1, 1, 0, 1, 0, 'distance, cover, the sea behind you'),
    R('sheep',        2, 49, 95, 0, 17, 133, 0, 1, 1, 2, 1, 0, 1, 0, 'walls, water; the sheep takes 10 s'),
    R('boulder',      1, 60, 155, 0, 0, 0, 126, 1, 3, 1, 1, 0, 1, 0, 'step aside, roofs'),
    R('blackhole',    0, 65, 118, 0, 4, 135, 126, 1, 2, 1, 1, 2, 1, 0, 'stay out of the 10 m pull'),
    R('tesla',        1, 88, 87, 0, 2, 1, 999, 1, 0, 0, 0, 0, 0.5, 0, 'tinfoil hat, spread out; thunderstorms only'),
    R('napalm',       1, 46, 125, 0, 0, 0, 999, 9, 0, 0, 0, 0, 1, 0, 'water, leave the fire'),
    R('moai',         0, 118, 114, 0, 2, 10, 999, 3, 0, 0, 0, 0, 1, 0, 'roofs, spreading out'),
    R('mine',         2, 30, 91, 0, 36, 34, 0, 1, 1, 1, 2, 0, 0.5, 0, 'bellows or a shot reveals it, walk around'),
    R('drill',        2, 15, 45, 0, 3, 0, 0, 3, 1, 1, 2, 3, 1, 0, 'tunnels are public'),
    R('rope',         Infinity, 0, 0, 0, 0, 0, 40, 0, 1, 1, 0, 0, 1, 0, 'cut by a blast'),
    R('parachute',    3, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 1, 0, 'a blast knocks the user off'),
    R('zipline',      2, 0, 0, 0, 0, 0, 40, 0, 1, 0, 1, 3, 1, 0, 'a blast cuts the line'),
    R('teleport',     2, 0, 0, 0, 0, 0, 999, 0, 1, 0, 1, 4, 1, 0, 'none (positional)'),
    R('girder',       3, 0, 0, 0, 0, 0, 28, 0, 1, 0, 1, 3, 1, 0, 'blasts pit the plate'),
    R('bellows',      3, 0, 0, 0, 10, 0, 22, 0, 1, 0, 2, 2, 1, 0, 'stay out of the cone'),
    R('sniper',       3, 45, 45, 0, 0, 0, 120, 1, 2, 1, 2, 0, 1, 0, 'cover; the shot tells where the sniper is'),
    R('foam',         3, 0, 0, 0, 0, -22, 126, 0, 1, 0, 0, 2, 1, 0, 'blast it'),
    R('magnet',       2, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 2, 1, 0, 'shoot the magnet'),
    R('spring',       2, 40, 120, 0, 39, 0, 0, 1, 1, 1, 2, 0, 0.5, 0, 'bellows reveal it; the fall damage needs a drop'),
    R('scrambler',    2, 0, 0, 0, 0, 0, 10, 0, 0, 1, 1, 1, 1, 0, 'none'),
    R('dog',          2, 35, 70, 0, 8, 56, 40, 1, 0, 1, 1, 0, 0.8, 0, 'walls, a shot kills it'),
    R('punch',        3, 30, 30, 0, 18, 0, 1.8, 1, 1, 0, 3, 1, 1, 0, 'do not stand beside the enemy'),
    R('sentry',       1, 96, 96, 0, 0, 0, 30, 1, 1, 2, 2, 1, 0.5, 0, 'leave the beam, a blast knocks it over'),
    R('claymore',     2, 48, 109, 0, 1, 4, 9, 1, 1, 2, 1, 0, 0.5, 0, 'the laser is visible: walk around'),
    R('ffield',       1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 6, 1, 0, 'a second shell after the first'),
    R('gravgun',      5, 0, 0, 0, 0, 0, 24, 0, 2, 1, 1, 2, 1, 0, 'none'),
    R('flamethrower', 3, 32, 32, 0, 0, 0, 11, 1, 1, 0, 3, 0, 1, 0, 'distance'),
    R('acid',         1, 49, 105, 0, 2, 10, 82, 1, 3, 0, 1, 0, 1, 0, 'leave the pool'),
    R('gas',          2, 1, 1, 20, 0, 0, 82, 1, 2, 1, 1, 0, 1, 0, 'a health crate cures it'),
    R('mortar',       3, 20, 79, 0, 2, 38, 82, 8, 2, 0, 1, 0, 1, 0, 'cover (roof), distance'),
    R('minigun',      0, 112, 115, 0, 0, 0, 52, 76, 1, 0, 2, 0, 1, 0, 'cover; walls stop the rounds'),
    R('handgun',      4, 24, 26, 0, 7, 0, 18, 2, 1, 0, 2, 0, 1, 0, 'distance'),
    R('boomerang',    3, 26, 26, 0, 8, 0, 20, 1, 2, 1, 1, 0, 1, 0, 'cover'),
    R('raven',        1, 27, 78, 0, 3, 19, 999, 5, 1, 1, 1, 0, 1, 25, 'a shot downs the raven; roofs'),
    R('skip',         Infinity, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, '-')
  ];
  /* tool-crate deliveries (skills.js): w = weight in the tool draw, value = HP-eq of what it grants for the turns it lasts */
  B.TOOLS = [
    { k: 'freerot',  w: 14, value: 20, note: 'turn the view freely for 2 turns (the rotation lock exists because free rotation passes obstacles)' },
    { k: 'laser',    w: 20, value: 12, note: 'laser sight for 4 turns: aim help for bullet weapons' },
    { k: 'fastwalk', w: 18, value: 14, note: 'x1.6 walk speed for 3 turns' },
    { k: 'lowgrav',  w: 18, value: 14, note: 'x0.45 gravity for 3 turns' },
    { k: 'tinfoil',  w: 15, value: 16, note: 'lightning does 10 % for the rest of the game' },
    { k: 'overload', w: 7,  value: 120, note: 'ten crates fall over the whole map' }
  ];

  /* every change this phase made to the game data, with the measurement that justified it (docs/BALANCE.md prints them) */
  B.CHANGES = [
    { what: 'Minigun: DMG 4 -> 2 per round, burst 2.2 -> 2.0 s, start ammo 2 -> 0 (crate-only, rare band)',
      why: 'measured 244 HP per burst on one still foe (264 on three) = 2.4 full-HP worms for zero aim; CPU matches (new AI, 240 games): 178 HP per use, 290 kills in 345 uses. Now 112 per burst (one full-HP worm if every round lands).' },
    { what: 'Moai Drop: start ammo 1 -> 0 (crate-only, super band)', why: 'measured 118 HP on the target with no aim at all (a kill on any worm up to 100 HP) and no counterplay in the shooter turn; CPU matches: 96 HP per use, 463 kills in 587 uses (the most lethal weapon per use).' },
    { what: 'Homing: start ammo 2 -> 1', why: 'with the improved CPU aim it is the top killer of the limited weapons: 47 HP per use, 719 uses, 307 kills (0.43 kills per use against the bazooka\'s 0.19 and the holy grenade\'s 0.36) for an aim rating of 1; usable value 50 puts it at the top of the uncommon band, so one per team.' },
    { what: 'Black Hole: start ammo 1 -> 0; Boulder 2 -> 1; Acid Bomb 2 -> 1; Mail Raven 2 -> 1', why: 'rare band (usable value 55-85): at most 1 per team; black hole is a listed super weapon. Boulder does 60 HP (155 on a group) with no terrain cost; acid 83 HP (173 on a group).' },
    { what: 'Claymore: pellet damage 8 -> 5', why: 'measured 300 HP point-blank (2 m); now 195 point-blank and 48 at the 3 m laser trigger (about 77 before): a trap that needs a victim should not be a guaranteed kill.' },
    { what: 'Gas Bomb: poison per round 1-3 -> 2-4 HP', why: 'measured 14 HP in 6 rounds per infected worm (usable value 15, the weakest damage weapon). Now 20.' },
    { what: 'Supply crates: weapon drawn by rarity band (common 10 / uncommon 6 / rare 4 / super 3) instead of uniform over 38 weapons', why: 'uniform: a minigun, a holy grenade and a parachute were equally likely (2.6 % each). Now the super band is 2 % of weapon crates, rare 8 %, uncommon 18 %, common 71 %.' }
    ,{ what: 'P38 R3: Acid Bomb row 83 / 173 -> 49 / 105 HP (re-measured after the R1 dedupe: balanceharness shots --only acid,sentry), Sentry 48 / 48 -> 96 / 96 HP with condition 0.4 -> 0.5; crate overload drawn with the weighted draw; tool crates have their own cap', why: 'the table was stale (acid: one pool hit per worm per 0.5 s now; sentry: R2 made the rounds honour 4 HP each, 24 rounds per use). Acid falls from the rare to the uncommon band (usable value 45), the sentry from common to uncommon; a sentry hit no longer ends the active worm\'s turn in the play phase (it denied whole turns). The overload used to draw 10 distinct entries uniformly from all weapons and tools (P(super) 43 % per overload): now health 45 %, then 25 % tools, the rest B.crate_pick. Crate caps: 24 weapon + health crates, 10 tool crates; a full class evicts its oldest landed crate (the cap used to stop supply for good once unreachable crates piled up). Re-measure the table with: node tools/dev/balanceharness.cjs shots --only acid,sentry (then node tools/dev/balance.cjs); tools/dev/gen/p38r3test.cjs re-measures acid and sentry within tolerance.' }
  ];
  B.CHANGES.push(
    { what: 'P38 R5 B1: Holy Grenade start ammo 1 -> 0 (crate-only, rare band), aim rating 2 -> 3',
      why: 'master matches (60, 2-4 teams, both map sizes): the holy grenade was in every start kit and delivered 23 % of all damage (178 uses, 64 HP / use, 0.31 kills / use, 98 % of the stock used) although its crate band is rare. The same 60 matches with the final CPU, holy in the kit vs crate-only: 27.9 -> 31.6 turns (2 teams 18.8 -> 22.6, 3 teams 28.0 -> 33.9, 4 teams 37.0 -> 38.4), sudden death reached in 54 instead of 49 of 60 matches. Aim 3: the noisy-aim hit share is 0.17 / 0.50 / 0.83 (easy / normal / hard), the lowest of the ballistic weapons. Usable value 82 -> 74.' },
    { what: 'P38 R5 B2: Air Strike re-rated to the rare band (timing 0 -> 1, condition 1 -> 0.9; ammo stays 1, crate weight 3 -> 4)',
      why: 'its usable value was 88 (super band) only because of the group bonus (59 HP on one foe, 176 on three) and it sat in every kit. The plane needs open sky (not in caves, not under a roof: condition 0.9) and its 4 s flight lets a foe walk out (timing 1): U 74. Removing it as well as the holy grenade made matches 7-20 turns longer in the review (4 teams 48 turns, always sudden death), so it stays in the kit once per team. CPU: 177 uses, 51 HP / use before; 180 uses, 48 HP / use after.' },
    { what: 'P38 R5 B3: difficulty ratings: boulder aim 2 -> 3, sniper aim 3 -> 2, homing aim 1 -> 0; banana measured on the 30 m shot (dmg 43 -> 82, exposure 1 -> 2)',
      why: 'the noisy-aim measurement (hit share easy / normal / hard): boulder 0.33 / 0.67 / 1 (rolling rock, hard to place), sniper 0.67 / 0.83 / 1 (a hitscan with a laser: easier than a lob), homing 1 / 1 / 1 (it steers: no aim at all). Boulder U 60 -> 54 (uncommon, weight 6), sniper 26 -> 29 (common), homing 50 -> 54 (uncommon). The banana row used the 12 m one-foe shot (43 HP: the bomblets bounce past a single foe at that range); the 30 m shot gives 82 HP (far 86, group 170) and it is the biggest self-damager (4.9 self HP per use, 11 own-team kills in 146 uses): exposure 2. U 54 -> 68: rare band, crate weight 6 -> 4; ammo stays 1. After round 5: 3.5 self HP per use, 5 own kills in 162 uses.' },
    { what: 'P38 R5 B6: sudden death one round earlier with 4 teams (sdRound 7 -> 6 for 3 worms per team)',
      why: 'with the holy grenade out of the kits the 4-team CPU matches ran 60 turns (master: 48), 32 of them after sudden death; a round is 4 turns. One round earlier: 38.7 turns over 40 matches, 39 of 40 reach sudden death, the winner seats 11 / 8 / 4 / 14. 2 and 3 teams unchanged (22.6 / 33.9 turns).' });
  /* the CPU rules of round 5 (docs/BALANCE.md section 6b) */
  B.CPU = [
    'The CPU used 19 of the 44 weapons on master; it uses 27-29 now (`aic.js` + fixes). Dynamite, mine, spring trap: a charge 1.5 m in front of the worm when a foe is within 5.5 m (mine 2 m of where it lands), scored like a shot with the worm walking 9 m away during the fuse (never lit without a 9 m walkable way out). Sheep: a foe 6-26 m away on walkable ground with no teammate on the path, set off from the retreat window when it is within 2 m of an enemy (43 uses, 45 HP / use, 0.4 self HP). Napalm: 50 HP per foe within 4.5 m, open sky, no teammate within 8 m of the aim point (165 uses, 36 HP / use). Bat: swing reach 1.8 m, + the foe\'s HP when the knock (14 m) ends in water. Torch: a foe within 3.4 m behind rock. Gas: a fallback when no shot is worth more. Teleport: a fallback (value 3) to a free spot 8-16 m from the foe with a clear line when no shot exists even after walking; and out of the rising sea when no walk or rope reaches high ground. Girder: a flat plate across a gap (water or a drop over 3 m, up to 4.9 m wide) toward the foe. Black hole: now in the plan (scored as the burst at its core, x 1.3).',
    'Approach: when 0.75 x the expected value of a close tool (bat, knockout punch, spring, dynamite, mine, flamethrower, handgun) beats the best shot by 8 (and is >= 20), the CPU walks up to the tool\'s stop distance (<= 28 m, once per turn); on 35 % of the turns (a hash of the turn and the worm) it is in a "close combat" mood and needs only -8.',
    'Crates by band: a weapon crate is worth 10 + U / 2 HP-eq (common ~20, uncommon ~32, rare ~45, super ~60), and the walk to it grows by 0.6 m per HP-eq above 22 (a super crate within ~35 m, rare ~29 m). A rare / super weapon crate (worth >= 37) is fetched at the start of the turn before shooting (it turns the view to it while rotation is free): picked up 16 weapon crates in 60 matches instead of 7, among them banana 2, boulder 3, moai, holy, black hole. Most missed crates lie 10-20 m above the worm (plateaus: a rope fetch is not implemented). The retreat-window fetch is limited by the 2 m/s walk and the remaining window.',
    'Fixes found on the way (all measured in the matches): the retreat after a shot chose "away from the foe" every step from the CURRENT facing, and walking flips the facing, so the worm shuffled on the spot (a dynamite 1.5 m ahead hit its thrower for 49 HP) and a flamethrower / minigun burst was sprayed backwards when the worm turned mid-burst (0 of 21 rounds hit at 12 m): the direction is now chosen once per turn, only when something of its own is about to go off near it (fused / buried charge, fire, gas, acid) or the target is within 14 m, never during a burst; the CPU walk to a foe stopped only on a timer (it walked through the foe and swung the bat backwards): it stops 1.3 m from it; a CPU worm walked into its own team\'s claymore laser (700 HP of damage in one match): steps into a laser are unsafe; the shotgun line ignored teammates standing in it; PlaneBody.worm is an id since R7 but rope knocking still used it as an object (a CPU swinging into a worm crashed the sim: 2 of 60 matches).'
  ];
  /* findings that did not lead to a data change (docs/BALANCE.md prints them) */
  B.NOTES = [
    'First-turn advantage: over 240 CPU matches (final data, new AI) the first mover won 38 of 77 two-team games (fair 38.5), 23 of 78 three-team (26) and 17 of 77 four-team (19.3); with the old data 42 / 78, 35 / 80, 19 / 74: no consistent effect, so no compensation was added.',
    'Sudden death (round 6 + max(0, 4 - worms) + 1 for two teams, in rounds, not turns): 86 % of the CPU matches reach it (about round 8-9); the average match is 25 / 32 / 44 turns for 2 / 3 / 4 teams (it was 21 / 22 / 32 with the old data: the minigun, moai and homing ended games early). Not changed (the CPU kills slowly; humans finish sooner); if matches with 3-4 teams feel rushed, add +1 round per extra team in game.js setup.',
    'Health crates: 0.3 x 0.45 = 0.135 per turn x 30 HP = 4 HP per turn on a 300-1200 HP field (about 11-16 % of the HP of a match): a minor heal, the crate drops on the active section so each team is first to it equally often. Unchanged.',
    'CPU gaps for A3 (first 90 matches with the pre-A3 CPU; the new CPU still collects 4 of 1150 weapon crates): it never walks to a supply crate (3 of 367 weapon and 0 of 297 health crates picked up in the first 90 matches); it fires the homing missile into its own team (pre-A3 only: 0.6 HP per use now); the sentry gun does 2 HP per use; the force field is cast 431 times with 0.5 HP of effect (89 % zero-damage turns), the gravity gun 162 times; without a turn limit (turnTime 0) 8 % of the 3-4 team matches stalled for good (7 of 89 in the first run); it never uses the dynamite, sheep, mine, boulder, sniper, bat, drill or black hole.'
  ];
  B.NOTES.push(
    'P38 R5 B4: homing stays at 1 per team: 142 uses, 0.52 kills per use (the best common-access finisher), its aim rating is now 0 (it steers).',
    'P38 R5 B5: claymore and shotgun self-damage were harness artefacts, not CPU suicides: a hitscan hit is emitted before its "use" event, so it was attributed to the previous shooter\'s team (shotgun: 12 HP per use "self"), and an overkill counted its full amount (one claymore: 707 HP on one worm). The harness now caps damage by the victim\'s HP and attributes instant weapons to the active team: shotgun 0.7 self HP per use. The remaining claymore risk was real: a CPU worm walked into its own team\'s laser (the CPU now treats a laser as unsafe ground).',
    'P38 R5 B7: the "tool crates high = +16 turns" of the review is not reproduced. 3-team matches, 20 each, final CPU: tool crates normal 32.5 turns, high 33.3. With every delivery forced to one tool (high): none 37.1, free rotation 35.1, laser 35.7, fast walk 35.6, low gravity 35.8, tinfoil 35.8, crate overload 35.9 turns (19 matches each): no tool lengthens a match; the 16 turns were seed noise of 3-team matches (+-5 turns per 20) on top of the then unfetched crates.',
    'P38 R5 B6 (kit scaling): the start kit is not scaled with the team count (half / one-per-item kits changed nothing measurable in the review); the match length is steered by the sudden death round instead (see section 6).',
    'Harness: `balanceharness.cjs matches --set cpu|tchigh|tcoff|noholy|holy1 [--teams 3] [--reps 2]` (60 matches: 2 teams / 3 / 4 x 5 biomes x 2 map sizes x 2 seeds), env BAL_TOOL=<tool> forces one tool delivery, `tools/dev/balcmp.cjs before.json after.json` prints the comparison. The scripted shots had a foe ON the shooter for the 6 m weapons in the spread scenario (d1 - 6 = 0 m: flamethrower and handgun measured 0 damage and 55-70 self HP): the spread foes now start at d1; baltest re-measures four rows (handgun, flamethrower, shotgun, grenade) and fails when the committed shots have gone stale.'
  );
  B.row = k => { for (const r of B.ROWS) if (r.k === k) return r; return null; };
  B.power = r => { const d1 = M.min(r.dmg, 100); return d1 + B.GROUP_K * M.max(0, M.min(r.dmgN, 300) - d1) + r.dot + B.UTIL_HP * r.util + r.prem; };
  B.ease = r => 1 - B.EASE_K * (r.aim + r.tim + r.exp);
  B.value = r => B.power(r) * B.ease(r) * r.cond;
  B.band_of = u => { for (let i = B.ORDER.length - 1; i >= 0; i--) if (u >= B.BAND[B.ORDER[i]].lo) return B.ORDER[i]; return 'common'; };
  B.band = r => (r.ammo === Infinity ? 'basic' : B.band_of(B.value(r)));
  B.weight = r => { const k = C.ARSENAL && C.ARSENAL[r.k]; return k && k.crate ? B.BAND[B.band(r)].w : 0; };

  /* the weighted weapon-crate draw: u in [0,1) -> key of C.CRATE_POOL (cumulative table built once) */
  const cumK = [], cumW = []; let tot = 0;
  function build() {
    cumK.length = 0; cumW.length = 0; tot = 0;
    for (const k of C.CRATE_POOL) { const r = B.row(k), w = r ? B.weight(r) : 6; if (w > 0) { tot += w; cumK.push(k); cumW.push(tot); } }
  }
  B.crate_pick = function (u) {
    const x = u * tot; for (let i = 0; i < cumW.length; i++) if (x < cumW[i]) return cumK[i];
    return cumK[cumK.length - 1];
  };
  B.crate_weights = function () { const o = {}; let p = 0; for (let i = 0; i < cumK.length; i++) { o[cumK[i]] = (cumW[i] - p) / tot; p = cumW[i]; } return o; };
  build();                                              // (the cumulative table is built once, at load: C.CRATE_POOL and the rows are static)
  /* (P38 R7: no apply(): skills.js KS.POOL and weapons.js CR hold these numbers themselves; tools/dev/gen/r7test.cjs checks that they equal B.TOOLS / B.ECON) */
})(window.SS = window.SS || {});
