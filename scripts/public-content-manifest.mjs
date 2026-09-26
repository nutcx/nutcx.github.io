import {
  createHash,
  createPublicKey,
  verify as verifyEd25519,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { inflateSync } from "node:zlib";
import {
  LEGACY_NAMES,
  projectLegacyContent,
} from "./legacy-content.mjs";

const MANIFEST_NAME = "manifest.json";
const SIGNATURE_NAME = "manifest.sig";
const VERSIONS_NAME = "versions";
const LEGACY_NAME = "legacy";
const MAX_LEGACY_BYTES = 8 * 1024 * 1024 + 16;
const MANIFEST_DOMAIN = Buffer.from("MLBYTES-MANIFEST-V1", "ascii");
const BUNDLE_DOMAIN = Buffer.from("MLBYTES-SIGNATURE-V1", "ascii");
const SIGNATURE_MAGIC = Buffer.from([0x4d, 0x4c, 0x42, 0x53, 0x49, 0x47, 0, 0]);
const BUNDLE_MAGIC = Buffer.from([0x4d, 0x4c, 0x42, 0x59, 0x54, 0x45, 0x53, 0]);
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_CONTENT_BYTES = 40 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_PATH_BYTES = 1024;
const MAX_VERSION_DIRECTORIES = 4_096;
const MAX_KEY_ID_BYTES = 128;
const SIGNATURE_PREFIX_BYTES = 16;
const ED25519_SIGNATURE_BYTES = 64;
const BUNDLE_HEADER_BYTES = 80;
const DIRECTORY_RECORD_BYTES = 64;
const DOCUMENT_SCHEMA_VERSION = 3;
const MINIMUM_SUPPORTED_APP_VERSION_CODE = 11;
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
const REQUIRED_DOCUMENT_ENTRIES = Object.freeze([
  "heroes.json",
  "preparations.json",
  "skin-tags.json",
]);

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

function strictJsonParse(text, {
  label = MANIFEST_NAME,
  maxValues = MAX_JSON_VALUES,
  numberParser = (source) => new JsonNumber(source),
} = {}) {
  let index = 0;
  let values = 0;

  function skipWhitespace() {
    while (index < text.length && /[\x20\t\r\n]/.test(text[index])) index += 1;
  }

  function countValue(depth) {
    values += 1;
    if (values > maxValues) fail(`${label} contains too many JSON values`);
    if (depth > MAX_JSON_DEPTH) fail(`${label} exceeds the JSON nesting limit`);
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
          fail(`${label} contains an invalid JSON string`, { cause: error });
        }
      }
      if (code < 0x20) fail(`${label} contains an unescaped control character`);
      if (code === 0x5c) {
        index += 1;
        if (index >= text.length || !/["\\/bfnrtu]/.test(text[index])) {
          fail(`${label} contains an invalid JSON escape`);
        }
        if (text[index] === "u") {
          const digits = text.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
            fail(`${label} contains an invalid Unicode escape`);
          }
          index += 4;
        }
      }
      index += 1;
    }
    fail(`${label} contains an unterminated JSON string`);
  }

  function parseNumber() {
    const start = index;
    if (text[index] === "-") index += 1;
    if (text[index] === "0") {
      index += 1;
      if (/[0-9]/.test(text[index] ?? "")) fail(`${label} contains a non-canonical JSON number`);
    } else {
      if (!/[1-9]/.test(text[index] ?? "")) fail(`${label} contains an invalid JSON number`);
      while (/[0-9]/.test(text[index] ?? "")) index += 1;
    }
    if (text[index] === ".") {
      index += 1;
      if (!/[0-9]/.test(text[index] ?? "")) fail(`${label} contains an invalid JSON number`);
      while (/[0-9]/.test(text[index] ?? "")) index += 1;
    }
    if (text[index] === "e" || text[index] === "E") {
      index += 1;
      if (text[index] === "+" || text[index] === "-") index += 1;
      if (!/[0-9]/.test(text[index] ?? "")) fail(`${label} contains an invalid JSON number`);
      while (/[0-9]/.test(text[index] ?? "")) index += 1;
    }
    return numberParser(text.slice(start, index));
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
      if (text[index] !== ",") fail(`${label} contains an invalid JSON array`);
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
      if (text[index] !== "\"") fail(`${label} object keys must be strings`);
      const key = parseString();
      if (Object.hasOwn(result, key)) fail(`${label} contains duplicate key '${key}'`);
      skipWhitespace();
      if (text[index] !== ":") fail(`${label} contains an invalid JSON object`);
      index += 1;
      result[key] = parseValue(depth + 1);
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return result;
      }
      if (text[index] !== ",") fail(`${label} contains an invalid JSON object`);
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
    fail(`${label} contains an invalid JSON value`);
  }

  const result = parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail(`${label} contains trailing JSON data`);
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

