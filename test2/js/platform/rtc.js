/* platform/rtc.js — the browser's transport for platform/net.js: WebRTC data channels, set up two ways.
 *   - room codes (the PoC's online friend matches): PeerJS (the local vendor/peerjs.min.js, loaded on demand) with the
 *     public PeerJS broker for signalling, Google / Cloudflare STUN and the PeerJS TURN relay. Needs the internet.
 *   - LAN codes: copy / paste WebRTC offer / answer codes, no server, host candidates only (works from file:// and
 *     offline); the host makes one offer per guest.
 * Nothing WebRTC-shaped leaves this file. net.js hands every call a sink and gets links back:
 *   sink.link(send, close, label, buffered) -> Link   a new link (send(obj): reliable and ordered; buffered(): bytes
 *                                                      not yet sent, the resync's flow control)
 *   sink.opened(l), sink.closed(l), sink.data(l, msg) its life and its messages (an object, or a JSON string)
 * API: room_host(sink) -> Promise<code>; room_join(sink, code); lan_offer(sink) -> Promise<code> (host, one per guest);
 * lan_accept(code) (host: the guest's answer); lan_answer(sink, code) -> Promise<code> (guest); close() (the signalling
 * peer and a pending offer). On Steam this file becomes the ISteamMatchmaking lobby + ISteamNetworkingSockets
 * connection of docs/PORTING.md; LAN codes have no Steam counterpart (Steam lobbies work on a LAN too). */
(function (SS) {
  'use strict';
  const RT = SS.rtc = {};
  const LAN_CFG = { iceServers: [] }, PREFIX = 'burrowbrawl3d-v1-', ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  // the PoC's ICE servers (public STUN + the PeerJS TURN relay) for room-code play over the internet
  const NET_CFG = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' }]
  };
  const BROKER_MS = 9000, CONNECT_MS = 15000, GATHER_MS = 4000, LOST_MS = 4000;
  const NO_BROKER = 'The matchmaking server did not answer (room codes need the internet; LAN codes do not).';
  let peer = null, pendingRtc = null;
  const enc = o => btoa(unescape(encodeURIComponent(JSON.stringify(o))));
  const dec = s => JSON.parse(decodeURIComponent(escape(atob(s.trim()))));
  const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
  const destroy = p => {
    try {
      p.destroy();
    } catch (e) { /* already gone */ }
  };

  /* ---------- room codes over PeerJS ---------- */
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
  function wrapConn(sink, c) {
    const l = sink.link(o => c.send(o), () => {
      try {
        c.close();
      } catch (e) { /* closed */ }
    }, 'Friend', () => (c.dataChannel ? c.dataChannel.bufferedAmount | 0 : 0));
    c.on('open', () => sink.opened(l));
    c.on('data', d => sink.data(l, d));
    c.on('close', () => sink.closed(l));
    c.on('error', () => sink.closed(l));
    return l;
  }
  // a broker peer under an id (null: the broker picks one); a timed-out peer is destroyed (it must not keep the room)
  async function openPeer(id, onError) {
    let np = null;
    try {
      return await withTimeout(new Promise((res, rej) => {
        const p = np = id ? new window.Peer(id, { config: NET_CFG, debug: 0 }) : new window.Peer({ config: NET_CFG, debug: 0 });
        p.on('open', () => res(p));
        p.on('error', e => onError(p, e, rej));
      }), BROKER_MS, NO_BROKER);
    } catch (e) {
      if (np) destroy(np);
      throw e;
    }
  }
  // the host: a free 4-character code (lobby randomness, not sim), its peer takes every guest's connection
  RT.room_host = async function (sink) {
    await loadPeer();
    for (let tries = 0; tries < 4; tries++) {
      let code = '';
      for (let i = 0; i < 4; i++) code += ALPHA[Math.floor(Math.random() * ALPHA.length)];
      try {
        peer = await openPeer(PREFIX + code, (p, e, rej) => {
          if (e && e.type === 'unavailable-id') {
            p.destroy();
            rej(new Error('taken'));
          } else rej(e);
        });
      } catch (e) {
        if (e.message === 'taken') continue;
        throw e;
      }
      peer.on('connection', c => wrapConn(sink, c));
      peer.on('disconnected', () => {
        try {
          peer.reconnect();
        } catch (e) { /* the broker is gone: the open links stay */ }
      });
      return code;
    }
    throw new Error('No free room code, try again.');
  };
  RT.room_join = async function (sink, code) {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length !== 4) throw new Error('Room codes have 4 characters.');
    await loadPeer();
    peer = await openPeer(null, (p, e, rej) => rej(e));
    await withTimeout(new Promise((res, rej) => {
      const c = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
      wrapConn(sink, c);
      c.on('open', () => res());
      peer.on('error', e => rej(new Error(e && e.type === 'peer-unavailable' ? 'No room with that code.' : String(e && e.message || e))));
    }), CONNECT_MS, 'Could not reach that room.');
  };

  /* ---------- LAN copy / paste codes (no server) ---------- */
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
      // LAN host candidates arrive at once; never hang the UI
      setTimeout(res, GATHER_MS);
    });
  }
  function wireRtc(sink, pc, ch) {
    const l = sink.link(o => ch.send(JSON.stringify(o)), () => {
      try {
        pc.close();
      } catch (e) { /* closed */ }
    }, 'LAN friend', () => ch.bufferedAmount | 0);
    ch.onopen = () => sink.opened(l);
    ch.onclose = () => sink.closed(l);
    ch.onmessage = e => sink.data(l, e.data);
    // a vanished peer: the data channel itself only notices after the SCTP timeout (~30 s)
    let t = null;
    pc.addEventListener('connectionstatechange', () => {
      const cs = pc.connectionState;
      if (cs === 'failed' || cs === 'closed') sink.closed(l);
      else if (cs === 'disconnected') {
        clearTimeout(t);
        t = setTimeout(() => {
          if (pc.connectionState !== 'connected') sink.closed(l);
        }, LOST_MS);
      }
    });
    return l;
  }
  RT.lan_offer = async function (sink) {
    const pc = new RTCPeerConnection(LAN_CFG);
    wireRtc(sink, pc, pc.createDataChannel('ss', { ordered: true }));
    pendingRtc = pc;
    await pc.setLocalDescription(await pc.createOffer());
    await gathered(pc);
    return enc({ sdp: pc.localDescription.sdp, type: 'offer' });
  };
  RT.lan_accept = async function (code) {
    if (!pendingRtc) throw new Error('host first');
    const pc = pendingRtc;
    pendingRtc = null;
    await pc.setRemoteDescription(dec(code));
  };
  RT.lan_answer = async function (sink, code) {
    const pc = new RTCPeerConnection(LAN_CFG);
    pc.ondatachannel = e => wireRtc(sink, pc, e.channel);
    await pc.setRemoteDescription(dec(code));
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    return enc({ sdp: pc.localDescription.sdp, type: 'answer' });
  };
  // the signalling peer and an offer not yet accepted (the open links are net.js's to close)
  RT.close = function () {
    if (pendingRtc) {
      try {
        pendingRtc.close();
      } catch (e) { /* closed */ }
      pendingRtc = null;
    }
    if (peer) {
      destroy(peer);
      peer = null;
    }
  };
})(window.SS = window.SS || {});
