#!/usr/bin/env node

import { resolve } from "node:path";
import { validatePublicContentDelivery } from "./public-content-manifest.mjs";

function usage() {
  console.log(`Usage:
  node scripts/validate-public-content-manifest.mjs [delivery-root] \\
    --public-key <key-id>=<base64-X509-SPKI-DER>

Defaults to public/content. Repeat --public-key to configure key rotation.`);
}

function parseArguments(argv) {
  let root = "public/content";
  let rootSeen = false;
  const publicKeys = Object.create(null);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      usage();
      process.exit(0);
    }
    if (argument === "--public-key") {
      const pair = argv[index + 1];
      if (!pair) throw new Error("--public-key requires <key-id>=<base64-X509-SPKI-DER>");
      index += 1;
      const separator = pair.indexOf("=");
      if (separator <= 0 || separator === pair.length - 1) {
        throw new Error("--public-key requires <key-id>=<base64-X509-SPKI-DER>");
      }
      const keyId = pair.slice(0, separator);
      if (Object.hasOwn(publicKeys, keyId)) throw new Error(`Duplicate public key ID: ${keyId}`);
      publicKeys[keyId] = pair.slice(separator + 1);
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (rootSeen) throw new Error("Only one delivery root may be supplied");
    root = argument;
    rootSeen = true;
  }

  if (Object.keys(publicKeys).length === 0) {
    throw new Error("At least one trusted --public-key is required");
  }
  return { root: resolve(root), publicKeys };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await validatePublicContentDelivery(options.root, {
    publicKeys: options.publicKeys,
  });
  console.log(
    `Public content delivery is valid: ${result.contentVersion}, `
      + `${result.contentSizeBytes} bytes, sequence ${result.publicationSequence}, `
      + `key ${result.signatureKeyId}.`,
  );
} catch (error) {
  console.error(`Public content delivery validation failed: ${error.message}`);
  process.exitCode = 1;
}
