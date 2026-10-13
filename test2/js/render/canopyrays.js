/* render/canopyrays.js (P116) — light leaking through the palm crowns (Three.js; presentation only, reads S.trees and the look's sun, never writes the sim).
 * A few soft, warm, additive light shafts per palm run from the crown along the sun's direction to the ground (crepuscular rays through the fronds' gaps):
 * one instanced draw call of cylindrical billboards (each quad turns about its own axis to face the camera in the vertex shader), a long soft fade at both ends and
 * across, a slow flicker in the wind. Strength follows the sun: a low sun (dusk, the golden day light) shows them, noon, night, rain, storms and fog do not.
 * Beach only (the palm species of the map), not in End of the World / caves, never in front of the slice (the automatic section rule wraps the ShaderMaterial).
 * Cost: ~3 quads per palm (<= 90), one draw, no overdraw beyond their own area. API: init(scene), clear(), onEvent(), frame(S, view, camera, dt), info(). */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const RV = SS.rayView = {};
  const MAXQ = 96, PER = 3;
  let scene = null, mesh = null, geo = null, attrs = null, uni = null, acc = 0, nQ = 0, lastInt = 0;

  RV.init = function (sc) { scene = sc; };
  RV.clear = function () { if (mesh) { if (mesh.parent) mesh.parent.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); mesh = null; } nQ = 0; };
  RV.onEvent = function () {};
  RV.gain = 2.2;                                              // (tuning / tools)
  RV.info = () => ({ quads: nQ, intensity: +lastInt.toFixed(3) });

  function make() {
    geo = new T.InstancedBufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(new Float32Array([0, -0.5, 0, 0, 0.5, 0, 1, -0.5, 0, 1, 0.5, 0]), 3));
    geo.setIndex([0, 2, 1, 1, 2, 3]);
    attrs = { base: new T.InstancedBufferAttribute(new Float32Array(MAXQ * 3), 3), axis: new T.InstancedBufferAttribute(new Float32Array(MAXQ * 3), 3), sz: new T.InstancedBufferAttribute(new Float32Array(MAXQ * 3), 3) };
    geo.setAttribute('aBase', attrs.base); geo.setAttribute('aAxis', attrs.axis); geo.setAttribute('aSz', attrs.sz);
    geo.instanceCount = 0;
    const TU = SS.terrain.uniforms;
    uni = { uTime: { value: 0 }, uInt: { value: 0 }, uCol: { value: new T.Color(1.0, 0.8, 0.5) }, uO: TU.uO, uN: TU.uN };
    const mat = new T.ShaderMaterial({
      uniforms: uni, transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false,
      vertexShader: `
        attribute vec3 aBase, aAxis, aSz; varying vec3 vQ; varying vec3 vWp; varying float vF;
        void main() {
          float u = position.x, v = position.y;
          vec3 ax = normalize(aAxis);
          vec3 P0 = aBase + ax * (u * aSz.x);
          vec3 vd = normalize(P0 - cameraPosition);
          vec3 right = normalize(cross(ax, vd) + vec3(1e-5));
          vec3 P = P0 + right * v * aSz.y * (0.35 + 0.9 * u);
          vQ = vec3(u, v, aSz.z + 0.0); vWp = P;
          vF = 1.0 - smoothstep(0.4, 0.78, -vd.y);              // seen from straight above the shafts would be long white scratches: they fade out for a steeply downward view
          gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
        }`,
      fragmentShader: `
        uniform float uTime, uInt; uniform vec3 uCol, uO, uN; varying vec3 vQ; varying vec3 vWp; varying float vF;
        void main() {
          float u = vQ.x, v = vQ.y;
          float a = smoothstep(0.0, 0.1, u) * (1.0 - smoothstep(0.45, 1.0, u)) * pow(max(0.0, 1.0 - 4.0 * v * v), 1.6);
          a *= 0.65 + 0.35 * sin(uTime * 0.5 + vQ.z * 6.283) * sin(uTime * 0.23 + vQ.z * 3.1);
          float tp = dot(vWp - uO, uN);                       // the section plane: the shafts fade out towards it (no hard cut edge where the slice clips them)
          a *= smoothstep(0.4, -3.5, tp) * vF;
          gl_FragColor = vec4(uCol * a * uInt, 1.0);
        }`
    });
    mat.userData.sectionMargin = 0.5;
    mesh = new T.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 7.4;
    scene.add(mesh);
  }

  RV.frame = function (S, view, camera, dt) {
    if (!scene) return;
    const W = SS.world, bio = (W.features && W.features.biome) || W.biome || S.biome;
    const L = view.look, tod = view.tod;
    // strength: the sun must be low (elevation < ~35 deg), the sky clear enough; none at night, in storms / rain / fog, in caves
    let k = 0;
    if (bio === 'beach' && !W.under && !W.eow && L && L.sunDir && tod !== 'night') {
      const el = L.sunDir[1], we = S.weather || {};
      k = M.clamp((0.62 - el) / 0.5, 0, 1) * (1 - M.clamp((we.rain || 0) * 1.6 + (we.cloud || 0) * 0.8, 0, 1)) * (view.wxKind === 'fog' ? 0.3 : 1);
    }
    lastInt = k * (tod === 'dusk' ? 0.14 : 0.07) * RV.gain;
    if (!(lastInt > 0.005)) { if (mesh) mesh.visible = false; return; }
    if (!mesh) make();
    mesh.visible = true; uni.uTime.value = view.time; uni.uInt.value = lastInt;
    acc += dt;
    if (acc < 0.5 && nQ) return;
    acc = 0;
    // (re)build the instances: the palms near the view (the section's focus), their crowns' current tops
    const sd = L.sunDir, ax = -sd[0], ay = -sd[1], az = -sd[2], al = Math.hypot(ax, ay, az) || 1;
    const fx = view.camT ? view.camT.x : W.MX, fz = view.camT ? view.camT.z : W.MZ;
    const list = [];
    for (const t of S.trees || []) { if (t.sp !== 4 || !t.alive) continue; const d = Math.hypot(t.x - fx, t.z - fz); if (d < 55) list.push([d, t]); }
    list.sort((a, b) => a[0] - b[0] || a[1].id - b[1].id);
    let n = 0;
    for (const [, t] of list) {
      let lv = 0; for (const l of t.leaf) if (l.s >= 0) lv = Math.max(lv, l.f); if (lv < 0.3) continue;       // a stripped crown lets nothing through
      for (let q = 0; q < PER && n < MAXQ; q++, n++) {
        const h1 = M.hash3(t.id, q, 1), h2 = M.hash3(t.id, q, 2), h3 = M.hash3(t.id, q, 3), h4 = M.hash3(t.id, q, 4);
        const ox = (h1 - 0.5) * 3.2, oz = (h2 - 0.5) * 3.2, jx = (h3 - 0.5) * 0.07, jz = (h4 - 0.5) * 0.07;
        const by = t.top - 0.6 - h3 * 1.2, hgt = Math.max(1, by - W.top_at(t.x + ox, t.z + oz)), sinEl = Math.max(0.08, -ay / al);
        const len = M.clamp(hgt / sinEl, 4, 24) * (0.8 + 0.4 * h1);
        attrs.base.setXYZ(n, t.x + ox, by, t.z + oz); attrs.axis.setXYZ(n, ax / al + jx, ay / al, az / al + jz);
        attrs.sz.setXYZ(n, len, 0.9 + 1.6 * h2, h4);
      }
    }
    nQ = n; geo.instanceCount = n;
    attrs.base.needsUpdate = attrs.axis.needsUpdate = attrs.sz.needsUpdate = true;
  };
})(window.SS = window.SS || {});
