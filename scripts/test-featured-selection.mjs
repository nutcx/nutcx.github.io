import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { projectItems } from '../src/lib/catalog.mjs';
import {
  featuredPreparationKey, featuredSkinKey, loadFeaturedContent,
  MAX_FEATURED_ITEMS, projectFeaturedContent,
} from '../src/lib/featured-catalog.mjs';

const archive = 'https://example.com/resource.zip';
const skin = (skinId, category, name, source = null) => ({
  skinId, category, name, landscape: `https://example.com/${category}-${skinId}.webp`, source,
});
const effect = (id, category, name, source = null) => ({
  id, category, name, image: `https://example.com/${category}-${id}.webp`, source,
});
const skinRoute = (targetSkinId, targetCategory = 0, url = archive) => ({
  targetSkinId, targetCategory, archive: url,
});
const effectRoute = (targetId, targetCategory = 0, url = archive, extra = {}) => ({
  targetId, targetCategory, archive: url, ...extra,
});
const original = (upgrades, backupArchive = '') => ({ upgrades, backupArchive });
const entries = (heroes = [], types = []) => ({
  'heroes.json': { heroes },
  'preparations.json': { preparationSchemaVersion: 4, types },
});

test('keys match the Android/Admin golden and preserve type, category and hero boundaries', () => {
  assert.equal(featuredSkinKey(101, 1, 7), 'featured.skin.101.1.7');
  assert.equal(featuredPreparationKey('effects.recall', 0, 7),
    'featured.preparation.4c76362d19efa16b9616e0deb8ca34ae');
  assert.equal(new Set([
    featuredPreparationKey('effects.recall', 0, 7),
    featuredPreparationKey('effects.recall', 1, 7),
    featuredPreparationKey('effects.spawn', 0, 7),
  ]).size, 3);
});

test('absent, false, nonboolean, inherited, and unknown flags never create cards', () => {
  const data = entries([{ heroId: 1, skins: [
    skin(1, 0, 'Original', original([skinRoute(7)])), skin(7, 0, 'Target'),
  ] }]);
  const key = featuredSkinKey(1, 0, 7);
  for (const flags of [undefined, {}, { [key]: false }, { [key]: 'true' },
    { [key]: 1 }, { [key]: null }, Object.create({ [key]: true }),
    { [featuredSkinKey(99, 0, 7)]: true }]) {
    assert.equal(projectFeaturedContent(data, flags).length, 0);
  }
  assert.equal(projectFeaturedContent(data, { [key]: true }).length, 1);
});

test('one destination card retains exact original routes even without an original backup', () => {
  const data = entries([{ heroId: 1, skins: [
    skin(1, 0, 'Same name', original([skinRoute(7)])),
    skin(1, 1, 'Same name', original([skinRoute(7)])),
    skin(2, 0, 'Other original', original([skinRoute(7), skinRoute(7)])),
    skin(7, 0, 'Target', original([], archive)),
  ] }]);
  const [group] = projectFeaturedContent(data, { [featuredSkinKey(1, 0, 7)]: true });
  assert.equal(group.name, 'Target');
  assert.equal(group.options.length, 4);
  assert.deepEqual(group.options.map(option => option.item.path).sort(), [
    '/heroes/1/1-7/', '/heroes/1/1c1-7/', '/heroes/1/2-7/', '/heroes/1/7/',
  ].sort());
  assert.equal(group.options.at(-1).item.filter, 'original', 'Replacement preview comes before restore');
  assert.equal(group.options.find(option => option.item.path === '/heroes/1/1-7/').source.availableToApply, false);
  for (const option of group.options) {
    const canonical = projectItems(data).find(item => item.id === option.item.id);
    assert.deepEqual(option.item, canonical);
    assert.equal(option.item.sourceId, option.source.id);
  }
  assert.ok(Object.isFrozen(group) && Object.isFrozen(group.options));
});

test('equal names and numeric destination IDs stay separate across heroes and categories', () => {
  const data = entries([1, 2].map(heroId => ({ heroId, skins: [
    skin(1, 0, 'Original', original([skinRoute(7), skinRoute(7, 1)])),
    skin(7, 0, 'Same target'), skin(7, 1, 'Same target'),
  ] })));
  const flags = Object.fromEntries([1, 2].flatMap(heroId => [0, 1].map(category => [
    featuredSkinKey(heroId, category, 7), true,
  ])));
  const groups = projectFeaturedContent(data, flags);
  assert.equal(groups.length, 4);
  assert.equal(new Set(groups.map(group => group.key)).size, 4);
  assert.ok(groups.every(group => group.options.length === 1));
});

