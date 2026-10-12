/* render/heroes.js (P101) — biome hero set pieces: a ruined stone well (temperate), a half-buried wagon wheel (desert, canyon), a lava-cracked
 * basalt monolith (volcanic). Baked Blender models with PBR maps (assets/models.js hero_*), RENDER ONLY: no sim body, so the layouts and hashes
 * of every match are unchanged, but they also do not block a worm (like the pebbles / cacti of the decor kit they are scenery).
 * Sites are chosen deterministically from the match seed and the lattice (hash only, no random, no clock): flat ground of the right material, above
 * the sea, away from the worms and from each other. A hero stands where it was placed until the ground under it changes (a blast, a collapse):
 * then it breaks with its baked chunks (SS.models.shatter), so nothing floats. Contact shadow via groundView.blob. The monolith's baked glow
 * breathes slowly (a low-passed sum of two slow sines, never a jump). Nothing is placed on End of the World, in caves or under snow weather.
 * API (W4V module): init(scene), clear(), onEvent(), frame(S, view, camera, dt), info().
 * Porting: a static mesh + a few lines of site picking (the same lattice queries) in any engine. */
(function (SS) {
  'use strict';
  const T = window.THREE, HV = SS.heroView = {};
  const M = SS.math;
  const MT = { ROCK: 2, SOIL: 3, SAND: 4, SANDSTONE: 5, BASALT: 8, LAVA: 9, CRUST: 10, ASH: 11 };
  /* per biome: [model id, count, allowed ground materials, sink (m), lean (rad), pivot lift (m)] */
  const SETS = {
    temperate: [['hero_well', 2, [MT.SOIL, MT.ROCK], 0.05, 0.0, 0.0]],
    desert: [['hero_wheel', 2, [MT.SAND, MT.SANDSTONE], 0.0, 0.32, 0.36]],
    canyon: [['hero_wheel', 1, [MT.SAND, MT.SANDSTONE, MT.SOIL], 0.0, 0.32, 0.36]],
    volcanic: [['hero_monolith', 2, [MT.BASALT, MT.ASH, MT.CRUST], 0.12, 0.0, 0.0]]
  };
  const FOOT = { hero_well: 1.0, hero_wheel: 0.8, hero_monolith: 0.85 };
  let scene = null, items = [], key = '', lastT = -1, chk = 0, glowT = 0, built = 0;

  HV.init = function (sc) { scene = sc; };
  HV.clear = function () { for (const it of items) if (it.g.parent) it.g.parent.remove(it.g); items = []; key = ''; };
  HV.onEvent = function () {};
  /* the decor (pebbles, tufts, grass, twigs ...) keeps out of a hero's footprint: clutter.js / grass.js ask here per instance */
  HV.blocked = function (x, z) {
    for (let i = 0; i < items.length; i++) { const it = items[i], dx = x - it.x, dz = z - it.z; if (dx * dx + dz * dz < it.pad * it.pad) return true; }
    return false;
  };
  HV._items = () => items;
  HV.info = () => ({ n: items.length, kinds: items.map(i => i.id), built: built });

  function flatEnough(W, x, z, r, y0) {
    let dev = 0;
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, y = W.top_at(x + Math.cos(a) * r, z + Math.sin(a) * r);
      if (y < -1e8) return -1;
      dev = Math.max(dev, Math.abs(y - y0));
    }
    return dev;
  }

  function pick(S, W, biome) {
    const set = SETS[biome]; if (!set) return [];
    const out = [], seed = (S.settings && S.settings.seed | 0) || 0, sea = W.SEA, dry = !!W.dry;
    const cx = W.SX * 0.5, cz = W.SZ * 0.5, pr = dry && SS.CFG.DRY ? SS.CFG.DRY.PLAY_R - 3 : Math.min(W.SX, W.SZ) * 0.5 - 7;
    for (let s = 0; s < set.length; s++) {
      const [id, cnt, mats, sink, lean, lift] = set[s];
      let tries = 0;
      for (let n = 0; n < cnt && tries < 600; tries++) {
        const h1 = M.hash3(seed + 31, tries, s * 7 + n), h2 = M.hash3(seed + 77, s * 7 + n, tries), h3 = M.hash3(seed + 5, tries, 101 + s);
        const x = W.flat ? 6 + h1 * (W.SX - 12) : cx + (h1 * 2 - 1) * pr, z = W.flat ? W.MZ : cz + (h2 * 2 - 1) * pr;
        if (!W.flat && Math.hypot(x - cx, z - cz) > pr) continue;
        const y0 = W.top_at(x, z);
        if (y0 < -1e8 || y0 < sea + 0.9 || y0 > W.SY - 3) continue;
        const m0 = W.mat_at(x, y0 - 0.12, z);
        if (mats.indexOf(m0) < 0) continue;
        const dev = flatEnough(W, x, z, FOOT[id], y0);
        if (dev < 0 || dev > 0.3) continue;
        let near = false;
        for (const o of out) if (Math.hypot(o.x - x, o.z - z) < 14) near = true;
        for (const w of S.worms || []) if (w.pos && Math.hypot(w.pos.x - x, w.pos.z - z) < 5) near = true;
        for (const t of S.trees || []) if (Math.hypot(t.x - x, t.z - z) < 2.6) near = true;                     // (sim trees / props are not moved: keep clear of them)
        for (const o of S.bodies || []) if (o.pos && Math.hypot(o.pos.x - x, o.pos.z - z) < 2.4 + (o.rb || 0)) near = true;
        for (const o of S.crates || []) if (o.pos && Math.hypot(o.pos.x - x, o.pos.z - z) < 3) near = true;
        if (near) continue;
        if (id === 'hero_monolith') {                 // never beside lava
          let hot = false;
          for (let k = 0; k < 8 && !hot; k++) { const a = k * Math.PI / 4; if (W.mat_at(x + Math.cos(a) * 2.2, W.top_at(x + Math.cos(a) * 2.2, z + Math.sin(a) * 2.2) - 0.12, z + Math.sin(a) * 2.2) === MT.LAVA) hot = true; }
          if (hot) continue;
        }
        out.push({ id: id, x: x, y: y0 - sink - dev * 0.5 + lift, z: z, y0: y0, yaw: h3 * Math.PI * 2, lean: lean, leanDir: h1 < 0.5 ? 1 : -1, r: FOOT[id] });
        n++;
      }
    }
    return out;
  }

  const qa = new T.Quaternion(), qb = new T.Quaternion(), ax = new T.Vector3(0, 1, 0), bx = new T.Vector3(1, 0, 0);

  HV.frame = function (S, view, camera, dt) {
    if (!scene || !SS.models || !SS.world) return;
    const W = SS.world;
    const biome = W.eow ? 'eow' : (W.features && W.features.biome) || W.biome || S.biome || 'temperate';
    const k = biome + ':' + ((S.settings && S.settings.seed) | 0) + ':' + W.SX + ':' + (W.under ? 1 : 0);
    if (S.time < lastT - 0.5 || k !== key) {                       // a new match (clock went back) or a new map
      HV.clear(); key = k;
      if (!W.under && !W.eow && SETS[biome] && S.phase !== undefined && S.worms && S.worms.length) {
        for (const p of pick(S, W, biome)) {
          if (!SS.models.has(p.id)) continue;
          const g = SS.models.mesh(p.id); if (!g) continue;
          g.position.set(p.x, p.y, p.z); qa.setFromAxisAngle(ax, p.yaw);
          if (p.lean) { qb.setFromAxisAngle(bx, p.lean * p.leanDir); qa.multiply(qb); }
          g.quaternion.copy(qa); scene.add(g);
          items.push({ pad: p.r + 0.55, id: p.id, g: g, x: p.x, y: p.y, z: p.z, y0: p.y0, r: p.r, seed: ((p.x * 73 + p.z * 131) | 0) });
          built++;
        }
        // chunks that were built before the sites were known: let the decor / grass of those re-run with the footprints
        if (items.length && SS.terrain && SS.terrain.chunks && SS.terrain.onChunk) {
          const ch = SS.terrain.chunks();
          for (let ci = 0; ci < ch.length; ci++) {
            const c = ch[ci]; if (!c || !c.box) continue;
            for (const it of items) if (it.x + it.pad > c.box.min.x && it.x - it.pad < c.box.max.x && it.z + it.pad > c.box.min.z && it.z - it.pad < c.box.max.z) { SS.terrain.onChunk(ci, c); break; }
          }
        }
      } else if (!S.worms || !S.worms.length) key = '';          // (the world is not populated yet: try again next frame)
    }
    lastT = S.time;
    if (!items.length) return;
    // the ground under a hero changed (blast, collapse, erosion): it breaks
    chk += dt;
    if (chk > 0.45) {
      chk = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i]; let dev = 0;
        const c = W.top_at(it.x, it.z); dev = Math.abs(c - it.y0);
        for (let a = 0; a < 4 && dev < 0.5; a++) dev = Math.max(dev, Math.abs(W.top_at(it.x + Math.cos(a * 1.57) * it.r, it.z + Math.sin(a * 1.57) * it.r) - it.y0));
        if (dev > 0.5) {
          if (SS.models.shatter(it.id, it.g, it.seed)) { if (SS.fx && SS.fx.dust) SS.fx.dust(it.x, it.y0 + 0.4, it.z, 8, 0.7, 0x8a7a64); }
          if (it.g.parent) it.g.parent.remove(it.g);
          items.splice(i, 1);
        }
      }
    }
    glowT += dt;
    const gl = 1.35 + 0.3 * Math.sin(glowT * 0.9) + 0.12 * Math.sin(glowT * 2.1 + 1.3);
    for (const it of items) {
      if (SS.groundView) SS.groundView.blob(it.x, it.y0, it.z, it.r * 0.95, 0.9);
      if (it.id === 'hero_monolith') { const m = it.g.children[0] && it.g.children[0].material; const mm = Array.isArray(m) ? m[0] : m; if (mm) mm.emissiveIntensity = gl; }
    }
  };
})(window.SS = window.SS || {});
