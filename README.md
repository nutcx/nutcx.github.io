# NutCracker Tools website

The official static website for NutCracker Tools, built with Astro and published through GitHub Pages.

## Requirements

- Node.js 24 or newer
- pnpm 11.19.0

The package manager version is pinned in `package.json`. If pnpm is not already available, install or activate pnpm 11.19.0 before continuing.

## Local development

Install dependencies:

```sh
pnpm install
```

Start the development server:

```sh
pnpm dev
```

Astro serves the project from the site root. Open `http://localhost:4321/` unless the terminal reports a different port.

## Validation and production preview

Run Astro's type and content checks:

```sh
pnpm check
```

Create the static production build:

```sh
pnpm build
```

Preview the generated site locally:

```sh
pnpm preview
```

The deployable files are generated in `dist/`.

## GitHub Pages deployment

The site is configured for the account-level Pages repository `nutcx/nutcx.github.io` and publishes at:

<https://nutcx.github.io/>

The AdMob authorization file is published at <https://nutcx.github.io/app-ads.txt>.

Before the first deployment, open the repository's **Settings → Pages** page and set **Source** to **GitHub Actions**. The workflow at `.github/workflows/pages.yml` builds and deploys the site whenever changes are pushed to `main`; it can also be run manually from the Actions tab.

If the repository name or hosting domain changes, update `astro.config.mjs`, `src/lib/site.ts`, `public/robots.txt`, `public/site.webmanifest`, and `scripts/validate-site.mjs` before deploying.

## Shared item previews

Skin previews use `/heroes/<heroId>/<sourceSkinId>-<targetSkinId>/` (for example,
`/heroes/1/1011-1013/`). Original skins use `/heroes/1/1011/`. Nonzero source or target
categories append `c<category>` to that skin ID to avoid collisions. Preparation
previews use `/preparations/<parentId>/<8-character-id>/`. The old `/items/<sha256>/`
pages remain available and declare the new URL as canonical. Pages are generated at build time from
`public/content/manifest.json` and its referenced `Document.mlbytes` in the same
checkout. The build verifies the pinned Ed25519 publisher on both files, the
manifest's version, size and SHA-256, and the document's entry checksums before
generating HTML. The pages publish preview metadata only;
archive download URLs and editable source JSON are not emitted.

Owner Admin publishes the signed content to this repository's `main` branch,
which triggers the existing Pages workflow. The same deployment updates both the
app's content files and the website's skin and Preparation previews; no separate
catalog upload or app release is needed. The build does not fetch the deployed
manifest (which would still describe the previous deployment) or the old
`app-content` catalog. `NUTCX_DOCUMENT_URL` is no longer used.

The Pages workflow also rebuilds every six hours and supports manual dispatch.
A missing or invalid signed delivery fails the build without falling back to an
older catalog, preserving the last deployed site. Missing item paths use the 404 page.

`public/.well-known/assetlinks.json` contains the Play Console Digital Asset Links
certificate for `com.nutcx.tools`. Production automatic opening requires this file
to be deployed and the updated app to be installed. Debug builds intentionally
are not associated with the production website.

Skin identities hash the canonical hero/source/target IDs and categories. Legacy
Preparation identities hash kind, parent ID, archive URL and image URL rather
than list position. The v4 Preparation catalog instead hashes the type and
source/target IDs; alternate archives for the same target also hash their
archive and displayed name/image. Old links never fall back to another position.
Preparations without an archive still get a preview page and link into the app;
the preview marks them as unavailable to apply until an archive is supplied.

Run `node scripts/test-item-links.mjs` after building to check shared IDs, metadata,
website association and same-checkout catalog loading. Run
`pnpm test:content-delivery` for signed manifest/document tamper rejection and
manifest-selected catalog freshness. App-side URL tests are in Fuego-GFX's `ItemLinksTest`.

## Retired content

Every build writes `catalog-history.json` with public item IDs, paths and names.
The next build reads the last deployed history and retains preview routes for
removed items, including legacy `/items/<id>/` links. Those pages explain that the
item is no longer available and link back to the catalog. Active content always
takes precedence, including when an earlier catalog is republished as a new version.

For a specific reason or replacement, add an entry to `src/data/retirements.json`:

```json
[{ "id": "<full 64-character item ID>", "reason": "Replaced by an updated item.", "replacement": "/heroes/1/1011/" }]
```

The replacement is optional and must identify a currently available item. Invalid
notices fail the build. Remove or update a replacement if it is later retired.
Reasons must be factual; removal alone only produces the generic notice.

The first deployment seeds history from the current signed catalog; it cannot
recover items removed before that deployment. Preserve the deployed history when
migrating hosting. Set `CATALOG_HISTORY_FILE` to a saved history JSON file to restore
history during a hosting migration or test a historical catalog locally.
A history response other than success or first-use 404 fails
the build, preserving the deployed site. Run `node scripts/test-retirements.mjs`
to verify retirement and restoration behavior. Historical archive URLs are never
included in this public index.

## Browsing behavior

`/heroes/` provides hero search, and `/heroes/<heroId>/` lists skin previews with
Original, Official, Custom and Anime filters matching the app classification.
`/preparations/` supports search, category selection and original/replacement filters.
Cards link to previews and offer Open in app and Share actions. Browsing links work
without JavaScript; filtering and sharing are progressive enhancements.

Catalog items come from the same verified bundle as shared previews. Hero names
and icons are a metadata snapshot in `src/data/heroes.json`, exported from the
app's hero index on September 16, 2026. Update that file when hero metadata changes,
keeping only the hero ID, name and HTTPS image URL. Unknown IDs display as
`Hero <id>` until their labels are added; only heroes present in the bundle appear.
