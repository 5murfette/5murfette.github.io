/* sim/water.js — sea and shallow water (portable, deterministic; no DOM / Three.js).
 *
 * Virtual-pipe shallow water (O'Brien & Hodgins / Mei et al.) on the 193 x 193 lattice columns (dx = 0.5 m), fixed
 * sub-step WATER.DT (1/60 s). Each cell keeps its depth h and four outflow pipes (to -x, +x, -z, +z):
 *   f += dt * g * dx * (H_here - H_there)     (pipe of cross-section dx^2 and length dx; H = bed + h),
 * decayed by DAMP and by bottom friction FRICTION / h (shallow run-up dies fast), clamped >= 0 and scaled so a cell
 * never ships more than it holds. Velocity comes from the mean through-flux / depth.
 * Bed = the ground seen from below (first air gap above bedrock): bridges and overhangs do not dry the sea under
 * them. Edited columns are refreshed through W.listeners (a crater next to the sea floods, re-baked rubble displaces
 * water). The outer RING cells relax toward a reservoir at SEA plus a swell entering from the upwind edges (a plane
 * wave, SWELL_A / SWELL_L / SWELL_DIR, phase from S.time) and absorb waves leaving the map.
 * Blasts (blast.js hook): a cavity (-A) with its volume thrown onto a rim, then the cavity's collapse (implosion) throws
 * up a central jet: a mound at t + 0.3 s under water / 0.2 s at the surface (P30g: A = 1.1 W^1/3 under water, 0.7 W^1/3
 * at the surface, R = 2.8 W^1/3; the 'waterblast' event carries tJet and the jet height jetH for the render).
 *
 * Open lava (S.lava.h) lies under the water and raises its effective bed (bed = b + lava), so a flow entering the
 * sea displaces it; lava.js quenches where h > WET.
 * Groundwater (water table = SEA): a column not connected to the sea whose bed is below SEA on permeable ground
 * (SEEP_MATS at the bed: rock, basalt and loose ground; not ice, snow, bedrock, crust) is a seep cell (mask `seep`, for the render's damp look). Each turn change (new_turn) adds
 * SEEP / teams of depth to `seepLeft`, released over SEEP_T s into the seep cells that are wet or a dry local low point
 * of the water surface, never above SEA: the pool level rises ~SEEP per round however steep the pit is.
 * C layout: struct Water { i32 NX, NZ; f32 *b, *be (b + lava), *bed (-> b or be), *h, *fL, *fR, *fB, *fF, *ux, *uz, *ring; f32 acc, t; u32 ver;
 *   Pend pend[]; u8 *sea, *seep; i32 *seepList, nSeep; f32 seepLeft, seepVol; u8 seepDirty; u32 seepVer; }.
 * API: init(S), step(S, dt), new_turn(S), surface(S, x, z) (-99 = dry), depth(S, x, z), vel(S, x, z, out),
 *   disturb(S, x, z, r, amp), blast(S, c, W), stats(S).
 */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, K = C.WATER;
  const WA = SS.water = {};
  const W = () => SS.world;
  const DRY = -99;
  let PERM = null;                            // material id -> permeable ground (groundwater seeps through)
  let dirty = null;                           // union of edited lattice columns since the last bed refresh

  // the pending edit rect is sim state outside S: sim.snapshot / restore carry it (bit-identical replays)
  WA.dirty_get = () => (dirty ? { i0: dirty.i0, k0: dirty.k0, i1: dirty.i1, k1: dirty.k1 } : null);
  WA.dirty_set = d => { dirty = d ? { i0: d.i0, k0: d.k0, i1: d.i1, k1: d.k1 } : null; };
  function onMark(i0, k0, i1, k1) {
    if (!dirty) dirty = { i0, k0, i1, k1 };
    else { dirty.i0 = Math.min(dirty.i0, i0); dirty.k0 = Math.min(dirty.k0, k0); dirty.i1 = Math.max(dirty.i1, i1); dirty.k1 = Math.max(dirty.k1, k1); }
  }
  /* ground under column (i, k) seen from below: the first solid->air transition above bedrock */
  function bedOf(w, i, k) {
    const NX = w.NX, NY = w.NY, D = w.d;
    let o = k * NY * NX + i;
    for (let j = 0; j < NY; j++, o += NX) {
      if (D[o] <= 0) {
        if (j === 0) return 0;
        const a = D[o - NX], b = D[o];
        return (j - 1 + a / (a - b)) * w.H;
      }
    }
    return w.top[k * NX + i];
  }

  /* sea-connected columns: flood from the map edge through every column whose bed is below SEA; marks st.sea */
  function seaFlood(st, w) {
    const NX = st.NX, NZ = st.NZ, SEA = w.SEA, b = st.b, sea = st.sea, stack = st.stack;
    sea.fill(0);
    let sp = 0;
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      if (i && k && i < NX - 1 && k < NZ - 1) continue;
      const c = k * NX + i; if (b[c] < SEA) { sea[c] = 1; stack[sp++] = c; }
    }
    while (sp > 0) {
      const c = stack[--sp], i = c % NX, k = (c / NX) | 0;
      if (i > 0 && !sea[c - 1] && b[c - 1] < SEA) { sea[c - 1] = 1; stack[sp++] = c - 1; }
      if (i < NX - 1 && !sea[c + 1] && b[c + 1] < SEA) { sea[c + 1] = 1; stack[sp++] = c + 1; }
      if (k > 0 && !sea[c - NX] && b[c - NX] < SEA) { sea[c - NX] = 1; stack[sp++] = c - NX; }
      if (k < NZ - 1 && !sea[c + NX] && b[c + NX] < SEA) { sea[c + NX] = 1; stack[sp++] = c + NX; }
    }
  }
  /* seep cells: not sea, bed below SEA, permeable material at the bed (the lattice node holding the bed surface) */
  function seepMask(st, w) {
    const NX = st.NX, NZ = st.NZ, NY = w.NY, SEA = w.SEA, H = w.H, b = st.b, sea = st.sea, seep = st.seep, list = st.seepList;
    seaFlood(st, w);
    let n = 0;
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      const c = k * NX + i;
      seep[c] = 0;
      if (sea[c] || b[c] >= SEA - 0.01) continue;
      let j = M.clamp(Math.floor(b[c] / H + 1e-4), 0, NY - 1), o = (k * NY + j) * NX + i;
      if (w.d[o] <= 0 && j > 0) o -= NX;
      if (!PERM[w.mat[o]]) continue;
      seep[c] = 1; list[n++] = c;
    }
    st.nSeep = n; st.seepDirty = false; st.seepVer++;
  }
  /* release this sub-step's share of the turn's seep budget */
  function seepIn(st, w, b, dt) {
    const NX = st.NX, NZ = st.NZ, SEA = w.SEA, h = st.h, list = st.seepList;
    const q = Math.min(st.seepLeft, K.SEEP / (st.nTeams || 2) / K.SEEP_T * dt);
    st.seepLeft = st.seepLeft - q > 1e-9 ? st.seepLeft - q : 0;
    let added = 0;
    for (let n = 0; n < st.nSeep; n++) {
      const c = list[n];
      if (b[c] !== st.b[c]) continue;                    // open lava on the floor: lava.js owns this column
      const Hc = b[c] + h[c], room = SEA - Hc;
      if (room <= 1e-5) continue;
      if (h[c] <= K.WET) {                               // dry: only a low point of the surface collects the first water
        const i = c % NX, k = (c / NX) | 0, e = Hc - 1e-4;
        if ((i > 0 && b[c - 1] + h[c - 1] < e) || (i < NX - 1 && b[c + 1] + h[c + 1] < e) ||
            (k > 0 && b[c - NX] + h[c - NX] < e) || (k < NZ - 1 && b[c + NX] + h[c + NX] < e)) continue;
      }
      const a = q < room ? q : room;
      h[c] += a; added += a;
    }
    st.seepVol += added * w.H * w.H;
  }

  WA.init = function (S) {
    const w = W(), NX = w.NX, NZ = w.NZ, N = NX * NZ, SEA = w.SEA;
    if (w.listeners.indexOf(onMark) < 0) w.listeners.push(onMark);
    dirty = null;
    if (!PERM) { PERM = new Uint8Array(256); for (const m of K.SEEP_MATS) PERM[C.MAT[m]] = 1; }
    const F = () => new Float32Array(N);
    const st = S.water = { NX, NZ, N, b: F(), h: F(), fL: F(), fR: F(), fB: F(), fF: F(), ux: F(), uz: F(), ring: F(), be: F(), side: new Int8Array(N),
      acc: 0, t: 0, ver: 1, pend: [], swellA: K.SWELL_A, swellL: K.SWELL_L, swellDir: K.SWELL_DIR,
      sea: new Uint8Array(N), seep: new Uint8Array(N), seepList: new Int32Array(N), stack: new Int32Array(N), nSeep: 0,
      seepLeft: 0, seepVol: 0, seepDirty: true, seepVer: 0 };
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) st.b[k * NX + i] = bedOf(w, i, k);
    // the sea: every column connected to the map edge below SEA starts full (inland pits start dry)
    seepMask(st, w);
    for (let c = 0; c < N; c++) if (st.sea[c]) st.h[c] = SEA - st.b[c];
    // sponge weight and the edge each ring cell belongs to (0 -x, 1 +x, 2 -z, 3 +z)
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      const e = Math.min(i, k, NX - 1 - i, NZ - 1 - k), c = k * NX + i;
      st.ring[c] = e < K.RING ? M.pow(1 - e / K.RING, 2) : 0;
      st.side[c] = e === i ? 0 : e === NX - 1 - i ? 1 : e === k ? 2 : 3;
    }
    st.bed = st.b;                                       // effective bed (b + open lava), set every sub-step
    st.vol0 = WA.stats(S).vol;
  };

  /* reservoir level of a ring cell: SEA + the swell where it enters (upwind edges only) */
  // cached per ring cell (sub() step 3): SEA + A · up · sin(ph − om t), ph = kw (x dx + z dz), om = kw sqrt(g max(0.5,
  // SEA − bed)); rebuilt when the swell heading / length / on-off or the bed changes
  function ringCache(st, w) {
    let r = st.rc;
    const key = st.swellDir + ':' + st.swellL + ':' + (st.swellA > 0) + ':' + (st.bedVer || 0);
    if (r && r.key === key) return r;
    const NX = st.NX, NZ = st.NZ, list = [];
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) if (st.ring[k * NX + i] > 0) list.push(k * NX + i);
    const n = list.length;
    r = st.rc = { key, n, c: Int32Array.from(list), a: new Float64Array(n), up: new Float64Array(n), ph: new Float64Array(n), om: new Float64Array(n) };
    const dx = M.cos(st.swellDir), dz = M.sin(st.swellDir), kw = 2 * Math.PI / st.swellL;
    for (let q = 0; q < n; q++) {
      const c = list[q], i = c % NX, k = (c / NX) | 0, sd = st.side[c];
      r.a[q] = 1 - M.exp(-K.SPONGE * st.ring[c] * K.DT * 8);
      const up = sd === 0 ? dx : sd === 1 ? -dx : sd === 2 ? dz : -dz;          // -(outward normal . heading)
      r.up[q] = up > 0 && st.swellA > 0 ? up : 0;
      const x = i * w.H, z = k * w.H, cw = Math.sqrt(C.G * Math.max(0.5, w.SEA - st.b[c]));
      r.ph[q] = kw * (x * dx + z * dz); r.om[q] = kw * cw;
    }
    return r;
  }

  function refreshBeds(st, w) {
    const NX = st.NX, NZ = st.NZ, i0 = Math.max(0, dirty.i0 - 1), k0 = Math.max(0, dirty.k0 - 1), i1 = Math.min(NX - 1, dirty.i1 + 1), k1 = Math.min(NZ - 1, dirty.k1 + 1);
    dirty = null;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const c = k * NX + i, nb = bedOf(w, i, k), surf = st.b[c] + st.h[c];
      // the water surface stays where it was: a raised bed displaces water, a crater leaves a hole the water fills
      st.h[c] = st.h[c] > 0 ? Math.max(0, surf - nb) : 0;
      st.b[c] = nb;
    }
    st.seepDirty = true; st.bedVer = (st.bedVer || 0) + 1;
  }

  function sub(S, st) {
    const w = W(), NX = st.NX, NZ = st.NZ, N = st.N, DT = K.DT, dx = w.H, area = dx * dx, kf = DT * C.G * dx;
    const h = st.h, fL = st.fL, fR = st.fR, fB = st.fB, fF = st.fF;
    if (dirty) refreshBeds(st, w);
    // effective bed: open lava lies on the ground under the water and displaces it
    let b = st.b;
    const lv = S.lava;
    if (lv && lv.i1 >= lv.i0) {
      b = st.be; b.set(st.b);
      const top = w.top;                                 // lava rests on W.top: only where that is the water's bed
      for (let k = lv.k0; k <= lv.k1; k++) for (let i = lv.i0, c = k * NX + lv.i0; i <= lv.i1; i++, c++) if (lv.h[c] > 0 && top[c] - st.b[c] < 0.3) b[c] += lv.h[c];
    }
    st.bed = b;
    if (st.seepDirty) seepMask(st, w);
    if (st.seepLeft > 0) seepIn(st, w, b, DT);
    st.t += DT;
    for (let q = st.pend.length - 1; q >= 0; q--) { const p = st.pend[q]; if (st.t >= p.t) { st.pend.splice(q, 1); mound(st, w, p.x, p.z, p.r, p.a); } }
    const damp = 1 - K.DAMP * DT, ih = S.ice ? S.ice.h : null, icr = S.ice ? S.ice.crack : null;
    // 1. outflows
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      const c = k * NX + i, hc = h[c];
      if (hc <= 0) { fL[c] = fR[c] = fB[c] = fF[c] = 0; continue; }
      // Step I: an intact ice sheet damps the waves under it (the swell dies in the ice)
      const Hc = b[c] + hc, d = damp / (1 + DT * K.FRICTION / Math.max(hc, 0.01)) * (ih && ih[c] >= 2 && !icr[c] ? 1 - Math.min(0.06, ih[c] * 0.004) : 1);
      let l = i > 0 ? Math.max(0, fL[c] * d + kf * (Hc - b[c - 1] - h[c - 1])) : 0;
      let r = i < NX - 1 ? Math.max(0, fR[c] * d + kf * (Hc - b[c + 1] - h[c + 1])) : 0;
      let bb = k > 0 ? Math.max(0, fB[c] * d + kf * (Hc - b[c - NX] - h[c - NX])) : 0;
      let f = k < NZ - 1 ? Math.max(0, fF[c] * d + kf * (Hc - b[c + NX] - h[c + NX])) : 0;
      const out = (l + r + bb + f) * DT;
      if (out > hc * area) { const s = hc * area / out; l *= s; r *= s; bb *= s; f *= s; }
      fL[c] = l; fR[c] = r; fB[c] = bb; fF[c] = f;
    }
    // 2. depths and velocities
    const ux = st.ux, uz = st.uz, inv = DT / area;
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      const c = k * NX + i;
      const inL = i > 0 ? fR[c - 1] : 0, inR = i < NX - 1 ? fL[c + 1] : 0, inB = k > 0 ? fF[c - NX] : 0, inF = k < NZ - 1 ? fB[c + NX] : 0;
      const h0 = h[c], h1 = Math.max(0, h0 + inv * (inL + inR + inB + inF - fL[c] - fR[c] - fB[c] - fF[c]));
      h[c] = h1;
      const hm = 0.5 * (h0 + h1);
      if (hm < K.WET) { ux[c] = uz[c] = 0; continue; }
      const den = 2 * dx * Math.max(hm, 0.05);
      let vx = ((inL - fL[c]) + (fR[c] - inR)) / den, vz = ((inB - fB[c]) + (fF[c] - inF)) / den;
      // flux / depth blows up in thin run-up films (8+ m/s at 5 cm): report at most Froude FR_MAX (and VMAX)
      const v2 = vx * vx + vz * vz, cap = Math.min(K.VMAX, K.FR_MAX * Math.sqrt(C.G * hm));
      if (v2 > cap * cap) { const f = cap / Math.sqrt(v2); vx *= f; vz *= f; }
      ux[c] = vx; uz[c] = vz;
    }
    // 3. sponge ring: relax to the reservoir (SEA + swell) and bleed the fluxes (ring cells + swell terms cached:
    // one sine per ring cell; the old per-cell trig + sqrt was 14 % of the sim)
    const rc = ringCache(st, w);
    for (let q = 0; q < rc.n; q++) {
      const c = rc.c[q];
      if (b[c] >= w.SEA + 1) continue;
      const tgt = rc.up[q] > 0 ? w.SEA + st.swellA * rc.up[q] * M.sin(rc.ph[q] - rc.om[q] * st.t) : w.SEA, a = rc.a[q];
      h[c] = Math.max(0, h[c] + (tgt - b[c] - h[c]) * a);
      const fd = 1 - 0.5 * a; fL[c] *= fd; fR[c] *= fd; fB[c] *= fd; fF[c] *= fd;
    }
    st.ver++;
  }

  WA.step = function (S, dt) {
    const st = S.water; if (!st) return;
    st.nTeams = S.teams ? S.teams.length : 2;
    st.acc += dt;
    while (st.acc >= K.DT - 1e-9) { st.acc -= K.DT; sub(S, st); }
  };

  /* P1 sudden death: the sea rises dh m. The open-sea ring relaxes toward the new SEA by itself; wet cells are lifted
   * at once (the lagoon and connected pools rise with it), dry pits below the new level fill by inflow. Underground and
   * dry worlds have no sea (SEA below the lattice): no-op. Emits 'searise' for the renderer (outer plane, uSea). */
  WA.raise = function (S, dh) {
    const st = S.water, w = W(); if (!st || w.under || w.dry || !(dh > 0)) return;
    w.SEA += dh;
    for (let c = 0; c < st.N; c++) if (st.h[c] > 0.01) st.h[c] += dh;
    st.bedVer = (st.bedVer || 0) + 1; st.ver++;
    SS.sim.emit(S, 'searise', { sea: w.SEA, dh });
  };
  /* turn change: this turn's share of the round's groundwater (SEEP / teams); an unreleased rest carries (max 2) */
  WA.new_turn = function (S) {
    const st = S.water; if (!st) return;
    const per = K.SEEP / (S.teams ? S.teams.length : 2);
    st.seepLeft = Math.min(st.seepLeft + per, 2 * per);
  };

  /* ---------- queries ---------- */
  function cellIdx(st, w, x, z) { return M.clamp(Math.round(z / w.H), 0, st.NZ - 1) * st.NX + M.clamp(Math.round(x / w.H), 0, st.NX - 1); }
  /* water surface height at (x, z) (bilinear over the wet corners); DRY (-99) where there is no water */
  WA.surface = function (S, x, z) {
    const st = S.water, w = W(); if (!st) return w.SEA;
    const fx = x / w.H, fz = z / w.H;
    if (fx < 0 || fz < 0 || fx > st.NX - 1 || fz > st.NZ - 1) return w.SEA;
    const i = Math.min(st.NX - 2, Math.floor(fx)), k = Math.min(st.NZ - 2, Math.floor(fz)), u = fx - i, v = fz - k;
    let sw = 0, sh = 0;
    for (let q = 0; q < 4; q++) {
      const c = (k + (q >> 1)) * st.NX + i + (q & 1), hh = st.h[c];
      if (hh <= K.WET) continue;
      const wt = ((q & 1) ? u : 1 - u) * ((q >> 1) ? v : 1 - v) + 1e-4;
      sw += wt; sh += wt * (st.bed[c] + hh);
    }
    return sw > 0 ? sh / sw : DRY;
  };
  WA.depth = function (S, x, z) { const st = S.water; if (!st) return 0; return st.h[cellIdx(st, W(), x, z)]; };
  WA.vel = function (S, x, z, out) {
    const st = S.water, w = W(); out.x = out.y = out.z = 0; if (!st) return out;
    const fx = M.clamp(x / w.H, 0, st.NX - 1.001), fz = M.clamp(z / w.H, 0, st.NZ - 1.001);
    const i = Math.floor(fx), k = Math.floor(fz), u = fx - i, v = fz - k, c = k * st.NX + i;
    out.x = (st.ux[c] * (1 - u) + st.ux[c + 1] * u) * (1 - v) + (st.ux[c + st.NX] * (1 - u) + st.ux[c + st.NX + 1] * u) * v;
    out.z = (st.uz[c] * (1 - u) + st.uz[c + 1] * u) * (1 - v) + (st.uz[c + st.NX] * (1 - u) + st.uz[c + st.NX + 1] * u) * v;
    return out;
  };
  /* add amp * (1 - (d/r)^2) of water within r (wet cells only; negative = a dip) */
  WA.disturb = function (S, x, z, r, amp) {
    const st = S.water, w = W(); if (!st) return;
    const H = w.H, i0 = Math.max(0, Math.floor((x - r) / H)), i1 = Math.min(st.NX - 1, Math.ceil((x + r) / H));
    const k0 = Math.max(0, Math.floor((z - r) / H)), k1 = Math.min(st.NZ - 1, Math.ceil((z + r) / H));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const c = k * st.NX + i, d2 = ((i * H - x) ** 2 + (k * H - z) ** 2) / (r * r);
      if (d2 >= 1 || st.h[c] <= K.WET) continue;
      st.h[c] = Math.max(0, st.h[c] + amp * (1 - d2));
    }
    st.ver++;
  };
  /* a mound of height a and radius r at (x, z), its volume taken from the ring r..2r (volume-neutral) */
  function mound(st, w, x, z, r, a) {
    const H = w.H, R2 = 2 * r, i0 = Math.max(0, Math.floor((x - R2) / H)), i1 = Math.min(st.NX - 1, Math.ceil((x + R2) / H));
    const k0 = Math.max(0, Math.floor((z - R2) / H)), k1 = Math.min(st.NZ - 1, Math.ceil((z + R2) / H));
    let vin = 0, nring = 0;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const c = k * st.NX + i; if (st.h[c] <= K.WET) continue;
      const d = M.len2(i * H - x, k * H - z);
      if (d < r) { const dh = a * (1 - (d / r) * (d / r)); st.h[c] += dh; vin += dh; } else if (d < R2) nring++;
    }
    if (nring) { const dd = vin / nring; for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) { const c = k * st.NX + i, d = M.len2(i * H - x, k * H - z); if (d >= r && d < R2 && st.h[c] > K.WET) st.h[c] = Math.max(0, st.h[c] - dd); } }
  }

  /* blast hook: cavity + rim (volume-neutral), and an underwater charge's delayed collapse jet */
  WA.blast = function (S, c, Wkg) {
    const st = S.water, w = W(); if (!st) return;
    const surf = WA.surface(S, c.x, c.z);
    if (surf === DRY) return;
    const depth = surf - c.y, s3 = M.cbrt(Wkg);
    if (depth < -1.2 * s3) return;                                   // air burst too high to dent the water
    const under = depth > 0.3, att = depth > 3 ? M.exp(-(depth - 3) / 3) : 1, R = 2.8 * s3, A = (under ? 1.1 : 0.7) * s3 * att;
    const H = w.H, Rr = 1.7 * R, i0 = Math.max(0, Math.floor((c.x - Rr) / H)), i1 = Math.min(st.NX - 1, Math.ceil((c.x + Rr) / H));
    const k0 = Math.max(0, Math.floor((c.z - Rr) / H)), k1 = Math.min(st.NZ - 1, Math.ceil((c.z + Rr) / H));
    let vout = 0, wr = 0;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const q = k * st.NX + i; if (st.h[q] <= K.WET) continue;
      const d = M.len2(i * H - c.x, k * H - c.z);
      if (d < R) { const dh = Math.min(st.h[q], A * (1 - (d / R) * (d / R))); st.h[q] -= dh; vout += dh; }
      else if (d < Rr) wr += M.sin(Math.PI * (d - R) / (Rr - R));
    }
    if (wr > 0) for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const q = k * st.NX + i; if (st.h[q] <= K.WET) continue;
      const d = M.len2(i * H - c.x, k * H - c.z);
      if (d >= R && d < Rr) st.h[q] += vout * M.sin(Math.PI * (d - R) / (Rr - R)) / wr;
    }
    // the cavity collapses inward (implosion) and its converging walls throw up the central jet: a mound at t + 0.2-0.3 s
    // that falls back as the second ring (both for charges under the surface and for contact bursts on it)
    const tJet = under ? 0.3 : 0.2, jetH = Math.min(16, Math.max(2, (under ? 8 : 5) * s3 * att));
    st.pend.push({ t: st.t + tJet, x: c.x, z: c.z, r: R * 0.42, a: A * (under ? 0.9 : 0.6) });
    st.ver++;
    SS.sim.emit(S, 'waterblast', { x: c.x, y: surf, z: c.z, R, A, under, depth, tJet, jetH });
  };

  WA.stats = function (S) {
    const st = S.water; if (!st) return null;
    let vol = 0, wet = 0, vmax = 0, hmax = 0;
    const a = W().H * W().H;
    for (let c = 0; c < st.N; c++) {
      const hh = st.h[c]; if (hh <= K.WET) continue;
      wet++; vol += hh * a; vmax = Math.max(vmax, M.len2(st.ux[c], st.uz[c])); hmax = Math.max(hmax, st.bed[c] + hh);
    }
    return { vol, wet, vmax, hmax, seepCells: st.nSeep, seepVol: st.seepVol, seepLeft: st.seepLeft };
  };
})(window.SS = window.SS || {});
