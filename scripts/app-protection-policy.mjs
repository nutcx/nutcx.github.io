import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const POLICY_KEY_ID = 'moba-app-policy-2026-01';
export const POLICY_PUBLIC_KEY = 'MCowBQYDK2VwAyEA3LJvZ2sCispvSoJFWRNwBTxqAxdyOgy/sODVwbwDWf8=';
export const PACKAGES = Object.freeze(['com.nutcx.tools', 'com.kaizokuo.gfx', 'com.mobalauncher.io']);
const DOMAIN = Buffer.from('moba-app-protection-policy-v1\n', 'ascii');
const MAX_FILE = 64 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function fields(value, expected) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Expected policy object');
  requireValue(Object.keys(value).sort().join(',') === [...expected].sort().join(','), 'Unexpected policy fields');
}
function positive(value, maximum = Number.MAX_SAFE_INTEGER) {
  requireValue(Number.isSafeInteger(value) && value > 0 && value <= maximum, 'Invalid policy integer');
}
function canonicalJson(bytes, maximum) {
  requireValue(bytes.length > 0 && bytes.length <= maximum, 'Oversized policy');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(text);
  // Production files are canonical. This also rejects duplicate keys and trailing data.
  requireValue(JSON.stringify(value) === text.trimEnd(), 'Noncanonical policy JSON');
  return value;
}
function base64(value) {
  requireValue(typeof value === 'string', 'Expected policy encoding');
  const bytes = Buffer.from(value, 'base64');
  requireValue(bytes.toString('base64') === value, 'Noncanonical policy encoding');
  return bytes;
}
export function adSettingsHash(settings) {
  requireValue(settings && typeof settings === 'object' && !Array.isArray(settings), 'Invalid ad settings');
  const keys = Object.keys(settings).sort();
  requireValue(keys.length >= 2 && keys.length <= 5 && keys.includes('appId'), 'Missing ad settings');
  const allowed = new Set(['appId', 'banner', 'interstitial', 'appOpen', 'rewardedInterstitial']);
  let canonical = 'moba-ad-settings-v1\n';
  for (const key of keys) {
    requireValue(allowed.has(key) && typeof settings[key] === 'string', 'Unknown ad setting');
    requireValue((key === 'appId' ? /^ca-app-pub-\d{16}~\d{10}$/ : /^ca-app-pub-\d{16}\/\d{10}$/).test(settings[key]), 'Invalid ad identifier');
    canonical += `${key}=${settings[key]}\n`;
  }
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
export function validatePolicy(payload, expectedPackage) {
  fields(payload, ['schemaVersion', 'packageName', 'revision', 'releases']);
  requireValue(payload.schemaVersion === 1 && payload.packageName === expectedPackage && PACKAGES.includes(expectedPackage), 'Wrong policy app/schema');
  positive(payload.revision);
  requireValue(Array.isArray(payload.releases) && payload.releases.length > 0 && payload.releases.length <= 128, 'Invalid policy releases');
  const versions = new Set();
  for (const release of payload.releases) {
    fields(release, ['versionCode', 'certificateSha256', 'adSettings', 'adSettingsSha256']);
    positive(release.versionCode, 2147483647);
    requireValue(!versions.has(release.versionCode), 'Repeated release'); versions.add(release.versionCode);
    const pins = release.certificateSha256;
    requireValue(Array.isArray(pins) && pins.length > 0 && pins.length <= 64 && new Set(pins).size === pins.length
      && pins.every(value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)), 'Invalid certificate hashes');
    requireValue(release.adSettingsSha256 === adSettingsHash(release.adSettings), 'Ad settings hash mismatch');
  }
  return payload;
}
function signedBytes(keyId, payload) {
  return Buffer.concat([DOMAIN, Buffer.from(`${keyId}\n`, 'ascii'), payload]);
}
export function signPolicy(payload, privatePem) {
  validatePolicy(payload, payload.packageName);
  const key = createPrivateKey(privatePem);
  const actualPublic = createPublicKey(key).export({ type: 'spki', format: 'der' });
  requireValue(actualPublic.toString('base64') === POLICY_PUBLIC_KEY, 'Signing key does not match policy publisher');
  const data = Buffer.from(JSON.stringify(payload));
  requireValue(data.length <= 32 * 1024, 'Oversized policy payload');
  const envelope = { keyId: POLICY_KEY_ID, payload: data.toString('base64'),
    signature: sign(null, signedBytes(POLICY_KEY_ID, data), key).toString('base64') };
  return Buffer.from(`${JSON.stringify(envelope)}\n`);
}
export function verifyPolicy(bytes, expectedPackage, previous = null) {
  const envelope = canonicalJson(bytes, MAX_FILE);
  fields(envelope, ['keyId', 'payload', 'signature']);
  requireValue(envelope.keyId === POLICY_KEY_ID, 'Unknown policy publisher');
  const payload = base64(envelope.payload), signature = base64(envelope.signature);
  requireValue(payload.length <= 32 * 1024 && signature.length === 64, 'Invalid signed policy size');
  const key = createPublicKey({ key: Buffer.from(POLICY_PUBLIC_KEY, 'base64'), type: 'spki', format: 'der' });
  requireValue(verify(null, signedBytes(envelope.keyId, payload), key, signature), 'Invalid policy signature');
  const policy = validatePolicy(canonicalJson(payload, 32 * 1024), expectedPackage);
  if (previous) {
    requireValue(policy.revision >= previous.revision, 'Policy rollback');
    if (policy.revision === previous.revision)
      requireValue(JSON.stringify(policy) === JSON.stringify(previous), 'Conflicting policy revision');
  }
  return policy;
}
