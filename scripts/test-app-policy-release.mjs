import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { resolve, join, dirname, basename, sep } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { PACKAGES, verifyPolicy } from './app-protection-policy.mjs';
import { prepareRelease, planRelease, validateSeedPolicy, applyPolicyTransaction, SEEDS } from './app-policy-release.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const library = pathToFileURL(join(source, 'scripts/app-policy-release.mjs')).href;
const LOCK = 'refs/moba-app-policy/preparation';
const pretty = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function git(root, args, input, allowFailure = false) {
  const result = spawnSync('git', ['-C', root, ...args], { input, encoding: 'utf8' });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr); return result;
}
async function fixture(t, old = false) {
  const root = await fs.mkdtemp(join(tmpdir(), 'moba-policy-release-'));
  t.after(async () => {
    const resolved = resolve(root), temporaryRoot = resolve(tmpdir());
    assert.ok(resolved.startsWith(temporaryRoot + sep) && basename(resolved).startsWith('moba-policy-release-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const web = join(root, 'website'), app = join(root, 'client');
  await fs.mkdir(join(web, 'config'), { recursive: true });
  await fs.mkdir(join(web, 'public/content/protection'), { recursive: true });
  const seed = join(app, SEEDS[PACKAGES[0]]);
  await fs.mkdir(dirname(seed), { recursive: true });
  git(web, ['init', '--quiet']); git(app, ['init', '--quiet']);
  const apps = [];
  for (const pkg of PACKAGES) {
    const bytes = await fs.readFile(old ? join(source, 'scripts/fixtures/app-policy-release', pkg + '.revision1.json')
      : join(source, 'public/content/protection', pkg + '.json'));
    apps.push(verifyPolicy(bytes, pkg));
    await fs.writeFile(join(web, 'public/content/protection', pkg + '.json'), bytes);
    if (pkg === PACKAGES[0]) await fs.writeFile(seed, bytes);
  }
  const config = join(web, 'config/app-protection-policies.json');
  await fs.writeFile(config, pretty({ schemaVersion: 1, apps }));
  const release = apps[0].releases.at(-1);
  const settings = { websiteRoot: web, appRoot: app, packageName: PACKAGES[0], versionCode: release.versionCode,
    versionName: 'test', certificateSha256: release.certificateSha256, adSettings: release.adSettings,
    keyFile: join(root, 'absent-key.pem') };
  const files = [config, ...PACKAGES.map(pkg => join(web, 'public/content/protection', pkg + '.json')), seed];
  const snapshot = async (times = false) => Promise.all(files.map(async file => {
    const bytes = await fs.readFile(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    return [file, bytes?.toString('base64') ?? null, times && bytes ? (await fs.stat(file)).mtimeMs : null];
  }));
  return { root, web, app, config, seed, settings, files, snapshot, apps };
}

test('current release and version-name-only rebuilds are no-ops without a key', async t => {
  const f = await fixture(t), before = await f.snapshot(true);
  assert.equal((await prepareRelease(f.settings)).changed, false);
  assert.equal((await prepareRelease({ ...f.settings, versionName: 'renamed-only' })).changed, false);
  assert.deepEqual(await f.snapshot(true), before);
});
test('new version planning appends a release and preserves every old record and other app', async t => {
  const f = await fixture(t), current = JSON.parse(await fs.readFile(f.config));
  const before = structuredClone(current);
  const plan = planRelease(current, { ...f.settings, versionCode: f.settings.versionCode + 1 });
  assert.equal(plan.policy.revision, current.apps[0].revision + 1);
  assert.deepEqual(plan.policy.releases.slice(0, -1), current.apps[0].releases);
  assert.deepEqual(plan.next.apps.slice(1), current.apps.slice(1));
  assert.deepEqual(current, before);
});
test('certificate order does not create a policy revision', async t => {
  const f = await fixture(t);
  assert.equal((await prepareRelease({ ...f.settings, certificateSha256: [...f.settings.certificateSha256].reverse() })).changed, false);
});
test('an approved direct-distribution subset reuses the release policy', async t => {
  const f = await fixture(t), before = await f.snapshot(true);
  assert.equal((await prepareRelease({ ...f.settings, certificateSha256: [f.settings.certificateSha256[0]] })).changed, false);
  assert.deepEqual(await f.snapshot(true), before);
});
test('an existing version cannot silently acquire different SDK settings or certificates', async t => {
  const f = await fixture(t), before = await f.snapshot(true);
  await assert.rejects(prepareRelease({ ...f.settings, adSettings: { ...f.settings.adSettings,
    interstitial: 'ca-app-pub-4163787779715408/9999999999' } }), { code: 'existing' });
  await assert.rejects(prepareRelease({ ...f.settings, certificateSha256: ['a'.repeat(64)] }), { code: 'existing' });
  assert.deepEqual(await f.snapshot(true), before);
});
test('history limits fail explicitly without dropping or modifying previous records', async t => {
  const f = await fixture(t), current = JSON.parse(await fs.readFile(f.config));
  current.apps[0].releases = Array.from({ length: 128 }, (_, index) => ({ ...structuredClone(current.apps[0].releases[0]), versionCode: index + 1 }));
  const before = structuredClone(current);
  assert.throws(() => planRelease(current, { ...f.settings, versionCode: 129 }), { code: 'capacity' });
  assert.deepEqual(current, before);
});
test('unknown older codes and invalid values are rejected before writes', async t => {
  const f = await fixture(t), before = await f.snapshot(true);
  await assert.rejects(prepareRelease({ ...f.settings, versionCode: f.apps[0].releases[0].versionCode - 1 }), { code: 'historical' });
  for (const code of [0, -1, 1.5, 2147483648]) await assert.rejects(prepareRelease({ ...f.settings, versionCode: code }), { code: 'input' });
  assert.deepEqual(await f.snapshot(true), before);
});
test('a missing signing key causes no partial update for a new release', async t => {
  const f = await fixture(t), before = await f.snapshot(true);
  await assert.rejects(prepareRelease({ ...f.settings, versionCode: f.settings.versionCode + 1 }), { code: 'key' });
  assert.deepEqual(await f.snapshot(true), before);
});
test('an unrelated private key cannot sign a policy', async t => {
  const f = await fixture(t), before = await f.snapshot(true);
  const key = join(f.root, 'wrong-key.pem');
  await fs.writeFile(key, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  await assert.rejects(prepareRelease({ ...f.settings, versionCode: f.settings.versionCode + 1, keyFile: key }), { code: 'signing' });
  assert.deepEqual(await f.snapshot(true), before);
});
test('a signing key is refused inside a Git checkout', async t => {
  const f = await fixture(t), before = await f.snapshot(true);
  const key = join(f.web, 'wrong-key.pem');
  await fs.writeFile(key, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }));
  await assert.rejects(prepareRelease({ ...f.settings, versionCode: f.settings.versionCode + 1, keyFile: key }), { code: 'key' });
  assert.deepEqual(await f.snapshot(true), before);
});
test('missing or damaged app seeds are repaired from the verified current public file without signing', async t => {
  const f = await fixture(t);
  for (const mode of ['missing', 'damaged']) {
    if (mode === 'missing') await fs.unlink(f.seed); else await fs.writeFile(f.seed, 'damaged');
    const result = await prepareRelease(f.settings);
    assert.equal(result.changed, true); assert.equal(result.policyUpdated, false);
    assert.deepEqual(await fs.readFile(f.seed), await fs.readFile(join(f.web, 'public/content/protection', PACKAGES[0] + '.json')));
  }
});
test('check mode validates but does not repair or sign', async t => {
  const f = await fixture(t);
  assert.equal((await prepareRelease({ ...f.settings, checkOnly: true })).checked, true);
  await fs.writeFile(f.seed, 'old seed'); const before = await f.snapshot(true);
  await assert.rejects(prepareRelease({ ...f.settings, checkOnly: true }), { code: 'pending' });
  await assert.rejects(prepareRelease({ ...f.settings, checkOnly: true, versionCode: f.settings.versionCode + 1 }), { code: 'pending' });
  assert.deepEqual(await f.snapshot(true), before);
});
test('a stale website checkout cannot downgrade a newer verified app seed', async t => {
  const f = await fixture(t, true);
  await fs.copyFile(join(source, 'public/content/protection', PACKAGES[0] + '.json'), f.seed);
  const before = await f.snapshot(true);
  await assert.rejects(prepareRelease(f.settings), { code: 'stale' });
  assert.deepEqual(await f.snapshot(true), before);
});
test('older verified seeds upgrade to the current reviewed policy without a key', async t => {
  const f = await fixture(t);
  await fs.copyFile(join(source, 'scripts/fixtures/app-policy-release', PACKAGES[0] + '.revision1.json'), f.seed);
  const result = await prepareRelease(f.settings);
  assert.equal(result.changed, true); assert.equal(result.policyUpdated, false);
  assert.deepEqual(await fs.readFile(f.seed), await fs.readFile(join(f.web, 'public/content/protection', PACKAGES[0] + '.json')));
});
test('equal-revision payload collisions are rejected after signature verification', async t => {
  const f = await fixture(t), policy = f.apps[0];
  validateSeedPolicy(policy, structuredClone(policy));
  assert.throws(() => validateSeedPolicy(policy, { ...policy, releases: [] }), { code: 'configuration' });
});
test('modified public files or duplicate configuration keys are rejected without changing the seed', async t => {
  const f = await fixture(t), seed = await fs.readFile(f.seed);
  const publicFile = join(f.web, 'public/content/protection', PACKAGES[0] + '.json');
  const original = await fs.readFile(publicFile);
  await fs.writeFile(publicFile, Buffer.alloc(70_000));
  await assert.rejects(prepareRelease(f.settings));
  assert.deepEqual(await fs.readFile(f.seed), seed);
  await fs.writeFile(publicFile, original);
  const text = await fs.readFile(f.config, 'utf8');
  await fs.writeFile(f.config, text.replace('"schemaVersion": 1,', '"schemaVersion": 0, "schemaVersion": 1,'));
  await assert.rejects(prepareRelease(f.settings));
  assert.deepEqual(await fs.readFile(f.seed), seed);
});

async function transactionFixture(t) {
  const f = await fixture(t, true);
  const afterPolicy = await fs.readFile(join(source, 'public/content/protection', PACKAGES[0] + '.json'));
  const policy = verifyPolicy(afterPolicy, PACKAGES[0]);
  const afterConfig = JSON.parse(await fs.readFile(f.config)); afterConfig.apps[0] = policy;
  const publicFile = join(f.web, 'public/content/protection', PACKAGES[0] + '.json');
  const pairs = [['config', f.config, pretty(afterConfig)], ['policy', publicFile, afterPolicy], ['seed', f.seed, afterPolicy]];
  const journal = { schemaVersion: 1, nonce: randomUUID(), packageName: PACKAGES[0], appRoot: f.app,
    entries: await Promise.all(pairs.map(async ([kind, file, after]) => ({ kind,
      before: (await fs.readFile(file)).toString('base64'), after: after.toString('base64') }))) };
  const journalPath = git(f.web, ['rev-parse', '--path-format=absolute', '--git-path', 'moba-app-policy-pending.json']).stdout.trim();
  const release = policy.releases.at(-1);
  return { ...f, journal, journalPath, pairs, settings: { ...f.settings, versionCode: release.versionCode,
    certificateSha256: release.certificateSha256, adSettings: release.adSettings } };
}
test('a write failure restores every previous file', async t => {
  const f = await transactionFixture(t), before = await f.snapshot();
  await assert.rejects(applyPolicyTransaction(f.web, f.journalPath, f.journal,
    { afterWrite() { throw new Error('simulated IO failure'); } }), /simulated IO failure/);
  assert.deepEqual(await f.snapshot(), before);
  await assert.rejects(fs.stat(f.journalPath), { code: 'ENOENT' });
});
async function interrupt(f) {
  const input = join(f.root, 'transaction.json'); await fs.writeFile(input, pretty(f.journal));
  const code = `import {readFile} from 'node:fs/promises'; import {applyPolicyTransaction} from ${JSON.stringify(library)};
    const [root,journal,input]=process.argv.slice(1); await applyPolicyTransaction(root,journal,JSON.parse(await readFile(input)),{afterWrite(){process.exit(73)}});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.web, f.journalPath, input], { encoding: 'utf8' });
  assert.equal(result.status, 73, result.stderr);
}
test('an interrupted multi-file transaction completes safely on the next preparation', async t => {
  const f = await transactionFixture(t); await interrupt(f);
  assert.deepEqual(await fs.readFile(f.config), f.pairs[0][2]);
  assert.notDeepEqual(await fs.readFile(f.seed), f.pairs[2][2]);
  const result = await prepareRelease(f.settings);
  assert.equal(result.recovered, true); assert.equal(result.policyUpdated, false);
  for (const [, file, after] of f.pairs) assert.deepEqual(await fs.readFile(file), after);
  await assert.rejects(fs.stat(f.journalPath), { code: 'ENOENT' });
});
test('check mode leaves an interrupted transaction untouched', async t => {
  const f = await transactionFixture(t); await interrupt(f); const before = await f.snapshot(true);
  await assert.rejects(prepareRelease({ ...f.settings, checkOnly: true }), { code: 'pending' });
  assert.deepEqual(await f.snapshot(true), before); assert.ok(await fs.stat(f.journalPath));
});
test('an unrelated edit after interruption is preserved for review', async t => {
  const f = await transactionFixture(t); await interrupt(f);
  await fs.writeFile(f.seed, 'manual change'); const before = await f.snapshot(true);
  await assert.rejects(prepareRelease(f.settings), { code: 'journal' });
  assert.deepEqual(await f.snapshot(true), before); assert.ok(await fs.stat(f.journalPath));
});
test('dead local lock owners are recovered with compare-and-swap; live owners are not removed', async t => {
  const f = await fixture(t);
  const exited = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
  const writeOwner = pid => {
    const oid = git(f.web, ['hash-object', '-w', '--stdin'], JSON.stringify({ schemaVersion: 1, host: hostname(), pid })).stdout.trim();
    git(f.web, ['update-ref', LOCK, oid]); return oid;
  };
  writeOwner(Number(exited.stdout.trim()));
  assert.equal((await prepareRelease(f.settings)).changed, false);
  assert.notEqual(git(f.web, ['show-ref', '--verify', LOCK], undefined, true).status, 0);
  const live = writeOwner(process.pid), before = await f.snapshot(true);
  await assert.rejects(prepareRelease({ ...f.settings, lockTimeoutMs: 20 }), { code: 'lock' });
  assert.equal(git(f.web, ['show-ref', '--hash', '--verify', LOCK]).stdout.trim(), live);
  assert.deepEqual(await f.snapshot(true), before);
});
test('CLI errors never echo supplied secret-like text', () => {
  const sentinel = 'PRIVATE_KEY_MATERIAL_MUST_NOT_BE_PRINTED';
  const result = spawnSync(process.execPath, [join(source, 'scripts/prepare-app-policy-release.mjs'),
    '--version-code', '1', '--version-code', sentinel], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel));
});
