/* sim/eow.js — P68c EXPERIMENTAL biome "End of the World": a shattered planet in space (docs/notes/P68c.md).
 * Everything of this biome lives in this file (plus js/render/eowview.js); the rest of the sim only has the one-line
 * hooks `if (S.eow) SS.eow.xxx(...)` listed in docs/notes/P68c.md "How to remove". With the biome off nothing changes.
 *
 * World: floating voxel chunks (planet fragments: the material follows the depth in the lost planet, so the cut faces
 * show crust, sandstone, rock, basalt and glassy mantle), a wrecked ship hull (steel, decks, bulkheads, torn ends),
 * crystal spikes, lava-cored pockets and small debris, around the glowing remnant of the planet's core.
 * The voxel field is STATIC (the chunks never move in the sim): the slow tumbling of the sky, the sun and the far debris
 * is drawn by render/eowview.js only (see the notes for the trade-off against rotating per-chunk frames).
 * Gravity: planetoid gravity, a sum of attractors (bodies) with an inverse-square fall-off. Worms wear magnetic suits:
 * a grounded worm sticks to the surface it stands on and walks on any side of a chunk (its "up" is the local surface
 * normal), a worm in the air flies under the summed field with a magnetic landing brake near a surface.
 * Void: a worm far from every chunk (K.VOID_D for K.VOID_T s), outside the box, or inside the core, is lost.
 *
 * C: struct EowBody { f32 x, y, z, R, k; u8 kind }  (kind 0 chunk, 1 hull part, 2 debris, 3 core); struct Eow { EowBody b[N]; int n; EowBody core; }
 * Worm extras (set by E.spawned): vec3 eup (the world up vector), vec2 eu2 (up in the plane), i8 eSense, eLatch, eMv, f32 eVoid, u8 eGround, eFlipC.
 * Deterministic: own RNG streams (seed mixed with Math.imul), SS.math only, no Map / Set, no wall clock. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT, P = SS.plane;
  const E = SS.eow = {};
  const W = () => SS.world;
  const K = E.K = {
    CORE_Y: 20, CORE_R: 4.4, CORE_KILL: 3.7, CORE_K: 0.42,       // the core remnant: glowing ball (m), kill radius, pull
    WORM_G: 0.42, PROJ_G: 0.8, BODY_G: 0.6, PIECE_G: 0.3,        // gravity at a chunk's surface for worms (x G_WORM), shells (x G), props, drifting pieces
    FADE0: 2.6, FADE1: 4.2, F_MAX: 1.8,                           // the field fades between FADE0 and FADE1 body radii; its cap
    VOID_D: 14, VOID_T: 2.2, OUT_M: 6,                            // lost: m from the nearest surface, for s; m outside the box
    SAFE: 24, BRAKE_A: 28, V_LAND: 3.2, BRAKE_L: 5, BRAKE_STEP: 0.35,   // magnetic landing: damage above SAFE m/s, deceleration m/s2, soft speed m/s, look-ahead m
    STEP_DOWN: 1.1, RING: [0.85, 1.6, 2.6], UP_BLEND: 0.3,       // walking: the suit follows a drop of this size; the surface normal probe radii, its smoothing
    NUB_R: 1.1, HULL_HL: 16, HULL_WY: 4.4, HULL_WZ: 5.4, HULL_T: 1.0
  };
  const TAU = M.TAU;
  const lerp = M.lerp, clamp = M.clamp;
  const COS16 = [], SIN16 = [];
  for (let i = 0; i < 16; i++) { COS16.push(M.cos(i / 16 * TAU)); SIN16.push(M.sin(i / 16 * TAU)); }
  const RIM = []; for (let i = 0; i < 12; i++) { const t = i / 12 * TAU; RIM.push(M.cos(t) * C.WORM_R, M.sin(t) * C.WORM_R); }

  /* ================= plan: where everything is (pure function of seed and size) ================= */
  function plan(settings, sx) {
    const sc = sx / 96, mx = sx / 2, mz = sx / 2, sy = 40, rng = M.rng_make((Math.imul(settings.seed | 0, 7919) + 0x6e0f) >>> 0);
    const rr = (a, b) => M.rng_range(rng, a, b);
    const chunks = [], debris = [], B = [];
    // the wrecked ship first (a capsule A-B, radius 6.5, clear of the core), the chunks are placed around it
    let hull = null;
    const HL = K.HULL_HL * sc;
    for (let tries = 0; !hull && tries < 500; tries++) {
      const a = rr(0, TAU), rad = rr(15, 30) * sc, x = mx + M.cos(a) * rad, z = mz + M.sin(a) * rad, y = rr(11, 29), ax = a + TAU / 4 + rr(-0.6, 0.6), dx = M.cos(ax), dz = M.sin(ax);
      const A = [x - dx * (HL - 4), y, z - dz * (HL - 4)], Bp = [x + dx * (HL - 4), y, z + dz * (HL - 4)];
      if (A[0] < 7 || A[0] > sx - 7 || A[2] < 7 || A[2] > sx - 7 || Bp[0] < 7 || Bp[0] > sx - 7 || Bp[2] < 7 || Bp[2] > sx - 7) continue;
      let ok = M.seg_dist(mx, K.CORE_Y, mz, A, Bp) > K.CORE_R + 8;
      if (ok) hull = { x, y, z, ax: dx, az: dz, HL, wy: K.HULL_WY, wz: K.HULL_WZ, T: K.HULL_T, seed: 313, A, B: Bp, breach: [], tearU: rr(0.55, 0.72), tearV: rr(0.3, 0.45) };
    }
    if (hull) for (let q = 0; q < 4; q++) { const f = rr(0, TAU); hull.breach.push({ u: rr(-HL * 0.7, HL * 0.8), lat: M.cos(f) * hull.wz * 1.05, ly: M.sin(f) * hull.wy * 1.05, r: rr(1.8, 3.0) }); }   // impact holes through the skin, never through the middle
    const nBig = sc > 1.2 ? 8 : 5;
    const sphere = () => { const u = rr(-1, 1), a = rr(0, TAU), s = Math.sqrt(M.max(0, 1 - u * u)); return { x: s * M.cos(a), y: u, z: s * M.sin(a) }; };
    for (let tries = 0; chunks.length < nBig && tries < 900; tries++) {
      const R = rr(8, 12.5), rx = R * rr(0.95, 1.2), rz = R * rr(0.95, 1.2), ry = R * rr(0.55, 0.78), Re = M.cbrt(rx * ry * rz);
      const a = rr(0, TAU), rad = rr(17, 31) * sc, x = mx + M.cos(a) * rad, z = mz + M.sin(a) * rad, y = rr(ry + 3, sy - ry - 3);
      if (x < rx + 2 || x > sx - rx - 2 || z < rz + 2 || z > sx - rz - 2) continue;
      if (M.len3(x - mx, y - K.CORE_Y, z - mz) < M.max(rx, M.max(ry, rz)) * 0.9 + K.CORE_R + 3.5) continue;
      let gap = 1e9, ok = true;
      for (let q = 0; q < chunks.length; q++) { const c = chunks[q], g = M.len3(x - c.x, (y - c.y) * 1.3, z - c.z) - Re - c.R; if (g < 5) { ok = false; break; } if (g < gap) gap = g; }
      if (ok && hull && M.seg_dist(x, y, z, hull.A, hull.B) - Re - 6.6 < 4.5) ok = false;
      if (!ok || (chunks.length && gap > 13)) continue;
      const cut = [], bites = [], nCut = 1 + (rr(0, 1) < 0.4 ? 1 : 0);
      for (let q = 0; q < nCut; q++) { const n = sphere(); cut.push({ nx: n.x, ny: n.y, nz: n.z, off: Re * rr(0.45, 0.72) }); }
      for (let q = 0, nb = 2 + M.rng_int(rng, 2); q < nb; q++) { const n = sphere(), br = Re * rr(0.2, 0.34); bites.push({ x: x + n.x * Re * 0.92, y: y + n.y * Re * 0.7, z: z + n.z * Re * 0.92, r: br }); }
      chunks.push({ x, y, z, rx, ry, rz, R: Re, cut, bites, seed: 11 + chunks.length * 37, lava: false, spikes: [] });
    }
    let nLava = 0;
    for (const c of chunks) if (nLava < 2 && M.len3(c.x - mx, c.y - K.CORE_Y, c.z - mz) < 29 * sc && c.R > 8.6) { c.lava = true; nLava++; }
    if (!nLava && chunks.length) chunks[0].lava = true;
    const spikeOf = c => { for (let q = 0, n = 4 + M.rng_int(rng, 4); q < n; q++) { const d = sphere(); c.spikes.push({ dx: d.x, dy: d.y, dz: d.z, L: rr(3, 5.6), r: rr(0.55, 0.95) }); } };
    for (let q = 0; q < chunks.length; q++) if (q % 2 === 0 && q < 5) spikeOf(chunks[q]);
    // debris: small lumps and a few steel plates, 2.5-7 m from a big chunk
    const nDeb = Math.round(7 * sc * sc);
    for (let tries = 0; debris.length < nDeb && tries < 600 && chunks.length; tries++) {
      const pj = chunks[M.rng_int(rng, chunks.length)], d = sphere(), Rd = rr(1.3, 3.0), plate = debris.length === 2 || debris.length === 5, Rg = plate ? Rd * 1.9 : Rd, dist = pj.R + Rg + rr(3, 7);
      const x = pj.x + d.x * dist, y = pj.y + d.y * dist * 0.7, z = pj.z + d.z * dist;
      if (x < Rd + 3 || x > sx - Rd - 3 || z < Rd + 3 || z > sx - Rd - 3 || y < Rd + 3 || y > sy - Rd - 3) continue;
      if (M.len3(x - mx, y - K.CORE_Y, z - mz) < Rd + K.CORE_R + 3) continue;
      let ok = true;
      for (const c of chunks) if (M.len3(x - c.x, (y - c.y) * 1.3, z - c.z) - c.R - Rg < 3.5) { ok = false; break; }
      for (const o of debris) if (ok && M.len3(x - o.x, y - o.y, z - o.z) - o.R * (o.plate ? 1.9 : 1) - Rg < 2.5) ok = false;
      if (ok && hull && M.seg_dist(x, y, z, hull.A, hull.B) - Rg - 6.6 < 3) ok = false;
      if (!ok) continue;
      debris.push({ x, y, z, R: Rd, plate, yaw: rr(0, TAU), seed: 101 + debris.length * 13 });
    }
    for (const c of chunks) B.push({ x: c.x, y: c.y, z: c.z, R: c.R, k: 1, kind: 0 });
    if (hull) for (const u of [-9 * sc, 0, 9 * sc]) B.push({ x: hull.x + hull.ax * u, y: hull.y, z: hull.z + hull.az * u, R: 6.5, k: 0.85, kind: 1 });
    for (const d of debris) B.push({ x: d.x, y: d.y, z: d.z, R: d.R, k: 1, kind: 2 });
    const core = { x: mx, y: K.CORE_Y, z: mz, R: K.CORE_R, k: 1, kind: 3 };
    B.push({ x: core.x, y: core.y, z: core.z, R: K.CORE_R + 1.5, k: K.CORE_K, kind: 3 });
    return { sx, chunks, hull, debris, bodies: B, core };
  }
  E.plan = plan;

  /* ================= voxel generation ================= */
  let Wd = null, seedS = 0;
  const LAYERS = [[34, MAT.SOIL], [30, MAT.SANDSTONE], [24, MAT.ROCK], [18, MAT.BASALT], [-1, MAT.CRUST]];   // r0 (m from the core) -> material
  const layerAt = (x, y, z, core) => {
    const r0 = M.len3(x - core.x, y - core.y, z - core.z) + (M.noise3(x / 8, y / 8, z / 8, seedS + 5) - 0.5) * 6;
    for (let i = 0; i < LAYERS.length; i++) if (r0 >= LAYERS[i][0]) return LAYERS[i][1];
    return MAT.CRUST;
  };
  function box(x0, y0, z0, x1, y1, z1) {
    const H = Wd.H;
    return [M.max(0, Math.floor(x0 / H)), M.min(Wd.NX - 1, Math.ceil(x1 / H)), M.max(1, Math.floor(y0 / H)), M.min(Wd.NY - 2, Math.ceil(y1 / H)), M.max(0, Math.floor(z0 / H)), M.min(Wd.NZ - 1, Math.ceil(z1 / H))];
  }
  function fillChunk(c, core) {
    const H = Wd.H, NX = Wd.NX, NY = Wd.NY, D = Wd.d, Mt = Wd.mat, rmin = M.min(c.rx, M.min(c.ry, c.rz)), reach = M.max(c.rx, M.max(c.ry, c.rz)) + 3.5;
    const b = box(c.x - reach, c.y - reach, c.z - reach, c.x + reach, c.y + reach, c.z + reach);
    for (let k = b[4]; k <= b[5]; k++) for (let j = b[2]; j <= b[3]; j++) for (let i = b[0]; i <= b[1]; i++) {
      const x = i * H, y = j * H, z = k * H, qx = x - c.x, qy = y - c.y, qz = z - c.z, e = M.len3(qx / c.rx, qy / c.ry, qz / c.rz);
      if (e > 1.7) continue;
      let dv = (1 - e) * rmin + (M.fbm3(x / 7.5, y / 7.5, z / 7.5, c.seed, 3) - 0.5) * 6 + (M.noise3(x / 2.4, y / 2.4, z / 2.4, c.seed + 9) - 0.5) * 1.3;
      for (let q = 0; q < c.cut.length; q++) { const p = c.cut[q]; dv = M.min(dv, p.off - (qx * p.nx + qy * p.ny + qz * p.nz)); }
      for (let q = 0; q < c.bites.length; q++) { const p = c.bites[q]; dv = M.min(dv, M.len3(x - p.x, y - p.y, z - p.z) - p.r); }
      if (dv < -3) continue;
      if (dv > 3) dv = 3;
      const o = (k * NY + j) * NX + i;
      if (dv > D[o]) { D[o] = dv; Mt[o] = dv > 0 ? layerAt(x, y, z, core) : MAT.AIR; }
    }
  }
  function fillDebris(d, core) {
    const H = Wd.H, NX = Wd.NX, NY = Wd.NY, D = Wd.d, Mt = Wd.mat, reach = d.R * (d.plate ? 2.2 : 1) + 3;
    const b = box(d.x - reach, d.y - reach, d.z - reach, d.x + reach, d.y + reach, d.z + reach), cy = M.cos(d.yaw), sy = M.sin(d.yaw);
    for (let k = b[4]; k <= b[5]; k++) for (let j = b[2]; j <= b[3]; j++) for (let i = b[0]; i <= b[1]; i++) {
      const x = i * H, y = j * H, z = k * H, qx = x - d.x, qy = y - d.y, qz = z - d.z;
      let dv;
      if (d.plate) {                                         // a torn hull plate: a thin slab 2R x 0.45R x 1.3R, jagged edges
        const lx = qx * cy + qz * sy, lz = -qx * sy + qz * cy, jag = (M.noise3(x / 1.4, y / 1.4, z / 1.4, d.seed) - 0.5) * 1.1;
        dv = M.min(d.R * 1.7 - Math.abs(lx), M.min(0.75 - Math.abs(qy), d.R * 1.1 - Math.abs(lz))) + jag;
      } else dv = (d.R - M.len3(qx, qy * 1.25, qz)) + (M.noise3(x / 1.8, y / 1.8, z / 1.8, d.seed) - 0.5) * 1.6;
      if (dv < -3) continue;
      if (dv > 3) dv = 3;
      const o = (k * NY + j) * NX + i;
      if (dv > D[o]) { D[o] = dv; Mt[o] = dv > 0 ? (d.plate ? MAT.STEEL : layerAt(x, y, z, core)) : MAT.AIR; }
    }
    const o = (Math.round(d.z / H) * NY + Math.round(d.y / H)) * NX + Math.round(d.x / H);   // its anchor: one bedrock voxel (collapse.js: only bedrock / steel hold)
    if (D[o] > 0.4) Mt[o] = d.plate ? MAT.STEEL : MAT.BEDROCK;
  }
  function fillHull(h) {
    const H = Wd.H, NX = Wd.NX, NY = Wd.NY, D = Wd.d, Mt = Wd.mat, reach = h.HL + 6;
    const b = box(h.x - reach, h.y - reach, h.z - reach, h.x + reach, h.y + reach, h.z + reach), T = h.T;
    const ax = h.ax, az = h.az, lx = -az, lz = ax;
    for (let k = b[4]; k <= b[5]; k++) for (let j = b[2]; j <= b[3]; j++) for (let i = b[0]; i <= b[1]; i++) {
      const x = i * H, y = j * H, z = k * H, qx = x - h.x, qy = y - h.y, qz = z - h.z, u = qx * ax + qz * az, lat = qx * lx + qz * lz, ly = qy;
      if (Math.abs(u) > h.HL + 2 || Math.abs(lat) > h.wz + 2 || Math.abs(ly) > h.wy + 2) continue;
      const t = Math.abs(u) / h.HL, bow = u > 0 && t > 0.6 ? Math.sqrt(M.max(0.0001, 1 - M.pow((t - 0.6) / 0.4, 2))) : 1;
      const wyU = h.wy * bow, wzU = h.wz * bow;
      const e = M.pow(M.pow(Math.abs(ly) / wyU, 3) + M.pow(Math.abs(lat) / wzU, 3), 1 / 3), outer = (1 - e) * M.min(wyU, wzU);
      let dv = M.min(outer, T - outer), mat = MAT.STEEL;
      const m = ((u + h.HL) % 5) - 2.5;                                   // frames every 5 m
      if (dv < 0 && outer > T && outer < T + 0.9 && Math.abs(m) < 0.4) { dv = 0.4; mat = MAT.STEEL; }
      if (dv < 0 && outer > T - 0.2) {
        if (Math.abs(ly + 1.2) < 0.5) { dv = 0.5 - Math.abs(ly + 1.2); mat = MAT.CONCRETE; }          // lower deck
        else if (Math.abs(ly - 1.9) < 0.4 && M.noise3(u / 5, lat / 5, 3, h.seed) > 0.42) { dv = 0.4 - Math.abs(ly - 1.9); mat = MAT.CONCRETE; }   // upper deck, partly gone
        else for (const ub of [-4, 6]) if (Math.abs(u - ub) < 0.4 && M.noise3(lat / 3, ly / 3, 7 + ub, h.seed) < 0.7) {       // bulkheads with a doorway
          const dd = (lat / 1.5) * (lat / 1.5) + ((ly + 0.0) / 1.6) * ((ly + 0.0) / 1.6);
          if (dd > 1) { dv = 0.4 - Math.abs(u - ub); mat = MAT.STEEL; }
        }
      }
      dv = M.min(dv, u - (-h.HL * h.tearU + 7 * (M.fbm3(lat / 3.2, ly / 3.2, 5, h.seed, 2) - 0.5)));   // the stern is torn off along a ragged line
      if (u > h.HL * 0.86) dv = M.min(dv, h.HL * 0.99 - u + (M.noise3(lat / 2, ly / 2, 9, h.seed) - 0.5) * 3);   // ... and the bow frayed
      for (let q = 0; q < h.breach.length; q++) {                         // impact breaches
        const br = h.breach[q];
        dv = M.min(dv, M.len3(u - br.u, lat - br.lat, ly - br.ly) - br.r * (1 + 0.28 * (M.noise3(x / 1.5, y / 1.5, z / 1.5, h.seed + q) - 0.5)));
      }
      if (dv < -3) continue;
      if (dv > 3) dv = 3;
      const o = (k * NY + j) * NX + i;
      if (dv > D[o]) { D[o] = dv; Mt[o] = dv > 0 ? mat : MAT.AIR; }
    }
  }
  const dAt = (x, y, z) => Wd.sample(x, y, z);
  function nubOf(c, rng) {                                     // a bedrock nub deep inside: it anchors the chunk (collapse.js); returns its direction
    let best = null, bd = -9;
    for (let q = 0; q < 16; q++) {
      const u = M.rng_range(rng, -1, 1), a = M.rng_range(rng, 0, TAU), s = Math.sqrt(M.max(0, 1 - u * u)), r = c.R * M.rng_range(rng, 0.05, 0.3);
      const x = c.x + s * M.cos(a) * r, y = c.y + u * r * 0.7, z = c.z + s * M.sin(a) * r, dv = dAt(x, y, z);
      if (dv > bd) { bd = dv; best = { x, y, z, ux: s * M.cos(a), uy: u, uz: s * M.sin(a) }; }
    }
    const H = Wd.H, NX = Wd.NX, NY = Wd.NY, r = M.min(K.NUB_R, M.max(0.7, bd - 0.5)), D = Wd.d, Mt = Wd.mat;
    const b = box(best.x - r - 1, best.y - r - 1, best.z - r - 1, best.x + r + 1, best.y + r + 1, best.z + r + 1);
    for (let k = b[4]; k <= b[5]; k++) for (let j = b[2]; j <= b[3]; j++) for (let i = b[0]; i <= b[1]; i++) {
      const o = (k * NY + j) * NX + i, dd = M.len3(i * H - best.x, j * H - best.y, k * H - best.z);
      if (dd < r + 0.5) { if (D[o] > 0 || dd < r) { Mt[o] = MAT.BEDROCK; if (D[o] < 0.6) D[o] = 0.6; } }
    }
    return best;
  }
  function pocketOf(c, nub, rng) {                              // a sealed magma pocket in a crust wall (lava.js is not stepped here: it stays put)
    const rpx = M.rng_range(rng, 2.3, 3.0), rpy = rpx * 0.75, rpz = rpx * 0.95, H = Wd.H, NX = Wd.NX, NY = Wd.NY, D = Wd.d, Mt = Wd.mat;
    for (let q = 0; q < 40; q++) {
      const u = M.rng_range(rng, -1, 1), a = M.rng_range(rng, 0, TAU), s = Math.sqrt(M.max(0, 1 - u * u)), r = c.R * M.rng_range(rng, 0.25, 0.55);
      const px = c.x + s * M.cos(a) * r, py = c.y + u * r * 0.6, pz = c.z + s * M.sin(a) * r;
      if (nub && M.len3(px - nub.x, py - nub.y, pz - nub.z) < rpx + 1.1 + K.NUB_R + 0.3) continue;
      if (dAt(px, py, pz) < 2.9 || dAt(px, py + rpy, pz) < 1.3 || dAt(px, py - rpy, pz) < 1.3 || dAt(px + rpx, py, pz) < 1.3 || dAt(px - rpx, py, pz) < 1.3 || dAt(px, py, pz + rpz) < 1.3 || dAt(px, py, pz - rpz) < 1.3) continue;
      const w = 1.1, b = box(px - rpx - w - 1, py - rpy - w - 1, pz - rpz - w - 1, px + rpx + w + 1, py + rpy + w + 1, pz + rpz + w + 1);
      for (let k = b[4]; k <= b[5]; k++) for (let j = b[2]; j <= b[3]; j++) for (let i = b[0]; i <= b[1]; i++) {
        const o = (k * NY + j) * NX + i, e = M.len3((i * H - px) / rpx, (j * H - py) / rpy, (k * H - pz) / rpz);
        if (Mt[o] === MAT.BEDROCK) continue;
        if (e < 1) { Mt[o] = MAT.LAVA; Wd.heat[o] = 250; D[o] = M.max(D[o], 0.8); }
        else if (e < 1 + w / rpy) { Mt[o] = MAT.CRUST; D[o] = M.max(D[o], 1.0); }
      }
      return { x: px, y: py, z: pz, rx: rpx, ry: rpy, rz: rpz };
    }
    return null;
  }
  function spikeOf(c, sp) {                                     // a crystal: a tapering ice-blue spike growing out of the surface
    let r = 0; const D = Wd.d, Mt = Wd.mat, H = Wd.H, NX = Wd.NX, NY = Wd.NY;
    for (; r < c.R * 2.4; r += 0.25) if (dAt(c.x + sp.dx * r, c.y + sp.dy * r, c.z + sp.dz * r) < 0) break;
    if (r >= c.R * 2.4) return;
    const bx = c.x + sp.dx * (r - 0.9), by = c.y + sp.dy * (r - 0.9), bz = c.z + sp.dz * (r - 0.9), L = sp.L + 0.9;
    const ex = bx + sp.dx * L, ey = by + sp.dy * L, ez = bz + sp.dz * L;
    const b = box(M.min(bx, ex) - sp.r - 1, M.min(by, ey) - sp.r - 1, M.min(bz, ez) - sp.r - 1, M.max(bx, ex) + sp.r + 1, M.max(by, ey) + sp.r + 1, M.max(bz, ez) + sp.r + 1);
    for (let k = b[4]; k <= b[5]; k++) for (let j = b[2]; j <= b[3]; j++) for (let i = b[0]; i <= b[1]; i++) {
      const px = i * H - bx, py = j * H - by, pz = k * H - bz, t = clamp((px * sp.dx + py * sp.dy + pz * sp.dz) / L, 0, 1);
      const dd = M.len3(px - sp.dx * L * t, py - sp.dy * L * t, pz - sp.dz * L * t), dv = sp.r * (1 - 0.82 * t) - dd;
      if (dv < -1) continue;
      const o = (k * NY + j) * NX + i;
      if (Mt[o] === MAT.BEDROCK || Mt[o] === MAT.LAVA || Mt[o] === MAT.STEEL) continue;
      if (dv > D[o]) { D[o] = M.min(dv, 1.5); if (dv > 0) Mt[o] = MAT.ICE; }
    }
  }
  // the generator leaves a few single voxels (hull edges, noise): remove every solid component smaller than `min` voxels
  function specks(w, min) {
    const N = w.N, NX = w.NX, NY = w.NY, SXY = NX * NY, D = w.d, seen = new Uint8Array(N), st = new Int32Array(N);
    for (let o0 = 0; o0 < N; o0++) {
      if (D[o0] <= 0 || seen[o0]) continue;
      let sp = 0, n = 0; st[sp++] = o0; seen[o0] = 1;
      while (sp > 0) {
        const o = st[--sp]; n++;
        const i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / SXY);
        if (i > 0 && !seen[o - 1] && D[o - 1] > 0) { seen[o - 1] = 1; st[sp++] = o - 1; }
        if (i < NX - 1 && !seen[o + 1] && D[o + 1] > 0) { seen[o + 1] = 1; st[sp++] = o + 1; }
        if (j > 0 && !seen[o - NX] && D[o - NX] > 0) { seen[o - NX] = 1; st[sp++] = o - NX; }
        if (j < NY - 1 && !seen[o + NX] && D[o + NX] > 0) { seen[o + NX] = 1; st[sp++] = o + NX; }
        if (k > 0 && !seen[o - SXY] && D[o - SXY] > 0) { seen[o - SXY] = 1; st[sp++] = o - SXY; }
        if (k < w.NZ - 1 && !seen[o + SXY] && D[o + SXY] > 0) { seen[o + SXY] = 1; st[sp++] = o + SXY; }
      }
      if (n >= min) continue;
      sp = 0; st[sp++] = o0; seen[o0] = 2;                      // a second pass over the same component: clear it
      while (sp > 0) {
        const o = st[--sp]; D[o] = -0.5; w.mat[o] = 0;
        const i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / SXY);
        const nb = [i > 0 ? o - 1 : -1, i < NX - 1 ? o + 1 : -1, j > 0 ? o - NX : -1, j < NY - 1 ? o + NX : -1, k > 0 ? o - SXY : -1, k < w.NZ - 1 ? o + SXY : -1];
        for (let q = 0; q < 6; q++) { const m = nb[q]; if (m >= 0 && seen[m] === 1 && D[m] > 0) { seen[m] = 2; st[sp++] = m; } }
      }
    }
  }
  E.gen_begin = function (world, settings) {
    Wd = world; seedS = (settings.seed | 0) * 131 + 35;
    world.eow = true; world.under = false; world.dry = false; world.SEA = -1; world.far = null; world.circ = null; world.frz = null; world.biome = 'eow';
    world.d.fill(-3); world.mat.fill(0); world.heat.fill(0);
    const pl = plan(settings, world.SX);
    world.features = { biome: 'eow', volcano: null, volcanoes: [], canals: [], lavaInit: null, pockets: [], vents: [], spires: [], bridges: [], iceShelf: false, lavaPresent: false, eow: pl };
    pl.nubs = []; pl.pockets = [];
    return { settings, biome: 'eow', spec: null, stage: 0, k: 0, label: 'Shattering the planet', under: false, eow: true, plan: pl, rng: M.rng_make((seedS * 7919 + 13) >>> 0) };
  };
  E.gen_step = function (job) {
    const pl = job.plan, w = Wd;
    switch (job.stage) {
      case 0: { for (const c of pl.chunks) fillChunk(c, pl.core); job.stage = 1; job.label = 'Wrecking the ship'; return 0.35; }
      case 1: { for (const d of pl.debris) fillDebris(d, pl.core); if (pl.hull) fillHull(pl.hull); job.stage = 2; job.label = 'Growing crystals and magma'; return 0.6; }
      case 2: {
        for (const c of pl.chunks) { const nub = nubOf(c, job.rng); pl.nubs.push(nub); if (c.lava) { const p = pocketOf(c, nub, job.rng); if (p) pl.pockets.push(p); } }
        for (const c of pl.chunks) for (const sp of c.spikes) spikeOf(c, sp);
        job.stage = 3; job.label = 'Checking structural support'; return 0.85;
      }
      case 3: {
        if (SS.collapse) SS.collapse.remove_floating_all(w);
        specks(w, 40);
        w.features.lavaPresent = pl.pockets.length > 0;
        job.stage = 5; job.label = 'Done'; return 1;
      }
      default: return 1;
    }
  };
  /* the menu preview: the top view heights of the plan (no voxels), same shape as worldgen.preview */
  E.preview = function (settings, n, sx) {
    const pl = plan(settings, sx), out = { n, sx, sea: -1, under: false, dry: false, h: new Float32Array(n * n), lava: new Uint8Array(n * n), volcanoes: [], biome: 'eow', shape: 'islands' };
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * sx, z = k / (n - 1) * sx; let h = 0;
      for (const c of pl.chunks) { const e = (x - c.x) * (x - c.x) / (c.rx * c.rx) + (z - c.z) * (z - c.z) / (c.rz * c.rz); if (e < 1) h = M.max(h, c.y + c.ry * Math.sqrt(1 - e)); }
      for (const d of pl.debris) { const e = M.len2(x - d.x, z - d.z); if (e < d.R) h = M.max(h, d.y + Math.sqrt(d.R * d.R - e * e)); }
      if (pl.hull) { const dd = M.seg_dist(x, pl.hull.y, z, pl.hull.A, pl.hull.B); if (dd < pl.hull.wz) h = M.max(h, pl.hull.y + pl.hull.wy * (1 - dd / pl.hull.wz * 0.5)); }
      out.h[k * n + i] = h;
    }
    return out;
  };

  /* ================= state ================= */
  E.init = function (S) {
    const w = W();
    if (!w.eow || !w.features || !w.features.eow) { S.eow = null; return; }
    const pl = w.features.eow;
    S.eow = { bodies: pl.bodies, core: pl.core, lost: 0 };
    S.settings.weather = 'clear'; S.settings.wind = 'calm';                  // no weather in space
  };
  const ensure = w => { if (!w.eup) { w.eup = { x: 0, y: 1, z: 0 }; w.eu2 = { s: 0, y: 1 }; w.eVoid = 0; w.eSense = 1; w.eLatch = 0; w.eMv = 0; w.eGround = false; w.eFlipC = false; w.eStill = 0; w.eAirPrev = false; } return w; };
  E.spawned = function (S) {
    for (const w of S.worms) ensure(w);
    SS.sim.log(S, 'End of the world: magnetic suits hold you to any surface. The void and the core are fatal.', 0x9fd0ff);
  };

  /* ================= gravity field ================= */
  // dimensionless pull (1 = the surface of one chunk) at a point: sum over the bodies, toward each centre
  function field(S, x, y, z, out) {
    const B = S.eow.bodies; let gx = 0, gy = 0, gz = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i], dx = b.x - x, dy = b.y - y, dz = b.z - z, r2 = dx * dx + dy * dy + dz * dz, R = b.R;
      if (r2 > K.FADE1 * K.FADE1 * R * R) continue;
      const r = Math.sqrt(r2);
      let f = r < R ? b.k * r / R : b.k * R * R / r2;
      if (r > K.FADE0 * R) f *= 1 - M.smoothstep(K.FADE0 * R, K.FADE1 * R, r);
      const q = f / M.max(r, 1e-6); gx += dx * q; gy += dy * q; gz += dz * q;
    }
    const l = M.len3(gx, gy, gz);
    if (l > K.F_MAX) { const k = K.F_MAX / l; gx *= k; gy *= k; gz *= k; }
    out.x = gx; out.y = gy; out.z = gz;
    return out;
  }
  E.field = field;
  const fg = { x: 0, y: 0, z: 0 };
  // m/s2 on a shell at a world point, projected on the plane (dx, dz = the plane's direction): out.s, out.y
  E.proj_acc = function (S, x, y, z, dx, dz, out) {
    field(S, x, y, z, fg); const a = C.G * K.PROJ_G;
    out.s = (fg.x * dx + fg.z * dz) * a; out.y = fg.y * a; return out;
  };
  // the same for a worm (G_WORM x its gravity factor)
  function worm_acc(S, w, x, y, z, dx, dz, out) {
    field(S, x, y, z, fg); const a = C.G_WORM * K.WORM_G * SS.sim.gravity_k(S, w);
    out.s = (fg.x * dx + fg.z * dz) * a; out.y = fg.y * a; out.x = fg.x * a; out.z = fg.z * a; return out;
  }
  E.rope_g = function (S, a, h) {                                            // the ninja rope's pendulum (traverse.js rope_step) under the field
    const c = M.cos(S.theta), sn = M.sin(S.theta), s = P.to_plane(S, a.pos).s, o = { s: 0, y: 0, x: 0, z: 0 };
    const q = P.to_world(S, s, a.pos.y); worm_acc(S, a, q.x, q.y, q.z, c, sn, o);
    a.vs += o.s * h; a.vy += o.y * h;
  };
  // a rigid body (prop, crate, drifting piece): the field instead of -y; pieces of a broken chunk drift (PIECE_G)
  E.body_g = function (S, b, dt) {
    field(S, b.pos.x, b.pos.y, b.pos.z, fg); const a = C.G * K.BODY_G * (b.kind === 'chunk' ? K.PIECE_G / K.BODY_G : 1) * dt;
    b.vel.x += fg.x * a; b.vel.y += fg.y * a; b.vel.z += fg.z * a;
  };
  // unit vector of "down" at a body (for the asleep support probe)
  E.gdir = function (S, p, out) {
    field(S, p.x, p.y, p.z, fg); const l = M.len3(fg.x, fg.y, fg.z);
    if (l < 1e-6) { out.x = 0; out.y = -1; out.z = 0; } else { out.x = fg.x / l; out.y = fg.y / l; out.z = fg.z / l; }
    return out;
  };
  // graves float where the worm died (no ground to fall to in space)
  E.grave = function (S, o, g) { g.rest = true; g.vy = 0; if (g.landT < 0 && !o.gravePending) g.landT = S.time; };
  // nearest chunk surface (estimate), the void test
  function surf_dist(S, x, y, z) {
    const B = S.eow.bodies; let m = 1e9;
    for (let i = 0; i < B.length; i++) { const b = B[i]; if (b.kind === 3) continue; const d = M.len3(x - b.x, y - b.y, z - b.z) - b.R * 1.08; if (d < m) m = d; }
    return m;
  }
  E.surf_dist = surf_dist;

  /* ================= hazards: the core and the void ================= */
  E.hazard = function (S, w, dt) {
    const e = S.eow; if (!e || w.dead || w.drowning) return;
    ensure(w);
    const c = e.core, d = M.len3(w.pos.x - c.x, w.pos.y - c.y, w.pos.z - c.z), sim = SS.sim, wd = W();
    if (d < K.CORE_KILL) {
      SS.sim.emit(S, 'eowcore', { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z });
      sim.log(S, `${w.name} fell into the planet's burning core.`, 0xff8a4a);
      w.grave = null; sim.hurt(S, w, w.hp, C.DS.LAVA); if (!w.dead) sim.kill(S, w, 'burn'); w.grave = null; return;
    }
    const out = w.pos.x < -K.OUT_M || w.pos.z < -K.OUT_M || w.pos.x > wd.SX + K.OUT_M || w.pos.z > wd.SZ + K.OUT_M || w.pos.y > wd.SY + K.OUT_M;
    if (w.pos.y < -0.8) w.eVoid = K.VOID_T + 1;                              // below the lattice: gone at once (before the sea logic mistakes the void for water)
    const far = surf_dist(S, w.pos.x, w.pos.y, w.pos.z) > K.VOID_D;
    if (out || far) w.eVoid += dt; else if (w.eVoid > 0) w.eVoid = M.max(0, w.eVoid - 2 * dt);
    if (w.eVoid > (out ? 0.3 : K.VOID_T)) {
      SS.sim.emit(S, 'eowvoid', { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z });
      sim.log(S, `${w.name} drifted off into the void.`, 0xffb27a);
      e.lost++; sim.kill(S, w, 'lost'); w.grave = null;
    }
    w.eAirPrev = w.air;
  };

  /* ================= the active worm: 2D in the section, any orientation ================= */
  const cl = { s: 0, y: 0 };
  // outward surface normal in the plane around (s, y): away from the solid points on rings of growing radius; false = nothing solid within 2.6 m
  function ring_up(S, s, y, out) {
    for (let ri = 0; ri < K.RING.length; ri++) {
      const r = K.RING[ri]; let ns = 0, ny = 0, n = 0;
      for (let i = 0; i < 16; i++) if (P.sample2(S, s + COS16[i] * r, y + SIN16[i] * r) > 0) { ns -= COS16[i]; ny -= SIN16[i]; n++; }
      if (n && n < 16) { const l = M.len2(ns, ny); if (l > 0.05) { out.s = ns / l; out.y = ny / l; return true; } }
    }
    return false;
  }
  function rim_normal(S, s, y, out) {
    let ns = 0, ny = 0, n = 0;
    for (let i = 0; i < RIM.length; i += 2) if (P.blocked2(S, s + RIM[i], y + RIM[i + 1])) { ns -= RIM[i]; ny -= RIM[i + 1]; n++; }
    if (!n) return false;
    const l = M.len2(ns, ny); if (l < 1e-6) { out.s = 0; out.y = 1; } else { out.s = ns / l; out.y = ny / l; }
    return true;
  }
  // the suit's foot test along the local up (u) and tangent (t)
  const grounded = (S, s, y, us, uy) => {
    const ts = uy, ty = -us;
    return P.blocked2(S, s - us * 0.53, y - uy * 0.53) || P.blocked2(S, s - us * 0.47 - ts * 0.25, y - uy * 0.47 - ty * 0.25) || P.blocked2(S, s - us * 0.47 + ts * 0.25, y - uy * 0.47 + ty * 0.25);
  };
  function set_up(S, a, us, uy) {
    const l = M.len2(us, uy) || 1; us /= l; uy /= l; a.eu2.s = us; a.eu2.y = uy;
    const c = M.cos(S.theta), sn = M.sin(S.theta); a.eup.x = us * c; a.eup.z = us * sn; a.eup.y = uy;
  }
  const wa = { s: 0, y: 0, x: 0, z: 0 }, wn = { s: 0, y: 0 }, wk = { x: 0, y: 0, z: 0 };
  function set_pos(S, a, s, y) { const p = P.to_world(S, s, y); a.pos.x = p.x; a.pos.y = y; a.pos.z = p.z; }
  // a launch from the ground (jump / hop / salto) sets (vs, vy) in the upright convention: turn it into the plane's world frame about the worm's up
  E.jump_fix = function (S, a) {
    ensure(a);
    const launch = a.air && !a.eAirPrev, salto = a.air && a.flip && a.flipAt === S.time && a.flipRope !== a.flipAt && !a.eFlipC;   // (eAirPrev: the air flag at the end of the last tick)
    if (!launch && !salto) return;
    const us = a.eu2.s, uy = a.eu2.y, ts = uy, ty = -us, sx = ts;           // t = the clockwise tangent
    const dirS = a.vs >= 0 ? 1 : -1, mag = Math.abs(a.vs);
    let es, ey;
    if (Math.abs(sx) > 0.25) { const k = sx * dirS >= 0 ? 1 : -1; es = ts * k; ey = ty * k; } else { es = ts * a.eSense * dirS; ey = ty * a.eSense * dirS; }
    a.vs = es * mag + us * a.vy; a.vy = ey * mag + uy * a.vy;
    a.eGround = false; a.eAirPrev = true; if (salto) a.eFlipC = true;
  };
  E.step2d = function (S, a, dt, mv) {
    const sim = SS.sim, WD = C.WORM_DYN; ensure(a);
    const q = P.to_plane(S, a.pos); let s = q.s, y = a.pos.y;
    a.walking = false;
    if (!a.air) {
      if (!a.eGround) { a.eGround = true; a.eFlipC = false; if (ring_up(S, s, y, cl)) set_up(S, a, cl.s, cl.y); }
      let us = a.eu2.s, uy = a.eu2.y;
      if (ring_up(S, s, y, cl)) { set_up(S, a, us * (1 - K.UP_BLEND) + cl.s * K.UP_BLEND, uy * (1 - K.UP_BLEND) + cl.y * K.UP_BLEND); us = a.eu2.s; uy = a.eu2.y; }
      const ts = uy, ty = -us;                                          // clockwise tangent
      // the direction of a walk: a fresh key press picks the screen direction; a held key keeps its sense around the curve
      if (mv && mv !== a.eMv) { if (Math.abs(ts) > 0.35) a.eSense = mv * (ts >= 0 ? 1 : -1); else a.eSense = a.eLatch ? a.eSense * (mv === a.eLatch ? 1 : -1) : mv; a.eLatch = mv; }
      a.eMv = mv;
      if (mv) {
        const hs = a.eSense * sim.walk_speed(S, a), ds = hs * dt, base = P.overlap2(S, s, y), top = S.worms.some(o => o !== a && !o.dead && M.len3(o.pos.x - a.pos.x, o.pos.y - a.pos.y, o.pos.z - a.pos.z) < 2 * C.WORM_R) ? WD.STEP_UP_WORM : WD.STEP_UP;
        const ns = s + ts * ds, ny0 = y + ty * ds;
        let moved = false;
        for (let l = 0; l <= top + 1e-6; l += 0.04) if (P.overlap2(S, ns + us * l, ny0 + uy * l) <= base) { s = ns + us * l; y = ny0 + uy * l; moved = true; break; }
        if (moved) { a.walking = true; const sx = ts * a.eSense; if (Math.abs(sx) > 0.2) a.facing = sx > 0 ? 1 : -1; }
      }
      let snapped = grounded(S, s, y, us, uy);
      if (!snapped) for (let l = 0.04; l <= K.STEP_DOWN + 1e-6; l += 0.04) {
        const cs = s - us * l, cy = y - uy * l, ob = P.overlap2(S, cs, cy) > P.overlap2(S, s, y);
        if (grounded(S, cs, cy, us, uy) || ob) { const lb = l - (ob ? 0.04 : 0); s -= us * lb; y -= uy * lb; snapped = true; break; }
      }
      if (!snapped) { a.air = true; a.eGround = false; const hs = mv ? a.eSense * sim.walk_speed(S, a) * 0.9 : 0; a.vs = ts * hs; a.vy = ty * hs; a.walking = false; }
      else { a.vs = 0; a.vy = 0; }
      set_pos(S, a, s, y);
      if (!a.air) return;
    }
    // ---- in the air: the field, the magnetic landing brake, contacts ----
    s = P.to_plane(S, a.pos).s; y = a.pos.y;
    const c0 = M.cos(S.theta), s0 = M.sin(S.theta), sp0 = M.len2(a.vs, a.vy), nsub = M.max(1, Math.ceil(sp0 * dt / 0.08)), h = dt / nsub;
    if (sp0 > WD.V_MAX) { const kk = WD.V_MAX / sp0; a.vs *= kk; a.vy *= kk; }
    for (let k = 0; k < nsub && a.air; k++) {
      wk.x = S.O.x + s * c0; wk.z = S.O.z + s * s0;
      worm_acc(S, a, wk.x, y, wk.z, c0, s0, wa); a.vs += wa.s * h; a.vy += wa.y * h;
      // the suit's brake: a surface ahead within BRAKE_L m caps the approach speed (a landing at ~V_LAND, never a crash)
      const sp = M.len2(a.vs, a.vy);
      if (sp > K.V_LAND) {
        const vs = a.vs / sp, vy = a.vy / sp; let dist = -1;
        for (let r = 0.4; r <= K.BRAKE_L; r += K.BRAKE_STEP) if (P.sample2(S, s + vs * r, y + vy * r) > 0) { dist = r; break; }
        if (dist >= 0) {
          const cap = K.V_LAND + Math.sqrt(2 * K.BRAKE_A * M.max(0, dist - 0.5));
          if (sp > cap) { const nsp = M.max(cap, sp - K.BRAKE_A * h * 1.6); a.vs *= nsp / sp; a.vy *= nsp / sp; }
        }
      }
      const ns = s + a.vs * h, ny = y + a.vy * h;
      if (P.overlap2(S, ns, ny) <= P.overlap2(S, s, y) && !rim_normal(S, ns, ny, wn)) { s = ns; y = ny; continue; }
      if (!rim_normal(S, ns, ny, wn)) { wn.s = 0; wn.y = 1; }
      const vn = a.vs * wn.s + a.vy * wn.y;
      if (vn >= 0) { if (P.overlap2(S, ns, ny) <= P.overlap2(S, s, y)) { s = ns; y = ny; } continue; }
      const imp = -vn, ts = -wn.y, ty = wn.s, vt = a.vs * ts + a.vy * ty;
      if (imp > K.SAFE) {                                              // a blast threw it into rock: it hurts, bounces
        const dmg = M.min(WD.GLANCE_MAX, Math.round((imp - K.SAFE) * WD.GLANCE_K));
        a.vs = ts * vt * WD.FRIC - wn.s * vn * WD.BOUNCE; a.vy = ty * vt * WD.FRIC - wn.y * vn * WD.BOUNCE;
        SS.sim.emit(S, 'land', { wormId: a.id, x: a.pos.x, y: a.pos.y, z: a.pos.z, speed: imp, mat: W().mat_at(a.pos.x, a.pos.y - 0.7, a.pos.z), hard: 1 });
        set_pos(S, a, s, y); if (dmg > 0) sim.hurt(S, a, dmg, C.DS.LANDING); if (!sim.ctl(S, a)) return;
        if (M.len2(a.vs, a.vy) < WD.SOFT_V) land(S, a, wn, imp); continue;
      }
      land(S, a, wn, imp); s = P.to_plane(S, a.pos).s; y = a.pos.y; return;
    }
    set_pos(S, a, s, y);
    // a worm wedged in rock (the disc mostly inside): the nearest free spot
    if (P.overlap2(S, s, y) >= 9) { const f = sim.wedge_free(S, a); if (f) { a.pos.x = f.x; a.pos.y = f.y; a.pos.z = f.z; a.vs = a.vy = 0; } }
  };
  function land(S, a, n, imp) {
    a.air = false; a.vs = 0; a.vy = 0; a.flip = false; a.hop = false; a.slide = false; a.stillT = 0; a.eGround = true; a.eFlipC = false;
    set_up(S, a, n.s, n.y);
    if (imp > 2) SS.sim.emit(S, 'land', { wormId: a.id, x: a.pos.x, y: a.pos.y - 0.45, z: a.pos.z, speed: imp, mat: W().mat_at(a.pos.x - a.eup.x * 0.7, a.pos.y - a.eup.y * 0.7, a.pos.z - a.eup.z * 0.7) });
    if (imp > 9.6) a.squash = S.time;
  }

  /* ================= the other worms: 3D bodies under the field ================= */
  const nv = { x: 0, y: 1, z: 0 }, ng = { x: 0, y: 0, z: 0 };
  function probe3(w, x, y, z, r) {
    return w.sample(x, y, z) > 0 || w.sample(x + r, y, z) > 0 || w.sample(x - r, y, z) > 0 || w.sample(x, y + r, z) > 0 || w.sample(x, y - r, z) > 0 || w.sample(x, y, z + r) > 0 || w.sample(x, y, z - r) > 0;
  }
  E.body3d = function (S, b, dt) {
    ensure(b);
    const w = W(), sim = SS.sim, WD = C.WORM_DYN, foot = b.foot, up = b.eup;
    b.rope = null;
    if (b.rest) {
      if (w.sample(b.pos.x - up.x * (foot + 0.06), b.pos.y - up.y * (foot + 0.06), b.pos.z - up.z * (foot + 0.06)) > 0) return;
      b.rest = false; b.eStill = 0;
    }
    if (w.sample(b.pos.x, b.pos.y, b.pos.z) > 0.3) { const f = sim.wedge_free(S, b); if (f) { b.pos.x = f.x; b.pos.y = f.y; b.pos.z = f.z; b.vel.x = b.vel.y = b.vel.z = 0; } }
    const sp0 = M.len3(b.vel.x, b.vel.y, b.vel.z);
    if (sp0 > WD.V_MAX) { const k = WD.V_MAX / sp0; b.vel.x *= k; b.vel.y *= k; b.vel.z *= k; }
    const n = M.max(1, Math.ceil(M.len3(b.vel.x, b.vel.y, b.vel.z) * dt / 0.08)), h = dt / n, a = C.G_WORM * K.WORM_G * sim.gravity_k(S, b);
    let touched = false;
    for (let i = 0; i < n && !b.rest; i++) {
      sim.plane_lock(S, b);
      field(S, b.pos.x, b.pos.y, b.pos.z, fg); b.vel.x += fg.x * a * h; b.vel.y += fg.y * a * h; b.vel.z += fg.z * a * h;
      const nx = b.pos.x + b.vel.x * h, ny = b.pos.y + b.vel.y * h, nz = b.pos.z + b.vel.z * h;
      if (!probe3(w, nx, ny, nz, foot)) { b.pos.x = nx; b.pos.y = ny; b.pos.z = nz; continue; }
      // contact: the normal of the terrain around the new centre
      w.normal(nx, ny, nz, nv); if (w.sample(nx, ny, nz) <= 0) { const dl = M.len3(b.vel.x, b.vel.y, b.vel.z) || 1; const vx = -b.vel.x / dl, vy = -b.vel.y / dl, vz = -b.vel.z / dl; if (nv.x * vx + nv.y * vy + nv.z * vz < 0) { nv.x = vx; nv.y = vy; nv.z = vz; } }
      touched = true;
      const vn = b.vel.x * nv.x + b.vel.y * nv.y + b.vel.z * nv.z;
      if (vn >= 0) { b.pos.x = nx; b.pos.y = ny; b.pos.z = nz; continue; }
      const imp = -vn, tx = b.vel.x - vn * nv.x, ty = b.vel.y - vn * nv.y, tz = b.vel.z - vn * nv.z;
      if (imp > WD.FALL_SAFE) {
        const dmg = M.min(WD.GLANCE_MAX, Math.round((imp - WD.FALL_SAFE) * WD.GLANCE_K));
        SS.sim.emit(S, 'land', { wormId: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, speed: imp, mat: w.mat_at(b.pos.x, b.pos.y - foot, b.pos.z), hard: 1 });
        b.vel.x = tx * WD.FRIC - nv.x * vn * WD.BOUNCE; b.vel.y = ty * WD.FRIC - nv.y * vn * WD.BOUNCE; b.vel.z = tz * WD.FRIC - nv.z * vn * WD.BOUNCE; b.slide = true;
        sim.hurt(S, b, dmg, C.DS.LANDING);
      } else if (!b.slide && imp < WD.SOFT_V * 2) {
        if (imp > 3) SS.sim.emit(S, 'land', { wormId: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, speed: imp, mat: w.mat_at(b.pos.x, b.pos.y - foot, b.pos.z) });
        b.vel.x = b.vel.y = b.vel.z = 0; b.rest = true; b.eStill = 0; b.eup.x = nv.x; b.eup.y = nv.y; b.eup.z = nv.z; b.eu2.s = 0;
        set_up3(S, b);
      } else { b.vel.x = tx * WD.FRIC - nv.x * vn * WD.BOUNCE; b.vel.y = ty * WD.FRIC - nv.y * vn * WD.BOUNCE; b.vel.z = tz * WD.FRIC - nv.z * vn * WD.BOUNCE; }
      // out of the rock along the normal (never deeper)
      let k = 0, px = b.pos.x, py = b.pos.y, pz = b.pos.z;
      for (; k < 30 && probe3(w, px, py, pz, foot); k++) { px += nv.x * 0.04; py += nv.y * 0.04; pz += nv.z * 0.04; }
      if (k < 30) { b.pos.x = px; b.pos.y = py; b.pos.z = pz; }
    }
    if (!b.rest && touched) {
      const sp = M.len3(b.vel.x, b.vel.y, b.vel.z);
      if (sp < WD.STILL_V) { b.eStill += dt; if (b.eStill > WD.STILL_T || (!b.slide && sp < WD.SOFT_V)) { b.vel.x = b.vel.y = b.vel.z = 0; b.rest = true; b.slide = false; b.eStill = 0; w.normal(b.pos.x - b.eup.x * foot, b.pos.y - b.eup.y * foot, b.pos.z - b.eup.z * foot, ng); if (M.len3(ng.x, ng.y, ng.z) > 0.5) { b.eup.x = ng.x; b.eup.y = ng.y; b.eup.z = ng.z; } set_up3(S, b); } }
      else b.eStill = 0;
    }
  };
  // keep the plane-frame up (eu2) of a 3D worm in step with its world up (for the renderer and the next turn)
  function set_up3(S, b) {
    const d = P.dir(S); b.eu2.s = b.eup.x * d.x + b.eup.z * d.z; b.eu2.y = b.eup.y;
  }
})(window.SS = window.SS || {});
