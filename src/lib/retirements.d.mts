import type { SharedItem } from './catalog.mjs';
export interface RetiredItem { id: string; path: string; name: string; retired: true; reason: string; replacement?: string; }
export function loadPreviewHistory(): Promise<{ history: { id: string; path: string; name: string }[]; retired: RetiredItem[]; previews: (SharedItem | RetiredItem)[] }>;
