/* render/ice.js — sea / pool ice (Step I8; Three.js specific). Draws S.ice (sim/ice.js) as one slab mesh over the iced
 * cells: a top face at the ice top (water surface + freeboard, sampled at rebuild) and a bottom face at the ice base;
 * rebuilt when the field changes (S.ice.ver) or, throttled, as the water under it moves. 100 % procedural look by the
 * WMO stages of development (research §8 "Ice (I)"): dark nilas (< 5 cm, near-black, glossy: the water shows
 * through) -> grey (10-15 cm) -> grey-white (15-30) -> white (> 30); snow on the ice while it snows; cracked floes
 * (cellular ~1.4 m floes) show dark wet joints and are darker; frost flowers on young ice. The cut at slice zero shows the
 * ice's thickness band (back faces: pale blue-white). Clipped like the trees (nothing in front of slice zero in play).
 * API: init(scene), clear(), frame(S, view), stats(). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const IV = SS.iceView = {};
  let scene = null, mesh = null, geo = null, U = null, own = null, builtVer = -1, builtT = -9, nQ = 0, vBot = null;
  let floeMesh = null, fPos = null, fNrm = null, fIce = null, fIdx = null, fCount = 0;

  /* P29k (user 2026-10-08: "this thin ice looks like shit": a flat grey sheet with saw-tooth edges, the water drawn
   * over it). Real young sea ice: nilas is a dark, glossy, translucent skin (the sea shows through, it mirrors the sky,
   * sparse frost flowers; a noise iso-band for finger rafting drew squiggles: dropped), it greys and whitens as it
   * thickens and gets mottled (brine drainage, snow ice). The sheet is TRANSPARENT and drawn AFTER the water, a little
   * above it (freeboard >= 2 cm), so the sea never shows on top of it; its contour follows a blurred presence field
   * plus a low-frequency wander: smooth lobes, no cell teeth; a pale slush rim at the edge. */
  function material() {
    const m = new T.MeshStandardMaterial({ roughness: 0.4, metalness: 0, side: T.DoubleSide, vertexColors: false, transparent: true, depthWrite: true });
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, own, { uO: U.uO, uN: U.uN, tNoise: U.tNoise, uHaze: U.uHaze });
      sh.vertexShader = 'attribute vec3 aIce; varying vec3 vW; varying vec3 vIce;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vIce = aIce;`);
      sh.fragmentShader = 'uniform vec3 uO, uN, uHaze; uniform float uInsp, uSnow; uniform sampler2D tNoise; varying vec3 vW; varying vec3 vIce;\nvec3 iceRefl;\n' + sh.fragmentShader
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          if (uInsp < 0.5 && dot(vW - uO, uN) > 0.02) discard;`)
        .replace('#include <map_fragment>', /* glsl */`
          float hcm = vIce.x, snowcm = vIce.y, pres = vIce.z;   // (P30: y = snow on the ice, cm; broken ice is floes now)
          // floes: z = 2 + e (e: 0 at the centre -> 1 on the broken edge / the side wall): a crisp piece with a pale
          // crushed-ice margin, no contour wander
          float fe = pres > 1.5 ? pres - 2.0 : -1.0; if (fe >= 0.0) pres = 1.0;
          // contour: blurred presence + a smooth wander (lobes of 2-5 m, a little 1 m ripple)
          float peL = pres + (texture2D(tNoise, vW.xz * 0.21).r - 0.5) * 0.42;
          if (peL + (texture2D(tNoise, vW.xz * 0.55 + 0.31).g - 0.5) * 0.05 < 0.5) discard;
          // the slush rim follows the smooth contour only (a band on the noisy one broke into squiggles where the
          // presence hovers near 0.5)
          float rim = (1.0 - smoothstep(0.5, 0.58, peL)) * smoothstep(0.25, 0.75, pres) * step(pres, 0.95);
          float n1 = texture2D(tNoise, vW.xz * 0.19).r, n2 = texture2D(tNoise, vW.xz * 0.9 + 0.37).g, n3 = texture2D(tNoise, vW.xz * 4.1).b;
          // WMO stages: nilas (dark, the sea shows through) -> grey (10-15 cm) -> grey-white -> white (> 30 cm)
          float st = smoothstep(3.0, 14.0, hcm), wt = smoothstep(15.0, 32.0, hcm);
          vec3 c = mix(vec3(0.045, 0.07, 0.085), vec3(0.34, 0.38, 0.41), st);
          c = mix(c, vec3(0.66, 0.7, 0.73), wt);
          // mottling over 1-6 m (brine drainage, snow-ice patches), stronger on older ice
          float mot = texture2D(tNoise, vW.xz * 0.07).r * 0.6 + texture2D(tNoise, vW.xz * 0.23 + 0.5).g * 0.4;
          c *= mix(0.9 + 0.2 * mot, 0.74 + 0.5 * mot, st);
          // frost flowers: sparse white rosettes on young ice
          { vec2 q = vW.xz * 2.6, qi = floor(q), qf = fract(q);                  // one rosette per ~0.4 m cell at most
            vec3 hh = fract(sin(vec3(dot(qi, vec2(127.1, 311.7)), dot(qi, vec2(269.5, 183.3)), dot(qi, vec2(419.2, 371.9)))) * 43758.5453);
            float dot0 = 1.0 - smoothstep(0.05, 0.16 + 0.1 * hh.z, length(qf - 0.25 - 0.5 * hh.xy));
            c = mix(c, vec3(0.86, 0.89, 0.93), dot0 * step(hh.z, 0.35) * smoothstep(0.45, 0.75, n1) * (1.0 - wt) * 0.6); }
          c *= 0.93 + 0.14 * n3;
          // the edge: pale slush / brash ice
          c = mix(c, c * 1.3 + vec3(0.07, 0.08, 0.09), rim * 0.65);
          if (fe >= 0.0) { float fr = smoothstep(0.86, 0.99, fe + (n2 - 0.5) * 0.1); c = mix(c, vec3(0.6, 0.66, 0.7), fr * 0.6); rim = max(rim, fr * 0.6); }
          // snow on the ice (falling snow, old ice keeps more)
          // snow lying on the ice (sim: S.ice.snow, cm): patchy from a dusting, full cover from ~1.5 cm
          float sn = smoothstep(0.1, 1.5, snowcm + (n1 * 0.6 + n2 * 0.4 - 0.5) * 0.8);
          c = mix(c, vec3(0.85, 0.88, 0.92), sn);
          float rough = mix(0.05, 0.45, st) + 0.3 * wt + 0.3 * sn + 0.2 * rim;
          // glossy young ice mirrors the sky (no env map here): Fresnel x the sky haze, as light, not as albedo
          vec3 Vv = normalize(cameraPosition - vW);
          iceRefl = uHaze * pow(1.0 - clamp(Vv.y, 0.0, 1.0), 4.0) * (1.0 - st) * (1.0 - sn) * 0.75;
          float alpha = mix(0.9, 1.0, smoothstep(2.0, 12.0, hcm)) * (1.0 - rim * 0.2);   // (more see-through showed the water's shore foam under it)
          if (!gl_FrontFacing) { c = vec3(0.55, 0.68, 0.76); rough = 0.25; alpha = 1.0; iceRefl = vec3(0.0); }   // the ice band seen at the cut
          diffuseColor = vec4(c, alpha);`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = rough;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += iceRefl;');
    };
    m.customProgramCacheKey = () => 'ice2';
    return m;
  }

  IV.init = function (sc) {
    scene = sc; U = SS.terrain.uniforms;
    own = { uInsp: { value: 0 }, uSnow: { value: 0 } };
    mesh = new T.Mesh(new T.BufferGeometry(), material());
    mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.visible = false; mesh.renderOrder = 6.4;   // after the water (5.9-6.2)
    scene.add(mesh);
    // P30 floes: one dynamic mesh (a 7-gon top at the water + freeboard, side walls down into the water), rebuilt
    // every frame from S.ice.floes; the same ice material (aIce: thickness, the snow it carries, 2 + edge 0..1 = a crisp piece with a pale broken margin)
    const MAXF = C.ICE.FLOE_MAX, VPF = 9 + 8 * 4, IPF = 8 * 3 + 8 * 6;   // up to 8 corners (sim/ice.js shatter)
    fPos = new Float32Array(MAXF * VPF * 3); fNrm = new Float32Array(MAXF * VPF * 3); fIce = new Float32Array(MAXF * VPF * 3); fIdx = new Uint32Array(MAXF * IPF);
    const fg = new T.BufferGeometry();
    fg.setAttribute('position', new T.BufferAttribute(fPos, 3).setUsage(T.DynamicDrawUsage));
    fg.setAttribute('normal', new T.BufferAttribute(fNrm, 3).setUsage(T.DynamicDrawUsage));
    fg.setAttribute('aIce', new T.BufferAttribute(fIce, 3).setUsage(T.DynamicDrawUsage));
    fg.setIndex(new T.BufferAttribute(fIdx, 1).setUsage(T.DynamicDrawUsage));
    floeMesh = new T.Mesh(fg, mesh.material); floeMesh.frustumCulled = false; floeMesh.renderOrder = 6.4; floeMesh.visible = false; floeMesh.receiveShadow = true;
    scene.add(floeMesh);
  };
  const C = SS.CFG;
  function buildFloes(S) {
    const F = S.ice ? S.ice.floes : null;
    if (!F || !F.length) { floeMesh.visible = false; fCount = 0; return; }
    let v = 0, q = 0;
    const put = (x, y, z, nx, ny, nz, h) => { const o = v * 3; fPos[o] = x; fPos[o + 1] = y; fPos[o + 2] = z; fNrm[o] = nx; fNrm[o + 1] = ny; fNrm[o + 2] = nz; fIce[o] = h; fIce[o + 1] = sn; fIce[o + 2] = 2 + e; return v++; };
    let sn = 0, e = 0;                                               // (the current floe's snow; edge 0 centre -> 1 rim)
    for (const f of F) {
      const s = SS.water.surface(S, f.x, f.z), top = (s < -50 ? SS.world.SEA : s) + freeboard(f.h), bot = top - Math.max(0.05, f.h * 0.01 + 0.03);
      const ca = Math.cos(f.a), sa = Math.sin(f.a), n = f.n, wx = [], wz = [];
      for (let k = 0; k < n; k++) { wx.push(f.x + f.px[k] * ca - f.pz[k] * sa); wz.push(f.z + f.px[k] * sa + f.pz[k] * ca); }
      sn = f.snow || 0; e = 0;
      const c0 = put(f.x, top, f.z, 0, 1, 0, f.h), t0 = v; e = 1;
      for (let k = 0; k < n; k++) put(wx[k], top, wz[k], 0, 1, 0, f.h);
      for (let k = 0; k < n; k++) { fIdx[q++] = c0; fIdx[q++] = t0 + (k + 1) % n; fIdx[q++] = t0 + k; }
      for (let k = 0; k < n; k++) {                                  // side walls, outward normals
        const k2 = (k + 1) % n, ex = wx[k2] - wx[k], ez = wz[k2] - wz[k], l = Math.hypot(ex, ez) || 1, nx = ez / l, nz = -ex / l;
        const a = put(wx[k], top, wz[k], nx, 0, nz, f.h), b = put(wx[k2], top, wz[k2], nx, 0, nz, f.h), c = put(wx[k2], bot, wz[k2], nx, 0, nz, f.h), d = put(wx[k], bot, wz[k], nx, 0, nz, f.h);
        fIdx[q++] = a; fIdx[q++] = b; fIdx[q++] = c; fIdx[q++] = a; fIdx[q++] = c; fIdx[q++] = d;   // (outward: a back face is painted as the cut band)
      }
    }
    const g = floeMesh.geometry;
    for (const k of ['position', 'normal', 'aIce']) { g.attributes[k].needsUpdate = true; g.attributes[k].clearUpdateRanges && g.attributes[k].clearUpdateRanges(); }
    g.index.needsUpdate = true; g.setDrawRange(0, q); floeMesh.visible = true; fCount = F.length;
  }
  IV.clear = function () { builtVer = -1; if (mesh) mesh.visible = false; if (floeMesh) floeMesh.visible = false; };

  // freeboard (m) of h cm of sea ice (~12 %), at least 2 cm so the water surface never shows through the sheet
  const freeboard = hcm => Math.max(0.02, hcm * 0.01 * 0.12);
  // a shared grid with vertices at the cell centres; presence (1 ice / 0 water) is interpolated and the fragment
  // shader discards below 0.5: smooth, diagonal contours instead of 0.5 m stair steps
  function rebuild(S) {
    const st = S.ice, w = SS.world, H = w.H, NX = st.NX, NZ = st.NZ, h = st.h;
    const P = [], A = [], N = [], I = [], B = [];
    const vid = new Int32Array(NX * NZ).fill(-1), vidB = new Int32Array(NX * NZ).fill(-1);
    const ice = c => h[c] >= 0.5;
    const surf = (x, z) => { const s = SS.water.surface(S, x, z); return s < -50 ? w.SEA : s; };
    // thickness at a vertex: its own, else the thickest neighbour (so the faded edge sits at the right height)
    const hAt = (i, k) => {
      const c = k * NX + i; if (ice(c)) return h[c];
      let m = 0;
      if (i > 0 && h[c - 1] > m) m = h[c - 1]; if (i < NX - 1 && h[c + 1] > m) m = h[c + 1];
      if (k > 0 && h[c - NX] > m) m = h[c - NX]; if (k < NZ - 1 && h[c + NX] > m) m = h[c + NX];
      return m;
    };
    // presence at a vertex: a 3 x 3 binomial blur of the iced cells (the contour at 0.5 runs smoothly between cells)
    const presence = (i, k) => {
      let a = 0;
      for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
        const ii = Math.min(NX - 1, Math.max(0, i + di)), kk = Math.min(NZ - 1, Math.max(0, k + dk));
        if (ice(kk * NX + ii)) a += (di ? 1 : 2) * (dk ? 1 : 2);
      }
      return a / 16;
    };
    const vert = (i, k, bottom) => {
      const c = k * NX + i, arr = bottom ? vidB : vid;
      if (arr[c] >= 0) return arr[c];
      const x = i * H, z = k * H, hc = hAt(i, k), top = surf(x, z) + freeboard(hc);
      const y = bottom ? top - Math.max(0.03, hc * 0.01) : top;
      P.push(x, y, z); N.push(0, bottom ? -1 : 1, 0); A.push(hc, st.snow[c], presence(i, k)); B.push(bottom ? 1 : 0);
      arr[c] = P.length / 3 - 1; return arr[c];
    };
    nQ = 0;
    for (let k = 0; k < NZ - 1; k++) for (let i = 0; i < NX - 1; i++) {
      const c = k * NX + i;
      if (!(ice(c) || ice(c + 1) || ice(c + NX) || ice(c + NX + 1))) continue;
      const a = vert(i, k, false), b = vert(i + 1, k, false), d = vert(i, k + 1, false), e = vert(i + 1, k + 1, false);
      I.push(a, d, e, a, e, b);
      const a2 = vert(i, k, true), b2 = vert(i + 1, k, true), d2 = vert(i, k + 1, true), e2 = vert(i + 1, k + 1, true);
      I.push(a2, e2, d2, a2, b2, e2);
      nQ++;
    }
    if (mesh.geometry && mesh.geometry !== geo) mesh.geometry.dispose();          // the empty one from init
    geo && geo.dispose();
    geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(P, 3));
    geo.setAttribute('normal', new T.Float32BufferAttribute(N, 3));
    geo.setAttribute('aIce', new T.Float32BufferAttribute(A, 3));
    geo.setIndex(I);
    mesh.geometry = geo; mesh.visible = I.length > 0; vBot = new Uint8Array(B);
  }
  // the water under the ice moved (swell, waves) and snow keeps falling on it: the heights and the snow change, so
  // update the vertex y and the snow channel in place (vertices sit at cell centres: the cell from x, z). (The sim
  // raises st.snow every 0.5 s without bumping st.ver: a full rebuild per snowfall tick would be wasteful.)
  function reheight(S) {
    const pos = geo && geo.attributes.position, ai = geo && geo.attributes.aIce, w = SS.world, st = S.ice;
    if (!pos || !pos.count) return;
    const p = pos.array, a = ai.array;
    for (let v = 0; v < pos.count; v++) {
      const x = p[v * 3], z = p[v * 3 + 2], hc = a[v * 3], s = SS.water.surface(S, x, z), top = (s < -50 ? w.SEA : s) + freeboard(hc);
      p[v * 3 + 1] = vBot[v] ? top - Math.max(0.03, hc * 0.01) : top;
      a[v * 3 + 1] = st.snow[Math.round(z / w.H) * st.NX + Math.round(x / w.H)];
    }
    pos.needsUpdate = true; ai.needsUpdate = true;
  }
  IV.frame = function (S, view) {
    if (!mesh) return;
    if (!S.ice) { mesh.visible = false; if (floeMesh) floeMesh.visible = false; return; }
    buildFloes(S);
    own.uInsp.value = view.insp || 0;
    const we = S.weather; own.uSnow.value = we ? Math.min(1, (we.snow || 0) * 1.2 + (we.snowCover || 0) * 0.6) : 0;
    const t = view.time || 0;
    if (S.ice.ver !== builtVer) { rebuild(S); builtVer = S.ice.ver; builtT = t; }
    else if (t - builtT > 2) { reheight(S); builtT = t; }
  };
  IV.stats = () => ({ quads: nQ, visible: !!(mesh && mesh.visible), floes: fCount });
})(window.SS = window.SS || {});
