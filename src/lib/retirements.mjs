import { loadItems } from './catalog.mjs';
import notices from '../data/retirements.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';

const pathPattern = /^\/(?:heroes\/[1-9][0-9]*\/[0-9]+(?:c-?[0-9]+)?(?:-[0-9]+(?:c-?[0-9]+)?)?|preparations\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[0-9]+\/[a-f0-9]{8})\/$/;
function validate(item) {
  if (!item || !/^[a-f0-9]{64}$/.test(item.id) || typeof item.path !== 'string'
      || item.path.length > 240 || !pathPattern.test(item.path)
      || typeof item.name !== 'string' || item.name.length > 500) throw new Error('Invalid retained preview metadata');
  return { id: item.id, path: item.path, name: item.name };
}

export function mergeHistory(current, previous, overrides = notices) {
  const activePaths = new Set(current.map(item => item.path));
  const history = new Map();
  const include = item => {
    const safe = validate(item);
    const previous = history.get(safe.path);
    if (previous && previous.id !== safe.id) throw new Error('Conflicting retained preview path');
    history.set(safe.path, safe);
  };
  for (const item of previous) include(item);
  for (const item of current) include(item);
  const historyIds = new Set([...history.values()].map(item => item.id));
  const overrideMap = new Map();
  for (const notice of overrides) {
    if (!historyIds.has(notice.id) || overrideMap.has(notice.id) || typeof notice.reason !== 'string'
        || !notice.reason.trim() || notice.reason.length > 1500
        || (notice.replacement && !activePaths.has(notice.replacement))) throw new Error('Invalid retirement notice or unavailable replacement');
    overrideMap.set(notice.id, notice);
  }
  const retired = [...history.values()].filter(item => !activePaths.has(item.path))
    .map(item => ({ ...item, retired: true, reason: overrideMap.get(item.id)?.reason || 'This item is no longer available in the current catalog.', replacement: overrideMap.get(item.id)?.replacement }));
  if (new Set(retired.map(item => item.path)).size !== retired.length) throw new Error('Retired preview path collision');
  return { history: [...history.values()], retired };
}

let cached;
export function loadPreviewHistory() {
  return cached ??= (async () => {
    const recoveryFile = process.env.CATALOG_HISTORY_FILE;
    const response = recoveryFile ? new Response(await readFile(recoveryFile))
      : await fetch('https://nutcx.github.io/catalog-history.json', { signal: AbortSignal.timeout(30000) });
    let previous = [];
    if (response.status !== 404) {
      if (!response.ok) throw new Error(`Previous catalog unavailable: ${response.status}`);
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 16 * 1024 * 1024) throw new Error('Catalog history exceeds size limit');
        chunks.push(chunk);
      }
      const document = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (document.version !== 1 || !Array.isArray(document.items)) throw new Error('Invalid catalog history');
      previous = document.items;
    }
    const current = await loadItems();
    const aliases = current.filter(item => item.legacyPath)
      .map(item => ({ ...item, path: item.legacyPath, canonicalPath: item.path }));
    const previews = [...current, ...aliases];
    const merged = mergeHistory(previews, previous);
    return { ...merged, previews: [...previews, ...merged.retired] };
  })();
}
