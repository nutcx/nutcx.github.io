export interface SharedItem { id: string; path: string; name: string; image: string; description: string; kind: 'skin' | 'preparation'; heroId?: number; group?: string; filter: string; }
export function loadItems(): Promise<SharedItem[]>;
export function decodeBundle(data: Uint8Array): Record<string, unknown>;
export function projectItems(entries: Record<string, unknown>): SharedItem[];
export interface CatalogHero { id: number; name: string; image: string; items: SharedItem[]; }
export function loadHeroes(): Promise<CatalogHero[]>;
export function skinFilter(skin: { category: number; type?: string }): string;
