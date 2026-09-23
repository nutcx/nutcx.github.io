export const SITE = {
  name: "NutCracker Tools",
  shortName: "NutCracker",
  operator: "Nutcx",
  description:
    "Browse hero skin and preparation previews, share item links, and find Android setup guides for the NutCracker Tools app.",
  packageName: "com.nutcx.tools",
  version: "1.0.0",
  repository: "https://github.com/nutcx/nutcx.github.io",
  issues: "https://github.com/nutcx/nutcx.github.io/issues",
  releases: "https://github.com/nutcx/nutcx.github.io/releases",
  pagesOrigin: "https://nutcx.github.io",
  pagesPath: "",
} as const;

export type PageKey = "heroes" | "preparations" | "home" | "dashboard" | "guides" | "support" | "privacy" | "terms";

export function withBase(path = ""): string {
  const base = import.meta.env.BASE_URL.endsWith("/")
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`;
  return `${base}${path.replace(/^\//, "")}`;
}

export function canonicalUrl(path = ""): string {
  return new URL(withBase(path), SITE.pagesOrigin).toString();
}
