/* platform/net.js — multiplayer transport (P12: the PoC's online friend matches on poc5's deterministic lockstep).
 * LOCKSTEP: every peer runs the same deterministic sim (host settings + seed + seat map in 'start'). For every sim step
 * the DRIVER is the seat that owns the active worm's team (a CPU team: the host); it steps at once with its input and
 * sends it tagged with the step number; everybody else applies the inputs in order and waits when the next one has not
 * arrived (turn-based: nothing is predicted). Every HASH_EVERY steps the state hashes are compared (desync report).
 * STAR: the host links every guest. Guests send their inputs / hashes to the host; the host relays a guest's inputs to
 * the other guests and broadcasts its own (and its CPU teams'). 2-4 teams: host = team 0, guests = the next teams in
 * join order, the remaining teams CPU (driven by the host).
 * TRANSPORTS (same messages):
 *   - room codes (PoC): PeerJS (local vendor/peerjs.min.js, loaded on demand) with the public PeerJS broker for
 *     signalling, Google / Cloudflare STUN and the PeerJS TURN relay (as in the PoC). Needs the internet.
 *   - LAN codes (9b): copy / paste WebRTC offer / answer codes, no server, host candidates only (file://, offline);
 *     the host makes one offer per guest.
 * FRIEND LEFT (PoC friendLeft): the host turns the leaver's team into a CPU team at an agreed step k (its own current
 * step: no other peer can be past it for that team's inputs, they all come through the host) and tells the others
 * ('ctl'); every peer switches at step k (main.js applies ctl_due before stepping).
 * Messages (JSON): {t:'hello', name} guest -> host; {t:'lobby', names[]} host -> guests; {t:'start', settings, seats,
 * you}; {t:'ins', k0, a:[...]}; {t:'hash', k, h}; {t:'ctl', team, k}; {t:'bye'}.
 * API: room_host(name) -> Promise<code>; room_join(code, name) -> Promise; host(settings, name) -> Promise<offer>
 * (LAN, one per guest); accept(answer); join(offer, name) -> Promise<answer>; start(settings) -> settings to play
 * (host); on(name, fn): 'open' (guest linked), 'peers' (lobby list), 'start', 'desync', 'close', 'leave';
 * drives(team), active, team, isHost, started, pack / unpack, queueInput, takeInput, flush, hash, due, ctl_due(k),
 * stepNow (set by main.js), close(), stats(). */