test('preparation types, target categories, variants and exact image overrides are retained', () => {
  const data = entries([], ['effects.recall', 'effects.trail'].map(key => ({ key, name: key, items: [
    effect(0, 0, 'Classic', original([
      effectRoute(7), effectRoute(7, 0, 'https://example.com/variant.zip', { name: 'Alternate', image: 'https://example.com/variant.webp' }),
      effectRoute(7, 1), effectRoute(8, 0, ''),
    ])),
    effect(7, 0, 'Official'), effect(7, 1, 'Custom'), effect(8, 0, 'Unavailable'),
  ] })));
  const flags = Object.fromEntries(data['preparations.json'].types.flatMap(type => [
    [featuredPreparationKey(type.key, 0, 0), true],
    [featuredPreparationKey(type.key, 0, 7), true],
    [featuredPreparationKey(type.key, 1, 7), true],
    [featuredPreparationKey(type.key, 0, 8), true],
  ]));
  const groups = projectFeaturedContent(data, flags);
  assert.equal(groups.length, 4, 'Empty backup and unavailable upgrade flags produce no card');
  for (const type of data['preparations.json'].types) {
    const group = groups.find(group => group.key === featuredPreparationKey(type.key, 0, 7));
    assert.equal(group.options.length, 2);
    assert.equal(group.name, 'Alternate', 'Deterministic replacement-first variant preview');
    assert.equal(group.image, 'https://example.com/variant.webp');
    assert.equal(new Set(group.options.map(option => option.item.path)).size, 2);
    assert.ok(group.options.every(option => option.source.availableToApply === false));
    assert.equal(group.group, type.name);
  }
});

test('legacy preparation names or numeric IDs do not become guessed feature keys', () => {
  const data = { 'heroes.json': { heroes: [] }, 'preparations.json': { preparations: [{
    preparationId: 7, name: 'Recall', archive, image: '', items: [{ name: 'Effect', archive, image: '' }],
  }] } };
  assert.deepEqual(projectFeaturedContent(data, { [featuredPreparationKey('effects.recall', 0, 7)]: true }), []);
});

test('apply the global 24-card cap before filtering a page and order deterministically', () => {
  const targets = Array.from({ length: 30 }, (_, i) => skin(i + 1, 0, `Alpha ${String(i).padStart(2, '0')}`));
  const data = entries([{ heroId: 1, skins: [
    skin(0, 0, 'Original', original(targets.map(target => skinRoute(target.skinId)))), ...targets,
  ] }], [{ key: 'effects.recall', name: 'Recall', items: [
    effect(0, 0, 'Classic', original([effectRoute(7)])), effect(7, 0, 'Zulu effect'),
  ] }]);
  const flags = Object.fromEntries(targets.map(target => [featuredSkinKey(1, 0, target.skinId), true]));
  flags[featuredPreparationKey('effects.recall', 0, 7)] = true;
  const groups = projectFeaturedContent(data, flags);
  assert.equal(groups.length, MAX_FEATURED_ITEMS);
  assert.equal(groups.filter(group => group.kind === 'preparation').length, 0);
  assert.deepEqual(groups.map(group => group.name), targets.slice(0, 24).map(target => target.name));
  const reordered = structuredClone(data);
  reordered['heroes.json'].heroes[0].skins.reverse();
  reordered['heroes.json'].heroes[0].skins.at(-1).source.upgrades.reverse();
  assert.deepEqual(projectFeaturedContent(reordered, flags), groups);
});

test('verified local delivery loads only its authenticated feature selections', async () => {
  const root = resolve('public/content');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const groups = await loadFeaturedContent(root);
  assert.ok(groups.length > 0);
  assert.ok(groups.every(group => manifest.client.features[group.key] === true));
  assert.ok(groups.every(group => group.options.every(option => option.item.path.startsWith('/'))));
  console.log(`Verified featured delivery: ${groups.length} selected destinations, ${groups.reduce((n, group) => n + group.options.length, 0)} exact choices.`);
});

test('feature flag tampering fails signature verification rather than producing cards', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'nutcx-featured-tamper-'));
  try {
    await cp(resolve('public/content'), tempRoot, { recursive: true });
    const path = join(tempRoot, 'manifest.json');
    const raw = await readFile(path, 'utf8');
    assert.ok(raw.includes(':true'), 'Fixture has a true flag to tamper');
    await writeFile(path, raw.replace(':true', ':false'));
    await assert.rejects(loadFeaturedContent(tempRoot), /authenticate.*manifest\.json bytes/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
