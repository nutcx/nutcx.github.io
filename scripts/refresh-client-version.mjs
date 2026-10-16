#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CLIENT_VERSION_NAME, fetchClientVersionHint } from "./client-version.mjs";

export async function refreshClientVersion({
  outputPath = resolve("public/content", CLIENT_VERSION_NAME),
  env = process.env,
  fetchImpl = globalThis.fetch,
  now,
  timeoutMillis,
  log = console.log,
} = {}) {
  // A failed refresh must never package a checked-in or previous generated hint as fresh.
  await rm(outputPath, { force: true });
  let hint;
  try {
    hint = await fetchClientVersionHint({
      zoneId: env.MLBB_VERSION_ZONE_ID,
      channel: env.MLBB_VERSION_CHANNEL || "and_usa",
      fetchImpl,
      now,
      timeoutMillis,
    });
  } catch {
    log("Client version hint unavailable; deployment continues without a hint.");
    return "unavailable";
  }
  if (hint === null) {
    log("Client version lookup is not configured; no hint is published.");
    return "not_configured";
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = resolve(dirname(outputPath), `.clientversion-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(hint)}\n`, { flag: "wx" });
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }
  log("Client version hint refreshed.");
  return "available";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await refreshClientVersion();
  } catch {
    // Local output failures must not publish a stale or partially written hint.
    console.error("Client version output could not be prepared safely.");
    process.exitCode = 1;
  }
}
