import express from "express";
type Request = any;
type Response = any;
import { createServer } from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import defaultCatalog from "../client/src/data/models.merged.json" with { type: "json" };
import defaultFavorites from "../client/src/data/models.favorite.json" with { type: "json" };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 平台归一化：cc/cmdc/cc-goat 与 oc/opencode 等常见写法统一到数据里的 key
const PLATFORM_ALIASES: Record<string, string> = {
  oc: "opencode",
  opencode: "opencode",
  "opencode-go": "opencode",
  cc: "cmdc",
  "cc-goat": "cmdc",
  cmdc: "cmdc",
  commandcode: "cmdc",
};

// 模型数据：server 打包为 dist/index.js 时，数据文件位于仓库 client/src/data 下。
// 无论从 dist 还是源码直接运行（tsx），都向上定位到项目根再进入数据目录。
const DATA_FILE = path.resolve(__dirname, "..", "client", "src", "data", "models.merged.json");
const FAVORITES_FILE = path.resolve(__dirname, "..", "client", "src", "data", "models.favorite.json");
const SYNC_TMP_DIR = path.resolve(__dirname, "..", ".sync-tmp");
const BACKUP_DIR = path.join(SYNC_TMP_DIR, "backups");
const ENV_FILE = path.join(SYNC_TMP_DIR, "api_keys.env");

const LIVE_ENDPOINTS: Record<string, string> = {
  opencode: "https://opencode.ai/zen/go/v1/models",
  cmdc: "https://api.commandcode.ai/provider/v1/models",
};

function normId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function bareId(value: string): string {
  return value.split("/").pop() ?? value;
}

export async function fetchCmdcDocModelsDirect(): Promise<Array<Record<string, any>>> {
  const resp = await fetch("https://commandcode.ai/docs/plans/goat", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(20000),
  });
  const html = await resp.text();

  const regex = /self\.__next_f\.push\(\[1,\s*"(.*?)"\]\)/g;
  let payload = "";
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    try {
      payload += JSON.parse('"' + match[1] + '"');
    } catch {}
  }

  const idx = payload.indexOf('"models":[');
  if (idx === -1) {
    throw new Error("Could not find 'models':[] array in CommandCode page RSC stream.");
  }

  const startBracket = idx + 9;
  let depth = 0;
  let endBracket = -1;
  for (let i = startBracket; i < payload.length; i++) {
    if (payload[i] === "[") depth++;
    else if (payload[i] === "]") {
      depth--;
      if (depth === 0) {
        endBracket = i + 1;
        break;
      }
    }
  }

  if (endBracket === -1) {
    throw new Error("Malformed models JSON array in CommandCode RSC stream.");
  }

  const rawJson = payload.substring(startBracket, endBracket).replace(/"\$undefined"/g, "null");
  const rawModels = JSON.parse(rawJson) as Array<Record<string, any>>;

  const extracted: Array<Record<string, any>> = [];
  for (const m of rawModels) {
    const rawId = m.id || m.slug;
    const bareKey = rawId.includes("/") ? rawId.split("/").pop() : rawId;
    const canonicalKey = bareKey.toLowerCase();

    const inputCost = m.inputCost ?? 0;
    const outputCost = m.outputCost ?? 0;
    const cacheRead = m.cacheReadCost ?? 0;
    const cacheWrite = m.cacheWriteCost ?? 0;

    const tiers: Array<Record<string, any>> = [];
    if (Array.isArray(m.tiers)) {
      for (const t of m.tiers) {
        const rates = t.rates || {};
        tiers.push({
          label: t.label ?? null,
          context: t.context ?? null,
          input: rates.input ?? inputCost,
          output: rates.output ?? outputCost,
          cache_read: rates.cacheRead ?? cacheRead,
          cache_write: rates.cacheWrite ?? cacheWrite,
        });
      }
    }

    const pricing: Record<string, any> = {
      input: inputCost,
      output: outputCost,
      cache_read: cacheRead,
      cache_write: cacheWrite,
    };
    if (tiers.length > 0) pricing.tiers = tiers;
    if (m.timeOfDay) pricing.time_of_day = m.timeOfDay;

    const caps = m.caps || {};
    const multimodal = ["text"];
    if (m.vision || caps.vision) multimodal.push("image");

    const monthlyCredits = m.minPlanName === "GOAT" ? 70.0 : 60.0;
    const allowance = {
      monthly_usd: monthlyCredits,
      plan_allowance: {
        goat: monthlyCredits,
      },
    };

    const notes: string[] = [];
    if (m.deal && typeof m.deal === "object") {
      notes.push(m.deal.note || m.deal.label || "");
    }
    if (m.minPlanName) {
      notes.push(`Min plan: ${m.minPlanName}`);
    }

    extracted.push({
      platform: "cmdc",
      key: canonicalKey,
      id: rawId,
      name: m.name || canonicalKey,
      provider: m.vendor,
      category: m.category || "opensource",
      context_size: m.contextWindow ?? null,
      multimodal,
      pricing,
      allowance,
      notes: notes.filter(Boolean).join(" · ") || null,
      deprecated: false,
    });
  }

  return extracted;
}

function readServerKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(ENV_FILE, "utf-8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const idx = trimmed.indexOf("=");
      out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  } catch {
    /* no env file */
  }
  return out;
}

function ccProtocol(provider?: string, name?: string): string[] {
  const text = `${provider ?? ""} ${name ?? ""}`.toLowerCase();
  return text.includes("anthropic") || text.includes("claude") ? ["messages"] : ["chat"];
}

function buildPlatformRecord(doc: Record<string, any>, platform: string): Record<string, any> {
  const rec: Record<string, any> = { id: doc.id };
  if (Array.isArray(doc.protocols) && doc.protocols.length > 0) rec.protocols = [...doc.protocols];
  else if (platform === "cmdc") rec.protocols = ccProtocol(doc.provider, doc.name);
  if (Array.isArray(doc.multimodal) && doc.multimodal.length > 0) rec.multimodal = [...doc.multimodal];
  if (doc.pricing && typeof doc.pricing === "object") rec.pricing = { currency: "USD", ...doc.pricing };
  if (doc.allowance && typeof doc.allowance === "object") rec.allowance = doc.allowance;
  if (doc.discount && typeof doc.discount === "object") rec.discount = doc.discount;
  if (typeof doc.deprecated === "boolean") rec.deprecated = doc.deprecated;
  if (doc.notes) rec.notes = doc.notes;
  rec.source = platform === "opencode" ? "opencode.ai/docs/zh-cn/go" : "commandcode.ai/docs/resources/pricing-limits";
  return rec;
}

