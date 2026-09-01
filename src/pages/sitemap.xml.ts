import type { APIRoute } from "astro";
import { canonicalUrl } from "../lib/site";

const routes = ["", "dashboard/", "support/", "privacy/", "terms/"];

export const GET: APIRoute = () => {
  const entries = routes
    .map((route) => `  <url><loc>${canonicalUrl(route)}</loc></url>`)
    .join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } },
  );
};
