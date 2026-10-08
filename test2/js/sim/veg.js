/* sim/veg.js — surface vegetation and grass fire (portable, deterministic; no DOM / Three.js).
 *
 * One cell per lattice column (193 x 193, 0.5 m). S.veg.surf is the presentation map the renderer uploads when
 * surfVer changes (Uint8 RGBA: r = grass cover, g = dryness, b = char, a = burning intensity); fuel / burnT / burnI
 * are the simulation state. Cover grows on soil (a little on scree / ash) above the shore, broken up by noise;
 * dryness = biome base + noise.
 * Fire automaton every C.FIRE_TICK (0.1 s) over the list of burning cells: each burning cell heats each of its 8
 * neighbours by v dt / dist, v = SPREAD_V * f(dry) * fuel * I * exp(WIND_K * dot(dir, wind)) * phi(slope), phi =
 * 1 + SLOPE_K tan^2 uphill (Rothermel), 1 / (1 + SLOPE_K tan^2 / 3) downhill (faster downwind and uphill, a slow
 * backing fire upwind, green grass does not carry a fire); a cell
 * ignites when its heat passes a per-cell threshold 0.75..1.25 (position hash) -> coherent fronts, no random holes,
 * no RNG draws. A cell burns BURN_T * (0.5 + 0.5 fuel) s and turns to char (no re-ignition). Water (S.water) and bare
 * rock stop it; rain (S.weather.rain) damps it. Blast hooks run after the crater is carved: they measure heights
 * from top0 (the ground before this step's edits) and skip freshly carved columns.
 * Inputs: fireballs (blast.js -> ignite), burning props and oil rings (scatter.js), hot lava (S.lava); outputs: worm damage (fire_at),
 * props ignited by the flames, events 'grassfire'. Edited columns (craters, re-baked rubble) lose their grass.
 *
 * C layout: struct Veg { i32 n; u8 *surf; f32 *fuel, *burnT, *burnI, *heat, *thr, *top0; i32 *act, *nxt, nAct;
 *   f32 acc; u32 tick, surfVer; }.
 * API: init(S), step(S, dt), ignite(S, c, r), blast(S, c, W), fire_at(S, x, y, z), burning(S) (cell count),
 *   cell(S, x, z).
 */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, K = C.VEG;
  const VG = SS.veg = {};
  const W = () => SS.world;
  const ZERO = { x: 0, y: 0, z: 0 };
  let dirty = null;
  // the pending edit rect is sim state outside S: sim.snapshot / restore carry it (bit-identical replays)
  VG.dirty_get = () => (dirty ? { i0: dirty.i0, k0: dirty.k0, i1: dirty.i1, k1: dirty.k1 } : null);
  VG.dirty_set = d => { dirty = d ? { i0: d.i0, k0: d.k0, i1: d.i1, k1: d.k1 } : null; };
  function onMark(i0, k0, i1, k1) {
    if (!dirty) dirty = { i0, k0, i1, k1 };
    else { dirty.i0 = Math.min(dirty.i0, i0); dirty.k0 = Math.min(dirty.k0, k0); dirty.i1 = Math.max(dirty.i1, i1); dirty.k1 = Math.max(dirty.k1, k1); }
  }
  const fdry = d => M.smoothstep(K.DRY0, K.DRY1, d);

  VG.init = function (S) {
    const w = W(), n = w.NX, N = n * w.NZ, MAT = C.MAT;
    if (w.listeners.indexOf(onMark) < 0) w.listeners.push(onMark);
    dirty = null;
    const st = S.veg = { n, surf: new Uint8Array(N * 4), fuel: new Float32Array(N), burnT: new Float32Array(N), burnI: new Float32Array(N),
      heat: new Float32Array(N), thr: new Float32Array(N), top0: new Float32Array(N), act: new Int32Array(N), nxt: new Int32Array(N), nAct: 0, acc: 0, tick: 0, surfVer: 1, logT: -9, stats: { ignited: 0, burnt: 0 } };
    const seed = (S.settings.seed | 0) * 17 + 5;
    const dryBase = K.DRY_BASE[S.biome] !== undefined ? K.DRY_BASE[S.biome] : 0.2;
    for (let k = 0; k < w.NZ; k++) for (let i = 0; i < n; i++) {
      const c = k * n + i, j = w.topJ[c], x = i * w.H, z = k * w.H;
      let cover = 0;
      if (j > 0 && w.top[c] > w.SEA + 0.5) {
        const m = w.mat[(k * w.NY + j) * w.NX + i];
        cover = m === MAT.SOIL ? 1 : m === MAT.SCREE ? 0.12 : m === MAT.ASH ? 0.06 : 0;
        cover *= M.smoothstep(0.28, 0.5, M.fbm2(x / 9, z / 9, seed, 3));
      }
      const dry = M.clamp(dryBase + (M.fbm2(x / 14, z / 14, seed + 3, 3) - 0.5) * 0.7, 0, 1);
      st.surf[c * 4] = cover * 255; st.surf[c * 4 + 1] = dry * 255;
      st.fuel[c] = cover; st.top0[c] = w.top[c];
      st.thr[c] = 0.75 + 0.5 * M.hash4(i, k, seed, 31);
    }
  };

  function wet(S, c) { return S.water && S.water.h[c] > 0.004; }
  function igniteCell(S, st, c, I) {
    if (st.burnT[c] > 0 || st.fuel[c] < 0.05 || st.surf[c * 4 + 2] > 128 || wet(S, c)) return false;
    st.burnT[c] = K.BURN_T * (0.5 + 0.5 * st.fuel[c]);
    st.burnI[c] = I;
    st.act[st.nAct++] = c;
    st.surf[c * 4 + 3] = Math.round(255 * I);
    st.stats.ignited++;
    return true;
  }
  /* fireball at c (radius r): its heat ignites dry fuel within HEAT_K r on the ground near c.y (beyond the crater
   * rim), scorches green grass; intensity falls off with distance */
  VG.ignite = function (S, c, rf) {
    const st = S.veg, w = W(); if (!st) return 0;
    const r = rf * K.HEAT_K, H = w.H, n = st.n;
    if (SS.trees) SS.trees.heat_burst(S, c, r);
    const i0 = Math.max(0, Math.floor((c.x - r) / H)), i1 = Math.min(n - 1, Math.ceil((c.x + r) / H));
    const k0 = Math.max(0, Math.floor((c.z - r) / H)), k1 = Math.min(n - 1, Math.ceil((c.z + r) / H));
    let lit = 0;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const q = k * n + i, d = M.len2(i * H - c.x, k * H - c.z);
      if (d > r || Math.abs(st.top0[q] - c.y) > rf + 0.6 || Math.abs(w.top[q] - st.top0[q]) > 0.2 || st.fuel[q] < 0.05) continue;
      const dry = st.surf[q * 4 + 1] / 255;
      if (dry >= K.IGNITE_DRY) { if (igniteCell(S, st, q, (0.4 + 0.6 * fdry(dry)) * (1 - 0.4 * d / r))) lit++; }
      else st.surf[q * 4 + 2] = Math.min(255, st.surf[q * 4 + 2] + Math.round(110 * (1 - d / r)));   // green grass: scorched only
    }
    st.surfVer++;
    if (lit) {
      SS.sim.emit(S, 'grassfire', { x: c.x, y: w.top_at(c.x, c.z), z: c.z, cells: lit });
      if (S.time - st.logT > 4) { st.logT = S.time; SS.sim.log(S, 'The dry grass catches fire!', 0xffb060); }
    }
    return lit;
  };
  /* burning debris / embers: lights the dry-enough fuel in a disc on the ground near y */
  VG.ignite_disc = function (S, x, y, z, r, I) {
    const st = S.veg, w = W(); if (!st) return 0;
    const H = w.H, n = st.n, i0 = Math.max(0, Math.floor((x - r) / H)), i1 = Math.min(n - 1, Math.ceil((x + r) / H));
    const k0 = Math.max(0, Math.floor((z - r) / H)), k1 = Math.min(n - 1, Math.ceil((z + r) / H));
    let lit = 0;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const q = k * n + i;
      if (M.len2(i * H - x, k * H - z) > r || Math.abs(w.top[q] - y) > 1.5 || st.surf[q * 4 + 1] / 255 < K.IGNITE_DRY) continue;
      if (igniteCell(S, st, q, I)) lit++;
    }
    if (lit) st.surfVer++;
    return lit;
  };
  /* blast: flattens and tears the grass around the burst; trees take the wave (trees.js) */
  VG.blast = function (S, c, Wkg) {
    if (SS.trees) SS.trees.blast(S, c, Wkg);
    const st = S.veg, w = W(); if (!st) return;
    const R = K.STRIP_R * M.cbrt(Wkg), H = w.H, n = st.n;
    const i0 = Math.max(0, Math.floor((c.x - R) / H)), i1 = Math.min(n - 1, Math.ceil((c.x + R) / H));
    const k0 = Math.max(0, Math.floor((c.z - R) / H)), k1 = Math.min(n - 1, Math.ceil((c.z + R) / H));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const q = k * n + i, d = M.len3(i * H - c.x, k * H - c.z, (st.top0[q] - c.y) * 0.7);
      if (d >= R) continue;
      const keep = 0.3 + 0.7 * M.smoothstep(0.35 * R, R, d);
      st.surf[q * 4] = Math.round(st.surf[q * 4] * keep);
    }
    ejecta(S, st, w, c, R);
    st.surfVer++;
  };
  /* the crater's spoil is thrown over the ground around it and buries the turf: the ground there shows the dug-up
   * soil, not grass. Crater = columns within R lowered by more than EJECTA_D since the step began (top0: this hook runs
   * after the carve, before the refresh); Rc = equivalent radius; thickness t(r) = EJECTA_K Rc^0.74 (r / Rc)^-3 beyond
   * the rim, clumpy (x 0.4..1.6 per cell); cover x exp(-t / EJECTA_T), fuel x exp(-t / EJECTA_FUEL_T) (clods: stems
   * between them still burn). No crater (air burst) = no spoil. */
  function ejecta(S, st, w, c, R) {
    const H = w.H, n = st.n;
    let i0 = Math.max(0, Math.floor((c.x - R) / H)), i1 = Math.min(n - 1, Math.ceil((c.x + R) / H));
    let k0 = Math.max(0, Math.floor((c.z - R) / H)), k1 = Math.min(n - 1, Math.ceil((c.z + R) / H));
    let nC = 0;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const q = k * n + i;
      if (M.len2(i * H - c.x, k * H - c.z) < R && st.top0[q] - w.top[q] > K.EJECTA_D) nC++;
    }
    if (nC < 2) return;
    const Rc = Math.sqrt(nC / Math.PI) * H, t0 = K.EJECTA_K * M.pow(Rc, 0.74), Re = K.EJECTA_R * Rc;
    i0 = Math.max(0, Math.floor((c.x - Re) / H)); i1 = Math.min(n - 1, Math.ceil((c.x + Re) / H));
    k0 = Math.max(0, Math.floor((c.z - Re) / H)); k1 = Math.min(n - 1, Math.ceil((c.z + Re) / H));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const q = k * n + i, r = M.len2(i * H - c.x, k * H - c.z);
      if (r > Re || st.surf[q * 4] === 0 && st.fuel[q] === 0) continue;
      if (Math.abs(w.top[q] - c.y) > Re) continue;                    // ground far above / below the burst (cliffs, caves)
      const rr = Math.max(r, Rc), t = t0 * M.pow(Rc / rr, 3) * (0.4 + 1.2 * M.hash3(i, k, 77));
      st.surf[q * 4] = Math.round(st.surf[q * 4] * M.exp(-t / K.EJECTA_T)); st.fuel[q] *= M.exp(-t / K.EJECTA_FUEL_T);
    }
  }

  /* edited columns: dug or buried ground has no grass */
  function refresh(S, st, w) {
    const n = st.n, i0 = Math.max(0, dirty.i0), k0 = Math.max(0, dirty.k0), i1 = Math.min(n - 1, dirty.i1), k1 = Math.min(w.NZ - 1, dirty.k1);
    dirty = null;
    if (SS.trees) SS.trees.on_edit(S, i0, k0, i1, k1);
    let ch = false;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const c = k * n + i;
      if (Math.abs(w.top[c] - st.top0[c]) <= C.VEG.CLEAR_D) continue;
      st.top0[c] = w.top[c]; st.surf[c * 4] = 0; st.surf[c * 4 + 2] = 0; st.surf[c * 4 + 3] = 0; st.fuel[c] = 0; st.burnT[c] = 0; st.heat[c] = 0;
      ch = true;
    }
    if (ch) st.surfVer++;
  }

  function tick(S, st) {
    const w = W(), n = st.n, H = w.H, TK = C.FIRE_TICK, top = w.top, surf = st.surf;
    const wind = (S.wind && S.wind.mean) || ZERO, rain = S.weather ? (S.weather.rain || 0) : 0;
    const damp = S.weather ? Math.max(rain, S.weather.wet || 0) : 0;                 // soaked fuel spreads like rain
    const douse = rain > K.RAIN_OUT ? 6 * (rain - 0.4) : 0;
    st.tick++;
    let m = 0;
    const nxt = st.nxt, act = st.act, nOld = st.nAct;
    // spread first (from the cells burning at the start of the tick), then age them
    for (let a = 0; a < nOld; a++) {
      const c = act[a]; if (st.burnT[c] <= 0) continue;
      const i = c % n, k = (c / n) | 0, I = st.burnI[c];
      for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
        if (!di && !dk) continue;
        const ii = i + di, kk = k + dk; if (ii < 0 || kk < 0 || ii >= n || kk >= n) continue;
        const q = kk * n + ii; if (st.burnT[q] > 0 || st.fuel[q] < 0.05 || surf[q * 4 + 2] > 128) continue;
        const dist = (di && dk ? 1.4142 : 1) * H, ux = di * H / dist, uz = dk * H / dist;
        const slope = M.clamp((top[q] - top[c]) / dist, -1, 1.5);
        const fd = fdry(surf[q * 4 + 1] / 255);
        const fs = slope > 0 ? 1 + K.SLOPE_K * slope * slope : 1 / (1 + K.SLOPE_K * slope * slope / 3);
        const v = K.SPREAD_V * fd * st.fuel[q] * I * fs * M.exp(K.WIND_K * (ux * wind.x + uz * wind.z)) * (1 - 0.9 * damp);
        if (v <= 0) continue;
        st.heat[q] += v * TK / dist;
        if (st.heat[q] >= st.thr[q]) igniteCell(S, st, q, 0.35 + 0.65 * fd * st.fuel[q]);
      }
    }
    // the cells lit just now were appended to act[nOld..]; age everything and compact into nxt
    for (let a = 0; a < st.nAct; a++) {
      const c = act[a]; if (st.burnT[c] <= 0) continue;
      let t = st.burnT[c];
      if (a < nOld) { t -= TK * (1 + 3 * rain + douse); st.fuel[c] = Math.max(0, st.fuel[c] - TK / K.BURN_T); }
      if (wet(S, c) || t <= 0) {
        const out = wet(S, c) || douse > 0;                // put out (water, heavy rain): partly charred, not burnt out
        st.burnT[c] = 0; surf[c * 4 + 3] = 0; surf[c * 4 + 2] = out ? Math.max(surf[c * 4 + 2], 90) : 255; st.fuel[c] = 0; st.stats.burnt++;
        continue;
      }
      st.burnT[c] = t;
      surf[c * 4 + 3] = Math.round(255 * st.burnI[c] * Math.min(1, t / 0.6));
      nxt[m++] = c;
    }
    st.nxt = act; st.act = nxt; st.nAct = m;
    // burning props and oil rings light the grass under them; flames light props standing in them
    for (const b of S.bodies) {
      if (!b.prop) continue;
      const q = M.clamp(Math.round(b.pos.z / H), 0, n - 1) * n + M.clamp(Math.round(b.pos.x / H), 0, n - 1);
      const onGround = b.pos.y - top[q] < b.rb + 0.4;
      if (b.burn >= 0 && onGround) igniteCell(S, st, q, 0.8);
      else if (st.burnT[q] > 0 && onGround && SS.scatter && SS.scatter.ignite) SS.scatter.ignite(S, b);
    }
    for (const f of S.flames) {
      const r = f.r * 0.8, i0 = Math.max(0, Math.floor((f.x - r) / H)), i1 = Math.min(n - 1, Math.ceil((f.x + r) / H));
      const k0 = Math.max(0, Math.floor((f.z - r) / H)), k1 = Math.min(n - 1, Math.ceil((f.z + r) / H));
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (M.len2(i * H - f.x, k * H - f.z) < r && Math.abs(top[k * n + i] - f.y) < 1) igniteCell(S, st, k * n + i, 0.9);
    }
    // hot lava lights dry grass in and next to its cells, and chars green grass under it (every 0.5 s)
    const lv = S.lava;
    if (lv && st.tick % 5 === 0 && lv.i1 >= lv.i0) {
      let ch = false;
      for (let k = Math.max(1, lv.k0 - 1); k <= Math.min(n - 2, lv.k1 + 1); k++) for (let i = Math.max(1, lv.i0 - 1); i <= Math.min(n - 2, lv.i1 + 1); i++) {
        const c = k * n + i; if (!(lv.h[c] > 0.02 && lv.T[c] > 0.3)) continue;
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
          const q = c + dk * n + di; if (st.fuel[q] < 0.05 || st.burnT[q] > 0 || surf[q * 4 + 2] > 128) continue;
          if (surf[q * 4 + 1] / 255 >= K.IGNITE_DRY) igniteCell(S, st, q, 0.9);
          else if (q === c) { surf[q * 4 + 2] = 255; st.fuel[q] = 0; ch = true; }
        }
      }
      if (ch) st.surfVer++;
    }
    if (SS.trees) SS.trees.tick(S, TK);
    if (nOld || m) st.surfVer++;
  }

  VG.step = function (S, dt) {
    const st = S.veg; if (!st) return;
    if (dirty) refresh(S, st, W());
    st.acc += dt;
    while (st.acc >= C.FIRE_TICK - 1e-9) { st.acc -= C.FIRE_TICK; tick(S, st); }
  };

  VG.cell = function (S, x, z) { const st = S.veg, w = W(); return M.clamp(Math.round(z / w.H), 0, st.n - 1) * st.n + M.clamp(Math.round(x / w.H), 0, st.n - 1); };
  /* flame intensity (0..1) at a point near the ground (the worm's centre): max over the 3x3 columns around it */
  VG.fire_at = function (S, x, y, z) {
    const st = S.veg, w = W(), It = SS.trees ? SS.trees.fire_at(S, x, y, z) : 0; if (!st || !st.nAct) return It;
    const n = st.n, i = Math.round(x / w.H), k = Math.round(z / w.H);
    let I = 0;
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, kk = k + dk; if (ii < 0 || kk < 0 || ii >= n || kk >= n) continue;
      const q = kk * n + ii; if (st.burnT[q] <= 0) continue;
      const h = y - w.top[q]; if (h < -0.5 || h > K.FIRE_H) continue;
      I = Math.max(I, st.burnI[q]);
    }
    return Math.max(I, It);
  };
  VG.burning = S => (S.veg ? S.veg.nAct : 0);
})(window.SS = window.SS || {});
