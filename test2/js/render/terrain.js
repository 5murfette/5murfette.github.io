/* render/terrain.js — voxel terrain presentation (Three.js specific).
 *   - one full-resolution surface-nets mesh per 16 m world chunk (SS.meshgen.chunk), remeshed on edit
 *     under a per-frame time budget (slab chunks first);
 *   - each chunk geometry is drawn by up to 4 meshes: the section SLAB behind "slice zero" (clipped to
 *     -uBack <= t <= 0 in the fragment shader, opaque, casts shadows; nothing in front of slice zero is drawn,
 *     so the collision section is never hidden), and the surrounding CONTEXT (far side t < -uBack: opaque,
 *     receding into the haze with its distance; near side t > 0: faint, inspection only);
 *   - the slab's cut face is a CAP plane at t = 0 (slice zero, exactly the collision section and its
 *     outline) that samples a 3D density+material texture of the world (strata, topsoil, glowing lava where
 *     the cut crosses a pocket);
 *   - lava inside the rock is drawn as an x-ray glow when the 3D context or inspection is visible; open lava (the
 *     fluid layer S.lava) is drawn by render/lava.js, its cross-section on the cap from tLavaS.
 * Porting: chunk meshes = engine meshes; the clip/cap trick = a material keyword + a 3D texture. */
