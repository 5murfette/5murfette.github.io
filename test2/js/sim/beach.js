/* sim/beach.js (P116) — the tropical cove biome 'beach': the heightfield, the granite boulders and the material rule.
 * Called from sim/worldgen.js (HEIGHT.beach, stage 0 after the blur, RULES.beach); no state of its own, so a run is
 * deterministic for (biome, seed): the layout comes from the settings seed through its own RNG (never S.rng).
 *
 * Layout: an island whose coast has one deliberate COVE (a bite out of the coast at a seeded bearing a0) and a rocky
 * point on each side of it. Along the coast the ground follows a beach profile P(u) (u = metres inland of the
 * waterline): a gentle shoreface under the water (the sea floor deepens slowly: clear shallows), a ~4 degree foreshore,
 * a wide flat berm of dry sand (wider in the cove), then the backshore rising into the jungle hinterland (rolling
 * hills, granite ridges, tors). Rounded granite boulders (MAT.ROCK; the renderer tints rock red-brown on this biome)
 * lie in clusters on the points, scattered on the beach and in the shallows; about half of those in the water stay
 * under the surface. Materials: sand (seabed, foreshore, berm, backshore), soil (jungle floor: the veg layer grows
 * grass / bushes there), rock (boulders, granite slopes and tors).
 * Coordinates are metres; the lattice is W.H = 0.5 m. C layout: plain functions over (W, F, seed, hgt[], extra[]).
 */
