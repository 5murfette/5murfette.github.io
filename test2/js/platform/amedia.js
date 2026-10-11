/* platform/amedia.js — P54: gesture-safe media element pool. Safari (and every browser with a strict autoplay policy) lets
 * HTMLMediaElement.play() succeed only for elements that were started once inside a user gesture (or when called inside one);
 * an Audio created later from the game loop gets NotAllowedError and stays silent. So the first gesture creates a pool of
 * elements and starts every one of them on a tiny silent clip (unlocking it for good); every later sound and music layer
 * borrows an element from this pool and swaps its src (never new Audio() outside a gesture).
 * API: unlock() (call inside a gesture handler, idempotent, retries while no element got through), gestured, acquire(src, opts) ->
 * element or null, release(el), warn(reason, detail), stat (counters for tools/dev/audiotest.cjs), status().
 * Presentation only; Math.random / wall clock are fine here, nothing touches js/sim. */
(function (SS) {
  'use strict';
  const AM = SS.amedia = {};
  const N = 40;
  const pool = [];
  const stat = AM.stat = { plays: 0, playing: 0, rejected: 0, errors: 0, unlocked: 0, buf_started: 0, buf_failed: 0, last_error: '', warned: {} };
  AM.gestured = false;
  // 0.1 s of silence as an 8-bit mono wav data URI (the clip that unlocks an element)
  function silent_uri() {
    const n = 800, b = new Uint8Array(44 + n), v = new DataView(b.buffer);
    const s = (o, t) => { for (let i = 0; i < t.length; i++) b[o + i] = t.charCodeAt(i); };
    s(0, 'RIFF'); v.setUint32(4, 36 + n, true); s(8, 'WAVE'); s(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); s(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) b[44 + i] = 128;
    let bin = ''; for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
    return 'data:audio/wav;base64,' + btoa(bin);
  }
  let SILENT = '';
  AM.warn = function (reason, detail) {
    stat.last_error = reason + (detail ? ': ' + detail : '');
    if (stat.warned[reason]) return;
    stat.warned[reason] = true;
    try { console.warn('[audio] ' + stat.last_error); } catch (e) { /* no console */ }
  };
  function is_silent(el) { return el.src === SILENT || String(el.src).slice(0, 10) === 'data:audio'; }
  function make_slot() {
    const el = new Audio(); el.preload = 'auto';
    const slot = { el, busy: 0, ok: false, pending: false, onerror: null, onended: null };
    el.addEventListener('playing', () => { if (!is_silent(el)) stat.playing++; });
    el.addEventListener('ended', () => { if (slot.onended) slot.onended(); if (!slot.keep) slot.busy = 0; });
    el.addEventListener('error', () => {
      if (is_silent(el) || !el.getAttribute('src')) return;
      stat.errors++; AM.warn('media error', (el.error && el.error.code) + ' ' + String(el.src).slice(-40));
      if (slot.onerror) slot.onerror();
      if (!slot.keep) slot.busy = 0;
    });
    el._slot = slot; return slot;
  }
  function try_unlock(slot) {
    const el = slot.el; let p;
    if (slot.pending) return;
    slot.pending = true;
    try { el.src = SILENT; el.volume = 1; el.muted = false; p = el.play(); } catch (e) { AM.warn('unlock play threw', String(e)); return; }
    const done = () => { slot.pending = false; if (slot.busy) return; if (!slot.ok) { slot.ok = true; stat.unlocked++; } try { el.pause(); } catch (e) { /* */ } };
    if (p && p.then) p.then(done, e => { slot.pending = false; if (e && e.name === 'NotAllowedError') { stat.rejected++; AM.warn('unlock rejected', e.name); } }); else done();
  }
  AM.unlock = function () {
    AM.gestured = true;
    if (typeof Audio === 'undefined') return;
    try {
      if (!SILENT) SILENT = silent_uri();
      if (!pool.length) for (let i = 0; i < N; i++) pool.push(make_slot());
      for (const s of pool) if (!s.ok && !s.busy && !s.pending) try_unlock(s);
    } catch (e) { AM.warn('unlock failed', String(e)); }
  };
  // a free element with src set (volume 0, not looping); null if none is free. opts: { onerror, onended, keep }
  AM.acquire = function (src, opts) {
    if (!AM.gestured || !pool.length) return null;
    const t = Date.now();
    let slot = null;
    for (const s of pool) if (!s.busy || t - s.busy > 60000) { slot = s; if (s.ok) break; }
    if (!slot) { AM.warn('pool exhausted'); return null; }
    const el = slot.el;
    slot.pending = false; slot.busy = t; slot.keep = !!(opts && opts.keep); slot.onerror = (opts && opts.onerror) || null; slot.onended = (opts && opts.onended) || null;
    try { el.pause(); el.loop = false; el.volume = 0; el.playbackRate = 1; el.src = src; } catch (e) { slot.busy = 0; return null; }
    return el;
  };
  AM.release = function (el) {
    const s = el && el._slot; if (!s) return;
    s.busy = 0; s.keep = false; s.onerror = s.onended = null;
    try { el.pause(); el.src = SILENT; } catch (e) { /* */ }
  };
  // play an acquired element: counts it, releases it again when the browser refuses
  AM.play = function (el) {
    stat.plays++;
    let p; try { p = el.play(); } catch (e) { AM.warn('play threw', String(e)); AM.release(el); return false; }
    if (p && p.catch) p.catch(e => { stat.rejected++; AM.warn('play rejected', (e && e.name) + ' ' + (e && e.message)); if (e && e.name === 'NotAllowedError') AM.gestured = false; if (!(el._slot && el._slot.keep)) AM.release(el); });
    return true;
  };
  AM.status = () => ({ gestured: AM.gestured, pool: pool.length, free: pool.filter(s => !s.busy).length, unlocked: stat.unlocked, plays: stat.plays, playing: stat.playing, rejected: stat.rejected, errors: stat.errors, last_error: stat.last_error });
  if (typeof addEventListener === 'function') for (const ev of ['pointerdown', 'keydown', 'touchend', 'click', 'mousedown']) addEventListener(ev, AM.unlock, { capture: true });
})(typeof window !== 'undefined' ? (window.SS = window.SS || {}) : (globalThis.SS = globalThis.SS || {}));
