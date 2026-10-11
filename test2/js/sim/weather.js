/* sim/weather.js — weather (portable, deterministic; no DOM / Three.js).
 *
 * 5a: weather kind + wind. 5b: terrain wind factors + whirlwinds. 5c: precipitation + surface state. 5d: lightning.
 * - Randomness: an own RNG `S.weather.rng` seeded from the map seed and biome. Never S.rng: init runs in initState
 *   before water / vegetation / scatter / worm spawns, so a single S.rng draw would move every layout.
 * - Kind: S.settings.weather ('auto' = drawn from C.WEATHER_AUTO[biome]); per-kind targets in C.WEATHER_KIND.
 * - Wind: heading `dir` (rad in xz, the direction the air moves TOWARD: (cos, sin)) and `speed` at 10 m (m/s);
 *   S.settings.wind = calm | breeze | strong | gale (C.WIND.CLASSES) or 'auto' (the kind's band). Each new turn
 *   the heading and speed take a bounded random walk (DRIFT_DIR, DRIFT_V, inside the band). Gusts: smooth
 *   deterministic noise of S.time, g(t) = 1 + G (0.55 sin(w1 t + p1) + 0.3 sin(w2 t + p2) + 0.15 sin(w3 t + p3)).
 *   S.wind.mean = gusted wind at 10 m; wind_at() applies the log profile over the local ground (z0 = Z0),
 *   u(h) = u10 ln((h + z0)/z0) / ln((10 + z0)/z0), h >= H_MIN, capped at P_MAX; under the terrain top SHELTER.
 * - Sea swell: heading = wind heading, amplitude SWELL_A (0.6 + 0.06 speed) (x0.6 .. x1.8).
 * - Terrain field (5b), 2 m cells (GRID), rebuilt when the heading changed or the world was edited (<= 2 per s):
 *   exposure e = ground - mean ground within MEAN_R -> ridge speed-up sp = 1 + clamp(RIDGE_K e); lee: the highest
 *   ground up to LEE_SCAN m upwind (crest), wall dh = crest - ground -> lee = smoothstep(LEE_DH) blends in a
 *   reversed flow -LEE_REV u below the crest (fading over crest -1 .. +1 m); valleys (-e within CHAN) turn the flow
 *   toward the contour (channelling). Unit-wind vectors (fx, fz) per cell; wind_at samples them bilinearly.
 * - Whirlwinds (5b): every 1 s of sim time one RNG draw; with fewer than MAX alive and wind >= MIN_WIND (or a clear
 *   hot desert) a whirl spawns with probability RATE at a candidate cell (lee walls / cliff feet, canyon floors,
 *   flat desert) within NEAR m of the section origin. Lamb-Oseen tangential speed + radial inflow near the ground +
 *   core updraft up to its height h; grows 1.5 s, decays over its last 2 s, drifts with the 2 m wind.
 *   S.wind.whirls[] {x, z, r (shader radius), s (signed peak speed x envelope), rc, G, up, h, sign, age, life}.
 *   P65a: each whirl has a life cycle FORMING -> MATURE -> DECAYING (outward gust ring) -> DEAD, tracks the terrain
 *   (wind + downslope + wander, blocked by walls), leans / snakes, and respawns (see the block comment above makeWhirl).
 * - Precipitation (5c, C.PRECIP): rain / snow / ash move toward the kind's targets (rT, sT, aT) at RAMP; ground
 *   wetness `wet` rises with rain and dries in its absence (faster in wind) — veg spreads like rain on soaked fuel,
 *   tree ignition thresholds scale by (1 + TREE_WET wet). Per-column cover depth grids `snowD` / `ashD` (193², m),
 *   updated every TICK s: snowfall / ashfall accumulate on every column top (the render keeps it to up-facing
 *   ground), capped; a column whose top moved (crater, spoil: W listener + top0) is bare; burning grass, lava and
 *   water clear snow, water washes ash; clear weather melts snow slowly. `snowCover` (grass) = mean
 *   min(1, snowD / COVER_D) within COVER_R of the section origin; `coverVer`++ per change (render upload).
 * - Lightning (5d, C.LIGHTNING, storm only): `nextStrike` = now + GAP (weather RNG); candidates within NEAR of the
 *   section origin: alive tree tops (K_TREE), terrain spires = wind-field cells higher than their 8 neighbours with
 *   exposure > SPIRE_E (K_SPIRE), barrels (K_BARREL), worms with open sky above (K_WORM); weight (top - SEA)^2 x K.
 *   Tree: SS.trees.strike (70 % leaves stripped, top segment snaps with p BREAK_P, burns). Then sim.explode W at the
 *   strike point and the events 'lightning' {x, y, z, kind, id, seed} + 'thunder' {x, y, z} (the render delays the
 *   sound by distance / 343 m/s). `strikes` counts them.
 * C layout: struct Wind { f32 dir, speed, gust, gustA, lo, hi; vec3 mean; Whirl whirls[4]; Field *field; };
 *   struct Field { f32 hg[48*48], fx[], fz[], sp[], crest[]; i32 cand[]; f32 candW[]; u32 ver; f32 dir, t; };
 *   struct Weather { u8 kind; f32 rain, snow, ash, cloud, rT, sT, aT, wet, snowCover; u8 storm; const char *sky; Rng rng;
 *     f32 ph[3]; f32 *snowD, *ashD, *top0; u32 coverVer; f32 tick; }.
 * API: init(S), step(S, dt), new_turn(S), wind_at(S, x, y, z, out), set_wind(S, dir, speed, gustA), describe(S),
 *   spawn_whirl(S, x, z, o) (tests), field(S) (debug: the grid).
 */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, K = C.WIND;
  const WE = SS.weather = {};
  const W = () => SS.world;

  const gustOf = v => v <= 0 ? 0 : M.min(0.35, 0.2 + 0.0125 * v);

  function pickKind(S, r) {
    if (W().under) return 'clear';                                    // U: no weather underground
    const want = S.settings.weather;
    if (want && want !== 'auto' && C.WEATHER_KIND[want]) return want;
    const tab = C.WEATHER_AUTO[S.biome] || C.WEATHER_AUTO.temperate;
    let u = M.rng_next(r), last = 'clear';
    for (let i = 0; i < tab.length; i++) { last = tab[i][0]; u -= tab[i][1]; if (u < 0) return last; }
    return last;
  }

  /* band [lo, hi] the speed stays in, and the starting speed */
  function windBand(S, kind, r) {
    if (W().under) return { lo: 0, hi: 0, v: 0, g: 0 };              // U: still air in the caves
    const cls = S.settings.wind;
    if (cls && cls !== 'auto' && K.CLASSES[cls]) {
      const v = K.CLASSES[cls][0];
      return { lo: v * 0.75, hi: v * 1.25, v, g: K.CLASSES[cls][1] };
    }
    const b = S.biome === 'desert' && kind === 'clear' ? K.DESERT_AUTO : C.WEATHER_KIND[kind].wind;
    const v = M.rng_range(r, b[0], b[1]);
    return { lo: b[0], hi: b[1], v, g: gustOf(v) };
  }

  function swell(S) {
    const st = S.water, w = S.wind;
    if (!st || !w) return;
    st.swellDir = w.dir;
    st.swellA = W().dry ? 0 : C.WATER.SWELL_A * M.clamp(0.6 + 0.06 * w.speed, 0.6, 1.8);   // dry worlds: no sea
  }

  function updateMean(S) {
    const w = S.wind, t = S.time || 0, ph = S.weather.ph, f = K.GUST_W;
    w.gust = 1 + w.gustA * (0.55 * M.sin(f[0] * t + ph[0]) + 0.3 * M.sin(f[1] * t + ph[1]) + 0.15 * M.sin(f[2] * t + ph[2]));
    const v = w.speed * w.gust;
    w.mean.x = M.cos(w.dir) * v; w.mean.y = 0; w.mean.z = M.sin(w.dir) * v;
  }

  /* ---------- terrain field (5b) ---------- */
  const GC = K.GRID;
  const sstep = (a, b, x) => { const t = M.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  function buildField(S) {
    const wd = W(), w = S.wind, GN = Math.ceil(wd.NX * wd.H / GC), N = GN * GN, per = Math.round(GC / wd.H);
    let f = w.field;
    if (!f || f.GN !== GN) {
      const F = () => new Float32Array(N);
      f = w.field = { GN, hg: F(), mn: F(), tmp: F(), fx: F(), fz: F(), sp: F(), crest: F(), cand: new Int32Array(N), candW: F(), nCand: 0, ver: -1, dir: NaN, t: -99, builds: 0, ms: 0 };
    }
    // ground per cell: mean of W.top over its columns
    for (let ck = 0; ck < GN; ck++) for (let ci = 0; ci < GN; ci++) {
      let s = 0, n = 0;
      for (let k = ck * per; k < M.min(wd.NZ, ck * per + per); k++) for (let i = ci * per; i < M.min(wd.NX, ci * per + per); i++) { s += wd.top[k * wd.NX + i]; n++; }
      f.hg[ck * GN + ci] = n ? s / n : wd.SEA;
    }
    // neighbourhood mean (separable box, radius MEAN_R)
    const R = Math.round(K.MEAN_R / GC), hg = f.hg, tmp = f.tmp, mn = f.mn;
    for (let k = 0; k < GN; k++) for (let i = 0; i < GN; i++) { let s = 0, n = 0; for (let d = -R; d <= R; d++) { const ii = i + d; if (ii >= 0 && ii < GN) { s += hg[k * GN + ii]; n++; } } tmp[k * GN + i] = s / n; }
    for (let k = 0; k < GN; k++) for (let i = 0; i < GN; i++) { let s = 0, n = 0; for (let d = -R; d <= R; d++) { const kk = k + d; if (kk >= 0 && kk < GN) { s += tmp[kk * GN + i]; n++; } } mn[k * GN + i] = s / n; }
    const ux = M.cos(w.dir), uz = M.sin(w.dir), samp = (x, z) => {        // ground at a point (nearest cell)
      const i = M.clamp(Math.floor(x / GC), 0, GN - 1), k = M.clamp(Math.floor(z / GC), 0, GN - 1); return hg[k * GN + i];
    };
    let nc = 0;
    for (let k = 0; k < GN; k++) for (let i = 0; i < GN; i++) {
      const c = k * GN + i, x = (i + 0.5) * GC, z = (k + 0.5) * GC, g = hg[c], e = g - mn[c];
      const sp = 1 + M.clamp(K.RIDGE_K * e, K.RIDGE_MIN, K.RIDGE_MAX);
      // lee: the highest ground upwind within LEE_SCAN
      let crest = g;
      for (let d = GC; d <= K.LEE_SCAN + 1e-6; d += GC) crest = M.max(crest, samp(x - ux * d, z - uz * d));
      const lee = sstep(K.LEE_DH[0], K.LEE_DH[1], crest - g);
      // channelling: valley cells turn toward the contour of the smoothed ground (the side with u . t > 0)
      const gx = (mn[k * GN + M.min(GN - 1, i + 1)] - mn[k * GN + M.max(0, i - 1)]) / (2 * GC), gz = (mn[M.min(GN - 1, k + 1) * GN + i] - mn[M.max(0, k - 1) * GN + i]) / (2 * GC);
      const gl = M.len2(gx, gz), chan = sstep(K.CHAN[0], K.CHAN[1], -e) * sstep(0.03, 0.12, gl) * K.CHAN_MIX;
      let dx = ux, dz = uz;
      if (chan > 0) {
        let tx = -gz / gl, tz = gx / gl; if (tx * ux + tz * uz < 0) { tx = -tx; tz = -tz; }
        dx = ux + (tx - ux) * chan; dz = uz + (tz - uz) * chan; const l = M.nz(M.len2(dx, dz), 1); dx /= l; dz /= l;
      }
      f.fx[c] = dx * sp * (1 - lee) - ux * K.LEE_REV * lee;
      f.fz[c] = dz * sp * (1 - lee) - uz * K.LEE_REV * lee;
      f.sp[c] = sp; f.crest[c] = lee > 0 ? crest : g;
      // whirl candidates: cliff feet in the lee, canyon floors, flat hot desert (above the sea)
      const mask = (lee > 0.3 ? 1 : 0) | (chan > 0.4 ? 2 : 0) | (gl < 0.08 && g > wd.SEA + 0.5 ? 4 : 0);
      if (mask > 0 && g > wd.SEA + 0.3) { f.cand[nc] = c; f.candW[nc] = mask; nc++; }
    }
    f.nCand = nc; f.ver = wd.version - (S.verBase || 0); f.dir = w.dir; f.t = S.time; f.builds++;   // (no timing here: the sim never reads the wall clock; profile from the platform)
  }
  function needField(S) {
    const f = S.wind.field;
    return !f || f.dir !== S.wind.dir || (f.ver !== W().version - (S.verBase || 0) && S.time - f.t >= 0.5);
  }

  /* ---------- whirlwinds (5b, P65a life cycle) ----------
   * A dust devil forms over hot, flat or sheltered ground, grows, wanders downslope and downwind, and dies:
   *   FORMING (T_FORM s): radius, height and strength grow from 0 (smoothstep), the track starts slowly.
   *   MATURE (life s): strength fluctuates (three sines), it follows wind(2 m) x TRACK_K + slope + a random walk,
   *     leans with the wind shear (lean m per m of height, LEAN_MAX) and snakes (sa, a sine along the axis); a rise
   *     steeper than STEEP, water or the map edge for BLOCK_T s ends it.
   *   DECAYING (T_DECAY s): rotation falls (1 - d)^1.5, the column shrinks and widens (it spreads out) and an outward
   *     gust ring (bst, expanding at BURST_V, e-folding BURST_T) blows radially over the ground in all directions.
   *   DEAD: removed once the ring has faded; with probability RESP_NEAR a new one is queued a few metres away
   *     (RESP s later), else at a random plausible spot (lee wall / cliff foot, canyon floor, hot flat sand).
   * All randomness: the weather RNG, a fixed number of draws per event; the per-step motion uses only the whirl's own
   * phases (sines of its age). C: struct Whirl { f32 x, z, gy, rc, rc0, vmax, G, h, h0, up, sign, age, t, life, tf, td, grow, env, str,
   *   lx, lz, px, pz, sa, vx, vz, bst, bt, blk, ph, ph2, ph3, r, s; u8 st; }; Whirl whirls[C.LIMITS.WHIRLS]; Respawn resp[WHIRL_RESP]. */
  const FORMING = 0, MATURE = 1, DECAYING = 2;
  const flatCand = (S, mask) => {                          // spawn weight of a candidate by its kind bits (1 lee, 2 canyon floor, 4 flat)
    const we = S.weather, hot = S.biome === 'desert' && we.kind === 'clear';
    let wgt = 0; if (mask & 3) wgt = 1;
    if ((mask & 4) && wgt < 1) { const v = hot ? 0.5 : (we.kind === 'clear' || we.kind === 'cloudy') && we.wet < 0.3 ? K.WHIRL.FLAT_W : 0; if (v > wgt) wgt = v; }
    return wgt;
  };
  function makeWhirl(S, x, z, o) {
    const r = S.weather.rng, WH = K.WHIRL, rr = (a) => M.rng_range(r, a[0], a[1]);
    const rc = o && o.rc || rr(WH.RC), vmax = o && o.vmax || rr(WH.VMAX), sign = o && o.sign || (M.rng_next(r) < 0.5 ? -1 : 1);
    const up = o && o.up || rr(WH.UP), h = o && o.h || rr(WH.H), shortLife = M.rng_next(r) < WH.SHORT_P;
    const life = o && o.life || (shortLife ? rr(WH.LIFE_SHORT) : rr(WH.LIFE)), tf = rr(WH.T_FORM), td = rr(WH.T_DECAY);
    const ph = M.rng_range(r, 0, 6.2832), ph2 = M.rng_range(r, 0, 6.2832), ph3 = M.rng_range(r, 0, 6.2832), sa = rr(WH.SNAKE) * rc;
    const gy = SS.world.topHeight(x, z), full = !!(o && o.age != null);
    const wl = { x, z, gy, rc: rc, rc0: rc, vmax, G: vmax * 2 * Math.PI * rc / 0.6382, sign, up, h, h0: h, life, tf, td,
      st: full ? MATURE : FORMING, t: full ? o.age : 0, age: full ? o.age + tf : 0, grow: full ? 1 : 0, env: 0, str: 1, lx: 0, lz: 0, px: 1, pz: 0, sa,
      vx: 0, vz: 0, bst: 0, bt: 0, blk: 0, ph, ph2, ph3, r: rc * 1.6, s: 0 };
    if (full) { wl.env = 1; wl.s = sign * vmax; }
    SS.sim.pool_push(S.wind.whirls, C.LIMITS.WHIRLS, wl);
    return wl;
  }
  /* pick a candidate cell (weighted by kind); near = {x, z, r0, r1} prefers an annulus about the old whirl (when it has
   * candidates), else any cell within NEAR of the section origin. Always three draws (pick, jitter x, jitter z) once there is a candidate. */
  function pickSpot(S, near) {
    const f = S.wind.field, we = S.weather; if (!f || !f.nCand) return null;
    const WH = K.WHIRL, O = S.O || { x: W().MX, z: W().MZ };
    const inR = (c, ann) => {
      const x = (c % f.GN + 0.5) * GC, z = ((c / f.GN | 0) + 0.5) * GC;
      if (M.len2(x - O.x, z - O.z) >= WH.NEAR || x < 4 || z < 4 || x > W().NX * W().H - 4 || z > W().NZ * W().H - 4) return false;
      if (!ann) return true;
      const d = M.len2(x - ann.x, z - ann.z); return d >= ann.r0 && d <= ann.r1;
    };
    const total = ann => { let t = 0; for (let q = 0; q < f.nCand; q++) if (inR(f.cand[q], ann)) t += flatCand(S, f.candW[q]); return t; };
    let ann = near, tot = near ? total(near) : 0;
    if (tot <= 0) { ann = null; tot = total(null); }
    if (tot <= 0) return null;
    let pick = M.rng_next(we.rng) * tot; const jx = M.rng_next(we.rng) - 0.5, jz = M.rng_next(we.rng) - 0.5;
    let c0 = -1;
    for (let q = 0; q < f.nCand; q++) {
      if (!inR(f.cand[q], ann)) continue;
      const wg = flatCand(S, f.candW[q]); if (wg <= 0) continue;
      c0 = f.cand[q]; pick -= wg; if (pick < 0) break;
    }
    const x = (c0 % f.GN + 0.5) * GC, z = ((c0 / f.GN | 0) + 0.5) * GC, wd = W();
    const jxx = x + jx * GC * 0.9, jzz = z + jz * GC * 0.9;
    return wd.topHeight(jxx, jzz) > wd.SEA + 0.3 ? { x: jxx, z: jzz } : { x, z };
  }
  function canSpawn(S) {
    const w = S.wind, WH = K.WHIRL, hot = S.biome === 'desert' && S.weather.kind === 'clear';
    return w.whirls.length < WH.MAX && (w.speed >= WH.MIN_WIND || hot);
  }
  const noise3 = (t, a, b, c) => 0.55 * M.sin(0.9 * t + a) + 0.3 * M.sin(2.1 * t + b) + 0.15 * M.sin(3.7 * t + c);
  const tmpW = { x: 0, y: 0, z: 0 };
  function startDecay(S, wl) {
    if (wl.st === DECAYING) return;
    wl.st = DECAYING; wl.t = 0; wl.bt = 0; wl.bst = K.WHIRL.BURST_K * wl.vmax * M.clamp(wl.env, 0.2, 1.1);
  }
  function stepWhirls(S, dt) {
    if (W().under) { S.wind.whirls.length = 0; S.weather.resp.length = 0; return; }   // U: no whirlwinds in the caves
    const w = S.wind, we = S.weather, WH = K.WHIRL, wd = W();
    // one draw per second of sim time: deterministic spawn cadence
    we.whirlAcc += dt;
    while (we.whirlAcc >= 1) {
      we.whirlAcc -= 1;
      const u = M.rng_next(we.rng);
      if (!canSpawn(S) || u >= WH.RATE) continue;
      const sp = pickSpot(S, null);
      if (sp) makeWhirl(S, sp.x, sp.z, null);
    }
    // respawns queued by dead whirls
    for (let q = 0; q < we.resp.length; q++) {
      const rs = we.resp[q]; if (S.time < rs.t) continue;
      we.resp.splice(q, 1); q--;
      if (!canSpawn(S)) continue;
      const sp = pickSpot(S, rs.near ? { x: rs.x, z: rs.z, r0: WH.RESP_R[0], r1: WH.RESP_R[1] } : null);
      if (sp) makeWhirl(S, sp.x, sp.z, null);
    }
    const X1 = wd.NX * wd.H - 1, Z1 = wd.NZ * wd.H - 1;
    for (let q = w.whirls.length - 1; q >= 0; q--) {
      const wl = w.whirls[q];
      wl.age += dt; wl.t += dt;
            if (wl.st === FORMING) {
        wl.grow = sstep(0, wl.tf, wl.t); wl.env = wl.grow;
        if (wl.t >= wl.tf) { wl.st = MATURE; wl.t = 0; }
      } else if (wl.st === MATURE) {
        wl.grow = 1; wl.str = M.clamp(1 + WH.FLUCT * noise3(wl.age, wl.ph, wl.ph2, wl.ph3), 0.4, 1.3);
        wl.env = wl.str;
        if (wl.t >= wl.life) startDecay(S, wl);
        else if (w.speed < WH.MIN_WIND * 0.5 && !(S.biome === 'desert' && we.kind === 'clear') && wl.t > 2) startDecay(S, wl);
      } else {
        const d = M.min(1, wl.t / wl.td);
        wl.env = wl.str * M.pow(1 - d, 1.5); wl.grow = 1 - 0.35 * d;
        wl.bt += dt; wl.bst *= M.exp(-dt / WH.BURST_T);
        if (wl.t >= wl.td && wl.bt >= WH.BURST_END) {
          w.whirls.splice(q, 1);
          if (M.rng_next(we.rng) < WH.RESP_NEAR) we.resp.push({ t: S.time + M.rng_range(we.rng, WH.RESP[0], WH.RESP[1]), x: wl.x, z: wl.z, near: 1 });
          else we.resp.push({ t: S.time + M.rng_range(we.rng, WH.RESP[0], WH.RESP[1]) * 1.6, x: wl.x, z: wl.z, near: 0 });
          if (we.resp.length > C.LIMITS.WHIRL_RESP) we.resp.shift();
          continue;
        }
      }
      // size: grows while forming, spreads and shrinks when decaying
      const dk = wl.st === DECAYING ? M.min(1, wl.t / wl.td) : 0;
      wl.rc = wl.rc0 * (0.55 + 0.45 * wl.grow) * (1 + 0.9 * dk);
      wl.h = wl.h0 * (0.3 + 0.7 * wl.grow);
      // track: the 2 m wind x TRACK_K, downslope drift, a random walk; slows while forming / decaying
      windBase(S, wl.x, wl.gy + 2, wl.z, tmpW);
      const gx = (wd.topHeight(wl.x + 1, wl.z) - wd.topHeight(wl.x - 1, wl.z)) * 0.5, gz = (wd.topHeight(wl.x, wl.z + 1) - wd.topHeight(wl.x, wl.z - 1)) * 0.5;
      const wa = WH.WANDER * M.sin(wl.age * 0.9 + wl.ph), th = wl.ph + wl.age * 0.5 + 1.2 * M.sin(wl.age * 0.23 + wl.ph2);
      const mv = wl.st === MATURE ? 1 : wl.st === FORMING ? 0.3 + 0.7 * wl.grow : 0.5 * (1 - dk) + 0.2;
      const tx = (tmpW.x * WH.TRACK_K + M.cos(th) * wa - gx * WH.SLOPE_K) * mv, tz = (tmpW.z * WH.TRACK_K + M.sin(th) * wa - gz * WH.SLOPE_K) * mv;
      wl.vx += (tx - wl.vx) * M.min(1, dt * 0.9); wl.vz += (tz - wl.vz) * M.min(1, dt * 0.9);
      // a wall 1 m ahead (rise > STEEP per metre): slide along it or stop; BLOCK_T s of that ends the whirl
      const sp = M.len2(wl.vx, wl.vz);
      if (sp > 0.05) {
        const ax = wl.vx / sp, az = wl.vz / sp;
        if (wd.topHeight(wl.x + ax, wl.z + az) - wl.gy > WH.STEEP) {
          const sx = wl.vx < 0 ? -1 : 1, sz = wl.vz < 0 ? -1 : 1, riseX = wd.topHeight(wl.x + sx, wl.z) - wl.gy, riseZ = wd.topHeight(wl.x, wl.z + sz) - wl.gy;
          if (riseX <= WH.STEEP && riseX <= riseZ) wl.vz *= 0.3; else if (riseZ <= WH.STEEP) wl.vx *= 0.3; else { wl.vx = 0; wl.vz = 0; }
          wl.blk += dt;
        } else wl.blk = M.max(0, wl.blk - dt * 0.5);
      } else wl.blk = M.max(0, wl.blk - dt * 0.5);
      const nx = wl.x + wl.vx * dt, nz = wl.z + wl.vz * dt, gn = wd.topHeight(nx, nz);
      wl.x = nx; wl.z = nz; wl.gy = gn;
      if (wl.st !== DECAYING && (wl.blk > WH.BLOCK_T || gn < wd.SEA + 0.15 || wl.x < 2 || wl.z < 2 || wl.x > X1 - 1 || wl.z > Z1 - 1)) startDecay(S, wl);
      // lean with the wind shear (upper 10 m wind - 2 m wind), clamped; the snake runs perpendicular to the lean
      const sh = WH.LEAN_K * M.clamp(w.speed * w.gust, 0, 12) * (wl.st === FORMING ? wl.grow : 1) * (1 - 0.5 * dk);
      let ux = w.mean.x, uz = w.mean.z; const ul = M.len2(ux, uz);
      if (ul > 1e-3) { ux /= ul; uz /= ul; wl.lx = ux * M.min(WH.LEAN_MAX, sh); wl.lz = uz * M.min(WH.LEAN_MAX, sh); wl.px = -uz; wl.pz = ux; }
      else { wl.lx = wl.lz = 0; wl.px = M.cos(wl.ph3); wl.pz = M.sin(wl.ph3); }
      wl.s = wl.sign * wl.vmax * wl.env;
      wl.r = wl.rc * 1.6;
    }
  }
  /* the axis of a whirl at height hh above its base: the lean (m per m) + the snake (a sine along the column) */
  WE.whirl_axis = function (wl, hh, out) {
    const k = M.min(1, hh / M.max(wl.h, 1)), sn = wl.sa * k * M.sin(hh * 0.45 - wl.age * 1.4 + wl.ph2);
    out.x = wl.x + wl.lx * hh + wl.px * sn; out.z = wl.z + wl.lz * hh + wl.pz * sn;
    return out;
  };
  const tmpA = { x: 0, z: 0 };
  /* whirl velocity added at a point (h = height above the local ground) */
  function whirlAt(w, x, y, z, h, out) {
    for (let q = 0; q < w.whirls.length; q++) {
      const wl = w.whirls[q];
      // the outgoing gust ring of a dying whirl: radial, near the ground, expanding
      if (wl.bst > 0.02 && h < 4) {
        const bx = x - wl.x, bz = z - wl.z, br = M.len2(bx, bz), rb = wl.rc0 * 1.5 + K.WHIRL.BURST_V * wl.bt, ww = wl.rc0 + 1.5 + 0.8 * wl.bt;
        if (br > 1e-3 && br < rb + 3 * ww) {
          const g = M.exp(-((br - rb) / ww) * ((br - rb) / ww)) * wl.bst * (1 - sstep(1.5, 4, h));
          out.x += bx / br * g; out.z += bz / br * g;
        }
      }
      if (wl.env <= 0.001 || h > wl.h) continue;
      WE.whirl_axis(wl, h, tmpA);
      const dx = x - tmpA.x, dz = z - tmpA.z, r2 = dx * dx + dz * dz, rcz = wl.rc * (1 + 0.4 * M.min(1, h / M.max(wl.h, 1))), rc2 = rcz * rcz;
      if (r2 > 36 * rc2) continue;
      const hf = wl.env * (1 - sstep(wl.h * 0.7, wl.h, h));
      if (hf <= 0) continue;
      const r = Math.sqrt(r2), ex = M.exp(-r2 / rc2);
      if (r > 1e-4) {
        const vt = wl.G * (rcz / wl.rc) / (2 * Math.PI * r) * (1 - ex) * hf, inflow = -0.25 * vt * (1 - sstep(0.5, 3, h));
        out.x += (wl.sign * -dz / r) * vt + dx / r * inflow;
        out.z += (wl.sign * dx / r) * vt + dz / r * inflow;
      }
      out.y += wl.up * ex * hf;
    }
  }

  /* ---------- precipitation and surface state (5c) ---------- */
  const P = C.PRECIP;
  let dirty = null;                                     // edited lattice columns since the last cover update
  // the pending edit rect is sim state outside S: sim.snapshot / restore carry it (bit-identical replays)
  WE.dirty_get = () => (dirty ? { i0: dirty.i0, k0: dirty.k0, i1: dirty.i1, k1: dirty.k1 } : null);
  WE.dirty_set = d => { dirty = d ? { i0: d.i0, k0: d.k0, i1: d.i1, k1: d.k1 } : null; };
  function onMark(i0, k0, i1, k1) {
    if (!dirty) dirty = { i0, k0, i1, k1 };
    else { dirty.i0 = M.min(dirty.i0, i0); dirty.k0 = M.min(dirty.k0, k0); dirty.i1 = M.max(dirty.i1, i1); dirty.k1 = M.max(dirty.k1, k1); }
  }
  function initCover(S) {
    const wd = W(), we = S.weather, N = wd.NX * wd.NZ;
    if (wd.listeners.indexOf(onMark) < 0) wd.listeners.push(onMark);
    dirty = null;
    we.snowD = new Float32Array(N); we.ashD = new Float32Array(N); we.top0 = new Float32Array(wd.top);
    we.tick = 0; we.coverVer = 1; we.wet = M.min(1, we.rain > 0 ? 0.5 + 0.5 * we.rain : 0);
    const s0 = P.SNOW_INIT * we.snow, a0 = P.ASH_INIT * we.ash;
    for (let c = 0; c < N; c++) { if (wd.top[c] > wd.SEA + 0.05) { we.snowD[c] = s0; we.ashD[c] = a0; } }
  }
  function stepCover(S, dt) {
    const wd = W(), we = S.weather, w = S.wind, NX = wd.NX, N = NX * wd.NZ, r = P.RAMP * dt;
    we.rain += M.clamp(we.rT - we.rain, -r, r); we.snow += M.clamp(we.sT - we.snow, -r, r); we.ash += M.clamp(we.aT - we.ash, -r, r);
    we.wet = we.rain > 0.02 ? M.min(1, we.wet + P.WET_UP * we.rain * dt) : M.max(0, we.wet - P.WET_DRY * (1 + 0.1 * w.speed) * dt);
    we.tick += dt;
    if (we.tick < P.TICK) return;
    const T = we.tick; we.tick = 0;
    // trees: soaked wood is harder to light (lightning bypasses the threshold)
    if (S.trees && C.TREES) for (const t of S.trees) { t.thr = t.thr0 * (1 + P.TREE_WET * we.wet); }
    const snow = we.snowD, ash = we.ashD, top0 = we.top0, top = wd.top;
    // edits: columns whose top moved are bare (crater floor, fresh spoil)
    if (dirty) {
      for (let k = M.max(0, dirty.k0); k <= M.min(wd.NZ - 1, dirty.k1); k++) for (let i = M.max(0, dirty.i0); i <= M.min(NX - 1, dirty.i1); i++) {
        const c = k * NX + i;
        if (Math.abs(top[c] - top0[c]) > P.CLEAR_D) { snow[c] = 0; ash[c] = 0; }
        top0[c] = top[c];
      }
      dirty = null;
    }
    const ds = we.snow * P.SNOW_RATE * T, da = we.ash * P.ASH_RATE * T, melt = we.snow < 0.02 && we.rain < 0.02 ? P.SNOW_MELT * T : 0;
    const vg = S.veg, wa = S.water, lv = S.lava;
    for (let c = 0; c < N; c++) {
      if (top[c] <= wd.SEA + 0.05) { snow[c] = 0; ash[c] = 0; continue; }
      const wetC = wa && wa.h[c] > 0.004, hot = (vg && vg.burnT && vg.burnT[c] > 0) || (lv && lv.h && lv.h[c] > 0.01);
      if (wetC || hot) snow[c] = 0; else snow[c] = M.max(0, M.min(P.SNOW_MAX, snow[c] + ds - melt));
      if (wetC) ash[c] = 0; else ash[c] = M.min(P.ASH_MAX, ash[c] + da);
    }
    // snow cover near the section (grass blades shorten / whiten)
    const O = S.O || { x: W().MX, z: W().MZ }, H = wd.H, R = Math.round(P.COVER_R / H), ci = Math.round(O.x / H), ck = Math.round(O.z / H);
    let sum = 0, n = 0;
    for (let k = M.max(0, ck - R); k <= M.min(wd.NZ - 1, ck + R); k += 2) for (let i = M.max(0, ci - R); i <= M.min(NX - 1, ci + R); i += 2) { sum += M.min(1, snow[k * NX + i] / P.COVER_D); n++; }
    we.snowCover = n ? sum / n : 0;
    we.coverVer++;
  }

  /* ---------- lightning (5d) ---------- */
  const L = C.LIGHTNING;
  function strikeTargets(S) {
    const wd = W(), O = S.O || { x: W().MX, z: W().MZ }, out = [], near = (x, z) => M.len2(x - O.x, z - O.z) < L.NEAR, hw = h => M.max(0.5, h - wd.SEA);
    if (SS.trees && S.trees) for (const t of S.trees) {
      if (!t.alive || !near(t.x, t.z)) continue;
      const p = SS.trees.top_point(t); if (p) out.push({ kind: 'tree', ref: t, id: t.id, x: p.x, y: p.y, z: p.z, w: hw(p.y) * hw(p.y) * L.K_TREE });
    }
    const f = S.wind.field;
    if (f) for (let k = 1; k < f.GN - 1; k++) for (let i = 1; i < f.GN - 1; i++) {
      const c = k * f.GN + i, g = f.hg[c], x = (i + 0.5) * GC, z = (k + 0.5) * GC;
      if (g - f.mn[c] < L.SPIRE_E || !near(x, z)) continue;
      let top = true; for (let dk = -1; dk <= 1 && top; dk++) for (let di = -1; di <= 1; di++) if ((di || dk) && f.hg[c + dk * f.GN + di] >= g) { top = false; break; }
      if (top) { const y = wd.topHeight(x, z); out.push({ kind: 'spire', id: c, x, y, z, w: hw(y) * hw(y) * L.K_SPIRE }); }
    }
    for (const b of S.bodies) if (b.prop === 'barrel' && near(b.pos.x, b.pos.z)) out.push({ kind: 'barrel', ref: b, id: b.id, x: b.pos.x, y: b.pos.y + (b.rb || 0.4), z: b.pos.z, w: hw(b.pos.y) * hw(b.pos.y) * L.K_BARREL });
    for (const m of S.worms) {
      if (m.dead || !near(m.pos.x, m.pos.z)) continue;
      if (wd.topHeight(m.pos.x, m.pos.z) > m.pos.y + 0.3) continue;                       // a roof over it
      out.push({ kind: 'worm', ref: m, id: m.id, x: m.pos.x, y: m.pos.y + 0.4, z: m.pos.z, w: hw(m.pos.y) * hw(m.pos.y) * L.K_WORM });
    }
    return out;
  }
  /* PoC lightningStrike: two out of three storm strikes avoid worms, mines, bombs and barrels (PoC safeLightningSpot,
   * 100 px = 6.4 m); the third may hit anything (trees, spires, worms in the open...) */
  const SAFE_R = 6.4;
  function unsafe(S, x, z) {
    if (S.worms.some(w => !w.dead && M.len2(w.pos.x - x, w.pos.z - z) < SAFE_R)) return true;
    if (S.bodies.some(b => (b.prop === 'mine' || b.prop === 'barrel') && M.len2(b.pos.x - x, b.pos.z - z) < SAFE_R + (b.rb || 0))) return true;
    for (const p of S.proj) { const q = SS.plane.to_world(S, p.s, p.y); if (M.len2(q.x - x, q.z - z) < SAFE_R) return true; }
    return false;
  }
  function strike(S) {
    const we = S.weather, r = we.rng, avoid = M.rng_next(r) < 2 / 3;
    let cand = strikeTargets(S);
    if (avoid) cand = cand.filter(q => q.kind !== 'worm' && q.kind !== 'barrel' && !unsafe(S, q.x, q.z));
    let tot = 0; for (const q of cand) tot += q.w;
    const u = M.rng_next(r), brk = M.rng_next(r) < L.BREAK_P, seed = M.rng_int(r, 1 << 30);    // fixed draws per strike
    if (tot <= 0) return null;
    let pick = u * tot, tg = cand[cand.length - 1];
    for (const q of cand) { pick -= q.w; if (pick < 0) { tg = q; break; } }
    let p = { x: tg.x, y: tg.y, z: tg.z };
    if (tg.kind === 'tree') p = SS.trees.strike(S, tg.ref, { breakTop: brk }) || p;
    SS.sim.emit(S, 'lightning', { x: p.x, y: p.y, z: p.z, kind: tg.kind, id: tg.id, seed });
    SS.sim.emit(S, 'thunder', { x: p.x, y: p.y, z: p.z });
    S.lightning = 1;                                  // P37 W4: a tinfoil hat grounds it (sim.hurt takes 10 %)
    SS.sim.explode(S, { x: p.x, y: p.y, z: p.z }, { W: L.W, dmg: 10, name: 'lightning' }, null);   // PoC strike explode(.., 24, 10)
    if (SS.weapons && SS.weapons.electrocute) SS.weapons.electrocute(S, p, L.ZAP_R, L.ZAP_D, null);   // PoC electrocute(60, 16)
    S.lightning = 0;
    we.strikes++;
    return tg;
  }
  /* PoC (applyTurnStart): in a thunderstorm, each turn has a 60 % chance of ONE strike, at a random moment between 4 s
   * and 80 % of the turn time (WE.turn_lightning, called at every turn start) */
  function stepLightning(S) {
    const we = S.weather;
    if (!we.storm || we.nextStrike == null || S.time < we.nextStrike) return;
    we.nextStrike = null;
    strike(S);
  }
  WE.turn_lightning = function (S) {
    const we = S.weather; if (!we) return;
    we.nextStrike = null;
    if (!we.storm || W().under) return;
    if (M.rng_next(we.rng) < L.TURN_P) { const T = S.settings.turnTime > 0 ? S.settings.turnTime : 45; we.nextStrike = S.time + M.rng_range(we.rng, 4, M.max(6, T * 0.8)); }
  };
  WE.strike_now = function (S) { return strike(S); };     // tests

  WE.init = function (S) {
    const bi = M.max(0, C.BIOMES.findIndex(b => b.id === S.biome));
    const r = M.rng_make(((C.LAYOUT_SEED * 31 + Math.imul(S.settings.seed | 0, 104729) + bi * 7919 + 0x9e37) >>> 0) || 1);
    const kind = pickKind(S, r), KD = C.WEATHER_KIND[kind];
    S.weather = { kind, rain: KD.rain, snow: KD.snow, ash: KD.ash, cloud: KD.cloud, storm: KD.storm, sky: KD.sky,
      rT: KD.rain, sT: KD.snow, aT: KD.ash, wet: 0, snowCover: 0, rng: r, changes: 0, strikes: 0, whirlAcc: 0, resp: [], nextStrike: null,
      ph: [M.rng_range(r, 0, 6.2832), M.rng_range(r, 0, 6.2832), M.rng_range(r, 0, 6.2832)] };
    initCover(S);
    const b = windBand(S, kind, r);
    S.wind = { dir: M.rng_range(r, -Math.PI, Math.PI), speed: b.v, lo: b.lo, hi: b.hi, gustA: b.g, gust: 1,
      mean: { x: 0, y: 0, z: 0 }, whirls: [], field: null };
    updateMean(S);
  };

  WE.step = function (S, dt) {
    if (!S.weather || !S.wind) return;
    updateMean(S);
    if (needField(S)) buildField(S);
    stepWhirls(S, dt);
    stepCover(S, dt);
    stepLightning(S);
  };

  /* 5f: 'auto' weather changes between turns. The biome's kinds (C.WEATHER_AUTO, in severity order) form a chain;
   * each turn with probability C.WEATHER_CHANGE a neighbour kind is proposed and accepted with min(1, p_new / p_old)
   * (Metropolis): over many turns every kind keeps the biome's probability, and the weather only moves one step at
   * a time (clear -> cloudy -> rain -> storm). The precipitation ramps to the new targets (stepCover), the wind band
   * follows the kind. */
  function setKind(S, kind) {
    const we = S.weather, KD = C.WEATHER_KIND[kind];
    we.kind = kind; we.rT = KD.rain; we.sT = KD.snow; we.aT = KD.ash; we.cloud = KD.cloud; we.storm = KD.storm; we.sky = KD.sky;
    if (!we.storm) we.nextStrike = null;
    const b = windBand(S, kind, we.rng), w = S.wind;
    w.lo = b.lo; w.hi = b.hi; w.gustA = b.g; w.speed = M.clamp(w.speed, b.lo, b.hi);
    we.changes++;
  }
  function changeKind(S) {
    const we = S.weather, tab = C.WEATHER_AUTO[S.biome] || C.WEATHER_AUTO.temperate;
    let i = -1; for (let q = 0; q < tab.length; q++) if (tab[q][0] === we.kind) i = q;
    if (i < 0 || M.rng_next(we.rng) >= C.WEATHER_CHANGE) return false;
    const j = i + (M.rng_next(we.rng) < 0.5 ? -1 : 1);
    if (j < 0 || j >= tab.length) return false;
    if (M.rng_next(we.rng) >= M.min(1, tab[j][1] / tab[i][1])) return false;
    setKind(S, tab[j][0]);
    return true;
  }
  WE.set_kind = setKind;                                  // tests

  /* turn change (the first turn too: it only couples the swell, water.init ran after weather.init) */
  WE.new_turn = function (S) {
    const w = S.wind, r = S.weather && S.weather.rng;
    if (!w || !r) return;
    if (S.turnNo > 1 && (!S.settings.weather || S.settings.weather === 'auto') && changeKind(S)) {
      SS.sim.emit(S, 'weather', { kind: S.weather.kind });
      SS.sim.log(S, `The weather turns: ${C.WEATHER_NAME[S.weather.kind] || S.weather.kind}.`, 0xb8d8ff);
    }
    if (S.turnNo > 1 && w.hi > 0) {
      w.dir += M.rng_range(r, -K.DRIFT_DIR, K.DRIFT_DIR);
      if (w.dir > Math.PI) w.dir -= 2 * Math.PI; else if (w.dir < -Math.PI) w.dir += 2 * Math.PI;
      w.speed = w.lo + (w.hi - w.lo) * (M.rng_next(r) + M.rng_next(r)) / 2;   // PoC: a fresh wind every turn (triangular)
    }
    updateMean(S);
    swell(S);
  };

  /* wind velocity (m/s, world xz + vertical y) at a point: gusted wind x log height profile over the local ground,
   * steered by the terrain field (ridge, lee below the crest, channelling), plus the whirlwinds */
  function windBase(S, x, y, z, out) {
    const w = S.wind;
    out.x = out.y = out.z = 0;
    if (!w) return out;
    const wd = W(), i = Math.round(x / wd.H), k = Math.round(z / wd.H);
    const ground = i >= 0 && k >= 0 && i < wd.NX && k < wd.NZ ? wd.top[k * wd.NX + i] : wd.SEA;
    const under = y < ground - 0.5, h = M.max(K.H_MIN, y - ground);
    if (w.speed > 0) {
      const p = under ? K.SHELTER : M.min(K.P_MAX, M.log((h + K.Z0) / K.Z0) / M.log((10 + K.Z0) / K.Z0));
      const v = w.speed * w.gust * p, ux = M.cos(w.dir), uz = M.sin(w.dir), f = w.field;
      let fx = ux, fz = uz;
      if (f && f.dir === w.dir && !under) {
        const GN = f.GN, gx = M.clamp(x / GC - 0.5, 0, GN - 1.001), gz = M.clamp(z / GC - 0.5, 0, GN - 1.001);
        const i0 = gx | 0, k0 = gz | 0, a = gx - i0, b = gz - k0, c = k0 * GN + i0;
        const bl = A => (A[c] * (1 - a) + A[c + 1] * a) * (1 - b) + (A[c + GN] * (1 - a) + A[c + GN + 1] * a) * b;
        fx = bl(f.fx); fz = bl(f.fz);
        const crest = bl(f.crest), sp = bl(f.sp), above = M.clamp((y - crest) * 0.5 + 0.5, 0, 1);   // over the wall: free flow
        if (above > 0) { fx += (ux * sp - fx) * above; fz += (uz * sp - fz) * above; }
      }
      out.x = fx * v; out.z = fz * v;
    }
    return out;
  }
  WE.wind_at = function (S, x, y, z, out) {
    const w = S.wind;
    windBase(S, x, y, z, out);
    if (w && w.whirls.length) {
      const wd = W(), i = Math.round(x / wd.H), k = Math.round(z / wd.H);
      const ground = i >= 0 && k >= 0 && i < wd.NX && k < wd.NZ ? wd.top[k * wd.NX + i] : wd.SEA;
      if (y >= ground - 0.5) whirlAt(w, x, y, z, M.max(0, y - ground), out);
    }
    return out;
  };

  /* lockstep hash: weather RNG, wind, the whirlwinds' life cycle and the respawn queue */
  WE.hash = function (S, mix) {
    const we = S.weather, w = S.wind; if (!we || !w) return;
    mix(we.rng.s % 100003); mix(w.dir); mix(w.speed); mix(we.whirlAcc); mix(w.whirls.length);
    for (let q = 0; q < w.whirls.length; q++) {
      const a = w.whirls[q];
      mix(a.x); mix(a.z); mix(a.gy); mix(a.rc); mix(a.h); mix(a.env); mix(a.st); mix(a.t); mix(a.age); mix(a.vx); mix(a.vz); mix(a.bst); mix(a.bt); mix(a.blk);
    }
    mix(we.resp.length);
    for (let q = 0; q < we.resp.length; q++) { mix(we.resp[q].t); mix(we.resp[q].x); mix(we.resp[q].z); }
  };
  WE.spawn_whirl = function (S, x, z, o) { return makeWhirl(S, x, z, o); };
  WE.field = function (S) { if (S.wind && needField(S)) buildField(S); return S.wind && S.wind.field; };

  /* tests / menu: force heading, speed (m/s at 10 m) and gust amplitude; the band follows the speed */
  WE.set_wind = function (S, dir, speed, gustA) {
    const w = S.wind; if (!w) return;
    w.dir = dir; w.speed = M.max(0, speed); w.lo = w.speed * 0.75; w.hi = w.speed * 1.25;
    w.gustA = gustA == null ? gustOf(w.speed) : gustA;
    updateMean(S); swell(S);
  };

  /* HUD: kind, speed class, heading the wind blows FROM in compass degrees (0 = from -z, clockwise toward +x) */
  WE.describe = function (S) {
    const w = S.wind, we = S.weather; if (!w || !we) return null;
    const v = w.speed, cls = v < 0.5 ? 'calm' : v < 5 ? 'breeze' : v < 9.5 ? 'strong' : 'gale';
    const from = M.atan2(-M.cos(w.dir), M.sin(w.dir));      // bearing of the source, 0 = -z, +90 = +x
    return { kind: we.kind, speed: v, gust: w.gust, cls, fromDeg: ((from * 180 / Math.PI) + 360) % 360, dir: w.dir };
  };
})(window.SS = window.SS || {});
