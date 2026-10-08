/* ui/netui.js — the multiplayer lobby (P12, the PoC's "Play online"; DOM). Opened from the menu ("Play online").
 *   Host a match: "Create room" -> a 4-character room code to send to friends; the players who joined are listed;
 *   "Start match" (the host's menu setup; friends take teams 2-4 in join order, free teams are CPU).
 *   Join a friend: your name + the room code -> wait for the host to start.
 *   LAN / offline (no internet, no server): copy / paste WebRTC codes (host: one code per friend).
 * The match itself starts in main.js (SS.ui.netStart / SS.net 'start'). */
(function (SS) {
  'use strict';
  const NU = SS.netui = {};
  let box = null, hooked = false, curSettings = null;
  const css = `#netui{position:fixed;left:50%;top:8%;transform:translateX(-50%);width:min(720px,94vw);max-height:84vh;overflow:auto;z-index:40;
    background:rgba(21,29,35,.96);border:1px solid rgba(236,226,200,.16);border-radius:16px;padding:16px 18px;font:500 14px var(--f-ui);color:#efe9da;box-shadow:0 20px 60px rgba(0,0,0,.5)}
    #netui h2{margin:0 0 4px;font:400 22px var(--f-display);color:#ffb02e}#netui h3{margin:0 0 6px;font:400 14px var(--f-display);color:#ffb02e;letter-spacing:.04em}
    #netui .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:10px}#netui .col{background:rgba(255,255,255,.04);border-radius:12px;padding:12px}
    #netui .code{font:400 42px var(--f-display);letter-spacing:.12em;color:#efe9da;text-align:center;margin:6px 0;user-select:all}
    #netui input,#netui textarea{width:100%;box-sizing:border-box;background:rgba(255,255,255,.07);color:#efe9da;border:1px solid rgba(236,226,200,.2);border-radius:8px;padding:6px 8px;font:600 14px var(--f-ui);margin:3px 0}
    #netui textarea{height:58px;font:11px ui-monospace,monospace}
    #netui button{margin:6px 6px 0 0;padding:7px 14px;border-radius:10px;border:0;background:#ffb02e;color:#2a1606;font:400 14px var(--f-display);cursor:pointer;box-shadow:0 3px 0 #8a5200}
    #netui button.ghost{background:rgba(255,255,255,.1);color:#efe9da;box-shadow:0 3px 0 rgba(0,0,0,.4)}#netui button:disabled{opacity:.4;cursor:default}
    #netui .pl{margin:4px 0;color:#79d98b}#netui .st{margin-top:8px;color:#9ba7a9;min-height:18px}#netui details{margin-top:12px}#netui summary{cursor:pointer;color:#9ba7a9}
    @media (max-width:640px){#netui .cols{grid-template-columns:1fr}}`;
  function el(tag, html) { const e = document.createElement(tag); if (html) e.innerHTML = html; return e; }
  const q = s => box.querySelector(s);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function status(t) { const s = box && q('#nuSt'); if (s) s.textContent = t; }
  function players(list) {
    const p = box && q('#nuPl'); if (!p) return;
    p.innerHTML = list.map((x, i) => `<div class="pl">● ${esc(x.name)}${i === 0 ? ' (host)' : ''}</div>`).join('');
    const go = q('#nuStart'); if (go) go.disabled = !(SS.net.isHost && list.length > 1);
  }
  NU.toggle = function (settings) {
    if (box) { box.remove(); box = null; return; }
    curSettings = settings;
    if (!document.getElementById('netui-css')) { const s = el('style', css); s.id = 'netui-css'; document.head.appendChild(s); }
    box = el('div'); box.id = 'netui';
    const myName = (settings && settings.names && settings.names[0]) || 'Player';
    box.innerHTML = `<h2>Play online</h2><div style="color:#9ba7a9">Friends get teams 2-4 in join order; free teams are played by the CPU. The host's setup (map, teams, rules) is used.</div>
      <div class="cols">
        <div class="col"><h3>Host a match</h3><div>Your name</div><input id="nuHN" maxlength="18" value="${esc(myName)}">
          <button id="nuCreate">Create room</button><div id="nuCode"></div><div id="nuPl"></div><button id="nuStart" disabled>Start match</button></div>
        <div class="col"><h3>Join a friend</h3><div>Your name</div><input id="nuJN" maxlength="18" value="Friend"><div>Room code</div><input id="nuJC" maxlength="4" placeholder="ABCD" style="text-transform:uppercase;font:400 22px var(--f-display);letter-spacing:.1em">
          <button id="nuJoin">Join</button></div>
      </div>
      <details><summary>LAN / offline play (no internet: copy and paste connection codes)</summary>
        <button class="ghost" id="nuLHost">Host: make a code</button><button class="ghost" id="nuLJoin">Join with a code</button><div id="nuLan"></div></details>
      <div class="st" id="nuSt">Room codes use a public matchmaking server and need the internet.</div>
      <button class="ghost" id="nuClose">Close</button>`;
    document.body.appendChild(box);
    q('#nuClose').onclick = () => NU.toggle();
    q('#nuCreate').onclick = async () => {
      status('Creating a room…');
      try { const code = await SS.net.room_host(q('#nuHN').value.trim() || 'Host'); q('#nuCode').innerHTML = `<div class="code">${esc(code)}</div><div style="text-align:center;color:#9ba7a9">Send this code to your friends.</div>`; status('Waiting for friends to join…'); players(SS.net.peers()); }
      catch (e) { status('Could not create a room: ' + (e.message || e)); }
    };
    q('#nuStart').onclick = () => { if (SS.ui.netStart) { const st = Object.assign({}, curSettings || SS.menu.load()); st.names = (st.names || []).slice(); st.names[0] = q('#nuHN').value.trim() || 'Host'; SS.ui.netStart(st); NU.toggle(); } };
    q('#nuJoin').onclick = async () => {
      status('Joining…');
      try { await SS.net.room_join(q('#nuJC').value, q('#nuJN').value.trim() || 'Friend'); status('Joined. Waiting for the host to start the match.'); }
      catch (e) { status('Could not join: ' + (e.message || e)); }
    };
    q('#nuLHost').onclick = async () => {
      const lan = q('#nuLan'); status('Making a LAN code…');
      let code; try { code = await SS.net.host(curSettings, q('#nuHN').value.trim() || 'Host'); } catch (e) { status('Could not make a code: ' + (e.message || e)); return; }
      const row = el('div', `<div>1. Send this code to one friend:</div><textarea readonly></textarea><div>2. Paste their answer:</div><textarea class="ans"></textarea><button class="ghost">Connect</button>`);
      lan.appendChild(row); row.querySelector('textarea').value = code; row.querySelector('textarea').select();
      row.querySelector('button').onclick = async () => { try { await SS.net.accept(row.querySelector('.ans').value); status('Connecting… (another friend: make another code)'); } catch (e) { status('That answer did not work: ' + (e.message || e)); } };
      q('#nuCode').innerHTML = '<div style="color:#9ba7a9">LAN match: start when your friends are listed.</div>'; players(SS.net.peers());
    };
    q('#nuLJoin').onclick = () => {
      const lan = q('#nuLan'); lan.innerHTML = `<div>1. Paste the host's code:</div><textarea id="nuOff"></textarea><button class="ghost" id="nuMk">Make answer</button>`;
      q('#nuMk').onclick = async () => {
        let ans; try { ans = await SS.net.join(q('#nuOff').value, q('#nuJN').value.trim() || 'Friend'); } catch (e) { status('That host code did not work: ' + (e.message || e)); return; }
        lan.innerHTML = `<div>2. Send this answer back to the host:</div><textarea readonly id="nuA"></textarea>`; q('#nuA').value = ans; q('#nuA').select();
        status('Waiting for the host to connect and start.');
      };
    };
    if (!hooked) {
      hooked = true;
      SS.net.on('peers', list => players(list));
      SS.net.on('open', () => status('Connected. Waiting for the host to start the match.'));
      SS.net.on('start', () => { if (box) NU.toggle(); });
      SS.net.on('close', () => status('The connection to the host was lost.'));
    }
  };
})(window.SS = window.SS || {});
