/* render/trails.js — P62 small worm / ground interaction details (Three.js specific, presentation only; reads the sim
 * state, never writes it).
 *   - footstep dust: a small puff every ~0.55 m of crawling, coloured by the ground material (render/fx.js dustAt:
 *   soil, sand, snow, ash ...);
 *   - drag marks (the worm's belly trail) pressed into sand / snow / ash / bare soil: a pooled instanced ring buffer of
 *     flat ovals aligned to the terrain normal behind the slice, they fade out after ~10 s (a per-instance fade
 *     attribute, standard material, normal blending);
 *   - splash rings when wading in shallow water (expanding rings on the water surface + a few droplets);
 *   - breath fog at night / dusk / in snow in the alpine biome (soft cold puffs from the worm's mouth);
 *   - P118d (Q-17) the rocket smoke ribbon: one continuous strip per rocket (render/fx.js FX.trail feeds it), not a
 * string of separate puffs. Quality: Q.trail (0.3 on low: the dust only; marks and rings from medium; the smoke ribbon
 * is cheap and always on). API: init(scene, quality), frame(S, view, camera, dt), clear(), stats(), smoke(x, y, z). */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math, P = SS.plane;
  const TV = SS.trailView = {};
  let scene = null, Q = null, marks = null, rings = null, track = new Map(), breathT = new Map();
  const MCAP = 90, RCAP = 24;
  const mk = { n: 0, i: 0, age: new Float32Array(MCAP), life: new Float32Array(MCAP), fade: null };
  const rg = {
    n: 0,
    i: 0,
    age: new Float32Array(RCAP),
    life: new Float32Array(RCAP),
    fade: null,
    x: new Float32Array(RCAP),
    y: new Float32Array(RCAP),
    z: new Float32Array(RCAP),
    s0: new Float32Array(RCAP),
    s1: new Float32Array(RCAP)
  };
  const dummy = new T.Object3D(),
    q1 = new T.Quaternion(),
    q2 = new T.Quaternion(),
    up = new T.Vector3(0, 1, 0),
    nv = new T.Vector3(),
    pv = new T.Vector3(),
    sv = new T.Vector3(),
    m4 = new T.Matrix4(),
    col = new T.Color();
  const MT = SS.CFG.MAT;
  const MARKC = {};
  MARKC[MT.SAND] = [0.5, 0.39, 0.24];
  MARKC[MT.SNOW] = [0.5, 0.6, 0.78];
  MARKC[MT.ASH] = [0.12, 0.11, 0.11];
  MARKC[MT.SOIL] = [0.17, 0.11, 0.07];

  function decalMat() {
    const m = new T.MeshStandardMaterial({
      color: 0xffffff, roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3,
      polygonOffsetUnits: -3, opacity: 1
    });
    m.onBeforeCompile = sh => {
      sh.vertexShader = 'attribute float aFade; varying float vFade;\n'
        + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vFade = aFade;');
      sh.fragmentShader = 'varying float vFade;\n'
        + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.a *= vFade;');
    };
    m.customProgramCacheKey = () => 'trail_decal';
    return m;
  }
  function ovalGeo(inner) {
    const pos = [], idx = [], N = 14;
    for (let i = 0; i < N; i++) {
      const a = i / N * 6.283, c = Math.cos(a), s = Math.sin(a);
      pos.push(c, 0, s, c * inner, 0, s * inner);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 2, b = ((i + 1) % N) * 2;
      if (inner > 0) idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    if (inner <= 0) {
      pos.push(0, 0, 0);
      for (let i = 0; i < N; i++) idx.push(i * 2, ((i + 1) % N) * 2, N * 2);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const nrm = [];
    for (let i = 0; i < pos.length / 3; i++) nrm.push(0, 1, 0);
    g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
    return g;
  }
  function pool(geo, cap, st) {
    const im = new T.InstancedMesh(geo, decalMat(), cap), fade = new T.InstancedBufferAttribute(new Float32Array(cap), 1);
    geo.setAttribute('aFade', fade);
    st.fade = fade;
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = false;
    im.receiveShadow = false;
    im.renderOrder = 3;
    for (let i = 0; i < cap; i++) {
      col.setRGB(1, 1, 1);
      im.setColorAt(i, col);
    }
    scene.add(im); return im;
  }
  /* ---------- P118d (Q-17): the rocket smoke ribbon ----------
   * The old trail spawned one soft puff per rendered frame: at 40-60 m/s that is a bead every 0.7-1.7 m, wider apart
   * than the beads are thick. Now every rocket owns a HEAD: a list of points along its path (appended every 0.22 m,
   * interpolated between frames, so the spacing never depends on the frame rate). Each point ages and is carried by the
   * wind (shear: the wind picks the smoke up slowly, it rises a little, it never leaves the section's 0.45 m front
   * margin: the rule of render/section.js would cut it). The points are drawn as ONE camera-facing strip per head by
   * one draw call: a vertex pair per point (position, tangent, side, age, length), the width grows with age, the
   * fragment shader carves the soft billowing edge and thins the alpha with age. A hot orange tint near the nozzle,
   * white-grey lit by the sky and the sun after that. Presentation only; Math.random is not used (the smoke's wobble is
   * a function of the path length). */
  const RB = { HN: 8, PN: 140, LIFE: 2.8, STEP: 0.22, W0: 0.3, W1: 1.25 };
  const rb = { mesh: null, geo: null, pos: null, tan: null, side: null, age: null, len: null, idx: null, heads: [], time: 0, drawn: 0 };
  const RIB_V = /* glsl */`
    // aS: side (-1 / 1), age (0..1 of the life), length along the path (m), width (m)
attribute vec3 aTan;
    attribute vec4 aS;
    varying vec4 vS;
    varying vec3 vP;
    void main(){
      vS = aS; vP = position;
      vec4 mv = viewMatrix * vec4(position, 1.0);
      vec3 t = (viewMatrix * vec4(aTan, 0.0)).xyz;
      vec2 pr = length(t.xy) > 1e-4 ? normalize(vec2(-t.y, t.x)) : vec2(0.0, 1.0);
      mv.xy += pr * aS.x * aS.w * 0.5;
      gl_Position = projectionMatrix * mv;
    }`;
  const RIB_F = /* glsl */`
    uniform vec3 uSun, uSunC, uSky, uGnd;
    uniform float uLife;
    varying vec4 vS;
    varying vec3 vP;
    float h3(vec3 p){
      p = fract(p * 0.1031);
      p += dot(p, p.zyx + 31.32);
      return fract((p.x + p.y) * p.z);
    }
    float vn(vec3 p){
      vec3 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
                 mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z);
             }
    void main(){
      float u = vS.x, ag = vS.y, L = vS.z, secs = ag * uLife;
      float nz = 0.55 * vn(vec3(L * 1.5, u * 1.4, secs * 0.9)) + 0.3 * vn(vec3(L * 3.9 + 4.0, u * 3.1, secs * 1.4 + 2.0)) + 0.15 * vn(vec3(L * 8.0 + 9.0, u * 6.0, secs * 2.0));
      // a soft, billowing edge: thick and thin patches along the strip
      float prof = 1.0 - smoothstep(0.05 + 0.6 * nz, 1.0, abs(u) + 0.4 * (nz - 0.5));
      float env = smoothstep(0.0, 0.03, ag) * pow(1.0 - ag, 1.5);
      float a = prof * env * (0.4 + 1.0 * nz) * 0.8;
      if (a < 0.004) discard;
      vec3 nrm = normalize(vec3(u * 0.8, 0.5 + 0.5 * (1.0 - abs(u)), 0.6));
      float lam = 0.55 + 0.45 * dot(normalize(vec3(uSun.x, max(uSun.y, 0.0), uSun.z)), nrm);
      // dense lumps are brighter, the thin edges greyer
      vec3 base = mix(vec3(0.92), vec3(0.58), smoothstep(0.1, 0.9, ag)) * (0.72 + 0.4 * nz);
      vec3 c = base * (mix(uGnd, uSky, 0.5 + 0.5 * nrm.y) * 0.62 + uSunC * lam * 0.5 + uSunC * 0.12);
      // the exhaust is still hot at the nozzle
      c += vec3(1.0, 0.5, 0.16) * exp(-secs * 11.0) * 1.1;
      gl_FragColor = vec4(c, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  function ribInit() {
    const vN = RB.HN * RB.PN * 2, g = new T.BufferGeometry();
    rb.pos = new Float32Array(vN * 3);
    rb.tan = new Float32Array(vN * 3);
    rb.aS = new Float32Array(vN * 4);
    rb.idx = new Uint32Array(RB.HN * (RB.PN - 1) * 6);
    g.setAttribute('position', new T.BufferAttribute(rb.pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aTan', new T.BufferAttribute(rb.tan, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('aS', new T.BufferAttribute(rb.aS, 4).setUsage(T.DynamicDrawUsage));
    g.setIndex(new T.BufferAttribute(rb.idx, 1).setUsage(T.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const own = SS.fx && SS.fx.uniforms ? SS.fx.uniforms : null;
    const m = new T.ShaderMaterial({
      vertexShader: RIB_V,
      fragmentShader: RIB_F,
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
      uniforms: {
        uSun: own ? own.uSun : { value: new T.Vector3(0, 1, 0) },
        uSunC: own ? own.uSunC : { value: new T.Color(1, 1, 1) },
        uSky: own ? own.uSky : { value: new T.Color(0.6, 0.65, 0.75) },
        uGnd: own ? own.uGnd : { value: new T.Color(0.3, 0.27, 0.24) },
        uLife: { value: RB.LIFE }
      }
    });
    rb.geo = g;
    rb.mesh = new T.Mesh(g, m);
    rb.mesh.frustumCulled = false;
    rb.mesh.renderOrder = 8;
    rb.mesh.visible = false;
    scene.add(rb.mesh);
    rb.heads = [];
    for (let i = 0; i < RB.HN; i++)
      rb.heads.push({
        n: 0,
        i0: 0,
        last: -9,
        lx: 0,
        ly: 0,
        lz: 0,
        len: 0,
        live: false,
        x: new Float32Array(RB.PN),
        y: new Float32Array(RB.PN),
        z: new Float32Array(RB.PN),
        vx: new Float32Array(RB.PN),
        vy: new Float32Array(RB.PN),
        vz: new Float32Array(RB.PN),
        age: new Float32Array(RB.PN),
        len_: new Float32Array(RB.PN)
      });
  }
  function ribAdd(h, x, y, z, age) {                       // append a point (the newest end); a full head drops its oldest
    let w;
    if (h.n >= RB.PN) {
      h.i0 = (h.i0 + 1) % RB.PN;
      h.n--;
    }
    w = (h.i0 + h.n) % RB.PN; h.n++;
    // a smooth wobble of the new smoke (turbulence of the exhaust), a function of the path length
    const j = Math.sin(h.len * 1.3) * 0.5 + Math.sin(h.len * 3.7 + 1.0) * 0.28 + Math.sin(h.len * 9.1 + 2.0) * 0.12,
      k2 = Math.sin(h.len * 1.9 + 4.0) * 0.4 + Math.sin(h.len * 5.3) * 0.2;
    h.x[w] = x;
    h.y[w] = y;
    h.z[w] = z;
    h.age[w] = age;
    h.len_[w] = h.len;
    h.vx[w] = j * 0.36;
    h.vy[w] = 0.2 + k2 * 0.55;
    h.vz[w] = j * 0.25;
  }
  /* FX.trail(x, y, z): the nozzle of a rocket this frame */
  TV.smoke = function (x, y, z) {
    if (!rb.mesh) return;
    let h = null, bd = 4;
    for (const q of rb.heads)
      if (q.live && rb.time - q.last < 0.25) {
        const d = Math.hypot(x - q.lx, y - q.ly, z - q.lz);
        if (d < bd) {
          bd = d;
          h = q;
        }
      }
    if (!h) {
      for (const q of rb.heads)
        if (!q.live && q.n === 0) {
          h = q;
          break;
        }
      if (!h) {
        let oa = -1;
        for (const q of rb.heads) {
          const a = q.n ? q.age[q.i0] : 99;
          if (a > oa) {
            oa = a;
            h = q;
          }
        }
        h.n = 0;
      }
      h.live = true;
      h.len = 0;
      h.lx = x;
      h.ly = y;
      h.lz = z;
      h.i0 = 0;
      h.n = 0;
      ribAdd(h, x, y, z, 0);
      h.last = rb.time;
      return;
    }
    const dx = x - h.lx,
      dy = y - h.ly,
      dz = z - h.lz,
      dist = Math.hypot(dx, dy, dz),
      n = Math.min(14, Math.floor(dist / RB.STEP)),
      gap = Math.min(0.1, Math.max(0, rb.time - h.last));
    for (let k = 1; k <= n; k++) {
      const f = k / (n + 1);
      h.len += dist / (n + 1);
      ribAdd(h, h.lx + dx * f, h.ly + dy * f, h.lz + dz * f, gap * (1 - f));
    }
    if (n > 0) {
      h.len += dist / (n + 1);
      ribAdd(h, x, y, z, 0);
      h.lx = x;
      h.ly = y;
      h.lz = z;
    }
    else if (dist < RB.STEP * 0.5) { /* too close to the last point: wait for the next call */ }
    h.last = rb.time;
  };
  function ribFrame(S, view, dt) {
    if (!rb.mesh) return;
    rb.time = view.time; dt = Math.min(dt, 0.1);
    const wx = SS.fx.env.wx || 0, wz = SS.fx.env.wz || 0, wk = 1 - Math.exp(-0.5 * dt), N = P.nrm(S), O = S.O;
    let vi = 0, ii = 0;
    for (const h of rb.heads) {
      if (h.live && rb.time - h.last > 0.25) h.live = false;
      while (h.n > 0 && h.age[h.i0] > RB.LIFE) {
        h.i0 = (h.i0 + 1) % RB.PN;
        h.n--;
      }
      if (h.n === 0) {
        h.live = false;
        continue;
      }
      // age, wind, rise; a point never leaves the section's front margin
      for (let q = 0; q < h.n; q++) {
        const k = (h.i0 + q) % RB.PN;
        h.age[k] += dt;
        const sh = 0.5 + 0.9 * Math.min(1, h.age[k] / 1.6);
        h.vx[k] += (wx * 0.85 * sh - h.vx[k]) * wk; h.vz[k] += (wz * 0.85 * sh - h.vz[k]) * wk; h.vy[k] += (0.3 - h.vy[k]) * wk;
        h.x[k] += h.vx[k] * dt; h.y[k] += h.vy[k] * dt; h.z[k] += h.vz[k] * dt;
        const tt = (h.x[k] - O.x) * N.x + (h.z[k] - O.z) * N.z;
        if (tt > 0.4) {
          h.x[k] -= N.x * (tt - 0.4);
          h.z[k] -= N.z * (tt - 0.4);
        }
      }
      if (h.n < 2) continue;
      const base = vi;
      for (let q = 0; q < h.n; q++) {
        const k = (h.i0 + q) % RB.PN, a = (h.i0 + Math.max(0, q - 1)) % RB.PN, b = (h.i0 + Math.min(h.n - 1, q + 1)) % RB.PN;
        let tx = h.x[b] - h.x[a], ty = h.y[b] - h.y[a], tz = h.z[b] - h.z[a];
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl;
        ty /= tl;
        tz /= tl;
        const ag = Math.min(1, h.age[k] / RB.LIFE),
          w = RB.W0 + (RB.W1 - RB.W0) * (1 - Math.exp(-h.age[k] * 0.9)) + 0.35 * (1 - Math.exp(-h.age[k] * 2.0)) * 0;
        for (let sd = -1; sd <= 1; sd += 2) {
          const o = vi * 3, o4 = vi * 4;
          rb.pos[o] = h.x[k];
          rb.pos[o + 1] = h.y[k];
          rb.pos[o + 2] = h.z[k];
          rb.tan[o] = tx;
          rb.tan[o + 1] = ty;
          rb.tan[o + 2] = tz;
          rb.aS[o4] = sd;
          rb.aS[o4 + 1] = ag;
          rb.aS[o4 + 2] = h.len_[k];
          rb.aS[o4 + 3] = w;
          vi++;
        }
      }
      for (let q = 0; q < h.n - 1; q++) {
        const a = base + q * 2;
        rb.idx[ii++] = a;
        rb.idx[ii++] = a + 1;
        rb.idx[ii++] = a + 2;
        rb.idx[ii++] = a + 1;
        rb.idx[ii++] = a + 3;
        rb.idx[ii++] = a + 2;
      }
    }
    rb.drawn = vi;
    rb.geo.setDrawRange(0, ii); rb.mesh.visible = ii > 0;
    if (ii > 0)
      for (const at of ['position', 'aTan', 'aS']) rb.geo.attributes[at].needsUpdate = true;
    if (ii > 0) rb.geo.index.needsUpdate = true;
  }

  TV.init = function (sc, quality) {
    scene = sc; Q = quality; marks = rings = null;
    ribInit();
    if (Q.trail < 0.6) return;
    marks = pool(ovalGeo(0), MCAP, mk); rings = pool(ovalGeo(0.62), RCAP, rg);
    // P118c (Q-18): the wading rings lie on the WATER: like the water (and the life jacket's wake rings) they end at
    // slice zero; with the default 0.5 m margin a strip of each ring hung in front of the cut face, over the rock
    // beside the water, as a flat white rectangle
    rings.material.userData.sectionMargin = -0.03;
  };
  TV.clear = function () {
    track.clear();
    breathT.clear();
    mk.n = mk.i = rg.n = rg.i = 0;
    if (marks) {
      marks.count = 0;
      rings.count = 0;
    }
    for (const h of rb.heads) {
      h.n = 0;
      h.live = false;
    }
    if (rb.mesh) {
      rb.geo.setDrawRange(0, 0);
      rb.mesh.visible = false;
    }
  };
  TV.stats = () => ({
    steps: mk.steps || 0,
    marks: marks ? Math.min(mk.n, MCAP) : 0,
    rings: rings ? Math.min(rg.n, RCAP) : 0,
    ribbons: rb.heads.filter(h => h.n > 1).length,
    ribbonVerts: rb.drawn
  });

  function addMark(x, y, z, yaw, nx, ny, nz, c, life, sl, sw) {
    const i = mk.i;
    mk.i = (mk.i + 1) % MCAP;
    mk.n++;
    nv.set(nx, ny, nz).normalize();
    q1.setFromUnitVectors(up, nv);
    q2.setFromAxisAngle(up, yaw);
    q1.multiply(q2);
    pv.set(x + nv.x * 0.012, y + nv.y * 0.012, z + nv.z * 0.012);
    sv.set(sw, 1, sl);
    m4.compose(pv, q1, sv);
    marks.setMatrixAt(i, m4);
    col.setRGB(c[0], c[1], c[2], T.SRGBColorSpace);
    marks.setColorAt(i, col);
    mk.age[i] = 0;
    mk.life[i] = life;
    mk.fade.array[i] = 0;
  }
  function addRing(x, y, z, r1, life) {
    const i = rg.i;
    rg.i = (rg.i + 1) % RCAP;
    rg.n++;
    rg.x[i] = x;
    rg.y[i] = y;
    rg.z[i] = z;
    rg.s0[i] = r1 * 0.25;
    rg.s1[i] = r1;
    rg.age[i] = 0;
    rg.life[i] = life;
    rg.fade.array[i] = 0;
    col.setRGB(0.9, 0.97, 1, T.SRGBColorSpace); rings.setColorAt(i, col);
  }
  const sm = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  TV.frame = function (S, view, camera, dt) {
    ribFrame(S, view, dt);
    if (!Q || !(Q.trail > 0) || SS.world.under) return;
    dt = Math.min(dt, 0.1);
    const W = SS.world,
      d = P.dir(S),
      tod = view.tod,
      cold = S.biome === 'alpine' && (tod === 'night' || tod === 'dusk' || (S.weather && S.weather.snow > 0.15));
    const ft = view.camT, fx = ft ? ft.x : S.O.x, fz = ft ? ft.z : S.O.z, fn = P.nrm(S);
    for (const w of S.worms) {
      if (w.dead) {
        track.delete(w.id);
        continue;
      }
      if (Math.hypot(w.pos.x - fx, w.pos.z - fz) > 45) continue;
      let tr = track.get(w.id);
      const x = w.pos.x, z = w.pos.z;
      if (!tr) {
        tr = { x, z, acc: 0, mAcc: 0, rAcc: 0, idle: 0 };
        track.set(w.id, tr);
      }
      const dx = x - tr.x, dz = z - tr.z, step = Math.hypot(dx, dz);
      tr.x = x;
      tr.z = z;
      const ground = !w.air && !w.swim && !w.drowning && !w.slide;
      if (step > 1.5 || !ground) {
        tr.acc = 0;
        tr.mAcc = 0;
        if (!w.swim) tr.rAcc = 0;
      }
      else if (step > 1e-4 && step / Math.max(dt, 1e-3) > 0.3) {
        tr.acc += step; tr.mAcc += step; tr.rAcc += step;
        const feetY = w.pos.y - 0.5;
        // P65h: the puff is synced to the crawl: one per contraction hump that pushes off at the tail (render/actors.js
        // pose.wave); by distance when the worm has no view
        const vv = SS.actors && SS.actors.vis ? SS.actors.vis(w) : null, ps = vv && vv.v && vv.v.pose;
        let stepNow = false;
        if (ps && ps.crawl > 0.25) {
          const ph = Math.floor(ps.wave + 0.07);
          if (tr.ph == null) tr.ph = ph;
          if (ph !== tr.ph) {
            tr.ph = ph;
            stepNow = true;
          }
        }
        else if (tr.acc > 0.55) stepNow = true;
        if (stepNow) {
          tr.acc = 0; mk.steps = (mk.steps || 0) + 1;
          const px = x - d.x * w.facing * 0.5, pz = z - d.z * w.facing * 0.5, py = Math.min(feetY, W.topHeight(px, pz)) + 0.02;
          SS.fx.dustAt(px, py, pz, Q.trail > 0.8 ? 2 : 1, 0.2);
        }
        const surf = SS.sim.surface_at(S, x, z);
        if (surf > feetY + 0.05 && surf < feetY + 0.75) {                                   // wading: rings + a few droplets
          if (tr.rAcc > 0.4 && rings) {
            tr.rAcc = 0;
            addRing(x, surf + 0.02, z, 0.65 + 0.3 * Math.random(), 1.1);
            if (Math.random() < 0.6) SS.fx.splash(x, surf, z, 0.1);
          }
        } else if (marks && tr.mAcc > 0.32) {
          tr.mAcc = 0;
          const bx = x - fn.x * 0.3, bz = z - fn.z * 0.3, g = W.topHeight(bx, bz);
          if (Math.abs(g - feetY) < 0.8) {
            const m = W.mat_at(bx, g - 0.12, bz), c = MARKC[m];
            const gr = SS.grass && SS.grass.cover ? SS.grass.cover(bx, bz) : 0;
            if (c && (m !== MT.SOIL || gr < 0.25) && !(S.weather && S.weather.rain > 0.5)) {
              const gx = W.topHeight(bx + 0.2, bz) - W.topHeight(bx - 0.2, bz), gz = W.topHeight(bx, bz + 0.2) - W.topHeight(bx, bz - 0.2);
              // P65h: the groove of a worm sunk into deep snow / sand is wider
              addMark(
                bx,
                g,
                bz,
                Math.atan2(dx, dz),
                -gx * 2.5,
                1,
                -gz * 2.5,
                c,
                m === MT.SNOW ? 16 : 11,
                0.34,
                m === MT.SNOW ? 0.21 : m === MT.SAND ? 0.18 : 0.15
              );
            }
          }
        }
      }
      if (cold && !w.swim && !w.drowning) {                                               // breath fog
        let b = breathT.get(w.id);
        if (b === undefined) b = (w.id * 0.7) % 2.8;
        b += dt;
        if (b > 2.8) {
          b -= 2.8;
          const hx = x + d.x * w.facing * 0.42, hz = z + d.z * w.facing * 0.42;
          for (let k = 0; k < 4; k++)
            SS.fx.spawn(SS.fx.KIND.STEAM, hx + (Math.random() - 0.5) * 0.06, w.pos.y + 0.32 + Math.random() * 0.06,
              hz + (Math.random() - 0.5) * 0.06,
              {
                vx: d.x * w.facing * (0.5 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.2,
                vy: 0.2 + Math.random() * 0.25,
                vz: d.z * w.facing * (0.5 + Math.random() * 0.4),
                life: 1.1 + Math.random() * 0.5,
                s0: 0.05,
                s1: 0.22 + Math.random() * 0.1,
                a0: 0.3,
                c0: [0.92, 0.96, 1],
                drag: 1.6
              });
        }
        breathT.set(w.id, b);
      }
    }
    if (marks) {
      const n = Math.min(mk.n, MCAP);
      for (let i = 0; i < n; i++) {
        mk.age[i] += dt;
        const a = mk.age[i], l = mk.life[i];
        mk.fade.array[i] = a >= l ? 0 : 0.6 * sm(0, 0.15, a) * (1 - sm(l * 0.55, l, a));
      }
      marks.count = n;
      marks.instanceMatrix.needsUpdate = true;
      if (marks.instanceColor) marks.instanceColor.needsUpdate = true;
      mk.fade.needsUpdate = true;
      const r = Math.min(rg.n, RCAP);
      for (let i = 0; i < r; i++) {
        rg.age[i] += dt;
        const a = rg.age[i] / rg.life[i];
        if (a >= 1) {
          rg.fade.array[i] = 0;
          continue;
        }
        const s = rg.s0[i] + (rg.s1[i] - rg.s0[i]) * Math.sqrt(a);
        pv.set(rg.x[i], rg.y[i], rg.z[i]);
        q1.identity();
        sv.set(s, 1, s);
        m4.compose(pv, q1, sv);
        rings.setMatrixAt(i, m4);
        rg.fade.array[i] = 0.85 * sm(0, 0.08, a) * (1 - a);
      }
      rings.count = r;
      rings.instanceMatrix.needsUpdate = true;
      if (rings.instanceColor) rings.instanceColor.needsUpdate = true;
      rg.fade.needsUpdate = true;
    }
  };
})(window.SS = window.SS || {});
