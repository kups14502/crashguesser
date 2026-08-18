// Vet candidate clips before they go anywhere near data.js.
//
// Sourcing rounds by hand is where the leaks came from, so this checks the
// things that are checkable and shows you the rest. For each video id it
// reports:
//
//   title/channel  - read from the player, so a candidate id is CONFIRMED to be
//                    the video you think it is. Never add a clip whose title
//                    here does not match what you expected.
//   embeddable     - plays from the production origin, or the YouTube error
//                    code. Error 101/150 means the uploader disallows embedding
//                    and the clip is unusable no matter how good it looks.
//   captions       - whether a caption track exists AT ALL, checked by forcing
//                    cc_load_policy=1. This is the sourcing filter that matters:
//                    captions cannot be suppressed at playback time (see
//                    probe-captions.js), so a clip with a track will leak to
//                    some viewers no matter what the player code does.
//   duration       - short raw clips are better; a long one usually means a
//                    studio segment wrapped around the footage.
//
// It also writes screenshots across the clip so the un-checkable things
// (burned-in station bugs, chyrons, on-scene cuts, whether it is even a dashcam
// POV) can be eyeballed in one pass.
//
// Usage: node vet-clips.js <videoId> [videoId...]
//        node vet-clips.js --known     # re-vet the clips already in data.js
const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.CG_ROOT || path.resolve(__dirname, '..');
const ORIGIN = process.env.CG_ORIGIN || 'https://dashguesser.brendonkupsch.com';
const SHOT_DIR = process.env.CG_SHOTS || path.join(os.tmpdir(), 'cg_vet');
const SHOTS_PER_CLIP = 6;

function resolveChrome() {
  if (process.env.CG_CHROME) return process.env.CG_CHROME;
  const candidates = [];
  try { candidates.push(chromium.executablePath()); } catch (e) { /* not resolvable */ }
  const registry = process.env.PLAYWRIGHT_BROWSERS_PATH || (
    process.platform === 'win32' ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    : path.join(os.homedir(), '.cache', 'ms-playwright')
  );
  if (fs.existsSync(registry)) {
    for (const dir of fs.readdirSync(registry).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      candidates.push(
        path.join(registry, dir, 'chrome-win64', 'chrome.exe'),
        path.join(registry, dir, 'chrome-linux64', 'chrome'),
      );
    }
  }
  return candidates.find((p) => p && fs.existsSync(p));
}

const YT_ERRORS = {
  2: 'invalid video id',
  5: 'HTML5 player error',
  100: 'video not found / private',
  101: 'embedding disabled by uploader',
  150: 'embedding disabled by uploader',
};

async function vet(browser, id) {
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body style="margin:0;background:#000">'
          + '<div id="t"></div><script src="https://www.youtube.com/iframe_api"></script></body></html>',
    }));
    await page.goto(`${ORIGIN}/vet.html`, { waitUntil: 'domcontentloaded' });

    // cc_load_policy:1 forces captions on. We are not trying to watch them, we
    // are asking whether this clip HAS any, which is the disqualifying trait.
    const boot = await page.evaluate(async (videoId) => {
      window.__v = { error: null, states: [], ready: false };
      await new Promise((resolve) => {
        const go = () => {
          window.__p = new YT.Player('t', {
            videoId, width: 960, height: 540,
            playerVars: {
              autoplay: 1, mute: 1, controls: 0, rel: 0, playsinline: 1,
              cc_load_policy: 1,
            },
            events: {
              onReady: (e) => { window.__v.ready = true; e.target.mute(); e.target.playVideo(); },
              onStateChange: (e) => window.__v.states.push(e.data),
              onError: (e) => { window.__v.error = e.data; },
            },
          });
          setTimeout(resolve, 7000);
        };
        if (window.YT && window.YT.Player) go();
        else window.onYouTubeIframeAPIReady = go;
      });
      const p = window.__p;
      const safe = (fn, d) => { try { return fn(); } catch (e) { return d; } };
      const track = safe(() => p.getOption('captions', 'track'), null);
      const list = safe(() => p.getOption('captions', 'tracklist'), null);
      const data = safe(() => p.getVideoData(), null);
      return {
        error: window.__v.error,
        played: window.__v.states.includes(1),
        duration: safe(() => p.getDuration(), 0),
        title: data ? data.title : null,
        author: data ? data.author : null,
        activeTrack: track && Object.keys(track).length ? (track.languageCode || 'on') : null,
        trackCount: Array.isArray(list) ? list.length : null,
        modules: safe(() => p.getOptions(), []),
      };
    }, id);

    const shots = [];
    if (boot.played && boot.duration > 0) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      for (let i = 0; i < SHOTS_PER_CLIP; i++) {
        // Spread across the clip but skip the very start and very end, which
        // are intros and end screens rather than footage.
        const at = boot.duration * (0.08 + (0.84 * i) / (SHOTS_PER_CLIP - 1));
        await page.evaluate((t) => window.__p.seekTo(t, true), at);
        await page.waitForTimeout(900);
        const file = path.join(SHOT_DIR, `${id}_${String(i).padStart(2, '0')}_${at.toFixed(0)}s.png`);
        await page.screenshot({ path: file });
        shots.push(file);
      }
    }
    return { id, ...boot, shots };
  } finally {
    await page.close();
  }
}

