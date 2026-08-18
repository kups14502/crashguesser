(function () {
  const MAX_POINTS = 5000;
  const SCALE_KM = 2000; // higher = more forgiving scoring curve
  const EPOCH_UTC = Date.UTC(2026, 7, 16); // CrashGuessr #1
  // Bumped from v1 when the day went from 5 rounds to 3: a stored v1 day holds
  // up to 5 scores, which would put roundIndex past the end of a 3-round day
  // and drop the player straight onto the final card.
  const STORAGE_KEY = 'cg_daily_v2';
  // Rounds served per day. Lower is a shorter sit-down AND stretches the clip
  // pool further, which is the binding constraint: a day of play costs this
  // many clips and clips are slow to source (see the sourcing notes in data.js).
  const ROUNDS_PER_DAY = 3;

  // --- Answer-leak guards (see the block comment above playYoutube) ---
  // How long the black cover stays over the player after playback first starts.
  // YouTube fades its own title/channel overlay in and back out over roughly the
  // first second, so revealing on the PLAYING event alone flashes the title.
  const REVEAL_MIN_MS = 1200;
  // ...and it must also have played this many seconds of real video, so a
  // player that reports PLAYING while still showing a static first frame
  // (title overlay included) doesn't get uncovered early.
  const REVEAL_MIN_PROGRESS = 0.8;
  // Backstop so a clip that never reports progress can't stay covered forever.
  const REVEAL_MAX_MS = 4000;
  // Re-showing the cover on every loop-around would strobe, so once a round is
  // past its first play the cover only needs long enough to avoid a flicker.
  const REVEAL_LOOP_MS = 150;
  // Stop this far short of a clip's natural end. Reaching the end triggers
  // YouTube's end screen (related-video thumbnails and titles, which name
  // cities), and it renders at the same moment ENDED fires, so seeking away
  // in the ENDED handler is already too late.
  const END_GUARD_S = 0.4;
  const TRIM_POLL_MS = 100;
  // Height of the band at the top of the player holding YouTube's video title
  // and channel name, which layoutClip() always crops outside the pane.
  const TITLE_CHROME_PX = 76;

  const dayNumber = Math.floor((Date.now() - EPOCH_UTC) / 86400000) + 1;
  const rounds = pickRounds(ROUNDS, dayNumber, ROUNDS_PER_DAY);

  let progress = loadProgress();
  let roundIndex = progress.points.length;
  let totalScore = progress.points.reduce((a, b) => a + b, 0);
  let guessMarker = null;
  let actualMarker = null;
  let guessLine = null;
  let hasGuessed = false;

  // Declared up here, not next to the playback code below: loadRound() reads
  // ytPlayer and runs during this IIFE, so a `let` further down would leave it
  // in the temporal dead zone and throw on first load.
  let ytPlayer = null;
  let ytApiReady = false;
  let pendingRound = null;
  let stallTimer = null;
  let apiLoadTimer = null;
  let trimTimer = null;
  let revealTimer = null;
  let captionTimer = null;
  // True from the moment a round's video starts loading until its first
  // PLAYING event. YouTube's title/channel overlay only shows on that first
  // transition (not on the seek-and-replay loop below), so only that one
  // needs the full cover time in armReveal().
  let firstPlayPending = false;

  const map = L.map('map', { worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18
  }).addTo(map);

  const els = {
    roundLabel: document.getElementById('roundLabel'),
    scoreLabel: document.getElementById('scoreLabel'),
    ytFrame: document.getElementById('ytFrame'),
    videoWrap: document.getElementById('videoWrap'),
    fileVideo: document.getElementById('fileVideo'),
    textClip: document.getElementById('textClip'),
    clipMeta: document.getElementById('clipMeta'),
    guessBtn: document.getElementById('guessBtn'),
    nextBtn: document.getElementById('nextBtn'),
    videoLoading: document.getElementById('videoLoading'),
    tapPlayBtn: document.getElementById('tapPlayBtn'),
    resultOverlay: document.getElementById('resultOverlay'),
    resultTitle: document.getElementById('resultTitle'),
    resultDistance: document.getElementById('resultDistance'),
    resultPoints: document.getElementById('resultPoints'),
    resultNextBtn: document.getElementById('resultNextBtn'),
    finalOverlay: document.getElementById('finalOverlay'),
    finalTitle: document.getElementById('finalTitle'),
    finalScore: document.getElementById('finalScore'),
    shareGrid: document.getElementById('shareGrid'),
    copyResultBtn: document.getElementById('copyResultBtn'),
    dailyNote: document.getElementById('dailyNote'),
  };

  map.on('click', (e) => {
    if (hasGuessed) return;
    placeGuessMarker(e.latlng);
  });

  els.guessBtn.addEventListener('click', submitGuess);
  els.resultNextBtn.addEventListener('click', () => {
    els.resultOverlay.hidden = true;
    advanceRound();
  });
  els.nextBtn.addEventListener('click', () => {
    els.resultOverlay.hidden = true;
    advanceRound();
  });
  els.copyResultBtn.addEventListener('click', copyShareText);

  if (progress.done) {
    showFinal();
  } else {
    loadRound();
  }

  function loadRound() {
    hasGuessed = false;
    clearMarkers();
    map.setView([20, 0], 2);

    els.roundLabel.textContent = `Round ${roundIndex + 1} / ${rounds.length}`;
    els.scoreLabel.textContent = `Score: ${totalScore}`;
    els.guessBtn.disabled = true;
    els.guessBtn.textContent = 'Place a pin to guess';
    els.guessBtn.hidden = false;
    els.nextBtn.hidden = true;

    const round = rounds[roundIndex];
    els.ytFrame.hidden = true;
    els.fileVideo.hidden = true;
    els.textClip.hidden = true;
    els.videoLoading.hidden = true;
    els.tapPlayBtn.hidden = true;
    els.fileVideo.src = '';
    clearInterval(trimTimer);
    clearInterval(revealTimer);
    clearInterval(captionTimer);
    firstPlayPending = false;
    if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();

    if (round.youtubeId) {
      els.ytFrame.hidden = false;
      layoutClip();
      playYoutube(round);
    } else if (round.file) {
      els.fileVideo.src = round.file;
      els.fileVideo.hidden = false;
    } else {
      els.textClip.textContent = round.text || 'No clip provided for this round.';
      els.textClip.hidden = false;
    }

    els.clipMeta.textContent = 'Where did this happen? Click the map to drop your pin.';
  }

  // --- YouTube playback (via IFrame API, never raw <iframe src>) ---
  // A raw embed shows its own poster/title/"Watch on YouTube" chrome whenever
  // playback stalls (slow connection). Driving it through the API lets us cover
  // that state with our own loading UI and force-retry play instead of leaking
  // YouTube's UI (which is how location clues were leaking through titles/links).
  window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    clearTimeout(apiLoadTimer);
    if (pendingRound) {
      const round = pendingRound;
      pendingRound = null;
      playYoutube(round);
    }
  };

  // index.html loads the iframe API before this file, so the API may already be
  // live by the time we get here and onYouTubeIframeAPIReady would never fire.
  if (typeof YT !== 'undefined' && YT.Player) window.onYouTubeIframeAPIReady();

  // Fit the clip to the pane and apply the round's crop. The pane is a wide,
  // short box (clip on top, map below) and clips vary from 16:9 to vertical
  // Shorts, so contain-fit first, then scale by `zoom` and nudge by `shiftY`
  // so station chyrons/bugs land outside the pane's overflow:hidden box.
  //
  // On top of the per-round crop, the top of the player is ALWAYS pushed out of
  // the pane by at least TITLE_CHROME_PX. That band is where YouTube draws the
  // video title and channel name, and no player parameter suppresses it:
  // modestbranding no longer does anything, and the overlay comes back on every
  // pause and seek, so holding the loading cover over it only helps while a
  // round is starting. Cropping it away is the only guard that holds for the
  // whole round. Found the hard way: a round was rendering "KTLA 5" across the
  // top of a clip whose answer was Los Angeles.
  //
  // The band is a roughly fixed pixel height rather than a share of the frame,
  // so this is computed in pixels. Required height H for a pane height h and
  // shift fraction S comes from  (H - h)/2 - S*H >= TITLE_CHROME_PX.
  // (TITLE_CHROME_PX is declared with the other constants at the top: layoutClip
  // runs during this IIFE, so a const here would be in the temporal dead zone.)
  function layoutClip() {
    const round = rounds[roundIndex];
    if (!round) return;
    const w = els.videoWrap.clientWidth;
    const h = els.videoWrap.clientHeight;
    if (!w || !h) return;

    const aspect = round.aspect || 16 / 9;
    const zoom = round.zoom || 1;
    const shiftY = round.shiftY || 0;

    // A shift of half the frame or more would push the top edge down faster
    // than extra height can outrun, so clamp before dividing.
    const headroom = Math.max(0.5 - shiftY, 0.05);
    const minHeight = (TITLE_CHROME_PX + h / 2) / headroom;
    const height = Math.max(Math.min(h, w / aspect) * zoom, minHeight);
    const width = height * aspect;

    els.ytFrame.style.width = width + 'px';
    els.ytFrame.style.height = height + 'px';
    // Positive shiftY pushes the clip down: it crops more off the bottom, and
    // correspondingly less off the top, which is why it has to be accounted for
    // in minHeight above rather than applied blindly.
    const shift = shiftY * height;
    els.ytFrame.style.transform = `translate(-50%, calc(-50% + ${shift}px))`;
  }

  let layoutTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(layoutTimer);
    layoutTimer = setTimeout(layoutClip, 100);
  });

  function playYoutube(round) {
    const id = round.youtubeId;
    const start = round.start || 0;
    els.videoLoading.hidden = false;
    els.tapPlayBtn.hidden = true;
    els.tapPlayBtn.textContent = 'Tap to play';
    if (!ytApiReady || typeof YT === 'undefined' || !YT.Player) {
      pendingRound = round;
      // If the YouTube iframe API script itself is blocked or never loads
      // (ad blockers, restrictive networks), onYouTubeIframeAPIReady never
      // fires and we'd otherwise spin forever with no way out.
      clearTimeout(apiLoadTimer);
      apiLoadTimer = setTimeout(() => {
        if (!ytApiReady) showRetry();
      }, 6000);
      return;
    }
    // Arm before construction, not just in onReady: if the player never
    // becomes ready (blocked iframe, dead network) onReady never fires and
    // there'd be no timer left to surface the retry button.
    armStallWatch();
    firstPlayPending = true;
    clearInterval(revealTimer);
    if (!ytPlayer) {
      ytPlayer = new YT.Player('ytPlayerTarget', {
        videoId: id,
        // Deliberately absent: `modestbranding` (deprecated 2023, confirmed
        // no-op, and keeping it implies a coverage it never provided) and
        // `cc_load_policy` (0 matches no value in the player's enum, so it
        // silently means "honor the viewer's preference", the exact case that
        // leaked). `controls: 0` removes only the BOTTOM chrome; the title bar
        // is not affected by it. See layoutClip() for what actually hides it.
        playerVars: {
          autoplay: 1, mute: 1, controls: 0, rel: 0,
          iv_load_policy: 3, disablekb: 1, fs: 0, playsinline: 1,
          start: start,
        },
        events: {
          onReady: (e) => {
            e.target.mute();
            e.target.playVideo();
            armStallWatch();
          },
          // Not onReady: unloadModule silently does nothing when the captions
          // module has not loaded yet, and it has not at onReady. onApiChange
          // is the event that signals the module exists.
          onApiChange: () => { killCaptions(); armCaptionWatch(); },
          onStateChange: onYtStateChange,
          onError: onYtError,
        },
      });
    } else {
      ytPlayer.loadVideoById({ videoId: id, startSeconds: start });
      ytPlayer.mute();
      // Loading a new video re-evaluates the caption preference and reloads the
      // module, so a previous unload does not carry over.
      killCaptions();
      armCaptionWatch();
      armStallWatch();
    }
    armTrimWatch(round);
  }

  // Captions are an answer leak: a news clip's subtitles transcribe the anchor
  // naming the city.
  //
  // Read the limits here before trusting this. Measured over repeated trials
  // (.test/probe-captions.js), NO combination of player calls reliably keeps
  // captions off for a viewer whose YouTube account asks for them: whether a
  // track ends up selected is a race between this code and the player's own
  // caption loading, and it is one we lose more often than we win. There is
  // also no caption event forwarded to the parent page to hook, only a poll.
  //
  // So this is damage reduction, not a guarantee, and it is why the crop in
  // layoutClip() and the sourcing rule in data.js both matter: a clip that
  // publishes no caption track cannot leak this way at all.
  //
  // Only 'captions' is a real module name ('cc' was the Flash-era player and
  // silently does nothing).
  function killCaptions() {
    if (!ytPlayer) return;
    try { ytPlayer.unloadModule('captions'); } catch (e) { /* not loaded yet */ }
    try { ytPlayer.setOption('captions', 'track', {}); } catch (e) { /* ditto */ }
  }

  // The only feedback loop available: poll the active track and re-kill when
  // one appears. Covers the module reloading mid-round, which it does on the
  // seek-back loop.
  function armCaptionWatch() {
    clearInterval(captionTimer);
    captionTimer = setInterval(() => {
      if (!ytPlayer || !ytPlayer.getOption) return;
      let track = null;
      try { track = ytPlayer.getOption('captions', 'track'); } catch (e) { return; }
      if (track && Object.keys(track).length) killCaptions();
    }, 400);
  }

  // Hold the black cover over the player until YouTube's own title/channel
  // overlay has finished fading out underneath it. Gated on elapsed time AND
  // real playback progress, because PLAYING can fire while the player is still
  // showing a static frame with the title on it.
  function armReveal(firstPlay) {
    clearInterval(revealTimer);
    const minMs = firstPlay ? REVEAL_MIN_MS : REVEAL_LOOP_MS;
    const minProgress = firstPlay ? REVEAL_MIN_PROGRESS : 0;
    const startedAt = Date.now();
    const from = (rounds[roundIndex] || {}).start || 0;
    const reveal = () => {
      clearInterval(revealTimer);
      els.videoLoading.hidden = true;
      els.tapPlayBtn.hidden = true;
    };
    revealTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= REVEAL_MAX_MS) return reveal();
      if (elapsed < minMs) return;
      const t = ytPlayer && ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0;
      if (typeof t === 'number' && t - from >= minProgress) reveal();
    }, 100);
  }

  // The `end` playerVar only applies to the initially cued video, so it can't
  // survive the seek-back loop below. Poll instead: one timer per round that
  // rewinds to `start` as soon as playback reaches the cutoff.
  //
  // Armed for EVERY round, not just ones with an explicit `end`. A round
  // without `end` used to play to its natural finish and rely on the ENDED
  // handler to seek back, but YouTube paints its end screen (related-video
  // thumbnails and titles) as ENDED fires, so that always flashed a set of
  // city names. Falling back to duration - END_GUARD_S means playback simply
  // never gets there.
  //
  // Polling at 100ms rather than the 250ms this used to use: some rounds' `end`
  // sits only a few hundred ms before footage that leaks the answer (a news
  // chyron or an on-scene cut), and a slower poll can overshoot the cutoff and
  // show a frame or two of it before seeking back.
  function armTrimWatch(round) {
    clearInterval(trimTimer);
    trimTimer = setInterval(() => {
      if (!ytPlayer || !ytPlayer.getCurrentTime) return;
      const t = ytPlayer.getCurrentTime();
      if (typeof t !== 'number') return;
      let cutoff = round.end;
      if (!cutoff) {
        // getDuration() reports 0 until metadata arrives, so resolve it here
        // rather than at arm time.
        const duration = ytPlayer.getDuration ? ytPlayer.getDuration() : 0;
        if (!duration) return;
        cutoff = duration - END_GUARD_S;
      }
      if (t >= cutoff) ytPlayer.seekTo(round.start || 0, true);
    }, TRIM_POLL_MS);
  }

  function armStallWatch() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(showRetry, 4000);
  }

  function showRetry() {
    els.videoLoading.hidden = false;
    els.tapPlayBtn.hidden = false;
  }

  function onYtStateChange(e) {
    if (typeof YT === 'undefined') return;
    if (e.data === YT.PlayerState.PLAYING) {
      clearTimeout(stallTimer);
      const firstPlay = firstPlayPending;
      firstPlayPending = false;
      if (firstPlay) killCaptions();
      armReveal(firstPlay);
    } else if (e.data === YT.PlayerState.ENDED) {
      // The trim watch is meant to make this unreachable; if it does fire,
      // YouTube's end screen is already on screen, so cover before seeking.
      clearInterval(revealTimer);
      els.videoLoading.hidden = false;
      const round = rounds[roundIndex] || {};
      e.target.seekTo(round.start || 0, true);
      e.target.playVideo();
    } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.BUFFERING) {
      // Re-arm: buffering that never resolves must still reach the retry state.
      clearInterval(revealTimer);
      els.videoLoading.hidden = false;
      armStallWatch();
    }
  }

  function onYtError() {
    clearTimeout(stallTimer);
    els.tapPlayBtn.textContent = 'Retry';
    showRetry();
  }

  els.tapPlayBtn.addEventListener('click', () => {
    if (ytPlayer && ytApiReady) {
      ytPlayer.mute();
      ytPlayer.playVideo();
      armStallWatch();
    } else {
      playYoutube(rounds[roundIndex]);
    }
  });

  function placeGuessMarker(latlng) {
    if (guessMarker) {
      guessMarker.setLatLng(latlng);
    } else {
      guessMarker = L.marker(latlng, { title: 'Your guess' }).addTo(map);
    }
    els.guessBtn.disabled = false;
    els.guessBtn.textContent = 'Submit guess';
  }

  function submitGuess() {
    if (hasGuessed || !guessMarker) return;
    hasGuessed = true;

    const round = rounds[roundIndex];
    const guessLatLng = guessMarker.getLatLng();
    const distanceKm = haversineKm(guessLatLng.lat, guessLatLng.lng, round.lat, round.lng);
    const points = Math.round(MAX_POINTS * Math.exp(-distanceKm / SCALE_KM));
    totalScore += points;
    progress.points.push(points);
    saveProgress();

    actualMarker = L.marker([round.lat, round.lng], {
      title: 'Actual location',
      icon: L.icon({
        iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
        shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
        iconSize: [25, 41], iconAnchor: [12, 41]
      })
    }).addTo(map);

    guessLine = L.polyline([guessLatLng, [round.lat, round.lng]], { color: '#ff5c5c', dashArray: '6 6' }).addTo(map);
    map.fitBounds(guessLine.getBounds(), { padding: [60, 60] });

    els.scoreLabel.textContent = `Score: ${totalScore}`;
    els.resultTitle.textContent = round.answer || 'Location revealed';
    els.resultDistance.textContent = `Distance: ${distanceKm.toFixed(1)} km`;
    els.resultPoints.textContent = `+${points} points`;
    els.guessBtn.hidden = true;
    els.nextBtn.hidden = false;
    els.resultOverlay.hidden = false;
  }

  function advanceRound() {
    roundIndex++;
    if (roundIndex >= rounds.length) {
      showFinal();
    } else {
      loadRound();
    }
  }

  function showFinal() {
    progress.done = true;
    saveProgress();

    els.finalTitle.textContent = `CrashGuessr #${dayNumber}`;
    els.finalScore.textContent = `${totalScore} / ${rounds.length * MAX_POINTS}`;
    els.shareGrid.textContent = progress.points.map(pointsToEmoji).join('');
    els.dailyNote.textContent = 'Come back tomorrow for a new CrashGuessr.';
    els.finalOverlay.hidden = false;
  }

  function pointsToEmoji(points) {
    const pct = points / MAX_POINTS;
    if (pct >= 0.9) return '🟩';
    if (pct >= 0.6) return '🟨';
    if (pct >= 0.3) return '🟧';
    return '⬛';
  }

  function buildShareText() {
    return `CrashGuessr #${dayNumber} ${totalScore}/${rounds.length * MAX_POINTS}\n\n${progress.points.map(pointsToEmoji).join('')}`;
  }

  function copyShareText() {
    const text = buildShareText();
    const done = () => {
      els.copyResultBtn.textContent = 'Copied!';
      setTimeout(() => { els.copyResultBtn.textContent = 'Copy Result'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* clipboard unavailable */ }
    document.body.removeChild(ta);
  }

  function loadProgress() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && raw.day === dayNumber) return raw;
    } catch (e) { /* corrupt storage, start fresh */ }
    return { day: dayNumber, points: [], done: false };
  }

  function saveProgress() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  }

  function clearMarkers() {
    if (guessMarker) { map.removeLayer(guessMarker); guessMarker = null; }
    if (actualMarker) { map.removeLayer(actualMarker); actualMarker = null; }
    if (guessLine) { map.removeLayer(guessLine); guessLine = null; }
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function toRad(deg) { return deg * Math.PI / 180; }

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Pick a day's rounds so the pool is CONSUMED rather than permuted.
  //
  // This used to be seededShuffle(ROUNDS, dayNumber), which reshuffled the same
  // clips every day: a player two days running saw the identical set in a new
  // order and scored 5000 a round. Instead, treat the pool as a deck dealt from
  // continuously. Day N takes the next `perDay` cards; when the deck runs out,
  // the next cycle is shuffled with a new seed, so the second pass through the
  // pool is not in the same order as the first.
  //
  // A day whose slice straddles a cycle boundary draws from two different decks
  // and can offer the same clip twice, hence the identity check: the decks hold
  // references into `all`, so `includes` compares the actual round objects.
  function pickRounds(all, day, perDay) {
    const take = Math.min(perDay, all.length);
    const picks = [];
    let idx = (day - 1) * take;
    // Bounded rather than while(true): a permutation of the full pool appears
    // every `all.length` steps, so a fresh clip is always close, but a bad
    // pool (empty, duplicated entries) must not spin forever.
    for (let guard = 0; picks.length < take && guard < all.length * 4; guard++) {
      const deck = seededShuffle(all.slice(), Math.floor(idx / all.length) + 1);
      const candidate = deck[idx % all.length];
      idx++;
      if (!picks.includes(candidate)) picks.push(candidate);
    }
    return picks;
  }

  function seededShuffle(arr, seed) {
    const rand = mulberry32(seed);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
})();
