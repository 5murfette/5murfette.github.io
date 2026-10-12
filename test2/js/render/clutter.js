/* render/clutter.js — P62 ground clutter: small instanced pebbles, twigs, grass tufts, flowers, desert scrub and snow chunks scattered on
 * the terrain surface (Three.js specific, presentation only; the deterministic sim is not touched).
 * Like the grass: placed once per terrain chunk mesh from its up-facing, sky-exposed triangles (stable world-anchored hashing, SS.math.hash3),
 * re-sampled whenever the chunk is remeshed (a crater removes the clutter that stood in it). What grows depends on the biome and on the
 * triangle's dominant material (soil, sand, snow, rock, ash ...); pebbles / chunks follow the surface normal, plants lean up.
 * Standard materials only: the automatic section clip (render/section.js) applies; the vertex shader additionally drops instances
 * behind the slab (t < -uBack) and sways the plants in the wind. Quality: Q.clutter (0 = off on low).
 * API: init(scene, tx, quality), onChunk(ci, chunk), frame(S, view, wind), count(). */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const CL = SS.clutterView = {};
  let scene = null, Q = null, geos = null, mats = null, uTime = { value: 0 }, uWind = { value: new T.Vector3() };
  const per = new Map();
  const MAXC = 2600;

  /* ---------- geometry ---------- */
  function finishGeo(pos, col, nrm) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    if (nrm) g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3)); else g.computeVertexNormals();
    return g;
  }
  function stoneGeo() {
    const g = new T.IcosahedronGeometry(1, 0), p = g.attributes.position, n = p.count, col = [];
    for (let i = 0; i < n; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), h = M.hash3(Math.round(x * 50), Math.round(y * 50), Math.round(z * 50));
      const k = 0.78 + 0.42 * h;
      p.setXYZ(i, x * k * 1.15, y * k * 0.55, z * k);
      const v = 0.8 + 0.2 * (y > 0 ? 1 : 0.7); col.push(v, v, v);
    }
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    return g;
  }
  function twigGeo() {
    const pos = [], col = [];
    const bar = (x0, y0, z0, x1, y1, z1, w) => {            // a thin flat strip with a ridge (3 faces)
      const dx = x1 - x0, dz = z1 - z0, l = Math.hypot(dx, dz) || 1, px = -dz / l * w, pz = dx / l * w;
      pos.push(x0 - px, y0, z0 - pz, x0 + px, y0, z0 + pz, x1, y1 + w, z1, x0 + px, y0, z0 + pz, x1 + px * 0.6, y1, z1 + pz * 0.6, x1, y1 + w, z1);
      for (let i = 0; i < 6; i++) col.push(0.7, 0.6, 0.5);
    };
    bar(-0.28, 0, 0, 0.28, 0.01, 0.02, 0.018); bar(0.02, 0.005, 0.0, 0.14, 0.01, 0.1, 0.008); bar(-0.1, 0.003, 0.0, -0.17, 0.01, -0.07, 0.007);
    return finishGeo(pos, col, null);
  }
  /* a clump of curved triangular blades (vertex colour: dark base -> bright tip), fake upward normals like the grass */
  function tuftGeo(nb, hgt, spread, wid) {
    const pos = [], col = [], nr = [];
    for (let b = 0; b < nb; b++) {
      const a = b / nb * 6.283 + M.hash3(b, 3, 5) * 0.8, lean = spread * (0.5 + M.hash3(b, 7, 1)), h = hgt * (0.6 + 0.4 * M.hash3(b, 1, 9)), w = wid || 0.045;
      const cx = Math.cos(a), cz = Math.sin(a), sx = -cz * w, sz = cx * w;
      pos.push(cx * 0.01 - sx, 0, cz * 0.01 - sz, cx * 0.01 + sx, 0, cz * 0.01 + sz, cx * lean, h, cz * lean);
      col.push(0.34, 0.52, 0.17, 0.34, 0.52, 0.17, 0.7, 0.95, 0.36);
      nr.push(0, 0.92, 0.38, 0, 0.92, 0.38, 0, 1, 0);
    }
    return finishGeo(pos, col, nr);
  }
  function flowerGeo() {
    const pos = [], col = [], nr = [], H = 0.3, bend = 0.04;
    const tri = (a, b, c, ca, cb, cc) => { pos.push(...a, ...b, ...c); col.push(...ca, ...cb, ...cc); for (let i = 0; i < 3; i++) nr.push(0, 1, 0.2); };
    const gA = [0.5, 0.78, 0.32], gB = [0.62, 0.9, 0.4], wh = [1, 1, 1], ye = [1, 0.85, 0.35];
    tri([-0.006, 0, 0], [0.006, 0, 0], [bend, H, 0], gA, gA, gB);
    tri([0, 0, -0.006], [0, 0, 0.006], [bend, H, 0], gA, gA, gB);
    for (let pl = 0; pl < 3; pl++) {                            // the head: three crossed fans of petals (a vertical pair and a tilted flat one), readable from every side
      const R2 = 0.05;
      for (let i = 0; i < 8; i++) {
        const a0 = i / 8 * 6.283, a1 = (i + 1) / 8 * 6.283;
        const P2 = a => pl === 0 ? [bend + Math.cos(a) * R2, H + Math.sin(a) * R2, 0] : pl === 1 ? [bend, H + Math.sin(a) * R2, Math.cos(a) * R2] : [bend + Math.cos(a) * R2 * 0.8, H + 0.03, Math.sin(a) * R2 * 0.8];
        tri([bend, H, 0], P2(a0), P2(a1), ye, wh, wh);
      }
    }
    return finishGeo(pos, col, nr);
  }
  /* desert scrub: a spiky dry bush (leaning thin blades + a few dead sticks) */
  function scrubGeo() {
    const g = tuftGeo(22, 0.5, 0.2, 0.07), p = g.attributes.position, c = g.attributes.color;
    for (let i = 0; i < c.count; i++) { const tip = c.getX(i) > 0.4; c.setXYZ(i, tip ? 0.78 : 0.32, tip ? 0.7 : 0.26, tip ? 0.36 : 0.12); }
    p.needsUpdate = true;
    return g;
  }

  const GF = SS.decorKit.GF, KT = SS.decorKit.TILE;
  CL.kit = GF;

  /* P96 shared PBR atlas (assets/decor.js: 4 x 3 tiles of 256 px; albedo atlas + normal atlas whose blue channel is the roughness) and the triplanar patch. */
  const ATL = { alb: { value: null }, nrm: { value: null }, grid: { value: new T.Vector2(4, 3) } };
  (function loadAtlas() {
    const D = window.DECOR_TEX; if (!D) return;
    const grey = new T.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1); grey.needsUpdate = true; ATL.alb.value = grey; ATL.nrm.value = new T.DataTexture(new Uint8Array([128, 128, 160, 255]), 1, 1); ATL.nrm.value.needsUpdate = true;
    ATL.grid.value.set(D.cols, D.rows);
    for (const k of ['alb', 'nrm']) { const im = new Image(); im.onload = () => { const t = new T.Texture(im); t.colorSpace = k === 'alb' ? T.SRGBColorSpace : T.NoColorSpace; t.generateMipmaps = true; t.minFilter = T.LinearMipmapLinearFilter; t.anisotropy = 4; t.needsUpdate = true; ATL[k].value = t; }; im.src = D[k]; }
  })();
  const TRI_VS = `
    attribute vec3 tl; varying vec3 vTP; varying vec3 vNO; varying float vLY; varying float vBl; flat varying vec2 vTiles; varying vec3 vMx; varying vec3 vMy; varying vec3 vMz;
    uniform float uTexD;`;
  const TRI_VS_BODY = `
    { float isc = length(instanceMatrix[0].xyz); vTP = position * isc * uTexD; vNO = normal; vLY = position.y * isc; vBl = tl.z; vTiles = tl.xy;
      mat3 rm = mat3(instanceMatrix[0].xyz, instanceMatrix[1].xyz, instanceMatrix[2].xyz) / isc; mat3 mm = normalMatrix * rm; vMx = mm[0]; vMy = mm[1]; vMz = mm[2]; }`;
  const TRI_FS = `
    uniform sampler2D tAlb; uniform sampler2D tNrm; uniform vec2 uGrid; uniform float uNS, uRK, uAO;
    varying vec3 vTP; varying vec3 vNO; varying float vLY; varying float vBl; flat varying vec2 vTiles; varying vec3 vMx; varying vec3 vMy; varying vec3 vMz;
    vec3 gAlb; float gRough; vec3 gNrm;
    void atlasFetch(float tile, vec2 p, vec2 dx, vec2 dy, out vec3 alb, out vec3 nrm, out float ro) {
      vec2 cell = vec2(mod(tile, uGrid.x), uGrid.y - 1.0 - floor(tile / uGrid.x)); vec2 uv = (cell + 0.015 + fract(p) * 0.97) / uGrid; vec2 g = 0.97 / uGrid;
      alb = textureGrad(tAlb, uv, dx * g, dy * g).rgb; vec4 n = textureGrad(tNrm, uv, dx * g, dy * g); nrm = vec3((n.rg * 2.0 - 1.0) * uNS, 1.0); ro = n.b;
    }
    void triplanar(float tile, out vec3 alb, out vec3 nO, out float ro) {
      vec3 bw = pow(abs(vNO), vec3(4.0)); bw /= (bw.x + bw.y + bw.z + 1e-5);
      vec2 pX = vTP.zy, pY = vTP.xz, pZ = vTP.xy; vec2 dXx = dFdx(pX), dXy = dFdy(pX), dYx = dFdx(pY), dYy = dFdy(pY), dZx = dFdx(pZ), dZy = dFdy(pZ);
      alb = vec3(0.0); ro = 0.0; nO = vec3(0.0);
      vec3 a, n; float r;
      if (bw.x > 0.03) { atlasFetch(tile, pX, dXx, dXy, a, n, r); alb += a * bw.x; ro += r * bw.x; vec3 t = vec3(n.xy + vNO.zy, abs(n.z) * vNO.x); nO += vec3(t.z, t.y, t.x) * bw.x; }
      if (bw.y > 0.03) { atlasFetch(tile, pY, dYx, dYy, a, n, r); alb += a * bw.y; ro += r * bw.y; vec3 t = vec3(n.xy + vNO.xz, abs(n.z) * vNO.y); nO += vec3(t.x, t.z, t.y) * bw.y; }
      if (bw.z > 0.03) { atlasFetch(tile, pZ, dZx, dZy, a, n, r); alb += a * bw.z; ro += r * bw.z; vec3 t = vec3(n.xy + vNO.xy, abs(n.z) * vNO.z); nO += t * bw.z; }
      float ws = bw.x + bw.y + bw.z; alb /= ws; ro /= ws; nO = normalize(nO);
    }`;
  const TRI_MAP = `
    { gAlb = vec3(1.0); gRough = 0.8; gNrm = normalize(vNO);
      if (vTiles.x > -0.5) {
        vec3 a0, n0; float r0; triplanar(vTiles.x, a0, n0, r0); gAlb = a0; gRough = r0; gNrm = n0;
        if (vBl > 0.01 && vTiles.y > -0.5) { vec3 a1, n1; float r1; triplanar(vTiles.y, a1, n1, r1); gAlb = mix(a0, a1, vBl); gRough = mix(r0, r1, vBl); gNrm = normalize(mix(n0, n1, vBl)); }
      }
      float ao = mix(uAO, 1.0, smoothstep(-0.03, 0.2, vLY));
      diffuseColor.rgb *= gAlb * ao; }`;
  const TRI_NRM = `
    { vec3 nv = normalize(vMx * gNrm.x + vMy * gNrm.y + vMz * gNrm.z); normal = nv * faceDirection; }`;

  /* o: { dbl, rough, metal, emit, tex (triplanar atlas), map (alpha card texture), aoK } (P96 decor: double sided, glossy glass / obsidian, metal, self-lit fungi and crystals) */
  function mat(sway, flat, kill, o) {
    o = o || {};
    const m = new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: o.rough != null ? o.rough : 0.95, metalness: o.metal || 0, side: sway || o.dbl ? T.DoubleSide : T.FrontSide, flatShading: !!flat });
    if (o.map) { m.map = o.map; m.alphaTest = 0.45; m.alphaToCoverage = true; }
    m.onBeforeCompile = sh => {
      const U = (SS.terrain && SS.terrain.uniforms) || FALLBACK_U;
      sh.uniforms.uO = U.uO; sh.uniforms.uN = U.uN; sh.uniforms.uBack = U.uBack; sh.uniforms.uTime = uTime; sh.uniforms.uWind = uWind;
      sh.uniforms.tCover = U.tCover || { value: null }; sh.uniforms.uNL = U.uNL || { value: 193 }; sh.uniforms.uSnowU = U.uSnow || { value: 0 }; sh.uniforms.uKill = { value: kill ? 1 : 0 };
      sh.uniforms.uEmit = { value: o.emit || 0 };
      if (o.tex) { sh.uniforms.tAlb = ATL.alb; sh.uniforms.tNrm = ATL.nrm; sh.uniforms.uGrid = ATL.grid; sh.uniforms.uNS = { value: o.ns != null ? o.ns : 0.9 }; sh.uniforms.uRK = { value: o.rk != null ? o.rk : 1 }; sh.uniforms.uAO = { value: o.aoK != null ? o.aoK : 0.55 }; sh.uniforms.uTexD = { value: o.dens || 3.4 }; }
      sh.vertexShader = sh.vertexShader
        .replace('void main() {', 'uniform vec3 uO; uniform vec3 uN; uniform float uBack, uTime, uNL, uSnowU, uKill; uniform vec3 uWind; uniform sampler2D tCover;' + (o.tex ? TRI_VS : '') + '\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n { vec2 cv = texture2D(tCover, (instanceMatrix[3].xz * 2.0 + 0.5) / uNL).rg * 0.4; float sn = max(uSnowU, max(cv.x / 0.05, cv.y / 0.03)); transformed *= mix(1.0, 1.0 - smoothstep(0.35, 0.7, sn), uKill); }\n' + (o.tex ? TRI_VS_BODY : '') + (sway ? `
          { float ph = instanceMatrix[3].x * 3.1 + instanceMatrix[3].z * 2.3; float hh = transformed.y * transformed.y;
            transformed.x += (uWind.x * 0.5 + sin(uTime * 1.8 + ph) * 0.05) * hh * 4.0; transformed.z += (uWind.z * 0.5 + cos(uTime * 1.3 + ph) * 0.04) * hh * 4.0; }` : ''))
        .replace('#include <project_vertex>', `#include <project_vertex>
          { vec4 cw = instanceMatrix * vec4(transformed, 1.0); if (dot(cw.xz - uO.xz, uN.xz) < -uBack) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }`);
      let fs = sh.fragmentShader;
      if (o.emit || o.tex) fs = fs.replace('void main() {', (o.emit ? 'uniform float uEmit;\n' : '') + (o.tex ? TRI_FS : '') + '\nvoid main() {');
      if (o.emit) fs = fs.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vColor.rgb * uEmit;');
      if (o.tex) { fs = fs.replace('#include <map_fragment>', '#include <map_fragment>\n' + TRI_MAP).replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = clamp(gRough * uRK, 0.12, 1.0);').replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + TRI_NRM); }
      if (o.map) fs = fs.replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;');
      sh.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => 'clutter' + (sway ? 's' : 'r') + (flat ? 'f' : 'g') + (kill ? 'k' : 'n') + (o.dbl ? 'd' : '') + (o.emit ? 'e' + o.emit : '') + (o.rough != null ? 'r' + o.rough : '') + (o.metal ? 'm' : '') + (o.tex ? 't' + (o.ns || '') + (o.rk || '') + (o.aoK || '') + (o.dens || '') : '') + (o.map ? 'a' : '');
    return m;
  }
  const FALLBACK_U = { uO: { value: new T.Vector3() }, uN: { value: new T.Vector3(0, 0, 1) }, uBack: { value: 1e5 } };

  /* P96 decor kinds: [lean to world up 0..1, sink m (x scale), scale lo, scale hi, material key]. Instances follow the surface normal (lean 0) or stand up (1);
   on End of the World (no common up) they always follow the surface normal. */
  const DEC = {
    mushA: [0.6, 0.01, 2.0, 3.4, 'std'], mushB: [0.6, 0.01, 2.0, 3.4, 'std'], fern: [0.7, 0.02, 1.0, 1.7, 'std'], log: [0.12, 0.05, 1.0, 1.8, 'logm'], stump: [0.9, 0.06, 1.0, 1.7, 'std'],
    cactus: [0.95, 0.04, 1.0, 1.8, 'std'], barrel: [0.9, 0.03, 1.0, 1.9, 'std'], pear: [0.85, 0.03, 1.2, 2.2, 'std'], skull: [0.15, 0.03, 1.6, 2.5, 'std'], ribs: [0.1, 0.04, 1.5, 2.4, 'std'], bone: [0.1, 0.01, 1.8, 3.0, 'std'],
    rubble: [0.15, 0.04, 1.2, 2.4, 'std'], pillar: [1.0, 0.1, 0.6, 1.4, 'std'], obsidian: [0.5, 0.03, 1.3, 2.6, 'gloss'], ice: [0.55, 0.03, 1.2, 2.6, 'ice'], crystal: [0.4, 0.03, 1.2, 2.6, 'crys'],
    boulder: [0.1, 0.12, 0.7, 1.5, 'std0'], stalag: [0.35, 0.05, 0.9, 2.1, 'std0'], fungi: [0.3, 0.01, 1.4, 2.6, 'fungi'], plate: [0, 0.0, 1.1, 2.2, 'metal'], wreck: [0, 0.04, 0.8, 1.4, 'metal'], cable: [0, 0.0, 1.2, 2.0, 'metal']
  };
  const MK = { logm: [false, true, { dbl: true, tex: true, aoK: 1 }], std: [false, true, { dbl: true, tex: true }], std0: [false, false, { dbl: true, tex: true }], gloss: [false, true, { dbl: true, tex: true, rk: 0.75, metal: 0.05 }], ice: [false, false, { dbl: true, tex: true, rk: 0.55, emit: 0.22 }], crys: [false, false, { dbl: true, rough: 0.15, emit: 0.7 }], fungi: [false, false, { dbl: true, emit: 1.5, rough: 0.6 }], metal: [false, false, { dbl: true, tex: true, metal: 0.7, rk: 0.8 }] };
  const geoCache = {}, matCache = {};
  const geoOf = k => geos[k] || geoCache[k] || (geoCache[k] = GF[k]());
  const matOf = k => { if (mats[k]) return mats[k]; const d = DEC[k][4]; return matCache[d] || (matCache[d] = mat(false, MK[d][0] || false, MK[d][1], MK[d][2])); };

  CL.init = function (sc, tx, quality) {
    scene = sc; Q = quality;
    if (!(Q.clutter > 0)) return;
    const sg = stoneGeo();
    geos = { stone: sg, snow: sg, twig: twigGeo(), tuft: tuftGeo(8, 0.45, 0.16), flower: flowerGeo(), scrub: scrubGeo() };
    mats = { stone: mat(false, true, true), snow: mat(false, true, false), twig: mat(false, false, true), tuft: mat(true, false, true), flower: mat(true, false, true), scrub: mat(true, false, true) };
    mats.fern = mat(true, false, true, { dbl: true, map: SS.decorKit.fernTexture() });
  };

  /* dominant material of a triangle vertex (slot = matId - 1: mA bedrock rock soil sand, mB sandstone snow ice basalt, mC lava crust ash scree; mD steel foam concrete obsidian) */
  function domMat(d, v) {
    let best = 0, bw = 0;
    for (let s = 0; s < 4; s++) {
      const a = d.mA[v * 4 + s], b = d.mB[v * 4 + s], c = d.mC[v * 4 + s];
      if (a > bw) { bw = a; best = s + 1; } if (b > bw) { bw = b; best = s + 5; } if (c > bw) { bw = c; best = s + 9; }
    }
    const x = d.mD[v * 4] + d.mD[v * 4 + 1] + d.mD[v * 4 + 2] + d.mD[v * 4 + 3];
    if (x > 20) { let m = 0, mw = 0; for (let s = 0; s < 4; s++) if (d.mD[v * 4 + s] > mw) { mw = d.mD[v * 4 + s]; m = 13 + s; } return m; }
    return best;
  }
  const MT = { BEDROCK: 1, ROCK: 2, SOIL: 3, SAND: 4, SANDSTONE: 5, SNOW: 6, ICE: 7, BASALT: 8, LAVA: 9, CRUST: 10, ASH: 11, SCREE: 12, STEEL: 13, FOAM: 14, CONCRETE: 15, OBSIDIAN: 16 };

  const qa = new T.Quaternion(), qb = new T.Quaternion(), qFix = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 0, 1), Math.PI / 2), up = new T.Vector3(0, 1, 0), nv = new T.Vector3(), pv = new T.Vector3(), sv = new T.Vector3(), m4 = new T.Matrix4(), cc = new T.Color();

  /* per biome: pebble / twig / plant densities per m2 (before the quality factor) */
  const BIO = {
    temperate: { stone: 1.1, twig: 0.4, tuft: 0.9, flower: 0.8, scrub: 0, snow: 0 },
    alpine: { stone: 0.7, twig: 0.15, tuft: 0.35, flower: 0.12, scrub: 0, snow: 0.8 },
    canyon: { stone: 1.2, twig: 0.25, tuft: 0.25, flower: 0.05, scrub: 0.35, snow: 0 },
    desert: { stone: 0.5, twig: 0.08, tuft: 0.1, flower: 0, scrub: 0.45, snow: 0 },
    volcanic: { stone: 1.4, twig: 0.1, tuft: 0.04, flower: 0, scrub: 0.05, snow: 0 },
    eow: { stone: 0.5, twig: 0, tuft: 0, flower: 0, scrub: 0, snow: 0 }
  };
  const SC = SS.CFG.MATS;
  function matCol(m) { const c = SC[m] ? SC[m].rgb : 0x808080; return [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255]; }

  CL.onChunk = function (ci, c) {
    let set = per.get(ci);
    if (set) { for (const im of set) { scene.remove(im); im.dispose(); } per.delete(ci); }
    if (!geos || !c || !c.data || !(Q.clutter > 0)) return;
    const S = CL.S, W = SS.world, biome = W.eow ? 'eow' : (W.features && W.features.biome) || W.biome || (S && S.biome) || 'temperate', B = BIO[biome] || BIO.temperate, d = c.data, P = d.pos, N = d.nrm, I = d.idx, D = d.depth;
    const dens = Q.clutter, sea = W.SEA, lists = { stone: [], snow: [], twig: [], tuft: [], flower: [], scrub: [] };
    const under = !!W.under, eow = !!W.eow, vents = (W.features && W.features.vents) || [], dd = (window.P96_DECOR != null ? window.P96_DECOR : 1) * 1.7;   // (window.P96_DECOR: a tuning / shot hook, a multiplier of every decor density; 0 = none)
    let total = 0;
    if (SS.grass && SS.grass.hotMap && S) SS.grass.hotMap(S);                                       // P102: heat distance field (lava, vents, burning ground)
    const hotR = SS.grass ? SS.grass.HOT_R : 4, PLANT = { tuft: 1, flower: 1, scrub: 1, twig: 1, mushA: 1, mushB: 1, fern: 1, log: 1, stump: 1, fungi: 1, cactus: 1, barrel: 1, pear: 1 };
    const snowy = S && S.weather ? S.weather.snowCover || 0 : 0;
    for (let i = 0; i < I.length && total < MAXC; i += 3) {
      const a = I[i], b = I[i + 1], c2 = I[i + 2];
      const nya = N[a * 3 + 1], nyb = N[b * 3 + 1], nyc = N[c2 * 3 + 1];
      const ceil = under && nya < -0.55 && nyb < -0.55 && nyc < -0.55;
      if (!eow && !ceil && (nya < 0.55 || nyb < 0.55 || nyc < 0.55)) continue;
      if (!eow && !under && (D[a] > 0.3 || D[b] > 0.3 || D[c2] > 0.3)) continue;
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      if (!eow && ay < sea + 0.25) continue;
      if (!eow && !under && Math.abs(W.top_at(ax, az) - ay) > 0.7) continue;
      const mt = domMat(d, a);
      if (mt === MT.LAVA || mt === MT.ICE || mt === MT.BEDROCK || mt === MT.FOAM || mt === MT.CONCRETE || (mt === MT.STEEL && !eow)) continue;
      if (!mt) continue;
      const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c2 * 3] - ax, vy = P[c2 * 3 + 1] - ay, vz = P[c2 * 3 + 2] - az;
      const area = 0.5 * M.len3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (area < 1e-4) continue;
      const nx = (N[a * 3] + N[b * 3] + N[c2 * 3]) / 3, ny = (N[a * 3 + 1] + N[b * 3 + 1] + N[c2 * 3 + 1]) / 3, nz = (N[a * 3 + 2] + N[b * 3 + 2] + N[c2 * 3 + 2]) / 3;
      const qx = Math.floor(ax * 4) + 311, qy = Math.floor(ay * 4), qz = Math.floor(az * 4) - 97;
      const patch = M.hash3(Math.floor(ax / 2.5) + 40, 11, Math.floor(az / 2.5)), patch2 = M.hash3(Math.floor(ax / 4) - 8, 23, Math.floor(az / 4) + 5);
      const gr = SS.grass.cover(ax, az);
      const kinds = [];
      const isSoil = mt === MT.SOIL, isSand = mt === MT.SAND, isSnow = mt === MT.SNOW, isRock = mt === MT.ROCK || mt === MT.SANDSTONE || mt === MT.SCREE, isDark = mt === MT.BASALT || mt === MT.CRUST || mt === MT.ASH || mt === MT.OBSIDIAN;
      const shore = ay < sea + 1.1 ? 2.2 : 1, flat = ny > 0.88;
      if (ceil) {
        if (dd > 0 && !snowy) kinds.push(['stalag', 0.12 * dd * (0.3 + patch2), 0]);
      } else if (eow) {
        if (mt === MT.STEEL) { kinds.push(['plate', 0.1 * dd, 0]); kinds.push(['wreck', 0.012 * dd * (patch2 > 0.4 ? 1 : 0), 0]); kinds.push(['cable', 0.03 * dd * patch, 0]); kinds.push(['ice', 0.025 * dd * patch2, 0]); kinds.push(['stone', B.stone * 0.2, 0]); }
        else { kinds.push(['stone', B.stone * (0.3 + 1.4 * patch), 0]); kinds.push(['ice', 0.012 * dd * patch2 * patch2 * 3, 0]); }
      } else {
        if (isSnow) { kinds.push(['snow', B.snow * (0.4 + patch2), 1]); kinds.push(['stone', B.stone * 0.12, 0]); }
        else if (isSoil || isSand || isRock || isDark) kinds.push(['stone', B.stone * (0.3 + 1.4 * patch) * (isSand ? 0.45 : 1) * shore, 0]);
        if (!under) {
          if (isSoil && !snowy) { kinds.push(['twig', B.twig * (0.3 + patch2), 0]); if (gr > 0.2) { kinds.push(['tuft', B.tuft * gr * (0.4 + patch), 0]); kinds.push(['flower', B.flower * gr * patch * patch * 4.5, 0]); } }
          if (isSand && !snowy) { kinds.push(['scrub', B.scrub * (patch2 > 0.45 ? patch2 : 0.1) * 1.4, 0]); if (B.tuft > 0) kinds.push(['tuft', B.tuft * patch, 2]); }
          if (isRock && !snowy && B.scrub > 0) kinds.push(['scrub', B.scrub * 0.4 * patch2, 0]);
          if (isDark && B.scrub > 0) kinds.push(['scrub', B.scrub * patch2, 3]);
        }
        if (dd > 0 && !snowy) decorKinds(kinds, biome, { mt, isSoil, isSand, isSnow, isRock, isDark, patch, patch2, gr, ny, flat, under, ax, az, vents, dd, shore });
      }
      for (let k = 0; k < kinds.length; k++) {
        const kd = kinds[k], kind = kd[0];
        let cnt = area * kd[1] * dens; const base = Math.floor(cnt);
        cnt = M.hash3(qx + k * 17, qy, qz) < cnt - base ? base + 1 : base;
        for (let q = 0; q < cnt && total < MAXC; q++) {
          let r1 = M.hash3(qx + q * 7 + k, qy + 3, qz + 1), r2 = M.hash3(qx + 2, qy + q * 13, qz + 2 + k);
          if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
          const h3_ = M.hash3(qx + q + k * 5, qy - q, qz + 5), h4 = M.hash3(qx - q, qy + k, qz + 9 + q), h5 = M.hash3(qx + 7 * q, qy + 5, qz - q);
          const x = ax + ux * r1 + vx * r2, y = ay + uy * r1 + vy * r2, z = az + uz * r1 + vz * r2;
          if (SS.heroView && SS.heroView.blocked(x, z)) continue;                // P101: nothing grows inside a hero set piece
          if (PLANT[kind] && SS.grass.hotDist(x, z) < hotR) continue;                                 // P102: no plants on or near lava / vents / fire
          let sc, r, g, bl, sink = 0.3;
          const dc = DEC[kind];
          if (dc) {
            sc = dc[2] + (dc[3] - dc[2]) * h3_; sink = dc[1]; r = g = bl = 0.88 + 0.24 * h4;
            if (kind === 'rubble') { const mc = matCol(mt), mx = Math.max(mc[0], mc[1], mc[2], 0.01), k2 = 0.8 + 0.35 * h4; r = (0.55 + 0.45 * mc[0] / mx) * k2; g = (0.55 + 0.45 * mc[1] / mx) * k2; bl = (0.55 + 0.45 * mc[2] / mx) * k2; }
            else if (kind === 'boulder') { r = 0.85 + 0.25 * h4; g = 0.85 + 0.25 * h4; bl = 0.88 + 0.25 * h4; }
            else if (kind === 'stump' && biome === 'volcanic') { r = 0.3 + 0.1 * h4; g = 0.28 + 0.08 * h4; bl = 0.27 + 0.08 * h4; }
            else if (kind === 'crystal') { const pal = Math.floor(h4 * 3); if (pal === 0) { r = 0.75; g = 0.5; bl = 1; } else if (pal === 1) { r = 0.45; g = 0.8; bl = 1; } else { r = 1; g = 0.5; bl = 0.85; } }
            else if (kind === 'fungi') { const pal = Math.floor(h4 * 3); if (pal === 0) { r = 1; g = 1; bl = 1; } else if (pal === 1) { r = 0.55; g = 1; bl = 0.4; } else { r = 1; g = 0.45; bl = 0.95; } }
            else if (kind === 'fern') { r = 0.85 + 0.2 * h4; g = 0.95 + 0.15 * h4; bl = 0.8; }
          } else if (kind === 'stone' || kind === 'snow') {
            if (kd[2] === 1) { sc = 0.18 + 0.3 * h3_ * h3_; r = 0.92; g = 0.96; bl = 1.0; sink = 0.45; }                 // snow chunk
            else if (kd[2] === 4) { sc = 0.07 + 0.15 * h3_ * h3_; r = g = bl = 0.74 + 0.25 * h4; g *= 0.98; bl *= 0.93; sink = 0.4; }   // pumice: pale and light
            else if (kd[2] === 5) { sc = 0.09 + 0.18 * h3_ * h3_; const y2 = 0.8 + 0.25 * h4; r = 1.0 * y2; g = 0.85 * y2; bl = 0.2 * y2; sink = 0.4; }   // sulphur crust
            else {
              sc = 0.06 + 0.14 * h3_ * h3_ + (h5 > 0.94 ? 0.12 : 0);
              const mc = matCol(mt), k2 = 0.55 + 0.7 * h4;
              r = mc[0] * k2 + 0.08; g = mc[1] * k2 + 0.07; bl = mc[2] * k2 + 0.06;
              if (isDark) { r *= 0.8; g *= 0.8; bl *= 0.8; }
              if (mt === MT.STEEL) { r = g = bl = 0.35 + 0.25 * h4; }
            }
          } else if (kind === 'twig') { sc = 0.7 + 0.8 * h3_; r = 0.3 + 0.2 * h4; g = 0.21 + 0.13 * h4; bl = 0.12 + 0.08 * h4; sink = 0.0; }
          else if (kind === 'tuft') {
            sc = 0.6 + 0.9 * h3_; sink = 0.02;
            if (kd[2] === 2) { r = 1.7; g = 1.1; bl = 0.6; } else { r = 0.85 + 0.35 * h4; g = 0.9 + 0.2 * h4; bl = 0.8 + 0.2 * h5; }
            if (biome === 'canyon' || biome === 'alpine') { r *= 1.1; g *= 0.95; bl *= 0.8; }
          } else if (kind === 'flower') {
            sc = 0.9 + 0.6 * h3_; sink = 0.02;
            const pal = Math.floor(h4 * 5);
            if (pal === 0) { r = 1; g = 1; bl = 1; } else if (pal === 1) { r = 1; g = 0.9; bl = 0.35; } else if (pal === 2) { r = 1; g = 0.55; bl = 0.7; } else if (pal === 3) { r = 0.8; g = 0.62; bl = 1; } else { r = 1; g = 0.6; bl = 0.35; }
          } else { sc = 0.7 + 0.9 * h3_; sink = 0.03; r = 0.85 + 0.2 * h4; g = 0.85 + 0.15 * h4; bl = 0.75; if (kd[2] === 3) { r *= 0.55; g *= 0.55; bl *= 0.55; } }
          (lists[kind] || (lists[kind] = [])).push(x, y, z, nx, ny, nz, h5 * 6.283, sc, r, g, bl, sink);
          total++;
        }
      }
    }
    set = [];
    for (const kind in lists) {
      const L = lists[kind], n = L.length / 12;
      if (!n) continue;
      const dc = DEC[kind], im = new T.InstancedMesh(dc ? geoOf(kind) : geos[kind], dc ? matOf(kind) : mats[kind], n), plant = kind === 'tuft' || kind === 'flower' || kind === 'scrub';
      const lean = dc ? dc[0] : plant ? 0.65 : 0;
      for (let i = 0; i < n; i++) {
        const o = i * 12, ny = L[o + 4];
        nv.set(L[o + 3], ny, L[o + 5]).normalize();
        if (lean > 0 && !eow) nv.lerp(ny < 0 ? pv.set(0, -1, 0) : up, lean).normalize();
        qa.setFromUnitVectors(up, nv); qb.setFromAxisAngle(up, L[o + 6]); qa.multiply(qb); if (kind === 'log') qa.multiply(qFix);
        const sc = L[o + 7], yv = L[o + 6] / 6.283;
        if (kind === 'stone' || kind === 'snow') sv.set(sc, sc * (0.7 + 0.5 * yv), sc); else if (kind === 'stalag') sv.set(sc * 0.8, sc * (0.8 + 0.8 * yv), sc * 0.8); else if (kind === 'boulder') sv.set(sc, sc * (0.7 + 0.4 * yv), sc * (0.85 + 0.3 * (1 - yv))); else sv.set(sc, sc, sc);
        const dn = kind === 'stone' || kind === 'snow' ? -L[o + 11] * sc : dc ? -L[o + 11] * sc : -0.02;
        pv.set(L[o] + nv.x * dn, L[o + 1] + nv.y * dn, L[o + 2] + nv.z * dn);
        m4.compose(pv, qa, sv); im.setMatrixAt(i, m4);
        cc.setRGB(L[o + 8], L[o + 9], L[o + 10], T.SRGBColorSpace); im.setColorAt(i, cc);
      }
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.receiveShadow = true; im.castShadow = false; im.userData.chunk = c;
      im.computeBoundingSphere(); if (im.boundingSphere) { im.boundingSphere.radius += 2.2; im.frustumCulled = true; } else im.frustumCulled = false;
      scene.add(im); set.push(im);
    }
    if (set.length) per.set(ci, set);
  };

  /* P96: what the biome and the ground under the triangle allow (densities per m2; the context sweep of docs/REASONING_CHECKLIST.md is in the comments) */
  function decorKinds(K, biome, x) {
    const dd = x.dd, p = x.patch, p2 = x.patch2, mt = x.mt;
    if (x.under) {                                                       // caves: no sky, no plants; limestone, glow fungi and crystals on the floor (stalactites are added for ceilings)
      if (mt === MT.SNOW || mt === MT.ICE) return;
      K.push(['stalag', 0.07 * dd * (0.2 + p), 0]); K.push(['fungi', 0.35 * dd * p2 * p2 * p, 0]); K.push(['crystal', 0.1 * dd * (p > 0.72 ? 1 : 0), 0]);
      return;
    }
    if (biome === 'temperate') {
      if (x.isSoil && x.gr > 0.2) {                                      // damp grass ground only: mushrooms and ferns in the shade of patches, a few logs / stumps
        K.push(['mushA', 0.1 * dd * p * p, 0]); K.push(['mushB', 0.14 * dd * p2 * p2, 0]); K.push(['fern', 0.5 * dd * x.gr * p2 * p2, 0]);
        if (x.ny > 0.85) { K.push(['log', 0.03 * dd * (p > 0.55 ? 1 : 0), 0]); K.push(['stump', 0.006 * dd * (p2 > 0.5 ? 1 : 0), 0]); }
      }
    } else if (biome === 'alpine') {
      if (x.isSnow) { K.push(['ice', 0.06 * dd * (0.3 + p2), 0]); K.push(['boulder', 0.05 * dd * p, 0]); }
      else if (x.isRock || x.isSoil) { K.push(['boulder', 0.05 * dd * p2, 0]); K.push(['ice', 0.015 * dd * p, 0]); }
    } else if (biome === 'desert') {
      if (x.isSand) {                                                    // cacti stand on level dune ground, bones lie where animals died
        const ok = x.ny > 0.8;
        if (ok) { K.push(['cactus', 0.026 * dd * (p2 > 0.4 ? p2 : 0), 0]); K.push(['barrel', 0.06 * dd * p, 0]); K.push(['pear', 0.05 * dd * p2 * p2, 0]); }
        K.push(['skull', 0.005 * dd, 0]); K.push(['ribs', 0.004 * dd, 0]); K.push(['bone', 0.016 * dd, 0]); K.push(['rubble', 0.08 * dd * p, 0]);
      } else if (x.isRock) { K.push(['rubble', 0.1 * dd * (0.3 + p), 0]); K.push(['barrel', 0.01 * dd * p, 0]); K.push(['bone', 0.006 * dd, 0]); }
    } else if (biome === 'canyon') {
      if (x.isRock) { K.push(['rubble', 0.12 * dd * (0.3 + p), 0]); if (x.ny > 0.85 && p2 > 0.3) K.push(['pillar', 0.06 * dd, 0]); }
      else if (x.isSand || x.isSoil) { K.push(['pear', 0.014 * dd * p, 0]); K.push(['barrel', 0.01 * dd * p2, 0]); K.push(['bone', 0.006 * dd, 0]); K.push(['skull', 0.002 * dd, 0]); K.push(['rubble', 0.03 * dd * p, 0]); }
    } else if (biome === 'volcanic') {
      if (x.isDark || x.isRock) {
        K.push(['obsidian', 0.1 * dd * p2 * p2 * 2, 0]); K.push(['stone', 0.07 * dd * p, 4]);
        if (x.ny > 0.8) K.push(['stump', 0.012 * dd * (p > 0.4 ? 1 : 0), 0]);
        for (let i = 0; i < x.vents.length; i++) { const v = x.vents[i]; if (Math.hypot(v.x - x.ax, v.z - x.az) < 11) { K.push(['stone', 0.7 * dd, 5]); break; } }
      }
    }
  }

  /* debug: instance counts per kind (all chunks), and within `r` m of (x, z) when given */
  CL.kinds = function (x, z, r) {
    const o = {}, m = new T.Matrix4(), v = new T.Vector3();
    for (const s of per.values()) for (const im of s) {
      const k = Object.keys(geos).find(q => geos[q] === im.geometry) || Object.keys(CL.kit).find(q => geoCache[q] === im.geometry) || '?';
      let n = 0; if (x == null) n = im.count; else for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); v.setFromMatrixPosition(m); if (Math.hypot(v.x - x, v.z - z) < r) n++; }
      o[k] = (o[k] || 0) + n;
    }
    return o;
  };
  CL.meshes = function (kind) {                                   // debug / shots: the instanced meshes of a kind
    const g = geos[kind] || geoCache[kind], r = [];
    for (const s of per.values()) for (const im of s) if (im.geometry === g) r.push(im);
    return r;
  };
  CL.weeds = () => TW.w;
  CL.fernMat = () => mats && mats.fern;
  CL.kitMat = k => DEC[k] ? matOf(k) : null;                     // showroom: the instanced material of a kit geometry
  CL.count = () => { let n = 0; for (const s of per.values()) for (const im of s) n += im.count; return n; };

  /* P96 tumbleweeds (desert / canyon only, open air): four dry bushes lodged on the ground that roll along the section with the wind component (still when it is calm,
   so a calm day shows them lying there). They follow the real ground height (W.top_at) and stop at a rise or the water, hop a little in the gusts, and are put back
   upwind of the view when they leave it. Seeded with SS.math.hash3, render only. */
  const TW = { w: [], mesh: null, last: 0 }, NTW = 4, twq = new T.Quaternion(), twp = new T.Vector3(), twn = new T.Vector3(), tws = new T.Vector3(), twm = new T.Matrix4();
  function tumbleFrame(S, view, wind) {
    const W = SS.world, P = SS.plane, bio = (W.features && W.features.biome) || W.biome || '';
    const on = (bio === 'desert' || bio === 'canyon') && !W.under && !W.eow && Q.clutter > 0 && view.camT && !(S.weather && (S.weather.snowCover > 0.05 || S.weather.rain > 0.5)) && !(window.P96_DECOR === 0);
    if (!on) { if (TW.mesh) TW.mesh.visible = false; return; }
    if (!TW.mesh) {
      const im = new T.InstancedMesh(geoOf('tumble'), matOf('rubble'), NTW);
      im.frustumCulled = false; im.castShadow = false; im.receiveShadow = true; im.instanceMatrix.setUsage(T.DynamicDrawUsage);
      for (let i = 0; i < NTW; i++) { cc.setRGB(0.9 + 0.12 * M.hash3(i, 5, 5), 0.9, 0.85, T.SRGBColorSpace); im.setColorAt(i, cc); TW.w.push({ init: false, s: 0, t: -0.5, y: 0, ang: 0, v: 0, hop: 0, stuck: 0, k: i }); }
      scene.add(im); TW.mesh = im;
    }
    const dt = M.clamp(view.time - TW.last, 0, 0.1); TW.last = view.time; TW.mesh.visible = true;
    const d = P.dir(S), n = P.nrm(S), fs = (view.camT.x - S.O.x) * d.x + (view.camT.z - S.O.z) * d.z;
    const wv = wind ? wind.x * d.x + wind.z * d.z : 0, v0 = Math.abs(wv) < 1 ? 0 : M.clamp(wv * 0.55, -4.5, 4.5);
    const R = 0.3, sea = W.SEA;
    for (let i = 0; i < NTW; i++) {
      const w = TW.w[i];
      if (!w.init || Math.abs(w.s - fs) > 26 || w.stuck > 4) {
        const up = v0 !== 0 && w.init ? -Math.sign(v0) * (19 + 5 * M.hash3(i, w.k, 3)) : (M.hash3(i, w.k, 1) - 0.5) * 34;
        w.s = fs + up; w.t = -0.35 - 0.5 * M.hash3(i, w.k, 2); w.k++; w.ang = M.hash3(i, w.k, 4) * 6; w.stuck = 0; w.v = 0;
        const x = S.O.x + w.s * d.x + w.t * n.x, z = S.O.z + w.s * d.z + w.t * n.z; w.y = W.top_at(x, z) + R; w.init = true;
      }
      w.v += (v0 * (0.8 + 0.2 * Math.sin(view.time * 0.9 + i * 2.1)) - w.v) * Math.min(1, dt * 1.5);
      const sn = w.s + w.v * dt, x1 = S.O.x + sn * d.x + w.t * n.x, z1 = S.O.z + sn * d.z + w.t * n.z, g1 = W.top_at(x1, z1);
      const x0 = S.O.x + w.s * d.x + w.t * n.x, z0 = S.O.z + w.s * d.z + w.t * n.z, g0 = W.top_at(x0, z0);
      if (Math.abs(w.v) > 0.05 && (g1 - g0 > 0.45 * Math.abs(w.v * dt) + 0.002 || g1 < sea + 0.15)) { w.v = 0; w.stuck += dt; }
      else { w.s = sn; w.stuck = Math.max(0, w.stuck - dt); }
      const sp = Math.abs(w.v); w.ang += w.v / R * dt;
      w.hop = Math.max(0, w.hop - dt * 3); if (sp > 1 && M.hash3(Math.floor(view.time * 3), i, 7) > 0.94 && w.hop < 0.1) w.hop = 1;
      const gy = W.top_at(S.O.x + w.s * d.x + w.t * n.x, S.O.z + w.s * d.z + w.t * n.z) + R * 0.85 + 0.18 * Math.sin(w.hop * 3.14159) * Math.min(1, sp * 0.4);
      w.y += (gy - w.y) * Math.min(1, dt * 12);
      twn.set(d.z, 0, -d.x).normalize(); twq.setFromAxisAngle(twn, w.ang);
      twp.set(S.O.x + w.s * d.x + w.t * n.x, w.y, S.O.z + w.s * d.z + w.t * n.z); tws.set(1.05, 1.05, 1.05);
      twm.compose(twp, twq, tws); TW.mesh.setMatrixAt(i, twm);
    }
    TW.mesh.instanceMatrix.needsUpdate = true;
  }

  CL.frame = function (S, view, wind) {
    CL.S = S;
    if (!geos) return;
    uTime.value = view.time;
    if (wind) uWind.value.set(wind.x, 0, wind.z);
    for (const s of per.values()) for (const im of s) { const c = im.userData.chunk; im.visible = !!(c && c.slab && c.slab.visible); }
    tumbleFrame(S, view, wind);
  };
  CL.clear = function () { if (TW.mesh) { scene.remove(TW.mesh); TW.mesh.dispose(); TW.mesh = null; TW.w.length = 0; } for (const s of per.values()) for (const im of s) { scene.remove(im); im.dispose(); } per.clear(); };
})(window.SS = window.SS || {});
