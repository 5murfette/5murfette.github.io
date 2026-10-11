/* render/softview.js — P39 J1: glue between the game and the soft-body worm solver (js/core/softworm.js).
 * The sim worm (disc, position, velocity, damage) stays the authority; each worm's visual body is a jelly chain (v.sw, SS.softworm) driven by it:
 *   - update(S, w, v, sp, c): once per worm and frame. sp = the muscle GOAL spine (actors.js spine(): the animator's pose at NS samples), c = the
 *     context (facing, slope, flight, water, rope, salto ...). Sets the solver inputs, advances it by the frame time (fixed sub-steps inside),
 *     and returns the LIVE spine (body-local x, y, tangent angle a, radius r at NS samples) the tube mesh is built from. Local frame as before:
 *     x along the facing, y up, origin = the sim disc centre, so eyes / arms / hats keep working unchanged.
 *   - onEvent(S, e): the sim's events become impulses: a blast (per-node radial kick with falloff, 'explode'.pushes), a bat (a dent where it
 *     lands, 0.06 s after the swing, along the hit vector), a landing (impact speed), any other hit with a direction (shot, punch, bite).
 *   - twist(w, rate): a spinning blow (the knockout punch) as an angular impulse.
 * Terrain: the real density field of the world on the worm's own vertical plane (+ the cross-sections of props near it). Presentation only
 * (not in S, not hashed); fixed sub-step, so it is frame-rate independent; a replay rebuilds the worm views, which resets the bodies.
 * Porting: one SoftWorm struct per worm; this file is the engine-side glue (sample callback, event -> impulse tables). */
