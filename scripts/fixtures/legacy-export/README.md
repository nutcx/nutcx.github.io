# Legacy wire fixtures

These are validation fixtures, not public files. They are outside `public/` and never form part of
the deployed content tree.

`document.json` and the five numeric `.mlbytes` files are copied unchanged from
`Fuego-GFX/admin/src/test/resources/legacy-export/`. The Java `LegacyContentExporterTest` and Python
`tools/content_release/tests/test_legacy.py` use these same historical wire fixtures. They cover UTF-8,
multi-byte string lengths, backup routes, other upgrade sources, and same-ID custom categories.

The small schema-3 preparation fixture checks the historical binary decoder layout independently.
It is not production preparation data and is not a frozen publication baseline. Current Owner Admin
projects the modern Preparations & Effects catalog into that same layout on each content publication.
