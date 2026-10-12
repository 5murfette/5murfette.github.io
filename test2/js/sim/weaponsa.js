/* sim/weaponsa.js — P37-W3 weapons A: flamethrower, acid bomb, gas bomb, mortar, minigun, handgun (the boomerang and
 * the mail raven are in sim/raven.js, which registers itself here). Data: sim/arsenala.js (C.ARMS.FLAME ... RAVEN).
 * Portable + deterministic: the own RNG stream S.wa.rng, fixed step, sim time only, every transcendental through SS.math.
 * All state lives in S.wa (snapshot / replay / hash cover it); the sim emits events, render/weaponsa.js + the audio
 * layer present them.
 *
 * C layout (S.wa = struct WeaponsA):
 *   struct WeaponsA { Rng rng; Stream stream; Spot spot[ACID.CAP]; AcidDrop acid[]; Cloud cloud[GAS.CAP]; Boom boom[];
 *                     Raven raven[]; Letter letter[]; f32 fz[NWEAPONS] (fuse per timed throwable); f32 mortarH, mineF;
 *                     u16 lastRound; Box ebox; };
 *   struct Stream  { u8 key; i16 owner; f32 t, dur, acc; u32 n; }           // flamethrower / minigun burst
 *   struct Spot    { vec3 p; f32 r, t, life, depth, tick; }                  // an acid spot eating the ground
 *   struct AcidDrop{ f32 s, y, vs, vy, age; }                                // in the section plane
 *   struct Cloud   { vec3 p; f32 r, t, vx, vz; }                             // a gas cloud
 *   Worm += { f32 stickT (gel burning until), gas (infected), coughT, coughAt, acidT, hopT; i8 hopDir }
 * Projectile specials (C.PROJ[*].wa): flamedrop, acid, gas, mortar (airburst), bomblet go through WA.pre / WA.detonate /
 * WA.water, called from weapons.js. Parameters (+ / -): WA.adjust(S, dir), WA.param(S, key), WA.fuse_of(S, key).
 * Contract for other workstreams: WA.minigun_round(S, origin, dir, owner[, opts]) and WA.bullet_path(S, weapon, s, y, aim). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane, MAT = C.MAT, A = C.ARMS;
  const WA = SS.weaponsA = {};
  const W = () => SS.world;
  const sim = () => SS.sim;
  const WPm = () => SS.weapons;
  WA.mods = [];                                            // sub-modules (raven.js): { init(S), step(S, dt), busy(S) }
  const HOLD = 2.5;                                        // s a fresh gas cloud / acid spot holds the turn
  const rng = S => M.rng_next(S.wa.rng);
  const rr = (S, a, b) => a + (b - a) * rng(S);
  const hyp3 = (a, b) => M.len3(a.x - b.x, a.y - b.y, a.z - b.z);
  WA.rr = rr; WA.rng = rng;

  WA.init = function (S) {
    S.wa = { rng: M.rng_make(((Math.imul(S.settings.seed | 0, 40503) + 0x37a1) >>> 0) || 1), stream: null, spots: [], acid: [], clouds: [], boom: [], ravens: [], letters: [],
      lastRound: null, ebox: null, n: 0 };
    for (const m of WA.mods) if (m.init) m.init(S);
  };
  const ens = S => { if (!S.wa) WA.init(S); return S.wa; };

  /* ---------- per-weapon parameters (+ / -): fuse of the timed throwables, mortar burst height, planted mine fuse ----------
   * P84: PER TEAM (they were one set for the whole match: team 1's F key changed team 2's grenade too). Stored in the team struct, t.ws = { fz{key: s},
   * mortarH, mineF }, read for the team whose worm is active (or the team passed in); it switches with the turn by itself, is in the snapshot and the hash. */
  WA.ws_make = () => ({ fz: Object.assign({}, C.FUSE_DEFAULT || {}), mortarH: (C.PARAM && C.PARAM.BURST_DEF) || 3, mineF: (C.PARAM && C.PARAM.MINE_DEF) || 1.5 });
  WA.ws = function (S, team) {
    const t = S.teams && S.teams[team != null ? team : (S.active ? S.active.team : 0)];
    if (!t) { if (!S.wsLone) S.wsLone = WA.ws_make(); return S.wsLone; }
    return t.ws || (t.ws = WA.ws_make());
  };
  WA.fuse_of = function (S, key, team) {
    const pd = C.PROJ[key] || {}, ws = WA.ws(S, team);
    if (ws.fz[key] != null && pd.fuseSet) return ws.fz[key];
    return pd.fuseSet ? S.fuse : (pd.fuse || 99);
  };
  WA.set_fuse = function (S, key, v, team) { const pd = C.PROJ[key] || {}; if (!pd.fuseSet) return; const ws = WA.ws(S, team); ws.fz[key] = M.clamp(v, C.PARAM.FUSE_MIN, C.PARAM.FUSE_MAX); if (key === 'grenade') S.fuse = ws.fz[key]; };
  // the turn changed hands: S.fuse (the legacy mirror of the grenade's fuse) follows the new team's setting
  WA.turn_sync = function (S) { if (!S.active) return; const f = WA.fuse_of(S, 'grenade'); if (S.fuse || f !== (C.FUSE_DEFAULT || {}).grenade) S.fuse = f; };
  // hash of every team's settings (the active team's mortar / mine values first: the same numbers the old global fields mixed)
  WA.hash_ws = function (S, mix) {
    const a = WA.ws(S); mix(a.mortarH); mix(a.mineF);
    const n = S.teams ? S.teams.length : 0, D = WA.ws_make();
    for (let t = 0; t < n; t++) {
      const ws = WA.ws(S, t);
      if (t !== (S.active ? S.active.team : 0)) { if (ws.mortarH !== D.mortarH) mix(ws.mortarH + 100 * t); if (ws.mineF !== D.mineF) mix(ws.mineF + 100 * t); }
      for (let q = 0; q < C.FUSE_KEYS.length; q++) { const k = C.FUSE_KEYS[q]; if (ws.fz[k] !== D.fz[k]) mix(ws.fz[k] + 7 * t + 0.1); }
    }
  };
  // step the parameter of the selected weapon by dir (-1 / +1); returns true when the selected weapon has one
  WA.adjust = function (S, dir) {
    const key = S.weapon, K = C.PARAM, wa = WA.ws(S), pd = C.PROJ[key] || {};
    if (!dir) return false;
    const d = dir > 0 ? 1 : -1;
    if (key === 'mortar') { wa.mortarH = M.clamp(wa.mortarH + d * K.BURST_STEP, K.BURST_MIN, K.BURST_MAX); return true; }
    if (key === 'mine') { wa.mineF = M.clamp(wa.mineF + d * K.MINE_STEP, K.MINE_MIN, K.MINE_MAX); return true; }
    if (pd.fuseSet) { const v = M.clamp(WA.fuse_of(S, key) + d * K.FUSE_STEP, K.FUSE_MIN, K.FUSE_MAX); wa.fz[key] = v; if (key === 'grenade') S.fuse = v; return true; }
    return false;
  };
  // { name, value, unit } for the HUD, or null
  WA.param = function (S, key) {
    const wa = WA.ws(S), pd = C.PROJ[key] || {};
    if (key === 'mortar') return { name: 'burst height', value: wa.mortarH, unit: 'm' };
    if (key === 'mine') return { name: 'fuse', value: wa.mineF, unit: 's' };
    if (pd.fuseSet) return { name: 'fuse', value: WA.fuse_of(S, key), unit: 's' };
    return null;
  };
  // the fuse of a mine once it is tripped: planted by a worm = the player's setting; the map's mines = settings.mineFuse
  // ('random' | 0 | 1 | 2 | 3 | '0'..'3'): random draws 0 / 1 / 2 / 3 s from the own stream. fallback = the legacy value
  WA.mine_fuse = function (S, b, fallback) {
    if (b && b.dropped && b.fuseSet != null) return b.fuseSet;
    const mf = S.settings.mineFuse;
    if (mf === undefined || mf === null || mf === 'default') return fallback;
    if (mf === 'random') { ens(S); return Math.floor(rng(S) * 4); }
    const v = +mf; return Number.isFinite(v) ? M.clamp(v, 0, 3) : fallback;
  };
  WA.streaming = (S, w) => !!(S.wa && S.wa.stream && S.wa.stream.owner === w.id);

  /* ---------- helpers ---------- */
  const pw = (S, ds, dy) => { const d = P.dir(S); return { x: d.x * ds, y: dy, z: d.z * ds }; };
  // the lattice box of an edit goes through the same hooks as weapons.js edited(): collapse + struct
  function mark_edit(S, x, y, z, R) {
    const wa = ens(S), b = wa.ebox;
    if (!b) wa.ebox = { x0: x - R, y0: y - R, z0: z - R, x1: x + R, y1: y + R, z1: z + R };
    else { b.x0 = M.min(b.x0, x - R); b.y0 = M.min(b.y0, y - R); b.z0 = M.min(b.z0, z - R); b.x1 = M.max(b.x1, x + R); b.y1 = M.max(b.y1, y + R); b.z1 = M.max(b.z1, z + R); }
    S.sectionDirty = true;
  }
  function flush_edit(S) {
    const wa = S.wa, b = wa && wa.ebox; if (!b) return; wa.ebox = null;
    const w = W(), H = w.H;
    const box = { i0: M.max(0, Math.floor(b.x0 / H) - 1), i1: M.min(w.NX - 1, Math.ceil(b.x1 / H) + 1), j0: M.max(0, Math.floor(b.y0 / H) - 1), j1: M.min(w.NY - 1, Math.ceil(b.y1 / H) + 1),
      k0: M.max(0, Math.floor(b.z0 / H) - 1), k1: M.min(w.NZ - 1, Math.ceil(b.z1 / H) + 1) };
    S.sectionDirty = true;
    if (S.settings.collapse && SS.collapse_hook) SS.collapse_hook(S, box);
    if (SS.struct && SS.struct.on_edit) SS.struct.on_edit(S);
  }
  WA.mark_edit = mark_edit; WA.flush_edit = flush_edit;
  const wv = { x: 0, y: 0, z: 0 };
  function wind(S, x, y, z) { if (SS.weather && SS.weather.wind_at) SS.weather.wind_at(S, x, y, z, wv); else { wv.x = wv.y = wv.z = 0; } return wv; }

  /* ---------- using a weapon (non-charge kinds: the stream weapons, the handgun, the raven) ---------- */
  WA.use = function (S, key, a, ap, aim) {
    const wa = ens(S);
    if (key === 'flamethrower' || key === 'minigun') {
      const K = key === 'minigun' ? A.MINIGUN : A.FLAME;
      if (wa.stream) return false;
      wa.stream = { key, owner: a.id, t: 0, dur: K.DUR, acc: 0, n: 0 };
      sim().emit(S, 'streamstart', { weapon: key, wormId: a.id});
      sim().log(S, `${a.name} opens up the ${C.ARSENAL[key].name.toLowerCase()}.`, sim().team_rgb(S, a.team));
      WPm().used(S, key, null);     // (P38 R1: the retreat window is the arsenal entry's `retreat`, one source of truth)
      return true;
    }
    if (key === 'handgun') return handgun(S, a, ap, aim);
    if (WA.mod_use) { const r = WA.mod_use(S, key, a, ap, aim); if (r != null) return r; }
    return false;
  };
  // charge kinds with their own flight (boomerang): called from weapons.js use() before the generic launch
  WA.charge = function (S, key, a, ap, aim, speed) { return WA.mod_charge ? WA.mod_charge(S, key, a, ap, aim, speed) : false; };
  // a generic projectile of a wa kind has just been launched (mortar: remember the burst height)
  WA.launched = function (S, key, p) {
    if (key === 'mortar') { p.burstH = WA.ws(S).mortarH; p.armB = 0.3; }
    if (key === 'gas') p.fuse = WA.fuse_of(S, 'gas');
  };

  /* ---------- the handgun: 2 hitscan explosive rounds ---------- */
  function handgun(S, a, ap, aim) {
    const K = A.HANDGUN;
    let s = ap.s + aim.s * K.MUZZLE, y = a.pos.y + aim.y * K.MUZZLE, hit = null;
    for (let L = 0; L < K.RANGE && !hit; L += 0.1) {
      s += aim.s * 0.1; y += aim.y * 0.1;
      const wp = P.to_world(S, s, y);
      for (const w of S.worms) if (!w.dead && w !== a && hyp3(w.pos, wp) < C.WORM_R + 0.05) { hit = { w, wp }; break; }
      if (hit) break;
      for (const b of S.bodies) if (b.prop === 'mine' && !b.disarmed && hyp3(b.pos, wp) < b.rb + 0.05) { hit = { wp }; break; }
      if (hit) break;
      const bi = S.planeBodies.length ? P.body_at2(S, s, y, true) : -1;
      if (bi >= 0) { hit = { wp }; break; }
      if (P.solid2(S, s, y)) { hit = { wp, ground: true }; break; }
    }
    const from = P.to_world(S, ap.s + aim.s * K.MUZZLE, a.pos.y + aim.y * K.MUZZLE), end = hit ? hit.wp : P.to_world(S, s, y);
    sim().emit(S, 'shot', { weapon: 'handgun', from, to: end, hit: !!hit });
    if (hit) { S.hitDir = pw(S, aim.s, aim.y); sim().explode(S, end, { W: K.W, dmg: K.BLAST_DMG, name: 'an explosive round' }, a.id); S.hitDir = null; }
    S.shots++;
    WPm().used(S, 'handgun', null, S.shots < K.SHOTS);
    if (S.shots < K.SHOTS) sim().log(S, 'One more round.', sim().team_rgb(S, a.team));
    return true;
  }

  /* ---------- the streams: flamethrower droplets, minigun rounds ---------- */
  function stepStream(S, dt) {
    const wa = S.wa, st = wa.stream, a = S.worms[st.owner];
    if (!a || a.dead) { endStream(S); return; }
    st.t += dt;
    const ap = P.to_plane(S, a.pos), aim = sim().aim_dir(S);
    if (st.key === 'flamethrower') {
      const K = A.FLAME;
      st.acc += K.RATE * dt;
      while (st.acc >= 1) {
        st.acc -= 1;
        const sp = K.V * (0.92 + 0.16 * rng(S)), ea = S.aim + (rng(S) + rng(S) - 1) * K.SPREAD;
        const ds = a.facing * M.cos(ea), dy = M.sin(ea);
        const back = rng(S) * sp * dt;                                 // (sub-step offset: the droplets of one step are spread along the jet)
        WPm().launch(S, 'flamedrop', ap.s + aim.s * K.MUZZLE + ds * back, a.pos.y + aim.y * K.MUZZLE + dy * back, ds * sp + 0.3 * (a.air ? a.vs : 0), dy * sp, a.id);
        st.n++;
      }
      if (S.tick % 6 === 0) sim().emit(S, 'flamejet', { x: a.pos.x, y: a.pos.y, z: a.pos.z, ds: aim.s, dy: aim.y, t: st.t / K.DUR, wormId: a.id});
      S.lastBoom = S.time;
      if (st.t >= K.DUR) endStream(S);
    } else {
      const K = A.MINIGUN, up = M.smooth(M.clamp(st.t / K.SPIN, 0, 1)), down = M.smooth(M.clamp((K.DUR - st.t) / K.SPIN, 0, 1)), k = up * down;
      st.acc += K.RATE * k * dt;
      const d = P.dir(S), nn = P.nrm(S);
      let fired = 0;
      const base = { x: d.x * aim.s, y: aim.y, z: d.z * aim.s };
      const o = P.to_world(S, ap.s + aim.s * K.MUZZLE, a.pos.y + aim.y * K.MUZZLE);
      while (st.acc >= 1) {
        st.acc -= 1;
        const e1 = (rng(S) + rng(S) - 1) * K.SPREAD * 1.4, e2 = (rng(S) + rng(S) - 1) * K.SPREAD * 0.6;
        // spread: a component perpendicular to the aim in the plane (e1) + a small one out of the plane (e2)
        const dir = { x: base.x + d.x * -aim.y * e1 + nn.x * e2, y: base.y + aim.s * e1, z: base.z + d.z * -aim.y * e1 + nn.z * e2 };
        const l = M.len3(dir.x, dir.y, dir.z); dir.x /= l; dir.y /= l; dir.z /= l;
        WA.minigun_round(S, o, dir, a.id);
        fired++; st.n++;
      }
      if (fired) { S.lastBoom = S.time; sim().emit(S, 'mgfire', { x: o.x, y: o.y, z: o.z, dx: base.x, dy: base.y, dz: base.z, n: fired, k, wormId: a.id}); }
      if (S.tick % 12 === 0) flush_edit(S);
      if (st.t >= K.DUR) endStream(S);
    }
  }
  function endStream(S) { const st = S.wa.stream; S.wa.stream = null; flush_edit(S); if (st) sim().emit(S, 'streamend', { weapon: st.key, wormId: st.owner}); }

  /* One minigun round (also used by W4's sentry): a hitscan from origin along dir (unit, world) to the first worm, prop or
   * terrain within RANGE. Worm: DMG HP + a small push + 'bloodhit' (+ 'gib' when it goes down: the worm is torn apart);
   * terrain: a CHIP-radius bite (soft ground more than rock), splash on worms near the impact, sparks / dust events.
   * opts = { range, dmg, name }. Returns { kind: 'worm' | 'terrain' | 'water' | 'none', x, y, z, worm } */
  const hitOut = { kind: 'none', x: 0, y: 0, z: 0, worm: null };
  WA.minigun_round = function (S, o, dir, owner, opts) {
    const K = A.MINIGUN, w = W(), range = (opts && opts.range) || K.RANGE, dmg = (opts && opts.dmg) || K.DMG, STEP = 0.14;
    const wa = ens(S);
    hitOut.kind = 'none'; hitOut.worm = null;
    let x = o.x, y = o.y, z = o.z, L = 0, px = x, py = y, pz = z;
    const wr = C.WORM_R + 0.08;
    while (L < range) {
      px = x; py = y; pz = z;
      x += dir.x * STEP; y += dir.y * STEP; z += dir.z * STEP; L += STEP;
      let hw = null;
      for (const q of S.worms) {
        if (q.dead || q.id === owner || q.drowning) continue;
        const dx = x - q.pos.x, dy = y - q.pos.y, dz = z - q.pos.z;
        if (dx * dx + dy * dy + dz * dz < wr * wr) { hw = q; break; }
      }
      if (hw) {
        hitOut.kind = 'worm'; hitOut.x = x; hitOut.y = y; hitOut.z = z; hitOut.worm = hw;
        S.hitDir = { x: dir.x, y: dir.y, z: dir.z };
        const lethal = hw.hp <= dmg;
        if (lethal) hw.mgKill = S.time;
        sim().emit(S, 'bloodhit', { x, y, z, dx: dir.x, dy: dir.y, dz: dir.z, wormId: hw.id, team: hw.team, hp: hw.hp, lethal });
        sim().hurt(S, hw, dmg, (opts && opts.src) || C.DS.MINIGUN);
        const sc = K.PUSH;
        if (!hw.dead) {
          if (sim().ctl(S, hw)) { const dd = P.dir(S); hw.vs += (dir.x * dd.x + dir.z * dd.z) * sc; hw.vy += dir.y * sc + 0.1 * sc; hw.air = true; }
          else { hw.rest = false; hw.vel.x += dir.x * sc; hw.vel.y += dir.y * sc + 0.1 * sc; hw.vel.z += dir.z * sc; }
        }
        return hitOut;
      }
      let bodyHit = false;
      for (const b of S.bodies) {
        if (!b.prop) continue;
        const dx = x - b.pos.x, dy = y - b.pos.y, dz = z - b.pos.z;
        if (dx * dx + dy * dy + dz * dz < (b.rb + 0.05) * (b.rb + 0.05)) {
          if (b.prop === 'mine' && !b.disarmed) { b.armed = true; if (b.det < 0 || b.det > S.time + 0.2) b.det = S.time + 0.2; }
          else if (b.prop === 'barrel' && SS.scatter && rng(S) < 0.25) SS.scatter.ignite(S, b);
          else if (SS.bodies && SS.bodies.nudge) SS.bodies.nudge(S, b, { x: dir.x, y: dir.y, z: dir.z }, 6);
          bodyHit = true; break;
        }
      }
      if (bodyHit) { hitOut.kind = 'terrain'; hitOut.x = x; hitOut.y = y; hitOut.z = z; sim().emit(S, 'mgimpact', { x, y, z, nx: -dir.x, ny: -dir.y, nz: -dir.z, mat: 0 }); return hitOut; }
      const sea = sim().surface_at(S, x, z);
      if (y < sea && py >= sea - 1e-3) { hitOut.kind = 'water'; hitOut.x = x; hitOut.y = sea; hitOut.z = z; if ((wa.n++ & 3) === 0) sim().emit(S, 'splash', { x, y: sea, z, size: 0.25 }); return hitOut; }
      if (y < 0.2 || x < 0 || z < 0 || x > w.SX || z > w.SZ) { hitOut.kind = 'none'; return hitOut; }
      if (w.sample(x, y, z) > 0) {
        const mat = w.mat_at(x, y, z), strength = C.MATS[mat] ? C.MATS[mat].strength : 100;
        hitOut.kind = 'terrain'; hitOut.x = px; hitOut.y = py; hitOut.z = pz;
        let nx = -dir.x, ny = -dir.y, nz = -dir.z;
        if (w.normal) { const n3 = w.normal(x, y, z, {}); if (n3 && (n3.x || n3.y || n3.z)) { nx = -n3.x; ny = -n3.y; nz = -n3.z; const nl = M.nz(M.len3(nx, ny, nz), 1); nx /= nl; ny /= nl; nz /= nl; } }
        sim().emit(S, 'mgimpact', { x: px, y: py, z: pz, nx, ny, nz, mat });
        if (strength < 1e8) {
          const R = K.CHIP * M.clamp(M.sqrt ? M.sqrt(140 / strength) : Math.sqrt(140 / strength), 0.2, 1.25);
          if (w.carve(x, y, z, R) > 0) mark_edit(S, x, y, z, R);
        }
        if (rng(S) < 0.3) for (const q of S.worms) if (!q.dead && q.id !== owner && M.len3(q.pos.x - px, q.pos.y - py, q.pos.z - pz) < K.SPLASH + C.WORM_R) { S.hitDir = { x: nx, y: ny, z: nz }; sim().hurt(S, q, K.SPLASH_DMG, C.DS.MINIGUN_SPLINTER); }
        return hitOut;
      }
    }
    return hitOut;
  };
  // the path of a minigun / handgun round for a laser sight: a straight line (no bullet drop) in the plane
  WA.bullet_path = function (S, weapon, s, y, aim) {
    const K = weapon === 'handgun' ? A.HANDGUN : A.MINIGUN, ds = aim.s, dy = aim.y, pts = [{ s, y }];
    let L = 0, cs = s, cy = y;
    while (L < K.RANGE) { cs += ds * 0.25; cy += dy * 0.25; L += 0.25; if (P.solid2(S, cs, cy)) break; }
    pts.push({ s: cs, y: cy }); return pts;
  };

  /* ---------- projectile specials (called from weapons.js) ---------- */
  const firePatchY = (S, x, z, y0) => { const top = W().top_at(x, z); return top > -1e8 && Math.abs(top - y0) < 2.5 ? top : y0; };
  // a burning gel patch (flamethrower): merged with a patch within MERGE m (it grows, keeps burning), else a new one
  function gelPatch(S, pos) {
    const K = A.FLAME, y = firePatchY(S, pos.x, pos.z, pos.y);
    if (y < sim().surface_at(S, pos.x, pos.z) + 0.05) { sim().emit(S, 'steam', { x: pos.x, y, z: pos.z, power: 0.25 }); return; }
    const life = rr(S, K.LIFE0, K.LIFE1), t1 = S.time + life;
    let best = null, bd = K.MERGE, n = 0;
    for (const f of S.flames) {
      if (!f.ft) continue; n++;
      const d = M.len3(f.x - pos.x, (f.y - y) * 0.5, f.z - pos.z);
      if (d < bd) { bd = d; best = f; }
    }
    if (best && (bd < K.MERGE || n >= K.CAP)) { best.t1 = M.max(best.t1, t1); best.r = M.min(K.R * 1.6, best.r + 0.035); }
    else if (n >= K.CAP) {
      let bf = null, bdd = 1e9; for (const f of S.flames) if (f.ft) { const d = M.len3(f.x - pos.x, f.y - y, f.z - pos.z); if (d < bdd) { bdd = d; bf = f; } }
      if (bf) bf.t1 = M.max(bf.t1, t1);
    } else sim().pool_push(S.flames, C.LIMITS.FLAMES, { x: pos.x, y, z: pos.z, r: K.R, t1, napalm: 1, ft: 1 });
    if (SS.veg && SS.veg.ignite_disc) SS.veg.ignite_disc(S, pos.x, y, pos.z, K.R + 0.3, 1);
  }
  function stickWorm(S, w) {
    const K = A.FLAME, t = S.time + rr(S, K.STICK0, K.STICK1);
    if (!(w.stickT > S.time)) { sim().emit(S, 'stick', { wormId: w.id}); }
    w.stickT = M.max(w.stickT || 0, M.min(t, S.time + K.STICK1 + 1));
  }
  WA.detonate = function (S, p, pos) {      // returns true when handled completely (no generic blast)
    const pd = C.PROJ[p.type] || {};
    if (pd.flamedrop) {
      // sticks to what it hits: a worm (burns it 1-3 s), a prop (lights it), else the ground / a wall (a burning patch)
      let tw = null, td = C.WORM_R + 0.4;
      for (const w of S.worms) { if (w.dead || w.drowning) continue; const d = hyp3(w.pos, pos); if (d < td) { td = d; tw = w; } }
      if (tw) { stickWorm(S, tw); S.hitDir = null; return true; }
      for (const b of S.bodies) if (b.prop && b.burn < 0 && hyp3(b.pos, pos) < b.rb + 0.3 && SS.scatter && SS.scatter.ignite) SS.scatter.ignite(S, b);
      gelPatch(S, pos);
      return true;
    }
    if (pd.acid) { acidBurst(S, p, pos); return true; }
    if (pd.gas) { gasBurst(S, pos); return true; }
    return false;                              // mortar impact, bomblet: the generic blast
  };
  WA.water = function (S, p, pd, wp, surf) {
    if (pd.flamedrop) { sim().emit(S, 'steam', { x: wp.x, y: surf, z: wp.z, power: 0.15 }); return 'gone'; }
    if (pd.acid) { sim().emit(S, 'splash', { x: wp.x, y: surf, z: wp.z, size: 0.5 }); return 'gone'; }
    return pd.impact ? 'burst' : 'keep';
  };
  // before the generic flight: the mortar's airburst
  WA.pre = function (S, p, dt, pd) {
    if (pd.mortar && p.vy < 0 && p.age > (p.armB || 0.3)) {
      const wp = P.to_world(S, p.s, p.y), g = WPm().ground_below(S, p.s, p.y), sea = sim().surface_at(S, wp.x, wp.z), gy = M.max(g, sea);
      if (p.y - gy <= (p.burstH || 3)) { mortarBurst(S, p); return 'gone'; }
    }
    return false;
  };
  function mortarBurst(S, p) {
    const K = A.MORTAR, wp = P.to_world(S, p.s, p.y), H = M.max(0.6, p.burstH || 3);
    sim().emit(S, 'airburst', { x: wp.x, y: p.y, z: wp.z });
    sim().emit(S, 'mortarburst', { x: wp.x, y: p.y, z: wp.z, H });
    // the fall time from the burst: bomblets leave with +-JY m/s; lateral speed so they land within SPREAD m
    const tf = M.sqrt ? M.sqrt(2 * H / C.G) : Math.sqrt(2 * H / C.G), vl = K.SPREAD / M.max(0.35, tf);
    for (let i = 0; i < K.N; i++) {
      const u = (i + 0.5) / K.N * 2 - 1, f = 0.55 + 0.45 * rng(S);
      WPm().launch(S, 'bomblet', p.s, p.y, 0.3 * p.vs + u * vl * f * 1.15, 0.3 * p.vy + rr(S, K.JY0, K.JY1), p.owner);
    }
    S.lastBoom = S.time;
  }

  /* ---------- acid ---------- */
  function acidBurst(S, p, pos) {
    const K = A.ACID, ap = P.to_plane(S, pos);
    sim().explode(S, pos, { W: K.BLAST_W, dmg: C.PROJ.acid.dmg, name: 'an acid bomb' }, p.owner);
    sim().emit(S, 'acidburst', { x: pos.x, y: pos.y, z: pos.z });
    const wa = ens(S);
    for (let i = 0; i < K.N; i++) {
      const a = rr(S, 0.15, M.wrap_angle(Math.PI - 0.15)), v = rr(S, K.V0, K.V1), sgn = i % 2 ? 1 : -1;
      wa.acid.push({ s: ap.s, y: pos.y + 0.15, vs: sgn * M.cos(a * 0.9) * v + 0.25 * p.vs, vy: M.sin(a) * v * 0.75 + rr(S, 0, K.UP) * 0.5 + 0.2 * p.vy, age: 0, hit: 0 });
    }
    S.lastBoom = S.time;
  }
  function addSpot(S, x, y, z) {
    const K = A.ACID, wa = ens(S);
    let best = null, bd = K.MERGE;
    for (const s of wa.spots) { const d = M.len3(s.x - x, (s.y - y) * 0.6, s.z - z); if (d < bd) { bd = d; best = s; } }
    if (best) { best.life = M.min(best.life + 0.8, K.LIFE1 * 1.4); best.r = M.min(K.R * 1.5, best.r + 0.04); return; }
    if (wa.spots.length >= K.CAP) return;
    wa.spots.push({ x, y, z, r: K.R, t: 0, life: rr(S, K.LIFE0, K.LIFE1), depth: 0, tick: rr(S, 0, K.TICK), id: ++wa.n, hop: 0, top0: null, deck: 0 });
  }
  function stepAcid(S, dt) {
    const wa = S.wa, K = A.ACID, w = W();
    for (let i = wa.acid.length - 1; i >= 0; i--) {
      const d = wa.acid[i]; d.age += dt;
      d.vy -= C.G * dt; const n = M.max(1, Math.ceil(M.len2(d.vs, d.vy) * dt / 0.1)), h = dt / n;
      let gone = false;
      for (let q = 0; q < n && !gone; q++) {
        const ns = d.s + d.vs * h, ny = d.y + d.vy * h, wp = P.to_world(S, ns, ny);
        if (ny < sim().surface_at(S, wp.x, wp.z) || ny < 0.3) { sim().emit(S, 'splash', { x: wp.x, y: sim().surface_at(S, wp.x, wp.z), z: wp.z, size: 0.25 }); gone = true; break; }
        if (P.blocked2(S, ns, ny)) {
          // lands: a spot on the surface (a wall: drips down it)
          let y = d.y; for (let k = 0; k < 8 && P.blocked2(S, d.s, y); k++) y += 0.05;
          const lp = P.to_world(S, d.s, y); addSpot(S, lp.x, y, lp.z); gone = true; break;
        }
        d.s = ns; d.y = ny;
        for (const o of S.worms) if (!o.dead && o.drowning !== true && hyp3(o.pos, wp) < C.WORM_R + 0.05 && d.age > 0.05 && !d.hit) {
          d.hit = 1; acidHurt(S, o, 3); acidTouch(S, o);
        }
      }
      if (gone || d.age > 6) wa.acid.splice(i, 1);
    }
    for (let i = wa.spots.length - 1; i >= 0; i--) {
      const s = wa.spots[i]; s.t += dt; s.tick -= dt;
      const surf = sim().surface_at(S, s.x, s.z);
      if (s.t > s.life || s.y < surf - 0.1 || s.y < 0.4) { sim().emit(S, 'acidend', { x: s.x, y: s.y, z: s.z }); wa.spots.splice(i, 1); continue; }
      if (s.tick <= 0) {
        // erosion: the spot rests on the ground surface under it and bites a ball out of it every TICK s (the lattice is
        // 0.5 m, so the ground goes in visible bites: ~0.4 m each); strong materials bite slower (rock x2, concrete x4),
        // steel / bedrock never; where the ground is gone under it, it runs down. Stops after DEPTH m below its landing.
        let sy = null; for (let q = s.y + 0.4; q > s.y - 1.4; q -= 0.1) if (w.sample(s.x, q, s.z) > 0) { sy = q + 0.04; break; }
        let deck = SS.struct && S.structs && S.structs.length ? SS.struct.floor_at(S, s.x, s.y + 0.5, s.z) : -1e9;   // P38: a steel deck holds the spot
        if (sy == null && deck > s.y - 1.0) { s.y = deck + 0.02; s.tick += K.TICK; s.deck = 1; }
        else if (sy == null) { s.y -= 0.25; s.tick += 0.05; s.deck = 0; }
        else {
          s.y = sy; if (s.top0 == null) s.top0 = sy;
          const under = w.mat_at(s.x, sy - 0.15, s.z), str = C.MATS[under] ? C.MATS[under].strength : 0, f = M.clamp(100 / M.max(1, str), 0.08, 2.2);        // concrete (2600) 0.08 = ~14x slower than soil, steel the same
          s.tick += K.TICK / f;
          if (str > 0 && str < 1e8 && s.top0 - sy < K.DEPTH) {
            const R = K.CARVE_R * (1 - 0.3 * s.t / s.life);
            if (w.carve(s.x, sy - 0.1, s.z, R) > 0) { mark_edit(S, s.x, sy, s.z, R); sim().emit(S, 'acideat', { x: s.x, y: sy, z: s.z }); }
          } else if (str >= 1e8) s.tick += 1;
        }
      }
      // P38: steel and wood. The spot weakens the bridge members around it (struct.js) and eats the trunk of a tree it sits at
      if (SS.struct && S.structs && S.structs.length) SS.struct.acid(S, s, s.r, dt);
      if (SS.trees && S.trees && S.trees.length) SS.trees.acid_at(S, s.x, s.y, s.z, s.r, dt);
      // worms in it: damage + hop; devices melt
      for (const o of S.worms) {
        if (o.dead || o.drowning) continue;
        const dx = o.pos.x - s.x, dz = o.pos.z - s.z, dy = o.pos.y - s.y;
        if (dx * dx + dz * dz < (s.r + C.WORM_R) * (s.r + C.WORM_R) && dy > -0.9 && dy < 1.4) { if (o.acidT !== S.time) acidDot(S, o, K.DPS, dt); acidTouch(S, o); }   // (P38 R1: once per worm per step however many spots overlap, like fire)
      }
      for (const d of S.devices) if (hyp3(d.pos, s) < s.r + 0.4) d.hp -= K.DEVICE_DPS * dt;
      // props: a crate dissolves (PROP_T s in the acid), a fuel barrel's wall is eaten through and it ignites, a mine's casing is
      // eaten and it goes off (their own fuse), a boulder / girder is left alone
      for (let bi = S.bodies.length - 1; bi >= 0; bi--) {
        const b = S.bodies[bi]; if (!b.prop || (b.prop !== 'crate' && b.prop !== 'barrel' && b.prop !== 'mine' && b.prop !== 'girder' && !(b.prop === 'car' && !b.wreck))) continue;
        const dx = b.pos.x - s.x, dz = b.pos.z - s.z, dy = b.pos.y - s.y;
        if (dx * dx + dz * dz > (s.r + b.rb) * (s.r + b.rb) || dy < -0.6 || dy > 1.2) continue;
        b.acidT = (b.acidT || 0) + dt;
        if (b.acidT < (b.prop === 'girder' ? K.GIRDER_T : b.prop === 'car' ? K.CAR_T : K.PROP_T)) continue;
        if (b.prop === 'girder') { SS.bodies.remove(S, b); sim().emit(S, 'propbreak', { x: b.pos.x, y: b.pos.y, z: b.pos.z, kind: 'girder', why: 'acid' }); }   // eaten through
        else if (b.prop === 'car') { if (SS.scatter && b.burn < 0) { SS.scatter.ignite(S, b); sim().log(S, 'Acid eats a car\'s fuel tank: it catches fire!', 0xffb060); } }
        else if (b.prop === 'crate') { SS.bodies.remove(S, b); sim().emit(S, 'propbreak', { x: b.pos.x, y: b.pos.y, z: b.pos.z, kind: 'crate', why: 'acid' }); }
        else if (b.prop === 'barrel' && SS.scatter && b.burn < 0) SS.scatter.ignite(S, b);
        else if (b.prop === 'mine' && !b.disarmed && b.det < 0) { b.armed = true; b.det = S.time + 0.3; }
      }
    }
    // hopping worms (one hop per HOP0..HOP1 s while in acid)
    for (const o of S.worms) {
      if (o.dead || !(o.acidT > S.time - 0.15)) continue;
      if (!(o.hopT > 0)) o.hopT = rr(S, K.HOP0, K.HOP1);
      o.hopT -= dt;
      if (o.hopT <= 0) {
        o.hopT = rr(S, K.HOP0, K.HOP1);
        const grounded = sim().ctl(S, o) ? !o.air : o.rest || Math.abs(o.vel.y) < 0.6;
        if (!grounded) continue;
        o.hopDir = o.hopDir ? -o.hopDir : (rng(S) < 0.5 ? -1 : 1);
        const vs = o.hopDir * K.HOP_VS;
        if (sim().ctl(S, o)) { o.vs = vs; o.vy = K.HOP_VY; o.air = true; if (S.rope) S.rope = null; }
        else { const d = P.dir(S); o.rest = false; o.vel.x = d.x * vs; o.vel.z = d.z * vs; o.vel.y = K.HOP_VY; }
        sim().emit(S, 'ouch', { wormId: o.id, x: o.pos.x, y: o.pos.y, z: o.pos.z, acid: 1 });
      }
    }
  }
  function acidTouch(S, o) { o.acidT = S.time; }
  function acidHurt(S, o, n) { S.hitDir = null; sim().hurt(S, o, n, C.DS.ACID, C.HF.DOT); }
  // continuous acid damage: whole points, at most every 0.5 s (like sim.burn, but no flames on the worm)
  function acidDot(S, o, dps, dt) {
    o.dmgAcc += dps * dt;
    if (o.dmgAcc >= 1 && S.time - o.dmgT > 0.5) { const n = Math.floor(o.dmgAcc); o.dmgAcc -= n; o.dmgT = S.time; acidHurt(S, o, n); }
  }

  /* ---------- gas ----------
   * P38-A4: the cloud is K.PUF puffs (a small particle gas, no grid): each puff drifts with the wind, sinks (gas is heavier
   * than air) and random-walks (velocity re-drawn from a hash every 0.5 s, so the cloud spreads like diffusion, sigma ~ sqrt(2 D t)).
   * A puff never enters solid terrain: it slides along the wall per axis (so the gas flows around / over a rock, collects in a
   * pit, creeps into a cave through its opening, and a blast / acid that opens a wall lets it through). Worms are infected by
   * puffs within K.INF_R that have a clear line to them (a thin wall shelters). Cloud = { x, y, z (centroid), r (extent),
   * t, vx, vz (mean drift), id, pf[PUF * 6] = x, y, z, vx, vy, vz per puff } (plain numbers: snapshot / replay / hash).
   * C: struct Cloud { vec3 c; f32 r, t, vx, vz; i32 id; struct Puff { vec3 p, v; } pf[GAS.PUF]; } */
  const solidAt = (x, y, z) => W().sample(x, y, z) > 0;
  function segClear(a, b, c, x1, y1, z1) {          // line of sight through air (3 samples)
    for (let k = 1; k <= 3; k++) { const u = k * 0.25; if (solidAt(a + (x1 - a) * u, b + (y1 - b) * u, c + (z1 - c) * u)) return false; }
    return true;
  }
  function gasBurst(S, pos) {
    const K = A.GAS, wa = ens(S);
    if (wa.clouds.length >= K.CAP) wa.clouds.shift();
    const id = ++wa.n, pf = [];
    let x = pos.x, y = pos.y + 0.3, z = pos.z;
    for (let q = 0; q < 14 && solidAt(x, y, z); q++) y += 0.4;      // a canister buried in the ground opens just above it
    for (let i = 0; i < K.PUF; i++) {
      const h = M.hash3(id * 977 + i, 5, 1), h2 = M.hash3(id * 977 + i, 5, 2), h3 = M.hash3(id * 977 + i, 5, 3);
      const th = M.acos(2 * h2 - 1), cz = M.cos(th), a = 6.283185 * h, sr = M.sin(th), sp = 1.0 + 2.2 * h3;
      let px = x + sr * M.cos(a) * 0.3, py = y + cz * 0.3, pz = z + sr * M.sin(a) * 0.3;
      if (solidAt(px, py, pz)) { px = x; py = y; pz = z; }
      pf.push(px, py, pz, sr * M.cos(a) * sp, cz * sp, sr * M.sin(a) * sp);
    }
    wa.clouds.push({ x, y, z, r: K.R0, t: 0, vx: 0, vz: 0, id, pf });
    sim().emit(S, 'gasburst', { x: pos.x, y: pos.y, z: pos.z });
    S.lastBoom = S.time;
  }
  WA.gas_burst = gasBurst;                          // (tests / scripted events)
  const cloud_density = (K, c) => M.clamp((K.LIFE - c.t) / K.FADE, 0, 1);
  WA.cloud_density = (c) => cloud_density(A.GAS, c);
  // number of puffs of cloud c within r of (x, y, z) with a clear line (solid terrain shelters)
  function puffsNear(c, x, y, z, r) {
    const pf = c.pf; let n = 0;
    for (let i = 0; i < pf.length; i += 6) {
      const dx = pf[i] - x, dy = pf[i + 1] - y, dz = pf[i + 2] - z;
      if (dx * dx + dy * dy + dz * dz < r * r && segClear(x, y, z, pf[i], pf[i + 1], pf[i + 2])) n++;
    }
    return n;
  }
  WA.gas_at = function (S, x, y, z) {               // gas puffs touching the point (0 = clean air); for the AI / tests
    let n = 0; if (S.wa) for (const c of S.wa.clouds) if (cloud_density(A.GAS, c) >= A.GAS.DENS_MIN) n += puffsNear(c, x, y, z, A.GAS.INF_R);
    return n;
  };
  function stepPuffs(S, c, dt, wv) {
    const K = A.GAS, pf = c.pf, spread = c.t < K.GROW ? 1 : 0.4, bucket = Math.floor(c.t / 0.5), f = 1 - M.exp(-dt * K.RELAX);
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let i = 0; i < pf.length; i += 6) {
      const seed = c.id * 977 + i / 6;
      const tx = (M.hash3(seed, bucket, 11) * 2 - 1) * K.DIFF * spread + wv.x * K.WIND_K;
      const ty = (M.hash3(seed, bucket, 12) * 2 - 1) * K.DIFF * spread * 0.7 - K.SINK + wv.y * 0.5;
      const tz = (M.hash3(seed, bucket, 13) * 2 - 1) * K.DIFF * spread + wv.z * K.WIND_K;
      pf[i + 3] += (tx - pf[i + 3]) * f; pf[i + 4] += (ty - pf[i + 4]) * f; pf[i + 5] += (tz - pf[i + 5]) * f;
      let x = pf[i], y = pf[i + 1], z = pf[i + 2];
      if (solidAt(x, y, z)) { y += 0.4; if (pf[i + 4] < 0) pf[i + 4] = 0; }                 // opened under it: float up out of the rock
      else {
        const nx = x + pf[i + 3] * dt, ny = y + pf[i + 4] * dt, nz = z + pf[i + 5] * dt;
        if (!solidAt(nx, ny, nz)) { x = nx; y = ny; z = nz; }
        else {                                                              // slide along the wall, axis by axis; a blocked axis reflects softly
          if (!solidAt(nx, y, z)) x = nx; else pf[i + 3] *= -0.3;
          if (!solidAt(x, ny, z)) y = ny; else pf[i + 4] *= -0.3;
          if (!solidAt(x, y, nz)) z = nz; else pf[i + 5] *= -0.3;
        }
      }
      const sea = sim().surface_at(S, x, z);                              // a puff does not sink into water
      if (y < sea && !solidAt(x, sea + 0.15, z)) y = sea + 0.15;
      pf[i] = x; pf[i + 1] = y; pf[i + 2] = z;
      sx += x; sy += y; sz += z; n++;
    }
    const ox = c.x, oz = c.z;
    c.x = sx / n; c.y = sy / n; c.z = sz / n;
    c.vx = (c.x - ox) / dt; c.vz = (c.z - oz) / dt;
    let q = 0; for (let i = 0; i < pf.length; i += 6) { const dx = pf[i] - c.x, dy = pf[i + 1] - c.y, dz = pf[i + 2] - c.z; q += dx * dx + dy * dy + dz * dz; }
    c.r = M.max(K.R0, 1.7 * M.pow(q / n, 0.5));
  }
  function stepGas(S, dt) {
    const wa = S.wa, K = A.GAS;
    for (let i = wa.clouds.length - 1; i >= 0; i--) {
      const c = wa.clouds[i]; c.t += dt;
      if (c.t >= K.LIFE) { wa.clouds.splice(i, 1); continue; }
      stepPuffs(S, c, dt, wind(S, c.x, c.y, c.z));
      if ((S.tick + i) % 4 === 0 && cloud_density(K, c) >= K.DENS_MIN) {
        for (const w of S.worms) {
          if (w.dead || w.gas) continue;
          if (puffsNear(c, w.pos.x, w.pos.y + 0.4, w.pos.z, K.INF_R) >= K.INF_N) {
            w.gas = 1; w.coughT = S.time + rr(S, 0.3, 1.2);
            sim().emit(S, 'infect', { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z });
            sim().log(S, `${w.name} breathes the gas and starts coughing.`, 0xb8e07a);
          }
        }
      }
      if (c.t < HOLD) S.lastBoom = S.time;
    }
    for (const w of S.worms) {
      if (w.dead || !w.gas) continue;
      if (w.coughT == null) w.coughT = S.time + rr(S, K.COUGH0, K.COUGH1);
      if (S.time >= w.coughT) {
        const inGas = WA.gas_at(S, w.pos.x, w.pos.y + 0.4, w.pos.z) >= K.INF_N;
        w.coughT = S.time + rr(S, K.COUGH0, K.COUGH1) * (inGas ? 0.45 : 1);
        w.coughAt = S.time; sim().emit(S, 'cough', { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z });
      }
    }
  }
  // the poison of a new round: every infected worm loses DMG0..DMG1 HP at the first turn of each round (S.round),
  // in worm-id order, deterministic (own stream); no one is cured except by a health crate (weapons.js pickup)
  function roundTick(S) {
    const wa = ens(S), K = A.GAS;
    if (wa.lastRound == null) { wa.lastRound = S.round; return; }
    if (S.round === wa.lastRound) return;
    wa.lastRound = S.round;
    for (const w of S.worms) {
      if (w.dead || !w.gas) continue;
      const dmg = K.DMG0 + Math.floor(rng(S) * (K.DMG1 - K.DMG0 + 1));
      w.coughAt = S.time; S.hitDir = null;
      sim().emit(S, 'cough', { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z, poison: 1 });
      sim().log(S, `${w.name} is poisoned: -${dmg} HP.`, 0xb8e07a);
      sim().hurt(S, w, dmg, C.DS.GAS, C.HF.QUIET | C.HF.DOT);
    }
  }
  WA.cure = function (S, w) { if (w.gas) { w.gas = 0; w.coughT = null; sim().emit(S, 'cure', { wormId: w.id}); } };

  /* ---------- sticky gel on worms ---------- */
  function stepStick(S, dt) {
    const K = A.FLAME;
    for (const w of S.worms) {
      if (w.dead || !(w.stickT > S.time)) continue;
      if (w.swim || w.drowning) { w.stickT = 0; continue; }
      w.fireT = S.time;
      if (w.fireStep !== S.tick) { w.fireStep = S.tick; sim().burn(S, w, K.DPS, dt, C.DS.FLAMETHROWER); }
    }
  }

  /* ---------- the module hooks ---------- */
  WA.step = function (S, dt) {
    const wa = ens(S);
    if (wa.stream) stepStream(S, dt);
    if (wa.acid.length || wa.spots.length) stepAcid(S, dt);
    else if (S.worms.length) for (const o of S.worms) if (o.hopT > 0) o.hopT = 0;
    if (wa.clouds.length || S.tick % 8 === 0) stepGas(S, dt);
    stepStick(S, dt);
    for (const m of WA.mods) if (m.step) m.step(S, dt);
    if (wa.spots.length && S.tick % 12 === 0) flush_edit(S);
  };
  WA.busy = function (S) {
    const wa = S.wa; if (!wa) return false;
    // the turn waits for the stream, drops in flight, a fresh acid spot / gas cloud (first HOLD s: the infection and the first bites
    // happen then); older ones go on across turns (a cloud lives 16 s, acid sinks for ~8 s)
    if (wa.stream || wa.acid.length) return true;
    for (const sp of wa.spots) if (sp.t < HOLD) return true;
    for (const c of wa.clouds) if (c.t < HOLD) return true;
    for (const m of WA.mods) if (m.busy && m.busy(S)) return true;
    return false;
  };
  WA.turn_start = function (S) { ens(S); roundTick(S); S.shots = 0; };
  WA.stats = S => (S.wa ? { stream: !!S.wa.stream, spots: S.wa.spots.length, acid: S.wa.acid.length, clouds: S.wa.clouds.length, boom: S.wa.boom.length, ravens: S.wa.ravens.length, letters: S.wa.letters.length, flames: S.flames.filter(f => f.ft).length } : null);
})(window.SS = window.SS || {});
