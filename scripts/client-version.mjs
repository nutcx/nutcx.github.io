/** Version-service metadata is a recovery hint, never an installed-version assertion. */
export const CLIENT_VERSION_NAME = "clientversion.json";
export const MAX_CLIENT_VERSION_HINT_BYTES = 4096;
export const MAX_CLIENT_VERSION_RESPONSE_BYTES = 16 * 1024;
export const CLIENT_VERSION_TIMEOUT_MILLIS = 15_000;

const ENDPOINT = "https://loginclientversion.ml.youngjoygame.com:30022/get_clientversion";
const CHANNEL = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLIENT_VERSION = /^(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){2,7}$/;
const FIELDS = ["schemaVersion", "resourceRoot", "channel", "clientVersion", "resourceVersion", "checkedAt"];

function unavailable() {
  // Never include the request URL, zone, response body, or underlying exception.
  return new Error("Client version hint is unavailable.");
}

function resourceVersion(clientVersion) {
  if (typeof clientVersion !== "string" || clientVersion !== clientVersion.trim() || clientVersion.length > 64
      || !CLIENT_VERSION.test(clientVersion)) throw unavailable();
  return clientVersion.split(".").slice(-2).join(".");
}

export function validateClientVersionHint(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== FIELDS.length
      || FIELDS.some((key) => !Object.hasOwn(value, key))
      || value.schemaVersion !== 1 || value.resourceRoot !== "res_version5"
      || typeof value.channel !== "string" || value.channel !== value.channel.trim() || !CHANNEL.test(value.channel)
      || value.resourceVersion !== resourceVersion(value.clientVersion)
      || typeof value.checkedAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.checkedAt)) {
    throw unavailable();
  }
  const instant = new Date(value.checkedAt);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value.checkedAt) throw unavailable();
  return Object.freeze({
    schemaVersion: 1,
    resourceRoot: "res_version5",
    channel: value.channel,
    clientVersion: value.clientVersion,
    resourceVersion: value.resourceVersion,
    checkedAt: value.checkedAt,
  });
}

export function parseClientVersionHint(bytes) {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIENT_VERSION_HINT_BYTES) throw unavailable();
  try {
    return validateClientVersionHint(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    throw unavailable();
  }
}

async function responseBody(response, signal) {
  const declaredText = response.headers.get("content-length");
  const declared = declaredText === null ? null : Number(declaredText);
  if (declaredText !== null && (!/^(0|[1-9][0-9]*)$/.test(declaredText)
      || !Number.isSafeInteger(declared) || declared === 0
      || declared > MAX_CLIENT_VERSION_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw unavailable();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const chunks = [];
  let count = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      count += part.value.byteLength;
      if (count > MAX_CLIENT_VERSION_RESPONSE_BYTES) throw unavailable();
      chunks.push(part.value);
    }
    if (count === 0 || declared !== null && count !== declared) throw unavailable();
    return Buffer.concat(chunks, count);
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function fetchClientVersionHint({
  zoneId,
  channel = "and_usa",
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMillis = CLIENT_VERSION_TIMEOUT_MILLIS,
} = {}) {
  if (zoneId === undefined || zoneId === "") return null;
  if (typeof zoneId !== "string" || zoneId !== zoneId.trim() || !/^[0-9]{1,10}$/.test(zoneId)
      || typeof channel !== "string" || channel !== channel.trim() || !CHANNEL.test(channel)
      || !Number.isInteger(timeoutMillis) || timeoutMillis < 1 || timeoutMillis > 30_000) throw unavailable();

  const url = new URL(ENDPOINT);
  url.searchParams.set("channel", channel);
  url.searchParams.set("zoneid", zoneId);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(unavailable());
    }, timeoutMillis);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(url, {
        method: "POST",
        body: "",
        headers: { Accept: "application/json", "Accept-Encoding": "identity" },
        redirect: "error",
        credentials: "omit",
        signal: controller.signal,
      });
      if (response.status !== 200 || response.headers.get("content-type")?.toLowerCase().startsWith("text/html")) {
        await response.body?.cancel().catch(() => {});
        throw unavailable();
      }
      const raw = await responseBody(response, controller.signal);
      const answer = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      if (answer === null || typeof answer !== "object" || Array.isArray(answer)
          || answer.Code !== "0" && answer.Code !== 0) throw unavailable();
      return validateClientVersionHint({
        schemaVersion: 1,
        resourceRoot: "res_version5",
        channel,
        clientVersion: answer.ClientVersion,
        resourceVersion: resourceVersion(answer.ClientVersion),
        checkedAt: now().toISOString(),
      });
    })(), deadline]);
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
