/* sim/aid.js — P95: the CPU's cave navigation (sub-module of sim/ai.js; hook: giveUp -> aib.nav_walk). Portable and deterministic: reads the world lattice only, no RNG,
 * no Map / Set; the scratch arrays are static (C: static arrays sized by the world at the first call).
 * Why: in a caverns match the foes sit behind rock in a winding 3D cave; the CPU searches shots on ONE vertical plane through the foe, finds none and ended 27 of 31 turns
 * with no action (both teams then died in the final stand: a draw). A human walks round the corner. The plane is fixed once the worm moves (rotation lock), so the CPU
 * can only walk ONE straight leg per turn: the leg is chosen on a path through the cave.
 * How: the "standable" cells of the lattice (a solid cell with CLEAR m of air above it; up to FL floors per 1 m column), a breadth-first search from ALL living foes over
 * walkable neighbour columns (a step up <= UP m, a drop <= DOWN m, the gap between them open), then from the worm's cell the path with decreasing distance; the leg ends at the
 * farthest path cell (<= LEG_MAX m of path) that a straight walk from the worm still reaches (the ground under the line keeps within a step / drop of the previous point).
 * API: leg(S, a) -> { x, y, z, rem (cells of path left to the nearest foe), n (cells walked) } or null. C layout: i16 dist[NCOL * FL]; i32 queue[NCOL * FL];
 * f32 floor[NCOL * FL]; u8 nfl[NCOL]; u32 stamp[NCOL]. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const ND = SS.nav = {};
  const K = ND.K = { STEP: 2, FL: 6, CLEAR: 1.4, UP: 1.6, DOWN: 3.5, LEG_MAX: 16, WALK_UP: 1.2, WALK_DOWN: 3.0, MAX_NODES: 90000 };
  let ncx = 0, ncz = 0, ncol = 0, fl = null, nfl = null, stamp = null, dist = null, queue = null, tick = 0, sizeVer = -1;
  const DI = [1, -1, 0, 0, 1, 1, -1, -1], DK = [0, 0, 1, -1, 1, -1, 1, -1];
  function ensure(w) {
    if (sizeVer === w.sizeVer && fl) return;
    ncx = Math.floor((w.NX - 1) / K.STEP); ncz = Math.floor((w.NZ - 1) / K.STEP); ncol = ncx * ncz;
    fl = new Float32Array(ncol * K.FL); nfl = new Uint8Array(ncol); stamp = new Uint32Array(ncol); dist = new Int16Array(ncol * K.FL); queue = new Int32Array(ncol * K.FL); sizeVer = w.sizeVer; tick = 0;
  }
  const wet = (S, x, z) => !!((SS.water && S.water && SS.water.depth(S, x, z) > 0.3) || (SS.lava && S.lava && SS.lava.depth_at(S, x, z) > 0.02));
  // the floors of column (ci, ck): y of every solid-to-air step with CLEAR m of air above it (the lattice point of the column centre), not under water / lava
  function floors(S, w, ci, ck) {
    const col = ck * ncx + ci;
    if (stamp[col] === tick) return nfl[col];
    stamp[col] = tick; let n = 0;
    const i = ci * K.STEP, k = ck * K.STEP, NX = w.NX, NY = w.NY, D = w.d, H = w.H, cl = Math.ceil(K.CLEAR / H);
    if (!wet(S, i * H, k * H)) {
      for (let j = 1; j < NY - cl - 1 && n < K.FL; j++) {
        const o = (k * NY + j) * NX + i, d0 = D[o - NX], d1 = D[o];
        if (!(d0 > 0 && d1 <= 0)) continue;
        let open = true; for (let q = 1; q <= cl; q++) if (D[o + q * NX] > 0) { open = false; break; }
        if (open) fl[col * K.FL + n++] = (j - 1) * H + H * d0 / (d0 - d1);
      }
    }
    nfl[col] = n; return n;
  }
  // the floor of column (ci, ck) nearest to y that lies at most `up` above and `down` below it (index, or -1)
  function nearest(S, w, ci, ck, y, up, down) {
    if (ci < 1 || ck < 1 || ci >= ncx - 1 || ck >= ncz - 1) return -1;
    const n = floors(S, w, ci, ck), col = ck * ncx + ci; let b = -1, bd = 1e9;
    for (let f = 0; f < n; f++) { const e = fl[col * K.FL + f] - y; if (e > up || -e > down) continue; const d = Math.abs(e); if (d < bd) { bd = d; b = f; } }
    return b;
  }
  // is the gap between the floors (y1 in column c1, y2 in column c2: lattice neighbours) open at body height?
  function gapOpen(w, ci, ck, di, dk, y1, y2) {
    const i = ci * K.STEP + di * (K.STEP >> 1), k = ck * K.STEP + dk * (K.STEP >> 1), j = Math.floor((M.max(y1, y2) + 0.7) / w.H);
    return !(w.d[(k * w.NY + j) * w.NX + i] > 0);
  }
  ND.leg = function (S, a) {
    const w = SS.world; if (!w || w.flat) return null;
    ensure(w); tick++;
    const cs = K.STEP * w.H, FLn = K.FL;
    const wi = Math.round(a.pos.x / cs), wk = Math.round(a.pos.z / cs), wf = nearest(S, w, wi, wk, a.pos.y - (a.foot || 0.5), 1.6, 1.6);
    if (wf < 0) return null;
    // the sources: every living enemy not in the water
    let head = 0, tail = 0; dist.fill(-1);
    for (let q = 0; q < S.worms.length; q++) {
      const o = S.worms[q]; if (o.dead || o.hp <= 0 || o.team === a.team || o.swim || o.drowning) continue;
      const ci = Math.round(o.pos.x / cs), ck = Math.round(o.pos.z / cs), f = nearest(S, w, ci, ck, o.pos.y - (o.foot || 0.5), 1.6, 1.6);
      if (f < 0) continue;
      const id = (ck * ncx + ci) * FLn + f; if (dist[id] < 0) { dist[id] = 0; queue[tail++] = id; }
    }
    if (!tail) return null;
    const goal = (wk * ncx + wi) * FLn + wf;
    while (head < tail && dist[goal] < 0 && tail < K.MAX_NODES) {
      const id = queue[head++], f = id % FLn, col = (id - f) / FLn, ci = col % ncx, ck = (col - ci) / ncx, y1 = fl[id], dd = dist[id];
      for (let n = 0; n < 8; n++) {
        const ni = ci + DI[n], nk = ck + DK[n]; if (ni < 1 || nk < 1 || ni >= ncx - 1 || nk >= ncz - 1) continue;
        const cnt = floors(S, w, ni, nk), nc = nk * ncx + ni;
        for (let g = 0; g < cnt; g++) {
          const y2 = fl[nc * FLn + g], dy = y2 - y1, nid = nc * FLn + g;
          if (dist[nid] >= 0 || dy > K.DOWN || dy < -K.UP || !gapOpen(w, ci, ck, DI[n], DK[n], y1, y2)) continue;      // (the search runs from the foe: the worm walks from the neighbour TO this cell, so a step up here is a drop there)
          dist[nid] = dd + 1; queue[tail++] = nid;
        }
      }
    }
    if (dist[goal] < 0) return null;
    // the path from the worm: always to a neighbour one step nearer (the first in a fixed order, the straight continuation first)
    const path = [goal]; let cur = goal, pd = -1;
    while (dist[cur] > 0 && path.length <= K.LEG_MAX) {
      const f = cur % FLn, col = (cur - f) / FLn, ci = col % ncx, ck = (col - ci) / ncx, y1 = fl[cur]; let nxt = -1, nn = -1;
      for (let t = 0; t < 8; t++) {
        const n = pd >= 0 ? (pd + t) % 8 : t, ni = ci + DI[n], nk = ck + DK[n]; if (ni < 1 || nk < 1 || ni >= ncx - 1 || nk >= ncz - 1) continue;
        const cnt = floors(S, w, ni, nk), nc = nk * ncx + ni;
        for (let g = 0; g < cnt; g++) {
          const nid = nc * FLn + g, dy = fl[nid] - y1;
          if (dist[nid] === dist[cur] - 1 && dy <= K.UP + 1e-6 && dy >= -K.DOWN - 1e-6 && gapOpen(w, ci, ck, DI[n], DK[n], y1, fl[nid])) { nxt = nid; nn = n; break; }
        }
        if (nxt >= 0) break;
      }
      if (nxt < 0) break;
      path.push(nxt); cur = nxt; pd = nn;
    }
    // the farthest path cell a straight walk reaches
    const px = [], pz = [], py = [];
    for (let q = 0; q < path.length; q++) { const f = path[q] % FLn, col = (path[q] - f) / FLn, ci = col % ncx, ck = (col - ci) / ncx; px.push(ci * cs); pz.push(ck * cs); py.push(fl[path[q]]); }
    let best = -1;
    for (let m = path.length - 1; m >= 1 && best < 0; m--) {
      let y = py[0], good = true; const L = M.len2(px[m] - px[0], pz[m] - pz[0]), n = M.max(1, Math.ceil(L / 0.5));
      for (let s = 1; s <= n && good; s++) {
        const t = s / n, x = px[0] + (px[m] - px[0]) * t, z = pz[0] + (pz[m] - pz[0]) * t, ci = Math.round(x / cs), ck = Math.round(z / cs), f = nearest(S, w, ci, ck, y, K.WALK_UP, K.WALK_DOWN);
        if (f < 0) { good = false; break; }
        y = fl[(ck * ncx + ci) * FLn + f];
      }
      if (good) best = m;
    }
    if (best < 0) best = 1;
    return { x: px[best], y: py[best], z: pz[best], rem: dist[goal], n: best };
  };
})(window.SS = window.SS || {});
