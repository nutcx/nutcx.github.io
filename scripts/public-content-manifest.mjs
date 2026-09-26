import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

const MANIFEST_NAME = "manifest.json";
const SIGNATURE_NAME = "manifest.sig";
const MANIFEST_DOMAIN = Buffer.from("MLBYTES-MANIFEST-V1", "ascii");
const SIGNATURE_MAGIC = Buffer.from([0x4d, 0x4c, 0x42, 0x53, 0x49, 0x47, 0, 0]);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 40 * 1024 * 1024;
const MAX_KEY_ID_BYTES = 128;
const SIGNATURE_PREFIX_BYTES = 16;
const ED25519_SIGNATURE_BYTES = 64;
const MAX_SIGNED_64 = 9_223_372_036_854_775_807n;
const MAX_UNSIGNED_32 = 4_294_967_295n;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_VALUES = 4_096;
const APPROVED_HTTP_CDN_HOSTS = new Set([
  "edge-txcdn.ml.youngjoygame.com",
  "akmcdn.ml.youngjoygame.com",
  "pldtcdn.ml.youngjoygame.com",
  "wscdn.ml.youngjoygame.com",
]);

const ROOT_FIELDS = [
  "schemaVersion",
  "publicationSequence",
  "channel",
  "publishedAt",
  "content",
  "client",
];
const CONTENT_FIELDS = ["version", "path", "sha256", "sizeBytes"];
const CLIENT_FIELDS = ["policy", "config", "features"];
const POLICY_FIELDS = [
  "schemaVersion",
  "policyId",
  "revision",
  "mode",
  "title",
  "message",
  "minimumAppVersionCode",
  "latestVersionName",
  "dismissible",
  "startsAtEpochSeconds",
  "endsAtEpochSeconds",
  "primaryAction",
  "secondaryAction",
];
const CONFIG_FIELDS = [
  "schemaVersion",
  "configId",
  "revision",
  "originalResourceRoot",
  "originalCdnRoots",
];

export class PublicContentManifestError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PublicContentManifestError";
  }
}

class JsonNumber {
  constructor(source) {
    this.source = source;
  }
}

function fail(message, options) {
  throw new PublicContentManifestError(message, options);
}

function strictJsonParse(text) {
  let index = 0;
  let values = 0;

  function skipWhitespace() {
    while (index < text.length && /[\x20\t\r\n]/.test(text[index])) index += 1;
  }

  function countValue(depth) {
    values += 1;
    if (values > MAX_JSON_VALUES) fail("manifest.json contains too many JSON values");
    if (depth > MAX_JSON_DEPTH) fail("manifest.json exceeds the JSON nesting limit");
  }

  function parseString() {
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch (error) {
          fail("manifest.json contains an invalid JSON string", { cause: error });
        }
      }
      if (code < 0x20) fail("manifest.json contains an unescaped control character");
      if (code === 0x5c) {
        index += 1;
        if (index >= text.length || !/["\\/bfnrtu]/.test(text[index])) {
          fail("manifest.json contains an invalid JSON escape");
        }
        if (text[index] === "u") {
          const digits = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
            fail("manifest.json contains an invalid Unicode escape");
          }
          index += 4;
        }
      }
      index += 1;
    }
    fail("manifest.json contains an unterminated JSON string");
  }

  function parseNumber() {
    const start = index;
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
      if (/[0-9]/.test(text[index] ?? "")) fail("manifest.json contains a non-canonical JSON number");
    } else {
      if (!/[1-9]/.test(text[index] ?? "")) fail("manifest.json contains an invalid JSON number");
      while (/[0-9]/.test(text[index] ?? "")) index += 1;
    }
    if (text[index] === ".") {
      index += 1;
      if (!/[0-9]/.test(text[index] ?? "")) fail("manifest.json contains an invalid JSON number");
      while (/[0-9]/.test(text[index] ?? "")) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!/[0-9]/.test(text[index] ?? "")) fail("manifest.json contains an invalid JSON number");
      while (/[0-9]/.test(text[index] ?? "")) index += 1;
    }
    return new JsonNumber(text.slice(start, index));
  }

  function parseArray(depth) {
    const result = [];
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return result;
    }
    while (true) {
      result.push(parseValue(depth + 1));
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") fail("manifest.json contains an invalid JSON array");
      index += 1;
      skipWhitespace();
    }
  }

  function parseObject(depth) {
    const result = Object.create(null);
    index += 1;
    skipWhitespace();
    if (text[index] === "}") {
      index += 1;
      return result;
    }
    while (true) {
      if (text[index] !== "\"") fail("manifest.json object keys must be strings");
      const key = parseString();
      if (Object.hasOwn(result, key)) fail(`manifest.json contains duplicate key '${key}'`);
      skipWhitespace();
      if (text[index] !== ":") fail("manifest.json contains an invalid JSON object");
      index += 1;
      result[key] = parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") fail("manifest.json contains an invalid JSON object");
      index += 1;
      skipWhitespace();
    }
  }

  function parseValue(depth) {
    skipWhitespace();
    countValue(depth);
    const character = text[index];
    if (character === "{") return parseObject(depth);
    if (character === "[") return parseArray(depth);
    if (character === "\"") return parseString();
    if (character === "-" || /[0-9]/.test(character ?? "")) return parseNumber();
    for (const [literal, value] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return value;
      }
    }
    fail("manifest.json contains an invalid JSON value");
  }

  const result = parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail("manifest.json contains trailing JSON data");
  return result;
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof JsonNumber) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, label, expected) {
  const actual = Object.keys(object(value, label));
  const missing = expected.filter((key) => !actual.includes(key));
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (missing.length || unexpected.length) {
    fail(`${label} fields do not match schema; missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}]`);
  }
}

