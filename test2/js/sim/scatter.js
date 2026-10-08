/* sim/scatter.js — props scattered over the island (portable, deterministic; no DOM / Three.js).
 *
 * Every prop is a rigid body (sim/bodies.js) with a little extra state:
 *   crate    25 kg wooden box: shatters above 70 kPa, burns (fireball, lava, burning neighbours) and burns out after 8 s.
 *   barrel   40 kg fuel drum (floats): above 150 kPa it detonates after a 0.05-0.15 s chain delay, or after 3-6 s of
 *            burning; W 1.5 plus a ring of burning oil (OIL_R m, OIL_T s) that burns worms and lights other props.
 *   mine     2 kg (sinks): a worm within 1.5 m starts a 3 s fuse; a blast above 100 kPa or lava sets it off; a mine
 *            under water is disarmed for good.
 *   boulder  500 kg rock: just a body (rolls / falls when its support is blasted away, hits worms).
 * Detonations happen at the prop's position at that moment (a barrel thrown by a blast explodes where it lands).
 * Chains therefore run through the blast hook: explosion -> SC.blast -> det time -> SC.step -> explosion ...
 *
 * C layout: Body gets { u8 prop; f32 burn, burnT, det; u8 disarmed, armed; }; S.flames = [{x, y, z, r, t1}].
 * API: populate(S, taken), add(S, kind, pos, yaw), step(S, dt), blast(S, c, W), ignite(S, b), settled(S), count(S).
 */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT, P = C.PROPS;
  const SC = SS.scatter = {};
  const KINDS = ['crate', 'barrel', 'mine', 'boulder', 'girder'];
  const rand = S => M.rng_next(S.rng);
  const lc = { sub: 0, heat: 0, surf: 0 };
  // fire damage does not stack: one burning source per worm per step
  function scorch(S, w, dt, why) { const k = S.tick; if (w.fireStep === k) return; w.fireStep = k; w.fireT = S.time; SS.sim.burn(S, w, C.FIRE_DPS, dt, why); }

  /* ---------- shapes (shell spheres x, y, z, r in body space) ---------- */
  function ring(pts, n, rad, y, r, a0) { for (let i = 0; i < n; i++) { const a = a0 + i * 2 * Math.PI / n; pts.push(M.cos(a) * rad, y, M.sin(a) * rad, r); } }
  const ICO = (() => {
    const f = (1 + Math.sqrt(5)) / 2, v = [[0, 1, f], [0, -1, f], [0, 1, -f], [0, -1, -f], [1, f, 0], [-1, f, 0], [1, -f, 0], [-1, -f, 0], [f, 0, 1], [-f, 0, 1], [f, 0, -1], [-f, 0, -1]];
    return v.map(p => { const l = M.len3(p[0], p[1], p[2]); return [p[0] / l, p[1] / l, p[2] / l]; });
  })();
  /* boulder shell: 12 jittered icosahedron spheres + a core; the same hash drives the render mesh (bodyView) */
  SC.boulder_pts = function (id) {
    const pts = [];
    for (let i = 0; i < 12; i++) { const d = ICO[i], k = 0.24 + 0.07 * M.hash3(id, i, 31); pts.push(d[0] * k, d[1] * k * 0.8, d[2] * k, 0.17); }
    pts.push(0, 0, 0, 0.28);
    return pts;
  };

  SC.add = function (S, kind, pos, yaw) {
    const B = SS.bodies;
    let b;
    if (kind === 'crate') {
      const h = P.CRATE.HALF;
      b = B.add_box(S, pos, { x: h, y: h, z: h }, P.CRATE.KG, MAT.SOIL);
      b.mu = 0.55;
    } else if (kind === 'barrel') {
      const R = P.BARREL.R, H = P.BARREL.H, m = P.BARREL.KG, rs = 0.11, pts = [];
      ring(pts, 8, R - rs, H / 2 - rs, rs, 0); ring(pts, 8, R - rs, -(H / 2 - rs), rs, 0); ring(pts, 8, R - rs * 0.8, 0, rs * 0.8, Math.PI / 8);
      b = B.add_shape(S, 'prop', pos, m, { x: m * (3 * R * R + H * H) / 12, y: 0.5 * m * R * R, z: m * (3 * R * R + H * H) / 12 }, pts, MAT.ROCK);
      b.mu = 0.45; b.vol = Math.PI * R * R * H; b.e = 0.3;
    } else if (kind === 'mine') {
      const R = P.MINE.R, m = P.MINE.KG, pts = [];
      ring(pts, 6, R - 0.065, 0, 0.065, 0); pts.push(0, 0, 0, 0.07);
      b = B.add_shape(S, 'prop', pos, m, { x: 0.25 * m * R * R, y: 0.5 * m * R * R, z: 0.25 * m * R * R }, pts, MAT.ROCK);
      b.mu = 0.55; b.vol = m / 1700; b.e = 0.35;               // steel casing + charge: sinks; bounces when thrown (user 2026-10-08)
    } else if (kind === 'car') {
      // P24.10: a car = a lower hull (2 x 7 spheres) + a cabin row (2 x 3, set back): 1.1 t
      const K = P.CAR, m = K.KG, rs = 0.36, pts = [];
      for (let i = 0; i < 7; i++) for (const z of [-0.42, 0.42]) pts.push(-1.6 + i * 0.533, -0.3, z, rs);
      for (let i = 0; i < 3; i++) for (const z of [-0.35, 0.35]) pts.push(-0.85 + i * 0.5, 0.32, z, 0.32);
      b = B.add_shape(S, 'prop', pos, m, { x: m * (K.W * K.W + K.H * K.H) / 12, y: m * (K.L * K.L + K.W * K.W) / 12, z: m * (K.L * K.L + K.H * K.H) / 12 }, pts, MAT.ROCK);
      b.mu = 0.6; b.vol = m / 450; b.e = 0.05; b.metal = true; b.paint = (Math.imul(S.bodyId, 2654435761) >>> 0) % 6;
    } else if (P.JUNK[kind]) {
      const [w, h, d, m] = P.JUNK[kind], r = Math.min(w, d) / 2 - 0.02, ny = Math.max(2, Math.round(h / (r * 1.5))), pts = [];
      for (let j = 0; j < ny; j++) for (const x of [-(w / 2 - r), w / 2 - r]) for (const z of [-(d / 2 - r), d / 2 - r]) pts.push(x, -h / 2 + r + j * (h - 2 * r) / (ny - 1), z, r);
      b = B.add_shape(S, 'prop', pos, m, { x: m * (h * h + d * d) / 12, y: m * (w * w + d * d) / 12, z: m * (w * w + h * h) / 12 }, pts, MAT.ROCK);
      b.mu = 0.55; b.vol = m / 300; b.e = 0.1; b.metal = true;
    } else if (P.STONE[kind]) {
      const [r0, h, m] = P.STONE[kind], n = Math.round(h / 0.3), pts = [];
      for (let j = 0; j <= n; j++) { const t = j / n, r = kind === 'obelisk' ? r0 * (1 - 0.55 * t) : r0; pts.push(0, -h / 2 + r + t * (h - 2 * r), 0, r); }
      b = B.add_shape(S, 'prop', pos, m, { x: m * h * h / 12, y: 0.5 * m * r0 * r0, z: m * h * h / 12 }, pts, MAT.ROCK);
      b.mu = 0.7; b.vol = m / 2600; b.e = 0.05;
    } else if (kind === 'girder') {
      // M: a loose steel I-beam (along body x, web vertical): spheres of the section's half depth every 0.25 m
      const G = P.GIRDER, m = G.KG, pts = [], k = Math.round(G.L / 0.25), r = G.H / 2;
      for (let i = 0; i <= k; i++) pts.push(-G.L / 2 + G.L * i / k, 0, 0, r);
      b = B.add_shape(S, 'prop', pos, m, { x: m * (G.H * G.H + G.B * G.B) / 12, y: m * G.L * G.L / 12, z: m * G.L * G.L / 12 }, pts, MAT.ROCK);
      b.mu = 0.5; b.vol = m / 7850; b.e = 0.15;
    } else {
      const m = P.BOULDER.KG, pts = SC.boulder_pts(S.bodyId + 1);
      b = B.add_shape(S, 'prop', pos, m, { x: 0.4 * m * 0.18, y: 0.4 * m * 0.18, z: 0.4 * m * 0.18 }, pts, MAT.ROCK);
      b.vol = m / 2600; b.e = 0.1;
      b.shapeId = b.id;
    }
    b.prop = kind; b.wreck = false; b.burn = -1; b.burnT = 0; b.det = -1; b.armed = false; b.disarmed = false;
    b.team = -1; b.planted = -99; b.revealed = false;          // traps: owner team (-1 = the map's), planting time, detected
    b.q = M.q_axis_angle(0, 1, 0, yaw || 0);
    return b;
  };
  const LIFT = { crate: P.CRATE.HALF, barrel: P.BARREL.H / 2, mine: 0.07, boulder: 0.36, girder: P.GIRDER.H / 2, car: 0.7,
    fridge: P.JUNK.fridge[1] / 2, vending: P.JUNK.vending[1] / 2, phonebooth: P.JUNK.phonebooth[1] / 2, column: P.STONE.column[1] / 2, obelisk: P.STONE.obelisk[1] / 2 };

  /* place the biome's props on free dry spots (>= 4 m from worms and each other), then let them settle */
  SC.populate = function (S, taken) {
    S.flames = [];
    const cnt = P.COUNT[S.biome] || P.COUNT.temperate, ev0 = S.events.length;
    for (let k = 0; k < KINDS.length; k++) for (let n = 0; n < cnt[k]; n++) {
      if (k >= cnt.length) continue;
      const kind = KINDS[k], spot = SS.sim.find_spot(S, kind === 'girder' ? 5 : 4, taken, { slope: kind === 'boulder' ? 0.4 : 0.2, clear: kind === 'girder' ? 3 : 2 });
      if (!spot) continue;
      taken.push(spot);
      SC.add(S, kind, { x: spot.x, y: spot.y + LIFT[kind] + 0.03, z: spot.z }, rand(S) * 2 * Math.PI);
    }
    // P24.10: the PoC's extra props, placed from their own stream (the map stream S.rng stays as before)
    const ex = P.EXTRA[S.biome]; if (ex && !SS.world.under) {
      const keep = S.rng; S.rng = M.rng_make(((S.settings.seed | 0) * 40503 + 17) >>> 0 || 1);
      for (const kind in ex) for (let n = 0; n < ex[kind]; n++) {
        const big = kind === 'car' || P.STONE[kind], spot = SS.sim.find_spot(S, big ? 5 : 4, taken, { slope: big ? 0.25 : 0.2, clear: P.STONE[kind] ? 4 : 2.6 });
        if (!spot) continue;
        taken.push(spot); SC.add(S, kind, { x: spot.x, y: spot.y + LIFT[kind] + 0.03, z: spot.z }, rand(S) * 2 * Math.PI);
      }
      S.rng = keep;
    }
    // settle at load: bodies only (no fuses, no worm hits), until everything sleeps; then drop what rolled next to a
    // worm or into water / lava
    S.settling = true;
    for (let t = 0; t < P.SETTLE / C.STEP && !SS.bodies.settled(S); t++) SS.bodies.step(S, C.STEP);
    S.settling = false;
    const W = SS.world;
    for (let i = S.bodies.length - 1; i >= 0; i--) {
      const b = S.bodies[i];
      if (!b.prop) continue;
      const nearWorm = S.worms.some(w => M.len2(w.pos.x - b.pos.x, w.pos.z - b.pos.z) < 2.5);
      const wet = b.pos.y - b.rb < (SS.sim.surface_at ? SS.sim.surface_at(S, b.pos.x, b.pos.z) : W.SEA) + 0.2;
      const hot = SS.sim.near_lava ? SS.sim.near_lava(S, b.pos.x, b.pos.z) : false;
      // dry worlds: everything starts in the play area (a prop that rolled down a slip face past SPAWN_R is dropped)
      const out = W.dry && SS.sim.arena_r && SS.sim.arena_r(b.pos.x, b.pos.z) > C.DRY.SPAWN_R;
      if (nearWorm || wet || hot || out) { S.bodies.splice(i, 1); continue; }
      b.vel.x = b.vel.y = b.vel.z = 0; b.w.x = b.w.y = b.w.z = 0; b.asleep = true; b.age = 0;
    }
    S.events.length = ev0;
  };

  /* ---------- state changes ---------- */
  SC.ignite = function (S, b) {
    if (!b.prop || b.burn >= 0 || (b.prop !== 'crate' && b.prop !== 'barrel' && !(b.prop === 'car' && !b.wreck))) return;
    if (SS.sim.surface_at && b.pos.y < SS.sim.surface_at(S, b.pos.x, b.pos.z)) return;       // wet
    b.burn = b.prop === 'crate' ? P.CRATE.BURN : b.prop === 'car' ? P.CAR.BURN : P.BARREL.BURN0 + rand(S) * (P.BARREL.BURN1 - P.BARREL.BURN0);
    b.burnT = 0;
    SS.sim.emit(S, 'propfire', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, kind: b.prop });
    if (b.prop === 'barrel') SS.sim.log(S, 'A fuel barrel catches fire!', 0xffb060);
  };
  function arm(S, b, delay) { if (b.det < 0 || S.time + delay < b.det) b.det = S.time + delay; }
  function breakProp(S, b, why) {
    SS.bodies.remove(S, b);
    SS.sim.emit(S, 'propbreak', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, kind: b.prop, why });
  }
  function detonate(S, b) {
    const W = SS.world, c = { x: b.pos.x, y: b.pos.y, z: b.pos.z };
    if (b.prop === 'car') {                                   // PoC: R54 dmg 44, burning fuel around, a charred wreck stays
      b.wreck = true; b.det = -1; b.burn = -1; b.armed = false;
      SS.sim.explode(S, c, { W: P.CAR.W_BLAST, dmg: P.CAR.DMG, name: 'an exploding car' }, null);
      const top = W.top_at(c.x, c.z);
      for (let k = 0; k < P.CAR.FIRES; k++) { const f = { x: c.x + (rand(S) - 0.5) * 3, y: top, z: c.z + (rand(S) - 0.5) * 1.5, r: 1.1, t1: S.time + 5 + rand(S) * 3 }; S.flames.push(f); SS.sim.emit(S, 'oilfire', { x: f.x, y: f.y, z: f.z, r: f.r, dur: f.t1 - S.time }); }
      SS.sim.log(S, 'A car goes up in flames!', 0xffb060);
      return;
    }
    SS.bodies.remove(S, b);
    if (b.prop === 'barrel') {
      SS.sim.explode(S, c, { W: P.BARREL.W, dmg: P.BARREL.DMG, name: 'barrel' }, null);
      const top = W.top_at(c.x, c.z), sea = SS.sim.surface_at ? SS.sim.surface_at(S, c.x, c.z) : W.SEA;
      if (top > sea && c.y - top < 3) {                       // oil only burns on land (and not after a high-air burst)
        const f = { x: c.x, y: top, z: c.z, r: P.BARREL.OIL_R, t1: S.time + P.BARREL.OIL_T };
        S.flames.push(f);
        SS.sim.emit(S, 'oilfire', { x: f.x, y: f.y, z: f.z, r: f.r, dur: P.BARREL.OIL_T });
      }
    } else SS.sim.explode(S, c, { W: P.MINE.W, dmg: P.MINE.DMG, name: 'mine' }, null);
  }

  /* blast hook (blast.js, after bodies.blast): shatter crates, set off barrels and mines, light what the fireball reaches */
  SC.blast = function (S, c, Wkg) {
    const BL = SS.blast, fire = C.BLAST.FIRE_R * M.cbrt(Wkg);
    for (let i = S.bodies.length - 1; i >= 0; i--) {
      const b = S.bodies[i];
      if (!b || !b.prop || b.prop === 'boulder') continue;
      const d = M.len3(b.pos.x - c.x, b.pos.y - c.y, b.pos.z - c.z), R = Math.max(0.2, d - b.rb * 0.5);
      if (R > 12 * M.cbrt(Wkg)) continue;
      const kPa = BL.overpressure(R, Wkg);
      if (b.prop === 'crate' && kPa > P.CRATE.BREAK_KPA) { breakProp(S, b, 'blast'); continue; }
      if (P.JUNK[b.prop] && kPa > P.JUNK.KPA) { breakProp(S, b, 'blast'); continue; }
      if (b.prop === 'car' && !b.wreck && kPa > P.CAR.KPA) arm(S, b, P.CAR.DELAY0 + rand(S) * (P.CAR.DELAY1 - P.CAR.DELAY0));
      if (b.prop === 'barrel' && kPa > P.BARREL.KPA) arm(S, b, P.BARREL.DELAY0 + rand(S) * (P.BARREL.DELAY1 - P.BARREL.DELAY0));
      // mines (user 2026-10-08): only the DIRECT blast zone, the part that digs the hole (PoC crater radius 44 px x
      // W^1/3 = 2.83 m W^1/3), sets a mine off (PoC fuse 0.15-0.4 s); beyond it the pressure wave only throws it
      // (bodies.blast: impulse + spin), it bounces and tumbles and lies where it lands, still live
      if (b.prop === 'mine') {
        const Rh = P.MINE.HOLE_R * M.cbrt(Wkg);
        if (!b.disarmed && d - b.rb < Rh) arm(S, b, P.MINE.CHAIN0 + rand(S) * (P.MINE.CHAIN1 - P.MINE.CHAIN0));
        // PoC explode() objects: v += (n + 0.4 up) x pressureFactor x 380 px/s (x 0.0643 m/px). The user wants the mine
        // to fly and bounce nicely (Worms): the full PoC speed under 9.81 (not rescaled to the PoC gravity) and a 0.6
        // up bias -> ~1.3 m high, ~6 m long just outside the hole, a hop at 1.5 R; spin: rolls along its flight + tumble
        const f = SS.blast.poc_factor(d, Rh);
        if (f > 0) {
          const l = d || 1, ux = d > 0.03 ? (b.pos.x - c.x) / l : 0, uy = d > 0.03 ? (b.pos.y - c.y) / l : 1, uz = d > 0.03 ? (b.pos.z - c.z) / l : 0, dv = f * P.MINE.THROW;
          b.asleep = false; b.sleepT = -1;                            // (as bodies.js wake)
          b.vel.x += ux * dv; b.vel.y += (uy + P.MINE.THROW_UP) * dv; b.vel.z += uz * dv;
          const h = M.len2(ux, uz) || 1, spin = dv / P.MINE.R;     // roll axis = up x the flight direction
          b.w.x += uz / h * spin + (rand(S) - 0.5) * spin * 0.6; b.w.y += (rand(S) - 0.5) * spin * 0.4; b.w.z += -ux / h * spin + (rand(S) - 0.5) * spin * 0.6;
        }
      }
      if (d < fire + b.rb) SC.ignite(S, b);
    }
  };

  SC.step = function (S, dt) {
    const W = SS.world, sim = SS.sim, tick = S.tick;
    for (let i = S.bodies.length - 1; i >= 0; i--) {
      const b = S.bodies[i];
      if (!b || !b.prop) continue;
      if (b.det >= 0 && S.time >= b.det) { detonate(S, b); continue; }
      if (b.prop === 'boulder') continue;
      // water and lava (every 10 steps, staggered)
      if ((tick + b.id) % 10 === 0) {
        const sea = sim.surface_at ? sim.surface_at(S, b.pos.x, b.pos.z) : W.SEA;
        if (b.pos.y < sea - 0.05) {
          if (b.prop === 'mine' && !b.disarmed) { b.disarmed = true; b.det = -1; b.armed = false; sim.emit(S, 'minedisarm', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z }); }
          if (b.burn >= 0) { b.burn = -1; sim.emit(S, 'steam', { x: b.pos.x, y: sea, z: b.pos.z, power: 0.5 }); }
        }
        if (sim.lava_contact) {
          sim.lava_contact(S, b.pos.x, b.pos.y - b.rb * 0.6, b.pos.z, lc);
          if (lc.sub > 0 && lc.heat > 0.05) { if (b.prop === 'mine') { if (!b.disarmed) arm(S, b, P.MINE.LAVA_T); } else SC.ignite(S, b); }
        }
      }
      // mine proximity fuse
      if (b.prop === 'mine' && !b.disarmed && !b.armed && !(b.armAt > S.time)) {     // (P2: a dropped mine arms after MINE.ARM s)
        for (const w of S.worms) {
          if (w.dead) continue;
          if (M.len3(w.pos.x - b.pos.x, w.pos.y - b.pos.y, w.pos.z - b.pos.z) < P.MINE.PROX) {
            b.armed = true; arm(S, b, P.MINE.FUSE);
            sim.emit(S, 'minearm', { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, fuse: P.MINE.FUSE });
            sim.log(S, `${w.name} trips a mine!`, 0xff8060);
            break;
          }
        }
      }
      // burning: hurts worms nearby, spreads to neighbours, ends in ash (crate) or a blast (barrel)
      if (b.burn >= 0) {
        b.burnT += dt;
        for (const w of S.worms) if (!w.dead && M.len3(w.pos.x - b.pos.x, w.pos.y - b.pos.y, w.pos.z - b.pos.z) < P.FIRE_R + b.rb) scorch(S, w, dt, 'fire');
        if (b.burnT > P.IGNITE_T && (tick + b.id) % 12 === 0) {
          for (const o of S.bodies) if (o !== b && o.prop && o.burn < 0 && M.len3(o.pos.x - b.pos.x, o.pos.y - b.pos.y, o.pos.z - b.pos.z) < P.SPREAD + b.rb + o.rb) SC.ignite(S, o);
        }
        if (b.burnT >= b.burn) { if (b.prop === 'crate') breakProp(S, b, 'burnt'); else detonate(S, b); }
      }
    }
    // burning oil rings
    for (let i = S.flames.length - 1; i >= 0; i--) {
      const f = S.flames[i];
      if (S.time > f.t1) { S.flames.splice(i, 1); continue; }
      for (const w of S.worms) {
        if (w.dead) continue;
        const dy = w.pos.y - f.y;
        if (dy > -1 && dy < 1.6 && M.len2(w.pos.x - f.x, w.pos.z - f.z) < f.r) scorch(S, w, dt, 'burning oil');
      }
      if ((tick + i) % 12 === 0) for (const o of S.bodies) if (o.prop && o.burn < 0 && M.len2(o.pos.x - f.x, o.pos.z - f.z) < f.r + o.rb && Math.abs(o.pos.y - f.y) < 1.5) SC.ignite(S, o);
    }
  };

  /* the turn waits for fuses and burning barrels (not for burning crates or oil) */
  SC.settled = S => !S.bodies.some(b => b.prop && (b.det >= 0 || (b.prop === 'barrel' && b.burn >= 0)));
  SC.count = function (S) { const n = { crate: 0, barrel: 0, mine: 0, boulder: 0, girder: 0 }; for (const b of S.bodies) if (b.prop) n[b.prop] = (n[b.prop] || 0) + 1; return n; };
})(window.SS = window.SS || {});
