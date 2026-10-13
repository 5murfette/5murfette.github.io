/* render/acid.js — P44 acid puddles that FOLLOW THE GROUND (Three.js; procedural geometry + shaders, no images; render
 * side only).
 * The old puddles were flat discs lying on the ground plane: on a slope they stuck out of the hill on one side and sank
 * into it on the other. Now every spot (S.wa.spots, the sim's data, read only) owns a slot in ONE dynamic mesh (80
 * slots, ~110 vertices each):
 *   - the puddle: a polar grid (center + 5 rings x 18 segments) laid in the tangent plane of the ground at the spot
 *     (normal = the SDF gradient there), every vertex then pushed ALONG THE NORMAL onto the real terrain surface (a
 *     short ray march of the world's density, W.sample, linear interpolation of the zero crossing): the puddle hugs
 *     bumps, craters and cliff faces. Vertices that find no ground (over an edge, inside a wall) are marked invalid and
 *     cut away by the shader. The grid's angle is measured from the DOWNHILL direction, so the shader can run the
 *     pattern downhill, stretch the pool downhill and drive the trickle;
 *   - the trickle: on a slope (> ~15 deg) a rivulet leaves the lower edge and is traced down the surface step by step
 *     (gradient descent on the surface: g minus its normal part, re-projected onto the ground each step), a tapering
 *     ribbon with running pulses;
 *   - the look (one fragment shader): a deep green liquid with a caustic network and rising / popping bubbles, a glossy
 *     sun glint from the surface normal (screen derivatives), a bright meniscus rim, an emissive lime glow that stays
 *     at night, and a dark scorched halo around the pool (the ground it is eating) that grows with the spot's age.
 * A spot is re-fitted when it is new, when it outgrew its grid, or when a cheap probe (5 rays, one spot per frame,
 * every 0.3 s) finds the ground moved under it (the sim bites the ground every 0.75 s; blasts); at most FITS spots per
 * frame. Cost: ~0.1 ms per fit. API: init(scene), clear(), frame(S, view, camera, dt), stats(). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const AV = SS.acidView = {};
  const SLOTS = 80, NR = 5, NS = 18, NT = 12, NTR = 2, FITS = 3, FR = [0.26, 0.48, 0.68, 0.85, 1.0];
  const VP = 1 + NR * NS, VPS = VP + NTR * NT * 2, IPS = (NS + (NR - 1) * NS * 2) * 3 + NTR * (NT - 1) * 6;
  const TAU = Math.PI * 2, NOFF = 0.035;
  let scene = null, mesh = null, geo = null, pos = null, aP = null, aV = null, aS = null, W = null;
  const recs = new Map(), freeSlots = [];
  let hiSlot = 0, nFit = 0;

  const VS = /* glsl */`
    attribute vec4 aP;
    attribute float aV;
    attribute vec4 aS;
    varying vec4 vP;
    varying vec4 vS;
    varying float vVal;
    varying vec3 vW;
    void main() {
      vP = aP;
      vS = aS;
      vVal = aV;
      vW = position;
      gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
    }`;
  const FS = /* glsl */`
    varying vec4 vP;
    varying vec4 vS;
    varying float vVal;
    varying vec3 vW;
    uniform float uTime, uDay;
    uniform vec3 uSun, uCam, uO, uN;
    float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    vec2 h22(vec2 p) { return vec2(h21(p), h21(p + 19.19)); }
    float n2(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
    }
    float fbm(vec2 p) {
      float a = 0.5, s = 0.0;
      for (int i = 0; i < 4; i++) {
        s += a * n2(p);
        p = p * 2.03 + vec2(1.7, -0.6);
        a *= 0.5;
      }
      return s;
    }
    // bubbles: a grid of cells, each grows, then pops (a bright ring that fades), at its own phase
    float bubbles(vec2 p, float t, out float fill) {
      vec2 g = floor(p), f = fract(p) - 0.5;
      float h = h21(g), ph = fract(t * (0.25 + 0.3 * h) + h * 9.0);
      vec2 off = (h22(g + 3.0) - 0.5) * 0.5;
      float r = 0.05 + ph * 0.3, d = length(f - off);
      fill = smoothstep(r, r * 0.4, d) * (1.0 - ph) * 0.35;
      return smoothstep(0.045, 0.0, abs(d - r)) * (1.0 - ph * ph) * step(0.35, h);
    }
    void main() {
      if (vVal < 0.5) discard;
      // like the terrain: nothing in front of the section plane
      float tD = dot(vW - uO, uN);
      if (tD > 0.2) discard;
      float fade = vS.y;
      if (fade <= 0.01) discard;
      vec3 V = normalize(uCam - vW), nW = normalize(cross(dFdx(vW), dFdy(vW)));
      if (dot(nW, V) < 0.0) nW = -nW;
      float seed = vP.w, sl = vS.z, age = vS.w, day = mix(0.35, 1.0, uDay);
      vec3 deep = vec3(0.03, 0.22, 0.02), lime = vec3(0.50, 0.95, 0.10), sCol = vec3(0.045, 0.035, 0.02);
      float acidA = 0.0, scorchA = 0.0, glow = 0.0, rimL = 0.0, bub = 0.0, tone = 0.5;
      vec2 q;
      if (vP.z < 0.5) {
        float f = vP.x, a = vP.y, R = vS.x;
        // domain warp: an organic outline
        vec2 p0 = f * vec2(cos(a), sin(a)) * 7.0,
          p = p0 + 2.6 * (vec2(fbm(p0 * 0.26 + seed), fbm(p0 * 0.26 + seed + 9.0)) - 0.5) + 0.4 * (vec2(n2(p0 * 1.1 + seed), n2(p0 * 1.1 + 5.0)) - 0.5);
        vec2 pf = p - vec2(uTime * (0.25 + 0.9 * sl), 0.0);                            // the pattern runs downhill (+x)
        float shape = 0.88 + 0.07 * sin(a * 2.0 + seed);
        float d = length(p) / 7.0 / max(1e-3, R * shape);
        acidA = (1.0 - smoothstep(0.955, 1.0, d)) * fade;
        float sc = min(1.0, 0.2 + age * 0.1), sd = (d - 1.0) / (0.55 + 0.4 * n2(p * 0.5 + seed));
        scorchA = (1.0 - smoothstep(0.0, 1.0, sd)) * 0.38 * sc * min(1.0, fade * 1.6) * step(0.0, sd + 0.02);
        float n = fbm(pf * 0.9 + seed), cau = abs(fbm(pf * 1.7 + vec2(0.0, uTime * 0.18)) - 0.5);
        float fillB, bb = bubbles(pf * 1.1, uTime, fillB);
        tone = 0.12 + 0.42 * n + 0.38 * smoothstep(0.07, 0.0, cau) + 0.2 * smoothstep(0.55, 0.9, d) - 0.18 * smoothstep(0.80, 0.92, d) * (1.0 - smoothstep(0.92, 0.97, d));
        bub = bb + fillB;
        rimL = smoothstep(0.915, 0.955, d) * (1.0 - smoothstep(0.955, 0.99, d)) * 1.5;   // a thin bright meniscus
        glow = 0.25 + 0.5 * tone;
      } else {
        // the trickle: u 0 (the pool) .. 1 (the tip), v across -1 .. 1
        float u = vP.x, v = vP.y, e = abs(v) + 0.14 * (n2(vec2(u * 10.0, seed)) - 0.5);
        float ends = smoothstep(0.0, 0.07, u) * (1.0 - smoothstep(0.45, 1.0, u));            // joins the pool, fades toward the tip
        float pulse = 0.5 + 0.5 * sin(u * 11.0 - uTime * (3.0 + 4.0 * sl) + seed), core = 1.0 - smoothstep(0.0, 0.8, e);
        acidA = (1.0 - smoothstep(0.50, 0.92, e)) * ends * fade * (0.82 + 0.18 * pulse);
        scorchA = (1.0 - smoothstep(0.75, 1.0, e)) * ends * 0.4 * fade * step(0.5, e + 0.35);   // darker eaten edges
        tone = 0.22 + 0.4 * core + 0.12 * pulse; rimL = smoothstep(0.35, 0.8, e) * 0.35; glow = 0.2 + 0.4 * core;
        // the wet sheen: a highlight streak down the middle
        bub = pow(core, 3.0) * 0.55 * (0.4 + 0.6 * uDay);
      }
      vec3 L = normalize(uSun), Hh = normalize(L + V);
      vec3 nb = normalize(nW + vec3(0.0, 0.18, 0.0) * (tone - 0.5) * 2.0);
      float spec = pow(max(dot(nb, Hh), 0.0), 60.0) * (0.25 + 0.75 * uDay), fres = pow(1.0 - clamp(dot(nW, V), 0.0, 1.0), 3.0);
      vec3 acid = mix(deep, lime * 0.8, clamp(tone * 0.85, 0.0, 1.0)) * day;
      acid += lime * glow * 0.45 + vec3(0.5, 0.8, 0.2) * bub * 0.9 + vec3(0.8, 1.0, 0.45) * rimL * 0.7 + vec3(1.0, 1.0, 0.85) * spec * 0.8 + vec3(0.4, 0.8, 0.3) * fres * 0.25;
      vec3 scorch = sCol * (0.5 + 0.5 * day);
      float a = acidA + scorchA * (1.0 - acidA);
      if (a < 0.01) discard;
      gl_FragColor = vec4((acid * acidA + scorch * scorchA * (1.0 - acidA)) / a, a * 0.96);
    }`;

  function build() {
    geo = new T.BufferGeometry();
    pos = new T.BufferAttribute(new Float32Array(SLOTS * VPS * 3), 3).setUsage(T.DynamicDrawUsage);
    aP = new T.BufferAttribute(new Float32Array(SLOTS * VPS * 4), 4);
    aV = new T.BufferAttribute(new Float32Array(SLOTS * VPS), 1).setUsage(T.DynamicDrawUsage);
    aS = new T.BufferAttribute(new Float32Array(SLOTS * VPS * 4), 4).setUsage(T.DynamicDrawUsage);
    const idx = new Uint16Array(SLOTS * IPS);
    let o = 0;
    for (let k = 0; k < SLOTS; k++) {
      const b = k * VPS, ring = (r, s) => b + 1 + r * NS + (s % NS);
      for (let s = 0; s < NS; s++) {
        idx[o++] = b;
        idx[o++] = ring(0, s);
        idx[o++] = ring(0, s + 1);
      }
      for (let r = 0; r < NR - 1; r++)
        for (let s = 0; s < NS; s++) {
          const a = ring(r, s), c = ring(r, s + 1), d = ring(r + 1, s), e = ring(r + 1, s + 1);
          idx[o++] = a;
          idx[o++] = d;
          idx[o++] = c;
          idx[o++] = c;
          idx[o++] = d;
          idx[o++] = e;
        }
      for (let tr = 0; tr < NTR; tr++)
        for (let i = 0; i < NT - 1; i++) {
          const a = b + VP + (tr * NT + i) * 2;
          idx[o++] = a;
          idx[o++] = a + 1;
          idx[o++] = a + 2;
          idx[o++] = a + 2;
          idx[o++] = a + 1;
          idx[o++] = a + 3;
        }
    }
    geo.setIndex(new T.BufferAttribute(idx, 1));
    geo.setAttribute('position', pos);
    geo.setAttribute('aP', aP);
    geo.setAttribute('aV', aV);
    geo.setAttribute('aS', aS);
    geo.setDrawRange(0, 0);
    const mat = new T.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, side: T.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      uniforms: {
        uTime: { value: 0 },
        uDay: { value: 1 },
        uSun: { value: new T.Vector3(0.4, 0.8, 0.4) },
        uCam: { value: new T.Vector3() },
        uO: SS.terrain.uniforms.uO,
        uN: SS.terrain.uniforms.uN
      } });
    mesh = new T.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    mesh.visible = false;
    scene.add(mesh);
  }

  /* ---------- fitting onto the world ---------- */
  const nrm = { x: 0, y: 0, z: 0 };
  // distance along (dx,dy,dz) from the origin to the first solid (density > 0) within L, or -1 (the origin itself solid
  // / nothing hit)
  function hit(ox, oy, oz, dx, dy, dz, L, st) {
    let prev = W.sample(ox, oy, oz);
    if (prev > 0) return -1;
    for (let t = st; t < L + st; t += st) {
      const v = W.sample(ox + dx * t, oy + dy * t, oz + dz * t);
      if (v > 0) return Math.max(0, t - st) + st * (-prev) / (v - prev);
      prev = v;
    }
    return -1;
  }
  function normalAt(x, y, z, out) {
    W.normal(x, y, z, nrm);
    out.x += nrm.x;
    out.y += nrm.y;
    out.z += nrm.z;
  }
  function slotWrite(r, k, x, y, z, f, a, kind, seed, valid) {
    const v = r.slot * VPS + k, p = v * 3;
    pos.array[p] = x;
    pos.array[p + 1] = y;
    pos.array[p + 2] = z;
    aV.array[v] = valid;
    if (f != null) {
      const q = v * 4;
      aP.array[q] = f;
      aP.array[q + 1] = a;
      aP.array[q + 2] = kind;
      aP.array[q + 3] = seed;
    }
  }
  function fit(r, s) {
    const sum = { x: 0, y: 0, z: 0 };
    let cy = s.y;
    const th = hit(s.x, s.y + 0.8, s.z, 0, -1, 0, 1.8, 0.1);
    if (th >= 0) cy = s.y + 0.8 - th;
    for (const [dx, dz] of [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) normalAt(s.x + dx, cy + 0.02, s.z + dz, sum);
    let nl = Math.hypot(sum.x, sum.y, sum.z) || 1;
    const n = { x: sum.x / nl, y: sum.y / nl, z: sum.z / nl };
    // downhill = gravity's tangential part; flat ground: any direction
    const gx = n.y * n.x, gy = -1 + n.y * n.y, gz = n.y * n.z;                            // g - n (g . n) with g = (0,-1,0): g . n = -n.y
    const sl = Math.min(1, Math.hypot(gx, gy, gz));
    let t1;
    if (sl > 0.06) t1 = { x: gx / sl, y: gy / sl, z: gz / sl };
    else {
      const d = n.x;
      t1 = { x: 1 - n.x * d, y: -n.y * d, z: -n.z * d };
      const l = Math.hypot(t1.x, t1.y, t1.z) || 1;
      t1.x /= l;
      t1.y /= l;
      t1.z /= l;
    }
    const t2 = { x: n.y * t1.z - n.z * t1.y, y: n.z * t1.x - n.x * t1.z, z: n.x * t1.y - n.y * t1.x };
    const Rm = Math.max(0.4, s.r * 1.9), seed = (r.id * 7.31) % 50, slEff = sl < 0.06 ? 0 : sl;
    r.rm = Rm;
    r.sl = slEff;
    r.cx = s.x;
    r.cy = cy;
    r.cz = s.z;
    r.nx = n.x;
    r.ny = n.y;
    r.nz = n.z;
    const put = (k, f, a, e) => {
      const dist = f * Rm * e, ca = Math.cos(a) * dist, sa = Math.sin(a) * dist;
      const ox = s.x + t1.x * ca + t2.x * sa, oy = cy + t1.y * ca + t2.y * sa, oz = s.z + t1.z * ca + t2.z * sa;
      const t = hit(ox + n.x * 0.9, oy + n.y * 0.9, oz + n.z * 0.9, -n.x, -n.y, -n.z, 1.7, 0.12);
      if (t < 0) slotWrite(r, k, ox, oy, oz, f, a, 0, seed, 0);
      else slotWrite(r, k, ox + n.x * (0.9 - t + NOFF), oy + n.y * (0.9 - t + NOFF), oz + n.z * (0.9 - t + NOFF), f, a, 0, seed, 1);
    };
    put(0, 0, 0, 1);
    for (let ri = 0; ri < NR; ri++)
      for (let si = 0; si < NS; si++) {
        const a = TAU * si / NS;
        put(1 + ri * NS + si, FR[ri], a, 1 + 0.6 * slEff * Math.max(0, Math.cos(a)));
      }
    // the trickles (1 or 2, different lengths): from the lower edge, down the surface, meandering with the micro-relief
    for (let i = 0; i < NTR * NT * 2; i++) slotWrite(r, VP + i, 0, 0, 0, 0, 0, 1, seed, 0);
    r.trick = 0;
    if (slEff > 0.26) {
      const hh = [
        (Math.sin(r.id * 12.9898) * 43758.5453) % 1,
        (Math.sin(r.id * 78.233) * 43758.5453) % 1,
        (Math.sin(r.id * 39.425) * 43758.5453) % 1
      ].map(v => Math.abs(v));
      const nt = hh[1] > 0.4 && slEff > 0.34 ? 2 : 1;
      for (let tr = 0; tr < nt; tr++) {
        const lat = tr === 0 ? (hh[0] - 0.5) * 0.5 : (hh[0] > 0.5 ? -1 : 1) * (0.5 + 0.4 * hh[2]),
          kmax = tr === 0 ? 6 + Math.floor(hh[2] * (NT - 6)) : 4 + Math.floor(hh[0] * (NT - 7)),
          sd = seed + tr * 3.7;
        const lx = t2.x * lat * Rm * 0.55, ly = t2.y * lat * Rm * 0.55, lz = t2.z * lat * Rm * 0.55, dd = Rm * 0.5 * (1 + 0.6 * slEff);
        let px = s.x + t1.x * dd + lx, py = cy + t1.y * dd + ly, pz = s.z + t1.z * dd + lz;
        const t0 = hit(px + n.x * 0.9, py + n.y * 0.9, pz + n.z * 0.9, -n.x, -n.y, -n.z, 1.7, 0.12);
        if (t0 < 0) continue;
        px += n.x * (0.9 - t0); py += n.y * (0.9 - t0); pz += n.z * (0.9 - t0);
        const W0 = 0.2 * (0.8 + 0.4 * hh[tr === 0 ? 2 : 0]), step = 0.15 + 0.24 * slEff, pts = [];
        for (let i = 0; i < kmax; i++) {
          const nn = { x: 0, y: 0, z: 0 };
          normalAt(px, py + 0.01, pz, nn);
          const l = Math.hypot(nn.x, nn.y, nn.z) || 1, cn = { x: nn.x / l, y: nn.y / l, z: nn.z / l };
          let dx = cn.y * cn.x, dy = -1 + cn.y * cn.y, dz = cn.y * cn.z;
          const dl = Math.hypot(dx, dy, dz);
          if (dl < 0.1) break;
          dx /= dl; dy /= dl; dz /= dl;
          let sx = cn.y * dz - cn.z * dy, sy = cn.z * dx - cn.x * dz, sz = cn.x * dy - cn.y * dx;
          pts.push([px + cn.x * NOFF, py + cn.y * NOFF, pz + cn.z * NOFF, sx, sy, sz]);
          const wob = 0.75 * (0.6 * Math.sin(i * 1.15 + sd) + 0.4 * Math.sin(i * 2.3 + sd * 2.1)),
            mx = dx + sx * wob,
            my = dy + sy * wob,
            mz = dz + sz * wob,
            ml = Math.hypot(mx, my, mz) || 1;
          const qx = px + mx / ml * step,
            qy = py + my / ml * step,
            qz = pz + mz / ml * step,
            th2 = hit(qx + cn.x * 0.35, qy + cn.y * 0.35, qz + cn.z * 0.35, -cn.x, -cn.y, -cn.z, 0.8, 0.1);
          if (th2 < 0) break;
          px = qx + cn.x * (0.35 - th2); py = qy + cn.y * (0.35 - th2); pz = qz + cn.z * (0.35 - th2);
        }
        const k = pts.length;
        if (k < 2) continue;
        for (let i = 0; i < k; i++) {
          const u = i / (k - 1),
            w = (W0 * Math.pow(1 - u, 0.85) + 0.025) * (1 + 0.25 * Math.sin(u * 9 + sd)),
            q = pts[i],
            b = tr * NT * 2 + i * 2;
          slotWrite(r, VP + b, q[0] - q[3] * w, q[1] - q[4] * w, q[2] - q[5] * w, u, -1, 1, sd, 1);
          slotWrite(r, VP + b + 1, q[0] + q[3] * w, q[1] + q[4] * w, q[2] + q[5] * w, u, 1, 1, sd, 1);
        }
        for (let i = k; i < NT; i++)
          for (let j = 0; j < 2; j++) {
            const v = r.slot * VPS + VP + tr * NT * 2 + (k - 1) * 2 + j, o = r.slot * VPS + VP + tr * NT * 2 + i * 2 + j;
            pos.array[o * 3] = pos.array[v * 3];
            pos.array[o * 3 + 1] = pos.array[v * 3 + 1];
            pos.array[o * 3 + 2] = pos.array[v * 3 + 2];
            aV.array[o] = 0;
          }
        r.trick += k;
      }
    }
    // probes: five rays down onto the ground; their hit distances now are what a later probe compares with
    r.probe = probeSet(s, n, r);
    aP.needsUpdate = true;
    pos.needsUpdate = true;
    aV.needsUpdate = true;
    r.dirty = false;
    r.fitR = s.r;
    nFit++;
  }
  function probeSet(s, n, r) {
    const out = [], rr = Math.max(0.3, s.r * 0.7);
    for (const [dx, dz] of [[0, 0], [rr, 0], [-rr, 0], [0, rr], [0, -rr]])
      out.push(hit(s.x + dx, r.cy + 0.6, s.z + dz, 0, -1, 0, 1.4, 0.15));
    return out;
  }
  function probeMoved(r, s) {
    const rr = Math.max(0.3, s.r * 0.7);
    let i = 0;
    for (const [dx, dz] of [[0, 0], [rr, 0], [-rr, 0], [0, rr], [0, -rr]]) {
      const t = hit(s.x + dx, r.cy + 0.6, s.z + dz, 0, -1, 0, 1.4, 0.15);
      if (Math.abs(t - r.probe[i++]) > 0.04) return true;
    }
    return false;
  }

  /* ---------- frame ---------- */
  function release(r) {
    const b = r.slot * VPS;
    for (let i = 0; i < VPS; i++) {
      const p = (b + i) * 3;
      pos.array[p] = pos.array[p + 1] = pos.array[p + 2] = 0;
      aV.array[b + i] = 0;
      aS.array[(b + i) * 4 + 1] = 0;
    }
    pos.needsUpdate = true;
    aV.needsUpdate = true;
    aS.needsUpdate = true;
    freeSlots.push(r.slot);
  }
  AV.init = function (sc) {
    scene = sc;
    for (let i = SLOTS - 1; i >= 0; i--) freeSlots.push(i);
    build();
  };
  AV.clear = function () {
    const gu = SS.grass && SS.grass.material() ? SS.grass.material().userData.uniforms.uAcid.value : null;
    if (gu)
      for (let i = 0; i < 8; i++) gu[i].w = 0;
    for (const r of recs.values()) release(r);
    recs.clear();
    if (mesh) mesh.visible = false;
    if (geo) geo.setDrawRange(0, 0);
    hiSlot = 0;
  };
  AV.frame = function (S, view, camera, dt) {
    if (!scene || !mesh) return;
    W = window.POC && POC.W;
    const wa = S.wa;
    if (!W || !wa || !wa.spots.length) {
      if (recs.size) AV.clear();
      return;
    }
    const t = view.time || 0, sun = view.look && view.look.sunDir ? view.look.sunDir : [-0.4, 0.7, 0.6], u = mesh.material.uniforms;
    u.uTime.value = t;
    u.uSun.value.set(sun[0], sun[1], sun[2]);
    u.uCam.value.copy(camera.position);
    u.uDay.value = Math.min(1, Math.max(0, sun[1] * 2.2));
    const seen = new Set(), dirty = [];
    let any = false, ng = 0;
    const gu = SS.grass && SS.grass.material() ? SS.grass.material().userData.uniforms.uAcid.value : null;
    for (const s of wa.spots) {
      if (!s.id) continue;
      seen.add(s.id);
      let r = recs.get(s.id);
      if (!r) {
        if (!freeSlots.length) continue;
        r = {
          id: s.id,
          slot: freeSlots.pop(),
          dirty: true,
          rm: 0,
          probe: [0, 0, 0, 0, 0],
          cy: s.y,
          fitR: 0,
          sl: 0,
          pt: t + Math.random() * 0.3
        };
        recs.set(s.id, r);
      }
      if (r.slot > hiSlot) hiSlot = r.slot;
      const shown = SS.view.shownAt(S, s, 0.8) || (view.insp || 0) > 0.05;
      const grow = 0.6 + 0.4 * Math.min(1, s.t / 0.6),
        fade = Math.min(1, s.t / 0.25, (s.life - s.t) / 1.0),
        vis = shown ? Math.max(0, Math.min(1, fade * 1.4)) : 0;
      const rim = (s.r * 1.05 * grow * (0.4 + 0.6 * Math.max(0, Math.min(1, fade * 1.4)))) / Math.max(0.01, r.rm || s.r * 1.9);
      if (r.rm && s.r * 1.2 > r.rm / 1.9 * 1.0 + 0.0 && s.r > r.fitR + 0.08) r.dirty = true;
      const b = r.slot * VPS * 4, a = aS.array, sl = r.sl, age = s.t;
      for (let i = 0; i < VPS; i++) {
        const q = b + i * 4;
        a[q] = rim;
        a[q + 1] = vis;
        a[q + 2] = sl;
        a[q + 3] = age;
      }
      any = true;
      if (gu && ng < 8 && shown) gu[ng++].set(s.x, s.z, s.r * 1.1 * grow * (1 + 0.5 * r.sl), vis);
      if (r.dirty) dirty.push([r, s]);
      else if (shown && t > r.pt) {
        r.pt = t + 0.3;
        if (r.cy !== undefined && probeMoved(r, s)) dirty.push([r, s]);
      }
      r.s = s;
    }
    if (gu)
      for (let i = ng; i < 8; i++) gu[i].w = 0;
    aS.needsUpdate = true;
    for (const [id, r] of recs)
      if (!seen.has(id)) {
        release(r);
        recs.delete(id);
      }
    let fits = 0;
    for (const [r, s] of dirty) {
      if (fits++ >= FITS) break;
      fit(r, s);
    }
    let hi = 0;
    for (const r of recs.values())
      if (r.slot > hi) hi = r.slot;
    hiSlot = hi;
    geo.setDrawRange(0, recs.size ? (hiSlot + 1) * IPS : 0); mesh.visible = recs.size > 0;
  };
  AV.stats = () => ({ puddles: recs.size, fits: nFit });
})(window.SS = window.SS || {});
