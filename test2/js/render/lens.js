/* render/lens.js — gravitational lensing around black holes (P29c, user 2026-10-08: "make a gravitational lensing
 * effect that distorts increasingly more the view behind the black hole"). Three.js specific; presentation only.
 * While a black hole exists the frame is rendered into an off-screen target (MSAA, linear HDR) and composited to the
 * screen through a point-mass lens per hole: every pixel at angle theta from the hole samples the scene at the lens
 * equation's source position beta = theta (1 - thetaE² / theta²) (thetaE: the Einstein radius): the background bends
 * around the hole more and more toward it, an Einstein ring forms at thetaE, inside it the mirrored second image; a
 * black event horizon (no light escapes) with a thin bright photon ring at its edge. The effect fades to nothing at
 * R_FX x thetaE, so there is no seam with the rest of the frame. Without holes the normal render path runs (no cost).
 * API: SS.lens.render(renderer, scene, camera, holes) — holes: [{ x, y, z, s }] (s = the hole's visual scale, m).
 * Porting: a post-process pass (any engine) over the scene colour buffer; per hole 4 floats. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const LN = SS.lens = {};
  const MAXH = 4, R_E = 2.6, R_H = 1.0, R_FX = 2.4;        // Einstein / horizon radius per unit of visual scale; effect reach
  let rt = null, quadScene = null, quadCam = null, mat = null;
  const v = new T.Vector3(), r = new T.Vector3(), size = new T.Vector2();
  function init(renderer) {
    rt = new T.WebGLRenderTarget(4, 4, { type: T.HalfFloatType, samples: 4 });
    mat = new T.ShaderMaterial({
      uniforms: { tScene: { value: rt.texture }, uRes: { value: new T.Vector2(1, 1) }, uN: { value: 0 },
        uH: { value: [0, 1, 2, 3].map(() => new T.Vector4()) } },
      depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tScene; uniform vec2 uRes; uniform int uN; uniform vec4 uH[${MAXH}];
        varying vec2 vUv;
        void main(){
          vec2 asp = vec2(uRes.x / uRes.y, 1.0), uv = vUv;
          float dark = 1.0; vec3 ring = vec3(0.0);
          for (int i = 0; i < ${MAXH}; i++) {
            if (i >= uN) break;
            vec2 c = uH[i].xy; float thE = uH[i].z, rh = uH[i].w, R = thE * ${R_FX.toFixed(2)};
            vec2 dv = (vUv - c) * asp; float rr = length(dv);
            if (rr >= R) continue;
            float f = 1.0 - smoothstep(R * 0.45, R, rr);                          // full lensing inside, none at R
            vec2 src = c + dv * (1.0 - thE * thE / max(rr * rr, 1e-7)) / asp;      // the lens equation
            uv = mix(uv, src, f);
            dark *= smoothstep(rh, rh * 1.2, rr);                                 // the event horizon
            ring += vec3(1.0, 0.86, 0.62) * exp(-pow((rr - rh * 1.16) / (rh * 0.07), 2.0)) * 0.9;   // photon ring
          }
          vec3 col = texture2D(tScene, clamp(uv, vec2(0.001), vec2(0.999))).rgb * dark + ring;
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    });
    quadScene = new T.Scene(); quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const q = new T.Mesh(new T.PlaneGeometry(2, 2), mat); q.frustumCulled = false; quadScene.add(q);
  }
  LN.render = function (renderer, scene, camera, holes) {
    if (!rt) init(renderer);
    renderer.getDrawingBufferSize(size);
    if (rt.width !== size.x || rt.height !== size.y) rt.setSize(size.x, size.y);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, camera);
    // per hole: screen centre (uv), Einstein and horizon radius (uv-height units, from a world offset along camera right)
    let n = 0;
    r.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    for (const h of holes) {
      if (n >= MAXH) break;
      v.set(h.x, h.y, h.z).project(camera);
      if (v.z > 1 || v.z < -1) continue;                                          // behind the camera
      const cx = v.x * 0.5 + 0.5, cy = v.y * 0.5 + 0.5;
      v.set(h.x, h.y, h.z).addScaledVector(r, h.s).project(camera);
      const px = Math.hypot((v.x * 0.5 + 0.5 - cx) * size.x / size.y, v.y * 0.5 + 0.5 - cy);   // 1 m of scale in uv-y units
      mat.uniforms.uH.value[n++].set(cx, cy, px * R_E, px * R_H);
    }
    mat.uniforms.uN.value = n; mat.uniforms.uRes.value.set(size.x, size.y);
    renderer.setRenderTarget(prev);
    renderer.render(quadScene, quadCam);
  };
  LN.stats = () => ({ on: !!rt, size: rt ? [rt.width, rt.height] : null });
})(window.SS = window.SS || {});
