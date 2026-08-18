// Find candidate clips by scraping real YouTube listings.
//
// Video ids are never written from memory: they are read out of a live search
// or channel page, so an id that appears here provably exists. Vetting is a
// separate step (vet-clips.js) and this deliberately does not do it.
//
// Broadcast channels caption everything they publish, and captions cannot be
// suppressed at playback time, so TV-station uploads are down-ranked here in
// favour of personal dashcam channels and print outlets.
//
// Usage:
//   node find-clips.js search "dash cam crash intersection"
//   node find-clips.js channel @ubertube111
const { chromium } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// A compilation has many incidents in many places, so it can never map to one
// lat/lng no matter how clean the footage is.
const COMPILATION = /\b(compilation|comp\b|top \d+|best of|#\d+|ep(isode)?\.? ?\d+|week \d+|idiots in cars|bad drivers)\b/i;
// Broadcast outlets: near-guaranteed captions, chyrons and a station bug. Every
// caption-bearing clip in data.js came from one (KTLA 5, WRAL, WTVC), and every
// clean one did not, so this is the highest-value filter here.
const BROADCAST = /\b(news|abc|nbc|cbs|fox|tv ?\d+|channel ?\d+|action ?news|eyewitness|newschannel|first ?coast|live ?\d)\b/i;
// US/Canadian station call signs (WRAL, KTLA, WHAS11, CBC): 3-4 caps starting
// W, K, C, with an optional channel number. Case-sensitive on purpose, since
// lowercasing this would swallow ordinary words.
const CALLSIGN = /\b[WKC][A-Z]{2,3}\d{0,2}\b/;
// A location in the title is what makes a round scoreable at all.
const HAS_PLACE = /\b(at|on|in|near)\b .*\b([A-Z][a-z]+(?: [A-Z][a-z]+)*)\b|\b(st|street|ave|avenue|rd|road|blvd|hwy|highway|route|rt|i-\d+|us-\d+|sr-\d+|pkwy|parkway|dr|drive|ln|lane)\b/i;

async function scrape(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // Consent interstitials block the listing in some regions.
  for (const label of ['Accept all', 'Reject all', 'I agree']) {
    const btn = page.locator(`button:has-text("${label}")`).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(1500);
      break;
    }
  }
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.scrollBy(0, 3000));
  await page.waitForTimeout(1500);

  // Pull from ytInitialData rather than the DOM: it carries duration and
  // channel per item, and survives layout changes.
  return page.evaluate(() => {
    const out = new Map();
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(walk);
      const r = node.videoRenderer || node.compactVideoRenderer || node.gridVideoRenderer
             || node.richItemRenderer?.content?.videoRenderer;
      if (r && r.videoId) {
        const text = (t) => t?.simpleText || t?.runs?.map((x) => x.text).join('') || null;
        if (!out.has(r.videoId)) {
          out.set(r.videoId, {
            id: r.videoId,
            title: text(r.title),
            channel: text(r.ownerText) || text(r.longBylineText) || text(r.shortBylineText),
            length: text(r.lengthText),
            views: text(r.shortViewCountText),
          });
        }
      }
      for (const k of Object.keys(node)) walk(node[k]);
    };
    walk(window.ytInitialData || {});
    return [...out.values()];
  });
}

function seconds(len) {
  if (!len) return null;
  const p = len.split(':').map(Number);
  if (p.some(Number.isNaN)) return null;
  return p.reduce((a, b) => a * 60 + b, 0);
}

(async () => {
  const [mode, ...rest] = process.argv.slice(2);
  const arg = rest.join(' ');
  if (!mode || !arg) {
    console.error('usage: node find-clips.js search "<query>"  |  channel <@handle>');
    process.exit(2);
  }
  const url = mode === 'channel'
    ? `https://www.youtube.com/${arg.startsWith('@') ? arg : '@' + arg}/videos`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(arg)}&sp=EgIQAQ%253D%253D`;

  const browser = await chromium.launch({
    executablePath: resolveChrome(), headless: true, args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  let items = [];
  try {
    items = await scrape(page, url);
  } catch (e) {
    console.error(`scrape failed: ${e.message.split('\n')[0]}`);
  }

  const scored = items.map((v) => {
    const secs = seconds(v.length);
    const reasons = [];
    if (COMPILATION.test(v.title || '')) reasons.push('compilation');
    if (BROADCAST.test(v.channel || '') || CALLSIGN.test(v.channel || '')) reasons.push('broadcast-channel');
    if (secs !== null && secs > 180) reasons.push(`long(${v.length})`);
    if (!HAS_PLACE.test(v.title || '')) reasons.push('no-place-in-title');
    return { ...v, secs, reasons };
  });

  const good = scored.filter((v) => !v.reasons.length);
  const rest2 = scored.filter((v) => v.reasons.length);

  console.log(`${url}\nfound ${items.length} items\n`);
  console.log(`--- ${good.length} PROMISING (no disqualifier from title/channel alone) ---`);
  for (const v of good) {
    console.log(`  ${v.id}  ${(v.length || '?').padStart(6)}  ${(v.channel || '').slice(0, 22).padEnd(24)} ${v.title}`);
  }
  console.log(`\n--- ${rest2.length} filtered out ---`);
  for (const v of rest2.slice(0, 25)) {
    console.log(`  ${v.id}  ${(v.length || '?').padStart(6)}  ${(v.channel || '').slice(0, 22).padEnd(24)} ${(v.title || '').slice(0, 60)}`);
    console.log(`  ${' '.repeat(13)}^ ${v.reasons.join(', ')}`);
  }
  if (good.length) {
    console.log(`\nNext: node vet-clips.js ${good.slice(0, 8).map((v) => v.id).join(' ')}`);
  }

  await browser.close();
})();
