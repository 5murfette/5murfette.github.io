/* render/seccut.js — P85: the yellow cut in the overview (V). User 2026-10-12: "when doing the overview with V make the
 * entire 3d map
 * visible with a clear yellow cut where the current view is".  P118c: ONE clean cut (the QA1 sweep found a tangle of
 * loops, beads and a plane
 * that z-fought the cut face).
 *   - ONE crisp yellow line along the ground where the plane meets the map: the SKYLINE of the section (the upper
 *     envelope of the solid, column by column, from S.section.V; it stops at the waterline: the sea floor is not part
 *     of it). The full outline also holds every arch, overhang and cave of the cut (a tangle of loops on the canyon, a
 *     squiggle network inside the island through the 45 % copy), so only cave worlds use it (geom/edge.js chains: the
 *     cave outline IS the cut there). A strip with shared vertices and mitred corners (no overlap: the old per-segment
 *     quads blended twice at every joint = a bead), sitting on the air side of the profile (the half inside the rock
 *     would be hidden), width follows the camera distance (quantised, geometry rebuilt only when the step or the
 *     section changes), drawn twice: depth-tested at full strength and, through the terrain, at 45 % so the cut reads
 *     from any angle. Pulled a little toward the camera in depth (polygon offset: in a cave world the cut face lies in
 *     the very same plane and the ribbon z-fought with it into yellow dots) and true yellow (sRGB: a raw linear colour
 *     came out orange);
 *   - a faint translucent yellow plane showing the slice extent (the plane x the world box), double sided, no depth
 *     write, with a crisp border of constant 3 px (screen derivatives: no 1 px line primitive).
 * Everything fades with the overview (insp 0..1). End of the World: the plane only (the rocks' cut line would mark
 * nothing). Presentation only. A cave world (its rock has no outside: the only surfaces are the tunnels) also gets the
 * edges of the world box on the far side of the plane, a thin warm frame round the back half, so the section face reads
 * as the front of a cut block (the tunnels inside it are the glass of render/terrain.js, the face is the cap). */
