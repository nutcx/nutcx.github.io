import assert from "node:assert/strict";
import {
  createHash,
  createDecipheriv,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import {
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  validatePublicContentDelivery,
  validatePublicContentTransition,
} from "./public-content-manifest.mjs";
import { LEGACY_NAMES, projectLegacyContent } from "./legacy-content.mjs";

const KEY_ID = "fixture-content-key";
const CONTENT_VERSION = "1001.6";
const SIGNATURE_MAGIC = Buffer.from([0x4d, 0x4c, 0x42, 0x53, 0x49, 0x47, 0, 0]);
const BUNDLE_MAGIC = Buffer.from([0x4d, 0x4c, 0x42, 0x59, 0x54, 0x45, 0x53, 0]);
const MANIFEST_DOMAIN = Buffer.from("MLBYTES-MANIFEST-V1", "ascii");
const BUNDLE_DOMAIN = Buffer.from("MLBYTES-SIGNATURE-V1", "ascii");
const validatorPath = fileURLToPath(new URL("./validate-public-content-manifest.mjs", import.meta.url));
const legacyFixtureRoot = fileURLToPath(new URL("./fixtures/legacy-export/", import.meta.url));

async function legacyFixtureDocuments() {
  return JSON.parse(await readFile(join(legacyFixtureRoot, "document.json"), "utf8"));
}

function exactNumericFixture(value) {
  return JSON.parse(JSON.stringify(value), (_key, entry) => typeof entry === "number" ? BigInt(entry) : entry);
}

function entriesForDocuments(documents) {
  return new Map(Object.entries(documents).map(([name, value]) => [
    name, Buffer.from(JSON.stringify(value), "utf8"),
  ]));
}

async function writeLegacyFixture(root, documents) {
  const directory = join(root, "legacy");
  await mkdir(directory, { recursive: true });
  const files = projectLegacyContent(exactNumericFixture(documents["heroes.json"]),
    exactNumericFixture(documents["skin-tags.json"]), exactNumericFixture(documents["preparations.json"]));
  for (const [name, bytes] of files) await writeFile(join(directory, name), bytes);
}

async function withLegacyFixture(run) {
  const documents = await legacyFixtureDocuments();
  await withFixture(async (item) => {
    await writeLegacyFixture(item.root, documents);
    await run({ ...item, documents });
  }, { documentOptions: { entries: entriesForDocuments(documents) } });
}

function decodePreparationRows(bytes) {
  const key = Buffer.from("zonghub_gfx_2024", "ascii");
  const cipher = createDecipheriv("aes-128-cbc", key, key);
  const raw = Buffer.concat([cipher.update(bytes), cipher.final()]);
  let cursor = 0;
  const integer = () => { const value = raw.readInt32LE(cursor); cursor += 4; return value; };
  const text = () => {
    let length = 0;
    let shift = 0;
    while (true) {
      const byte = raw[cursor++];
      assert.notEqual(byte, undefined);
      length += (byte & 127) * (2 ** shift);
      if ((byte & 128) === 0) break;
      shift += 7;
      assert.ok(shift <= 28);
    }
    assert.ok(cursor + length <= raw.length);
    const value = raw.subarray(cursor, cursor + length).toString("utf8");
    cursor += length;
    return value;
  };
  const count = integer();
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const row = { id: integer(), type: integer(), name: text(), image: text(), archive: text(), items: [] };
    const childCount = integer();
    for (let child = 0; child < childCount; child += 1) {
      row.items.push({ name: text(), tag: integer(), image: text(), archive: text() });
    }
    result.push(row);
  }
  assert.equal(cursor, raw.length, "legacy preparation rows must consume all decrypted bytes");
  return result;
}

function preparationBytes(document) {
  return projectLegacyContent({ heroes: [] }, { tags: [] }, exactNumericFixture(document)).get(LEGACY_NAMES[4]);
}

function signatureBlock(domain, payloadBytes, privateKey, keyId = KEY_ID) {
  const keyIdBytes = Buffer.from(keyId, "utf8");
  const prefix = Buffer.alloc(16 + keyIdBytes.length);
  SIGNATURE_MAGIC.copy(prefix, 0);
  prefix.writeUInt16LE(1, 8);
  prefix.writeUInt16LE(1, 10);
  prefix.writeUInt16LE(keyIdBytes.length, 12);
  prefix.writeUInt16LE(64, 14);
  keyIdBytes.copy(prefix, 16);
  const signed = Buffer.concat([domain, Buffer.from([0]), payloadBytes, prefix]);
  return Buffer.concat([prefix, signEd25519(null, signed, privateKey)]);
}

function documentEntries() {
  return new Map([
    ["heroes.json", Buffer.from('{"heroes":[]}\n', "utf8")],
    ["preparations.json", Buffer.from('{"preparations":[]}\n', "utf8")],
    ["skin-tags.json", Buffer.from('{"tags":[]}\n', "utf8")],
  ]);
}

