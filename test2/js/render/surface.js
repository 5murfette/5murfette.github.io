/* render/surface.js — the lattice-sized maps of the view module (the third file of SS.view, render/view.js): the
 * surface texture the terrain, the grass and the clutter read (the sim's vegetation state S.veg.surf: cover, dryness,
 * char, burning) with the render-only blast soot OR-ed into its char channel; the soot / fresh-ground map; the height
 * map (the HUD's 1 m plan, and the texture the particles and the weather sample). One texel per lattice column; the
 * texture objects stay when the map size changes (other modules hold them in uniforms).
 * C: three render textures of the terrain system. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const V = SS.view, view = V.state;
  let NS = 193, heightTex = null, surfTex = null, scyTex = null;
  const map = (filter) => {
    const t = new T.DataTexture(new Uint8Array(NS * NS * 4), NS, NS, T.RGBAFormat);
    t.magFilter = t.minFilter = filter;
    t.needsUpdate = true;
    return t;
  };
  // the three textures (once, at the view's init): heights and surface filtered, the soot's heights nearest
  V.surfaceTextures = function () {
    heightTex = map(T.LinearFilter);
    surfTex = map(T.LinearFilter);
    scyTex = map(T.NearestFilter);
    return { heightTex, surfTex, scyTex };
  };
  // a map of another size: the same texture objects with new lattice-sized images
  V.surfaceResize = function (n) {
    if (NS === n) return;
    NS = n;
    for (const t of [heightTex, surfTex, scyTex]) {
      t.dispose();
      t.image = { data: new Uint8Array(NS * NS * 4), width: NS, height: NS };
      t.needsUpdate = true;
    }
  };
  /* blast scorch on any ground (the sim's char channel only knows grass cells): a render-only soot map, OR-ed into the
   * char (b) channel of the uploaded surface texture; scorchY: the height and half depth of the soot per column (a
   * wall does not wear a stripe down its whole column); freshMap: freshly dug ground, darker and damper than the
   * weathered surface (scyTex.b) */
  let scorchMap = null, scorchDirty = false, scorchY = null, freshMap = null;
  V.scorch = function (x, z, r, a, y, fresh) {
    const n = NS, H = SS.world.H;
    if (!scorchMap || scorchMap.length !== n * n) {
      scorchMap = new Uint8Array(n * n);
      scorchY = new Uint8Array(n * n * 2);
      freshMap = new Uint8Array(n * n);
    }
    const yq = y == null ? 0 : Math.max(1, Math.min(255, Math.round(y * 4))),
      hq = Math.max(1, Math.min(255, Math.round((0.9 + 0.75 * r) * 8)));
    const ci = x / H,
      ck = z / H,
      rc = r / H,
      i0 = Math.max(0, Math.floor(ci - rc)),
      i1 = Math.min(n - 1, Math.ceil(ci + rc)),
      k0 = Math.max(0, Math.floor(ck - rc)),
      k1 = Math.min(n - 1, Math.ceil(ck + rc));
    for (let k = k0; k <= k1; k++)
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(i - ci, k - ck) / rc;
        if (d >= 1) continue;
        const rag = 0.82 + 0.18 * Math.sin(i * 12.9898 + k * 78.233) * Math.sin(k * 4.1 + i * 2.3), an = Math.atan2(k - ck, i - ci);
        // blast rays and a burnt rim around the crater edge
        const ray = 0.62 + 0.38 * Math.sin(an * 7.0 + x * 3.7) * Math.sin(an * 3.0 - z * 2.9 + 1.0) + 0.12 * Math.sin(an * 17.0 + x),
          rim = 1 + 0.5 * Math.exp(-Math.pow((d - 0.62) / 0.16, 2));
        const f = Math.min(1, Math.min(1, (1 - d) * 1.8 * Math.max(0.35, ray)) * rim) * a * rag;
        if (fresh > 0) {
          freshLive = true;
          const fv = Math.round(255 * Math.min(1, fresh * Math.pow(1 - d, 0.55) * (0.85 + 0.15 * rag)));
          if (fv > freshMap[k * n + i]) {
            freshMap[k * n + i] = fv;
            scorchY[(k * n + i) * 2] = y == null ? 0 : yq;
            scorchY[(k * n + i) * 2 + 1] = y == null ? 0 : hq;
          }
        }
        const v = Math.round(255 * f);
        if (v > scorchMap[k * n + i]) {
          scorchMap[k * n + i] = v;
          scorchY[(k * n + i) * 2] = y == null ? 0 : yq;
          scorchY[(k * n + i) * 2 + 1] = y == null ? 0 : hq;
        }
      }
    scorchDirty = true;
  };
  /* freshly dug ground dries back to the normal soil colour over ~40 s (the fresh channel loses 3 / 255 every 0.5 s;
   * the soot stays) */
  let freshAcc = 0, freshLive = false;
  V.dryFresh = function (dt) {
    if (!freshMap || !freshLive) return;
    freshAcc += dt;
    if (freshAcc < 0.5) return;
    freshAcc = 0;
    let any = false;
    for (let q = 0; q < freshMap.length; q++) {
      const v = freshMap[q];
      if (v) {
        freshMap[q] = v > 3 ? v - 3 : 0;
        any = true;
      }
    }
    freshLive = any; scorchDirty = true;
  };
  function applyScorch() {
    // (also with no scorch map: a new world must clear the previous one's soot / fresh-ground texels on the GPU)
    const e = scyTex.image.data;
    e.fill(0);
    scyTex.needsUpdate = true;
    if (!scorchMap) return;
    const d = surfTex.image.data;
    for (let q = 0; q < scorchMap.length; q++) {
      const v = scorchMap[q], fv = freshMap[q];
      if (fv) {
        e[q * 4 + 2] = fv;
        e[q * 4] = scorchY[q * 2];
        e[q * 4 + 1] = scorchY[q * 2 + 1];
      }
      if (v && v > d[q * 4 + 2]) {
        d[q * 4 + 2] = v;
        e[q * 4] = scorchY[q * 2];
        e[q * 4 + 1] = scorchY[q * 2 + 1];
      }
    }
    scyTex.needsUpdate = true;
  }
  // the surface texture from the sim's vegetation map (S.veg.surf), with the soot and fresh ground over it
  V.uploadSurface = function (S) {
    const s = { buf: S.veg.surf, n: S.veg.n };
    // (a 2D slab: a render-only copy with the cover varied behind the plane)
    s.buf = SS.slab2d.shapeSurf(s.buf, s.n, S);
    view.surf = s.buf;
    view.surfN = s.n;
    view.surfVer = S.veg ? S.veg.surfVer : 0;
    view.surfUploads = (view.surfUploads | 0) + 1;
    surfTex.image.data.set(s.buf.subarray(0, NS * NS * 4));
    applyScorch();
    surfTex.needsUpdate = true;
    scorchDirty = false;
    SS.grass.setSurface(s.buf, s.n);
  };
  V.buildHeights = function () {
    // (1 px = 1 m: the HUD minimap; the version drives the minimap / cave x-ray / dunes rebuilds)
    view.heightmap = SS.meshgen.heightmap(SS.world.SX + 1); view.heightVer++;
    const h = SS.meshgen.heightmap(NS), d = heightTex.image.data;
    for (let i = 0; i < h.length; i++) {
      const v = Math.round(M.clamp(h[i] / 40, 0, 1) * 255);
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }
    heightTex.needsUpdate = true;
    view.heightFor = SS.world.version;
  };
  // a new world: no soot or fresh ground from the last one
  V.surfaceClear = function () {
    scorchMap = null;
    scorchY = null;
    freshMap = null;
    scorchDirty = false;
  };
  // each frame: the heights follow the world's edits (at most every 0.4 s), the fresh ground dries, the surface
  // texture follows the vegetation and the soot
  V.surfaceFrame = function (S, dtU) {
    if (SS.world.version !== view.heightFor && view.time - view.heightT > 0.4) {
      V.buildHeights();
      view.heightT = view.time;
    }
    V.dryFresh(dtU);
    if (S.veg.surfVer !== view.surfVer || scorchDirty) V.uploadSurface(S);
  };
})(window.SS = window.SS || {});
