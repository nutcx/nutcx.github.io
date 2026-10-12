# Public content delivery contract

The website hosts one signed production pointer and immutable content payloads under
`public/content/`. The initial publication has sequence `1` and points to the unchanged,
already-signed `1001.5` document. Future content releases must use a version greater than
`1001.5`; `1002.0` is the recommended next version.

```text
public/content/
|-- manifest.json
|-- manifest.sig
|-- legacy/                         (optional before its first publication)
|   |-- 533271041.mlbytes            (skins)
|   |-- 789276696.mlbytes            (skin tags)
|   |-- 674624113.mlbytes            (upgrade sources)
|   |-- 181462965.mlbytes            (upgrade routes)
|   `-- 819204176.mlbytes            (preparations and effects in the old row layout)
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

No other public content files are permitted. The root allowlist is `manifest.json`,
`manifest.sig`, `versions/`, and the optional `legacy/`; each canonical version directory contains exactly one regular,
non-symlink `Document.mlbytes` file. Raw JSON databases, temporary files, sidecars, and nested assets
make validation fail.

## Legacy compatibility files

Owner Admin generates all five `legacy/` files from the same authenticated canonical
`heroes.json`, `skin-tags.json`, and `preparations.json` entries used in the active `Document.mlbytes`. These are the old
binary row format: little-endian 32-bit integers, 7-bit-prefixed UTF-8 strings, and the historical
AES-128-CBC/PKCS7 wire encoding. That historical key is public compatibility data, not an
authentication or secrecy mechanism. Official category-0 skin IDs remain unchanged; other categories
use deterministic export-only aliases so old routes cannot join the wrong same-ID skin.

Preparations & Effects are projected into the old nested row layout: every effect with a source is
one parent row, and each of its upgrade routes is one child row. Catalog-only effects remain targets,
not invented parents. Parent IDs are stable export-only aliases: SHA-256 of the UTF-8 text
`preparation:<type-key>:<category>:<id>`, with the first big-endian 32 bits masked by `0x3fffffff`
and OR-ed with `0x40000000`. An alias collision fails publication rather than silently joining groups.
Names, images, backup archives, route order, repeated route variants, optional route name/image
overrides, and blank archive links are retained. Targets are resolved within their full type/category/ID
identity. Valid custom-category source owners and self routes are retained too.

Known parent types keep the original enum IDs: battle emote `0`, recall `1`, spawn `2`, elimination `3`,
notification `4`, and trail `5`. Radiant Kits and unfamiliar types use `-1` (unknown), and child rarity
tags use `-1`; a modern effect category is not a legacy rarity. The legacy file therefore does not
represent every modern field or reuse official effect IDs as globally unique parent IDs. Historical
schema-3 preparations also remain verifiable with their original IDs and unknown type/tag fields.
Shared compatibility fixtures are documented in `scripts/fixtures/legacy-export/README.md`.

No fields are added to the signed schema-1 manifest, which existing clients parse strictly.
Instead, host validation authenticates the active document, derives all five outputs, and
requires exact byte equality.
When `legacy/` is present it must contain all five approved regular files and nothing else. Each file
is bounded to 8 MiB plus one AES padding block. Missing, extra, symlinked, modified, or stale outputs
fail validation. Once published, the entire directory cannot be removed by a later transition.

Existing deployments without `legacy/` remain valid, permitting a safe first publication. Content
publications must generate all five companions together with the new document and signed pointer;
settings-only publications leave the companions unchanged. The aliases are mutable latest-content
endpoints, so they should be served with revalidation rather than immutable caching.

Hosting these files does not redirect already-installed clients that are hardcoded to a different
repository or URL. Those old endpoints are not rewritten by this website validation change.

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

## Website catalog consumer

The website builds its skin and Preparation previews from this same checked-out
delivery tree. `loadPublicContentDelivery` validates the manifest and the exact
referenced document with the pinned publisher key, then parses the already-verified
entry bytes. It does not reread an unverified copy, fetch the deployed manifest, or
fall back to an old `app-content` bundle. Malformed entry JSON, duplicate keys,
invalid UTF-8 and unsafe numeric IDs also fail the build.

Owner Admin's publication push to `main` triggers the existing Pages workflow, so
the generated catalog and its signed source deploy together. Preview projection

retains existing item identities, grouping, numeric aliases and retirement history;
it does not emit archive links or editable database JSON. The previous deployment's
`catalog-history.json` remains a separate input solely to preserve removed links,
not to supply active catalog data.

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
byte-for-byte identical, and the only permitted version-file addition is the document selected by the new
manifest. Legacy files are independently checked against that document.
The Pages workflow extracts the pre-push Git tree and applies these checks before deployment.

The validator also rejects duplicate or extra JSON fields, unsafe paths, malformed policy/config data,
untrusted or invalid signatures, symlinked paths, size mismatches, and SHA-256 mismatches. Fixtures
are created only in the operating system's temporary directory.

Release tooling should write the immutable `Document.mlbytes` first, then generate and sign the
manifest from those exact bytes. Deploy the manifest/signature pair only after validation succeeds.
Serve versioned payloads with immutable caching; serve `manifest.json` and `manifest.sig` with
revalidation so clients can discover a new publication sequence.
