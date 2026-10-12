/* render/prewarm.js — shader pre-warm (P38-R4; Three.js specific, presentation only).
 * A program is compiled the first time a material is drawn: a first black hole / force field / explosion / air strike hitched
 * 20-340 ms. Two parts:
 *  1. registry: every THREE.Material created from now on is remembered (a WeakRef list; this file loads right after three.js, before
 *     any module makes its shared materials), also the ones whose meshes only appear when a weapon is used;
 *  2. warm(): the materials that are not on a mesh of the scene are put on a 1-triangle dummy mesh in a scratch scene and compiled
 *     (renderer.compile with the main scene as the target: its lights / fog), for the canvas and for a float render target (the
 *     lens path: other output colour space = other programs). Spread over frames (PER_FRAME materials per call of tick()), the
 *     driver compiles in parallel (KHR_parallel_shader_compile): nothing blocks.
 * API: SS.prewarm.count(); .begin(renderer, scene, camera, mainScene) -> queues the registry; .tick(n) -> materials left;
 * .stats(). Porting: not needed (a native engine compiles pipelines at load). */
(function (SS) {
  'use strict';
  const T = window.THREE, PW = SS.prewarm = {};
  const refs = [];
  if (T && T.Material && !Object.getOwnPropertyDescriptor(T.Material.prototype, '__reg')) {
    Object.defineProperty(T.Material.prototype, '__reg', { value: 1 });
    Object.defineProperty(T.Material.prototype, 'type', {
      configurable: true,
      get() { return undefined; },
      set(v) { Object.defineProperty(this, 'type', { value: v, writable: true, configurable: true, enumerable: true }); refs.push(new WeakRef(this)); if (PW.onLate && rend) PW.onLate(this); }
    });
  }
  const only4 = new Set();
  let todo = [], rend = null, cam = null, main = null, warmScene = null, tri = null, tri4 = null, rtTiny = null, done = 0, total = 0;
  const PER_FRAME = 2;
  function dummyGeo() {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    g.setAttribute('normal', new T.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    g.setAttribute('uv', new T.BufferAttribute(new Float32Array(6), 2));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(9).fill(1), 3));
    return g;
  }
  function dummyGeo4() {
    const g = dummyGeo(); g.setAttribute('color', new T.BufferAttribute(new Float32Array(12).fill(1), 4)); return g;
  }
  /* P78: lazily created effect objects (a crate with its parachute, a grave, the air-strike plane, rocket plumes, a sentry beam ...) are asked
   * for here once: PW.exemplars(fn) registers a function that BUILDS one of them (with the module's own builder, so the same materials, defines,
   * geometry attributes and cache keys) and returns an Object3D (or an array of them) that is never put in the scene. Its meshes are compiled
   * like any material (canvas + lens target, with the clipping state they are drawn with) and then dropped. */
  const providers = [];
  PW.exemplars = fn => { providers.push(fn); };
  PW.tri = () => tri || (tri = dummyGeo());
  PW.begin = function (renderer, scene, camera, mainScene) {
    rend = renderer; cam = camera; main = mainScene || scene;
    const inScene = new Set(), skip = o => { const m = o.material; if (m) { if (Array.isArray(m)) m.forEach(x => inScene.add(x)); else inScene.add(m); } };
    main.traverse(skip); if (SS.farView && SS.farView.scene) SS.farView.scene().traverse(skip);
    todo = []; only4.clear(); const keep = [], covered = new Set(); PW.tri(); if (!tri4) tri4 = dummyGeo4();
    for (const fn of providers) {
      try {
        const r = fn(), list = Array.isArray(r) ? r : r ? [r] : [];
        for (const root of list) root.traverse(o => { if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || !o.material) return; o.frustumCulled = false; todo.push(o); for (const m of Array.isArray(o.material) ? o.material : [o.material]) covered.add(m); });
      } catch (e) { console.warn('prewarm exemplar: ' + e); }
    }
    for (const r of refs) { const m = r.deref(); if (!m) continue; keep.push(r); if (covered.has(m)) continue; if (inScene.has(m)) { if (m.isMaterial && m.vertexColors && !m.isShaderMaterial) { only4.add(m); todo.push(m); } continue; }
      if (m.isMaterial && (m.isShaderMaterial || m.isMeshStandardMaterial || m.isMeshBasicMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isPointsMaterial || m.isLineBasicMaterial || m.isSpriteMaterial)) todo.push(m); }
    refs.length = 0; for (const r of keep) refs.push(r);
    total = todo.length; done = 0;
    if (!warmScene) warmScene = new T.Scene();
    if (!rtTiny) rtTiny = new T.WebGLRenderTarget(4, 4, { type: T.HalfFloatType, samples: 0 });
    return total;
  };
  /* P78: renderer.compile() builds the program with the clipping state left by the LAST DRAW (clipping.numPlanes is stale there), so a material
   * that is drawn clipped (the section rule gives every material one plane) was compiled with 0 planes and compiled AGAIN on its first real draw
   * (edge, glass, chunk bodies, felled tree parts: 60-140 ms). Fix: the batch is split into clipped / exempt materials and a tiny reference mesh of
   * the same kind is DRAWN (into a 4 x 4 target) before each compile, which sets the state. Also: vertex colours with and without alpha (edge
   * meshes use rgba), transparent double-sided materials (three draws them as a back pass then a front pass: two programs). */
  function dummyFor(m, g) {
    let o;
    if (m.isPointsMaterial) o = new T.Points(g || tri, m);
    else if (m.isLineBasicMaterial) o = new T.Line(g || tri, m);
    else if (m.isSpriteMaterial) o = new T.Sprite(m);
    else o = new T.Mesh(g || tri, m);
    o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true; return o;
  }
  let refScene = null, refClip = null, refFree = null;
  function setClipState(clipped) {
    if (!refScene) {
      refScene = new T.Scene();
      refClip = new T.Mesh(tri, new T.MeshBasicMaterial()); refFree = new T.Mesh(tri, new T.MeshBasicMaterial());
      refFree.material.userData.sectionExempt = 'prewarm state';
      refClip.frustumCulled = refFree.frustumCulled = false; refScene.add(refClip, refFree);
    }
    refClip.visible = clipped; refFree.visible = !clipped;
    const ac = rend.autoClear; rend.autoClear = false;
    rend.setRenderTarget(rtTiny); rend.render(refScene, cam); rend.autoClear = ac;
  }
  /* the light count is part of a program's key (lights that are not visible are not counted): the match toggles some lights (flash, torches, jets),
   * so each material is compiled with the lights as they are AND with every light on (the state V.prewarm compiled the scene in) */
  function compileAll() {
    const lights = [], hid = [];
    main.traverse(o => { if (o.isLight) lights.push(o); });
    for (const pass of [0, 1]) {
      if (pass === 1) { for (const l of lights) if (!l.visible) { l.visible = true; hid.push(l); } if (!hid.length) break; }
      for (const rt of [null, rtTiny]) {                     // the canvas, the lens / float target
        rend.setRenderTarget(rt); rend.compile(warmScene, cam, main);
      }
    }
    for (const l of hid) l.visible = false;
  }
  /* the shadow-depth programs (three builds a depth material per caster: double-sided, alpha-tested, clipped ...) are only made by a real shadow pass:
   * the casters go through a scene with its own tiny shadow-casting light; the colour pass of that scene uses one override material (no extra programs) */
  let shScene = null;
  const depthSigs = new Set();                           // the depth programs differ by side, alpha test / map, clipping, a custom depth material, instancing: one caster per combination is enough
  function newDepthSig(o) {
    const m = Array.isArray(o.material) ? o.material[0] : o.material, dm = o.customDepthMaterial;
    const sig = [m.side, m.alphaTest > 0 ? 1 : 0, m.alphaTest > 0 && m.map ? 1 : 0, m.alphaMap ? 1 : 0, m.clippingPlanes && m.clippingPlanes.length ? 1 : 0, m.shadowSide === null ? 0 : 1, dm ? dm.uuid : 0, o.isInstancedMesh ? 1 : 0, m.displacementMap ? 1 : 0].join('|');
    if (depthSigs.has(sig)) return false;
    depthSigs.add(sig); return true;
  }
  function shadowWarm(objs) {
    if (!rend.shadowMap.enabled) return;
    if (!shScene) {
      shScene = new T.Scene(); const l = new T.DirectionalLight(0xffffff, 1); l.castShadow = true; l.shadow.mapSize.set(8, 8); l.position.set(0, 5, 0); shScene.add(l, l.target);
      shScene.overrideMaterial = new T.MeshBasicMaterial({ colorWrite: false, depthWrite: false }); shScene.overrideMaterial.userData.sectionExempt = 'prewarm';
    }
    const ac = rend.autoClear; rend.autoClear = false;
    for (const o of objs) shScene.add(o);
    try { rend.setRenderTarget(rtTiny); rend.render(shScene, cam); } finally { rend.autoClear = ac; for (const o of objs) shScene.remove(o); }
  }
  /* an exemplar is thrown away after the compile: its geometry and textures are released (unless flagged shared: baked models), its MATERIALS stay
   * undisposed on purpose: a program lives as long as one material that uses it is alive (disposing them would drop the programs again) */
  function freeExemplar(o) {
    if (o.geometry && !(o.geometry.userData && o.geometry.userData.shared) && o.geometry !== tri && o.geometry !== tri4) o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m && m.map && !(m.map.userData && m.map.userData.shared) && !(m.userData && m.userData.shared)) m.map.dispose();
    }
  }
  const matsOf = it => it.isMaterial ? [it] : Array.isArray(it.material) ? it.material : [it.material];
  PW.tick = function (n) {
    if (!todo.length || !rend) return 0;
    const batch = todo.splice(0, n || PER_FRAME), rt0 = rend.getRenderTarget(), groups = [[], []];
    for (const it of batch) { const m = matsOf(it)[0]; groups[m.clippingPlanes && m.clippingPlanes.length ? 1 : 0].push(it); }
    try {
      for (let gi = 0; gi < 2; gi++) {
        const its = groups[gi]; if (!its.length) continue;
        for (const it of its) {
          if (!it.isMaterial) { warmScene.add(it); continue; }                 // (an exemplar mesh: its own geometry)
          if (!only4.has(it)) warmScene.add(dummyFor(it));
          if (it.vertexColors) warmScene.add(dummyFor(it, tri4));
        }
        setClipState(gi === 1);
        compileAll();
        const casters = warmScene.children.filter(o => o.isMesh && o.castShadow && newDepthSig(o));
        for (const o of warmScene.children.slice()) warmScene.remove(o);
        if (casters.length) shadowWarm(casters);
        for (const it of its) if (!it.isMaterial) freeExemplar(it);
      }
    } catch (e) { console.warn('prewarm: ' + e); }
    rend.setRenderTarget(rt0);
    done += batch.length;
    return todo.length;
  };
  PW.stats = () => ({ registered: refs.length, queued: todo.length, done, total });
})(window.SS = window.SS || {});
