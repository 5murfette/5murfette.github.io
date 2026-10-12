/* render/grass.js — grass blades as one InstancedMesh per terrain chunk (Three.js specific).
 * Blades are placed once per chunk mesh (stable world-anchored hashing, see SS.meshgen.grass) and the vertex
 * shader clips them to the section slab, so rotating the section never rebuilds anything.
 * Coverage / dryness / char / burning come from the simulation surface map (tSurf), wind from the weather. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const GR = SS.grass = {};
  let scene, mat, geo, Q, surf = null, surfN = 0;
  const per = new Map();
  const MAXC = 9000;

  // ASSET: grass_tuft_[1-4], flower_[1-6] (models/*.glb or cards)
  function bladeGeometry() {
    const bg = new T.BufferGeometry(), pos = [], idx = [], nrm = [], SEG = 4;
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG, w = 0.035 * (1 - t) + 0.002, bend = t * t * 0.18;
      pos.push(-w, t, bend, w, t, bend); nrm.push(0, 0.92, 0.38, 0, 0.92, 0.38);
      if (i < SEG) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
    }
    bg.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); bg.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3)); bg.setIndex(idx);
    return bg;
  }

  GR.init = function (sc, tx, quality) { scene = sc; Q = quality; mat = SS.mat.grass(tx); geo = bladeGeometry(); };
  GR.material = () => mat;
  /* surface map: Uint8Array n*n*4 over the world (r = grass cover) */
  GR.setSurface = function (buf, n) { surf = buf; surfN = n; };
  function grassAt(x, z) {
    if (!surf) return 0;
    if (SS.heroView && SS.heroView.blocked(x, z)) return 0;                  // P101: no grass inside a hero set piece
    const i = M.clamp(Math.round(x / SS.world.SX * (surfN - 1)), 0, surfN - 1), k = M.clamp(Math.round(z / SS.world.SZ * (surfN - 1)), 0, surfN - 1);
    return surf[(k * surfN + i) * 4] / 255;
  }

  GR.cover = grassAt;

  /* P102: heat proximity. Nothing green grows on or near lava, vents (fumaroles) or burning ground: a distance field (m) over the
   * lattice, built from S.lava (any column with lava) + the fumarole list + burning veg cells, cached by lava version. */
  const HOT_R = 4.0;                                                  // m: no grass / plants closer than this to heat (blades fade in over the last metre)
  let hotD = null, hotKey = '', hotN = 0;
  GR.hotMap = function (S) {
    const W = SS.world, n = W.NX, nz = W.NZ, H = W.H, lv = S && S.lava, vg = S && S.veg;
    if (!W.features && !lv) return null;
    const key = (lv ? lv.ver : 0) + ':' + (vg ? vg.nAct : 0) + ':' + W.version + ':' + n;
    if (hotD && hotKey === key && hotN === n * nz) return hotD;
    const N = n * nz, INF = 1e4; if (!hotD || hotN !== N) hotD = new Float32Array(N);
    hotN = N; hotKey = key; hotD.fill(INF);
    let any = false;
    if (lv) for (let c = 0; c < N; c++) if (lv.h[c] > 0.02) { hotD[c] = 0; any = true; }
    if (vg) for (let c = 0; c < N; c++) if (vg.burnT[c] > 0) { hotD[c] = 0; any = true; }
    const vents = (W.features && W.features.vents) || [];
    for (let v = 0; v < vents.length; v++) {                          // a fumarole is a hot mouth about 1.5 m wide
      const ci = Math.round(vents[v].x / H), ck = Math.round(vents[v].z / H), r = Math.ceil(1.5 / H);
      for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) { const i = ci + di, k = ck + dk; if (i >= 0 && k >= 0 && i < n && k < nz && Math.hypot(di, dk) * H <= 1.5) { hotD[k * n + i] = 0; any = true; } }
    }
    if (!any) return hotD;
    const a = H, b = H * 1.4142;                                      // chamfer distance transform (two passes), metres
    for (let k = 0; k < nz; k++) for (let i = 0; i < n; i++) {
      const c = k * n + i; let d = hotD[c];
      if (i > 0 && hotD[c - 1] + a < d) d = hotD[c - 1] + a;
      if (k > 0) { if (hotD[c - n] + a < d) d = hotD[c - n] + a; if (i > 0 && hotD[c - n - 1] + b < d) d = hotD[c - n - 1] + b; if (i < n - 1 && hotD[c - n + 1] + b < d) d = hotD[c - n + 1] + b; }
      hotD[c] = d;
    }
    for (let k = nz - 1; k >= 0; k--) for (let i = n - 1; i >= 0; i--) {
      const c = k * n + i; let d = hotD[c];
      if (i < n - 1 && hotD[c + 1] + a < d) d = hotD[c + 1] + a;
      if (k < nz - 1) { if (hotD[c + n] + a < d) d = hotD[c + n] + a; if (i < n - 1 && hotD[c + n + 1] + b < d) d = hotD[c + n + 1] + b; if (i > 0 && hotD[c + n - 1] + b < d) d = hotD[c + n - 1] + b; }
      hotD[c] = d;
    }
    return hotD;
  };
  /* distance (m) to the nearest heat source at (x, z): 1e4 = none known */
  GR.hotDist = function (x, z) {
    if (!hotD) return 1e4; const W = SS.world, n = W.NX;
    return hotD[M.clamp(Math.round(z / W.H), 0, W.NZ - 1) * n + M.clamp(Math.round(x / W.H), 0, n - 1)];
  };
  GR.HOT_R = HOT_R;
  const m4 = new T.Matrix4(), q4 = new T.Quaternion(), v4 = new T.Vector3(), s4 = new T.Vector3(), yAxis = new T.Vector3(0, 1, 0), col = new T.Color();
  GR.onChunk = function (ci, c) {
    let im = per.get(ci);
    if (im) { scene.remove(im); im.dispose(); per.delete(ci); }
    if (!c || !c.data || !surf) return;
    if (GR.S) GR.hotMap(GR.S);
    const G = SS.meshgen.grass(c.data, grassAt, SS.world.SEA, MAXC, Q.grass, hotD ? GR.hotDist : null, HOT_R), n = G.length / 6;
    if (!n) return;
    im = new T.InstancedMesh(geo, mat, n);
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      q4.setFromAxisAngle(yAxis, G[o + 3]); v4.set(G[o], G[o + 1], G[o + 2]); s4.set(1, G[o + 4], 1);
      m4.compose(v4, q4, s4); im.setMatrixAt(i, m4);
      const f = G[o + 5], h = M.hash3(Math.round(G[o] * 10), ci, 9);
      if (f === 1) col.setRGB(2, 1, 1); else if (f === 2) col.setRGB(1, 1, 2); else col.setRGB(0.85 + h * 0.3, 0.9 + h * 0.15, 0.75 + h * 0.2);
      im.setColorAt(i, col);
    }
    im.instanceMatrix.needsUpdate = true; im.instanceColor.needsUpdate = true;
    im.receiveShadow = true; im.frustumCulled = false; im.userData.chunk = c;
    scene.add(im); per.set(ci, im);
  };
  GR.rebuildAll = function (chunks) { for (let ci = 0; ci < chunks.length; ci++) if (chunks[ci]) GR.onChunk(ci, chunks[ci]); };
  GR.count = () => { let n = 0; for (const im of per.values()) n += im.count; return n; };

  /* per frame: slab plane, wind, time; only chunks crossing the slab are drawn */
  GR.frame = function (S, time, wind, whirls, snow) {
    if (!mat) return;
    const U = mat.userData.uniforms, n = SS.plane.nrm(S);
    U.uTime.value = time; U.uO.value.set(S.O.x, 0, S.O.z); U.uN.value.set(n.x, 0, n.z); U.uBack.value = SS.terrain.uniforms.uBack.value;
    if (wind) U.uWind.value.set(wind.x, 0, wind.z);
    if (SS.fx && SS.fx.blastField) SS.fx.blastField(U.uBlast.value);          // P71: the blast impulse field (flattened, then springing back)
    if (whirls) for (let i = 0; i < 4; i++) {
      const w = whirls[i];
      if (w) { U.uWhirl.value[i].set(w.x, w.z, w.r, w.s); U.uWhirlB.value[i].set(w.rc0 * 1.5 + SS.CFG.WIND.WHIRL.BURST_V * w.bt, w.st === 2 ? w.bst : 0, w.rc0 + 1.5 + 0.8 * w.bt, 0); }
      else { U.uWhirl.value[i].set(0, 0, 1, 0); U.uWhirlB.value[i].set(0, 0, 1, 0); }
    }
    U.uSnow.value = snow || 0;
    for (const im of per.values()) { const c = im.userData.chunk; im.visible = !!(c && c.slab && c.slab.visible); }
  };
})(window.SS = window.SS || {});
