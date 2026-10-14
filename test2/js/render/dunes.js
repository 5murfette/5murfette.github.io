/* render/dunes.js — the far dunes of a desert (Step D2, seam rebuilt in D4; Three.js specific).
 * A dry world (W.dry: the 3D desert) has no sea; yellow dunes run to the horizon. Two meshes, shown only on dry worlds:
 *   - BACKDROP: one tensor-product grid centred on the map, heights from SS.worldgen.far_height (the sim's analytic
 *     dunes: worms, bodies and shots beyond the border stand on what is drawn, world.js W.sample -> W.far). Spacing:
 *     the lattice's 0.5 m over the lattice and FINE m beyond the border, then growing xGROW to ~450 m. The lattice
 *     interior is not in the index buffer (the real terrain is drawn there); only a BAND of cells inside the border
 *     is, so the grid closes the strip the terrain mesh leaves open (surface nets has no quads on the border nodes:
 *     the mesh ends at the border cells' vertices, ~0.25 m inside; through that open end one saw the floor and the
 *     terrain's back faces as a dark crawling line on every dune crest = the D4 flicker).
 *     D6 (user: "everything should be a circle"): the lattice terrain is drawn only inside the disc C.DRY.LAT_R
 *     (terrain.js uLatR discard); the grid covers everything beyond it: cells with a node beyond LAT_R - RING are in
 *     the index buffer, every node there is far_height (= the lattice's frozen raw ring, worldgen / world.js
 *     freeze_beyond: it never changes, so no updates after edits), sunk SINK_M per metre inside LAT_R, and fragments
 *     inside LAT_R - OVERLAP are discarded. In the OVERLAP the grid lies just under the terrain (1-pixel polygon
 *     offset too), so the terrain covers it there and no crack can open on the circle.
 *     Drawn behind slice zero; in front of it only while inspecting (faint), so it never hides the slab.
 *   - (the D2 CURTAIN, the cut face beyond the lattice, is gone since D5: the terrain cap draws the whole section,
 *     beyond the lattice from a 1D strip of the far layering, render/terrain.js; the curtain z-fought the cap in the
 *     metre past the border and had its own layering / scale / lighting)
 *   - FLOOR: a dark plane at y 0.3 under it all (a line of sight under the ground through a cave stays dark).
 * Shading = the terrain's sand (same triplanar textures, detail layer, noise tint, wetness, hot-sand tint) and the
 * terrain's shadow rule (receive / cast only within the slab, -uBack <= t <= 0), so nothing changes at the border.
 * The 2D desert (a cropped slab: W.flat, W.dry cleared) has no sea either, so it must not get the wet worlds' ocean
 * round its mesas. Mode 'slab' draws the SAME dunes (one function: SS.worldgen.far_height / dune_height, valid in the
 * slab's frame) as a scenery backdrop BEHIND the slab, never terrain the sim knows. What the sim does there decides
 * what is drawn: beyond the slab's ends and behind it the world is air (W.sample -3), and anything that falls below y =
 * SEA ends on the phantom sea level at y = W.SEA (-1: a body floats there, a crate / shot is removed, a worm drowns).
 * So the backdrop is a sand plain AT that level (flat under the slab and at its plane, where the cut face ends), rising
 * into the 3D desert's own dunes over 60 m behind the slab's back face: the ground those things land on, never a floor
 * above it, never a drop below it. Below y = 0 inside the slab the sim is solid (bedrock): the cut face shows rock
 * there (terrain.js cap); the cap below the plain beyond the ends is bedrock too. Own grid (small: x +-FAR_EXT at 1 m
 * near the slab, z from the plane back to FAR_EXT), no floor plane, no shadows, the same shader (kind 3) with the
 * dissolve centred on the slab. The hot-sand tint stays off (uPlayR 0): the circle is a 3D rule. Porting: two static
 * meshes + one dynamic strip; the clip rules are a material keyword like the terrain's. */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math, C = SS.CFG;
  const DV = SS.dunesView = {};
  const SLOT_SAND = C.MAT.SAND - 1;
  const FINE = 12;            // m beyond the border at the lattice's 0.5 m spacing (worms land and walk there)
  const GROW = 1.06;          // spacing growth per step beyond FINE, out to FAR_EXT
  const RING = 2.5;           // m inside the disc LAT_R whose cells are in the index buffer (D6)
  const OVERLAP = 0.5;        // m inside LAT_R drawn by both the grid (under) and the terrain (D6)
  const SINK_M = 0.1;         // m per metre inside LAT_R: the grid sinks under the terrain there
  const FAR_EXT = 450;        // m from the map centre (fades into the sky from 330 m, square metric)
  const SLAB_FINE = 64;       // m: the slab backdrop's 1 m spacing reaches this far from the slab, then GROW
  const SLAB_NEAR = 330;       // m from the slab's centre (square metric): beyond it the backdrop dissolves into the sky
  const SLAB_FRONT = 3;       // m in front of the plane that the slab backdrop's grid reaches (the section rule clips it at the plane)
  // m behind the slab's back face over which the sea-level plain rises into the 3D desert's own dunes (dune_height)
  let slabRamp = 60;
  let scene, U, mat, floorMat, depthMat, grid = null, floor = null, ax = null, NA = 0, on = false;
  let hRaw = null;            // unsunk grid heights (normals)
  // 'disc' (the 3D desert) | 'slab' (the 2D desert's backdrop) | null
  let mode = null, matS = null, matN = null, gridS = null, axS = null, azS = null, NAx = 0, NAz = 0;
  const own = { uInsp: { value: 0 }, uDbg: { value: 0 }, uCtr: { value: new T.Vector2(48, 48) } };
  // uDbg (tools): 1 = backdrop back faces magenta, 2 = all backdrop, 3 = the part inside the lattice, 4 = the floor +
  // all back faces (crack probe, tools/dev/d4/seam.cjs)

  /* grid axis: the lattice nodes (0.5 m, 193 values), FINE m more at 0.5 m outward, then steps growing xGROW */
  function axis() {
    const out = [], ext = [], NL = SS.world.NX;
    for (let s = 0.5, p = 96, q = 0; p - 48 < FAR_EXT; q++) {
      p += s;
      if (q >= FINE * 2 - 1) s *= GROW;
      ext.push(p);
    }
    for (let i = ext.length - 1; i >= 0; i--) out.push(96 - ext[i]);
    for (let i = 0; i < NL; i++) out.push(i * 0.5);
    for (const p of ext) out.push(p);
    return { a: new Float32Array(out), n0: ext.length, NL };
  }
  /* the slab backdrop's axes: offsets from the slab's centre line, 1 m up to SLAB_FINE, then growing by GROW out to
   * FAR_EXT. x: symmetric about the map centre; z: from SLAB_FRONT m in front of the plane back to FAR_EXT m behind it
   * (ascending) */
  function offsets() {
    const o = [];
    for (let s = 1, p = 0; p < FAR_EXT; ) {
      p += s;
      if (p > SLAB_FINE) s *= GROW;
      o.push(p);
    }
    return o;
  }
  function axisSlab() {
    const W = SS.world, o = offsets(), x = [], z = [];
    for (let i = o.length - 1; i >= 0; i--) x.push(W.MX - o[i]);
    x.push(W.MX);
    for (const p of o) x.push(W.MX + p);
    for (let i = o.length - 1; i >= 0; i--) z.push(W.MZ - o[i]);
    for (let p = 0; p <= SLAB_FRONT; p++) z.push(W.MZ + p);
    return { x: new Float32Array(x), z: new Float32Array(z) };
  }

  const VERT = /* glsl */`
    varying vec3 vW;
    varying vec3 vWN;
`;
  /* the terrain's material sampling for one slot (terrain.js triA / triAT): triplanar weights pow(|n|, 4), a second
   * offset layer blended by noise on high quality. Side projections with < 0.4 % weight are skipped (gentle dunes). */
  const TRI = /* glsl */`
    vec3 triS(vec3 p, vec3 w, float sc, float L){
      vec3 c = texture(tMats, vec3(p.xz * sc, L)).rgb * w.y;
      float s = w.y;
      if (w.x > 0.004) {
        c += texture(tMats, vec3(p.zy * sc, L)).rgb * w.x;
        s += w.x;
      }
      if (w.z > 0.004) {
        c += texture(tMats, vec3(p.xy * sc, L)).rgb * w.z;
        s += w.z;
      }
      return c / s;
    }
    vec3 triST(vec3 p, vec3 w, float sc, float L){
      vec3 a = triS(p, w, sc, L);
      if (uDetail < 0.5) return a;
      float n = texture(tNoise, p.xz * 0.011 + p.y * 0.004).a;
      return mix(a, triS(p * 0.61 + vec3(13.1, 7.7, 3.3), w, sc * 0.83, L), smoothstep(0.38, 0.62, n));
    }`;
  /* the 2D backdrop's sampler (kind 3): the dunes fill half of the picture and nearly all of it lies far away, so the
   * second, noise-blended offset layer (it only breaks up the tiling near the camera: 3 more texture fetches and a
   * noise fetch per pixel) fades out between 60 and 140 m and is not sampled beyond */
  const TRI3 = TRI.replace(
    'if (uDetail < 0.5) return a;',
    'float kd = 1.0 - smoothstep(60.0, 140.0, distance(vW, cameraPosition)); if (uDetail < 0.5 || kd < 0.01) return a;'
  )
    .replace('smoothstep(0.38, 0.62, n));', 'smoothstep(0.38, 0.62, n) * kd);');
  const v3 = v => /* glsl */`vec3(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;
  /* the slab backdrop's clip blocks: the slab is no lattice disc (no inside / overlap), the dissolve into the
   * sky is centred on the slab; the section rule (render/section.js) clips what lies in front of the plane.
   * Kind 3 is the far band of the grid (beyond SLAB_NEAR from the slab's centre), where the ground dissolves
   * into the sky by alpha. Kind 4 is everything nearer: opaque, so it needs no blending (a ground that covers
   * half of the picture is cheaper without it) and no dissolve: SLAB_NEAR is where the dissolve starts */
  const CLIP3 = /* glsl */`#include <clipping_planes_fragment>
          float tD = dot(vW - uO, uN), aV = 1.0;
          bool inside = false, inSlab = false;
          if (tD > 0.0) aV = uInsp;
          aV *= 1.0 - smoothstep(${SLAB_NEAR.toFixed(1)}, 445.0, max(abs(vW.x - uCtr.x), abs(vW.z - uCtr.y)));`;
  const CLIP4 = /* glsl */`#include <clipping_planes_fragment>
          float tD = dot(vW - uO, uN), aV = 1.0;
          bool inside = false, inSlab = false;
          if (tD > 0.0) aV = uInsp;
          if (aV < 0.5) discard;`;
  /* kind: 0 backdrop (3D desert), 2 floor; the 2D desert's backdrop: 3 far band (alpha), 4 the rest (opaque) */
  function material(kind) {
    // both sides: seen from below (through a cave or an arch cut by the slab) the backdrop's underside reads as dark
    // rock interior, like the slab's own back faces, instead of opening onto the sky
    const m = new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0, transparent: true, depthWrite: true, side: T.DoubleSide });
    m.userData.sectionMargin = 0;
    if (kind === 4) m.transparent = false;
    // the grid loses ties with the real terrain (the band lies just under it): one pixel's worth of depth slope
    if (kind === 0) {
      m.polygonOffset = true;
      m.polygonOffsetFactor = 1;
      m.polygonOffsetUnits = 2;
    }
    const PS = U.uMatP.value[SLOT_SAND],
      scS = PS.x.toFixed(4),
      roughS = PS.y.toFixed(3),
      poro = PS.w.toFixed(3),
      tS = v3(U.uMatTint.value[SLOT_SAND]);
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, {
        tMats: U.tMats,
        tNoise: U.tNoise,
        uO: U.uO,
        uN: U.uN,
        uBack: U.uBack,
        uTime: U.uTime,
        uPlayR: U.uPlayR,
        uDetail: U.uDetail,
        uWet: U.uWet,
        uInsp: own.uInsp,
        uDbg: own.uDbg,
        uCtr: own.uCtr
      });
      sh.vertexShader = VERT + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vWN = normalize(mat3(modelMatrix) * objectNormal);`);
      sh.fragmentShader = (kind >= 3 ? 'uniform vec2 uCtr;' : '') + /* glsl */`
        uniform highp sampler2DArray tMats;
        uniform sampler2D tNoise;
        uniform vec3 uO, uN;
        uniform float uBack, uTime, uPlayR, uInsp, uDbg, uDetail, uWet;
        varying vec3 vW;
        varying vec3 vWN;
        ${SS.terrain.HOT_GLSL}
        ${kind >= 3 ? TRI3 : TRI}
      ` + sh.fragmentShader
        .replace(
          '#include <clipping_planes_fragment>',
          kind === 4 ? CLIP4 : kind === 3 ? CLIP3 : /* glsl */`#include <clipping_planes_fragment>
          float tD = dot(vW - uO, uN), aV = 1.0;
          float rC = distance(vW.xz, vec2(${C.DRY.CX.toFixed(1)}, ${C.DRY.CZ.toFixed(1)}));
          // (D6: the lattice disc)
          bool inside = rC < ${C.DRY.LAT_R.toFixed(2)};
          ${kind === 0 ? `if (rC < ${(C.DRY.LAT_R - OVERLAP).toFixed(2)}) discard;` : ''}
          bool inSlab = tD <= 0.05 && tD >= -uBack;          // the terrain's shadow rule: the slab receives, the context not
          // P118c: the overview (hold V) shows the whole map solid: the front dunes were a 55 % veil over the dark
          // floor plane (brown stripes across the desert)
          if (tD > 0.0) aV = uInsp;
          aV *= 1.0 - smoothstep(330.0, 445.0, max(abs(vW.x - 48.0), abs(vW.z - 48.0)));   // the grid's square edge dissolves into the sky`
        )
        .replace('#include <map_fragment>', /* glsl */`
          vec3 nW = normalize(vWN);
          float nz = texture(tNoise, vW.xz * 0.05 + vW.y * 0.02).g, rough = ${roughS};
          // dune sand only (D4: no rock beyond the play area), sampled exactly like the terrain's sand
          vec3 bw = pow(abs(nW), vec3(4.0));
          bw /= (bw.x + bw.y + bw.z);
          vec3 col = triST(vW, bw, ${scS}, ${SLOT_SAND}.0) * ${tS};
          // the floor never shows the heat line
          float up = ${kind === 2 ? '0.0' : 'nW.y'};
          col *= mix(vec3(0.94, 0.9, 0.86), vec3(1.07, 1.03, 0.97), nz);
          float wet = uWet * (0.25 + 0.75 * smoothstep(-0.3, 0.6, up));   // rain: as the terrain's porous sand
          col *= 1.0 - wet * ${poro} * 0.42; rough = mix(rough, 0.18 + 0.3 * (1.0 - ${poro}), wet);
          if (!gl_FrontFacing${kind === 2 ? ' || true' : ''}) col = texture(tMats, vec3(vW.xz * 0.1 + vW.y * 0.07, 14.0)).rgb * 0.35;
          vec3 hotE = vec3(0.0);
          col = hotSand(col, vW, up, hotE);
          if ((uDbg > 2.5 && uDbg < 3.5 && inside) || (uDbg > 1.5 && uDbg < 2.5) || (uDbg > 0.5 && uDbg < 1.5 && !gl_FrontFacing)
              || (uDbg > 3.5 && (${kind === 2 ? 'true' : 'false'} || !gl_FrontFacing))) {
              col = vec3(0.0);
              hotE = vec3(4.0, 0.0, 4.0);
            }
          diffuseColor.rgb = col; diffuseColor.a = aV;`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = rough;')
        // shadows only within the slab, like the terrain (a local stands in for the receiveShadow uniform)
        .replace(
          '#include <lights_fragment_begin>',
          'bool rcvS = receiveShadow && inSlab;\n#define receiveShadow rcvS\n#include <lights_fragment_begin>'
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += hotE;');
    };
    m.customProgramCacheKey = () => 'dunes' + kind;
    return m;
  }
  /* shadow pass for the grid: the terrain's slab clip (only the part within the slab casts) */
  function depthMaterial() {
    const m = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, side: T.DoubleSide });
    m.userData.sectionMargin = 0;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { uO: U.uO, uN: U.uN, uBack: U.uBack });
      sh.vertexShader = 'varying vec3 vW;\n'
        + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = 'uniform vec3 uO, uN; uniform float uBack; varying vec3 vW;\n'
        + sh.fragmentShader.replace('#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\n float tD = dot(vW - uO, uN); if (tD < -uBack) discard;' +
            /* glsl */
            ` if (distance(vW.xz, vec2(${C.DRY.CX.toFixed(1)}, ${C.DRY.CZ.toFixed(1)})) < ${(C.DRY.LAT_R - OVERLAP).toFixed(2)})
            discard;`);
    };
    m.customProgramCacheKey = () => 'dunesdepth2';
    return m;
  }

  DV.init = function (sc) {
    scene = sc; U = SS.terrain.uniforms;
    mat = material(0); floorMat = material(2); depthMat = depthMaterial();
    const A = axis();
    ax = A.a;
    NA = ax.length;
    const N = NA * NA, pos = new Float32Array(N * 3), nrm = new Float32Array(N * 3);
    hRaw = new Float32Array(N);
    for (let k = 0; k < NA; k++)
      for (let i = 0; i < NA; i++) {
        const o = (k * NA + i) * 3;
        pos[o] = ax[i];
        pos[o + 2] = ax[k];
        nrm[o + 1] = 1;
      }
    // cells: everything except the disc's interior (all four nodes closer than LAT_R - RING to the centre, D6)
    const D = C.DRY, rIn = D.LAT_R - RING, rr = (i, k) => Math.hypot(ax[i] - D.CX, ax[k] - D.CZ);
    const skip = (i, k) => rr(i, k) < rIn && rr(i + 1, k) < rIn && rr(i, k + 1) < rIn && rr(i + 1, k + 1) < rIn;
    let nc = 0;
    for (let k = 0; k < NA - 1; k++)
      for (let i = 0; i < NA - 1; i++)
        if (!skip(i, k)) nc++;
    const idx = new Uint32Array(nc * 6);
    let q = 0;
    for (let k = 0; k < NA - 1; k++)
      for (let i = 0; i < NA - 1; i++) {
        if (skip(i, k)) continue;
        const a = k * NA + i, b = a + 1, c = a + NA, d = c + 1;
        idx[q++] = a;
        idx[q++] = c;
        idx[q++] = b;
        idx[q++] = b;
        idx[q++] = c;
        idx[q++] = d;
      }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    g.setIndex(new T.BufferAttribute(idx, 1));
    grid = new T.Mesh(g, mat);
    grid.renderOrder = 3.5;
    grid.frustumCulled = false;
    grid.visible = false;
    grid.castShadow = true; grid.receiveShadow = true; grid.customDepthMaterial = depthMat;
    scene.add(grid);
    floor = new T.Mesh(new T.PlaneGeometry(900, 900), floorMat); floor.rotation.x = -Math.PI / 2; floor.position.set(48, 0.3, 48);
    floor.renderOrder = 3.4;
    floor.frustumCulled = false;
    floor.visible = false;
    scene.add(floor);
  };

  /* heights (D6): far_height on every node from LAT_R - RING - 0.5 outward (inside the disc it equals the lattice's
   * frozen raw ring), sunk SINK_M per metre inside LAT_R; nodes deeper in are never drawn and stay at 0. Normals from
   * the unsunk heights. Built once per map: nothing the grid draws can change (the ring beyond EDIT_R is frozen). */
  function fillHeights() {
    const p = grid.geometry.attributes.position.array, G = SS.worldgen, D = C.DRY, rIn = D.LAT_R - RING - 0.5;
    for (let k = 0; k < NA; k++)
      for (let i = 0; i < NA; i++) {
        const v = k * NA + i, r = Math.hypot(ax[i] - D.CX, ax[k] - D.CZ);
        if (r < rIn) {
          hRaw[v] = 0;
          p[v * 3 + 1] = 0;
          continue;
        }
        const h = G.far_height(ax[i], ax[k]);
        hRaw[v] = h; p[v * 3 + 1] = h - (r < D.LAT_R ? (D.LAT_R - r) * SINK_M : 0);
      }
    // normals from central differences on the non-uniform grid
    const nr = grid.geometry.attributes.normal.array;
    for (let k = 0; k < NA; k++)
      for (let i = 0; i < NA; i++) {
        const il = Math.max(0, i - 1), ir = Math.min(NA - 1, i + 1), kl = Math.max(0, k - 1), kr = Math.min(NA - 1, k + 1);
        const hx = (hRaw[k * NA + ir] - hRaw[k * NA + il]) / (ax[ir] - ax[il]);
        const hz = (hRaw[kr * NA + i] - hRaw[kl * NA + i]) / (ax[kr] - ax[kl]);
        const l = Math.hypot(hx, 1, hz), o = (k * NA + i) * 3;
        nr[o] = -hx / l; nr[o + 1] = 1 / l; nr[o + 2] = -hz / l;
      }
    grid.geometry.attributes.position.needsUpdate = true; grid.geometry.attributes.normal.needsUpdate = true;
  }

  /* the 2D desert's backdrop: a small grid behind the slab, built once (the heights follow the map's seed in
   * fillHeightsSlab). Every cell is drawn (the part under the slab lies 0 .. 11 m under it, behind the cut face); no
   * shadows, no floor plane. */
  function buildSlab() {
    matS = material(3);
    matN = material(4);
    const A = axisSlab(), W = SS.world;
    axS = A.x;
    azS = A.z;
    NAx = axS.length;
    NAz = azS.length;
    const N = NAx * NAz, pos = new Float32Array(N * 3), nrm = new Float32Array(N * 3), idx = new Uint32Array((NAx - 1) * (NAz - 1) * 6);
    for (let k = 0; k < NAz; k++)
      for (let i = 0; i < NAx; i++) {
        const o = (k * NAx + i) * 3;
        pos[o] = axS[i];
        pos[o + 2] = azS[k];
        nrm[o + 1] = 1;
      }
    // the cells whose corners all lie within SLAB_NEAR of the slab's centre come first (group 0, opaque), the rest
    // (group 1) is the far band that dissolves into the sky
    const metric = (i, k) => Math.max(Math.abs(axS[i] - W.MX), Math.abs(azS[k] - W.MZ));
    const near = (i, k) => Math.max(metric(i, k), metric(i + 1, k), metric(i, k + 1), metric(i + 1, k + 1)) <= SLAB_NEAR;
    let q = 0, nNear = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < NAz - 1; k++)
        for (let i = 0; i < NAx - 1; i++) {
          if (near(i, k) !== (pass === 0)) continue;
          const a = k * NAx + i, b = a + 1, c = a + NAx, d = c + 1;
          idx[q++] = a;
          idx[q++] = c;
          idx[q++] = b;
          idx[q++] = b;
          idx[q++] = c;
          idx[q++] = d;
        }
      if (pass === 0) nNear = q;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    g.setIndex(new T.BufferAttribute(idx, 1));
    g.addGroup(0, nNear, 0);
    g.addGroup(nNear, q - nNear, 1);
    gridS = new T.Mesh(g, [matN, matS]);
    gridS.renderOrder = 3.5;
    gridS.frustumCulled = false;
    gridS.visible = false;
    gridS.castShadow = false;
    gridS.receiveShadow = false;
    scene.add(gridS);
  }
  /* the slab backdrop's height at (x, z): the sand plain at the sea level (W.SEA: where whatever falls off the
   * slab ends) under the slab, at its plane and in front of it; the 3D desert's own dunes (dune_height =
   * far_height without the play area's mesas: the sand shader cannot draw a mesa, the slab's own are the sim's)
   * slabRamp m behind the slab's back face; a smooth blend between */
  function slabHeight(G, W, x, z) {
    const t = M.smooth(M.clamp(((W.MZ - W.SZ * 0.5) - z) / slabRamp, 0, 1));
    return t > 0 ? W.SEA + (G.dune_height(x, z) - W.SEA) * t : W.SEA;
  }
  function fillHeightsSlab() {
    const g = gridS.geometry,
      p = g.attributes.position.array,
      nr = g.attributes.normal.array,
      G = SS.worldgen,
      W = SS.world,
      h = new Float32Array(NAx * NAz);
    for (let k = 0; k < NAz; k++)
      for (let i = 0; i < NAx; i++) {
        const v = k * NAx + i;
        h[v] = slabHeight(G, W, axS[i], azS[k]);
        p[v * 3 + 1] = h[v];
      }
    for (let k = 0; k < NAz; k++)
      for (let i = 0; i < NAx; i++) {
        const il = Math.max(0, i - 1), ir = Math.min(NAx - 1, i + 1), kl = Math.max(0, k - 1), kr = Math.min(NAz - 1, k + 1);
        const hx = (h[k * NAx + ir] - h[k * NAx + il]) / (axS[ir] - axS[il]);
        const hz = (h[kr * NAx + i] - h[kl * NAx + i]) / (azS[kr] - azS[kl]);
        const l = Math.hypot(hx, 1, hz), o = (k * NAx + i) * 3;
        nr[o] = -hx / l; nr[o + 1] = 1 / l; nr[o + 2] = -hz / l;
      }
    g.attributes.position.needsUpdate = true; g.attributes.normal.needsUpdate = true;
    own.uCtr.value.set(W.MX, W.MZ);
  }

  /* new map: build or hide. 'disc' = the 3D desert (W.dry), 'slab' = its 2D slab (the dune function is valid there,
   * worldgen far_on) */
  DV.reset = function (S, view) {
    const W = SS.world, G = SS.worldgen;
    mode = G.far_height && G.far_on && G.far_on() ? (W.dry ? 'disc' : W.flat ? 'slab' : null) : null;
    on = mode !== null;
    grid.visible = floor.visible = mode === 'disc';
    if (mode === 'slab' && !gridS) buildSlab();
    if (gridS) gridS.visible = mode === 'slab';
    U.uPlayR.value = mode === 'disc' ? S.playR : 0;
    if (!on) return;
    const t0 = performance.now();
    if (mode === 'disc') fillHeights();
    else fillHeightsSlab();
    DV.buildMs = performance.now() - t0;
  };
  DV.frame = function (S, view) {
    if (!on) return;
    if (mode === 'disc') U.uPlayR.value = S.playR;           // the hot-sand line follows the sudden-death shrink
    own.uInsp.value = view.insp || 0;
  };
  DV.meshes = () => (mode === 'slab' ? [gridS] : [grid, floor]);
  DV.mode = () => mode;
  // (tools: how far behind the slab the plain has become the 3D dunes)
  DV.ramp = r => {
    slabRamp = r;
    if (mode === 'slab') fillHeightsSlab();
  };
  DV.debug = v => { own.uDbg.value = v; };
  DV.stats = () => (
    mode === 'slab'
    ? { on, mode, verts: NAx * NAz, tris: gridS.geometry.index.count / 3, axis: NAx, buildMs: +(DV.buildMs || 0).toFixed(1) }
    : { on, mode, verts: NA * NA, tris: grid ? grid.geometry.index.count / 3 : 0, axis: NA, buildMs: +(DV.buildMs || 0).toFixed(1) }
  );
})(window.SS = window.SS || {});
