export interface SharedItem { id: string; name: string; image: string; description: string; }
export function loadItems(): Promise<SharedItem[]>;
export function decodeBundle(data: Uint8Array): Record<string, unknown>;
export function projectItems(entries: Record<string, unknown>): SharedItem[];
