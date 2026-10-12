import { createHash } from 'node:crypto';
import heroLabels from '../src/data/heroes.json' with { type: 'json' };
import { projectItems } from '../src/lib/catalog.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const SITE = 'https://nutcx.github.io';
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function usableArchive(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

/** Persist semantic replacement identities without retaining archive URLs. */
export function createCatalogSnapshot({ summary, entries }) {
  const projected = new Map(projectItems(entries).map(item => [item.id, item]));
  const routes = new Map();
  const add = ({ identity, pairKey, sourceKey, targetIdentity, archive, group }) => {
    if (!usableArchive(archive)) return;
    const item = projected.get(sha256(identity));
    if (!item || item.filter === 'original' || item.availableToApply === false) return;
    const source = projected.get(item.sourceId);
    const targetKey = `${targetIdentity}:${sha256(JSON.stringify([item.name, item.image]))}`;
    const route = {
      pairKey, targetKey, kind: item.kind, group, name: item.name, image: item.image,
      sourceName: source?.name ?? '', sourceImage: source?.image ?? '', sourceKey, path: item.path,
    };
    route.fingerprint = sha256(JSON.stringify({ ...route, archiveSha256: sha256(archive) }));
    routes.set(`${pairKey}:${route.fingerprint}`, route);
  };
  for (const hero of entries['heroes.json'].heroes) {
    for (const source of hero.skins) {
      if (!source.source) continue;
      for (const upgrade of source.source.upgrades) {
        const pairKey = `skin:${hero.heroId}:${source.category}:${source.skinId}:${upgrade.targetCategory}:${upgrade.targetSkinId}`;
        add({
          identity: `skin:REPLACEMENT:${hero.heroId}:${source.skinId}:${source.category}:${upgrade.targetSkinId}:${upgrade.targetCategory}`,
          pairKey, sourceKey: `skin:${hero.heroId}:${source.category}:${source.skinId}`,
          targetIdentity: `skin:${hero.heroId}:${upgrade.targetCategory}:${upgrade.targetSkinId}`,
          archive: upgrade.archive, group: heroLabels[hero.heroId]?.name ?? `Hero ${hero.heroId}`,
        });
      }
    }
  }
  const preparations = entries['preparations.json'];
  if (preparations.preparationSchemaVersion === 4) {
    for (const type of preparations.types) {
      const targets = new Map(type.items.map(item => [`${item.category}:${item.id}`, item]));
      for (const source of type.items) {
        if (!source.source) continue;
        for (const upgrade of source.source.upgrades) {
          const target = targets.get(`${upgrade.targetCategory}:${upgrade.targetId}`);
          const name = upgrade.name ?? target.name;
          const image = upgrade.image ?? target.image;
          const variant = sha256(`${upgrade.archive}\0${name}\0${image}`).slice(0, 32);
          const sourceKey = `preparation:${type.key}:${source.category}:${source.id}`;
          add({
            identity: `v4:${type.key}:${source.category}:${source.id}:target:${target.category}:${target.id}:${variant}`,
            pairKey: `${sourceKey}:${target.category}:${target.id}`, sourceKey,
            targetIdentity: `preparation:${type.key}:${target.category}:${target.id}`,
            archive: upgrade.archive, group: type.name,
          });
        }
      }
    }
  } else {
    for (const source of preparations.preparations) {
      if (!usableArchive(source.archive)) continue;
      for (const target of source.items) {
        // Legacy entries have no numeric target identity; presentation identifies a variant.
        const sourceKey = `preparation:legacy:${source.preparationId}`;
        const targetIdentity = `${sourceKey}:${sha256(JSON.stringify([target.name, target.image]))}`;
        add({
          identity: `preparation:REPLACEMENT:${source.preparationId}:${target.archive}:${target.image}`,
          pairKey: targetIdentity, sourceKey, targetIdentity, archive: target.archive, group: source.name,
        });
      }
    }
  }
  return {
    schemaVersion: 1, sequence: String(summary.publicationSequence), version: summary.contentVersion,
    contentSha256: summary.contentSha256,
    routes: [...routes.values()].sort((a, b) => compare(a.pairKey, b.pairKey) || compare(a.fingerprint, b.fingerprint)),
  };
}

function groupPairs(routes) {
  const pairs = new Map();
  for (const route of routes) {
    if (!pairs.has(route.pairKey)) pairs.set(route.pairKey, []);
    pairs.get(route.pairKey).push(route);
  }
  return pairs;
}

/** Removed or unchanged routes stay quiet; group changed originals by target variant. */
export function diffCatalogSnapshots(previous, current) {
  const previousPairs = groupPairs(previous?.routes ?? []);
  const currentPairs = groupPairs(current.routes);
  const changedTargets = new Map();
  for (const [pairKey, routes] of currentPairs) {
    const old = previousPairs.get(pairKey) ?? [];
    const exact = new Set(old.map(route => route.fingerprint));
    const remaining = old.filter(route => !routes.some(currentRoute => currentRoute.fingerprint === route.fingerprint));
    const changed = routes.filter(route => !exact.has(route.fingerprint));
    // Match named/image variants first, so a new variant cannot consume an archive update.
    const matched = new Map();
    for (const route of changed) {
      const index = remaining.findIndex(oldRoute => oldRoute.name === route.name && oldRoute.image === route.image);
      if (index >= 0) matched.set(route, remaining.splice(index, 1)[0]);
    }
    for (const route of changed) {
      const status = matched.has(route) || remaining.shift() ? 'updated' : 'new';
      let target = changedTargets.get(route.targetKey);
      if (!target) {
        target = { key: route.targetKey, kind: route.kind, group: route.group, name: route.name,
          image: route.image, status, originals: [] };
        changedTargets.set(route.targetKey, target);
      }
      if (status === 'updated') target.status = 'updated';
      const existing = target.originals.find(original => original.key === route.sourceKey);
      if (existing) {
        if (status === 'updated') existing.status = 'updated';
      } else {
        target.originals.push({ key: route.sourceKey, name: route.sourceName, image: route.sourceImage,
          path: route.path, status });
      }
    }
  }
  return [...changedTargets.values()].sort((a, b) => compare(a.key, b.key)).map(target => ({
    ...target, originals: target.originals.sort((a, b) => compare(a.key, b.key)),
  }));
}

function truncate(value, limit) {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  let shortened = text.slice(0, limit - 1);
  if (/[\uD800-\uDBFF]$/.test(shortened)) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

function plainText(value, limit) {
  return truncate(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/@/g, '＠').replace(/[<>\\`*_~|\[\]()]/g, '').replace(/\s+/g, ' ').trim(), limit);
}

function routeUrl(path) {
  if (typeof path !== 'string' || !/^\/(?:heroes|preparations)\/[a-zA-Z0-9/.-]+\/$/.test(path)
      || path.split('/').some(segment => segment === '.' || segment === '..')) {
    throw new Error('Discord announcements require a canonical catalog route');
  }
  return `${SITE}${path}`;
}

function embedCharacters(embed) {
  return [embed.title, embed.description, embed.footer?.text,
    ...embed.fields.flatMap(field => [field.name, field.value])]
    .reduce((total, text) => total + (text?.length ?? 0), 0);
}

/** Plan webhook JSON; the sender supplies comparison attachments in change order. */
export function buildDiscordBatches(changes, { version, sequence }) {
  const targets = new Map();
  for (const [index, change] of changes.entries()) {
    if (!targets.has(change.key)) targets.set(change.key, { index, change: { ...change, originals: [] } });
    const target = targets.get(change.key).change;
    if (change.status === 'updated') target.status = 'updated';
    for (const original of change.originals) {
      const existing = target.originals.find(item => item.key === original.key);
      if (existing) {
        if (original.status === 'updated') existing.status = 'updated';
      } else target.originals.push({ ...original });
    }
  }
  const batches = [];
  for (const { index, change } of targets.values()) {
    if (!change.originals.length) throw new Error('Discord announcements require a changed original');
    const originalLines = [];
    let omitted = 0;
    for (const original of change.originals) {
      const line = `[${plainText(original.name, 120) || 'Original'}](${routeUrl(original.path)}) · ${original.status === 'new' ? 'New' : 'Updated'}`;
      if ([...originalLines, line].join('\n').length <= 950) originalLines.push(line);
      else omitted += 1;
    }
    if (omitted) originalLines.push(`…and ${omitted} more changed originals.`);
    const embed = {
      title: `${change.status === 'new' ? 'New' : 'Updated'}: ${plainText(change.name, 245) || 'Replacement'}`,
      description: `${plainText(change.group, 180)} · ${change.kind === 'skin' ? 'Skin' : 'Effect'} replacement`,
      url: routeUrl(change.originals[0].path),
      fields: [{ name: 'Changed originals', value: originalLines.join('\n') }],
      image: { url: `attachment://comparison-${index}.webp` },
      footer: { text: `Content ${plainText(version, 80)} · Publication ${plainText(sequence, 80)}` },
    };
    let batch = batches.at(-1);
    if (!batch || batch.embeds.length >= 5
        || batch.embeds.reduce((total, previousEmbed) => total + embedCharacters(previousEmbed), 0) + embedCharacters(embed) > 6000) {
      batch = { content: batches.length === 0 ? '@everyone New and updated NutCracker content is available.' : '',
        allowed_mentions: { parse: batches.length === 0 ? ['everyone'] : [] }, embeds: [] };
      batches.push(batch);
    }
    batch.embeds.push(embed);
  }
  return batches;
}