(function (SS) {
  'use strict';
  const T = window.THREE, SC = SS.secCut = {};
  let scene = null, ribA = null, ribB = null, plane = null, frame = null, secRef = null, wStep = -99, pKey = '', fKey = '';
  const YEL = 0xffd400;
  SC.info = { chains: 0, points: 0, kept: 0, strips: 0, frame: 0 };
  function ribMat(depth, a) {
    return new T.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: depth, fog: false, side: T.DoubleSide,
      polygonOffset: depth, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      uniforms: { uA: { value: a }, uC: { value: new T.Color(YEL) } },
      vertexShader: 'attribute vec2 rib; varying vec2 vR; void main(){ vR = rib; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uA; uniform vec3 uC; varying vec2 vR; void main(){ float e = 1.0 - smoothstep(0.62, 1.0, abs(vR.y)); gl_FragColor = vec4(uC, uA * e);\n#include <colorspace_fragment>\n}'
    });
  }
  function planeMat() {
    return new T.ShaderMaterial({
      transparent: true, depthWrite: false, side: T.DoubleSide, fog: false, polygonOffset: true, polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
      uniforms: { uA: { value: 0 }, uC: { value: new T.Color(YEL) }, uSize: { value: new T.Vector2(1, 1) } },
      vertexShader: 'attribute vec2 aUv; varying vec2 vUv; void main(){ vUv = aUv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: `uniform float uA;
        uniform vec3 uC;
        uniform vec2 uSize;
        varying vec2 vUv;
        void main(){
          vec2 q = min(vUv, 1.0 - vUv) * uSize;                     // metres to the nearest border on each axis
          float d = min(q.x, q.y), px = d / max(fwidth(d), 1e-5);   // ... and in pixels: the border is 3 px wide at any distance
          float edge = 1.0 - smoothstep(1.0, 3.0, px);
          gl_FragColor = vec4(uC, uA * mix(0.14, 0.9, edge));
          #include <colorspace_fragment>
        }`
    });
  }
  SC.init = function (sc) {
    scene = sc;
    ribA = new T.Mesh(new T.BufferGeometry(), ribMat(true, 0)); ribB = new T.Mesh(new T.BufferGeometry(), ribMat(false, 0));
    ribA.renderOrder = 8;
    ribB.renderOrder = 8;
    ribA.frustumCulled = ribB.frustumCulled = false;
    ribA.visible = ribB.visible = false;
    plane = new T.Mesh(new T.BufferGeometry(), planeMat());
    plane.renderOrder = 6; plane.frustumCulled = false; plane.visible = false;
    frame = new T.LineSegments(
      new T.BufferGeometry(),
      new T.LineBasicMaterial({ color: 0xc9a46a, transparent: true, opacity: 0, depthWrite: false, depthTest: false, fog: false })
    );
    frame.renderOrder = 7; frame.frustumCulled = false; frame.visible = false;
    scene.add(ribA);
    scene.add(ribB);
    scene.add(plane);
    scene.add(frame);
  };
  /* the lattice rectangle on the far side of the section plane (t <= 0): the footprint of the back half of the world
   * box (the box clipped by the half plane, Sutherland-Hodgman) */
  function behindPoly(S) {
    const W = SS.world,
      n = SS.plane.nrm(S),
      O = S.O,
      R = [[0, 0], [W.SX, 0], [W.SX, W.SZ], [0, W.SZ]],
      out = [],
      f = p => (p[0] - O.x) * n.x + (p[1] - O.z) * n.z;
    for (let i = 0; i < 4; i++) {
      const a = R[i], b = R[(i + 1) % 4], fa = f(a), fb = f(b);
      if (fa <= 0) out.push(a);
      if ((fa < 0 && fb > 0) || (fa > 0 && fb < 0)) {
        const k = fa / (fa - fb);
        out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
      }
    }
    return out;
  }
  /* a strip along a polyline: two vertices per point (the point moved along its normal by c + w and c - w), consecutive
   * points joined by two
   * triangles: shared vertices, so no overlap and no gap (an overlap of the 45 % copy drew a bright bead at every
   * joint). P = [s, y, ns, ny, ...] per point (position in the plane, unit normal toward the air); the strip lies in
   * the section plane o + s d */
  function strip(G, P, n, closed, w, c) {
    const first = G.nv;
    for (let k = 0; k < n; k++) {
      const s = P[k * 4], y = P[k * 4 + 1], ns = P[k * 4 + 2], ny = P[k * 4 + 3];
      for (let q = 0; q < 2; q++) {
        const off = q ? c - w : c + w;
        G.pos.push(G.O.x + (s + ns * off) * G.d.x, y + ny * off, G.O.z + (s + ns * off) * G.d.z);
        G.rib.push(0, q ? -1 : 1);
      }
      if (k > 0) {
        const b = G.nv;
        G.idx.push(b - 2, b - 1, b + 1, b - 2, b + 1, b);
      }
      G.nv += 2;
    }
    if (closed && n > 2) G.idx.push(G.nv - 2, G.nv - 1, first + 1, G.nv - 2, first + 1, first);
    G.strips++;
  }
  /* the cut line of a cave world: every outline chain (geom/edge.js: polylines with the air normal at every point)
   * inside the plane's extent, the cave outline IS the cut there */
  function chainLine(G, S, sec, ex) {
    const E = sec.edge || SS.edge.build(S, sec), P = [];
    for (let q = 0; q < E.nc; q++) {
      const a = E.chain[q * 2], n = E.chain[q * 2 + 1];
      let run = 0, all = true;
      P.length = 0;
      const flush = () => {
        if (run > 1) strip(G, P, run, all && E.closed[q] && run === n, G.w, G.c);
        P.length = 0;
        run = 0;
      };
      for (let t = 0; t < n; t++) {
        const s = E.pts[(a + t) * 2];
        if (ex && (s < ex[0] || s > ex[1])) {
          flush();
          all = false;
          continue;
        }
        P.push(s, E.pts[(a + t) * 2 + 1], E.nrm[(a + t) * 2], E.nrm[(a + t) * 2 + 1]); run++; G.kept++;
      }
      flush();
    }
    G.points = E.np;
  }
  /* the cut line of every other world: the skyline of the section, ONE line along the ground surface (the upper
   * envelope of the solid, the lattice column by
   * column; sec.V[j * ns + i] > 0 is solid at s = s0 + i H, y = j H). The full outline also holds every arch, overhang
   * and cave of the cut (a tangle of loops on the canyon) and the sea floor; the overview wants the one line where the
   * plane meets the ground, so it stops at the waterline */
  function skyLine(G, sec, ex, sea) {
    const ns = sec.ns, ny = sec.ny, V = sec.V, H = SS.world.H, wet = SS.world.has_sea();
    let S_ = [], Y_ = [];
    const flush = () => {
      const m = S_.length;
      if (m > 1) {
        const P = [];
        // (the unit normal of the segment k -> k + 1, up when the line runs along +s)
        const seg = k => {
          const ds = S_[k + 1] - S_[k], dy = Y_[k + 1] - Y_[k], l = Math.hypot(ds, dy) || 1;
          return [-dy / l, ds / l];
        };
        for (let k = 0; k < m; k++) {
          const a = k > 0 ? seg(k - 1) : null, b = k < m - 1 ? seg(k) : null;
          let x = (a ? a[0] : 0) + (b ? b[0] : 0), y = (a ? a[1] : 0) + (b ? b[1] : 0);
          const l = Math.hypot(x, y) || 1;
          x /= l;
          y /= l;
          // (a miter: the strip keeps its width round a corner, never more than x 2)
          const q = a && b ? Math.max(0.5, x * a[0] + y * a[1]) : 1;
          P.push(S_[k], Y_[k], x / q, y / q);
        }
        strip(G, P, m, false, G.w, G.c);
      }
      G.kept += m; S_ = []; Y_ = [];
    };
    for (let i = 0; i < ns; i++) {
      const s = sec.s0 + i * H;
      let j = ny - 1;
      while (j >= 0 && V[j * ns + i] <= 0) j--;
      let y = -1;
      if (j >= 0) {
        y = j * H;
        if (j + 1 < ny) {
          const a = V[j * ns + i], b = V[(j + 1) * ns + i];
          y += H * a / (a - b);
        }
      }
      // (all air / outside the world box / under the sea)
      if (j < 0 || (ex && (s < ex[0] || s > ex[1])) || (wet && y < sea + 0.05)) {
        flush();
        continue;
      }
      S_.push(s); Y_.push(y);
    }
    flush(); G.points = ns;
  }
  function ribbon(S, sec, w, ex) {
    const G = {
      O: { x: sec.O.x, z: sec.O.z },
      d: { x: Math.cos(sec.theta), z: Math.sin(sec.theta) },
      w,
      c: 0.55 * w,
      pos: [],
      rib: [],
      idx: [],
      nv: 0,
      strips: 0,
      kept: 0,
      points: 0
    };
    if (SS.world.under) chainLine(G, S, sec, ex);
    else skyLine(G, sec, ex, SS.terrain.uniforms.uSea.value);
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array(G.pos), 3));
    g.setAttribute('rib', new T.BufferAttribute(new Float32Array(G.rib), 2));
    g.setIndex(new T.BufferAttribute(new Uint32Array(G.idx), 1));
    const info = SC.info;
    info.points = G.points;
    info.kept = G.kept;
    info.strips = G.strips;
    info.chains = SS.world.under && sec.edge ? sec.edge.nc : 0;
    return g;
  }
  /* the slice x the world box: s range along the plane's direction from S.O */
  function extent(S) {
    const W = SS.world, c = Math.cos(S.theta), sn = Math.sin(S.theta);
    let lo = -1e9, hi = 1e9;
    for (const [o, d, m] of [[S.O.x, c, W.SX], [S.O.z, sn, W.SZ]]) {
      if (Math.abs(d) < 1e-6) {
        if (o < 0 || o > m) return null;
        continue;
      }
      let a = (0 - o) / d, b = (m - o) / d;
      if (a > b) {
        const t = a;
        a = b;
        b = t;
      }
      lo = Math.max(lo, a); hi = Math.min(hi, b);
    }
    return hi > lo ? [lo, hi] : null;
  }
  SC.frame = function (S, view, camera, insp, dist) {
    if (!scene) return;
    const on = insp > 0.02 && S.section && SS.world && !SS.world.flat && !S.dim2d;
    ribA.visible = ribB.visible = plane.visible = frame.visible = !!on;
    if (!on) {
      SC.shown = 0;
      return;
    }
    const W = SS.world, eow = !!W.eow, a = Math.min(1, insp * 1.2);
    SC.shown = a;
    // the plane (rebuilt only when the plane or the world box changes)
    const key = [S.O.x.toFixed(2), S.O.z.toFixed(2), S.theta.toFixed(4), W.SX, W.SZ, W.SY].join();
    if (key !== pKey) {
      pKey = key;
      const ex = extent(S), c = Math.cos(S.theta), sn = Math.sin(S.theta), y0 = 0, y1 = W.SY;
      if (ex) {
        const P = [[ex[0], y0], [ex[1], y0], [ex[1], y1], [ex[0], y1]].map(q => [S.O.x + q[0] * c, q[1], S.O.z + q[0] * sn]);
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(new Float32Array(P.flat()), 3));
        g.setAttribute('aUv', new T.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2)); g.setIndex([0, 1, 2, 0, 2, 3]);
        plane.geometry.dispose();
        plane.geometry = g;
        plane.material.uniforms.uSize.value.set(ex[1] - ex[0], y1 - y0);
        plane.userData.ok = true;
      } else plane.userData.ok = false;
    }
    plane.visible = !!plane.userData.ok;
    plane.material.uniforms.uA.value = a;
    // a cave world: the edges of the box behind the plane (rebuilt with the plane): the footprint polygon at the floor
    // and at the roof and an edge up at every corner
    frame.visible = !!W.under && plane.visible;
    if (frame.visible) {
      if (key !== fKey) {
        fKey = key;
        const P = behindPoly(S), n = P.length, v = [];
        for (let i = 0; i < n; i++) {
          const p0 = P[i], p1 = P[(i + 1) % n];
          for (const y of [0, W.SY]) v.push(p0[0], y, p0[1], p1[0], y, p1[1]);
          v.push(p0[0], 0, p0[1], p0[0], W.SY, p0[1]);
        }
        frame.geometry.dispose();
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(new Float32Array(v), 3));
        frame.geometry = g;
        SC.info.frame = v.length / 6;
      }
      frame.material.opacity = 0.5 * a;
    } else SC.info.frame = 0;
    // the cut line: width follows the distance (x1.5 steps), rebuilt when the step or the section changes
    const showLine = !eow;
    ribA.visible = ribB.visible = showLine;
    if (showLine) {
      const step = Math.round(Math.log(Math.max(0.11, Math.min(3.0, dist * 0.008)) / 0.11) / Math.log(1.5));
      if (S.section !== secRef || step !== wStep) {
        secRef = S.section;
        wStep = step;
        const g = ribbon(S, S.section, 0.11 * Math.pow(1.5, step), extent(S));
        ribA.geometry.dispose();
        ribB.geometry.dispose();
        ribA.geometry = g;
        ribB.geometry = g.clone();
      }
      ribA.material.uniforms.uA.value = a; ribB.material.uniforms.uA.value = 0.45 * a;
    }
  };
})(window.SS = window.SS || {});