function newMergedModel(doc: Record<string, any>, platform: string): Record<string, any> {
  const record = buildPlatformRecord(doc, platform);
  const root: Record<string, any> = {
    key: doc.key,
    name: doc.name ?? doc.key,
    provider: doc.provider ?? null,
    category: doc.category ?? null,
  };
  if (doc.context_size) root.context_size = doc.context_size;
  if (doc.max_output) root.max_output = doc.max_output;
  return {
    ...root,
    platforms: { [platform]: record },
    coverage: { platforms: [platform], count: 1 },
    capabilities: {
      multimodal: Array.from(new Set(record.multimodal ?? ["text"])).sort(),
      protocols: Array.from(new Set(record.protocols ?? [])).sort(),
      platform_count: 1,
    },
    sources: [record.source],
  };
}

function mergeIntoModel(model: Record<string, any>, doc: Record<string, any>, platform: string): Record<string, any> {
  const platforms = { ...(model.platforms ?? {}) };
  const old = platforms[platform] ?? {};
  const rec: Record<string, any> = { ...old, id: doc.id };
  for (const field of ["pricing", "allowance", "discount", "notes"] as const) {
    const val = doc[field];
    if (val === undefined || val === null) continue;
    if (field === "pricing" && typeof val === "object") rec.pricing = { ...(old.pricing ?? {}), currency: "USD", ...val };
    else rec[field] = val;
  }
  if (doc.context_size) rec.context_size = doc.context_size;
  if (Array.isArray(doc.multimodal) && doc.multimodal.length > 0) {
    rec.multimodal = Array.from(new Set([...(rec.multimodal ?? []), ...doc.multimodal])).sort();
  }
  if (Array.isArray(doc.protocols) && doc.protocols.length > 0) {
    rec.protocols = Array.from(new Set([...(rec.protocols ?? []), ...doc.protocols])).sort();
  } else if (platform === "cmdc" && !rec.protocols) {
    rec.protocols = ccProtocol(doc.provider ?? model.provider, doc.name ?? model.name);
  }
  if (typeof doc.deprecated === "boolean") rec.deprecated = doc.deprecated;
  rec.source = platform === "opencode" ? "opencode.ai/docs/zh-cn/go" : "commandcode.ai/docs/resources/pricing-limits";
  platforms[platform] = rec;
  const next: Record<string, any> = { ...model, platforms };
  for (const f of ["name", "provider", "category"] as const) {
    if (!next[f] && doc[f]) next[f] = doc[f];
  }
  if (doc.context_size && !next.context_size) next.context_size = doc.context_size;
  if (doc.max_output && !next.max_output) next.max_output = doc.max_output;
  return next;
}

function finalizeModel(model: Record<string, any>): Record<string, any> {
  const platforms: Record<string, any> = {};
  for (const [p, r] of Object.entries(model.platforms ?? {})) {
    if (r && typeof r === "object" && (r as any).id) platforms[p] = r;
  }
  const keys = Object.keys(platforms).sort();
  const mm = new Set<string>();
  const protos = new Set<string>();
  const sources: string[] = [];
  for (const p of keys) {
    for (const m of platforms[p].multimodal ?? []) mm.add(m);
    for (const pr of platforms[p].protocols ?? []) protos.add(pr);
    if (platforms[p].source) sources.push(platforms[p].source);
  }
  return {
    ...model,
    platforms,
    coverage: { platforms: keys, count: keys.length },
    capabilities: {
      multimodal: Array.from(mm).sort(),
      protocols: Array.from(protos).sort(),
      platform_count: keys.length,
    },
    sources: sources.length > 0 ? sources : (model.sources ?? []),
  };
}

// ---- LiteLLM 价格表输出（GET /api/models/prices）----
// 目录价格单位为 USD / 1M tokens；LiteLLM model_prices_and_context_window.json 为 USD / token。
type PricingTier = {
  label?: string | null;
  context?: string | number | null;
  input?: number | null;
  output?: number | null;
  cache_read?: number | null;
  cache_write?: number | null;
};

// 解析 tier.context 的 token 阈值：">272K"/"≤ 256K" → {op, tokens}；standard/null/Off-Peak 等返回 null
function parseTierContext(value: unknown): { op: ">" | "<="; tokens: number } | null {
  if (typeof value !== "string") return null;
  const m = value.replace(/\s/g, "").match(/^([<>≤<=]*)(\d+(?:\.\d+)?)([KkMm])?$/);
  if (!m) return null;
  const tokens = Math.round(parseFloat(m[2]) * (m[3]?.toLowerCase() === "m" ? 1e6 : m[3]?.toLowerCase() === "k" ? 1e3 : 1));
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return { op: m[1].includes(">") ? ">" : "<=", tokens };
}

// 每百万 token 价格 → 每 token；null/undefined 原样返回；取 12 位有效数字消掉浮点噪声
function perToken(value: number | null | undefined): number | null | undefined {
  if (value === null || value === undefined) return value;
  return Number((value / 1_000_000).toPrecision(12));
}

// 从模型的分档里选基准档与超限档：基准 = 最小的 "<=" 阈值档；超限 = 最大的 ">" 阈值档。
// LiteLLM 只支持一层 above_N_tokens 阈值，无法表达的分档（Off-Peak/Peak、多级 <=）忽略。
function pickTiers(tiers: PricingTier[] | undefined | null): { base?: PricingTier; upper?: PricingTier } {
  if (!Array.isArray(tiers) || tiers.length < 2) return {};
  let base: PricingTier | undefined;
  let upper: PricingTier | undefined;
  for (const t of tiers) {
    const c = parseTierContext(t?.context);
    if (!c) continue;
    if (c.op === "<=" && (!base || c.tokens < (parseTierContext(base.context)?.tokens ?? 0))) base = t;
    if (c.op === ">" && (!upper || c.tokens > (parseTierContext(upper.context)?.tokens ?? 0))) upper = t;
  }
  return { base, upper };
}

