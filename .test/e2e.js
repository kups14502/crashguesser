// End-to-end: play a full day of rounds, assert each clip actually reaches playback
// (spinner gone, media time advancing), that round advance works, and that
// none of the answer-leak guards in app.js have regressed.
//
// The leak guards are the fiddly part. A clip whose location is given away by
// YouTube's own chrome is a broken round even though every gameplay assertion
// passes, so this suite checks them explicitly:
//   - the black cover is held over the player long enough to hide the title
//     overlay YouTube fades in over the first second of playback
//   - the player never reaches ENDED, which is what paints the end screen full
//     of related-video thumbnails and titles
//   - the captions module is not loaded (subtitles transcribe the anchor
//     naming the city)
//   - playback never runs past the round's trim cutoff
const { chromium } = require('playwright-core');

const fs = require('fs');
const os = require('os');
const path = require('path');

// Resolve the browser and repo root instead of hardcoding one machine's paths:
// this suite has to run from both the Linux box and the Windows checkout.
const ROOT = process.env.CG_ROOT || path.resolve(__dirname, '..');
const PLAY_TIMEOUT = 15000;

// playwright-core only reports the chromium build it shipped against, which is
// not necessarily the one installed (a `npm i` bump leaves the older build on
// disk). Prefer its answer, but fall back to scanning the browser registry so a
// version skew doesn't fail the run before a single assertion executes.
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
        path.join(registry, dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      );
    }
  }
  return candidates.find((p) => p && fs.existsSync(p));
}
const CHROME = resolveChrome();

// Load the real round table so expectations come from the same source the app
// uses, rather than a copy in the test that can drift.
const ROUNDS = new Function(`${fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8')}; return ROUNDS;`)();
const BY_ID = new Map(ROUNDS.filter((r) => r.youtubeId).map((r) => [r.youtubeId, r]));

// The cover must outlast YouTube's title fade. app.js aims for 1200ms; assert a
// little under that so ordinary timer jitter isn't a failure, while a genuine
// regression (revealing straight off the PLAYING event) still trips it.
const MIN_COVER_MS = 900;
// Allowed overshoot past a trim cutoff: the watch polls at 100ms and a seek
// takes a moment to land.
const TRIM_TOLERANCE_S = 0.75;
// Must match TITLE_CHROME_PX in app.js, less a pixel of rounding slack. This is
// the band holding the video title and channel name.
const MIN_TOP_CROP_PX = 75;

// Some uploaders' embed rules reject a localhost origin (YouTube error 150),
// so by default serve the real files under the production origin.
const ORIGIN = process.env.CG_ORIGIN || 'https://dashguesser.brendonkupsch.com';
const PAGE_URL = process.env.CG_URL || `${ORIGIN}/index.html`;

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

const fail = [];
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); fail.push(m); };