function integer(value, label, minimum, maximum) {
  if (!(value instanceof JsonNumber) || !/^(?:0|[1-9][0-9]*)$/.test(value.source)) {
    fail(`${label} must be a nonnegative integer`);
  }
  const parsed = BigInt(value.source);
  if (parsed < minimum || parsed > maximum) fail(`${label} is outside its allowed range`);
  return parsed;
}

function nullableLong(value, label) {
  if (value === null) return null;
  return integer(value, label, 0n, MAX_SIGNED_64);
}

function string(value, label, { minimum = 0, maximum, trimmed = false } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (!isWellFormed(value)) fail(`${label} must contain valid Unicode`);
  if (trimmed && value !== value.trim()) fail(`${label} must be trimmed`);
  if (value.length < minimum || (maximum !== undefined && value.length > maximum)) {
    fail(`${label} has an invalid length`);
  }
  return value;
}

function bool(value, label) {
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function isWellFormed(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateId(value, label) {
  const parsed = string(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(parsed) || parsed.includes("..")) {
    fail(`${label} is not publication-safe`);
  }
  return parsed;
}

function validateAction(value, label) {
  if (value === null) return null;
  exactKeys(value, label, ["label", "url"]);
  string(value.label, `${label}.label`, { minimum: 1, maximum: 64, trimmed: true });
  const rawUrl = string(value.url, `${label}.url`, { minimum: 1, maximum: 2_048, trimmed: true });
  if (/[\u0000-\u0020\u007f]/.test(rawUrl)) fail(`${label}.url contains whitespace or a control character`);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    fail(`${label}.url must be a valid absolute HTTPS URL`, { cause: error });
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    fail(`${label}.url must be an absolute HTTPS URL without user info`);
  }
  return value;
}

function validatePolicy(value) {
  const label = "manifest.json.client.policy";
  exactKeys(value, label, POLICY_FIELDS);
  if (integer(value.schemaVersion, `${label}.schemaVersion`, 1n, 1n) !== 1n) fail("unreachable");
  validateId(value.policyId, `${label}.policyId`);
  integer(value.revision, `${label}.revision`, 1n, MAX_UNSIGNED_32);
  const mode = string(value.mode, `${label}.mode`);
  const modes = new Set(["NORMAL", "NOTICE", "TEMPORARILY_UNAVAILABLE", "UPDATE_AVAILABLE", "UPDATE_REQUIRED"]);
  if (!modes.has(mode)) fail(`${label}.mode is unsupported`);
  const title = string(value.title, `${label}.title`, { maximum: 120, trimmed: true });
  const message = string(value.message, `${label}.message`, { maximum: 2_000, trimmed: true });
  const minimumVersion = integer(
    value.minimumAppVersionCode,
    `${label}.minimumAppVersionCode`,
    0n,
    MAX_UNSIGNED_32,
  );
  const latestVersion = string(value.latestVersionName, `${label}.latestVersionName`, {
    maximum: 64,
    trimmed: true,
  });
  const dismissible = bool(value.dismissible, `${label}.dismissible`);
  const startsAt = nullableLong(value.startsAtEpochSeconds, `${label}.startsAtEpochSeconds`);
  const endsAt = nullableLong(value.endsAtEpochSeconds, `${label}.endsAtEpochSeconds`);
  const primary = validateAction(value.primaryAction, `${label}.primaryAction`);
  const secondary = validateAction(value.secondaryAction, `${label}.secondaryAction`);

  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
    fail(`${label}.endsAtEpochSeconds must be greater than startsAtEpochSeconds`);
  }
  if (secondary !== null && primary === null) fail(`${label}.secondaryAction requires primaryAction`);

  const requirePresented = () => {
    if (!title || !message) fail(`${label}.${mode} requires title and message`);
  };
  const requireNoUpdateVersion = () => {
    if (minimumVersion !== 0n || latestVersion) fail(`${label}.${mode} must not contain update version fields`);
  };
  if (mode === "NORMAL") {
    if (title || message || latestVersion || minimumVersion !== 0n || dismissible || primary || secondary) {
      fail(`${label}.NORMAL must not contain presentation fields`);
    }
    if (startsAt !== null || endsAt !== null) fail(`${label}.NORMAL must not have an active window`);
  } else if (mode === "NOTICE") {
    requirePresented();
    requireNoUpdateVersion();
    if (!dismissible) fail(`${label}.NOTICE must be dismissible`);
  } else if (mode === "TEMPORARILY_UNAVAILABLE") {
    requirePresented();
    requireNoUpdateVersion();
    if (dismissible) fail(`${label}.TEMPORARILY_UNAVAILABLE must not be dismissible`);
    if (endsAt === null) fail(`${label}.TEMPORARILY_UNAVAILABLE requires endsAtEpochSeconds`);
  } else {
    requirePresented();
    if (minimumVersion === 0n || !latestVersion || primary === null) {
      fail(`${label}.${mode} requires update version fields and primaryAction`);
    }
    if (dismissible !== (mode === "UPDATE_AVAILABLE")) {
      fail(`${label}.${mode} has an invalid dismissible value`);
    }
  }
}

