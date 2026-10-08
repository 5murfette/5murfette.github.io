/* render/textures.js — texture preparation (presentation layer).
 * gpt-image photo textures are made seamless at load time by procedural stitching (half-offset copy
 * cross-faded in with a noise-perturbed mask + low-frequency luminance flattening), foliage cards are
 * chroma-keyed (magenta → alpha), procedural textures (noise, sprites) are synthesised.
 * Terrain materials are packed into one 2D texture array (layer = material slot).
 * Fire/flames/fireballs are NOT textures: they are generated in shaders (render/fx.js).
 * Porting: run once offline and ship the resulting images / a texture array asset. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const X = SS.tex = {};

  /* layer order of the terrain array: slots 0..11 = material ids 1..12, then cover/cut layers */
  X.LAYERS = ['rock', 'rock', 'soil', 'sand', 'sandstone', 'snow', 'ice', 'basalt', 'lava', 'basalt', 'ash', 'scree', 'grass', 'drygrass', 'strata'];
  X.L_GRASS = 12; X.L_DRY = 13; X.L_STRATA = 14;

  function loadImage(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
  }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  const tick = () => new Promise(r => setTimeout(r, 0));

  /* tileable value noise in [0,1], period p */
  function tnoise(x, y, p, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), u = M.smooth(x - xi), v = M.smooth(y - yi);
    const h = (i, j) => M.hash3(((i % p) + p) % p, ((j % p) + p) % p, seed);
    return M.lerp(M.lerp(h(xi, yi), h(xi + 1, yi), u), M.lerp(h(xi, yi + 1), h(xi + 1, yi + 1), u), v);
  }

  /* Procedural stitching: out = mix(img, img shifted by half, mask) where mask→1 at the borders. */
  X.makeSeamless = function (img, size) {
    const c = canvas(size, size), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, size, size);
    const src = g.getImageData(0, 0, size, size), out = g.createImageData(size, size), a = src.data, o = out.data, h = size >> 1;
    const B = 8, cell = size / B, mean = new Float32Array(B * B);
    let tot = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4, l = a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11;
      mean[((y / cell) | 0) * B + ((x / cell) | 0)] += l; tot += l;
    }
    tot /= size * size;
    for (let i = 0; i < mean.length; i++) mean[i] /= cell * cell;
    const gainT = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / cell - 0.5, fy = y / cell - 0.5, x0 = M.clamp(Math.floor(fx), 0, B - 1), y0 = M.clamp(Math.floor(fy), 0, B - 1);
      const x1 = Math.min(B - 1, x0 + 1), y1 = Math.min(B - 1, y0 + 1), u = M.clamp(fx - x0, 0, 1), v = M.clamp(fy - y0, 0, 1);
      const m = M.lerp(M.lerp(mean[y0 * B + x0], mean[y0 * B + x1], u), M.lerp(mean[y1 * B + x0], mean[y1 * B + x1], u), v);
      gainT[y * size + x] = M.lerp(1, tot / Math.max(8, m), 0.6);
    }
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const ex = Math.abs(x / size - 0.5) * 2, ey = Math.abs(y / size - 0.5) * 2;
      const n = tnoise(x / size * 8, y / size * 8, 8, 3) * 0.6 + tnoise(x / size * 24, y / size * 24, 24, 4) * 0.4;
      const m = Math.max(ex, ey) + (n - 0.5) * 0.35;
      const w = Math.max(M.clamp((m - 0.62) / 0.3, 0, 1), M.clamp((Math.max(ex, ey) - 0.95) / 0.04, 0, 1)), ws = w * w * (3 - 2 * w);
      const i = (y * size + x) * 4, sx = (x + h) % size, sy = (y + h) % size, j = (sy * size + sx) * 4;
      const g0 = gainT[y * size + x], g1 = gainT[sy * size + sx];
      for (let ch = 0; ch < 3; ch++) o[i + ch] = M.clamp(a[i + ch] * g0 * (1 - ws) + a[j + ch] * g1 * ws, 0, 255);
      o[i + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    return c;
  };
  /* Seamless horizontally only (strata bands must keep their vertical order). */
  X.makeSeamlessX = function (img, size) {
    const c = canvas(size, size), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, size, size);
    const src = g.getImageData(0, 0, size, size), out = g.createImageData(size, size), a = src.data, o = out.data, h = size >> 1;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const n = tnoise(x / size * 6, y / size * 14, 6, 9);
      const m = Math.abs(x / size - 0.5) * 2 + (n - 0.5) * 0.3;
      const w = Math.max(M.clamp((m - 0.6) / 0.3, 0, 1), M.clamp((Math.abs(x / size - 0.5) * 2 - 0.95) / 0.04, 0, 1)), ws = w * w * (3 - 2 * w);
      const i = (y * size + x) * 4, j = (y * size + (x + h) % size) * 4;
      for (let ch = 0; ch < 3; ch++) o[i + ch] = a[i + ch] * (1 - ws) + a[j + ch] * ws;
      o[i + 3] = 255;
    }
    g.putImageData(out, 0, 0);
    return c;
  };
  /* Chroma key: magenta background → alpha, with de-spill on the soft edge. */
  X.keyMagenta = function (img, size) {
    const c = canvas(size, size), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, size, size);
    const im = g.getImageData(0, 0, size, size), d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const mag = Math.min(r, b) - gg;                       // magenta-ness
      const a = 1 - M.smoothstep(40, 120, mag);
      if (a < 1) { d[i] = Math.min(r, gg * 1.05 + 8); d[i + 2] = Math.min(b, gg * 0.9 + 6); }
      d[i + 3] = Math.round(a * 255);
    }
    g.putImageData(im, 0, 0);
    return c;
  };
  /* Black background → alpha (smoke sprite): alpha from luminance, colour normalised to white-ish grey. */
  X.keyBlack = function (img, size) {
    const c = canvas(size, size), g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, size, size);
    const im = g.getImageData(0, 0, size, size), d = im.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4, l = Math.max(d[i], d[i + 1], d[i + 2]);
      const r = Math.hypot(x / size - 0.5, y / size - 0.5) * 2, edge = 1 - M.smoothstep(0.82, 0.98, r);
      const a = M.clamp((l - 6) / 170, 0, 1) * edge;
      const k = l > 0 ? 255 / l : 0;
      d[i] = Math.min(255, d[i] * k * 0.92); d[i + 1] = Math.min(255, d[i + 1] * k * 0.92); d[i + 2] = Math.min(255, d[i + 2] * k * 0.92); d[i + 3] = a * 255;
    }
    g.putImageData(im, 0, 0);
    return c;
  };

  /* RGBA tileable noise: R,G,B = different octaves/seeds, A = fbm. */
  X.noiseCanvas = function (size) {
    const c = canvas(size, size), g = c.getContext('2d'), im = g.createImageData(size, size), d = im.data;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = (y * size + x) * 4;
      const n1 = tnoise(u * 4, v * 4, 4, 1), n2 = tnoise(u * 16, v * 16, 16, 2), n3 = tnoise(u * 32, v * 32, 32, 5);
      d[i] = n1 * 255; d[i + 1] = n2 * 255; d[i + 2] = n3 * 255; d[i + 3] = (n1 * 0.55 + n2 * 0.3 + n3 * 0.15) * 255;
    }
    g.putImageData(im, 0, 0);
    return c;
  };
  /* C1: tileable 3D value noise, RGBA8 n³ (R 4, G 16, B 32 lattice cells per tile, A = their fbm: the same channel
   * layout as noiseCanvas). The cut face samples it at the face pixel's WORLD position: a real 3D field, so as the
   * section turns about the worm the pattern stays put under the worm and changes with the arc |s|·Δθ further out
   * (never slides). Lattice values hashed once per channel, smoothstep-trilinear per texel (~30 ms for n = 64). */
  X.noise3D = function (n) {
    const data = new Uint8Array(n * n * n * 4), P = [4, 16, 32], seeds = [11, 12, 15];
    const lat = P.map((p, c) => { const a = new Float32Array(p * p * p); for (let i = 0; i < a.length; i++) a[i] = M.hash3(i % p, ((i / p) | 0) % p, ((i / (p * p)) | 0) + 977 * seeds[c], seeds[c]); return a; });
    const ch = new Float32Array(3);
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      for (let c = 0; c < 3; c++) {
        const p = P[c], L = lat[c], fx = x / n * p, fy = y / n * p, fz = z / n * p;
        const xi = Math.floor(fx), yi = Math.floor(fy), zi = Math.floor(fz), u = M.smooth(fx - xi), v = M.smooth(fy - yi), w = M.smooth(fz - zi);
        const x1 = (xi + 1) % p, y1 = (yi + 1) % p, z1 = (zi + 1) % p, g = (i, j, k) => L[(k * p + j) * p + i];
        const a0 = M.lerp(M.lerp(g(xi, yi, zi), g(x1, yi, zi), u), M.lerp(g(xi, y1, zi), g(x1, y1, zi), u), v);
        const a1 = M.lerp(M.lerp(g(xi, yi, z1), g(x1, yi, z1), u), M.lerp(g(xi, y1, z1), g(x1, y1, z1), u), v);
        ch[c] = M.lerp(a0, a1, w);
      }
      const o = ((z * n + y) * n + x) * 4;
      data[o] = ch[0] * 255; data[o + 1] = ch[1] * 255; data[o + 2] = ch[2] * 255; data[o + 3] = (ch[0] * 0.55 + ch[1] * 0.3 + ch[2] * 0.15) * 255;
    }
    const t = new T.Data3DTexture(data, n, n, n);
    t.format = T.RGBAFormat; t.type = T.UnsignedByteType; t.minFilter = t.magFilter = T.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = T.RepeatWrapping; t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true;
    return t;
  };
  // ASSET: vfx glow / ring / streak sprites (vfx/*.png)
  X.glowCanvas = function () {
    const c = canvas(128, 128), g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.8)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return c;
  };
  X.ringCanvas = function () {
    const c = canvas(128, 128), g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 30, 64, 64, 62);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return c;
  };
  /* raindrop streak / snowflake sprites */
  X.streakCanvas = function () {
    const c = canvas(16, 128), g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.75)'); gr.addColorStop(1, 'rgba(255,255,255,0.95)');
    g.fillStyle = gr; g.beginPath(); g.ellipse(8, 64, 2.2, 63, 0, 0, M.TAU); g.fill(); return c;
  };

  function tex(c, srgb, repeat, aniso) {
    const t = new T.CanvasTexture(c);
    if (srgb) t.colorSpace = T.SRGBColorSpace;
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; }
    t.anisotropy = aniso || 8;
    t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter;
    t.needsUpdate = true;
    return t;
  }
  function avgColor(img, v0, v1) {
    const c = canvas(64, 64), g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, 64, 64);
    const d = g.getImageData(0, Math.floor(v0 * 64), 64, Math.max(1, Math.floor((v1 - v0) * 64))).data;
    let r = 0, gg = 0, b = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; n++; }
    return [r / n / 255, gg / n / 255, b / n / 255];
  }
  /* average linear-ish colour of a canvas (for debris / minimap tints) */
  function canvasAvg(c) {
    const s = canvas(16, 16), g = s.getContext('2d', { willReadFrequently: true }); g.drawImage(c, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data; let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    return [r / 256 / 255, gg / 256 / 255, b / 256 / 255];
  }

  /* Load everything; onProgress(fraction, label). Resolves to a dictionary of THREE textures + derived data. */
  // ASSET: terrain / vegetation / sky textures (assets/src/*.png today; native: PBR sets, see docs/ASSET_PROMPTS.md)
  X.loadAll = async function (quality, onProgress) {
    const D = window.TEXTURE_DATA || {}, out = {}, imgs = {};
    const prog = onProgress || (() => {});
    await Promise.all(Object.keys(D).map(async k => { imgs[k] = await loadImage(D[k]); }));
    const size = quality === 'low' ? 256 : 512, aniso = quality === 'low' ? 2 : quality === 'medium' ? 4 : 8;
    // terrain texture array
    const uniq = {}, names = X.LAYERS;
    let done = 0;
    for (const n of names) {
      if (uniq[n]) continue;
      uniq[n] = n === 'strata' ? X.makeSeamlessX(imgs.strata, size) : X.makeSeamless(imgs[n], size);
      prog(++done / 16, 'Stitching textures');
      await tick();
    }
    const L = names.length, data = new Uint8Array(size * size * 4 * L);
    out.matAvg = [];
    for (let l = 0; l < L; l++) {
      const cv = uniq[names[l]], px = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, size, size).data;
      data.set(px, l * size * size * 4);
      out.matAvg.push(canvasAvg(cv));
    }
    const arr = new T.DataArrayTexture(data, size, size, L);
    arr.format = T.RGBAFormat; arr.type = T.UnsignedByteType; arr.colorSpace = T.SRGBColorSpace;
    arr.wrapS = arr.wrapT = T.RepeatWrapping; arr.minFilter = T.LinearMipmapLinearFilter; arr.magFilter = T.LinearFilter;
    arr.generateMipmaps = true; arr.anisotropy = aniso; arr.needsUpdate = true;
    out.mats = arr; out.matSize = size;
    // separate copies used by props / cut faces
    out.strata = tex(uniq.strata, true, true, aniso);
    out.rock = tex(uniq.rock, true, true, aniso);
    out.bark = tex(X.makeSeamless(imgs.bark, size), true, true, aniso); prog(0.8, 'Stitching textures'); await tick();
    for (const k of ['foliage', 'pine', 'palm']) { out[k] = tex(X.keyMagenta(imgs[k], 512), true, false, aniso); out[k].wrapS = out[k].wrapT = T.ClampToEdgeWrapping; }
    out.crate = tex((() => { const c = canvas(512, 512); c.getContext('2d').drawImage(imgs.crate, 0, 0, 512, 512); return c; })(), true, false, aniso);
    out.barrel = tex((() => { const c = canvas(512, 512); c.getContext('2d').drawImage(imgs.barrel, 0, 0, 512, 512); return c; })(), true, true, aniso);
    out.smoke = tex(X.keyBlack(imgs.smoke, 256), false, false, 1);
    out.skies = {};
    for (const k of ['sky', 'sky_cold', 'sky_storm']) {
      if (!imgs[k]) continue;                    // K2: retired (procedural sky); kept loadable for old asset files
      const c = canvas(imgs[k].width, imgs[k].height); c.getContext('2d').drawImage(imgs[k], 0, 0);
      const t = tex(c, true, false, 1); t.wrapS = T.RepeatWrapping;   // K1: the panoramas tile (tools/sky_tile.py), no mirror
      out.skies[k] = { tex: t, avg: avgColor(imgs[k], 0.70, 0.80), horizon: avgColor(imgs[k], 0.885, 0.915), top: avgColor(imgs[k], 0.0, 0.15) };
    }
    out.noise = tex(X.noiseCanvas(256), false, true, 1);
    out.noise3 = X.noise3D(64);
    // K2: six-way lit cloud puff atlases (Blender renders): a = lit from +X / -X / +Y, b = -Y / +Z / -Z, c = opacity
    if (imgs.clouds_a) {
      const ct = k => { const c = canvas(imgs[k].width, imgs[k].height); c.getContext('2d').drawImage(imgs[k], 0, 0); const t = tex(c, true, false, 4); t.wrapS = t.wrapT = T.ClampToEdgeWrapping; return t; };
      out.clouds = { a: ct('clouds_a'), b: ct('clouds_b'), c: ct('clouds_c') };
    }
    out.glow = tex(X.glowCanvas(), false, false, 1);
    out.ring = tex(X.ringCanvas(), false, false, 1);
    out.streak = tex(X.streakCanvas(), false, false, 1);
    prog(1, 'Textures ready');
    return out;
  };
})(window.SS = window.SS || {});
