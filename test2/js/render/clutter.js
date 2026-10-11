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

  function mat(sway, flat, kill) {
    const m = new T.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, metalness: 0, side: sway ? T.DoubleSide : T.FrontSide, flatShading: !!flat });
    m.onBeforeCompile = sh => {
      const U = SS.terrain.uniforms;
      sh.uniforms.uO = U.uO; sh.uniforms.uN = U.uN; sh.uniforms.uBack = U.uBack; sh.uniforms.uTime = uTime; sh.uniforms.uWind = uWind;
      sh.uniforms.tCover = U.tCover || { value: null }; sh.uniforms.uNL = U.uNL || { value: 193 }; sh.uniforms.uSnowU = U.uSnow || { value: 0 }; sh.uniforms.uKill = { value: kill ? 1 : 0 };
      sh.vertexShader = sh.vertexShader
        .replace('void main() {', 'uniform vec3 uO; uniform vec3 uN; uniform float uBack, uTime, uNL, uSnowU, uKill; uniform vec3 uWind; uniform sampler2D tCover;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n { vec2 cv = texture2D(tCover, (instanceMatrix[3].xz * 2.0 + 0.5) / uNL).rg * 0.4; float sn = max(uSnowU, max(cv.x / 0.05, cv.y / 0.03)); transformed *= mix(1.0, 1.0 - smoothstep(0.35, 0.7, sn), uKill); }\n' + (sway ? `
          { float ph = instanceMatrix[3].x * 3.1 + instanceMatrix[3].z * 2.3; float hh = transformed.y * transformed.y;
            transformed.x += (uWind.x * 0.5 + sin(uTime * 1.8 + ph) * 0.05) * hh * 4.0; transformed.z += (uWind.z * 0.5 + cos(uTime * 1.3 + ph) * 0.04) * hh * 4.0; }` : ''))
        .replace('#include <project_vertex>', `#include <project_vertex>
          { vec4 cw = instanceMatrix * vec4(transformed, 1.0); if (dot(cw.xz - uO.xz, uN.xz) < -uBack) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }`);
    };
    m.customProgramCacheKey = () => 'clutter' + (sway ? 's' : 'r') + (flat ? 'f' : 'g') + (kill ? 'k' : 'n');
    return m;
  }

  CL.init = function (sc, tx, quality) {
    scene = sc; Q = quality;
    if (!(Q.clutter > 0)) return;
    const sg = stoneGeo();
    geos = { stone: sg, snow: sg, twig: twigGeo(), tuft: tuftGeo(8, 0.45, 0.16), flower: flowerGeo(), scrub: scrubGeo() };
    mats = { stone: mat(false, true, true), snow: mat(false, true, false), twig: mat(false, false, true), tuft: mat(true, false, true), flower: mat(true, false, true), scrub: mat(true, false, true) };
  };

  /* dominant material of a triangle vertex (slot = matId - 1: mA bedrock rock soil sand, mB sandstone snow ice basalt, mC lava crust ash scree) */
  function domMat(d, v) {
    let best = 0, bw = 0;
    for (let s = 0; s < 4; s++) {
      const a = d.mA[v * 4 + s], b = d.mB[v * 4 + s], c = d.mC[v * 4 + s];
      if (a > bw) { bw = a; best = s + 1; } if (b > bw) { bw = b; best = s + 5; } if (c > bw) { bw = c; best = s + 9; }
    }
    const x = d.mD[v * 4] + d.mD[v * 4 + 1] + d.mD[v * 4 + 2] + d.mD[v * 4 + 3];
    return x > 20 ? 99 : best;
  }
  const MT = { BEDROCK: 1, ROCK: 2, SOIL: 3, SAND: 4, SANDSTONE: 5, SNOW: 6, ICE: 7, BASALT: 8, LAVA: 9, CRUST: 10, ASH: 11, SCREE: 12 };

  const qa = new T.Quaternion(), qb = new T.Quaternion(), up = new T.Vector3(0, 1, 0), nv = new T.Vector3(), pv = new T.Vector3(), sv = new T.Vector3(), m4 = new T.Matrix4(), cc = new T.Color();

  /* per biome: pebble / twig / plant densities per m2 (before the quality factor) */
  const BIO = {
    temperate: { stone: 1.1, twig: 0.4, tuft: 0.9, flower: 0.8, scrub: 0, snow: 0 },
    alpine: { stone: 0.7, twig: 0.15, tuft: 0.35, flower: 0.12, scrub: 0, snow: 0.8 },
    canyon: { stone: 1.2, twig: 0.25, tuft: 0.25, flower: 0.05, scrub: 0.35, snow: 0 },
    desert: { stone: 0.5, twig: 0.08, tuft: 0.1, flower: 0, scrub: 0.45, snow: 0 },
    volcanic: { stone: 1.4, twig: 0.1, tuft: 0.04, flower: 0, scrub: 0.05, snow: 0 }
  };
  const SC = SS.CFG.MATS;
  function matCol(m) { const c = SC[m] ? SC[m].rgb : 0x808080; return [(c >> 16 & 255) / 255, (c >> 8 & 255) / 255, (c & 255) / 255]; }

  CL.onChunk = function (ci, c) {
    let set = per.get(ci);
    if (set) { for (const im of set) { scene.remove(im); im.dispose(); } per.delete(ci); }
    if (!geos || !c || !c.data || !(Q.clutter > 0)) return;
    const S = CL.S, biome = (S && S.biome) || 'temperate', B = BIO[biome] || BIO.temperate, W = SS.world, d = c.data, P = d.pos, N = d.nrm, I = d.idx, D = d.depth;
    const dens = Q.clutter, sea = W.SEA, lists = { stone: [], snow: [], twig: [], tuft: [], flower: [], scrub: [] };
    let total = 0;
    const snowy = S && S.weather ? S.weather.snowCover || 0 : 0;
    for (let i = 0; i < I.length && total < MAXC; i += 3) {
      const a = I[i], b = I[i + 1], c2 = I[i + 2];
      if (N[a * 3 + 1] < 0.55 || N[b * 3 + 1] < 0.55 || N[c2 * 3 + 1] < 0.55) continue;
      if (D[a] > 0.3 || D[b] > 0.3 || D[c2] > 0.3) continue;
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      if (ay < sea + 0.25) continue;
      if (Math.abs(W.top_at(ax, az) - ay) > 0.7) continue;
      const mt = domMat(d, a);
      if (mt === 99 || mt === MT.LAVA || mt === MT.ICE || mt === MT.BEDROCK) continue;
      const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az, vx = P[c2 * 3] - ax, vy = P[c2 * 3 + 1] - ay, vz = P[c2 * 3 + 2] - az;
      const area = 0.5 * M.len3(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
      if (area < 1e-4) continue;
      const nx = (N[a * 3] + N[b * 3] + N[c2 * 3]) / 3, ny = (N[a * 3 + 1] + N[b * 3 + 1] + N[c2 * 3 + 1]) / 3, nz = (N[a * 3 + 2] + N[b * 3 + 2] + N[c2 * 3 + 2]) / 3;
      const qx = Math.floor(ax * 4) + 311, qy = Math.floor(ay * 4), qz = Math.floor(az * 4) - 97;
      const patch = M.hash3(Math.floor(ax / 2.5) + 40, 11, Math.floor(az / 2.5)), patch2 = M.hash3(Math.floor(ax / 4) - 8, 23, Math.floor(az / 4) + 5);
      const gr = SS.grass.cover(ax, az);
      const kinds = [];
      const isSoil = mt === MT.SOIL, isSand = mt === MT.SAND, isSnow = mt === MT.SNOW, isRock = mt === MT.ROCK || mt === MT.SANDSTONE || mt === MT.SCREE, isDark = mt === MT.BASALT || mt === MT.CRUST || mt === MT.ASH;
      if (isSnow) { kinds.push(['snow', B.snow * (0.4 + patch2), 1]); kinds.push(['stone', B.stone * 0.12, 0]); }
      else if (isSoil || isSand || isRock || isDark) kinds.push(['stone', B.stone * (0.3 + 1.4 * patch) * (isSand ? 0.45 : 1), 0]);
      if (isSoil && !snowy) { kinds.push(['twig', B.twig * (0.3 + patch2), 0]); if (gr > 0.2) { kinds.push(['tuft', B.tuft * gr * (0.4 + patch), 0]); kinds.push(['flower', B.flower * gr * patch * patch * 4.5, 0]); } }
      if (isSand && !snowy) { kinds.push(['scrub', B.scrub * (patch2 > 0.45 ? patch2 : 0.1) * 1.4, 0]); if (B.tuft > 0) kinds.push(['tuft', B.tuft * patch, 2]); }
      if (isRock && !snowy && B.scrub > 0) kinds.push(['scrub', B.scrub * 0.4 * patch2, 0]);
      if (isDark && B.scrub > 0) kinds.push(['scrub', B.scrub * patch2, 3]);
      for (let k = 0; k < kinds.length; k++) {
        const kd = kinds[k], kind = kd[0];
        let cnt = area * kd[1] * dens; const base = Math.floor(cnt);
        cnt = M.hash3(qx + k * 17, qy, qz) < cnt - base ? base + 1 : base;
        for (let q = 0; q < cnt && total < MAXC; q++) {
          let r1 = M.hash3(qx + q * 7 + k, qy + 3, qz + 1), r2 = M.hash3(qx + 2, qy + q * 13, qz + 2 + k);
          if (r1 + r2 > 1) { r1 = 1 - r1; r2 = 1 - r2; }
          const h3 = M.hash3(qx + q + k * 5, qy - q, qz + 5), h4 = M.hash3(qx - q, qy + k, qz + 9 + q), h5 = M.hash3(qx + 7 * q, qy + 5, qz - q);
          const x = ax + ux * r1 + vx * r2, y = ay + uy * r1 + vy * r2, z = az + uz * r1 + vz * r2;
          let sc, r, g, bl, sink = 0.3;
          if (kind === 'stone' || kind === 'snow') {
            if (kd[2] === 1) { sc = 0.18 + 0.3 * h3 * h3; r = 0.92; g = 0.96; bl = 1.0; sink = 0.45; }                 // snow chunk
            else {
              sc = 0.06 + 0.14 * h3 * h3 + (h5 > 0.94 ? 0.12 : 0);
              const mc = matCol(mt), k2 = 0.55 + 0.7 * h4;
              r = mc[0] * k2 + 0.08; g = mc[1] * k2 + 0.07; bl = mc[2] * k2 + 0.06;
              if (isDark) { r *= 0.8; g *= 0.8; bl *= 0.8; }
            }
          } else if (kind === 'twig') { sc = 0.7 + 0.8 * h3; r = 0.3 + 0.2 * h4; g = 0.21 + 0.13 * h4; bl = 0.12 + 0.08 * h4; sink = 0.0; }
          else if (kind === 'tuft') {
            sc = 0.6 + 0.9 * h3; sink = 0.02;
            if (kd[2] === 2) { r = 1.7; g = 1.1; bl = 0.6; } else { r = 0.85 + 0.35 * h4; g = 0.9 + 0.2 * h4; bl = 0.8 + 0.2 * h5; }
            if (biome === 'canyon' || biome === 'alpine') { r *= 1.1; g *= 0.95; bl *= 0.8; }
          } else if (kind === 'flower') {
            sc = 0.9 + 0.6 * h3; sink = 0.02;
            const pal = Math.floor(h4 * 5);
            if (pal === 0) { r = 1; g = 1; bl = 1; } else if (pal === 1) { r = 1; g = 0.9; bl = 0.35; } else if (pal === 2) { r = 1; g = 0.55; bl = 0.7; } else if (pal === 3) { r = 0.8; g = 0.62; bl = 1; } else { r = 1; g = 0.6; bl = 0.35; }
          } else { sc = 0.7 + 0.9 * h3; sink = 0.03; r = 0.85 + 0.2 * h4; g = 0.85 + 0.15 * h4; bl = 0.75; if (kd[2] === 3) { r *= 0.55; g *= 0.55; bl *= 0.55; } }
          lists[kind].push(x, y, z, nx, ny, nz, h5 * 6.283, sc, r, g, bl, sink);
          total++;
        }
      }
    }
    set = [];
    for (const kind in lists) {
      const L = lists[kind], n = L.length / 12;
      if (!n) continue;
      const im = new T.InstancedMesh(geos[kind], mats[kind], n), plant = kind === 'tuft' || kind === 'flower' || kind === 'scrub';
      for (let i = 0; i < n; i++) {
        const o = i * 12, ny = L[o + 4];
        nv.set(L[o + 3], ny, L[o + 5]).normalize();
        if (plant) nv.lerp(up, 0.65).normalize();
        qa.setFromUnitVectors(up, nv); qb.setFromAxisAngle(up, L[o + 6]); qa.multiply(qb);
        const sc = L[o + 7]; sv.set(sc, kind === 'stone' || kind === 'snow' ? sc * (0.7 + 0.5 * (L[o + 6] / 6.283)) : sc, sc);
        const dn = kind === 'stone' || kind === 'snow' ? -L[o + 11] * sc : -0.02;
        pv.set(L[o] + nv.x * dn, L[o + 1] + nv.y * dn, L[o + 2] + nv.z * dn);
        m4.compose(pv, qa, sv); im.setMatrixAt(i, m4);
        cc.setRGB(L[o + 8], L[o + 9], L[o + 10], T.SRGBColorSpace); im.setColorAt(i, cc);
      }
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.receiveShadow = true; im.castShadow = false; im.frustumCulled = false; im.userData.chunk = c;
      scene.add(im); set.push(im);
    }
    if (set.length) per.set(ci, set);
  };

  CL.count = () => { let n = 0; for (const s of per.values()) for (const im of s) n += im.count; return n; };

  CL.frame = function (S, view, wind) {
    CL.S = S;
    if (!geos) return;
    uTime.value = view.time;
    if (wind) uWind.value.set(wind.x, 0, wind.z);
    for (const s of per.values()) for (const im of s) { const c = im.userData.chunk; im.visible = !!(c && c.slab && c.slab.visible); }
  };
  CL.clear = function () { for (const s of per.values()) for (const im of s) { scene.remove(im); im.dispose(); } per.clear(); };
})(window.SS = window.SS || {});
