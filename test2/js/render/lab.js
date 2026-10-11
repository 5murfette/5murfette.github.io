/* render/lab.js — P42 Lab: the meteor shower on screen (Three.js, procedural geometry only, no textures).
 * State-driven: every frame the markers follow S.lab.met[] (id, t0, t, x, y, z): a pulsing red warning ring on the ground that
 * tightens as the impact nears, and a glowing streak (an elongated cone, additive) falling from 55 m up along a slanted line.
 * API: init(scene, textures), clear(), frame(S, view, camera, dt), onEvent(S, e). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const LV = SS.labView = {};
  let root = null;
  const items = new Map();
  const FALL_H = 55, SLANT = 0.35;
  LV.init = function (sc) { root = new T.Group(); sc.add(root); };
  LV.clear = function () { for (const it of items.values()) { root.remove(it.g); it.g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); } items.clear(); };
  function make() {
    const g = new T.Group();
    const ring = new T.Mesh(new T.RingGeometry(0.85, 1, 40), new T.MeshBasicMaterial({ color: 0xff3a1a, transparent: true, opacity: 0.8, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; g.add(ring);
    const disc = new T.Mesh(new T.CircleGeometry(1, 32), new T.MeshBasicMaterial({ color: 0xff2200, transparent: true, opacity: 0.18, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
    disc.rotation.x = -Math.PI / 2; g.add(disc);
    const rock = new T.Mesh(new T.IcosahedronGeometry(0.5, 1), new T.MeshBasicMaterial({ color: 0xffa040 }));
    const tail = new T.Mesh(new T.ConeGeometry(0.45, 7, 10, 1, true), new T.MeshBasicMaterial({ color: 0xff7a20, transparent: true, opacity: 0.55, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
    tail.position.y = 3.6; rock.add(tail);
    g.add(rock);
    return { g, ring, disc, rock };
  }
  LV.frame = function (S, view) {
    if (!root) return;
    const L = S.lab, list = L && L.met ? L.met : [], C = SS.CFG.LAB;
    const live = {};
    for (const m of list) {
      live[m.id] = 1;
      let it = items.get(m.id);
      if (!it) { it = make(); items.set(m.id, it); root.add(it.g); }
      const k = Math.min(1, Math.max(0, (S.time - m.t0) / C.MET_WARN)), r = 3 * Math.cbrt(C.MET_W);
      it.g.position.set(m.x, m.y + 0.08, m.z);
      const pulse = 0.5 + 0.5 * Math.sin(view.time * (6 + 14 * k));
      const rr = r * (1.6 - 0.6 * k);
      it.ring.scale.set(rr, rr, rr); it.ring.material.opacity = 0.45 + 0.5 * pulse;
      it.disc.scale.set(r, r, r); it.disc.material.opacity = 0.08 + 0.25 * k;
      const h = FALL_H * (1 - k) * (1 - k);
      it.rock.position.set(h * SLANT, h, 0);
      it.rock.rotation.z = Math.atan2(SLANT, 1) * -1;
      it.rock.visible = k > 0.02;
    }
    for (const [id, it] of items) if (!live[id]) { root.remove(it.g); it.g.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); items.delete(id); }
  };
  LV.onEvent = function (S, e) {
    if (e.type === 'labmeteorhit' && SS.fx && SS.fx.dust) SS.fx.dust(e.x, e.y + 0.1, e.z, 4, 1.4, 0x7a6a5a);
  };
})(window.SS = window.SS || {});
