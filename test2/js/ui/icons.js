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
  parachute: '<path d="M3 11a9 8 0 0 1 18 0z" fill="currentColor"/><path d="M3 11l9 9M21 11l-9 9M12 11v9" stroke="currentColor" stroke-width="1.4" fill="none"/><circle cx="12" cy="21" r="1.6" fill="currentColor"/>',
  zipline: '<path d="M2 5l20 9" stroke="currentColor" stroke-width="2"/><circle cx="11" cy="9.6" r="2" fill="currentColor"/><path d="M11 12v5M9 22l2-5 2 5" stroke="currentColor" stroke-width="2" fill="none"/>',
  teleport: '<path d="M12 2l2 7 7 3-7 3-2 7-2-7-7-3 7-3z" fill="currentColor"/>',
  girder: '<path d="M2 8h20v3H2zM2 13h20v3H2z" fill="currentColor"/><path d="M5 11l3 2 3-2 3 2 3-2 3 2" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  skip: '<path d="M4 6l7 6-7 6zM12 6l7 6-7 6z" fill="currentColor"/>',
  bellows: '<path d="M3 9h7l5-4v14l-5-4H3z" fill="currentColor"/><path d="M18 6l3-2M18 12h5M18 18l3 2" stroke="currentColor" stroke-width="2"/>',
  sniper: '<path d="M2 12h20v2H9l-3 5H2l2-5zM9 6h7v3H9z" fill="currentColor"/><path d="M12 9v3" stroke="currentColor" stroke-width="2"/>',
  foam: '<circle cx="8" cy="15" r="5" fill="currentColor"/><circle cx="15" cy="13" r="6" fill="currentColor"/><circle cx="19" cy="18" r="3" fill="currentColor"/>',
  magnet: '<path d="M4 4v9a8 8 0 0 0 16 0V4h-5v9a3 3 0 0 1-6 0V4z" fill="currentColor"/>',
  spring: '<path d="M4 21h16M5 4h14M6 7l12 3-12 3 12 3-12 3" fill="none" stroke="currentColor" stroke-width="2"/>',
  // P37-W3 (weapons A): original vector icons (the new weapons have no painted ones)
  flamethrower: '<rect x="1.5" y="10" width="8" height="8" rx="2.2" fill="currentColor"/><path d="M9 12.2h7v3.6H9z" fill="currentColor"/><path d="M5 10V7.5h3V10" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M16.5 14c.4-2.6 2.2-4 4.5-4.6-.8 1.2-.4 2.3.4 3 .6-.7.9-1.6.7-2.6 1.6 1.4 1.9 4 .1 5.9-1.7 1.8-4.4 1.6-5.7-.1z" fill="#ff8a3a"/>',
  acid: '<path d="M9 3h6v4l4.2 9.4A3.3 3.3 0 0 1 16.2 21H7.8a3.3 3.3 0 0 1-3-4.6L9 7z" fill="currentColor"/><path d="M6.4 15.5h11.2l.7 1.6c.5 1.1-.3 2.4-1.5 2.4H7.2c-1.2 0-2-1.3-1.5-2.4z" fill="#8bd83a"/><path d="M12 11.5c1 1.5 1.6 2.3 1.6 3a1.6 1.6 0 0 1-3.2 0c0-.7.6-1.5 1.6-3z" fill="#151d23"/>',
  gas: '<circle cx="8" cy="14" r="5" fill="currentColor"/><circle cx="15.5" cy="11" r="5.2" fill="currentColor"/><circle cx="18" cy="17" r="3.4" fill="currentColor"/><path d="M6 13.5a1.4 1.4 0 1 0 0 .01M12 11a1.2 1.2 0 1 0 0 .01M16 15a1.2 1.2 0 1 0 0 .01" stroke="#151d23" stroke-width="1.4" fill="none"/><path d="M10 3h4v3h-4z" fill="currentColor"/>',
  mortar: '<path d="M7.5 21l4.2-9.8 3.7 1.6L11.8 21z" fill="currentColor"/><path d="M12.5 9.4l2.2-5.2 3.8 1.6-2.2 5.2z" fill="currentColor"/><path d="M5 21h9" stroke="currentColor" stroke-width="2"/><circle cx="19" cy="4.5" r="1.4" fill="#ffb02e"/><circle cx="21.4" cy="8" r="1.1" fill="#ffb02e"/><circle cx="17" cy="1.8" r="1" fill="#ffb02e"/>',
  minigun: '<rect x="1.5" y="13" width="6.2" height="7.5" rx="1.2" fill="currentColor"/><rect x="7.7" y="9" width="2.6" height="9" fill="currentColor"/><path d="M10 9.4h10.5M10 12h10.5M10 14.6h10.5M10 17.2h10.5" stroke="currentColor" stroke-width="1.9"/><path d="M21 11h2M21 14h2.4M21 17h2" stroke="#ffb02e" stroke-width="1.6"/>',
  handgun: '<path d="M2.5 8.5h15.5v3.8h-6.6l-.9 6.2H6.2l1.1-6.2H2.5z" fill="currentColor"/><path d="M18 9.4h3.2" stroke="currentColor" stroke-width="1.8"/><circle cx="21.4" cy="9.4" r="1.2" fill="#ffb02e"/>',
  boomerang: '<path d="M4 4c8 0 14.5 6.2 16.2 16-2.2-5.4-8.4-8.2-12.6-8.2-.9 0-1.8.1-2.6.3C3.8 10.4 3.6 7.4 4 4z" fill="currentColor"/><path d="M15 6.5c2.6.2 4.7 1.4 6.2 3.3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-dasharray="2 2"/>',
  raven: '<path d="M2 15c4.2-.4 6.6-3.2 8.6-6.6 1.6 1.3 3.6 1.7 5.4 1.2l5.4-2.8-2.2 3.4c.6 3.7-1.6 7.2-5.6 8.4-.2-1.8-.5-2.6-1.6-3.4-.4 1.5-1.2 2.7-2.6 3.4-.6-2.4-2-3.8-4.2-4.4z" fill="currentColor"/><rect x="2.5" y="17.5" width="6" height="4" rx=".6" fill="#f0e8d0"/><path d="M2.5 18l3 1.9 3-1.9" stroke="#151d23" stroke-width=".9" fill="none"/>',
  scrambler: '<circle cx="12" cy="14" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9v5l4 2M9 3h6M12 3v3" fill="none" stroke="currentColor" stroke-width="2"/>',
  // P37 W4: weapons B and the skills (vector icons only: no painted art for them)
  dog: '<path d="M3 11h10l2.5-3.2H19l2 2.8-2.2 1.6v2.2h-2v6h-2.2v-6H9.2v6H7v-6H5.2v-2.4L3 12z" fill="currentColor"/><circle cx="18.6" cy="9.4" r=".95" fill="#ff5b4f"/><path d="M3.2 11 1.8 7.5M14.5 7.4l.6-2.6" stroke="currentColor" stroke-width="1.5" fill="none"/>',
  punch: '<path d="M7 22v-7.2L5 12.6V9a2 2 0 0 1 4 0V8a2 2 0 0 1 4 0V7.6a2 2 0 0 1 4 0V9a2 2 0 0 1 3 1.8V15l-2 2.3V22z" fill="currentColor"/><path d="M12 6V1.5M9 3.2l3-2.6 3 2.6" stroke="#ffb02e" stroke-width="1.6" fill="none"/>',
  sentry: '<path d="M12 22 7.5 15.5h9z" fill="currentColor"/><rect x="8.6" y="8.4" width="6.8" height="5.4" rx="1.3" fill="currentColor"/><path d="M15.4 10.5H23" stroke="#ff5b4f" stroke-width="1.8" stroke-dasharray="2 1.6"/><path d="M8.6 11H5" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="6.2" r="1.4" fill="currentColor"/>',
  claymore: '<path d="M2.5 15.5c3.4-6.2 15.6-6.2 19 0V18h-19z" fill="currentColor"/><path d="M6.5 21v-3M17.5 21v-3" stroke="currentColor" stroke-width="2"/><path d="M12 5.6v3.3M7.6 7l1.4 2.5M16.4 7 15 9.5" stroke="#ff5b4f" stroke-width="1.6"/>',
  ffield: '<path d="M2.5 19.5a9.5 9.5 0 0 1 19 0" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6 19a6 6 0 0 1 12 0" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".6"/><rect x="9.6" y="16.5" width="4.8" height="4.5" rx="1" fill="currentColor"/><circle cx="12" cy="18.7" r="1" fill="#9fe8ff"/>',
  gravgun: '<path d="M2.5 14.5h9.5l2 1.8h2.5v-4.6h-2.5L12 13.5" fill="currentColor"/><path d="M5.5 15v5.5h3V15" fill="currentColor"/><path d="M18.2 9.5a5 5 0 0 1 0 9M20.7 7a8.5 8.5 0 0 1 0 14" fill="none" stroke="#9fe8ff" stroke-width="1.6"/>',
  skill_freerot: '<path d="M20 12a8 8 0 1 1-2.6-5.9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M19.4 2.4v4.4h-4.4z" fill="currentColor"/>',
  skill_laser: '<circle cx="19" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M2 12h12" stroke="currentColor" stroke-width="2" stroke-dasharray="2 2"/><circle cx="19" cy="12" r="1" fill="#ff5b4f"/>',
  skill_fastwalk: '<path d="M3 6l7 6-7 6zM11 6l7 6-7 6z" fill="currentColor"/><path d="M20 7v10" stroke="currentColor" stroke-width="2"/>',
  skill_lowgrav: '<path d="M12 3v11M7 8l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M5 20h14M8 17h8" stroke="currentColor" stroke-width="1.6" stroke-dasharray="1.5 2"/>',
  skill_tinfoil: '<path d="M12 2.5 6.2 17h11.6z" fill="currentColor"/><path d="M9.4 9.5l2 2.2-2.3 1.6M13.2 5.8l1.8 2-2 1.6" stroke="#151d23" stroke-width="1" fill="none"/><path d="M4 19.5h16" stroke="currentColor" stroke-width="2"/>',
  skill_overload: '<rect x="3" y="12.5" width="8" height="8" rx="1" fill="currentColor"/><rect x="12.5" y="12.5" width="8" height="8" rx="1" fill="currentColor"/><rect x="7.8" y="3.5" width="8" height="8" rx="1" fill="currentColor"/>',
};
  /* keys that have a painted icon (assets/icons/icon-<key>.webp); any other key shows its vector icon whatever the
   * Artwork option says. tools/dev/gen/iconstest.cjs keeps this list equal to the files on disk. */
  SS.iconsArt = {
    acid: 1, airstrike: 1, banana: 1, bat: 1, bazooka: 1, bellows: 1, blackhole: 1, boomerang: 1,
    boulder: 1, claymore: 1, cluster: 1, dog: 1, drill: 1, dynamite: 1, ffield: 1, flamethrower: 1,
    foam: 1, gas: 1, girder: 1, gravgun: 1, grenade: 1, handgun: 1, holy: 1, homing: 1,
    magnet: 1, mine: 1, minigun: 1, moai: 1, mortar: 1, napalm: 1, parachute: 1, punch: 1,
    raven: 1, rope: 1, scrambler: 1, sentry: 1, sheep: 1, shotgun: 1, skip: 1, sniper: 1,
    spring: 1, teleport: 1, tesla: 1, zipline: 1
  };
})(window.SS = window.SS || {});
