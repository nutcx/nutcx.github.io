import type { APIRoute } from "astro";
import { canonicalUrl } from "../lib/site";
import { guides } from "../data/guides";

import { loadHeroes, loadItems } from "../lib/catalog.mjs";

export const GET: APIRoute = async () => {
  const heroes = await loadHeroes();
  const items = await loadItems();
  const routes = ["", "dashboard/", "support/", "privacy/", "terms/", "heroes/", "preparations/", "guides/", ...guides.map(guide => `guides/${guide.slug}/`),
    ...heroes.map(hero => `heroes/${hero.id}/`), ...items.map(item => item.path)];
  const entries = [...new Set(routes.map(route => canonicalUrl(route)))]
    .map((url) => `  <url><loc>${url.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</loc></url>`)
    .join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } },
  );
};
