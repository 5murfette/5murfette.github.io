/* render/blood.js — the PoC's optional gore (setup "Blood": On), presentation only (Three.js; Math.random is fine).
 *   - a hit of 3+ HP sprays droplets: short dark-red streaks that fly, fall and leave a wet stain where they land;
 *   - a worm that bursts ('gib', blood on): a radial splat (rays in every direction stain the ground they meet, bigger
 *     close in, like a burst paint balloon), meat chunks that bounce and settle, and a big droplet burst.
 * Stains are instanced flat discs on the terrain (a procedural ragged-rim alpha), wet and glossy; a stain whose ground
 * is blown away disappears (checked a few per frame). API: init(scene), clear(), onEvent(S, e), frame(S, dt). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const BV = SS.bloodView = {};
  const DROPS = 900, STAINS = 900, GIBS = 120;
  let scene = null, lines = null, lp = null, lc = null, stains = null, gibs = null, nStain = 0, chk = 0;
  const drops = [], meat = [], stainPos = [];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const m4 = new T.Matrix4(), q = new T.Quaternion(), zAxis = new T.Vector3(0, 0, 1), nv = new T.Vector3(), sv = new T.Vector3(), pv = new T.Vector3();
  function stainAlpha() {
    // a ragged splat: a radial falloff with a noisy rim and a few satellite droplets
    const N = 64, d = new Uint8Array(N * N * 4);
    const sat = []; for (let i = 0; i < 7; i++) { const a = Math.random() * 6.283, r = rnd(0.62, 0.9); sat.push([0.5 + Math.cos(a) * r * 0.5, 0.5 + Math.sin(a) * r * 0.5, rnd(0.03, 0.07)]); }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const u = x / (N - 1), v = y / (N - 1), dx = u - 0.5, dy = v - 0.5, r = Math.hypot(dx, dy) * 2, a = Math.atan2(dy, dx);
      const rim = 0.72 + 0.12 * Math.sin(a * 5 + 1.3) + 0.08 * Math.sin(a * 11 + 0.4);
      let k = r < rim ? 1 - Math.pow(r / rim, 6) * 0.35 : 0;
      for (const [sx, sy, sr] of sat) if (Math.hypot(u - sx, v - sy) < sr) k = Math.max(k, 0.9);
      const o = (y * N + x) * 4; d[o] = d[o + 1] = d[o + 2] = 255; d[o + 3] = Math.round(k * 255);
    }
    const t = new T.DataTexture(d, N, N, T.RGBAFormat); t.needsUpdate = true; t.magFilter = T.LinearFilter; t.minFilter = T.LinearMipmapLinearFilter; t.generateMipmaps = true;
    return t;
  }
  // stains / gibs follow the section view (user 2026-10-08: drops floated over the see-through context ground)
  const slab = m => (SS.view && SS.view.slabFade ? SS.view.slabFade(m, 0.45) : m);
  BV.init = function (sc) {
    scene = sc;
    const g = new T.BufferGeometry();
    lp = new Float32Array(DROPS * 6); lc = new Float32Array(DROPS * 6);
    g.setAttribute('position', new T.BufferAttribute(lp, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('color', new T.BufferAttribute(lc, 3).setUsage(T.DynamicDrawUsage));
    lines = new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    lines.frustumCulled = false; lines.renderOrder = 7; scene.add(lines);
    stains = new T.InstancedMesh(new T.CircleGeometry(1, 12), slab(new T.MeshStandardMaterial({ color: 0x5a0408, roughness: 0.22, metalness: 0, alphaMap: stainAlpha(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 })), STAINS);
    stains.instanceMatrix.setUsage(T.DynamicDrawUsage); stains.count = 0; stains.frustumCulled = false; stains.renderOrder = 2; scene.add(stains);
    gibs = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0), slab(new T.MeshStandardMaterial({ roughness: 0.45, metalness: 0 })), GIBS);
    gibs.instanceMatrix.setUsage(T.DynamicDrawUsage); gibs.count = 0; gibs.frustumCulled = false; gibs.castShadow = true; scene.add(gibs);
    gibs.setColorAt(0, new T.Color(0xffffff));
  };
  BV.clear = function () { drops.length = 0; meat.length = 0; stainPos.length = 0; nStain = 0; if (stains) stains.count = 0; if (gibs) gibs.count = 0; };
  // dir (user 2026-10-08): the hit's direction (blast -> worm, the bat / shot along its aim): the droplets fly in a cone
  // around it (hit from above: down onto the ground around the worm; from the front: out behind it, onto the ground
  // there); a few still scatter at random. No dir: the old all-round spray.
  function burst(x, y, z, n, sp, up, dir) {
    for (let k = 0; k < n; k++) {
      if (drops.length >= DROPS) drops.shift();
      let vx, vy, vz;
      const v = rnd(0.25, 1) * sp;
      if (dir && Math.random() < 0.85) {
        // a random direction within ~35 deg of dir (+ a little lift so a side hit arcs instead of skimming)
        const ux = dir.x + rnd(-0.6, 0.6), uy = dir.y + rnd(-0.45, 0.45) + 0.15, uz = dir.z + rnd(-0.6, 0.6), l = Math.hypot(ux, uy, uz) || 1;
        vx = ux / l * v * 1.3; vy = uy / l * v * 1.3; vz = uz / l * v * 1.3;
      } else {
        const a = Math.random() * 6.283, el = rnd(-0.3, 1.2) * (up ? 1 : 0.6), c = Math.cos(el);
        vx = Math.cos(a) * c * v; vy = Math.sin(el) * v; vz = Math.sin(a) * c * v;
      }
      drops.push({ x: x + rnd(-0.1, 0.1), y: y + rnd(-0.1, 0.15), z: z + rnd(-0.1, 0.1), vx, vy, vz, life: 3, big: Math.random() < 0.3 });
    }
  }
  function stain(x, y, z, size) {
    const W = SS.world, n = W.normal ? W.normal(x, y, z, {}) : { x: 0, y: 1, z: 0 };
    nv.set(-(n.x || 0), -(n.y || -1), -(n.z || 0)); if (nv.lengthSq() < 1e-6) nv.set(0, 1, 0); nv.normalize();
    // the density gradient points into the rock: the stain faces out of it
    if (W.sample(x + nv.x * 0.3, y + nv.y * 0.3, z + nv.z * 0.3) > W.sample(x, y, z)) nv.negate();
    q.setFromUnitVectors(zAxis, nv); q.multiply(new T.Quaternion().setFromAxisAngle(zAxis, Math.random() * 6.283));
    pv.set(x + nv.x * 0.015, y + nv.y * 0.015, z + nv.z * 0.015); sv.set(size, size * rnd(0.75, 1), 1);
    const i = nStain % STAINS; m4.compose(pv, q, sv); stains.setMatrixAt(i, m4); stainPos[i] = { x, y, z, nx: nv.x, ny: nv.y, nz: nv.z, s: size };
    nStain++; stains.count = Math.min(STAINS, nStain); stains.instanceMatrix.needsUpdate = true;
  }
  // a burst worm: rays out in every direction stain what they meet (bigger close in)
  function splatRadial(x, y, z, dir) {
    const W = SS.world;
    for (let k = 0; k < 90; k++) {
      const u = Math.random() * 2 - 1, a = Math.random() * 6.283, s = Math.sqrt(1 - u * u);
      let dx = s * Math.cos(a), dy = u * 0.8 - 0.25, dz = s * Math.sin(a), reach = rnd(1.2, 4.2);
      if (dir) { dx += dir.x * 1.4; dy += dir.y * 1.4; dz += dir.z * 1.4; const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l; reach *= 1.3; }   // blown along the hit
      for (let d = 0.45; d < reach; d += 0.1) {
        const px = x + dx * d, py = y + dy * d, pz = z + dz * d;
        if (W.sample(px, py, pz) > 0) { stain(px, py, pz, (0.12 + 0.35 * (1 - d / reach)) * rnd(0.7, 1.2)); break; }
      }
    }
  }
  const MEAT = [0xf2a0a8, 0xe68e98, 0x96141e, 0xc85a64, 0x780a12];
  function gibBurst(x, y, z) {
    for (let i = 0; i < 28; i++) {
      if (meat.length >= GIBS) meat.shift();
      const a = Math.random() * 6.283, v = rnd(2, 9), el = rnd(0.2, 1.3);
      meat.push({ x, y: y + 0.2, z, vx: Math.cos(a) * Math.cos(el) * v, vy: Math.sin(el) * v, vz: Math.sin(a) * Math.cos(el) * v, r: rnd(0.035, 0.085), c: new T.Color(MEAT[i % MEAT.length]), t: 0, rest: false, rx: Math.random() * 6, ry: Math.random() * 6 });
    }
  }
  BV.onEvent = function (S, e) {
    if (!scene || !S.settings.blood) return;
    if (e.type === 'hurt' && e.worm && e.amount >= 3 && !e.worm.dead) burst(e.worm.pos.x, e.worm.pos.y + 0.1, e.worm.pos.z, Math.min(40, Math.round(e.amount * 1.4)), 4 + e.amount * 0.12, true, e.dir);
    if (e.type === 'gib') { splatRadial(e.x, e.y, e.z, e.dir); gibBurst(e.x, e.y, e.z); burst(e.x, e.y, e.z, 90, 9, true, e.dir); }
  };
  BV.frame = function (S, dt) {
    if (!scene) return;
    const W = SS.world, G = 9.81;
    let n = 0;
    for (let i = drops.length - 1; i >= 0; i--) {
      const b = drops[i]; b.life -= dt; b.vy -= G * dt; const k = 1 - 0.6 * dt; b.vx *= k; b.vz *= k;
      const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt, nz = b.z + b.vz * dt;
      if (b.life <= 0 || ny < SS.sim.surface_at(S, nx, nz)) { drops.splice(i, 1); continue; }
      if (W.sample(nx, ny, nz) > 0) { stain(b.x, b.y, b.z, b.big ? rnd(0.09, 0.16) : rnd(0.04, 0.08)); drops.splice(i, 1); continue; }
      b.x = nx; b.y = ny; b.z = nz;
    }
    for (const b of drops) {
      const o = n * 6, L = 0.025;
      lp[o] = b.x; lp[o + 1] = b.y; lp[o + 2] = b.z; lp[o + 3] = b.x - b.vx * L; lp[o + 4] = b.y - b.vy * L; lp[o + 5] = b.z - b.vz * L;
      lc[o] = 0.28; lc[o + 1] = 0.005; lc[o + 2] = 0.01; lc[o + 3] = 0.16; lc[o + 4] = 0.003; lc[o + 5] = 0.006; n++;
    }
    lines.geometry.setDrawRange(0, n * 2); lines.geometry.attributes.position.needsUpdate = true; lines.geometry.attributes.color.needsUpdate = true;
    // meat chunks: bounce, roll to a stop, fade after ~30 s
    let gN = 0;
    for (let i = meat.length - 1; i >= 0; i--) {
      const m = meat[i]; m.t += dt;
      if (m.t > 32) { meat.splice(i, 1); continue; }
      if (!m.rest) {
        m.vy -= G * dt; const nx = m.x + m.vx * dt, ny = m.y + m.vy * dt, nz = m.z + m.vz * dt;
        if (W.sample(nx, ny - m.r, nz) > 0) {
          if (Math.abs(m.vy) > 1.5 && Math.random() < 0.5) stain(m.x, m.y - m.r, m.z, rnd(0.06, 0.12));
          m.vy = -m.vy * 0.25; m.vx *= 0.55; m.vz *= 0.55;
          if (Math.hypot(m.vx, m.vy, m.vz) < 0.4) m.rest = true;
        } else { m.x = nx; m.y = ny; m.z = nz; m.rx += dt * 6; m.ry += dt * 4; }
        if (m.y < SS.sim.surface_at(S, m.x, m.z) - 0.3) { meat.splice(i, 1); continue; }
      } else if (W.sample(m.x, m.y - m.r - 0.05, m.z) <= 0) m.rest = false;      // the ground under it is gone
    }
    for (const m of meat) {
      const s = m.r * (m.t > 28 ? Math.max(0.01, (32 - m.t) / 4) : 1);
      q.setFromEuler(new T.Euler(m.rx, m.ry, 0)); pv.set(m.x, m.y, m.z); sv.set(s, s * 0.8, s * 1.1); m4.compose(pv, q, sv);
      gibs.setMatrixAt(gN, m4); gibs.setColorAt(gN, m.c); gN++;
    }
    gibs.count = gN; gibs.instanceMatrix.needsUpdate = true; if (gibs.instanceColor) gibs.instanceColor.needsUpdate = true;
    // stains on ground that was blown away disappear (a few checks per frame)
    for (let k = 0; k < 24 && stainPos.length; k++) {
      chk = (chk + 1) % stainPos.length; const p = stainPos[chk];
      if (p && p.s > 0 && W.sample(p.x - p.nx * 0.12, p.y - p.ny * 0.12, p.z - p.nz * 0.12) <= 0) { p.s = 0; m4.makeScale(0, 0, 0); stains.setMatrixAt(chk, m4); stains.instanceMatrix.needsUpdate = true; }
    }
  };
})(window.SS = window.SS || {});