function semanticFingerprint(value) {
  if (value instanceof JsonNumber) return `n${value.source.length}:${value.source}`;
  if (value === null) return "z";
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "string") return `s${value.length}:${value}`;
  if (Array.isArray(value)) {
    return `a${value.length}[${value.map(semanticFingerprint).join("")}]`;
  }
  const keys = Object.keys(value).sort();
  return `o${keys.length}{${keys.map((key) => (
    `${semanticFingerprint(key)}${semanticFingerprint(value[key])}`
  )).join("")}}`;
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
  const revision = integer(value.revision, `${label}.revision`, 1n, MAX_UNSIGNED_32);
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
  return revision;
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
  const revision = integer(value.revision, `${label}.revision`, 1n, MAX_UNSIGNED_32);
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
  return revision;
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
  const policyRevision = validatePolicy(root.client.policy);
  const configRevision = validateConfig(root.client.config);
  validateFeatures(root.client.features);

  return {
    publicationSequence,
    version,
    path,
    sha256,
    sizeBytes: Number(sizeBytes),
    policyRevision,
    policySemantic: semanticFingerprint(root.client.policy),
    configRevision,
    configSemantic: semanticFingerprint(root.client.config),
  };
}

function parseSignatureBlock(bytes, label = SIGNATURE_NAME) {
  const minimum = SIGNATURE_PREFIX_BYTES + 1 + ED25519_SIGNATURE_BYTES;
  const maximum = SIGNATURE_PREFIX_BYTES + MAX_KEY_ID_BYTES + ED25519_SIGNATURE_BYTES;
  if (bytes.length < minimum || bytes.length > maximum) fail(`${label} has an invalid size`);
  if (!bytes.subarray(0, SIGNATURE_MAGIC.length).equals(SIGNATURE_MAGIC)) {
    fail(`${label} has invalid MLBSIG magic`);
  }
  const version = bytes.readUInt16LE(8);
  const algorithm = bytes.readUInt16LE(10);
  const keyIdLength = bytes.readUInt16LE(12);
  const signatureLength = bytes.readUInt16LE(14);
  if (version !== 1) fail(`${label} has an unsupported signature-block version`);
  if (algorithm !== 1) fail(`${label} has an unsupported signature algorithm`);
  if (keyIdLength < 1 || keyIdLength > MAX_KEY_ID_BYTES) fail(`${label} has an invalid key ID length`);
  if (signatureLength !== ED25519_SIGNATURE_BYTES) fail(`${label} has an invalid Ed25519 signature length`);
  const prefixLength = SIGNATURE_PREFIX_BYTES + keyIdLength;
  if (bytes.length !== prefixLength + signatureLength) fail(`${label} has an inconsistent length`);
  let keyId;
  try {
    keyId = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(SIGNATURE_PREFIX_BYTES, prefixLength),
    );
  } catch (error) {
    fail(`${label} key ID is not valid UTF-8`, { cause: error });
  }
  if (!keyId || /[\u0000-\u001f\u007f-\u009f]/.test(keyId)) {
    fail(`${label} key ID contains a control character`);
  }
  return {
    keyId,
    signedPrefix: bytes.subarray(0, prefixLength),
    signature: bytes.subarray(prefixLength),
  };
}

function trustedKey(publicKeys, keyId, label = SIGNATURE_NAME) {
  const raw = publicKeys instanceof Map
    ? publicKeys.get(keyId)
    : publicKeys && Object.hasOwn(publicKeys, keyId)
      ? publicKeys[keyId]
      : undefined;
  if (!raw) fail(`${label} uses untrusted key ID '${keyId}'`);
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

async function regularDirectory(path, label) {
  let details;
  try {
    details = await lstat(path);
  } catch (error) {
    fail(`${label} is missing`, { cause: error });
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    fail(`${label} must be a non-symlink directory`);
  }
}

function exactDirectoryEntries(actual, expected, label) {
  const names = actual.map((entry) => entry.name);
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  if (missing.length || unexpected.length) {
    fail(`${label} entries do not match the public allowlist; missing=[${missing.join(",")}], unexpected=[${unexpected.join(",")}]`);
  }
}

function isCanonicalVersionDirectory(name) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(name);
  return Boolean(match
    && BigInt(match[1]) > 0n
    && BigInt(match[1]) <= MAX_UNSIGNED_32
    && BigInt(match[2]) <= MAX_UNSIGNED_32);
}

