/* sim/traverse.js — P37 W2: how a worm gets about: the ninja rope (Worms Armageddon style), the parachute and the
 * zipline.
 * Portable and deterministic (fixed step, no RNG at all, SS.math only, in-plane (s, y) like the rest of the active-worm
 * code); all state lives in S (snapshot / replay / lockstep safe). Free functions over S, plain structs, no classes.
 *
 * C layout
 *   struct Rope   { f32 s, y;            // the CURRENT pivot in the section (the anchor, or the newest bend)
 *                   f32 len;             // free length from the pivot to the worm (m)
 *                   bool hooked;         // false only while the plane rotates (re-seat)
 *                   Pin pins[50]; f32 fixed;   // earlier pivots (newest last); fixed = their summed segment length
 *                   u8 slack; };         // render hint: the worm is inside the rope length (set by rope_step)
 *   struct Pin    { f32 s, y; i8 side; };
 *   struct Hook   { f32 s, y, ds, dy, dist; };                    // the flying grapple (S.hook, null when none)
 *   struct RopeMem{ f32 aim; i8 chain; f32 relT; };               // S.ropeMem: aim of the last shot, "in a rope chain"
 *                                                                 // (released, still airborne), time of the release
 *   struct Chute  { u8 open; i32 wid; f32 t, sway, steer; };      // S.chute (the active worm's parachute), t = s open
 *   struct Zip    { u8 state; i32 wid; f32 as, ay, bs, by, len, t, v, age; Bolt bolt; };   // S.zip, state 0 none, 1
 *   bolt
 *                                                                 // flying, 2 riding, 3 line left behind (until next
 * turn) API
 *   rope_fire(S)  hook_step(S, a, dt)  hook_resolve(S)  rope_control(S, a, dt, inp, mv, retreat)  rope_release(S, a)
 *   air_pre(S, a, dt, inp, mv)         before the air flight: chute auto-open, drag, wind, steering; rope-chain upkeep
 *   tool(S, a, dt, inp, retreat)       fire key of the parachute / zipline weapons;  step(S, a, dt)  the bolt flight
 *   riding(S)  zip_control(S, a, dt, inp, mv)   the zipline ride;   busy(S)  reset(S)  on_end(S)  clamp_aim(S)
 *
 * ROPE — Worms Armageddon rope, as far as it can be reconstructed from the game's behaviour (no binary was read; every
 * number below is a tuned assumption, see docs/notes/P37-W2.md):
 *   - fired along the aim to ROPE_MAX; bites the first solid (terrain / prop); the worm hangs where it is.
 *   - the worm is a MASS: a pendulum under gravity (G_WORM x gravity_k); only the speed along the rope is removed when
 *     the rope is taut, so the swing is conservative (a tiny rope friction DAMP). Reeling conserves angular momentum
 *     (shorter rope = faster swing). Left / right pump: a tangential push (PUMP_K x gravity) toward the key; up / down
 *     reel in / out.
 *   - the rope bends around terrain corners (pins) and unwinds when the worm swings back.
 *   - letting go (Space / Enter) keeps the full velocity: a ballistic flight with a forward salto (tumble).
 *   - angle memory: the aim stays what it was when the rope was shot. Shooting again while still airborne goes at that
 *     angle toward the TRAVEL direction; pressing it again within QUICK s of the release mirrors it (opposite
 *     direction, same angle). Keep going one way and every shot goes that way at the same angle: chained swings.
 *   - rope knocking: swinging into another worm shoves it along the swing. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane;
  const T = SS.traverse = {};
  const PX = 0.0643;                                    // 1 PoC px in metres
  const R = C.TRAV = {
    ROPE: { PUMP_K: 0.4, REEL_IN: 6.5, REEL_OUT: 7.5, LEN_MIN: 0.64, DAMP: 0.03, VMAX: 45, HOOK_V: 1700 * PX, HOP_UP: 220 * PX,
      HOP_SIDE: 145 * PX, HOP_PAY: 24 * PX, HOP_COOL: 0.38,
      QUICK: 0.25, KNOCK_K: 0.9, KNOCK_MIN: 3, KNOCK_MAX: 16, KNOCK_UP: 3, KNOCK_COOL: 0.4, KNOCK_SELF: 0.45, SPIN_V: 4, SPIN_W0: 5,
      SPIN_W1: 13 },
    // parachute: OPEN_VY open below this fall speed (a ~3.2 m drop under G_WORM), OPEN_T inflates over 0.45 s, DRAG the
    // vertical drag rate (terminal sink = G_WORM / DRAG = 3.5 m/s), H_RATE how fast the horizontal speed follows the
    // wind (1/s), WIND_K the share of the wind speed the canopy reaches, STEER the left / right speed (m/s), FLARE the
    // braking within FLARE_H m of the ground
    CHUTE: { OPEN_VY: 13, OPEN_T: 0.45, DRAG: 9.55, H_RATE: 1.6, WIND_K: 0.9, STEER: 2.2, WIND_H: 2.5, FLARE_H: 1.6, FLARE_RATE: 7 },
    // zipline: RANGE m (bolt flight), BOLT_V m/s, MIN_ANGLE the shallowest aim (rad below horizontal), MIN_DROP the
    // least height the line must lose, MIN_LEN, HANG the worm's centre below the line at the start (it hoists itself
    // LIFT m up over LIFT_T s, so it clears the ground it stood on), G_K the share of worm gravity pulling
    // along the line, MU kinetic friction, DRAG 1/s, VMAX m/s, PUSH m/s2 from left / right, END_K the speed kept when
    // the line ends, DROP_UP a hop when letting go
    ZIP: {
      RANGE: 60, BOLT_V: 90, MIN_ANGLE: 0.12, MIN_DROP: 0.8, MIN_LEN: 3, HANG: 1.15, LIFT: 0.45, LIFT_T: 0.25, G_K: 0.4, MU: 0.05,
      DRAG: 0.03, VMAX: 16, PUSH: 3, END_K: 0.5, DROP_UP: 3
    }
  };
  const RP = R.ROPE, CH = R.CHUTE, ZP = R.ZIP;
  const sim = () => SS.sim, log = (S, m, c) => sim().log(S, m, c), emit = (S, t, d) => sim().emit(S, t, d);
  const gk = (S, a) => (sim().gravity_k ? sim().gravity_k(S, a) : 1);
  const setPos = (S, a, s, y) => {
    const p = P.to_world(S, s, y);
    a.pos.x = p.x;
    a.pos.y = y;
    a.pos.z = p.z;
  };
  const NSUB = 8;
  const mem = S => S.ropeMem;
  /* the rope struct (S.rope, null when none): C: struct Rope { f32 s, y, len; u8 hooked; Pin pins[50]; i32 npins; f32
   * fixed (length wound round pins), slack; } */
  T.rope_make = (s, y, len, hooked) => ({ s, y, len, hooked, pins: [], fixed: 0, slack: 0 });

  /* ================================ NINJA ROPE ================================ */
  // PoC fireRope / updateHook: the hook FLIES (1700 px/s = 109 m/s) from the hand along the aim, up to ROPE_MAX, and
  // catches the first solid (terrain or a prop on the section); the worm is attached when it bites
  T.rope_fire = function (S) {
    const a = S.active, m = mem(S);
    // shooting again mid-air after a release: the angle is kept, the side follows the flight
    if (a.air && m.chain) {
      let dir = Math.abs(a.vs) > 1 ? (a.vs > 0 ? 1 : -1) : a.facing;
      if (S.time - m.relT < RP.QUICK) dir = -dir;         // pressed again at once: the opposite direction, same angle
      a.facing = dir;
    }
    const ap = P.to_plane(S, a.pos), d = sim().aim_dir(S);
    S.hook = { s: ap.s + d.s * 0.4, y: a.pos.y + d.y * 0.4, ds: d.s, dy: d.y, dist: 0.4 };
    m.aim = S.aim;
    emit(S, 'rope_fire', P.to_world(S, S.hook.s, S.hook.y));
  };
  T.hook_step = function (S, a, dt) {
    const k = S.hook, step = 0.1, n = Math.ceil(RP.HOOK_V * dt / step);
    for (let i = 0; i < n; i++) {
      k.s += k.ds * step; k.y += k.dy * step; k.dist += step;
      if (P.solid2(S, k.s, k.y) || (S.planeBodies.length && P.body_at2(S, k.s, k.y, true) >= 0)) {   // terrain or a prop (not a worm)
        const ap = P.to_plane(S, a.pos), L = M.len2(k.s - ap.s, k.y - a.pos.y);
        S.rope = T.rope_make(k.s, k.y, M.max(C.ROPE_MIN, L), true); a.air = true; S.hook = null;
        a.flip = false; a.hop = false;                    // the tumble ends: it hangs now
        log(S, `Rope attached ${L.toFixed(1)} m away.`);
        emit(S, 'rope_hook', P.to_world(S, k.s, k.y));
        return;
      }
      if (k.dist >= C.ROPE_MAX || k.y < 0.2 || k.y > SS.world.SY + 2) {
        S.hook = null;
        log(S, `Nothing within ${C.ROPE_MAX.toFixed(0)} m on this section for the rope.`, 0xffb27a);
        return;
      }
    }
  };
  // fly the hook to its end at once (tests / tools: same steps as the live flight, the worm does not move meanwhile)
  T.hook_resolve = function (S) {
    for (let i = 0; S.hook && i < 1000; i++) T.hook_step(S, S.active, C.STEP);
  };

  // letting go: the worm keeps its velocity (ballistic flight under the worm gravity in step2D) and tumbles forward
  T.rope_release = function (S, a) {
    const m = mem(S), sp = M.len2(a.vs, a.vy);
    S.rope = null; a.air = true;
    m.chain = 1; m.relT = S.time;
    if (Math.abs(a.vs) > 0.5) a.facing = a.vs > 0 ? 1 : -1;          // it faces where it flies
    if (sp > RP.SPIN_V) {
      a.flip = true;
      a.flipAt = S.time;
      a.flipRope = S.time;
      a.flipK = -1;
      a.flipW = M.clamp(sp * 0.45, RP.SPIN_W0, RP.SPIN_W1);
      a.hop = false;
    }
    emit(S, 'rope_release', { wormId: a.id, speed: sp });
  };

  function lineBlocked(S, s0, y0, s1, y1, skip0, skip1) {
    const L = M.len2(s1 - s0, y1 - y0);
    if (L < 1e-3) return false;
    for (let d = skip0; d < L - skip1; d += 0.12) {
      const f = d / L;
      if (P.solid2(S, s0 + (s1 - s0) * f, y0 + (y1 - y0) * f)) return true;
    }
    return false;
  }
  // the corner the rope now bends around: sweep the line's end from where the worm was to where it is, take the first
  // blocked line, then its first solid sample from the pivot, backed off out of the rock
  function ropeCorner(S, r, ps, py, s, y) {
    for (let k = 1; k <= 8; k++) {
      const es = ps + (s - ps) * k / 8, ey = py + (y - py) * k / 8, L = M.len2(es - r.s, ey - r.y);
      if (!lineBlocked(S, r.s, r.y, es, ey, 0.15, 0.3)) continue;
      for (let d = 0.15; d < L; d += 0.06) {
        const f = d / L, qs = r.s + (es - r.s) * f, qy = r.y + (ey - r.y) * f;
        if (P.solid2(S, qs, qy)) {
          const n = P.normal2(S, qs, qy), b = M.max(0, d - 0.06) / L;
          return { s: r.s + (es - r.s) * b + n.s * 0.12, y: r.y + (ey - r.y) * b + n.y * 0.12 };
        }
      }
    }
    return null;
  }
  // While the plane rotates, the rope keeps its in-plane offset (it turns with the plane). When rotation settles, it
  // re-hooks on the new section along that same line, or is released.
  function reseat(S) {
    const a = S.active, r = S.rope, ap = P.to_plane(S, a.pos);
    const dx = r.s - ap.s, dy = r.y - a.pos.y, L = M.nz(M.len2(dx, dy), 1);
    for (let q = 0.5; q <= C.ROPE_MAX; q += 0.1) {
      const s = ap.s + dx / L * q, y = a.pos.y + dy / L * q;
      if (P.solid2(S, s, y)) {
        r.s = s;
        r.y = y;
        r.len = M.max(C.ROPE_MIN, q);
        r.hooked = true;
        r.pins = [];
        r.fixed = 0;
        log(S, `Rope re-hooked on the new section (${q.toFixed(1)} m).`, 0xfff3b0);
        emit(S, 'rope_hook', P.to_world(S, s, y));
        return;
      }
    }
    log(S, 'No terrain on the rope line in this section – rope released.', 0xffb27a);
    T.rope_release(S, a);
  }
  // swinging into another worm shoves it along the swing (rope knocking); the swinger loses some of its speed
  function knock(S, a, s, y) {
    const B = S.planeBodies, d = P.dir(S);
    for (let i = 0; i < B.length; i++) {
      // (P38-R5: PlaneBody.worm is a worm id, -1 = none since R7; it was still used as an object: a CPU swinging into a
      // worm crashed the sim)
      const b = B[i];
      if (b.worm < 0 || b.worm === a.id || S.worms[b.worm].shoveT > S.time) continue;
      const ds = b.s - s, dy = b.y - y, L = M.len2(ds, dy);
      if (L >= 2 * C.WORM_R || L < 1e-3) continue;
      const ns = ds / L, ny = dy / L, vn = a.vs * ns + a.vy * ny;
      if (vn < 1) continue;
      const o = S.worms[b.worm], v = M.clamp(vn * RP.KNOCK_K, RP.KNOCK_MIN, RP.KNOCK_MAX);
      o.rest = false;
      o.vel.x += d.x * ns * v;
      o.vel.z += d.z * ns * v;
      o.vel.y = M.max(M.max(o.vel.y, ny * v), RP.KNOCK_UP);
      o.slide = true;
      o.shoveT = S.time + RP.KNOCK_COOL;
      if (o.rope) o.rope = null;
      a.vs -= ns * vn * RP.KNOCK_SELF; a.vy -= ny * vn * RP.KNOCK_SELF;
      emit(S, 'rope_knock', { wormId: o.id, speed: vn });
    }
  }
  function rope_step(S, a, dt, mv, up, down) {
    const r = S.rope;
    let s = P.to_plane(S, a.pos).s, y = a.pos.y;
    const GW = C.G_WORM * gk(S, a), len0 = r.len;
    if (up) r.len = M.max(RP.LEN_MIN, r.len - RP.REEL_IN * dt);
    if (down) r.len = M.min(C.ROPE_MAX - r.fixed, r.len + RP.REEL_OUT * dt);
    if (mv) a.facing = mv;
    let dx = s - r.s, dy = y - r.y, L = M.nz(M.len2(dx, dy), 1);
    const taut = L > len0 - 0.35;
    // reeling keeps the angular momentum: the speed across the rope scales with the old / new length
    if (taut && r.len !== len0) {
      const rv = (a.vs * dx + a.vy * dy) / L, rs = dx / L, ry = dy / L, k = len0 / r.len;
      const ts = a.vs - rv * rs, ty = a.vy - rv * ry;
      a.vs = rv * rs + ts * k;
      a.vy = rv * ry + ty * k;
    }
    // the pendulum in NSUB sub-steps (the rope constraint bleeds energy O(dt) per step: 4 sub-steps keep a 20 s swing
    // within ~1 %): gravity, the pump, the friction, the move, then back onto the rope circle without its outward speed
    const reelV = (r.len - len0) / dt, lim = M.min(0, reelV), h = dt / NSUB;
    let ns = s, ny = y;
    for (let k = 0; k < NSUB; k++) {
      // P68c: the pendulum under the chunk fields
      if (S.eow) SS.eow.rope_g(S, a, h);
      else a.vy -= GW * h;
      dx = ns - r.s; dy = ny - r.y; L = M.nz(M.len2(dx, dy), 1);
      // pumping: a tangential push toward the pressed side while the rope is taut (an upward push when the rope lies
      // almost horizontal and the tangent is vertical)
      if (mv && L > r.len - 0.35) {
        let ts = -dy / L, ty = dx / L;
        if (Math.abs(ts) > 0.12) {
          if (ts * mv < 0) {
            ts = -ts;
            ty = -ty;
          }
        } else if (ty < 0) {
          ts = -ts;
          ty = -ty;
        }
        a.vs += ts * RP.PUMP_K * C.G_WORM * h; a.vy += ty * RP.PUMP_K * C.G_WORM * h;
      }
      const damp = M.exp(-RP.DAMP * h);
      a.vs *= damp;
      a.vy *= damp;
      const sp = M.len2(a.vs, a.vy);
      if (sp > RP.VMAX) {
        a.vs *= RP.VMAX / sp;
        a.vy *= RP.VMAX / sp;
      }
      ns += a.vs * h; ny += a.vy * h;
      dx = ns - r.s; dy = ny - r.y; L = M.len2(dx, dy);
      if (L > r.len) {
        ns = r.s + dx / L * r.len; ny = r.y + dy / L * r.len;
        const rv = (a.vs * dx + a.vy * dy) / L;
        if (rv > lim) {
          a.vs -= (rv - lim) * dx / L;
          a.vy -= (rv - lim) * dy / L;
        }
      }
    }
    r.slack = M.len2(ns - r.s, ny - r.y) < r.len - 0.05 ? 1 : 0;
    knock(S, a, ns, ny);
    const base = P.overlap2(S, s, y);
    if (P.overlap2(S, ns, ny) <= base) {
      s = ns;
      y = ny;
    }
    else if (P.overlap2(S, ns, y) <= base) {
      s = ns;
      a.vy *= -0.3;
    }
    else if (P.overlap2(S, s, ny) <= base) {
      y = ny;
      a.vs *= -0.3;
    }
    else {
      a.vs *= -0.3;
      a.vy *= -0.3;
    }
    const ps = P.to_plane(S, a.pos).s, py = a.pos.y;
    setPos(S, a, s, y);
    // wrap around a corner the line to the pivot now cuts through
    if (r.pins.length < 50 && lineBlocked(S, r.s, r.y, s, y, 0.15, 0.3)) {
      const c = ropeCorner(S, r, ps, py, s, y);
      if (c) {
        const seg = M.len2(c.s - r.s, c.y - r.y), side = Math.sign((c.s - r.s) * (y - c.y) - (c.y - r.y) * (s - c.s)) || 1;
        if (seg > 0.2 && r.len - seg > C.ROPE_MIN * 0.5) {
          r.pins.push({ s: r.s, y: r.y, side });
          r.fixed += seg;
          r.len -= seg;
          r.s = c.s;
          r.y = c.y;
          emit(S, 'rope_wrap', P.to_world(S, c.s, c.y));
        }
      }
    }
    // unwrap: the worm swung back past the bend and sees the previous pivot again
    if (r.pins.length) {
      const q = r.pins[r.pins.length - 1], side = Math.sign((r.s - q.s) * (y - r.y) - (r.y - q.y) * (s - r.s));
      if (side && side !== q.side && !lineBlocked(S, q.s, q.y, s, y, 0.15, 0.3)) {
        const seg = M.len2(r.s - q.s, r.y - q.y);
        r.pins.pop();
        r.fixed -= seg;
        r.len += seg;
        r.s = q.s;
        r.y = q.y;
      }
    }
  }
  // the controls while hanging: Space / Enter let go (Enter drops a payload weapon instead when one is selected),
  // Backspace / down+arrow hops off the ground, left / right pump, up / down reel
  T.rope_control = function (S, a, dt, inp, mv, retreat) {
    const WP = SS.weapons;
    if (inp.drop && !retreat) {
      if (C.WEAPONS[S.weapon].payload && WP.can_use(S, S.weapon)) WP.rope_drop(S);
      else log(S, `Cannot drop the ${C.WEAPONS[S.weapon].name.toLowerCase()} from the rope.`, 0xffb27a);
      return;
    }
    if (inp.fire_pressed || inp.jump) {
      T.rope_release(S, a);
      return;
    }
    // (PoC ropeStep: also arrow + down)
    if (
      (inp.backflip || (mv && inp.down))
      && S.time - (S.ropeHopT == null ? -9 : S.ropeHopT) > RP.HOP_COOL
      && P.grounded2(S, P.to_plane(S, a.pos).s, a.pos.y)
    ) {
      const dir = mv || -a.facing;
      a.vy = M.max(a.vy, RP.HOP_UP);
      a.vs += dir * RP.HOP_SIDE;
      a.air = true;
      S.ropeHopT = S.time;
      a.squash = S.time;
      S.rope.len = M.min(M.max(C.ROPE_MIN, C.ROPE_MAX - (S.rope.fixed || 0)), S.rope.len + RP.HOP_PAY);
      emit(S, 'jump', M.v3_copy(a.pos));
      return;
    }
    if (!S.rope.hooked && S.time - S.lastRotate > 0.25 && S.thetaGoal == null) reseat(S);
    if (S.rope) rope_step(S, a, dt, mv, inp.up, inp.down);
  };

  /* ================================ PARACHUTE ================================ */
  const chute = S => S.chute;
  function chute_close(S) {
    if (S.chute) {
      S.chute.open = 0;
      S.chute.t = 0;
    }
  }
  function chute_open(S, a, why) {
    const c = chute(S);
    c.open = 1;
    c.wid = a.id;
    c.t = 0;
    c.sway = 0;
    c.steer = 0;
    a.flip = false;
    a.hop = false;
    SS.weapons.used(S, 'parachute', 0, true);
    emit(S, 'chute_open', { wormId: a.id, why });
    log(S, `${a.name} pulls the ripcord.`, sim().team_rgb(S, a.team));
  }
  // before the worm's air flight: auto-open while the parachute is the selected tool and the fall is fast, then the
  // drag (vertical: terminal sink G_WORM / DRAG), the wind (horizontal speed relaxes toward the wind) and the steering
  T.air_pre = function (S, a, dt, inp, mv) {
    const m = S.ropeMem;
    if (m && m.chain && (!a.air || inp.up || inp.down) && !S.rope) m.chain = 0;
    let c = S.chute;
    if (
      !(c && c.open)
      && S.weapon === 'parachute'
      && a.air
      && !a.dead
      && a.vy < -CH.OPEN_VY
      && SS.weapons.can_use(S, 'parachute')
      && !T.riding(S)
    ) chute_open(S, a, 'auto');
    c = S.chute;
    if (!c || !c.open) return;
    if (c.wid !== a.id || !a.air || a.slide || a.dead) {
      chute_close(S);
      return;
    }
    c.t += dt;
    const f = M.clamp(c.t / CH.OPEN_T, 0, 1), P2 = P.to_plane(S, a.pos), wv = { x: 0, y: 0, z: 0 };
    if (SS.weather && SS.weather.wind_at) SS.weather.wind_at(S, a.pos.x, a.pos.y + CH.WIND_H, a.pos.z, wv);
    const d = P.dir(S), ws = (wv.x * d.x + wv.z * d.z) * CH.WIND_K, wy = wv.y * CH.WIND_K;
    c.steer += (mv - c.steer) * M.min(1, dt * 6);
    let tvs = ws + c.steer * CH.STEER, rate = CH.H_RATE;
    // flare: close to the ground the canopy brakes the drift, so it comes down softly
    let near = false;
    for (let q = 0.4; q <= CH.FLARE_H && !near; q += 0.4)
      if (P.blocked2(S, P2.s, a.pos.y - C.WORM_R - q)) near = true;
    if (near) {
      tvs = 0;
      rate = CH.FLARE_RATE;
    }
    a.vs += -(a.vs - tvs) * rate * f * dt;
    a.vy += -(a.vy - wy) * CH.DRAG * f * dt;
    if (mv) a.facing = mv;
    c.sway += ((a.vs - tvs) * 0.05 + c.steer * 0.1 - c.sway) * M.min(1, dt * 3);   // render: the canopy leans (rad)
  };

  /* ================================ ZIPLINE ================================ */
  T.riding = S => !!(S.zip && S.zip.state === 2);
  T.busy = S => !!(S.zip && (S.zip.state === 1 || S.zip.state === 2));
  const zip = S => S.zip;
  function zipFire(S, a) {
    const z = zip(S), ap = P.to_plane(S, a.pos), d = sim().aim_dir(S);
    z.state = 1;
    z.wid = a.id;
    z.age = 0;
    z.as = ap.s;
    z.ay = a.pos.y + ZP.HANG;
    z.bolt = { s: ap.s + d.s * 0.4, y: a.pos.y + d.y * 0.4, ds: d.s, dy: d.y, dist: 0.4 };
    emit(S, 'zip_fire', P.to_world(S, z.bolt.s, z.bolt.y));
  }
  function zipBolt(S, a, dt) {
    const z = S.zip, k = z.bolt, step = 0.1, n = Math.ceil(ZP.BOLT_V * dt / step);
    for (let i = 0; i < n; i++) {
      k.s += k.ds * step; k.y += k.dy * step; k.dist += step;
      if (P.solid2(S, k.s, k.y) || (S.planeBodies.length && P.body_at2(S, k.s, k.y, true) >= 0)) {
        // (the bolt's tip, just in front of the surface)
        const bs = k.s - k.ds * 0.1, by = k.y - k.dy * 0.1, L = M.len2(bs - z.as, by - z.ay);
        z.bolt = null;
        if (L < ZP.MIN_LEN || z.ay - by < ZP.MIN_DROP) {
          z.state = 0;
          log(S, 'The line would hardly slope: aim lower or further away.', 0xffb27a);
          return;
        }
        if (P.solid2(S, z.as, z.ay) || lineBlocked(S, z.as, z.ay, bs, by, 0.1, 0.1)) {
          z.state = 0;
          log(S, 'The line is blocked.', 0xffb27a);
          return;
        }
        z.bs = bs;
        z.by = by;
        z.len = L;
        z.t = 0;
        z.v = 0;
        z.age = 0;
        z.state = 2;
        a.air = false;
        a.vs = 0;
        a.vy = 0;
        a.walking = false;
        a.flip = false;
        a.hop = false;
        a.facing = bs > z.as ? 1 : -1;
        SS.weapons.used(S, 'zipline', 0, true);
        emit(S, 'zip_hook', P.to_world(S, bs, by));
        log(S, `${a.name} rides a ${L.toFixed(0)} m zipline.`, sim().team_rgb(S, a.team));
        return;
      }
      if (k.dist >= ZP.RANGE || k.y < 0.2 || k.y > SS.world.SY + 2) {
        z.state = 0;
        z.bolt = null;
        log(S, `Nothing within ${ZP.RANGE.toFixed(0)} m to hook the line to.`, 0xffb27a);
        return;
      }
    }
  }
  // the ride ends: the worm leaves the line with (a share of) its speed along it
  function zipLeave(S, a, k, up) {
    const z = S.zip, L = z.len || 1, us = (z.bs - z.as) / L, uy = (z.by - z.ay) / L;
    a.air = true;
    a.vs = z.v * us * k;
    a.vy = z.v * uy * k + (up || 0);
    z.state = 3;
    z.age = 0;
    emit(S, 'zip_leave', { wormId: a.id, speed: z.v });
  }
  T.zip_control = function (S, a, dt, inp, mv) {
    const z = S.zip;
    if (z.wid !== a.id || a.dead) {
      z.state = 0;
      return;
    }
    // knocked off the line (a blast, a shove): it keeps what it was given
    if (a.air) {
      zipLeave(S, a, 1, 0);
      return;
    }
    if (inp.jump || inp.drop || inp.backflip || inp.fire_pressed) {
      zipLeave(S, a, 1, ZP.DROP_UP);
      return;
    }
    const L = z.len, us = (z.bs - z.as) / L, uy = (z.by - z.ay) / L, GW = C.G_WORM * gk(S, a) * ZP.G_K;
    const acc = GW * (-uy - ZP.MU * Math.abs(us)) + mv * (us >= 0 ? 1 : -1) * ZP.PUSH;
    z.v = M.clamp((z.v + acc * dt) * M.exp(-ZP.DRAG * dt), 0, ZP.VMAX);
    const t1 = z.t + z.v * dt,
      lr = M.clamp(z.age / ZP.LIFT_T, 0, 1),
      ns = z.as + us * t1,
      ny = z.ay + uy * t1 - ZP.HANG + ZP.LIFT * lr * lr * (3 - 2 * lr);
    const base = P.overlap2(S, P.to_plane(S, a.pos).s, a.pos.y);
    // end of the line, or rock in the way
    if (t1 >= L - 0.05 || P.overlap2(S, ns, ny) > M.max(base, 2) + 2) {
      zipLeave(S, a, ZP.END_K, 0);
      return;
    }
    z.t = t1;
    setPos(S, a, ns, ny);
    a.vs = z.v * us;
    a.vy = z.v * uy;
    a.facing = us >= 0 ? 1 : -1;
    z.age += dt;
  };

  // the fire key of the parachute / zipline weapons (called from controlActive for the selected weapon's kind)
  T.tool = function (S, a, dt, inp, retreat) {
    const k = C.WEAPONS[S.weapon].kind;
    if (!inp.fire_pressed) return;
    if (k === 'chute') {
      // fire again: cut it away
      if (S.chute && S.chute.open) {
        chute_close(S);
        emit(S, 'chute_cut', { wormId: a.id});
      }
      else if (!SS.weapons.can_use(S, 'parachute')) return;
      else if (a.air) chute_open(S, a, 'manual');
      else log(S, 'The parachute opens in the air: jump, or fall.', 0xffb27a);
    } else if (k === 'zip') {
      const z = zip(S);
      if (z.state === 1 || retreat || !SS.weapons.can_use(S, 'zipline')) return;
      if (a.air || a.walking) {
        log(S, 'Stand on the ground to string the line.', 0xffb27a);
        return;
      }
      zipFire(S, a);
    }
  };
  // the zipline bolt flight, once per step (called from controlActive before the worm's own movement)
  T.step = function (S, a, dt) {
    const z = S.zip;
    if (!z) return;
    if (z.state === 1) {
      if (z.wid !== a.id) {
        z.state = 0;
        z.bolt = null;
      } else zipBolt(S, a, dt);
    }
    else if (z.state === 3) z.age += dt;
  };
  // the weapon aim the zipline allows: horizontal-ish or below (the slide down is enforced)
  T.clamp_aim = function (S) {
    if (S.weapon === 'zipline' && S.aim > -ZP.MIN_ANGLE) S.aim = -ZP.MIN_ANGLE;
  };

  // the turn ends / a new turn / a worm switch: the line is cut, the chute folded
  T.reset = function (S) {
    if (S.zip) {
      S.zip.state = 0;
      S.zip.bolt = null;
    }
    chute_close(S);
  };
  // the retreat ends while the worm is on the line: it drops off with its speed (body3D takes over)
  T.on_end = function (S) {
    const a = S.active;
    if (a && !a.dead && T.riding(S)) zipLeave(S, a, 1, 0);
    chute_close(S);
    if (S.zip && S.zip.state === 1) {
      S.zip.state = 0;
      S.zip.bolt = null;
    }
  };
})(window.SS = window.SS || {});
