# Modern preparation compatibility fixture

`preparations.json` is shared with the Flutter Owner Admin fixture at
`nutcracker-admin/test/fixtures/legacy-preparation-export/preparations.json`.
The website's independent Node projector must produce the same old-client encrypted bytes as Dart:

- Size: 576 bytes
- SHA-256: `ce5209079a34b8b18d9452becb68e1820cd003632b3dcfce1ed8e183a08de3ab`
- Four parent groups and six child routes

Cases include same-ID official/custom effects, a custom source with a self route, repeated target
variants, UTF-8 names, explicit name/image overrides, empty image/archive values, catalog-only records,
empty source routes, and a future type represented as unknown. This is synthetic test data outside
the deployed `public/` tree, not a frozen production snapshot.
