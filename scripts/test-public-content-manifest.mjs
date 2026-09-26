import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  sign as signEd25519,
} from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PublicContentManifestError,
  validatePublicContentDelivery,
} from "./public-content-manifest.mjs";

const KEY_ID = "fixture-content-key";
const CONTENT_VERSION = "1001.6";
const CONTENT_PATH = `versions/${CONTENT_VERSION}/Document.mlbytes`;
const SIGNATURE_MAGIC = Buffer.from([0x4d, 0x4c, 0x42, 0x53, 0x49, 0x47, 0, 0]);
const MANIFEST_DOMAIN = Buffer.from("MLBYTES-MANIFEST-V1", "ascii");
const validatorPath = fileURLToPath(new URL("./validate-public-content-manifest.mjs", import.meta.url));

function signatureBlock(manifestBytes, privateKey, keyId = KEY_ID) {
  const keyIdBytes = Buffer.from(keyId, "utf8");
  const prefix = Buffer.alloc(16 + keyIdBytes.length);
  SIGNATURE_MAGIC.copy(prefix, 0);
  prefix.writeUInt16LE(1, 8);
  prefix.writeUInt16LE(1, 10);
  prefix.writeUInt16LE(keyIdBytes.length, 12);
  prefix.writeUInt16LE(64, 14);
  keyIdBytes.copy(prefix, 16);
  const signed = Buffer.concat([
    MANIFEST_DOMAIN,
    Buffer.from([0]),
    manifestBytes,
    prefix,
  ]);
  return Buffer.concat([prefix, signEd25519(null, signed, privateKey)]);
}

function manifestFor(contentBytes) {
  return {
    schemaVersion: 1,
    publicationSequence: 7,
    channel: "production",
    publishedAt: "2026-09-26T04:05:06Z",
    content: {
      version: CONTENT_VERSION,
      path: CONTENT_PATH,
      sha256: createHash("sha256").update(contentBytes).digest("hex"),
      sizeBytes: contentBytes.length,
    },
    client: {
      policy: {
        schemaVersion: 1,
        policyId: "normal-7",
        revision: 7,
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
        configId: "resources-3",
        revision: 3,
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

async function writeSignedManifest(root, value, privateKey) {
  const bytes = Buffer.from(
    typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(root, "manifest.json"), bytes);
  await writeFile(join(root, "manifest.sig"), signatureBlock(bytes, privateKey));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nutcx-public-content-"));
  const contentBytes = Buffer.from("fixture canonical content\n", "utf8");
  const contentFile = join(root, ...CONTENT_PATH.split("/"));
  await mkdir(dirname(contentFile), { recursive: true });
  await writeFile(contentFile, contentBytes);
  const keys = generateKeyPairSync("ed25519");
  const manifest = manifestFor(contentBytes);
  await writeSignedManifest(root, manifest, keys.privateKey);
  return {
    root,
    contentBytes,
    contentFile,
    manifest,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    publicKeyBase64: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

async function withFixture(run) {
  const current = await fixture();
  try {
    await run(current);
  } finally {
    await rm(current.root, { recursive: true, force: true });
  }
}

test("validates a signed manifest and the exact referenced immutable file", async () => {
  await withFixture(async ({ root, publicKey, publicKeyBase64 }) => {
    const result = await validatePublicContentDelivery(root, {
      publicKeys: new Map([[KEY_ID, publicKey]]),
    });
    assert.deepEqual(result, {
      publicationSequence: "7",
      contentVersion: CONTENT_VERSION,
      contentPath: CONTENT_PATH,
      contentSha256: result.contentSha256,
      contentSizeBytes: 26,
      signatureKeyId: KEY_ID,
    });
    assert.match(result.contentSha256, /^[0-9a-f]{64}$/);

    const cli = spawnSync(
      process.execPath,
      [validatorPath, root, "--public-key", `${KEY_ID}=${publicKeyBase64}`],
      { encoding: "utf8" },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /Public content delivery is valid: 1001\.6/);
  });
});

test("rejects tampered signatures before parsing manifest data", async () => {
  await withFixture(async ({ root, publicKey }) => {
    const path = join(root, "manifest.sig");
    const signature = await readFile(path);
    signature[signature.length - 1] ^= 1;
    await writeFile(path, signature);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      (error) => error instanceof PublicContentManifestError
        && /does not authenticate/.test(error.message),
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
        unsafe,
      );
    }

    manifest.content.version = "0.6";
    manifest.content.path = "versions/0.6/Document.mlbytes";
    await writeSignedManifest(root, manifest, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /content\.version/,
    );
  });
});

test("checks the referenced local file size and SHA-256", async () => {
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

test("enforces embedded client policy behavior", async () => {
  await withFixture(async ({ root, manifest, privateKey, publicKey }) => {
    manifest.client.policy.title = "A NORMAL policy cannot display this";
    await writeSignedManifest(root, manifest, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /NORMAL must not contain presentation fields/,
    );

    const policy = manifestFor(Buffer.from("fixture canonical content\n")).client.policy;
    Object.assign(policy, {
      mode: "UPDATE_REQUIRED",
      title: "Update required",
      message: "Install the supported release.",
      minimumAppVersionCode: 42,
      latestVersionName: "2.0.0",
      dismissible: false,
      primaryAction: { label: "Update", url: "https://play.google.com/store/apps/details?id=com.nutcx.tools" },
    });
    manifest.client.policy = policy;
    await writeSignedManifest(root, manifest, privateKey);
    await validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } });
  });
});

test("enforces client config origins and bounded safe feature flags", async () => {
  await withFixture(async ({ root, manifest, privateKey, publicKey }) => {
    manifest.client.config.originalCdnRoots = ["http://example.com"];
    await writeSignedManifest(root, manifest, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /HTTP for a host that is not approved/,
    );

    manifest.client.config.originalCdnRoots = ["https://EXAMPLE.com/"];
    await writeSignedManifest(root, manifest, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /normalized origin form/,
    );

    manifest.client.config.originalCdnRoots = ["https://example.com"];
    manifest.client.features = { "bad..flag": true };
    await writeSignedManifest(root, manifest, privateKey);
    await assert.rejects(
      validatePublicContentDelivery(root, { publicKeys: { [KEY_ID]: publicKey } }),
      /unsafe key/,
    );
  });
});

test("accepts the complete signed-64 publication sequence range without number rounding", async () => {
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