async function inspectAllowlistedTree(rootRealPath) {
  const rootEntries = await readdir(rootRealPath, { withFileTypes: true });
  const legacyPresent = rootEntries.some((entry) => entry.name === LEGACY_NAME);
  exactDirectoryEntries(rootEntries, [MANIFEST_NAME, SIGNATURE_NAME, VERSIONS_NAME,
    ...(legacyPresent ? [LEGACY_NAME] : [])], "public content root");

  const legacyFiles = new Map();
  if (legacyPresent) {
    const legacyPath = resolve(rootRealPath, LEGACY_NAME);
    await regularDirectory(legacyPath, LEGACY_NAME);
    const children = await readdir(legacyPath, { withFileTypes: true });
    exactDirectoryEntries(children, LEGACY_NAMES, LEGACY_NAME);
    for (const name of LEGACY_NAMES) {
      const path = resolve(legacyPath, name);
      await regularFile(path, `${LEGACY_NAME}/${name}`, MAX_LEGACY_BYTES);
      legacyFiles.set(name, path);
    }
  }

  await regularFile(resolve(rootRealPath, MANIFEST_NAME), MANIFEST_NAME, MAX_MANIFEST_BYTES);
  await regularFile(
    resolve(rootRealPath, SIGNATURE_NAME),
    SIGNATURE_NAME,
    SIGNATURE_PREFIX_BYTES + MAX_KEY_ID_BYTES + ED25519_SIGNATURE_BYTES,
  );
  const versionsPath = resolve(rootRealPath, VERSIONS_NAME);
  await regularDirectory(versionsPath, VERSIONS_NAME);

  const versionEntries = await readdir(versionsPath, { withFileTypes: true });
  if (versionEntries.length > MAX_VERSION_DIRECTORIES) {
    fail(`public content tree contains more than ${MAX_VERSION_DIRECTORIES} version directories`);
  }
  const versionFiles = new Map();
  for (const entry of versionEntries) {
    if (!isCanonicalVersionDirectory(entry.name)) {
      fail(`public content tree contains invalid version directory '${entry.name}'`);
    }
    const versionPath = resolve(versionsPath, entry.name);
    await regularDirectory(versionPath, `versions/${entry.name}`);
    const children = await readdir(versionPath, { withFileTypes: true });
    exactDirectoryEntries(children, ["Document.mlbytes"], `versions/${entry.name}`);
    const contentPath = `versions/${entry.name}/Document.mlbytes`;
    const absolutePath = resolve(versionPath, "Document.mlbytes");
    await regularFile(absolutePath, contentPath, MAX_CONTENT_BYTES);
    versionFiles.set(contentPath, absolutePath);
  }
  return { versionFiles, legacyFiles };
}

async function hashFile(path, label) {
  const before = await stat(path);
  const digest = createHash("sha256");
  let streamedBytes = 0;
  for await (const chunk of createReadStream(path)) {
    streamedBytes += chunk.length;
    if (streamedBytes > MAX_CONTENT_BYTES) fail(`${label} exceeds the file-size limit`);
    digest.update(chunk);
  }
  const after = await stat(path);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || streamedBytes !== before.size) {
    fail(`${label} changed while it was being validated`);
  }
  return Object.freeze({ sizeBytes: before.size, sha256: digest.digest("hex") });
}

async function hashVersionFiles(versionFiles) {
  const result = new Map();
  for (const [path, absolutePath] of versionFiles) {
    result.set(path, Object.freeze({
      absolutePath,
      ...await hashFile(absolutePath, path),
    }));
  }
  return result;
}

function readSupportedUnsigned64(bytes, offset, label) {
  const value = bytes.readBigUInt64LE(offset);
  if (value > MAX_SIGNED_64) fail(`Document.mlbytes ${label} exceeds the supported range`);
  return value;
}

