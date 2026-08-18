// Diagnostic: load CrashGuessr in a real Chromium and report why the clip pane
// stays on the loading spinner. Prints a timeline of YT player states.
const { chromium } = require('playwright-core');

const CHROME = '/home/brendon/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const URL = process.env.CG_URL || 'http://127.0.0.1:8095/index.html';
const WATCH_MS = Number(process.env.CG_WATCH || 20000);

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleMsgs = [];
  const failedReqs = [];
  page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) =>
    failedReqs.push(`${r.failure()?.errorText} ${r.url().slice(0, 120)}`));

  // Instrument before any app code runs: wrap YT.Player so we capture the real
  // player state machine, not just what the DOM flags claim.
  await page.addInitScript(() => {
    const t0 = Date.now();
    window.__cg = { states: [], errors: [], playerMade: false };
    const NAMES = { '-1': 'UNSTARTED', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'CUED' };
    let installed = false;
    const install = () => {
      if (installed || typeof YT === 'undefined' || !YT.Player) return;
      installed = true;
      const Orig = YT.Player;
      YT.Player = function (el, opts) {
        window.__cg.playerMade = true;
        const ev = (opts && opts.events) || {};
        const userState = ev.onStateChange;
        const userErr = ev.onError;
        ev.onStateChange = function (e) {
          window.__cg.states.push({ t: Date.now() - t0, s: NAMES[e.data] ?? e.data });
          if (userState) userState(e);
        };
        ev.onError = function (e) {
          window.__cg.errors.push({ t: Date.now() - t0, code: e.data });
          if (userErr) userErr(e);
        };
        opts.events = ev;
        return new Orig(el, opts);
      };
      YT.Player.prototype = Orig.prototype;
      Object.assign(YT.Player, Orig);
    };
    const iv = setInterval(install, 50);
    setTimeout(() => clearInterval(iv), 15000);
    install();
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Hook the YT API once it exists so we see real state transitions.
  await page.evaluate(() => {
    const hook = () => {
      if (typeof YT === 'undefined' || !YT.Player) return false;
      window.__cg.apiReady = true;
      return true;
    };
    if (!hook()) {
      const iv = setInterval(() => { if (hook()) clearInterval(iv); }, 200);
    }
  });

  const t0 = Date.now();
  const timeline = [];
  while (Date.now() - t0 < WATCH_MS) {
    const snap = await page.evaluate(() => {
      const ld = document.getElementById('videoLoading');
      const btn = document.getElementById('tapPlayBtn');
      const fr = document.getElementById('ytFrame');
      const iframe = document.querySelector('#ytFrame iframe');
      let playerState = 'n/a';
      try {
        // The app keeps ytPlayer in closure scope; probe the iframe instead.
        playerState = iframe ? 'iframe-present' : 'no-iframe';
      } catch (e) {}
      return {
        loadingVisible: ld && !ld.hidden,
        retryVisible: btn && !btn.hidden,
        retryText: btn ? btn.textContent : null,
        ytFrameHidden: fr ? fr.hidden : null,
        iframeSrc: iframe ? iframe.src.slice(0, 90) : null,
        ytApi: typeof YT !== 'undefined' && !!(window.YT && YT.Player),
        playerState,
      };
    });
    timeline.push({ t: Math.round((Date.now() - t0) / 1000), ...snap });
    await page.waitForTimeout(2000);
  }

  // Dedupe consecutive identical rows for readability.
  const rows = [];
  let prev = '';
  for (const r of timeline) {
    const key = JSON.stringify({ ...r, t: 0 });
    if (key !== prev) { rows.push(r); prev = key; }
  }

  console.log('=== TIMELINE (deduped) ===');
  for (const r of rows) {
    console.log(
      `t=${r.t}s loading=${r.loadingVisible} retry=${r.retryVisible}(${r.retryText}) ` +
      `ytApi=${r.ytApi} iframe=${r.playerState} src=${r.iframeSrc}`);
  }

  const yt = await page.evaluate(() => ({
    playerMade: window.__cg.playerMade,
    states: window.__cg.states,
    errors: window.__cg.errors,
  }));
  console.log('\n=== YT PLAYER ===');
  console.log(`playerConstructed=${yt.playerMade}`);
  console.log(`states: ${yt.states.map((s) => `${(s.t / 1000).toFixed(1)}s:${s.s}`).join(' -> ') || '(none)'}`);
  console.log(`errors: ${JSON.stringify(yt.errors)}`);

  console.log('\n=== FINAL ===');
  console.log(JSON.stringify(timeline[timeline.length - 1], null, 2));

  console.log('\n=== CONSOLE (last 30) ===');
  console.log(consoleMsgs.slice(-30).join('\n') || '(none)');

  console.log('\n=== FAILED REQUESTS (last 20) ===');
  console.log(failedReqs.slice(-20).join('\n') || '(none)');

  await page.screenshot({ path: '/tmp/cg_diag.png' });
  console.log('\nscreenshot -> /tmp/cg_diag.png');

  await browser.close();
})();
