// CrashGuessr round data.
//
// Each round needs a real-world location (lat/lng) and a clip source.
// Clip source options (pick ONE per round):
//   youtubeId: "VIDEO_ID"          -> embeds https://www.youtube.com/embed/VIDEO_ID
//   file: "clips/whatever.mp4"     -> local/self-hosted video file (put files in a clips/ folder)
//   text: "flavor description"    -> no video, just descriptive text (demo/placeholder mode)
//
// Optional per-round framing/trim fields (all optional):
//   start:  seconds to start at   -> skips studio intros, anchor read, station stings
//   end:    seconds to loop at    -> cuts before the clip leaves dashcam POV
//   aspect: source aspect ratio   -> defaults to 16/9; needed for portrait (9/16) uploads
//   zoom:   scale over contain-fit -> >1 pushes chyrons/station bugs outside the pane
//   shiftY: fraction of clip height to nudge down (+) or up (-) before clipping
//   captions: true                -> ACKNOWLEDGED LEAK, this clip publishes a
//             caption track. See the captions note below. The e2e suite fails
//             on any clip that shows captions without this flag set, so it is
//             an admission that a round is known-risky, never an approval.
//
// Why trim/zoom exist: several of these incidents only exist on news uploads.
// A news upload leaks the answer two ways (an anchor reading the city name, and
// a lower-third chyron / station bug that names it on every frame), so those
// rounds are trimmed to the raw dashcam segment and cropped so no station
// graphics are on screen.
//
// News uploads are a last-resort source, not a preferred one: even with
// trim/crop, they've leaked in testing (captions the uploader left on, the
// on-scene chyron flashing for a frame when a cut lands right at `end`).
// A standalone dashcam-channel upload with no studio segment and no
// chyron needs none of this and can't leak the same way. Prefer that for
// future rounds; only reach for a news re-upload when no clean dashcam-only
// upload of the incident exists, and budget extra margin on `start`/`end`
// (not just enough to trim the studio segment, since the trim watch polls
// on an interval and a tight cut can still let a frame through).
//
// CAPTIONS ARE THE UNFIXABLE ONE. Three of the five clips below publish a
// caption track, and a news clip's captions transcribe the anchor saying the
// city name. Measured over repeated trials (.test/probe-captions.js), no
// combination of player calls reliably suppresses them for a viewer whose
// YouTube account asks for captions, and there is no caption event to hook,
// only a poll we frequently lose. app.js does what it can, and the crop helps
// because captions render low in the frame, but neither is a guarantee.
//
// The only real fix is sourcing: a clip that publishes no caption track cannot
// leak this way. The two clips below without a `captions` flag (Vaughan,
// Oelwein) are both plain dashcam-channel uploads, which is not a coincidence.
// Replacing the three flagged rounds with caption-free uploads is the open
// work item here.
//
// ---------------------------------------------------------------------------
// ADDING A CLIP
//
// The pool is the binding constraint on the whole game: app.js serves
// ROUNDS_PER_DAY rounds and deals from this list without repeating, so a day of
// play costs that many clips. Five clips is under two days of non-repeating
// play. Tooling to grow it lives in .test/:
//
//   node find-clips.js search "<query>"   scrapes real YouTube listings, so an
//   node find-clips.js channel <@handle>  id it prints provably exists. It
//                                         down-ranks compilations and broadcast
//                                         channels.
//   node vet-clips.js <id> [id...]        confirms the id IS the video you
//                                         think (reads title/channel off the
//                                         player), that it embeds from the
//                                         production origin, whether it has
//                                         caption tracks, and writes
//                                         screenshots across the clip.
//
// What the tools CANNOT decide, and what actually gates a clip:
//   1. A real location. Every round needs a lat/lng, so the title, description
//      or a news report has to pin the spot down. "10th Street and 9th Avenue"
//      exists in dozens of towns: if the city is not certain, the clip is not
//      usable, because a confidently wrong answer is worse than no round.
//   2. Trim points. Watch it and find when the crash happens, then set
//      start/end around it with margin (see the trim notes above).
//   3. Burned-in graphics. Screenshots show these; station bugs and chyrons are
//      part of the video's pixels and can only be cropped, never turned off.
//
// Prefer, in order: personal dashcam channels, dashcam-hardware channels
// (BlackVue, Thinkware, VIOFO customer submissions), print outlets. Avoid TV
// stations: every caption-bearing clip here came from one.
//
// These are REAL incidents, each confirmed by a news report naming the exact
// intersection, paired with a standalone (non-compilation) YouTube upload of the
// dashcam footage. lat/lng for Vaughan and DTLA come from a geocoded street address;
// the other three are best-effort estimates of the named intersection (news coverage
// didn't include a geocode), so treat those as approximate, not survey-grade.
//
// Sources:
//   1. Vaughan: https://www.youtube.com/watch?v=BCzCJ2B-rr8 (Global News, Weston & Rutherford)
//   2. DTLA: https://www.youtube.com/watch?v=e9ugQlVnYdo (KTLA, 7th & Hope, Feb 25 2026)
//   3. Goldsboro: https://www.youtube.com/watch?v=0-t-LOCVNeU (US-70 & N Oak Forest Rd, May 9 2026)
//   4. Fort Oglethorpe: https://www.youtube.com/shorts/r6FZXi43GEk (Battlefield Pkwy/GA-2 & Dietz Rd, Jan 2026)
//   5. Oelwein: https://www.youtube.com/watch?v=wVrZoCPfCFw (Hwy 3 & W Ave, Fayette Co, Jul 27 2026)