(function (SS) {
  'use strict';
  const M = SS.math, C = SS.CFG, P = SS.plane, SW = SS.softworm, N = SW.N;
  const SV = SS.softView = {};
  const NS = 150;
  const OUT = { x: new Float32Array(NS), y: new Float32Array(NS), a: new Float32Array(NS), r: new Float32Array(NS), dx: 0, dy: 0 };   // dx, dy: how far the shoulder is from its goal (m): a held weapon rides with it
  const TMP = { x: 0, y: 0 };
  const MAT_ICE = 7, MAT_SNOW = 6, SINK = { 6: 0.1, 4: 0.055, 11: 0.05, 12: 0.03 };   // sink depth (m) by ground material: snow, sand, ash, scree
  const BAT_SPEED = 38, BAT_DELAY = 0.06, HIT_R = 0.32;
  let clock = 0;
  const pend = [];                          // delayed bat hits { t, w, cs, cy, dx, dy }
  const batW = [];                          // worms hit by a bat this step (until the 'swing' event with the contact point arrives)

  /* ---------- the world seen from one worm's plane ---------- */
  const E = { S: null, c: 1, s: 0, t: 0, sink: 0, nb: 0, bs: [], bY: [], bK: [], bA: [], bB: [], sample: null };
  E.sample = function (s, y) {
    const S = E.S, nx = -E.s, nz = E.c;
    let d = SS.world.sample(S.O.x + s * E.c + E.t * nx, y, S.O.z + s * E.s + E.t * nz) - E.sink;
    for (let i = 0; i < E.nb; i++) {                       // a prop / trunk cross-section: a signed field (m * 0.7) like the terrain's
      const ds = s - E.bs[i], dy = y - E.bY[i];
      const f = E.bK[i] === 0 ? (E.bA[i] - M.len2(ds, dy)) * 0.7 : Math.min(E.bA[i] - Math.abs(ds), E.bB[i] - Math.abs(dy)) * 0.7;
      if (f > d) d = f;
    }
    return d;
  };
  function gatherBodies(S, s0, y0) {
    const B = S.planeBodies; E.nb = 0; if (!B) return;
    for (let i = 0; i < B.length && E.nb < 8; i++) {
      const b = B[i]; if (b.worm >= 0) continue;
      const rr = b.kind === 0 ? b.r : Math.max(b.hs, b.hy);
      if (Math.abs(b.s - s0) > rr + 2 || Math.abs(b.y - y0) > rr + 2) continue;
      const k = E.nb++; E.bs[k] = b.s; E.bY[k] = b.y; E.bK[k] = b.kind; E.bA[k] = b.kind === 0 ? b.r : b.hs; E.bB[k] = b.kind === 0 ? 0 : b.hy;
    }
  }

  SV.init = function () {};
  SV.clear = function () { pend.length = 0; batW.length = 0; clock = 0; };
  SV.frame = function (S, view, camera, dt) {
    clock += dt; batW.length = 0;
    for (let i = pend.length - 1; i >= 0; i--) if (clock >= pend[i].t) { const q = pend[i]; pend.splice(i, 1); const sw = body(q.w); if (sw) SW.hit(sw, q.cs, q.cy, q.dx, q.dy, BAT_SPEED, HIT_R); }
  };
  const body = w => { const vis = SS.actors && SS.actors.vis(w), v = vis && vis.v; return v && v.sw && v.sw.init ? v.sw : null; };
  SV.body = body; SV.OUT = OUT;

  /* ---------- per worm and frame ---------- */
  /* c = { f, sNow, airborne, wet (0..1), surf, vs (crawl velocity), grounded, slope (rad, ground frame in the plane), hang (angle rad or null), swim, lean, spin,
   *       sx, sy, ox, oy (goal scale / offset: the muscles), dt, dizzy } */
  SV.update = function (S, w, v, sp, c) {
    if (S.eow && SS.eowView) return SS.eowView.goal(OUT, sp, c);      // P68c: no jelly solver in space (its gravity and ground are the upright world's): the muscle pose, turned by the suit
    let sw = v.sw; const created = !sw; if (created) sw = v.sw = SW.make();
    const I = sw.in, f = c.f, s0 = c.sNow, y0 = w.pos.y;
    // the goal pose: the animator's spine sampled at N nodes, scaled by the muscles (crouch, stretch, breathing) about the ground line
    for (let j = 0; j < N; j++) {
      const i = Math.round(j * (NS - 1) / (N - 1));
      SW.set_goal(sw, j, sp.x[i] * c.sx + c.ox, -0.5 + (sp.y[i] + 0.5) * c.sy + c.oy, sp.r[i] * (c.sx + c.sy) * 0.5, sp.b ? sp.b[i] : 0);
    }
    const tp = P.to_plane(S, w.pos);
    E.S = S; E.c = M.cos(S.theta); E.s = M.sin(S.theta); E.t = tp.t; gatherBodies(S, s0, y0);
    // inputs of the solver
    if (!created && sw.init && I.f !== f) SW.flip(sw, I.px);               // turned round: the view mirrors the body, so the nodes mirror about the disc
    I.f = f; I.x = s0; I.y = y0;
    I.ground = c.grounded ? 1 : 0; I.thG = c.slope + f * c.lean;
    I.spin = c.spin; I.tone = c.dizzy ? 0.75 : 1; I.vref = c.grounded && c.vs ? c.vs : 0;
    I.surf = c.surf > -1e8 ? c.surf : -1e9; I.g = 9.81 * (SS.sim && SS.sim.gravity_k ? SS.sim.gravity_k(S, w) : 1);
    if (c.hang != null) { I.extTh = f * c.hang; I.extW = 0.9; } else if (c.fly) { I.extTh = c.fly.a; I.extW = c.fly.w; } else if (c.swim) { I.extTh = 0; I.extW = 0.5; } else I.extW = 0;
    if (c.pull) { I.hx = c.pull.x * I.g * SW.K.PULL; I.hy = c.pull.y * I.g * SW.K.PULL; } else I.hx = I.hy = 0;   // rope / riser tension on the head
    I.mu = SW.K.MU;
    let sinkT = 0;
    if (c.grounded) {
      const m = SS.world.mat_at(w.pos.x, w.pos.y - 0.7, w.pos.z);
      if (m === MAT_ICE) I.mu = 0.1; else if (m === MAT_SNOW) I.mu = 0.5;
      sinkT = SINK[m] || 0;                                  // P65h: a worm sinks into loose ground (the surface the body meets is lowered by that depth)
    }
    v.sinkD = (v.sinkD || 0) + (sinkT - (v.sinkD || 0)) * M.min(1, c.dt * 3.5);
    E.sink = v.sinkD * 0.7;
    if (!sw.init) { I.px = s0; I.py = y0; SW.reset(sw, s0, y0); }
    else if (Math.abs(s0 - I.px) + Math.abs(y0 - I.py) > 1.2 + 1.6 * c.speed * c.dt) {
      // a teleport / a respawn (a fast flight is not). P38 R3: while the section turns, the in-plane coordinates of a worm far from the pivot
      // jump by metres per frame: the body is carried along (re-anchored) instead of reset, so it does not go rigid / drag
      if (sw.th0 != null && Math.abs(S.theta - sw.th0) > 1e-5) { const ds = s0 - I.px, dy = y0 - I.py; for (let k = 0; k < N; k++) { sw.px[k] += ds; sw.py[k] += dy; } I.px = s0; I.py = y0; }
      else SW.reset(sw, s0, y0);
    }
    sw.th0 = S.theta;
    SW.advance(sw, c.dt, E);
    // the live spine: Catmull-Rom through the nodes, body-local (x along the facing, origin = the sim disc centre)
    const lx = j => f * (sw.px[j < 0 ? 0 : j >= N ? N - 1 : j] - s0), ly = j => sw.py[j < 0 ? 0 : j >= N ? N - 1 : j] - y0;
    for (let k = 0; k < NS; k++) {
      const t = k * (N - 1) / (NS - 1); let j = Math.floor(t); if (j > N - 2) j = N - 2; const u = t - j, u2 = u * u, u3 = u2 * u;
      const p0x = lx(j - 1), p1x = lx(j), p2x = lx(j + 1), p3x = lx(j + 2), p0y = ly(j - 1), p1y = ly(j), p2y = ly(j + 1), p3y = ly(j + 2);
      const x = 0.5 * (2 * p1x + (-p0x + p2x) * u + (2 * p0x - 5 * p1x + 4 * p2x - p3x) * u2 + (-p0x + 3 * p1x - 3 * p2x + p3x) * u3);
      const y = 0.5 * (2 * p1y + (-p0y + p2y) * u + (2 * p0y - 5 * p1y + 4 * p2y - p3y) * u2 + (-p0y + 3 * p1y - 3 * p2y + p3y) * u3);
      const dx = 0.5 * ((-p0x + p2x) + 2 * (2 * p0x - 5 * p1x + 4 * p2x - p3x) * u + 3 * (-p0x + 3 * p1x - 3 * p2x + p3x) * u2);
      const dy = 0.5 * ((-p0y + p2y) + 2 * (2 * p0y - 5 * p1y + 4 * p2y - p3y) * u + 3 * (-p0y + 3 * p1y - 3 * p2y + p3y) * u2);
      OUT.x[k] = x; OUT.y[k] = y; OUT.a[k] = M.atan2(dy, dx);
      // radius: the animator's (annuli, saddle, contraction) times the volume factor of the solver (stretch -> thin, squash -> bulge)
      const ra = sw.r0[j] > 1e-4 ? sw.rad[j] / sw.r0[j] : 1, rb = sw.r0[j + 1] > 1e-4 ? sw.rad[j + 1] / sw.r0[j + 1] : 1, vf = ra + (rb - ra) * u;
      OUT.r[k] = sp.r[k] * (c.sx + c.sy) * 0.5 * vf;
    }
    const sh = Math.round(NS * 0.55);
    let dx = OUT.x[sh] - (sp.x[sh] * c.sx + c.ox), dy = OUT.y[sh] - (-0.5 + (sp.y[sh] + 0.5) * c.sy + c.oy); const dl = M.len2(dx, dy);
    if (dl > 0.25) { dx *= 0.25 / dl; dy *= 0.25 / dl; }
    OUT.dx = dx; OUT.dy = dy;
    return OUT;
  };

  /* ---------- events -> impulses ---------- */
  const toPlane = (S, x, y, z) => { const p = P.to_plane(S, { x, z }); TMP.x = p.s; TMP.y = y; return TMP; };
  const planeDir = (S, dx, dy, dz) => { const d = P.dir(S), a = dx * d.x + dz * d.z, l = M.len2(a, dy) || 1; return { x: a / l, y: dy / l }; };
  SV.onEvent = function (S, e) {
    if (e.type === 'explode' && e.pushes) {
      for (const q of e.pushes) {
        const sw = body(q.worm); if (!sw) continue;
        const c = toPlane(S, e.x, e.y, e.z);
        SW.blast(sw, c.x, c.y, q.dv, q.r, 0.45);
      }
    } else if (e.type === 'land' && e.worm) {
      const sw = body(e.worm); if (sw && (e.speed || 0) > 3) SW.land(sw, e.speed);
    } else if (e.type === 'hurt' && e.worm && !e.dot && e.dir && !e.worm.dead) {
      if (e.src === C.DS.BAT) { batW.push({ w: e.worm, dir: e.dir }); return; }
      if (e.src === C.DS.BLAST) return;                                    // (explode.pushes carries the real per-node wave)
      const sw = body(e.worm); if (!sw) return;
      const d = planeDir(S, e.dir.x, e.dir.y, e.dir.z), cen = {}; SW.centroid(sw, cen);
      SW.hit(sw, cen.x - d.x * 0.3, cen.y - d.y * 0.3 + 0.1, d.x, d.y, M.clamp(4 + e.amount * 0.6, 4, 26), 0.3);
    } else if (e.type === 'swing' && batW.length) {                         // the bat's contact point (the worms it hit were queued by their 'hurt')
      const c = toPlane(S, e.x, e.y, e.z), cs = c.x, cy = c.y;
      for (const q of batW) { const d = planeDir(S, q.dir.x, q.dir.y, q.dir.z); pend.push({ t: clock + BAT_DELAY, w: q.w, cs, cy, dx: d.x, dy: d.y }); }
      batW.length = 0;
    }
  };
  SV.twist = function (w, rate) { const sw = body(w); if (sw) SW.twist(sw, rate); };
})(window.SS = window.SS || {});
