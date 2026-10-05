/* Native installation when offered; platform-specific directions otherwise. No remote dependencies. */
(() => {
  const button = document.createElement('button');
  button.id = 'installButton'; button.type = 'button'; button.setAttribute('aria-label', 'Install Burrow Brawl for offline play');
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></svg><span>Install</span>';
  const dialog = document.createElement('dialog'); dialog.id = 'installDialog'; dialog.setAttribute('aria-labelledby', 'installTitle');
  dialog.innerHTML = `<button id="installClose" aria-label="Close install instructions">×</button>
    <header><img src="assets/app/icon-192.png" alt="Pink worm wearing copper goggles"><div><h2 id="installTitle">Burrow Brawl</h2><span>Take the burrow with you.</span></div></header>
    <p id="offlineStatus" role="status">Downloading the complete game for offline play…</p>
    <div id="installSteps"></div><p class="installNote">CPU and same-device multiplayer work offline. Playing a friend online needs an internet connection.</p>
    <div class="installActions"><button class="btn" id="installNative" hidden>Install game</button><button class="btn ghost" id="installRetry" hidden>Retry download</button></div>`;
  document.body.append(button, dialog);
  const $ = id => document.getElementById(id);
  let prompt = null, ready = false, registration = null, error = '', updateWaiting = false;
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const safari = /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Android/.test(navigator.userAgent);
  const supported = location.protocol !== 'file:' && window.isSecureContext && 'serviceWorker' in navigator;
  function render() {
    const status = $('offlineStatus'); status.classList.toggle('ready', ready); button.classList.toggle('ready', ready);
    button.querySelector('span').textContent = standalone() ? 'Offline' : 'Install';
    status.textContent = error || (ready ? 'Offline ready — all game content is downloaded.' + (updateWaiting ? ' An update is ready; close all game windows to use it.' : '') : 'Downloading the complete game for offline play…');
    $('installRetry').hidden = !error || !supported;
    $('installNative').hidden = !prompt || standalone(); $('installNative').disabled = !ready;
    let steps;
    if (!supported) steps = '<p>Open this game from an <b>HTTPS website</b> to install it. A local file can be played directly, but browsers cannot install it as an offline app. For desktop testing, localhost also works.</p>';
    else if (standalone()) steps = '<p>The game is installed. Launch it from its icon whenever you want to play.</p>';
    else if (ios) steps = '<ol><li>Open this page in <b>Safari</b>.</li><li>Tap <b>Share</b>, then <b>Add to Home Screen</b>.</li><li>Keep <b>Open as Web App</b> enabled if shown, then tap <b>Add</b>.</li><li>Open the new icon once while online and wait for <b>Offline ready</b>.</li></ol>';
    else if (prompt) steps = '<p>When the download is ready, choose <b>Install game</b> below. The new icon launches the complete game in its own window.</p>';
    else if (safari && /Mac/.test(navigator.platform)) steps = '<ol><li>Choose <b>File → Add to Dock</b> in Safari (macOS Sonoma or newer).</li><li>Open the new icon once while online and wait for <b>Offline ready</b>.</li></ol>';
    else if (/Android/.test(navigator.userAgent)) steps = '<ol><li>Open the browser menu <b>⋮</b>.</li><li>Choose <b>Install app</b> or <b>Add to Home screen</b>.</li><li>If neither is offered, open this HTTPS page in Chrome.</li></ol>';
    else steps = '<p>In Chrome or Edge, use the <b>install icon in the address bar</b>, or the browser menu’s <b>Install / Apps</b> option. The native button appears here when the browser offers installation.</p>';
    $('installSteps').innerHTML = steps;
  }
  button.addEventListener('click', () => { render(); if (!dialog.open) dialog.showModal(); });
  $('installClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
  addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt = event; render(); });
  addEventListener('appinstalled', () => { prompt = null; render(); });
  $('installNative').addEventListener('click', async () => {
    if (!prompt || !ready) return;
    const event = prompt; prompt = null;
    try {
      await event.prompt();
      if ((await event.userChoice).outcome === 'accepted') { dialog.close(); navigator.storage?.persist?.().catch(() => {}); }
    } catch { error = 'Installation was not completed. Try the browser’s Install option.'; }
    render();
  });
  function askStatus() { (navigator.serviceWorker.controller || registration?.active)?.postMessage({ type: 'BB_OFFLINE_STATUS' }); }
  async function download() {
    error = ''; render();
    try {
      registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
      const watch = () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'redundant' && !registration.active) { error = 'Download incomplete. Reconnect and retry before going offline.'; render(); }
          if (worker.state === 'installed') { updateWaiting = !!registration.waiting && !!registration.active; render(); }
          if (worker.state === 'activated') askStatus();
        });
      };
      watch(); registration.addEventListener('updatefound', watch);
      updateWaiting = !!registration.waiting;
      if (registration.active) askStatus();
      await navigator.serviceWorker.ready; askStatus();
    } catch { error = 'Offline download could not finish. Check the connection and available browser storage, then retry.'; render(); }
  }
  if (supported) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'BB_OFFLINE_REPAIR_FAILED') { error = 'Download incomplete. Reconnect and retry before going offline.'; render(); return; }
      if (!['BB_OFFLINE_READY', 'BB_OFFLINE_INCOMPLETE'].includes(event.data?.type)) return;
      ready = event.data.type === 'BB_OFFLINE_READY';
      error = ready ? '' : 'Some offline files are missing. Reconnect and retry the download.'; render();
    });
    navigator.serviceWorker.addEventListener('controllerchange', askStatus);
    $('installRetry').addEventListener('click', async () => {
      // The browser may have evicted individual cached files. Refill this app's active cache
      // through a worker message; registering the same version alone would not repair it.
      error = ''; render();
      if (registration?.active) registration.active.postMessage({ type: 'BB_OFFLINE_REPAIR' });
      else download();
    });
    download();
  } else { error = 'Installation needs HTTPS or localhost. The local game files still work offline.'; render(); }
  window.BB_INSTALL = { get ready() { return ready; }, get canPrompt() { return !!prompt; }, show: () => button.click() };
})();
