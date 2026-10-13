/* sim/fort.js — P68b: fort mode (settings.fort, default off; user 2026-10-11: "fort mode where if enabled the generated map should
 * have X teams' visible sides and the worms of each team are placed on separated chunks, with at least one bunker with a worm inside;
 * water map = islands, desert = mountains, etc.").
 * Portable, deterministic: world arrays, F (the generator's features) and S only; its own hashes / noise (SS.math), no RNG stream.
 * One layout rule for every biome: the map is cut into one CELL per team (Voronoi cells of n anchors, the cell borders wobbled by a
 * domain warp), the cells are separated by a CHANNEL of half-width hw along the cell borders, and each cell is one fort.
 *   3D: the anchors sit on a ring about the map centre (2 teams: left and right), the rotation is the best of a few candidates
 *       (balanced land area per cell). 2D: the anchors sit on the line z = slice at even spacing, so the cut slice shows n forts.
 *   per-fort balancing: every cell's mean land height is pulled toward the common mean (the lift, at most 4 m up / 3 m down).
 * What the channel is (kind, per biome, profile = floor + max(0, gd - hw) * bank, gd = the distance to the cell border):
 *   sea    temperate / canyon / alpine: a sea channel down to y 1.3 (islands; alpine: icy water, no ice shelf, it would bridge it)
 *   chasm  desert: tall mesas (flat tops 11-16 m) over a sand-floored chasm down to y 1.4 (a fall is the hazard); fades out beyond the
 *          play circle (hot sand there), so the way around costs HP
 *   lava   volcanic (no cones in fort mode): basalt crags over a lava river bed at SEA + 1.2 filled to 1.1 m (F.lavaInit, lavaZone)
 *   pit    underground: n halls (flat-floored chambers, 10 m of room) without tunnels between them, each opening through a short mouth
 *          into one shared pit (hub in 3D, a pit between every neighbour pair in 2D) that falls to the bedrock: crossing = rope / jump
 * Bunkers: every fort gets one bunker (sim/bunker.js build) on a flat pad (the heightfield is flattened under it before the volume
 * fill), the embrasure toward the nearest enemy fort; worm id t (the first of team t) starts inside it. 2D: the bunker is the cross
 * section at the slab's plane (bunker.js stamp, w.flat). The other worms spawn on their own cell (find_spot opts.team).
 * Rules that stay: no steel bridges, no derelict / ruins stamps, spires and rock bridges never cross a channel.
 * Hooks (shared files): worldgen G.begin (layout), setupVolcanoes (no cones), stage 0 (shape), landmarks (keep_out, span_ok), fill (ledge / cave filter, chasm undercut),
 * underPlan, stampIceShelf call; sim.js find_spot / caveSpot / unbury_worms / initState / hash; game.js begin_placement / place_point / autoSpot; dim2d.pick_slice; bunker.js build + the
 * 2D stamp; the CPU's way out of a chasm / pit: aib.js prep / spotValue, aic.js spotFree, weapons.js open_air.
 * C mapping: struct Fort { u8 n, line, under, kind; f32 ax[4], az[4], hw, bank, floor, lean, span, sliceZ, lift[4]; Site sites[4]; Hall halls[4]; Pit pits[4]; i32 npits; };
 *   struct Site { f32 x, z, y, phi, r; }; bool fort_on(const Settings*); void fort_layout(World*, Features*, ...); void fort_shape(World*, f32 *hgt, ...);
 *   i8 fort_team_at(f32 x, f32 z, f32 y); void fort_populate(Game*, Taken*). Every loop is over fixed arrays.
 * API: on(settings), is(), of(), layout(W, F, st, biome, seed), shape(W, hgt, F, seed, lz), under_plan(W, F), cell(f, x, z, out), team_at(x, z, y), spot_ok(x, z, y, team),
 *      seat(team), keep_out(x, z, gapPad, sitePad), span_ok(xa, za, xb, zb), undercut_col(x, z), undercut(f, gd, y), trapped(x, z, y), populate(S, taken). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT, B = C.BUNKER;
  const FT = SS.fort = {};
  const W = () => SS.world;
  const sat = M.sat, sm = M.smooth, clamp = M.clamp;
  const K = FT.K = { GAP3: 4.8, GAP3_N: 4.4, GAP2: 3.0, GAP2_4: 2.4, WARP: 3.0, MOUND_R: 10, SITE_STEP: 2, UNDER_R: 25, PIT3_R: 8, HALL_RY: 6.2, MOUTH_R: 2.7, LEAN: 2.6 };
  /* per biome: channel kind, bed height (null = set from the sea), bank slope (m / m), half-width factor */
  const PROF = {
    temperate: { kind: 'sea', floor: 1.3, bank: 2.2, hwk: 1 },
    canyon: { kind: 'sea', floor: 1.3, bank: 2.2, hwk: 1 },
    alpine: { kind: 'sea', floor: 1.3, bank: 2.6, hwk: 1 },
    desert: { kind: 'chasm', floor: 1.4, bank: 14, hwk: 1.15 },
    volcanic: { kind: 'lava', floor: -1, bank: 2.4, hwk: 1 },
    beach: { kind: 'sea', floor: 1.3, bank: 2.2, hwk: 1 }
  };

  FT.on = st => !!st && !!st.fort && st.fort !== '0' && st.fort !== 'off';
  FT.of = () => { const F = W().features; return F && F.fort ? F.fort : null; };
  FT.is = () => !!FT.of();

  /* ---------- layout ---------- */
  function anchors(f, w, rot) {
    const n = f.n;
    if (f.line) {
      const m = f.under ? 8 : 0, S = (w.SX - 2 * m) / n;                    // (the cells tile the whole width: the end forts are not larger than the middle ones)
      for (let t = 0; t < n; t++) { f.ax[t] = m + S * (t + 0.5); f.az[t] = f.sliceZ; }
      f.span = S;
    } else {
      const R = f.under ? K.UNDER_R : 0.45 * w.PR;
      for (let t = 0; t < n; t++) { const a = rot + Math.PI + t * M.TAU / n; f.ax[t] = w.MX + M.cos(a) * R; f.az[t] = w.MZ + M.sin(a) * R; }
      f.span = M.TAU * R / n;
    }
    f.rot = rot;
  }
  FT.layout = function (w, F, st, biome, seed) {
    if (!FT.on(st)) return null;
    const n = clamp(st.teams | 0 || 2, 2, 4), line = st.dim === '2d', P = PROF[biome] || PROF.temperate;
    const f = { n, line, under: !!w.under, biome, kind: w.under ? 'pit' : P.kind, seed: seed | 0, sliceZ: w.MZ, ax: [0, 0, 0, 0], az: [0, 0, 0, 0], rot: 0, span: 0,
      hw: 0, bank: P.bank, floor: P.floor < 0 ? w.SEA + 1.2 : P.floor, dry: !!w.dry, sites: [], halls: [], pits: [], lift: [0, 0, 0, 0] };
    f.lean = line && n > 3 ? 1.8 : K.LEAN;
    f.hw = (line ? (n > 3 ? K.GAP2_4 : K.GAP2) : (n > 2 ? K.GAP3_N : K.GAP3)) * P.hwk;
    anchors(f, w, 0);
    return f;
  };

  /* the cell of a point: team (nearest anchor of the warped point) and gd (the distance to the border with the next cell, m) */
  const cellOut = { team: 0, gd: 0 };
  function cell(f, x, z, o) {
    if (f.line) z = f.sliceZ;
    const sd = f.seed, nx = x + K.WARP * 2 * (M.noise2(x / 17, z / 17, sd + 601) - 0.5), nz = z + K.WARP * 2 * (M.noise2(x / 17 + 31, z / 17 + 17, sd + 602) - 0.5);
    let bi = 0, bd = 1e18;
    for (let t = 0; t < f.n; t++) { const dx = nx - f.ax[t], dz = nz - f.az[t], d = dx * dx + dz * dz; if (d < bd) { bd = d; bi = t; } }
    let g = 1e9;
    for (let t = 0; t < f.n; t++) {
      if (t === bi) continue;
      const dx = nx - f.ax[t], dz = nz - f.az[t], L = M.len2(f.ax[t] - f.ax[bi], f.az[t] - f.az[bi]);
      const e = (dx * dx + dz * dz - bd) / (2 * L);
      if (e < g) g = e;
    }
    o.team = bi; o.gd = g;
    return o;
  }
  FT.cell = (f, x, z, o) => cell(f, x, z, o || cellOut);

  /* the team owning ground at (x, z[, y]): -1 in a channel / a pit. Surface maps: the cell outside the channel's middle; caves: the hall's cell outside the pits */
  function teamAt(f, x, z, y) {
    if (f.under) {
      for (let q = 0; q < f.pits.length; q++) { const p = f.pits[q]; if (M.len2(x - p.x, f.line ? 0 : z - p.z) < p.r + 0.5) return -1; }
      let bi = 0, bd = 1e18;
      for (let t = 0; t < f.n; t++) { const dx = x - f.ax[t], dz = f.line ? 0 : z - f.az[t], d = dx * dx + dz * dz; if (d < bd) { bd = d; bi = t; } }
      return bi;
    }
    cell(f, x, z, cellOut);
    return cellOut.gd > f.hw * 0.5 ? cellOut.team : -1;
  }
  FT.team_at = (x, z, y) => { const f = FT.of(); return f ? teamAt(f, x, z, y) : -1; };
  /* where a spire / an overhang ledge may not stand: within gp m of a channel, or within sp m of a bunker site */
  FT.keep_out = (x, z, gp, sp) => {
    const f = FT.of(); if (!f || f.under) return false;
    cell(f, x, z, cellOut);
    if (cellOut.gd < f.hw + gp) return true;
    for (let t = 0; t < f.sites.length; t++) { const s = f.sites[t]; if (s && M.len2(x - s.x, f.line ? 0 : z - s.z) < B.R_OUT + sp) return true; }
    return false;
  };
  /* desert chasm walls lean out at the top (a worm climbs any slope that does not overhang: step-up 0.64 m per tick): the solid starts
   * UNDER_K m farther from the channel at the floor than at 12 m up. undercut_col(x, z): the column's channel distance (99 = none);
   * undercut(f, gd, y): the signed limit (+ = solid allowed) to min() into the density */
  FT.undercut_col = (x, z) => {
    const f = FT.of(); if (!f || f.kind !== 'chasm') return 99;
    cell(f, x, z, cellOut); return cellOut.gd < f.hw + 3.5 ? cellOut.gd : 99;
  };
  FT.undercut = (f, gd, y) => {
    if (y <= f.floor + 0.3) return 99;
    return (gd - (f.hw + f.lean * (1 - sat((y - f.floor) / 12)))) * 0.9;
  };
  /* a worm on a chasm's floor / in a pit (nothing there walks out: the walls lean or fall sheer): the CPU's cue to rope or teleport out (aib.prep) */
  FT.trapped = (x, z, y) => {
    const f = FT.of(); if (!f || (f.kind !== 'chasm' && f.kind !== 'pit')) return false;
    if (f.under) { for (let q = 0; q < f.pits.length; q++) { const p = f.pits[q]; if (M.len2(x - p.x, f.line ? 0 : z - p.z) < p.r + 1.5 && y < f.halls[0].yf - 2.5) return true; } return false; }
    cell(f, x, z, cellOut);
    return cellOut.gd < f.hw + f.lean + 0.5 && y < f.floor + 4;
  };
  /* a rock bridge a -> b may stand: both ends on one fort and the span clear of every bunker site */
  FT.span_ok = (xa, za, xb, zb) => {
    const f = FT.of(); if (!f) return true;
    if (teamAt(f, xa, za, 0) !== teamAt(f, xb, zb, 0)) return false;
    for (let q = 0; q <= 12; q++) {
      const x = xa + (xb - xa) * q / 12, z = za + (zb - za) * q / 12;
      cell(f, x, z, cellOut); if (cellOut.gd < f.hw + 2) return false;
      for (let t = 0; t < f.sites.length; t++) { const s = f.sites[t]; if (s && M.len2(x - s.x, f.line ? 0 : z - s.z) < B.R_OUT + 4) return false; }
    }
    return true;
  };
  /* a spawn spot for `team`: on its fort, clear of every bunker site (the bunkers are stamped after the worms) */
  FT.spot_ok = (x, z, y, team) => {
    const f = FT.of(); if (!f) return true;
    if (teamAt(f, x, z, y) !== team) return false;
    if (!f.under && cellOut.gd < f.hw + 1.5 + (f.kind === 'chasm' ? f.lean : 0)) return false;                    // (teamAt left the cell in cellOut: not on a channel's floor or bank)
    for (let t = 0; t < f.sites.length; t++) { const s = f.sites[t]; if (s && M.len2(x - s.x, f.line ? 0 : z - s.z) < B.R_OUT + 2.6) return false; }
    return true;
  };
  FT.seat = team => { const f = FT.of(), s = f.sites[team], w = W(); return { x: s.x, y: s.y, z: w.flat ? w.MZ : s.z }; };

  /* ---------- heightfield (surface maps) ---------- */
  function widen(w, hgt, F, seed) {
    const NX = w.NX, NZ = w.NZ, H = w.H, SEA = w.SEA, ph = ((seed | 0) & 255) * 0.37;
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      const x = i * H, z = k * H, e = M.min(M.min(M.min(i, k), NX - 1 - i), NZ - 1 - k) * H, c = k * NX + i;
      const roll = SEA + 2.5 + 6 * M.fbm2(x / 22 + ph, z / 22, seed + 11, 4) + 2 * M.sin(x / 13 + ph) * M.sin(z / 17);
      const want = M.lerp(SEA - 3, roll, sm(clamp((e - 4) / 7, 0, 1)));
      if (want > hgt[c]) hgt[c] = M.lerp(hgt[c], want, 0.9);
    }
  }
  const isLand = (w, f, h, x, z) => (f.dry ? M.len2(x - C.DRY.CX, z - C.DRY.CZ) <= C.DRY.PLAY_R : h > w.SEA + 1.2);
  function areaScore(w, hgt, f) {
    const NX = w.NX, NZ = w.NZ, H = w.H, a = [0, 0, 0, 0];
    for (let k = 2; k < NZ - 2; k += 3) for (let i = 2; i < NX - 2; i += 3) {
      const x = i * H, z = k * H;
      if (!isLand(w, f, hgt[k * NX + i], x, z)) continue;
      cell(f, x, z, cellOut);
      if (cellOut.gd > f.hw) a[cellOut.team]++;
    }
    let lo = 1e9, hi = 0;
    for (let t = 0; t < f.n; t++) { lo = M.min(lo, a[t]); hi = M.max(hi, a[t]); }
    return hi > 0 ? lo / hi : 0;
  }
  /* P72: a big fort holds more than one bunker: one per BK_AREA m^2 of the fort's land (2D: one per BK_LEN m of its length), at most 3, the SAME
   * count for every team (the smallest fort decides; a team with no room for its n-th bunker lowers everybody's count). The extra sites are
   * appended to f.sites after the n primary ones (f.sites[team] stays the team's first), each tagged with its team, spread apart (a greedy
   * farthest-point pick: the score adds the distance to the team's other bunkers) and facing the nearest enemy anchor (2D: along the line). */
  const BK_AREA = 600, BK_LEN = 26, BK_MAX = 3, BK_APART = 16;
  function extraSites(w, hgt, f, gdA, tmA, Rp, need0) {
    const NX = w.NX, NZ = w.NZ, H = w.H, SEA = w.SEA, area = [0, 0, 0, 0], n = f.n;
    const kz = Math.round(f.sliceZ / H);
    for (let k = f.line ? kz : 0; k <= (f.line ? kz : NZ - 1); k++) for (let i = 0; i < NX; i++) {
      const c = k * NX + i; if (gdA[c] <= f.hw || !isLand(w, f, hgt[c], i * H, k * H)) continue;
      area[tmA[c]] += f.line ? H : H * H;
    }
    let want = BK_MAX; for (let t = 0; t < n; t++) want = M.min(want, M.max(1, M.min(BK_MAX, Math.floor(area[t] / (f.line ? BK_LEN : BK_AREA)))));
    f.bkWant = want; f.land = area.slice(0, n);
    if (want < 2) return;
    const mine = [], full = [false, false, false, false];
    for (let t = 0; t < n; t++) mine.push([f.sites[t]]);
    for (let j = 1; j < want; j++) for (let t = 0; t < n; t++) {
      if (mine[t].length > j || full[t]) continue;
      let best = null, bs = -1e9;
      for (let relax = 0; relax < 3 && !best; relax++) {
        const need = need0 * (relax === 0 ? 1 : relax === 1 ? 0.75 : 0.5), apart = BK_APART * (relax === 2 ? 0.8 : 1);
        const k0 = f.line ? kz : 8, k1 = f.line ? kz : NZ - 9;
        for (let k = k0; k <= k1; k += (f.line ? 1 : K.SITE_STEP)) for (let i = 8; i <= NX - 9; i += K.SITE_STEP) {
          const c = k * NX + i, x = i * H, z = k * H;
          if (tmA[c] !== t) continue;
          const h = hgt[c], g = gdA[c];
          if (g < need || (!f.dry && h < SEA + 3.3) || h > 30) continue;
          if (f.dry && M.len2(x - C.DRY.CX, z - C.DRY.CZ) > C.DRY.PLAY_R - 7) continue;
          let dn = 1e9, ok = true;
          for (let q = 0; q < f.sites.length && ok; q++) { const o = f.sites[q], d = M.len2(x - o.x, f.line ? 0 : z - o.z); if (d < apart) ok = false; if (o.team === t || q === t) dn = M.min(dn, d); }
          if (!ok) continue;
          let lo = h, hi = h;
          const nb = [c - 6, c + 6, c - 6 * NX, c + 6 * NX];
          for (let q = 0; q < (f.line ? 2 : 4); q++) { const v = hgt[nb[q]]; if (v < lo) lo = v; if (v > hi) hi = v; }
          const sc = 0.5 * h - 1.5 * (hi - lo) + 0.35 * M.min(dn, 30) + 3 * M.hash3(i, k, (f.seed & 0xffff) + t + 17 * j);
          if (sc > bs) { bs = sc; best = { x, z, h }; }
        }
      }
      if (!best) { full[t] = true; continue; }                          // (no room for another: the count of every team drops to the smallest)
      let tg = -1, td = 1e18;
      for (let q = 0; q < n; q++) { if (q === t) continue; const d = M.len2(f.ax[q] - best.x, f.line ? 0 : f.az[q] - best.z); if (d < td) { td = d; tg = q; } }
      const phi = f.line ? (f.ax[tg] >= best.x ? 0 : Math.PI) : M.atan2(f.az[tg] - best.z, f.ax[tg] - best.x);
      const site = { x: best.x, z: f.line ? f.sliceZ : best.z, y: M.max(best.h, f.dry || f.kind === 'lava' ? 0 : SEA + 3.2), phi, r: Rp, team: t, extra: true };
      mine[t].push(site); f.sites.push(site);
    }
    let have = want; for (let t = 0; t < n; t++) have = M.min(have, mine[t].length);
    if (have < want) {                                                  // balance: drop the surplus sites of the richer teams (the latest first)
      for (let q = f.sites.length - 1; q >= n; q--) { const s0 = f.sites[q]; if (mine[s0.team].indexOf(s0) >= have) f.sites.splice(q, 1); }
    }
    f.bkWant = have;
  }
  function bunkerSites(w, hgt, f, gdA, tmA) {
    const NX = w.NX, NZ = w.NZ, H = w.H, SEA = w.SEA, Rp = f.line ? B.R_OUT + 1.8 : B.R_OUT + 2.5;
    const need0 = f.hw + 4.5 + Rp * 0.85;
    for (let t = 0; t < f.n; t++) {
      let best = null, bs = -1e9, fall = null, fg = -1;
      for (let relax = 0; relax < 3 && !best; relax++) {
        const need = need0 * (relax === 0 ? 1 : relax === 1 ? 0.75 : 0.5);
        const k0 = f.line ? Math.round(f.sliceZ / H) : 8, k1 = f.line ? k0 : NZ - 9;
        for (let k = k0; k <= k1; k += (f.line ? 1 : K.SITE_STEP)) for (let i = 8; i <= NX - 9; i += K.SITE_STEP) {
          const c = k * NX + i, x = i * H, z = k * H;
          if (tmA[c] !== t) continue;
          const h = hgt[c], g = gdA[c];
          if (g > fg) { fg = g; fall = { c, x, z, h }; }
          if (g < need || (!f.dry && h < SEA + 3.3) || h > 30) continue;
          if (f.dry && M.len2(x - C.DRY.CX, z - C.DRY.CZ) > C.DRY.PLAY_R - 7) continue;
          let lo = h, hi = h;
          const r6 = 6;
          const nb = [c - r6, c + r6, c - r6 * NX, c + r6 * NX];
          for (let q = 0; q < (f.line ? 2 : 4); q++) { const v = hgt[nb[q]]; if (v < lo) lo = v; if (v > hi) hi = v; }
          const sc = 0.5 * h - 0.25 * M.len2(x - f.ax[t], f.line ? 0 : z - f.az[t]) - 1.5 * (hi - lo) + 3 * M.hash3(i, k, (f.seed & 0xffff) + t);
          if (sc > bs) { bs = sc; best = { c, x, z, h }; }
        }
      }
      if (!best) best = fall;
      // the enemy it faces: the nearest other anchor (3D); 2D: toward the middle of the line
      let tg = -1, td = 1e18;
      for (let q = 0; q < f.n; q++) { if (q === t) continue; const d = M.len2(f.ax[q] - best.x, f.az[q] - best.z); if (d < td) { td = d; tg = q; } }
      const phi = f.line ? (t < f.n / 2 ? 0 : Math.PI) : M.atan2(f.az[tg] - best.z, f.ax[tg] - best.x);
      const padH = M.max(best.h, f.dry || f.kind === 'lava' ? 0 : SEA + 3.2);
      f.sites[t] = { x: best.x, z: f.line ? f.sliceZ : best.z, y: padH, phi, r: Rp };
    }
    extraSites(w, hgt, f, gdA, tmA, Rp, need0);
    // flatten the pads (a disc in 3D, a strip across the slab in 2D), blended over 4 m
    for (let t = 0; t < f.sites.length; t++) {
      const s = f.sites[t], bl = f.line ? 3 : 4, R = s.r + bl;
      const i0 = M.max(0, Math.floor((s.x - R) / H)), i1 = M.min(NX - 1, Math.ceil((s.x + R) / H));
      const k0 = f.line ? 0 : M.max(0, Math.floor((s.z - R) / H)), k1 = f.line ? NZ - 1 : M.min(NZ - 1, Math.ceil((s.z + R) / H));
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
        const d = f.line ? Math.abs(i * H - s.x) : M.len2(i * H - s.x, k * H - s.z);
        if (d >= R) continue;
        const wgt = 1 - sm(sat((d - s.r) / bl)), c = k * NX + i;
        hgt[c] = M.lerp(hgt[c], s.y, wgt);
      }
    }
  }

  FT.shape = function (w, hgt, F, seed, lz) {
    const f = F.fort; if (!f || f.under) return;
    const NX = w.NX, NZ = w.NZ, H = w.H, SEA = w.SEA, n = f.n, NC = NX * NZ, hw = f.hw, kind = f.kind;
    if (f.line && !f.dry) widen(w, hgt, F, seed);
    // 3D: the rotation with the most even land (the first candidate wins unless a later one is clearly better)
    if (!f.line) {
      const cands = n === 2 ? [0, 0.2, -0.2, 0.4, -0.4] : [0, 1, 2, 3, 4, 5, 6, 7].map(q => q * M.TAU / n / 8);
      let bs = -1, br = 0;
      for (let q = 0; q < cands.length; q++) { anchors(f, w, cands[q]); const s = areaScore(w, hgt, f); if (s > bs + 0.04) { bs = s; br = cands[q]; } }
      anchors(f, w, br);
    }
    // cells: team and channel distance per column
    const tm = new Int8Array(NC), gd = new Float32Array(NC);
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) { cell(f, i * H, k * H, cellOut); tm[k * NX + i] = cellOut.team; gd[k * NX + i] = cellOut.gd; }
    // an anchor with no land under it gets a mound (a fort needs ground to stand on)
    if (!f.dry) for (let t = 0; t < n; t++) {
      const i0 = Math.round(f.ax[t] / H), k0 = Math.round(f.az[t] / H), R = K.MOUND_R;
      if (hgt[k0 * NX + i0] >= SEA + 4) continue;
      for (let k = M.max(0, k0 - Math.ceil(R / H)); k <= M.min(NZ - 1, k0 + Math.ceil(R / H)); k++) for (let i = M.max(0, i0 - Math.ceil(R / H)); i <= M.min(NX - 1, i0 + Math.ceil(R / H)); i++) {
        const d = M.len2((i - i0) * H, (k - k0) * H); if (d >= R) continue;
        const c = k * NX + i, m = SEA + 6 * (1 - sm(d / R)) + 1 * sm(d / R) * 0;
        if (m > hgt[c]) hgt[c] = m;
      }
    }
    // balance: every fort's mean land height toward the common mean
    { const sum = [0, 0, 0, 0], cnt = [0, 0, 0, 0];
      const kz = Math.round(f.sliceZ / H), kb = f.line ? 6 : 0;                 // (2D: the slice's band only: that is what the players see)
      for (let k = f.line ? kz - kb : 0; k <= (f.line ? kz + kb : NZ - 1); k += f.line ? 1 : 2) for (let i = 0; i < NX; i += f.line ? 1 : 2) { const c = k * NX + i; if (gd[c] > hw + 3 && isLand(w, f, hgt[c], i * H, k * H)) { sum[tm[c]] += hgt[c]; cnt[tm[c]]++; } }
      let mt = 0, nn = 0; for (let t = 0; t < n; t++) if (cnt[t]) { sum[t] /= cnt[t]; mt += sum[t]; nn++; }
      mt /= M.max(1, nn);
      for (let t = 0; t < n; t++) f.lift[t] = cnt[t] ? (f.line ? clamp((mt - sum[t]) * 0.9, -6, 6) : clamp((mt - sum[t]) * 0.8, -3, 4)) : 0;
    }
    const P = PROF[f.biome] || PROF.temperate;
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      const c = k * NX + i, x = i * H, z = k * H, g = gd[c], t = tm[c], rr = f.dry ? M.len2(x - C.DRY.CX, z - C.DRY.CZ) : 0;
      const rm = f.dry && !f.line ? 1 - sat((rr - (C.DRY.PLAY_R + 3)) / 7) : 1;
      let h = hgt[c];
      if (f.line && !f.dry) h = M.lerp(h, M.max(h, SEA + 3 + 2 * M.noise2(x / 9, z / 9, seed + 614)), sm(sat((g - hw - 1.5) / 2)) * sat(M.min(M.min(i, NX - 1 - i) * H, 12) / 12 - 0.2));   // 2D: a fort is one piece of ground (no bay inside a cell)
      h += f.lift[t] * sat((h - SEA - 0.5) / 3) * sat((g - hw) / 6) * rm;
      if (kind === 'chasm') {                                                   // tall mesas: flat tops, steep walls
        const Ti = 13 + 3 * (M.hash3(t, 7, f.seed & 0xffff) - 0.5), m = sm(sat((g - hw - 1) / 5)) * rm;
        const hM = Ti + 2.4 * (M.fbm2(x / 9, z / 9, seed + 611, 2) - 0.5) + 0.25 * (h - 6);
        h = M.lerp(h, hM, m);
      } else if (kind === 'lava') {                                              // basalt crags
        const crag = 7 * M.pow(M.ridge2(x / 13, z / 13, seed + 612, 3), 1.6) + 2 * (M.fbm2(x / 8, z / 8, seed + 613, 2) - 0.4);
        h = M.min(26, h + sat((g - hw - 1) / 6) * M.max(0, crag) * sat((h - SEA) / 2));
      }
      const prof = f.floor + M.max(0, g - hw) * f.bank + (1 - rm) * 60;
      if (h > prof) {
        if (kind === 'lava' && h > f.floor + 0.15 && g < hw) { if (!F.lavaInit) F.lavaInit = new Float32Array(NC).fill(-1); F.lavaInit[c] = f.floor + 1.1; }
        h = prof;
      } else if (kind === 'lava' && g < hw && h > SEA - 0.3) h = SEA - 1.7;      // the river's mouth: low ground in the channel becomes a sea inlet (no isthmus)
      if (kind === 'lava' && g < hw + 2 && h <= f.floor + 2.5 && lz) lz[c] = 1;
      hgt[c] = h;
    }
    f.bank = P.bank;
    bunkerSites(w, hgt, f, gd, tm);
  };

  /* ---------- caves ---------- */
  /* the plan of an underground fort map: n halls + the pit(s); returns { ch, tu, ni } for worldgen's underFill (the same structs) */
  FT.under_plan = function (w, F) {
    const f = F.fort, n = f.n, ch = [], tu = [], ni = [], line = f.line;
    anchors(f, w, 0);
    f.pits = []; f.halls = []; f.sites = [];
    const rx = line ? M.clamp(f.span * 0.3, 4.6, 8) : 8.5, rz = line ? 7 : 8, ry = K.HALL_RY, pitR = line ? M.clamp(f.span * 0.2, 3.2, 5.5) : K.PIT3_R;
    if (line) for (let t = 0; t + 1 < n; t++) f.pits.push({ x: (f.ax[t] + f.ax[t + 1]) / 2, z: f.sliceZ, r: pitR });
    else f.pits.push({ x: w.MX, z: w.MZ, r: pitR });
    for (let t = 0; t < n; t++) {
      const yf = 11 + 3 * M.hash3(t, 3, f.seed & 0xffff), x = f.ax[t], z = f.az[t];
      ch.push({ x, y: yf + ry * 0.62, z, rx, rz, ry });
      f.halls.push({ x, z, yf, rx, rz });
      // mouths: to every pit that touches the hall (the 3D hub; 2D: the neighbours' pits)
      for (let q = 0; q < f.pits.length; q++) {
        const p = f.pits[q];
        if (line && Math.abs(p.x - x) > f.span * 0.75) continue;
        tu.push([{ x, y: yf + K.MOUTH_R, z }, { x: p.x, y: yf + K.MOUTH_R, z: line ? z : p.z }, K.MOUTH_R]);
      }
      // two side niches on the far side of the hall
      for (let q = 0; q < 2; q++) {
        const a = f.rot + Math.PI * (q ? 0.7 : -0.7) + M.hash3(t, q, 5) * 0.4;
        if (!line) ni.push({ x: x + M.cos(a) * rx * 0.85, y: yf + 2.2, z: z + M.sin(a) * rz * 0.85, r: 2.2 + 0.8 * M.hash3(t, q, 9) });
        else ni.push({ x: x + (q ? 1 : -1) * rx * 0.8, y: yf + 2.2, z: z + (M.hash3(t, q, 9) - 0.5) * 3, r: 2 + 0.7 * M.hash3(t, q, 11) });
      }
    }
    for (let q = 0; q < f.pits.length; q++) { const p = f.pits[q]; tu.push([{ x: p.x, y: 3.5, z: p.z }, { x: p.x, y: 34, z: p.z }, p.r]); }
    // the bunker site: the hall's middle, the embrasure toward the (nearest) pit
    for (let t = 0; t < n; t++) {
      const h = f.halls[t]; let bq = 0, bd = 1e18;
      for (let q = 0; q < f.pits.length; q++) { const d = M.len2(f.pits[q].x - h.x, f.pits[q].z - h.z); if (d < bd) { bd = d; bq = q; } }
      const p = f.pits[bq], phi = line ? (p.x >= h.x ? 0 : Math.PI) : M.atan2(p.z - h.z, p.x - h.x);
      f.sites.push({ x: h.x, z: h.z, y: h.yf, phi, r: B.R_OUT + 2 });
    }
    return { ch, tu, ni };
  };

  /* ---------- bunkers and the bunker worms ---------- */
  FT.populate = function (S, taken) {
    const f = FT.of(); if (!f || !SS.bunker) return;
    const w = W(); let made = 0;
    for (let t = 0; t < f.sites.length; t++) {                              // (P72: the n primary sites first = one per team, then the extra bunkers of big forts)
      const s = f.sites[t], z = w.flat ? w.MZ : s.z;
      if (t < f.n && t >= S.teams.length) continue;
      const y0 = s.y + 0.05, foot = B.FOUND + 0.5;                      // (the pad is flat at s.y; under a rock bridge the rim's top would read the deck)
      SS.bunker.build(S, taken, s.x, z, y0, s.phi, foot);
      const wm = t < f.n ? S.worms[t] : null;
      if (wm && wm.team === t) { wm.pos.x = s.x; wm.pos.y = y0 + 0.56; wm.pos.z = z; wm.vel.x = 0; wm.vel.y = 0; wm.vel.z = 0; wm.rest = false; wm.vs = 0; wm.vy = 0; }
      made++;
    }
    SS.sim.log(S, `Fort mode: ${f.n} forts, ${made} bunker${made > 1 ? 's' : ''}${made > f.n ? ' (' + (made / f.n) + ' per fort)' : ''}. ${f.kind === 'sea' ? 'The sea' : f.kind === 'lava' ? 'Lava rivers' : f.kind === 'chasm' ? 'Deep canyons' : 'A deep pit'} separate${f.kind === 'pit' ? 's' : ''} the teams: rope, jump or shoot across.`, 0xc8ccd0);
  };
})(window.SS = window.SS || {});
