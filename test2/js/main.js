/* main.js — the browser entry. It boots the menu and binds the keys, the buttons and the HUD callbacks. It makes a
 * new world (the quality's renderer and textures, the world generation, the terrain meshes, behind a progress bar)
 * and hands the running game to the frame loop (platform/loop.js). A local step runs the input and the instant
 * replay (platform/replay.js); a net match's steps are the session's (platform/session.js). The deterministic test
 * hooks are on window.POC. */
(function (SS) {
  'use strict';
  const C = SS.CFG, PHASE = C.PHASE, $ = id => document.getElementById(id);
  const S = SS.sim.create();
  const inp = SS.sim.input_make();
  const params = new URLSearchParams(location.search);
  // the settings a quality change carries across its page reload
  const AUTO_KEY = 'strataSlice.autostart';
  /* the app: the one game state and its input, and what runs (the frame loop, the net session and the instant
   * replay read it). paused: the tools' pause and the time before the first frame; busy: a new world is being made;
   * quality: the running quality preset (platform/quality.js) */
  const A = { S, inp, running: false, paused: false, menuOpen: false, busy: false, quality: null };
  const stats = { genMs: 0, meshMs: 0, texMs: 0 };
  const tick = () => new Promise(r => setTimeout(r, 0));
  // the listener the view fills for the audio every frame
  const ears = SS.audio ? SS.audio.ears_make() : null;
  let tx = null, R = null, pendingStart = null;

  /* a left click on the canvas: a target on the section for a target weapon (it fires) and the homing missile (it
   * sets the target), a spot for a worm in the placement phase, or a drop of the armed debug item */
  function clickTarget() {
    const I = SS.input;
    if (!I.clicks.length) return null;
    const c = I.clicks.shift();
    I.clicks.length = 0;
    if (SS.dbgui && SS.dbgui.armed()) {
      const p = SS.view.pickPlane(S, c.x, c.y);
      if (p) SS.dbgui.queue(p.s, p.y);
      return null;
    }
    if (S.phase === PHASE.PLACE) {
      const p = SS.view.pickPlane(S, c.x, c.y);
      return p ? { s: p.s, y: p.y, fire: true } : null;
    }
    const d = C.ARSENAL[S.weapon];
    if (!d || !(d.kind === 'target' || d.target) || S.phase !== PHASE.PLAY) return null;
    const p = SS.view.pickPlane(S, c.x, c.y);
    if (!p) return null;
    // (twostep: the mail raven: the click sets the target, Space releases)
    return { s: p.s, y: p.y, fire: d.kind === 'target' && !d.twostep };
  }
  /* one local step: the replay's playback (any key or click skips it), or this player's input through the sim (a
   * debug drop rides in it, sim/debug.js) with the instant replay watching */
  function step() {
    const I = SS.input, net = SS.session.game();
    if (SS.replay.playing()) {
      const skip = I.pressed.has('Space') || I.pressed.has('Enter') || I.pressed.has('Escape') || I.clicks.length > 0;
      I.clicks.length = 0;
      I.end_step();
      SS.replay.step(S, skip);
      return;
    }
    I.sample(inp, S, clickTarget());
    if (SS.dbgui && !net) SS.dbgui.fill(inp);
    if (inp.reset) {
      inp.reset = 0;
      I.end_step();
      SS.replay.clear();
      if (!net) newGame(S.settings);
      return;
    }
    if (!net) SS.replay.watch(S);
    SS.sim.step(S, inp, C.STEP);
    SS.replay.record(S, inp);
    I.end_step();
  }
  function frameRender(dt) {
    const I = SS.input;
    if (I.wheel) {
      SS.view.zoom(I.wheel);
      I.wheel = 0;
    }
    if (I.zoomToggle) {
      I.zoomToggle = false;
      SS.view.zoomToggle();
    }
    if (I.panX || I.panY) {
      SS.view.drag(I.panX, I.panY, S);
      I.panX = I.panY = 0;
    }
    // edge scroll: the mouse parked in the outer 10 % of the view scrolls the camera (not while dragging / firing)
    if (I.mouseIn && !I.held && !I.mfire && A.running && !A.menuOpen && !A.paused && !(S.inspect > 0.5)) {
      const ex = I.mx / innerWidth, ey = I.my / innerHeight, m = 0.1;
      const vx = ex < m ? -(m - ex) / m : ex > 1 - m ? (ex - 1 + m) / m : 0,
        vy = ey < m ? -(m - ey) / m : ey > 1 - m ? (ey - 1 + m) / m : 0;
      if (vx || vy) SS.view.drag(-vx * 1000 * dt, -vy * 1000 * dt, S);
    }
    if (I.panReset) {
      SS.view.resetPan();
      I.panReset = false;
    }
    SS.view.render(S, dt);
    SS.ui.draw(S);
    if (SS.audio) SS.audio.frame(S, SS.view.ears(ears));
  }
  function resize() {
    if (R) SS.view.resize(innerWidth, innerHeight);
  }
  // the presentation after a snapshot is loaded into S (a replay, a resync): no stale actors or HUD state, the camera
  // on the new state
  function refresh() {
    if (SS.view.clearActors) SS.view.clearActors();
    if (SS.ui.clear) SS.ui.clear();
    SS.view.snapCamera();
  }

  /* Renderer + textures depend on the quality preset; changing quality after start reloads the page. */
  async function ensureRenderer(settings) {
    const want = SS.quality.resolve(settings.quality);
    if (R) {
      if (want.name === A.quality.name) return;
      SS.store.put_session(AUTO_KEY, settings);
      location.reload();
      await new Promise(() => {});
    }
    A.quality = want;
    const t0 = performance.now();
    SS.menu.progress(0.01, 'Stitching textures');
    tx = await SS.tex.loadAll(want.tex, (f, l) => SS.menu.progress(0.01 + 0.2 * f, l));
    stats.texMs = performance.now() - t0;
    R = SS.view.init($('view'), tx, want, { preserve: params.has('auto') });
    SS.ui.init(R.camera, $('view'));
    resize();
  }

  /* Full new map with progress: generation stages, subsystem setup, then chunk meshing. */
  async function newGame(settings) {
    const net = SS.session.game();
    // a net 'start' that arrives while loading runs next
    if (A.busy) {
      if (net) pendingStart = settings;
      return;
    }
    // (a guest never clears the queues here: net.js did it at 'start', and inputs of the new match may already be
    // buffered)
    if (net && SS.net.active && SS.net.isHost) settings = SS.net.start(Object.assign({}, settings, { cpu: 'off' }));
    A.busy = true;
    A.menuOpen = false;
    SS.replay.clear();
    A.paused = true;
    A.running = false;
    try {
      await ensureRenderer(settings);
      SS.view.setSlice(settings.slice);
      SS.view.setGhost(settings.ghost | 0);
      if (SS.view.setGhostAuto) SS.view.setGhostAuto(settings.ghostAuto !== false);
      if (SS.cine) SS.cine.setEnabled(settings.cine !== false);
      if (SS.anticCam) SS.anticCam.setEnabled(settings.anticCam !== false);
      SS.quality.set_frame_rate(settings.fps);
      let t0 = performance.now();
      const job = SS.sim.begin_reset(S, settings);
      let p = 0, ts = performance.now();
      SS.menu.progress(0.22, job.label);
      while ((p = SS.sim.reset_step(S, job)) < 1) {
        if (performance.now() - ts > 30) {
          SS.menu.progress(0.22 + 0.5 * p, job.label);
          await tick();
          ts = performance.now();
        }
      }
      stats.genMs = performance.now() - t0;
      SS.menu.progress(0.72, 'Building terrain meshes'); await tick();
      t0 = performance.now();
      SS.view.newWorld(S);
      await SS.view.buildTerrain(f => SS.menu.progress(0.72 + 0.27 * f, 'Building terrain meshes'));
      stats.meshMs = performance.now() - t0;
      SS.menu.progress(0.995, 'Compiling shaders'); await tick();
      SS.view.prewarm(S);
      SS.menu.progress(1, 'Ready');
      frameRender(C.STEP);
      SS.menu.hide(params.has('auto'));
      S.netStep = 0;
      // the debug toolbox drops only in local / CPU matches
      if (SS.debug) SS.debug.enable(S, !net);
      if (SS.dbgui) SS.dbgui.allowed(!net);
      A.running = true;
      A.paused = !!(window.POC && window.POC.keepPaused);
    } catch (e) {
      console.error(e); SS.menu.error(e.message || String(e));
    } finally {
      A.busy = false;
      if (pendingStart) {
        const p = pendingStart;
        pendingStart = null;
        newGame(p);
      }
    }
  }

  function openMenu() {
    if (A.busy || !A.running) return;
    // net game: only the host may start a new map (it is sent to the guest); the guest cannot desync the game
    if (SS.session.game() && !SS.net.isHost) {
      SS.sim.log(S, 'Multiplayer: the host chooses the maps.', 0xffb080);
      return;
    }
    A.menuOpen = true;
    // keys / clicks pressed before the menu opened must not fire or jump on Resume
    SS.input.end_step();
    SS.input.clicks.length = 0;
    inp.fire_held = 0;
    inp.fire_pressed = 0;
    // the form shows the LIVE settings of this match (rematch seed + 1, ?auto, net start), not only the saved ones
    const saved = SS.menu.load(), live = Object.assign({}, saved, S.settings || {});
    if (saved.biome === 'random' && SS.menu.resolve_biome(Object.assign({}, saved, { seed: live.seed })) === live.biome)
      live.biome = 'random';
    SS.menu.show(live, s => newGame(s), {
      inGame: true,
      onResume: () => {
        A.menuOpen = false;
        SS.input.end_step();
      }
    });
  }

  /* the settings a URL asks for (?biome=desert&teams=3&fort=1): every row of the settings schema by its key (the Lab
   * mask also as ?lab=), read by the row's kind (C.setting_value), then the menu's sanitizer (an unknown biome or an
   * out-of-range value falls back to the default) */
  function urlSettings() {
    const s = Object.assign({}, C.SETTINGS);
    for (const r of C.SETTING_SCHEMA) {
      const k = r[0] === 'labFlags' && params.has('lab') ? 'lab' : r[0];
      if (params.has(k)) s[r[0]] = C.setting_value(r, params.get(k));
    }
    return SS.menu.sanitize(s, C.SETTINGS);
  }
  const setMuteIcon = () => { $('mutebtn').textContent = SS.audio.muted ? '🔇' : '🔊'; };

  function boot() {
    const canvas = $('view');
    SS.menu.init();
    // ?debug=1 opens the debug toolbox at the start (F9 toggles it)
    if (SS.dbgui) SS.dbgui.init(params.get('debug') === '1');
    SS.replay.init(refresh);
    SS.input.attach(canvas, code => {
      // (the weapon hotkeys own B, C, H, L, N, R, sim/arsenal.js: help, home and the slice view are on F1 / ?, Home, `)
      if (code === 'F9' && SS.dbgui) {
        SS.dbgui.toggle();
        return;
      }
      // Esc cancels a pending debug drop (before it opens the menu)
      if (code === 'Escape' && SS.dbgui && SS.dbgui.armed()) {
        SS.dbgui.cancel();
        return;
      }
      if (code === 'F1' || code === 'Slash') $('help').classList.toggle('hidden');
      // aim details on / off (the i button on the HUD panel does the same, also by touch)
      if (code === 'F3' && SS.ui.toggleDetail) SS.ui.toggleDetail();
      if ((code === 'KeyM' || code === 'Escape') && A.running && !A.menuOpen) openMenu();
      if (code === 'Home') SS.view.resetPan && SS.view.resetPan();
      if (code === 'F2' && SS.audio) {
        SS.audio.setMuted(!SS.audio.muted);
        setMuteIcon();
      }
      // cycle how much of the world behind slice zero is solid
      if (code === 'Backquote' && A.running) {
        const names = Object.keys(SS.view.SLICE), v = SS.view.setSlice(names[(names.indexOf(SS.view.slice) + 1) % names.length]);
        S.settings.slice = v;
        const st = SS.menu.load();
        st.slice = v;
        SS.menu.save(st);
        SS.sim.log(S, `Slice view: ${v} (${v === 'full' ? 'everything' : SS.view.SLICE[v] + ' m'} behind the collision slice).`, 0xfff3b0);
      }
    });
    // top map click: in a net game it goes through the lockstep input (align_id), only on the own turn
    $('topmap').addEventListener('click', e => {
      const w = SS.ui.pickTop(S, e);
      if (!w) return;
      if (SS.session.game()) SS.session.align(w);
      else SS.sim.align_to(S, w);
    });
    $('menubtn').addEventListener('click', openMenu);
    if (SS.audio) {
      setMuteIcon();
      $('mutebtn').addEventListener('click', () => {
        SS.audio.setMuted(!SS.audio.muted);
        setMuteIcon();
      });
    }
    // the weapon grid, the HUD's life jacket button, the game-over buttons
    SS.ui.onPick = k => { SS.input.pickWeapon = k; };
    SS.ui.onGear = k => { SS.input.gearReq = k + 1; };
    if (SS.input.attachTouch) SS.input.attachTouch(canvas);
    SS.input.pick = SS.view.pickPlane;
    // the mouse: a left press aims and fires on a local human turn with a weapon that is aimed (target weapons and a
    // homing without its target, or shift + click, take the click as a target instead; an armed debug item drops)
    SS.input.mouseFireOk = shift => {
      if (SS.dbgui && SS.dbgui.armed()) return false;
      if (!A.running || A.menuOpen || S.phase !== PHASE.PLAY || !S.active || SS.game.is_cpu(S, S.active.team)) return false;
      if (SS.session.game() && !SS.net.drives(S.active.team)) return false;
      const d = C.ARSENAL[S.weapon];
      if (!d || d.kind === 'target' || S.weapon === 'girder') return false;
      return !(d.target && (!S.tgt || shift));
    };
    SS.ui.onRematch = () => {
      if (SS.session.game() && !SS.net.isHost) return;
      newGame(Object.assign({}, S.settings, { seed: ((S.settings.seed | 0) + 1) % 100000 }));
    };
    SS.ui.onSetup = () => {
      if (SS.session.game() && !SS.net.isHost) return;
      openMenu();
    };
    SS.ui.onOnline = () => {
      if (SS.netui) SS.netui.toggle(SS.menu.load());
    };
    SS.menu.onOnline = () => SS.ui.onOnline();
    SS.menu.defaultStart = s => newGame(s);
    // (a failed start: back to a local menu)
    SS.menu.onBack = () => SS.session.cancel();
    addEventListener('resize', resize);
    // the aim helpers follow the cursor
    canvas.addEventListener('mousemove', e => {
      if (SS.armsView) SS.armsView.cursor = { x: e.clientX, y: e.clientY };
    });
    if (innerWidth < 900) $('help').classList.add('hidden');
    // adaptive resolution: off under automation (navigator.webdriver: tests want a fixed canvas), ?adpr=1 / 0 forces
    const adaptOn = params.get('adpr') === '1' || (params.get('adpr') !== '0' && !navigator.webdriver);

    /* Deterministic hooks for automated verification. */
    window.POC = {
      S, get W() { return SS.world; }, keys: SS.input.keys, pressed: SS.input.pressed, stats0: stats, keepPaused: false,
      get camera() { return SS.view.camera(); }, get scene() { return SS.view.scene(); }, get renderer() { return SS.view.renderer(); },
      get dpr() { return SS.view.dpr(); }, adaptive: () => adaptOn,
      get ready() { return A.running && !A.busy; }, get quality() { return A.quality && A.quality.name; },
      start: s => newGame(Object.assign(urlSettings(), s || {})),
      overlap2: (s, y) => SS.plane.overlap2(S, s, y), toPlane: p => SS.plane.to_plane(S, p), toWorld: (s, y) => SS.plane.to_world(S, s, y),
      sample2: (s, y) => SS.plane.sample2(S, s, y), solid2: (s, y) => SS.plane.solid2(S, s, y),
      rotateBy: da => SS.sim.rotate_by(S, da), alignTo: w => SS.sim.align_to(S, w), alignNext: k => SS.sim.align_next(S, k),
      fire: p => SS.sim.fire(S, p), explode: (c, wp) => SS.sim.explode(S, c, wp || { W: 1 }), shootRope: () => {
        SS.sim.shoot_rope(S);
        SS.sim.hook_resolve(S);
      },
      nextTurn: () => SS.sim.next_turn(S),
      vis: w => SS.view.vis(w),
      pause(v) {
        A.paused = v;
        this.keepPaused = v;
      },
      replaying: () => SS.replay.progress(),
      // (tools: one fixed step, the real game path, without a render)
      stepOnce: input => {
        if (input) input();
        step();
      },
      advance(sec, input) {
        const n = Math.round(sec / C.STEP);
        for (let i = 0; i < n; i++) {
          if (input) input(i);
          step();
        }
        SS.view.snapCamera();
        frameRender(C.STEP);
      },
      // (dt: the studio / tools advance the view clock by the sim time they stepped)
      render(dt) {
        if (!dt) SS.view.snapCamera();
        frameRender(dt || C.STEP);
      },
      slabExtent() {
        const b = SS.terrain.uniforms.uBack.value;
        return { minT: -b, maxT: 0, thickness: b };
      },
      setSlice: v => SS.view.setSlice(v),
      stats: () => {
        const ts = SS.terrain.stats(), a = SS.terrain.uniforms.uAlpha.value;
        let slabTris = 0;
        for (const c of SS.terrain.chunks())
          if (c && c.slab.visible) slabTris += c.tris;
        return Object.assign(
          {
            slabTris,
            ctxAlpha: a,
            ctxVisible: a > 0.004,
            outlineSegs: S.section ? S.section.outline.length / 4 : 0,
            grass: SS.grass.count()
          },
          ts,
          stats
        );
      }
    };
    window.POC.reset = () => newGame(S.settings);
    // the multiplayer lobby and the net match (platform/session.js)
    SS.session.init(A, { new_game: newGame, click_target: clickTarget, url_settings: urlSettings, refresh });
    if (SS.net) {
      window.POC.resyncDebug = { fields: () => SS.netdiag.fields(S), dump: () => SS.netdiag.dump(S), poke: fn => fn(S) };
      window.POC.net = {
        get game() { return SS.session.game(); },
        stepNet: () => SS.session.step(),
        flush: () => SS.net.flush(),
        start: st => SS.ui.netStart(st)
      };
    }

    let auto = SS.store.take_session(AUTO_KEY);
    if (params.has('auto')) auto = urlSettings();
    if (auto) newGame(auto);
    else SS.menu.show(SS.menu.load(), s => newGame(s));
    SS.loop.start(A, { step, render: frameRender, adapt: adaptOn });
  }
  boot();
})(window.SS = window.SS || {});
