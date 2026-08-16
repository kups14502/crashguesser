// CrashGuessr round data.
//
// Each round needs a real-world location (lat/lng) and a clip source.
// Clip source options (pick ONE per round):
//   youtubeId: "VIDEO_ID"          -> embeds https://www.youtube.com/embed/VIDEO_ID
//   file: "clips/whatever.mp4"     -> local/self-hosted video file (put files in a clips/ folder)
//   text: "flavor description"    -> no video, just descriptive text (demo/placeholder mode)
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
    youtubeId: "BCzCJ2B-rr8",
    lat: 43.8262, lng: -79.5562,
    answer: "Vaughan, Ontario, Canada (Weston Rd & Rutherford Rd)"
  },
  {
    youtubeId: "e9ugQlVnYdo",
    lat: 34.0489, lng: -118.2590,
    answer: "Downtown Los Angeles, USA (7th St & S Hope St)"
  },
  {
    youtubeId: "0-t-LOCVNeU",
    lat: 35.365, lng: -78.010,
    answer: "Goldsboro, North Carolina, USA (US-70 & N Oak Forest Rd, approx.)"
  },
  {
    youtubeId: "r6FZXi43GEk",
    lat: 34.925, lng: -85.245,
    answer: "Fort Oglethorpe, Georgia, USA (Battlefield Pkwy/GA-2 & Dietz Rd, approx.)"
  },
  {
    youtubeId: "wVrZoCPfCFw",
    lat: 42.680, lng: -91.955,
    answer: "Near Oelwein, Iowa, USA (Highway 3 & W Ave, Fayette Co., approx.)"
  }
];