function litellmEntry(model: Record<string, any>, platformRec: Record<string, any>, platform: string): Record<string, any> | null {
  const pricing = platformRec.pricing as Record<string, any> | undefined;
  if (!pricing || typeof pricing !== "object") return null;
  if (pricing.currency && pricing.currency !== "USD") return null;
  const { base, upper } = pickTiers(pricing.tiers as PricingTier[] | undefined);
  const src = base ?? pricing;
  if (typeof src.input !== "number" && typeof src.output !== "number") return null;

  const entry: Record<string, any> = {};
  const contextSize = typeof platformRec.context_size === "number" ? platformRec.context_size : model.context_size;
  const maxOutput = typeof platformRec.max_output === "number" ? platformRec.max_output : model.max_output;
  if (typeof maxOutput === "number") {
    entry.max_tokens = maxOutput;
    entry.max_output_tokens = maxOutput;
  }
  if (typeof contextSize === "number") entry.max_input_tokens = contextSize;
  if (typeof src.input === "number") entry.input_cost_per_token = perToken(src.input);
  if (typeof src.output === "number") entry.output_cost_per_token = perToken(src.output);
  // LiteLLM 的长上下文超限价写在字段名里：input_cost_per_token_above_200k_tokens
  const upperTokens = upper ? parseTierContext(upper.context)?.tokens : undefined;
  if (upper && typeof upperTokens === "number") {
    const suffix = `above_${upperTokens}_tokens`;
    if (typeof upper.input === "number") entry[`input_cost_per_token_${suffix}`] = perToken(upper.input);
    if (typeof upper.output === "number") entry[`output_cost_per_token_${suffix}`] = perToken(upper.output);
  }
  const cacheRead = base ? (base.cache_read ?? pricing.cache_read) : pricing.cache_read;
  const cacheWrite = base ? (base.cache_write ?? pricing.cache_write) : pricing.cache_write;
  if (typeof cacheRead === "number") entry.cache_read_input_token_cost = perToken(cacheRead);
  if (typeof cacheWrite === "number") entry.cache_creation_input_token_cost = perToken(cacheWrite);

  entry.litellm_provider = String(model.provider ?? platform).toLowerCase().replace(/\s+/g, "-");
  entry.mode = "chat";
  const multimodal: string[] = Array.isArray(platformRec.multimodal) ? platformRec.multimodal : [];
  if (multimodal.includes("image")) entry.supports_vision = true;
  if (model.tool_use === true) entry.supports_function_calling = true;
  if (model.reasoning === true) entry.supports_reasoning = true;
  if (typeof cacheRead === "number") entry.supports_prompt_caching = true;
  return entry;
}

import { isRedisConfigured, redisGet, redisSet, getRedisUrl, getRedisToken } from "./redis";

const REDIS_MODELS_KEY = "model-catalog:models.merged:v1";
const REDIS_FAVORITES_KEY = "model-catalog:models.favorite:v1";

function loadCatalogLocal(): { meta: Record<string, any>; models: Record<string, any> } {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && parsed.models) {
        return {
          meta: parsed.meta ?? {},
          models: parsed.models ?? {},
        };
      }
    }
  } catch (err) {
    console.warn("loadCatalogLocal fs read failed, using bundled default:", err);
  }
  return {
    meta: (defaultCatalog as any).meta ?? {},
    models: (defaultCatalog as any).models ?? {},
  };
}

async function loadCatalog(): Promise<{ meta: Record<string, any>; models: Record<string, any> }> {
  if (isRedisConfigured()) {
    try {
      const cached = await redisGet<{ meta: Record<string, any>; models: Record<string, any> }>(REDIS_MODELS_KEY);
      if (cached && cached.models && Object.keys(cached.models).length > 0) {
        console.log(`[Storage] Loaded ${Object.keys(cached.models).length} models from Upstash Redis`);
        return cached;
      }
    } catch (e) {
      console.warn("[Storage] Failed to read from Redis, falling back to local file:", e);
    }
  }
  const local = loadCatalogLocal();
  // 如果配置了 Redis 且 Redis 还是空的，自动将本地初始数据填充进 Redis
  if (isRedisConfigured() && local.models && Object.keys(local.models).length > 0) {
    try {
      await redisSet(REDIS_MODELS_KEY, local);
      console.log(`[Storage] Initialized Upstash Redis with ${Object.keys(local.models).length} models`);
    } catch (e) {
      console.error("[Storage] Failed to seed Redis:", e);
    }
  }
  return local;
}

async function persistCatalog(merged: { meta?: Record<string, any>; models?: Record<string, any> }): Promise<string | null> {
  const payload = {
    meta: merged.meta ?? {},
    models: merged.models ?? {},
  };
  // 1. 如果配置了 Redis，持久化到 Redis
  if (isRedisConfigured()) {
    try {
      await redisSet(REDIS_MODELS_KEY, payload);
      console.log(`[Storage] Persisted ${Object.keys(payload.models).length} models to Upstash Redis`);
    } catch (err) {
      console.error("[Storage] Failed to persist to Redis:", err);
    }
  }

  // 2. 尝试写入本地文件并备份（如果在非只读环境，如本地运行）
  let backupName: string | null = null;
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "Z";
    const backupPath = path.join(BACKUP_DIR, `models.merged.${stamp}.json`);
    if (fs.existsSync(DATA_FILE)) {
      fs.copyFileSync(DATA_FILE, backupPath);
      backupName = path.basename(backupPath);
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2) + "\n", "utf-8");
  } catch {
    // Vercel Serverless 环境为只读文件系统，无法写本地文件是正常的
  }
  return backupName;
}

type FavRef = { platform: string; key: string };

function isValidFavRef(x: unknown): x is FavRef {
  if (!x || typeof x !== "object") return false;
  const ref = x as FavRef;
  return (ref.platform === "opencode" || ref.platform === "cmdc") && typeof ref.key === "string" && ref.key.length > 0;
}

