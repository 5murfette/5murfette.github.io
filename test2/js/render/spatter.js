/* render/spatter.js — lava spatter clots (Step LV4; Three.js specific). Draws the sim's S.spat as ONE instanced mesh
 * of lumpy spheres (icosphere displaced by 3D value noise per clot), 100 % procedural (no textures):
 *   - instance transform: landed clots = oblate splat (semi-axes a, c, a) with its short axis along the ground normal
 *     and a per-clot yaw; flying clots stretched along the velocity (motion: 1 + |v|·SHUT / r, ≤ 3);
 *   - shading: MeshStandardMaterial (dark vesicular basalt, lit by the scene like everything else) + emissive from a
 *     black-body ramp of the SIM temperatures: the skin Ts on the crust plates and the shell under it (T[NS-2]) in a
 *     3D cellular crack network (seen at the temperature halfway between the two), so a cooling clot goes glowing yellow-orange -> orange plates with cracks -> dark
 *     plates with dull red cracks -> black. Same ramp as render/lava.js glow() (0 = 650 C .. 1 = 1150 C), faded out
 *     between 540 and 690 C (daylight glow threshold ~600 C);
 *   - landed clots follow the bodies' visibility rule (shown where the terrain under them is drawn); flying ones are
 *     always drawn.
 * API: init(scene), clear(), frame(S, view, camera), stats(). Porting: an instanced mesh + an emissive lit material. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const PV = SS.spatView = {};
  const SHUT = 0.012;
  let mesh = null, aSp = null, nDrawn = 0, hot = 0;
  const m4 = new T.Matrix4(), bx = new T.Vector3(), by = new T.Vector3(), bz = new T.Vector3(), tp = new T.Vector3();

  const NOISE = /* glsl */`
    float sh31(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
    float vn3(vec3 p){
      vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(sh31(i), sh31(i + vec3(1, 0, 0)), f.x), mix(sh31(i + vec3(0, 1, 0)), sh31(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(sh31(i + vec3(0, 0, 1)), sh31(i + vec3(1, 0, 1)), f.x), mix(sh31(i + vec3(0, 1, 1)), sh31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }`;
  const FRAG = /* glsl */`
    varying vec3 vObj; varying vec4 vSp;
    vec3 h33(vec3 p){ p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
    // F2 - F1 of a 3D cellular field (~ distance to the nearest crack)
    float cell(vec3 x){
      vec3 n = floor(x), f = fract(x); float d1 = 8.0, d2 = 8.0;
      for (int k = -1; k <= 1; k++) for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec3 g = vec3(float(i), float(j), float(k)), r = g + h33(n + g) - f; float d = dot(r, r);
        if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
      }
      return sqrt(d2) - sqrt(d1);
    }
    // black-body-ish ramp (render/lava.js glow): 0 dull red (~650 C) .. 1 orange-yellow (~1150 C); faded below ~690 C
    vec3 bb(float Tc){
      float k = clamp((Tc - 650.0) / 500.0, 0.0, 1.0);
      vec3 c0 = vec3(0.30, 0.02, 0.003), c1 = vec3(1.1, 0.13, 0.01), c2 = vec3(1.6, 0.42, 0.04), c3 = vec3(2.3, 0.9, 0.16);
      vec3 c = k < 0.4 ? mix(c0, c1, k / 0.4) : k < 0.8 ? mix(c1, c2, (k - 0.4) / 0.4) : mix(c2, c3, (k - 0.8) / 0.2);
      return c * smoothstep(540.0, 690.0, Tc);
    }`;

  function material() {
    const m = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
    m.onBeforeCompile = sh => {
      sh.vertexShader = 'attribute vec4 aSp; varying vec3 vObj; varying vec4 vSp;\n' + NOISE + '\n' + sh.vertexShader
        .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
          // lumpy clot: radial displacement by value noise (seeded per clot), the same on both shading and outline
          vec3 sp = position * 1.7 + aSp.z * 17.3;
          float lump = (vn3(sp) - 0.5) * 0.34 + (vn3(sp * 2.3 + 4.1) - 0.5) * 0.14;
          transformed *= 1.0 + lump;
          vObj = position * 3.6 + aSp.z * 7.1; vSp = aSp;`);
      sh.fragmentShader = FRAG + '\n' + sh.fragmentShader
        .replace('#include <map_fragment>', /* glsl */`
          float Ts = vSp.x, Tsub = vSp.y;
          float ed = cell(vObj) + (sh31f(vObj * 3.1) - 0.5) * 0.08;
          // cracks open as the skin chills against the hot inside (contrast Tsub - Ts), wider on fresher clots
          float cw = 0.015 + 0.06 * clamp((Tsub - Ts) / 250.0, 0.0, 1.0);
          // anti-aliased: a sharp edge while the cells are resolved, their mean coverage once they shrink below a pixel
          float aa = fwidth(ed);
          float crack = mix(1.0 - smoothstep(cw - 0.5 * aa, cw + 0.5 * aa, ed), clamp(cw / 0.3, 0.0, 1.0), smoothstep(0.08, 0.3, aa));
          float mott = sh31f(floor(vObj * 4.0));
          float fresh = smoothstep(950.0, 1100.0, Ts);                      // still a fluid skin: glows all over
          vec3 sEmis = bb(Ts - 40.0 * mott) * mix(0.8, 1.0, fresh);
          // a crack shows the rind a few mm in: between the skin and the shell under it
          sEmis = max(sEmis, bb(mix(Ts, Tsub, 0.5)) * crack * (1.0 - fresh));
          float rock = 0.6 + 0.8 * mott;
          diffuseColor.rgb = vec3(0.030, 0.028, 0.027) * rock * (1.0 - 0.8 * fresh);
        `)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n roughnessFactor = mix(0.85, 0.45, fresh);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += sEmis;');
      sh.fragmentShader = 'float sh31f(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }\n' + sh.fragmentShader;
    };
    m.customProgramCacheKey = () => 'spatter';
    return m;
  }

  PV.init = function (scene) {
    const MAX = SS.CFG.SPATTER.MAX;
    const geo = new T.IcosahedronGeometry(1, 3);
    aSp = new T.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(T.DynamicDrawUsage);
    geo.setAttribute('aSp', aSp);
    mesh = new T.InstancedMesh(geo, material(), MAX);
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true; mesh.renderOrder = 2;
    scene.add(mesh);
  };
  PV.clear = function () { if (mesh) mesh.count = 0; nDrawn = 0; };
  PV.frame = function (S, view, camera) {
    if (!mesh) return;
    const A = S.spat || [], NS = SS.CFG.SPATTER.NS;
    const n = SS.plane.nrm(S), O = S.O, back = SS.terrain.uniforms.uBack.value, insp = (view.insp || 0) > 0.05;
    const ctx = (view.ctxA || 0) > 0.004 && back < 200;
    let k = 0; hot = 0;
    const arr = aSp.array;
    for (const b of A) {
      if (k >= mesh.instanceMatrix.count) break;
      if (b.st !== 0) {
        const t = (b.x - O.x) * n.x + (b.z - O.z) * n.z;
        if (!(insp || (t <= b.a && (t >= -back - b.a || ctx)))) continue;
      }
      // basis: Y = ground normal (landed) or velocity (flying); X, Z perpendicular with a per-clot yaw
      let sy, sxz;
      if (b.st === 0) {
        const sp = Math.hypot(b.vx, b.vy, b.vz);
        if (sp > 1e-3) by.set(b.vx / sp, b.vy / sp, b.vz / sp); else by.set(0, 1, 0);
        sxz = b.r; sy = b.r * Math.min(3, 1 + sp * SHUT / b.r);
      } else { by.set(b.nx, b.ny, b.nz); sxz = b.a; sy = b.c; }
      tp.set(Math.abs(by.y) < 0.9 ? 0 : 1, Math.abs(by.y) < 0.9 ? 1 : 0, 0);
      bx.crossVectors(tp, by).normalize(); bz.crossVectors(bx, by);
      const yaw = (b.id * 2.3999632) % 6.2832, cy = Math.cos(yaw), syw = Math.sin(yaw);
      tp.copy(bx).multiplyScalar(cy).addScaledVector(bz, syw); bz.copy(bz).multiplyScalar(cy).addScaledVector(bx, -syw); bx.copy(tp);
      m4.set(bx.x * sxz, by.x * sy, bz.x * sxz, b.x,
             bx.y * sxz, by.y * sy, bz.y * sxz, b.y,
             bx.z * sxz, by.z * sy, bz.z * sxz, b.z,
             0, 0, 0, 1);
      mesh.setMatrixAt(k, m4);
      const o = k * 4;
      arr[o] = b.Ts; arr[o + 1] = b.cold ? b.Ts : b.T[NS - 2]; arr[o + 2] = (b.id * 0.618034) % 1 * 10; arr[o + 3] = b.st;
      if (b.Ts > 600) hot++;
      k++;
    }
    mesh.count = k; nDrawn = k;
    if (k) { mesh.instanceMatrix.needsUpdate = true; aSp.needsUpdate = true; }
  };
  PV.stats = () => ({ drawn: nDrawn, hot });
  PV.mesh = () => mesh;
})(window.SS = window.SS || {});
