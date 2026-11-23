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
  // The player is never laid out narrower than this, in its own CSS pixels. On
  // a narrower pane (phones) it is laid out at this width and scaled down with a
  // CSS transform. TITLE_CHROME_PX was measured on a player about this wide, and
  // YouTube draws that band at a fixed pixel height, so cropping it from a real
  // 390px-wide player meant blowing the clip up far wider than the screen. That
  // was the "videos cut off on mobile" bug.
  const VIRTUAL_MIN_W = 854;
  // Keep in step with the matching @media blocks in style.css.
  const COMPACT_MQ = '(max-width: 800px), (max-aspect-ratio: 1/1)';
  const SIDE_MQ = '(max-height: 520px) and (min-aspect-ratio: 1/1)';
  // Floor for the clip pane on phones, and the share of the game area the clip
  // may take there (the map keeps the rest).
  const MIN_PANE_PX = 140;
  const COMPACT_CLIP_SHARE = 0.52;
  const SITE_URL = 'https://dashguesser.brendonkupsch.com';

  const dayNumber = Math.floor((Date.now() - EPOCH_UTC) / 86400000) + 1;
  const rounds = pickRounds(ROUNDS, dayNumber, ROUNDS_PER_DAY);

  let progress = loadProgress();
  // A stored day can hold more scores than today's rounds (rounds-per-day
  // lowered, or a pool that shrank): treat it as finished rather than load a
  // round past the end of the list.
  if (progress.points.length >= rounds.length) progress.done = true;
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
  let countdownTimer = null;
  // True from the moment a round's video starts loading until its first
  // PLAYING event. YouTube's title/channel overlay only shows on that first
  // transition (not on the seek-and-replay loop below), so only that one
  // needs the full cover time in armReveal().
  let firstPlayPending = false;

  const compactMq = window.matchMedia(COMPACT_MQ);
  const sideMq = window.matchMedia(SIDE_MQ);
  const isCompact = () => compactMq.matches && !sideMq.matches;
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

  const map = L.map('map', { worldCopyJump: true, minZoom: 1 });
  resetMapView();
  // No {s} subdomains: OSM retired them, the bare host is the supported URL.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxZoom: 18
  }).addTo(map);

  const pin = (kind) => L.divIcon({ className: '', html: `<div class="cg-pin ${kind}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] });

  const els = {
    game: document.getElementById('game'),
    clipPane: document.getElementById('clipPane'),
    roundLabel: document.getElementById('roundLabel'),
    scoreLabel: document.getElementById('scoreLabel'),
    ytFrame: document.getElementById('ytFrame'),
    videoWrap: document.getElementById('videoWrap'),
    fileVideo: document.getElementById('fileVideo'),
    textClip: document.getElementById('textClip'),
    clipMeta: document.getElementById('clipMeta'),
    guessBtn: document.getElementById('guessBtn'),
    controls: document.getElementById('controls'),
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
    finalRounds: document.getElementById('finalRounds'),
    shareBtn: document.getElementById('shareBtn'),
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
  els.copyResultBtn.addEventListener('click', copyShareText);
  if (navigator.share && coarsePointer) {
    els.shareBtn.hidden = false;
    els.copyResultBtn.classList.add('secondary');
    els.shareBtn.addEventListener('click', () => {
      navigator.share({ text: buildShareText() }).catch(() => { /* dismissed */ });
    });
  }

  // Enter submits a placed pin, then moves on from the result.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.closest('button, a, input, textarea')) return;
    if (!els.resultOverlay.hidden) { els.resultNextBtn.click(); e.preventDefault(); }
    else if (!hasGuessed && !els.guessBtn.disabled && els.finalOverlay.hidden) { submitGuess(); e.preventDefault(); }
  });

  if (!rounds.length) {
    els.textClip.textContent = 'No rounds today. Check back soon.';
    els.textClip.hidden = false;
    els.guessBtn.hidden = true;
  } else if (progress.done) {
    showFinal();
  } else {
    loadRound();
  }

  function resetMapView() {
    // A narrow map at zoom 2 shows a sliver of the world; zoom 1 fits a phone.
    const w = document.getElementById('map').clientWidth;
    map.setView([20, 0], w && w < 600 ? 1 : 2);
  }

  function loadRound() {
    hasGuessed = false;
    clearMarkers();
    resetMapView();

    els.roundLabel.textContent = `Round ${roundIndex + 1} / ${rounds.length}`;
    els.scoreLabel.textContent = `Score: ${totalScore}`;
    els.guessBtn.disabled = true;
    els.guessBtn.textContent = coarsePointer ? 'Tap the map to place a pin' : 'Place a pin to guess';
    els.guessBtn.hidden = false;
    els.controls.hidden = false;
    els.resultOverlay.hidden = true;

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
      layoutClip();
      els.fileVideo.src = round.file;
      els.fileVideo.hidden = false;
    } else {
      layoutClip();
      els.textClip.textContent = round.text || 'No clip provided for this round.';
      els.textClip.hidden = false;
    }

    els.clipMeta.textContent = coarsePointer
      ? 'Where did this happen? Tap the map to drop your pin.'
      : 'Where did this happen? Click the map to drop your pin.';
  }

  // Stop everything a round left running (the final card sits over a player
  // that would otherwise keep looping and polling underneath it).
  function stopPlayback() {
    clearInterval(trimTimer);
    clearInterval(revealTimer);
    clearInterval(captionTimer);
    clearTimeout(stallTimer);
    clearTimeout(apiLoadTimer);
    pendingRound = null;
    try { if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo(); } catch (e) { /* player gone */ }
    els.fileVideo.pause();
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
  //
  // All of that maths runs in the player's own pixels ("virtual" below): the
  // pane is scaled up by k so it is at least VIRTUAL_MIN_W wide, the frame is
  // laid out against that, and a CSS scale(1/k) brings it back to the screen.
  // On desktop k is 1 and nothing changes.
  //
  // The pane's height is also capped here, at the tallest pane the clip can
  // fill edge to edge once the title band is cropped. Any taller and the crop
  // floor forces the frame wider than the pane, cutting the sides off.
  function layoutClip() {
    const round = rounds[roundIndex];
    if (!round) return;
    const wrap = els.videoWrap;
    if (!round.youtubeId) {
      wrap.style.height = '';
      wrap.style.flex = '';
      return;
    }
    const w = wrap.clientWidth;
    if (!w) return;

    const aspect = round.aspect || 16 / 9;
    const zoom = round.zoom || 1;
    const shiftY = round.shiftY || 0;
    const k = Math.max(1, VIRTUAL_MIN_W / w);
    const vw = w * k;

    // A shift of half the frame or more would push the top edge down faster
    // than extra height can outrun, so clamp before dividing.
    const headroom = Math.max(0.5 - shiftY, 0.05);

    // Pane height: what is free, capped where the crop floor below would make
    // the frame exactly as wide as the pane.
    const ideal = 2 * (headroom * vw / aspect - TITLE_CHROME_PX) / k;
    const avail = availablePaneHeight();
    const h = Math.round(Math.max(Math.min(avail, ideal), Math.min(avail, MIN_PANE_PX)));
    if (!h) return;
    if (Math.abs(wrap.clientHeight - h) > 1 || !wrap.style.height) {
      wrap.style.height = h + 'px';
      wrap.style.flex = '0 0 auto';
    }

    const hv = h * k;
    const minHeight = (TITLE_CHROME_PX + hv / 2) / headroom;
    const height = Math.max(Math.min(hv, vw / aspect) * zoom, minHeight);
    const width = height * aspect;

    els.ytFrame.style.width = width + 'px';
    els.ytFrame.style.height = height + 'px';
    // Positive shiftY pushes the clip down: it crops more off the bottom, and
    // correspondingly less off the top, which is why it has to be accounted for
    // in minHeight above rather than applied blindly.
    const shift = shiftY * height / k;
    els.ytFrame.style.transform = k === 1
      ? `translate(-50%, calc(-50% + ${shift}px))`
      : `translate(-50%, calc(-50% + ${shift}px)) scale(${1 / k})`;
  }

  // Height the clip may use. Phones: a share of the game area (the clip pane
  // sizes to its content there, so it cannot be measured). Elsewhere: the pane.
  function availablePaneHeight() {
    const meta = els.clipMeta.offsetHeight || 0;
    if (isCompact()) {
      return Math.max(els.game.clientHeight * COMPACT_CLIP_SHARE - meta, MIN_PANE_PX);
    }
    return Math.max(els.clipPane.clientHeight - meta, 0);
  }

  // Re-fit on any size change: window resizes, phone rotation, the mobile URL
  // bar collapsing, a banner ad appearing. Setting the pane height above
  // resizes the clip pane on phones, which lands back here and is a no-op.
  let layoutQueued = false;
  const queueLayout = () => {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => { layoutQueued = false; layoutClip(); });
  };
  window.addEventListener('resize', queueLayout);
  window.addEventListener('orientationchange', queueLayout);
  if (window.ResizeObserver) {
    new ResizeObserver(queueLayout).observe(els.game);
    new ResizeObserver(queueLayout).observe(els.clipPane);
    // Leaflet only tracks window resizes; the map's box also changes when the
    // clip pane above it changes height between rounds.
    let mapQueued = false;
    new ResizeObserver(() => {
      if (mapQueued) return;
      mapQueued = true;
      requestAnimationFrame(() => { mapQueued = false; map.invalidateSize({ pan: false }); });
    }).observe(document.getElementById('map'));
  }

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
    // Once the day is over the player is paused on purpose under the final
    // card; a PAUSED here must not re-arm the stall watch and retry button.
    if (!els.finalOverlay.hidden) return;
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
    // worldCopyJump lets a click land on a repeated copy of the world
    // (lng 200, say); wrap it so the pin and the line use real coordinates.
    latlng = latlng.wrap();
    if (guessMarker) {
      guessMarker.setLatLng(latlng);
    } else {
      guessMarker = L.marker(latlng, { title: 'Your guess', icon: pin('guess'), keyboard: false }).addTo(map);
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

    // The answer pin is green and the guess red, so the two read apart.
    actualMarker = L.marker([round.lat, round.lng], { title: 'Actual location', icon: pin('actual'), keyboard: false }).addTo(map);

    guessLine = L.polyline([guessLatLng, [round.lat, round.lng]], { color: '#ff5c5c', dashArray: '6 6' }).addTo(map);

    els.scoreLabel.textContent = `Score: ${totalScore}`;
    els.resultTitle.textContent = round.answer || 'Location revealed';
    els.resultDistance.textContent = formatDistance(distanceKm);
    els.resultPoints.textContent = `+${points} points`;
    els.resultNextBtn.textContent = roundIndex + 1 >= rounds.length ? 'See results' : 'Next round';
    els.controls.hidden = true;
    els.resultOverlay.hidden = false;

    // The result panel covers the bottom of the map, so keep the line clear of it.
    map.invalidateSize({ pan: false });
    const pad = els.resultOverlay.offsetHeight || 0;
    map.fitBounds(guessLine.getBounds(), { paddingTopLeft: [40, 40], paddingBottomRight: [40, pad + 30], maxZoom: 12 });
    els.resultNextBtn.focus({ preventScroll: true });
  }

  function formatDistance(km) {
    if (km < 1) return `${Math.round(km * 1000)} m away`;
    if (km < 100) return `${km.toFixed(1)} km away`;
    return `${Math.round(km).toLocaleString('en-US')} km away`;
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
    stopPlayback();
    els.resultOverlay.hidden = true;

    els.finalTitle.textContent = `CrashGuessr #${dayNumber}`;
    els.finalScore.textContent = `${totalScore.toLocaleString('en-US')} / ${(rounds.length * MAX_POINTS).toLocaleString('en-US')}`;
    els.shareGrid.textContent = progress.points.map(pointsToEmoji).join('');

    els.finalRounds.textContent = '';
    progress.points.forEach((p, i) => {
      const r = rounds[i];
      if (!r) return;
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${pointsToEmoji(p)} ${r.answer || 'Round ' + (i + 1)}`;
      const pts = document.createElement('span');
      pts.className = 'pts';
      pts.textContent = p.toLocaleString('en-US');
      li.append(name, pts);
      els.finalRounds.appendChild(li);
    });

    // Puzzles turn over at midnight UTC (dayNumber counts whole UTC days).
    const tick = () => {
      const next = EPOCH_UTC + dayNumber * 86400000;
      const left = Math.max(0, next - Date.now());
      if (!left) {
        els.dailyNote.textContent = 'A new CrashGuessr is ready. Reload to play.';
        clearInterval(countdownTimer);
        return;
      }
      const h = Math.floor(left / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      els.dailyNote.textContent = `Next CrashGuessr in ${h}h ${String(m).padStart(2, '0')}m.`;
    };
    clearInterval(countdownTimer);
    tick();
    countdownTimer = setInterval(tick, 30000);

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
    const url = location.protocol === 'https:' ? location.origin : SITE_URL;
    return `CrashGuessr #${dayNumber} ${totalScore}/${rounds.length * MAX_POINTS}\n\n${progress.points.map(pointsToEmoji).join('')}\n${url}`;
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
      if (raw && raw.day === dayNumber && Array.isArray(raw.points) &&
          raw.points.every((p) => Number.isFinite(p) && p >= 0 && p <= MAX_POINTS)) {
        return { day: raw.day, points: raw.points.map(Math.round), done: raw.done === true };
      }
    } catch (e) { /* corrupt storage or storage blocked, start fresh */ }
    return { day: dayNumber, points: [], done: false };
  }

  function saveProgress() {
    // Throws in some private-browsing modes and when storage is full; the
    // game still plays, it just won't remember the day across reloads.
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(progress)); } catch (e) { /* not persisted */ }
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
