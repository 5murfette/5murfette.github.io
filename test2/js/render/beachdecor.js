/* render/beachdecor.js (P116) — decor kit pieces of the beach biome, added to SS.decorKit.GF (render/clutter.js places them, see DEC / decorKinds there):
 *   jbush   a dense dome of leafy blobs (the green bushes of the photo), dark olive greens
 *   bigleaf a broadleaf plant (banana / heliconia style): 5-7 big arching oval leaves from one base, a midrib fold, glossy
 *   coconut a fallen coconut / husk
 * Same conventions as render/decorkit.js: base at y = 0, vertex colours in sRGB intent, per-vertex `tl` (atlas tiles, -1 = tint only). Presentation only. */
(function (SS) {
  'use strict';
  const K = SS.decorKit; if (!K || !K.B) return;
  const THREE = window.THREE, B = K.B, M = SS.math, TAU = 6.2832;
  const h3 = (a, b, c) => M.hash3(a * 13 + 1, b * 7 + 3, c * 5 + 2);
  /* a dense leafy bush: ~64 alpha leaf-clump cards (tx.foliage) over a dome, facing out, rolled at random, dark inside / bright outside (vertex colours); the clutter
   * material gives it the chroma-keyed foliage texture (MK.jleaf). Positions in metres (base at y = 0). */
  function jbushGeo() {
    const pos = [], col = [], uv = [], nr = [], N = 64, ga = 2.399963;
    for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N, y = 0.06 + 0.94 * Math.sqrt(u) * (0.35 + 0.65 * h3(i, 5, 1)), rad = Math.sqrt(Math.max(0, 1 - y * y)), th = i * ga + 0.6 * h3(i, 2, 1);
      const dx = Math.cos(th) * rad, dy = y, dz = Math.sin(th) * rad, d = 0.34 + 0.12 * h3(i, 3, 1);
      const cx = dx * d * 1.35, cy = 0.04 + dy * d * 0.72, cz = dz * d * 1.35, s = 0.3 + 0.18 * h3(i, 4, 1);
      // card basis: facing (dx, dy, dz), rolled
      let ux = 0, uy = 1, uz = 0; if (Math.abs(dy) > 0.9) { ux = 1; uy = 0; }
      let e1x = uy * dz - uz * dy, e1y = uz * dx - ux * dz, e1z = ux * dy - uy * dx; const l1 = Math.hypot(e1x, e1y, e1z) || 1; e1x /= l1; e1y /= l1; e1z /= l1;
      const e2x = dy * e1z - dz * e1y, e2y = dz * e1x - dx * e1z, e2z = dx * e1y - dy * e1x, ro = h3(i, 6, 1) * 6.28, cr = Math.cos(ro), sr = Math.sin(ro);
      const ax = e1x * cr + e2x * sr, ay = e1y * cr + e2y * sr, az = e1z * cr + e2z * sr, bx = -e1x * sr + e2x * cr, by = -e1y * sr + e2y * cr, bz = -e1z * sr + e2z * cr;
      const k = 0.5 + 0.5 * Math.min(1, dy * 0.8 + d), c = [(0.8 + 0.2 * h3(i, 7, 1)) * k, (0.9 + 0.1 * h3(i, 8, 1)) * k, 0.7 * k];
      const nx = dx * 0.7, ny = dy * 0.7 + 0.3, nz = dz * 0.7, nl = Math.hypot(nx, ny, nz);
      const P = (a, b2) => [cx + (ax * (a - 0.5) + bx * (b2 - 0.5)) * s, cy + (ay * (a - 0.5) + by * (b2 - 0.5)) * s, cz + (az * (a - 0.5) + bz * (b2 - 0.5)) * s];
      const q = [[0, 0], [1, 0], [0, 1], [1, 1]];
      for (const t of [[0, 1, 2], [2, 1, 3]]) for (const v of t) { const p = P(q[v][0], q[v][1]); pos.push(p[0], Math.max(0.0, p[1]), p[2]); uv.push(q[v][0], q[v][1]); col.push(c[0], c[1], c[2]); nr.push(nx / nl, ny / nl, nz / nl); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nr, 3));
    return g;
  }
  function bigleafGeo() {
    const b = B.mk(); b.A = -1; b.B = -1;
    const nl = 6;
    for (let l = 0; l < nl; l++) {
      const az = l / nl * TAU + h3(l, 1, 2) * 0.7, L = 0.95 * (0.75 + 0.4 * h3(l, 2, 2)), W0 = 0.22 * (0.8 + 0.4 * h3(l, 3, 2)), el0 = 0.95 - 0.4 * h3(l, 4, 2), ca = Math.cos(az), sa = Math.sin(az);
      const sx = -sa, sz = ca, SG = 5, rows = [];
      let px = 0, py = 0.05, pz = 0;
      for (let s = 0; s <= SG; s++) {
        const t = s / SG, el = el0 - 1.2 * t;
        if (s) { px += Math.cos(el) * ca * L / SG; py += Math.sin(el) * L / SG; pz += Math.cos(el) * sa * L / SG; }
        rows.push({ p: [px, py, pz], w: W0 * Math.sin(Math.min(1, 0.18 + t * 0.95) * 3.1416) * (1 - 0.25 * t), t });
      }
      const edge = (r, side) => [r.p[0] + sx * r.w * side, r.p[1] - 0.28 * r.w, r.p[2] + sz * r.w * side];
      const col = r => B.mixc([0.08, 0.26, 0.05], [0.22, 0.46, 0.1], 0.35 + 0.5 * r.t);
      for (let s = 0; s < SG; s++) {
        const r0 = rows[s], r1 = rows[s + 1];
        B.quad(b, edge(r0, -1), edge(r1, -1), r1.p, r0.p, col(r0), col(r1), col(r1), col(r0));
        B.quad(b, r0.p, r1.p, edge(r1, 1), edge(r0, 1), col(r0), col(r1), col(r1), col(r0));
      }
    }
    return B.fin(b, true);
  }
  function coconutGeo() {
    const b = B.mk(); b.A = B.TILE.bark; b.B = -1;
    B.blob(b, 0, 0.1, 0, 0.14, 0.12, 0.12, 2, 0.12, 5, v => [0.38 + 0.1 * v[3], 0.26 + 0.08 * v[3], 0.14], { flat: -0.2 });
    return B.fin(b);
  }
  K.GF.jbush = jbushGeo; K.GF.bigleaf = bigleafGeo; K.GF.coconut = coconutGeo;
})(window.SS = window.SS || {});