function signedDocument({
  privateKey,
  keyId = KEY_ID,
  version = CONTENT_VERSION,
  schemaVersion = 3,
  minimumAppVersionCode = 11,
  signed = true,
  corruptEntryDigest = false,
  entries = documentEntries(),
} = {}) {
  const [release, revision] = version.split(".").map(Number);
  const records = [...entries.entries()]
    .map(([path, raw]) => {
      const pathBytes = Buffer.from(path, "utf8");
      return { pathBytes, stored: deflateSync(raw), raw };
    })
    .sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  const directorySize = records.reduce((total, record) => total + 64 + record.pathBytes.length, 0);
  const storedPayloadSize = records.reduce((total, record) => total + record.stored.length, 0);
  const totalRawSize = records.reduce((total, record) => total + record.raw.length, 0);
  const payloadOffset = 80 + directorySize;
  const signatureOffset = payloadOffset + storedPayloadSize;

  const header = Buffer.alloc(80);
  BUNDLE_MAGIC.copy(header, 0);
  header.writeUInt16LE(1, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt32LE(signed ? 1 : 0, 12);
  header.writeUInt32LE(80, 16);
  header.writeUInt32LE(schemaVersion, 20);
  header.writeUInt32LE(minimumAppVersionCode, 24);
  header.writeUInt32LE(0, 28);
  header.writeUInt32LE(release, 32);
  header.writeUInt32LE(revision, 36);
  header.writeUInt32LE(records.length, 40);
  header.writeUInt32LE(directorySize, 44);
  header.writeBigUInt64LE(BigInt(payloadOffset), 48);
  header.writeBigUInt64LE(BigInt(storedPayloadSize), 56);
  header.writeBigUInt64LE(BigInt(totalRawSize), 64);
  header.writeBigUInt64LE(BigInt(signed ? signatureOffset : 0), 72);

  const directory = Buffer.alloc(directorySize);
  let directoryCursor = 0;
  let payloadCursor = 0;
  records.forEach((record, index) => {
    directory.writeUInt16LE(record.pathBytes.length, directoryCursor);
    directory.writeUInt8(1, directoryCursor + 2);
    directory.writeUInt8(0, directoryCursor + 3);
    directory.writeUInt32LE(0, directoryCursor + 4);
    directory.writeBigUInt64LE(BigInt(payloadCursor), directoryCursor + 8);
    directory.writeBigUInt64LE(BigInt(record.stored.length), directoryCursor + 16);
    directory.writeBigUInt64LE(BigInt(record.raw.length), directoryCursor + 24);
    const digest = createHash("sha256").update(record.raw).digest();
    if (corruptEntryDigest && index === 0) digest[0] ^= 1;
    digest.copy(directory, directoryCursor + 32);
    record.pathBytes.copy(directory, directoryCursor + 64);
    directoryCursor += 64 + record.pathBytes.length;
    payloadCursor += record.stored.length;
  });
  const unsignedBytes = Buffer.concat([header, directory, ...records.map(({ stored }) => stored)]);
  if (!signed) return unsignedBytes;
  return Buffer.concat([
    unsignedBytes,
    signatureBlock(BUNDLE_DOMAIN, unsignedBytes, privateKey, keyId),
  ]);
}

function manifestFor(contentBytes, {
  version = CONTENT_VERSION,
  publicationSequence = 7,
  policyRevision = 7,
  configRevision = 3,
} = {}) {
  return {
    schemaVersion: 1,
    publicationSequence,
    channel: "production",
    publishedAt: "2026-09-26T04:05:06Z",
    content: {
      version,
      path: `versions/${version}/Document.mlbytes`,
      sha256: createHash("sha256").update(contentBytes).digest("hex"),
      sizeBytes: contentBytes.length,
    },
    client: {
      policy: {
        schemaVersion: 1,
        policyId: `normal-${policyRevision}`,
        revision: policyRevision,
        mode: "NORMAL",
        title: "",
        message: "",
        minimumAppVersionCode: 0,
        latestVersionName: "",
        dismissible: false,
        startsAtEpochSeconds: null,
        endsAtEpochSeconds: null,
        primaryAction: null,
        secondaryAction: null,
      },
      config: {
        schemaVersion: 1,
        configId: `resources-${configRevision}`,
        revision: configRevision,
        originalResourceRoot: "android",
        originalCdnRoots: [
          "https://edge-txcdn.ml.youngjoygame.com",
          "http://akmcdn.ml.youngjoygame.com",
        ],
      },
      features: {
        "catalog.v4": true,
        "legacy.fallback": false,
      },
    },
  };
}

async function writeSignedManifest(root, value, privateKey, keyId = KEY_ID) {
  const bytes = Buffer.from(
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(root, "manifest.json"), bytes);
  await writeFile(
    join(root, "manifest.sig"),
    signatureBlock(MANIFEST_DOMAIN, bytes, privateKey, keyId),
  );
}

async function fixture({
  keys = generateKeyPairSync("ed25519"),
  version = CONTENT_VERSION,
  publicationSequence = 7,
  policyRevision = 7,
  configRevision = 3,
  documentOptions = {},
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "nutcx-public-content-"));
  const contentBytes = signedDocument({
    privateKey: keys.privateKey,
    version,
    ...documentOptions,
  });
  const contentPath = `versions/${version}/Document.mlbytes`;
  const contentFile = join(root, ...contentPath.split("/"));
  await mkdir(dirname(contentFile), { recursive: true });
  await writeFile(contentFile, contentBytes);
  const manifest = manifestFor(contentBytes, {
    version,
    publicationSequence,
    policyRevision,
    configRevision,
  });
  await writeSignedManifest(root, manifest, keys.privateKey);
  return {
    root,
    contentBytes,
    contentPath,
    contentFile,
    manifest,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    publicKeyBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    keys,
  };
}

