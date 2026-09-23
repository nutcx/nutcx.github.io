import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://nutcx.github.io",
  base: "/",
  output: "static",
  trailingSlash: "always",
  image: {
    remotePatterns: [{ protocol: "https", hostname: "akmweb.youngjoygame.com", pathname: "/web/svnres/img/**" }],
  },
  build: {
    format: "directory",
  },
});
