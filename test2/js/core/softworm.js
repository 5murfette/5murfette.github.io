/* core/softworm.js — P39 J1: a deterministic soft-body ("jelly") worm. Position-based dynamics on a chain of N = 16
 * spheres along the
 * worm's spine, solved in the gameplay plane (s, y) with a fixed sub-step. It replaces the rigid salto / tumble / dent
 * hacks of the old worm render: a worm now deforms, wobbles and settles because of real contacts, constraints, damping
 * and impulses.
 *
 * WHAT IT IS (and what it is not). The gameplay simulation (js/sim: the collision disc, its velocity, damage, turn
 * logic) stays the authority. This solver is the worm's BODY: secondary dynamics driven by the sim worm, living
 * render-side (never read by gameplay, not in S, not in sim.hash). It is still a pure function of its inputs: no
 * Math.random, no clock, a fixed sub-step SW.H, an accumulator, so the same inputs give the same bits on any frame rate
 * (tests: tools/dev/gen/softwormtest.cjs).
 *
 * MODEL (all lengths m, times s, plane coordinates; x = s along the plane bearing, y up):
 *   - N nodes, each a sphere of radius rad[i] (the tube radius there). A muscle GOAL pose g[i] (facing frame: x along
 *     the facing, y up, origin = the sim disc centre) comes from the animator (aim, breathing, crawl wave); the solver
 *     never plays a canned animation, it only holds the goal with finite, state-dependent stiffness ("muscle tone").
 *   - per sub-step: gravity, buoyancy + drag in water, rope pull at the head, impulses already added to v; internal
 *     damping (only the NON-rigid part of the velocity: rigid translation / rotation keep their momentum) and angular
 *     drag while airborne;
 *     predict; K.ITER passes of  distance constraints (neighbours + skip-2: stretch / compress / kinks)  ->  shape
 *     matching (pulls each
 *     node toward the goal pose carried by a rigid frame)  ->  a soft pin of the centroid to the sim worm  ->  terrain
 *     contact.
 *   - SHAPE-MATCHING FRAME. The goal pose is carried by a rigid frame (angle th about the centroid). While the worm
 *     touches the ground the frame is the GROUND frame (th = the slope under it): the body can only deform, never roll
 *     as a rigid thing, and it lies along slopes. Airborne the frame is the body's own rotation (estimated from the
 *     nodes), so momentum from an off-centre blast gives a real, angular-damped tumble. The weight between them is gw
 *     (smoothed 0..1). On a rope / while swimming the frame is pulled to an external angle (in.extTh / in.extW). A
 *     salto is a muscle torque on the rigid mode (in.spin rad/s), not a drawn rotation.
 *   - CONTACT: the terrain is a density field (>0 = solid) sampled through env.sample(x, y); its gradient gives the
 *     normal, d / |grad| the distance. A node closer than its radius to the surface is pushed out along the normal;
 *     friction is PBD Coulomb (the tangential displacement is cut by mu * penetration, so the deceleration is mu * g),
 *     and a thin adhesion skin (K.SKIN) keeps the belly on the surface (sticky: no hopping, follows slopes). Grounded +
 *     crawling: friction acts relative to the crawl velocity (in.vref), so the worm walks instead of being held back.
 *   - VOLUME: the radius of a node follows the stretch of its two segments (rad = rad0 * sqrt(L0 / L), clamped):
 *     compress -> bulge, stretch -> thin (jelly squash and stretch), used by contact and the mesh alike.
 *
 * C LAYOUT (a port uses these as they are; float / double both fine):
 *   typedef struct { double px[N], py[N], vx[N], vy[N];        // node positions / velocities (plane s, y)
 *                    double gx[N], gy[N], r0[N];                // goal pose (facing frame, from the animator) and its
 *                    radii (input)
 *                    double rad[N], len[N], cn[N];               // current radius (output, after the volume rule),
 *                    segment rest lengths, contact flags
 *                    double act[N], ax[N], ay[N], tmx[N], tmy[N];  // muscle activation, per-node accumulators /
 *                    scratch (kept in the struct: no allocation)
 *                    double fs, th, gw, cg, shock, thG, thE, acc;  // smoothed facing sign, frame angle, ground weight,
 *                    contact weight, hit shock, ground / external frame angles, accumulator
 *                    double sg, snx, sny;                          // P88: snap offset of the pin target (m) and the
 *                    surface normal it acts along
 *                    double crash, lcool, svx, svy;               // P40: crash state 0..1 (steep + fast landing),
 *                    landing cool-down (s), the sim worm's velocity (plane)
 *                    double hvx[8], hvy[8]; int hi, cprev;        // P40: ring of the last 8 centroid velocities (the
 *                    approach velocity of a landing), its head, contacts of the last sub-step
 *                    double en, wz, pen, spd; int contacts;      // diagnostics: kinetic energy, angular velocity, max
 *                    penetration, speed, nodes in contact
 *                    double th0;                                  // presentation: the plane angle of the last update
 *                    (null = none; softview re-anchors when it changes)
 *                    SoftIn in; int init; } SoftWorm;
 *   typedef struct { double x, y, vx, vy;      // sim worm centre and velocity (plane)   f   facing sign (+-1)
 *                    double ground;            // 1 = sim says on the ground           thG slope angle of the ground
 *                    frame (rad)
 *                    double extTh, extW;       // external frame angle and weight (rope, swim)
 *                    double spin;              // salto muscle torque (rad/s target of the rigid rotation), 0 = none
 *                    double tone;              // muscle tone 0..1 (1 = firm, low right after a hit: floppy)
 *                    double vref;              // crawl velocity along the ground (s), friction reference
 *                    double mu;                // ground friction (ice: low)
 *                    double surf;              // water surface y (-1e9 = none)     g  gravity (m/s^2)
 *                    double hx, hy;            // rope pull acceleration on the head
 *                    double px, py;            // the sim worm's previous position (set by SW.reset) } SoftIn;
 *   API (free functions over the struct): make(), reset(sw, x, y), set_goal(sw, i, gx, gy, r0), advance(sw, dt, env),
 *   hit(sw, cx, cy, dx, dy, speed, radius), twist(sw, omega), flip(sw, x0), blast(sw, cx, cy, dv, dist, upBias),
 *   land(sw, speed, vt), centroid(sw, out), spine(sw, ...). LANDING (P40): the body classifies every landing by its
 *   impact angle and speed (land() from the sim's event, or by itself: the first contact after flight, fast along the
 *   surface normal). Steep + fast = a CRASH: deep vertical squash, tangential motion absorbed, stronger pin to the sim
 *   worm for ~0.45 s, a spring back up in place; shallow = the tangential velocity is kept (it skids and may fold along
 *   the ground). Constants K.CR_*, K.LAND_COOL, K.AUTO_V. env = { sample(x, y) -> density }: the only world access (a
 *   function pointer in C). Pure SS.math, no allocation per step. */