function checkedAdd(left, right, label) {
  const value = left + right;
  if (value > MAX_SIGNED_64) fail(`Document.mlbytes ${label} exceeds the supported range`);
  return value;
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`${label} is not valid UTF-8`, { cause: error });
  }
}

function verifySignedDocument(bytes, expectedVersion, publicKeys) {
  if (bytes.length < BUNDLE_HEADER_BYTES) fail("Document.mlbytes is shorter than its fixed header");
  if (bytes.length > MAX_CONTENT_BYTES) fail("Document.mlbytes exceeds the file-size limit");
  if (!bytes.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) {
    fail("Document.mlbytes has invalid MLBytes magic");
  }
  if (bytes.readUInt16LE(8) !== 1 || bytes.readUInt16LE(10) !== 0) {
    fail("Document.mlbytes has an unsupported MLBytes format version");
  }
  if (bytes.readUInt32LE(12) !== 1) {
    fail("Document.mlbytes must be signed and contain no unknown flags");
  }
  if (bytes.readUInt32LE(16) !== BUNDLE_HEADER_BYTES) {
    fail("Document.mlbytes has an invalid header size");
  }
  const schemaVersion = bytes.readUInt32LE(20);
  if (schemaVersion !== DOCUMENT_SCHEMA_VERSION) {
    fail(`Document.mlbytes must use content schema ${DOCUMENT_SCHEMA_VERSION}`);
  }
  const minimumAppVersionCode = bytes.readUInt32LE(24);
  if (minimumAppVersionCode < MINIMUM_SUPPORTED_APP_VERSION_CODE) {
    fail(`Document.mlbytes minimum app version code must be at least ${MINIMUM_SUPPORTED_APP_VERSION_CODE}`);
  }
  if (bytes.readUInt32LE(28) !== 0) fail("Document.mlbytes header reserved field is nonzero");

  const release = bytes.readUInt32LE(32);
  const revision = bytes.readUInt32LE(36);
  const contentVersion = `${release}.${revision}`;
  if (release === 0 || contentVersion !== expectedVersion) {
    fail(`Document.mlbytes content version ${contentVersion} does not match manifest version ${expectedVersion}`);
  }
  const entryCount = bytes.readUInt32LE(40);
  if (entryCount !== REQUIRED_DOCUMENT_ENTRIES.length) {
    fail(`Document.mlbytes must contain exactly ${REQUIRED_DOCUMENT_ENTRIES.length} entries`);
  }
  const directorySize = bytes.readUInt32LE(44);
  if (directorySize < entryCount * DIRECTORY_RECORD_BYTES || directorySize > MAX_DIRECTORY_BYTES) {
    fail("Document.mlbytes has an invalid directory size");
  }
  const payloadOffset = readSupportedUnsigned64(bytes, 48, "payload offset");
  const storedPayloadSize = readSupportedUnsigned64(bytes, 56, "stored payload size");
  const totalRawSize = readSupportedUnsigned64(bytes, 64, "uncompressed payload size");
  const signatureOffset = readSupportedUnsigned64(bytes, 72, "signature offset");
  const expectedPayloadOffset = BigInt(BUNDLE_HEADER_BYTES + directorySize);
  if (payloadOffset !== expectedPayloadOffset) {
    fail("Document.mlbytes payload does not immediately follow its directory");
  }
  if (totalRawSize > BigInt(MAX_TOTAL_ENTRY_BYTES)) {
    fail("Document.mlbytes uncompressed payload exceeds the limit");
  }
  const payloadEnd = checkedAdd(payloadOffset, storedPayloadSize, "payload end");
  if (signatureOffset !== payloadEnd) {
    fail("Document.mlbytes signature does not immediately follow its payload");
  }
  if (signatureOffset > BigInt(bytes.length)) {
    fail("Document.mlbytes signature offset exceeds the file length");
  }

  // Authenticate the exact header, directory, and payload before parsing any directory records.
  const signatureStart = Number(signatureOffset);
  const signature = parseSignatureBlock(
    bytes.subarray(signatureStart),
    "Document.mlbytes signature block",
  );
  const key = trustedKey(publicKeys, signature.keyId, "Document.mlbytes signature block");
  const signed = Buffer.concat([
    BUNDLE_DOMAIN,
    Buffer.from([0]),
    bytes.subarray(0, signatureStart),
    signature.signedPrefix,
  ]);
  if (!verifyEd25519(null, signed, key, signature.signature)) {
    fail("Document.mlbytes signature does not authenticate the exact bundle bytes");
  }

  const directoryEnd = BUNDLE_HEADER_BYTES + directorySize;
  let cursor = BUNDLE_HEADER_BYTES;
  let nextRelativeOffset = 0n;
  let calculatedRawSize = 0n;
  let previousPathBytes;
  const seenPaths = new Set();
  const records = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + DIRECTORY_RECORD_BYTES > directoryEnd) {
      fail("Document.mlbytes directory ended unexpectedly");
    }
    const pathLength = bytes.readUInt16LE(cursor);
    const codec = bytes.readUInt8(cursor + 2);
    const entryFlags = bytes.readUInt8(cursor + 3);
    const reserved = bytes.readUInt32LE(cursor + 4);
    const relativeOffset = readSupportedUnsigned64(bytes, cursor + 8, "entry offset");
    const storedSize = readSupportedUnsigned64(bytes, cursor + 16, "stored entry size");
    const rawSize = readSupportedUnsigned64(bytes, cursor + 24, "uncompressed entry size");
    const expectedSha256 = bytes.subarray(cursor + 32, cursor + 64);
    cursor += DIRECTORY_RECORD_BYTES;
    if (pathLength < 1 || pathLength > MAX_PATH_BYTES || cursor + pathLength > directoryEnd) {
      fail("Document.mlbytes entry path length is invalid");
    }
    const pathBytes = bytes.subarray(cursor, cursor + pathLength);
    cursor += pathLength;
    const path = decodeUtf8(pathBytes, "Document.mlbytes entry path");

    if (!REQUIRED_DOCUMENT_ENTRIES.includes(path)) {
      fail(`Document.mlbytes contains undeclared entry '${path}'`);
    }
    if (seenPaths.has(path)) fail(`Document.mlbytes contains duplicate entry '${path}'`);
    seenPaths.add(path);
    if (previousPathBytes && Buffer.compare(previousPathBytes, pathBytes) >= 0) {
      fail("Document.mlbytes directory entries are not byte-sorted");
    }
    previousPathBytes = pathBytes;
    if (codec !== 0 && codec !== 1) fail(`Document.mlbytes entry '${path}' uses an unsupported codec`);
    if (entryFlags !== 0 || reserved !== 0) {
      fail(`Document.mlbytes entry '${path}' has nonzero flags or reserved data`);
    }
    if (relativeOffset !== nextRelativeOffset) {
      fail("Document.mlbytes entry payloads are not contiguous");
    }
    if (storedSize > BigInt(MAX_ENTRY_BYTES)
        || rawSize < 1n
        || rawSize > BigInt(MAX_ENTRY_BYTES)) {
      fail(`Document.mlbytes entry '${path}' exceeds its size limit`);
    }
    if (codec === 0 && storedSize !== rawSize) {
      fail(`Document.mlbytes stored entry '${path}' has inconsistent sizes`);
    }
    nextRelativeOffset = checkedAdd(nextRelativeOffset, storedSize, "entry payload size");
    calculatedRawSize = checkedAdd(calculatedRawSize, rawSize, "uncompressed payload size");
    if (calculatedRawSize > BigInt(MAX_TOTAL_ENTRY_BYTES)) {
      fail("Document.mlbytes uncompressed payload exceeds the limit");
    }
    records.push({
      path,
      codec,
      relativeOffset: Number(relativeOffset),
      storedSize: Number(storedSize),
      rawSize: Number(rawSize),
      expectedSha256,
    });
  }
  if (cursor !== directoryEnd) fail("Document.mlbytes directory contains trailing bytes");
  if (nextRelativeOffset !== storedPayloadSize) {
    fail("Document.mlbytes stored payload total is inconsistent");
  }
  if (calculatedRawSize !== totalRawSize) {
    fail("Document.mlbytes uncompressed payload total is inconsistent");
  }
  if (seenPaths.size !== REQUIRED_DOCUMENT_ENTRIES.length
      || REQUIRED_DOCUMENT_ENTRIES.some((path) => !seenPaths.has(path))) {
    fail("Document.mlbytes entry set is incomplete");
  }

  const payloadStart = Number(payloadOffset);
  const entries = new Map();
  for (const record of records) {
    const storedStart = payloadStart + record.relativeOffset;
    const storedEnd = storedStart + record.storedSize;
    if (storedEnd > signatureStart) fail(`Document.mlbytes entry '${record.path}' exceeds the payload`);
    const stored = bytes.subarray(storedStart, storedEnd);
    let raw;
    if (record.codec === 0) {
      raw = stored;
    } else {
      try {
        const inflated = inflateSync(stored, {
          info: true,
          maxOutputLength: record.rawSize,
        });
        if (inflated.engine.bytesWritten !== stored.length) {
          fail(`Document.mlbytes zlib stream has trailing bytes for '${record.path}'`);
        }
        raw = inflated.buffer;
      } catch (error) {
        if (error instanceof PublicContentManifestError) throw error;
        fail(`Document.mlbytes contains invalid zlib data for '${record.path}'`, { cause: error });
      }
    }
    if (raw.length !== record.rawSize) {
      fail(`Document.mlbytes entry '${record.path}' has an inconsistent uncompressed size`);
    }
    const actualSha256 = createHash("sha256").update(raw).digest();
    if (!actualSha256.equals(record.expectedSha256)) {
      fail(`Document.mlbytes entry '${record.path}' has a SHA-256 mismatch`);
    }
    entries.set(record.path, raw);
  }
  return Object.freeze({
    contentVersion,
    schemaVersion,
    minimumAppVersionCode,
    signatureKeyId: signature.keyId,
    entries,
  });
}

