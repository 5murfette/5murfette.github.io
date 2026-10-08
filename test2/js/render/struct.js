/* render/struct.js — steel structures (Step M; Three.js specific): the sim's S.structs (Warren truss footbridges) and
 * their fallen pieces (SS.bodies 'struct', via bodyView -> SS.structView.pieceGroup). 100 % procedural:
 *   - geometry: every member a box along a -> b (hollow-section chords / diagonals / cross beams), gusset plates at the
 *     truss nodes, deck panels of checker plate; rebuilt only when a structure changes (st.ver: a member was cut);
 *   - material: MeshStandardMaterial + onBeforeCompile: paint per biome (dark green / galvanised grey / red-oxide
 *     primer / sun-faded / dark grey), rust from world-space noise (more low down, downward streaks), paint is a
 *     dielectric (rough 0.5), rust rough 0.9; deck = worn checker plate (raised diamond treads as a normal
 *     perturbation, bare steel where feet wear it);
 *   - clipping like the trees: nothing in front of slice zero in play (inspection shows it), the cut through a member
 *     shows bright cut steel (back faces); a matching depth material keeps the shadows consistent.
 * API: init(scene, tx, Q), frame(S, view), pieceGroup(body) -> {group, meshes}, stats(). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const SV = SS.structView = {};
  const PAINT = [[0.07, 0.17, 0.1], [0.36, 0.38, 0.4], [0.3, 0.08, 0.05], [0.5, 0.45, 0.37], [0.11, 0.11, 0.12]];
  let scene = null, mat = null, matPiece = null, depth = null, U = null, own = null, items = new Map();

  const FS_HEAD = /* glsl */`
    uniform vec3 uPaint; uniform float uInsp, uClip; uniform vec3 uO, uN; uniform sampler2D tNoise;
    varying vec3 vW; varying vec3 vObj; varying float vDeck;`;
  function patch(sh, clip) {
    Object.assign(sh.uniforms, own, { uO: U.uO, uN: U.uN, tNoise: U.tNoise, uClip: { value: clip ? 1 : 0 } });
    sh.vertexShader = 'attribute float aDeck; varying vec3 vW; varying vec3 vObj; varying float vDeck;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vObj = transformed; vDeck = aDeck;`);
    sh.fragmentShader = FS_HEAD + '\n' + sh.fragmentShader
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (uClip > 0.5 && uInsp < 0.5 && dot(vW - uO, uN) > 0.02) discard;`)
      .replace('#include <map_fragment>', /* glsl */`
        // texture space: object space for fallen pieces (rust stays on the steel), world space for the standing bridge
        vec3 tp = uClip > 0.5 ? vW : vObj;
        float n1 = texture2D(tNoise, tp.xz * 0.21 + tp.y * 0.07).r, n2 = texture2D(tNoise, vec2(tp.x * 0.9 + tp.z * 0.6, tp.y * 0.18)).g;
        float n3 = texture2D(tNoise, tp.xz * 1.7 + tp.y * 1.3).b;
        float rust = smoothstep(0.58, 0.8, n1 * 0.7 + n2 * 0.45 + n3 * 0.15 - 0.08);      // patches + downward streaks (n2 stretched in y)
        vec3 paint = uPaint * (0.85 + 0.3 * n3);
        vec3 rustC = mix(vec3(0.24, 0.085, 0.03), vec3(0.4, 0.16, 0.05), n3);
        vec3 c = mix(paint, rustC, rust);
        float rough = mix(0.5, 0.9, rust), metal = 0.0;
        if (vDeck > 0.5) {
          // checker plate: worn bare steel, diamond treads, rust in the low spots
          vec2 g = fract(vec2(dot(tp.xz, vec2(0.707, 0.707)), dot(tp.xz, vec2(-0.707, 0.707))) * 14.0) - 0.5;
          float tread = (1.0 - smoothstep(0.18, 0.32, abs(g.x) * 0.35 + abs(g.y)));
          c = mix(vec3(0.3, 0.3, 0.3) * (0.8 + 0.4 * n3), rustC, rust * 0.6);
          rough = mix(0.45, 0.85, rust) - 0.1 * tread; metal = (1.0 - rust) * 0.85;
          c *= 0.85 + 0.25 * tread;
        }
        if (!gl_FrontFacing) { c = vec3(0.55, 0.55, 0.56); rough = 0.35; metal = 1.0; }   // the cut through the steel
        diffuseColor.rgb = c;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = rough;')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = metal;');
  }
  function mkMat(clip) {
    const m = new T.MeshStandardMaterial({ roughness: 0.6, metalness: 0, side: T.DoubleSide });
    m.onBeforeCompile = sh => patch(sh, clip);
    m.customProgramCacheKey = () => 'struct' + (clip ? 'C' : 'P');
    return m;
  }

  /* ---------- geometry ---------- */
  function Buf() { return { p: [], n: [], d: [], idx: [], v: 0 }; }
  // box from a to b, section w (across, horizontal-ish) x h (perpendicular), up hint
  function box(B, a, b, w, h, deck, upH) {
    const ax = b.x - a.x, ay = b.y - a.y, az = b.z - a.z, L = Math.hypot(ax, ay, az) || 1e-3;
    const dx = ax / L, dy = ay / L, dz = az / L;
    let ux = upH ? upH.x : 0, uy = upH ? upH.y : 1, uz = upH ? upH.z : 0;
    if (Math.abs(dx * ux + dy * uy + dz * uz) > 0.95) { ux = 1; uy = 0; uz = 0; }
    // s = d x up (across), t = s x d (perpendicular)
    let sx = dy * uz - dz * uy, sy = dz * ux - dx * uz, sz = dx * uy - dy * ux; const sl = Math.hypot(sx, sy, sz); sx /= sl; sy /= sl; sz /= sl;
    const tx = sy * dz - sz * dy, ty = sz * dx - sx * dz, tz = sx * dy - sy * dx;
    const hw = w / 2, hh = h / 2;
    const faces = [[sx, sy, sz, hw, tx, ty, tz, hh], [-sx, -sy, -sz, hw, -tx, -ty, -tz, hh], [tx, ty, tz, hh, -sx, -sy, -sz, hw], [-tx, -ty, -tz, hh, sx, sy, sz, hw]];
    for (const [nx, ny, nz, off, ex, ey, ez, ext] of faces) {
      const v0 = B.v;
      for (const [u, e] of [[0, -1], [1, -1], [1, 1], [0, 1]]) {
        const P = u ? b : a;
        B.p.push(P.x + nx * off + ex * ext * e, P.y + ny * off + ey * ext * e, P.z + nz * off + ez * ext * e); B.n.push(nx, ny, nz); B.d.push(deck ? 1 : 0); B.v++;
      }
      B.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    }
    // end caps
    for (const [P, sg] of [[a, -1], [b, 1]]) {
      const v0 = B.v;
      for (const [es, et] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { B.p.push(P.x + sx * hw * es + tx * hh * et, P.y + sy * hw * es + ty * hh * et, P.z + sz * hw * es + tz * hh * et); B.n.push(dx * sg, dy * sg, dz * sg); B.d.push(deck ? 1 : 0); B.v++; }
      if (sg > 0) B.idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3); else B.idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
    }
  }
  function members(B, list, ux, uz, gussets) {
    const across = { x: -uz, y: 0, z: ux };            // the bridge's lateral direction
    for (const m of list) {
      if (m.kind === 3) box(B, m.a, m.b, m.w, 0.03, true, { x: 0, y: 1, z: 0 });
      else if (m.kind === 2) box(B, m.a, m.b, m.w, m.h, false, { x: ux, y: 0, z: uz });
      else box(B, m.a, m.b, m.w, m.h, false, across);   // side-truss members: section faces across the bridge
    }
    // gusset plates: 0.4 x 0.4 x 12 mm in the truss plane at the side-truss nodes
    for (const g of gussets) box(B, { x: g.x - ux * 0.2, y: g.y, z: g.z - uz * 0.2 }, { x: g.x + ux * 0.2, y: g.y, z: g.z + uz * 0.2 }, 0.2, 0.4, false, across);
  }
  function mesh(B, m) {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(B.p, 3));
    g.setAttribute('normal', new T.Float32BufferAttribute(B.n, 3));
    g.setAttribute('aDeck', new T.Float32BufferAttribute(B.d, 1));
    g.setIndex(B.idx); g.computeBoundingSphere();
    const o = new T.Mesh(g, m); o.castShadow = o.receiveShadow = true; o.frustumCulled = false;
    return o;
  }

  SV.init = function (sc) {
    scene = sc; U = SS.terrain.uniforms;
    own = { uPaint: { value: new T.Color(0.07, 0.17, 0.1) }, uInsp: { value: 0 } };
    mat = mkMat(true); matPiece = mkMat(false);
    depth = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking });
    depth.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { uO: U.uO, uN: U.uN, uInsp: own.uInsp });
      sh.vertexShader = 'varying vec3 vW;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = 'uniform vec3 uO, uN; uniform float uInsp; varying vec3 vW;\n' + sh.fragmentShader.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n if (uInsp < 0.5 && dot(vW - uO, uN) > 0.02) discard;');
    };
    depth.customProgramCacheKey = () => 'structDepth';
  };
  SV.clear = function () { for (const [, it] of items) { scene.remove(it.mesh); it.mesh.geometry.dispose(); } items.clear(); };
  SV.frame = function (S, view) {
    if (!scene) return;
    own.uInsp.value = view.insp || 0;
    const L = S.structs || [];
    if (!L.length && !items.size) return;
    const seen = new Set();
    if (L.length) { const p = PAINT[L[0].look] || PAINT[0]; own.uPaint.value.setRGB(p[0], p[1], p[2]); }
    for (const st of L) {
      seen.add(st);
      let it = items.get(st);
      if (it && it.ver === st.ver) continue;
      if (it) { scene.remove(it.mesh); it.mesh.geometry.dispose(); items.delete(st); }
      if (st.fallen) continue;
      const B = Buf(), list = [], gus = [];
      for (const m of st.mem) if (m.on) list.push({ a: st.nodes[m.a], b: st.nodes[m.b], kind: m.kind, w: m.w, h: m.h });
      const used = new Set();
      for (const m of st.mem) if (m.on && m.kind !== 3 && m.kind !== 2) for (const k of [m.a, m.b]) used.add(k);
      for (const k of used) gus.push(st.nodes[k]);
      members(B, list, st.ux, st.uz, gus);
      const me = mesh(B, mat); me.customDepthMaterial = depth;
      scene.add(me); items.set(st, { mesh: me, ver: st.ver, tris: B.idx.length / 3 });
    }
    for (const [st, it] of items) if (!seen.has(st)) { scene.remove(it.mesh); it.mesh.geometry.dispose(); items.delete(st); }
  };
  /* a fallen piece (body space members) */
  SV.pieceGroup = function (b) {
    if (!scene) return null;
    const B = Buf(), g = new T.Group();
    let ux = 1, uz = 0;
    const ch = b.members.find(m => m.kind === 0);
    if (ch) { const dx = ch.b.x - ch.a.x, dz = ch.b.z - ch.a.z, l = Math.hypot(dx, dz) || 1; ux = dx / l; uz = dz / l; }
    members(B, b.members, ux, uz, []);
    const me = mesh(B, matPiece);
    g.add(me);
    return { group: g, meshes: [me] };
  };
  /* a loose I-beam (body x = its length, web vertical): two flanges + the web */
  SV.girderGroup = function (G) {
    const B = Buf(), hl = G.L / 2, up = { x: 0, y: 1, z: 0 }, tf = 0.0107, tw = 0.0071 * 1.6;
    box(B, { x: -hl, y: G.H / 2 - tf / 2, z: 0 }, { x: hl, y: G.H / 2 - tf / 2, z: 0 }, G.B, tf * 1.4, false, up);
    box(B, { x: -hl, y: -G.H / 2 + tf / 2, z: 0 }, { x: hl, y: -G.H / 2 + tf / 2, z: 0 }, G.B, tf * 1.4, false, up);
    box(B, { x: -hl, y: 0, z: 0 }, { x: hl, y: 0, z: 0 }, tw, G.H - 2 * tf, false, up);
    const me = mesh(B, matPiece);
    return { meshes: [me] };
  };
  // triangles of the standing structures now in the scene (fallen pieces are counted by the body view)
  SV.stats = () => { let tris = 0; for (const [, it] of items) tris += it.tris; return { structs: items.size, tris }; };
})(window.SS = window.SS || {});
