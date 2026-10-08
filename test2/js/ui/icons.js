/* ui/icons.js — the PoC's procedural vector weapon icons (inline SVG paths, currentColor), used when the setup
 * "Artwork" option is "procedural" (the painted icons are assets/icons/icon-<key>.webp). Copied from the PoC IC table. */
(function (SS) {
  'use strict';
  SS.icons = {
  bat: '<path d="M4 19l2 2 13-12c1.6-1.5 2-3.6.8-4.8S16.5 4 15 5.6z" fill="currentColor"/><circle cx="4.2" cy="20" r="1.6" fill="currentColor"/>',
  bazooka: '<path d="M2 14h15l3-2v-1l-3-2H2z" fill="currentColor"/><path d="M7 14v4M11 14v3" stroke="currentColor" stroke-width="2"/>',
  grenade: '<circle cx="12" cy="14" r="6.5" fill="currentColor"/><path d="M10 7h4v3h-4zM14 8l4-3" stroke="currentColor" stroke-width="2" fill="none"/>',
  cluster: '<circle cx="12" cy="12" r="7" fill="currentColor"/><circle cx="9" cy="10" r="1.6" fill="#151d23"/><circle cx="15" cy="11" r="1.6" fill="#151d23"/><circle cx="12" cy="15.5" r="1.6" fill="#151d23"/>',
  shotgun: '<path d="M2 11h17v3H9l-2 4H4l1-4H2z" fill="currentColor"/><path d="M19 12h3" stroke="currentColor" stroke-width="2"/>',
  homing: '<path d="M3 19c4-10 10-13 16-13" stroke="currentColor" stroke-width="2.4" fill="none" stroke-dasharray="3 2"/><path d="M15 3l6 3-4 5z" fill="currentColor"/>',
  dynamite: '<rect x="7" y="8" width="7" height="13" rx="1.5" fill="currentColor"/><path d="M10.5 8c0-3 3-4 5-3" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="17" cy="4" r="2" fill="#ffb02e"/>',
  banana: '<path d="M4 6c1 9 7 14 16 12-7-1-11-6-12-12z" fill="currentColor"/>',
  airstrike: '<path d="M2 12l8-1 4-7h2l-2 7 6-1 2-3h1l-1 4 1 4h-1l-2-3-6-1 2 7h-2l-4-7-8-1z" fill="currentColor"/>',
  holy: '<circle cx="12" cy="15" r="6.5" fill="currentColor"/><path d="M12 2v7M9 4.5h6" stroke="currentColor" stroke-width="2"/>',
  sheep: '<path d="M6 16a4 4 0 0 1 1-8 5 5 0 0 1 9 0 4 4 0 0 1 1 8z" fill="currentColor"/><circle cx="19" cy="11" r="2.6" fill="currentColor"/><path d="M8 16v4M14 16v4" stroke="currentColor" stroke-width="2"/>',
  boulder: '<path d="M5 18l-2-6 4-6 7-2 6 4 1 7-5 4z" fill="currentColor"/><path d="M8 9l3 3M14 8l1 4" stroke="#151d23" stroke-width="1.4"/>',
  blackhole: '<circle cx="12" cy="12" r="4" fill="currentColor"/><ellipse cx="12" cy="12" rx="10" ry="4" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  tesla: '<path d="M13 2L5 14h6l-2 8 9-13h-6z" fill="currentColor"/>',
  napalm: '<path d="M12 3c3 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-7 1 2 2 3 3 3 0-3-1-5 0-7z" fill="currentColor"/>',
  moai: '<path d="M7 21V9l2-6h6l2 6v12z" fill="currentColor"/><path d="M9 10h6M11 12v4h2" stroke="#151d23" stroke-width="1.6" fill="none"/>',
  mine: '<ellipse cx="12" cy="15" rx="8" ry="4.5" fill="currentColor"/><circle cx="12" cy="10" r="2" fill="#ff5b4f"/>',
  drill: '<rect x="8" y="2" width="8" height="9" rx="1" fill="currentColor"/><path d="M12 11l-2 3 2 3-2 3 2 2 2-2-2-3 2-3z" fill="currentColor"/>',
  rope: '<path d="M4 21C8 14 14 10 18 5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M15 3l6 0-2 6z" fill="currentColor"/>',
  teleport: '<path d="M12 2l2 7 7 3-7 3-2 7-2-7-7-3 7-3z" fill="currentColor"/>',
  girder: '<path d="M2 8h20v3H2zM2 13h20v3H2z" fill="currentColor"/><path d="M5 11l3 2 3-2 3 2 3-2 3 2" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  skip: '<path d="M4 6l7 6-7 6zM12 6l7 6-7 6z" fill="currentColor"/>',
  bellows: '<path d="M3 9h7l5-4v14l-5-4H3z" fill="currentColor"/><path d="M18 6l3-2M18 12h5M18 18l3 2" stroke="currentColor" stroke-width="2"/>',
  sniper: '<path d="M2 12h20v2H9l-3 5H2l2-5zM9 6h7v3H9z" fill="currentColor"/><path d="M12 9v3" stroke="currentColor" stroke-width="2"/>',
  foam: '<circle cx="8" cy="15" r="5" fill="currentColor"/><circle cx="15" cy="13" r="6" fill="currentColor"/><circle cx="19" cy="18" r="3" fill="currentColor"/>',
  magnet: '<path d="M4 4v9a8 8 0 0 0 16 0V4h-5v9a3 3 0 0 1-6 0V4z" fill="currentColor"/>',
  spring: '<path d="M4 21h16M5 4h14M6 7l12 3-12 3 12 3-12 3" fill="none" stroke="currentColor" stroke-width="2"/>',
  scrambler: '<circle cx="12" cy="14" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9v5l4 2M9 3h6M12 3v3" fill="none" stroke="currentColor" stroke-width="2"/>',
};
})(window.SS = window.SS || {});