const ROUNDS = [
  {
    // Raw dashcam start to finish (no studio segment). Impact lands ~16s.
    youtubeId: "BCzCJ2B-rr8",
    lat: 43.8262, lng: -79.5562,
    answer: "Vaughan, Ontario, Canada (Weston Rd & Rutherford Rd)"
  },
  {
    // Dashcam POV runs 0-10.2s, then cuts to on-scene footage with a
    // "DOWNTOWN LA" chyron. Zoom crops the KTLA bug and the news ticker
    // (which names LA-area cities) out of frame. end was 10 (only a 0.2s
    // margin before the chyron), which the trim watch's poll interval could
    // miss and flash the chyron before seeking back; 9 gives real headroom.
    //
    // shiftY was 0.10 to crop the bottom ticker, but shifting down also drags
    // the visible window UP the frame, which left only 6.7% of the top cropped
    // and put YouTube's own title bar on screen: this round was rendering
    // "KTLA 5" over a clip whose answer is Los Angeles. layoutClip() now
    // guarantees the top crop on every round, so this no longer needs to fight
    // for it.
    //
    // The zoom is this aggressive because KTLA's station bug is burned into
    // the video pixels in the bottom-right corner, so unlike the YouTube
    // overlays it cannot be turned off, only cropped away. The small positive
    // shiftY sends the extra crop to the bottom where the bug and the ticker
    // are, while layoutClip()'s floor keeps the top covered. This is the most
    // compromised clip in the set (burned-in bug, chyron, AND captions) and is
    // the first one that should be replaced.
    youtubeId: "e9ugQlVnYdo",
    end: 9, zoom: 1.8, shiftY: 0.06,
    captions: true,
    lat: 34.0489, lng: -118.2590,
    answer: "Downtown Los Angeles, USA (7th St & S Hope St)"
  },
  {
    // First 19s is an anchor at the desk; dashcam starts at 20s. The red
    // chyron ("CRASH IN GOLDSBORO...") sits on every frame, so crop it out.
    // shiftY reduced from 0.08 for the same reason as the DTLA round: a
    // positive shift eats into the top crop that hides YouTube's title bar.
    youtubeId: "0-t-LOCVNeU",
    start: 20, zoom: 1.6, shiftY: 0.03,
    captions: true,
    lat: 35.365, lng: -78.010,
    answer: "Goldsboro, North Carolina, USA (US-70 & N Oak Forest Rd, approx.)"
  },
  {
    // Vertical Shorts upload, dashcam only. Impact ~8-11s.
    youtubeId: "r6FZXi43GEk",
    start: 4, end: 18, aspect: 9 / 16,
    captions: true,
    lat: 34.925, lng: -85.245,
    answer: "Fort Oglethorpe, Georgia, USA (Battlefield Pkwy/GA-2 & Dietz Rd, approx.)"
  },
  {
    // Raw dashcam, 10s, impact ~5s.
    youtubeId: "wVrZoCPfCFw",
    aspect: 22 / 15,
    lat: 42.680, lng: -91.955,
    answer: "Near Oelwein, Iowa, USA (Highway 3 & W Ave, Fayette Co., approx.)"
  }
];
