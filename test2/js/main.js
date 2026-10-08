/* main.js — browser entry: menu → textures → world generation → terrain meshes (with a progress bar),
 * then platform input → fixed-step sim → renderer/UI. Exposes deterministic test hooks on window.POC. */
(function (SS) {
  'use strict';
  const C = SS.CFG, $ = id => document.getElementById(id);
  const S = SS.sim.create();
  const inp = SS.sim.input_make();
  const params = new URLSearchParams(location.search);
  const AUTO_KEY = 'strataSlice.autostart';
  let paused = false, running = false, menuOpen = false, busy = false, tx = null, Q = null, R = null;
  const stats = { genMs: 0, meshMs: 0, texMs: 0 };
  const tick = () => new Promise(r => setTimeout(r, 0));

  /* P9: a left click on the canvas = a target on the section for target weapons (fires them) and homing (sets it) */
  function clickTarget() {
    const I = SS.input; if (!I.clicks.length) return null;
    const c = I.clicks.shift(); I.clicks.length = 0;
    if (S.phase === 'place') { const p = SS.view.pickPlane(S, c.x, c.y); return p ? { s: p.s, y: p.y, fire: true } : null; }   // P13: deploy
    const d = C.ARSENAL[S.weapon]; if (!d || !(d.kind === 'target' || d.target) || S.phase !== 'play') return null;
    const p = SS.view.pickPlane(S, c.x, c.y); if (!p) return null;
    return { s: p.s, y: p.y, fire: d.kind === 'target' };
  }
  /* P22a instant replay (user: "if more than 1 worm died"): when an attack starts (play -> attack) the deterministic
   * state is snapshot (sim.snapshot: S + the voxel world) and every step's input recorded; when the next turn begins
   * and >= 2 worms died since, the end state is kept aside, the start restored and the recorded steps re-run at half
   * speed under a REPLAY banner (Space / Enter / a click skips), then the end state comes back. Local games only (a
   * lockstep game would have to pause every peer). */
  const RP = { snap: null, inputs: null, dead0: 0, turn: -1, play: null };
  const deadCount = () => S.worms.reduce((n, w) => n + ((w.dead || w.hp <= 0) && !w.reserve ? 1 : 0), 0);   // (0 HP = the fatal moment; the dying beats come later)
  function replayStart() {
    const end = SS.sim.snapshot(S);
    SS.sim.restore(S, RP.snap); if (SS.view.clearActors) SS.view.clearActors(); if (SS.ui.clear) SS.ui.clear(); SS.view.snapCamera();
    // fast-forward (unseen) from the snapshot to the step that started the attack (or to 3 s before the second kill:
    // a long fuse is not worth watching twice), then play it back visibly
    if (RP.killAt > 0) RP.at = Math.max(RP.at, RP.killAt - 360);
    for (let i = 0; i < RP.at; i++) SS.sim.step(S, RP.inputs[i], C.STEP);
    S.events.length = 0;
    RP.play = { inputs: RP.killAt > 0 ? RP.inputs.slice(0, Math.min(RP.inputs.length, RP.killAt + 180)) : RP.inputs, i: RP.at, end };   // up to 1.5 s after the 2nd kill
    RP.snap = null; RP.inputs = null;
    S.events.push({ type: 'banner', title: 'Instant replay', sub: 'Space skips' });
  }
  function replayEnd() {
    SS.sim.restore(S, RP.play.end); RP.play = null; if (SS.view.clearActors) SS.view.clearActors(); if (SS.ui.clear) SS.ui.clear(); SS.view.snapCamera();
    S.events.length = 0;
  }
  function replayStep() {
    const I = SS.input, skip = I.pressed.has('Space') || I.pressed.has('Enter') || I.pressed.has('Escape') || I.clicks.length;
    I.clicks.length = 0; SS.input.end_step();
    const p = RP.play;
    if (skip || p.i >= p.inputs.length) { replayEnd(); return; }
    SS.sim.step(S, p.inputs[p.i++], C.STEP);
  }
  function step() {
    if (RP.play) { replayStep(); return; }
    SS.input.sample(inp, S, clickTarget());
    if (inp.reset) { inp.reset = 0; SS.input.end_step(); RP.snap = RP.inputs = null; if (!netGame) newGame(S.settings); return; }
    const phase0 = S.phase, turn0 = S.turnNo;
    // while the worm aims / walks: a fresh snapshot every 2 s of sim time (~5 ms each); the inputs since it are kept
    if (!netGame && phase0 === 'play' && (!RP.snap || (!RP.armed && (RP.turn !== turn0 || S.time - RP.snapT > 2)))) {
      RP.snap = SS.sim.snapshot(S); RP.snapT = S.time; RP.inputs = []; RP.dead0 = deadCount(); RP.turn = turn0; RP.armed = false; RP.at = 0;
    }
    SS.sim.step(S, inp, C.STEP);
    if (RP.snap) {
      RP.inputs.push(Object.assign({}, inp));
      if (!RP.armed && S.phase !== 'play' && S.turnNo === RP.turn) { RP.armed = true; RP.at = RP.inputs.length - 1; RP.killAt = -1; }   // the attack starts with this step
      if (RP.armed && RP.killAt < 0 && deadCount() - RP.dead0 >= 2) RP.killAt = RP.inputs.length;                 // the second fatal hit
      if (S.turnNo !== RP.turn || S.phase === 'over') {
        if (RP.armed && deadCount() - RP.dead0 >= 2 && RP.inputs.length < 120 * 60) { replayStart(); SS.input.end_step(); return; }
        RP.snap = RP.inputs = null;
      }
    }
    SS.input.end_step();
  }
  /* 9b lockstep (platform/net.js): the peer owning the active worm's team drives (steps at once, sends its input);
   * the other replays the inputs in order and waits for the next one. false = waiting. */
  let netGame = false, pendingAlign = 0, pendingStart = null;
  const inpR = SS.sim.input_make();
  function stepNet() {
    const NT = SS.net, k = S.netStep | 0;
    // P12: a seat that left becomes a CPU team at the step the host fixed (identical on every peer)
    for (const c of NT.ctl_due(k)) if (S.teams && S.teams[c.team]) { S.teams[c.team].ctl = 'cpu'; SS.sim.log(S, `${S.teams[c.team].name} left: the CPU plays their worms now.`, 0xffb080); }
    const drvTeam = S.active ? S.active.team : 0, mine = NT.drives(drvTeam) || (S.phase === 'over' && NT.isHost);
    let use;
    if (mine) {
      SS.input.sample(inp, S, clickTarget());
      if (inp.reset) { inp.reset = 0; SS.input.end_step(); if (NT.isHost && S.phase === 'over') newGame(S.settings); return false; }   // host: next map (sent to the guest)
    }
    if (NT.drives(drvTeam)) { if (pendingAlign) { inp.align_id = pendingAlign; pendingAlign = 0; } NT.queueInput(k, NT.pack(inp)); use = inp; }
    else { const a = NT.takeInput(k); if (!a) return false; SS.input.sample(inp, S, null); use = NT.unpack(a, inpR); }
    SS.sim.step(S, use, C.STEP); SS.input.end_step();
    use.align_id = 0;
    S.netStep = k + 1;
    if (NT.due(S.netStep)) NT.hash(S.netStep, SS.sim.hash(S));       // only every HASH_EVERY steps
    return true;
  }
  function frameRender(dt) {
    const I = SS.input;
    if (I.wheel) { SS.view.zoom(I.wheel); I.wheel = 0; }
    if (I.panX || I.panY) { SS.view.drag(I.panX, I.panY, S); I.panX = I.panY = 0; }
    // PoC edgeScroll: the mouse parked in the outer 10 % of the view scrolls the camera (not while dragging / firing)
    if (I.mouseIn && !I.held && !I.mfire && running && !menuOpen && !paused && !(S.inspect > 0.5)) {
      const ex = I.mx / innerWidth, ey = I.my / innerHeight, m = 0.1;
      const vx = ex < m ? -(m - ex) / m : ex > 1 - m ? (ex - 1 + m) / m : 0, vy = ey < m ? -(m - ey) / m : ey > 1 - m ? (ey - 1 + m) / m : 0;
      if (vx || vy) SS.view.drag(-vx * 1000 * dt, -vy * 1000 * dt, S);
    }
    if (I.panReset) { SS.view.resetPan(); I.panReset = false; }
    SS.view.render(S, dt);
    SS.ui.draw(S);
    if (SS.audio) SS.audio.frame(S);
  }
  function resize() { if (R) SS.view.resize(innerWidth, innerHeight); }

  /* Renderer + textures depend on the quality preset; changing quality after start reloads the page. */
  async function ensureRenderer(settings) {
    const want = SS.quality.resolve(settings.quality);
    if (R) {
      if (want.name === Q.name) return;
      try { sessionStorage.setItem(AUTO_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
      location.reload();
      await new Promise(() => {});
    }
    Q = want;
    const t0 = performance.now();
    SS.menu.progress(0.01, 'Stitching textures');
    tx = await SS.tex.loadAll(Q.tex, (f, l) => SS.menu.progress(0.01 + 0.2 * f, l));
    stats.texMs = performance.now() - t0;
    R = SS.view.init($('view'), tx, Q, { preserve: params.has('auto') });
    SS.ui.init(R.camera, $('view'));
    resize();
  }

  /* Full new map with progress: generation stages, subsystem setup, then chunk meshing. */
  async function newGame(settings) {
    if (busy) { if (netGame) pendingStart = settings; return; }       // a net 'start' that arrives while loading runs next
    if (netGame && SS.net.active) { if (SS.net.isHost) settings = SS.net.start(Object.assign({}, settings, { cpu: 'off' })); else SS.net.clearQueues(); }
    busy = true; menuOpen = false;
    RP.snap = RP.inputs = RP.play = null; RP.armed = false;          // a replay never runs into a new world
    paused = true; running = false;
    try {
      await ensureRenderer(settings);
      SS.view.setSlice(settings.slice);
      let t0 = performance.now();
      const job = SS.sim.begin_reset(S, settings);
      let p = 0, ts = performance.now();
      SS.menu.progress(0.22, job.label);
      while ((p = SS.sim.reset_step(S, job)) < 1) {
        if (performance.now() - ts > 30) { SS.menu.progress(0.22 + 0.5 * p, job.label); await tick(); ts = performance.now(); }
      }
      stats.genMs = performance.now() - t0;
      SS.menu.progress(0.72, 'Building terrain meshes'); await tick();
      t0 = performance.now();
      SS.view.newWorld(S);
      await SS.view.buildTerrain(f => SS.menu.progress(0.72 + 0.27 * f, 'Building terrain meshes'));
      stats.meshMs = performance.now() - t0;
      SS.menu.progress(1, 'Ready');
      frameRender(C.STEP);
      SS.menu.hide(params.has('auto'));
      S.netStep = 0;
      running = true; paused = !!(window.POC && window.POC.keepPaused);
    } catch (e) {
      console.error(e); SS.menu.error(e.message || String(e));
    } finally { busy = false; if (pendingStart) { const p = pendingStart; pendingStart = null; newGame(p); } }
  }

  function openMenu() {
    if (busy || !running) return;
    // net game: only the host may start a new map (it is sent to the guest); the guest cannot desync the game
    if (netGame && !SS.net.isHost) { SS.sim.log(S, 'Multiplayer: the host chooses the maps.', 0xffb080); return; }
    menuOpen = true;
    // keys / clicks pressed before the menu opened must not fire or jump on Resume
    SS.input.end_step(); SS.input.clicks.length = 0; inp.fire_held = 0; inp.fire_pressed = 0;
    SS.menu.show(SS.menu.load(), s => newGame(s), { inGame: true, onResume: () => { menuOpen = false; SS.input.end_step(); } });
  }

  function urlSettings() {
    const s = Object.assign({}, C.SETTINGS);
    for (const k of ['biome', 'weather', 'lava', 'wind', 'quality', 'slice', 'under', 'cpu', 'skill', 'placement', 'time', 'art', 'shape', 'first', 'volcanoes']) if (params.has(k)) s[k] = params.get(k);
    for (const k of ['blood', 'select', 'keepRope', 'rooms']) if (params.has(k)) s[k] = params.get(k) !== '0' && params.get(k) !== 'off';
    for (const k of ['teams', 'worms', 'hp', 'turnTime']) if (params.has(k)) s[k] = parseInt(params.get(k), 10) || 0;
    if (params.has('ctl')) s.ctl = params.get('ctl').split(',');
    if (params.has('sd')) s.sd = params.get('sd') !== '0';
    if (params.has('seed')) s.seed = parseInt(params.get('seed'), 10) || 0;
    if (params.has('collapse')) s.collapse = params.get('collapse') !== '0';
    return s;
  }

  function boot() {
    const canvas = $('view');
    SS.menu.init();
    SS.input.attach(canvas, code => {
      // P9: the PoC weapon hotkeys took B, C, H, L, N, R (sim/arsenal.js); these moved to F1 / ?, Home, ` and the menu
      if (code === 'F1' || code === 'Slash') $('help').classList.toggle('hidden');
      if ((code === 'KeyM' || code === 'Escape') && running && !menuOpen) openMenu();
      if (code === 'Home') SS.view.resetPan && SS.view.resetPan();
      if (code === 'F2' && SS.audio) { SS.audio.setMuted(!SS.audio.muted); $('mutebtn').textContent = SS.audio.muted ? '🔇' : '🔊'; }
      if (code === 'Backquote' && running) {                       // cycle how much of the world behind slice zero is solid
        const names = Object.keys(SS.view.SLICE), v = SS.view.setSlice(names[(names.indexOf(SS.view.slice) + 1) % names.length]);
        S.settings.slice = v; const st = SS.menu.load(); st.slice = v; SS.menu.save(st);
        SS.sim.log(S, `Slice view: ${v} (${v === 'full' ? 'everything' : SS.view.SLICE[v] + ' m'} behind the collision slice).`, 0xfff3b0);
      }
    });
    // top map click: in a net game it goes through the lockstep input (align_id), only on the own turn
    $('topmap').addEventListener('click', e => { const w = SS.ui.pickTop(S, e); if (!w) return; if (netGame) { if (S.active && S.active.team === SS.net.team) pendingAlign = w.id + 1; } else SS.sim.align_to(S, w); });
    $('menubtn').addEventListener('click', openMenu);
    if (SS.audio) { $('mutebtn').textContent = SS.audio.muted ? '🔇' : '🔊'; $('mutebtn').addEventListener('click', () => { SS.audio.setMuted(!SS.audio.muted); $('mutebtn').textContent = SS.audio.muted ? '🔇' : '🔊'; }); }
    // P9: weapon grid clicks, the game-over buttons
    SS.ui.onPick = k => { SS.input.pickWeapon = k; };
    if (SS.input.attachTouch) SS.input.attachTouch(canvas);           // P24.4 touch pad + gestures
    // PoC mouse: a left press aims + fires on a local human turn with a weapon that is aimed (target weapons and a
    // homing without its target, or shift + click, take the click as a target instead)
    SS.input.mouseFireOk = shift => {
      if (!running || menuOpen || !S || S.phase !== 'play' || !S.active || SS.game.is_cpu(S, S.active.team)) return false;
      if (netGame && !SS.net.drives(S.active.team)) return false;
      const d = C.ARSENAL[S.weapon]; if (!d || d.kind === 'target' || S.weapon === 'girder') return false;
      return !(d.target && (!S.tgt || shift));
    };
    SS.ui.onRematch = () => { if (netGame && !SS.net.isHost) return; newGame(Object.assign({}, S.settings, { seed: ((S.settings.seed | 0) + 1) % 100000 })); };
    SS.ui.onSetup = () => { if (netGame && !SS.net.isHost) return; openMenu(); };
    SS.ui.onOnline = () => { if (SS.netui) SS.netui.toggle(SS.menu.load()); };
    SS.menu.onOnline = () => SS.ui.onOnline();
    addEventListener('resize', resize);
    canvas.addEventListener('mousemove', e => { if (SS.armsView) SS.armsView.cursor = { x: e.clientX, y: e.clientY }; });   // P7: aim helpers
    if (innerWidth < 900) $('help').classList.add('hidden');

    /* Deterministic hooks for automated verification. */
    window.POC = {
      S, get W() { return SS.world; }, keys: SS.input.keys, pressed: SS.input.pressed, stats0: stats, keepPaused: false,
      get camera() { return SS.view.camera(); }, get scene() { return SS.view.scene(); }, get renderer() { return SS.view.renderer(); },
      get ready() { return running && !busy; }, get quality() { return Q && Q.name; },
      start: s => newGame(Object.assign(urlSettings(), s || {})),
      overlap2: (s, y) => SS.plane.overlap2(S, s, y), toPlane: p => SS.plane.to_plane(S, p), toWorld: (s, y) => SS.plane.to_world(S, s, y),
      sample2: (s, y) => SS.plane.sample2(S, s, y), solid2: (s, y) => SS.plane.solid2(S, s, y),
      rotateBy: da => SS.sim.rotate_by(S, da), alignTo: w => SS.sim.align_to(S, w), alignNext: k => SS.sim.align_next(S, k),
      fire: p => SS.sim.fire(S, p), explode: (c, wp) => SS.sim.explode(S, c, wp || { W: 1 }), shootRope: () => { SS.sim.shoot_rope(S); SS.sim.hook_resolve(S); },
      nextTurn: () => SS.sim.next_turn(S),
      vis: w => SS.view.vis(w),
      pause(v) { paused = v; this.keepPaused = v; },
      replaying: () => RP.play ? { i: RP.play.i, n: RP.play.inputs.length } : null,
      advance(sec, input) { const n = Math.round(sec / C.STEP); for (let i = 0; i < n; i++) { if (input) input(i); step(); } SS.view.snapCamera(); frameRender(C.STEP); },
      render() { SS.view.snapCamera(); frameRender(C.STEP); },
      slabExtent() { const b = SS.terrain.uniforms.uBack.value; return { minT: -b, maxT: 0, thickness: b }; },
      setSlice: v => SS.view.setSlice(v),
      stats: () => {
        const ts = SS.terrain.stats(), a = SS.terrain.uniforms.uAlpha.value;
        let slabTris = 0; for (const c of SS.terrain.chunks()) if (c && c.slab.visible) slabTris += c.tris;
        return Object.assign({ slabTris, ctxAlpha: a, ctxVisible: a > 0.004, outlineSegs: S.section ? S.section.outline.length / 4 : 0, grass: SS.grass.count() }, ts, stats);
      }
    };
    window.POC.reset = () => newGame(S.settings);
    // 9b: multiplayer lobby (L) and the hooks the net layer calls
    if (SS.net) {
      // P12: the host starts the match from the lobby (net.start assigns the seats); guests start on 'start'
      SS.net.stepNow = () => S.netStep | 0;
      SS.ui.netStart = settings => { if (!SS.net.isHost || !SS.net.active) return; netGame = true; newGame(Object.assign({}, settings || SS.menu.load(), { cpu: 'off' })); };
      SS.net.on('start', st => {
        const ok = {}, allow = ['biome', 'seed', 'weather', 'lava', 'wind', 'under', 'collapse', 'teams', 'worms', 'hp', 'turnTime', 'skill', 'sd', 'placement', 'first', 'volcanoes', 'time', 'shape', 'blood', 'select', 'keepRope', 'rooms'];
        for (const k of allow) if (st[k] != null && (typeof st[k] === 'string' || typeof st[k] === 'number' || typeof st[k] === 'boolean')) ok[k] = st[k];
        if (Array.isArray(st.ctl)) ok.ctl = st.ctl.slice(0, 4).map(v => (v === 'cpu' ? 'cpu' : 'human'));
        if (Array.isArray(st.names)) ok.names = st.names.slice(0, 4).map(v => String(v).slice(0, 18));
        // presentation stays the guest's own (a different quality reloads the renderer: it dropped the link mid-match)
        const mine = SS.menu.load() || {}, pres = {};
        for (const k of ['quality', 'slice', 'art']) if (mine[k] != null) pres[k] = mine[k];
        netGame = true; newGame(Object.assign(urlSettings(), pres, ok, { cpu: 'off' }));
      });
      SS.net.on('leave', d => {
        if (!netGame) return;
        SS.sim.log(S, `${d.name} disconnected.`, 0xffb080);
        // the host's last guest left: no lockstep any more (the local step path runs), so apply the queued CPU
        // take-over of the departed seats now (stepNet would have, at its step) and go on as a local game
        if (SS.net.isHost && SS.net.peers().length <= 1) {
          for (const c of SS.net.ctl_due(Infinity)) if (S.teams && S.teams[c.team]) { S.teams[c.team].ctl = 'cpu'; SS.sim.log(S, `${S.teams[c.team].name} left: the CPU plays their worms now.`, 0xffb080); }
          netGame = false;
        }
      });
      SS.net.on('desync', d => { console.warn('lockstep desync at step', d.k); SS.sim.log(S, `Desync at step ${d.k}: the two games differ.`, 0xff8080); });
      SS.net.on('close', () => { if (netGame) SS.sim.log(S, 'Multiplayer: the host left; the game goes on here only.', 0xffb080); netGame = false; });
      window.POC.net = { get game() { return netGame; }, stepNet: () => stepNet(), flush: () => SS.net.flush(), start: st => SS.ui.netStart(st) };
    }

    let auto = null;
    try { auto = JSON.parse(sessionStorage.getItem(AUTO_KEY) || 'null'); sessionStorage.removeItem(AUTO_KEY); } catch (e) { auto = null; }
    if (params.has('auto')) auto = urlSettings();
    if (auto) newGame(auto);
    else SS.menu.show(SS.menu.load(), s => newGame(s));

    let acc = 0, last = performance.now(), frameErrs = 0;
    function frame(now) {
      // the next frame is requested first: an exception in one frame is logged (console.error, the tests see it) but
      // never stops the loop (D6: a RangeError in the section builder used to freeze the game for good)
      requestAnimationFrame(frame);
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000)); last = now;
      try {
        if (running && !busy) {
          if (netGame && SS.net.active) {
            // lockstep: the driver steps in real time; the follower also catches up on queued inputs (<= 60 per frame)
            // (catch-up applies to the follower only: a driver never runs ahead of real time)
            if (!menuOpen) { acc += dt; let n = 0; while (running && n < 60 && (acc >= C.STEP || (!SS.net.drives(S.active ? S.active.team : 0) && SS.net.pending() > 2))) { if (!stepNet()) { acc = Math.min(acc, C.STEP); break; } acc = Math.max(0, acc - C.STEP); n++; } SS.net.flush(); }
          } else if (!paused && !menuOpen) { acc += dt * (RP.play ? 0.5 : S.time < (S.slowUntil || 0) && S.slowUntil - S.time < 1.5 ? 0.35 : 1); while (acc >= C.STEP && running) { step(); acc -= C.STEP; } }   // (PoC slow motion)
          else acc = 0;
          if (!paused) frameRender(dt);
        }
      } catch (e) { acc = 0; if (frameErrs++ < 5) console.error('frame error:', e && e.stack || e); }
    }
    requestAnimationFrame(frame);
  }
  boot();
})(window.SS = window.SS || {});