(function (SS) {
  'use strict';
  const NT = SS.net = { active: false, team: -1, isHost: false, mode: null, seats: null, code: null, name: '', started: false, stepNow: null };
  const HASH_EVERY = 120, LAN_CFG = { iceServers: [] }, PREFIX = 'burrowbrawl3d-v1-';
  // the PoC's ICE servers (public STUN + the PeerJS TURN relay) for room-code play over the internet
  const NET_CFG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }] };
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let links = [], hostLink = null, pendingRtc = null, peer = null, handlers = {}, inbox = new Map(), outbox = [], outK0 = -1, hashes = new Map(), ctlQ = [];
  let stats = { sent: 0, recv: 0, desync: 0, hashOk: 0 }, linkId = 0;
  const enc = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  const dec = s => JSON.parse(decodeURIComponent(escape(atob(s.trim()))));
  NT.on = (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); };
  const fire = (name, a) => { for (const f of handlers[name] || []) f(a); };

  // the Input struct as a compact array (field order fixed; P2 adds the arsenal fields at the end)
  const KEYS = ['move', 'up', 'down', 'jump', 'backflip', 'fire_pressed', 'fire_held', 'weapon', 'rotate', 'rotate_mouse', 'fine', 'align_step', 'align_refocus', 'align_id', 'end_turn', 'inspect',
    'fuse', 'tgt', 'ts', 'ty', 'sdir', 'gang', 'drop', 'wsel', 'aimset', 'aimv', 'face'];
  NT.pack = inp => KEYS.map(k => inp[k] || 0);
  NT.unpack = (a, inp) => { KEYS.forEach((k, i) => { const v = a[i]; inp[k] = k === 'weapon' ? (typeof v === 'string' ? v : '') : (typeof v === 'number' && Number.isFinite(v) ? v : 0); }); inp.reset = 0; return inp; };

  /* ---------- links (one per remote peer; send / close hide the transport) ---------- */
  function makeLink(send, close, label) { return { id: ++linkId, send, close, open: false, name: label || 'Friend', team: -1 }; }
  function sendTo(l, o) { if (l && l.open) { try { l.send(o); stats.sent++; } catch (e) { /* closed */ } } }
  NT.send = o => { if (NT.isHost) for (const l of links) sendTo(l, o); else sendTo(hostLink, o); };
  function opened(l) {
    if (l.open) return; l.open = true;
    if (NT.isHost) { links.push(l); NT.active = true; lobby(); fire('peers', NT.peers()); }
    else { hostLink = l; NT.active = true; sendTo(l, { t: 'hello', name: NT.name || 'Friend' }); fire('open'); }
  }
  function closed(l) {
    if (!l.open) return; l.open = false;
    if (NT.isHost) {
      links = links.filter(x => x !== l);
      if (l.team >= 0) fire('leave', { team: l.team, name: l.name, lastK: l.lastK == null ? -1 : l.lastK });
      lobby(); fire('peers', NT.peers());
      NT.active = links.length > 0;
    } else { NT.active = false; hostLink = null; fire('close'); }
  }
  function lobby() { NT.send({ t: 'lobby', names: [NT.name || 'Host'].concat(links.map(l => l.name)) }); }
  NT.peers = () => [{ id: 0, name: NT.name || 'Host', team: 0 }].concat(links.map(l => ({ id: l.id, name: l.name, team: l.team })));
  // peer data is untrusted: malformed messages are dropped; main.js whitelists the settings
  function onData(l, raw) {
    let m = raw; if (typeof raw === 'string') { try { m = JSON.parse(raw); } catch (e) { return; } }
    if (!m || typeof m !== 'object') return;
    stats.recv++; stats.lastRecv = performance.now();
    // P24.12 link health (PoC net panel): ping / pong every 2 s, the round trip smoothed
    if (m.t === 'ping' && typeof m.ts === 'number') { sendTo(l, { t: 'pong', ts: m.ts }); return; }
    if (m.t === 'pong' && typeof m.ts === 'number') { const r = performance.now() - m.ts; if (r >= 0 && r < 60000) stats.rtt = stats.rtt ? stats.rtt * 0.7 + r * 0.3 : r; return; }
    if (NT.isHost) {
      if (m.t === 'hello' && typeof m.name === 'string') { l.name = m.name.slice(0, 18) || 'Friend'; lobby(); fire('peers', NT.peers()); }
      else if (m.t === 'ins' && Number.isInteger(m.k0) && Array.isArray(m.a) && l.team >= 0) {
        m.a.forEach((a, j) => { if (Array.isArray(a)) inbox.set(m.k0 + j, a); });
        l.lastK = Math.max(l.lastK == null ? -1 : l.lastK, m.k0 + m.a.length - 1);
        for (const o of links) if (o !== l) sendTo(o, { t: 'ins', k0: m.k0, a: m.a });      // relay to the other guests
      } else if (m.t === 'hash' && Number.isInteger(m.k)) remoteHash(m.k, m.h, l.id);
      else if (m.t === 'bye') closed(l);
    } else {
      if (m.t === 'start' && m.settings && typeof m.settings === 'object' && Array.isArray(m.seats) && Number.isInteger(m.you)) {
        NT.clearQueues(); NT.seats = m.seats.map(x => (x === 'cpu' ? 'cpu' : 'human')); NT.team = m.you; NT.started = true; fire('start', m.settings);
      } else if (m.t === 'lobby' && Array.isArray(m.names)) fire('peers', m.names.slice(0, 8).map((n, i) => ({ id: i, name: String(n).slice(0, 18) })));
      else if (m.t === 'ins' && Number.isInteger(m.k0) && Array.isArray(m.a)) m.a.forEach((a, j) => { if (Array.isArray(a)) inbox.set(m.k0 + j, a); });
      else if (m.t === 'hash' && Number.isInteger(m.k)) remoteHash(m.k, m.h, 0);
      else if (m.t === 'ctl' && Number.isInteger(m.team) && Number.isInteger(m.k)) ctlQ.push({ team: m.team, k: m.k });
      else if (m.t === 'bye') closed(l);
    }
  }

  /* ---------- transport 1: room codes over PeerJS (the PoC's online friend matches) ---------- */
  function loadPeer() {
    if (window.Peer) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'vendor/peerjs.min.js';
      s.onload = () => (window.Peer ? res() : rej(new Error('PeerJS did not load')));
      s.onerror = () => rej(new Error('vendor/peerjs.min.js is missing'));
      document.head.appendChild(s);
    });
  }
  function wrapConn(c) {
    const l = makeLink(o => c.send(o), () => { try { c.close(); } catch (e) { /* */ } }, 'Friend');
    c.on('open', () => opened(l)); c.on('data', d => onData(l, d)); c.on('close', () => closed(l)); c.on('error', () => closed(l));
    return l;
  }
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
  NT.room_host = async function (name) {
    reset(); NT.isHost = true; NT.team = 0; NT.mode = 'room'; NT.name = (name || 'Host').slice(0, 18);
    await loadPeer();
    for (let tries = 0; tries < 4; tries++) {
      let code = ''; for (let i = 0; i < 4; i++) code += ALPHA[Math.floor(Math.random() * ALPHA.length)];   // (lobby randomness, not sim)
      try {
        peer = await withTimeout(new Promise((res, rej) => {
          const p = new window.Peer(PREFIX + code, { config: NET_CFG, debug: 0 });
          p.on('open', () => res(p)); p.on('error', e => { if (e && e.type === 'unavailable-id') { p.destroy(); rej(new Error('taken')); } else rej(e); });
        }), 9000, 'The matchmaking server did not answer (room codes need the internet; LAN codes do not).');
        peer.on('connection', c => wrapConn(c));
        peer.on('disconnected', () => { try { peer.reconnect(); } catch (e) { /* */ } });
        NT.code = code; return code;
      } catch (e) { if (e.message !== 'taken') throw e; }
    }
    throw new Error('No free room code, try again.');
  };
  NT.room_join = async function (code, name) {
    reset(); NT.isHost = false; NT.mode = 'room'; NT.name = (name || 'Friend').slice(0, 18);
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length !== 4) throw new Error('Room codes have 4 characters.');
    await loadPeer();
    peer = await withTimeout(new Promise((res, rej) => { const p = new window.Peer({ config: NET_CFG, debug: 0 }); p.on('open', () => res(p)); p.on('error', rej); }),
      9000, 'The matchmaking server did not answer (room codes need the internet; LAN codes do not).');
    await withTimeout(new Promise((res, rej) => {
      const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      wrapConn(c); c.on('open', () => res());
      peer.on('error', e => rej(new Error(e && e.type === 'peer-unavailable' ? 'No room with that code.' : String(e && e.message || e))));
    }), 15000, 'Could not reach that room.');
  };

  /* ---------- transport 2: LAN copy / paste codes (no server; the host makes one offer per guest) ---------- */
  function gathered(p) {
    return new Promise(res => {
      if (p.iceGatheringState === 'complete') return res();
      const f = () => { if (p.iceGatheringState === 'complete') { p.removeEventListener('icegatheringstatechange', f); res(); } };
      p.addEventListener('icegatheringstatechange', f);
      setTimeout(res, 4000);                              // LAN host candidates arrive at once; never hang the UI
    });
  }
  function wireRtc(pc, ch) {
    const l = makeLink(o => ch.send(JSON.stringify(o)), () => { try { pc.close(); } catch (e) { /* */ } }, 'LAN friend');
    ch.onopen = () => opened(l); ch.onclose = () => closed(l); ch.onmessage = e => onData(l, e.data);
    // a vanished peer: the data channel itself only notices after the SCTP timeout (~30 s)
    let t = null;
    pc.addEventListener('connectionstatechange', () => {
      const cs = pc.connectionState;
      if (cs === 'failed' || cs === 'closed') closed(l);
      else if (cs === 'disconnected') { clearTimeout(t); t = setTimeout(() => { if (pc.connectionState !== 'connected') closed(l); }, 4000); }
    });
    return l;
  }
  NT.host = async function (settings, name) {
    if (!NT.isHost || NT.mode !== 'lan') { reset(); NT.isHost = true; NT.team = 0; NT.mode = 'lan'; NT.name = (name || 'Host').slice(0, 18); }
    if (settings) NT.settings = settings;
    const pc = new RTCPeerConnection(LAN_CFG);
    wireRtc(pc, pc.createDataChannel('ss', { ordered: true }));
    pendingRtc = pc;
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    return enc({ sdp: pc.localDescription.sdp, type: 'offer' });
  };
  NT.accept = async function (answer) { if (!pendingRtc) throw new Error('host first'); const pc = pendingRtc; pendingRtc = null; await pc.setRemoteDescription(dec(answer)); };
  NT.join = async function (offer, name) {
    reset(); NT.isHost = false; NT.mode = 'lan'; NT.name = (name || 'Friend').slice(0, 18);
    const pc = new RTCPeerConnection(LAN_CFG);
    pc.ondatachannel = e => wireRtc(pc, e.channel);
    await pc.setRemoteDescription(dec(offer));
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return enc({ sdp: pc.localDescription.sdp, type: 'answer' });
  };

  /* ---------- the match: seats, inputs, hashes, the CPU takeover ---------- */
  // host: team 0 = the host, each guest the next team (join order) as long as there are teams; the rest are CPU
  // teams (whatever the setup said: a human seat needs a person). Returns the settings everybody plays.
  NT.start = function (settings) {
    const n = Math.max(2, Math.min(4, settings.teams | 0 || 2)), seats = [], ctl = [], names = (settings.names || []).slice(0, 4);
    for (const l of links) l.team = -1;
    let g = 0;
    for (let t = 0; t < n; t++) {
      if (t === 0) { seats.push('human'); ctl.push('human'); names[0] = NT.name || names[0]; continue; }
      const l = links[g];
      if (l) { l.team = t; seats.push('human'); ctl.push('human'); names[t] = l.name; g++; }
      else { seats.push('cpu'); ctl.push('cpu'); }
    }
    const st = Object.assign({}, settings, { teams: n, ctl, names, cpu: 'off' });
    NT.settings = st; NT.seats = seats; NT.team = 0; NT.started = true;
    NT.clearQueues();
    for (const l of links) sendTo(l, { t: 'start', settings: st, seats, you: l.team });     // (spectators: you = -1)
    return st;
  };
  NT.drives = team => team === NT.team || (NT.isHost && !!NT.seats && NT.seats[team] === 'cpu');
  NT.clearQueues = () => { inbox.clear(); outbox = []; outK0 = -1; hashes.clear(); ctlQ = []; };
  /* the driver's inputs: queued per step, sent once per frame (flush); a batch is contiguous (k0 + j) */
  NT.queueInput = (k, packed) => { if (outK0 >= 0 && k !== outK0 + outbox.length) NT.flush(); if (outK0 < 0) outK0 = k; outbox.push(packed); };
  let pingT = 0;
  NT.flush = () => {
    if (outbox.length) { NT.send({ t: 'ins', k0: outK0, a: outbox }); outbox = []; outK0 = -1; }
    const now = performance.now(); if (NT.active && now - pingT > 2000) { pingT = now; NT.send({ t: 'ping', ts: now }); }
  };
  NT.takeInput = k => { const a = inbox.get(k); if (a) inbox.delete(k); return a || null; };
  NT.pending = () => inbox.size;
  // the CPU takeover: the host fixes the step and tells everybody; main.js applies it before step k
  // (k >= one past the last input of that seat the host relayed: a guest may already have played those steps)
  NT.on('leave', ({ team, lastK }) => { if (!NT.isHost || !NT.started || team < 0 || !NT.stepNow) return; const k = Math.max(NT.stepNow(), lastK + 1); ctlQ.push({ team, k }); NT.send({ t: 'ctl', team, k }); });
  NT.ctl_due = k => { const due = ctlQ.filter(c => c.k <= k); if (due.length) { ctlQ = ctlQ.filter(c => c.k > k); for (const c of due) if (NT.seats) NT.seats[c.team] = 'cpu'; } return due; };
  /* state hashes every HASH_EVERY steps: the host compares with each guest, a guest with the host */
  function judge(k, lh, rh) { if (lh !== rh) { stats.desync++; fire('desync', { k, l: lh, r: rh }); } else stats.hashOk++; }
  function remoteHash(k, h, from) { const mine = hashes.get('L' + k); if (mine != null) judge(k, mine, h); else hashes.set('R' + from + ':' + k, h); }
  NT.due = k => k % HASH_EVERY === 0;
  NT.hash = (k, h) => {
    if (k % HASH_EVERY) return;
    hashes.set('L' + k, h);
    for (const [key, rh] of [...hashes]) if (key[0] === 'R' && key.endsWith(':' + k)) { judge(k, h, rh); hashes.delete(key); }
    NT.send({ t: 'hash', k, h });
    hashes.delete('L' + (k - 40 * HASH_EVERY));
  };
  NT.close = () => {
    NT.send({ t: 'bye' });
    for (const l of links) l.close(); if (hostLink) hostLink.close();
    if (pendingRtc) { try { pendingRtc.close(); } catch (e) { /* */ } }
    reset();
  };
  function reset() {
    NT.active = false; NT.started = false; NT.seats = null; NT.code = null; links = []; hostLink = null; pendingRtc = null;
    if (peer) { try { peer.destroy(); } catch (e) { /* */ } peer = null; }
    NT.clearQueues(); stats = { sent: 0, recv: 0, desync: 0, hashOk: 0 };
  }
  // leaving the page says goodbye (the others turn this seat into a CPU team at once)
  if (typeof addEventListener === 'function') addEventListener('pagehide', () => { if (NT.active) NT.send({ t: 'bye' }); });
  NT.stats = () => Object.assign({ active: NT.active, team: NT.team, host: NT.isHost, mode: NT.mode, peers: links.length, inbox: inbox.size }, stats);
})(window.SS = window.SS || {});
