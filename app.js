(function () {
  const MAX_POINTS = 5000;
  const SCALE_KM = 2000; // higher = more forgiving scoring curve
  const EPOCH_UTC = Date.UTC(2026, 7, 16); // CrashGuessr #1
  const STORAGE_KEY = 'cg_daily_v1';

  const dayNumber = Math.floor((Date.now() - EPOCH_UTC) / 86400000) + 1;
  const rounds = seededShuffle(ROUNDS.slice(), dayNumber);

  let progress = loadProgress();
  let roundIndex = progress.points.length;
  let totalScore = progress.points.reduce((a, b) => a + b, 0);
  let guessMarker = null;
  let actualMarker = null;
  let guessLine = null;
  let hasGuessed = false;

  const map = L.map('map', { worldCopyJump: true }).setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18
  }).addTo(map);

  const els = {
    roundLabel: document.getElementById('roundLabel'),
    scoreLabel: document.getElementById('scoreLabel'),
    ytFrame: document.getElementById('ytFrame'),
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
    if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();

    if (round.youtubeId) {
      els.ytFrame.hidden = false;
      playYoutube(round.youtubeId);
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
  let ytPlayer = null;
  let ytApiReady = false;
  let pendingVideoId = null;
  let stallTimer = null;

  window.onYouTubeIframeAPIReady = function () {
    ytApiReady = true;
    if (pendingVideoId) {
      const id = pendingVideoId;
      pendingVideoId = null;
      playYoutube(id);
    }
  };

  function playYoutube(id) {
    els.videoLoading.hidden = false;
    els.tapPlayBtn.hidden = true;
    if (!ytApiReady || typeof YT === 'undefined' || !YT.Player) {
      pendingVideoId = id;
      return;
    }
    if (!ytPlayer) {
      ytPlayer = new YT.Player('ytPlayerTarget', {
        videoId: id,
        playerVars: {
          autoplay: 1, mute: 1, controls: 0, modestbranding: 1, rel: 0,
          iv_load_policy: 3, disablekb: 1, fs: 0, playsinline: 1,
        },
        events: {
          onReady: (e) => { e.target.mute(); e.target.playVideo(); armStallWatch(); },
          onStateChange: onYtStateChange,
        },
      });
    } else {
      ytPlayer.loadVideoById(id);
      ytPlayer.mute();
      armStallWatch();
    }
  }

  function armStallWatch() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { els.tapPlayBtn.hidden = false; }, 4000);
  }

  function onYtStateChange(e) {
    if (typeof YT === 'undefined') return;
    if (e.data === YT.PlayerState.PLAYING) {
      clearTimeout(stallTimer);
      els.videoLoading.hidden = true;
      els.tapPlayBtn.hidden = true;
    } else if (e.data === YT.PlayerState.ENDED) {
      e.target.seekTo(0);
      e.target.playVideo();
    } else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.BUFFERING) {
      els.videoLoading.hidden = false;
    }
  }

  els.tapPlayBtn.addEventListener('click', () => {
    if (ytPlayer) { ytPlayer.mute(); ytPlayer.playVideo(); }
    armStallWatch();
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

  function seededShuffle(arr, seed) {
    const rand = mulberry32(seed);
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
})();
