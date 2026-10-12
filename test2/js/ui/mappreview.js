/* ui/mappreview.js — live map preview for the main menu (browser/canvas only; the data comes from the portable
 * SS.worldgen.preview, which runs only the 2D heightfield stage of the generator: ~10-20 ms, same surface as the real map).
 * Three renders from one PreviewData { n, sea, under, dry, h[n*n], lava[n*n], volcanoes[], biome, shape }:
 *   hero  - a pseudo-3D oblique view painted far to near (click = new seed),
 *   top   - a hill-shaded top view with the markers of the content densities (click = open the battlefield sub-menu),
 *   side  - a cross-section through the middle of the island plus the far silhouette (same click).
 * The content markers (trees, rocks, crates ...) are indicative: positions are drawn from the seed on dry land, the counts are
 * exactly what the world generator will be asked for (C.density_count). Everything is table-driven (RAMPS, MARKS). */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math;
  const PV = SS.mappreview = {};
  /* height ramps per biome: [metres above the sea (or above 0 on the dry map), r, g, b] */
  const RAMPS = {
    temperate: [[0, 226, 208, 150], [0.8, 226, 208, 150], [1.4, 104, 164, 76], [5, 82, 136, 58], [12, 118, 108, 88], [20, 190, 188, 180], [30, 236, 236, 232]],
    alpine: [[0, 150, 140, 125], [1, 128, 130, 116], [8, 112, 116, 122], [14, 150, 158, 168], [20, 238, 244, 250], [32, 252, 254, 255]],
    canyon: [[0, 214, 160, 104], [3, 200, 124, 76], [8, 176, 98, 58], [15, 142, 74, 46], [25, 110, 56, 38]],
    desert: [[0, 244, 222, 160], [6, 232, 198, 128], [12, 208, 166, 100], [18, 180, 134, 82], [30, 150, 108, 70]],
    volcanic: [[0, 78, 72, 70], [1, 58, 54, 54], [5, 46, 42, 44], [12, 70, 64, 62], [22, 96, 88, 84], [34, 128, 120, 114]]
  };
  const SKY = { day: ['#7fb6e8', '#cfe6f7'], dusk: ['#3a2c5c', '#ff9a5a'], night: ['#050914', '#16223d'] };
  const SEA_RGB = { shallow: [88, 196, 206], deep: [18, 66, 118] };

  function ramp(biome, e) {
    const r = RAMPS[biome] || RAMPS.temperate;
    if (e <= r[0][0]) return r[0];
    for (let i = 1; i < r.length; i++) if (e <= r[i][0]) { const a = r[i - 1], b = r[i], t = (e - a[0]) / (b[0] - a[0] || 1); return [0, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]; }
    return r[r.length - 1];
  }
  /* shaded colour of sample (i, k): [r, g, b] */
  function colour(d, i, k, shade) {
    const n = d.n, c = k * n + i, h = d.h[c], e = h - d.sea;
    if (d.lava[c]) return [255, 120 + 60 * shade, 20];
    let r, g, b;
    if (!d.dry && e < 0) {
      const t = M.clamp(-e / 5, 0, 1);
      r = SEA_RGB.shallow[0] + (SEA_RGB.deep[0] - SEA_RGB.shallow[0]) * t; g = SEA_RGB.shallow[1] + (SEA_RGB.deep[1] - SEA_RGB.shallow[1]) * t; b = SEA_RGB.shallow[2] + (SEA_RGB.deep[2] - SEA_RGB.shallow[2]) * t;
      return [r * (0.9 + 0.1 * shade), g * (0.9 + 0.1 * shade), b * (0.9 + 0.1 * shade)];
    }
    const q = ramp(d.biome, d.dry ? h : e), s = M.clamp(shade, 0.55, 1.5);
    return [q[1] * s, q[2] * s, q[3] * s];
  }
  function shadeAt(d, i, k) {
    const n = d.n, h = d.h, a = h[k * n + Math.max(0, i - 1)], b = h[k * n + Math.min(n - 1, i + 1)], u = h[Math.max(0, k - 1) * n + i], v = h[Math.min(n - 1, k + 1) * n + i];
    return 1 + 0.16 * ((a - b) + (u - v));                      // light from the upper left
  }
  const rgb = c => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
  const clamp8 = v => Math.max(0, Math.min(255, v | 0));

  /* ---- data ---- */
  PV.compute = function (settings, n) {
    const d = SS.worldgen.preview(settings, n || 96);
    d.seed = settings.seed | 0; d.time = settings.time;
    return d;
  };

  /* ---- content markers: [key, base count source, colour, shape] ---- */
  function bases(biome) {
    const T = C.TREES.COUNT[biome] || 0, P = C.PROPS.COUNT[biome] || [0, 0, 0, 0, 0], X = C.PROPS.EXTRA[biome] || {};
    let stone = 0, junk = 0; for (const k in X) { if (C.PROPS.STONE[k]) stone += X[k]; else junk += X[k]; }
    return { dTrees: T, dRocks: P[3] + stone, dBarrels: P[1], dProps: P[4] + junk, dCrates: P[0], dMines: P[2], dBunkers: C.BUNKER.N, dTown: biome === 'volcanic' ? 6 : 0, dEggs: biome === 'volcanic' ? 4 : 0 };
  }
  PV.BASES = bases;
  const MARKS = [['dTrees', '#2f7d32', 'dot', 2.2], ['dRocks', '#bdb7a8', 'dot', 2.4], ['dBarrels', '#c0392b', 'dot', 1.8], ['dProps', '#9aa7b3', 'sq', 2.2], ['dCrates', '#f1c40f', 'sq', 2.4],
    ['dMines', '#ff4d4d', 'dot', 1.5], ['dBunkers', '#6e7378', 'sq', 3.4], ['dTown', '#d9c7a0', 'sq', 3], ['dEggs', '#a6ff3a', 'dot', 2.4]];
  PV.MARKS = MARKS;
  function hash(a, b, c) { let h = (a * 374761393 + b * 668265263 + c * 2246822519) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  PV.markers = function (d, settings) {
    const out = [], B = bases(d.biome), n = d.n, sx = d.sx || 96, sc = sx / 96, mc = sx / 2;   // (P38: the preview has the map's size)
    if (d.under) return out;
    for (let m = 0; m < MARKS.length; m++) {
      const key = MARKS[m][0], cnt = C.density_count(settings, key, B[key]);
      const town = key === 'dTown';
      let cx = mc, cz = mc;
      if (town) { for (let t = 0; t < 60; t++) { const x = mc - 28 * sc + hash(d.seed, 99, t) * 56 * sc, z = mc - 28 * sc + hash(d.seed, 98, t) * 56 * sc, i = Math.round(x / sx * (n - 1)), k = Math.round(z / sx * (n - 1)); if (d.h[k * n + i] > d.sea + 1.2 && !d.lava[k * n + i]) { cx = x; cz = z; break; } } }
      let placed = 0;
      for (let t = 0; t < 400 && placed < cnt * (town ? 3 : 1); t++) {
        let x = 6 + hash(d.seed, m, t * 2) * (sx - 12), z = 6 + hash(d.seed, m, t * 2 + 1) * (sx - 12);
        if (town) { x = cx + (hash(d.seed, 7, t * 2) - 0.5) * 16; z = cz + (hash(d.seed, 7, t * 2 + 1) - 0.5) * 16; }
        if (M.len2(x - mc, z - mc) > 42 * sc) continue;
        const i = Math.round(x / sx * (n - 1)), k = Math.round(z / sx * (n - 1)), c = k * n + i;
        if (d.h[c] < d.sea + 1.0 || d.lava[c]) continue;
        out.push({ x, z, m }); placed++;
      }
    }
    return out;
  };

  /* ---- caverns (underground maps): the preview paints the cave PLAN of the generator (chambers, tunnels, niches; d.caves) ----
   * side / hero: a cross-section at the z with the most open space (rock strata + wobble, the caves dark with a warm glow, ice /
   * lava tints per biome); top: a plan view, the three levels in three tints (deeper = darker), sorted deep first. */
  const CAVE_PAL = {                                                      // rock (a, b: banding), cave floor glow, tint
    temperate: { a: [92, 82, 70], b: [112, 98, 80], glow: [255, 214, 150], lvl: ['#5b4f66', '#8a7a8c', '#d8c8a0'] },
    alpine: { a: [88, 96, 110], b: [128, 142, 158], glow: [190, 230, 255], lvl: ['#3c5068', '#6f8ca8', '#c8e4f4'] },
    canyon: { a: [140, 84, 56], b: [176, 108, 66], glow: [255, 190, 120], lvl: ['#6a3a2a', '#a8623c', '#f0b070'] },
    desert: { a: [172, 130, 84], b: [204, 160, 100], glow: [255, 226, 160], lvl: ['#7a5a38', '#b88c58', '#f4dca0'] },
    volcanic: { a: [52, 46, 48], b: [72, 62, 62], glow: [255, 120, 40], lvl: ['#2a2224', '#6a3a28', '#ff8a3a'] }
  };
  const cavePal = d => CAVE_PAL[d.biome] || CAVE_PAL.temperate;
  const segDist3 = (px, py, pz, a) => {
    const abx = a[3] - a[0], aby = a[4] - a[1], abz = a[5] - a[2], l2 = abx * abx + aby * aby + abz * abz || 1,
      t = M.clamp(((px - a[0]) * abx + (py - a[1]) * aby + (pz - a[2]) * abz) / l2, 0, 1);
    return M.len3(px - a[0] - abx * t, py - a[1] - aby * t, pz - a[2] - abz * t);
  };
  /* signed distance (m, approx.) to the nearest open space of the cave plan at (x, y, z): < 0 inside a chamber / tunnel / niche */
  PV.caveSdf = function (cv, x, y, z) {
    let m = 1e9;
    for (const c of cv.ch) { const dy = y - c.y, ry = dy < 0 ? c.ry * 0.62 : c.ry, e = M.len3((x - c.x) / c.rx, dy / ry, (z - c.z) / c.rz); m = Math.min(m, (e - 1) * Math.min(c.rx, ry, c.rz)); }
    for (const t of cv.tu) m = Math.min(m, segDist3(x, y, z, t) - t[6]);
    for (const q of cv.ni) m = Math.min(m, M.len3(x - q.x, y - q.y, z - q.z) - q.r);
    return m;
  };
  /* side projection (x right, y up; every feature seen from the side, the near z not told apart): rock strata with noise, the
   * chambers / tunnels / niches painted as dark hollows with a warm glow at their floors, overlapping ones darker */
  function drawCaveSide(ctx, cv, d, x0, y0, w, h, seed) {
    const P = cavePal(d), sw = Math.max(8, w >> 2), sh = Math.max(8, h >> 2), small = document.createElement('canvas'); small.width = sw; small.height = sh;
    const sg = small.getContext('2d'), im = sg.createImageData(sw, sh), px = im.data;
    for (let yy = 0; yy < sh; yy++) for (let xx = 0; xx < sw; xx++) {
      const x = xx / sw * cv.SX, y = (1 - yy / sh) * cv.SY, o = (yy * sw + xx) * 4;
      const t = M.clamp(0.5 + 0.5 * M.sin(y * 1.7 + 2.6 * M.noise2(x / 7, y / 3, seed)), 0, 1) * 0.65 + 0.35 * M.noise2(x / 1.6, y / 1.6, seed + 3), dep = 0.55 + 0.45 * (y / cv.SY);
      for (let c = 0; c < 3; c++) px[o + c] = clamp8((P.a[c] + (P.b[c] - P.a[c]) * t) * dep);
      px[o + 3] = 255;
    }
    sg.putImageData(im, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.drawImage(small, x0, y0, w, h);
    const kx = w / cv.SX, ky = h / cv.SY, X = v => x0 + v * kx, Y = v => y0 + h - v * ky, glow = P.glow;
    const dark = 'rgba(9,7,9,0.62)', rim = 'rgba(' + glow[0] + ',' + glow[1] + ',' + glow[2] + ',0.22)';
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const t of cv.tu) { ctx.strokeStyle = rim; ctx.lineWidth = t[6] * 2 * ky + 2; ctx.beginPath(); ctx.moveTo(X(t[0]), Y(t[1])); ctx.lineTo(X(t[3]), Y(t[4])); ctx.stroke(); }
    for (const t of cv.tu) { ctx.strokeStyle = dark; ctx.lineWidth = t[6] * 2 * ky; ctx.beginPath(); ctx.moveTo(X(t[0]), Y(t[1])); ctx.lineTo(X(t[3]), Y(t[4])); ctx.stroke(); }
    for (const q of cv.ni) { ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(X(q.x), Y(q.y), q.r * kx, q.r * ky, 0, 0, 6.2832); ctx.fill(); }
    for (const c of cv.ch) {
      const cx = X(c.x), cy = Y(c.y), rx = c.rx * kx, ry = c.ry * ky;
      ctx.fillStyle = rim; ctx.beginPath(); ctx.ellipse(cx, cy, rx + 2, ry + 2, 0, 0, 6.2832); ctx.fill();
      const g = ctx.createRadialGradient(cx, cy + ry * 0.6, 0, cx, cy + ry * 0.2, rx);       // the floor glows, the roof is dark
      g.addColorStop(0, 'rgba(' + glow[0] + ',' + glow[1] + ',' + glow[2] + ',0.5)'); g.addColorStop(0.5, 'rgba(24,18,16,0.8)'); g.addColorStop(1, 'rgba(9,7,9,0.88)');
      ctx.save(); ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 6.2832); ctx.clip(); ctx.fillStyle = g; ctx.fillRect(cx - rx, cy - ry, 2 * rx, 2 * ry); ctx.restore();
    }
    ctx.restore();
  }
  function drawCavePlan(cv2, cv, d) {
    const ctx = cv2.getContext('2d'), w = cv2.width, h = cv2.height, P = cavePal(d), kx = w / cv.SX, kz = h / cv.SZ;
    const im = ctx.createImageData(w, h), px = im.data;
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {         // rock: noise grain, a vignette
      const o = (yy * w + xx) * 4, n = 0.8 + 0.4 * M.noise2(xx / 5, yy / 5, d.seed + 9), v = 0.8 + 0.2 * M.noise2(xx / 2, yy / 2, d.seed + 11);
      px[o] = clamp8(P.a[0] * 0.55 * n * v); px[o + 1] = clamp8(P.a[1] * 0.55 * n * v); px[o + 2] = clamp8(P.a[2] * 0.55 * n * v); px[o + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    const lvl = y => (y < 12 ? 0 : y < 22 ? 1 : 2), sy = cv.SY;
    const items = [];
    for (const c of cv.ch) items.push({ y: c.y, k: 'c', c });
    for (const t of cv.tu) items.push({ y: (t[1] + t[4]) / 2, k: 't', t });
    for (const q of cv.ni) items.push({ y: q.y, k: 'n', q });
    items.sort((a, b) => a.y - b.y);                                      // deep first: the upper levels paint over the lower ones
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const it of items) {
      const col = P.lvl[lvl(it.y)];
      ctx.fillStyle = col; ctx.strokeStyle = col;
      if (it.k === 'c') { ctx.beginPath(); ctx.ellipse(it.c.x * kx, it.c.z * kz, it.c.rx * kx, it.c.rz * kz, 0, 0, 6.2832); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 1; ctx.stroke(); }
      else if (it.k === 't') { ctx.lineWidth = it.t[6] * 2 * kx * 0.8; ctx.beginPath(); ctx.moveTo(it.t[0] * kx, it.t[2] * kz); ctx.lineTo(it.t[3] * kx, it.t[5] * kz); ctx.stroke(); }
      else { ctx.beginPath(); ctx.arc(it.q.x * kx, it.q.z * kz, it.q.r * kx, 0, 6.2832); ctx.fill(); }
    }
    // a legend of the levels
    ctx.font = '11px Barlow Semi Condensed, sans-serif'; ctx.textAlign = 'left';
    ['low', 'mid', 'high'].forEach((n, i) => { ctx.fillStyle = P.lvl[i]; ctx.fillRect(6, h - 36 + i * 11, 8, 8); ctx.fillStyle = 'rgba(255,255,255,.8)'; ctx.fillText(n, 18, h - 29 + i * 11); });
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.textAlign = 'right'; ctx.font = '13px Bungee, sans-serif'; ctx.fillText('CAVE SYSTEM', w - 8, 17);
  }

  /* ---- top view ---- */
  PV.drawTop = function (cv, d, settings) {
    if (d.biome === 'eow' && SS.eowPreview) return SS.eowPreview.top(cv, d);                  // P68d
    if (d.under && d.caves) { drawCavePlan(cv, d.caves, d); return; }                       // P38-A4: the cave plan
    const ctx = cv.getContext('2d'), n = d.n, S = cv.width / n, sx = d.sx || 96, pr = sx / 2 - 3.5;
    const im = ctx.createImageData(cv.width, cv.height), px = im.data;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      const i = Math.min(n - 1, (x / S) | 0), k = Math.min(n - 1, (y / S) | 0), o = (y * cv.width + x) * 4;
      if (d.under) { const v = 40 + 30 * hash(i, k, d.seed); px[o] = v; px[o + 1] = v * 0.9; px[o + 2] = v * 0.8; px[o + 3] = 255; continue; }
      const col = colour(d, i, k, shadeAt(d, i, k));
      const rr = M.len2((x + 0.5) / cv.width * sx - sx / 2, (y + 0.5) / cv.height * sx - sx / 2), vig = rr > pr ? 0.45 : 1;   // outside the play circle
      px[o] = clamp8(col[0] * vig); px[o + 1] = clamp8(col[1] * vig); px[o + 2] = clamp8(col[2] * vig); px[o + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    if (d.under) return;
    const mk = PV.markers(d, settings), k2 = cv.width / sx;
    for (const q of mk) {
      const m = MARKS[q.m]; ctx.fillStyle = m[1]; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1;
      const x = q.x * k2, y = q.z * k2, r = m[3] * k2 / 1.6;
      ctx.beginPath(); if (m[2] === 'dot') ctx.arc(x, y, r, 0, 6.2832); else ctx.rect(x - r, y - r, 2 * r, 2 * r);
      ctx.fill(); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.arc(cv.width / 2, cv.height / 2, pr * k2, 0, 6.2832); ctx.stroke(); ctx.setLineDash([]);
  };

  function skyFill(ctx, w, h, time, biome) {
    const t = SKY[time] || SKY.day, g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, biome === 'volcanic' && time !== 'night' ? '#4a3a40' : t[0]); g.addColorStop(1, biome === 'volcanic' && time !== 'night' ? '#b86a4a' : t[1]);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  }
  const timeOf = d => (d.time === 'day' || d.time === 'dusk' || d.time === 'night') ? d.time : ['day', 'day', 'dusk', 'night'][(Math.imul(d.seed | 0, 2246822519) >>> 9) % 4];

  /* ---- side view: cross-section through z = 48 + the far silhouette ---- */
  PV.drawSide = function (cv, d) {
    if (d.biome === 'eow' && SS.eowPreview) return SS.eowPreview.side(cv, d);                 // P68d
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, n = d.n;
    skyFill(ctx, w, h, timeOf(d), d.biome);
    const y0 = -3, y1 = 38, Y = v => h - 3 - (M.clamp(v, y0, y1) - y0) / (y1 - y0) * (h - 6);
    if (d.under && d.caves) { drawCaveSide(ctx, d.caves, d, 0, 0, w, h, d.seed); return; }       // P38-A4: a real cross-section
    if (d.under) {
      ctx.fillStyle = '#2a2320'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#0c0a09'; for (let i = 0; i < 24; i++) { const x = hash(d.seed, 5, i) * w, y = hash(d.seed, 6, i) * h; ctx.beginPath(); ctx.ellipse(x, y, 10 + 26 * hash(d.seed, 7, i), 5 + 9 * hash(d.seed, 8, i), 0, 0, 6.28); ctx.fill(); }
      return;
    }
    const mid = Math.round(n / 2), far = new Float32Array(n);
    for (let i = 0; i < n; i++) { let mx = -99; for (let k = 0; k < n; k++) mx = Math.max(mx, d.h[k * n + i]); far[i] = mx; }
    ctx.fillStyle = 'rgba(40,50,60,.35)'; ctx.beginPath(); ctx.moveTo(0, h);
    for (let i = 0; i < n; i++) ctx.lineTo(i / (n - 1) * w, Y(far[i])); ctx.lineTo(w, h); ctx.fill();
    if (!d.dry) { ctx.fillStyle = 'rgba(40,120,170,.85)'; ctx.fillRect(0, Y(d.sea), w, h - Y(d.sea)); }
    for (let i = 0; i < n - 1; i++) {                                    // columns of the section, strata by depth
      const x = i / (n - 1) * w, cw = w / (n - 1) + 1, top = d.h[mid * n + i], c = mid * n + i;
      if (top <= (d.dry ? -9 : d.sea)) continue;
      const yt = Y(top), q = ramp(d.biome, d.dry ? top : top - d.sea);
      ctx.fillStyle = d.lava[c] ? '#ff7a18' : rgb(q.slice(1)); ctx.fillRect(x, yt, cw, 3);
      const g = ctx.createLinearGradient(0, yt, 0, h); g.addColorStop(0, rgb([q[1] * 0.72, q[2] * 0.68, q[3] * 0.66])); g.addColorStop(1, '#2b2724');
      ctx.fillStyle = g; ctx.fillRect(x, yt + 3, cw, h - yt - 3);
    }
  };

  /* ---- hero: oblique painter view ---- */
  PV.drawHero = function (cv, d) {
    if (d.biome === 'eow' && SS.eowPreview) return SS.eowPreview.hero(cv, d);                 // P68d
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, n = d.n;
    skyFill(ctx, w, h, timeOf(d), d.biome);
    if (d.under && d.caves) {                                                                 // P38-A4: a cutaway block: the section, a thin rock roof, a lit frame
      const cvv = d.caves, bx = w * 0.04, bw = w * 0.92, by = h * 0.16, bh = h * 0.74;
      ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#0b0a0c'; ctx.fillRect(0, 0, w, h);
      drawCaveSide(ctx, cvv, d, Math.round(bx), Math.round(by), Math.round(bw), Math.round(bh), d.seed);
      const P = cavePal(d), rg = ctx.createLinearGradient(0, by - h * 0.09, 0, by); rg.addColorStop(0, rgb(P.a.map(v => v * 0.35))); rg.addColorStop(1, rgb(P.b.map(v => v * 0.7)));
      ctx.fillStyle = rg; ctx.beginPath(); ctx.moveTo(bx + bw * 0.03, by - h * 0.09); ctx.lineTo(bx + bw - bw * 0.03, by - h * 0.09); ctx.lineTo(bx + bw, by); ctx.lineTo(bx, by); ctx.fill();   // the roof's thickness in perspective
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5; ctx.strokeRect(bx, by, bw, bh);
      const vg = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.25, w / 2, h * 0.55, h * 0.8); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
      return;
    }
    if (d.under) { PV.drawTop(cv, d, {}); return; }
    const vs = 3.6, rows = 0.60 * h, baseFar = 0.33 * h;
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1), sc = 0.62 + 0.38 * t, by = baseFar + t * rows, rowH = rows / n * 1.6 + 1, cw = w * 0.98 * sc / (n - 1) + 1;
      for (let i = 0; i < n; i++) {
        const c = k * n + i, hh = d.h[c], e = Math.max(hh, d.dry ? -99 : d.sea) - d.sea;
        const x = w / 2 + (i / (n - 1) - 0.5) * w * 0.98 * sc, y = by - (d.dry ? hh : e) * vs * sc;
        const rr = M.len2(i / (n - 1) * (d.sx || 96) - (d.sx || 96) / 2, k / (n - 1) * (d.sx || 96) - (d.sx || 96) / 2);
        let col = colour(d, i, k, shadeAt(d, i, k));
        if (rr > (d.sx || 96) / 2 - 3.5) col = [col[0] * 0.45, col[1] * 0.45, col[2] * 0.5];
        ctx.fillStyle = rgb(col); ctx.fillRect(x - cw / 2, y, cw, Math.max(1, by - y) + rowH);
      }
    }
    const g = ctx.createLinearGradient(0, h * 0.82, 0, h); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.35)'); ctx.fillStyle = g; ctx.fillRect(0, h * 0.82, w, h * 0.18);
  };
})(window.SS = window.SS || {});
