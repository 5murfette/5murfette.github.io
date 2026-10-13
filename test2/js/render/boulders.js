/* render/boulders.js (P116) — the granite boulders of the beach biome (Three.js; presentation only, reads the sim's feature lists, never writes the sim).
 * The sim stamps every boulder of r >= 0.85 m into the voxel terrain as rock (it blocks and can be blown up: F.beach.rocks = centre, semi-axes, yaw) and lists the
 * smaller ones as render-only pebbles (F.beach.pebbles). A 0.5 m voxel surface cannot draw a smooth rounded stone (it reads as a soft, furry blob), so every
 * boulder is DRAWN here as a baked Blender mesh (assets/models_beach.js beach_rock_{L,M,S}{0..2}: smooth rounded granite, one shared PBR granite set, one texture
 * tile = 1.5 m) laid over its terrain dome (1.06 x the dome so the voxel skin is covered), one InstancedMesh per variant (8 draw calls for ~300 stones).
 * Material: the granite PBR set; a damp dark band just above the waterline, a cool dim tint under water (the clear shallows show the stones with a dark halo).
 * A boulder whose ground is gone (a blast dug the dome away) disappears with a puff of dust; a pebble is dropped when the ground under it changes.
 * Nothing is placed in End of the World / caves / on other biomes. Deterministic placement (the sim lists), render only.
 * API: init(scene), clear(), onEvent(), frame(S, view, camera, dt), info(). */
