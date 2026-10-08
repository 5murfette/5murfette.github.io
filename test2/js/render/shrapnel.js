/* render/shrapnel.js — luminous casing shrapnel (Step X2; Three.js specific). Draws the sim's S.frags as white-hot
 * streaks and the 'frag' stops as glowing embers that cool; 100 % procedural (no textures):
 *   - streak per flying fragment: a camera-facing ribbon from the fragment back along its velocity (length
 *     |v|·SHUTTER, ≤ STREAK_MAX, never behind the blast point), ≥ MIN_PX pixels wide; colour = black-body ramp of its
 *     heat (cools over COOL s), bright head, fading tail;
 *   - afterglow trail: the fragment's path (blast point, its position at each frame, its stop point) drawn as
 *     ribbons tapering toward the blast end that fade over TRAIL_T s (eye persistence: at ~800 m/s a fragment crosses the
 *     view in ~2 frames);
 *   - ricochet sparks where a fragment strikes rock / a body (render-only, not sim state): 1-3 glowing bits thrown
 *     back off the surface at 4-16 m/s, falling, cooling over 0.25-0.7 s, drawn as short streaks;
 *   - ember where a fragment stopped in rock / a body (heat 0.85 -> 0 over EMBER_T s, a short flash first), hidden in
 *     front of slice zero (no terrain is drawn there); a worm hit gives a brief orange-red flash.
 * One dynamic geometry (quads), additive, no depth write, no fog. API: init(scene), clear(), onEvent(S, e),
 * frame(S, view, camera), stats(). */
