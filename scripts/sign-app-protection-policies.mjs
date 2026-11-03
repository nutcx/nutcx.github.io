import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGES, signPolicy, verifyPolicy } from './app-protection-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const input = resolve(option('--input', join(root, 'config/app-protection-policies.json')));
const output = resolve(option('--output', join(root, 'public/content/protection')));
const verifyOnly = args.includes('--verify-only');
const previousRoot = option('--previous-root', null);
try {
  const source = JSON.parse(await readFile(input, 'utf8'));
  if (source.schemaVersion !== 1 || !Array.isArray(source.apps)
    || source.apps.length !== PACKAGES.length || new Set(source.apps.map(app => app.packageName)).size !== PACKAGES.length)
    throw new Error('Expected exactly the three supported app policies');
  let pem;
  if (!verifyOnly) {
    const path = option('--key-file', process.env.MOBA_POLICY_SIGNING_KEY_FILE);
    if (!path) throw new Error('Supply --key-file or MOBA_POLICY_SIGNING_KEY_FILE; keep the key outside this repository');
    pem = await readFile(resolve(path));
    await mkdir(output, { recursive: true });
  }
  // Verify the complete set before writing any output; no private key is copied.
  const prepared = [];
  for (const pkg of PACKAGES) {
    const payload = source.apps.find(app => app.packageName === pkg);
    if (!payload) throw new Error('Missing app policy');
    let previous = null;
    try { previous = verifyPolicy(await readFile(previousRoot
      ? join(resolve(previousRoot), 'protection', `${pkg}.json`) : join(output, `${pkg}.json`)), pkg); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const bytes = verifyOnly ? await readFile(join(output, `${pkg}.json`)) : signPolicy(payload, pem);
    const policy = verifyPolicy(bytes, pkg, previous);
    if (JSON.stringify(policy) !== JSON.stringify(payload)) throw new Error('Published policy differs from reviewed configuration');
    prepared.push({ pkg, bytes, revision: policy.revision });
  }
  if (!verifyOnly) for (const row of prepared) await writeFile(join(output, `${row.pkg}.json`), row.bytes);
  console.log(JSON.stringify({ mode: verifyOnly ? 'verified' : 'signed', policies: prepared.map(row => ({ package: row.pkg, revision: row.revision })) }));
} catch (error) {
  // Crypto errors can include input excerpts. Never print arbitrary signing-tool errors.
  console.error('App policy operation failed. Check the reviewed public configuration and local signing key.');
  process.exitCode = 1;
}
