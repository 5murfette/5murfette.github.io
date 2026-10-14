/* render/look.js — the look of a map: the per-biome lights (sun, hemisphere, fill), the procedural sky, fog and haze,
 * the exposure and the colour grade, the vegetation and water tints, all set for the time of day (dusk: the sun 4°
 * above the horizon, warm low light; night: a cool moon light, stars, the worm's lamp; underground: a faint cave
 * skylight and dark fog) and the weather. apply(S) runs at a new map and when the weather turns; it sets the shared
 * view state (view.look, tod, haze, stormK, lavaK) the other views read.
 * C: the engine's lighting / post-process volume per biome and time of day; LOOKS is its data. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const LK = SS.look = {};
  let view = null, scene = null, renderer = null, Q = null, sun = null, hemi = null, fill = null, stars = null;
  // the per-biome lighting and grading: sun / hemisphere colours and intensities, fog density, haze tint, exposure,
  // the grass / dry-grass tints, the sea's deep / shallow colours, the sun's direction
  const LOOKS = {
    temperate: {
      sun: 0xffe2b8,
      sunI: 3.0,
      hemiS: 0xcfe2ff,
      hemiG: 0x7a5a3a,
      hemiI: 1.15,
      fog: 0.0062,
      haze: 0xf1d9c0,
      exp: 1.05,
      grass: [1, 1, 1],
      dry: [1, 1, 1],
      gBase: 0x173a0c,
      gTip: 0x8cc840,
      gDry: 0xc8a85c,
      deep: 0x0d3a5c,
      shallow: 0x2fa7a8,
      sunDir: [-0.42, 0.62, 0.66]
    },
    alpine: {
      sun: 0xfff3e6,
      sunI: 2.9,
      hemiS: 0xd8e8ff,
      hemiG: 0x6a7080,
      hemiI: 1.3,
      fog: 0.0070,
      haze: 0xdde8f5,
      exp: 1.0,
      grass: [0.86, 0.96, 0.92],
      dry: [0.95, 0.95, 0.9],
      gBase: 0x1a3418,
      gTip: 0x7aa860,
      gDry: 0xb8a878,
      deep: 0x123a58,
      shallow: 0x5fb0c8,
      sunDir: [-0.5, 0.5, 0.7]
    },
    canyon: {
      sun: 0xffd4a0,
      sunI: 3.2,
      hemiS: 0xffe2c4,
      hemiG: 0x8a4a2a,
      hemiI: 1.1,
      fog: 0.0058,
      haze: 0xf0c8a0,
      exp: 1.05,
      grass: [1.05, 0.95, 0.75],
      dry: [1.1, 0.98, 0.8],
      gBase: 0x2a3a12,
      gTip: 0xa8b050,
      gDry: 0xd8b070,
      deep: 0x1a3a48,
      shallow: 0x4a9a8a,
      sunDir: [-0.55, 0.55, 0.62]
    },
    desert: {
      sun: 0xfff0d2,
      sunI: 3.4,
      hemiS: 0xfff0d8,
      hemiG: 0xa07850,
      hemiI: 1.15,
      fog: 0.0055,
      haze: 0xf5dcb0,
      exp: 0.94,
      grass: [1.1, 1.0, 0.75],
      dry: [1.15, 1.0, 0.8],
      gBase: 0x3a3a14,
      gTip: 0xb8b060,
      gDry: 0xe0c080,
      deep: 0x0d4a66,
      shallow: 0x38c0c0,
      sunDir: [-0.35, 0.72, 0.6]
    },
    beach: {
      sun: 0xffe2bc,
      sunI: 3.3,
      hemiS: 0xdcd2c2,
      hemiG: 0xb89460,
      hemiI: 1.15,
      fog: 0.0046,
      haze: 0xf4dcb4,
      exp: 1.0,
      grass: [0.82, 1.06, 0.66],
      dry: [1.0, 1.0, 0.8],
      gBase: 0x0e3a0c,
      gTip: 0x4ca82c,
      gDry: 0xb4a45c,
      deep: 0x0c3a30,
      shallow: 0x4f8f5c,
      sunDir: [-0.5, 0.46, 0.72],
      water: { near: 0x7a6a40, mid: 0x344034, deep: 0x283e3a }
    },
    volcanic: {
      sun: 0xffc896,
      sunI: 3.1,
      hemiS: 0xb8b4c4,
      hemiG: 0x5e463a,
      hemiI: 1.7,
      fog: 0.0072,
      haze: 0x8e7672,
      exp: 1.45,
      grass: [0.8, 0.85, 0.7],
      dry: [0.9, 0.85, 0.7],
      gBase: 0x1a2410,
      gTip: 0x6a7a40,
      gDry: 0x8a7a50,
      deep: 0x0a1a22,
      shallow: 0x2a5a5a,
      sunDir: [-0.5, 0.45, 0.72]
    }
  };
  LK.LOOKS = LOOKS;
  /* the colour grade per biome and time of day (render/lens.js, after the tone map): sat, con (S-curve 0..1), vig, cool
   * shadows sh, warm highlights hi */
  const GRADES = {
    temperate: { sat: 1.12, con: 0.16, vig: 0.22, sh: [-0.004, 0.0, 0.012], hi: [1.03, 1.0, 0.95] },
    alpine: { sat: 1.1, con: 0.2, vig: 0.22, sh: [-0.006, 0.0, 0.016], hi: [1.02, 1.0, 0.96] },
    canyon: { sat: 1.06, con: 0.18, vig: 0.24, sh: [0.0, -0.004, 0.012], hi: [1.04, 1.0, 0.94] },
    desert: { sat: 1.14, con: 0.27, vig: 0.22, sh: [0.004, -0.002, 0.012], hi: [1.03, 0.99, 0.93] },
    volcanic: { sat: 1.14, con: 0.2, vig: 0.3, sh: [0.004, -0.004, 0.008], hi: [1.05, 0.98, 0.92] },
    beach: { sat: 1.2, con: 0.2, vig: 0.2, sh: [-0.004, 0.002, 0.012], hi: [1.04, 1.0, 0.93] }
  };
  function gradeFor(L, tod) {
    const g = GRADES[view.biome] || GRADES.temperate;
    if (tod === 'night')
      return { sat: g.sat * 0.92, con: g.con * 0.6, vig: g.vig * 1.2, sh: [-0.002, 0.002, 0.014], hi: [0.96, 1.0, 1.08] };
    if (tod === 'dusk') return { sat: g.sat * 1.08, con: g.con, vig: g.vig * 1.1, sh: [-0.002, -0.004, 0.016], hi: [1.06, 0.98, 0.9] };
    return g;
  }
  /* the cool fill from the far side of the sky (no shadow). apply sets it with the other lights; render/weather.js
   * takes
   * the final values of the sun, the hemisphere and the fill as its bases (WX.look) and only modulates them (cloud
   * deck, lightning flash) */
  const FILL = LK.FILL = { color: 0x9cc0ff, intensity: 0.45, x: -30, y: 20, z: -40 };
  LK.apply = function (S) {
    view.biome = S.biome;
    let L = LOOKS[S.biome] || LOOKS.temperate, skyDir = null;
    const tod = SS.world.under ? 'day' : SS.sim.time_of_day(S);
    view.tod = tod;
    if (S.biome === 'beach' && SS.world.features && SS.world.features.beach && !SS.world.under) {
      // the sun's bearing is tied to the cove (the photo's light: sea on one side, the low sun over the land and
      // along the shore, long shadows towards the water); the sunset swings it over the open sea (a glitter path on the
      // water, the palms backlit)
      const a0 = SS.world.features.beach.a0, ca = Math.cos(a0), sa = Math.sin(a0), el = tod === 'dusk' ? 0.07 : 0.4;
      const az = tod === 'dusk' ? a0 + 0.5 : Math.atan2(-0.85 * sa + 0.5 * ca, -0.85 * ca - 0.5 * sa);
      L = Object.assign({}, L, { sunDir: [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)] });
    }
    if (tod !== 'day') {
      const sd = L.sunDir, az = Math.atan2(sd[2], sd[0]);
      if (tod === 'dusk') {
        const el = 0.07;
        L = Object.assign({}, L, {
          sunDir: [Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)],
          sunI: L.sunI * 0.9,
          hemiI: L.hemiI * 0.7,
          exp: L.exp * 1.15
        });
      }
      else {
        skyDir = [Math.cos(az) * 0.99, -0.14, Math.sin(az) * 0.99];
        const m = [-Math.cos(az) * 0.6, 0.62, -Math.sin(az) * 0.6];
        view.moonDir = m;
        L = Object.assign({}, L, {
          sunDir: m,
          sun: 0x9fb4e8,
          sunI: 0.85,
          hemiS: 0x4a6090,
          hemiG: 0x1c1c22,
          hemiI: 0.8,
          exp: L.exp * 1.35,
          fog: L.fog * 0.8
        });
      }
    }
    view.wxKind = S.weather ? S.weather.kind : null;
    view.look = L;
    // the procedural sky for this biome + weather; the fog / haze is the sky's own horizon colour (aerial perspective:
    // the far terrain fades into exactly the sky behind it), a little of the biome's haze tint
    const sk = SS.skyView.look(
      S.biome,
      S.weather ? S.weather.kind : 'clear',
      skyDir || L.sunDir,
      tod === 'night' && view.moonDir ? { k: 1, moon: view.moonDir } : null
    );
    SS.cloudView.look(S, sk);
    SS.farView.look(S, sk, L);
    const haze = new T.Color().setRGB(sk.horizon[0], sk.horizon[1], sk.horizon[2], T.SRGBColorSpace)
      .lerp(new T.Color(L.haze), sk.phys ? 0.15 : 0.45);
    scene.fog.color.copy(haze); scene.fog.density = L.fog;
    view.haze = haze.clone(); view.fogBase = L.fog;
    sun.color.set(L.sun);
    sun.intensity = L.sunI;
    hemi.color.set(L.hemiS);
    hemi.groundColor.set(L.hemiG);
    hemi.intensity = L.hemiI;
    if (sk.sunT) {                      // K2: ash / dust along the sun's path dim and redden it (relative to clean air)
      const t = sk.sunT, mx = Math.max(t[0], t[1], t[2]);
      sun.color.r *= t[0] / mx;
      sun.color.g *= t[1] / mx;
      sun.color.b *= t[2] / mx;
      sun.intensity *= Math.max(0.35, mx);
    }
    // moonlight (not the reddened sun beam)
    if (tod === 'night') {
      sun.color.set(L.sun);
      sun.intensity = L.sunI;
    }
    fill.color.set(FILL.color); fill.intensity = FILL.intensity; fill.position.set(FILL.x, FILL.y, FILL.z);
    if (SS.world.under) {
      // deep underground the time of day barely matters: only the faint skylight that works its way down (dusk warmer,
      // night bluer and a little dimmer); no sun, no sky fill
      const ct = SS.sim.time_of_day(S),
        cHemi = ct === 'night' ? 0x7d8aa6 : ct === 'dusk' ? 0x948a84 : 0x8a8f99,
        cI = ct === 'night' ? 0.28 : ct === 'dusk' ? 0.31 : 0.32;
      sun.intensity = 0;
      sun.castShadow = false;
      fill.intensity = 0;
      hemi.color.set(cHemi);
      hemi.groundColor.set(0x3a3028);
      hemi.intensity = cI;
    }
    stars.material.opacity = tod === 'night' ? 0.95 : tod === 'dusk' ? 0.18 : 0;
    /* under a storm deck the night is dark and the lava is the dominant light there: exposure x 0.7, lava light x 2.4
     * (dusk 1.4); view.stormK = 1 under a cloud deck (sky ov >= 0.7) */
    view.stormK = sk && sk.ov !== undefined && sk.ov >= 0.7 ? 1 : 0;
    view.lavaK = tod === 'night' ? 1 + 1.4 * (0.5 + 0.5 * view.stormK) : tod === 'dusk' ? 1.4 : 1;
    renderer.toneMappingExposure = L.exp * (tod === 'night' ? 1 - 0.3 * view.stormK : 1);
    if (SS.lens && SS.lens.grade) {
      // (only where the quality grades the frame: on low the lens pass runs only for a black hole / heat haze)
      SS.lens.grade(Q.grade ? gradeFor(L, tod) : null);
      const sc = sun.color;
      SS.lens.sun(
        !Q.grade || tod === 'night' || SS.world.under ? null : L.sunDir,
        [sc.r * 0.5, sc.g * 0.4, sc.b * 0.3],
        tod === 'dusk' ? 0.55 : 0.3
      );
    }
    const U = SS.terrain.uniforms;
    U.uBeach.value = S.biome === 'beach' ? 1 : 0;       // (the granite / pale sand look in the terrain shader)
    U.uHaze.value.copy(haze);
    U.uGrassTint.value.setRGB(L.grass[0], L.grass[1], L.grass[2]); U.uDryTint.value.setRGB(L.dry[0], L.dry[1], L.dry[2]);
    const G = SS.grass.material().userData.uniforms;
    G.uBase.value.set(L.gBase); G.uTip.value.set(L.gTip); G.uDryTip.value.set(L.gDry);
    SS.waterView.look(L, sk, haze);
    // the cut faces (rock cap, sea face) take the time of day's light: dusk warm and dimmer, moonlight cool, dark and
    // desaturated (FACE: r, g, b, saturation, haze; volcanic maps add their haze and fire tint)
    {
      const f = FACE[tod] || FACE.day, volc = S.biome === 'volcanic';
      SS.terrain.capTod(tod === 'night' || tod === 'dusk' ? tod : 'day', view.stormK, S.biome);
      SS.waterView.faceLook(f[0], f[1], f[2], f[3], f[4] + (volc ? 0.3 : 0), volc ? 0.45 : 0);
    }
    SS.weatherView.look(L, sk, haze);
    SS.fx.look(L, sk);
    SS.flameView.look(L, sk);
    // underground: no sun, a dim cave ambient (rock-tinted bounce), dark fog; the sky world is hidden in V.render
    if (SS.world.under) {
      scene.fog.color.set(0x0b0a09);
      scene.fog.density = 0.032;
      view.haze = scene.fog.color.clone();
      U.uHaze.value.copy(scene.fog.color);
      renderer.setClearColor(0x050505, 1); renderer.toneMappingExposure = 1.15;
      // the dark fog; the lights are already the cave's
      SS.weatherView.look(Object.assign({}, L, { fog: 0.032 }), sk, scene.fog.color);
    } else {
      // (no shadow pass for a dark sun underground)
      renderer.setClearColor(0x000000, 1);
      sun.castShadow = true;
    }
    // what the shared environment map shows: the sky cube + lit soil below the horizon; caves a faint grey; space is
    // captured from the End of the World's dome
    {
      if (SS.world.eow || S.eow) SS.envView.look({ mode: 'space', k: 1, ground: [0, 0, 0], floor: [0.012, 0.013, 0.018] });
      else if (SS.world.under) SS.envView.look({ mode: 'cave', k: 0, ground: [0.02, 0.018, 0.016], floor: [0.03, 0.03, 0.033] });
      else {
        const g = new T.Color(L.hemiG), sy = Math.max(0, L.sunDir[1]), lit = L.hemiI * 0.8 + L.sunI * sy * 0.35;
        SS.envView.look({
          mode: 'sky',
          k: 1,
          ground: [g.r * lit, g.g * lit, g.b * lit],
          floor: tod === 'night' ? [0.010, 0.014, 0.024] : [0, 0, 0]
        });
      }
    }
  };
  // the cut faces' light per time of day: r, g, b, saturation, haze
  const FACE = { day: [1, 1, 1, 1, 0], dusk: [0.78, 0.64, 0.52, 0.9, 0], night: [0.2, 0.3, 0.44, 0.8, 0.1] };
  /* ctx: the view's state record and its scene, renderer, quality, lights (sun, hemi, fill) and stars */
  LK.init = function (ctx) {
    view = ctx.view;
    scene = ctx.scene;
    renderer = ctx.renderer;
    Q = ctx.Q;
    sun = ctx.sun;
    hemi = ctx.hemi;
    fill = ctx.fill;
    stars = ctx.stars;
  };
})(window.SS = window.SS || {});
