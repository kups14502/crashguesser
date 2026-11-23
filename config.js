// CrashGuessr site config: ad, affiliate and sponsor slots.
//
// EVERYTHING HERE IS OFF. Nothing loads, renders or calls out to a third party
// until `enabled` is true at the top AND the section's own `enabled` is true AND
// its required IDs are filled in. monetize.js reads this object and ignores any
// value that does not validate (wrong ID format, non-https URL).
//
// Before turning ads on:
//   1. Get an approved AdSense account and fill in adsenseClient ("ca-pub-" and
//      digits) plus a slot ID per placement.
//   2. Publish /ads.txt at the site root with the line AdSense gives you
//      (google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0).
//   3. Add a privacy policy page and a consent banner (AdSense requires a
//      Google-certified CMP for EEA/UK visitors).
//
// Affiliate links render with rel="sponsored" and a disclosure line under them
// (FTC rule). Sponsor links render with rel="sponsored" too.
window.CG_CONFIG = {
  monetization: {
    enabled: false,

    ads: {
      enabled: false,
      adsenseClient: '',   // e.g. 'ca-pub-0000000000000000'
      slots: {
        banner: '',        // page-bottom banner during play (320x50 on phones, 728x90 on desktop)
        final: '',         // responsive unit on the end-of-day score card
      },
    },

    affiliates: {
      enabled: false,
      heading: 'Dashcams we like',
      disclosure: 'Some links are affiliate links. We may earn a commission at no cost to you.',
      // { label: 'Camera name', url: 'https://...', note: 'one short line' }
      links: [],
    },

    sponsor: {
      enabled: false,
      name: '',            // shown as "Presented by <name>"
      url: '',             // https only
      tagline: '',         // one short line on the score card
      logo: '',            // optional https image URL, about 120x32
    },
  },
};
