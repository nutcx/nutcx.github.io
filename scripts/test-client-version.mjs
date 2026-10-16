import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_CLIENT_VERSION_HINT_BYTES,
  MAX_CLIENT_VERSION_RESPONSE_BYTES,
  fetchClientVersionHint,
  parseClientVersionHint,
  validateClientVersionHint,
} from "./client-version.mjs";
import { refreshClientVersion } from "./refresh-client-version.mjs";

const ZONE = "807216349"; // Synthetic fixture, not a user's account or production configuration.
const CHECKED_AT = "2026-10-16T16:00:00.000Z";
const HINT = Object.freeze({
  schemaVersion: 1,
  resourceRoot: "res_version5",
  channel: "and_usa",
  clientVersion: "2.2.16.1232.1",
  resourceVersion: "1232.1",
  checkedAt: CHECKED_AT,
});
const now = () => new Date(CHECKED_AT);
const answer = (value = { Code: "0", ClientVersion: HINT.clientVersion }, init = {}) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "client-version-test-"));
  try { await run({ root, outputPath: join(root, "clientversion.json") }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("POSTs an empty body to the exact HTTPS service and derives the trailing version", async () => {
  let called = 0;
  const hint = await fetchClientVersionHint({ zoneId: ZONE, now, fetchImpl: async (url, options) => {
    called += 1;
    assert.equal(url.origin, "https://loginclientversion.ml.youngjoygame.com:30022");
    assert.equal(url.pathname, "/get_clientversion");
    assert.deepEqual([...url.searchParams], [["channel", "and_usa"], ["zoneid", ZONE]]);
    assert.equal(options.method, "POST");
    assert.equal(options.body, "");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.headers["Accept-Encoding"], "identity");
    assert.ok(options.signal instanceof AbortSignal);
    return answer();
  } });
  assert.equal(called, 1);
  assert.deepEqual(hint, HINT);
  assert.equal(Object.hasOwn(hint, "zoneid"), false);
});

test("supports a configured channel and a numeric success code", async () => {
  const hint = await fetchClientVersionHint({ zoneId: ZONE, channel: "and_usa_lite", now,
    fetchImpl: async (url) => {
      assert.equal(url.searchParams.get("channel"), "and_usa_lite");
      return answer({ Code: 0, ClientVersion: "2.2.16.1232.20" });
    } });
  assert.equal(hint.channel, "and_usa_lite");
  assert.equal(hint.resourceVersion, "1232.20");
});

test("an unset zone makes no request and supplies no default version", async () => {
  for (const zoneId of [undefined, ""]) {
    assert.equal(await fetchClientVersionHint({ zoneId,
      fetchImpl: () => { throw new Error("Must not fetch"); } }), null);
  }
});

test("invalid request inputs fail before a network request", async () => {
  for (const input of [
    { zoneId: " 3095" }, { zoneId: "3095&x=1" }, { zoneId: "a" }, { zoneId: 3095 },
    { zoneId: "1".repeat(11) }, { zoneId: ZONE, channel: "and_usa&zoneid=1" },
    { zoneId: ZONE, channel: "" }, { zoneId: ZONE, channel: "a".repeat(65) },
  ]) {
    await assert.rejects(fetchClientVersionHint({ ...input,
      fetchImpl: () => { assert.fail("Invalid inputs must not reach fetch"); } }),
    { message: "Client version hint is unavailable." });
  }
});

test("rejects missing and unsuccessful service codes without substituting a version", async () => {
  for (const value of [null, [], {}, { Code: "-101" }, { Code: false }, { Code: "00" },
    { Code: 0 }, { Code: 0, ClientVersion: null }, { Code: 0, ClientVersion: 1232.1 }]) {
    await assert.rejects(fetchClientVersionHint({ zoneId: ZONE, now,
      fetchImpl: async () => answer(value) }), { message: "Client version hint is unavailable." });
  }
});

test("rejects malformed and noncanonical versions", async () => {
  for (const clientVersion of ["1232.1", "2.2.16.1232.1_high", "2.2.16.1232.1\n", "2..1232.1",
    "2.2.16.01232.1", "2.2.16.-1.0", "2.2.16.1232.1/Art", "1.".repeat(40) + "1"]) {
    await assert.rejects(fetchClientVersionHint({ zoneId: ZONE, now,
      fetchImpl: async () => answer({ Code: "0", ClientVersion: clientVersion }) }));
  }
});

test("rejects non-200, redirects, HTML and malformed UTF-8/JSON responses", async () => {
  for (const response of [
    answer(undefined, { status: 503 }), answer(undefined, { status: 302 }),
    new Response("<html>error</html>", { headers: { "content-type": "text/html" } }),
    new Response("{"), new Response(new Uint8Array([0xff])), new Response(""),
  ]) {
    await assert.rejects(fetchClientVersionHint({ zoneId: ZONE, now,
      fetchImpl: async () => response }));
  }
});

test("rejects oversized declared or streamed bodies and incomplete declared bodies", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_CLIENT_VERSION_RESPONSE_BYTES + 1)); },
    cancel() { cancelled = true; },
  });
  for (const response of [
    new Response("{}", { headers: { "content-length": String(MAX_CLIENT_VERSION_RESPONSE_BYTES + 1) } }),
    new Response(stream),
    new Response("{}", { headers: { "content-length": "20" } }),
    new Response("{}", { headers: { "content-length": "x" } }),
  ]) {
    await assert.rejects(fetchClientVersionHint({ zoneId: ZONE, now,
      fetchImpl: async () => response }));
  }
  assert.equal(cancelled, true);
});

