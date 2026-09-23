import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const sitemap = readFileSync('dist/sitemap.xml','utf8');
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match=>match[1]);
assert.equal(new Set(urls).size,urls.length,'Sitemap URLs must be unique');
for(const value of urls) {
  const url = new URL(value);
  assert.equal(url.origin,'https://nutcx.github.io');
  assert.equal(url.search,''); assert.equal(url.hash,'');
  const file = join('dist',url.pathname,'index.html');
  assert.ok(existsSync(file),`Sitemap route exists: ${value}`);
  const html = readFileSync(file,'utf8');
  assert.ok(!/<meta name="robots" content="noindex"/.test(html),`Sitemap route is indexable: ${value}`);
  assert.ok(html.includes(`<link rel="canonical" href="${value}"`),`Canonical matches sitemap: ${value}`);
}
for(const route of ['guides/','guides/get-started/','guides/shared-previews/','guides/troubleshooting/']) {
  assert.ok(urls.includes(`https://nutcx.github.io/${route}`));
  const html = readFileSync(join('dist',route,'index.html'),'utf8');
  assert.equal((html.match(/<h1\b/g)||[]).length,1);
}
const home = readFileSync('dist/index.html','utf8');
const images = [...home.matchAll(/<img\b[^>]*>/g)].map(match=>match[0]).filter(tag=>tag.includes('.webp'));
assert.equal(images.length,6,'Featured portraits use generated WebP assets');
for(const tag of images) {
  const src = tag.match(/src="([^"]+)"/)[1];
  assert.ok(src.startsWith('/_astro/'));
  assert.ok(tag.includes('srcset=') && tag.includes('loading="lazy"'));
  assert.ok(statSync(join('dist',src)).size<20000,'Each small portrait should remain below 20 KB');
}
assert.ok(home.includes('google-site-verification'));
assert.ok(home.includes('data-analytics-panel'));
assert.ok(!home.includes('<script async src="https://www.googletagmanager.com'),'Google script must only load after consent');
console.log(`Search readiness passed: ${urls.length} canonical sitemap pages, guides, responsive portraits, and opt-in markup.`);
