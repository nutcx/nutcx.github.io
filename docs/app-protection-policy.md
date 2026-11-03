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

## Automatic release preparation

The three Android applications run `prepareSignedAppPolicy` before their release
assets are merged. A normal production APK/AAB build therefore prepares the
matching signed policy and bundled seed automatically. NCT's hook is limited to
the `nutcxRelease` variant; other flavors and debug builds are not coupled to it.

The task supplies its resolved version code, approved certificate list and the
same SDK settings used by the application. A new code appends a record, preserves
all older records and increments only that application's policy revision. An
existing matching code is a no-op, including version-name-only rebuilds. An
approved certificate subset can reuse the record for direct-distribution builds;
the compiled local checks still limit that build's own trust. Different SDK values
or additional certificates for an already-recorded code require a version/configuration
review instead of silently rewriting historical records.
Existing format limits fail before writing; records are never pruned automatically.

Default checkout layout:

```text
GitHub/
  nutcx.github.io/
  Fuego-GFX/
  KaizokuGFX/
  MLBBReplacer/
```

Node and Git must be available locally. Another website checkout can be selected
with `-PappPolicyWebsiteDir=<path>` or `MOBA_POLICY_WEBSITE_DIR`; a Node executable
can be selected with `-PappPolicyNodeExecutable=<path>`. No network request is made,
including when Gradle runs with `--offline`.

For a new record, the key is selected from `-PappPolicySigningKeyFile=<path>`,
`MOBA_POLICY_SIGNING_KEY_FILE`, or the existing owner key at
`~/.nutcx-owner/keys/app-protection-policy-2026-01.pem`. It must be outside Git
checkouts and match the pinned publisher. It is never copied to output, logs,
application assets, or the website. No signing key is needed for an already
prepared code, seed-only repair, or verification-only CI.

The automatic task updates only the reviewed policy configuration, the affected
signed public policy and that application's seed. A Git compare-and-swap lock
serializes concurrent preparations. A local journal under Git metadata restores
failed writes or completes an interrupted transaction; unrelated manual edits
are preserved for review. A newer verified app seed is never downgraded to an
older website checkout, and equal-revision payload collisions are rejected.
The task never commits, pushes, deploys or changes app
versions or public changelogs.

When using source-freeze/signing helpers, prepare **before freezing**:

```text
Fuego-GFX:   gradlew.bat :app:prepareSignedAppPolicy
KaizokuGFX:  gradlew.bat :app:prepareSignedAppPolicy
MLBBReplacer: gradlew.bat :toolkit:prepareSignedAppPolicy
```

Then freeze the resulting source and build normally. The packaging hook runs
again as an idempotent check. CI can select `-PappPolicyMode=check` to require
already-prepared records without changing policy files or reading a private key.
Sync the website checkout before preparing a new release. Commit/push the changed
website policy files with the release; the existing Pages
workflow verifies and deploys them. Local preparation alone does not publish them.

This is developer tooling. Keep implementation details out of public app release
notes, including historical entries. Current beta artifacts do not need a rebuild
merely because the preparation tooling was added.

## Manual publication and recovery

To publish a deliberately reviewed manual update:

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
