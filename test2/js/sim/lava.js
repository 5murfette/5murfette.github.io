/* sim/lava.js — open lava as a slow, very viscous fluid (portable, deterministic; no DOM / Three.js).
 *
 * 2.5D layer on the lattice columns (193 x 193 cells of 0.5 m): bed = W.top (the highest solid surface, so no lava
 * flows under bridges or overhangs), thickness h, temperature T (1 = eruption, 0 = solid). Creeping, inertia-free
 * Bingham flow: the volume flux per unit width is q = g h^3 / (3 nu) * f(r) * slope, f = 1 - 1.5 r + 0.5 r^3,
 * r = hc / h, hc = Y / |grad eta| (r >= 1: the sheet is too thin to overcome the yield stress and does not move).
 * nu and Y grow exponentially as the lava cools, so thin sheets and the cooling front stop on their own and the
 * flow builds lobes and levees. Explicit step C.LAVA.DT with two limiters: no face moves more than a fraction of
 * the level difference (no overshoot), no cell gives more than it holds. Heat moves with the volume (upwind).
 * Sources: the crater vent keeps the lake at its level (capped supply); breached voxel pockets drain out through
 * the breach (pressurised). Sinks: cold, still lava bakes into CRUST voxels (it builds land, dams and sea deltas).
 * The sea quenches it ('steam' events). Blasts throw lava out ('lavasplash') and reshape the bed (W.top), so the
 * flow re-routes by itself.
 *
 * State S.lava: h, T, ux, uz (Float32 per column; velocity = mean over the depth, m/s; the surface moves 1.5x),
 *   i0..i1 / k0..k1 (bounding box of wet columns), ver (bumped every sub-step), stats.
 * API: init(S), step(S, dt), blast(S, c, Wkg), deposit(S, x, z, V, T), depth_at(S, x, z), surface_at(S, x, z) (-1 = no lava),
 *   temp_at(S, x, z), vel_at(S, x, z, out), stats(S).
 */
