/* platform/audio.js — sound (P10): recorded samples where they exist (assets/sfx/manifest.js, docs/SOUND_PROMPTS.md;
 * AU.play / AU.voice), else the PoC's procedural WebAudio effects as the fallback; driven only by sim events (S.events
 * via render/view.js onEvent) and a per-frame ambient mix (rain, wind, fire, lava).
 * The AudioContext starts on the first key / pointer gesture (browser rule; headless tests stay silent). Thunder for
 * weather lightning stays in render/weather.js. Mute: the button / F2 (remembered). Not ported on purpose: the holy
 * grenade's choir (LEGAL.md: a recognisable cue), the car alarm and piano (no such props here).
 * API: unlock(), onEvent(S, e), frame(S), setMuted(m), muted. Math.random is fine here: presentation only. */
(function (SS) {
  'use strict';
  const AU = SS.audio = {};
  const TAU = Math.PI * 2, clamp = (v, a, b) => (v < a ? a : v > b ? b : v), rand = Math.random;
  let ctx = null, master = null, verbIn = null, muted = false, amb = null, charge = null, lastDrill = 0, lastOuch = 0, lastBounce = 0;
  const B = {};
  try { muted = localStorage.getItem('burrowBrawl3d.muted') === '1'; } catch (e) { /* private mode */ }
  function onePoleLP(a, k) { let y = 0; for (let i = 0; i < a.length; i++) { y += k * (a[i] - y); a[i] = y; } return a; }
  function onePoleHP(a, k) { let y = 0, px = 0; for (let i = 0; i < a.length; i++) { const x = a[i]; y = k * (y + x - px); px = x; a[i] = y; } return a; }
  function pink(n) { const o = new Float32Array(n); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; for (let i = 0; i < n; i++) { const w = rand() * 2 - 1; b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926; } return o; }
  function brown(n) { const o = new Float32Array(n); let l = 0; for (let i = 0; i < n; i++) { l = (l + 0.02 * (rand() * 2 - 1)) / 1.02; o[i] = l * 3.5; } return o; }
  function norm(chs, peak) { let m = 0; for (const c of chs) for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i])); if (m > 0) for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= peak / m; }
  function toBuf(L, R) { const b = ctx.createBuffer(2, L.length, ctx.sampleRate); b.copyToChannel(L, 0); b.copyToChannel(R || L, 1); return b; }
  function genRain(sec) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), L = onePoleHP(pink(n), 0.94), R = onePoleHP(pink(n), 0.94);
    for (let i = 0; i < n; i++) { L[i] *= 0.5; R[i] *= 0.5; }
    for (let d = 0; d < sec * 1800; d++) {
      const t0 = Math.floor(rand() * n), amp = 0.03 + Math.pow(rand(), 4) * 0.35, len = Math.floor(sr * (0.0008 + rand() * 0.003)), pan = rand();
      let hp = 0, px = 0;
      for (let k = 0; k < len; k++) { const x = (rand() * 2 - 1) * Math.exp(-k / (len * 0.3)); hp = 0.6 * (hp + x - px); px = x; const v = hp * amp, j = (t0 + k) % n; L[j] += v * (1 - pan); R[j] += v * pan; }
    }
    norm([L, R], 0.8); return toBuf(L, R);
  }
  function genWind(sec) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), L = brown(n), R = brown(n), p1 = rand() * TAU, p2 = rand() * TAU;
    let y1 = 0, y2 = 0; const w0 = TAU * 720 / sr, r = 0.995, c1 = 2 * r * Math.cos(w0), c2 = -r * r;
    for (let i = 0; i < n; i++) {
      const t = i / n, env = 0.55 + 0.3 * Math.sin(TAU * t + p1) + 0.15 * Math.sin(TAU * 3 * t + p2);
      const x = (rand() * 2 - 1) * 0.02, y = x + c1 * y1 + c2 * y2; y2 = y1; y1 = y;
      const whistle = y * env * env * 0.6; L[i] = L[i] * env + whistle; R[i] = R[i] * (1.1 - env * 0.2) + whistle * 0.7;
    }
    norm([L, R], 0.8); return toBuf(L, R);
  }
  function genFire(sec) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), L = onePoleLP(brown(n), 0.08), R = onePoleLP(brown(n), 0.08);
    for (let i = 0; i < n; i++) { L[i] *= 0.5; R[i] *= 0.5; }
    for (let c = 0; c < sec * 55; c++) {
      const t0 = Math.floor(rand() * n), amp = 0.2 + Math.pow(rand(), 3) * 0.9, len = Math.floor(sr * (0.0004 + rand() * 0.002)), pan = rand();
      for (let k = 0; k < len; k++) { const v = (rand() * 2 - 1) * amp * Math.exp(-k / (len * 0.25)), j = (t0 + k) % n; L[j] += v * (1 - pan); R[j] += v * pan; }
    }
    norm([L, R], 0.8); return toBuf(L, R);
  }
  function genBoom() {
    const sr = ctx.sampleRate, n = Math.floor(sr * 2.6), L = new Float32Array(n), R = new Float32Array(n);
    let lpL = 0, lpR = 0, ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, cut = 3200 * Math.exp(-t * 3.2) + 90, k = 1 - Math.exp(-TAU * cut / sr), env = (t < 0.004 ? t / 0.004 : 1) * Math.exp(-t / 0.55);
      lpL += k * ((rand() * 2 - 1) - lpL); lpR += k * ((rand() * 2 - 1) - lpR);
      const f = 52 * Math.exp(-t * 1.2) + 26; ph += TAU * f / sr; const sub = Math.sin(ph) * Math.exp(-t / 0.4) * 0.9;
      const crack = t < 0.012 ? (rand() * 2 - 1) * (1 - t / 0.012) * 1.2 : 0;
      L[i] = lpL * env * 2.4 + sub + crack; R[i] = lpR * env * 2.4 + sub + crack * 0.8;
    }
    for (let c = 0; c < 90; c++) {                             // gravel raining back down
      const t0 = Math.floor(sr * (0.15 + Math.pow(rand(), 1.5) * 1.6)), amp = 0.25 * (1 - t0 / n) * rand(), len = Math.floor(sr * 0.003), pan = rand();
      for (let k = 0; k < len && t0 + k < n; k++) { const v = (rand() * 2 - 1) * amp * Math.exp(-k / (len * 0.3)); L[t0 + k] += v * (1 - pan); R[t0 + k] += v * pan; }
    }
    norm([L, R], 0.95); return toBuf(L, R);
  }
  function genIR(sec) { const sr = ctx.sampleRate, n = Math.floor(sr * sec), L = new Float32Array(n), R = new Float32Array(n); for (let i = 0; i < n; i++) { const e = Math.pow(1 - i / n, 3); L[i] = (rand() * 2 - 1) * e; R[i] = (rand() * 2 - 1) * e; } onePoleLP(L, 0.25); onePoleLP(R, 0.25); return toBuf(L, R); }
  AU.unlock = function () {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.6;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4; master.connect(comp); comp.connect(ctx.destination);
    const verb = ctx.createConvolver(); verb.buffer = genIR(2.6); verbIn = ctx.createGain(); verbIn.gain.value = 0.35; verbIn.connect(verb); verb.connect(master);
    B.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); { const d = B.noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1; }
    setTimeout(() => {
      B.boom = [genBoom(), genBoom(), genBoom()];
      const loop = buf => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; const g = ctx.createGain(); g.gain.value = 0; s.connect(g); g.connect(master); s.start(); return g; };
      amb = { rain: loop(genRain(4)), wind: loop(genWind(8)), fire: loop(genFire(4)), lava: loop(genFire(3)) };
    }, 50);
  };
  // (iOS Safari unlocks audio only inside touchend / click handlers, not pointerdown)
  if (typeof addEventListener === 'function') for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) addEventListener(ev, () => AU.unlock(), { capture: true });
  const ok = () => ctx && !muted && ctx.state === 'running';
  function env(g, t, a, peak, dec) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec); }
  function out(pan, wet) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan || 0, -1, 1); p.connect(master); if (wet) { const s = ctx.createGain(); s.gain.value = wet; p.connect(s); s.connect(verbIn); } return p; }
  function noise(dur, type, f0, q, peak, f1, rate, delay, pan) {
    if (!ok()) return; const t = ctx.currentTime + (delay || 0);
    const s = ctx.createBufferSource(); s.buffer = B.noise; s.loop = true; s.playbackRate.value = rate || 1;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(f0, t); if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur); f.Q.value = q;
    const g = ctx.createGain(); env(g, t, 0.006, peak, dur);
    s.connect(f); f.connect(g); g.connect(pan ? out(pan) : master); s.start(t, rand() * 1.5); s.stop(t + dur + 0.1);
  }
  function tone(type, f0, f1, dur, peak, a, delay) {
    if (!ok()) return; const t = ctx.currentTime + (delay || 0); a = a || 0.005;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain(); env(g, t, a, peak, dur); o.connect(g); g.connect(master); o.start(t); o.stop(t + a + dur + 0.05);
  }
  function voice(f, dur, vib, formants, peak, delay, f1) {
    if (!ok()) return; const t = ctx.currentTime + (delay || 0);
    const o2 = ctx.createGain(); o2.gain.setValueAtTime(0.0001, t); o2.gain.exponentialRampToValueAtTime(peak, t + 0.04); o2.gain.setValueAtTime(peak, t + dur * 0.7); o2.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o2.connect(master);
    const fs = formants.map(([fr, q]) => { const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.frequency.value = fr; b.Q.value = q; b.connect(o2); return b; });
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.setValueAtTime(f, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const l = ctx.createOscillator(); l.frequency.value = vib[0]; const lg = ctx.createGain(); lg.gain.value = vib[1]; l.connect(lg); lg.connect(o.frequency);
    for (const b of fs) o.connect(b);
    o.start(t); l.start(t); o.stop(t + dur + 0.05); l.stop(t + dur + 0.05);
  }
  function playBuf(buf, gain, rate, pan, wet) { if (!ok() || !buf) return; const s = ctx.createBufferSource(); s.buffer = buf; s.playbackRate.value = rate; const g = ctx.createGain(); g.gain.value = gain; s.connect(g); g.connect(out(pan, wet)); s.start(); }
  // stereo pan / distance gain of a world point for the current camera
  function where(p) {
    const cam = SS.view && SS.view.camera && SS.view.camera(); if (!cam || !p) return { pan: 0, k: 1 };
    const e = cam.matrixWorld.elements, dx = p.x - cam.position.x, dy = p.y - cam.position.y, dz = p.z - cam.position.z;
    const right = dx * e[0] + dy * e[1] + dz * e[2], dist = Math.hypot(dx, dy, dz);
    return { pan: clamp(right / Math.max(4, dist), -0.9, 0.9), k: clamp(30 / (dist + 10), 0.25, 1.4) };
  }
  const SFX = {
    boom(Rpx, p) { const w = where(p); if (!B.boom) { noise(1.2, 'lowpass', 1800, 0.7, 0.8 * w.k, 70); return; } const s = clamp(Rpx / 60, 0.2, 2); playBuf(B.boom[(rand() * 3) | 0], Math.min(1.1, 0.35 + s * 0.45) * w.k, clamp(1.3 - Rpx / 140, 0.55, 1.35), w.pan, 0.5); },
    boomWater(Rpx) { const s = clamp(Rpx / 60, 0.2, 2); noise(1.4, 'lowpass', 420, 0.8, Math.min(0.9, 0.35 + s * 0.4), 60); tone('sine', 70, 34, 0.9, 0.35 * s); noise(0.9, 'bandpass', 1100, 0.7, 0.25 * s, 400, 1, 0.08); },
    crack(s) { noise(0.25, 'highpass', 900, 0.8, 0.25 + s * 0.4, 300); noise(0.8 + s, 'lowpass', 500, 0.6, 0.2 + s * 0.4, 60, 0.7, 0.05); },
    thud(s) { tone('sine', 80, 35, 0.3, Math.min(0.8, s * 0.6)); noise(0.3, 'lowpass', 600, 0.6, Math.min(0.6, s * 0.4), 100); },
    wood(v) { noise(0.12, 'bandpass', 700 + rand() * 300, 2, v * 0.6); tone('triangle', 190, 140, 0.12, v * 0.35); },
    metal(v) { const f = 180 + rand() * 260; [1, 2.76, 5.4, 8.9].forEach((m, i) => tone('sine', f * m, f * m * 0.995, 0.5 / (i + 1) + 0.1, v * 0.18 / (i * 0.6 + 1))); noise(0.06, 'highpass', 2500, 0.7, v * 0.4); },
    zap() { if (!ok()) return; const t = ctx.currentTime; for (const f of [90, 180, 271]) { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sawtooth'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.05, t + 0.01); for (let i = 0; i < 10; i++) g.gain.setValueAtTime(rand() * 0.06 + 0.005, t + i * 0.05); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6); o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.62); } noise(0.5, 'highpass', 3000, 0.5, 0.3); },
    hole() { tone('sine', 38, 90, 3, 0.5, 0.4); noise(3, 'bandpass', 200, 1.5, 0.3, 1600, 0.6); },
    torch() { const n = performance.now(); if (n - lastDrill < 70) return; lastDrill = n; noise(0.09, 'bandpass', 700 + rand() * 300, 0.7, 0.16); noise(0.06, 'highpass', 3500, 0.5, 0.05); },
    drill() { const n = performance.now(); if (n - lastDrill < 90) return; lastDrill = n; tone('square', 85 + rand() * 20, 70, 0.08, 0.08); noise(0.08, 'bandpass', 1200, 1, 0.18); },
    ouch() { const n = performance.now(); if (n - lastOuch < 250) return; lastOuch = n; voice(420 + rand() * 120, 0.22, [9, 15], [[750, 4], [1300, 5]], 0.22, 0, 300); },
    splash(s) { noise(0.5 + s * 0.3, 'bandpass', 900, 0.8, Math.min(0.7, 0.2 + s * 0.4), 300); tone('sine', 600, 1600, 0.05, 0.08 * s); },
    whoosh(s) { noise(0.6, 'bandpass', 400, 1.2, 0.3 * (s || 1), 2400); },
    bounce(s) { const n = performance.now(); if (n - lastBounce < 60) return; lastBounce = n; tone('triangle', 240 + rand() * 60, 160, 0.08, 0.15 * s + 0.04); },
    shotgun() { playBuf(B.boom && B.boom[0], 0.45, 2.4, 0, 0.3); noise(0.25, 'highpass', 1500, 0.5, 0.6, 400); tone('square', 140, 50, 0.1, 0.2); },
    launch(k) { if (k === 'rocket') noise(0.6, 'bandpass', 500, 1, 0.45, 2400); else if (k === 'boulder') { tone('sine', 120, 60, 0.25, 0.4); noise(0.3, 'lowpass', 500, 1, 0.4); } else { tone('sine', 300, 180, 0.15, 0.25); noise(0.15, 'bandpass', 900, 1, 0.2, 2000); } },
    jump() { voice(380, 0.14, [6, 8], [[700, 4], [1100, 5]], 0.12, 0, 520); },
    thwip() { tone('sine', 900, 200, 0.16, 0.25); noise(0.12, 'highpass', 3000, 0.7, 0.2); },
    clink() { tone('triangle', 1800, 1200, 0.08, 0.2); },
    bat() { noise(0.09, 'bandpass', 1800, 2.5, 0.7, 900); tone('triangle', 520, 180, 0.12, 0.35); tone('sine', 120, 60, 0.18, 0.4); },
    crunch(a) { const v = Math.min(0.5, 0.15 + (a || 0.1) * 2); noise(0.22, 'bandpass', 900, 0.9, v, 300); tone('square', 140, 60, 0.18, v * 0.4); noise(0.12, 'highpass', 2500, 0.6, v * 0.35); },
    clank() { tone('square', 180, 120, 0.25, 0.25); tone('triangle', 1200, 900, 0.3, 0.12); },
    beep() { tone('square', 1400, 1400, 0.08, 0.12); tone('square', 1400, 1400, 0.08, 0.12, 0.005, 0.14); },
    pickup() { [523, 659, 784, 1046].forEach((f, i) => tone('triangle', f, f, 0.12, 0.18, 0.005, i * 0.07)); },
    click() { tone('square', 700, 500, 0.03, 0.06); },
    teleport() {
      if (!ok()) return; const t = ctx.currentTime, D = 1.5;
      const bus = ctx.createGain(); bus.gain.setValueAtTime(0.0001, t); bus.gain.exponentialRampToValueAtTime(0.32, t + 0.35); bus.gain.setValueAtTime(0.32, t + D - 0.55); bus.gain.exponentialRampToValueAtTime(0.0001, t + D);
      const trem = ctx.createGain(); trem.gain.value = 0.55; const lfo = ctx.createOscillator(); lfo.frequency.value = 17; const lg = ctx.createGain(); lg.gain.value = 0.45; lfo.connect(lg); lg.connect(trem.gain);
      bus.connect(trem); trem.connect(master); const wet = ctx.createGain(); wet.gain.value = 0.7; trem.connect(wet); wet.connect(verbIn);
      for (const [f, v] of [[1180, 0.5], [1490, 0.38], [1770, 0.3], [2360, 0.22], [2950, 0.14], [3540, 0.1]]) { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.setValueAtTime(f * 0.97, t); o.frequency.linearRampToValueAtTime(f * 1.03, t + D); const g = ctx.createGain(); g.gain.value = v; o.connect(g); g.connect(bus); o.start(t); o.stop(t + D + 0.05); }
      lfo.start(t); lfo.stop(t + D + 0.05); noise(D, 'bandpass', 2500, 1.6, 0.08, 6500);
    },
    fuse() { noise(0.8, 'highpass', 4000, 0.5, 0.15); },
    plane() { if (!ok()) return; const t = ctx.currentTime, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain(); o.type = 'sawtooth'; o.frequency.setValueAtTime(64, t); o.frequency.linearRampToValueAtTime(78, t + 2.2); o.frequency.linearRampToValueAtTime(58, t + 4.5); f.type = 'lowpass'; f.frequency.value = 600; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.2, t + 1.8); g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5); o.connect(f); f.connect(g); g.connect(master); o.start(t); o.stop(t + 4.6); },
    baa() { voice(300 + rand() * 40, 0.6, [7, 28], [[900, 3], [1600, 4]], 0.5); },
    chirp() { const n = 2 + (rand() * 3 | 0), b = 500 + rand() * 400; for (let i = 0; i < n; i++) voice(b * (0.8 + rand() * 0.5), 0.07, [12, 10], [[800, 3], [1500, 4]], 0.07, i * 0.08, b * (0.7 + rand() * 0.6)); },
    fanfare() { [392, 523, 659, 784, 659, 784].forEach((f, i) => tone('triangle', f, f, i === 5 ? 0.6 : 0.15, 0.22, 0.005, i * 0.14)); },
    splat() { noise(0.35, 'lowpass', 1100, 1, 0.7, 180); noise(0.2, 'bandpass', 420, 3, 0.45, 160, 1, 0.03); tone('sine', 120, 50, 0.2, 0.4); },
    chargeStart() { if (!ok()) return; const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'triangle'; o.frequency.setValueAtTime(180, t); o.frequency.exponentialRampToValueAtTime(900, t + 1.2); g.gain.value = 0.07; o.connect(g); g.connect(master); o.start(t); o.stop(t + 1.3); charge = o; },
    chargeStop() { if (charge) { try { charge.stop(); } catch (e) { /* */ } charge = null; } }
  };
  AU.sfx = SFX;
  const ROCKETS = { bazooka: 1, homing: 1 };
  /* ---------- recorded / generated samples (assets/sfx/manifest.js, ids = docs/SOUND_PROMPTS.md) ----------
   * HTMLAudio (decodeAudioData needs fetch, which file:// forbids): a small pool per file; volume x master; pitch jitter
   * through playbackRate (preservesPitch off). play(id, vol, rate) -> true when a sample played; else the caller's
   * synthesised fallback runs. Worm voice lines (voice()) have no fallback: silent until their files exist. */
  const pools = {};
  AU.has = id => !!(SS.SFX_FILES && SS.SFX_FILES[id] && SS.SFX_FILES[id].length);
  AU.play = function (id, vol, rate) {
    if (!ctx || muted || !AU.has(id)) return false;
    const files = SS.SFX_FILES[id], f = files[(rand() * files.length) | 0], pool = pools[f] || (pools[f] = []);
    let el = pool.find(a => a.paused || a.ended);
    if (!el && pool.length < 6) { el = new Audio('assets/sfx/' + f); el.preload = 'auto'; pool.push(el); }
    if (!el) return true;
    try { el.preservesPitch = false; el.mozPreservesPitch = false; el.webkitPreservesPitch = false; } catch (e) { /* */ }
    el.volume = clamp((vol == null ? 1 : vol) * 0.85, 0, 1); el.playbackRate = clamp((rate || 1) * (0.94 + rand() * 0.12), 0.5, 2);
    el.currentTime = 0; const pr = el.play(); if (pr && pr.catch) pr.catch(() => { /* not allowed yet */ });
    return true;
  };
  const S2 = (id, vol, rate, fallback) => { if (!AU.play(id, vol, rate) && fallback) fallback(); };
  // worm voices: one character per team (the same lines pitched: 0.92 / 1.0 / 1.1 / 1.22), throttled per worm
  const VOICE_RATE = [0.92, 1.0, 1.1, 1.22], lastVoice = new Map();
  AU.voice = function (id, w, vol, minGap) {
    if (!w) return false;
    const t = ctx ? ctx.currentTime : 0, l = lastVoice.get(w.id) || -9;   // (by id: a replay restore replaces the worm objects)
    if (t - l < (minGap == null ? 0.6 : minGap)) return false;
    if (!AU.play(id, vol == null ? 0.9 : vol, VOICE_RATE[(w.team | 0) % 4])) return false;
    lastVoice.set(w.id, t); return true;
  };
  const hurtLine = e => e.why === 'a baseball bat' ? 'worm_bat_hit' : /fire|lava|oil|burn|hot/.test(e.why || '') ? 'worm_burn' : e.amount >= 25 ? 'worm_hurt_big' : 'worm_hurt_small';
  AU.onEvent = function (S, e) {
    if (!ctx) return;
    switch (e.type) {
      case 'explode': { const R = 44 * Math.cbrt(e.W || 1); S2(R > 60 ? 'explosion_large' : R > 30 ? 'explosion_medium' : 'explosion_small', clamp(R / 60, 0.4, 1), 1, () => SFX.boom(R, e));
        // a gasp from the worm on turn when a blast goes off close to it
        const a = S.active; if (a && !a.dead && Math.hypot(a.pos.x - e.x, a.pos.y - e.y, a.pos.z - e.z) < 7) AU.voice('worm_flinch', a, 0.7, 1.5); break; }
      case 'waterblast': S2('explosion_water', 1, 1, () => SFX.boomWater(44 * Math.cbrt(e.W || 1))); break;
      case 'fire': S2(ROCKETS[e.weapon] ? 'launch_rocket' : 'launch_throw', 0.9, 1, () => SFX.launch(ROCKETS[e.weapon] ? 'rocket' : 'thrown')); if (rand() < 0.35) AU.voice('worm_attack', S.active, 0.8); break;
      case 'use': if (e.weapon === 'boulder') S2('launch_boulder', 1, 1, () => SFX.launch('boulder')); else if (e.weapon === 'skip') { S2('ui_click', 0.6, 1, () => SFX.click()); AU.voice('worm_skip', S.active, 0.8); } break;
      case 'bounce': S2('bounce_metal', clamp((e.speed || 3) / 10, 0.1, 1), 1, () => SFX.bounce(clamp((e.speed || 3) / 10, 0.1, 1))); break;
      case 'splash': S2(e.size > 0.9 ? 'splash_big' : 'splash_small', Math.min(1, e.size || 0.6), 1, () => SFX.splash(Math.min(1.5, e.size || 0.6))); break;
      case 'hurt': if (!AU.voice(hurtLine(e), e.worm, 1, 0.35) && !AU.has(hurtLine(e))) SFX.ouch(); break;   // (the synth only when there is no recording, not when the voice is merely throttled)
      case 'jump': S2('worm_jump_whoosh', 0.6, 1, () => SFX.jump()); AU.voice('worm_jump', S.active, 0.7, 0.4); break;
      case 'salto': AU.voice('worm_salto', e.worm || S.active, 0.9, 0.3); break;
      case 'dizzy': AU.voice('worm_dizzy', e.worm, 0.9, 0.5); break;
      case 'drown': AU.voice('worm_drown', e.worm, 1, 0.2); S2('splash_big', 0.8, 1, null); break;
      case 'wash': AU.voice('worm_wash', e.worm, 0.9); S2('wave_wash', 0.9, 1, null); break;
      case 'switch': AU.voice('worm_select', e.worm, 0.9, 0.2); break;
      case 'rope_fire': S2('rope_fire', 0.7, 1, () => SFX.thwip()); break;
      case 'rope_hook': S2('rope_hook', 0.8, 1, () => SFX.clink()); break;
      case 'zap': S2('electric_zap', 0.9, 1, () => SFX.zap()); break;
      case 'hole': S2('blackhole_open', 1, 1, () => SFX.hole()); break;
      case 'teleport': S2('teleport_beam', 0.9, 1, () => SFX.teleport()); AU.voice('worm_teleport', e.worm, 0.8, 0.2); break;
      case 'plane': S2('airstrike_plane', 1, 1, () => SFX.plane()); break;
      case 'baa': S2('sheep_baa', 0.9, 1, () => SFX.baa()); break;
      case 'swing': if (e.hit) S2('bat_hit', 1, 1, () => SFX.bat()); else S2('swing_whoosh', 0.8, 1, () => SFX.whoosh(0.8)); break;
      case 'shot': if (e.from) S2(e.weapon === 'sniper' ? 'sniper_shot' : 'shotgun_shot', 1, 1, () => SFX.shotgun()); break;
      case 'sparks': if (e.mode === 'drill') S2('drill_loop', 0.7, 1, () => SFX.drill()); else S2('torch_loop', 0.7, 1, () => SFX.torch()); break;
      case 'girder': S2('girder_place', 1, 1, () => SFX.clank()); break;
      case 'pickup': S2('crate_pickup', 0.9, 1, () => SFX.pickup()); AU.voice('worm_pickup', S.active, 0.9, 0.2); break;
      case 'fuse': S2('fuse_tick', 0.6, 1, () => SFX.fuse()); break;
      case 'minearm': S2('mine_beep', 0.8, 1, () => SFX.beep()); break;
      case 'propbreak': S2(e.kind === 'barrel' ? 'metal_crunch' : 'wood_break', 0.8, 1, () => SFX.wood(0.7)); break;
      case 'collapse': S2('rock_collapse', Math.min(1, (e.pieces || 1) / 4), 1, () => SFX.crack(Math.min(1, (e.pieces || 1) / 4))); break;
      case 'land': if ((e.speed || 0) > 5) { S2(e.hard ? 'worm_land_hard_thud' : 'worm_land_thud', Math.min(1, e.speed / 12), 1, () => SFX.thud(Math.min(1, e.speed / 12))); if (e.hard) AU.voice('worm_land_hard', e.worm, 1, 0.3); } break;
      case 'bodyhit': S2('body_hit', 0.4, 1, () => SFX.crunch(0.15)); break;
      case 'gameover': S2('fanfare_win', 1, 1, () => SFX.fanfare()); { const w = S.worms.find(o => !o.dead); if (w) AU.voice('worm_victory', w, 1, 0); } break;
      case 'turn': S2('turn_start', 0.7, 1, () => SFX.chirp()); AU.voice('worm_turn_start', e.worm || S.active, 0.85, 0); break;
      case 'foam': S2('foam_grow', 0.8, 1, () => SFX.whoosh(0.7)); break;
      case 'blow': S2('bellows_blow', 0.8, 1, () => SFX.whoosh(0.7)); break;
      case 'spring': S2('spring_launch', 1, 1, () => SFX.bounce(1)); AU.voice('worm_fall_scream', e.worm, 1, 0); break;
      case 'scramble': S2('scrambler_buzz', 0.8, 1, () => SFX.click()); break;
      case 'shatter': S2('ice_shatter', 0.8, 1, () => SFX.crunch(0.4)); break;
      case 'steelcut': S2('metal_cut', 0.8, 1, () => SFX.metal(0.8)); break;
      case 'airburst': S2('explosion_air', 0.9, 1, () => SFX.boom(20, e)); break;
      case 'gib': S2('gib_splat', 1, 1, () => SFX.splat()); break;
      case 'dying': if (!AU.voice('worm_dying', e.worm, 1, 0) && !AU.has('worm_dying')) SFX.ouch(); break;
      case 'lavaplop': S2('lava_plop', 0.8, 1, null); break;
      case 'steam': S2('steam_hiss', Math.min(1, e.power || 0.5), 1, null); break;
      case 'icebreak': S2('ice_crack', 0.9, 1, () => SFX.crunch(0.4)); break;
      case 'bridgefall': S2('bridge_fall', 1, 1, () => SFX.crack(1)); break;
      case 'treebreak': case 'treeshatter': S2('tree_crack', 0.9, 1, () => SFX.wood(0.9)); break;
      case 'holy': S2('holy_orb_burst', 1, 1, null); break;
      case 'lightning': S2('lightning_crack', 1, 1, null); break;
      case 'moai': S2('moai_whoosh', 1, 1, () => SFX.whoosh(1)); break;
      case 'lavabreach': S2('lava_breach', 1, 1, null); break;
      case 'oilfire': case 'propfire': case 'grassfire': case 'treefire': S2('fire_ignite', 0.7, 1, null); break;
    }
  };
  // looping ambient samples: one <audio loop> per id, its volume eased toward the wanted level
  const loops = {};
  function ambLoop(id, lvl) {
    if (!AU.has(id)) return false;
    let el = loops[id];
    if (!el) { el = loops[id] = new Audio('assets/sfx/' + SS.SFX_FILES[id][0]); el.loop = true; el.volume = 0; }
    const want = muted ? 0 : clamp(lvl, 0, 1) * 0.6;
    el.volume += (want - el.volume) * 0.05;
    if (el.volume > 0.005 && el.paused) { const pr = el.play(); if (pr && pr.catch) pr.catch(() => { /* */ }); } else if (el.volume <= 0.005 && !el.paused) el.pause();
    return true;
  }
  let wasCharging = false;
  const screamed = new WeakSet();   // (audio state stays off the sim objects)
  AU.frame = function (S) {
    if (!ctx) return;
    if (S.charging && !wasCharging) { if (!AU.play('charge_power', 0.7)) SFX.chargeStart(); } else if (!S.charging && wasCharging) SFX.chargeStop();
    wasCharging = !!S.charging;
    // a worm falling fast screams once per fall (the scared face in render/actors.js)
    for (const w of S.worms) {
      if (w.dead) continue;
      const vy = w === S.active ? (w.air ? w.vy : 0) : (!w.rest && w.vel ? w.vel.y : 0);
      if (vy < -12 && !screamed.has(w)) { screamed.add(w); AU.voice('worm_fall_scream', w, 1, 0.5); } else if (vy > -2) screamed.delete(w);
    }
    if (!amb) return;
    const t = ctx.currentTime, we = S.weather, w = S.wind && !SS.world.under ? Math.hypot(S.wind.mean.x, S.wind.mean.z) : 0;
    const rain = we ? Math.min(1, (we.rain || 0) * 1.4) : 0, fire = Math.min(1, ((S.flames && S.flames.length) || 0) / 6 + (SS.veg && SS.veg.burning ? Math.min(1, SS.veg.burning(S) / 40) : 0));
    const lava = S.biome === 'volcanic' && !SS.world.under ? 0.6 : 0;
    // ambient beds: a looping sample (amb_*) replaces the synthesised loop when it exists
    const sea = SS.world.dry || SS.world.under ? 0 : 0.5;
    const bed = (id, synth, lvl, k) => { if (ambLoop(id, lvl)) synth.gain.setTargetAtTime(0, t, 0.3); else synth.gain.setTargetAtTime(lvl * k, t, 0.6); };
    bed('amb_rain', amb.rain, rain, 0.42); bed('amb_wind', amb.wind, Math.min(1, w / 14), 0.3); bed('amb_fire', amb.fire, fire, 0.35); bed('amb_lava', amb.lava, lava, 0.3);
    ambLoop('amb_sea_surf', sea);
  };
  AU.setMuted = function (m) { muted = !!m; if (master) master.gain.value = muted ? 0 : 0.6; try { localStorage.setItem('burrowBrawl3d.muted', muted ? '1' : '0'); } catch (e) { /* */ } };
  Object.defineProperty(AU, 'muted', { get: () => muted });
})(window.SS = window.SS || {});