(function (SS) {
  'use strict';
  const T = window.THREE;
  const SV = SS.shrapView = {};
  const MAXQ = 2048, SHUTTER = 0.035, STREAK_MAX = 9, MIN_PX = 3.2, COOL = 0.9, EMBER_T = 1.6, EMBER_R = 0.06, TRAIL_T = 0.2, TRAIL_N = 8;
  let mesh = null, geo = null, pos, uvh, n = 0, embers = [], sparks = [], pxScale = 1000, now = 0;
  const trails = new Map();                       // fragment id -> { p: [[x, y, z, t]...], h, dead }
  const VS = /* glsl */`
    attribute vec4 aUVH;            // u along (0 tail .. 1 head), v across (-1 .. 1), heat 0..1, kind (0 streak, 1 ember)
    varying vec4 vUVH;
    void main(){ vUVH = aUVH; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const FS = /* glsl */`
    varying vec4 vUVH;
    // black-body-like ramp: dull red -> orange -> yellow -> white, intensity grows with heat (linear, HDR > 1)
    vec3 bb(float h){
      vec3 c = mix(vec3(0.55, 0.06, 0.01), vec3(1.0, 0.35, 0.05), smoothstep(0.0, 0.4, h));
      c = mix(c, vec3(1.0, 0.75, 0.3), smoothstep(0.35, 0.7, h));
      c = mix(c, vec3(1.0, 0.95, 0.85), smoothstep(0.7, 1.0, h));
      return c * (0.4 + 5.0 * h * h);
    }
    void main(){
      float u = vUVH.x, v = vUVH.y, h = vUVH.z, a;
      if (vUVH.w < 0.5) a = exp(-v * v * 2.2) * pow(u, 1.6);                  // streak: bright head, fading tail
      else { float r2 = u * u + v * v; if (r2 > 1.0) discard; a = exp(-r2 * 4.0); }   // ember: round glow
      gl_FragColor = vec4(bb(h) * a, 1.0);
    }`;

  SV.init = function (scene) {
    geo = new T.BufferGeometry();
    pos = new Float32Array(MAXQ * 4 * 3); uvh = new Float32Array(MAXQ * 4 * 4);
    const idx = new Uint32Array(MAXQ * 6);
    for (let q = 0; q < MAXQ; q++) { const v = q * 4; idx.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], q * 6); }
    geo.setAttribute('position', new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
    geo.setAttribute('aUVH', new T.BufferAttribute(uvh, 4).setUsage(T.DynamicDrawUsage));
    geo.setIndex(new T.BufferAttribute(idx, 1));
    // DoubleSide: ribbon quads (a − s, a + s, b − s, b + s with s = d × view) wind clockwise as seen from the camera
    // (face normal ∝ |d|²·v − (d·v)·d points away), FrontSide culled every streak / trail / spark
    const mat = new T.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, transparent: true, depthWrite: false, blending: T.AdditiveBlending, fog: false, side: T.DoubleSide });
    mesh = new T.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 9; mesh.visible = false;
    scene.add(mesh);
  };
  SV.clear = function () { embers = []; sparks = []; trails.clear(); n = 0; if (mesh) mesh.visible = false; };
  SV.onEvent = function (S, e) {
    if (e.type !== 'frag') return;
    // close (or make, for one stopped between two frames) the fragment's afterglow trail at its stop point
    let tr = trails.get(e.id);
    if (!tr) { tr = { p: [[e.ox, e.oy, e.oz, now - 0.001]], h: Math.exp(-(e.age || 0) / COOL), dead: false }; trails.set(e.id, tr); }
    tr.p.push([e.x, e.y, e.z, now]); tr.dead = true;
    const sp = Math.hypot(e.vx, e.vy, e.vz) || 1, dx = e.vx / sp, dy = e.vy / sp, dz = e.vz / sp;
    if ((e.kind === 'rock' || e.kind === 'body') && sparks.length < 300) {
      // ricochet: thrown back off the surface (mirror of the incoming direction about a random-ish normal), slow
      const m = 1 + (Math.random() * 2.4 | 0);
      for (let k = 0; k < m; k++) {
        let rx = -dx + (Math.random() - 0.5) * 1.4, ry = -dy + Math.random() * 0.9, rz = -dz + (Math.random() - 0.5) * 1.4; const rl = Math.hypot(rx, ry, rz) || 1;
        const v = 4 + Math.random() * 12;
        sparks.push({ x: e.x - dx * 0.05, y: e.y - dy * 0.05, z: e.z - dz * 0.05, vx: rx / rl * v, vy: ry / rl * v, vz: rz / rl * v, t: 0, life: 0.25 + Math.random() * 0.45 });
      }
    }
    if (e.kind === 'rock' || e.kind === 'body') embers.push({ x: e.x - dx * 0.03, y: e.y - dy * 0.03, z: e.z - dz * 0.03, t: 0, life: EMBER_T * (0.7 + 0.6 * Math.random()), h0: 0.8 + 0.2 * Math.random(), r: EMBER_R });
    else if (e.kind === 'worm') embers.push({ x: e.x, y: e.y, z: e.z, t: 0, life: 0.25, h0: 0.55, r: 0.16 });
    if (embers.length > 400) embers.splice(0, embers.length - 400);
  };
  const cam = new T.Vector3();
  const wOf = (x, y, z) => Math.max(0.018, MIN_PX * 0.5 * Math.hypot(x - cam.x, y - cam.y, z - cam.z) / pxScale);   // half width (m)
  // one camera-facing quad from a (tail) to b (head); half width from each end's distance to the camera (a ribbon
  // reaching toward the camera stays >= MIN_PX at both ends); u = ua at a .. ub at b (shader: brightness u^1.6)
  function ribbon(ax, ay, az, bx, by, bz, wk, h, ua, ub) {
    if (n >= MAXQ) return;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const vx = (ax + bx) * 0.5 - cam.x, vy = (ay + by) * 0.5 - cam.y, vz = (az + bz) * 0.5 - cam.z;
    let sx = dy * vz - dz * vy, sy = dz * vx - dx * vz, sz = dx * vy - dy * vx; const sl = Math.hypot(sx, sy, sz);
    if (sl < 1e-9) return;
    const wa = wk * wOf(ax, ay, az) / sl, wb = wk * wOf(bx, by, bz) / sl;
    const o = n * 12, p = n * 16;
    pos[o] = ax - sx * wa; pos[o + 1] = ay - sy * wa; pos[o + 2] = az - sz * wa; pos[o + 3] = ax + sx * wa; pos[o + 4] = ay + sy * wa; pos[o + 5] = az + sz * wa;
    pos[o + 6] = bx - sx * wb; pos[o + 7] = by - sy * wb; pos[o + 8] = bz - sz * wb; pos[o + 9] = bx + sx * wb; pos[o + 10] = by + sy * wb; pos[o + 11] = bz + sz * wb;
    uvh.set([ua, -1, h, 0, ua, 1, h, 0, ub, -1, h, 0, ub, 1, h, 0], p);
    n++;
  }
  // camera-facing square of half size r at (x, y, z); u, v = -1..1
  const rgt = new T.Vector3(), up = new T.Vector3();
  function blob(x, y, z, r, h) {
    if (n >= MAXQ) return;
    const o = n * 12, p = n * 16, rx = rgt.x * r, ry = rgt.y * r, rz = rgt.z * r, ux = up.x * r, uy = up.y * r, uz = up.z * r;
    pos[o] = x - rx - ux; pos[o + 1] = y - ry - uy; pos[o + 2] = z - rz - uz; pos[o + 3] = x + rx - ux; pos[o + 4] = y + ry - uy; pos[o + 5] = z + rz - uz;
    pos[o + 6] = x - rx + ux; pos[o + 7] = y - ry + uy; pos[o + 8] = z - rz + uz; pos[o + 9] = x + rx + ux; pos[o + 10] = y + ry + uy; pos[o + 11] = z + rz + uz;
    uvh.set([-1, -1, h, 1, 1, -1, h, 1, -1, 1, h, 1, 1, 1, h, 1], p);
    n++;
  }
  SV.frame = function (S, view, camera, dt) {
    if (!mesh) return;
    n = 0;
    cam.copy(camera.position); rgt.setFromMatrixColumn(camera.matrixWorld, 0); up.setFromMatrixColumn(camera.matrixWorld, 1);
    pxScale = view.pxScale || pxScale; now = view.time;
    const F = S.frags || [];
    for (const f of F) {
      const sp = Math.hypot(f.vx, f.vy, f.vz); if (sp < 1) continue;
      const h = Math.exp(-f.age / COOL);
      let tr = trails.get(f.id);
      if (!tr) { tr = { p: [[f.ox, f.oy, f.oz, now - 0.001]], h, dead: false }; trails.set(f.id, tr); }
      const l = tr.p[tr.p.length - 1];
      if (l[0] !== f.x || l[1] !== f.y || l[2] !== f.z) { tr.p.push([f.x, f.y, f.z, now]); if (tr.p.length > TRAIL_N) tr.p.shift(); }
      tr.h = h;
      const back = Math.min(sp * SHUTTER, STREAK_MAX, Math.hypot(f.x - f.ox, f.y - f.oy, f.z - f.oz));
      const ax = f.x - f.vx / sp * back, ay = f.y - f.vy / sp * back, az = f.z - f.vz / sp * back;
      ribbon(ax, ay, az, f.x, f.y, f.z, 1, h, 0, 1);
    }
    // afterglow trails: each path segment fades with the age of its newer end; along the path the brightness tapers
    // from the head (u 1) back to the oldest point (u 0.45: the eye's persistence of the earlier part has decayed)
    for (const [id, tr] of trails) {
      const P = tr.p, last = P[P.length - 1];
      if (now - last[3] > TRAIL_T * 4) { trails.delete(id); continue; }
      let L = 0; for (let i = 0; i + 1 < P.length; i++) L += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1], P[i + 1][2] - P[i][2]);
      let s = 0;
      for (let i = 0; i + 1 < P.length; i++) {
        const a = P[i], b = P[i + 1], k = Math.exp(-(now - b[3]) / TRAIL_T), ds = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        const ua = 0.45 + 0.55 * (L > 0 ? s / L : 1); s += ds; const ub = 0.45 + 0.55 * (L > 0 ? s / L : 1);
        if (k < 0.04) continue;
        ribbon(a[0], a[1], a[2], b[0], b[1], b[2], 0.8, tr.h * k * 0.8, ua, ub);
      }
    }
    // ricochet sparks: ballistic, cooling (render-only)
    const ddt = dt || 0;
    for (let i = sparks.length - 1; i >= 0; i--) {
      const q = sparks[i]; q.t += ddt;
      if (q.t >= q.life) { sparks.splice(i, 1); continue; }
      q.vy -= 9.81 * ddt; q.x += q.vx * ddt; q.y += q.vy * ddt; q.z += q.vz * ddt;
      const sp = Math.hypot(q.vx, q.vy, q.vz) || 1, L = Math.min(0.6, sp * 0.03), k = 1 - q.t / q.life;
      ribbon(q.x - q.vx / sp * L, q.y - q.vy / sp * L, q.z - q.vz / sp * L, q.x, q.y, q.z, 0.7, 0.95 * k * k, 0, 1);
    }
    // embers: cool and fade; hidden in front of slice zero (that terrain is not drawn)
    const nx = -Math.sin(S.theta), nz = Math.cos(S.theta);
    for (let i = embers.length - 1; i >= 0; i--) {
      const e = embers[i]; e.t += dt || 0;
      if (e.t >= e.life) { embers.splice(i, 1); continue; }
      if ((e.x - S.O.x) * nx + (e.z - S.O.z) * nz > 0.05 && view.insp < 0.5) continue;
      const k = e.t / e.life, h = e.h0 * (1 - k) * (1 - k) + (e.t < 0.06 ? 0.25 : 0);
      const d = Math.hypot(e.x - cam.x, e.y - cam.y, e.z - cam.z), r = Math.max(e.r * (1 + (e.t < 0.06 ? 1.5 : 0)), MIN_PX * d / pxScale);
      blob(e.x, e.y, e.z, r, h);
    }
    geo.setDrawRange(0, n * 6);
    geo.attributes.position.needsUpdate = true; geo.attributes.aUVH.needsUpdate = true;
    mesh.visible = n > 0;
  };
  SV.stats = () => ({ quads: n, embers: embers.length, trails: trails.size, sparks: sparks.length });
  SV.mesh = () => mesh;                           // (tools)
})(window.SS = window.SS || {});
