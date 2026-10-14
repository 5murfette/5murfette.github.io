/* sim/ruins.js — the volcanic island's abandoned town and its rocky ground (P37 W5; user: "an abandoned small town:
 * broken
 * buildings, broken streets, rubble; lots of small and big rocks everywhere, almost never flat shiny terrain").
 * Everything is stamped into the voxel world after generation (like sim/bunker.js), so it is collidable, cut by the
 * gameplay section and destructible like any terrain: walls of SANDSTONE (brick, strength 140) or CONCRETE (2600),
 * floors / foundations / roof slabs of CONCRETE, rocks of BASALT / ROCK. Deterministic: an own rng stream from the
 * map seed, no wall clock. Signed distances are in metres, > 0 inside.
 *
 * Town:  a grid of LOTS (spacing LOT m) in a frame rotated by `ang` about the town centre T; streets run on the grid
 *        lines
 *        (width ROAD). T is the best of a coarse candidate grid: the most lots whose footprint ground is flat enough,
 *        on dry land, clear of lava / bunkers / worms / the crater. A building = a box shell (walls WALL m thick, 1-3
 *        floors of FLOOR m, slabs SLAB m, a foundation down to the lowest ground), windows and a door cut through the
 *        walls, then BROKEN: the wall tops and the roof are cut by a noise height field (a collapsed roof / jagged
 *        walls), floors have holes, a few spheres bite the walls. Rubble blobs (concrete / brick / rock) lie around and
 *        inside. Streets: the ground surface within ROAD/2 of a grid line becomes CONCRETE (cracks where a noise ridge
 *        passes, potholes carved at hashed spots), rubble blobs on top.
 * Rocks: islands-wide, three sizes (small 0.45-0.8 m, medium 0.9-1.5 m, big clusters 1.6-3 m) at random dry spots,
 *        clear of worms / bunkers / lava; the count of each follows settings.dRocks (none / low / medium / high).
 * 2D (P72): the slab holds the CROSS SECTION through the middle of a row of lots (plane z = MZ, no rotation): each
 *        building is cut open (end walls with a door / windows, floor slabs, roof, the broken top) and the cross
 * streets are concrete bands; rocks lie along the line. Settings: dTown scales the lot count (3 / 6 / 12 lots for low /
 * medium / high; 'none' = no town), dRocks the rocks. State: S.town = { x, z, ang, bld: [{ x, z, y0, hx, hz, ang,
 * floors }], rocks } or null (render / AI / tools). C layout: struct Building { f32 x, z, y0, hx, hz, ang; i32 floors;
 * u8 mat; }; struct Town { f32 x, z, ang; i32 n, rocks;
 *   Building bld[12]; };  API: populate(S, taken), stats(S).  Cost: ~4k lattice cells per building, ~0.3k per rock. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, MAT = C.MAT;
  const RU = SS.ruins = {};
  const W = () => SS.world;
  const K = {
    LOT: 15, ROAD: 3.2, WALL: 0.8, FLOOR: 3.1, SLAB: 0.7, ROOF: 0.7, FLAT: 2.6, FLAT2: 4.5, LOTS: 12, ROCK_S: 56, ROCK_M: 22, ROCK_B: 7,
    EDGE_R: 40
  };
  RU.K = K;
  let seedK = 1;

  /* ---------- the voxel writers ---------- */
  /* fn(x, y, z, o): o.s = the solid sdf (-9 = none), o.mat, o.air = a cut into the terrain (> 0 inside, else -9) */
  function stamp(x0, y0, z0, x1, y1, z1, fn) {
    const w = W(), H = w.H, NX = w.NX, NY = w.NY, NZ = w.NZ, o = { s: -9, mat: MAT.CONCRETE, air: -9 };
    // P72: the 2D slab: the plane's slice only (w.mark copies it over the slab)
    const fl = !!w.flat;
    const i0 = M.max(1, Math.floor(x0 / H)),
      i1 = M.min(NX - 2, Math.ceil(x1 / H)),
      k0 = fl ? w.kz : M.max(1, Math.floor(z0 / H)),
      k1 = fl ? w.kz : M.min(NZ - 2, Math.ceil(z1 / H));
    const j0 = M.max(1, Math.floor(y0 / H)), j1 = M.min(NY - 2, Math.ceil(y1 / H));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const q = (k * NY + j) * NX + i;
          o.s = -9; o.air = -9; fn(i * H, j * H, fl ? w.MZ : k * H, o);
          if (o.air > 0 && w.d[q] > -o.air) {
            w.d[q] = -M.clamp(o.air, 0.05, 1.5);
            w.mat[q] = MAT.AIR;
            w.heat[q] = 0;
          }
          if (o.s > -0.5 && o.s > w.d[q]) {
            w.d[q] = M.clamp(o.s, -0.6, 1.5);
            if (o.s > 0) {
              w.mat[q] = o.mat;
              w.heat[q] = 0;
            }
          }
        }
    w.mark(i0, j0, k0, i1, j1, k1);
  }
  /* an irregular blob (ellipsoid + 3D noise): solid union with the terrain */
  function blob(cx, cy, cz, ax, ay, az, mat) {
    const mn = M.fast_min(ax, M.fast_min(ay, az)), R = M.fast_max(ax, M.fast_max(ay, az)) + 0.6;
    stamp(cx - R, cy - R, cz - R, cx + R, cy + R, cz + R, (x, y, z, o) => {
      const q = M.len3((x - cx) / ax, (y - cy) / ay, (z - cz) / az);
      o.s = (1 - q) * mn + 0.5 * mn * (M.noise3(x * 1.4, y * 1.4, z * 1.4, seedK) - 0.5); o.mat = mat;
    });
  }

  /* ---------- ground queries ---------- */
  function ground(x, z, r) {                                      // min / max / mean top over a rectangle-ish footprint
    const w = W();
    let lo = 1e9, hi = -1e9, sum = 0, n = 0;
    // (2D: along the plane only)
    for (let a = -1; a <= 1; a++)
      for (let b = w.flat ? 0 : -1; b <= (w.flat ? 0 : 1); b++) {
        const t = w.top_at(x + a * r, z + b * r);
        lo = M.fast_min(lo, t);
        hi = M.fast_max(hi, t);
        sum += t;
        n++;
      }
    return { lo, hi, mean: sum / n };
  }
  function usable(S, x, z, pad) {
    const w = W();
    if (w.outside(x, z) || M.len2(x - w.MX, z - w.MZ) > K.EDGE_R * w.SC) return false;
    if (S.water && S.water.h && S.water.h[Math.round(z / w.H) * w.NX + Math.round(x / w.H)] > 0.004) return false;
    if (SS.sim.near_lava && SS.sim.near_lava(S, x, z)) return false;
    const m = w.mat_at(x, w.top_at(x, z) - 0.2, z);
    if (m === MAT.LAVA || m === MAT.ICE || m === MAT.STEEL || m === MAT.CONCRETE) return false;
    for (const v of (w.features.volcanoes || []))
      if (M.len2(x - v.x, z - v.z) < v.Rc + 2.5 + (pad || 0)) return false;
    // (the wreck)
    if (S.derelict && M.len2(x - S.derelict.x, z - S.derelict.z) < S.derelict.Rm + S.derelict.r * 1.6 + 1 + (pad || 0)) return false;
    return true;
  }
  const clear = (taken, x, z, d) => {
    for (let i = 0; i < taken.length; i++)
      if (M.len2(taken[i].x - x, taken[i].z - z) < d) return false;
    return true;
  };

  /* ---------- one building ---------- */
  function openings(b, r) {
    const ops = [], FH = K.FLOOR;
    for (let side = 0; side < 4; side++) {
      const len = side & 1 ? b.hx * 2 : b.hz * 2, nw = M.max(1, Math.floor((len - 1) / 3));
      for (let f = 0; f < b.floors; f++)
        for (let q = 0; q < nw; q++) {
          if (M.rng_next(r) < 0.22) continue;
          ops.push({ side, c: (q + 0.5) / nw * len - len / 2, y0: f * FH + 0.9, y1: f * FH + 2.3, w: 1.5 });
        }
    }
    ops.push({ side: M.rng_int(r, 4), c: (M.rng_next(r) - 0.5) * 2, y0: 0, y1: 2.3, w: 1.8 });   // the door
    // P72: the plane crosses the two end walls (sides 0, 2) at c = 0: a door in one, a window per floor in both
    if (W().flat) {
      ops.length = 0;
      // (the ground door and one small window per upper floor, all in the +u end wall: the -u wall stays whole, so the
      // floors and the roof stay attached to the foundation through it)
      for (let f = 0; f < b.floors; f++)
        ops.push(f ? { side: 0, c: 0, y0: f * FH + 1.0, y1: f * FH + 2.0, w: 1.2 } : { side: 0, c: 0, y0: 0, y1: 2.3, w: 1.8 });
    }
    return ops;
  }
  function building(b, r) {
    const T = K.WALL, FH = K.FLOOR, Ht = b.floors * FH + K.ROOF, ca = M.cos(b.ang), sa = M.sin(b.ang);
    const ops = openings(b, r), bites = [], fl2 = !!W().flat;
    for (let n = 0, nb = 2 + M.rng_int(r, 3); n < nb; n++)
      bites.push({
        u: (M.rng_next(r) - 0.5) * 2 * b.hx,
        v: fl2 ? 0 : (M.rng_next(r) - 0.5) * 2 * b.hz,
        y: 1 + M.rng_next(r) * (Ht - 1),
        r: 0.7 + M.rng_next(r) * 1.1
      });
    const thr = (W().flat ? 0.1 : 0.22) + M.rng_next(r) * (W().flat ? 0.1 : 0.18), found = b.found, R = M.len2(b.hx, b.hz) + 1.5;
    const wm = b.mat;
    stamp(b.x - R, b.y0 - found - 0.5, b.z - R, b.x + R, b.y0 + Ht + 1, b.z + R, (X, Y, Z, o) => {
      const du = X - b.x, dv = Z - b.z, u = ca * du + sa * dv, v = -sa * du + ca * dv, y = Y - b.y0;
      const au = Math.abs(u), av = Math.abs(v);
      const dOut = M.fast_min(b.hx - au, M.fast_min(b.hz - av, Ht - y));
      if (dOut < -1.2) return;
      // the cavity (air), floor at y = 0
      const dIn = M.fast_min(b.hx - T - au, M.fast_min(b.hz - T - av, M.fast_min(Ht - K.ROOF - y, y)));
      // broken top: where the noise is low the walls / roof are cut down to a jagged height
      const n = M.noise2(u * 0.22 + b.ox, v * 0.22 + b.oz, seedK), yb = n > thr ? 99 : 1.3 + (Ht - 1.3) * M.pow(n / thr, 1.2);
      let s = M.fast_min(M.fast_min(dOut, -dIn), y + found), mat = wm;
      const slabN = M.noise2(u * 0.4 + b.oz, v * 0.4 + b.ox, seedK + 5);
      for (let f = 1; f < b.floors; f++) {                                                    // floor slabs (with holes)
        const sl = M.fast_min(dOut, M.fast_min(K.SLAB / 2 - Math.abs(y - f * FH), (slabN - 0.3) * 5));
        if (sl > s) {
          s = sl;
          mat = MAT.CONCRETE;
        }
      }
      const fs = M.fast_min(dOut, M.fast_min(-y, y + found));                                             // foundation + ground floor slab
      if (fs > s) {
        s = fs;
        mat = MAT.CONCRETE;
      }
      if (y > Ht - K.ROOF - 0.01 && s > 0) mat = MAT.CONCRETE;                                // roof slab
      s = M.fast_min(s, yb - y);                                                                    // the collapse
      for (let q = 0; q < ops.length; q++) {                                                  // windows / door
        const p = ops[q], odd = p.side & 1, sgn = p.side < 2 ? 1 : -1, along = odd ? u : v, nrm = odd ? v : u, h = odd ? b.hz : b.hx;
        const op = M.fast_min(
          M.fast_min(p.w / 2 - Math.abs(along - p.c), y - p.y0),
          M.fast_min(p.y1 - y, T / 2 + 0.45 - Math.abs(nrm - sgn * (h - T / 2)))
        );
        if (op > 0) s = M.fast_min(s, -op);
      }
      for (let q = 0; q < bites.length; q++) {
        const t = bites[q];
        s = M.fast_min(s, M.len3(u - t.u, y - t.y, v - t.v) - t.r);
      }
      o.s = s; o.mat = mat; o.air = dIn;
    });
  }

  /* ---------- the town ---------- */
  function lotCentre(T, a, bq) {                                // lot grid cell (a, bq) -> world x, z
    const ca = M.cos(T.ang), sa = M.sin(T.ang), u = (a + 0.5) * K.LOT, v = (bq + 0.5) * K.LOT;
    return { x: T.x + ca * u - sa * v, z: T.z + sa * u + ca * v };
  }
  function lots(S, T, taken, flat) {
    const out = [];
    // (2D: the one row of lots the plane cuts through)
    for (let a = -2; a <= 1; a++)
      for (let bq = W().flat ? 0 : -1; bq <= (W().flat ? 0 : 1); bq++) {
        const c = lotCentre(T, a, bq), g = ground(c.x, c.z, 3.6);
        // (2D: the worms of a line of ground may stand inside a lot: unbury_worms lifts them)
        if (g.hi - g.lo > flat || g.lo < W().SEA + 1.2 || !usable(S, c.x, c.z, 3) || (!W().flat && !clear(taken, c.x, c.z, 6))) continue;
        let ok = true;
        for (const bk of (S.bunkers || []))
          if (M.len2(bk.x - c.x, bk.z - c.z) < 12) ok = false;
        if (ok) out.push({ x: c.x, z: c.z, a, b: bq, range: g.hi - g.lo, mean: g.mean, lo: g.lo });
      }
    return out;
  }
  function paintRoads(S, T, taken, rg) {
    const w = W(), H = w.H, NX = w.NX, NY = w.NY, ca = M.cos(T.ang), sa = M.sin(T.ang), L = K.LOT, half = K.ROAD / 2;
    const ext = 2.5 * L, R = ext * 1.5;
    let i0 = M.max(1, Math.floor((T.x - R) / H)),
      i1 = M.min(NX - 2, Math.ceil((T.x + R) / H)),
      k0 = M.max(1, Math.floor((T.z - R) / H)),
      k1 = M.min(w.NZ - 2, Math.ceil((T.z + R) / H));
    // P72: 2D: the plane's slice (marked below)
    if (w.flat) {
      k0 = w.kz;
      k1 = w.kz;
    }
    let painted = 0;
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) {
        const x = i * H, z = w.flat ? w.MZ : k * H, du = x - T.x, dv = z - T.z, u = ca * du + sa * dv, v = -sa * du + ca * dv;
        if (u < -2 * L - 2 || u > 2 * L + 2 || v < -1.5 * L - 2 || v > 1.5 * L + 2) continue;
        const ru = Math.abs(u - Math.round(u / L) * L), rv = Math.abs(v - Math.round(v / L) * L);
        const jag = 0.35 * (M.noise2(x * 0.7, z * 0.7, seedK + 3) - 0.5);
        if (M.fast_min(ru, rv) > half + jag) continue;
        const c = k * NX + i, j = w.topJ[c];
        if (j < 2 || !usable(S, x, z, -2)) continue;
        if (M.noise2(u * 1.3, v * 1.3, seedK + 9) > 0.82) continue;                      // a crack: the natural ground shows
        for (let dj = 0; dj < 2; dj++) {
          const q = ((k * NY) + (j - dj)) * NX + i;
          if (w.d[q] > 0 && w.mat[q] !== MAT.LAVA && w.mat[q] !== MAT.ICE && w.mat[q] !== MAT.CONCRETE) {
            w.mat[q] = MAT.CONCRETE;
            painted++;
          }
        }
      }
    // potholes: a hashed spot per 3 m cell of the street grid
    for (let a = -2 * L; a <= 2 * L; a += 3)
      for (let bq = -1.5 * L; bq <= 1.5 * L; bq += 3) {
        const ru = Math.abs(a - Math.round(a / L) * L), rv = Math.abs(bq - Math.round(bq / L) * L);
        if (M.fast_min(ru, rv) > half - 0.4 || M.rng_next(rg) > 0.2) continue;
        const x = T.x + ca * a - sa * bq + (M.rng_next(rg) - 0.5) * 2,
          z = w.flat ? w.MZ : T.z + sa * a + ca * bq + (M.rng_next(rg) - 0.5) * 2;
        if (!usable(S, x, z, -2)) continue;
        const y = w.top_at(x, z), r = 0.55 + M.rng_next(rg) * 0.45;
        stamp(x - r - 1, y - r - 1, z - r - 1, x + r + 1, y + r + 1, z + r + 1, (X, Y, Z, o) => {
          o.air = r - M.len3(X - x, (Y - y) * 1.6, Z - z);
        });
      }
    // P72: copy the painted slice over the slab
    if (w.flat) w.mark(i0, 0, w.kz, i1, NY - 1, w.kz);
    return painted;
  }
  function rubbleAt(x, z, rg, small) {
    const w = W(), t = w.top_at(x, z), r = (small ? 0.3 : 0.45) + M.rng_next(rg) * (small ? 0.4 : 0.7), q = M.rng_next(rg);
    blob(
      x,
      t + r * 0.1,
      z,
      r * (1 + M.rng_next(rg) * 0.6),
      r * 0.7,
      r * (1 + M.rng_next(rg) * 0.6),
      q < 0.4 ? MAT.CONCRETE : q < 0.8 ? MAT.SANDSTONE : MAT.ROCK
    );
  }
  function town(S, taken, rg) {
    const w = W(), want = C.density_count(S.settings, 'dTown', 6);
    if (want <= 0) return null;
    // the best town centre: most valid lots (own coarse grid; ties: nearest the map centre)
    // P72: 2D: the grid is not turned and the plane runs through the middle of a row of lots
    const fl = !!w.flat, ang0 = fl ? (M.rng_next(rg), 0) : M.rng_next(rg) * M.PI * 0.5;
    let best = null;
    for (const flat of [K.FLAT, K.FLAT2]) {
      for (let z = fl ? w.MZ - K.LOT / 2 : W().MZ - 24 * W().SC; z <= (fl ? w.MZ - K.LOT / 2 : W().MZ + 24 * W().SC); z += 4)
        for (let x = W().MX - 24 * W().SC; x <= W().MX + 24 * W().SC; x += 4) {
          const T = { x, z, ang: ang0 }, n = M.min(want, lots(S, T, taken, flat).length), dc = M.len2(x - W().MX, fl ? 0 : z - W().MZ);
          if (!best || n > best.n || (n === best.n && dc < best.dc)) best = { x, z, ang: ang0, n, dc };
        }
      if (best && best.n >= M.min(want, 3)) {
        best.flat = flat;
        break;
      }
    }
    if (!best || best.n < 1) return null;
    const T = { x: best.x, z: best.z, ang: best.ang, bld: [], rocks: 0 };
    const ls = lots(S, T, taken, best.flat);
    ls.sort((p, q) => p.range - q.range || p.a - q.a || p.b - q.b);
    for (let n = 0; n < ls.length && T.bld.length < want; n++) {
      const l = ls[n], r = M.rng_make(((seedK * 977 + n * 131 + 7) >>> 0) || 1), q = M.rng_next(r);
      const b = { x: l.x + (M.rng_next(r) - 0.5) * 1.0, z: l.z + (M.rng_next(r) - 0.5) * 1.0, ang: T.ang + (M.rng_next(r) - 0.5) * 0.16,
        hx: 3 + M.rng_next(r) * 1.5, hz: 2.6 + M.rng_next(r) * 1.1,
        floors: q < 0.5 ? 1 : q < 0.85 ? 2 : 3, mat: M.rng_next(r) < 0.12 ? MAT.SANDSTONE : MAT.CONCRETE, ox: M.rng_next(r) * 50,
        oz: M.rng_next(r) * 50 };
      // P72: the cross section passes through the building's middle
      if (fl) {
        b.z = w.MZ;
        b.ang = 0;
      }
      const g = ground(b.x, b.z, M.len2(b.hx, b.hz) * 0.8);
      b.y0 = g.mean; b.found = M.clamp(b.y0 - g.lo + 0.4, 0.8, 4);
      building(b, r);
      T.bld.push({ x: b.x, z: b.z, y0: b.y0, hx: b.hx, hz: b.hz, ang: b.ang, floors: b.floors });
      for (let q2 = 0; q2 < 5; q2++) {                                                          // rubble around and inside
        const a = M.rng_next(rg) * M.TAU, d = 1 + M.rng_next(rg) * 1.6, ex = b.hx + 0.7, ez = b.hz + 0.7;
        rubbleAt(b.x + M.cos(a) * ex * d, fl ? w.MZ : b.z + M.sin(a) * ez * d, rg, false);
      }
      for (let q2 = 0; q2 < 2; q2++)
        rubbleAt(b.x + (M.rng_next(rg) - 0.5) * b.hx, fl ? w.MZ : b.z + (M.rng_next(rg) - 0.5) * b.hz, rg, true);
    }
    paintRoads(S, T, taken, rg);
    for (let n = 0; n < 14; n++) {                                                              // rubble in the streets
      const a = (M.rng_int(rg, 4) - 1.5) * K.LOT, bq = (M.rng_next(rg) - 0.5) * 3 * K.LOT, ca = M.cos(T.ang), sa = M.sin(T.ang);
      const u = M.rng_next(rg) < 0.5 ? a : bq, v = u === a ? bq : a, x = T.x + ca * u - sa * v, z = fl ? w.MZ : T.z + sa * u + ca * v;
      if (usable(S, x, z, -2)) rubbleAt(x, z, rg, true);
    }
    return T;
  }

  /* ---------- rocks ---------- */
  function rocks(S, taken, rg) {
    const w = W(),
      nS = C.density_count(S.settings, 'dRocks', K.ROCK_S),
      nM = C.density_count(S.settings, 'dRocks', K.ROCK_M),
      nB = C.density_count(S.settings, 'dRocks', K.ROCK_B);
    let placed = 0;
    const kinds = [[nS, 0.45, 0.8, 2.2, 0.8], [nM, 0.9, 1.5, 3.2, 1], [nB, 1.6, 2.6, 5.5, 3]];
    for (const [cnt, r0, r1, sep, cl] of kinds)
      for (let n = 0, tries = 0; n < cnt && tries < cnt * 30; tries++) {
        const x = 5 + M.rng_next(rg) * (w.SX - 10), z = w.flat ? w.MZ : 5 + M.rng_next(rg) * (w.SZ - 10);
        if (!usable(S, x, z, 1)) continue;
        const t = w.top_at(x, z);
        if (t < w.SEA + 0.5) continue;
        if (!clear(taken, x, z, sep + 1.5)) continue;
        if ((S.bunkers || []).some(bk => M.len2(bk.x - x, bk.z - z) < C.BUNKER.R_OUT + 2.5 + r1)) continue;
        if (S.town && S.town.bld.some(bd => M.len2(bd.x - x, bd.z - z) < M.len2(bd.hx, bd.hz) + r1 + 1)) continue;
        const mat = M.rng_next(rg) < 0.75 ? MAT.BASALT : MAT.ROCK, r = r0 + M.rng_next(rg) * (r1 - r0);
        for (let c = 0, nc = cl < 2 ? 1 : 3; c < nc; c++) {                                   // big ones: a cluster of 3 lumps
          const ox = c ? (M.rng_next(rg) - 0.5) * r * 1.3 : 0,
            oz = c ? (M.rng_next(rg) - 0.5) * r * 1.3 : 0,
            rr = c ? r * (0.55 + M.rng_next(rg) * 0.3) : r;
          blob(
            x + ox,
            w.top_at(x + ox, z + oz) + rr * (0.05 + 0.15 * M.rng_next(rg)),
            z + oz,
            rr * (0.9 + M.rng_next(rg) * 0.5),
            rr * (0.7 + M.rng_next(rg) * 0.4),
            rr * (0.9 + M.rng_next(rg) * 0.5),
            c ? mat : (M.rng_next(rg) < 0.25 ? MAT.ROCK : mat)
          );
        }
        n++; placed++;
      }
    return placed;
  }

  RU.populate = function (S, taken) {
    S.town = null;
    const w = W();
    if (S.biome !== 'volcanic' || w.under || w.dry) return;
    seedK = (Math.imul(S.settings.seed | 0, 40503) + 12345) >>> 0;
    const rg = M.rng_make(seedK || 1);
    const T = town(S, taken, rg);
    S.town = T || { x: 0, z: 0, ang: 0, bld: [], rocks: 0 };
    S.town.rocks = rocks(S, taken, rg);
    // keep the props off the roofs (find_spot keeps SEP m from every taken point)
    for (const b of S.town.bld) {
      const c = M.cos(b.ang), s2 = M.sin(b.ang);
      for (const [u, v] of [[0, 0], [b.hx * 0.7, 0], [-b.hx * 0.7, 0], [0, b.hz * 0.7], [0, -b.hz * 0.7]])
        taken.push({ x: b.x + c * u - s2 * v, y: b.y0, z: b.z + s2 * u + c * v });
    }
    if (S.town.bld.length) SS.sim.log(S, `${S.town.bld.length} ruined buildings: an abandoned town on the island.`, 0xd9c7a0);
  };
  RU.stats = S => ({ buildings: S.town ? S.town.bld.length : 0, rocks: S.town ? S.town.rocks : 0 });
})(window.SS = window.SS || {});
