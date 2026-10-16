# Client version lookup

The Pages build can publish `https://nutcx.github.io/content/clientversion.json` as a
small, optional version-service hint. It is generated before Astro builds the site,
using the existing push, manual and six-hour scheduled deployment workflow.
The generated file is ignored by Git and is not a new signed catalog publication.

In this repository's **Settings → Secrets and variables → Actions**, configure:

| Setting | Location | Purpose |
| --- | --- | --- |
| `MLBB_VERSION_ZONE_ID` | Repository secret (recommended), or repository variable | Zone used by the version service; a secret takes precedence. |
| `MLBB_VERSION_CHANNEL` | Repository variable | APK channel; defaults to `and_usa` when omitted. |

The workflow sends an HTTPS POST with an empty body to the fixed game version-service
endpoint. Channel and zone are query parameters, but neither request URLs nor zone
values are written to logs. The request and complete response body share a 15-second
deadline; responses are bounded to 16 KiB. Redirects, non-success HTTP or service codes,
malformed JSON/UTF-8, incomplete bodies and invalid version strings are rejected.
No game credentials or publisher signing key are required.

Successful output has exactly these fields:

```json
{
  "schemaVersion": 1,
  "resourceRoot": "res_version5",
  "channel": "and_usa",
  "clientVersion": "2.2.16.1232.1",
  "resourceVersion": "1232.1",
  "checkedAt": "2026-10-16T16:00:00.000Z"
}
```

The client version is a canonical numeric dotted string of 3–8 components, at most
64 characters. The resource version is its last two components; it is never a fixed
fallback value. `checkedAt` is the successful fetch time in UTC using the exact
`YYYY-MM-DDTHH:mm:ss.SSSZ` format. No zone ID or upstream response extras are published.
Site validation permits only a regular, non-symlink hint file of at most 4 KiB and
independently validates its shape, timestamp and version consistency.

Each refresh first removes any existing local hint. With no configured zone or when
the upstream request fails, the file remains absent and the website deployment
continues. No stale placeholder, fabricated version or previous success is stamped
with a new timestamp. A local filesystem error prevents packaging potentially stale
output rather than silently leaving it behind.

Clients may consult this hint only when the installed game's resource version cannot
be determined locally. A readable installed version always takes priority, and an
individual missing resource must not silently switch versions. The service reports a
candidate version, not proof of the installed version, a recognized channel or CDN
resource availability. Clients enforce freshness and verify the candidate's game
metadata before restoring resources; a missing or invalid hint supplies no fallback.
The original signed manifest/configuration schema and its signatures are unchanged.

Run the isolated tests with `pnpm test:client-version`; the content-delivery suite also
checks that this optional file does not weaken the signed catalog's directory rules.