async function withFixture(run, options) {
  const current = await fixture(options);
  try {
    await run(current);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
}

async function replaceDocument(current, bytes) {
  current.contentBytes = bytes;
  await writeFile(current.contentFile, bytes);
  current.manifest.content.sha256 = createHash("sha256").update(bytes).digest("hex");
  current.manifest.content.sizeBytes = bytes.length;
  await writeSignedManifest(current.root, current.manifest, current.privateKey);
}

async function transitionPair({ previous = {}, current = {} } = {}) {
  const keys = generateKeyPairSync("ed25519");
  const oldTree = await fixture({ keys, ...previous });
  const newTree = await fixture({ keys, publicationSequence: 8, ...current });
  if (oldTree.contentPath !== newTree.contentPath) {
    const oldCopy = join(newTree.root, ...oldTree.contentPath.split("/"));
    await mkdir(dirname(oldCopy), { recursive: true });
    await copyFile(oldTree.contentFile, oldCopy);
  }
  return { oldTree, newTree };
}

async function withTransition(run, options) {
  const pair = await transitionPair(options);
  try {
    await run(pair);
  } finally {
    await Promise.all([
      rm(pair.oldTree.root, { recursive: true, force: true }),
      rm(pair.newTree.root, { recursive: true, force: true }),
    ]);
  }
}

test("validates both signatures, the exact Document header, and the CLI", async () => {
  await withFixture(async ({ root, contentBytes, publicKey, publicKeyBase64 }) => {
    const result = await validatePublicContentDelivery(root, {
      publicKeys: new Map([[KEY_ID, publicKey]]),
    });
    assert.equal(result.contentVersion, CONTENT_VERSION);
    assert.equal(result.contentSizeBytes, contentBytes.length);
    assert.equal(result.signatureKeyId, KEY_ID);
    assert.equal(result.documentSignatureKeyId, KEY_ID);
    assert.equal(result.minimumAppVersionCode, 11);

    const cli = spawnSync(
      process.execPath,
      [validatorPath, root, "--previous-root", root, "--public-key", `${KEY_ID}=${publicKeyBase64}`],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Transition from sequence 7 is valid/);
  });
});

test("rejects a tampered manifest signature before parsing manifest data", async () => {
  await withFixture(async ({ root, publicKey }) => {
    await writeFile(join(root, "manifest.json"), Buffer.from("not json", "utf8"));
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /does not authenticate/,
    );
  });
});

test("rejects duplicate and unexpected manifest fields", async () => {
  await withFixture(async ({ root, manifest, privateKey, publicKey }) => {
    const raw = JSON.stringify(manifest).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    );
    await writeSignedManifest(root, raw, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /duplicate key 'schemaVersion'/,
    );

    manifest.unexpected = true;
    await writeSignedManifest(root, manifest, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /unexpected=\[unexpected\]/,
    );
  });
});

test("enforces the exact public/content tree allowlist", async () => {
  for (const mutation of [
    async (item) => writeFile(join(item.root, "database.json"), "{}"),
    async (item) => writeFile(join(item.root, "versions", "README.md"), "no"),
    async (item) => {
      const path = join(item.root, "versions", "1001.7", "extra.bin");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "no");
    },
    async (item) => {
      const path = join(item.root, "versions", "01.7", "Document.mlbytes");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "no");
    },
  ]) {
    await withFixture(async (item) => {
      await mutation(item);
      await assert.rejects(
        validatePublicContentDelivery(item.root, { publicKeys: { [KEY_ID]: item.publicKey } }),
        /allowlist|invalid version directory/,
      );
    });
  }
});

