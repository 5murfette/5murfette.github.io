/* render/lava.js — open lava (the fluid layer S.lava of sim/lava.js) on screen (Three.js specific).
 *   - surface mesh: one vertex per wet lattice column (x, bed + h, z) plus a 1-column apron around the wet area whose
 *     vertices sit on the extrapolated lava level, clamped under the local ground (min(top - 4 cm, neighbour level)),
 *     so the shoreline is the exact intersection with the terrain mesh. Rebuilt on the CPU (compact, only wet columns)
 *     whenever the simulation steps (S.lava.ver), at most ~10 times per second;
 *   - shading is 100% procedural and self-lit: Voronoi crust plates with glowing cracks, advected by the simulated
 *     surface velocity (1.5 x the depth-mean, flow-map technique: two phase-shifted layers, each reset while
 *     invisible); crack width and colour follow the temperature T (black-body ramp), thin margins chill, the crater
 *     lake gets a visual convection drift (upwelling at the vent, plates spreading to the wall) and gas bubbles;
 *   - the same slice clip as the terrain: slab (-uBack <= t <= 0, opaque), far context (faded), near context
 *     (inspection only). The cut face at slice zero is drawn by the terrain cap from the data texture tLavaS
 *     (rgba = surface y, depth h, T, bed y per column).
 * Porting: the mesh build is plain arrays (engine mesh API); the shader = an unlit/emissive material. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const LW = SS.lavaView = {};
  const WET = 0.004;          // m: thinner lava is not drawn
  const LIFT = 0.015;         // m: keeps thin films above the smoothed terrain mesh
  const SURF = 1.5;           // surface speed / depth-mean speed (laminar viscous film)
  LW.vis = 1;                 // view-only speed multiplier for the surface pattern (1 = real speed)
  LW.lightI = 25;             // crater lake point light (candela)
  let scene, Q, U, geo, pos, nrm, dat, idx, posA, nrmA, datA, idxA, vid, meshes = [], tex, texData, light;
  let ver = -1, lastT = -9, box = null, nV = 0, nI = 0, ms = 0;
  const OWN = { uVis: { value: 1 }, uVent: { value: null } };   // uVent: vec4[3] (P25: up to 3 crater lakes)

  const FRAG = /* glsl */`
    uniform vec3 uO, uN, uHaze; uniform float uBack, uAlpha, uTime, uVis, uCtxSolid, uCtxHaze; uniform vec4 uVent[3]; uniform sampler2D tNoise;
    varying vec3 vW; varying vec4 vL;
    vec2 lh2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return fract(sin(p) * 43758.5453); }
    // Voronoi: x = distance to the nearest site, y = F2 - F1 (~ distance to the crack), z = cell id
    vec3 voro(vec2 x){
      vec2 n = floor(x), f = fract(x); float d1 = 8.0, d2 = 8.0, id = 0.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j)), o = lh2(n + g), r = g + 0.15 + o * 0.7 - f; float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; id = o.x; } else if (d < d2) d2 = d;
      }
      d1 = sqrt(d1); return vec3(d1, sqrt(d2) - d1, id);
    }
    // black-body-ish ramp sized for ACES: 0 dull red (~650 C) .. 1 orange-yellow (~1150 C)
    vec3 glow(float k){
      k = clamp(k, 0.0, 1.0);
      vec3 c0 = vec3(0.30, 0.02, 0.003), c1 = vec3(1.1, 0.13, 0.01), c2 = vec3(1.6, 0.42, 0.04), c3 = vec3(2.3, 0.9, 0.16);
      return k < 0.4 ? mix(c0, c1, k / 0.4) : k < 0.8 ? mix(c1, c2, (k - 0.4) / 0.4) : mix(c2, c3, (k - 0.8) / 0.2);
    }
    // one crust layer at pattern position q (moves with the lava): domain-warped Voronoi plates (1 / sc m) with seams
    // whose width varies along the crack. returns x = crack glow (0..1, 1 = crack centre), y = plate id, z = mottling,
    // w = relief (domed plates, seams sunk)
    vec4 crust(vec2 q, float sc, float cw){
      vec2 wp = (texture(tNoise, q * 0.05).rg - 0.5) * 1.5;
      vec3 a = voro((q + wp) * sc);
      cw *= 0.3 + 1.1 * texture(tNoise, q * 0.09 + 0.31).b;
      float ed = a.y;
    #ifndef LAVA_LOW
      ed += (texture(tNoise, q * 0.9 + 0.17).g - 0.5) * 0.07;                 // ragged seam edges
    #endif
      float aa = fwidth(ed) + 1e-4;
      float c = 1.0 - smoothstep(cw, cw + aa * 1.5, ed);
      float core = 1.0 - smoothstep(0.0, cw + aa, ed);
      float halo = exp(-max(ed - cw, 0.0) / 0.05) * 0.18;                      // hot plate edge next to the seam
      // LV2: plates barely domed (3.5 cm; 7 cm domes each carried one smooth highlight: hammered metal), the skin
      // wrinkled at ~5 cm ("elephant skin" of a chilled glassy rind)
      float mott = 0.0, rel = smoothstep(0.0, 0.4, ed) * 0.035;
    #ifndef LAVA_LOW
      mott = texture(tNoise, q * 0.6 + a.z * 7.0).g;
      rel += (texture(tNoise, q * 0.8 + a.z * 3.0).g - 0.5) * 0.03 + (texture(tNoise, q * 2.3 - a.z * 5.0).r - 0.5) * 0.008
           + (texture(tNoise, q * 5.3 + a.z * 11.0).b - 0.5) * 0.012;
    #endif
      return vec4(max(c * (0.55 + 0.45 * core), halo), a.z, mott, rel);
    }
    float bubbles(vec2 p, float t){
      vec2 g = p / 1.7, n = floor(g); float e = 0.0;
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 cc = n + vec2(float(i), float(j)), o = lh2(cc + 41.0);
        if (o.y < 0.45) continue;
        float per = 2.5 + 4.0 * o.x, ph = fract(t / per + o.y * 7.0);
        vec2 c = (cc + 0.2 + 0.6 * lh2(cc + 7.0)) * 1.7;
        float r = length(p - c), R = 0.5 * smoothstep(0.0, 0.85, ph);
        // a swelling dome tears the crust along a soft ring, then bursts (bright splash that fades)
        float ring = (1.0 - smoothstep(0.0, 0.18, abs(r - R))) * smoothstep(0.3, 0.7, ph) * (1.0 - smoothstep(0.82, 0.88, ph));
        float burst = (1.0 - smoothstep(R * 0.1, R + 0.15, r)) * smoothstep(0.84, 0.87, ph) * (1.0 - smoothstep(0.87, 1.0, ph));
        e += ring * 0.08 + burst * 1.0;
      }
      return e;
    }
    // emissive radiance of the lava surface; crustF = crust coverage (0..1), plate = plate id (albedo variation)
    vec3 lavaSurface(vec2 p, vec2 v, float Tm, float h, out float crustF, out float plate, out float relief){
      float heat = clamp((Tm - 0.12) / 0.88, 0.0, 1.0);
      // crater lake: a slow visual circulation (rigid rotation about the vent: no strain, so the pattern does not
      // stretch) fading out past the lake edge, an upwelling of open melt over the vent and gas bubbles
      vec4 VV = uVent[0]; for (int q = 1; q < 3; q++) if (uVent[q].w > 0.5 && distance(p, uVent[q].xy) < distance(p, VV.xy)) VV = uVent[q];   // the nearest crater
      vec2 dv = p - VV.xy; float rv = length(dv);
      float lake = VV.w * (1.0 - smoothstep(VV.z - 0.5, VV.z + 1.5, rv));
      v += vec2(-dv.y, dv.x) * 0.0032 * lake;
      // stretch limiter: the pattern moves by v * phase * P; where v changes fast in space (lake -> notch) that
      // would shear it into stripes, so cap |grad v| * P at 0.6 (a 2.7 m channel at 1.5 cm/s centre speed: ~0.45).
      // P is long: at real lava speeds the cross-fade to the next crack network is the most visible change
      const float P = 40.0;
      float gv = length(fwidth(v)) / max(length(fwidth(p)), 1e-4);
      v *= min(1.0, 0.6 / max(gv * P, 1e-4));
      float spd = length(v);
      // flow map: two layers displaced by v * phase, each reset while its weight is zero
      float ph0 = fract(uTime / P), ph1 = fract(uTime / P + 0.5);
      float w0 = smoothstep(0.0, 0.3, ph0) * (1.0 - smoothstep(0.7, 1.0, ph0));
      vec2 q0 = p - v * ph0 * P, q1 = p - v * ph1 * P + vec2(5.3, 2.9);
      // crack width: hot lava has wide incandescent seams; shear (speed) tears the crust; thin margins are chilled
      float cw = (0.006 + 0.022 * heat * heat + 0.8 * min(spd, 0.03) * heat) * smoothstep(0.0, 0.2, h);
      float up = lake * (1.0 - smoothstep(0.4, 1.4, rv));                     // upwelling: mostly open melt
      cw += up * 0.35;
      const float sc = 0.55;                    // ~1.8 m plates; constant: a varying scale multiplies the world coordinates
      vec4 c0 = crust(q0, sc, cw), c1 = crust(q1, sc, cw);
      vec4 c = mix(c1, c0, w0);
      plate = mix(c1.y, c0.y, w0); relief = c.w;
    #ifndef LAVA_LOW
      // LV2 pahoehoe ropes: folds of the plastic skin dragged by the melt below, crests ACROSS the flow (~15 cm apart,
      // arcs bent by noise), only where it moves; they ride with the crust layers like the plates
      vec2 fd = spd > 1e-4 ? v / spd : vec2(1.0, 0.0);
      float rp0 = sin(dot(q0, fd) * 42.0 + texture(tNoise, q0 * 0.21).r * 9.0), rp1 = sin(dot(q1, fd) * 42.0 + texture(tNoise, q1 * 0.21).r * 9.0);
      float fwq = length(fwidth(p));                                           // m per pixel (ropes 15 cm: fade < ~5 px)
      float patchR = smoothstep(0.5, 0.75, texture(tNoise, q0 * 0.13 + 0.61).g);   // in patches, not everywhere
      relief += mix(rp1, rp0, w0) * 0.003 * patchR * smoothstep(0.0005, 0.004, spd) * (1.0 - smoothstep(0.0, 0.3, c.x))
              * (1.0 - smoothstep(0.012, 0.03, fwq));
    #endif
      float crack = clamp(c.x, 0.0, 1.0);
      float bub = lake * bubbles(p, uTime) * heat;
      // thin crust over hot melt glows faintly (dull red) in patches; young plates (near seams/vent) more
      float skin = heat * heat * (0.003 + 0.012 * plate) * (0.4 + 1.2 * c.z) + up * 0.3;
      float open = clamp(crack + bub, 0.0, 1.0);
      crustF = 1.0 - open;
      // seams: orange edges, hotter yellow core
      vec3 e = glow(heat * (0.45 + 0.42 * crack * crack)) * (crack * 0.85 + bub * 0.7)
             + glow(heat * 0.45) * skin * (1.0 - open);
      return e;
    }
  `;

  /* mode 0 slab (opaque), 1 far context, 3 near context (inspection) */
  function material(mode) {
    const opts = { roughness: 0.8, metalness: 0, side: T.FrontSide };
    if (mode !== 0) Object.assign(opts, { transparent: true, depthWrite: false });
    const m = new T.MeshStandardMaterial(opts);
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { uO: U.uO, uN: U.uN, uHaze: U.uHaze, uBack: U.uBack, uAlpha: U.uAlpha, uTime: U.uTime, tNoise: U.tNoise, uCtxSolid: U.uCtxSolid, uCtxHaze: U.uCtxHaze }, OWN);
      sh.vertexShader = 'attribute vec4 aL; varying vec3 vW; varying vec4 vL;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vL = aL;`);
      const clip = mode === 0 ? 'if (tD > 0.0 || tD < -uBack) discard;' : mode === 3 ? 'if (tD < 0.0) discard;' : 'if (tD > -uBack) discard;';
      sh.fragmentShader = (Q.name === 'low' ? '#define LAVA_LOW 1\n' : '') + FRAG + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          float tD = dot(vW - uO, uN);
          ${clip}`)
        .replace('#include <map_fragment>', /* glsl */`
          float crustF, plate, relief;
          vec3 lEmis = lavaSurface(vW.xz, vL.zw * uVis, vL.y, vL.x, crustF, plate, relief);
          // crust: dark basalt skin (no albedo on the open melt). LV2: a chilled glassy rind is wrinkled rock, not a
          // mirror: roughness 0.65-0.9 over the relief normals below (was 0.32-0.75: plates reflected the sky like glass)
          vec3 lCol = vec3(0.017, 0.017, 0.019) * (0.7 + 0.6 * plate) * crustF;
          float lRough = mix(0.65, 0.9, plate);
          diffuseColor.rgb = lCol;
          ${mode === 0 ? '' : /* glsl */`
            float ad = ${mode === 1 ? '-tD - uBack' : 'tD'};
            float a = ${mode === 1 ? 'mix(uAlpha * mix(0.96, 0.42, smoothstep(0.0, 46.0, ad)), 1.0, uCtxSolid)' : 'uAlpha * 0.26 * exp(-ad / 12.0)'};
            diffuseColor.a = a;
            diffuseColor.rgb = mix(lCol, uHaze * 0.3, (0.12 + 0.4 * smoothstep(0.0, 50.0, ad)) * ${mode === 1 ? '(1.0 - uCtxSolid) + 0.5 * uCtxSolid * uCtxHaze' : '1.0'});
            lEmis *= 1.0 - 0.5 * smoothstep(0.0, 50.0, ad);`}
        `)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = lRough;')
        // relief bump (screen-space derivatives of the relief height)
        .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
          {
            vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
            float bx = dFdx(relief), by = dFdy(relief);
            vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx); float det = dot(dpx, r1);
            normal = normalize(abs(det) * normal - sign(det) * (bx * r1 + by * r2) * 1.0);
          }`)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += lEmis;');
    };
    m.customProgramCacheKey = () => 'lava' + mode + Q.name;
    return m;
  }

  LW.init = function (sc, textures, quality) {
    scene = sc; Q = quality; U = SS.terrain.uniforms;
    const W = SS.world, N = W.NX * W.NZ;
    OWN.uVent.value = [new T.Vector4(), new T.Vector4(), new T.Vector4()];
    // capacity: grows on demand (rebuild)
    alloc(4096, 8192);
    vid = new Int32Array(N).fill(-1);
    const mats = [material(0), material(1), material(3)];
    meshes = mats.map((m, q) => {
      const me = new T.Mesh(geo, m); me.frustumCulled = false; me.renderOrder = [1, 5.5, 7.5][q];
      if (q === 0) me.receiveShadow = true;
      scene.add(me); return me;
    });
    // per-column data for the terrain cap (cut face): r = surface y, g = h, b = T, a = bed y
    texData = new Float32Array(N * 4);
    tex = new T.DataTexture(texData, W.NX, W.NZ, T.RGBAFormat, T.FloatType);
    tex.minFilter = tex.magFilter = T.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    U.tLavaS.value = tex;
    // the lava lake lights the crater (always in the scene: adding a light later recompiles every material)
    light = new T.PointLight(0xff6a24, 0, 34, 2);
    scene.add(light);
  };
  function alloc(maxV, maxI) {
    if (geo) geo.dispose();
    pos = new Float32Array(maxV * 3); nrm = new Float32Array(maxV * 3); dat = new Float32Array(maxV * 4); idx = new Uint32Array(maxI);
    geo = new T.BufferGeometry();
    posA = new T.BufferAttribute(pos, 3); nrmA = new T.BufferAttribute(nrm, 3); datA = new T.BufferAttribute(dat, 4); idxA = new T.BufferAttribute(idx, 1);
    for (const a of [posA, nrmA, datA, idxA]) a.setUsage(T.DynamicDrawUsage);
    geo.setAttribute('position', posA); geo.setAttribute('normal', nrmA); geo.setAttribute('aL', datA); geo.setIndex(idxA);
    geo.setDrawRange(0, 0);
    for (const me of meshes) me.geometry = geo;
  }
  LW.reset = function (S) {
    ver = -1; lastT = -9;
    if (box) { clearBox(box); box = null; }
    const v = S.lava && S.lava.vent, F = SS.world.features || {}, vo = F.volcano;
    const vs = (S.lava && S.lava.vents) || [];
    for (let q = 0; q < 3; q++) { const o = vs[q]; if (o) OWN.uVent.value[q].set(o.x, o.z, o.Rc, 1); else OWN.uVent.value[q].set(-999, -999, 0, 0); }
    if (light) { light.position.set(v ? v.x : 0, v ? v.level + 5 : -50, v ? v.z : 0); light.userData.on = !!v; }
  };
  function clearBox(b) {
    const W = SS.world, NX = W.NX;
    for (let k = b.k0; k <= b.k1; k++) for (let i = b.i0; i <= b.i1; i++) { const c = k * NX + i; vid[c] = -1; texData.fill(0, c * 4, c * 4 + 4); }
  }

  /* CPU mesh build: wet columns + apron, normals from the surface heights, cap texture */
  function rebuild(S) {
    const t0 = performance.now();
    const W = SS.world, st = S.lava, NX = W.NX, NZ = W.NZ, H = W.H, h = st.h, Tt = st.T, top = W.top;
    if (box) clearBox(box);
    if (st.i1 < 0) { box = null; nV = nI = 0; geo.setDrawRange(0, 0); tex.needsUpdate = true; ms = performance.now() - t0; return; }
    const i0 = Math.max(0, st.i0 - 1), i1 = Math.min(NX - 1, st.i1 + 1), k0 = Math.max(0, st.k0 - 1), k1 = Math.min(NZ - 1, st.k1 + 1);
    box = { i0, i1, k0, k1 };
    // active columns = wet ones + their 8 neighbours (the apron); vid = -2 marks active before numbering
    if ((i1 - i0 + 1) * (k1 - k0 + 1) > pos.length / 3) { const nb = (i1 - i0 + 1) * (k1 - k0 + 1); alloc(nb + 64, nb * 6 + 64); }
    for (let k = k0; k <= k1; k++) for (let i = i0, c = k * NX + i0; i <= i1; i++, c++) {
      if (h[c] <= WET) continue;
      for (let dk = -1; dk <= 1; dk++) { const kk = k + dk; if (kk < k0 || kk > k1) continue; for (let di = -1; di <= 1; di++) { const ii = i + di; if (ii >= i0 && ii <= i1) vid[kk * NX + ii] = -2; } }
    }
    let n = 0;
    for (let k = k0; k <= k1; k++) for (let i = i0, c = k * NX + i0; i <= i1; i++, c++) {
      if (vid[c] !== -2) continue;
      let y, hh, tt, ux = 0, uz = 0;
      if (h[c] > WET) { hh = h[c]; y = top[c] + hh + LIFT; tt = Tt[c]; ux = st.ux[c]; uz = st.uz[c]; }
      else {
        let eta = -1e9, ts = 0, tw = 0;
        for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
          const ii = i + di, kk = k + dk; if (ii < 0 || ii >= NX || kk < 0 || kk >= NZ) continue;
          const cc = kk * NX + ii; if (h[cc] <= WET) continue;
          const e = top[cc] + h[cc] + LIFT; if (e > eta) eta = e; ts += Tt[cc]; tw++;
        }
        hh = 0; y = Math.min(top[c] - 0.04, eta); tt = ts / tw;
      }
      vid[c] = n;
      pos[n * 3] = i * H; pos[n * 3 + 1] = y; pos[n * 3 + 2] = k * H;
      dat[n * 4] = hh; dat[n * 4 + 1] = tt; dat[n * 4 + 2] = ux * SURF; dat[n * 4 + 3] = uz * SURF;
      texData[c * 4] = y; texData[c * 4 + 1] = hh; texData[c * 4 + 2] = tt; texData[c * 4 + 3] = top[c];
      n++;
    }
    // normals (central differences over drawn neighbours)
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
      const c = k * NX + i, v = vid[c]; if (v < 0) continue;
      const y = pos[v * 3 + 1];
      const yl = i > 0 && vid[c - 1] >= 0 ? pos[vid[c - 1] * 3 + 1] : y, yr = i < NX - 1 && vid[c + 1] >= 0 ? pos[vid[c + 1] * 3 + 1] : y;
      const yd = k > 0 && vid[c - NX] >= 0 ? pos[vid[c - NX] * 3 + 1] : y, yu = k < NZ - 1 && vid[c + NX] >= 0 ? pos[vid[c + NX] * 3 + 1] : y;
      const gx = (yr - yl) / (2 * H), gz = (yu - yd) / (2 * H), il = 1 / Math.sqrt(gx * gx + gz * gz + 1);
      nrm[v * 3] = -gx * il; nrm[v * 3 + 1] = il; nrm[v * 3 + 2] = -gz * il;
    }
    // quads with all 4 corners drawn and at least one wet corner (CCW seen from above)
    let m = 0;
    for (let k = k0; k < k1; k++) for (let i = i0; i < i1; i++) {
      const c = k * NX + i, a = vid[c], b = vid[c + 1], d = vid[c + NX], e = vid[c + NX + 1];
      if (a < 0 || b < 0 || d < 0 || e < 0) continue;
      if (h[c] <= WET && h[c + 1] <= WET && h[c + NX] <= WET && h[c + NX + 1] <= WET) continue;
      idx[m++] = a; idx[m++] = d; idx[m++] = b; idx[m++] = b; idx[m++] = d; idx[m++] = e;
    }
    nV = n; nI = m;
    for (const [A, s] of [[posA, 3], [nrmA, 3], [datA, 4], [idxA, 1]]) { A.clearUpdateRanges(); A.addUpdateRange(0, (A === idxA ? m : n) * s); A.needsUpdate = true; }
    geo.setDrawRange(0, m);
    tex.needsUpdate = true;
    ms = performance.now() - t0;
  }

  /* per frame */
  LW.frame = function (S, view) {
    if (!S.lava) { for (const me of meshes) me.visible = false; return; }
    if (S.lava.ver !== ver && view.time - lastT > 0.09) { rebuild(S); ver = S.lava.ver; lastT = view.time; }
    const draw = nI > 0, ctxA = view.ctxA || 0, insp = view.insp || 0;
    meshes[0].visible = draw;
    meshes[1].visible = draw && ctxA > 0.004 && U.uBack.value < 200;
    meshes[2].visible = draw && insp > 0.05 && Q.nearCtx;
    OWN.uVis.value = LW.vis;
    // lake light: flickers with the convection, off without a lake
    const on = light.userData.on && S.lava.vent;
    light.intensity = on ? LW.lightI * (0.9 + 0.06 * Math.sin(view.time * 1.7) + 0.04 * Math.sin(view.time * 4.3 + 1.1)) : 0;
  };
  LW.stats = () => ({ verts: nV, tris: nI / 3, ms: +ms.toFixed(2), ver });
})(window.SS = window.SS || {});
