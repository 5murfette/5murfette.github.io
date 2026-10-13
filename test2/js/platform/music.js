/* platform/music.js — music player (P42b): per-biome loops with an intensity layer, menu music, stingers, ducking.
 * Files: assets/music/manifest.js (SS.MUSIC_FILES[cue] = [alternative formats]); a missing cue is silence, never an
 * error. Playback is plain HTMLAudio (a MediaElementAudioSourceNode of a file:// page is cross-origin and plays silence
 * in Chrome, decodeAudioData needs fetch, which file:// forbids). Loops do not use el.loop (it leaves a gap in some
 * browsers and AAC has encoder padding): a track is played as overlapping generations, the next one starts OV seconds
 * before the end of the current one and the two are crossfaded with equal power. Cue changes are equal-power crossfades
 * of whole decks. A deck holds 1..2 layers (base, intense) that play in sync; the intensity 0..1 crossfades them.
 * The pure functions (MU.eq_in, approach, pick_file, cue_for, intensity_for, bank_id, jitter, ...) have no DOM access
 * and are tested by tools/dev/gen/musictest.cjs. Presentation only: Math.random is fine, nothing here touches js/sim.
 * API: tick(S, hold) every frame (S = match state or null in the menus), duck(g), stinger(id), set_volume(v), volume,
 * audition(id, intensity), state(). Dev: ?music=<cue id> forces a cue, &mi=0..1 its intensity. */
