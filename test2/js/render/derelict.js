/* render/derelict.js — the crashed derelict ship's biomechanical glow (P37 W5). The hull itself is voxels (sim/derelict.js:
 * OBSIDIAN, drawn by the terrain shader: glossy black glass); this adds the lime light of the ship: a pulsing pod on every
 * rib inside the corridor and on the outer crests (small emissive ellipsoids) and a soft additive halo round each. A pod is
 * removed when the wall voxel it is anchored in is blown away. Presentation only (Math.random is fine).
 * Porting: an instanced emissive mesh + a billboard glow per pod (or a point-light cluster).
 * API: SS.derelictView.init(scene, tx), reset(S), clear(), frame(S, view, camera, dt). */
(function (SS) {
  'use strict';
  const T = window.THREE, DV = SS.derelictView = {};
  let scene = null, tex = null, group = null, mesh = null, halo = null, pods = [], phase = null, alive = null, t0 = 0, chk = 0;
  DV.init = function (sc, tx) { scene = sc; tex = tx && tx.glow; };
  DV.clear = function () {
    if (group) { scene.remove(group); group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
    group = mesh = halo = null; pods = []; alive = null;
  };
  DV.reset = function (S) {
    DV.clear();
    const d = S.derelict; if (!d || !d.pods.length || !scene) return;
    pods = d.pods; const n = pods.length;
    group = new T.Group(); group.frustumCulled = false;
    mesh = new T.InstancedMesh(new T.IcosahedronGeometry(1, 1), new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false }), n);
    mesh.instanceColor = new T.InstancedBufferAttribute(new Float32Array(n * 3), 3); mesh.frustumCulled = false;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3); phase = new Float32Array(n); alive = new Uint8Array(n).fill(1);
    for (let i = 0; i < n; i++) { pos[i * 3] = pods[i].x; pos[i * 3 + 1] = pods[i].y; pos[i * 3 + 2] = pods[i].z; phase[i] = Math.random() * 6.28; col[i * 3] = 0.5; col[i * 3 + 1] = 1; col[i * 3 + 2] = 0.2; }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(pos, 3)); g.setAttribute('color', new T.BufferAttribute(col, 3));
    halo = new T.Points(g, new T.PointsMaterial({ map: tex, size: 4.2, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.8, depthWrite: false, blending: T.AdditiveBlending, fog: false }));
    halo.frustumCulled = false; halo.renderOrder = 4;
    group.add(mesh, halo); scene.add(group);
  };
  const m4 = new T.Matrix4(), q = new T.Quaternion(), sc = new T.Vector3(), ps = new T.Vector3(), cc = new T.Color();
  DV.frame = function (S, view, camera, dt) {
    if (!group) return;
    t0 += dt || 0.016; chk -= dt || 0.016;
    const W = SS.world;
    if (chk <= 0) { chk = 0.5; for (let i = 0; i < pods.length; i++) alive[i] = W.sample(pods[i].ax, pods[i].ay, pods[i].az) > 0 ? 1 : 0; }
    const hc = halo.geometry.getAttribute('color');
    for (let i = 0; i < pods.length; i++) {
      const p = pods[i], pulse = 0.55 + 0.45 * Math.sin(t0 * 1.3 + phase[i]), a = alive[i];
      const s = a ? (p.k ? 0.34 : 0.16) * (0.85 + 0.25 * pulse) : 0;
      ps.set(p.x, p.y, p.z); sc.set(s, s * 1.4, s); m4.compose(ps, q, sc); mesh.setMatrixAt(i, m4);
      cc.setRGB(0.55 * (0.5 + pulse), 1.0 * (0.5 + pulse), 0.2); mesh.setColorAt(i, cc);
      const h = a ? (0.3 + 0.7 * pulse) * (p.k ? 1 : 0.7) : 0; hc.setXYZ(i, 0.35 * h, 0.95 * h, 0.1 * h);
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; hc.needsUpdate = true;
  };
})(window.SS = window.SS || {});
