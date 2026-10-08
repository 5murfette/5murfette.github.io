/* render/materials.js — shaders: sky dome, grass blades, glowing collision outline (+ legacy water until render/water.js).
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

  /* Sky dome: painted panorama mapped by azimuth and elevation; storm darkening + lightning flash.
   * K1: the panoramas tile horizontally (tools/sky_tile.py: quilting cut + pyramid blend), repeated twice around the
   * dome (180° each, RepeatWrapping; the old MirroredRepeat showed reflected "butterfly" clouds at az 0 and ±π). The
   * atan wrap at ±π takes u from a second parameterisation whose own wrap is at az 0 (pick the smaller fwidth), so
   * the mip level never jumps (no one-pixel line); toward the zenith the colour turns azimuth-independent
   * (`uZenith`, the average of the top rows) instead of pinching the top row into a star. */
  MAT.sky = function (sky) {
    return new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, fog: false,
      uniforms: { tSky: { value: sky.tex }, uHorizon: { value: new T.Color().setRGB(sky.avg[0], sky.avg[1], sky.avg[2], T.SRGBColorSpace) }, uTurn: { value: 0 }, uDark: { value: 0 }, uFlash: { value: 0 }, uTint: { value: new T.Color(1, 1, 1) }, uZenith: { value: new T.Color().setRGB(sky.top[0], sky.top[1], sky.top[2], T.SRGBColorSpace) } },
      vertexShader: `varying vec3 vD; void main(){ vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tSky; uniform vec3 uHorizon, uTint, uZenith; uniform float uTurn, uDark, uFlash; varying vec3 vD;
        void main(){
          vec3 d = normalize(vD);
          float az = atan(d.z, d.x) + uTurn;
          float u1 = az / 3.14159265;                       // wraps at az ±π (2 tiles: same texel, huge derivative)
          float u2 = u1 < 0.0 ? u1 + 2.0 : u1;              // same texel, wraps at az 0 instead
          float u = fwidth(u1) <= fwidth(u2) + 1e-6 ? u1 : u2;
          float el = asin(clamp(d.y, -1.0, 1.0));
          float v = (el + 0.10) / 0.95;
          vec3 c = texture2D(tSky, vec2(u, clamp(1.0 - v, 0.002, 0.998))).rgb;
          vec3 zen = texture2D(tSky, vec2(u, 0.004)).rgb * vec3(0.82, 0.9, 1.02);
          zen = mix(zen, uZenith * vec3(0.82, 0.9, 1.02), smoothstep(1.1, 1.6, v));   // no pinch at the pole
          c = mix(c, zen, smoothstep(0.95, 1.25, v));
          c = mix(c, uHorizon * vec3(0.55, 0.68, 0.85), (1.0 - smoothstep(-0.25, -0.02, v)));
          c *= uTint;
          float l = dot(c, vec3(0.3, 0.59, 0.11));
          c = mix(c, vec3(l) * vec3(0.55, 0.58, 0.64), uDark * 0.75) * (1.0 - uDark * 0.45);
          c += uFlash * vec3(0.75, 0.8, 1.0) * (0.4 + 0.6 * l);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    });
  };

  /* Legacy water (replaced by render/water.js when present). */
  MAT.water = function (tx, sky, heightTex) {
    return new T.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: {
        tNoise: { value: tx.noise }, tHeight: { value: heightTex }, tSky: { value: sky.tex }, uTime: { value: 0 }, uSea: { value: SS.world.SEA },
        uSun: { value: new T.Vector3(0.5, 0.6, 0.3).normalize() }, uHorizon: { value: new T.Color(0xf6c89a) },
        uDeep: { value: new T.Color(0x0d3a5c) }, uShallow: { value: new T.Color(0x2fa7a8) }, uFog: { value: new T.Color(0xf3d2b0) }, uFogD: { value: 0.0026 }
      },
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tNoise, tHeight, tSky; uniform float uTime, uSea, uFogD; uniform vec3 uSun, uHorizon, uDeep, uShallow, uFog;
        varying vec3 vW;
        float hgt(vec2 p){
          return texture2D(tNoise, p*0.045 + vec2(uTime*0.010, uTime*0.006)).a * 0.6
               + texture2D(tNoise, p*0.11 - vec2(uTime*0.017, -uTime*0.012)).a * 0.3
               + texture2D(tNoise, p*0.33 + vec2(-uTime*0.03, uTime*0.025)).g * 0.1;
        }
        void main(){
          vec2 p = vW.xz; float e = 0.12;
          float h0 = hgt(p), hx = hgt(p + vec2(e, 0.0)), hz = hgt(p + vec2(0.0, e));
          vec3 n = normalize(vec3((h0 - hx) * 2.2, 1.0, (h0 - hz) * 2.2));
          vec3 V = normalize(cameraPosition - vW);
          vec2 huv = p / 96.0;
          float inside = step(0.0, huv.x) * step(huv.x, 1.0) * step(0.0, huv.y) * step(huv.y, 1.0);
          vec2 outD = max(max(-huv, huv - 1.0), 0.0) * 96.0;
          float ground = mix(1.2 - length(outD) * 0.25, texture2D(tHeight, huv).r * 40.0, inside);
          float depth = uSea - ground;
          float land = step(depth, 0.0);
          depth = mix(depth, 1.6, land);
          vec3 col = mix(uShallow, uDeep, smoothstep(0.4, 4.5, depth));
          float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
          vec3 R = reflect(-V, n);
          float rel = asin(clamp(R.y, 0.0, 1.0));
          vec3 refl = texture2D(tSky, vec2(atan(R.z, R.x) / 3.14159265, clamp(1.0 - (rel + 0.10) / 0.95, 0.002, 0.998))).rgb;
          refl = mix(refl, uHorizon, 0.25);
          col = mix(col, refl, 0.08 + 0.72 * fres);
          vec3 H = normalize(uSun + V);
          float spec = pow(max(dot(n, H), 0.0), 260.0) * 3.0 + pow(max(dot(n, H), 0.0), 40.0) * 0.12;
          col += vec3(1.0, 0.86, 0.66) * spec;
          float fn = texture2D(tNoise, p*0.5 + uTime*0.03).b;
          float band = 0.5 + 0.5 * sin(depth * 9.0 - uTime * 1.7 + fn * 4.0);
          float foam = (1.0 - smoothstep(0.0, 1.1, depth)) * smoothstep(0.35, 0.9, band * 0.6 + fn * 0.6);
          foam = max(foam, (1.0 - smoothstep(0.0, 0.25, depth))) * (1.0 - land);
          col = mix(col, vec3(0.97, 0.98, 1.0), foam * 0.85);
          float a = mix(0.62, 0.93, smoothstep(0.0, 3.0, depth));
          a = max(a, foam) * (1.0 - land);
          float fd = length(cameraPosition - vW);
          float f = 1.0 - exp(-fd * fd * uFogD * uFogD);
          col = mix(col, uFog, f);
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`
    });
  };

  /* Grass blades: instanced over the whole world, clipped to the section slab in the vertex shader.
   * Reads the simulation surface state (cover / dryness / char / burning) and the wind field uniforms. */
  MAT.grass = function (tx) {
    const m = new T.MeshStandardMaterial({ roughness: 0.85, side: T.DoubleSide });
    const U = m.userData.uniforms = {
      uTime: { value: 0 }, tNoise: { value: tx.noise }, tSurf: { value: null }, uO: { value: new T.Vector3() }, uN: { value: new T.Vector3(0, 0, 1) }, uHalf: { value: C.HALF }, uBack: { value: C.HALF },
      uWind: { value: new T.Vector3(1, 0, 0) }, uWhirl: { value: [new T.Vector4(), new T.Vector4(), new T.Vector4(), new T.Vector4()] },
      uBase: { value: new T.Color(0.09, 0.22, 0.05) }, uTip: { value: new T.Color(0.55, 0.78, 0.25) }, uDryTip: { value: new T.Color(0.78, 0.66, 0.36) }, uSnow: { value: 0 }
    };
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U);
      sh.vertexShader = /* glsl */`
        uniform float uTime, uHalf, uBack, uSnow; uniform sampler2D tNoise, tSurf; uniform vec3 uO, uN, uWind; uniform vec4 uWhirl[4];
        varying float vH; varying vec3 vTint; varying vec4 vSurf;
      ` + sh.vertexShader
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
          vH = position.y;
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          vSurf = texture2D(tSurf, (ip.xz * 2.0 + 0.5) / 193.0);   // texel centre of column round(x / 0.5)
          float tI = dot(ip - uO, uN);                       // slab behind slice zero only (nothing in front of it)
          float keep = step(tI, 0.05) * step(-uBack - 0.05, tI) * step(0.04, vSurf.r) * (1.0 - step(0.55, vSurf.b));
          // wind: mean flow + gust noise + whirlwinds (tangential swirl)
          float wn = texture2D(tNoise, ip.xz * 0.03 - uWind.xz * uTime * 0.012).a;
          vec2 w = uWind.xz * (0.35 + 0.9 * wn) * 0.09 + vec2(sin(uTime * 2.1 + ip.x * 0.7 + ip.z * 0.5), cos(uTime * 1.7 + ip.z * 0.6)) * 0.04 * (0.3 + length(uWind.xz) * 0.1);
          for (int i = 0; i < 4; i++) {
            vec4 wh = uWhirl[i]; if (wh.w <= 0.0) continue;
            vec2 r = ip.xz - wh.xy; float d = length(r) + 1e-3;
            float f = wh.w * exp(-d * d / (wh.z * wh.z * 2.5));
            w += vec2(-r.y, r.x) / d * f * 0.12;
          }
          vec2 sway = w * vH * vH;
          transformed *= keep;
          transformed.y *= 1.0 - uSnow * 0.6;
          vTint = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
            vTint = instanceColor;
          #endif`)
        .replace('#include <project_vertex>', `
          vec4 mvPosition = vec4(transformed, 1.0);
          mvPosition = instanceMatrix * mvPosition;
          mvPosition.xz += sway * keep;
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;`)
        .replace('#include <worldpos_vertex>', `
          #if defined( USE_SHADOWMAP )
            vec4 worldPosition = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          #endif`);
      // back faces keep the up-facing blade normal: DoubleSide would flip it downwards (black blades seen from behind)
      sh.fragmentShader = 'uniform vec3 uBase, uTip, uDryTip; uniform float uTime; varying float vH; varying vec3 vTint; varying vec4 vSurf;\n' + sh.fragmentShader
        .replace('#include <normal_fragment_begin>', T.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'))
        .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
          vec3 tip = mix(uTip, uDryTip, smoothstep(0.35, 0.85, vSurf.g)) * vTint;
          vec3 c = mix(uBase, tip, smoothstep(0.0, 1.0, vH));
          if (vTint.r > 1.5) c = mix(uBase, vec3(1.0, 0.86, 0.2), smoothstep(0.6, 0.95, vH) + 0.3 * vH);
          if (vTint.b > 1.5) c = mix(uBase, vec3(0.98, 0.95, 1.0), smoothstep(0.6, 0.95, vH) + 0.3 * vH);
          c = mix(c, vec3(0.06, 0.05, 0.04), smoothstep(0.1, 0.5, vSurf.b));          // scorched
          diffuseColor.rgb = c;`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += vSurf.a * vec3(3.0, 1.0, 0.2) * smoothstep(0.3, 1.0, vH) * (0.7 + 0.3 * sin(uTime * 13.0 + vH * 9.0));`);
    };
    m.customProgramCacheKey = () => 'grass3';
    return m;
  };

  /* Glowing ribbon for the collision outline. */
  MAT.outline = function () {
    return new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false,
      uniforms: { uTime: { value: 0 }, uColor: { value: new T.Color(0xfff0b0) }, uAlpha: { value: 1 } },
      vertexShader: `attribute vec2 rib; varying vec2 vR; void main(){ vR = rib; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime, uAlpha; uniform vec3 uColor; varying vec2 vR;
        void main(){
          float a = abs(vR.y);
          float core = (1.0 - smoothstep(0.0, 0.32, a)), glow = pow(1.0 - a, 2.2) * 0.35;
          float pulse = 0.82 + 0.18 * sin(vR.x * 1.4 - uTime * 3.0);
          gl_FragColor = vec4(uColor * (core * 1.25 + glow) * pulse * uAlpha, 1.0);
        }`
    });
  };
})(window.SS = window.SS || {});
