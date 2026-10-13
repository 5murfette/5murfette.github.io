/* render/alien.js — the alien business of the volcanic island (P37 W5, P47 overhaul): eggs, the acid blood, and the
 * orchestration of the
 * face hugger (render/hugger.js), the black snake-like alien (render/xeno.js) and the infected worm (render/infect.js).
 * Everything is procedural geometry / shaders (no images, canvas textures only). Presentation only (Math.random is
 * fine); it reads the sim state S.alien (sim/alien.js) every frame and creates / updates / disposes its meshes to
 * match.
 *   egg      a leathery, veined, glistening ovoid (canvas skin + bump + clear-coat), a flared root, four thick petals
 *            (outer skin, wet inner
 *            lining) that crack open with the sim's opening progress: a lime light leaks through the seams first, then
 *            a glowing core, mist and a light pool on the ground; the egg breathes like a heartbeat that speeds up and
 *            trembles in the last seconds, and in the last moments the hugger's fingers curl over the rim. A spent egg
 *            stays open and dark, a broken one is a husk in a puddle of goo.
 *   acid     flying drops (instanced glowing spheres) and pools (instanced additive discs: a noisy bubbling lime
 *            shader, fading with the pool's
 *            life) + a halo. (Another agent improves the acid pool look to follow the terrain; this renderer only draws
 * the alien's own blood.) Materials (all built-in: MeshPhysical / MeshStandard / MeshBasic / Points, or a
 * ShaderMaterial for the instanced pool discs): egg skin, egg lining, egg core, light pool, goo, acid drop, acid pool
 * (ShaderMaterial; transparent additive); hugger / xeno ones in their files. Porting: the same data drive a skeletal
 * mesh / Niagara-style particles; the shaders are plain noise + fresnel. API: SS.alienView.init(scene, tx, renderer),
 * reset(S), frame(S, view, camera, dt), onEvent(S, e), worm_pre / worm_post (render/infect.js). */
