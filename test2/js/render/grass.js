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
    const i = M.clamp(Math.round(x / 96 * (surfN - 1)), 0, surfN - 1), k = M.clamp(Math.round(z / 96 * (surfN - 1)), 0, surfN - 1);
    return surf[(k * surfN + i) * 4] / 255;
  }

  const m4 = new T.Matrix4(), q4 = new T.Quaternion(), v4 = new T.Vector3(), s4 = new T.Vector3(), yAxis = new T.Vector3(0, 1, 0), col = new T.Color();
  GR.onChunk = function (ci, c) {
    let im = per.get(ci);
    if (im) { scene.remove(im); im.dispose(); per.delete(ci); }
    if (!c || !c.data || !surf) return;
    const G = SS.meshgen.grass(c.data, grassAt, SS.world.SEA, MAXC, Q.grass), n = G.length / 6;
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
    if (whirls) for (let i = 0; i < 4; i++) { const w = whirls[i]; if (w) U.uWhirl.value[i].set(w.x, w.z, w.r, w.s); else U.uWhirl.value[i].set(0, 0, 1, 0); }
    U.uSnow.value = snow || 0;
    for (const im of per.values()) { const c = im.userData.chunk; im.visible = !!(c && c.slab && c.slab.visible); }
  };
})(window.SS = window.SS || {});