(async () => {
  let ids = process.argv.slice(2);
  if (ids[0] === '--known') {
    const ROUNDS = new Function(`${fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8')}; return ROUNDS;`)();
    ids = ROUNDS.filter((r) => r.youtubeId).map((r) => r.youtubeId);
  }
  if (!ids.length) {
    console.error('usage: node vet-clips.js <videoId> [videoId...]   |   --known');
    process.exit(2);
  }

  const browser = await chromium.launch({
    executablePath: resolveChrome(), headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  const results = [];
  for (const id of ids) {
    const r = await vet(browser, id);
    results.push(r);

    const verdictParts = [];
    if (r.error) verdictParts.push(`UNUSABLE: error ${r.error} (${YT_ERRORS[r.error] || 'unknown'})`);
    else if (!r.played) verdictParts.push('UNUSABLE: never played');
    else {
      const hasCaptions = r.activeTrack || (r.trackCount || 0) > 0 || (r.modules || []).includes('captions');
      verdictParts.push(hasCaptions ? 'REJECT: has captions' : 'OK on auto-checks');
      if (r.duration > 90) verdictParts.push(`long (${Math.round(r.duration)}s), check for a studio segment`);
    }

    console.log(`\n${'='.repeat(72)}\n${r.id}  ->  ${verdictParts.join(' | ')}`);
    console.log(`  title    ${r.title ?? '(unavailable)'}`);
    console.log(`  channel  ${r.author ?? '(unavailable)'}`);
    console.log(`  duration ${r.duration ? r.duration.toFixed(1) + 's' : 'n/a'}`);
    console.log(`  captions active=${r.activeTrack ?? 'none'} tracks=${r.trackCount ?? 'n/a'} modules=${JSON.stringify(r.modules)}`);
    if (r.shots.length) console.log(`  shots    ${r.shots.length} in ${SHOT_DIR}`);
  }

  console.log(`\n${'='.repeat(72)}\nSUMMARY`);
  for (const r of results) {
    const hasCaptions = r.activeTrack || (r.trackCount || 0) > 0 || (r.modules || []).includes('captions');
    const state = r.error ? `err${r.error}` : !r.played ? 'no-play' : hasCaptions ? 'CAPTIONS' : 'clean';
    console.log(`  ${r.id.padEnd(14)} ${state.padEnd(10)} ${(r.author || '').slice(0, 24).padEnd(26)} ${(r.title || '').slice(0, 46)}`);
  }
  console.log('\nAuto-checks cannot see burned-in station bugs, chyrons, on-scene cuts or');
  console.log('whether the footage is even dashcam POV. Look at the screenshots.');

  await browser.close();
})();