// 收藏持久化：Redis 或 local JSON 文件
async function readFavorites(): Promise<FavRef[]> {
  if (isRedisConfigured()) {
    try {
      const cached = await redisGet<FavRef[]>(REDIS_FAVORITES_KEY);
      if (Array.isArray(cached)) return cached.filter(isValidFavRef);
    } catch {}
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(FAVORITES_FILE, "utf-8")) as unknown;
    const list = Array.isArray(parsed) ? parsed : (parsed as { favorites?: unknown }).favorites;
    return Array.isArray(list) ? list.filter(isValidFavRef) : [];
  } catch {
    return [];
  }
}

async function writeFavorites(refs: FavRef[]): Promise<void> {
  const clean = refs.filter(isValidFavRef);
  const seen = new Set<string>();
  const deduped = clean.filter((ref) => {
    const id = `${ref.platform}:${ref.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  if (isRedisConfigured()) {
    try {
      await redisSet(REDIS_FAVORITES_KEY, deduped);
    } catch (err) {
      console.error("[Storage] Failed to save favorites to Redis:", err);
    }
  }

  try {
    fs.writeFileSync(FAVORITES_FILE, JSON.stringify({ favorites: deduped }, null, 2) + "\n", "utf-8");
  } catch {
    // 只读环境忽略
  }
}

// 按平台投影：只保留该平台的视图。
// - platforms 只保留该平台记录
// - xxx_by_platform 分平台字段：该平台有独立值时提升为主字段值，否则保留原主字段，随后删除 by_platform
// - coverage 收敛为仅该平台
function projectToPlatform(model: unknown, platformKey: string): unknown {
  const m = model as Record<string, unknown>;
  const out: Record<string, unknown> = { ...m };

  const platforms = m.platforms;
  out.platforms =
    platforms && typeof platforms === "object" && platformKey in (platforms as Record<string, unknown>)
      ? { [platformKey]: (platforms as Record<string, unknown>)[platformKey] }
      : {};

  out.coverage = { platforms: [platformKey], count: 1 };

  for (const key of Object.keys(m)) {
    if (!key.endsWith("_by_platform")) continue;
    const byPlatform = m[key];
    if (byPlatform && typeof byPlatform === "object") {
      const val = (byPlatform as Record<string, unknown>)[platformKey];
      const base = key.slice(0, -"_by_platform".length);
      // 该平台有独立值 → 提升；否则保留原主字段值
      if (val !== undefined) out[base] = val;
    }
    delete out[key];
  }

  return out;
}

export const app = express();
app.use(express.json({ limit: "2mb" }));

// 内存中缓存的模型数据
let catalogData = loadCatalogLocal();
let models = (catalogData.models ?? {}) as Record<string, Record<string, any>>;

// 保证在 Serverless 环境下，请求处理之前完成 Redis 初始化与同步（避免后台异步被 Lambda 冻结）
let initPromise: Promise<void> | null = null;
async function ensureCatalogLoaded(): Promise<void> {
  if (isRedisConfigured()) {
    try {
      const fresh = await loadCatalog();
      if (fresh && fresh.models && Object.keys(fresh.models).length > 0) {
        models = fresh.models;
        console.log(`[Storage] Ensured ${Object.keys(models).length} models loaded in memory/Redis`);
      }
    } catch (e) {
      console.warn("[Storage] ensureCatalogLoaded failed:", e);
    }
  }
}

app.use(async (_req: Request, _res: Response, next: any) => {
  if (!initPromise) {
    initPromise = ensureCatalogLoaded();
  }
  try {
    await initPromise;
  } catch {}
  next();
});

// 状态探针与 Redis 信息（提供详细环境诊断）
app.get(["/api/status", "/status"], async (_req: Request, res: Response) => {
  const url = getRedisUrl();
  const token = getRedisToken();
  const configured = Boolean(url && token);
  let redisModelsCount = 0;
  let redisError: string | null = null;
  if (configured) {
    try {
      const data = await redisGet<{ models?: Record<string, any> }>(REDIS_MODELS_KEY);
      redisModelsCount = Object.keys(data?.models ?? {}).length;
      if (redisModelsCount === 0) {
        // 如果 Redis 还是空的，就地触发一次填充
        const seeded = await loadCatalog();
        redisModelsCount = Object.keys(seeded.models ?? {}).length;
      }
    } catch (e) {
      redisError = e instanceof Error ? e.message : String(e);
    }
  }

  // 收集环境变量名（安全：仅展示 key 名，绝不泄露 token 值）
  const relevantEnvKeys = Object.keys(process.env).filter(
    (k) => k.includes("REDIS") || k.includes("KV") || k.includes("REST")
  );

  let urlHost: string | null = null;
  try {
    if (url) urlHost = new URL(url).host;
  } catch {}

  res.json({
    ok: true,
    redisConfigured: configured,
    hasUrl: Boolean(url),
    hasToken: Boolean(token),
    urlHost,
    redisModelsCount,
    redisError,
    memoryModelsCount: Object.keys(models).length,
    relevantEnvKeys,
    vercel: process.env.VERCEL === "1",
  });
});

// 手动一键灌入/初始化 Redis 数据库
app.post(["/api/maintenance/seed-redis", "/maintenance/seed-redis"], async (_req: Request, res: Response) => {
  if (!isRedisConfigured()) {
    res.status(400).json({ error: "Redis not configured (missing URL or TOKEN)" });
    return;
  }
  try {
    const local = loadCatalogLocal();
    await redisSet(REDIS_MODELS_KEY, local);
    models = local.models;
    const favs = await readFavorites();
    await redisSet(REDIS_FAVORITES_KEY, favs);
    res.json({ ok: true, seededModels: Object.keys(models).length });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// GET /api/models?platform=oc&model=deepseek-v4-pro
// 过滤参数均可选：不带返回全部；platform 归一化（无法识别返回空）；model 匹配 key/name（忽略 -_. 与大小写）
app.get(["/api/models", "/models"], async (req: Request, res: Response) => {
  if (isRedisConfigured()) {
    try {
      const fresh = await loadCatalog();
      if (fresh.models && Object.keys(fresh.models).length > 0) {
        models = fresh.models;
      }
    } catch {}
  }
    const qPlatform = (req.query.platform as string | undefined) ?? "";
    const qModel = (req.query.model as string | undefined) ?? "";

    const rawPlatform = qPlatform.trim().toLowerCase();
    const platformKey = rawPlatform ? (PLATFORM_ALIASES[rawPlatform] ?? null) : undefined;

    const norm = (s: string) => s.toLowerCase().replace(/[-_.\s]/g, "");
    const modelNeedles = qModel
      .split(",")
      .map((s) => norm(s.trim()))
      .filter(Boolean);

    let result: unknown[] = Object.values(models);

    // platform 提供了但无法识别 → 空结果；未提供 → 不过滤
    if (rawPlatform && platformKey === null) {
      result = [];
    } else if (platformKey) {
      result = result
        .filter((m) => {
          const coverage = (m as { coverage?: { platforms?: string[] } }).coverage;
          return coverage?.platforms?.includes(platformKey) ?? false;
        })
        .map((m) => projectToPlatform(m, platformKey));
    }

    if (modelNeedles.length > 0) {
      result = result.filter((m) => {
        const rec = m as Record<string, unknown>;
        const key = typeof rec.key === "string" ? rec.key : "";
        const name = typeof rec.name === "string" ? rec.name : "";
        const nbp = rec.name_by_platform;
        const names: string[] = Array.isArray(nbp)
          ? nbp.filter((x): x is string => typeof x === "string")
          : nbp && typeof nbp === "object"
            ? Object.values(nbp as Record<string, unknown>).filter((x): x is string => typeof x === "string")
            : [];
        const haystacks = [key, name, ...names].filter(Boolean).map(norm);
        return modelNeedles.some((needle) => haystacks.some((hay) => hay === needle || hay.includes(needle)));
      });
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });

  // GET /api/models/list — 每平台模型的 id+name 列表
  // 返回 {"opencode":[{id,name},...], "cmdc":[{id,name},...]}，id 为各平台真实调用 id
  app.get(["/api/models/list", "/models/list"], (_req: Request, res: Response) => {
    const result: Record<string, Array<{ id: string; name: string }>> = {};
    for (const m of Object.values(models)) {
      const rec = m as {
        name?: string;
        coverage?: { platforms?: string[] };
        platforms?: Record<string, { id?: string }>;
      };
      const platformRecs = rec.platforms ?? {};
      for (const p of rec.coverage?.platforms ?? []) {
        (result[p] ??= []).push({ id: platformRecs[p]?.id ?? "", name: rec.name ?? "" });
      }
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });

  // GET /api/models/prices[?platform=oc|cc] — LiteLLM 官方价格表格式输出
  // 结构对齐 LiteLLM model_prices_and_context_window.json（扁平 map，key 为平台调用 id）：
  // - 价格换算为 USD/token（数据为 USD/1M tokens）；上下文分档映射为 input/output_cost_per_token_above_N_tokens
  // - supports_vision/function_calling/reasoning/prompt_caching 仅在为真时输出（与 LiteLLM 官方文件一致）
  // - 两个平台出现相同 id 时，条目 key 加 "<platform>/" 前缀消歧
  app.get(["/api/models/prices", "/models/prices"], (req: Request, res: Response) => {
    const qPlatform = String(req.query.platform ?? "").trim().toLowerCase();
    const platformKey = qPlatform ? (PLATFORM_ALIASES[qPlatform] ?? null) : undefined;
    if (qPlatform && platformKey === null) {
      res.status(400).json({ error: "unknown platform" });
      return;
    }
    const platformFilter = platformKey ? [platformKey] : ["opencode", "cmdc"];

    const rows: Array<{ platform: string; id: string; model: Record<string, any>; rec: Record<string, any> }> = [];
    for (const m of Object.values(models)) {
      for (const p of platformFilter) {
        const rec = m.platforms?.[p];
        if (rec?.id) rows.push({ platform: p, id: rec.id, model: m, rec });
      }
    }
    // 同名 id 跨平台冲突时加平台前缀
    const idCount = new Map<string, number>();
    for (const r of rows) idCount.set(r.id, (idCount.get(r.id) ?? 0) + 1);

    const result: Record<string, Record<string, any>> = {};
    for (const r of rows) {
      const entry = litellmEntry(r.model, r.rec, r.platform);
      if (!entry) continue;
      const key = (idCount.get(r.id) ?? 0) > 1 ? `${r.platform}/${r.id}` : r.id;
      result[key] = entry;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.json(result);
  });

  // GET /api/maintenance/local — 当前全量模型数据（写盘后与内存一致，维护页实时拉取）
  app.get(["/api/maintenance/local", "/maintenance/local"], async (_req: Request, res: Response) => {
    if (isRedisConfigured()) {
      try {
        const fresh = await loadCatalog();
        if (fresh.models && Object.keys(fresh.models).length > 0) {
          models = fresh.models;
        }
      } catch {}
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ total: Object.keys(models).length, models });
  });

  // GET /api/maintenance/live?platform=opencode|cmdc
  // 服务端代拉官方 /models（前端直连 CORS 失败时的兜底），返回 {id,name?,context_length?}[]
  app.get(["/api/maintenance/live", "/maintenance/live"], async (req: Request, res: Response) => {
    const platform = String(req.query.platform ?? "").toLowerCase();
    const target = platform === "cc" || platform === "cmdc" || platform === "commandcode" ? "cmdc" : platform === "oc" || platform === "opencode" ? "opencode" : "";
    if (!target) {
      res.status(400).json({ error: "unknown platform" });
      return;
    }
    try {
      const keys = readServerKeys();
      const headers: Record<string, string> = { "User-Agent": "model-catalog-maintenance/1.0", Accept: "application/json" };
      const key = target === "opencode" ? keys.OPENCODE_API_KEY ?? keys.OC_KEY ?? "" : keys.CC_KEY ?? keys.COMMANDCODE_API_KEY ?? "";
      if (key) headers.Authorization = `Bearer ${key}`;
      const resp = await fetch(LIVE_ENDPOINTS[target], { headers, signal: AbortSignal.timeout(30000) });
      const text = await resp.text();
      if (!resp.ok) {
        res.status(resp.status).json({ error: `upstream ${resp.status}: ${text.slice(0, 500)}` });
        return;
      }
      const body = JSON.parse(text) as { data?: Array<{ id: string; name?: string; context_length?: number }> };
      const items = (body.data ?? []).map((it) => ({
        id: it.id,
        ...(it.name ? { name: it.name } : {}),
        ...(typeof it.context_length === "number" ? { context_length: it.context_length } : {}),
      }));
      res.setHeader("Cache-Control", "no-store");
      res.json({ platform: target, count: items.length, items });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : "fetch failed" });
    }
  });

  // GET /api/maintenance/doc-models?platform=cmdc
  // 直接从官方文档 (Next.js RSC 流) 提取 100% 精确的模型元数据和价格配置
  app.get(["/api/maintenance/doc-models", "/maintenance/doc-models"], async (req: Request, res: Response) => {
    const platform = String(req.query.platform ?? "").toLowerCase();
    const target = platform === "cc" || platform === "cmdc" || platform === "commandcode" ? "cmdc" : "";
    if (!target) {
      res.status(400).json({ error: "currently only platform=cmdc is supported for direct doc stream extraction" });
      return;
    }
    try {
      const models = await fetchCmdcDocModelsDirect();
      res.setHeader("Cache-Control", "no-store");
      res.json({ platform: target, count: models.length, models });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : "failed to fetch doc models" });
    }
  });

  // POST /api/maintenance/apply — 把 LLM 产出的模型参数 JSON 合并进 models.merged.json
  // body: {models:[{platform,key,id,name?,provider?,category?,context_size?,max_output?,pricing?,allowance?,discount?,notes?,protocols?,multimodal?,deprecated?}]}
  // 只写提供的字段；写前自动备份；成功后同步更新内存并返回 actions + updated 模型
  app.post(["/api/maintenance/apply", "/maintenance/apply"], async (req: Request, res: Response) => {
    const docs = (req.body as { models?: unknown })?.models;
    const list: Array<Record<string, any>> = Array.isArray(docs) ? (docs as Array<Record<string, any>>) : [];
    if (list.length === 0 || list.length > 50) {
      res.status(400).json({ error: "body.models must be a non-empty array (<=50)" });
      return;
    }
    try {
      const current = await loadCatalog();
      const store: Record<string, Record<string, any>> = { ...(current.models ?? {}), ...models };
      const merged: { meta: Record<string, any>; models: Record<string, any> } = {
        meta: { ...(current.meta ?? {}) },
        models: store,
      };
      const byKey: Record<string, string> = {};
      for (const k of Object.keys(store)) byKey[normId(k)] = k;
      const actions: string[] = [];
      const updated: Array<{ key: string; platform: string; model: unknown }> = [];
      for (const raw of list) {
        const doc = raw as Record<string, any>;
        const platform = String(doc.platform ?? "").toLowerCase() === "opencode" ? "opencode" : String(doc.platform ?? "").toLowerCase() === "cmdc" ? "cmdc" : "";
        if (!platform || typeof doc.key !== "string" || !doc.key.trim() || typeof doc.id !== "string" || !doc.id.trim()) {
          res.status(400).json({ error: "each record needs platform(opencode|cmdc), key, id" });
          return;
        }
        const key = doc.key.trim();
        const clean: Record<string, any> = { ...doc, platform, key, id: String(doc.id).trim() };
        if (byKey[normId(key)] !== undefined && store[byKey[normId(key)]]) {
          const target = byKey[normId(key)];
          store[target] = finalizeModel(mergeIntoModel(store[target], clean, platform));
          actions.push(`update: ${target}.${platform} <- ${clean.id}`);
          updated.push({ key: target, platform, model: store[target] });
        } else {
          store[key] = finalizeModel(newMergedModel(clean, platform));
          byKey[normId(key)] = key;
          actions.push(`add: new model ${key} [${platform}]`);
          updated.push({ key, platform, model: store[key] });
        }
      }
      merged.models = Object.fromEntries(Object.entries(store).sort(([a], [b]) => a.localeCompare(b)));
      merged.meta = merged.meta ?? {};
      (merged.meta as any).last_synced_at = new Date().toISOString().slice(0, 19) + "Z";
      (merged.meta as any).aggregation = { ...((merged.meta as any).aggregation ?? {}), merged_models: Object.keys(store).length, total: Object.keys(store).length };
      
      const backup = await persistCatalog(merged);
      models = store;
      res.json({ ok: true, actions, updated, backup: backup ?? "redis", total: Object.keys(store).length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "apply failed" });
    }
  });

  // POST /api/maintenance/remove — 从配置中移除某模型的一个平台参数
  // body: {key, platform}；移除后若无平台则彻底删除该模型；写前自动备份
  app.post(["/api/maintenance/remove", "/maintenance/remove"], async (req: Request, res: Response) => {
    const key = typeof (req.body as { key?: unknown })?.key === "string" ? String((req.body as { key?: string }).key).trim() : "";
    const rawPlatform = String((req.body as { platform?: unknown })?.platform ?? "").toLowerCase();
    const platform = rawPlatform === "opencode" ? "opencode" : rawPlatform === "cmdc" ? "cmdc" : "";
    if (!key || !platform) {
      res.status(400).json({ error: "body needs key and platform(opencode|cmdc)" });
      return;
    }
    try {
      const current = await loadCatalog();
      const store: Record<string, Record<string, any>> = { ...(current.models ?? {}), ...models };
      const merged: { meta: Record<string, any>; models: Record<string, any> } = {
        meta: { ...(current.meta ?? {}) },
        models: store,
      };
      const byKey: Record<string, string> = {};
      for (const k of Object.keys(store)) byKey[normId(k)] = k;
      const target = byKey[normId(key)];
      if (!target || !store[target]) {
        res.status(404).json({ error: `model not found: ${key}` });
        return;
      }
      const model = store[target];
      const platforms = { ...(model.platforms ?? {}) };
      if (!platforms[platform]) {
        res.status(404).json({ error: `platform record not found: ${target}.${platform}` });
        return;
      }
      delete platforms[platform];
      const remaining = Object.keys(platforms).sort();
      let action = "";
      if (remaining.length === 0) {
        delete store[target];
        action = `delete: model ${target} (last platform ${platform} removed)`;
      } else {
        store[target] = finalizeModel({ ...model, platforms });
        action = `remove: ${target}.${platform} (kept ${remaining.join("+")})`;
      }
      merged.models = Object.fromEntries(Object.entries(store).sort(([a], [b]) => a.localeCompare(b)));
      merged.meta = merged.meta ?? {};
      (merged.meta as any).last_synced_at = new Date().toISOString().slice(0, 19) + "Z";
      (merged.meta as any).aggregation = { ...((merged.meta as any).aggregation ?? {}), merged_models: Object.keys(store).length, total: Object.keys(store).length };
      
      const backup = await persistCatalog(merged);
      models = store;
      res.json({ ok: true, action, deleted: remaining.length === 0, key: target, platform, remaining, backup: backup ?? "redis", total: Object.keys(store).length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "remove failed" });
    }
  });

  // POST /api/maintenance/pricing — 只改某平台记录的价格（指定档的四项单价 + 月额度）
  // body: {key, platform, tierIndex?, input?, output?, cache_read?, cache_write?, monthly_usd?}
  //   - tierIndex 指向 platforms.<platform>.pricing.tiers[<i>]；记录没有 tiers 时，根级单价即视为唯一档
  //   - body 未出现的价格字段一律保持原值；显式传 null 表示清空该字段
  //   - 改 tier 0（含无 tiers 的根级）时同步写回根级主价格，维持 tiers[0] ≡ pricing 的不变量
  //   - 只触碰 pricing/allowance，不动 id、协议、多模态等字段；写前自动备份
  app.post(["/api/maintenance/pricing", "/maintenance/pricing"], async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const rawPlatform = String(body.platform ?? "").toLowerCase();
    const platform = rawPlatform === "opencode" ? "opencode" : rawPlatform === "cmdc" ? "cmdc" : "";
    if (!key || !platform) {
      res.status(400).json({ error: "body needs key and platform(opencode|cmdc)" });
      return;
    }

    const PRICE_FIELDS = ["input", "output", "cache_read", "cache_write"] as const;
    const patch: Record<string, number | null> = {};
    for (const field of PRICE_FIELDS) {
      if (!(field in body)) continue;
      const value = body[field];
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        res.status(400).json({ error: `${field} must be a non-negative number or null` });
        return;
      }
      patch[field] = value as number | null;
    }
    let monthly: number | null | undefined;
    if ("monthly_usd" in body) {
      const value = body.monthly_usd;
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
        res.status(400).json({ error: "monthly_usd must be a non-negative number or null" });
        return;
      }
      monthly = value as number | null;
    }
    if (Object.keys(patch).length === 0 && monthly === undefined) {
      res.status(400).json({ error: "no price field provided" });
      return;
    }

    try {
      const current = await loadCatalog();
      const store: Record<string, Record<string, any>> = { ...(current.models ?? {}), ...models };
      const merged: { meta: Record<string, any>; models: Record<string, any> } = {
        meta: { ...(current.meta ?? {}) },
        models: store,
      };
      const byKey: Record<string, string> = {};
      for (const k of Object.keys(store)) byKey[normId(k)] = k;
      const target = byKey[normId(key)];
      if (!target || !store[target]) {
        res.status(404).json({ error: `model not found: ${key}` });
        return;
      }
      const model = store[target];
      const oldRec = (model.platforms ?? {})[platform];
      if (!oldRec || !oldRec.id) {
        res.status(404).json({ error: `platform record not found: ${target}.${platform}` });
        return;
      }

      const rec: Record<string, any> = { ...oldRec };
      const pricing: Record<string, any> = { ...(oldRec.pricing ?? {}) };
      pricing.currency = pricing.currency ?? "USD";
      const tiers: Array<Record<string, any>> = Array.isArray(pricing.tiers) ? pricing.tiers.map((t: Record<string, any>) => ({ ...t })) : [];
      const hasTiers = tiers.length > 0;
      let tierIndex = 0;
      if (hasTiers) {
        const rawIndex = body.tierIndex;
        if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= tiers.length) {
          res.status(400).json({ error: `tierIndex must be an integer in [0, ${tiers.length - 1}]` });
          return;
        }
        tierIndex = rawIndex;
        Object.assign(tiers[tierIndex], patch);
        pricing.tiers = tiers;
      } else if (body.tierIndex !== undefined && body.tierIndex !== null && body.tierIndex !== 0) {
        res.status(400).json({ error: "this record has a single price (no tiers); tierIndex must be 0" });
        return;
      }
      // tier 0 与根级主价格描述同一档价格，必须同步，否则列表/LiteLLM 导出会读到旧值
      if (!hasTiers || tierIndex === 0) Object.assign(pricing, patch);
      rec.pricing = pricing;
      if (monthly !== undefined) {
        const allowance: Record<string, any> = { ...(oldRec.allowance ?? {}) };
        if (monthly === null) delete allowance.monthly_usd;
        else allowance.monthly_usd = monthly;
        rec.allowance = allowance;
      }
      store[target] = finalizeModel({ ...model, platforms: { ...(model.platforms ?? {}), [platform]: rec } });

      merged.models = Object.fromEntries(Object.entries(store).sort(([a], [b]) => a.localeCompare(b)));
      merged.meta = merged.meta ?? {};
      (merged.meta as any).last_synced_at = new Date().toISOString().slice(0, 19) + "Z";
      (merged.meta as any).aggregation = { ...((merged.meta as any).aggregation ?? {}), merged_models: Object.keys(store).length, total: Object.keys(store).length };
      
      const backup = await persistCatalog(merged);
      models = store;
      res.json({
        ok: true,
        action: `pricing: ${target}.${platform} tier ${tierIndex}${hasTiers ? "" : " (root)"}${monthly !== undefined ? " + allowance" : ""}`,
        key: target,
        platform,
        tierIndex,
        hasTiers,
        pricing: rec.pricing,
        allowance: rec.allowance ?? null,
        model: store[target],
        backup: backup ?? "redis",
        total: Object.keys(store).length,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "pricing update failed" });
    }
  });

  // GET /api/models/favorite?platform=opencode|cc-goat
  // 输出后端持久化的收藏模型（我的模型页 / dsh 等 agent 配置用），只返回收藏的、字段压扁。
  // 收藏存于 client/src/data/models.favorite.json（前端点心形图标时经 POST 同步写入）。
  // 对外平台名：cmdc 显示为 cc-goat；查询时 platform=cc|cmdc|cc-goat 均可。
  // 如需覆盖收藏可传 favorites 参数（JSON 数组或 platform:key 简写），否则读后端文件。
  // 返回 {platform, models:[{id,name,contextWindow,maxTokens,input,reasoningEfforts}]}
  //   - id：该平台真实调用 id；name：该平台侧名称（name_by_platform 优先）
  //   - contextWindow/maxTokens：模型级 context_size/max_output（平台独立值优先）
  //   - input：该平台侧 multimodal（如 [text]）
  //   - reasoningEfforts：{off,low,medium,high,xhigh,max}，有该档则映射自己、无则 null
  app.get(["/api/models/favorite", "/models/favorite"], async (req: Request, res: Response) => {
    const qPlatform = String(req.query.platform ?? "").trim().toLowerCase();
    const platformKey = qPlatform ? (PLATFORM_ALIASES[qPlatform] ?? null) : undefined;
    if (qPlatform && platformKey === null) {
      res.status(400).json({ error: "unknown platform" });
      return;
    }

    type FavRef = { platform: string; key: string };
    let refs: FavRef[] = await readFavorites();
    const rawFav = String(req.query.favorites ?? "").trim();
    if (rawFav) {
      try {
        if (rawFav.startsWith("[")) {
          const parsed = JSON.parse(rawFav) as unknown;
          if (Array.isArray(parsed)) {
            refs = parsed
              .filter((x): x is FavRef => !!x && typeof x === "object" && typeof (x as FavRef).key === "string")
              .map((x) => ({
                platform: PLATFORM_ALIASES[String((x as FavRef).platform ?? "").toLowerCase()] ?? String((x as FavRef).platform ?? "").toLowerCase(),
                key: String((x as FavRef).key),
              }))
              .filter((x) => x.platform === "opencode" || x.platform === "cmdc");
          }
        } else {
          refs = rawFav.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
            const [p, ...rest] = s.split(":");
            if (rest.length === 0) return { platform: platformKey ?? "", key: p };
            return { platform: PLATFORM_ALIASES[p.toLowerCase()] ?? p.toLowerCase(), key: rest.join(":") };
          });
        }
      } catch {
        res.status(400).json({ error: "invalid favorites param" });
        return;
      }
    }

    const effortsOf = (m: Record<string, any>): string[] => Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts : [];

    const pick = (m: Record<string, any>, platform: string) => {
      const rec = m.platforms?.[platform];
      if (!rec?.id) return null;
      const byPlatformName = m.name_by_platform?.[platform];
      const byPlatformCtx = m.context_size_by_platform?.[platform];
      const byPlatformMax = m.max_output_by_platform?.[platform];
      const efforts: string[] = effortsOf(m);
      // off 恒为 null（关闭推理）；其余档位仅保留模型支持的，不支持的不输出 key
      const reasoningEfforts: Record<string, string | null> = { off: null };
      for (const slot of ["low", "medium", "high", "xhigh", "max"] as const) {
        if (efforts.includes(slot)) reasoningEfforts[slot] = slot;
      }
      return {
        id: rec.id as string,
        name: (typeof byPlatformName === "string" && byPlatformName ? byPlatformName : (m.name ?? m.key)) as string,
        contextWindow: (typeof byPlatformCtx === "number" ? byPlatformCtx : (m.context_size ?? null)) as number | null,
        maxTokens: (typeof byPlatformMax === "number" ? byPlatformMax : (m.max_output ?? null)) as number | null,
        input: Array.isArray(rec.multimodal) ? (rec.multimodal as string[]) : ["text"],
        reasoningEfforts,
      };
    };

    const byKey: Record<string, string> = {};
    for (const k of Object.keys(models)) byKey[normId(k)] = k;

    // 对外输出的平台名：cmdc -> cc-goat（内部存储/匹配仍用 cmdc）
    const displayPlatform = (p: string) => (p === "cmdc" ? "cc-goat" : p);
    const platforms = platformKey ? [platformKey] : ["opencode", "cmdc"];
    const groups: Record<string, Array<ReturnType<typeof pick>>> = {};
    for (const p of platforms) {
      const list: Array<NonNullable<ReturnType<typeof pick>>> = [];
      for (const ref of refs) {
        if (ref.platform && ref.platform !== p) continue;
        const target = byKey[normId(ref.key)] ?? ref.key;
        const m = models[target];
        if (!m) continue;
        const item = pick(m, p);
        if (item) list.push(item);
      }
      groups[displayPlatform(p)] = list;
    }

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (platformKey) res.json({ platform: displayPlatform(platformKey), models: groups[displayPlatform(platformKey)] });
    else res.json({ platforms: groups });
  });

  // GET /api/models/favorites — 后端持久化的原始收藏引用（前端同步/回填用）
  app.get(["/api/models/favorites", "/models/favorites"], async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ favorites: await readFavorites() });
  });

  // POST /api/models/favorites — 整体覆盖后端收藏并持久化
  // body: {favorites:[{platform,key}]}，返回落盘后的收藏
  app.post(["/api/models/favorites", "/models/favorites"], async (req: Request, res: Response) => {
    const list = (req.body as { favorites?: unknown })?.favorites;
    if (!Array.isArray(list)) {
      res.status(400).json({ error: "body.favorites must be an array of {platform,key}" });
      return;
    }
    const refs: FavRef[] = list
      .filter(isValidFavRef)
      .map((x) => ({ platform: x.platform, key: x.key }));
    try {
      await writeFavorites(refs);
      res.json({ ok: true, favorites: await readFavorites() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "write failed" });
    }
  });

  if (process.env.VERCEL !== "1") {
    // Serve static files from dist/public in production
    const staticPath =
      process.env.NODE_ENV === "production"
        ? path.resolve(__dirname, "public")
        : path.resolve(__dirname, "..", "dist", "public");

    app.use(express.static(staticPath));

    // Handle client-side routing - serve index.html for all routes
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(staticPath, "index.html"));
    });

    const port = process.env.PORT || 3006;
    const server = createServer(app);
    server.listen(port, () => {
      console.log(`Server running on http://localhost:${port}/`);
    });
  }

export const appPromise = Promise.resolve(app);
export default app;

// 兜底：单个异常请求（如无法解码的 URL）不应拖垮整个服务
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err.message);
});
