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
  const css = `#netui{position:fixed;left:50%;top:max(8px,3vh);transform:translateX(-50%);box-sizing:border-box;width:min(calc(var(--mu) * 762),94vw);max-height:calc(100vh - max(8px,3vh) - 8px);overflow:auto;z-index:40;
    background:linear-gradient(180deg,rgba(40,30,22,.97),rgba(18,14,12,.98));border:1px solid rgba(236,226,200,.16);border-radius:20px;padding:calc(var(--mu) * 18) calc(var(--mu) * 20);font:500 calc(var(--mu) * 15) var(--f-ui);color:#efe9da;
    box-shadow:0 0 0 100vmax rgba(8,6,4,.62),0 30px 80px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,214,150,.1);animation:nucard .3s var(--ease,ease-out) both}
    @keyframes nucard{from{opacity:0;transform:translateX(-50%) translateY(14px)}to{opacity:1;transform:translateX(-50%)}}
    #netui :focus-visible{outline:2px solid #ffb02e;outline-offset:2px}#netui button:hover:not(:disabled){filter:brightness(1.1)}#netui button:active:not(:disabled){transform:translateY(2px);box-shadow:0 1px 0 #8a5200}
    #netui h2{margin:0 0 4px;font:400 calc(var(--mu) * 22) var(--f-display);color:#ffb02e}#netui h3{margin:0 0 6px;font:400 calc(var(--mu) * 14) var(--f-display);color:#ffb02e;letter-spacing:.04em}
    #netui .cols{display:grid;grid-template-columns:1fr 1fr;gap:calc(var(--mu) * 14);margin-top:calc(var(--mu) * 10)}#netui .col{background:rgba(255,255,255,.04);border-radius:12px;padding:calc(var(--mu) * 12)}
    #netui .code{font:400 calc(var(--mu) * 42) var(--f-display);letter-spacing:.12em;color:#efe9da;text-align:center;margin:6px 0;user-select:all}
    #netui input,#netui textarea{width:100%;box-sizing:border-box;background:rgba(255,255,255,.07);color:#efe9da;border:1px solid rgba(236,226,200,.2);border-radius:8px;padding:calc(var(--mu) * 6) calc(var(--mu) * 8);font:600 calc(var(--mu) * 14) var(--f-ui);margin:3px 0}
    #netui textarea{height:calc(var(--mu) * 58);font:calc(var(--mu) * 11) ui-monospace,monospace}
    #netui button{margin:6px 6px 0 0;padding:calc(var(--mu) * 7) calc(var(--mu) * 14);border-radius:10px;border:0;background:#ffb02e;color:#2a1606;font:400 calc(var(--mu) * 14) var(--f-display);cursor:pointer;box-shadow:0 3px 0 #8a5200}
    #netui button.ghost{background:rgba(255,255,255,.1);color:#efe9da;box-shadow:0 3px 0 rgba(0,0,0,.4)}#netui button:disabled{opacity:.4;cursor:default}
    #netui .pl{margin:4px 0;color:#79d98b}#netui .st{margin-top:8px;color:#9ba7a9;min-height:18px}#netui details{margin-top:12px}#netui summary{cursor:pointer;color:#9ba7a9}
    @media (max-width:640px){#netui .cols{grid-template-columns:1fr}}`;
  function el(tag, html) {
    const e = document.createElement(tag);
    if (html) e.innerHTML = html;
    return e;
  }
  const q = s => box.querySelector(s);
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function status(t) {
    const s = box && q('#nuSt');
    if (s) s.textContent = t;
  }
  function players(list) {
    const p = box && q('#nuPl');
    if (!p) return;
    p.innerHTML = list.map((x, i) => `<div class="pl">● ${esc(x.name)}${i === 0 ? ' (host)' : ''}</div>`).join('');
    const go = q('#nuStart');
    if (go) go.disabled = !(SS.net.isHost && list.length > 1);
  }
  /* P38 R6 (R7): the build / desync banners (a fixed strip; plain DOM). desync(k, onStop): "Stop multiplayer" ends the
   * lockstep and goes on
   * locally; "Keep playing" dismisses. refused(msg): the host / guest runs another build. */
  function banner(id, html, buttons) {
    let b = document.getElementById(id);
    if (b) b.remove();
    b = el('div', html); b.id = id;
    b.style.cssText = 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:60;max-width:min(560px,92vw);background:rgba(60,20,20,.96);color:#ffe0d8;border:1px solid #ff8a70;border-radius:12px;padding:12px 16px;font:600 14px var(--f-ui);box-shadow:0 10px 30px rgba(0,0,0,.5)';
    for (const [t, fn] of buttons) {
      const x = el('button', t);
      x.type = 'button';
      x.style.cssText = 'margin:8px 8px 0 0;padding:6px 12px;border:0;border-radius:8px;background:#ffb02e;color:#2a1606;font:400 13px var(--f-display);cursor:pointer';
      x.onclick = () => {
        b.remove();
        if (fn) fn();
      };
      b.appendChild(x);
    }
    document.body.appendChild(b); return b;
  }
  /* P103: no blocking popup for a desync. net.js resyncs a guest from the host's snapshot by itself; the player sees
   * ONE small toast per incident
   * ("Resynced with host"). Only when the automatic tries fail there is ONE banner with a Resync button (a new banner
   * replaces the old one, it never stacks, and net.js raises 'resync_failed' once per failure until the button is
   * pressed again). */
  let toastT = 0;
  NU.toast = text => {
    let t = document.getElementById('nutoast');
    if (!t) {
      t = el('div');
      t.id = 'nutoast';
      t.style.cssText = 'position:fixed;left:50%;top:104px;transform:translateX(-50%);z-index:58;padding:6px 14px;border-radius:10px;background:rgba(14,24,32,.88);color:#dff3ff;border:1px solid rgba(150,210,240,.4);font:600 13px var(--f-ui);pointer-events:none;transition:opacity .4s;max-width:min(520px,90vw);text-align:center';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.style.opacity = '1';
    clearTimeout(toastT);
    toastT = setTimeout(() => { t.style.opacity = '0'; }, 3200);
  };
  NU.clearBanner = () => {
    const b = document.getElementById('nudesync');
    if (b) b.remove();
  };
  NU.resyncFailed = (incident, onResync, onStop) => {
    if (document.getElementById('nudesync')) return;
    banner('nudesync', 'Your game is out of sync with the host and the automatic resync did not work.', [
      ['Resync', onResync],
      ['Leave match', onStop]
    ]);
  };
  NU.refused = msg => {
    banner('nurefused', esc(msg), [['OK', null]]);
    status(msg);
  };

  /* ---------- P103: chat (DOM only; never touches S, the sim log, the lockstep or a replay) ----------
   * Enter / T open it when the player cannot act right now (not their turn, a CPU turn, the lobby); Shift+Enter /
   * Shift+T open it any time (Enter is jump and T is the teleport weapon on your own turn); the chat button opens it
   * too (touch). Enter sends and closes, Esc closes. While the input is focused input.js ignores every key (it skips
   * INPUT targets), so nothing walks, fires or rotates; the keys held when it opens are released. */
  const CHAT_KEEP = 40, CHAT_FADE = 8000;
  let chatEl = null, logEl = null, inEl = null, btnEl = null, lines = [], chatOpen = false, fadeT = 0;
  const hex = rgb => '#' + ('000000' + (rgb >>> 0).toString(16)).slice(-6);
  NU.canAct = null;                                                    // main.js: () => true while the player controls a worm right now
  function chatInit() {
    if (chatEl) return;
    if (!document.getElementById('nuchat-css')) {
      const st = el(
        'style',
        `#nuchat{position:fixed;left:14px;bottom:calc(var(--gh,140px) + 56px);width:min(380px,calc(100vw - 28px));z-index:45;pointer-events:none;font:600 13px/1.3 var(--f-ui)}
      #nuchat .lg{display:flex;flex-direction:column;gap:2px}#nuchat .ln{align-self:flex-start;max-width:100%;padding:2px 8px;border-radius:7px;background:rgba(8,12,16,.5);color:#eef4f8;text-shadow:0 1px 2px #000;opacity:1;transition:opacity .6s;word-break:break-word}
      #nuchat .ln.old{opacity:0}#nuchat.open .ln.old{opacity:1}#nuchat .ln.sys{color:#bcd;font-style:italic}#nuchat .ln b{font-weight:800}
      #nuchat input{display:none;pointer-events:auto;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 9px;border-radius:8px;border:1px solid rgba(236,226,200,.35);background:rgba(8,12,16,.82);color:#fff;font:600 14px var(--f-ui)}
      #nuchat.open input{display:block}
      #nuchatbtn{position:fixed;left:14px;bottom:calc(var(--gh,140px) + 14px);z-index:45;width:34px;height:34px;border-radius:50%;border:1px solid rgba(236,226,200,.3);background:rgba(8,12,16,.55);color:#eee;font-size:16px;cursor:pointer;display:none;padding:0}
      body.touch #nuchatbtn,#nuchatbtn.on{display:block}`
      );
      st.id = 'nuchat-css';
      document.head.appendChild(st);
    }
    chatEl = el('div');
    chatEl.id = 'nuchat';
    logEl = el('div');
    logEl.className = 'lg';
    inEl = el('input');
    inEl.maxLength = 200;
    inEl.placeholder = 'Say something (Enter sends, Esc closes)';
    inEl.autocomplete = 'off';
    inEl.setAttribute('aria-label', 'Chat message');
    chatEl.appendChild(logEl); chatEl.appendChild(inEl); document.body.appendChild(chatEl);
    btnEl = el('button', '&#128172;');
    btnEl.id = 'nuchatbtn';
    btnEl.type = 'button';
    btnEl.title = 'Chat (Enter / T when it is not your turn, Shift+Enter any time)';
    btnEl.onclick = () => (chatOpen ? chatClose() : chatOpenIn());
    document.body.appendChild(btnEl);
    addEventListener('keydown', chatKey, true);
    if (SS.net) SS.net.on('chat', d => {
      if (d.sys) NU.sys(d.text);
      else NU.chatLine(d.name, d.team, d.text);
    });
  }
  function addLine(name, rgb, text, sys) {
    chatInit();
    const d = el('div');
    d.className = 'ln' + (sys ? ' sys' : '');
    if (name) {
      const b = el('b');
      b.textContent = name;
      b.style.color = rgb != null ? hex(rgb) : '#ddd';
      d.appendChild(b);
      d.appendChild(document.createTextNode(': '));
    }
    d.appendChild(document.createTextNode(text));                       // textContent / text nodes only: no HTML from a peer is ever parsed
    logEl.appendChild(d); lines.push({ d, t: performance.now() });
    while (lines.length > CHAT_KEEP) {
      const o = lines.shift();
      o.d.remove();
    }
    btnEl.classList.add('on'); fadeSoon();
  }
  function fadeSoon() {
    clearTimeout(fadeT);
    fadeT = setTimeout(fade, 700);
  }
  function fade() {
    const now = performance.now();
    let more = false;
    for (const l of lines) {
      const old = now - l.t > CHAT_FADE;
      l.d.classList.toggle('old', old);
      if (!old) more = true;
    }
    if (more) fadeT = setTimeout(fade, 700);
  }
  const teamRgb = t => (t >= 0 && SS.CFG.TEAMS[t] ? SS.CFG.TEAMS[t].rgb : null);
  NU.chatLine = (name, team, text) => addLine(String(name).slice(0, 18), teamRgb(team), String(text).slice(0, 200), false);
  NU.sys = text => addLine('', null, String(text).slice(0, 200), true);
  function chatOpenIn() {
    chatInit();
    if (chatOpen) return;
    chatOpen = true;
    chatEl.classList.add('open');
    if (SS.input && SS.input.keys) {
      SS.input.keys.clear();
      SS.input.pressed.clear();
    }
    fade();
    inEl.value = '';
    inEl.focus();
  }
  function chatClose() {
    if (!chatOpen) return;
    chatOpen = false;
    chatEl.classList.remove('open');
    inEl.blur();
    inEl.value = '';
    fadeSoon();
  }
  NU.chatOpen = () => chatOpen;
  NU.chatToggle = on => (on ? chatOpenIn() : chatClose());
  function chatSend() {
    const text = SS.net && SS.net.chat_clean ? SS.net.chat_clean(inEl.value) : inEl.value.trim().slice(0, 200);
    chatClose();
    if (!text) return;
    const r = SS.net.chat(text);
    if (!r) {
      addLine('', null, 'Slow down: too many messages.', true);
      return;
    }
    NU.chatLine(r.name, r.team, r.text);
  }
  function chatKey(e) {
    if (chatOpen) {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        chatClose();
        return;
      }
      if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault();
        e.stopImmediatePropagation();
        chatSend();
        return;
      }
      e.stopPropagation(); return;                                       // typed keys reach the input only
    }
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code !== 'Enter' && e.code !== 'KeyT') return;
    const t = e.target;
    if (t && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName)) return;
    if (SS.menu && SS.menu.visible && SS.menu.visible() && !box) return;   // the settings menu owns Enter / T; the lobby panel does not
    if (!e.shiftKey && NU.canAct && NU.canAct()) return;               // on your own turn Enter is jump and T the teleport weapon
    e.preventDefault(); e.stopImmediatePropagation(); chatOpenIn();
  }
  window.addEventListener('DOMContentLoaded', () => chatInit());
  NU.toggle = function (settings) {
    // (R11: closing the panel before the match starts leaves the lobby: the room is released)
    if (box) {
      box.remove();
      box = null;
      if (!SS.net.started && SS.net.mode) SS.net.close();
      return;
    }
    curSettings = settings;
    if (!document.getElementById('netui-css')) {
      const s = el('style', css);
      s.id = 'netui-css';
      document.head.appendChild(s);
    }
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
      try {
        const code = await SS.net.room_host(q('#nuHN').value.trim() || 'Host');
        q('#nuCode').innerHTML =
          `<div class="code">${esc(code)}</div><div style="text-align:center;color:#9ba7a9">Send this code to your friends.</div>`;
        status('Waiting for friends to join…');
        players(SS.net.peers());
      }
      catch (e) {
        status('Could not create a room: ' + (e.message || e));
      }
    };
    q('#nuStart').onclick = () => {
      if (SS.ui.netStart) {
        const st = Object.assign({}, curSettings || SS.menu.load());
        st.names = (st.names || []).slice();
        st.names[0] = q('#nuHN').value.trim() || 'Host';
        SS.ui.netStart(st);
        NU.toggle();
      }
    };
    q('#nuJoin').onclick = async () => {
      status('Joining…');
      try {
        await SS.net.room_join(q('#nuJC').value, q('#nuJN').value.trim() || 'Friend');
        status('Joined. Waiting for the host to start the match.');
      }
      catch (e) {
        status('Could not join: ' + (e.message || e));
      }
    };
    q('#nuLHost').onclick = async () => {
      const lan = q('#nuLan');
      status('Making a LAN code…');
      let code;
      try {
        code = await SS.net.host(curSettings, q('#nuHN').value.trim() || 'Host');
      } catch (e) {
        status('Could not make a code: ' + (e.message || e));
        return;
      }
      const row = el(
        'div',
        `<div>1. Send this code to one friend:</div><textarea readonly></textarea><div>2. Paste their answer:</div><textarea class="ans"></textarea><button class="ghost">Connect</button>`
      );
      lan.appendChild(row); row.querySelector('textarea').value = code; row.querySelector('textarea').select();
      row.querySelector('button').onclick = async () => {
        try {
          await SS.net.accept(row.querySelector('.ans').value);
          status('Connecting… (another friend: make another code)');
        } catch (e) {
          status('That answer did not work: ' + (e.message || e));
        }
      };
      q('#nuCode').innerHTML = '<div style="color:#9ba7a9">LAN match: start when your friends are listed.</div>'; players(SS.net.peers());
    };
    q('#nuLJoin').onclick = () => {
      const lan = q('#nuLan');
      lan.innerHTML =
        `<div>1. Paste the host's code:</div><textarea id="nuOff"></textarea><button class="ghost" id="nuMk">Make answer</button>`;
      q('#nuMk').onclick = async () => {
        let ans;
        try {
          ans = await SS.net.join(q('#nuOff').value, q('#nuJN').value.trim() || 'Friend');
        } catch (e) {
          status('That host code did not work: ' + (e.message || e));
          return;
        }
        lan.innerHTML = `<div>2. Send this answer back to the host:</div><textarea readonly id="nuA"></textarea>`;
        q('#nuA').value = ans;
        q('#nuA').select();
        status('Waiting for the host to connect and start.');
      };
    };
    if (!hooked) {
      hooked = true;
      SS.net.on('peers', list => players(list));
      SS.net.on('open', () => status('Connected. Waiting for the host to start the match.'));
      SS.net.on('start', () => {
        if (box) NU.toggle();
      });
      SS.net.on('close', () => status('The connection to the host was lost.'));
      SS.net.on('refused', d => status(d.msg || (d.name + ' runs another game build and was turned away.')));
    }
  };
})(window.SS = window.SS || {});
