import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://kaizokuo-gfx.github.io",
  base: "/nutcracker-tools",
  output: "static",
  trailingSlash: "always",
  build: {
    format: "directory",
  },
});
