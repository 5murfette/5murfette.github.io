/* render/trails.js — P62 small worm / ground interaction details (Three.js specific, presentation only; reads the sim state, never writes it).
 *   - footstep dust: a small puff every ~0.55 m of crawling, coloured by the ground material (render/fx.js dustAt: soil, sand, snow, ash ...);
 *   - drag marks (the worm's belly trail) pressed into sand / snow / ash / bare soil: a pooled instanced ring buffer of flat ovals aligned to the
 *     terrain normal behind the slice, they fade out after ~10 s (a per-instance fade attribute, standard material, normal blending);
 *   - splash rings when wading in shallow water (expanding rings on the water surface + a few droplets);
 *   - breath fog at night / dusk / in snow in the alpine biome (soft cold puffs from the worm's mouth).
 * Quality: Q.trail (0.3 on low: the dust only; marks and rings from medium). API: init(scene, quality), frame(S, view, camera, dt), clear(), stats(). */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math, P = SS.plane;
  const TV = SS.trailView = {};
  let scene = null, Q = null, marks = null, rings = null, track = new Map(), breathT = new Map();
  const MCAP = 90, RCAP = 24;
  const mk = { n: 0, i: 0, age: new Float32Array(MCAP), life: new Float32Array(MCAP), fade: null };
  const rg = { n: 0, i: 0, age: new Float32Array(RCAP), life: new Float32Array(RCAP), fade: null, x: new Float32Array(RCAP), y: new Float32Array(RCAP), z: new Float32Array(RCAP), s0: new Float32Array(RCAP), s1: new Float32Array(RCAP) };
  const dummy = new T.Object3D(), q1 = new T.Quaternion(), q2 = new T.Quaternion(), up = new T.Vector3(0, 1, 0), nv = new T.Vector3(), pv = new T.Vector3(), sv = new T.Vector3(), m4 = new T.Matrix4(), col = new T.Color();
  const MT = SS.CFG.MAT;
  const MARKC = {};
  MARKC[MT.SAND] = [0.5, 0.39, 0.24]; MARKC[MT.SNOW] = [0.5, 0.6, 0.78]; MARKC[MT.ASH] = [0.12, 0.11, 0.11]; MARKC[MT.SOIL] = [0.17, 0.11, 0.07];

  function decalMat() {
    const m = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, opacity: 1 });
    m.onBeforeCompile = sh => {
      sh.vertexShader = 'attribute float aFade; varying float vFade;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vFade = aFade;');
      sh.fragmentShader = 'varying float vFade;\n' + sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n diffuseColor.a *= vFade;');
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
    for (let i = 0; i < N; i++) { const a = i * 2, b = ((i + 1) % N) * 2; if (inner > 0) idx.push(a, a + 1, b, b, a + 1, b + 1); }
    if (inner <= 0) { pos.push(0, 0, 0); for (let i = 0; i < N; i++) idx.push(i * 2, ((i + 1) % N) * 2, N * 2); }
    const g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    const nrm = []; for (let i = 0; i < pos.length / 3; i++) nrm.push(0, 1, 0); g.setAttribute('normal', new T.Float32BufferAttribute(nrm, 3));
    return g;
  }
  function pool(geo, cap, st) {
    const im = new T.InstancedMesh(geo, decalMat(), cap), fade = new T.InstancedBufferAttribute(new Float32Array(cap), 1);
    geo.setAttribute('aFade', fade); st.fade = fade; im.count = 0; im.frustumCulled = false; im.castShadow = false; im.receiveShadow = false; im.renderOrder = 3;
    for (let i = 0; i < cap; i++) { col.setRGB(1, 1, 1); im.setColorAt(i, col); }
    scene.add(im); return im;
  }
  TV.init = function (sc, quality) {
    scene = sc; Q = quality; marks = rings = null;
    if (Q.trail < 0.6) return;
    marks = pool(ovalGeo(0), MCAP, mk); rings = pool(ovalGeo(0.62), RCAP, rg);
  };
  TV.clear = function () { track.clear(); breathT.clear(); mk.n = mk.i = rg.n = rg.i = 0; if (marks) { marks.count = 0; rings.count = 0; } };
  TV.stats = () => ({ steps: mk.steps || 0, marks: marks ? Math.min(mk.n, MCAP) : 0, rings: rings ? Math.min(rg.n, RCAP) : 0 });

  function addMark(x, y, z, yaw, nx, ny, nz, c, life, sl, sw) {
    const i = mk.i; mk.i = (mk.i + 1) % MCAP; mk.n++;
    nv.set(nx, ny, nz).normalize(); q1.setFromUnitVectors(up, nv); q2.setFromAxisAngle(up, yaw); q1.multiply(q2);
    pv.set(x + nv.x * 0.012, y + nv.y * 0.012, z + nv.z * 0.012); sv.set(sw, 1, sl); m4.compose(pv, q1, sv); marks.setMatrixAt(i, m4);
    col.setRGB(c[0], c[1], c[2], T.SRGBColorSpace); marks.setColorAt(i, col); mk.age[i] = 0; mk.life[i] = life; mk.fade.array[i] = 0;
  }
  function addRing(x, y, z, r1, life) {
    const i = rg.i; rg.i = (rg.i + 1) % RCAP; rg.n++;
    rg.x[i] = x; rg.y[i] = y; rg.z[i] = z; rg.s0[i] = r1 * 0.25; rg.s1[i] = r1; rg.age[i] = 0; rg.life[i] = life; rg.fade.array[i] = 0;
    col.setRGB(0.9, 0.97, 1, T.SRGBColorSpace); rings.setColorAt(i, col);
  }
  const sm = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  TV.frame = function (S, view, camera, dt) {
    if (!Q || !(Q.trail > 0) || SS.world.under) return;
    dt = Math.min(dt, 0.1);
    const W = SS.world, d = P.dir(S), tod = view.tod, cold = S.biome === 'alpine' && (tod === 'night' || tod === 'dusk' || (S.weather && S.weather.snow > 0.15));
    const ft = view.camT, fx = ft ? ft.x : S.O.x, fz = ft ? ft.z : S.O.z, fn = P.nrm(S);
    for (const w of S.worms) {
      if (w.dead) { track.delete(w.id); continue; }
      if (Math.hypot(w.pos.x - fx, w.pos.z - fz) > 45) continue;
      let tr = track.get(w.id);
      const x = w.pos.x, z = w.pos.z;
      if (!tr) { tr = { x, z, acc: 0, mAcc: 0, rAcc: 0, idle: 0 }; track.set(w.id, tr); }
      const dx = x - tr.x, dz = z - tr.z, step = Math.hypot(dx, dz); tr.x = x; tr.z = z;
      const ground = !w.air && !w.swim && !w.drowning && !w.slide;
      if (step > 1.5 || !ground) { tr.acc = 0; tr.mAcc = 0; if (!w.swim) tr.rAcc = 0; }
      else if (step > 1e-4 && step / Math.max(dt, 1e-3) > 0.3) {
        tr.acc += step; tr.mAcc += step; tr.rAcc += step;
        const feetY = w.pos.y - 0.5;
        // P65h: the puff is synced to the crawl: one per contraction hump that pushes off at the tail (render/actors.js pose.wave); by distance when the worm has no view
        const vv = SS.actors && SS.actors.vis ? SS.actors.vis(w) : null, ps = vv && vv.v && vv.v.pose;
        let stepNow = false;
        if (ps && ps.crawl > 0.25) { const ph = Math.floor(ps.wave + 0.07); if (tr.ph == null) tr.ph = ph; if (ph !== tr.ph) { tr.ph = ph; stepNow = true; } }
        else if (tr.acc > 0.55) stepNow = true;
        if (stepNow) {
          tr.acc = 0; mk.steps = (mk.steps || 0) + 1;
          const px = x - d.x * w.facing * 0.5, pz = z - d.z * w.facing * 0.5, py = Math.min(feetY, W.topHeight(px, pz)) + 0.02;
          SS.fx.dustAt(px, py, pz, Q.trail > 0.8 ? 2 : 1, 0.2);
        }
        const surf = SS.sim.surface_at(S, x, z);
        if (surf > feetY + 0.05 && surf < feetY + 0.75) {                                   // wading: rings + a few droplets
          if (tr.rAcc > 0.4 && rings) { tr.rAcc = 0; addRing(x, surf + 0.02, z, 0.65 + 0.3 * Math.random(), 1.1); if (Math.random() < 0.6) SS.fx.splash(x, surf, z, 0.1); }
        } else if (marks && tr.mAcc > 0.32) {
          tr.mAcc = 0;
          const bx = x - fn.x * 0.3, bz = z - fn.z * 0.3, g = W.topHeight(bx, bz);
          if (Math.abs(g - feetY) < 0.8) {
            const m = W.mat_at(bx, g - 0.12, bz), c = MARKC[m];
            const gr = SS.grass && SS.grass.cover ? SS.grass.cover(bx, bz) : 0;
            if (c && (m !== MT.SOIL || gr < 0.25) && !(S.weather && S.weather.rain > 0.5)) {
              const gx = W.topHeight(bx + 0.2, bz) - W.topHeight(bx - 0.2, bz), gz = W.topHeight(bx, bz + 0.2) - W.topHeight(bx, bz - 0.2);
              addMark(bx, g, bz, Math.atan2(dx, dz), -gx * 2.5, 1, -gz * 2.5, c, m === MT.SNOW ? 16 : 11, 0.34, m === MT.SNOW ? 0.21 : m === MT.SAND ? 0.18 : 0.15);       // P65h: the groove of a worm sunk into deep snow / sand is wider
            }
          }
        }
      }
      if (cold && !w.swim && !w.drowning) {                                               // breath fog
        let b = breathT.get(w.id); if (b === undefined) b = (w.id * 0.7) % 2.8;
        b += dt; if (b > 2.8) {
          b -= 2.8;
          const hx = x + d.x * w.facing * 0.42, hz = z + d.z * w.facing * 0.42;
          for (let k = 0; k < 4; k++) SS.fx.spawn(SS.fx.KIND.STEAM, hx + (Math.random() - 0.5) * 0.06, w.pos.y + 0.32 + Math.random() * 0.06, hz + (Math.random() - 0.5) * 0.06,
            { vx: d.x * w.facing * (0.5 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.2, vy: 0.2 + Math.random() * 0.25, vz: d.z * w.facing * (0.5 + Math.random() * 0.4), life: 1.1 + Math.random() * 0.5, s0: 0.05, s1: 0.22 + Math.random() * 0.1, a0: 0.3, c0: [0.92, 0.96, 1], drag: 1.6 });
        }
        breathT.set(w.id, b);
      }
    }
    if (marks) {
      const n = Math.min(mk.n, MCAP);
      for (let i = 0; i < n; i++) { mk.age[i] += dt; const a = mk.age[i], l = mk.life[i]; mk.fade.array[i] = a >= l ? 0 : 0.6 * sm(0, 0.15, a) * (1 - sm(l * 0.55, l, a)); }
      marks.count = n; marks.instanceMatrix.needsUpdate = true; if (marks.instanceColor) marks.instanceColor.needsUpdate = true; mk.fade.needsUpdate = true;
      const r = Math.min(rg.n, RCAP);
      for (let i = 0; i < r; i++) {
        rg.age[i] += dt; const a = rg.age[i] / rg.life[i];
        if (a >= 1) { rg.fade.array[i] = 0; continue; }
        const s = rg.s0[i] + (rg.s1[i] - rg.s0[i]) * Math.sqrt(a);
        pv.set(rg.x[i], rg.y[i], rg.z[i]); q1.identity(); sv.set(s, 1, s); m4.compose(pv, q1, sv); rings.setMatrixAt(i, m4);
        rg.fade.array[i] = 0.85 * sm(0, 0.08, a) * (1 - a);
      }
      rings.count = r; rings.instanceMatrix.needsUpdate = true; if (rings.instanceColor) rings.instanceColor.needsUpdate = true; rg.fade.needsUpdate = true;
    }
  };
})(window.SS = window.SS || {});
