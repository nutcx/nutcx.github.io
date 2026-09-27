import heroLabels from '../data/heroes.json' with { type: 'json' };
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { loadPublicContentDelivery } from '../../scripts/public-content-manifest.mjs';

const publicKeys = Object.freeze({
  'nutcx-content-2026-01': 'MCowBQYDK2VwAyEA/nqv5THRQyePGH/ARBmY+hzQygbVq34lhQXzf/YmYpk=',
});
const hash = value => createHash('sha256').update(value).digest('hex');
function requireValue(ok, message) { if (!ok) throw new Error(message); }

function https(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}

export function skinPath(hero, source, sourceCategory, target, targetCategory) {
  const token = (id, category) => `${id}${category === 0 ? '' : `c${category}`}`;
  return `/heroes/${hero}/${token(source, sourceCategory)}${target === undefined ? '' : `-${token(target, targetCategory)}`}/`;
}

export function projectItems(entries) {
  const items = new Map();
  const add = (identity, name, image, description, archive, route, metadata = {}, allowMissingArchive = false) => {
    if (!name?.trim() || (!https(archive) && !(allowMissingArchive && archive === ''))) return;
    const id = hash(identity);
    const path = route ?? `/preparations/${identity.split(':')[2]}/${id.slice(0, 8)}/`;
    const item = { id, sourceId: id, path, name: name.trim(), image: https(image), description, ...metadata };
    if (items.has(id)) requireValue(JSON.stringify(items.get(id)) === JSON.stringify(item), 'Conflicting shared item identity');
    items.set(id, item);
  };
  for (const hero of entries['heroes.json'].heroes) {
    for (const skin of hero.skins) {
      if (!skin.source) continue;
      const backupIdentity = `skin:BACKUP:${hero.heroId}:${skin.skinId}:${skin.category}:0:${skin.category}`;
      const backupAvailable = Boolean(https(skin.source.backupArchive));
      // Like the app, keep a source with usable replacements even without its own archive.
      if (backupAvailable || skin.source.upgrades.some(upgrade => https(upgrade.archive))) {
        add(backupIdentity, skin.name, skin.landscape || skin.portrait, 'Skin preview · Original', backupAvailable ? skin.source.backupArchive : '', skinPath(hero.heroId, skin.skinId, skin.category), { kind: 'skin', heroId: hero.heroId, filter: 'original', availableToApply: backupAvailable }, true);
      }
      for (const upgrade of skin.source.upgrades) {
        const target = hero.skins.find(s => s.skinId === upgrade.targetSkinId && s.category === upgrade.targetCategory);
        requireValue(target, 'Missing skin target');
        add(`skin:REPLACEMENT:${hero.heroId}:${skin.skinId}:${skin.category}:${target.skinId}:${target.category}`, target.name, target.landscape || target.portrait, `Skin preview · For ${skin.name}`, upgrade.archive, skinPath(hero.heroId, skin.skinId, skin.category, target.skinId, target.category), { kind: 'skin', heroId: hero.heroId, filter: skinFilter(target), sourceId: hash(backupIdentity) });
      }
    }
  }
  const preparations = entries['preparations.json'];
  if (preparations?.preparationSchemaVersion === 4) {
    requireValue(Array.isArray(preparations.types), 'Invalid Preparation catalog');
    for (const type of preparations.types) {
      requireValue(typeof type.key === 'string' && typeof type.name === 'string' && Array.isArray(type.items), 'Invalid Preparation type');
      const byIdentity = new Map();
      for (const item of type.items) {
        requireValue(Number.isSafeInteger(item.category) && Number.isSafeInteger(item.id)
          && item.category >= 0 && item.id >= 0, 'Invalid Preparation item identity');
        const identity = `${item.category}:${item.id}`;
        requireValue(!byIdentity.has(identity), 'Duplicate Preparation item identity');
        byIdentity.set(identity, item);
      }
      for (const source of type.items) {
        if (!source.source) continue;
        const base = `v4:${type.key}:${source.category}:${source.id}`;
        const path = identity => `/preparations/${source.id}/${hash(identity).slice(0, 8)}/`;
        const backupIdentity = `${base}:backup`;
        const backupAvailable = Boolean(https(source.source.backupArchive));
        add(backupIdentity, source.name, source.image,
          `Preparation preview · Original${backupAvailable ? '' : ' · Not available to apply'}`,
          source.source.backupArchive, path(backupIdentity),
          { kind: 'preparation', group: type.name, filter: 'original', availableToApply: backupAvailable }, true);
        requireValue(Array.isArray(source.source.upgrades), 'Invalid Preparation upgrades');
        for (const upgrade of source.source.upgrades) {
          const target = byIdentity.get(`${upgrade.targetCategory}:${upgrade.targetId}`);
          requireValue(target, 'Missing Preparation target');
          const name = upgrade.name ?? target.name;
          const image = upgrade.image ?? target.image;
          const variant = hash(`${upgrade.archive}\0${name}\0${image}`).slice(0, 32);
          const identity = `${base}:target:${target.category}:${target.id}:${variant}`;
          const available = Boolean(https(upgrade.archive));
          add(identity, name, image,
            `Preparation preview · For ${source.name}${available ? '' : ' · Not available to apply'}`,
            upgrade.archive, path(identity),
            { kind: 'preparation', group: type.name, filter: 'replacement', availableToApply: available, sourceId: hash(backupIdentity) }, true);
        }
      }
    }
  } else {
    requireValue(Array.isArray(preparations?.preparations), 'Unsupported Preparation catalog');
    for (const prep of preparations.preparations) {
      // The legacy Android catalog only exposes replacements with an available parent.
      if (!https(prep.archive)) continue;
      const backupIdentity = `preparation:BACKUP:${prep.preparationId}:${prep.archive}:${prep.image}`;
      add(backupIdentity, prep.name, prep.image, 'Preparation preview · Original', prep.archive, undefined, { kind: 'preparation', group: prep.name, filter: 'original' });
      for (const item of prep.items) add(`preparation:REPLACEMENT:${prep.preparationId}:${item.archive}:${item.image}`, item.name, item.image, `Preparation preview · For ${prep.name}`, item.archive, undefined, { kind: 'preparation', group: prep.name, filter: 'replacement', sourceId: hash(backupIdentity) });
    }
  }
  const paths = new Set();
  for (const item of items.values()) {
    requireValue(!paths.has(item.path), `Item route collision: ${item.path}`);
    paths.add(item.path);
  }
  return [...items.values()];
}

