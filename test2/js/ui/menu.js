/* ui/menu.js — the main menu and the loading progress bar.
 * DOM only; returns plain settings objects to main.js, which hands them to the sim. All options are DATA (tables
 * below): the form is built from MATCH / RULES / DISPLAY / FIELD (+ the DENSITY rows) by one generic row builder
 * (segmented buttons, toggles, selects). Layout: left = live map preview (hero: click = new seed; Top / Side minis:
 * click = the battlefield sub-menu), right = a page ('main' or 'field'). Everything is set in the display font
 * (Bungee). The preview data come from SS.worldgen.preview (the 2D stage of the real generator) via
 * ui/mappreview.js. */
(function (SS) {
  'use strict';
  const C = SS.CFG, D = SS.dom, DEN = C.DENSITY;
  const MN = SS.menu = {};
  /* the hooks main.js sets: onOnline() opens the multiplayer lobby, onBack() leaves a failed net start, defaultStart(s)
   * starts a map, onDisplay(settings) applies the display rows that take effect at once */
  MN.onOnline = null;
  MN.onBack = null;
  MN.defaultStart = null;
  MN.onDisplay = null;
  const KEY = 'burrowBrawl3d.settings';
  let lastShow = null,
    root,
    panel,
    prog,
    bar,
    lbl,
    pct,
    cur,
    onStart,
    onResume,
    page = 'main',
    pv = null,
    pvTimer = 0,
    cv = {},
    rowsEl = null,
    tabsEl = null;
  /* the right column is a tab strip + one page: main (match and rules), field (battlefield), lab, opts (display and
   * sound) */
  const TABS = [['main', 'Match'], ['crates', 'Crates'], ['field', 'Battlefield'], ['lab', 'Lab'], ['opts', 'Options']];

  const BIOME_LOOK = {
    random: 'linear-gradient(135deg,#6b5b95,#3a7bd5 50%,#d76d77)',
    temperate: 'linear-gradient(160deg,#9fd3ff 0%,#7cc36b 45%,#4f7f3a 70%,#8a6a48)',
    alpine: 'linear-gradient(160deg,#dfefff 0%,#f6fbff 40%,#9fc7e8 65%,#5f6f80)',
    canyon: 'linear-gradient(160deg,#ffd8a8 0%,#e08a50 45%,#a8502e 75%,#6e3420)',
    desert: 'linear-gradient(160deg,#fff1cf 0%,#f0d08a 45%,#d8a860 75%,#a07040)',
    volcanic: 'linear-gradient(160deg,#4a4048 0%,#2a2426 45%,#ff5a10 75%,#3a2a24)',
    beach: 'linear-gradient(160deg,#bfe9f2 0%,#35c2b8 28%,#e9d29a 52%,#d9b878 66%,#3f7a3a 88%,#24501f)',
    // the End of the World: the sun, the lava core and the dark of space
    eow: 'radial-gradient(circle at 70% 30%,#ffb24a 0 6%,transparent 7%),radial-gradient(circle at 40% 62%,#ff6a1a 0 9%,#3a1a10 10% 14%,transparent 15%),linear-gradient(160deg,#05060f 0%,#1a1230 55%,#3a1840 100%)'
  };
  const LV = [['none', 'None'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
  const OPTS = {
    weather: [
      ['auto', 'Auto'], ['clear', 'Clear'], ['cloudy', 'Cloudy'], ['rain', 'Rain'], ['storm', 'Storm'], ['snow', 'Snow'],
      ['blizzard', 'Blizzard'], ['ashfall', 'Ash fall'], ['fog', 'Fog']
    ],
    lava: [['auto', 'Auto'], ['on', 'Pockets'], ['off', 'None']],
    wind: [['auto', 'Auto'], ['calm', 'Calm'], ['breeze', 'Breeze'], ['strong', 'Strong'], ['gale', 'Gale']],
    skill: [['easy', 'Rookie'], ['normal', 'Soldier'], ['hard', 'Sharpshooter']],
    teams: [['2', '2'], ['3', '3'], ['4', '4']], worms: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']],
    hp: [['80', '80'], ['100', '100'], ['150', '150']],
    time: [['random', 'Random'], ['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night']],
    shape: [['random', 'Random'], ['islands', 'Islands'], ['hills', 'Hills'], ['caverns', 'Caverns'], ['canyon', 'Canyon']],
    // 96 m / 128 m (Auto: the biome's default, the volcano island is large)
    mapSize: [['auto', 'Auto'], ['normal', 'Normal'], ['large', 'Large']],
    art: [['painted', 'Painted'], ['procedural', 'Vector']],
    placement: [['random', 'Random'], ['user', 'You place']],
    volcanoes: [['auto', 'Random'], ['0', 'None'], ['1', 'One'], ['2', 'Two'], ['3', 'Three']],
    first: [['random', 'Random'], ['0', 'Team 1'], ['1', 'Team 2'], ['2', 'Team 3'], ['3', 'Team 4']],
    turnTime: [['30', '30 s'], ['45', '45 s'], ['60', '60 s'], ['90', '90 s'], ['0', 'No limit']],
    mineFuse: [['random', 'Random'], ['0', '0 s'], ['1', '1 s'], ['2', '2 s'], ['3', '3 s']],
    toolCrates: [['off', 'Off'], ['low', 'Few'], ['normal', 'Normal'], ['high', 'Many']],
    jackets: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => [String(n), String(n)]),
    slice: [['thin', 'Thin'], ['thick', 'Thick'], ['full', 'Full']],
    fps: [['auto', 'Auto'], ['30', '30'], ['60', '60'], ['max', 'Max']],
    // the front of the section as a ghost image (render/section.js)
    ghost: [['0', 'Off'], ['15', '15 %'], ['30', '30 %'], ['50', '50 %'], ['75', '75 %'], ['100', '100 %']]
  };
  /* row: k key, t label, o options (or null = toggle), n = numeric value, w = widget ('seg' | 'sel'), h = hint */
  const MATCH = [
    {
      k: 'dim',
      t: 'Dimension',
      o: [['3d', '3D'], ['2d', '2D']],
      w: 'seg',
      h: '3D: turn the world to aim. 2D: a classic side-on slice, no rotation'
    },
    { k: 'teams', t: 'Teams', o: OPTS.teams, n: 1, w: 'seg', teams: 1 }, { k: 'worms', t: 'Worms per team', o: OPTS.worms, n: 1, w: 'seg' },
    {
      k: 'fort',
      t: 'Fort mode',
      b: true,
      d: false,
      h: 'each team owns a separate island / mesa / crag with a bunker; the gaps between are the hazard'
    },
    { k: 'hp', t: 'Worm health', o: OPTS.hp, n: 1, w: 'seg' }, { k: 'turnTime', t: 'Turn time', o: OPTS.turnTime, n: 1, w: 'seg' },
    { k: 'skill', t: 'CPU skill', o: OPTS.skill, w: 'seg' }, { k: 'placement', t: 'Worm placement', o: OPTS.placement, w: 'seg' },
    { k: 'first', t: 'Who starts', o: OPTS.first, w: 'sel', fn: v => (v === 'random' ? 'random' : parseInt(v, 10)) }
  ];
  const RULES = [
    { k: 'rotLock', t: 'Rotation lock', b: true, d: true, h: 'random start worm, rotate for 10 s, then fixed' },
    { k: 'mineFuse', t: 'Mine fuse', o: OPTS.mineFuse, w: 'seg', fn: v => (v === 'random' ? 'random' : parseInt(v, 10)) },
    {
      k: 'jackets',
      t: 'Life jackets per team',
      o: OPTS.jackets,
      n: 1,
      w: 'sel',
      h: 'a worm that lands in water inflates one (-6 HP) and swims back to the shore by itself; 0 = none'
    },
    {
      k: 'jacketOn',
      t: 'Life jackets on at the start',
      b: true,
      d: true,
      h: 'each team switches its own in the match (the ; key or the vest chip)'
    },
    {
      k: 'jetpacks',
      t: 'Jetpacks per team',
      o: OPTS.jackets,
      n: 1,
      w: 'sel',
      h: 'End of the World only: a falling worm fires one to land safely (key J or the chip switches it); 0 = none'
    },
    { k: 'sd', t: 'Sudden death', b: true, d: true, h: 'the sea rises from round 8' },
    { k: 'collapse', t: 'Land collapse', b: true, d: true, h: 'unsupported land breaks' },
    { k: 'blood', t: 'Blood and gibs', b: true, d: false }, { k: 'teamBlood', t: 'Team-coloured blood', b: true, d: false },
    { k: 'select', t: 'Worm select', b: true, d: false }, { k: 'rooms', t: 'Buried rooms', b: true, d: false },
    { k: 'keepRope', t: 'Keep ropes', b: true, d: false, h: 'a worm stays hanging' }
  ];
  const DISPLAY = [
    { k: 'quality', t: 'Visual quality', w: 'seg', dyn: 'quality' }, { k: 'slice', t: 'Slice view', o: OPTS.slice, w: 'seg' },
    {
      k: 'ghost',
      t: 'Front ghost',
      o: OPTS.ghost,
      n: 1,
      w: 'seg',
      h: 'how visible the part of the world in front of the section is (Off = hidden)'
    }, { k: 'art', t: 'Artwork', o: OPTS.art, w: 'seg' },
    { k: 'idle', t: 'Idle antics', b: true, d: true, h: 'bored worms juggle, scroll a phone, doze off ...' },
    {
      k: 'ghostAuto',
      t: 'Auto ghost after attacks',
      b: true,
      d: true,
      h: 'the front half shows at 50 % after a shot and while an alien attacks'
    },
    {
      k: 'cine',
      t: 'Cinematic camera',
      b: true,
      d: true,
      h: 'smooth turn moves, hit and kill cams, victory orbit (off = instant cuts); any key skips'
    },
    {
      k: 'anticCam',
      t: 'Antic camera',
      b: true,
      d: true,
      h: 'the camera moves in on a worm\'s face while it plays an idle antic or winces from a hit, then goes back (never while you aim or move)'
    },
    {
      k: 'fps',
      t: 'Frame rate',
      o: OPTS.fps,
      w: 'seg',
      h: 'frames per second; Auto = 30 on a phone (half the battery), the screen\'s own rate elsewhere'
    }
  ];
  const FIELD = [
    { k: 'shape', t: 'Terrain shape', o: OPTS.shape, w: 'seg' },
    { k: 'mapSize', t: 'Map size', o: OPTS.mapSize, w: 'seg', h: 'caves and the desert are always normal' },
    { k: 'volcanoes', t: 'Volcanoes', o: OPTS.volcanoes, w: 'seg', only: 'volcanic' },
    { k: 'time', t: 'Time of day', o: OPTS.time, w: 'seg' }, { k: 'weather', t: 'Weather', o: OPTS.weather, w: 'sel' },
    { k: 'wind', t: 'Wind', o: OPTS.wind, w: 'seg' }, { k: 'lava', t: 'Lava', o: OPTS.lava, w: 'seg' }
  ];
  const DENSITY = [
    { k: 'dTrees', t: 'Trees' }, { k: 'dRocks', t: 'Rocks and boulders' }, { k: 'dProps', t: 'Cars, junk, monuments' },
    { k: 'dBarrels', t: 'Explosive barrels' },
    { k: 'dCrates', t: 'Crates' }, { k: 'dMines', t: 'Mines' }, { k: 'dBunkers', t: 'Bunkers' },
    { k: 'dTown', t: 'Ruined town', only: 'volcanic' }, { k: 'dEggs', t: 'Alien eggs', only: 'volcanic' }
  ];
  /* the Lab: the experimental mechanics (bits = C.LAB.FLAG, rules in sim/lab.js); every one is OFF by default and
   * applies to the next match */
  const LAB = [
    {
      id: 'BANK',
      t: 'Bank shots',
      d: 'A grenade (or any bouncing shell) that ricochets hard off the terrain before it explodes deals +20 % blast damage per bounce, up to +60 %, to the other teams. Rewards geometry and trick shots over plain lobbing.'
    },
    {
      id: 'UNDERDOG',
      t: 'Underdog',
      d: 'A team holding half the HP (or less) of the strongest other team deals +35 % blast damage until it catches up. A comeback mechanic: being behind makes every shot scarier.'
    },
    {
      id: 'GUSTS',
      t: 'Wind gusts',
      d: 'While you aim, the wind keeps shifting every 6-12 seconds, in strength and heading. Check the wind bar right before you fire: a perfect shot can be blown off at the last second.'
    },
    {
      id: 'METEORS',
      t: 'Meteor shower',
      d: 'Every third turn two or three meteors are announced by red rings on the ground and strike 2.2 seconds later near the action. They hit everyone, so shelter matters.'
    },
    {
      id: 'CLOCK',
      t: 'Pressure clock',
      d: 'An overtime mode: the turn clock shrinks by 10 % every round, down to 15 seconds. Needs a turn time (not "No limit"). Long games get frantic.'
    },
    {
      id: 'MOON',
      t: 'Moon phase',
      d: 'Every third round gravity halves for worms and props: jumps are huge and floaty, falls are gentle. Shells keep their normal flight, so rope and jump routes change.'
    },
    {
      sec: 'Batch 2: perks, momentum, precision',
      id: 'PERKS',
      t: 'Perk draft',
      d: 'At the start of the match and every third round (rounds 1, 4, 7 ...) each team picks 1 of 3 random perks, press 1 / 2 / 3 or click a card: wide blasts (+15 % radius), padded boots (-20 % landing damage), spring legs (+20 % jump), thick skin (-15 % blast damage taken), crate magnet (2.5 x pickup reach), extra time (+10 s per turn). The CPU picks by a fixed ranking; online, the pick is a normal input.'
    },
    {
      id: 'STREAK',
      t: 'Streak',
      d: 'Damage an enemy with a blast during your turn and your team gains a streak step (up to x4): +10 % blast damage per step, shown on the team panel. A turn without a hit resets it. Rewards consistency, and the underdog has the other mechanic to catch up.'
    },
    {
      id: 'LONGSHOT',
      t: 'Long shot',
      d: 'A blast that hurts an enemy farther than 25 m from the shooter deals +25 % damage, farther than 40 m +50 %, with a LONG SHOT banner. Rewards sniping across the map and punishes camping at range.'
    },
    {
      id: 'FATIGUE',
      t: 'Fatigue',
      d: 'Every metre a worm walks, swings or falls during its turn (up to 25 m) makes that same worm\'s NEXT shot sway: up to 5.7 degrees of random aim error. Stand still for a perfect aim, move for position: the HUD badge shows the current sway.'
    },
    {
      sec: 'Batch 3: terrain',
      id: 'CRACKS',
      t: 'Cracks',
      d: 'Blasts leave cracks in the ground, in 3D, that stay: they weaken the soil (later blasts dig wider there and the rubble breaks into smaller rocks) and can cut land loose. After every blast the game weighs the land around it (rock, soil, props, worms on top) against what still holds it: a ledge whose root was cut by the hole and the cracks, or a big block hanging on a thin neck, falls with whatever stands on it. Rock and ice crack far, soil less, sand and snow hardly. Cracks show as dark lines on the ground.'
    },
    {
      sec: 'Batch 4: storm, ground, weapons',
      id: 'LIGHTNING',
      t: 'Lightning rods',
      d: 'In a thunderstorm a bolt strikes the tallest conductor near a random spot: steel girders and bridges first, then mines, barrels and metal props, a worm standing bare on high ground, a tree. A bluish crackle marks the point 1.4 seconds ahead, so you can run. A bolt zaps worms nearby, sets off a mine or barrel, blows a supply crate and lights dry plants. Replaces the natural strike; needs Weather: Thunderstorm.'
    },
    {
      id: 'SLICK',
      t: 'Mud and slick ground',
      d: 'Rain and snow make loose ground (soil, sand, ash, scree) slippery: a worm on a steep wet slope slides downhill, walking through mud is up to 30 % slower, and a fall into mud hurts up to 50 % less. The ground dries out again over a few turns. Needs rain, a storm or snow.'
    },
    {
      id: 'RECOIL',
      t: 'Recoil',
      d: 'Heavy shots push the shooter back: a bazooka\'s back-blast, a shotgun, a sniper rifle, a hurled boulder. Dry ground holds you, but ice and mud barely do: you slide, and a ledge edge or the sea behind you becomes a danger. The CPU steps away from edges before it fires.'
    },
    {
      id: 'SCAVENGE',
      t: 'Scavenge',
      d: 'When a worm dies, its grave leaves one random item from that team\'s stock as a supply crate at the next turn: take it before the enemy does. Drowned worms lose their pack.'
    }
  ];
  MN.LAB = LAB;
  const labBits = () => LAB.reduce((n, r) => n + (((cur.labFlags | 0) & C.LAB.FLAG[r.id]) ? 1 : 0), 0);
  /* the saved settings (untrusted: an old build, a hand edit) over the menu's match defaults, made valid by the
   * settings
   * schema (C.settings_sanitize) */
  MN.load = function () {
    const s = SS.store.get_json(KEY, {});
    // the match defaults: 2 teams of 3, 100 HP, 45 s turns, sudden death, team 1 human, the others CPU
    const d = Object.assign(
      {},
      C.SETTINGS,
      { biome: 'random', teams: 2, worms: 3, hp: 100, turnTime: 45, sd: true, skill: 'normal', cpu: 'off',
        ctl: ['human', 'cpu', 'cpu', 'cpu'], names: C.TEAMS.map(t => t.name),
        first: 'random', volcanoes: 'auto', blood: false, teamBlood: false, mineFuse: 'random', select: false, rooms: false,
        keepRope: false, time: 'random', shape: 'random', art: 'painted' },
      s
    );
    if (d.under === 'on' && !s.shape) d.shape = 'caverns';            // (older saved settings: World underground)
    d.under = 'off';                                                  // the terrain shape 'caverns' is the underground map now
    d.cpu = 'off';                                       // (the legacy per-map CPU switch is replaced by ctl[])
    return C.settings_sanitize(d, {
      biome: 'random',
      teams: 2,
      worms: 3,
      hp: 100,
      turnTime: 45,
      seed: 7,
      ctl: ['human', 'cpu', 'cpu', 'cpu'],
      names: C.TEAMS.map(t => t.name)
    });
  };
  MN.save = s => SS.store.set_json(KEY, s);

  /* the biome a 'random' choice resolves to: by the seed, so the preview shows exactly what Start will build */
  /* a beta biome (C.BIOMES[i].beta) is listed and drawn only with ?beta=1 in the URL: it ships with the build but stays
   * out of
   * the menu and the random pool until its look is finished */
  MN.beta = typeof location !== 'undefined' && /[?&]beta=1(&|$)/.test(location.search);
  MN.biome_listed = b => !b.beta || MN.beta;
  MN.resolve_biome = s => {
    if (s.biome !== 'random') return s.biome;
    // an experimental biome is never a surprise, a beta one only with ?beta=1
    const pool = C.BIOMES.filter(b => !b.experimental && MN.biome_listed(b));
    return pool[(Math.imul((s.seed | 0) + 12345, 2654435761) >>> 11) % pool.length].id;
  };
  const resolved = () => Object.assign({}, cur, { biome: MN.resolve_biome(cur) });

  /* ---------- generic rows ---------- */
  function seg(opts, val, onpick) {
    const w = D.el('div', 'seg');
    w.setAttribute('role', 'radiogroup');
    for (const [v, t] of opts) {
      const on = String(v) === String(val), b = D.el('button', 'sg' + (on ? ' on' : ''), t);
      b.type = 'button';
      b.dataset.v = v;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.onclick = () => {
        for (const x of w.children) {
          x.classList.remove('on');
          x.setAttribute('aria-checked', 'false');
        }
        b.classList.add('on');
        b.setAttribute('aria-checked', 'true');
        onpick(v);
      };
      w.appendChild(b);
    }
    // Left / Right move the choice inside a group (Tab moves between groups)
    w.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const k = [...w.children], i = k.indexOf(document.activeElement);
      if (i < 0) return;
      const n = k[Math.max(0, Math.min(k.length - 1, i + d))];
      e.preventDefault();
      n.focus();
      n.click();
    });
    return w;
  }
  function selectW(opts, val, onpick) {
    const s = D.el('select', 'sel');
    for (const [v, t] of opts) {
      const o = D.el('option');
      o.value = v;
      o.textContent = t;
      if (String(v) === String(val)) o.selected = true;
      s.appendChild(o);
    }
    s.onchange = () => onpick(s.value);
    return s;
  }
  function toggle(val, onpick) {
    const b = D.el('button', 'tg' + (val ? ' on' : ''), '<i></i>');
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', val ? 'true' : 'false');
    b.onclick = () => {
      const v = !b.classList.contains('on');
      b.classList.toggle('on', v);
      b.setAttribute('aria-checked', v ? 'true' : 'false');
      onpick(v);
    };
    return b;
  }
  function rowOf(r, host, after) {
    const qOpts = [['auto', 'Auto (' + SS.quality.detect() + ')'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
    const row = D.el('div', 'row'), lab = D.el('div', 'lab', r.t + (r.h ? `<em>${r.h}</em>` : ''));
    let w;
    if (r.b) w = toggle(cur[r.k] == null ? r.d : !!cur[r.k], v => {
      cur[r.k] = v;
      if (after) after(r);
    });
    else {
      const o = r.dyn === 'quality' ? qOpts : r.o, conv = r.fn || (r.n ? (v => parseInt(v, 10)) : (v => v));
      const pick = v => {
        cur[r.k] = conv(v);
        if (after) after(r);
      };
      w = (r.w === 'sel' || o.length > 5) ? selectW(o, cur[r.k], pick) : seg(o, cur[r.k], pick);
    }
    row.append(lab, w); host.appendChild(row); return row;
  }

  /* ---------- the map preview ---------- */
  function previewSettings() {
    const s = resolved();
    s.shape = cur.shape;
    return s;
  }
  function refreshPreview(now) {
    clearTimeout(pvTimer);
    const run = () => {
      if (!cv.top || !SS.mappreview || !SS.worldgen.preview) return;
      const s = previewSettings();
      try {
        pv = SS.mappreview.compute(s, 96);
      } catch (e) {
        console.warn('preview failed', e);
        return;
      }
      SS.mappreview.drawHero(cv.hero, pv); SS.mappreview.drawTop(cv.top, pv, s); SS.mappreview.drawSide(cv.side, pv);
      const B = C.BIOMES.find(b => b.id === pv.biome);
      cv.cap.innerHTML =
        `<b>${B ? B.name : pv.biome}</b><span>seed ${cur.seed} · ${pv.under ? 'caverns' : pv.shape + ' · ' + pv.sx + ' m'}</span>`;
    };
    if (now) run();
    else pvTimer = setTimeout(run, 60);
  }
  function newSeed() {
    cur.seed = Math.floor(Math.random() * 99999);
    if (cv.seed) cv.seed.value = cur.seed;
    refreshPreview(true);
    cv.hero.classList.remove('pop');
    void cv.hero.offsetWidth;
    cv.hero.classList.add('pop');
    if (page === 'field') syncField();
  }

  function buildPreview(host) {
    const box = D.el('div', 'pvbox');
    cv.hero = D.el('canvas', 'hero');
    cv.hero.width = 480;
    cv.hero.height = 270;
    cv.hero.title = 'Click: new map (new seed)';
    cv.hero.onclick = newSeed;
    const heroWrap = D.el('div', 'herowrap');
    heroWrap.appendChild(cv.hero);
    heroWrap.appendChild(D.el('div', 'herohint', '<span>⚄</span> CLICK FOR A NEW MAP'));
    cv.cap = D.el('div', 'pvcap');
    heroWrap.appendChild(cv.cap);
    const minis = D.el('div', 'minis');
    cv.top = D.el('canvas');
    cv.top.width = 192;
    cv.top.height = 192;
    cv.side = D.el('canvas');
    cv.side.width = 288;
    cv.side.height = 192;
    for (const [c, name] of [[cv.top, 'Top'], [cv.side, 'Side']]) {
      const f = D.el('button', 'mini');
      f.type = 'button';
      f.title = 'Battlefield settings';
      f.append(c, D.el('span', 'mtag', name), D.el('span', 'mgo', 'EDIT ▸'));
      f.onclick = () => go('field'); minis.appendChild(f);
    }
    const sr = D.el('div', 'seedrow2', '<span>SEED</span>');
    cv.seed = D.el('input');
    cv.seed.type = 'number';
    cv.seed.min = 0;
    cv.seed.max = 99999;
    cv.seed.value = cur.seed;
    cv.seed.oninput = () => {
      cur.seed = Math.min(99999, Math.max(0, parseInt(cv.seed.value, 10) || 0));
      if (+cv.seed.value > 99999) cv.seed.value = cur.seed;
      refreshPreview();
      if (page === 'field') syncField();
    };
    const dice = D.el('button', 'dice', '⚄');
    dice.type = 'button';
    dice.title = 'New map';
    dice.onclick = newSeed;
    sr.append(cv.seed, dice);
    // (the seed row right under the hero: never pushed out of a short window)
    box.append(heroWrap, sr, minis); host.appendChild(box);
  }

  /* ---------- the right column ---------- */
  /* A section is a header button and a body: pressing the header folds the body (a phone in landscape sees only a few
   * rows at a time, so every tab but its first
   * section starts folded there; a large window starts with everything open). The choice is kept while the menu lives.
   * Returns the body: rows go into it. */
  const secOpen = {};
  const compactMenu = () => !!(window.matchMedia && matchMedia('(max-width:900px),(max-height:520px)').matches);
  function sec(host, title, first, meta) {
    const key = page + ':' + title, head = D.el('button', 'msec'), body = D.el('div', 'msb');
    if (secOpen[key] == null) secOpen[key] = !compactMenu() || !!first;
    head.type = 'button';
    head.innerHTML = '<span class="msn">' + title + '</span>' + (meta ? '<em class="msm">' + meta + '</em>' : '');
    const show = () => {
      head.setAttribute('aria-expanded', secOpen[key] ? 'true' : 'false');
      body.hidden = !secOpen[key];
    };
    head.onclick = () => {
      secOpen[key] = !secOpen[key];
      show();
    };
    show();
    host.append(head, body);
    return body;
  }
  function teamsBlock(host) {
    const tbox = D.el('div', 'tbox');
    const draw = () => {
      tbox.innerHTML = '';
      cur.ctl = (cur.ctl || []).slice(); cur.names = (cur.names || []).slice();
      for (let i = 0; i < (cur.teams | 0 || 2); i++) {
        const row = D.el('div', 'tcfg');
        row.style.setProperty('--team', C.css(C.TEAMS[i].rgb));
        const nm = D.el('input');
        nm.maxLength = 18;
        nm.value = cur.names[i] || C.TEAMS[i].name;
        nm.oninput = () => { cur.names[i] = nm.value; };
        cur.ctl[i] = cur.ctl[i] || (i ? 'cpu' : 'human');
        const ct = seg([['human', 'Human'], ['cpu', 'CPU']], cur.ctl[i], v => { cur.ctl[i] = v; });
        row.append(D.el('i'), nm, ct); tbox.appendChild(row);
      }
    };
    draw(); host.appendChild(tbox); return draw;
  }
  function go(p) {
    page = p;
    buildRows();
    rowsEl.scrollTop = 0;
    syncTabs();
  }
  function syncTabs() {
    if (!tabsEl) return;
    for (const b of tabsEl.children) {
      const on = b.dataset.page === page;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (b.dataset.page === 'lab') {
        const n = labBits(), s = 'Lab' + (n ? ` <i>${n}</i>` : '');
        if (b._h !== s) {
          b._h = s;
          b.innerHTML = s;
        }
      }
    }
  }
  function buildTabs() {
    tabsEl = D.el('div', 'mtabs'); tabsEl.setAttribute('role', 'tablist');
    for (const [id, t] of TABS) {
      const b = D.el('button', 'mtab', t);
      b.type = 'button';
      b.dataset.page = id;
      b.setAttribute('role', 'tab');
      b.onclick = () => go(id); tabsEl.appendChild(b);
    }
    tabsEl.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const i = TABS.findIndex(x => x[0] === page), n = TABS[(i + d + TABS.length) % TABS.length][0];
      e.preventDefault();
      go(n);
      tabsEl.children[TABS.findIndex(x => x[0] === n)].focus();
    });
    return tabsEl;
  }
  function buildRows() {
    rowsEl.innerHTML = '';
    rowsEl.classList.remove('enter'); void rowsEl.offsetWidth; rowsEl.classList.add('enter');
    if (page === 'field') return buildField();
    if (page === 'crates') return buildCrates();
    if (page === 'lab') return buildLab();
    if (page === 'opts') return buildOpts();
    let redraw = () => {};
    for (const r of MATCH) {
      rowOf(r, rowsEl, r.teams ? () => redraw() : null);
      if (r.teams) redraw = teamsBlock(rowsEl);
    }
    const rules = sec(rowsEl, 'Rules');
    for (const r of RULES) rowOf(r, rules);
  }
  /* the Crates page: one 0..10 slider per crate kind (0 = never, 5 = default = 20 % of the rounds, 10 = 40 %); the
   * line under them shows the exact
   * chances per round (sim/skills.js crate_chances: the chance of ONE crate = 4 % x the highest level, shared by the
   * kinds in proportion to their levels) */
  function buildCrates() {
    rowsEl.appendChild(
      D.el(
        'div',
        'labintro',
        'How often supply crates fall. At most one crate per round. Each slider goes from 0 (never) over 5 (default) to 10; the chance of a crate in a round is 4 % per level of the highest slider (5 = 20 %, 10 = 40 %), shared between the kinds in proportion to their sliders.'
      )
    );
    const KIND = [
      ['crateW', 'Weapon crates', 'a random weapon, rarer ones less often'],
      ['crateH', 'Health crates', '+30 HP'],
      ['crateT', 'Tool crates', 'free rotation, laser sight, fast walk, low gravity, tinfoil hat, crate overload']
    ];
    const sum = D.el('div', 'labcount'), outs = {};
    const upd = () => {
      const ch = SS.skills && SS.skills.crate_chances ? SS.skills.crate_chances({ settings: cur }) : null,
        pc = v => (v * 100).toFixed(1).replace(/\.0$/, '') + ' %';
      for (const [k] of KIND) {
        const o = outs[k];
        if (o) o.textContent = cur[k] + (ch ? ' · ' + pc(ch[C.CRATES.KINDS[C.CRATES.SLIDERS.indexOf(k)]]) + ' / round' : '');
      }
      if (ch) sum.textContent = ch.any > 0 ? 'A crate falls in ' + pc(ch.any) + ' of the rounds' : 'No crates at all';
    };
    for (const [k, t, h] of KIND) {
      const row = D.el('div', 'row'),
        lab = D.el('div', 'lab', t + `<em>${h}</em>`),
        box = D.el('div', 'cratebox'),
        w = D.el('input', 'vslider'),
        out = D.el('span', 'cratev');
      w.type = 'range';
      w.min = 0;
      w.max = C.CRATES.MAX;
      w.step = 1;
      w.value = cur[k];
      w.dataset.key = k;
      w.setAttribute('aria-label', t);
      w.oninput = () => {
        cur[k] = parseInt(w.value, 10);
        upd();
      };
      w.onchange = () => MN.save(cur);
      outs[k] = out;
      box.append(w, out);
      row.append(lab, box);
      rowsEl.appendChild(row);
    }
    const bar = D.el('div', 'labbar'), def = D.el('button', 'back', 'Default (5)'), off = D.el('button', 'back', 'No crates');
    def.type = off.type = 'button';
    const setAll = v => {
      for (const [k] of KIND) cur[k] = v;
      MN.save(cur);
      buildRows();
    };
    def.onclick = () => setAll(C.CRATES.DEF); off.onclick = () => setAll(0);
    bar.append(sum, def, off); rowsEl.appendChild(bar); upd();
  }
  const LIVE = { ghostAuto: 1, cine: 1, anticCam: 1, fps: 1, idle: 1 };
  function buildOpts() {
    const display = sec(rowsEl, 'Display', true);
    // the rows that take effect at once in the running match go through MN.onDisplay (main.js applies them)
    for (const r of DISPLAY) rowOf(r, display, LIVE[r.k] ? () => MN.onDisplay && MN.onDisplay(cur) : null);
    musicRow(sec(rowsEl, 'Sound'));
  }
  /* the music volume (platform/music.js keeps and persists it, not part of the map settings) */
  function musicRow(host) {
    const M = SS.music;
    if (!M) return;
    const row = D.el('div', 'row'), lab = D.el('div', 'lab', 'Music volume'), w = D.el('input', 'vslider');
    w.type = 'range';
    w.min = 0;
    w.max = 100;
    w.step = 1;
    w.value = Math.round(M.volume * 100);
    w.id = 'musicvol';
    w.setAttribute('aria-label', 'Music volume');
    w.oninput = () => M.set_volume(w.value / 100);
    row.append(lab, w); host.appendChild(row);
  }
  /* the Lab screen: one card per experimental mechanic (toggle, description, status). Saved at once (applies to
   * the next match, local or hosted) */
  function buildLab() {
    rowsEl.appendChild(
      D.el(
        'div',
        'labintro',
        'New game mechanics to try out. Everything here is off by default, applies to the next match (also an online match you host) and shows as a badge in the game.'
      )
    );
    const cnt = D.el('div', 'labcount');
    const upd = () => {
      syncTabs();
      cnt.textContent = labBits() ? labBits() + ' of ' + LAB.length + ' active' : 'all off';
    };
    const batches = [];
    for (const r of LAB) {
      if (r.sec || !batches.length) batches.push({ name: r.sec || 'Batch 1: shots, comebacks, weather', items: [] });
      batches[batches.length - 1].items.push(r);
    }
    batches.forEach(bt => {
      const body = sec(rowsEl, bt.name, false, bt.items.length + ' mechanics');
      for (const r of bt.items) {
        const bit = C.LAB.FLAG[r.id], card = D.el('div', 'labcard');
        const top = D.el('div', 'labtop'), nm = D.el('div', 'labname', r.t);
        const st = D.el('span', 'labstatus', 'EXPERIMENTAL');
        nm.appendChild(st);
        const tg = toggle(((cur.labFlags | 0) & bit) !== 0, v => {
          cur.labFlags = v ? ((cur.labFlags | 0) | bit) : ((cur.labFlags | 0) & ~bit);
          MN.save(cur);
          upd();
        });
        tg.dataset.lab = r.id;
        top.append(nm, tg); card.append(top, D.el('div', 'labdesc', r.d)); body.appendChild(card);
      }
    });
    const bar = D.el('div', 'labbar'), all = D.el('button', 'back', 'Enable all'), none = D.el('button', 'back', 'Disable all');
    all.type = none.type = 'button';
    const set = v => {
      cur.labFlags = v;
      MN.save(cur);
      buildRows();
      syncTabs();
    };
    all.onclick = () => set(C.LAB.ALL); none.onclick = () => set(0);
    bar.append(cnt, all, none); rowsEl.appendChild(bar); upd();
  }
  function buildField() {
    const biomeBody = sec(rowsEl, 'Biome', true);
    const cards = D.el('div', 'biomes');
    for (const b of [{ id: 'random', name: 'Surprise me' }].concat(C.BIOMES.filter(MN.biome_listed))) {
      const c = D.el('button', 'bcard' + (cur.biome === b.id ? ' on' : ''), `<span>${b.name}</span>`);
      c.style.background = BIOME_LOOK[b.id]; c.type = 'button'; c.dataset.biome = b.id;
      c.onclick = () => {
        cur.biome = b.id;
        for (const x of cards.children) x.classList.remove('on');
        c.classList.add('on');
        refreshPreview(true);
        syncField();
      };
      cards.appendChild(c);
    }
    biomeBody.appendChild(cards);
    const fhost = sec(rowsEl, 'Terrain and sky');
    for (const r of FIELD) {
      const row = rowOf(r, fhost, () => refreshPreview());
      row.dataset.only = r.only || '';
      row.dataset.k = r.k;
    }
    const dhost = sec(rowsEl, 'How much of everything');
    for (const r of DENSITY) {
      const row = rowOf({ k: r.k, t: r.t, o: LV, w: 'seg' }, dhost, () => refreshPreview());
      row.dataset.only = r.only || '';
    }
    syncField();
  }
  /* biome-specific rows (volcanoes, ruined town, eggs) show only on that biome */
  function syncField() {
    const b = MN.resolve_biome(cur);
    for (const r of rowsEl.querySelectorAll('.row[data-only]')) r.style.display = (!r.dataset.only || r.dataset.only === b) ? '' : 'none';
    // the biome's own weather pool (no snow on the beach)
    const ws = rowsEl.querySelector('.row[data-k="weather"] select');
    if (ws) {
      for (const o of ws.options) {
        const ok = o.value === 'auto' || C.weather_ok(b, o.value);
        o.hidden = !ok;
        o.disabled = !ok;
      }
      if (cur.weather && cur.weather !== 'auto' && !C.weather_ok(b, cur.weather)) {
        cur.weather = C.weather_for(b, cur.weather);
        ws.value = cur.weather;
        MN.save(cur);
      }
    }
  }

  MN.init = function () {
    root = document.getElementById('menu');
    root.innerHTML = '';
    panel = D.el('div', 'mpanel');
    root.appendChild(panel);
    prog = D.el('div', 'mprog', '<h2>BURROW BRAWL</h2><div class="pbar"><i></i></div><div class="plabel"><span></span><b></b></div>');
    root.appendChild(prog);
    // Esc closes the in-game menu (Resume); on the battlefield page it goes back first. (input.js skips keys
    // while a button has the focus)
    addEventListener('keydown', e => {
      if (e.code !== 'Escape' || e.repeat || !onResume || !MN.visible() || panel.style.display === 'none') return;
      // (the game's own Escape handler must not reopen the menu in the same event)
      e.preventDefault(); e.stopImmediatePropagation();
      if (page !== 'main') {
        go('main');
        return;
      }
      MN.hide(); onResume();
    });
    bar = prog.querySelector('i'); lbl = prog.querySelector('span'); pct = prog.querySelector('b');
  };

  // the build time the deploy writes into index.html (YYYYMMDD/HH:MM, its local time; 'dev' in a checkout)
  const BUILD_TIME = (document.querySelector('meta[name="build-time"]') || {}).content || '';
  /* Show the settings form. opts.inGame adds a Resume button. */
  MN.show = function (settings, start, opts) {
    opts = opts || {};
    cur = C.settings_sanitize(settings, MN.load()); page = 'main'; lastShow = [settings, start, opts];
    for (const k of DEN.KEYS)
      if (DEN.LEVELS.indexOf(cur[k]) < 0) cur[k] = 'medium';
    onStart = start; onResume = opts.onResume;
    root.classList.remove('gone');
    root.classList.add('menu');
    root.classList.toggle('ingame', !!opts.inGame);
    prog.style.display = 'none';
    panel.style.display = '';
    panel.innerHTML = '';
    const head = D.el(
      'div',
      'mhead',
      '<img class="mlogo" src="assets/logo.webp" alt="Burrow Brawl"><div class="sub">Turn-based worm warfare on a rotatable cross-section of a fully destructible 3D world</div>'
        + (opts.inGame ? '<div class="mpause">Paused</div>' : '')
        + (BUILD_TIME ? '<div class="mbuild">Build ' + D.esc(BUILD_TIME) + '</div>' : '')
    );
    const body = D.el('div', 'mbody'), left = D.el('div', 'mleft'), right = D.el('div', 'mright');
    buildPreview(left);
    rowsEl = D.el('div', 'rows');
    right.append(buildTabs(), rowsEl);
    buildRows();
    syncTabs();
    body.append(left, right);
    const btns = D.el('div', 'mbtns');
    btns.appendChild(D.el('div', 'hint', 'Generation runs on this device (10-20 s on phones)'));
    // in the pause menu Resume is the primary button (focused) and "New battle" the quieter one; at the start "Start
    // battle" is the primary one
    const primary = !!onResume;
    if (MN.onOnline) {
      const on = D.el('button', 'ghost', 'Play online');
      on.type = 'button';
      on.onclick = () => {
        MN.save(cur);
        MN.onOnline();
      };
      btns.appendChild(on);
    }
    const go = D.el('button', primary ? 'ghost' : 'go', opts.inGame ? 'New battle' : 'Start battle');
    go.type = 'button';
    go.onclick = () => {
      MN.save(cur);
      const s = Object.assign({}, cur);
      s.biome = MN.resolve_biome(cur);
      onStart(s);
    };
    let rs = null;
    if (onResume) {
      rs = D.el('button', 'go', 'Resume');
      rs.type = 'button';
      rs.onclick = () => {
        MN.hide();
        onResume();
      };
    }
    btns.append(go);
    if (rs) btns.appendChild(rs);
    panel.append(head, body, btns);
    refreshPreview(true);
    (rs || go).focus();
  };
  MN.visible = () => root && !root.classList.contains('gone');
  MN.state = () => cur;                                     // (tests / tools)

  /* Loading progress (0..1) with a stage label. */
  MN.progress = function (f, label) {
    // (a pending preview must not compute (a 96 px map) while the real map loads)
    clearTimeout(pvTimer); pvTimer = 0; pv = null;
    root.classList.remove('gone'); root.classList.remove('menu'); root.classList.remove('ingame');
    panel.style.display = 'none'; prog.style.display = '';
    bar.style.width = (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%';
    if (label) lbl.textContent = label;
    pct.textContent = Math.round(f * 100) + '%';
  };
  /* a failed start is not a dead end: "Back to menu" returns to the settings form (the saved settings) */
  MN.error = function (msg) {
    MN.progress(0, 'Failed to start: ' + msg); prog.classList.add('err');
    let b = prog.querySelector('.back');
    if (!b) {
      b = D.el('button', 'back', 'Back to menu');
      b.type = 'button';
      prog.appendChild(b);
    }
    b.style.display = '';
    b.onclick = () => {
      prog.classList.remove('err');
      b.style.display = 'none';
      const l = lastShow;
      if (MN.onBack) MN.onBack();
      MN.show(MN.load(), (l && l[1]) || onStart || MN.defaultStart, {});
    };
    b.focus();
  };
  MN.hide = function (instant) {
    clearTimeout(pvTimer); pvTimer = 0; pv = null;
    if (instant) {
      root.style.transition = 'none';
      root.classList.add('gone');
      void root.offsetWidth;
      root.style.transition = '';
    }
    else root.classList.add('gone');
  };
})(window.SS = window.SS || {});
