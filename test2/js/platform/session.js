/* platform/session.js — the game side of a net match (platform/net.js runs the lockstep, the links and the resync
 * transfer). It steps a lockstep match: the seat that drives the active team samples and sends its input, a
 * follower plays the received inputs in order and waits for the next. It hands the CPU a seat whose player left, at
 * the step the host fixed (identical on every peer). After a desync it loads the host's state at a frame boundary. It
 * turns the net events into log lines, toasts and the move back to a local game.
 * C: struct NetSession { u8 on; i32 align; Resync *pending; }; session_step, session_apply_resync. */
(function (SS) {
  'use strict';
  const C = SS.CFG, PHASE = C.PHASE, SN = SS.session = {};
  // presentation settings stay this player's own: across a resync and in a guest's match
  const LOOK = C.setting_keys(C.SF.LOOK);
  // a follower plays the queued inputs in one frame while more than BEHIND wait (at most CATCH_UP per frame, loop.js)
  const BEHIND = 2, NOTE = 0xffb080;
  const inpR = SS.sim.input_make();
  let A = null, H = null, S = null, on = false, align = 0, resync = null;
  // in a net match (set when it starts, cleared when it goes back to a local game)
  SN.game = () => on;
  // the lockstep runs: a net match with its links up
  SN.lockstep = () => on && SS.net.active;
  // a follower that has more than BEHIND received inputs waiting plays them at once
  SN.behind = () => !SS.net.drives(S.active ? S.active.team : 0) && SS.net.pending() > BEHIND;
  // a top-map click travels in the lockstep input (align_id), on this player's own turn only
  SN.align = w => {
    if (S.active && S.active.team === SS.net.team) align = w.id + 1;
  };
  // a failed start: back to a local menu, the links closed
  SN.cancel = () => {
    if (on && SS.net.active) {
      SS.net.close();
      on = false;
    }
  };
  // the CPU takes over a seat whose player left
  function cpuTakesOver(team) {
    const t = SS.game.set_ctl(S, team, 'cpu');
    if (t) SS.sim.log(S, `${t.name} left: the CPU plays their worms now.`, NOTE);
  }
  // leaving multiplayer for a local game: every seat but this player's own becomes a CPU team (a left host's or a
  // dropped friend's team must not stay 'human' with nobody to play it)
  function toLocal() {
    if (S.teams)
      for (let i = 0; i < S.teams.length; i++)
        if (i !== SS.net.team) SS.game.set_ctl(S, i, 'cpu');
    on = false;
  }

  /* one lockstep step; false = waiting (the driver's input has not come, or the host started the next map) */
  SN.step = function () {
    const NT = SS.net, k = S.netStep | 0, inp = A.inp;
    for (const c of NT.ctl_due(k)) cpuTakesOver(c.team);
    const drv = S.active ? S.active.team : 0;
    if (NT.drives(drv) || (S.phase === PHASE.OVER && NT.isHost)) {
      SS.input.sample(inp, S, H.click_target());
      // the host's next map (sent to the guests)
      if (inp.reset) {
        inp.reset = 0;
        SS.input.end_step();
        if (NT.isHost && S.phase === PHASE.OVER) H.new_game(S.settings);
        return false;
      }
    }
    let use;
    // after a resync the driver plays again its own inputs it had already sent (never sampled again, never re-sent)
    const rpl = NT.drives(drv) ? NT.takeReplay(k) : null;
    if (rpl) {
      SS.input.sample(inp, S, null);
      SS.input.clicks.length = 0;
      use = NT.unpack(rpl, inpR);
    } else if (NT.drives(drv)) {
      if (align) {
        inp.align_id = align;
        align = 0;
      }
      NT.queueInput(k, NT.pack(inp));
      use = inp;
    } else {
      // a follower: its own clicks and weapon picks are dropped (a stale click fired a target weapon at the start of
      // its own turn)
      const a = NT.takeInput(k);
      if (!a) {
        if (NT.isHost) {
          const nm = NT.stalled(drv, k, performance.now());
          if (nm) SS.sim.log(S, `${nm} is not responding: the CPU takes over their worms.`, NOTE);
        }
        return false;
      }
      SS.input.sample(inp, S, null);
      SS.input.clicks.length = 0;
      use = NT.unpack(a, inpR);
    }
    SS.sim.step(S, use, C.STEP);
    SS.input.end_step();
    use.align_id = 0;
    S.netStep = k + 1;
    if (NT.due(S.netStep)) NT.hash(S.netStep, SS.sim.hash(S));
    return true;
  };

  /* the host's state for a resync, loaded at a frame boundary: this player's presentation settings kept, the fields
   * that differed logged when the guest is at the host's step, the lockstep re-armed from that step. true = loaded
   * (the frame loop restarts its clock). */
  SN.apply_resync = function () {
    if (!resync || !A.running || A.busy || !SN.lockstep()) return false;
    const NT = SS.net, d = resync, mine = {};
    resync = null;
    for (const k of LOOK)
      if (S.settings && S.settings[k] !== undefined) mine[k] = S.settings[k];
    if (d.fields && SS.netdiag && (S.netStep | 0) === d.k) {
      const diff = SS.netdiag.diff(SS.netdiag.fields(S), d.fields).filter(k => k !== 'settings');
      console.warn('resync: fields that differed from the host at step ' + d.k + ':', diff.join(', ') || '(none: only derived data)');
      NT.lastDiff = diff;
    }
    SS.sim.restore(S, d.snap);
    for (const k of LOOK)
      if (mine[k] !== undefined) S.settings[k] = mine[k];
    H.refresh();
    S.events.length = 0;
    S.sectionDirty = true;
    NT.resync_applied(S.netStep | 0, d);
    return true;
  };

  /* app: main.js's app record (S, inp, running, menuOpen, busy, quality); hooks: new_game(settings),
   * click_target(), url_settings(), refresh() */
  SN.init = function (app, hooks) {
    A = app;
    H = hooks;
    S = app.S;
    const NT = SS.net;
    if (!NT) return;
    NT.stepNow = () => S.netStep | 0;
    // the host's state at its current step, for a guest's resync
    NT.provide = () => (S.worms ? { k: S.netStep | 0, snap: SS.sim.snapshot(S), fields: SS.netdiag ? SS.netdiag.fields(S) : null } : null);
    // the host starts the match from the lobby (net.start assigns the seats); the guests start on 'start'
    SS.ui.netStart = settings => {
      if (!NT.isHost || !NT.active) return;
      on = true;
      H.new_game(Object.assign({}, settings || SS.menu.load(), { cpu: 'off' }));
    };
    NT.on('start', st => {
      // a guest takes exactly the NET rows of the host's settings (plain values) and its seats and names
      const ok = {};
      for (const k of C.setting_keys(C.SF.NET))
        if (st[k] != null && (typeof st[k] === 'string' || typeof st[k] === 'number' || typeof st[k] === 'boolean')) ok[k] = st[k];
      if (Array.isArray(st.ctl)) ok.ctl = st.ctl.slice(0, 4).map(v => (v === 'cpu' ? 'cpu' : 'human'));
      if (Array.isArray(st.names)) ok.names = st.names.slice(0, 4).map(v => String(v).slice(0, 18));
      // its own LOOK rows, with the RUNNING quality (a saved one that differs would reload the page and drop the link)
      const saved = SS.menu.load() || {}, pres = {};
      for (const k of LOOK)
        if (saved[k] != null) pres[k] = saved[k];
      pres.quality = A.quality ? A.quality.name : saved.quality;
      // a sim setting the host did not send is the default (what the host's sim.begin_reset fills in), never this
      // page's own URL parameter
      const base = H.url_settings();
      for (const k of Object.keys(C.SETTINGS))
        if (LOOK.indexOf(k) < 0) base[k] = C.SETTINGS[k];
      on = true;
      H.new_game(SS.menu.sanitize(Object.assign(base, pres, ok, { cpu: 'off' }), C.SETTINGS));
    });
    NT.on('leave', d => {
      if (!on) return;
      SS.sim.log(S, `${d.name} disconnected.`, NOTE);
      // the host's last guest left: no lockstep any more (the local step path runs), so the queued CPU take-over of
      // the departed seats applies now (SN.step would have, at its step) and the game goes on as a local one
      if (NT.isHost && NT.peers().length <= 1) {
        for (const c of NT.ctl_due(Infinity)) cpuTakesOver(c.team);
        on = false;
      }
    });
    /* the host is the authority: a guest that sees a hash mismatch asks for the host's state (net.js does it by
     * itself) and loads it at the next frame boundary (SN.apply_resync). One toast per incident; one banner (with a
     * Resync button) only when the automatic tries fail. Chat and toasts are DOM only: nothing here writes S. */
    NT.on('desync', d => {
      console.warn('lockstep desync at step', d.k, 'local', d.l, 'remote', d.r, d.name ? 'peer ' + d.name : '');
      if (NT.isHost && SS.netui && SS.netui.toast)
        SS.netui.toast((d.name || 'A guest') + ' went out of sync; the host is sending them the state.');
    });
    NT.on('resync', d => { resync = d; });
    NT.on('resync_start', d => {
      if (d.tries === 1 && SS.netui && SS.netui.toast) SS.netui.toast('Out of sync: fetching the host\'s state...');
    });
    NT.on('resynced', d => {
      console.info('resynced with host', d);
      if (SS.netui) {
        if (SS.netui.toast) SS.netui.toast('Resynced with host');
        if (SS.netui.sys) SS.netui.sys('Resynced with host');
        if (SS.netui.clearBanner) SS.netui.clearBanner();
      }
    });
    NT.on('resync_failed', d => {
      if (SS.netui && SS.netui.resyncFailed) SS.netui.resyncFailed(d.incident, () => NT.resync_request(), () => {
        NT.close();
        toLocal();
      });
    });
    NT.on('refused', d => {
      if (SS.netui && SS.netui.refused) SS.netui.refused(d.msg || `${d.name} runs another game build: not allowed in.`);
      if (d.msg) NT.close();
    });
    NT.on('close', () => {
      if (on) SS.sim.log(S, 'Multiplayer: the host left; the game goes on here only (the CPU plays the other teams).', NOTE);
      toLocal();
    });
    if (SS.netui)
      SS.netui.canAct = () => !!(
        A.running
        && !A.menuOpen
        && S.phase === PHASE.PLAY
        && S.active
        && (SN.lockstep() ? NT.drives(S.active.team) : !SS.game.is_cpu(S, S.active.team))
      );
  };
})(window.SS = window.SS || {});
