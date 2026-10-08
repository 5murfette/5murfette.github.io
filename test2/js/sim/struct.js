/* sim/struct.js — steel structures (Step M3): Warren-truss footbridges over gaps (ravines, inlets, lava canals),
 * placed per map by a deterministic search (no RNG). Deterministic, engine-agnostic; render/struct.js draws them.
 * A structure is a graph: nodes (x, y, z, anchor = rests on the ground at an abutment) and members (a, b, kind:
 * 0 chord, 1 diagonal, 2 cross beam, 3 deck plate; section w x h, steel area A, mass, on, dmg). Geometry (C.STRUCT):
 * through truss, two side trusses W apart, panel ~PANEL m, depth span / 10 clamped DEPTH_MIN-DEPTH_MAX, top nodes at
 * the half panels (Warren), cross beams at every bottom node, an 8 mm checker-plate deck panel between them.
 * Steel (research, §8 "Steel structures (M)"): 7850 kg/m3, S235 yield; hollow sections SHS 180x6 chords, 100x5
 * diagonals, 150x6 cross beams. A nearby blast hardly bends such members (a grenade 1 m from a chord gives it ~15 J
 * against ~27 kJ of plastic hinge capacity): steel is CUT by close charges. Cutting charge (US Army FM 5-25, structural
 * steel) P = 3/8 A lb TNT, A in in²; a charge W at standoff ds delivers W x exp(-max(0, ds - r) / CUT_L): each blast
 * adds that / P to the member's damage, cut at >= 1 (a grenade on a chord: ~0.9; two cut it; a diagonal goes with one).
 * A deck panel is holed when a charge within DECK_R of it cuts a 0.5 m strip (P for t x 0.5 m).
 * Stability: a side truss holds panel i while its bottom chord there, a diagonal of the panel and a top chord at its
 * top node remain; the bridge fails at a panel where BOTH sides fail, or when an abutment loses its ground; the span
 * hangs on pinned bearings, so a failed span comes down: it is released as rigid bodies (one per piece between failed
 * panels; SS.bodies 'struct', spheres along its members), with the blast's momentum.
 * Gameplay plane: members crossing slice zero are solid (S.planeBodies: boxes for flat members, discs along steep
 * ones). Events 'steelcut' {x, y, z, kind}, 'bridgefall' {id, pieces}.
 * C layout: struct Node { vec3 p; u8 anchor; }; struct Mem { i32 a, b; u8 kind, on; f32 w, h, A, mass, dmg; };
 *   struct Struct { i32 id, n; Node nodes[]; Mem mem[]; u8 look; u32 ver; };  API: populate(S, taken), blast(S, c, W),
 *   plane_sections(S), on_edit(S) (abutment check), stats(S). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, K = C.STRUCT;
  const ST = SS.struct = {};
  const W = () => SS.world;
  const IN2 = 1 / 0.00064516;                       // m² -> in²
  const SEC = [                                     // per kind: section w, h (m), steel area (m²), Zp-free
    { w: 0.18, h: 0.18, A: 4 * 0.18 * 0.006 },       // chord SHS 180x6
    { w: 0.10, h: 0.10, A: 4 * 0.10 * 0.005 },       // diagonal SHS 100x5
    { w: 0.15, h: 0.15, A: 4 * 0.15 * 0.006 },       // cross beam SHS 150x6
    { w: 0, h: 0.008, A: 0 }                         // deck plate (w = deck width, A per 0.5 m strip below)
  ];
  const len = (a, b) => M.len3(b.x - a.x, b.y - a.y, b.z - a.z);
  function segd(p, a, b) {
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const u = M.sat(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / (abx * abx + aby * aby + abz * abz || 1));
    return M.len3(p.x - a.x - abx * u, p.y - a.y - aby * u, p.z - a.z - abz * u);
  }

  /* ---------- placement: the best gap to span ---------- */
  function ledge(x, z) {
    const w = W(), y = w.top_at(x, z);
    if (w.outside(x, z) || y < w.SEA + 0.6) return null;
    for (let a = 0; a < 6.28; a += 1.05) if (Math.abs(w.top_at(x + M.cos(a) * 1.2, z + M.sin(a) * 1.2) - y) > 0.6) return null;
    for (let h = 1; h <= 6; h += 1) if (w.sample(x, y + h, z) > 0) return null;
    return { x, y, z };
  }
  function scoreSpan(A, B, avoid) {
    const w = W(), L = M.len2(B.x - A.x, B.z - A.z);
    if (L < K.SPAN_MIN || L > K.SPAN_MAX || Math.abs(A.y - B.y) > K.DY_MAX) return -1;
    const h = M.clamp(L / 10, K.DEPTH_MIN, K.DEPTH_MAX);
    // quick: the middle must be a real gap
    const mx = (A.x + B.x) / 2, mz = (A.z + B.z) / 2, my = (A.y + B.y) / 2;
    if (my - w.top_at(mx, mz) < K.GAP_MIN) return -1;
    let gap = 0, n = 0, low = 0, wet = 0;
    for (let t = 1.5 / L; t < 1 - 1.5 / L; t += 0.5 / L) {
      const x = A.x + (B.x - A.x) * t, z = A.z + (B.z - A.z) * t, y = A.y + (B.y - A.y) * t + 0.15;
      const g = w.top_at(x, z); n++;
      if (y - g >= K.GAP_MIN) low++;
      gap += Math.min(8, y - g);
      // clear passage: no rock through the truss (both side planes) or just under the deck
      for (const s of [-1, 1]) {
        const vx = -(B.z - A.z) / L * s * K.WIDTH / 2, vz = (B.x - A.x) / L * s * K.WIDTH / 2;
        for (let yy = y - 0.2; yy <= y + h + 0.4; yy += 0.45) if (w.sample(x + vx, yy, z + vz) > 0) return -1;
      }
      if (SS.sim.surface_at(S_ref, x, z) > g + 0.2 || (SS.lava && S_ref.lava && SS.lava.depth_at(S_ref, x, z) > 0.05)) wet++;
    }
    if (n < 4 || low < 0.6 * n) return -1;
    for (const p of avoid) if (segd(p, { x: A.x, y: p.y, z: A.z }, { x: B.x, y: p.y, z: B.z }) < 3) return -1;
    return (gap / n) * Math.min(L, 16) * (1 + 0.5 * wet / n);
  }
  let S_ref = null;
  function findSpans(S, taken) {
    const w = W(), pts = [], out = [];
    const cx = w.dry ? C.DRY.CX : 48, cz = w.dry ? C.DRY.CZ : 48;
    for (let z = 10; z <= 86; z += K.GRID) for (let x = 10; x <= 86; x += K.GRID) {
      if (M.len2(x - cx, z - cz) > K.PLACE_R) continue;
      const p = ledge(x, z); if (p) pts.push(p);
    }
    const cand = [];
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const s = scoreSpan(pts[i], pts[j], taken);
      if (s > 0) cand.push({ A: pts[i], B: pts[j], s, n: cand.length });
    }
    cand.sort((a, b) => b.s - a.s || a.A.x - b.A.x || a.A.z - b.A.z || a.n - b.n);   // total order (n: insertion; C qsort is not stable)
    for (const c of cand) {
      if (out.length >= K.MAX_PER_MAP) break;
      const mid = { x: (c.A.x + c.B.x) / 2, z: (c.A.z + c.B.z) / 2 };
      if (out.some(o => M.len2((o.A.x + o.B.x) / 2 - mid.x, (o.A.z + o.B.z) / 2 - mid.z) < K.SEPARATE)) continue;
      out.push(c);
    }
    return out;
  }

  /* ---------- building a Warren through-truss from A to B ---------- */
  function build(S, A, B, look) {
    const L = M.len2(B.x - A.x, B.z - A.z), ux = (B.x - A.x) / L, uz = (B.z - A.z) / L, vx = -uz, vz = ux;
    const n = Math.max(3, Math.round(L / K.PANEL)), p = L / n, h = M.clamp(L / 10, K.DEPTH_MIN, K.DEPTH_MAX), hw = K.WIDTH / 2;
    const st = { id: S.structId = (S.structId || 0) + 1, kind: 'truss', look, n, L, h, ux, uz, A: { x: A.x, y: A.y, z: A.z }, B: { x: B.x, y: B.y, z: B.z }, nodes: [], mem: [], ver: 1, fallen: false };
    const node = (x, y, z) => { st.nodes.push({ x, y, z, anchor: 0 }); return st.nodes.length - 1; };
    const yAt = t => A.y + (B.y - A.y) * t + K.DECK_LIFT;
    const bot = [[], []], top = [[], []], cen = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = A.x + ux * L * t, z = A.z + uz * L * t, y = yAt(t);
      for (let s = 0; s < 2; s++) { const sg = s ? 1 : -1; bot[s].push(node(x + vx * hw * sg, y, z + vz * hw * sg)); }
      cen.push(node(x, y, z));
    }
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n, x = A.x + ux * L * t, z = A.z + uz * L * t, y = yAt(t) + h;
      for (let s = 0; s < 2; s++) { const sg = s ? 1 : -1; top[s].push(node(x + vx * hw * sg, y, z + vz * hw * sg)); }
    }
    const mem = (a, b, kind, i, s) => {
      const sc = SEC[kind], Lm = len(st.nodes[a], st.nodes[b]);
      const area = kind === 3 ? K.WIDTH * 0.008 : sc.A;
      st.mem.push({ a, b, kind, w: kind === 3 ? K.WIDTH - 0.12 : sc.w, h: sc.h, A: kind === 3 ? 0.008 * 0.5 : sc.A, mass: 7850 * area * Lm, on: 1, dmg: 0, i, s });
    };
    for (let s = 0; s < 2; s++) {
      for (let i = 0; i < n; i++) mem(bot[s][i], bot[s][i + 1], 0, i, s);                       // bottom chords
      for (let i = 0; i + 1 < n; i++) mem(top[s][i], top[s][i + 1], 0, i + 0.5, s);              // top chords (between top nodes)
      for (let i = 0; i < n; i++) { mem(bot[s][i], top[s][i], 1, i, s); mem(top[s][i], bot[s][i + 1], 1, i, s); }   // diagonals
    }
    for (let i = 0; i <= n; i++) mem(bot[0][i], bot[1][i], 2, i, -1);                             // cross beams
    for (let i = 0; i < n; i++) mem(cen[i], cen[i + 1], 3, i, -1);                                // deck panels
    for (const i of [0, n]) { for (const k of [bot[0][i], bot[1][i], cen[i]]) st.nodes[k].anchor = 1; }
    st.bot = bot; st.top = top; st.cen = cen;
    return st;
  }

  ST.populate = function (S, taken) {
    S.structs = [];
    if (!K || K.OFF || W().under) return;                                  // U: no gaps to bridge underground
    S_ref = S;
    const w = W(), look = { temperate: 0, alpine: 1, canyon: 2, desert: 3, volcanic: 4 }[S.biome] || 0;
    for (const c of findSpans(S, taken || [])) {
      const st = build(S, c.A, c.B, look);
      S.structs.push(st);
      if (taken) { taken.push({ x: c.A.x, y: c.A.y, z: c.A.z }); taken.push({ x: c.B.x, y: c.B.y, z: c.B.z }); }
    }
    S_ref = null;
  };

  /* ---------- stability and release ---------- */
  function sideOK(st, s, i) {
    const M_ = st.mem;
    let botOn = false, diag = false, topOn = false;
    for (const m of M_) {
      if (!m.on || m.s !== s) continue;
      if (m.kind === 0 && m.i === i) botOn = true;                       // bottom chord of panel i
      if (m.kind === 1 && m.i === i) diag = true;
      if (m.kind === 0 && (m.i === i - 0.5 || m.i === i + 0.5)) topOn = true;   // a top chord at top node i
    }
    if (st.n === 1) topOn = true;
    return botOn && diag && topOn;
  }
  function anchorsOK(st) {
    const w = W();
    for (const nd of st.nodes) if (nd.anchor && w.sample(nd.x, nd.y - K.DECK_LIFT - 0.25, nd.z) <= 0 && w.sample(nd.x, nd.y - K.DECK_LIFT - 0.6, nd.z) <= 0) return false;
    return true;
  }
  // a piece (members of panels [i0, i1]) -> one rigid body: spheres along the members, body-space member list (render)
  function release(S, st, i0, i1, kick) {
    const ms = st.mem.filter(m => m.on && (m.kind === 2 ? m.i >= i0 && m.i <= i1 + 1 : Math.floor(m.i) >= i0 && Math.floor(m.i) <= i1));
    if (!ms.length || !SS.bodies) return null;
    let mass = 0, cx = 0, cy = 0, cz = 0;
    for (const m of ms) { const a = st.nodes[m.a], b = st.nodes[m.b]; mass += m.mass; cx += m.mass * (a.x + b.x) / 2; cy += m.mass * (a.y + b.y) / 2; cz += m.mass * (a.z + b.z) / 2; }
    cx /= mass; cy /= mass; cz /= mass;
    const pts = [], mem = [];
    let Ix = 0, Iy = 0, Iz = 0;
    for (const m of ms) {
      const a = st.nodes[m.a], b = st.nodes[m.b], Lm = len(a, b);
      const r = m.kind === 3 ? 0.12 : Math.max(0.08, m.h / 2);
      const lanes = m.kind === 3 ? [-0.6, 0, 0.6] : [0];
      const step = m.kind === 3 ? 0.6 : Math.max(0.25, r * 1.6), k = Math.max(1, Math.ceil(Lm / step));
      for (const ln of lanes) for (let q = 0; q <= k; q++) {
        const t = q / k, x = a.x + (b.x - a.x) * t - cx, y = a.y + (b.y - a.y) * t - cy, z = a.z + (b.z - a.z) * t - cz;
        const lx = ln * -st.uz, lz = ln * st.ux;           // deck lanes across the bridge
        pts.push(x + lx, y, z + lz, r);
      }
      const mx = (a.x + b.x) / 2 - cx, my = (a.y + b.y) / 2 - cy, mz = (a.z + b.z) / 2 - cz;
      Ix += m.mass * (my * my + mz * mz + Lm * Lm / 12); Iy += m.mass * (mx * mx + mz * mz + Lm * Lm / 12); Iz += m.mass * (mx * mx + my * my + Lm * Lm / 12);
      mem.push({ a: { x: a.x - cx, y: a.y - cy, z: a.z - cz }, b: { x: b.x - cx, y: b.y - cy, z: b.z - cz }, kind: m.kind, w: m.w, h: m.h });
      m.on = 0; m.gone = 1;
    }
    const bd = SS.bodies.add_shape(S, 'struct', { x: cx, y: cy, z: cz }, mass, { x: Ix, y: Iy, z: Iz }, pts, C.MAT.ROCK);
    bd.members = mem; bd.look = st.look; bd.mu = 0.5; bd.e = 0.1;
    if (kick) { const d = M.len3(cx - kick.x, cy - kick.y, cz - kick.z) || 1, dv = Math.min(3, kick.J / mass); bd.vel.x = (cx - kick.x) / d * dv; bd.vel.y = (cy - kick.y) / d * dv; bd.vel.z = (cz - kick.z) / d * dv; }
    return bd;
  }
  function check(S, st, kick) {
    if (st.fallen) return;
    const fail = [];
    for (let i = 0; i < st.n; i++) if (!sideOK(st, 0, i) && !sideOK(st, 1, i)) fail.push(i);
    if (!fail.length && anchorsOK(st)) return;
    // the span hangs on pinned bearings: any failed panel or a lost abutment brings it all down, in pieces split at
    // the failed panels
    // pieces: the runs of panels between failed panels, and what is left of each failed panel on its own (before, a
    // failed panel next to another one or at panel 0 was switched off without a body: its steel vanished)
    const runs = [], pieces = [];
    let i0 = 0;
    for (const f of fail) { if (f > i0) runs.push([i0, f - 1]); runs.push([f, f]); i0 = f + 1; }
    if (i0 <= st.n - 1) runs.push([i0, st.n - 1]);
    for (const [ra, rb] of runs) { const b = release(S, st, ra, rb, kick); if (b) pieces.push(b.id); }
    for (const m of st.mem) if (m.on) { m.on = 0; m.gone = 1; }
    st.fallen = true; st.ver++;
    SS.sim.emit(S, 'bridgefall', { id: st.id, pieces: pieces.length, x: (st.A.x + st.B.x) / 2, y: st.A.y, z: (st.A.z + st.B.z) / 2 });
    SS.sim.log(S, 'The steel bridge collapses!', 0xffc070);
  }

  /* ---------- blasts ---------- */
  ST.blast = function (S, c, Wkg) {
    if (!S.structs || !S.structs.length) return;
    const reach = 3 + 4 * M.cbrt(Wkg);
    for (const st of S.structs) {
      if (st.fallen) continue;
      if (segd(c, st.A, st.B) > reach + st.h + K.WIDTH) continue;
      let changed = false, Jsum = 0;
      for (const m of st.mem) {
        if (!m.on) continue;
        const a = st.nodes[m.a], b = st.nodes[m.b], ds = segd(c, a, b), r = m.kind === 3 ? 0.004 : m.h / 2;
        if (ds > reach) continue;
        // blast momentum on the member (for the release kick): Kinney-Graham impulse x frontal area
        Jsum += SS.blast.impulse(Math.max(0.2, ds - r), Wkg) * len(a, b) * (m.kind === 3 ? m.w * 0.5 : m.h);
        const eff = M.exp(-Math.max(0, ds - r) / K.CUT_L);
        if (eff < 0.02) continue;
        const P = 0.375 * m.A * IN2 * 0.4536;                       // kg TNT to cut it (FM 5-25: 3/8 A lb, A in in²)
        const reachD = m.kind === 3 ? ds < K.DECK_R : true;
        if (!reachD) continue;
        m.dmg += Wkg * eff / P;
        if (m.dmg >= 1) {
          m.on = 0; m.cut = 1; changed = true;
          SS.sim.emit(S, 'steelcut', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2, kind: m.kind, id: st.id });
        }
      }
      if (changed) st.ver++;
      check(S, st, { x: c.x, y: c.y, z: c.z, J: Jsum });
    }
  };
  /* terrain edits (a crater under an abutment) */
  ST.on_edit = function (S) { if (S.structs) for (const st of S.structs) if (!st.fallen && !anchorsOK(st)) check(S, st, null); };

  /* ---------- gameplay plane ---------- */
  ST.plane_sections = function (S) {
    if (!S.structs || !S.structs.length) return;
    const P = SS.plane, n = P.nrm(S), d = P.dir(S), ox = S.O.x, oz = S.O.z, PB = S.planeBodies;
    for (const st of S.structs) {
      if (st.fallen) continue;
      for (const m of st.mem) {
        if (!m.on) continue;
        const a = st.nodes[m.a], b = st.nodes[m.b];
        if (m.kind === 3) { deckSection(PB, st, m, a, b, n, d, ox, oz); continue; }
        const ta = (a.x - ox) * n.x + (a.z - oz) * n.z, tb = (b.x - ox) * n.x + (b.z - oz) * n.z;
        const half = m.kind === 3 ? m.w / 2 : m.w / 2 + 0.02, rad = m.kind === 3 ? 0.06 : m.h / 2;
        // the deck plate is wide across the bridge: its extent on the plane depends on the crossing angle
        const ext = m.kind === 3 ? half * Math.abs(st.ux * n.x + st.uz * n.z) + 0.05 : half;
        if (Math.min(ta, tb) > ext || Math.max(ta, tb) < -ext) continue;
        // clip the member to the slab |t| <= ext
        let u0 = 0, u1 = 1;
        if (Math.abs(tb - ta) > 1e-6) { const ua = (-ext - ta) / (tb - ta), ub = (ext - ta) / (tb - ta); u0 = Math.max(0, Math.min(ua, ub)); u1 = Math.min(1, Math.max(ua, ub)); }
        if (u1 < u0) continue;
        const sA = (a.x + (b.x - a.x) * u0 - ox) * d.x + (a.z + (b.z - a.z) * u0 - oz) * d.z, yA = a.y + (b.y - a.y) * u0;
        const sB = (a.x + (b.x - a.x) * u1 - ox) * d.x + (a.z + (b.z - a.z) * u1 - oz) * d.z, yB = a.y + (b.y - a.y) * u1;
        const ls = Math.abs(sB - sA), ly = Math.abs(yB - yA);
        if (ly <= 0.25 * ls + 0.05) PB.push({ s: (sA + sB) / 2, y: (yA + yB) / 2, kind: 1, hs: ls / 2 + rad * 0.5, hy: rad + ly / 2, r: 0, ref: null, struct: st.id });
        else {
          const k = Math.max(1, Math.ceil(M.len2(ls, ly) / Math.max(0.1, rad)));
          for (let q = 0; q <= k; q++) { const t = q / k; PB.push({ s: sA + (sB - sA) * t, y: yA + (yB - yA) * t, kind: 0, hs: 0, hy: 0, r: rad + 0.02, ref: null, struct: st.id }); }
        }
      }
    }
  };
  /* P29m (user 2026-10-08: "it's not possible to walk across the bridge, it doesn't register as a walkable surface on
   * the intersection"): a deck panel is a RECTANGLE, its centre line a..b plus +- WIDTH / 2 across the bridge. Where
   * slice zero crosses it, the walkable strip is the plane's intersection with that rectangle (crossing the bridge
   * square on: the full deck width; along it: the panel's length). Before, only the centre line was clipped, with the
   * width projected on the bridge AXIS: crossing square on, the deck was a 6 cm sliver and worms fell through. The
   * box's top is the deck surface (DECK_LIFT above the centre nodes, as ST.floor_at for worms in 3D). */
  const DECK_TOL = 0.05;                            // m: the plane counts a deck this close to it (thin slab)
  function deckSection(PB, st, m, a, b, n, d, ox, oz) {
    const half = m.w / 2, lx = -st.uz, lz = st.ux;                      // lateral (across the bridge), horizontal
    const tA = (a.x - ox) * n.x + (a.z - oz) * n.z, tB = (b.x - ox) * n.x + (b.z - oz) * n.z, tl = lx * n.x + lz * n.z;
    const sA = (a.x - ox) * d.x + (a.z - oz) * d.z, sB = (b.x - ox) * d.x + (b.z - oz) * d.z, sl = lx * d.x + lz * d.z;
    // corners (al, be): al along a -> b (0..1), be across (-half..half); t / s / y are linear in both
    const T = (al, be) => tA + (tB - tA) * al + tl * be, Sx = (al, be) => sA + (sB - sA) * al + sl * be;
    const C4 = [[0, -half], [1, -half], [1, half], [0, half]];
    let tMin = 1e9, tMax = -1e9;
    for (const [al, be] of C4) { const t = T(al, be); if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
    if (tMin > DECK_TOL || tMax < -DECK_TOL) return;
    // the part of the rectangle within |t| <= DECK_TOL: its s range and its along-range (for the deck's height)
    let s0 = 1e9, s1 = -1e9, al0 = 1, al1 = 0;
    const take = (al, be) => { const sv = Sx(al, be); if (sv < s0) s0 = sv; if (sv > s1) s1 = sv; if (al < al0) al0 = al; if (al > al1) al1 = al; };
    for (let e = 0; e < 4; e++) {
      const [al, be] = C4[e], [al2, be2] = C4[(e + 1) % 4], t1 = T(al, be), t2 = T(al2, be2);
      if (Math.abs(t1) <= DECK_TOL) take(al, be);
      for (const tc of [-DECK_TOL, DECK_TOL]) if ((t1 - tc) * (t2 - tc) < 0) { const u = (tc - t1) / (t2 - t1); take(al + (al2 - al) * u, be + (be2 - be) * u); }
    }
    if (s1 < s0) return;
    const yAt = al => a.y + (b.y - a.y) * al + K.DECK_LIFT + 0.004, y0 = yAt(al0), y1 = yAt(al1), TH = 0.05;
    const yTop = Math.max(y0, y1), yBot = Math.min(y0, y1) - TH;
    PB.push({ s: (s0 + s1) / 2, y: (yTop + yBot) / 2, kind: 1, hs: (s1 - s0) / 2, hy: (yTop - yBot) / 2, r: 0, ref: null, struct: st.id });
  }

  /* the deck surface under (x, z) at or below yTop + 0.05 (worms in 3D stand on it), -1e9 = none. A deck panel that was
   * holed leaves its gap. */
  ST.floor_at = function (S, x, yTop, z) {
    if (!S.structs || !S.structs.length) return -1e9;
    let best = -1e9;
    for (const st of S.structs) {
      if (st.fallen) continue;
      const rx = x - st.A.x, rz = z - st.A.z, t = rx * st.ux + rz * st.uz, lat = -rx * st.uz + rz * st.ux;
      if (t < 0 || t > st.L || Math.abs(lat) > K.WIDTH / 2 - 0.05) continue;
      const i = Math.min(st.n - 1, Math.floor(t / st.L * st.n)), dm = st.mem.find(m => m.kind === 3 && m.i === i);
      if (!dm || !dm.on) continue;
      const y = st.A.y + (st.B.y - st.A.y) * t / st.L + K.DECK_LIFT + 0.004;
      if (y <= yTop + 0.05 && y > best) best = y;
    }
    return best;
  };
  /* is a standing structure within r (horizontally) of (x, z) with its deck below yTop? (tree / prop placement) */
  ST.near = function (S, x, z, r, yTop) {
    for (const st of S.structs || []) {
      if (st.fallen || Math.min(st.A.y, st.B.y) > yTop) continue;
      if (segd({ x, y: 0, z }, { x: st.A.x, y: 0, z: st.A.z }, { x: st.B.x, y: 0, z: st.B.z }) < r + K.WIDTH / 2) return true;
    }
    return false;
  };
  ST.stats = S => (S.structs || []).map(st => ({ id: st.id, L: +st.L.toFixed(1), n: st.n, h: +st.h.toFixed(2), members: st.mem.length, on: st.mem.filter(m => m.on).length, fallen: st.fallen }));
})(window.SS = window.SS || {});