function projectVerifiedLegacy(entries) {
  const parsed = new Map();
  for (const name of REQUIRED_DOCUMENT_ENTRIES) {
    const bytes = entries.get(name);
    parsed.set(name, strictJsonParse(decodeUtf8(bytes, name), {
      label: name,
      maxValues: 1_000_000,
      numberParser: (source) => {
        if (source.length > 19 || !/^(?:0|[1-9][0-9]*)$/.test(source)) {
          fail(`Legacy projection: ${name} contains a nonnegative-integer violation`);
        }
        return BigInt(source);
      },
    }));
  }
  try {
    return projectLegacyContent(parsed.get("heroes.json"), parsed.get("skin-tags.json"),
      parsed.get("preparations.json"));
  } catch (error) {
    fail(error.message, { cause: error });
  }
}

async function validateLegacyFiles(legacyFiles, entries) {
  if (legacyFiles.size === 0) return;
  const generated = projectVerifiedLegacy(entries);
  for (const [name, path] of legacyFiles) {
    const details = await regularFile(path, `legacy/${name}`, MAX_LEGACY_BYTES);
    const bytes = await readFile(path);
    if (bytes.length !== details.size || bytes.length > MAX_LEGACY_BYTES) {
      fail(`legacy/${name} changed while it was being validated`);
    }
    if (!bytes.equals(generated.get(name))) {
      fail(`legacy/${name} does not match the verified current Document.mlbytes`);
    }
  }
}

