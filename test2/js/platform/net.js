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
  const NT =
    SS.net = { active: false, team: -1, isHost: false, mode: null, seats: null, code: null, name: '', started: false, stepNow: null };
  const HASH_EVERY = 120, LAN_CFG = { iceServers: [] }, PREFIX = 'burrowbrawl3d-v1-';
  // the PoC's ICE servers (public STUN + the PeerJS TURN relay) for room-code play over the internet
  const NET_CFG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }]
  };
  const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let links = [],
    hostLink = null,
    pendingRtc = null,
    peer = null,
    handlers = {},
    inbox = new Map(),
    outbox = [],
    outK0 = -1,
    hashes = new Map(),
    ctlQ = [];
  let stats = { sent: 0, recv: 0, desync: 0, hashOk: 0, resync: 0 }, linkId = 0;
  /* P103: inputs already played (own + received) by step, so a resync that rolls the guest back to the host's step can
   * replay them; steps in `replay` are own inputs to re-use (never re-sampled) */
  const DONE_MAX = 8000, done = new Map(), replay = new Set(), mine = new Set();
  /* P38 D5 / D7: every ins / hash / ctl message carries the match id `m` (the host picks a new one at every start and
   * sends it in 'start'); messages of another match (in flight over a rematch, or for a peer that never got 'start')
   * are dropped. Untrusted sizes are bounded: a batch holds <= MAX_BATCH inputs at steps 0..MAX_STEP, the inbox <=
   * MAX_INBOX entries (a hostile huge k0 used to grow it without limit), remote hashes <= MAX_HASHES pending
   * entries. */
  const MAX_BATCH = 2000, MAX_STEP = 4000000, MAX_INBOX = 30000, MAX_HASHES = 2048;
  let matchId = 0;
  /* P38 R6 (R7): a build id (C.BUILD + a hash of the arsenal / biome tables) goes in 'hello' and 'start': peers of
   * different builds
   * would only desync, so the host refuses a guest of another build and a guest refuses a 'start' of another build,
   * with a message. */
  function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  let buildId = '';
  NT.build = () => {
    if (buildId) return buildId;
    const C = SS.CFG;
    let t = '';
    try {
      t = JSON.stringify([C.STEP, C.ARSENAL_ORDER, C.ARSENAL, C.BIOMES, C.TEAMS, C.DENSITY]);
    } catch (e) {
      t = '';
    }
    return (buildId = String(C.BUILD || '?') + '-' + fnv(t).toString(16));
  };
  /* R13: inputs of a guest are accepted only in a window of steps around the host's own step (a hostile huge k0 / a
   * flood of
   * far-future steps used to fill the inbox and get later legitimate inputs refused). A guest that is up to INS_AHEAD
   * steps (5.5 min) ahead of the host is legitimate (the host was in the background). Guests trust the host's relay (no
   * window). */
  const INS_AHEAD = 20000;
  function putIns(m, windowed) {
    if (!(m.k0 >= 0 && m.k0 <= MAX_STEP) || m.a.length > MAX_BATCH) return false;
    if (windowed && NT.stepNow && m.k0 > (NT.stepNow() | 0) + INS_AHEAD) return false;
    m.a.forEach((a, j) => {
      if (Array.isArray(a) && a.length <= 64 && (inbox.size < MAX_INBOX || inbox.has(m.k0 + j))) inbox.set(m.k0 + j, a);
    });
    return true;
  }
  const enc = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  const dec = s => JSON.parse(decodeURIComponent(escape(atob(s.trim()))));
  NT.on = (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); };
  const fire = (name, a) => {
    for (const f of handlers[name] || []) f(a);
  };

  // the Input struct as a compact array (field order fixed; P2 adds the arsenal fields at the end)
  const KEYS = ['move', 'up', 'down', 'jump', 'backflip', 'jet', 'fire_pressed', 'fire_held', 'weapon', 'rotate', 'rotate_mouse', 'fine',
    'align_step', 'align_crate', 'align_refocus', 'align_id', 'end_turn', 'inspect',
    'fuse', 'tgt', 'ts', 'ty', 'sdir', 'gang', 'drop', 'wsel', 'aimset', 'aimv', 'face', 'adj', 'gturn', 'gear'];
  /* wire format (P38 R7): the Input struct as an array of numbers in KEYS order; `weapon` travels as an i16 weapon
   * INDEX + 1 (C.WEAPON_KEYS; 0 = no change), never the
   * string. JSON numbers are f64 today; the values are small ints / metres (a binary port quantises: i8 axes / flags,
   * f32 for ts / ty / aimv, u8 fuse). */
  // (P103: a boolean would be 0 on the receiver but 1 (sanitize) on the driver)
  NT.pack = inp => KEYS.map(
    k => (k === 'weapon' ? (inp.weapon ? SS.CFG.WEAPON_KEYS.indexOf(inp.weapon) + 1 : 0) : inp[k] === true ? 1 : inp[k] || 0)
  );
  // P38 D2: untrusted: every field forced into its legal range (sim.sanitize_input)
  NT.unpack = (a, inp) => {
    KEYS.forEach((k, i) => {
      const v = a[i];
      inp[k] = k === 'weapon'
        ? (typeof v === 'number' && v >= 1 && v <= SS.CFG.WEAPON_KEYS.length ? SS.CFG.WEAPON_KEYS[v - 1] : '')
        : (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    });
    inp.reset = 0;
    return SS.sim && SS.sim.sanitize_input ? SS.sim.sanitize_input(inp) : inp;
  };

  /* ---------- links (one per remote peer; send / close hide the transport) ---------- */
  function makeLink(send, close, label, buffered) {
    return { id: ++linkId, send, close, buffered: buffered || null, open: false, name: label || 'Friend', team: -1, rsT: -1e9, chatT: [] };
  }
  function sendTo(l, o) {
    if (l && l.open) {
      try {
        l.send(o);
        stats.sent++;
      } catch (e) { /* closed */ }
    }
  }
  NT.send = o => {
    if (o.t === 'ins' || o.t === 'hash' || o.t === 'ctl') o.m = matchId;
    if (NT.isHost)
      for (const l of links) sendTo(l, o);
    else sendTo(hostLink, o);
  };
  function opened(l) {
    if (l.open) return;
    l.open = true;
    if (NT.isHost) {
      links.push(l);
      NT.active = true;
      lobby();
      fire('peers', NT.peers());
    }
    else {
      hostLink = l;
      NT.active = true;
      sendTo(l, { t: 'hello', name: NT.name || 'Friend', build: NT.build() });
      fire('open');
    }
  }
  function closed(l) {
    if (!l.open) return;
    l.open = false;
    if (NT.isHost) {
      links = links.filter(x => x !== l);
      if (l.team >= 0) fire('leave', { team: l.team, name: l.name, lastK: l.lastK == null ? -1 : l.lastK });
      sysChat(l.name + ' left');
      lobby(); fire('peers', NT.peers());
      NT.active = links.length > 0;
    } else {
      NT.active = false;
      hostLink = null;
      fire('close');
    }
  }
  function lobby() { NT.send({ t: 'lobby', names: [NT.name || 'Host'].concat(links.map(l => l.name)) }); }
  NT.peers = () => [{ id: 0, name: NT.name || 'Host', team: 0 }].concat(links.map(l => ({ id: l.id, name: l.name, team: l.team })));
  // peer data is untrusted: malformed messages are dropped; main.js whitelists the settings
  function onData(l, raw) {
    let m = raw;
    if (typeof raw === 'string') {
      try {
        m = JSON.parse(raw);
      } catch (e) {
        return;
      }
    }
    if (!m || typeof m !== 'object') return;
    stats.recv++; stats.lastRecv = performance.now();
    // P24.12 link health (PoC net panel): ping / pong every 2 s, the round trip smoothed
    if (m.t === 'ping' && typeof m.ts === 'number') {
      sendTo(l, { t: 'pong', ts: m.ts });
      return;
    }
    if (m.t === 'pong' && typeof m.ts === 'number') {
      const r = performance.now() - m.ts;
      if (r >= 0 && r < 60000) stats.rtt = stats.rtt ? stats.rtt * 0.7 + r * 0.3 : r;
      return;
    }
    // another match (D5)
    if ((m.t === 'ins' || m.t === 'hash' || m.t === 'ctl' || m.t === 'rsq' || m.t === 'rss' || m.t === 'rsc') && m.m !== matchId) return;
    if (NT.isHost) {
      if (m.t === 'hello' && typeof m.name === 'string') {
        if (m.build !== NT.build()) {
          sendTo(l, {
            t: 'refuse',
            msg: 'This game build differs from the host\'s ('
              + String(m.build || 'unknown').slice(0, 24)
              + ' vs '
              + NT.build()
              + '). Both players need the same version.'
          });
          fire('refused', { name: String(m.name).slice(0, 18), build: String(m.build || '') });
          const lk = l;
          l.open = false;
          links = links.filter(x => x !== lk);
          setTimeout(() => lk.close(), 300);
          NT.active = links.length > 0;
          lobby();
          fire('peers', NT.peers());
          return;
        }
        l.name = m.name.slice(0, 18) || 'Friend';
        lobby();
        fire('peers', NT.peers());
        sysChat(l.name + ' joined');
      }
      else if (m.t === 'ins' && Number.isInteger(m.k0) && Array.isArray(m.a) && l.team >= 0) {
        if (!putIns(m, true)) return;
        l.lastK = Math.max(l.lastK == null ? -1 : l.lastK, m.k0 + m.a.length - 1);
        // relay to the other guests
        for (const o of links)
          if (o !== l) sendTo(o, { t: 'ins', k0: m.k0, a: m.a, m: matchId });
      } else if (m.t === 'hash' && Number.isInteger(m.k)) remoteHash(m.k, m.h, l.id);
      else if (m.t === 'rsq' && NT.started && l.team >= 0) hostResync(l, m.id);
      else if (m.t === 'chat' && typeof m.x === 'string') hostChat(l, m.x);
      else if (m.t === 'bye') closed(l);
    } else {
      if (m.t === 'refuse' && typeof m.msg === 'string') { fire('refused', { msg: m.msg.slice(0, 200) }); }
      else if (m.t === 'start' && m.build !== NT.build()) {
        fire('refused', {
          msg: 'The host runs another game build ('
            + String(m.build || 'unknown').slice(0, 24)
            + ' vs '
            + NT.build()
            + '). Both players need the same version.'
        });
      }
      else if (m.t === 'start' && m.settings && typeof m.settings === 'object' && Array.isArray(m.seats) && Number.isInteger(m.you)) {
        matchId = Number.isInteger(m.mid) ? m.mid : 0;
        NT.clearQueues();
        NT.seats = m.seats.map(x => (x === 'cpu' ? 'cpu' : 'human'));
        NT.team = m.you;
        NT.started = true;
        fire('start', m.settings);
      } else if (m.t === 'lobby' && Array.isArray(m.names))
        fire('peers', m.names.slice(0, 8).map((n, i) => ({ id: i, name: String(n).slice(0, 18) })));
      else if (m.t === 'ins' && Number.isInteger(m.k0) && Array.isArray(m.a)) putIns(m);
      else if (m.t === 'hash' && Number.isInteger(m.k)) remoteHash(m.k, m.h, 0);
      else if (m.t === 'rss') guestRss(m);
      else if (m.t === 'rsc') guestRsc(m);
      else if (m.t === 'chat' && typeof m.x === 'string') guestChat(m);
      else if (m.t === 'ctl' && Number.isInteger(m.team) && Number.isInteger(m.k)) ctlQ.push({ team: m.team, k: m.k });
      else if (m.t === 'bye') closed(l);
    }
  }

  /* ---------- transport 1: room codes over PeerJS (the PoC's online friend matches) ---------- */
  function loadPeer() {
    if (window.Peer) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'vendor/peerjs.min.js';
      s.onload = () => (window.Peer ? res() : rej(new Error('PeerJS did not load')));
      s.onerror = () => rej(new Error('vendor/peerjs.min.js is missing'));
      document.head.appendChild(s);
    });
  }
  function wrapConn(c) {
    const l = makeLink(o => c.send(o), () => {
      try {
        c.close();
      } catch (e) { /* */ }
    }, 'Friend', () => (c.dataChannel ? c.dataChannel.bufferedAmount | 0 : 0));
    c.on('open', () => opened(l));
    c.on('data', d => onData(l, d));
    c.on('close', () => closed(l));
    c.on('error', () => closed(l));
    return l;
  }
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
  NT.room_host = async function (name) {
    reset();
    NT.isHost = true;
    NT.team = 0;
    NT.mode = 'room';
    NT.name = (name || 'Host').slice(0, 18);
    await loadPeer();
    for (let tries = 0; tries < 4; tries++) {
      // (lobby randomness, not sim)
      let code = '';
      for (let i = 0; i < 4; i++) code += ALPHA[Math.floor(Math.random() * ALPHA.length)];
      try {
        let np = null;
        try {
          peer = await withTimeout(new Promise((res, rej) => {
            const p = np = new window.Peer(PREFIX + code, { config: NET_CFG, debug: 0 });
            p.on('open', () => res(p));
            p.on('error', e => {
              if (e && e.type === 'unavailable-id') {
                p.destroy();
                rej(new Error('taken'));
              } else rej(e);
            });
          }), 9000, 'The matchmaking server did not answer (room codes need the internet; LAN codes do not).');
        } catch (e) {
          if (np) {
            try {
              np.destroy();
            } catch (e2) { /* */ }
            // (R11: a timed-out Peer must not keep the room)
          }
          throw e;
        }
        peer.on('connection', c => wrapConn(c));
        peer.on('disconnected', () => {
          try {
            peer.reconnect();
          } catch (e) { /* */ }
        });
        NT.code = code; return code;
      } catch (e) {
        if (e.message !== 'taken') throw e;
      }
    }
    throw new Error('No free room code, try again.');
  };
  NT.room_join = async function (code, name) {
    reset();
    NT.isHost = false;
    NT.mode = 'room';
    NT.name = (name || 'Friend').slice(0, 18);
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length !== 4) throw new Error('Room codes have 4 characters.');
    await loadPeer();
    let np = null;
    try {
      peer = await withTimeout(new Promise((res, rej) => {
        const p = np = new window.Peer({ config: NET_CFG, debug: 0 });
        p.on('open', () => res(p));
        p.on('error', rej);
      }),
        9000, 'The matchmaking server did not answer (room codes need the internet; LAN codes do not).');
    } catch (e) {
      if (np) {
        try {
          np.destroy();
        } catch (e2) { /* */ }
      }
      throw e;
    }
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
      const f = () => {
        if (p.iceGatheringState === 'complete') {
          p.removeEventListener('icegatheringstatechange', f);
          res();
        }
      };
      p.addEventListener('icegatheringstatechange', f);
      setTimeout(res, 4000);                              // LAN host candidates arrive at once; never hang the UI
    });
  }
  function wireRtc(pc, ch) {
    const l = makeLink(o => ch.send(JSON.stringify(o)), () => {
      try {
        pc.close();
      } catch (e) { /* */ }
    }, 'LAN friend', () => ch.bufferedAmount | 0);
    ch.onopen = () => opened(l); ch.onclose = () => closed(l); ch.onmessage = e => onData(l, e.data);
    // a vanished peer: the data channel itself only notices after the SCTP timeout (~30 s)
    let t = null;
    pc.addEventListener('connectionstatechange', () => {
      const cs = pc.connectionState;
      if (cs === 'failed' || cs === 'closed') closed(l);
      else if (cs === 'disconnected') {
        clearTimeout(t);
        t = setTimeout(() => {
          if (pc.connectionState !== 'connected') closed(l);
        }, 4000);
      }
    });
    return l;
  }
  NT.host = async function (settings, name) {
    if (!NT.isHost || NT.mode !== 'lan') {
      reset();
      NT.isHost = true;
      NT.team = 0;
      NT.mode = 'lan';
      NT.name = (name || 'Host').slice(0, 18);
    }
    if (settings) NT.settings = settings;
    const pc = new RTCPeerConnection(LAN_CFG);
    wireRtc(pc, pc.createDataChannel('ss', { ordered: true }));
    pendingRtc = pc;
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    return enc({ sdp: pc.localDescription.sdp, type: 'offer' });
  };
  NT.accept = async function (answer) {
    if (!pendingRtc) throw new Error('host first');
    const pc = pendingRtc;
    pendingRtc = null;
    await pc.setRemoteDescription(dec(answer));
  };
  NT.join = async function (offer, name) {
    reset();
    NT.isHost = false;
    NT.mode = 'lan';
    NT.name = (name || 'Friend').slice(0, 18);
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
      if (t === 0) {
        seats.push('human');
        ctl.push('human');
        names[0] = NT.name || names[0];
        continue;
      }
      const l = links[g];
      if (l) {
        l.team = t;
        seats.push('human');
        ctl.push('human');
        names[t] = l.name;
        g++;
      }
      else {
        seats.push('cpu');
        ctl.push('cpu');
      }
    }
    const st = Object.assign({}, settings, { teams: n, ctl, names, cpu: 'off' });
    NT.settings = st;
    NT.seats = seats;
    NT.team = 0;
    NT.started = true;
    matchId = 1 + Math.floor(Math.random() * 2000000000);                  // (lobby randomness, not sim)
    NT.clearQueues();
    // (spectators: you = -1)
    for (const l of links) sendTo(l, { t: 'start', settings: st, seats, you: l.team, mid: matchId, build: NT.build() });
    return st;
  };
  NT.drives = team => team === NT.team || (NT.isHost && !!NT.seats && NT.seats[team] === 'cpu');
  NT.clearQueues = () => {
    inbox.clear();
    outbox = [];
    outK0 = -1;
    hashes.clear();
    ctlQ = [];
    done.clear();
    replay.clear();
    mine.clear();
    rs = rs_make();
  };
  /* the driver's inputs: queued per step, sent once per frame (flush); a batch is contiguous (k0 + j) */
  NT.queueInput = (k, packed) => {
    done.set(k, packed);
    mine.add(k);
    if (done.size > DONE_MAX) {
      const f = done.keys().next().value;
      done.delete(f);
      mine.delete(f);
    }
    if (outK0 >= 0 && k !== outK0 + outbox.length) NT.flush();
    if (outK0 < 0) outK0 = k;
    outbox.push(packed);
  };
  let pingT = 0;
  NT.flush = () => {
    if (outbox.length) {
      NT.send({ t: 'ins', k0: outK0, a: outbox });
      outbox = [];
      outK0 = -1;
    }
    const now = performance.now();
    NT.resync_tick(now);
    if (NT.active && now - pingT > 2000) {
      pingT = now;
      NT.send({ t: 'ping', ts: now });
    }
  };
  NT.takeInput = k => {
    const a = inbox.get(k);
    if (a) {
      inbox.delete(k);
      done.set(k, a);
      if (done.size > DONE_MAX) done.delete(done.keys().next().value);
    }
    // D7: steps already played are never needed
    if (inbox.size > 2000)
      for (const key of [...inbox.keys()])
        if (key < k) inbox.delete(key);
    return a || null;
  };
  NT.pending = () => inbox.size;
  // the CPU takeover: the host fixes the step and tells everybody; main.js applies it before step k
  // (k >= one past the last input of that seat the host relayed: a guest may already have played those steps)
  NT.on('leave', ({ team, lastK }) => {
    if (!NT.isHost || !NT.started || team < 0 || !NT.stepNow) return;
    const k = Math.max(NT.stepNow(), lastK + 1);
    ctlQ.push({ team, k });
    NT.send({ t: 'ctl', team, k });
  });
  /* R8: the host waits for the input of step k of a seat that is a remote person. When it has not arrived for stall_ms
   * of wall time (a
   * background tab: rAF stopped, so the lockstep waits for ever; its link still answers pings, so link silence is no
   * test) the HOST decides the take-over: it queues {team, k = its own current step} and sends the 'ctl' message; every
   * peer applies it at step k (ctl_due), exactly like a left friend. Returns the guest's name once when it fires, else
   * ''. Called by main.js every frame it is waiting. */
  let stallT = { team: -1, k: -1, t: 0 };
  NT.stall_ms = 15000;                                    // (a test may lower it)
  NT.stalled = (team, k, now) => {
    if (!NT.isHost || !NT.started || !NT.seats || team === NT.team || NT.seats[team] !== 'human') return '';
    const l = links.find(x => x.team === team);
    if (!l) return '';
    if (stallT.team !== team || stallT.k !== k) {
      stallT = { team, k, t: now };
      return '';
    }
    if (now - stallT.t < NT.stall_ms) return '';
    // (its later inputs are ignored)
    const name = l.name;
    l.team = -1;
    ctlQ.push({ team, k }); NT.send({ t: 'ctl', team, k });
    stallT = { team: -1, k: -1, t: 0 };
    return name;
  };
  NT.ctl_due = k => {
    const due = ctlQ.filter(c => c.k <= k);
    if (due.length) {
      ctlQ = ctlQ.filter(c => c.k > k);
      for (const c of due)
        if (NT.seats) NT.seats[c.team] = 'cpu';
    }
    return due;
  };
  /* state hashes every HASH_EVERY steps: the host compares with each guest, a guest with the host */
  function judge(k, lh, rh, from) {
    if (!NT.isHost && rs.state === 'wait') return;                               // a resync is on its way: old hashes mean nothing
    if (lh !== rh) {
      stats.desync++;
      fire('desync', { k, l: lh, r: rh, from: from || 0, name: linkName(from) });
      if (!NT.isHost) guestDesync(k);
    }
    else {
      stats.hashOk++;
      if (!NT.isHost && rs.state === 'verify') {
        rs.state = 'ok';
        rs.tries = 0;
        fire('resynced', { k, ms: rs.ms, bytes: rs.bytes, raw: rs.raw });
      }
    }
  }
  function linkName(id) {
    const l = links.find(x => x.id === id);
    return l ? l.name : '';
  }
  function remoteHash(k, h, from) {
    if (typeof h !== 'number' || k < 0 || k > MAX_STEP || k % HASH_EVERY) return;
    const mine = hashes.get('L' + k);
    if (mine != null) judge(k, mine, h, from);
    else if (hashes.size < MAX_HASHES) hashes.set('R' + from + ':' + k, h);
  }
  NT.due = k => k % HASH_EVERY === 0;
  NT.hash = (k, h) => {
    if (k % HASH_EVERY) return;
    hashes.set('L' + k, h);
    for (const [key, rh] of [...hashes])
      if (key[0] === 'R' && key.endsWith(':' + k)) {
        judge(k, h, rh, +key.slice(1, key.indexOf(':')));
        hashes.delete(key);
      }
    NT.send({ t: 'hash', k, h });
    hashes.delete('L' + (k - 40 * HASH_EVERY));
    // D7: remote hashes of steps long past
    for (const key of [...hashes.keys()])
      if (key[0] === 'R' && +key.slice(key.indexOf(':') + 1) < k - 40 * HASH_EVERY) hashes.delete(key);
  };

  /* ---------- P103: authoritative resync (the host is the truth) ----------
   * A guest whose hash differs from the host's asks for the host's state: {t:'rsq', m}. The host captures
   * SS.sim.snapshot at ITS current step k (NT.provide() -> {k, snap}, set by main.js), packs it (netsnap: binary +
   * deflate) and sends a header {t:'rss', id, k, z, raw, n, seats, ctl} and n chunks {t:'rsc', id, i, d: base64}. The
   * guest unpacks, fires 'resync' {k, snap}; main.js restores the state at the next frame boundary and calls
   * NT.resync_applied(k, info): the inputs of the steps >= k that the guest had already played / received come back
   * from `done`, own inputs are replayed (never re-sampled, never re-sent), the hash history after k is dropped and the
   * guest verifies against the next host hash ('resynced' event). A failed verification retries (3 tries, then ONE
   * 'resync_failed' event until the player asks again with NT.resync_request('manual')). The host never pulls state
   * from a guest. The guest re-requests after RS_TIMEOUT ms without a complete snapshot. */
  const CHUNK = 12000, RS_TRIES = 3, RS_GAP = 2500;
  NT.rs_timeout = 30000;                                          // (a test lowers it)
  function rs_make() {
    return { state: 'ok', tries: 0, rid: 0, t0: 0, incident: 0, got: null, ms: 0, bytes: 0, raw: 0, failedSent: false };
  }
  let rs = rs_make();
  NT.resyncState = () => rs.state;
  NT.provide = null;                                               // main.js: () => ({ k, snap }) the host's snapshot at its current step
  function guestDesync(k) {
    if (rs.state === 'failed') return;                              // already told the player; only the button restarts it
    if (rs.state === 'ok') {
      rs.incident++;
      rs.tries = 0;
      rs.failedSent = false;
    }
    if (rs.tries >= RS_TRIES) {
      rs.state = 'failed';
      if (!rs.failedSent) {
        rs.failedSent = true;
        fire('resync_failed', { incident: rs.incident, k });
      }
      return;
    }
    guestAsk('hash');
  }
  function guestAsk(why) {
    if (NT.isHost || !hostLink || !NT.started) return false;
    rs.tries++;
    rs.rid++;
    rs.state = 'wait';
    rs.t0 = performance.now();
    rs.got = null;
    rs.why = why;
    sendTo(hostLink, { t: 'rsq', m: matchId, id: rs.rid, why });
    fire('resync_start', { incident: rs.incident, why, tries: rs.tries });
    return true;
  }
  /* the Resync button / key: always starts a fresh attempt (a manual request is also fine while 'ok') */
  NT.resync_request = () => {
    if (NT.isHost) return false;
    rs.tries = 0;
    rs.failedSent = false;
    if (rs.state === 'ok') rs.incident++;
    return guestAsk('manual');
  };
  function hostResync(l, reqId) {
    const now = performance.now();
    if (now - l.rsT < RS_GAP || !NT.provide) return;
    l.rsT = now;
    const cap = NT.provide();
    if (!cap) return;
    const seats = NT.seats ? NT.seats.slice() : [], ctl = ctlQ.map(c => ({ team: c.team, k: c.k })), id = ++rsId;
    stats.resync++; fire('resync_sent', { name: l.name, k: cap.k });
    const t0 = performance.now();
    SS.netsnap.pack(cap.snap).then(p => {
      if (!l.open) return;
      const txt = SS.netsnap.b64(p.bytes), n = Math.ceil(txt.length / CHUNK) || 1;
      NT.lastSnap = { raw: p.raw, bytes: p.bytes.length, b64: txt.length, chunks: n, packMs: performance.now() - t0, k: cap.k };
      sendTo(l, {
        t: 'rss',
        m: matchId,
        id,
        rid: reqId | 0,
        k: cap.k,
        z: p.z,
        raw: p.raw,
        n,
        len: p.bytes.length,
        seats,
        ctl,
        fields: cap.fields || null
      });
      let i = 0;
      const pump = () => {
        if (!l.open || !NT.started) return;
        let c = 0;
        while (i < n && c < 600 && !(l.buffered && l.buffered() > 4000000)) {
          sendTo(l, { t: 'rsc', m: matchId, id, i, d: txt.slice(i * CHUNK, (i + 1) * CHUNK) });
          i++;
          c++;
        }
        if (i < n) setTimeout(pump, 20);
      };
      pump();
    }).catch(e => console.error('resync pack failed', e));
  }
  let rsId = 0;
  function guestRss(m) {
    if (
      !Number.isInteger(m.id)
      || !Number.isInteger(m.k)
      || !Number.isInteger(m.n)
      || m.n < 1
      || m.n > 20000
      || !Array.isArray(m.seats)
      || !Array.isArray(m.ctl)
    ) return;
    if (rs.state !== 'wait') return;
    rs.got = {
      id: m.id,
      k: m.k,
      z: m.z ? 1 : 0,
      raw: m.raw | 0,
      len: m.len | 0,
      n: m.n,
      parts: new Array(m.n),
      have: 0,
      seats: m.seats.map(x => (x === 'cpu' ? 'cpu' : 'human')).slice(0, 4),
      ctl: m.ctl.filter(c => c && Number.isInteger(c.team) && Number.isInteger(c.k)).slice(0, 8),
      fields: m.fields && typeof m.fields === 'object' ? m.fields : null
    };
  }
  function guestRsc(m) {
    const g = rs.got;
    if (!g || m.id !== g.id || !Number.isInteger(m.i) || m.i < 0 || m.i >= g.n || typeof m.d !== 'string' || g.parts[m.i] !== undefined)
      return;
    g.parts[m.i] = m.d; g.have++;
    if (g.have < g.n) return;
    rs.got = null;
    const rid = rs.rid;
    let bytes;
    try {
      bytes = SS.netsnap.unb64(g.parts.join(''));
    } catch (e) {
      return;
    }
    SS.netsnap.unpack(bytes, g.z).then(snap => {
      if (rid !== rs.rid || rs.state !== 'wait') return;          // a newer request replaced this one
      rs.ms = performance.now() - rs.t0; rs.bytes = bytes.length; rs.raw = g.raw;
      fire('resync', { k: g.k, snap, seats: g.seats, ctl: g.ctl, fields: g.fields, bytes: bytes.length, raw: g.raw, ms: rs.ms });
    }).catch(e => { console.error('resync unpack failed', e); });
  }
  /* main.js: the snapshot of step k is restored. Re-arm the lockstep from k. */
  NT.resync_applied = function (k, info) {
    if (info) {
      if (info.seats && info.seats.length) NT.seats = info.seats.slice();
      ctlQ = (info.ctl || []).map(c => ({ team: c.team, k: c.k }));
    }
    for (const key of [...hashes.keys()]) {
      const kk = +key.slice(key.indexOf(':') + 1 || 1);
      if (key[0] === 'L' ? +key.slice(1) >= k : kk <= k) hashes.delete(key);
    }
    for (const [j, a] of done)
      if (j >= k) { inbox.set(j, a); }
    for (const [j, a] of done)
      if (j >= k && mine.has(j)) replay.add(j);
    for (const j of [...done.keys()])
      if (j >= k) { done.delete(j); }
    for (const j of [...inbox.keys()])
      if (j < k) inbox.delete(j);
    outbox = []; outK0 = -1;
    rs.state = 'verify'; stats.resync++;
  };
  NT.takeReplay = k => {
    if (!replay.has(k)) return null;
    replay.delete(k);
    return NT.takeInput(k);
  };
  NT.resync_tick = now => {
    if (!NT.isHost && rs.state === 'wait' && now - rs.t0 > NT.rs_timeout) {
      rs.got = null;
      if (rs.tries >= RS_TRIES) {
        rs.state = 'failed';
        if (!rs.failedSent) {
          rs.failedSent = true;
          fire('resync_failed', { incident: rs.incident, k: -1 });
        }
      } else guestAsk('timeout');
    }
  };

  /* ---------- P103: chat (its own message type: never a sim input, never in the lockstep, the hash or a replay)
   * ---------- */
  const CHAT_MAX = 200, CHAT_N = 5, CHAT_WIN = 5000;
  const clean = t => String(t).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
  NT.chat_clean = clean;
  let myChatT = [];
  function rate(arr, now) {
    while (arr.length && now - arr[0] > CHAT_WIN) arr.shift();
    if (arr.length >= CHAT_N) return false;
    arr.push(now);
    return true;
  }
  const teamOf = l => (l.team >= 0 ? l.team : -1);
  function hostChat(l, x) {
    x = clean(x);
    if (!x || !rate(l.chatT, performance.now())) return;
    const o = { t: 'chat', nm: l.name, tm: teamOf(l), x };
    for (const q of links)
      if (q !== l) sendTo(q, o);
    fire('chat', { name: l.name, team: o.tm, text: x });
  }
  function guestChat(m) {
    const x = clean(m.x);
    if (!x) return;
    fire('chat', {
      name: m.sys ? '' : String(m.nm || 'Friend').slice(0, 18),
      team: Number.isInteger(m.tm) ? m.tm : -1,
      text: x,
      sys: !!m.sys
    });
  }
  function sysChat(text) {
    if (!NT.isHost) return;
    for (const q of links) sendTo(q, { t: 'chat', sys: 1, x: text });
    fire('chat', { name: '', team: -1, text: text, sys: true });
  }
  /* send my own message: false = refused (empty / rate limit). The local echo is the caller's (netui shows it through
   * this return value). */
  NT.chat = text => {
    const x = clean(text);
    if (!x || !rate(myChatT, performance.now())) return null;
    if (NT.isHost) {
      const o = { t: 'chat', nm: NT.name || 'Host', tm: NT.started ? NT.team : -1, x };
      for (const q of links) sendTo(q, o);
    }
    else sendTo(hostLink, { t: 'chat', x });
    return { name: NT.name || (NT.isHost ? 'Host' : 'Me'), team: NT.started ? NT.team : -1, text: x };
  };
  NT.close = () => {
    NT.send({ t: 'bye' });
    for (const l of links) l.close();
    if (hostLink) hostLink.close();
    if (pendingRtc) {
      try {
        pendingRtc.close();
      } catch (e) { /* */ }
    }
    reset();
  };
  /* R10: a second Host / Join click (reset) must not leave the old links alive: each one is marked closed (no 'leave' /
   * 'close' events
   * for a deliberate drop), told goodbye and closed */
  function drop_links() {
    const all = links.slice();
    if (hostLink) all.push(hostLink);
    for (const l of all) {
      if (l.open) { sendTo(l, { t: 'bye' }); }
      l.open = false;
      try {
        l.close();
      } catch (e) { /* */ }
    }
    if (pendingRtc) {
      try {
        pendingRtc.close();
      } catch (e) { /* */ }
    }
  }
  function reset() {
    drop_links();
    NT.active = false;
    NT.started = false;
    NT.seats = null;
    NT.code = null;
    NT.mode = null;
    matchId = 0;
    links = [];
    hostLink = null;
    pendingRtc = null;
    if (peer) {
      try {
        peer.destroy();
      } catch (e) { /* */ }
      peer = null;
    }
    NT.clearQueues(); stats = { sent: 0, recv: 0, desync: 0, hashOk: 0, resync: 0 };
  }
  // leaving the page says goodbye (the others turn this seat into a CPU team at once)
  if (typeof addEventListener === 'function') addEventListener('pagehide', () => {
    if (NT.active) NT.send({ t: 'bye' });
  });
  NT.stats = () => Object.assign(
    { active: NT.active, team: NT.team, host: NT.isHost, mode: NT.mode, peers: links.length, inbox: inbox.size },
    stats
  );
})(window.SS = window.SS || {});