test("bounds the entire request including a response that never arrives", { timeout: 1000 }, async () => {
  let signal;
  await assert.rejects(fetchClientVersionHint({ zoneId: ZONE, timeoutMillis: 10,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("Sensitive URL must not escape")), { once: true });
      });
    } }), { message: "Client version hint is unavailable." });
  assert.equal(signal.aborted, true);
});

test("bounds and cancels a stalled response body", { timeout: 1000 }, async () => {
  let cancelled = false;
  await assert.rejects(fetchClientVersionHint({ zoneId: ZONE, timeoutMillis: 10,
    fetchImpl: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }));
  assert.equal(cancelled, true);
});

test("published hints require the exact contract, a matching version and canonical UTC time", () => {
  assert.deepEqual(parseClientVersionHint(Buffer.from(JSON.stringify(HINT))), HINT);
  for (const hint of [
    { ...HINT, schemaVersion: 2 }, { ...HINT, resourceRoot: "res_version5cn" },
    { ...HINT, resourceVersion: "1232.2" }, { ...HINT, checkedAt: "2026-10-16T16:00:00+00:00" },
    { ...HINT, checkedAt: "2026-02-30T16:00:00.000Z" }, { ...HINT, zoneid: ZONE },
  ]) assert.throws(() => validateClientVersionHint(hint));
  assert.throws(() => parseClientVersionHint(Buffer.alloc(MAX_CLIENT_VERSION_HINT_BYTES + 1)));
  assert.throws(() => parseClientVersionHint(Buffer.from([0xff])));
});

test("publishes only checked data and logs no zone, query or response body", async () => fixture(async ({ root, outputPath }) => {
  const logs = [];
  const status = await refreshClientVersion({ outputPath,
    env: { MLBB_VERSION_ZONE_ID: ZONE }, now, log: (line) => logs.push(line),
    fetchImpl: async () => answer() });
  assert.equal(status, "available");
  assert.deepEqual(parseClientVersionHint(await readFile(outputPath)), HINT);
  assert.deepEqual(await readdir(root), ["clientversion.json"]);
  assert.deepEqual(logs, ["Client version hint refreshed."]);
  assert.equal((await readFile(outputPath, "utf8")).includes(ZONE), false);
}));

test("no-zone builds remove previous generated data and continue without making a request", async () => fixture(async ({ outputPath }) => {
  await writeFile(outputPath, JSON.stringify(HINT));
  const logs = [];
  assert.equal(await refreshClientVersion({ outputPath, env: {}, log: (line) => logs.push(line),
    fetchImpl: () => assert.fail("Zone is not configured") }), "not_configured");
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  assert.deepEqual(logs, ["Client version lookup is not configured; no hint is published."]);
}));

test("failed upstream refreshes remove previous data and never echo sensitive errors", async () => fixture(async ({ outputPath }) => {
  await writeFile(outputPath, JSON.stringify(HINT));
  const logs = [];
  assert.equal(await refreshClientVersion({ outputPath,
    env: { MLBB_VERSION_ZONE_ID: ZONE }, log: (line) => logs.push(line),
    fetchImpl: async (url) => { throw new Error(`Private request ${url}`); } }), "unavailable");
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  assert.deepEqual(logs, ["Client version hint unavailable; deployment continues without a hint."]);
  assert.equal(logs.join("\n").includes(ZONE), false);
  assert.equal(logs.join("\n").includes("zoneid"), false);
}));