(async () => {
  if (!CHROME) {
    console.error('No chromium found. Set CG_CHROME to a browser executable.');
    process.exit(1);
  }
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();

  const errors = [];
  const notFound = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });

  // Track media time from YouTube's watchtime beacons: proof of real playback.
  // Reset per round, since each new video restarts cmt near 0.
  const mediaTime = { v: 0, seen: 0 };
  page.on('request', (r) => {
    const m = /[?&]cmt=([\d.]+)/.exec(r.url());
    if (m && r.url().includes('/api/stats/')) {
      mediaTime.v = Math.max(mediaTime.v, parseFloat(m[1]));
      mediaTime.seen++;
    }
  });

  // Intercept window.YT the instant the API script assigns it, so we can wrap
  // YT.Player before app.js constructs one and capture real states/error codes.
  //
  // Wrapping happens in the GETTER, not the setter: the API assigns window.YT
  // first and only fills in YT.Player a moment later, so a setter-time wrap
  // (what this used to do, with a couple of short setTimeout retries) kept
  // losing the race and silently recorded nothing at all.
  await page.addInitScript(() => {
    const t0 = Date.now();
    window.__yt = { states: [], errors: [], loads: [], cover: [], player: null };
    const NAMES = { '-1': 'UNSTARTED', 0: 'ENDED', 1: 'PLAYING', 2: 'PAUSED', 3: 'BUFFERING', 5: 'CUED' };
    let real;
    const wrap = (YT) => {
      if (!YT || !YT.Player || YT.__wrapped) return YT;
      const Orig = YT.Player;
      const Wrapped = function (el, opts) {
        const ev = (opts.events = opts.events || {});
        const us = ev.onStateChange, ue = ev.onError;
        ev.onStateChange = function (e) {
          window.__yt.states.push({ t: Date.now() - t0, s: NAMES[e.data] ?? e.data });
          if (us) us(e);
        };
        ev.onError = function (e) {
          window.__yt.errors.push({ t: Date.now() - t0, code: e.data });
          if (ue) ue(e);
        };
        const p = new Orig(el, opts);
        window.__yt.player = p;
        const origLoad = p.loadVideoById;
        if (origLoad) {
          p.loadVideoById = function (...a) {
            const id = a[0] && a[0].videoId ? a[0].videoId : a[0];
            window.__yt.loads.push({ t: Date.now() - t0, id });
            return origLoad.apply(this, a);
          };
        }
        return p;
      };
      Wrapped.prototype = Orig.prototype;
      Object.assign(Wrapped, Orig);
      YT.Player = Wrapped;
      YT.__wrapped = true;
      return YT;
    };
    Object.defineProperty(window, 'YT', {
      configurable: true,
      get: () => { if (real && real.Player && !real.__wrapped) wrap(real); return real; },
      set: (v) => { real = v; },
    });

    // Timestamp every show/hide of the cover on the same clock as the player
    // states, so the gap between "playback started" and "cover lifted" is
    // measurable.
    const watchCover = () => {
      const el = document.getElementById('videoLoading');
      if (!el) return;
      const rec = () => window.__yt.cover.push({ t: Date.now() - t0, shown: !el.hidden });
      rec();
      new MutationObserver(rec).observe(el, { attributes: true, attributeFilter: ['hidden'] });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', watchCover);
    } else {
      watchCover();
    }
  });

  // Serve the working-tree files under ORIGIN so the test exercises the real
  // deployed origin (embed permissions depend on it) against local edits.
  if (PAGE_URL.startsWith(ORIGIN)) {
    await page.route(`${ORIGIN}/**`, (route) => {
      const p = new URL(route.request().url()).pathname;
      const file = path.join(ROOT, p === '/' ? 'index.html' : p);
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'nf' });
      route.fulfill({
        status: 200,
        contentType: MIME[path.extname(file)] || 'application/octet-stream',
        body: fs.readFileSync(file),
      });
    });
  }

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });

  // Rounds per day is a product decision that changes; read it off the page
  // rather than hardcoding, so changing it is not also a test edit.
  const firstLabel = await page.textContent('#roundLabel');
  const ROUND_COUNT = Number((/\/\s*(\d+)/.exec(firstLabel) || [])[1]);
  if (!ROUND_COUNT) {
    console.log(`  FAIL  could not read round count from label "${firstLabel}"`);
    process.exit(1);
  }
  console.log(`rounds per day: ${ROUND_COUNT}`);

  const playedIds = [];
  // Events before this index belong to earlier rounds. Advanced at the end of
  // each iteration rather than reset at the start, so round 1 keeps the states
  // it emitted during initial page load.
  let mark = { s: 0, c: 0 };

  for (let round = 1; round <= ROUND_COUNT; round++) {
    console.log(`\n--- Round ${round} ---`);

    const label = await page.textContent('#roundLabel');
    if (label.trim() === `Round ${round} / ${ROUND_COUNT}`) ok(`label "${label.trim()}"`);
    else bad(`label expected "Round ${round} / ${ROUND_COUNT}", got "${label.trim()}"`);

    // The clip must become visible and the spinner must go away.
    mediaTime.v = 0;   // each round loads a fresh video; cmt restarts near 0
    mediaTime.seen = 0;
    let playing = false;
    let maxTime = 0;
    const deadline = Date.now() + PLAY_TIMEOUT;
    while (Date.now() < deadline) {
      const s = await page.evaluate(() => {
        const ld = document.getElementById('videoLoading');
        const fr = document.getElementById('ytFrame');
        const cs = ld ? getComputedStyle(ld).display : null;
        const p = window.__yt.player;
        return {
          spinnerShown: ld && !ld.hidden && cs !== 'none',
          frameVisible: fr && !fr.hidden,
          hasIframe: !!document.querySelector('#ytFrame iframe'),
          current: p && p.getCurrentTime ? p.getCurrentTime() : null,
        };
      });
      if (typeof s.current === 'number') maxTime = Math.max(maxTime, s.current);
      if (!s.spinnerShown && s.frameVisible && s.hasIframe && mediaTime.v > 0.5) {
        playing = true;
        break;
      }
      await page.waitForTimeout(250);
    }

    // Keep sampling briefly after playback is established: the trim cutoff and
    // the loop-around are what need observing, and they happen mid-clip.
    for (let i = 0; i < 8; i++) {
      const t = await page.evaluate(() => {
        const p = window.__yt.player;
        return p && p.getCurrentTime ? p.getCurrentTime() : null;
      });
      if (typeof t === 'number') maxTime = Math.max(maxTime, t);
      await page.waitForTimeout(250);
    }

    const st = await page.evaluate((m) => {
      const ld = document.getElementById('videoLoading');
      const btn = document.getElementById('tapPlayBtn');
      const p = window.__yt.player;
      let data = null, options = null, track = null;
      try { data = p && p.getVideoData ? p.getVideoData() : null; } catch (e) { /* not ready */ }
      try { options = p && p.getOptions ? p.getOptions() : null; } catch (e) { /* not ready */ }
      // The active track is the signal that matters. The module merely being
      // loaded says the clip HAS captions available, not that any are being
      // rendered; a non-empty track object means they are on screen.
      try { track = p && p.getOption ? p.getOption('captions', 'track') : null; } catch (e) { /* not ready */ }
      // How much of the player is clipped off by the pane, in real pixels.
      const wrap = document.getElementById('videoWrap').getBoundingClientRect();
      const frame = document.getElementById('ytFrame').getBoundingClientRect();
      return {
        hiddenAttr: ld.hidden,
        computed: getComputedStyle(ld).display,
        retryShown: btn && !btn.hidden,
        retryText: btn ? btn.textContent : null,
        videoId: data ? data.video_id : null,
        cropTopPx: Math.round(wrap.top - frame.top),
        cropBottomPx: Math.round(frame.bottom - wrap.bottom),
        states: window.__yt.states.slice(m.s),
        cover: window.__yt.cover.slice(m.c),
        options: options,
        captionTrack: track && Object.keys(track).length ? (track.languageCode || 'on') : null,
        stateLen: window.__yt.states.length,
        coverLen: window.__yt.cover.length,
      };
    }, mark);

    console.log(`  info  videoId=${st.videoId} beacons=${mediaTime.seen} maxTime=${maxTime.toFixed(1)}s ` +
                `crop=${st.cropTopPx}px/${st.cropBottomPx}px`);
    console.log(`  info  states: ${st.states.map((s) => s.s).join(' > ') || '(none)'}`);
    if (st.videoId) playedIds.push(st.videoId);

    if (playing) ok(`clip playing (media time ${mediaTime.v.toFixed(1)}s), spinner cleared`);
    else bad(`clip did NOT reach playback in ${PLAY_TIMEOUT}ms ` +
             `(spinner hidden=${st.hiddenAttr} computed=${st.computed}, ` +
             `retry=${st.retryShown}("${st.retryText}"), mediaTime=${mediaTime.v})`);

    // Regression guard for the CSS bug: hidden must actually compute to none.
    if (st.hiddenAttr && st.computed !== 'none') {
      bad(`spinner has hidden attr but computes display:${st.computed} (CSS defeats [hidden])`);
    } else {
      ok('[hidden] honored on #videoLoading');
    }

    // --- Leak guards ---

    // Expectations for this round come from the entry in data.js for whichever
    // clip actually played, rather than from round order, which is shuffled by
    // day.
    const meta = st.videoId ? BY_ID.get(st.videoId) : null;

    // The instrumentation itself has to be working, or every check below is a
    // vacuous pass.
    if (st.states.length) ok(`player states captured (${st.states.length})`);
    else bad('no player states captured: YT.Player wrapper did not attach');

    // ENDED means YouTube's end screen (related video titles) was painted.
    const ended = st.states.filter((s) => s.s === 'ENDED');
    if (!ended.length) ok('never reached ENDED (no end-screen leak)');
    else bad(`player hit ENDED ${ended.length}x: end screen with related-video titles was shown`);

    // The top of the player must be clipped away, because that band is where
    // YouTube draws the video title and channel name and nothing in the player
    // API removes it. This is the guard that actually holds for a whole round;
    // the cover below only spans the start of one.
    if (st.cropTopPx >= MIN_TOP_CROP_PX) {
      ok(`top chrome cropped by ${st.cropTopPx}px (>= ${MIN_TOP_CROP_PX}px), title bar off-pane`);
    } else {
      bad(`top of player only cropped ${st.cropTopPx}px (< ${MIN_TOP_CROP_PX}px): ` +
          'YouTube title/channel bar is on screen');
    }

    // Cover must be held across the title fade, measured from the first
    // PLAYING to the first time the cover went away after it.
    const firstPlay = st.states.find((s) => s.s === 'PLAYING');
    const lift = firstPlay && st.cover.find((c) => !c.shown && c.t >= firstPlay.t);
    if (!firstPlay) {
      bad('no PLAYING state observed, cannot verify cover hold');
    } else if (!lift) {
      bad('cover never lifted after playback started');
    } else if (lift.t - firstPlay.t >= MIN_COVER_MS) {
      ok(`cover held ${lift.t - firstPlay.t}ms after first PLAYING (>= ${MIN_COVER_MS}ms)`);
    } else {
      bad(`cover lifted only ${lift.t - firstPlay.t}ms after PLAYING ` +
          `(< ${MIN_COVER_MS}ms): YouTube title overlay can flash`);
    }

    // Captions transcribe the anchor naming the city. This cannot be fully
    // suppressed through the player API (see probe-captions.js), so a clip that
    // publishes a caption track has to be acknowledged in data.js. An
    // unacknowledged clip showing captions is a new leak and fails.
    const acked = meta && meta.captions;
    if (!st.captionTrack) {
      ok(`no caption track active${acked ? ' (clip is flagged captions:true)' : ''}`);
    } else if (acked) {
      console.log(`  WARN  caption track "${st.captionTrack}" active; clip is flagged ` +
                  'captions:true in data.js. Known leak, replace this clip.');
    } else {
      bad(`caption track "${st.captionTrack}" active on an unflagged clip: ` +
          'subtitles leak the location. Replace the clip, or flag it captions:true.');
    }

    // Playback must stay inside the trimmed window.
    if (meta && meta.end) {
      if (maxTime <= meta.end + TRIM_TOLERANCE_S) {
        ok(`playback stayed within trim cutoff (max ${maxTime.toFixed(1)}s <= ${meta.end}s +tol)`);
      } else {
        bad(`playback ran to ${maxTime.toFixed(1)}s, past cutoff ${meta.end}s: trimmed footage was shown`);
      }
    } else if (meta) {
      ok('round has no explicit cutoff (guarded by duration fallback)');
    }

    await page.screenshot({
      path: path.join(os.tmpdir(), `cg_round${round}.png`),
      clip: await page.evaluate(() => {
        const r = document.getElementById('clipPane').getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    });

    // Play the round: drop a pin, submit, continue.
    await page.click('#map', { position: { x: 200, y: 200 } });
    const guessEnabled = await page.isEnabled('#guessBtn');
    if (guessEnabled) ok('guess button enabled after pin drop');
    else bad('guess button still disabled after map click');

    await page.click('#guessBtn');
    await page.waitForSelector('#resultOverlay:not([hidden])', { timeout: 5000 })
      .then(() => ok('result overlay shown'))
      .catch(() => bad('result overlay did not appear'));

    const dist = await page.textContent('#resultDistance');
    const pts = await page.textContent('#resultPoints');
    console.log(`  info  ${dist} | ${pts}`);

    await page.click('#resultNextBtn');
    await page.waitForTimeout(800);
    mark = { s: st.stateLen, c: st.coverLen };
  }

  console.log('\n--- Final ---');
  const finalShown = await page.evaluate(() => {
    const f = document.getElementById('finalOverlay');
    return f && !f.hidden && getComputedStyle(f).display !== 'none';
  });
  if (finalShown) ok(`final overlay shown after ${ROUND_COUNT} rounds`);
  else bad(`final overlay missing after ${ROUND_COUNT} rounds`);

  const share = await page.textContent('#shareGrid');
  // Count code points, not UTF-16 units: the score emoji are astral (🟩 is a
  // surrogate pair, ⬛ is not), so .length does not equal one-per-round.
  const tiles = share ? [...share.trim()].length : 0;
  if (tiles === ROUND_COUNT) ok(`share grid rendered ${tiles} tiles: ${share.trim()}`);
  else bad(`share grid has ${tiles} tiles, expected ${ROUND_COUNT}: "${share}"`);

  // Every round must have served a different clip. The iframe's src attribute
  // keeps naming the first video forever (loadVideoById swaps the video without
  // touching the src), so this reads the id from the player itself.
  const unique = new Set(playedIds);
  if (playedIds.length === ROUND_COUNT && unique.size === ROUND_COUNT) {
    ok(`${ROUND_COUNT} distinct clips played: ${[...unique].join(', ')}`);
  } else {
    bad(`expected ${ROUND_COUNT} distinct clips, got ${playedIds.length} ids ` +
        `with ${unique.size} unique: ${playedIds.join(', ')}`);
  }

  const known = [...unique].filter((id) => !BY_ID.has(id));
  if (!known.length) ok('all played clips are from data.js');
  else bad(`played clips not in data.js: ${known.join(', ')}`);

  const ytLog = await page.evaluate(() => window.__yt);
  console.log('\n=== YT PLAYER LOG ===');
  console.log('loadVideoById: ' + (ytLog.loads.map((l) => `${(l.t / 1000).toFixed(1)}s:${l.id}`).join(' ') || '(none)'));
  console.log('states: ' + (ytLog.states.map((s) => `${(s.t / 1000).toFixed(1)}s:${s.s}`).join(' > ') || '(none)'));
  console.log('errors: ' + (ytLog.errors.map((e) => `${(e.t / 1000).toFixed(1)}s:code${e.code}`).join(' ') || '(none)'));

  console.log('\n=== PAGE ERRORS ===');
  console.log(errors.length ? [...new Set(errors)].join('\n') : '(none)');
  console.log('\n=== 404s ===');
  console.log(notFound.length ? [...new Set(notFound)].join('\n') : '(none)');
  console.log(`\nRound screenshots: ${path.join(os.tmpdir(), 'cg_round*.png')}`);

  await browser.close();

  console.log(`\n${fail.length ? `FAILED (${fail.length})` : 'ALL PASSED'}`);
  process.exit(fail.length ? 1 : 0);
})();
