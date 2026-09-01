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

Astro serves the project under its configured base path. Open `http://localhost:4321/nutcracker-tools/` unless the terminal reports a different port.

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

The site is configured for the repository `kaizokuo-gfx/nutcracker-tools` and publishes at:

<https://kaizokuo-gfx.github.io/nutcracker-tools/>

Before the first deployment, open the repository's **Settings → Pages** page and set **Source** to **GitHub Actions**. The workflow at `.github/workflows/pages.yml` builds and deploys the site whenever changes are pushed to `main`; it can also be run manually from the Actions tab.

If the repository name or hosting domain changes, update both `site` and `base` in `astro.config.mjs` before deploying.
