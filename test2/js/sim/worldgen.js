/* sim/worldgen.js — procedural battlefield generation for five map types (biomes).
 * Pipeline (C: void worldgen_generate(World*, const Settings*)):
 *   1. 2D heightfield per biome (+ volcano cone, crater bowl, 0-2 lava canals with levees)
 *   2. landmarks: rock spires and natural bridges/arches (rope anchors, different silhouettes per bearing)
 *   3. volume fill: signed density from the heightfield + 3D overhang band + caves / lava tubes
 *   4. stamps: hidden lava pockets with veins, ice shelf. Open lava (crater lake, canals) is not voxels: it is the
 *      fluid layer of sim/lava.js, initialised from F.lavaInit (target lava surface per column).
 *   5. per-run material layering (topsoil, beaches, snow caps, scree, ash, glaciers ...)
 *   6. connectivity clean-up: nothing generated is left floating (except buoyant ice on the sea)
 * Deterministic for (biome, seed). No engine types. */
(function (SS) {
  'use strict';
  const M = SS.math, C = SS.CFG, MAT = C.MAT;
  const G = SS.worldgen = {};
  const sat = M.sat, sm = M.smooth, clamp = M.clamp;
  let W, NX, NY, NZ, H, SEA, rng, seed, hgt, ginv, lavaZone, canalD, extra, F;
  const R = () => M.rng_next(rng);
  const RR = (a, b) => a + (b - a) * M.rng_next(rng);
  const fbm2 = (x, z, s, o) => M.fbm2(x, z, seed + s, o);

  /* island edge: distance beyond the coast line. LS1 (user: the play area is a circle, the island's shape random in
   * it): mean radius `base`, 2-4 big lobes / bays from angular harmonics k = 1..4 with seeded amplitudes and phases
   * (F.isl, its own rng: the rest of the layout keeps its random sequence), the old fine wobble, and a 2D noise term
   * that cuts coves and pushes out headlands; the edge is softly capped below ISL_MAX (inside the play circle,
   * never a coast drawn by the circle itself) and kept above 0.6 x base (room for spawns and props). */
  const ISL_MAX = 44.5;        // m: no coast farther than this from the centre (the play circle; lattice edge at 48)
  const CLIFF_S = 2.2;         // sea-cliff face slope (65°): the cliff band = (h − SEA + 0.4) / CLIFF_S, up to ~15 m
  const BEACH_S = 0.12;        // beach face slope (~7°: sand / shingle foreshore), also the shoreface below the water
  const BEACH_W = 4;           // m: dry beach width before the backshore rises
  const BEACH_R = 6;           // m: the backshore slope grows from BEACH_S to BACK_S over this run
  const BACK_S = 0.9;          // backshore slope cap (42°, the old falloff's slope; a cliff coast is steeper)
  let coastHead = 0;           // falloff() side output: the coast line's offset from the mean radius (m; + = headland)
  /* LS1: the height h lowered toward the coast line (where the sea meets the land). Real island coasts: CLIFFS on the
   * headlands (wave energy converges there and cuts the land back), BEACHES in the bays (sediment collects there).
   * cliff: h drops at CLIFF_S to just under the sea ON the line and keeps dropping beyond (to the 3 m sea floor):
   *        a wall as tall as the land behind it (a 2 m step on a lava plain, a 30 m face below an alpine ridge).
   *        (A fixed 9 m band cut a 42° ramp into every low plain: volcanic flat ground 25 % -> 8 %, props 13 -> 7.)
   * beach: h capped by a profile P(u) (u = m inland of the line): the waterline on the line, a ~7° foreshore and dry
   *        strip (BEACH_W), then the slope grows over BEACH_R to BACK_S (a bluff, never a wall); offshore a gentle
   *        shoreface. (A quadratic backshore reached 62° within 10 m: steeper than the cliffs.)
   * blend by cliffiness c (headland offset, angular noise, per-biome bias cb). The old rule (h − k0·distance beyond a
   * radius) let 25 m hills run 26 m past the edge: the islands filled the lattice square and met its border. */
  function coast(h, x, z, base, wob, cb) {
    const e = falloff(x, z, base, wob, true), d = e + Math.max(0, h - W.SEA + 0.4) / CLIFF_S, u = -e;
    let P;
    if (u <= 0) P = W.SEA + BEACH_S * u - 0.02 * u * u;
    else {
      const ur = M.clamp(u - BEACH_W, 0, BEACH_R), ul = Math.max(0, u - BEACH_W - BEACH_R);
      P = W.SEA + BEACH_S * Math.min(u, BEACH_W + BEACH_R) + (BACK_S - BEACH_S) * ur * ur / (2 * BEACH_R)
        + ul * BACK_S;
    }
    if (d <= 0 && h <= P) return h;
    const hc = d <= 0 ? h : h - d * CLIFF_S;
    const hb = Math.min(h, P);
    const a = M.atan2(z - 48, x - 48);
    let c = 0.5 + cb + coastHead / 5 + 1.8 * (M.noise2(M.cos(a) * 2.6 + 1.7, M.sin(a) * 2.6 - 4.2, seed + 131) - 0.5);
    c = M.clamp(c, 0, 1); c = c * c * (3 - 2 * c);
    return hb + (hc - hb) * c;
  }
  function falloff(x, z, base, wob, signed) {
    const dx = x - 48, dz = z - 48, r = M.len2(dx, dz), a = M.atan2(dz, dx), I = F.isl;
    let edge = base + wob * (M.noise2(M.cos(a) * 1.8 + 7.3, M.sin(a) * 1.8 + 3.1, seed + 99) - 0.5) * 2;
    if (I) {
      let lobes = 0;
      for (let k = 0; k < 4; k++) lobes += I.A[k] * M.cos((k + 1) * a + I.P[k]);
      edge += base * lobes * I.k + 8 * I.k * (fbm2(x / 13, z / 13, 77, 3) - 0.5);
      if (edge > ISL_MAX - 5) edge = ISL_MAX - 5 * M.exp(-(edge - (ISL_MAX - 5)) / 5);
      edge = Math.max(edge, 0.6 * base);
    }
    coastHead = edge - base;
    return signed ? r - edge : Math.max(0, r - edge);
  }

  /* desert dunes + mesas without the island edge (pure in x, z for a given seed; also the far ring, Step D).
   * lod (0 in and near the lattice) widens every feature far out, so a coarse far mesh does not alias them:
   * the dunes become draa-sized ridges. Mesas stand only in the play area (D4, user: beyond it nothing but yellow
   * dunes): the mesa mask fades out between MESA_R0 and MESA_R0 + MESA_W from the map centre, so a mesa near the
   * edge shrinks into a lower, smaller butte and none reaches the lattice border or the far dunes. */
  const MESA_R0 = C.DRY.PLAY_R, MESA_W = 6;
  const BORDER_BAND = 3;       // m: dry worlds, outer band of the disc LAT_R that returns to the raw dune function (stage 0)
  const BORDER_SOLID = 4;      // m: dry worlds, no caves this close to the disc's edge (the far ground beyond it is solid)
  let desertSand = 0;
  const DUNE_LAM = 32;         // m: crest spacing of the transverse dunes (D7)
  const DUNE_H = 0.13;         // dune height / crest spacing at mod 1 (real transverse dunes ~1/8-1/20; the steep end, for relief)
  const DUNE_LEE = 0.6;        // slip-face slope at the brink (tan 31°; sand's angle of repose is ~32-34°)
  function desertH(x, z, lod) {
    const L = lod || 0, sc = 1 + 3.2 * L;
    const bed = 3.4 + 3 * fbm2(x / 30, z / 30, 1, 3);
    const u = x * F.ca + z * F.sa;
    // D7 transverse dunes with a real cross-section (user: rows of spikes looked weird; measured: 18-30 % of the dune
    // area steeper than the angle of repose, p99 52-67°, 11-33 sharp cones / ha — the old symmetric pow(1 - |sin|, 1.8)
    // ridge had ~60° flanks at every crest and a 5-rad phase warp packed crests 2-6 m apart). Phase in wavelengths
    // ph = u / λ + gentle sinuosity (two weak warps, crest spacing stays ~0.7-1.4 λ); the local spacing 1 / |∇ph| sets
    // the height (DUNE_H · spacing · mod), so slopes never exceed the repose angle anywhere. Like a real active dune the
    // SLIP FACE always stands at the repose angle (DUNE_LEE at its brink) whatever the height: its share of the
    // wavelength is 1.5 · height / (DUNE_LEE · spacing) (smaller dunes: shorter slip faces); the stoss side (upwind,
    // the rest) rises with t²(2 − t) (flat trough, steepest ~2/3 up, ~5-9°) to a sharp brink; the slip face falls
    // 1 − 1.5q + 0.5q³ (concave toe) to the next trough. Far out (lod) everything widens by sc (gentler draa).
    const lam = DUNE_LAM * sc, ew = 0.5 * sc;
    const wf = (px, pz) => 0.35 * fbm2(px / (45 * sc), pz / (45 * sc), 2, 2) + 0.8 * fbm2(px / (120 * sc), pz / (120 * sc), 5, 2);
    const w0 = wf(x, z), gx = F.ca / lam + (wf(x + ew, z) - w0) / ew, gz = F.sa / lam + (wf(x, z + ew) - w0) / ew;
    const lamL = 1 / M.clamp(M.len2(gx, gz), 0.6 / lam, 1.6 / lam);          // local crest spacing (m)
    const ph = u / lam + w0, pf = ph - Math.floor(ph);
    const mod = 0.5 + 0.6 * fbm2(x / 35, z / 35, 3, 2);                              // crest height along the crest (0.5..1.1)
    const aS = 1 - 1.5 * DUNE_H * mod / DUNE_LEE;                                    // stoss share (0.72-0.88)
    let g;
    if (pf < aS) { const t = pf / aS; g = t * t * (2 - t); }
    else { const q = (pf - aS) / (1 - aS); g = 1 - 1.5 * q + 0.5 * q * q * q; }
    const dune = DUNE_H * lamL * mod * g * (1 + 0.6 * L) / sc;
    const sandTop = bed + 1.5 + dune + 2.5 * (L ? M.lerp(fbm2(x / 18, z / 18, 4, 3), 0.5, L) : fbm2(x / 18, z / 18, 4, 3));
    const fade = sat((M.len2(x - 48, z - 48) - MESA_R0) / MESA_W);
    const m = fade >= 1 ? 0 : fbm2(x / (16 * sc), z / (16 * sc), 6, 3) - 0.5 * fade;
    let h = sandTop, sand = sandTop - bed;
    if (m > 0.6) {
      let mh = 10 + 14 * sat((m - 0.6) / 0.12);
      const tq = Math.floor(mh / 4) * 4; mh = tq + 4 * sm(sat(((mh - tq) / 4 - 0.5) / 0.25));
      if (mh > h) { h = mh; sand = Math.max(0, 0.6 - (mh - sandTop) * 0.3); }
    }
    desertSand = sand;
    return h;
  }

  /* ---------- 1. heightfields ---------- */
  const HEIGHT = {
    temperate(x, z) {
      let h = 3 + 22 * sat((fbm2(x / 30, z / 30, 1, 4) - 0.28) / 0.44);
      const tq = Math.floor(h / 3) * 3; h = tq + 3 * sm(sat((h - tq) / 3 * 1.7 - 0.35));
      h += Math.max(0, 1 - Math.abs(fbm2(x / 17, z / 17, 7, 3) - 0.5) * 7) * 5;
      const cv = Math.abs((x - 48) * F.ca + (z - 48) * F.sa + 10 * (M.noise2(x / 22, z / 22, seed + 3) - 0.5));
      h -= Math.max(0, 7 - cv) * 1.4;
      return coast(h, x, z, 39, 4, 0);
    },
    alpine(x, z) {
      const rd = M.ridge2(x / 34, z / 34, seed + 1, 4);
      let h = 2 + 33 * M.pow(rd, 1.7) + 5 * fbm2(x / 16, z / 16, 2, 3);
      h = Math.min(h, 34);
      return coast(h, x, z, 38, 5, 0.2);       // fjord-like: mostly rock walls
    },
    canyon(x, z) {
      let h = 5 + 22 * sat((fbm2(x / 28, z / 28, 1, 4) - 0.25) / 0.45);
      const st = 4.5, tq = Math.floor(h / st) * st; h = tq + st * sm(sat(((h - tq) / st - 0.55) / 0.2));
      const cn = Math.abs(fbm2(x / 22, z / 22, 5, 3) - 0.5), cd = sat(1 - cn / 0.055);
      h = M.lerp(h, 3.9 + 2.2 * fbm2(x / 9, z / 9, 6, 2), M.pow(cd, 0.7));
      return coast(h, x, z, 40, 4, 0.25);        // sandstone sea cliffs
    },
    desert(x, z, col) {
      const h = desertH(x, z);
      extra[col] = desertSand;
      return W.dry ? h : coast(h, x, z, 40, 5, -0.1);          // dry (Step D): dunes run to the border and beyond
    },
    volcanic(x, z) {
      // P25: a volcanic island with 0-3 cones (F.volcanoes); without one, broader lava-plateau hills
      let h = 4.6 + 4.5 * fbm2(x / 20, z / 20, 1, 3) + (F.volcanoes.length ? 0 : 5 * fbm2(x / 34, z / 34, 7, 2));
      for (const v of F.volcanoes) {
      const r = M.len2(x - v.x, z - v.z), th = M.atan2(z - v.z, x - v.x);
      if (r < v.Rb) {
        let cone = v.Hv * M.pow(1 - r / v.Rb, v.ex);
        cone -= M.pow(1 - Math.abs(M.sin(th * 7 + 3 * fbm2(x / 15, z / 15, 4, 2))), 5) * sat(r / 12) * sat((v.Rb - r) / 10) * 2.4;
        cone += M.exp(-M.pow((r - v.Rc - 0.6) / 1.4, 2)) * 1.2;               // crater lip
        if (r < v.Rc + 1.5) cone = Math.min(cone, v.floor - v.base + (v.rim - v.floor) * M.pow(sat(r / (v.Rc + 1.5)), 2.2));
        h = Math.max(h, cone + v.base);
      }
      }
      return coast(h, x, z, 42, 4, 0);
    }
  };

  /* ---------- volcano: boiling crater lake + 0-2 lava canals down the flanks ----------
   * The canals are real channels for the lava fluid (sim/lava.js): a flat bottom 0.7 m below the design lava level, an
   * inner wall up to a levee crest 0.65 m above it, an outer levee slope; inside the crater only a V-notch through the
   * rim. The lava itself is not stamped: F.lavaInit holds the initial lava surface (lake + the filled part of each
   * canal); the rest of a canal is empty and the front advances during play. */
  /* P25 (user 2026-10-08): the volcanic biome is a volcanic ISLAND: 0-3 volcanoes at random places (count: rolls of
   * 70 % / 35 % / 17 %, stopping at the first miss; settings.volcanoes 0-3 forces it), each a cone with a crater lake
   * fed by a rock-walled conduit (stampConduit) whose side branches end in sealed magma pockets, 0-2 lava rivers leaking
   * from the crater (pre-filled to the sea at load), fumaroles on the flanks and the plains. More cones = smaller ones. */
  function setupVolcanoes(settings) {
    // own stream for the rolls / the placement of several cones: the classic single cone draws exactly what the old
    // setupVolcano drew from the map stream, so its map (pockets, spires, ...) is unchanged
    let hs = ((seed | 0) ^ 0x9e3779b9) >>> 0; hs = Math.imul(hs ^ (hs >>> 16), 0x45d9f3b) >>> 0; hs = Math.imul(hs ^ (hs >>> 16), 0x45d9f3b) >>> 0; hs = (hs ^ (hs >>> 16)) >>> 0;   // (a hashed seed: neighbouring seeds roll independently)
    const vr = M.rng_make(hs || 1), VR = () => M.rng_next(vr), VRR = (a, b) => a + (b - a) * VR();
    VR(); VR();
    let n = 0;
    const fv = settings && settings.volcanoes, forced = fv != null && fv !== 'auto' && fv !== '' && !isNaN(+fv);
    if (forced) n = M.clamp(+fv | 0, 0, 3);
    else if (VR() < 0.7) { n = 1; if (VR() < 0.35) { n = 2; if (VR() < 0.17) n = 3; } }
    const sz = [[36, 44, 28, 34], [24, 32, 18, 26], [19, 25, 14, 20]][Math.max(0, n - 1)];
    F.volcanoes = [];
    if (n === 1) {                                                             // the classic cone near the centre
      const v = { x: 48 + RR(-5, 5), z: 48 + RR(-5, 5), Rb: forced ? 44 : VRR(sz[0], sz[1]), Hv: forced ? 34 : VRR(sz[2], sz[3]), ex: 1.3, base: 2 };
      v.Rc = M.clamp(v.Rb * 0.13, 3.4, 5.6);
      const q = R(); v.nCanals = q < 0.3 ? 0 : q < 0.7 ? 1 : 2;
      F.volcanoes.push(v);
    } else for (let t = 0; t < 400 && F.volcanoes.length < n; t++) {
      const Rb = VRR(sz[0], sz[1]), Hv = VRR(sz[2], sz[3]), a = VR() * M.TAU, d = VRR(8, 26);
      const x = 48 + M.cos(a) * d, z = 48 + M.sin(a) * d;
      if (F.volcanoes.some(o => M.len2(o.x - x, o.z - z) < (o.Rb + Rb) * 0.5)) continue;
      const q = VR();
      F.volcanoes.push({ x, z, Rb, Hv, Rc: M.clamp(Rb * 0.13, 3.4, 5.6), ex: 1.3, base: 2, nCanals: q < 0.3 ? 0 : q < 0.7 ? 1 : 2 });
    }
    for (const v of F.volcanoes) {
      v.rim = v.Hv * M.pow(1 - v.Rc / v.Rb, v.ex) + 1.2 + v.base;                                     // rim/floor/lake are true heights
      v.floor = v.rim - Math.min(5.2, v.Rc * 0.95); v.lake = v.floor + 1.9;
    }
    F.volcano = F.volcanoes[0] || null;                       // (compat: the first / biggest one)
  }
  const nearVolcano = (x, z, pad) => F.volcanoes && F.volcanoes.some(v => M.len2(x - v.x, z - v.z) < v.Rc + pad);
  function gradH(i, k) {
    const a = hgt[k * NX + Math.max(0, i - 1)], b = hgt[k * NX + Math.min(NX - 1, i + 1)];
    const c = hgt[Math.max(0, k - 1) * NX + i], d = hgt[Math.min(NZ - 1, k + 1) * NX + i];
    return [(b - a) / (2 * H), (d - c) / (2 * H)];
  }
  /* trace one canal from the crater lake down to the sea: [{x, z, level, w}] every 0.5 m */
  function traceCanal(v, ang, seedK) {
    let x = v.x + M.cos(ang) * (v.Rc - 2.5), z = v.z + M.sin(ang) * (v.Rc - 2.5);   // start inside the lake: no sill
    let dx = M.cos(ang), dz = M.sin(ang), level = v.lake - 0.35;   // notch crest ~1.4 m under the lake: ~12 l/s per canal at full lake
    const path = [];
    for (let s = 0; s < 400; s++) {
      const i = clamp(Math.round(x / H), 1, NX - 2), k = clamp(Math.round(z / H), 1, NZ - 2);
      const g = gradH(i, k), gl = M.len2(g[0], g[1]) || 1;
      const radial = [x - v.x, z - v.z], rl = M.len2(radial[0], radial[1]) || 1;
      const mx = (M.noise2(s * 0.05, seedK * 7.1, seed + 41) - 0.5) * 1.6;
      // inside the crater/rim the descent points into the bowl: leave radially through the breach first
      const wg = rl < v.Rc + 3.5 ? 0 : 0.9;
      let nx = -g[0] / gl * wg + radial[0] / rl * 0.7 + (-dz) * mx, nz = -g[1] / gl * wg + radial[1] / rl * 0.7 + dx * mx;
      let nl = M.len2(nx, nz) || 1; nx /= nl; nz /= nl;
      const outward = (nx * radial[0] + nz * radial[1]) / rl;                     // never turn back towards the vent
      if (outward < 0.3) { nx += radial[0] / rl * (0.3 - outward) * 1.5; nz += radial[1] / rl * (0.3 - outward) * 1.5; nl = M.len2(nx, nz) || 1; nx /= nl; nz /= nl; }
      dx = dx * 0.7 + nx * 0.3; dz = dz * 0.7 + nz * 0.3; const dl = M.len2(dx, dz); dx /= dl; dz /= dl;
      x += dx * 0.5; z += dz * 0.5;
      if (x < 2 || z < 2 || x > W.SX - 2 || z > W.SZ - 2) break;
      const ground = hgt[clamp(Math.round(z / H), 0, NZ - 1) * NX + clamp(Math.round(x / H), 0, NX - 1)];
      // the design lava level keeps falling: slope >= 0.12 through the notch, >= 0.1 on the plain (Bingham lava
      // stalls and spills on flatter ground); low-slope stretches get a wider bed (the same discharge runs shallower)
      level -= rl < v.Rc + 3.5 ? 0.06 : 0.05;
      if (rl > v.Rc + 0.6) level = Math.min(level, ground - 0.55);           // not inside the bowl: the rim crest is the control section
      path.push({ x, z, level: Math.max(level, SEA + CANAL.DEPTH + 0.05), w: 1.4 + 0.5 * sat(s / 60) + 0.8 * sat((0.35 - gl) / 0.25) });
      if (ground < SEA + 0.3 && path.length > 8) break;                       // reached the shore: the bed stays above the sea,
                                                                              // the lava leaves the canal end down the beach
    }
    for (let it = 0; it < 3; it++) for (let q = 1; q + 1 < path.length; q++) path[q].w = (path[q - 1].w + 2 * path[q].w + path[q + 1].w) / 4;
    return path;
  }
  const CANAL = { DEPTH: 0.7, FREE: 0.75, CREST: 0.9, LEVEE: 0.8, NOTCH: 1.2, FILL_W: 0.8 };   // crest >= 2 cells: the 3x3 pre-blur ate ~0.2 m of a 1-cell crest
  function carveCanals() {
    const NC = NX * NZ, paths = [], pv = [];
    F.volcanoes.forEach((v, vi) => {
      const a0 = R() * M.TAU, spread = RR(1.9, 3.6);                          // a second canal 110-205 deg away
      for (let c = 0; c < v.nCanals; c++) { paths.push(traceCanal(v, a0 + c * spread + RR(-0.3, 0.3), vi * 3 + c)); pv.push(v); }
    });
    // per-column distance to the nearest canal segment, with the design level/width and path position there
    canalD = new Float32Array(NC).fill(1e9);
    const cl = new Float32Array(NC), cw = new Float32Array(NC), cs = new Float32Array(NC), cp = new Int8Array(NC).fill(-1);
    paths.forEach((path, pi) => {
      for (let q = 0; q + 1 < path.length; q++) {
        const a = path[q], b = path[q + 1], R0 = Math.max(a.w, b.w) + 4.5;
        const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - R0) / H)), i1 = Math.min(NX - 1, Math.ceil((Math.max(a.x, b.x) + R0) / H));
        const k0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - R0) / H)), k1 = Math.min(NZ - 1, Math.ceil((Math.max(a.z, b.z) + R0) / H));
        const ex = b.x - a.x, ez = b.z - a.z, el = ex * ex + ez * ez || 1;
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
          const px = i * H, pz = k * H, u = clamp(((px - a.x) * ex + (pz - a.z) * ez) / el, 0, 1);
          const dd = M.len2(px - a.x - ex * u, pz - a.z - ez * u), col = k * NX + i;
          if (dd >= canalD[col]) continue;
          canalD[col] = dd; cl[col] = a.level + (b.level - a.level) * u; cw[col] = a.w + (b.w - a.w) * u; cs[col] = q + u; cp[col] = pi;
        }
      }
    });
    // P25 (user: "pre-initialised": a random spawn once stood in front of an advancing lava front and died before the
    // first turn): every river is filled to the sea at load, so nothing advances at the start
    const fills = paths.map(p => { if (R() < 0.35) R(); else RR(0.3, 0.85); return p.length - 1; });   // (the old partial-fill draws, kept: the map stream stays the same)
    F.lavaInit = new Float32Array(NC).fill(-1);
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      const col = k * NX + i, x = i * H, z = k * H, dd = canalD[col];
      for (const o of F.volcanoes) {
        const ro = M.len2(x - o.x, z - o.z);
        if (ro < o.Rc + 1.5) F.lavaInit[col] = Math.max(F.lavaInit[col], o.lake);  // lake (lava.js floods it from the vent)
        if (ro < o.Rc + 2.5) lavaZone[col] = 1;
      }
      if (dd > 30) continue;
      const v = pv[cp[col]] || F.volcano, r = M.len2(x - v.x, z - v.z);
      const w = cw[col], lv = cl[col], bottom = lv - CANAL.DEPTH, crest = lv + CANAL.FREE;
      const cIn = w + 0.1, cOut = cIn + CANAL.CREST, in0 = 0.45 * w;
      const prof = dd <= in0 ? bottom : dd < cIn ? bottom + (crest - bottom) * sm(sat((dd - in0) / (cIn - in0))) : dd <= cOut ? crest : crest - (dd - cOut) * CANAL.LEVEE;
      const h0 = hgt[col];
      // inside the crater and through the rim: carve only (a V-notch); outside: exact channel + levees
      const lw = sat((r - v.Rc - 2) / 2);
      const carved = Math.min(h0, dd < cIn ? prof : crest + (dd - cIn) * CANAL.NOTCH);
      const built = dd < cIn ? prof : Math.max(h0, prof);
      hgt[col] = carved + (built - carved) * lw;
      if (dd < cOut + 1) lavaZone[col] = 1;
      if (dd < w * CANAL.FILL_W && cp[col] >= 0 && cs[col] <= fills[cp[col]]) F.lavaInit[col] = Math.max(F.lavaInit[col], Math.min(lv - 0.2, h0 + 2));   // ~0.5 m deep (near the steady flow)
    }
    F.canals = paths.map((p, pi) => ({ pts: p.map(q => [+q.x.toFixed(2), +q.level.toFixed(2), +q.z.toFixed(2), +q.w.toFixed(2)]), fill: +(fills[pi] / Math.max(1, p.length - 1)).toFixed(2) }));
  }

  /* overhang band (spec.band): floating-looking ledges grown out of the hillside between 14 and 26 m; density, or
   * -9 outside the band */
  function bandD(x, y, z, r) {
    const band = Math.max(0, 14 - y, y - 26) * 1.6 + Math.max(0, r - 30) * 0.8;
    return band < 5 ? (M.fbm3(x / 10, y / 6.5, z / 10, seed + 5, 2) - 0.64) * 9 - band : -9;
  }

  /* A bridge from spire a to b with deck ends yA, yB and radius rr is a real span (falls when cut at both ends,
   * step 2c): over its middle 70 % the heightfield stays >= 2.5 m under the deck across a 3 m wide strip, and
   * neither band ledges nor a third spire come within 1.2 m of the deck. */
  function spanClear(sp, a, b, yA, yB, rr, spec) {
    const L = M.len2(sp[b][0] - sp[a][0], sp[b][1] - sp[a][1]), ux = (sp[b][0] - sp[a][0]) / L, uz = (sp[b][1] - sp[a][1]) / L;
    for (let q = 3; q <= 17; q++) {
      const t = q / 20, x = sp[a][0] + (sp[b][0] - sp[a][0]) * t, z = sp[a][1] + (sp[b][1] - sp[a][1]) * t, y = yA + (yB - yA) * t, e = rr + 1.2;
      for (let u = -1.5; u <= 1.5; u += 0.75) {
        const xx = clamp(x - uz * u, 0, (NX - 1) * H), zz = clamp(z + ux * u, 0, (NZ - 1) * H);
        if (hgt[Math.round(zz / H) * NX + Math.round(xx / H)] > y - rr - 2.5) return false;
      }
      for (let c = 0; c < sp.length; c++) if (c !== a && c !== b && M.len2(x - sp[c][0], z - sp[c][1]) < sp[c][2] + e + 1 && sp[c][3] > y - e) return false;
      if (spec.band) for (let u = -1; u <= 1; u++) for (let v = -1; v <= 1; v++) {
        if (!u && !v) continue;
        const xx = x - uz * u * e, yy = y + v * e, zz = z + ux * u * e;
        if (yy > 10 && yy < 31 && bandD(xx, yy, zz, M.len2(xx - 48, zz - 48)) > -0.2) return false;
      }
    }
    return true;
  }

  /* ---------- 2. landmarks ---------- */
  function landmarks(nSp, nBr, spec) {
    const sp = [];
    for (let t = 0; t < 600 && sp.length < nSp; t++) {
      const x = RR(18, 78), z = RR(18, 78), h = hgt[Math.round(z / H) * NX + Math.round(x / H)];
      if (h < SEA + 3 || M.len2(x - 48, z - 48) > 32) continue;
      if (nearVolcano(x, z, 7)) continue;
      if (canalD && canalD[Math.round(z / H) * NX + Math.round(x / H)] < 7) continue;     // keep canals free (lava under a spire)
      if (sp.some(s => M.len2(s[0] - x, s[1] - z) < 12)) continue;
      sp.push([x, z, RR(spec.r0, spec.r1), Math.min(34, h + RR(spec.h0, spec.h1))]);
    }
    const br = [];
    for (let a = 0; a < sp.length && br.length < nBr; a++) for (let b = a + 1; b < sp.length && br.length < nBr; b++) {
      const L = M.len2(sp[a][0] - sp[b][0], sp[a][1] - sp[b][1]);
      if (L < 14 || L > 30 || R() < 0.35) continue;
      if (canalD) {                                     // no bridge over a canal: the lava layer sees only the top surface
        let over = false;
        for (let q = 0; q <= 12 && !over; q++) { const x = sp[a][0] + (sp[b][0] - sp[a][0]) * q / 12, z = sp[a][1] + (sp[b][1] - sp[a][1]) * q / 12; over = canalD[Math.round(z / H) * NX + Math.round(x / H)] < 4; }
        if (over) continue;
      }
      // deck ends at a fraction of each spire's height above its own ground (an absolute fraction put decks into the
      // hills); keep only real spans (spanClear), retrying once with the deck raised towards the spire tops
      const gA = hgt[Math.round(sp[a][1] / H) * NX + Math.round(sp[a][0] / H)], gB = hgt[Math.round(sp[b][1] / H) * NX + Math.round(sp[b][0] / H)];
      const fA = RR(0.55, 0.8), fB = RR(0.55, 0.8), rr = RR(0.9, 1.2);
      let yA = 0, yB = 0, clear = false;
      for (let lift = 0; lift <= 1 && !clear; lift++) {
        yA = gA + (sp[a][3] - gA) * (fA + lift * (0.88 - fA)); yB = gB + (sp[b][3] - gB) * (fB + lift * (0.88 - fB));
        clear = spanClear(sp, a, b, yA, yB, rr, spec);
      }
      if (!clear) continue;
      br.push([[sp[a][0], yA, sp[a][1]], [sp[b][0], yB, sp[b][1]], rr, spec.bridgeMat || 0]);
    }
    F.spires = sp; F.bridges = br;
  }

  /* ---------- 3. volume fill ---------- */
  const CAVE_WALL = 1.7;
  function fill(spec, kA, kB) {
    const D = W.d, Mt = W.mat;
    const sp = F.spires, br = F.bridges;
    let bandLo = 99, bandHi = -99;
    for (const b of br) { bandLo = Math.min(bandLo, b[0][1], b[1][1]) - 3; bandHi = Math.max(bandHi, b[0][1], b[1][1]) + 3; }
    for (let k = kA; k < kB; k++) {
      const z = k * H;
      for (let i = 0; i < NX; i++) {
        const x = i * H, col = k * NX + i, h = hgt[col], r = M.len2(x - 48, z - 48);
        const near = sp.filter(s => M.len2(x - s[0], z - s[1]) < s[2] + 5);
        const edge = i === 0 || k === 0 || i === NX - 1 || k === NZ - 1;
        const caveOK = !W.dry || (Math.min(i, k, NX - 1 - i, NZ - 1 - k) * H > BORDER_SOLID && r < C.DRY.LAT_R - BORDER_SOLID);   // D4/D6: the cut at the disc's edge matches the solid far ground
        for (let j = 0; j < NY; j++) {
          const y = j * H, o = (k * NY + j) * NX + i;
          let d = (h - y) * ginv[col], m = 0;
          for (const s of near) {
            if (y > s[3] + 1) continue;
            const hd = M.len2(x - s[0], z - s[1]);
            const rad = s[2] + Math.max(0, 7 - y) * 0.25 + (M.fbm3(x * 0.41 + y * 0.12, y * 0.3, z * 0.41 - x * 0.09, seed + 11, 2) - 0.5) * 1.0;
            const q = hd / rad, top = s[3] - q * q * rad * spec.dome + (M.noise2(x * 0.7, z * 0.7, seed + 17) - 0.5) * 0.5 * spec.dome;
            const sd = Math.min(rad - hd, top - y);
            if (sd > d) { d = sd; m = spec.spireMat || 0; }
          }
          if (y > bandLo && y < bandHi) for (const b of br) {
            const sd = M.seg_dist(x, y, z, b[0], b[1]);
            if (sd < b[2] + 3) { const v = b[2] + (M.fbm3(x * 0.3 + z * 0.1, y * 0.33, z * 0.3 - x * 0.1, seed + 13, 2) - 0.5) * 0.7 - sd; if (v > d) { d = v; m = b[3]; } }
          }
          // Every term below is continuous (max/min of continuous fields) so the iso-surface stays smooth:
          // overhang band: floating-looking ledges grown out of the hillside between 14 and 26 m
          if (spec.band && y > 10 && y < 31) d = Math.max(d, bandD(x, y, z, r));
          // caves: thin noise shells above 4 m. `CAVE_WALL - d` keeps >= CAVE_WALL m of rock (d ~ signed distance) to
          // every outside surface, including cliffs, spires and bridges; a vertical-only limit left sub-voxel sheets
          // on steep walls that meshed as a waffle of holes.
          if (spec.caves && caveOK && y > 2.5 && d > CAVE_WALL * 0.5) {
            let cv = Math.max((Math.abs(M.fbm3(x / 17, y / 8.5, z / 17, seed + 9, 2) - 0.5) - spec.caves * 1.15) * 16, 4 - y, CAVE_WALL - d, 8.5 - h);
            // user 2026-10-08: no caves in the volcano's core (a hollow under the crater let a holed floor turn the lake
            // into a free-standing lava tube); the core holds the rock-walled feeding conduit (stampConduit)
            for (const vo of F.volcanoes || []) cv = Math.max(cv, (vo.Rc + 7 - M.len2(x - vo.x, z - vo.z)) * 0.5);
            if (cv < d) { d = cv; m = 0; }
          }
          d = Math.max(d, 1.2 - y);
          if (edge && y > 1.2 && !W.dry) d = Math.min(d, -1);                 // islands: a closed rim; dry: dunes to the border
          D[o] = clamp(d, -3, 3); Mt[o] = d > 0 ? m : 0; W.heat[o] = 0;
        }
      }
    }
  }

  /* Despeckle: lattice-scale pits (air with >= 5 solid face neighbours) are filled and needles (solid with
   * >= 5 air face neighbours) are removed. Noise sources always leave a few of these; they mesh into spiky
   * artefacts and cost triangles. Values are set from the neighbour mean, so the surface stays smooth. */
  /* width (m) of the air gap around an air node of value v between solid neighbours a, b on one axis (linear field) */
  const SLIT_MIN = 0.12;
  function slit(v, a, b) { if (a <= 0 || b <= 0) return false; const n = -v; return H * (n / (a + n) + n / (b + n)) < SLIT_MIN; }
  function despeckle() {
    const D = W.d, Mt = W.mat, SXY = NX * NY;
    let changed = 0;
    for (let k = 1; k < NZ - 1; k++) for (let j = 1; j < NY - 1; j++) {
      let o = (k * NY + j) * NX + 1;
      for (let i = 1; i < NX - 1; i++, o++) {
        const v = D[o], s = v > 0;
        const a = D[o - 1], b = D[o + 1], c = D[o - NX], e = D[o + NX], f = D[o - SXY], g = D[o + SXY];
        let opp = 0;
        if ((a > 0) !== s) opp++; if ((b > 0) !== s) opp++; if ((c > 0) !== s) opp++;
        if ((e > 0) !== s) opp++; if ((f > 0) !== s) opp++; if ((g > 0) !== s) opp++;
        // O1: hairline sheets: air nodes between solid nodes on one axis whose slit would be under SLIT_MIN wide
        // (e.g. exactly 0 where the cave floor clamp `4 − y` meets rock above, canyon terrace seams at −0.02..−0.06):
        // they meshed as hidden double faces / 70 cm stray pieces and put phantom lines into the section outline.
        if (!s && (slit(v, a, b) || slit(v, c, e) || slit(v, f, g))) opp = 6;
        if (opp < 5) continue;
        const mean = (a + b + c + e + f + g) / 6;
        if (s) { D[o] = Math.min(-0.05, mean * 0.5); Mt[o] = 0; W.heat[o] = 0; }
        else {
          D[o] = Math.max(0.05, mean * 0.5);
          // material/heat of the most solid neighbour (0 before the material pass: assigned later)
          let best = o - 1, bd = a;
          if (b > bd) { bd = b; best = o + 1; } if (c > bd) { bd = c; best = o - NX; } if (e > bd) { bd = e; best = o + NX; }
          if (f > bd) { bd = f; best = o - SXY; } if (g > bd) { bd = g; best = o + SXY; }
          Mt[o] = Mt[best]; W.heat[o] = W.heat[best];
        }
        changed++;
      }
    }
    return changed;
  }

  // needles can be chains (removing a tip exposes the next voxel), so repeat until stable
  function despeckleAll() { for (let p = 0; p < 8; p++) if (!despeckle()) break; }

  /* ---------- U: underground maps ----------
   * The lattice is solid rock (and so is everything beyond it: W.far = UNDER_FAR) holding a connected cave system:
   * UNDER.N chambers (flat-floored ellipsoids, rx / rz 4-7.5 m, ry 2.6-4 m) on three levels, joined by tunnels along a
   * minimum spanning tree + a few extra loops (wiggly sphere-swept polylines, radius 1.4-2.1 m; slopes up to ~0.6, the
   * steepest links become shafts for the rope), side niches, and fbm wobble on every wall. Carved feature by feature
   * inside each feature's box (min of signed distances). Biome flavour = materials (underMaterials). */
  const UNDER_FAR = () => 1e4;
  let UF = null;                                          // { ch: [...], tu: [[p0, p1, r]...], ni: [...] }
  function underPlan(biome) {
    const SY = W.SY, ch = [], tu = [], ni = [];
    for (let k = 0; k < NZ * NX; k++) hgt[k] = SY - 0.5;
    const levels = [[5, 11], [14, 21], [24, 31]], n = 8 + M.rng_int(rng, 3);
    for (let t = 0; ch.length < n && t < 600; t++) {
      const L = levels[ch.length % 3], x = RR(12, 84), z = RR(12, 84), y = RR(L[0], L[1]);
      if (ch.some(c => M.len3(c.x - x, c.z - z, (c.y - y) * 2) < 15)) continue;
      ch.push({ x, y, z, rx: RR(4, 7.5), rz: RR(4, 7.5), ry: RR(2.6, 4) });
    }
    // Prim's MST over the chamber centres (distance with climb weighted x2), then the 2 shortest unused links
    const dist = (a, b) => M.len3(a.x - b.x, (a.y - b.y) * 2, a.z - b.z), inT = [0], edges = [];
    while (inT.length < ch.length) {
      let best = null;
      for (const i of inT) for (let j = 0; j < ch.length; j++) if (inT.indexOf(j) < 0) { const d = dist(ch[i], ch[j]); if (!best || d < best[2]) best = [i, j, d]; }
      edges.push(best); inT.push(best[1]);
    }
    const spare = [];
    for (let i = 0; i < ch.length; i++) for (let j = i + 1; j < ch.length; j++) if (!edges.some(e => (e[0] === i && e[1] === j) || (e[0] === j && e[1] === i))) spare.push([i, j, dist(ch[i], ch[j])]);
    spare.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);     // total order (= the stable JS order; C qsort is not stable)
    for (const e of spare.slice(0, 2 + M.rng_int(rng, 2))) edges.push(e);
    for (const [i, j] of edges) {
      const a = ch[i], b = ch[j], L = M.len2(b.x - a.x, b.z - a.z), r = RR(1.4, 2.1);
      const steps = Math.max(3, Math.round(L / 3.5)), nx = -(b.z - a.z) / (L || 1), nz = (b.x - a.x) / (L || 1), amp = RR(1, 3.5), ph = RR(0, 6.28);
      let prev = { x: a.x, y: a.y - a.ry * 0.45, z: a.z };
      for (let s = 1; s <= steps; s++) {
        const t = s / steps, wv = M.sin(t * Math.PI) * amp * M.sin(t * 2 * Math.PI + ph);
        const p = { x: a.x + (b.x - a.x) * t + nx * wv, y: (a.y - a.ry * 0.45) + ((b.y - b.ry * 0.45) - (a.y - a.ry * 0.45)) * t + M.sin(t * Math.PI * 3 + ph) * 0.6, z: a.z + (b.z - a.z) * t + nz * wv };
        tu.push([prev, p, r]); prev = p;
        if (M.rng_next(rng) < 0.18) ni.push({ x: p.x + nx * RR(-3, 3), y: p.y + RR(-0.5, 1.5), z: p.z + nz * RR(-3, 3), r: RR(1, 2.2) });
      }
    }
    UF = { ch, tu, ni };
    F.caves = { chambers: ch.map(c => ({ x: c.x, y: c.y, z: c.z, rx: c.rx, ry: c.ry, rz: c.rz })), tunnels: tu.length, niches: ni.length };
  }
  function underFill(biome) {
    const D = W.d, Mt = W.mat, SY = W.SY;
    D.fill(3); Mt.fill(0);
    const carve = (x0, y0, z0, x1, y1, z1, sdf) => {
      const i0 = Math.max(1, Math.floor(x0 / H)), i1 = Math.min(NX - 2, Math.ceil(x1 / H)), j0 = Math.max(2, Math.floor(y0 / H)), j1 = Math.min(NY - 3, Math.ceil(y1 / H));
      const k0 = Math.max(1, Math.floor(z0 / H)), k1 = Math.min(NZ - 2, Math.ceil(z1 / H));
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const o = (k * NY + j) * NX + i, d = sdf(i * H, j * H, k * H);
        if (d < D[o]) D[o] = d;
      }
    };
    const wob = (x, y, z) => (M.noise3(x / 2.3, y / 2.3, z / 2.3, seed + 501) - 0.5) * 0.9 + (M.noise3(x / 0.9, y / 0.9, z / 0.9, seed + 502) - 0.5) * 0.3;
    for (const c of UF.ch) {
      const m = 1.5;
      carve(c.x - c.rx - m, c.y - c.ry - m, c.z - c.rz - m, c.x + c.rx + m, c.y + c.ry + m, c.z + c.rz + m, (x, y, z) => {
        const dy = y - c.y, ry = dy < 0 ? c.ry * 0.62 : c.ry;                 // flatter floor
        const e = M.len3((x - c.x) / c.rx, dy / ry, (z - c.z) / c.rz);
        return (e - 1) * Math.min(c.rx, ry, c.rz) + wob(x, y, z);
      });
    }
    for (const [a, b, r] of UF.tu) {
      const m = r + 1.2;
      carve(Math.min(a.x, b.x) - m, Math.min(a.y, b.y) - m, Math.min(a.z, b.z) - m, Math.max(a.x, b.x) + m, Math.max(a.y, b.y) + m, Math.max(a.z, b.z) + m,
        (x, y, z) => M.seg_dist(x, y, z, [a.x, a.y, a.z], [b.x, b.y, b.z]) - r + wob(x, y, z) * 0.7);
    }
    for (const q of UF.ni) carve(q.x - q.r - 1, q.y - q.r - 1, q.z - q.r - 1, q.x + q.r + 1, q.y + q.r + 1, q.z + q.r + 1, (x, y, z) => M.len3(x - q.x, y - q.y, z - q.z) - q.r + wob(x, y, z));
    for (let o = 0; o < D.length; o++) D[o] = D[o] > 3 ? 3 : D[o] < -3 ? -3 : D[o];
    // the lattice's outer shell and the bottom stay solid; the top layer is the (unreachable) roof
    for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      if (i === 0 || k === 0 || i === NX - 1 || k === NZ - 1 || j < 2 || j * H > SY - 1) { const o = (k * NY + j) * NX + i; D[o] = Math.max(D[o], 1); }
    }
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) { hgt[k * NX + i] = SY - 0.5; }
  }
  // biome flavour: limestone (temperate), rock + ice caves (alpine), banded sandstone (canyon), sandstone with sand floors
  // (desert), basalt with crust / ash (volcanic); loose floors (scree / soil / sand / ash) where air lies just above
  function underMaterials(biome) {
    const D = W.d, Mt = W.mat, SXY = NX * NY;
    for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const o = (k * NY + j) * NX + i;
      if (D[o] <= 0 || Mt[o] === MAT.LAVA || Mt[o] === MAT.CRUST || Mt[o] === MAT.BASALT && biome !== 'volcanic') continue;
      const x = i * H, y = j * H, z = k * H;
      if (y < 1) { Mt[o] = MAT.BEDROCK; continue; }
      const floor = j + 1 < NY && D[o + NX] <= 0 && D[o] < 0.9, band = M.noise3(x / 9, y / 2.2, z / 9, seed + 503);
      let m;
      if (biome === 'alpine') m = y > 22 && M.noise3(x / 6, y / 6, z / 6, seed + 504) > 0.58 ? MAT.ICE : MAT.ROCK;
      else if (biome === 'canyon') m = band > 0.55 ? MAT.ROCK : MAT.SANDSTONE;
      else if (biome === 'desert') m = MAT.SANDSTONE;
      else if (biome === 'volcanic') m = band > 0.72 ? MAT.CRUST : MAT.BASALT;
      else m = band > 0.7 ? MAT.SOIL : MAT.ROCK;
      if (floor) m = biome === 'desert' || biome === 'canyon' && band < 0.4 ? MAT.SAND : biome === 'volcanic' ? MAT.ASH : biome === 'alpine' && m === MAT.ICE ? MAT.ICE : band < 0.45 ? MAT.SCREE : MAT.SOIL;
      Mt[o] = m;
    }
    materialEdges();
  }

  /* ---------- 4. stamps ---------- */
  /* LV1: magma only sits inside rock. A pocket (sill / chamber) + its feeder vein (a dike towards the surface) is
   * encased in a rock wall POCKET_WALL m thick (x 0.8-1.3 by 3D noise: irregular): glassy chilled margin + baked
   * contact zone. Caves the wall crosses are plugged with basalt (cave air = air at least 0.6 m under the
   * heightfield); the whole wall is CRUST (the cap draws it as dark glassy rock with glowing contact cracks); a lava voxel whose wall would have to stand in open air (a cliff face, the sky, the lattice edge)
   * becomes wall instead, so after generation no lava voxel is within the wall distance of air. The vein tapers
   * (0.45 -> 0.28 m) and stops POCKET_ROOF m under the ground. */
  const POCKET_WALL = 0.9, POCKET_ROOF = 1.5;
  function stampPockets(n) {
    const D = W.d, Mt = W.mat, SXY = NX * NY, RW = Math.ceil(POCKET_WALL * 1.3 / H);
    const wallAt = (X, Y, Z) => POCKET_WALL * (0.8 + 0.5 * M.noise3(X / 2.3, Y / 2.3, Z / 2.3, seed + 79));
    const caveAir = (o, i, j, k) => !W.under && D[o] <= 0 && j * H < hgt[k * NX + i] - 0.6;   // U: never plug the cave system
    for (let p = 0, tries = 0; p < n && tries < 400; tries++) {
      const x = RR(14, 82), z = RR(14, 82), col = Math.round(z / H) * NX + Math.round(x / H), h = hgt[col];
      if (h < 9 || lavaZone[col]) continue;
      if (F.pockets.some(q => M.len2(q.x - x, q.z - z) < 12)) continue;
      const rx = RR(2.2, 3.6), ry = RR(1.5, 2.3), rz = RR(2.2, 3.6), cy = W.under ? RR(5, W.SY - 8) : Math.max(SEA + ry + 1.2, h - RR(4.5, 8));
      if (cy + ry > h - 1.8) continue;
      // is the column solid at the pocket centre (not inside a cave)?
      if (W.d[(Math.round(z / H) * NY + Math.round(cy / H)) * NX + Math.round(x / H)] <= 0.5) continue;
      const P = { x, y: cy, z, rx, ry, rz, vein: [] };
      // vein (dike): wiggly tapering tube from the pocket roof towards the surface, stopping POCKET_ROOF under it
      let vx = x, vy = cy + ry * 0.8, vz = z; const top = Math.max(vy + 0.5, h - POCKET_ROOF);
      P.vein.push([vx, vy, vz]);
      for (let s = 1; s <= 6; s++) { vx += RR(-0.7, 0.7); vz += RR(-0.7, 0.7); vy = cy + ry * 0.8 + (top - cy - ry * 0.8) * s / 6; P.vein.push([vx, vy, vz]); }
      const ext = Math.max(rx, rz) + 2 + RW * H;
      const i0 = Math.max(RW + 1, Math.floor((x - ext) / H)), i1 = Math.min(NX - 2 - RW, Math.ceil((x + ext) / H));
      const k0 = Math.max(RW + 1, Math.floor((z - ext) / H)), k1 = Math.min(NZ - 2 - RW, Math.ceil((z + ext) / H));
      const j0 = Math.max(3, Math.floor((cy - ry - 1.5) / H)), j1 = Math.min(NY - 2 - RW, Math.ceil((top + 1) / H));
      // 1. candidate lava voxels: inside the pocket / vein shape, rock or cave air, a full roof above
      const cand = new Set();
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const o = (k * NY + j) * NX + i, X = i * H, Y = j * H, Z = k * H;
        if (!(D[o] > 0 || caveAir(o, i, j, k))) continue;
        const e = M.len3((X - x) / rx, (Y - cy) / ry, (Z - z) / rz);
        let vd = 9, vr = 0.45;
        for (let s = 0; s + 1 < P.vein.length; s++) { const d = M.seg_dist(X, Y, Z, P.vein[s], P.vein[s + 1]); if (d < vd) { vd = d; vr = 0.45 - 0.17 * (s + 0.5) / 6; } }
        const wob = (M.noise3(X / 1.5, Y / 1.5, Z / 1.5, seed + 77) - 0.5) * 0.3;
        if (!(e < 1 + wob * 0.3 || vd < vr + wob * 0.4)) continue;
        if (Y > hgt[k * NX + i] - wallAt(X, Y, Z) - 0.4) continue;
        cand.add(o);
      }
      // 2. keep a candidate only if its whole wall can stand: every voxel within the wall distance is rock, cave air
      //    (to be plugged) or lava
      const lava = [];
      for (const o of cand) {
        const i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / SXY), wl = wallAt(i * H, j * H, k * H);
        let okW = true;
        for (let dk = -RW; dk <= RW && okW; dk++) for (let dj = -RW; dj <= RW && okW; dj++) for (let di = -RW; di <= RW; di++) {
          if ((di * di + dj * dj + dk * dk) * H * H > wl * wl) continue;
          const q = o + dk * SXY + dj * NX + di;
          if (D[q] > 0 || cand.has(q) || caveAir(q, i + di, j + dj, k + dk)) continue;
          okW = false; break;
        }
        if (okW) lava.push(o);
      }
      if (lava.length < 40) continue;
      const isLava = new Set(lava);
      // 3. the wall: plug cave air (density ~ wall distance left, a smooth new cave surface), basalt, chilled margin
      for (const o of lava) {
        const i = o % NX, j = Math.floor(o / NX) % NY, k = Math.floor(o / SXY), wl = wallAt(i * H, j * H, k * H);
        for (let dk = -RW; dk <= RW; dk++) for (let dj = -RW; dj <= RW; dj++) for (let di = -RW; di <= RW; di++) {
          const d = Math.sqrt(di * di + dj * dj + dk * dk) * H;
          if (d > wl || d === 0) continue;
          const q = o + dk * SXY + dj * NX + di;
          if (isLava.has(q)) continue;
          if (D[q] <= 0) D[q] = Math.min(0.6, Math.max(0.05, wl - d));
          else if (D[q] < wl - d) D[q] = Math.min(Math.max(D[q], wl - d), 1.5);
          Mt[q] = MAT.CRUST;                     // glassy chilled margin + baked contact zone (dark on the cut face)
        }
      }
      for (const o of lava) { Mt[o] = MAT.LAVA; W.heat[o] = 250; D[o] = Math.max(D[o], 0.6); }
      P.vox = lava.length;
      F.vents.push({ x: vx, y: h, z: vz, kind: 'fumarole' });
      F.pockets.push(P); p++;
    }
  }
  /* The volcano's feeding conduit (user 2026-10-08: "lava must flow in a rocky channel up"): a column of voxel lava
   * (r ~1 m, a slight wander) from 3 m up to just under the crater floor, in a basalt wall ~1.2 m thick with a glassy
   * chilled margin; so the section through the volcano shows magma rising in a rock channel, and a blast that opens
   * it breaches a walled lava body (lava.js breach) instead of a free column of the 2.5D layer */
  function stampConduit(v, vi) {
    const D = W.d, Mt = W.mat, SXY = NX * NY, c0 = Math.round(v.z / H) * NX + Math.round(v.x / H);
    const yTop = hgt[c0] - 1.0, R0 = Math.max(0.7, v.Rc * 0.18), WALL = 1.2, MARGIN = 0.45, ext = R0 + WALL + 1;
    const i0 = Math.max(2, Math.floor((v.x - ext - 1) / H)), i1 = Math.min(NX - 3, Math.ceil((v.x + ext + 1) / H));
    const k0 = Math.max(2, Math.floor((v.z - ext - 1) / H)), k1 = Math.min(NZ - 3, Math.ceil((v.z + ext + 1) / H));
    let n = 0;
    const axis = y => [v.x + (M.noise2(y * 0.11, 3.1 + vi, seed + 91) - 0.5) * 1.2, v.z + (M.noise2(y * 0.11, 7.7 + vi, seed + 92) - 0.5) * 1.2];
    for (let j = Math.ceil(3 / H); j * H <= yTop; j++) {
      const y = j * H, [cx, cz] = axis(y);
      const R = R0 * (0.85 + 0.3 * M.noise2(y * 0.3, 1.3 + vi, seed + 93)) + Math.max(0, 6 - y) * 0.12;    // a little wider at the root
      for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
        const o = (k * NY + j) * NX + i, r = M.len2(i * H - cx, k * H - cz);
        if (r < R && y < yTop - 0.2) { Mt[o] = MAT.LAVA; W.heat[o] = 250; D[o] = Math.max(D[o], 0.6); n++; }
        else if (r < R + WALL + (y > yTop - 0.6 ? 0.6 : 0)) {
          D[o] = Math.max(D[o], Math.min(1.5, R + WALL - r + 0.3));
          Mt[o] = r < R + MARGIN ? MAT.CRUST : MAT.BASALT;
        }
      }
    }
    // P25: the conduit is a TREE: 1-3 side branches (dikes / sills, r ~0.45 m) leave the trunk and end in sealed magma
    // pockets (ellipsoids), all walled; a pocket must stay >= 1.6 m under the flank (sealed: no damage until breached)
    const branches = [];
    for (let b = 0, nb = 1 + M.rng_int(rng, 3), tries = 0; b < nb && tries < 30; tries++) {
      const yb = RR(4, Math.max(5, yTop * 0.65)), a = R() * M.TAU, L = RR(4, Math.min(10, v.Rb * 0.32)), dy = RR(-1.5, 2.5);
      const [bx, bz] = axis(yb), ex = bx + M.cos(a) * L, ez = bz + M.sin(a) * L, ey = yb + dy;
      const rx = RR(1.6, 2.8), ry = RR(1.1, 1.8), rz = RR(1.6, 2.8);
      const ground = hgt[clamp(Math.round(ez / H), 0, NZ - 1) * NX + clamp(Math.round(ex / H), 0, NX - 1)];
      if (ey + ry > ground - 1.6 - WALL || ey - ry < 2.5) continue;
      branches.push({ a: [bx, yb, bz], b: [ex, ey, ez], rx, ry, rz }); b++;
    }
    for (const br of branches) {
      const bi0 = Math.max(2, Math.floor((Math.min(br.a[0], br.b[0]) - 4.5) / H)), bi1 = Math.min(NX - 3, Math.ceil((Math.max(br.a[0], br.b[0]) + 4.5) / H));
      const bk0 = Math.max(2, Math.floor((Math.min(br.a[2], br.b[2]) - 4.5) / H)), bk1 = Math.min(NZ - 3, Math.ceil((Math.max(br.a[2], br.b[2]) + 4.5) / H));
      const bj0 = Math.max(2, Math.floor((Math.min(br.a[1], br.b[1]) - 3.5) / H)), bj1 = Math.min(NY - 3, Math.ceil((Math.max(br.a[1], br.b[1]) + 3.5) / H));
      const n0 = n;
      for (let k = bk0; k <= bk1; k++) for (let j = bj0; j <= bj1; j++) for (let i = bi0; i <= bi1; i++) {
        const X = i * H, Y = j * H, Z = k * H, o = (k * NY + j) * NX + i;
        const dDike = M.seg_dist(X, Y, Z, br.a, br.b) - 0.45, e = M.len3((X - br.b[0]) / br.rx, (Y - br.b[1]) / br.ry, (Z - br.b[2]) / br.rz);
        const dPocket = (e - 1) * Math.min(br.rx, br.ry, br.rz), d = Math.min(dDike, dPocket);
        if (d < 0) { Mt[o] = MAT.LAVA; W.heat[o] = 250; D[o] = Math.max(D[o], 0.6); n++; }
        else if (d < WALL && Mt[o] !== MAT.LAVA) { D[o] = Math.max(D[o], Math.min(1.5, WALL - d + 0.3)); Mt[o] = d < MARGIN ? MAT.CRUST : MAT.BASALT; }
      }
      F.pockets.push({ x: br.b[0], y: br.b[1], z: br.b[2], rx: br.rx, ry: br.ry, rz: br.rz, vein: [br.a, br.b], volcano: vi, vox: n - n0 });
    }
    v.conduit = { top: yTop, vox: n, branches: branches.length };
  }
  /* fumaroles / thermal vents (P25): gas vents on the cone flanks (2-4 per volcano, between the crater and halfway
   * down) and on the plains (1-3): render/vents.js draws a sulphur-stained mouth and a steam plume */
  function placeFumaroles() {
    const add = (x, z) => { const c = clamp(Math.round(z / H), 0, NZ - 1) * NX + clamp(Math.round(x / H), 0, NX - 1), h = hgt[c]; if (h < SEA + 1.2 || lavaZone[c] || (canalD && canalD[c] < 3)) return false; F.vents.push({ x, y: h, z, kind: 'fumarole' }); return true; };
    for (const v of F.volcanoes) for (let q = 0, n = 2 + M.rng_int(rng, 3), t = 0; q < n && t < 40; t++) { const a = R() * M.TAU, r = RR(v.Rc + 3, v.Rb * 0.5); if (add(v.x + M.cos(a) * r, v.z + M.sin(a) * r)) q++; }
    for (let q = 0, n = 1 + M.rng_int(rng, 3), t = 0; q < n && t < 60; t++) if (add(RR(16, 80), RR(16, 80))) q++;
  }
  function stampIceShelf() {
    // distance-to-land on the column grid (two-pass chamfer), ice where the sea is shallow near shore
    const NC = NX * NZ, dist = new Float32Array(NC);
    for (let c = 0; c < NC; c++) dist[c] = hgt[c] > SEA - 0.2 ? 0 : 1e9;
    for (let pass = 0; pass < 2; pass++) for (let kk = 0; kk < NZ; kk++) for (let ii = 0; ii < NX; ii++) {
      const k = pass ? NZ - 1 - kk : kk, i = pass ? NX - 1 - ii : ii, c = k * NX + i, s = pass ? 1 : -1;
      if (i + s >= 0 && i + s < NX) dist[c] = Math.min(dist[c], dist[c + s] + H);
      if (k + s >= 0 && k + s < NZ) dist[c] = Math.min(dist[c], dist[c + s * NX] + H);
    }
    const a0 = R() * M.TAU;
    for (let k = 1; k < NZ - 1; k++) for (let i = 1; i < NX - 1; i++) {
      const c = k * NX + i, x = i * H, z = k * H;
      const ang = M.atan2(z - 48, x - 48), sector = M.cos(ang - a0);
      const reach = 4 + 6 * sat(sector * 1.5) + 2 * (M.noise2(x / 6, z / 6, seed + 61) - 0.5);
      if (dist[c] <= 0 || dist[c] > reach) continue;
      const topY = SEA + 0.32 - dist[c] * 0.02, botY = SEA - 0.75;
      for (let j = Math.floor(botY / H); j <= Math.ceil(topY / H); j++) {
        const o = (k * NY + j) * NX + i, y = j * H, v = Math.min(topY - y, y - botY);
        if (v > W.d[o]) { W.d[o] = clamp(v, -3, 3); if (v > 0) W.mat[o] = MAT.ICE; }
      }
    }
    F.iceShelf = true;
  }

  /* ---------- 5. materials ----------
   * Surface layers use the true distance below the surface, not the vertical depth below the column top: on steep
   * walls every column top is a surface voxel, so a vertical-depth rule paints a moire grid of single-voxel spots.
   * The density is not a distance deep inside (caves that nearly carved leave d ~ 0.3 far from air), so the distance
   * comes from a 6-connected BFS from air-adjacent voxels (layers 1..SL_MAX). Each voxel also carries the normal
   * up-component of the surface voxel it was reached from. Deeper voxels use the vertical depth (dv). */
  const SL_MAX = 7;
  let sLay, sNy;
  function surfaceLayers() {
    const D = W.d, SXY = NX * NY, N = W.N;
    sLay = new Uint8Array(N); sNy = new Int8Array(N);
    let cur = new Int32Array(1 << 16), nc = 0;
    const push = (arr, n, o) => { if (n >= arr.length) { const b = new Int32Array(arr.length * 2); b.set(arr); arr = b; } arr[n] = o; return arr; };
    for (let k = 1; k < NZ - 1; k++) for (let j = 1; j < NY - 1; j++) {
      let o = (k * NY + j) * NX + 1;
      for (let i = 1; i < NX - 1; i++, o++) {
        if (D[o] <= 0) continue;
        if (D[o - 1] > 0 && D[o + 1] > 0 && D[o - NX] > 0 && D[o + NX] > 0 && D[o - SXY] > 0 && D[o + SXY] > 0) continue;
        const gx = D[o + 1] - D[o - 1], gy = D[o + NX] - D[o - NX], gz = D[o + SXY] - D[o - SXY];
        sLay[o] = 1; sNy[o] = Math.round(clamp(-gy / (M.len3(gx, gy, gz) || 1), -1, 1) * 127);
        cur = push(cur, nc++, o);
      }
    }
    let nxt = new Int32Array(cur.length);
    for (let L = 2; L <= SL_MAX && nc > 0; L++) {
      let nn = 0;
      for (let q = 0; q < nc; q++) {
        const o = cur[q], ny = sNy[o];
        for (let t = 0; t < 6; t++) {
          const n = t === 0 ? o - 1 : t === 1 ? o + 1 : t === 2 ? o - NX : t === 3 ? o + NX : t === 4 ? o - SXY : o + SXY;
          if (n < 0 || n >= N || sLay[n] || D[n] <= 0) continue;
          sLay[n] = L; sNy[n] = ny; nxt = push(nxt, nn++, n);
        }
      }
      const t = cur; cur = nxt; nxt = t.length >= cur.length ? t : new Int32Array(cur.length); nc = nn;
    }
  }
  function materials(rule, kA, kB) {
    const D = W.d, Mt = W.mat;
    for (let k = kA; k < kB; k++) for (let i = 1; i < NX - 1; i++) {
      let dv = -1;
      const x = i * H, z = k * H, col = k * NX + i;
      for (let j = NY - 2; j >= 0; j--) {
        const o = (k * NY + j) * NX + i, v = D[o];
        if (v <= 0) { dv = -1; continue; }
        dv = dv < 0 ? 0 : dv + H;
        if (j * H < 1.0) { Mt[o] = MAT.BEDROCK; continue; }
        if (Mt[o]) continue;
        const L = sLay[o];
        let de, ny;
        if (L === 1) { de = Math.min(v, H); ny = sNy[o] / 127; }
        else if (L > 1) { de = Math.max(v, (L - 1) * H + 0.25); ny = sNy[o] / 127; }
        else { de = Math.max(SL_MAX * H, dv); ny = 1; }
        Mt[o] = rule(x, j * H, z, de, ny, col, dv);
      }
    }
  }
  /* the border nodes (materials() skips them): islands get a bedrock rim; on dry worlds (D4) the dunes continue past
   * the border, so each border node copies its inner neighbour (z edges first, then x edges, so corners get one too) */
  function materialEdges() {
    const D = W.d, Mt = W.mat, SXY = NX * NY;
    const set = (o, oi, j) => { if (D[o] > 0) Mt[o] = !W.dry ? MAT.BEDROCK : Mt[oi] || (j * H < 1 ? MAT.BEDROCK : MAT.SAND); };
    for (let i = 1; i < NX - 1; i++) for (let j = 0; j < NY; j++) for (const k of [0, NZ - 1]) { const o = (k * NY + j) * NX + i; set(o, k ? o - SXY : o + SXY, j); }
    for (let k = 0; k < NZ; k++) for (let j = 0; j < NY; j++) for (const i of [0, NX - 1]) { const o = (k * NY + j) * NX + i; set(o, i ? o - 1 : o + 1, j); }
    if (!W.dry) for (let i = 0; i < NX; i++) for (let j = 0; j < NY; j++) for (const k of [0, NZ - 1]) { const o = (k * NY + j) * NX + i; if (D[o] > 0) Mt[o] = MAT.BEDROCK; }
  }
  const nz = (x, z, s) => M.noise2(x / 4.3, z / 4.3, seed + s);
  let cliffMax, glacier;
  function neighborhoodMax(rad) {
    const out = new Float32Array(NX * NZ), r = Math.round(rad / H);
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
      let m = -9;
      for (let dk = -r; dk <= r; dk += 2) for (let di = -r; di <= r; di += 2) { const ii = clamp(i + di, 0, NX - 1), kk = clamp(k + dk, 0, NZ - 1); m = Math.max(m, hgt[kk * NX + ii]); }
      out[k * NX + i] = m;
    }
    return out;
  }
  function boxBlur(src, rad) {
    const r = Math.round(rad / H), tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const ii = clamp(i + d, 0, NX - 1); s += src[k * NX + ii]; n++; } tmp[k * NX + i] = s / n; }
    for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { const kk = clamp(k + d, 0, NZ - 1); s += tmp[kk * NX + i]; n++; } out[k * NX + i] = s / n; }
    return out;
  }
  /* rule(x, y, z, de = distance below the surface, ny = local up-component of the normal, col, dv = vertical depth) */
  const RULES = {
    temperate(x, y, z, de, ny, col) {
      const n = nz(x, z, 21);
      if (y > 24.5 + n * 3 && ny > 0.45 && de < 0.6 + n * 0.6) return MAT.SNOW;
      if (y < SEA + 1.4 + n * 0.9 && ny > 0.55 && de < 1.6) return MAT.SAND;
      if (cliffMax[col] - y > 3.5 && ny > 0.6 && de < 0.7 && y < 18) return MAT.SCREE;
      // topsoil: thick on flats, thin on slopes, none on cliffs (bare rock)
      const soilT = ny < 0.5 ? 0 : (0.55 + 0.85 * sm(sat((ny - 0.5) / 0.35))) * (0.75 + n * 0.5);
      if (de < soilT) return MAT.SOIL;
      return MAT.ROCK;
    },
    alpine(x, y, z, de, ny, col) {
      const n = nz(x, z, 22), snowline = 9.5 + n * 4;
      if (glacier[col] > 0.5 && de < 2.6 && y > 5 && ny > 0.2) return de < 0.6 && ny > 0.6 ? MAT.SNOW : MAT.ICE;
      if (y > snowline && ny > 0.42 && de < 0.9 + n * 0.9) return MAT.SNOW;
      if (y < SEA + 1.2 && ny > 0.6 && de < 1.2) return MAT.SCREE;
      if (y <= snowline && ny > 0.72 && de < 0.6 + n * 0.4) return MAT.SOIL;
      if (cliffMax[col] - y > 3 && ny > 0.55 && de < 0.7) return MAT.SCREE;
      return MAT.ROCK;
    },
    canyon(x, y, z, de, ny, col, dv) {
      const n = nz(x, z, 23);
      if (y < SEA + 1.3 && ny > 0.5 && de < 1.4) return MAT.SAND;
      if (cliffMax[col] - y > 3 && ny > 0.55 && de < 0.8 + n * 0.5) return MAT.SCREE;
      if (ny > 0.86 && de < 0.5 + n * 0.35 && y > 7) return MAT.SOIL;
      if (y < 3.5 + n * 1.5 || dv > 9) return MAT.ROCK;
      return MAT.SANDSTONE;
    },
    desert(x, y, z, de, ny, col, dv) {
      const st = extra[col];
      if (st > 0.05 && ny > 0.3 && de < st + G.SAND_EXTRA) return MAT.SAND;   // dune sand (none on mesa walls)
      if (y < SEA + 1.2 && ny > 0.3 && de < 1.5) return MAT.SAND;
      if (cliffMax[col] - y > 3 && ny > 0.5 && de < 0.7) return MAT.SAND;   // sand banked against cliff feet
      return dv > G.ROCK_DV ? MAT.ROCK : MAT.SANDSTONE;
    },
    volcanic(x, y, z, de, ny, col) {
      const n = nz(x, z, 24);
      if (y < SEA + 1.2 && ny > 0.5 && de < 1.3) return MAT.ASH;                  // black-sand beaches
      // old flows: radial streaks round the nearest cone (none on a cone-less island)
      let v = null, r = 1e9; for (const o of F.volcanoes) { const ro = M.len2(x - o.x, z - o.z); if (ro < r) { r = ro; v = o; } }
      const th = v ? M.atan2(z - v.z, x - v.x) : 0;
      const oldFlow = !!v && r < v.Rb && Math.abs(M.sin(th * 5 + M.noise2(x / 12, z / 12, seed + 31) * 4)) < 0.16 && r > v.Rc + 3;
      if ((oldFlow || lavaZone[col]) && ny > 0.2 && de < 1.1) return MAT.CRUST;      // old flows, canal beds and levees
      if (ny > 0.68 && de < 0.6 + n * 0.6) return MAT.ASH;
      return MAT.BASALT;
    }
  };
  const SPEC = {
    temperate: { dome: 0.9, band: true, caves: 0.075, sp: [6, 4], r0: 1.6, r1: 2.6, h0: 8, h1: 14 },
    alpine: { dome: 1.6, band: true, caves: 0.07, sp: [5, 3], r0: 1.8, r1: 2.6, h0: 6, h1: 11, bridgeMat: MAT.ICE },
    canyon: { dome: 0.12, band: true, caves: 0.06, sp: [8, 4], r0: 1.3, r1: 2.2, h0: 6, h1: 12, spireMat: MAT.SANDSTONE, bridgeMat: MAT.SANDSTONE },
    desert: { dome: 0.2, band: false, caves: 0.05, sp: [3, 2], r0: 1.6, r1: 2.4, h0: 7, h1: 12, spireMat: MAT.SANDSTONE, bridgeMat: MAT.SANDSTONE },
    volcanic: { dome: 0.8, band: false, caves: 0.07, sp: [3, 2], r0: 1.5, r1: 2.2, h0: 6, h1: 10, spireMat: MAT.BASALT, bridgeMat: MAT.BASALT }
  };

  /* Analytic ground height outside the lattice of a dry world (Step D): the same dunes as the lattice (no mesas this
   * far out; equal to the lattice's raw outer band on the border, D4; without edits). The render's far grid and
   * curtain, projectiles and the sim's ground beyond the border (W.far -> W.sample, D4) use it.
   * Valid for the last generated world; -1e9 when it is not dry. */
  G.far_height = function (x, z) {
    if (!W || !W.dry) return -1e9;
    const lod = sat((M.len2(x - 48, z - 48) - 90) / 130);           // 0 within 90 m of the centre (the lattice and its seam)
    return desertH(x, z, lod);
  };

  /* D5: the far ground's layering (dry worlds), for the cut face beyond the lattice: out[0] = top (= far_height),
   * out[1] = dune-sand thickness (desertH's sand: sandTop - bed). The materials rule (RULES.desert) puts SAND down to
   * sand + 0.45 below the top, SANDSTONE to 10 m, ROCK below, BEDROCK under y 1 — the same rule as inside, so the
   * strata continue across the border (the border columns are the raw function, stage 0). */
  G.far_layers = function (x, z, out) {
    if (!W || !W.dry) { out[0] = -1e9; out[1] = 0; return out; }
    const lod = sat((M.len2(x - 48, z - 48) - 90) / 130);
    out[0] = desertH(x, z, lod); out[1] = desertSand;
    return out;
  };
  G.SAND_EXTRA = 0.45; G.ROCK_DV = 10;   // (RULES.desert constants, shared with the far cut face)

  /* Resumable job so the platform layer can show a progress bar (C: WorldgenJob; worldgen_step()). */
  /* PoC "Terrain shape" (setup option). islands = the poc5 island (default); caverns = the underground map; hills = the
   * land rolls out almost to the map border (a thin sea ring stays for the far ocean); canyon = a winding gorge cut
   * across the land down below sea level (struct.js then spans it with a footbridge: PoC "Canyon and bridge").
   * 'random' picks one by seed. Own RNG (the layout stream is untouched). */
  const SHAPES = ['islands', 'hills', 'caverns', 'canyon'];
  G.shape_of = function (settings) {
    const s = settings.shape;
    if (SHAPES.indexOf(s) >= 0) return s;
    if (s === 'random') return SHAPES[(Math.imul(settings.seed | 0, 2246822519) >>> 9) % SHAPES.length];
    return 'islands';
  };
  function applyShape(shape) {
    const r = M.rng_make(((seed * 31 + 7) >>> 0) || 1), NC = NX * NZ;
    if (shape === 'hills') {
      const ph = M.rng_next(r) * 100;
      for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
        const x = i * H, z = k * H, e = Math.min(i, k, NX - 1 - i, NZ - 1 - k) * H;
        const roll = SEA + 2.5 + 7 * M.fbm2(x / 22 + ph, z / 22, seed + 11, 4) + 3 * M.sin(x / 13 + ph) * M.sin(z / 17);
        const c = k * NX + i, want = M.lerp(SEA - 3, roll, sm(M.clamp((e - 3) / 9, 0, 1)));
        if (want > hgt[c]) hgt[c] = M.lerp(hgt[c], want, 0.85);
      }
    } else if (shape === 'canyon') {
      // a gentle S-curve through the map centre at a random heading; U-shaped section 9-12 m wide down to SEA - 1.5
      const a = M.rng_next(r) * Math.PI, dx = M.cos(a), dz = M.sin(a), amp = 6 + M.rng_next(r) * 6, wl = 40 + M.rng_next(r) * 30, half = 4.5 + M.rng_next(r) * 1.5;
      for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
        const x = i * H - 48, z = k * H - 48, along = x * dx + z * dz, across = -x * dz + z * dx - amp * M.sin(along / wl * Math.PI * 2);
        const d = Math.abs(across), floor = SEA - 1.5, c = k * NX + i;
        if (d < half) hgt[c] = Math.min(hgt[c], floor + 0.6 * (d / half) * (d / half));
        else if (d < half + 6) hgt[c] = Math.min(hgt[c], M.lerp(floor + 0.6, hgt[c], sm((d - half) / 6) * 0.25 + 0.75 * M.pow((d - half) / 6, 0.5)));
      }
    }
  }
  G.begin = function (world, settings) {
    W = world; NX = W.NX; NY = W.NY; NZ = W.NZ; H = W.H;
    const biome = SPEC[settings.biome] ? settings.biome : 'temperate';
    G.shape = G.shape_of(settings);                                    // PoC "Terrain shape": islands | hills | caverns | canyon
    W.under = !!(settings.under && settings.under !== '0' && settings.under !== 'off') || G.shape === 'caverns';   // U: underground map (caves)
    W.dry = !W.under && !!(C.BIOMES.find(b => b.id === biome) || {}).dry;  // Step D: no sea, dunes to the horizon
    W.SEA = W.under ? -1 : W.dry ? C.DRY.SEA : W.SEA_WET; SEA = W.SEA;
    W.far = W.under ? UNDER_FAR : W.dry ? G.far_height : null;        // D4: the ground beyond the lattice (world.js W.sample); U: rock
    W.circ = W.dry ? { x: C.DRY.CX, z: C.DRY.CZ, r: C.DRY.LAT_R } : null;   // D6: ... beyond the disc LAT_R
    W.frz = null;                                                      // (frozen ring: set when generation ends)
    seed = (settings.seed | 0) * 131 + C.BIOMES.findIndex(b => b.id === biome) * 7;
    rng = M.rng_make(seed * 7919 + 13);
    const NC = NX * NZ;
    hgt = new Float32Array(NC); lavaZone = new Uint8Array(NC); canalD = null; extra = new Float32Array(NC);
    const ang = R() * M.TAU;
    F = { biome, ca: M.cos(ang), sa: M.sin(ang), volcano: null, volcanoes: [], canals: [], lavaInit: null, pockets: [], vents: [], spires: [], bridges: [], iceShelf: false };
    { // LS1: the island's shape (own rng: amplitudes of the k = 1..4 harmonics, phases; the volcano island varies less)
      const ir = M.rng_make((seed * 977 + 5) >>> 0 || 1), A = [0.1, 0.13, 0.08, 0.05];
      F.isl = { A: A.map(v => v * (0.5 + M.rng_next(ir))), P: [0, 1, 2, 3].map(() => M.rng_next(ir) * Math.PI * 2), k: biome === 'volcanic' ? 0.45 : 1 };
    }
    W.features = F; W.biome = biome;
    return { settings, biome, spec: SPEC[biome], stage: 0, k: 0, label: W.under ? 'Boring the caves' : 'Shaping the land', under: W.under };
  };
  const ROWS = 12;
  G.step = function (job) {
    const biome = job.biome, spec = job.spec, NC = NX * NZ;
    switch (job.stage) {
      case 0: { // heightfield (+ volcano and its canals) and landmarks
        if (job.under) { underPlan(biome); job.stage = 1; job.k = 0; job.label = 'Boring the caves'; return 0.06; }
        if (biome === 'volcanic') setupVolcanoes(job.settings);
        const hf = HEIGHT[biome];
        for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) hgt[k * NX + i] = hf(i * H, k * H, k * NX + i);
        if (biome === 'volcanic' && F.volcanoes.length) carveCanals();
        if (!W.dry && (G.shape === 'hills' || G.shape === 'canyon')) applyShape(G.shape);
        const raw = W.dry ? hgt.slice() : null;
        // no feature may be narrower than ~2 lattice cells (avoids one-column needles on terrace risers)
        { const bl = boxBlur(hgt, 0.5); for (let c = 0; c < NC; c++) hgt[c] = hgt[c] * 0.35 + bl[c] * 0.65; }
        // dry worlds (D4, circular since D6): the outer BORDER_BAND m of the disc LAT_R return to the raw dune
        // function, exactly far_height from its edge outward, so the lattice meets the analytic far dunes (render
        // grid, sim ground beyond the disc) without a step
        if (raw) for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) {
          const e = Math.min(C.DRY.LAT_R - M.len2(i * H - C.DRY.CX, k * H - C.DRY.CZ), Math.min(i, k, NX - 1 - i, NZ - 1 - k) * H);
          if (e < BORDER_BAND) { const c = k * NX + i; hgt[c] = e <= 0 ? raw[c] : M.lerp(raw[c], hgt[c], sm(e / BORDER_BAND)); }
        }
        // 1/|grad(h - y)|: turns h - y into an approximate signed distance (smooth meshes on steep slopes)
        ginv = new Float32Array(NC);
        for (let k = 0; k < NZ; k++) for (let i = 0; i < NX; i++) { const g = gradH(i, k); ginv[k * NX + i] = g[0] * g[0] + g[1] * g[1]; }
        { const bl = boxBlur(ginv, 1.5); for (let c = 0; c < NC; c++) ginv[c] = 1 / Math.sqrt(1 + bl[c]); }   // smooth, so neighbours agree
        landmarks(spec.sp[0], spec.sp[1], spec);
        job.stage = 1; job.k = 0; job.label = 'Filling the volume';
        return 0.06;
      }
      case 1: { // volume fill, a slab of rows per call
        if (job.under) { underFill(biome); job.k = NZ; despeckleAll(); job.stage = 2; job.label = 'Lava and veins'; return 0.56; }
        fill(spec, job.k, Math.min(NZ, job.k + ROWS)); job.k += ROWS;
        if (job.k >= NZ) { despeckleAll(); job.stage = 2; job.label = 'Lava, ice and veins'; }
        return 0.06 + 0.5 * Math.min(1, job.k / NZ);
      }
      case 2: {
        const bdef = C.BIOMES.find(b => b.id === biome);
        const set = job.settings.lava;
        job.lava = set === 'on' ? true : set === 'off' ? false : R() < bdef.lavaChance;
        // volcanic: 3-4 loose magma bodies (sills) + the conduit trees' own branch pockets
        if (job.lava) stampPockets(biome === 'volcanic' ? 3 + M.rng_int(rng, 2) : 1 + M.rng_int(rng, 2));
        if (job.lava && biome === 'volcanic') F.volcanoes.forEach((v, vi) => stampConduit(v, vi));
        if (biome === 'volcanic') placeFumaroles();
        if (biome === 'alpine' && !job.under) stampIceShelf();
        cliffMax = neighborhoodMax(2.5);
        if (biome === 'alpine') {
          const bl = boxBlur(hgt, 7); glacier = new Float32Array(NC);
          for (let c = 0; c < NC; c++) glacier[c] = (bl[c] - hgt[c] > 1.2 && hgt[c] > 6 && hgt[c] < 24) ? 1 : 0;
        }
        if (job.under) { underMaterials(biome); job.stage = 4; job.label = 'Checking structural support'; return 0.9; }
        surfaceLayers();
        job.stage = 3; job.k = 1; job.label = 'Laying down strata';
        return 0.6;
      }
      case 3: { // materials, slab by slab
        materials(RULES[biome], job.k, Math.min(NZ - 1, job.k + ROWS)); job.k += ROWS;
        if (job.k >= NZ - 1) { materialEdges(); job.stage = 4; job.label = 'Checking structural support'; }
        return 0.6 + 0.3 * Math.min(1, job.k / NZ);
      }
      case 4: { // nothing may start floating (buoyant ice touching the sea counts as supported)
        despeckleAll();
        if (SS.collapse) SS.collapse.remove_floating_all(W);
        F.lavaPresent = job.lava || biome === 'volcanic';
        if (W.dry) W.freeze_beyond(C.DRY.CX, C.DRY.CZ, C.DRY.EDIT_R);   // D6: only the disc is destructible
        hgt = ginv = lavaZone = canalD = extra = cliffMax = glacier = sLay = sNy = null;
        job.stage = 5; job.label = 'Done';
        return 1;
      }
      default: return 1;
    }
  };
  G.generate = function (world, settings) { const job = G.begin(world, settings); while (G.step(job) < 1); };
})(window.SS = window.SS || {});