(function (SS) {
  'use strict';
  const T = window.THREE, AV = SS.alienView = SS.alienView || {};
  let scene = null, tex = null, renderer = null, root = null, env = null, tNow = 0;
  const eggs = new Map(), hugs = new Map(), xenos = new Map();     // (render-only maps: id -> object)
  let GOO_T = null, LT = null, GEO = null, M = null, dropMesh = null, poolMesh = null, poolHalo = null;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const sm = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  AV.res = () => ({ env, tex, root, renderer });
  AV.clock = () => tNow;
  AV.xenoView = id => xenos.get(id);
  AV.eggView = id => eggs.get(id);
  AV.huggerView = id => hugs.get(id);                              // (tools / tests: the render object of a hugger)

  /* ---------- textures ---------- */
  // leathery wrinkled hide with veins (kind 'skin') / a wet lining (kind 'lining')
  function skinCanvas(kind) {
    const N = 256, c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    let s = kind === 'skin' ? 4242 : 77;
    const r = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    if (kind === 'skin') {
      g.fillStyle = '#4b4a33'; g.fillRect(0, 0, N, N);
      for (let i = 0; i < 1400; i++) {
        const v = 50 + r() * 50;
        g.fillStyle = `rgba(${v * 1.05 | 0},${v * 1.1 | 0},${v * 0.65 | 0},0.18)`;
        g.beginPath();
        g.ellipse(r() * N, r() * N, 2 + r() * 9, 1 + r() * 5, r() * 3.14, 0, 6.3);
        g.fill();
      }
      g.lineCap = 'round';
      for (let i = 0; i < 70; i++) {                                    // wrinkle folds
        let x = r() * N, y = r() * N, a = r() * 6.3;
        g.strokeStyle = `rgba(20,24,10,${0.25 + r() * 0.2})`;
        g.lineWidth = 0.8 + r() * 1.6;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 6; k++) {
          a += (r() - 0.5) * 1.1;
          x += Math.cos(a) * 12;
          y += Math.sin(a) * 12;
          g.lineTo(x, y);
        }
        g.stroke();
      }
      for (let i = 0; i < 34; i++) {                                    // veins: greenish-ochre branching lines, brighter
        let x = r() * N, y = r() * N, a = r() * 6.3;
        const w = 1.2 + r() * 2.0;
        for (let k = 0; k < 16; k++) {
          g.strokeStyle = `rgba(150,170,70,${0.34 - k * 0.018})`;
          g.lineWidth = w * (1 - k / 20);
          g.beginPath();
          g.moveTo(x, y);
          a += (r() - 0.5) * 0.8;
          x += Math.cos(a) * 10;
          y += Math.sin(a) * 10;
          g.lineTo(x, y);
          g.stroke();
          if (r() < 0.14) {
            const b = a + (r() - 0.5) * 2.2;
            g.beginPath();
            g.moveTo(x, y);
            g.lineTo(x + Math.cos(b) * 14, y + Math.sin(b) * 14);
            g.stroke();
          }
        }
      }
    } else {
      g.fillStyle = '#7a8f3e'; g.fillRect(0, 0, N, N);
      for (let i = 0; i < 700; i++) {
        g.fillStyle = `rgba(${150 + r() * 80 | 0},${190 + r() * 60 | 0},${60 + r() * 40 | 0},0.16)`;
        g.beginPath();
        g.arc(r() * N, r() * N, 2 + r() * 10, 0, 6.3);
        g.fill();
      }
      for (let i = 0; i < 40; i++) {
        g.strokeStyle = 'rgba(90,60,40,0.3)';
        g.lineWidth = 1;
        let x = r() * N, y = r() * N, a = r() * 6.3;
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 8; k++) {
          a += (r() - 0.5);
          x += Math.cos(a) * 9;
          y += Math.sin(a) * 9;
          g.lineTo(x, y);
        }
        g.stroke();
      }
    }
    return c;
  }
  // a soft radial falloff that is exactly 0 at the edge (the pool of light on the ground, the halo)
  function lightTexture() {
    const N = 128, c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d'), gr = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    for (let i = 0; i <= 8; i++) {
      const u = i / 8;
      gr.addColorStop(u, `rgba(255,255,255,${Math.pow(1 - u, 2.2).toFixed(3)})`);
    }
    g.fillStyle = gr; g.fillRect(0, 0, N, N); return new T.CanvasTexture(c);
  }
  const ctex = (canvas, rep) => {
    const t = new T.CanvasTexture(canvas);
    t.wrapS = t.wrapT = T.RepeatWrapping;
    t.anisotropy = 4;
    if (rep) t.repeat.set(rep[0], rep[1]);
    return t;
  };
  // a procedural environment for the glossy skins (eggs, the black alien)
  function studioEnv() {
    if (!renderer || !T.PMREMGenerator) return null;
    const sc = new T.Scene(),
      sky = new T.Mesh(
        new T.SphereGeometry(10, 24, 12),
        new T.ShaderMaterial({ side: T.BackSide, uniforms: {},
          vertexShader:
          'varying vec3 p; void main(){ p = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: 'varying vec3 p; void main(){ float h = normalize(p).y; vec3 c = mix(vec3(0.02,0.025,0.03), vec3(0.16,0.19,0.23), smoothstep(-0.2, 0.9, h)); c += vec3(0.25,0.7,0.08) * 0.07 * smoothstep(0.1,0.9,-h); gl_FragColor = vec4(c, 1.0); }' })
      );
    sc.add(sky);
    for (
      const [x, y, z, s, c] of [
        [4, 5, 3, 3, [6, 6.4, 7]],
        [-5, 3, -4, 2.2, [4, 4.6, 5.4]],
        [0, 7, -5, 2.6, [5, 5.4, 6]],
        [-4, 2, 4, 1.6, [1.0, 3.4, 0.6]]
      ]
    ) {
      const m = new T.Mesh(
        new T.PlaneGeometry(s, s * 0.5),
        new T.MeshBasicMaterial({ color: new T.Color(c[0], c[1], c[2]), side: T.DoubleSide, toneMapped: false })
      );
      m.position.set(x, y, z);
      m.lookAt(0, 0, 0);
      sc.add(m);
    }
    const pm = new T.PMREMGenerator(renderer), rt = pm.fromScene(sc, 0.04);
    pm.dispose();
    return rt.texture;
  }
  const EGG_H = 0.7, RIM_R = 0.27;                                      // (the lower pod up to the rim, the rim radius)
  function eggProfile() {                                              // the lower pod: a flared root, a waist, a fat ovoid, up to the rim
    const P = [
      [0.4, 0],
      [0.38, 0.03],
      [0.3, 0.075],
      [0.24, 0.13],
      [0.225, 0.2],
      [0.26, 0.29],
      [0.315, 0.39],
      [0.345, 0.48],
      [0.345, 0.57],
      [0.32, 0.64],
      [0.29, EGG_H - 0.03],
      [RIM_R, EGG_H]
    ];
    return P.map(p => new T.Vector2(p[0], p[1]));
  }
  function wrinkle(geo, amp, seed) {                                   // leathery relief: radial displacement along the meridians and rings
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x), r = Math.hypot(x, z);
      if (r < 1e-4) continue;
      const d = amp * (Math.sin(a * 9 + y * 11 + seed) * 0.5 + Math.sin(a * 17 - y * 7 + seed * 2) * 0.3 + Math.sin(y * 23 + a * 3) * 0.2)
        + amp * 1.4 * Math.pow(Math.abs(Math.sin(a * 5.5 + seed)), 6);
      p.setXYZ(i, x + x / r * d, y, z + z / r * d);
    }
    geo.computeVertexNormals(); return geo;
  }
  function shade(geo) {                                              // darker, damp towards the root; a few veins of light on the ridges
    const p = geo.attributes.position, col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i),
        k = 0.55 + 0.45 * Math.min(1, y / 0.3),
        a = Math.atan2(p.getZ(i), p.getX(i)),
        v = 0.9 + 0.1 * Math.sin(a * 5.5 + 1.3);
      col[i * 3] = k * v;
      col[i * 3 + 1] = k * v;
      col[i * 3 + 2] = k * v * 0.95;
    }
    geo.setAttribute('color', new T.BufferAttribute(col, 3)); return geo;
  }
  function tint(geo, k) {                                              // a flat vertex colour (the skin material multiplies by it)
    const n = geo.attributes.position.count, col = new Float32Array(n * 3).fill(k);
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    return geo;
  }
  function geos() {
    if (GEO) return;
    const prof = eggProfile(), N = 28;
    const upper = [];
    for (let i = 0; i <= 12; i++) {
      const u = i / 12, rr = RIM_R * Math.pow(Math.max(0, 1 - Math.pow(u, 1.8)), 0.55);
      upper.push(new T.Vector2(Math.max(0.01, rr), u * 0.4));
    }
    GEO = {
      body: shade(wrinkle(new T.LatheGeometry(prof, N), 0.012, 1.3)),
      petal: tint(wrinkle(new T.LatheGeometry(upper, 10, -0.86, 1.72), 0.01, 3.7), 0.92),
      rim: new T.TorusGeometry(RIM_R, 0.04, 8, 28), core: new T.SphereGeometry(1, 14, 10), sph: new T.SphereGeometry(1, 12, 8),
      cyl: new T.CylinderGeometry(1, 1, 1, 6), disc: new T.CircleGeometry(1, 28), goo: new T.CircleGeometry(1, 20)
    };
    GEO.rim.rotateX(Math.PI / 2);
    GEO.cyl.translate(0, 0.5, 0);
    GEO.disc.rotateX(-Math.PI / 2);
    GEO.goo.rotateX(-Math.PI / 2);
    const skin = ctex(skinCanvas('skin'), [2, 1]), lin = ctex(skinCanvas('lining'));
    M = {
      skin: new T.MeshPhysicalMaterial({
        map: skin,
        bumpMap: skin,
        bumpScale: 3.4,
        color: 0x6a6a52,
        roughness: 0.7,
        vertexColors: true,
        metalness: 0.0,
        clearcoat: 0.22,
        clearcoatRoughness: 0.45,
        sheen: 0.35,
        sheenColor: new T.Color(0x80a048),
        sheenRoughness: 0.6,
        envMap: env,
        envMapIntensity: 0.4,
        emissive: 0x0b1404
      }),
      lining: new T.MeshPhysicalMaterial({
        map: lin,
        color: 0xb8c880,
        roughness: 0.24,
        clearcoat: 0.9,
        clearcoatRoughness: 0.12,
        emissive: 0x4f9a14,
        emissiveIntensity: 0.1,
        side: T.BackSide,
        envMap: env,
        envMapIntensity: 0.8
      }),
      finger: new T.MeshStandardMaterial({ color: 0xcfb99a, roughness: 0.45, emissive: 0x2a1a08 }),
      goo: new T.MeshStandardMaterial({
        color: 0x2c3a10, roughness: 0.1, metalness: 0, emissive: 0x10260a, transparent: true, opacity: 0.7
      }),
      drop: new T.MeshBasicMaterial({ color: 0xb4ff4a, toneMapped: false, fog: false })
    };
    for (const m of Object.values(M)) m.userData.shared = true;
  }
  AV.geos = () => {
    geos();
    return GEO;
  };

  /* ---------- draped discs (P48): a polar grid laid ON the terrain (every vertex at the real ground height under it),
   * so a pool / skirt follows a slope ---------- */
  const DR_R = 5, DR_S = 22;
  function drapeMake(mat) {
    const nv = 1 + DR_R * DR_S, pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = [];
    uv[0] = uv[1] = 0.5;
    for (let r = 0; r < DR_R; r++)
      for (let k = 0; k < DR_S; k++) {
        const a = k / DR_S * 6.2832, f = (r + 1) / DR_R, i = 1 + r * DR_S + k;
        uv[i * 2] = 0.5 + 0.5 * f * Math.cos(a);
        uv[i * 2 + 1] = 0.5 + 0.5 * f * Math.sin(a);
      }
    const ring = (r, k) => 1 + r * DR_S + (k % DR_S);
    for (let k = 0; k < DR_S; k++) idx.push(0, ring(0, k + 1), ring(0, k));
    for (let r = 0; r < DR_R - 1; r++)
      for (let k = 0; k < DR_S; k++) {
        const a = ring(r, k), b = ring(r, k + 1), c = ring(r + 1, k), d = ring(r + 1, k + 1);
        idx.push(a, b, c, b, d, c);
      }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    g.setAttribute('uv', new T.BufferAttribute(uv, 2));
    g.setIndex(idx);
    const m = new T.Mesh(g, mat);
    m.frustumCulled = false;
    root.add(m);
    return { m, g, R: 0, y0: 1e9 };
  }
  function drapeFit(d, cx, cy, cz, R, lift) {
    const AL = SS.alien, pa = d.g.getAttribute('position');
    d.R = R;
    d.y0 = cy;
    const put = (i, x, z) => {
      let gy = AL.ground_y(x, cy + 0.5, z, 26);
      if (gy < -1e8 || Math.abs(gy - cy) > 1.2) gy = cy;
      pa.setXYZ(i, x, gy + lift, z);
    };
    put(0, cx, cz);
    for (let r = 0; r < DR_R; r++)
      for (let k = 0; k < DR_S; k++) {
        const a = k / DR_S * 6.2832, f = (r + 1) / DR_R * R;
        put(1 + r * DR_S + k, cx + Math.cos(a) * f, cz + Math.sin(a) * f);
      }
    pa.needsUpdate = true; d.g.computeVertexNormals(); d.g.computeBoundingSphere();
  }
  const NRM = { x: 0, y: 1, z: 0 };
  // the mean of five SDF gradients on the ground round (x, z): the slope under an egg
  function groundNormal(x, y, z, out) {
    let sx = 0, sy = 0, sz = 0;
    const W = SS.world;
    for (const [dx, dz] of [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) {
      const gy = SS.alien.ground_y(x + dx, y + 0.4, z + dz, 20);
      W.normal(x + dx, (gy > -1e8 ? gy : y) + 0.03, z + dz, NRM);
      sx += NRM.x;
      sy += NRM.y;
      sz += NRM.z;
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    out.set(sx / l, sy / l, sz / l);
    return out;
  }
  function gooTexture() {                                              // a flat wet puddle with a soft rim (alpha in the grey value)
    const N = 128, c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d'), gr = g.createRadialGradient(N / 2, N / 2, 0, N / 2, N / 2, N / 2);
    gr.addColorStop(0, '#fff');
    gr.addColorStop(0.55, '#fff');
    gr.addColorStop(0.8, '#777');
    gr.addColorStop(1, '#000');
    g.fillStyle = gr;
    g.fillRect(0, 0, N, N);
    const t = new T.CanvasTexture(c);
    return t;
  }

  /* ---------- eggs ---------- */
  function makeEgg(e) {
    const g = new T.Group(), root_ = new T.Group();
    g.add(root_);
    // (per egg: its own glow)
    const lin = M.lining.clone();
    lin.userData.shared = false;
    const body = new T.Mesh(GEO.body, M.skin);
    body.castShadow = true;
    body.receiveShadow = true;
    root_.add(body);
    const cup = new T.Mesh(GEO.body, lin);
    cup.scale.set(0.96, 0.98, 0.96);
    root_.add(cup);
    const rim = new T.Mesh(GEO.rim, lin);
    rim.position.y = EGG_H - 0.01;
    root_.add(rim);
    const pet = [];
    for (let k = 0; k < 4; k++) {
      const grp = new T.Group();
      grp.rotation.y = k * Math.PI / 2;
      grp.position.y = EGG_H;
      const piv = new T.Group();
      piv.position.z = RIM_R;
      const m = new T.Mesh(GEO.petal, M.skin), mi = new T.Mesh(GEO.petal, lin);
      m.position.z = -RIM_R;
      mi.position.z = -RIM_R;
      m.castShadow = true;
      piv.add(m, mi);
      grp.add(piv);
      root_.add(grp);
      pet.push({ piv, grp });
    }
    const core = new T.Mesh(GEO.core, new T.MeshBasicMaterial({ color: 0xa6ff3a, toneMapped: false, fog: false }));
    core.position.y = EGG_H - 0.22;
    core.scale.set(0.08, 0.06, 0.08);
    core.visible = false;
    root_.add(core);
    // the hugger's fingers curling over the rim in the last moments
    const fing = [];
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + 0.6, fg = new T.Group();
      fg.position.set(Math.cos(a) * (RIM_R - 0.01), EGG_H - 0.02, Math.sin(a) * (RIM_R - 0.01));
      fg.rotation.y = -a;
      const seg = [];
      let par = fg;
      for (let j = 0; j < 3; j++) {
        const s = new T.Group();
        s.position.x = j ? 0.07 : 0;
        const m = new T.Mesh(GEO.cyl, M.finger);
        m.rotation.z = -Math.PI / 2;
        m.scale.set(0.017 - j * 0.003, 0.075, 0.017 - j * 0.003);
        s.add(m);
        par.add(s);
        par = s;
        seg.push(s);
      }
      fg.visible = false; root_.add(fg); fing.push({ fg, seg });
    }
    const gm = new T.PointsMaterial({
      map: LT,
      size: 2.4,
      sizeAttenuation: true,
      color: 0x8cff30,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: T.AdditiveBlending,
      fog: false
    });
    const pg = new T.BufferGeometry();
    pg.setAttribute('position', new T.BufferAttribute(new Float32Array([0, 0.75, 0]), 3));
    const halo = new T.Points(pg, gm);
    halo.frustumCulled = false;
    g.add(halo);
    // the pool of lime light on the ground round the egg
    const pm = new T.MeshBasicMaterial({
      map: LT,
      color: 0x7fe02a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: T.AdditiveBlending,
      fog: false,
      side: T.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3
    });
    const pool = drapeMake(pm);
    pool.m.renderOrder = 3;
    const gm2 = M.goo.clone();
    gm2.userData.shared = false;
    gm2.alphaMap = GOO_T;
    gm2.side = T.DoubleSide;
    gm2.polygonOffset = true;
    gm2.polygonOffsetFactor = -2;
    gm2.polygonOffsetUnits = -2;
    gm2.depthWrite = false;
    const goo = drapeMake(gm2);
    goo.m.renderOrder = 2;
    g.position.set(e.x, e.y, e.z); root.add(g);
    return {
      g,
      root: root_,
      body,
      rim,
      lin,
      pet,
      core,
      fing,
      halo,
      gm,
      pool,
      pm,
      goo,
      ph: Math.random() * 6.28,
      shape: rnd(0.9, 1.1),
      yaw: e.yaw,
      nrm: new T.Vector3(0, 1, 0),
      fitT: -9,
      qy: new T.Quaternion().setFromAxisAngle(UPV, e.yaw)
    };
  }
  function frameEgg(S, e, o) {
    const AL = SS.alien, p = AL.egg_progress(S, e), st = e.st;
    // heartbeat: rate climbs with the progress; trembles in the last seconds
    const left = st === 1 ? AL.K.OPEN_T * (1 - p) : 99,
      rate = 0.55 + 1.6 * p * p + (left < 6 ? 2.2 : 0),
      beat = st === 1 ? Math.pow(Math.max(0, Math.sin(tNow * rate * 6.283 + o.ph)), 6) : 0;
    const flare = st === 1 ? sm(0.9, 1, p) : 0, shake = st === 1 ? (left < 8 ? (1 - left / 8) * 0.012 : 0) + 0.0018 * p : 0;
    o.root.scale.set(o.shape * (1 + 0.016 * beat * (0.4 + p)), 1 + 0.02 * beat * (0.4 + p), o.shape * (1 + 0.016 * beat * (0.4 + p)));
    o.root.position.set(Math.sin(tNow * 41 + o.ph) * shake, 0, Math.cos(tNow * 37 + o.ph) * shake);
    // the petals: a slow crack first (light leaks), then the lips peel back; spent: wide open; broken: torn down
    const crack = 0.08 * sm(0.02, 0.4, p), peel = 1.32 * Math.pow(sm(0.45, 1, p), 1.4), open = st === 3 ? 1.38 : crack + peel;
    const wob = st === 1 ? 0.03 * Math.sin(tNow * 3 + o.ph) * sm(0.5, 1, p) : 0;
    for (let k = 0; k < 4; k++) {
      const pt = o.pet[k];
      let ang = open + wob * (k & 1 ? 1 : -1) + (st === 1 ? 0.05 * flare * Math.sin(tNow * 30 + k * 2) : 0);
      if (st === 4) {
        ang = 1.5 + 0.35 * Math.sin(k * 2.7 + o.ph);
        pt.grp.scale.setScalar(0.7 + 0.1 * (k & 1));
        pt.grp.position.y = EGG_H - 0.12;
      } else {
        pt.grp.scale.setScalar(1);
        pt.grp.position.y = EGG_H;
      }
      pt.piv.rotation.x = ang;
    }
    o.body.scale.y = st === 4 ? 0.8 : 1;
    // the light: seams, then a core, mist, the pool on the ground
    const lit = st === 4 ? 0 : st === 3 ? 0.16 : 0.05 + 0.95 * Math.pow(p, 1.25),
      pulse = 0.55 + 0.45 * beat + 0.2 * Math.sin(tNow * 2 + o.ph);
    o.lin.emissiveIntensity = 0.1 + 0.9 * lit;
    o.core.visible = (st === 1 && p > 0.04) || st === 3;
    const cs = (0.05 + 0.1 * (st === 3 ? 0.35 : p)) * (1 + 0.2 * beat);
    o.core.scale.set(cs, cs * 0.8, cs);
    o.core.position.y = EGG_H - 0.26 + 0.18 * (st === 3 ? 0 : p);
    const cc = st === 3 ? 0.3 : 0.55 + 0.45 * p;
    o.core.material.color.setRGB((0.4 + 0.25 * pulse) * cc * 1.3, cc * 1.25, 0.12 * cc);
    o.gm.opacity = 0.55 * lit * (0.5 + 0.5 * pulse) * (0.7 + 0.6 * flare); o.gm.size = 0.9 + 1.7 * (st === 3 ? 0.3 : p) + 0.5 * flare;
    o.pm.opacity = (st === 4 ? 0 : st === 3 ? 0.1 : 0.05 + 0.6 * p * p) * (0.7 + 0.5 * pulse);
    o.pool.m.visible = o.pm.opacity > 0.004;
    // fingers over the rim
    const fk = st === 1 ? sm(0.93, 1, p) : 0;
    for (let k = 0; k < 4; k++) {
      const f = o.fing[k];
      f.fg.visible = fk > 0.02;
      if (!f.fg.visible) continue;
      const curl = 0.6 + 0.9 * fk + 0.25 * Math.sin(tNow * 9 + k * 1.7);
      f.seg[0].rotation.z = -0.2 + curl * -0.25; f.seg[1].rotation.z = -curl * 0.55; f.seg[2].rotation.z = -curl * 0.7;
      f.fg.scale.setScalar(fk);
    }
    // the husk and the spent egg: a puddle of goo
    o.gooR = st === 4 ? 0.95 : st === 3 ? 0.78 : 0.56;
  }
  /* the egg sits in the ground: it leans halfway between upright and the surface normal, sinks a little (more on a
   * slope), and the pool of light and the slime skirt are
   * draped on the actual terrain (refitted twice a second: a blast or the acid may change the ground under it) */
  const UPV = new T.Vector3(0, 1, 0), qa = new T.Quaternion(), vb = new T.Vector3();
  function settleEgg(S, e, o, p) {
    if (tNow - o.fitT > 0.5 + 0.05 * (e.id % 5) || (o.fitY !== e.y)) {
      o.fitT = tNow; o.fitY = e.y;
      groundNormal(e.x, e.y, e.z, o.nrm);
      const lean = Math.min(1, 0.55 + 0.1 * Math.min(1, (1 - o.nrm.y) * 3));
      vb.copy(UPV).multiplyScalar(1 - lean * 0.6).addScaledVector(o.nrm, lean * 0.6).normalize();
      o.lean = vb.clone(); o.tilt = Math.acos(Math.min(1, o.nrm.y));
      drapeFit(o.pool, e.x, e.y, e.z, 1.5 + 1.3 * p, 0.035); drapeFit(o.goo, e.x, e.y, e.z, o.gooR || 0.6, 0.02);
    }
    qa.setFromUnitVectors(UPV, o.lean || UPV); o.g.quaternion.copy(qa).multiply(o.qy);
    o.g.position.set(e.x, e.y - (0.025 + 0.4 * Math.tan(0.5 * (o.tilt || 0)) * 0.7), e.z);
  }

  /* ---------- acid ---------- */
  const POOL_V = /* glsl */`
    varying vec2 vUv;
    varying float vI;
    attribute float aI;
    #include <clipping_planes_pars_vertex>
    void main(){
      vUv = position.xz;
      vI = aI;
      vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <clipping_planes_vertex>
    }`;
  const POOL_F = /* glsl */`
    uniform float uT;
    varying vec2 vUv;
    varying float vI;
    #include <clipping_planes_pars_fragment>
    float h21(vec2 p){
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }
    float n2(vec2 p){
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1,0)), f.x), mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y);
    }
    void main(){
      #include <clipping_planes_fragment>
      float r = length(vUv);
      if (r > 1.0) discard;
      float n = n2(vUv * 5.0 + uT * 0.8) * 0.6 + n2(vUv * 11.0 - uT * 1.3) * 0.4;
      float bub = smoothstep(0.62, 0.7, n2(vUv * 9.0 + floor(uT * 2.0) * 3.1));
      float edge = smoothstep(1.0, 0.55, r);
      vec3 col = mix(vec3(0.25, 0.9, 0.05), vec3(0.8, 1.0, 0.35), n) + bub * 0.5;
      gl_FragColor = vec4(col * (0.7 + 0.5 * n), edge * vI * (0.55 + 0.4 * n));
    }`;
  const v0 = new T.Vector3(), sc3 = new T.Vector3(), m4 = new T.Matrix4(), q0 = new T.Quaternion();
  function makeAcid() {
    dropMesh = new T.InstancedMesh(GEO.sph, M.drop, 96);
    dropMesh.frustumCulled = false;
    dropMesh.count = 0;
    root.add(dropMesh);
    const pm = new T.ShaderMaterial({
      uniforms: { uT: { value: 0 } },
      vertexShader: POOL_V,
      fragmentShader: POOL_F,
      transparent: true,
      depthWrite: false,
      blending: T.AdditiveBlending,
      side: T.DoubleSide,
      clipping: true
    });
    const g = GEO.disc.clone();
    g.setAttribute('aI', new T.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(1), 1));
    poolMesh = new T.InstancedMesh(g, pm, 96);
    poolMesh.frustumCulled = false;
    poolMesh.count = 0;
    poolMesh.renderOrder = 5;
    root.add(poolMesh);
    const hg = new T.BufferGeometry();
    hg.setAttribute('position', new T.BufferAttribute(new Float32Array(96 * 3), 3));
    hg.setAttribute('color', new T.BufferAttribute(new Float32Array(96 * 3), 3));
    hg.setDrawRange(0, 0);
    poolHalo = new T.Points(
      hg,
      new T.PointsMaterial({
        map: tex,
        size: 2.2,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: T.AdditiveBlending,
        fog: false
      })
    );
    poolHalo.frustumCulled = false;
    root.add(poolHalo);
  }
  function frameAcid(S) {
    const A = S.alien.acid;
    let nd = 0, np = 0;
    const hp = poolHalo.geometry.getAttribute('position'), hc = poolHalo.geometry.getAttribute('color');
    for (const a of A) {
      if (a.st === 0) {
        if (nd < 96) {
          v0.set(a.x, a.y, a.z);
          sc3.set(0.075, 0.075, 0.075);
          m4.compose(v0, q0.identity(), sc3);
          dropMesh.setMatrixAt(nd++, m4);
        }
      }
      else if (np < 96) {
        const age = S.time - a.t0,
          fade = Math.min(1, age * 3) * Math.min(1, (a.life - age) / 4),
          r = a.r * (1.4 + 0.2 * Math.sin(age * 2 + a.x));
        v0.set(a.x, a.y + 0.04, a.z);
        sc3.set(r, 1, r);
        m4.compose(v0, q0.identity(), sc3);
        poolMesh.setMatrixAt(np, m4);
        hp.setXYZ(np, a.x, a.y + 0.25, a.z); hc.setXYZ(np, 0.3 * fade, 0.9 * fade, 0.08 * fade); np++;
      }
    }
    dropMesh.count = nd;
    dropMesh.instanceMatrix.needsUpdate = true;
    poolMesh.count = np;
    poolMesh.instanceMatrix.needsUpdate = true;
    hp.needsUpdate = true;
    hc.needsUpdate = true;
    poolHalo.geometry.setDrawRange(0, np);
    poolMesh.material.uniforms.uT.value = tNow;
  }

  /* ---------- lifecycle ---------- */
  function detach(o) {
    if (o.g && o.g.parent) o.g.parent.remove(o.g);
  }
  function clearAll() {
    // (the per-reset materials: the eggs' glow points, light pools, the acid drops / pools / halo; the module's shared
    // ones (M) and geometries (GEO) stay)
    for (const o of hugs.values()) detach(o);
    if (LT) {
      LT.dispose();
      LT = null;
    }
    if (root) {
      scene.remove(root);
      const shared = GEO ? Object.values(GEO) : [];
      root.traverse(o => {
        if (o.geometry && shared.indexOf(o.geometry) < 0 && !o.userData.keepGeo) o.geometry.dispose();
        if (o.material)
          for (const m of [].concat(o.material))
            if (!m.userData.shared) m.dispose();
      });
    }
    eggs.clear();
    hugs.clear();
    for (const o of xenos.values())
      if (AV.xenoDispose) AV.xenoDispose(o);
    xenos.clear();
    root = null;
    dropMesh = poolMesh = poolHalo = null;
  }
  AV.init = function (sc, tx, rend) {
    scene = sc;
    tex = tx && tx.glow;
    renderer = rend;
  };
  AV.reset = function () {
    if (!scene) return;
    clearAll();
    if (!env) env = studioEnv();
    geos();
    LT = lightTexture();
    if (GOO_T) GOO_T.dispose();
    GOO_T = gooTexture();
    if (M.skin.envMap !== env) {
      M.skin.envMap = env;
      M.lining.envMap = env;
      M.skin.needsUpdate = M.lining.needsUpdate = true;
    }
    root = new T.Group(); root.frustumCulled = false; scene.add(root);
    makeAcid();
    if (AV.inf_init) AV.inf_init(root);
    if (AV.xenoInit) AV.xenoInit(root);
  };
  AV.onEvent = function (S, e) {
    if (!root) return;
    if (e.type === 'parasite_pulse' && e.worm && AV.inf_pulse) AV.inf_pulse(S, e, w => {
      const q = SS.actors.vis(w);
      return q && q.v;
    });
    if (AV.xenoEvent) AV.xenoEvent(S, e);
  };
  AV.frame = function (S, view, camera, dt) {
    if (!root || !S.alien) return;
    dt = dt || 0.016; tNow += dt;
    const A = S.alien, AL_ = SS.alien;
    for (const e of A.eggs) {
      let o = eggs.get(e.id);
      if (!o) {
        o = makeEgg(e);
        eggs.set(e.id, o);
      }
      frameEgg(S, e, o);
      settleEgg(S, e, o, AL_.egg_progress(S, e));
    }
    for (const [id, o] of hugs)
      if (!A.huggers.some(h => h.id === id)) {
        detach(o);
        o.segs.dispose();
        o.balls.dispose();
        o.claws.dispose();
        hugs.delete(id);
      }
    for (const h of A.huggers) {
      let o = hugs.get(h.id);
      if (!o) {
        o = AV.hugMake(root);
        hugs.set(h.id, o);
      }
      const hw = h.host >= 0 ? S.worms[h.host] : null, vis = hw ? SS.actors.vis(hw) : null;
      AV.hugFrame(S, h, o, dt, tNow, vis && vis.v, root);
    }
    for (const [id, o] of xenos)
      if (!A.xenos.some(x => x.id === id)) {
        if (AV.xenoDispose) AV.xenoDispose(o);
        xenos.delete(id);
      }
    for (const X of A.xenos) {
      let o = xenos.get(X.id);
      if (!o) {
        o = AV.xenoMake(root);
        xenos.set(X.id, o);
      }
      AV.xenoFrame(S, X, o, dt, tNow, camera);
    }
    if (AV.inf_frame) AV.inf_frame(S, dt);
    if (AV.xenoFx) AV.xenoFx(S, dt, tNow);
    frameAcid(S);
  };
})(window.SS = window.SS || {});
