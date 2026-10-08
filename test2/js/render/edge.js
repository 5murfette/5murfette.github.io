/* render/edge.js — the section's material edge (Step E3, user request 2026-10-06).
 * While the section rotates, view.js draws the bright outline ribbon. Once rotation stops (S.lastRotate older than
 * SHOW_DELAY 0.45 s, no auto-align running) this module builds a procedural edge along the labelled chains of
 * SS.edge (sim/edge.js) and the outline cross-fades out over FADE 0.5 s:
 *   - a band per class with 4 rows: shadow feather inside the cut face, drape bottom / ink line, surface line, lit
 *     outer lip. Drape classes hang an opaque lip over the cut face (scalloped turf, snow cornice, glassy ice rim,
 *     hot lava contact); the others draw a thin dark ink line. Lip/drape thickness from 2D value noise in (s, y):
 *     smooth, crumbly, jagged (ridged) or stepped profiles;
 *   - items per class: grass tufts springing up (+ flowers; charring, glowing and wilting while on fire) with roots
 *     on the cut face, dry grass with seed heads, burnt stubble with embers and ash flecks, soil crumbs and rootlets
 *     hanging from soil ceilings, pebbles / moss / scree / teeth under rock ceilings, sandstone plates and ledges,
 *     ice crystals and icicles, snow glints, heat cracks under lava, ash flakes and twigs, seaweed under water.
 * Flat-ish geometry on the plane just in front of the cut face (t 0.012..0.08 m), built on the CPU from per-segment
 * seeded hashes: a segment's key is symmetric in its endpoints (world position) and its classes, so a crater only
 * regrows the segments it changed (births kept per key). Vertex shader: grow from a per-vertex birth time with a
 * spring overshoot (1 - e^-5x cos 8x), sway, ember/lava flicker, snow-glint twinkle. Two meshes: opaque items and
 * a translucent band + ice (MeshPhong, see material()). Rebuilt on a new section object (rotation stop, blasts,
 * world edits) and re-labelled every REFRESH 0.4 s when fire / water / lava changed (rebuilt if a label changed).
 * O2 (user: natural, antialiased, no sharp corners / sticks): stations at uniform arc length along each chain;
 * band normals from the chain's own tangent turned to the air by a density test (the sim's gradient normal is up to
 * 60° off on thin fins); per station a ±0.1 m class blend (5 taps); lip / drape offsets limited by curvature (no
 * bow-tie folds in hollows / on crests), by 45 % of the solid's thickness, both cone-filtered along the chain (no
 * one-station notches); lip profiles chipped (bilinear noise) or terraced with ramps instead of ridged beads /
 * floor() steps; lip >= 1.2 px and ink line >= 1.4 px at the build zoom (rebuild when the zoom changes > 1.4x); the
 * band's last pixel fades by fwidth of the distance to its outer edge (aEdg; AA also without MSAA). Items: loose
 * stones bedded and flat, 1-3 together, mostly in hollows (chain concavity); flakes lie along walls; chips under
 * ceilings wider than long; ice crystals short. Tool hooks: EV.dbgRows / EV.dbgItems arrays (tools/dev/o2/bandcheck).
 * API: init(scene, tx, Q), reset(S), frame(S, view) -> alpha (outline drawn with 1 - alpha), stats(), debug(). */
