/* render/materials.js — shaders: sky dome, grass blades, glowing collision outline (+ legacy water until
 * render/water.js).
 * Terrain shaders live in render/terrain.js, water in render/water.js, fire in render/fx.js.
 * Porting: the GLSL bodies map directly to HLSL/ShaderGraph custom functions. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG;
  const MAT = SS.mat = {};
  /* free the GPU resources of an object tree removed from the scene: geometries, materials (+ their maps) unless
   * flagged userData.shared or in `keep`. (Disposing a geometry that is still shared elsewhere is safe in three.js: it
   * is uploaded again on its next use.) Porting: the engine's own resource release on despawn. */
  MAT.disposeTree = function (obj, keep) {
    if (!obj) return;
    obj.traverse(o => {
      if (o.geometry && !(o.geometry.userData && o.geometry.userData.shared)) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) {
        if (!m || (m.userData && m.userData.shared) || (keep && keep.has(m))) continue;
        if (m.map && !(m.map.userData && m.map.userData.shared)) m.map.dispose();
        m.dispose();
      }
    });
  };

  /* Grass blades: instanced over the whole world, clipped to the section slab in the vertex shader.
   * Reads the simulation surface state (cover / dryness / char / burning) and the wind field uniforms. */
  MAT.grass = function (tx) {
    const m = new T.MeshStandardMaterial({ roughness: 0.85, side: T.DoubleSide });
    const U = m.userData.uniforms = {
      uTime: { value: 0 }, tNoise: { value: tx.noise }, tSurf: { value: null }, uO: { value: new T.Vector3() },
      uN: { value: new T.Vector3(0, 0, 1) }, uHalf: { value: C.HALF }, uBack: { value: C.HALF },
      uWind: { value: new T.Vector3(1, 0, 0) }, uWhirl: { value: [new T.Vector4(), new T.Vector4(), new T.Vector4(), new T.Vector4()] },
      uWhirlB: { value: [new T.Vector4(), new T.Vector4(), new T.Vector4(), new T.Vector4()] },
      uBlast: { value: [new T.Vector4(0, 0, 1, -1), new T.Vector4(0, 0, 1, -1), new T.Vector4(0, 0, 1, -1), new T.Vector4(0, 0, 1, -1)] },
      uBase: { value: new T.Color(0.09, 0.22, 0.05) }, uTip: { value: new T.Color(0.55, 0.78, 0.25) },
      uDryTip: { value: new T.Color(0.78, 0.66, 0.36) }, uSnow: { value: 0 },
      uAcid: { value: Array.from({ length: 8 }, () => new T.Vector4(0, 0, 0, 0)) }, uOv: { value: 0 }
    };
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U, SS.slab2d.U);
      sh.vertexShader = SS.slab2d.GLSL + /* glsl */`
        uniform float uTime, uHalf, uBack, uSnow, uOv;
        uniform sampler2D tNoise, tSurf;
        uniform vec3 uO, uN, uWind;
        uniform vec4 uWhirl[4], uWhirlB[4], uBlast[4];
        uniform vec4 uAcid[8];
        varying float vH;
        varying vec3 vTint;
        varying vec4 vSurf;
        varying float vAcid;
        varying float vGust;
        varying float vPatch;
      ` + sh.vertexShader
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
          vH = position.y;
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          vSurf = texture2D(tSurf, (ip.xz * 2.0 + 0.5) / 193.0);   // texel centre of column round(x / 0.5)
          float tI = dot(ip - uO, uN);                       // slab behind slice zero only (nothing in front of it)
          // P113: the 2D slab's ground relief (render/slab2d.js): the blade stands on the displaced terrain
          float s2L = 0.0;
          if (uSlab.x > 0.5) s2L = s2H(ip.xz, -tI, s2K(ip.y, 1.0));
          float keep = step(tI, 0.05) * step(-(uSlab.x > 0.5 ? s2Edge(ip.x) : uBack) - 0.05, tI) * step(0.04, vSurf.r) * (1.0 - step(0.55, vSurf.b));
          // uOv = the overview's ease: the blades shrink away as V comes in, the terrain's own grass colour stays
          keep *= 1.0 - smoothstep(0.05, 0.55, uOv);
          // wind: mean flow + gust noise + whirlwinds (tangential swirl)
          float wn = texture2D(tNoise, ip.xz * 0.03 - uWind.xz * uTime * 0.012).a;
          vec2 w = uWind.xz * (0.35 + 0.9 * wn) * 0.09 + vec2(sin(uTime * 2.1 + ip.x * 0.7 + ip.z * 0.5), cos(uTime * 1.7 + ip.z * 0.6)) * 0.04 * (0.3 + length(uWind.xz) * 0.1);
          for (int i = 0; i < 4; i++) {
            vec4 wh = uWhirl[i];
            if (abs(wh.w) <= 0.001 && uWhirlB[i].y <= 0.0) continue;
            vec2 r = ip.xz - wh.xy;
            float d = length(r) + 1e-3;
            float f = wh.w * exp(-d * d / (wh.z * wh.z * 2.5));
            // P65a: the swirl and the inflow (blades lean toward the axis)
            w += vec2(-r.y, r.x) / d * f * 0.12 - r / d * f * 0.05;
            // the outgoing gust ring of a disbanding whirl (ring radius, amplitude)
            vec4 wb = uWhirlB[i];
            if (wb.y > 0.0) {
              float gu = (d - wb.x) / wb.z;
              float g = exp(-gu * gu) * wb.y;
              w += r / d * g * 0.1;
            }
          }
          // P71: the blast wave (x, z, radius, age): the shock reaches a blade after d / 55 s, flattens it outward at
          // once, holds ~1 s, then it springs back with a small overshoot over ~6 s
          float bflat = 0.0;
          for (int i = 0; i < 4; i++) {
            vec4 b = uBlast[i];
            if (b.w < 0.0) continue;
            vec2 r = ip.xz - b.xy;
            float d = length(r) + 1e-3, arr = b.w - d / 55.0;
            if (arr <= 0.0) continue;
            float amp = 1.0 - smoothstep(0.3 * b.z, b.z, d);
            float env = smoothstep(0.0, 0.07, arr) * (1.0 - smoothstep(0.9, 6.5, arr)) * (1.0 + 0.22 * sin(arr * 8.0) * exp(-arr * 0.7));
            float f = amp * max(env, 0.0);
            w += r / d * f * 1.1; bflat = max(bflat, f);
          }
          // P61: travelling gust waves along the wind direction (a slow broad front modulated by a noise), the blades
          // lean and flutter in them
          float wsp = length(uWind.xz), wk = clamp(wsp * 0.22, 0.0, 1.6);
          vec2 wdir = uWind.xz / max(wsp, 1e-3);
          float gph = dot(ip.xz, wdir) * 0.16 - uTime * (0.7 + 0.35 * wsp);
          float gwv = 0.5 + 0.5 * sin(gph + 1.6 * texture2D(tNoise, ip.xz * 0.02).a);
          gwv = gwv * gwv * (0.45 + 0.55 * texture2D(tNoise, ip.xz * 0.05 - wdir * uTime * 0.03).g);
          vGust = gwv * wk;
          w += wdir * gwv * wk * 0.11 + vec2(-wdir.y, wdir.x) * sin(uTime * 3.1 + ip.x * 1.3 + ip.z * 0.9) * 0.025 * gwv * wk;
          vPatch = texture2D(tNoise, ip.xz * 0.045 + 0.31).b;
          // P102: a blade bends, it is never sheared into a spike: the tip leans at most 0.6 of its own length (strong
          // wind / gust / blast summed up to 2-3 m before)
          float hg = max(instanceMatrix[1][1], 0.05), wl = length(w), capW = 0.6 * hg;
          if (wl > capW) w *= capW / wl;
          float lean = clamp(wl / capW, 0.0, 1.0);
          vec2 sway = w * vH * vH;
          float ac = 0.0;                                      // P44: acid pools (xz, r, strength): the grass inside is burnt and flattened
          for (int i = 0; i < 8; i++) {
            vec4 a = uAcid[i];
            if (a.w <= 0.0) continue;
            float d = length(ip.xz - a.xy) / max(a.z, 0.05);
            ac = max(ac, a.w * (1.0 - smoothstep(0.75, 1.45, d)));
          }
          vAcid = ac;
          transformed *= keep; transformed.y *= s2Clear(-tI);
          transformed.y *= (1.0 - 0.28 * lean * lean) * (1.0 - uSnow * 0.6) * (1.0 - 0.75 * ac) * (1.0 - 0.55 * clamp(bflat, 0.0, 1.0));
          transformed.z += ac * vH * 0.25;
          vTint = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            vTint = instanceColor;
          #endif`)
        .replace('#include <project_vertex>', `
          vec4 mvPosition = vec4(transformed, 1.0);
          mvPosition = instanceMatrix * mvPosition;
          mvPosition.xz += sway * keep; mvPosition.y += s2L;
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;`)
        .replace('#include <worldpos_vertex>', /* glsl */`
          #if defined( USE_SHADOWMAP )
            vec4 worldPosition = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          #endif`);
      // back faces keep the up-facing blade normal: DoubleSide would flip it downwards (black blades seen from behind)
      sh.fragmentShader = 'uniform vec3 uBase, uTip, uDryTip; uniform float uTime; varying float vH; varying vec3 vTint; varying vec4 vSurf; varying float vAcid; varying float vGust; varying float vPatch;\n'
        + sh.fragmentShader
          .replace('#include <normal_fragment_begin>', SS.glsl.ONE_SIDED_NORMAL)
          .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
          vec3 tip = mix(uTip, uDryTip, smoothstep(0.35, 0.85, vSurf.g)) * vTint;
          tip *= vec3(0.88 + 0.24 * vPatch, 0.92 + 0.14 * vPatch, 1.12 - 0.28 * vPatch);           // P61: patches of fresher / drier grass
          vec3 c = mix(uBase, tip, smoothstep(0.0, 1.0, vH));
          // the lit undersides of blades bent by a gust
          c *= 1.0 + 0.28 * vGust * smoothstep(0.3, 1.0, vH);
          if (vTint.r > 1.5) c = mix(uBase, vec3(1.0, 0.86, 0.2), smoothstep(0.6, 0.95, vH) + 0.3 * vH);
          if (vTint.b > 1.5) c = mix(uBase, vec3(0.98, 0.95, 1.0), smoothstep(0.6, 0.95, vH) + 0.3 * vH);
          c = mix(c, vec3(0.06, 0.05, 0.04), smoothstep(0.1, 0.5, vSurf.b));          // scorched
          // burnt: dark brown, a sickly yellow tip
          c = mix(c, mix(vec3(0.07, 0.05, 0.025), vec3(0.22, 0.2, 0.05), vH), smoothstep(0.0, 0.7, vAcid));
          diffuseColor.rgb = c;`)
          .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
          totalEmissiveRadiance += vSurf.a * vec3(3.0, 1.0, 0.2) * smoothstep(0.3, 1.0, vH) * (0.7 + 0.3 * sin(uTime * 13.0 + vH * 9.0));`);
    };
    m.customProgramCacheKey = () => 'grass9';
    return m;
  };

  /* Glowing ribbon for the collision outline. */
  MAT.outline = function () {
    return new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color(0xfff0b0) }, uAlpha: { value: 1 } },
      vertexShader: `attribute vec2 rib;
        varying vec2 vR;
        void main(){
          vR = rib;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `uniform float uTime, uAlpha;
        uniform vec3 uColor;
        varying vec2 vR;
        void main(){
          float a = abs(vR.y);
          float core = (1.0 - smoothstep(0.0, 0.32, a)), glow = pow(1.0 - a, 2.2) * 0.35;
          float pulse = 0.92 + 0.08 * sin(vR.x * 1.4 - uTime * 2.0);
          gl_FragColor = vec4(uColor * (core * 1.25 + glow) * pulse * uAlpha, 1.0);
        }`
    });
  };
})(window.SS = window.SS || {});
