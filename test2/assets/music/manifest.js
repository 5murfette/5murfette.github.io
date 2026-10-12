/* assets/music/manifest.js — the generated music (docs/SOUND_PROMPTS.md "Music"; docs/notes/P42b.md has the conventions).
 * A plain script (works from file://): SS.MUSIC_FILES[cue] = ['file.ogg', 'file.m4a', ...] (paths relative to
 * assets/music/). Several entries are ALTERNATIVE FORMATS of the same track: platform/music.js takes the first one the
 * browser can play (canPlayType), so list the preferred format first. A cue that is missing or empty is silence (no error).
 * Cue ids the player asks for:
 *   mus_menu                              main menu / lobby loop
 *   mus_<biome>_base, mus_<biome>_intense biome = temperate | alpine | canyon | desert | volcanic; the two files must be the
 *                                         SAME length, tempo and key (they play in sync; the game crossfades them by intensity)
 *   mus_suddendeath (+ mus_suddendeath_intense, optional)   loop once sudden death has begun
 *   mus_tension                           loop faded in over the last 5 s of a turn
 *   mus_victory, mus_defeat               one-shot stingers at the end of a match
 * Example: SS.MUSIC_FILES.mus_menu = ['mus_menu.m4a']; */
(function (SS) {
  'use strict';
  SS.MUSIC_FILES = SS.MUSIC_FILES || {};
  /* P83b: temperate / desert / alpine / canyon / caves / eow bases are the P81 slow-ambient loops (docs/notes/P83b.md); they have no
   * intense stem (the old stems were another key and length, so they are not listed); volcanic + menu are the approved P42 files. */
  /* BEGIN music (generated: ACE-Step 1.5 via gfx-factory, loops cut by tools/dev/gen/musicloop.py; picks in HANDOFF P42b) */
  SS.MUSIC_FILES.mus_alpine_base = ['mus_alpine_base.m4a', 'mus_alpine_base.opus'];
  SS.MUSIC_FILES.mus_caves_base = ['mus_caves_base.m4a', 'mus_caves_base.opus'];
  SS.MUSIC_FILES.mus_canyon_base = ['mus_canyon_base.m4a', 'mus_canyon_base.opus'];
  SS.MUSIC_FILES.mus_desert_base = ['mus_desert_base.m4a', 'mus_desert_base.opus'];
  SS.MUSIC_FILES.mus_eow_base = ['mus_eow_base.m4a', 'mus_eow_base.opus'];
  SS.MUSIC_FILES.mus_menu = ['mus_menu.m4a', 'mus_menu.opus'];
  SS.MUSIC_FILES.mus_suddendeath = ['mus_suddendeath.m4a', 'mus_suddendeath.opus'];
  SS.MUSIC_FILES.mus_temperate_base = ['mus_temperate_base.m4a', 'mus_temperate_base.opus'];
  SS.MUSIC_FILES.mus_tension = ['mus_tension.m4a', 'mus_tension.opus'];
  SS.MUSIC_FILES.mus_volcanic_base = ['mus_volcanic_base.m4a', 'mus_volcanic_base.opus'];
  SS.MUSIC_FILES.mus_volcanic_intense = ['mus_volcanic_intense.m4a', 'mus_volcanic_intense.opus'];
  SS.MUSIC_FILES.mus_victory = ['mus_victory.m4a', 'mus_victory.opus'];
  SS.MUSIC_FILES.mus_defeat = ['mus_defeat.m4a', 'mus_defeat.opus'];
  /* END music */
})(window.SS = window.SS || {});
