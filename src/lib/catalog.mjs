import heroLabels from '../data/heroes.json' with { type: 'json' };
import { createHash, createPublicKey, verify } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const key = createPublicKey({ key: Buffer.from('MCowBQYDK2VwAyEA/nqv5THRQyePGH/ARBmY+hzQygbVq34lhQXzf/YmYpk=', 'base64'), format: 'der', type: 'spki' });
const hash = value => createHash('sha256').update(value).digest('hex');
function requireValue(ok, message) { if (!ok) throw new Error(message); }

export function decodeBundle(data) {
  requireValue(data.length >= 80 && data.length <= 40 * 1024 * 1024, 'Invalid bundle size');
  const u32 = offset => data.readUInt32LE(offset);
  const u64 = offset => { const n = Number(data.readBigUInt64LE(offset)); requireValue(Number.isSafeInteger(n), 'Oversized offset'); return n; };
  requireValue(data.subarray(0, 8).equals(Buffer.from('MLBYTES\0')), 'Invalid bundle magic');
  requireValue(data.readUInt16LE(8) === 1 && data.readUInt16LE(10) === 0 && u32(12) === 1 && u32(16) === 80 && u32(20) === 3 && u32(28) === 0, 'Unsupported or unsigned content');
  const payload = u64(48), stored = u64(56), rawTotal = u64(64), signature = u64(72);
  requireValue(u32(40) === 3 && u32(44) <= 65536 && payload === 80 + u32(44) && signature === payload + stored && signature + 80 <= data.length, 'Invalid bundle layout');
  const block = data.subarray(signature), keyLength = block.readUInt16LE(12);
  requireValue(block.subarray(0, 8).equals(Buffer.from('MLBSIG\0\0')) && block.readUInt16LE(8) === 1 && block.readUInt16LE(10) === 1 && block.readUInt16LE(14) === 64 && keyLength > 0 && keyLength <= 128 && block.length === 16 + keyLength + 64, 'Invalid signature block');
  requireValue(block.subarray(16, 16 + keyLength).toString() === 'nutcx-content-2026-01', 'Unknown publisher');
  requireValue(verify(null, Buffer.concat([Buffer.from('MLBYTES-SIGNATURE-V1\0'), data.subarray(0, signature), block.subarray(0, 16 + keyLength)]), key, block.subarray(16 + keyLength)), 'Content signature verification failed');
  let cursor = 80, next = 0, total = 0;
  const entries = {};
  for (const expected of ['heroes.json', 'preparations.json', 'skin-tags.json']) {
    const length = data.readUInt16LE(cursor), codec = data[cursor + 2];
    const offset = u64(cursor + 8), size = u64(cursor + 16), rawSize = u64(cursor + 24);
    requireValue(length > 0 && length <= 1024 && cursor + 64 + length <= payload && codec <= 1 && data[cursor + 3] === 0 && u32(cursor + 4) === 0 && offset === next && size <= 8 * 1024 * 1024 && rawSize > 0 && rawSize <= 8 * 1024 * 1024 && payload + offset + size <= signature, 'Invalid content entry');
    const name = data.subarray(cursor + 64, cursor + 64 + length).toString();
    requireValue(name === expected, 'Unexpected content entry');
    const compressed = data.subarray(payload + offset, payload + offset + size);
    const raw = codec === 1 ? inflateSync(compressed, { maxOutputLength: rawSize }) : compressed;
    requireValue(raw.length === rawSize && hash(raw) === data.subarray(cursor + 32, cursor + 64).toString('hex'), 'Content checksum mismatch');
    entries[name] = JSON.parse(raw.toString('utf8'));
    cursor += 64 + length; next += size; total += rawSize;
  }
  requireValue(cursor === payload && next === stored && total === rawTotal, 'Invalid content totals');
  return entries;
}

function https(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; } catch { return ''; }
}

export function skinPath(hero, source, sourceCategory, target, targetCategory) {
  const token = (id, category) => `${id}${category === 0 ? '' : `c${category}`}`;
  return `/heroes/${hero}/${token(source, sourceCategory)}${target === undefined ? '' : `-${token(target, targetCategory)}`}/`;
}

export function projectItems(entries) {
  const items = new Map();
  const add = (identity, name, image, description, archive, route, metadata = {}) => {
    if (!name?.trim() || !https(archive)) return;
    const id = hash(identity);
    const path = route ?? `/preparations/${identity.split(':')[2]}/${id.slice(0, 8)}/`;
    const item = { id, path, name: name.trim(), image: https(image), description, ...metadata };
    if (items.has(id)) requireValue(JSON.stringify(items.get(id)) === JSON.stringify(item), 'Conflicting shared item identity');
    items.set(id, item);
  };
  for (const hero of entries['heroes.json'].heroes) {
    for (const skin of hero.skins) {
      if (!skin.source) continue;
      add(`skin:BACKUP:${hero.heroId}:${skin.skinId}:${skin.category}:0:${skin.category}`, skin.name, skin.landscape || skin.portrait, 'Skin preview · Original', skin.source.backupArchive, skinPath(hero.heroId, skin.skinId, skin.category), { kind: 'skin', heroId: hero.heroId, filter: 'original' });
      for (const upgrade of skin.source.upgrades) {
        const target = hero.skins.find(s => s.skinId === upgrade.targetSkinId && s.category === upgrade.targetCategory);
        requireValue(target, 'Missing skin target');
        add(`skin:REPLACEMENT:${hero.heroId}:${skin.skinId}:${skin.category}:${target.skinId}:${target.category}`, target.name, target.landscape || target.portrait, `Skin preview · For ${skin.name}`, upgrade.archive, skinPath(hero.heroId, skin.skinId, skin.category, target.skinId, target.category), { kind: 'skin', heroId: hero.heroId, filter: skinFilter(target) });
      }
    }
  }
  for (const prep of entries['preparations.json'].preparations) {
    // The Android catalog only exposes replacements with an available parent.
    if (!https(prep.archive)) continue;
    add(`preparation:BACKUP:${prep.preparationId}:${prep.archive}:${prep.image}`, prep.name, prep.image, 'Preparation preview · Original', prep.archive, undefined, { kind: 'preparation', group: prep.name, filter: 'original' });
    for (const item of prep.items) add(`preparation:REPLACEMENT:${prep.preparationId}:${item.archive}:${item.image}`, item.name, item.image, `Preparation preview · For ${prep.name}`, item.archive, undefined, { kind: 'preparation', group: prep.name, filter: 'replacement' });
  }
  const paths = new Set();
  for (const item of items.values()) {
    requireValue(!paths.has(item.path), `Item route collision: ${item.path}`);
    paths.add(item.path);
  }
  return [...items.values()];
}

let cached;
export async function loadItems() {
  if (!cached) cached = (async () => {
    const response = await fetch('https://raw.githubusercontent.com/nutcx/app-content/main/Document.mlbytes', { signal: AbortSignal.timeout(30000) });
    requireValue(response.ok, `Content download failed: ${response.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length; requireValue(size <= 40 * 1024 * 1024, 'Content download exceeds limit'); chunks.push(chunk);
    }
    return projectItems(decodeBundle(Buffer.concat(chunks)));
  })();
  return cached;
}

export function skinFilter(skin) {
  if (skin.category === 0) return 'official';
  return String(skin.type || '').split('|').map(part => part.trim()).filter(Boolean)[0]?.toLowerCase() === 'anime' ? 'anime' : 'custom';
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