(function (SS) {
  'use strict';
  const T = window.THREE, C = SS.CFG;
  const TR = SS.terrain = {};
  const capN = { value: null };   // world-space lighting normal of the cut face (see capMaterial)
  /* D5: dry worlds — the cap also draws the cut face BEYOND the lattice (the far dunes' section; the D2 curtain is
   * gone: it z-fought the cap in the 1 m the cap reached past the border, where the cap smeared the clamped volume, and
   * used its own layering / scale / lighting). Beyond the border the cap reads a 1D strip along the section (tFar,
   * FAR_N texels over the lattice exits ± FAR_S m): r = top (worldgen far_height), g = sand base (top − sand −
   * SAND_EXTRA), b = rock top (top − ROCK_DV): RULES.desert's layering, the same rule the lattice voxels got, so the
   * strata continue; within 1 m inside the border the volume's material weights blend into the strip's. */
  const FAR_N = 2048, FAR_S = 420;
  const VOLSIZE = new T.Vector3();                      // lattice size, shared by every material (P38: it changes with the map size)
  const FAR = { tFar: { value: null }, uFar: { value: null }, uLat: { value: null } };
  const CAP_DEEP = 400, CAP_EXT = 1500;   // m: the section's rock body below the lattice / beyond it on wet worlds (P29a)
  // C1: the cut face's 3D noise and pinned-coordinate offset (τ = s + uS0, see the cap shader); MORPH_CELL = the world
  // cell size (m) of the texture-offset grid: a face point that moves ~one cell while the section turns has fully
  // changed its texture (at s = 20 m a 7° turn; under the worm never)
  // uCapK: night / dusk grade of the cut face: rgb tint x brightness, w = saturation
  const CAPU = {
    uUnder: { value: 0 },
    uCapDet: { value: 1 },
    uCapDbg: { value: 0 },
    uCapFill: { value: new T.Vector4(0, 0, 0, 0) },
    uCapGrade: { value: new T.Vector4(1, 1, 1, 1) },
    uCapFlash: { value: 0 },
    uStrata: { value: 0.6 },
    uConcQ: { value: 1 },
    tN3: { value: null },
    uS0: { value: 0 },
    uCapK: { value: new T.Vector4(1, 1, 1, 1) },
    uEow: { value: 0 }
  };
  const MORPH_CELL = 2.5;
  let capPivot = null;
  let farData = null, farKey = '', farRange = null;
  // P118c: the overview (V) is the whole map, solid. ovr = that state is on this frame (not in caves: their overview
  // keeps the cut face, see TR.frame), backUser = the player's slice-view setting (TR.setBack), which the overview
  // overrides with OV_BACK and restores afterwards
  let ovr = false, backUser = null;
  const OV_BACK = 250;
  /* a cave world's overview. The lattice of a cave world is solid to its border (the only surfaces are the tunnels), so
   * "the whole map, solid" has no outside to show: its
   * overview (V) is the section face (the cap, cut to the world box) with the tunnels drawn as faint glass (the x-ray
   * below: both halves, nothing opaque in front of the face; render/section.js keeps the rule on, SEC.cutOv). capOv =
   * that state this frame. */
  let capOv = false, holoMat = null;
  const XR = {
    uK: { value: 0 },
    uCF: { value: new T.Color(0.35, 0.65, 1.0) },
    uCB: { value: new T.Color(1.0, 0.72, 0.3) },
    // the round play area (x, z, r; r 0 = none): no glass outside it
    uDisc: { value: new T.Vector3(48, 48, 0) }
  };
  const XRD = { x: 0, z: 0, r: 0 };
  let scene, tx, Q, chunks = [], volTex, volData, slabMat, slabDepth, ctxFar, ctxNear, bodyMats = null, cap, capMat;
  const U = {};               // shared uniforms
  TR.uniforms = U;

  /* per-material shading table (slot = mat id - 1): x = triplanar scale (1/m), y = roughness, z = emissive, w =
   * porosity (rain darkening) */
  const MATP = [
    [0.14, 0.95, 0, 0.3], [0.16, 0.9, 0, 0.35], [0.28, 0.97, 0, 0.8], [0.22, 0.95, 0, 0.6], [0.15, 0.9, 0, 0.5], [0.2, 0.55, 0, 0.1],
    [0.12, 0.12, 0, 0.0], [0.17, 0.85, 0, 0.3], [0.13, 0.6, 1, 0.0], [0.17, 0.9, 0.12, 0.3], [0.25, 0.98, 0, 0.7], [0.24, 0.92, 0, 0.5]];
  /* LV2 relief amplitudes (m) per material slot of the 2 m / 0.5 m (+0.25 m) / 9 cm / 5 cm octaves (render-only
   * normals; the mesh is 0.5 m): rock lumps and fractures, soil clods and grains, fine sand, soft snow, smooth ice,
   * vesicular basalt, fluid lava 0 (it glows), ropy / clinker crust, fine ash, blocky scree */
  const RELIEF = [
    [0.12, 0.05, 0.012, 0.006], [0.15, 0.06, 0.015, 0.007], [0.05, 0.02, 0.008, 0.006], [0.03, 0.006, 0.002, 0.001],
    [0.1, 0.035, 0.01, 0.004], [0.06, 0.012, 0.003, 0.001], [0.02, 0.004, 0.0008, 0], [0.12, 0.05, 0.02, 0.01],
    [0, 0, 0, 0], [0.08, 0.05, 0.02, 0.008], [0.03, 0.008, 0.003, 0.002], [0.1, 0.08, 0.012, 0.005]];
  /* LV2 sun glints: share of 2.5 cm facets per slot that are mirror-like (snow / ice crystals, quartz grains, glassy
   * basalt rinds and fragments, glassy crust, volcanic glass in ash); wet ground adds film beads (shader) */
  const GLINT = [0.004, 0.006, 0, 0.015, 0.008, 0.06, 0, 0.03, 0, 0.06, 0.01, 0.006];
  // three's lights_fragment_begin with a glint lobe after the directional lights' RE_Direct (directLight.color
  // already carries intensity and shadow: no glints in shadow)
  const LFB_GLINT = (() => {
    const L = T.ShaderChunk.lights_fragment_begin, DK = 'directionalLight = directionalLights[ i ];',
      RE =
      'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';
    const di = L.indexOf(DK), ri = di < 0 ? -1 : L.indexOf(RE, di);
    if (ri < 0) {
      console.warn('terrain: glints off (lights chunk changed)');
      return null;
    }
    return L.slice(0, ri + RE.length)
      + '\n\t\treflectedLight.directSpecular += directLight.color * glintLobe(directLight.direction, geometryViewDir);'
      + L.slice(ri + RE.length);
  })();
  // linear multipliers per material slot. Basalt/ash textures average ~0.21 sRGB (~0.035 linear), darker than real
  // basalt (~0.08-0.1 linear albedo), so they are lifted; crust stays darker than basalt.
  const TINT = [
    [0.52, 0.5, 0.5], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1], [1.02, 1.04, 1.08],
    [1, 1, 1], [2.0, 1.95, 1.9], [1, 1, 1], [1.2, 1.12, 1.1], [1.9, 1.85, 1.8], [1, 1, 1]];

  /* Dry worlds (Step D): the sand beyond the play area (radius uPlayR about the map centre; 0 = off) is hot: sun-
   * bleached (a little paler, the same yellow hue: D4, the dunes stay yellow), and a steady dashed glowing heat line
   * marks the edge. Nothing animates (D4: the old brightness shimmer and the pulsing line read as flicker).
   * Shared with render/dunes.js (needs uniform uPlayR). */
  const HOT = /* glsl */`
    vec3 hotSand(vec3 col, vec3 p, float up, inout vec3 emis){
      if (uPlayR <= 0.0) return col;
      vec2 d = p.xz - vec2(48.0);
      float r = length(d), hot = smoothstep(uPlayR - 0.3, uPlayR + 5.0, r);
      col = mix(col, col * vec3(1.1, 1.06, 0.9) + vec3(0.02, 0.015, 0.0), hot * 0.85);
      /* P97: the edge marker is a broken, wavering ember seam, not a ring of dashes (a perfect circle of equal dashes
       * read as road paint):
       * the radius wanders with the angle, the glow breaks at irregular intervals with soft ends and a wide soft
       * edge */
      float an = atan(d.y, d.x), wob = 0.55 * sin(an * 5.0 + 1.3) + 0.3 * sin(an * 13.0 + 4.1) + 0.2 * sin(an * 29.0 + 0.7);
      float brk = smoothstep(0.25, 0.8, 0.5 + 0.5 * sin(an * uPlayR / 1.5 + 2.2 * sin(an * 7.0) + 1.7 * sin(an * 19.0 + 2.0)));
      float ring = (1.0 - smoothstep(0.05, 0.65, abs(r - uPlayR - wob))) * brk * smoothstep(0.4, 0.75, up);
      col = mix(col, vec3(0.5, 0.14, 0.035), ring * 0.4);
      emis += ring * vec3(0.5, 0.12, 0.02) * 0.3;
      return col;
    }`;
  TR.HOT_GLSL = HOT;

  /* P37 W4 (user: "the foam should have a white overlay, not black, once it pops, and a 3D hexagon structure inside"):
   * foam is a honeycomb. foamHex(p, cell): p in metres on a face, returns .x = distance to the cell wall (0 centre ..
   * 0.5 wall, hexagonal metric), .y = a per-cell random 0..1. foamLook(): the colour of that cell structure: bright
   * white ridges (the walls), a shadowed groove just inside each wall and a concave, slightly bluish cell floor of
   * per-cell depth, so a cut through foam shows a field of hexagonal cells looking into the block (and the outside skin
   * shows the cells as a white relief); never darker than a light grey. */
  const FOAM_GLSL = /* glsl */`
    vec2 foamHex(vec2 p, float cell) {
      p /= cell;
      vec2 r = vec2(1.0, 1.7320508), h = r * 0.5, a = mod(p, r) - h, b = mod(p - h, r) - h, gv = dot(a, a) < dot(b, b) ? a : b, id = p - gv;
      vec2 ag = abs(gv);
      float e = max(dot(ag, vec2(0.5, 0.8660254)), ag.x);
      return vec2(e, fract(sin(dot(id, vec2(127.1, 311.7))) * 43758.5453));
    }
    vec3 foamLook(vec2 p, float cell, float ndl) {
      vec2 q = foamHex(p, cell);
      float e = q.x, rnd = q.y;
      float wall = smoothstep(0.385, 0.455, e), groove = smoothstep(0.30, 0.38, e) * (1.0 - smoothstep(0.38, 0.43, e));
      float fl = smoothstep(0.04, 0.36, e);
      // a concave, bluish cell floor, lighter towards the walls
      vec3 floorC = mix(vec3(0.62, 0.74, 0.90) * (0.9 + 0.2 * rnd), vec3(0.97, 0.985, 1.0), fl);
      vec3 c = mix(floorC, vec3(1.0), wall) - 0.30 * groove * vec3(0.8, 0.85, 1.0);
      // (a touch over 1: the foam reads white in every light)
      return c * (1.0 + 0.1 * ndl);
    }`;
  /* P37 W4 (user: "the plate should be shiny and perfectly flat, made of metal frames with metal sheets bolted on them,
   * like
   * a section of the bridge"): the girder plate's steel voxels are drawn by plate-local coordinates. The sim's plate
   * registry (S.plates) goes to the shader as three vec4 per plate: A = (centre, half length), B = (long axis U, half
   * thickness), C = (plane normal n, half depth); V = n x U (across the thickness). plateIdx(P) = the plate whose box
   * holds P (0.25 m of slack: the voxel surface is within a quarter metre of the exact box).
   *   - the broad faces (normal along V: the deck): a frame of channel steel round the edge, cross ribs every ~1.5 m,
   *     recessed sheets between them (brushed along the plate, a darker inner bevel), round bolt heads every 0.4 m
   *     along the frame and the ribs, polished-steel colour, low roughness; a fake sky / ground reflection and a sun
   *     glint stand in for an environment map (shiny, flat: no relief);
   *   - the other faces: plain frame steel;
   *   - the cut through it (cap): the profile of a bridge girder: flanges top and bottom, a web with ribs, bolts. */
  const EOW_GLSL = SS.eowView ? SS.eowView.GLSL : '';                       // P68d: the wrecked hull's look (render/eowview.js)
  const EOWU = SS.eowView ? Object.assign({ uEow: CAPU.uEow }, SS.eowView.U) : {};
  const TUFF_GLSL = /* glsl */`
    /* P65i: the ruined town of the volcanic island is dressed stone, not pale concrete: courses of dark basalt and brown tuff ashlar (rows 0.28 m on walls, 0.6 m
     * flagstones on roads / floors), recessed joints, pitted faces, lava-orange stains running down from the wall tops, soot, thermal-crack lines.
     * a = along the wall (or x), b = up (or z); returns the albedo, k = 1 on the stone / 0 in the joint */
    /* P116 beach: the bunkers are granite block pillboxes: courses of rounded pink-brown granite blocks, dark joints, rain streaks, pale lichen and moss on the top faces */
    vec3 graniteMasonry(vec2 fq, bool horiz, float up, out float k) {
      float rowH = horiz ? 1.3 : 0.55, row = floor(fq.y / rowH);
      float r1 = texture(tNoise, vec2(row * 0.137, 0.31)).r;
      float a2 = fq.x + r1 * 7.0, bl = (horiz ? 1.6 : 1.1) + 0.6 * texture(tNoise, vec2(row * 0.211, 0.67)).g;
      float cell = floor(a2 / bl), fa = a2 / bl - cell, fb = fq.y / rowH - row;
      float dj = min(min(fa, 1.0 - fa) * bl, min(fb, 1.0 - fb) * rowH);
      float cr = texture(tNoise, vec2(cell * 0.0731 + row * 0.1301, row * 0.0937 + cell * 0.0413)).b;
      float tint = texture(tNoise, vec2(cell * 0.173 + 0.11, row * 0.239 + 0.37)).r;
      vec3 c = mix(vec3(0.4, 0.31, 0.26), vec3(0.49, 0.39, 0.33), smoothstep(0.25, 0.75, tint)) * (0.88 + 0.24 * cr);
      float sp = texture(tNoise, fq * 11.0 + 0.2).b, sp2 = texture(tNoise, fq * 31.0 + 0.6).b;
      c = mix(c, vec3(0.62, 0.52, 0.48), smoothstep(0.78, 0.92, sp2) * 0.6);
      c *= 0.88 + 0.24 * sp;
      float st = smoothstep(0.6, 0.92, texture(tNoise, vec2(fq.x * 1.7, fq.y * 0.07)).b);                              // rain streaks
      c *= 1.0 - 0.38 * st * (horiz ? 0.0 : 1.0);
      float li = smoothstep(0.58, 0.8, texture(tNoise, fq * 0.9 + 0.3).g), mo = smoothstep(0.5, 0.78, texture(tNoise, fq * 0.5 + 0.8).r);
      c = mix(c, vec3(0.5, 0.52, 0.36), li * 0.4);                                                                      // lichen
      // moss: thick on the top faces
      c = mix(c, vec3(0.1, 0.2, 0.06), mo * (horiz ? 0.75 : 0.3 * (1.0 - smoothstep(0.0, 0.5, fq.y - floor(fq.y / 3.0) * 3.0))));
      k = smoothstep(0.008, 0.035, dj);
      c *= mix(0.68, 1.0, k);
      return c;
    }
    vec3 tuffMasonry(vec2 fq, bool horiz, float up, out float k) {
      float rowH = horiz ? 0.6 : 0.28, row = floor(fq.y / rowH);
      float r1 = texture(tNoise, vec2(row * 0.137, 0.31)).r;
      float a2 = fq.x + r1 * 7.0, bl = (horiz ? 0.9 : 0.55) + 0.4 * texture(tNoise, vec2(row * 0.211, 0.67)).g;
      float cell = floor(a2 / bl), fa = a2 / bl - cell, fb = fq.y / rowH - row;
      float dj = min(min(fa, 1.0 - fa) * bl, min(fb, 1.0 - fb) * rowH);
      float cr = texture(tNoise, vec2(cell * 0.0731 + row * 0.1301, row * 0.0937 + cell * 0.0413)).b;
      float tint = texture(tNoise, vec2(cell * 0.173 + 0.11, row * 0.239 + 0.37)).r;
      vec3 basalt = vec3(0.045, 0.044, 0.048), tuff = vec3(0.105, 0.09, 0.078), rust = vec3(0.3, 0.12, 0.045);
      vec3 c = mix(basalt, tuff, smoothstep(0.35, 0.7, tint)) * (0.75 + 0.5 * cr);
      float pit = texture(tNoise, fq * 7.3 + 0.2).r, pit2 = texture(tNoise, fq * 2.1 + 0.5).g;
      c *= 0.8 + 0.35 * pit2 - 0.25 * smoothstep(0.7, 0.9, pit);                                                        // vesicular pits
      float st = smoothstep(0.62, 0.92, texture(tNoise, vec2(fq.x * 1.9, fq.y * 0.06)).b);                           // runs of lava stain
      c = mix(c, rust * (0.6 + 0.8 * pit), st * 0.55 * (horiz ? 0.0 : 1.0));
      float sooty = smoothstep(0.35, 0.75, texture(tNoise, fq * 0.43 + 0.77).g);
      c *= 1.0 - 0.45 * sooty * (horiz ? 0.4 : 1.0);
      float rc = 1.0 - abs(2.0 * texture(tNoise, fq * 0.62 + 0.13).r - 1.0);
      c *= 1.0 - 0.7 * smoothstep(0.955, 0.985, rc);                                                                 // thermal cracks
      k = smoothstep(0.008, 0.03, dj);
      // the joint: a shadowed recess
      c *= mix(0.3, 1.0, k);
      return c;
    }
`;
  /* P118b: integer hashes of a 2D cell (pcg-style, the same on every GPU: no sin() hash): hc3 = three values in 0..1,
   * hc1 = one */
  const HASH_GLSL = /* glsl */`
    uvec2 hqc(vec2 p){
      uvec2 q = uvec2(ivec2(floor(p)) + 32768);
      q = q * 1664525u + 1013904223u;
      q.x += q.y * 1664525u;
      q.y += q.x * 1664525u;
      q ^= q >> 16u;
      q.x += q.y * 1664525u;
      q.y += q.x * 1664525u;
      q ^= q >> 16u;
      return q;
    }
    vec3 hc3(vec2 p){
      uvec2 q = hqc(p);
      return vec3(float(q.x & 0xffffu), float(q.x >> 16u), float(q.y & 0xffffu)) * (1.0 / 65536.0);
    }
    float hc1(vec2 p){ return float(hqc(p).y >> 8u) * (1.0 / 16777216.0); }
  `;
  /* P118b (QA1 Q-01): weathered cast concrete as a SURFACE (outside walls, the inside of bunkers and forts, slabs,
   * roads), the xc material weight of the terrain shader.
   * Walls: board-formed (boards 0.15 m with their own tint and wood grain, butt joints, fins in the seams), tie holes
   * on a 0.6 m grid (a few plugged with pale mortar, some with a rust run below), cold joints every 1.25 m, bug holes,
   * vertical wet streaks, a damp dark foot. Tops and soffits: formed or broom-finished sheets, panel joints every 2.4
   * m, hairline cracks, dirt patches. Returns the albedo; rel = a height (m) for the lit normal (grooves, tie cones,
   * grain: it fades with the pixel footprint fw). */
  const CONC_SURF = /* glsl */`
    vec3 concSurf(vec3 p, vec3 nW, float up, float fw, out float rel){
      rel = 0.0;
      bool hz = abs(nW.y) > 0.62;
      vec2 tq = hz ? p.xz : (abs(nW.x) > abs(nW.z) ? p.zy : p.xy);
      float mot = texture(tNoise, p.xz * 0.35 + p.y * 0.2).g, mot2 = texture(tNoise, tq * vec2(0.8, 0.45) + 0.3).r,
        mot3 = texture(tNoise, tq * 2.3 + 0.7).g;
      float kF = 1.0 - smoothstep(0.003, 0.012, fw), kM = 1.0 - smoothstep(0.012, 0.05, fw);
      vec3 c = vec3(0.27, 0.265, 0.25) * (0.8 + 0.3 * mot) * (0.9 + 0.2 * mot2) * (0.94 + 0.12 * mot3);
      float agg = texture(tNoise, tq * 9.0 + 0.2).b, agg2 = texture(tNoise, tq * 23.0 + 0.5).b;
      c *= 1.0 + (agg - 0.5) * 0.26 * (0.4 + 0.6 * kM) + (agg2 - 0.5) * 0.16 * kF;
      float aa = max(fw, 0.0015);
      if (!hz) {
        // boards: 0.15 m high, planks 2.4 m long with staggered butt joints; per plank tint and a stretched grain
        const float BH = 0.15, BL = 2.4;
        float by = tq.y / BH, bi = floor(by), bf = fract(by);
        float bx = tq.x / BL + hc1(vec2(bi, 7.0)), pj = floor(bx);
        vec3 hp = hc3(vec2(pj, bi));
        float grain = texture(tNoise, vec2(tq.x * 0.55 + hp.x * 13.0, tq.y * 5.5 + hp.y * 9.0)).g,
          grain2 = texture(tNoise, vec2(tq.x * 1.6 + hp.z * 7.0, tq.y * 21.0)).b;
        c *= (0.93 + 0.14 * hp.y) * (1.0 + (grain - 0.5) * 0.3 * kM + (grain2 - 0.5) * 0.2 * kF);
        float gd = min(bf, 1.0 - bf) * BH;
        float groove = 1.0 - smoothstep(0.0012, 0.0045, gd), fin = 1.0 - smoothstep(0.004, 0.016, bf * BH);
        c *= 1.0 - (0.2 * groove + 0.09 * fin) * mix(0.6, 1.0, kF);
        float jx = min(fract(bx), 1.0 - fract(bx)) * BL, bj = 1.0 - smoothstep(0.002, 0.006, jx);
        c *= 1.0 - 0.22 * bj * kM;
        rel += (-0.0015 * groove + 0.0008 * (grain - 0.5) + 0.0006 * (hp.y - 0.5) - 0.001 * bj) * kM;
        // cold joints between the pours (every 1.25 m), a thin dark seam with a pale lip
        float yl = tq.y / 1.25, lf = fract(yl), jd = min(lf, 1.0 - lf) * 1.25;
        float cj = 1.0 - smoothstep(0.003, 0.011, jd);
        c *= 1.0 - 0.3 * cj; rel -= 0.0012 * cj * kM;
        // tie holes: 0.6 m grid, a dark cone, some plugged with pale mortar, some with a rust run
        vec2 tc = (tq + vec2(0.3, 0.075)) / 0.6, tid = floor(tc);
        vec3 ht = hc3(tid + 41.0);
        float hd = length((fract(tc) - 0.5) * 0.6), hr = 0.013;
        float hole = 1.0 - smoothstep(hr * 0.75, hr, hd), ring = (1.0 - smoothstep(hr, hr * 2.2, hd)) * (1.0 - hole);
        float plug = step(0.78, ht.x);
        c = mix(c, c * 0.18, hole * (1.0 - plug) * mix(0.55, 1.0, kF));
        c = mix(c, vec3(0.34, 0.33, 0.3) * (0.9 + 0.2 * ht.y), hole * plug);
        c *= 1.0 - 0.16 * ring * (1.0 - plug);
        rel += -0.006 * hole * (1.0 - plug) * kM;
        float runx = (fract(tc.x) - 0.5) * 0.6, runy = (fract(tc.y) - 0.5) * 0.6;
        float run = (1.0 - smoothstep(0.003, 0.009 + 0.01 * ht.z, abs(runx))) * step(runy, 0.0) * (1.0 - smoothstep(0.0, 0.1 + 0.25 * ht.y, -runy)) * step(ht.x, 0.3);
        c = mix(c, c * vec3(0.72, 0.55, 0.42), run * 0.7);
        // bug holes and pinholes of the formed face
        vec2 bq = tq / 0.045, bid = floor(bq);
        vec3 hb = hc3(bid + 3.0);
        float bd = length((fract(bq) - vec2(0.2 + 0.6 * hb.x, 0.2 + 0.6 * hb.y)) * 0.045), br = 0.0016 + 0.0042 * hb.z * hb.z;
        float bug = (1.0 - smoothstep(br * 0.7, br, bd)) * step(0.85, hb.z * 0.5 + hb.x * 0.5 + 0.25) * kF;
        c = mix(c, c * 0.35, bug); rel -= 0.0008 * bug;
        // rain streaks down from the top edges and from the joints, a damp darker lower part
        float sx = tq.x * 0.9 + 0.3 * sin(tq.y * 0.5),
          st = smoothstep(0.55, 0.85, texture(tNoise, vec2(sx, tq.y * 0.035)).g) * smoothstep(0.35, 0.65, texture(tNoise, vec2(tq.x * 0.11, 0.55)).r);
        float st2 = smoothstep(0.8, 0.96, texture(tNoise, vec2(tq.x * 1.7 + 0.2, tq.y * 0.05)).b) * smoothstep(0.45, 0.75, texture(tNoise, vec2(tq.x * 0.17, 0.9)).r);
        c *= 1.0 - 0.3 * st * (1.0 - smoothstep(-0.3, 0.6, up)) - 0.07 * st2;
        c = mix(c, c * vec3(0.9, 0.98, 0.9), st * 0.35);
      } else {
        // tops, floors and soffits: sheets with joints every 2.4 m, a fine broom / trowel micro-texture, hairline
        // cracks, dirt patches
        float ax = 1.2 - abs(fract(tq.x / 2.4) - 0.5) * 2.4, ad = 1.2 - abs(fract(tq.y / 2.4 + 0.37) - 0.5) * 2.4;
        float jt = 1.0 - smoothstep(0.003, 0.012, min(ax, ad));
        float broom = texture(tNoise, vec2(tq.x * 1.4, tq.y * 31.0)).g;
        c *= 1.0 + (broom - 0.5) * 0.18 * kM;
        rel += 0.0005 * (broom - 0.5) * kM - 0.0015 * jt * kM;
        // joint lines, hairline cracks and dirt. S2 is defined for the play slab's material in 3D matches too, so the
        // test is the runtime one: only the 2D slab's floors seen from above skip them, because the caller paints its
        // own cast panels there (uSlab.x, up > 0.75)
        float kT = 1.0;
        #ifdef S2
        if (uSlab.x > 0.5 && up > 0.75) kT = 0.0;
        #endif
        c *= 1.0 - 0.34 * jt * kT;
        float cr = texture(tNoise, tq * vec2(0.55, 0.9) + 0.6).g;
        float crk = (1.0 - smoothstep(0.0, 0.012 + 0.6 * aa, abs(cr - 0.5))) * smoothstep(0.35, 0.6, texture(tNoise, tq * 0.21).b);
        c *= 1.0 - 0.5 * crk * kT;
        float dirt = smoothstep(0.5, 0.85, texture(tNoise, tq * vec2(0.13, 0.35) + 0.2).g);
        c *= 1.0 - 0.26 * dirt * kT;
      }
      return c;
    }
  `;
  const PLATE_GLSL = /* glsl */`
    uniform vec4 uPlA[24];
    uniform vec4 uPlB[24];
    uniform vec4 uPlC[24];
    uniform int uNPl;
    int plateIdx(vec3 P) {
      for (int i = 0; i < 24; i++) {
        if (i >= uNPl) break;
        vec3 U = uPlB[i].xyz, n = uPlC[i].xyz, V = cross(n, U), d = P - uPlA[i].xyz;
        if (abs(dot(d, U)) < uPlA[i].w + 0.25 && abs(dot(d, V)) < uPlB[i].w + 0.25 && abs(dot(d, n)) < uPlC[i].w + 0.25) return i;
      }
      return -1;
    }
    float plBolt(vec2 p, float pitch, float r) {                              // 1 inside a round bolt head
      vec2 q = (fract(p / pitch + 0.5) - 0.5) * pitch;
      return 1.0 - smoothstep(r * 0.8, r, length(q));
    }
    float plHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    // the colour at P on plate i with surface normal N; .a = polish (1 = mirror steel, 0 = dull frame)
    vec4 plateCol(int i, vec3 P, vec3 N) {
      vec3 U = uPlB[i].xyz, n = uPlC[i].xyz, V = cross(n, U), d = P - uPlA[i].xyz;
      float u = dot(d, U), v = dot(d, V), w = dot(d, n), hu = uPlA[i].w, hv = uPlB[i].w, hw = uPlC[i].w;
      float nv = abs(dot(N, V)), nw = abs(dot(N, n)), nu = abs(dot(N, U));
      vec3 steel = vec3(0.66, 0.68, 0.72), frame = vec3(0.47, 0.49, 0.53);
      if (nv > max(nu, nw)) {                                                  // the deck: coordinates (u, w)
        float fw = 0.22, ribP = 1.5, ribs = abs(fract(u / ribP + 0.5) - 0.5) * ribP;
        float edge = min(hu - abs(u), hw - abs(w));
        float onFrame = 1.0 - smoothstep(fw - 0.02, fw, edge), onRib = 1.0 - smoothstep(0.07, 0.09, ribs);
        float fr = max(onFrame, onRib);
        float brush = 0.93 + 0.07 * sin(w * 90.0 + plHash(vec2(floor(u * 3.0), 1.0)) * 6.0) + 0.04 * sin(w * 23.0);
        // darker toward the frame: the sheet is recessed
        float bevel = smoothstep(fw, fw + 0.12, edge) * smoothstep(0.09, 0.2, ribs);
        vec3 sheet = steel * brush * (0.80 + 0.2 * bevel);
        vec3 c = mix(sheet, frame * (0.92 + 0.08 * sin(u * 40.0)), fr);
        float bolt = max(plBolt(vec2(u, w), 0.4, 0.05) * max(onFrame * step(fw * 0.35, edge) * step(edge, fw * 0.8), 0.0), plBolt(vec2(u, w + 0.2), 0.4, 0.05) * onRib * step(0.02, ribs) * step(ribs, 0.06));
        c = mix(c, vec3(0.2, 0.21, 0.23), bolt * 0.9); c += bolt * vec3(0.5) * smoothstep(0.0, 0.5, bolt);
        return vec4(c, mix(0.95, 0.5, fr) - bolt * 0.3);
      }
      // end / side faces: frame steel with a bevelled lip
      float lip = smoothstep(0.0, 0.08, min(hv - abs(v), 0.08));
      return vec4(frame * (0.85 + 0.15 * lip), 0.4);
    }
    // the cut face of plate i at P (on the plane through its middle): a bridge-girder profile in (u, v)
    vec3 plateCut(int i, vec3 P) {
      vec3 U = uPlB[i].xyz, n = uPlC[i].xyz, V = cross(n, U), d = P - uPlA[i].xyz;
      float u = dot(d, U), v = dot(d, V), hu = uPlA[i].w, hv = uPlB[i].w;
      float fl = 0.11, flange = smoothstep(hv - fl - 0.02, hv - fl, abs(v)), ribs = abs(fract(u / 1.5 + 0.5) - 0.5) * 1.5,
        rib = 1.0 - smoothstep(0.06, 0.08, ribs);
      float endc = 1.0 - smoothstep(0.1, 0.13, hu - abs(u));
      vec3 web = vec3(0.30, 0.34, 0.40) * (0.88 + 0.08 * sin(v * 70.0) + 0.04 * plHash(vec2(floor(u * 5.0), 3.0)));
      vec3 fla = vec3(0.62, 0.66, 0.72) * (0.8 + 0.2 * cos(abs(v) / hv * 3.14159 * 4.0));         // a polished flange: a banded highlight
      vec3 c = mix(web, vec3(0.46, 0.5, 0.56), max(rib, endc));
      c = mix(c, fla, flange);
      float bolt = max(plBolt(vec2(u, abs(v) - hv + fl * 0.5), 0.45, 0.04) * flange, plBolt(vec2(u + 0.07, v * 2.0), 0.3, 0.035) * rib);
      c = mix(c, vec3(0.16, 0.17, 0.19), bolt * 0.85) + bolt * 0.12;
      return c;
    }`;
  /* P66b: crack damage (sim/cracks.js W.crack: one byte per lattice point, 3D texture tCrack, render/cracks.js) as dark
   * jagged lines: the
   * trilinear value crosses a threshold that wobbles with a fine noise (the sheet is 1-2 lattice points thick, so a
   * plain threshold would be a smooth 0.5 m band); the faint halo of micro damage stays below it. uCrackOn 0 = the
   * CRACKS lab flag is off: nothing is drawn. */
  const CRACK_GLSL = /* glsl */`
    uniform highp sampler3D tCrack;
    uniform float uCrackOn;
    uniform vec3 uCrackSize;
    float crackMask(vec3 p, float n1, float n2) {
      if (uCrackOn < 0.5) return 0.0;
      float c = texture(tCrack, (p * 2.0 + 0.5) / uCrackSize).r;
      float thr = 0.42 + 0.3 * (n1 - 0.5) + 0.12 * (n2 - 0.5);
      float m = smoothstep(thr, thr + 0.07, c);
      if (m <= 0.0) return 0.0;
      // P106: a CRACK is thin: along some axis the damage falls away within half a metre. A saturated blob (load-check
      // breaks, stacked blasts: damage 255 over a whole region) used to paint a flat dark fill over the cut face (the
      // user's brown patches); there the minimum over the three axes of the two-sided mean stays high, so only its
      // outline (the fracture surface) is drawn and the material shows through inside.
      vec3 q0 = (p * 2.0 + 0.5) / uCrackSize, st = 1.0 / uCrackSize;
      float ax = 0.5 * (texture(tCrack, q0 + vec3(st.x, 0.0, 0.0)).r + texture(tCrack, q0 - vec3(st.x, 0.0, 0.0)).r);
      float ay = 0.5 * (texture(tCrack, q0 + vec3(0.0, st.y, 0.0)).r + texture(tCrack, q0 - vec3(0.0, st.y, 0.0)).r);
      float az = 0.5 * (texture(tCrack, q0 + vec3(0.0, 0.0, st.z)).r + texture(tCrack, q0 - vec3(0.0, 0.0, st.z)).r);
      return m * (1.0 - smoothstep(0.55, 0.8, min(ax, min(ay, az))));
    }`;
  const COMMON = /* glsl */`
    uniform float uNL;   // the lattice columns per side (the textures and the water map are sized per map)
    ${CRACK_GLSL}
    ${FOAM_GLSL}
    ${PLATE_GLSL}
    float gMetal = 0.0;
    float fakeEnvK = 0.0;
    uniform highp sampler2DArray tMats;
    uniform sampler2D tNoise;
    uniform sampler2D tSurf;
    uniform sampler2D tScY;
    uniform sampler2D tWater;
    uniform sampler2D tCover;
    uniform float uPlayR;
    uniform highp sampler2D tLavaS;
    uniform float uLavaOn;
    uniform vec3 uO, uN, uHaze, uGrassTint, uDryTint, uSunDir, uCaveAmb;
    uniform vec4 uCloudSh;
    uniform float uVolc;
    // the organic-top table (config MATS[].veg) per weight slot (mA, mB, mC, mD): 1 = nothing grows on this material
    // (steel, foam, concrete, glass, ice, snow, lava, bedrock)
    uniform vec4 uNoVeg[4];
    vec3 gCaveEm = vec3(0.0);
    // P65c: drifting cloud shadows (xy = how far the wind aloft has carried them, z = cover, w = strength): patches of
    // the land lie in shade, the sun-lit rest keeps its colour
    float cloudShade(vec2 p){
      float n = texture(tNoise, (p - uCloudSh.xy) * 0.0055).a;
      return 1.0 - uCloudSh.w * smoothstep(0.62 - 0.26 * uCloudSh.z, 0.8 - 0.26 * uCloudSh.z, n);
    }

    ${HASH_GLSL}
    ${TUFF_GLSL}
    ${CONC_SURF}
    uniform float uHalf, uBack, uAlpha, uTime, uSea, uWet, uSnow, uCaustic, uDetail, uDbgBack, uCtxSolid, uCtxHaze, uBeach,
      uConcNight;
    uniform float uEow;
    ${EOW_GLSL}
    // the landscape behind the slab (mode 1, ad = m beyond its back face): the old ghost haze while it fades
    // (uCtxSolid 0); drawn solid (CX1) it still recedes into the haze with the slice-view setting (P29j, uCtxHaze).
    // P76: the haze starts at 0 right behind the slab's back face (a flat 16 % step there showed as a milky seam across
    // spires and dunes standing over the 1.5 m slab depth)
    #define CTX_HAZE(ad) ((0.12 + 0.4 * smoothstep(0.0, 50.0, ad)) * (1.0 - uCtxSolid) + (0.16 * smoothstep(0.0, 9.0, ad) + 0.36 * smoothstep(0.0, 55.0, ad)) * uCtxSolid * uCtxHaze)
    uniform vec4 uMatP[12];
    uniform vec3 uMatTint[12];
    uniform vec3 uLatR;
    uniform vec4 uRelief[12];
    uniform highp sampler3D tRel;
    uniform float uGlint[12];
    varying vec3 vW;
    varying vec3 vWN;
    varying float vDepth;
    varying vec4 vMA;
    varying vec4 vMB;
    varying vec4 vMC;
    varying vec4 vMD;
    // texture space: = world for terrain; where the rock came from for bodies
    varying vec3 vT;
    varying vec3 vTN;
    vec3 triA(float L, vec3 p, vec3 w, float sc){
      return texture(tMats, vec3(p.zy*sc, L)).rgb*w.x + texture(tMats, vec3(p.xz*sc, L)).rgb*w.y + texture(tMats, vec3(p.xy*sc, L)).rgb*w.z;
    }
    vec3 triAT(float L, vec3 p, vec3 w, float sc){
      vec3 a = triA(L, p, w, sc);
      if (uDetail < 0.5) return a;
      float n = texture(tNoise, p.xz*0.011 + p.y*0.004).a;
      vec3 b = triA(L, p*0.61 + vec3(13.1, 7.7, 3.3), w, sc*0.83);
      return mix(a, b, smoothstep(0.38, 0.62, n));
    }
    float caustic(vec3 p){
      vec2 q = p.xz*0.55;
      float a = texture(tNoise, q*0.31 + vec2(uTime*0.031, uTime*0.017)).g;
      float b = texture(tNoise, q*0.27 - vec2(uTime*0.024, -uTime*0.029) + 0.37).g;
      return pow(1.0 - abs(a - b), 9.0);
    }
    // Exposed voxel lava (a breached pocket before it drains; open lava is the fluid layer, render/lava.js): the
    // crust-cell texture with a slow churn. Explicit gradients (uniform control flow around the fetches).
    float lavaTex(vec2 uv, vec2 gx, vec2 gy){ return textureGrad(tMats, vec3(uv, 8.0), gx, gy).r; }
    float lavaFlow(vec3 p, vec2 dpx, vec2 dpy){
      vec2 uv = p.xz * 0.13;
      return mix(lavaTex(uv + vec2(0.0019, 0.0011) * uTime, dpx * 0.13, dpy * 0.13),
                 lavaTex(uv * 1.09 + vec2(-0.0012, 0.0016) * uTime + 0.37, dpx * 0.142, dpy * 0.142), 0.3);
    }
    // low-frequency triplanar noise in [-0.5, 0.5] with a per-material offset (material boundary wobble, ~2 m)
    float matNoise(vec3 p, vec3 bw, float m){
      vec2 o = vec2(m * 0.373, m * 0.719);
      if (uDetail < 0.5) {                                  // Low: one planar fetch (wall-ish projection)
        vec2 q = vec2(p.x + p.z, p.y + 0.4 * (p.x - p.z));
        vec4 n = texture(tNoise, q * 0.11 + o);
        return n.r - 0.5 + (texture(tNoise, q * 0.035 - o).g - 0.5) * 0.5;
      }
      vec3 q = p * 0.11;
      float a = texture(tNoise, q.yz + o).r * bw.x + texture(tNoise, q.xz + o).r * bw.y + texture(tNoise, q.xy + o).r * bw.z;
      vec3 q2 = p * 0.035;
      float b = texture(tNoise, q2.yz - o).g * bw.x + texture(tNoise, q2.xz - o).g * bw.y + texture(tNoise, q2.xy - o).g * bw.z;
      return a - 0.5 + (b - 0.5) * 0.5;
    }
    // LV2 relief height (m) from the 3D noise at the texture position p (moves with a rock piece). A = amplitudes of
    // the octaves with cells 2 m (R of an 8 m tile), 0.5 + 0.25 m (G + B), 9.4 cm and 4.7 cm (G, B of a 1.5 m tile).
    // Each octave fades out once the pixel footprint fw (m) passes 0.15-0.45 of its cell (the noise has no mipmaps:
    // fade before it aliases into sparkle); its slope variance goes to sv instead (added to roughness²: relief too fine
    // to resolve still spreads the highlight; Toksvig 2005).
    float reliefH(vec3 p, vec4 A, float fw, out float sv){
      vec4 c = texture(tRel, p * 0.125), f = texture(tRel, p * 0.6667 + 0.31);
      vec4 k = vec4(1.0) - vec4(smoothstep(0.3, 0.9, fw), smoothstep(0.075, 0.225, fw), smoothstep(0.014, 0.042, fw), smoothstep(0.007, 0.021, fw));
      vec4 sl = A / vec4(2.0, 0.5, 0.094, 0.047);                       // octave slopes (m/m)
      sv = dot((vec4(1.0) - k) * sl * sl, vec4(1.5));
      return A.x * (c.r - 0.5) * k.x + A.y * ((c.g - 0.5) + 0.5 * (c.b - 0.5)) * k.y + A.z * (f.g - 0.5) * k.z + A.w * (f.b - 0.5) * k.w;
    }
    // LV2 sun glints: sparse mirror-like facets, one per 2.5 cm cell of texture space where hash < density (stable:
    // the pattern is fixed in the rock), a disc around a jittered centre, tilted at random by up to ~0.3 rad; a facet
    // flashes only when it mirrors a light into the eye (glintLobe, in the lights loop). Faded below ~1 px (the
    // Toksvig roughness carries the unresolved part). pcg3d hash: Jarzynski & Olano 2020.
    uvec3 pcgG(uvec3 v){
      v = v * 1664525u + 1013904223u;
      v.x += v.y * v.z;
      v.y += v.z * v.x;
      v.z += v.x * v.y;
      v ^= v >> 16u;
      v.x += v.y * v.z;
      v.y += v.z * v.x;
      v.z += v.x * v.y;
      return v;
    }
    vec4 glintFacet(vec3 p, float fw, float dens){
      const float CS = 0.025;
      vec3 q = p / CS, c = floor(q);
      uvec3 ci = uvec3(ivec3(c) + 65536);
      vec3 h = vec3(pcgG(ci)) / 4294967295.0, h2 = vec3(pcgG(ci + 7919u)) / 4294967295.0;
      float d = length(q - c - (0.25 + 0.5 * h2));
      float m = step(h.x, dens) * (1.0 - smoothstep(0.2, 0.3, d)) * (1.0 - smoothstep(CS * 0.4, CS * 1.0, fw));
      return vec4((h.yzx * 2.0 - 1.0) * 0.3, m);
    }
    vec3 gFacetV = vec3(0.0, 0.0, 1.0);
    float gMask = 0.0;
    float glintLobe(vec3 Lv, vec3 Vv){
      if (gMask <= 0.0) return 0.0;
      vec3 R = reflect(-Vv, gFacetV);
      return gMask * pow(max(dot(R, Lv), 0.0), 150.0) * 12.0 * smoothstep(0.0, 0.1, dot(gFacetV, Lv));
    }

    /* P90: a fumarole IN the rock (user 2026-10-12: the P87 lathe rim read as a brown blob floating on the surface). No
     * mesh: the terrain
     * itself gets a small elongated crater: a noise-warped distance field in the slope plane around each vent (uVent
     * xyz + seed) drives
     * (a) the relief height, so the lit normals show a real bowl and a lumpy raised lip, (b) a sooty throat, (c) an
     * encrusted rim in ochre / pale yellow / white patches broken up by noise thresholds, (d) a wide heat stain with
     * sulphur efflorescence that thins into the basalt. Nothing has an edge: every mask is a smoothstep of a warped
     * distance, so the effect fades into the slope. */
    uniform vec4 uVent[8];
    uniform int uNVent;
    uniform float uVentHot;
    void ventLook(inout vec3 col, inout float rough, inout vec3 emis, inout float relief, vec3 pos, vec3 nW){
      for (int i = 0; i < 8; i++){
        if (i >= uNVent) break;
        vec4 v = uVent[i];
        vec3 dd = pos - v.xyz;
        float dl = length(dd);
        if (dl > 5.0) continue;
        vec3 tp = dd - nW * dot(dd, nW);
        float an = v.w * 6.2832;
        vec3 A = vec3(cos(an), 0.0, sin(an));
        A = normalize(A - nW * dot(A, nW) + vec3(0.0, 1e-4, 0.0));
        vec3 Bv = normalize(cross(nW, A));
        float u = dot(tp, A), sd = dot(tp, Bv);
        vec2 nq = vec2(u, sd) * 0.85 + v.w * 13.0;      // noise in the slope plane: no stretching on a steep face
        float n1 = texture(tNoise, nq).r, n2 = texture(tNoise, nq * 2.7 + 0.3).g, n3 = texture(tNoise, nq * 7.9 + 0.6).b,
          n4 = texture(tNoise, nq * 21.0 + 0.2).r;
        float d = sqrt(u * u * 0.4 + sd * sd) * (0.72 + 0.55 * n1 + 0.22 * (n2 - 0.5)) * 1.7;
        float bowl = 1.0 - smoothstep(0.1, 0.66, d);
        float throat = 1.0 - smoothstep(0.04, 0.3 + 0.08 * n2, d);
        float lip = smoothstep(0.36, 0.62, d) * (1.0 - smoothstep(0.66, 1.15, d));
        float heat = 1.0 - smoothstep(0.5, 3.4, d * (0.9 + 0.3 * n2));
        float ringU = (d - 0.58 + 0.3 * (n1 - 0.5)) / 0.3;
        float fb = 0.5 * n2 + 0.3 * n3 + 0.25 * n1, ringW = exp(-ringU * ringU), outW = exp(-d * 1.4);
        // a threshold map: broken patches, thickest on the lip, a few outliers further out
        float crust = smoothstep(0.8, 0.9, fb + 0.24 * ringW + 0.16 * outW + 0.12 * (n4 - 0.5) + 0.14 * clamp(u / (d + 0.4), -1.0, 1.0)) * (1.0 - smoothstep(0.8, 1.8, d));
        relief += -0.24 * pow(bowl, 0.85) + 0.1 * lip * (0.72 + 0.5 * n3) + 0.006 * (n3 - 0.5) * (bowl + lip);
        float lum = dot(col, vec3(0.3, 0.55, 0.15));
        col = mix(col, vec3(lum) * vec3(1.1, 0.95, 0.82) * 0.7, 0.2 * heat * (0.4 + n1));
        col *= 1.0 - 0.22 * heat * heat;
        vec3 ocher = mix(vec3(0.24, 0.17, 0.05), vec3(0.5, 0.43, 0.19), smoothstep(0.25, 0.8, n3 * 0.6 + n1 * 0.5));
        ocher = mix(ocher, vec3(0.62, 0.6, 0.52), smoothstep(0.55, 0.85, n4 * 0.5 + n2 * 0.5) * 0.6);
        ocher *= 0.8 + 0.4 * n4;
        float cA = crust * (0.8 - 0.7 * throat);
        col = mix(col, ocher, cA);
        float speck = smoothstep(0.8, 0.93, n4 * 0.55 + n3 * 0.5) * (1.0 - smoothstep(0.4, 2.2, d)) * 0.45;
        col = mix(col, vec3(0.86, 0.82, 0.55), speck);
        col = mix(col * (1.0 - 0.38 * bowl * bowl), vec3(0.012, 0.011, 0.012), throat * throat);
        rough = mix(rough, 0.97, max(heat * 0.5, max(cA, throat)));
        emis += vec3(0.9, 0.3, 0.06) * throat * throat * uVentHot;
      }
    }
    ${HOT}
    vec3 terrainColor(vec3 nW, out float rough, out vec3 emis, out float relief, out float glintD){
      gMetal = 0.0;
      vec3 bw = pow(abs(nW), vec3(4.0));
      bw /= (bw.x + bw.y + bw.z);
      vec2 dPx = dFdx(vT.xz), dPy = dFdy(vT.xz);           // uniform control flow (used by the lava branch)
      float fw = max(length(dFdx(vT)), length(dFdy(vT)));   // pixel footprint (m), for the relief octaves
      float Wt[12];
      Wt[0]=vMA.x;
      Wt[1]=vMA.y;
      Wt[2]=vMA.z;
      Wt[3]=vMA.w;
      Wt[4]=vMB.x;
      Wt[5]=vMB.y;
      Wt[6]=vMB.z;
      Wt[7]=vMB.w;
      Wt[8]=vMC.x;
      Wt[9]=vMC.y;
      Wt[10]=vMC.z;
      Wt[11]=vMC.w;
      int i1 = 1;
      float w1 = -1.0;
      int i2 = 1;
      float w2 = -1.0;
      float sum = 0.0;
      for (int i = 0; i < 12; i++){
        float v = Wt[i];
        sum += v;
        if (v > w1){
          w2 = w1;
          i2 = i1;
          w1 = v;
          i1 = i;
        } else if (v > w2){
          w2 = v;
          i2 = i;
        }
      }
      float nb = texture(tNoise, vT.xz*0.21 + vT.y*0.09).b, nz = texture(tNoise, vT.xz*0.05 + vT.y*0.02).g;
      #ifdef S2
      // P113: the 2D slab's ground (render/slab2d.js): s2w = 0 within 0.3 m of the gameplay plane, 1 from 1 m behind
      // it; s2h = the relief height field (the same one that moves the vertices)
      float s2d = -dot(vW - uO, uN), s2w = uSlab.x > 0.5 ? smoothstep(0.3, 1.0, s2d) : 0.0, s2h = 0.0;
      vec2 s2n = vec2(0.5);
      if (s2w > 0.0) {
        s2h = s2Field(vW.xz, s2d);
        s2n = vec2(texture(tNoise, vW.xz * vec2(0.17, 0.5) + vec2(0.3, s2d * 0.5)).g, texture(tNoise, vW.xz * vec2(0.43, 0.9) + vec2(0.7, s2d * 0.9)).r);
      }
      #endif
      // symmetric blend: each material's score = its share + its own noise; swapping i1/i2 gives 1 - t, so there is
      // no seam where the ranking flips (adding noise to t itself left a lattice-shaped seam = stair steps)
      vec3 bwn = pow(abs(nW), vec3(2.0));
      bwn /= (bwn.x + bwn.y + bwn.z);
      float dsc = (w2 - w1) / (w1 + w2 + 1e-4) + (matNoise(vT, bwn, float(i2)) - matNoise(vT, bwn, float(i1))) * 0.9;
      #ifdef S2
      // material seams wander with the depth: no straight line running into the slab
      dsc += s2w * (s2n.x - 0.5) * 0.7;
      #endif
      float t = w2 > 1e-3 ? smoothstep(-0.22, 0.22, dsc) : 0.0;
      vec4 P1 = uMatP[i1], P2 = uMatP[i2];
      vec3 c1 = triAT(float(i1), vT, bw, P1.x) * uMatTint[i1];
      vec3 c2 = triAT(float(i2), vT, bw, P2.x) * uMatTint[i2];
      vec3 col = mix(c1, c2, t);
      // P116 beach biome: the rock slot is red-brown rounded granite, the sand slot a fine pale warm sand (the shared
      // textures are a grey-brown crag and a rippled dune sand)
      float bwR = Wt[1] / max(sum, 1e-3), bwS = Wt[3] / max(sum, 1e-3);
      if (uBeach > 0.5) {
        float lmB = dot(col, vec3(0.3, 0.55, 0.15));
        // granite (the tors, the hill slopes, the voxel skin under the boulder meshes): warm red-brown, fine feldspar /
        // biotite speckle, a slow mottling (no crag texture) the speckle fades with the pixel footprint (the noise has
        // no mip maps: it would alias into a woven pattern at a distance)
        float gk1 = 1.0 - smoothstep(0.012, 0.05, fw), gk2 = 1.0 - smoothstep(0.03, 0.14, fw);
        vec3 gq = vT * 6.0;
        float gs1 = mix(0.5, texture(tNoise, gq.zy).b * bw.x + texture(tNoise, gq.xz).b * bw.y + texture(tNoise, gq.xy).b * bw.z, gk1);
        float gs2 = mix(0.5, texture(tNoise, gq.zy * 3.1 + 0.3).b * bw.x + texture(tNoise, gq.xz * 3.1 + 0.3).b * bw.y + texture(tNoise, gq.xy * 3.1 + 0.3).b * bw.z, gk1);
        float glf = texture(tNoise, vT.xz * 0.09 + vT.y * 0.06).a;
        float gm1 = texture(tNoise, vT.xz * 0.33 + vT.y * 0.21).a, gm2 = mix(0.5, texture(tNoise, vT.xz * 1.25 + vT.y * 0.7 + 0.4).g, gk2);
        // dark weathering streaks running down the faces
        float gst = smoothstep(0.55, 0.9, texture(tNoise, vec2(dot(vT.xz, vec2(0.83, 0.56)) * 1.4, vT.y * 0.07)).b);
        // pale grey-green lichen patches
        float gli = smoothstep(0.6, 0.82, gm2 * 0.6 + gm1 * 0.5);
        vec3 gbase = mix(vec3(0.5, 0.36, 0.3), vec3(0.65, 0.5, 0.42), glf) * (0.86 + 0.28 * gs1) * (0.78 + 0.44 * gm1);
        gbase *= 1.0 - 0.3 * gst * (1.0 - smoothstep(0.35, 0.85, nW.y));
        gbase = mix(gbase, vec3(0.6, 0.58, 0.44), gli * 0.4);
        gbase = mix(gbase, vec3(0.66, 0.54, 0.5), smoothstep(0.76, 0.9, gs2) * 0.65);
        gbase = mix(gbase, vec3(0.09, 0.07, 0.06), smoothstep(0.76, 0.92, 1.0 - gs2) * 0.45);
        vec3 granA = pow(gbase, vec3(2.2));
        vec3 sandA = pow(vec3(0.9, 0.82, 0.66), vec3(2.2)) * mix(1.0, lmB / 0.42, 0.18);
        col = mix(col, granA, bwR);
        col = mix(col, sandA, bwS);
      }
      col *= mix(vec3(0.94, 0.9, 0.86), vec3(1.07, 1.03, 0.97), nz);
      // volcanic ground (basalt 7, crust 9, ash 10) is black rock and tephra (user 2026-10-08: "black rocky ground,
      // not shiny plastic"): the source textures' red scoria specks and brown cast are muted toward charcoal
      float wv = (Wt[7] + Wt[9] + Wt[10]) / max(sum, 1e-3);
      col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))) * vec3(0.9, 0.93, 1.0) * 0.82, 0.6 * wv);
      // ice (slot 6): the source texture is a saturated ultramarine (user 2026-10-08, the shore ice "garish"); real
      // glacier / shore ice is pale blue-white with only a little blue in it
      float wi = Wt[6] / max(sum, 1e-3);
      col = mix(col, mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.3) * vec3(0.9, 0.97, 1.05) * 1.25 + vec3(0.06, 0.07, 0.08), 0.8 * wi);
      rough = mix(P1.y, P2.y, t);
      float poro = mix(P1.w, P2.w, t);
      vec4 RA = mix(uRelief[i1], uRelief[i2], t);
      if (uBeach > 0.5) RA *= 1.0 - 0.7 * bwR;                // (rounded boulders: smoother than a crag)
      float GD = mix(uGlint[i1], uGlint[i2], t);
      // surface state from the simulation (grass cover, dryness, char, burning)
      vec4 sf = texture(tSurf, (vT.xz * 2.0 + 0.5) / uNL);   // 193 columns, texel centres at x = i * 0.5
      #ifdef S2
      // grass in patches that break up with the depth, not one stripe along z
      sf.r *= 1.0 - 0.85 * s2w * (1.0 - smoothstep(0.3, 0.62, s2n.y + 0.28 * s2h));
      #endif
      float up = nW.y, sky = (1.0 - smoothstep(0.05, 0.35, vDepth));
      // no turf on a built, frozen or molten top: the share of the surface's weight that is steel / foam / concrete /
      // glass / ice / snow / lava / bedrock thins the cover out over the range those looks are painted in (0.2 - 0.55),
      // the same function the grass blades and the clutter use (meshgen veg_keep), so a rim of grass never fringes a
      // foam block or a roof
      float noVeg = dot(vMA, uNoVeg[0]) + dot(vMB, uNoVeg[1]) + dot(vMC, uNoVeg[2]) + dot(vMD, uNoVeg[3]);
      float vegOk = 1.0 - smoothstep(0.2, 0.55, noVeg);
      float cover = sf.r * smoothstep(0.55, 0.8, up + (nb - 0.5) * 0.25) * sky * vegOk;
      vec3 gT = triA(12.0, vT, bw, 0.33), dT = triA(13.0, vT, bw, 0.3);
      vec3 grass = mix(gT * uGrassTint, dT * uDryTint, smoothstep(0.35, 0.8, sf.g + (nz - 0.5) * 0.3));
      col = mix(col, grass, smoothstep(0.15, 0.6, cover));
      #ifdef S2
      col *= 1.0 + s2w * (0.34 * s2h + 0.14 * (s2n.x - 0.5));  // crests dry and pale, dips damp and dark
      col *= mix(vec3(1.0), mix(vec3(0.92, 0.9, 0.85), vec3(1.07, 1.04, 0.97), s2n.y), s2w * 0.9);
      #endif
      // weather cover (5e): per-column snow / ash depth from the sim (render/weather.js tCover: r / g = depth / 0.4 m)
      // on up-facing, sky-exposed surfaces; full from ~5 cm snow / ~3 cm ash, patchy below; uSnow = a uniform floor
      vec2 cvr = texture(tCover, (vT.xz * 2.0 + 0.5) / uNL).rg * 0.4;
      float upM = smoothstep(0.45, 0.75, up + (nb - 0.5) * 0.3) * sky;
      float sn = max(uSnow, cvr.x > 0.002 ? smoothstep(0.2, 0.8, cvr.x / 0.05 + (nb - 0.5) * 0.6) : 0.0) * upM;
      col = mix(col, triA(5.0, vT, bw, 0.2) * vec3(1.0, 1.02, 1.06), sn);
      rough = mix(rough, 0.6, sn); RA = mix(RA, uRelief[5], sn); GD = mix(GD, uGlint[5], sn);
      float ashC = (cvr.y > 0.002 ? smoothstep(0.2, 0.8, cvr.y / 0.03 + (nz - 0.5) * 0.6) : 0.0) * upM;
      col = mix(col, vec3(0.085, 0.08, 0.078) * (0.8 + 0.4 * nb), ashC);
      rough = mix(rough, 0.95, ashC); RA = mix(RA, uRelief[10], ashC); GD = mix(GD, uGlint[10], ashC);
      // char / scorch
      // P65b: blast soot is gated to the height it was made at (+- its radius): a wall keeps no stripe down the whole
      // column
      vec4 scy4 = texture(tScY, (vT.xz * 2.0 + 0.5) / uNL);
      vec2 scy = scy4.rg * 255.0;
      float scGate = scy.y > 0.0 ? 1.0 - smoothstep(0.55, 1.0, abs(vW.y - scy.x * 0.25) / (scy.y * 0.125)) : 1.0;
      // P65k: freshly dug ground (the crater and its rim): moister, darker, redder subsoil under the weathered surface,
      // drying out with distance from the pit
      col *= mix(vec3(1.0), vec3(0.6, 0.53, 0.47), scy4.b * scGate * (0.8 + 0.4 * nb));
      col = mix(col, vec3(0.045, 0.04, 0.038) + col * 0.12, sf.b * scGate * (0.65 + 0.35 * nb));
      // P66b: cracks
      if (uCrackOn > 0.5 && distance(vT, vW) < 0.001) {
        vec2 ckn = texture(tNoise, vW.xz * 1.9 + vW.y * 1.3).rg;
        float ckm = crackMask(vW, ckn.x, ckn.y);
        col = mix(col, vec3(0.028, 0.024, 0.021), ckm * 0.92);
        rough = mix(rough, 0.97, ckm);
      }
      // overhangs / cave ceilings: darker, cooler
      col *= mix(1.0, 0.6, (1.0 - smoothstep(-0.8, -0.2, up)));
      // rain (LV2; Lagarde 2013 "Water drop 2b"): water fills the pores of porous ground (darker; little film on top,
      // so it stays fairly matte: ~0.55-0.6), a film runs on dense rock (~0.35-0.4), always over the rock's relief
      // (the normals below): many small broken highlights, never one smooth lobe. Mirror-like only in puddles (film).
      // (Before: 0.18 + 0.3 (1 - poro) on the smooth mesh normals: soil 0.24 = a plastic bag.)
      float wet = uWet * (0.25 + 0.75 * smoothstep(-0.3, 0.6, up));
      col *= 1.0 - wet * poro * 0.42; rough = mix(rough, min(rough, mix(0.3, 0.62, poro)), wet);
      GD = max(GD, wet * (0.04 + 0.1 * (1.0 - poro)));    // film beads on wet ground, more on dense rock
      // water: wet band, depth tint and caustics below the (simulated) surface
      // tWater: render/water.js map (one texel per column: r surface or bed, g depth, b foam, a wetness)
      vec4 wt = texture(tWater, (vW.xz * 2.0 + 0.5) / uNL);
      // g < 0: dry bank next to water (signed depth)
      float surf = wt.g > -0.6 ? wt.r : -99.0;
      float under = surf - vW.y;
      float wetB = smoothstep(-0.45, 0.0, under);
      wetB = max(wetB, wt.a * smoothstep(-0.7, -0.1, wt.r - vW.y));   // (a recent run-up dries slowly)
      // P61: wave lapping on the beach: the run-up edge oscillates (travelling along the shore), the sand behind it is
      // a darker wet band and a thin lace of foam stays on the edge (sea level beaches only)
      float lapFoam = 0.0;
      if (wt.r > uSea - 0.5 && wt.r < uSea + 0.4) {
        float lnz = texture(tNoise, vW.xz * 0.35).b;
        float lapS = 0.5 + 0.5 * sin(uTime * 0.8 + vW.x * 0.35 + vW.z * 0.3 + lnz * 4.0);
        float u2 = uSea + 0.04 + 0.2 * lapS - vW.y;
        float nearSea = smoothstep(0.8, 0.2, abs(vW.y - uSea));
        wetB = max(wetB, smoothstep(-0.14, 0.0, u2) * nearSea);
        wetB = max(wetB, 0.7 * smoothstep(-0.9, -0.15, u2 - 0.1 * lapS) * nearSea);
        float lnz2 = texture(tNoise, vW.xz * 1.7 + vec2(uTime * 0.02, 0.0)).g;
        float lapU = (u2 + 0.01) / 0.03;
        lapFoam = exp(-lapU * lapU) * smoothstep(0.3, 0.7, lnz * 0.5 + lnz2 * 0.7) * nearSea * step(0.0, u2 + 0.1);
      }
      // wet sand loses ~40 % albedo; wet rock darkens too (film fills its micro-relief)
      col *= mix(vec3(1.0), mix(vec3(0.5), vec3(0.45, 0.36, 0.26), uBeach), wetB * (0.45 + 0.55 * poro));
      // a sheen near the water only; damp ground stays matte
      rough = mix(rough, 0.3 + 0.3 * (1.0 - poro), wetB * 0.7 * smoothstep(-0.45, 0.0, under));
      // water film: the smoothed mesh lies a few cm above the simulated bed in concave floors (one vertex per cell),
      // so a shallow pool's water is under it: terrain just above the surface of a wet column reads as a film
      float film = smoothstep(0.0, 0.02, wt.g) * smoothstep(-0.07, -0.005, under);
      col *= mix(1.0, 0.8, film);
      rough = mix(rough, 0.07, film);
      RA *= (1.0 - film) * uDetail;                       // a puddle's water surface is flat (and Low has no relief)
      GD *= (1.0 - film) * (1.0 - smoothstep(-0.05, 0.05, under)) * uDetail * sky;   // none in puddles, under water, caves
      col = mix(col, vec3(0.95, 0.97, 1.0), lapFoam * (0.7 - 0.55 * uBeach) * (1.0 - smoothstep(0.0, 0.1, under)));
      if (under > 0.0) {
        col *= mix(vec3(1.0), mix(vec3(0.42, 0.66, 0.72), vec3(0.56, 0.74, 0.58), uBeach), smoothstep(0.0, 2.0, under));
        col += uCaustic * (1.0 - 0.8 * uBeach) * caustic(vW) * vec3(0.55, 0.7, 0.62) * smoothstep(0.0, 0.35, under) * exp(-under * 0.6) * max(up, 0.2);
        // P116: the sea floor is not one sand sheet: darker patches of weed, reef and rock rubble
        if (uBeach > 0.5) {
          float pn = texture(tNoise, vW.xz * 0.045).a * 0.6 + texture(tNoise, vW.xz * 0.16 + 0.3).g * 0.4;
          float pat = smoothstep(0.46, 0.7, pn) * smoothstep(0.1, 0.8, under);
          col = mix(col, col * vec3(0.3, 0.38, 0.2), pat * 0.75);
        }
        rough = 0.4;
      }
      // lava glow (fresh lava = slot 8, crust = slot 9 with faint cracks)
      float wl = Wt[8] / max(sum, 1e-3), wc = Wt[9] / max(sum, 1e-3);
      emis = vec3(0.0);
      if (wl + wc > 0.01) {
        float lf = lavaFlow(vT, dPx, dPy);
        float pulse = 0.88 + 0.12 * sin(uTime * 0.6 + vT.x * 0.5 + vT.z * 0.4);
        // crust: only a faint dull-red residual heat in the deepest cracks (it is cold rock; open lava is
        // render/lava.js)
        emis = wl * pow(lf, 1.9) * 3.8 * pulse * vec3(1.0, 0.34, 0.06) + wc * pow(lf, 5.0) * (uEow > 0.5 ? 2.2 : 0.45) * vec3(1.0, 0.2, 0.03);
        // P68g: the colour follows the temperature (render/eowview.js)
        if (uEow > 0.5) emis = eoLava(vW, wl, wc, lf, pulse);
        col = mix(col, vec3(0.12, 0.06, 0.04), wl * 0.6);
      }
      // P65d: the ground within ~0.6 m of open lava is heated: a dull orange glow that dies off with the distance to
      // the nearest lava column (no hard line where the lava meets the ground)
      if (uLavaOn > 0.5) {
        ivec2 lb = ivec2(floor(vW.xz / 0.5)), lmx = textureSize(tLavaS, 0) - 1;
        float lh = 0.0;
        for (int j = -1; j <= 2; j++)
          for (int i = -1; i <= 2; i++) {
          ivec2 lc = lb + ivec2(i, j);
          vec4 q = texelFetch(tLavaS, clamp(lc, ivec2(0), lmx), 0);
          if (q.y > 0.012 && abs(vW.y - q.x) < 0.7) {
            vec2 d = vec2(lc) * 0.5 - vW.xz;
            lh = max(lh, exp(-dot(d, d) / 0.2) * smoothstep(0.012, 0.08, q.y));
          }
        }
        float lpulse = 0.85 + 0.15 * sin(uTime * 0.9 + vT.x * 1.7 + vT.z * 1.3);
        emis += lh * lh * 1.1 * lpulse * vec3(1.0, 0.27, 0.04) * (1.0 - wl);
        col = mix(col, col * vec3(0.55, 0.45, 0.4), lh * 0.5);
      }
      // burning grass: glowing embers in the cover band (S.veg.surf a), none where the organic-top table says nothing
      // grows
      float emberK = sf.a * vegOk;
      if (emberK > 0.01)
        emis += emberK * sky * smoothstep(0.35, 0.7, nb + 0.25 * sin(uTime * 3.0 + vT.x * 2.0 + vT.z * 1.7)) * 1.4 * vec3(1.0, 0.3, 0.05);
      col = hotSand(col, vW, up, emis);
      // P7 (PoC materials): girder steel = painted orange-brown plate with darker truss bars and rivet rows;
      // foam-mortar foam = pale, bubbly, matte (vMD: their weights, 0..1, outside the 12 texture slots)
      float xs = vMD.x, xf = vMD.y, xc = vMD.z, xo = vMD.w;
      // P31 obsidian (lava quenched by water): black volcanic glass, glossy, with faint conchoidal (shell-fracture)
      // ripples and a grey sheen; no grain
      if (xo > 0.02) {
        float cf = texture(tNoise, vT.xz * 0.9 + vT.y * 0.7).r, rip = 0.5 + 0.5 * sin(cf * 26.0 + vT.y * 3.0);
        vec3 obs = vec3(0.028, 0.026, 0.032) * (0.85 + 0.3 * rip) + vec3(0.02, 0.022, 0.026) * smoothstep(0.6, 0.9, cf);
        float ko = smoothstep(0.2, 0.55, xo);
        col = mix(col, obs, ko);
        rough = mix(rough, 0.16, ko);
        RA *= 1.0 - ko * 0.6;
        GD *= 1.0 - ko;
        emis *= 1.0 - ko;
      }
      // ASSET: tex_concrete (docs/ASSET_PROMPTS.md: textures/concrete_*.png, board-formed; this procedural look is the
      // stand-in) P29d bunker concrete: weathered grey cast concrete, horizontal board-formwork lines (0.3 m lifts),
      // fine aggregate speckle, darker rain-streaked stains running down from edges and a damp darker foot
      float cRel = 0.0, kcR = 0.0;
      if (xc > 0.02) {
        float kj = 1.0;
        bool hzc = abs(nW.y) > 0.62;
        vec2 tqc = hzc ? vT.xz : (abs(nW.x) > abs(nW.z) ? vT.zy : vT.xy);
        vec3 conc;
        if (uVolc > 0.5) conc = tuffMasonry(tqc, hzc, up, kj);
        else if (uBeach > 0.5) conc = pow(graniteMasonry(tqc, hzc, up, kj), vec3(2.2));
        // (at night the moon's blue is taken out of grey concrete a little: the cut face is graded the same way,
        // capPost)
        else conc = concSurf(vT, nW, up, fw, cRel) * mix(vec3(1.0), vec3(1.1, 0.99, 0.84), uConcNight);
        #ifdef S2
        if (uSlab.x > 0.5 && up > 0.75) {
          // P113 fort / ruin floors seen from above: cast panels with joints, rain stains, hairline cracks and moss
          // creeping in from the back edge (the deck used to be one flat grey extrusion)
          float ax = 1.2 - abs(fract(vW.x / 2.4) - 0.5) * 2.4, ad = 0.55 - abs(fract(s2d / 1.1 + 0.37) - 0.5) * 1.1;
          float joint = 1.0 - smoothstep(0.012, 0.034, min(ax, ad));
          float st = smoothstep(0.5, 0.85, texture(tNoise, vW.xz * vec2(0.13, 0.35) + 0.2).g),
            cr = texture(tNoise, vW.xz * vec2(0.55, 0.9) + 0.6).g;
          float crack = (1.0 - smoothstep(0.0, 0.014, abs(cr - 0.5))) * smoothstep(0.35, 0.6, texture(tNoise, vW.xz * 0.21).b);
          float mo = smoothstep(0.52, 0.8, texture(tNoise, vW.xz * vec2(0.3, 0.8) + 0.4).r + 0.35 * smoothstep(0.5, 1.3, s2d) - 0.2);
          conc *= 1.0 - 0.3 * st - 0.4 * joint - 0.5 * crack;
          conc = mix(conc, vec3(0.13, 0.17, 0.07) * (0.7 + 0.6 * texture(tNoise, vW.xz * 2.3).g), 0.7 * mo * smoothstep(0.3, 1.0, s2d));
        }
        #endif
        float kc = smoothstep(0.2, 0.55, xc);
        kcR = kc;
        col = mix(col, conc, kc);
        rough = mix(rough, uVolc > 0.5 ? 0.97 : 0.9, kc);
        RA *= 1.0 - kc * 0.7;
        GD *= 1.0 - kc;
        emis *= 1.0 - kc;
      }
      if (xs + xf > 0.02) {
        vec2 q = vec2(dot(vT.xz, vec2(0.7071)), vT.y) * 2.2;
        float bar = 1.0 - smoothstep(0.06, 0.12, min(abs(fract(q.x + q.y) - 0.5), abs(fract(q.x - q.y) - 0.5)));
        float rv = 1.0 - smoothstep(0.08, 0.13, length(fract(q * 2.0) - 0.5));
        vec3 steel = vec3(0.47, 0.24, 0.12) * (0.85 + 0.3 * nb) * (1.0 - 0.38 * bar) + vec3(0.12, 0.1, 0.08) * rv;
        // P37 W4: the foam skin: the honeycomb as a white relief (triplanar on the dominant axis of the normal) + a
        // little bubble noise
        float bub = texture(tNoise, vT.xz * 3.1 + vT.y * 1.7).r;
        vec2 fq = abs(nW.y) > 0.62 ? vT.xz : (abs(nW.x) > abs(nW.z) ? vT.zy : vT.xy);
        vec3 foam = foamLook(fq, 0.3, up * 0.5 + 0.5) * (0.96 + 0.04 * smoothstep(0.3, 0.7, bub));
        float ks = smoothstep(0.2, 0.55, xs), kf = smoothstep(0.2, 0.55, xf);
        col = mix(mix(col, steel, ks), foam, kf);
        // (P37: foam self-lights a little: white in any light)
        rough = mix(mix(rough, 0.42, ks), 0.9, kf);
        RA *= 1.0 - max(ks, kf);
        GD *= 1.0 - max(ks, kf);
        emis *= 1.0 - max(ks, kf);
        emis += kf * vec3(0.16, 0.17, 0.185);
      }
      // P37 W4: the girder plate: frame, sheets and bolts in plate-local coordinates, polished (see PLATE_GLSL)
      if (xs > 0.02 && uNPl > 0) {
        int pi = plateIdx(vW);
        if (pi >= 0) {
          vec4 pc = plateCol(pi, vW, nW);
          vec3 V3 = normalize(cameraPosition - vW), R = reflect(-V3, nW);
          vec3 env = mix(vec3(0.30, 0.27, 0.24), mix(vec3(0.88, 0.9, 0.94), vec3(0.42, 0.6, 0.92), smoothstep(0.1, 0.85, R.y)), smoothstep(-0.2, 0.08, R.y));
          float fres = 0.18 + 0.82 * pow(1.0 - max(dot(nW, V3), 0.0), 4.0), sun = pow(max(dot(R, normalize(uSunDir)), 0.0), 120.0);
          float kp = smoothstep(0.2, 0.55, xs);
          col = mix(col, pc.rgb, kp); rough = mix(rough, mix(0.5, 0.2, pc.a), kp); gMetal = kp * 0.7 * pc.a;
          emis += kp * pc.a * (env * fres * pc.rgb * 0.75 + vec3(sun * 1.6));
        }
      }
      if (uEow > 0.5 && xs + xc > 0.02) eoHull(vT, nW, xs, xc, col, rough, emis, RA, GD);   // P68d: the wrecked hull (render/eowview.js)
      float sv;
      relief = reliefH(vT, RA, fw, sv) + cRel * kcR;
      glintD = GD;
      #ifdef S2
      if (s2w > 0.0) {
        // P113 sand: wind ripples across the dune (crests run along the depth, wobbling with a noise), pale crests,
        // darker troughs
        float sandW = Wt[3] / max(sum, 1e-3);
        if (sandW > 0.05 && up > 0.6) {
          float ph = vW.x * 5.2 + 1.7 * texture(tNoise, vW.xz * vec2(0.35, 0.8) + 0.2).g + 0.35 * s2h;
          float rp = sin(ph * 6.2832) * (1.0 - smoothstep(0.03, 0.1, fw)) * sandW * s2w;
          relief += 0.011 * rp; col *= 1.0 + 0.07 * rp;
        }
        // P113 snow: soft wind-packed drifts (low sastrugi lines) over the lumps
        float snW = Wt[5] / max(sum, 1e-3);
        if (snW > 0.05) {
          float sp = texture(tNoise, vW.xz * vec2(0.9, 1.9) + 0.4).b - 0.5;
          relief += 0.02 * sp * snW * s2w * (1.0 - smoothstep(0.05, 0.2, fw));
        }
      }
      #endif
      rough = min(1.0, sqrt(rough * rough + sv));
      #ifdef S2
      if (uS2D > 0.5) col = vec3(s2d / 1.5, fract(s2d * 4.0), 0.0);
      #endif
      // the cracks of a fresh vacuum crater (render/eowview.js; nothing where there is none)
      emis += eoCrater(vW);
      return col;
    }
  `;

  /* P61: surface ambient occlusion from the world density volume: a few taps along the normal (solid within 0.4 / 1.0 /
   * 2.2 m darkens:
   * crevices, the foot of a cliff, the ground under an overhang) plus a slight sideways spread so flat ground stays
   * clean. */
  const CON_AO = /* glsl */`
    uniform vec4 uCon[24];
    uniform int uNCon;
    /* P65b contact shadows (render/ground.js): soft blobs round the feet of props / graves / devices; the distance is
     * 3D, so the shade wraps the ground */
    float conAO(vec3 p){
      float a = 0.0;
      for (int i = 0; i < 24; i++) {
        if (i >= uNCon) break;
        vec4 c = uCon[i];
        vec3 d = (p - c.xyz) * vec3(1.0, 1.6, 1.0);
        a += (1.0 - smoothstep(0.2 * c.w, c.w, length(d))) * step(0.01, c.w);
      }
      return 1.0 - 0.46 * min(a, 1.0);
    }
  `;
  const SURF_AO = /* glsl */`
    uniform highp sampler3D tVol;
    uniform vec3 uVolSize;
    ${CON_AO}
    float aoSolid(vec3 p){ return texture(tVol, (p / 0.5 + 0.5) / uVolSize).r > 0.0 ? 1.0 : 0.0; }
    float surfAO(vec3 p, vec3 n){
      vec3 t = normalize(abs(n.y) > 0.9 ? cross(n, vec3(1.0, 0.0, 0.0)) : cross(n, vec3(0.0, 1.0, 0.0)));
      vec3 b = cross(n, t);
      vec3 q = p + n * 0.15;
      float a = aoSolid(q + n * 0.4) * 1.0 + aoSolid(q + n * 0.4 + t * 0.5) * 0.5 + aoSolid(q + n * 0.4 - b * 0.5) * 0.5
              + aoSolid(q + n * 1.0 + t * 0.9) * 0.8 + aoSolid(q + n * 1.0 - t * 0.9 + b * 0.5) * 0.8
              + aoSolid(q + n * 2.2 + b * 1.6) * 0.6 + aoSolid(q + n * 2.2 - b * 1.6 - t * 0.8) * 0.6;
      return 1.0 - 0.72 * clamp(a / 4.0, 0.0, 1.0);
    }
  `;
  function patchVertex(sh, body, slab) {
    sh.vertexShader = 'attribute float depth; attribute vec4 mA; attribute vec4 mB; attribute vec4 mC; attribute vec4 mD;\nvarying vec3 vW; varying vec3 vWN; varying float vDepth; varying vec4 vMA; varying vec4 vMB; varying vec4 vMC; varying vec4 vMD;\nvarying vec3 vT; varying vec3 vTN;\n' +
      (body ? 'attribute vec3 tpos;\n' : '') +
      (
        slab ? 'uniform vec3 uO, uN; uniform highp sampler2D tLavaS; uniform float uLavaOn;\n' + SS.slab2d.GLSL + SS.slab2d.VERT + '\n' : ''
      ) +
        sh.vertexShader.replace('#include <beginnormal_vertex>', slab ? /* glsl */`#include <beginnormal_vertex>
        float s2h = 0.0;
        if (uSlab.x > 0.5) s2Vert((modelMatrix * vec4(position, 1.0)).xyz, mD, objectNormal, s2h);` : '#include <beginnormal_vertex>').replace(
          '#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        ${slab ? 'transformed.y += s2h;' : ''}
        vW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWN = normalize(mat3(modelMatrix) * objectNormal);
        vDepth = depth;
        vMA = mA;
        vMB = mB;
        vMC = mC;
        vMD = mD;
        ${body ? 'vT = tpos; vTN = normalize(objectNormal);' : 'vT = vW; vTN = vWN;'}`
        );
  }
  /* mode 0 slab, 1 context far colour, 2 context far depth pre-pass, 3 context near */
  /* body = true: material for a detached rock piece (render/bodies.js): textured in the piece's own frame (tpos) */
  /* P101: the terrain program carries the env sampler (+0.1..0.3 ms on high) only where the ground can reflect the sky:
   * wet ground (rain / storm),
   * the volcanic island (obsidian), the End of the World (steel hull). Elsewhere a program variant without USE_ENVMAP
   * is compiled. */
  const ENVMATS = [];
  let envOn = false, envOff = 0;
  function setEnv(on) {
    if (on === envOn) return;
    envOn = on;
    for (const m of ENVMATS) m.needsUpdate = true;
  }
  function terrainMaterial(mode, body) {
    const opts = { roughness: 0.92, metalness: 0, side: mode === 0 ? T.DoubleSide : T.FrontSide };
    if (mode === 3) Object.assign(opts, { transparent: true, depthWrite: false });
    const m = new T.MeshStandardMaterial(opts);
    ENVMATS.push(m);
    m.userData.sectionMargin = 0;                         // P46: the terrain's front limit is slice zero itself (render/section.js)
    if (mode === 0) m.shadowSide = T.DoubleSide;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, U, EOWU);
      // P101: dry ground has nothing to reflect: the env sampler is compiled out of this variant
      if (!envOn) sh.fragmentShader = '#undef USE_ENVMAP\n' + sh.fragmentShader;
      if (mode === 0 && !body) Object.assign(sh.uniforms, { tVol: { value: volTex }, uVolSize: { value: VOLSIZE } });
      const slab = mode === 0 && !body;                 // P113: the 2D slab's ground relief (render/slab2d.js)
      if (slab) Object.assign(sh.uniforms, SS.slab2d.U);
      patchVertex(sh, body, slab);
      // slice zero (t = 0) is the collision section: the slab is everything from -uBack up to it, nothing in front
      // D6: a dry world's lattice is drawn only inside the disc uLatR (x, z, r; r 0 = off): the far grid beyond it
      // (render/dunes.js); rock pieces (body) are never clipped
      // P105: a falling piece is never cut at the back (thin slice view): its far half was clipped away and the piece
      // showed as a hollow shell; the whole piece is hidden by its centre instead (render/bodies.js). P113: the 2D slab
      // clips at its ragged back edge.
      const clip = (
        mode === 0 ? (body ? '' : slab ? 'if (tD < -(uSlab.x > 0.5 ? s2Edge(vW.x) : uBack)) discard;' : 'if (tD < -uBack) discard;')
        : mode === 3 ? 'if (tD < 0.0) discard;' : 'if (tD > -uBack) discard;'
      ) +
        (body ? '' : ' if (uLatR.z > 0.0 && distance(vW.xz, uLatR.xy) > uLatR.z) discard;');
      sh.fragmentShader = (slab ? '#define S2 1\n' + SS.slab2d.GLSL : '')
        + COMMON
        + (mode === 0 && !body ? SURF_AO : '')
        + sh.fragmentShader
          .replace('#include <clipping_planes_fragment>', /* glsl */`#include <clipping_planes_fragment>
          float tD = dot(vW - uO, uN);
          ${clip}`)
          .replace('#include <map_fragment>', /* glsl */`
          vec3 nW = normalize(vWN);
          float tRough, tRelief, tGlint;
          vec3 tEmis;
          vec3 col = terrainColor(normalize(vTN), tRough, tEmis, tRelief, tGlint);
          ${body ? '' : 'if (uVolc > 0.5 && uNVent > 0 && gl_FrontFacing) ventLook(col, tRough, tEmis, tRelief, vW, nW);'}
          ${mode === 0 ? `if (!gl_FrontFacing) { col = texture(tMats, vec3(vT.xz*0.1 + vT.y*0.07, 14.0)).rgb * 0.35; tEmis = vec3(0.0);
            col = mix(col, vec3(0.88, 0.92, 0.97), smoothstep(0.2, 0.55, vMD.y));   // P37 W4: the inside of foam is white, not dark
            if (uDbgBack > ${body ? '0.5' : '1.5'}) { col = vec3(0.0); tEmis = vec3(4.0, 0.0, 4.0); } }` : ''}
          ${mode === 0 && !body ? 'if (gl_FrontFacing && uDetail > 0.5) col *= surfAO(vW, nW) * conAO(vW);' : ''}
          col *= cloudShade(vW.xz);
          {   /* P65i: caves are not black. Rock under a roof (vDepth = metres of solid above the vertex) still gets skylight scattered in through the
               * mouth and bounced off the walls: a fraction of the hemisphere ambient (uCaveAmb, set per frame from the real hemi light), fading with
               * the depth into the rock; the seeping wet rock shines a little (lower roughness, darker albedo) */
            float cvK = smoothstep(0.5, 2.5, vDepth), cvF = 0.35 + 0.65 * exp(-max(vDepth - 2.0, 0.0) * 0.1);
            gCaveEm = col * uCaveAmb * cvK * cvF;
            col *= 1.0 - 0.18 * cvK;
          }
          diffuseColor.rgb = col;
          ${mode === 1 || mode === 3 ? /* glsl */`
            float ad = ${mode === 1 ? '-tD - uBack' : 'tD'};
            ${mode === 3 ? 'diffuseColor.a = uAlpha * 0.26 * exp(-ad / 12.0) * smoothstep(7.0, 22.0, distance(vW, cameraPosition));' : ''}
            diffuseColor.rgb = mix(col, uHaze, ${mode === 1 ? 'CTX_HAZE(ad)' : '(0.12 + 0.4 * smoothstep(0.0, 50.0, ad))'});` : ''}
        `)
          .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
          roughnessFactor = tRough * (1.0 - 0.3 * smoothstep(0.5, 2.5, vDepth));`)
          .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n metalnessFactor = gMetal;')
          // LV2 relief normals: Mikkelsen 2010 surface gradient from screen-space derivatives of the relief height (m)
          .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
          {
            vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
            float bx = dFdx(tRelief), by = dFdy(tRelief);
            vec3 r1 = cross(dpy, normal), r2 = cross(normal, dpx);
            float det = dot(dpx, r1);
            normal = normalize(abs(det) * normal - sign(det) * (bx * r1 + by * r2));
            float fwG = max(length(dFdx(vT)), length(dFdy(vT)));
            vec4 gf = glintFacet(vT, fwG, tGlint);
            gMask = gf.w;
            gFacetV = normalize(normal + (viewMatrix * vec4(gf.xyz, 0.0)).xyz);
          }`)
          .replace('#include <lights_fragment_begin>', LFB_GLINT || '#include <lights_fragment_begin>')
          .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
          totalEmissiveRadiance += tEmis + gCaveEm;`);
    };
    m.customProgramCacheKey = () => 'terrain2'
      + mode
      + (body ? 'b' : '')
      + (U.uDetail.value > 0.5 ? 'd' : '')
      + (envOn ? '' : 'n');
    return m;
  }
  /* shadow pass for the slab: same clip */
  function slabDepthMaterial() {
    const m = new T.MeshDepthMaterial({ depthPacking: T.RGBADepthPacking, side: T.DoubleSide });
    m.userData.sectionMargin = 0;
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { uO: U.uO, uN: U.uN, uBack: U.uBack, uLatR: U.uLatR, tLavaS: U.tLavaS, uLavaOn: U.uLavaOn }, SS.slab2d.U);
      sh.vertexShader = 'attribute vec4 mD; uniform vec3 uO, uN; uniform highp sampler2D tLavaS; uniform float uLavaOn;\n'
        + SS.slab2d.GLSL
        + SS.slab2d.VERT
        + 'varying vec3 vW;\n'
        + sh.vertexShader.replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
        if (uSlab.x > 0.5) {
          float s2h = 0.0;
          vec3 s2n = normal;
          s2Vert((modelMatrix * vec4(position, 1.0)).xyz, mD, s2n, s2h);
          transformed.y += s2h;
        }
        vW = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = SS.slab2d.GLSL
        + 'uniform vec3 uO, uN, uLatR; uniform float uBack; varying vec3 vW;\n'
        + sh.fragmentShader.replace(
          '#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\n float tD = dot(vW - uO, uN); if (tD < -(uSlab.x > 0.5 ? s2Edge(vW.x) : uBack)) discard;' +
            ' if (uLatR.z > 0.0 && distance(vW.xz, uLatR.xy) > uLatR.z) discard;'
        );
    };
    m.customProgramCacheKey = () => 'slabdepth3';
    return m;
  }

  /* P118b (QA1 Q-01: concrete was one flat beige / royal-blue fill): reinforced concrete cut through, the cap's
   * material 15 (bunkers, forts, ruin walls and slabs).
   * Everything is a function of the pinned face coordinates pu = (tau, y), of the density field (the distance d0 to the
   * nearest surface and its gradient in the face plane, from dens()) and of the pixel footprint fw (every layer fades
   * out before it aliases: the noise has no mip maps, and the stones that fade out leave their average):
   *   paste     cement paste with per-pour tint, 1 m blotches and a sand speckle;
   *   aggregate three layers of Voronoi-packed stones (cobbles 5-9 cm, 4-5 cm stones, 2 cm chips; limestone, granite,
   *   basalt, buff sandstone, quartz): rounded polygons separated by thin paste;
   *   pours     horizontal cold joints every 1.25 m (a dark seam with a pale laitance lip), efflorescence drips under
   *             some of them;
   *   rebar     two mats parallel to every surface at 85 mm cover, bars every 0.2 m (rows at fixed heights on walls,
   *             columns on slabs): steel disc, rust ring, rust halo in the paste,
   *             rust runs below some bars (the cover is what the cut outline's own line leaves visible at the game
   *             zoom); behind a 0.26 m granite block facing on the beach pillboxes;
   *   cracks    hairline cracks that start at a surface and run inward, wiggling and thinning (lanes along the
   *             surface), the wide ones with a leached pale edge; spalled patches, air voids;
   *   weather   a darker 3 cm skin along every surface, wet streaks below the ground line above, a damp green foot
   *             where the wall stands in the ground, rain darkening.
   * Returns the albedo; gCapWet = the share that shines. The surface concrete (the walls and floors seen in the
   * bunkers) is CONC_SURF, further up. */
  const CONC_CUT = /* glsl */`
    // Voronoi-packed aggregate: the stone of the nearest feature point, a rounded polygon (radius rr cells, cut by the bisectors with its neighbours, a hair of paste between);
    // cov = the stone, sc = its colour, rim = 1 at its edge
    float stoneVor(vec2 p, float cell, float rr, float fillP, float seed, float aa, out vec3 sc, out float rim){
      vec2 q = p / cell, id = floor(q), f = fract(q);
      float d1 = 9.0, d2 = 9.0;
      vec3 ch = vec3(0.0);
      // the four cells round the pixel's quadrant (not all nine: the nearest points are there)
      vec2 sg = vec2(f.x < 0.5 ? -1.0 : 1.0, f.y < 0.5 ? -1.0 : 1.0);
      for (int k = 0; k < 4; k++) {
        vec2 o = vec2(float(k & 1), float(k >> 1)) * sg;
        vec3 h = hc3(id + o + seed);
        vec2 r = o + 0.12 + 0.76 * h.xy - f;
        float d = dot(r, r);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          ch = h;
        } else if (d < d2) d2 = d;
      }
      float e1 = sqrt(d1), e2 = sqrt(d2);
      float R = rr * (0.62 + 0.76 * ch.z) * (ch.x < fillP ? 1.0 : 0.0);
      float w = aa / cell, gap = 0.5 * (e2 - e1) - 0.035;                                  // distance to the bisector, minus the paste line
      float m = min(R - e1, gap), cov = smoothstep(-w, w, m);
      rim = (1.0 - smoothstep(0.0, 0.07, m)) * cov;
      float kk = fract(ch.y * 5.17 + ch.z * 3.3);
      vec3 c0 = kk < 0.34 ? vec3(0.37, 0.365, 0.35) : kk < 0.58 ? vec3(0.27, 0.265, 0.26) : kk < 0.70 ? vec3(0.15, 0.15, 0.155) : kk < 0.84 ? vec3(0.37, 0.34, 0.29) : kk < 0.94 ? vec3(0.34, 0.3, 0.28) : vec3(0.5, 0.49, 0.46);
      sc = c0 * (0.82 + 0.36 * fract(ch.x * 9.1 + ch.z * 4.7));
      return cov;
    }
    // a wiggling line at lane coordinate x (width w): used for cracks and drips
    float lineD(float x, float c, float w, float aa){ return 1.0 - smoothstep(max(w, aa) * 0.5, max(w, aa) * 0.5 + aa, abs(x - c)); }
    vec3 concCut(vec2 pu, float dd, out vec3 em, out float wetK){
      em = vec3(0.0); wetK = 0.0;
      float fw = max(max(length(cGx), length(cGy)), 1e-4), aa = 0.8 * fw;
      vec2 dW2 = vec2(uN.z, -uN.x);
      vec3 dw3 = vec3(dW2.x, 0.0, dW2.y);
      // the surface: distance d0 (m) to the nearest surface and its inward gradient gr in the face plane (gl = how much
      // of the surface's normal lies in the plane)
      float d0 = dens(vW);
      const float EX = 0.1;
      vec2 gr = vec2(dens(vW + dw3 * EX) - dens(vW - dw3 * EX), dens(vW + vec3(0.0, EX, 0.0)) - dens(vW - vec3(0.0, EX, 0.0))) / (2.0 * EX);
      float gl = length(gr);
      d0 = clamp(d0, 0.0, 1.5);
      // ---- paste: per-pour tint, blotches, speckle
      float lift = floor((pu.y + 0.04 * sin(pu.x * 0.7)) / 1.25);
      vec3 lh = hc3(vec2(lift, 3.0));
      float m1 = texture(tNoise, pu * 0.23 + vec2(0.3, 0.7)).g, m2 = texture(tNoise, pu * vec2(0.9, 0.35) + 0.4).r,
        m3 = texture(tNoise, pu * 2.1 + 0.1).g;
      vec3 paste = vec3(0.335, 0.33, 0.315) * mix(vec3(0.95, 0.96, 1.0), vec3(1.04, 1.02, 0.97), lh.x) * (0.94 + 0.12 * lh.y);
      vec3 col = paste * (0.88 + 0.24 * m1) * (0.95 + 0.1 * m2) * (0.94 + 0.12 * m3);
      float kFine = 1.0 - smoothstep(0.0016, 0.0045, fw);
      // (the fetches only where a pixel is small enough to show them)
      if (kFine > 0.0)
        col *= 1.0 + (texture(tNoise, pu * 17.0).b - 0.5) * 0.2 * kFine + (texture(tNoise, pu * 41.0 + 0.3).b - 0.5) * 0.12 * (1.0 - smoothstep(0.0007, 0.002, fw));
      // ---- aggregate
      vec3 sc = vec3(0.4), sc2 = vec3(0.4);
      float rim = 0.0, rim2 = 0.0;
      float kA = smoothstep(0.55, 1.3, 0.055 * 0.3 / max(aa, 1e-4)), kB = smoothstep(0.55, 1.3, 0.026 * 0.3 / max(aa, 1e-4));
      float cA = 0.0, cB = 0.0, cC = 0.0, rimC = 0.0;
      vec3 scC = vec3(0.3);
      float kC = smoothstep(0.55, 1.3, 0.13 * 0.3 / max(aa, 1e-4));
      if (kC > 0.0) cC = stoneVor(vec2(pu.x * 0.6 - pu.y * 0.8, pu.y * 0.6 + pu.x * 0.8) + 3.0, 0.13, 0.44, 0.34, 9.0, aa, scC, rimC) * kC;
      if (kA > 0.0) cA = stoneVor(pu, 0.055, 0.42, 0.8, 1.0, aa, sc, rim) * kA * (1.0 - cC);
      if (kB > 0.45 && uConcQ > 0.5)
        cB = stoneVor(vec2(pu.x * 0.8 + pu.y * 0.6, pu.y * 0.8 - pu.x * 0.6) + 7.0, 0.026, 0.42, 0.7, 5.0, aa, sc2, rim2) * kB * (1.0 - cA);
      float gr1 = fw < 0.006 ? 0.88 + 0.24 * texture(tNoise, pu * 23.0).b : 1.0,
        gc = fw < 0.01 ? 0.9 + 0.2 * texture(tNoise, pu * 11.0).b : 1.0;
      col = mix(col, mix(paste * 0.9, scC, 0.75) * gc * (1.0 - 0.22 * rimC), cC);
      col = mix(col, mix(paste * 0.9, sc, 0.75) * gr1 * (1.0 - 0.2 * rim), cA);
      col = mix(col, mix(paste * 0.9, sc2, 0.7) * gr1 * (1.0 - 0.2 * rim2), cB);
      // (the average of the stones that faded out)
      col += (1.0 - kA) * 0.28 * (vec3(0.25, 0.245, 0.23) - paste) + (1.0 - kB) * 0.16 * (vec3(0.25, 0.245, 0.23) - paste);
      // ---- cold joints between the pours, with drips of efflorescence below some of them
      {
        float yl = pu.y + 0.015 * sin(pu.x * 1.9 + lift) + 0.01 * (m1 - 0.5), lf = fract(yl / 1.25), jd = min(lf, 1.0 - lf) * 1.25;
        float seam = lineD(jd, 0.0, 0.008, aa), lip = (1.0 - smoothstep(0.0, 0.05, abs(lf * 1.25 - 0.045))) * 0.5;
        col *= 1.0 - 0.38 * seam;
        col = mix(col, col * vec3(1.08, 1.08, 1.06), lip * (1.0 - seam));
        float below = fract(yl / 1.25) * 1.25;                                            // metres above the last joint
        vec3 hj = hc3(vec2(lift, 11.0));
        float lane = floor(pu.x / 0.3), hl = hc1(vec2(lane, lift * 3.0 + 1.0));
        float dx = fract(pu.x / 0.3) * 0.3 - 0.3 * (0.2 + 0.6 * hl), dripL = 0.08 + 0.5 * hl * hl;
        float drip = lineD(dx + 0.012 * sin(below * 11.0 + hl * 9.0), 0.0, 0.012 + 0.012 * hl, aa) * step(hl, 0.45 * hj.x + 0.1) * (1.0 - smoothstep(0.0, dripL, 1.25 - below)) * step(1.25 - below, dripL);
        col = mix(col, vec3(0.5, 0.49, 0.45), drip * 0.5);
      }
      // ---- rebar: two mats parallel to every surface at 85 mm cover (what the cut outline's own line leaves visible
      // at the game zoom). On a wall (the surface mostly vertical in the face) the bars sit in rows at fixed heights,
      // on a slab in columns at fixed positions; the centre is where the row / column meets the iso-line d = cover (the
      // linearised density field), so it is the same for every pixel of a bar (the granite facing of a beach pillbox:
      // the bars sit behind it)
      float faceT = uBeach > 0.5 ? 0.26 : 0.0;
      float barVis = smoothstep(0.2, 0.5, gl) * (1.0 - smoothstep(0.38 + faceT, 0.54 + faceT, d0));
      if (barVis > 0.0) {
        float COVER = 0.085 + faceT;
        const float PIT = 0.2, RB = 0.0125;
        bool vert = abs(gr.x) > abs(gr.y);
        vec2 cen;
        float rowId;
        if (vert) {
          float yk = (floor(pu.y / PIT) + 0.5) * PIT;
          cen = vec2(pu.x + (COVER - d0 - gr.y * (yk - pu.y)) / gr.x, yk);
          rowId = floor(pu.y / PIT);
        }
        else {
          float xk = (floor(pu.x / PIT) + 0.5) * PIT;
          cen = vec2(xk, pu.y + (COVER - d0 - gr.x * (xk - pu.x)) / gr.y);
          rowId = floor(pu.x / PIT) + 977.0;
        }
        float bd = length(pu - cen);
        vec3 hb = hc3(vec2(rowId, 1.0));
        float rust = 0.25 + 0.75 * hb.x * hb.x;
        float rr = RB * (0.9 + 0.2 * hb.y), vis = clamp(rr / max(0.7 * aa, 1e-4), 0.0, 1.0);
        float rw = rr + 0.0035 * (0.5 + rust);
        float bar = (1.0 - smoothstep(rr - aa, rr + aa, bd)) * vis, ring = (1.0 - smoothstep(rw - aa, rw + aa, bd)) * vis;
        float halo = (1.0 - smoothstep(rr, rr * 4.4 + 0.016 * rust, bd)) * mix(1.0, vis, 0.6);
        col = mix(col, col * vec3(0.84, 0.62, 0.45), halo * (0.35 + 0.6 * rust) * barVis);
        float hlt = 1.0 - smoothstep(0.0, rr * 1.2, length(pu - cen - vec2(-0.35, 0.35) * rr));
        vec3 steel = vec3(0.05, 0.055, 0.065) + vec3(0.12, 0.125, 0.14) * hlt;
        col = mix(col, vec3(0.30, 0.115, 0.04) * (0.8 + 0.5 * hb.z), ring * barVis * (0.55 + 0.45 * rust));
        col = mix(col, steel, bar * barVis);
        if (vert && hb.z < 0.3) {                                                         // a rust run below the bar
          float runL = 0.12 + 0.55 * hb.y, below = cen.y - pu.y;
          float rn = (1.0 - smoothstep(0.0, runL, below)) * step(0.0, below) * step(0.01, bd);
          col = mix(col, col * vec3(0.78, 0.6, 0.46), rn * lineD(pu.x - cen.x, 0.0, 0.016 + 0.02 * hb.x, aa) * 0.7 * barVis);
        }
      }
      // ---- hairline cracks from the surface inward: lanes along the surface (a grid in the dominant axis), each with
      // a crack by chance
      float crk = 0.0, leach = 0.0;
      if (d0 < 0.8 && gl > 0.3) {
        bool vert = abs(gr.x) > abs(gr.y);
        float tc = vert ? pu.y : pu.x, LW = 0.42;
        float lane = floor(tc / LW), fl = tc / LW - lane;
        vec3 hc = hc3(vec2(lane, vert ? 21.0 : 23.0));
        float L = 0.1 + 0.65 * hc.y * hc.y;
        if (hc.x < 0.3) {
          float wig = (texture(tNoise, vec2(d0 * 2.3 + hc.z * 9.0, lane * 0.071)).g - 0.5) * 0.09 + (texture(tNoise, vec2(d0 * 9.0 + hc.z * 5.0, lane * 0.13)).b - 0.5) * 0.02;
          float tcc = (0.2 + 0.6 * hc.z) * LW + wig;
          float wdt = (0.0009 + 0.005 * hc.y * hc.y * hc.y) * (1.0 - smoothstep(0.0, L, d0));
          float taper = 1.0 - smoothstep(L * 0.6, L, d0);
          float ln = lineD(fl * LW, tcc, wdt, aa * 0.8) * taper;
          crk = ln;
          leach = lineD(fl * LW, tcc, wdt + 0.012, aa) * taper * step(0.006, wdt) * (1.0 - ln);
        }
      }
      col = mix(col, col * 1.1 + vec3(0.03), leach * 0.35);
      col = mix(col, vec3(0.05, 0.048, 0.045), crk * 0.7);
      // ---- spalled patches next to a surface (the skin is gone: the rough dark core shows, rust on the bars) and air
      // voids
      {
        float sp = d0 < 0.1 ? smoothstep(0.76, 0.86, texture(tNoise, pu * 3.4 + 0.37).b) * (1.0 - smoothstep(0.03, 0.1, d0)) : 0.0;
        col = mix(col, col * vec3(0.58, 0.52, 0.47), sp * 0.8);
        float kV = 1.0 - smoothstep(0.003, 0.009, fw);
        if (kV > 0.0) {
          vec2 vq = pu / 0.017, vid = floor(vq);
          vec3 hv = hc3(vid + 61.0);
          float vd = length((fract(vq) - 0.2 - 0.6 * hv.xy) * 0.017), vr = 0.0012 + 0.0035 * hv.z * hv.z;
          float vo = (1.0 - smoothstep(vr * 0.7, vr, vd)) * step(0.86, hv.x * 0.3 + hv.z * 0.7 + 0.15) * kV;
          col = mix(col, col * vec3(0.38, 0.37, 0.36), vo);
        }
      }
      // ---- the beach pillboxes are faced with granite blocks (render: graniteMasonry on the outside and inside): a
      // 0.26 m facing of block cross-sections, a mortar bed behind it, a concrete core
      if (uBeach > 0.5) {
        float fac = 1.0 - smoothstep(0.23, 0.29, d0);
        if (fac > 0.0) {
          bool vv = abs(gr.x) > abs(gr.y);
          float tcb = vv ? pu.y : pu.x, rowH = vv ? 0.55 : 1.3, row = floor(tcb / rowH), fr = tcb / rowH - row;
          vec3 hg = hc3(vec2(row, vv ? 5.0 : 6.0));
          vec3 gran = pow(mix(vec3(0.40, 0.31, 0.26), vec3(0.54, 0.43, 0.36), hg.x) * (0.9 + 0.2 * hg.y), vec3(2.2));
          gran *= 0.88 + 0.24 * texture(tNoise, pu * 11.0 + hg.xy).b;
          gran = mix(gran, pow(vec3(0.62, 0.52, 0.48), vec3(2.2)), smoothstep(0.8, 0.92, texture(tNoise, pu * 29.0).b) * 0.5);
          float jn = min(fr, 1.0 - fr) * rowH, mortar = 1.0 - smoothstep(0.006, 0.016 + aa, jn);
          gran = mix(gran, vec3(0.22, 0.2, 0.18), mortar * 0.8);
          col = mix(col, gran, fac);
          col *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.012 + aa, abs(d0 - 0.26)));
        }
      }
      // ---- skin and wet streaks
      col *= mix(0.8, 1.0, smoothstep(0.0, 0.035, d0));
      {
        float sx = pu.x * 2.3 + 0.37 * sin(pu.y * 0.8 + pu.x * 0.3), sk = texture(tNoise, vec2(sx, 0.13)).g,
          ln = texture(tNoise, vec2(sx * 0.6 + 0.2, pu.y * 0.09)).b,
          sp2 = smoothstep(0.35, 0.7, texture(tNoise, vec2(pu.x * 0.08, 0.77)).r);
        float depthK = smoothstep(3.0, 0.2, dd);
        float st = smoothstep(0.76, 0.9, sk) * smoothstep(0.25, 0.75, ln + 0.4 * depthK - 0.15) * depthK * sp2;
        col *= 1.0 - 0.32 * st; col = mix(col, col * vec3(0.9, 0.97, 0.9), st * 0.4);
        wetK = st * 0.4;
      }
      // the foot: where the concrete stands in the ground (another material within a metre below) it is damp, darker
      // and a little green
      {
        float damp = 0.0;
        ivec3 vmx = ivec3(uVolSize) - 1;
        for (int k = 1; k <= 2; k++) {
          vec2 tv = texelFetch(tVol, clamp(ivec3(floor((vW + vec3(0.0, -0.4 * float(k), 0.0)) / 0.5 + 0.5)), ivec3(0), vmx), 0).rg;
          if (tv.r > 0.0 && (int(tv.g + 0.5) & 31) != 15) {
            damp = 1.0 - 0.4 * float(k - 1);
            break;
          }
        }
        float dn = 0.6 + 0.4 * texture(tNoise, pu * vec2(1.7, 0.5) + 0.2).g;
        col = mix(col, col * vec3(0.7, 0.74, 0.66), damp * dn * 0.7);
      }
      col *= 1.0 - 0.3 * uWet;
      wetK = max(wetK, uWet * 0.6);
      return col;
    }
  `;

  /* P118b (QA1 Q-14: the canyon cut face was a smooth red-orange gradient): sedimentary strata of the cut face, a
   * function of the stratigraphic height zb (world y plus the slow
   * regional warp) so the same bed continues across the map. Three nested sequences of beds (formations about 2.6 m,
   * beds 0.9 m, thin beds 0.23 m; every boundary shifted by its own hash, so thicknesses run from 5 cm to 3 m) give the
   * colour: each formation and bed picks a hue from a palette (brick red, red-orange, orange-tan, salmon, buff,
   * purple-brown, grey-green silt; uStrata = how much of the pale / exotic end a map shows: canyon most), a thin bed a
   * lightness. Bedding planes are dark lines, a hard bed (resistant ledge) is paler with a bright lip and throws a
   * shadow on the soft bed under it; soft beds are darker and pitted (honeycomb weathering). Inside a bed: laminae
   * along the bed, cross-bedding (dipping laminae truncated by the bed's own planes) in the thick ones, a pebble lens
   * in a few thin beds; across the beds: desert-varnish streaks and open vertical joints. Everything fades out with the
   * pixel footprint fw. */
  const STRATA_CUT = /* glsl */`
    float bedOf(float z, float T, float seed, out float lo, out float hi){
      float i0 = floor(z / T), b0 = (i0 + 0.8 * (hc1(vec2(i0, seed)) - 0.5)) * T;
      bool up = z >= b0;
      float i = up ? i0 : i0 - 1.0;
      lo = up ? b0 : (i0 - 1.0 + 0.8 * (hc1(vec2(i0 - 1.0, seed)) - 0.5)) * T;
      hi = up ? (i0 + 1.0 + 0.8 * (hc1(vec2(i0 + 1.0, seed)) - 0.5)) * T : b0;
      return i;
    }
    vec3 strataPal(float h, float variety){
      h = pow(h, 1.0 + 0.7 * (1.0 - variety));
      if (h < 0.10) return vec3(0.13, 0.055, 0.045);
      if (h < 0.24) return vec3(0.34, 0.085, 0.045);
      if (h < 0.52) return mix(vec3(0.54, 0.15, 0.05), vec3(0.62, 0.2, 0.065), (h - 0.24) / 0.28);
      if (h < 0.68) return vec3(0.68, 0.3, 0.11);
      if (h < 0.78) return vec3(0.66, 0.33, 0.22);
      if (h < 0.89) return vec3(0.74, 0.56, 0.36);
      if (h < 0.94) return vec3(0.28, 0.12, 0.11);
      return vec3(0.30, 0.31, 0.26);
    }
    // a formation (2-4 m): cliff-forming (hard) units are red / orange / salmon / buff, slope-forming (soft) units dark
    // brown, purple-brown, dull red, grey-green silt
    vec3 formationCol(float h, float hard, float variety){
      if (hard > 0.5) {
        h = pow(h, 1.0 + 0.6 * (1.0 - variety));
        if (h < 0.22) return vec3(0.40, 0.095, 0.05);
        if (h < 0.62) return mix(vec3(0.60, 0.17, 0.06), vec3(0.74, 0.27, 0.085), (h - 0.22) / 0.4);
        if (h < 0.80) return vec3(0.78, 0.38, 0.13);
        if (h < 0.90) return vec3(0.76, 0.42, 0.29);
        return vec3(0.84, 0.66, 0.43);
      }
      if (h < 0.34) return vec3(0.15, 0.058, 0.045);
      if (h < 0.62) return vec3(0.29, 0.1, 0.065);
      if (h < 0.84) return vec3(0.23, 0.105, 0.1);
      return mix(vec3(0.29, 0.105, 0.07), vec3(0.30, 0.31, 0.26), variety);
    }
    vec3 sandStrata(vec2 pu, float zb, float fw, float variety){
      float aa = max(fw, 0.004);
      float loF, hiF, loB, hiB, loC, hiC;
      float iF = bedOf(zb, 2.0, 3.0, loF, hiF), iB = bedOf(zb, 0.6, 7.0, loB, hiB), iC = bedOf(zb, 0.16, 11.0, loC, hiC);
      vec3 hF = hc3(vec2(iF, 3.1)), hFa = hc3(vec2(iF + 1.0, 3.1)), hB = hc3(vec2(iB, 7.3)), hC = hc3(vec2(iC, 11.7)),
        hX = hc3(vec2(iB, 29.0)), hA = hc3(vec2(iB + 1.0, 7.3));
      float hardF = step(0.38, hF.y), hardFa = step(0.38, hFa.y);
      vec3 col = mix(formationCol(hF.x, hardF, variety), strataPal(hB.x, variety), 0.2) * (0.76 + 0.48 * hB.z) * (0.86 + 0.28 * hC.x) * mix(vec3(0.94, 0.95, 1.0), vec3(1.05, 1.03, 0.97), hC.y);
      float hard = smoothstep(0.45, 0.7, hB.y), hardAbove = smoothstep(0.45, 0.7, hA.y);
      col *= mix(0.92, 1.1, hard);
      float eUB = hiB - zb, eDB = zb - loB, eUC = hiC - zb, eDC = zb - loC, eUF = hiF - zb, eDF = zb - loF;
      // bedding planes, the lip of a hard bed, the shadow it throws on the soft bed below; the same at the formation
      // scale, stronger
      col *= 1.0 - 0.5 * (1.0 - smoothstep(0.0, 0.025 + aa, min(eUF, eDF))) - 0.27 * (1.0 - smoothstep(0.0, 0.014 + aa, min(eUB, eDB))) - 0.11 * (1.0 - smoothstep(0.0, 0.009 + aa, min(eUC, eDC)));
      col *= 1.0 + 0.16 * hard * (1.0 - smoothstep(0.0, 0.05, eUB)) - 0.4 * hardAbove * (1.0 - smoothstep(0.0, 0.25, eUB)) * (1.0 - 0.6 * hard);
      col *= 1.0 + 0.2 * hardF * (1.0 - smoothstep(0.0, 0.07, eUF)) - 0.45 * hardFa * (1.0 - hardF) * (1.0 - smoothstep(0.0, 0.45, eUF));
      // laminae along the bed, wavering
      float kL = 1.0 - smoothstep(0.012, 0.05, fw), kG = 1.0 - smoothstep(0.003, 0.012, fw);
      float lw = (texture(tNoise, vec2(pu.x * 0.03, zb * 0.4)).g - 0.5) * 2.2;
      float lam = texture(tNoise, vec2(pu.x * 0.045 + hB.z * 13.0, zb * 14.0 + lw)).g - 0.5,
        lam2 = texture(tNoise, vec2(pu.x * 0.11, zb * 33.0 + lw * 2.0)).b - 0.5;
      col *= 1.0 + (0.22 * lam * mix(1.2, 0.7, hard) + 0.12 * lam2) * kL;
      // cross-bedding in the thick beds: a set of laminae dipping across the bed (the coordinate along the dip drives a
      // stretched noise), cut off by the bed's own planes
      float thick = hiB - loB, xb = step(0.55, hX.x) * smoothstep(0.4, 0.7, thick);
      if (xb > 0.0 && kL > 0.0) {
        float dip = (hX.y - 0.5) * 0.9,
          zl = zb + dip * (pu.x - hX.z * 60.0) + 0.04 * lw + 0.012 * (pu.x - hX.z * 60.0) * (pu.x - hX.z * 60.0) * sign(dip) * 0.05;
        float xl = texture(tNoise, vec2(zl * 5.5, hX.z * 3.0)).r - 0.5, xl2 = texture(tNoise, vec2(zl * 21.0, hX.z * 5.0 + 0.3)).g - 0.5;
        col *= 1.0 + (0.24 * xl + 0.2 * xl2) * xb * kL;
      }
      // pebble lens in a few thin beds
      if (hC.z > 0.93 && fw < 0.02) {
        vec3 sc;
        float rim;
        float cv = stoneVor(pu, 0.055, 0.42, 0.9, 5.0, aa, sc, rim);
        vec3 pc = col * (0.6 + 0.9 * hc3(vec2(floor(pu.x / 0.055), floor(pu.y / 0.055))).x);
        col = mix(col, pc * (1.0 - 0.25 * rim), cv * (1.0 - smoothstep(0.012, 0.02, fw)));
      }
      // soft beds: honeycomb pits (weathered hollows with a pale lip), in a few beds only
      float kP = (1.0 - hard) * step(0.78, hB.z) * (1.0 - smoothstep(0.008, 0.03, fw));
      if (kP > 0.0) {
        vec3 sc;
        float rim;
        float cv = stoneVor(vec2(pu.x, zb) + 3.0, 0.12, 0.36, 0.55, 17.0, aa, sc, rim);
        col *= 1.0 - (0.3 * cv - 0.12 * rim * cv) * kP;
      }
      // grains
      col *= 1.0 + (texture(tNoise, pu * 13.0 + 0.2).b - 0.5) * 0.12 * kG;
      // desert varnish: dark soft streaks running down from the ledges (broken up along their length), and open
      // vertical joints (a few, not through every bed)
      float vlen = smoothstep(0.4, 0.62, texture(tNoise, vec2(pu.x * 0.5 + 0.3, zb * 0.13)).g);
      float vs = smoothstep(0.64, 0.86, texture(tNoise, vec2(pu.x * 0.5, zb * 0.04)).g) * smoothstep(0.35, 0.6, texture(tNoise, vec2(pu.x * 0.06, 0.3)).r) * vlen;
      col = mix(col, col * vec3(0.62, 0.52, 0.47), vs * 0.5);
      float LW = 2.3, lane = floor(pu.x / LW);
      vec3 hJ = hc3(vec2(lane, 41.0));
      float jx = pu.x - (lane + 0.2 + 0.6 * hJ.y) * LW + 0.03 * (hC.z - 0.5) + 0.02 * sin(zb * 3.1 + hJ.z * 9.0);
      float jseg = smoothstep(0.35, 0.55, texture(tNoise, vec2(lane * 0.37 + 0.2, zb * 0.09)).g);
      col *= 1.0 - 0.42 * (1.0 - smoothstep(0.0, 0.012 + aa, abs(jx) - 0.003 - 0.012 * hJ.z)) * step(hJ.x, 0.3) * jseg;
      // (more tonal separation between the beds, the hue kept)
      {
        float lm = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col *= pow(max(lm, 1e-4) / 0.3, 0.42);
      }
      return col;
    }
  `;

  /* The cut face: a plane at t = 0 (slice zero) coloured from the 3D world texture.
   * Material weights come from the lattice points around a noise-jittered position: a quadratic B-spline over 27
   * points (C1, so a voxel staircase becomes a smooth curve) or, on Low, trilinear over 8 (C0: corners at every
   * lattice point). The jitter is low-frequency (~1-2 m) so boundaries wander instead of growing teeth. */
  function capMaterial() {
    const m = new T.MeshStandardMaterial({ roughness: 0.95, metalness: 0, side: T.DoubleSide });
    m.userData.sectionMargin = 0;
    const bspline = Q.name !== 'low';
    m.onBeforeCompile = sh => {
      if (bspline) sh.fragmentShader = '#define CAP_BSPLINE 1\n' + sh.fragmentShader;
      Object.assign(sh.uniforms, U, FAR, CAPU, EOWU, { tVol: { value: volTex }, uVolSize: { value: VOLSIZE }, uCapN: capN });
      // the plane mesh sits 2 mm behind slice zero; everything is sampled ON slice zero (t = 0: the collision plane,
      // O1)
      sh.vertexShader = 'uniform vec3 uO, uN; varying vec3 vW;\n'
        + sh.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n vW = (modelMatrix * vec4(transformed, 1.0)).xyz; vW -= uN * dot(vW - uO, uN);'
        );
      sh.fragmentShader = /* glsl */`
        uniform highp sampler3D tVol;
        uniform highp sampler2DArray tMats;
        uniform sampler2D tNoise;
        uniform sampler2D tSurf;
        uniform sampler2D tCover;
        uniform highp sampler2D tLavaS;
        uniform vec3 uVolSize, uO, uN, uGrassTint;
        uniform float uTime, uSea, uHalf, uVolc, uWet, uBeach;
        uniform vec3 uMatTint[12];
        // D5 far strip: u0, du, n, on; lattice size; D6 disc
        uniform highp sampler2D tFar;
        uniform vec4 uFar;
        uniform vec2 uLat;
        uniform vec3 uLatR;
        uniform highp sampler3D tN3;
        uniform float uS0;
        uniform float uNL;
        uniform float uEow;
        uniform float uUnder, uCapDet, uCapDbg;
        uniform vec4 uCapFill, uCapGrade;
        uniform float uCapFlash, uStrata, uConcQ;
        varying vec3 vW;
        ${CRACK_GLSL}
        ${FOAM_GLSL}
        ${PLATE_GLSL}
        ${HASH_GLSL}
        ${TUFF_GLSL}
        ${EOW_GLSL}
        // C1 (user: the face must not SCROLL while the section turns; each spot morphs into another random part of the
        // texture, faster the further from the worm): textures are pinned to the face, pu = (τ, y), τ = s + uS0 (s =
        // distance from the pivot along the face; uS0 absorbs pivot moves on the same plane); the variety comes from a
        // 3D world grid of MORPH cells (simplex corners, MORPH_CELL m): each corner holds a random texture offset and
        // the face pixel blends the texture at the offsets of the corners around its WORLD point (variance-preserving,
        // Heitz & Neyret 2018 / Deliot & Heitz 2019). Turning moves that point by |s|·Δθ through the grid: no change
        // under the worm, a full change after ~one cell further out, and turning back restores the look. Noise: tN3 at
        // the world point (a 3D field behaves the same way).
        vec4 cW4;
        vec2 cO4[4];
        float cNrm;
        vec2 cGx, cGy;
        uvec3 pcg3(uvec3 v){
          v = v * 1664525u + 1013904223u;
          v.x += v.y * v.z;
          v.y += v.z * v.x;
          v.z += v.x * v.y;
          v ^= v >> 16u;
          v.x += v.y * v.z;
          v.y += v.z * v.x;
          v.z += v.x * v.y;
          return v;
        }
        vec2 cellOff(vec3 c){
          uvec3 h = pcg3(uvec3(ivec3(c) + 4096));
          return vec2(h.xy & 0xffffu) / 65536.0;
        }
        void morphCells(vec3 p){
          const float F3 = 1.0 / 3.0, G3 = 1.0 / 6.0;
          vec3 i = floor(p + dot(p, vec3(F3)));
          vec3 x0 = p - i + dot(i, vec3(G3));
          vec3 g = step(x0.yzx, x0.xyz), l = 1.0 - g;
          vec3 i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy);
          vec3 x1 = x0 - i1 + G3, x2 = x0 - i2 + 2.0 * G3, x3 = x0 - 1.0 + 3.0 * G3;
          vec4 w = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);   // compact: 0 where a corner changes
          w = w * w * w; w /= max(w.x + w.y + w.z + w.w, 1e-6);
          cW4 = w; cNrm = inversesqrt(max(dot(w, w), 1e-6));
          cO4[0] = cellOff(i);
          cO4[1] = cellOff(i + i1);
          cO4[2] = cellOff(i + i2);
          cO4[3] = cellOff(i + 1.0);
        }
        // the material layer L at face coords pu·sc through the morph cells (msk (1, 1); strata (1, 0): offsets along
        // the face only, so the layers keep their heights); explicit gradients (offsets jump where their weight is 0)
        vec3 texM(vec2 pu, vec2 sc, float L, vec2 msk){
          vec2 uv = pu * sc, gx = cGx * sc, gy = cGy * sc;
          vec3 mean = textureLod(tMats, vec3(0.5, 0.5, L), 12.0).rgb, acc = vec3(0.0);
          for (int k = 0; k < 4; k++)
            if (cW4[k] > 0.003) acc += cW4[k] * (textureGrad(tMats, vec3(uv + cO4[k] * msk, L), gx, gy).rgb - mean);
          return max(mean + acc * cNrm, vec3(0.0));
        }
        vec4 n3(vec3 p){ return texture(tN3, p); }
        // far strip at section coordinate u (= dot(xz, dir)): top, sand base, rock top (linear between texels)
        vec4 farAt(float u){
          float t = clamp((u - uFar.x) / uFar.y, 0.0, uFar.z - 1.001);
          int i = int(t);
          return mix(texelFetch(tFar, ivec2(i, 0), 0), texelFetch(tFar, ivec2(i + 1, 0), 0), t - float(i));
        }
        vec3 vuv(vec3 p){ return (p / 0.5 + 0.5) / uVolSize; }
        float gLava;                                   // lava share of the local material weights (1 deep inside a pocket)
        float dens(vec3 p){ return texture(tVol, vuv(p)).r; }   // raw half-float density: the sim's iso-line (O1)
        // open lava layer (render/lava.js): bilinear over the columns of rgba = surface y, depth, T, bed y
        vec4 lavaCol(vec2 xz){
          vec2 g = xz / 0.5;
          ivec2 b = ivec2(floor(g));
          vec2 f = g - vec2(b);
          ivec2 mx = textureSize(tLavaS, 0) - 1;
          vec4 a = texelFetch(tLavaS, clamp(b, ivec2(0), mx), 0), c = texelFetch(tLavaS, clamp(b + ivec2(1, 0), ivec2(0), mx), 0);
          vec4 d = texelFetch(tLavaS, clamp(b + ivec2(0, 1), ivec2(0), mx), 0), e = texelFetch(tLavaS, clamp(b + ivec2(1, 1), ivec2(0), mx), 0);
          return mix(mix(a, c, f.x), mix(d, e, f.x), f.y);
        }
        // section through open lava: incandescent melt with slow convection, a dark crust skin with glowing cracks at
        // the surface, a chilled orange base against the ground; colours as the voxel pockets (ACES-sized)
        vec3 lavaSection(vec2 pu, float dTop, float dBot, float Tm, out float skinF){
          float heat = clamp((Tm - 0.12) / 0.88, 0.0, 1.0);
          vec2 wq = (texture(tNoise, pu * 0.07 + vec2(0.0009, -0.0026) * uTime).rg - 0.5) * 1.4;
          float cv = texture(tNoise, pu * 0.16 + wq + vec2(-0.004, -0.002) * uTime).r * 0.65 + texture(tNoise, pu * 0.41 - wq * 0.5 + vec2(0.002, -0.009) * uTime).g * 0.35;
          float core = smoothstep(0.05, 0.4, min(dTop, dBot) + (cv - 0.5) * 0.15) * heat;
          vec3 hot = mix(vec3(1.0, 0.11, 0.01), vec3(1.8, 0.52, 0.05), core) * (0.62 + 0.76 * cv) * (0.35 + 0.65 * heat);
          float sk = 0.03 + 0.05 * (1.0 - heat) + (texture(tNoise, vec2(pu.x * 0.9, 0.3)).r - 0.5) * 0.03;
          float crack = smoothstep(0.82, 0.95, texture(tNoise, vec2(pu.x * 0.7 + uTime * 0.002, 0.71)).g);
          skinF = (1.0 - smoothstep(sk * 0.5, sk, dTop)) * (1.0 - crack);
          return hot * (1.0 - skinF);
        }
        // P76: cut-face detail (sedimentary laminae, calcite / quartz veins with rust halos, wet seepage streaks, geode
        // crystals, roots under the soil line); everything is a function of the pinned face coordinates pu = (tau, y)
        // and the depth below the ground / roof above, so it does not scroll when the section turns. uUnder (caves)
        // turns the seepage and the crystals up; wet = the share that shines (roughness)
        float gCapWet = 0.0;
        float h11(float n){ return fract(sin(n * 91.3458) * 47453.5453); }
        vec3 capDetail(vec3 col, int mat, vec2 pu, float dd, float nb, float cover, float heat, out vec3 em){
          em = vec3(0.0);
          bool rockM = mat == 2 || mat == 5 || mat == 1 || mat == 12 || mat == 8 || mat == 10;
          bool soilM = mat == 3;
          if (!rockM && !soilM) return col;
          float un = uUnder;
          // thin sedimentary laminae that follow the (warped) bedding: brightness only, a few millimetres to
          // centimetres
          if (rockM && mat != 8 && mat != 10) {
            float ly = pu.y + (texture(tNoise, vec2(pu.x * 0.021, 0.43)).g - 0.5) * 1.6 + 0.25 * sin(pu.x * 0.7 + nb * 5.0);
            float lam = texture(tNoise, vec2(pu.x * 0.011, ly * 2.3)).b, lam2 = texture(tNoise, vec2(pu.x * 0.017 + 0.3, ly * 7.1)).g;
            col *= 0.9 + 0.2 * lam + 0.1 * (lam2 - 0.5);
          }
          // mineral veins: short lens-shaped calcite / quartz fills along joints, low contrast, clustered in fractured
          // zones (none in loose soil / sand); cream-milky and only slightly lighter than the host, with a faint rusty
          // (iron oxide) halo
          if (rockM) {
            float zone = smoothstep(0.58, 0.8, texture(tNoise, pu * 0.011 + vec2(0.7, 0.2)).a);
            float vein = 0.0, halo = 0.0;
            if (zone > 0.0) {
              float vc = 2.6;
              vec2 vq = pu / vc, vid = floor(vq), vf = fract(vq);
              float h = h11(vid.x * 13.0 + vid.y * 71.0 + 4.0), h2 = h11(vid.x * 5.0 - vid.y * 29.0 + 1.0),
                h3 = h11(vid.x * 23.0 + vid.y * 3.0 + 8.0);
              if (h < 0.55 * zone) {
                float ang = (h2 - 0.5) * 0.9 + 0.12;                                   // joints dip gently off the bedding
                vec2 d = (vf - vec2(0.3 + 0.4 * h3, 0.3 + 0.4 * h2)) * vc, e = vec2(cos(ang), sin(ang));
                float xa = dot(d, e), ya = dot(d, vec2(-e.y, e.x)), L = 0.35 + 0.45 * h3, t = xa / L;
                float wd = (0.008 + 0.016 * h2) * max(1.0 - t * t, 0.0), wid = max(wd, 0.0);
                float dpu = max(length(dFdx(pu)), length(dFdy(pu)));
                float wx = max(wid, 0.7 * dpu) * step(abs(t), 1.0);
                vein = (1.0 - smoothstep(wx * 0.6, wx * 1.4, abs(ya))) * step(abs(t), 1.0);
                halo = (1.0 - smoothstep(wx * 1.5, wx * 5.0 + 0.01, abs(ya))) * step(abs(t), 1.15) * 0.4;
              }
            }
            vec3 vc3 = (mat == 8 || mat == 10) ? vec3(0.3, 0.3, 0.29) : vec3(0.74, 0.7, 0.6);
            col = mix(col, col * vec3(1.06, 0.88, 0.72), halo * (1.0 - vein));
            col = mix(col, mix(col, vc3, 0.5) * 1.05, vein * 0.55 * (mat == 8 || mat == 10 ? 0.5 : 1.0));
          }
          // wet seepage: dark vertical streaks running down from the ground / roof line and from joints; the wet rock
          // shines (gCapWet)
          {
            float sx = pu.x * 1.7 + 0.37 * sin(pu.y * 0.9 + pu.x * 0.3);
            float sk = texture(tNoise, vec2(sx, 0.13)).g, ln = texture(tNoise, vec2(sx * 0.7 + 0.2, pu.y * 0.11)).b,
              sp = smoothstep(0.42, 0.7, texture(tNoise, vec2(pu.x * 0.07, 0.77)).r);
            float depthK = smoothstep(3.5 + 3.5 * un, 0.3, dd) * (0.2 + 0.95 * un);
            float st = smoothstep(0.8 - 0.07 * un, 0.93, sk) * smoothstep(0.3, 0.8, ln + 0.35 * depthK - 0.18) * depthK * sp;
            float wob = 0.85 + 0.3 * texture(tNoise, vec2(sx * 3.1, pu.y * 0.6)).r;
            float wet = clamp(st * wob, 0.0, 1.0);
            col *= 1.0 - 0.42 * wet; col = mix(col, col * vec3(0.78, 0.88, 1.05), wet * 0.5);
            gCapWet = max(gCapWet, wet);
          }
          // geodes / vugs: rare small dark cavities in rock lined with dull crystal faces (quartz grey-white; amethyst,
          // sulphur very rarely); none in soil
          if (rockM) {
            float cs = 7.0;
            vec2 q = pu / cs, cid = floor(q), f = fract(q);
            float h1 = h11(cid.x * 17.0 + cid.y * 131.0 + 0.5), h2 = h11(cid.x * 31.0 + cid.y * 7.0 + 3.0),
              h3 = h11(cid.x * 5.0 - cid.y * 53.0 + 9.0);
            if (h1 < 0.07 + 0.13 * un) {
              vec2 c = vec2(0.25 + 0.5 * h2, 0.25 + 0.5 * h3), d = (f - c) * cs * vec2(1.0, 1.3);
              float r = length(d), ang = atan(d.y, d.x), rad = 0.14 + 0.12 * h2;
              float cav = 1.0 - smoothstep(rad * 0.9, rad * 1.12, r);
              float facet = 0.55 + 0.45 * sin(floor(ang * 5.0 + h3 * 6.0) * 2.7 + r * 14.0);
              float rim = smoothstep(rad * 0.25, rad * 0.5, r);
              float kind = fract(h1 * 100.0);
              vec3 cc = uVolc > 0.5 ? (kind < 0.25 ? vec3(0.5, 0.45, 0.2) : vec3(0.5, 0.5, 0.48)) : kind < 0.08 ? vec3(0.36, 0.26, 0.46) : vec3(0.52, 0.52, 0.49);
              vec3 inner = mix(col * 0.22, cc * (0.45 + 0.4 * facet), rim);
              col = mix(col, inner, cav);
              gCapWet = max(gCapWet, cav * rim * 0.5);
              em += cc * cav * rim * 0.012;
            }
          }
          // roots: pale-brown threads hanging from the ground line through the soil (and into the rock under grass),
          // tapering with depth, with rootlets
          if ((soilM || cover > 0.25) && dd < 2.6 && un < 0.5) {
            float rt = 0.0;
            for (int l = 0; l < 3; l++) {
              float fl = float(l), cw = 0.62 + 0.23 * fl, x = pu.x / cw + 13.7 * fl, id = floor(x), h = h11(id * 7.3 + fl * 19.0),
                h2 = h11(id * 3.1 + fl * 5.0 + 1.0);
              if (h < 0.5) continue;
              float len = (0.35 + 1.5 * h2) * (1.0 - 0.2 * fl);
              float cx = 0.5 + 0.28 * sin(dd * (3.5 + 2.0 * h2) + h * 30.0) * (0.4 + dd * 0.6) + (h - 0.75) * 0.3;
              float w = (0.018 + 0.014 * h2) * (1.0 - dd / len) * (1.0 + 0.5 * fl) / cw * 0.7;
              float ln = 1.0 - smoothstep(w * 0.5, w, abs(fract(x) - cx)) ;
              rt = max(rt, ln * (1.0 - smoothstep(len * 0.6, len, dd)) * smoothstep(-0.02, 0.05, dd));
            }
            col = mix(col, vec3(0.3, 0.2, 0.11) * (0.8 + 0.5 * nb), clamp(rt, 0.0, 1.0) * 0.85);
          }
          // humus: the topmost decimetres of soil are darker and moister
          if (soilM) col *= mix(0.62, 1.0, smoothstep(0.0, 0.4, dd));
          return col;
        }
        ${CONC_CUT}
        ${STRATA_CUT}
        /* P118b (QA1 Q-02: night and storm turned the board black): the cut face takes its light AFTER the scene's
         * lighting. uCapFill = a sky / moonlight fill on the section
         * (colour x strength): a soft floor under the lit colour, sqrt(L^2 + lift^2), lift = k x albedo^0.45 in the hue
         * of the material, so the dark materials (soil, basalt) are lifted most, the bright ones (sand, concrete)
         * hardly at all, and every material keeps its rank (the eye is dark-adapted: night contrast is compressed, not
         * gone); a lightning flash lights it too (uCapFlash, from the weather); uCapGrade = the colour grade of the
         * board (rgb gain, w = saturation): the moon's blue light is taken out of it, so concrete is grey and sand
         * pale, not royal blue */
        vec3 capPost(vec3 L, vec3 alb){
          if (uCapFill.w <= 0.0 && uCapFlash <= 0.0 && uCapGrade.w > 0.999) return L;                     // (daylight: nothing to do)
          float la = dot(alb, vec3(0.2126, 0.7152, 0.0722));
          vec3 hue = mix(vec3(1.0), clamp(alb / max(la, 1e-3), 0.3, 2.5), 0.55);
          float kd = 1.0 - 0.85 * smoothstep(0.10, 0.36, la);
          // (space has no sky to fill the shadows: End of the World keeps its own lights)
          vec3 lift = uCapFill.rgb * hue * (uCapFill.w * (1.0 - uEow) * pow(la * 5.0 + 0.02, 0.4) * kd);
          L = sqrt(L * L + lift * lift) + alb * vec3(0.8, 0.86, 1.0) * (0.3 * uCapFlash);
          float l = dot(L, vec3(0.2126, 0.7152, 0.0722));
          return mix(vec3(l), L, uCapGrade.w) * uCapGrade.rgb;
        }
        vec3 capCol(int mat, vec2 pu, vec3 strata, float dd, vec4 sf, float heat, out vec3 em){
          em = vec3(0.0);
          if (uEow > 0.5 && (mat == 13 || mat == 15)) return eoCap(pu, vW, em);   // P68d: the wrecked hull's cut (render/eowview.js)
          // P7: girder steel (13): the beam's cut, a painted plate with a dark web line; foam (14): bubbly pale cells
          if (mat == 13) {
            int pi = uNPl > 0 ? plateIdx(vW) : -1;
            if (pi >= 0) return plateCut(pi, vW);
            // P118b: a solid steel girder cut through (a placed girder, the hull of a wreck): bright ground steel with
            // fine machining marks and a faint temper tint, the painted skin (orange-brown, 2 cm) along every surface
            // with chips and a rust bloom where the paint is gone, a dark scale line under the skin; semi-gloss
            float sd = clamp(dens(vW), 0.0, 1.5);
            float ms = max(max(length(cGx), length(cGy)), 1e-4), kS = 1.0 - smoothstep(0.004, 0.02, ms);
            float mk = texture(tNoise, vec2(pu.x * 0.35, pu.y * 41.0)).g, mk2 = texture(tNoise, vec2(pu.x * 1.1 + 0.3, pu.y * 83.0)).b,
              cl = texture(tNoise, pu * 0.7 + 0.2).a;
            vec3 stl = vec3(0.25, 0.265, 0.29) * (0.82 + 0.36 * cl) * (1.0 + (mk - 0.5) * 0.3 * kS + (mk2 - 0.5) * 0.18 * kS);
            stl *= mix(vec3(1.0), vec3(1.04, 0.99, 0.93), smoothstep(0.4, 0.7, texture(tNoise, pu * 0.31 + 0.6).r));
            float skin = 1.0 - smoothstep(0.014, 0.026, sd), chip = smoothstep(0.62, 0.8, texture(tNoise, pu * 4.3 + 0.1).g) * skin;
            vec3 paint = vec3(0.47, 0.24, 0.12) * (0.88 + 0.24 * texture(tNoise, pu * 1.9).r);
            vec3 rustc = vec3(0.26, 0.12, 0.06) * (0.8 + 0.5 * texture(tNoise, pu * 9.0).b);
            vec3 c = mix(stl, mix(paint, rustc, chip), skin);
            c *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.01 + ms, abs(sd - 0.03))) * step(0.0, sd - 0.026);
            gCapWet = max(gCapWet, 0.55 * (1.0 - skin));
            return c;
          }
          // P37 W4: white honeycomb cut (a field of hexagonal cells looking into the block)
          if (mat == 14) {
            em = vec3(0.2, 0.21, 0.225);
            return foamLook(pu, 0.2, 1.0);
          }
          // P31 obsidian cut: black glass, curved conchoidal fracture lines, a faint grey flow banding
          if (mat == 16) {
            float cf = texture(tNoise, pu * 0.8).r, rip = 0.5 + 0.5 * sin(cf * 30.0);
            float band = texture(tNoise, vec2(pu.x * 0.15, pu.y * 2.2)).g;
            return vec3(0.03, 0.028, 0.034) * (0.8 + 0.4 * rip) + vec3(0.025) * smoothstep(0.62, 0.8, band);
          }
          // P29d concrete cut: grey matrix, coarse aggregate stones, rebar cut ends every 0.2 m (rust-brown dots)
          if (mat == 15) {
            // P65i: a cut through a ruin wall shows the dark stone courses
            if (uVolc > 0.5) {
              float ag = texture(tNoise, pu * 3.7 + vec2(0.13, 0.71)).r * 0.6 + texture(tNoise, pu * 9.1 + 0.3).g * 0.4, kj;
              vec3 c = tuffMasonry(pu, false, 0.0, kj) * 1.3 * (0.85 + 0.3 * ag);
              float rb = 1.0 - smoothstep(0.012, 0.022, length(fract(pu / 0.2) - 0.5));
              return mix(c, vec3(0.32, 0.17, 0.09), rb * 0.9);
            }
            float cwet;
            vec3 cc = concCut(pu, dd, em, cwet);
            gCapWet = max(gCapWet, cwet);
            return cc;
          }
          // P118b: sandstone on the volcanic island is the ruins' brick (no canyon strata there): dressed tuff courses
          // like the walls' concrete
          if (mat == 5 && uVolc > 0.5) {
            float kjb;
            float agb = texture(tNoise, pu * 3.7 + vec2(0.13, 0.71)).r * 0.6 + texture(tNoise, pu * 9.1 + 0.3).g * 0.4;
            return tuffMasonry(pu, false, 0.0, kjb) * 1.6 * (0.85 + 0.3 * agb);
          }
          int L = mat - 1;
          vec3 own = texM(pu, vec2(0.16), float(L), vec2(1.0)) * uMatTint[L];
          vec3 col = own;
          em = vec3(0.0);
          if (mat == 8 || mat == 10 || (mat == 1 && uVolc > 0.5)) {
            // basalt / crust (and a volcanic island's bedrock): black volcanic rock, not the sedimentary strata (user
            // 2026-10-08: "black rocky ground, not shiny plastic"; 65 % red-orange strata read as smooth painted clay).
            // The basalt texture's grain, desaturated to charcoal; the strata only add flow-unit banding in brightness
            // (no hue), plus blocky joint shading. Slightly cool, so under the warm sun / brown ground bounce it reads
            // as neutral charcoal, not brown.
            vec3 bas = texM(pu, vec2(0.16), 7.0, vec2(1.0)) * uMatTint[7];
            float bl = dot(bas, vec3(0.299, 0.587, 0.114)), sl = dot(strata, vec3(0.299, 0.587, 0.114));
            float jn = texture(tNoise, vec2(pu.x * 0.55, pu.y * 0.9)).g;               // jointed blocks
            col = mix(vec3(bl), bas, 0.12) * vec3(0.84, 0.9, 1.0) * 0.55 * mix(0.72, 1.18, smoothstep(0.12, 0.42, sl)) * mix(0.8, 1.08, smoothstep(0.3, 0.7, jn));
            if (mat == 10) col *= 0.85;                                                 // chilled margin: glassier, darker
          } else if (mat == 11) {
            // ash / tephra: dark grey cinders, a few dull red scoria grains (muted like the surface)
            col = mix(own, vec3(dot(own, vec3(0.299, 0.587, 0.114))) * vec3(0.9, 0.93, 1.0), 0.65) * 0.75;
          } else if (mat == 1 || mat == 2 || mat == 5 || mat == 12) {
            vec3 tint = mat == 5 ? vec3(0.94, 0.83, 0.76) : mat == 1 ? vec3(0.5) : mat == 2 ? mix(vec3(0.79, 0.62, 0.485), vec3(0.98, 0.79, 0.62), uUnder) : vec3(1.0);
            col = mix(strata * tint, own, mat == 12 ? 0.75 : 0.35);
          } else if (mat == 9) {
            // Lava sealed in rock is an incandescent liquid (no crust): yellow-white core with slow, low-contrast
            // convection, orange-red only in the thin chilled margin against the host rock. The crust-plate texture
            // (cooled skin floating on the melt) only appears within ~0.35 m of air.
            col = vec3(0.0);                                          // self-lit: no diffuse (it washed the glow out)
            // slow convection: domain-warped noise drifting upward (~1-2 cm/s)
            vec2 wq = (texture(tNoise, pu * 0.07 + vec2(0.0009, -0.0026) * uTime).rg - 0.5) * 1.4;
            float cv = texture(tNoise, pu * 0.16 + wq + vec2(0.0, -0.0045) * uTime).r * 0.65 + texture(tNoise, pu * 0.41 - wq * 0.5 + vec2(0.002, -0.009) * uTime).g * 0.35;
            float core = smoothstep(0.5, 0.95, gLava + (cv - 0.5) * 0.3);
            // sized for ACES (its input matrix desaturates; more green/blue washes out to cream): core -> sRGB
            // ~(250, 199, 99) golden yellow, margin -> deep orange
            // LV1: was (1.8, 0.52, 0.05) x up to 1.4: ACES flattened the whole pocket to one cream colour (sRGB ~244,
            // 214, 136, std 10) = the "flat lava wall"; now orange-yellow with visible convection cells and plumes
            float plume = smoothstep(0.6, 0.85, texture(tNoise, vec2(pu.x * 0.21, pu.y * 0.16 - uTime * 0.004) + wq * 0.5).b);
            // (three's ACES multiplies by exposure / 0.6 first: keep the melt below ~1 so the cells survive the curve)
            vec3 hot = mix(vec3(0.42, 0.04, 0.004), vec3(0.72, 0.2, 0.018), core) * (0.35 + 1.2 * cv + 0.4 * plume * core) * (0.7 + 0.3 * heat);
            float skin = (1.0 - smoothstep(0.1, 0.35, dd));
            float lf = texture(tMats, vec3(pu * 0.11 + vec2(0.0011, -0.0035) * uTime, 8.0)).r;
            em = mix(hot, pow(lf, 1.3) * vec3(5.0, 1.7, 0.35), skin);
          }
          if (mat == 10) {
            // LV1: crust = glassy chilled margin / old flow rind: dark, no strata; against hot lava (gLava, the lava
            // share of this cell) a dull red contact glow with brighter thermal-contraction cracks
            col = own * 0.55;
            float rc = 1.0 - abs(2.0 * texture(tNoise, pu * 0.55 + 0.13).g - 1.0), rc2 = 1.0 - abs(2.0 * texture(tNoise, pu * 1.3 + 0.61).r - 1.0);
            float crk = max(smoothstep(0.9, 0.98, rc), smoothstep(0.93, 0.99, rc2) * 0.7);
            float hotC = smoothstep(0.0, 0.35, gLava);
            em = (vec3(0.11, 0.012, 0.0) + vec3(0.55, 0.07, 0.006) * crk) * hotC;
          }
          if (mat == 3) {
            vec3 turf = mix(texM(pu, vec2(0.33), 12.0, vec2(1.0)) * uGrassTint * 0.7, own * 0.55, smoothstep(0.04, 0.16, dd));
            col = mix(mix(turf, own * 0.9, smoothstep(0.16, 0.4, dd)), own * 0.9, 1.0 - sf.r);
          }
          if (mat == 6) col = mix(col, col * vec3(0.8, 0.9, 1.05), smoothstep(0.3, 2.0, dd));
          if (mat == 7) {                                                                  // ice: pale, bluer with depth
            col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, 0.35) * 1.2 + vec3(0.05, 0.06, 0.07);
            col = mix(col * vec3(1.0, 1.04, 1.08), col * vec3(0.62, 0.8, 1.0), smoothstep(0.2, 1.5, dd));
          }
          if (uEow > 0.5 && (mat == 9 || mat == 10)) em = eoCapHeat(em, vW, mat);   // P68g: the cut's glow follows the temperature
          return col;
        }
        `
        + sh.fragmentShader
          .replace('#include <clipping_planes_fragment>', /* glsl */`#include <clipping_planes_fragment>
          vec2 dW = vec2(uN.z, -uN.x);
          float u = dot(vW.xz, dW);                      // absolute along-plane coordinate: GEOMETRY only (far strip)
          float tau = dot(vW.xz - uO.xz, dW) + uS0;      // C1: pinned face coordinate for every texture
          morphCells(vW / ${MORPH_CELL.toFixed(2)});
          cGx = dFdx(vec2(tau, vW.y)); cGy = dFdy(vec2(tau, vW.y));
          // D5: beyond the lattice (dry worlds) the far strip is the ground; eB = distance inside the border
          float eB = min(min(vW.x, vW.z), min(uLat.x - vW.x, uLat.y - vW.z));
          if (uLatR.z > 0.0) eB = min(eB, uLatR.z - distance(vW.xz, uLatR.xy));   // D6: the disc's edge
          bool farOn = uFar.w > 0.5, outL = farOn && eB < 0.0;
          vec4 fl = farOn && eB < 1.0 ? farAt(u) : vec4(0.0);
          // P29a (user 2026-10-08: "below the map there should be endless soil, not empty space, under the sea as
          // well"): the section never ends in a void. Below the lattice floor (y < 0.02) it is bedrock; beyond the
          // lattice on wet worlds it is rock under the open sea's bed line (the same line as render/water.js's aquarium
          // face), water above it (drawn by that face). The cap plane reaches DEEP m down and EXT m sideways
          // (TR.update).
          bool wetOut = !farOn && eB < 0.0;
          if (uEow > 0.5 && (vW.y < 0.02 || wetOut)) discard;      // P68c: space has no bedrock below the lattice and no rock beyond it
          vec2 oL = max(max(-vW.xz, vW.xz - uLat), 0.0);
          float bedL = max(1.08 - length(oL) * 0.06, 0.02);
          // a world without a sea (the 2D desert): the rock under the plain at the sea level, not a ledge
          // standing above it
          if (uUnder < 0.5) bedL = min(bedL, uSea - 0.02);
          if (wetOut && vW.y >= bedL) discard;
          bool deepR = vW.y < 0.02 || wetOut;
          float d0 = deepR ? 1.0 : outL ? fl.x - vW.y : dens(vW);
          vec4 cLv = d0 > 0.0 || outL ? vec4(0.0) : lavaCol(vW.xz);
          // only the air between the bed (the column's highest solid) and the lava surface holds layer lava. Air BELOW
          // the bed is a cave under the flow, not lava (user 2026-10-08 "lava pillar": a cave under a lava river was
          // drawn as a solid orange column inside the rock). 0.3 m covers the bilinear bed blend at the flow's edges.
          bool capLava = d0 <= 0.0 && cLv.g > 0.004 && vW.y < cLv.r && vW.y > cLv.a - 0.3;
          // weather cover (5e): air within the column's snow + ash depth above solid ground, open to the sky
          // (nothing solid within 4 m above), is drawn as the cover layer lying on the section's ground line
          float capCv = 0.0, capAsh = 0.0;
          if (d0 <= 0.0 && !capLava && !outL) {
            vec2 cq = texture(tCover, (vW.xz * 2.0 + 0.5) / uNL).rg * 0.4;
            float cT = cq.x + cq.y;
            if (cT > 0.004 && dens(vW - vec3(0.0, cT, 0.0)) > 0.0) {
              capCv = 1.0; capAsh = cq.y / cT;
              for (int k = 1; k <= 8; k++) {
                if (dens(vW + vec3(0.0, float(k) * 0.5, 0.0)) > 0.0) {
                  capCv = 0.0;
                  break;
                }
              }
            }
          }
          // P76 dripstone (caves only): air under a roof / over a floor within a few decimetres holds stalactites /
          // stalagmites, drawn as part of the cut
          float capDrip = 0.0;
          if (uUnder > 0.5 && d0 <= 0.0 && !capLava && !outL && !deepR && capCv < 0.5) {
            float cw = 0.5, cid = floor(tau / cw), fx = fract(tau / cw);
            float hA = h11(cid * 3.7 + 1.0), hB = h11(cid * 7.9 + 2.0), hC = h11(cid * 1.3 + 5.0);
            float up = 9.0, dn = 9.0;
            for (int k = 1; k <= 6; k++) {
              if (up > 8.0 && dens(vW + vec3(0.0, float(k) * 0.1, 0.0)) > 0.0) up = float(k) * 0.1;
            }
            if (up > 8.0) {
              for (int k = 1; k <= 6; k++) {
                if (dn > 8.0 && dens(vW - vec3(0.0, float(k) * 0.1, 0.0)) > 0.0) dn = float(k) * 0.1;
              }
            }
            float wdt = 0.06 + 0.1 * hB, dx = abs(fx - (0.2 + 0.6 * hC)) * cw;
            float prof = max(0.0, 1.0 - dx / wdt);
            if (up < 8.0 && hA < 0.62) capDrip = step(up, (0.14 + 0.62 * hB * hB) * pow(prof, 1.25) + 0.02 * prof);
            if (dn < 8.0 && hA > 0.82) capDrip = max(capDrip, step(dn, (0.08 + 0.26 * hB) * pow(prof, 1.4)));
          }
          if (!deepR && ((d0 <= 0.0 && !capLava && capCv < 0.5 && capDrip < 0.5) || vW.y < 0.02)) discard;
          // .r has 4 cells per tile: at 0.11-0.13 /m that is ~2 m features; .g (16 cells) adds a little ~1 m wobble
          // (C1: 3D noise at the world point, so the boundary wobble stays under the worm and morphs further out)
          vec2 jn = vec2(n3(vW * vec3(0.11, 0.13, 0.11)).r, n3(vW * vec3(0.13, 0.11, 0.13) + vec3(0.5, 0.3, 0.7)).r) - 0.5;
          jn += (vec2(n3(vW * vec3(0.031, 0.037, 0.031)).g, n3(vW * vec3(0.037, 0.031, 0.037) + vec3(0.4, 0.7, 0.2)).g) - 0.5) * 0.45;
          vec3 jp = vW + vec3(dW.x, 0.0, dW.y) * jn.x * 0.9 + vec3(0.0, jn.y * 0.8, 0.0);
          if (uNPl > 0 && plateIdx(vW) >= 0) jp = vW;       // P37 W4: a plate's cut keeps its crisp straight edges (no organic wobble)
          vec3 gg = jp / 0.5;
          ivec3 vmax = ivec3(uVolSize) - 1;
          float Wm[17];            // materials 1-16 (13 girder steel, 14 foam, 15 concrete, 16 obsidian: their own cap colours, capCol)
          for (int i = 0; i < 17; i++) Wm[i] = 0.0;
          float hs = 0.0, hw = 0.0;
          if (!outL && !deepR) {                         // (beyond the lattice the clamped volume would smear the border)
        #ifdef CAP_BSPLINE
          ivec3 c = ivec3(floor(gg + 0.5));
          vec3 f = gg - vec3(c);
          vec3 wa = 0.5 * (0.5 - f) * (0.5 - f), wb = 0.75 - f * f, wc = 0.5 * (0.5 + f) * (0.5 + f);
          for (int q = 0; q < 27; q++) {
            ivec3 oq = ivec3(q % 3, (q / 3) % 3, q / 9) - 1;
            vec2 tv = texelFetch(tVol, clamp(c + oq, ivec3(0), vmax), 0).rg;
            int g = int(tv.g + 0.5), mq = g & 31;
            if (mq == 0 || mq > 16 || tv.r <= 0.0) continue;
            float w = (oq.x < 0 ? wa.x : oq.x == 0 ? wb.x : wc.x) * (oq.y < 0 ? wa.y : oq.y == 0 ? wb.y : wc.y) * (oq.z < 0 ? wa.z : oq.z == 0 ? wb.z : wc.z) + 1e-4;
            Wm[mq] += w; hs += float(g >> 5) * w; hw += w;
          }
        #else
          ivec3 b = ivec3(floor(gg));
          vec3 fr = fract(gg);
          for (int q = 0; q < 8; q++) {
            ivec3 oq = ivec3(q & 1, (q >> 1) & 1, q >> 2);
            vec2 tv = texelFetch(tVol, clamp(b + oq, ivec3(0), vmax), 0).rg;
            int g = int(tv.g + 0.5), mq = g & 31;
            if (mq == 0 || mq > 16 || tv.r <= 0.0) continue;
            vec3 t = vec3(oq);
            float w = mix(1.0 - fr.x, fr.x, t.x) * mix(1.0 - fr.y, fr.y, t.y) * mix(1.0 - fr.z, fr.z, t.z) + 1e-3;
            Wm[mq] += w; hs += float(g >> 5) * w; hw += w;
          }
        #endif
          }
          // D5: the far layering (RULES.desert from the strip) at the jittered point, blended in over the last metre
          // inside the border (k: 0 on / beyond the border -> 1 one metre inside)
          if (farOn && eB < 1.0) {
            float k = outL ? 0.0 : smoothstep(0.0, 1.0, eB), ws = 0.0;
            for (int i = 1; i < 17; i++) ws += Wm[i];
            float nv = ws > 0.0 ? k / ws : 0.0;
            for (int i = 1; i < 17; i++) Wm[i] *= nv;
            vec4 fj = farAt(dot(jp.xz, dW));
            float wS = smoothstep(fj.y - 0.3, fj.y + 0.3, jp.y), wD = 1.0 - smoothstep(fj.z - 0.3, fj.z + 0.3, jp.y),
              wBd = 1.0 - smoothstep(0.7, 1.3, jp.y), o = 1.0 - k;
            Wm[4] += o * wS;
            Wm[5] += o * (1.0 - wS) * (1.0 - wD);
            Wm[2] += o * (1.0 - wS) * wD * (1.0 - wBd);
            Wm[1] += o * (1.0 - wS) * wD * wBd;
          }
          if (deepR) Wm[1] = 1.0;                        // the deep body: bedrock (charcoal basalt on a volcanic island)
          int m1 = 2, m2 = 2;
          float w1 = -1.0, w2 = -1.0;
          for (int i = 1; i < 17; i++) {
            float v = Wm[i];
            if (v > w1) {
              w2 = w1;
              m2 = m1;
              w1 = v;
              m1 = i;
            } else if (v > w2) {
              w2 = v;
              m2 = i;
            }
          }
          float heat = hw > 0.0 ? hs / hw / 15.0 : 0.0;
          {
            float ws = 0.0;
            for (int i = 1; i < 17; i++) ws += Wm[i];
            gLava = Wm[9] / max(ws, 1e-4);
          }
          // depth below the nearest air above (march up the column)
          float depthB = 6.0;
          if (deepR) depthB = 6.0;
          else if (outL) depthB = clamp(fl.x - vW.y, 0.0, 6.0);
          else
            for (int k = 1; k <= 12; k++) {
              if (dens(vW + vec3(0.0, float(k) * 0.5, 0.0)) <= 0.0) {
                depthB = float(k) * 0.5 - 0.25;
                break;
              }
            }
        `)
          .replace('#include <map_fragment>', /* glsl */`
          float nb = n3(vW * vec3(0.21, 0.09, 0.21)).b, nz = n3(vW * vec3(0.05, 0.02, 0.05)).g;
          float warp = (n3(vW * vec3(0.012, 0.0, 0.012) + vec3(0.0, 0.37, 0.0)).a - 0.5) * 3.5 + (nz - 0.5) * 0.6;
          vec2 pu = vec2(tau, vW.y);
          // P118b: the sedimentary strata (sandStrata) are only built where a rock-like material is drawn
          bool needStrata = m1 == 1 || m1 == 2 || m1 == 5 || m1 == 8 || m1 == 10 || m1 == 12 || (w2 > 0.0 && (m2 == 1 || m2 == 2 || m2 == 5 || m2 == 8 || m2 == 10 || m2 == 12));
          vec3 strata = needStrata ? sandStrata(pu, vW.y + warp, max(length(cGx), length(cGy)), uStrata) * mix(vec3(0.94), vec3(1.06), nb) * 0.7 : vec3(0.3);
          float dd = depthB + (nb - 0.5) * 0.25;
          vec4 sf = outL || deepR ? vec4(0.0) : texture(tSurf, (vW.xz * 2.0 + 0.5) / uNL);
          vec3 e1, e2;
          vec3 col = capCol(m1, pu, strata, dd, sf, heat, e1);
          float tb = w2 > 0.0 ? smoothstep(-0.24, 0.24, (w2 - w1) / (w1 + w2) + (n3(vW * vec3(0.09, 0.1, 0.09) + float(m2) * 0.37).r - n3(vW * vec3(0.09, 0.1, 0.09) + float(m1) * 0.37).r) * 0.25) : 0.0;
          if (tb > 0.002) col = mix(col, capCol(m2, pu, strata, dd, sf, heat, e2), tb);
          else e2 = vec3(0.0);
          vec3 cEmis = mix(e1, e2, tb);
          if (!outL && !deepR && uCapDet > 0.5 && !capLava && capCv < 0.5 && uEow < 0.5) {
            vec3 dEm;
            col = capDetail(col, m1, pu, dd, nb, sf.r, heat, dEm);
            cEmis += dEm;
          }
          col *= mix(1.0, 0.68, smoothstep(1.0, 8.0, dd));                                // deeper = darker
          // P56: contact shading along the cut's border (a baked AO: air within 0.5 / 1.2 m in the plane and below)
          if (!outL && !deepR) {
            vec3 dw3 = vec3(dW.x, 0.0, dW.y);
            float ao = (dens(vW + dw3 * 0.5) <= 0.0 ? 1.0 : 0.0) + (dens(vW - dw3 * 0.5) <= 0.0 ? 1.0 : 0.0) + (dens(vW - vec3(0.0, 0.5, 0.0)) <= 0.0 ? 1.0 : 0.0)
                    + 0.6 * ((dens(vW + dw3 * 1.2) <= 0.0 ? 1.0 : 0.0) + (dens(vW - dw3 * 1.2) <= 0.0 ? 1.0 : 0.0) + (dens(vW + vec3(0.0, 1.2, 0.0)) <= 0.0 ? 1.0 : 0.0));
            col *= 1.0 - 0.085 * ao;
          }
          col *= mix(1.0, 0.42, smoothstep(0.0, 70.0, -vW.y));                           // P29a: the deep body fades darker
          col *= mix(1.0, 0.62, (1.0 - smoothstep(uSea - 1.0, uSea + 0.3, vW.y)));               // waterlogged base
          col = mix(col, vec3(0.05, 0.045, 0.04), sf.b * (1.0 - smoothstep(0.0, 0.35, dd)) * 0.8); // charred surface
          if (capLava) {
            float skinF;
            cEmis = lavaSection(pu, cLv.r - vW.y, vW.y - cLv.a, cLv.b, skinF);
            col = vec3(0.034, 0.03, 0.028) * skinF;
          }
          if (capCv > 0.5) {
            col = mix(vec3(0.84, 0.87, 0.93) * (0.92 + 0.12 * nb), vec3(0.085, 0.08, 0.078) * (0.8 + 0.4 * nb), smoothstep(0.4, 0.6, capAsh));
            cEmis = vec3(0.0);
          }
          // P76: dripstone: pale banded limestone, wet at the tip
          if (capDrip > 0.5) {
            float bd = 0.85 + 0.25 * sin(pu.y * 38.0 + nb * 9.0);
            col = vec3(0.64, 0.58, 0.48) * bd * (0.9 + 0.2 * nb); cEmis = vec3(0.0); gCapWet = 0.75;
          }
          col = mix(vec3(dot(col, vec3(0.299, 0.587, 0.114))), col, uCapK.w) * uCapK.rgb;
          // P65b: contact shade of worms / props reads on the cut line too
          col *= conAO(vW);
          // P66b: cracks cut by the section
          if (uCrackOn > 0.5) {
            vec4 ckn = n3(vW * 2.3);
            float ckm = crackMask(vW, ckn.r, ckn.g);
            col = mix(col, vec3(0.03, 0.026, 0.022), ckm * 0.92);
          }
          diffuseColor.rgb = col;
        `)
          .replace('#include <opaque_fragment>', 'outgoingLight = capPost(outgoingLight, diffuseColor.rgb);\n#include <opaque_fragment>')
          // tools (tools/dev/p118bshot.cjs): 1 = the cut face magenta (a mask), 2 = material ids (m1, m2, blend) as raw
          // colour
          .replace(
            '#include <dithering_fragment>',
            '#include <dithering_fragment>\n if (uCapDbg > 0.5) gl_FragColor = uCapDbg > 1.5 ? vec4(float(m1) / 255.0, float(m2) / 255.0, tb, 1.0) : vec4(1.0, 0.0, 1.0, 1.0);'
          )
          // P76: wet seepage / crystals shine
          .replace(
            '#include <roughnessmap_fragment>',
            '#include <roughnessmap_fragment>\n roughnessFactor = mix(roughnessFactor, 0.28, gCapWet);'
          )
          // the rock of the cut round a fresh crater glows in cracks too
          .replace(
            '#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n totalEmissiveRadiance += cEmis + 0.55 * eoCrater(vW);'
          )
          // the cut face is an open section (nothing is drawn in front of it): light it from the sun's side of the
          // plane with a slight upward tilt (uCapN), so it reads the same whether the sun is in front or behind
          .replace(
            '#include <normal_fragment_maps>',
            '#include <normal_fragment_maps>\n normal = normalize((viewMatrix * vec4(uCapN, 0.0)).xyz);'
          );
      sh.fragmentShader = 'uniform vec3 uCapN; uniform vec4 uCapK;\n' + CON_AO + sh.fragmentShader;
    };
    m.customProgramCacheKey = () => bspline ? 'cap5b' : 'cap5';
    return m;
  }

  /* the shader's copy of the organic-top table (config MATS[].veg): 1 where nothing grows on the material, one vec4 per
   * weight slot group. Called at init; a tool that changes the table calls it again. */
  TR.syncVeg = function () {
    const L = SS.CFG.VEG_LEVEL, A = U.uNoVeg.value;
    for (let r = 0; r < 4; r++) A[r].set(L[1 + r * 4] ? 0 : 1, L[2 + r * 4] ? 0 : 1, L[3 + r * 4] ? 0 : 1, L[4 + r * 4] ? 0 : 1);
  };
  TR.init = function (sc, textures, quality) {
    scene = sc; tx = textures; Q = quality;
    const W = SS.world;
    Object.assign(U, {
      tMats: { value: tx.mats }, tNoise: { value: tx.noise }, tSurf: { value: null }, tScY: { value: null }, tWater: { value: null },
      tLavaS: { value: null }, uLavaOn: { value: 0 }, tCover: { value: null }, uDbgBack: { value: 0 },
      // P66b (render/cracks.js)   // tools: 1 body / 2 all slab back faces magenta
      tCrack: { value: SS.crackView ? SS.crackView.dummy() : null }, uCrackOn: { value: 0 }, uCrackSize: { value: new T.Vector3(1, 1, 1) },
      uCtxSolid: { value: 0 },  // D3: 1 = far context opaque, no ghost haze (dry worlds; set by view.js newWorld)
      // P29j: the slice-view setting: 1 (thin / thick) = the landscape behind the slab recedes into haze; 0 (full) =
      // crisp
      uCtxHaze: { value: 1 },
      uO: { value: new T.Vector3() }, uN: { value: new T.Vector3(0, 0, 1) }, uHaze: { value: new T.Color(0xf3d2b0) },
      uCaveAmb: { value: new T.Color(0, 0, 0) },
      uGrassTint: { value: new T.Color(1, 1, 1) }, uDryTint: { value: new T.Color(1, 1, 1) }, uSunDir: { value: new T.Vector3(0, 1, 0) },
      uHalf: { value: C.HALF }, uBack: { value: C.HALF }, uAlpha: { value: 0 }, uTime: { value: 0 }, uSea: { value: W.SEA },
      uBeach: { value: 0 }, uWet: { value: 0 }, uSnow: { value: 0 },
      uConcNight: { value: 0 }, uCaustic: { value: 1 }, uCloudSh: { value: new T.Vector4(0, 0, 0, 0) },
      uDetail: { value: Q.detail ? 1 : 0 }, uPlayR: { value: 0 }, uVolc: { value: 0 },
      // P90: fumarole craters in the terrain shader (render/vents.js)
      uVent: { value: Array.from({ length: 8 }, () => new T.Vector4()) }, uNVent: { value: 0 }, uVentHot: { value: 0 },
      uNL: { value: W.NX },
      uLatR: { value: new T.Vector3(48, 48, 0) },   // D6: dry worlds' lattice disc (x, z, r; r 0 = off, set per frame)
      // P37 W4: plate registry
      uPlA: { value: Array.from({ length: 24 }, () => new T.Vector4()) },
      uPlB: { value: Array.from({ length: 24 }, () => new T.Vector4()) },
      uPlC: { value: Array.from({ length: 24 }, () => new T.Vector4()) }, uNPl: { value: 0 },
      uCon: { value: Array.from({ length: 24 }, () => new T.Vector4()) }, uNCon: { value: 0 },   // P65b: contact shadows (render/ground.js)
      uMatP: { value: MATP.map(p => new T.Vector4(p[0], p[1], p[2], p[3])) },
      uMatTint: { value: TINT.map(c => new T.Vector3(c[0], c[1], c[2])) },
      uRelief: { value: RELIEF.map(c => new T.Vector4(c[0], c[1], c[2], c[3])) }, tRel: { value: tx.noise3 },
      uGlint: { value: GLINT.slice() },
      // the organic-top table, one flag per weight slot (mA: bedrock rock soil sand, mB: sandstone snow ice basalt, mC:
      // lava crust ash scree, mD: steel foam concrete obsidian), filled by TR.syncVeg
      uNoVeg: { value: [0, 1, 2, 3].map(() => new T.Vector4()) }
    });
    TR.syncVeg();
    // 3D world texture RG16F: R = density (raw, linear filtering = the sim's trilinear W.sample; 8-bit put the cap's
    // edge up to 15 cm off the collision line, O1), G = material | heat << 5 as an integer (texelFetch; P31: 5 material
    // bits for obsidian, 16)
    VOLSIZE.set(W.NX, W.NY, W.NZ);
    volData = new Uint16Array(W.N * 2);
    volTex = new T.Data3DTexture(volData, W.NX, W.NY, W.NZ);
    volTex.format = T.RGFormat; volTex.type = T.HalfFloatType; volTex.unpackAlignment = 1;
    volTex.minFilter = volTex.magFilter = T.LinearFilter; volTex.wrapS = volTex.wrapT = volTex.wrapR = T.ClampToEdgeWrapping;
    volTex.generateMipmaps = false; volTex.needsUpdate = true;
    SS.slab2d.init(tx.noise);
    slabMat = terrainMaterial(0);
    ctxFar = terrainMaterial(1);
    ctxNear = terrainMaterial(3);
    bodyMats = {
      slab: terrainMaterial(0, true),
      far: terrainMaterial(1, true),
      pre: terrainMaterial(2, true),
      near: terrainMaterial(3, true)
    };
    slabDepth = slabDepthMaterial();
    farData = new Float32Array(FAR_N * 4);
    FAR.tFar.value = new T.DataTexture(farData, FAR_N, 1, T.RGBAFormat, T.FloatType);
    FAR.tFar.value.minFilter = FAR.tFar.value.magFilter = T.NearestFilter; FAR.tFar.value.needsUpdate = true;
    FAR.uFar.value = new T.Vector4(0, 1, FAR_N, 0); FAR.uLat.value = new T.Vector2(W.SX, W.SZ);
    CAPU.tN3.value = tx.noise3;
    // P118b: the low quality skips the medium aggregate layer of the concrete cut
    CAPU.uConcQ.value = Q.name === 'low' ? 0 : 1;
    capMat = capMaterial();
    capN.value = new T.Vector3(0, 0, 1);
    cap = new T.Mesh(new T.PlaneGeometry(1, 1), capMat); cap.frustumCulled = false; scene.add(cap);   // no shadows: open section
    // (user 2026-10-08: buried lava must NOT glow through the rock: the old 'lava x-ray' sprites are gone; lava shows
    //  where it is open or cut by the section)
  };
  TR.dispose = function () {
    chunks.forEach((c, ci) => {
      if (c) {
        for (const m of c.meshes) scene.remove(m);
        c.geo.dispose();
        if (TR.onChunk) TR.onChunk(ci, null);
      }
    });
    chunks = [];
  };

  /* ---------- volume texture ---------- */
  /* float -> IEEE half (round to nearest; |v| < 65504, subnormals kept): C would use _cvtss_sh / a cast to _Float16 */
  const hF = new Float32Array(1), hU = new Uint32Array(hF.buffer), HALF_INT = new Uint16Array(512);
  function toHalf(v) {
    hF[0] = v;
    const x = hU[0], sign = (x >>> 16) & 0x8000, e = ((x >>> 23) & 0xff) - 112;
    let m = x & 0x7fffff;
    if (e <= 0) {
      if (e < -10) return sign;
      m = (m | 0x800000) >>> (1 - e);
      return sign | ((m + 0x1000) >>> 13);
    }
    if (e >= 31) return sign | 0x7c00;
    return sign | ((e << 10) + ((m + 0x1000) >>> 13));
  }
  for (let q = 0; q < 512; q++) HALF_INT[q] = toHalf(q);
  function packBox(i0, j0, k0, i1, j1, k1) {
    const W = SS.world, D = W.d, Mt = W.mat, Ht = W.heat;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++) {
        let o = (k * W.NY + j) * W.NX + i0;
        for (let i = i0; i <= i1; i++, o++) {
          volData[o * 2] = toHalf(D[o]);
          volData[o * 2 + 1] = HALF_INT[Mt[o] | ((Ht[o] >> 4) << 5)];
        }
      }
  }
  TR.toHalf = toHalf;
  function uploadVolumeBox(renderer, b) {
    const W = SS.world;
    packBox(b.i0, b.j0, b.k0, b.i1, b.j1, b.k1);
    const props = renderer.properties.get(volTex), gl = renderer.getContext();
    if (!props.__webglTexture || !gl.texSubImage3D) {
      volTex.needsUpdate = true;
      return;
    }
    renderer.state.bindTexture(gl.TEXTURE_3D, props.__webglTexture);
    // Three leaves UNPACK_FLIP_Y / PREMULTIPLY_ALPHA from its last 2D upload; both are invalid for 3D uploads
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W.NX); gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, W.NY);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, b.i0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, b.j0); gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, b.k0);
    gl.texSubImage3D(gl.TEXTURE_3D, 0, b.i0, b.j0, b.k0, b.i1 - b.i0 + 1, b.j1 - b.j0 + 1, b.k1 - b.k0 + 1, gl.RG, gl.HALF_FLOAT, volData);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0); gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0); gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
  }

  /* the cave overview's glass. Every tunnel wall of the network as an additive, unlit sheet, brightest at the grazing
   * angle (a tube reads as a tube, the near and the far wall add up),
   * azure in front of the section plane and warm behind it (the colour flips exactly where the plane cuts the tunnel),
   * fading with the distance to the plane. No depth test: the part behind the face shows through it, faintly (the face
   * stays the brightest thing), and nothing here is opaque, so nothing hides the face. XR.uK = the overview's ease (0
   * outside it). */
  function xrayMaterial() {
    const m = new T.ShaderMaterial({
      transparent: true, depthWrite: false, depthTest: false, side: T.DoubleSide, blending: T.AdditiveBlending, fog: false,
      uniforms: { uO: U.uO, uN: U.uN, uK: XR.uK, uCF: XR.uCF, uCB: XR.uCB, uDisc: XR.uDisc },
      vertexShader: /* glsl */`varying vec3 vN;
        varying vec3 vW;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vW = w.xyz;
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `uniform vec3 uO, uN, uCF, uCB, uDisc;
        uniform float uK;
        varying vec3 vN;
        varying vec3 vW;
        void main() {
          if (uDisc.z > 0.0 && length(vW.xz - uDisc.xy) > uDisc.z) discard;
          float f = 1.0 - abs(dot(normalize(vN), normalize(cameraPosition - vW)));
          float t = dot(vW - uO, uN), side = step(0.0, t);
          float a = (0.02 + 0.25 * f * f) * exp(-abs(t) / 48.0) * mix(0.8, 1.0, side) * uK;
          gl_FragColor = vec4(mix(uCB, uCF, side) * a, 1.0);
          #include <colorspace_fragment>
        }`
    });
    return SS.section.exempt(m, 'cave overview x-ray (the tunnels in front of the plane are the point)');
  }
  /* ---------- chunks ---------- */
  // P113: 4^2 = 16 triangles per source triangle in the 2D band (0.5 m cells -> 0.125 m)
  const SUBDIV = 2;
  function buildChunk(ci) {
    const W = SS.world, cx = ci % W.CX, cy = Math.floor(ci / W.CX) % W.CY, cz = Math.floor(ci / (W.CX * W.CY));
    const m = SS.meshgen.chunk(cx, cy, cz);
    let c = chunks[ci];
    if (!m.idx.length) {
      if (c) {
        for (const mm of c.meshes) scene.remove(mm);
        c.geo.dispose();
        chunks[ci] = null;
        if (TR.onChunk) TR.onChunk(ci, null);
      }
      return { ver: W.chunkVer[ci], empty: true };
    }
    const g = new T.BufferGeometry();
    /* P113: in a 2D match the slab's visible band (the 1.5 m behind the plane) is subdivided so the ground relief
     * (render/slab2d.js) has vertices to move;
     * c.data stays the raw chunk (grass / clutter / picking place on it) */
    const gm = SS.slab2d.on() ? SS.slab2d.subdivide(m, SS.world.MZ - 2.1, SS.world.MZ + 0.3, SUBDIV) : m;
    g.setAttribute('position', new T.BufferAttribute(gm.pos, 3));
    g.setAttribute('normal', new T.BufferAttribute(gm.nrm, 3));
    g.setAttribute('mA', new T.BufferAttribute(gm.mA, 4, true));
    g.setAttribute('mB', new T.BufferAttribute(gm.mB, 4, true));
    g.setAttribute('mC', new T.BufferAttribute(gm.mC, 4, true));
    g.setAttribute('mD', new T.BufferAttribute(gm.mD || new Uint8Array(gm.mC.length), 4, true));
    g.setAttribute('depth', new T.BufferAttribute(gm.depth, 1));
    g.setIndex(new T.BufferAttribute(gm.idx, 1));
    g.computeBoundingSphere(); g.computeBoundingBox();
    if (!c) {
      const slab = new T.Mesh(g, slabMat);
      slab.castShadow = true;
      slab.receiveShadow = true;
      slab.customDepthMaterial = slabDepth;
      const far = new T.Mesh(g, ctxFar);
      far.renderOrder = 5;
      const near = new T.Mesh(g, ctxNear);
      near.renderOrder = 7;
      c = chunks[ci] = { meshes: [slab, far, near], slab, far, near, geo: g };
      scene.add(slab, far, near);
      // the x-ray mesh of the cave overview (shares the geometry, drawn only there)
      if (SS.world.under) {
        const holo = new T.Mesh(g, holoMat || (holoMat = xrayMaterial()));
        holo.renderOrder = 7;
        holo.frustumCulled = false;
        holo.visible = false;
        c.holo = holo; c.meshes.push(holo); scene.add(holo);
      }
    } else {
      c.geo.dispose(); c.geo = g;
      for (const mm of c.meshes) mm.geometry = g;
    }
    c.ver = W.chunkVer[ci]; c.tris = m.idx.length / 3; c.data = m;
    c.box = g.boundingBox;
    if (TR.onChunk) TR.onChunk(ci, c);
    return c;
  }
  const built = [];
  let chunkMs = 2;                                       // expected cost of one chunk build (ms)
  /* full build at load (async, reports progress) */
  /* P38: the map size changed (a new World lattice): re-create the volume texture and the size uniforms. */
  function resize() {
    const W = SS.world;
    if (volTex.image.width === W.NX && volTex.image.height === W.NY && volTex.image.depth === W.NZ) return;
    volTex.dispose();                                    // (three: the old GL storage is immutable, a new one is allocated)
    volData = new Uint16Array(W.N * 2);
    volTex.image = { data: volData, width: W.NX, height: W.NY, depth: W.NZ };
    volTex.needsUpdate = true;
    VOLSIZE.set(W.NX, W.NY, W.NZ);
    U.uNL.value = W.NX;
    FAR.uLat.value.set(W.SX, W.SZ);
    farKey = null; farRange = null;
  }
  TR.buildAll = async function (renderer, onProgress) {
    const W = SS.world;
    resize();
    const n = W.CX * W.CY * W.CZ;
    TR.dispose();
    built.length = n;
    packBox(0, 0, 0, W.NX - 1, W.NY - 1, W.NZ - 1); volTex.needsUpdate = true;
    let t0 = performance.now();
    for (let ci = 0; ci < n; ci++) {
      const c = buildChunk(ci);
      built[ci] = c.ver;
      if (performance.now() - t0 > 40) {
        onProgress && onProgress((ci + 1) / n);
        await new Promise(r => setTimeout(r, 0));
        t0 = performance.now();
      }
    }
    W.dirtyBox = null;
    onProgress && onProgress(1);
  };
  TR.chunks = () => chunks;
  /* per frame: remesh changed chunks under a time budget, slab chunks first */
  TR.update = function (renderer, S, dt, budgetMs) {
    const W = SS.world, n = W.CX * W.CY * W.CZ;
    if (W.dirtyBox) {
      uploadVolumeBox(renderer, W.dirtyBox);
      W.dirtyBox = null;
    }
    const t0 = performance.now(), n0 = SS.plane.nrm(S);
    const order = [];
    for (let ci = 0; ci < n; ci++)
      if (built[ci] !== W.chunkVer[ci]) order.push(ci);
    if (order.length) {
      const pr = ci => {
        const c = chunks[ci];
        if (!c || !c.box) return 1;
        return slabHits(c.box, S, n0) ? 0 : 1;
      };
      order.sort((a, b) => pr(a) - pr(b));
      /* P38-R4: the budget is checked BEFORE a build (the old check ran after it: a frame always overran by one chunk):
       * the next chunk is
       * built only if the time spent plus its expected cost (the slowest of the last builds, decayed) fits; at least
       * one per frame */
      for (let q = 0; q < order.length; q++) {
        if (q > 0 && performance.now() - t0 + chunkMs > budgetMs) break;
        const t1 = performance.now(), c = buildChunk(order[q]);
        built[order[q]] = c.ver;
        const d = performance.now() - t1;
        chunkMs = d > chunkMs ? d : chunkMs * 0.9 + d * 0.1;
      }
    }
    // visibility: slab only for chunks that intersect the band
    for (const c of chunks)
      if (c) c.slab.visible = slabHits(c.box, S, n0);
    U.uO.value.set(S.O.x, 0, S.O.z); U.uN.value.set(n0.x, 0, n0.z);
    {
      const c = W.circ;
      U.uLatR.value.set(c ? c.x : W.MX, c ? c.z : W.MZ, c ? c.r : 0);
    }
    // cap plane at slice zero (t = -0.002); dry worlds: out to FAR_S m beyond the lattice exits (D5 far strip)
    const d = SS.plane.dir(S), r = W.dry && SS.worldgen.far_layers ? buildFar(S, d) : SS.plane.range(S);
    // C1: a new pivot on the same plane (rotate_by re-centres O on the worm) must not shift the face's texture:
    // uS0 += (O' − O)·d keeps τ = s + uS0 of every face point; turning about a fixed O leaves τ alone
    if (capPivot && (capPivot.x !== S.O.x || capPivot.z !== S.O.z))
      CAPU.uS0.value += (S.O.x - capPivot.x) * d.x + (S.O.z - capPivot.z) * d.z;
    capPivot = { x: S.O.x, z: S.O.z };
    CAPU.uUnder.value = SS.world.under ? 1 : 0;
    if (!W.dry) FAR.uFar.value.w = 0;
    // P29a: down to CAP_DEEP below the lattice floor; wet worlds also CAP_EXT beyond the lattice exits (rock under the
    // sea) the overview of a cave world shows the section of the world box only: the 3 km x 400 m rock wall round it
    // was a dark strata field filling the lower half of the picture
    // (the cave overview: the face of the round play area only, the chord)
    const box = W.under && S.inspect > 0.02,
      rb = box ? SS.plane.chord(S) || r : r,
      ext = W.dry || box ? 0 : CAP_EXT,
      deep = box ? 0 : CAP_DEEP,
      mid = (rb[0] + rb[1]) / 2,
      L = rb[1] - rb[0] + 2 * ext;
    cap.position.set(S.O.x + d.x * mid - n0.x * 0.002, (W.SY - deep) / 2, S.O.z + d.z * mid - n0.z * 0.002);
    cap.scale.set(L, W.SY + deep, 1);
    cap.rotation.set(0, Math.atan2(n0.x, n0.z), 0);
    // (underground there is no sun: the face is lit by the worm's lamp, which hangs on the camera side, so its lighting
    // normal faces the camera whatever the sun's direction: it faced away on half of the section angles and the lamp
    // did not reach it)
    {
      const L = U.uSunDir.value, sd = W.under || n0.x * L.x + n0.z * L.z >= 0 ? 1 : -1;
      capN.value.set(n0.x * sd, 0.35, n0.z * sd).normalize();
    }
  };
  /* D5: the far strip along the section (dry worlds), rebuilt when the section moves; returns the cap's [s0, s1] */
  const farO = [0, 0];
  function buildFar(S, d) {
    const W = SS.world, G = SS.worldgen, key = S.O.x + ',' + S.O.z + ',' + S.theta + ',' + W.SX;
    if (key === farKey && farRange) return farRange;
    let sA = -1e9, sB = 1e9;
    for (const [o, v, Lx] of [[S.O.x, d.x, W.SX], [S.O.z, d.z, W.SZ]]) {
      if (Math.abs(v) < 1e-9) continue;
      const a = -o / v, b = (Lx - o) / v;
      sA = Math.max(sA, Math.min(a, b));
      sB = Math.min(sB, Math.max(a, b));
    }
    if (sA > sB) sA = sB = 0;                              // D6: the line misses the lattice: around the worm only
    sA = Math.min(sA, 0); sB = Math.max(sB, 0);              // (and always covering the rotation centre)
    const s0 = sA - FAR_S, s1 = sB + FAR_S, ds = (s1 - s0) / (FAR_N - 1);
    for (let i = 0; i < FAR_N; i++) {
      const s = s0 + i * ds;
      G.far_layers(S.O.x + d.x * s, S.O.z + d.z * s, farO);
      farData[i * 4] = farO[0];
      farData[i * 4 + 1] = farO[0] - farO[1] - G.SAND_EXTRA;
      farData[i * 4 + 2] = farO[0] - G.ROCK_DV;
      farData[i * 4 + 3] = 1;
    }
    FAR.tFar.value.needsUpdate = true;
    FAR.uFar.value.set(S.O.x * d.x + S.O.z * d.z + s0, ds, FAR_N, 1);
    farKey = key; farRange = [s0, s1];
    return farRange;
  }
  TR.capMesh = () => cap;                                  // (tools: hide the section face)
  // the range of t (signed distance from slice zero) a chunk box spans: its four vertical edges
  const TB = { lo: 0, hi: 0 };
  function tRange(box, S, n0) {
    TB.lo = 1e9;
    TB.hi = -1e9;
    for (let q = 0; q < 4; q++) {
      const x = q & 1 ? box.max.x : box.min.x, z = q & 2 ? box.max.z : box.min.z, t = (x - S.O.x) * n0.x + (z - S.O.z) * n0.z;
      TB.lo = Math.min(TB.lo, t);
      TB.hi = Math.max(TB.hi, t);
    }
    return TB;
  }
  function slabHits(box, S, n0) {
    if (!box) return false;
    const r = tRange(box, S, n0);
    return ovr || ((r.lo <= 0.5 || SS.section.frontOn) && r.hi >= -U.uBack.value - 0.5);
  }
  // the far context is the part behind the slab (t < -uBack, the context shaders clip the rest): a chunk wholly in
  // front of it has none, its depth pre-pass and blend meshes stay off
  const hasBehind = (box, S, n0) => !!box && tRange(box, S, n0).lo < -U.uBack.value + 0.5;
  /* per frame visual uniforms */
  TR.frame = function (S, view, ctxA, inspect) {
    U.uTime.value = view.time;
    SS.slab2d.update(S, U.uBack.value);
    U.uAlpha.value = ctxA;
    {
      const wet = U.uWet.value, want = S.biome === 'volcanic' || S.eow || wet > 0.01;
      if (want) {
        envOff = 0;
        setEnv(true);
      } else if (envOn && ++envOff > 120) setEnv(false);
    }
    U.uVolc.value = S.biome === 'volcanic' ? 1 : 0;          // volcanic island: the deep bedrock is black basalt too
    // P65i: boulders of generic rock / sandstone on the volcanic island are dark tuff, not beach sand
    {
      const mt = U.uMatTint.value, vo = U.uVolc.value > 0.5;
      mt[1].set(vo ? 0.4 : TINT[1][0], vo ? 0.38 : TINT[1][1], vo ? 0.37 : TINT[1][2]);
      mt[4].set(vo ? 0.42 : TINT[4][0], vo ? 0.38 : TINT[4][1], vo ? 0.36 : TINT[4][2]);
    }
    // P37 W4: the girder plates (shader: frame / sheets / bolts in plate-local coordinates)
    {
      const pl = S.plates || [], n = Math.min(24, pl.length);
      for (let i = 0; i < n; i++) {
        const p = pl[i];
        U.uPlA.value[i].set(p.cx, p.cy, p.cz, p.hl);
        U.uPlB.value[i].set(p.ux, p.uy, p.uz, p.ht);
        U.uPlC.value[i].set(p.nx, 0, p.nz, p.hd);
      }
      U.uNPl.value = n;
    }
    // P118c: the overview (hold V, P85) shows the WHOLE map, solid ("the entire 3D map visible with a clear yellow
    // cut"). The opaque slab meshes only existed for the chunks that touch the band behind slice zero: every chunk in
    // FRONT of the plane was drawn by the 26 % near ghost alone (a veil over the sea, and where it overlapped a
    // straddling chunk's solid slab it z-fought into a dot grid: Q-OV6). So while inspecting (not in caves, whose
    // overview is the cut face seen through the dark rock) every chunk draws its solid slab, the slice view is 'full'
    // (grass, clutter and the lava slab everywhere, no far-context copy of the back half), the ghost is off, and the
    // cut face (the cap quad at slice zero, Q-OV3: a dark strata wedge on the beach, a grey band on temperate) is not
    // drawn
    const under = !!SS.world.under, ov = inspect > 0.05 && !under;
    capOv = inspect > 0.05 && under;
    XR.uK.value = capOv ? inspect : 0;
    {
      const pd = SS.world.play_disc(XRD);
      XR.uDisc.value.set(pd ? pd.x : 0, pd ? pd.z : 0, pd ? pd.r : 0);
    }
    if (backUser === null) backUser = U.uBack.value;
    if (ov !== ovr) {
      ovr = ov;
      U.uBack.value = ov ? Math.max(backUser, OV_BACK) : backUser;
    }
    // far context only exists beyond the slab
    // P113: a 2D slab has 0.5 m of lattice behind the visible band: no far context (it showed as a floating ribbon
    // behind the ragged back edge)
    const far = ctxA > 0.004 && U.uBack.value < 200 && !SS.slab2d.on(), n0 = SS.plane.nrm(S);
    for (const c of chunks)
      if (c) {
        c.far.visible = far && hasBehind(c.box, S, n0);
        // (no front half in a cave world's overview: the section rule stays on and the tunnels in front show as the
        // x-ray, c.holo)
        c.near.visible = false;
        if (c.holo) c.holo.visible = capOv;
        if (ov) c.slab.visible = true;
      }
    if (cap) cap.visible = !ov;
  };
  TR.stats = () => ({
    chunks: chunks.filter(Boolean).length,
    tris: chunks.reduce((s, c) => s + (c ? c.tris : 0), 0),
    slabChunks: chunks.filter(c => c && c.slab.visible).length,
    xray: chunks.filter(c => c && c.holo && c.holo.visible).length
  });
  /* how far behind slice zero the slab stays solid (m); >= 200 = everything behind */
  TR.setBack = function (m) {
    backUser = m;
    U.uBack.value = ovr ? Math.max(m, OV_BACK) : m;
  };
  // P118c: the PLAYER's slice view (m), also while the overview draws everything (uBack 250): what 'on the section'
  // means for the worms (render/view.js inSlab)
  TR.back = () => (backUser === null ? U.uBack.value : backUser);
  TR.vol = () => volTex;                     // 3D density + material texture (render/water.js: the aquarium face skips rock)
  TR.slabMaterial = () => slabMat;
  TR.cloudShadow = function (dx, dz, cover, k) { U.uCloudSh.value.set(dx, dz, cover, k); };
  TR.capLook = function (r, g, b, sat) { CAPU.uCapK.value.set(r, g, b, sat); };
  /* P118b: the cut face's night / storm look from the time of day (view.js applyLook): tod = 'day' | 'dusk' | 'night',
   * storm = 1 under a cloud deck. A sky / moonlight fill on the
   * section, the blue taken out of the board, a little less colour; capFlash(k) = the lightning flash (view.js, once
   * per frame) */
  TR.capTod = function (tod, storm, biome) {
    const F = CAPU.uCapFill.value, G = CAPU.uCapGrade.value, K = CAPU.uCapK.value;
    U.uConcNight.value = tod === 'night' ? 1 : 0;
    // how much of the pale / exotic end of the strata palette a map shows
    CAPU.uStrata.value = biome === 'canyon' ? 1 : biome === 'desert' ? 0.62 : 0.5;
    if (tod === 'night') {
      K.set(1, 1, 1, 1);
      F.set(0.62, 0.7, 0.9, (0.05 + 0.02 * (storm || 0)) * (biome === 'volcanic' ? 0.6 : 1));
      G.set(0.93, 0.865, 0.76, 0.45);
    }
    else if (tod === 'dusk') {
      K.set(1, 0.97, 0.93, 1);
      F.set(0.6, 0.55, 0.62, 0.012 + 0.03 * (storm || 0));
      G.set(1, 1, 1, 1);
    }
    else {
      K.set(1, 1, 1, 1);
      F.set(0.6, 0.65, 0.8, 0.03 * (storm || 0));
      G.set(1, 1, 1, 1);
    }
  };
  TR.capFlash = function (k) { CAPU.uCapFlash.value = k > 0.001 ? k : 0; };
  TR.capEow = function (v) { CAPU.uEow.value = v ? 1 : 0; };               // P68c: End of the World (render/eowview.js)
  // (tools: the cut face uniforms, e.g. uCapDet 0 = no cut-face detail: tools/dev/ablate.cjs)
  TR.capU = CAPU;
  TR.capN = capN;                                // debug/tests
  TR.ctxMaterial = () => ctxFar;
  TR.slabDepthMaterial = () => slabDepth;
  TR.ctxNearMaterial = () => ctxNear;
  TR.bodyMaterials = () => bodyMats;     // {slab, far, pre, near}: chunk-body variants (need a 'tpos' attribute)
  // (render/bodies.js: the same near ghost of a falling rock piece: off in the solid overview)
  TR.nearCtx = () => !!Q.nearCtx && !ovr && !capOv;
})(window.SS = window.SS || {});
