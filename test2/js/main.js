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
    const I = SS.input;
    if (!I.clicks.length) return null;
    const c = I.clicks.shift();
    I.clicks.length = 0;
    // P49: the debug toolbox takes the click
    if (SS.dbgui && SS.dbgui.armed()) {
      const p = SS.view.pickPlane(S, c.x, c.y);
      if (p) SS.dbgui.queue(p.s, p.y);
      return null;
    }
    // P13: deploy
    if (S.phase === 'place') {
      const p = SS.view.pickPlane(S, c.x, c.y);
      return p ? { s: p.s, y: p.y, fire: true } : null;
    }
    const d = C.ARSENAL[S.weapon];
    if (!d || !(d.kind === 'target' || d.target) || S.phase !== 'play') return null;
    const p = SS.view.pickPlane(S, c.x, c.y);
    if (!p) return null;
    // (twostep: the mail raven: the click sets the target, Space releases)
    return { s: p.s, y: p.y, fire: d.kind === 'target' && !d.twostep };
  }
  /* P22a instant replay (user: "if more than 1 worm died"): when an attack starts (play -> attack) the deterministic
   * state is snapshot (sim.snapshot: S + the voxel world) and every step's input recorded; when the next turn begins
   * and >= 2 worms died since, the end state is kept aside, the start restored and the recorded steps re-run at half
   * speed under a REPLAY banner (Space / Enter / a click skips), then the end state comes back. Local games only (a
   * lockstep game would have to pause every peer). */
  const RP = { snap: null, inputs: null, dead0: 0, deadN: 0, lastKill: -1, final: false, turn: -1, play: null };
  // (0 HP = the fatal moment; the dying beats come later)
  const deadCount = () => S.worms.reduce((n, w) => n + ((w.dead || w.hp <= 0) && !w.reserve ? 1 : 0), 0);
  function replayStart() {
    const end = SS.sim.snapshot(S);
    SS.sim.restore(S, RP.snap);
    if (SS.view.clearActors) SS.view.clearActors();
    if (SS.ui.clear) SS.ui.clear();
    SS.view.snapCamera();
    // fast-forward (unseen) from the snapshot to the step that started the attack (or to 3 s before the second kill:
    // a long fuse is not worth watching twice), then play it back visibly
    // P118d (Q-25): the kill that ENDS the match: 1.8 s before it to 1.2 s after (never into the step that made the
    // match over), at 0.4 x
    const fin = RP.final;
    if (RP.killAt > 0) RP.at = Math.max(RP.at, RP.killAt - (fin ? 216 : 360));
    for (let i = 0; i < RP.at; i++) SS.sim.step(S, RP.inputs[i], C.STEP);
    S.events.length = 0;
    // up to 1.5 s after the 2nd kill
    RP.play = {
      inputs: RP.killAt > 0 ? RP.inputs.slice(0, Math.min(RP.inputs.length - (fin ? 3 : 0), RP.killAt + (fin ? 144 : 180))) : RP.inputs,
      i: RP.at,
      end,
      slow: fin ? 0.4 : 0.5
    };
    RP.snap = null; RP.inputs = null;
    S.events.push({ type: 'banner', title: fin ? 'Final blow' : 'Instant replay', sub: 'slow motion · Space skips' });
  }
  function replayEnd() {
    SS.sim.restore(S, RP.play.end);
    RP.play = null;
    if (SS.view.clearActors) SS.view.clearActors();
    if (SS.ui.clear) SS.ui.clear();
    SS.view.snapCamera();
    S.events.length = 0;
    // P118d: the end state is the match over: its fanfare (the original event was dropped with the queue)
    if (S.phase === 'over') S.events.push({ type: 'gameover', team: S.over, round: S.round });
  }
  function replayStep() {
    const I = SS.input, skip = I.pressed.has('Space') || I.pressed.has('Enter') || I.pressed.has('Escape') || I.clicks.length;
    I.clicks.length = 0; SS.input.end_step();
    const p = RP.play;
    if (skip || p.i >= p.inputs.length) {
      replayEnd();
      return;
    }
    SS.sim.step(S, p.inputs[p.i++], C.STEP);
  }
  function step() {
    if (RP.play) {
      replayStep();
      return;
    }
    SS.input.sample(inp, S, clickTarget());
    if (SS.dbgui && !netGame) SS.dbgui.fill(inp);                  // P49: a debug drop travels as one step's Input (sim/debug.js)
    if (inp.reset) {
      inp.reset = 0;
      SS.input.end_step();
      RP.snap = RP.inputs = null;
      if (!netGame) newGame(S.settings);
      return;
    }
    const phase0 = S.phase, turn0 = S.turnNo;
    // while the worm aims / walks: a fresh snapshot every 2 s of sim time (~5 ms each); the inputs since it are kept
    if (!netGame && phase0 === 'play' && (!RP.snap || (!RP.armed && (RP.turn !== turn0 || S.time - RP.snapT > 2)))) {
      RP.snap = SS.sim.snapshot(S);
      RP.snapT = S.time;
      RP.inputs = [];
      RP.dead0 = RP.deadN = deadCount();
      RP.lastKill = -1;
      RP.final = false;
      RP.turn = turn0;
      RP.armed = false;
      RP.at = 0;
    }
    SS.sim.step(S, inp, C.STEP);
    if (RP.snap) {
      RP.inputs.push(Object.assign({}, inp));
      // the attack starts with this step
      if (!RP.armed && S.phase !== 'play' && S.turnNo === RP.turn) {
        RP.armed = true;
        RP.at = RP.inputs.length - 1;
        RP.killAt = -1;
      }
      if (RP.armed && RP.killAt < 0 && deadCount() - RP.dead0 >= 2) RP.killAt = RP.inputs.length;                 // the second fatal hit
      // P118d: the step of the latest fatal hit (the final blow of a match needs only one)
      if (RP.armed && deadCount() > RP.deadN) {
        RP.deadN = deadCount();
        RP.lastKill = RP.inputs.length;
      }
      if (S.turnNo !== RP.turn || S.phase === 'over') {
        // P118d (Q-25): a match-ending kill gets its slow-motion replay too
        const nd = deadCount() - RP.dead0, fin = S.phase === 'over' && S.over >= 0 && nd >= 1 && RP.lastKill > 0;
        if (RP.armed && (nd >= 2 || fin) && RP.inputs.length < 120 * 60) {
          RP.final = fin;
          if (fin) RP.killAt = RP.lastKill;
          replayStart();
          SS.input.end_step();
          return;
        }
        RP.snap = RP.inputs = null;
      }
    }
    SS.input.end_step();
  }
  /* 9b lockstep (platform/net.js): the peer owning the active worm's team drives (steps at once, sends its input);
   * the other replays the inputs in order and waits for the next one. false = waiting. */
  let netGame = false, pendingAlign = 0, pendingStart = null, pendingResync = null;
  // presentation settings stay the guest's own across a resync
  const PRES = ['slice', 'art', 'ghost', 'idle', 'ghostAuto', 'cine', 'anticCam', 'quality'];
  function applyResync(d) {
    const NT = SS.net, mine = {};
    for (const k of PRES)
      if (S.settings && S.settings[k] !== undefined) mine[k] = S.settings[k];
    if (d.fields && SS.netdiag && (S.netStep | 0) === d.k) {
      const diff = SS.netdiag.diff(SS.netdiag.fields(S), d.fields).filter(k => k !== 'settings');
      console.warn('resync: fields that differed from the host at step ' + d.k + ':', diff.join(', ') || '(none: only derived data)');
      NT.lastDiff = diff;
    }
    SS.sim.restore(S, d.snap);
    for (const k of PRES)
      if (mine[k] !== undefined) S.settings[k] = mine[k];
    if (SS.view.clearActors) SS.view.clearActors();
    if (SS.ui.clear) SS.ui.clear();
    SS.view.snapCamera();
    S.events.length = 0; S.sectionDirty = true;
    NT.resync_applied(S.netStep | 0, d);
  }
  const inpR = SS.sim.input_make();
  function stepNet() {
    const NT = SS.net, k = S.netStep | 0;
    // P12: a seat that left becomes a CPU team at the step the host fixed (identical on every peer)
    for (const c of NT.ctl_due(k))
      if (S.teams && S.teams[c.team]) {
        S.teams[c.team].ctl = 'cpu';
        SS.sim.log(S, `${S.teams[c.team].name} left: the CPU plays their worms now.`, 0xffb080);
      }
    const drvTeam = S.active ? S.active.team : 0, mine = NT.drives(drvTeam) || (S.phase === 'over' && NT.isHost);
    let use;
    if (mine) {
      SS.input.sample(inp, S, clickTarget());
      // host: next map (sent to the guest)
      if (inp.reset) {
        inp.reset = 0;
        SS.input.end_step();
        if (NT.isHost && S.phase === 'over') newGame(S.settings);
        return false;
      }
    }
    // P103: after a resync the guest re-plays its OWN inputs it had already sent (never re-sampled, never re-sent)
    const rpl = NT.drives(drvTeam) ? NT.takeReplay(k) : null;
    if (rpl) {
      SS.input.sample(inp, S, null);
      SS.input.clicks.length = 0;
      use = NT.unpack(rpl, inpR);
    }
    else if (NT.drives(drvTeam)) {
      if (pendingAlign) {
        inp.align_id = pendingAlign;
        pendingAlign = 0;
      }
      NT.queueInput(k, NT.pack(inp));
      use = inp;
    }
    // P38 D4: a follower's clicks / weapon picks are dropped (a stale click fired a target weapon at the start of the
    // own turn)
    else {
      const a = NT.takeInput(k);
      if (!a) {
        if (NT.isHost) {
          const nm = NT.stalled(drvTeam, k, performance.now());
          if (nm) SS.sim.log(S, `${nm} is not responding: the CPU takes over their worms.`, 0xffb080);
        }
        return false;
      }
      SS.input.sample(inp, S, null);
      SS.input.clicks.length = 0;
      use = NT.unpack(a, inpR);
    }
    SS.sim.step(S, use, C.STEP); SS.input.end_step();
    use.align_id = 0;
    S.netStep = k + 1;
    if (NT.due(S.netStep)) NT.hash(S.netStep, SS.sim.hash(S));       // only every HASH_EVERY steps
    return true;
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
    // PoC edgeScroll: the mouse parked in the outer 10 % of the view scrolls the camera (not while dragging / firing)
    if (I.mouseIn && !I.held && !I.mfire && running && !menuOpen && !paused && !(S.inspect > 0.5)) {
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
    if (SS.audio) SS.audio.frame(S);
  }
  function resize() {
    if (R) SS.view.resize(innerWidth, innerHeight);
  }

  /* Renderer + textures depend on the quality preset; changing quality after start reloads the page. */
  async function ensureRenderer(settings) {
    const want = SS.quality.resolve(settings.quality);
    if (R) {
      if (want.name === Q.name) return;
      try {
        sessionStorage.setItem(AUTO_KEY, JSON.stringify(settings));
      } catch (e) { /* ignore */ }
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
    // a net 'start' that arrives while loading runs next
    if (busy) {
      if (netGame) pendingStart = settings;
      return;
    }
    // (P38 R6 R1: a guest never clears the queues here: net.js did it at 'start', and inputs of the new match may
    // already be buffered)
    if (netGame && SS.net.active) {
      if (SS.net.isHost) settings = SS.net.start(Object.assign({}, settings, { cpu: 'off' }));
    }

    busy = true; menuOpen = false;
    RP.snap = RP.inputs = RP.play = null; RP.armed = false;          // a replay never runs into a new world
    paused = true; running = false;
    try {
      await ensureRenderer(settings);
      SS.view.setSlice(settings.slice);
      SS.view.setGhost(settings.ghost | 0);
      if (SS.view.setGhostAuto) SS.view.setGhostAuto(settings.ghostAuto !== false);
      if (SS.cine) SS.cine.setEnabled(settings.cine !== false);
      if (SS.anticCam) SS.anticCam.setEnabled(settings.anticCam !== false);
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
      if (SS.debug) SS.debug.enable(S, !netGame);                    // P49: the debug toolbox drops only in local / CPU matches
      if (SS.dbgui) SS.dbgui.allowed(!netGame);
      running = true; paused = !!(window.POC && window.POC.keepPaused);
    } catch (e) {
      console.error(e); SS.menu.error(e.message || String(e));
    } finally {
      busy = false;
      if (pendingStart) {
        const p = pendingStart;
        pendingStart = null;
        newGame(p);
      }
    }
  }

  function openMenu() {
    if (busy || !running) return;
    // net game: only the host may start a new map (it is sent to the guest); the guest cannot desync the game
    if (netGame && !SS.net.isHost) {
      SS.sim.log(S, 'Multiplayer: the host chooses the maps.', 0xffb080);
      return;
    }
    menuOpen = true;
    // keys / clicks pressed before the menu opened must not fire or jump on Resume
    SS.input.end_step();
    SS.input.clicks.length = 0;
    inp.fire_held = 0;
    inp.fire_pressed = 0;
    // P38 R3: the form shows the LIVE settings of this match (rematch seed + 1, ?auto, net start), not only the saved
    // ones
    const saved = SS.menu.load(), live = Object.assign({}, saved, S.settings || {});
    if (saved.biome === 'random' && SS.menu.resolve_biome(Object.assign({}, saved, { seed: live.seed })) === live.biome)
      live.biome = 'random';
    SS.menu.show(live, s => newGame(s), {
      inGame: true,
      onResume: () => {
        menuOpen = false;
        SS.input.end_step();
      }
    });
  }

  function urlSettings() {
    const s = Object.assign({}, C.SETTINGS);
    for (
      const k of [
        'biome', 'weather', 'lava', 'wind', 'quality', 'slice', 'ghost', 'under', 'cpu', 'skill', 'placement', 'time', 'art', 'shape',
        'first', 'volcanoes', 'mapSize', 'dim'
      ]
    )
      if (params.has(k)) s[k] = params.get(k);
    for (const k of SS.CFG.DENSITY.KEYS.concat(['mineFuse', 'toolCrates', 'jetpacks']))
      if (params.has(k)) s[k] = params.get(k);
    if (params.has('jackets')) s.jackets = parseInt(params.get('jackets'), 10);
    for (const k of ['blood', 'select', 'keepRope', 'rooms', 'rotLock', 'teamBlood', 'ghostAuto', 'cine', 'anticCam', 'fort', 'jacketOn'])
      if (params.has(k)) s[k] = params.get(k) !== '0' && params.get(k) !== 'off';
    // P84: crate levels 0..10
    for (const k of SS.CFG.CRATES.SLIDERS)
      if (params.has(k)) s[k] = Math.max(0, Math.min(10, parseInt(params.get(k), 10) || 0));
    for (const k of ['teams', 'worms', 'hp', 'turnTime'])
      if (params.has(k)) s[k] = parseInt(params.get(k), 10) || 0;
    if (params.has('ctl')) s.ctl = params.get('ctl').split(',');
    if (params.has('lab')) s.labFlags = parseInt(params.get('lab'), 10) || 0;     // P42: Lab mechanics bit mask (tests)
    if (params.has('sd')) s.sd = params.get('sd') !== '0';
    if (params.has('seed')) s.seed = parseInt(params.get('seed'), 10) || 0;
    if (params.has('collapse')) s.collapse = params.get('collapse') !== '0';
    return SS.menu.sanitize(s, C.SETTINGS);                           // (P38 R6 R3: an unknown biome / out-of-range value from the URL)
  }

  function boot() {
    const canvas = $('view');
    SS.menu.init();
    if (SS.dbgui) SS.dbgui.init(params.get('debug') === '1');       // P49: ?debug=1 opens the debug toolbox at the start (F9 toggles it)
    SS.input.attach(canvas, code => {
      // P9: the PoC weapon hotkeys took B, C, H, L, N, R (sim/arsenal.js); these moved to F1 / ?, Home, ` and the menu
      if (code === 'F9' && SS.dbgui) {
        SS.dbgui.toggle();
        return;
      }
      // P49: Esc cancels a pending drop (before it opens the menu)
      if (code === 'Escape' && SS.dbgui && SS.dbgui.armed()) {
        SS.dbgui.cancel();
        return;
      }
      if (code === 'F1' || code === 'Slash') $('help').classList.toggle('hidden');
      // aim details on / off (the i button on the HUD panel does the same, also by touch)
      if (code === 'F3' && SS.ui.toggleDetail) SS.ui.toggleDetail();
      if ((code === 'KeyM' || code === 'Escape') && running && !menuOpen) openMenu();
      if (code === 'Home') SS.view.resetPan && SS.view.resetPan();
      if (code === 'F2' && SS.audio) {
        SS.audio.setMuted(!SS.audio.muted);
        $('mutebtn').textContent = SS.audio.muted ? '🔇' : '🔊';
      }
      if (code === 'Backquote' && running) {                       // cycle how much of the world behind slice zero is solid
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
      if (netGame) {
        if (S.active && S.active.team === SS.net.team) pendingAlign = w.id + 1;
      } else SS.sim.align_to(S, w);
    });
    $('menubtn').addEventListener('click', openMenu);
    if (SS.audio) {
      $('mutebtn').textContent = SS.audio.muted ? '🔇' : '🔊';
      $('mutebtn').addEventListener('click', () => {
        SS.audio.setMuted(!SS.audio.muted);
        $('mutebtn').textContent = SS.audio.muted ? '🔇' : '🔊';
      });
    }
    // P9: weapon grid clicks, the game-over buttons
    SS.ui.onPick = k => { SS.input.pickWeapon = k; };
    SS.ui.onGear = k => { SS.input.gearReq = k + 1; };            // P89: the HUD's life jacket button
    if (SS.input.attachTouch) SS.input.attachTouch(canvas);           // P24.4 touch pad + gestures
    // PoC mouse: a left press aims + fires on a local human turn with a weapon that is aimed (target weapons and a
    // homing without its target, or shift + click, take the click as a target instead)
    SS.input.mouseFireOk = shift => {
      if (SS.dbgui && SS.dbgui.armed()) return false;                // P49: a click with a debug item armed drops it, it does not fire
      if (!running || menuOpen || !S || S.phase !== 'play' || !S.active || SS.game.is_cpu(S, S.active.team)) return false;
      if (netGame && !SS.net.drives(S.active.team)) return false;
      const d = C.ARSENAL[S.weapon];
      if (!d || d.kind === 'target' || S.weapon === 'girder') return false;
      return !(d.target && (!S.tgt || shift));
    };
    SS.ui.onRematch = () => {
      if (netGame && !SS.net.isHost) return;
      newGame(Object.assign({}, S.settings, { seed: ((S.settings.seed | 0) + 1) % 100000 }));
    };
    SS.ui.onSetup = () => {
      if (netGame && !SS.net.isHost) return;
      openMenu();
    };
    SS.ui.onOnline = () => {
      if (SS.netui) SS.netui.toggle(SS.menu.load());
    };
    SS.menu.onOnline = () => SS.ui.onOnline();
    SS.menu.defaultStart = s => newGame(s);
    // (a failed start: back to a local menu)
    SS.menu.onBack = () => {
      if (netGame && SS.net.active) {
        SS.net.close();
        netGame = false;
      }
    };
    addEventListener('resize', resize);
    // P7: aim helpers
    canvas.addEventListener('mousemove', e => {
      if (SS.armsView) SS.armsView.cursor = { x: e.clientX, y: e.clientY };
    });
    if (innerWidth < 900) $('help').classList.add('hidden');

    /* Deterministic hooks for automated verification. */
    window.POC = {
      S, get W() { return SS.world; }, keys: SS.input.keys, pressed: SS.input.pressed, stats0: stats, keepPaused: false,
      get camera() { return SS.view.camera(); }, get scene() { return SS.view.scene(); }, get renderer() { return SS.view.renderer(); },
      get dpr() { return SS.view.dpr(); }, adaptive: () => adaptOn,
      get ready() { return running && !busy; }, get quality() { return Q && Q.name; },
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
        paused = v;
        this.keepPaused = v;
      },
      replaying: () => RP.play ? { i: RP.play.i, n: RP.play.inputs.length } : null,
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
    // 9b: multiplayer lobby (L) and the hooks the net layer calls
    if (SS.net) {
      // P12: the host starts the match from the lobby (net.start assigns the seats); guests start on 'start'
      SS.net.stepNow = () => S.netStep | 0;
      SS.ui.netStart = settings => {
        if (!SS.net.isHost || !SS.net.active) return;
        netGame = true;
        newGame(Object.assign({}, settings || SS.menu.load(), { cpu: 'off' }));
      };
      SS.net.on('start', st => {
        // (P37: the menu's rule / density keys)
        const ok = {},
          allow = C.setting_keys(C.SF.NET);
        for (const k of allow)
          if (st[k] != null && (typeof st[k] === 'string' || typeof st[k] === 'number' || typeof st[k] === 'boolean')) ok[k] = st[k];
        if (Array.isArray(st.ctl)) ok.ctl = st.ctl.slice(0, 4).map(v => (v === 'cpu' ? 'cpu' : 'human'));
        if (Array.isArray(st.names)) ok.names = st.names.slice(0, 4).map(v => String(v).slice(0, 18));
        // presentation stays the guest's own (a different quality reloads the renderer: it dropped the link mid-match)
        const mine = SS.menu.load() || {}, pres = {};
        // (R10: 'idle' too: render only, a guest who switched the antics off got them back in every online match)
        for (const k of C.setting_keys(C.SF.LOOK))
          if (mine[k] != null) pres[k] = mine[k];
        // (P38 R6 R6: the RUNNING quality: a saved one that differs would reload the page and drop the link)
        pres.quality = Q ? Q.name : mine.quality;
        // P103: a sim-relevant setting the host did not send is the DEFAULT (what the host's sim.begin_reset fills in),
        // never this page's own ?url parameter
        const base = urlSettings();
        for (const k of Object.keys(C.SETTINGS))
          if (PRES.indexOf(k) < 0) base[k] = C.SETTINGS[k];
        netGame = true; newGame(SS.menu.sanitize(Object.assign(base, pres, ok, { cpu: 'off' }), C.SETTINGS));
      });
      SS.net.on('leave', d => {
        if (!netGame) return;
        SS.sim.log(S, `${d.name} disconnected.`, 0xffb080);
        // the host's last guest left: no lockstep any more (the local step path runs), so apply the queued CPU
        // take-over of the departed seats now (stepNet would have, at its step) and go on as a local game
        if (SS.net.isHost && SS.net.peers().length <= 1) {
          for (const c of SS.net.ctl_due(Infinity))
            if (S.teams && S.teams[c.team]) {
              S.teams[c.team].ctl = 'cpu';
              SS.sim.log(S, `${S.teams[c.team].name} left: the CPU plays their worms now.`, 0xffb080);
            }
          netGame = false;
        }
      });
      /* leaving multiplayer for a local game: every seat but my own becomes a CPU team (a left host's / a dropped
       * friend's team must not
       * stay 'human' with nobody to play it) */
      const toLocal = () => {
        const me = SS.net.team;
        if (S.teams)
          for (let i = 0; i < S.teams.length; i++)
            if (i !== me && S.teams[i].ctl !== 'cpu') S.teams[i].ctl = 'cpu';
        netGame = false;
      };
      /* P103: the host is the authority. A guest that sees a hash mismatch asks for the host's snapshot (net.js does it
       * by itself), restores it at
       * the next frame boundary and goes on from the same step. One toast per incident; one banner (with a Resync
       * button) only when the automatic tries fail. Nothing here writes the sim log (S) except through the restore:
       * chat / toasts are DOM only. */
      SS.net.on('desync', d => {
        console.warn('lockstep desync at step', d.k, 'local', d.l, 'remote', d.r, d.name ? 'peer ' + d.name : '');
        if (SS.net.isHost && SS.netui && SS.netui.toast)
          SS.netui.toast((d.name || 'A guest') + ' went out of sync; the host is sending them the state.');
      });
      SS.net.provide = () => (
        S && S.worms ? { k: S.netStep | 0, snap: SS.sim.snapshot(S), fields: SS.netdiag ? SS.netdiag.fields(S) : null } : null
      );
      SS.net.on('resync', d => { pendingResync = d; });
      if (SS.netui)
        SS.netui.canAct = () => !!(
          running
          && !menuOpen
          && S
          && S.phase === 'play'
          && S.active
          && (netGame && SS.net.active ? SS.net.drives(S.active.team) : !SS.game.is_cpu(S, S.active.team))
        );
      SS.net.on('resync_start', d => {
        if (d.tries === 1 && SS.netui && SS.netui.toast) SS.netui.toast('Out of sync: fetching the host\'s state...');
      });
      SS.net.on('resynced', d => {
        console.info('resynced with host', d);
        if (SS.netui) {
          if (SS.netui.toast) SS.netui.toast('Resynced with host');
          if (SS.netui.sys) SS.netui.sys('Resynced with host');
          if (SS.netui.clearBanner) SS.netui.clearBanner();
        }
      });
      SS.net.on('resync_failed', d => {
        if (SS.netui && SS.netui.resyncFailed) SS.netui.resyncFailed(d.incident, () => SS.net.resync_request(), () => {
          SS.net.close();
          toLocal();
        });
      });
      window.POC.resyncDebug = { fields: () => SS.netdiag.fields(S), dump: () => SS.netdiag.dump(S), poke: fn => fn(S) };
      SS.net.on('refused', d => {
        if (SS.netui && SS.netui.refused) SS.netui.refused(d.msg || `${d.name} runs another game build: not allowed in.`);
        if (d.msg) SS.net.close();
      });
      SS.net.on('close', () => {
        if (netGame) SS.sim.log(S, 'Multiplayer: the host left; the game goes on here only (the CPU plays the other teams).', 0xffb080);
        toLocal();
      });
      window.POC.net = {
        get game() { return netGame; },
        stepNet: () => stepNet(),
        flush: () => SS.net.flush(),
        start: st => SS.ui.netStart(st)
      };
    }

    let auto = null;
    try {
      auto = JSON.parse(sessionStorage.getItem(AUTO_KEY) || 'null');
      sessionStorage.removeItem(AUTO_KEY);
    } catch (e) {
      auto = null;
    }
    if (params.has('auto')) auto = urlSettings();
    if (auto) newGame(auto);
    else SS.menu.show(SS.menu.load(), s => newGame(s));

    /* P38-R4 adaptive resolution (platform/quality.js adapt_*): off under automation (navigator.webdriver: tests want a
     * fixed canvas), ?adpr=1 / 0 forces */
    const adaptOn = params.get('adpr') === '1' || (params.get('adpr') !== '0' && !navigator.webdriver);
    let adapt = null, adaptQ = null;
    function adaptDpr(ms, nowS) {
      if (!adaptOn || !Q || menuOpen || busy || document.hidden || ms > 250) return;
      if (adaptQ !== Q) {
        adaptQ = Q;
        adapt = SS.quality.adapt_make(Math.min(Q.dpr, window.devicePixelRatio || 1));
      }
      const r = SS.quality.adapt_frame(adapt, ms, nowS);
      if (r) SS.view.setDpr(r);
    }
    // tscale: slow motion / replay (the effect clocks of the renderer follow it)
    let acc = 0, last = performance.now(), frameErrs = 0, tscale = 1;
    function frame(now) {
      // the next frame is requested first: an exception in one frame is logged (console.error, the tests see it) but
      // never stops the loop (D6: a RangeError in the section builder used to freeze the game for good)
      requestAnimationFrame(frame);
      const rawMs = now - last, dt = Math.min(0.1, Math.max(0, rawMs / 1000));
      last = now;
      try {
        if (SS.audio && SS.audio.hold) SS.audio.hold(paused || menuOpen);
        if (SS.music) SS.music.tick(running && !busy ? S : null, paused ? 'pause' : menuOpen ? 'menu' : null);
        if (pendingResync && running && !busy && netGame && SS.net.active) {
          const d = pendingResync;
          pendingResync = null;
          applyResync(d);
          acc = 0;
        }
        if (running && !busy) {
          if (netGame && SS.net.active) {
            // lockstep: the driver steps in real time; the follower also catches up on queued inputs (<= 60 per frame)
            // (catch-up applies to the follower only: a driver never runs ahead of real time)
            if (!menuOpen) {
              acc += dt;
              let n = 0;
              while (running && n < 60 && (acc >= C.STEP || (!SS.net.drives(S.active ? S.active.team : 0) && SS.net.pending() > 2))) {
                if (!stepNet()) {
                  acc = Math.min(acc, C.STEP);
                  break;
                }
                acc = Math.max(0, acc - C.STEP);
                n++;
              }
              SS.net.flush();
            }
          } else if (!paused && !menuOpen) {
            // (PoC slow motion)
            tscale = RP.play ? (RP.play.slow || 0.5) : S.time < (S.slowUntil || 0) && S.slowUntil - S.time < 1.5 ? 0.35 : 1;
            if (!RP.play && SS.cine) tscale = Math.min(tscale, SS.cine.timeScale());
            acc += dt * tscale;
            while (acc >= C.STEP && running) {
              step();
              acc -= C.STEP;
            }
          }
          else acc = 0;
          if (!paused) {
            SS.view.timeScale = menuOpen ? 1 : tscale;
            SS.view.menuOpen = menuOpen;
            frameRender(dt);
            adaptDpr(rawMs, now / 1000);
          }
        }
      } catch (e) {
        acc = 0;
        if (frameErrs++ < 5) console.error('frame error:', e && e.stack || e);
      }
    }
    requestAnimationFrame(frame);
  }
  boot();
})(window.SS = window.SS || {});
