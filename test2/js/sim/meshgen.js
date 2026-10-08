/* sim/meshgen.js — engine-agnostic mesh building from the density field.
 * Every function returns plain typed arrays that any engine can upload directly
 * (Three.js BufferAttribute, Unity Mesh.SetVertices/SetUVs, a native vertex buffer).
 *   chunk(cx,cy,cz)  -> {pos, nrm, mA, mB, mC, depth, idx}   full-res surface nets for one 16 m chunk
 *   local(grid,com)  -> same layout for a detached rigid piece (positions relative to its centre of mass)
 *   section(S)       -> the t=0 gameplay plane: density/material grid + collision outline segments
 *   grass(mesh,...)  -> grass blade instances on sky-exposed, grassy surfaces
 * Material weights: slot = matId-1, 12 slots packed in three RGBA8 (mA: bedrock rock soil sand,
 * mB: sandstone snow ice basalt, mC: lava crust ash scree), plus mD: steel foam concrete obsidian (13-16, exact corner
 * weights, painted procedurally). Lava weight is split by heat into crust. */
(function (SS) {
  'use strict';
  const G = SS.meshgen = {};
  const M = SS.math;
  const OFF = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const LAVA = 9, CRUST = 10;

  /* growable output buffers (C: struct MeshOut with capacity) */
  function Out() { return { p: [], n: [], w: [], x: [], dp: [], ix: [] }; }
  function finish(o) {
    const nv = o.p.length / 3, mA = new Uint8Array(nv * 4), mB = new Uint8Array(nv * 4), mC = new Uint8Array(nv * 4), mD = new Uint8Array(nv * 4);
    for (let v = 0; v < nv; v++) for (let s = 0; s < 4; s++) { mA[v * 4 + s] = o.w[v * 12 + s]; mB[v * 4 + s] = o.w[v * 12 + 4 + s]; mC[v * 4 + s] = o.w[v * 12 + 8 + s]; }
    for (let v = 0; v < nv; v++) { mD[v * 4] = o.x[v * 4]; mD[v * 4 + 1] = o.x[v * 4 + 1]; mD[v * 4 + 2] = o.x[v * 4 + 2]; mD[v * 4 + 3] = o.x[v * 4 + 3]; }   // steel, foam, concrete, obsidian (P31)
    return { pos: new Float32Array(o.p), nrm: new Float32Array(o.n), mA, mB, mC, mD, depth: new Float32Array(o.dp), idx: new Uint32Array(o.ix) };
  }
  const wtmp = new Float32Array(12), xtmp = new Float32Array(4), c = new Float32Array(8);
  function addWeights(o, mats, heats) {
    wtmp.fill(0); xtmp.fill(0); let tot = 0;
    for (let q = 0; q < 8; q++) {
      if (c[q] <= 0) continue;
      const m = mats[q]; if (!m) continue;
      const wv = Math.min(c[q], 1) + 0.05;
      if (m === LAVA) { const h = heats[q] / 255; wtmp[LAVA - 1] += wv * h; wtmp[CRUST - 1] += wv * (1 - h); }
      else if (m <= 12) wtmp[m - 1] += wv;
      else xtmp[m - 13] += wv;                               // P7 / P29d: steel / foam / concrete: the extra weights (mD), painted procedurally
      tot += wv;
    }
    if (tot <= 0) { wtmp[1] = 1; tot = 1; }
    let ts = 0; for (let s = 0; s < 12; s++) ts += wtmp[s];
    if (ts <= 0) wtmp[1] = 1e-3;                             // (a pure steel / foam vertex: rock underneath, overpainted)
    for (let s = 0; s < 12; s++) o.w.push(Math.round(wtmp[s] / tot * 255));
    o.x.push(Math.round(xtmp[0] / tot * 255), Math.round(xtmp[1] / tot * 255), Math.round(xtmp[2] / tot * 255), Math.round(xtmp[3] / tot * 255));
  }

  /* P29h (user 2026-10-08: "strange patches ... it should look natural, things blended, no sharp edges where the
   * textures connect unless there is a reason"): world-terrain vertices take their natural-material weights from a
   * 4 x 4 x 4 block of lattice points around the cell (falloff WIDE_R m from the vertex, solid points only), not from
   * the cell's 8 corners: a material boundary blends over ~1 m and the shader's noise can wander it organically,
   * instead of one-hot vertices turning every patch into a mesh polygon. Steel, foam and concrete (built objects: a real edge)
   * keep the exact corner weights. Depends on the world position only: identical on both sides of a chunk seam. */
  const WIDE_R = 1.1;
  function addWeightsWide(o, D, MT, HT, NX, NY, NZ, i, j, k, u, v, w) {
    wtmp.fill(0); xtmp.fill(0);
    let xs = 0, cs = 0;                                      // steel / foam share of the cell corners (as before)
    for (let q = 0; q < 8; q++) { if (c[q] <= 0) continue; const m = MT_c[q], wv = Math.min(c[q], 1) + 0.05; cs += wv; if (m > 12) { xtmp[m - 13] += wv; xs += wv; } }
    const SXY = NX * NY, R2 = WIDE_R * WIDE_R * 4;           // (lattice units: H = 0.5 m)
    let tot = 0;
    for (let dk = -1; dk <= 2; dk++) { const kk = k + dk; if (kk < 0 || kk >= NZ) continue;
      for (let dj = -1; dj <= 2; dj++) { const jj = j + dj; if (jj < 0 || jj >= NY) continue;
        for (let di = -1; di <= 2; di++) { const ii = i + di; if (ii < 0 || ii >= NX) continue;
          const of = (kk * NY + jj) * NX + ii, dv = D[of];
          if (dv <= 0) continue;
          const m = MT[of]; if (!m || m > 12) continue;
          const ex = di - u, ey = dj - v, ez = dk - w, d2 = ex * ex + ey * ey + ez * ez;
          if (d2 >= R2) continue;
          const f = 1 - Math.sqrt(d2 / R2), wv = f * f * (Math.min(dv, 1) + 0.05);
          if (m === LAVA) { const h = HT[of] / 255; wtmp[LAVA - 1] += wv * h; wtmp[CRUST - 1] += wv * (1 - h); }
          else wtmp[m - 1] += wv;
          tot += wv;
        } } }
    const xshare = cs > 0 ? xs / cs : 0, nat = 1 - xshare;
    if (tot <= 0) { wtmp[1] = 1; tot = 1; }
    if (nat <= 0) { wtmp.fill(0); wtmp[1] = 1e-3 * tot; }   // a pure steel / foam vertex: rock underneath, overpainted
    for (let s = 0; s < 12; s++) o.w.push(Math.round(wtmp[s] / tot * Math.max(nat, 0.004) * 255));
    o.x.push(cs > 0 ? Math.round(xtmp[0] / cs * 255) : 0, cs > 0 ? Math.round(xtmp[1] / cs * 255) : 0, cs > 0 ? Math.round(xtmp[2] / cs * 255) : 0, cs > 0 ? Math.round(xtmp[3] / cs * 255) : 0);
  }
  const MT_c = new Uint8Array(8);

  /* Surface-nets vertex for one cell whose 8 corner values are in c[]. Returns [x,y,z] in cell units + gradient.
   * O1: the mass point of the edge crossings is then pulled onto the cell's trilinear iso-surface (Newton along the
   * analytic gradient, kept inside the cell), so the mesh passes through the same surface the sim collides with and
   * the cap / outline draw; only the flat chords between vertices remain (cm). */
  const vtx = new Float32Array(6);
  const PROJ_IT = 4;
  function cellVertex() {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let e = 0; e < 12; e++) {
      const a = c[EDGES[e][0]], b = c[EDGES[e][1]];
      if ((a > 0) === (b > 0)) continue;
      const t = a / (a - b), A = OFF[EDGES[e][0]], B = OFF[EDGES[e][1]];
      sx += A[0] + (B[0] - A[0]) * t; sy += A[1] + (B[1] - A[1]) * t; sz += A[2] + (B[2] - A[2]) * t; n++;
    }
    let u = sx / n, v = sy / n, w = sz / n, gx = 0, gy = 0, gz = 0;
    for (let it = 0; it <= PROJ_IT; it++) {
      // analytic gradient of the trilinear interpolant at (u,v,w): identical on both sides of a chunk seam
      gx = (1 - v) * (1 - w) * (c[1] - c[0]) + v * (1 - w) * (c[3] - c[2]) + (1 - v) * w * (c[5] - c[4]) + v * w * (c[7] - c[6]);
      gy = (1 - u) * (1 - w) * (c[2] - c[0]) + u * (1 - w) * (c[3] - c[1]) + (1 - u) * w * (c[6] - c[4]) + u * w * (c[7] - c[5]);
      gz = (1 - u) * (1 - v) * (c[4] - c[0]) + u * (1 - v) * (c[5] - c[1]) + (1 - u) * v * (c[6] - c[2]) + u * v * (c[7] - c[3]);
      if (it === PROJ_IT) break;
      const a00 = c[0] + (c[1] - c[0]) * u, a10 = c[2] + (c[3] - c[2]) * u, a01 = c[4] + (c[5] - c[4]) * u, a11 = c[6] + (c[7] - c[6]) * u;
      const b0 = a00 + (a10 - a00) * v, b1 = a01 + (a11 - a01) * v, f = b0 + (b1 - b0) * w, g2 = gx * gx + gy * gy + gz * gz;
      if (g2 < 1e-10 || Math.abs(f) < 1e-5) break;
      const k = f / g2;
      u -= k * gx; v -= k * gy; w -= k * gz;
      u = u < 0 ? 0 : u > 1 ? 1 : u; v = v < 0 ? 0 : v > 1 ? 1 : v; w = w < 0 ? 0 : w > 1 ? 1 : w;
    }
    vtx[0] = u; vtx[1] = v; vtx[2] = w; vtx[3] = gx; vtx[4] = gy; vtx[5] = gz;
  }

  /* Smooth normal: trilinear blend of central-difference gradients at the 8 cell corners.
   * Reads the global field only, so vertices on chunk seams get identical normals in both chunks. */
  const gq = new Float32Array(3);
  function latticeGrad(D, nx, ny, nz, i0, j0, k0, u, v, w) {
    const sxy = nx * ny; let gx = 0, gy = 0, gz = 0;
    for (let q = 0; q < 8; q++) {
      const i = i0 + OFF[q][0], j = j0 + OFF[q][1], k = k0 + OFF[q][2];
      const wt = (OFF[q][0] ? u : 1 - u) * (OFF[q][1] ? v : 1 - v) * (OFF[q][2] ? w : 1 - w);
      const o = (k * ny + j) * nx + i;
      const xm = i > 0 ? o - 1 : o, xp = i < nx - 1 ? o + 1 : o, ym = j > 0 ? o - nx : o, yp = j < ny - 1 ? o + nx : o, zm = k > 0 ? o - sxy : o, zp = k < nz - 1 ? o + sxy : o;
      gx += wt * (D[xp] - D[xm]); gy += wt * (D[yp] - D[ym]); gz += wt * (D[zp] - D[zm]);
    }
    const l = M.len3(gx, gy, gz);
    if (l < 1e-6) { gq[0] = vtx[3]; gq[1] = vtx[4]; gq[2] = vtx[5]; const l2 = M.len3(gq[0], gq[1], gq[2]) || 1; gq[0] /= l2; gq[1] /= l2; gq[2] /= l2; }
    else { gq[0] = gx / l; gq[1] = gy / l; gq[2] = gz / l; }
    return gq;
  }

  /* depth below the nearest air above (world lattice column walk), metres, capped */
  function columnDepth(W, x, y, z, cap) {
    const H = W.H, i = M.clamp(Math.round(x / H), 0, W.NX - 1), k = M.clamp(Math.round(z / H), 0, W.NZ - 1);
    let j = Math.max(0, Math.ceil(y / H));
    const capJ = j + Math.ceil(cap / H);
    let o = (k * W.NY + j) * W.NX + i;
    while (j < W.NY && j < capJ && W.d[o] > 0) { j++; o += W.NX; }
    if (j >= W.NY || j >= capJ) return cap;
    const a = j > 0 ? W.d[o - W.NX] : 0, b = W.d[o], f = a > 0 && b <= 0 ? a / (a - b) : 0;
    return M.clamp((j - 1 + f) * H - y, 0, cap);
  }

  /* Full-resolution mesh of world chunk (cx,cy,cz). */
  G.chunk = function (cx, cy, cz) {
    const W = SS.world, NX = W.NX, NY = W.NY, NZ = W.NZ, CS = W.CS, H = W.H, D = W.d, MT = W.mat, HT = W.heat, SXY = NX * NY;
    const i0 = cx * CS, j0 = cy * CS, k0 = cz * CS;
    const i1 = cx === W.CX - 1 ? NX : i0 + CS, j1 = cy === W.CY - 1 ? NY : j0 + CS, k1 = cz === W.CZ - 1 ? NZ : k0 + CS;
    const ci0 = Math.max(0, i0 - 1), ci1 = Math.min(NX - 2, i1), cj0 = Math.max(0, j0 - 1), cj1 = Math.min(NY - 2, j1), ck0 = Math.max(0, k0 - 1), ck1 = Math.min(NZ - 2, k1);
    const sx = ci1 - ci0 + 1, sy = cj1 - cj0 + 1, sz = ck1 - ck0 + 1;
    const cell = new Int32Array(sx * sy * sz).fill(-1);
    const o = Out(), mats = new Uint8Array(8), heats = new Uint8Array(8);
    for (let k = ck0; k <= ck1; k++) for (let j = cj0; j <= cj1; j++) for (let i = ci0; i <= ci1; i++) {
      const b = (k * NY + j) * NX + i;
      let mask = 0;
      for (let q = 0; q < 8; q++) {
        const of = b + OFF[q][0] + OFF[q][1] * NX + OFF[q][2] * SXY;
        const v = D[of]; c[q] = v; mats[q] = MT[of]; MT_c[q] = MT[of]; heats[q] = HT[of];
        if (v > 0) mask |= 1 << q;
      }
      if (mask === 0 || mask === 255) continue;
      cellVertex();
      cell[((k - ck0) * sy + (j - cj0)) * sx + (i - ci0)] = o.p.length / 3;
      const x = (i + vtx[0]) * H, y = (j + vtx[1]) * H, z = (k + vtx[2]) * H;
      o.p.push(x, y, z);
      const gn = latticeGrad(D, NX, NY, NZ, i, j, k, vtx[0], vtx[1], vtx[2]);
      o.n.push(-gn[0], -gn[1], -gn[2]);
      addWeightsWide(o, D, MT, HT, NX, NY, NZ, i, j, k, vtx[0], vtx[1], vtx[2]);
      // depth = solid above the vertex; a vertex more than 0.6 m below its column's top (cave floor, ledge under an
      // overhang) is not sky-exposed either: the grass cover and grass-fire glow live on the topmost surface only
      const ct = W.top[M.clamp(Math.round(z / H), 0, NZ - 1) * NX + M.clamp(Math.round(x / H), 0, NX - 1)] - y;
      o.dp.push(Math.max(columnDepth(W, x, y, z, 6), ct > 0.6 ? Math.min(6, ct) : 0));
    }
    const cid = (i, j, k) => (i < ci0 || j < cj0 || k < ck0 || i > ci1 || j > cj1 || k > ck1) ? -1 : cell[((k - ck0) * sy + (j - cj0)) * sx + (i - ci0)];
    const dims = [NX, NY, NZ], p = [0, 0, 0], r = [0, 0, 0];
    for (let k = k0; k < k1; k++) for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
      const b = (k * NY + j) * NX + i, v0 = D[b] > 0;
      p[0] = i; p[1] = j; p[2] = k;
      for (let a = 0; a < 3; a++) {
        if (p[a] >= dims[a] - 1) continue;
        const nb = b + (a === 0 ? 1 : a === 1 ? NX : SXY);
        if ((D[nb] > 0) === v0) continue;
        const u = (a + 1) % 3, w = (a + 2) % 3;
        if (p[u] < 1 || p[w] < 1 || p[u] > dims[u] - 2 || p[w] > dims[w] - 2) continue;
        r[0] = p[0]; r[1] = p[1]; r[2] = p[2]; r[u]--; r[w]--; const A = cid(r[0], r[1], r[2]);
        r[u]++; const B = cid(r[0], r[1], r[2]);
        r[w]++; const Cc = cid(r[0], r[1], r[2]);
        r[u]--; const Dd = cid(r[0], r[1], r[2]);
        if (A < 0 || B < 0 || Cc < 0 || Dd < 0) continue;
        if (v0) o.ix.push(A, B, Cc, A, Cc, Dd); else o.ix.push(A, Dd, Cc, A, Cc, B);
      }
    }
    return finish(o);
  };

  /* Mesh of a detached piece's local grid; positions relative to its centre of mass `com` (world at creation). */
  G.local = function (g, com) {
    const W = SS.world, H = W.H, nx = g.nx, ny = g.ny, nz = g.nz, sxy = nx * ny;
    const cell = new Int32Array((nx - 1) * (ny - 1) * (nz - 1)).fill(-1);
    const o = Out(), mats = new Uint8Array(8), heats = new Uint8Array(8).fill(255);
    for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const b = (k * ny + j) * nx + i;
      let mask = 0;
      for (let q = 0; q < 8; q++) { const of = b + OFF[q][0] + OFF[q][1] * nx + OFF[q][2] * sxy; c[q] = g.d[of]; mats[q] = g.mat[of]; if (c[q] > 0) mask |= 1 << q; }
      if (mask === 0 || mask === 255) continue;
      cellVertex();
      cell[(k * (ny - 1) + j) * (nx - 1) + i] = o.p.length / 3;
      o.p.push((g.i0 + i + vtx[0]) * H - com.x, (g.j0 + j + vtx[1]) * H - com.y, (g.k0 + k + vtx[2]) * H - com.z);
      const gn = latticeGrad(g.d, nx, ny, nz, i, j, k, vtx[0], vtx[1], vtx[2]);
      o.n.push(-gn[0], -gn[1], -gn[2]);
      addWeights(o, mats, heats);
      o.dp.push(3);
    }
    const cid = (i, j, k) => (i < 0 || j < 0 || k < 0 || i > nx - 2 || j > ny - 2 || k > nz - 2) ? -1 : cell[(k * (ny - 1) + j) * (nx - 1) + i];
    const dims = [nx, ny, nz], p = [0, 0, 0], r = [0, 0, 0];
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const b = (k * ny + j) * nx + i, v0 = g.d[b] > 0;
      p[0] = i; p[1] = j; p[2] = k;
      for (let a = 0; a < 3; a++) {
        if (p[a] >= dims[a] - 1) continue;
        const nb = b + (a === 0 ? 1 : a === 1 ? nx : sxy);
        if ((g.d[nb] > 0) === v0) continue;
        const u = (a + 1) % 3, w = (a + 2) % 3;
        if (p[u] < 1 || p[w] < 1 || p[u] > dims[u] - 2 || p[w] > dims[w] - 2) continue;
        r[0] = p[0]; r[1] = p[1]; r[2] = p[2]; r[u]--; r[w]--; const A = cid(r[0], r[1], r[2]);
        r[u]++; const B = cid(r[0], r[1], r[2]);
        r[w]++; const Cc = cid(r[0], r[1], r[2]);
        r[u]--; const Dd = cid(r[0], r[1], r[2]);
        if (A < 0 || B < 0 || Cc < 0 || Dd < 0) continue;
        if (v0) o.ix.push(A, B, Cc, A, Cc, Dd); else o.ix.push(A, Dd, Cc, A, Cc, B);
      }
    }
    return finish(o);
  };

  /* The gameplay plane (t = 0): density + material grid and collision outline.
   * O1: the outline lies ON the exact collision line (the iso-line d = 0 of the trilinear field on the plane, what
   * worms and bodies collide with, and what the cap shader draws), not on marching-squares chords:
   *   - crossings on vertical cell edges are exact already (the field is linear in y between lattice nodes); on
   *     horizontal edges (piecewise quadratic along an oblique row) they are solved by regula falsi;
   *   - saddle cells (4 crossings) are paired exactly (the field is linear in y inside a cell: the order of the two
   *     row crossings decides);
   *   - a row edge whose ends share a sign but touches a lattice node of the other sign is searched exactly
   *     (piecewise quadratic) for a hidden opposite stretch; its cells are split there into sub-cells (the field is
   *     linear in y inside a cell, so every sub-cell feature touches a row: none is missed);
   *   - every chord is split where the curve is more than SEC_TOL off it: inside a cell the line is the graph
   *     y(s) = y0 + H·b(s) / (b(s) − t(s)) of the two row values (exact, 2 samples per point; up to SEC_DEPTH levels).
   * Shared crossings are computed from identical inputs in both cells (bit-identical floats: sim/edge.js chains them). */
  const SEC_TOL = 0.003, SEC_DEPTH = 4;
  let secBuf = null;   // per-row-edge scratch (C: static buffers sized once)
  const SEC_FAR = 24;  // m: dry worlds (D4) extend the section past the lattice on both sides (W.sample = far dunes)
  G.section = function (S) {
    const W = SS.world, P = SS.plane, H = W.H;
    const d = P.dir(S), Ox0 = S.O.x, Oz0 = S.O.z; let r = P.range(S);
    if (r[0] > r[1]) r = [0, 0];                    // D6: the line misses the lattice (a worm out in the far dunes)
    // dry worlds: SEC_FAR beyond the lattice and always around the rotation centre (the worm) too (D6: it used to
    // be the lattice ± 24 m only: a negative length when the line missed the lattice -> RangeError -> freeze)
    if (W.far) {
      r[0] = Math.min(r[0], 0) - SEC_FAR; r[1] = Math.max(r[1], 0) + SEC_FAR;
      // ... and out to every living worm near the plane (a worm blasted far out on the hot sand stays on the drawn
      // section, D6), never beyond FAR_R
      const ws = S.worms || [];
      for (let q = 0; q < ws.length; q++) {
        const w = ws[q];
        if (w.dead) continue;
        const ex = w.pos.x - Ox0, ez = w.pos.z - Oz0;
        if (Math.abs(-ex * d.z + ez * d.x) > 4) continue;
        const sw = ex * d.x + ez * d.z;
        r[0] = Math.max(-SS.CFG.DRY.FAR_R, Math.min(r[0], sw - 8)); r[1] = Math.min(SS.CFG.DRY.FAR_R, Math.max(r[1], sw + 8));
      }
    }
    const s0 = r[0], ns = Math.round((r[1] - s0) / H) + 1, ny = W.NY, Ox = S.O.x, Oz = S.O.z;
    const V = new Float32Array(ns * ny), Mt = new Uint8Array(ns * ny);
    for (let j = 0; j < ny; j++) {
      const y = j * H;
      for (let i = 0; i < ns; i++) {
        const s = s0 + i * H, x = Ox + s * d.x, z = Oz + s * d.z, v = W.sample(x, y, z);
        V[j * ns + i] = v; if (v > 0) Mt[j * ns + i] = W.mat_at(x, y, z);
      }
    }
    const f2 = (s, y) => W.sample(Ox + s * d.x, y, Oz + s * d.z);
    // the boundary of {d > 0} along the row y between sA (value a) and sB (value b) of opposite solidity: Illinois
    // regula falsi; exact zeros count as air (a floor exactly on a row has stretches of d = 0): bisect on the sign there
    function rowRoot(sA, a, sB, b, y) {
      if (a === 0 || b === 0) {
        let lo = sA, hi = sB; const pl = a > 0;
        for (let it = 0; it < 20; it++) { const m = (lo + hi) * 0.5; if ((f2(m, y) > 0) === pl) lo = m; else hi = m; }
        return (lo + hi) * 0.5;
      }
      let lo = sA, hi = sB, fl = a, fh = b, s = sA + (sB - sA) * a / (a - b), side = 0;
      for (let it = 0; it < 8; it++) {
        const fs = f2(s, y);
        if (Math.abs(hi - lo) < 1e-5) break;
        if ((fs > 0) === (fl > 0)) { lo = s; fl = fs; if (side === -1) fh *= 0.5; side = -1; }
        else { hi = s; fh = fs; if (side === 1) fl *= 0.5; side = 1; }
        s = lo + (hi - lo) * fl / (fl - fh);
      }
      return s;
    }
    // does the row y = j·H between sA and sB touch a lattice node of the other sign? The field on a lattice row is a
    // convex blend of the nodes of the cells it crosses: if none has the other sign, no hidden crossing (rigorous)
    function mixedNodes(sA, sB, j, pos) {
      const xa = Ox + sA * d.x, xb = Ox + sB * d.x, za = Oz + sA * d.z, zb = Oz + sB * d.z;
      if (Math.min(xa, xb) < 0 || Math.min(za, zb) < 0 || Math.max(xa, xb) > W.SX || Math.max(za, zb) > W.SZ) return false;
      if (W.outside(xa, za) || W.outside(xb, zb)) return false;     // D6: beyond the disc of a dry world W.far rules
      const ia = Math.floor(Math.min(xa, xb) / H), ib = Math.min(W.NX - 1, Math.floor(Math.max(xa, xb) / H) + 1);
      const ka = Math.floor(Math.min(za, zb) / H), kb = Math.min(W.NZ - 1, Math.floor(Math.max(za, zb) / H) + 1), D = W.d;
      for (let k = ka; k <= kb; k++) for (let i = ia; i <= ib; i++) if ((D[(k * W.NY + j) * W.NX + i] > 0) !== pos) return true;
      return false;
    }
    // the most opposite point of a same-sign row edge: the field is exactly quadratic between the points where the row
    // crosses lattice lines (bilinear along a line), so each piece is checked at its ends, middle and vertex -> pr
    const bp = new Float64Array(4), pr = new Float64Array(2);
    function rowSplit(sA, a, sB, y) {
      const xa = Ox + sA * d.x, xb = Ox + sB * d.x, za = Oz + sA * d.z, zb = Oz + sB * d.z, pos = a > 0;
      let n = 0; bp[n++] = 0;
      const ca = Math.floor(xa / H), cb = Math.floor(xb / H), ka = Math.floor(za / H), kb = Math.floor(zb / H);
      if (ca !== cb) bp[n++] = ((Math.max(ca, cb)) * H - xa) / (xb - xa);
      if (ka !== kb) { const t = ((Math.max(ka, kb)) * H - za) / (zb - za); if (n === 2 && t < bp[1]) { bp[2] = bp[1]; bp[1] = t; n++; } else bp[n++] = t; }
      bp[n++] = 1;
      let best = 0, bs = 0, f0 = a;
      for (let q = 0; q + 1 < n; q++) {
        const t0 = bp[q], t1 = bp[q + 1], L = sB - sA;
        if (t1 - t0 < 1e-9) continue;
        const fm = f2(sA + L * (t0 + t1) * 0.5, y), f1 = q + 2 === n ? f2(sB, y) : f2(sA + L * t1, y);
        const A = 2 * f0 - 4 * fm + 2 * f1, B = -3 * f0 + 4 * fm - f1;
        const cand = (u, v) => { if ((v > 0) !== pos && Math.abs(v) > best) { best = Math.abs(v); bs = sA + L * (t0 + (t1 - t0) * u); } };
        cand(0.5, fm); if (q + 2 < n) cand(1, f1);
        if (Math.abs(A) > 1e-12) { const u = -B / (2 * A); if (u > 0 && u < 1) cand(u, f0 + B * u + A * u * u); }
        f0 = f1;
      }
      if (best < 1e-6) return false;
      pr[0] = bs; pr[1] = f2(bs, y); return (pr[1] > 0) !== pos;
    }
    // one piece of line inside a (sub-)cell with bottom row y0: the field is linear in y at every s, so the piece is the
    // graph y(s) = y0 + H·b/(b − t) (b, t = bottom / top row values at s); split where the chord is > SEC_TOL off it
    const seg = [];
    function emit(sa, ya, sb, yb, y0, depth) {
      const ds = sb - sa, dy = yb - ya, L2 = ds * ds + dy * dy;
      if (depth < SEC_DEPTH && L2 > (H / 8) * (H / 8) && Math.abs(ds) > 1e-4) {
        const ms = (sa + sb) * 0.5, bv = f2(ms, y0), tv = f2(ms, y0 + H);
        if ((bv > 0) !== (tv > 0) || ((bv === 0 || tv === 0) && bv !== tv)) {   // (a row value of exactly 0 = the line touches that row)
          const my = y0 + H * bv / (bv - tv), off = Math.abs((ms - sa) * dy - (my - ya) * ds) / Math.sqrt(L2);
          if (off > SEC_TOL) { emit(sa, ya, ms, my, y0, depth + 1); emit(ms, my, sb, yb, y0, depth + 1); return; }
        }
      }
      if (L2 > 1e-12) seg.push(sa, ya, sb, yb);   // (a corner exactly at 0 gives zero-length pieces)
    }
    // crossings of every row edge, computed once (both cells sharing it get the same floats): rA (first), rB (second,
    // only on split edges), sp / spV = split point and its value (hidden opposite-sign stretch)
    const NE = (ns - 1) * ny;
    if (!secBuf || secBuf.rA.length < NE) secBuf = { rA: new Float64Array(NE), rB: new Float64Array(NE), sp: new Float64Array(NE), spV: new Float64Array(NE) };
    const rA = secBuf.rA, rB = secBuf.rB, sp = secBuf.sp, spV = secBuf.spV;
    rA.fill(NaN, 0, NE); rB.fill(NaN, 0, NE); sp.fill(NaN, 0, NE);
    let nSplit = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < ns - 1; i++) {
      const e = j * (ns - 1) + i, a = V[j * ns + i], b = V[j * ns + i + 1], sA = s0 + i * H, y = j * H;
      if ((a > 0) !== (b > 0)) rA[e] = rowRoot(sA, a, sA + H, b, y);
      else if (j > 0 && mixedNodes(sA, sA + H, j, a > 0) && rowSplit(sA, a, sA + H, y)) {
        sp[e] = pr[0]; spV[e] = pr[1]; rA[e] = rowRoot(sA, a, pr[0], pr[1], y); rB[e] = rowRoot(pr[0], pr[1], sA + H, b, y); nSplit++;
      }
    }
    // one (sub-)cell [L, R] x [y0, y0 + H]: corner values q0 (L, y0), q1 (R, y0), q2 (R, top), q3 (L, top); row edges eb / et
    const pts = [];
    function rowX(e, L, R, a, b, y) {   // the cached crossing of row edge e inside [L, R] (fallback: solve there)
      const u = rA[e], v = rB[e];
      if (u >= L && u <= R) return u;
      if (v >= L && v <= R) return v;
      return rowRoot(L, a, R, b, y);
    }
    function cell(L, R, y0, q0, q1, q2, q3, eb, et, jj) {
      pts.length = 0;
      if ((q0 > 0) !== (q1 > 0)) pts.push(rowX(eb, L, R, q0, q1, y0), y0);                     // bottom
      if ((q1 > 0) !== (q2 > 0)) { const f = q1 / (q1 - q2); pts.push(R, (jj + f) * H); }      // right (linear in y: exact)
      if ((q3 > 0) !== (q2 > 0)) pts.push(rowX(et, L, R, q3, q2, y0 + H), y0 + H);              // top
      if ((q0 > 0) !== (q3 > 0)) { const f = q0 / (q0 - q3); pts.push(L, (jj + f) * H); }      // left
      if (pts.length === 8) {
        // saddle, resolved exactly: at every s the field is linear in y, so the line is y(s) = y0 + H·b/(b − t) wherever
        // the bottom-row value b and the top-row value t differ in sign. Left of the first row crossing they differ,
        // between the two crossings they agree, right of the second they differ again: the left piece ends at the
        // first row crossing, the right piece starts at the second.
        const p = pts.slice();
        if (p[0] < p[4]) { emit(p[6], p[7], p[0], p[1], y0, 0); emit(p[4], p[5], p[2], p[3], y0, 0); }   // left-bottom, top-right
        else { emit(p[6], p[7], p[4], p[5], y0, 0); emit(p[0], p[1], p[2], p[3], y0, 0); }                // left-top, bottom-right
      } else if (pts.length === 4) emit(pts[0], pts[1], pts[2], pts[3], y0, 0);
    }
    const cut = [0, 0, 0, 0], vb = [0, 0, 0, 0], vt = [0, 0, 0, 0];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < ns - 1; i++) {
      const eb = j * (ns - 1) + i, et = (j + 1) * (ns - 1) + i, L = s0 + i * H, y0 = j * H;
      const c0 = V[j * ns + i], c1 = V[j * ns + i + 1], c2 = V[(j + 1) * ns + i + 1], c3 = V[(j + 1) * ns + i];
      if (sp[eb] !== sp[eb] && sp[et] !== sp[et]) { cell(L, L + H, y0, c0, c1, c2, c3, eb, et, j); continue; }
      // a hidden opposite-sign stretch on a row edge: split the cell at the split point(s) into sub-cells
      let n = 0; cut[n] = L; vb[n] = c0; vt[n] = c3; n++;
      const ps = sp[eb] === sp[eb], pt = sp[et] === sp[et];
      const add = (s) => { cut[n] = s; vb[n] = ps && s === sp[eb] ? spV[eb] : f2(s, y0); vt[n] = pt && s === sp[et] ? spV[et] : f2(s, y0 + H); n++; };
      if (ps && pt) { if (sp[eb] <= sp[et]) { add(sp[eb]); if (sp[et] > sp[eb]) add(sp[et]); } else { add(sp[et]); add(sp[eb]); } }
      else add(ps ? sp[eb] : sp[et]);
      cut[n] = L + H; vb[n] = c1; vt[n] = c2; n++;
      for (let q = 0; q + 1 < n; q++) cell(cut[q], cut[q + 1], y0, vb[q], vb[q + 1], vt[q + 1], vt[q], eb, et, j);
    }
    G.sectionSplits = nSplit;
    return { s0, s1: s0 + (ns - 1) * H, ns, ny, V, M: Mt, layer: 0, O: { x: S.O.x, z: S.O.z }, theta: S.theta, outline: new Float32Array(seg) };
  };

  /* Top-surface heights on an (n x n) grid covering the world (metres). */
  G.heightmap = function (n) {
    const W = SS.world, out = new Float32Array(n * n);
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) out[k * n + i] = W.top_at(i / (n - 1) * W.SX, k / (n - 1) * W.SZ);
    return out;
  };

  /* Grass blades on up-facing, sky-exposed triangles of a chunk mesh (stable world-anchored hashing).
   * grassAt(x,z) -> 0..1 coverage; dens = quality density factor (scales the count only, not the coverage threshold,
   * so sparse cover does not vanish on lower quality). Output per blade: x, y, z, yaw, height, kind. */
  G.grass = function (mesh, grassAt, sea, max, dens) {
    if (dens === undefined) dens = 1;
    const W = SS.world, P = mesh.pos, N = mesh.nrm, I = mesh.idx, D = mesh.depth, out = [];
    for (let i = 0; i < I.length && out.length < max * 6; i += 3) {
      const a = I[i], b = I[i + 1], cc = I[i + 2];
      if (N[a * 3 + 1] < 0.7 || N[b * 3 + 1] < 0.7 || N[cc * 3 + 1] < 0.7) continue;
      if (D[a] > 0.3 || D[b] > 0.3 || D[cc] > 0.3) continue;
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      if (ay < sea + 0.6) continue;
      if (Math.abs(W.top_at(ax, az) - ay) > 0.7) continue;          // only sky-exposed surfaces grow grass
      const g = grassAt(ax, az); if (g < 0.04) continue;
      const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
      const vx = P[cc * 3] - ax, vy = P[cc * 3 + 1] - ay, vz = P[cc * 3 + 2] - az;
      const area = 0.5 * M.len3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      const qx = Math.floor(ax * 4), qy = Math.floor(ay * 4), qz = Math.floor(az * 4);
      const patch = M.hash3(Math.floor(ax / 3), 7, Math.floor(az / 3));
      let cnt = area * (8 + 26 * patch) * g * dens; const base = Math.floor(cnt);
      cnt = M.hash3(qx, qy, qz) < cnt - base ? base + 1 : base;
      for (let q = 0; q < cnt; q++) {
        let r1 = M.hash3(qx + q * 7, qy, qz + 1), r2 = M.hash3(qx, qy + q * 13, qz + 2);
        if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
        const h3 = M.hash3(qx + q, qy - q, qz + 5);
        out.push(ax + ux * r1 + vx * r2, ay + uy * r1 + vy * r2 - 0.02, az + uz * r1 + vz * r2, M.hash3(qx - q, qy, qz + 9) * 6.283,
          0.2 + 0.34 * M.hash3(qx, qy, qz + q + 3) * (0.6 + patch * 0.8), h3 > 0.965 ? (h3 > 0.985 ? 2 : 1) : 0);
      }
    }
    return new Float32Array(out);
  };
})(window.SS = window.SS || {});
