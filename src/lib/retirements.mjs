import { loadItems } from './catalog.mjs';
import notices from '../data/retirements.json' with { type: 'json' };
import { readFile } from 'node:fs/promises';

const pathPattern = /^\/(?:heroes\/[1-9][0-9]*\/[0-9]+(?:c-?[0-9]+)?(?:-[0-9]+(?:c-?[0-9]+)?)?|preparations\/[0-9]+\/[a-f0-9]{8})\/$/;
function validate(item) {
  if (!item || !/^[a-f0-9]{64}$/.test(item.id) || !pathPattern.test(item.path)
      || typeof item.name !== 'string' || item.name.length > 500) throw new Error('Invalid retained preview metadata');
  return { id: item.id, path: item.path, name: item.name };
}

export function mergeHistory(current, previous, overrides = notices) {
  const activeIds = new Set(current.map(item => item.id));
  const activePaths = new Set(current.map(item => item.path));
  const history = new Map(previous.map(item => { const safe = validate(item); return [safe.id, safe]; }));
  for (const item of current) history.set(item.id, validate(item));
  const overrideMap = new Map();
  for (const notice of overrides) {
    if (!history.has(notice.id) || overrideMap.has(notice.id) || typeof notice.reason !== 'string'
        || !notice.reason.trim() || notice.reason.length > 1500
        || (notice.replacement && !activePaths.has(notice.replacement))) throw new Error('Invalid retirement notice or unavailable replacement');
    overrideMap.set(notice.id, notice);
  }
  const retired = [...history.values()].filter(item => !activeIds.has(item.id) && !activePaths.has(item.path))
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
    const merged = mergeHistory(current, previous);
    return { ...merged, previews: [...current, ...merged.retired] };
  })();
}
