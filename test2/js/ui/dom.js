/* ui/dom.js — the HUD's DOM helpers. Element builders, HTML escaping (team and chat names come from the network) and
 * setters that write only on change: the HUD and the labels are refreshed every frame, and a write of an unchanged
 * style, class or text still costs the browser a style recalculation or a re-parse. Each setter keeps its last value
 * on the element itself. The label pool reuses world-anchored elements by index (projected, placed and filled by
 * their owner each frame) and hides the ones a frame did not use.
 * C: the engine's UI replaces this file (UI Toolkit / UMG); the pools become world-space widgets. */
(function (SS) {
  'use strict';
  const D = SS.dom = {};
  // a new element: tag, class names, inner HTML (all optional), appended to parent when given
  D.el = function (tag, cls, html, parent) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  };
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  D.esc = t => String(t).replace(/[&<>"]/g, c => ESC[c]);
  // the setters: true when they wrote
  D.text = function (el, s) {
    if (el._tx === s) return false;
    el._tx = s;
    el.textContent = s;
    return true;
  };
  D.html = function (el, s) {
    if (el._hm === s) return false;
    el._hm = s;
    el.innerHTML = s;
    return true;
  };
  D.cls = function (el, s) {
    if (el._cl === s) return false;
    el._cl = s;
    el.className = s;
    return true;
  };
  // one class name on or off
  D.flag = function (el, name, on) {
    const k = '_f' + name;
    if (el[k] === on) return false;
    el[k] = on;
    el.classList.toggle(name, on);
    return true;
  };
  // display: shown as `mode` (default 'block') or 'none'
  D.show = function (el, on, mode) {
    const v = on ? mode || 'block' : 'none';
    if (el._dp === v) return false;
    el._dp = v;
    el.style.display = v;
    return true;
  };
  // one style property (a string value)
  D.style = function (el, prop, v) {
    const k = '_s' + prop;
    if (el[k] === v) return false;
    el[k] = v;
    el.style[prop] = v;
    return true;
  };
  /* a label at the screen point (x, y), rounded to whole pixels, its anchor `at` an extra translate (above the point:
   * D.ABOVE, below it: D.BELOW, centred on it: D.CENTER) */
  D.ABOVE = 'translate(-50%,-100%)';
  D.BELOW = 'translate(-50%,6px)';
  D.CENTER = 'translate(-50%,-50%)';
  D.place = (el, x, y, at) => D.style(el, 'transform', `translate(${Math.round(x)}px,${Math.round(y)}px) ${at}`);
  /* the HUD unit in px (the CSS --u: 1 in a 1280 x 720 window), measured by a hidden stick of width var(--u) and
   * kept current on resize: label spacings follow the size of the labels */
  let uPx = 1, uStick = null;
  const readUnit = () => { uPx = uStick.getBoundingClientRect().width || 1; };
  D.unit = function () {
    if (!uStick) {
      uStick = D.el('i', '', null, document.body);
      uStick.id = 'ustick';
      uStick.style.cssText = 'position:fixed;left:-99px;top:0;width:var(--u);height:1px;visibility:hidden;pointer-events:none';
      readUnit();
      addEventListener('resize', readUnit);
    }
    return uPx;
  };
  /* the client size of the view's canvas { w, h }, read once and on resize / orientation change (a read of clientWidth
   * after the frame's DOM writes forces a layout: once per frame per reader was measurable) */
  const VS = { w: 0, h: 0 };
  let vsEl = null;
  const readSize = () => {
    VS.w = vsEl.clientWidth;
    VS.h = vsEl.clientHeight;
  };
  D.view_size = function (el) {
    if (vsEl !== el) {
      if (!vsEl) {
        addEventListener('resize', () => vsEl && readSize());
        addEventListener('orientationchange', () => vsEl && readSize());
      }
      vsEl = el;
      readSize();
    }
    return VS;
  };
  /* a pool of like elements under parent (class cls, inner HTML html): at(i) gives the i-th (made on first use),
   * end(n) hides the ones from n on; the owner shows and fills the ones it uses each frame */
  D.pool = function (parent, cls, html) {
    const els = [];
    return {
      at(i) {
        return els[i] || (els[i] = D.el('div', cls, html, parent));
      },
      end(n) {
        for (let i = n; i < els.length; i++) D.show(els[i], false);
      },
      all: () => els
    };
  };
})(window.SS = window.SS || {});
