/* Optional integration checks. PLAYWRIGHT_MODULE may point at an existing Playwright install. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const output = process.env.CHECK_OUTPUT;
const entry = '/burrow-brawl.html';
const source = fs.readFileSync(path.join(root, decodeURIComponent(entry)), 'utf8').replace('<script src="game.js" defer></script>', '<script>' + fs.readFileSync(path.join(root,'game.js'),'utf8') + '</script>');
const injected = source.replace('/* backdrop for the menu:', `window.testGame = {
  game, NET, alive, startGame, readCfg, phaseStep, step, syncHUD, syncWorms, updateCamera, camera, cam,
  beginPlacement, nextPlacement, placementPoint, autoPlacementPoint, commitPlacement, requestPlacement, receivePlacementRequest,
  humanPlacement, humanTurn, makeInit, loadFromInit, buildSnap, applySnapshot, applyEvent, findSpots, toScreen,
  updateObj, updateWorm, addObj, explode, busy, fxList, updateFx, clearWorld,
  entities: () => ({ worms, objs, bodies, projs }),
  pause: () => { paused = true; window.__testFreeze = true; }, resume: () => { paused = false; window.__testFreeze = false; },
  clock: dt => { const before = paused; paused = false; placementClock(dt); paused = before; },
  aim: p => { placementAim = p; },
  setup: (teams = 3, count = 2, placement = 'user') => {
    NET.mode = 'off'; NET.role = 'host'; paused = true; window.__testFreeze = true;
    const cfg = readCfg(); Object.assign(cfg, { placement, worms: count, quality: 'low', theme: 'meadow', shape: 'hills', weather: 'clear', time: 'day', fallingLand: false,
      teams: Array.from({length: teams}, (_, i) => ({name: 'Team ' + (i + 1), cpu: false, owner: 'host'})) });
    startGame(cfg); phaseStep(2.5); syncHUD(0); syncWorms(0);
    updateCamera(10); camera.updateMatrixWorld(); renderer.render(scene, camera); return cfg;
  }
}; setQuality('low');
/* backdrop for the menu:`).replace('requestAnimationFrame(frame);', 'requestAnimationFrame(frame); if (window.__testFreeze) { last = now; return; }');
let failDownload = false, updateVersion = false, serverOffline = false;
const requests = [];
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  requests.push(pathname);
  if (serverOffline) { res.writeHead(503); res.end('server unreachable for offline test'); return; }
  if (failDownload && pathname === '/assets/app/icon-512.png') { res.writeHead(503); res.end('test download interruption'); return; }
  if (pathname === '/test-game.html') { res.setHeader('Content-Type', 'text/html'); res.end(injected); return; }
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream'); res.setHeader('Cache-Control', 'no-store');
  let data = fs.readFileSync(file);
  if (updateVersion && pathname === '/offline-assets.js') data = data.toString().replace(/"version": "[^"]+"/, '"version": "integration-update"');
  res.end(data);
});
const results = {};
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const errors = [], external = [];
  const watch = page => {
    page.setDefaultNavigationTimeout(90000); page.setDefaultTimeout(60000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(origin)) external.push(r.url()); });
  };
  try {
    if (!process.env.CHECK_PWA_ONLY) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    const page = await ctx.newPage(); watch(page);
    await page.goto(origin + '/test-game.html');
    await page.waitForFunction(() => window.__bbBoot && window.testGame);
    results.placement = await page.evaluate(() => {
      const t = testGame, check = (ok, message) => { if (!ok) throw Error(message); };
      check(t.readCfg().placement === 'random', 'Random must be default');
      t.setup(); const ws = t.entities().worms;
      check(ws.length === 6 && ws.every(w => w.pendingPlacement && !t.alive(w) && !w.mesh.visible && w.label.el.hidden), 'Reserved worms visible/alive');
      check(t.game.phase === 'placement' && t.game.placement.left === 15 && t.game.turnCount === 0, 'Placement not entered with 15 seconds');
      const idle = ws[5], original = {x: idle.x, y: idle.y, hp: idle.hp};
      const dormant = t.addObj('mine', idle.x, idle.y); dormant.rest = true; dormant.armT = 0; dormant.t = 2;
      t.updateObj(dormant, .02); check(!dormant.lit, 'Undeployed worm triggered a mine');
      t.explode(idle.x, idle.y, 30, 40, {quiet: true, noSlow: true}); t.updateWorm(idle, .2);
      check(idle.hp === original.hp && idle.x === original.x && idle.y === original.y, 'Reserved worm damaged/moved');
      check(!t.commitPlacement(NaN, 50) && !t.commitPlacement(0, 50) && !t.commitPlacement(500, 99999), 'Invalid placement accepted');
      const p = t.autoPlacementPoint(), mine = t.addObj('mine', p.x, p.y + 6); mine.rest = true; mine.armT = 0; mine.t = 2;
      check(t.commitPlacement(p.x, p.y), 'Manual placement rejected');
      const first = ws[0]; check(first.arriving && first.teleT > 0 && t.alive(first), 'Arrival not live');
      t.updateObj(mine, .02); check(mine.lit, 'Placing over a mine did not trigger it');
      const hp = first.hp;
      for (let i = 0; i < 230; i++) t.step(1 / 120);
      check(!t.entities().objs.includes(mine) && (first.hp < hp || first.dead), 'Live mine failed to explode/damage during placement');
      check(ws.slice(1).every(w => w.pendingPlacement && w.hp === 100), 'Blast damaged pending reserve');
      check(t.game.turnCount === 0 && t.game.phase === 'placement-wait', 'Combat started before everyone deployed');
      const damage = hp - first.hp;
      const order = [first.team.name]; t.clock(1.61);
      check(t.game.placement.index === 1 && t.game.placement.left === 15, 'Second team did not receive full time');
      t.clock(14.9); check(ws[1].pendingPlacement && t.game.placement.left > 0, 'Timeout placed early');
      t.clock(.11); check(!ws[1].pendingPlacement, 'Timeout did not auto-place'); order.push(ws[1].team.name);
      t.clock(1.61); ws[2].team.cpu = true; t.clock(2.6); check(!ws[2].pendingPlacement, 'CPU failed to place'); order.push(ws[2].team.name);
      for (let i = 3; i < 6; i++) {
        t.clock(1.61); check(t.game.placement.index === i, 'Placement order skipped a worm'); order.push(ws[i].team.name);
        if (ws[i].team.cpu) t.clock(2.6); else { const spot = t.autoPlacementPoint(); check(t.commitPlacement(spot.x, spot.y), 'Later manual placement failed'); }
        check(!ws[i].pendingPlacement && t.game.turnCount === 0, 'Round-robin placement failed');
      }
      t.game.teams.forEach(team => team.cpu = false); t.clock(1.61);
      check(!t.game.placement && t.game.phase === 'settle', 'Final placement did not reach settlement');
      for (let i = 0; i < 2600 && !t.game.turnCount; i++) t.step(1 / 120);
      check(t.game.turnCount === 1 && t.game.phase === 'turn', 'Combat did not begin after deployment');
      t.syncHUD(0); check(!document.body.classList.contains('placing'), 'Placement HUD persisted into battle');
      const noPending = ws.every(w => !w.pendingPlacement);
      t.setup(2, 1, 'random'); check(t.entities().worms.every(w => !w.pendingPlacement) && !t.game.placement, 'Random placement regressed');
      return { order, mineDamage: damage, pendingProtected: true, allDeployed: noPending, timeout: '15 seconds', combatTurn: 1, randomDefault: true };
    });
    // Real mouse/keyboard input (no direct commit), plus the rendered deployment HUD.
    await page.evaluate(() => { testGame.setup(2, 1); testGame.game.teams[1].cpu = true; testGame.resume(); });
    const mouseSpot = await page.evaluate(() => {
      const t = testGame; return t.findSpots(50, 20).map(p => t.placementPoint(p.x, p.y)).filter(Boolean).map(p => ({p, screen:t.toScreen(p.x, p.y)})).find(v => v.screen[0] > 120 && v.screen[0] < 1100 && v.screen[1] > 180 && v.screen[1] < 580);
    });
    assert(mouseSpot, 'No visible mouse-placement fixture');
    await page.mouse.move(...mouseSpot.screen);
    if (output) await page.screenshot({ path: path.join(output, 'bb-placement.png'), timeout: 30000 });
    await page.mouse.click(...mouseSpot.screen);
    await page.waitForFunction(() => !testGame.entities().worms[0].pendingPlacement);
    await page.evaluate(() => { testGame.pause(); testGame.setup(2, 1); testGame.aim(testGame.autoPlacementPoint()); testGame.resume(); });
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !testGame.entities().worms[0].pendingPlacement);
    await page.evaluate(() => testGame.pause());
    results.input = { mouse: true, keyboard: true };
    console.log('Placement, live mine, rounds, timeout, CPU, mouse and keyboard passed.');

    // Two independent browsers exercise host authority and the friend's placement request/snapshot path.
    const friend = await ctx.newPage(); watch(friend); await friend.goto(origin + '/test-game.html');
    await friend.waitForFunction(() => window.testGame && window.__bbBoot);
    const init = await page.evaluate(() => {
      const t = testGame; t.setup(2, 2); t.game.teams[1].owner = 'guest'; t.game.cfg.teams[1].owner = 'guest';
      t.NET.mode = 'host'; t.NET.role = 'host'; t.NET.gr = {presence: async () => {}}; return t.makeInit();
    });
    await friend.evaluate(init => { const t = testGame; t.pause(); t.NET.mode = 'guest'; t.NET.role = 'guest'; t.NET.gr = {presence: async p => { if (p.place) window.lastPlace = p.place; }}; t.loadFromInit(init); }, init);
    await friend.waitForFunction(seed => testGame.NET.loadedSeed === seed, init.seed);
    await page.evaluate(() => { const t = testGame, p = t.autoPlacementPoint(); t.commitPlacement(p.x, p.y); t.clock(1.61); });
    const snap = await page.evaluate(() => testGame.buildSnap());
    await friend.evaluate(s => { const t = testGame; t.applySnapshot(s); t.resume(); const p = t.autoPlacementPoint(); if (!t.requestPlacement(p.x, p.y)) throw Error('Friend cannot request placement'); t.pause(); }, snap);
    const req = await friend.evaluate(() => window.lastPlace);
    assert(req && req[1] === 1, 'Guest did not send its placement request');
    const networkResult = await page.evaluate(req => {
      const t = testGame;
      if (t.receivePlacementRequest([req[0] + 1, req[1], req[2], req[3]])) throw Error('Stale seed accepted');
      if (t.receivePlacementRequest([req[0], req[1] + 1, req[2], req[3]])) throw Error('Wrong slot accepted');
      if (t.receivePlacementRequest([req[0], req[1], null, req[3]])) throw Error('Invalid coordinate accepted');
      if (!t.receivePlacementRequest(req) || t.receivePlacementRequest(req)) throw Error('Request rejected or replayed');
      return { snap: t.buildSnap(), auth: t.game.authRole };
    }, req);
    assert.equal(networkResult.auth, 'host');
    const guestState = await friend.evaluate(s => { const t = testGame; t.applySnapshot(s); t.syncWorms(0); return t.entities().worms.map(w => ({ pending: w.pendingPlacement, x: w.x, y: w.y })); }, networkResult.snap);
    assert.deepEqual(guestState.map(w => w.pending), [false, false, true, true]);
    assert(Math.abs(guestState[1].x - req[2]) < .2);
    results.friendPlacement = { authoritativeHost: true, duplicateAndStaleRejected: true, pendingSnapshot: true };
    console.log('Two-browser friend placement and snapshot checks passed.');
    await ctx.close();

    const mobile = await browser.newContext({ viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    const touch = await mobile.newPage(); watch(touch); await touch.goto(origin + '/test-game.html');
    await touch.waitForFunction(() => window.testGame && window.__bbBoot);
    await touch.evaluate(() => { testGame.setup(2, 1); testGame.resume(); });
    const cdp = await mobile.newCDPSession(touch);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{x:140,y:400,id:1},{x:240,y:400,id:2}] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{x:120,y:420,id:1},{x:260,y:420,id:2}] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{x:190,y:420,id:1}] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    assert(await touch.evaluate(() => testGame.entities().worms[0].pendingPlacement), 'Pinch/cancel accidentally placed worm');
    const touchSpot = await touch.evaluate(() => {
      const t = testGame; t.cam.free = false; t.updateCamera(10); t.camera.updateMatrixWorld();
      return t.findSpots(50, 20).map(p => t.placementPoint(p.x, p.y)).filter(Boolean).map(p => t.toScreen(p.x, p.y)).find(p => p[0] > 65 && p[0] < 310 && p[1] > 230 && p[1] < 600);
    });
    assert(touchSpot, 'No visible mobile placement fixture');
    await touch.touchscreen.tap(...touchSpot);
    await touch.waitForFunction(() => !testGame.entities().worms[0].pendingPlacement);
    await touch.evaluate(() => { testGame.pause(); testGame.syncHUD(0); });
    if (output) await touch.screenshot({path:path.join(output,'bb-placement-mobile.png')});
    results.input.touch = true; results.input.pinchAndCancelSafe = true;
    console.log('Mobile tap, pinch and cancellation passed.');
    await mobile.close();
    }

    const pwa = await browser.newContext({ viewport: {width:1280,height:800} });
    let app = await pwa.newPage(); watch(app); await app.goto(origin + entry);
    await app.waitForFunction(() => window.__bbBoot && window.BB_INSTALL?.ready && navigator.serviceWorker.controller, {timeout:60000});
    await app.evaluate(() => document.fonts.ready);
    await app.click('#installButton');
    if (output) await app.screenshot({path:path.join(output,'bb-install.png'),timeout:30000});
    const session = await pwa.newCDPSession(app);
    const manifest = await session.send('Page.getAppManifest'); assert.equal(manifest.errors.length, 0);
    const installability = await session.send('Page.getInstallabilityErrors'); assert.deepEqual(installability.installabilityErrors, []);
    // Exercise our native prompt wiring, with a synthetic browser prompt object.
    await app.evaluate(() => {
      const e = new Event('beforeinstallprompt', {cancelable:true});
      e.prompt = async () => { window.promptCalled = true; }; e.userChoice = Promise.resolve({outcome:'dismissed'}); dispatchEvent(e);
    });
    await app.click('#installNative'); assert(await app.evaluate(() => window.promptCalled));
    await app.click('#installClose');
    const cached = await app.evaluate(async () => { const k = (await caches.keys()).find(k => k.startsWith('burrow-brawl:')); return {key:k,count:(await (await caches.open(k)).keys()).length}; });
    assert.equal(cached.count, 22);
    // Missing file detection and repair, including a failed offline repair.
    await app.evaluate(async key => { await (await caches.open(key)).delete(new URL('vendor/engine.js', location.href)); navigator.serviceWorker.controller.postMessage({type:'BB_OFFLINE_STATUS'}); }, cached.key);
    await app.waitForFunction(() => !BB_INSTALL.ready);
    await pwa.setOffline(true); serverOffline = true; await app.click('#installButton'); await app.click('#installRetry');
    await app.waitForFunction(() => document.getElementById('offlineStatus').textContent.includes('Download incomplete'));
    serverOffline = false; await pwa.setOffline(false); await app.click('#installRetry'); await app.waitForFunction(() => BB_INSTALL.ready);
    await app.close(); await pwa.setOffline(true); serverOffline = true;
    const requestCount = requests.length;
    app = await pwa.newPage(); watch(app); await app.goto(origin + entry + '?launcher=1');
    await app.waitForFunction(() => window.__bbBoot && window.BB_INSTALL?.ready, {timeout:60000});
    await app.selectOption('#cGfx', 'low'); await app.selectOption('#cWeather','clear'); await app.click('#bStart');
    await app.waitForFunction(() => document.body.classList.contains('ingame') && document.getElementById('timer').textContent !== '–', {timeout:60000});
    assert.equal(await app.locator('#installButton').isVisible(), false, 'Install button must be hidden during battle');
    assert.deepEqual(requests.slice(requestCount).filter(p => !['/sw.js','/offline-assets.js'].includes(p)), [], 'Offline runtime missed its cache');
    assert(await app.evaluate(() => document.getElementById('gameLogo').naturalWidth > 0 && [...document.querySelectorAll('.artIcon')].every(i => i.naturalWidth > 0)), 'Offline artwork missing');
    results.offline = { files:cached.count, coldPageLaunch:true, queryStringLaunch:true, battleStarted:true, artwork:true, repairedEviction:true, installabilityErrors:[] };
    // Updates download in the background, but must not activate over an ongoing match.
    serverOffline = false; await pwa.setOffline(false); updateVersion = true;
    await app.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r.update(); });
    await app.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()).waiting, {timeout:60000});
    assert(await app.evaluate(async key => (await caches.keys()).includes(key), cached.key));
    await app.close();
    app = await pwa.newPage(); watch(app); await app.goto(origin + entry);
    await app.waitForFunction(async () => window.__bbBoot && BB_INSTALL.ready && (await caches.keys()).some(k => k.endsWith(':integration-update')), {timeout:60000});
    await app.waitForFunction(async key => !(await caches.keys()).includes(key), cached.key);
    results.offline.updateWaitedForMatchClose = true;
    await pwa.close(); updateVersion = false;

    // A partial first download cannot claim success; retry recovers.
    const broken = await browser.newContext(); const interrupted = await broken.newPage(); watch(interrupted);
    failDownload = true; await interrupted.goto(origin + entry);
    await interrupted.waitForFunction(() => document.getElementById('offlineStatus')?.textContent.includes('Download incomplete'), {timeout:60000});
    assert.equal(await interrupted.evaluate(() => BB_INSTALL.ready), false);
    failDownload = false; await interrupted.click('#installButton'); await interrupted.click('#installRetry');
    await interrupted.waitForFunction(() => BB_INSTALL.ready, {timeout:60000});
    results.offline.partialDownloadRetried = true; await broken.close();

    const fileCtx = await browser.newContext({offline:true}); const local = await fileCtx.newPage(); watch(local);
    await local.goto('file://' + path.join(root, decodeURIComponent(entry)));
    await local.waitForFunction(() => window.__bbBoot && window.BB_ENGINE && window.BB_INSTALL);
    await local.click('#installButton');
    assert.match(await local.locator('#installSteps').textContent(), /HTTPS/);
    results.directFileOffline = true; await fileCtx.close();
    assert.deepEqual(errors, []); assert.deepEqual(external, []);
    results.browserErrors = errors; results.externalRequests = external;
    console.log(JSON.stringify(results, null, 2));
  } finally { failDownload = serverOffline = false; await browser.close(); server.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
