# Public content delivery contract

The website hosts one signed production pointer and immutable content payloads under
`public/content/`. The initial publication has sequence `1` and points to the unchanged,
already-signed `1001.5` document. Future content releases must use a version greater than
`1001.5`; `1002.0` is the recommended next version.

```text
public/content/
|-- manifest.json
|-- manifest.sig
`-- versions/
    `-- <release>.<revision>/
        `-- Document.mlbytes
```

`manifest.json` is UTF-8 JSON no larger than 64 KiB. It has exactly these root fields:

```text
schemaVersion:       1
publicationSequence: positive signed 64-bit integer
channel:             "production"
publishedAt:         canonical UTC Instant string
content:             { version, path, sha256, sizeBytes }
client:              { policy, config, features }
```

The content version is canonical `<positive-u32>.<u32>`. Its path is relative to `public/content/` and must
be exactly `versions/<version>/Document.mlbytes`. SHA-256 is 64 lowercase hexadecimal characters;
the declared size is 1 through 41,943,040 bytes. Publishing a new manifest must never replace an
existing version path with different bytes.

No other public content files are permitted. The root allowlist is exactly `manifest.json`,
`manifest.sig`, and `versions/`; each canonical version directory contains exactly one regular,
non-symlink `Document.mlbytes` file. Raw JSON databases, temporary files, sidecars, and nested assets
make validation fail.

`client.policy` embeds the existing ClientPolicy schema without additions or omissions. It includes
the policy ID/revision, mode, presentation fields, application-version fields, active window, and
optional HTTPS actions. Mode-specific constraints still apply: for example, `NORMAL` has no
presentation, window, or actions, while update modes require an update version and primary action.

`client.config` embeds the existing ClientConfig schema: schema version, config ID/revision,
original resource root, and one to eight unique normalized CDN origins. Cleartext HTTP remains
limited to the four approved MLBB CDN hosts. `client.features` contains at most 64 boolean flags;
keys are 1-64 publication-safe ASCII characters and may not contain `..`.

`manifest.sig` is the standard MLBSIG v1 Ed25519 block. The signature input is, in order:

1. ASCII `MLBYTES-MANIFEST-V1`
2. one zero byte
3. the exact `manifest.json` bytes
4. the MLBSIG prefix through its UTF-8 key ID

The Android client verifies this detached signature before parsing JSON. Host validation likewise
requires a trusted public key whose key ID matches the signature block.

The host validator also verifies the embedded MLBSIG signature on the referenced `Document.mlbytes`
before parsing its directory. It then enforces MLBytes format 1.0, schema 3, the exact manifest content
version, minimum app version code 11 or newer, the complete three-entry document profile, bounded
offsets and sizes, decompression, and each entry's SHA-256 digest.

## Validation and publication order

Run the self-contained fixture suite:

```powershell
node scripts/test-public-content-manifest.mjs
```

Validate staged release files with one or more trusted Ed25519 X.509/SPKI public keys:

```powershell
node scripts/validate-public-content-manifest.mjs public/content `
  --previous-root path/to/previous/public/content `
  --public-key publisher-key-id=BASE64_X509_SPKI_DER
```

The transition validator accepts an unchanged delivery. Any changed manifest must have a strictly
higher publication sequence. Content versions cannot roll back; a reused content version must retain
the exact same path, size, and digest. Policy and config revisions cannot roll back, and their meaning
cannot change without increasing the corresponding revision. Every old version file must remain
byte-for-byte identical, and the only permitted addition is the version file selected by the new
manifest. The Pages workflow extracts the pre-push Git tree and applies these checks before deployment.

The validator also rejects duplicate or extra JSON fields, unsafe paths, malformed policy/config data,
untrusted or invalid signatures, symlinked paths, size mismatches, and SHA-256 mismatches. Fixtures
are created only in the operating system's temporary directory.

Release tooling should write the immutable `Document.mlbytes` first, then generate and sign the
manifest from those exact bytes. Deploy the manifest/signature pair only after validation succeeds.
Serve versioned payloads with immutable caching; serve `manifest.json` and `manifest.sig` with
revalidation so clients can discover a new publication sequence.
