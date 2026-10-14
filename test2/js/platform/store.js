/* platform/store.js — the player's small persistent values (the menu settings, mute, music volume, the HUD's aim
 * details) and the one-shot slot a quality change carries across its page reload. Every access is guarded: private
 * mode, blocked storage or a page without storage reads as absent and drops the write, and the game goes on with
 * the defaults.
 * C: a key -> string map read from the player's settings file at boot (on Steam: the Steam Cloud file); get / set
 * over it, the session slot a variable that survives the renderer restart. */
(function (SS) {
  'use strict';
  const ST = SS.store = {};
  // the stored string under key, or def when it is absent or storage is unavailable
  ST.get = function (key, def) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? def : v;
    } catch (e) {
      return def;
    }
  };
  ST.set = function (key, v) {
    try {
      localStorage.setItem(key, String(v));
    } catch (e) { /* storage unavailable: the value lasts for this page only */ }
  };
  // a JSON value under key, or def when it is absent, unreadable or not an object
  ST.get_json = function (key, def) {
    try {
      const v = JSON.parse(ST.get(key, 'null'));
      return v && typeof v === 'object' ? v : def;
    } catch (e) {
      return def;
    }
  };
  ST.set_json = (key, v) => ST.set(key, JSON.stringify(v));
  // the session slot: a JSON value kept for the next load of this tab only, read once (take clears it)
  ST.put_session = function (key, v) {
    try {
      sessionStorage.setItem(key, JSON.stringify(v));
    } catch (e) { /* storage unavailable: the reload starts at the menu */ }
  };
  ST.take_session = function (key) {
    try {
      const v = JSON.parse(sessionStorage.getItem(key) || 'null');
      sessionStorage.removeItem(key);
      return v;
    } catch (e) {
      return null;
    }
  };
})(window.SS = window.SS || {});
