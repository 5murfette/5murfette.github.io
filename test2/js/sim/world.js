/* sim/world.js — the shared volumetric world (engine-agnostic: typed arrays + pure functions).
 * The battlefield is a signed density field d (positive = solid, ≈ metres inside the surface) on a
 * 0.5 m lattice, plus a material id and a heat byte per lattice point. Every view, collision query,
 * crater, flow automaton and minimap reads this single store.
 *
 * C layout:  struct World { f32 d[N]; u8 mat[N]; u8 heat[N]; f32 top[NX*NZ]; u32 chunkVer[CX*CY*CZ]; ... };
 * Index:     idx(i,j,k) = (k*NY + j)*NX + i      (x fastest, then y, then z — matches a 3D texture). */
(function (SS) {
  'use strict';
  const M = SS.math;
  const C = SS.CFG, MAT = C.MAT;
  const W = { SX: 96, SZ: 96, SY: 40, H: 0.5, SEA: 3, SEA_WET: 3, dry: false };   // SEA / dry: set per world by worldgen (C.DRY)
  W.NX = Math.round(W.SX / W.H) + 1;
  W.NY = Math.round(W.SY / W.H) + 1;
  W.NZ = Math.round(W.SZ / W.H) + 1;
  W.N = W.NX * W.NY * W.NZ;
  W.d = new Float32Array(W.N);
  W.mat = new Uint8Array(W.N);
  W.heat = new Uint8Array(W.N);          // lava temperature (255 = fed by a source, never cools)
  W.top = new Float32Array(W.NX * W.NZ); // y of the highest solid surface per lattice column
  W.topJ = new Int16Array(W.NX * W.NZ);  // j of the highest solid lattice point (-1 = none)
  W.version = 0;
  W.biome = 'temperate';
  W.under = false; W.dry = false;          // world kind flags (worldgen.G.begin sets them per map)
  W.features = {};                       // generator output: volcano, canals, lavaInit, pockets, vents... (read-only for others)
  const NX = W.NX, NY = W.NY, NZ = W.NZ, H = W.H, SXY = NX * NY;
  const idx = (i, j, k) => (k * NY + j) * NX + i;
  W.idx = idx;

  /* ---------- meshing chunks (render rebuilds a chunk when its version changes) ---------- */
  W.CS = 32;
  W.CX = Math.ceil((NX - 1) / W.CS); W.CY = Math.ceil((NY - 1) / W.CS); W.CZ = Math.ceil((NZ - 1) / W.CS);
  W.chunkVer = new Uint32Array(W.CX * W.CY * W.CZ);
  W.dirtyBox = null;                     // union of edited lattice boxes since the renderer last consumed it
  W.listeners = [];                      // sim modules told about every edit: fn(i0, k0, i1, k1) (lattice columns)

  /* Record an edit of lattice box [i0..i1]x[j0..j1]x[k0..k1]: bump versions, refresh column tops. */
  // quiet: renderers only (versions, dirty box, tops), the sim listeners are not told (sim.restore: their pending
  // edit rects come back from the snapshot instead of a whole-lattice refresh that perturbs the water)
  W.mark = function (i0, j0, k0, i1, j1, k1, quiet) {
    i0 = Math.max(0, i0); j0 = Math.max(0, j0); k0 = Math.max(0, k0);
    i1 = Math.min(NX - 1, i1); j1 = Math.min(NY - 1, j1); k1 = Math.min(NZ - 1, k1);
    if (i1 < i0 || j1 < j0 || k1 < k0) return;
    if (W.frz) restore_frozen(i0, j0, k0, i1, j1, k1);
    W.version++;
    const CS = W.CS;
    const ci0 = Math.max(0, Math.floor((i0 - 2) / CS)), ci1 = Math.min(W.CX - 1, Math.floor((i1 + 1) / CS));
    const cj0 = Math.max(0, Math.floor((j0 - 2) / CS)), cj1 = Math.min(W.CY - 1, Math.floor((j1 + 1) / CS));
    const ck0 = Math.max(0, Math.floor((k0 - 2) / CS)), ck1 = Math.min(W.CZ - 1, Math.floor((k1 + 1) / CS));
    for (let c = ck0; c <= ck1; c++) for (let b = cj0; b <= cj1; b++) for (let a = ci0; a <= ci1; a++) W.chunkVer[(c * W.CY + b) * W.CX + a]++;
    const D = W.dirtyBox;
    if (!D) W.dirtyBox = { i0, j0, k0, i1, j1, k1 };
    else { D.i0 = Math.min(D.i0, i0); D.j0 = Math.min(D.j0, j0); D.k0 = Math.min(D.k0, k0); D.i1 = Math.max(D.i1, i1); D.j1 = Math.max(D.j1, j1); D.k1 = Math.max(D.k1, k1); }
    W.update_tops(i0, k0, i1, k1);
    if (!quiet) for (let q = 0; q < W.listeners.length; q++) W.listeners[q](i0, k0, i1, k1);
  };
  W.mark_all = function (quiet) { W.mark(0, 0, 0, NX - 1, NY - 1, NZ - 1, quiet); };

  /* D6 frozen ring (dry worlds): the lattice columns farther than r from (cx, cz) keep their generated state for good.
   * Every edit path ends in W.mark, which puts those columns back (blast.js / carve also skip them, so the counts of
   * removed material stay right). Only the disc r is destructible; beyond the disc C.DRY.LAT_R the ground is W.far,
   * which these columns match (worldgen's radial border band), so the crater wall always ends inside the disc.
   * C: int32 slot per column (-1 = editable) + a compact copy of d / mat / heat for the frozen columns. */
  W.frz = null;
  W.freeze_beyond = function (cx, cz, r) {
    const slot = new Int32Array(NX * NZ).fill(-1);
    let n = 0;
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) if (M.len2(i * H - cx, k * H - cz) > r) slot[k * NX + i] = n++;
    const d = new Float32Array(n * NY), m = new Uint8Array(n * NY), ht = new Uint8Array(n * NY);
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      const s = slot[k * NX + i];
      if (s < 0) continue;
      for (let j = 0; j < NY; j++) { const o = idx(i, j, k), q = s * NY + j; d[q] = W.d[o]; m[q] = W.mat[o]; ht[q] = W.heat[o]; }
    }
    W.frz = { slot, d, m, ht, n };
  };
  function restore_frozen(i0, j0, k0, i1, j1, k1) {
    const F = W.frz;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const s = F.slot[k * NX + i];
      if (s < 0) continue;
      for (let j = j0; j <= j1; j++) { const o = idx(i, j, k), q = s * NY + j; W.d[o] = F.d[q]; W.mat[o] = F.m[q]; W.heat[o] = F.ht[q]; }
    }
  }
  W.frozen_col = (i, k) => !!W.frz && W.frz.slot[k * NX + i] >= 0;

  W.update_tops = function (i0, k0, i1, k1) {
    const D = W.d;
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      let j = NY - 1, o = idx(i, j, k);
      while (j >= 0 && D[o] <= 0) { j--; o -= NX; }
      const c = k * NX + i;
      W.topJ[c] = j;
      if (j < 0) { W.top[c] = 0; continue; }
      const a = D[o], b = j < NY - 1 ? D[o + NX] : -1;
      W.top[c] = (j + (a > 0 && b <= 0 ? a / (a - b) : 0)) * H;
    }
  };

  /* ---------- sampling ---------- */
  /* Beyond the lattice: air (-3), or on a dry world (D4) the analytic far dunes W.far(x, z) (set by worldgen; the
   * lattice's outer band equals it on the border, so the field continues across it): worms, bodies and blasts out
   * there stand, roll and walk on the same ground the render draws. */
  W.far = null;
  /* D6: on a dry world the lattice part is a disc (W.circ = { x, z, r }: C.DRY.LAT_R about the map centre, set by
   * worldgen); beyond it W.far is the ground. Wet worlds: the lattice square. */
  W.circ = null;
  const outside = (x, z) => {
    const c = W.circ;
    if (c) { const dx = x - c.x, dz = z - c.z; return dx * dx + dz * dz > c.r * c.r; }
    return x < 0 || z < 0 || x > W.SX || z > W.SZ;
  };
  W.outside = outside;
  W.sample = function (x, y, z) {
    if (outside(x, z)) {
      if (!W.far) return -3;
      const d = W.far(x, z) - y;
      return d > 3 ? 3 : d < -3 ? -3 : d;
    }
    if (y <= 0) return 3;
    if (y >= W.SY) return -3;
    const fx = x / H, fy = y / H, fz = z / H;
    let i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i > NX - 2) i = NX - 2; if (j > NY - 2) j = NY - 2; if (k > NZ - 2) k = NZ - 2;
    const u = fx - i, v = fy - j, w = fz - k, D = W.d;
    const o = idx(i, j, k);
    const c00 = D[o] + (D[o + 1] - D[o]) * u, c10 = D[o + NX] + (D[o + NX + 1] - D[o + NX]) * u;
    const c01 = D[o + SXY] + (D[o + SXY + 1] - D[o + SXY]) * u, c11 = D[o + SXY + NX] + (D[o + SXY + NX + 1] - D[o + SXY + NX]) * u;
    const c0 = c00 + (c10 - c00) * v, c1 = c01 + (c11 - c01) * v;
    return c0 + (c1 - c0) * w;
  };
  W.solid = (x, y, z) => W.sample(x, y, z) > 0;
  /* outward surface normal (points from solid into air) */
  W.normal = function (x, y, z, out) {
    const e = 0.2;
    let gx = W.sample(x + e, y, z) - W.sample(x - e, y, z), gy = W.sample(x, y + e, z) - W.sample(x, y - e, z), gz = W.sample(x, y, z + e) - W.sample(x, y, z - e);
    const l = M.len3(gx, gy, gz);
    if (l < 1e-6) { gx = 0; gy = -1; gz = 0; } else { gx /= l; gy /= l; gz /= l; }
    out.x = -gx; out.y = -gy; out.z = -gz;
    return out;
  };
  /* material of the most solid of the 8 lattice points around (x,y,z); AIR if none is solid */
  W.mat_at = function (x, y, z) {
    if (W.far && outside(x, z)) return W.sample(x, y, z) > 0 ? MAT.SAND : MAT.AIR;   // dry: the far dunes are sand
    const i = Math.max(0, Math.min(NX - 2, Math.floor(x / H))), j = Math.max(0, Math.min(NY - 2, Math.floor(y / H))), k = Math.max(0, Math.min(NZ - 2, Math.floor(z / H)));
    let best = 0, bd = 0;
    for (let q = 0; q < 8; q++) {
      const o = idx(i + (q & 1), j + ((q >> 1) & 1), k + (q >> 2));
      if (W.d[o] > bd) { bd = W.d[o]; best = W.mat[o]; }
    }
    return best;
  };
  W.in_bounds = (i, j, k) => i >= 0 && j >= 0 && k >= 0 && i < NX && j < NY && k < NZ;

  /* Highest solid surface at (x,z) (fine walk downward from the coarse column top). */
  W.topHeight = function (x, z) {
    if (W.far && outside(x, z)) return Math.max(0, W.far(x, z));
    const i = Math.max(0, Math.min(NX - 1, Math.round(x / H))), k = Math.max(0, Math.min(NZ - 1, Math.round(z / H)));
    let y0 = 0;
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
      const ii = Math.max(0, Math.min(NX - 1, i + di)), kk = Math.max(0, Math.min(NZ - 1, k + dk));
      y0 = Math.max(y0, W.top[kk * NX + ii]);
    }
    for (let y = Math.min(W.SY - 0.25, y0 + 1); y > 0; y -= 0.1) if (W.sample(x, y, z) > 0) return y;
    return 0;
  };
  /* coarse column top (bilinear over lattice columns) — cheap, for sky exposure / water beds */
  W.top_at = function (x, z) {
    if (W.far && outside(x, z)) return Math.max(0, W.far(x, z));
    const fx = Math.max(0, Math.min(NX - 1.001, x / H)), fz = Math.max(0, Math.min(NZ - 1.001, z / H));
    const i = Math.floor(fx), k = Math.floor(fz), u = fx - i, v = fz - k, T = W.top;
    const a = T[k * NX + i], b = T[k * NX + i + 1], c = T[(k + 1) * NX + i], d = T[(k + 1) * NX + i + 1];
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };

  /* Metres of solid along the segment p0->p1 (blast-wave shielding, line of sight). */
  W.solid_len = function (x0, y0, z0, x1, y1, z1) {
    const L = M.len3(x1 - x0, y1 - y0, z1 - z0), n = Math.max(1, Math.ceil(L / 0.25)), st = L / n;
    let s = 0;
    for (let i = 1; i < n; i++) { const t = i / n; if (W.sample(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t) > 0) s += st; }
    return s;
  };
  /* First solid hit from p along unit dir d within maxD; returns distance or -1. */
  W.raycast = function (x, y, z, dx, dy, dz, maxD) {
    for (let r = 0; r <= maxD; r += 0.15) if (W.sample(x + dx * r, y + dy * r, z + dz * r) > 0) return r;
    return -1;
  };

  /* ---------- editing primitives ---------- */
  /* Plain spherical cut (material-agnostic). Blast craters use SS.blast (material-aware). */
  W.carve = function (cx, cy, cz, R) {
    const i0 = Math.max(0, Math.floor((cx - R - 1) / H)), i1 = Math.min(NX - 1, Math.ceil((cx + R + 1) / H));
    const j0 = Math.max(1, Math.floor((cy - R - 1) / H)), j1 = Math.min(NY - 1, Math.ceil((cy + R + 1) / H));
    const k0 = Math.max(0, Math.floor((cz - R - 1) / H)), k1 = Math.min(NZ - 1, Math.ceil((cz + R + 1) / H));
    let removed = 0;
    const fz = W.frz ? W.frz.slot : null;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const o = idx(i, j, k);
      if (W.mat[o] === MAT.BEDROCK || W.mat[o] === MAT.STEEL || (fz && fz[k * NX + i] >= 0)) continue;
      const v = M.len3(i * H - cx, j * H - cy, k * H - cz) - R;
      if (v < W.d[o]) { if (W.d[o] > 0 && v <= 0) { removed++; W.mat[o] = MAT.AIR; W.heat[o] = 0; } W.d[o] = v; }
    }
    W.mark(i0, j0, k0, i1, j1, k1);
    return removed;
  };
  /* Set one lattice point solid/air (used by flow automata and re-baking). */
  W.set_solid = function (o, dval, m, heat) { W.d[o] = dval; W.mat[o] = m; W.heat[o] = heat || 0; };
  W.set_air = function (o, dval) { W.d[o] = dval == null ? -0.6 : dval; W.mat[o] = MAT.AIR; W.heat[o] = 0; };

  /* Generation (delegates to sim/worldgen.js). Resumable: gen_begin + gen_step until it returns 1. */
  W.gen_begin = function (settings) { return SS.worldgen.begin(W, settings); };
  W.gen_step = function (job) {
    const p = SS.worldgen.step(job);
    if (p >= 1 && !job.finalized) {
      job.finalized = true;
      W.update_tops(0, 0, NX - 1, NZ - 1);
      W.mark_all();
    }
    return p;
  };
  W.generate = function (settings) { const job = W.gen_begin(settings); while (W.gen_step(job) < 1); };

  SS.world = W;
  window.WORLD = W; // legacy alias
})(window.SS = window.SS || {});
