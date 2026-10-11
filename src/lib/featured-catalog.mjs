import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadPublicContentDelivery } from '../../scripts/public-content-manifest.mjs';
import { projectItems } from './catalog.mjs';

// Keep the signed feature keys in sync with the app's FeaturedContent contract.
export const MAX_FEATURED_ITEMS = 24;
const publicKeys = Object.freeze({
  'nutcx-content-2026-01': 'MCowBQYDK2VwAyEA/nqv5THRQyePGH/ARBmY+hzQygbVq34lhQXzf/YmYpk=',
});
const hash = value => createHash('sha256').update(value).digest('hex');

export function featuredSkinKey(heroId, category, skinId) {
  return `featured.skin.${heroId}.${category}.${skinId}`;
}

export function featuredPreparationKey(typeKey, category, id) {
  return `featured.preparation.${hash(`${typeKey}\0${category}\0${id}`).slice(0, 32)}`;
}

function hasArchive(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNames(left, right) {
  return compare(left.toLowerCase(), right.toLowerCase());
}

/**
 * Select only explicitly featured destinations, while retaining each original's
 * exact canonical route. A destination is not itself a route to apply.
 */
export function projectFeaturedContent(entries, flags) {
  const projected = new Map(projectItems(entries).map(item => [item.id, item]));
  const candidates = [];
  const add = (key, identity, sourceIdentity, archive, metadata) => {
    if (!flags || !Object.hasOwn(flags, key) || flags[key] !== true || !hasArchive(archive)) return;
    const item = projected.get(hash(identity));
    const source = projected.get(hash(sourceIdentity));
    if (!item || !source) throw new Error(`Missing projected featured route: ${identity}`);
    candidates.push({ key, item, source, ...metadata });
  };

  for (const hero of entries['heroes.json'].heroes) {
    for (const source of hero.skins) {
      if (!source.source) continue;
      const sourceIdentity = `skin:BACKUP:${hero.heroId}:${source.skinId}:${source.category}:0:${source.category}`;
      add(featuredSkinKey(hero.heroId, source.category, source.skinId), sourceIdentity,
        sourceIdentity, source.source.backupArchive,
        { kind: 'skin', heroId: hero.heroId, category: source.category });
      for (const upgrade of source.source.upgrades) {
        add(featuredSkinKey(hero.heroId, upgrade.targetCategory, upgrade.targetSkinId),
          `skin:REPLACEMENT:${hero.heroId}:${source.skinId}:${source.category}:${upgrade.targetSkinId}:${upgrade.targetCategory}`,
          sourceIdentity, upgrade.archive,
          { kind: 'skin', heroId: hero.heroId, category: upgrade.targetCategory });
      }
    }
  }

  const preparations = entries['preparations.json'];
  // Legacy preparations have no signed type/category identity; never guess one.
  if (preparations?.preparationSchemaVersion === 4) {
    for (const type of preparations.types) {
      const byIdentity = new Map(type.items.map(item => [`${item.category}:${item.id}`, item]));
      for (const source of type.items) {
        if (!source.source) continue;
        const base = `v4:${type.key}:${source.category}:${source.id}`;
        const sourceIdentity = `${base}:backup`;
        add(featuredPreparationKey(type.key, source.category, source.id), sourceIdentity,
          sourceIdentity, source.source.backupArchive,
          { kind: 'preparation', typeKey: type.key, category: source.category, group: type.name });
        for (const upgrade of source.source.upgrades) {
          const target = byIdentity.get(`${upgrade.targetCategory}:${upgrade.targetId}`);
          if (!target) throw new Error('Missing featured Preparation target');
          const name = upgrade.name ?? target.name;
          const image = upgrade.image ?? target.image;
          const variant = hash(`${upgrade.archive}\0${name}\0${image}`).slice(0, 32);
          add(featuredPreparationKey(type.key, target.category, target.id),
            `${base}:target:${target.category}:${target.id}:${variant}`,
            sourceIdentity, upgrade.archive,
            { kind: 'preparation', typeKey: type.key, category: target.category, group: type.name });
        }
      }
    }
  }

  candidates.sort((left, right) =>
    Number(left.item.filter === 'original') - Number(right.item.filter === 'original')
    || compareNames(left.item.name, right.item.name)
    || compare(left.item.id, right.item.id));
  const selected = new Map();
  for (const candidate of candidates) {
    let group = selected.get(candidate.key);
    if (!group) {
      group = { key: candidate.key, kind: candidate.kind, name: candidate.item.name,
        image: candidate.item.image, category: candidate.category,
        categoryLabel: candidate.category === 0 ? 'Official' : 'Custom', options: new Map() };
      if (candidate.heroId !== undefined) group.heroId = candidate.heroId;
      if (candidate.typeKey !== undefined) group.typeKey = candidate.typeKey;
      if (candidate.group !== undefined) group.group = candidate.group;
      selected.set(candidate.key, group);
    }
    if (!group.options.has(candidate.item.id)) {
      group.options.set(candidate.item.id, Object.freeze({ item: candidate.item, source: candidate.source }));
    }
  }
  const groups = [...selected.values()].sort((left, right) =>
    compareNames(left.name, right.name) || compare(left.key, right.key));
  // Apply the same global cap as the client before a page filters its own kind/hero.
  return Object.freeze(groups.slice(0, MAX_FEATURED_ITEMS).map(group => Object.freeze({
    ...group, options: Object.freeze([...group.options.values()]),
  })));
}

async function loadFromContent(rootDirectory) {
  const { entries, clientFeatures } = await loadPublicContentDelivery(rootDirectory, { publicKeys });
  if (!clientFeatures || typeof clientFeatures !== 'object' || Array.isArray(clientFeatures)) {
    throw new Error('Verified content delivery is missing its authenticated feature flags');
  }
  return projectFeaturedContent(entries, clientFeatures);
}

let cached;
export function loadFeaturedContent(rootDirectory) {
  // Reuse the build's verified default delivery; explicit roots always reverify.
  return rootDirectory === undefined
    ? cached ??= loadFromContent(resolve('public/content'))
    : loadFromContent(rootDirectory);
}
