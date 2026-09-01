import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const base = "/nutcracker-tools/";
const errors = [];

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function expectFile(path) {
  if (!existsSync(join(dist, path))) errors.push(`Missing generated file: ${path}`);
}

[
  "index.html",
  "404.html",
  "dashboard/index.html",
  "support/index.html",
  "privacy/index.html",
  "terms/index.html",
  "sitemap.xml",
  "favicon.svg",
  "brand-mark.svg",
  "site.webmanifest",
  "robots.txt",
].forEach(expectFile);

if (existsSync(dist)) {
  const htmlFiles = walk(dist).filter((path) => path.endsWith(".html"));
  const attributePattern = /(?:href|src)="([^"]+)"/g;

  for (const file of htmlFiles) {
    const html = readFileSync(file, "utf8");
    if (!html.includes("<meta name=\"description\"")) errors.push(`${relative(dist, file)} has no meta description`);
    if (!html.includes("<title>")) errors.push(`${relative(dist, file)} has no title`);
    if (/\b(?:TODO|FIXME|undefined|null)\b/.test(html)) errors.push(`${relative(dist, file)} contains an unresolved placeholder`);

    for (const match of html.matchAll(attributePattern)) {
      const raw = match[1];
      if (/^(?:https?:|mailto:|tel:|data:|#)/.test(raw)) continue;
      if (raw.startsWith("/") && !raw.startsWith(base)) {
        errors.push(`${relative(dist, file)} uses a root URL outside the Pages base: ${raw}`);
        continue;
      }
      if (!raw.startsWith(base)) continue;

      const clean = raw.slice(base.length).split(/[?#]/)[0];
      let target = clean;
      if (!target || target.endsWith("/")) target += "index.html";
      if (!existsSync(join(dist, target))) {
        errors.push(`${relative(dist, file)} links to missing local output: ${raw}`);
      }
    }
  }

  const privacy = readFileSync(join(dist, "privacy/index.html"), "utf8");
  ["Firebase", "Google Mobile Ads", "Wireless ADB", "GitHub Pages", "September 2, 2026"].forEach((term) => {
    if (!privacy.includes(term)) errors.push(`Privacy policy is missing required disclosure: ${term}`);
  });
}

if (errors.length) {
  console.error(`Site validation failed with ${errors.length} issue(s):`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log("Site validation passed: required routes, metadata, base paths, local links, and privacy disclosures are present.");