async function validateDeliveryInternal(rootDirectory, publicKeys) {
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
  const allowlisted = await inspectAllowlistedTree(rootRealPath);
  const manifestPath = resolve(rootRealPath, MANIFEST_NAME);
  const signaturePath = resolve(rootRealPath, SIGNATURE_NAME);

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
  const versionFiles = await hashVersionFiles(allowlisted.versionFiles);
  const referenced = versionFiles.get(metadata.path);
  if (!referenced) fail(`referenced content file is missing: ${metadata.path}`);
  if (referenced.sizeBytes !== metadata.sizeBytes) {
    fail(`referenced content size mismatch: expected ${metadata.sizeBytes}, found ${referenced.sizeBytes}`);
  }
  if (referenced.sha256 !== metadata.sha256) {
    fail(`referenced content SHA-256 mismatch: expected ${metadata.sha256}, found ${referenced.sha256}`);
  }
  const documentBytes = await readFile(referenced.absolutePath);
  if (documentBytes.length !== referenced.sizeBytes
      || createHash("sha256").update(documentBytes).digest("hex") !== referenced.sha256) {
    fail("referenced content changed while its signed bundle was being validated");
  }
  const document = verifySignedDocument(documentBytes, metadata.version, publicKeys);
  await validateLegacyFiles(allowlisted.legacyFiles, document.entries);
  const summary = Object.freeze({
    publicationSequence: metadata.publicationSequence.toString(),
    contentVersion: metadata.version,
    contentPath: metadata.path,
    contentSha256: metadata.sha256,
    contentSizeBytes: metadata.sizeBytes,
    signatureKeyId: signature.keyId,
    documentSignatureKeyId: document.signatureKeyId,
    minimumAppVersionCode: document.minimumAppVersionCode,
    legacyFileCount: allowlisted.legacyFiles.size,
  });
  return { manifestBytes, metadata, versionFiles, legacyPresent: allowlisted.legacyFiles.size !== 0, summary };
}

