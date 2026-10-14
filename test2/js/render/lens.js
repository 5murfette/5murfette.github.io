/* render/lens.js — gravitational lensing around black holes (P29c, user 2026-10-08: "make a gravitational lensing
 * effect that distorts increasingly more the view behind the black hole"). Three.js specific; presentation only.
 * While a black hole exists the frame is rendered into an off-screen target (MSAA, linear HDR) and composited to the
 * screen through a point-mass lens per hole: every pixel at angle theta from the hole samples the scene at the lens
 * equation's source position beta = theta (1 - thetaE² / theta²) (thetaE: the Einstein radius): the background bends
 * around the hole more and more toward it, an Einstein ring forms at thetaE, inside it the mirrored second image; a
 * black event horizon (no light escapes) with a thin bright photon ring at its edge. The effect fades to nothing at
 * R_FX x thetaE, so there is no seam with the rest of the frame. Without holes the normal render path runs (no cost).
 * P38-R8: the same pass draws SHOCK RINGS (a blast's refraction front: a thin moving band where the air is compressed
 * bends the view, a hot core shimmers): SS.lens.shock(x, y, z, R, strength) adds one (R = metres reached, ~0.45 s); the
 * pass only runs while a ring (or hole) lives. API: SS.lens.render(renderer, scene, camera, holes) — holes: [{ x, y, z,
 * s }] (s = the hole's visual scale, m); LN.active() = a ring lives. Porting: a post-process pass (any engine) over the
 * scene colour buffer; per hole 4 floats. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const LN = SS.lens = {};
  // Einstein / horizon radius per unit of visual scale; effect reach
  const MAXR = 3, RING_T = 0.5, MAXH = 4, R_E = 2.6, R_H = 1.0, R_FX = 2.4;
  const rings = [];
  let bloomOn = false;                     // { x, y, z, R, k, t }
  let rt = null, quadScene = null, quadCam = null, mat = null;
  const sunDirV = new T.Vector3(), v = new T.Vector3(), r = new T.Vector3(), size = new T.Vector2();
  function init(renderer) {
    rt = new T.WebGLRenderTarget(4, 4, {
      type: T.HalfFloatType,
      stencilBuffer: true,                                       // (the worms' x-ray silhouette: render/actors.js)
      generateMipmaps: bloomOn,
      minFilter: bloomOn ? T.LinearMipmapLinearFilter : T.LinearFilter,
      samples: window.LNS != null ? window.LNS : SS.view && SS.view.msaa ? Math.min(2, SS.view.msaa()) : 2
    });
    mat = new T.ShaderMaterial({
      uniforms: { tScene: { value: rt.texture }, uRes: { value: new T.Vector2(1, 1) }, uN: { value: 0 },
        uH: { value: [0, 1, 2, 3].map(() => new T.Vector4()) }, uNR: { value: 0 }, uR: { value: [0, 1, 2].map(() => new T.Vector4()) },
        uRk: { value: [0, 1, 2].map(() => new T.Vector2()) },
        uNZ: { value: 0 }, uZ: { value: [0, 1, 2, 3].map(() => new T.Vector4()) }, uT: { value: 0 },
        uGA: { value: new T.Vector4(1, 0, 0, 0) }, uBl: { value: 0.55 }, uSunP: { value: new T.Vector4(0, 0, 0, 0) },
        uSunC: { value: new T.Vector3() }, uSh: { value: new T.Vector3() }, uHi: { value: new T.Vector3(1, 1, 1) } },
      depthTest: false, depthWrite: false, defines: bloomOn ? { BLOOM: 1 } : {},
      vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tScene;
        uniform float uBl;
        uniform vec4 uGA, uSunP;
        uniform vec3 uSunC;
        uniform vec3 uSh, uHi;
        uniform vec2 uRes;
        uniform float uT;
        uniform int uNZ;
        uniform vec4 uZ[4];
        uniform int uN;
        uniform vec4 uH[${MAXH}];
        uniform int uNR;
        uniform vec4 uR[${MAXR}];
        uniform vec2 uRk[${MAXR}];
        varying vec2 vUv;
        void main(){
          vec2 asp = vec2(uRes.x / uRes.y, 1.0), uv = vUv;
          float dark = 1.0, lit = 0.0;
          vec3 ring = vec3(0.0);
          for (int i = 0; i < ${MAXH}; i++) {
            if (i >= uN) break;
            vec2 c = uH[i].xy;
            float thE = uH[i].z, rh = uH[i].w, R = thE * ${R_FX.toFixed(2)};
            vec2 dv = (vUv - c) * asp;
            float rr = length(dv);
            if (rr >= R) continue;
            float f = 1.0 - smoothstep(R * 0.45, R, rr);                          // full lensing inside, none at R
            vec2 src = c + dv * (1.0 - thE * thE / max(rr * rr, 1e-7)) / asp;      // the lens equation
            uv = mix(uv, src, f);
            dark *= smoothstep(rh, rh * 1.2, rr);                                 // the event horizon
            float ringU = (rr - rh * 1.16) / (rh * 0.07);
            ring += vec3(1.0, 0.86, 0.62) * exp(-ringU * ringU) * 0.9;   // photon ring
          }
          // shock rings: x,y = centre uv, z = front radius, w = amplitude; uRk = (band width, core radius)
          for (int i = 0; i < ${MAXR}; i++) {
            if (i >= uNR) break;
            vec2 dv = (vUv - uR[i].xy) * asp;
            float rr = length(dv), an = atan(dv.y, dv.x), sd = uR[i].x * 17.0 + uR[i].y * 11.0;
            // P87: an irregular front (wobbling radius, patchy strength), never a clean circle
            float wob = 0.07 * sin(an * 3.0 + sd) + 0.045 * sin(an * 7.0 + sd * 2.3) + 0.025 * sin(an * 13.0 + sd * 4.1),
              pat = 0.35 + 0.65 * smoothstep(-0.6, 0.7, sin(an * 4.0 + sd * 1.7) * 0.6 + sin(an * 9.0 + sd * 0.7) * 0.4);
            rr *= 1.0 - wob;
            float band = (rr - uR[i].z) / uRk[i].x, rareU = (band + 1.8) * 0.6, coreU = rr / uRk[i].y;
            float d = uR[i].w * pat * (exp(-band * band) * (band > 0.0 ? 1.0 : 0.6) - 0.5 * exp(-rareU * rareU));
            d += uR[i].w * 0.35 * exp(-coreU * coreU) * sin(rr * 260.0 - uR[i].z * 90.0);          // the hot core shimmers
            uv += dv / max(rr, 1e-4) / asp * d;
            // P73: the compressed band is a touch brighter, the rarefaction behind it a touch darker (schlieren)
            lit += uR[i].w * 1.6 * pat * (exp(-band * band * 1.5) - 0.7 * exp(-rareU * rareU));
          }
          // heat haze over fires: x,y = the flame top (uv), z = half width (uv-height units), w = strength
          for (int i = 0; i < 4; i++) {
            if (i >= uNZ) break;
            vec2 dv = (vUv - uZ[i].xy) * asp;
            float R = uZ[i].z;
            float m = smoothstep(R * 1.3, R * 0.2, abs(dv.x)) * smoothstep(-R * 0.5, R * 0.1, dv.y) * smoothstep(R * 3.4, R * 0.4, dv.y) * uZ[i].w;
            if (m <= 0.0) continue;
            vec2 q = vec2(vUv.x * 46.0, vUv.y * 38.0 - uT * 2.6);                       // rising ripples (cheap value noise, scrolled up)
            vec2 ip = floor(q), fp = fract(q);
            fp = fp * fp * (3.0 - 2.0 * fp);
            float a0 = fract(sin(dot(ip, vec2(127.1, 311.7))) * 43758.5), a1 = fract(sin(dot(ip + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5);
            float a2 = fract(sin(dot(ip + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5),
              a3 = fract(sin(dot(ip + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5);
            float n = mix(mix(a0, a1, fp.x), mix(a2, a3, fp.x), fp.y) - 0.5;
            uv += vec2(n * 0.9, sin(q.y * 1.7 + n * 6.0) * 0.25) * 0.0075 * m / asp;
          }
          vec3 col = textureLod(tScene, clamp(uv, vec2(0.001), vec2(0.999)), 0.0).rgb * dark * (1.0 + lit) + ring;
          #ifdef BLOOM
          // P61 bloom: the bright parts (HDR above the knee) of the scene's mip chain (lods 2, 3, 4: 5 taps each),
          // added before the tone map
          {
            vec3 bl = vec3(0.0);
            vec2 px = 1.0 / uRes;
            for (int k = 0; k < 3; k++) {
              float lod = 2.0 + float(k), st = exp2(lod) * 1.6;
              vec2 o = px * st;
              vec3 a = vec3(0.0);
              a += textureLod(tScene, uv, lod).rgb * 0.4;
              a += textureLod(tScene, uv + vec2(o.x, 0.0), lod).rgb * 0.15 + textureLod(tScene, uv - vec2(o.x, 0.0), lod).rgb * 0.15;
              a += textureLod(tScene, uv + vec2(0.0, o.y), lod).rgb * 0.15 + textureLod(tScene, uv - vec2(0.0, o.y), lod).rgb * 0.15;
              bl += max(a - 1.15, 0.0) * (k == 0 ? 0.6 : k == 1 ? 0.8 : 1.0);
            }
            col += min(bl, vec3(1.5)) * uBl;
          }
          #endif
          // P56 sun glare: a soft warm veil round the sun on the screen (uSunP = uv, strength), added before the tone
          // map
          vec2 sd = (vUv - uSunP.xy) * asp;
          float sr = dot(sd, sd);
          col += uSunC * uSunP.w * (exp(-sr * 14.0) * 0.55 + exp(-sr * 2.4) * 0.25);
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          // P56 grade (after the tone map, in display space): saturation (uGA.x), S-curve contrast (uGA.y), cool
          // shadows / warm highlights (uSh, uHi), vignette (uGA.z), a 1/255 dither against banding in dark gradients
          // (uGA.w)
          vec3 g = gl_FragColor.rgb;
          float lum = dot(g, vec3(0.2126, 0.7152, 0.0722));
          g = mix(vec3(lum), g, uGA.x);
          g = mix(g, g * g * (3.0 - 2.0 * g), uGA.y);
          g += uSh * (1.0 - smoothstep(0.0, 0.5, lum));
          g *= mix(vec3(1.0), uHi, smoothstep(0.35, 0.95, lum));
          vec2 vq = (vUv - 0.5) * vec2(1.0, 0.85);
          g *= 1.0 - uGA.z * smoothstep(0.18, 0.62, dot(vq, vq) * 2.2);
          g += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) * uGA.w;
          gl_FragColor = vec4(max(g, 0.0), 1.0);
        }`
    });
    SS.section.exempt(mat, 'post: full-screen lens quad');
    LN.applyGrade();
    quadScene = new T.Scene(); quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const q = new T.Mesh(new T.PlaneGeometry(2, 2), mat);
    q.frustumCulled = false;
    quadScene.add(q);
  }
  LN.shock = function (x, y, z, R, k, T) {
    if (rings.length >= MAXR) rings.shift();
    rings.push({ x, y, z, R: Math.max(2, R), k: k || 1, t: 0, T: T || RING_T });
  };
  LN.active = () => rings.length > 0;
  /* the grade of the frame (view.js applyLook): sat, con, vig, shadow tint [r, g, b], highlight tint [r, g, b]; init()
   * is lazy */
  const NEUTRAL = { sat: 1, con: 0, vig: 0, sh: [0, 0, 0], hi: [1, 1, 1] };
  let GR = NEUTRAL;
  let sunDir = null, sunCol = [1, 1, 1], sunK = 0;
  LN.sun = function (dir, col, k) {
    sunDir = dir;
    sunCol = col;
    sunK = k;
  };
  LN.grade = function (g) {
    GR = g || NEUTRAL;
    if (mat) LN.applyGrade();
  };
  LN.applyGrade = function () {
    mat.uniforms.uGA.value.set(GR.sat, GR.con, GR.vig, 1 / 255);
    mat.uniforms.uSh.value.set(GR.sh[0], GR.sh[1], GR.sh[2]);
    mat.uniforms.uHi.value.set(GR.hi[0], GR.hi[1], GR.hi[2]);
  };
  LN.bloom = function (on) { bloomOn = !!on; };                  // P61: before the first frame (init reads it); quality-gated by view.js
  LN.clear = function () { rings.length = 0; };
  LN.tick = function (dt) {
    for (let i = rings.length - 1; i >= 0; i--)
      if ((rings[i].t += dt) > rings[i].T) rings.splice(i, 1);
  };
  LN.render = function (renderer, scene, camera, holes, haze) {
    if (!rt) init(renderer);
    renderer.getDrawingBufferSize(size);
    if (rt.width !== size.x || rt.height !== size.y) rt.setSize(size.x, size.y);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, camera);
    // per hole: screen centre (uv), Einstein and horizon radius (uv-height units, from a world offset along camera
    // right)
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
    // shock rings: front radius in uv-height units from a metre offset along camera right
    let nr = 0;
    for (const g of rings) {
      v.set(g.x, g.y, g.z).project(camera);
      if (v.z > 1 || v.z < -1) continue;
      const cx = v.x * 0.5 + 0.5, cy = v.y * 0.5 + 0.5, f = g.t / g.T, front = g.R * (1 - Math.exp(-4.5 * f)) / (1 - Math.exp(-4.5));
      v.set(g.x, g.y, g.z).addScaledVector(r, 1).project(camera);
      const px = Math.hypot((v.x * 0.5 + 0.5 - cx) * size.x / size.y, v.y * 0.5 + 0.5 - cy);
      mat.uniforms.uR.value[nr].set(cx, cy, front * px, 0.02 * g.k * (1 - f) * (1 - f) * Math.min(1, 6 / g.R + 0.3));
      mat.uniforms.uRk.value[nr].set(Math.max(0.01, 0.35 * px * (0.6 + f)), Math.max(0.01, 0.6 * g.R * px * 0.3));
      nr++;
    }
    mat.uniforms.uNR.value = nr;
    // heat haze: the strongest fire clusters (render/flame.js): flame top, half width in uv-height units
    let nz = 0;
    if (haze)
      for (let i = 0; i < haze.n && nz < 4; i++) {
        v.set(haze.d[i * 4], haze.d[i * 4 + 1], haze.d[i * 4 + 2]).project(camera);
        if (v.z > 1 || v.z < -1) continue;
        const cx = v.x * 0.5 + 0.5, cy = v.y * 0.5 + 0.5;
        v.set(haze.d[i * 4], haze.d[i * 4 + 1], haze.d[i * 4 + 2]).addScaledVector(r, 1 + 1.2 * haze.d[i * 4 + 3]).project(camera);
        const px = Math.hypot((v.x * 0.5 + 0.5 - cx) * size.x / size.y, v.y * 0.5 + 0.5 - cy);
        mat.uniforms.uZ.value[nz++].set(cx, cy, px, 0.35 + 0.65 * haze.d[i * 4 + 3]);
      }
    if (sunDir && sunK > 0) {
      v.copy(camera.position).add(sunDirV.set(sunDir[0], sunDir[1], sunDir[2]).multiplyScalar(200)); v.project(camera);
      const vis = v.z < 1 ? 1 : 0, ex = Math.max(Math.abs(v.x), Math.abs(v.y));
      mat.uniforms.uSunP.value.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5, 0, vis * sunK * Math.max(0, 1 - Math.max(0, ex - 1.0) * 1.6));
      mat.uniforms.uSunC.value.set(sunCol[0], sunCol[1], sunCol[2]);
    } else mat.uniforms.uSunP.value.w = 0;
    mat.uniforms.uNZ.value = nz; mat.uniforms.uT.value += 1 / 60;
    mat.uniforms.uN.value = n; mat.uniforms.uRes.value.set(size.x, size.y);
    renderer.setRenderTarget(prev);
    renderer.render(quadScene, quadCam);
  };
  // (P38-R4: the pre-warm creates the target and the quad before the first hole)
  LN.ensure = function () {
    if (!rt) init();
  };
  LN.stats = () => ({ on: !!rt, size: rt ? [rt.width, rt.height] : null, samples: rt ? rt.samples : 0 });
})(window.SS = window.SS || {});
