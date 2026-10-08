/* platform/input.js — browser keyboard/mouse → sim Input struct.
 * Replace this file when porting (Unity Input System, SDL events...). */
(function (SS) {
  'use strict';
  const I = SS.input = {};
  I.keys = new Set();      // held key codes
  I.pressed = new Set();   // edge-triggered key codes since last step
  I.mouseRot = 0;          // accumulated right-drag rotation (pixels * gain)
  I.wheel = 0;
  I.panX = 0; I.panY = 0;  // accumulated left-drag (pixels): camera pan, or orbit while inspecting (view only)
  I.panReset = false;
  I.clicks = [];           // P9: left clicks without a drag (client x, y): targets on the section
  I.pickWeapon = '';       // P9: a weapon chosen on the weapon grid (consumed by the next sample)
  /* PoC mouse aim (aimAt / pointerdown / pointermove): the cursor aims the active worm (the shot line runs through it,
   * the worm turns to it), a left press aims + starts the shot, holding charges, releasing fires. The mouse aims only
   * when really used for it: not while a keyboard shot charges, not for nudges within 40 px after aiming with the keys,
   * not parked at a screen edge (10 %). main.js sets mouseFireOk(shift) = a local human turn with an aimable weapon;
   * otherwise a left drag pans the camera as before. The result goes through the lockstep input (aimset / aimv / face). */
  I.mx = 0; I.my = 0; I.mouseIn = false; I.held = false; I.aimReq = false; I.mfire = false; I.mfirePressed = false; I.kbLock = null; I.mouseFireOk = null;
  /* P9: weapon hotkeys from the PoC (sim/arsenal.js `key`), on key codes; poc5's own keys that clashed moved:
   * help F1 / ?, slice view `, recentre Home, end turn = Skip Go (K), new map = the menu, lobby = the menu button */
  const CODE = k => (/^[0-9]$/.test(k) ? 'Digit' + k : k === '-' ? 'Minus' : 'Key' + k);
  let WKEY = null;
  const wkeys = () => { if (!WKEY) { WKEY = {}; const A = SS.CFG.ARSENAL; for (const k in A) WKEY[CODE(A[k].key)] = k; } return WKEY; };

  const HANDLED = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Enter']);
  I.attach = function (canvas, onKey) {
    addEventListener('keydown', e => {
      if (e.target && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) return;
      if (HANDLED.has(e.code)) e.preventDefault();
      if (!e.repeat) { I.pressed.add(e.code); if (onKey) onKey(e.code); }
      I.keys.add(e.code);
    });
    addEventListener('keyup', e => I.keys.delete(e.code));
    addEventListener('blur', () => I.keys.clear());
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    let drag = false, pan = false, down = null;
    canvas.addEventListener('mousedown', e => {
      I.mx = e.clientX; I.my = e.clientY;
      if (e.button === 0 && I.mouseFireOk && I.mouseFireOk(e.shiftKey)) { I.mfire = true; I.mfirePressed = true; I.aimReq = true; I.kbLock = null; return; }
      if (e.button === 2) drag = true; if (e.button === 0 || e.button === 1) pan = true; if (e.button === 0) down = { x: e.clientX, y: e.clientY };
    });
    addEventListener('mouseup', e => {
      drag = false; pan = false; I.held = false;
      if (e.button === 0 && I.mfire) { I.mfire = false; down = null; return; }                 // release = fire (PoC releaseFire)
      if (e.button === 0 && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) I.clicks.push({ x: e.clientX, y: e.clientY, shift: e.shiftKey });
      down = null;
    });
    addEventListener('mousemove', e => {
      if (drag) I.mouseRot += e.movementX * 0.6; if (pan) { I.panX += e.movementX; I.panY += e.movementY; }
      I.mx = e.clientX; I.my = e.clientY; I.mouseIn = e.target === canvas; I.held = drag || pan;
      if (drag || pan || e.target !== canvas) return;
      if (I.kbLock && Math.hypot(e.clientX - I.kbLock.x, e.clientY - I.kbLock.y) < 40) return;
      I.kbLock = null;
      const ex = innerWidth * 0.1, ey = innerHeight * 0.1;
      if (!I.mfire && (e.clientX < ex || e.clientX > innerWidth - ex || e.clientY < ey || e.clientY > innerHeight - ey)) return;
      I.aimReq = true;
    });
    canvas.addEventListener('dblclick', () => { I.panReset = true; });
    canvas.addEventListener('mouseleave', () => { I.mouseIn = false; });
    addEventListener('mouseout', e => { if (!e.relatedTarget) I.mouseIn = false; });
    canvas.addEventListener('wheel', e => { e.preventDefault(); I.wheel += e.deltaY > 0 ? 1 : -1; }, { passive: false });
  };

  /* P24.4 touch (PoC #touch pad + pointer handling): the pad's buttons hold / press the same key codes as the keyboard
   * (FIRE held = Space held: charge; JUMP = Enter: also drops a payload on the rope); 🎒 opens / closes the weapon grid,
   * 🔍 toggles near / far zoom, ⇄ = Tab. On the canvas: one finger aims (like the mouse) and a quick tap is a click (a
   * target for target weapons); two fingers pinch to zoom and drag to pan. */
  I.attachTouch = function (canvas) {
    const pad = document.getElementById('touch'); if (!pad) return;
    const on = () => { if (!document.body.classList.contains('touch')) { document.body.classList.add('touch'); const w = document.getElementById('weapons'); if (w) w.classList.add('closed'); } };
    if (window.matchMedia && matchMedia('(pointer: coarse)').matches) on();
    addEventListener('touchstart', on, { passive: true });
    for (const btn of pad.querySelectorAll('button[data-k]')) {
      const k = btn.dataset.k;
      const down = e => {
        e.preventDefault(); btn.classList.add('on');
        if (k === 'weapons') { const w = document.getElementById('weapons'); if (w) w.classList.toggle('closed'); return; }
        if (k === 'zoom') { I.wheel += I.zoomedOut ? -6 : 6; I.zoomedOut = !I.zoomedOut; return; }
        I.pressed.add(k); I.keys.add(k);
      };
      const up = e => { e.preventDefault(); btn.classList.remove('on'); if (k !== 'weapons' && k !== 'zoom') I.keys.delete(k); };
      btn.addEventListener('pointerdown', down); btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up); btn.addEventListener('pointerleave', up);
    }
    // the weapon grid closes again after a pick on a touch device
    const wg = document.getElementById('weapons'); if (wg) wg.addEventListener('click', () => { if (document.body.classList.contains('touch')) setTimeout(() => wg.classList.add('closed'), 120); });
    const pts = new Map(); let pinch = null, tap = null;
    canvas.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      on(); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; tap = null; return; }
      tap = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      I.mx = e.clientX; I.my = e.clientY; I.mouseIn = false; I.aimReq = true; I.kbLock = null;
    });
    canvas.addEventListener('pointermove', e => {
      if (e.pointerType !== 'touch' || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        if (d / pinch.d > 1.15) { I.wheel -= 1; pinch.d = d; } else if (d / pinch.d < 0.87) { I.wheel += 1; pinch.d = d; }
        I.panX += mx - pinch.mx; I.panY += my - pinch.my; pinch.mx = mx; pinch.my = my;
        return;
      }
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap.moved = true;
      I.mx = e.clientX; I.my = e.clientY; I.aimReq = true;                          // a finger drag aims
    });
    const end = e => {
      if (e.pointerType !== 'touch') return;
      pts.delete(e.pointerId); if (pts.size < 2) pinch = null;
      if (tap && !tap.moved && performance.now() - tap.t < 350 && e.type === 'pointerup') I.clicks.push({ x: tap.x, y: tap.y, shift: false });   // a tap = a click (targets)
      if (!pts.size) tap = null;
    };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    canvas.style.touchAction = 'none';
    canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });   // no emulated mouse events (a tap must not 'click-fire')
  };
  /* Fill a sim Input from the current device state. Edge triggers are consumed by end_step(). */
  // S (optional): the state, for keys whose meaning depends on the selected weapon (strike side, girder angle, fuse,
  // rope payload); target: optional {s, y, fire} from a click on the section (main.js maps the click to the plane)
  I.sample = function (inp, S, target) {
    const k = I.keys, p = I.pressed, A = SS.CFG.ARSENAL;
    const shift = k.has('ShiftLeft') || k.has('ShiftRight');
    const wd = S && A[S.weapon] || {}, strike = !!wd.strike, girder = S && S.weapon === 'girder';
    const left = k.has('KeyA') || k.has('ArrowLeft'), right = k.has('KeyD') || k.has('ArrowRight');
    // PoC: with a plane strike selected, the arrows (and , .) choose the side it comes from instead of walking
    const arrowsL = p.has('ArrowLeft') || p.has('Comma'), arrowsR = p.has('ArrowRight') || p.has('Period');
    inp.sdir = strike ? (arrowsL ? -1 : arrowsR ? 1 : 0) : 0;
    inp.move = strike ? ((k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0)) : (right ? 1 : 0) - (left ? 1 : 0);
    // the girder turns in 22.5° steps on the up / down keys
    inp.gang = girder ? ((p.has('KeyW') || p.has('ArrowUp')) ? 1 : (p.has('KeyS') || p.has('ArrowDown')) ? -1 : 0) : 0;
    inp.up = !girder && (k.has('KeyW') || k.has('ArrowUp')) ? 1 : 0;
    inp.down = !girder && (k.has('KeyS') || k.has('ArrowDown')) ? 1 : 0;
    // Enter on the rope drops the selected payload weapon, else it jumps
    const ropeDrop = S && S.rope && wd.payload;
    inp.drop = ropeDrop && p.has('Enter') ? 1 : 0;
    inp.jump = !ropeDrop && p.has('Enter') ? 1 : 0;
    inp.backflip = p.has('Backspace') ? 1 : 0;
    inp.fire_pressed = p.has('Space') || I.mfirePressed ? 1 : 0;
    inp.fire_held = k.has('Space') || I.mfire ? 1 : 0;
    // mouse aim: from the worm's centre (the shots leave along the aim from there) through the cursor on the section
    inp.aimset = 0; inp.aimv = 0; inp.face = 0;
    if (inp.up || inp.down) I.kbLock = { x: I.mx, y: I.my };
    if (I.aimReq && S && S.active && S.phase === 'play' && !(S.charging && !I.mfire) && SS.view && SS.view.pickPlane) {
      const c = SS.view.pickPlane(S, I.mx, I.my), a = S.active;
      if (c) {
        const ds = c.s - SS.plane.to_plane(S, a.pos).s, dy = c.y - a.pos.y;
        if (Math.hypot(ds, dy) >= 0.39) {                                      // PoC: not within 6 px of the worm
          inp.aimset = 1; inp.aimv = Math.atan2(dy, Math.abs(ds));
          inp.face = Math.abs(ds) > 0.064 ? (ds > 0 ? 1 : -1) : 0;
        }
      }
    }
    let wkey = ''; const wk = wkeys(); for (const c of p) if (wk[c]) wkey = wk[c];
    if (I.pickWeapon) { wkey = I.pickWeapon; I.pickWeapon = ''; }
    // P24.11 (PoC Q / E / Tab cycle; here [ and ]: Q / E turn the section): previous / next weapon that has ammo
    if (!wkey && S && S.active && S.teams && (p.has('BracketLeft') || p.has('BracketRight'))) {
      const order = SS.CFG.ARSENAL_ORDER.filter(k => k !== 'skip'), am = S.teams[S.active.team].ammo, dir = p.has('BracketRight') ? 1 : -1;
      let i = Math.max(0, order.indexOf(S.weapon));
      for (let n = 0; n < order.length; n++) { i = (i + dir + order.length) % order.length; if (am[order[i]] > 0 || am[order[i]] === Infinity) { wkey = order[i]; break; } }
    }
    inp.weapon = wkey;
    inp.fuse = p.has('KeyF') && S ? (S.fuse % 5) + 1 : 0;                  // PoC: F cycles the fuse 1-5 s
    inp.rotate = (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0);
    inp.rotate_mouse = I.mouseRot;
    inp.fine = shift ? 1 : 0;
    // PoC worm select: Tab hands the turn to the next worm while that is allowed, else it aligns the section
    const wsel = p.has('Tab') && !shift && S && SS.sim.can_switch && SS.sim.can_switch(S);
    inp.wsel = wsel ? 1 : 0;
    inp.align_step = p.has('Tab') && !wsel ? (shift ? -1 : 1) : 0;
    inp.align_refocus = 0;
    inp.end_turn = 0;
    inp.reset = 0;
    inp.inspect = k.has('KeyV') ? 1 : 0;
    inp.tgt = 0; inp.ts = 0; inp.ty = 0;
    if (target) { inp.tgt = 1; inp.ts = target.s; inp.ty = target.y; if (target.fire) inp.fire_pressed = 1; }
    return inp;
  };
  I.end_step = function () { I.pressed.clear(); I.mouseRot = 0; I.aimReq = false; I.mfirePressed = false; };
})(window.SS = window.SS || {});
