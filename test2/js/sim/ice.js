/* sim/ice.js — sea / pool ice (Step I; P30 rework, user 2026-10-08: "thin ice doesn't work as it should ... ALL NORMAL
 * LOGICAL REAL WORLD STUFF"). Portable, deterministic: no RNG streams (seeded hashes of positions / ids only).
 * render/ice.js draws the sheet and the floes.
 * Field: per lattice column (the water grid, 193²) thickness h (cm, 0 = open water), snow on the ice (cm), floe id
 * (render: the crack pattern of refrozen pieces). Ice only on water deeper than WET.
 * Temperature (air_temp, °C, shown in the HUD): biome x weather (C.ICE.T_AIR) + time of day (T_TOD: dusk, night).
 * Which water freezes: alpine always; other biomes when the air is below 0 °C (snow / blizzard, cold nights).
 * Growth per turn (TURN_H hours of frost): Stefan's law h² += a² dFDD (a = A_GROW cm/sqrt(°C day), sea ice; Ashton,
 * Lebedev): the colder, the faster; thin ice thickens fast, thick ice slowly. The sheet spreads from shores and ice one
 * cell per turn (leads refreeze from their edges as new thin ice). Above 0 °C it melts (MELT cm per °C per turn, +
 * MELT_SUN on a clear day): the new thin ice goes first.
 * Bearing (Gold): a cell fails above A_FAIL h² kg (h in cm). A worm (WORM_KG, game scale) stands on one-turn ice
 * (~1.5 cm); a hard landing breaks it; ice melted thin gives way under it. Loads: static, or a landing:
 * F = m (1 + sqrt(1 + 2 H / STOP_D)) / 2, H = v² / 2g.
 * Breaking: a hole (open water, brash) and FLOES around it: thin sheets of random shape (~FLOE_SIZE m, Voronoi pieces of
 * the broken area) that float off with the water and the wind, bump into shores, the sheet and each other, and freeze
 * back into the sheet where they are once a full round has passed (at a frost turn; they melt in a thaw). A worm over a broken cell has
 * nothing to stand on: it falls in.
 * Projectiles: the punching work ½ m vn² > PUNCH h² (vn: the speed INTO the ice, h in m): a fast, steep shell goes
 * through (and goes off in the water under it), a gentle or slow drop bounces off (ice: no friction to speak of).
 * Blasts: the ice within R = k W^(1/3) / (1 + h / H_REF) breaks at once (k = K_SURF on / above the ice, K_UNDER under
 * water); and the blast's WAVE runs out under the sheet at the shallow-water speed sqrt(g depth): as its front passes,
 * every cell within the wave's reach for its thickness (WAVE_K W^(1/3) / (1 + h / H_REF)) shatters into floes.
 * Snow on the ice (falling snow: SNOW_RATE cm/s at full intensity; melts above 0 °C) gives the worms grip again;
 * bare ice is slippery (slippery(S, x, z): sim.js slides the worm, GRIP 1/s).
 * Floating bodies frozen in by the growing sheet are locked (b.iceLock) until the ice around them breaks.
 * Gameplay plane: intact ice along slice zero = thin boxes (S.planeBodies, `ice` flag); floes are not walkable.
 * Events 'icebreak' {x, y, z, r, why}. API: init(S), new_turn(S), step(S, dt), air_temp(S), top_at(S, x, z) (-1e9 =
 * none), cell(S, x, z), supports(S, x, z, kg), slippery(S, x, z), load(S, x, z, kg, why) (breaks if over),
 * would_punch / impact(S, x, z, mass, vn) (projectile: true = through), blast(S, c, W), plane_sections(S), stats(S).
 * C layout: struct Floe { i32 id, round; f32 x, z, a, vx, vz, va, h, r; u8 n; f32 px[8], pz[8]; };
 *   struct Wave { f32 x, z, r, c, E; };
 *   struct Ice { f32 T; f32 *h, *snow; u8 *crack, *floe; Floe floes[FLOE_MAX]; Wave waves[8]; u32 ver, turns; }. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, K = C.ICE;
  const IC = SS.ice = {};
  const W = () => SS.world;

  /* the air temperature (°C): biome x weather kind, colder at dusk and at night */
  function airT(S) {
    const T = K.T_AIR[S.biome] || K.T_AIR.other, kind = S.weather ? S.weather.kind : 'clear';
    const t = T[kind] != null ? T[kind] : T.clear, tod = SS.sim && SS.sim.time_of_day ? SS.sim.time_of_day(S) : 'day';
    return t + (K.T_TOD[tod] || 0);
  }
  IC.air_temp = airT;
  // turns in one round: the teams that still have a living worm (>= 1)
  function roundTurns(S) { let n = 0; for (let t = 0; t < (S.teams ? S.teams.length : 0); t++) if (S.worms.some(w => w.team === t && !w.dead)) n++; return Math.max(1, n); }
  IC.round_turns = roundTurns;
  const sunny = S => (!S.weather || S.weather.kind === 'clear') && (!SS.sim || !SS.sim.time_of_day || SS.sim.time_of_day(S) === 'day');
  const idx = (st, x, z) => { const w = W(); return M.clamp(Math.round(z / w.H), 0, st.NZ - 1) * st.NX + M.clamp(Math.round(x / w.H), 0, st.NX - 1); };
  const charL = hcm => { const h = hcm / 100; return M.pow(K.E * h * h * h / (12 * (1 - 0.33 * 0.33) * 1025 * C.G), 0.25); };
  IC.cap = hcm => K.A_FAIL * hcm * hcm;                       // kg the ice carries (Gold, failure)
  const hash = (a, b, c) => M.hash3(a | 0, b | 0, c | 0);

  function create(S) {
    const w = W(), NX = w.NX, NZ = w.NZ, N = NX * NZ;
    S.ice = { NX, NZ, N, h: new Float32Array(N), snow: new Float32Array(N), crack: new Uint8Array(N), floe: new Uint8Array(N), ver: 1, turns: 0, T: airT(S),
      prevVy: {}, scratch: new Uint8Array(N), floes: [], floeId: 0, waves: [], snowT: 0 };
  }
  IC.init = function (S) {
    S.ice = null;
    if (!S.water || !K || SS.world.under) return;                      // U: no sea ice in the caves
    if (airT(S) >= 0 && !K.ALWAYS[S.biome]) return;
    create(S);
    // the winter before the match: an always-cold biome pre-freezes with its clear-weather frost even if the match
    // starts in a thaw (alpine rain / ashfall)
    const Tpre = Math.min(airT(S), K.ALWAYS[S.biome] && K.T_AIR[S.biome] ? K.T_AIR[S.biome].clear : 0);
    for (let t = 0; t < K.PRE_TURNS; t++) freezeTurn(S, K.PRE_TURN_H, Tpre);
    S.ice.turns = 0;
  };

  /* one turn: frost (growth, spreading, floes freeze back in) or thaw (melting, floes melt) */
  function freezeTurn(S, hours, Tforce) {
    const st = S.ice, NX = st.NX, NZ = st.NZ, h = st.h, wh = S.water.h, T = Tforce != null ? Tforce : airT(S);
    st.T = T; st.turns++;
    const hrs = hours || K.TURN_H;
    if (T >= 0) {                                              // thaw: the thin new ice goes first
      const d = (K.MELT * T + (sunny(S) ? K.MELT_SUN : 0)) * hrs / K.TURN_H;
      for (let c = 0; c < st.N; c++) {
        if (st.snow[c] > 0) st.snow[c] = Math.max(0, st.snow[c] - d);
        if (h[c] > 0) { h[c] = Math.max(0, h[c] - d); if (h[c] < K.H_MIN) { h[c] = 0; st.crack[c] = 0; st.snow[c] = 0; } }
      }
      for (let i = st.floes.length - 1; i >= 0; i--) { const f = st.floes[i]; f.h -= d; if (f.h < K.H_MIN) st.floes.splice(i, 1); }
      st.ver++; return;
    }
    const dF = -T * hrs / 24, a2 = K.A_GROW * K.A_GROW;
    for (let c = 0; c < st.N; c++) {
      if (h[c] <= 0) continue;
      if (!(wh[c] > K.WET)) { h[c] = 0; st.crack[c] = 0; st.snow[c] = 0; continue; }   // the water went (drained / dry)
      h[c] = M.len2(h[c], K.A_GROW * M.pow(dF, 0.5));             // Stefan: h² + a² dF
      if (st.crack[c] > 0) st.crack[c]--;
    }
    // floes a full round old (user: "after a round they should freeze again") freeze back into the sheet where they
    // float now (their cells take the floe's grown thickness); younger ones keep drifting and thicken
    // (a full round = one turn per team still in the game, counted from the floe's own turn: S.round only counts
    // wraps of the team order, so a floe from the round's last turn refroze after one turn)
    const nT = roundTurns(S);
    for (let i = st.floes.length - 1; i >= 0; i--) {
      const f = st.floes[i], hf = M.len2(f.h, K.A_GROW * M.pow(dF, 0.5));
      if ((S.turnNo | 0) - f.turn < nT) { f.h = hf; continue; }
      const tag = 1 + (f.id % 15), sn = Math.min(K.SNOW_MAX, f.snow || 0);
      floeCells(st, f, c => { if (wh[c] > K.WET && h[c] < hf) { h[c] = hf; st.crack[c] = 0; st.floe[c] = tag; st.snow[c] = sn; } });
      st.floes.splice(i, 1);
    }
    // spread: open water next to land (a shore) or to ice freezes as new thin ice
    const h0 = K.A_GROW * M.pow(dF, 0.5) * K.NEW_K, mark = st.scratch; mark.fill(0);
    for (let k = 1; k < NZ - 1; k++) for (let i = 1; i < NX - 1; i++) {
      const c = k * NX + i;
      if (h[c] > 0 || !(wh[c] > K.WET)) continue;
      if (h[c - 1] >= K.H_MIN || h[c + 1] >= K.H_MIN || h[c - NX] >= K.H_MIN || h[c + NX] >= K.H_MIN ||
          !(wh[c - 1] > K.WET) || !(wh[c + 1] > K.WET) || !(wh[c - NX] > K.WET) || !(wh[c + NX] > K.WET)) mark[c] = 1;
    }
    for (let c = 0; c < st.N; c++) if (mark[c]) { h[c] = h0; st.crack[c] = 0; st.snow[c] = 0; }
    st.ver++;
  }
  // a frost that sets in mid-match ('auto' weather turned cold) starts the field from open water
  IC.new_turn = function (S) { if (!S.ice && S.water && K && !SS.world.under && airT(S) < 0) create(S); if (S.ice) freezeTurn(S); };

  /* ---------- queries ---------- */
  IC.cell = (S, x, z) => (S.ice ? idx(S.ice, x, z) : -1);
  // ice top at (x, z) for intact ice of usable thickness; -1e9 = none. Freeboard ~(1 - rho_i / rho_w) h.
  IC.top_at = function (S, x, z) {
    const st = S.ice; if (!st) return -1e9;
    const H = W().H; if (x < 0 || z < 0 || x > (st.NX - 1) * H || z > (st.NZ - 1) * H) return -1e9;   // (idx clamps: no ice beyond the lattice)
    const c = idx(st, x, z), hc = st.h[c];
    if (hc < K.H_MIN || st.crack[c] > 0) return -1e9;
    const s = SS.water.surface(S, x, z); if (s < -50) return -1e9;
    return s + hc * 0.01 * K.FREEBOARD;
  };
  IC.supports = (S, x, z, kg) => { const st = S.ice; if (!st) return false; const c = idx(st, x, z); return st.crack[c] === 0 && st.h[c] >= K.H_MIN && kg <= IC.cap(st.h[c]); };
  // bare ice is slippery; a thin snow cover (SNOW_GRIP cm) gives grip
  IC.slippery = (S, x, z) => { const st = S.ice; if (!st) return false; const c = idx(st, x, z); return st.h[c] >= K.H_MIN && st.snow[c] < K.SNOW_GRIP; };

  /* ---------- floes ---------- */
  // every lattice cell whose centre lies in floe f's polygon (world: rotate by a, translate to x, z)
  function floeCells(st, f, cb) {
    const H = W().H, ca = M.cos(f.a), sa = M.sin(f.a), n = f.n, wx = new Float32Array(n), wz = new Float32Array(n);
    for (let v = 0; v < n; v++) { wx[v] = f.x + f.px[v] * ca - f.pz[v] * sa; wz[v] = f.z + f.px[v] * sa + f.pz[v] * ca; }
    const i0 = Math.max(0, Math.floor((f.x - f.r) / H)), i1 = Math.min(st.NX - 1, Math.ceil((f.x + f.r) / H));
    const k0 = Math.max(0, Math.floor((f.z - f.r) / H)), k1 = Math.min(st.NZ - 1, Math.ceil((f.z + f.r) / H));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const x = i * H, z = k * H; let inside = false;
      for (let v = 0, u = n - 1; v < n; u = v++) {                            // even-odd rule
        if ((wz[v] > z) !== (wz[u] > z) && x < (wx[u] - wx[v]) * (z - wz[v]) / (wz[u] - wz[v]) + wx[v]) inside = !inside;
      }
      if (inside) cb(k * st.NX + i);
    }
  }
  /* break the listed cells into floes: Voronoi pieces of ~FLOE_SIZE m (seeds jittered by a hash of their grid cell),
   * each a random 7-gon of the piece's area, pushed away from (cx, cz) at up to `kick` m/s, with a little spin */
  /* reg (optional, a blast wave's registry key -> { f, n, sx, sz }): a wave breaks the ice ring by ring, step by
   * step; cells of a piece it already made join that floe (grown, re-centred, keeping its drift) instead of each
   * thin ring becoming its own sliver of floes */
  function shatter(S, cells, cx, cz, kick, reg) {
    const st = S.ice, H = W().H, FS0 = K.FLOE_SIZE, groups = new Map();
    for (let q = 0; q < cells.length; q++) {
      const c = cells[q], x = (c % st.NX) * H, z = Math.floor(c / st.NX) * H;
      // piece size grows with the distance from the break (crushed small near it, big plates further out: the radial
      // and ring fractures of a point load), three bands of FLOE_SIZE x 0.6 / 1.2 / 2.2
      const dc = M.len2(x - cx, z - cz), band = dc < 2 ? 0 : dc < 4.5 ? 1 : 2, FS = FS0 * (band === 0 ? 0.6 : band === 1 ? 1.2 : 2.2);
      const gx = Math.floor(x / FS), gz = Math.floor(z / FS);
      // additively weighted Voronoi (distance - a per-seed weight up to 0.9 FS): pieces of very different sizes with
      // curved borders, not a cobblestone tiling of equal cells
      let best = 0, bd = 1e9;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const sx = (gx + dx + 0.5 + (hash(gx + dx, gz + dz, 11) - 0.5) * 0.9) * FS, sz = (gz + dz + 0.5 + (hash(gx + dx, gz + dz, 12) - 0.5) * 0.9) * FS;
        const d = M.len2(sx - x, sz - z) - hash(gx + dx, gz + dz, 13) * hash(gx + dx, gz + dz, 14) * 0.9 * FS;
        if (d < bd) { bd = d; best = ((gx + dx) * 4099 + (gz + dz)) * 4 + band; }
      }
      let g = groups.get(best); if (!g) { g = { n: 0, sx: 0, sz: 0, sh: 0, ss: 0, key: best }; groups.set(best, g); }
      g.n++; g.sx += x; g.sz += z; g.sh += st.h[c]; g.ss += st.snow[c];
    }
    for (const g of groups.values()) {
      const old = reg ? reg.get(g.key) : null;
      if (old && st.floes.indexOf(old.f) >= 0) {
        const f = old.f, ox = old.sx / old.n, oz = old.sz / old.n, k = M.pow((old.n + g.n) / old.n, 0.5);
        old.n += g.n; old.sx += g.sx; old.sz += g.sz;
        f.x += old.sx / old.n - ox; f.z += old.sz / old.n - oz; f.r *= k;
        for (let v = 0; v < f.n; v++) { f.px[v] *= k; f.pz[v] *= k; }
        f.h = (f.h * (old.n - g.n) + g.sh) / old.n; f.snow = (f.snow * (old.n - g.n) + g.ss) / old.n;
        continue;
      }
      if (st.floes.length >= K.FLOE_MAX) st.floes.shift();               // the oldest goes (bounded state)
      const x = g.sx / g.n, z = g.sz / g.n, r = M.pow(g.n * H * H / Math.PI, 0.5) * 1.12, id = ++st.floeId, nv = 5 + Math.floor(hash(id, 9, 20) * 4);   // 5-8 corners
      const px = new Float32Array(nv), pz = new Float32Array(nv);
      for (let v = 0; v < nv; v++) {
        const an = (v + (hash(id, v, 21) - 0.5) * 0.7) / nv * M.TAU, rr = r * (0.62 + 0.62 * hash(id, v, 22));
        px[v] = M.cos(an) * rr; pz[v] = M.sin(an) * rr;
      }
      const dx = x - cx, dz = z - cz, d = M.len2(dx, dz) || 1, vk = kick * (0.6 + 0.4 * hash(id, 3, 23));
      st.floes.push({ id, turn: S.turnNo | 0, x, z, a: hash(id, 4, 24) * M.TAU, vx: dx / d * vk, vz: dz / d * vk, va: (hash(id, 5, 25) - 0.5) * 2.4 * Math.min(1, kick), h: g.sh / g.n, snow: g.ss / g.n, r: r * 1.2, n: nv, px, pz });
      if (reg) reg.set(g.key, { f: st.floes[st.floes.length - 1], n: g.n, sx: g.sx, sz: g.sz });   // (snow: the cover it carries away, cm)
    }
    for (let q = 0; q < cells.length; q++) { const c = cells[q]; st.h[c] = 0; st.crack[c] = 0; st.floe[c] = 0; st.snow[c] = 0; }
    st.ver++;
  }
  /* break the ice at (x, z): open water (brash) within rh, floes out to rc pushed off at up to `kick` m/s */
  function breakAt(S, x, z, rh, rc, why, kick, reg) {
    const st = S.ice, H = W().H, NX = st.NX, ext = Math.ceil(rc / H) + 1, ci = Math.round(x / H), ck = Math.round(z / H), ring = [];
    let any = false;
    for (let k = Math.max(0, ck - ext); k <= Math.min(st.NZ - 1, ck + ext); k++) for (let i = Math.max(0, ci - ext); i <= Math.min(NX - 1, ci + ext); i++) {
      const c = k * NX + i, d = M.len2(i * H - x, k * H - z);
      if (st.h[c] <= 0 || d > rc) continue;
      any = true;
      if (d <= rh) { st.h[c] = 0; st.crack[c] = 0; st.snow[c] = 0; continue; }
      ring.push(c);
    }
    if (!any) return;
    if (ring.length) shatter(S, ring, x, z, kick == null ? 1.5 : kick, reg);
    st.ver++;
    SS.sim.emit(S, 'icebreak', { x, y: SS.water.surface(S, x, z), z, r: rc, why });
  }
  IC.break_at = breakAt;
  /* a load at (x, z): breaks the ice if it is more than it carries; true = broke (the load goes into the water) */
  IC.load = function (S, x, z, kg, why) {
    const st = S.ice; if (!st) return false;
    const c = idx(st, x, z), hc = st.h[c];
    if (hc < K.H_MIN || st.crack[c] > 0 || kg <= IC.cap(hc)) return false;
    breakAt(S, x, z, K.HOLE_R, Math.max(K.HOLE_R + 0.5, K.CRACK_K * charL(hc)), why || 'overload', 0.4);
    return true;
  };
  const dynKg = (m, v) => { const Hd = v * v / (2 * C.G); return m * (1 + M.pow(1 + 2 * Hd / K.STOP_D, 0.5)) / 2; };   // /2: the static case gives m
  IC.dyn_kg = dynKg;
  /* would a projectile with speed vn INTO the ice punch through (no side effects; the CPU's flight copy) */
  IC.would_punch = function (S, x, z, mass, vn) {
    const st = S.ice; if (!st) return true;
    const c = idx(st, x, z), hc = st.h[c];
    if (hc < K.H_MIN || st.crack[c] > 0) return true;
    return 0.5 * mass * vn * vn > K.PUNCH * (hc / 100) * (hc / 100);
  };
  /* a projectile hits the ice with speed vn into it: true = punched through (a hole + a few floes) */
  IC.impact = function (S, x, z, mass, vn) {
    if (!IC.would_punch(S, x, z, mass, vn)) return false;
    const st = S.ice; if (!st) return true;
    const hc = st.h[idx(st, x, z)];
    if (hc >= K.H_MIN) breakAt(S, x, z, 0.3, Math.max(0.9, charL(hc)), 'impact', 0.6);
    return true;
  };

  /* ---------- per step: worm loads, floes, blast waves, snow on the ice, frozen-in bodies ---------- */
  IC.step = function (S, dt) {
    const st = S.ice; if (!st) return;
    for (const wm of S.worms) {
      if (wm.dead) continue;
      const foot = wm.pos.y - (wm.foot || 0.5), top = IC.top_at(S, wm.pos.x, wm.pos.z);
      const vy = SS.sim.ctl(S, wm) ? (wm.air ? wm.vy : 0) : wm.vel.y, prev = st.prevVy[wm.id] || 0;
      st.prevVy[wm.id] = vy;
      if (top < -1e8 || Math.abs(foot - top) > 0.12) continue;
      // landing (the previous step still fell) or standing
      const kg = prev < -1 ? dynKg(K.WORM_KG, -prev) : K.WORM_KG;
      if (IC.load(S, wm.pos.x, wm.pos.z, kg, prev < -1 ? 'landing' : 'weight')) {
        wm.rest = false; if (wm === S.active) wm.air = true;
        SS.sim.log(S, `The ice gives way under ${wm.name}!`, 0x9fd8ff);
      }
    }
    stepWaves(S, st, dt);
    stepFloes(S, st, dt);
    // snow settles on the ice while it snows (and melts in a thaw at the turn change)
    st.snowT += dt;
    if (st.snowT >= 0.5) {
      const sn = S.weather ? S.weather.snow || 0 : 0, add = sn * K.SNOW_RATE * st.snowT; st.snowT = 0;
      if (add > 0 && st.T < 0) for (let c = 0; c < st.N; c++) if (st.h[c] >= K.H_MIN) st.snow[c] = Math.min(K.SNOW_MAX, st.snow[c] + add);
    }
    for (const b of S.bodies) {
      if (b.iceLock) {
        const c = idx(st, b.pos.x, b.pos.z);
        if (st.h[c] < K.H_MIN || st.crack[c] > 0) { b.iceLock = false; b.asleep = false; }
        continue;
      }
      // a floating body (afloat for a while) frozen into new ice is locked in place
      if ((b.floatT || 0) > 1 && !b.inLava) {
        const c = idx(st, b.pos.x, b.pos.z);
        if (st.h[c] >= K.LOCK_H && st.crack[c] === 0) { b.iceLock = true; b.vel.x = b.vel.y = b.vel.z = 0; b.w.x = b.w.y = b.w.z = 0; }
      }
    }
  };
  // a blast's wave runs out under the sheet; its front shatters every cell within the reach for that cell's thickness
  /* a blast wave runs out under the ice at c m/s. The cells its ring passes (where its reach beats the ice) crack at
   * once (no bearing: a worm on them goes in) and are shattered in batches every WAVE_FLUSH s: one sheet rebuild and
   * one 'icebreak' event per batch, not per step. Only the ring is scanned (two spans per row). */
  const WAVE_FLUSH = 0.1;
  function flushWave(S, st, wv) {
    // (a queued cell another break / a thaw / drained water cleared meanwhile is not shattered again: it made
    // zero-thickness floes that froze back as ice out of nothing)
    let n = 0; for (let q = 0; q < wv.hit.length; q++) { const c = wv.hit[q]; if (st.h[c] >= K.H_MIN) wv.hit[n++] = c; }
    wv.hit.length = n;
    if (!n) return;
    shatter(S, wv.hit, wv.x, wv.z, 0.9, wv.reg); wv.hit.length = 0;
    if (wv.t - wv.te >= 0.3) { wv.te = wv.t; SS.sim.emit(S, 'icebreak', { x: wv.x, y: SS.water.surface(S, wv.x, wv.z), z: wv.z, r: wv.r, why: 'wave' }); }
  }
  function stepWaves(S, st, dt) {
    const H = W().H, NX = st.NX, NZ = st.NZ;
    for (let w = st.waves.length - 1; w >= 0; w--) {
      const wv = st.waves[w], r0 = wv.r, r1 = wv.r + wv.c * dt; wv.r = r1;
      if (!wv.hit) { wv.hit = []; wv.t = 0; wv.tf = 0; wv.te = -9; if (!wv.reg) wv.reg = new Map(); }
      wv.t += dt;
      const ck = Math.round(wv.z / H), kr = Math.ceil(r1 / H) + 1;
      for (let k = Math.max(0, ck - kr); k <= Math.min(NZ - 1, ck + kr); k++) {
        const dz = k * H - wv.z, o2 = r1 * r1 - dz * dz; if (o2 <= 0) continue;
        const wo = M.pow(o2, 0.5), i2 = r0 * r0 - dz * dz, wi = i2 > 0 ? M.pow(i2, 0.5) : 0;
        for (let sp = 0; sp < 2; sp++) {
          // span 0: x - wo .. x - wi (or the whole chord when the row misses the inner circle), span 1: x + wi .. x + wo
          if (sp === 1 && wi <= 0) break;
          const xa = wi > 0 ? (sp === 0 ? wv.x - wo : wv.x + wi) : wv.x - wo, xb = wi > 0 ? (sp === 0 ? wv.x - wi : wv.x + wo) : wv.x + wo;
          for (let i = Math.max(0, Math.floor(xa / H)); i <= Math.min(NX - 1, Math.ceil(xb / H)); i++) {
            const c = k * NX + i, hc = st.h[c]; if (hc < K.H_MIN || st.crack[c] > 0) continue;
            const d = M.len2(i * H - wv.x, dz);
            if (d < r0 || d >= r1) continue;
            if (d <= wv.E / (1 + hc / K.H_REF)) { st.crack[c] = 1; wv.hit.push(c); }
          }
        }
      }
      if (wv.t - wv.tf >= WAVE_FLUSH) { wv.tf = wv.t; flushWave(S, st, wv); }
      if (r1 > wv.E / (1 + K.H_MIN / K.H_REF) + 1) { flushWave(S, st, wv); st.waves.splice(w, 1); }
    }
  }
  // floes drift with the water (and a little with the wind), bump into shores, the sheet and each other, slowly spin
  const fv = { x: 0, y: 0, z: 0 }, fw = { x: 0, y: 0, z: 0 };
  function stepFloes(S, st, dt) {
    const F = st.floes; if (!F.length) return;
    const w = W(), kd = 1 - M.exp(-K.FLOE_DRAG * dt), ks = M.exp(-0.8 * dt);
    for (let i = F.length - 1; i >= 0; i--) {
      const f = F[i];
      SS.water.vel(S, f.x, f.z, fv);
      let wx = 0, wz = 0;
      if (SS.weather && SS.weather.wind_at) { SS.weather.wind_at(S, f.x, w.SEA + 0.5, f.z, fw); wx = fw.x * K.FLOE_WIND; wz = fw.z * K.FLOE_WIND; }
      f.vx += (fv.x + wx - f.vx) * kd; f.vz += (fv.z + wz - f.vz) * kd;
      const nx = f.x + f.vx * dt, nz = f.z + f.vz * dt;
      if (w.outside(nx, nz)) { F.splice(i, 1); continue; }
      // the leading edge: shallow water / land or the intact sheet stops it (a soft bounce)
      const sp = M.len2(f.vx, f.vz), lx = nx + (sp > 1e-4 ? f.vx / sp : 0) * f.r * 0.8, lz = nz + (sp > 1e-4 ? f.vz / sp : 0) * f.r * 0.8;
      if (SS.water.depth(S, lx, lz) < 0.15 || st.h[idx(st, lx, lz)] >= K.H_MIN) { f.vx *= -0.25; f.vz *= -0.25; f.va *= 0.5; }
      else { f.x = nx; f.z = nz; }
      f.va *= ks; f.a += f.va * dt;
    }
    // floe against floe: push apart (they do not overlap much), share their momentum
    for (let i = 0; i < F.length; i++) for (let j = i + 1; j < F.length; j++) {
      const a = F[i], b = F[j], dx = b.x - a.x, rr = (a.r + b.r) * 0.75;
      if (dx >= rr || dx <= -rr) continue;                                     // (cheap reject: most pairs are far apart)
      const dz = b.z - a.z, d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-8) continue;
      const d = M.pow(d2, 0.5), push = (rr - d) * 0.5, ux = dx / d, uz = dz / d;
      a.x -= ux * push; a.z -= uz * push; b.x += ux * push; b.z += uz * push;
      const vn = (b.vx - a.vx) * ux + (b.vz - a.vz) * uz;
      if (vn < 0) { a.vx += ux * vn * 0.5; a.vz += uz * vn * 0.5; b.vx -= ux * vn * 0.5; b.vz -= uz * vn * 0.5; }
    }
  }

  /* ---------- blasts ---------- */
  IC.blast = function (S, c, Wkg) {
    const st = S.ice; if (!st) return;
    const surf = SS.water.surface(S, c.x, c.z);
    if (surf < -50) return;
    const ci = idx(st, c.x, c.z), hc = st.h[ci], s3 = M.cbrt(Wkg);
    const under = c.y < surf - 0.2, above = c.y - surf;
    if (!under && above > 1.6 * s3 + 1) return;                              // too high above the water
    const R = (under ? K.K_UNDER : K.K_SURF) * s3 / (1 + Math.max(hc, 2) / K.H_REF);
    const reg = new Map();                                                   // (the blast's pieces, grown on by its wave)
    breakAt(S, c.x, c.z, K.HOLE_F * R, R, under ? 'underwater blast' : 'blast', 2.2, reg);
    // the wave: out at the shallow-water speed (depth under the blast), reach E at zero thickness
    const depth = Math.max(0.3, SS.water.depth(S, c.x, c.z));
    if (st.waves.length < 8) st.waves.push({ x: c.x, z: c.z, r: R, c: M.clamp(M.pow(C.G * depth, 0.5), 2, 7), E: K.WAVE_K * s3 * (under ? 1.4 : 1) * (above > 0.3 ? 0.7 : 1), reg });
  };

  /* ---------- gameplay plane: intact ice along slice zero ---------- */
  IC.plane_sections = function (S) {
    const st = S.ice; if (!st) return;
    const P = SS.plane, d = P.dir(S), O = S.O, PB = S.planeBodies, H = W().H;
    let run = null;
    const flush = () => { if (run) { PB.push({ s: (run.s0 + run.s1) / 2, y: run.y, kind: 1, hs: (run.s1 - run.s0) / 2 + H / 2, hy: run.hy, r: 0, ref: null, ice: true }); run = null; } };
    for (let s = -70; s <= 70; s += H) {
      const x = O.x + d.x * s, z = O.z + d.z * s;
      if (W().outside(x, z)) { flush(); continue; }
      const top = IC.top_at(S, x, z);
      if (top < -1e8) { flush(); continue; }
      const c = idx(st, x, z), hy = Math.max(0.04, st.h[c] * 0.005), y = top - hy;
      if (run && Math.abs(run.y - y) < 0.06) { run.s1 = s; run.y = (run.y + y) / 2; run.hy = Math.max(run.hy, hy); }
      else { flush(); run = { s0: s, s1: s, y, hy }; }
    }
    flush();
  };

  IC.stats = function (S) {
    const st = S.ice; if (!st) return null;
    let n = 0, sum = 0, mx = 0, cr = 0;
    for (let c = 0; c < st.N; c++) if (st.h[c] > 0) { n++; sum += st.h[c]; mx = Math.max(mx, st.h[c]); if (st.crack[c]) cr++; }
    return { cells: n, area: n * W().H * W().H, meanCm: n ? sum / n : 0, maxCm: mx, cracked: cr, floes: st.floes.length, waves: st.waves.length, T: st.T, turns: st.turns };
  };
})(window.SS = window.SS || {});
