/* render/section.js — the ONE automatic section visibility rule (P46; Three.js specific, presentation only).
 * Rule: everything on the viewer's side of the section plane (slice zero, t = dot(p - uO, uN) > margin) is invisible.
 * It is applied to EVERY material by default, so a new object can never forget it. Loaded right after three.js, before
 * any module makes a material.
 *  1. Built-in materials (Standard, Basic, Points, Line, Sprite, depth ...): THREE's own clipping.
 *     Material.prototype.clippingPlanes / clipShadows are accessors that return the shared section plane (one
 *     THREE.Plane per margin), so every material (also the shadow-depth ones) is clipped without anybody assigning
 *     anything; renderer.localClippingEnabled is switched on for every WebGLRenderer.
 *  2. ShaderMaterial (custom GLSL): Material.prototype.onBeforeCompile is an accessor whose wrapper runs the module's
 *     own patch after the module's function: main() of both shaders is renamed and wrapped; the vertex wrapper rebuilds
 *     the world position from gl_Position (inverse(projection), inverse(view)), the fragment wrapper discards by the
 *     same plane. No shader has to know about it.
 *  3. Margin: default 0.5 m in front of slice zero (worms / props standing ON the plane keep their volume);
 *     terrain-like materials set userData.sectionMargin = 0 (the cut face is at t = 0). The slab-behind rule (t <
 *     -uBack) stays in the terrain-like shaders.
 *  4. Opt-out: material.userData.sectionExempt = 'reason' (SS.section.exempt(mat, why)). Allowed: sky dome / sky LUT /
 *     clouds / far land (the landscape beyond the world), full-screen post quads, the air-strike plane + its propeller
 *     (P69: it flies above the battlefield across the plane; cut in half it read as a broken model). Everything else
 *     follows the rule.
 *  5. Inspection (view.insp > 0.05) switches the rule off (the whole 3D world is shown by design); a cave world keeps
 *  it on (SEC.cutOv, see update()).
 *  6. Front ghost (user setting 0..100 %): when > 0 the part the rule removes is drawn by a second pass (planes
 *     inverted, offscreen target) and composited over the frame at that opacity (desaturated, blue tinted, outlined). 0
 *     % costs nothing.
 *  7. audit(scene, renderer): lists every visible mesh / points / line / sprite whose material does not carry the rule
 *     and is not exempt (tools/dev/sectiontest.cjs asserts none).
 * API: SS.section = { attach(renderer, scene), DEF_M, exempt(mat, why), isExempt(mat), planes(margin), update(O, N,
 *   insp, keep), mode, cutOv, setGhost(pct), ghost, renderGhost(renderer, scene, camera, view), audit(scene, renderer),
 *   uniforms }. Porting: a native engine uses one clip plane in its material system. */
