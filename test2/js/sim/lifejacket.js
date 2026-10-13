/* sim/lifejacket.js — P89: the life jacket (user 2026-10-12: "life jackets, default 3, enabled by default; when a worm
 * lands in
 * water it inflates the jacket (after losing some health), then floats and slowly, on its own, swims back to the land;
 * in a river small currents can move it a bit off course, in the ocean it saves the life too and there are no
 * currents").
 *
 * It rides on the existing water entry of sim.js (swimStart / swimStep: the worm becomes a swimmer, w.swim). When the
 * worm's team has the jacket enabled with charges left (sim/gear.js), swimStart calls enter() and the swim becomes a
 * jacket swim (w.swim.jk = 1) driven by step() here instead of the struggle that bills SWIM_DPS:
 *   enter   water deeper than K.MIN_DEPTH (no puddle), not in lava, not in space: one charge, K.HP_LOSS HP (never
 *           lethal: the
 *           hit stops at 1 HP) for the cold-water shock / the hard landing on the water, then the vest inflates (event
 *           'jacket')
 *   float   the worm rides K.FLOAT_Y under the smoothed water surface with a slow bob: no jitter from the waves, no
 *           thrashing,
 *           no HP loss, however long the swim takes (no timeout: a vest does not run out of air)
 *   swim    toward the nearest REACHABLE shore at K.SWIM_V m/s: a breadth-first search over the water columns (8
 *           neighbours; a dry
 *           column is a shore only when its ground is at most K.CLIMB above the water and not lava / water), redone
 *           every K.RETARGET_T s (the shore moves when the sea rises, the swimmer is carried by a current, a bank is
 *           blasted), the path is followed to the farthest waypoint with a clear straight line (so the open sea gives a
 *   straight line) current only in water that is not sea (a river, a lake, flood water): the surface flow SS.water.vel
 *           x K.DRIFT_K, at most K.DRIFT_MAX m/s (a third of the swim speed: it can never stop the rescue); the sea
 *           (st.sea) has none
 *   out     at the shore column it climbs out (the existing climb-out rules), the jacket deflates (event 'jacketend')
 * The active worm (and every worm in 2D) searches only along the section line (the plane must not be left), the others
 * in 3D. No shore reachable (a flooded island, walls all round): it floats and the search repeats every
 * K.RETARGET_T_LONG s; the turn does not wait for it (settled() ignores a jacket swimmer after K.HOLD_T s) and the
 * sudden-death final drain still bills it (no safe place is left then), so a match can never stall on a floating worm.
 * Not rescued: lava (it burns), EOW (no water), a puddle shallower than K.MIN_DEPTH (the old shallow swim), a worm
 * already swimming (no second charge: a hit while floating is a normal hit, a blast's push is ignored as for every
 * swimmer). C layout: struct SwimJk { u8 jk; f32 ys, rt, stuck, gx, gz; i16 pi, npath; f32 path[2 * PATH_MAX]; } inside
 * struct Swim; scratch i32 par[], seen[], queue[] (NX * NZ). P107 (user 2026-10-12: "my blue worm was on a life jacket
 * but no land to get to, it was my turn and I couldn't use anything, no rope, no teleport"): a jacket worm on its own
 * turn is a PLAYABLE worm. sim.js used to skip controlActive for every swimmer, so the turn timer ran out on a floating
 * worm. Now control() runs the shared control (weapon choice, aim, the fire key) with the jacket rules: left / right
 * paddles (K.PADDLE m/s, along the section, the auto-swim to the shore pauses while a key is held), the ninja rope /
 * teleport are allowed and the jacket comes off cleanly (release: no swim state, the charge stays spent) when the rope
 * bites or the teleport lands, shells and bolts may be fired from the surface; what needs a footing (drops, melee,
 * torch / drill, parachute, zipline) is greyed out with a hint (no_weapon, also sim.weapons.can_use, so the CPU never
 * picks it). The EOW jetpack: there is no water in space, nothing to do. API: enter(S, w, surf), step(S, w, dt),
 * holds(S, w), control(S, a, dt, inp, retreat), release(S, w, why), no_weapon(S, key), K (constants).
 */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane;
  const JK = SS.jacket = {};
  const K = JK.K = {
    HP_LOSS: 6, MIN_DEPTH: 0.6, HOLD_T: 5, SWIM_V: 1.0, DRIFT_K: 0.5, DRIFT_MAX: 0.3, RETARGET_T: 1.2, RETARGET_T_LONG: 3, CLIMB: 1.4,
    PADDLE: 1.6, FLOAT_Y: 0.1, BOB_A: 0.025, BOB_W: 2.1, LOOK: 6, LINE_R: 150, UP_RATE: 2.5, DOWN_RATE: 3
  };
  const W = () => SS.world, sim = () => SS.sim;
  const WETD = 0.004;                                  // = sim.js landAt: a column deeper than this is water
  const tmpv = { x: 0, y: 0, z: 0 };
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DZ = [0, 0, 1, -1, 1, -1, 1, -1];
  let par = null, seen = null, queue = null, gen = 0;   // scratch of the search (not game state: rebuilt on every call)

  const wetAt = (S, x, z) => !!(SS.water && S.water) && SS.water.depth(S, x, z) > WETD;
  const lavaAt = (S, x, z) => !!(SS.lava && S.lava) && SS.lava.depth_at(S, x, z) > 0.01;
  /* a column a swimmer can climb out onto (sim.js landAt with the jacket's climb height): its ground height, or -1e9 */
  function land(S, x, z, surf) {
    const w = W(), i = Math.round(x / w.H), k = Math.round(z / w.H);
    if (i < 1 || k < 1 || i >= w.NX - 1 || k >= w.NZ - 1) return -1e9;
    if (SS.ice && S.ice) {
      const it = SS.ice.top_at(S, x, z);
      if (it > -1e8) return it;
    }
    if (wetAt(S, x, z) || lavaAt(S, x, z)) return -1e9;
    const t = w.top[k * w.NX + i];
    return t >= surf - 0.4 && t <= surf + K.CLIMB ? t : -1e9;
  }
  function isSea(S, x, z) {
    const st = S.water, w = W();
    if (!st || !st.sea) return true;
    const i = M.clamp(Math.round(x / w.H), 0, st.NX - 1), k = M.clamp(Math.round(z / w.H), 0, st.NZ - 1);
    return st.sea[k * st.NX + i] !== 0;
  }
  /* is the straight line (x0, z0) -> (x1, z1) open water (or the goal column at its end)? */
  function clear(S, x0, z0, x1, z1, gx, gz) {
    const L = M.len2(x1 - x0, z1 - z0), n = M.max(1, Math.ceil(L / 0.4));
    for (let q = 1; q <= n; q++) {
      const x = x0 + (x1 - x0) * q / n, z = z0 + (z1 - z0) * q / n;
      if (!wetAt(S, x, z) && M.len2(x - gx, z - gz) > 0.6) return false;
      if (lavaAt(S, x, z)) return false;
    }
    return true;
  }
  /* nearest shore column by breadth-first search over the water columns; fills sw.path (x, z pairs, start excluded) */
  function search(S, w, sw) {
    const st = S.water, wd = W(), NX = wd.NX, NZ = wd.NZ, n = NX * NZ, H = wd.H;
    if (!st || st.NX !== NX) return false;
    if (!par || par.length !== n) {
      par = new Int32Array(n);
      seen = new Int32Array(n);
      queue = new Int32Array(n);
      gen = 0;
    }
    gen++;
    const i0 = M.clamp(Math.round(w.pos.x / H), 0, NX - 1), k0 = M.clamp(Math.round(w.pos.z / H), 0, NZ - 1), c0 = k0 * NX + i0;
    let qh = 0, qt = 0, goal = -1;
    queue[qt++] = c0; seen[c0] = gen; par[c0] = -1;
    const nd = wd.flat ? 2 : 8;                            // 2D: along the slice only
    while (qh < qt && goal < 0) {
      const c = queue[qh++], ci = c % NX, ck = (c - ci) / NX, surfC = c === c0 ? sw.ys : st.bed[c] + st.h[c];
      for (let d = 0; d < nd; d++) {
        const ni = ci + DX[d], nk = ck + DZ[d];
        if (ni < 1 || nk < 1 || ni >= NX - 1 || nk >= NZ - 1) continue;
        const m = nk * NX + ni;
        if (seen[m] === gen) continue;
        seen[m] = gen; par[m] = c;
        if (st.h[m] > WETD) {
          if (!lavaAt(S, ni * H, nk * H)) queue[qt++] = m;
        }
        else if (land(S, ni * H, nk * H, surfC) > -1e8) {
          goal = m;
          break;
        }
      }
    }
    if (goal < 0) return false;
    let len = 0;
    for (let c = goal; c >= 0 && c !== c0; c = par[c]) len++;
    const path = new Array(len * 2);
    let o = len;
    for (let c = goal; c >= 0 && c !== c0; c = par[c]) {
      o--;
      path[o * 2] = (c % NX) * H;
      path[o * 2 + 1] = ((c - (c % NX)) / NX) * H;
    }
    sw.path = path;
    sw.pi = 0;
    sw.gx = path[len * 2 - 2];
    sw.gz = path[len * 2 - 1];
    return true;
  }
  /* the section line: nearest shore along +-plane direction (the active worm may not leave its plane) */
  function lineSearch(S, w, sw) {
    const d = P.dir(S);
    let best = 1e9, bx = 0, bz = 0;
    for (let q = 0; q < 2; q++) {
      const sg = q ? -1 : 1;
      for (let r = 0.5; r <= K.LINE_R; r += 0.5) {
        const x = w.pos.x + sg * d.x * r, z = w.pos.z + sg * d.z * r;
        if (wetAt(S, x, z)) {
          if (lavaAt(S, x, z)) break;
          continue;
        }
        if (land(S, x, z, sw.ys) > -1e8 && r < best) {
          best = r;
          bx = x;
          bz = z;
        }
        break;
      }
    }
    if (best >= 1e9) return false;
    sw.path = [bx, bz];
    sw.pi = 0;
    sw.gx = bx;
    sw.gz = bz;
    return true;
  }
  function retarget(S, w, sw) {
    let line = w === S.active || !!W().flat;
    let ok = line ? lineSearch(S, w, sw) : search(S, w, sw);
    // P91: no shore along the section: a swimmer is not under control, so the search may leave the plane (the next turn
    // re-centres it)
    if (!ok && line) {
      ok = search(S, w, sw);
      if (ok) line = false;
    }
    sw.land = ok; sw.line = line ? 1 : 0;
    sw.rt = S.time + (ok ? K.RETARGET_T : K.RETARGET_T_LONG);
    if (ok) {
      sw.tx = sw.gx;
      sw.tz = sw.gz;
    } else {
      sw.tx = w.pos.x;
      sw.tz = w.pos.z;
    }
  }

  /* swimStart: the worm just became a swimmer. Returns true when the jacket inflated. */
  JK.enter = function (S, w, surf) {
    const sw = w.swim, G = SS.gear;
    if (!sw || !G || S.eow || w.dead || w.drowning || sw.jk) return false;
    if (!G.ready(S, w.team, G.JACKET)) return false;
    if (!SS.water || !S.water || SS.water.depth(S, w.pos.x, w.pos.z) < K.MIN_DEPTH || lavaAt(S, w.pos.x, w.pos.z)) return false;
    G.use(S, w.team, G.JACKET);
    const loss = M.min(K.HP_LOSS, M.max(0, Math.floor(w.hp) - 1));
    if (loss > 0) sim().hurt(S, w, loss, C.DS.DROWNING, C.HF.QUIET);
    sw.jk = 1;
    sw.ys = surf;
    sw.stuck = 0;
    sw.path = [];
    sw.pi = 0;
    sw.gx = sw.gz = 0;
    sw.line = 0;
    sw.rt = S.time;
    sw.acc = 0;
    retarget(S, w, sw);
    sim().emit(S, 'jacket', { wormId: w.id, x: w.pos.x, y: surf, z: w.pos.z, land: sw.land, hp: loss, sea: isSea(S, w.pos.x, w.pos.z) });
    sim().log(
      S,
      `${w.name}'s life jacket inflates${loss > 0 ? ` (-${loss} HP)` : ''}: ${sw.land ? 'swimming for the shore.' : 'no shore in reach, floating.'}`,
      0xffa24a
    );
    return true;
  };
  /* does this swimmer still hold the turn? A jacket swim longer than HOLD_T s runs on in the background */
  JK.holds = (S, w) => !!w.swim && !(w.swim.jk && S.time - w.swim.t0 > K.HOLD_T);

  function lose(S, w, why) {
    w.swim = null; sim().emit(S, 'jacketend', { wormId: w.id, why: 'lost' });
    sim().drown(S, w);
  }
  /* the worm leaves the water at the column (x, z) whose ground is at height t: the common end of a swim (climb-out,
   * dry water, turn-start rescue) */
  function exitAt(S, w, x, z, t, why) {
    w.pos.x = x;
    w.pos.z = z;
    w.pos.y = t + w.foot + 0.02;
    w.swim = null;
    w.vel.x = w.vel.y = w.vel.z = 0; w.vs = 0; w.vy = 0;
    if (w === S.active) w.air = true;
    else w.rest = false;
    sim().emit(S, 'swimout', { wormId: w.id }); sim().emit(S, 'jacketend', { wormId: w.id, why: why });
    sim().log(S, `${w.name} climbs out and the life jacket deflates.`, 0xffa24a);
  }
  /* P107: the jacket comes off at once (the rope bit, the teleport landed): the worm is an ordinary airborne worm, no
   * swim flag is left behind */
  JK.release = function (S, w, why) {
    if (!w.swim || !w.swim.jk) return false;
    w.swim = null;
    w.vel.x = w.vel.y = w.vel.z = 0;
    w.vs = 0;
    w.vy = 0;
    w.air = true;
    w.rest = false;
    w.ropeWet = null;
    sim().emit(S, 'jacketend', { wormId: w.id, why: why });
    sim().log(S, `${w.name} slips the life jacket off (${why}).`, 0xffa24a);
    return true;
  };
  /* P107: which weapons a worm afloat can use. Shells, bolts, strikes from the sky, the rope and the teleport work from
   * the surface; what needs a footing
   * (dropped / planted things sink, a swing or a torch needs ground, a parachute needs a fall, a zipline needs a higher
   * anchor than the water) does not. Returns the reason (for the HUD hint and the log) or '' when the weapon is
   * allowed. */
  JK.REFUSE = {
    drop: 'No footing: it would only sink',
    melee: 'Needs a firm footing to swing',
    dig: 'Needs solid ground under you',
    chute: 'Only opens in a fall',
    zip: 'No higher anchor from the water'
  };
  JK.no_weapon = function (S, key) {
    const a = S.active;
    if (!a || !a.swim || !a.swim.jk) return '';
    const d = C.ARSENAL[key];
    if (!d || key === 'ffield') return '';
    return JK.REFUSE[d.kind] || '';
  };
  /* P107: the active jacket worm's turn (or retreat). The shared control of sim.js does the weapon choice / aim / fire
   * key; the swim step (JK.step) keeps floating it. */
  JK.control = function (S, a, dt, inp, retreat) {
    const sw = a.swim;
    if (!sw || !sw.jk || a.dead || a.drowning) return;
    // (the flags of a worm on its feet mean nothing afloat)
    a.flip = false;
    a.hop = false;
    a.windUp = 0;
    a.walking = false;
    a.slide = false;
    a.air = false;
    sim().control_pre(S, a, dt, inp, retreat);
    const mv = inp.move || 0;
    // paddle along the section (never out of it)
    if (mv && !S.charging && !S.rope && !S.hook) {
      a.facing = mv > 0 ? 1 : -1;
      const d = P.dir(S), st = K.PADDLE * dt * (inp.fine ? 0.5 : 1), nx = a.pos.x + d.x * a.facing * st, nz = a.pos.z + d.z * a.facing * st;
      let bank = sim().blocked3(nx, a.pos.y, nz);
      for (let up = 0.1; up <= 0.41 && bank; up += 0.1)
        if (!sim().blocked3(nx, a.pos.y + up, nz)) {
          a.pos.y += up;
          bank = false;
        }
      if (!bank && sim().in_play(S, nx, nz)) {
        a.pos.x = nx;
        a.pos.z = nz;
        sw.manual = S.tick;
      }
    }
    if (retreat) return;
    if (S.hook) SS.traverse.hook_step(S, a, dt);
    if (S.rope) {
      JK.release(S, a, 'rope');
      return;
    }
    const key = S.weapon, why = JK.no_weapon(S, key), tele = S.teleT > 0;
    if (why) {
      if (inp.fire_pressed && S.phase === 'play') sim().log(S, `${C.ARSENAL[key].name}: ${why}.`, 0xffb27a);
      return;
    }
    sim().control_fire(S, a, dt, inp, false);
    if (S.rope) {
      JK.release(S, a, 'rope');
      return;
    }
    if (S.teleT > 0 && !tele) JK.release(S, a, 'teleport');
  };

  /* P91: haul a jacket swimmer out NOW (the turn was handed to it: a worm in the water cannot act). Returns true when
   * it is on land. */
  JK.haul = function (S, w) {
    const sw = w.swim;
    if (!sw || !sw.jk) return false;
    for (let tries = 0; tries < 2; tries++) {
      retarget(S, w, sw);
      if (!sw.land) return false;
      const surf2 = sim().surface_at(S, sw.gx, sw.gz), t = land(S, sw.gx, sw.gz, surf2 > -90 ? surf2 : sw.ys);
      if (t > -1e8) {
        exitAt(S, w, sw.gx, sw.gz, t, 'turn');
        return true;
      }
    }
    return false;
  };
  /* one fixed step of a jacket swim (called from swimStep after it zeroed the velocity) */
  JK.step = function (S, w, dt) {
    const sw = w.swim, wd = W();
    if (w.hp <= 0) {
      lose(S, w);
      return;
    }
    const sdd = SS.game.final_drain(S);                    // the last stage of sudden death bills a floater too (no match stalls on one)
    if (sdd > 0) {
      sim().burn(S, w, sdd, dt, C.DS.SUDDEN_DEATH, C.HF.QUIET);
      if (w.hp <= 0) {
        lose(S, w);
        return;
      }
    }
    // P91: the water is gone from under the swimmer (it receded, or the worm waded onto a bar): it stands on the ground
    // it is over, no jacket swim on dry land
    if (!wetAt(S, w.pos.x, w.pos.z) && !lavaAt(S, w.pos.x, w.pos.z)) {
      const g = land(S, w.pos.x, w.pos.z, sw.ys);
      if (g > -1e8 && w.pos.y - w.foot <= g + 0.4) {
        exitAt(S, w, w.pos.x, w.pos.z, g, 'dry');
        return;
      }
    }
    // the surface, smoothed (a wave must not shake the worm), and the float height with a slow bob
    const surf = sim().surface_at(S, w.pos.x, w.pos.z);
    if (surf > -90) sw.ys += (surf - sw.ys) * M.min(1, 4 * dt);
    const ty = sw.ys - K.FLOAT_Y + K.BOB_A * M.sin((S.time - sw.t0) * K.BOB_W), dy = ty - w.pos.y;
    const fy = w.pos.y + M.clamp(dy * M.min(1, 6 * dt), -K.DOWN_RATE * dt, K.UP_RATE * dt);
    if (!(fy < w.pos.y && sim().blocked3(w.pos.x, fy, w.pos.z))) w.pos.y = fy;
    if (S.time >= sw.rt) retarget(S, w, sw);
    // the current: only outside the sea; along the plane for the active worm / in 2D
    let cx = 0, cz = 0;
    if (!isSea(S, w.pos.x, w.pos.z)) {
      SS.water.vel(S, w.pos.x, w.pos.z, tmpv);
      let vx = tmpv.x * K.DRIFT_K, vz = tmpv.z * K.DRIFT_K;
      if (sw.line) {
        const d = P.dir(S), a = vx * d.x + vz * d.z;
        vx = a * d.x;
        vz = a * d.z;
      }
      const L = M.len2(vx, vz);
      if (L > K.DRIFT_MAX) {
        vx *= K.DRIFT_MAX / L;
        vz *= K.DRIFT_MAX / L;
      }
      cx = vx; cz = vz;
    }
    sw.cx = cx; sw.cz = cz;                                // presentation (the wake leans with it)
    let nx = w.pos.x + cx * dt, nz = w.pos.z + cz * dt;
    if (sw.land && sw.path.length >= 2 && sw.manual !== S.tick) {                       // (P107: not while the player paddles)
      const np = sw.path.length / 2;
      while (sw.pi < np - 1 && M.len2(sw.path[sw.pi * 2] - w.pos.x, sw.path[sw.pi * 2 + 1] - w.pos.z) < 0.6) sw.pi++;
      let j = M.min(np - 1, sw.pi + K.LOOK);
      while (j > sw.pi && !clear(S, w.pos.x, w.pos.z, sw.path[j * 2], sw.path[j * 2 + 1], sw.gx, sw.gz)) j--;
      sw.tx = sw.path[j * 2]; sw.tz = sw.path[j * 2 + 1];
      const gdx = sw.gx - w.pos.x, gdz = sw.gz - w.pos.z, GL = M.len2(gdx, gdz);
      const dx = sw.tx - w.pos.x, dz = sw.tz - w.pos.z, L = M.len2(dx, dz), st = M.min(L, K.SWIM_V * dt);
      if (L > 1e-4) {
        nx += dx / L * st;
        nz += dz / L * st;
      }
      // a submerged slope: step up over it; the real bank close by: climb out there
      let bank = sim().blocked3(nx, w.pos.y, nz);
      for (let up = 0.1; up <= 0.41 && bank; up += 0.1)
        if (!sim().blocked3(nx, w.pos.y + up, nz)) {
          w.pos.y += up;
          bank = false;
        }
      if (!bank) {
        w.pos.x = nx;
        w.pos.z = nz;
      }
      sw.stuck = bank ? (sw.stuck || 0) + dt : 0;
      // wedged on a submerged ledge far from the shore: look for another way (never a teleport)
      if (bank && GL >= 0.9 && sw.stuck > 0.6) {
        sw.rt = S.time;
        sw.stuck = 0;
      }
      if ((bank && GL < 0.9) || GL < 0.3) {
        const surf2 = sim().surface_at(S, sw.gx, sw.gz), t = land(S, sw.gx, sw.gz, surf2 > -90 ? surf2 : sw.ys);
        if (t > -1e8) {
          exitAt(S, w, sw.gx, sw.gz, t, 'shore');
          return;
        }
        sw.rt = S.time;                                    // the shore column is gone: look again at once
      }
    } else if (cx || cz) {
      if (!sim().blocked3(nx, w.pos.y, nz)) {
        w.pos.x = nx;
        w.pos.z = nz;
      }
    }
  };
})(window.SS = window.SS || {});