test("rejects unsafe, mutable, and version-mismatched content paths", async () => {
  await withFixture(async ({ root, manifest, privateKey, publicKey }) => {
    for (const unsafe of [
      "../Document.mlbytes",
      "/versions/1001.6/Document.mlbytes",
      "versions/1001.6/../Document.mlbytes",
      "versions/1001.6/assets/Document.mlbytes",
      "versions/1001.7/Document.mlbytes",
    ]) {
      manifest.content.path = unsafe;
      await writeSignedManifest(root, manifest, privateKey);
      await assert.rejects(
        validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
        /content\.path/,
      );
    }
  });
});

test("legacy projection exactly matches the independent historical Java/Python fixtures", async () => {
  const documents = await legacyFixtureDocuments();
  const files = projectLegacyContent(exactNumericFixture(documents["heroes.json"]),
    exactNumericFixture(documents["skin-tags.json"]), exactNumericFixture(documents["preparations.json"]));
  assert.equal(files.size, 5);
  for (const [name, bytes] of files) {
    assert.deepEqual(bytes, await readFile(join(legacyFixtureRoot, name)), name);
  }
});

test("accepts exactly five legacy files without changing the signed manifest schema", async () => {
  await withLegacyFixture(async ({ root, publicKey, manifest }) => {
    assert.deepEqual(Object.keys(manifest), ["schemaVersion", "publicationSequence", "channel",
      "publishedAt", "content", "client"]);
    const result = await validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } });
    assert.equal(result.legacyFileCount, 5);
    const unchanged = await validatePublicContentTransition(root, root, {
      publicKeys: { [KEY_ID]: publicKey },
    });
    assert.equal(unchanged.manifestChanged, false);
  });
});

