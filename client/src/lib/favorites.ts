/* Favorite models: per-platform picks, persisted in localStorage.
   One entry = one platform-side of a merged model, e.g. "opencode:deepseek-v4-flash". */

import type { PlatformKey } from "@/lib/model-catalog";

const STORAGE_KEY = "model-catalog.favorite-models.v1";

export type FavoriteRef = { platform: PlatformKey; key: string };

function refId(ref: FavoriteRef): string {
  return `${ref.platform}:${ref.key}`;
}

export function loadFavorites(): FavoriteRef[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is FavoriteRef =>
        !!x && typeof x === "object" &&
        (x.platform === "opencode" || x.platform === "cmdc") &&
        typeof x.key === "string" && x.key.length > 0,
    );
  } catch {
    return [];
  }
}

export function persistFavorites(refs: FavoriteRef[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(refs));
}

export function isFavorite(refs: FavoriteRef[], platform: PlatformKey, key: string): boolean {
  return refs.some((ref) => ref.platform === platform && ref.key === key);
}

/** Toggle one platform-side favorite; returns the next list. */
export function toggleFavorite(refs: FavoriteRef[], platform: PlatformKey, key: string): FavoriteRef[] {
  const id = refId({ platform, key });
  const next = refs.some((ref) => refId(ref) === id)
    ? refs.filter((ref) => refId(ref) !== id)
    : [...refs, { platform, key }];
  persistFavorites(next);
  void syncFavorites(next).catch(() => {
    /* 后端不可达时仅保留本地，下次聚焦再同步 */
  });
  return next;
}

export function removeFavorite(refs: FavoriteRef[], platform: PlatformKey, key: string): FavoriteRef[] {
  const next = refs.filter((ref) => !(ref.platform === platform && ref.key === key));
  persistFavorites(next);
  void syncFavorites(next).catch(() => {
    /* 后端不可达时仅保留本地，下次聚焦再同步 */
  });
  return next;
}

/** 把本地收藏整体同步到后端 models.favorite.json。 */
export async function syncFavorites(refs: FavoriteRef[]): Promise<FavoriteRef[]> {
  const resp = await fetch("/api/models/favorites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorites: refs }),
    signal: AbortSignal.timeout(15000),
  });
  const body = (await resp.json()) as { ok?: boolean; favorites?: FavoriteRef[]; error?: string };
  if (!resp.ok || !body.ok || !Array.isArray(body.favorites)) {
    throw new Error(body.error ?? `sync failed ${resp.status}`);
  }
  persistFavorites(body.favorites);
  return body.favorites;
}

/** 从后端拉回收藏并覆盖本地（页面打开/聚焦时调用）。拉不到则保留本地。 */
export async function reloadFavorites(): Promise<FavoriteRef[] | null> {
  try {
    const resp = await fetch("/api/models/favorites", { signal: AbortSignal.timeout(15000) });
    const body = (await resp.json()) as { favorites?: FavoriteRef[] };
    if (!resp.ok || !Array.isArray(body.favorites)) return null;
    const next = body.favorites.filter(
      (x): x is FavoriteRef =>
        !!x && typeof x === "object" &&
        (x.platform === "opencode" || x.platform === "cmdc") &&
        typeof x.key === "string" && x.key.length > 0,
    );
    persistFavorites(next);
    return next;
  } catch {
    return null;
  }
}
