/* render/envmap.js (P100) — ONE shared environment map for every PBR material (Three.js side only).
 * The game scene had no environment map, so metal (EOW wreck, hull plates, girders, bridges, sentry, weapons, worm eyes) rendered dark.
 * Now scene.environment = a PMREM of the REAL sky: render/sky.js already draws the physical dome + clouds into a small cube every second
 * (it feeds the water); this file turns that cube into a prefiltered map, adds the ground below the horizon (a lit-soil colour from the biome
 * light), a faint night floor and a global gain, and rebuilds it only when the look changes (biome, hour, weather) and every EVERY seconds
 * (the clouds drift), never per frame. The End of the World has no sky cube: its own dome (stars, harsh sun, moon, belt) is captured the
 * same way with a CubeCamera on a private layer. Caves get a faint grey.
 * The diffuse part of the image based light is REMOVED from every material (the hemisphere light is the ambient term, adding the map would
 * brighten the whole look) and the specular part is weighted by how mirror-like the surface is (metal F0 or low roughness), so rough soil /
 * rock / grass pay nothing and keep their look; wet ground (rain lowers the terrain roughness) and water-wet rock pick up a faint sky sheen.
 * Clearcoat materials (alien, xeno, hugger, slime) keep the stock behaviour at full weight. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const EV = SS.envView = {};
  const EVERY = 45, LAYER = 29;

  /* ---- global patch of the stock chunk (before any program compiles) ---- */
  (function patch() {
    const C = T.ShaderChunk, k = 'lights_fragment_maps';
    let s = C[k];
    if (!s || s.indexOf('ssEW') >= 0) return;
    const diff = 'iblIrradiance += getIBLIrradiance( geometryNormal );';
    const rad = 'radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );';
    if (s.indexOf(diff) < 0 || s.indexOf(rad) < 0) return;
    s = s.replace(diff, '');
    s = s.replace(rad, [
      '#ifdef USE_CLEARCOAT',
      '\t\tfloat ssEW = 1.0;',
      '\t#else',
      '\t\tfloat ssEW = max( smoothstep( 0.07, 0.45, max( material.specularColor.r, max( material.specularColor.g, material.specularColor.b ) ) ), 1.0 - smoothstep( 0.35, 0.8, material.roughness ) );',
      '\t#endif',
      '\t\tif ( ssEW > 0.003 ) radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * ssEW;'
    ].join('\n'));
    C[k] = s;
  })();

  let global = true, att = [], renderer = null, scene = null, mat = null, bscene = null, rt = null, cubeRT = null, cubeCam = null, domeRef = null;
  let P = { mode: 'sky', k: 1, ground: [0.1, 0.08, 0.06], floor: [0, 0, 0] }, dirty = true, last = -1e9, builds = 0, lastSun = null, ms = 0;

  EV.init = function (sc, rd, Q) {
    scene = sc; renderer = rd; global = !Q || Q.env !== false;
    if (!T.PMREMGenerator) return;
    mat = new T.ShaderMaterial({
      side: T.BackSide, depthWrite: false, depthTest: false,
      uniforms: { tSky: { value: null }, uK: { value: 1 }, uGround: { value: new T.Vector3() }, uFloor: { value: new T.Vector3() } },
      vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform samplerCube tSky; uniform float uK; uniform vec3 uGround, uFloor; varying vec3 vD;\n' +
        'void main(){ vec3 d = normalize(vD); vec3 c = textureCube(tSky, d).rgb * uK;\n' +
        '  c = mix(c, uGround, smoothstep(0.02, -0.3, d.y)); gl_FragColor = vec4(c + uFloor, 1.0); }'
    });
    bscene = new T.Scene();
    const m = new T.Mesh(new T.SphereGeometry(20, 24, 12), mat); m.frustumCulled = false; bscene.add(m);
  };

  /* what the look wants: mode 'sky' | 'space' | 'cave', k gain on the sky cube, ground = linear rgb below the horizon, floor = linear rgb added everywhere */
  EV.look = function (p) { P = Object.assign({}, P, p); dirty = true; };
  /* materials that always carry the map (baked models, glass), also where the scene-wide map is off (low quality) */
  EV.attach = function (m) { if (att.indexOf(m) < 0) att.push(m); if (rt) m.envMap = rt.texture; return m; };
  EV.dome = function (m) { domeRef = m; };

  function capture(dome, camera) {
    if (!cubeRT) {
      cubeRT = new T.WebGLCubeRenderTarget(64, { type: T.HalfFloatType, generateMipmaps: false, minFilter: T.LinearFilter });
      cubeCam = new T.CubeCamera(1, 1000, cubeRT); cubeCam.layers.set(LAYER); for (const c of cubeCam.children) c.layers.set(LAYER);
      dome.layers.enable(LAYER);
    }
    cubeCam.position.copy(camera.position);
    const fog = scene.fog; scene.fog = null; cubeCam.update(renderer, scene); scene.fog = fog;
    return cubeRT.texture;
  }

  function build(src) {
    const t0 = performance.now();
    mat.uniforms.tSky.value = src || mat.uniforms.tSky.value;
    const cave = P.mode === 'cave' || !src;
    mat.uniforms.uK.value = cave ? 0 : P.k;
    mat.uniforms.uGround.value.set(P.ground[0], P.ground[1], P.ground[2]);
    mat.uniforms.uFloor.value.set(P.floor[0], P.floor[1], P.floor[2]);
    const pm = new T.PMREMGenerator(renderer), nrt = pm.fromScene(bscene, 0, 0.1, 100); pm.dispose();
    if (global) scene.environment = nrt.texture;
    for (const m of att) m.envMap = nrt.texture;
    if (rt) rt.dispose();
    rt = nrt; builds++; ms = performance.now() - t0;
  }

  /* per frame (after the sky frame, so the sky cube of this frame is fresh) */
  EV.frame = function (camera, time) {
    if (!mat || !renderer) return;
    const sp = P.mode === 'space';
    let due = dirty || time - last > EVERY || time < last;
    if (sp && domeRef && lastSun && !due) { const d = domeRef.material.uniforms.uSun.value; if (d.dot(lastSun) < 0.996) due = true; }
    if (!due) return;
    let src = null;
    if (sp) { if (!domeRef) return; src = capture(domeRef, camera); lastSun = domeRef.material.uniforms.uSun.value.clone(); }
    else if (P.mode === 'sky') { src = SS.skyView && SS.skyView.info ? SS.skyView.info.env : null; if (!src) return; }
    build(src); dirty = false; last = time;
  };
  EV.info = () => ({ builds: builds, ms: +ms.toFixed(2), mode: P.mode, k: P.k, on: !!(scene && scene.environment), global: global, att: att.length });
})(window.SS = window.SS || {});