test("permits the first legacy publication and retains companions for settings-only updates", async () => {
  const documents = await legacyFixtureDocuments();
  await withFixture(async (oldTree) => {
    const newRoot = await mkdtemp(join(tmpdir(), "nutcx-legacy-add-"));
    try {
      await cp(oldTree.root, newRoot, { recursive: true });
      await writeLegacyFixture(newRoot, documents);
      const initial = await validatePublicContentTransition(oldTree.root, newRoot, {
        publicKeys: { [KEY_ID]: oldTree.publicKey },
      });
      assert.equal(initial.legacyFileCount, 5);
      assert.equal(initial.manifestChanged, false);

      const updated = structuredClone(oldTree.manifest);
      updated.publicationSequence += 1;
      updated.client.features["example.enabled"] = true;
      await writeSignedManifest(newRoot, updated, oldTree.privateKey);
      const settings = await validatePublicContentTransition(oldTree.root, newRoot, {
        publicKeys: { [KEY_ID]: oldTree.publicKey },
      });
      assert.equal(settings.manifestChanged, true);
      assert.equal(settings.legacyFileCount, 5);
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  }, { documentOptions: { entries: entriesForDocuments(documents) } });
});

test("rejects stale companions after a new signed content release, then accepts their refresh", async () => {
  await withLegacyFixture(async (oldTree) => {
    const newRoot = await mkdtemp(join(tmpdir(), "nutcx-legacy-refresh-"));
    try {
      await cp(oldTree.root, newRoot, { recursive: true });
      const documents = structuredClone(oldTree.documents);
      documents["heroes.json"].heroes[0].skins[0].name = "Updated source";
      const bytes = signedDocument({ privateKey: oldTree.privateKey, version: "1001.7",
        entries: entriesForDocuments(documents) });
      const target = join(newRoot, "versions", "1001.7", "Document.mlbytes");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
      await writeSignedManifest(newRoot,
        manifestFor(bytes, { version: "1001.7", publicationSequence: 8 }), oldTree.privateKey);
      await assert.rejects(validatePublicContentTransition(oldTree.root, newRoot, {
        publicKeys: { [KEY_ID]: oldTree.publicKey },
      }), /does not match the verified current Document/);
      await writeLegacyFixture(newRoot, documents);
      const result = await validatePublicContentTransition(oldTree.root, newRoot, {
        publicKeys: { [KEY_ID]: oldTree.publicKey },
      });
      assert.equal(result.contentVersion, "1001.7");
      assert.equal(result.legacyFileCount, 5);
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  });
});

test("rejects tampering in every generated legacy file", async () => {
  for (const name of LEGACY_NAMES) {
    await withLegacyFixture(async ({ root, publicKey }) => {
      const path = join(root, "legacy", name);
      const bytes = await readFile(path);
      bytes[0] ^= 1;
      await writeFile(path, bytes);
      await assert.rejects(validatePublicContentDelivery(root, {
        publicKeys: { [KEY_ID]: publicKey },
      }), /does not match the verified current Document/);
    });
  }
});

test("rejects partial legacy directories, extra files, wrong entry kinds, and oversized files", async () => {
  for (const mutate of [
    (root) => rm(join(root, "legacy", LEGACY_NAMES[0])),
    (root) => writeFile(join(root, "legacy", "heroes.json"), "{}"),
    async (root) => {
      const path = join(root, "legacy", LEGACY_NAMES[0]);
      await rm(path);
      await mkdir(path);
    },
    async (root) => {
      await rm(join(root, "legacy"), { recursive: true });
      await writeFile(join(root, "legacy"), "not a directory");
    },
    (root) => writeFile(join(root, "legacy", LEGACY_NAMES[0]), Buffer.alloc(8 * 1024 * 1024 + 17)),
  ]) {
    await withLegacyFixture(async ({ root, publicKey }) => {
      await mutate(root);
      await assert.rejects(validatePublicContentDelivery(root, {
        publicKeys: { [KEY_ID]: publicKey },
      }), /allowlist|non-symlink|file-size limit|invalid size/);
    });
  }
});

test("rejects a symlinked legacy directory", async () => {
  await withLegacyFixture(async ({ root, publicKey }) => {
    const targetRoot = await mkdtemp(join(tmpdir(), "nutcx-legacy-target-"));
    try {
      await cp(join(root, "legacy"), targetRoot, { recursive: true });
      await rm(join(root, "legacy"), { recursive: true });
      await symlink(targetRoot, join(root, "legacy"), process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(validatePublicContentDelivery(root, {
        publicKeys: { [KEY_ID]: publicKey },
      }), /non-symlink directory/);
    } finally {
      await rm(join(root, "legacy"), { recursive: true, force: true });
      await rm(targetRoot, { recursive: true, force: true });
    }
  });
});

test("does not permit removing an already-published legacy directory", async () => {
  await withLegacyFixture(async (oldTree) => {
    const newRoot = await mkdtemp(join(tmpdir(), "nutcx-legacy-remove-"));
    try {
      await cp(oldTree.root, newRoot, { recursive: true });
      await rm(join(newRoot, "legacy"), { recursive: true });
      await assert.rejects(validatePublicContentTransition(oldTree.root, newRoot, {
        publicKeys: { [KEY_ID]: oldTree.publicKey },
      }), /legacy directory may not be removed/);
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  });
});

test("preserves signed-64 timestamps exactly when checking legacy bytes", async () => {
  await withLegacyFixture(async (item) => {
    const entries = entriesForDocuments(item.documents);
    entries.set("heroes.json", Buffer.from(entries.get("heroes.json").toString("utf8")
      .replace('"timestamp":1727371147739', '"timestamp":9223372036854775807')));
    await replaceDocument(item, signedDocument({ privateKey: item.privateKey, entries }));
    const heroes = exactNumericFixture(item.documents["heroes.json"]);
    heroes.heroes[0].skins[0].timestamp = 9_223_372_036_854_775_807n;
    const files = projectLegacyContent(heroes, exactNumericFixture(item.documents["skin-tags.json"]),
      exactNumericFixture(item.documents["preparations.json"]));
    for (const [name, bytes] of files) await writeFile(join(item.root, "legacy", name), bytes);
    const result = await validatePublicContentDelivery(item.root, {
      publicKeys: { [KEY_ID]: item.publicKey },
    });
    assert.equal(result.legacyFileCount, 5);
  });
});

test("fails closed on duplicate JSON keys, invalid numbers, Unicode, and unresolved legacy joins", async () => {
  for (const mutate of [
    (raw) => raw.replace('"heroId":1', '"heroId":1,"heroId":1'),
    (raw) => raw.replace('"heroId":1', '"heroId":2147483648'),
    (raw) => raw.replace('"timestamp":2', '"timestamp":2.5'),
    (raw) => raw.replace('"timestamp":2', '"timestamp":9223372036854775808'),
    (raw) => raw.replace('"name":"Base"', '"name":"\\ud800"'),
    (raw) => raw.replace('"targetSkinId":1012', '"targetSkinId":9999'),
  ]) {
    await withLegacyFixture(async (item) => {
      const entries = entriesForDocuments(item.documents);
      entries.set("heroes.json", Buffer.from(mutate(entries.get("heroes.json").toString("utf8"))));
      await replaceDocument(item, signedDocument({ privateKey: item.privateKey, entries }));
      await assert.rejects(validatePublicContentDelivery(item.root, {
        publicKeys: { [KEY_ID]: item.publicKey },
      }), /duplicate key|Legacy projection/);
    });
  }
});

test("projects modern preparation sources and variants without inventing catalog-only groups", async () => {
  const document = {
    preparationSchemaVersion: 4,
    types: [{ key: "effects.recall", name: "Recall", items: [
      { category: 0, id: 0, name: "Classic", image: "classic.webp", source: {
        backupArchive: "", upgrades: [
          { targetCategory: 0, targetId: 101, archive: "one.zip" },
          { targetCategory: 0, targetId: 101, name: "Variant", image: "variant.webp", archive: "" },
          { targetCategory: 1, targetId: 101, archive: "custom.zip" },
        ],
      } },
      { category: 0, id: 101, name: "Official", image: "official.webp", source: null },
      { category: 1, id: 101, name: "Custom", image: "custom.webp", source: {
        backupArchive: "custom-backup.zip", upgrades: [
          { targetCategory: 1, targetId: 101, archive: "self.zip" },
        ],
      } },
    ] }, { key: "effects.trail", name: "Trail", items: [
      { category: 0, id: 0, name: "Classic", image: "trail.webp", source: { backupArchive: "", upgrades: [] } },
    ] }],
  };
  const rows = decodePreparationRows(preparationBytes(document));
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  assert.equal(rows[0].type, 1);
  assert.equal(rows[2].type, 5);
  assert.equal(rows[0].archive, "");
  assert.deepEqual(rows[0].items, [
    { name: "Official", tag: -1, image: "official.webp", archive: "one.zip" },
    { name: "Variant", tag: -1, image: "variant.webp", archive: "" },
    { name: "Custom", tag: -1, image: "custom.webp", archive: "custom.zip" },
  ]);
  assert.deepEqual(rows[1].items, [{ name: "Custom", tag: -1, image: "custom.webp", archive: "self.zip" }]);
  document.types[0].name = "Renamed type display";
  document.types[0].items[0].name = "Renamed source";
  document.types.reverse();
  const reordered = decodePreparationRows(preparationBytes(document));
  assert.equal(reordered[0].id, rows[2].id);
  assert.equal(reordered[1].id, rows[0].id);
  assert.equal(reordered[2].id, rows[1].id);
});

test("uses the original preparation type enum and leaves unknown types and child tags unknown", () => {
  const keys = ["battle-emote", "recall", "spawn", "elimination", "notification", "trail", "radiant-kits", "future"];
  const document = { preparationSchemaVersion: 4, types: keys.map((key) => ({
    key: `effects.${key}`, name: key, items: [{ category: 0, id: 0, name: "Classic", image: "", source: {
      backupArchive: "", upgrades: [{ targetCategory: 0, targetId: 0, archive: "" }],
    } }],
  })) };
  const rows = decodePreparationRows(preparationBytes(document));
  assert.deepEqual(rows.map((row) => row.type), [0, 1, 2, 3, 4, 5, -1, -1]);
  assert.equal(new Set(rows.map((row) => row.id)).size, keys.length);
  assert.ok(rows.every((row) => row.items[0].tag === -1));
});

test("rejects unresolved preparation targets and duplicate identities instead of dropping rows", () => {
  const document = { preparationSchemaVersion: 4, types: [{ key: "effects.recall", items: [
    { category: 0, id: 0, name: "Classic", image: "", source: { backupArchive: "", upgrades: [
      { targetCategory: 1, targetId: 0, archive: "" },
    ] } },
  ] }] };
  assert.throws(() => preparationBytes(document), /missing preparation route target/);
  document.types[0].items[0].source.upgrades = [];
  document.types[0].items.push(structuredClone(document.types[0].items[0]));
  assert.throws(() => preparationBytes(document), /duplicate preparation effect/);
});

test("matches the Dart schema-4 preparation fixture and validates it against the signed Document", async () => {
  const documents = await legacyFixtureDocuments();
  documents["preparations.json"] = JSON.parse(await readFile(new URL(
    "./fixtures/legacy-preparation-export/preparations.json", import.meta.url), "utf8"));
  const bytes = preparationBytes(documents["preparations.json"]);
  assert.equal(bytes.length, 576);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "ce5209079a34b8b18d9452becb68e1820cd003632b3dcfce1ed8e183a08de3ab");
  const rows = decodePreparationRows(bytes);
  assert.equal(rows.length, 4);
  assert.equal(rows.reduce((total, row) => total + row.items.length, 0), 6);
  assert.equal(rows[0].id, 1_466_205_851);

  await withFixture(async (item) => {
    await writeLegacyFixture(item.root, documents);
    assert.equal((await validatePublicContentDelivery(item.root, {
      publicKeys: { [KEY_ID]: item.publicKey },
    })).legacyFileCount, 5);
    documents["preparations.json"].types[0].items[0].source.upgrades[0].archive = "changed.zip";
    await replaceDocument(item, signedDocument({ privateKey: item.privateKey,
      entries: entriesForDocuments(documents) }));
    await assert.rejects(validatePublicContentDelivery(item.root, {
      publicKeys: { [KEY_ID]: item.publicKey },
    }), /legacy\/819204176.mlbytes does not match the verified current Document/);
    await writeLegacyFixture(item.root, documents);
    await validatePublicContentDelivery(item.root, { publicKeys: { [KEY_ID]: item.publicKey } });
  }, { documentOptions: { entries: entriesForDocuments(documents) } });
});

test("fails closed on a real preparation alias hash collision", () => {
  const document = { preparationSchemaVersion: 4, types: [{ key: "effects.recall", items:
    [509, 12123].map((id) => ({ category: 0, id, name: `Effect ${id}`, image: "", source: {
      backupArchive: "", upgrades: [],
    } })),
  }] };
  assert.throws(() => preparationBytes(document), /preparation ID collision/);
});

test("checks the referenced file size and SHA-256", async () => {
  await withFixture(async ({ root, contentFile, contentBytes, manifest, privateKey, publicKey }) => {
    manifest.content.sizeBytes += 1;
    await writeSignedManifest(root, manifest, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /content size mismatch/,
    );

    manifest.content.sizeBytes = contentBytes.length;
    await writeSignedManifest(root, manifest, privateKey);
    const tampered = Buffer.from(contentBytes);
    tampered[0] ^= 1;
    await writeFile(contentFile, tampered);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /SHA-256 mismatch/,
    );
  });
});

test("independently validates the embedded signed MLBytes bundle", async () => {
  const cases = [
    { options: ({ privateKey }) => ({ privateKey, signed: false }), message: /must be signed/ },
    { options: ({ privateKey }) => ({ privateKey, schemaVersion: 2 }), message: /content schema 3/ },
    { options: ({ privateKey }) => ({ privateKey, minimumAppVersionCode: 10 }), message: /at least 11/ },
    { options: ({ privateKey }) => ({ privateKey, version: "1001.7" }), message: /does not match manifest version/ },
    { options: ({ privateKey }) => ({ privateKey, keyId: "untrusted-document-key" }), message: /untrusted key ID/ },
    { options: ({ privateKey }) => ({ privateKey, corruptEntryDigest: true }), message: /SHA-256 mismatch/ },
  ];
  for (const currentCase of cases) {
    await withFixture(async (item) => {
      await replaceDocument(item, signedDocument(currentCase.options(item)));
      await assert.rejects(
        validatePublicContentDelivery(item.root, { publicKeys: { [KEY_ID]: item.publicKey } }),
        currentCase.message,
      );
    });
  }

  await withFixture(async (item) => {
    const tampered = Buffer.from(item.contentBytes);
    tampered[tampered.length - 1] ^= 1;
    await replaceDocument(item, tampered);
    await assert.rejects(
      validatePublicContentDelivery(item.root, { publicKeys: { [KEY_ID]: item.publicKey } }),
      /signature does not authenticate/,
    );
  });
});

test("enforces embedded client policy and config behavior", async () => {
  await withFixture(async ({ root, manifest, privateKey, publicKey }) => {
    manifest.client.policy.title = "A NORMAL policy cannot display this";
    await writeSignedManifest(root, manifest, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /NORMAL must not contain presentation fields/,
    );

    manifest.client.policy.title = "";
    manifest.client.config.originalCdnRoots = ["http://example.com"];
    await writeSignedManifest(root, manifest, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /HTTP for a host that is not approved/,
    );
  });
});

test("accepts the complete signed-64 publication sequence range without rounding", async () => {
  await withFixture(async ({ root, manifest, privateKey, publicKey }) => {
    const raw = `${JSON.stringify(manifest, null, 2)}`
      .replace('"publicationSequence": 7', '"publicationSequence": 9223372036854775807')
      + "\n";
    await writeSignedManifest(root, raw, privateKey);
    const result = await validatePublicContentDelivery(root, {
      publicKeys: { [KEY_ID]: publicKey },
    });
    assert.equal(result.publicationSequence, "9223372036854775807");
  });
});

test("accepts an unchanged delivery and a monotonic new content release", async () => {
  await withFixture(async (item) => {
    const unchanged = await validatePublicContentTransition(item.root, item.root, {
      publicKeys: { [KEY_ID]: item.publicKey },
    });
    assert.equal(unchanged.manifestChanged, false);
    assert.deepEqual(unchanged.addedContentPaths, []);
  });

  await withTransition(async ({ oldTree, newTree }) => {
    const result = await validatePublicContentTransition(oldTree.root, newTree.root, {
      publicKeys: { [KEY_ID]: oldTree.publicKey },
    });
    assert.equal(result.manifestChanged, true);
    assert.deepEqual(result.addedContentPaths, [newTree.contentPath]);
  }, {
    previous: { version: "1001.6", publicationSequence: 7 },
    current: { version: "1001.7", publicationSequence: 8 },
  });
});

test("requires a strictly increasing sequence for every manifest byte change", async () => {
  await withFixture(async (oldTree) => {
    const newRoot = await mkdtemp(join(tmpdir(), "nutcx-public-content-copy-"));
    try {
      await cp(oldTree.root, newRoot, { recursive: true });
      const changed = structuredClone(oldTree.manifest);
      changed.publishedAt = "2026-09-26T04:05:07Z";
      await writeSignedManifest(newRoot, changed, oldTree.privateKey);
      await assert.rejects(
        validatePublicContentTransition(oldTree.root, newRoot, {
          publicKeys: { [KEY_ID]: oldTree.publicKey },
        }),
        /strictly increasing publicationSequence/,
      );
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  });
});

test("rejects content rollback and same-version descriptor collisions", async () => {
  await withTransition(async ({ oldTree, newTree }) => {
    await assert.rejects(
      validatePublicContentTransition(oldTree.root, newTree.root, {
        publicKeys: { [KEY_ID]: oldTree.publicKey },
      }),
      /content version rollback/,
    );
  }, {
    previous: { version: "1001.7", publicationSequence: 7 },
    current: { version: "1001.6", publicationSequence: 8 },
  });

  await withFixture(async (oldTree) => {
    const newRoot = await mkdtemp(join(tmpdir(), "nutcx-public-content-copy-"));
    try {
      await cp(oldTree.root, newRoot, { recursive: true });
      const replacement = signedDocument({
        privateKey: oldTree.privateKey,
        version: CONTENT_VERSION,
        minimumAppVersionCode: 12,
      });
      await writeFile(join(newRoot, ...oldTree.contentPath.split("/")), replacement);
      const changed = manifestFor(replacement, { version: CONTENT_VERSION, publicationSequence: 8 });
      await writeSignedManifest(newRoot, changed, oldTree.privateKey);
      await assert.rejects(
        validatePublicContentTransition(oldTree.root, newRoot, {
          publicKeys: { [KEY_ID]: oldTree.publicKey },
        }),
        /descriptor collision/,
      );
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  });
});

test("rejects policy and config revision rollback or same-revision collision", async () => {
  for (const mutate of [
    (manifest) => { manifest.client.policy.revision = 6; },
    (manifest) => { manifest.client.policy.policyId = "changed-without-revision"; },
    (manifest) => { manifest.client.config.revision = 2; },
    (manifest) => { manifest.client.config.originalResourceRoot = "android2"; },
  ]) {
    await withFixture(async (oldTree) => {
      const newRoot = await mkdtemp(join(tmpdir(), "nutcx-public-content-copy-"));
      try {
        await cp(oldTree.root, newRoot, { recursive: true });
        const changed = structuredClone(oldTree.manifest);
        changed.publicationSequence = 8;
        mutate(changed);
        await writeSignedManifest(newRoot, changed, oldTree.privateKey);
        await assert.rejects(
          validatePublicContentTransition(oldTree.root, newRoot, {
            publicKeys: { [KEY_ID]: oldTree.publicKey },
          }),
          /revision rollback|without increasing its revision/,
        );
      } finally {
        await rm(newRoot, { recursive: true, force: true });
      }
    });
  }
});

test("preserves every historical version exactly and permits no inactive additions", async () => {
  await withTransition(async ({ oldTree, newTree }) => {
    const oldCopy = join(newTree.root, ...oldTree.contentPath.split("/"));
    const changed = await readFile(oldCopy);
    changed[changed.length - 1] ^= 1;
    await writeFile(oldCopy, changed);
    await assert.rejects(
      validatePublicContentTransition(oldTree.root, newTree.root, {
        publicKeys: { [KEY_ID]: oldTree.publicKey },
      }),
      /immutable content file changed/,
    );
  }, {
    previous: { version: "1001.6" },
    current: { version: "1001.7" },
  });

  await withTransition(async ({ oldTree, newTree }) => {
    await rm(dirname(join(newTree.root, ...oldTree.contentPath.split("/"))), {
      recursive: true,
      force: true,
    });
    await assert.rejects(
      validatePublicContentTransition(oldTree.root, newTree.root, {
        publicKeys: { [KEY_ID]: oldTree.publicKey },
      }),
      /immutable content file was removed/,
    );
  }, {
    previous: { version: "1001.6" },
    current: { version: "1001.7" },
  });

  await withFixture(async (oldTree) => {
    const newRoot = await mkdtemp(join(tmpdir(), "nutcx-public-content-copy-"));
    try {
      await cp(oldTree.root, newRoot, { recursive: true });
      const inactive = signedDocument({ privateKey: oldTree.privateKey, version: "999.1" });
      const inactivePath = join(newRoot, "versions", "999.1", "Document.mlbytes");
      await mkdir(dirname(inactivePath), { recursive: true });
      await writeFile(inactivePath, inactive);
      await assert.rejects(
        validatePublicContentTransition(oldTree.root, newRoot, {
          publicKeys: { [KEY_ID]: oldTree.publicKey },
        }),
        /only the active content version may be added/,
      );
    } finally {
      await rm(newRoot, { recursive: true, force: true });
    }
  });
});
