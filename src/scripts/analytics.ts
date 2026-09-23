export {};

const measurementId = 'G-LZFHMGC1GT';
const storageKey = 'nutcx-analytics-consent-v1';
const panel = document.querySelector<HTMLElement>('[data-analytics-panel]');
const status = document.querySelector<HTMLElement>('[data-analytics-status]');
const closeButton = document.querySelector<HTMLButtonElement>('[data-analytics-close]');
const acceptButton = document.querySelector<HTMLButtonElement>('[data-analytics-accept]');
const declineButton = document.querySelector<HTMLButtonElement>('[data-analytics-decline]');
const production = location.hostname === 'nutcx.github.io' && location.protocol === 'https:';
const enabled = panel?.dataset.analyticsEnabled === 'true';
let consent = 'unset';
let started = false;
let returnFocus: HTMLElement | null = null;
try { consent = localStorage.getItem(storageKey) || 'unset'; } catch { /* Keep choices in this page when storage is unavailable. */ }

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
    [key: `ga-disable-${string}`]: boolean;
  }
}

function startAnalytics() {
  if (!production || !enabled || consent !== 'granted') return;
  if (started) {
    window[`ga-disable-${measurementId}`] = false;
    window.gtag?.('consent', 'update', { analytics_storage: 'granted' });
    return;
  }
  started = true;
  window[`ga-disable-${measurementId}`] = false;
  window.dataLayer = window.dataLayer || [];
  // gtag requires Arguments entries, rather than nested array entries.
  window.gtag = function () { window.dataLayer!.push(arguments); };
  window.gtag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
  window.gtag('consent', 'update', { analytics_storage: 'granted' });
  window.gtag('js', new Date());
  let referringOrigin = '';
  try { referringOrigin = new URL(document.referrer).origin; } catch { /* No referrer. */ }
  const pageLocation = `${location.origin}${location.pathname}`;
  window.gtag('config', measurementId, {
    send_page_view: false,
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_domain: 'none',
    cookie_expires: 60 * 60 * 24 * 30,
    page_location: pageLocation,
    page_referrer: referringOrigin,
  });
  window.gtag('event', 'page_view', { page_location: pageLocation, page_referrer: referringOrigin, page_title: document.title });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${measurementId}`;
  script.referrerPolicy = 'origin';
  document.head.append(script);
}

function showChoices(focus = false) {
  if (!panel) return;
  panel.hidden = false;
  if (status) status.textContent = consent === 'granted' ? 'Analytics is currently on.' : consent === 'denied' ? 'Analytics is currently off.' : '';
  if (declineButton) declineButton.textContent = consent === 'granted' ? 'Turn off analytics' : 'No thanks';
  if (closeButton) closeButton.hidden = consent === 'unset';
  if (focus) acceptButton?.focus();
}

function hideChoices() { if (panel) panel.hidden = true; returnFocus?.focus(); }

function choose(value: 'granted' | 'denied') {
  const wasStarted = started;
  consent = value;
  try { localStorage.setItem(storageKey, value); } catch { /* This choice still applies to the current page. */ }
  hideChoices();
  if (value === 'granted') {
    startAnalytics();
  } else {
    // Disable measurement before clearing this site's Analytics cookies.
    window[`ga-disable-${measurementId}`] = true;
    if (wasStarted) window.gtag?.('consent', 'update', { analytics_storage: 'denied' });
    for (const cookie of document.cookie.split(';')) {
      const name = cookie.split('=')[0].trim();
      if (/^_ga(?:_|$)/.test(name)) document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
    }
    // Keep the disable flag in place for the rest of this page; no reload or navigation is needed.
  }
  window.nutcxToast?.(value === 'granted' ? 'Analytics allowed. You can change this in the footer.' : 'Optional analytics is off.');
}

acceptButton?.addEventListener('click', () => choose('granted'));
declineButton?.addEventListener('click', () => choose('denied'));
closeButton?.addEventListener('click', hideChoices);
document.querySelectorAll<HTMLButtonElement>('[data-analytics-settings]').forEach(button => {
  button.hidden = false;
  button.addEventListener('click', () => { returnFocus = button; showChoices(true); });
});
document.addEventListener('click', event => {
  if (!production || !enabled || consent !== 'granted' || !started) return;
  const link = event.target instanceof Element ? event.target.closest('a[href]') as HTMLAnchorElement | null : null;
  if (!link) return;
  let destination: URL;
  try { destination = new URL(link.href); } catch { return; }
  if (destination.protocol !== 'https:' || destination.hostname !== 'play.google.com' || destination.pathname !== '/store/apps/details' || destination.searchParams.get('id') !== 'com.nutcx.tools') return;
  const placement = link.dataset.playPlacement;
  window.gtag?.('event', 'play_store_click', {
    page_location: `${location.origin}${location.pathname}`,
    link_placement: ['home', 'item-preview', 'guide'].includes(placement || '') ? placement : 'other',
    transport_type: 'beacon',
  });
});
// Respect withdrawal in another tab without requiring a refresh.
window.addEventListener('storage', event => {
  if (event.key !== storageKey) return;
  consent = event.newValue || 'unset';
  if (consent !== 'granted') window[`ga-disable-${measurementId}`] = true;
  else startAnalytics();
});
if (consent === 'granted') startAnalytics();
else if (consent !== 'denied' && enabled) showChoices();
