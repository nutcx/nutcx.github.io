import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeBundle, projectItems, skinPath } from '../src/lib/catalog.mjs';

const skin = { skinId: 1011, category: 0, name: 'Moonlight Archer', landscape: 'https://example.com/miya.webp', source: { backupArchive: 'https://example.com/miya.zip', upgrades: [] } };
const prep = { preparationId: 1, name: 'Recall', image: 'https://example.com/recall.webp', archive: 'https://example.com/recall.zip', items: [
  { name: 'One', image: 'https://example.com/1.webp', archive: 'https://example.com/1.zip' },
  { name: 'Two', image: 'https://example.com/2.webp', archive: 'https://example.com/2.zip' },
] };
const fixture = { 'heroes.json': { heroes: [{ heroId: 1, skins: [skin] }] }, 'preparations.json': { preparations: [prep] } };
assert.equal(skinPath(1, 1011, 0, 1013, 0), '/heroes/1/1011-1013/');
assert.equal(skinPath(1, 1011, 0, 1013, 1), '/heroes/1/1011-1013c1/');
assert.equal(skinPath(1, 1011, 1, 1013, 2), '/heroes/1/1011c1-1013c2/');
const original = projectItems(fixture);
assert.equal(original[0].path, '/heroes/1/1011/');
assert.equal(original[0].id, '1c958d925da574895fe95e312d532a17d503b2b29fb015b0696771d24237a7d7');
prep.items.reverse(); prep.items[0].name = 'Renamed';
assert.deepEqual(projectItems(fixture).map(x => x.id).sort(), original.map(x => x.id).sort());
assert.ok(original.every(x => !('archive' in x)), 'Preview projection must omit archive downloads');
const assetlinks = JSON.parse(readFileSync('dist/.well-known/assetlinks.json', 'utf8'));
assert.equal(assetlinks[0].target.package_name, 'com.nutcx.tools');
assert.match(assetlinks[0].target.sha256_cert_fingerprints[0], /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
const friendly = readFileSync(`dist${original[0].path}index.html`, 'utf8');
assert.ok(friendly.includes('Moonlight Archer'));
const html = readFileSync(`dist/items/${original[0].id}/index.html`, 'utf8');
assert.ok(html.includes('property="og:image"') && html.includes('landscape.webp'));
assert.ok(html.includes('https://nutcx.github.io' + original[0].path));
assert.ok(html.includes('package=com.nutcx.tools') && html.includes('browser_fallback_url='));
const response = await fetch('https://raw.githubusercontent.com/nutcx/app-content/main/Document.mlbytes');
assert.ok(response.ok);
const signed = Buffer.from(await response.arrayBuffer());
assert.ok(projectItems(decodeBundle(signed)).length > 0);
const tampered = Buffer.from(signed); tampered[100] ^= 1;
assert.throws(() => decodeBundle(tampered), /signature verification failed/);
assert.throws(() => decodeBundle(signed.subarray(0, signed.length - 1)), /Invalid signature block/);
console.log('Item checks passed: cross-platform IDs, reorder and rename stability, preview metadata, asset association, signed content and tamper rejection.');
