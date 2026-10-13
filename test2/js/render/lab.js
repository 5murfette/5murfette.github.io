/* render/lab.js — P42 Lab: the meteor shower on screen (Three.js, procedural geometry only, no textures).
 * State-driven: every frame the markers follow S.lab.met[] (id, t0, t, x, y, z): a pulsing red warning ring on the
 * ground that tightens as the impact nears, and a glowing streak (an elongated cone, additive) falling from 55 m up
 * along a slanted line. P79 (batch 4): the lightning tell (S.lab.b4.zap[]: a pulsing blue-white ring and a flickering
 * corona with jittering spark lines at the chosen point), the quake shake (camera, via SS.fx.addShake) and the small
 * event cues (dust, sounds of existing ids only). API: init(scene, textures), clear(), frame(S, view, camera, dt),
 * onEvent(S, e). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const LV = SS.labView = {};
  let root = null;
  const items = new Map();
  const FALL_H = 55, SLANT = 0.35;
  LV.init = function (sc) {
    root = new T.Group();
    sc.add(root);
  };
  LV.clear = function () {
    for (const it of items.values()) {
      root.remove(it.g);
      it.g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    items.clear();
    for (const it of zaps.values()) {
      root.remove(it.g);
      it.g.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    zaps.clear();
  };
  function make() {
    const g = new T.Group();
    const ring = new T.Mesh(
      new T.RingGeometry(0.85, 1, 40),
      new T.MeshBasicMaterial({
        color: 0xff3a1a,
        transparent: true,
        opacity: 0.8,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide
      })
    );
    ring.rotation.x = -Math.PI / 2; g.add(ring);
    const disc = new T.Mesh(
      new T.CircleGeometry(1, 32),
      new T.MeshBasicMaterial({
        color: 0xff2200,
        transparent: true,
        opacity: 0.18,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide
      })
    );
    disc.rotation.x = -Math.PI / 2; g.add(disc);
    const rock = new T.Mesh(new T.IcosahedronGeometry(0.5, 1), new T.MeshBasicMaterial({ color: 0xffa040 }));
    const tail = new T.Mesh(
      new T.ConeGeometry(0.45, 7, 10, 1, true),
      new T.MeshBasicMaterial({
        color: 0xff7a20,
        transparent: true,
        opacity: 0.55,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide
      })
    );
    tail.position.y = 3.6; rock.add(tail);
    g.add(rock);
    return { g, ring, disc, rock };
  }
  /* ---------- P79: the lightning tell ---------- */
  const zaps = new Map();
  const NSP = 5, NPT = 7;
  function makeZap() {
    const g = new T.Group();
    const ring = new T.Mesh(
      new T.RingGeometry(0.8, 1, 40),
      new T.MeshBasicMaterial({
        color: 0xaad8ff,
        transparent: true,
        opacity: 0.8,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide
      })
    );
    ring.rotation.x = -Math.PI / 2; g.add(ring);
    const cor = new T.Mesh(
      new T.CylinderGeometry(0.1, 0.5, 3.2, 10, 1, true),
      new T.MeshBasicMaterial({
        color: 0xcfe8ff,
        transparent: true,
        opacity: 0.3,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide
      })
    );
    cor.position.y = 1.6; g.add(cor);
    const lines = [];
    for (let i = 0; i < NSP; i++) {
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(new Float32Array(NPT * 3), 3));
      const ln = new T.Line(
        geo,
        new T.LineBasicMaterial({ color: 0xe8f4ff, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false })
      );
      ln.frustumCulled = false; g.add(ln); lines.push(ln);
    }
    return { g, ring, cor, lines };
  }
  const jit = (a, b) => {
    const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  function zapFrame(S, view) {
    const L = S.lab && S.lab.b4, list = L ? L.zap : [], K = SS.CFG.LAB.L4, live = {};
    for (const z of list) {
      live[z.id] = 1;
      let it = zaps.get(z.id);
      if (!it) {
        it = makeZap();
        zaps.set(z.id, it);
        root.add(it.g);
      }
      const k = Math.min(1, Math.max(0, (S.time - z.t0) / K.ZAP_WARN)), tick = Math.floor(view.time * (12 + 30 * k));
      it.g.position.set(z.x, z.y, z.z);
      const rr = 2.4 - 1.5 * k;
      it.ring.scale.set(rr, rr, rr); it.ring.material.opacity = 0.25 + 0.6 * k * (0.6 + 0.4 * jit(tick, 1));
      it.cor.material.opacity = 0.1 + 0.4 * k * jit(tick, 2);
      for (let i = 0; i < NSP; i++) {
        const pa = it.lines[i].geometry.attributes.position,
          a = i / NSP * Math.PI * 2 + jit(tick, 3 + i) * 0.8,
          r = 0.2 + 1.3 * (1 - k * 0.5);
        for (let p = 0; p < NPT; p++) {
          const u = p / (NPT - 1), ang = a + (jit(tick + p, 9 + i) - 0.5) * 0.9;
          pa.setXYZ(
            p,
            Math.cos(ang) * r * (1 - u) + (jit(tick, p + i) - 0.5) * 0.25,
            u * 2.6 * (0.6 + 0.4 * jit(tick, 20 + i)),
            Math.sin(ang) * r * (1 - u) + (jit(tick, p + 40 + i) - 0.5) * 0.25
          );
        }
        pa.needsUpdate = true; it.lines[i].material.opacity = 0.35 + 0.6 * k * jit(tick, 30 + i);
      }
    }
    for (const [id, it] of zaps)
      if (!live[id]) {
        root.remove(it.g);
        it.g.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
        zaps.delete(id);
      }
    // the quake: a low tremor during the warning, a hard shake while it lasts
    if (L && SS.fx && SS.fx.addShake) {
      const warn = L.qT >= 0 && S.time < L.qT, shaking = L.qT < 0 && S.time >= 0 && S.time < L.qEnd;
      const goal = shaking ? 0.5 * Math.min(1, (L.qEnd - S.time) / 0.8 + 0.2) : warn ? 0.08 + 0.1 * (1 - (L.qT - S.time) / K.WARN) : 0;
      if (goal > 0 && SS.fx.shake() < goal) SS.fx.addShake(goal - SS.fx.shake());
    }
  }
  LV.frame = function (S, view) {
    if (!root) return;
    zapFrame(S, view);
    const L = S.lab, list = L && L.met ? L.met : [], C = SS.CFG.LAB;
    const live = {};
    for (const m of list) {
      live[m.id] = 1;
      let it = items.get(m.id);
      if (!it) {
        it = make();
        items.set(m.id, it);
        root.add(it.g);
      }
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
    for (const [id, it] of items)
      if (!live[id]) {
        root.remove(it.g);
        it.g.traverse(o => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) o.material.dispose();
        });
        items.delete(id);
      }
  };
  const snd = (e, id, vol, rate) => {
    const A = SS.audio;
    if (A && A.play) A.play(id, vol, rate, undefined, { x: e.x, y: e.y, z: e.z }, { cls: 'norm' });
  };
  LV.onEvent = function (S, e) {
    const fx = SS.fx;
    if (e.type === 'labmeteorhit' && fx && fx.dust) fx.dust(e.x, e.y + 0.1, e.z, 4, 1.4, 0x7a6a5a);
    else if (e.type === 'labstatic') {
      snd(e, 'electric_zap', 0.45, 1.9);
      if (fx && fx.spark) {
        fx.spark(e.x, e.y + 0.3, e.z);
        fx.spark(e.x, e.y + 0.6, e.z);
      }
    }
    else if (e.type === 'labquake') {
      snd(e, 'rock_collapse', 0.7, 0.55);
      if (fx && fx.addShake) fx.addShake(0.1);
    }
    else if (e.type === 'labquakehit') {
      snd(e, 'rock_collapse', 1, 0.7);
      if (fx && fx.dust)
        for (let i = -3; i <= 3; i++) fx.dust(e.x + e.dx * e.len * i / 7, e.y + 0.1, e.z + e.dz * e.len * i / 7, 3, 1.3, 0x8a7a66);
    } else if (e.type === 'labslide') {
      if (fx && fx.dust) fx.dust(e.x, e.y + 0.05, e.z, 3, 0.7, 0x6a4a2c);
      snd(e, 'body_hit', 0.25, 0.7);
    }
    else if (e.type === 'labrecoil') {
      if (fx && fx.dust) fx.dust(S.worms[e.wormId].pos.x, S.worms[e.wormId].pos.y - 0.4, S.worms[e.wormId].pos.z, 3, 0.8, 0x9a8a70);
      if (fx && fx.addShake) fx.addShake(0.12 + 0.1 * Math.min(1, e.dv));
      {
        const w = S.worms[e.wormId];
        snd({ x: w.pos.x, y: w.pos.y, z: w.pos.z }, 'body_hit', 0.4, 0.6);
      }
    }
    else if (e.type === 'labscav') {
      if (fx && fx.dust) fx.dust(e.x, e.y + 0.3, e.z, 4, 0.8, 0xe8c870);
      snd(e, 'crate_pickup', 0.5, 0.75);
    }
  };
})(window.SS = window.SS || {});
