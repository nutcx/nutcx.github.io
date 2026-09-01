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
