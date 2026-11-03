import { promises as fs } from 'node:fs';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { hostname, homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { PACKAGES, adSettingsHash, signPolicy, verifyPolicy, validatePolicy } from './app-protection-policy.mjs';

export const SEEDS = Object.freeze({
  'com.nutcx.tools': 'app/src/nutcx/assets/app-protection-policy.json',
  'com.kaizokuo.gfx': 'app/src/main/assets/app-protection-policy.json',
  'com.mobalauncher.io': 'toolkit/src/main/assets/app-protection-policy.json',
});
const LOCK = 'refs/moba-app-policy/preparation';
const MAX_CONFIG = 1024 * 1024;
const MESSAGES = Object.freeze({
  input: 'Invalid release settings. Check the configured package, version code, certificates and SDK settings.',
  checkout: 'Use the website and app Git checkouts, and keep the policy assets inside their app checkout.',
  configuration: 'Reviewed policy configuration and signed public files disagree. Reconcile them before preparing a release.',
  existing: 'This version code already has different approved settings. Use a new version code or review the configuration.',
  historical: 'An unknown older version code cannot be added automatically. Check the selected app checkout and version.',
  capacity: 'Policy history has reached its format limit. Review retired release records before preparing another version; no records were dropped.',
  stale: 'The website policy checkout is older than the bundled app policy. Sync the website checkout before preparing this release.',
  key: 'A new policy needs the dedicated local signing key. Set MOBA_POLICY_SIGNING_KEY_FILE to a key outside the checkouts.',
  signing: 'Policy signing failed. Check the dedicated publisher key; its contents were not printed.',
  pending: 'The release policy is not prepared. Run prepareSignedAppPolicy in prepare mode before checking or freezing source.',
  lock: 'Another policy preparation is active. Retry when it finishes; an interrupted local owner is recovered automatically.',
  journal: 'An interrupted preparation conflicts with current files. Review the retained local journal before retrying.',
  write: 'Policy preparation did not finish. Retry to recover the local transaction before releasing a build.',
});
export class PolicyReleaseError extends Error {
  constructor(code) { super(MESSAGES[code] ?? MESSAGES.write); this.code = code; }
}
function need(condition, code = 'input') { if (!condition) throw new PolicyReleaseError(code); }
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => a === null ? b === null : b !== null && a.equals(b);
const pretty = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function inside(root, path) {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel);
}
function samePath(a, b) { return process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b); }
function git(root, args, input = undefined, allowFailure = false) {
  const result = spawnSync('git', ['-C', root, ...args], {
    input, encoding: 'utf8', maxBuffer: 2 * MAX_CONFIG, timeout: 10_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (!allowFailure) need(result.status === 0, 'checkout');
  return result;
}
async function checkout(path) {
  const root = await fs.realpath(resolve(path));
  const top = git(root, ['rev-parse', '--show-toplevel']).stdout.trim();
  need(samePath(root, await fs.realpath(top)), 'checkout');
  return root;
}
async function bounded(path, maximum, optional = false) {
  let file;
  try {
    const stat = await fs.lstat(path);
    need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, 'configuration');
    file = await fs.open(path, 'r');
    const data = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < data.length) {
      const read = await file.read(data, length, data.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    need(length <= maximum, 'configuration');
    return data.subarray(0, length);
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  } finally { if (file) await file.close(); }
}
function config(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
  const value = JSON.parse(text);
  // A machine-owned canonical source also rejects duplicate JSON keys.
  need(pretty(value).toString() === text && Object.keys(value).sort().join(',') === 'apps,schemaVersion'
    && value.schemaVersion === 1 && Array.isArray(value.apps) && value.apps.length === PACKAGES.length
    && new Set(value.apps.map(app => app.packageName)).size === PACKAGES.length, 'configuration');
  for (const pkg of PACKAGES) validatePolicy(value.apps.find(app => app.packageName === pkg), pkg);
  return value;
}
export function releaseSettings({ packageName, versionCode, versionName = '', certificateSha256, adSettings }) {
  need(PACKAGES.includes(packageName) && Number.isSafeInteger(versionCode) && versionCode > 0 && versionCode <= 2147483647);
  need(typeof versionName === 'string' && versionName.length <= 120 && !/[\x00-\x1f]/.test(versionName));
  need(Array.isArray(certificateSha256) && certificateSha256.length > 0 && certificateSha256.length <= 64);
  const pins = certificateSha256.map(value => typeof value === 'string' ? value.replaceAll(':', '').toLowerCase().trim() : '');
  need(pins.every(pin => /^[0-9a-f]{64}$/.test(pin)) && new Set(pins).size === pins.length);
  const ads = { ...adSettings };
  const hash = adSettingsHash(ads);
  return { packageName, versionCode, versionName, certificateSha256: pins, adSettings: ads, adSettingsSha256: hash };
}
export function planRelease(current, rawSettings) {
  const settings = releaseSettings(rawSettings);
  const next = structuredClone(current);
  const policy = next.apps.find(app => app.packageName === settings.packageName);
  need(policy, 'configuration'); validatePolicy(policy, settings.packageName);
  const existing = policy.releases.find(row => row.versionCode === settings.versionCode);
  if (existing) {
    need(settings.certificateSha256.every(pin => existing.certificateSha256.includes(pin))
      && existing.adSettingsSha256 === settings.adSettingsSha256, 'existing');
    return { next, policy, changed: false, settings };
  }
  need(settings.versionCode > Math.max(...policy.releases.map(row => row.versionCode)), 'historical');
  need(policy.releases.length < 128, 'capacity');
  policy.releases.push({ versionCode: settings.versionCode, certificateSha256: settings.certificateSha256,
    adSettings: settings.adSettings, adSettingsSha256: settings.adSettingsSha256 });
  policy.revision++;
  need(Buffer.byteLength(JSON.stringify(policy), 'utf8') <= 32 * 1024, 'capacity');
  validatePolicy(policy, settings.packageName);
  return { next, policy, changed: true, settings };
}
export function validateSeedPolicy(published, verifiedSeed) {
  if (!verifiedSeed) return;
  need(verifiedSeed.revision <= published.revision, 'stale');
  if (verifiedSeed.revision === published.revision)
    need(JSON.stringify(verifiedSeed) === JSON.stringify(published), 'configuration');
}
function ownerAlive(owner) {
  if (owner.host !== hostname()) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function acquire(root, timeout) {
  const owner = { schemaVersion: 1, pid: process.pid, host: hostname(), nonce: randomUUID(), started: Date.now() };
  const oid = git(root, ['hash-object', '-w', '--stdin'], JSON.stringify(owner)).stdout.trim();
  need(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid), 'lock');
  const deadline = Date.now() + timeout;
  for (;;) {
    if (git(root, ['update-ref', LOCK, oid, '0'.repeat(oid.length)], undefined, true).status === 0) {
      return () => need(git(root, ['update-ref', '-d', LOCK, oid], undefined, true).status === 0, 'lock');
    }
    const previous = git(root, ['show-ref', '--hash', '--verify', LOCK], undefined, true).stdout.trim();
    if (previous) {
      const data = git(root, ['cat-file', 'blob', previous]).stdout;
      need(data.length < 2048, 'lock');
      const held = JSON.parse(data);
      need(held.schemaVersion === 1 && Number.isSafeInteger(held.pid) && held.pid > 0 && typeof held.host === 'string', 'lock');
      if (!ownerAlive(held)) {
        // Compare-and-swap deletion cannot remove a different/new owner's lock.
        git(root, ['update-ref', '-d', LOCK, previous], undefined, true);
        continue;
      }
    }
    need(Date.now() < deadline, 'lock');
    await delay(50);
  }
}
async function targets(websiteRoot, appRoot, packageName) {
  need(PACKAGES.includes(packageName), 'journal');
  const root = await checkout(appRoot);
  const result = { config: join(websiteRoot, 'config/app-protection-policies.json'),
    policy: join(websiteRoot, 'public/content/protection', packageName + '.json'), seed: join(root, SEEDS[packageName]) };
  for (const [kind, file] of Object.entries(result)) {
    const base = kind === 'seed' ? root : websiteRoot;
    need(inside(base, file) && inside(base, await fs.realpath(dirname(file))), 'checkout');
    try { need(!(await fs.lstat(file)).isSymbolicLink(), 'checkout'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { files: result, appRoot: root };
}
async function replace(path, bytes, nonce) {
  const temporary = join(dirname(path), `.app-policy-${nonce}.tmp`);
  let file;
  try {
    file = await fs.open(temporary, 'wx', 0o600);
    await file.writeFile(bytes); await file.sync(); await file.close(); file = null;
    await fs.rename(temporary, path);
    need(equal(await bounded(path, Math.max(bytes.length, 1)), bytes), 'write');
  } finally {
    if (file) await file.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
function decode(value, maximum, nullable = false) {
  if (nullable && value === null) return null;
  need(typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4, 'journal');
  const bytes = Buffer.from(value, 'base64');
  need(bytes.toString('base64') === value && bytes.length <= maximum, 'journal'); return bytes;
}
async function checkedJournal(websiteRoot, data) {
  need(data.schemaVersion === 1 && /^[0-9a-f-]{36}$/.test(data.nonce) && Array.isArray(data.entries)
    && data.entries.length > 0 && data.entries.length <= 3, 'journal');
  const context = await targets(websiteRoot, data.appRoot, data.packageName);
  const entries = data.entries.map(row => {
    need(['config', 'policy', 'seed'].includes(row.kind), 'journal');
    const maximum = row.kind === 'config' ? MAX_CONFIG : 65536;
    return { kind: row.kind, path: context.files[row.kind], maximum,
      before: decode(row.before, maximum, true), after: decode(row.after, maximum) };
  });
  need(new Set(entries.map(row => row.kind)).size === entries.length && entries.some(row => row.kind === 'seed'), 'journal');
  const after = async kind => entries.find(row => row.kind === kind)?.after
    ?? await bounded(context.files[kind], kind === 'config' ? MAX_CONFIG : 65536);
  const reviewed = config(await after('config'));
  const policy = verifyPolicy(await after('policy'), data.packageName);
  need(JSON.stringify(policy) === JSON.stringify(reviewed.apps.find(app => app.packageName === data.packageName))
    && equal(await after('seed'), await after('policy')), 'journal');
  return entries;
}
async function states(entries) {
  const result = [];
  for (const row of entries) {
    const current = await bounded(row.path, row.maximum, true);
    need(equal(current, row.before) || equal(current, row.after), 'journal');
    result.push(current);
  }
  return result;
}
async function recover(websiteRoot, journalPath) {
  const raw = await bounded(journalPath, 4 * MAX_CONFIG, true);
  if (raw === null) return false;
  const journal = JSON.parse(raw);
  const entries = await checkedJournal(websiteRoot, journal);
  await states(entries); // Check every file before changing any file.
  for (let i = 0; i < entries.length; i++) {
    const row = entries[i];
    const current = await bounded(row.path, row.maximum, true);
    need(equal(current, row.before) || equal(current, row.after), 'journal');
    if (!equal(current, row.after)) await replace(row.path, row.after, journal.nonce);
    await fs.unlink(join(dirname(row.path), `.app-policy-${journal.nonce}.tmp`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  need((await states(entries)).every((bytes, index) => equal(bytes, entries[index].after)), 'journal');
  await fs.unlink(journalPath); return true;
}
// Exported for isolated failure/crash tests; the CLI offers no bypass or test mode.
export async function applyPolicyTransaction(websiteRoot, journalPath, journal, hooks = {}) {
  websiteRoot = await checkout(websiteRoot);
  const entries = await checkedJournal(websiteRoot, journal);
  await states(entries);
  await replace(journalPath, pretty(journal), randomUUID());
  try {
    for (const row of entries) {
      const current = await bounded(row.path, row.maximum, true);
      need(equal(current, row.before) || equal(current, row.after), 'journal');
      if (!equal(current, row.after)) await replace(row.path, row.after, journal.nonce);
      await hooks.afterWrite?.(row.kind);
    }
    need((await states(entries)).every((bytes, index) => equal(bytes, entries[index].after)), 'journal');
    await fs.unlink(journalPath);
  } catch (failure) {
    try {
      const current = await states(entries);
      for (let i = entries.length - 1; i >= 0; i--) {
        const row = entries[i];
        if (equal(current[i], row.before)) continue;
        if (row.before === null) await fs.unlink(row.path);
        else await replace(row.path, row.before, randomUUID());
      }
      await fs.unlink(journalPath);
    } catch { throw new PolicyReleaseError('journal'); }
    throw failure;
  }
}
export async function prepareRelease(options) {
  const websiteRoot = await checkout(options.websiteRoot);
  const settings = releaseSettings(options);
  const context = await targets(websiteRoot, options.appRoot, settings.packageName);
  const unlock = await acquire(websiteRoot, options.lockTimeoutMs ?? 30_000);
  const journalPath = git(websiteRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'moba-app-policy-pending.json']).stdout.trim();
  try {
    if (options.checkOnly) need(await bounded(journalPath, 4 * MAX_CONFIG, true) === null, 'pending');
    const recovered = options.checkOnly ? false : await recover(websiteRoot, journalPath);
    const beforeConfig = await bounded(context.files.config, MAX_CONFIG);
    const reviewed = config(beforeConfig);
    let currentBytes;
    for (const pkg of PACKAGES) {
      const bytes = await bounded(join(websiteRoot, 'public/content/protection', pkg + '.json'), 65536);
      const policy = verifyPolicy(bytes, pkg);
      need(JSON.stringify(policy) === JSON.stringify(reviewed.apps.find(app => app.packageName === pkg)), 'configuration');
      if (pkg === settings.packageName) currentBytes = bytes;
    }
    const plan = planRelease(reviewed, settings);
    const beforeSeed = await bounded(context.files.seed, 65536, true);
    let verifiedSeed = null;
    if (beforeSeed !== null) {
      try { verifiedSeed = verifyPolicy(beforeSeed, settings.packageName); }
      catch { /* A missing or invalid seed can be replaced by the reviewed signed policy. */ }
    }
    validateSeedPolicy(verifyPolicy(currentBytes, settings.packageName), verifiedSeed);
    if (options.checkOnly) {
      need(!plan.changed && equal(beforeSeed, currentBytes), 'pending');
      return { packageName: settings.packageName, versionCode: settings.versionCode, revision: plan.policy.revision, changed: false, recovered, checked: true };
    }
    let nextBytes = currentBytes;
    if (plan.changed) {
      let key;
      try {
        const keyPath = await fs.realpath(resolve(options.keyFile ?? process.env.MOBA_POLICY_SIGNING_KEY_FILE
          ?? join(homedir(), '.nutcx-owner/keys/app-protection-policy-2026-01.pem')));
        need(!inside(websiteRoot, keyPath) && !samePath(websiteRoot, keyPath)
          && !inside(context.appRoot, keyPath) && !samePath(context.appRoot, keyPath), 'key');
        const keyCheckout = git(dirname(keyPath), ['rev-parse', '--is-inside-work-tree'], undefined, true);
        need(keyCheckout.status !== 0 || keyCheckout.stdout.trim() !== 'true', 'key');
        key = await bounded(keyPath, 16384);
      } catch { throw new PolicyReleaseError('key'); }
      try {
        nextBytes = signPolicy(plan.policy, key);
        verifyPolicy(nextBytes, settings.packageName, verifyPolicy(currentBytes, settings.packageName));
      } catch { throw new PolicyReleaseError('signing'); }
      finally { key.fill(0); }
    }
    const changes = [
      { kind: 'config', before: beforeConfig, after: plan.changed ? pretty(plan.next) : beforeConfig },
      { kind: 'policy', before: currentBytes, after: nextBytes },
      { kind: 'seed', before: beforeSeed, after: nextBytes },
    ].filter(row => !equal(row.before, row.after));
    if (changes.length) {
      if (!changes.some(row => row.kind === 'seed')) changes.push({ kind: 'seed', before: beforeSeed, after: nextBytes });
      const journal = { schemaVersion: 1, nonce: randomUUID(), packageName: settings.packageName, appRoot: context.appRoot,
        entries: changes.map(row => ({ kind: row.kind, before: row.before?.toString('base64') ?? null, after: row.after.toString('base64') })) };
      await applyPolicyTransaction(websiteRoot, journalPath, journal, options.hooks);
    }
    return { packageName: settings.packageName, versionCode: settings.versionCode, revision: plan.policy.revision,
      changed: changes.length > 0, policyUpdated: plan.changed, recovered, sha256: sha(nextBytes) };
  } finally { unlock(); }
}
