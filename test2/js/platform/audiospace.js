/* platform/audiospace.js — P65j: audio that makes physical sense. Presentation only (never touches js/sim state; Math.random is fine).
 * Pure geometry + mixing rules; the WebAudio / HTMLAudio nodes live in audio.js (AU.play(id, vol, rate, jit, pos, opt), AU.bed()).
 *
 * LISTENER. The ears are at the camera focus (the point the player looks at, view.camT: usually the active worm), the orientation (left / right)
 * is the camera's. A zoomed-out camera therefore does not make a blast next to the worm quiet.
 * SOURCE MODEL eval(p, opt) -> { gain, fc, pan, delay, wet, muffle }:
 *   - distance attenuation: inverse law past a reference distance, gain = 1 / (1 + roll (d - ref) / ref), per class (loud blasts carry far,
 *     footsteps stay local); the same shape as the WebAudio PannerNode 'inverse' model (MDN), floored so nothing vanishes in the map.
 *   - air absorption: low-pass fc = 20 kHz exp(-d / L) (ISO 9613-1: ~25 dB/km at 4 kHz, ~75 dB/km at 8 kHz; the map is only ~100 m, so L is
 *     shortened ~3x for audibility), floor 1.8 kHz.
 *   - speed of sound: a loud source farther than 18 m arrives d / 343 s after the flash (cap 0.9 s).
 *   - occlusion: metres of solid terrain on the line source -> listener (world.solid_len); gain x exp(-0.07 m), fc = 20 kHz / (1 + 0.9 m)
 *     (floor 450 Hz): the dull, bass-only 'behind a hill' sound (Wwise / CryEngine occlusion practice: volume cut + low-pass on the direct path).
 *   - enclosure: 5 rays (up 14 m, 4 horizontal 8 m) from the source; a covered / cave source sends more to the reverb (open air: nearly dry).
 *   - water: a listener under the surface hears everything through 600 Hz low-pass; an underwater source heard from air is muffled to 1.1 kHz.
 *   - pan from the camera's right vector, d / pan law (3 + 0.6 d).
 * HTMLAudio (file://) cannot filter or pan: AU.play uses gain (and a muffle volume cut) only; delay by setTimeout.
 * AMBIENCE frame(S): wind / whirlwind / rain / snow / ash / lava / surf / birds / crickets / cave / fire levels from the camera focus (10 Hz). */
