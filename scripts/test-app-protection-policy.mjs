import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PACKAGES, adSettingsHash, verifyPolicy, validatePolicy } from './app-protection-policy.mjs';

for (const pkg of PACKAGES) {
  test(`${pkg}: published signature, app binding and ad settings`, async () => {
    const bytes = await readFile(new URL(`../public/content/protection/${pkg}.json`, import.meta.url));
    const policy = verifyPolicy(bytes, pkg);
    assert.ok(policy.releases.length);
    for (const release of policy.releases) assert.equal(adSettingsHash(release.adSettings), release.adSettingsSha256);
    assert.throws(() => verifyPolicy(bytes, PACKAGES.find(other => other !== pkg)));
    const envelope = JSON.parse(bytes);
    envelope.signature = Buffer.alloc(64).toString('base64');
    assert.throws(() => verifyPolicy(Buffer.from(JSON.stringify(envelope)), pkg));
    assert.throws(() => verifyPolicy(bytes, pkg, { ...policy, revision: policy.revision + 1 }));
    assert.throws(() => verifyPolicy(bytes, pkg, { ...policy, releases: [] }));
  });
}
test('unknown publisher, duplicate envelope keys and oversized input are rejected', async () => {
  const bytes = await readFile(new URL('../public/content/protection/com.nutcx.tools.json', import.meta.url));
  const envelope = JSON.parse(bytes);
  assert.throws(() => verifyPolicy(Buffer.from(JSON.stringify({ ...envelope, keyId: 'other' })), PACKAGES[0]));
  assert.throws(() => verifyPolicy(Buffer.from(`{"keyId":"wrong",${bytes.toString().slice(1)}`), PACKAGES[0]));
  assert.throws(() => verifyPolicy(Buffer.alloc(65537), PACKAGES[0]));
});
test('release overlap, ad hash disagreement, empty pins and unknown settings are rejected', async () => {
  const bytes = await readFile(new URL('../public/content/protection/com.nutcx.tools.json', import.meta.url));
  const policy = verifyPolicy(bytes, PACKAGES[0]);
  const change = mutate => { const value = structuredClone(policy); mutate(value); assert.throws(() => validatePolicy(value, PACKAGES[0])); };
  change(value => value.releases.push(value.releases[0]));
  change(value => value.releases[0].adSettingsSha256 = '0'.repeat(64));
  change(value => value.releases[0].certificateSha256 = []);
  change(value => value.releases[0].adSettings.enabled = 'false');
});
