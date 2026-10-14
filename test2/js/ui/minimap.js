/* ui/minimap.js — the HUD's two maps. The section map: the cut through the terrain along the section with the worms
 * (on the section: dots; off it: ticks in the gutter below), the shells in flight and the rope; its base is rebuilt
 * when the section is (a new S.section record) or the lava / water along it moved enough. The top map: the plan of
 * the map (the 1 m heightmap shaded by its slope, the ground's materials and grass; underground an x-ray of the caves
 * at the active worm's level; the dry world's play circle), the visible slab, the camera's side, the warning arrows
 * of the map's mines, the worms. Reads the sim state and the view's plan (the view API of SS.ui.init).
 * C: two textures the engine's UI draws, rebuilt on the same versions. */
(function (SS) {
  'use strict';
  const C = SS.CFG, P = SS.plane, M = SS.math, css = C.css;
  const MM = SS.minimap = {};
  const $ = id => document.getElementById(id);
  let view = null, secC = null, secX = null, secBase = null, topC = null, topX = null, topBase = null, topVer = -1, secFor = null;
  let underOpen = null, underVer = -1, underLevel = 5, lavaVer = 0, waterVer = 0;

  /* the section map's base: the cut along the section, one pixel per 0.5 m sample (solid, the grass edge, open lava,
   * water, the sky) */
  function sectionBase(S) {
    secFor = S.section;
    const { ns, ny, V } = S.section;
    secBase.width = ns; secBase.height = ny;
    const bx = secBase.getContext('2d'), img = bx.createImageData(ns, ny), sea = SS.world.SEA;
    // open lava (sim/lava.js layer) along the section: surface height per section column (-1 = none)
    const lavaY = new Float32Array(ns).fill(-1), d = SS.plane.dir(S);
    if (SS.lava && S.lava)
      for (let i = 0; i < ns; i++) {
        const s = S.section.s0 + i * 0.5;
        lavaY[i] = SS.lava.surface_at(S, S.O.x + s * d.x, S.O.z + s * d.z);
      }
    lavaVer = S.lava ? S.lava.ver : 0;
    // water surface along the section (sim/water.js; -99 = dry), else the still sea level
    const waterY = new Float32Array(ns).fill(sea);
    if (SS.water && S.water)
      for (let i = 0; i < ns; i++) {
        const s = S.section.s0 + i * 0.5;
        waterY[i] = SS.water.surface(S, S.O.x + s * d.x, S.O.z + s * d.z);
      }
    waterVer = S.water ? S.water.ver : 0;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < ns; i++) {
        const v = V[j * ns + i], o = ((ny - 1 - j) * ns + i) * 4, y = j * 0.5;
        const above = V[Math.min(ny - 1, j + 1) * ns + i];
        let r, g, b;
        if (v > 0) {
          const m = S.section.M[j * ns + i];
          if (m === C.MAT.LAVA) {
            r = 255;
            g = 110;
            b = 30;
          }
          else if (v < 0.6 && above <= 0) {
            r = 118;
            g = 186;
            b = 84;
          }
          else {
            r = 168 + (j % 6) * 5 - Math.min(40, v * 6);
            g = 120 + (j % 6) * 4;
            b = 82;
          }
        } else if (y < lavaY[i]) {
          r = 255;
          g = 120;
          b = 36;
        }
        else if (y < waterY[i]) {
          r = 40;
          g = 96;
          b = 140;
        }
        else {
          const k = j / ny;
          r = 24 + k * 20;
          g = 38 + k * 30;
          b = 58 + k * 40;
        }
        const D = img.data;
        D[o] = r;
        D[o + 1] = g;
        D[o + 2] = b;
        D[o + 3] = 255;
      }
    bx.putImageData(img, 0, 0);
  }
  function drawSectionMap(S) {
    if (!S.section) return;
    const { s0, s1 } = S.section, len = s1 - s0, Wd = 320, sc = Wd / len, Hh = Math.round(40 * sc);
    if (secC.height !== Hh + 16) secC.height = Hh + 16;
    const x = secX;
    x.imageSmoothingEnabled = false;
    x.clearRect(0, 0, Wd, secC.height); x.drawImage(secBase, 0, 0, Wd, Hh);
    const Pp = (s, y) => [(s - s0) * sc, Hh - y * sc];
    for (const w of S.worms) {
      if (w.dead) continue;
      const pp = P.to_plane(S, w.pos), q = Pp(pp.s, w.pos.y), tc = css(C.TEAMS[w.team].rgb);
      if (view.inSlab(S, w.pos) || w === S.active) {
        x.fillStyle = tc;
        x.beginPath();
        x.arc(q[0], q[1], 3.4, 0, 7);
        x.fill();
        if (w === S.active) {
          x.strokeStyle = '#fff';
          x.lineWidth = 1.5;
          x.beginPath();
          x.arc(q[0], q[1], 6, 0, 7);
          x.stroke();
        }
      } else if (q[0] >= 0 && q[0] <= Wd) {
        // off-section worms: hollow ticks in the gutter below the map, never drawn on playable terrain
        x.strokeStyle = tc;
        x.lineWidth = 1.5;
        x.beginPath();
        x.moveTo(q[0], Hh + 3);
        x.lineTo(q[0] - 4, Hh + 11);
        x.lineTo(q[0] + 4, Hh + 11);
        x.closePath();
        x.stroke();
      }
    }
    for (const p of S.proj) {
      const q = Pp(p.s, p.y);
      x.fillStyle = '#fff';
      x.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3);
    }
    if (S.rope && S.active) {
      const ap = P.to_plane(S, S.active.pos), A = Pp(ap.s, S.active.pos.y), B = Pp(S.rope.s, S.rope.y);
      x.strokeStyle = '#ffe08a';
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(A[0], A[1]);
      x.lineTo(B[0], B[1]);
      x.stroke();
    }
    x.fillStyle = '#e8eef5';
    x.fillRect(Wd - 10 * sc - 8, 8, 10 * sc, 2);
    x.font = '10px system-ui,sans-serif';
    x.fillText('10 m', Wd - 10 * sc - 8, 20);
  }

  function buildTopBase(S) {
    const vs = view.plan(), H = vs.heightmap, W = SS.world, n = W.SX + 1, sea = W.SEA, surf = vs.surf, sn = vs.surfN;
    topBase.width = n; topBase.height = n;
    const bx = topBase.getContext('2d'), img = bx.createImageData(n, n);
    // underground: an x-ray plan of the caves, the active worm's level bright
    if (W.under) {
      const ya = underLevel * 3, L = Math.ceil(W.SY - 2.5);
      // open (air) samples per column at y = 1.5, 2.5, ... (one terrain scan per heightVer, not per level change)
      if (underVer !== vs.heightVer || !underOpen) {
        underOpen = new Uint8Array(n * n * L); underVer = vs.heightVer;
        for (let k = 0; k < n; k++)
          for (let i = 0; i < n; i++) {
            const x = Math.min(W.SX, i), z = Math.min(W.SZ, k), o = (k * n + i) * L;
            for (let l = 0; l < L; l++) underOpen[o + l] = W.sample(x, 1.5 + l, z) <= 0 ? 1 : 0;
          }
      }
      for (let k = 0; k < n; k++)
        for (let i = 0; i < n; i++) {
          const q = (k * n + i) * L;
          let any = false, lev = false;
          for (let l = 0; l < L; l++)
            if (underOpen[q + l]) {
              any = true;
              if (Math.abs(1.5 + l - ya) < 3) {
                lev = true;
                break;
              }
            }
          const c = lev ? [205, 192, 168] : any ? [96, 86, 76] : [34, 30, 28], o = (k * n + i) * 4;
          img.data[o] = c[0];
          img.data[o + 1] = c[1];
          img.data[o + 2] = c[2];
          img.data[o + 3] = 255;
        }
      bx.putImageData(img, 0, 0);
      return;
    }
    for (let k = 0; k < n; k++)
      for (let i = 0; i < n; i++) {
        const h = H[k * n + i];
        // hill shading from the heightmap gradient
        const hx = H[k * n + Math.min(n - 1, i + 1)] - H[k * n + Math.max(0, i - 1)],
          hz = H[Math.min(n - 1, k + 1) * n + i] - H[Math.max(0, k - 1) * n + i];
        const shade = M.clamp(1 - (hx * 0.5 + hz * 0.35) * 0.12, 0.6, 1.3);
        let cr, cg, cb;                                          // (scalars: this loop ran once per map pixel with array literals)
        // (a map pixel is 1 m) beyond the dry world's disc
        const cc = W.circ, far = cc && Math.hypot(i - cc.x, k - cc.z) > cc.r;
        if (h < sea) {
          cr = 34;
          cg = 88;
          cb = 132;
        }
        else if (far) {                                         // the far dunes: plain sand, a little dimmer (not destructible)
          const rgb = C.MATS[C.MAT.SAND].rgb, lift = 0.72 + h * 0.012;
          cr = ((rgb >> 16) & 255) * lift;
          cg = ((rgb >> 8) & 255) * lift;
          cb = (rgb & 255) * lift;
        } else {
          const ci = Math.min(W.NX - 1, i * 2), ck = Math.min(W.NZ - 1, k * 2), j = W.topJ[ck * W.NX + ci];
          const m = j >= 0 ? W.mat[(ck * W.NY + j) * W.NX + ci] : 0, rgb = C.MATS[m].rgb;
          cr = (rgb >> 16) & 255; cg = (rgb >> 8) & 255; cb = rgb & 255;
          if (surf) {
            const so = (Math.min(sn - 1, ck) * sn + Math.min(sn - 1, ci)) * 4, g = surf[so] / 255, dry = surf[so + 1] / 255;
            cr = cr * (1 - g) + (96 + dry * 90) * g;
            cg = cg * (1 - g) + (140 + dry * 30) * g;
            cb = cb * (1 - g) + 60 * g;
          }
          const lift = 0.85 + h * 0.012;
          cr *= lift;
          cg *= lift;
          cb *= lift;
        }
        const o4 = (k * n + i) * 4, D = img.data;
        D[o4] = cr * shade;
        D[o4 + 1] = cg * shade;
        D[o4 + 2] = cb * shade;
        D[o4 + 3] = 255;
      }
    bx.putImageData(img, 0, 0);
  }
  function drawTopMap(S) {
    // (no plan view of a one-slice 2D map)
    const fig = topC.parentNode, hide = !!SS.world.flat;
    if (fig && fig.style && (fig.style.display === 'none') !== hide) fig.style.display = hide ? 'none' : '';
    if (document.body.classList.contains('flat') !== hide) document.body.classList.toggle('flat', hide);
    if (hide) return;
    const vs = view.plan();
    if (!vs.heightmap) return;
    // underground: the worm's level in 3 m bands, with hysteresis (a worm bobbing at a band edge does not flicker the
    // map)
    if (SS.world.under && S.active) {
      const f = S.active.pos.y / 3;
      if (Math.abs(f - underLevel) > 0.7) underLevel = Math.round(f);
    }
    // terrain / surface changed (underground: the worm's level)
    const tv = vs.heightVer * 65536 + (vs.surfUploads | 0) + (SS.world.under ? underLevel * 7919 : 0);
    if (topVer !== tv) {
      buildTopBase(S);
      topVer = tv;
    }
    const x = topX, Z = topC.width, sc = Z / SS.world.SX, n = P.nrm(S);
    x.imageSmoothingEnabled = true; x.drawImage(topBase, 0, 0, Z, Z);
    const L = 140, ox = S.O.x * sc, oz = S.O.z * sc;
    if (SS.world.dry) {                                       // play area of a dry world: beyond it the sand is hot
      x.strokeStyle = 'rgba(255,140,60,0.85)'; x.lineWidth = 1.5; x.setLineDash([4, 3]);
      x.beginPath();
      x.arc(C.DRY.CX * sc, C.DRY.CZ * sc, S.playR * sc, 0, 7);
      x.stroke();
      x.setLineDash([]);
      // the edge of the destructible disc
      x.strokeStyle = 'rgba(70,40,20,0.45)'; x.lineWidth = 1;
      x.beginPath(); x.arc(C.DRY.CX * sc, C.DRY.CZ * sc, C.DRY.LAT_R * sc, 0, 7); x.stroke();
    }
    x.save(); x.translate(ox, oz); x.rotate(S.theta);
    // visible slab: from slice zero (t = 0) back to -uBack (rotated frame: +y = plane normal = camera side)
    const bk = Math.min(L, view.back());
    x.fillStyle = 'rgba(255,243,176,0.35)'; x.fillRect(-L * sc, -bk * sc, 2 * L * sc, bk * sc);
    x.strokeStyle = 'rgba(255,243,176,0.9)'; x.lineWidth = 1; x.strokeRect(-L * sc, -bk * sc, 2 * L * sc, bk * sc);
    x.fillStyle = '#fff3b0';
    x.beginPath();
    x.moveTo(Z * 0.42, 0);
    x.lineTo(Z * 0.36, -5);
    x.lineTo(Z * 0.36, 5);
    x.fill();
    x.restore();
    x.fillStyle = 'rgba(255,255,255,0.7)';
    x.beginPath();
    x.arc(ox + n.x * 10 * sc, oz + n.z * 10 * sc, 2.5, 0, 7);
    x.fill();
    // the map's mines: flickering red arrows while they are still unburied, then gone
    if (S.mapMinesUntil >= 0 && S.time < S.mapMinesUntil && Math.sin(S.time * 9) > -0.2) {
      x.fillStyle = '#ff3b30';
      for (const b of S.bodies)
        if (b.prop === 'mine' && b.team === -1 && !b.disarmed) {
          const mx = b.pos.x * sc, mz = b.pos.z * sc;
          x.beginPath();
          x.moveTo(mx, mz);
          x.lineTo(mx - 4, mz - 8);
          x.lineTo(mx + 4, mz - 8);
          x.closePath();
          x.fill();
        }
    }
    for (const w of S.worms) {
      if (w.dead) continue;
      const px = w.pos.x * sc, pz = w.pos.z * sc, inSec = view.inSlab(S, w.pos);
      x.fillStyle = css(C.TEAMS[w.team].rgb); x.globalAlpha = inSec || w === S.active ? 1 : 0.8;
      x.beginPath();
      x.arc(px, pz, w === S.active ? 4.5 : 3.5, 0, 7);
      x.fill();
      x.globalAlpha = 1;
      if (w === S.active) {
        x.strokeStyle = '#fff';
        x.lineWidth = 2;
        x.beginPath();
        x.arc(px, pz, 7, 0, 7);
        x.stroke();
      }
      if (w === S.target) {
        x.strokeStyle = '#ffe14a';
        x.lineWidth = 1.5;
        x.beginPath();
        x.arc(px, pz, 7, 0, 7);
        x.stroke();
      }
    }
    x.fillStyle = '#e8eef5'; x.font = 'bold 10px system-ui,sans-serif'; x.fillText('N', Z / 2 - 3, 11);
  }

  /* a click on the top map: the nearest other worm within 9 px (the camera turns to it), or null */
  MM.pick = function (S, e) {
    const r = topC.getBoundingClientRect(), sc = topC.width / SS.world.SX;
    const mx = (e.clientX - r.left) * topC.width / r.width, mz = (e.clientY - r.top) * topC.height / r.height;
    let best = null, bd = 9;
    for (const w of S.worms)
      if (!w.dead && w !== S.active) {
        const dd = Math.hypot(w.pos.x * sc - mx, w.pos.z * sc - mz);
        if (dd < bd) {
          bd = dd;
          best = w;
        }
      }
    return best;
  };

  // v: the view API (inSlab, plan, back)
  MM.init = function (v) {
    view = v;
    secC = $('secmap');
    secX = secC.getContext('2d');
    secBase = document.createElement('canvas');
    topC = $('topmap');
    topX = topC.getContext('2d');
    topBase = document.createElement('canvas');
  };
  MM.draw = function (S) {
    // the lava layer moves slowly: the section base follows it every ~2 s of sim time while it changes
    if (S.section && (S.section !== secFor || (S.lava && S.lava.ver - lavaVer >= 20) || (S.water && S.water.ver - waterVer >= 15)))
      sectionBase(S);
    drawSectionMap(S);
    drawTopMap(S);
  };
})(window.SS = window.SS || {});
