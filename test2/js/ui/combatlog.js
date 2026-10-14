/* ui/combatlog.js — the HUD's combat log (S.log). Collapsed: at most --log-n short lines, each fading out after
 * ~7 s (the important ones: deaths, crates, sudden death, the result, stay 12 s); verbose setup and hint lines are
 * dropped. The "log" chip expands the full list (every kept line, wrapped, no fading). Reads the sim state only.
 * C: the engine UI's log list. */
(function (SS) {
  'use strict';
  const C = SS.CFG, D = SS.dom, css = C.css;
  const LG = SS.combatlog = {};
  const $ = id => document.getElementById(id);
  let lastS = null;

  // the important lines (kept 12 s) and the noise (dropped from the collapsed log)
  const LOG_KEEP = new RegExp([
    'sudden death', 'final stand', 'crate', 'win after', 'nobody survived', '\\bdies\\b', '\\bdied\\b', 'killed', 'buried', 'sank',
    'drifted', 'wandered', 'head off', 'escaped', 'infected', 'bursts out', 'collaps', 'streak', 'void', 'explod', 'take over',
    'weather turns', 'moon phase', 'meteor'
  ].join('|'), 'i');
  const LOG_NOISE = new RegExp('^(' + [
    'rope', 'nothing within', 'no terrain', 'cannot drop', 'the line', 'stand on', 'click a target', 'view locked', 'section locked',
    'section aligned', 'debug', 'the parachute opens'
  ].join('|') + ')|' + [
    'section aligned with', 'rotate with', 'on the map: get in', 'ruined buildings', 'on the island', 'a \\d+ m side-on',
    'a crashed derelict', 'magnetic suits', 'no room there'
  ].join('|'), 'i');
  let logOpen = false;
  /* A log line wraps at spaces, like any text. One that needs more than --log-lines lines at the panel's width is cut
   * at a space and ends in an ellipsis: never inside a word. The widths come from a hidden span with the log's own
   * font (cached per text and window size). */
  let logGeom = '', logW = 0, logLines = 2, logMax = 3, measureEl = null;
  const fitCache = new Map();
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) document.fonts.ready.then(() => fitCache.clear());
  function logGeometry(el) {
    const key = innerWidth + 'x' + innerHeight;
    if (key === logGeom) return;
    logGeom = key; fitCache.clear();
    const cs = getComputedStyle(el), col = $('lcol');
    logW = col.clientWidth - 2 - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    logLines = parseInt(cs.getPropertyValue('--log-lines'), 10) || 2;
    logMax = parseInt(cs.getPropertyValue('--log-n'), 10) || 3;
  }
  function textWidth(t, imp) {
    if (!measureEl) {
      measureEl = document.createElement('span');
      $('lcol').appendChild(measureEl);
    }
    measureEl.className = 'lmeasure' + (imp ? ' imp' : '');
    measureEl.textContent = t;
    return measureEl.getBoundingClientRect().width;
  }
  function fitLine(text, imp) {
    if (logW < 60) return text;
    const key = (imp ? 'i' : 'n') + logW + '|' + logLines + '|' + text;
    const hit = fitCache.get(key);
    if (hit !== undefined) return hit;
    const room = logW - 2, space = textWidth('a a', imp) - textWidth('aa', imp), words = text.split(' '), lines = [[]];
    let x = 0;
    for (const w of words) {
      const ww = textWidth(w, imp), cur = lines[lines.length - 1];
      if (cur.length && x + space + ww > room) {
        lines.push([w]);
        x = ww;
      } else {
        cur.push(w);
        x = cur.length > 1 ? x + space + ww : ww;
      }
    }
    let out = text;
    if (lines.length > logLines) {
      const keep = lines.slice(0, logLines), last = keep[keep.length - 1];
      while (last.length > 1 && textWidth(last.join(' ') + '…', imp) > room) last.pop();
      out = keep.map(l => l.join(' ')).join(' ').replace(/[ ,;:.\-–]+$/, '') + '…';
    }
    if (fitCache.size > 400) fitCache.clear();
    fitCache.set(key, out);
    return out;
  }
  function drawLog(S) {
    const el = $('log');
    if (!el) return;
    if (!el._tog) {
      el._tog = 1;
      el.addEventListener('click', e => {
        if (e.target.closest && e.target.closest('.lt')) {
          logOpen = !logOpen;
          if (lastS) drawLog(lastS);
        }
      });
    }
    lastS = S;
    if (!logOpen) logGeometry(el);
    let out = '', n = 0;
    for (const l of S.log) {
      const age = S.time - l.t, imp = LOG_KEEP.test(l.text);
      if (!logOpen) {
        if (LOG_NOISE.test(l.text) && !imp) continue;
        const life = imp ? 12 : 7;
        if (age > life || n >= logMax) continue;
        const op = Math.min(1, Math.max(0, (life - age) / 2.5)), shown = fitLine(l.text, imp);
        const full = shown !== l.text ? ' data-full="' + D.esc(l.text) + '"' : '';
        const style = 'color:' + css(l.rgb) + ';opacity:' + Math.round(op * 20) / 20;
        out += '<div class="' + (imp ? 'imp' : '') + '" style="' + style + '"' + full + '>' + D.esc(shown) + '</div>';
        n++;
      } else out += `<div class="full" style="color:${css(l.rgb)}">${D.esc(l.text)}</div>`;
    }
    el.classList.toggle('quiet', !logOpen && n === 0); el.classList.toggle('open', logOpen);
    D.html(
      el,
      S.log.length
        ? out + `<button type="button" class="lt" title="Show or hide the full event log">${logOpen ? 'hide log' : 'log'}</button>`
        : ''
    );
  }
  LG.draw = S => drawLog(S);
})(window.SS = window.SS || {});
