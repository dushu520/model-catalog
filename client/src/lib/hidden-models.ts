/* Hidden models: canonical keys the user hid on the maintenance page.
   Hidden keys are excluded from every list (home / compare / maintenance). */

const STORAGE_KEY = "model-catalog.hidden-keys.v1";

export function loadHiddenKeys(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function persistHiddenKeys(keys: string[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export function hideModelKey(key: string): string[] {
  const next = Array.from(new Set([...loadHiddenKeys(), key]));
  persistHiddenKeys(next);
  return next;
}

export function unhideModelKey(key: string): string[] {
  const next = loadHiddenKeys().filter((item) => item !== key);
  persistHiddenKeys(next);
  return next;
}
