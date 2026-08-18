// Probe: can captions be suppressed through the IFrame API at all?
//
// The e2e suite caught the captions module active on the news-sourced clips.
// Single-shot probing gave contradictory answers on consecutive runs, because
// whether a caption track ends up selected is a RACE: the captions module
// loads and picks a track asynchronously, so a one-shot kill can land before
// there is anything to kill and then be silently undone.
//
// So this measures instead of sampling: N independent trials per strategy, and
// a trial counts as LEAKED if a caption track was active at ANY sample point
// (a subtitle that shows for one second has already given the answer away).
//
// cc_load_policy=1 stands in for a viewer whose own YouTube account has
// "always show captions" on. That is the case that actually leaked in the
// field and it cannot be reproduced with a cookieless browser at the default.
//
// Usage: node probe-captions.js [videoId] [trials]
const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VIDEO = process.argv[2] || '0-t-LOCVNeU';
const TRIALS = Number(process.argv[3] || 5);
const CONCURRENCY = 4;
const ORIGIN = 'https://dashguesser.brendonkupsch.com';

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

// `apply` is stringified into the page, so each must be self-contained.
const STRATEGIES = {
  none: '() => {}',
  killOnce: `(p) => {
    try { p.setOption('captions', 'track', {}); } catch (e) {}
    try { p.unloadModule('captions'); } catch (e) {}
  }`,
  killRepeat400: `(p) => {
    const kill = () => {
      try { p.setOption('captions', 'track', {}); } catch (e) {}
      try { p.unloadModule('captions'); } catch (e) {}
    };
    kill(); setInterval(kill, 400);
  }`,
  killRepeat150: `(p) => {
    const kill = () => {
      try { p.setOption('captions', 'track', {}); } catch (e) {}
      try { p.unloadModule('captions'); } catch (e) {}
    };
    kill(); setInterval(kill, 150);
  }`,
};

async function trial(browser, applySrc, ccPolicy) {
  const page = await browser.newPage();
  try {
    await page.route(`${ORIGIN}/**`, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="t"></div>'
          + '<script src="https://www.youtube.com/iframe_api"></script></body></html>',
    }));
    await page.goto(`${ORIGIN}/probe.html`, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(async ({ videoId, applySrc, ccPolicy }) => {
      const applyFn = eval(applySrc);
      const seen = [];
      let tracklist = null;
      await new Promise((resolve) => {
        const boot = () => {
          const p = new YT.Player('t', {
            videoId,
            width: 640, height: 360,
            playerVars: {
              autoplay: 1, mute: 1, controls: 0, rel: 0, playsinline: 1,
              cc_load_policy: ccPolicy,
            },
            events: {
              onReady: (e) => { e.target.mute(); e.target.playVideo(); applyFn(e.target); },
              onStateChange: (e) => { if (e.data === 1) applyFn(e.target); },
            },
          });
          const snap = () => {
            let track = null;
            try { track = p.getOption('captions', 'track'); } catch (e) { track = null; }
            try { tracklist = p.getOption('captions', 'tracklist') || tracklist; } catch (e) { /* none */ }
            seen.push(track && Object.keys(track).length ? (track.languageCode || 'on') : null);
          };
          for (let ms = 1500; ms <= 6000; ms += 750) setTimeout(snap, ms);
          setTimeout(resolve, 6500);
        };
        if (window.YT && window.YT.Player) boot();
        else window.onYouTubeIframeAPIReady = boot;
      });
      return { leaked: seen.some(Boolean), samples: seen, tracks: (tracklist || []).length };
    }, { videoId: VIDEO, applySrc, ccPolicy });
  } finally {
    await page.close();
  }
}

async function pool(tasks, limit) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      out[idx] = await tasks[idx]();
    }
  }));
  return out;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: resolveChrome(),
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  console.log(`video: ${VIDEO}   trials per cell: ${TRIALS}`);
  console.log('A trial LEAKS if a caption track was active at any sample point.\n');
  console.log('strategy'.padEnd(16) + 'cc_load_policy=0'.padEnd(22) + 'cc_load_policy=1');
  console.log('-'.repeat(64));

  let trackCount = null;
  for (const [name, applySrc] of Object.entries(STRATEGIES)) {
    const cells = [];
    for (const policy of [0, 1]) {
      const results = await pool(
        Array.from({ length: TRIALS }, () => () => trial(browser, applySrc, policy)),
        CONCURRENCY,
      );
      const leaked = results.filter((r) => r.leaked).length;
      if (trackCount === null && results[0]) trackCount = results[0].tracks;
      cells.push(`${leaked}/${TRIALS} leaked`);
    }
    console.log(name.padEnd(16) + cells[0].padEnd(22) + cells[1]);
  }

  console.log(`\ncaption tracks published on this video: ${trackCount}`);
  await browser.close();
})();