(function (SS) {
  'use strict';
  const T = THREE;
  const EV = SS.edgeView = { enabled: true };
  const SHOW_DELAY = 0.45, FADE = 0.5, REFRESH = 0.4;
  let Q = null, tx = null, meshO = null, meshT = null, dens = 1, step = 0.05, bseg = 3, K = null, FACE = null;
  const U = { uTime: { value: 0 }, uDir: { value: new T.Vector3(1, 0, 0) }, uWind: { value: 0 } };
  const st = { mpp: 0.018, zoomB: 19, sec: null, shown: false, showT: -99, births: new Map(), prev: null, refreshT: -99, vegVer: -1, waterVer: -1, lavaVer: -1,
    sig: null, builds: 0, refreshes: 0, buildMs: 0, count: {}, fresh: false, now: 0, biome: '' };

  /* ---------- vertex buffers (growable typed arrays) ---------- */
  function mkBuf() { return { nv: 0, ni: 0, cap: 0, icap: 0, pos: null, nrm: null, col: null, anc: null, ani: null, rgh: null, edg: null, idx: null }; }
  const BO = mkBuf(), BT = mkBuf();
  function reserve(b, nv, ni) {
    if (b.nv + nv > b.cap) {
      const c = Math.max(16384, (b.nv + nv) * 2), cp = (a, k) => { const n = new Float32Array(c * k); if (a) n.set(a.subarray(0, b.nv * k)); return n; };
      b.pos = cp(b.pos, 3); b.nrm = cp(b.nrm, 3); b.col = cp(b.col, 4); b.anc = cp(b.anc, 4); b.ani = cp(b.ani, 4); b.rgh = cp(b.rgh, 1); b.edg = cp(b.edg, 1); b.cap = c;
    }
    if (b.ni + ni > b.icap) { const c = Math.max(32768, (b.ni + ni) * 2), n = new Uint32Array(c); if (b.idx) n.set(b.idx.subarray(0, b.ni)); b.idx = n; b.icap = c; }
  }
  /* plane frame of the section being built: world = O + s·d + t·n (n = P.nrm, towards the camera); sd flips the
   * camera-facing part of the lighting normal to the sun's side, like the cap (terrain.js capN) */
  const F = { ox: 0, oz: 0, dx: 1, dz: 0, nx: 0, nz: 1, sd: 1 };
  /* the item being emitted: anchor (grow origin), birth, grow duration, phase, emissive, roughness */
  const cur = { s: 0, y: 0, t: 0, birth: 0, dur: 0.5, phase: 0, em: 0, rough: 0.9, sw: 0, edg: -1 };   // edg: m to the band's outer edge (AA fade), -1 = item
  function vtx(b, s, y, t, ns, ny, nt, c, a, sway) {
    const i = b.nv++, o = i * 3, q = i * 4;
    b.pos[o] = F.ox + s * F.dx + t * F.nx; b.pos[o + 1] = y; b.pos[o + 2] = F.oz + s * F.dz + t * F.nz;
    const k = nt * F.sd, wx = ns * F.dx + k * F.nx, wz = ns * F.dz + k * F.nz, l = Math.hypot(wx, ny, wz) || 1;
    b.nrm[o] = wx / l; b.nrm[o + 1] = ny / l; b.nrm[o + 2] = wz / l;
    b.col[q] = c[0]; b.col[q + 1] = c[1]; b.col[q + 2] = c[2]; b.col[q + 3] = a;
    b.anc[q] = F.ox + cur.s * F.dx + cur.t * F.nx; b.anc[q + 1] = cur.y; b.anc[q + 2] = F.oz + cur.s * F.dz + cur.t * F.nz; b.anc[q + 3] = cur.birth;
    b.ani[q] = sway; b.ani[q + 1] = cur.em; b.ani[q + 2] = cur.phase; b.ani[q + 3] = cur.dur;
    b.rgh[i] = cur.rough; b.edg[i] = cur.edg;
    return i;
  }
  function tri(b, i, j, k) { b.idx[b.ni++] = i; b.idx[b.ni++] = j; b.idx[b.ni++] = k; }

  /* ---------- hashing / seeded random / value noise (render-side, stable per segment) ---------- */
  function hi(a, b) {
    let h = Math.imul(a ^ 0x27d4eb2d, 0x9E3779B1) ^ Math.imul((b | 0) + 0x165667b1, 0x85EBCA77);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return h | 0;
  }
  let rs = 1;
  function rnd() { rs = (rs + 0x6D2B79F5) | 0; let t = Math.imul(rs ^ (rs >>> 15), 1 | rs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  const lat = (i, j) => (hi(i, j) >>> 0) / 4294967296;
  function vn2(x, y) {
    const i = Math.floor(x), j = Math.floor(y); let u = x - i, v = y - j; u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v);
    const a = lat(i, j), b = lat(i + 1, j), c = lat(i, j + 1), d = lat(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  // value noise with plain bilinear interpolation: straight runs meeting at shallow corners (a chipped edge)
  function vlin(x, y) {
    const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j;
    const a = lat(i, j), b = lat(i + 1, j), c = lat(i, j + 1), d = lat(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const cnt = x => { const v = x * dens; const n = Math.floor(v); return rnd() < v - n ? n + 1 : n; };

  /* ---------- colours (linear) ---------- */
  const PAL = {};
  const TC = [0, 0, 0], TC2 = [0, 0, 0];
  const sc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
  const mixc = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  function mixTo(o, a, b, f) { o[0] = a[0] + (b[0] - a[0]) * f; o[1] = a[1] + (b[1] - a[1]) * f; o[2] = a[2] + (b[2] - a[2]) * f; return o; }
  function scTo(o, a, k) { o[0] = a[0] * k; o[1] = a[1] * k; o[2] = a[2] * k; return o; }
  function palette(look) {
    const tc = new T.Color(), tint = SS.terrain.uniforms.uMatTint.value;
    const avg = layer => { const a = tx.matAvg[layer] || [0.5, 0.5, 0.5]; tc.setRGB(a[0], a[1], a[2], T.SRGBColorSpace); const tn = tint[layer] || { x: 1, y: 1, z: 1 }; return [tc.r * tn.x, tc.g * tn.y, tc.b * tn.z]; };
    const lin = hex => { tc.set(hex); return [tc.r, tc.g, tc.b]; };
    PAL.rock = avg(1); PAL.soil = avg(2); PAL.sand = avg(3); PAL.sst = avg(4); PAL.snow = avg(5); PAL.ice = avg(6);
    PAL.basalt = avg(7); PAL.crust = avg(9); PAL.ash = avg(10); PAL.scree = avg(11);
    PAL.gBase = lin(look.gBase); PAL.gTip = lin(look.gTip); PAL.gDry = lin(look.gDry);
    PAL.root = mixc(PAL.soil, [0.5, 0.4, 0.28], 0.75);
    PAL.char = [0.022, 0.019, 0.017]; PAL.ember = [1.0, 0.36, 0.06];
    PAL.snowW = mixc(PAL.snow, [0.92, 0.95, 1.0], 0.6); PAL.snowB = [0.55, 0.64, 0.8];
    PAL.iceHi = [0.82, 0.94, 1.0]; PAL.iceLo = [0.42, 0.66, 0.86];
    const B = PAL.band = [];
    // fe = shadow feather inside the cut face (alpha 0 at its end), dr = drape bottom / ink line, mid = surface line,
    // out = lit outer lip
    const set = (k, fe, dr, mid, out, em, rough) => { B[k] = { fe, dr, mid, out, em: em || 0, rough: rough === undefined ? 0.92 : rough }; };
    const gMid = mixc(PAL.gBase, PAL.gTip, 0.3), gOut = mixc(PAL.gBase, PAL.gTip, 0.6), gDr = mixc(PAL.gBase, PAL.gTip, 0.12);
    const dMid = mixc(PAL.gBase, PAL.gDry, 0.55), dOut = sc(PAL.gDry, 0.9), dDr = mixc(PAL.gBase, PAL.gDry, 0.3);
    set(K.GRASS, sc(PAL.soil, 0.25), gDr, gMid, gOut);
    set(K.DRY, sc(PAL.soil, 0.25), dDr, dMid, dOut);
    set(K.BURNT, sc(PAL.soil, 0.2), PAL.char, sc(PAL.char, 1.5), sc(PAL.char, 2.6));
    set(K.SOIL, sc(PAL.soil, 0.2), sc(PAL.soil, 0.3), sc(PAL.soil, 0.6), sc(PAL.soil, 1.1));
    set(K.ROCK, sc(PAL.rock, 0.15), sc(PAL.rock, 0.25), sc(PAL.rock, 0.6), sc(PAL.rock, 1.45));
    set(K.NONE, sc(PAL.rock, 0.15), sc(PAL.rock, 0.25), sc(PAL.rock, 0.6), sc(PAL.rock, 1.45));
    // (user 2026-10-08: on the pale desert the dark sand feather / ink read as a shadow: a light, warm edge)
    set(K.SAND, sc(PAL.sand, 0.8), sc(PAL.sand, 0.86), sc(PAL.sand, 0.96), sc(PAL.sand, 1.15));
    set(K.SNOW, sc(PAL.snowB, 0.45), PAL.snowB, mixc(PAL.snowB, PAL.snowW, 0.65), PAL.snowW, 0, 0.55);
    set(K.ICE, sc(PAL.ice, 0.35), PAL.iceLo, mixc(PAL.iceLo, PAL.iceHi, 0.5), sc(PAL.iceHi, 1.1), 0.05, 0.12);
    set(K.LAVA, [0.15, 0.02, 0.005], [0.4, 0.06, 0.01], [0.5, 0.1, 0.015], [0.55, 0.16, 0.02], 2.0, 0.6);   // dark diffuse (the lava light is strong), emission carries the glow
    set(K.BASALT, sc(PAL.basalt, 0.15), sc(PAL.basalt, 0.25), sc(PAL.basalt, 0.6), sc(PAL.basalt, 1.6), 0, 0.7);
    set(K.ASH, sc(PAL.ash, 0.3), sc(PAL.ash, 0.45), sc(PAL.ash, 0.75), sc(PAL.ash, 1.3));
    set(K.SCREE, sc(PAL.scree, 0.15), sc(PAL.scree, 0.25), sc(PAL.scree, 0.6), sc(PAL.scree, 1.35));
    set(K.SANDSTONE, sc(PAL.sst, 0.55), sc(PAL.sst, 0.62), sc(PAL.sst, 0.8), sc(PAL.sst, 1.3));
  }
  /* band per class: outer lip [min, max, noise freq 1/m, profile 0 smooth / 1 crumbly / 2 jagged / 3 stepped],
   * drape over the cut face [min, max, freq, profile, alpha at its bottom], shadow feather below it (m).
   * Drape classes (turf, snow cornice, glassy ice, molten rim) hang an opaque lip over the cut face; the others
   * draw a thin dark ink line that feathers into it. */
  const BANDT = [];
  function bandTable() {
    const s = (k, lip, dr, fe) => { BANDT[k] = { lip, dr, fe, ink: dr === ink }; };
    const ink = [0.008, 0.016, 8, 0, 0.85];
    s(K.NONE, [0.012, 0.042, 4.5, 2], ink, 0.04); s(K.ROCK, [0.012, 0.042, 4.5, 2], ink, 0.04);
    s(K.GRASS, [0.015, 0.035, 9, 0], [0.03, 0.11, 16, 2, 1], 0.05);
    s(K.DRY, [0.012, 0.03, 9, 0], [0.025, 0.09, 14, 2, 1], 0.05);
    s(K.BURNT, [0.01, 0.025, 9, 1], [0.012, 0.045, 12, 1, 1], 0.04);
    s(K.SOIL, [0.01, 0.035, 8, 1], ink, 0.04);
    s(K.SAND, [0.015, 0.035, 3.5, 0], ink, 0.035);
    s(K.SNOW, [0.08, 0.22, 1.2, 0], [0.025, 0.08, 3, 0, 1], 0.04);
    s(K.ICE, [0.02, 0.05, 5, 1], [0.02, 0.05, 9, 2, 0.75], 0.03);
    s(K.LAVA, [0.04, 0.09, 2.5, 0], [0.03, 0.07, 5, 0, 1], 0.05);
    s(K.BASALT, [0.012, 0.045, 4.5, 2], ink, 0.04);
    s(K.ASH, [0.02, 0.05, 3, 0], ink, 0.035);
    s(K.SCREE, [0.012, 0.04, 7, 1], ink, 0.035);
    s(K.SANDSTONE, [0.012, 0.05, 3.2, 3], ink, 0.04);
  }
  const mkBP = () => ({ to: 0, ti: 0, fe: 0, a1: 1, cfe: [0, 0, 0], cdr: [0, 0, 0], cmid: [0, 0, 0], cout: [0, 0, 0], em: 0, rough: 0.9 });
  const BP = mkBP(), BQ = mkBP();
  function prof(p, fq, s, y, ofs) {
    const nz = vn2(s * fq + ofs, y * fq);
    switch (p) {
      case 1: return 0.6 * nz + 0.4 * vn2(s * fq * 2.7 + 11.3 + ofs, y * fq * 2.7);
      // O2: chipped (rock): faceted runs; the old ridged |2n - 1| profile made periodic round bumps (beads)
      case 2: return 0.65 * vlin(s * fq + ofs, y * fq) + 0.35 * vlin(s * fq * 2.3 + 5.7 + ofs, y * fq * 2.3);
      // terraced (sandstone): flat steps joined by short ramps (the old floor() jumped: square corners in the lip)
      case 3: { const z = nz * 3, k = Math.floor(z), fr = z - k, r = Math.min(1, Math.max(0, (fr - 0.35) / 0.3)); return Math.min(1, (k + r * r * (3 - 2 * r)) / 3); }
      default: return nz;
    }
  }
  function bandAt(o, cls, face, wet, s, y) {
    const bt = BANDT[cls] || BANDT[K.ROCK], L = bt.lip, D = bt.dr;
    let to = L[0] + (L[1] - L[0]) * prof(L[3], L[2], s, y, 0), ti = D[0] + (D[1] - D[0]) * prof(D[3], D[2], s, y, 37.1);
    if (face === FACE.DOWN) { to *= cls === K.SNOW ? 0.12 : 0.35; ti *= 0.5; }
    else if (face === FACE.WALL && cls === K.SNOW) to *= 0.35;
    const pc = PAL.band[cls] || PAL.band[K.ROCK], wk = wet ? 0.55 : 1;
    o.to = wet ? to * 0.7 : to; o.ti = ti; o.fe = bt.fe; o.a1 = D[4];
    // never thinner than ~1.2 px (lip) / 1.4 px (ink line) at the zoom of the build: sub-pixel lines crawl
    o.to = Math.max(o.to, st.mpp * 1.2); if (bt.ink) o.ti = Math.max(o.ti, st.mpp * 1.4);
    scTo(o.cfe, pc.fe, wk); scTo(o.cdr, pc.dr, wk); scTo(o.cmid, pc.mid, wk); scTo(o.cout, pc.out, wk);
    o.em = wet ? 0 : pc.em; o.rough = pc.rough;
  }

  /* ---------- the section density (roots stay inside the solid, out of rock) ---------- */
  let SEC = null;
  function sdens(s, y) {
    const H = SS.world.H, fi = (s - SEC.s0) / H, fj = y / H, i = Math.floor(fi), j = Math.floor(fj);
    if (i < 0 || j < 0 || i >= SEC.ns - 1 || j >= SEC.ny - 1) return -1;
    const u = fi - i, v = fj - j, V = SEC.V, o = j * SEC.ns + i;
    return (V[o] * (1 - u) + V[o + 1] * u) * (1 - v) + (V[o + SEC.ns] * (1 - u) + V[o + SEC.ns + 1] * u) * v;
  }
  function soft(s, y) {
    const H = SS.world.H, i = Math.round((s - SEC.s0) / H), j = Math.round(y / H);
    if (i < 0 || j < 0 || i >= SEC.ns || j >= SEC.ny) return false;
    const m = SEC.M[j * SEC.ns + i], MT = SS.CFG.MAT;
    return m === MT.SOIL || m === MT.SAND || m === MT.ASH || m === MT.SCREE || m === 0;
  }

  /* ---------- primitives (plane coordinates s, y, t; colours linear) ---------- */
  const CB0 = [0, 0, 0], CB1 = [0, 0, 0], CB2 = [0, 0, 0];
  const kount = name => { st.count[name] = (st.count[name] || 0) + 1; };
  // curved tapering blade from (s, y) along unit (ds, dy): height h, base width w, bend = sideways tip offset (m);
  // swayK = sway per m of height at the tip; emTip = emissive added towards the tip (embers)
  function blade(b, s, y, t, ds, dy, h, w, bend, c0, c1, n, swayK, emTip) {
    const ps = dy, py = -ds, em0 = cur.em;
    reserve(b, n * 2 + 1, n * 6);
    let pl = -1, pr = -1;
    for (let k = 0; k <= n; k++) {
      const u = k / n, cs = s + ds * h * u + ps * bend * u * u, cy = y + dy * h * u + py * bend * u * u;
      mixTo(TC, c0, c1, u);
      const sw = swayK * u * u * h;
      cur.em = em0 + emTip * u * u;
      if (k === n) { const tp = vtx(b, cs, cy, t, 0, 0.3, 1, TC, 1, sw); tri(b, pl, pr, tp); break; }
      const hw = w * 0.5 * (1 - 0.85 * u);
      const L = vtx(b, cs - ps * hw, cy - py * hw, t, -ps * 0.5, -py * 0.5 + 0.15, 0.85, TC, 1, sw);
      const R = vtx(b, cs + ps * hw, cy + py * hw, t, ps * 0.5, py * 0.5 + 0.15, 0.85, TC, 1, sw);
      if (k > 0) { tri(b, pl, pr, R); tri(b, pl, R, L); }
      pl = L; pr = R;
    }
    cur.em = em0;
  }
  // ribbon along the polyline RP[0 .. np-1] (roots, rootlets, twigs)
  const RP = new Float32Array(64);
  function ribbon(b, np, t, w0, w1, c0, c1, swayK) {
    reserve(b, np * 2, np * 6);
    let pl = -1, pr = -1;
    for (let k = 0; k < np; k++) {
      const a = Math.max(0, k - 1), c = Math.min(np - 1, k + 1);
      let ds = RP[c * 2] - RP[a * 2], dy = RP[c * 2 + 1] - RP[a * 2 + 1]; const l = Math.hypot(ds, dy) || 1; ds /= l; dy /= l;
      const u = k / (np - 1), hw = 0.5 * (w0 + (w1 - w0) * u), ps = dy, py = -ds;
      mixTo(TC, c0, c1, u);
      const sw = swayK * u * u;
      const L = vtx(b, RP[k * 2] - ps * hw, RP[k * 2 + 1] - py * hw, t, -ps * 0.4, -py * 0.4, 0.9, TC, 1, sw);
      const R = vtx(b, RP[k * 2] + ps * hw, RP[k * 2 + 1] + py * hw, t, ps * 0.4, py * 0.4, 0.9, TC, 1, sw);
      if (k > 0) { tri(b, pl, pr, R); tri(b, pl, R, L); }
      pl = L; pr = R;
    }
  }
  // domed polygon (pebble, clod, crust plate, bubble, petal): rx along the tangent of (ns, ny), ry along (ns, ny)
  function pebble(b, s, y, t, ns, ny, rx, ry, n, jit, cTop, cBot, alpha) {
    if (EV.dbgItems) EV.dbgItems.push(['pebble', rx, ry, (s - cur.s) * ns + (y - cur.y) * ny, P.cls]);
    const ts = ny, ty = -ns;
    reserve(b, n + 1, n * 3);
    mixTo(TC2, cTop, cBot, 0.3);
    const c = vtx(b, s, y, t + 0.003, 0, 0.25, 1, TC2, alpha, cur.sw);
    const a0 = rnd() * 6.283;
    for (let k = 0; k < n; k++) {
      const a = a0 + (k + (rnd() - 0.5) * jit * 0.6) / n * 6.283, r = 1 - jit * 0.4 * rnd();
      const lx = Math.cos(a) * rx * r, ly = Math.sin(a) * ry * r;
      const ps = lx * ts + ly * ns, py = lx * ty + ly * ny, pl = Math.hypot(ps, py) || 1;
      mixTo(TC, cBot, cTop, 0.5 + 0.5 * py / pl);
      vtx(b, s + ps, y + py, t, ps / pl * 0.8, py / pl * 0.8, 0.6, TC, alpha, cur.sw);
    }
    for (let k = 0; k < n; k++) tri(b, c, c + 1 + k, c + 1 + (k + 1) % n);
  }
  // flat plate centred at (s, y) along axis (ax, ay): length len, thickness th, lit top face (sandstone)
  function plate(b, s, y, t, ax, ay, len, th, cTop, cBot) {
    if (EV.dbgItems) EV.dbgItems.push(['plate', len, th, Math.abs(ax * P.ns + ay * P.ny)]);
    let px = -ay, py = ax; if (py < 0) { px = -px; py = -py; }
    reserve(b, 6, 12);
    const hl = len * 0.5, ht = th * 0.5, i0 = b.nv;
    for (let r = 0; r < 3; r++) {
      const v = r === 0 ? -ht : r === 1 ? ht * 0.25 : ht, w = r === 2 ? hl * 0.9 : hl, nk = r === 0 ? -0.6 : r === 2 ? 0.7 : 0;
      mixTo(TC, cBot, cTop, r / 2);
      vtx(b, s - ax * w + px * v, y - ay * w + py * v, t, px * nk - ax * 0.3, py * nk - ay * 0.3, 0.8, TC, 1, 0);
      vtx(b, s + ax * w + px * v, y + ay * w + py * v, t, px * nk + ax * 0.3, py * nk + ay * 0.3, 0.8, TC, 1, 0);
    }
    for (let r = 0; r < 2; r++) { const o = i0 + r * 2; tri(b, o, o + 1, o + 3); tri(b, o, o + 3, o + 2); }
  }
  // two-facet crystal / tooth from (s, y) along (ds, dy)
  function shard(b, s, y, t, ds, dy, len, w, cA, cB, alpha) {
    if (EV.dbgItems) EV.dbgItems.push(['shard', len, w, P.cls]);
    const ps = dy, py = -ds, bs = s - ds * 0.012, by = y - dy * 0.012, hw = w * 0.5;
    reserve(b, 6, 6);
    const a0 = vtx(b, bs - ps * hw, by - py * hw, t, -ps * 0.7, -py * 0.7, 0.7, cA, alpha, 0);
    const a1 = vtx(b, bs, by, t + 0.004, -ps * 0.5, -py * 0.5, 0.85, cA, alpha, 0);
    const a2 = vtx(b, s + ds * len, y + dy * len, t, ds * 0.3, dy * 0.3, 0.9, cA, alpha, 0);
    tri(b, a0, a1, a2);
    const b0 = vtx(b, bs + ps * hw, by + py * hw, t, ps * 0.7, py * 0.7, 0.7, cB, alpha, 0);
    const b1 = vtx(b, bs, by, t + 0.004, ps * 0.5, py * 0.5, 0.85, cB, alpha, 0);
    const b2 = vtx(b, s + ds * len, y + dy * len, t, ds * 0.3, dy * 0.3, 0.9, cB, alpha, 0);
    tri(b, b1, b0, b2);
  }
  // hanging icicle (translucent): glassy centre ridge, tapering to a drip point
  function icicle(b, s, y, t, len, w) {
    reserve(b, 10, 30);
    const wob = (rnd() - 0.5) * 0.3 * w, rows = [0, 0.38, 0.72], first = b.nv;
    for (let r = 0; r < 3; r++) {
      const u = rows[r], hw = w * 0.5 * (1 - u * 0.78), cs = s + wob * u * u, cy = y + 0.012 - len * u, a = 0.92 - 0.2 * u;
      mixTo(TC, PAL.iceHi, PAL.iceLo, u);
      vtx(b, cs - hw, cy, t, -0.7, 0, 0.7, TC, a * 0.8, 0);
      mixTo(TC2, PAL.iceHi, [1, 1, 1], 0.5 - 0.3 * u);
      vtx(b, cs + hw * 0.2, cy, t + 0.004, 0.1, 0.1, 1, TC2, a, 0);
      vtx(b, cs + hw, cy, t, 0.7, 0, 0.7, TC, a * 0.8, 0);
    }
    const tip = vtx(b, s + wob, y + 0.012 - len, t, 0, -0.4, 0.9, PAL.iceLo, 0.6, 0);
    for (let r = 0; r < 2; r++) { const o = first + r * 3, p = o + 3; tri(b, o, o + 1, p + 1); tri(b, o, p + 1, p); tri(b, o + 1, o + 2, p + 2); tri(b, o + 1, p + 2, p + 1); }
    const o = first + 6; tri(b, o, o + 1, tip); tri(b, o + 1, o + 2, tip);
  }
  // 4-point twinkle star (snow glint; cur.em < 0 = twinkle mode in the shader)
  const WHITE = [1, 1, 1];
  function glint(b, s, y, t, r) {
    reserve(b, 9, 24);
    const c = vtx(b, s, y, t, 0, 0.3, 1, WHITE, 1, 0);
    for (let k = 0; k < 8; k++) { const a = k / 8 * 6.283 + 0.4, rr = k & 1 ? r * 0.18 : r; vtx(b, s + Math.cos(a) * rr, y + Math.sin(a) * rr, t, 0, 0.3, 1, PAL.snowW, 1, 0); }
    for (let k = 0; k < 8; k++) tri(b, c, c + 1 + k, c + 1 + (k + 1) % 8);
  }

  /* ---------- items per class ---------- */
  const P = { conc: 0, sA: 0, yA: 0, sB: 0, yB: 0, nsA: 0, nyA: 1, nsB: 0, nyB: 1, s: 0, y: 0, ns: 0, ny: 1, len: 0, cls: 0, face: 0, wet: 0, cover: 0, dry: 0, chr: 0, burn: 0, birth: 0 };
  function at(f) {
    P.s = P.sA + (P.sB - P.sA) * f; P.y = P.yA + (P.yB - P.yA) * f;
    const ns = P.nsA + (P.nsB - P.nsA) * f, ny = P.nyA + (P.nyB - P.nyA) * f, l = Math.hypot(ns, ny) || 1;
    P.ns = ns / l; P.ny = ny / l;
  }
  function anchor(s, y, t, jit, dur) { cur.s = s; cur.y = y; cur.t = t; cur.birth = P.birth + rnd() * jit; cur.dur = dur; cur.phase = rnd(); cur.em = 0; cur.rough = 0.9; cur.sw = 0; }
  const FLOWERS = {
    temperate: [[0.92, 0.9, 0.82], [0.95, 0.72, 0.08], [0.42, 0.28, 0.72], [0.88, 0.42, 0.58]],
    alpine: [[0.92, 0.92, 0.95], [0.38, 0.45, 0.9], [0.5, 0.3, 0.75]], canyon: [[0.95, 0.6, 0.1], [0.95, 0.8, 0.2]], desert: [[0.95, 0.75, 0.2]]
  };
  const ROOT_D = 0.012;   // section density ~0.7-1.2 per metre of depth near the surface: ~1.5 cm inside
  // root walk on the cut face from (s, y) along (ds, dy): stays in soft solid ground (any solid when anyMat, for
  // heat cracks under lava); colours c0 -> c1; returns points in RP
  function rootWalk(s, y, ds, dy, len, w0, c0, c1, anyMat) {
    if (sdens(s, y) < ROOT_D || (!anyMat && !soft(s, y))) return 0;
    const n = 6, stp = len / n;
    RP[0] = s; RP[1] = y; let np = 1;
    for (let q = 0; q < n; q++) {
      const a = (rnd() - 0.5) * 0.9, ca = Math.cos(a), sa = Math.sin(a);
      let es = ds * ca - dy * sa, ey = ds * sa + dy * ca - 0.15; const l = Math.hypot(es, ey) || 1; ds = es / l; dy = ey / l;
      const s2 = s + ds * stp, y2 = y + dy * stp;
      if (sdens(s2, y2) < ROOT_D || (!anyMat && !soft(s2, y2))) break;
      s = s2; y = y2; RP[np * 2] = s; RP[np * 2 + 1] = y; np++;
    }
    if (np < 3) return 0;
    cur.s = RP[0]; cur.y = RP[1]; cur.t = 0.012;
    ribbon(BO, np, 0.012, w0, w0 * 0.3, c0, c1, 0);
    kount(anyMat ? 'vein' : 'root');
    return np;
  }
  function roots(s, y, ns, ny, k) {
    const b0 = cur.birth;
    cur.birth = b0 + 0.2 + rnd() * 0.15; cur.dur = 0.9; cur.em = 0; cur.sw = 0;
    scTo(CB2, PAL.root, 0.7);
    let ds = -ns * 0.5, dy = -ny * 0.5 - 0.5; const l = Math.hypot(ds, dy) || 1; ds /= l; dy /= l;
    const np = rootWalk(s - ns * 0.03, y - ny * 0.03, ds, dy, (0.15 + rnd() * 0.3) * k, 0.03, PAL.root, CB2, false);
    if (np > 3 && rnd() < 0.5) {
      const bs = RP[4], by = RP[5], sgn = rnd() < 0.5 ? -1 : 1;
      rootWalk(bs, by, ds * 0.5 + sgn * 0.8, dy * 0.5 - 0.3, (0.07 + rnd() * 0.1) * k, 0.018, PAL.root, CB2, false);
    }
    cur.birth = b0;
  }
  function tuft(f, dry) {
    at(f);
    const cov = P.cover / 255, dr = P.dry / 255, t = 0.025 + rnd() * 0.05, nb = dry ? 2 + (rnd() * 4 | 0) : 3 + (rnd() * 4 | 0);
    let gs = P.ns * 0.35, gy = 0.65 + Math.max(0, P.ny) * 0.35; const gl = Math.hypot(gs, gy); gs /= gl; gy /= gl;
    const hb = (dry ? 0.1 + rnd() * 0.18 : 0.14 + rnd() * 0.22) * (0.6 + 0.4 * cov);
    const dryness = dry ? 0.75 + 0.25 * dr : Math.max(0, Math.min(1, (dr - 0.35) / 0.45)) * 0.8;
    const burning = P.burn / 255, ch = P.chr / 255;   // on fire: blades char, wilt and glow at the tips
    anchor(P.s, P.y - 0.012, t, 0.15, dry ? 0.6 : 0.75);
    for (let k = 0; k < nb; k++) {
      const ang = (rnd() - 0.5) * (dry ? 1.3 : 1.0), ca = Math.cos(ang), sa = Math.sin(ang);
      const ds = gs * ca - gy * sa, dy = gs * sa + gy * ca, h = hb * (0.6 + 0.6 * rnd()), w = 0.024 + rnd() * 0.014;
      const bend = (ang * 0.6 + (rnd() - 0.5) * (dry ? 0.5 : 0.3)) * h, v = 0.85 + rnd() * 0.3;
      scTo(CB0, PAL.gBase, 0.75 * v); mixTo(CB1, PAL.gTip, PAL.gDry, dryness); scTo(CB1, CB1, v * 1.1);
      const bs = P.s + (rnd() - 0.5) * 0.035, bt = t + (rnd() - 0.5) * 0.012;
      let emTip = 0, hh = h;
      if (burning > 0.02 || ch > 0.1) {
        const k = Math.min(1, ch + burning);
        mixTo(CB0, CB0, PAL.char, k); mixTo(CB1, CB1, PAL.char, k * 0.8);
        if (burning > 0.02 && rnd() < 0.7) { CB1[0] = PAL.ember[0]; CB1[1] = PAL.ember[1]; CB1[2] = PAL.ember[2]; emTip = 3.0 * Math.min(1, burning * 2); }
        hh = h * (1 - 0.35 * k);
      }
      blade(BO, bs, P.y - 0.012, bt, ds, dy, hh, w, bend * (1 + burning), CB0, CB1, bseg, 0.14, emTip);
      kount('blade');
      if (dry && rnd() < 0.2) {          // seed head on the tip
        const hs = bs + ds * h + dy * bend, hy = P.y - 0.012 + dy * h - ds * bend;
        cur.sw = 0.14 * h; scTo(CB0, PAL.gDry, 0.8);
        pebble(BO, hs, hy, bt, ds, dy, 0.008, 0.022, 5, 0.3, PAL.gDry, CB0, 1); cur.sw = 0;
        kount('seed');
      }
    }
    const fl = FLOWERS[st.biome];
    if (!dry && fl && rnd() < 0.06) {
      const h = hb * 1.25 + 0.04, ds = gs * 0.9, dy = gy, bend = (rnd() - 0.5) * 0.04;
      scTo(CB0, PAL.gBase, 0.8); scTo(CB1, PAL.gTip, 0.8);
      blade(BO, P.s, P.y - 0.012, t + 0.01, ds, dy, h, 0.01, bend, CB0, CB1, 2, 0.14, 0);
      const hs = P.s + ds * h + dy * bend, hy = P.y - 0.012 + dy * h - ds * bend, col = fl[rnd() * fl.length | 0];
      cur.sw = 0.14 * h; scTo(CB2, col, 0.6);
      for (let k = 0; k < 5; k++) { const a = k / 5 * 6.283 + rnd(); pebble(BO, hs + Math.cos(a) * 0.017, hy + Math.sin(a) * 0.017, t + 0.012, Math.cos(a), Math.sin(a), 0.011, 0.016, 5, 0.2, col, CB2, 1); }
      pebble(BO, hs, hy, t + 0.016, 0, 1, 0.008, 0.008, 5, 0.1, [0.95, 0.8, 0.15], [0.6, 0.45, 0.05], 1);
      cur.sw = 0; kount('flower');
    }
    if (rnd() < (dry ? 0.35 : 0.6)) roots(P.s, P.y, P.ns, P.ny, dry ? 0.7 : 1);
  }
  function stubble(f) {
    at(f);
    const t = 0.025 + rnd() * 0.04, n = 2 + (rnd() * 3 | 0), burning = P.burn / 255;
    anchor(P.s, P.y - 0.008, t, 0.1, 0.4);
    for (let k = 0; k < n; k++) {
      const ang = (rnd() - 0.5) * 0.7, ds = P.ns * 0.3 + Math.sin(ang), dy = Math.max(0.3, P.ny) + 0.4, l = Math.hypot(ds, dy);
      const glow = burning > 0.02 && rnd() < 0.6;
      blade(BO, P.s + (rnd() - 0.5) * 0.03, P.y - 0.008, t, ds / l, dy / l, 0.03 + rnd() * 0.06, 0.012, (rnd() - 0.5) * 0.01, PAL.char, glow ? PAL.ember : sc(PAL.char, 2.2), 1, 0.02, glow ? 3.0 * Math.min(1, burning * 2) : 0);
      kount('stubble');
    }
    if (rnd() < 0.15) roots(P.s, P.y, P.ns, P.ny, 0.6);
  }
  function half(f0) {
    const L = P.len * 0.5, c = P.cls, down = P.face === FACE.DOWN, up = P.face === FACE.UP, bi = st.biome;
    let n;
    if (P.wet) {
      if ((c === K.SAND || c === K.SOIL || c === K.SCREE) && !down && bi !== 'alpine' && bi !== 'volcanic') {
        n = cnt(1.4 * L);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y - 0.01, 0.03 + rnd() * 0.03, 0.15, 0.8);
          const h = 0.15 + rnd() * 0.27, v = 0.8 + rnd() * 0.4;
          blade(BO, P.s, P.y - 0.01, cur.t, P.ns * 0.3, 0.95, h, 0.03, (rnd() - 0.5) * 0.6 * h, sc([0.06, 0.1, 0.03], v), sc([0.22, 0.3, 0.08], v), bseg, 0.35, 0);
          kount('weed');
        }
      }
      if (c === K.ROCK || c === K.SCREE || c === K.BASALT) {
        const base = c === K.BASALT ? PAL.basalt : c === K.SCREE ? PAL.scree : PAL.rock;
        n = cnt(1.0 * L);
        for (let i = 0; i < n; i++) { at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.035, 0.1, 0.4); const ry = 0.012 + rnd() * 0.022; pebble(BO, P.s - P.ns * ry * 0.15, P.y - P.ny * ry * 0.15, 0.035, P.ns, P.ny, ry * 1.5, ry, 6, 0.6, sc(base, 0.7), sc(base, 0.25), 1); kount('pebble'); }
      }
      return;
    }
    switch (c) {
      case K.GRASS: case K.DRY: {
        n = cnt((c === K.GRASS ? 18 : 13) * L * (0.4 + 0.6 * P.cover / 255) * (down ? 0 : 1));
        for (let i = 0; i < n; i++) tuft(f0 + rnd() * 0.5, c === K.DRY);
        break;
      }
      case K.BURNT: {
        n = cnt(10 * L);
        for (let i = 0; i < n; i++) stubble(f0 + rnd() * 0.5);
        const burning = P.burn / 255;
        n = cnt(4 * L + 10 * L * burning);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.035, 0.1, 0.3);
          const r = 0.006 + rnd() * 0.01, hot = burning > 0.02 && rnd() < 0.7;
          if (hot) cur.em = 2.5;
          pebble(BO, P.s + P.ns * r, P.y + P.ny * r, 0.035, P.ns, P.ny, r, r * 0.8, 4, 0.5, hot ? PAL.ember : sc(PAL.ash, 1.4), hot ? PAL.ember : sc(PAL.ash, 0.8), 1);
          kount(hot ? 'ember' : 'flake');
        }
        break;
      }
      case K.SOIL: {
        if (down) {                      // rootlets hanging from soil ceilings
          n = cnt(2.2 * L);
          for (let i = 0; i < n; i++) {
            at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.015, 0.2, 0.9);
            let s = P.s, y = P.y + 0.01, ds = 0, np = 1; const stp = (0.06 + rnd() * 0.16) / 5;
            RP[0] = s; RP[1] = y;
            for (let q = 0; q < 5; q++) { ds = ds * 0.6 + (rnd() - 0.5) * 0.9; s += ds * stp; y -= stp; if (sdens(s, y) > 0) break; RP[np * 2] = s; RP[np * 2 + 1] = y; np++; }
            if (np >= 3) { scTo(CB2, PAL.root, 0.6); ribbon(BO, np, 0.015, 0.016, 0.006, PAL.root, CB2, 0.05); kount('rootlet'); }
          }
          break;
        }
        n = cnt(9 * L);
        scTo(CB0, PAL.soil, 1.2); scTo(CB1, PAL.soil, 0.4);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.03 + rnd() * 0.025, 0.12, 0.35);
          const ry = 0.012 + rnd() * 0.02;
          pebble(BO, P.s + P.ns * ry * 0.5, P.y + P.ny * ry * 0.5, cur.t, P.ns, P.ny, ry * (1.2 + rnd()), ry, 5, 0.9, CB0, CB1, 1);
          kount('crumb');
        }
        break;
      }
      case K.ROCK: case K.NONE: case K.BASALT: case K.SCREE: {
        const bas = c === K.BASALT, scr = c === K.SCREE, base = bas ? PAL.basalt : scr ? PAL.scree : PAL.rock;
        if (down) {
          n = cnt((scr ? 0.4 : 0.9) * L);
          for (let i = 0; i < n; i++) {
            at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.03, 0.1, 0.4);
            shard(BO, P.s, P.y, 0.03, P.ns, P.ny, 0.022 + rnd() * 0.04, 0.05 + rnd() * 0.035, sc(base, 0.9), sc(base, 0.45), 1);   // a broken chip, wider than long
            kount('tooth');
          }
          break;
        }
        // loose stones settle in hollows and at wall feet (concavity P.conc, 1/m), bedded in the surface (they
        // show ~2/3 of their height), flat, often 2-3 together; scree is a debris field everywhere
        const hollow = Math.max(0, Math.min(1, P.conc * 0.6));
        n = cnt((scr ? 11 : (up ? 1.1 : 0.45) * (0.3 + 1.7 * hollow)) * L);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.03 + rnd() * 0.03, 0.12, 0.35);
          const m = scr ? 1 : 1 + (rnd() < 0.45 ? 1 : 0) + (rnd() < 0.2 ? 1 : 0), ts = P.ny, ty = -P.ns;
          for (let k = 0; k < m; k++) {
            const big = (scr ? 0.65 : up ? 1 : 0.6) * (1 - 0.3 * k), ry = (0.012 + rnd() * 0.026) * big, v = 0.8 + rnd() * 0.5, o = k ? (rnd() - 0.5) * 0.09 : 0;
            if (scr) mixTo(CB0, PAL.scree, PAL.rock, rnd()); else CB0[0] = base[0], CB0[1] = base[1], CB0[2] = base[2];
            scTo(CB1, CB0, (bas ? 1.45 : 1.12) * v); scTo(CB0, CB0, 0.5);
            pebble(BO, P.s + ts * o - P.ns * ry * 0.15, P.y + ty * o - P.ny * ry * 0.15, cur.t, P.ns, P.ny, ry * (1.4 + rnd() * 0.9), ry, bas ? 4 + (rnd() * 2 | 0) : 6 + (rnd() * 2 | 0), bas ? 1 : 0.6, CB1, CB0, 1);
            kount('pebble');
          }
        }
        if (up && !bas && !scr && (bi === 'temperate' || bi === 'alpine')) {
          n = cnt(0.8 * L);
          for (let i = 0; i < n; i++) {
            at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.04, 0.2, 0.6);
            const m = 3 + (rnd() * 3 | 0);
            scTo(CB0, PAL.gTip, 0.55); scTo(CB1, PAL.gBase, 0.9);
            for (let k = 0; k < m; k++) { const r = 0.01 + rnd() * 0.014, o = (rnd() - 0.5) * 0.06; pebble(BO, P.s + P.ny * o + P.ns * r * 0.4, P.y - P.ns * o + P.ny * r * 0.4, 0.04 + rnd() * 0.01, P.ns, P.ny, r * 1.3, r, 6, 0.5, CB0, CB1, 1); }
            kount('moss');
          }
        }
        break;
      }
      case K.SAND: {
        if (down) break;
        n = cnt(30 * L);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.03 + rnd() * 0.03, 0.12, 0.3);
          const r = 0.005 + rnd() * 0.007, o = rnd() * 0.012, v = 0.6 + rnd() * 0.75;
          scTo(CB0, PAL.sand, v * 1.15); scTo(CB1, PAL.sand, v * 0.6);
          pebble(BO, P.s + P.ns * (r + o), P.y + P.ny * (r + o), cur.t, P.ns, P.ny, r, r, 4, 0.5, CB0, CB1, 1);
          kount('grain');
        }
        n = cnt(0.35 * L);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.04, 0.12, 0.35);
          const ry = 0.012 + rnd() * 0.008;
          pebble(BO, P.s + P.ns * ry * 0.6, P.y + P.ny * ry * 0.6, 0.04, P.ns, P.ny, ry * 1.7, ry, 7, 0.3, [0.85, 0.8, 0.72], [0.45, 0.4, 0.36], 1);
          kount('shell');
        }
        break;
      }
      case K.SNOW: case K.ICE: {
        const ice = c === K.ICE;
        if (down) {
          n = cnt((ice ? 5 : 2) * L);
          for (let i = 0; i < n; i++) {
            at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.03 + rnd() * 0.02, 0.35, 1.0); cur.rough = 0.1; cur.em = 0.04;
            const r = rnd(), len = ice ? 0.1 + 0.5 * r * r : 0.06 + 0.16 * r;
            icicle(BT, P.s, P.y, cur.t, len, (ice ? 0.035 + rnd() * 0.04 : 0.03 + rnd() * 0.025) * (0.7 + len));
            kount('icicle');
          }
          break;
        }
        if (ice) {
          n = cnt(6 * L);
          for (let i = 0; i < n; i++) {
            at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.03 + rnd() * 0.03, 0.15, 0.5); cur.rough = 0.1; cur.em = 0.05;
            const a = (rnd() - 0.5) * 1.0, ca = Math.cos(a), sa = Math.sin(a), ds = P.ns * ca - P.ny * sa, dy = P.ns * sa + P.ny * ca, r = rnd();
            shard(BT, P.s + P.ns * 0.01, P.y + P.ny * 0.01, cur.t, ds, dy, 0.03 + 0.06 * r * r, 0.03 + rnd() * 0.02, PAL.iceHi, PAL.iceLo, 0.85);   // short crystals
            kount('shard');
          }
        } else {
          n = cnt(8 * L);
          for (let i = 0; i < n; i++) {
            at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.04, 0.3, 0.6); cur.em = -1.8;
            const o = up ? 0.02 + rnd() * 0.09 : 0.01;
            glint(BO, P.s + P.ns * o, P.y + P.ny * o, 0.04, 0.015 + rnd() * 0.013);
            kount('glint');
          }
        }
        break;
      }
      case K.LAVA: {
        // the lava layer itself (surface, crust) is drawn by render/lava.js; the edge is the hot contact under it:
        // a glowing rim (band) plus heat cracks running into the cut face
        if (down) break;
        n = cnt(2.2 * L);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.012, 0.3, 0.8); cur.em = 2.0;
          let ds = -P.ns * 0.6, dy = -P.ny * 0.6 - 0.4; const l = Math.hypot(ds, dy) || 1;
          rootWalk(P.s - P.ns * 0.03, P.y - P.ny * 0.03, ds / l, dy / l, 0.08 + rnd() * 0.25, 0.022, [0.5, 0.13, 0.02], [0.25, 0.03, 0.005], true);
        }
        break;
      }
      case K.ASH: {
        if (down) break;
        n = cnt(6 * L);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.03 + rnd() * 0.03, 0.12, 0.3);
          const r = 0.006 + rnd() * 0.007, v = 0.85 + rnd() * 0.35;
          pebble(BO, P.s + P.ns * r, P.y + P.ny * r, cur.t, P.ns, P.ny, r, r * 0.7, 4, 0.5, sc(PAL.ash, v), sc(PAL.ash, 0.6), 1);
          kount('flake');
        }
        n = cnt(0.5 * L);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.04, 0.15, 0.4);
          const l = 0.08 + rnd() * 0.12, ts = P.ny, ty = -P.ns, k = (rnd() - 0.5) * 0.03;
          RP[0] = P.s - ts * l * 0.5 + P.ns * 0.008; RP[1] = P.y - ty * l * 0.5 + P.ny * 0.008;
          RP[2] = P.s + P.ns * (0.012 + k); RP[3] = P.y + P.ny * (0.012 + k);
          RP[4] = P.s + ts * l * 0.5 + P.ns * 0.008; RP[5] = P.y + ty * l * 0.5 + P.ny * 0.008;
          ribbon(BO, 3, 0.04, 0.014, 0.009, [0.05, 0.04, 0.035], [0.03, 0.025, 0.02], 0);
          kount('twig');
        }
        break;
      }
      case K.SANDSTONE: {
        if (down) {
          n = cnt(0.5 * L);
          for (let i = 0; i < n; i++) { at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.03, 0.1, 0.4); shard(BO, P.s, P.y, 0.03, P.ns, P.ny, 0.02 + rnd() * 0.035, 0.05, sc(PAL.sst, 0.8), sc(PAL.sst, 0.4), 1); kount('tooth'); }
          break;
        }
        n = cnt((up ? 2 : 1.5) * L);
        for (let i = 0; i < n; i++) {
          at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.03 + rnd() * 0.02, 0.12, 0.4);
          const v = 0.85 + rnd() * 0.3, th = (up ? 0.022 : 0.014) + rnd() * 0.016;
          scTo(CB0, PAL.sst, 1.4 * v); scTo(CB1, PAL.sst, 0.45 * v);
          // a bedding-plane flake lying along the surface (O2: on walls these stood out horizontally: sticks)
          plate(BO, P.s + P.ns * th * 0.35, P.y + P.ny * th * 0.35, cur.t, P.ny, -P.ns, (up ? 0.08 : 0.06) + rnd() * (up ? 0.17 : 0.1), th, CB0, CB1);
          kount('plate');
        }
        if (up) {
          n = cnt(1.5 * L);
          for (let i = 0; i < n; i++) { at(f0 + rnd() * 0.5); anchor(P.s, P.y, 0.035, 0.12, 0.35); const ry = 0.008 + rnd() * 0.012; pebble(BO, P.s + P.ns * ry * 0.1, P.y + P.ny * ry * 0.1, 0.035, P.ns, P.ny, ry * 1.6, ry, 5, 0.6, sc(PAL.sst, 1.3), sc(PAL.sst, 0.45), 1); kount('pebble'); }
        }
        break;
      }
    }
  }

  /* ---------- per chain: band stations + per-segment items ---------- */
  function keyPt(s, y) { const x = F.ox + s * F.dx, z = F.oz + s * F.dz; return hi(hi(Math.round(x * 64), Math.round(y * 64)), Math.round(z * 64)); }
  // birth time of a segment: kept from the previous build when the segment (endpoints + classes) is unchanged;
  // fresh edge = a wave from the worm (s = 0) outwards, later edits = right now
  function birthOf(key, s) {
    let b = st.prev ? st.prev.get(key) : undefined;
    if (b === undefined) {
      const h = (hi(key, 77) >>> 0) / 4294967296;
      b = st.fresh ? st.showT + 0.05 + Math.min(0.6, Math.abs(s) * 0.025) + h * 0.08 : st.now + 0.02 + h * 0.08;
    }
    st.births.set(key, b);
    return b;
  }
  let rowPrev = -1, rowFirst = -1;
  function link(a, b) { for (let r = 0; r < 3; r++) { tri(BT, a + r, b + r, b + r + 1); tri(BT, a + r, b + r + 1, a + r + 1); } }
  // one band station (4 vertices: shadow feather end, drape bottom / ink line, surface line, lit outer lip).
  // O2: the band parameters are a weighted blend of the classes found at 5 taps within ±2 TW of arc length (weights
  // 1 2 3 2 1), all sampled at this station's (s, y): a class change becomes a ~0.2 m ramp whatever the segment
  // lengths (it used to jump within one segment, a few mm on O1's fine chords: square steps in the lip).
  const TW = 0.05, TAPK = new Int32Array(5), TAPW = new Float32Array(5);
  function accBand(o, q, w) {
    o.to += q.to * w; o.ti += q.ti * w; o.fe += q.fe * w; o.a1 += q.a1 * w; o.em += q.em * w; o.rough += q.rough * w;
    for (let c = 0; c < 3; c++) { o.cfe[c] += q.cfe[c] * w; o.cdr[c] += q.cdr[c] * w; o.cmid[c] += q.cmid[c] * w; o.cout[c] += q.cout[c] * w; }
  }
  function station(E, pA, pB, f, birth, u) {
    const s = E.pts[pA * 2] + (E.pts[pB * 2] - E.pts[pA * 2]) * f, y = E.pts[pA * 2 + 1] + (E.pts[pB * 2 + 1] - E.pts[pA * 2 + 1]) * f;
    let ns = NRM[pA * 2] + (NRM[pB * 2] - NRM[pA * 2]) * f, ny = NRM[pA * 2 + 1] + (NRM[pB * 2 + 1] - NRM[pA * 2 + 1]) * f;
    const l = Math.hypot(ns, ny) || 1; ns /= l; ny /= l;
    let nk = 0;
    for (let k = -2; k <= 2; k++) {
      const p = ptAt(u + k * TW), key = E.cls[p] | (E.face[p] << 4) | (E.wet[p] << 6), w = 3 - Math.abs(k);
      let q = 0; while (q < nk && TAPK[q] !== key) q++;
      if (q === nk) { TAPK[nk] = key; TAPW[nk] = 0; nk++; }
      TAPW[q] += w / 9;
    }
    if (nk === 1) bandAt(BP, TAPK[0] & 15, (TAPK[0] >> 4) & 3, TAPK[0] >> 6, s, y);
    else {
      BP.to = BP.ti = BP.fe = BP.a1 = BP.em = BP.rough = 0; BP.cfe.fill(0); BP.cdr.fill(0); BP.cmid.fill(0); BP.cout.fill(0);
      for (let q = 0; q < nk; q++) { bandAt(BQ, TAPK[q] & 15, (TAPK[q] >> 4) & 3, TAPK[q] >> 6, s, y); accBand(BP, BQ, TAPW[q]); }
    }
    // offsets never reach the centre of curvature: the lip (into the air) in hollows, the drape / feather (into the
    // rock) on crests, else the row folds into a bow-tie (a spike / dark wedge)
    BP.to = Math.min(BP.to, LIMO[pA] + (LIMO[pB] - LIMO[pA]) * f);
    { const lim = LIMI[pA] + (LIMI[pB] - LIMI[pA]) * f, d0 = BP.ti + BP.fe; if (d0 > lim) { const k = lim / d0; BP.ti *= k; BP.fe *= k; } }
    cur.s = s; cur.y = y; cur.t = 0.02; cur.birth = birth; cur.dur = 0.45; cur.phase = vn2(s * 3, y * 3); cur.em = BP.em; cur.rough = BP.rough;
    reserve(BT, 4, 18);
    // edg = metres to the outer edge of the band: the fragment shader fades the last pixel (AA without MSAA)
    const di = BP.ti + BP.fe;
    cur.edg = BP.to + di; const i0 = vtx(BT, s - ns * di, y - ny * di, 0.02, 0, 0, 1, BP.cfe, 0, 0);
    cur.edg = BP.to + BP.ti; vtx(BT, s - ns * BP.ti, y - ny * BP.ti, 0.02, -ns * 0.2, -ny * 0.2, 1, BP.cdr, BP.a1, 0);
    cur.edg = BP.to + 0.004; vtx(BT, s - ns * 0.004, y - ny * 0.004, 0.02, ns * 0.35, ny * 0.35, 0.94, BP.cmid, 1, 0);
    cur.edg = 0; vtx(BT, s + ns * BP.to, y + ny * BP.to, 0.02, ns * 0.75, ny * 0.75, 0.66, BP.cout, 1, 0);
    cur.edg = -1;
    if (rowPrev >= 0) link(rowPrev, i0);
    rowPrev = i0; if (rowFirst < 0) rowFirst = i0;
    if (EV.dbgRows) EV.dbgRows.push(chainId, s, y, s + ns * BP.to, y + ny * BP.to, s - ns * di, y - ny * di, BP.to, E.cls[pA]);
  }
  let chainId = 0;
  /* arc length along the chain being built (C: static scratch): CH.cum[i] = arc at point a + i (closed chains: one
   * more entry for the closing segment); ptAt(u) = index of the point nearest to arc u; posAt(u) -> PS, PY */
  const CH = { E: null, a: 0, n: 0, cl: 0, cum: new Float64Array(1024), tot: 0 };
  let PS = 0, PY = 0;
  function chainArc(E, a, n, cl) {
    const m = cl ? n + 1 : n;
    if (CH.cum.length < m) CH.cum = new Float64Array(m * 2);
    CH.E = E; CH.a = a; CH.n = n; CH.cl = cl; CH.cum[0] = 0;
    for (let i = 1; i < m; i++) {
      const p = a + (i - 1), q = a + i % n;
      CH.cum[i] = CH.cum[i - 1] + Math.hypot(E.pts[q * 2] - E.pts[p * 2], E.pts[q * 2 + 1] - E.pts[p * 2 + 1]);
    }
    CH.tot = CH.cum[m - 1];
  }
  function segOf(u) {               // segment index e (point a + e .. a + e + 1) holding arc u, after wrap / clamp
    const m = CH.cl ? CH.n + 1 : CH.n, cum = CH.cum;
    let lo = 0, hi = m - 1;
    while (hi - lo > 1) { const md = (lo + hi) >> 1; if (cum[md] <= u) lo = md; else hi = md; }
    return lo;
  }
  function wrap(u) { return CH.cl ? ((u % CH.tot) + CH.tot) % CH.tot : Math.max(0, Math.min(CH.tot, u)); }
  function ptAt(u) {
    if (CH.n < 2 || CH.tot <= 0) return CH.a;
    u = wrap(u); const e = segOf(u), cum = CH.cum;
    return CH.a + ((u - cum[e] < cum[e + 1] - u ? e : e + 1) % CH.n);
  }
  function posAt(u) {
    const E = CH.E;
    if (CH.n < 2 || CH.tot <= 0) { PS = E.pts[CH.a * 2]; PY = E.pts[CH.a * 2 + 1]; return; }
    u = wrap(u); const e = segOf(u), cum = CH.cum, L = cum[e + 1] - cum[e], f = L > 1e-9 ? (u - cum[e]) / L : 0;
    const p = CH.a + e, q = CH.a + (e + 1) % CH.n;
    PS = E.pts[p * 2] + (E.pts[q * 2] - E.pts[p * 2]) * f; PY = E.pts[p * 2 + 1] + (E.pts[q * 2 + 1] - E.pts[p * 2 + 1]) * f;
  }
  /* concavity per chain point (1/m, + = a hollow seen from the air, - = a crest): the sagitta of the chord between
   * the points CONC_R m back and ahead along the chain, measured along the air normal. Loose debris settles in
   * hollows and at wall feet, not on crests (O2: pebbles were strung evenly along every slope: beads on a string). */
  const CONC_R = 0.25, CONC_RF = 0.08;   // debris scale; fine scale for the band's fold clamps (sharp tips)
  let CONC = new Float32Array(1024), CONCF = new Float32Array(1024);
  function sagitta(E, p, u, R) {
    posAt(u - R); const sA = PS, yA = PY; posAt(u + R);
    const ms = (sA + PS) * 0.5 - E.pts[p * 2], my = (yA + PY) * 0.5 - E.pts[p * 2 + 1], half = Math.max(R * 0.2, Math.hypot(PS - sA, PY - yA) * 0.5);
    return 2 * (ms * NRM[p * 2] + my * NRM[p * 2 + 1]) / (half * half);
  }
  /* per point offset limits (m): LIMO for the lip (into the air: hollows), LIMI for drape + feather (into the solid:
   * crests, thin fins), then a cone filter along the chain (a limit may rise only LIM_SLOPE m per m of arc away from
   * where it binds), so a clamp eases in instead of notching the lip at one station */
  const LIM_SLOPE = 0.3;
  let LIMO = new Float32Array(1024), LIMI = new Float32Array(1024);
  function cone(L) {
    const a = CH.a, n = CH.n, cum = CH.cum, passes = CH.cl ? 2 : 1;
    for (let r = 0; r < passes; r++) {
      for (let i = 1; i <= (CH.cl ? n : n - 1); i++) { const p = a + i % n, o = a + i - 1; L[p] = Math.min(L[p], L[o] + LIM_SLOPE * (cum[i] - cum[i - 1])); }
      for (let i = (CH.cl ? n : n - 1); i >= 1; i--) { const p = a + i - 1, o = a + i % n; L[p] = Math.min(L[p], L[o] + LIM_SLOPE * (cum[i] - cum[i - 1])); }
    }
  }
  function concavity(E) {
    for (let i = 0; i < CH.n; i++) {
      const p = CH.a + i, u = CH.cum[i]; CONC[p] = sagitta(E, p, u, CONC_R); CONCF[p] = sagitta(E, p, u, CONC_RF);
      const hol = Math.max(CONC[p], CONCF[p], 0), cre = Math.max(-CONC[p], -CONCF[p], 0);
      LIMO[p] = hol > 1e-3 ? 0.6 / hol : 9;
      LIMI[p] = Math.min(cre > 1e-3 ? 0.6 / cre : 9, THK[p] < THK_MAX ? 0.45 * THK[p] : 9);
    }
    cone(LIMO); cone(LIMI);
  }
  /* band normal per chain point (O2): perpendicular of the chain's own tangent over ±NT m, turned to the air side by a
   * density test 2 cm either way (the sim's gradient normal straddles both faces of a thin fin: up to 60° off), and
   * the solid's thickness under the point along it (THK, m, capped at THK_MAX): the drape / feather rows stay within
   * 45 % of it, so they never cross a thin fin into the air on its far side */
  const NT = 0.03, THK_MAX = 0.3, THK_ST = 0.025;
  let NRM = new Float32Array(2048), THK = new Float32Array(1024);
  const wsamp = (s, y) => SS.world.sample(F.ox + s * F.dx, y, F.oz + s * F.dz);
  function normals(E) {
    for (let i = 0; i < CH.n; i++) {
      const p = CH.a + i, u = CH.cum[i], s0 = E.pts[p * 2], y0 = E.pts[p * 2 + 1];
      posAt(u - NT); const sA = PS, yA = PY; posAt(u + NT);
      let ts = PS - sA, ty = PY - yA; const l = Math.hypot(ts, ty);
      let ns = E.nrm[p * 2], ny = E.nrm[p * 2 + 1];
      if (l > 1e-5) {
        ts /= l; ty /= l; let qs = -ty, qy = ts;
        const out = wsamp(s0 + qs * 0.02, y0 + qy * 0.02), inn = wsamp(s0 - qs * 0.02, y0 - qy * 0.02);
        if (out > inn || (out === inn && qs * ns + qy * ny < 0)) { qs = -qs; qy = -qy; }
        ns = qs; ny = qy;
      }
      NRM[p * 2] = ns; NRM[p * 2 + 1] = ny;
      let d = THK_ST; while (d < THK_MAX && wsamp(s0 - ns * d, y0 - ny * d) > 0) d += THK_ST;
      THK[p] = d;
    }
  }
  function segItems(E, pA, pB, len, birth) {
    P.sA = E.pts[pA * 2]; P.yA = E.pts[pA * 2 + 1]; P.sB = E.pts[pB * 2]; P.yB = E.pts[pB * 2 + 1];
    P.nsA = NRM[pA * 2]; P.nyA = NRM[pA * 2 + 1]; P.nsB = NRM[pB * 2]; P.nyB = NRM[pB * 2 + 1];
    P.len = len; P.birth = birth;
    for (let h = 0; h < 2; h++) {
      const p = h ? pB : pA;
      P.cls = E.cls[p]; P.face = E.face[p]; P.wet = E.wet[p]; P.conc = CONC[p];
      P.cover = E.veg[p * 4]; P.dry = E.veg[p * 4 + 1]; P.chr = E.veg[p * 4 + 2]; P.burn = E.veg[p * 4 + 3];
      half(h * 0.5);
    }
  }
  function buildChain(E, q) {
    const a = E.chain[q * 2], n = E.chain[q * 2 + 1], cl = E.closed[q];
    if (n < 2) return;
    const nseg = cl ? n : n - 1;
    rowPrev = rowFirst = -1; chainId = q;
    chainArc(E, a, n, cl); normals(E); concavity(E);
    const nSt = Math.max(1, Math.round(CH.tot / step)), stepC = CH.tot / nSt; let jSt = 0;
    for (let e = 0; e < nseg; e++) {
      const pA = a + e, pB = a + (e + 1) % n;
      const sA = E.pts[pA * 2], yA = E.pts[pA * 2 + 1], sB = E.pts[pB * 2], yB = E.pts[pB * 2 + 1], len = Math.hypot(sB - sA, yB - yA);
      const kA = keyPt(sA, yA), kB = keyPt(sB, yB), swap = kA > kB, cA = E.cls[pA], cB = E.cls[pB];
      // symmetric key (the chain direction can flip between rebuilds): endpoints + classes in canonical order
      const key = hi(kA ^ kB, swap ? cB * 16 + cA : cA * 16 + cB), birth = birthOf(key, (sA + sB) * 0.5);
      // stations at uniform arc length along the whole chain (O2: per-segment ceil(len / step) put them 3 mm to 6 cm
      // apart on O1's mixed chords; uneven spacing turned smooth lip changes into kinks)
      while (jSt * stepC < CH.cum[e + 1] - 1e-9 && jSt < nSt) { const u = jSt * stepC; station(E, pA, pB, len > 1e-9 ? (u - CH.cum[e]) / len : 0, birth, u); jSt++; }
      if (!cl && e === nseg - 1) station(E, pA, pB, 1, birth, CH.tot);
      rs = key;
      if (swap) segItems(E, pB, pA, len, birth); else segItems(E, pA, pB, len, birth);
    }
    if (cl && rowPrev >= 0 && rowFirst >= 0 && rowPrev !== rowFirst) link(rowPrev, rowFirst);
  }

  /* ---------- material: MeshPhong + vertex colours/alpha, per-vertex gloss/emissive, grow + sway ----------
   * Phong, not Standard: the lighting normal's camera-facing part is flipped to the sun's side (F.sd, like the cap);
   * Standard then sees N·V ≈ 0 and its Fresnel energy term removes the ambient diffuse (blades went black). Phong's
   * diffuse is plain Lambert; per-vertex specular strength = 1 - roughness keeps the ice glossy. */
  function material(transparent) {
    const m = new T.MeshPhongMaterial({ vertexColors: true, specular: 0xffffff, shininess: 60, side: T.DoubleSide, transparent, depthWrite: !transparent });
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = 'attribute vec4 aAnc, aAni; attribute float aRgh, aEdg; uniform float uTime, uWind; uniform vec3 uDir; varying float vEm, vRgh, vEdg;\n' +
        sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
          float age = uTime - aAnc.w, gx = clamp(age / max(aAni.w, 0.01), 0.0, 1.0);
          float g = age <= 0.0 ? 0.0 : (gx >= 1.0 ? 1.0 : 1.0 - exp(-5.0 * gx) * cos(8.0 * gx));   // spring overshoot
          transformed = aAnc.xyz + (transformed - aAnc.xyz) * g;
          float ph = aAni.z * 6.2832;
          float sw = sin(uTime * 2.3 + ph + dot(aAnc.xz, vec2(0.9, 0.7))) * 0.6 + sin(uTime * 3.7 + ph * 2.0) * 0.25 + uWind;
          transformed += uDir * (sw * aAni.x * g);
          float e = aAni.y;
          vEm = e >= 0.0 ? e * (0.72 + 0.28 * sin(uTime * (5.0 + 4.0 * aAni.z) + ph * 7.0)) : -e * pow(max(0.0, sin(uTime * 1.7 + ph * 3.0)), 12.0);
          vRgh = aRgh; vEdg = aEdg;`);
      sh.fragmentShader = 'varying float vEm, vRgh, vEdg;\n' + sh.fragmentShader
        // band: fade the last pixel before its outer edge (vEdg = metres to it; items carry -1)
        .replace('#include <color_fragment>', '#include <color_fragment>\n          if (vEdg >= 0.0) diffuseColor.a *= clamp(vEdg / max(fwidth(vEdg), 1e-6), 0.0, 1.0);')
        .replace('#include <normal_fragment_begin>', T.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
        .replace('#include <specularmap_fragment>', 'float specularStrength = clamp(1.0 - vRgh * 1.1, 0.0, 1.0);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n          totalEmissiveRadiance += diffuseColor.rgb * vEm;');
    };
    m.customProgramCacheKey = () => 'edge' + (transparent ? 'T' : 'O');
    return m;
  }
  function upload(mesh, b) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(b.pos.slice(0, b.nv * 3), 3));
    g.setAttribute('normal', new T.BufferAttribute(b.nrm.slice(0, b.nv * 3), 3));
    g.setAttribute('color', new T.BufferAttribute(b.col.slice(0, b.nv * 4), 4));
    g.setAttribute('aAnc', new T.BufferAttribute(b.anc.slice(0, b.nv * 4), 4));
    g.setAttribute('aAni', new T.BufferAttribute(b.ani.slice(0, b.nv * 4), 4));
    g.setAttribute('aRgh', new T.BufferAttribute(b.rgh.slice(0, b.nv), 1));
    g.setAttribute('aEdg', new T.BufferAttribute(b.edg.slice(0, b.nv), 1));
    g.setIndex(new T.BufferAttribute(b.idx.slice(0, b.ni), 1));
    mesh.geometry.dispose(); mesh.geometry = g;
  }
  const sigOf = (E, p) => E.cls[p] | (E.wet[p] << 4) | ((E.veg[p * 4 + 3] > 20 ? 1 : 0) << 5);
  function signature(E) { const g = new Uint8Array(E.np); for (let p = 0; p < E.np; p++) g[p] = sigOf(E, p); return g; }
  function changed(E) { if (!st.sig || st.sig.length !== E.np) return true; for (let p = 0; p < E.np; p++) if (st.sig[p] !== sigOf(E, p)) return true; return false; }

  function rebuild(S, view, sec, fresh) {
    const t0 = performance.now(), E = sec.edge, look = view.look || (SS.view && SS.view.LOOKS.temperate);
    palette(look); st.biome = S.biome;
    F.ox = sec.O.x; F.oz = sec.O.z; F.dx = Math.cos(sec.theta); F.dz = Math.sin(sec.theta); F.nx = -F.dz; F.nz = F.dx;
    const L = look.sunDir || [0, 1, 0]; F.sd = F.nx * L[0] + F.nz * L[2] >= 0 ? 1 : -1;
    U.uDir.value.set(F.dx, 0, F.dz);
    st.fresh = fresh; st.now = view.time; if (fresh) st.showT = view.time;
    st.prev = st.births; st.births = new Map();
    BO.nv = BO.ni = BT.nv = BT.ni = 0; st.count = {};
    SEC = sec;
    if (CONC.length < E.np) { CONC = new Float32Array(E.np * 2); CONCF = new Float32Array(E.np * 2); THK = new Float32Array(E.np * 2); NRM = new Float32Array(E.np * 4); LIMO = new Float32Array(E.np * 2); LIMI = new Float32Array(E.np * 2); }
    EV.thk = THK; EV.nrmB = NRM;                        // (tools)
    // metres per pixel on the plane at this zoom (camera ~view.zoom m away): minimum line widths (bandAt)
    st.zoomB = view.zoom || 19; st.mpp = st.zoomB / (view.pxScale || 1000);
    for (let q = 0; q < E.nc; q++) buildChain(E, q);
    SEC = null; st.prev = null;
    upload(meshO, BO); upload(meshT, BT);
    st.sec = sec; st.shown = true; meshO.visible = meshT.visible = true;
    st.sig = signature(E);
    st.buildMs = performance.now() - t0; st.builds++;
  }
  function hide() { meshO.visible = meshT.visible = false; st.shown = false; st.sec = null; st.births.clear(); }

  /* ---------- API ---------- */
  EV.init = function (scene, txx, q) {
    tx = txx; Q = q; K = SS.edge.CLS; FACE = SS.edge.FACE; bandTable();
    dens = q.name === 'low' ? 0.45 : q.name === 'medium' ? 0.75 : 1;
    step = q.name === 'low' ? 0.11 : q.name === 'medium' ? 0.08 : 0.06;
    bseg = q.name === 'low' ? 2 : 3;
    reserve(BO, 1, 3); reserve(BT, 1, 3);
    meshO = new T.Mesh(new T.BufferGeometry(), material(false)); meshO.frustumCulled = false; meshO.visible = false; meshO.renderOrder = 3;
    meshT = new T.Mesh(new T.BufferGeometry(), material(true)); meshT.frustumCulled = false; meshT.visible = false; meshT.renderOrder = 7;
    scene.add(meshO); scene.add(meshT);
  };
  EV.reset = function () { if (meshO) hide(); st.vegVer = st.waterVer = st.lavaVer = -1; st.sig = null; };
  /* per frame (after the section is rebuilt): returns the edge alpha 0..1; the outline is drawn with 1 - alpha */
  EV.frame = function (S, view) {
    if (!meshO) return 0;
    U.uTime.value = view.time;
    // (a section that moved since the edge was built - a placement jump, an align - hides it at once; the new one fades in)
    const still = EV.enabled && S.section && S.time - S.lastRotate >= SHOW_DELAY && S.thetaGoal == null && S.section.O.x === S.O.x && S.section.O.z === S.O.z;
    if (!still) { if (st.shown) hide(); return (EV.alpha = 0); }
    const sec = S.section;
    if (sec !== st.sec) {
      if (!sec.edge) SS.edge.build(S, sec);
      rebuild(S, view, sec, !st.shown);
      st.refreshT = view.time;
      st.vegVer = S.veg ? S.veg.surfVer : 0; st.waterVer = S.water ? S.water.ver : 0; st.lavaVer = S.lava ? S.lava.ver : 0;
    } else if (Math.abs(Math.log((view.zoom || 19) / st.zoomB)) > 0.33) {
      rebuild(S, view, sec, false);                     // zoomed far: re-derive the pixel-minimum line widths
    } else if (view.time - st.refreshT > REFRESH) {
      const vv = S.veg ? S.veg.surfVer : 0, wv = S.water ? S.water.ver : 0, lv = S.lava ? S.lava.ver : 0;
      if (vv !== st.vegVer || wv !== st.waterVer || lv !== st.lavaVer) {
        st.vegVer = vv; st.waterVer = wv; st.lavaVer = lv; st.refreshT = view.time; st.refreshes++;
        SS.edge.refresh(S, sec);
        if (changed(sec.edge)) rebuild(S, view, sec, false);
      }
    }
    U.uWind.value = S.wind && S.wind.mean ? (S.wind.mean.x * F.dx + S.wind.mean.z * F.dz) * 0.08 : 0;
    const x = Math.max(0, Math.min(1, (view.time - st.showT) / FADE));
    return (EV.alpha = x * x * (3 - 2 * x));
  };
  EV.stats = () => ({ shown: st.shown, alpha: EV.alpha || 0, builds: st.builds, refreshes: st.refreshes, buildMs: +st.buildMs.toFixed(2),
    trisO: BO.ni / 3, trisT: BT.ni / 3, vertsO: BO.nv, vertsT: BT.nv, count: Object.assign({}, st.count), births: st.births.size, showT: st.showT });
  EV.debug = () => ({ meshO, meshT, st, U, PAL, F });
})(window.SS = window.SS || {});
