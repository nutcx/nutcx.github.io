#!/usr/bin/env node

import { resolve } from "node:path";
import {
  validatePublicContentDelivery,
  validatePublicContentTransition,
} from "./public-content-manifest.mjs";

function usage() {
  console.log(`Usage:
  node scripts/validate-public-content-manifest.mjs [delivery-root] \\
    [--previous-root <previous-delivery-root>] \\
    --public-key <key-id>=<base64-X509-SPKI-DER>

Defaults to public/content. Repeat --public-key to configure key rotation.
When --previous-root is present, immutable files and monotonic release state are also checked.`);
}

function parseArguments(argv) {
  let root = "public/content";
  let rootSeen = false;
  let previousRoot;
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
    if (argument === "--previous-root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--previous-root requires a directory");
      if (previousRoot) throw new Error("--previous-root may be supplied only once");
      previousRoot = resolve(value);
      index += 1;
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
  return { root: resolve(root), previousRoot, publicKeys };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = options.previousRoot
    ? await validatePublicContentTransition(options.previousRoot, options.root, {
      publicKeys: options.publicKeys,
    })
    : await validatePublicContentDelivery(options.root, {
      publicKeys: options.publicKeys,
    });
  console.log(
    `Public content delivery is valid: ${result.contentVersion}, `
      + `${result.contentSizeBytes} bytes, sequence ${result.publicationSequence}, `
      + `manifest key ${result.signatureKeyId}, document key ${result.documentSignatureKeyId}, `
      + `${result.legacyFileCount} legacy files.`
      + (options.previousRoot
        ? ` Transition from sequence ${result.previousPublicationSequence} is valid.`
        : ""),
  );
} catch (error) {
  console.error(`Public content delivery validation failed: ${error.message}`);
  process.exitCode = 1;
}