function normalizedCdnOrigin(value, label) {
  const raw = string(value, label);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    fail(`${label} must be a valid HTTP(S) origin`, { cause: error });
  }
  if (!["http:", "https:"].includes(parsed.protocol)
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.pathname !== "/") {
    fail(`${label} must be an HTTP(S) origin without user info, path, query, or fragment`);
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "http:" && !APPROVED_HTTP_CDN_HOSTS.has(host)) {
    fail(`${label} uses HTTP for a host that is not approved`);
  }
  const defaultPort = (parsed.protocol === "https:" && parsed.port === "443")
    || (parsed.protocol === "http:" && parsed.port === "80");
  const normalized = `${parsed.protocol}//${host}${parsed.port && !defaultPort ? `:${parsed.port}` : ""}`;
  if (raw !== normalized) fail(`${label} must use its normalized origin form '${normalized}'`);
  return normalized;
}

function validateConfig(value) {
  const label = "manifest.json.client.config";
  exactKeys(value, label, CONFIG_FIELDS);
  integer(value.schemaVersion, `${label}.schemaVersion`, 1n, 1n);
  validateId(value.configId, `${label}.configId`);
  integer(value.revision, `${label}.revision`, 1n, MAX_UNSIGNED_32);
  const resourceRoot = string(value.originalResourceRoot, `${label}.originalResourceRoot`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(resourceRoot)) {
    fail(`${label}.originalResourceRoot is invalid`);
  }
  if (!Array.isArray(value.originalCdnRoots)
      || value.originalCdnRoots.length < 1
      || value.originalCdnRoots.length > 8) {
    fail(`${label}.originalCdnRoots must contain 1 to 8 origins`);
  }
  const roots = value.originalCdnRoots.map((entry, index) => normalizedCdnOrigin(
    entry,
    `${label}.originalCdnRoots[${index}]`,
  ));
  if (new Set(roots).size !== roots.length) fail(`${label}.originalCdnRoots must be unique`);
}

