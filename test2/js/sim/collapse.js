/* sim/collapse.js — structural support of the voxel world.
 * A solid voxel is supported if a 6-connected path of supporting voxels reaches the bedrock layer
 * (or, for ice, the sea it floats on). After a blast the shell around the crater is probed with a
 * down-first depth-first search; components that never reach support are cut out of the field,
 * fractured into a few Voronoi pieces and handed to the rigid-body solver. When a piece comes to
 * rest it is re-baked into the field, so settled rubble is real terrain for every later view.
 * C mapping: stamp[] / stack[] are static scratch buffers; components are int arrays of voxel indices. */
(function (SS) {
  'use strict';
  const C = SS.CFG, MAT = C.MAT, M = SS.math;
  const K = SS.collapse = {};
  let stamp = null, stack = null, visit = null, counter = 1;
  const nb = new Int32Array(6);                         // neighbour scratch (no per-voxel allocation)
  const BUDGET = 260000;
  K.stats = { seeds: 0, visited: 0, maxRun: 0 };      // last find_floating: probes, voxels visited, longest probe

  function ensure(W) {
    if (!stamp || stamp.length !== W.N) { stamp = new Uint32Array(W.N); stack = new Int32Array(W.N); visit = new Int32Array(BUDGET + 8); }
    if (counter > 4e9) { stamp.fill(0); counter = 1; }
  }
  const supports = (W, o) => W.d[o] > 0 && W.mat[o] !== MAT.LAVA;
  function anchored(W, o) {
    const j = Math.floor(o / W.NX) % W.NY;
    if (j <= 2) return true;
    if (W.mat[o] === MAT.ICE || W.mat[o] === MAT.FOAM) { const y = j * W.H; return y <= W.SEA + 0.6 && y >= W.SEA - 1.6; }   // floats (ice, P2 foam)
    if (W.mat[o] === MAT.STEEL) return true;                 // P2: a girder holds (PoC: steel is an anchor)
    return false;
  }

  /* Full pass (generation): flood from every anchor, delete whatever is not reached. */
  K.remove_floating_all = function (W) {
    ensure(W);
    const A = ++counter, NX = W.NX, NY = W.NY, NZ = W.NZ, SXY = NX * NY;
    let sp = 0;
    for (let o = 0; o < W.N; o++) if (supports(W, o) && anchored(W, o)) { stamp[o] = A; stack[sp++] = o; }
    while (sp > 0) {
      const o = stack[--sp], i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / SXY);
      nb[0] = i > 0 ? o - 1 : -1; nb[1] = i < NX - 1 ? o + 1 : -1; nb[2] = j > 0 ? o - NX : -1; nb[3] = j < NY - 1 ? o + NX : -1; nb[4] = k > 0 ? o - SXY : -1; nb[5] = k < NZ - 1 ? o + SXY : -1;
      for (let q = 0; q < 6; q++) { const n = nb[q]; if (n >= 0 && stamp[n] !== A && supports(W, n)) { stamp[n] = A; stack[sp++] = n; } }
    }
    let removed = 0;
    for (let o = 0; o < W.N; o++) if (W.d[o] > 0 && stamp[o] !== A && W.mat[o] !== MAT.LAVA) { W.d[o] = -0.5; W.mat[o] = MAT.AIR; removed++; }
    return removed;
  };

  /* Probe the solid shell of lattice box b; returns an array of floating components (Int32Array each). */
  K.find_floating = function (W, b) {
    ensure(W);
    const NX = W.NX, NY = W.NY, NZ = W.NZ, SXY = NX * NY;
    const KNOWN = ++counter, comps = [];
    K.stats.seeds = 0; K.stats.visited = 0; K.stats.maxRun = 0;
    const i0 = Math.max(1, b.i0 - 2), i1 = Math.min(NX - 2, b.i1 + 2), j0 = Math.max(1, b.j0 - 2), j1 = Math.min(NY - 2, b.j1 + 2), k0 = Math.max(1, b.k0 - 2), k1 = Math.min(NZ - 2, b.k1 + 2);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const s = (k * NY + j) * NX + i;
      if (!supports(W, s) || stamp[s] === KNOWN) continue;
      // only seeds that touch air (the shell); interior voxels are reached through them
      if (supports(W, s - 1) && supports(W, s + 1) && supports(W, s - NX) && supports(W, s + NX) && supports(W, s - SXY) && supports(W, s + SXY)) continue;
      const sid = ++counter;
      let sp = 0, nv = 0, ok = false;
      stack[sp++] = s; stamp[s] = sid;
      while (sp > 0) {
        const o = stack[--sp];
        if (nv < BUDGET) visit[nv] = o;
        nv++;
        if (anchored(W, o) || nv > BUDGET) { ok = true; break; }
        const ii = o % NX, jj = Math.floor(o / NX) % NY, kk = Math.floor(o / SXY);
        // push order: up, sides, down last -> down is explored first (reaches the ground fast)
        nb[0] = jj < NY - 1 ? o + NX : -1; nb[1] = ii > 0 ? o - 1 : -1; nb[2] = ii < NX - 1 ? o + 1 : -1; nb[3] = kk > 0 ? o - SXY : -1; nb[4] = kk < NZ - 1 ? o + SXY : -1; nb[5] = jj > 0 ? o - NX : -1;
        for (let q = 0; q < 6; q++) {
          const n = nb[q];
          if (n < 0 || !supports(W, n)) continue;
          if (stamp[n] === KNOWN) { ok = true; sp = 0; break; }
          if (stamp[n] !== sid) { stamp[n] = sid; stack[sp++] = n; }
        }
      }
      K.stats.seeds++; K.stats.visited += nv; if (nv > K.stats.maxRun) K.stats.maxRun = nv;
      const cnt = Math.min(nv, BUDGET);
      for (let q = 0; q < cnt; q++) stamp[visit[q]] = KNOWN; // either anchored, or recorded below (never probed twice)
      if (!ok) comps.push(visit.slice(0, cnt));
    }
    return comps;
  };

  /* Cut a component out of the field and split it into rigid pieces + rubble.
   * Returns { pieces: [ChunkDesc], rubble: [{x,y,z,mat}] }. ChunkDesc carries a local density grid. */
  K.detach = function (W, comp, rng) {
    const NX = W.NX, NY = W.NY, SXY = NX * NY, H = W.H, n = comp.length;
    const nPieces = M.clamp(Math.round(n / 320), 1, 6), seeds = [];
    for (let s = 0; s < nPieces; s++) {
      const o = comp[Math.floor(M.rng_next(rng) * n)];
      seeds.push([(o % NX) * H, (Math.floor(o / NX) % NY) * H, Math.floor(o / SXY) * H]);
    }
    const owner = new Uint8Array(n);
    for (let q = 0; q < n; q++) {
      const o = comp[q], x = (o % NX) * H, y = (Math.floor(o / NX) % NY) * H, z = Math.floor(o / SXY) * H;
      let best = 0, bd = 1e9;
      for (let s = 0; s < nPieces; s++) {
        const dd = M.len3(x - seeds[s][0], y - seeds[s][1], z - seeds[s][2]) + (M.hash3(o, s, 3) - 0.5) * 1.2;
        if (dd < bd) { bd = dd; best = s; }
      }
      owner[q] = best;
    }
    const pieces = [], rubble = [];
    let bi0 = 1e9, bj0 = 1e9, bk0 = 1e9, bi1 = -1, bj1 = -1, bk1 = -1;
    for (let s = 0; s < nPieces; s++) {
      const list = [];
      for (let q = 0; q < n; q++) if (owner[q] === s) list.push(comp[q]);
      if (!list.length) continue;
      let i0 = 1e9, j0 = 1e9, k0 = 1e9, i1 = -1, j1 = -1, k1 = -1;
      for (const o of list) {
        const i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / SXY);
        i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j); k0 = Math.min(k0, k); k1 = Math.max(k1, k);
      }
      bi0 = Math.min(bi0, i0); bj0 = Math.min(bj0, j0); bk0 = Math.min(bk0, k0); bi1 = Math.max(bi1, i1); bj1 = Math.max(bj1, j1); bk1 = Math.max(bk1, k1);
      if (list.length < 22) { for (const o of list) if (M.hash3(o, 9, 9) < 0.5) rubble.push({ x: (o % NX) * H, y: (Math.floor(o / NX) % NY) * H, z: Math.floor(o / SXY) * H, mat: W.mat[o] }); continue; }
      // local grid with one lattice of padding
      const gx = i1 - i0 + 3, gy = j1 - j0 + 3, gz = k1 - k0 + 3, gd = new Float32Array(gx * gy * gz).fill(-0.6), gm = new Uint8Array(gx * gy * gz);
      let cx = 0, cy = 0, cz = 0, mass = 0;
      const matCount = new Uint32Array(C.MATS.length);
      for (const o of list) {
        const i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / SXY), l = ((k - k0 + 1) * gy + (j - j0 + 1)) * gx + (i - i0 + 1);
        gd[l] = Math.max(0.35, Math.min(1.5, W.d[o])); gm[l] = W.mat[o]; matCount[W.mat[o]]++;
        const mv = C.MATS[W.mat[o]].rho * H * H * H;
        cx += i * H * mv; cy += j * H * mv; cz += k * H * mv; mass += mv;
      }
      cx /= mass; cy /= mass; cz /= mass;
      let Ixx = 0, Iyy = 0, Izz = 0;
      const mv0 = mass / list.length;
      for (const o of list) {
        const x = (o % NX) * H - cx, y = (Math.floor(o / NX) % NY) * H - cy, z = Math.floor(o / SXY) * H - cz;
        Ixx += mv0 * (y * y + z * z + 0.04); Iyy += mv0 * (x * x + z * z + 0.04); Izz += mv0 * (x * x + y * y + 0.04);
      }
      // collision points: shell voxels, spread out by a coarse 3D hash grid
      const pts = [], taken = new Set(), cell = Math.max(0.8, M.cbrt(list.length * 0.125) / 3);
      for (const o of list) {
        const i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / SXY);
        const l = ((k - k0 + 1) * gy + (j - j0 + 1)) * gx + (i - i0 + 1);
        const shell = gd[l - 1] <= 0 || gd[l + 1] <= 0 || gd[l - gx] <= 0 || gd[l + gx] <= 0 || gd[l - gx * gy] <= 0 || gd[l + gx * gy] <= 0;
        if (!shell) continue;
        const key = Math.floor(i * H / cell) + ',' + Math.floor(j * H / cell) + ',' + Math.floor(k * H / cell);
        if (taken.has(key)) continue;
        taken.add(key); pts.push(i * H - cx, j * H - cy, k * H - cz, 0.26);
        if (pts.length >= 48 * 4) break;
      }
      let dom = 0; for (let m = 1; m < C.MATS.length; m++) if (matCount[m] > matCount[dom]) dom = m;
      pieces.push({
        grid: { nx: gx, ny: gy, nz: gz, d: gd, mat: gm, i0: i0 - 1, j0: j0 - 1, k0: k0 - 1 },
        com: { x: cx, y: cy, z: cz }, mass, inertia: { x: Ixx, y: Iyy, z: Izz }, pts: new Float32Array(pts), mat: dom, voxels: list.length
      });
    }
    for (let q = 0; q < n; q++) { const o = comp[q]; W.d[o] = -0.6; W.mat[o] = MAT.AIR; W.heat[o] = 0; }
    W.mark(bi0 - 1, bj0 - 1, bk0 - 1, bi1 + 1, bj1 + 1, bk1 + 1);
    return { pieces, rubble };
  };

  /* blast.js hook (settings.collapse): after a crater, cut out every component around the edited box that lost its
   * support and hand the pieces to the rigid-body solver (they fall, tumble and re-bake where they come to rest).
   * Small leftovers (< 22 voxels) become 'rubble' (FX only). The new pieces get the same blast kick as other bodies. */
  SS.collapse_hook = function (S, box) {
    if (!SS.bodies) return null;
    const W = SS.world, comps = K.find_floating(W, box);
    if (!comps.length) return null;
    let vox = 0, rub = 0;
    const made = [];
    for (const comp of comps) {
      vox += comp.length;
      const r = K.detach(W, comp, S.rng);
      for (const p of r.pieces) made.push(SS.bodies.from_piece(S, p));
      rub += r.rubble.length;
      if (r.rubble.length) SS.sim.emit(S, 'rubble', { pts: r.rubble.slice(0, 24) });
    }
    const e = S.lastExplosion;
    if (e && made.length) SS.bodies.blast(S, e, M.pow(e.R / 3, 3), made);
    const ev = { voxels: vox, pieces: made.length, rubble: rub, x: 0, y: 0, z: 0 };
    for (const b of made) { ev.x += b.pos.x / made.length; ev.y += b.pos.y / made.length; ev.z += b.pos.z / made.length; }
    SS.sim.emit(S, 'collapse', ev);
    if (made.length) SS.sim.log(S, `Unsupported rock breaks off: ${made.length} piece${made.length > 1 ? 's' : ''}, ${(vox * W.H * W.H * W.H).toFixed(1)} m³.`, 0xd8c8a8);
    return ev;
  };

  /* Stamp a resting piece back into the world field (resampling its rotated local grid). */
  K.rebake = function (W, g, com, pos, q) {
    const H = W.H, NX = W.NX, NY = W.NY;
    const r = M.len3(g.nx, g.ny, g.nz) * H * 0.5 + 1;
    const i0 = Math.max(1, Math.floor((pos.x - r) / H)), i1 = Math.min(W.NX - 2, Math.ceil((pos.x + r) / H));
    const j0 = Math.max(2, Math.floor((pos.y - r) / H)), j1 = Math.min(W.NY - 2, Math.ceil((pos.y + r) / H));
    const k0 = Math.max(1, Math.floor((pos.z - r) / H)), k1 = Math.min(W.NZ - 2, Math.ceil((pos.z + r) / H));
    const v = { x: 0, y: 0, z: 0 };
    let added = 0;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      M.q_rot_inv(q, i * H - pos.x, j * H - pos.y, k * H - pos.z, v);
      // local lattice coords: world-at-creation = com + v  ->  grid index
      const fx = (com.x + v.x) / H - g.i0, fy = (com.y + v.y) / H - g.j0, fz = (com.z + v.z) / H - g.k0;
      if (fx < 0 || fy < 0 || fz < 0 || fx >= g.nx - 1 || fy >= g.ny - 1 || fz >= g.nz - 1) continue;
      const a = Math.floor(fx), b = Math.floor(fy), c = Math.floor(fz), u = fx - a, w = fy - b, t = fz - c;
      const L = (aa, bb, cc) => g.d[((c + cc) * g.ny + (b + bb)) * g.nx + (a + aa)];
      const dv = M.lerp(M.lerp(M.lerp(L(0, 0, 0), L(1, 0, 0), u), M.lerp(L(0, 1, 0), L(1, 1, 0), u), w), M.lerp(M.lerp(L(0, 0, 1), L(1, 0, 1), u), M.lerp(L(0, 1, 1), L(1, 1, 1), u), w), t);
      const o = (k * NY + j) * NX + i;
      if (dv > W.d[o]) {
        if (dv > 0 && W.d[o] <= 0) {
          const m = g.mat[((Math.round(fz)) * g.ny + Math.round(fy)) * g.nx + Math.round(fx)];
          W.mat[o] = m || g.mat.find(x => x) || MAT.ROCK; W.heat[o] = 0; added++;
        }
        W.d[o] = dv;
      }
    }
    W.mark(i0, j0, k0, i1, j1, k1);
    return added;
  };
})(window.SS = window.SS || {});