/**
 * Validates one complete public/content delivery tree.
 *
 * publicKeys must map MLBSIG key IDs to Ed25519 SPKI DER base64 strings or public KeyObjects.
 */
export async function validatePublicContentDelivery(rootDirectory, { publicKeys } = {}) {
  return (await validateDeliveryInternal(rootDirectory, publicKeys)).summary;
}

function compareContentVersions(left, right) {
  const [leftRelease, leftRevision] = left.split(".").map(BigInt);
  const [rightRelease, rightRevision] = right.split(".").map(BigInt);
  if (leftRelease !== rightRelease) return leftRelease < rightRelease ? -1 : 1;
  if (leftRevision !== rightRevision) return leftRevision < rightRevision ? -1 : 1;
  return 0;
}

function sameDescriptor(left, right) {
  return left.version === right.version
    && left.path === right.path
    && left.sha256 === right.sha256
    && left.sizeBytes === right.sizeBytes;
}

async function filesAreExactlyEqual(leftPath, rightPath) {
  const [left, right] = await Promise.all([readFile(leftPath), readFile(rightPath)]);
  return left.equals(right);
}

/** Validates a candidate tree and all monotonic/immutable transitions from a prior tree. */
export async function validatePublicContentTransition(
  previousRootDirectory,
  currentRootDirectory,
  { publicKeys } = {},
) {
  const [previous, current] = await Promise.all([
    validateDeliveryInternal(previousRootDirectory, publicKeys),
    validateDeliveryInternal(currentRootDirectory, publicKeys),
  ]);

  const manifestChanged = !previous.manifestBytes.equals(current.manifestBytes);
  if (previous.legacyPresent && !current.legacyPresent) {
    fail("the published legacy directory may not be removed");
  }
  if (manifestChanged) {
    if (current.metadata.publicationSequence <= previous.metadata.publicationSequence) {
      fail("a changed manifest requires a strictly increasing publicationSequence");
    }
    const contentOrder = compareContentVersions(current.metadata.version, previous.metadata.version);
    if (contentOrder < 0) fail("content version rollback is not allowed");
    if (contentOrder === 0 && !sameDescriptor(previous.metadata, current.metadata)) {
      fail(`content descriptor collision for immutable version ${current.metadata.version}`);
    }
    if (current.metadata.policyRevision < previous.metadata.policyRevision) {
      fail("client policy revision rollback is not allowed");
    }
    if (current.metadata.policyRevision === previous.metadata.policyRevision
        && current.metadata.policySemantic !== previous.metadata.policySemantic) {
      fail("client policy changed without increasing its revision");
    }
    if (current.metadata.configRevision < previous.metadata.configRevision) {
      fail("client config revision rollback is not allowed");
    }
    if (current.metadata.configRevision === previous.metadata.configRevision
        && current.metadata.configSemantic !== previous.metadata.configSemantic) {
      fail("client config changed without increasing its revision");
    }
  }

  for (const [path, oldFile] of previous.versionFiles) {
    const newFile = current.versionFiles.get(path);
    if (!newFile) fail(`immutable content file was removed: ${path}`);
    if (oldFile.sizeBytes !== newFile.sizeBytes
        || oldFile.sha256 !== newFile.sha256
        || !await filesAreExactlyEqual(oldFile.absolutePath, newFile.absolutePath)) {
      fail(`immutable content file changed: ${path}`);
    }
  }
  const additions = [...current.versionFiles.keys()]
    .filter((path) => !previous.versionFiles.has(path));
  const allowedAddition = previous.versionFiles.has(current.metadata.path)
    ? []
    : [current.metadata.path];
  if (additions.length !== allowedAddition.length
      || additions.some((path, index) => path !== allowedAddition[index])) {
    fail(`only the active content version may be added; additions=[${additions.join(",")}]`);
  }

  return Object.freeze({
    ...current.summary,
    previousPublicationSequence: previous.summary.publicationSequence,
    manifestChanged,
    addedContentPaths: Object.freeze(additions),
  });
}
