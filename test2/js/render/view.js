/* render/view.js — Three.js presentation of the sim state: renderer, camera, lights, sky, water, section outline
 * and event-driven effects; worms/projectiles/rope/reticle are render/actors.js, bodies and props render/bodies.js.
 * Terrain meshes live in render/terrain.js, grass in render/grass.js. Reads S (writes only presentation bookkeeping:
 * S.section, S.sectionDirty, S.stats). Porting: this file + materials/terrain/grass/actors/fx are the only
 * Three.js-specific code. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG, M = SS.math, P = SS.plane;
  const V = SS.view = {};
  let headSpot,
    renderer,
    scene,
    camera,
    tx,
    Q,
    sun,
    hemi,
    fill,
    sky,
    skyMat,
    heightTex,
    surfTex,
    scyTex,
    outline,
    outlineMat,
    motes,
    lamp,
    stars = null;
  const view = {
    camT: null, camZ: 0, dir: { cur: null, since: 0 }, zoom: 19, autoZ: 0, zoomBack: 0, userT: 99, time: 0, heightVer: 0, heightFor: -1,
    heightT: -99, heightmap: null, secWV: -1, secT: -99, edgeA: 0,
    pan: { s: 0, y: 0 }, orbit: { yaw: 0, tilt: 0 }, look: null, activeId: -1, surf: null, surfN: 0, vw: 0, vh: 0
  };
  V.state = view;


  V.init = function (canvas, textures, quality, opts) {
    tx = textures; Q = quality; opts = opts || {};
    renderer = new T.WebGLRenderer({
      canvas,
      stencil: true,                                             // (the worms' x-ray silhouette: render/actors.js)
      antialias: Q.msaa > 0 && !Q.grade,
      preserveDrawingBuffer: !!opts.preserve,
      powerPreference: 'high-performance'
    });
    if (SS.lens && SS.lens.bloom) SS.lens.bloom(Q.bloom);
    renderer.localClippingEnabled = true;                // P46: the section rule is a clipping plane on every material (render/section.js)
    renderer.setPixelRatio(Math.min(Q.dpr, window.devicePixelRatio || 1));
    renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = Q.softShadow ? T.PCFSoftShadowMap : T.PCFShadowMap;
    scene = new T.Scene();
    if (SS.envView) SS.envView.init(scene, renderer, Q);     // P100: the shared environment map (render/envmap.js)
    scene.fog = new T.FogExp2(0xf1d9c0, 0.0065);
    camera = new T.PerspectiveCamera(42, 1, 0.1, 900);
    // P46: the rule is on for this scene only (far pass / PMREM / post quads are drawn without it)
    SS.section.attach(renderer, scene);

    hemi = new T.HemisphereLight(0xcfe2ff, 0x7a5a3a, 1.15); scene.add(hemi);
    sun = new T.DirectionalLight(0xffe0b5, 3.0);
    sun.castShadow = true; sun.shadow.mapSize.set(Q.shadow, Q.shadow);
    const sc = sun.shadow.camera;
    sc.left = -36;
    sc.right = 36;
    sc.top = 36;
    sc.bottom = -36;
    sc.near = 1;
    sc.far = 170;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.04; sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    const FL = SS.look.FILL;
    fill = new T.DirectionalLight(FL.color, FL.intensity); fill.position.set(FL.x, FL.y, FL.z); scene.add(fill);

    // the procedural sky, the far world pass and its 3D clouds
    const sv = SS.skyView.init(scene, tx, Q, renderer);
    sky = sv.mesh;
    skyMat = sv.mat;
    SS.farView.init(scene, tx, Q, renderer);
    SS.cloudView.init(SS.farView.scene(), tx);

    ({ heightTex, surfTex, scyTex } = V.surfaceTextures());


    SS.terrain.init(scene, tx, Q);
    // the sea: render/water.js (the simulated surface) after the terrain (it shares its uniforms)
    SS.waterView.init(scene, tx, Q, renderer);
    if (SS.dunesView) SS.dunesView.init(scene);       // dry worlds: far dunes instead of the sea (Step D2)
    SS.terrain.uniforms.tSurf.value = surfTex; SS.terrain.uniforms.tScY.value = scyTex;
    SS.terrain.uniforms.tWater.value = SS.waterView.texture;
    if (SS.lavaView) SS.lavaView.init(scene, tx, Q);
    if (SS.bodyView) SS.bodyView.init(scene, tx);
    if (SS.treeView) SS.treeView.init(scene, tx, Q);   // after terrain (shared uniforms) and bodyView (flame shader)
    SS.grass.init(scene, tx, Q);
    SS.grass.material().userData.uniforms.tSurf.value = surfTex;
    SS.terrain.onChunk = (ci, c) => {
      SS.grass.onChunk(ci, c);
      if (SS.clutterView) SS.clutterView.onChunk(ci, c);
    };
    if (SS.clutterView) SS.clutterView.init(scene, tx, Q);   // P62: pebbles / twigs / flowers / scrub on the ground

    outlineMat = SS.mat.outline();
    outline = new T.Mesh(new T.BufferGeometry(), outlineMat);
    outline.renderOrder = 7;
    outline.frustumCulled = false;
    scene.add(outline);
    if (SS.edgeView) SS.edgeView.init(scene, tx, Q);   // material edge that replaces the outline once rotation stops
    if (SS.secCut) SS.secCut.init(scene);              // P85: the yellow cut of the overview

    // floating pollen / dust motes in the light (cosmetic, render-side randomness is fine)
    const mp = new Float32Array(Q.motes * 3);
    for (let i = 0; i < mp.length; i += 3) {
      mp[i] = (Math.random() - 0.5) * 50;
      mp[i + 1] = Math.random() * 18;
      mp[i + 2] = (Math.random() - 0.5) * 50;
    }
    const mg = new T.BufferGeometry();
    mg.setAttribute('position', new T.BufferAttribute(mp, 3));
    motes = new T.Points(
      mg,
      new T.PointsMaterial({
        map: tx.glow,
        size: 0.11,
        color: 0xffe2a8,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        blending: T.AdditiveBlending
      })
    );
    motes.frustumCulled = false; scene.add(motes);

    // U: the worm's lamp underground (a warm point light on the active worm; off on the surface)
    lamp = new T.PointLight(0xffd9a8, 0, 26, 1.6); scene.add(lamp);
    // the cave lamp's numbers in one place (tools sweep them: tools/dev/p119clamp.cjs): the fill point light (cd, m in
    // front of the worm toward the camera, m up), the head spot (cd, cone half angle rad, m ahead it aims) and a
    // multiplier of the cave's ambient hemisphere light
    V.caveLamp = { fill: 26, ahead: 2.4, up: 1.1, spot: 90, cone: 0.66, aim: 3.6, hemi: 1 };
    /* P65i: the night headlamp is a real spot (worn on the head, aimed ahead and a little down, inverse-square), not a
     * point light hanging
     * next to the worm: the worm itself is outside the cone (lit by the moon, not blown out) and a pool of light lies
     * on the ground ahead */
    headSpot = new T.SpotLight(0xffd9a8, 0, 26, 0.66, 1.0, 2); scene.add(headSpot); scene.add(headSpot.target);
    /* P118c (Q-16: "the cave headlamp reads as an orange fireball on the worm's head"): the cave light used to be ONE
     * point light (34 cd) inside the worm's head:
     * at 0.15-0.3 m the 1/d^1.6 falloff blasted the head to white, and the bloom pass spread that into a red-orange
     * fireball. Now it is what a head lamp is: the headSpot above (a spot, the worm itself lies outside its cone) on a
     * small warm bulb that rides on the worm's head, and a weak fill that hangs in front of the worm (toward the
     * camera, never inside it) so the worm and the ground at its feet read. No light is added: the spot is the surface
     * night lamp's. */
    {
      const dot = new T.Group();
      const bulb = new T.Mesh(
        new T.SphereGeometry(0.035, 10, 8),
        new T.MeshBasicMaterial({ color: 0xfff0cc, toneMapped: false, fog: false })
      );
      const halo = new T.Sprite(
        new T.SpriteMaterial({
          map: tx.glow,
          color: 0xffd79a,
          transparent: true,
          opacity: 0.42,
          blending: T.AdditiveBlending,
          depthWrite: false,
          fog: false
        })
      );
      halo.scale.set(0.23, 0.23, 1);
      dot.add(bulb);
      dot.add(halo);
      dot.visible = false;
      scene.add(dot);
      view.cave = { spot: headSpot, dot, host: null };
    }
    // night sky: stars on the upper dome (procedural points; the glow sprite), shown at night (faintly at dusk)
    {
      const n = 1600, p = new Float32Array(n * 3), c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const u = Math.random() * 0.97 + 0.03,
          a = Math.random() * 6.283,
          r = Math.sqrt(1 - u * u),
          k = 0.55 + Math.random() * 0.45,
          warm = Math.random();
        p[i * 3] = Math.cos(a) * r * 700;
        p[i * 3 + 1] = u * 700;
        p[i * 3 + 2] = Math.sin(a) * r * 700;
        c[i * 3] = k;
        c[i * 3 + 1] = k * (0.92 + 0.08 * warm);
        c[i * 3 + 2] = k * (0.85 + 0.25 * (1 - warm));
      }
      const g = new T.BufferGeometry();
      g.setAttribute('position', new T.BufferAttribute(p, 3));
      g.setAttribute('color', new T.BufferAttribute(c, 3));
      stars = new T.Points(
        g,
        SS.section.exempt(
          new T.PointsMaterial({
            map: tx.glow,
            size: 2.6,
            sizeAttenuation: false,
            vertexColors: true,
            transparent: true,
            opacity: 0,
            depthWrite: false,
            fog: false,
            blending: T.AdditiveBlending
          }),
          'sky: stars'
        )
      );
      stars.renderOrder = -5; stars.frustumCulled = false; scene.add(stars);
    }
    SS.look.init({ view, scene, renderer, Q, sun, hemi, fill, stars });
    SS.fx.init(scene, tx, Q, heightTex);
    if (SS.flameView) SS.flameView.init(scene, Q);
    if (SS.actors.init) SS.actors.init(scene, tx, Q);
    if (SS.armsView) SS.armsView.init(scene, tx);           // P7: the PoC arsenal's models and effects
    if (SS.weaponsView) SS.weaponsView.init(scene, tx);     // P37-W3: weapons A
    if (SS.ventsView) SS.ventsView.init(scene, Q);             // P25: fumaroles
    if (SS.bloodView) SS.bloodView.init(scene);             // the PoC's optional gore (setup Blood: On)
    if (SS.weatherView) SS.weatherView.init(scene, tx, Q, { skyMat, sun, hemi, fill, motes, heightTex, renderer });
    if (SS.trailView) SS.trailView.init(scene, Q);     // P62: footstep dust, drag marks, wading rings, breath fog
    if (SS.lifeView) SS.lifeView.init(scene, tx, Q);   // P62: birds, butterflies, lizards, fish, fireflies, embers, falling leaves
    if (SS.shrapView) SS.shrapView.init(scene);        // X2: luminous casing shrapnel
    if (SS.spatView) SS.spatView.init(scene);          // LV4: lava spatter clots
    if (SS.structView) SS.structView.init(scene);      // M: steel bridges
    if (SS.derelictView) SS.derelictView.init(scene, tx);   // P37: the derelict ship's glow
    if (SS.alienView) SS.alienView.init(scene, tx, renderer);   // P37: eggs, face huggers, the alien, acid
    if (SS.iceView) SS.iceView.init(scene);            // Step I: sea ice
    for (const n of W4V)
      if (SS[n]) SS[n].init(scene, tx);
    return { renderer, scene, camera };
  };

  V.resize = function (w, h) {
    view.vw = w;
    view.vh = h;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  };
  /* P38-R4: the pixel ratio (adaptive resolution, platform/quality.js adapt_*): the canvas, the far pass and the lens
   * target follow the drawing buffer */
  V.setDpr = function (r) {
    r = Math.min(r, window.devicePixelRatio || 1);
    if (Math.abs(renderer.getPixelRatio() - r) < 0.01) return;
    renderer.setPixelRatio(r);
    if (view.vw) V.resize(view.vw, view.vh);
  };
  V.dpr = () => renderer.getPixelRatio();
  V.msaa = () => (Q ? Q.msaa : 0);
  /* P38-R4 shader pre-warm (a first use used to compile its programs mid-game: 20-340 ms hitches). Every object of the
   * main and the far
   * scene is made visible for a moment (pooled effect meshes are hidden until used), the programs are submitted to the
   * driver at once (renderer.compile) and drawn once into a 1 x 1 pixel scissor on the canvas and into a tiny float
   * target (the lens path: other output colour space / tone mapping = other programs; also the shadow-depth programs).
   * Presentation only: nothing is simulated. */
  V.prewarm = function (S) {
    if (!renderer) return 0;
    const t0 = performance.now(),
      hid = [],
      force = o => {
        if (!o.visible) {
          hid.push(o);
          o.visible = true;
        }
      };
    scene.traverse(force);
    if (SS.farView && SS.farView.scene) SS.farView.scene().traverse(force);
    const rt0 = renderer.getRenderTarget(),
      vp = renderer.getViewport(new T.Vector4()),
      sc = renderer.getScissor(new T.Vector4()),
      st = renderer.getScissorTest();
    try {
      if (SS.farView && SS.farView.dirty) SS.farView.dirty();
      renderer.compile(scene, camera);
      renderer.setScissorTest(true); renderer.setScissor(0, 0, 1, 1); renderer.setViewport(0, 0, 1, 1);
      renderer.render(scene, camera);
      const tr = new T.WebGLRenderTarget(4, 4, { type: T.HalfFloatType, samples: Q.msaa > 0 ? Q.msaa : 0 });
      renderer.setRenderTarget(tr);
      if (SS.farView && SS.farView.dirty) SS.farView.dirty();
      renderer.compile(scene, camera); renderer.render(scene, camera);
      renderer.setRenderTarget(rt0); tr.dispose();
      // R11: the front ghost pass (the automatic one is on by default): its programs and its full-size float target are
      // built now, not in the first attack of the match
      if ((ghostAutoOn || ghostUser > 0) && SS.section.renderGhost) {
        const g0 = SS.section.ghost;
        SS.section.setGhost(50);
        try {
          SS.section.renderGhost(renderer, scene, camera, V);
        } finally {
          SS.section.setGhost(g0);
        }
        renderer.setRenderTarget(rt0);
      }
    } finally {
      for (const o of hid) o.visible = false;
      renderer.setViewport(vp);
      renderer.setScissor(sc);
      renderer.setScissorTest(st);
      renderer.setRenderTarget(rt0);
      if (SS.farView && SS.farView.dirty) SS.farView.dirty();
    }
    V.prewarmMs = performance.now() - t0;
    if (SS.lens && SS.lens.ensure) SS.lens.ensure();
    // the rest (materials of not yet shown effects): V.render spreads it over the next frames
    if (SS.prewarm) SS.prewarm.begin(renderer, scene, camera, scene);
    return V.prewarmMs;
  };
  V.quality = () => Q;
  V.camera = () => camera; V.scene = () => scene; V.renderer = () => renderer;
  /* the listener for the audio (platform/audio.js AU.ears_make, AU.frame): the camera focus (the point the player
   * looks at, usually the active worm), the camera position and its right vector; ok false until the camera has a
   * focus */
  V.ears = function (out) {
    out.ok = !!(camera && view.camT);
    if (!out.ok) return out;
    const e = camera.matrixWorld.elements, p = camera.position, f = view.camT;
    out.fx = f.x;
    out.fy = f.y;
    out.fz = f.z;
    out.cx = p.x;
    out.cy = p.y;
    out.cz = p.z;
    out.rx = e[0];
    out.ry = e[1];
    out.rz = e[2];
    return out;
  };
  V.vis = w => SS.actors.vis(w);
  /* P9: client (x, y) -> the point on the section plane under the cursor, {s, y} in plane coordinates (or null) */
  const rc = new T.Raycaster(), ndc = new T.Vector2();
  V.pickPlane = function (S, cx, cy) {
    if (!renderer || !camera) return null;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    rc.setFromCamera(ndc, camera);
    const o = rc.ray.origin, d = rc.ray.direction, n = SS.plane.nrm(S), den = d.x * n.x + d.z * n.z;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((S.O.x - o.x) * n.x + (S.O.z - o.z) * n.z) / den;
    if (t < 0) return null;
    const p = { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t };
    return { s: SS.plane.to_plane(S, p).s, y: p.y };
  };
  /* P1 sudden death: the sea rose (sim/water.js raise): move the flat sea planes, the terrain's still-sea level */
  // P37-5: the planes follow W.SEA itself (sim truth), not only the 'searise' event: a new match / a restored snapshot
  // / a replay reset W.SEA without that event and the outer ocean stayed at the old (risen) level next to the new water
  let seaShown = null;
  V.seaSync = function () {
    const s = SS.world.SEA;
    if (s !== seaShown) V.seaChanged(s);
  };
  V.seaChanged = function (sea) {
    seaShown = sea;
    if (SS.farView && SS.farView.setSea) SS.farView.setSea(sea);
    SS.terrain.uniforms.uSea.value = sea;
    if (SS.waterView && SS.waterView.seaChanged) SS.waterView.seaChanged(sea);
  };
  /* traps (user 2026-10-07): who looks at the screen? online: my seat's team; hot seat: the human team whose turn it is
   * (the last one while a CPU plays); a CPU-only match: -2 = sees everything */
  let lastHuman = 0;
  V.viewerTeam = function (S) {
    if (SS.net && SS.net.active && SS.net.started) return SS.net.team;
    if (!S.teams || !SS.game) return 0;
    if (S.teams.every((t, i) => SS.game.is_cpu(S, i))) return -2;
    const a = S.active;
    if (a && !SS.game.is_cpu(S, a.team)) lastHuman = a.team;
    return lastHuman;
  };
  // a buried trap / mine is seen by its planter's team, by everybody while it is planted (PLANT_SEEN s) or once
  // detected; the map's own mines (team -1) by everybody until mapMinesUntil (they burrow when the match is under way)
  V.trapVisible = function (S, team, planted, revealed) {
    if (revealed) return true;
    const v = V.viewerTeam(S);
    if (v === -2) return true;
    if (team == null || team < 0) return !(S.mapMinesUntil >= 0) || S.time < S.mapMinesUntil;
    return v === team || S.time - (planted || -99) < SS.CFG.ARMS.TRAPS.PLANT_SEEN;
  };
  /* P75: the default camera distance. The old fixed 19 m made the worm ~25 px tall at 1280x800. Now the distance
   * follows the window so the worm is
   * WORM_PX tall (about 4.6 % of the window height, 34..60 px), a little further out on big maps and on narrow /
   * portrait windows (the width must still show some battlefield). The player's wheel / pinch / tool value is kept:
   * auto only follows while view.zoom still equals the last auto value. */
  // P37 W4: weapons B, the force field, worn items + torch + laser sight (each: init / clear / onEvent / frame)
  const W4V = [
    'gadgetView', 'labView', 'ffView', 'acidView', 'wornView', 'polishView', 'reactView', 'softView', 'idleView', 'jacketView', 'heroView',
    'boulderView', 'rayView'
  ];

  V.clearActors = () => clearActors();          // (instant replay: the restored state has new object identities)
  function clearActors() {
    SS.fx.clear();
    if (SS.flameView) SS.flameView.clear();
    if (SS.actors.clear) SS.actors.clear();
    if (SS.armsView) SS.armsView.clear();
    if (SS.weaponsView) SS.weaponsView.clear();
    if (SS.bloodView) SS.bloodView.clear();
    if (SS.weatherView && SS.weatherView.clear) SS.weatherView.clear();
    if (SS.lifeView) SS.lifeView.clear();
    if (SS.trailView) SS.trailView.clear();
    if (SS.shrapView) SS.shrapView.clear();
    if (SS.spatView) SS.spatView.clear();
    if (SS.structView) SS.structView.clear();
    if (SS.iceView) SS.iceView.clear();
    for (const n of W4V)
      if (SS[n]) SS[n].clear();
  }

  /* ---------- new map: surface map, height maps (terrain meshes are built by main via buildTerrain) ---------- */
  // (the lens pass runs every frame on a graded quality: no temporary array without a black hole)
  const NO_HOLES = [];
  /* P38: the map size changed: every lattice-sized render resource follows (the texture OBJECTS stay, other modules
   * hold them in uniforms). Called first thing by newWorld. */
  V.resizeWorld = function () {
    const W = SS.world;
    if (view.sizeVer === W.sizeVer) return;
    view.sizeVer = W.sizeVer;
    V.surfaceResize(W.NX);
    if (SS.waterView && SS.waterView.resize) SS.waterView.resize();
    if (SS.weatherView && SS.weatherView.resize) SS.weatherView.resize();
  };
  V.newWorld = function (S) {
    V.resizeWorld();
    clearActors();
    SS.look.apply(S);
    V.surfaceClear();
    if (SS.grass) SS.grass.S = S;
    if (SS.clutterView) SS.clutterView.S = S;
    SS.slab2d.reset();
    V.uploadSurface(S);
    V.buildHeights();
    V.seaChanged(SS.world.SEA);                           // per world (dry worlds: below the floor): terrain, outer ocean, face
    SS.terrain.uniforms.uCtxSolid.value = 1;   // D3 (dry) + CX1 (all worlds): the far context is drawn solid
    if (SS.dunesView) SS.dunesView.reset(S, view);
    view.camT = null; V.resetPan(); view.activeId = -1;
    if (SS.lavaView) SS.lavaView.reset(S);
    if (SS.ventsView) SS.ventsView.reset(S);
    if (SS.derelictView) SS.derelictView.reset(S);
    if (SS.alienView) SS.alienView.reset(S);
    if (SS.bodyView) SS.bodyView.clear();
    if (SS.edgeView) SS.edgeView.reset(S);
    if (SS.eowView) SS.eowView.reset(S);                  // P68c: back to the normal look when the new world is not the End of the World
    S.sectionDirty = true;
  };
  V.buildTerrain = onProgress => SS.terrain.buildAll(renderer, onProgress);
  // (tests and tools read the lights: render/look.js sets them, weather.js modulates them)
  V.lights = () => ({ sun, hemi, fill });
  /* slice view: how much of the world behind slice zero stays solid (view-only setting) */
  V.SLICE = { thin: 1.5, thick: 6, full: 250 };
  /* drawn as part of the slab: from slice zero (plus a body radius) back to -uBack. A worm in front of slice zero
   * would float in front of the cut face (its ground is not drawn), so it is a ghost like the off-section ones. */
  /* user 2026-10-08: what lies ON the terrain (blood stains, gibs, ...) follows the terrain's section view: nothing in
   * front of slice zero (+margin: the automatic rule of render/section.js), and beyond the slab (t < -uBack - margin)
   * only as much as the context terrain is drawn (uAlpha; 0 = hidden). Patches a material's shaders (instancing aware)
   * with the terrain's own uniforms. */
  V.slabFade = function (mat, margin) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      if (prev) prev(sh, r);
      const U = SS.terrain.uniforms;
      Object.assign(sh.uniforms, { uO: U.uO, uN: U.uN, uBack: U.uBack, uAlpha: U.uAlpha, uSlabM: { value: margin || 0.5 } });
      sh.vertexShader = 'varying vec3 vSlabW;\n' + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        vec4 slabP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          slabP = instanceMatrix * slabP;
        #endif
        vSlabW = (modelMatrix * slabP).xyz;`);
      sh.fragmentShader = 'uniform vec3 uO, uN; uniform float uBack, uAlpha, uSlabM; varying vec3 vSlabW;\n'
        + sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        {
          float tS = dot(vSlabW - uO, uN);
          if (tS < -uBack - uSlabM) {
            if (uAlpha < 0.004) discard;
            gl_FragColor.a *= uAlpha;
          }
        }`);
    };
    const key = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : () => '';
    mat.customProgramCacheKey = () => key() + 'slab';
    mat.transparent = true; mat.needsUpdate = true;
    return mat;
  };
  /* the rule of render/bodies.js for any object on the terrain: drawn where the ground under it is drawn (the slab,
   * the context while it shows, everything while inspecting) */
  V.shownAt = function (S, p, r) {
    if ((view.insp || 0) > 0.05) return true;
    const n = P.nrm(S), back = SS.terrain.uniforms.uBack.value, t = (p.x - S.O.x) * n.x + (p.z - S.O.z) * n.z;
    if (t > r && SS.section.frontOn) return true;                    // (front ghost: drawn, and clipped / ghosted by render/section.js)
    return t <= r && (t >= -back - r || ((view.ctxA || 0) > 0.004 && back < 200));
  };
  // (P118c: the player's slice view, not the overview's full one: a worm off the section is still a ghost marker while
  // V is held)
  V.inSlab = (S, p) => {
    const t = P.to_plane(S, p).t;
    return t <= C.WORM_R && t >= -SS.terrain.back() - C.WORM_R;
  };
  /* what the HUD reads from the view (SS.ui.init takes it): the slab tests, the plan of the map for the top map
   * (plan():
   * the 1 m heightmap and its version, the vegetation surface and its upload count; back(): the slab depth drawn now,
   * the uniform as it eases toward a new slice setting), the cinematic camera's timings and the reaction queue */
  const planRec = { heightmap: null, heightVer: 0, surf: null, surfN: 0, surfUploads: 0 };
  V.hud = {
    inSlab: V.inSlab,
    shownAt: V.shownAt,
    plan() {
      planRec.heightmap = view.heightmap;
      planRec.heightVer = view.heightVer;
      planRec.surf = view.surf;
      planRec.surfN = view.surfN;
      planRec.surfUploads = view.surfUploads | 0;
      return planRec;
    },
    back: () => SS.terrain.uniforms.uBack.value,
    // the cinematic camera: the delay of the turn banner (it appears as the camera move settles), the results card's
    // moment (the celebration is over)
    turnDelay: () => (SS.cine ? SS.cine.turnDelay() : 0),
    panelReady: S => !SS.cine || SS.cine.panelReady(S),
    // the reaction queue (render/reactq.js): fn(S, item) when a worm may react (speak) now
    react: fn => {
      if (SS.reactq) SS.reactq.listen(fn);
    }
  };
  // P29j (user 2026-10-08: "the slice view setting doesn't work, the full map behind is always shown"): the slab depth
  // (uBack) AND the haze of everything behind it: thin / thick = crisp to 1.5 / 6 m, the rest recedes; full = all crisp
  /* the front ghost = max(the player's setting, the automatic one): after the attack (resolve / dying) and while an
   * alien
   * strikes / wraps / bites / eats, the front half of the map shows at 50 %, so what happens off the section (an alien
   * eating someone in front of the cut) is seen (user 2026-10-11); faded in / out over ~0.5 s */
  let ghostUser = 0, ghostAuto = 0, ghostAutoOn = true;
  V.setGhostAuto = on => { ghostAutoOn = !!on; };
  V.setGhost = pct => {
    ghostUser = Math.max(0, Math.min(100, +pct || 0));
    return SS.section.setGhost(Math.max(ghostUser, ghostAuto));
  };
  function alienBusy(S) {
    const A = S.alien;
    if (!A || !A.xenos) return false;
    for (let i = 0; i < A.xenos.length; i++) {
      const st = A.xenos[i].st;
      if (st >= 1 && st <= 4) return true;
    }
    return false;
  }
  function autoGhost(S, dt) {
    const want = ghostAutoOn && S && (S.phase === 'resolve' || S.phase === 'dying' || alienBusy(S)) ? 50 : 0;
    ghostAuto += (want - ghostAuto) * Math.min(1, dt * 4);
    if (want === 0 && ghostAuto < 1) ghostAuto = 0;
    const eff = Math.max(ghostUser, ghostAuto);
    if (Math.abs(eff - SS.section.ghost) > 0.25 || (eff === 0 && SS.section.ghost !== 0)) SS.section.setGhost(eff);
  }
  V.ghostAuto = () => ghostAuto;
  V.setSlice = function (name) {
    V.slice = V.SLICE[name] ? name : 'thin';
    SS.terrain.setBack(V.SLICE[V.slice]);
    SS.terrain.uniforms.uCtxHaze.value = V.slice === 'full' ? 0 : 1;
    return V.slice;
  };

  /* ---------- section outline ribbon ---------- */
  function buildOutline(sec) {
    const L = sec.outline, n = L.length / 4, d = { x: Math.cos(sec.theta), z: Math.sin(sec.theta) }, nn = { x: -d.z, z: d.x };
    // on the cut face (slice zero)
    const pos = new Float32Array(n * 12), rib = new Float32Array(n * 8), idx = new Uint32Array(n * 6), w = 0.11, tf = 0.03;
    for (let i = 0; i < n; i++) {
      const s0 = L[i * 4], y0 = L[i * 4 + 1], s1 = L[i * 4 + 2], y1 = L[i * 4 + 3];
      let ps = -(y1 - y0), py = s1 - s0;
      const l = Math.hypot(ps, py) || 1;
      ps /= l;
      py /= l;
      const pts = [
        [s0 + ps * w, y0 + py * w, s0, 1],
        [s0 - ps * w, y0 - py * w, s0, -1],
        [s1 + ps * w, y1 + py * w, s1, 1],
        [s1 - ps * w, y1 - py * w, s1, -1]
      ];
      for (let k = 0; k < 4; k++) {
        const o = (i * 4 + k) * 3, s = pts[k][0], y = pts[k][1];
        pos[o] = sec.O.x + s * d.x + tf * nn.x; pos[o + 1] = y; pos[o + 2] = sec.O.z + s * d.z + tf * nn.z;
        rib[(i * 4 + k) * 2] = pts[k][2]; rib[(i * 4 + k) * 2 + 1] = pts[k][3];
      }
      const b = i * 4;
      idx.set([b, b + 1, b + 3, b, b + 3, b + 2], i * 6);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    g.setAttribute('rib', new T.BufferAttribute(rib, 2));
    g.setIndex(new T.BufferAttribute(idx, 1));
    outline.geometry.dispose(); outline.geometry = g;
  }

  /* ---------- events ---------- */
  /* metres from the camera's focus point to an event (the camera shake of a blast follows the distance, not the
   * zoom) */
  function focusDist(e) { return view.camT ? Math.hypot(e.x - view.camT.x, e.y - view.camT.y, e.z - view.camT.z) : view.zoom; }
  const camApi = { focusDist: e => focusDist(e), camT: () => view.camT };
  /* the modules that hear every event after the view's own effects and the cinematic camera, in this order: the
   * actors, the weapon views, the gadget / worn / idle views (W4V), the blood, the sound, the weather, the wildlife,
   * the shrapnel, the alien, the HUD */
  const LISTENERS = ['actors', 'armsView', 'weaponsView'].concat(W4V, [
    'bloodView', 'audio', 'weatherView', 'lifeView', 'shrapView', 'alienView', 'ui'
  ]);
  function onEvents(S) {
    for (const e of S.events) {
      SS.sim.event_bind(S, e);                                  // R7 P2: the sim's events carry worm ids; the view code reads e.worm
      if (SS.reactq) SS.reactq.onEvent(S, e);                   // P85: who may speak after an attack, and the camera visits
      switch (e.type) {
        case 'reset': clearActors(); break;
        case 'explode': if (SS.bodyView && SS.bodyView.noteBlast) SS.bodyView.noteBlast(e);
          SS.fx.env.S = S;
          SS.fx.env.biome = S.biome;
          SS.fx.env.tod = view.tod;
          SS.fx.env.under = !!(SS.world.under || SS.world.eow);
          SS.fx.env.vac = !!SS.world.eow;
          SS.fx.env.rain = S.weather ? Math.min(1, S.weather.rain || 0) : 0;
          SS.fx.env.snow = S.weather ? Math.min(1, S.weather.snow || 0) : 0;
          SS.fx.explosion(e, focusDist(e));
          break;
        // only on a sea. Where there is none (the 2D desert beyond the slab) the sim's splash is something
        // landing on the ground at the sea level: a puff of sand
        case 'splash':
          if (SS.world.has_sea()) {
            SS.fx.splash(e.x, e.y, e.z, e.size);
            if (SS.waterView) SS.waterView.onEvent(e);
          }
          else SS.fx.dust(e.x, e.y + 0.1, e.z, 3 + Math.round(3 * (e.size || 1)), 0.5 + 0.3 * (e.size || 1), C.MATS[C.MAT.SAND].rgb);
          break;
        case 'waterblast':
          if (SS.world.has_sea()) {
            SS.fx.waterBlast(e);
            if (SS.waterView) SS.waterView.onEvent(e);
          }
          break;
        case 'lavaplop': SS.fx.lava(e.x, e.y, e.z, Math.min(1.4, 0.35 + (e.speed || 0) * 0.06)); break;
        case 'icebreak':
          SS.fx.dust(e.x, e.y + 0.05, e.z, Math.min(5, 2 + e.r | 0), 0.4 + 0.15 * e.r, 0xdbe6ee);
          SS.fx.chips(e.x, e.y + 0.1, e.z, [0.75, 0.92, 1], Math.min(10, 3 + e.r * 2 | 0), 3.5, 0.08);
          if (SS.fx.steam) SS.fx.steam(e.x, e.y, e.z, 0.15);
          break;
        case 'steelcut': SS.fx.dust(e.x, e.y, e.z, 2, 0.35, 0x8a8580); SS.fx.spark(e.x, e.y, e.z); break;
        // a burst at the wood: the shattered length flies as splinters (pale heartwood, dark bark) with a few chunks
        case 'treesplinter': {
          const n = Math.min(40, 12 + Math.round((e.len || 0.5) * (e.r || 0.15) * 160));
          SS.fx.chips(e.x, e.y, e.z, [0.74, 0.6, 0.4], n, 7, 0.07);
          SS.fx.chips(e.x, e.y, e.z, [0.3, 0.22, 0.15], Math.round(n * 0.4), 5, 0.1);
          SS.fx.chips(e.x, e.y, e.z, [0.62, 0.48, 0.3], 4, 3.5, 0.2);
          SS.fx.dust(e.x, e.y, e.z, 3, 0.6, 0x8a6a48);
          break;
        }
        // a minigun round bites the wood: a few splinters and bark dust (the notch grows: e.eaten 0..1)
        case 'treechip':
          SS.fx.chips(e.x, e.y, e.z, [0.72, 0.58, 0.38], 2, 2.6, 0.045);
          if (Math.random() < 0.35) SS.fx.dust(e.x, e.y, e.z, 1, 0.25, 0x9a7a55);
          break;
        // a burning tree's twigs / limbs burn away: glowing bits fall out of the crown
        case 'treeburnoff':
          for (let i = 0; i < (e.limbs ? 10 : 6); i++)
            SS.fx.spark(e.x + (Math.random() - 0.5) * 2, e.y + Math.random(), e.z + (Math.random() - 0.5) * 2);
          SS.fx.chips(e.x, e.y, e.z, [0.12, 0.08, 0.06], e.limbs ? 8 : 4, 2, 0.08);
          break;
        case 'bridgefall': SS.fx.dust(e.x, e.y, e.z, 5, 1.2, 0x7a7068); SS.fx.chips(e.x, e.y, e.z, [0.45, 0.33, 0.2], 10, 5, 0.12); break;
        case 'lavasplash': SS.fx.lava(e.x, e.y, e.z, Math.min(2.2, 0.6 + Math.sqrt(e.volume || 0))); break;
        case 'lavabreach': SS.fx.lava(e.x, e.y, e.z, 1.2); break;
        case 'steam': SS.fx.steam(e.x, e.y, e.z, e.power); break;
        case 'rubble':
          for (let i = 0; i < e.pts.length; i += 3) SS.fx.dust(e.pts[i].x, e.pts[i].y, e.pts[i].z, 2, 0.5);
          break;
        // P66b: dust puffs out of the new cracks
        case 'crack':
          for (const q of e.pts) SS.fx.dust(q.x, q.y, q.z, 3, 0.5);
          break;
        case 'collapse': SS.fx.dust(e.x, e.y, e.z, Math.min(14, 4 + e.pieces * 2), 1.2); break;
        case 'rebake': SS.fx.dust(e.x, e.y - 0.5, e.z, Math.min(12, 3 + (e.voxels / 60) | 0), 1.0); break;
        case 'bodyhit': SS.fx.dustAt(e.x, e.y, e.z, 4, 0.5); break;
        case 'propbreak': SS.fx.dust(e.x, e.y, e.z, e.why === 'burnt' ? 6 : 9, 0.6, e.why === 'burnt' ? 0x3a3330 : 0x8a6a48);
          // baked chunks fly instead of the chips
          if (SS.models && SS.bodyView && SS.models.shatter('prop_' + e.kind, SS.bodyView.groupOf(e.body), e.body)) break;
          SS.fx.chips(e.x, e.y, e.z, e.why === 'burnt' ? [0.05, 0.045, 0.04] : [0.5, 0.33, 0.18], e.why === 'burnt' ? 6 : 10, 4.5, 0.09);
          break;
        case 'minedisarm': SS.fx.splash(e.x, e.y, e.z, 0.4); break;
        case 'oilfire': SS.fx.dust(e.x, e.y + 0.5, e.z, 8, 1.4, 0x2a2420); break;
        case 'grassfire': SS.fx.dust(e.x, e.y + 0.3, e.z, Math.min(5, 2 + e.cells / 10 | 0), 0.5, 0x3a3330); break;
        // (a hard landing's dust is react.js's: it was spawned twice)
        case 'land':
          if (!(e.worm && e.speed > 9)) SS.fx.dustAt(e.x, e.y, e.z, Math.min(10, 2 + e.speed | 0), 0.5);
          break;
        case 'bounce': SS.fx.dustAt(e.x, e.y, e.z, 3, 0.3); SS.fx.impact(e.x, e.y, e.z, 0, 1, 0, null, 0.45); break;
        case 'jump': SS.fx.dustAt(e.x, e.y - 0.45, e.z, 3, 0.35); break;
        case 'fire': SS.fx.dust(e.pos.x, e.pos.y, e.pos.z, 4, 0.4, 0xdddddd); break;
        case 'rope_hook': SS.fx.spark(e.x, e.y, e.z); break;
        case 'zip_hook': SS.fx.spark(e.x, e.y, e.z); break;
        case 'chute_open':
          if (e.worm) SS.fx.dust(e.worm.pos.x, e.worm.pos.y + 0.6, e.worm.pos.z, 6, 0.5, 0xe8e8e8);
          break;
      }
      SS.cine.onEvent(S, e, camApi);
      for (const n of LISTENERS) {
        const m = SS[n];
        if (m && m.onEvent) m.onEvent(S, e);
      }
    }
    S.events.length = 0;
  }

  /* ---------- per-frame sync + render ---------- */
  const ease = x => x * x * (3 - 2 * x);
  /* P38-R2: slow motion / instant replay run at V.timeScale (set by main.js): every effect and animation clock
   * (view.time, particles,
   * blood, react / worn / gadget timers) gets the scaled dt, the camera and the terrain remesh the real one (dtU). */
  V.timeScale = 1;
  V.render = function (S, dtU) {
    const dt = dtU * (V.timeScale || 1);
    // (userT: seconds since the player last zoomed / panned: the antic camera leaves the camera alone while it is
    // theirs)
    view.time += dt; view.userT += dtU;
    onEvents(S);
    autoGhost(S, dtU);
    if (S.weather && view.wxKind !== undefined && S.weather.kind !== view.wxKind) SS.look.apply(S);   // (the weather turned)
    syncWorld(S, dtU);
    const insp = ease(M.clamp(S.inspect, 0, 1)), ctxA = Math.max(ease(M.clamp(S.ctx, 0, 1)), insp * 0.9);
    sliceFrame(S, insp);
    V.directCamera(S, dtU, insp);
    skyFrame(dt);
    viewsFrame(S, dt, ctxA, insp);
    cloudShadows(S, dt);
    lamps(S);
    ambientFrame(S);
    draw(S, dt);
  };
  /* the world the view draws follows the sim: the remeshed terrain chunks, the surface maps, the section (rebuilt when
   * it was marked dirty, the plane moved, or the world was edited: at most ~3 times a second) */
  function syncWorld(S, dtU) {
    const W = SS.world;
    if (SS.clutterView) SS.clutterView.S = S;
    if (SS.grass) SS.grass.S = S;
    SS.terrain.update(renderer, S, dtU, Q.remeshMs);
    V.surfaceFrame(S, dtU);
    // the section also follows world edits that do not mark it dirty (collapse, rebake), at most ~3 times a second
    // (also whenever the plane moved without a dirty flag: the drawn section must always be the one the terrain is cut
    // at)
    const moved = S.section && (S.section.O.x !== S.O.x || S.section.O.z !== S.O.z || S.section.theta !== S.theta);
    if (S.sectionDirty || !S.section || moved || (W.version !== view.secWV && view.time - view.secT > 0.3)) {
      S.section = SS.meshgen.section(S);
      buildOutline(S.section);
      S.sectionDirty = false;
      S.stats.slabBuilds++;
      view.secWV = W.version;
      view.secT = view.time;
    }
  }
  /* the slice: the material edge, the section rule, the terrain's and the grass' per-frame uniforms, the cut line's
   * colour and fade */
  function sliceFrame(S, insp) {
    const edgeA = SS.edgeView ? SS.edgeView.frame(S, view) : 0;
    view.edgeA = edgeA;
    const n = P.nrm(S);
    // The terrain beyond the slab stays drawn, solid and without the ghost haze (uCtxSolid): it is the landscape
    // behind the cut. D3 did this for dry worlds (a 1 m stand-in grid used to replace it after the fade: it poked
    // through cliffs, filled arches and popped in at the end of the fade); CX1 (user, 2026-10-07: "i like how it is on
    // desert now, but keep the sea") for all worlds: on wet maps the faded state showed the flat outer sea plane over
    // the land behind the slab (a mirror sheet + the old shoreline foam as a white curve, "glass ground", also seen
    // from caves) and props hung in the sky during the fade (P1). Worms keep the fade (S.ctx, actors).
    const ctxF = 1;
    view.ctxA = ctxF; view.insp = insp;
    // P46: the one section visibility rule (render/section.js); a cave world's overview keeps it (the rock in front of
    // the face is not drawn)
    SS.section.update(S.O, n, insp, !!SS.world.under);
    view.pxScale = renderer.domElement.height * camera.projectionMatrix.elements[5] * 0.5;
    if (SS.crackView) SS.crackView.frame(S);                            // P66b: the crack damage texture (CRACKS lab flag)
    SS.terrain.frame(S, view, ctxF, insp);
    const wind = S.wind || null;
    // (P118d: every frame, not only at a blast: the rocket smoke and the dust of a landing must know the world has no
    // air)
    SS.fx.env.wx = wind && wind.mean ? wind.mean.x : 0; SS.fx.env.wz = wind && wind.mean ? wind.mean.z : 0; SS.fx.env.vac = !!SS.world.eow;
    SS.grass.frame(S, view.time, wind ? wind.mean : null, wind ? wind.whirls : null, S.weather ? S.weather.snowCover : 0, insp);
    if (SS.clutterView) SS.clutterView.frame(S, view, wind ? wind.mean : null);
    // P97: the cut line takes the light of the hour (cool and dim at night, warm at dusk) instead of one cream at all
    // times
    {
      const oc = outlineMat.uniforms.uColor.value, nt = view.tod === 'night', dk = view.tod === 'dusk';
      oc.setHex(nt ? 0xa8c4ff : dk ? 0xffd08a : 0xfff0b0);
    }
    // (P85: the overview draws its own yellow cut, render/seccut.js)
    outlineMat.uniforms.uTime.value = view.time;
    outlineMat.uniforms.uAlpha.value = (0.55 + 0.45 * (1 - insp))
      * (1 - edgeA)
      * (1 - insp)
      * (view.tod === 'night' ? 0.6 : view.tod === 'dusk' ? 0.85 : 1);
    outline.visible = edgeA < 0.999;
  }
  /* the sky dome and the stars follow the camera, the sun follows the action (the shadow map stays dense around it),
   * the motes drift */
  function skyFrame(dt) {
    sky.position.copy(camera.position);
    view.sky = sky;
    // sun follows the action so the shadow map stays dense around it
    const L = (view.look || SS.look.LOOKS.temperate).sunDir;
    sun.target.position.copy(view.camT); sun.position.set(view.camT.x + L[0] * 80, view.camT.y + L[1] * 80, view.camT.z + L[2] * 80);
    SS.terrain.uniforms.uSunDir.value.set(L[0], L[1], L[2]).normalize();
    motes.position.set(view.camT.x, 0, view.camT.z);
    const mp = motes.geometry.attributes.position;
    for (let i = 0; i < mp.count; i++) {
      let y = mp.getY(i) + dt * 0.12;
      if (y > 20) y = 1 + Math.random() * 2;
      mp.setXYZ(
        i,
        mp.getX(i) + Math.sin(view.time * 0.3 + i) * dt * 0.15,
        y,
        mp.getZ(i) + Math.cos(view.time * 0.25 + i * 1.7) * dt * 0.15
      );
    }
    mp.needsUpdate = true;
  }
  /* the view modules' frames, in this order (several read what an earlier one wrote: the ground decals, the sea level,
   * the weather's flash) */
  function viewsFrame(S, dt, ctxA, insp) {
    if (SS.groundView) SS.groundView.begin();
    if (SS.actors.sync) SS.actors.sync(S, view, ctxA, insp, dt);
    if (SS.lavaView) SS.lavaView.frame(S, view);
    if (SS.bodyView) SS.bodyView.frame(S, view);
    if (SS.treeView) SS.treeView.frame(S, view);
    V.seaSync();
    if (SS.waterView) SS.waterView.frame(S, view, camera);
    if (SS.dunesView) SS.dunesView.frame(S, view);
    if (SS.weatherView) SS.weatherView.frame(S, view, camera, dt);
    if (SS.terrain.capFlash) SS.terrain.capFlash(view.flash || 0);           // P118b: the lightning flash lights the cut face too
    // P85: the overview of a cave world is lit: the whole map has to be readable (the cave dark is for the play view)
    if (SS.world.under) hemi.intensity = hemi.intensity * V.caveLamp.hemi + (insp > 0.02 ? insp * 2.2 : 0);
    if (SS.lifeView) SS.lifeView.frame(S, view, camera, dt);
    if (SS.trailView) SS.trailView.frame(S, view, camera, dt);
    if (SS.farView) SS.farView.frame(view.time);
    if (SS.cloudView) {
      SS.cloudView.frame(S, view, camera, dt);
      if (SS.skyView) SS.skyView.frame(camera, SS.cloudView.drift(), SS.cloudView.uniforms.uVis.value, view.time);
    }
    if (SS.shrapView) SS.shrapView.frame(S, view, camera, dt);
    if (SS.spatView) SS.spatView.frame(S, view, camera);
    if (SS.structView) SS.structView.frame(S, view);
    if (SS.derelictView) SS.derelictView.frame(S, view, camera, dt);
    if (SS.alienView) SS.alienView.frame(S, view, camera, dt);
    if (SS.iceView) SS.iceView.frame(S, view);
    if (SS.armsView) SS.armsView.frame(S, view, camera, dt);
    if (SS.weaponsView) SS.weaponsView.frame(S, view, camera, dt);
    for (const n of W4V)
      if (SS[n]) SS[n].frame(S, view, camera, dt);
    if (SS.ventsView) SS.ventsView.frame(S, view, camera, dt);
    if (SS.bloodView) SS.bloodView.frame(S, dt);
    if (SS.groundView) SS.groundView.upload(S);
    SS.fx.update(dt, camera);
    if (SS.flameView) SS.flameView.update(S, dt, camera);
  }
  /* cloud shadows ride the wind aloft (2x the surface wind, like the cloud layer), only in daylight and where the sky
   * is not overcast */
  function cloudShadows(S, dt) {
    // P65c: cloud shadows ride the wind aloft (2x the surface wind, like the cloud layer), only in daylight and where
    // the sky is not overcast
    {
      const wm = S.wind && S.wind.mean ? S.wind.mean : { x: 0, z: 0 },
        cv = S.weather ? S.weather.cloud : 0.1,
        cd = view.cloudD || (view.cloudD = { x: 0, z: 0 });
      cd.x += (wm.x * 2 + 0.6) * Math.min(dt, 0.1); cd.z += (wm.z * 2 + 0.3) * Math.min(dt, 0.1);
      const lit = view.tod === "night" || SS.world.under ? 0 : view.tod === "dusk" ? 0.7 : 1,
        k = 0.34 * lit * M.clamp((0.9 - cv) / 0.5, 0, 1);
      SS.terrain.cloudShadow(cd.x, cd.z, cv, k);
    }
  }
  /* the active worm's lamps: the cave head lamp (a bulb on its head, a spot from it) and the night lamp on the surface;
   * underground the sky world is hidden */
  function lamps(S) {
    // P118c (Q-16): the cave head lamp: the bulb rides on top of the active worm's head (it follows jumps and flips
    // like the tin-foil hat), headSpot hangs at the bulb; only underground (on the surface headSpot is the night lamp,
    // driven below)
    {
      const cv = view.cave,
        a = S.active,
        on = !!cv && SS.world.under && !!a && !a.dead,
        vis = on ? SS.actors.vis(a) : null,
        v = vis && vis.v,
        host = v ? v.body : null;
      if (cv) {
        if (cv.host !== host) {
          if (cv.host) cv.host.remove(cv.dot);
          if (host) host.add(cv.dot);
          cv.host = host;
        }
        cv.dot.visible = !!host;
        if (SS.world.under) {
          headSpot.intensity = host ? V.caveLamp.spot / Math.max(0.6, renderer.toneMappingExposure) : 0;
          headSpot.angle = V.caveLamp.cone;
        }
        if (host) {
          const ep = v.eyes.position,
            ha = v.eyes.rotation.z,
            ux = -Math.sin(ha),
            uy = Math.cos(ha),
            fx = Math.cos(ha),
            fy = Math.sin(ha),
            n = SS.plane.nrm(S),
            d = SS.plane.dir(S),
            f = a.facing || 1;
          cv.dot.position.set(ep.x + ux * 0.27 + fx * 0.03, ep.y + uy * 0.27 + fy * 0.03, 0.06);
          cv.dot.updateWorldMatrix(true, false);
          cv.dot.getWorldPosition(headSpot.position);
          headSpot.target.position.set(
            a.pos.x + d.x * f * V.caveLamp.aim + n.x * 0.1,
            a.pos.y - 0.5,
            a.pos.z + d.z * f * V.caveLamp.aim + n.z * 0.1
          );
          headSpot.target.updateMatrixWorld();
        }
      }
    }
    // U: underground maps hide the whole sky world (several modules re-enable their meshes per frame) and light the
    // active worm's lamp
    if (SS.world.under) {
      if (sky) sky.visible = false;
      if (motes) motes.visible = false;
      for (const m of [SS.cloudView && SS.cloudView.mesh && SS.cloudView.mesh(), SS.farView && SS.farView.quad && SS.farView.quad()])
        if (m) m.visible = false;
      if (SS.waterView && SS.waterView.meshes)
        for (const m of SS.waterView.meshes())
          if (m) m.visible = false;
      // P118c: the fill in front of the worm (toward the camera), not inside its head: the worm gets about 5 (it was
      // 700), the cave around it keeps its warm glow; V.caveLamp holds the numbers (20 cd, 2.4 m), the cut face is lit
      // by it (terrain.js capN)
      const a = S.active, CL = V.caveLamp;
      lamp.intensity = a && !a.dead ? CL.fill : 0;
      if (a) lamp.position.set(a.pos.x + SS.plane.nrm(S).x * CL.ahead, a.pos.y + CL.up, a.pos.z + SS.plane.nrm(S).z * CL.ahead);
    } else {
      if (sky) sky.visible = true;
      if (motes) motes.visible = view.tod !== 'night';
      // night: the active worm's lamp lights its surroundings (as in the caves, a little weaker)
      /* P65c: the lamp hangs 1.1 m in front of the worm (toward the camera) and 0.9 m up, not inside its head: at 0.3 m
       * the 1/d^1.6 falloff
       * burned the worm white (and left the cut face at a grazing angle) */
      const a = S.active, on = view.tod === 'night' && a && !a.dead;
      // candela, scaled to the exposure so the pool keeps its brightness against the moonlit scene
      lamp.intensity = 0; headSpot.angle = 0.66; headSpot.intensity = on ? 44 / Math.max(0.6, renderer.toneMappingExposure) : 0;
      if (a) {
        const n = SS.plane.nrm(S), d = SS.plane.dir(S), f = a.facing || 1;
        headSpot.position.set(a.pos.x + d.x * f * 0.3 + n.x * 0.45, a.pos.y + 0.8, a.pos.z + d.z * f * 0.3 + n.z * 0.45);
        headSpot.target.position.set(a.pos.x + d.x * f * 3.6 + n.x * 0.1, a.pos.y - 0.5, a.pos.z + d.z * f * 3.6 + n.z * 0.1);
        headSpot.target.updateMatrixWorld();
      }
    }
  }
  /* the End of the World's space look, the shared environment map, the cave's ambient bounce */
  function ambientFrame(S) {
    // P68c: the space look (lights, sky, core, debris)
    if (S.eow && SS.eowView) SS.eowView.frame(S, view, camera, { scene, renderer, sun, hemi, fill, lamp, sky, motes, stars, Q, tx });
    // P100: rebuilds the environment map only when the look changed (or every 30 s)
    if (SS.envView) SS.envView.frame(camera, view.time);
    // P65i: ambient bounce inside caves. The eye adapts to a cave's gloom, so the level is nearly constant (about 1.1 /
    // pi irradiance); only its tint follows the light that comes in (sky + sun / moon)
    {
      const cs = hemi.color, cg = hemi.groundColor, sc = sun.color, hi = hemi.intensity, si = sun.intensity * 0.4;
      const lr = (cs.r * 0.65 + cg.r * 0.35) * hi + sc.r * si,
        lg = (cs.g * 0.65 + cg.g * 0.35) * hi + sc.g * si,
        lb = (cs.b * 0.65 + cg.b * 0.35) * hi + sc.b * si;
      const lum = Math.max(1e-3, 0.2126 * lr + 0.7152 * lg + 0.0722 * lb),
        k = SS.world.under ? 0 : 1.3 * (0.5 + 0.5 * M.clamp(lum / 2.5, 0, 1)) / Math.PI / lum;
      SS.terrain.uniforms.uCaveAmb.value.setRGB(lr * k, lg * k, lb * k);
    }
  }
  /* the frame itself: the shader prewarm, the lens pass (black holes, heat haze, the colour grade) or a plain render,
   * the section's tick, the front ghost */
  function draw(S, dt) {
    if (SS.prewarm) SS.prewarm.tick();
    if (stars) {
      stars.position.copy(camera.position);
      stars.visible = !SS.world.under && stars.material.opacity > 0;
    }
    if (SS.lens) SS.lens.tick(dt);
    let hz = SS.flameView && Q.haze && !SS.world.under && SS.flameView.haze().n > 0 ? SS.flameView.haze() : null;
    // P87: vents shimmer too       // P45: heat haze over big fires (high quality only: costs a lens pass)
    if (Q.haze && SS.ventsView && !SS.world.under) {
      const vh = SS.ventsView.haze(camera);
      if (vh.n > 0) {
        const fh = hz, d = new Float32Array(32);
        let n = 0;
        if (fh) {
          d.set(fh.d.subarray(0, fh.n * 4));
          n = fh.n;
        }
        d.set(vh.d.subarray(0, vh.n * 4), n * 4);
        hz = { n: Math.min(4, n + vh.n), d };
      }
    }
    // P29c: gravitational lensing (render/lens.js)
    if (SS.lens && ((S.holes && S.holes.length) || SS.lens.active() || hz || (Q.grade && !SS.lens.off))) {
      const HK = C.ARMS.HOLE;
      SS.lens.render(
        renderer,
        scene,
        camera,
        !(S.holes && S.holes.length)
          ? NO_HOLES
          : S.holes.map(h => ({ x: h.x, y: h.y, z: h.z, s: 0.25 + 0.55 * Math.min(1, h.t / HK.GROW) })),
        hz
      );
    } else renderer.render(scene, camera);
    SS.section.tick(scene, renderer);
    // P46: the optional front ghost (0 = off, costs nothing)
    if (SS.section.ghost > 0) SS.section.renderGhost(renderer, scene, camera, V);
  }

})(window.SS = window.SS || {});