let cached;
export async function loadItemsFromContent(rootDirectory) {
  const { entries } = await loadPublicContentDelivery(rootDirectory, { publicKeys });
  return projectItems(entries);
}

export function loadItems() {
  // Astro and the site scripts run from the repository root. Do not fetch the
  // deployed manifest: it still belongs to the previous Pages deployment.
  return cached ??= loadItemsFromContent(resolve('public/content'));
}

export function skinFilter(skin) {
  if (skin.category === 0) return 'official';
  return String(skin.type || '').split('|').map(part => part.trim()).filter(Boolean)[0]?.toLowerCase() === 'anime' ? 'anime' : 'custom';
}

// Group by publisher identities, never display names or numeric preparation IDs alone.
export function groupItemsBySource(items) {
  const groups = new Map(items.filter(item => item.filter === 'original')
    .map(source => [source.id, { source, replacements: [] }]));
  for (const item of items) {
    if (item.filter === 'original') continue;
    const group = groups.get(item.sourceId);
    requireValue(group, `Missing catalog source for ${item.path}`);
    group.replacements.push(item);
  }
  return [...groups.values()];
}

let cachedGroups;
export async function loadItemGroup(sourceId) {
  if (!cachedGroups) cachedGroups = loadItems().then(items =>
    new Map(groupItemsBySource(items).map(group => [group.source.id, group])));
  return (await cachedGroups).get(sourceId);
}

export async function loadHeroes() {
  const grouped = new Map();
  for (const item of await loadItems()) {
    if (item.kind !== 'skin') continue;
    if (!grouped.has(item.heroId)) {
      const label = heroLabels[item.heroId];
      grouped.set(item.heroId, { id: item.heroId, name: label?.name || `Hero ${item.heroId}`, image: https(label?.image), items: [] });
    }
    grouped.get(item.heroId).items.push(item);
  }
  return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
}
