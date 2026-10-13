/* sim/ffield.js — P37 W4: the force field generator.
 * A planted generator (a small device on the ground) keeps a glass-like dome of radius R about it.
 *   - Worms walk through it. A shell that meets the dome from OUTSIDE bounces off ONCE (the field's single charge) into
 *     a random direction in the outward hemisphere (in 3D, so it leaves the 2D attack plane for good). It flies on as a
 *     free 3D projectile (S.free3d: gravity, terrain / worm contact, the shell's own fuse and burst) and the camera
 *     goes to a full 3D view (S.forceInspect) to show where it lands. Events carry the impact point for the render's
 *     ripples.
 *   - A charge that goes off INSIDE the dome is contained: only LEAK of its blast gets out (a small crater, little
 *     damage outside), worms inside take CONTAIN_K x the charge's damage on top and are flung about; the rest of the
 *     energy is stored in the field (charge, kg TNT-equivalent).
 *   - When the generator is destroyed (a blast reaches it: hp 0) the field drops and the stored energy is released a
 *     moment later as a second explosion that also cracks the ground and nearby rocks into big pieces (collapse.detach
 *     -> rigid chunks, rocks -> balls: the collapse / rubble systems).
 * C layout: struct Field { i32 id; u8 team; i32 owner; vec3 pos; f32 cy, R, hp, charge, born; u8 state /0 up, 1 down/,
 *   charges /bounces left/, turns; }; struct Free3d { i32 id; u8 type; vec3 pos, vel; i32 owner; f32 fuse, age; u8
 *   bounces, wet; f32 hitW; };
 *   struct Rel { f32 t; vec3 pos; f32 W; };   S.ffields[MAX], S.free3d[MAX], S.ffRel[4].
 * API: init(S), use(S, a), step(S, dt), blast(S, c, W, dmg), turn_start(S), busy(S), hash(S, mix),
 *   proj_hit(S, p, wpPrev, wp, def) (stepProjectiles: a plane shell reached the dome -> bool consumed),
 *   contain_pre(S, c, Wkg, wp) -> ctx | null, contain_post(S, c, Wkg, wp, ctx) (sim.explode), inside(S, p) -> field |
 *   null. */