(function (SS) {
  'use strict';
  const AU = SS.audio;
  if (!AU) return;
  const SP = AU.space = {};
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const CLS = { loud: { ref: 40, roll: 0.5, air: 190, min: 0.1 }, norm: { ref: 22, roll: 1, air: 110, min: 0.1 }, quiet: { ref: 9, roll: 1.6, air: 60, min: 0.05 } };
  const L = SP.L = { fx: 0, fy: 0, fz: 0, rx: 1, ry: 0, rz: 0, uw: false, ok: false, S: null, enc: 0, t: 0 };
  let T = 0;                                                                   // seconds of audio-frame time

  function surf(x, z) { const S = L.S; return S && SS.sim && SS.sim.surface_at ? SS.sim.surface_at(S, x, z) : -1e9; }
  function updateListener() {
    const V = SS.view, cam = V && V.camera && V.camera(), st = V && V.state;
    if (!cam || !st || !st.camT) { L.ok = false; return; }
    const e = cam.matrixWorld.elements;
    L.fx = st.camT.x; L.fy = st.camT.y; L.fz = st.camT.z; L.rx = e[0]; L.ry = e[1]; L.rz = e[2];
    const W = SS.world, p = cam.position;
    L.uw = !!(L.S && !W.under && (p.y < surf(p.x, p.z) - 0.05 || L.fy < surf(L.fx, L.fz) - 0.05));
    L.ok = true;
  }
  SP.listener = () => { updateListener(); return L; };

  /* enclosure 0..1 at a point: share of 5 probe rays that hit rock soon (a cave / overhang / canyon pocket). Cached per 2 m cell for 1.5 s. */
  const encCache = new Map();
  SP.enclosure = function (x, y, z) {
    const W = SS.world; if (!W || !W.raycast) return 0;
    const key = ((x / 2) | 0) + ',' + ((y / 2) | 0) + ',' + ((z / 2) | 0), c = encCache.get(key);
    if (c && T - c.t < 1.5) return c.v;
    const y0 = y + 0.6;
    let hit = 0;
    if (W.raycast(x, y0, z, 0, 1, 0, 14) >= 0) hit += 1.4;
    if (W.raycast(x, y0, z, 1, 0, 0, 8) >= 0) hit += 0.4;
    if (W.raycast(x, y0, z, -1, 0, 0, 8) >= 0) hit += 0.4;
    if (W.raycast(x, y0, z, 0, 0, 1, 8) >= 0) hit += 0.4;
    if (W.raycast(x, y0, z, 0, 0, -1, 8) >= 0) hit += 0.4;
    let v = clamp(hit / 3, 0, 1); if (W.under) v = Math.max(v, 0.75);
    if (encCache.size > 300) encCache.clear();
    encCache.set(key, { v, t: T });
    return v;
  };

  /* metres of terrain between the source and the listener focus */
  function occlusion(p, d) {
    const W = SS.world; if (!W || !W.solid_len || d < 2 || d > 160) return 0;
    return Math.min(40, W.solid_len(p.x, p.y + 0.4, p.z, L.fx, L.fy, L.fz));
  }

  SP.eval = function (p, o) {
    updateListener();
    const out = { gain: 1, fc: 20000, pan: 0, delay: 0, wet: 0.06, muffle: 0, d: 0, occ: 0 };
    if (!L.ok || !p || !(p.x === p.x)) return out;
    o = o || {};
    const c = CLS[o.cls] || CLS.norm, dx = p.x - L.fx, dy = p.y - L.fy, dz = p.z - L.fz, d = Math.hypot(dx, dy, dz);
    out.d = d;
    out.gain = Math.max(c.min, 1 / (1 + c.roll * Math.max(0, d - c.ref) / c.ref));
    out.fc = clamp(20000 * Math.exp(-d / c.air), 1800, 20000);
    out.pan = clamp((dx * L.rx + dy * L.ry + dz * L.rz) / (3 + 0.6 * d), -0.85, 0.85);
    if (o.cls === 'loud' && o.delay !== false && d > 18) out.delay = Math.min(0.9, d / 343);
    const occ = o.occ === false ? 0 : occlusion(p, d);
    if (occ > 0.4) { out.occ = occ; out.gain *= Math.max(o.cls === 'loud' ? 0.45 : 0.25, Math.exp(-0.07 * occ)); out.fc = Math.min(out.fc, Math.max(450, 20000 / (1 + 0.9 * occ))); }
    const srcUW = !o.noUW && L.S && !SS.world.under && p.y < surf(p.x, p.z) - 0.1;
    if (L.uw) { out.fc = Math.min(out.fc, srcUW ? 1400 : 600); if (!srcUW) out.gain *= 0.8; }
    else if (srcUW) { out.fc = Math.min(out.fc, 1100); out.gain *= 0.7; }
    const enc = SP.enclosure(p.x, p.y, p.z);
    out.wet = (0.05 + 0.5 * enc) * (L.uw ? 0.3 : 1) * (o.cls === 'quiet' ? 0.7 : 1);
    out.muffle = clamp(1 - out.fc / 20000, 0, 1);
    return out;
  };

  /* ---------- surfaces ---------- */
  const M = () => SS.CFG.MAT;
  /* material -> class used by the sound ids: soil rock sand snow ash metal concrete ice */
  SP.matClass = function (m) {
    const T0 = M();
    switch (m) {
      case T0.SAND: return 'sand';
      case T0.SNOW: return 'snow';
      case T0.ASH: return 'ash';
      case T0.STEEL: return 'metal';
      case T0.CONCRETE: return 'concrete';
      case T0.ICE: return 'ice';
      case T0.ROCK: case T0.BEDROCK: case T0.SANDSTONE: case T0.BASALT: case T0.OBSIDIAN: case T0.SCREE: case T0.LAVA: return 'rock';
      default: return 'soil';
    }
  };
  const STEP = { soil: 'step_soil', rock: 'step_rock', sand: 'step_sand', snow: 'step_snow', ash: 'step_ash', metal: 'step_metal', concrete: 'step_rock', ice: 'step_rock' };
  const LAND = { soil: 'worm_land_thud', rock: 'land_rock', sand: 'land_sand', snow: 'land_snow', ash: 'land_sand', metal: 'land_metal', concrete: 'land_rock', ice: 'land_rock' };
  const BOUNCE = { soil: 'bounce_soil', rock: 'bounce_rock', sand: 'bounce_sand', snow: 'bounce_snow', ash: 'bounce_sand', metal: 'bounce_metal', concrete: 'bounce_concrete', ice: 'bounce_concrete' };
  SP.stepId = cls => STEP[cls] || 'step_soil';
  SP.landId = cls => LAND[cls] || 'worm_land_thud';
  SP.bounceId = cls => BOUNCE[cls] || 'bounce_metal';

  /* worm footsteps: one per contraction hump of the crawl (same phase as the footstep dust in render/trails.js) or per 0.55 m; wading steps in
   * shallow water; every step is a 'quiet' source at the feet. At most 5 plays / s overall. */
  const track = new Map(); let stepBudget = 0;
  SP.steps = function (S, dt) {
    const W = SS.world; dt = Math.min(dt, 0.1); stepBudget = Math.min(5, stepBudget + dt * 5);
    for (const w of S.worms) {
      if (w.dead) { track.delete(w.id); continue; }
      let tr = track.get(w.id); const x = w.pos.x, z = w.pos.z;
      if (!tr) { tr = { x, z, acc: 0, ph: null, wacc: 0 }; track.set(w.id, tr); }
      const step = Math.hypot(x - tr.x, z - tr.z); tr.x = x; tr.z = z;
      const ground = !w.air && !w.swim && !w.drowning && !w.slide;
      if (step > 1.5 || !ground) { tr.acc = 0; tr.wacc = 0; tr.ph = null; continue; }
      if (!(step > 1e-4 && step / Math.max(dt, 1e-3) > 0.3)) continue;
      tr.acc += step; tr.wacc += step;
      const feetY = w.pos.y - 0.5, sf = SS.sim.surface_at(S, x, z);
      const wading = sf > feetY + 0.05 && sf < feetY + 0.75;
      let now = false;
      const vv = SS.actors && SS.actors.vis ? SS.actors.vis(w) : null, ps = vv && vv.v && vv.v.pose;
      if (ps && ps.crawl > 0.25) { const ph = Math.floor(ps.wave + 0.07); if (tr.ph == null) tr.ph = ph; if (ph !== tr.ph) { tr.ph = ph; now = true; } }
      else if (tr.acc > 0.55) now = true;
      if (!now || stepBudget < 1) continue;
      tr.acc = 0; stepBudget -= 1;
      const pos = { x, y: feetY + 0.1, z };
      if (wading) { if (tr.wacc > 0.3) { tr.wacc = 0; AU.play('step_wade', 0.55, 1, 0.04, { x, y: sf, z }, { cls: 'quiet', noUW: true }); } continue; }
      const g = W.topHeight(x, z), cls = SP.matClass(W.mat_at(x, g - 0.12, z));
      const v = (w === S.active ? 0.6 : 0.45) * clamp(0.6 + step / dt * 0.1, 0.6, 1);
      AU.play(SP.stepId(cls), v, 1, 0.05, pos, { cls: 'quiet', occ: false });
    }
  };

  /* ---------- ambience ---------- */
  const A = SP.amb = { wind: 0, whirl: 0, whirlPan: 0, whirlFc: 20000, whirlRate: 1, rain: 0, snow: 0, ash: 0, lava: 0, lavaPan: 0, surf: 0, surfPan: 0, birds: 0, crickets: 0, cave: 0, fire: 0, firePan: 0, hush: 0, muffle: 0, enc: 0 };
  let nextAmb = 0;
  /* a loud blast hushes birds and crickets for a few seconds (animals fall silent after a bang) */
  SP.hush = k => { A.hush = Math.max(A.hush, clamp(k, 0, 1)); };
  const panOf = (x, y, z) => clamp(((x - L.fx) * L.rx + (y - L.fy) * L.ry + (z - L.fz) * L.rz) / (4 + 0.5 * Math.hypot(x - L.fx, y - L.fy, z - L.fz)), -0.85, 0.85);

  SP.frame = function (S, dt) {
    T += dt; L.S = S;
    A.hush *= Math.exp(-dt / 5);
    if (T < nextAmb) return;
    nextAmb = T + 0.1;
    updateListener(); if (!L.ok) return;
    const W = SS.world, we = S.weather || {}, wd = S.wind, under = !!W.under, st = SS.view.state;
    const wmean = wd && wd.mean ? Math.hypot(wd.mean.x, wd.mean.z) : 0;
    A.enc = SP.enclosure(L.fx, L.fy - 1, L.fz);
    const sheltered = under ? 1 : A.enc * 0.8;                               // under a roof / in a pocket the open-air beds fade
    const open = 1 - sheltered;
    A.muffle = L.uw ? 0.95 : A.enc * 0.4;
    A.wind = under ? 0 : clamp(wmean / 14, 0, 1) * (1 - 0.6 * A.enc);
    A.rain = clamp((we.rain || 0) * 1.4, 0, 1) * open;
    A.snow = clamp((we.snow || 0) * 1.2, 0, 1) * open;
    A.ash = clamp((we.ash || 0) * 1.2, 0, 1) * open;
    // whirlwinds: the loudest of S.wind.whirls (env x grow = the life cycle, forming -> mature -> decaying), distance, radius
    let best = 0, bw = null;
    if (wd && wd.whirls && !under) for (let i = 0; i < wd.whirls.length; i++) {
      const w = wd.whirls[i], d = Math.hypot(w.x - L.fx, (w.gy || 0) + 2 - L.fy, w.z - L.fz), rc = w.rc || 2;
      const k = clamp(w.env || 0, 0, 1.3) * clamp(w.grow || 0, 0, 1) * (0.55 + 0.45 * Math.min(1, (w.vmax || 12) / 14)) / (1 + Math.pow(d / (14 + rc * 3), 2));
      if (k > best) { best = k; bw = w; }
    }
    A.whirl = clamp(best * 1.6, 0, 1) * (L.uw ? 0.2 : 1);
    if (bw) {
      A.whirlPan = panOf(bw.x, (bw.gy || 0) + 2, bw.z);
      const d = Math.hypot(bw.x - L.fx, bw.z - L.fz);
      A.whirlFc = clamp(20000 * Math.exp(-d / 150), 2500, 20000);
      A.whirlRate = clamp(0.92 + 0.1 * Math.min(1, Math.abs(bw.s || 0) / 14), 0.9, 1.04);       // faster spin: a hair higher, never a chipmunk
    }
    // lava: the hottest nearby cell; a volcano's far rumble in the volcanic biome
    let lv = S.biome === 'volcanic' && !under ? 0.12 : 0, lp = 0;
    if (SS.lava && S.lava && !L.uw) {
      let bk = 0;
      for (let r = 0; r <= 24; r += (r < 6 ? 3 : 9)) for (let a = 0; a < (r ? 8 : 1); a++) {
        const th = a * 0.785398, x = L.fx + Math.cos(th) * r, z = L.fz + Math.sin(th) * r;
        if (SS.lava.depth_at(S, x, z) > 0.05) { const k = 1 / (1 + r / 7); if (k > bk) { bk = k; lp = panOf(x, L.fy, z); } }
      }
      lv = Math.max(lv, bk * 0.9);
    }
    A.lava = lv; A.lavaPan = lp;
    // surf: shoreline proximity (water cells in rings around the focus) and a low listener height
    let sv = 0, sp = 0;
    if (!W.dry && !under && SS.water && S.water && !L.uw) {
      let bk = 0;
      for (let r = 0; r <= 36; r += (r < 6 ? 6 : 10)) for (let a = 0; a < (r ? 8 : 1); a++) {
        const th = a * 0.785398 + 0.3, x = L.fx + Math.cos(th) * r, z = L.fz + Math.sin(th) * r;
        if (x < 0 || z < 0 || x > W.SX || z > W.SZ) { if (S.biome !== 'canyon') { const k = 0.6 / (1 + r / 10); if (k > bk) { bk = k; sp = panOf(x, L.fy, z); } } continue; }
        if (SS.water.depth(S, x, z) > 0.25) { const k = 1 / (1 + r / 10); if (k > bk) { bk = k; sp = panOf(x, L.fy, z); } }
      }
      sv = bk * 0.85 * open;
    }
    A.surf = sv; A.surfPan = sp;
    // wildlife: birds by day in fair weather, crickets at night; not in caves / deserts' heat / on lava or snow; hushed by blasts
    const tod = st.tod || 'day', fair = (we.rain || 0) < 0.15 && (we.snow || 0) < 0.15 && (we.ash || 0) < 0.15 && (we.kind !== 'storm') && wmean < 9;
    const bio = S.biome, bday = bio === 'temperate' ? 1 : bio === 'canyon' ? 0.45 : bio === 'alpine' ? 0.3 : bio === 'desert' ? 0.12 : 0;
    const bnight = bio === 'temperate' ? 1 : bio === 'canyon' ? 0.5 : bio === 'desert' ? 0.5 : 0;
    const calm = fair && !under && !L.uw ? open * (1 - A.hush) : 0;
    A.birds = (tod === 'day' ? bday : tod === 'dusk' ? bday * 0.3 : 0) * calm;
    A.crickets = (tod === 'night' ? bnight : tod === 'dusk' ? bnight * 0.5 : 0) * calm;
    A.cave = under ? 0.7 : A.enc > 0.6 ? (A.enc - 0.6) : 0;
    // fire: nearest burning thing (props, napalm, grass cells), by distance
    let fv = 0, fp = 0;
    if (S.flames) for (let i = 0; i < S.flames.length && i < 40; i++) {
      const f = S.flames[i]; if (S.time >= f.t1) continue;
      const d = Math.hypot(f.x - L.fx, f.y - L.fy, f.z - L.fz), k = 1 / (1 + d / 8); if (k > fv) { fv = k; fp = panOf(f.x, f.y, f.z); }
    }
    const vg = S.veg;
    if (vg && vg.nAct && vg.act) {
      const NX = W.NX, H = W.H, n = Math.min(vg.nAct, 400), stp = Math.max(1, (n / 80) | 0);
      let cnt = 0;
      for (let i = 0; i < n; i += stp) {
        const c = vg.act[i], x = (c % NX) * H, z = ((c / NX) | 0) * H, d = Math.hypot(x - L.fx, z - L.fz);
        if (d < 30) { cnt++; const k = 1 / (1 + d / 10) * Math.min(1, 0.35 + cnt * 0.05); if (k > fv) { fv = k; fp = panOf(x, L.fy, z); } }
      }
    }
    A.fire = clamp(fv, 0, 1); A.firePan = fp;
  };
})(window.SS = window.SS || {});