(function (SS) {
  'use strict';
  const T = window.THREE, M = SS.math;
  const BV = SS.boulderView = {};
  const IDS = { L: ['beach_rock_L0', 'beach_rock_L1', 'beach_rock_L2'], M: ['beach_rock_M0', 'beach_rock_M1', 'beach_rock_M2'], S: ['beach_rock_S0', 'beach_rock_S1'] };
  const FIT = 1.06;                       // the mesh is a little bigger than the sim dome: the voxel skin never shows
  let scene = null, mat = null, key = '', items = [], meshes = [], chk = 0, lastT = -1, built = 0, nDrop = 0;
  const tm = new T.Matrix4(), tq = new T.Quaternion(), tp = new T.Vector3(), ts = new T.Vector3(), up = new T.Vector3(0, 1, 0), tc = new T.Color();

  BV.init = function (sc) { scene = sc; };
  BV.clear = function () {
    for (const m of meshes) { if (m.parent) m.parent.remove(m); m.dispose(); }
    meshes = []; items = []; key = ''; built = 0;
  };
  BV.onEvent = function () {};
  BV.info = () => ({ n: items.length, built: built, dropped: nDrop, draws: meshes.length });
  BV._items = () => items;

  /* the shared material: the first model's granite PBR set + the water line darkening */
  function material() {
    if (mat) return mat;
    const g = SS.models.mesh('beach_rock_L0'); if (!g) return null;
    const base = g.children[0].material;
    mat = base.clone(); mat.userData.shared = true;
    mat.envMapIntensity = 0.5;
    mat.onBeforeCompile = sh => {
      sh.uniforms.uSeaB = SS.terrain.uniforms.uSea;
      sh.vertexShader = sh.vertexShader.replace('void main() {', 'varying vec3 vRW;\nvoid main() {')
        .replace('#include <project_vertex>', '#include <project_vertex>\n vRW = (modelMatrix * (instanceMatrix * vec4(transformed, 1.0))).xyz;');
      sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'varying vec3 vRW; uniform float uSeaB;\nvoid main() {')
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            float rel = vRW.y - uSeaB;
            float wob = 0.07 * sin(vRW.x * 5.3 + vRW.z * 3.7) + 0.05 * sin(vRW.x * 11.0 - vRW.z * 9.0);
            float wetB = 1.0 - smoothstep(0.02, 0.5 + wob, rel);                           // the splash zone: dark, damp stone
            diffuseColor.rgb *= mix(1.0, 0.5, wetB);
            float und = clamp(-rel, 0.0, 3.0);
            diffuseColor.rgb *= mix(vec3(1.0), vec3(0.34, 0.44, 0.36), smoothstep(0.0, 0.9, und));     // under water: absorbed red, a dark cool stone (the water layer lifts it again)
          }`);
    };
    mat.customProgramCacheKey = () => 'beachrock1';
    return mat;
  }

  function classOf(r) { return r >= 1.5 ? 'L' : r >= 0.75 ? 'M' : 'S'; }

  /* instance records from the sim lists, checked against the terrain that really exists (2D band, fort, a blast before the first frame) */
  const isLow = () => { const q = SS.view && SS.view.quality ? SS.view.quality() : null; return !!q && q.name === 'low'; };
  function collect(S, W, F) {
    const out = [], sea = W.SEA, B = F.beach, low = isLow();
    for (const o of B.rocks || []) {
      const top = W.top_at(o.x, o.z);
      if (top < -1e8 || top < o.y + o.ry * 0.45) continue;                         // no dome here (unfilled rows of a 2D map, dug away)
      const r = Math.max(o.rx, o.rz), cls = classOf(r);
      out.push({ sim: 1, cls, x: o.x, y: o.y, z: o.z, rx: o.rx, rz: o.rz, ry: o.ry, yaw: o.yaw, seed: o.seed, top0: top, r, g: o.g });
    }
    for (const p of B.pebbles || []) {
      if (low && p.r < 0.55) continue;                                              // (low quality: the small stones are dropped: fewer instances, the big ones carry the look)
      const g = W.top_at(p.x, p.z);
      if (g < -1e8 || g > W.SY - 3) continue;
      let ry = p.ry, cy = g - 0.2 * ry;
      if (p.sub && g + 0.8 * ry > sea - 0.12) { ry = (sea - 0.12 - g) / 0.8; if (ry < 0.12) continue; cy = g - 0.2 * ry; }
      if (g < sea - 0.1 && !p.sub && g + 0.8 * ry < sea - 0.12) { /* a dry-listed pebble that lies under the sea: keep it, it simply shows through the water */ }
      const rx = p.r * p.asp, rz = p.r / p.asp, cls = classOf(Math.max(rx, rz) * 1.0);
      out.push({ sim: 0, cls, x: p.x, y: cy, z: p.z, rx, rz, ry, yaw: p.yaw, seed: p.seed, top0: g, r: Math.max(rx, rz), g });
    }
    return out;
  }

  /* the dark halo round a stone (ambient occlusion on the sand under the water / a soft contact shadow on the beach): one radial-gradient quad per stone, flat on the ground */
  let haloTex = null;
  function halo() {
    if (haloTex) return haloTex;
    const cv = document.createElement('canvas'); cv.width = cv.height = 128; const x = cv.getContext('2d');
    const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.55, 'rgba(255,255,255,0.85)'); g.addColorStop(0.8, 'rgba(255,255,255,0.28)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
    haloTex = new T.CanvasTexture(cv); haloTex.colorSpace = T.SRGBColorSpace;
    return haloTex;
  }
  function addHalos(recs, W) {
    for (const wet of [1, 0]) {
      const L = recs.filter(r => (r.g < W.SEA + 0.05 ? 1 : 0) === wet && r.r >= 0.4);
      if (!L.length) continue;
      const geo = new T.PlaneGeometry(1, 1); geo.rotateX(-Math.PI / 2);
      const m = new T.MeshBasicMaterial({ map: halo(), color: wet ? 0x070a04 : 0x2a1a0c, transparent: true, opacity: wet ? 0.62 : 0.3, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const im = new T.InstancedMesh(geo, m, L.length);
      for (let i = 0; i < L.length; i++) {
        const r = L[i]; tp.set(r.x, r.g + 0.04, r.z); tq.setFromAxisAngle(up, -r.yaw); ts.set(r.rx * 3.0 + 0.5, 1, r.rz * 3.0 + 0.5); tm.compose(tp, tq, ts); im.setMatrixAt(i, tm);
      }
      im.instanceMatrix.needsUpdate = true; im.frustumCulled = false; im.renderOrder = 5.5; im.castShadow = false; im.receiveShadow = false;
      scene.add(im); meshes.push(im);
    }
  }

  /* the village's board walks: weathered planks laid across a path from door to door (a chain to the nearest hut) and from the sea-facing doors down the beach; one InstancedMesh
   * of ~100 boards; a board whose ground changed is dropped with the rest of the stones' check (below) */
  function walkways(W, B) {
    const hs = (B.huts || []).filter(h => W.top_at(h.x, h.z) > -1e8);
    if (hs.length < 2) return;
    const door = h => ({ x: h.x + Math.cos(h.yaw) * 2.5, z: h.z - Math.sin(h.yaw) * 2.5 });
    const boards = [];
    const line = (a, b, wob) => {
      const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(2, Math.round(L / 0.42)), px = -(b.z - a.z) / L, pz = (b.x - a.x) / L, yaw = Math.atan2(b.z - a.z, b.x - a.x);
      for (let i = 0; i <= n; i++) {
        const t = i / n, o = Math.sin(t * 6.283 * (0.7 + wob) + wob * 9) * 0.3 * Math.sin(t * 3.1416), x = a.x + (b.x - a.x) * t + px * o, z = a.z + (b.z - a.z) * t + pz * o, g = W.top_at(x, z);
        if (g > W.SEA + 0.3 && g < W.SY - 3) boards.push({ x, y: g, z, yaw, k: M.hash3(i, (a.x * 7) | 0, (a.z * 5) | 0) });
      }
    };
    const left = hs.slice(1), cur = [hs[0]];
    while (left.length) {
      const l = cur[cur.length - 1]; let bi = 0, bd = 1e9;
      left.forEach((h, i) => { const d = Math.hypot(h.x - l.x, h.z - l.z); if (d < bd) { bd = d; bi = i; } });
      const h = left.splice(bi, 1)[0]; line(door(l), door(h), cur.length * 0.37); cur.push(h);
    }
    for (const h of hs) {
      const d0 = door(h), dx = Math.cos(h.yaw), dz = -Math.sin(h.yaw); let L = 0;
      while (L < 30 && W.top_at(d0.x + dx * L, d0.z + dz * L) > W.SEA + 0.35) L += 0.5;
      if (L > 2 && L < 30) line(d0, { x: d0.x + dx * (L - 0.8), z: d0.z + dz * (L - 0.8) }, 0.2 + 0.1 * (h.x % 1));
    }
    if (!boards.length) return;
    const geo = new T.BoxGeometry(1.15, 0.06, 0.32), m = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
    const im = new T.InstancedMesh(geo, m, boards.length);
    for (let i = 0; i < boards.length; i++) {
      const b = boards[i];
      tp.set(b.x, b.y + 0.02, b.z); tq.setFromAxisAngle(up, -(b.yaw + Math.PI / 2) + (b.k - 0.5) * 0.12); ts.set(1, 1, 0.9 + 0.2 * b.k); tm.compose(tp, tq, ts); im.setMatrixAt(i, tm);
      const v = 0.5 + 0.35 * M.hash3(i, 3, 3); tc.setRGB(v * 0.95, v * 0.78, v * 0.58, T.SRGBColorSpace); im.setColorAt(i, tc);
    }
    im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = false; im.receiveShadow = true; im.frustumCulled = false;
    scene.add(im); meshes.push(im);
  }

  function build(S, W) {
    BV.clear();
    key = ((S.settings && S.settings.seed) | 0) + ':' + W.SX + ':' + (W.flat ? 1 : 0) + ':' + (W.biome || '');
    const F = W.features;
    if (!F || !F.beach || !SS.models || !SS.models.has('beach_rock_L0')) return;
    const m = material(); if (!m) return;
    const recs = collect(S, W, F);
    const groups = {};
    for (const r of recs) {
      const ids = IDS[r.cls], id = ids[Math.min(ids.length - 1, Math.floor(M.hash3(r.seed | 0, 3, 7) * ids.length))];
      (groups[id] || (groups[id] = [])).push(r);
    }
    for (const id in groups) {
      const L = groups[id], mod = SS.MODELS[id], bb = mod.bbox, g = SS.models.mesh(id).children[0].geometry;
      const hx = (bb[3] - bb[0]) / 2, hz = (bb[5] - bb[2]) / 2, top = bb[4], cxm = (bb[3] + bb[0]) / 2, czm = (bb[5] + bb[2]) / 2;
      const im = new T.InstancedMesh(g, m, L.length);
      for (let i = 0; i < L.length; i++) {
        const r = L[i];
        // X of the model = the sim's u axis (yaw): local +X -> (cos yaw, sin yaw) in (x, z) = three's rotation.y of -yaw; model Z -> the sim's v axis
        ts.set(FIT * r.rx / hx, FIT * r.ry / top, FIT * r.rz / hz);
        tq.setFromAxisAngle(up, -r.yaw);
        tp.set(r.x, r.y, r.z);
        // the model's bounding box is not centred on its pivot: shift so the box centre (x, z) sits on the dome centre
        tp.x -= (cxm * ts.x) * Math.cos(-r.yaw) + (czm * ts.z) * Math.sin(-r.yaw);
        tp.z -= -(cxm * ts.x) * Math.sin(-r.yaw) + (czm * ts.z) * Math.cos(-r.yaw);
        tm.compose(tp, tq, ts); im.setMatrixAt(i, tm);
        const v = 0.86 + 0.28 * M.hash3(r.seed | 0, 11, 3);
        tc.setRGB(v * (0.95 + 0.1 * M.hash3(r.seed | 0, 13, 3)), v * (0.97 + 0.06 * M.hash3(r.seed | 0, 17, 3)), v, T.SRGBColorSpace); im.setColorAt(i, tc);
      }
      im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
      // the small stones cast no shadow (cheap decor); on low quality only the big ones do
      im.castShadow = id.indexOf('_S') < 0 && (!isLow() || id.indexOf('_L') > 0);
      im.receiveShadow = true; im.frustumCulled = false;
      im.userData.recs = L; im.userData.model = id;
      scene.add(im); meshes.push(im);
      for (const r of L) items.push({ r, im, idx: L.indexOf(r) });
    }
    if (!isLow()) addHalos(recs, W);
    walkways(W, F.beach);
    built++;
  }

  /* hide one instance (scale 0) */
  const zero = new T.Matrix4().makeScale(0, 0, 0);
  function drop(it) {
    it.im.setMatrixAt(it.idx, zero); it.im.instanceMatrix.needsUpdate = true; it.gone = true; nDrop++;
    if (SS.fx && SS.fx.dust) SS.fx.dust(it.r.x, it.r.y + it.r.ry * 0.5, it.r.z, it.r.sim ? 10 : 4, it.r.sim ? 0.9 : 0.4, 0x8a7060);
  }

  BV.frame = function (S, view, camera, dt) {
    if (!scene || !SS.models || !SS.world) return;
    const W = SS.world;
    const bio = (W.features && W.features.biome) || W.biome || S.biome;
    const k = ((S.settings && S.settings.seed) | 0) + ':' + W.SX + ':' + (W.flat ? 1 : 0) + ':' + (W.biome || '');
    if (S.time < lastT - 0.5 || k !== key) {
      if (bio === 'beach' && !W.under && !W.eow && S.phase !== undefined && S.worms && S.worms.length) build(S, W);
      else { BV.clear(); key = k; if (!S.worms || !S.worms.length) key = ''; }
    }
    lastT = S.time;
    if (!items.length) return;
    chk += dt;
    if (chk > 0.4) {                                                             // the ground under a boulder changed (blast, collapse): it goes
      chk = 0;
      for (const it of items) {
        if (it.gone) continue;
        const r = it.r, t = W.top_at(r.x, r.z);
        if (r.sim ? t < r.y + r.ry * 0.45 - 0.3 : Math.abs(t - r.top0) > 0.35) drop(it);
      }
    }
  };
})(window.SS = window.SS || {});
