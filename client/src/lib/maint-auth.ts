/* Storage and helper for maintenance access authentication */

const AUTH_STORAGE_KEY = "model-catalog.maintenance-token.v1";

export function loadMaintenanceToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(AUTH_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function persistMaintenanceToken(token: string): void {
  try {
    if (token) {
      window.localStorage.setItem(AUTH_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(AUTH_STORAGE_KEY);
    }
  } catch {}
}

export function getMaintenanceHeaders(): Record<string, string> {
  const token = loadMaintenanceToken();
  if (!token) return {};
  return {
    "X-Maintenance-Password": token,
  };
}
