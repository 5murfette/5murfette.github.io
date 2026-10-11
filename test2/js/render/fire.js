/* render/fire.js — the heat FIELD of the burning ground (P37-W3, P45). The burning patches of the sim (S.flames: napalm, oil rings, car wrecks,
 * the flamethrower's gel) and the burning grass / bush cells (S.veg) are no longer drawn as separate flames each: their heat is summed
 * into one smooth FIELD on a ground grid (cell 0.45 m, a quadratic falloff of each patch's radius), and a flame SOURCE is submitted to
 * the fire system (render/flame.js) on every cell where the summed heat is high enough: the source's height grows with the heat
 * (sqrt: a dense core of merged patches towers over the thin edge), its radius overlaps the neighbours' so adjacent cells blend into
 * ONE continuous sheet of flame; two patches that come close simply add their fields. At most MAXC cells: past that the cell grows
 * (x 1.35 per pass) so a huge fire stays cheap. Presentation only (no sim state touched, no Math.random).
 * API: emit(S): submits the sources (SS.flameView.src), stats().
 * Porting: feed the same heat field to a GPU particle / volume emitter. */
(function (SS) {
  'use strict';
  const FV = SS.fireView = {};
  const MAXC = 170, CELL0 = 0.45, FADE = 1.2;
  const grid = new Map();
  let last = { cells: 0, cell: CELL0, flames: 0 };
  const hash = (a, b) => { let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  FV.emit = function (S) {
    const FLv = SS.flameView; if (!FLv) return;
    const fl = S.flames, V = S.veg, W = SS.world, nG = V && V.nAct > 0 ? V.nAct : 0;
    if ((!fl || !fl.length) && !nG) { last.cells = 0; last.flames = 0; return; }
    let cell = CELL0;
    for (let pass = 0; pass < 4; pass++) {
      grid.clear();
      if (fl) for (const f of fl) {
        const left = f.t1 - S.time; if (left <= 0) continue;
        const k = Math.min(1, left / FADE), re = f.r * 1.25 + cell * 0.5, re2 = re * re;
        const i0 = Math.floor((f.x - re) / cell), i1 = Math.floor((f.x + re) / cell), k0 = Math.floor((f.z - re) / cell), k1 = Math.floor((f.z + re) / cell);
        for (let iz = k0; iz <= k1; iz++) for (let ix = i0; ix <= i1; ix++) {
          const dx = (ix + 0.5) * cell - f.x, dz = (iz + 0.5) * cell - f.z, d2 = dx * dx + dz * dz;
          if (d2 >= re2) continue;
          const q = 1 - d2 / re2, e = k * q * q * 1.4, key = (ix + 4096) * 8192 + (iz + 4096);
          let c = grid.get(key);
          if (!c) { c = { ix, iz, E: 0, Y: 0, S: 0 }; grid.set(key, c); }
          c.E += e; c.Y += f.y * e; c.S += 0.95 * e;
        }
      }
      if (nG) {                                                                    // burning grass / bushes: low, light flames, thin grey smoke
        const n = V.n, H = W.H, top = W.top, gk = 0.5;
        for (let a = 0; a < nG; a++) {
          const c0 = V.act[a]; if (!(V.burnT[c0] > 0)) continue;
          const e = V.burnI[c0] * Math.min(1, V.burnT[c0] / 0.8) * gk, x = (c0 % n) * H, z = ((c0 / n) | 0) * H;
          if (FV.vis && !FV.vis(x, z)) continue;
          const ix = Math.floor(x / cell), iz = Math.floor(z / cell), key = (ix + 4096) * 8192 + (iz + 4096);
          let c = grid.get(key);
          if (!c) { c = { ix, iz, E: 0, Y: 0, S: 0 }; grid.set(key, c); }
          c.E += e; c.Y += top[c0] * e; c.S += 0.35 * e;
        }
      }
      if (grid.size <= MAXC) break;
      cell *= 1.35;
    }
    let n = 0;
    for (const c of grid.values()) {
      if (c.E < 0.12) continue;
      const E = c.E, x = (c.ix + 0.5) * cell, z = (c.iz + 0.5) * cell, sd = hash(c.ix, c.iz);
      let y = c.Y / E; const top = W.top_at(x, z); if (top > -1e8 && Math.abs(top - y) < 1.2) y = top;
      const h = (0.45 + 1.15 * Math.sqrt(Math.min(E, 2.4))) * (0.9 + 0.2 * sd), rr = cell * (0.9 + 0.25 * Math.min(E, 1.5));
      FLv.src(x, y - 0.05, z, rr, h, Math.min(1.45, 0.6 + 0.55 * E), c.S / E, Math.min(1, E * 0.8)); n++;
    }
    last.cells = n; last.cell = cell; last.flames = fl ? fl.length : 0;
  };
  FV.stats = () => last;
})(window.SS = window.SS || {});
