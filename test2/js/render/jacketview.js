/* render/jacketview.js — P89: the life jacket (presentation only; Math.random is fine).
 *   - the VEST: an orange inflatable collar (a puffy torus with a reflective stripe) around the worm's neck
 *     (spine index VEST_I), parented to the body mesh's group so it follows every pose. It inflates when the worm's
 *     swim becomes a jacket swim (w.swim.jk: 0.7 s, a little overshoot, a hiss from the audio) and deflates 0.5 s after
 *     the climb-out;
 *   - the WAKE: while a jacket swim runs, soft rings spread on the water surface under / behind the worm every 0.5 s (a
 *     calm stroke: slow rings, never the splashing of a struggle); a river's drift leans them downstream;
 *   - the landing: the 'jacket' event puffs a short burst of spray around the vest (SS.fx.splash is already fired by
 * the water entry). API (view.js W4V list): init(scene, tx), clear(), onEvent(S, e), frame(S, view, camera, dt);
 * vest(S, w, v, sp, dt) is called by actors.js for every worm. Porting: a mesh per worm + a ring pool; nothing shared
 * with the simulation. */
(function (SS) {
  'use strict';
  const T = window.THREE, JV = SS.jacketView = {};
  const VEST_I = 84;                                     // spine index of the collar (the neck, under the head)
  let scene = null, rings = null, ringGeo = null, ringMat = null, clock = 0, pool = [];
  const NRING = 24, spawnT = {};                         // spawnT[wormId] = next ring time
  let matOrange = null, matBand = null, geoMain = null, geoBand = null;

  JV.init = function (sc) {
    scene = sc;
    ringGeo = new T.RingGeometry(0.82, 1, 40); ringGeo.rotateX(-Math.PI / 2);
    ringMat = new T.MeshBasicMaterial({ color: 0xe6f6ff, transparent: true, opacity: 0, depthWrite: false, side: T.DoubleSide });
    // P118c (Q-18): like the water itself, a ring on the sea ends at slice zero (3 cm behind it, so the 2 mm between
    // the cut face and the plane keep no hairline over the rock). With the default 0.5 m margin a strip of every ring
    // stayed in front of the cut face and, over the rock beside the water, hung there as a flat white rectangle (pairs
    // of them at the waterline of every jacket swim)
    ringMat.userData.sectionMargin = -0.03;
    rings = new T.Group(); rings.name = 'jacketRings'; scene.add(rings);
    pool = [];
    for (let i = 0; i < NRING; i++) {
      const m = new T.Mesh(ringGeo, ringMat.clone());
      m.visible = false;
      m.renderOrder = 6;
      m.frustumCulled = false;
      rings.add(m);
      pool.push({ m, t: 9, life: 1.6, x: 0, y: 0, z: 0, r0: 0.3, r1: 1.3, sx: 0, sz: 0 });
    }
  };
  JV.clear = function () {
    for (const q of pool) {
      q.t = 9;
      q.m.visible = false;
    }
    for (const k in spawnT) delete spawnT[k];
  };
  function mats() {
    if (matOrange) return;
    matOrange = new T.MeshStandardMaterial({
      color: 0xff6a12, roughness: 0.42, metalness: 0.0, emissive: 0x3a1200, emissiveIntensity: 0.35
    });
    matBand = new T.MeshStandardMaterial({ color: 0xf4f0c0, roughness: 0.3, metalness: 0.2, emissive: 0x555544, emissiveIntensity: 0.4 });
    geoMain = new T.TorusGeometry(1, 0.34, 12, 32);      // unit major radius: the collar is scaled to the body
    geoBand = new T.TorusGeometry(1.31, 0.075, 8, 32);   // the reflective stripe round the outer equator of the tube
  }
  function make() {
    mats();
    const g = new T.Group(), ring = new T.Group();
    const main = new T.Mesh(geoMain, matOrange);
    main.castShadow = true;
    ring.add(main);
    ring.add(new T.Mesh(geoBand, matBand));
    ring.rotation.y = Math.PI / 2;                       // the torus axis (z) along the spine tangent (x)
    g.add(ring); g.visible = false;
    return g;
  }
  /* called by actors.js after the soft body's spine sp was built (body-local coordinates) */
  JV.vest = function (S, w, v, sp, dt) {
    let jv = v.jk;
    const on = !!(w.swim && w.swim.jk) && !w.dead && !w.drowning;
    if (!jv) {
      if (!on) return;
      jv = v.jk = { g: make(), k: 0 };
      (v.mesh.parent || v.root).add(jv.g);
    }
    jv.k += ((on ? 1 : 0) - jv.k) * Math.min(1, dt * (on ? 4.5 : 6));
    if (jv.k < 0.015 && !on) {
      jv.g.visible = false;
      return;
    }
    const i = Math.min(VEST_I, sp.x.length - 1), k = Math.min(1, jv.k), puff = k * (1 + 0.16 * Math.sin(k * Math.PI));
    const R = ((sp.r[i] || 0.18) + 0.012) / 0.66 * puff;                       // major radius: the hole (0.66 R) just clears the body
    jv.g.visible = true;
    jv.g.position.set(sp.x[i], sp.y[i], 0); jv.g.rotation.z = sp.a[i];
    jv.g.scale.setScalar(Math.max(0.001, R));
  };
  function spawn(x, y, z, sx, sz, big) {
    let q = null;
    for (const p of pool)
      if (p.t >= p.life) {
        q = p;
        break;
      }
    if (!q) return;
    q.t = 0;
    q.life = big ? 1.9 : 1.6;
    q.x = x;
    q.y = y;
    q.z = z;
    q.r0 = big ? 0.5 : 0.32;
    q.r1 = big ? 2.0 : 1.25;
    q.sx = sx;
    q.sz = sz;
    q.m.visible = true;
  }
  JV.onEvent = function (S, e) {
    if (e.type === 'jacket' && e.worm) {
      spawn(e.x, e.y + 0.02, e.z, 0, 0, true);
      if (SS.fx && SS.fx.splash) SS.fx.splash(e.x, e.y, e.z, 0.7);
    }
  };
  JV.frame = function (S, view, camera, dt) {
    if (!rings) return;
    clock += dt;
    for (const w of S.worms) {
      const sw = w.swim;
      if (!sw || !sw.jk || w.dead) {
        delete spawnT[w.id];
        continue;
      }
      const surf = SS.sim.surface_at(S, w.pos.x, w.pos.z);
      if (!(surf > -90)) continue;
      if (!(clock >= (spawnT[w.id] || 0))) continue;
      spawnT[w.id] = clock + 0.5;
      spawn(w.pos.x, surf + 0.02, w.pos.z, (sw.cx || 0) * 0.3, (sw.cz || 0) * 0.3, false);
    }
    for (const q of pool) {
      if (q.t >= q.life) {
        if (q.m.visible) q.m.visible = false;
        continue;
      }
      q.t += dt;
      const u = Math.min(1, q.t / q.life), e = 1 - (1 - u) * (1 - u);
      const r = q.r0 + (q.r1 - q.r0) * e;
      q.m.position.set(q.x + q.sx * q.t, q.y, q.z + q.sz * q.t); q.m.scale.set(r, 1, r);
      q.m.material.opacity = 0.42 * (1 - u) * Math.min(1, u * 8);
    }
  };
})(window.SS = window.SS || {});
