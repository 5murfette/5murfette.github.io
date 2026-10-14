/* render/blood.js — the PoC's optional gore (setup "Blood": On), presentation only (Three.js; Math.random is fine).
 *   - a hit of 3+ HP sprays droplets: short dark-red streaks that fly, fall and leave a wet stain where they land;
 *   - a worm that bursts ('gib', blood on): a radial splat (rays in every direction stain the ground they meet, bigger
 *     close in, like a burst paint balloon), meat chunks that bounce and settle, and a big droplet burst.
 * P37-W3: (1) setup "Blood in team colour" (settings.teamBlood): every droplet / stain / mush of a worm is its team's
 * colour (rgb of the team, darkened a little for the wet look); (2) the minigun: each round that hits sprays a short
 * directional burst ('bloodhit'), and a worm that goes down under its rounds is SHREDDED ('gib' with worm.mgKill): pink
 * worm segments (capsules with torn red ends), a head with its eye, a tail tip, red mush chunks and a big stain splat;
 * the pieces tumble, bounce and settle like the meat chunks.
 * Stains are instanced flat discs on the terrain (a procedural ragged-rim alpha), wet and glossy; a stain whose ground
 * is blown away disappears (checked a few per frame). API: init(scene), clear(), onEvent(S, e), frame(S, dt). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const BV = SS.bloodView = {};
  const DROPS = 1400, STAINS = 1100, GIBS = 240;
  let scene = null, lines = null, lp = null, lc = null, stains = null, gibs = null, nStain = 0, chk = 0;
  const drops = [], meat = [], stainPos = [];
  const PARTS = 90;
  let pSeg = null, pTail = null, pHead = null, pEye = null, pCut = null;
  const parts = [];
  const BLOOD0 = [0.28, 0.005, 0.01], STAIN0 = new T.Color(0x5a0408);
  const rnd = (a, b) => a + Math.random() * (b - a);
  const tv2 = new T.Vector3(),
    bv2 = new T.Vector3(),
    tmpC = new T.Color(),
    m4 = new T.Matrix4(),
    q = new T.Quaternion(),
    nv = new T.Vector3(),
    sv = new T.Vector3(),
    pv = new T.Vector3();
  /* P87 (user 2026-10-12: "not some circles, looks like shit"): the stain is a SPATTER, not a disc: alpha of a teardrop
   * whose travel
   * axis is local +x: a ragged body with thin spikes at the back, a tapering tail forward (the drop's momentum), and
   * satellite droplets strung ahead of / around it. The instance is rotated so +x follows the impact direction
   * projected on the surface and stretched by the impact angle (grazing -> long), so a hit from above leaves a
   * near-round crown, a glancing one a long tailed streak. */
  function stainAlpha() {
    const N = 128, d = new Uint8Array(N * N * 4), sat = [];
    for (let i = 0; i < 11; i++) {
      const x = rnd(0.35, 0.98), sp = 0.1 + 0.3 * x;
      sat.push([x, rnd(-sp, sp), rnd(0.022, 0.06) * (1.2 - 0.5 * x)]);
    }
    for (let i = 0; i < 4; i++) {
      const a = rnd(0, 6.283), r = rnd(0.5, 0.75);
      sat.push([-0.35 + Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.5, rnd(0.02, 0.04)]);
    }
    const sm = (a, b, x) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    const ph = rnd(0, 6), ph2 = rnd(0, 6);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = (i + 0.5) / N * 2 - 1, y = (j + 0.5) / N * 2 - 1;
        const bx = (x + 0.35) / 0.4, by = y / 0.33, th = Math.atan2(by, bx), rn = Math.hypot(bx, by);
        const spike = Math.pow(Math.max(0, Math.sin(th * 9 + ph)), 10) * (bx < 0.3 ? 0.55 : 0.2);
        const rim = 1 + 0.1 * Math.sin(th * 5 + ph2) + 0.07 * Math.sin(th * 11 + ph) + spike;
        let k = sm(1.0, 0.88, rn / rim);
        const tx = (x + 0.1) / 0.9;                                                      // the tail: from the body's front along +x
        if (tx > 0 && tx < 1) {
          const w = 0.17 * Math.pow(1 - tx, 1.4) * (1 + 0.25 * Math.sin(tx * 12 + ph)) + 0.01;
          k = Math.max(k, sm(1.0, 0.7, Math.abs(y) / w) * (1 - tx * tx * 0.5));
        }
        for (const [sx, sy, sr] of sat) {
          const dd = Math.hypot(x - sx, y - sy);
          if (dd < sr * 1.4) k = Math.max(k, sm(sr * 1.4, sr * 0.8, dd) * 0.95);
        }
        // (three's alphaMap reads the GREEN channel: the old alpha-only texture made every stain a solid disc)
        const o = (j * N + i) * 4;
        d[o] = d[o + 1] = d[o + 2] = Math.round(k * 255);
        d[o + 3] = 255;
      }
    const t = new T.DataTexture(d, N, N, T.RGBAFormat);
    t.needsUpdate = true;
    t.magFilter = T.LinearFilter;
    t.minFilter = T.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    return t;
  }
  // stains / gibs follow the section view (user 2026-10-08: drops floated over the see-through context ground)
  const slab = m => (SS.view && SS.view.slabFade ? SS.view.slabFade(m, 0.45) : m);
  // the blood colour of a worm: its team colour when settings.teamBlood is on (rgb darkened for the wet look), else
  // null (the default red)
  function teamCol(S, w) {
    if (!S.settings.teamBlood || !w || w.team == null) return null;
    const rgb = SS.sim.team_rgb(S, w.team), r = ((rgb >> 16) & 255) / 255, g = ((rgb >> 8) & 255) / 255, b = (rgb & 255) / 255;
    return [r * 0.8, g * 0.8, b * 0.8];
  }
  BV.init = function (sc) {
    scene = sc;
    const g = new T.BufferGeometry();
    lp = new Float32Array(DROPS * 6); lc = new Float32Array(DROPS * 6);
    g.setAttribute('position', new T.BufferAttribute(lp, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('color', new T.BufferAttribute(lc, 3).setUsage(T.DynamicDrawUsage));
    lines = new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
    lines.frustumCulled = false; lines.renderOrder = 7; scene.add(lines);
    stains = new T.InstancedMesh(
      new T.PlaneGeometry(2, 2),
      slab(
        new T.MeshStandardMaterial({
          color: 0xffffff,
          roughness: 0.22,
          metalness: 0,
          alphaMap: stainAlpha(),
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -4
        })
      ),
      STAINS
    );
    stains.instanceMatrix.setUsage(T.DynamicDrawUsage);
    stains.setColorAt(0, STAIN0);
    stains.count = 0;
    stains.frustumCulled = false;
    stains.renderOrder = 2;
    scene.add(stains);
    gibs = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0), slab(new T.MeshStandardMaterial({ roughness: 0.45, metalness: 0 })), GIBS);
    gibs.instanceMatrix.setUsage(T.DynamicDrawUsage);
    gibs.count = 0;
    gibs.frustumCulled = false;
    gibs.castShadow = true;
    scene.add(gibs);
    gibs.setColorAt(0, new T.Color(0xffffff));
    const mkI = (geo, color, n, col) => {
      const m = new T.InstancedMesh(geo, slab(new T.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0 })), n);
      m.instanceMatrix.setUsage(T.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.castShadow = true;
      if (col) m.setColorAt(0, new T.Color(0xffffff));
      scene.add(m);
      return m;
    };
    pSeg = mkI(new T.CapsuleGeometry(0.5, 1, 4, 8), 0xffffff, PARTS, true);
    pTail = mkI(new T.ConeGeometry(0.5, 1, 8), 0xffffff, 8, true);
    pHead = mkI(new T.SphereGeometry(0.5, 10, 8), 0xffffff, 8, true);
    pEye = mkI(new T.SphereGeometry(0.5, 8, 6), 0xf8f8f8, 8, false);
    pCut = mkI(new T.SphereGeometry(0.5, 8, 6), 0x8a0c16, PARTS * 3, false);
  };
  BV.clear = function () {
    drops.length = 0;
    meat.length = 0;
    parts.length = 0;
    if (pSeg) { pSeg.count = pTail.count = pHead.count = pEye.count = pCut.count = 0; }
    stainPos.length = 0;
    runs.length = 0;
    nStain = 0;
    if (stains) stains.count = 0;
    if (gibs) gibs.count = 0;
  };
  // dir (user 2026-10-08): the hit's direction (blast -> worm, the bat / shot along its aim): the droplets fly in a
  // cone around it (hit from above: down onto the ground around the worm; from the front: out behind it, onto the
  // ground there); a few still scatter at random. No dir: the old all-round spray.
  function burst(x, y, z, n, sp, up, dir, col, life) {
    for (let k = 0; k < n; k++) {
      if (drops.length >= DROPS) drops.shift();
      let vx, vy, vz;
      const v = rnd(0.25, 1) * sp;
      if (dir && Math.random() < 0.85) {
        // a random direction within ~35 deg of dir (+ a little lift so a side hit arcs instead of skimming)
        const ux = dir.x + rnd(-0.6, 0.6),
          uy = dir.y + rnd(-0.45, 0.45) + 0.15,
          uz = dir.z + rnd(-0.6, 0.6),
          l = Math.hypot(ux, uy, uz) || 1;
        vx = ux / l * v * 1.3; vy = uy / l * v * 1.3; vz = uz / l * v * 1.3;
      } else {
        const a = Math.random() * 6.283, el = rnd(-0.3, 1.2) * (up ? 1 : 0.6), c = Math.cos(el);
        vx = Math.cos(a) * c * v; vy = Math.sin(el) * v; vz = Math.sin(a) * c * v;
      }
      drops.push({
        x: x + rnd(-0.1, 0.1),
        y: y + rnd(-0.1, 0.15),
        z: z + rnd(-0.1, 0.1),
        vx,
        vy,
        vz,
        life: life || 3,
        big: Math.random() < 0.3,
        col: col || null
      });
    }
  }
  const runs = [], stT0 = [], bx2 = new T.Matrix4(), tg = new T.Vector3(), bt = new T.Vector3();
  let clock = 0, recT = 0;
  /* (dx, dy, dz): the travel direction of whatever made it (drop velocity, ray); no direction: a random one. Steep
   * faces get a slowly running rivulet. */
  function stain(x, y, z, size, col, dx, dy, dz) {
    const W = SS.world, n = W.normal ? W.normal(x, y, z, {}) : { x: 0, y: 1, z: 0 };
    nv.set(-(n.x || 0), -(n.y || -1), -(n.z || 0));
    if (nv.lengthSq() < 1e-6) nv.set(0, 1, 0);
    nv.normalize();
    // the density gradient points into the rock: the stain faces out of it
    if (W.sample(x + nv.x * 0.3, y + nv.y * 0.3, z + nv.z * 0.3) > W.sample(x, y, z)) nv.negate();
    // P65b: a flat disc must lie on the ground over its whole rim: four rim points are tested against the surface plane
    // (air just above it, rock just below it); on a ridge, a rim or a step it shrinks (x0.6, twice), and where it still
    // hangs / sinks it is dropped
    {
      const W2 = SS.world, ay = Math.abs(nv.y) < 0.9 ? 1 : 0;
      tv2.set(ay ? 0 : 1, ay, 0).cross(nv).normalize();
      bv2.crossVectors(nv, tv2);
      let sc = 1, ok = false;
      for (let it = 0; it < 3 && !ok; it++) {
        let bad = 0;
        for (let k = 0; k < 4; k++) {
          const sg = k < 2 ? 1 : -1, ax = k & 1 ? tv2 : bv2, r = size * sc * 0.85 * sg;
          const rx = x + ax.x * r, ry = y + ax.y * r, rz = z + ax.z * r;
          if (
            W2.sample(rx + nv.x * 0.06, ry + nv.y * 0.06, rz + nv.z * 0.06) > 0
            || W2.sample(rx - nv.x * 0.08, ry - nv.y * 0.08, rz - nv.z * 0.08) <= 0
          ) bad++;
        }
        if (bad === 0 || (it === 2 && bad <= 1)) ok = true;
        else if (it < 2) sc *= 0.6;
      }
      if (!ok) return;
      size *= sc;
    }
    let st = 1, ln = Math.hypot(dx || 0, dy || 0, dz || 0);
    // the in-surface travel axis; the incidence sets the stretch (grazing -> long)
    if (ln > 1e-4) {
      const dn = (dx * nv.x + dy * nv.y + dz * nv.z) / ln;
      tg.set(dx / ln - nv.x * dn, dy / ln - nv.y * dn, dz / ln - nv.z * dn);
      st = 0.85 + 1.5 * (1 - Math.abs(dn)) * Math.min(1, ln / 4);
      if (tg.lengthSq() < 1e-6) {
        tg.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        tg.addScaledVector(nv, -tg.dot(nv));
      }
    } else {
      tg.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
      tg.addScaledVector(nv, -tg.dot(nv));
    }
    if (tg.lengthSq() < 1e-8) tg.set(1, 0, 0).addScaledVector(nv, -nv.x);
    tg.normalize();
    bt.crossVectors(nv, tg);
    bx2.makeBasis(tg, bt, nv); q.setFromRotationMatrix(bx2);
    const ox = size * 2.3 * st * 0.35;
    pv.set(x + nv.x * 0.015 + tg.x * ox, y + nv.y * 0.015 + tg.y * ox, z + nv.z * 0.015 + tg.z * ox);
    sv.set(size * 2.3 * st, size * 2.3 * rnd(0.75, 1) / Math.sqrt(st), 1);
    const i = nStain % STAINS;
    m4.compose(pv, q, sv);
    stains.setMatrixAt(i, m4);
    const sp = stainPos[i] = { x, y, z, nx: nv.x, ny: nv.y, nz: nv.z, s: size, c: col || null, t0: clock };
    stT0[i] = clock;
    tmpC.setRGB(col ? col[0] * 0.6 : 0.35, col ? col[1] * 0.6 : 0.02, col ? col[2] * 0.6 : 0.03);
    stains.setColorAt(i, tmpC);
    if (nv.y < 0.78 && size > 0.075 && runs.length < 40 && Math.random() < 0.6) {      // a rivulet runs down the steep face, very slowly
      tg.set(0, -1, 0).addScaledVector(nv, nv.y);
      if (tg.lengthSq() > 1e-4) {
        tg.normalize();
        runs.push({
          i,
          sp,
          x: x,
          y: y,
          z: z,
          dx: tg.x,
          dy: tg.y,
          dz: tg.z,
          nx: nv.x,
          ny: nv.y,
          nz: nv.z,
          size,
          t: 0,
          L: 0.25 + 3 * size,
          col: col || null
        });
      }
    }
    nStain++;
    stains.count = Math.min(STAINS, nStain);
    stains.instanceMatrix.needsUpdate = true;
    stains.instanceColor.needsUpdate = true;
  }
  // a burst worm: rays out in every direction stain what they meet (bigger close in)
  function splatRadial(x, y, z, dir, col, strong) {
    const W = SS.world;
    for (let k = 0; k < (strong ? 170 : 90); k++) {
      const u = Math.random() * 2 - 1, a = Math.random() * 6.283, s = Math.sqrt(1 - u * u);
      let dx = s * Math.cos(a), dy = u * 0.8 - 0.25, dz = s * Math.sin(a), reach = rnd(1.2, 4.2);
      // blown along the hit
      if (dir) {
        dx += dir.x * 1.4;
        dy += dir.y * 1.4;
        dz += dir.z * 1.4;
        const l = Math.hypot(dx, dy, dz) || 1;
        dx /= l;
        dy /= l;
        dz /= l;
        reach *= 1.3;
      }
      for (let d = 0.45; d < reach; d += 0.1) {
        const px = x + dx * d, py = y + dy * d, pz = z + dz * d;
        if (W.sample(px, py, pz) > 0) {
          stain(px, py, pz, (0.1 + 0.28 * (1 - d / reach)) * rnd(0.7, 1.2) * (strong ? 1.3 : 1), col, dx, dy, dz);
          break;
        }
      }
    }
  }
  const MEAT = [0xf2a0a8, 0xe68e98, 0x96141e, 0xc85a64, 0x780a12];
  function gibBurst(x, y, z, col, n, dir) {
    for (let i = 0; i < (n || 28); i++) {
      if (meat.length >= GIBS) meat.shift();
      const a = Math.random() * 6.283, v = rnd(2, 9), el = rnd(0.2, 1.3);
      let vx = Math.cos(a) * Math.cos(el) * v, vy = Math.sin(el) * v, vz = Math.sin(a) * Math.cos(el) * v;
      if (dir) {
        vx += dir.x * rnd(2, 7);
        vy += dir.y * rnd(2, 7);
        vz += dir.z * rnd(2, 7);
      }
      const c = col
        ? new T.Color().setRGB(col[0] * rnd(0.7, 1.4), col[1] * rnd(0.7, 1.4), col[2] * rnd(0.7, 1.4))
        : new T.Color(MEAT[i % MEAT.length]);
      meat.push({
        x,
        y: y + 0.2,
        z,
        vx,
        vy,
        vz,
        r: rnd(0.035, 0.085),
        c,
        col: col || null,
        t: 0,
        rest: false,
        rx: Math.random() * 6,
        ry: Math.random() * 6
      });
    }
  }
  /* ---------- the minigun's shredded worm: worm segments, a head with its eye, a tail tip, red mush ---------- */
  const SKIN = [0xf2a0a8, 0xe68e98, 0xf6b4ba, 0xdc8690];
  function shred(S, w, x, y, z, dir, col) {
    const d = dir || { x: 0, y: 0.2, z: 0 };
    const mk = (kind, n) => {
      for (let i = 0; i < n; i++) {
        if (parts.length >= PARTS) parts.shift();
        const a = Math.random() * 6.283, el = rnd(-0.1, 1.1), rs = rnd(1.5, 5.5), ds = rnd(2, 8);
        const L = kind === 0 ? rnd(0.12, 0.3) : kind === 1 ? rnd(0.3, 0.45) : 0,
          r = kind === 0 ? rnd(0.07, 0.12) : kind === 1 ? 0.11 : 0.17;
        parts.push({ kind, x: x + rnd(-0.15, 0.15), y: y + rnd(0, 0.35), z: z + rnd(-0.15, 0.15),
          vx: Math.cos(a) * Math.cos(el) * rs + d.x * ds, vy: Math.sin(el) * rs * 1.4 + rnd(1, 4) + d.y * ds * 0.5,
          vz: Math.sin(a) * Math.cos(el) * rs + d.z * ds,
          rx: rnd(0, 6), ry: rnd(0, 6), rz: rnd(0, 6), sx: rnd(-14, 14), sy: rnd(-14, 14), sz: rnd(-14, 14), L, r, t: 0, rest: false,
          col: col || null, c: new T.Color(SKIN[i % 4]) });
      }
    };
    mk(0, 11); mk(1, 1); mk(2, 1);
    gibBurst(x, y, z, col, 70, d);
    splatRadial(x, y, z, d, col, true);
    burst(x, y, z, 150, 10, true, d, col, 2.5);
  }
  const eulP = new T.Euler(), pv2 = new T.Vector3(), q2 = new T.Quaternion(), sc2 = new T.Vector3();
  function updateParts(S, dt) {
    const W = SS.world, G = 9.81;
    for (let i = parts.length - 1; i >= 0; i--) {
      const k = parts[i];
      k.t += dt;
      if (k.t > 45) {
        parts.splice(i, 1);
        continue;
      }
      if (!k.rest) {
        k.vy -= G * dt;
        const nx = k.x + k.vx * dt, ny = k.y + k.vy * dt, nz = k.z + k.vz * dt, rr = Math.max(0.05, k.r);
        if (W.sample(nx, ny - rr, nz) > 0) {
          if (Math.abs(k.vy) > 1.5 && Math.random() < 0.6) stain(k.x, k.y - rr, k.z, rnd(0.07, 0.15), k.col, k.vx, k.vy, k.vz);
          k.vy = -k.vy * 0.22;
          k.vx *= 0.5;
          k.vz *= 0.5;
          k.sx *= 0.4;
          k.sy *= 0.4;
          k.sz *= 0.4;
          if (Math.hypot(k.vx, k.vy, k.vz) < 0.5) k.rest = true;
        } else {
          k.x = nx;
          k.y = ny;
          k.z = nz;
          k.rx += k.sx * dt;
          k.ry += k.sy * dt;
          k.rz += k.sz * dt;
        }
        if (k.y < SS.sim.surface_at(S, k.x, k.z) - 0.3) {
          parts.splice(i, 1);
          continue;
        }
      } else if (W.sample(k.x, k.y - k.r - 0.05, k.z) <= 0) k.rest = false;
    }
    let ns = 0, nt = 0, nh = 0, nc = 0;
    for (const k of parts) {
      const fade = k.t > 40 ? Math.max(0.02, (45 - k.t) / 5) : 1;
      eulP.set(k.rx, k.ry, k.rz); q2.setFromEuler(eulP); pv2.set(k.x, k.y, k.z);
      if (k.kind === 0) {                                          // a segment: pink capsule, torn red ends
        sc2.set(k.r * 2 * fade, k.L * fade, k.r * 2 * fade);
        m4.compose(pv2, q2, sc2);
        pSeg.setMatrixAt(ns, m4);
        pSeg.setColorAt(ns, k.c);
        ns++;
        for (const sgn of [-1, 1]) {
          pv2.set(0, sgn * (k.L * 0.5 + k.r * 0.55) * fade, 0).applyQuaternion(q2).add(tv0.set(k.x, k.y, k.z));
          sc2.set(k.r * 1.7 * fade, k.r * 0.7 * fade, k.r * 1.7 * fade);
          m4.compose(pv2, q2, sc2);
          pCut.setMatrixAt(nc++, m4);
        }
      } else if (k.kind === 1) {
        sc2.set(k.r * 2 * fade, k.L * fade, k.r * 2 * fade);
        m4.compose(pv2, q2, sc2);
        pTail.setMatrixAt(nt, m4);
        pTail.setColorAt(nt, k.c);
        nt++;
      }
      else {                                                       // the head: a pink ball with its eye (and a torn red neck)
        sc2.set(k.r * 2 * fade, k.r * 1.8 * fade, k.r * 2 * fade);
        m4.compose(pv2, q2, sc2);
        pHead.setMatrixAt(nh, m4);
        pHead.setColorAt(nh, k.c);
        pv2.set(k.r * 0.55, k.r * 0.35, k.r * 0.75).applyQuaternion(q2).add(tv0.set(k.x, k.y, k.z));
        sc2.set(k.r * 0.7 * fade, k.r * 0.7 * fade, k.r * 0.7 * fade);
        m4.compose(pv2, q2, sc2);
        pEye.setMatrixAt(nh, m4);
        pv2.set(0, -k.r * 0.8, 0).applyQuaternion(q2).add(tv0.set(k.x, k.y, k.z));
        sc2.set(k.r * 1.5 * fade, k.r * 0.7 * fade, k.r * 1.5 * fade);
        m4.compose(pv2, q2, sc2);
        pCut.setMatrixAt(nc++, m4);
        nh++;
      }
    }
    pSeg.count = ns;
    pTail.count = nt;
    pHead.count = nh;
    pEye.count = nh;
    pCut.count = nc;
    for (const m of [pSeg, pTail, pHead, pEye, pCut]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
  }
  const tv0 = new T.Vector3();
  BV.onEvent = function (S, e) {
    if (!scene || !S.settings.blood) return;
    const col = teamCol(S, e.worm);
    if (e.type === 'hurt' && e.worm && e.amount >= 3 && !e.worm.dead && e.src !== SS.CFG.DS.MINIGUN && e.src !== SS.CFG.DS.SENTRY)
      burst(
        e.worm.pos.x,
        e.worm.pos.y + 0.1,
        e.worm.pos.z,
        Math.min(40, Math.round(e.amount * 1.4)),
        4 + e.amount * 0.12,
        true,
        e.dir,
        col
      );
    // P37-W3: one minigun round into a worm
    if (e.type === 'bloodhit') burst(e.x, e.y, e.z, 7, 4.5, true, { x: e.dx, y: e.dy, z: e.dz }, col, 1.6);
    if (e.type === 'gib') {
      if (e.worm && e.worm.mgKill != null && S.time - e.worm.mgKill < 0.6) shred(S, e.worm, e.x, e.y, e.z, e.dir, col);
      else {
        splatRadial(e.x, e.y, e.z, e.dir, col);
        gibBurst(e.x, e.y, e.z, col);
        burst(e.x, e.y, e.z, 90, 9, true, e.dir, col);
      }
    }
  };
  /* a rivulet: the stain's blob creeps down a steep face (decelerating, ~25 s), its tail stretching up behind it */
  function updateRuns(dt) {
    for (let r = runs.length - 1; r >= 0; r--) {
      const u = runs[r];
      u.t += dt;
      if (stainPos[u.i] !== u.sp || u.sp.s === 0 || u.t > 26) {
        runs.splice(r, 1);
        continue;
      }
      const tr = u.L * (1 - Math.exp(-u.t / 7)), sx = Math.max(u.size * 1.6, (tr + 0.8 * u.size) / 0.9), sy = u.size * 1.1 / (1 + 0.5 * tr);
      tg.set(-u.dx, -u.dy, -u.dz);
      nv.set(u.nx, u.ny, u.nz);
      bt.crossVectors(nv, tg);
      bx2.makeBasis(tg, bt, nv);
      q.setFromRotationMatrix(bx2);
      // centre = head - 0.35 sx downhill (blob sits at local -0.35)
      const c = tr - 0.35 * sx;
      pv.set(u.x + u.dx * c + nv.x * 0.015, u.y + u.dy * c + nv.y * 0.015, u.z + u.dz * c + nv.z * 0.015);
      sv.set(sx, sy * 1.6, 1);
      m4.compose(pv, q, sv);
      stains.setMatrixAt(u.i, m4);
      stains.instanceMatrix.needsUpdate = true;
    }
    recT -= dt;
    if (recT <= 0) {                                                             // fresh blood is bright, then browns and darkens (60 s)
      recT = 0.5;
      let any = false;
      for (let i = 0; i < stainPos.length; i++) {
        const sp = stainPos[i];
        if (!sp || sp.s === 0) continue;
        const a = clock - sp.t0;
        if (a > 62) continue;
        const k = Math.min(1, a / 60), f = 1 - 0.55 * k, b = sp.c || BLOOD_S;
        tmpC.setRGB(b[0] * 0.6 * f * (1 + 0.5 * (1 - k)), b[1] * 0.6 * f * (1 + 0.5 * (1 - k)) + 0.01 * k, b[2] * 0.6 * f);
        stains.setColorAt(i, tmpC);
        any = true;
      }
      if (any) stains.instanceColor.needsUpdate = true;
    }
  }
  const BLOOD_S = [0.58, 0.035, 0.05];
  BV.frame = function (S, dt) {
    if (!scene) return;
    const W = SS.world, G = 9.81;
    let n = 0;
    clock += dt;
    updateRuns(dt);
    for (let i = drops.length - 1; i >= 0; i--) {
      const b = drops[i];
      b.life -= dt;
      b.vy -= G * dt;
      const k = 1 - 0.6 * dt;
      b.vx *= k;
      b.vz *= k;
      const nx = b.x + b.vx * dt, ny = b.y + b.vy * dt, nz = b.z + b.vz * dt;
      if (b.life <= 0 || ny < SS.sim.surface_at(S, nx, nz)) {
        drops.splice(i, 1);
        continue;
      }
      if (W.sample(nx, ny, nz) > 0) {
        const sz = b.big ? rnd(0.07, 0.12) : rnd(0.035, 0.065);
        stain(b.x, b.y, b.z, sz, b.col, b.vx, b.vy, b.vz);
        // a satellite droplet ahead
        if (b.big && Math.random() < 0.5) {
          const sp = Math.hypot(b.vx, b.vz) || 1, o = sz * rnd(2.2, 3.4);
          stain(b.x + b.vx / sp * o, b.y, b.z + b.vz / sp * o, sz * 0.3, b.col, b.vx, b.vy, b.vz);
        }
        drops.splice(i, 1); continue;
      }
      b.x = nx; b.y = ny; b.z = nz;
    }
    for (const b of drops) {
      const o = n * 6, L = 0.025;
      lp[o] = b.x;
      lp[o + 1] = b.y;
      lp[o + 2] = b.z;
      lp[o + 3] = b.x - b.vx * L;
      lp[o + 4] = b.y - b.vy * L;
      lp[o + 5] = b.z - b.vz * L;
      const c = b.col || BLOOD0;
      lc[o] = c[0];
      lc[o + 1] = c[1];
      lc[o + 2] = c[2];
      lc[o + 3] = c[0] * 0.57;
      lc[o + 4] = c[1] * 0.57;
      lc[o + 5] = c[2] * 0.57;
      n++;
    }
    lines.geometry.setDrawRange(0, n * 2);
    lines.geometry.attributes.position.needsUpdate = true;
    lines.geometry.attributes.color.needsUpdate = true;
    // meat chunks: bounce, roll to a stop, fade after ~30 s
    let gN = 0;
    for (let i = meat.length - 1; i >= 0; i--) {
      const m = meat[i];
      m.t += dt;
      if (m.t > 32) {
        meat.splice(i, 1);
        continue;
      }
      if (!m.rest) {
        m.vy -= G * dt;
        const nx = m.x + m.vx * dt, ny = m.y + m.vy * dt, nz = m.z + m.vz * dt;
        if (W.sample(nx, ny - m.r, nz) > 0) {
          if (Math.abs(m.vy) > 1.5 && Math.random() < 0.5) stain(m.x, m.y - m.r, m.z, rnd(0.05, 0.1), m.col, m.vx, m.vy, m.vz);
          m.vy = -m.vy * 0.25; m.vx *= 0.55; m.vz *= 0.55;
          if (Math.hypot(m.vx, m.vy, m.vz) < 0.4) m.rest = true;
        } else {
          m.x = nx;
          m.y = ny;
          m.z = nz;
          m.rx += dt * 6;
          m.ry += dt * 4;
        }
        if (m.y < SS.sim.surface_at(S, m.x, m.z) - 0.3) {
          meat.splice(i, 1);
          continue;
        }
      } else if (W.sample(m.x, m.y - m.r - 0.05, m.z) <= 0) m.rest = false;      // the ground under it is gone
    }
    for (const m of meat) {
      const s = m.r * (m.t > 28 ? Math.max(0.01, (32 - m.t) / 4) : 1);
      q.setFromEuler(new T.Euler(m.rx, m.ry, 0));
      pv.set(m.x, m.y, m.z);
      sv.set(s, s * 0.8, s * 1.1);
      m4.compose(pv, q, sv);
      gibs.setMatrixAt(gN, m4); gibs.setColorAt(gN, m.c); gN++;
    }
    gibs.count = gN;
    gibs.instanceMatrix.needsUpdate = true;
    if (gibs.instanceColor) gibs.instanceColor.needsUpdate = true;
    updateParts(S, dt);
    // stains on ground that was blown away disappear (a few checks per frame)
    for (let k = 0; k < 24 && stainPos.length; k++) {
      chk = (chk + 1) % stainPos.length;
      const p = stainPos[chk];
      if (p && p.s > 0 && W.sample(p.x - p.nx * 0.12, p.y - p.ny * 0.12, p.z - p.nz * 0.12) <= 0) {
        p.s = 0;
        m4.makeScale(0, 0, 0);
        stains.setMatrixAt(chk, m4);
        stains.instanceMatrix.needsUpdate = true;
      }
    }
  };
})(window.SS = window.SS || {});