(function (SS) {
  'use strict';
  const M = SS.math, C = SS.CFG, MAT = C.MAT;
  const BG = SS.beachgen = {};
  const sat = M.sat;

  BG.K = {
    FORESHORE: 0.07,       // slope of the foreshore (4 deg)
    SHOREFACE: 0.062,      // slope of the sea floor just off the beach; it deepens quadratically (SHELF_Q)
    SHELF_Q: 0.0105,
    BERM_U: 9,             // m of foreshore before the flat berm starts (cove: x 1.25)
    BERM_W: 8,             // m of flat berm (cove: x 1.7)
    BERM_S: 0.022,         // berm slope
    COVE_D: 12,            // m the coast is pulled inland in the middle of the cove
    COVE_W: 0.52,          // cove half width (rad, gaussian)
    ROCKY: 0.8             // bearing offset (rad) of the two rocky points from the cove axis
  };

  /* the layout of a map: cove bearing and the boulder clusters; in F.beach (read by the renderer for the huts) */
  BG.setup = function (W, F, seed) {
    const r = M.rng_make(((Math.imul(seed | 0, 2654435761) ^ 0x51ed270b) >>> 0) || 1), R = () => M.rng_next(r);
    F.beach = { a0: R() * M.TAU, cove: BG.K.COVE_D * (0.85 + 0.3 * R()), flip: R() < 0.5 ? 1 : -1, rng: r };
  };

  /* signed distance beyond the coast with the cove cut in (> 0 = sea side); E = { W, F, falloff, base, wob } */
  BG.edge = function (E, x, z) {
    const W = E.W, B = E.F.beach;
    let e = E.falloff(x, z, E.base, E.wob, true);
    let da = M.atan2(z - W.MZ, x - W.MX) - B.a0;
    da -= Math.floor(da / M.TAU + 0.5) * M.TAU;
    // (the bite fades out towards the centre: the bearing is meaningless there, and a full-size bite would cut a cliff
    // along the bearing ray through the middle of the island)
    e += B.cove * W.SC * M.exp(-(da * da) / (BG.K.COVE_W * BG.K.COVE_W)) * M.smoothstep(14 * W.SC, 30 * W.SC, M.len2(x - W.MX, z - W.MZ));
    return e;
  };
  /* cove weight 0..1 at a bearing */
  const coveW = (B, a) => {
    let da = a - B.a0;
    da -= Math.floor(da / M.TAU + 0.5) * M.TAU;
    return M.exp(-(da * da) / (BG.K.COVE_W * BG.K.COVE_W * 1.6));
  };

  BG.height = function (E, x, z) {
    const W = E.W, F = E.F, B = F.beach, SEA = W.SEA, sd = E.seed, K = BG.K;
    const fb = (px, pz, s, o) => M.fbm2(px, pz, sd + s, o);
    // jungle hinterland: rolling hills, a few granite ridges
    let h = 7.4 + 9.5 * M.pow(sat((fb(x / 26, z / 26, 1, 4) - 0.28) / 0.5), 1.25) + 2.2 * fb(x / 9, z / 9, 2, 2);
    h += 0.5 * M.max(0, 1 - Math.abs(fb(x / 20, z / 20, 7, 3) - 0.5) * 4.0);
    const e = BG.edge(E, x, z), u = -e;
    const cw = coveW(B, M.atan2(z - W.MZ, x - W.MX));
    let P;
    if (u <= 0) P = SEA + K.FORESHORE * u * (K.SHOREFACE / K.FORESHORE) - K.SHELF_Q * u * u;
    else {
      const u1 = K.BERM_U * (0.55 + 0.7 * cw), u2 = u1 + K.BERM_W * (0.35 + 1.5 * cw);
      P = SEA + K.FORESHORE * M.min(u, u1);
      if (u > u1) P += K.BERM_S * (M.min(u, u2) - u1);
      if (u > u2) {
        const v = u - u2;
        P += 0.28 * v + 0.022 * v * v;
      }
    }
    // small swells in the beach face (cusps) so the shoreline is not a ruler line
    if (u > -2 && u < K.BERM_U + 6) P += (fb(x / 5.5, z / 5.5, 11, 2) - 0.5) * 0.28 * sat((u + 2) / 3);
    return M.min(h, P);
  };

  /* ---------- boulders ---------- */
  /* One rounded boulder = a flattened ellipsoid dome (plan semi-axes rx, rz turned by yaw, height ry above its centre
   * cy, the lower part buried) raised into hgt;
   * extra[] holds how much it adds (> 0.1 = granite for the material rule). The record goes to F.beach.rocks: the
   * renderer (render/boulders.js) draws a smooth granite mesh over every sim boulder (the 0.5 m voxel surface alone
   * reads as a soft, furry blob) and the sim keeps the rock as terrain (it blocks, it can be blown up). Rocks smaller
   * than SIM_MIN are NOT stamped: they are render-only pebbles (F.beach.pebbles, placed on whatever ground the renderer
   * finds). */
  const SIM_MIN = 0.85;
  function dome(W, hgt, extra, o) {
    const H = W.H, NX = W.NX, NZ = W.NZ, rr = M.max(o.rx, o.rz) * 1.1 + 0.3;
    const i0 = M.max(0, Math.floor((o.x - rr) / H)), i1 = M.min(NX - 1, Math.ceil((o.x + rr) / H));
    const k0 = M.max(0, Math.floor((o.z - rr) / H)), k1 = M.min(NZ - 1, Math.ceil((o.z + rr) / H));
    const g0 = hgt[Math.round(o.z / H) * NX + Math.round(o.x / H)];
    let ry = o.ry;
    if (o.topMax != null) {
      ry = M.min(ry, (o.topMax - g0 - o.lift) / 0.98);
      if (ry < 0.4) return null;
    }
    const cy = g0 + o.lift, cs = M.cos(o.yaw), sn = M.sin(o.yaw);
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) {
        const dx = i * H - o.x, dz = k * H - o.z, u = dx * cs + dz * sn, v = -dx * sn + dz * cs;
        const a = M.atan2(dz, dx), wob = 1 + 0.05 * (M.noise2(M.cos(a) * 1.7 + o.seed * 0.37, M.sin(a) * 1.7, o.seed + 5) - 0.5) * 2;
        const q = M.len2(u / o.rx, v / o.rz) / wob;
        if (q >= 1) continue;
        const s = Math.sqrt(M.max(0, 1 - q * q)), top = cy + ry * M.pow(s, 0.85);
        const c = k * NX + i;
        if (top > hgt[c]) {
          extra[c] = M.max(extra[c], top - hgt[c] + 0.12);
          hgt[c] = top;
        }
      }
    return { x: o.x, z: o.z, y: cy, g: g0, rx: o.rx, rz: o.rz, ry: ry, yaw: o.yaw, seed: o.seed };
  }

  /* all the boulders of the map, after the blur and the fort shaping (hgt = the final heightfield of stage 0) */
  BG.stamp = function (E, hgt, extra) {
    const W = E.W,
      F = E.F,
      B = F.beach,
      SEA = W.SEA,
      H = W.H,
      K = BG.K,
      r = B.rng,
      R = () => M.rng_next(r),
      RR = (a, b) => a + (b - a) * M.rng_next(r);
    const sd = E.seed;
    B.rocks = []; B.pebbles = []; B.points = [];
    const gnd = (x, z) => hgt[M.clamp(Math.round(z / H), 0, W.NZ - 1) * W.NX + M.clamp(Math.round(x / H), 0, W.NX - 1)];
    const free = (x, z, pad) => !(F.fort && SS.fort.keep_out(x, z, pad, pad));
    const inside = (x, z) => !(x < 4 || z < 4 || x > W.SX - 4 || z > W.SZ - 4);
    // the coast radius along a bearing (bisection on the signed edge)
    const coastR = a => {
      let lo = 6, hi = 60;
      for (let t = 0; t < 22; t++) {
        const m = (lo + hi) / 2;
        if (BG.edge(E, W.MX + M.cos(a) * m, W.MZ + M.sin(a) * m) < 0) lo = m;
        else hi = m;
      }
      return (lo + hi) / 2;
    };
    let nid = 0;
    // one rock at (x, z): big enough -> terrain + record, else a render-only pebble; wet: may be kept under the surface
    const put = (x, z, rad, sub, lowK) => {
      const asp = RR(0.86, 1.17), yaw = RR(0, M.PI), ryk = RR(0.72, 1.02), seed = sd + 13 * (nid++);
      if (rad >= SIM_MIN) {
        const o = dome(W, hgt, extra, {
          x,
          z,
          rx: rad * asp,
          rz: rad / asp,
          yaw,
          ry: rad * ryk,
          lift: lowK * rad,
          topMax: sub ? SEA - 0.18 : null,
          seed
        });
        if (o) {
          B.rocks.push(o);
          return true;
        }
        return false;
      }
      B.pebbles.push({ x, z, r: rad, asp, yaw, ry: rad * ryk, seed, sub: sub ? 1 : 0 });
      return true;
    };
    const cl = [];
    // the two rocky points flank the cove (big clusters), then smaller clusters round the rest of the coast
    for (const sg of [-1, 1])
      cl.push({ a: B.a0 + sg * (K.ROCKY + RR(-0.12, 0.18)), n: Math.round(RR(26, 34)), sN: RR(4.6, 6.2), sT: RR(5.4, 7.4), big: 1 });
    for (let t = 0, n = 0; t < 60 && n < 4; t++) {
      const a = R() * M.TAU;
      let da = a - B.a0;
      da -= Math.floor(da / M.TAU + 0.5) * M.TAU;
      if (Math.abs(da) < 0.55) continue;
      if (cl.some(c => {
        let d = a - c.a;
        d -= Math.floor(d / M.TAU + 0.5) * M.TAU;
        return Math.abs(d) < 0.5;
      })) continue;
      cl.push({ a, n: Math.round(RR(8, 14)), sN: RR(2.4, 3.6), sT: RR(2.6, 4.2), big: 0 }); n++;
    }
    for (const c of cl) {
      const r0 = coastR(c.a), nx = M.cos(c.a), nz = M.sin(c.a), tx = -nz, tz = nx, ox = W.MX + nx * r0, oz = W.MZ + nz * r0;
      B.points.push({ a: c.a, x: ox, z: oz, big: c.big });
      const rocks = [];
      for (let q = 0; q < c.n * 4 && rocks.length < c.n; q++) {
        const gN = (R() + R() + R() - 1.5) * 1.6 * c.sN, gT = (R() + R() + R() - 1.5) * 1.6 * c.sT;
        const x = ox + nx * gN + tx * gT, z = oz + nz * gN + tz * gT;
        if (!inside(x, z) || !free(x, z, 2)) continue;
        // a few big ones, many small (power law)
        const rk = (c.big ? 0.45 : 0.4) + 1.9 * M.pow(R(), 2.0) * (c.big ? 1.2 : 0.9);
        if (rocks.some(o => M.len2(o.x - x, o.z - z) < (o.r + rk) * 0.98)) continue;
        rocks.push({ x, z, r: rk });
      }
      for (const o of rocks) {
        const g0 = gnd(o.x, o.z);
        put(o.x, o.z, o.r, g0 < SEA + 0.3 && R() < 0.3, RR(-0.2, 0.12));
      }
    }
    // loose rocks on the beach near the points and in the shallows of the cove (mostly pebbles)
    for (let t = 0, n = 0; t < 900 && n < 130; t++) {
      const inCove = (n & 1) === 0, a = inCove ? B.a0 + RR(-0.6, 0.6) : B.a0 + (R() < 0.5 ? -1 : 1) * RR(0.5, 1.5);
      const r0 = coastR(a), u = inCove ? RR(-12, -1.5) : RR(-4, 10), x = W.MX + M.cos(a) * (r0 - u), z = W.MZ + M.sin(a) * (r0 - u);
      if (!inside(x, z) || !free(x, z, 2)) continue;
      const g0 = gnd(x, z), wet = g0 < SEA + 0.3;
      if (put(x, z, 0.3 + 0.7 * M.pow(R(), 1.4), wet && R() < 0.6, RR(-0.15, 0.1))) n++;
    }
    // the shelf: dark rocks and reefs scattered over the clear shallows (seen through the water, a few break the
    // surface)
    for (let t = 0, n = 0; t < 700 && n < 90; t++) {
      const a = B.a0 + RR(-1.2, 1.2), r0 = coastR(a), u = -RR(2.5, 26), x = W.MX + M.cos(a) * (r0 - u), z = W.MZ + M.sin(a) * (r0 - u);
      if (!inside(x, z) || !free(x, z, 2)) continue;
      if (put(x, z, 0.4 + 1.3 * M.pow(R(), 1.8), R() < 0.6, RR(-0.25, 0.0))) n++;
    }
    B.boulders = B.rocks.length + B.pebbles.length;
  };

  /* ---------- the village: 5 huts on the backshore behind the first rocky point, flat pads ---------- */
  const HUT_PAD = 2.7, HUT_BLEND = 2.9;
  BG.village = function (E, hgt, extra) {
    const W = E.W,
      F = E.F,
      B = F.beach,
      SEA = W.SEA,
      H = W.H,
      K = BG.K,
      r = B.rng,
      RR = (a, b) => a + (b - a) * M.rng_next(r);
    B.huts = [];
    const gnd = (x, z) => hgt[M.clamp(Math.round(z / H), 0, W.NZ - 1) * W.NX + M.clamp(Math.round(x / H), 0, W.NX - 1)];
    const exAt = (x, z) => extra[M.clamp(Math.round(z / H), 0, W.NZ - 1) * W.NX + M.clamp(Math.round(x / H), 0, W.NX - 1)];
    const coastR = a => {
      let lo = 6, hi = 60;
      for (let t = 0; t < 22; t++) {
        const m = (lo + hi) / 2;
        if (BG.edge(E, W.MX + M.cos(a) * m, W.MZ + M.sin(a) * m) < 0) lo = m;
        else hi = m;
      }
      return (lo + hi) / 2;
    };
    const ap = B.a0 + B.flip * (K.ROCKY + 0.08);                 // behind the rocky point on one side of the cove
    let best = null;
    for (let du = 6; du <= 20; du += 2)
      for (let da = -0.3; da <= 0.31; da += 0.06) {
        const a = ap + da, rr = coastR(a) - du, x = W.MX + M.cos(a) * rr, z = W.MZ + M.sin(a) * rr, y0 = gnd(x, z);
        if (y0 < SEA + 0.8 || y0 > SEA + 5.0) continue;
        if (F.fort && SS.fort.keep_out(x, z, 8, 8)) continue;
        let dev = 0, rock = 0;
        for (let k = -4; k <= 4; k++)
          for (let i = -4; i <= 4; i++) {
            const px = x + i * 1.25, pz = z + k * 1.25;
            dev += Math.abs(gnd(px, pz) - y0);
            if (exAt(px, pz) > 0.1) rock++;
          }
        const cost = dev / 81 * 4 + rock * 0.6 + Math.abs(y0 - (SEA + 1.6)) * 0.4 + du * 0.02;
        if (!best || cost < best.c) best = { c: cost, x, z, a, y: y0 };
      }
    if (!best) return;
    const types = ['thatch', 'tin', 'thatch', 'tin', 'thatch', 'thatch'];
    for (let i = 0; i < 6; i++) {
      for (let t = 0; t < 140; t++) {
        const an = RR(0, M.TAU), rd = 3.6 + t * 0.05 + RR(0, 2.4);
        const x = best.x + M.cos(an) * rd, z = best.z + M.sin(an) * rd;
        const y0 = gnd(x, z);
        if (
          !(x > 6 && z > 6 && x < W.SX - 6 && z < W.SZ - 6) || y0 < SEA + 0.8 || y0 > SEA + 6.0 || (F.fort && SS.fort.keep_out(x, z, 4, 4))
        ) continue;
        let bad = false;
        for (let q = 0; q < 8 && !bad; q++) {
          const px = x + M.cos(q * 0.785) * 2.3, pz = z + M.sin(q * 0.785) * 2.3;
          if (exAt(px, pz) > 0.1 || Math.abs(gnd(px, pz) - y0) > 2.3) bad = true;
        }
        if (bad || exAt(x, z) > 0.1 || B.huts.some(h => M.len2(h.x - x, h.z - z) < 5.8)) continue;
        B.huts.push({ x, z, y: y0, yaw: -(best.a + RR(-0.45, 0.45)), type: types[i] });
        break;
      }
    }
    // flat pads: every hut stands on level ground (the renderer's hero needs the footprint within 0.45 m). Neighbouring
    // pads share the ground: each cell moves to the weight^4 mean of the pad heights, so the core of a pad (weight 1)
    // is not disturbed by the blend zone of the next one.
    if (B.huts.length) {
      const R1 = HUT_PAD + HUT_BLEND;
      let i0 = W.NX, i1 = 0, k0 = W.NZ, k1 = 0;
      for (const h of B.huts) {
        i0 = M.min(i0, M.max(0, Math.floor((h.x - R1) / H)));
        i1 = M.max(i1, M.min(W.NX - 1, Math.ceil((h.x + R1) / H)));
        k0 = M.min(k0, M.max(0, Math.floor((h.z - R1) / H)));
        k1 = M.max(k1, M.min(W.NZ - 1, Math.ceil((h.z + R1) / H)));
      }
      for (let k = k0; k <= k1; k++)
        for (let i = i0; i <= i1; i++) {
          let ws = 0, wy = 0, wm = 0;
          for (const h of B.huts) {
            const d = M.len2(i * H - h.x, k * H - h.z), w = 1 - M.smoothstep(HUT_PAD, R1, d);
            if (w <= 0) continue;
            const w4 = w * w * w * w;
            ws += w4;
            wy += w4 * h.y;
            if (w > wm) wm = w;
          }
          if (ws > 0) {
            const c = k * W.NX + i;
            hgt[c] = hgt[c] + (wy / ws - hgt[c]) * wm;
          }
        }
    }
    B.village = best.c < 1e8 ? { x: best.x, z: best.z } : null;
  };

  /* ---------- materials ---------- */
  /* E = { SEA, extra, cliffMax, nz } */
  BG.rule = function (E, x, y, z, de, ny, col, dv) {
    const SEA = E.SEA, n = E.nz(x, z, 26);
    const eb = E.extra[col];
    if (eb > 0.1 && de < eb + 1.0) return MAT.ROCK;                                // a granite boulder
    if (y < SEA - 0.05 && de < 2.2) return MAT.SAND;                               // sea floor
    const sandTop = SEA + 1.8 + n * 1.3;                                           // the backshore: sand grades into jungle soil
    if (y < sandTop && ny > 0.3 && de < 2.6) return MAT.SAND;
    if (ny > 0.5 && de < 1.1 + n * 0.5 && y < SEA + 23) return MAT.SOIL;           // jungle floor
    return MAT.ROCK;                                                               // granite slopes, tors and stacks
  };
})(window.SS = window.SS || {});
