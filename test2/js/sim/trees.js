/* sim/trees.js — trees made of parts (portable, deterministic; no DOM / Three.js).
 *
 * A tree is a list of segments (capsules a->b, radius r0->r1; parent index < child index) plus leaf clusters
 * (spheres attached to a segment, f = fraction of leaves left):
 *   segment 0 = root stump (0.4 m below ground to 0.3 m above): it never breaks;
 *   trunk segments (kind 1) and branches (kind 2) above it.
 * Species per biome (C.TREES.SPECIES / SPEC): oak (temperate), spruce (alpine: foliage tiers on the trunk), juniper
 * (canyon), snag (desert, volcanic: dead, leafless).
 * Blast (veg.blast -> TR.blast, after the crater is carved): every part takes the Kinney-Graham impulse I at its
 * distance, shielded by the solid on the line like worms; leaf clusters lose clamp((I - LEAF_I) / LEAF_SPAN) of their
 * leaves; each part's impulse J = I A (A = frontal area; a crown catches POROSITY of its disc) acts at the part along
 * the blast direction; torn-off leaves pass only LEAF_HOLD of their impulse to the branch (T2: leaves go first).
 * Segments are processed children first: the bending angular impulse about a segment's base |(sum r x J) x axis|
 * breaks it above K_BREAK r0^3 (weaker when charred), so twigs, side branches and the top go before the trunk; a
 * segment within CUT_K W^(1/3) + r of the burst is cut. Every broken segment becomes its OWN rigid 'log' body (wood
 * 600 kg/m^3: floats; with its unbroken children) with the blast impulse applied; the tree keeps the rest, at worst
 * the stump (segment 0, 0.3 m above ground). Roots (T1): only a direct hit on the lower stem (within the cut radius
 * of the stem up to STEM_LOW) destroys the stump and the roots ('treeshatter'); a crater beside the tree leaves it
 * standing (roots exposed) unless less than ROOT_HOLD of its root plate (ROOT_R_K x crown, ROOT_D deep) has ground
 * left ('uproot': the whole tree falls).
 * Fire: heat accumulates from burning grass around the root, fireballs (veg.ignite), lava at the root and burning
 * neighbours; a tree ignites at IGNITE + IGNITE_GREEN (1 - dry); burning consumes leaves (LEAF_BURN_T) and chars the
 * wood (BURN_T), drops embers on the grass under the crown, lights props and neighbours, burns worms near the trunk
 * or inside the crown; water at the root puts it out. Burnt trees (char 1) stay as charred snags.
 * Plane: standing trunk / branch segments crossing slice zero are solid boxes on the gameplay plane.
 *
 * C layout: struct Seg { i32 p; vec3 a, b; f32 r0, r1; u8 kind, on; };
 *   struct Leaf { vec3 c; f32 r, f; i32 s; };
 *   struct Tree { i32 id; u8 sp, alive; vec3 root; f32 h, crown, dry, burn, heat, thr, char; Seg seg[]; Leaf leaf[]; };
 * API: populate(S, taken), blast(S, c, W), heat_burst(S, c, r), tick(S, dt), fire_at(S, x, y, z), on_edit(S, box),
 *   plane_sections(S), strike(S, t) (lightning hook), stats(S).
 */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, K = C.TREES, BC = C.BLAST;
  const TR = SS.trees = {};
  const W = () => SS.world;
  const SPN = ['oak', 'spruce', 'juniper', 'snag'];
  const v = (x, y, z) => ({ x, y, z });
  const dist3 = (a, b) => M.len3(a.x - b.x, a.y - b.y, a.z - b.z);
  function segd(p, a, b) {                               // point to segment distance (objects)
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const u = M.sat(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz || 1));
    return M.len3(p.x - a.x - abx * u, p.y - a.y - aby * u, p.z - a.z - abz * u);
  }

  /* ---------- growth ---------- */
  function seg(t, p, a, b, r0, r1, kind) { t.seg.push({ p, a, b, r0, r1, kind, on: 1 }); return t.seg.length - 1; }
  function leaf(t, s, x, y, z, r) { t.leaf.push({ x, y, z, r, f: 1, s }); }
  function grow(rg, sp, x, y, z) {
    const R = () => M.rng_next(rg), P = K.SPEC[SPN[sp]];
    const t = { id: 0, sp, alive: 1, x, y, z, h: 0, crown: 0, top: 0, seg: [], leaf: [], dry: 0, burn: -1, heat: 0, thr: 1, char: 0, emb: 0 };
    const h = P.h[0] + (P.h[1] - P.h[0]) * R(), r = P.r[0] + (P.r[1] - P.r[0]) * R(), la = R() * M.TAU, ln = P.lean * (0.3 + 0.7 * R());
    t.h = h;
    const root = seg(t, -1, v(x, y - 0.4, z), v(x, y + 0.3, z), r * 1.35, r * 1.12, 0);
    const trunk = [root];
    let pa = t.seg[root].b, prev = root;
    const topY = h * P.top;
    for (let i = 1; i <= P.nT; i++) {
      const f = i / P.nT, yy = 0.3 + (topY - 0.3) * f, off = ln * yy;
      const b = v(x + M.cos(la) * off + (R() - 0.5) * P.wob * f, y + yy, z + M.sin(la) * off + (R() - 0.5) * P.wob * f);
      prev = seg(t, prev, pa, b, t.seg[prev].r1, r * (1 - (1 - P.taper) * f), 1); pa = b; trunk.push(prev);
    }
    const sc = h / P.h[1];
    const branch = (s, n, el0, el1, l0, l1, rf, lr) => {
      const o = t.seg[s].b, a0 = R() * M.TAU;
      for (let k = 0; k < n; k++) {
        const az = a0 + k * M.TAU / n + (R() - 0.5) * 0.8, el = el0 + (el1 - el0) * R(), L = (l0 + (l1 - l0) * R()) * sc;
        const e = v(o.x + M.cos(el) * M.cos(az) * L, o.y + M.sin(el) * L, o.z + M.cos(el) * M.sin(az) * L);
        const r0 = Math.max(0.04, t.seg[s].r1 * rf), bi = seg(t, s, o, e, r0, r0 * 0.5, 2);
        if (lr) leaf(t, bi, e.x, e.y + 0.25 * sc, e.z, (lr[0] + (lr[1] - lr[0]) * R()) * sc);
      }
    };
    const tp = t.seg[trunk[P.nT]].b;
    if (sp === 0) {                                        // oak: two tiers of limbs with clusters + a top cluster
      branch(trunk[P.nT - 1], 2 + (R() < 0.5 ? 1 : 0), 0.45, 0.85, 1.5, 2.4, 0.75, [1.0, 1.4]);
      branch(trunk[P.nT], 2 + (R() < 0.5 ? 1 : 0), 0.6, 1.0, 1.1, 1.8, 0.8, [1.0, 1.3]);
      leaf(t, trunk[P.nT], tp.x, tp.y + 0.5 * sc, tp.z, (1.3 + 0.4 * R()) * sc);
    } else if (sp === 1) {                                 // spruce: foliage tiers around the trunk, narrowing upwards
      const fr = [0.2, 0.34, 0.48, 0.62, 0.76, 0.9];
      for (const q of fr) {
        const yy = y + h * q;
        let s = trunk[1]; for (const i of trunk) if (i && t.seg[i].a.y <= yy && t.seg[i].b.y >= yy) s = i;
        const g = t.seg[s], u = M.clamp((yy - g.a.y) / Math.max(0.01, g.b.y - g.a.y), 0, 1);
        leaf(t, s, g.a.x + (g.b.x - g.a.x) * u, yy, g.a.z + (g.b.z - g.a.z) * u, (0.35 + 1.45 * (1 - q)) * sc);
      }
    } else if (sp === 2) {                                 // juniper: a crooked crown of a few short limbs
      branch(trunk[P.nT], 3, 0.3, 0.8, 0.9, 1.5, 0.75, [0.6, 0.9]);
      leaf(t, trunk[P.nT], tp.x, tp.y + 0.3 * sc, tp.z, (0.7 + 0.2 * R()) * sc);
    } else {                                               // snag: bare limbs
      branch(trunk[P.nT - 1], 1 + (R() < 0.6 ? 1 : 0), 0.4, 1.0, 0.8, 1.4, 0.55, null);
      branch(trunk[P.nT], 1 + (R() < 0.5 ? 1 : 0), 0.5, 1.1, 0.6, 1.1, 0.6, null);
    }
    let cr = 0.8, top = tp.y;
    for (const l of t.leaf) { cr = Math.max(cr, M.len2(l.x - x, l.z - z) + l.r); top = Math.max(top, l.y + l.r); }
    for (const g of t.seg) { cr = Math.max(cr, M.len2(g.b.x - x, g.b.z - z) + g.r1); top = Math.max(top, g.b.y); }
    t.crown = cr; t.top = top;
    t.leaf0 = 0; for (const l of t.leaf) t.leaf0 += l.r * l.r;
    return t;
  }

  /* place trees on free spots (soil with grass for the leafy species), >= SEP apart and clear of worms / props */
  TR.populate = function (S, taken) {
    S.trees = [];
    const w = W(), st = S.veg, sp = SPN.indexOf(K.SPECIES[S.biome] || 'oak'), N = K.COUNT[S.biome] || 0;
    if (!N) return;
    const rg = M.rng_make(((S.settings.seed | 0) * 7919 + 101) >>> 0), P = K.SPEC[SPN[sp]];
    for (let tries = 0; tries < 6000 && S.trees.length < N; tries++) {
      const x = 6 + M.rng_next(rg) * 84, z = 6 + M.rng_next(rg) * 84, top = w.topHeight(x, z);
      if (top < w.SEA + 1.2) continue;
      const i = Math.round(x / w.H), k = Math.round(z / w.H), c = k * w.NX + i;
      const m = w.mat_at(x, top - 0.2, z);
      // oaks need grass (soil); spruce also takes the thin soil / scree / rock of the lower alpine slopes (real
      // montane conifers do, snow-covered in winter; LS1 smaller islands left too little grass: 3 trees on alpine 7)
      const conifer = sp === 1 && (m === C.MAT.SOIL || m === C.MAT.SCREE || m === C.MAT.ROCK || m === C.MAT.SNOW) && top < w.SEA + 14;
      if (sp <= 1 ? !(st && st.fuel[c] > 0.35) && !conifer : w.topJ[c] <= 0) continue;
      if (m === C.MAT.LAVA || m === C.MAT.ICE || m === C.MAT.BEDROCK) continue;
      let ok = true;
      for (const [dx, dz] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) if (Math.abs(w.topHeight(x + dx, z + dz) - top) > 0.5) ok = false;
      if (!ok) continue;
      const F = w.features;
      if ((F.volcanoes || []).some(v => M.len2(x - v.x, z - v.z) < v.Rc + 4)) continue;
      if (SS.sim.near_lava && SS.sim.near_lava(S, x, z)) continue;
      if (S.water && S.water.h[c] > 0.004) continue;
      if (taken.some(p => M.len2(p.x - x, p.z - z) < K.SEP)) continue;
      if (S.worms.some(o => M.len2(o.pos.x - x, o.pos.z - z) < K.WORM_SEP) || S.bodies.some(o => M.len2(o.pos.x - x, o.pos.z - z) < 2 + o.rb)) continue;
      const t = grow(rg, sp, x, top, z);
      // room for the crown: no rock in the trunk line or around the crown
      for (let yy = 1; yy < t.h && ok; yy += 0.8) if (w.sample(x, top + yy, z) > 0) ok = false;
      for (let a = 0; a < 6 && ok; a++) { const an = a * M.TAU / 6; if (w.sample(x + M.cos(an) * t.crown * 0.75, top + t.h * 0.65, z + M.sin(an) * t.crown * 0.75) > 0) ok = false; }
      // M: keep clear of steel bridges (crown + 1 m from the truss, horizontally, when the tree reaches its deck)
      if (ok && SS.struct && SS.struct.near(S, x, z, t.crown + 1, top + t.h)) ok = false;
      if (!ok) continue;
      t.id = S.trees.length + 1;
      const dry = st ? st.surf[c * 4 + 1] / 255 : 0.3;
      t.dry = M.clamp(P.dry[0] + P.dry[1] * dry, 0, 1);
      t.thr = K.IGNITE + K.IGNITE_GREEN * (1 - t.dry);
      if (S.biome === 'volcanic') t.char = 0.6;            // fire-killed snags
      S.trees.push(t);
      taken.push({ x, y: top, z });
    }
  };

  /* ---------- breaking ---------- */
  function subtree(t, s) {
    const m = new Uint8Array(t.seg.length); m[s] = 1;
    for (let i = s + 1; i < t.seg.length; i++) if (t.seg[i].on && m[t.seg[i].p]) m[i] = 1;
    return m;
  }
  /* segment s and everything above it leave the tree as one rigid body */
  function detach(S, t, s, c, Wkg, why) {
    const m = subtree(t, s), sgs = [], lvs = [];
    let mass = 0, wood = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < t.seg.length; i++) if (m[i]) {
      const g = t.seg[i], ra = (g.r0 + g.r1) / 2, mi = K.WOOD_KG * Math.PI * ra * ra * dist3(g.a, g.b);
      mass += mi; wood += mi; cx += mi * (g.a.x + g.b.x) / 2; cy += mi * (g.a.y + g.b.y) / 2; cz += mi * (g.a.z + g.b.z) / 2;
      sgs.push(g); g.on = 0;
    }
    for (const l of t.leaf) if (m[l.s]) {
      if (l.f > 0.02) { const lm = K.LEAF_KG * l.r * l.r * l.r * l.f; mass += lm; cx += lm * l.x; cy += lm * l.y; cz += lm * l.z; lvs.push({ x: l.x, y: l.y, z: l.z, r: l.r, f: l.f }); }
      l.f = 0; l.s = -1;
    }
    if (s === 0) t.alive = 0;
    if (wood < K.MIN_KG) return null;                      // twigs: gone
    const com = v(cx / mass, cy / mass, cz / mass), pts = [], pm = [];
    let n = 0; for (const g of sgs) n += Math.max(1, Math.ceil(dist3(g.a, g.b) / Math.max(0.3, g.r0 + g.r1)));
    const sp = n > 40 ? n / 40 : 1;
    for (const g of sgs) {
      const len = dist3(g.a, g.b), ra = (g.r0 + g.r1) / 2, k = Math.max(1, Math.round(Math.ceil(len / Math.max(0.3, g.r0 + g.r1)) / sp)), mi = K.WOOD_KG * Math.PI * ra * ra * len / k;
      for (let q = 0; q < k; q++) { const u = (q + 0.5) / k; pts.push(g.a.x + (g.b.x - g.a.x) * u - com.x, g.a.y + (g.b.y - g.a.y) * u - com.y, g.a.z + (g.b.z - g.a.z) * u - com.z, Math.max(0.06, ra)); pm.push(mi); }
    }
    for (const l of lvs) { pts.push(l.x - com.x, l.y - com.y, l.z - com.z, l.r * 0.45); pm.push(K.LEAF_KG * l.r * l.r * l.r * l.f); }
    const Ib = v(0, 0, 0);
    for (let i = 0; i < pm.length; i++) { const x = pts[i * 4], y = pts[i * 4 + 1], z = pts[i * 4 + 2]; Ib.x += pm[i] * (y * y + z * z); Ib.y += pm[i] * (x * x + z * z); Ib.z += pm[i] * (x * x + y * y); }
    Ib.x = Math.max(Ib.x, 0.05 * mass); Ib.y = Math.max(Ib.y, 0.05 * mass); Ib.z = Math.max(Ib.z, 0.05 * mass);
    const b = SS.bodies.add_shape(S, 'log', com, mass, Ib, pts, C.MAT.SOIL);
    b.vol = wood / K.WOOD_KG; b.mu = 0.7; b.e = 0.1;
    const rel = p => v(p.x - com.x, p.y - com.y, p.z - com.z);
    b.log = { tree: t.id, sp: t.sp, char: t.char, segs: sgs.map(g => ({ a: rel(g.a), b: rel(g.b), r0: g.r0, r1: g.r1, kind: g.kind })), leaves: lvs.map(l => Object.assign(rel(l), { r: l.r, f: l.f })) };
    if (c) SS.bodies.blast(S, c, Wkg, [b]);
    SS.sim.emit(S, 'treebreak', { tree: t.id, seg: s, body: b.id, why, x: com.x, y: com.y, z: com.z, mass });
    return b;
  }
  /* T1: the root system holds the tree. Roots spread over a plate of radius ROOT_R_K x crown (>= ROOT_R_MIN) and
   * ROOT_D deep; the tree only falls when less than ROOT_HOLD of that plate still has ground (probes: centre +
   * 3 rings x 8 azimuths x 2 depths + the tap root TAP_D deep). Thick roots are far stronger than soil: a crater beside the tree blows the
   * soil out but leaves the roots (exposed) anchored in the ground around it. */
  TR.root_r = t => Math.max(K.ROOT_R_MIN, K.ROOT_R_K * t.crown);
  function root_hold(t) {
    const w = W(), R = TR.root_r(t);
    let n = 0, s = 0;
    n++; if (w.sample(t.x, t.y - K.TAP_D, t.z) > 0) s++;      // tap root
    for (const dy of [0.3, K.ROOT_D]) {
      n++; if (w.sample(t.x, t.y - dy, t.z) > 0) s++;
      for (const f of [0.5, 0.75, 1]) for (let a = 0; a < 8; a++) {
        const an = (a + 0.5 * f) * M.TAU / 8; n++;
        if (w.sample(t.x + M.cos(an) * R * f, t.y - dy, t.z + M.sin(an) * R * f) > 0) s++;
      }
    }
    return s / n;
  }
  TR.root_hold = root_hold;
  const supported = t => root_hold(t) >= K.ROOT_HOLD;
  const shield = (c, p) => 0.25 + 0.75 * M.exp(-W().solid_len(c.x, c.y, c.z, p.x, p.y, p.z) / BC.SHIELD_L);
  /* T2: slender parts (wood, leaves) are pushed by the blast WIND: drag of the dynamic pressure q, not the side-on
   * pressure. q / p = 2.5 p / (p + 7 p0) (Rankine-Hugoniot, ideal air): ~1.5 next to a 1 kg charge (p ~ 1 MPa),
   * 0.3 at 3 m (100 kPa), ~0.1 at 8 m; factor = Cd q / p (Cd DRAG_CD) scales the side-on impulse I. */
  const windK = (d, Wkg) => { const p = SS.blast.overpressure_z(Math.max(0.05, d) / M.cbrt(Wkg)); return K.DRAG_CD * 2.5 * p / (p + 7 * 101.3); };
  // scratch (per segment): impulse sum J and first moment sum p x J; mass m, first mass moment m p, second m |p|^2
  let JX = new Float64Array(64), JY = new Float64Array(64), JZ = new Float64Array(64), MX = new Float64Array(64), MY = new Float64Array(64), MZ = new Float64Array(64);
  let MS = new Float64Array(64), PX = new Float64Array(64), PY = new Float64Array(64), PZ = new Float64Array(64), Q2 = new Float64Array(64);
  function mass(s, x, y, z, m, extra) { MS[s] += m; PX[s] += m * x; PY[s] += m * y; PZ[s] += m * z; Q2[s] += m * (x * x + y * y + z * z) + (extra || 0); }
  function load(s, p, ux, uy, uz, J) {
    const jx = ux * J, jy = uy * J, jz = uz * J;
    JX[s] += jx; JY[s] += jy; JZ[s] += jz;
    MX[s] += p.y * jz - p.z * jy; MY[s] += p.z * jx - p.x * jz; MZ[s] += p.x * jy - p.y * jx;
  }

  TR.blast = function (S, c, Wkg) {
    if (!S.trees || !S.trees.length) return;
    const BL = SS.blast, reach = 8 * M.cbrt(Wkg), cut = K.CUT_K * M.cbrt(Wkg);
    for (const t of S.trees) {
      if (!t.alive || M.len2(t.x - c.x, t.z - c.z) > reach + t.crown || Math.abs(c.y - t.y) > reach + t.h) continue;
      const ns = t.seg.length;
      if (JX.length < ns) { JX = new Float64Array(ns); JY = new Float64Array(ns); JZ = new Float64Array(ns); MX = new Float64Array(ns); MY = new Float64Array(ns); MZ = new Float64Array(ns); MS = new Float64Array(ns); PX = new Float64Array(ns); PY = new Float64Array(ns); PZ = new Float64Array(ns); Q2 = new Float64Array(ns); }
      for (let i = 0; i < ns; i++) JX[i] = JY[i] = JZ[i] = MX[i] = MY[i] = MZ[i] = MS[i] = PX[i] = PY[i] = PZ[i] = Q2[i] = 0;
      let stripped = 0, hit = false;
      const rel = p => v(p.x - t.x, p.y - t.y, p.z - t.z);  // moments about the root (small numbers)
      for (const l of t.leaf) {
        if (l.f <= 0 || l.s < 0 || !t.seg[l.s].on) continue;
        const d0 = dist3(c, l), d = Math.max(0.3, d0 - 0.5 * l.r), I = BL.impulse(d, Wkg) * shield(c, l), wk = windK(d, Wkg);
        if (I < BC.LEAF_I * 0.5) continue;
        hit = true;
        // T2: leaves go first. The stripped share is torn off and flies away with its momentum: only LEAF_HOLD of
        // its impulse reaches the branch (the stalks' strength), the leaves that stay pass all of theirs.
        const sf = M.clamp((I - BC.LEAF_I) / BC.LEAF_SPAN, 0, 1), f0 = l.f;
        l.f *= 1 - sf; stripped += (f0 - l.f) * l.r * l.r;
        const J = I * wk * Math.PI * l.r * l.r * K.POROSITY * (l.f + K.LEAF_HOLD * (f0 - l.f)), inv = 1 / Math.max(1e-3, d0);
        load(l.s, rel(l), (l.x - c.x) * inv, (l.y - c.y) * inv, (l.z - c.z) * inv, J);
      }
      const cutS = new Uint8Array(ns);
      // T1: a DIRECT hit on the lower stem (burst within cut + r of the stem from the roots up to STEM_LOW m) destroys
      // the stump and the roots; anything else leaves them in the ground
      // A charge cuts wood up to the diameter CUT_D sqrt(W) (timber-cutting rule, US Army FM 5-25: P = D^2 / 250 lb,
      // D in inches, untamped external charge ~ 0.6 sqrt(kg) m; 0.7 with the casing fragments)
      const dCut = K.CUT_D * Math.sqrt(Wkg), g0 = t.seg[0], lowTop = v(t.x, t.y + K.STEM_LOW, t.z);
      const direct = g0.on && segd(c, g0.a, lowTop) < cut + g0.r0 && 2 * (t.seg[1] ? t.seg[1].r0 : g0.r1) <= dCut;
      if (direct) { cutS[0] = 1; hit = true; }
      for (let i = 1; i < ns; i++) {
        const g = t.seg[i]; if (!g.on) continue;
        const ds = segd(c, g.a, g.b), ra = (g.r0 + g.r1) / 2;
        if (ds < cut + ra && 2 * ra <= dCut) { cutS[i] = 1; hit = true; }
        const mid = v((g.a.x + g.b.x) / 2, (g.a.y + g.b.y) / 2, (g.a.z + g.b.z) / 2), d0 = dist3(c, mid);
        const I = BL.impulse(Math.max(0.2, ds - ra), Wkg) * shield(c, mid);
        if (I < 2) continue;
        hit = true;
        const inv = 1 / Math.max(1e-3, d0);
        load(i, rel(mid), (mid.x - c.x) * inv, (mid.y - c.y) * inv, (mid.z - c.z) * inv, I * windK(Math.max(0.2, ds - ra), Wkg) * 2 * ra * dist3(g.a, g.b));
      }
      if (!hit) continue;
      // masses (wood + the leaves still on) for the dynamic response
      for (let i = 1; i < ns; i++) {
        const g = t.seg[i]; if (!g.on) continue;
        const L = dist3(g.a, g.b), ra = (g.r0 + g.r1) / 2, m = K.WOOD_KG * Math.PI * ra * ra * L, mid = rel(v((g.a.x + g.b.x) / 2, (g.a.y + g.b.y) / 2, (g.a.z + g.b.z) / 2));
        mass(i, mid.x, mid.y, mid.z, m, m * L * L / 12);
      }
      for (const l of t.leaf) if (l.f > 0 && l.s > 0 && t.seg[l.s].on) { const p = rel(l); mass(l.s, p.x, p.y, p.z, K.LEAF_KG * l.r * l.r * l.r * l.f, 0); }
      // children first (parents have lower indices): break or pass the load down. T2 dynamic response: a blast
      // impulse (~ms) is far shorter than any natural period, so the part + everything still attached above it gets
      // the angular momentum H (bending part of sum (p - a) x J about its base a) and swings like a rotational
      // spring: peak bending moment = H w, w = sqrt(k / J), k = 3 E I / Lc, I = pi r0^4 / 4 (Lc = base to the subtree's centre of
      // mass), J = its moment of inertia about a. It breaks when that exceeds the section's strength MOR pi r0^3 / 4
      // (weaker when charred). Light stiff twigs / branches (w ~ 100+ rad/s) take ~10x the moment of the heavy slow
      // trunk (w ~ 20 rad/s) per unit impulse: leaves go first, then branches and the top, the trunk last.
      const weak = 1 - K.CHAR_WEAK * t.char, broke = [];
      for (let i = ns - 1; i >= 1; i--) {
        const g = t.seg[i]; if (!g.on) continue;
        const a = rel(g.a), ax = g.b.x - g.a.x, ay = g.b.y - g.a.y, az = g.b.z - g.a.z, al = M.len3(ax, ay, az) || 1;
        // moment about a: sum (p - a) x J = M - a x J
        const mx = MX[i] - (a.y * JZ[i] - a.z * JY[i]), my = MY[i] - (a.z * JX[i] - a.x * JZ[i]), mz = MZ[i] - (a.x * JY[i] - a.y * JX[i]);
        const along = (mx * ax + my * ay + mz * az) / al, bx = mx - along * ax / al, by = my - along * ay / al, bz = mz - along * az / al;
        const Hb = M.len3(bx, by, bz), m = Math.max(1e-3, MS[i]);
        const Jb = Math.max(1e-3, Q2[i] - 2 * (a.x * PX[i] + a.y * PY[i] + a.z * PZ[i]) + m * (a.x * a.x + a.y * a.y + a.z * a.z));
        const Lc = Math.max(0.3 * al, M.len3(PX[i] / m - a.x, PY[i] / m - a.y, PZ[i] / m - a.z));
        const r0 = g.r0, w = Math.sqrt(3 * K.WOOD_E * Math.PI * r0 * r0 * r0 * r0 / (4 * Lc) / Jb);   // k = 3 E I / Lc (cantilever)
        g.mDyn = Hb * w; g.mMax = K.WOOD_MOR * Math.PI * r0 * r0 * r0 / 4 * weak * (g.kind === 2 ? K.JOINT : 1);   // (tools: last ratio)
        if (cutS[i] || g.mDyn > g.mMax) { broke.push(i); g.brk = 1; continue; }
        const p = g.p; JX[p] += JX[i]; JY[p] += JY[i]; JZ[p] += JZ[i]; MX[p] += MX[i]; MY[p] += MY[i]; MZ[p] += MZ[i];
        MS[p] += MS[i]; PX[p] += PX[i]; PY[p] += PY[i]; PZ[p] += PZ[i]; Q2[p] += Q2[i];
      }
      // T2: every broken segment leaves as its OWN piece (broke[] runs from the highest index down, so twigs and side
      // branches go first, then the top, then the trunk with whatever unbroken limbs it still carries)
      if (direct && t.seg[1] && t.seg[1].on && !t.seg[1].brk) { t.seg[1].brk = 1; broke.push(1); cutS[1] = 1; }
      for (const i of broke) { const g = t.seg[i]; g.brk = 0; if (g.on) detach(S, t, i, c, Wkg, cutS[i] ? 'cut' : 'snap'); }
      if (direct) {                                         // stump + roots shattered: nothing stays in the crater
        const g = t.seg[0]; g.on = 0; t.alive = 0;
        for (const l of t.leaf) if (l.s === 0) { l.f = 0; l.s = -1; }
        SS.sim.emit(S, 'treeshatter', { tree: t.id, x: t.x, y: t.y, z: t.z, r: g.r0 });
      }
      if (stripped > 0.02) SS.sim.emit(S, 'leafstrip', { tree: t.id, x: t.x, y: t.y + t.h * 0.7, z: t.z, amount: stripped });
      if (t.alive && !supported(t)) { detach(S, t, 0, c, Wkg, 'uproot'); SS.sim.emit(S, 'uproot', { tree: t.id, x: t.x, y: t.y, z: t.z }); }
    }
  };
  /* terrain edited without a blast (collapse, chunk detach): trees left without ground fall */
  TR.on_edit = function (S, i0, k0, i1, k1) {
    if (!S.trees) return;
    const H = W().H;
    for (const t of S.trees) {
      if (!t.alive) continue;
      const i = t.x / H, k = t.z / H;
      if (i < i0 - 2 || i > i1 + 2 || k < k0 - 2 || k > k1 + 2) continue;
      if (!supported(t)) { detach(S, t, 0, null, 0, 'uproot'); SS.sim.emit(S, 'uproot', { tree: t.id, x: t.x, y: t.y, z: t.z }); }
    }
  };

  /* ---------- fire ---------- */
  function ignite(S, t, why) {
    if (t.burn >= 0 || t.char >= 1 || !t.alive) return;
    t.burn = 0; t.heat = 0;
    SS.sim.emit(S, 'treefire', { tree: t.id, x: t.x, y: t.y + t.h * 0.6, z: t.z, why });
    if (!S._treeLogT || S.time - S._treeLogT > 5) { S._treeLogT = S.time; SS.sim.log(S, 'A tree goes up in flames!', 0xffb060); }
  }
  /* a fireball of radius r (already scaled by veg's HEAT_K) heats the crowns / trunks it reaches */
  TR.heat_burst = function (S, c, r) {
    if (!S.trees) return;
    for (const t of S.trees) {
      if (!t.alive || t.burn >= 0 || M.len2(t.x - c.x, t.z - c.z) > r + t.crown) continue;
      let best = 1e9;
      for (const l of t.leaf) if (l.f > 0.05) best = Math.min(best, dist3(c, l) - l.r);
      for (const g of t.seg) if (g.on) best = Math.min(best, segd(c, g.a, g.b) - g.r0);
      if (best > r) continue;
      t.heat += K.FIREBALL_HEAT * Math.sqrt(1 - Math.max(0, best) / r);
      if (t.heat >= t.thr) ignite(S, t, 'fireball');
    }
  };
  /* lightning (5d): the bolt hits the highest point of the tree; 70 % of every leaf is stripped, the topmost thin
   * segment may snap off (o.breakTop, decided by the caller's RNG), and the tree burns whatever its moisture.
   * Returns the strike point (the caller adds the W 0.25 burst there) or null. */
  TR.top_point = function (t) {
    let best = null;
    for (let i = 0; i < t.seg.length; i++) { const g = t.seg[i]; if (g.on && (!best || g.b.y > best.y)) best = { x: g.b.x, y: g.b.y, z: g.b.z, s: i }; }
    return best;
  };
  TR.strike = function (S, t, o) {
    if (!t || !t.alive) return null;
    const p = TR.top_point(t);
    if (!p) return null;
    for (const l of t.leaf) if (l.s >= 0) l.f *= 1 - K.STRIKE_STRIP;
    if (o && o.breakTop && p.s > 0 && t.seg[p.s].r0 < K.STRIKE_BREAK_R) detach(S, t, p.s, p, 0.25, 'lightning');
    ignite(S, t, 'lightning');
    SS.sim.emit(S, 'treestrike', { tree: t.id, x: p.x, y: p.y, z: p.z });
    return p;
  };
  function leafLeft(t) { let a = 0; for (const l of t.leaf) if (l.s >= 0) a += l.f * l.r * l.r; return a; }
  /* one fire tick (C.FIRE_TICK) — called by veg.js after the grass tick */
  TR.tick = function (S, TK) {
    if (!S.trees || !S.trees.length) return;
    const st = S.veg, w = W(), n = st ? st.n : 0, H = w.H, lv = S.lava;
    for (const t of S.trees) {
      if (!t.alive) continue;
      const rc = M.clamp(Math.round(t.z / H), 0, n - 1) * n + M.clamp(Math.round(t.x / H), 0, n - 1);
      if (t.burn >= 0) {
        if (S.water && S.water.h[rc] > 0.05) { t.burn = -1; t.heat = 0; SS.sim.emit(S, 'steam', { x: t.x, y: t.y + 0.5, z: t.z, power: 0.6 }); continue; }
        t.burn += TK;
        for (const l of t.leaf) if (l.s >= 0 && l.f > 0) l.f = Math.max(0, l.f - TK / K.LEAF_BURN_T);
        t.char = Math.min(1, t.char + TK / K.BURN_T);
        const I = TR.intensity(t);
        // embers on the grass under the crown, heat on neighbours, props in the flames
        if (st && (t.emb++ % 5) === 0) SS.veg.ignite_disc(S, t.x, t.y, t.z, Math.min(2.5, t.crown * 0.7), 0.8);
        for (const o of S.trees) if (o !== t && o.alive && o.burn < 0 && o.char < 1 && M.len2(o.x - t.x, o.z - t.z) < t.crown + o.crown + 0.5) { o.heat += K.TREE_HEAT * I * TK; if (o.heat >= o.thr) ignite(S, o, 'spread'); }
        for (const b of S.bodies) if (b.prop && b.burn < 0 && M.len2(b.pos.x - t.x, b.pos.z - t.z) < K.FIRE_R + b.rb && b.pos.y < t.y + 1.5 && SS.scatter) SS.scatter.ignite(S, b);
        if (t.char >= 1) { t.burn = -2; for (const l of t.leaf) l.f = 0; SS.sim.emit(S, 'treeburnt', { tree: t.id, x: t.x, y: t.y + t.h * 0.5, z: t.z }); }
        continue;
      }
      if (t.burn === -2 || t.char >= 1) continue;
      t.heat = Math.max(0, t.heat - K.COOL * TK);
      // burning grass around the root
      if (st && st.nAct) {
        const i0 = Math.round(t.x / H), k0 = Math.round(t.z / H);
        for (let dk = -3; dk <= 3; dk++) for (let di = -3; di <= 3; di++) {
          const q = (k0 + dk) * n + i0 + di; if (q < 0 || q >= n * n || st.burnT[q] <= 0) continue;
          t.heat += K.GRASS_HEAT * st.burnI[q] * TK;
        }
      }
      if (lv && lv.h[rc] > 0.02 && lv.T[rc] > 0.3) t.heat = Math.max(t.heat, t.thr);
      if (t.heat >= t.thr) ignite(S, t, 'grass');
    }
  };
  TR.intensity = t => (t.burn < 0 ? 0 : Math.min(1, t.burn / 3) * (0.55 + 0.45 * (t.leaf0 > 0 ? Math.min(1, leafLeft(t) / t.leaf0) : 0)));
  /* flame intensity at a worm's centre: next to a burning trunk or inside a burning crown */
  TR.fire_at = function (S, x, y, z) {
    if (!S.trees) return 0;
    let I = 0;
    for (const t of S.trees) {
      if (t.burn < 0 || !t.alive) continue;
      if (M.len2(x - t.x, z - t.z) < K.FIRE_R && y > t.y - 0.5 && y < t.top) I = Math.max(I, TR.intensity(t));
      for (const l of t.leaf) if (l.f > 0.05 && dist3(l, v(x, y, z)) < l.r) I = Math.max(I, TR.intensity(t));
    }
    return I;
  };

  /* ---------- gameplay plane: standing wood crossing slice zero ---------- */
  TR.plane_sections = function (S) {
    if (!S.trees || !S.trees.length) return;
    const P = SS.plane, n = P.nrm(S), d = P.dir(S), ox = S.O.x, oz = S.O.z, PB = S.planeBodies;
    for (const t of S.trees) {
      if (!t.alive) continue;
      if (Math.abs((t.x - ox) * n.x + (t.z - oz) * n.z) > t.crown + 0.3) continue;
      for (let i = 0; i < t.seg.length; i++) {
        const g = t.seg[i]; if (!g.on || g.r0 < K.SOLID_R) continue;
        const ta = (g.a.x - ox) * n.x + (g.a.z - oz) * n.z, tb = (g.b.x - ox) * n.x + (g.b.z - oz) * n.z, r = Math.max(g.r0, g.r1);
        let u0, u1;
        if (Math.abs(ta - tb) < 1e-4) { if (Math.abs(ta) >= r) continue; u0 = 0; u1 = 1; }
        else { const a = (ta - r) / (ta - tb), b = (ta + r) / (ta - tb); u0 = Math.max(0, Math.min(a, b)); u1 = Math.min(1, Math.max(a, b)); if (u1 <= u0) continue; }
        const pa = v(g.a.x + (g.b.x - g.a.x) * u0, g.a.y + (g.b.y - g.a.y) * u0, g.a.z + (g.b.z - g.a.z) * u0);
        const pb = v(g.a.x + (g.b.x - g.a.x) * u1, g.a.y + (g.b.y - g.a.y) * u1, g.a.z + (g.b.z - g.a.z) * u1);
        const sa = (pa.x - ox) * d.x + (pa.z - oz) * d.z, sb = (pb.x - ox) * d.x + (pb.z - oz) * d.z;
        const tm = Math.min(Math.abs(ta + (tb - ta) * (u0 + u1) / 2), r * 0.95), hw = Math.sqrt(r * r - tm * tm);
        const s0 = Math.min(sa, sb) - hw, s1 = Math.max(sa, sb) + hw, y0 = Math.min(pa.y, pb.y) - (i ? r * 0.5 : 0), y1 = Math.max(pa.y, pb.y) + r * 0.5;
        PB.push({ s: (s0 + s1) / 2, y: (y0 + y1) / 2, kind: 1, hs: (s1 - s0) / 2, hy: (y1 - y0) / 2, r: 0, ref: null, tree: t.id, seg: i });
      }
    }
  };
  TR.stats = function (S) {
    let alive = 0, segs = 0, leaves = 0, burning = 0, burnt = 0;
    for (const t of S.trees || []) { if (!t.alive) continue; alive++; burning += t.burn >= 0 ? 1 : 0; burnt += t.char >= 1 ? 1 : 0; for (const g of t.seg) segs += g.on; for (const l of t.leaf) leaves += l.s >= 0 ? l.f : 0; }
    return { trees: alive, segs, leaves: +leaves.toFixed(2), burning, burnt };
  };
})(window.SS = window.SS || {});
