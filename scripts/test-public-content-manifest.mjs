import assert from "node:assert/strict";
import {
  createHash,
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

const KEY_ID = "fixture-content-key";
const CONTENT_VERSION = "1001.6";
const SIGNATURE_MAGIC = Buffer.from([0x4d, 0x4c, 0x42, 0x53, 0x49, 0x47, 0, 0]);
const BUNDLE_MAGIC = Buffer.from([0x4d, 0x4c, 0x42, 0x59, 0x54, 0x45, 0x53, 0]);
const MANIFEST_DOMAIN = Buffer.from("MLBYTES-MANIFEST-V1", "ascii");
const BUNDLE_DOMAIN = Buffer.from("MLBYTES-SIGNATURE-V1", "ascii");
const validatorPath = fileURLToPath(new URL("./validate-public-content-manifest.mjs", import.meta.url));

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
