import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectItems } from '../src/lib/catalog.mjs';
import { loadPublicContentDelivery } from './public-content-manifest.mjs';

const module = await import('./discord-content-diff.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes('discord-content-diff.mjs')) {
    assert.fail('Catalog snapshots, change detection, and Discord batching have not been implemented');
  }
  throw error;
});
const { createCatalogSnapshot, diffCatalogSnapshots, buildDiscordBatches } = module;
const summary = { publicationSequence: '42', contentVersion: '1001.14', contentSha256: 'a'.repeat(64) };
const archive = 'https://example.com/replacement.zip';
const fixture = () => ({
  'heroes.json': { heroes: [{ heroId: 1, skins: [
    { skinId: 1011, category: 0, name: 'Moonlight Archer', landscape: 'https://example.com/moonlight.webp',
      source: { backupArchive: 'https://example.com/backup.zip', upgrades: [
        { targetSkinId: 1013, targetCategory: 1, archive },
      ] } },
    { skinId: 1012, category: 0, name: 'Burning Bow', landscape: 'https://example.com/bow.webp',
      source: { backupArchive: '', upgrades: [] } },
    { skinId: 1013, category: 1, name: 'Honor', landscape: 'https://example.com/honor.webp', source: null },
  ] }] },
  'preparations.json': { preparationSchemaVersion: 4, types: [{ key: 'effects.recall', name: 'Recall', items: [
    { id: 0, category: 0, name: 'Classic', image: 'https://example.com/classic.webp',
      source: { backupArchive: '', upgrades: [
        { targetId: 99740, targetCategory: 0, archive: 'https://example.com/seal.zip' },
        { targetId: 99740, targetCategory: 0, name: 'Big Seal', image: 'https://example.com/big.webp', archive: 'https://example.com/big.zip' },
      ] } },
    { id: 99740, category: 0, name: 'Seal', image: 'https://example.com/seal.webp', source: null },
  ] }] },
});
const snapshot = entries => createCatalogSnapshot({ summary, entries });
const changes = (previous, current) => diffCatalogSnapshots(snapshot(previous), snapshot(current));

// Catches backup announcements and hand-built routes that disagree with app sharing.
test('snapshots retain only installable replacements and canonical skin and preparation links', () => {
  const result = snapshot(fixture());
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.sequence, '42');
  assert.equal(result.version, '1001.14');
  assert.equal(result.contentSha256, 'a'.repeat(64));
  assert.equal(result.routes.length, 3);
  assert.deepEqual(result.routes.map(route => route.path).sort(), [
    '/heroes/1/1011-1013c1/',
    '/preparations/effects/recall/0/423013c1/',
    '/preparations/effects/recall/0/7cd041dd/',
  ]);
  assert.ok(result.routes.every(route => /^[a-f0-9]{64}$/.test(route.fingerprint)));
  assert.ok(!JSON.stringify(result).includes('.zip'), 'Snapshots must not retain archive download URLs');
  assert.ok(result.routes.some(route => route.name === 'Big Seal' && route.image === 'https://example.com/big.webp'));
});

// Catches order- or timestamp-sensitive fingerprints and repeated announcement decisions.
test('catalog timestamps and reordering do not create announcements', () => {
  const previous = fixture();
  const current = structuredClone(previous);
  current['heroes.json'].heroes[0].skins.reverse();
  current['preparations.json'].types[0].items.reverse();
  current['preparations.json'].types[0].items[1].source.upgrades.reverse();
  current.updatedAt = '2030-01-01T00:00:00Z';
  current['heroes.json'].heroes[0].skins[2].updatedAt = 999;
  assert.deepEqual(changes(previous, current), []);
  assert.deepEqual(diffCatalogSnapshots(snapshot(previous), snapshot(previous)), []);
});

// Catches treating archive-dependent preparation IDs as new target identity.
test('an archive-only preparation change is updated with only its changed original', () => {
  const previous = fixture();
  const current = structuredClone(previous);
  current['preparations.json'].types[0].items[0].source.upgrades[0].archive = 'https://example.com/seal-v2.zip';
  const result = changes(previous, current);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Seal');
  assert.equal(result[0].status, 'updated');
  assert.equal(result[0].originals.length, 1);
  assert.equal(result[0].originals[0].name, 'Classic');
  assert.equal(result[0].originals[0].status, 'updated');
  assert.notEqual(result[0].originals[0].path, '/preparations/effects/recall/0/423013c1/');
});

// Catches collapsing explicit variants or including an exact unchanged variant.
test('a new explicit variant preserves its name and image while old exact variants stay quiet', () => {
  const previous = fixture();
  const current = structuredClone(previous);
  current['preparations.json'].types[0].items[0].source.upgrades.push({
    targetId: 99740, targetCategory: 0, name: 'Golden Seal', image: 'https://example.com/gold.webp',
    archive: 'https://example.com/gold.zip',
  });
  const result = changes(previous, current);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Golden Seal');
  assert.equal(result[0].image, 'https://example.com/gold.webp');
  assert.equal(result[0].status, 'new');
  assert.equal(result[0].originals.length, 1);
});

