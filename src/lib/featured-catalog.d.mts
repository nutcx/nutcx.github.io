import type { SharedItem } from './catalog.mjs';

export interface FeaturedOption { item: SharedItem; source: SharedItem; }
export interface FeaturedGroup {
  key: string;
  kind: 'skin' | 'preparation';
  name: string;
  image: string;
  category: number;
  categoryLabel: string;
  heroId?: number;
  typeKey?: string;
  group?: string;
  options: readonly FeaturedOption[];
}

export const MAX_FEATURED_ITEMS: 24;
export function featuredSkinKey(heroId: number, category: number, skinId: number): string;
export function featuredPreparationKey(typeKey: string, category: number, id: number): string;
export function projectFeaturedContent(entries: Record<string, unknown>, flags: Record<string, unknown>): readonly FeaturedGroup[];
export function loadFeaturedContent(rootDirectory?: string): Promise<readonly FeaturedGroup[]>;
