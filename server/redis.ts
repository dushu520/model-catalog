/**
 * Upstash Redis / Vercel KV 轻量客户端（零依赖，直接走 HTTP REST API）
 * 环境变量支持（Vercel Upstash 集成时会自动注入以下几种变量名之一）：
 * 1. UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 * 2. KV_REST_API_URL / KV_REST_API_TOKEN
 * 3. 带有特定数据库后缀的变量（如 UPSTASH_REDIS_REST_KV_...）
 */

function getEnv(keys: string[]): string | undefined {
  for (const k of keys) {
    if (process.env[k]) return process.env[k];
  }
  // 扫描所有匹配的 UPSTASH_ 或 KV_ 环境变量
  for (const [k, v] of Object.entries(process.env)) {
    if (v && (k.endsWith("_REST_URL") || k.endsWith("_REST_API_URL"))) {
      if (keys.includes("URL")) return v;
    }
    if (v && (k.endsWith("_REST_TOKEN") || k.endsWith("_REST_API_TOKEN"))) {
      if (keys.includes("TOKEN")) return v;
    }
  }
  return undefined;
}

const url = getEnv(["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "URL"]);
const token = getEnv(["UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "TOKEN"]);

export const isRedisConfigured = Boolean(url && token);

export async function redisGet<T = any>(key: string): Promise<T | null> {
  if (!isRedisConfigured) return null;
  try {
    const cleanUrl = url!.replace(/\/$/, "");
    const resp = await fetch(`${cleanUrl}/get/${encodeURIComponent(key)}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const body = (await resp.json()) as { result?: any };
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
    return null;
  }
}

export async function redisSet(key: string, value: any): Promise<boolean> {
  if (!isRedisConfigured) return false;
  try {
    const cleanUrl = url!.replace(/\/$/, "");
    const payload = typeof value === "string" ? value : JSON.stringify(value);
    const resp = await fetch(`${cleanUrl}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    return resp.ok;
  } catch (err) {
    console.error(`[Redis] SET ${key} error:`, err);
    return false;
  }
}