(function (SS) {
  'use strict';
  const M = SS.math;
  const SW = SS.softworm = {};
  const N = SW.N = 16;
  SW.H = 1 / 120;                       // fixed sub-step (s)
  const K = SW.K = {
    ITER: 2,                            // constraint passes per sub-step
    MAX_SUB: 8,                         // sub-steps per advance() (a long frame is cut, never an explosion)
    D_NEI: 0.9, D_SKIP: 0.35,           // distance-constraint stiffness per pass (neighbour / skip-2)
    // shape matching stiffness per pass at full tone (P40: stiffer, ~6 Hz; was 0.036 = ~5 visible wobbles)
    A_SHAPE: 0.055,
    // centroid pin to the sim worm per pass: along the ground firm (the sim carries the walk), across it soft (the body
    // may crumple); air: follows
    PIN_T: 0.16, PIN_N: 0.022, PIN_A: 0.55,
    // internal (non-rigid) velocity damping per sub-step (P88: 0.14 -> 0.18, less jelly in contact; P40: was 0.05;
    // about 1-2 visible wobbles after an impact)
    KD: 0.18,
    KW_AIR: 4.0,                        // angular drag while airborne (1/s)
    KV_AIR: 0.15,                       // linear air drag (1/s)
    DENT_K: 0.0045, DENT_MAX: 0.2,      // bat dent depth (m) per m/s of the hit, max
    ACT_MU0: 0.35,                      // friction of a fully relaxed (lengthening) ring relative to a contracted one
    VREF_K: 0.0,                        // share of the crawl velocity friction is measured against (0 = the real ground)
    // a node resting on the ground (slower than CSLOW m/s) loses CDAMP of its velocity per sub-step: the body comes to
    // rest, no jitter
    CSLOW: 1.5, CDAMP: 0.25,
    SPIN_ABSORB: 0.6,                   // share of the torque of a hit / blast the soft body absorbs
    AIR_SOFT: 0.4,                      // muscles relax in flight: the body is floppier airborne
    SHOCK_PIN: 0.75, SHOCK_DECAY: 3.5, SHOCK_SOFT: 0.55,  // muscle tone drops after a hit / landing (floppy), recovers in ~0.3 s
    // P40 landing: sine of the impact angle (normal / total speed) where a crash starts / is complete (33 .. 58 degrees
    // from the ground)
    CR_A0: 0.55, CR_A1: 0.85,
    CR_V0: 3.5, CR_V1: 8.0,             // ... and the normal speed (m/s) where it starts / is complete (a hop is not a crash)
    CR_DECAY: 2.2,                      // the crash state ends in ~0.45 s
    // crash: share of the body's velocity relative to the sim worm (along the ground) absorbed per sub-step; tangential
    // pin to the sim worm per pass
    CR_ABS: 0.3, CR_PIN: 0.55,
    CR_PIN_N: 0.05,                     // crash: pin across the ground (the spring-back: the squashed centroid is pulled up to the disc)
    // crash: muscle tone drops by this share (a deeper squash), internal damping drops by this share (a clear rebound)
    CR_SOFT: 0.5, CR_KD: 0.6,
    CR_BOOST: 0.8,                      // crash: the nodes get (0.8 + this) x the impact speed (the crumple goes deeper)
    // after a landing impulse no new one for this long (s); the body detects its own landing (first contact after
    // flight) above this normal speed (m/s)
    LAND_COOL: 0.25, AUTO_V: 3.5,
    CR_TANG: 0.9,                       // crash: share of the tangential impulse absorbed at once at the impact
    D_COMP: 0.3,                        // compression stiffness factor of the neighbour constraints (length is not conserved, volume is)
    MU: 1.6, SKIN: 0.035,               // ground friction (slime: sticky, holds a 55 degree slope); adhesion skin (m)
    GRAD_E: 0.08,                       // finite difference step for the terrain gradient (m)
    VMAX: 60, RMAX: 2.2,                // clamps: node speed; node distance from the sim worm before a reset
    PULL: 1.25,                         // rope / riser tension on the head (x g; gravity acts on it too)
    BUOY: 1.0, WDRAG: 7.0,              // water: buoyancy as a fraction of gravity (a worm floats), drag (1/s)
    // P88: grounded + calm: the pin target is lowered until the belly is SNAP_GAP m off the surface (at most
    // SNAP_MAX_GAP m; integrator gain 1/s)
    SNAP_GAP: 0.012, SNAP_MAX_GAP: 0.4, SNAP_RATE: 14,
    KC_REL: 24,                         // P88: damping (1/s) of the centroid velocity relative to the sim worm while grounded and calm
    // P88: a push out of a surface deeper than this (m) adds no velocity (a node that is put back on a new surface, a
    // section turned under it, is not launched)
    DEPEN: 0.03,
    PUSH_MAX: 0.25,                     // P88: the most a node is pushed out of a surface per pass (m)
    VOL_MIN: 0.72, VOL_MAX: 1.45
  };
  const abs = Math.abs, min = M.min, max = M.max;

  SW.make = function () {
    const f = () => new Float64Array(N);
    return { px: f(), py: f(), vx: f(), vy: f(), gx: f(), gy: f(), r0: f(), rad: f(), len: f(), cn: f(), act: f(), ax: f(), ay: f(),
      tmx: f(), tmy: f(),
      fs: 1, th: 0, gw: 0, cg: 0, sg: 0, snx: 0, sny: 1, shock: 0, crash: 0, lcool: 0, cprev: 0, svx: 0, svy: 0, hvx: new Float64Array(8),
      hvy: new Float64Array(8), hi: 0, thG: 0, thE: 0, acc: 0, wz: 0, en: 0, pen: 0, spd: 0, contacts: 0, init: 0, th0: null,
      in: {
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        f: 1,
        ground: 1,
        thG: 0,
        extTh: 0,
        extW: 0,
        spin: 0,
        tone: 1,
        vref: 0,
        mu: K.MU,
        surf: -1e9,
        g: 9.81,
        hx: 0,
        hy: 0,
        px: 0,
        py: 0
      } };
  };
  SW.set_goal = function (sw, i, gx, gy, r0, act) {
    sw.gx[i] = gx;
    sw.gy[i] = gy;
    sw.r0[i] = r0;
    sw.act[i] = act || 0;
  };

  const gcen = (sw, out) => {
    let cx = 0, cy = 0;
    for (let i = 0; i < N; i++) {
      cx += sw.gx[i];
      cy += sw.gy[i];
    }
    out.x = cx / N;
    out.y = cy / N;
    return out;
  };
  const GC = { x: 0, y: 0 };
  /* put the nodes on the goal pose (upright, at the sim worm): used at the start, after a teleport / replay / camera
   * cut */
  SW.reset = function (sw, x, y) {
    const I = sw.in;
    sw.fs = I.f;
    gcen(sw, GC);
    const th = I.ground > 0.5 ? I.thG : 0, c = M.cos(th), s = M.sin(th);
    for (let i = 0; i < N; i++) {
      const ox = sw.fs * (sw.gx[i] - GC.x) * 1, oy = sw.gy[i] - GC.y;
      sw.px[i] = x + GC.x * sw.fs * c - GC.y * s + ox * c - oy * s;
      sw.py[i] = y + GC.x * sw.fs * s + GC.y * c + ox * s + oy * c;
      sw.vx[i] = sw.vy[i] = 0;
      sw.rad[i] = sw.r0[i];
    }
    sw.shock = 0;
    sw.th = sw.thE = th;
    sw.thG = th;
    sw.gw = I.ground > 0.5 ? 1 : 0;
    sw.cg = 0;
    sw.acc = 0;
    sw.wz = 0;
    sw.init = 1;
    I.px = x;
    I.py = y;
  };
  /* P88: put the nodes onto the surface without giving them any velocity (a section that turned / moved under the body:
   * the cross-section is a new one). Position-only contact passes. */
  SW.relax = function (sw, env, passes) {
    for (let p = 0; p < passes; p++)
      for (let i = 0; i < N; i++) {
        sw.tmx[i] = sw.px[i];
        sw.tmy[i] = sw.py[i];
        CN.x = 0;
        CN.y = 0;
        contact(sw, i, env, 0, 0, 0, SW.H);
      }
    for (let i = 0; i < N; i++) {
      sw.tmx[i] = sw.px[i];
      sw.tmy[i] = sw.py[i];
      sw.vx[i] = sw.vy[i] = 0;
    }
    sw.sg = 0;
  };
  SW.centroid = function (sw, out) {
    let cx = 0, cy = 0;
    for (let i = 0; i < N; i++) {
      cx += sw.px[i];
      cy += sw.py[i];
    }
    out.x = cx / N;
    out.y = cy / N;
    return out;
  };

  /* ---------- impulses (events of the sim) ---------- */
  /* a bat / punch / shot: a Gaussian blob of velocity along (dx, dy) (unit) around (cx, cy), plus a quarter of it for
   * the whole body */
  SW.hit = function (sw, cx, cy, dx, dy, speed, radius) {
    // (P38 R3: a NaN / infinite speed would poison sw.shock for good: M.max(0, NaN) = NaN)
    if (!(speed === speed) || !(speed < 1e6)) return;
    sw.shock = max(sw.shock, min(1, speed / 14));
    const s2 = 1 / (2 * radius * radius);
    const dent = min(K.DENT_MAX, speed * K.DENT_K);
    for (let i = 0; i < N; i++) {
      const ex = sw.px[i] - cx, ey = sw.py[i] - cy, g = M.exp(-(ex * ex + ey * ey) * s2), w = 0.25 + 0.75 * g;
      sw.vx[i] += dx * speed * w; sw.vy[i] += dy * speed * w;
      sw.px[i] += dx * dent * g; sw.py[i] += dy * dent * g;               // the contact compresses the jelly under the bat at once
    }
    absorb_spin(sw);
  };
  /* spin the whole body (a punch, a spinning blow): angular velocity omega (rad/s) about the centroid, added to the
   * node velocities */
  SW.twist = function (sw, omega) {
    let cx = 0, cy = 0;
    for (let i = 0; i < N; i++) {
      cx += sw.px[i];
      cy += sw.py[i];
    }
    cx /= N;
    cy /= N;
    for (let i = 0; i < N; i++) {
      sw.vx[i] -= omega * (sw.py[i] - cy);
      sw.vy[i] += omega * (sw.px[i] - cx);
    }
  };
  /* the worm turned round (the view mirrors the whole body): reflect nodes about the vertical line x0 so the mirrored
   * view is continuous */
  SW.flip = function (sw, x0) {
    for (let i = 0; i < N; i++) {
      sw.px[i] = 2 * x0 - sw.px[i];
      sw.vx[i] = -sw.vx[i];
    }
    sw.thE = -sw.thE; sw.th = -sw.th; sw.wz = -sw.wz;
  };
  /* the compliant body absorbs most of the torque of an impulse into deformation instead of spinning like a rigid body:
   * remove 60 % of the rigid angular velocity */
  function absorb_spin(sw) {
    let cx = 0, cy = 0, vcx = 0, vcy = 0;
    for (let i = 0; i < N; i++) {
      cx += sw.px[i];
      cy += sw.py[i];
      vcx += sw.vx[i];
      vcy += sw.vy[i];
    }
    cx /= N;
    cy /= N;
    vcx /= N;
    vcy /= N;
    let wn = 0, wd = 0;
    for (let i = 0; i < N; i++) {
      const rx = sw.px[i] - cx, ry = sw.py[i] - cy;
      wn += rx * (sw.vy[i] - vcy) - ry * (sw.vx[i] - vcx);
      wd += rx * rx + ry * ry;
    }
    const w = wd > 1e-6 ? wn / wd * K.SPIN_ABSORB : 0;
    for (let i = 0; i < N; i++) {
      sw.vx[i] += w * (sw.py[i] - cy);
      sw.vy[i] -= w * (sw.px[i] - cx);
    }
  }
  /* a blast at (cx, cy): every node gets a radial kick (away from the centre, tilted up like the sim's shove),
   * strongest on the
   * side facing it (a pressure wave through the body). dv = the sim's velocity change of the worm centre, dist = its
   * distance */
  SW.blast = function (sw, cx, cy, dv, dist, upBias) {
    if (!(dv === dv) || !(dv < 1e6) || !(dist === dist)) return;
    const ub = upBias == null ? 0.45 : upBias, d0 = max(0.3, dist);
    sw.shock = max(sw.shock, min(1, dv / 16));
    for (let i = 0; i < N; i++) {
      let ex = sw.px[i] - cx, ey = sw.py[i] - cy;
      const d = max(0.25, M.len2(ex, ey));
      ex /= d;
      ey = ey / d + ub;
      const l = M.len2(ex, ey) || 1;
      const k = M.clamp(M.pow(d0 / d, 1.3), 0.3, 3.0);
      sw.vx[i] += ex / l * dv * k; sw.vy[i] += ey / l * dv * k;
    }
    absorb_spin(sw);
  };
  /* a landing: 'speed' = the impact speed along the ground normal (the sim's), vt = the tangential speed along the
   * ground (+ = toward +s; omitted /
   * NaN = taken from the body's own velocity ~65 ms ago). The IMPACT ANGLE and speed decide the response (P40):
   *   steep + fast (crash q -> 1): the nodes get the impact velocity along the normal (top-heavy crumple), the
   *     tangential motion is absorbed (the body stays on the sim worm: no slide, no drift) and the crash state
   *     (sw.crash) pins the centroid hard along the ground for ~0.45 s while the squashed body springs back up in place
   *   (overshoot once, then settles). shallow / slow (q -> 0): the normal impulse is the same, the tangential velocity
   *     is KEPT: the body bumps, skids (friction) and may fold / tumble along the ground, settling where the sim worm
   *     is. */
  const smooth = (a, b, x) => {
    const t = M.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  /* the response proper: impact speed vn along the normal (nx, ny), tangential speed vt along t = (ny, -nx) */
  function land_apply(sw, vn, vt, nx, ny) {
    const q = smooth(K.CR_A0, K.CR_A1, vn / (M.len2(vn, vt) + 1e-6)) * smooth(K.CR_V0, K.CR_V1, vn), tc = ny, ts = -nx;
    sw.shock = max(sw.shock, min(1, vn / 14));
    sw.crash = max(sw.crash, q); sw.lcool = K.LAND_COOL;
    const vdn = -vn * (0.8 + K.CR_BOOST * q);
    for (let i = 0; i < N; i++) {
      const un = sw.vx[i] * nx + sw.vy[i] * ny, ut = sw.vx[i] * tc + sw.vy[i] * ts;
      const un2 = un > vdn ? vdn : un, ut2 = ut * (1 - K.CR_TANG * q);
      sw.vx[i] = un2 * nx + ut2 * tc; sw.vy[i] = un2 * ny + ut2 * ts;
    }
  }
  /* the approach velocity: the fastest centroid velocity of the last 8 sub-steps (65 ms) */
  const HP = { x: 0, y: 0 };
  function hist_peak(sw) {
    let b = -1, bx = 0, by = 0;
    for (let k = 0; k < 8; k++) {
      const d = sw.hvx[k] * sw.hvx[k] + sw.hvy[k] * sw.hvy[k];
      if (d > b) {
        b = d;
        bx = sw.hvx[k];
        by = sw.hvy[k];
      }
    }
    HP.x = bx; HP.y = by; return HP;
  }
  SW.land = function (sw, speed, vt) {
    if (!(speed === speed) || !(speed < 1e6)) return;
    const I = sw.in, tc = M.cos(I.thG), ts = M.sin(I.thG);
    if (!(vt > -1e6 && vt < 1e6)) {
      hist_peak(sw);
      vt = HP.x * tc + HP.y * ts;
    }
    land_apply(sw, speed, vt, -ts, tc);
  };

  /* ---------- the step ---------- */
  // CG: the node closest to the surface this pass (gap = distance - radius) and its surface normal   // CN: sum of the
  // contact normals of this sub-step
  const G2 = { x: 0, y: 0 }, CN = { x: 0, y: 0 }, CG = { gap: 9, nx: 0, ny: 1 };
  /* terrain contact for one node (position p, radius r): pushes it out, applies friction; returns the penetration (>0)
   * or 0 */
  function contact(sw, i, env, mu, vrx, vry, h) {
    const x = sw.px[i], y = sw.py[i], r = sw.rad[i], d = env.sample(x, y);
    if (d < -2.9) return 0;
    const e = K.GRAD_E,
      gx = env.sample(x + e, y) - env.sample(x - e, y),
      gy = env.sample(x, y + e) - env.sample(x, y - e),
      gl = M.len2(gx, gy);
    if (gl < 1e-3) { return 0; }
    const nx = -gx / gl, ny = -gy / gl, dist = -d * 2 * e / gl;                 // gl = |grad| * 2e  ->  distance = -d / |grad|
    const pen = r - dist;
    if (dist - r < CG.gap) {
      CG.gap = dist - r;
      CG.nx = nx;
      CG.ny = ny;
    }
    if (pen > 0) {
      CN.x += nx;
      CN.y += ny;
    }
    if (pen < -K.SKIN) return 0;
    // sticky skin: inside the skin the node loses its velocity away from the surface (the slime holds the belly down)
    const ox = sw.px[i] - sw.tmx[i], oy = sw.py[i] - sw.tmy[i];                 // displacement of this sub-step (before the push)
    let px = x, py = y;
    // (the depth beyond DEPEN is a position fix only: it adds no velocity)   // (P88: a body buried by a prop / rubble
    // is eased out, never thrown: it used to reach 10^7 energy)
    if (pen > 0) {
      const pp = pen < K.PUSH_MAX ? pen : K.PUSH_MAX;
      px += nx * pp;
      py += ny * pp;
      if (pp > K.DEPEN) {
        const ex = pp - K.DEPEN;
        sw.tmx[i] += nx * ex;
        sw.tmy[i] += ny * ex;
      }
    }
    // PBD Coulomb friction: remove the tangential part of the displacement (relative to the crawl reference) up to mu *
    // penetration
    const rx = ox - vrx * h, ry = oy - vry * h, dn = rx * nx + ry * ny, tx = rx - dn * nx, ty = ry - dn * ny, tl = M.len2(tx, ty);
    // peristalsis: a contracted ring grips, a lengthening one slips
    const lim = mu * (K.ACT_MU0 + (1 - K.ACT_MU0) * sw.act[i]) * (pen > 0 ? pen : 0);
    if (tl > 1e-9) {
      const cut = tl <= lim ? tl : lim;
      px -= tx / tl * cut;
      py -= ty / tl * cut;
    }
    sw.px[i] = px; sw.py[i] = py;
    return pen > 0 ? pen : 0;
  }

  function substep(sw, h, env, kf) {
    const I = sw.in;
    // frame: centroid, facing sign, rotation estimate
    let cx = 0, cy = 0, vcx = 0, vcy = 0;
    for (let i = 0; i < N; i++) {
      cx += sw.px[i];
      cy += sw.py[i];
      vcx += sw.vx[i];
      vcy += sw.vy[i];
    }
    cx /= N;
    cy /= N;
    vcx /= N;
    vcy /= N;
    sw.fs = I.f;
    // centroid velocity history (the pre-impact velocity of a landing)
    sw.hi = (sw.hi + 1) & 7; sw.hvx[sw.hi] = vcx; sw.hvy[sw.hi] = vcy;
    gcen(sw, GC);
    const fs = sw.fs, gcx = GC.x * fs, gcy = GC.y;
    let sc = 0, sd = 0;
    for (let i = 0; i < N; i++) {
      const ax = sw.gx[i] * fs - gcx, ay = sw.gy[i] - gcy, bx = sw.px[i] - cx, by = sw.py[i] - cy;
      sw.ax[i] = ax;
      sw.ay[i] = ay;
      sc += ax * by - ay * bx;
      sd += ax * bx + ay * by;
    }
    if (abs(fs) > 0.4 && sd * sd + sc * sc > 1e-8) sw.thE = M.atan2(sc, sd);
    // ground weight and the frame angle
    // grounded by the sim, or by what the body itself touches (a slide / tumble down a slope is not flight)
    const gt = I.ground > 0.5 ? 1 : sw.cg;
    sw.gw += (gt - sw.gw) * min(1, (gt > sw.gw ? 12 : 6) * h);
    sw.thG += M.wrap_angle(I.thG - sw.thG) * min(1, 8 * h);
    let th = sw.thE + sw.gw * M.wrap_angle(sw.thG - sw.thE);
    if (I.extW > 0) th += I.extW * M.wrap_angle(I.extTh - th);
    sw.th = th;
    const ct = M.cos(th), st = M.sin(th);
    // forces: gravity, buoyancy + drag in water, linear air drag, rope pull on the head
    const g = I.g, nh = 3;
    for (let i = 0; i < N; i++) {
      let ay = -g, ax = 0;
      if (I.surf > -1e8) {
        const sub = M.clamp((I.surf - (sw.py[i] - sw.rad[i] * 0.5)) / (sw.rad[i] * 2 + 1e-3), 0, 1);
        ay += g * K.BUOY * sub * 1.0; sw.vx[i] *= 1 - min(0.5, K.WDRAG * sub * h); sw.vy[i] *= 1 - min(0.5, K.WDRAG * sub * h);
      }
      if (i >= N - nh && (I.hx || I.hy)) {
        ax += I.hx;
        ay += I.hy;
      }
      sw.vx[i] += ax * h; sw.vy[i] += ay * h;
    }
    // rigid modes: keep their momentum, damp only the deformation; angular drag in the air; the salto torque
    let wn = 0, wd = 0;
    for (let i = 0; i < N; i++) {
      const rx = sw.px[i] - cx, ry = sw.py[i] - cy;
      wn += rx * (sw.vy[i]) - ry * (sw.vx[i]);
      wd += rx * rx + ry * ry;
    }
    vcx = 0;
    vcy = 0;
    for (let i = 0; i < N; i++) {
      vcx += sw.vx[i];
      vcy += sw.vy[i];
    }
    vcx /= N;
    vcy /= N;
    wn = 0;
    for (let i = 0; i < N; i++) {
      const rx = sw.px[i] - cx, ry = sw.py[i] - cy;
      wn += rx * (sw.vy[i] - vcy) - ry * (sw.vx[i] - vcx);
    }
    const w0 = wd > 1e-6 ? wn / wd : 0;
    sw.wz = w0;
    let w1 = w0;
    const air = 1 - sw.gw;
    w1 *= M.exp(-K.KW_AIR * air * h);
    if (I.spin !== 0) w1 += (I.spin - w1) * min(1, 18 * h);
    // P88: on the ground the whole body is tied to the sim worm by the soft pin (a spring on the centroid): left
    // undamped it is a ball on a rubber band (the rigid translation keeps its momentum), which is the jelly bounce in
    // place. The motion of the centroid relative to the sim worm is damped (calm bodies only: a crash / a hit keeps its
    // designed rebound)
    {
      const kc = K.KC_REL * sw.gw * (1 - sw.crash) * (1 - min(1, sw.shock * 2)) * h;
      if (kc > 0) {
        const f = 1 - M.exp(-kc), rx_ = (vcx - sw.svx) * f, ry_ = (vcy - sw.svy) * f;
        for (let i = 0; i < N; i++) {
          sw.vx[i] -= rx_;
          sw.vy[i] -= ry_;
        }
        vcx -= rx_;
        vcy -= ry_;
      }
    }
    const kd = 1 - K.KD * (0.5 + 0.5 * I.tone * (1 - K.SHOCK_SOFT * sw.shock)) * (1 - K.CR_KD * sw.crash) * kf,
      ka = M.exp(-K.KV_AIR * air * h);
    for (let i = 0; i < N; i++) {
      const rx = sw.px[i] - cx, ry = sw.py[i] - cy;
      const rvx = sw.vx[i] - vcx + w0 * ry, rvy = sw.vy[i] - vcy - w0 * rx;            // velocity relative to the rigid motion
      sw.vx[i] = vcx * ka + w1 * (-ry) + rvx * kd; sw.vy[i] = vcy * ka + w1 * rx + rvy * kd;
      const sp = M.len2(sw.vx[i], sw.vy[i]);
      if (sp > K.VMAX) {
        const q = K.VMAX / sp;
        sw.vx[i] *= q;
        sw.vy[i] *= q;
      }
    }
    // a crash (steep + fast landing): the velocity relative to the sim worm along the ground is absorbed (the body
    // stays where the sim worm is)
    sw.crash = max(0, sw.crash - K.CR_DECAY * h * (gt > 0.5 ? 1 : 4));
    if (sw.crash > 0) {
      const tc0 = M.cos(sw.thG), ts0 = M.sin(sw.thG), ka2 = K.CR_ABS * sw.crash;
      for (let i = 0; i < N; i++) {
        const rv = (sw.vx[i] - sw.svx) * tc0 + (sw.vy[i] - sw.svy) * ts0;
        sw.vx[i] -= rv * ka2 * tc0;
        sw.vy[i] -= rv * ka2 * ts0;
      }
    }
    // predict
    for (let i = 0; i < N; i++) {
      sw.tmx[i] = sw.px[i];
      sw.tmy[i] = sw.py[i];
      sw.px[i] += sw.vx[i] * h;
      sw.py[i] += sw.vy[i] * h;
    }
    // volume: radius from the stretch of the two segments around the node
    for (let i = 0; i < N; i++) {
      const a = i > 0 ? i - 1 : 0, b = i < N - 1 ? i + 1 : N - 1, l = M.len2(sw.px[b] - sw.px[a], sw.py[b] - sw.py[a]) + 1e-6,
        l0 = M.len2((sw.gx[b] - sw.gx[a]) * fs, sw.gy[b] - sw.gy[a]) + 1e-6;
      sw.len[i] = l0 / l;
    }
    for (let i = 0; i < N; i++) {
      const q = M.clamp(Math.sqrt(sw.len[i]), K.VOL_MIN, K.VOL_MAX), tgt = sw.r0[i] * q;
      sw.rad[i] += (tgt - sw.rad[i]) * min(1, 30 * h);
    }
    // constraint passes
    sw.shock = max(0, sw.shock - K.SHOCK_DECAY * h);
    const tone = I.tone * (1 - K.SHOCK_SOFT * sw.shock) * (1 - K.AIR_SOFT * air) * (1 - K.CR_SOFT * sw.crash),
      ash = K.A_SHAPE * (0.25 + 0.75 * tone),
      pinT = ((K.PIN_T * gt + K.PIN_A * (1 - gt)) * (1 - K.SHOCK_PIN * sw.shock)) * (1 - sw.crash) + K.CR_PIN * sw.crash,
      pinN = (K.PIN_N * gt + K.PIN_A * (1 - gt)) * (1 - sw.crash) + K.CR_PIN_N * sw.crash,
      tcx = M.cos(sw.thG),
      tcy = M.sin(sw.thG);
    // the pin target of the centroid: the sim worm + the goal centroid offset carried by the frame
    const tx = I.x + gcx * ct - gcy * st - sw.snx * sw.sg, ty = I.y + gcx * st + gcy * ct - sw.sny * sw.sg;
    const vrx = I.vref * K.VREF_K, vry = 0, mu = I.mu;
    let maxPen = 0, nc = 0;
    for (let i = 0; i < N; i++) sw.cn[i] = 0;
    CN.x = 0; CN.y = 0; CG.gap = 9;
    for (let it = 0; it < K.ITER; it++) {
      for (let i = 0; i < N - 1; i++) {                                             // neighbours: stretch / compress
        const dx = sw.px[i + 1] - sw.px[i],
          dy = sw.py[i + 1] - sw.py[i],
          l = M.len2(dx, dy) + 1e-9,
          l0 = M.len2((sw.gx[i + 1] - sw.gx[i]) * fs, sw.gy[i + 1] - sw.gy[i]);
        const c = (l - l0) / l * 0.5 * K.D_NEI * (l < l0 ? K.D_COMP + (1 - K.D_COMP) * tone : 1);
        sw.px[i] += dx * c;
        sw.py[i] += dy * c;
        sw.px[i + 1] -= dx * c;
        sw.py[i + 1] -= dy * c;
      }
      for (let i = 0; i < N - 2; i++) {                                             // skip-2: no sharp kinks
        const dx = sw.px[i + 2] - sw.px[i],
          dy = sw.py[i + 2] - sw.py[i],
          l = M.len2(dx, dy) + 1e-9,
          l0 = M.len2((sw.gx[i + 2] - sw.gx[i]) * fs, sw.gy[i + 2] - sw.gy[i]);
        const c = (l - l0) / l * 0.5 * K.D_SKIP * (l < l0 ? 0.3 : 1) * (0.3 + 0.7 * tone);
        sw.px[i] += dx * c;
        sw.py[i] += dy * c;
        sw.px[i + 2] -= dx * c;
        sw.py[i + 2] -= dy * c;
      }
      // shape matching toward the goal pose carried by the frame (centroid = the current one: translation is free)
      let ccx = 0, ccy = 0;
      for (let i = 0; i < N; i++) {
        ccx += sw.px[i];
        ccy += sw.py[i];
      }
      ccx /= N;
      ccy /= N;
      for (let i = 0; i < N; i++) {
        const ux = ccx + sw.ax[i] * ct - sw.ay[i] * st, uy = ccy + sw.ax[i] * st + sw.ay[i] * ct, a = ash * (1 - 0.35 * i / (N - 1));
        sw.px[i] += (ux - sw.px[i]) * a; sw.py[i] += (uy - sw.py[i]) * a;
      }
      // the soft pin of the centroid to the sim worm (the sim carries the translation; the body may deform around it)
      ccx = 0;
      ccy = 0;
      for (let i = 0; i < N; i++) {
        ccx += sw.px[i];
        ccy += sw.py[i];
      }
      ccx /= N;
      ccy /= N;
      {
        const dx = tx - ccx,
          dy = ty - ccy,
          dt_ = dx * tcx + dy * tcy,
          dn_ = -dx * tcy + dy * tcx,
          a_ = dt_ * pinT,
          b_ = dn_ * pinN,
          ex = a_ * tcx - b_ * tcy,
          ey = a_ * tcy + b_ * tcx;
        for (let i = 0; i < N; i++) {
          sw.px[i] += ex;
          sw.py[i] += ey;
        }
      }
      for (let i = 0; i < N; i++) {
        const p = contact(sw, i, env, mu, vrx * sw.gw, vry, h);
        if (p > 0) {
          nc++;
          sw.cn[i] = 1;
          if (p > maxPen) maxPen = p;
        }
      }
    }
    // P88: SNAP. The sim says the worm stands on the ground (its disc touches it), so the belly of the body touches it
    // too. The disc of the sim is a coarse shape (on a 35 degree slope the body hovered 0.15-0.25 m: a worm "floating"
    // above a slope, sliding down it with no contact). While grounded and calm the PIN TARGET is lowered along the
    // surface normal by sg (m): an integrator on the gap of the closest node (it stops when the belly touches), so the
    // pin and the contact agree and nothing fights (a direct push down against the pin made the body buzz at the frame
    // rate)
    if (I.ground > 0.5 && sw.gw > 0.5 && sw.crash < 0.2 && CG.gap < K.SNAP_MAX_GAP) {
      sw.sg = M.clamp(sw.sg + (CG.gap - K.SNAP_GAP) * K.SNAP_RATE * h, 0, K.SNAP_MAX_GAP);
      sw.snx = CG.nx;
      sw.sny = CG.ny;
    }
    else sw.sg *= M.exp(-8 * h);
    // the body's own landing: the first contact after flight, fast along the surface normal (blast-launched worms
    // bounce in the sim without a 'land' event)
    sw.lcool = max(0, sw.lcool - h);
    if (nc > 0 && sw.cprev === 0 && sw.lcool <= 0) {
      const cl = M.len2(CN.x, CN.y);
      if (cl > 1e-6) {
        const nx = CN.x / cl, ny = CN.y / cl, hp = hist_peak(sw), vn = -(hp.x * nx + hp.y * ny), vt = hp.x * ny - hp.y * nx;
        if (vn > K.AUTO_V) land_apply(sw, vn, vt, nx, ny);
      }
    }
    sw.cprev = nc;
    sw.pen = maxPen; sw.contacts = nc; sw.cg += ((nc >= 2 ? 1 : 0) - sw.cg) * min(1, 15 * h);
    // velocities from the corrected positions
    const ih = 1 / h;
    let en = 0;
    for (let i = 0; i < N; i++) {
      sw.vx[i] = (sw.px[i] - sw.tmx[i]) * ih;
      sw.vy[i] = (sw.py[i] - sw.tmy[i]) * ih;
      if (sw.cn[i] > 0 && sw.vx[i] * sw.vx[i] + sw.vy[i] * sw.vy[i] < K.CSLOW * K.CSLOW) {
        sw.vx[i] *= 1 - K.CDAMP;
        sw.vy[i] *= 1 - K.CDAMP;
      }
      en += sw.vx[i] * sw.vx[i] + sw.vy[i] * sw.vy[i];
    }
    sw.en = 0.5 * en / N;
  }

  /* advance by dt (the frame time) with fixed sub-steps; the sim worm's input moves linearly from its last value to
   * in.x / in.y */
  SW.advance = function (sw, dt, env) {
    const I = sw.in;
    if (!sw.init) SW.reset(sw, I.x, I.y);
    if (!(dt > 0)) return;
    sw.acc += min(dt, SW.H * K.MAX_SUB);
    const n = Math.floor(sw.acc / SW.H + 1e-9);
    if (n <= 0) return;
    sw.acc -= n * SW.H;
    const tx = I.x, ty = I.y, x0 = I.px, y0 = I.py;
    let lx = x0, ly = y0;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      I.x = x0 + (tx - x0) * t;
      I.y = y0 + (ty - y0) * t;
      sw.svx = (I.x - lx) / SW.H;
      sw.svy = (I.y - ly) / SW.H;
      lx = I.x;
      ly = I.y;
      substep(sw, SW.H, env, 1);
    }
    I.x = tx;
    I.y = ty;
    I.px = tx;
    I.py = ty;
    // guard: NaN / a node thrown far from the sim worm -> back on the goal pose
    let bad = false;
    for (let i = 0; i < N; i++) {
      const dx = sw.px[i] - tx, dy = sw.py[i] - ty;
      if (!(dx * dx + dy * dy < K.RMAX * K.RMAX)) {
        bad = true;
        break;
      }
    }
    if (bad) SW.reset(sw, tx, ty);
  };
})(window.SS = window.SS || {});
