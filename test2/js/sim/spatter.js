/* sim/spatter.js — lava spatter (Step LV4, user: "explosions make LAVA SPLATTER: glowing lava spheres of random sizes
 * that fly, land, and cool slowly, turning black (cold) after a few minutes"). Deterministic (own RNG stream
 * S.spatRng, fixed step), engine-agnostic; render/spatter.js draws S.spat.
 * Spawn (from SS.lava.blast, which knows the thrown volume Vs and its temperature): clots of log-normal diameter
 * (C.SPATTER D50 / SIG_LN, DMIN-DMAX) until FRAC of Vs is flown (N_MIN-N_MAX per blast); the rest of Vs still lands
 * as lava.js's near ring sheet. Each leaves from a random point of the splash disc at the lava surface, on a steep
 * cone (TH0-TH1 from the vertical) leaning away from the blast, at V_REF·W^(1/6)·(D / D50)^-0.5 × log-normal noise.
 * Flight: gravity + quadratic air drag (KD = 3 ρa Cd / (8 ρ r)), sub-steps of ≤ SUB m; stops on a worm (burns it
 * BURN_HP × heat × (D / D50)^1.5 HP once, then drops), in open lava (merges back: SS.lava.deposit), on rock (sticks
 * where the path enters the solid, flattens by heat and impact speed, no bounce; lights dry grass when hot), in
 * water (quenched: 'steam'), on a body (sticks in the body's frame).
 * Cooling: NS concentric shells (geometric thickness, thinnest outside), explicit radial conduction; the skin
 * temperature Ts solves k (T_out − Ts) / hs = εσ(Ts⁴ − Ta⁴) + hc (Ts − Ta) (Newton); the outer shell loses that flux
 * over the exposed area and EG / sqrt(π t_contact) · (T_out − Ta) over the contact share; latent heat LAT spreads over
 * T_SOL-T_LIQ as extra heat capacity. Updated every TDT s (sub-stepped below the explicit stability limit).
 * A landed clot is re-checked every 2 updates: support gone (cratered under it) -> falls again; lava over it ->
 * remelts. A blast loosens / pulverises landed clots nearby (SP.blast, before lava.blast spawns new ones).
 * State: S.spat [{id, x, y, z, vx, vy, vz, D, r (sphere-equivalent radius), a, c (splat semi-axes, horizontal /
 * along the normal), st (0 flying, 1 on the ground, 2 on a body), nx, ny, nz, age, tl (landing time), T[NS] (C),
 * Ts (skin C), nsub, geo (shell volumes / areas / distances), fc (contact share), af (area factor), bid, lx, ly, lz,
 * hit (worm id, -1 none), cold}], S.spatId, S.spatAcc; events 'spatter' {x, y, z, n, V} at a blast and 'spatland' {id, x, y,
 * z, kind: 'rock' | 'body' | 'worm' | 'lava' | 'water' | 'ice', Ts, D}.
 * C layout: struct Clot { i32 id; vec3 pos, vel, nrm, loc; f32 D, r, a, c, age, tl, Ts, fc, af; f32 T[NS];
 * u8 st, cold, nsub; i32 bid, hit; }; Clot clots[MAX]; spatter_spawn / spatter_step / spatter_blast. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, K = C.SPATTER, NS = K.NS, SIG = 5.670e-8;
  const SP = SS.spatter = {};
  const W = () => SS.world;
  const rng = S => { if (!S.spatRng) S.spatRng = M.rng_make(Math.imul((S.settings && S.settings.seed) | 0, 2246822519) + 0x5a7 >>> 0); return M.rng_next(S.spatRng); };
  const gauss = S => { const u = Math.max(1e-9, rng(S)), v = rng(S); return Math.sqrt(-2 * M.log(u)) * M.cos(6.283185 * v); };
  const RCP = K.RHO * K.CP;
  const ce = T => K.CP + (T > K.T_SOL && T < K.T_LIQ ? K.LAT / (K.T_LIQ - K.T_SOL) : 0);   // J/kgK incl. latent heat
  const vol = r => 4.18879 * r * r * r;
  const tmean = b => { let s = 0, v = 0; for (let i = 0; i < NS; i++) { s += b.T[i] * b.geo.V[i]; v += b.geo.V[i]; } return s / v; };
  const tlava = Tc => M.clamp(1 - (K.T_LAUNCH - Tc) / K.T_DROP, 0, 1);       // C -> lava.js T (1 = eruption)

  /* shell geometry of a clot of radius r: thickness ∝ Q_SH^(NS-1-i) (thinnest outside); V, A (outer area of shell
   * i), dc (centre distance i -> i + 1), hs (outer centre -> skin), nsub (explicit stability at TDT) */
  function geometry(r) {
    let s = 0; const rb = [0], w = [];
    for (let i = 0; i < NS; i++) { w.push(M.pow(K.Q_SH, NS - 1 - i)); s += w[i]; }
    for (let i = 0; i < NS; i++) rb.push(rb[i] + w[i] / s * r);
    const V = [], A = [], rc = [], dc = [];
    for (let i = 0; i < NS; i++) { V.push(vol(rb[i + 1]) - vol(rb[i])); A.push(12.56637 * rb[i + 1] * rb[i + 1]); rc.push(0.5 * (rb[i] + rb[i + 1])); }
    for (let i = 0; i < NS - 1; i++) dc.push(rc[i + 1] - rc[i]);
    const hs = r - rc[NS - 1];
    let rate = 0;
    for (let i = 0; i < NS; i++) {
      let g = 0;
      if (i > 0) g += K.K * A[i - 1] / dc[i - 1];
      if (i < NS - 1) g += K.K * A[i] / dc[i];
      else g += Math.min(K.K / hs, 600 + K.EG * 0.8) * A[i] * 1.25;    // skin film (radiation ~600 W/m2K at 1150 C, fresh contact)
      rate = Math.max(rate, g / (RCP * V[i]));
    }
    return { V, A, dc, hs, nsub: Math.max(1, Math.ceil(rate * K.TDT / 0.45)) };
  }

  function make_room(S) {
    const A = S.spat;
    if (A.length < K.MAX) return true;
    for (let i = 0; i < A.length; i++) if (A[i].st !== 0) { A.splice(i, 1); return true; }   // oldest landed
    return false;
  }

  /* one flying clot of diameter D (m) at temperature T0 (C) */
  SP.add = function (S, x, y, z, vx, vy, vz, D, T0) {
    if (!S.spat) S.spat = [];
    const r = D / 2, g = geometry(r), T = new Float64Array(NS); T.fill(T0);
    const b = { id: S.spatId = (S.spatId || 0) + 1, x, y, z, vx, vy, vz, D, r, a: r, c: r, st: 0, nx: 0, ny: 1, nz: 0, age: 0, tl: 0, T, Ts: T0,
      nsub: g.nsub, geo: g, fc: 0, af: 1, bid: 0, lx: 0, ly: 0, lz: 0, hit: -1, cold: false };   // hit: the last worm burned (-1 none: worm ids start at 0)
    S.spat.push(b);
    return b;
  };
  /* a blast at c (Wkg TNT-eq) threw Vs m3 of lava at lava temperature Tn from the splash disc of radius R; returns the
   * volume flown as clots (lava.js lands the rest as its ring sheet) */
  SP.spawn = function (S, c, Wkg, Vs, Tn, R) {
    if (!S.spat) S.spat = [];
    if (!(Vs > 0.004)) return 0;
    const w = W(), budget = K.FRAC * Vs, T0 = K.T_LAUNCH - K.T_DROP * (1 - M.clamp(Tn, 0, 1)), vk = M.pow(Math.max(Wkg, 0.05), 1 / 6);
    let Vf = 0, n = 0;
    while (n < K.N_MAX && (Vf < budget || n < K.N_MIN)) {
      if (!make_room(S)) break;
      const D = M.clamp(K.D50 * M.exp(K.SIG_LN * gauss(S)), K.DMIN, K.DMAX), r = D / 2;
      if (Vf + vol(r) > Vs) break;                                        // never more lava in clots than was thrown
      // launch point: splash disc (centre-weighted), at the lava surface there
      const rr = 0.7 * R * Math.sqrt(rng(S)), aa = rng(S) * 6.283185;
      const x = c.x + rr * M.cos(aa), z = c.z + rr * M.sin(aa);
      const ls = SS.lava ? SS.lava.surface_at(S, x, z) : -1;
      let y = (ls > 0 && ls > c.y - R ? ls : Math.max(c.y, w.top_at(x, z))) + r + 0.05;
      for (let k = 0; k < 10 && w.sample(x, y, z) > 0; k++) y += 0.1;
      // direction: steep cone leaning away from the blast centre
      const th = K.TH0 + (K.TH1 - K.TH0) * rng(S);
      const az = rr > 0.2 * R ? aa + (rng(S) - 0.5) * 2.0 : rng(S) * 6.283185;
      const v = M.clamp(K.V_REF * vk * M.pow(D / K.D50, -0.5) * M.exp(K.V_SIG * gauss(S)), K.V_MIN, K.V_MAX);
      const s = M.sin(th);
      SP.add(S, x, y, z, v * s * M.cos(az), v * M.cos(th), v * s * M.sin(az), D, T0);
      Vf += vol(r); n++;
    }
    if (n) SS.sim.emit(S, 'spatter', { x: c.x, y: c.y, z: c.z, n, V: Vf });
    return Math.min(Vf, Vs);
  };

  /* ---------- landing ---------- */
  function land(S, b, kind, vn) {
    SS.sim.emit(S, 'spatland', { id: b.id, x: b.x, y: b.y, z: b.z, kind, Ts: b.Ts, D: b.D });
    if (kind === 'lava' || kind === 'water') return false;      // caller removes it
    // splat: a hot (fluid) clot hitting fast flattens most; volume kept: a = r flat^(-1/3), c = r flat^(2/3)
    const f = M.clamp((tmean(b) - 900) / 250, 0, 1), flat = 1 - (1 - K.FLAT_MIN) * f * M.clamp(vn / 8, 0.25, 1);
    b.a = b.r * M.pow(flat, -1 / 3); b.c = b.r * M.pow(flat, 2 / 3);
    b.fc = 0.12 + 0.3 * (1 - flat) / (1 - K.FLAT_MIN); b.af = 1 + 0.24 * (1 - flat);
    b.vx = b.vy = b.vz = 0; b.tl = S.time;
    return true;
  }
  const tn = { x: 0, y: 0, z: 0 }, tq = { x: 0, y: 0, z: 0 };
  function on_rock(S, b, px, py, pz, vn0) {
    const w = W();
    // bisect between the last free point and the first solid one: the surface point
    let ax = px, ay = py, az = pz, bx = b.x, by = b.y, bz = b.z;
    for (let k = 0; k < 6; k++) {
      const mx = 0.5 * (ax + bx), my = 0.5 * (ay + by), mz = 0.5 * (az + bz);
      if (w.sample(mx, my, mz) > 0) { bx = mx; by = my; bz = mz; } else { ax = mx; ay = my; az = mz; }
    }
    w.normal(ax, ay, az, tn);
    const vn = Math.max(0, -(b.vx * tn.x + b.vy * tn.y + b.vz * tn.z)) || vn0;
    b.x = ax; b.y = ay; b.z = az; b.nx = tn.x; b.ny = tn.y; b.nz = tn.z;
    land(S, b, 'rock', vn);
    b.st = 1;
    b.x += tn.x * b.c * 0.85; b.y += tn.y * b.c * 0.85; b.z += tn.z * b.c * 0.85;   // centre above the contact (slightly sunk)
    if (b.Ts > K.IGNITE_T && SS.veg && S.veg) SS.veg.ignite_disc(S, b.x, b.y, b.z, 0.25 + 2 * b.D, M.clamp(0.3 + (b.Ts - K.IGNITE_T) / 800, 0.3, 0.8));
  }
  function remelt(S, b) {
    if (SS.lava && SS.lava.deposit) SS.lava.deposit(S, b.x, b.z, vol(b.r), tlava(tmean(b)));
  }

  /* ---------- cooling ---------- */
  const Q = new Float64Array(NS);
  function cool(S, b, dt) {
    const g = b.geo, T = b.T, h = dt / b.nsub, TA = K.T_AIR, TAK4 = M.pow(TA + 273.15, 4);
    const hc = b.st === 0 ? K.HC_FLY : K.HC, As = g.A[NS - 1] * b.af, fc = b.st === 0 ? 0 : b.fc;
    const hg = fc > 0 ? K.EG / Math.sqrt(Math.PI * Math.max(S.time - b.tl, 0.5)) : 0;
    let Ts = b.Ts;
    for (let s = 0; s < b.nsub; s++) {
      const To = T[NS - 1];
      for (let it = 0; it < 3; it++) {                                   // skin: conduction in = radiation + convection out
        const Tk = Ts + 273.15, q = K.EPS * SIG * (Tk * Tk * Tk * Tk - TAK4) + hc * (Ts - TA), dq = 4 * K.EPS * SIG * Tk * Tk * Tk + hc;
        Ts -= (q - K.K * (To - Ts) / g.hs) / (dq + K.K / g.hs);
      }
      Ts = M.clamp(Ts, TA, To);
      for (let i = 0; i < NS; i++) Q[i] = 0;
      for (let i = 0; i < NS - 1; i++) { const f = K.K * g.A[i] * (T[i] - T[i + 1]) / g.dc[i]; Q[i] -= f; Q[i + 1] += f; }
      Q[NS - 1] -= K.K * (To - Ts) / g.hs * As * (1 - fc) + hg * (To - TA) * As * fc;
      for (let i = 0; i < NS; i++) T[i] += Q[i] * h / (K.RHO * ce(T[i]) * g.V[i]);
    }
    b.Ts = Ts;
    if (T[0] < K.COLD_T) { b.cold = true; b.Ts = TA; }
  }

  /* ---------- per step ---------- */
  function body_of(S, id) { for (const o of S.bodies) if (o.id === id) return o; return null; }
  SP.step = function (S, dt) {
    const A = S.spat; if (!A || !A.length) return;
    const w = W(), G = C.G;
    for (let i = A.length - 1; i >= 0; i--) {
      const b = A[i]; b.age += dt;
      if (b.st === 2) {                                                   // riding a body
        const o = body_of(S, b.bid);
        if (!o) { b.st = 0; b.age = 0; b.hit = -1; b.vx = b.vy = b.vz = 0; continue; }    // the body is gone: falls again
        M.q_rot(o.q, b.lx, b.ly, b.lz, tq); b.x = o.pos.x + tq.x; b.y = o.pos.y + tq.y; b.z = o.pos.z + tq.z;
        const l = M.len3(tq.x, tq.y, tq.z) || 1; b.nx = tq.x / l; b.ny = tq.y / l; b.nz = tq.z / l;
        continue;
      }
      if (b.st !== 0) continue;
      if (b.age > K.LIFE) { A.splice(i, 1); continue; }
      let sp = M.len3(b.vx, b.vy, b.vz);
      const n = Math.max(1, Math.ceil(sp * dt / K.SUB)), h = dt / n, KD = 3 * 1.2 * 0.5 / (8 * K.RHO * b.r);
      let gone = false;
      for (let s = 0; s < n && !gone; s++) {
        const px = b.x, py = b.y, pz = b.z;
        const k = 1 / (1 + KD * sp * h);
        b.vx *= k; b.vy = b.vy * k - G * h; b.vz *= k;
        b.x += b.vx * h; b.y += b.vy * h; b.z += b.vz * h;
        sp = M.len3(b.vx, b.vy, b.vz);
        // worms: a hot clot burns once, then drops beside the worm
        for (const wm of S.worms) {
          if (wm.dead || wm.id === b.hit) continue;
          const ex = b.x - wm.pos.x, ey = b.y - wm.pos.y, ez = b.z - wm.pos.z, R = K.WORM_R + b.r;
          if (ex * ex + ey * ey + ez * ez > R * R) continue;
          const heat = M.clamp((b.Ts - 500) / 650, 0, 1);
          const hp = Math.min(K.BURN_MAX, Math.round(K.BURN_HP * heat * M.pow(b.D / K.D50, 1.5)));
          b.hit = wm.id;
          SS.sim.emit(S, 'spatland', { id: b.id, x: b.x, y: b.y, z: b.z, kind: 'worm', Ts: b.Ts, D: b.D });
          if (hp >= 1 || heat > 0.2) { wm.burnT = S.time; SS.sim.hurt(S, wm, Math.max(1, hp), 'lava spatter'); }
          b.vx *= 0.15; b.vz *= 0.15; b.vy = Math.min(b.vy, 0);
          break;
        }
        // open lava: merges back
        if (SS.lava && S.lava) {
          const ls = SS.lava.surface_at(S, b.x, b.z);
          if (ls > 0 && b.y - b.r * 0.5 < ls && b.vy < 0) { b.y = ls; land(S, b, 'lava', 0); remelt(S, b); A.splice(i, 1); gone = true; break; }
        }
        if (w.sample(b.x, b.y, b.z) > 0) { on_rock(S, b, px, py, pz, sp); gone = true; break; }
        // sea ice: the clot lands on it with a hiss (it does not melt through cm-dm ice)
        if (SS.ice && S.ice && b.vy < 0) {
          const it = SS.ice.top_at(S, b.x, b.z);
          if (it > -1e8 && b.y - b.r < it && py - b.r >= it - 0.1) {
            b.x = b.x; b.y = it; b.nx = 0; b.ny = 1; b.nz = 0;
            land(S, b, 'ice', Math.max(0, -b.vy)); b.st = 1; b.y = it + b.c * 0.85;
            SS.sim.emit(S, 'steam', { x: b.x, y: it, z: b.z, power: Math.min(1, 0.1 + b.D * 3) });
            gone = true; break;
          }
        }
        if (b.y < SS.sim.surface_at(S, b.x, b.z)) {
          land(S, b, 'water', 0);
          SS.sim.emit(S, 'steam', { x: b.x, y: SS.sim.surface_at(S, b.x, b.z), z: b.z, power: Math.min(1, 0.2 + b.D * 4) });
          A.splice(i, 1); gone = true; break;
        }
        for (const o of S.bodies) {
          const bx = b.x - o.pos.x, by = b.y - o.pos.y, bz = b.z - o.pos.z, r = o.rb * 0.8 + b.r * 0.5;
          if (bx * bx + by * by + bz * bz >= r * r) continue;
          const vn = Math.max(0, -(b.vx * bx + b.vy * by + b.vz * bz) / (M.len3(bx, by, bz) || 1));
          land(S, b, 'body', vn); b.st = 2; b.bid = o.id;
          M.q_rot_inv(o.q, bx, by, bz, tq); b.lx = tq.x; b.ly = tq.y; b.lz = tq.z;
          gone = true; break;
        }
      }
    }
    // thermal update (and, every second update, the landed clots' support / remelt test)
    S.spatAcc = (S.spatAcc || 0) + dt;
    if (S.spatAcc < K.TDT) return;
    S.spatAcc -= K.TDT;
    S.spatTick = (S.spatTick || 0) + 1;
    const chk = (S.spatTick & 1) === 0;
    for (let i = A.length - 1; i >= 0; i--) {
      const b = A[i];
      if (!b.cold) cool(S, b, K.TDT);
      if (!chk || b.st !== 1) continue;
      if (SS.lava && S.lava && SS.lava.depth_at(S, b.x, b.z) > 0.02 && SS.lava.surface_at(S, b.x, b.z) > b.y - b.c * 0.3) { remelt(S, b); A.splice(i, 1); continue; }
      const d = b.c + 0.12;
      const onIce = SS.ice && S.ice && Math.abs(SS.ice.top_at(S, b.x, b.z) - (b.y - b.c * 0.85)) < 0.15;
      if (!onIce && w.sample(b.x - b.nx * d, b.y - b.ny * d, b.z - b.nz * d) <= 0 && w.sample(b.x, b.y - d, b.z) <= 0) { b.st = 0; b.age = 0; b.vx = b.vy = b.vz = 0; b.hit = -1; }
    }
  };

  /* a blast at c: landed clots inside the crater are pulverised, those near it are knocked loose */
  SP.blast = function (S, c, Wkg) {
    const A = S.spat; if (!A || !A.length) return;
    const Rc = SS.blast ? SS.blast.crater_radius(C.MAT.ROCK, Wkg) : 2 * M.cbrt(Wkg), R2 = 2.5 * Rc;
    for (let i = A.length - 1; i >= 0; i--) {
      const b = A[i]; if (b.st === 0) continue;
      const dx = b.x - c.x, dy = b.y - c.y, dz = b.z - c.z, d = M.len3(dx, dy, dz);
      if (d < Rc * 1.05) { A.splice(i, 1); continue; }
      if (d < R2) {
        const v = 6 * (1 - d / R2) / (d || 1);
        b.st = 0; b.age = 0; b.hit = -1; b.vx = dx * v; b.vy = dy * v + 2; b.vz = dz * v;
      }
    }
  };
  SP.settled = S => !S.spat || !S.spat.some(b => b.st === 0);
  SP.flying = S => (S.spat ? S.spat.reduce((n, b) => n + (b.st === 0), 0) : 0);
  SP.tmean = tmean;
})(window.SS = window.SS || {});
