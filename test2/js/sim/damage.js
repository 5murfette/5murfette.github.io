/* sim/damage.js — hurting and killing worms: hurt (an HP loss with its cause and flags, its log line, whether the hit
 * ends the turn), burn, kill / kill_now, a worm lost off the map, and the texts of a cause (src_text, cause_gibs, the
 * body and weapon name ids).
 * API: hurt, burn, kill, kill_now, lost, hit_ends_turn, src_text, cause_gibs, body_name_id, weapon_name_id; the tables
 * CAUSE, CAUSE_NAME, BODY_NAMES.
 * Determinism: no RNG. */
(function (SS) {
  'use strict';
  const DM = SS.damage;
  const C = SS.CFG;
  const PHASE = C.PHASE;
  const EV = C.EV;
  const M = SS.math;
  const P = SS.plane;
  const sim = SS.sim;
  const TN = SS.turn;

  /* ---------- damage ---------- */
  /* event 'hurt' { worm, amount, src, arg, dir, dot }: src = DamageSrc (C.DS, config.js: the table gives the cause /
   * turn rule / text), arg = i16 name
   * index for the `a % hit` / `a flying %` rows (-1 none); dot = damage over time (drowning, lava, fire, gas ...):
   * presentation only (blood, flash, shouts); the camera director never follows it (P37-3), a discrete hit (blast,
   * shot, landing) it does */
  // a discrete hit on the active worm ends its turn (play) / its retreat (attack); P38 R1: also called by the shrapnel
  // pass (its hurt is quiet)
  /* P38 R3: the cause of a death. hurt() stores the code of the last damage in w.cause (int); kill() logs / animates by
   * it (C.CAUSE, config.js).
   * Blood on: only BLAST / SHOT / CRUSH / SHRED burst into gibs; the rest collapse by cause. Blood off: the dying
   * beat's small blast (PoC) only for the gib causes, the rest collapse quietly (cause FX in render/react.js). */
  const CAUSE = C.CAUSE, CAUSE_NAME = C.CAUSE_NAME, CAUSE_LOG = C.CAUSE_LOG, DS = C.DS, DSF = C.DSF, HF = C.HF;
  DM.CAUSE = CAUSE; DM.CAUSE_NAME = CAUSE_NAME;
  DM.cause_gibs = function (c) { return c === CAUSE.BLAST || c === CAUSE.SHOT || c === CAUSE.CRUSH || c === CAUSE.SHRED; };
  /* names for the `%` of a row: a projectile / weapon (index in C.WEAPON_KEYS) or a body (BODY_NAMES: prop tag or body
   * kind) */
  const BODY_NAMES = [
    'barrel', 'mine', 'crate', 'girder', 'boulder', 'car', 'fridge', 'vending', 'phonebooth', 'column', 'obelisk', 'log', 'moai', 'struct',
    'box', 'ball'
  ];
  DM.BODY_NAMES = BODY_NAMES;
  DM.body_name_id = b => BODY_NAMES.indexOf(b.prop || b.kind);
  DM.weapon_name_id = key => (C.WEAPON_KEYS ? C.WEAPON_KEYS.indexOf(key) : -1);
  /* the log / presentation text of a damage source (never read by the sim itself) */
  DM.src_text = function (src, arg) {
    const t = C.DS_TEXT[src | 0] || C.DS_TEXT[0], i = t.indexOf('%');
    if (i < 0) return t;
    let nm = 'object';
    if (src === DS.FLY_PROP) nm = arg >= 0 && arg < BODY_NAMES.length ? BODY_NAMES[arg] : 'object';
    else {
      const k = arg >= 0 && C.WEAPON_KEYS ? C.WEAPON_KEYS[arg] : null, d = k ? C.WEAPONS[k] : null;
      nm = d && d.name ? d.name.toLowerCase() : 'shell';
    }
    return t.slice(0, i) + nm + t.slice(i + 1);
  };
  DM.hit_ends_turn = function (S, w) {
    if (w !== S.active || w.dead) return;
    if (S.phase === PHASE.PLAY) {
      S.charging = false;
      S.power = 0;
      S.phase = PHASE.ATTACK;
      S.attackStart = S.time;
      S.lastBoom = S.time;
      TN.end_retreat(S);
      sim.log(S, `${w.name} got hurt: the turn ends.`, 0xffb27a);
    }
    else if (S.phase === PHASE.ATTACK && S.retreatT > 0) TN.end_retreat(S);
  };
  function hurt(S, w, dmg, src, flags, arg) {
    // (S.hitDir is set by the caller for this hit only)
    if (w.dead || dmg <= 0) {
      S.hitDir = null;
      return;
    }
    flags = flags | 0; src = src | 0; arg = arg === undefined ? -1 : arg;
    const sf = C.DS_FLAGS[src], quiet = (flags & HF.QUIET) !== 0, dot = (flags & HF.DOT) !== 0 || (sf & DSF.DOT) !== 0;
    // P37 W4: the tinfoil hat grounds lightning
    if (S.lightning && w.skills && w.skills.tinfoil) dmg = M.max(1, Math.round(dmg * ((C.SKILL && C.SKILL.TINFOIL_K) || 0.1)));
    w.hp -= dmg; w.cause = C.DS_CAUSE[src];
    // dir: where the hit pushed (blood sprays that way)
    sim.emit(S, EV.HURT, { wormId: w.id, amount: dmg, src, arg, dir: S.hitDir || null, dot });
    w.hitDir = S.hitDir || null; S.hitDir = null;
    // P84: a shotgun pellet / a hit over 30 HP tears a face hugger off
    if (w.hug != null && w.hug >= 0 && SS.alien) SS.alien.on_hit(S, w, dmg, src);
    // P1 (PoC activeHurt): a hit on the active worm ends its turn / its retreat; so does FIRE (user 2026-10-08, PoC:
    // napalm, burning oil / grass / props); the poc5-only steady hazards (lava, hot sand, the black hole's core) do not
    // (P38 R3: a sentry gun hit does not end the turn in play: turn denial)
    if (w === S.active && !quiet && (!dot || (sf & DSF.FIRE) !== 0) && !w.dead && !(S.phase === PHASE.PLAY && (sf & DSF.NOEND_PLAY) !== 0))
      DM.hit_ends_turn(S, w);
    const t = P.to_plane(S, w.pos).t;
    if (quiet) { /* steady hazards (hot sand) log once on entry, not per point */ }
    else if (Math.abs(t) > C.HALF) sim.log(S, `${w.name} took ${dmg} off-section (${Math.abs(t).toFixed(1)} m from the plane).`, 0xff9a9a);
    else sim.log(S, `${w.name} took ${dmg} from ${DM.src_text(src, arg)}.`);
    // PoC death model: with blood on the worm bursts at once (its grave goes off in the dying beat); else it stays,
    // at 0 HP, until the aftermath settles, then dies in its own beat with a small blast (sim.step 'dying')
    if (w.hp <= 0) {
      w.hp = 0;
      if (S.settings.blood && DM.cause_gibs(w.cause)) {
        kill(S, w, 'gib');
        w.gravePending = true;
      }
      // P38 R3: burn / lava / poison / fall / shock ... collapse by cause: no gib, no grave blast
      else if (S.settings.blood) kill(S, w, CAUSE_NAME[w.cause] || 'beat');
      else if (!w.dying) {
        w.dying = true;
        if (w === S.active && S.phase === PHASE.PLAY) {
          S.charging = false;
          S.phase = PHASE.ATTACK;
          S.attackStart = S.time;
          S.lastBoom = S.time;
          TN.end_retreat(S);
        }
      }
      if (S.phase === PHASE.PLACE) SS.game.flush_dying && SS.game.flush_dying(S);
    }
  }
  DM.hurt = hurt;
  /* continuous damage (fire, lava): accumulate, apply in whole points at most twice per second */
  DM.burn = function (S, w, dps, dt, src, flags) {
    if (w.dead) return;
    flags = flags | 0;
    if (!(flags & HF.QUIET)) w.burnT = S.time;                      // presentation: flames on the worm while this keeps happening
    w.dmgAcc += dps * dt;
    if (w.dmgAcc >= 1 && S.time - w.dmgT > 0.5) {
      const n = Math.floor(w.dmgAcc);
      w.dmgAcc -= n;
      w.dmgT = S.time;
      hurt(S, w, n, src, flags | HF.DOT);
    }
  };
  DM.kill = (S, w, how) => kill(S, w, how);                      // P68c (eow.js: lost in the void)
  DM.kill_now = (S, w, how) => {
    if (!w.dead) {
      kill(S, w, how);
      if (S.settings.blood) sim.emit(S, EV.GIB, { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z });
    }
  };
  function kill(S, w, how) {
    // the grave: its BASE (ground contact) under the worm; it falls / settles in stepGraves (user 2026-10-08: graves
    // floated where a worm died in the air or once the ground under them was blown away)
    if (SS.alien && SS.alien.burst) SS.alien.burst(S, w);          // P37: an embryo bursts out of the host
    // (P47: a worm the alien ate leaves no tombstone)
    w.dead = true;
    w.hp = 0;
    w.dying = false;
    w.grave = w.eaten ? null : { x: w.pos.x, y: w.pos.y - (w.foot || 0.5), z: w.pos.z, vy: 0, rest: false, landT: -1 };
    if (how === 'drown') w.cause = CAUSE.DROWN;
    else if (how === 'crush') w.cause = CAUSE.CRUSH;
    sim.emit(S, EV.KILL, { wormId: w.id, how: how || '', cause: w.cause | 0 });
    // PoC slow motion: a kill by a big blast (R >= 30 px = W >= 0.32 kg) slows the action for 0.9 s (presentation)
    if (S.lastBlastT === S.time && S.lastBlastW >= 0.32) S.slowUntil = S.time + 0.9;
    if (how === 'gib') sim.emit(S, EV.GIB, { wormId: w.id, x: w.pos.x, y: w.pos.y, z: w.pos.z, dir: w.hitDir || null });
    // (alien.js logs its own line)
    if (w.cause !== CAUSE.ALIEN) sim.log(S, `${w.name} ${CAUSE_LOG[w.cause | 0] || CAUSE_LOG[0]}`, 0xff9a9a);
    if (w === S.active && S.phase === PHASE.PLAY) {
      S.phase = PHASE.RESOLVE;
      S.resolveT = S.time;
    }
    if (w === S.active && S.retreatT > 0) TN.end_retreat(S);
  }
  function lost(S, w) {
    if (w.dead) return;
    sim.log(S, `${w.name} wandered off into the open desert.`, 0xffb27a); kill(S, w); w.grave = null;
  }
  DM.lost = lost;
})(window.SS = window.SS || {});
