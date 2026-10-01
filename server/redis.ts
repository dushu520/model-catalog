/**
 * Upstash Redis / Vercel KV 轻量客户端（零依赖，直接走 HTTP REST API）
 * 环境变量支持（Vercel Upstash 集成时会自动注入以下几种变量名之一）：
 * 1. UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * 2. KV_REST_API_URL / KV_REST_API_TOKEN
 * 3. 带有数据库名称后缀的变量（如 UPSTASH_KV_PINK_LAMP_REST_API_URL）
 */

export function getRedisUrl(): string | undefined {
  const directNames = [
    "UPSTASH_REDIS_REST_URL",
    "KV_REST_API_URL",
  ];
  for (const name of directNames) {
    const val = process.env[name];
    if (val && (val.startsWith("https://") || val.startsWith("http://"))) {
      return val;
    }
  }
  // 扫描所有匹配的 REST_URL / REST_API_URL（必须是 http 或 https 开头）
  for (const [k, v] of Object.entries(process.env)) {
    if (v && (k.endsWith("_REST_URL") || k.endsWith("_REST_API_URL"))) {
      if (v.startsWith("http://") || v.startsWith("https://")) {
        return v;
      }
    }
  }
  return undefined;
}

export function getRedisToken(): string | undefined {
  const directNames = [
    "UPSTASH_REDIS_REST_TOKEN",
    "KV_REST_API_TOKEN",
  ];
  for (const name of directNames) {
    if (process.env[name]) return process.env[name];
  }
  // 扫描所有匹配的 REST_TOKEN / REST_API_TOKEN（排除只读 token）
  for (const [k, v] of Object.entries(process.env)) {
    if (v && !k.includes("READ_ONLY") && (k.endsWith("_REST_TOKEN") || k.endsWith("_REST_API_TOKEN"))) {
      return v;
    }
  }
  return undefined;
}

export function isRedisConfigured(): boolean {
  return Boolean(getRedisUrl() && getRedisToken());
}

export async function redisGet<T = any>(key: string): Promise<T | null> {
  const url = getRedisUrl();
  const token = getRedisToken();
  if (!url || !token) return null;
  try {
    const cleanUrl = url.replace(/\/$/, "");
    const resp = await fetch(cleanUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["GET", key]),
      signal: AbortSignal.timeout(6000),
    });
    if (!resp.ok) {
      console.warn(`[Redis] GET ${key} status ${resp.status}`);
      return null;
    }
    const body = (await resp.json()) as { result?: any; error?: string };
    if (!body || body.result === null || body.result === undefined) return null;
    if (typeof body.result === "string") {
      try {
        return JSON.parse(body.result) as T;
      } catch {
        return body.result as unknown as T;
      }
    }
    return body.result as T;
  } catch (err) {
    console.error(`[Redis] GET ${key} error:`, err);
    throw err;
  }
}

export async function redisSet(key: string, value: any): Promise<boolean> {
  const url = getRedisUrl();
  const token = getRedisToken();
  if (!url || !token) return false;
  try {
    const cleanUrl = url.replace(/\/$/, "");
    const payload = typeof value === "string" ? value : JSON.stringify(value);
    const resp = await fetch(cleanUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["SET", key, payload]),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`[Redis] SET ${key} failed (${resp.status}): ${errText}`);
      throw new Error(`Upstash SET failed (${resp.status}): ${errText}`);
    }
    const result = await resp.json().catch(() => ({}));
    console.log(`[Redis] SET ${key} success:`, result);
    return true;
  } catch (err) {
    console.error(`[Redis] SET ${key} error:`, err);
    throw err;
  }
}