// Catches matching variants by array position instead of exact previous fingerprints.
test('changing one variant among several leaves every exact variant unannounced', () => {
  const previous = fixture();
  const current = structuredClone(previous);
  const upgrades = current['preparations.json'].types[0].items[0].source.upgrades;
  upgrades[1].archive = 'https://example.com/big-v2.zip';
  upgrades.reverse();
  const result = changes(previous, current);
  assert.deepEqual(result.map(change => [change.name, change.status]), [['Big Seal', 'updated']]);
});

// Catches duplicate target messages and reporting unchanged originals for a target.
test('changed skin originals with the same replacement target combine into one announcement', () => {
  const previous = fixture();
  const current = structuredClone(previous);
  current['heroes.json'].heroes[0].skins[0].source.upgrades[0].archive = 'https://example.com/honor-v2.zip';
  current['heroes.json'].heroes[0].skins[1].source.upgrades.push({ targetSkinId: 1013, targetCategory: 1, archive });
  const result = changes(previous, current);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Honor');
  assert.equal(result[0].status, 'updated');
  assert.deepEqual(result[0].originals.map(original => [original.name, original.path, original.status]).sort(), [
    ['Burning Bow', '/heroes/1/1012-1013c1/', 'new'],
    ['Moonlight Archer', '/heroes/1/1011-1013c1/', 'updated'],
  ]);
});

// Catches name- or ID-only grouping across different preparation types.
test('same-name preparation targets in different types remain separate', () => {
  const current = fixture();
  const other = structuredClone(current['preparations.json'].types[0]);
  other.key = 'effects.elimination';
  other.name = 'Elimination';
  current['preparations.json'].types.push(other);
  const result = diffCatalogSnapshots(null, snapshot(current));
  assert.equal(result.length, 5);
  assert.equal(new Set(result.map(change => change.key)).size, 5);
  assert.deepEqual(result.filter(change => change.name === 'Seal').map(change => change.group).sort(), ['Elimination', 'Recall']);
});

// Catches preview-only or insecure archive entries being mistaken for installable changes.
test('blank and unusable archive replacements are excluded even when preview routes exist', () => {
  const current = fixture();
  current['heroes.json'].heroes[0].skins[0].source.upgrades[0].archive = '';
  const upgrades = current['preparations.json'].types[0].items[0].source.upgrades;
  upgrades[0].archive = '';
  upgrades[1].archive = 'http://example.com/big.zip';
  assert.deepEqual(snapshot(current).routes, []);
  assert.deepEqual(diffCatalogSnapshots(snapshot(fixture()), snapshot(current)), []);
});

// Catches stale or invented identities against the current signed publication fixture.
test('the real signed catalog snapshot uses only existing canonical projected replacement routes', async () => {
  const delivery = await loadPublicContentDelivery('public/content', { publicKeys: {
    'nutcx-content-2026-01': 'MCowBQYDK2VwAyEA/nqv5THRQyePGH/ARBmY+hzQygbVq34lhQXzf/YmYpk=',
  } });
  const result = createCatalogSnapshot(delivery);
  const projected = projectItems(delivery.entries);
  const replacements = projected.filter(item => item.filter !== 'original' && item.availableToApply !== false);
  assert.ok(result.routes.length > 0);
  assert.equal(result.routes.length, replacements.length);
  const canonicalPaths = new Set(replacements.map(item => item.path));
  assert.ok(result.routes.every(route => canonicalPaths.has(route.path)));
  assert.deepEqual(diffCatalogSnapshots(result, result), []);
});

const embedChars = embed => [embed.title, embed.description, embed.footer?.text, embed.author?.name,
  ...(embed.fields ?? []).flatMap(field => [field.name, field.value])].reduce((total, value) => total + (value?.length ?? 0), 0);

