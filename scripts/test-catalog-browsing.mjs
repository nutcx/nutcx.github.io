import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupItemsBySource, loadItems, projectItems } from '../src/lib/catalog.mjs';

const source = (skinId, category, backupArchive, upgrades = []) => ({
  skinId, category, name: 'Same name', landscape: 'https://example.com/skin.webp',
  source: { backupArchive, upgrades },
});
const upgrade = { targetSkinId: 9, targetCategory: 1, archive: 'https://example.com/replacement.zip' };
const preparationType = key => ({ key, name: key, items: [
  { id: 0, category: 0, name: 'Classic', image: '', source: { backupArchive: '', upgrades: [
    { targetId: 9, targetCategory: 0, archive: 'https://example.com/a.zip' },
    { targetId: 9, targetCategory: 0, name: 'Variant', archive: 'https://example.com/b.zip' },
  ] } },
  { id: 0, category: 1, name: 'Classic', image: '', source: { backupArchive: '', upgrades: [] } },
  { id: 9, category: 0, name: 'Replacement', image: '', source: null },
] });
const fixture = { 'heroes.json': { heroes: [{ heroId: 1, skins: [
  source(1, 0, '', [upgrade]), source(1, 1, 'https://example.com/original.zip', [upgrade]),
  source(2, 0, '', []), { skinId: 9, category: 1, name: 'Custom target', source: null },
] }] }, 'preparations.json': { preparationSchemaVersion: 4, types: [
  preparationType('effects.recall'), preparationType('effects.elimination'),
] } };
const projected = projectItems(fixture);
const grouped = groupItemsBySource(projected);
const skins = grouped.filter(group => group.source.kind === 'skin');
assert.equal(skins.length, 2, 'A source with no archive or usable replacements is excluded');
assert.equal(skins[0].source.availableToApply, false, 'Keep a missing-archive source with usable replacements');
assert.equal(skins[0].source.path, '/heroes/1/1/');
assert.equal(skins[1].source.path, '/heroes/1/1c1/');
assert.deepEqual(skins.map(group => group.replacements.map(item => item.path)), [
  ['/heroes/1/1-9c1/'], ['/heroes/1/1c1-9c1/'],
], 'Equal names and numeric IDs must not combine different source categories');
const preps = grouped.filter(group => group.source.kind === 'preparation');
assert.equal(preps.length, 4, 'Equal preparation IDs remain distinct across types and categories');
assert.deepEqual(preps.map(group => group.replacements.length), [2, 0, 2, 0]);
assert.equal(new Set(preps.map(group => group.source.id)).size, 4);
for (const group of grouped) {
  assert.equal(group.source.sourceId, group.source.id);
  assert.ok(group.replacements.every(item => item.sourceId === group.source.id));
  assert.equal(new Set(group.replacements.map(item => item.path)).size, group.replacements.length);
}
const legacy = projectItems({ 'heroes.json': { heroes: [] }, 'preparations.json': { preparations: [
  { preparationId: 1, name: 'Recall', archive: 'https://example.com/original.zip', image: '',
    items: [{ name: 'Replacement', archive: 'https://example.com/legacy.zip', image: '' }] },
] } });
assert.equal(groupItemsBySource(legacy)[0].replacements.length, 1, 'Legacy preparation relationships remain supported');

const htmlAt = path => readFileSync(`dist${path}index.html`, 'utf8');
const cardPaths = html => [...html.matchAll(/<article\b[^>]*data-catalog-card[\s\S]*?<\/article>/g)]
  .map(match => match[0].match(/<a\b[^>]*href="([^"]+)"/)[1]);
const all = await loadItems();
const groups = groupItemsBySource(all);
const heroes = new Set(all.filter(item => item.kind === 'skin').map(item => item.heroId));
for (const heroId of heroes) {
  const page = htmlAt(`/heroes/${heroId}/`);
  assert.deepEqual(cardPaths(page), groups.filter(group => group.source.heroId === heroId).map(group => group.source.path));
  assert.ok(!page.includes('data-catalog-filter='), 'Replacement filters do not appear among originals');
}
assert.deepEqual(cardPaths(htmlAt('/preparations/')), groups.filter(group => group.source.kind === 'preparation').map(group => group.source.path));
for (const group of groups) {
  assert.deepEqual(cardPaths(htmlAt(group.source.path)), group.replacements.map(item => item.path), `Only this original's replacements: ${group.source.path}`);
  for (const replacement of group.replacements) {
    const page = htmlAt(replacement.path);
    assert.ok(page.includes(`href="${group.source.path}#replacements"`), 'A shared replacement can navigate to its original');
    assert.ok(page.includes(`intent://nutcx.github.io${replacement.path}`), 'Existing item-specific app links are preserved');
  }
}
console.log(`Catalog browsing passed: ${heroes.size} heroes, ${preps.length} collision fixtures, ${groups.length} original groups, and every replacement's return/app links.`);
