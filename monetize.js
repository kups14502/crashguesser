// Renders the ad, affiliate and sponsor slots from window.CG_CONFIG (config.js).
// With the shipped config this does nothing: every slot stays hidden and no
// third-party script is requested. See config.js for what turns each one on.
(function () {
  const cfg = ((window.CG_CONFIG || {}).monetization) || {};
  if (cfg.enabled !== true) return;

  const isHttps = (u) => {
    try { return new URL(u).protocol === 'https:'; } catch (e) { return false; }
  };
  const el = (id) => document.getElementById(id);
  const link = (url, text) => {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'sponsored noopener noreferrer';
    a.textContent = text;
    return a;
  };

  // --- Sponsor spot: topbar line during play, plus a line on the score card ---
  const sp = cfg.sponsor || {};
  if (sp.enabled === true && sp.name && isHttps(sp.url)) {
    const top = el('sponsorTop');
    if (top) {
      top.append('Presented by ');
      const a = link(sp.url, '');
      if (sp.logo && isHttps(sp.logo)) {
        const img = document.createElement('img');
        img.src = sp.logo;
        img.alt = sp.name;
        img.height = 20;
        img.loading = 'lazy';
        a.appendChild(img);
      } else {
        a.textContent = sp.name;
      }
      top.appendChild(a);
      top.hidden = false;
    }
    const fin = el('sponsorFinal');
    if (fin) {
      fin.append('Today\'s CrashGuessr is presented by ');
      fin.appendChild(link(sp.url, sp.name));
      if (sp.tagline) {
        const t = document.createElement('div');
        t.className = 'sponsor-tagline';
        t.textContent = sp.tagline;
        fin.appendChild(t);
      }
      fin.hidden = false;
    }
  }

  // --- Affiliate links: a short list on the score card ---
  const af = cfg.affiliates || {};
  const links = Array.isArray(af.links) ? af.links.filter((l) => l && l.label && isHttps(l.url)).slice(0, 4) : [];
  if (af.enabled === true && links.length) {
    const box = el('affiliateBox');
    if (box) {
      const h = document.createElement('h3');
      h.textContent = af.heading || 'Gear';
      box.appendChild(h);
      const ul = document.createElement('ul');
      for (const l of links) {
        const li = document.createElement('li');
        li.appendChild(link(l.url, l.label));
        if (l.note) {
          const n = document.createElement('span');
          n.className = 'affiliate-note';
          n.textContent = ' ' + l.note;
          li.appendChild(n);
        }
        ul.appendChild(li);
      }
      box.appendChild(ul);
      const d = document.createElement('p');
      d.className = 'affiliate-disclosure';
      d.textContent = af.disclosure || 'Some links are affiliate links.';
      box.appendChild(d);
      box.hidden = false;
    }
  }

  // --- AdSense banners ---
  const ads = cfg.ads || {};
  const client = String(ads.adsenseClient || '');
  const slots = ads.slots || {};
  if (ads.enabled !== true || !/^ca-pub-\d{10,20}$/.test(client)) return;
  const places = [['adBanner', slots.banner], ['adFinal', slots.final]]
    .filter(([id, slot]) => el(id) && /^\d{6,20}$/.test(String(slot || '')));
  if (!places.length) return;

  const s = document.createElement('script');
  s.async = true;
  s.crossOrigin = 'anonymous';
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(client);
  document.head.appendChild(s);

  window.adsbygoogle = window.adsbygoogle || [];
  const filled = new Set();
  const fill = (id, slot) => {
    if (filled.has(id)) return;
    const box = el(id);
    if (!box) return;
    filled.add(id);
    const ins = document.createElement('ins');
    ins.className = 'adsbygoogle';
    ins.style.display = 'block';
    ins.setAttribute('data-ad-client', client);
    ins.setAttribute('data-ad-slot', String(slot));
    ins.setAttribute('data-ad-format', id === 'adBanner' ? 'horizontal' : 'auto');
    ins.setAttribute('data-full-width-responsive', 'true');
    box.appendChild(ins);
    box.hidden = false;
    try { window.adsbygoogle.push({}); } catch (e) { /* blocked by an ad blocker */ }
    if (id === 'adBanner') {
      document.body.classList.add('has-banner-ad');
      window.dispatchEvent(new Event('resize'));
    }
  };

  for (const [id, slot] of places) {
    if (id === 'adBanner') { fill(id, slot); continue; }
    // The score-card unit has no width while its overlay is hidden, and AdSense
    // refuses a zero-width slot, so fill it once the card opens.
    const overlay = el('finalOverlay');
    const tryFill = () => { if (overlay && !overlay.hidden) fill(id, slot); };
    tryFill();
    if (overlay) new MutationObserver(tryFill).observe(overlay, { attributes: true, attributeFilter: ['hidden'] });
  }
})();
