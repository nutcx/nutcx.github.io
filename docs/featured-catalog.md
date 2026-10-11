# Featured catalog pages

Featured selections come from `client.features` in the same signed local
`public/content/manifest.json` that selects the catalog's `Document.mlbytes`.
The manifest, document signatures, and content hashes are verified before either
the flags or catalog entries are used. The website does not fetch an older
deployed catalog during a build.

- `/heroes/` shows featured skins across heroes.
- `/heroes/{id}/` shows only that hero's featured skins.
- `/preparations/` shows featured preparations.

Each destination appears once, with its exact original-to-replacement preview
links grouped under **Choose original**. Original images identify the available
choices; selecting one opens the existing preview page, not an automatic install.
Archive variants and source categories keep their existing canonical links.
The native disclosure works without JavaScript. Original search, categories,
counts, and sharing remain separate from Featured cards.

Keys match the client and Owner Admin: `featured.skin.{hero}.{category}.{id}`,
or `featured.preparation.` plus the first 32 hexadecimal characters of SHA-256
over `typeKey + NUL + category + NUL + id`. Only explicit `true` selections with
usable archives appear. The shared 24-card limit is applied before page filtering.
Empty sections are hidden; selecting a preparation in Owner Admin enables its
card on the next signed-content publication and Pages rebuild.

After `pnpm build`, run `pnpm test:featured`. The main test command and Pages CI
also run these checks. They cover identity collisions, variants, missing
archives, authenticated selections, tampering, rendered choices, and existing
item-specific app links.
