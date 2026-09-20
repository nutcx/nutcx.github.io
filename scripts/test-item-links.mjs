import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { decodeBundle, documentUrl, projectItems, skinPath, skinFilter } from '../src/lib/catalog.mjs';

const skin = { skinId: 1011, category: 0, name: 'Moonlight Archer', landscape: 'https://example.com/miya.webp', source: { backupArchive: 'https://example.com/miya.zip', upgrades: [] } };
const prep = { preparationId: 1, name: 'Recall', image: 'https://example.com/recall.webp', archive: 'https://example.com/recall.zip', items: [
  { name: 'One', image: 'https://example.com/1.webp', archive: 'https://example.com/1.zip' },
  { name: 'Two', image: 'https://example.com/2.webp', archive: 'https://example.com/2.zip' },
] };
const fixture = { 'heroes.json': { heroes: [{ heroId: 1, skins: [skin] }] }, 'preparations.json': { preparations: [prep] } };
assert.equal(documentUrl(''), 'https://raw.githubusercontent.com/nutcx/app-content/main/channels/preparations-v4/Document.mlbytes');
assert.equal(documentUrl('https://raw.githubusercontent.com/nutcx/app-content/main/Document.mlbytes'),
  'https://raw.githubusercontent.com/nutcx/app-content/main/Document.mlbytes');
assert.equal(documentUrl('https://raw.githubusercontent.com/nutcx/app-content/main/channels/preparations-v4/Document.mlbytes'),
  'https://raw.githubusercontent.com/nutcx/app-content/main/channels/preparations-v4/Document.mlbytes');
for (const invalid of [
  ' ', 'http://raw.githubusercontent.com/nutcx/app-content/main/Document.mlbytes',
  'https://example.com/nutcx/app-content/main/Document.mlbytes',
  'https://raw.githubusercontent.com/other/app-content/main/Document.mlbytes',
  'https://raw.githubusercontent.com/nutcx/app-content/preparations-v4/Document.mlbytes',
  'https://raw.githubusercontent.com/nutcx/app-content/main/versions/1001.4/assets/Document.mlbytes',
  'https://raw.githubusercontent.com/nutcx/app-content/main/Document.mlbytes?preview=1',
  'https://raw.githubusercontent.com/nutcx/app-content/main/Document.mlbytes#fragment',
  'https://user@raw.githubusercontent.com/nutcx/app-content/main/Document.mlbytes',
  'https://raw.githubusercontent.com/nutcx/app-content/main/../Document.mlbytes',
]) assert.throws(() => documentUrl(invalid), /Invalid Document URL override/);
assert.equal(skinPath(1, 1011, 0, 1013, 0), '/heroes/1/1011-1013/');
assert.equal(skinPath(1, 1011, 0, 1013, 1), '/heroes/1/1011-1013c1/');
assert.equal(skinPath(1, 1011, 1, 1013, 2), '/heroes/1/1011c1-1013c2/');
const original = projectItems(fixture);
assert.equal(original[0].path, '/heroes/1/1011/');
assert.equal(original[0].id, '1c958d925da574895fe95e312d532a17d503b2b29fb015b0696771d24237a7d7');
prep.items.reverse(); prep.items[0].name = 'Renamed';
assert.deepEqual(projectItems(fixture).map(x => x.id).sort(), original.map(x => x.id).sort());
assert.ok(original.every(x => !('archive' in x)), 'Preview projection must omit archive downloads');
const sha = value => createHash('sha256').update(value).digest('hex');
const v4 = { 'heroes.json': { heroes: [] }, 'preparations.json': {
  preparationSchemaVersion: 4,
  types: [{ key: 'effects.recall', name: 'Recall', items: [
    { category: 0, id: 0, name: 'Classic', image: 'https://example.com/classic.webp', source: {
      backupArchive: 'https://example.com/backup.zip', upgrades: [
        { targetCategory: 0, targetId: 99740, archive: 'https://example.com/seal.zip' },
        { targetCategory: 0, targetId: 99740, name: 'Big Seal', image: 'https://example.com/big.webp', archive: 'https://example.com/big.zip' },
      ],
    } },
    { category: 0, id: 99740, name: 'Seal', image: 'https://example.com/seal.webp', source: null },
    { category: 0, id: 7, name: 'Unpublished', image: 'https://example.com/unpublished.webp', source: {
      backupArchive: '', upgrades: [
        { targetCategory: 0, targetId: 99740, archive: '' },
      ],
    } },
  ] }],
} };
const v4Items = projectItems(v4);
assert.equal(v4Items.length, 5);
const backupKey = 'v4:effects.recall:0:0:backup';
const firstVariant = sha('https://example.com/seal.zip\0Seal\0https://example.com/seal.webp').slice(0, 32);
const secondVariant = sha('https://example.com/big.zip\0Big Seal\0https://example.com/big.webp').slice(0, 32);
const firstKey = `v4:effects.recall:0:0:target:0:99740:${firstVariant}`;
const secondKey = `v4:effects.recall:0:0:target:0:99740:${secondVariant}`;
assert.deepEqual(v4Items.slice(0, 3).map(item => item.id), [sha(backupKey), sha(firstKey), sha(secondKey)]);
assert.deepEqual(v4Items.slice(0, 3).map(item => item.path),
  [backupKey, firstKey, secondKey].map(key => `/preparations/0/${sha(key).slice(0, 8)}/`));
