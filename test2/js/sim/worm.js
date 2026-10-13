/* sim/worm.js — how worms move and touch the world. The worm under control moves in its section plane (control_pre,
 * control_active, control_fire; step_2d: walking, jumps, flips, slides); every other worm is a 3D body (body_3d:
 * gravity, landings and fall damage, other worms, sleeping props, bridge decks, ropes). Pinning (a prop or rock on a
 * worm: it is moved out, else the prop breaks), wedged and entombed worms, the hazards (water, lava, hot sand, fire,
 * out of the field) and the team query living.
 * State: the S.worms[] fields (pos, vel, rest, slide, stillT, foot, rope, lsink ...); reads S.planeBodies, S.bodies.
 * API: ctl, control_pre, control_active, control_fire, step_2d, body_3d, hazards, unpin_others, unentomb, living,
 *   body_free, blocked3, deck_floor, walk_speed, gravity_k, jump_vs, aim_dir, weapon_ready, in_band, plane_lock,
 *   worm_under, wedge_free, lava_floor.
 * Determinism: no RNG; the module scratch (lc, lvv, wv, pn, pn2, pn3, pq) lives for one call. */
(function (SS) {
  'use strict';
  const WM = SS.worm;
  const C = SS.CFG;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const M = SS.math;
  const P = SS.plane;
  const MAT = C.MAT;
  const W = SS.world;
  const DRY = C.DRY;
  const DS = C.DS;
  const HF = C.HF;
  const wv = { x: 0, y: 0, z: 0 };
  const sim = SS.sim;
  const SP = SS.spawn;
  const DM = SS.damage;
  const SW = SS.swim;

  const lc = { sub: 0, heat: 0, surf: 0 };
  const lvv = { x: 0, y: 0, z: 0 };
  /* LV3: a worm floats on open lava (2600 kg/m3 vs ~1000): its foot rests at the lava surface minus its immersion
   * wm.lsink (hazards() relaxes it toward the buoyancy equilibrium); -1e9 = no open lava under it */
  // (user 2026-10-08: worms were "teleported to the top": the 2.5D lava column's surface was used whatever the worm's
  // height, so a worm in a cave under a lava-covered column snapped up through the rock: below the column's bed there
  // is no lava for it)
  function lavaFloor(S, x, z, wm) {
    if (!SS.lava || !S.lava) return -1e9;
    const ls = SS.lava.surface_at(S, x, z);
    if (ls < 0 || wm.pos.y - wm.foot < W.top_at(x, z) - 0.5) return -1e9;
    return ls - (wm.lsink || 0);
  }
  WM.lava_floor = lavaFloor;

  /* P38 R1: after all the voxel stamps (derelict hull, ruined town, rocks) a worm whose body overlaps solid rock
   * (spawned before the
   * stamps, which ignore it) is lifted to the nearest free standing spot: a ring search of 1.5 m steps out to 30 m.
   * Body test: the centre, the head and four mid-body rim points (a worm on an ordinary slope never trips it).
   * Layout-neutral on maps without a stamp: nothing moves. */
  function bodyFree(w, x, y, z) {
    const R = C.WORM_R, d = W;
    return !(
      d.sample(x, y, z) > 0 || d.sample(x, y + R * 0.9, z) > 0 || d.sample(x + R * 0.9, y + 0.1, z) > 0
      || d.sample(x - R * 0.9, y + 0.1, z) > 0 ||
      d.sample(x, y + 0.1, z + R * 0.9) > 0 || d.sample(x, y + 0.1, z - R * 0.9) > 0
    );
  }
  WM.body_free = bodyFree;

  /* P38 R9: the wedge resolver (a safety net: the causes are fixed where they arise, see body3D). A worm that is
   * airborne yet has not moved
   * vertically for WD.PIN_T s while its vertical speed says it falls is stuck inside rock (a blast threw it into a
   * slot, the ground rose around it). It is moved to the nearest spot (cube shells of PIN_STEP m out to PIN_R m, scan
   * order x, y, z: deterministic) where its whole body is free, not in lava, inside the play circle; none: it is
   * crushed. C: bool pin_step(Game*, Worm*, f32 y0, f32 dt), called at the end of body3D / step2D. */
  function wedge_free(S, o) {
    const w = W, st = WD.PIN_STEP, nmax = Math.round(WD.PIN_R / st);
    for (let n = 1; n <= nmax; n++)
      for (let iy = -n; iy <= n; iy++)
        for (let ix = -n; ix <= n; ix++)
          for (let iz = -n; iz <= n; iz++) {
            if (M.max(Math.abs(ix), M.max(Math.abs(iy), Math.abs(iz))) !== n || (w.flat && iz !== 0)) continue;
            const x = o.pos.x + ix * st, y = o.pos.y + iy * st, z = o.pos.z + iz * st;
            if (x < 2 || x > w.SX - 2 || !w.zin(z, 2) || y < 1 || y > w.SY - 2) continue;
            if (!bodyFree(o, x, y, z) || w.sample(x, y - o.foot, z) > 0 || w.mat_at(x, y, z) === MAT.LAVA || SP.near_lava(S, x, z))
              continue;
            if (w.dry && !SP.in_play(S, x, z)) continue;
            return { x, y, z };
          }
    return null;
  }
  WM.wedge_free = wedge_free;
  /* P88: a worm AT REST or walking inside solid ground (rubble / a collapse / a stamp landed on it, a hole closed over
   * it): its centre and its head both deep in rock.
   * rest / the ground checks only look below the feet, so it stayed there for good, and the soft body, buried in the
   * rock's field, went wild. Same rule as the runaway-speed wedge: the nearest free spot (wedge_free), else it is
   * crushed. Staggered (every 8th step per worm). */
  function unentomb(S, o) {
    if (S.eow || o.dead || o.drowning || o.swim || o.rope || ((S.tick + o.id * 5) & 7) !== 0) return;
    const w = W;
    if (!(w.sample(o.pos.x, o.pos.y, o.pos.z) > 0.3 && w.sample(o.pos.x, o.pos.y + 0.4, o.pos.z) > 0.3)) return;
    const f = wedge_free(S, o);
    if (!f) {
      sim.log(S, `${o.name} is buried in the rock.`, 0xff9a9a);
      DM.kill(S, o, 'crush');
      return;
    }
    o.pos.x = f.x;
    o.pos.y = f.y;
    o.pos.z = f.z;
    o.vel.x = o.vel.y = o.vel.z = 0;
    o.vs = 0;
    o.vy = 0;
    o.rest = false;
    o.slide = false;
    o.stillT = 0;
    o.air = true;
    o.flip = false;
    o.hop = false;
    sim.emit(S, EV.UNWEDGE, { wormId: o.id, x: f.x, y: f.y, z: f.z });
  }
  WM.unentomb = unentomb;
  function pin_step(S, o, y0, vyNow, dt) {
    if (Math.abs(o.pos.y - y0) < 1e-4 && Math.abs(vyNow) > 2) o.pinT += dt;
    else {
      o.pinT = 0;
      return false;
    }
    if (o.pinT < WD.PIN_T) return false;
    o.pinT = 0;
    const f = wedge_free(S, o);
    if (!f) {
      sim.log(S, `${o.name} is buried in the rock.`, 0xff9a9a);
      DM.kill(S, o, 'crush');
      return true;
    }
    o.pos.x = f.x;
    o.pos.y = f.y;
    o.pos.z = f.z;
    o.vel.x = o.vel.y = o.vel.z = 0;
    o.vs = 0;
    o.vy = 0;
    o.rest = false;
    o.slide = false;
    o.stillT = 0;
    o.air = true; o.flip = false; o.hop = false;
    sim.emit(S, EV.UNWEDGE, { wormId: o.id, x: f.x, y: f.y, z: f.z });
    return true;
  }

  /* ---------- turn flow ---------- */
  /* the worms still in the game (a worm at 0 HP is dying), optionally of one team: once per turn change (not per step);
   * a plain loop into a fresh array (C: fills a caller array) */
  function living(S, team) {
    const out = [];
    for (let i = 0; i < S.worms.length; i++) {
      const w = S.worms[i];
      if (!w.dead && w.hp > 0 && (team === undefined || w.team === team)) out.push(w);
    }
    return out;
  }
  WM.living = living;
  // a worm still in the game (a worm at 0 HP is dying: hurt clamps its HP to 0)
  WM.alive = w => !w.dead && w.hp > 0;
  // the HP of a team's worms still in the game
  WM.team_hp = function (S, team) {
    let h = 0;
    for (let i = 0; i < S.worms.length; i++) {
      const w = S.worms[i];
      if (!w.dead && w.hp > 0 && w.team === team) h += w.hp;
    }
    return h;
  };
  // the team still has a worm in the game
  WM.team_alive = function (S, team) {
    for (let i = 0; i < S.worms.length; i++) {
      const w = S.worms[i];
      if (!w.dead && w.hp > 0 && w.team === team) return true;
    }
    return false;
  };
  // PoC sniperAimRate: aim slows near what the scope points at (2.06 / max(1.41, dist) rad/s, 0.025 .. 1.5)
  function sniperRate(S, a) {
    const ad = WM.aim_dir(S), ap = P.to_plane(S, a.pos);
    for (let d = 0.6; d < 40; d += 0.25) {
      const s = ap.s + ad.s * d, y = a.pos.y + ad.y * d, p = P.to_world(S, s, y);
      if (P.solid2(S, s, y) || S.worms.some(o => !o.dead && o !== a && M.len3(o.pos.x - p.x, o.pos.y - y, o.pos.z - p.z) < C.WORM_R))
        return M.clamp(2.06 / M.max(1.41, d), 0.025, WD.AIM_RATE);
    }
    return WD.AIM_RATE;
  }

  /* ---------- active worm: 2D in the section ---------- */
  WM.aim_dir = S => ({ s: S.active.facing * M.cos(S.aim), y: M.sin(S.aim) });
  function setActive2D(S, a, s, y) {
    const p = P.to_world(S, s, y);
    a.pos.x = p.x;
    a.pos.y = y;
    a.pos.z = p.z;
  }

  /* ---------- PoC worm dynamics (C.WORM_DYN; game.js walkWorm / updateWorm / integrateBody) ---------- */
  const WD = C.WORM_DYN, GW = C.G_WORM;
  /* P37-7: a worm's walking speed (m/s) and gravity factor; the tool-crate skills (worm.skills: fastwalk / lowgrav,
   * turns
   * left) act here and nowhere else. sim.jump_vs: the horizontal speed of a forward jump. */
  // (P79 SLICK: mud slows the walk)
  WM.walk_speed = (S, w) => C.WALK
    * (w && w.skills && w.skills.fastwalk > 0 ? C.SKILL.FASTWALK_K : 1)
    * (SS.lab4 && S.lab ? SS.lab4.walk_k(S, w) : 1);
  WM.gravity_k = (S, w) => (w && w.skills && w.skills.lowgrav > 0 ? C.SKILL.LOWGRAV_K : 1) * (SS.lab ? SS.lab.gravity_k(S) : 1);
  // the forward jump covers what walking covers in the whole time (wind-up + flat flight 2 vy / g): spring speed = walk
  // x (T_w + T_air) / T_air
  WM.jump_vs = (S, w) => {
    const ta = 2 * WD.JUMP_VY / (GW * WM.gravity_k(S, w));
    return WM.walk_speed(S, w) * (WD.JUMP_WIND + ta) / ta;
  };
  const RIM = [];
  for (let i = 0; i < 12; i++) {
    const t = i / 12 * Math.PI * 2;
    RIM.push(M.cos(t) * C.WORM_R, M.sin(t) * C.WORM_R);
  }
  // contact normal of the worm disc at (s, y): away from the blocked rim points (null = no contact)
  function rimNormal(S, s, y) {
    let ns = 0, ny = 0, n = 0;
    for (let i = 0; i < RIM.length; i += 2)
      if (P.blocked2(S, s + RIM[i], y + RIM[i + 1])) {
        ns -= RIM[i];
        ny -= RIM[i + 1];
        n++;
      }
    if (!n) return null;
    const l = M.len2(ns, ny);
    return l < 1e-6 ? { s: 0, y: 1 } : { s: ns / l, y: ny / l };
  }
  // the worm disc overlaps another worm (walkWorm: then it may climb 18 px instead of 10)
  // (m: P88 reach margin)
  const onWorm = (S, a, s, y, m) => {
    for (const b of S.planeBodies)
      if (b.worm >= 0 && b.worm !== a.id && M.len2(b.s - s, b.y - y) < 2 * C.WORM_R - 0.02 + (m || 0)) return b;
    return null;
  };
  // landing damage (PoC: head-on / glancing, both only on floors and slopes), the spring trap's minimum
  function landHurt(S, w, dmg) {
    if (w.springFall) {
      w.springFall = false;
      dmg = M.max(dmg, C.ARMS.SPRING.FALL_MIN);
    }
    if (dmg > 0 && SS.lab) dmg = SS.lab.landing_dmg(S, w, dmg);      // (P50: the PADDED perk)
    if (dmg > 0) DM.hurt(S, w, dmg, DS.LANDING);
  }
  function landNow(S, a, impact) {
    a.iceV = SS.ice && S.ice && SS.ice.slippery(S, a.pos.x, a.pos.z) ? a.vs : 0;   // P30: lands sliding on bare ice
    a.air = false;
    a.vs = 0;
    a.vy = 0;
    a.flip = false;
    a.hop = false;
    a.slide = false;
    a.stillT = 0;
    if (a.springFall) landHurt(S, a, 0);
    if (impact > 2)
      sim.emit(S, EV.LAND, {
        wormId: a.id,
        x: a.pos.x,
        y: a.pos.y - 0.45,
        z: a.pos.z,
        speed: impact,
        mat: W.mat_at(a.pos.x, a.pos.y - 0.7, a.pos.z)
      });
    if (impact > 9.6) a.squash = S.time;
  }
  WM.weapon_ready = function (S, a) {                 // PoC weaponReady L4342
    // P107: a worm afloat in a life jacket may use what its weapon rule allows (SS.jacket.no_weapon)
    const jk = !!(a.swim && a.swim.jk);
    return !a.walking
      && (jk || !a.air)
      && !(a.windUp > 0)
      && !S.rope
      && !(S.zip && S.zip.state === 2)
      && !a.flip
      && !(a.dizzyUntil > S.time)
      && !(S.teleT > 0)
      && !a.drowning
      && (jk || !a.swim)
      && M.len2(a.vs || 0, a.vy || 0) < WD.READY_V;
  };
  /* PoC recoverPinnedWorm (L2009): a worm inside a resting prop (a crate landed on it, a boulder settled into it) moves
   * to the nearest spot where the WHOLE disc is free (up, sideways, the diagonals; up to 2 x the prop + the worm,
   * at most 110 px = 7.07 m), else the prop breaks (never a soft-locked worm); a worm "in the air" but slow, not
   * sliding / hopping / flipping and touching ground that stays within 2 px (0.13 m) for 0.18 s lands */
  const PIN_ANG = [Math.PI / 2, 0, Math.PI, Math.PI / 4, 3 * Math.PI / 4, -Math.PI / 4, -3 * Math.PI / 4];
  function pinningBody(S, s, y) {
    for (const b of S.planeBodies) {
      const rb = b.body >= 0 ? SS.bodies.by_id(S, b.body) : null;
      if (!rb || !rb.asleep) continue;
      if (P.pb_inside(b, s, y)) return b;
      for (let k = 0; k < 12; k++) {
        const t = k / 12 * Math.PI * 2;
        if (P.pb_inside(b, s + M.cos(t) * (C.WORM_R - PX), y + M.sin(t) * (C.WORM_R - PX))) return b;
      }
    }
    return null;
  }
  // the nearest spot where the whole disc is free of the pinning prop (null: none within reach)
  function pinFree(S, pin, s, y, radial) {
    const size = P.pb_size(pin), maxR = M.min(110 * PX, size * 2 + C.WORM_R);
    // (radial: away from the prop's centre, so a worm on a boulder's shoulder slides off instead of being lifted
    // straight up and dropped back in)
    const angs = radial ? [M.atan2(y - pin.y, s - pin.s)].concat(PIN_ANG) : PIN_ANG;
    for (let r = PX; r <= maxR + 1e-6; r += PX)
      for (const t of angs) {
        const ns = s + M.cos(t) * r, ny = y + M.sin(t) * r, wq = P.to_world(S, ns, ny);
        if (ny - C.WORM_R < sim.surface_at(S, wq.x, wq.z) || P.overlap2(S, ns, ny) > 0) continue;
        return { s: ns, y: ny };
      }
    return null;
  }
  // the prop b pins a worm that has no free spot within reach: it breaks (never a soft-locked worm)
  function breakPin(S, b) {
    SS.bodies.remove(S, b);
    sim.emit(S, EV.PROPBREAK, { body: b.id, x: b.pos.x, y: b.pos.y, z: b.pos.z, kind: b.prop || 'rubble', why: 'pinned' });
  }
  /* P88: a worm inside a resting prop (a crate landed on it, a boulder settled into it) is moved out, else the prop
   * breaks (never a soft-locked worm: the soft body, buried
   * in the prop's field, exploded). Before P118a this was the PoC rule for the worm under control (the whole disc free
   * of the prop's plane section, an axis-aligned box) and, for the others, the same box (a worm that sank into a log
   * was lifted onto the top of that box, which hovers over a tilted log, and body3D dropped it back in: four lifts a
   * second for ever, Q-12). Now ONE rule for every worm, against what body3D lands the worms on (propDepth: the
   * collision spheres) and what a hollow shell cannot show (propBox: a crate): pinned = the core of the body (PIN_RAD
   * round the centre) inside a prop, or the feet inside it. The worm is pushed out along the normal (feet only:
   * straight up), else straight up, in 0.1 m steps, to the first spot where the core is clear and the feet are outside
   * the padded spheres (so it falls on the prop and rests, instead of sinking in below the centre of a thin log and
   * being lifted again); none within reach: the prop breaks. The worm under control (planar) is pushed inside its
   * section plane and judged by where its disc stands (feet up to PLANE_SINK inside a surface are legal), not by the
   * padded sphere. One rule for both is what makes a worm that rests on a log or beside a crate legal when its turn
   * starts: with the whole-disc rule for the worm under control and a core rule for the others, 4 % of the turns began
   * with a jump of 0.2 to 3 m. The End of the World keeps the plane-section rule (local gravity: no world up to push
   * along). Returns 0: free, 1: moved out, 2: no way out, the prop broke. */
  // worm o may stand at (x, y, z): its body clear of rock and worms, its core and its feet (padded by pad) outside
  // every prop, its feet not below the water surface
  function pinSpotFree(S, o, x, y, z, pad) {
    return bodyFree(o, x, y, z)
      && !(pinDepth(S, x, y, z, WD.PIN_RAD, 0, pn2) > 0)
      && !(pinDepth(S, x, y - o.foot, z, 0, pad, pn2) > 0)
      && y - o.foot >= sim.surface_at(S, x, z) - 0.3;
  }
  function unpinProp(S, o, planar) {
    if (S.eow) return 0;
    // the core of the body inside a prop...
    const pc = pinDepth(S, o.pos.x, o.pos.y, o.pos.z, WD.PIN_RAD, 0, pn), bc = pn.body;
    // ...or the feet (a log that settled around them)
    const pf = pc > 0 ? 0 : pinDepth(S, o.pos.x, o.pos.y - o.foot, o.pos.z, 0, planar ? -WD.PLANE_SINK : 0, pn2), bf = pn2.body;
    if (!(pc > 0) && !(pf > 0)) return 0;
    const pen = pc > 0 ? pc : pf, pb = pc > 0 ? bc : bf, reach = M.min(110 * PX, pb.rb * 2 + C.WORM_R);
    // (feet only: straight up, a normal pointing down would push the worm into the ground)
    let nx = pc > 0 ? pn.x : 0, ny = pc > 0 ? pn.y : 1, nz = pc > 0 ? pn.z : 0;
    if (planar) {                                                                    // the worm under control stays in its section plane
      const q = P.nrm(S), dn = nx * q.x + nz * q.z;
      nx -= dn * q.x;
      nz -= dn * q.z;
      const l = M.len3(nx, ny, nz);
      if (l < 1e-3) {
        nx = 0;
        ny = 1;
        nz = 0;
      } else {
        nx /= l;
        ny /= l;
        nz /= l;
      }
    }
    const x0 = o.pos.x, y0 = o.pos.y, z0 = o.pos.z, pad = planar ? -WD.PLANE_SINK : WD.PROP_PAD;
    let found = false;
    for (let k = 0; k < 2 && !found; k++) {                                          // k = 0: out along the normal; k = 1: straight up
      const ux = k ? 0 : nx, uy = k ? 1 : ny, uz = k ? 0 : nz;
      for (let r = pen + 0.03; r <= reach && !found; r += 0.1) {
        if (!pinSpotFree(S, o, x0 + ux * r, y0 + uy * r, z0 + uz * r, pad)) continue;
        // (the worm under control lands at once)
        let q = r;
        if (planar)
          while (q - 0.02 > pen && pinSpotFree(S, o, x0 + ux * (q - 0.02), y0 + uy * (q - 0.02), z0 + uz * (q - 0.02), pad)) q -= 0.02;
        o.pos.x = x0 + ux * q;
        o.pos.y = y0 + uy * q;
        o.pos.z = z0 + uz * q;
        found = true;
      }
    }
    if (!found) {
      breakPin(S, pb);
      return 2;
    }
    o.vel.x = o.vel.y = o.vel.z = 0;
    o.rest = false;
    o.slide = false;
    o.stillT = 0;
    return 1;
  }
  function unpinOthers(S) {                                                          // once per step before the active worm moves
    if (S.eow) return;
    for (let i = 0; i < S.worms.length; i++) {
      // (a worm under control frees itself: recoverPinned)
      const o = S.worms[i];
      if (o.dead || o.drowning || o.swim || o.rope || WM.ctl(S, o)) continue;
      unpinProp(S, o, false);
    }
  }
  WM.unpin_others = unpinOthers;
  function recoverPinned(S, a, dt) {
    if (S.rope || S.hook || S.dig || a.drowning || a.swim || a.dead || !WM.ctl(S, a)) return;
    let moved = 0;
    if (S.eow) {                                                                     // (the End of the World: the plane-section rule)
      const s0 = P.to_plane(S, a.pos).s, pin = pinningBody(S, s0, a.pos.y);
      if (pin) {
        const found = pinFree(S, pin, s0, a.pos.y);
        if (!found) {
          breakPin(S, SS.bodies.by_id(S, pin.body));
          return;
        }
        setActive2D(S, a, found.s, found.y);
        moved = 1;
      }
    } else moved = unpinProp(S, a, true);
    // (the prop broke: remove the obstruction rather than soft-lock the worm)
    if (moved === 2) return;
    const q = P.to_plane(S, a.pos), s = q.s, y = a.pos.y;
    if (moved === 1) {
      a.vs = a.vy = 0;
      a.flip = false;
      a.hop = false;
      a.slide = false;
      a.air = !P.grounded2(S, s, y);
      if (!a.air) landNow(S, a, 0);
      a.pinProbe = null;
    } else if (a.air && !a.slide && !a.hop && !a.flip && M.len2(a.vs, a.vy) < 70 * PX && P.grounded2(S, s, y)) {
      const p = a.pinProbe || (a.pinProbe = { s, y, t: 0 });
      if (M.len2(s - p.s, y - p.y) < 2 * PX) p.t += dt;
      else {
        p.s = s;
        p.y = y;
        p.t = 0;
      }
      if (p.t > 0.18) {
        landNow(S, a, 0);
        p.t = 0;
      }
    } else a.pinProbe = null;
  }
  function step2D(S, a, dt, mv) {
    if (S.eow) return SS.eow.step2d(S, a, dt, mv);                 // P68c: planetoid gravity, a magnetic suit on any surface
    let s = P.to_plane(S, a.pos).s, y = a.pos.y;
    a.walking = false;
    if (!a.air && mv) a.facing = mv;
    let wq = P.to_world(S, s, y), lf = lavaFloor(S, wq.x, wq.z, a);
    if (!a.air) {
      // walking: sim.walk_speed (PoC 2.96 m/s x 0.7), step up 0.64 m (1.16 m over another worm), follow the ground down
      // 0.64 m, else drop off
      let hs = mv * WM.walk_speed(S, a);
      if (hs && sim.lava_contact(S, a.pos.x, a.pos.y - a.foot, a.pos.z, lc).sub > 0.05) hs *= C.LAVA_WADE;   // wading in viscous lava
      // P30: bare sea ice is slippery: the speed eases toward the walk speed (C.ICE.GRIP 1/s) and slides on when the
      // key is let go; a thin snow cover on the ice gives grip again (SS.ice.slippery)
      const it = SS.ice && S.ice ? SS.ice.top_at(S, a.pos.x, a.pos.z) : -1e9;
      const onIce = it > -1e8 && Math.abs(a.pos.y - a.foot - it) < 0.15 && SS.ice.slippery(S, a.pos.x, a.pos.z);
      if (onIce) {
        a.iceV += (hs - a.iceV) * (1 - M.exp(-C.ICE.GRIP * dt));
        hs = Math.abs(a.iceV) < 0.04 && !mv ? 0 : a.iceV;
      } else a.iceV = 0;
      // P79 SLICK: a wet slope steeper than the friction lets go
      if (SS.lab4 && S.lab && S.settings.labFlags) hs += SS.lab4.slip(S, a, s, y);
      if (hs) {
        // P88: a worm right ahead can be climbed too (on a slope the disc stopped 0.01 m short of 'on it')
        const base = P.overlap2(S, s, y),
          ns = s + hs * dt,
          top = onWorm(S, a, s, y) || onWorm(S, a, ns, y, WD.STACK_REACH) ? WD.STEP_UP_WORM : WD.STEP_UP;
        let moved = false;
        for (let l = 0; l <= top + 1e-6; l += 0.04)
          if (P.overlap2(S, ns, y + l) <= base) {
            s = ns;
            y += l;
            a.walking = true;
            moved = true;
            break;
          }
        if (!moved) a.iceV = 0;                                                  // slid into something
      }
      // following the ground down: the feet probes, the bottom of the disc meeting something (a prop's rounded top), or
      // another worm's ball anywhere on the disc (a worm climbs over a worm). Anything else the disc would sink into
      // stops the step down but is no footing (a trunk's bulge on its flank): the worm is not snapped and slides off
      let snapped = P.grounded2(S, s, y);
      if (!snapped) {
        const u0 = P.under2(S, s, y), o0 = P.overlap2(S, s, y);
        for (let l = 0.04; l <= WD.STEP_DOWN + 1e-6; l += 0.04) {
          const g = P.grounded2(S, s, y - l), u = P.under2(S, s, y - l) > u0, into = u || P.overlap2(S, s, y - l) > o0;
          if (g || into) {
            snapped = g || u || !!onWorm(S, a, s, y - l, WD.STACK_REACH);
            y -= into ? l - 0.04 : l;
            break;
          }
        }
      }
      wq = P.to_world(S, s, y); lf = lavaFloor(S, wq.x, wq.z, a);
      const onLava = lf > -1e8 && a.pos.y - a.foot <= lf + 0.08;
      if (onLava) {
        // floats (sinks with lsink), or a bank holds it; deep in a lava column it RISES (viscous, 1.5 m/s), never jumps
        // (lakes / canals < DEEP: as before)
        const yf = lf + a.foot;
        y = y < yf - C.LAVA.DEEP ? y + 1.5 * dt : snapped ? M.max(y, yf) : yf;
        SS.lava.vel_at(S, wq.x, wq.z, lvv);
        const d = P.dir(S), ds = 1.5 * (lvv.x * d.x + lvv.z * d.z) * dt;
        if (ds && P.overlap2(S, s + ds, y) <= P.overlap2(S, s, y)) s += ds;
      }
      // ledge: drops off at 40 px/s
      if (!snapped && !onLava) {
        a.air = true;
        a.vs = mv ? mv * WD.LEDGE_VS * (WM.walk_speed(S, a) / C.WALK) : 0;
        a.vy = 0;
      }
      else {
        a.vs = 0;
        a.vy = 0;
      }
    }
    if (a.air) {
      const sp0 = M.len2(a.vs, a.vy), nsub = M.max(1, Math.ceil(sp0 * dt / 0.08)), h = dt / nsub;
      let contact = null;
      const yStart = y;
      // P38 R9: terminal velocity
      if (sp0 > WD.V_MAX) {
        const kk = WD.V_MAX / sp0;
        a.vs *= kk;
        a.vy *= kk;
      }
      for (let k = 0; k < nsub && a.air; k++) {
        a.vy -= GW * WM.gravity_k(S, a) * h;
        let ns = s + a.vs * h, ny = y + a.vy * h;
        wq = P.to_world(S, ns, ny); lf = lavaFloor(S, wq.x, wq.z, a);
        // lands on the lava (crossing its surface): it floats
        if (lf > -1e8 && a.vy < 0 && ny - a.foot <= lf && y - a.foot > lf - C.LAVA.DEEP) {
          if (a.vy < -2) sim.emit(S, EV.LAVAPLOP, { x: wq.x, y: lf + (a.lsink || 0), z: wq.z, speed: -a.vy });
          y = lf + a.foot;
          s = ns;
          landNow(S, a, 0);
          break;
        }
        if (P.overlap2(S, ns, ny) <= P.overlap2(S, s, y) && !rimNormal(S, ns, ny)) {
          s = ns;
          y = ny;
          continue;
        }
        const n = rimNormal(S, ns, ny) || { s: 0, y: 1 }, vn = a.vs * n.s + a.vy * n.y;
        contact = n;
        if (vn >= 0) {
          if (P.overlap2(S, ns, ny) <= P.overlap2(S, s, y)) {
            s = ns;
            y = ny;
          }
          continue;
        }
        const imp = -vn, sp = M.len2(a.vs, a.vy), ts = -n.y, ty = n.s, vt = a.vs * ts + a.vy * ty, along = Math.abs(vt) / M.max(1e-6, sp);
        // landing on another worm's head (PoC resolveWormContacts): it is shoved aside, the lander stops on top
        const lower = n.y > 0.5 ? onWorm(S, a, ns, ny - 0.1) : null;
        if (lower && imp >= WD.HEAD_SHOVE_V && !(S.worms[lower.worm].shoveT > S.time)) {
          const o = S.worms[lower.worm], d = P.dir(S), dir = Math.abs(o.s - ns) > 0.06 ? Math.sign(lower.s - ns) : a.facing;
          shoveWorm(S, o, d.x * dir, d.z * dir, imp);
          landNow(S, a, imp);
          a.vs *= 0.25;
          a.squash = S.time;
          break;
        }
        if (imp > WD.FALL_SAFE && n.y > 0.2) {                                // a hard landing on a floor or slope
          const head = along < WD.HEAD_ALONG;
          // the rebound first: the damage ends the turn and hands the worm (with this velocity) to the 3D body step
          if (head) {
            const up = M.min(WD.HEAD_UP_MAX, WD.HEAD_UP_K * imp);
            a.vs = n.s * up + a.facing * WD.HEAD_SIDE;
            a.vy = n.y * up;
            a.dizzyUntil = S.time + WD.DIZZY;
            a.squash = S.time;
            sim.emit(S, EV.DIZZY, { wormId: a.id});
          }
          else {
            a.vs = ts * vt * WD.FRIC - n.s * vn * WD.BOUNCE;
            a.vy = ty * vt * WD.FRIC - n.y * vn * WD.BOUNCE;
          }
          a.slide = true; a.flip = false; a.hop = false;
          sim.emit(S, EV.LAND, {
            wormId: a.id,
            x: a.pos.x,
            y: a.pos.y - 0.45,
            z: a.pos.z,
            speed: imp,
            mat: W.mat_at(a.pos.x, a.pos.y - 0.7, a.pos.z),
            hard: 1
          });
          setActive2D(S, a, s, y);
          landHurt(
            S,
            a,
            head
              ? M.min(WD.HEAD_MAX, Math.round((imp - WD.FALL_SAFE) * WD.HEAD_K) + WD.HEAD_ADD)
              : M.min(WD.GLANCE_MAX, Math.round((imp - WD.FALL_SAFE) * WD.GLANCE_K))
          );
          if (!WM.ctl(S, a)) return;                                         // (the turn ended: the 3D body step takes over)
        } else if (!a.slide && n.y > WD.FIRM_NY) {
          // a firm landing stops dead (PoC land())
          landNow(S, a, imp);
          break;
        }
        // skid / wall / ceiling
        else {
          a.vs = ts * vt * WD.FRIC - n.s * vn * WD.BOUNCE;
          a.vy = ty * vt * WD.FRIC - n.y * vn * WD.BOUNCE;
        }
      }
      // a skidding worm comes to rest: slow and supported for 0.45 s, or a soft touch on a floor
      if (a.air && contact) {
        const sp = M.len2(a.vs, a.vy);
        if (contact.y > WD.SOFT_NY && sp < WD.SOFT_V && !a.slide) landNow(S, a, sp);
        else if (sp < WD.STILL_V && contact.y > 0.2) {
          a.stillT = (a.stillT || 0) + dt;
          if (a.stillT > WD.STILL_T) landNow(S, a, sp);
        }
        else a.stillT = 0;
      }
      // P38 R9: wedged in rock
      if (a.air && !S.rope && !a.dead) {
        setActive2D(S, a, s, y);
        if (pin_step(S, a, yStart, a.vy, dt)) return;
      }
    }
    setActive2D(S, a, s, y);
  }
  const PX = 0.0643;

  /* P107: the part of the control every active worm shares (weapon choice, fuse, aim, mouse aim): also used by a worm
   * afloat in a life jacket (sim/lifejacket.js) */
  function controlPre(S, a, dt, inp, retreat) {
    const mv = inp.move || 0, WP = SS.weapons;                 // (partial Input structs from tools / tests: 0)
    if (inp.jet && S.eow) SS.eow.jet_toggle(S, a);                // P86: the team's jetpack switch (J)
    if (mv || inp.jump || inp.backflip || inp.fire_pressed || inp.drop) S.acted = true;     // (worm select: only before acting)
    // P2: weapon choice (only with ammo; locked after the first shotgun shot), fuse, strike side, girder angle, target
    // P37-8: choosing Skip Go only SELECTS it (the worm shows a hand gesture); the turn ends when fire is pressed
    // (WP.use 'skip')
    if (
      !retreat && !S.charging && inp.weapon && C.WEAPONS[inp.weapon] && C.ARSENAL[inp.weapon] && !(S.shots > 0) && WP.can_use(S, inp.weapon)
    ) S.weapon = inp.weapon;
    if (inp.fuse >= 1 && inp.fuse <= 5) {
      S.fuse = inp.fuse | 0;
      if (SS.weaponsA) SS.weaponsA.set_fuse(S, S.weapon, S.fuse);
    }
    if (inp.adj && SS.weaponsA && !retreat) SS.weaponsA.adjust(S, inp.adj);
    if (inp.sdir) S.strikeDir = inp.sdir > 0 ? 1 : -1;
    // girder plate (P37 W4): free angle: held keys turn it continuously (gturn -1..1, Shift = fine), gang = one 22.5°
    // step
    if (inp.gang) S.plateAng = M.wrap_angle((S.plateAng || 0) + (inp.gang > 0 ? 1 : -1) * C.ARMS.GIRDER.STEP);
    if (inp.gturn)
      S.plateAng = M.wrap_angle((S.plateAng || 0) + M.clamp(inp.gturn, -1, 1) * C.ARMS.GIRDER.TURN * (inp.fine ? 0.25 : 1) * dt);
    if (inp.tgt && Number.isFinite(inp.ts) && Number.isFinite(inp.ty)) S.tgt = { s: inp.ts, y: inp.ty };
    // aim: 1.5 rad/s up to +-90° (PoC L5154); the sniper aims finer when pointed at something near
    // (features-ballistics)
    if (!S.rope) {
      const rate = S.weapon === 'sniper' ? sniperRate(S, a) : WD.AIM_RATE;
      if (inp.up) S.aim = M.min(Math.PI / 2, S.aim + rate * dt);
      if (inp.down) S.aim = M.max(-Math.PI / 2, S.aim - rate * dt);
      // PoC torch / drill: the torch aims within ±45°; pressing on down past -45° picks the drill (straight down), up
      // from there comes back to the torch at -45°
      if (S.weapon === 'drill' && (inp.up || inp.down)) {
        if (S.aim > Math.PI / 4) S.aim = Math.PI / 4;
        else if (S.aim < -Math.PI / 4 && S.aim > -Math.PI / 2 + 1e-3) S.aim = inp.down ? -Math.PI / 2 : -Math.PI / 4;
        else if (S.aim <= -Math.PI / 2 + 1e-3 && inp.up) S.aim = -Math.PI / 4;
      }
    }
    // mouse aim (PoC aimAt): only with the weapon ready, never for the girder (its keys turn it) or on the rope; the
    // torch / drill: pointing well below 45° picks the drill (straight down), anything else is the torch within ±45°
    if (inp.aimset && Number.isFinite(inp.aimv) && !S.rope && S.weapon !== 'girder' && WM.weapon_ready(S, a)) {
      let v = M.clamp(inp.aimv, -Math.PI / 2, Math.PI / 2);
      if (S.weapon === 'drill') v = v < -1.15 ? -Math.PI / 2 : M.clamp(v, -Math.PI / 4, Math.PI / 4);
      S.aim = v;
      if (inp.face) a.facing = inp.face > 0 ? 1 : -1;
    }
    if (SS.traverse) SS.traverse.clamp_aim(S);                                   // the zipline aims level or down only
    if (retreat && inp.fire_pressed) WP.detonate_own(S);                     // PoC: fire again sets the sheep off
  }
  WM.control_pre = controlPre;
  function controlActive(S, a, dt, inp, retreat) {
    const mv = inp.move || 0, WP = SS.weapons;
    controlPre(S, a, dt, inp, retreat);
    // on the rope: SS.traverse.rope_control (Space / Enter let go, Enter drops a payload, Backspace hops, arrows pump /
    // reel)
    if (S.rope) {
      if (inp.fire_pressed && S.weapon === 'skip' && !retreat) WP.use(S, 0);    // (P37-8: Skip Go selected: fire skips, the rope is kept)
      else SS.traverse.rope_control(S, a, dt, inp, mv, retreat);
    } else if (SS.traverse && SS.traverse.riding(S)) {
      SS.traverse.zip_control(S, a, dt, inp, mv);                 // on a zipline: it slides, left / right nudge, a jump drops off
    } else {
      if (S.hook) SS.traverse.hook_step(S, a, dt);
      if (SS.traverse) {
        SS.traverse.step(S, a, dt);
        SS.traverse.air_pre(S, a, dt, inp, mv);
      }
      // PoC jumps (L3649-3664): Enter = forward jump, Backspace = back hop; Backspace again while the hop still rises
      // (within 0.5 s) = back salto (a flip; no weapon until it lands). No jump in the air, no steering in the air.
      // P37-7: the forward jump: stop, tilt back for JUMP_WIND s (a.windUp = the time of the spring), then spring
      // forward
      if (a.windUp > 0 && (a.air || S.rope || a.swim || a.drowning)) a.windUp = 0;               // knocked off its feet / roped: no spring
      if (!a.air && inp.jump && !(a.windUp > 0)) {
        a.windUp = S.time + WD.JUMP_WIND;
        a.windFace = a.facing;
        a.walking = false;
      }
      else if (a.windUp > 0 && !a.air && S.time >= a.windUp) {
        a.windUp = 0;
        a.vy = WD.JUMP_VY * (SS.lab ? SS.lab.jump_k(S, a) : 1);
        a.vs = a.windFace * WM.jump_vs(S, a);
        a.air = true;
        a.hop = false;
        a.slide = false;
        a.squash = S.time;
        sim.emit(S, EV.JUMP, M.v3_copy(a.pos));
      }
      else if (!a.air && inp.backflip && !(a.windUp > 0) && (!a.hopAt || S.time - a.hopAt >= WD.HOP_GAP)) {
        a.vy = WD.HOP_VY;
        a.vs = a.facing * WD.HOP_VS;
        a.air = true;
        a.hop = true;
        a.hopAt = S.time;
        a.slide = false;
        a.squash = S.time;
        sim.emit(S, EV.JUMP, M.v3_copy(a.pos));
      }
      else if (a.air && inp.backflip && a.hop && S.time - a.hopAt < WD.SALTO_WIN && a.vy > WD.SALTO_VMIN) {
        a.vy = M.max(a.vy, WD.SALTO_BASE) + WD.SALTO_ADD;
        a.vs = a.facing * WD.SALTO_VS;
        a.flip = true;
        a.flipAt = S.time;
        a.hop = false;
        sim.emit(S, EV.SALTO, { wormId: a.id});
      }
      // no walking while charging a shot (PoC L5148)
      if (S.eow) SS.eow.jump_fix(S, a);                                   // P68c: a jump leaves along the worm's own up
      step2D(S, a, dt, a.air || S.charging || a.windUp > 0 ? 0 : mv);
      recoverPinned(S, a, dt);
      controlFire(S, a, dt, inp, retreat);
    }
  }
  WM.control_active = controlActive;

  /* the weapon / tool part of the control (the fire key, the charge): shared with the life jacket control (P107) */
  function controlFire(S, a, dt, inp, retreat) {
    const WP = SS.weapons;
    const kind = C.WEAPONS[S.weapon].kind, ready = WM.weapon_ready(S, a);
    // parachute / zipline (also in the retreat)
    if (kind === 'chute' || kind === 'zip') SS.traverse.tool(S, a, dt, inp, retreat || S.teleT > 0);
    else if (retreat || S.teleT > 0) { /* P1 retreat: move, jump, keep swinging; no new attack */ }
    else if (S.weapon === 'rope') {
      if (inp.fire_pressed && !S.hook) sim.shoot_rope(S);
    }
    else if (kind === 'charge') {
      // (fixed: the mortar always fires at full power)
      if (inp.fire_pressed && !S.charging && ready && WP.can_use(S, S.weapon) && !(C.WEAPONS[S.weapon].target && !S.tgt)) {
        S.charging = true;
        S.power = C.WEAPONS[S.weapon].fixed ? 1 : 0;
      }
      else if (inp.fire_pressed && C.WEAPONS[S.weapon].target && !S.tgt) sim.log(S, 'Click a target first.', 0xffb27a);
      if (S.charging) {
        S.power = M.min(1, S.power + dt / WD.CHARGE_T);
        // PoC releaseFire: a shot released while the worm is not ready (jumped, knocked, flipping) is cancelled, no
        // ammo
        if (!inp.fire_held || S.power >= 1) {
          if (WM.weapon_ready(S, a)) sim.fire(S);
          else {
            S.charging = false;
            S.power = 0;
          }
        }
      }
    } else if (inp.fire_pressed && (ready || kind === 'drop' || kind === 'skip')) WP.use(S, 0);   // drops work anywhere (PoC)
  }
  WM.control_fire = controlFire;

  /* P1: in-plane control of the active worm: its turn, or the retreat window after an attack */
  WM.ctl = (S, w) => w === S.active && (S.phase === PHASE.PLAY || (S.phase === PHASE.ATTACK && S.retreatT > 0));

  /* ---------- inactive worms: 3D bodies ---------- */
  function blocked3(x, y, z) {
    const w = W;
    return w.sample(x, y, z) > 0
      || w.sample(x + 0.4, y, z) > 0
      || w.sample(x - 0.4, y, z) > 0
      || w.sample(x, y, z + 0.4) > 0
      || w.sample(x, y, z - 0.4) > 0;
  }
  // P89: the life jacket swim (sim/lifejacket.js) moves a floating worm and ends it
  WM.blocked3 = blocked3;
  // M / Step I: walkable surfaces that are not voxels: a bridge deck, sea ice (intact, under yTop + 0.05)
  const deckFloor = (S, x, y, z) => {
    let f = SS.struct ? SS.struct.floor_at(S, x, y, z) : -1e9;
    if (SS.ice && S.ice) {
      const t = SS.ice.top_at(S, x, z);
      if (t > f && t <= y + 0.05) f = t;
    }
    return f;
  };
  WM.deck_floor = deckFloor;
  /* P118a (Q-12): a SLEEPING rigid prop (a log, a crate, a boulder, a wreck piece) is ground for a worm that is not
   * under control. body3D knew only voxels, decks and
   * ice: such a worm sank into the prop, unpinOthers lifted it out, gravity dropped it back in, four times a second for
   * ever (the soft body hid it, but the turn waited out the 16 s settle cap). propDepth(S, x, y, z, rad, pad, n): how
   * deep the point (a worm's feet; with rad > 0 a ball round it) lies inside the collision spheres of the sleeping
   * bodies, each padded by `pad` (the shells are sparse: a worm must not slip between two touching spheres); the
   * deepest sphere wins: n = the unit vector away from its centre, n.body = its body; 0 = outside all of them. Spheres
   * thinner than PROP_RMIN (sticks and twigs 0.05-0.12 m, barrels 0.09-0.11, mines 0.07: a worm stands on trunks,
   * crates (0.175) and boulders, not on sticks) are neither ground nor pin: with them 3 of 16 test matches held a turn
   * open (a worm between sticks is lifted and falls back). PIN_RAD = the core of the body that a prop must not overlap
   * (the feet are tested on their own: a larger ball overlaps the incline of a leaning log while the feet stand on it).
   * The same spheres the bodies collide with, in 3D (the plane section is an axis-aligned box: over a tilted log it is
   * a hovering lid). C: f32 prop_depth(Game*, vec3 p, f32 rad, f32 pad, vec3* n). */
  // the scratch hit records of the prop probes: the unit normal out of the prop and the body (null: no hit)
  const pn = { x: 0, y: 1, z: 0, body: null }, pn2 = { x: 0, y: 1, z: 0, body: null }, pq = { x: 0, y: 0, z: 0 };
  function propDepth(S, x, y, z, rad, pad, n) {
    const L = S.bodies;
    let best = 0;
    n.body = null;
    for (let i = 0; i < L.length; i++) {
      const b = L[i];
      if (!b.asleep || b.held) continue;
      const R = b.rb + pad + rad, dx = x - b.pos.x, dy = y - b.pos.y, dz = z - b.pos.z;
      if (dx * dx + dy * dy + dz * dz > R * R) continue;
      for (let k = 0; k < b.np; k++) {
        const r = b.pts[k * 4 + 3];
        if (r < WD.PROP_RMIN) continue;
        M.q_rot(b.q, b.pts[k * 4], b.pts[k * 4 + 1], b.pts[k * 4 + 2], pq);
        const ex = x - (b.pos.x + pq.x),
          ey = y - (b.pos.y + pq.y),
          ez = z - (b.pos.z + pq.z),
          d = Math.sqrt(ex * ex + ey * ey + ez * ez),
          pen = r + pad + rad - d;
        if (pen > best) {
          best = pen;
          n.body = b;
          if (d > 1e-6) {
            n.x = ex / d;
            n.y = ey / d;
            n.z = ez / d;
          } else {
            n.x = 0;
            n.y = 1;
            n.z = 0;
          }
        }
      }
    }
    return best;
  }
  /* The pin test asks whether a worm is INSIDE a prop, and a shell of spheres is hollow: a crate is 26 spheres on its
   * surface (a worm at its centre is 0.33 m from the nearest).
   * propBox(S, x, y, z, rad, n) is propDepth's twin for crates (kind box): the box of the shell in the body's own frame
   * (the extents of its spheres: exactly the crate); the shallowest axis gives the way out (n = that face's normal in
   * the world). Not for the other props: the box of a tilted log or a barrel has empty corners (a worm that falls into
   * one has no sphere to land on and would be lifted and dropped again, the Q-12 loop), and a barrel's spheres are
   * thinner than PROP_RMIN anyway (it neither carries nor pins: a barrel that settles on a worm leaves it inside). C:
   * f32 prop_box(Game*, vec3 p, f32 rad, vec3* n). */
  function propBox(S, x, y, z, rad, n) {
    const L = S.bodies;
    let best = 0;
    n.body = null;
    for (let i = 0; i < L.length; i++) {
      const b = L[i];
      if (!b.asleep || b.held || b.kind !== 'box') continue;
      const R = b.rb + rad, dx = x - b.pos.x, dy = y - b.pos.y, dz = z - b.pos.z;
      if (dx * dx + dy * dy + dz * dz > R * R) continue;
      M.q_rot_inv(b.q, dx, dy, dz, pq);
      let l0 = 1e9, l1 = 1e9, l2 = 1e9, h0 = -1e9, h1 = -1e9, h2 = -1e9;
      for (let k = 0; k < b.np; k++) {
        const r = b.pts[k * 4 + 3], a = b.pts[k * 4], c = b.pts[k * 4 + 1], d = b.pts[k * 4 + 2];
        l0 = M.min(l0, a - r);
        h0 = M.max(h0, a + r);
        l1 = M.min(l1, c - r);
        h1 = M.max(h1, c + r);
        l2 = M.min(l2, d - r);
        h2 = M.max(h2, d + r);
      }
      const e0 = pq.x - (l0 + h0) / 2, e1 = pq.y - (l1 + h1) / 2, e2 = pq.z - (l2 + h2) / 2;
      const d0 = (h0 - l0) / 2 + rad - Math.abs(e0), d1 = (h1 - l1) / 2 + rad - Math.abs(e1), d2 = (h2 - l2) / 2 + rad - Math.abs(e2);
      // (the way out: the shallowest face)
      const m = M.min(d0, M.min(d1, d2));
      if (!(m > best)) continue;
      best = m;
      n.body = b;
      let ax = 0, ay = 0, az = 0;
      if (m === d0) ax = e0 < 0 ? -1 : 1;
      else if (m === d1) ay = e1 < 0 ? -1 : 1;
      else az = e2 < 0 ? -1 : 1;
      M.q_rot(b.q, ax, ay, az, n);
    }
    return best;
  }
  const pn3 = { x: 0, y: 1, z: 0, body: null };
  // how deep the point (a ball of radius rad round it, padded by pad) lies in a sleeping prop, as the pin test sees it:
  // the deeper of the shell's spheres (propDepth) and, for a crate, its box (propBox)
  function pinDepth(S, x, y, z, rad, pad, n) {
    const ds = propDepth(S, x, y, z, rad, pad, n), db = propBox(S, x, y, z, rad + pad - WD.BOX_SHRINK, pn3);
    if (db > ds) {
      n.x = pn3.x;
      n.y = pn3.y;
      n.z = pn3.z;
      n.body = pn3.body;
      return db;
    }
    return ds;
  }
  /* a kept rope (inactive worm): a 3D pendulum on the anchor; it drops when the anchor's rock is gone */
  function hangOnRope(S, b, dt) {
    const r = b.rope, w = W;
    if (w.sample(r.x, r.y, r.z) <= 0 && w.sample(r.x, r.y + 0.25, r.z) <= 0 && w.sample(r.x, r.y - 0.25, r.z) <= 0) {
      b.rope = null;
      b.rest = false;
      return false;
    }
    const n = 4, h = dt / n;
    for (let i = 0; i < n; i++) {
      b.vel.y -= GW * WM.gravity_k(S, b) * h;
      const k = M.exp(-0.4 * h);
      b.vel.x *= k;
      b.vel.y *= k;
      b.vel.z *= k;
      let nx = b.pos.x + b.vel.x * h, ny = b.pos.y + b.vel.y * h, nz = b.pos.z + b.vel.z * h;
      const dx = nx - r.x, dy = ny - r.y, dz = nz - r.z, d = M.len3(dx, dy, dz);
      if (d > r.len) {                                   // taut: back onto the sphere, drop the outward speed
        const ux = dx / d, uy = dy / d, uz = dz / d;
        nx = r.x + ux * r.len;
        ny = r.y + uy * r.len;
        nz = r.z + uz * r.len;
        const vr = b.vel.x * ux + b.vel.y * uy + b.vel.z * uz;
        if (vr > 0) {
          b.vel.x -= vr * ux;
          b.vel.y -= vr * uy;
          b.vel.z -= vr * uz;
        }
      }
      if (blocked3(nx, ny, nz)) {
        b.vel.x *= -0.3;
        b.vel.y *= -0.3;
        b.vel.z *= -0.3;
        continue;
      }
      b.pos.x = nx; b.pos.y = ny; b.pos.z = nz;
    }
    b.rest = false;
    return true;
  }
  /* P37-2: worms inside the visible section band (|t| <= C.SECT_BAND, t = distance from the gameplay plane) move ON the
   * section: the velocity component along the plane normal is dropped (blasts, slides, falls, waves), so nothing
   * slides "off view" sideways. Worms farther out (other sections, unseen) keep full 3D physics. The band is the slab
   * half thickness plus the worm radius, so every worm that is drawn in the slab (or touches it) is constrained. */
  WM.in_band = (S, p) => S.O != null && Math.abs(P.to_plane(S, p).t) <= C.SECT_BAND;
  function planeLock(S, b) {
    if (!S.O || S.phase === PHASE.PLACE || !WM.in_band(S, b.pos)) return;
    const n = P.nrm(S), vn = b.vel.x * n.x + b.vel.z * n.z;
    b.vel.x -= vn * n.x; b.vel.z -= vn * n.z;
  }
  WM.plane_lock = planeLock;
  /* ---------- P88 worm-worm contact (3D bodies): a worm is a solid ball of WORM_R for every other worm ----------
   * The ACTIVE worm already met the others as discs in its plane (planeBodies: it climbs over a worm, stands on it,
   * lands on its head). The worms that are not under control (body3D) used to ignore each other completely: a worm that
   * stood on another when its turn ended fell THROUGH it, and worms that bunched up overlapped for good. Now every worm
   * obeys the same ball contact: it lands on / rolls off / rests on a head (contact normal.y >= STACK_NY), is pushed
   * out of a flank, and resting worms that overlap side by side slide apart (gently, never into rock, never off their
   * footing). Presentation (the fold under the weight, the feet on the back) reads sim.worm_under(S, w): the worm a
   * worm stands on. No state of its own: pure geometry over the worm positions, so it is the same on every peer. (EOW
   * has its own body step: p86's eow.js may call these.) */
  function wormUnder(S, b) {
    if (S.eow || b.dead || b.drowning || b.swim) return null;
    const R2 = 2 * C.WORM_R;
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i];
      if (o === b || o.dead || o.drowning || o.swim) continue;
      const dx = b.pos.x - o.pos.x, dy = b.pos.y - o.pos.y, dz = b.pos.z - o.pos.z, d = M.len3(dx, dy, dz);
      if (dy > 0.3 && d > 1e-6 && dy / d >= WD.STACK_NY && Math.abs(d - R2) <= WD.STACK_GAP) return o;
    }
    return null;
  }
  WM.worm_under = wormUnder;
  // the contact of a point (the body centre) with the worm balls: fills nv (unit normal away from the worm) and returns
  // that worm, or null
  function wormHit(S, b, x, y, z, nv) {
    const R2 = 2 * C.WORM_R;
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i];
      if (o === b || o.dead || o.drowning || o.swim) continue;
      const dx = x - o.pos.x, dy = y - o.pos.y, dz = z - o.pos.z, d = M.len3(dx, dy, dz);
      if (d >= R2) continue;
      if (d < 1e-6) {
        nv.x = 0;
        nv.y = 1;
        nv.z = 0;
      } else {
        nv.x = dx / d;
        nv.y = dy / d;
        nv.z = dz / d;
      }
      return o;
    }
    return null;
  }
  // PoC resolveWormContacts: a hard landing on a head shoves the lower worm aside (dir = the horizontal direction in
  // the world)
  function shoveWorm(S, o, dx, dz, imp) {
    if (o.shoveT > S.time) return;
    const v = M.clamp(imp * WD.SHOVE_K, WD.SHOVE_MIN, WD.SHOVE_MAX);
    o.rest = false;
    o.vel.x += dx * v;
    o.vel.z += dz * v;
    o.vel.y = M.max(o.vel.y, WD.SHOVE_UP);
    o.slide = true;
    o.shoveT = S.time + WD.SHOVE_COOL;
    if (o.rope) o.rope = null;
  }
  // resting worms that overlap side by side slide apart (b is moved; the other, if it is a resting worm too, moves by
  // the same amount in its own turn)
  function wormSeparate(S, b, dt) {
    const w = W, R2 = 2 * C.WORM_R;
    for (let i = 0; i < S.worms.length; i++) {
      const o = S.worms[i];
      if (o === b || o.dead || o.drowning || o.swim) continue;
      const dx = b.pos.x - o.pos.x, dy = b.pos.y - o.pos.y, dz = b.pos.z - o.pos.z, hh = M.len2(dx, dz);
      if (M.len3(dx, dy, dz) >= WD.SEP_D || Math.abs(dy) >= C.WORM_R) continue;
      let ux, uz;
      if (hh > 1e-3) {
        ux = dx / hh;
        uz = dz / hh;
      } else {
        const a = b.id * 2.399963;
        ux = M.cos(a);
        uz = M.sin(a);
      }
      const need = Math.sqrt(M.max(0, R2 * R2 - dy * dy)) - hh,
        share = o.rest && o !== S.active ? 0.5 : 1,
        m = M.min(WD.SEP_V * dt, need * share + 0.002);
      const nx = b.pos.x + ux * m, nz = b.pos.z + uz * m;
      let y = b.pos.y;
      for (let k = 0; k < 4 && w.sample(nx, y - b.foot, nz) > 0; k++) y += 0.03;                // a rising slope: follow it a little
      // rock in the way, or no footing there: stay
      if (
        w.sample(nx, y - b.foot, nz) > 0
        || blocked3(nx, y, nz)
        || !(w.sample(nx, y - b.foot - 0.06, nz) > 0 || propDepth(S, nx, y - b.foot - 0.06, nz, 0, WD.PROP_PAD, pn2) > 0)
      ) continue;
      b.pos.x = nx; b.pos.y = y; b.pos.z = nz;
    }
  }
  // b meets worm o with the contact normal nv (away from o): leaves, rolls off, or rests on its head. True = b is at
  // rest (the substep loop ends).
  function wormLand(S, b, o, nv, vn, nx, ny, nz) {
    const w = W, R2 = 2 * C.WORM_R;
    // moving apart already
    if (vn >= 0) {
      b.pos.x = nx;
      b.pos.y = ny;
      b.pos.z = nz;
      return false;
    }
    const px = o.pos.x + nv.x * R2, py = o.pos.y + nv.y * R2, pz = o.pos.z + nv.z * R2;    // pushed out to touching (unless that is rock)
    if (!(w.sample(px, py - b.foot, pz) > 0) && !blocked3(px, py, pz)) {
      b.pos.x = px;
      b.pos.y = py;
      b.pos.z = pz;
    }
    const imp = -vn;
    // on the head: a hard landing shoves the lower worm, then stops dead (no damage: PoC)
    if (nv.y >= WD.STACK_NY) {
      if (imp >= WD.HEAD_SHOVE_V) {
        const hh = M.len2(nv.x, nv.z);
        shoveWorm(S, o, hh > 1e-3 ? -nv.x / hh : 1, hh > 1e-3 ? -nv.z / hh : 0, imp);
      }
      if (imp > 3)
        sim.emit(S, EV.LAND, {
          wormId: b.id,
          x: b.pos.x,
          y: b.pos.y - b.foot,
          z: b.pos.z,
          speed: imp,
          mat: w.mat_at(o.pos.x, o.pos.y - o.foot - 0.2, o.pos.z)
        });
      b.vel.x = b.vel.y = b.vel.z = 0;
      b.rest = true;
      b.slide = false;
      b.stillT = 0;
      b.squash = S.time;
      return true;
    }
    // a flank / the shoulder: no bounce, the tangential velocity is kept (it rolls off the ball and lands beside it)
    const tx = b.vel.x - vn * nv.x, ty = b.vel.y - vn * nv.y, tz = b.vel.z - vn * nv.z;
    b.vel.x = tx * WD.FRIC;
    b.vel.y = ty * WD.FRIC;
    b.vel.z = tz * WD.FRIC;
    b.slide = true;
    return false;
  }
  function body3D(S, b, dt) {
    if (S.eow) return SS.eow.body3d(S, b, dt);                     // P68c
    const w = W, foot = b.foot;
    // LV3: afloat on open lava: ride the surface flow, held at the lava floor (never 'at rest': the lava moves)
    const lf0 = lavaFloor(S, b.pos.x, b.pos.z, b);
    if (lf0 > -1e8 && b.pos.y - foot < lf0 - C.LAVA.DEEP) {                  // deep in a lava column: rises slowly (viscous)
      b.rest = false;
      b.vel.x = b.vel.z = 0;
      b.vel.y = 0;
      b.pos.y = M.min(lf0 + foot, b.pos.y + 1.5 * dt);
      return;
    }
    if (lf0 > -1e8 && b.pos.y - foot <= lf0 + 0.08 && b.vel.y <= 0.5) {
      if (b.vel.y < -2) sim.emit(S, EV.LAVAPLOP, { x: b.pos.x, y: lf0 + (b.lsink || 0), z: b.pos.z, speed: -b.vel.y });
      b.rest = false; SS.lava.vel_at(S, b.pos.x, b.pos.z, lvv);
      const k = M.exp(-20 * dt);                                           // viscous capture of any slide
      b.vel.x = 1.5 * lvv.x + (b.vel.x - 1.5 * lvv.x) * k; b.vel.z = 1.5 * lvv.z + (b.vel.z - 1.5 * lvv.z) * k; b.vel.y = 0;
      const nx = b.pos.x + b.vel.x * dt, nz = b.pos.z + b.vel.z * dt;
      if (!blocked3(nx, b.pos.y, nz)) {
        b.pos.x = nx;
        b.pos.z = nz;
      } else {
        b.vel.x = b.vel.z = 0;
      }
      const lf1 = lavaFloor(S, b.pos.x, b.pos.z, b);
      if (lf1 > -1e8) b.pos.y = M.clamp(lf1 + foot, b.pos.y - 1.5 * dt, b.pos.y + 3 * dt);   // follows the surface (never jumps)
      return;
    }
    if (b.rope && hangOnRope(S, b, dt)) return;
    if (b.rest) {
      if (
        w.sample(b.pos.x, b.pos.y - foot - 0.06, b.pos.z) > 0
        || Math.abs(deckFloor(S, b.pos.x, b.pos.y - foot, b.pos.z) - (b.pos.y - foot)) < 0.08
        || propDepth(S, b.pos.x, b.pos.y - foot - 0.06, b.pos.z, 0, WD.PROP_PAD, pn) > 0
      ) {
        if (b !== S.active) wormSeparate(S, b, dt);
        return;
      }
      if (wormUnder(S, b)) return;                                             // P88: standing on another worm
      b.rest = false;
    }
    // PoC dynamics in 3D (worm gravity, head-on / glancing landings, dizziness, skids with bounce 0.3 / friction 0.72)
    const sp0 = M.len3(b.vel.x, b.vel.y, b.vel.z), y0 = b.pos.y;
    // P38 R9: terminal velocity
    if (sp0 > WD.V_MAX) {
      const k = WD.V_MAX / sp0;
      b.vel.x *= k;
      b.vel.y *= k;
      b.vel.z *= k;
    }
    const n = M.max(1, Math.ceil(M.len3(b.vel.x, b.vel.y, b.vel.z) * dt / 0.08)), h = dt / n, nv = { x: 0, y: 0, z: 0 };
    let touched = false;
    for (let i = 0; i < n && !b.rest; i++) {
      planeLock(S, b);
      b.vel.y -= GW * WM.gravity_k(S, b) * h;
      const nx = b.pos.x + b.vel.x * h, nz = b.pos.z + b.vel.z * h, ny = b.pos.y + b.vel.y * h;
      const lf = lavaFloor(S, nx, nz, b);
      // LV3: lands on lava (crossing its surface) and floats
      if (b.vel.y <= 0 && lf > -1e8 && ny - foot <= lf && b.pos.y - foot > lf - C.LAVA.DEEP) {
        if (b.vel.y < -2) sim.emit(S, EV.LAVAPLOP, { x: b.pos.x, y: lf + (b.lsink || 0), z: b.pos.z, speed: -b.vel.y });
        b.pos.x = nx;
        b.pos.z = nz;
        b.pos.y = lf + foot;
        b.vel.y = 0;
        b.vel.x *= 0.3;
        b.vel.z *= 0.3;
        b.slide = false;
        landHurt(S, b, 0);
        break;
      }
      const df = deckFloor(S, nx, b.pos.y - foot + 0.05, nz);                    // M: a bridge deck (a flat floor)
      let hit = false, onProp = false;
      if (b.vel.y <= 0 && df > -1e8 && ny - foot <= df) {
        nv.x = 0;
        nv.y = 1;
        nv.z = 0;
        hit = true;
      }
      // P118a: a sleeping prop under the feet (its upper half: below the sphere's centre the worm passes by)
      else if (b.vel.y <= 0 && propDepth(S, nx, ny - foot, nz, 0, WD.PROP_PAD, pn) > 0 && pn.y > 0) {
        nv.x = pn.x;
        nv.y = pn.y;
        nv.z = pn.z;
        hit = true;
        onProp = true;
      }
      else if (w.sample(nx, ny - foot, nz) > 0 || blocked3(nx, ny, nz)) {
        // the contact point: below the feet when falling onto ground, else the body's side
        if (w.sample(nx, ny - foot, nz) > 0) w.normal(nx, ny - foot, nz, nv);
        else w.normal(nx, ny, nz, nv);
        hit = true;
      }
      const wo = hit ? null : wormHit(S, b, nx, ny, nz, nv);                    // P88: another worm's ball
      if (!hit && !wo) {
        b.pos.x = nx;
        b.pos.y = ny;
        b.pos.z = nz;
        continue;
      }
      touched = true;
      const vn = b.vel.x * nv.x + b.vel.y * nv.y + b.vel.z * nv.z;
      if (wo) {
        if (wormLand(S, b, wo, nv, vn, nx, ny, nz)) break;
        continue;
      }
      // P118a: the shoulder of a ball (past the 32 degrees a worm's head holds): no hold, it rolls off with its
      // tangential speed
      if (onProp && vn < 0 && nv.y < WD.STACK_NY) {
        // (out onto the sphere's surface, along its normal)
        const dep = M.min(0.3, propDepth(S, nx, ny - foot, nz, 0, WD.PROP_PAD, pn2)),
          px = nx + pn2.x * dep,
          py = ny + pn2.y * dep,
          pz = nz + pn2.z * dep;
        // wedged between the prop and the rock (a log against a wall): nowhere to roll to, it stays
        if (w.sample(px, py - foot, pz) > 0 || blocked3(px, py, pz)) {
          b.vel.x = b.vel.y = b.vel.z = 0;
          b.rest = true;
          b.slide = false;
          b.stillT = 0;
          landHurt(S, b, 0);
          break;
        }
        b.vel.x = (b.vel.x - vn * nv.x) * WD.FRIC;
        b.vel.y = (b.vel.y - vn * nv.y) * WD.FRIC;
        b.vel.z = (b.vel.z - vn * nv.z) * WD.FRIC;
        b.slide = true;
        b.pos.x = px; b.pos.y = py; b.pos.z = pz;
        continue;
      }
      if (vn >= 0) {
        b.pos.x = nx;
        b.pos.z = nz;
        continue;
      }
      const imp = -vn, sp = M.len3(b.vel.x, b.vel.y, b.vel.z), tx = b.vel.x - vn * nv.x, ty = b.vel.y - vn * nv.y, tz = b.vel.z - vn * nv.z;
      const along = M.len3(tx, ty, tz) / M.max(1e-6, sp);
      if (imp > WD.FALL_SAFE && nv.y > 0.2) {
        const head = along < WD.HEAD_ALONG,
          dmg = head
            ? M.min(WD.HEAD_MAX, Math.round((imp - WD.FALL_SAFE) * WD.HEAD_K) + WD.HEAD_ADD)
            : M.min(WD.GLANCE_MAX, Math.round((imp - WD.FALL_SAFE) * WD.GLANCE_K));
        sim.emit(S, EV.LAND, {
          wormId: b.id,
          x: b.pos.x,
          y: b.pos.y - foot,
          z: b.pos.z,
          speed: imp,
          mat: w.mat_at(b.pos.x, b.pos.y - foot - 0.2, b.pos.z),
          hard: 1
        });
        b.landDmg = dmg;                                                         // (applied after the rebound below)
        if (head) {
          const up = M.min(WD.HEAD_UP_MAX, WD.HEAD_UP_K * imp);
          b.vel.x = nv.x * up;
          b.vel.y = nv.y * up;
          b.vel.z = nv.z * up;
          b.dizzyUntil = S.time + WD.DIZZY;
          b.squash = S.time;
          sim.emit(S, EV.DIZZY, { wormId: b.id});
        }
        else {
          b.vel.x = tx * WD.FRIC - nv.x * vn * WD.BOUNCE;
          b.vel.y = ty * WD.FRIC - nv.y * vn * WD.BOUNCE;
          b.vel.z = tz * WD.FRIC - nv.z * vn * WD.BOUNCE;
        }
        b.slide = true;
        landHurt(S, b, b.landDmg);
      } else if (!b.slide && nv.y > WD.FIRM_NY) {                              // a firm landing stops dead
        if (imp > 3)
          sim.emit(S, EV.LAND, {
            wormId: b.id,
            x: b.pos.x,
            y: b.pos.y - foot,
            z: b.pos.z,
            speed: imp,
            mat: w.mat_at(b.pos.x, b.pos.y - foot - 0.2, b.pos.z)
          });
        b.vel.x = b.vel.y = b.vel.z = 0;
        b.rest = true;
        b.stillT = 0;
        landHurt(S, b, 0);
      } else {
        b.vel.x = tx * WD.FRIC - nv.x * vn * WD.BOUNCE;
        b.vel.y = ty * WD.FRIC - nv.y * vn * WD.BOUNCE;
        b.vel.z = tz * WD.FRIC - nv.z * vn * WD.BOUNCE;
      }
      // stand on top of the ground (never inside it)
      // (P38 R9: only while the lift does not push the body centre deeper into the rock: a worm thrown into a slot used
      // to climb 1.2 m per step into the ceiling)
      let y = b.pos.y;
      const c0 = w.sample(b.pos.x, y, b.pos.z);
      for (
        let k = 0;
        k < 30
          && (
            w.sample(b.pos.x, y - foot, b.pos.z) > 0
            || (df > -1e8 && y - foot < df)
            || (onProp && propDepth(S, b.pos.x, y - foot, b.pos.z, 0, WD.PROP_PAD, pn2) > 0 && pn2.y > 0)
          );
        k++
      ) {
        if (w.sample(b.pos.x, y + 0.04, b.pos.z) > M.max(c0, 0) + 0.15) break;
        y += 0.04;
      }
      b.pos.y = y;
    }
    // a skidding worm comes to rest when slow and supported for 0.45 s (PoC still), or a soft touch
    if (!b.rest && touched) {
      const sp = M.len3(b.vel.x, b.vel.y, b.vel.z);
      if (sp < WD.STILL_V) {
        b.stillT = (b.stillT || 0) + dt;
        if (b.stillT > WD.STILL_T || (!b.slide && sp < WD.SOFT_V)) {
          b.vel.x = b.vel.y = b.vel.z = 0;
          b.rest = true;
          b.slide = false;
          b.stillT = 0;
          landHurt(S, b, 0);
        }
      }
      else b.stillT = 0;
    }
    if (!b.rest && !b.dead) pin_step(S, b, y0, b.vel.y, dt);          // P38 R9: wedged in rock (see pin_step)
  }
  WM.body_3d = body3D;

  function ropeDip(S, w, dt) {
    const rw = w.ropeWet, WD = C.WORM_DYN;
    rw.t += dt;
    const k = rw.t > WD.ROPE_GRACE ? Math.floor((rw.t - WD.ROPE_GRACE) / WD.ROPE_TICK) : 0;
    while (rw.k < k && !w.dead && w.hp > 0) {
      rw.k++;
      DM.hurt(S, w, WD.ROPE_DMG, DS.DROWNING, HF.DOT);
    }
  }
  /* environmental hazards for every worm: water (waves, drowning), lava, fire */
  function hazards(S, wm, dt) {
    const w = W;
    if (S.eow) SS.eow.hazard(S, wm, dt);                           // P68c: the core and the void
    const surf = sim.surface_at(S, wm.pos.x, wm.pos.z);
    if (wm.pos.y < surf - 0.1) {
      // P107 (user 2026-10-12): a worm on the ninja rope stays on it in water: no detach, no swim, no drown, no life
      // jacket, no turn end. Submerged (body centre under the surface) for more than ROPE_GRACE s it loses ROPE_DMG HP
      // every second (whole points, the normal hurt path: a death is death by damage). Surfacing resets the clock. Lava
      // is not water: a worm roped into lava keeps the old rule (SWIM_DPS at once, P33c).
      if (wm === S.active && S.rope && S.rope.hooked) {
        if (!wm.ropeWet) wm.ropeWet = { acc: 0, tick: S.time, t: 0, k: 0 };
        if (SS.lava && S.lava && SS.lava.depth_at(S, wm.pos.x, wm.pos.z) > 0.01) SW.water_damage(S, wm, dt, wm.ropeWet);
        else ropeDip(S, wm, dt);
        return;
      }
      if (wm.ropeWet && wm.hp <= 0) return;                        // P107: it died by damage on the rope: no swim / drown on top of that
      SW.start(S, wm); return;
    }
    wm.ropeWet = null;
    if (SS.water && S.water && wm.pos.y - 0.5 < surf) {
      // a wave running over the worm: drag it along with the water
      const v = SS.water.vel(S, wm.pos.x, wm.pos.z, wv), sub = M.clamp((surf - (wm.pos.y - 0.5)) / 0.6, 0, 1), sp = M.len2(v.x, v.z);
      // PoC washWorms (L6283): a wave of >= 1.6 m/s (here 1.2: the shallow-water surge of a 0.7 m wave runs 1.5-1.7 m/s
      // at the waterline, the ambient swell never wets a beach worm) over the feet of a standing worm THROWS it along
      // the flow (vx = 70 + 0.8 v px/s, vy = 60 + 0.4 v up; it skids), at most every 1.2 s
      const WD = C.WORM_DYN, grounded = WM.ctl(S, wm) ? !wm.air : wm.rest;
      if (sub > 0.05 && sp >= WD.WASH_V && grounded && S.time - (wm.washT || -9) > WD.WASH_COOL) {
        const ux = v.x / sp, uz = v.z / sp, hv = WD.WASH_VS + WD.WASH_K * sp, vy = WD.WASH_VY + WD.WASH_KY * sp;
        if (WM.ctl(S, wm)) {
          const d = P.dir(S);
          wm.air = true;
          wm.vs = (ux * d.x + uz * d.z) * hv;
          wm.vy = vy;
        }
        else {
          wm.rest = false;
          wm.vel.x = ux * hv;
          wm.vel.z = uz * hv;
          wm.vel.y = vy;
        }
        wm.slide = true; wm.washT = S.time;
        sim.emit(S, EV.WASH, { wormId: wm.id, x: wm.pos.x, y: surf, z: wm.pos.z });
        sim.log(S, `A wave throws ${wm.name} off the shore!`, 0x7fc3ff);
      }
    }
    // dry worlds: lost far out in the open desert (beyond FAR_R; no blast throws a worm that far, a safety net)
    if (w.dry && SP.arena_r(wm.pos.x, wm.pos.z) > DRY.FAR_R) {
      DM.lost(S, wm);
      return;
    }
    // dry worlds: the sand beyond the play area is hot (1 HP / 5 s while touching it; one log line per visit)
    if (w.dry && SP.arena_r(wm.pos.x, wm.pos.z) > S.playR && w.sample(wm.pos.x, wm.pos.y - wm.foot - 0.15, wm.pos.z) > 0) {
      if (!(S.time - wm.hotT < 2)) {
        sim.emit(S, EV.HOTSAND, { wormId: wm.id, x: wm.pos.x, y: wm.pos.y, z: wm.pos.z });
        sim.log(S, `${wm.name} is on hot sand: -1 HP every 5 s until back in the dunes' heart.`, 0xffb27a);
      }
      wm.hotT = S.time;
      DM.burn(S, wm, DRY.HOT_DPS, dt, DS.HOT_SAND, HF.QUIET);
    }
    const sdd = SS.game.final_drain(S);                            // P38 R9: the final stage of sudden death (game.js)
    if (sdd > 0) DM.burn(S, wm, sdd, dt, DS.SUDDEN_DEATH, HF.QUIET);
    const m = w.mat_at(wm.pos.x, wm.pos.y - 0.62, wm.pos.z);
    if (m === MAT.LAVA) DM.burn(S, wm, C.LAVA_DPS, dt, DS.LAVA);
    // open lava (LV3): the worm floats. Its immersion relaxes toward the buoyancy equilibrium RHO_WORM / RHO of its
    // height, minus the share of its weight the skin's yield stress carries (cool crust holds it up), at a viscous
    // rate; it burns by immersion and temperature (a cold crust does not). Nothing light is engulfed any more.
    const LA = C.LAVA, dep = SS.lava && S.lava ? SS.lava.depth_at(S, wm.pos.x, wm.pos.z) : 0;
    if (dep > 0.01 && wm.pos.y - wm.foot <= lavaFloor(S, wm.pos.x, wm.pos.z, wm) + 0.1) {     // resting on the lava
      const T = SS.lava.temp_at(S, wm.pos.x, wm.pos.z), cool = M.clamp(1 - T, 0, 1);
      const yl = LA.YIELD * M.exp(LA.YIELD_K * cool), sup = M.clamp(LA.RHO * yl / (LA.RHO_WORM * C.WORM_H), 0, 1);
      const eq = M.min(dep, LA.RHO_WORM / LA.RHO * C.WORM_H * (1 - sup)), tau = LA.SINK_TAU * M.exp(LA.NU_K * cool);
      wm.lsink = (wm.lsink || 0) + (eq - (wm.lsink || 0)) * M.min(1, dt / tau);
    } else wm.lsink = 0;
    const lv = sim.lava_contact(S, wm.pos.x, wm.pos.y - wm.foot, wm.pos.z, lc);
    if (lv.sub > 0 && lv.heat > 0) DM.burn(S, wm, C.LAVA_DPS * lv.heat * (0.5 + M.clamp(lv.sub / 0.4, 0, 1)), dt, DS.LAVA);
    // burning grass (same once-per-step rule as scatter's scorch: oil + grass do not stack)
    if (SS.veg && SS.veg.fire_at(S, wm.pos.x, wm.pos.y, wm.pos.z) > 0) {
      const k = S.tick;
      if (wm.fireStep !== k) {
        wm.fireStep = k;
        wm.fireT = S.time;
        DM.burn(S, wm, C.FIRE_DPS, dt, DS.BURNING_GRASS);
      }
    }
  }
  WM.hazards = hazards;
})(window.SS = window.SS || {});
