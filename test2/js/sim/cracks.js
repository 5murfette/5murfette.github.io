/* sim/cracks.js — P66b: cracks in the ground and the structural load check (lab flag CRACKS). Portable, deterministic.
 *
 * Two mechanisms, both only with the flag on (S.crk != null, W.crack != null); with the flag off nothing here runs and
 * not a single number of the sim changes:
 *
 * 1. CRACKS.  Every blast (W >= CRACK.W_MIN) grows N = 3..7 crack SHEETS from the crater wall outward in random 3D
 * directions, plus a
 *    micro damage halo around the crater. A sheet is a thin, wobbly, jagged lens (length = nominal crater radius x
 *    (0.9..2.4) x the brittleness of the material it starts in: rock / ice / sandstone far, soil medium, sand / snow /
 *    ash hardly, steel / bedrock never). The damage is written into W.crack (u8, 0..255, one byte per lattice point,
 *    persistent) and ADDS UP: a blast near an old crack lengthens the new sheets (stress concentration) and saturates
 *    the old voxels. A voxel at CRACK.BREAK (200) or more is an open crack: it carries nothing (collapse.js `supports`
 *    skips it, so a closed sheet cuts a piece loose even though the voxels stay solid). Damaged ground also gives way
 *    wider (blast.js crater: radius x (1 + WEAK_K x damage / 255)) and its fragments shatter into more, smaller pieces
 *    (collapse.js detach -> piece_count).
 *
 * 2. LOAD CHECK (settings.collapse on).  After the crater and the new cracks the solid land around the blast is
 * weighed:
 *      - region    the box around crater + cracks (+2), at most REGION_MAX lattice points per axis;
 *      - ground    anchored voxels (bedrock layer, steel, floating ice) and region-border voxels whose outside
 *      neighbours reach an anchor
 *                  WITHOUT crossing the region; an outside component that reaches none ("loose") is a mass hanging on
 *                  the border voxel (its weight and centroid are added there), so a ledge that sticks out of the region
 *                  is still weighed;
 *      - routes    Dial's shortest-path (integer weights down 2, side 3, up 5) from the ground over solid voxels that
 *      are not open
 *                  cracks: every voxel gets a distance and a set of lower neighbours it leans on;
 *      - load      swept from the far end to the ground (descending distance): a voxel carries its own weight (rho H^3
 *      g) + worms
 *                  (CRACK.WORM_KG) and resting bodies (mass) standing on it + what flowed in, and hands it on to its
 *                  lower neighbours in proportion to the bond capacities. A bond = H^2 x strength(kPa) x K[compression
 *                  8 | shear 3 | tension 1] x (1 - damage / BREAK);
 *      - failure   load x (1 + LEVER x arm) > the sum of the voxel's bond capacities (arm = horizontal distance from
 *      the voxel to the centroid
 *                  of the load it carries: an overhang's lever) -> the voxel breaks (damage 255) and sheds its load.
 *                  Nothing else is needed to separate the piece: collapse.js find_floating then sees it cut off and
 *                  detaches it (Voronoi pieces, rigid bodies, worms fall with it). A 1-voxel neck under a big block
 *    fails the compression / shear test by weight alone, no crack needed. Up to MAX_PASS passes (check -> detach ->
 * check ...), static scratch buffers, voxel visit caps (collapse.js BUDGET): bounded cost. C mapping: W.crack = u8
 * crack[N] (World); S.crk = struct Cracks { u32 n; i32 lastBroken, lastNodes, lastSheets; }; the region scratch (dist
 * i16, ld / mx / mz f32, order i32, Dial pool) are static arrays of REGION_MAX^3; the stamp / stack / visit buffers
 * belong to collapse.c. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT, K = C.CRACK, H = 0.5;
  const EV = C.EV;
  const CR = SS.cracks = {};
  const LAB_BIT = C.LAB.FLAG.CRACKS;
  const NM = C.MATS.length;

  /* material tables */
  const BRITTLE = new Float32Array(NM);                       // how far a crack runs (0 = never cracks)
  {
    const B = {
      rock: 1.0, basalt: 1.0, obsidian: 1.0, ice: 1.0, sandstone: 0.9, crust: 0.85, concrete: 0.6, soil: 0.55, scree: 0.35, ash: 0.2,
      sand: 0.15, snow: 0.15
    };
    for (let m = 0; m < NM; m++) BRITTLE[m] = B[C.MATS[m].name] || 0;
  }
  CR.BRITTLE = BRITTLE;
  const RHO3 = new Float64Array(NM), CAPV = new Float64Array(NM);   // voxel mass (kg), bond capacity of one face (N) per material
  function tables(Hh) {
    for (let m = 0; m < NM; m++) {
      RHO3[m] = C.MATS[m].rho * Hh * Hh * Hh;
      CAPV[m] = M.min(C.MATS[m].strength, K.SIGMA_MAX) * 1000 * Hh * Hh;
    }
  }
  tables(H);

  /* ---------- state ---------- */
  CR.on = S => !!S.crk && !!SS.world.crack;
  CR.init = function (S) {
    const W = SS.world, fl = (S.settings.labFlags | 0) & C.LAB.ALL & LAB_BIT;
    if (!fl) {
      W.crack = null;
      S.crk = null;
      return;
    }
    if (!W.crack || W.crack.length !== W.N) W.crack = new Uint8Array(W.N);
    else W.crack.fill(0);
    tables(W.H);
    S.crk = {
      n: 0, lastBroken: 0, lastNodes: 0, lastSheets: 0, lastPass: 0, lastPieces: 0, maxRatio: 0, maxLoad: 0, maxCap: 0, maxArm: 0,
      maxLvl: 0, firstRatio: 0, firstPieces: 0
    };
    CR.bump(W);
  };
  CR.bump = function (W) { W.crackVer = ((W.crackVer | 0) + 1) | 0; };
  CR.hash = function (S, mix) {
    const W = SS.world, CK = W.crack;
    if (!CK || !S.crk) return;
    mix(S.crk.n);
    let t = 0, u = 0;
    for (let i = 0; i < CK.length; i += 61) t += CK[i];
    for (let i = 7; i < CK.length; i += 4093) u += CK[i] * ((i >> 6) & 15);
    mix(t); mix(u);
  };

  /* ---------- crack growth ---------- */
  const LISTMAX = 60000;
  let lst = null, lval = null;
  let bi0 = 0, bj0 = 0, bk0 = 0, bi1 = 0, bj1 = 0, bk1 = 0;
  const ext = (i, j, k) => {
    if (i < bi0) bi0 = i;
    if (i > bi1) bi1 = i;
    if (j < bj0) bj0 = j;
    if (j > bj1) bj1 = j;
    if (k < bk0) bk0 = k;
    if (k > bk1) bk1 = k;
  };
  const pt = { x: 0, y: 0, z: 0 };

  /* one sheet: start (sx, sy, sz) in the wall, propagation u, length L (m), tangent t, normal nn. Dedupes the voxels it
   * touches (max per sheet),
   * then ADDS the sheet's damage to the field. `stamp` / `stack` are collapse.js scratch (stack = voxel -> list slot
   * map). */
  function sheet(W, SC, sx, sy, sz, ux, uy, uz, tx, ty, tz, L, w0, wobA, sd, fz) {
    const NX = W.NX, NY = W.NY, NZ = W.NZ, D = W.d, MT = W.mat, CK = W.crack, stamp = SC.stamp, map = SC.stack;
    const id = SS.collapse.next_id(), ds = 0.35 * H;
    const nx = uy * tz - uz * ty, ny = uz * tx - ux * tz, nz = ux * ty - uy * tx;
    let n = 0;
    for (let s = 0; s <= L; s += ds) {
      const fr = s / L, w = w0 * Math.sqrt(M.max(0, 1 - fr)), fall = M.pow(1 - fr, 0.7);
      for (let q = -w; q <= w; q += ds) {
        const jg = M.noise2(s * 2.1 + 31, q * 2.1 + 17, sd) - 0.5;
        if (Math.abs(q) > w * (1 + 0.9 * jg)) continue;                                  // jagged outline
        const wob = wobA * (2 * M.fbm2(s * 0.8, q * 0.8, sd + 7, 2) - 1) * (0.3 + 0.7 * M.min(1, s / (0.4 * L + 0.01)));
        const px = sx + ux * s + tx * q + nx * wob, py = sy + uy * s + ty * q + ny * wob, pz = sz + uz * s + tz * q + nz * wob;
        // the voxel and the one 0.62 lattice steps along the normal: the sheet is gap-free for the 6-neighbour flood
        for (let t2 = 0; t2 < 2; t2++) {
          const e = t2 ? 0.62 * H : 0;
          const i = Math.round((px + nx * e) / H), j = Math.round((py + ny * e) / H), k = Math.round((pz + nz * e) / H);
          if (i < 1 || j < 3 || k < 1 || i > NX - 2 || j > NY - 2 || k > NZ - 2) continue;
          const o = (k * NY + j) * NX + i;
          if (D[o] <= 0) continue;
          const b = BRITTLE[MT[o]];
          if (b <= 0) continue;
          if (fz && fz[k * NX + i] >= 0) continue;
          const dmg = K.DMG * fall * (1 - 0.5 * Math.abs(q) / (w + 1e-6)) * M.pow(b, 0.8);
          if (stamp[o] === id) {
            const l = map[o];
            if (dmg > lval[l]) lval[l] = dmg;
          }
          else if (n < LISTMAX) {
            stamp[o] = id;
            map[o] = n;
            lst[n] = o;
            lval[n] = dmg;
            n++;
          }
        }
      }
    }
    for (let l = 0; l < n; l++) {
      const o = lst[l], v = M.min(255, CK[o] + Math.round(lval[l]));
      if (v > CK[o]) {
        CK[o] = v;
        const i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / (NX * NY));
        ext(i, j, k);
      }
    }
    return n;
  }

  function grow(S, c, Wkg, cr) {
    const W = SS.world,
      SC = SS.collapse.scratch(W),
      st = S.crk,
      NX = W.NX,
      NY = W.NY,
      NZ = W.NZ,
      D = W.d,
      MT = W.mat,
      CK = W.crack,
      fz = W.frz ? W.frz.slot : null;
    if (!lst) {
      lst = new Int32Array(LISTMAX);
      lval = new Float32Array(LISTMAX);
    }
    const w3 = M.cbrt(Wkg), R0 = K.R0_K * w3;
    const rng = M.rng_make(
      (
        (
          Math.imul(S.settings.seed | 0, -1640531535)
          ^ Math.imul(st.n, 40503)
          ^ Math.imul(Math.round(c.x * 16), 73856093)
          ^ Math.imul(Math.round(c.y * 16), 19349663)
          ^ Math.imul(Math.round(c.z * 16), 83492791)
        )
        >>> 0
      )
        || 1
    );
    bi0 = bj0 = bk0 = 1e9; bi1 = bj1 = bk1 = -1;
    // the crater's removed voxels carry no damage any more (the field of air is kept clean: a later rebake starts
    // fresh)
    if (cr && cr.box) {
      const b = cr.box;
      for (let k = b.k0; k <= b.k1; k++)
        for (let j = b.j0; j <= b.j1; j++)
          for (let i = b.i0; i <= b.i1; i++) {
            const o = (k * NY + j) * NX + i;
            if (D[o] <= 0) CK[o] = 0;
          }
    }
    const nSheets = M.clamp(Math.floor(K.N0 + K.N_POW * (w3 - 0.5) + M.rng_next(rng) * 2.4), 2, K.N_MAX);
    const smax = 1.35 * R0 + 0.6, pts = [];
    let made = 0;
    for (let n = 0; n < nSheets; n++) {
      // direction: uniform on the sphere
      const uz0 = 2 * M.rng_next(rng) - 1, ph = 2 * M.PI * M.rng_next(rng), rr = Math.sqrt(M.max(0, 1 - uz0 * uz0));
      const ux = rr * M.cos(ph), uy = uz0, uz = rr * M.sin(ph);
      // the first solid voxel along the ray: the crater wall (inside rock that did not give way: at once)
      let found = -1, ss = 0;
      for (let s = 0.2; s <= smax; s += 0.25 * H) {
        const i = Math.round((c.x + ux * s) / H), j = Math.round((c.y + uy * s) / H), k = Math.round((c.z + uz * s) / H);
        if (i < 1 || j < 3 || k < 1 || i > NX - 2 || j > NY - 2 || k > NZ - 2) break;
        const o = (k * NY + j) * NX + i;
        if (D[o] > 0) {
          found = o;
          ss = s;
          break;
        }
      }
      // (the random draws below are made whether or not the ray hit, so the stream does not depend on the terrain it
      // met)
      const rl = M.rng_next(rng),
        rt1 = M.rng_next(rng) * 2 - 1,
        rt2 = M.rng_next(rng) * 2 - 1,
        rt3 = M.rng_next(rng) * 2 - 1,
        rw = M.rng_next(rng),
        sd = M.rng_int(rng, 100000);
      if (found < 0) continue;
      const b = BRITTLE[MT[found]];
      if (b <= 0) continue;
      let L = R0 * (K.LEN0 + rl * K.LEN1) * b * (1 + K.STRESS_K * CK[found] / 255);
      L = M.min(L, K.LEN_MAX);
      if (L < K.LEN_MIN) continue;
      // tangent: a random vector made perpendicular to u
      let tx = rt1, ty = rt2, tz = rt3;
      const dd = tx * ux + ty * uy + tz * uz;
      tx -= dd * ux;
      ty -= dd * uy;
      tz -= dd * uz;
      let tl = M.len3(tx, ty, tz);
      if (tl < 1e-3) {
        tx = -uz;
        ty = 0;
        tz = ux;
        tl = M.len3(tx, ty, tz) || 1;
      }
      tx /= tl; ty /= tl; tz /= tl;
      const sx = c.x + ux * ss, sy = c.y + uy * ss, sz = c.z + uz * ss;
      made += sheet(W, SC, sx, sy, sz, ux, uy, uz, tx, ty, tz, L, L * K.WIDTH_K * (0.6 + 0.4 * rw), K.WOB_K * Math.sqrt(L), sd, fz);
      if (pts.length < 8) pts.push({ x: sx, y: sy, z: sz });
      st.lastSheets++;
    }
    // micro damage halo around the crater
    const Rh = M.min(K.HALO_K * R0, 9);
    const hi0 = M.max(1, Math.floor((c.x - Rh) / H)), hi1 = M.min(NX - 2, Math.ceil((c.x + Rh) / H));
    const hj0 = M.max(3, Math.floor((c.y - Rh) / H)), hj1 = M.min(NY - 2, Math.ceil((c.y + Rh) / H));
    const hk0 = M.max(1, Math.floor((c.z - Rh) / H)), hk1 = M.min(NZ - 2, Math.ceil((c.z + Rh) / H));
    for (let k = hk0; k <= hk1; k++)
      for (let j = hj0; j <= hj1; j++)
        for (let i = hi0; i <= hi1; i++) {
          const o = (k * NY + j) * NX + i;
          if (D[o] <= 0) continue;
          const b = BRITTLE[MT[o]];
          if (b <= 0) continue;
          if (fz && fz[k * NX + i] >= 0) continue;
          const r = M.len3(i * H - c.x, j * H - c.y, k * H - c.z);
          if (r >= Rh) continue;
          const f = 1 - r / Rh, v = Math.round(K.HALO_DMG * b * f * f);
          if (v > 0 && CK[o] < 255) {
            CK[o] = M.min(255, CK[o] + v);
            ext(i, j, k);
          }
        }
    return { pts, made };
  }

  /* ---------- load check ---------- */
  const RM = K.REGION_MAX, RCAP = RM * RM * RM;
  let dist = null, ld = null, mxA = null, mzA = null, order = null, fr = null, pnode = null, pnext = null;
  let par = null, evl = null, dQ = null, dMx = null, dMz = null, dC = null, dCx = null, dCz = null;
  const RECMAX = 64;
  const recSeed = new Int32Array(RECMAX), recD = new Int32Array(RECMAX), recOn = new Uint8Array(RECMAX), recRat = new Float32Array(RECMAX);
  const ckind = new Uint8Array(K.COMPS_MAX + 2), clinks = new Int32Array(K.COMPS_MAX + 2);
  const cmass = new Float64Array(K.COMPS_MAX + 2), ccx = new Float64Array(K.COMPS_MAX + 2), ccz = new Float64Array(K.COMPS_MAX + 2);
  const head = new Int32Array(128);                         // Dial ring (the longest edge weight, W_SIDE, is below 128)
  const nbo = new Int32Array(6), off6 = new Int32Array(6);
  let GID = 0, BLK = 0, SID0 = 0, SIDTOP = 0, ncomp = 0;

  /* flood one outside component down-first (as collapse.js find_floating); stamps: GID reached an anchor, a fresh id =
   * loose component
   * (kind 1: its mass and centroid are kept). Region voxels (BLK) are walls. Returns -1 grounded, or the component
   * index. */
  function dfs(W, SC, o2) {
    const stamp = SC.stamp,
      stack = SC.stack,
      visit = SC.visit,
      NX = W.NX,
      NY = W.NY,
      NZ = W.NZ,
      SXY = NX * NY,
      MT = W.mat,
      KB = SS.collapse.BUDGET,
      anch = SS.collapse.anchored,
      sup = SS.collapse.supports;
    const sid = SS.collapse.next_id(), q = sid - SID0;
    if (q >= K.COMPS_MAX) {
      stamp[o2] = GID;
      return -1;
    }
    SIDTOP = sid;
    let sp = 0, nv = 0, ok = false, m = 0, mx = 0, mz = 0;
    stack[sp++] = o2; stamp[o2] = sid;
    while (sp > 0) {
      const o = stack[--sp];
      if (nv < KB) visit[nv] = o;
      nv++;
      if (anch(W, o) || nv > KB) {
        ok = true;
        break;
      }
      const ii = o % NX, jj = Math.floor(o / NX) % NY, kk = Math.floor(o / SXY), mv = RHO3[MT[o]];
      m += mv; mx += mv * ii * H; mz += mv * kk * H;
      nbo[0] = jj < NY - 1 ? o + NX : -1;
      nbo[1] = ii > 0 ? o - 1 : -1;
      nbo[2] = ii < NX - 1 ? o + 1 : -1;
      nbo[3] = kk > 0 ? o - SXY : -1;
      nbo[4] = kk < NZ - 1 ? o + SXY : -1;
      nbo[5] = jj > 0 ? o - NX : -1;
      for (let t = 0; t < 6; t++) {
        const n = nbo[t];
        if (n < 0 || !sup(W, n)) continue;
        const s2 = stamp[n];
        if (s2 === BLK) continue;
        if (s2 === GID) {
          ok = true;
          sp = 0;
          break;
        }
        if (s2 !== sid) {
          stamp[n] = sid;
          stack[sp++] = n;
        }
      }
    }
    if (ok) {
      const cnt = M.min(nv, KB);
      for (let t = 0; t < cnt; t++) stamp[visit[t]] = GID;
      stamp[o2] = GID;
      return -1;
    }
    ckind[q] = 1;
    cmass[q] = m;
    ccx[q] = mx / M.max(m, 1e-9);
    ccz[q] = mz / M.max(m, 1e-9);
    clinks[q] = 0;
    if (q >= ncomp) ncomp = q + 1;
    return q;
  }
  function status(W, SC, o2) {
    const s = SC.stamp[o2];
    if (s === GID) return -1;
    const q = s - SID0;
    if (q > 0 && q < K.COMPS_MAX && s <= SIDTOP && ckind[q] === 1) return q;
    return dfs(W, SC, o2);
  }
  function find(a) {
    while (par[a] !== a) {
      par[a] = par[par[a]];
      a = par[a];
    }
    return a;
  }

  /* The weighing. Every node (solid voxel that is not an open crack) gets a distance from the ground (Dial shortest
   * paths, a step down 2,
   * sideways 3, up 5). The sets {nodes with distance >= d} are swept from the far end to the ground; the connected
   * pieces K of such a set are exactly what a cut across the structure at "level d" would drop: K must be held by the
   * bonds that cross from K to lower nodes (compression for a node below, shear sideways, tension for a node above,
   * each x (1 - damage)): capacity C(K). Its load is the weight of K (+ worms, bodies, loose outside masses) x (1 +
   * LEVER x arm), arm = horizontal distance from K's centre of mass to the centre of those bonds (the lever of an
   * overhang). Pieces are tracked incrementally (union-find with sums, each edge counted once as it stops being a
   * crossing edge), so the cost is one pass over the region. A piece with load > C(K) fails: the largest failing piece
   * of every chain is cut off at its crossing (its boundary voxels become open cracks) and find_floating (collapse.js)
   * detaches it. A wide body is safe by construction (bonds grow with its footprint as its weight does), a neck, a thin
   * strip, a cracked root is not. Returns the number of voxels broken; reg = the region box used. */
  function check(S, c, box, reg) {
    const W = SS.world, CL = SS.collapse, SC = CL.scratch(W), stamp = SC.stamp;
    const NX = W.NX, NY = W.NY, NZ = W.NZ, SXY = NX * NY, MT = W.mat, CK = W.crack, BR = K.BREAK, Hh = W.H, G = K.G;
    if (!dist) {
      dist = new Int16Array(RCAP);
      ld = new Float32Array(RCAP);
      mxA = new Float32Array(RCAP);
      mzA = new Float32Array(RCAP);
      order = new Int32Array(RCAP);
      fr = new Int32Array(6 * RM * RM); pnode = new Int32Array(7 * RCAP); pnext = new Int32Array(7 * RCAP);
      par = new Int32Array(RCAP); evl = new Int32Array(RCAP);
      dQ = new Float64Array(RCAP);
      dMx = new Float64Array(RCAP);
      dMz = new Float64Array(RCAP);
      dC = new Float64Array(RCAP);
      dCx = new Float64Array(RCAP);
      dCz = new Float64Array(RCAP);
    }
    // region box: the crack / crater box + 2, clipped to the lattice and to REGION_MAX around the blast
    const ci = Math.round(c.x / Hh), cj = Math.round(c.y / Hh), ck = Math.round(c.z / Hh), hr = RM >> 1;
    const i0 = M.max(1, box.i0 - 2, ci - hr), i1 = M.min(NX - 2, box.i1 + 2, ci + hr - 1);
    const j0 = M.max(1, box.j0 - 2, cj - hr), j1 = M.min(NY - 2, box.j1 + 2, cj + hr - 1);
    const k0 = M.max(1, box.k0 - 2, ck - hr), k1 = M.min(NZ - 2, box.k1 + 2, ck + hr - 1);
    if (i1 < i0 || j1 < j0 || k1 < k0) return 0;
    const nx = i1 - i0 + 1, ny = j1 - j0 + 1, nz = k1 - k0 + 1, nxy = nx * ny, o0 = (k0 * NY + j0) * NX + i0;
    reg.i0 = i0;
    reg.j0 = j0;
    reg.k0 = k0;
    reg.i1 = i1;
    reg.j1 = j1;
    reg.k1 = k1;
    BLK = CL.next_id();
    GID = CL.next_id();
    SID0 = CL.next_id();
    SIDTOP = SID0;
    ncomp = 0;
    ckind.fill(0);                                                          // (loose component kinds of the previous check are stale)
    const sup = CL.supports, anch = CL.anchored;
    off6[0] = 1;
    off6[1] = -1;
    off6[2] = nx;
    off6[3] = -nx;
    off6[4] = nxy;
    off6[5] = -nxy;
    // world offsets of +x, +y, +z (the -x, -y, -z ones are their negatives)
    const wo0 = 1, wo2 = NX, wo4 = SXY;
    const wof = t => (t & 1 ? -1 : 1) * (t < 2 ? wo0 : t < 4 ? wo2 : wo4);
    // 1. nodes (solid voxels that are not open cracks); border list
    let nfr = 0;
    for (let lk = 0; lk < nz; lk++)
      for (let lj = 0; lj < ny; lj++)
        for (let li = 0; li < nx; li++) {
          const r = (lk * ny + lj) * nx + li, o = o0 + lj * NX + lk * SXY + li;
          ld[r] = 0; mxA[r] = 0; mzA[r] = 0;
          if (sup(W, o)) {
            dist[r] = -1; stamp[o] = BLK;
            if (li === 0 || lj === 0 || lk === 0 || li === nx - 1 || lj === ny - 1 || lk === nz - 1) fr[nfr++] = r;
          } else dist[r] = -2;
        }
    // 2. outside components touching the border: grounded (the border voxel is a ground seed) or loose (its mass hangs
    // on the border voxel)
    for (let pass = 0; pass < 2; pass++) {
      for (let f = 0; f < nfr; f++) {
        const r = fr[f],
          lk = Math.floor(r / nxy),
          lj = Math.floor((r - lk * nxy) / nx),
          li = r - lk * nxy - lj * nx,
          o = o0 + lj * NX + lk * SXY + li;
        for (let q = 0; q < 6; q++) {
          const out = q === 0
            ? li === nx - 1
            : q === 1
            ? li === 0
            : q === 2
            ? lj === ny - 1
            : q === 3
            ? lj === 0
            : q === 4
            ? lk === nz - 1
            : lk === 0;
          if (!out) continue;
          const o2 = o + wof(q);
          if (!sup(W, o2)) continue;
          const st = status(W, SC, o2);
          if (pass === 0) {
            if (st >= 0) clinks[st]++;
            else dist[r] = 0;
          }
          else if (st >= 0) {
            const share = cmass[st] * G / M.max(1, clinks[st]);
            ld[r] += share; mxA[r] += share * ccx[st]; mzA[r] += share * ccz[st];
          }
        }
      }
    }
    // 3. ground seeds + Dial shortest paths (a step down 1, up 3, sideways W_SIDE 64: a step sideways costs more than
    // any climb of the region, so the order is first by sideways path length)
    for (let b = 0; b < 128; b++) head[b] = -1;
    let pn = 0, active = 0, no = 0;
    for (let lk = 0; lk < nz; lk++)
      for (let lj = 0; lj < ny; lj++)
        for (let li = 0; li < nx; li++) {
          const r = (lk * ny + lj) * nx + li;
          if (dist[r] === -2) continue;
          const o = o0 + lj * NX + lk * SXY + li;
          if (dist[r] === 0 || anch(W, o)) {
            dist[r] = 0;
            pnode[pn] = r;
            pnext[pn] = head[0];
            head[0] = pn;
            pn++;
            active++;
          }
        }
    for (let d = 0; active > 0; d++) {
      const b = d & 127;
      while (head[b] >= 0) {
        const e = head[b];
        head[b] = pnext[e];
        active--;
        const r = pnode[e];
        if (dist[r] !== d) continue;
        order[no++] = r;
        const lk = Math.floor(r / nxy), lj = Math.floor((r - lk * nxy) / nx), li = r - lk * nxy - lj * nx;
        for (let q = 0; q < 6; q++) {
          if (
            (q === 0 && li === nx - 1)
            || (q === 1 && li === 0)
            || (q === 2 && lj === ny - 1)
            || (q === 3 && lj === 0)
            || (q === 4 && lk === nz - 1)
            || (q === 5 && lk === 0)
          ) continue;
          const u = r + off6[q], du = dist[u];
          if (du === -2) continue;
          // u above r: u's load flows down to r; u below r: up; else sideways
          const nd = d + (q === 2 ? K.W_DOWN : q === 3 ? K.W_UP : K.W_SIDE);
          if (du === -1 || nd < du) {
            dist[u] = nd;
            pnode[pn] = u;
            pnext[pn] = head[nd & 127];
            head[nd & 127] = pn;
            pn++;
            active++;
          }
        }
      }
    }
    // 4. loads: own weight, worms and bodies standing on the land (kept in ld / mxA / mzA: load, load x x, load x z)
    for (let q = 0; q < no; q++) {
      const r = order[q],
        lk = Math.floor(r / nxy),
        lj = Math.floor((r - lk * nxy) / nx),
        li = r - lk * nxy - lj * nx,
        o = o0 + lj * NX + lk * SXY + li;
      const w = RHO3[MT[o]] * G;
      ld[r] += w;
      mxA[r] += w * (i0 + li) * Hh;
      mzA[r] += w * (k0 + lk) * Hh;
    }
    const put = (x, y, z, kg) => {
      const li = Math.round(x / Hh) - i0, lk = Math.round(z / Hh) - k0;
      if (li < 0 || lk < 0 || li >= nx || lk >= nz) return;
      for (let j = Math.round(y / Hh) - j0, t = 0; t < 8 && j >= 0; t++, j--) {
        if (j >= ny) continue;
        const r = (lk * ny + j) * nx + li;
        if (dist[r] >= 0) {
          const w = kg * G;
          ld[r] += w;
          mxA[r] += w * x;
          mzA[r] += w * z;
          return;
        }
      }
    };
    for (const w of S.worms)
      if (!w.dead) put(w.pos.x, w.pos.y - 0.25, w.pos.z, K.WORM_KG);
    for (const b of S.bodies)
      if (b.asleep && b.mass > 0) put(b.pos.x, b.pos.y - 0.3, b.pos.z, b.mass);
    // 5. sweep the levels from the far end to the ground, growing the pieces of {dist >= d}
    for (let q = 0; q < no; q++) par[order[q]] = -1;
    let nrec = 0, lvl = 0, mxRat = 0, mxDem = 0, mxCap = 0, mxArm = 0, mxLvl = 0;
    const ls = M.max(K.LEVER, 0);
    for (let hi = no; hi > 0;) {
      const dl = dist[order[hi - 1]];
      let lo = hi - 1;
      while (lo > 0 && dist[order[lo - 1]] === dl) lo--;
      // the ground itself is never added: bonds to it are the crossing edges
      if (dl === 0) break;
      lvl++;
      for (let q = hi - 1; q >= lo; q--) {
        const r = order[q],
          lk = Math.floor(r / nxy),
          lj = Math.floor((r - lk * nxy) / nx),
          li = r - lk * nxy - lj * nx,
          o = o0 + lj * NX + lk * SXY + li;
        const x = (i0 + li) * Hh, z = (k0 + lk) * Hh, mv = MT[o], ckv = CK[o];
        par[r] = r;
        evl[r] = 0;
        dQ[r] = ld[r];
        dMx[r] = mxA[r];
        dMz[r] = mzA[r];
        dC[r] = 0;
        dCx[r] = 0;
        dCz[r] = 0;
        for (let t = 0; t < 6; t++) {
          if (
            (t === 0 && li === nx - 1)
            || (t === 1 && li === 0)
            || (t === 2 && lj === ny - 1)
            || (t === 3 && lj === 0)
            || (t === 4 && lk === nz - 1)
            || (t === 5 && lk === 0)
          ) continue;
          const u = r + off6[t];
          if (dist[u] < 0) continue;
          const ou = o + wof(t);
          // u is in the set already: the edge u -> v stops crossing, the pieces join
          if (par[u] >= 0) {
            const a = find(u), ul = Math.floor(u / nxy), uj = Math.floor((u - ul * nxy) / nx), ui = u - ul * nxy - uj * nx;
            // the bond as seen from u (v lies in direction t ^ 1 from u)
            const kd = (t ^ 1) === 3 ? K.K_COMP : (t ^ 1) === 2 ? K.K_TENS : K.K_SIDE;
            const cu = M.min(CAPV[MT[ou]], CAPV[mv]) * kd * M.max(K.MIN_DAMAGE, 1 - M.max(CK[ou], ckv) / BR);
            dC[a] -= cu; dCx[a] -= cu * (i0 + ui) * Hh; dCz[a] -= cu * (k0 + ul) * Hh;
            const b = find(r);
            if (a !== b) {
              par[a] = b;
              dQ[b] += dQ[a];
              dMx[b] += dMx[a];
              dMz[b] += dMz[a];
              dC[b] += dC[a];
              dCx[b] += dCx[a];
              dCz[b] += dCz[a];
            }
          } else {                                                          // u is lower or not yet added: the bond v -> u crosses
            const kd = t === 3 ? K.K_COMP : t === 2 ? K.K_TENS : K.K_SIDE;
            const cv = M.min(CAPV[MT[ou]], CAPV[mv]) * kd * M.max(K.MIN_DAMAGE, 1 - M.max(CK[ou], ckv) / BR);
            const b = find(r);
            dC[b] += cv;
            dCx[b] += cv * x;
            dCz[b] += cv * z;
          }
        }
      }
      // evaluate every piece that has a node at this level
      for (let q = lo; q < hi; q++) {
        const a = find(order[q]);
        if (evl[a] === lvl) continue;
        evl[a] = lvl;
        const Q = dQ[a], C = dC[a];
        if (Q <= 0) continue;
        const arm = M.len3(dMx[a] / Q - (C > 1e-6 ? dCx[a] / C : dMx[a] / Q), 0, dMz[a] / Q - (C > 1e-6 ? dCz[a] / C : dMz[a] / Q));
        const dem = Q * (1 + ls * arm);
        // (diagnostics: the weakest piece)
        {
          const rt = dem / M.max(C, 1e-6);
          if (rt > mxRat) {
            mxRat = rt;
            mxDem = dem;
            mxCap = C;
            mxArm = arm;
            mxLvl = dl;
          }
        }
        if (dem > M.max(C, 1e-6)) {
          // the larger piece supersedes the smaller ones inside it
          for (let e = 0; e < nrec; e++)
            if (recOn[e] && find(recSeed[e]) === a) recOn[e] = 0;
          if (nrec < RECMAX) {
            recSeed[nrec] = order[q];
            recD[nrec] = dl;
            recOn[nrec] = 1;
            recRat[nrec] = dem / M.max(C, 1e-6);
            nrec++;
          }
        }
      }
      hi = lo;
    }
    // 6. cut: every surviving failing piece loses the voxels that bond it to lower ground (they become open cracks)
    let broken = 0;
    for (let e = 0; e < nrec; e++) {
      if (!recOn[e]) continue;
      const seed = recSeed[e], dd = recD[e];
      // (reuse: dQ < 0 marks the flooded piece)
      let sp = 0;
      order[0] = seed;
      sp = 1;
      dQ[seed] = -1;
      let n2 = 0;
      while (sp > 0) {
        const r = order[--sp];
        pnode[n2++] = r;
        const lk = Math.floor(r / nxy), lj = Math.floor((r - lk * nxy) / nx), li = r - lk * nxy - lj * nx;
        for (let t = 0; t < 6; t++) {
          if (
            (t === 0 && li === nx - 1)
            || (t === 1 && li === 0)
            || (t === 2 && lj === ny - 1)
            || (t === 3 && lj === 0)
            || (t === 4 && lk === nz - 1)
            || (t === 5 && lk === 0)
          ) continue;
          const u = r + off6[t];
          if (dist[u] < dd || dQ[u] < 0) continue;
          dQ[u] = -1; order[sp++] = u;
        }
      }
      for (let q = 0; q < n2; q++) {
        const r = pnode[q], lk = Math.floor(r / nxy), lj = Math.floor((r - lk * nxy) / nx), li = r - lk * nxy - lj * nx;
        let edge = false;
        for (let t = 0; t < 6 && !edge; t++) {
          if (
            (t === 0 && li === nx - 1)
            || (t === 1 && li === 0)
            || (t === 2 && lj === ny - 1)
            || (t === 3 && lj === 0)
            || (t === 4 && lk === nz - 1)
            || (t === 5 && lk === 0)
          ) continue;
          const u = r + off6[t];
          if (dist[u] >= 0 && dist[u] < dd) edge = true;
        }
        if (edge) {
          CK[o0 + lj * NX + lk * SXY + li] = 255;
          broken++;
        }
      }
    }
    S.crk.lastNodes = no;
    S.crk.lastPieces = nrec;
    S.crk.maxRatio = mxRat;
    S.crk.maxLoad = mxDem;
    S.crk.maxCap = mxCap;
    S.crk.maxArm = mxArm;
    S.crk.maxLvl = mxLvl;
    return broken;
  }

  /* load check passes around lattice box `box` (grown in place by what was probed): returns the voxels broken. The
   * pieces that came
   * loose are detached by the caller's collapse_hook (blast.js) afterwards: a broken voxel is an open crack,
   * collapse.js find_floating sees what it cut off. */
  CR.settle = function (S, c, box) {
    const W = SS.world,
      st = S.crk,
      reg = { i0: 0, j0: 0, k0: 0, i1: 0, j1: 0, k1: 0 },
      b0 = { i0: box.i0, j0: box.j0, k0: box.k0, i1: box.i1, j1: box.j1, k1: box.k1 };
    let total = 0;
    for (let pass = 0; pass < K.MAX_PASS; pass++) {
      const nb = check(S, c, b0, reg);
      total += nb; st.lastBroken += nb; st.lastPass = pass + 1;
      if (pass === 0) {
        st.firstRatio = st.maxRatio;
        st.firstPieces = st.lastPieces;
      }
      if (!nb) break;
      W.mark(reg.i0, reg.j0, reg.k0, reg.i1, reg.j1, reg.k1);
      CR.bump(W);
      box.i0 = M.min(box.i0, reg.i0);
      box.j0 = M.min(box.j0, reg.j0);
      box.k0 = M.min(box.k0, reg.k0);
      box.i1 = M.max(box.i1, reg.i1);
      box.j1 = M.max(box.j1, reg.j1);
      box.k1 = M.max(box.k1, reg.k1);
    }
    return total;
  };

  /* ---------- blast hook ----------
   * Called by blast.js after the crater (c: centre, Wkg: the charge that dug it, cr: BL.crater result). Returns the
   * lattice box to probe for collapse (crater + cracks + weakened voxels), or null when nothing happened. */
  CR.blast = function (S, c, Wkg, cr) {
    const W = SS.world, st = S.crk;
    if (!W.crack || !st || !(Wkg >= K.W_MIN)) return null;
    st.n++;
    st.lastBroken = 0;
    st.lastSheets = 0;
    st.lastPass = 0;
    const g = grow(S, c, Wkg, cr);
    if (bi1 < 0 && !(cr && cr.box)) return null;
    const box = {
      i0: bi1 < 0 ? cr.box.i0 : bi0,
      j0: bi1 < 0 ? cr.box.j0 : bj0,
      k0: bi1 < 0 ? cr.box.k0 : bk0,
      i1: bi1 < 0 ? cr.box.i1 : bi1,
      j1: bi1 < 0 ? cr.box.j1 : bj1,
      k1: bi1 < 0 ? cr.box.k1 : bk1
    };
    if (cr && cr.box) {
      const b = cr.box;
      box.i0 = M.min(box.i0, b.i0);
      box.j0 = M.min(box.j0, b.j0);
      box.k0 = M.min(box.k0, b.k0);
      box.i1 = M.max(box.i1, b.i1);
      box.j1 = M.max(box.j1, b.j1);
      box.k1 = M.max(box.k1, b.k1);
    }
    if (W.flat) SS.dim2d.flatten(W, box.i0, box.j0, box.i1, box.j1);   // P68a 2D: the sheets grew in 3D, keep the slab's slices identical
    CR.bump(W);
    SS.sim.emit(S, EV.CRACK, { x: c.x, y: c.y, z: c.z, n: st.lastSheets, pts: g.pts });
    if (S.settings.collapse) CR.settle(S, c, box);
    return box;
  };

  /* ---------- collapse.js hooks ---------- */
  /* how many Voronoi pieces a detached component breaks into: damaged ground shatters (more, smaller pieces) */
  CR.piece_count = function (W, comp, base) {
    const CK = W.crack, n = comp.length;
    let t = 0;
    for (let q = 0; q < n; q++) t += CK[comp[q]];
    if (t <= 0) return base;
    const k = 1 - K.PIECE_CRACK * (t / n) / 255;
    return M.max(base, M.clamp(Math.round(n / (K.PIECE_N * k)), 1, K.PIECE_MAX));
  };
  /* a component was cut out: its voxels start clean (settled rubble is fresh), and the open cracks that bounded it
   * become air (the gap) */
  CR.detached = function (W, comp) {
    const CK = W.crack, D = W.d, MT = W.mat, HT = W.heat, NX = W.NX, NY = W.NY, NZ = W.NZ, SXY = NX * NY, n = comp.length, BR = K.BREAK;
    for (let q = 0; q < n; q++) CK[comp[q]] = 0;
    for (let q = 0; q < n; q++) {
      const o = comp[q], ii = o % NX, jj = Math.floor(o / NX) % NY, kk = Math.floor(o / SXY);
      nbo[0] = ii > 0 ? o - 1 : -1;
      nbo[1] = ii < NX - 1 ? o + 1 : -1;
      nbo[2] = jj > 0 ? o - NX : -1;
      nbo[3] = jj < NY - 1 ? o + NX : -1;
      nbo[4] = kk > 0 ? o - SXY : -1;
      nbo[5] = kk < NZ - 1 ? o + SXY : -1;
      for (let t = 0; t < 6; t++) {
        const m = nbo[t];
        if (m >= 0 && D[m] > 0 && CK[m] >= BR) {
          D[m] = -0.6;
          MT[m] = MAT.AIR;
          HT[m] = 0;
          CK[m] = 0;
        }
      }
    }
    CR.bump(W);
  };
})(window.SS = window.SS || {});
