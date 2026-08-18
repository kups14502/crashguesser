// Probe each round's video ID in isolation through the real YT IFrame API and
// report its terminal state / error code. Error 101 & 150 = embedding disabled
// by the uploader; 100 = removed/private; 2 = bad id; 5 = HTML5 player error.
const { chromium } = require('playwright-core');

const CHROME = '/home/brendon/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const IDS = process.argv.slice(2);
if (!IDS.length) { console.error('usage: node probe-embed.js <id> [id...]'); process.exit(2); }

const PAGE = (id) => `<!doctype html><html><body><div id="t"></div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
window.__r = { states: [], error: null, ready: false };
const NAMES={'-1':'UNSTARTED',0:'ENDED',1:'PLAYING',2:'PAUSED',3:'BUFFERING',5:'CUED'};
function onYouTubeIframeAPIReady(){
  new YT.Player('t', { videoId: ${JSON.stringify(id)}, width: 640, height: 360,
    playerVars:{autoplay:1,mute:1,controls:0,playsinline:1},
    events:{
      onReady:e=>{ window.__r.ready=true; e.target.mute(); e.target.playVideo(); },
      onStateChange:e=>window.__r.states.push(NAMES[e.data] ?? e.data),
      onError:e=>{ window.__r.error=e.data; }
    }});
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;
<\/script></body></html>`;

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  for (const id of IDS) {
    const page = await browser.newPage();
    // Serve from a real https origin so YouTube sees a normal referrer.
    await page.route('https://crashguessr.test/**', (r) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: PAGE(id) }));
    await page.goto('https://crashguessr.test/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(12000);
    const r = await page.evaluate(() => window.__r);
    const verdict = r.error ? `ERROR ${r.error}` :
      r.states.includes('PLAYING') ? 'PLAYS' : `NO-PLAY (${r.states.join('>') || 'no states'})`;
    console.log(`${id}  ready=${r.ready}  states=[${r.states.join(' > ')}]  error=${r.error}  => ${verdict}`);
    await page.close();
  }
  await browser.close();
})();
