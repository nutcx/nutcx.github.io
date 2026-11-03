# Signed app configuration policies

The website serves one signed policy per app at
`/content/protection/{package}.json`. These are public configuration files, with
approved signing-certificate SHA-256 fingerprints and version-specific AdMob
settings. They authenticate the published settings; they do not attest that a
client displayed an ad or enforce access to public archives.

`config/app-protection-policies.json` is the reviewed source. Its app policy
revisions are independent of Android version codes and catalog versions. Every
release record binds an exact version code to its certificates and SDK settings.
Keep older supported release records when adding a new one.

To publish an update:

1. Edit the applicable app's records and increment its policy revision.
2. Set `MOBA_POLICY_SIGNING_KEY_FILE` to the dedicated local Ed25519 PEM key,
   outside this repository, or pass `--key-file` explicitly.
3. Run `node scripts/sign-app-protection-policies.mjs`, then
   `pnpm test:app-protection` and the website test suite.
4. Review and publish the three files under `public/content/protection/` through
   the normal website deployment. Never commit the private key.
5. For a new Android release, copy its newly signed file into that app's
   `assets/app-protection-policy.json`. Its asset-contract test checks the current
   version-code binding. The existing signed catalog publication is unchanged.

CI validates signatures, the exact public-file allowlist, reviewed source values
and monotonic revisions relative to the prior website tree. The three apps pin
the dedicated public key; changing a public key file on this website cannot
change an installed app's trust. A new publisher key requires an app update.

Clients refresh in the background and retain verified cached/bundled settings
offline. Network or signature failures do not erase good state. Policies cannot
disable the independent compiled checks, and recovery remains available.
The Owner/Content Admin UI and its content-signing key are separate from this
dedicated policy publication workflow.