(function (SS) {
  'use strict';
  const M = SS.math;
  const C = SS.CFG, MAT = C.MAT, L = C.LAVA, G = C.G;
  const LV = SS.lava = {};
  const W = () => SS.world;
  const sat = v => v < 0 ? 0 : v > 1 ? 1 : v;
  const M_clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ---------- setup ---------- */
  LV.init = function (S) {
    const w = W(), NX = w.NX, NZ = w.NZ, N = NX * NZ, H = w.H, F = w.features || {};
    const st = S.lava = {
      h: new Float32Array(N), T: new Float32Array(N), ux: new Float32Array(N), uz: new Float32Array(N),
      eta: new Float32Array(N), s: new Float32Array(N), kf: new Float32Array(N), yl: new Float32Array(N),
      out: new Float32Array(N), qx: new Float32Array(N), qz: new Float32Array(N), dV: new Float32Array(N), dE: new Float32Array(N),
      i0: NX, i1: -1, k0: NZ, k1: -1, acc: 0, t: 0, bakeT: 0, leakT: 0, steamT: -9, ver: 0, quiet: false,
      vent: null, lake: null, sources: [], claimed: null,
      qn: new Uint8Array(N), hasVox: false, qRow: 0, qvT: 0, hiss: [],     // P31: water contact (bakes to obsidian), voxel quench sweep, steam
      stats: { vented: 0, drained: 0, leaked: 0, baked: 0, bakedCols: 0, lost: 0, splashed: 0, steam: 0, vmax: 0, ms: 0 }
    };
    // P25: one vent + crater lake per volcano (st.vents; st.vent / st.lake = the first one, kept for older readers)
    st.vents = [];
    for (const v of F.volcanoes || (F.volcano ? [F.volcano] : [])) {
      const vent = [], lake = [], R = v.Rc + 1;
      for (let k = Math.max(0, Math.floor((v.z - R) / H)); k <= Math.min(NZ - 1, Math.ceil((v.z + R) / H)); k++)
        for (let i = Math.max(0, Math.floor((v.x - R) / H)); i <= Math.min(NX - 1, Math.ceil((v.x + R) / H)); i++) {
          const r = M.len2(i * H - v.x, k * H - v.z), c = k * NX + i;
          if (r <= L.VENT_R) vent.push(c);
          if (r <= v.Rc) lake.push(c);
        }
      st.vents.push({ cells: Int32Array.from(vent), level: v.lake, x: v.x, z: v.z, Rc: v.Rc, lake: Int32Array.from(lake) });
    }
    st.vent = st.vents[0] || null; st.lake = st.vent ? st.vent.lake : null;
    for (let o = 0; o < w.N && !st.hasVox; o++) if (w.mat[o] === MAT.LAVA) st.hasVox = true;   // P31: any voxel lava to quench
    if (F.lavaInit) {
      const I = F.lavaInit;
      for (let c = 0; c < N; c++) {
        if (I[c] < 0) continue;
        const hh = I[c] - w.top[c];
        if (hh <= L.HMIN) continue;
        st.h[c] = hh;
        let r = 1e9, rc = 0; for (const o of st.vents) { const ro = M.len2((c % NX) * H - o.x, Math.floor(c / NX) * H - o.z); if (ro < r) { r = ro; rc = o.Rc; } }
        st.T[c] = st.vents.length ? 1 - 0.15 * sat((r - rc) / 40) : 1;   // cooler down the rivers (nearest crater)
      }
    }
    bbox(st, 0, NX - 1, 0, NZ - 1);
    // settle the drawn-in initial state (rounded fronts, lake level vs notches) without emitting events
    st.quiet = true;
    const n = Math.round(L.PREROLL / L.DT);
    for (let q = 0; q < n; q++) tick(S, st, L.DT);
    st.quiet = false;
    st.t = 0; st.bakeT = 0; st.leakT = 0; st.steamT = -9;
  };

  /* bounding box of wet columns inside [i0..i1] x [k0..k1] (the caller passes the region that can hold lava) */
  function bbox(st, i0, i1, k0, k1) {
    const NX = W().NX, h = st.h;
    let a0 = 1e9, a1 = -1, b0 = 1e9, b1 = -1;
    for (let k = k0; k <= k1; k++) {
      const row = k * NX;
      for (let i = i0; i <= i1; i++) if (h[row + i] > 0) { if (i < a0) a0 = i; if (i > a1) a1 = i; if (k < b0) b0 = k; if (k > b1) b1 = k; }
    }
    if (a1 < 0) { st.i0 = W().NX; st.i1 = -1; st.k0 = W().NZ; st.k1 = -1; return; }
    st.i0 = a0; st.i1 = a1; st.k0 = b0; st.k1 = b1;
  }
  function grow(st, i0, i1, k0, k1) {
    const w = W();
    st.i0 = Math.max(0, Math.min(st.i0, i0)); st.i1 = Math.min(w.NX - 1, Math.max(st.i1, i1));
    st.k0 = Math.max(0, Math.min(st.k0, k0)); st.k1 = Math.min(w.NZ - 1, Math.max(st.k1, k1));
  }
  /* add volume V (m^3) of temperature Tin to column c */
  function addLava(st, c, V, Tin) {
    const A = W().H * W().H, h = st.h, hn = h[c] + V / A;
    st.T[c] = hn > 0 ? (h[c] * st.T[c] + V / A * Tin) / hn : Tin;
    h[c] = hn;
  }

  /* ---------- one fixed sub-step ---------- */
  function tick(S, st, dt) {
    st.t += dt;
    sources(S, st, dt);
    flow(S, st, dt);
    st.leakT += dt;
    if (st.leakT >= L.LEAK_EVERY) { st.leakT = 0; leak(S, st); }
    st.bakeT += dt;
    if (st.bakeT >= L.BAKE_EVERY) { st.bakeT = 0; bake(S, st); }
    st.qvT += dt;
    if (st.qvT >= L.QV_EVERY) { st.qvT = 0; quenchVox(S, st); }
    hiss(S, st, dt);
    st.ver++;
  }

  LV.step = function (S, dt) {
    const st = S.lava;
    if (!st) return;
    st.acc += dt;
    while (st.acc >= L.DT - 1e-9) { st.acc -= L.DT; tick(S, st, L.DT); }
  };

  function flow(S, st, dt) {
    if (st.i1 < 0) return;
    const w = W(), NX = w.NX, NZ = w.NZ, H = w.H, A = H * H, top = w.top, SEA = w.SEA, HMIN = L.HMIN;
    // water contact = simulated water on the same ground (not sea under an overhang the lava rests on)
    const wh = S.water ? S.water.h : null, wb = S.water ? S.water.b : null, WET = C.WATER ? C.WATER.WET : 0.004;
    const h = st.h, T = st.T, eta = st.eta, s = st.s, kf = st.kf, yl = st.yl, out = st.out, qx = st.qx, qz = st.qz, dV = st.dV, dE = st.dE;
    // B = wet box + 1 ring (cells that can change this step)
    const i0 = Math.max(0, st.i0 - 1), i1 = Math.min(NX - 1, st.i1 + 1), k0 = Math.max(0, st.k0 - 1), k1 = Math.min(NZ - 1, st.k1 + 1);
    // 1. surface, reset accumulators; E = B + 1 more ring for the gradient
    const e0 = Math.max(0, i0 - 1), e1 = Math.min(NX - 1, i1 + 1), f0 = Math.max(0, k0 - 1), f1 = Math.min(NZ - 1, k1 + 1);
    for (let k = f0; k <= f1; k++) for (let i = e0, c = k * NX + e0; i <= e1; i++, c++) eta[c] = top[c] + h[c];
    for (let k = k0; k <= k1; k++) for (let i = i0, c = k * NX + i0; i <= i1; i++, c++) { out[c] = 0; qx[c] = 0; qz[c] = 0; dV[c] = 0; dE[c] = 0; }
    // 2. per wet column: |grad eta| (a dry wall above the surface gives no gradient; a cliff counts as a drop of at most
    //    max(h, H)), fluidity g / (3 nu(T)) and yield length Y(T)
    for (let k = k0; k <= k1; k++) for (let i = i0, c = k * NX + i0; i <= i1; i++, c++) {
      const hc = h[c];
      if (hc <= HMIN) continue;
      const ec = eta[c], drop = ec - Math.max(hc, H);
      let eE = i < NX - 1 ? eta[c + 1] : ec, eW = i > 0 ? eta[c - 1] : ec, eS = k < NZ - 1 ? eta[c + NX] : ec, eN = k > 0 ? eta[c - NX] : ec;
      if (i < NX - 1 && h[c + 1] <= HMIN && eE > ec) eE = ec; if (eE < drop) eE = drop;
      if (i > 0 && h[c - 1] <= HMIN && eW > ec) eW = ec; if (eW < drop) eW = drop;
      if (k < NZ - 1 && h[c + NX] <= HMIN && eS > ec) eS = ec; if (eS < drop) eS = drop;
      if (k > 0 && h[c - NX] <= HMIN && eN > ec) eN = ec; if (eN < drop) eN = drop;
      const gx = (eE - eW) / (2 * H), gz = (eS - eN) / (2 * H);
      s[c] = Math.sqrt(gx * gx + gz * gz);
      const cool = 1 - T[c];
      kf[c] = G / (3 * L.NU_HOT * M.exp(L.NU_K * cool));
      yl[c] = L.YIELD * M.exp(L.YIELD_K * cool);
    }
    // 3. face fluxes (m^3/s), x faces: c -> c+1, z faces: c -> c+NX; out[] = volume each column wants to give
    const capK = 0.2 * A / dt;
    for (let k = k0; k <= k1; k++) for (let i = i0, c = k * NX + i0; i <= i1; i++, c++) {
      for (let dir = 0; dir < 2; dir++) {
        if (dir === 0 ? i === i1 : k === k1) continue;
        const b = dir === 0 ? c + 1 : c + NX;
        const ea = eta[c], eb = eta[b];
        const u = ea >= eb ? c : b, d = ea >= eb ? ea - eb : eb - ea;
        const hu = h[u];
        if (hu <= HMIN || d <= 0) continue;
        const he = Math.min(hu, eta[u] - Math.max(top[c], top[b]));
        if (he <= HMIN) continue;
        const sl = Math.min(d, Math.max(hu, H)) / H, se = s[u] > sl ? s[u] : sl;
        const r = yl[u] / (se * he);
        if (r >= 1) continue;
        let Q = kf[u] * he * he * he * (1 - 1.5 * r + 0.5 * r * r * r) * sl * H;
        const cap = capK * d;
        if (Q > cap) Q = cap;
        out[u] += Q * dt;
        if (dir === 0) qx[c] = u === c ? Q : -Q; else qz[c] = u === c ? Q : -Q;
      }
    }
    // 4. volume limiter: scale factor per giving column
    for (let k = k0; k <= k1; k++) for (let i = i0, c = k * NX + i0; i <= i1; i++, c++) {
      const o = out[c];
      out[c] = o > 0 && o > h[c] * A ? h[c] * A / o : 1;
    }
    // 5. move volume and heat
    for (let k = k0; k <= k1; k++) for (let i = i0, c = k * NX + i0; i <= i1; i++, c++) {
      let Q = qx[c];
      if (Q !== 0) {
        const b = c + 1, u = Q > 0 ? c : b, V = Q * dt * out[u], Ev = V * T[u];
        dV[c] -= V; dV[b] += V; dE[c] -= Ev; dE[b] += Ev; qx[c] = V / dt;
      }
      Q = qz[c];
      if (Q !== 0) {
        const b = c + NX, u = Q > 0 ? c : b, V = Q * dt * out[u], Ev = V * T[u];
        dV[c] -= V; dV[b] += V; dE[c] -= Ev; dE[b] += Ev; qz[c] = V / dt;
      }
    }
    // 6. update columns; velocity, cooling (thin and still lava cools faster; the sea quenches), new wet box
    let a0 = 1e9, a1 = -1, b0 = 1e9, b1 = -1, vmax = 0, steamC = -1, steamP = 0;
    const lakeHeat = L.LAKE_HEAT * dt;
    for (let k = k0; k <= k1; k++) for (let i = i0, c = k * NX + i0; i <= i1; i++, c++) {
      const h0 = h[c];
      if (h0 <= 0 && dV[c] === 0) continue;
      let hn = h0 + dV[c] / A;
      if (hn <= 1e-6) { st.stats.lost += hn > 0 ? hn * A : 0; h[c] = 0; T[c] = 0; st.ux[c] = 0; st.uz[c] = 0; continue; }
      let Tn = (h0 * T[c] + dE[c] / A) / hn;
      const hv = hn > 0.05 ? hn : 0.05;
      const ux = 0.5 * ((i > 0 ? qx[c - 1] : 0) + qx[c]) / (H * hv), uz = 0.5 * ((k > 0 ? qz[c - NX] : 0) + qz[c]) / (H * hv);
      const sp = Math.sqrt(ux * ux + uz * uz);
      if (sp > vmax) vmax = sp;
      const still = sp < L.STILL_V ? 1 - sp / L.STILL_V : 0, inv = 1 / (hn > 0.1 ? hn : 0.1);
      let cool = L.COOL * inv * (1 + L.STILL_K * still);
      st.qn[c] = 0;                                  // (water contact NOW: a column wetted once long ago bakes to crust)
      if (wh ? wh[c] > WET && top[c] - wb[c] < 0.3 : top[c] < SEA) { cool += L.QUENCH_SIDE * inv; st.qn[c] = 1; const p = Tn * hn; if (p > steamP) { steamP = p; steamC = c; } }   // bed under the sea: water contact
      else if (wh && sideWet(wh, wb, c, i, k, NX, NZ, top[c], WET)) { cool += L.QUENCH_SIDE * inv; st.qn[c] = 1; const p = Tn * hn * 4; if (p > steamP) { steamP = p; steamC = c; } }   // P31: water against its flank
      Tn -= cool * dt;
      h[c] = hn; T[c] = Tn < 0 ? 0 : Tn > 1 ? 1 : Tn; st.ux[c] = ux; st.uz[c] = uz;
      if (i < a0) a0 = i; if (i > a1) a1 = i; if (k < b0) b0 = k; if (k > b1) b1 = k;
    }
    for (const vt of st.vents || []) { const lk = vt.lake; for (let q = 0; q < lk.length; q++) { const c = lk[q]; if (h[c] > 0) T[c] += (1 - T[c]) * lakeHeat; } }
    if (a1 < 0) { st.i0 = NX; st.i1 = -1; st.k0 = NZ; st.k1 = -1; } else { st.i0 = a0; st.i1 = a1; st.k0 = b0; st.k1 = b1; }
    st.stats.vmax = vmax;
    if (steamC >= 0 && st.t - st.steamT > 0.5) {
      st.steamT = st.t; st.stats.steam++;
      const sx = (steamC % NX) * H, sz = Math.floor(steamC / NX) * H, sy = S.water && SS.water ? Math.max(top[steamC], SS.water.surface(S, sx, sz)) : SEA;
      if (!st.quiet && SS.sim) SS.sim.emit(S, 'steam', { x: sx, y: sy, z: sz, power: steamP });
    }
  }

  /* a drained source keeps only its summary (the voxel lists can be ~1 MB each and sources live for the match) */
  const NONE = new Int32Array(0);
  function finish(src) { src.done = true; src.vox = NONE; src.cav = NONE; src.cavP = NONE; }

  /* ---------- sources: the crater vent and breached pockets ---------- */
  function sources(S, st, dt) {
    const w = W(), H = w.H, A = H * H, NX = w.NX, h = st.h, top = w.top;
    for (const vt of st.vents || []) {
      // the lake level = mean surface of the wet lake columns (the vent itself sits at the deepest point)
      const cells = vt.cells, lk = vt.lake;
      let m = 0, n = 0;
      for (let q = 0; q < lk.length; q++) { const c = lk[q]; if (h[c] > L.HMIN) { m += top[c] + h[c]; n++; } }
      m = n ? m / n : -1e9;
      if (m < vt.level) {
        const V = Math.min(L.VENT_Q * dt, n ? (vt.level - m) * A * n : L.VENT_Q * dt), dv = V / cells.length;
        for (let q = 0; q < cells.length; q++) addLava(st, cells[q], dv, 1);
        st.stats.vented += V;
        const c0 = cells[0], c1 = cells[cells.length - 1];
        grow(st, c0 % NX, c1 % NX, Math.floor(c0 / NX), Math.floor(c1 / NX));
      }
    }
    const H3 = H * H * H, NY = w.NY, SXY = NX * NY, jOf = o => Math.floor(o / NX) % NY;
    for (const src of st.sources) {
      if (src.done) continue;
      // LV1: communicating vessels. Lava above the current level (the next cavity voxel's fill level, or the spill
      // level) moves: into the cavity (voxel by voxel, lowest first) or out through the spill point onto the ground
      // (the 2.5D layer). Head-driven (viscous: Q ∝ head above that level).
      while (src.next < src.vox.length && w.mat[src.vox[src.next]] !== MAT.LAVA) src.next++;
      while (src.ci < src.cav.length && w.d[src.cav[src.ci]] > 0) src.ci++;
      if (src.next >= src.vox.length) { finish(src); continue; }
      // spill level: the spill point, or the open lava already standing there (it backs up to the pocket's level)
      const spill = Math.max(src.js, h[src.c] > L.HMIN ? Math.floor((top[src.c] + h[src.c]) / H) : 0);
      const filling = src.ci < src.cav.length, lvl = filling ? src.cavP[src.ci] : spill;
      const jp = jOf(src.vox[src.next]);
      if (filling ? jp <= lvl : lvl > 1e8) { finish(src); continue; }                  // levels equal / nowhere to go
      if (!filling && jp < lvl) continue;                    // backed up: waits (the open lava may flow away and drop)
      src.acc += L.DRAIN_Q * M_clamp((jp - lvl + 1) * H / L.DRAIN_HEAD, 0.15, 2) * dt;
      let bi0 = 1e9, bi1 = -1, bj0 = 1e9, bj1 = -1, bk0 = 1e9, bk1 = -1, out = 0;
      const box = o => { const vi = o % NX, vj = jOf(o), vk = Math.floor(o / SXY); if (vi < bi0) bi0 = vi; if (vi > bi1) bi1 = vi; if (vj < bj0) bj0 = vj; if (vj > bj1) bj1 = vj; if (vk < bk0) bk0 = vk; if (vk > bk1) bk1 = vk; };
      while (src.acc >= H3 && src.next < src.vox.length) {
        const o = src.vox[src.next];
        if (w.mat[o] !== MAT.LAVA) { src.next++; continue; }
        const j = jOf(o);
        while (src.ci < src.cav.length && w.d[src.cav[src.ci]] > 0) src.ci++;
        if (src.ci < src.cav.length) {
          if (j <= src.cavP[src.ci]) { src.acc = 0; break; }
          const q = src.cav[src.ci++];
          w.set_solid(q, 0.6, MAT.LAVA, 250); box(q);
        } else if (src.js < 1e8 && j >= spill) out += H3;                         // (the spill level, also once the cavity just filled)
        else { src.acc = 0; break; }
        w.set_air(o, Math.min(w.d[o], -0.25)); box(o);
        src.next++; src.acc -= H3; src.moved += H3; st.stats.drained += H3;
      }
      if (out > 0) { addLava(st, src.c, out, 1); const i = src.c % NX, k = Math.floor(src.c / NX); grow(st, i, i, k, k); }
      if (bi1 >= 0) w.mark(bi0, bj0, bk0, bi1, bj1, bk1);
    }
  }

  /* A blast that opened voxel lava (a pocket or its vein) turns the connected lava body into a source that drains
   * through the breach: the lowest sky-exposed opened voxel (else the lowest opened one). LV1: only the lava ABOVE
   * the hole drains (the rest stays in the chamber below its level), at a rate ∝ the head above the hole; the lava
   * comes out SIDEWAYS: the source column is the hole's open neighbour (a hole in a cliff face pours onto the ground
   * in front of it, not onto the rock above). */
  function breach(S, st, box) {
    const w = W(), NX = w.NX, NY = w.NY, NZ = w.NZ, SXY = NX * NY, D = w.d, Mt = w.mat, H = w.H;
    if (!st.claimed) st.claimed = new Int32Array(w.N);
    const cl = st.claimed, open = [], sid = st.sources.length + 1;
    const busy = o => cl[o] > 0 && st.sources[cl[o] - 1] && !st.sources[cl[o] - 1].done;   // held by a still-active source
    const i0 = Math.max(1, box.i0 - 1), i1 = Math.min(NX - 2, box.i1 + 1), j0 = Math.max(1, box.j0 - 1), j1 = Math.min(NY - 2, box.j1 + 1);
    const k0 = Math.max(1, box.k0 - 1), k1 = Math.min(NZ - 2, box.k1 + 1);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const o = (k * NY + j) * NX + i;
      if (Mt[o] !== MAT.LAVA || D[o] <= 0 || busy(o)) continue;
      if (D[o - 1] <= 0 || D[o + 1] <= 0 || D[o - NX] <= 0 || D[o + NX] <= 0 || D[o - SXY] <= 0 || D[o + SXY] <= 0) open.push(o);
    }
    if (!open.length) return;
    // connected lava body (6-neighbour flood fill from the opened voxels)
    const vox = [], stack = open.slice();
    for (const o of open) cl[o] = sid;
    while (stack.length && vox.length < 200000) {
      const o = stack.pop();
      vox.push(o);
      const oi = o % NX, oj = Math.floor(o / NX) % NY, ok = Math.floor(o / SXY);
      for (let q = 0; q < 6; q++) {                   // 6 neighbours, never across a row / layer edge (no index wrap)
        if ((q === 0 && oi === 0) || (q === 1 && oi === NX - 1) || (q === 2 && oj === 0) || (q === 3 && oj === NY - 1) || (q === 4 && ok === 0) || (q === 5 && ok === NZ - 1)) continue;
        const n = q === 0 ? o - 1 : q === 1 ? o + 1 : q === 2 ? o - NX : q === 3 ? o + NX : q === 4 ? o - SXY : o + SXY;
        if (cl[n] !== sid && !busy(n) && Mt[n] === MAT.LAVA && D[n] > 0) { cl[n] = sid; stack.push(n); }
      }
    }
    // drain order: top down (ties by index, deterministic)
    vox.sort((a, b) => (Math.floor(b / NX) % NY) - (Math.floor(a / NX) % NY) || a - b);
    let best = -1, bestJ = 1e9, sky = false;
    for (const o of open) {
      const i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / SXY), isSky = j >= w.topJ[k * NX + i];
      if ((isSky && !sky) || (isSky === sky && j < bestJ)) { best = o; bestJ = j; sky = isSky; }
    }
    const bi = best % NX, bk = Math.floor(best / SXY), jOf = o => Math.floor(o / NX) % NY;
    // LV1: where can the lava go? Priority flood over the air reachable from the opened voxels, by fill level
    // p = max(j, parent's p) (the level the lava must reach to get there; buckets per j, deterministic): enclosed
    // air is filled lowest-first (cav); the first open-sky voxel (above its column's top solid) is the spill point.
    const jTop = jOf(vox[0]), seen = new Set(), bk_ = [];
    for (let j = 0; j < NY; j++) bk_.push([]);
    const push = (q, p) => { if (q < 0 || q >= w.N || seen.has(q) || D[q] > 0) return; const qi = q % NX, qk = Math.floor(q / SXY); if (qi < 1 || qk < 1 || qi > NX - 2 || qk > NZ - 2) return; seen.add(q); bk_[Math.max(p, jOf(q))].push(q); };
    for (const o of open) for (const q of [o - 1, o + 1, o - NX, o + NX, o - SXY, o + SXY]) push(q, jOf(o) < jOf(q) ? jOf(q) : jOf(o));
    const cav = [], cavP = [];
    let js = 1e9, sc = bk * NX + bi;
    for (let p = 0; p <= jTop && js > 1e8 && cav.length < 8000; p++) {
      const B = bk_[p];
      for (let n = 0; n < B.length && cav.length < 8000; n++) {
        const q = B[n], qi = q % NX, qk = Math.floor(q / SXY), qj = jOf(q);
        if (qj > w.topJ[qk * NX + qi]) { js = p; sc = qk * NX + qi; break; }
        cav.push(q); cavP.push(p);
        for (const r of [q - 1, q + 1, q - NX, q + NX, q - SXY, q + SXY]) if (jOf(r) <= jTop || r === q - NX) push(r, p);
      }
    }
    const left = vox.length * H * H * H;
    st.sources.push({ c: sc, vox: Int32Array.from(vox), next: 0, cav: Int32Array.from(cav), cavP: Int32Array.from(cavP), ci: 0, js, jb: bestJ, acc: 0, moved: 0, left, done: false });
    if (!st.quiet && SS.sim) SS.sim.emit(S, 'lavabreach', { x: bi * H, y: bestJ * H, z: bk * H, volume: left, cavity: cav.length * H * H * H, spill: js < 1e8 ? { x: (sc % NX) * H, y: js * H, z: Math.floor(sc / NX) * H } : null });
  }

  /* ---------- cave leak: the layer never stands beside open cave air ---------- */
  /* The 2.5D layer only knows each column's bed (its highest solid). When a blast opens a bed into a cave (a river or
   * crater floor over a hollow), the bed drops to the cave floor and the layer would stand in the hole as a free
   * column with cave air beside it (user 2026-10-08 "lava pillar"). This pass finds, per wet column, the lowest
   * lattice level between its bed and its surface where a 4-neighbour is cave air (air under that neighbour's top),
   * caps the column there and pours the excess into the cave as voxel lava, lowest voxels first (it pools on the
   * cave floor). Bounded: at most LEAK_VOX cave voxels are explored per column and pass. Deterministic: fixed scan
   * order, explicit stack, counting sort by level. */
  let lkVox = null, lkSeen = null, lkCnt = null, lkOrd = null;    // scratch (C: static arrays of LEAK_VOX)
  const LK_HASH = 16384;                                          // open-addressing set of visited voxels (> 2 x LEAK_VOX)
  function seenAdd(o) {                                           // true when o was new
    let s = (Math.imul(o, 0x9E3779B1) >>> 18) & (LK_HASH - 1);
    while (lkSeen[s] >= 0) { if (lkSeen[s] === o) return false; s = (s + 1) & (LK_HASH - 1); }
    lkSeen[s] = o; return true;
  }
  function leak(S, st) {
    if (st.i1 < 0) return;
    const w = W(), NX = w.NX, NY = w.NY, NZ = w.NZ, SXY = NX * NY, H = w.H, A = H * H, H3 = A * H;
    const D = w.d, top = w.top, topJ = w.topJ, h = st.h, CAP = L.LEAK_VOX;
    if (!lkVox) { lkVox = new Int32Array(CAP); lkSeen = new Int32Array(LK_HASH); lkCnt = new Int32Array(NY + 1); lkOrd = new Int32Array(CAP); }
    // cave air: an air voxel under its own column's highest solid (inside the lattice, off the border)
    const cave = o => { const i = o % NX, k = Math.floor(o / SXY); return i > 0 && k > 0 && i < NX - 1 && k < NZ - 1 && D[o] <= 0 && Math.floor(o / NX) % NY < topJ[k * NX + i]; };
    for (let k = Math.max(1, st.k0); k <= Math.min(NZ - 2, st.k1); k++) for (let i = Math.max(1, st.i0); i <= Math.min(NX - 2, st.i1); i++) {
      const c = k * NX + i;
      if (h[c] <= L.HMIN) continue;
      const ys = top[c] + h[c], jb = Math.max(1, topJ[c] + 1), je = Math.min(NY - 2, Math.floor(ys / H));
      let jl = -1, seed = -1;
      for (let j = jb; j <= je && jl < 0; j++) {
        const o = (k * NY + j) * NX + i;
        if (cave(o - 1)) seed = o - 1; else if (cave(o + 1)) seed = o + 1; else if (cave(o - SXY)) seed = o - SXY; else if (cave(o + SXY)) seed = o + SXY;
        if (seed >= 0) jl = j;
      }
      if (jl < 0) continue;
      const excess = (ys - jl * H) * A;                 // volume above the opening (it pours sideways)
      if (excess < H3) continue;
      // the cave air reachable from the opening, at or below its level (flood fill, explicit stack in lkOrd)
      lkSeen.fill(-1); let nv = 0, sp = 0;
      seenAdd(seed); lkOrd[sp++] = seed;
      while (sp > 0 && nv < CAP) {
        const o = lkOrd[--sp]; lkVox[nv++] = o;
        const j = Math.floor(o / NX) % NY;
        for (let q = 0; q < 6; q++) {
          const n = q === 0 ? o - 1 : q === 1 ? o + 1 : q === 2 ? o - SXY : q === 3 ? o + SXY : q === 4 ? o - NX : o + NX;
          if (q === 5 && j + 1 > jl) continue;            // never above the opening's level
          if (q === 4 && j < 2) continue;
          if (cave(n) && seenAdd(n) && sp < CAP) lkOrd[sp++] = n;
        }
      }
      // fill lowest first: counting sort of the explored voxels by level j
      lkCnt.fill(0);
      for (let q = 0; q < nv; q++) lkCnt[Math.floor(lkVox[q] / NX) % NY + 1]++;
      for (let j = 1; j <= NY; j++) lkCnt[j] += lkCnt[j - 1];
      for (let q = 0; q < nv; q++) { const j = Math.floor(lkVox[q] / NX) % NY; lkOrd[lkCnt[j]++] = lkVox[q]; }
      const nf = Math.min(nv, Math.floor(excess / H3));
      if (nf <= 0) continue;
      let bi0 = NX, bi1 = -1, bj0 = NY, bj1 = -1, bk0 = NZ, bk1 = -1;
      for (let q = 0; q < nf; q++) {
        const o = lkOrd[q], vi = o % NX, vj = Math.floor(o / NX) % NY, vk = Math.floor(o / SXY);
        w.set_solid(o, 0.6, MAT.LAVA, 250); st.hasVox = true;   // (voxel lava now exists: quenchVox must look)
        if (vi < bi0) bi0 = vi; if (vi > bi1) bi1 = vi; if (vj < bj0) bj0 = vj; if (vj > bj1) bj1 = vj; if (vk < bk0) bk0 = vk; if (vk > bk1) bk1 = vk;
      }
      const V = nf * H3;
      h[c] -= V / A; st.stats.leaked += V;
      w.mark(bi0, bj0, bk0, bi1, bj1, bk1);
    }
  }

  /* ---------- solidification: cold lava becomes CRUST voxels ---------- */
  function bake(S, st) {
    if (st.i1 < 0) return;
    const w = W(), NX = w.NX, NY = w.NY, H = w.H, A = H * H, D = w.d, Mt = w.mat, Ht = w.heat, h = st.h, T = st.T;
    for (let k = st.k0; k <= st.k1; k++) for (let i = st.i0; i <= st.i1; i++) {
      const c = k * NX + i, hc = h[c];
      if (hc <= 0) continue;
      if (hc <= L.HMIN) {   // a film left behind: give it to the deepest wet neighbour (else it is lost)
        let b = -1, bh = L.HMIN;
        if (i > 0 && h[c - 1] > bh) { b = c - 1; bh = h[b]; } if (i < NX - 1 && h[c + 1] > bh) { b = c + 1; bh = h[b]; }
        if (k > 0 && h[c - NX] > bh) { b = c - NX; bh = h[b]; } if (k < w.NZ - 1 && h[c + NX] > bh) { b = c + NX; bh = h[b]; }
        if (b >= 0) addLava(st, b, hc * A, T[c]); else st.stats.lost += hc * A;
        h[c] = 0; T[c] = 0; continue;
      }
      if (T[c] >= L.T_SOLID) continue;
      const y1 = w.top[c] + hc, j0 = Math.max(1, w.topJ[c]), j1 = Math.min(NY - 2, Math.floor(y1 / H) + 1);
      for (let j = j0; j <= j1; j++) {
        const o = (k * NY + j) * NX + i, v = y1 - j * H;
        if (v <= D[o]) continue;
        if (D[o] <= 0 && v > 0) { Mt[o] = st.qn[c] ? MAT.OBSIDIAN : MAT.CRUST; Ht[o] = 0; }   // P31: quenched by water: glass
        D[o] = v;
      }
      w.mark(i, j0, k, i, j1, k);
      st.stats.baked += hc * A; st.stats.bakedCols++; st.qn[c] = 0;
      h[c] = 0; T[c] = 0; st.ux[c] = 0; st.uz[c] = 0;
    }
  }

  /* ---------- P31: water quenching ---------- */
  // a wet neighbour column whose water stands above this column's bed (the water touches the lava's flank)
  function sideWet(wh, wb, c, i, k, NX, NZ, bed, WET) {
    return (i > 0 && wh[c - 1] > WET && wb[c - 1] + wh[c - 1] > bed + 0.05) || (i < NX - 1 && wh[c + 1] > WET && wb[c + 1] + wh[c + 1] > bed + 0.05) ||
      (k > 0 && wh[c - NX] > WET && wb[c - NX] + wh[c - NX] > bed + 0.05) || (k < NZ - 1 && wh[c + NX] > WET && wb[c + NX] + wh[c + NX] > bed + 0.05);
  }
  /* Voxel lava (pockets, a drained pocket's cavity fill) touching water: every lava voxel face-adjacent to a water-
   * filled lattice cell (air under the water surface of a wet column) turns into OBSIDIAN. QV_ROWS rows per call
   * (round robin), one voxel deep: the glass skin seals the melt behind it. The water boils off a little and the
   * contact hisses (st.hiss) for STEAM_T s. */
  function quenchVox(S, st) {
    const ws = S.water; if (!st.hasVox || !ws) return;
    const w = W(), NX = w.NX, NY = w.NY, NZ = w.NZ, SXY = NX * NY, H = w.H, D = w.d, Mt = w.mat, Ht = w.heat;
    const wh = ws.h, bed = ws.bed || ws.b, WET = C.WATER ? C.WATER.WET : 0.004;
    const kA = st.qRow, kB = Math.min(NZ - 2, kA + L.QV_ROWS - 1);
    st.qRow = kB >= NZ - 2 ? 1 : kB + 1;
    let n = 0, sx = 0, sy = 0, sz = 0, bi0 = 1e9, bi1 = -1, bj0 = 1e9, bj1 = -1, bk0 = 1e9, bk1 = -1;
    for (let k = Math.max(1, kA); k <= kB; k++) for (let i = 1; i < NX - 1; i++) {
      const c = k * NX + i; if (wh[c] <= WET) continue;
      const ys = bed[c] + wh[c], jb = Math.max(1, Math.floor(bed[c] / H) - 1), je = Math.min(NY - 2, Math.floor(ys / H));
      for (let j = jb; j <= je; j++) {
        const o = (k * NY + j) * NX + i; if (D[o] > 0) continue;              // a water-filled cell (air under the surface)
        for (let q = 0; q < 6; q++) {
          const nb = q === 0 ? o - 1 : q === 1 ? o + 1 : q === 2 ? o - NX : q === 3 ? o + NX : q === 4 ? o - SXY : o + SXY;
          if (Mt[nb] !== MAT.LAVA || D[nb] <= 0) continue;
          Mt[nb] = MAT.OBSIDIAN; Ht[nb] = 0; n++;
          const ni = nb % NX, nj = Math.floor(nb / NX) % NY, nk = Math.floor(nb / SXY);
          if (ni < bi0) bi0 = ni; if (ni > bi1) bi1 = ni; if (nj < bj0) bj0 = nj; if (nj > bj1) bj1 = nj; if (nk < bk0) bk0 = nk; if (nk > bk1) bk1 = nk;
          sx += ni * H; sy += ys; sz += nk * H;
          wh[c] = Math.max(0, wh[c] - L.QV_BOIL);                                 // boiled off
        }
      }
    }
    if (!n) return;
    w.mark(bi0, bj0, bk0, bi1, bj1, bk1); ws.ver++;
    st.stats.quenched = (st.stats.quenched || 0) + n;
    if (st.hiss.length >= L.HISS_MAX) st.hiss.shift();
    st.hiss.push({ x: sx / n, y: sy / n, z: sz / n, t: L.STEAM_T, p: Math.min(6, 1 + n * 0.5), next: 0 });
  }
  // the steam of fresh quench contacts: a 'steam' event every 0.3 s while it lasts, fading
  function hiss(S, st, dt) {
    for (let q = st.hiss.length - 1; q >= 0; q--) {
      const e = st.hiss[q]; e.t -= dt; e.next -= dt;
      if (e.t <= 0) { st.hiss.splice(q, 1); continue; }
      if (e.next <= 0) { e.next = 0.3; if (!st.quiet && SS.sim) SS.sim.emit(S, 'steam', { x: e.x, y: e.y, z: e.z, power: e.p * (0.3 + 0.7 * e.t / L.STEAM_T) }); }
    }
  }

  /* ---------- blasts ---------- */
  LV.blast = function (S, c, Wkg) {
    const st = S.lava;
    if (!st) return;
    if (S.lastCrater) breach(S, st, S.lastCrater);
    const w = W(), NX = w.NX, NZ = w.NZ, H = w.H, A = H * H, h = st.h, T = st.T, top = w.top;
    const R = L.SPLASH_K * SS.blast.crater_radius(MAT.LAVA, Wkg), R2 = 1.8 * R;
    const i0 = Math.max(0, Math.floor((c.x - R2) / H)), i1 = Math.min(NX - 1, Math.ceil((c.x + R2) / H));
    const k0 = Math.max(0, Math.floor((c.z - R2) / H)), k1 = Math.min(NZ - 1, Math.ceil((c.z + R2) / H));
    let Vs = 0, Es = 0;
    const ring = [];
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const q = k * NX + i, d = M.len2(i * H - c.x, k * H - c.z);
      if (d < R) {
        if (h[q] > 0 && Math.abs(top[q] + h[q] - c.y) < R) { const f = 1 - (d / R) * (d / R), V = h[q] * f * A; h[q] -= V / A; Vs += V; Es += V * T[q]; }
      } else if (d < R2 && Math.abs(top[q] - c.y) < R2) ring.push(q);
    }
    if (Vs <= 0) return;
    st.stats.splashed += Vs;
    // LV4: part of it flies as glowing clots (sim/spatter.js); the rest lands as the near ring sheet
    if (!st.quiet && SS.spatter) { const Vb = SS.spatter.spawn(S, c, Wkg, Vs, Es / Vs, R); Es *= 1 - Vb / Vs; Vs -= Vb; }
    if (ring.length && Vs > 1e-9) {
      const dv = Vs / ring.length, Tin = 0.85 * Es / Vs;     // spatter cools in flight
      for (const q of ring) addLava(st, q, dv, Tin);
      grow(st, i0, i1, k0, k1);
    } else st.stats.lost += Vs;
    if (!st.quiet && SS.sim) SS.sim.emit(S, 'lavasplash', { x: c.x, y: c.y, z: c.z, volume: Vs, R });
  };

  /* LV4: a clot of V m3 at lava temperature Tin falls back into (or is remelted by) the lava at x, z */
  LV.deposit = function (S, x, z, V, Tin) {
    const st = S.lava, w = W(); if (!st || w.outside(x, z) || !(V > 0)) return;
    const i = Math.min(w.NX - 1, Math.max(0, Math.round(x / w.H))), k = Math.min(w.NZ - 1, Math.max(0, Math.round(z / w.H)));
    addLava(st, k * w.NX + i, V, Tin); grow(st, i, i, k, k);
  };

  /* ---------- queries ---------- */
  function bil(S, arr, x, z) {
    const w = W(), NX = w.NX, NZ = w.NZ, H = w.H;
    const fx = Math.max(0, Math.min(NX - 1.001, x / H)), fz = Math.max(0, Math.min(NZ - 1.001, z / H));
    const i = Math.floor(fx), k = Math.floor(fz), u = fx - i, v = fz - k, c = k * NX + i;
    return (arr[c] * (1 - u) + arr[c + 1] * u) * (1 - v) + (arr[c + NX] * (1 - u) + arr[c + NX + 1] * u) * v;
  }
  LV.depth_at = (S, x, z) => (S.lava && !W().outside(x, z) ? bil(S, S.lava.h, x, z) : 0);   // none beyond the lattice (dry far dunes, D4)
  LV.surface_at = function (S, x, z) { const d = LV.depth_at(S, x, z); return d > 0.01 ? W().top_at(x, z) + d : -1; };
  LV.temp_at = (S, x, z) => (S.lava ? bil(S, S.lava.T, x, z) : 0);
  LV.vel_at = function (S, x, z, out) { out.x = S.lava ? bil(S, S.lava.ux, x, z) : 0; out.z = S.lava ? bil(S, S.lava.uz, x, z) : 0; return out; };
  LV.stats = function (S) {
    const st = S.lava;
    if (!st) return null;
    const NX = W().NX, A = W().H * W().H;
    let vol = 0, cells = 0, Tsum = 0;
    for (let k = Math.max(0, st.k0); k <= st.k1; k++) for (let i = st.i0; i <= st.i1; i++) { const c = k * NX + i; if (st.h[c] > 0) { vol += st.h[c] * A; cells++; Tsum += st.T[c] * st.h[c] * A; } }
    return Object.assign({ vol, cells, Tmean: vol > 0 ? Tsum / vol : 0, sources: st.sources.length, box: [st.i0, st.i1, st.k0, st.k1] }, st.stats);
  };
})(window.SS = window.SS || {});
