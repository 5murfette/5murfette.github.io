/* render/ffield.js — P37 W4 the force field generator on screen (Three.js; procedural geometry + shaders only).
 *   - the generator: a dark base, three legs, a pylon with a glowing cyan core, a spinning ring and three prongs;
 *   - the dome: a glass-like bubble (one ShaderMaterial on a sphere, drawn double-sided without depth writes). P38:
 *     REAL screen-space refraction: the colour buffer drawn so far (sky, terrain, worms) is copied into a
 *     FramebufferTexture once per frame (dome.onBeforeRender, renderer.copyFramebufferToTexture, a blit: no second
 *     scene render) and the dome shows it again, displaced by the view-space normal (stronger toward the rim and where
 *     a ripple passes, a different amount per colour channel = chromatic dispersion), tinted, plus a Fresnel sky
 *     reflection. Skipped (uRefr 0, the old film look) when the target is an MSAA render target (the lens pass), where
 *     the copy is not allowed. Also: a Fresnel rim, a thin-film colour shift with the viewing angle (soap-bubble hues),
 *     a sun glint, a faint honeycomb of cells (hex lattice on the dominant cube face of the sphere direction), and
 *     RIPPLES: every impact / contained blast adds a ring wave (up to 8 at once) spreading over the field from its
 *     point of impact (arc length x speed, a gaussian front that decays). When the generator dies the dome shatters:
 *     cells drop out one after another (hash per cell) while the rim flares;
 *   - the bounced shell: a free 3D shell (S.free3d) drawn with the projectile models and a cyan wake;
 *   - events: ffplant (a ring on the ground), ffripple / ffbounce (ripple + sparks), ffcontain (inner flash), ffbreak
 *     (shatter), ffrelease (a shock sphere and a flash), ffcrack (dust ring along the cracked ground).
 * API: init(scene, textures), clear(), frame(S, view, camera, dt), onEvent(S, e), stats(). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const FV = SS.ffView = {};
  let scene = null, tx = null, root = null, clock = 0;
  const NR = 8;
  const VS = /* glsl */`
    varying vec3 vN;
    varying vec3 vW;
    varying vec3 vL;
    void main() {
      vL = normalize(position);
      vN = normalize(mat3(modelMatrix) * normal);
      vec4 w = modelMatrix * vec4(position, 1.0);
      vW = w.xyz;
      gl_Position = projectionMatrix * viewMatrix * w;
    }`;
  const FS = /* glsl */`
    varying vec3 vN;
    varying vec3 vW;
    varying vec3 vL;
    uniform vec3 uCam, uSun;
    uniform float uT, uR, uFlash, uBreak, uHit, uRefr, uInside, uDay;
    uniform vec4 uRip[${NR}];
    uniform float uAmp[${NR}];
    // P44: the ground density around the dome (3D texture, world box uGO .. uGO + uGS)
    precision highp sampler3D;
    uniform sampler3D tG;
    uniform vec3 uGO;
    uniform float uGS, uGon;
    uniform vec3 uO, uN;   // the section plane (the terrain is shown only behind it)
    // view-matrix rows (world -> view xy, z)
    uniform sampler2D tScene;
    uniform vec2 uRes;
    uniform vec3 uView0, uView1, uView2;
    ${SS.glsl.HASH12S}
    // hex lattice: returns (distance to the nearest cell edge in 0..0.5 from the cell edge inwards, cell id)
    vec4 hexc(vec2 p) {
      vec2 r = vec2(1.0, 1.7320508), h = r * 0.5, a = mod(p, r) - h, b = mod(p - h, r) - h, gv = dot(a, a) < dot(b, b) ? a : b;
      return vec4(gv, p - gv);
    }
    float hexEdge(vec2 gv) {
      gv = abs(gv);
      return max(dot(gv, normalize(vec2(1.0, 1.7320508))), gv.x);
    }
    void main() {
      vec3 N = normalize(vN), V = normalize(uCam - vW);
      if (!gl_FrontFacing) N = -N;
      // P44: the dome ends AT the ground: the density of the terrain at this fragment (0 = the surface, > 0 solid):
      // discarded inside the ground, a bright glowing contact line + a ripple running along the ground where the shell
      // meets it, a soft fade just above it
      float gd = -1.0, contact = 0.0, gfade = 1.0;
      if (uGon > 0.5) {
        // the terrain is drawn only BEHIND the section plane (tD < 0). A shell fragment in front of it is tested at two
        // places on the cut profile (the plane): where the view ray through it meets the plane (so nothing of the dome
        // shows over the cut face = no dome under the ground line) and straight under it along the plane normal (the
        // profile extruded toward the camera: right in the 3D orbit view too).
        float tD = dot(vW - uO, uN), tc = dot(uCam - uO, uN);
        vec3 q = tD > 0.0 && tc > tD ? uCam + (vW - uCam) * (tc / (tc - tD)) : vW, gp = (q - uGO) / uGS,
          gp2 = ((tD > 0.0 ? vW - uN * tD : vW) - uGO) / uGS;
        float g1 = (gp.x < 0.0 || gp.y < 0.0 || gp.z < 0.0 || gp.x > 1.0 || gp.y > 1.0 || gp.z > 1.0) ? -1.0 : (texture(tG, gp).r - 0.5) * 6.0;
        float g2 = tD > 0.0 ? (texture(tG, clamp(gp2, 0.0, 1.0)).r - 0.5) * 6.0 : g1;
        gd = max(g1, g2);
        if (gd > 0.0) discard;
        float hgt = -gd;                                                              // ~ distance above the ground
        contact = exp(-hgt * hgt / 0.02) + 0.35 * exp(-hgt / 0.45);
        gfade = smoothstep(0.0, 0.10, hgt);
      }
      float ndv = clamp(abs(dot(N, V)), 0.0, 1.0), fres = pow(1.0 - ndv, 3.0);
      vec3 film = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + ndv * 1.3 + uT * 0.04));
      vec3 col = mix(vec3(0.38, 0.78, 1.0), film, 0.4);
      vec3 H = normalize(normalize(uSun) + V);
      float spec = pow(max(dot(N, H), 0.0), 140.0);
      // honeycomb on the dominant cube face of the direction
      vec3 d = vL, ad = abs(d);
      vec2 uv = ad.x > ad.y && ad.x > ad.z ? d.yz / ad.x : ad.y > ad.z ? d.xz / ad.y : d.xy / ad.z;
      vec4 hx = hexc(uv * 6.5);
      float edge = smoothstep(0.40, 0.5, hexEdge(hx.xy)), cid = sl_hash12s(hx.zw + floor(d * 3.0).xy);
      float cellGlow = edge * (0.5 + 0.5 * sin(uT * 1.6 + cid * 6.28));
      // ripples: a gaussian front at arc length (age x 5 m/s) with a few inner rings, decaying
      float rip = 0.0;
      for (int i = 0; i < ${NR}; i++) {
        float amp = uAmp[i];
        if (amp <= 0.0) continue;
        float ang = acos(clamp(dot(vL, uRip[i].xyz), -1.0, 1.0)), arc = ang * uR, age = uRip[i].w, front = arc - age * 5.5;
        rip += amp * exp(-front * front / 0.9) * (0.6 + 0.4 * cos(front * 7.0)) * exp(-age * 1.1);
      }
      float shatter = 0.0;
      if (uBreak > 0.0) {
        float thr = cid * 0.8;
        shatter = smoothstep(thr, thr + 0.2, uBreak);
        if (shatter > 0.99) discard;
      }
      // the contact line: energy racing round along the ground (azimuth around the generator), a hex-cell pattern, a
      // hot core
      float az = atan(vL.z, vL.x), flow = 0.55 + 0.45 * sin(az * 9.0 - uT * 3.0 + sl_hash12s(floor(vec2(az * 4.0, 0.0))) * 6.28),
        hexg = 0.65 + 0.35 * cellGlow;
      float cl = contact * (0.55 + 0.45 * flow) * hexg;
      float a = 0.05 + fres * 0.55 + cellGlow * 0.16 + rip * 0.5 + spec * 0.9 + uFlash * (0.25 + 0.3 * fres) + uHit * 0.18;
      a += cl * 1.1;
      a *= (1.0 - shatter) * mix(0.35, 1.0, gfade);
      vec3 c = col * (0.55 + fres) + vec3(0.45, 0.95, 1.0) * cl * 2.0 + vec3(1.0) * spec + vec3(0.7, 1.0, 1.0) * (rip * 0.9 + cellGlow * 0.3) + vec3(1.0, 0.95, 0.8) * uFlash * 0.5;
      if (uBreak > 0.0) c += vec3(0.8, 1.0, 1.0) * edge * (1.0 - shatter) * 0.8;
      // P38: the refracting surface = the one nearest the camera (front faces; from inside the dome: the far wall)
      bool nearest = gl_FrontFacing != (uInside > 0.5);
      if (uRefr > 0.5 && nearest && shatter < 0.99) {
        vec3 Nv = vec3(dot(uView0, N), dot(uView1, N), dot(uView2, N));               // normal in view space
        // displacement: lens-like toward the rim, wobbles with ripples
        float k = (0.010 + 0.036 * pow(1.0 - ndv, 1.4)) * (1.0 + rip * 2.0);
        vec2 uv0 = gl_FragCoord.xy / uRes, off = -Nv.xy * k, asp = vec2(1.0, uRes.x / uRes.y);
        // dispersion (level 0: the mip chain of the lens target is not built until the end of the pass)
        vec3 refr = vec3(textureLod(tScene, uv0 + off * 0.85 * asp, 0.0).r, textureLod(tScene, uv0 + off * asp, 0.0).g, textureLod(tScene, uv0 + off * 1.15 * asp, 0.0).b);
        refr *= mix(vec3(0.93, 0.99, 1.0), vec3(0.6, 0.85, 1.0), fres);               // a faint cyan glass tint, deeper at the rim
        vec3 Rf = reflect(-V, N);
        vec3 sky = mix(vec3(0.62, 0.74, 0.88), vec3(0.22, 0.42, 0.78), clamp(Rf.y, 0.0, 1.0)) * (0.25 + 0.75 * uDay);
        vec3 emit = c * a * 0.9 + sky * fres * 0.5;
        gl_FragColor = vec4(refr * (1.0 - shatter) + emit, 1.0 - shatter);
      } else gl_FragColor = vec4(c * a, a);
    }`;
  const MT = {
    dark: new T.MeshStandardMaterial({ color: 0x2a2f34, metalness: 0.7, roughness: 0.4 }),
    steel: new T.MeshStandardMaterial({ color: 0xb4bac2, metalness: 0.85, roughness: 0.25 }),
    core: new T.MeshBasicMaterial({ color: 0x9fe8ff })
  };
  const KEEP = new Set(Object.values(MT));
  function genMesh(f) {
    const g = new T.Group();
    const add = (geo, mat, x, y, z, rx, ry, rz) => {
      const m = new T.Mesh(geo, mat);
      m.position.set(x || 0, y || 0, z || 0);
      m.rotation.set(rx || 0, ry || 0, rz || 0);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    add(new T.CylinderGeometry(0.2, 0.26, 0.1, 14), MT.dark, 0, 0.05, 0);
    for (let i = 0; i < 3; i++) {
      const a = i * 2.094;
      add(
        new T.CylinderGeometry(0.02, 0.025, 0.3, 6),
        MT.steel,
        Math.cos(a) * 0.2,
        0.1,
        Math.sin(a) * 0.2,
        Math.sin(a) * 0.5,
        0,
        -Math.cos(a) * 0.5
      );
    }
    add(new T.CylinderGeometry(0.06, 0.08, 0.34, 10), MT.dark, 0, 0.27, 0);
    const core = add(new T.SphereGeometry(0.1, 14, 10), MT.core.clone(), 0, 0.5, 0);
    core.castShadow = false;
    const ring = add(new T.TorusGeometry(0.17, 0.016, 6, 24), MT.steel, 0, 0.5, 0, Math.PI / 2, 0, 0);
    for (let i = 0; i < 3; i++) {
      const a = i * 2.094 + 1;
      add(
        new T.CylinderGeometry(0.008, 0.014, 0.28, 5),
        MT.steel,
        Math.cos(a) * 0.09,
        0.68,
        Math.sin(a) * 0.09,
        Math.sin(a) * 0.4,
        0,
        -Math.cos(a) * 0.4
      );
    }
    const glow = new T.Sprite(
      new T.SpriteMaterial({
        map: tx.glow,
        color: 0x7fe0ff,
        transparent: true,
        blending: T.AdditiveBlending,
        depthWrite: false,
        opacity: 0.8
      })
    );
    glow.scale.set(1.3, 1.3, 1);
    glow.position.y = 0.5;
    g.add(glow);
    g.scale.setScalar(1.5);
    g.userData = { core, ring, glow };
    return g;
  }
  /* the colour grab: the frame as drawn so far (everything opaque, the sky, earlier transparents) copied into a
   * FramebufferTexture once per rendered frame, the first time a dome is drawn */
  let grabTex = null, grabW = 0, grabH = 0, grabFrame = -1;
  const gv2 = new T.Vector2(), gv0 = new T.Vector2(0, 0), gFr = new T.Frustum(), gPM = new T.Matrix4(), gSp = new T.Sphere();
  function grabPass(renderer, sc, camera) {
    const u = this.userData.u, tgt = renderer.getRenderTarget();
    // only a dome that is on screen pays for a grab (the meshes are never frustum culled: the shader needs them every
    // frame)
    gPM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    gFr.setFromProjectionMatrix(gPM);
    gSp.center.copy(this.position);
    gSp.radius = this.userData.R;
    if (!gFr.intersectsSphere(gSp)) {
      u.uRefr.value = 0;
      return;
    }
    let w, h;
    if (tgt && tgt.samples > 0) {
      /* P118d: the colour grade draws every frame into the lens pass's multisampled target, which cannot be copied from
       * (copyFramebufferToTexture needs a single-sample
       * read buffer: it raised INVALID_OPERATION and the dome never refracted at medium / high quality). Resolve that
       * target by hand instead, once per frame, the way three.js resolves it at the end of a render call: blit the
       * samples into the target's own texture (rt.texture, attached to its single-sample framebuffer), which is NOT
       * bound for drawing now (the samples live in a renderbuffer), so the dome can sample it while it draws. The mip
       * chain of that texture is stale until the end of the pass: the shader reads level 0 only (textureLod). The
       * end-of-pass resolve overwrites the texture with the final image. */
      const gl = renderer.getContext(),
        st = renderer.state,
        pr = renderer.properties.get(tgt),
        ms = pr.__webglMultisampledFramebuffer,
        rs = pr.__webglFramebuffer;
      if (!ms || !rs) {
        u.uRefr.value = 0;
        return;
      }
      w = tgt.width; h = tgt.height;
      const fr = renderer.info.render.frame;
      if (fr !== grabFrame) {
        grabFrame = fr;
        st.bindFramebuffer(gl.READ_FRAMEBUFFER, ms); st.bindFramebuffer(gl.DRAW_FRAMEBUFFER, rs);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        // back to drawing into the samples (READ and DRAW)
        st.bindFramebuffer(gl.FRAMEBUFFER, ms);
      }
      u.tScene.value = tgt.texture;
    } else {
      if (tgt) gv2.set(tgt.width, tgt.height);
      else renderer.getDrawingBufferSize(gv2);
      w = Math.max(1, Math.floor(gv2.x)); h = Math.max(1, Math.floor(gv2.y));
      if (!grabTex || w !== grabW || h !== grabH) {
        if (grabTex) grabTex.dispose();
        grabTex = new T.FramebufferTexture(w, h);
        grabTex.minFilter = grabTex.magFilter = T.LinearFilter;
        grabW = w;
        grabH = h;
        grabFrame = -1;
      }
      const fr = renderer.info.render.frame;
      if (fr !== grabFrame) {
        grabFrame = fr;
        renderer.copyFramebufferToTexture(gv0, grabTex);
      }
      u.tScene.value = grabTex;
    }
    const e = camera.matrixWorldInverse.elements, c = this.position;
    u.uRes.value.set(w, h); u.uRefr.value = FV.refraction === false ? 0 : 1;
    u.uView0.value.set(e[0], e[4], e[8]); u.uView1.value.set(e[1], e[5], e[9]); u.uView2.value.set(e[2], e[6], e[10]);
    u.uInside.value = camera.position.distanceTo(c) < this.userData.R ? 1 : 0;
    u.uDay.value = Math.min(1, Math.max(0, u.uSun.value.y * 2));
  }
  function domeMesh(R) {
    const u = { uCam: { value: new T.Vector3() }, uSun: { value: new T.Vector3(0.4, 0.8, 0.4) }, uT: { value: 0 }, uR: { value: R },
      uFlash: { value: 0 }, uBreak: { value: 0 }, uHit: { value: 0 },
      uRip: { value: Array.from({ length: NR }, () => new T.Vector4(0, 1, 0, 99)) }, uAmp: { value: new Array(NR).fill(0) },
      tScene: { value: null }, tG: { value: null }, uGO: { value: new T.Vector3() }, uGS: { value: 1 }, uGon: { value: 0 },
      uO: SS.terrain.uniforms.uO, uN: SS.terrain.uniforms.uN, uRes: { value: new T.Vector2(1, 1) }, uRefr: { value: 0 },
      uInside: { value: 0 }, uDay: { value: 1 }, uView0: { value: new T.Vector3() }, uView1: { value: new T.Vector3() },
      uView2: { value: new T.Vector3() } };
    const m = new T.Mesh(
      new T.SphereGeometry(R, 56, 36),
      new T.ShaderMaterial({
        vertexShader: VS,
        fragmentShader: FS,
        uniforms: u,
        transparent: true,
        depthWrite: false,
        side: T.DoubleSide,
        blending: T.CustomBlending,
        blendEquation: T.AddEquation,
        blendSrc: T.OneFactor,
        blendDst: T.OneMinusSrcAlphaFactor
      })
    );
    m.renderOrder = 6;
    m.frustumCulled = false;
    m.userData.u = u;
    m.userData.R = R;
    m.onBeforeRender = grabPass;
    return m;
  }
  /* P44: the terrain around a dome as a 3D density texture (the world's own SDF, 8 bit: byte = (d / 6 + 0.5) x 255),
   * box = the sphere's bounds;
   * only the cells near the shell are sampled (the shader reads it on the shell only). Rebuilt when the world changes
   * under it (W.version), at most every 3rd frame. Render side only: it reads the sim's world, never writes. */
  const GN = 48;
  function groundTex(it, f, c) {
    const W = SS.world;
    if (!W || !W.sample) return;
    const u = it.dome.material.uniforms;
    if (!it.gtex) {
      it.gdata = new Uint8Array(GN * GN * GN); it.gtex = new T.Data3DTexture(it.gdata, GN, GN, GN);
      it.gtex.format = T.RedFormat;
      it.gtex.type = T.UnsignedByteType;
      it.gtex.minFilter = it.gtex.magFilter = T.LinearFilter;
      it.gtex.wrapS = it.gtex.wrapT = it.gtex.wrapR = T.ClampToEdgeWrapping;
      it.gtex.unpackAlignment = 1;
      it.gver = -1; u.tG.value = it.gtex; u.uGS.value = 2 * f.R + 1.2;
    }
    const ou = SS.terrain.uniforms.uO.value,
      nu = SS.terrain.uniforms.uN.value,
      key = ou.x + ou.z * 7.3 + nu.x * 131 + nu.z * 17,
      ver = W.version | 0;
    if (ver === it.gver && it.gc === c.y && it.gkey === key) return;
    if (it.gver >= 0 && ++it.gwait < 3 && it.gc === c.y && it.gkey === key) return;
    it.gwait = 0;
    it.gver = ver;
    it.gc = c.y;
    it.gkey = key;
    const S = u.uGS.value, ox = c.x - S / 2, oy = c.y - S / 2, oz = c.z - S / 2, h = S / GN, d = it.gdata, R = f.R;
    u.uGO.value.set(ox, oy, oz);
    for (let k = 0; k < GN; k++)
      for (let j = 0; j < GN; j++)
        for (let i = 0; i < GN; i++) {
          const x = ox + (i + 0.5) * h, y = oy + (j + 0.5) * h, z = oz + (k + 0.5) * h, r = Math.hypot(x - c.x, y - c.y, z - c.z);
          let v = 0;
          if ((r > R - 0.5 && r < R + 0.5) || Math.abs((x - ou.x) * nu.x + (z - ou.z) * nu.z) < 1.3 * h)
            v = Math.max(0, Math.min(255, Math.round((Math.max(-3, Math.min(3, W.sample(x, y, z))) / 6 + 0.5) * 255)));
          d[(k * GN + j) * GN + i] = v;
        }
    it.gtex.needsUpdate = true; u.uGon.value = 1;
  }
  const items = new Map(), shells = new Map(), fxs = [], ripples = new Map();   // ripples: field id -> [{dir, t0, amp}]
  FV.init = function (sc, textures) {
    scene = sc;
    tx = textures;
    root = new T.Group();
    scene.add(root);
  };
  FV.clear = function () {
    for (const it of items.values()) {
      if (it.gtex) it.gtex.dispose();
      root.remove(it.g);
      SS.mat.disposeTree(it.g, KEEP);
    }
    items.clear();
    for (const m of shells.values()) {
      root.remove(m);
      SS.mat.disposeTree(m, KEEP);
    }
    shells.clear();
    for (const f of fxs) {
      root.remove(f.obj);
      SS.mat.disposeTree(f.obj, KEEP);
    }
    fxs.length = 0;
    ripples.clear();
  };
  const addFx = (obj, life, fn) => {
    root.add(obj);
    fxs.push({ obj, t: 0, life, fn });
    return obj;
  };
  function shock(x, y, z, col, r1, life) {
    const m = new T.Mesh(
      new T.SphereGeometry(1, 28, 18),
      new T.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0.6,
        blending: T.AdditiveBlending,
        depthWrite: false,
        side: T.DoubleSide
      })
    );
    m.position.set(x, y, z);
    addFx(m, life, (o, k) => {
      const s = 0.3 + (r1 - 0.3) * Math.sqrt(k);
      o.scale.set(s, s, s);
      o.material.opacity = 0.6 * (1 - k) * (1 - k);
    });
  }
  function addRipple(S, fid, x, y, z, amp) {
    const f = S.ffields.find(q => q.id === fid);
    if (!f) return;
    const c = SS.ffield.centre(f), dx = x - c.x, dy = y - c.y, dz = z - c.z, l = Math.hypot(dx, dy, dz) || 1;
    const list = ripples.get(fid) || [];
    list.push({ dir: [dx / l, dy / l, dz / l], t0: clock, amp });
    if (list.length > NR) list.shift();
    ripples.set(fid, list);
    const it = items.get(fid);
    if (it) it.hit = 1;
  }
  FV.onEvent = function (S, e) {
    switch (e.type) {
      case 'ffplant': {
        SS.fx.dust(e.x, e.y, e.z, 6, 0.45, 0xb8a080);
        const m = new T.Mesh(
          new T.RingGeometry(0.9, 1, 48),
          new T.MeshBasicMaterial({
            color: 0x9fe8ff,
            transparent: true,
            opacity: 0.8,
            blending: T.AdditiveBlending,
            depthWrite: false,
            side: T.DoubleSide
          })
        );
        m.rotation.x = -Math.PI / 2;
        m.position.set(e.x, e.y + 0.05, e.z);
        addFx(m, 0.9, (o, k) => {
          const s = 0.5 + e.R * 1.05 * k;
          o.scale.set(s, s, s);
          o.material.opacity = 0.8 * (1 - k);
        });
        break;
      }
      case 'ffripple': addRipple(S, e.fid, e.x, e.y, e.z, e.amp || 1); break;
      case 'ffbounce':
        for (let i = 0; i < 12; i++) SS.fx.spark(e.x, e.y, e.z);
        shock(e.x, e.y, e.z, 0x9fe8ff, 1.2, 0.3);
        break;
      case 'ffcontain': {
        const it = items.get(e.fid);
        if (it) it.flash = 1;
        break;
      }
      case 'ffbreak': {
        const it = items.get(e.fid);
        if (it) it.breakT = clock;
        for (let i = 0; i < 10; i++) SS.fx.spark(e.x, e.y + 0.5, e.z);
        break;
      }
      case 'ffrelease': shock(e.x, e.y, e.z, 0xbff4ff, 3 + 2.5 * Math.cbrt(e.W), 0.5); break;
      case 'ffcrack':
        for (let i = 0; i < 10; i++) {
          const a = i * 0.628, r = e.R * (0.4 + 0.6 * Math.random());
          SS.fx.dust(e.x + Math.cos(a) * r, e.y - 0.2, e.z + Math.sin(a) * r, 3, 0.9, 0x8a7a68);
        }
        break;
    }
  };
  const vq = new T.Vector3(), xAxis = new T.Vector3(1, 0, 0);
  FV.frame = function (S, view, camera, dt) {
    if (!scene) return;
    const t = clock = view.time || 0;
    const seen = new Set(), sun = view.look && view.look.sunDir ? view.look.sunDir : [-0.4, 0.7, 0.6];
    for (const f of S.ffields || []) {
      seen.add(f.id);
      let it = items.get(f.id);
      if (!it) {
        const g = new T.Group(), gen = genMesh(f), dome = domeMesh(f.R);
        g.add(gen, dome);
        root.add(g);
        it = { g, gen, dome, hit: 0, flash: 0, breakT: -1 }; items.set(f.id, it);
      }
      const c = SS.ffield.centre(f), uf = it.dome.material.uniforms;
      it.gen.position.set(f.pos.x, f.pos.y, f.pos.z); it.dome.position.set(c.x, c.y, c.z);
      groundTex(it, f, c);
      it.dome.visible = SS.view.shownAt(S, f.pos, f.R) || (view.insp || 0) > 0.05;
      uf.uCam.value.copy(camera.position); uf.uSun.value.set(sun[0], sun[1], sun[2]); uf.uT.value = t;
      const rl = ripples.get(f.id) || [];
      for (let i = 0; i < NR; i++) {
        const r = rl[i];
        if (r && t - r.t0 < 3.5) {
          uf.uRip.value[i].set(r.dir[0], r.dir[1], r.dir[2], t - r.t0);
          uf.uAmp.value[i] = r.amp;
        } else uf.uAmp.value[i] = 0;
      }
      it.flash = Math.max(0, it.flash - dt * 2.5); it.hit = Math.max(0, it.hit - dt * 1.6);
      uf.uFlash.value = it.flash; uf.uHit.value = it.hit;
      const brk = f.state === 1 ? Math.min(1.4, (t - (it.breakT >= 0 ? it.breakT : (it.breakT = t))) / 0.9) : 0;
      uf.uBreak.value = brk;
      // the generator: the core flares on a hit, flickers when the field is down, the ring spins
      const u = it.gen.userData, live = f.state === 0;
      u.ring.rotation.z = t * 3; u.ring.rotation.x = Math.PI / 2 + 0.3 * Math.sin(t * 1.7);
      u.core.material.color.setHex(live ? 0x9fe8ff : (Math.sin(t * 40) > 0.3 ? 0x6a8a99 : 0x1a2a33))
        .multiplyScalar(1 + it.hit * 0.9 + it.flash);
      u.glow.material.opacity = live ? 0.55 + 0.25 * Math.sin(t * 5) + it.hit * 0.4 : 0.15;
      if (f.charges <= 0 && live) u.core.material.color.setHex(0x7fd0e8);
    }
    for (const [id, it] of items)
      if (!seen.has(id)) {
        if (it.gtex) it.gtex.dispose();
        root.remove(it.g);
        SS.mat.disposeTree(it.g, KEEP);
        items.delete(id);
        ripples.delete(id);
      }
    // the bounced shell: a free 3D flight, models of the projectile types
    const seenS = new Set();
    for (const q of S.free3d || []) {
      seenS.add(q.id);
      let m = shells.get(q.id);
      if (!m) {
        m = (SS.ordnance && SS.ordnance.proj(q.type))
          || (SS.armsView && SS.armsView.projMesh(q.type))
          || new T.Mesh(new T.SphereGeometry(0.14, 10, 8), new T.MeshStandardMaterial({ color: 0x3d6b2a }));
        m.castShadow = true; root.add(m); shells.set(q.id, m);
      }
      m.position.set(q.pos.x, q.pos.y, q.pos.z);
      const sp = Math.hypot(q.vel.x, q.vel.y, q.vel.z) || 1;
      vq.set(q.vel.x / sp, q.vel.y / sp, q.vel.z / sp);
      const rocket = (SS.armsView && SS.armsView.isRocket(q.type)) || q.type === 'bazooka';
      if (rocket) m.quaternion.setFromUnitVectors(xAxis, vq);
      else {
        m.rotation.x += dt * q.spin;
        m.rotation.z += dt * q.spin * 0.7;
      }
      if (Math.random() < 0.6) SS.fx.trail(q.pos.x, q.pos.y, q.pos.z);
    }
    for (const [id, m] of shells)
      if (!seenS.has(id)) {
        root.remove(m);
        shells.delete(id);
        SS.mat.disposeTree(m, KEEP);
      }
    for (let i = fxs.length - 1; i >= 0; i--) {
      const f = fxs[i];
      f.t += dt;
      if (f.t >= f.life) {
        root.remove(f.obj);
        SS.mat.disposeTree(f.obj, KEEP);
        fxs.splice(i, 1);
        continue;
      }
      f.fn(f.obj, f.t / f.life);
    }
  };
  FV._items = items;
  FV.stats = () => ({ fields: items.size, shells: shells.size, fx: fxs.length });
  /* P78: the dome material is built on the first force field: pre-warm exemplar (render/prewarm.js) */
  if (SS.prewarm) SS.prewarm.exemplars(() => domeMesh(1));
})(window.SS = window.SS || {});
