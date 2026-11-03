import { fileURLToPath } from 'node:url';
import { prepareRelease, PolicyReleaseError } from './app-policy-release.mjs';

try {
  const args = process.argv.slice(2);
  const values = new Map(), ads = Object.create(null);
  let checkOnly = false;
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === '--check') { if (checkOnly) throw new PolicyReleaseError('input'); checkOnly = true; continue; }
    if (!['--app-root', '--package', '--version-code', '--version-name', '--certificates', '--ad', '--key-file'].includes(name)
      || i + 1 >= args.length) throw new PolicyReleaseError('input');
    const value = args[++i];
    if (name === '--ad') {
      const separator = value.indexOf('=');
      if (separator <= 0 || Object.hasOwn(ads, value.slice(0, separator))) throw new PolicyReleaseError('input');
      ads[value.slice(0, separator)] = value.slice(separator + 1);
    } else {
      if (values.has(name)) throw new PolicyReleaseError('input'); values.set(name, value);
    }
  }
  const code = values.get('--version-code');
  if (!/^[1-9][0-9]*$/.test(code ?? '') || !values.get('--app-root') || !values.get('--package')) throw new PolicyReleaseError('input');
  const result = await prepareRelease({
    websiteRoot: fileURLToPath(new URL('../', import.meta.url)), appRoot: values.get('--app-root'),
    packageName: values.get('--package'), versionCode: Number(code), versionName: values.get('--version-name') ?? '',
    certificateSha256: (values.get('--certificates') ?? '').split(','), adSettings: ads,
    keyFile: values.get('--key-file'), checkOnly,
  });
  console.log(JSON.stringify(result));
} catch (error) {
  // Never print arbitrary crypto, filesystem or private-key parsing errors.
  console.error(error instanceof PolicyReleaseError ? error.message : 'Policy preparation failed. Check the reviewed configuration and dedicated local key, then retry.');
  process.exitCode = 1;
}