(function (SS) {
  'use strict';
  const T = window.THREE, SEC = SS.section = {};
  if (!T || !T.Material) return;
  const DEF_M = SEC.DEF_M = 0.5;
  // (the GLSL patch rebuilds the world position from gl_Position: a centimetre of tolerance)
  const BIG = 1e7, GLSL_EPS = 0.01;
  /* shared state: uP = world plane (N, -dot(N, O)): t = dot(uP.xyz, p) + uP.w; uS.x = mode (0 hide the front, 1 only
   * the front, 2 off) */
  const uP = { value: new T.Vector4(0, 0, 1, 0) }, uS = { value: new T.Vector2(0, 0) };
  // 1 while the ghost pass draws (for shaders that keep their own front cut, e.g. trees)
  const uG = { value: 0 };
  SEC.uniforms = { uSecP: uP, uSecS: uS, uSecG: uG };
  SEC.mode = 0;
  SEC.ghost = 0;
  SEC.frontOn = false;
  SEC.cutOv = false;
  const N = new T.Vector3(0, 0, 1), O = new T.Vector3();
  const sets = new Map();                                    // margin -> { planes: [Plane], m }
  function planes(m) {
    let s = sets.get(m);
    if (!s) {
      s = { planes: [new T.Plane(new T.Vector3(0, 0, -1), 0)], m };
      sets.set(m, s);
      apply(s);
    }
    return s.planes;
  }
  SEC.planes = planes;
  /* THREE keeps a point when dot(n, p) + constant >= 0: mode 0 keeps t <= m (n = -N), mode 1 keeps t >= m (n = N), mode
   * 2 keeps all */
  function apply(s) {
    const pl = s.planes[0], d = N.dot(O);
    if (SEC.mode === 0) {
      pl.normal.copy(N).negate();
      pl.constant = d + s.m;
    }
    else if (SEC.mode === 1) {
      pl.normal.copy(N);
      pl.constant = -d - s.m;
    }
    else {
      pl.normal.set(0, 1, 0);
      pl.constant = BIG;
    }
  }
  function applyAll() {
    for (const s of sets.values()) apply(s);
    uP.value.set(N.x, N.y, N.z, -N.dot(O)); uS.value.set(SEC.mode, 0); uG.value = SEC.mode === 1 ? 1 : 0;
  }
  SEC.setMode = function (m) {
    if (SEC.mode !== m) {
      SEC.mode = m;
      applyAll();
    }
  };
  /* per frame (view.js): the plane (O on it, N toward the viewer); inspection = off, except where `keep` holds the rule
   * through the overview (a cave world, whose
   * overview is the section face with the tunnels as an x-ray, render/terrain.js: the rock in front of the face must
   * not be drawn, it hides the face. SEC.cutOv is that state; the front ghost is not drawn then, the x-ray already
   * shows the front tunnels) */
  SEC.update = function (o, n, insp, keep) {
    O.set(o.x, o.y || 0, o.z); N.set(n.x, n.y || 0, n.z);
    SEC.cutOv = !!keep && insp > 0.05;
    SEC.mode = insp > 0.05 && !SEC.cutOv ? 2 : 0;
    // the front ghost is on: the CPU culls of the front half are lifted (the planes clip it)
    SEC.frontOn = SEC.ghost >= 0.5 && SEC.mode === 0 && !SEC.cutOv;
    applyAll();
  };
  const isExempt = SEC.isExempt = m => !!(m.userData && m.userData.sectionExempt);
  SEC.exempt = function (m, why) {
    if (m) {
      m.userData = m.userData || {};
      m.userData.sectionExempt = why || true;
    }
    return m;
  };
  const marginOf = m => (m.userData && m.userData.sectionMargin != null ? m.userData.sectionMargin : DEF_M);

  /* 1. built-in clipping: the default of every material (explicit clippingPlanes assigned by a module are kept, but the
   * audit reports them) */
  const MP = T.Material.prototype;
  if (!Object.getOwnPropertyDescriptor(MP, '__sec')) {
    Object.defineProperty(MP, '__sec', { value: 1 });
    Object.defineProperty(MP, 'clippingPlanes', {
      configurable: true,
      get() {
        if (this._cpx) return this._cpx;
        return isExempt(this) ? null : planes(marginOf(this));
      },
      set(v) { this._cpx = v && v.length ? v : undefined; }
    });
    Object.defineProperty(MP, 'clipShadows', { configurable: true, get() { return !isExempt(this); }, set() { } });
    const copy0 = MP.copy;
    MP.copy = function (src) {
      const r = copy0.call(this, src);
      this._cpx = undefined;
      return r;
    };

    /* 2. custom GLSL: patched after the module's own onBeforeCompile */
    const RE = /void\s+main\s*\(\s*(?:void\s*)?\)/;
    const VPOST = '\nvoid main() { secMainV_(); vec4 secH = inverse(viewMatrix) * (inverse(projectionMatrix) * gl_Position); vSecW = secH.xyz / secH.w; }\n';
    const FPOST = '\nvoid main() {\n  float secT = dot(uSecP.xyz, vSecW) + uSecP.w;\n  if (uSecS.x < 0.5 ? secT > uSecM : (uSecS.x < 1.5 && secT < uSecM)) discard;\n  secMainF_();\n}\n';
    function inject(mat, p) {
      // P105: a wrapped onBeforeCompile (a cloned log material calls the base's) injects once; the outer material still
      // carries the flag
      if (p.__sec) {
        if (p.__secMode && mat.userData) mat.userData.sectionInjected = p.__secMode;
        return;
      }
      p.__sec = 1;
      if (isExempt(mat)) return;
      const vs = p.vertexShader, fs = p.fragmentShader;
      if (!vs || !fs || mat.isRawShaderMaterial) return;
      if (/clipping_planes_fragment/.test(fs)) {
        mat.userData.sectionInjected = p.__secMode = 'native';
        return;
      }
      if (!RE.test(vs) || !RE.test(fs)) return;
      p.vertexShader = vs.replace(RE, 'varying vec3 vSecW;\nvoid secMainV_()') + VPOST;
      p.fragmentShader = fs.replace(
        RE,
        'varying vec3 vSecW; uniform vec4 uSecP; uniform vec2 uSecS; uniform float uSecM;\nvoid secMainF_()'
      )
        + FPOST;
      p.uniforms.uSecP = uP; p.uniforms.uSecS = uS; p.uniforms.uSecM = { value: marginOf(mat) + GLSL_EPS };
      mat.userData.sectionInjected = p.__secMode = 'glsl';
    }
    function wrap(mat, user) {
      const w = function (p, r) {
        if (user) user.call(mat, p, r);
        inject(mat, p);
      };
      w.toString = () => (user ? user.toString() : 'section') + (isExempt(mat) ? '|ex' : '|sec');
      return w;
    }
    Object.defineProperty(MP, 'onBeforeCompile', {
      configurable: true,
      get() { return this._obc || (this._obc = wrap(this, null)); },
      set(f) { this._obc = typeof f === 'function' ? wrap(this, f) : wrap(this, null); }
    });
  }
  /* every renderer gets local clipping */
  if (T.WebGLRenderer && !T.WebGLRenderer.__sec) {
    const R0 = T.WebGLRenderer;
    const R1 = class extends R0 {
      constructor(p) {
        super(p);
        this.localClippingEnabled = true;
      }
    };
    R1.__sec = 1;
    try {
      T.WebGLRenderer = R1;
    } catch (e) { /* frozen namespace: view.js sets the flag itself */ }
  }

  /* the rule belongs to the game scene: any other scene rendered by the renderer (the far landscape pass, PMREM / sky
   * LUT / post quads) is
   * drawn with the rule off, so an offscreen helper pass is never clipped by the section */
  SEC.scene = null;
  SEC.attach = function (renderer, scene) {
    SEC.scene = scene;
    const r0 = renderer.render.bind(renderer);
    renderer.render = function (sc, cam) {
      if (sc === SEC.scene || SEC.mode === 2) return r0(sc, cam);
      const m = SEC.mode;
      SEC.setMode(2);
      try {
        return r0(sc, cam);
      } finally {
        SEC.setMode(m);
      }
    };
  };

  /* 7. audit: what is visible, drawn through the scene graph, and does not carry the rule */
  SEC.audit = function (scene, renderer, camera) {
    const bad = [], ex = {}, out = { checked: 0, violations: bad, exempt: ex, clipOn: renderer ? !!renderer.localClippingEnabled : null };
    const path = o => {
      const a = [];
      for (let q = o; q; q = q.parent) a.push(q.name || q.type);
      return a.reverse().join('/');
    };
    // (every material that would be drawn has its program built, so the flag below is decided)
    if (renderer && camera) renderer.compile(scene, camera);
    scene.traverseVisible(o => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite) || !o.material) return;
      for (const m of [].concat(o.material)) {
        out.checked++;
        if (isExempt(m)) {
          const k = String(m.userData.sectionExempt) + ' ' + (m.name || m.type);
          ex[k] = (ex[k] || 0) + 1;
          continue;
        }
        let why = null;
        if (m._cpx) why = 'explicit clippingPlanes';
        else if (!m.clippingPlanes || !m.clippingPlanes.length) why = 'no planes';
        else if (m.isRawShaderMaterial) why = 'RawShaderMaterial';
        else if (renderer && !renderer.localClippingEnabled) why = 'localClippingEnabled off';
        else if (!m.userData.sectionInjected)
          why = renderer && renderer.properties.get(m).currentProgram ? 'program built without the rule' : 'program not built yet';
        if (why) bad.push({ why, obj: path(o), type: o.type, mat: m.name || m.type, order: o.renderOrder });
      }
    });
    return out;
  };

  /* runtime watch (?secaudit=1, used by tests/verify.cjs): every 90 frames the audit runs and a violation is logged
   * once per object */
  let watchOn = false, watchN = 0;
  const seen = new Set();
  try {
    watchOn = /(?:^|[?&])secaudit=1(?:&|$)/.test(window.location.search);
  } catch (e) {
    watchOn = false;
  }
  SEC.tick = function (scene, renderer) {
    if (!watchOn || (++watchN % 90) !== 0) return;
    const r = SEC.audit(scene, renderer);
    for (const v of r.violations) {
      const k = v.obj + '|' + v.mat + '|' + v.why;
      if (v.why === 'program not built yet' || seen.has(k)) continue;
      seen.add(k);
      console.warn('section rule: ' + k);
    }
  };

  /* 6. front ghost. P118b (QA1 Q-09: it read as frosted glass, a milky double exposure over the cut face): the part the
   * rule removes is drawn into an offscreen target WITH a depth
   * texture and composited as (1) a LOW-opacity flat fill (cool, a little of its own colour, a quarter of the chosen
   * opacity at the default 50 %), (2) a crisp one-pixel outline where a nearer surface ends in front of a farther one
   * (a Laplacian of the linear depth: silhouettes and ridges, never a surface's own slope; the nearer side only), and
   * (3) a fade by the distance in front of the section plane (the foreground next to the camera lets go first, what is
   * close to the plane stays). No blur, no dither, no stipple. */
  let rt = null, quadScene = null, quadCam = null, qmat = null;
  const sz = new T.Vector2(), invVP = new T.Matrix4();
  function ghostInit(renderer, samples) {
    const dt = new T.DepthTexture(4, 4);
    dt.type = T.UnsignedIntType;
    dt.minFilter = dt.magFilter = T.NearestFilter;
    rt = new T.WebGLRenderTarget(4, 4, { type: T.HalfFloatType, samples: samples || 0, depthTexture: dt });
    qmat = new T.ShaderMaterial({
      uniforms: {
        tG: { value: rt.texture },
        tD: { value: dt },
        uK: { value: 0 },
        uPx: { value: new T.Vector2(1, 1) },
        uInvVP: { value: invVP },
        uPl: { value: uP.value },
        uNF: { value: new T.Vector2(0.1, 900) },
        uFade: { value: 16 }
      },
      depthTest: false, depthWrite: false, transparent: true, blending: T.CustomBlending,
      blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor, blendSrcAlpha: T.OneFactor, blendDstAlpha: T.OneMinusSrcAlphaFactor,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */`
        uniform sampler2D tG, tD;
        uniform float uK, uFade;
        uniform vec2 uPx, uNF;
        uniform mat4 uInvVP;
        uniform vec4 uPl;
        varying vec2 vUv;
        float lin(vec2 uv){
          float z = texture2D(tD, uv).x;
          return 2.0 * uNF.x * uNF.y / (uNF.y + uNF.x - (z * 2.0 - 1.0) * (uNF.y - uNF.x));
        }
        void main() {
          vec4 g = texture2D(tG, vUv);
          if (g.a < 0.004) discard;
          float d0 = lin(vUv), dl = lin(vUv - vec2(uPx.x, 0.0)), dr = lin(vUv + vec2(uPx.x, 0.0)), du = lin(vUv + vec2(0.0, uPx.y)),
            dn = lin(vUv - vec2(0.0, uPx.y));
          float dl2 = lin(vUv - vec2(uPx.x * 2.0, 0.0)), dr2 = lin(vUv + vec2(uPx.x * 2.0, 0.0)), du2 = lin(vUv + vec2(0.0, uPx.y * 2.0)),
            dn2 = lin(vUv - vec2(0.0, uPx.y * 2.0));
          // a step to a FARTHER surface (or to the open sky: no depth there): the Laplacian is large and positive on
          // the nearer side only; two reaches (1 and 2 px) give the line a soft two-pixel body instead of a jagged
          // single pixel
          float lap = max(dl + dr - 2.0 * d0, du + dn - 2.0 * d0) / max(d0, 1.0),
            lap2 = max(dl2 + dr2 - 2.0 * d0, du2 + dn2 - 2.0 * d0) / max(d0, 1.0);
          vec2 p3 = uPx * 3.0;
          float cov = (g.a + texture2D(tG, vUv - vec2(p3.x, 0.0)).a + texture2D(tG, vUv + vec2(p3.x, 0.0)).a + texture2D(tG, vUv + vec2(0.0, p3.y)).a + texture2D(tG, vUv - vec2(0.0, p3.y)).a) * 0.2;
          // (thin things, grass blades, foliage, are not outlined: they would scribble)
          float edge = max(smoothstep(0.09, 0.28, lap), 0.6 * smoothstep(0.12, 0.34, lap2)) * smoothstep(0.3, 0.9, g.a) * smoothstep(0.5, 0.7, cov);
          // where this pixel is: metres in front of the section plane
          vec4 ndc = vec4(vUv * 2.0 - 1.0, texture2D(tD, vUv).x * 2.0 - 1.0, 1.0);
          vec4 wp = uInvVP * ndc;
          float t = max(dot(uPl.xyz, wp.xyz / wp.w) + uPl.w, 0.0);
          float fade = exp(-t / uFade);
          vec3 c = g.rgb / max(g.a, 1e-3);
          gl_FragColor = vec4(c, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          vec3 col = gl_FragColor.rgb;
          float l = dot(col, vec3(0.299, 0.587, 0.114));
          col = mix(vec3(l), col, 0.42) * vec3(0.8, 0.93, 1.12) * 0.9;
          // the chosen opacity to the power 1.5: 50 % reads as about a third, 100 % is solid
          float fill = g.a * uK * sqrt(uK) * mix(0.45, 1.0, fade);
          float line = edge * min(1.0, uK * 1.8) * mix(0.55, 1.0, fade) * 0.85;
          // an azure outline (the cut's own outline is cream): reads on a bright sky and on dark rock
          vec3 lc = vec3(0.46, 0.74, 1.0);
          float al = clamp(fill + line * (1.0 - fill), 0.0, 1.0);
          gl_FragColor = vec4(col * fill * (1.0 - line) + lc * line, al);
        }`
    });
    quadScene = new T.Scene(); quadCam = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const q = new T.Mesh(new T.PlaneGeometry(2, 2), SEC.exempt(qmat, 'ghost composite quad'));
    q.frustumCulled = false;
    quadScene.add(q);
  }
  // (per-frame scratch: the ghost pass used to allocate an array, a Color and a [].concat per object every frame)
  const hid = [], ccTmp = new T.Color();
  let hidN = 0;
  /* P118b: the ghost shows what stands in front of the plane (terrain, trees, props, worms, effects), not the water:
   * the sea in front is a flat sheet that carries nothing and was the
   * widest milky area of the old ghost. A water surface is recognised by its uniforms (render/water.js: uDeep +
   * uShallow on the grid, the outer ocean and the section face). */
  const isWater = m => !!(m.uniforms && m.uniforms.uDeep && m.uniforms.uShallow);
  function hideExempt(o) {
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) {
      for (let i = 0; i < m.length; i++)
        if (!isExempt(m[i]) && !isWater(m[i])) return;
    }
    else if (!isExempt(m) && !isWater(m)) return;
    hid[hidN++] = o;
  }
  SEC.setGhost = function (pct) {
    const v = Number.isFinite(+pct) ? Math.max(0, Math.min(100, +pct)) : 0;
    SEC.ghost = v;
    SEC.frontOn = v >= 0.5 && SEC.mode === 0;
    return v;
  };
  /* second pass: only what the rule removes (planes inverted), into an offscreen target, composited at the chosen
   * opacity */
  SEC.renderGhost = function (renderer, scene, camera, view) {
    const g = SEC.ghost;
    if (g < 0.5 || SEC.mode === 2 || SEC.cutOv) return false;
    renderer.getDrawingBufferSize(sz);
    if (!rt) ghostInit(renderer, view && view.msaa ? view.msaa() : 0);
    if (rt.width !== sz.x || rt.height !== sz.y) rt.setSize(sz.x, sz.y);
    hidN = 0;
    scene.traverseVisible(hideExempt);
    for (let i = 0; i < hidN; i++) hid[i].visible = false;
    const prev = renderer.getRenderTarget(), ca = renderer.getClearAlpha(), ac = renderer.autoClear, sa = renderer.shadowMap.autoUpdate;
    renderer.getClearColor(ccTmp);
    SEC.setMode(1);
    // (R10: a throwing render left the exempt objects hidden and the rule inverted)
    try {
      renderer.shadowMap.autoUpdate = false; renderer.autoClear = true;
      renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear();
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(prev);
      renderer.setClearColor(ccTmp, ca);
      renderer.autoClear = ac;
      renderer.shadowMap.autoUpdate = sa;
      SEC.setMode(0);
      for (let i = 0; i < hidN; i++) hid[i].visible = true;
      hidN = 0;
    }
    qmat.uniforms.uK.value = g / 100; qmat.uniforms.uPx.value.set(1 / sz.x, 1 / sz.y);
    invVP.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse); qmat.uniforms.uNF.value.set(camera.near, camera.far);
    const ac2 = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(quadScene, quadCam);
    renderer.autoClear = ac2;
    return true;
  };
  SEC.ghostStats = () => ({ on: !!rt, size: rt ? [rt.width, rt.height] : null });
})(window.SS = window.SS || {});
