// Run the REAL app but serve an instrumented copy of app.js (via response
// interception, so the on-disk file is untouched) that reports YT error codes
// and state transitions from inside the IIFE closure.
const fs = require('fs');
const { chromium } = require('playwright-core');

const CHROME = '/home/brendon/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const APP = '/home/brendon/crashguesser/app.js';
const URL = process.env.CG_URL || 'http://127.0.0.1:8095/index.html';

function instrument(src) {
  let out = src;
  const before = out;

  out = out.replace(
    'function onYtError() {',
    'function onYtError(e) { window.__t.push({ev:"ERROR", code: e && e.data, t: Date.now()-window.__t0});');

  out = out.replace(
    'function onYtStateChange(e) {',
    'function onYtStateChange(e) { window.__t.push({ev:"STATE", s: e.data, t: Date.now()-window.__t0});');

  out = out.replace(
    'function showRetry() {',
    'function showRetry() { window.__t.push({ev:"SHOW_RETRY", t: Date.now()-window.__t0});');

  out = out.replace(
    'function playYoutube(id) {',
    'function playYoutube(id) { window.__t.push({ev:"PLAY_YT", id: id, t: Date.now()-window.__t0});');

  out = out.replace(
    'function armStallWatch() {',
    'function armStallWatch() { window.__t.push({ev:"ARM_STALL", t: Date.now()-window.__t0});');

  // Expose live player identity for ground truth on what is actually loaded.
  out = out.replace(
    '})();',
    'window.__cur = function(){ try { return ytPlayer.getVideoData().video_id; } catch(e){ return null; } };\n' +
    'window.__state = function(){ try { return ytPlayer.getPlayerState(); } catch(e){ return null; } };\n})();');

  if (out === before) throw new Error('instrumentation did not apply - app.js shape changed');
  return out;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();

  await page.addInitScript(() => { window.__t = []; window.__t0 = Date.now(); });

  const patched = instrument(fs.readFileSync(APP, 'utf8'));
  await page.route('**/app.js*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: patched }));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  const NAMES = { '-1': 'UNSTARTED', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'CUED' };

  for (let round = 1; round <= 5; round++) {
    let playing = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await page.evaluate(() => window.__state && window.__state() === 1)) { playing = true; break; }
      await page.waitForTimeout(400);
    }
    const cur = await page.evaluate(() => window.__cur && window.__cur());
    console.log(`round ${round}  actual=${cur}  playing=${playing ? 'YES' : 'NO'}`);

    await page.click('#map', { position: { x: 200, y: 200 } });
    await page.click('#guessBtn');
    await page.waitForTimeout(400);
    await page.click('#resultNextBtn');
    await page.waitForTimeout(1000);
  }

  const t = await page.evaluate(() => window.__t);
  console.log('\n=== TRACE ===');
  for (const e of t) {
    const s = e.s !== undefined ? ` ${NAMES[e.s] ?? e.s}` : '';
    const c = e.code !== undefined ? ` code=${e.code}` : '';
    const id = e.id ? ` ${e.id}` : '';
    console.log(`${(e.t / 1000).toFixed(1)}s ${e.ev}${id}${s}${c}`);
  }
  await browser.close();
})();
