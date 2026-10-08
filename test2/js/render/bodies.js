/* render/bodies.js — rigid bodies and props on screen (Three.js specific).
 * Detached terrain pieces are meshed once from their local grid (SS.meshgen.local, same vertex layout as the terrain
 * chunks) and drawn with the terrain materials (slab clip, context, shadows), following the body's position and
 * orientation every frame. Props (sim/scatter.js): textured crate and fuel barrel, a mine with a blinking light while
 * its fuse runs, boulders meshed from the same jittered icosahedron as their collision shell. Burning props and oil
 * rings get procedural flame billboards (noise shader, black-body ramp, additive; no images). A body that re-baked
 * into the terrain, exploded or left the world is dropped.
 * Porting: one engine mesh per body, transform from the sim each frame; flames = particle/billboard shader. */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const BV = SS.bodyView = {};
  let scene, tx, items = new Map(), mats = null, flameGeo = null, flameMat = null, flames = [], time = 0;

  const FLAME_VS = `
    uniform float uTime; attribute float seed; varying vec2 vUv; varying float vSeed;
    void main() {
      vUv = uv; vSeed = seed;
      vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);            // camera-facing quad around the object origin
      vec3 sc = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), 1.0);
      mv.xy += position.xy * sc.xy;
      gl_Position = projectionMatrix * mv;
    }`;
  // the billboard flame (render/trees.js grass-fire field, instanced): P23n, a 2D take on the volume fire: domain-warped
  // fbm rising through a teardrop mask, tongues breaking off at the top, blackbody ramp (red rim -> orange -> hot core)
  const FLAME_FS = `
    uniform float uTime, uInt; varying vec2 vUv; varying float vSeed;
    float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
    float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n2(p); p = p * 2.03 + vec2(1.7, -0.6); a *= 0.5; } return s; }
    vec3 bb(float t) {
      vec3 c = mix(vec3(0.3, 0.02, 0.0), vec3(0.95, 0.18, 0.01), smoothstep(0.0, 0.3, t));
      c = mix(c, vec3(1.0, 0.5, 0.06), smoothstep(0.3, 0.7, t));
      return mix(c, vec3(1.0, 0.86, 0.5), smoothstep(0.82, 1.0, t));
    }
    void main() {
      vec2 p = vUv; float t = uTime * (1.4 + 0.3 * fract(vSeed * 7.1)) + vSeed * 13.0;
      float x = (p.x - 0.5) * 2.0;
      // domain warp: the noise field itself is pushed up and sideways by a slower noise (licking, curling tongues)
      vec2 q = vec2(x * 1.6, p.y * 2.2 - t * 1.5);
      vec2 w = vec2(fbm(q * 0.8 + vec2(0.0, -t * 0.4)), fbm(q * 0.8 + vec2(5.2, 1.3 - t * 0.4))) - 0.5;
      float n = fbm(q + w * 1.6 + vSeed * 3.0);
      float body = (1.0 - p.y) * (1.0 - x * x * (1.0 + p.y * 2.6)) * smoothstep(0.0, 0.18, p.y);
      float f = clamp(body * 1.9 - n * 1.05 - p.y * 0.3 + 0.12, 0.0, 1.0) * uInt;
      if (f < 0.02) discard;
      float T = clamp(f * (1.15 - p.y * 0.9), 0.0, 1.0);
      gl_FragColor = vec4(bb(T) * (0.5 + 1.5 * T), smoothstep(0.02, 0.35, f));
    }`;

  /* P23n (user 2026-10-08: "make fire look better", ref. three.js volume fire): a raymarched VOLUME flame. The proxy is a
   * unit box (x, z in -0.5..0.5, y 0..1) drawn from its back faces; the camera ray is taken into object space and
   * marched (20 steps) through a teardrop-shaped density carved by upward-advected 3D fbm; temperature (density x height)
   * -> blackbody colour; additive. 100 % procedural (no textures). */
  const VFIRE_VS = `
    attribute float seed; varying vec3 vPos; varying vec3 vOrig; varying float vSeed;
    void main() {
      vPos = position; vSeed = seed;
      vOrig = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;
  const VFIRE_FS = `
    uniform float uTime, uInt; varying vec3 vPos; varying vec3 vOrig; varying float vSeed;
    float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float n3(vec3 x) { vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z); }
    float fbm(vec3 p) { return 0.55 * n3(p) + 0.3 * n3(p * 2.07 + 3.1) + 0.15 * n3(p * 4.13 + 7.7); }
    vec3 blackbody(float t) {                       // 0 = cool ember red .. 1 = white-yellow core
      vec3 c = mix(vec3(0.3, 0.02, 0.0), vec3(0.95, 0.18, 0.01), smoothstep(0.0, 0.3, t));
      c = mix(c, vec3(1.0, 0.5, 0.06), smoothstep(0.3, 0.7, t));
      return mix(c, vec3(1.0, 0.85, 0.5), smoothstep(0.82, 1.0, t));
    }
    void main() {
      vec3 ro = vOrig, rd = normalize(vPos - vOrig);
      // ray / box [-0.5, 0, -0.5]..[0.5, 1, 0.5]
      vec3 inv = 1.0 / rd, t0 = (vec3(-0.5, 0.0, -0.5) - ro) * inv, t1 = (vec3(0.5, 1.0, 0.5) - ro) * inv;
      vec3 tmin = min(t0, t1), tmax = max(t0, t1);
      float tn = max(max(tmin.x, tmin.y), max(tmin.z, 0.0)), tf = min(min(tmax.x, tmax.y), tmax.z);
      if (tf <= tn) discard;
      const int N = 20; float dt = (tf - tn) / float(N), t = tn + dt * fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5);
      float time = uTime * (1.0 + 0.25 * fract(vSeed * 7.3)) + vSeed * 31.0;
      vec3 col = vec3(0.0); float acc = 0.0;
      for (int i = 0; i < N; i++) {
        vec3 p = ro + rd * t; t += dt;
        float hgt = clamp(p.y, 0.0, 1.0), rr = length(p.xz) * 2.0;
        // flicker + lean: the flame sways, its tongues rise and break up toward the tip
        vec3 q = vec3(p.x * 3.2 + sin(time * 1.7 + hgt * 3.0) * 0.25 * hgt, p.y * 2.6 - time * 2.1, p.z * 3.2 + vSeed * 9.0);
        float n = fbm(q), prof = (1.0 - hgt) * (0.75 + 0.25 * smoothstep(0.0, 0.15, hgt));       // teardrop: wide low, thin tip
        float d = smoothstep(prof, prof * 0.35, rr + (n - 0.5) * 0.9 * (0.4 + hgt)) * smoothstep(0.0, 0.06, hgt);
        d *= smoothstep(0.08, 0.5, n + (1.0 - hgt) * 0.45);
        if (d > 0.002) { float T = clamp(d * (1.05 - hgt * 1.0) + (n - 0.5) * 0.35 - hgt * 0.15, 0.0, 1.0); col += blackbody(T) * d * (0.45 + 1.3 * T); acc += d; }
      }
      col *= dt * 2.6 * uInt; acc = clamp(acc * dt * 3.0, 0.0, 1.0);
      if (acc < 0.004) discard;
      gl_FragColor = vec4(col, acc);
    }`;
  BV.init = function (sc, textures) {
    scene = sc; tx = textures || {};
    const rockMap = tx.rock && tx.rock.isTexture && !tx.rock.isDataArrayTexture ? tx.rock : null;
    mats = {
      crate: new T.MeshStandardMaterial({ map: tx.crate || null, color: tx.crate ? 0xffffff : 0x8a6a48, roughness: 0.8 }),
      barrel: new T.MeshStandardMaterial({ map: tx.barrel || null, color: tx.barrel ? 0xffffff : 0xb03a22, roughness: 0.45, metalness: 0.35 }),
      barrelCap: new T.MeshStandardMaterial({ color: 0x7a2a1a, roughness: 0.5, metalness: 0.4 }),
      mine: new T.MeshStandardMaterial({ color: 0x2d3229, roughness: 0.55, metalness: 0.6 }),
      boulder: new T.MeshStandardMaterial({ map: rockMap, color: rockMap ? 0xb8b0a6 : 0x7c746a, roughness: 0.95, flatShading: true }),
      prop: new T.MeshStandardMaterial({ color: 0x8a6a48, roughness: 0.85 }),
      bark: new T.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.95 }),
      leaves: new T.MeshStandardMaterial({ color: 0x4f6e2e, roughness: 0.9, flatShading: true })
    };
    flameGeo = new T.BoxGeometry(1, 1, 1); flameGeo.translate(0, 0.5, 0);
    flameMat = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uInt: { value: 1.25 } }, vertexShader: VFIRE_VS, fragmentShader: VFIRE_FS,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, side: T.BackSide
    });
  };

  function std(geo, mat) { const m = new T.Mesh(geo, mat); m.castShadow = m.receiveShadow = true; return m; }
  /* P24.10 props (PoC PROPS, original shapes): a car (hull, cabin, glass, wheels, lights; paint by id; charred when
   * wrecked), metal junk (fridge, vending machine with a lit panel, red phone booth), stone monuments (fluted
   * column, obelisk). Local frame = the body's (centre of mass at the origin, x = length). */
  const CAR_PAINT = [0xb3261e, 0x1f5fbf, 0xe0b42a, 0x2e7d4f, 0xe8e6e0, 0x2a2a2e];
  const PM = {};
  function pm() {
    if (PM.glass) return PM;
    PM.glass = new T.MeshStandardMaterial({ color: 0x25384a, roughness: 0.08, metalness: 0.6 });
    PM.rubber = new T.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
    PM.hub = new T.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 0.85, roughness: 0.3 });
    PM.head = new T.MeshStandardMaterial({ color: 0xfff4c8, emissive: 0xfff0b0, emissiveIntensity: 0.7 });
    PM.tail = new T.MeshStandardMaterial({ color: 0xa01010, emissive: 0x700808, emissiveIntensity: 0.6 });
    PM.dark = new T.MeshStandardMaterial({ color: 0x232427, roughness: 0.7 });
    PM.char = new T.MeshStandardMaterial({ color: 0x1c1a19, roughness: 0.95 });
    PM.chrome = new T.MeshStandardMaterial({ color: 0xd8dde2, metalness: 0.95, roughness: 0.2 });
    PM.stone = new T.MeshStandardMaterial({ color: 0xc9bfa9, roughness: 0.92 });
    PM.red = new T.MeshStandardMaterial({ color: 0xc0201c, roughness: 0.45 });
    PM.paneG = new T.MeshStandardMaterial({ color: 0x9fc6d8, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.55 });
    PM.sign = new T.MeshStandardMaterial({ color: 0xf4f0e0, emissive: 0xfff0c0, emissiveIntensity: 0.7 });
    return PM;
  }
  const box = (w, h, d, mat, x, y, z) => { const m = std(new T.BoxGeometry(w, h, d), mat); m.position.set(x || 0, y || 0, z || 0); return m; };
  // ASSET: prop_car_* (models/prop_car_[sedan,hatch,pickup,van].glb + wreck)
  function carMesh(b, meshes) {
    const P = pm(), K = SS.CFG.PROPS.CAR, paint = b.wreck ? P.char : new T.MeshStandardMaterial({ color: CAR_PAINT[(b.paint | 0) % 6], roughness: 0.35, metalness: 0.45 });
    const L = K.L, W = K.W;
    meshes.push(box(L, 0.62, W, paint, 0, -0.28, 0));                                // hull
    meshes.push(box(L * 0.52, 0.55, W * 0.88, paint, -0.25, 0.3, 0));                  // cabin
    if (!b.wreck) for (const z of [-W * 0.44 - 0.01, W * 0.44 + 0.01]) meshes.push(box(L * 0.46, 0.38, 0.02, P.glass, -0.25, 0.33, z));
    if (!b.wreck) { meshes.push(box(0.02, 0.38, W * 0.8, P.glass, -0.25 + L * 0.26 + 0.01, 0.33, 0)); meshes.push(box(0.02, 0.36, W * 0.8, P.glass, -0.25 - L * 0.26 - 0.01, 0.33, 0)); }
    for (const x of [-L * 0.32, L * 0.32]) for (const z of [-W / 2, W / 2]) {
      const wh = std(new T.CylinderGeometry(0.34, 0.34, 0.24, 18), P.rubber); wh.rotation.x = Math.PI / 2; wh.position.set(x, -0.55, z); meshes.push(wh);
      const hb = std(new T.CylinderGeometry(0.17, 0.17, 0.26, 12), P.hub); hb.rotation.x = Math.PI / 2; hb.position.set(x, -0.55, z); meshes.push(hb);
    }
    if (!b.wreck) for (const z of [-W * 0.32, W * 0.32]) { meshes.push(box(0.04, 0.12, 0.26, P.head, L / 2 + 0.01, -0.15, z)); meshes.push(box(0.04, 0.12, 0.22, P.tail, -L / 2 - 0.01, -0.12, z)); }
    meshes.push(box(0.12, 0.16, W + 0.04, P.dark, L / 2, -0.45, 0), box(0.12, 0.16, W + 0.04, P.dark, -L / 2, -0.45, 0));
  }
  // ASSET: prop_fridge / prop_vending / prop_phonebooth (models/prop_*.glb)
  function junkMesh(b, meshes) {
    const P = pm(), [w, h, d] = SS.CFG.PROPS.JUNK[b.prop];
    if (b.prop === 'fridge') {
      meshes.push(box(w, h, d, new T.MeshStandardMaterial({ color: [0xf2f2ee, 0xd8e8ef, 0xf6e6c8][b.id % 3], roughness: 0.3 })));
      meshes.push(box(w + 0.01, 0.02, d + 0.01, P.dark, 0, h * 0.13, 0), box(0.05, 0.36, 0.05, P.chrome, w * 0.36, h * 0.3, d / 2 + 0.03), box(0.05, 0.5, 0.05, P.chrome, w * 0.36, -h * 0.15, d / 2 + 0.03));
    } else if (b.prop === 'vending') {
      meshes.push(box(w, h, d, new T.MeshStandardMaterial({ color: [0xb3141c, 0x1f5fbf, 0x1a1a1a][b.id % 3], roughness: 0.4 })));
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 96; const x = cv.getContext('2d'); x.fillStyle = '#0d141b'; x.fillRect(0, 0, 64, 96);
      const cols = ['#ff4d4d', '#ffd23f', '#4ea8ff', '#79d98b', '#ff9f43']; for (let r = 0; r < 5; r++) for (let k = 0; k < 4; k++) { x.fillStyle = cols[(r + k) % 5]; x.fillRect(6 + k * 14, 8 + r * 17, 9, 12); }
      const tx = new T.CanvasTexture(cv); const panel = new T.Mesh(new T.PlaneGeometry(w * 0.62, h * 0.68), new T.MeshStandardMaterial({ map: tx, emissive: 0xffffff, emissiveMap: tx, emissiveIntensity: 0.9 }));
      panel.position.set(-w * 0.1, h * 0.08, d / 2 + 0.005); meshes.push(panel); meshes.push(box(0.16, 0.36, 0.04, P.chrome, w * 0.36, h * 0.08, d / 2 + 0.02));
    } else {                                                                              // the red phone booth
      meshes.push(box(w, h * 0.9, d, P.red, 0, -h * 0.05, 0), box(w + 0.1, 0.16, d + 0.1, P.red, 0, h * 0.42, 0), box(w * 0.8, 0.1, d * 0.8, P.red, 0, h * 0.5, 0));
      for (const z of [d / 2 + 0.01, -d / 2 - 0.01]) for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) meshes.push(box(w * 0.3, h * 0.15, 0.02, P.paneG, -w * 0.18 + c * w * 0.36, -h * 0.25 + r * h * 0.17, z));
      meshes.push(box(w * 0.7, 0.12, d + 0.02, P.sign, 0, h * 0.36, 0));
    }
  }
  // ASSET: prop_column / prop_obelisk (models/prop_*.glb)
  function stoneMesh(b, meshes) {
    const P = pm(), [r0, h] = SS.CFG.PROPS.STONE[b.prop];
    if (b.prop === 'column') {
      const shaft = std(new T.CylinderGeometry(r0 * 0.85, r0 * 0.92, h * 0.86, 20), P.stone), pa = shaft.geometry.attributes.position;
      for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), z = pa.getZ(i), a = Math.atan2(z, x), k = 1 - 0.05 * Math.pow(Math.abs(Math.cos(a * 10)), 3); pa.setX(i, x * k); pa.setZ(i, z * k); }   // flutes
      shaft.geometry.computeVertexNormals(); meshes.push(shaft);
      meshes.push(box(r0 * 2.3, h * 0.07, r0 * 2.3, P.stone, 0, h / 2 - h * 0.035, 0), box(r0 * 2.3, h * 0.07, r0 * 2.3, P.stone, 0, -h / 2 + h * 0.035, 0));
    } else {
      const sh = std(new T.CylinderGeometry(r0 * 0.5, r0, h * 0.9, 4, 1), P.stone); sh.rotation.y = Math.PI / 4; sh.position.y = -h * 0.05; meshes.push(sh);
      const tip = std(new T.ConeGeometry(r0 * 0.5 * 1.414 / 1.414, h * 0.1, 4), P.stone); tip.rotation.y = Math.PI / 4; tip.position.y = h * 0.45; meshes.push(tip);
    }
  }
  // ASSET: prop_crate, prop_barrel, prop_boulder_[1-4], mine (models/*.glb)
  function propMesh(b, g, meshes) {
    if (b.prop === 'crate') { const h = b.half.x * 2; meshes.push(std(new T.BoxGeometry(h, h, h), mats.crate)); }
    else if (b.prop === 'barrel') {
      const P = SS.CFG.PROPS.BARREL, side = std(new T.CylinderGeometry(P.R, P.R, P.H * 0.96, 20, 1, true), mats.barrel);
      const cap = std(new T.CylinderGeometry(P.R * 0.97, P.R * 0.97, P.H, 20, 1, false), mats.barrelCap);
      cap.scale.set(0.99, 1, 0.99); meshes.push(side, cap);
    } else if (b.prop === 'girder' && SS.structView) {
      const gg = SS.structView.girderGroup(SS.CFG.PROPS.GIRDER);     // M: steel I-beam, same paint / rust as the bridges
      for (const m of gg.meshes) meshes.push(m);
    } else if (b.prop === 'mine') {
      const P = SS.CFG.PROPS.MINE, body = std(new T.CylinderGeometry(P.R * 0.8, P.R, 0.12, 18), mats.mine);
      const lamp = new T.Mesh(new T.SphereGeometry(0.035, 10, 8), new T.MeshStandardMaterial({ color: 0x401010, emissive: 0xff2010, emissiveIntensity: 0.2 }));
      lamp.position.y = 0.07; meshes.push(body, lamp);
    } else if (b.prop === 'boulder') {
      // the collision shell (12 jittered icosahedron spheres): push an icosphere's vertices out to the shell
      const pts = SS.scatter.boulder_pts(b.shapeId || b.id), geo = new T.IcosahedronGeometry(0.42, 1), pa = geo.attributes.position, v = new T.Vector3();
      for (let i = 0; i < pa.count; i++) {
        v.fromBufferAttribute(pa, i).normalize();
        let r = 0.28;
        for (let k = 0; k < pts.length; k += 4) {
          const px = pts[k], py = pts[k + 1], pz = pts[k + 2], rr = pts[k + 3], d = v.x * px + v.y * py + v.z * pz;
          const disc = d * d - (px * px + py * py + pz * pz - rr * rr);
          if (disc >= 0) r = Math.max(r, d + Math.sqrt(disc));       // ray from the centre leaves this sphere at d + sqrt
        }
        const j = 1 + (SS.math.hash3(Math.round(v.x * 40), Math.round(v.y * 40), Math.round(v.z * 40) + b.id) - 0.5) * 0.08;
        pa.setXYZ(i, v.x * r * j, v.y * r * j, v.z * r * j);
      }
      geo.computeVertexNormals();
      meshes.push(std(geo, mats.boulder));
    } else if (b.prop === 'car') carMesh(b, meshes);
    else if (SS.CFG.PROPS.JUNK[b.prop]) junkMesh(b, meshes);
    else if (SS.CFG.PROPS.STONE[b.prop]) stoneMesh(b, meshes);
    else meshes.push(std(new T.BoxGeometry(1, 1, 1), mats.prop));
    for (const m of meshes) g.add(m);
  }
  function build(b) {
    const TR = SS.terrain, g = new T.Group(), meshes = [];
    let ctx = [], near = null, lamp = null;
    if (b.kind === 'chunk' && b.grid) {
      const m = SS.meshgen.local(b.grid, b.com0);
      if (!m.idx.length) return null;
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(m.pos, 3));
      geo.setAttribute('normal', new T.BufferAttribute(m.nrm, 3));
      geo.setAttribute('mA', new T.BufferAttribute(m.mA, 4, true));
      geo.setAttribute('mB', new T.BufferAttribute(m.mB, 4, true));
      geo.setAttribute('mC', new T.BufferAttribute(m.mC, 4, true));
      geo.setAttribute('mD', new T.BufferAttribute(m.mD || new Uint8Array(m.mC.length), 4, true));
      geo.setAttribute('depth', new T.BufferAttribute(m.depth, 1));
      // texture space = where the rock came from (local + com0), so the strata and grass stay glued to the piece
      const tp = new Float32Array(m.pos.length), c0 = b.com0;
      for (let i = 0; i < tp.length; i += 3) { tp[i] = m.pos[i] + c0.x; tp[i + 1] = m.pos[i + 1] + c0.y; tp[i + 2] = m.pos[i + 2] + c0.z; }
      geo.setAttribute('tpos', new T.BufferAttribute(tp, 3));
      geo.setIndex(new T.BufferAttribute(m.idx, 1));
      geo.computeBoundingSphere();
      const BM = TR.bodyMaterials();
      const slab = new T.Mesh(geo, BM.slab); slab.castShadow = slab.receiveShadow = true; slab.customDepthMaterial = TR.slabDepthMaterial();
      const pre = new T.Mesh(geo, BM.pre); pre.renderOrder = 4;
      const far = new T.Mesh(geo, BM.far); far.renderOrder = 5;
      near = new T.Mesh(geo, BM.near); near.renderOrder = 7;
      meshes.push(slab, pre, far, near); g.add(slab, pre, far, near); ctx = [pre, far];
    } else if (b.prop) {
      propMesh(b, g, meshes);
      if (b.prop === 'mine') lamp = meshes[1];
    } else if (b.kind === 'struct' && b.members && SS.structView) {
      const sg = SS.structView.pieceGroup(b);          // M: a fallen piece of a steel bridge
      if (sg) { for (const m of sg.meshes) meshes.push(m); g.add(sg.group); }
    } else if (b.kind === 'log' && b.log && SS.treeView && SS.treeView.logGroup) {
      const lg = SS.treeView.logGroup(b.log);       // broken tree part: same bark / foliage look as the standing trees
      for (const m of lg.meshes) meshes.push(m);
      g.add(lg.group);
    } else if (b.kind === 'log' && b.log) {
      // broken tree part (fallback look without render/trees.js)
      const up = new T.Vector3(0, 1, 0), q = new T.Quaternion();
      for (const sg of b.log.segs) {
        const ax = sg.b.x - sg.a.x, ay = sg.b.y - sg.a.y, az = sg.b.z - sg.a.z, L = Math.hypot(ax, ay, az) || 0.01;
        const me = std(new T.CylinderGeometry(sg.r1, sg.r0, L, 7), mats.bark);
        q.setFromUnitVectors(up, new T.Vector3(ax / L, ay / L, az / L)); me.quaternion.copy(q);
        me.position.set((sg.a.x + sg.b.x) / 2, (sg.a.y + sg.b.y) / 2, (sg.a.z + sg.b.z) / 2);
        meshes.push(me); g.add(me);
      }
      for (const l of b.log.leaves) {
        const me = std(new T.IcosahedronGeometry(l.r * (0.5 + 0.5 * l.f), 1), mats.leaves);
        me.position.set(l.x, l.y, l.z); meshes.push(me); g.add(me);
      }
    } else if (b.kind === 'moai' && SS.armsView) {         // P7: the moai drop's stone head
      const mg = SS.armsView.moaiGroup(); for (const m of mg.meshes) meshes.push(m); g.add(mg.group);
    } else {
      const geo = b.kind === 'ball' ? new T.SphereGeometry(b.r, 16, 12) : b.half ? new T.BoxGeometry(b.half.x * 2, b.half.y * 2, b.half.z * 2) : new T.SphereGeometry(Math.max(0.1, b.rb * 0.6), 12, 8);
      const me = std(geo, mats.prop); meshes.push(me); g.add(me);
    }
    scene.add(g);
    return { g, meshes, ctx, near, lamp, flame: null };
  }
  function drop(id, it) {
    scene.remove(it.g);
    for (const m of it.meshes) { m.geometry.dispose(); if (m === it.lamp) m.material.dispose(); }
    if (it.flame) freeFlame(it.flame);
    items.delete(id);
  }
  // flame billboards (pooled meshes sharing one material; per-flame seed attribute via a tiny geometry clone)
  const pool = [];
  function getFlame(seed) {
    let f = pool.pop();
    if (!f) {
      const geo = flameGeo.clone(), nv = geo.attributes.position.count; geo.setAttribute('seed', new T.Float32BufferAttribute(new Float32Array(nv), 1));
      f = new T.Mesh(geo, flameMat); f.renderOrder = 9; f.frustumCulled = false;
      // callers size flames as (width, height, 1): keep the volume round (depth = width)
      f.onBeforeRender = () => { if (f.scale.z !== f.scale.x) { f.scale.z = f.scale.x; f.updateMatrixWorld(); f.modelViewMatrix.multiplyMatrices(SS.view.camera().matrixWorldInverse, f.matrixWorld); } };
    }
    const s = f.geometry.attributes.seed; s.array.fill(seed); s.needsUpdate = true;
    scene.add(f); f.visible = true; return f;
  }
  function freeFlame(f) { scene.remove(f); pool.push(f); }

  BV.clear = function () { for (const [id, it] of items) drop(id, it); for (const f of flames) freeFlame(f); flames = []; };
  BV.frame = function (S, view) {
    time = view.time || time + 1 / 60;
    if (flameMat) flameMat.uniforms.uTime.value = time;
    const seen = new Set(), ctx = (view.ctxA || 0) > 0.004 && SS.terrain.uniforms.uBack.value < 200;
    const nearOn = (view.insp || 0) > 0.05 && SS.terrain.nearCtx();
    // props and logs are not clipped by shaders: draw them only where the terrain under them is drawn (slab, plus the
    // context while it shows, plus everything while inspecting), else they float in the void behind the slab
    const n = SS.plane.nrm(S), O = S.O, back = SS.terrain.uniforms.uBack.value, insp = (view.insp || 0) > 0.05;
    for (const b of S.bodies || []) {
      seen.add(b.id);
      let it = items.get(b.id);
      if (it && b.prop === 'car' && it.wreck !== !!b.wreck) { drop(b.id, it); it = null; }   // a car blew up: the wreck look
      if (!it) { it = build(b); if (!it) continue; it.wreck = !!b.wreck; items.set(b.id, it); }
      it.g.position.set(b.pos.x, b.pos.y, b.pos.z); it.g.quaternion.set(b.q.x, b.q.y, b.q.z, b.q.w);
      for (const m of it.ctx) m.visible = ctx;
      if (it.near) it.near.visible = nearOn;
      let shown = true;
      if (b.kind !== 'chunk') {
        const t = (b.pos.x - O.x) * n.x + (b.pos.z - O.z) * n.z, r = b.rb || 0.5;
        shown = insp || (t <= r && (t >= -back - r || ctx));
      }
      if (b.prop === 'mine' && shown) shown = SS.view.trapVisible(S, b.team, b.planted, b.revealed || b.armed);   // buried mines
      it.g.visible = shown;
      if (it.lamp) it.lamp.material.emissiveIntensity = b.disarmed ? 0 : b.armed ? (Math.sin(time * 18) > 0 ? 3.5 : 0.1) : (Math.sin(time * 2.5) > 0.6 ? 1.2 : 0.15);
      // burning prop: a flame above it (barrels flare harder towards the end of their burn)
      if (b.burn >= 0 && shown) {
        if (!it.flame) it.flame = getFlame((b.id * 0.618) % 1);
        const grow = Math.min(1, b.burnT / 0.6), big = b.prop === 'barrel' ? 1 + 0.6 * Math.min(1, b.burnT / Math.max(0.1, b.burn)) : 1.2;
        it.flame.position.set(b.pos.x, b.pos.y - b.rb * 0.4, b.pos.z); it.flame.scale.set(1.1 * big * grow, 1.7 * big * grow, 1);
      } else if (it.flame) { freeFlame(it.flame); it.flame = null; }
    }
    for (const [id, it] of items) if (!seen.has(id)) drop(id, it);
    // oil rings: a dozen tongues of flame around each ring, dying down over the last 2 s
    const need = [];
    for (const f of S.flames || []) {
      const left = f.t1 - S.time, k = Math.min(1, left / 2);
      for (let i = 0; i < 12; i++) {
        const a = i * 0.5236 + f.x * 0.37, rr = f.r * (0.45 + 0.5 * SS.math.hash3(i, Math.round(f.x * 10), Math.round(f.z * 10)));
        const x = f.x + Math.cos(a) * rr, z = f.z + Math.sin(a) * rr;
        need.push([x, SS.world.top_at(x, z) - 0.05, z, (0.7 + 0.5 * SS.math.hash3(i, 3, Math.round(f.z * 10))) * k, (i * 0.137 + f.x) % 1]);
      }
    }
    while (flames.length > need.length) freeFlame(flames.pop());
    for (let i = 0; i < need.length; i++) {
      const n = need[i];
      if (!flames[i]) flames[i] = getFlame(n[4]);
      flames[i].position.set(n[0], n[1], n[2]); flames[i].scale.set(0.9 * n[3], 1.4 * n[3], 1);
    }
  };
  BV.FLAME_FS = FLAME_FS;                     // render/trees.js: instanced grass-fire flames
  BV.flame = seed => getFlame(seed);          // shared flame billboards (actors.js: burning worms)
  BV.unflame = f => freeFlame(f);
  BV.count = () => items.size;
  BV.flameCount = () => flames.length + [...items.values()].filter(it => it.flame).length;
})(window.SS = window.SS || {});
