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

`/items/<sha256>/` pages are generated at build time from the current public signed
`nutcx/app-content` bundle. The build verifies the pinned Ed25519 publisher and
entry checksums before generating HTML. The pages publish preview metadata only;
archive download URLs and editable source JSON are not emitted.

The existing Pages workflow rebuilds every six hours and supports manual dispatch.
A failed download or signature check fails the build, preserving the last deployed
site. A content release can therefore take up to the next successful rebuild to
appear on the website. Missing item paths use the 404 page.

`public/.well-known/assetlinks.json` contains the Play Console Digital Asset Links
certificate for `com.nutcx.tools`. Production automatic opening requires this file
to be deployed and the updated app to be installed. Debug builds intentionally
are not associated with the production website.

Skin identities hash the canonical hero/source/target IDs and categories. Preparation
identities hash kind, parent ID, archive URL and image URL rather than list position.
Renames and reordering keep links; changing a preparation archive or image creates
a new link. Old links never fall back to another position. A future schema with
permanent preparation-item IDs can remove this content-identity limitation.

Run `node scripts/test-item-links.mjs` after building to check shared IDs, metadata,
website association and signed-bundle tamper rejection. App-side URL tests are in
Fuego-GFX's `ItemLinksTest`.
