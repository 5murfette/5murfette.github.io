/* render/models.js — baked glTF-derived models (assets/models.js, format in docs/MODELS.md). Three.js side only.
 * API: SS.models.has(id), SS.models.mesh(id) -> a new THREE.Group holding one Mesh that SHARES the per-id geometry and
 * material (built once on first use, flagged userData.shared so SS.mat.disposeTree keeps them), null when the id has no
 * baked model (the caller then builds its procedural mesh), SS.models.decode(part) -> plain typed arrays (also used by
 * tests), SS.models.stats().
 * Breakable models (fmt 2): SS.models.hasChunks(id), SS.models.shatter(id, group, seed) (render-only: the intact group is
 * hidden and its pre-fractured chunks + interior parts fly as debris, see below), SS.models.update(dt), SS.models.init(scene).
 * Conventions: local +X = nose / aim / flight direction, +Y = up, metres, pivot already applied by the baker. UVs keep the
 * glTF convention (origin top-left), so textures use flipY = false; aoMap reads uv2 (geometry attribute 'uv1', texture
 * channel 1) when the model has one, else uv. Basecolor is sRGB, normal / AO are linear. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const MD = SS.models = {};
  const built = {};
  const debris = [];
  const MAXD = 96, GRAV = 17;
  let scene = null;

  function bytes(b64) {
    const s = atob(b64), n = s.length, u = new Uint8Array(n);
    for (let i = 0; i < n; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function f32(b64) { const u = bytes(b64); return new Float32Array(u.buffer, 0, u.length >> 2); }
  function i16(b64) { const u = bytes(b64); return new Int16Array(u.buffer, 0, u.length >> 1); }
  function u16(b64) { const u = bytes(b64); return new Uint16Array(u.buffer, 0, u.length >> 1); }
  function u32(b64) { const u = bytes(b64); return new Uint32Array(u.buffer, 0, u.length >> 2); }

  /* octahedral decode of one int16 pair into a unit vector (out[o..o+2]) */
  function octDecode(e, i, out, o) {
    let x = e[i] / 32767, y = e[i + 1] / 32767;
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) { const ox = x; x = (1 - Math.abs(y)) * (ox >= 0 ? 1 : -1); y = (1 - Math.abs(ox)) * (y >= 0 ? 1 : -1); }
    const l = Math.hypot(x, y, z) || 1;
    out[o] = x / l; out[o + 1] = y / l; out[o + 2] = z / l;
  }
  function uvDecode(u, nv) {
    const q = u16(u.b64), r = new Float32Array(nv * 2);
    for (let i = 0; i < nv; i++) { r[i * 2] = u.min[0] + q[i * 2] / 65535 * u.range[0]; r[i * 2 + 1] = u.min[1] + q[i * 2 + 1] / 65535 * u.range[1]; }
    return r;
  }

  MD.has = id => !!(SS.MODELS && SS.MODELS[id]);
  MD.hasChunks = id => !!(SS.MODELS && SS.MODELS[id] && SS.MODELS[id].chunks && SS.MODELS[id].chunks.length);

  /* a mesh block (the model itself, an interior part or a chunk) -> typed arrays; cached on the block */
  MD.decode = function (m) {
    if (m._dec) return m._dec;
    const eo = i16(m.nrm.b64), nrm = new Float32Array(m.nv * 3);
    for (let i = 0; i < m.nv; i++) octDecode(eo, i * 2, nrm, i * 3);
    const idx = m.idx.type === 'u32' ? u32(m.idx.b64) : u16(m.idx.b64);
    return (m._dec = { pos: f32(m.pos.b64), nrm: nrm, uv: uvDecode(m.uv, m.nv), uv2: m.uv2 ? uvDecode(m.uv2, m.nv) : null, idx: idx });
  };

  function texture(uri, srgb) {
    const img = new Image(), t = new T.Texture(img);
    img.onload = () => { t.needsUpdate = true; };
    img.src = uri;
    t.flipY = false; t.anisotropy = 4; t.wrapS = t.wrapT = T.RepeatWrapping;
    if (srgb && T.SRGBColorSpace) t.colorSpace = T.SRGBColorSpace;
    t.userData.shared = true;
    return t;
  }

  function material(tx, color, rough, metal, side, hasUv2) {
    const o = { color: 0xffffff, roughness: rough, metalness: metal, side: side };
    if (tx.basecolor) o.map = texture(tx.basecolor, true); else o.color = color;
    if (tx.normal) o.normalMap = texture(tx.normal, false);
    if (tx.ao) { o.aoMap = texture(tx.ao, false); o.aoMap.channel = hasUv2 ? 1 : 0; }
    const mat = new T.MeshStandardMaterial(o);
    mat.userData.shared = true;
    return mat;
  }

  function geometry(m) {
    const d = MD.decode(m), geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(d.pos, 3));
    geo.setAttribute('normal', new T.BufferAttribute(d.nrm, 3));
    geo.setAttribute('uv', new T.BufferAttribute(d.uv, 2));
    if (d.uv2) geo.setAttribute('uv1', new T.BufferAttribute(d.uv2, 2));
    geo.setIndex(new T.BufferAttribute(d.idx, 1));
    if (m.groups) for (const g of m.groups) geo.addGroup(g[0], g[1], g[2]);       // (a material array draws nothing without groups)
    geo.computeBoundingSphere(); geo.computeBoundingBox();
    geo.userData.shared = true;
    return geo;
  }

  function build(id) {
    const m = SS.MODELS[id], side = m.double ? T.DoubleSide : T.FrontSide, tm = m.texmeta || {};
    const outer = material(m.tex || {}, m.color === undefined ? 0xffffff : m.color, 0.7, 0.0, side, !!m.uv2 && tm.aoUv === 'uv2');
    const b = { geo: geometry(m), mat: outer, inner: null, parts: null };
    if (m.inner) b.inner = material(m.inner.tex || {}, m.inner.color, m.inner.roughness, m.inner.metalness, T.DoubleSide, false);
    return (built[id] = b);
  }
  function mats(b) { return b.inner ? [b.mat, b.inner] : b.mat; }

  /* the intact model: one mesh (faces of material slot 1, if any, use the inner material) */
  MD.mesh = function (id) {
    if (!MD.has(id)) return null;
    const b = built[id] || build(id);
    const g = new T.Group(), mesh = new T.Mesh(b.geo, mats(b));
    mesh.castShadow = true; mesh.receiveShadow = true;
    g.add(mesh); g.userData.model = id; g.userData.props = [];
    return g;
  };

  /* chunks + interior parts: built once per id (shared geometry), instanced as meshes at their origin in model space */
  function parts(id) {
    const b = built[id] || build(id);
    if (b.parts) return b.parts;
    const m = SS.MODELS[id], r = [];
    for (const c of (m.chunks || [])) r.push({ geo: geometry(c), origin: c.origin, radius: c.radius, chunk: true });
    for (const c of (m.interior || [])) {
      const geo = geometry(c), bb = geo.boundingBox;
      r.push({ geo: geo, origin: c.origin || [0, 0, 0], radius: c.radius || 0.3, chunk: false, half: Math.max(0.01, (bb.max.y - bb.min.y) / 2) });
    }
    return (b.parts = r);
  }

  /* the textures are data URIs decoded on the event loop: build every model at init so a prop / grave / crate that first
   * appears mid-match is never drawn untextured (black) for its first frames */
  MD.init = function (sc) {
    scene = sc;
    if (SS.MODELS) for (const id in SS.MODELS) if (!built[id]) build(id);
  };
  MD.clear = function () { for (const d of debris) if (d.g.parent) d.g.parent.remove(d.g); debris.length = 0; };

  /* deterministic per-break random stream (the break event's body id), so replays look the same */
  function rng(seed) { let s = (seed * 2654435761 + 12345) >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

  /* A prop with baked chunks broke (view.js 'propbreak'): hide the intact group, spawn the chunks and the interior parts
   * as render-only debris at the intact group's transform. No sim state is touched. Returns true when it handled the break
   * (the caller then skips its procedural chips), false when the model has no chunks (procedural break). */
  MD.shatter = function (id, grp, seed) {
    if (!scene || !MD.hasChunks(id) || !grp) return false;
    const b = built[id] || build(id), ps = parts(id), br = SS.MODELS[id].break || {}, rnd = rng(seed | 0);
    const q = grp.quaternion, p = grp.position, sp = br.speed || 3, spin = br.spin || 4, life = br.life || 6;
    grp.visible = false;
    for (const c of ps) {
      if (debris.length >= MAXD) { const o = debris.shift(); if (o.g.parent) o.g.parent.remove(o.g); }
      const me = new T.Mesh(c.geo, mats(b)); me.castShadow = true;
      const g = new T.Group(); g.add(me);
      const o = new T.Vector3(c.origin[0], c.origin[1], c.origin[2]), out = o.clone().applyQuaternion(q);
      g.position.copy(p).add(out); g.quaternion.copy(q);
      const l = out.length() || 1, k = c.chunk ? sp : sp * 0.35;
      const v = new T.Vector3(out.x / l * k * (0.6 + rnd() * 0.8), (c.chunk ? 2 : 0.3) + rnd() * sp * (c.chunk ? 0.8 : 0.15), out.z / l * k * (0.6 + rnd() * 0.8));
      const sc = c.chunk ? 1 : 0.25;
      const w = new T.Vector3((rnd() - 0.5) * spin * sc, (rnd() - 0.5) * spin * sc, (rnd() - 0.5) * spin * sc);
      scene.add(g);
      debris.push({ g: g, v: v, w: w, t: 0, life: life * (c.chunk ? 0.8 + rnd() * 0.4 : 0.7), r: c.chunk ? c.radius * 0.5 : c.half, rest: false });
    }
    return true;
  };

  /* per frame: ballistic fall, a bounce on the terrain top, spin damping, shrink away at the end of the life */
  const qTmp = new T.Quaternion(), eTmp = new T.Euler();                       // (R10: were allocated every frame while debris flew)
  MD.update = function (dt) {
    if (!debris.length) return;
    const W = SS.world, q = qTmp, e = eTmp;
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      d.t += dt;
      if (d.t >= d.life) { if (d.g.parent) d.g.parent.remove(d.g); debris.splice(i, 1); continue; }
      const left = d.life - d.t; if (left < 0.6) d.g.scale.setScalar(Math.max(0.01, left / 0.6));
      if (d.rest) continue;
      d.v.y -= GRAV * dt;
      d.g.position.addScaledVector(d.v, dt);
      e.set(d.w.x * dt, d.w.y * dt, d.w.z * dt); q.setFromEuler(e); d.g.quaternion.premultiply(q);
      const gy = W && W.top_at ? W.top_at(d.g.position.x, d.g.position.z) : -1e9;
      if (d.g.position.y - d.r < gy) {
        d.g.position.y = gy + d.r;
        if (Math.abs(d.v.y) < 1.2) { d.rest = true; continue; }
        d.v.y *= -0.3; d.v.x *= 0.6; d.v.z *= 0.6; d.w.multiplyScalar(0.6);
      }
    }
  };

  MD.debrisCount = () => debris.length;
  MD._debris = () => debris;

  MD.stats = function () {
    const r = {};
    for (const id in (SS.MODELS || {})) r[id] = { nv: SS.MODELS[id].nv, nt: SS.MODELS[id].nt, chunks: (SS.MODELS[id].chunks || []).length, built: !!built[id] };
    return r;
  };
})(window.SS = window.SS || {});
