# Website search and measurement

The public website is `https://nutcx.github.io/`. Search Console ownership uses
the existing HTML meta tag in `SiteLayout.astro`; keep that tag when editing the
layout. The sitemap lists active canonical catalog pages and the guide pages.
Legacy item aliases and retirement notices remain available at their existing
URLs but are not added to the sitemap as duplicate content.

## Google Analytics

- Existing property: **nutcx-ph**, property ID **552257989**.
- Website stream: **NutCracker website**, stream ID **15832688436**.
- Public Google tag measurement ID: **G-LZFHMGC1GT**.
- `play_store_click` is a key event, counted once per event, with no assigned
  monetary value. It measures a direct click to the listing, not an installation.
- Event parameter `link_placement`: `home`, `item-preview`, `guide`, or `other`.
  The event-scoped custom dimension is **Play link placement**.

Only the production HTTPS hostname sends measurements. The tag is loaded only
after the visitor allows analytics. Declining does not load it. Footer controls
allow withdrawal and re-enabling; withdrawal disables measurement and removes
the host-only `_ga` cookies. The browser remembers its choice in
`nutcx-analytics-consent-v1`. Storage failures fall back to a choice for the
current page. Excluded/noindex pages do not initialize measurement.

Enhanced measurement is disabled on this website stream. The site explicitly
sends page views and direct Google Play clicks. Standard GA session/engagement
processing can still occur after consent. Query strings, fragments, and full
referrer paths are excluded from the configured page data. Advertising storage,
personalization, and Google Signals are disabled by the tag. Search inputs,
local dashboard notes, files, pairing codes, and intent-link contents are not
included in custom events. Cookies use a 30-day lifetime. The privacy policy and
dashboard describe these choices.

For website reporting, use the **NutCracker website** stream or **Web** platform
filter so the existing Android app traffic does not get mixed into comparisons.
In Reports, review page views and traffic acquisition; use `play_store_click`
for event counts/key events. In Explore, break that event down by **Page path**
and **Play link placement**. Consent declines and blocking extensions reduce
measured totals; these figures do not represent all visits or installs.

## Content and mobile performance

The `/guides/` section covers Android setup, sharing previews, and troubleshooting.
Guide content is based on the site's existing app support guidance. Catalog pages
use available names, categories, counts, source descriptions, and availability;
they do not invent hero statistics or resource behavior.

Heroes and Preparations list originals first, matching the Android app's browse
flow. An original's existing preview page lists only its own replacements; direct
replacement links include navigation back to that original. Relationships use
the publisher's full source identity, including preparation type and category,
so same-name items and repeated numeric IDs do not get merged. A skin original
with no backup archive is retained when it has an available replacement.

Hero portraits are processed by Astro/Sharp from the existing authorized CDN
into WebP files at their displayed size and double density. Explicit dimensions
reserve space and off-screen portraits load lazily. Large item artwork continues
to use its existing catalog URL; primary preview artwork has high fetch priority.

Baseline on September 24, 2026: mobile homepage performance **99**, accessibility
**96**, best practices **100**, SEO **100**; FCP **0.9 s**, LCP **1.0 s**, TBT **0 ms**,
CLS **0**, Speed Index **3.6 s**. The six featured portraits transferred about
**1,018.5 KiB**. The report also found low contrast in light-theme card link text.

[Baseline PageSpeed report](https://pagespeed.web.dev/analysis/https-nutcx-github-io/zwkcastydf?form_factor=mobile)

## Validation

`pnpm test` runs the production build, existing site/item-link/retirement checks,
consent and click tests, and a sitemap/canonical/guide/image audit. On Windows,
set `ASTRO_TELEMETRY_DISABLED=1` and `CI=true` if an interactive first-run prompt
would block a scripted build. No analytics calls are made by the test fixture.

The sitemap readiness audit checks every submitted URL against the generated
HTML and its canonical. PageSpeed scores are lab measurements and can vary;
Search Console indexing and real-user Core Web Vitals are separate signals.
