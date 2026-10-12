/* render/seccut.js — P85: the yellow cut in the overview (V). User 2026-10-12: "when doing the overview with V make the entire 3d map
 * visible with a clear yellow cut where the current view is".
 *   - a ribbon along the section outline (S.section.outline, the plane x terrain intersection in (s, y)), crisp yellow, width follows the camera
 *     distance (quantised, geometry rebuilt only when the step or the section changes), drawn twice: depth-tested at full strength and, through
 *     the terrain, at 35 % so the cut reads from any angle (no z-fight: the ribbon crosses the surface, it is never coplanar with it);
 *   - a faint translucent yellow plane with a frame showing the slice extent (the plane x the world box), double sided, no depth write.
 * Everything fades with the overview (insp 0..1). End of the World: the plane only (the rocks' cut line would mark nothing). Presentation only. */
(function (SS) {
  'use strict';
  const T = window.THREE, SC = SS.secCut = {};
  let scene = null, ribA = null, ribB = null, plane = null, frame = null, secRef = null, wStep = -99, wasEow = false, pKey = '';
  const YEL = 0xffd400;
  function ribMat(depth, a) {
    return new T.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: depth, fog: false,
      uniforms: { uA: { value: a }, uC: { value: new T.Color(YEL) } },
      vertexShader: 'attribute vec2 rib; varying vec2 vR; void main(){ vR = rib; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uA; uniform vec3 uC; varying vec2 vR; void main(){ float e = 1.0 - smoothstep(0.62, 1.0, abs(vR.y)); gl_FragColor = vec4(uC, uA * e); }'
    });
  }
  SC.init = function (sc) {
    scene = sc;
    ribA = new T.Mesh(new T.BufferGeometry(), ribMat(true, 0)); ribB = new T.Mesh(new T.BufferGeometry(), ribMat(false, 0));
    ribA.renderOrder = 8; ribB.renderOrder = 8; ribA.frustumCulled = ribB.frustumCulled = false; ribA.visible = ribB.visible = false;
    plane = new T.Mesh(new T.BufferGeometry(), new T.MeshBasicMaterial({ color: YEL, transparent: true, opacity: 0, side: T.DoubleSide, depthWrite: false, fog: false, toneMapped: false }));
    plane.renderOrder = 6; plane.frustumCulled = false; plane.visible = false;
    frame = new T.LineLoop(new T.BufferGeometry(), new T.LineBasicMaterial({ color: YEL, transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false }));
    frame.renderOrder = 9; frame.frustumCulled = false; frame.visible = false;
    scene.add(ribA); scene.add(ribB); scene.add(plane); scene.add(frame);
  };
  function ribbon(sec, w) {
    const L = sec.outline, n = L.length / 4, d = { x: Math.cos(sec.theta), z: Math.sin(sec.theta) };
    const pos = new Float32Array(n * 12), rib = new Float32Array(n * 8), idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
      const s0 = L[i * 4], y0 = L[i * 4 + 1], s1 = L[i * 4 + 2], y1 = L[i * 4 + 3];
      let ps = -(y1 - y0), py = s1 - s0; const l = Math.hypot(ps, py) || 1; ps /= l; py /= l;
      const pts = [[s0 + ps * w, y0 + py * w, 1], [s0 - ps * w, y0 - py * w, -1], [s1 + ps * w, y1 + py * w, 1], [s1 - ps * w, y1 - py * w, -1]];
      for (let k = 0; k < 4; k++) {
        const o = (i * 4 + k) * 3; pos[o] = sec.O.x + pts[k][0] * d.x; pos[o + 1] = pts[k][1]; pos[o + 2] = sec.O.z + pts[k][0] * d.z;
        rib[(i * 4 + k) * 2] = 0; rib[(i * 4 + k) * 2 + 1] = pts[k][2];
      }
      idx.set([i * 4, i * 4 + 1, i * 4 + 3, i * 4, i * 4 + 3, i * 4 + 2], i * 6);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('rib', new T.BufferAttribute(rib, 2)); g.setIndex(new T.BufferAttribute(idx, 1));
    return g;
  }
  /* the slice x the world box: s range along the plane's direction from S.O */
  function extent(S) {
    const W = SS.world, c = Math.cos(S.theta), sn = Math.sin(S.theta);
    let lo = -1e9, hi = 1e9;
    for (const [o, d, m] of [[S.O.x, c, W.SX], [S.O.z, sn, W.SZ]]) {
      if (Math.abs(d) < 1e-6) { if (o < 0 || o > m) return null; continue; }
      let a = (0 - o) / d, b = (m - o) / d; if (a > b) { const t = a; a = b; b = t; }
      lo = Math.max(lo, a); hi = Math.min(hi, b);
    }
    return hi > lo ? [lo, hi] : null;
  }
  SC.frame = function (S, view, camera, insp, dist) {
    if (!scene) return;
    const on = insp > 0.02 && S.section && SS.world && !S.dim2d;
    ribA.visible = ribB.visible = plane.visible = frame.visible = !!on;
    if (!on) { SC.shown = 0; return; }
    const W = SS.world, eow = !!W.eow, a = Math.min(1, insp * 1.2);
    SC.shown = a;
    // the plane + frame (rebuilt only when the plane or the world box changes)
    const key = [S.O.x.toFixed(2), S.O.z.toFixed(2), S.theta.toFixed(4), W.SX, W.SZ, W.SY].join();
    if (key !== pKey) {
      pKey = key; const ex = extent(S), c = Math.cos(S.theta), sn = Math.sin(S.theta), y0 = 0, y1 = W.SY;
      if (ex) {
        const P = [[ex[0], y0], [ex[1], y0], [ex[1], y1], [ex[0], y1]].map(q => [S.O.x + q[0] * c, q[1], S.O.z + q[0] * sn]);
        const flat = new Float32Array(P.flat()); const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(flat, 3)); g.setIndex([0, 1, 2, 0, 2, 3]);
        plane.geometry.dispose(); plane.geometry = g;
        const g2 = new T.BufferGeometry(); g2.setAttribute('position', new T.BufferAttribute(flat.slice(), 3)); frame.geometry.dispose(); frame.geometry = g2;
      } else { plane.visible = frame.visible = false; }
    }
    plane.material.opacity = 0.14 * a; frame.material.opacity = 0.85 * a;
    // the cut line: width follows the distance (x1.5 steps), rebuilt when the step or the section changes
    const showLine = !eow;
    ribA.visible = ribB.visible = showLine;
    if (showLine) {
      const step = Math.round(Math.log(Math.max(0.11, Math.min(3.0, dist * 0.008)) / 0.11) / Math.log(1.5));
      if (S.section !== secRef || step !== wStep) { secRef = S.section; wStep = step; const g = ribbon(S.section, 0.11 * Math.pow(1.5, step)); ribA.geometry.dispose(); ribB.geometry.dispose(); ribA.geometry = g; ribB.geometry = g.clone(); }
      ribA.material.uniforms.uA.value = a; ribB.material.uniforms.uA.value = 0.35 * a;
    }
  };
})(window.SS = window.SS || {});
