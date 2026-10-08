/* render/trees.js — tree renderer (Three.js; presentation only, reads S.trees / S.veg).
 *
 * Geometry is built once per map in world space: tapered bark cylinders per segment (+ end caps), leaf clusters as
 * alpha-tested foliage cards on a sphere around a darker core clump (oak / juniper), radial pine sprays + a core cone
 * per tier (spruce). Live state goes through a small float texture (one row per tree, texelFetch in the vertex
 * shader): texel 0..31 = segment on/off, 32..46 = leaf fraction left per cluster, 47 = tree (alive, char, fire
 * intensity, sway phase). Broken parts collapse to a point, stripped crowns lose cards and shrink, the wind bends
 * trees from the root (h^2), charred wood darkens and glows in its cracks while burning, leaves wilt and glow.
 * Clipping follows the terrain: nothing in front of slice zero in play (inspection ghosts it), the slab is solid,
 * the context behind it fades with the terrain's context alpha (screen-door dither: no sorting). Shadows use a
 * matching depth material. Fire: flame billboards on burning crowns / trunks (SS.bodyView pool) and an instanced
 * procedural flame field on burning grass cells (S.veg). Logs (broken parts, render/bodies.js) use logGroup().
 * API: init(scene, tx, Q), frame(S, view), logGroup(log) -> {group, meshes}, stats().
 */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, M = SS.math;
  const TV = SS.treeView = {};
  const ROW = 49, LEAF0 = 32, TREE_T = 47, ROOT_T = 48;
  const CTX_M = 0.3;   // a tree whose root is more than this behind the slab belongs to the context (ghost); else it is drawn whole
  const SPN = ['oak', 'spruce', 'juniper', 'snag'];
  // per species: bark tint, leaf tint (multiplies the card texture), core colour
  const LOOK = {
    oak: { bark: [0.5, 0.44, 0.38], leaf: [0.95, 1.0, 0.85], core: [0.05, 0.09, 0.03] },
    spruce: { bark: [0.55, 0.4, 0.32], leaf: [0.85, 1.0, 0.9], core: [0.035, 0.08, 0.05] },
    juniper: { bark: [0.7, 0.62, 0.55], leaf: [0.78, 0.86, 0.7], core: [0.05, 0.07, 0.04] },
    snag: { bark: [1.05, 0.98, 0.9], leaf: [1, 1, 1], core: [0.05, 0.05, 0.05] }
  };
  let scene = null, tx = null, Q = null, U = null, own = null;
  let woodMat, leafMat, coreMat, woodMats, leafMats, coreMats, woodDepth, leafDepth, coreDepth, meshes = [];
  let stTex = null, stData = null, builtFor = null, nRows = 0, fire = null, fireSeed = null, maxFire = 0, fireN = 0;
  const flames = new Map();
  let time = 0, tris = 0, lastSig = '', lastBoom = null;

  /* ---------- shaders ---------- */
  const VHEAD = /* glsl */`
    uniform highp sampler2D tState; uniform float uTime; uniform vec3 uWind, uO, uN;
    attribute vec4 aInfo; attribute vec3 aCen;
    varying vec3 vTW; varying vec4 vTr; varying float vLeafF; varying float vCut; varying float vRootT; varying vec3 vCenT; varying float vRoot;
    vec3 treeXform(vec3 p) {
      vCenT = aCen; vRoot = 0.0;
    #ifdef LOG
      vTr = vec4(1.0, aInfo.x, 0.0, 0.0); vLeafF = 1.0; vCut = step(0.95, fract(aInfo.w * 64.0)); vRootT = 0.0;
      return p;
    #else
      int row = int(aInfo.x + 0.5), part = int(aInfo.y + 0.5);
      vec4 pt = texelFetch(tState, ivec2(part, row), 0);
      vec4 tr = texelFetch(tState, ivec2(${TREE_T}, row), 0);
      vTr = tr;
      vec4 rt = texelFetch(tState, ivec2(${ROOT_T}, row), 0);
      vRootT = dot(vec2(rt.x - uO.x, rt.y - uO.z), uN.xz);    // root distance from slice zero: picks slab vs context for the whole tree
      bool leaf = part >= ${LEAF0};
      float f = pt.r;
      // a card disappears once the cluster has lost more than its share of leaves (seed = fract part of aInfo.w)
      float seed = fract(aInfo.w * 64.0);
      float keep = tr.r * (leaf ? step(0.02, f) * step(seed, f + 0.02) : step(0.5, f));
      vLeafF = leaf ? f : 1.0; vCut = leaf ? 0.0 : step(0.95, seed) * step(0.5, pt.g);   // cap of a segment whose child broke off
      vRoot = leaf ? 0.0 : step(0.55, seed) * step(seed, 0.65);                           // T3: root tubes (seed 0.6)
      if (leaf) p = aCen + (p - aCen) * (0.55 + 0.45 * sqrt(clamp(f, 0.0, 1.0)));
      float h = floor(aInfo.w * 64.0) / 63.0;         // height fraction above the root (0..1), packed in aInfo.w
      float g = 0.65 + 0.35 * sin(uTime * 0.83 + tr.a * 6.28) * sin(uTime * 0.31 + tr.a * 3.7);
      vec2 sw = uWind.xz * 0.014 * g * h * h + vec2(sin(uTime * 1.25 + tr.a * 9.0), cos(uTime * 1.05 + tr.a * 7.0)) * 0.03 * h * h;
      p.xz += sw * (1.0 - 0.75 * tr.g);
      if (leaf) p += vec3(sin(uTime * 4.7 + p.y * 2.7 + seed * 30.0), 0.0, cos(uTime * 4.1 + p.x * 2.9)) * 0.022 * (0.4 + length(uWind.xz) * 0.12);
      return keep > 0.5 ? p : vec3(0.0);
    #endif
    }`;
  const FCLIP = /* glsl */`
    varying vec3 vTW; varying vec4 vTr; varying float vLeafF; varying float vCut; varying float vRootT; varying vec3 vCenT; varying float vRoot;
    uniform vec3 uO, uN, uHaze; uniform float uBack, uAlpha, uInsp, uCtxSolid, uCtxHaze;
    float treeA = 1.0;
    // context behind the slab: same haze as the terrain ghost
    vec3 treeHaze(vec3 c) {
    #ifdef CTX
      float ad = max(0.0, -dot(vTW - uO, uN) - uBack);
      c = mix(c, uHaze, (0.12 + 0.4 * smoothstep(0.0, 50.0, ad)) * (1.0 - uCtxSolid) + (0.3 + 0.38 * smoothstep(0.0, 40.0, ad)) * uCtxSolid * uCtxHaze);   // CX1 solid; P29j: haze per slice setting
    #endif
      return c;
    }
    float bayer4(vec2 p) {
      ivec2 i = ivec2(mod(p, 4.0));
      int k = i.x + i.y * 4;
      float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
      return (m[k] + 0.5) / 16.0;
    }
    // passes: main = trees rooted in (or in front of) the slab, drawn whole behind slice zero (+ dithered inspection ghost
    // in front); CTX = trees rooted behind the slab, drawn like the terrain ghost: a depth pre-pass (renderOrder 4) then
    // one translucent layer at the front-most depth (renderOrder 5). Per tree, so a crown never splits solid/ghost.
    // jag > 0 (foliage): the slice cuts the crown along a ragged line a little behind t = 0 instead of a straight edge
    void treeClipJ(float jag) {
    #ifndef LOG
      float t = dot(vTW - uO, uN);
     #ifdef CTX
      if (vRootT >= -uBack - ${CTX_M} || t > 0.02 || uAlpha < 0.004) discard;
      treeA = mix(uAlpha * mix(0.96, 0.42, smoothstep(0.0, 46.0, max(0.0, -uBack - t))), 1.0, uCtxSolid);   // CX1: solid
     #else
      float a = 1.0;
      if (vRootT < -uBack - ${CTX_M}) discard;
      if (t > 0.02 - jag) { if (uInsp < 0.02) discard; a = uInsp * 0.3 * exp(-max(t, 0.0) / 12.0); }
      if (a < 0.995 && a <= bayer4(gl_FragCoord.xy)) discard;
     #endif
    #endif
    }
    void treeClip() { treeClipJ(0.0); }`;
  function patchVS(sh) {
    sh.vertexShader = VHEAD + '\n' + sh.vertexShader
      .replace('#include <begin_vertex>', `vec3 transformed = treeXform(vec3(position)); vTW = transformed;`);
  }
  function makeMats() {
    own = {
      tState: { value: stTex }, uTime: { value: 0 }, uWind: { value: new T.Vector3(1.6, 0, 0.7) },
      uBarkTint: { value: new T.Color(1, 1, 1) }, uLeafTint: { value: new T.Color(1, 1, 1) }, uCore: { value: new T.Color(0.05, 0.08, 0.03) },
      uInsp: { value: 0 }, tLeaf: { value: tx.foliage || null }
    };
    const shared = () => Object.assign({}, own, { uO: U.uO, uN: U.uN, uBack: U.uBack, uAlpha: U.uAlpha, uCtxSolid: U.uCtxSolid, uCtxHaze: U.uCtxHaze, tNoise: U.tNoise, uHaze: U.uHaze || { value: new T.Color(0.6, 0.7, 0.8) } });
    const woodFS = sh => {
      sh.fragmentShader = FCLIP + `
        uniform float uTime; uniform vec3 uBarkTint; uniform sampler2D tNoise;
\n` + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n treeClip();')
        .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
          float nb = texture2D(tNoise, vTW.xz * 0.23 + vTW.y * 0.11).a;
          vec3 c = diffuseColor.rgb * uBarkTint;
          float lum = dot(diffuseColor.rgb, vec3(0.33));
          if (!gl_FrontFacing || vCut > 0.5) {
            // T3: fresh inner wood (slice / broken end): bright pale-yellow sapwood, growth bands about the segment axis
            // (faded to their mean once finer than a pixel), torn-fibre mottling
            float rr = length(vTW - vCenT), bw = 0.012, aa = fwidth(rr) / bw;
            float band = 0.5 + 0.5 * sin(rr * 6.2832 / bw + nb * 4.0);
            float fib = texture2D(tNoise, vTW.xz * 3.1 + vTW.y * 2.3).g;
            c = vec3(0.8, 0.6, 0.29) * (1.0 - 0.3 * band * (1.0 - smoothstep(0.25, 0.9, aa))) * (0.82 + 0.3 * fib);
          } else if (vRoot > 0.5) c = mix(c * 0.45, vec3(0.13, 0.085, 0.05) * (0.7 + 0.6 * nb), 0.65);   // T3: roots: bark caked with soil
          c = mix(c, vec3(0.03, 0.027, 0.025) * (0.6 + 0.9 * lum), smoothstep(0.0, 0.4, vTr.g));
          diffuseColor.rgb = treeHaze(c);`)
        .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
          #ifdef USE_MAP
            float crack = (1.0 - smoothstep(0.08, 0.2, dot(texture2D(map, vMapUv).rgb, vec3(0.33))));    // deepest furrows only
          #else
            float crack = smoothstep(0.7, 0.85, nb);
          #endif
          // embers in the charred bark's cracks (glow follows the char, flickers)
          totalEmissiveRadiance += vTr.b * smoothstep(0.05, 0.4, vTr.g) * crack * (0.6 + 0.4 * sin(uTime * 5.0 + vTW.y * 3.0 + nb * 9.0)) * vec3(1.8, 0.45, 0.06);`);
    };
    const leafFS = sh => {
      sh.fragmentShader = FCLIP + `
        uniform float uTime; uniform vec3 uLeafTint; uniform sampler2D tNoise;
\n` + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n treeClipJ(0.45 * smoothstep(0.3, 0.75, texture2D(tNoise, vTW.xy * 1.9 + vTW.z * 0.7).a));')
        .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
          float nl = texture2D(tNoise, vTW.xz * 0.35 + vTW.y * 0.2).a;
          vec3 c = diffuseColor.rgb * uLeafTint * (0.8 + 0.4 * nl);
          c = mix(c, vec3(0.12, 0.07, 0.03) * (0.7 + 0.6 * nl), max(smoothstep(0.0, 0.45, vTr.g), 0.8 * smoothstep(0.05, 0.6, vTr.b)));  // scorched by the heat, then charred
          if (!gl_FrontFacing) c *= 0.7;
          diffuseColor.rgb = treeHaze(c);`)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n normal = normalize(vNormal);')  // same outward normal on both faces
        .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
          totalEmissiveRadiance += vTr.b * smoothstep(0.78, 0.98, nl + 0.25 * sin(uTime * 8.0 + vTW.y * 5.0 + vTW.x * 3.0)) * vec3(1.2, 0.33, 0.04);`);  // leaf embers
    };
    const coreFS = sh => {
      sh.fragmentShader = FCLIP + `
        uniform float uTime; uniform vec3 uCore; uniform sampler2D tNoise, tLeaf;
\n` + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n treeClip();')
        .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
          float nl = texture2D(tNoise, vTW.xz * 0.5 + vTW.y * 0.3).a;
          vec2 cu = vTW.xy * 1.1 + vTW.zz * vec2(0.7, -0.4);
          vec4 lt = textureGrad(tLeaf, fract(cu), dFdx(cu), dFdy(cu));      // leaf clumps tiled over the core (gaps stay dark)
          vec2 cu2 = cu * 1.37 + 0.5;
          vec4 lt2 = textureGrad(tLeaf, fract(cu2), dFdx(cu2), dFdy(cu2));
          float ng = texture2D(tNoise, vTW.xy * 2.3 + vTW.z * 1.1).a;
          vec3 c = mix(uCore * (0.25 + 0.7 * ng), lt.rgb * 0.5, lt.a);   // texels are linear (dark): alpha is the leaf mask
          c = mix(c, lt2.rgb * 0.4, lt2.a * 0.85);
          c = mix(c, vec3(0.04, 0.03, 0.02), smoothstep(0.0, 0.45, vTr.g));
          // the crown cut open by the slice: a flat section through dense foliage (leaf clumps in slice-plane coordinates)
          if (!gl_FrontFacing) {
            vec3 tg = normalize(vec3(-uN.z, 0.0, uN.x));
            vec2 su = vec2(dot(vTW, tg), vTW.y) * 1.3;
            vec4 st = textureGrad(tLeaf, fract(su), dFdx(su), dFdy(su));
            c = mix(vec3(0.02, 0.035, 0.012), st.rgb * (0.6 + 0.3 * nl), st.a) * (1.0 - 0.8 * smoothstep(0.0, 0.45, vTr.g));
          }
          diffuseColor.rgb = treeHaze(c);`)
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n if (!gl_FrontFacing) normal = normalize((viewMatrix * vec4(uN, 0.0)).xyz);')   // section lit flat
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          if (!gl_FrontFacing) totalEmissiveRadiance += diffuseColor.rgb * 0.45;   // the section sits inside the crown's own shadow: keep it readable
          totalEmissiveRadiance += vTr.b * (gl_FrontFacing ? 1.0 : 0.35) * smoothstep(0.62, 0.9, nl + 0.2 * sin(uTime * 6.0 + vTW.y * 4.0)) * vec3(1.4, 0.36, 0.05);`);   // glowing patches
    };
    // pass 0 main (opaque), 1 context depth pre-pass, 2 context colour (translucent, front-most layer only)
    const mk = (opts, fs, key, pass) => {
      const o = Object.assign({}, opts);
      if (pass === 1) o.colorWrite = false;
      if (pass === 2) Object.assign(o, { transparent: true, depthWrite: false });
      const m = new T.MeshStandardMaterial(o);
      if (pass) m.defines = { CTX: 1 };
      m.onBeforeCompile = sh => {
        Object.assign(sh.uniforms, shared()); patchVS(sh); fs(sh);
        if (pass === 2) sh.fragmentShader = sh.fragmentShader.replace('#include <alphatest_fragment>', '#include <alphatest_fragment>\n diffuseColor.a = treeA;');
      };
      m.customProgramCacheKey = () => key + 'p' + (pass || 0);
      return m;
    };
    const variants = (opts, fs, key) => [0, 1, 2].map(p => mk(opts, fs, key, p));
    woodMats = variants({ map: tx.bark || null, color: tx.bark ? 0xffffff : 0x5a4632, roughness: 0.95, side: T.DoubleSide }, woodFS, 'treeWood1');
    leafMats = variants({ map: tx.foliage || null, color: 0xffffff, roughness: 0.85, side: T.DoubleSide, alphaTest: 0.45 }, leafFS, 'treeLeaf1');
    coreMats = variants({ roughness: 0.95, side: T.DoubleSide }, coreFS, 'treeCore1');
    woodMat = woodMats[0]; leafMat = leafMats[0]; coreMat = coreMats[0];
    const depth = (map, key) => {
      const m = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, map: map || null, alphaTest: map ? 0.45 : 0 });
      m.onBeforeCompile = sh => {
        Object.assign(sh.uniforms, shared()); patchVS(sh);
        sh.fragmentShader = FCLIP + '\n' +
          sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n treeClip();');
      };
      m.customProgramCacheKey = () => key;
      return m;
    };
    woodDepth = depth(null, 'treeWoodD1'); leafDepth = depth(tx.foliage, 'treeLeafD1'); coreDepth = depth(null, 'treeCoreD1');
  }

  /* ---------- geometry builders (world or body space) ---------- */
  function Buf() { return { p: [], n: [], uv: [], info: [], cen: [], idx: [], v: 0 }; }
  function vert(B, x, y, z, nx, ny, nz, u, v, info, cx, cy, cz) {
    B.p.push(x, y, z); B.n.push(nx, ny, nz); B.uv.push(u, v); B.info.push(info[0], info[1], info[2], info[3]); B.cen.push(cx, cy, cz); return B.v++;
  }
  // aInfo.w packs the height fraction (floor(w*64)/63) and a per-vertex seed (fract(w*64): card visibility, 0.99 = cut cap)
  const pack = (hf, seed) => (Math.round(M.clamp(hf, 0, 1) * 63) + M.clamp(seed, 0, 0.999)) / 64;
  function basis(dx, dy, dz) {
    const l = Math.hypot(dx, dy, dz) || 1, ax = dx / l, ay = dy / l, az = dz / l;
    let ux = 0, uy = 1, uz = 0; if (Math.abs(ay) > 0.9) { ux = 1; uy = 0; }
    let e1x = uy * az - uz * ay, e1y = uz * ax - ux * az, e1z = ux * ay - uy * ax; const l1 = Math.hypot(e1x, e1y, e1z); e1x /= l1; e1y /= l1; e1z /= l1;
    const e2x = ay * e1z - az * e1y, e2y = az * e1x - ax * e1z, e2z = ax * e1y - ay * e1x;
    return { ax, ay, az, l, e1x, e1y, e1z, e2x, e2y, e2z };
  }
  /* tapered bark tube a -> b (+ cap at b); along0 = bark v at a (m) */
  // T3: mark = per-vertex seed of the ring vertices (0.6 = root); splA / splB = splinter heights of the caps (fraction
  // of the radius along the axis: a fresh break is torn, not a flat disc), capA = also close the tube at a (a log's base)
  const sh1 = (i, k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
  function tube(B, a, b, r0, r1, along0, row, part, sp, hfA, hfB, radial, cut, mark, splB, capA) {
    const bs = basis(b.x - a.x, b.y - a.y, b.z - a.z), L = bs.l, rings = 1 + Math.max(1, Math.ceil(L / 0.8)), circ = 2 * Math.PI * Math.max(r0, 0.05);
    const ku = Math.max(1, Math.round(circ / 0.9));                 // bark texture repeats around the trunk
    const base = B.v;
    for (let q = 0; q < rings; q++) {
      const u = q / (rings - 1), cx = a.x + (b.x - a.x) * u, cy = a.y + (b.y - a.y) * u, cz = a.z + (b.z - a.z) * u, r = r0 + (r1 - r0) * u;
      const info = [row, part, sp, pack(hfA + (hfB - hfA) * u, mark || 0)];
      for (let k = 0; k <= radial; k++) {
        const th = k / radial * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th);
        const nx = bs.e1x * c + bs.e2x * s, ny = bs.e1y * c + bs.e2y * s, nz = bs.e1z * c + bs.e2z * s;
        vert(B, cx + nx * r, cy + ny * r, cz + nz * r, nx, ny, nz, k / radial * ku, (along0 + u * L) / circ * ku, info, cx, cy, cz);
      }
    }
    for (let q = 0; q < rings - 1; q++) for (let k = 0; k < radial; k++) {
      const i0 = base + q * (radial + 1) + k, i1 = i0 + radial + 1;
      B.idx.push(i0, i0 + 1, i1, i0 + 1, i1 + 1, i1);         // CCW seen from outside (normal d x e2 was inward)
    }
    // cap (the broken / cut end shows light wood: info.w seed 0.99 marks it in LOG mode; in play the backface rule).
    // T3: splintered: every other rim vertex pushed out along the axis by a random share of the radius (spikes), the
    // centre a little; an unbroken cap sits inside the child's tube, so the spikes stay hidden there
    const capAt = (P, rr, sgn, spl) => {
      const info = [row, part, sp, pack(sgn > 0 ? hfB : hfA, cut ? 0.99 : 0)], ax = bs.ax * sgn, ay = bs.ay * sgn, az = bs.az * sgn;
      const c0 = vert(B, P.x + ax * rr * spl * 0.35, P.y + ay * rr * spl * 0.35, P.z + az * rr * spl * 0.35, ax, ay, az, 0.5, 0.5, info, P.x, P.y, P.z);
      const nr = spl > 0 ? radial * 3 : radial;                   // a torn end gets 3x the rim vertices (fibres)
      for (let k = 0; k <= nr; k++) {
        const th = k / nr * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th), kk = k % nr;
        // irregular: a slanted break (cos term) + random fibre heights, now and then one long splinter
        const h1 = sh1(part + row * 0.37, kk), h2 = sh1(kk * 1.7, part + row);
        const up = spl * rr * Math.max(0, 0.3 + 0.35 * c * (part % 2 ? 1 : -1) + 0.7 * h1 * h1 * h1 + (h2 > 0.86 ? 0.8 * h1 + 0.3 : 0) - 0.3 * (k % 2));
        vert(B, P.x + (bs.e1x * c + bs.e2x * s) * rr + ax * up, P.y + (bs.e1y * c + bs.e2y * s) * rr + ay * up, P.z + (bs.e1z * c + bs.e2z * s) * rr + az * up, ax, ay, az, 0.5 + 0.5 * c, 0.5 + 0.5 * s, info, P.x, P.y, P.z);
      }
      for (let k = 0; k < nr; k++) { if (sgn > 0) B.idx.push(c0, c0 + 1 + k, c0 + 2 + k); else B.idx.push(c0, c0 + 2 + k, c0 + 1 + k); }
    };
    capAt(b, r1, 1, splB || 0);
    if (capA) capAt(a, r0, -1, capA);
    return L;
  }
  /* foliage cards around a cluster centre (+ the core into the core buffer) */
  function cluster(B, Bc, l, row, part, sp, hf, seed, nCards, coreDetail) {
    const r = l.r, n = nCards, ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const yv = 1 - (i + 0.5) / n * 1.88, rad = Math.sqrt(Math.max(0, 1 - yv * yv)), th = i * ga + seed * 6.28;
      let dx = Math.cos(th) * rad, dy = yv, dz = Math.sin(th) * rad;
      const h1 = M.hash3(i, seed * 1000 | 0, 3), h2 = M.hash3(i, seed * 1000 | 0, 5), h3 = M.hash3(i, seed * 1000 | 0, 7);
      const d = r * (0.62 + 0.28 * h1), cx = l.x + dx * d, cy = l.y + dy * d * 0.8, cz = l.z + dz * d, s = r * (0.85 + 0.35 * h2);
      // card plane: facing out along (dx, dy, dz), rolled randomly
      const bs = basis(dx, dy, dz), ro = h3 * 6.28, cr = Math.cos(ro), sr = Math.sin(ro);
      const ex = { x: bs.e1x * cr + bs.e2x * sr, y: bs.e1y * cr + bs.e2y * sr, z: bs.e1z * cr + bs.e2z * sr };
      const ey = { x: -bs.e1x * sr + bs.e2x * cr, y: -bs.e1y * sr + bs.e2y * cr, z: -bs.e1z * sr + bs.e2z * cr };
      const nx = 0.7 * bs.ax, ny = 0.7 * bs.ay + 0.3, nz = 0.7 * bs.az, nl = Math.hypot(nx, ny, nz);
      const info = [row, part, sp, pack(hf, 0.02 + 0.97 * M.hash3(i, seed * 997 | 0, 11))], base = B.v;
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const px = cx + (ex.x * (u - 0.5) + ey.x * (v - 0.5)) * s, py = cy + (ex.y * (u - 0.5) + ey.y * (v - 0.5)) * s, pz = cz + (ex.z * (u - 0.5) + ey.z * (v - 0.5)) * s;
        vert(B, px, py, pz, nx / nl, ny / nl, nz / nl, u, v, info, l.x, l.y, l.z);
      }
      B.idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
    // core clump: icosphere, flattened below, jittered
    const g = new T.IcosahedronGeometry(1, coreDetail), pa = g.attributes.position, base = Bc.v, info = [row, part, sp, pack(hf, 0.01)];
    for (let i = 0; i < pa.count; i++) {
      let x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const j = 0.8 + 0.35 * M.hash3(Math.round(x * 50), Math.round(y * 50) + (seed * 100 | 0), Math.round(z * 50)), rr = r * 0.64 * j;
      vert(Bc, l.x + x * rr, l.y + y * rr * (y < 0 ? 0.6 : 0.85), l.z + z * rr, x, y, z, 0, 0, info, l.x, l.y, l.z);
    }
    for (let i = 0; i < pa.count; i++) Bc.idx.push(base + i);
    g.dispose();
  }
  /* spruce tier: radial pine sprays drooping from the trunk + a dark inner foliage mass.
   * P29i (user 2026-10-08, a spruce of "stacked dark cones with fern-like cards sticking out"): the core is a ragged,
   * jittered cone well inside the sprays (it was a smooth 9-sided cone that showed between the tiers), and the sprays
   * are many smaller cards in three whorls (a long drooping skirt, a middle ring, a short top) spread over the tier's
   * height, so they cover the core and close the gap to the next tier; little roll, so the needles face out. */
  function tier(B, Bc, l, row, part, sp, hf, seed, nCards) {
    const r = l.r, base0 = Bc.v, info0 = [row, part, sp, pack(hf, 0.01)], nr = 14, sd0 = seed * 100 | 0;
    // inner mass: apex above, a ragged rim below (radial jitter 0.75-1.25, vertical jitter)
    const apex = vert(Bc, l.x, l.y + r * 0.6, l.z, 0, 1, 0, 0, 0, info0, l.x, l.y, l.z);   // (below the top whorl's base)
    for (let k = 0; k <= nr; k++) {
      const kk = k % nr, th = kk / nr * 6.283, rr = r * 0.33 * (0.75 + 0.5 * M.hash3(kk, sd0, 1)), c = Math.cos(th), s = Math.sin(th);
      vert(Bc, l.x + c * rr, l.y - r * (0.3 + 0.15 * M.hash3(kk, sd0, 5)), l.z + s * rr, c * 0.8, 0.6, s * 0.8, 0, 0, info0, l.x, l.y, l.z);
    }
    for (let k = 0; k < nr; k++) Bc.idx.push(apex, base0 + 2 + k, base0 + 1 + k);
    const under = vert(Bc, l.x, l.y - r * 0.12, l.z, 0, -1, 0, 0, 0, info0, l.x, l.y, l.z);
    for (let k = 0; k < nr; k++) Bc.idx.push(under, base0 + 1 + k, base0 + 2 + k);
    for (let i = 0; i < nCards; i++) {
      // whorl: 0 = the long drooping skirt (half the cards), 1 = middle, 2 = short top
      const wh = i % 4 === 3 ? 2 : i % 4 === 2 ? 1 : 0;
      const th = (i + 0.6 * M.hash3(i, sd0, 2)) / nCards * 6.283 * 2.0 + seed * 6.28 + wh * 0.7;
      const dr = M.hash3(i, sd0, 4), ox = Math.cos(th), oz = Math.sin(th);
      const droop = [0.42, 0.3, 0.18][wh] + 0.22 * M.hash3(i, sd0, 6), cd = Math.cos(droop), sn = Math.sin(droop);
      const e = { x: ox * cd, y: -sn, z: oz * cd }, roll = (M.hash3(i, sd0, 8) - 0.5) * 0.9, cr = Math.cos(roll), sr = Math.sin(roll);
      const sd = { x: -oz * cr - ox * sn * sr, y: -cd * sr, z: ox * cr - oz * sn * sr };          // (-oz, 0, ox) rolled about e
      const L = r * [1.15, 0.9, 0.62][wh] * (0.85 + 0.3 * dr), s = L / Math.SQRT2;
      const by = l.y + r * ([-0.24, 0.16, 0.48][wh] + 0.2 * M.hash3(i, 3, sd0)), b0 = { x: l.x + ox * 0.04, y: by, z: l.z + oz * 0.04 };
      const info = [row, part, sp, pack(hf, 0.02 + 0.97 * M.hash3(i, seed * 997 | 0, 13))], base = B.v;
      const nx = e.x * 0.6, ny = 0.8, nz = e.z * 0.6, nl = Math.hypot(nx, ny, nz);
      const P = (k1, k2) => ({ x: b0.x + (e.x * (k1 + k2) + sd.x * (k1 - k2)) * s / Math.SQRT2, y: b0.y + (e.y * (k1 + k2) + sd.y * (k1 - k2)) * s / Math.SQRT2, z: b0.z + (e.z * (k1 + k2) + sd.z * (k1 - k2)) * s / Math.SQRT2 });
      for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const p = P(u, v); vert(B, p.x, p.y, p.z, nx / nl, ny / nl, nz / nl, u, v, info, l.x, l.y, l.z); }
      B.idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3);
    }
  }
  function geo(B) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(B.p, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(B.n, 3));
    g.setAttribute('uv', new T.Float32BufferAttribute(B.uv, 2));
    g.setAttribute('aInfo', new T.Float32BufferAttribute(B.info, 4));
    g.setAttribute('aCen', new T.Float32BufferAttribute(B.cen, 3));
    g.setIndex(B.idx);
    g.computeBoundingSphere();
    return g;
  }
  // ASSET: tree_broadleaf_*, tree_pine_*, tree_palm_* (models/tree_*.glb, breakable trunk bones)
  function treeInto(t, row, Bw, Bl, Bc, ox, oy, oz, low) {
    const sp = t.sp, h = Math.max(1, t.h || 1), alongs = [];
    const hf = y => (y - (t.y || 0)) / h;
    const kid = new Uint8Array(t.seg.length);           // segment j has a child (a later segment with p === j)
    for (let k = 0; k < t.seg.length; k++) { const p = t.seg[k].p; if (p >= 0 && p < k) kid[p] = 1; }
    for (let j = 0; j < t.seg.length && j < LEAF0; j++) {
      const g = t.seg[j]; if (g.on === 0) { alongs.push(0); continue; }
      const a = { x: g.a.x - ox, y: g.a.y - oy, z: g.a.z - oz }, b = { x: g.b.x - ox, y: g.b.y - oy, z: g.b.z - oz };
      const a0 = g.p >= 0 && alongs[g.p] !== undefined ? alongs[g.p] : 0;
      const radial = g.kind === 2 ? (low ? 4 : 5) : (low ? 6 : 9);
      const hasKid = kid[j];
      alongs.push(a0 + tube(Bw, a, b, g.r0, g.r1, a0, row, j, sp, hf(g.a.y), hf(g.b.y), radial, true, 0, hasKid ? 1 : 0, row < 0 && g.p < 0 ? 1 : 0));
    }
    if (row >= 0 && t.seg.length) roots(t, row, Bw, sp, low);
    for (let k = 0; k < t.leaf.length && k < TREE_T - LEAF0; k++) {
      const l = t.leaf[k]; if (l.s === -1 && row >= 0) continue;
      const lc = { x: l.x - ox, y: l.y - oy, z: l.z - oz, r: l.r }, seed = ((t.id || 1) * 0.6180339 + k * 0.137) % 1;
      if (sp === 1) tier(Bl, Bc, lc, row, LEAF0 + k, sp, hf(l.y), seed, low ? 12 : 26);
      else cluster(Bl, Bc, lc, row, LEAF0 + k, sp, hf(l.y), seed, Math.round((low ? 7 : 14) * M.clamp(l.r / 1.2, 0.6, 1.4)), low ? 0 : 1);
    }
  }

  /* T3: the root system, render-only: laterals radiating from the stump base out to ~the root plate (ROOT_R_K x crown,
   * >= ROOT_R_MIN), sloping down to ~ROOT_D, tapering, with a side root each, plus a tap root. Built underground (kept
   * >= r + 5 cm under the ground at build time), so the terrain hides them until a crater uncovers them; part 0 (the
   * stump): they vanish with a shattered stump. Seeded by the tree id (stable per map). */
  const rootCache = new WeakMap();                 // tree -> root segments laid out against the ORIGINAL ground
  function rootSegs(t, low) {
    let L = rootCache.get(t); if (L) return L;
    L = [];
    const TK = C.TREES, s0 = t.seg[0], rs = s0.r0, plate = Math.max(TK.ROOT_R_MIN, TK.ROOT_R_K * (t.crown || 1.5));
    let hs = (((t.id || 1) * 2654435761) ^ 0x9e3779b9) >>> 0;
    const R = () => (hs = (Math.imul(hs, 1664525) + 1013904223) >>> 0) / 4294967296;
    const Wd = SS.world, gy = (x, z) => (Wd && Wd.top_at ? Wd.top_at(x, z) : t.y);
    const n = low ? 4 : 6 + Math.floor(R() * 3);
    const under = (P, r) => { const g = gy(P.x, P.z) - r - 0.05; if (P.y > g) P.y = g; return P; };
    const chain = (P, ang, dip, Lr, r, nSeg, side) => {
      for (let q = 0; q < nSeg; q++) {
        ang += (R() - 0.5) * 0.9; dip = Math.min(1.1, Math.max(0.05, dip + (R() - 0.35) * 0.3));
        const l = Lr / nSeg * (0.8 + 0.4 * R()), ca = Math.cos(dip);
        const Q = under({ x: P.x + Math.cos(ang) * ca * l, y: P.y - Math.sin(dip) * l, z: P.z + Math.sin(ang) * ca * l }, r * 0.7);
        Q.y = Math.max(Q.y, t.y - TK.ROOT_D - 0.6);
        L.push({ a: P, b: Q, r0: r, r1: r * 0.72 });
        if (side && (q === 1 || q === 3)) chain({ x: Q.x, y: Q.y, z: Q.z }, ang + (R() < 0.5 ? -1 : 1) * (0.6 + 0.6 * R()), dip, Lr * 0.35, r * 0.5, 3, false);
        P = Q; r *= 0.72;
      }
    };
    for (let i = 0; i < n; i++) {
      const ang = (i + R() * 0.6) / n * 6.2832, Lr = plate * (0.6 + 0.5 * R());
      const P = under({ x: t.x + Math.cos(ang) * rs * 0.6, y: t.y - 0.1, z: t.z + Math.sin(ang) * rs * 0.6 }, rs * 0.4);
      chain(P, ang, 0.1 + 0.3 * R(), Lr, rs * (0.38 + 0.15 * R()), low ? 3 : 5, !low);
    }
    if (t.sp !== 1) L.push({ a: { x: t.x, y: t.y - 0.3, z: t.z }, b: { x: t.x + (R() - 0.5) * 0.3, y: t.y - TK.TAP_D, z: t.z + (R() - 0.5) * 0.3 }, r0: rs * 0.55, r1: 0.04 });   // tap root (spruce: plate only)
    rootCache.set(t, L);
    return L;
  }
  /* T3: the root system, render-only: laterals radiating from the stump base out to ~the root plate (ROOT_R_K x crown,
   * >= ROOT_R_MIN), wandering and sloping down to ~ROOT_D, tapering, with side roots, plus a tap root. Laid out once
   * against the original ground (>= r + 5 cm under it), so the terrain hides them until a crater uncovers them; after
   * a blast near the tree the wood is rebuilt and every root segment now wholly in air is left out (blown away): what
   * remains shows along the crater walls / floor with broken ends. Part 0 (the stump): they vanish with a shattered
   * stump. Seeded by the tree id. */
  function roots(t, row, Bw, sp, low) {
    const Wd = SS.world, rad = low ? 4 : 5;
    const air = (x, y, z) => !Wd || !Wd.sample || Wd.sample(x, y, z) <= 0;
    for (const g of rootSegs(t, low)) {
      const a = g.a, b = g.b;
      if (air(a.x * 0.75 + b.x * 0.25, a.y * 0.75 + b.y * 0.25, a.z * 0.75 + b.z * 0.25) && air((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2) && air(a.x * 0.25 + b.x * 0.75, a.y * 0.25 + b.y * 0.75, a.z * 0.25 + b.z * 0.75)) {
        // wholly in air: thin roots were torn out; a thick one (r > 5 cm) still anchored at an end hangs across the crater
        if (!(g.r0 > 0.05 && (!air(a.x, a.y - 0.15, a.z) || !air(b.x, b.y - 0.15, b.z)))) continue;
      }
      tube(Bw, a, b, g.r0, g.r1, 0, row, 0, sp, 0, 0, rad, false, 0.6, 0, 0);
    }
  }

  /* ---------- per map ---------- */
  function drop() {
    const geos = new Set(meshes.map(m => m.geometry));
    for (const m of meshes) scene.remove(m);
    for (const g of geos) g.dispose();
    meshes = []; tris = 0;
  }
  function rebuild(S) {
    drop();
    builtFor = S.trees;
    const trees = S.trees || [];
    if (!trees.length) return;
    nRows = Math.max(1, trees.length);
    stData = new Float32Array(ROW * nRows * 4);
    if (stTex) stTex.dispose();
    stTex = new T.DataTexture(stData, ROW, nRows, T.RGBAFormat, T.FloatType);
    stTex.magFilter = stTex.minFilter = T.NearestFilter; stTex.needsUpdate = true;
    own.tState.value = stTex;
    const Bw = Buf(), Bl = Buf(), Bc = Buf(), low = Q && Q.name === 'low';
    trees.forEach((t, i) => treeInto(t, i, Bw, Bl, Bc, 0, 0, 0, low));
    const sp = SPN[trees[0].sp] || 'oak', L = LOOK[sp] || LOOK.oak;          // (an unknown species falls back to oak)
    own.uBarkTint.value.setRGB(L.bark[0], L.bark[1], L.bark[2]); own.uLeafTint.value.setRGB(L.leaf[0], L.leaf[1], L.leaf[2]); own.uCore.value.setRGB(L.core[0], L.core[1], L.core[2]);
    const map = sp === 'spruce' ? tx.pine : tx.foliage;
    if (leafMat.map !== map) for (const m of [...leafMats, leafDepth]) { m.map = map || null; m.needsUpdate = true; }
    own.tLeaf.value = map || null;
    const mk = (B, mats, dm) => {
      if (!B.idx.length) return;
      const g = geo(B);
      mats.forEach((mat, pass) => {
        const m = new T.Mesh(g, mat); m.frustumCulled = false;
        if (pass === 0) { m.castShadow = true; m.receiveShadow = true; m.customDepthMaterial = dm; }
        else m.renderOrder = pass === 1 ? 4 : 5;          // with the terrain ghost's pre-pass / colour pass
        scene.add(m); meshes.push(m);
      });
      tris += B.idx.length / 3;
    };
    mk(Bw, woodMats, woodDepth); mk(Bl, leafMats, leafDepth); mk(Bc, coreMats, coreDepth);
    lastSig = '';
  }

  TV.init = function (sc, textures, quality) {
    scene = sc; tx = textures || {}; Q = quality; U = SS.terrain.uniforms;
    stTex = new T.DataTexture(new Float32Array(ROW * 4), ROW, 1, T.RGBAFormat, T.FloatType); stTex.needsUpdate = true;
    makeMats();
    // grass fire: instanced procedural flame quads on burning cells
    maxFire = Math.round(1400 * (Q && Q.particles ? Q.particles : 1));
    const fg = new T.PlaneGeometry(1, 1); fg.translate(0, 0.5, 0);
    const ig = new T.InstancedBufferGeometry(); ig.index = fg.index; ig.setAttribute('position', fg.attributes.position); ig.setAttribute('uv', fg.attributes.uv);
    fireSeed = new T.InstancedBufferAttribute(new Float32Array(maxFire), 1); fireSeed.setUsage(T.DynamicDrawUsage); ig.setAttribute('seed', fireSeed);
    const fm = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uInt: { value: 1 } },
      vertexShader: /* glsl */`
        attribute float seed; varying vec2 vUv; varying float vSeed;
        void main() {
          vUv = uv; vSeed = seed;
          vec4 mv = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec3 sc = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), 1.0);
          mv.xy += position.xy * sc.xy;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: SS.bodyView && SS.bodyView.FLAME_FS ? SS.bodyView.FLAME_FS : 'void main(){ gl_FragColor = vec4(1.0, 0.5, 0.1, 1.0); }',
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    fire = new T.InstancedMesh(ig, fm, maxFire); fire.count = 0; fire.frustumCulled = false; fire.renderOrder = 9;
    fire.instanceMatrix.setUsage(T.DynamicDrawUsage);
    scene.add(fire);
  };

  const mtx = new T.Matrix4();
  function freeFlames(id) { const fl = flames.get(id); if (fl) { for (const f of fl) SS.bodyView.unflame(f); flames.delete(id); } }
  TV.frame = function (S, view) {
    if (!own) return;
    time = view.time || time + 1 / 60;
    if (builtFor !== S.trees) { for (const id of [...flames.keys()]) freeFlames(id); rebuild(S); lastBoom = S.lastExplosion; }
    // T3: a blast near a tree may have uncovered / torn its roots: rebuild the wood (root segments now in air dropped).
    // Keyed on the explosion record itself (S.lastBoom also moves on every shot fired / projectile removed)
    else if (S.lastExplosion !== lastBoom) {
      lastBoom = S.lastExplosion; const e = S.lastExplosion;
      if (e && (S.trees || []).some(t => Math.hypot(t.x - e.x, t.z - e.z) < Math.max(C.TREES.ROOT_R_MIN, C.TREES.ROOT_R_K * (t.crown || 1.5)) * 1.1 + e.R + 1)) rebuild(S);
    }
    own.uTime.value = time; own.uInsp.value = view.insp || 0;
    const wm = S.wind && S.wind.mean; if (wm) own.uWind.value.set(wm.x, 0, wm.z);
    const trees = S.trees || [], O = S.O, n = SS.plane.nrm(S), back = U.uBack.value, insp = view.insp || 0, ctx = view.ctxA || 0;
    const tOf = (x, z) => (x - O.x) * n.x + (z - O.z) * n.z;
    const visT = t => (t <= 0.3 || insp > 0.05) && (t >= -back - 0.5 || ctx > 0.25);
    const slabTree = t => tOf(t.x, t.z) >= -back - CTX_M;                 // same split as the shaders
    const visL = (tr, t) => (t <= 0.3 || insp > 0.05) && (slabTree(tr) || ctx > 0.25);
    // state texture
    if (stData && trees.length) {
      for (let i = 0; i < trees.length && i < nRows; i++) {
        const t = trees[i], o = i * ROW * 4;
        for (let j = 0; j < LEAF0; j++) { stData[o + j * 4] = j < t.seg.length ? t.seg[j].on : 0; stData[o + j * 4 + 1] = 0; }
        for (let j = 1; j < t.seg.length && j < LEAF0; j++) if (!t.seg[j].on && t.seg[j].p >= 0) stData[o + t.seg[j].p * 4 + 1] = 1;   // exposed top
        for (let k = 0; k < TREE_T - LEAF0; k++) stData[o + (LEAF0 + k) * 4] = k < t.leaf.length && t.leaf[k].s >= 0 ? t.leaf[k].f : 0;
        const q = o + TREE_T * 4, qr = o + ROOT_T * 4;
        stData[qr] = t.x; stData[qr + 1] = t.z;
        stData[q] = t.alive ? 1 : 0; stData[q + 1] = t.char; stData[q + 2] = SS.trees ? SS.trees.intensity(t) : 0; stData[q + 3] = ((t.id || 1) * 0.618034) % 1;
      }
      stTex.needsUpdate = true;
    }
    // flames on burning trees
    for (const t of trees) {
      const I = t.alive && t.burn >= 0 && SS.trees ? SS.trees.intensity(t) : 0;
      if (I <= 0.02 || !SS.bodyView) { freeFlames(t.id); continue; }
      let fl = flames.get(t.id); if (!fl) { fl = []; flames.set(t.id, fl); }
      const want = [];
      if (visL(t, tOf(t.x, t.z))) want.push([t.x, t.y - 0.1, t.z, 0.9 + 0.5 * I, 1.5 + 1.2 * I]);
      for (const l of t.leaf) if (l.s >= 0 && l.f > 0.15 && visL(t, tOf(l.x, l.z))) {
        const tf = Math.min(l.r * 0.6, Math.max(0, 0.3 - tOf(l.x, l.z)));     // toward the camera, never past the slice
        want.push([l.x + n.x * tf, l.y - l.r * 0.1, l.z + n.z * tf, l.r * (0.7 + 0.4 * I) * Math.sqrt(l.f), l.r * (1.2 + 0.9 * I) * Math.sqrt(l.f)]);
      }
      while (fl.length > want.length) SS.bodyView.unflame(fl.pop());
      for (let i = 0; i < want.length; i++) {
        if (!fl[i]) fl[i] = SS.bodyView.flame(((t.id * 0.37 + i * 0.211) % 1));
        const w = want[i]; fl[i].position.set(w[0], w[1], w[2]); fl[i].scale.set(w[3], w[4], 1);
      }
    }
    // grass fire field
    const st = S.veg; let k = 0;
    if (st && st.nAct && fire) {
      const H = SS.world.H, nn = st.n, top = SS.world.top, stride = Math.max(1, Math.ceil(st.nAct / maxFire));
      for (let a = 0; a < st.nAct && k < maxFire; a += stride) {
        const c = st.act[a]; if (st.burnT[c] <= 0) continue;
        const x = (c % nn) * H, z = ((c / nn) | 0) * H, tt = tOf(x, z);
        if (!visT(tt)) continue;
        const h1 = M.hash3(c, 1, 9), h2 = M.hash3(c, 2, 9), s = st.burnI[c] * Math.min(1, st.burnT[c] / 0.8) * (0.7 + 0.6 * h1) * (stride > 1 ? 1.2 : 1);
        if (s < 0.05) continue;
        mtx.makeScale(0.75 * s, 1.05 * s, 1).setPosition(x + (h1 - 0.5) * 0.35, top[c] - 0.08, z + (h2 - 0.5) * 0.35);
        fire.setMatrixAt(k, mtx); fireSeed.array[k] = h2; k++;
      }
    }
    if (fire) {
      fire.count = k; fireN = k;
      if (k) { fire.instanceMatrix.needsUpdate = true; fireSeed.needsUpdate = true; fire.material.uniforms.uTime.value = time; }
    }
  };

  /* a broken tree part (body space): same look, no clipping (bodies are drawn whole like props) */
  const logMats = new Map();
  function logMat(base) {
    const key = base.uuid;
    let m = logMats.get(key);
    if (!m) {
      m = base.clone(); m.defines = Object.assign({}, m.defines, { LOG: 1 });
      const ob = base.onBeforeCompile;
      m.onBeforeCompile = sh => { ob(sh); };
      m.customProgramCacheKey = () => base.customProgramCacheKey() + 'L';
      logMats.set(key, m);
    }
    return m;
  }
  TV.logGroup = function (log) {
    if (!own) return null;
    const g = new T.Group(), Bw = Buf(), Bl = Buf(), Bc = Buf();
    const t = { id: log.tree, sp: log.sp, y: 0, h: 1, seg: log.segs.map((s, i) => ({ a: s.a, b: s.b, r0: s.r0, r1: s.r1, kind: s.kind, on: 1, p: i - 1 })), leaf: log.leaves.map(l => ({ x: l.x, y: l.y, z: l.z, r: l.r * (0.55 + 0.45 * Math.sqrt(l.f)), f: l.f, s: 0 })) };
    treeInto(t, -1, Bw, Bl, Bc, 0, 0, 0, true);
    // LOG mode: aInfo.x carries the char
    for (const B of [Bw, Bl, Bc]) for (let i = 0; i < B.info.length; i += 4) B.info[i] = log.char || 0;
    const parts = [];
    for (const [B, mat] of [[Bw, woodMat], [Bl, leafMat], [Bc, coreMat]]) {
      if (!B.idx.length) continue;
      const m = new T.Mesh(geo(B), logMat(mat)); m.castShadow = m.receiveShadow = true; g.add(m); parts.push(m);
      if (mat === leafMat) m.customDepthMaterial = logMat(leafDepth);
    }
    return { group: g, meshes: parts };
  };
  TV.debug = () => ({ meshes, woodMats, leafMats, coreMats, state: stData, ROW, LEAF0 });   // dev tools (shot scripts, verify)
  TV.stats = () => ({ tris, fire: fireN, flames: [...flames.values()].reduce((a, f) => a + f.length, 0) });
})(window.SS = window.SS || {});