(function (SS) {
  'use strict';
  const C = SS.CFG, M = SS.math, P = SS.plane, MAT = C.MAT;
  const EV = C.EV;
  const FF = SS.ffield = {};
  const W = () => SS.world;
  const sim = () => SS.sim;
  const WPN = () => SS.weapons;
  const K = C.TOOLB = C.TOOLB || {};
  K.FIELD = { R: 4.2, HP: 90, LEAK: 0.4, CONTAIN_K: 1.6, CAP: 8, TURNS: 8, MAX: 3, UP: 0.4, MIN_REL: 0.25, REL_K: 1.6, REL_DELAY: 0.22,
    MAX_FREE: 24,
    CRACK_BLOBS: 5, CRACK_R: 1.2, CRACK_V: 7, ROCK_R: 6, SPEED_MIN: 6, V_KEEP: 0.85, INSPECT_T: 4 };
  const rng = S => M.rng_next(S.ffRng);
  const rr = (S, a, b) => a + (b - a) * rng(S);

  FF.init = function (S) {
    S.ffRng = M.rng_make(((Math.imul(S.settings.seed | 0, 3266489917) + 0x4f1b) >>> 0) || 1);
    S.ffields = [];
    S.free3d = [];
    S.ffRel = [];
    S.ffId = 0;
    S.forceInspect = 0;
    S.lightning = 0;
  };
  const centre = f => ({ x: f.pos.x, y: f.pos.y + K.FIELD.UP, z: f.pos.z });
  FF.centre = centre;
  FF.inside = function (S, p, margin) {
    for (const f of S.ffields)
      if (f.state === 0 && M.v3_dist(p, centre(f)) < f.R - (margin || 0)) return f;
    return null;
  };

  /* ---------- planting ---------- */
  FF.make = function (S, team, owner, p) {            // (the worm's use and the debug toolbox share it)
    const KF = K.FIELD,
      f = { id: ++S.ffId, team, owner, pos: p, R: KF.R, hp: KF.HP, charge: 0, born: S.time, state: 0, charges: 1, turns: KF.TURNS, vy: 0 };
    S.ffields.push(f); sim().emit(S, EV.FFPLANT, { x: p.x, y: p.y, z: p.z, R: KF.R, fid: f.id }); return f;
  };
  FF.use = function (S, a) {
    const KF = K.FIELD, ap = P.to_plane(S, a.pos);
    if (a.air || S.rope) {
      sim().log(S, 'Stand on the ground to plant the generator.', 0xffb27a);
      return false;
    }
    if (S.ffields.filter(f => f.state === 0).length >= KF.MAX) {
      sim().log(S, 'Too many force fields.', 0xffb27a);
      return false;
    }
    const w = P.to_world(S, ap.s + a.facing * 1.0, a.pos.y - 0.45), p = { x: w.x, y: w.y, z: w.z };
    let l = 0;
    while (W().sample(p.x, p.y, p.z) > 0 && l < 0.7) {
      p.y += 0.05;
      l += 0.05;
    }
    if (W().sample(p.x, p.y, p.z) > 0) {
      sim().log(S, 'No room for the generator here.', 0xffb27a);
      return false;
    }
    FF.make(S, a.team, a.id, p);
    sim().log(S, `${a.name} switches on a force field.`, sim().team_rgb(S, a.team));
    WPN().used(S, 'ffield'); return true;
  };

  /* ---------- a plane shell meets the dome ---------- */
  // random unit vector (deterministic stream)
  function randDir(S) {
    const u = rr(S, -1, 1), a = rr(S, 0, 6.2832), r = Math.sqrt(1 - u * u);
    return { x: r * M.cos(a), y: u, z: r * M.sin(a) };
  }
  FF.proj_hit = function (S, p, a, b, def) {
    if (!S.ffields.length || def.sheep) return false;
    const KF = K.FIELD, sp = M.len2(p.vs, p.vy);
    if (sp < 3) return false;
    for (const f of S.ffields) {
      if (f.state !== 0 || f.charges <= 0) continue;
      const c = centre(f), da = M.v3_dist(a, c), db = M.v3_dist(b, c);
      if (!(da >= f.R && db < f.R)) continue;
      // (P38 R1: no room for another free shell: it goes on as an ordinary 2D shell, no charge spent; before it
      // vanished and the charge was lost)
      if (S.free3d.length >= KF.MAX_FREE) return false;
      // bounce: an outward-hemisphere random direction, speed mostly kept
      const n = { x: (b.x - c.x) / (db || 1), y: (b.y - c.y) / (db || 1), z: (b.z - c.z) / (db || 1) };
      const u = randDir(S);
      let d = { x: u.x + n.x * 0.8, y: u.y + n.y * 0.8, z: u.z + n.z * 0.8 };
      let l = M.nz(M.len3(d.x, d.y, d.z), 1);
      d.x /= l;
      d.y /= l;
      d.z /= l;
      const dn = d.x * n.x + d.y * n.y + d.z * n.z;
      if (dn < 0.15) {
        const k = 0.15 - dn + 0.2;
        d.x += n.x * k;
        d.y += n.y * k;
        d.z += n.z * k;
        l = M.len3(d.x, d.y, d.z);
        d.x /= l;
        d.y /= l;
        d.z /= l;
      }
      const v = M.max(KF.SPEED_MIN, sp * KF.V_KEEP),
        hp = { x: c.x + n.x * (f.R + 0.05), y: c.y + n.y * (f.R + 0.05), z: c.z + n.z * (f.R + 0.05) };
      if (S.free3d.length < KF.MAX_FREE)
        S.free3d.push({
          id: ++S.ffId,
          type: p.type,
          pos: hp,
          vel: { x: d.x * v, y: d.y * v, z: d.z * v },
          owner: p.owner,
          fuse: p.fuse,
          age: 0,
          bounces: 0,
          wet: false,
          hitW: 0,
          spin: rr(S, -6, 6)
        });
      f.charges--; f.hitT = S.time;
      S.forceInspect = S.time + KF.INSPECT_T; S.lastBoom = S.time;
      sim().emit(S, EV.FFRIPPLE, { fid: f.id, x: hp.x, y: hp.y, z: hp.z, amp: 1 });
      sim().emit(S, EV.FFBOUNCE, { fid: f.id, x: hp.x, y: hp.y, z: hp.z, dx: d.x, dy: d.y, dz: d.z, type: p.type });
      sim().emit(S, EV.BANNER, { title: 'Deflected!', sub: 'The force field throws it into 3D' });
      sim()
        .log(S, `The force field throws the ${C.WEAPONS[p.type] ? C.WEAPONS[p.type].name.toLowerCase() : 'shell'} off into 3D!`, 0x9fe8ff);
      return true;
    }
    return false;
  };

  /* ---------- the bounced shell: a free 3D flight ---------- */
  function burst3(S, q, pos) {
    const pd = C.PROJ[q.type] || C.WEAPONS[q.type] || {}, own = q.owner, name = (C.WEAPONS[q.type] || {}).name || q.type;
    const i = S.free3d.indexOf(q);
    if (i >= 0) S.free3d.splice(i, 1);
    if (pd.split) {                                           // cluster / banana: the bomblets fly on in 3D
      if (pd.W > 0) sim().explode(S, pos, { W: pd.W, dmg: pd.dmg, name, frag: pd.frag, boom: pd.boom }, own);
      const sp = pd.split, sub = C.PROJ[sp.kind];
      for (let k = 0; k < sp.n && S.free3d.length < K.FIELD.MAX_FREE; k++) {
        const d = randDir(S), v = rr(S, sp.vy0, sp.vy1) + 2;
        S.free3d.push({
          id: ++S.ffId,
          type: sp.kind,
          pos: { x: pos.x, y: pos.y + 0.3, z: pos.z },
          vel: { x: d.x * v * 0.6 + rr(S, -1, 1) * sp.jx, y: Math.abs(d.y) * v + 1, z: d.z * v * 0.6 + rr(S, -1, 1) * sp.jx },
          owner: -1,
          fuse: sub && sub.fuse ? sub.fuse : 99,
          age: 0,
          bounces: 0,
          wet: false,
          hitW: 0,
          spin: 0
        });
      }
      return;
    }
    WPN().detonate(S, { type: q.type, owner: own, vs: 0, vy: 0, s: 0, y: pos.y, fuse: 0 }, pos);
    S.lastBoom = S.time;
  }
  function stepFree(S, q, dt) {
    const w = W(), pd = C.PROJ[q.type] || C.WEAPONS[q.type] || {}, imp = !!pd.impact && !(pd.arm && q.age < pd.arm);
    q.age += dt; q.fuse -= dt;
    S.lastBoom = S.time;
    const sp = M.len3(q.vel.x, q.vel.y, q.vel.z), n = M.max(1, Math.ceil(sp * dt / 0.08)), h = dt / n;
    for (let i = 0; i < n; i++) {
      // P68g: the field
      if (S.eow) SS.eow.body_g(S, q, h);
      else q.vel.y -= C.G * h;
      if (q.wet) {
        const dr = M.exp(-2.6 * h);
        q.vel.x *= dr;
        q.vel.y = q.vel.y * dr - C.G * 0.55 * h * 0.5;
        q.vel.z *= dr;
      }
      const nx = q.pos.x + q.vel.x * h, ny = q.pos.y + q.vel.y * h, nz = q.pos.z + q.vel.z * h;
      const oob = w.dry ? (sim().arena_r(nx, nz) > C.DRY.FAR_R) : (nx < -60 || nz < -60 || nx > w.SX + 60 || nz > w.SZ + 60);
      if (ny < 0.2 || oob) {
        S.free3d.splice(S.free3d.indexOf(q), 1);
        sim().log(S, `${(C.WEAPONS[q.type] || {}).name || 'The shell'} left the battlefield.`);
        return;
      }
      const surf = sim().surface_at(S, nx, nz);
      if (!q.wet && ny < surf && q.vel.y < 0) {
        sim().emit(S, EV.SPLASH, { x: nx, y: surf, z: nz, size: M.min(1.6, 0.4 + sp * 0.05), proj: 1 });
        if (imp) {
          burst3(S, q, { x: nx, y: surf - 0.15, z: nz });
          return;
        }
        q.wet = true;
        q.vel.x *= 0.35;
        q.vel.y *= 0.3;
        q.vel.z *= 0.35;
      }
      if (imp)
        for (const o of S.worms)
          if (!o.dead && M.v3_dist(o.pos, { x: nx, y: ny, z: nz }) < C.WORM_R + 0.12) {
            burst3(S, q, { x: nx, y: ny, z: nz });
            return;
          }
      if (w.sample(nx, ny, nz) > 0) {
        if (imp) {
          burst3(S, q, { x: q.pos.x, y: q.pos.y, z: q.pos.z });
          return;
        }
        const nn = w.normal(nx, ny, nz, { x: 0, y: 1, z: 0 }), vn = q.vel.x * nn.x + q.vel.y * nn.y + q.vel.z * nn.z;
        if (vn < 0) {
          const rest = pd.rest != null ? pd.rest : 0.4, fric = pd.fric != null ? pd.fric : 0.9;
          if (vn < -2) sim().emit(S, EV.BOUNCE, { x: nx, y: ny, z: nz, speed: -vn, mat: w.mat_at(nx, ny, nz) });
          q.vel.x = (q.vel.x - (1 + rest) * vn * nn.x) * fric;
          q.vel.y = (q.vel.y - (1 + rest) * vn * nn.y) * fric;
          q.vel.z = (q.vel.z - (1 + rest) * vn * nn.z) * fric;
          q.bounces++;
          if (M.len3(q.vel.x, q.vel.y, q.vel.z) < 0.8) { q.vel.x = q.vel.y = q.vel.z = 0; }
        }
        continue;
      }
      q.pos.x = nx; q.pos.y = ny; q.pos.z = nz;
    }
    if (q.fuse <= 0 && !imp) burst3(S, q, q.pos);
    else if (q.fuse <= -1) burst3(S, q, q.pos);
  }

  /* ---------- a blast inside the dome ---------- */
  FF.contain_pre = function (S, c, Wkg, wp) {
    // (P38 R1: a bullet crater (shotgun 0.012, sniper 0.004) is no contained blast: it kicked every worm in the dome)
    if (!S.ffields.length || wp.noContain || Wkg < 0.05) return null;
    const KF = K.FIELD;
    for (const f of S.ffields) {
      if (f.state !== 0 || M.v3_dist(c, centre(f)) >= f.R - 0.15) continue;
      f.charge = M.min(KF.CAP, f.charge + Wkg * (1 - KF.LEAK));
      S.ffCtx = f.id;
      return { f, W: Wkg * KF.LEAK };
    }
    return null;
  };
  FF.contain_post = function (S, c, Wkg, wp, ctx) {
    const KF = K.FIELD, f = ctx.f, cc = centre(f);
    S.ffCtx = 0;
    const dmgBase = wp.dmg != null ? wp.dmg : 50 * M.pow(Wkg, 0.28);
    // everything inside takes the contained wave: damage on top of the leak, flung about the dome
    for (const o of S.worms) {
      if (o.dead || M.v3_dist(o.pos, cc) >= f.R) continue;
      // (P38 R3: the field shelters its owner's team (no extra wave for them) and a spent field (its charge used) adds
      // only 0.5x, not CONTAIN_K: a spent dome was a 2.5x damage zone for whoever stood in it: bazooka 50 -> 123,
      // airstrike 59 -> 230)
      const d = M.v3_dist(o.pos, c),
        fk = 1 - 0.55 * M.min(1, d / f.R),
        kk = o.team === f.team ? 0 : f.charges > 0 ? KF.CONTAIN_K : 0.5,
        extra = Math.round(dmgBase * kk * fk);
      if (extra >= 1) {
        const l = d || 1;
        S.hitDir = { x: (o.pos.x - c.x) / l, y: (o.pos.y - c.y) / l + 0.3, z: (o.pos.z - c.z) / l };
        sim().hurt(S, o, extra, C.DS.BLAST_CONTAINED);
      }
      const l = d || 1, dv = (3 + 8 * (1 - M.min(1, d / f.R))) * M.min(1.5, Wkg + 0.3);
      WPN().shove(S, o, (o.pos.x - c.x) / l * dv, 4 + dv * 0.5, (o.pos.z - c.z) / l * dv);
    }
    sim().emit(S, EV.FFCONTAIN, { fid: f.id, x: c.x, y: c.y, z: c.z, W: Wkg });
    sim().emit(S, EV.FFRIPPLE, { fid: f.id, x: c.x, y: c.y, z: c.z, amp: 2 });
    // the generator takes the full charge
    const R = 2.83 * M.cbrt(Wkg), fk = SS.blast.poc_factor(M.v3_dist(f.pos, c), R), dP = dmgBase;
    if (fk > 0) f.hp -= dP * fk;
    if (f.hp <= 0) drop(S, f, true);
  };
  // blasts outside (WP.blast): hurt the generator; a contained blast is handled by contain_post
  FF.blast = function (S, c, Wkg, dmg) {
    if (!S.ffields.length) return;
    const R = 2.83 * M.cbrt(Wkg), dP = dmg != null ? dmg : 50 * M.pow(Wkg, 0.28);
    for (const f of S.ffields.slice()) {
      if (f.state !== 0 || f.id === S.ffCtx) continue;
      const k = SS.blast.poc_factor(M.v3_dist(f.pos, c), R);
      if (k > 0) f.hp -= dP * k;
      if (f.hp <= 0) drop(S, f, true);
    }
  };
  function drop(S, f, release) {
    if (f.state !== 0) return;
    f.state = 1;
    sim().emit(S, EV.FFBREAK, { fid: f.id, x: f.pos.x, y: f.pos.y, z: f.pos.z, R: f.R, charge: f.charge });
    if (release && f.charge >= K.FIELD.MIN_REL && S.ffRel.length < 4) {
      S.ffRel.push({
        t: S.time + K.FIELD.REL_DELAY,
        x: f.pos.x,
        y: f.pos.y + 0.3,
        z: f.pos.z,
        W: M.min(K.FIELD.CAP, f.charge * K.FIELD.REL_K + 0.3),
        fid: f.id
      });
      sim().log(S, 'The force field collapses: the contained energy is released!', 0x9fe8ff);
    }
    f.charge = 0;
  }
  /* the stored energy goes off: a blast, and the ground + nearby rocks crack into big pieces */
  function crack(S, c, Wkg) {
    const KF = K.FIELD, w = W(), H = w.H, rg = S.ffRng;
    const Rc = 2.2 + 1.2 * M.cbrt(Wkg), blobs = KF.CRACK_BLOBS + M.min(4, Math.floor(Wkg));
    let made = 0;
    for (let b = 0; b < blobs; b++) {
      const th = rr(S, 0, 6.2832), el = rr(S, -1.3, 0.2), dx = M.cos(th) * M.cos(el), dy = M.sin(el), dz = M.sin(th) * M.cos(el);
      let hit = -1;
      for (let r = 0.4; r <= Rc + 1.2; r += 0.25)
        if (w.sample(c.x + dx * r, c.y + dy * r, c.z + dz * r) > 0) {
          hit = r;
          break;
        }
      if (hit < 0) continue;
      const R = KF.CRACK_R * rr(S, 0.85, 1.3),
        cx = c.x + dx * (hit + R * 0.5),
        cy = c.y + dy * (hit + R * 0.5),
        cz = c.z + dz * (hit + R * 0.5),
        comp = [];
      for (let kk = M.max(1, Math.floor((cz - R) / H)); kk <= M.min(w.NZ - 2, Math.ceil((cz + R) / H)); kk++)
        for (let jj = M.max(1, Math.floor((cy - R) / H)); jj <= M.min(w.NY - 2, Math.ceil((cy + R) / H)); jj++)
          for (let ii = M.max(1, Math.floor((cx - R) / H)); ii <= M.min(w.NX - 2, Math.ceil((cx + R) / H)); ii++) {
            const o = (kk * w.NY + jj) * w.NX + ii, ex = ii * H - cx, ey = jj * H - cy, ez = kk * H - cz;
            if (
              w.d[o] > 0
              && w.mat[o] !== MAT.LAVA
              && w.mat[o] !== MAT.STEEL
              && w.mat[o] !== MAT.BEDROCK
              && ex * ex + ey * ey + ez * ez < R * R
            ) comp.push(o);
          }
      if (comp.length < 22 || !SS.collapse || !SS.bodies) continue;
      const r = SS.collapse.detach(w, comp, rg);
      for (const pc of r.pieces) {
        const body = SS.bodies.from_piece(S, pc);
        made++;
        const ex = body.pos.x - c.x,
          ey = body.pos.y - c.y,
          ez = body.pos.z - c.z,
          l = M.nz(M.len3(ex, ey, ez), 1),
          v = KF.CRACK_V * rr(S, 0.7, 1.2);
        body.vel.x += ex / l * v; body.vel.y += ey / l * v + 3; body.vel.z += ez / l * v;
        body.w.x += rr(S, -3, 3); body.w.y += rr(S, -3, 3); body.w.z += rr(S, -3, 3);
      }
      if (r.rubble && r.rubble.length) sim().emit(S, EV.RUBBLE, { pts: r.rubble.slice(0, 24) });
      WPN().edited(S, cx, cy, cz, R + 0.5);
    }
    // nearby rocks split into big pieces
    let rocks = 0;
    for (const b of S.bodies.slice()) {
      if (rocks >= 6 || !(b.prop === 'boulder' || b.kind === 'chunk')) continue;
      const d = M.v3_dist(b.pos, c);
      if (d > KF.ROCK_R + b.rb) continue;
      const r0 = M.max(0.25, b.rb * 0.62), n = 3;
      SS.bodies.remove(S, b); rocks++;
      for (let k = 0; k < n; k++) {
        const a = rr(S, 0, 6.2832),
          off = b.rb * 0.4,
          pos = { x: b.pos.x + M.cos(a) * off, y: b.pos.y + rr(S, 0, 0.3), z: b.pos.z + M.sin(a) * off };
        const piece = SS.bodies.add_ball(S, pos, r0 * rr(S, 0.8, 1.1), M.max(30, b.mass / n), MAT.ROCK);
        const ex = pos.x - c.x, ez = pos.z - c.z, l = M.nz(M.len2(ex, ez), 1), v = rr(S, 4, 8);
        piece.vel.x = ex / l * v + M.cos(a) * 2; piece.vel.y = rr(S, 3, 7); piece.vel.z = ez / l * v + M.sin(a) * 2;
      }
    }
    sim().emit(S, EV.FFCRACK, { x: c.x, y: c.y, z: c.z, R: Rc, pieces: made, rocks });
  }

  /* ---------- per step / turn ---------- */
  FF.step = function (S, dt) {
    for (const f of S.ffields) {
      if (f.state === 0) {
        // the generator sits on the ground (falls when it is undermined)
        // P68g: along the field
        if (S.eow) {
          if (!SS.eow.dev_fall(S, f, dt)) f.hp = 0;
        }
        else if (W().sample(f.pos.x, f.pos.y - 0.07, f.pos.z) <= 0) {
          f.vy -= C.G * dt;
          f.pos.y += f.vy * dt;
          if (f.pos.y < 0.3) f.hp = 0;
        }
        else f.vy = 0;
        if (f.hp <= 0) drop(S, f, true);
        // shorts out in the water
        else if (f.pos.y < sim().surface_at(S, f.pos.x, f.pos.z) - 0.1) {
          f.hp = 0;
          drop(S, f, false);
          sim().emit(S, EV.STEAM, { x: f.pos.x, y: f.pos.y, z: f.pos.z, power: 0.5 });
        }
      }
    }
    for (let i = S.ffields.length - 1; i >= 0; i--) {
      const f = S.ffields[i];
      if (f.state === 1 && S.time - (f.downT == null ? (f.downT = S.time) : f.downT) > 1.5) S.ffields.splice(i, 1);
    }
    if (S.free3d.length) {
      for (const q of S.free3d.slice())
        if (S.free3d.indexOf(q) >= 0) stepFree(S, q, dt);
      if (S.free3d.length) S.forceInspect = M.max(S.forceInspect, S.time + 1.2);
    }
    for (let i = S.ffRel.length - 1; i >= 0; i--) {
      const r = S.ffRel[i];
      if (S.time < r.t) continue;
      S.ffRel.splice(i, 1);
      sim().emit(S, EV.FFRELEASE, { x: r.x, y: r.y, z: r.z, W: r.W });
      sim().explode(S, { x: r.x, y: r.y, z: r.z }, { W: r.W, dmg: 55, name: 'the force field energy', noContain: 1 }, null);
      crack(S, { x: r.x, y: r.y, z: r.z }, r.W);
      S.lastBoom = S.time;
    }
  };
  FF.busy = S => S.free3d.length > 0 || S.ffRel.length > 0;
  FF.turn_start = function (S) {
    for (let i = S.ffields.length - 1; i >= 0; i--) {
      const f = S.ffields[i];
      if (f.state === 0 && --f.turns <= 0) {
        sim().emit(S, EV.FFBREAK, { fid: f.id, x: f.pos.x, y: f.pos.y, z: f.pos.z, R: f.R, charge: 0, expired: 1 });
        S.ffields.splice(i, 1);
      }
    }
  };
  FF.hash = function (S, mix) {
    for (const f of S.ffields) {
      mix(f.pos.y);
      mix(f.hp);
      mix(f.charge);
      mix(f.state);
    }
    for (const q of S.free3d) {
      mix(q.pos.x);
      mix(q.pos.y);
      mix(q.pos.z);
    }
    mix(S.ffRng ? S.ffRng.s : 0);
  };
  FF.stats = S => ({ fields: S.ffields.length, free3d: S.free3d.length, rel: S.ffRel.length });
})(window.SS = window.SS || {});