// Catches repeated pings, limit overflow, repeated targets, and local attachment index resets.
test('large publications stay within Discord limits and ping exactly once across all batches', () => {
  const publication = Array.from({ length: 17 }, (_, index) => ({
    key: `skin:1:${index}`, kind: 'skin', group: 'Miya'.repeat(1000), name: `Target ${index} `.repeat(1000),
    image: 'https://example.com/target.webp', status: index % 2 ? 'new' : 'updated',
    originals: Array.from({ length: 60 }, (_, source) => ({
      key: `source:${source}`, name: `Source ${source} `.repeat(500), image: 'https://example.com/source.webp',
      path: `/heroes/1/${source}-${index}/`, status: 'new',
    })),
  }));
  const result = buildDiscordBatches(publication, { version: '1001.14', sequence: '42' });
  assert.ok(result.length > 1);
  assert.equal(result.flatMap(batch => batch.embeds).length, 17);
  assert.equal(result.map(batch => batch.content).join('\n').match(/@everyone/g)?.length, 1);
  assert.deepEqual(result[0].allowed_mentions, { parse: ['everyone'] });
  assert.ok(result.slice(1).every(batch => batch.allowed_mentions.parse.length === 0));
  let imageIndex = 0;
  for (const batch of result) {
    assert.ok(batch.content.length <= 2000);
    assert.ok(batch.embeds.length <= 5);
    assert.ok(batch.embeds.reduce((total, embed) => total + embedChars(embed), 0) <= 6000);
    for (const embed of batch.embeds) {
      assert.ok(embed.title.length <= 256);
      assert.ok(embed.description.length <= 4096);
      assert.ok(embed.fields.length <= 25);
      assert.ok(embed.fields.every(field => field.name.length <= 256 && field.value.length <= 1024));
      assert.ok(embed.fields.some(field => field.value.includes('https://nutcx.github.io/heroes/1/')));
      assert.equal(embed.image.url, `attachment://comparison-${imageIndex++}.webp`);
      assert.match(embed.url, /^https:\/\/nutcx\.github\.io\//);
    }
  }
});

// Catches malicious mentions or a publisher name gaining control of authored markdown.
test('untrusted names cannot inject Discord mentions or markdown links', () => {
  const result = buildDiscordBatches([{
    key: 'one', kind: 'preparation', group: '@here', name: '@everyone <@123> <@&456> [click](https://evil.test) **bold**',
    image: '', status: 'new', originals: [{ key: 'source', name: '@everyone `code` ||secret||', image: '',
      path: '/preparations/effects/recall/0/423013c1/', status: 'new' }],
  }], { version: '@everyone', sequence: '<@789>' });
  assert.equal(result.length, 1);
  const payload = result[0];
  assert.equal(JSON.stringify(payload).match(/@everyone/g)?.length, 1);
  assert.ok(!JSON.stringify(payload.embeds).includes('@here'));
  assert.ok(!/<@!?\d+>|<@&\d+>/.test(JSON.stringify(payload)));
  assert.ok(!payload.embeds[0].title.includes('[click]('));
  assert.ok(!payload.embeds[0].title.includes('**bold**'));
  assert.ok(payload.embeds[0].fields[0].value.includes('https://nutcx.github.io/preparations/effects/recall/0/423013c1/'));
});

// Catches duplicate target payloads when callers combine change lists.
test('duplicate target changes produce one embed containing their different changed originals', () => {
  const target = { key: 'same-target', kind: 'skin', group: 'Miya', name: 'Honor', image: '', status: 'new' };
  const result = buildDiscordBatches([
    { ...target, originals: [{ key: 'first', name: 'Moonlight Archer', image: '', path: '/heroes/1/1011-1013c1/', status: 'new' }] },
    { ...target, status: 'updated', originals: [{ key: 'second', name: 'Burning Bow', image: '', path: '/heroes/1/1012-1013c1/', status: 'updated' }] },
  ], { version: '1001.14', sequence: '42' });
  assert.equal(result.flatMap(batch => batch.embeds).length, 1);
  assert.ok(result[0].embeds[0].title.startsWith('Updated:'));
  assert.ok(result[0].embeds[0].fields[0].value.includes('Moonlight Archer'));
  assert.ok(result[0].embeds[0].fields[0].value.includes('Burning Bow'));
});

// Catches treating legacy archive-dependent route IDs as new effects.
test('legacy preparation archive changes retain stable pair identity and updated status', () => {
  const previous = { 'heroes.json': { heroes: [] }, 'preparations.json': { preparations: [
    { preparationId: 1, name: 'Recall', image: 'https://example.com/classic.webp', archive: 'https://example.com/backup.zip',
      items: [{ name: 'Seal', image: 'https://example.com/seal.webp', archive: 'https://example.com/seal.zip' }] },
  ] } };
  const current = structuredClone(previous);
  current['preparations.json'].preparations[0].items[0].archive = 'https://example.com/seal-v2.zip';
  const result = changes(previous, current);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Seal');
  assert.equal(result[0].status, 'updated');
  assert.match(result[0].originals[0].path, /^\/preparations\/1\/[a-f0-9]{8}\/$/);
});

// Catches accepting a route that injects external or noncanonical destinations.
test('Discord payload links reject routes outside canonical skin and preparation pages', () => {
  const change = { key: 'one', kind: 'skin', group: 'Miya', name: 'Honor', image: '', status: 'new',
    originals: [{ key: 'source', name: 'Moonlight Archer', image: '', path: '//evil.test/', status: 'new' }] };
  assert.throws(() => buildDiscordBatches([change], { version: '1001.14', sequence: '42' }), /canonical catalog route/);
});

test('an unchanged publication produces no Discord payload', () => {
  assert.deepEqual(buildDiscordBatches([], { version: '1001.14', sequence: '42' }), []);
});