function validateFeatures(value) {
  const label = "manifest.json.client.features";
  const entries = Object.entries(object(value, label));
  if (entries.length > 64) fail(`${label} must contain at most 64 entries`);
  for (const [key, enabled] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key) || key.includes("..")) {
      fail(`${label} contains unsafe key '${key}'`);
    }
    bool(enabled, `${label}.${key}`);
  }
}

function validatePublishedAt(value) {
  const label = "manifest.json.publishedAt";
  const timestamp = string(value, label);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{3}|\d{6}|\d{9}))?Z$/.exec(timestamp);
  if (!match) fail(`${label} must be a canonical UTC Instant string`);
  const fraction = match[2] ?? "";
  if ((fraction.length === 3 && fraction === "000")
      || (fraction.length > 3 && fraction.endsWith("000"))) {
    fail(`${label} contains a non-canonical fractional second`);
  }
  const milliseconds = fraction ? fraction.slice(0, 3) : "000";
  const parsed = new Date(`${match[1]}.${milliseconds}Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== `${match[1]}.${milliseconds}Z`) {
    fail(`${label} is not a valid UTC instant`);
  }
}

function validateContentVersion(value) {
  const label = "manifest.json.content.version";
  const version = string(value, label);
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(version);
  if (!match
      || BigInt(match[1]) === 0n
      || BigInt(match[1]) > MAX_UNSIGNED_32
      || BigInt(match[2]) > MAX_UNSIGNED_32) {
    fail(`${label} must be a canonical <positive-u32>.<u32> value`);
  }
  return version;
}

function validateSafeRelativePath(value, label) {
  const path = string(value, label, { minimum: 1, maximum: 512 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(path)) fail(`${label} must be a safe ASCII relative path`);
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`${label} contains an unsafe path segment`);
  }
  return path;
}

function validateManifestModel(root) {
  exactKeys(root, "manifest.json", ROOT_FIELDS);
  integer(root.schemaVersion, "manifest.json.schemaVersion", 1n, 1n);
  const publicationSequence = integer(
    root.publicationSequence,
    "manifest.json.publicationSequence",
    1n,
    MAX_SIGNED_64,
  );
  if (string(root.channel, "manifest.json.channel") !== "production") {
    fail("manifest.json.channel must be 'production'");
  }
  validatePublishedAt(root.publishedAt);

  exactKeys(root.content, "manifest.json.content", CONTENT_FIELDS);
  const version = validateContentVersion(root.content.version);
  const path = validateSafeRelativePath(root.content.path, "manifest.json.content.path");
  const expectedPath = `versions/${version}/Document.mlbytes`;
  if (path !== expectedPath) fail(`manifest.json.content.path must be '${expectedPath}'`);
  const sha256 = string(root.content.sha256, "manifest.json.content.sha256");
  if (!/^[0-9a-f]{64}$/.test(sha256)) fail("manifest.json.content.sha256 must be lowercase SHA-256 hex");
  const sizeBytes = integer(
    root.content.sizeBytes,
    "manifest.json.content.sizeBytes",
    1n,
    BigInt(MAX_CONTENT_BYTES),
  );

  exactKeys(root.client, "manifest.json.client", CLIENT_FIELDS);
  validatePolicy(root.client.policy);
  validateConfig(root.client.config);
  validateFeatures(root.client.features);

  return {
    publicationSequence,
    version,
    path,
    sha256,
    sizeBytes: Number(sizeBytes),
  };
}

function parseSignatureBlock(bytes) {
  const minimum = SIGNATURE_PREFIX_BYTES + 1 + ED25519_SIGNATURE_BYTES;
  const maximum = SIGNATURE_PREFIX_BYTES + MAX_KEY_ID_BYTES + ED25519_SIGNATURE_BYTES;
  if (bytes.length < minimum || bytes.length > maximum) fail("manifest.sig has an invalid size");
  if (!bytes.subarray(0, SIGNATURE_MAGIC.length).equals(SIGNATURE_MAGIC)) {
    fail("manifest.sig has invalid MLBSIG magic");
  }
  const version = bytes.readUInt16LE(8);
  const algorithm = bytes.readUInt16LE(10);
  const keyIdLength = bytes.readUInt16LE(12);
  const signatureLength = bytes.readUInt16LE(14);
  if (version !== 1) fail("manifest.sig has an unsupported signature-block version");
  if (algorithm !== 1) fail("manifest.sig has an unsupported signature algorithm");
  if (keyIdLength < 1 || keyIdLength > MAX_KEY_ID_BYTES) fail("manifest.sig has an invalid key ID length");
  if (signatureLength !== ED25519_SIGNATURE_BYTES) fail("manifest.sig has an invalid Ed25519 signature length");
  const prefixLength = SIGNATURE_PREFIX_BYTES + keyIdLength;
  if (bytes.length !== prefixLength + signatureLength) fail("manifest.sig has an inconsistent length");
  let keyId;
  try {
    keyId = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(SIGNATURE_PREFIX_BYTES, prefixLength),
    );
  } catch (error) {
    fail("manifest.sig key ID is not valid UTF-8", { cause: error });
  }
  if (!keyId || /[\u0000-\u001f\u007f-\u009f]/.test(keyId)) {
    fail("manifest.sig key ID contains a control character");
  }
  return {
    keyId,
    signedPrefix: bytes.subarray(0, prefixLength),
    signature: bytes.subarray(prefixLength),
  };
}

function trustedKey(publicKeys, keyId) {
  const raw = publicKeys instanceof Map
    ? publicKeys.get(keyId)
    : publicKeys && Object.hasOwn(publicKeys, keyId)
      ? publicKeys[keyId]
      : undefined;
  if (!raw) fail(`manifest.sig uses untrusted key ID '${keyId}'`);
  try {
    const key = typeof raw === "string"
      ? createPublicKey({ key: Buffer.from(raw, "base64"), format: "der", type: "spki" })
      : raw.type === "public"
        ? raw
        : createPublicKey(raw);
    if (key.asymmetricKeyType !== "ed25519") fail(`trusted key '${keyId}' is not Ed25519`);
    return key;
  } catch (error) {
    if (error instanceof PublicContentManifestError) throw error;
    fail(`trusted key '${keyId}' is invalid`, { cause: error });
  }
}

async function regularFile(path, label, maximumBytes) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    fail(`${label} is missing`, { cause: error });
  }
  if (details.isSymbolicLink() || !details.isFile()) fail(`${label} must be a regular non-symlink file`);
  if (details.size < 1 || details.size > maximumBytes) fail(`${label} has an invalid size`);
  return details;
}

async function verifyReferencedFile(rootRealPath, metadata) {
  const segments = metadata.path.split("/");
  let current = rootRealPath;
  for (let index = 0; index < segments.length; index += 1) {
    current = resolve(current, segments[index]);
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      fail(`referenced content file is missing: ${metadata.path}`, { cause: error });
    }
    if (details.isSymbolicLink()) fail(`referenced content path contains a symlink: ${metadata.path}`);
    if (index < segments.length - 1 && !details.isDirectory()) {
      fail(`referenced content path traverses a non-directory: ${metadata.path}`);
    }
    if (index === segments.length - 1 && !details.isFile()) {
      fail(`referenced content path is not a regular file: ${metadata.path}`);
    }
  }
  const escaped = relative(rootRealPath, current);
  if (!escaped || escaped.startsWith("..") || isAbsolute(escaped)) {
    fail(`referenced content path escapes its delivery root: ${metadata.path}`);
  }
  const resolvedFile = await realpath(current);
  const resolvedRelative = relative(rootRealPath, resolvedFile);
  if (!resolvedRelative || resolvedRelative.startsWith("..") || isAbsolute(resolvedRelative)) {
    fail(`referenced content path escapes its delivery root: ${metadata.path}`);
  }

  const before = await stat(resolvedFile);
  if (before.size !== metadata.sizeBytes) {
    fail(`referenced content size mismatch: expected ${metadata.sizeBytes}, found ${before.size}`);
  }
  const digest = createHash("sha256");
  let streamedBytes = 0;
  for await (const chunk of createReadStream(resolvedFile)) {
    streamedBytes += chunk.length;
    if (streamedBytes > MAX_CONTENT_BYTES) fail("referenced content exceeds the file-size limit");
    digest.update(chunk);
  }
  const after = await stat(resolvedFile);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || streamedBytes !== before.size) {
    fail("referenced content changed while it was being validated");
  }
  const actualHash = digest.digest("hex");
  if (actualHash !== metadata.sha256) {
    fail(`referenced content SHA-256 mismatch: expected ${metadata.sha256}, found ${actualHash}`);
  }
}

/**
 * Validates one complete public/content delivery tree.
 *
 * publicKeys must map MLBSIG key IDs to Ed25519 SPKI DER base64 strings or public KeyObjects.
 */
export async function validatePublicContentDelivery(rootDirectory, { publicKeys } = {}) {
  const requestedRoot = resolve(rootDirectory);
  let rootDetails;
  try {
    rootDetails = await lstat(requestedRoot);
  } catch (error) {
    fail("public content delivery root is missing", { cause: error });
  }
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    fail("public content delivery root must be a non-symlink directory");
  }
  const rootRealPath = await realpath(requestedRoot);
  const manifestPath = resolve(rootRealPath, MANIFEST_NAME);
  const signaturePath = resolve(rootRealPath, SIGNATURE_NAME);
  await regularFile(manifestPath, MANIFEST_NAME, MAX_MANIFEST_BYTES);
  await regularFile(signaturePath, SIGNATURE_NAME, SIGNATURE_PREFIX_BYTES + MAX_KEY_ID_BYTES + ED25519_SIGNATURE_BYTES);

  const manifestBytes = await readFile(manifestPath);
  const signatureBytes = await readFile(signaturePath);
  if (manifestBytes.length >= 3
      && manifestBytes[0] === 0xef
      && manifestBytes[1] === 0xbb
      && manifestBytes[2] === 0xbf) {
    fail("manifest.json must not contain a UTF-8 BOM");
  }

  const signature = parseSignatureBlock(signatureBytes);
  const key = trustedKey(publicKeys, signature.keyId);
  const signed = Buffer.concat([
    MANIFEST_DOMAIN,
    Buffer.from([0]),
    manifestBytes,
    signature.signedPrefix,
  ]);
  if (!verifyEd25519(null, signed, key, signature.signature)) {
    fail("manifest.sig does not authenticate the exact manifest.json bytes");
  }

  let manifestText;
  try {
    manifestText = new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes);
  } catch (error) {
    fail("manifest.json is not valid UTF-8", { cause: error });
  }
  const metadata = validateManifestModel(strictJsonParse(manifestText));
  await verifyReferencedFile(rootRealPath, metadata);

  return Object.freeze({
    publicationSequence: metadata.publicationSequence.toString(),
    contentVersion: metadata.version,
    contentPath: metadata.path,
    contentSha256: metadata.sha256,
    contentSizeBytes: metadata.sizeBytes,
    signatureKeyId: signature.keyId,
  });
}
