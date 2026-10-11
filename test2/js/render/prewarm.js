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
      set(v) { Object.defineProperty(this, 'type', { value: v, writable: true, configurable: true, enumerable: true }); refs.push(new WeakRef(this)); }
    });
  }
  let todo = [], rend = null, cam = null, main = null, warmScene = null, tri = null, rtTiny = null, done = 0, total = 0;
  const PER_FRAME = 4;
  function dummyGeo() {
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    g.setAttribute('normal', new T.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    g.setAttribute('uv', new T.BufferAttribute(new Float32Array(6), 2));
    g.setAttribute('color', new T.BufferAttribute(new Float32Array(9).fill(1), 3));
    return g;
  }
  PW.begin = function (renderer, scene, camera, mainScene) {
    rend = renderer; cam = camera; main = mainScene || scene;
    const inScene = new Set(), skip = o => { const m = o.material; if (m) { if (Array.isArray(m)) m.forEach(x => inScene.add(x)); else inScene.add(m); } };
    main.traverse(skip); if (SS.farView && SS.farView.scene) SS.farView.scene().traverse(skip);
    todo = []; const keep = [];
    for (const r of refs) { const m = r.deref(); if (!m) continue; keep.push(r); if (!inScene.has(m) && m.isMaterial && (m.isShaderMaterial || m.isMeshStandardMaterial || m.isMeshBasicMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isPointsMaterial || m.isLineBasicMaterial || m.isSpriteMaterial)) todo.push(m); }
    refs.length = 0; for (const r of keep) refs.push(r);
    total = todo.length; done = 0;
    if (!warmScene) { warmScene = new T.Scene(); tri = dummyGeo(); }
    if (!rtTiny) rtTiny = new T.WebGLRenderTarget(4, 4, { type: T.HalfFloatType, samples: 0 });
    return total;
  };
  function dummyFor(m) {
    let o;
    if (m.isPointsMaterial) o = new T.Points(tri, m);
    else if (m.isLineBasicMaterial) o = new T.Line(tri, m);
    else if (m.isSpriteMaterial) o = new T.Sprite(m);
    else o = new T.Mesh(tri, m);
    o.frustumCulled = false; o.castShadow = true; return o;
  }
  PW.tick = function (n) {
    if (!todo.length || !rend) return 0;
    const batch = todo.splice(0, n || PER_FRAME), objs = [];
    for (const m of batch) { const o = dummyFor(m); warmScene.add(o); objs.push(o); }
    const rt0 = rend.getRenderTarget();
    try {
      rend.compile(warmScene, cam, main);                          // the canvas
      rend.setRenderTarget(rtTiny); rend.compile(warmScene, cam, main);    // the lens / float target
    } catch (e) { /* a material that cannot be compiled stays lazy */ }
    rend.setRenderTarget(rt0);
    for (const o of objs) warmScene.remove(o);
    done += batch.length;
    return todo.length;
  };
  PW.stats = () => ({ registered: refs.length, queued: todo.length, done, total });
})(window.SS = window.SS || {});
