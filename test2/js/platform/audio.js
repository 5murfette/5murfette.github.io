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
  const AM = SS.amedia || null;
  let meter = null,
    ctx = null,
    master = null,
    verbIn = null,
    muted = false,
    amb = null,
    charge = null,
    lastDrill = 0,
    lastOuch = 0,
    lastBounce = 0;
  const B = {};
  try {
    muted = localStorage.getItem('burrowBrawl3d.muted') === '1';
  } catch (e) { /* private mode */ }
  function onePoleLP(a, k) {
    let y = 0;
    for (let i = 0; i < a.length; i++) {
      y += k * (a[i] - y);
      a[i] = y;
    }
    return a;
  }
  function onePoleHP(a, k) {
    let y = 0, px = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i];
      y = k * (y + x - px);
      px = x;
      a[i] = y;
    }
    return a;
  }
  function pink(n) {
    const o = new Float32Array(n);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rand() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      o[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    return o;
  }
  function brown(n) {
    const o = new Float32Array(n);
    let l = 0;
    for (let i = 0; i < n; i++) {
      l = (l + 0.02 * (rand() * 2 - 1)) / 1.02;
      o[i] = l * 3.5;
    }
    return o;
  }
  function norm(chs, peak) {
    let m = 0;
    for (const c of chs)
      for (let i = 0; i < c.length; i++) m = Math.max(m, Math.abs(c[i]));
    if (m > 0)
      for (const c of chs)
        for (let i = 0; i < c.length; i++) c[i] *= peak / m;
  }
  function toBuf(L, R) {
    const b = ctx.createBuffer(2, L.length, ctx.sampleRate);
    b.copyToChannel(L, 0);
    b.copyToChannel(R || L, 1);
    return b;
  }
  function genRain(sec) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), L = onePoleHP(pink(n), 0.94), R = onePoleHP(pink(n), 0.94);
    for (let i = 0; i < n; i++) {
      L[i] *= 0.5;
      R[i] *= 0.5;
    }
    for (let d = 0; d < sec * 1800; d++) {
      const t0 = Math.floor(rand() * n),
        amp = 0.03 + Math.pow(rand(), 4) * 0.35,
        len = Math.floor(sr * (0.0008 + rand() * 0.003)),
        pan = rand();
      let hp = 0, px = 0;
      for (let k = 0; k < len; k++) {
        const x = (rand() * 2 - 1) * Math.exp(-k / (len * 0.3));
        hp = 0.6 * (hp + x - px);
        px = x;
        const v = hp * amp, j = (t0 + k) % n;
        L[j] += v * (1 - pan);
        R[j] += v * pan;
      }
    }
    norm([L, R], 0.8); return toBuf(L, R);
  }
  function genWind(sec) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), L = brown(n), R = brown(n), p1 = rand() * TAU, p2 = rand() * TAU;
    let y1 = 0, y2 = 0;
    const w0 = TAU * 720 / sr, r = 0.995, c1 = 2 * r * Math.cos(w0), c2 = -r * r;
    for (let i = 0; i < n; i++) {
      const t = i / n, env = 0.55 + 0.3 * Math.sin(TAU * t + p1) + 0.15 * Math.sin(TAU * 3 * t + p2);
      const x = (rand() * 2 - 1) * 0.02, y = x + c1 * y1 + c2 * y2;
      y2 = y1;
      y1 = y;
      const whistle = y * env * env * 0.6;
      L[i] = L[i] * env + whistle;
      R[i] = R[i] * (1.1 - env * 0.2) + whistle * 0.7;
    }
    norm([L, R], 0.8); return toBuf(L, R);
  }
  function genFire(sec) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), L = onePoleLP(brown(n), 0.08), R = onePoleLP(brown(n), 0.08);
    for (let i = 0; i < n; i++) {
      L[i] *= 0.5;
      R[i] *= 0.5;
    }
    for (let c = 0; c < sec * 55; c++) {
      const t0 = Math.floor(rand() * n),
        amp = 0.2 + Math.pow(rand(), 3) * 0.9,
        len = Math.floor(sr * (0.0004 + rand() * 0.002)),
        pan = rand();
      for (let k = 0; k < len; k++) {
        const v = (rand() * 2 - 1) * amp * Math.exp(-k / (len * 0.25)), j = (t0 + k) % n;
        L[j] += v * (1 - pan);
        R[j] += v * pan;
      }
    }
    norm([L, R], 0.8); return toBuf(L, R);
  }
  function genBoom() {
    const sr = ctx.sampleRate, n = Math.floor(sr * 2.6), L = new Float32Array(n), R = new Float32Array(n);
    let lpL = 0, lpR = 0, ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr,
        cut = 3200 * Math.exp(-t * 3.2) + 90,
        k = 1 - Math.exp(-TAU * cut / sr),
        env = (t < 0.004 ? t / 0.004 : 1) * Math.exp(-t / 0.55);
      lpL += k * ((rand() * 2 - 1) - lpL); lpR += k * ((rand() * 2 - 1) - lpR);
      const f = 52 * Math.exp(-t * 1.2) + 26;
      ph += TAU * f / sr;
      const sub = Math.sin(ph) * Math.exp(-t / 0.4) * 0.9;
      const crack = t < 0.012 ? (rand() * 2 - 1) * (1 - t / 0.012) * 1.2 : 0;
      L[i] = lpL * env * 2.4 + sub + crack; R[i] = lpR * env * 2.4 + sub + crack * 0.8;
    }
    for (let c = 0; c < 90; c++) {                             // gravel raining back down
      const t0 = Math.floor(sr * (0.15 + Math.pow(rand(), 1.5) * 1.6)),
        amp = 0.25 * (1 - t0 / n) * rand(),
        len = Math.floor(sr * 0.003),
        pan = rand();
      for (let k = 0; k < len && t0 + k < n; k++) {
        const v = (rand() * 2 - 1) * amp * Math.exp(-k / (len * 0.3));
        L[t0 + k] += v * (1 - pan);
        R[t0 + k] += v * pan;
      }
    }
    norm([L, R], 0.95); return toBuf(L, R);
  }
  function genIR(sec) {
    const sr = ctx.sampleRate, n = Math.floor(sr * sec), L = new Float32Array(n), R = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const e = Math.pow(1 - i / n, 3);
      L[i] = (rand() * 2 - 1) * e;
      R[i] = (rand() * 2 - 1) * e;
    }
    onePoleLP(L, 0.25);
    onePoleLP(R, 0.25);
    return toBuf(L, R);
  }
  AU.unlock = function () {
    if (AM) AM.unlock();
    if (ctx) {
      resume();
      return;
    }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      if (AM) AM.warn('AudioContext failed', String(e));
      return;
    }
    resume(); kick_silent();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.6;
    meter = ctx.createAnalyser(); meter.fftSize = 2048; master.connect(meter);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    master.connect(comp);
    comp.connect(ctx.destination);
    const verb = ctx.createConvolver();
    verb.buffer = genIR(2.6);
    verbIn = ctx.createGain();
    verbIn.gain.value = 0.35;
    verbIn.connect(verb);
    verb.connect(master);
    B.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    {
      const d = B.noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = rand() * 2 - 1;
    }
    setTimeout(() => {
      B.boom = [genBoom(), genBoom(), genBoom()];
      const loop = buf => {
        const s = ctx.createBufferSource();
        s.buffer = buf;
        s.loop = true;
        const g = ctx.createGain();
        g.gain.value = 0;
        s.connect(g);
        g.connect(master);
        s.start();
        return g;
      };
      amb = { rain: loop(genRain(4)), wind: loop(genWind(8)), fire: loop(genFire(4)), lava: loop(genFire(3)) };
    }, 50);
    preload_start();
  };
  /* P54: the context must be resumed inside the gesture (Safari), and again whenever it is not running (tab hidden, iOS
   * interruption);
   * a one-sample silent buffer started in the gesture finishes the unlock on iOS. */
  function resume() {
    if (!ctx || ctx.state === 'running') return;
    try {
      const p = ctx.resume();
      if (p && p.catch) p.catch(e => {
        if (AM) AM.warn('ctx.resume rejected', String(e && e.name));
      });
    } catch (e) { /* */ }
  }
  function kick_silent() {
    try {
      const s = ctx.createBufferSource();
      s.buffer = ctx.createBuffer(1, 1, 22050);
      s.connect(ctx.destination);
      s.start(0);
    } catch (e) { /* */ }
  }
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', () => {
    if (!document.hidden) resume();
  });
  // (iOS Safari unlocks audio only inside touchend / click handlers, not pointerdown)
  if (typeof addEventListener === 'function')
    for (const ev of ['pointerdown', 'keydown', 'touchend', 'click']) addEventListener(ev, () => AU.unlock(), { capture: true });
  const ok = () => {
    if (!ctx || muted) return false;
    if (ctx.state !== 'running') {
      resume();
      return false;
    }
    return true;
  };
  /* P38-R2 polyphony cap: every synthesised source counts until it ends; a burst of events (a cluster, a shrapnel
   * storm) cannot create
   * hundreds of nodes. Over the cap new one-shots are dropped (the oldest keep playing). */
  /* P38 R6 (R12): a context that was suspended / throttled while sources were scheduled never fires their onended,
   * which pinned
   * nVoices at the cap for good (a silent game). The count is therefore also reset when nothing ended for
   * VOICE_STALE_MS of wall time. */
  const MAX_VOICES = 40, VOICE_STALE_MS = 6000;
  let nVoices = 0, lastEnded = 0;
  const take = src => {
    const now = performance.now();
    if (nVoices >= MAX_VOICES) {
      if (now - lastEnded < VOICE_STALE_MS) return false;
      nVoices = 0;
    }
    if (nVoices === 0) lastEnded = now;
    nVoices++;
    src.onended = () => {
      if (nVoices > 0) nVoices--;
      lastEnded = performance.now();
    };
    return true;
  };
  AU.voices = () => nVoices;
  AU.voices_set = n => {
    nVoices = n;
    lastEnded = performance.now() - VOICE_STALE_MS - 1;
  };
  function env(g, t, a, peak, dec) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + dec);
  }
  function out(pan, wet) {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan || 0, -1, 1);
    p.connect(master);
    if (wet) {
      const s = ctx.createGain();
      s.gain.value = wet;
      p.connect(s);
      s.connect(verbIn);
    }
    return p;
  }
  function noise(dur, type, f0, q, peak, f1, rate, delay, pan) {
    if (!ok()) return;
    const t = ctx.currentTime + (delay || 0);
    const s = ctx.createBufferSource();
    if (!take(s)) return;
    s.buffer = B.noise;
    s.loop = true;
    s.playbackRate.value = rate || 1;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    env(g, t, 0.006, peak, dur);
    s.connect(f);
    f.connect(g);
    g.connect(pan ? out(pan) : master);
    s.start(t, rand() * 1.5);
    s.stop(t + dur + 0.1);
  }
  function tone(type, f0, f1, dur, peak, a, delay) {
    if (!ok()) return;
    const t = ctx.currentTime + (delay || 0);
    a = a || 0.005;
    const o = ctx.createOscillator();
    if (!take(o)) return;
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    env(g, t, a, peak, dur);
    o.connect(g);
    g.connect(master);
    o.start(t);
    o.stop(t + a + dur + 0.05);
  }
  function voice(f, dur, vib, formants, peak, delay, f1) {
    if (!ok()) return;
    const t = ctx.currentTime + (delay || 0);
    const o2 = ctx.createGain();
    const oc = ctx.createOscillator();
    if (!take(oc)) return;
    o2.gain.setValueAtTime(0.0001, t);
    o2.gain.exponentialRampToValueAtTime(peak, t + 0.04);
    o2.gain.setValueAtTime(peak, t + dur * 0.7);
    o2.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o2.connect(master);
    const fs = formants.map(([fr, q]) => {
      const b = ctx.createBiquadFilter();
      b.type = 'bandpass';
      b.frequency.value = fr;
      b.Q.value = q;
      b.connect(o2);
      return b;
    });
    const o = oc;
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const l = ctx.createOscillator();
    l.frequency.value = vib[0];
    const lg = ctx.createGain();
    lg.gain.value = vib[1];
    l.connect(lg);
    lg.connect(o.frequency);
    for (const b of fs) o.connect(b);
    o.start(t);
    l.start(t);
    o.stop(t + dur + 0.05);
    l.stop(t + dur + 0.05);
  }
  function playBuf(buf, gain, rate, pan, wet) {
    if (!ok() || !buf) return;
    const s = ctx.createBufferSource();
    if (!take(s)) return;
    s.buffer = buf;
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    s.connect(g);
    g.connect(out(pan, wet));
    s.start();
  }
  // stereo pan / distance gain of a world point for the current camera
  function where(p) {
    const cam = SS.view && SS.view.camera && SS.view.camera();
    if (!cam || !p) return { pan: 0, k: 1 };
    const e = cam.matrixWorld.elements, dx = p.x - cam.position.x, dy = p.y - cam.position.y, dz = p.z - cam.position.z;
    const right = dx * e[0] + dy * e[1] + dz * e[2], dist = Math.hypot(dx, dy, dz);
    return { pan: clamp(right / Math.max(4, dist), -0.9, 0.9), k: clamp(30 / (dist + 10), 0.25, 1.4) };
  }
  const SFX = {
    boom(Rpx, p) {
      const w = where(p);
      if (!B.boom) {
        noise(1.2, 'lowpass', 1800, 0.7, 0.8 * w.k, 70);
        return;
      }
      const s = clamp(Rpx / 60, 0.2, 2);
      playBuf(B.boom[(rand() * 3) | 0], Math.min(1.1, 0.35 + s * 0.45) * w.k, clamp(1.3 - Rpx / 140, 0.55, 1.35), w.pan, 0.5);
    },
    boomWater(Rpx) {
      const s = clamp(Rpx / 60, 0.2, 2);
      noise(1.4, 'lowpass', 420, 0.8, Math.min(0.9, 0.35 + s * 0.4), 60);
      tone('sine', 70, 34, 0.9, 0.35 * s);
      noise(0.9, 'bandpass', 1100, 0.7, 0.25 * s, 400, 1, 0.08);
    },
    crack(s) {
      noise(0.25, 'highpass', 900, 0.8, 0.25 + s * 0.4, 300);
      noise(0.8 + s, 'lowpass', 500, 0.6, 0.2 + s * 0.4, 60, 0.7, 0.05);
    },
    thud(s) {
      tone('sine', 80, 35, 0.3, Math.min(0.8, s * 0.6));
      noise(0.3, 'lowpass', 600, 0.6, Math.min(0.6, s * 0.4), 100);
    },
    wood(v) {
      noise(0.12, 'bandpass', 700 + rand() * 300, 2, v * 0.6);
      tone('triangle', 190, 140, 0.12, v * 0.35);
    },
    metal(v) {
      const f = 180 + rand() * 260;
      [1, 2.76, 5.4, 8.9].forEach((m, i) => tone('sine', f * m, f * m * 0.995, 0.5 / (i + 1) + 0.1, v * 0.18 / (i * 0.6 + 1)));
      noise(0.06, 'highpass', 2500, 0.7, v * 0.4);
    },
    zap() {
      if (!ok()) return;
      const t = ctx.currentTime;
      for (const f of [90, 180, 271]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.05, t + 0.01);
        for (let i = 0; i < 10; i++) g.gain.setValueAtTime(rand() * 0.06 + 0.005, t + i * 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        o.connect(g);
        g.connect(master);
        o.start(t);
        o.stop(t + 0.62);
      }
      noise(0.5, 'highpass', 3000, 0.5, 0.3);
    },
    hole() {
      tone('sine', 38, 90, 3, 0.5, 0.4);
      noise(3, 'bandpass', 200, 1.5, 0.3, 1600, 0.6);
    },
    torch() {
      const n = performance.now();
      if (n - lastDrill < 70) return;
      lastDrill = n;
      noise(0.09, 'bandpass', 700 + rand() * 300, 0.7, 0.16);
      noise(0.06, 'highpass', 3500, 0.5, 0.05);
    },
    drill() {
      const n = performance.now();
      if (n - lastDrill < 90) return;
      lastDrill = n;
      tone('square', 85 + rand() * 20, 70, 0.08, 0.08);
      noise(0.08, 'bandpass', 1200, 1, 0.18);
    },
    ouch() {
      const n = performance.now();
      if (n - lastOuch < 250) return;
      lastOuch = n;
      voice(300 + rand() * 90, 0.22, [9, 15], [[650, 4], [1150, 5]], 0.22, 0, 215);
    },
    splash(s) {
      noise(0.5 + s * 0.3, 'bandpass', 900, 0.8, Math.min(0.7, 0.2 + s * 0.4), 300);
      tone('sine', 600, 1600, 0.05, 0.08 * s);
    },
    whoosh(s) { noise(0.6, 'bandpass', 400, 1.2, 0.3 * (s || 1), 2400); },
    bounce(s) {
      const n = performance.now();
      if (n - lastBounce < 60) return;
      lastBounce = n;
      tone('triangle', 240 + rand() * 60, 160, 0.08, 0.15 * s + 0.04);
    },
    shotgun() {
      playBuf(B.boom && B.boom[0], 0.45, 2.4, 0, 0.3);
      noise(0.25, 'highpass', 1500, 0.5, 0.6, 400);
      tone('square', 140, 50, 0.1, 0.2);
    },
    launch(k) {
      if (k === 'rocket') noise(0.6, 'bandpass', 500, 1, 0.45, 2400);
      else if (k === 'boulder') {
        tone('sine', 120, 60, 0.25, 0.4);
        noise(0.3, 'lowpass', 500, 1, 0.4);
      } else {
        tone('sine', 300, 180, 0.15, 0.25);
        noise(0.15, 'bandpass', 900, 1, 0.2, 2000);
      }
    },
    jump() { voice(290, 0.14, [6, 8], [[640, 4], [1000, 5]], 0.12, 0, 400); },
    thwip() {
      tone('sine', 900, 200, 0.16, 0.25);
      noise(0.12, 'highpass', 3000, 0.7, 0.2);
    },
    clink() { tone('triangle', 1800, 1200, 0.08, 0.2); },
    bat() {
      noise(0.09, 'bandpass', 1800, 2.5, 0.7, 900);
      tone('triangle', 520, 180, 0.12, 0.35);
      tone('sine', 120, 60, 0.18, 0.4);
    },
    crunch(a) {
      const v = Math.min(0.5, 0.15 + (a || 0.1) * 2);
      noise(0.22, 'bandpass', 900, 0.9, v, 300);
      tone('square', 140, 60, 0.18, v * 0.4);
      noise(0.12, 'highpass', 2500, 0.6, v * 0.35);
    },
    clank() {
      tone('square', 180, 120, 0.25, 0.25);
      tone('triangle', 1200, 900, 0.3, 0.12);
    },
    beep() {
      tone('square', 1400, 1400, 0.08, 0.12);
      tone('square', 1400, 1400, 0.08, 0.12, 0.005, 0.14);
    },
    pickup() { [523, 659, 784, 1046].forEach((f, i) => tone('triangle', f, f, 0.12, 0.18, 0.005, i * 0.07)); },
    click() { tone('square', 700, 500, 0.03, 0.06); },
    teleport() {
      if (!ok()) return;
      const t = ctx.currentTime, D = 1.5;
      const bus = ctx.createGain();
      bus.gain.setValueAtTime(0.0001, t);
      bus.gain.exponentialRampToValueAtTime(0.32, t + 0.35);
      bus.gain.setValueAtTime(0.32, t + D - 0.55);
      bus.gain.exponentialRampToValueAtTime(0.0001, t + D);
      const trem = ctx.createGain();
      trem.gain.value = 0.55;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 17;
      const lg = ctx.createGain();
      lg.gain.value = 0.45;
      lfo.connect(lg);
      lg.connect(trem.gain);
      bus.connect(trem);
      trem.connect(master);
      const wet = ctx.createGain();
      wet.gain.value = 0.7;
      trem.connect(wet);
      wet.connect(verbIn);
      for (const [f, v] of [[1180, 0.5], [1490, 0.38], [1770, 0.3], [2360, 0.22], [2950, 0.14], [3540, 0.1]]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f * 0.97, t);
        o.frequency.linearRampToValueAtTime(f * 1.03, t + D);
        const g = ctx.createGain();
        g.gain.value = v;
        o.connect(g);
        g.connect(bus);
        o.start(t);
        o.stop(t + D + 0.05);
      }
      lfo.start(t); lfo.stop(t + D + 0.05); noise(D, 'bandpass', 2500, 1.6, 0.08, 6500);
    },
    fuse() { noise(0.8, 'highpass', 4000, 0.5, 0.15); },
    plane() {
      if (!ok()) return;
      const t = ctx.currentTime, o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(64, t);
      o.frequency.linearRampToValueAtTime(78, t + 2.2);
      o.frequency.linearRampToValueAtTime(58, t + 4.5);
      f.type = 'lowpass';
      f.frequency.value = 600;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.2, t + 1.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 4.5);
      o.connect(f);
      f.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 4.6);
    },
    baa() { voice(300 + rand() * 40, 0.6, [7, 28], [[900, 3], [1600, 4]], 0.5); },
    chirp() {
      const n = 2 + (rand() * 3 | 0), b = 380 + rand() * 300;
      for (let i = 0; i < n; i++)
        voice(b * (0.8 + rand() * 0.5), 0.07, [12, 10], [[800, 3], [1500, 4]], 0.07, i * 0.08, b * (0.7 + rand() * 0.6));
    },
    fanfare() { [392, 523, 659, 784, 659, 784].forEach((f, i) => tone('triangle', f, f, i === 5 ? 0.6 : 0.15, 0.22, 0.005, i * 0.14)); },
    splat() {
      noise(0.35, 'lowpass', 1100, 1, 0.7, 180);
      noise(0.2, 'bandpass', 420, 3, 0.45, 160, 1, 0.03);
      tone('sine', 120, 50, 0.2, 0.4);
    },
    chargeStart() {
      if (!ok()) return;
      const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(180, t);
      o.frequency.exponentialRampToValueAtTime(900, t + 1.2);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.07, t + 0.04);
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + 1.3);
      charge = { o, g };
    },
    chargeStop() {
      if (charge) {
        try {
          const t = ctx.currentTime;
          charge.g.gain.cancelScheduledValues(t);
          charge.g.gain.setValueAtTime(charge.g.gain.value, t);
          charge.g.gain.linearRampToValueAtTime(0.0001, t + 0.05);
          charge.o.stop(t + 0.06);
        } catch (e) { /* */ }
        charge = null;
      }
    }
  };
  AU.sfx = SFX;
  // P37: platform/audioa.js (W3) and audio_b.js (W4) build the new weapons' sounds from these
  AU.synth = { tone, noise, voice, playBuf, where, ok, clamp, rand, S2: (id, vol, rate, fb) => S2(id, vol, rate, fb) };
  const ROCKETS = { bazooka: 1, homing: 1 };
  /* ---------- recorded / generated samples (assets/sfx/manifest.js, ids = docs/SOUND_PROMPTS.md) ----------
   * HTMLAudio (decodeAudioData needs fetch, which file:// forbids): a small pool per file; volume x master; pitch
   * jitter through playbackRate (preservesPitch off). play(id, vol, rate) -> true when a sample played; else the
   * caller's synthesised fallback runs. Worm voice lines (voice()) have no fallback: silent until their files exist
   * (P42b: the team banks 'id@t1'..'@t4'). */
  /* R10: a recorded file counts only if the browser can decode its format (canPlayType). The sfx are Ogg Vorbis: a
   * Safari without it used to get
   * an <audio> that failed silently while AU.play() still answered true, so the synthesised fallbacks never ran (no
   * sound effects at all). */
  const MIME = {
    ogg: 'audio/ogg; codecs="vorbis"',
    oga: 'audio/ogg; codecs="vorbis"',
    opus: 'audio/ogg; codecs="opus"',
    m4a: 'audio/mp4; codecs="mp4a.40.2"',
    mp3: 'audio/mpeg',
    wav: 'audio/wav'
  };
  const canExt = {};
  let probe = null;
  const badFile = {};
  function playable(f) {
    if (badFile[f]) return false;
    const x = f.slice(f.lastIndexOf('.') + 1).toLowerCase();
    if (canExt[x] === undefined) {
      let r = true;
      // (no Audio: assume yes)
      try {
        if (MIME[x]) {
          probe = probe || new Audio();
          const q = probe.canPlayType(MIME[x]);
          r = q === 'probably' || q === 'maybe';
        }
      } catch (e) {
        r = true;
      }
      canExt[x] = r;
    }
    return canExt[x];
  }
  /* P42b: every .ogg / .opus sound has an AAC .m4a sibling when the manifest sets SS.SFX_M4A (tools/dev/gen/sfxm4a.py):
   * a browser that cannot decode Ogg (older Safari) plays the sibling instead of falling back to the synth / silence */
  function resolve(f) {
    if (playable(f)) return f;
    if (SS.SFX_M4A && /\.(ogg|opus)$/i.test(f)) {
      const g = f.replace(/\.(ogg|opus)$/i, '.m4a');
      if (playable(g)) return g;
    }
    return null;
  }
  AU.has = id => {
    const l = SS.SFX_FILES && SS.SFX_FILES[id];
    if (!l) return false;
    for (let i = 0; i < l.length; i++)
      if (resolve(l[i])) return true;
    return false;
  };
  /* jit = the random detune of this play (fraction of the speed): one-shots +-4 % (MU.JIT_SHOT), worm voices +-2 %
   * (MU.JIT_VOICE, platform/music.js); a caller that wants a wider spread passes its own. */
  /* P54: two playback paths, one gesture-safe.
   * - http(s): the file is fetched and decoded once (decodeAudioData; an Ogg the browser cannot decode falls back to
   *   the m4a sibling) and played through an AudioBufferSourceNode on the master bus (detune = playbackRate). While a
   *   file is not decoded yet its first play goes through the element pool below and the decode starts in the
   *   background.
   * - file:// (fetch is forbidden) or a failed decode: an element of the unlocked pool (platform/amedia.js), never `new
   *   Audio()` outside a gesture (Safari refuses that: total silence). */
  const bufs = {}, loading = {}, nbuf = [], MAXBUF = 160;
  const web = typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && typeof fetch === 'function';
  let preloaded = 0;
  function decode(data) {
    return new Promise((res, rej) => {
      const r = ctx.decodeAudioData(data, res, rej);
      if (r && r.then) r.then(res, rej);
    });
  }
  function load_buf(f) {
    if (!web || !ctx || bufs[f] || loading[f] || badFile[f]) return;
    loading[f] = true;
    fetch('assets/sfx/' + f).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(decode).then(b => {
      bufs[f] = b; nbuf.push(f); delete loading[f];
      if (nbuf.length > MAXBUF) delete bufs[nbuf.shift()];
    }).catch(e => {
      delete loading[f];
      badFile[f] = true;
      if (AM) AM.stat.buf_failed++;
      if (AM) AM.warn('decode/fetch failed', f + ' ' + String(e && (e.message || e.name)));
      if (/\.ogg$/i.test(f) && !/HTTP|fetch|Network|Load failed/i.test(String(e && (e.message || e.name)))) canExt.ogg = false;
    });
  }
  // the most used sounds are decoded right after the unlock (a bounded set; the rest on first use)
  function preload_start() {
    if (!web || preloaded) return;
    preloaded = 1;
    const ids = [],
      want = /^(explosion|launch_|ui_|turn_start|crate_pickup|splash|worm_jump|worm_land|worm_hurt|charge)/,
      files = SS.SFX_FILES || {};
    for (const id in files)
      if (want.test(id) && files[id].length) ids.push(id);
    let k = 0;
    const next = () => {
      if (k >= ids.length || k > 90) return;
      const l = files[ids[k++]], f = resolve(l[0]);
      if (f) load_buf(f);
      setTimeout(next, 25);
    };
    setTimeout(next, 200);
  }
  /* P65j: a voice with a spatial result sp (audiospace.js eval): gain -> low-pass (air absorption / occlusion / water)
   * -> pan -> master, plus a send
   * to the reverb (wet: more in caves). Node count is tracked (AU.nodes) for the perf check. */
  let liveNodes = 0, peakNodes = 0;
  function start_buf(b, vol, rate, sp) {
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = vol * (sp ? sp.gain : 1);
    s.connect(g);
    let last = g, n = 2;
    if (sp) {
      if (sp.fc < 16000) {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = sp.fc;
        f.Q.value = 0.5;
        last.connect(f);
        last = f;
        n++;
      }
      if (Math.abs(sp.pan) > 0.03 && ctx.createStereoPanner) {
        const p = ctx.createStereoPanner();
        p.pan.value = sp.pan;
        last.connect(p);
        last = p;
        n++;
      }
      if (sp.wet > 0.03 && verbIn) {
        const w = ctx.createGain();
        w.gain.value = sp.wet;
        last.connect(w);
        w.connect(verbIn);
        n++;
      }
    }
    last.connect(master);
    liveNodes += n;
    if (liveNodes > peakNodes) peakNodes = liveNodes;
    s.onended = () => { liveNodes -= n; };
    s.start(ctx.currentTime + (sp && sp.delay > 0.02 ? sp.delay : 0));
    if (AM) AM.stat.buf_started++;
  }
  /* position of the event being dispatched (AU.onEvent sets it): every AU.play inside gets spatialised without its
   * caller knowing */
  let curPos = null, curOpt = null;
  AU.nodes = () => ({ live: liveNodes, peak: peakNodes });
  AU.play = function (id, vol, rate, jit, pos, opt) {
    if (muted || !(AM ? AM.gestured : ctx) || !AU.has(id)) return false;
    const all = SS.SFX_FILES[id], files = all.map(resolve).filter(Boolean), f = files[(rand() * files.length) | 0];
    const v = clamp((vol == null ? 1 : vol) * 0.85, 0, 1),
      r = clamp((rate || 1) * SS.music.jitter(rand(), jit == null ? SS.music.JIT_SHOT : jit), 0.5, 2);
    if (pos === undefined) {
      pos = curPos;
      if (opt === undefined) opt = curOpt;
    }
    let sp = null;
    if (pos && AU.space) {
      try {
        sp = AU.space.eval(pos, opt);
      } catch (e) {
        sp = null;
      }
    }
    if (sp && v * sp.gain < 0.012) return true;                      // inaudible at this distance: handled, no fallback
    if (web && ctx && ctx.state === 'running' && bufs[f]) {
      try {
        start_buf(bufs[f], v / 0.6, r, sp);
        return true;
      } catch (e) {
        if (AM) AM.warn('buffer start failed', String(e));
      }
    }
    if (web) load_buf(f);
    if (!AM) return false;
    const vol2 = sp ? v * sp.gain * (1 - 0.35 * sp.muffle) : v;     // (HTMLAudio cannot filter or pan: volume only)
    const go = () => {
      const el = AM.acquire('assets/sfx/' + f, { onerror: () => { badFile[f] = true; } });
      if (!el) return false;
      try {
        el.preservesPitch = false;
        el.mozPreservesPitch = false;
        el.webkitPreservesPitch = false;
      } catch (e) { /* */ }
      el.volume = clamp(vol2, 0, 1); el.playbackRate = r;
      return AM.play(el);
    };
    if (sp && sp.delay > 0.05) {
      setTimeout(go, sp.delay * 1000);
      return true;
    }
    return go();
  };
  AU.status = function () {
    let rms = 0;
    if (meter) {
      const d = new Float32Array(meter.fftSize);
      meter.getFloatTimeDomainData(d);
      let a = 0;
      for (let i = 0; i < d.length; i++) a += d[i] * d[i];
      rms = Math.sqrt(a / d.length);
    }
    return {
      nodes: liveNodes,
      peakNodes,
      path: web ? 'webaudio+pool' : 'pool',
      ctx: ctx ? ctx.state : 'none',
      muted,
      rms,
      decoded: nbuf.length,
      loading: Object.keys(loading).length,
      bad: Object.keys(badFile).length,
      media: AM ? AM.status() : null,
      buf_started: AM ? AM.stat.buf_started : 0,
      last_error: AM ? AM.stat.last_error : ''
    };
  };
  const S2 = (id, vol, rate, fallback, pos, opt) => {
    if (!AU.play(id, vol, rate, undefined, pos, opt) && fallback) fallback();
  };
  /* worm voices (P42b): team identity comes from distinct voice BANKS, not from pitch (pitched-up voices sounded like
   * chipmunks):
   * SS.SFX_FILES['worm_hurt_small@t1'] ... '@t4' (team 1..4) when delivered, else the shared id at pitch 1.0. Detune
   * only +-2 %. Throttled per worm. */
  const lastVoice = new Map();
  /* P85: who may speak. ACTIVE lines (turn opener, aim / fire, hop, pass, pickup, idle chatter) only from S.active;
   * REACTION lines go through
   * render/reactq.js (affected worms only, one at a time, the most dramatic first): hurt / burn / bat / dying / drown /
   * wash / dizzy are fed by the events there, fall scream / cough / acid / flinch are submitted from here. Anything
   * else from a bystander is dropped (returns true: handled, no synth). */
  const V_EVENTFED = {
    worm_hurt_small: 1, worm_hurt_big: 1, worm_burn: 1, worm_bat_hit: 1, worm_dying: 1, worm_drown: 1, worm_wash: 1, worm_dizzy: 1
  };
  const V_SUBMIT = { worm_fall_scream: 'fall', worm_cough: 'cough', worm_ouch: 'acid', worm_flinch: null };
  let curS = null;
  AU.voice = function (id, w, vol, minGap) {
    if (!w) return false;
    if (id === 'worm_victory') return AU.voiceNow(id, w, vol, minGap);
    const RQ = SS.reactq, S = curS;
    if (RQ && S && S.active) {
      if (V_EVENTFED[id]) return true;
      if (id in V_SUBMIT) {
        if (S.phase === 'play' && w.id !== S.active.id) return true;
        RQ.submit(S, w, { id, kind: V_SUBMIT[id], vol: vol == null ? 0.9 : vol, prio: id === 'worm_flinch' ? 0 : 1, cam: false, amt: 0 });
        return true;
      }
      if (w.id !== S.active.id) return true;
    }
    return AU.voiceNow(id, w, vol, minGap);
  };
  AU.voiceNow = function (id, w, vol, minGap) {
    if (!w) return false;
    const t = ctx ? ctx.currentTime : 0, l = lastVoice.get(w.id) || -9;   // (by id: a replay restore replaces the worm objects)
    if (t - l < (minGap == null ? 0.6 : minGap)) return false;
    if (
      !AU.play(
        SS.music.bank_id(AU.has, id, w.team),
        vol == null ? 0.9 : vol,
        1,
        SS.music.JIT_VOICE,
        w.pos ? { x: w.pos.x, y: w.pos.y + 0.3, z: w.pos.z } : null,
        { cls: 'norm' }
      )
    ) return false;
    lastVoice.set(w.id, t); return true;
  };
  const hurtLine = e => e.src === SS.CFG.DS.BAT
    ? 'worm_bat_hit'
    : (SS.CFG.DS_FLAGS[e.src | 0] & SS.CFG.DSF.FX_HOT)
    ? 'worm_burn'
    : e.amount >= 25
    ? 'worm_hurt_big'
    : 'worm_hurt_small';
  /* P65j: how far each event type carries: loud = blasts / collapses (speed-of-sound delay, long reach), quiet =
   * footfall-sized, else normal */
  const LOUD = {
    explode: 1, waterblast: 1, airburst: 1, collapse: 1, bridgefall: 1, holy: 1, lightning: 1, lavabreach: 1, hole: 1, treeshatter: 1,
    moai: 0
  };
  const QUIET = { land: 1, bodyhit: 1, fuse: 1, minearm: 1, pickup: 1, jump: 1, switch: 1, rope_hook: 1 };
  AU.onEvent = function (S, e) {
    curS = S;
    if (!ctx && !(AM && AM.gestured)) return;
    const wp = e.worm && e.worm.pos;
    curPos = e.x != null && e.y != null && e.z != null ? { x: e.x, y: e.y, z: e.z } : wp ? { x: wp.x, y: wp.y, z: wp.z } : null;
    curOpt = { cls: LOUD[e.type] ? 'loud' : QUIET[e.type] ? 'quiet' : 'norm' };
    try {
      onEvent2(S, e);
    } finally {
      curPos = null;
      curOpt = null;
    }
  };
  function onEvent2(S, e) {
    switch (e.type) {
      // a charge under the water: its own sound is the 'waterblast' event (no second, dry boom)
      case 'explode': {
        const R = 44 * Math.cbrt(e.W || 1);
        if (e.wet != null && e.wet > 0.25) break;
        if (SS.music) {
          const dk = SS.music.duck_gain(R), dl = AU.space ? AU.space.eval(e, { cls: 'loud' }).delay : 0;
          if (dl > 0.05) setTimeout(() => SS.music.duck(dk), dl * 1000);
          else SS.music.duck(dk);
        }
        if (AU.space) AU.space.hush(R / 50);
        S2(R > 60 ? 'explosion_large' : R > 30 ? 'explosion_medium' : 'explosion_small', clamp(R / 60, 0.4, 1), 1, () => SFX.boom(R, e));
        // P66a: HE = a sharp crack (the shock front: a short airburst sample pitched up) on top of the low boom; FUEL =
        // a soft 'whoomp' of the ignition (a low, slowed fire_ignite), the boom a little quieter
        if (!e.boom) S2('explosion_air', clamp(R / 60, 0.25, 0.7), 1.6);
        else S2('fire_ignite', clamp(0.5 + R / 80, 0.5, 1), 0.6);
        // a gasp from the worm on turn when a blast goes off close to it
        const a = S.active;
        if (a && !a.dead && Math.hypot(a.pos.x - e.x, a.pos.y - e.y, a.pos.z - e.z) < 7) AU.voice('worm_flinch', a, 0.7, 1.5);
        break;
      }
      case 'waterblast':
        if (SS.world.has_sea()) S2('explosion_water', 1, 1, () => SFX.boomWater(44 * Math.cbrt(e.W || 1)));
        break;
      case 'fire':
        if (AU.ext && AU.ext(S, e)) break;
        S2(ROCKETS[e.weapon] ? 'launch_rocket' : 'launch_throw', 0.9, 1, () => SFX.launch(ROCKETS[e.weapon] ? 'rocket' : 'thrown'));
        if (rand() < 0.35) AU.voice('worm_attack', S.active, 0.8);
        break;
      case 'use':
        if (e.weapon === 'boulder') S2('launch_boulder', 1, 1, () => SFX.launch('boulder'));
        else if (e.weapon === 'skip') {
          S2('ui_click', 0.6, 1, () => SFX.click());
          AU.voice('worm_skip', S.active, 0.8);
        }
        break;
      case 'bounce': {
        const k = clamp((e.speed || 3) / 10, 0.1, 1), cls = AU.space && e.mat != null ? AU.space.matClass(e.mat) : 'metal';
        S2(AU.space ? AU.space.bounceId(cls) : 'bounce_metal', k, 1, () => S2('bounce_metal', k, 1, () => SFX.bounce(k)));
        break;
      }
      // (no sea, no splash: the sim's splash in a world without one is something leaving the world)
      case 'splash':
        if (SS.world.has_sea())
          S2(e.size > 0.9 ? 'splash_big' : 'splash_small', Math.min(1, e.size || 0.6), 1, () => SFX.splash(Math.min(1.5, e.size || 0.6)));
        break;
      // (the synth only when there is no recording, not when the voice is merely throttled)
      case 'hurt':
        if (!AU.voice(hurtLine(e), e.worm, 1, 0.35) && !AU.has(hurtLine(e))) SFX.ouch();
        break;
      case 'jump': S2('worm_jump_whoosh', 0.6, 1, () => SFX.jump()); AU.voice('worm_jump', S.active, 0.7, 0.4); break;
      case 'salto': AU.voice('worm_salto', e.worm || S.active, 0.9, 0.3); break;
      case 'dizzy': AU.voice('worm_dizzy', e.worm, 0.9, 0.5); break;
      case 'drown':
        AU.voice('worm_drown', e.worm, 1, 0.2);
        if (SS.world.has_sea()) S2('splash_big', 0.8, 1, null);
        break;
      case 'wash': AU.voice('worm_wash', e.worm, 0.9); S2('wave_wash', 0.9, 1, null); break;
      case 'switch': AU.voice('worm_select', e.worm, 0.9, 0.2); break;
      case 'rope_fire': S2('rope_fire', 0.7, 1, () => SFX.thwip()); break;
      case 'rope_hook': S2('rope_hook', 0.8, 1, () => SFX.clink()); break;
      case 'rope_release':
        if ((e.speed || 0) > 4) S2('rope_release', 0.6, 1, () => SFX.whoosh(Math.min(1, e.speed / 25)));
        break;
      case 'rope_knock': S2('body_hit', 0.6, 1, () => SFX.thud(0.6)); break;
      case 'chute_open': S2('chute_open', 0.8, 1, () => SFX.whoosh(0.8)); break;
      // P86: the jetpack (through the suit: muffled by audiospace unless it is the listener's own)
      case 'eowjet':
        if (e.phase === 0) S2('eow_jet', 0.8, 1, () => SFX.whoosh(0.9), { x: e.x, y: e.y, z: e.z });
        else S2('eow_jet_hiss', 0.3, 1, () => SFX.whoosh(0.25), { x: e.x, y: e.y, z: e.z });
        break;
      case 'eowjetmode': S2('ui_click', 0.5, e.on ? 1 : 0.8, () => SFX.click()); break;
      case 'chute_cut': S2('chute_cut', 0.5, 1, () => SFX.whoosh(0.4)); break;
      case 'zip_fire': S2('zip_fire', 0.7, 1, () => SFX.thwip()); break;
      case 'zip_hook': S2('zip_hook', 0.8, 1, () => SFX.clink()); break;
      case 'zip_leave': S2('zip_leave', 0.5, 1, () => SFX.whoosh(0.4)); break;
      case 'zap': S2('electric_zap', 0.9, 1, () => SFX.zap()); break;
      case 'hole': S2('blackhole_open', 1, 1, () => SFX.hole()); break;
      case 'teleport': S2('teleport_beam', 0.9, 1, () => SFX.teleport()); AU.voice('worm_teleport', e.worm, 0.8, 0.2); break;
      case 'plane': S2('airstrike_plane', 1, 1, () => SFX.plane()); break;
      case 'baa': S2('sheep_baa', 0.9, 1, () => SFX.baa()); break;
      case 'swing':
        if (e.hit) S2('bat_hit', 1, 1, () => SFX.bat());
        else S2('swing_whoosh', 0.8, 1, () => SFX.whoosh(0.8));
        break;
      case 'shot':
        if (e.from && !(e.weapon === 'handgun' && AU.ext && AU.ext(S, e)))
          S2(e.weapon === 'sniper' ? 'sniper_shot' : 'shotgun_shot', 1, 1, () => SFX.shotgun());
        break;
      case 'sparks':
        if (e.mode === 'drill') S2('drill_loop', 0.7, 1, () => SFX.drill());
        else S2('torch_loop', 0.7, 1, () => SFX.torch());
        break;
      case 'girder': S2('girder_place', 1, 1, () => SFX.clank()); break;
      case 'pickup': S2('crate_pickup', 0.9, 1, () => SFX.pickup()); AU.voice('worm_pickup', S.active, 0.9, 0.2); break;
      case 'lablong': S2('fanfare_win', 0.55, 1.3, () => SFX.fanfare()); break;                    // P50 Lab: long shot
      case 'labperk': S2('crate_pickup', 0.9, 0.85, () => SFX.pickup()); break;                     // P50 Lab: a perk taken
      // P50 Lab: a streak step
      case 'labstreak':
        if (e.streak > 0) S2('turn_start', 0.8, 1.35, () => SFX.chirp());
        break;
      case 'fuse': S2('fuse_tick', 0.6, 1, () => SFX.fuse()); break;
      case 'minearm': S2('mine_beep', 0.8, 1, () => SFX.beep()); break;
      case 'propbreak': S2(e.kind === 'barrel' ? 'metal_crunch' : 'wood_break', 0.8, 1, () => SFX.wood(0.7)); break;
      case 'collapse': S2('rock_collapse', Math.min(1, (e.pieces || 1) / 4), 1, () => SFX.crack(Math.min(1, (e.pieces || 1) / 4))); break;
      case 'land':
        if ((e.speed || 0) > 5) {
          const k = Math.min(1, e.speed / 12),
            cls = AU.space && e.mat != null ? AU.space.matClass(e.mat) : 'soil',
            lid = AU.space ? AU.space.landId(cls) : 'worm_land_thud';
          S2(lid, k, 1, () => S2('worm_land_thud', k, 1, () => SFX.thud(k)));
          if (e.hard) {
            if (cls === 'soil' || cls === 'ash') S2('worm_land_hard_thud', k, 1, null);
            AU.voice('worm_land_hard', e.worm || (S.worms && S.worms.find(w => w.id === e.wormId)), 1, 0.3);
          }
        }
        break;
      case 'bodyhit': S2('body_hit', 0.4, 1, () => SFX.crunch(0.15)); break;
      case 'gameover':
        S2('fanfare_win', 1, 1, () => SFX.fanfare());
        {
          const w = S.worms.find(o => !o.dead);
          if (w) AU.voice('worm_victory', w, 1, 0);
        }
        break;
      case 'turn': S2('turn_start', 0.7, 1, () => SFX.chirp()); AU.voice('worm_turn_start', e.worm || S.active, 0.85, 0); break;
      case 'foam': S2('foam_grow', 0.8, 1, () => SFX.whoosh(0.7)); break;
      case 'blow': S2('bellows_blow', 0.8, 1, () => SFX.whoosh(0.7)); break;
      case 'spring': S2('spring_launch', 1, 1, () => SFX.bounce(1)); AU.voice('worm_fall_scream', e.worm, 1, 0); break;
      case 'scramble': S2('scrambler_buzz', 0.8, 1, () => SFX.click()); break;
      case 'shatter': S2('ice_shatter', 0.8, 1, () => SFX.crunch(0.4)); break;
      // (acid: audio_c.js plays acid_steel instead)
      case 'steelcut':
        if (!e.acid) S2('metal_cut', 0.8, 1, () => SFX.metal(0.8));
        break;
      case 'airburst': S2('explosion_air', 0.9, 1, () => SFX.boom(20, e)); break;
      case 'gib': S2('gib_splat', 1, 1, () => SFX.splat()); break;
      case 'dying':
        if (!AU.voice('worm_dying', e.worm, 1, 0) && !AU.has('worm_dying')) SFX.ouch();
        break;
      case 'lavaplop': S2('lava_plop', 0.8, 1, null); break;
      case 'steam': S2('steam_hiss', Math.min(1, e.power || 0.5), 1, null); break;
      // P89: the life jacket's CO2 cartridge hisses as the vest inflates (existing samples)
      case 'jacket': S2('steam_hiss', 0.5, 1.3, null); S2('splash_small', 0.5, 1, null); break;
      // P89: the HUD toggle
      case 'gear':
        if (!e.used) S2('ui_click', 0.5, e.on ? 1.15 : 0.85, null);
        break;
      case 'icebreak': S2('ice_crack', 0.9, 1, () => SFX.crunch(0.4)); break;
      case 'bridgefall': S2('bridge_fall', 1, 1, () => SFX.crack(1)); break;
      case 'treebreak': case 'treeshatter': S2('tree_crack', 0.9, 1, () => SFX.wood(0.9)); break;
      case 'holy': S2('holy_orb_burst', 1, 1, null); break;
      case 'lightning': S2('lightning_crack', 1, 1, null); break;
      case 'moai': S2('moai_whoosh', 1, 1, () => SFX.whoosh(1)); break;
      case 'lavabreach': S2('lava_breach', 1, 1, null); break;
      case 'oilfire': case 'propfire': case 'grassfire': case 'treefire': S2('fire_ignite', 0.7, 1, null); break;
      default: if (AU.ext) AU.ext(S, e);                                   // P37-W3 events (platform/audioa.js)
    }
    if (AU.extra) AU.extra(S, e);
  }
  ;
  /* looping ambient beds (P65j: spatial). http(s): the decoded buffer loops through gain -> low-pass -> pan on the
   * master bus (pan = where the source
   * is, low-pass = distance / shelter / water); file:// (no decode): one <audio loop> per id from the pool, volume only
   * (no pan / filter). o = { pan, fc, rate, muffle }. -> true when the id has a recording. */
  const loops = {}, wbeds = {};
  function ambLoop(id, lvl, o) {
    if (!AU.has(id)) return false;
    o = o || {};
    const f = resolve(SS.SFX_FILES[id][0]);
    if (!f) return false;
    if (web && ctx) {
      if (bufs[f]) {
        const t = ctx.currentTime, want = muted ? 0 : clamp(lvl, 0, 1);
        let b = wbeds[id];
        if (!b) {
          if (want < 0.004) return true;
          const s = ctx.createBufferSource();
          s.buffer = bufs[f];
          s.loop = true;
          const g = ctx.createGain();
          g.gain.value = 0;
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass';
          lp.frequency.value = o.fc || 20000;
          lp.Q.value = 0.5;
          const pn = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
          s.connect(lp);
          lp.connect(g);
          if (pn) {
            pn.pan.value = o.pan || 0;
            g.connect(pn);
            pn.connect(master);
          } else g.connect(master);
          s.start(0, rand() * bufs[f].duration);
          b = wbeds[id] = { s, g, lp, pn, lowT: 0 };
          liveNodes += 4;
          if (liveNodes > peakNodes) peakNodes = liveNodes;
          if (loops[id]) {
            loops[id].pause();
            loops[id].volume = 0;
          }
        }
        b.g.gain.setTargetAtTime(want, t, 0.45);
        b.lp.frequency.setTargetAtTime(clamp(o.fc || 20000, 300, 20000), t, 0.35);
        if (b.pn) b.pn.pan.setTargetAtTime(clamp(o.pan || 0, -1, 1), t, 0.35);
        if (o.rate) b.s.playbackRate.setTargetAtTime(o.rate, t, 0.6);
        if (want < 0.004) {
          if (!b.lowT) b.lowT = t;
          else if (t - b.lowT > 3) {
            try {
              b.s.stop();
              b.s.disconnect();
              b.lp.disconnect();
              b.g.disconnect();
              if (b.pn) b.pn.disconnect();
            } catch (e) { /* */ }
            delete wbeds[id];
            liveNodes -= 4;
          }
        } else b.lowT = 0;
        return true;
      }
      // (decode in the background, only once the bed is audible; the pool element covers the first seconds)
      if (lvl >= 0.004) load_buf(f);
    }
    if (!AM) return false;
    let el = loops[id];
    if (!el && lvl < 0.004) return true;                              // (no pool element for a bed nobody hears)
    if (!el) {
      el = AM.acquire('assets/sfx/' + f, {
        keep: true,
        onerror: () => {
          badFile[f] = true;
          if (loops[id]) AM.release(loops[id]);
          delete loops[id];
        }
      });
      if (!el) return false;
      el.loop = true; el.volume = 0; loops[id] = el;
    }
    const want = muted ? 0 : clamp(lvl, 0, 1) * 0.6 * (1 - 0.4 * (o.muffle || 0));
    el.volume += (want - el.volume) * 0.05;
    if (el.volume > 0.005 && el.paused) {
      AM.play(el);
    } else if (el.volume <= 0.005 && !el.paused) el.pause();
    return true;
  }
  /* P38-R2: ambient beds and the charge whine stop while the game is paused / a menu is open (AU.frame only runs while
   * the game renders):
   * main.js calls hold(on) every frame (cheap: acts on a change only). */
  let held = false;
  AU.hold = function (on) {
    on = !!on;
    if (on === held) return;
    held = on;
    if (on) {
      for (const id in loops)
        if (!loops[id].paused) loops[id].pause();
      if (ctx)
        for (const id in wbeds) wbeds[id].g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      if (amb && ctx)
        for (const k in amb) amb[k].gain.setTargetAtTime(0, ctx.currentTime, 0.05);
      SFX.chargeStop(); wasCharging = false;
    }
  };
  let rqHooked = false;
  AU.reactSpeak = function (S, it) {                               // P85: a reaction line starts (render/reactq.js)
    const w = S.worms[it.wid];
    if (!w || !it.id) return;
    if (!AU.voiceNow(it.id, w, it.vol, 0.2) && !AU.has(it.id) && it.prio >= 1 && ctx) SFX.ouch();
  };
  let wasCharging = false, lastFrameMs = 0;
  const screamed = new WeakSet();   // (audio state stays off the sim objects)
  AU.frame = function (S) {
    curS = S;
    if (!rqHooked && SS.reactq) {
      rqHooked = true;
      SS.reactq.listen(AU.reactSpeak);
    }
    if (!ctx || held) return;
    if (S.charging && !wasCharging) {
      if (!AU.play('charge_power', 0.7)) SFX.chargeStart();
    } else if (!S.charging && wasCharging) SFX.chargeStop();
    wasCharging = !!S.charging;
    // a worm falling fast screams once per fall (the scared face in render/actors.js)
    for (const w of S.worms) {
      if (w.dead) continue;
      const vy = w === S.active ? (w.air ? w.vy : 0) : (!w.rest && w.vel ? w.vel.y : 0);
      if (vy < -12 && !screamed.has(w)) {
        screamed.add(w);
        AU.voice('worm_fall_scream', w, 1, 0.5);
      } else if (vy > -2) screamed.delete(w);
    }
    const nowMs = performance.now(), fdt = clamp((nowMs - lastFrameMs) / 1000, 0, 0.25);
    lastFrameMs = nowMs;
    const SPc = AU.space;
    if (SPc) {
      SPc.frame(S, fdt);
      if (S.phase === 'play' || S.phase === 'turn' || S.worms) SPc.steps(S, fdt);
    }
    if (!amb) return;
    const t = ctx.currentTime;
    const A = SPc ? SPc.amb : null, L = SPc ? SPc.L : null;
    // ambient beds: a looping sample (amb_*) replaces the synthesised loop when it exists; levels come from what is
    // near the camera focus (audiospace.js)
    const bed = (id, synth, lvl, k, o) => {
      if (ambLoop(id, lvl, o)) synth.gain.setTargetAtTime(0, t, 0.3);
      else synth.gain.setTargetAtTime(lvl * k, t, 0.6);
    };
    if (!A || !L.ok) {
      const we = S.weather, w = S.wind && !SS.world.under ? Math.hypot(S.wind.mean.x, S.wind.mean.z) : 0;
      bed('amb_rain', amb.rain, we ? Math.min(1, (we.rain || 0) * 1.4) : 0, 0.42); bed('amb_wind', amb.wind, Math.min(1, w / 14), 0.3);
      return;
    }
    const base = L.uw ? 450 : 20000 / (1 + 2.5 * A.enc), mu = A.muffle;
    bed('amb_rain', amb.rain, A.rain, 0.42, { fc: base, muffle: mu });
    bed('amb_wind', amb.wind, Math.max(A.wind, A.whirl * 0.5), 0.3, { fc: base, muffle: mu });
    bed('amb_fire', amb.fire, A.fire, 0.35, { pan: A.firePan, fc: base, muffle: mu });
    bed('amb_lava', amb.lava, A.lava, 0.3, { pan: A.lavaPan, fc: Math.min(base, 9000), muffle: mu });
    ambLoop('amb_sea_surf', A.surf, { pan: A.surfPan, fc: Math.min(base, 12000), muffle: mu });
    ambLoop('amb_whirl', A.whirl, { pan: A.whirlPan, fc: Math.min(base, A.whirlFc), rate: A.whirlRate, muffle: mu });
    ambLoop('amb_snowfall', Math.max(A.snow * 0.8, A.ash * 0.55), { fc: Math.min(base, A.ash > A.snow ? 5000 : 12000), muffle: mu });
    ambLoop('amb_birds', A.birds * 0.8, { fc: base, muffle: mu });
    ambLoop('amb_crickets', A.crickets * 0.8, { fc: base, muffle: mu });
    ambLoop('amb_cave', A.cave, { fc: L.uw ? 450 : 20000, muffle: L.uw ? 0.9 : 0 });
  };
  AU.setMuted = function (m) {
    muted = !!m;
    if (master) master.gain.value = muted ? 0 : 0.6;
    try {
      localStorage.setItem('burrowBrawl3d.muted', muted ? '1' : '0');
    } catch (e) { /* */ }
  };
  Object.defineProperty(AU, 'muted', { get: () => muted });
})(window.SS = window.SS || {});
