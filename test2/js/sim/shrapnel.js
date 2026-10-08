/* sim/shrapnel.js — casing fragments of grenade and bazooka blasts (Step X2, user: explosives throw high-speed
 * LUMINOUS SHRAPNEL that can hurt worms nearby, not rocks). Deterministic (own RNG stream S.fragRng, fixed step),
 * engine-agnostic; render/shrapnel.js draws S.frags and the 'frag' events.
 * Physics (C.SHRAPNEL): a ~0.6 g steel fragment leaves at V0 ~800 m/s (±V_SPREAD), quadratic air drag
 * dv/dt = −KD·|v|·v (KD = ρ·Cd·A / 2m ≈ 0.024 /m) plus gravity, integrated in sub-steps of ≤ SUB m so nothing tunnels.
 * It stops in rock (W.sample > 0), in a body (bounding sphere × 0.75), in water (local surface), in a worm (sphere
 * WORM_HIT_R about its centre), or is dropped below V_STOP / beyond REACH m / after LIFE s (cooled, no longer drawn).
 * A real casing gives ~N_REAL_PER_KG fragments per kg; only FREE_PER_KG per kg are simulated in random directions
 * (the visible burst), and worms get their statistically expected hits explicitly: for each worm within REACH with
 * line of sight (solid along the line < LOS_SOLID m), n = N_REAL · A_WORM / (2π r²) (a ground burst throws into the
 * upper half space) is drawn as floor(n) + (rng < frac); each hit is one fragment aimed at a random point on the worm.
 * Damage per hit from the kinetic energy at impact: hp = clamp(round(½ m v² / J_PER_HP), 1, HIT_MAX); the momentum
 * (m·v ≈ 0.5 N·s) moves a 6 kg worm < 0.1 m/s, so there is no knock-back beyond the blast's own.
 * Hits are summed per worm and step: one 'hurt' + one log line ("took N from shrapnel (k fragments)").
 * State: S.frags [{id, x, y, z, vx, vy, vz, ox, oy, oz (origin), age, aim (worm id, -1 = free)}], S.fragId;
 * events 'shrapnel' {x, y, z, n} at the burst and 'frag' {id, x, y, z, vx, vy, vz, ox, oy, oz, age, kind: 'rock'|'body'|'water'|
 * 'worm', mat} where one stops. C layout: struct Frag {...}; Frag frags[MAX]; shrapnel_spawn / shrapnel_step. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT;
  const SH = SS.shrapnel = {};
  const K = C.SHRAPNEL;
  const W = () => SS.world;
  const rng = S => { if (!S.fragRng) S.fragRng = M.rng_make(Math.imul((S.settings && S.settings.seed) | 0, 2654435761) + 0x5eed >>> 0); return M.rng_next(S.fragRng); };

  function add(S, c, dx, dy, dz, v, aim) {
    if (S.frags.length >= K.MAX) return null;
    const f = { id: S.fragId = (S.fragId || 0) + 1, x: c.x, y: c.y, z: c.z, vx: dx * v, vy: dy * v, vz: dz * v, ox: c.x, oy: c.y, oz: c.z, age: 0, aim };
    S.frags.push(f);
    return f;
  }
  /* a blast of Wkg kg TNT-eq at c by a fragmenting weapon */
  SH.spawn = function (S, c, Wkg) {
    if (!S.frags) S.frags = [];
    const w = W(), nFree = Math.round(K.FREE_PER_KG * Wkg), nReal = K.N_REAL_PER_KG * Wkg;
    let n = 0;
    // 0.2 m above the blast point: the crater has been carved, the charge sat on / in the surface
    const o = { x: c.x, y: c.y + 0.2, z: c.z };
    for (let i = 0; i < nFree; i++) {
      const u = rng(S) * 2 - 1, a = rng(S) * 6.2832, r = Math.sqrt(1 - u * u), v = K.V0 * (1 + (rng(S) * 2 - 1) * K.V_SPREAD);
      if (add(S, o, r * M.cos(a), u, r * M.sin(a), v, -1)) n++;
    }
    // expected hits on every worm in reach and in sight
    for (const wm of S.worms) {
      if (wm.dead) continue;
      const dx = wm.pos.x - o.x, dy = wm.pos.y - o.y, dz = wm.pos.z - o.z, d = M.len3(dx, dy, dz);
      if (d > K.REACH || d < 1e-3) continue;
      if (w.solid_len(o.x, o.y, o.z, wm.pos.x, wm.pos.y, wm.pos.z) > K.LOS_SOLID) continue;
      const ex = nReal * K.A_WORM / (2 * Math.PI * Math.max(d, 0.5) * Math.max(d, 0.5));
      let hits = Math.floor(ex); if (rng(S) < ex - hits) hits++;
      for (let h = 0; h < hits; h++) {
        const tx = wm.pos.x + (rng(S) - 0.5) * 0.5, ty = wm.pos.y + (rng(S) - 0.5) * 0.6, tz = wm.pos.z + (rng(S) - 0.5) * 0.5;
        const ax = tx - o.x, ay = ty - o.y, az = tz - o.z, al = M.len3(ax, ay, az) || 1;
        if (add(S, o, ax / al, ay / al, az / al, K.V0 * (1 + (rng(S) * 2 - 1) * K.V_SPREAD), wm.id)) n++;
      }
    }
    SS.sim.emit(S, 'shrapnel', { x: o.x, y: o.y, z: o.z, n });
    return n;
  };

  const dmg = new Map();                          // worm -> [hp, fragments] this step
  function stop(S, f, i, kind, mat) {
    SS.sim.emit(S, 'frag', { id: f.id, x: f.x, y: f.y, z: f.z, vx: f.vx, vy: f.vy, vz: f.vz, ox: f.ox, oy: f.oy, oz: f.oz, age: f.age, kind, mat: mat || 0 });
    S.frags.splice(i, 1);
  }
  SH.step = function (S, dt) {
    const F = S.frags; if (!F || !F.length) return;
    const w = W(), G = C.G;
    for (let i = F.length - 1; i >= 0; i--) {
      const f = F[i]; f.age += dt;
      let sp = M.len3(f.vx, f.vy, f.vz);
      if (sp < K.V_STOP || f.age > K.LIFE || M.len2(f.x - f.ox, f.z - f.oz) > K.REACH * 4) { F.splice(i, 1); continue; }
      const n = Math.max(1, Math.ceil(sp * dt / K.SUB)), h = dt / n;
      let gone = false;
      for (let s = 0; s < n && !gone; s++) {
        const k = 1 / (1 + K.KD * sp * h);           // implicit quadratic drag along the velocity
        f.vx *= k; f.vy = f.vy * k - G * h; f.vz *= k;
        f.x += f.vx * h; f.y += f.vy * h; f.z += f.vz * h;
        sp = M.len3(f.vx, f.vy, f.vz);
        // worms (all of them, also the active one: shrapnel is a 3D blast effect)
        for (const wm of S.worms) {
          if (wm.dead) continue;
          const ex = f.x - wm.pos.x, ey = f.y - wm.pos.y, ez = f.z - wm.pos.z;
          if (ex * ex + ey * ey + ez * ez > K.WORM_HIT_R * K.WORM_HIT_R) continue;
          const hp = M.clamp(Math.round(0.5 * K.MASS * sp * sp / K.J_PER_HP), 1, K.HIT_MAX);
          const acc = dmg.get(wm) || [0, 0]; acc[0] += hp; acc[1]++; dmg.set(wm, acc);
          stop(S, f, i, 'worm'); gone = true; break;
        }
        if (gone) break;
        if (w.sample(f.x, f.y, f.z) > 0) { stop(S, f, i, 'rock', w.mat_at(f.x, f.y, f.z)); gone = true; break; }
        if (f.y < SS.sim.surface_at(S, f.x, f.z)) { stop(S, f, i, 'water'); gone = true; break; }
        for (const b of S.bodies) {
          const bx = f.x - b.pos.x, by = f.y - b.pos.y, bz = f.z - b.pos.z, r = b.rb * 0.75;
          if (bx * bx + by * by + bz * bz < r * r) { stop(S, f, i, 'body', b.mat); gone = true; break; }
        }
      }
    }
    if (dmg.size) {
      for (const [wm, a] of dmg) {
        // P24: the PoC blast damage is the main hurt now; casing fragments add at most CAP HP per worm per burst
        // (a point-blank homing once did 85 HP from 43 fragments on top of the blast)
        if (!(S.time - (wm.shrapT == null ? -9 : wm.shrapT) < 0.5)) { wm.shrapT = S.time; wm.shrapSum = 0; }
        a[0] = Math.min(a[0], K.CAP - wm.shrapSum); if (a[0] <= 0) continue; wm.shrapSum += a[0];
        SS.sim.hurt(S, wm, a[0], 'shrapnel', true);
        SS.sim.log(S, `${wm.name} took ${a[0]} from shrapnel (${a[1]} fragment${a[1] > 1 ? 's' : ''}).`, 0xffb27a);
      }
      dmg.clear();
    }
  };
  SH.settled = S => !S.frags || S.frags.length === 0;
})(window.SS = window.SS || {});