(function (SS) {
  'use strict';
  const MU = SS.music = {};
  const HALF_PI = Math.PI / 2, clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const XFADE = 2.5, OVERLAP = 2.0, KEY = 'burrowBrawl3d.musicVol', DIR = 'assets/music/';
  const BIOMES = ['temperate', 'alpine', 'canyon', 'desert', 'volcanic', 'eow'];
  MU.BIOMES = BIOMES;
  // cues that have an intense stem in sync with the base (P83b: the other bases are single-layer ambient loops)
  MU.INTENSE = { volcanic: true };
  /* P83b: per-cue mix trim of the ambient bases (-6 dB: file -20 LUFS -> about -26 LUFS, a bed under the SFX at -17 /
   * -18 LUFS;
   * the menu, volcanic, sudden death, tension and stingers keep the old level) */
  MU.AMBIENT_TRIM = 0.5;
  MU.trim_of = cue => (/^mus_(temperate|alpine|canyon|desert|caves|eow)_base$/.test(cue || '') ? MU.AMBIENT_TRIM : 1);
  MU.TENSION_S = 5;

  /* ---------- pure logic ---------- */
  MU.eq_in = x => Math.sin(clamp(x, 0, 1) * HALF_PI);
  MU.eq_out = x => Math.cos(clamp(x, 0, 1) * HALF_PI);
  // one-pole approach with separate time constants for rising and falling toward the target (tau <= 0: jump)
  MU.approach = function (cur, target, dt, tau_up, tau_down) {
    const tau = target > cur ? tau_up : tau_down;
    if (tau <= 0 || dt <= 0) return tau <= 0 ? target : cur;
    return cur + (target - cur) * (1 - Math.exp(-dt / tau));
  };
  // linear step toward a target (the deck presence 0..1: XFADE seconds for a full fade)
  MU.step_to = (cur, target, dt, secs) => (cur < target ? Math.min(target, cur + dt / secs) : Math.max(target, cur - dt / secs));
  // gains of [base, intense] for an intensity 0..1 (equal power: the sum of squares stays 1)
  MU.layer_gains = i => [MU.eq_out(i), MU.eq_in(i)];
  // the first file of an alternative-format list that the browser can play; can(file) -> bool
  MU.pick_file = function (list, can) {
    if (!list) return null;
    for (let i = 0; i < list.length; i++)
      if (can(list[i])) return list[i];
    return null;
  };
  MU.mime_of = function (f) {
    const e = /\.([a-z0-9]+)$/i.exec(f);
    const x = e ? e[1].toLowerCase() : '';
    return x === 'ogg' || x === 'oga'
      ? 'audio/ogg; codecs="vorbis"'
      : x === 'opus'
      ? 'audio/ogg; codecs="opus"'
      : x === 'm4a' || x === 'mp4' || x === 'aac'
      ? 'audio/mp4; codecs="mp4a.40.2"'
      : x === 'mp3'
      ? 'audio/mpeg'
      : x === 'wav'
      ? 'audio/wav'
      : x === 'webm'
      ? 'audio/webm'
      : '';
  };
  /* what should play: st = { match, biome, phase, sudden, turn_left (s, <= 0: no limit or not in the turn), proj, over
   * }.
   * -> { base, intense, tension (bool) } with cue ids (null = nothing, e.g. at the end of a match: the stinger takes
   * over). */
  MU.cue_for = function (st) {
    if (!st || !st.match) return { base: 'mus_menu', intense: null, tension: false };
    if (st.over) return { base: null, intense: null, tension: false };
    const tension = st.turn_left > 0 && st.turn_left <= MU.TENSION_S;
    if (st.sudden) return { base: 'mus_suddendeath', intense: 'mus_suddendeath_intense', tension };
    let b = BIOMES.indexOf(st.biome) >= 0 ? st.biome : 'temperate';
    if (st.under && b !== 'eow') b = 'caves';                          // P83b: a cave system has its own ambient loop
    return { base: 'mus_' + b + '_base', intense: MU.INTENSE[b] ? 'mus_' + b + '_intense' : null, tension };
  };
  // the wanted intensity 0..1: calm 0, a projectile in flight 0.85, the last seconds of a turn 0.7, sudden death at
  // least 0.55
  MU.intensity_for = function (st) {
    if (!st || !st.match || st.over) return 0;
    let v = 0;
    if (st.proj > 0) v = 0.85;
    if (st.turn_left > 0 && st.turn_left <= MU.TENSION_S) v = Math.max(v, 0.7);
    if (st.sudden) v = Math.max(v, 0.55);
    return v;
  };
  // the stinger at the end of a match: a human team won -> victory, anything else -> defeat
  MU.stinger_for = (human_won) => (human_won ? 'mus_victory' : 'mus_defeat');
  // an explosion's duck: gain to duck to (about -6 dB for a big one, -3 dB for a medium one)
  MU.duck_gain = R => (R > 60 ? 0.5 : R > 30 ? 0.7 : 1);
  /* worm voice banks: the id with the team's bank first ('worm_hurt_small@t1' ... '@t4'), else the shared id at pitch
   * 1.0.
   * has(id) -> bool. -> the id to play. */
  MU.bank_id = function (has, id, team) {
    const t = id + '@t' + (((team | 0) % 4 + 4) % 4 + 1);
    return has(t) ? t : id;
  };
  // random speed factor: r01 in [0, 1), frac = the detune (voices 0.02, one-shots 0.04)
  MU.jitter = (r01, frac) => 1 + (r01 * 2 - 1) * frac;
  MU.JIT_VOICE = 0.02;
  MU.JIT_SHOT = 0.04;
  // loop scheduling: pos / dur of the playing generation -> { spawn, x }: spawn the next one from dur - ov, x =
  // progress of the overlap
  MU.loop_phase = function (pos, dur, ov) {
    if (!(dur > 0)) return { spawn: false, x: 0 };
    const o = Math.min(ov, dur * 0.25);
    return { spawn: pos >= dur - o, x: clamp((pos - (dur - o)) / o, 0, 1) };
  };

  /* ---------- state ---------- */
  let vol = 0.6, gesture = false, last = 0, intensity = 0, duck = 1, hold_g = 1, sting_until = 0, sting_el = null;
  let decks = [], was_over = false, forced = null, forced_i = -1, failed = {};
  try {
    const v = localStorage.getItem(KEY);
    if (v != null && v !== '') vol = clamp(parseFloat(v) || 0, 0, 1);
  } catch (e) { /* private mode */ }
  try {
    const q = new URLSearchParams(location.search);
    if (q.has('music')) forced = q.get('music');
    if (q.has('mi')) forced_i = clamp(parseFloat(q.get('mi')) || 0, 0, 1);
  } catch (e) { /* no location */ }
  Object.defineProperty(MU, 'volume', { get: () => vol });
  MU.set_volume = function (v) {
    vol = clamp(+v || 0, 0, 1);
    try {
      localStorage.setItem(KEY, String(vol));
    } catch (e) { /* */ }
  };
  const gestured = () => (SS.amedia ? SS.amedia.gestured : gesture);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  function can_play(f) {
    const m = MU.mime_of(f);
    if (!m) return false;
    try {
      const a = can_play.a || (can_play.a = new Audio());
      const r = a.canPlayType(m);
      return r === 'probably' || r === 'maybe';
    } catch (e) {
      return false;
    }
  }
  const files_of = id => (
    id && SS.MUSIC_FILES && SS.MUSIC_FILES[id] && SS.MUSIC_FILES[id].length ? MU.pick_file(SS.MUSIC_FILES[id], can_play) : null
  );
  MU.has = id => !!files_of(id);

  /* ---------- decks and generations ---------- */
  /* P54: elements come from the gesture-unlocked pool (platform/amedia.js); a bare `new Audio()` outside a gesture is
   * refused by Safari.
   * -> an element or null (not unlocked yet / pool empty: the caller retries on the next frame) */
  function new_el(file, deck) {
    const AM = SS.amedia,
      on_err = () => {
        failed[file] = true;
        deck.dead = true;
      };
    // (keep: a layer outlives the pool's 60 s reclaim and its own 'ended'; free_el releases it)
    if (AM) return AM.acquire(DIR + file, { onerror: on_err, keep: true });
    const el = new Audio(DIR + file);
    el.preload = 'auto';
    el.volume = 0;
    el.addEventListener('error', on_err);
    return el;
  }
  function free_el(el) {
    if (SS.amedia) SS.amedia.release(el);
    else {
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch (e) { /* */ }
    }
  }
  function new_gen(deck, x0) {
    const g = { els: [], x: x0, spawned: false };
    for (let i = 0; i < deck.files.length; i++) {
      const el = new_el(deck.files[i], deck);
      if (!el) {
        for (const o of g.els) free_el(o);
        return null;
      }
      g.els.push(el);
    }
    deck.gens.push(g); return g;
  }
  function kill_gen(g) {
    for (const el of g.els) free_el(el);
  }
  function make_deck(slot, cue, ids) {
    const files = [];
    for (const id of ids) {
      const f = id ? files_of(id) : null;
      if (f && !failed[f]) files.push(f);
      else if (files.length) break;
    }
    if (!files.length) return null;
    const d = { slot, cue, files, gens: [], x: 0, want: 1, dead: false };
    decks.push(d); return d;
  }
  function kill_deck(d) {
    for (const g of d.gens) kill_gen(g);
    d.gens.length = 0;
  }
  function play_el(el) {
    if (!gestured() || !el.paused) return;
    if (SS.amedia) {
      SS.amedia.play(el);
      return;
    }
    const p = el.play();
    if (p && p.catch) p.catch(() => { /* not allowed yet: retried */ });
  }
  function update_deck(d, dt, master) {
    d.x = MU.step_to(d.x, d.want, dt, XFADE);
    if (d.dead) {
      d.want = 0;
      d.x = 0;
      return;
    }
    if (!d.gens.length && d.want > 0 && gestured()) new_gen(d, 1);
    const n = d.gens.length, lg = MU.layer_gains(d.files.length > 1 ? intensity : 0), dg = MU.eq_in(d.x) * master * MU.trim_of(d.cue);
    for (let k = 0; k < n; k++) {
      const g = d.gens[k], nxt = k + 1 < n ? d.gens[k + 1] : null, e0 = g.els[0];
      for (const el of g.els) play_el(el);
      if (!nxt && !g.spawned) {
        const ph = MU.loop_phase(e0.currentTime, e0.duration, OVERLAP);
        if (ph.spawn && d.want > 0) {
          if (new_gen(d, 0)) g.spawned = true;
        }
      }
      if (nxt) nxt.x = clamp(nxt.els[0].currentTime / Math.min(OVERLAP, (e0.duration || OVERLAP * 4) * 0.25), 0, 1);
      const gg = (k === 0 && n === 1 ? 1 : MU.eq_in(g.x)) * (nxt ? MU.eq_out(nxt.x) : 1);
      for (let i = 0; i < g.els.length; i++) g.els[i].volume = clamp(dg * gg * (g.els.length > 1 ? lg[i] : 1), 0, 1);
    }
    while (d.gens.length > 1 && d.gens[1].x >= 1) {
      kill_gen(d.gens[0]);
      d.gens.shift();
    }
  }

  /* ---------- per-frame driver ---------- */
  function human_won(S) {
    const w = S.over;
    if (!(w >= 0) || !SS.game || !SS.game.is_cpu) return false;
    return !SS.game.is_cpu(S, w);
  }
  function state_of(S) {
    if (!S) return { match: false };
    const tl = S.settings && S.settings.turnTime > 0 && S.phase === 'play' ? S.turnT : 0;
    return {
      match: true,
      biome: S.biome,
      under: !!(SS.world && SS.world.under),
      phase: S.phase,
      sudden: !!S.sudden,
      turn_left: tl,
      proj: S.proj ? S.proj.length : 0,
      over: S.phase === 'over'
    };
  }
  function ensure_cue(cue) {
    let cur = null;
    for (const d of decks)
      if (d.slot === 'main' && d.want > 0) cur = d;
    const base = cue.base;
    if (cur && cur.cue === base) return;
    if (cur) cur.want = 0;
    if (!base) return;
    for (const d of decks)
      if (d.slot === 'main' && d.cue === base && !d.dead) {
        d.want = 1;
        return;
      }
    make_deck('main', base, [base, cue.intense]);
  }
  function ensure_tension(on) {
    let t = null;
    for (const d of decks)
      if (d.slot === 'tension') t = d;
    if (t) {
      if (t.want !== (on ? 1 : 0)) t.want = on ? 1 : 0;
      if (t.want > 0 || t.x > 0) return;
    }
    if (on && !t) make_deck('tension', 'mus_tension', ['mus_tension']);
  }
  MU.duck = function (g) {
    if (g < duck) duck = Math.max(0.05, g);
  };
  MU.stinger = function (id) {
    const f = files_of(id);
    if (!f || failed[f]) return false;
    try {
      if (sting_el) free_el(sting_el);
      const el = new_el(f, { dead: false });
      if (!el) return false;
      sting_el = el;
      el.volume = clamp(vol * 0.9, 0, 1);
      const done = () => {
        sting_until = now() + 0.8;
        if (sting_el === el) {
          sting_el = null;
          free_el(el);
        }
      };
      if (el._slot) el._slot.onended = done;
      else el.addEventListener('ended', done);
      play_el(el);
    } catch (e) {
      return false;
    }
    return true;
  };
  MU.audition = function (id, inten) {
    if (id === 'mus_victory' || id === 'mus_defeat') {
      MU.stinger(id);
      return;
    }
    forced = id || null; forced_i = inten == null ? -1 : clamp(inten, 0, 1);
  };
  MU.tick = function (S, hold) {
    const t = now(), dt = last ? Math.min(0.25, t - last) : 0;
    last = t;
    const st = state_of(S);
    let cue = MU.cue_for(st), want_i = MU.intensity_for(st);
    if (forced) {
      cue = { base: forced, intense: forced.replace(/_base$/, '_intense'), tension: false };
      if (cue.intense === forced) cue.intense = forced + '_intense';
      want_i = forced_i >= 0 ? forced_i : 0;
    } else if (st.match && st.over && !was_over) MU.stinger(MU.stinger_for(human_won(S)));
    was_over = st.match && st.over;
    ensure_cue(cue); ensure_tension(!!cue.tension && cue.base !== null);
    intensity = MU.approach(intensity, want_i, dt, 0.4, 2.5);
    duck = MU.approach(duck, 1, dt, 0.4, 0);
    if (sting_el && sting_el._slot && !sting_el._slot.busy) sting_el = null;
    const stung = (sting_el && !sting_el.paused && !sting_el.ended) || sting_until > t;
    const hold_t = hold === 'pause' ? 0.3 : hold === 'menu' ? 0.6 : 1;
    hold_g = MU.approach(hold_g, hold_t, dt, 1.0, 0.5);
    const muted = SS.audio && SS.audio.muted;
    const master = muted ? 0 : vol * 0.8 * duck * hold_g * (stung ? 0.25 : 1);
    for (const d of decks) update_deck(d, dt, master);
    for (let i = decks.length - 1; i >= 0; i--)
      if (decks[i].want === 0 && decks[i].x === 0) {
        kill_deck(decks[i]);
        decks.splice(i, 1);
      }
    if (sting_el) sting_el.volume = clamp(muted ? 0 : vol * 0.9, 0, 1);
  };
  MU.state = () => ({
    intensity,
    duck,
    hold: hold_g,
    vol,
    decks: decks.map(d => ({
      slot: d.slot,
      cue: d.cue,
      x: d.x,
      want: d.want,
      gens: d.gens.length,
      files: d.files.slice(),
      paused: d.gens.length ? d.gens[0].els[0].paused : true,
      vols: d.gens.map(g => g.els.map(e => e.volume))
    }))
  });
  // the browser lets media start only after a gesture (iOS: inside touchend / click)
  if (typeof addEventListener === 'function')
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) addEventListener(ev, () => { gesture = true; }, { capture: true });
})(typeof window !== 'undefined' ? (window.SS = window.SS || {}) : (globalThis.SS = globalThis.SS || {}));