assert.equal(v4Items[2].name, 'Big Seal');
assert.equal(v4Items[2].image, 'https://example.com/big.webp');
assert.ok(v4Items.every(item => item.group === 'Recall' && !('archive' in item)));
assert.ok(v4Items.slice(0, 3).every(item => item.availableToApply === true));
const missingBackupKey = 'v4:effects.recall:0:7:backup';
const missingVariant = sha('\0Seal\0https://example.com/seal.webp').slice(0, 32);
const missingUpgradeKey = `v4:effects.recall:0:7:target:0:99740:${missingVariant}`;
assert.deepEqual(v4Items.slice(3).map(item => item.id), [sha(missingBackupKey), sha(missingUpgradeKey)]);
assert.deepEqual(v4Items.slice(3).map(item => item.path),
  [missingBackupKey, missingUpgradeKey].map(key => `/preparations/7/${sha(key).slice(0, 8)}/`));
assert.ok(v4Items.slice(3).every(item => item.availableToApply === false
  && item.description.includes('Not available to apply') && !('archive' in item)));
assert.throws(() => projectItems({ ...v4, 'preparations.json': {
  ...v4['preparations.json'], types: [{ ...v4['preparations.json'].types[0],
    items: v4['preparations.json'].types[0].items.slice(0, 1) }],
} }), /Missing Preparation target/);
const assetlinks = JSON.parse(readFileSync('dist/.well-known/assetlinks.json', 'utf8'));
assert.equal(assetlinks[0].target.package_name, 'com.nutcx.tools');
assert.match(assetlinks[0].target.sha256_cert_fingerprints[0], /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
const friendly = readFileSync(`dist${original[0].path}index.html`, 'utf8');
assert.ok(friendly.includes('Moonlight Archer'));
const html = readFileSync(`dist/items/${original[0].id}/index.html`, 'utf8');
assert.ok(html.includes('property="og:image"') && html.includes('landscape.webp'));
assert.ok(html.includes('https://nutcx.github.io' + original[0].path));
assert.ok(html.includes('package=com.nutcx.tools') && html.includes('browser_fallback_url='));
const response = await fetch(documentUrl());
assert.ok(response.ok);
const signed = Buffer.from(await response.arrayBuffer());
const signedItems = projectItems(decodeBundle(signed));
assert.ok(signedItems.length > 0);
const missingArchiveItem = signedItems.find(item => item.kind === 'preparation' && item.availableToApply === false);
assert.ok(missingArchiveItem, 'The signed v4 catalog should include preview-only items');
const unavailableHtml = readFileSync(`dist${missingArchiveItem.path}index.html`, 'utf8');
assert.ok(unavailableHtml.includes('not available to apply in the app yet'));
assert.ok(unavailableHtml.includes('Open in NutCracker'));
assert.ok(!/https:\/\/[^"'\s<>]+\.zip(?:\?[^"'\s<>]*)?/.test(unavailableHtml),
  'Preview HTML must not expose archive downloads');
const tampered = Buffer.from(signed); tampered[100] ^= 1;
assert.throws(() => decodeBundle(tampered), /signature verification failed/);
assert.throws(() => decodeBundle(signed.subarray(0, signed.length - 1)), /Invalid signature block/);
console.log('Item checks passed: cross-platform IDs, reorder and rename stability, preview metadata, asset association, signed content and tamper rejection.');

assert.equal(skinFilter({ category: 0, type: 'Anime' }), 'official');
assert.equal(skinFilter({ category: 1, type: ' | Anime | Naruto' }), 'anime');
assert.equal(skinFilter({ category: 1, type: 'Custom | Anime' }), 'custom');
assert.equal(skinFilter({ category: 1 }), 'custom');
const roster = readFileSync('dist/heroes/index.html', 'utf8');
assert.ok(roster.includes('Miya') && roster.includes('href="/heroes/1/"'));
const heroPage = readFileSync('dist/heroes/1/index.html', 'utf8');
assert.ok(heroPage.includes('data-catalog-filter="anime"') && heroPage.includes('href="/heroes/1/1011/"'));
assert.ok(readFileSync('dist/preparations/index.html', 'utf8').includes('data-catalog-group'));
console.log('Catalog checks passed: classifications, hero names, browse routes and item navigation.');
