import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadHeroes } from '../src/lib/catalog.mjs';
import { loadFeaturedContent } from '../src/lib/featured-catalog.mjs';

const decode = value => value.replace(/&(?:amp|lt|gt|quot|apos|#39|#x27);/g, entity => ({
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'", '&#x27;': "'",
})[entity]);
const attribute = (markup, name) => {
  const match = markup.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decode(match[1]) : undefined;
};
const htmlAt = path => readFileSync(`dist${path}index.html`, 'utf8');
const featuredArticles = html => [...html.matchAll(/<article\b[^>]*\bdata-featured-card="[^"]*"[\s\S]*?<\/article>/g)]
  .map(match => match[0]);
const featuredRoutes = html => [...html.matchAll(/<a\b[^>]*\bdata-featured-route="[^"]*"[\s\S]*?<\/a>/g)]
  .map(match => match[0]);
const text = html => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

// Page selection must use the same signed local delivery as the generated pages.
// A stale deployed manifest or unsigned network replacement must never be used.
const previousFetch = globalThis.fetch;
let groups;
let heroes;
try {
  globalThis.fetch = () => { throw new Error('Featured page checks must not fetch remote content'); };
  [groups, heroes] = await Promise.all([loadFeaturedContent(), loadHeroes()]);
} finally {
  globalThis.fetch = previousFetch;
}

function assertFeaturedPage(path, expected) {
  const html = htmlAt(path);
  const articles = featuredArticles(html);
  assert.deepEqual(articles.map(article => attribute(article, 'data-featured-card')),
    expected.map(group => group.key), `${path}: one card per signed featured destination`);
  const sections = [...html.matchAll(/<section\b[^>]*\bdata-featured-section(?:\s|>)[\s\S]*?<\/section>/g)]
    .map(match => match[0]);
  assert.equal(sections.length, expected.length ? 1 : 0,
    `${path}: hide the whole section when no applicable featured flags exist`);
  if (sections.length) {
    const labelledBy = attribute(sections[0], 'aria-labelledby');
    assert.ok(labelledBy, `${path}: featured region has a heading label`);
    assert.ok(sections[0].includes(`<h2 id="${labelledBy}"`), `${path}: heading label resolves to its h2`);
    assert.ok(!/\bdata-catalog(?:\s|=|>)/.test(sections[0]),
      `${path}: featured cards stay separate from original search/filter controls`);
  }

  for (const [index, group] of expected.entries()) {
    const article = articles[index];
    assert.ok(!article.includes('data-catalog-card'), `${path}: original-card counts are unchanged`);
    assert.equal(text(article.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? ''), group.name);
    const summary = article.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
    assert.ok(summary, `${path}: choices use a native keyboard-accessible details summary`);
    assert.equal(text(summary), `Choose original for ${group.name}`, `${path}: summary identifies its destination`);
    assert.ok(!/<(?:a|button|input|select)\b/.test(summary), `${path}: summary has no nested interactive control`);
    assert.equal((article.match(/\bdata-featured-choices(?:\s|>)/g) ?? []).length, 1);
    const routes = featuredRoutes(article);
    assert.equal(routes.length, group.options.length, `${path}: every exact original/archive option is retained`);
    const sourceCount = new Set(group.options.map(option => option.source.id)).size;
    assert.ok(text(article).includes(`${sourceCount} original${sourceCount === 1 ? '' : 's'} available`),
      `${path}: original count is not inflated by archive variants`);
    assert.ok(text(article).includes(group.group || group.categoryLabel), `${path}: category label is human-readable`);
    if (group.image) {
      assert.ok([...article.matchAll(/<img\b[^>]*>/g)].some(match => attribute(match[0], 'src') === group.image),
        `${path}: destination image is preserved`);
    }
    for (const [optionIndex, choice] of group.options.entries()) {
      const route = routes[optionIndex];
      assert.equal(attribute(route, 'data-featured-route'), choice.item.id);
      assert.equal(attribute(route, 'data-featured-source'), choice.source.id);
      assert.equal(attribute(route, 'href'), choice.item.path,
        `${path}: links retain the exact original/category/type/variant route`);
      assert.notEqual(choice.item.availableToApply, false, `${path}: unavailable choices are not promoted as featured`);
      assert.ok(text(route).includes(choice.source.name), `${path}: choice identifies its original`);
      assert.ok(text(route).includes(choice.item.filter === 'original' ? 'Restore original' : `Replace with ${choice.item.name}`));
      if (choice.source.image) {
        const image = [...route.matchAll(/<img\b[^>]*>/g)].find(match => attribute(match[0], 'src') === choice.source.image);
        assert.ok(image, `${path}: chooser shows the exact original's artwork`);
        assert.equal(attribute(image[0], 'alt'), '', `${path}: adjacent original label makes the image decorative`);
      }
      assert.ok(readFileSync(`dist${choice.item.path}index.html`, 'utf8')
        .includes(`intent://nutcx.github.io${choice.item.path}`), `${path}: choice leads to its existing item-specific app link`);
    }
    assert.ok(!/https:\/\/[^"'\s<>]+\.zip(?:\?[^"'\s<>]*)?/.test(article),
      `${path}: featured previews do not expose archive downloads`);
  }
}

assertFeaturedPage('/heroes/', groups.filter(group => group.kind === 'skin'));
assertFeaturedPage('/preparations/', groups.filter(group => group.kind === 'preparation'));
for (const hero of heroes) {
  assertFeaturedPage(`/heroes/${hero.id}/`, groups.filter(group => group.kind === 'skin' && group.heroId === hero.id));
}
console.log(`Featured page checks passed: ${groups.length} signed destinations, ${groups.reduce((count, group) => count + group.options.length, 0)} exact image choices, and ${heroes.length} hero pages.`);
