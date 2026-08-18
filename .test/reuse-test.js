// Isolate the player-reuse path: create ONE YT.Player then walk it through the
// day's 5 video IDs via loadVideoById, exactly as app.js does. Answers whether
// the round-3 failure is caused by that specific video or by reuse position.
const { chromium } = require('playwright-core');

const CHROME = '/home/brendon/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const IDS = process.argv.slice(2);
if (!IDS.length) { console.error('usage: node reuse-test.js <id> [id...]'); process.exit(2); }

const PAGE = (ids) => `<!doctype html><html><body><div id="t"></div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
const IDS = ${JSON.stringify(ids)};
const NAMES={'-1':'UNSTARTED',0:'ENDED',1:'PLAYING',2:'PAUSED',3:'BUFFERING',5:'CUED'};
window.__log = [];
let player = null, idx = 0;
const t0 = Date.now();
const rec = (o) => window.__log.push(Object.assign({t: Date.now()-t0, round: idx+1, id: IDS[idx]}, o));

window.onYouTubeIframeAPIReady = function(){
  player = new YT.Player('t', { videoId: IDS[0], width: 640, height: 360,
    playerVars:{autoplay:1,mute:1,controls:0,modestbranding:1,rel:0,
                iv_load_policy:3,disablekb:1,fs:0,playsinline:1},
    events:{
      onReady: e => { rec({ev:'READY'}); e.target.mute(); e.target.playVideo(); },
      onStateChange: e => rec({ev:'STATE', s:NAMES[e.data] ?? e.data}),
      onError: e => rec({ev:'ERROR', code:e.data})
    }});
};

// Advance exactly like loadRound(): pause, then loadVideoById + mute.
window.__next = function(){
  idx++;
  if (idx >= IDS.length) return false;
  rec({ev:'ADVANCE'});
  if (player && player.pauseVideo) player.pauseVideo();
  player.loadVideoById(IDS[idx]);
  player.mute();
  return true;
};
window.__playing = function(){
  try { return player && player.getPlayerState && player.getPlayerState() === 1; }
  catch(e){ return false; }
};
window.__curId = function(){
  try { return player.getVideoData().video_id; } catch(e){ return null; }
};
<\/script></body></html>`;

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.route('https://crashguessr.test/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: PAGE(IDS) }));
  await page.goto('https://crashguessr.test/', { waitUntil: 'domcontentloaded' });

  for (let i = 0; i < IDS.length; i++) {
    // Wait up to 15s for this round to reach PLAYING.
    let playing = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await page.evaluate(() => window.__playing && window.__playing())) { playing = true; break; }
      await page.waitForTimeout(400);
    }
    const cur = await page.evaluate(() => window.__curId && window.__curId());
    console.log(`round ${i + 1}  want=${IDS[i]}  actual=${cur}  playing=${playing ? 'YES' : 'NO'}`);
    if (i < IDS.length - 1) {
      await page.evaluate(() => window.__next());
      await page.waitForTimeout(1200);
    }
  }

  const log = await page.evaluate(() => window.__log);
  console.log('\n=== EVENT LOG ===');
  for (const e of log) {
    console.log(`${(e.t / 1000).toFixed(1)}s r${e.round}(${e.id}) ${e.ev}${e.s ? ' ' + e.s : ''}${e.code !== undefined ? ' code=' + e.code : ''}`);
  }
  await browser.close();
})();
