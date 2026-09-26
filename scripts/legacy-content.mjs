import { createCipheriv, createHash } from "node:crypto";

// Original client wire constants, not production signing credentials. These
// outputs are checked against the authenticated Document, never trusted alone.
const WIRE_KEY = Buffer.from("zonghub_gfx_2024", "ascii");
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_I32 = 2_147_483_647n;
const MAX_I64 = 9_223_372_036_854_775_807n;
const PREPARATION_TYPE_IDS = new Map([
  ["effects.battle-emote", 0],
  ["effects.recall", 1],
  ["effects.spawn", 2],
  ["effects.elimination", 3],
  ["effects.notification", 4],
  ["effects.trail", 5],
]);

export const LEGACY_NAMES = Object.freeze([
  "533271041.mlbytes",
  "789276696.mlbytes",
  "674624113.mlbytes",
  "181462965.mlbytes",
  "819204176.mlbytes",
]);

function invalid(message) {
  throw new Error(`Legacy projection: ${message}`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value;
}

function rows(value, label) {
  if (!Array.isArray(value) || value.length > MAX_ROWS) invalid(`${label} has invalid rows`);
  return value;
}

function integer(value, label, maximum = MAX_I32) {
  if (typeof value !== "bigint" || value < 0n || value > maximum) {
    invalid(`${label} must be an exact nonnegative integer within range`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || !value.isWellFormed()) invalid(`${label} must be valid Unicode text`);
  return value;
}

class Binary {
  #chunks = [];
  #size = 0;

  constructor(count) {
    this.integer(count);
  }

  append(bytes) {
    this.#size += bytes.length;
    if (this.#size > MAX_RAW_BYTES) invalid("a generated file exceeds its size limit");
    this.#chunks.push(bytes);
    return this;
  }

  integer(value) {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE(Number(BigInt.asUintN(32, BigInt(value))));
    return this.append(bytes);
  }

  text(value) {
    const bytes = Buffer.from(text(value, "binary field"), "utf8");
    const prefix = [];
    let length = bytes.length;
    while (length >= 128) {
      prefix.push((length & 127) | 128);
      length >>>= 7;
    }
    prefix.push(length);
    return this.append(Buffer.from(prefix)).append(bytes);
  }

  encrypt() {
    const cipher = createCipheriv("aes-128-cbc", WIRE_KEY, WIRE_KEY);
    return Buffer.concat([cipher.update(Buffer.concat(this.#chunks)), cipher.final()]);
  }
}

function identity(hero, category, id) {
  return `${hero}:${category}:${id}`;
}

function preparationRows(document) {
  object(document, "preparations.json");
  if (Object.hasOwn(document, "preparations")) {
    if (Object.hasOwn(document, "types") || Object.hasOwn(document, "preparationSchemaVersion")) {
      invalid("mixed preparation schemas");
    }
    const preparations = rows(document.preparations, "preparations");
    const output = new Binary(preparations.length);
    const ids = new Set();
    for (const row of preparations) {
      const preparation = object(row, "preparation");
      const id = integer(preparation.preparationId, "preparationId");
      if (ids.has(id)) invalid(`duplicate preparation ID ${id}`);
      ids.add(id);
      const items = rows(preparation.items, "preparation items");
      output.integer(id).integer(-1).text(preparation.name).text(preparation.image)
        .text(preparation.archive).integer(items.length);
      for (const itemRow of items) {
        const item = object(itemRow, "preparation item");
        output.text(item.name).integer(-1).text(item.image).text(item.archive);
      }
    }
    return output;
  }
  if (document.preparationSchemaVersion !== 4n) invalid("unsupported preparation schema");
  const types = rows(document.types, "preparation types");
  const keys = new Set();
  const catalog = new Map();
  const sources = [];
  const aliases = new Map();
  const usedAliases = new Set();
  let itemCount = 0;
  let routeCount = 0;
  for (const typeRow of types) {
    const type = object(typeRow, "preparation type");
    const typeKey = text(type.key, "preparation type key");
    if (keys.has(typeKey)) invalid(`duplicate preparation type ${typeKey}`);
    keys.add(typeKey);
    for (const itemRow of rows(type.items, "preparation effects")) {
      const item = object(itemRow, "preparation effect");
      const category = integer(item.category, "preparation category");
      const id = integer(item.id, "preparation effect id");
      text(item.name, "preparation effect name");
      text(item.image, "preparation effect image");
      const key = `${typeKey}:${category}:${id}`;
      if (catalog.has(key)) invalid(`duplicate preparation effect ${key}`);
      catalog.set(key, item);
      itemCount += 1;
      if (itemCount > MAX_ROWS) invalid("too many preparation effects");
      if (item.source === null) continue;
      const source = object(item.source, "preparation source");
      text(source.backupArchive, "preparation backupArchive");
      const upgrades = rows(source.upgrades, "preparation upgrades");
      routeCount += upgrades.length;
      if (routeCount > MAX_ROWS) invalid("too many preparation routes");
      for (const routeRow of upgrades) {
        const route = object(routeRow, "preparation route");
        integer(route.targetCategory, "preparation targetCategory");
        integer(route.targetId, "preparation targetId");
        text(route.archive, "preparation archive");
        if (Object.hasOwn(route, "name")) text(route.name, "preparation route name");
        if (Object.hasOwn(route, "image")) text(route.image, "preparation route image");
      }
      const digest = createHash("sha256").update(`preparation:${key}`, "utf8").digest();
      const alias = 0x40000000 | (digest.readUInt32BE(0) & 0x3fffffff);
      if (usedAliases.has(alias)) invalid(`preparation ID collision for ${key}`);
      usedAliases.add(alias);
      aliases.set(key, alias);
      sources.push({ typeKey, key, item });
    }
  }
  const output = new Binary(sources.length);
  for (const { typeKey, key, item } of sources) {
    output.integer(aliases.get(key)).integer(PREPARATION_TYPE_IDS.get(typeKey) ?? -1)
      .text(item.name).text(item.image)
      .text(item.source.backupArchive).integer(item.source.upgrades.length);
    for (const route of item.source.upgrades) {
      const targetKey = `${typeKey}:${route.targetCategory}:${route.targetId}`;
      const target = catalog.get(targetKey);
      if (!target) invalid(`missing preparation route target ${targetKey}`);
      output.text(Object.hasOwn(route, "name") ? route.name : target.name).integer(-1)
        .text(Object.hasOwn(route, "image") ? route.image : target.image).text(route.archive);
    }
  }
  return output;
}

/** Pure projection of parsed authenticated entries. Numeric JSON values must be BigInts. */
export function projectLegacyContent(heroesDocument, tagsDocument, preparationsDocument) {
  const heroes = rows(object(heroesDocument, "heroes.json").heroes, "heroes");
  const tags = rows(object(tagsDocument, "skin-tags.json").tags, "tags");
  const skins = [];
  const catalog = new Map();
  const ids = new Map();
  const used = new Set();
  const seenHeroes = new Set();
  const backups = new Map();
  let sourceCount = 0;
  let routeCount = 0;
  for (const heroRecord of heroes) {
    const hero = integer(object(heroRecord, "hero").heroId, "heroId");
    if (seenHeroes.has(hero)) invalid(`duplicate hero ${hero}`);
    seenHeroes.add(hero);
    for (const skinRecord of rows(heroRecord.skins, "skins")) {
      const skin = object(skinRecord, "skin");
      const category = integer(skin.category, "category");
      const skinId = integer(skin.skinId, "skinId");
      for (const name of ["name", "type", "portrait", "landscape"]) text(skin[name], name);
      integer(skin.timestamp, "timestamp", MAX_I64);
      const key = identity(hero, category, skinId);
      let alias = skinId;
      if (category !== 0n) {
        const digest = createHash("sha256").update(key, "ascii").digest();
        alias = BigInt(0x40000000 | (digest.readUInt32BE(0) & 0x3fffffff));
      }
      const joined = `${hero}:${alias}`;
      if (catalog.has(key) || used.has(joined)) invalid(`skin ID collision for ${key}`);
      used.add(joined);
      catalog.set(key, skin);
      ids.set(key, alias);
      skins.push({ hero, skin, key });
      if (skins.length > MAX_ROWS) invalid("too many skin rows");
      if (skin.source !== null) {
        const source = object(skin.source, "source");
        text(source.backupArchive, "backupArchive");
        const upgrades = rows(source.upgrades, "upgrades");
        sourceCount += 1;
        routeCount += upgrades.length;
        if (routeCount > MAX_ROWS) invalid("too many upgrade rows");
        const targets = new Set();
        for (const routeRecord of upgrades) {
          const route = object(routeRecord, "upgrade");
          const targetKey = identity(hero, integer(route.targetCategory, "targetCategory"),
            integer(route.targetSkinId, "targetSkinId"));
          text(route.archive, "archive");
          if (targets.has(targetKey)) invalid(`duplicate route target ${targetKey}`);
          targets.add(targetKey);
        }
        if (skin.type.toLowerCase() === "backup") {
          if (backups.has(hero)) invalid(`multiple Backup skins for hero ${hero}`);
          backups.set(hero, skin);
        }
      }
    }
  }

  const scripts = new Map();
  for (const [hero, backup] of backups) {
    for (const route of backup.source.upgrades) {
      scripts.set(identity(hero, route.targetCategory, route.targetSkinId), route.archive);
    }
    scripts.set(identity(hero, backup.category, backup.skinId), backup.source.backupArchive);
  }

  const skinRows = new Binary(skins.length);
  const sourceRows = new Binary(sourceCount);
  const routeRows = new Binary(routeCount);
  for (const { hero, skin, key } of skins) {
    skinRows.integer(hero).integer(ids.get(key)).integer(skin.category)
      .text(skin.name).text(skin.type).text(skin.portrait).text(skin.landscape)
      .text(scripts.get(key) ?? "").text(skin.timestamp.toString());
    if (skin.source === null) continue;
    sourceRows.integer(hero).integer(ids.get(key)).text(`Hero #${hero}`)
      .text(skin.name).text(skin.portrait).text(skin.source.backupArchive);
    for (const route of skin.source.upgrades) {
      const targetKey = identity(hero, route.targetCategory, route.targetSkinId);
      const target = catalog.get(targetKey);
      if (!target) invalid(`missing route target ${targetKey}`);
      routeRows.integer(hero).integer(ids.get(key)).integer(ids.get(targetKey))
        .text(target.name).text(target.portrait).text(target.landscape).text(route.archive);
    }
  }
  const tagRows = new Binary(tags.length);
  for (const tagRecord of tags) {
    const tag = object(tagRecord, "tag");
    tagRows.text(tag.name).text(tag.image);
  }
  return new Map([
    [LEGACY_NAMES[0], skinRows.encrypt()],
    [LEGACY_NAMES[1], tagRows.encrypt()],
    [LEGACY_NAMES[2], sourceRows.encrypt()],
    [LEGACY_NAMES[3], routeRows.encrypt()],
    [LEGACY_NAMES[4], preparationRows(preparationsDocument).encrypt()],
  ]);
}
