// Probe one video ID from several page origins. YouTube error 101/150 can be
// origin-sensitive, so this separates "embedding disabled everywhere" from
// "only blocked on this dev origin".
const { chromium } = require('playwright-core');

const CHROME = '/home/brendon/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome';
const ID = process.argv[2];
const ORIGINS = process.argv.slice(3);
if (!ID || !ORIGINS.length) {
  console.error('usage: node probe-origin.js <videoId> <origin> [origin...]');
  process.exit(2);
}

const PAGE = (id) => `<!doctype html><html><body><div id="t"></div>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
window.__r={states:[],error:null,ready:false};
const N={'-1':'UNSTARTED',0:'ENDED',1:'PLAYING',2:'PAUSED',3:'BUFFERING',5:'CUED'};
window.onYouTubeIframeAPIReady=function(){
  new YT.Player('t',{videoId:${JSON.stringify(id)},width:640,height:360,
    playerVars:{autoplay:1,mute:1,controls:0,playsinline:1},
    events:{
      onReady:e=>{window.__r.ready=true;e.target.mute();e.target.playVideo();},
      onStateChange:e=>window.__r.states.push(N[e.data]??e.data),
      onError:e=>{window.__r.error=e.data;}
    }});
};
<\/script></body></html>`;

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  for (const origin of ORIGINS) {
    const page = await browser.newPage();
    await page.route(`${origin}/**`, (r) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: PAGE(ID) }));
    try {
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(10000);
      const r = await page.evaluate(() => window.__r);
      const verdict = r.error ? `ERROR ${r.error}`
        : r.states.includes('PLAYING') ? 'PLAYS'
        : `NO-PLAY (${r.states.join('>') || 'none'})`;
      console.log(`${origin.padEnd(34)} ready=${String(r.ready).padEnd(5)} states=[${r.states.join('>')}] => ${verdict}`);
    } catch (e) {
      console.log(`${origin.padEnd(34)} threw: ${e.message.split('\n')[0]}`);
    }
    await page.close();
  }
  await browser.close();
})();
