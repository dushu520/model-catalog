/* Editorial Atlas reminder: adding models is a background errand, not a modal hostage—jobs run at a fixed concurrency, outlive the dialog, and land one result at a time. */

import { toast } from "sonner";
import { loadApiKeys } from "@/components/ApiKeyDialog";
import { MergedModel, PlatformKey, PLATFORM_META } from "@/lib/model-catalog";

const ENRICH_MODEL_ID = "deepseek/deepseek-v4.1-flash";
const ENRICH_ENDPOINT = "https://api.commandcode.ai/provider/v1/chat/completions";
const CONCURRENCY = 2;

export const DOC_URLS: Record<PlatformKey, string> = {
  opencode: "https://opencode.ai/docs/zh-cn/go",
  cmdc: "https://commandcode.ai/docs/resources/pricing-limits",
};

export type NewModel = { id: string; name?: string; context_length?: number };

export type QueueStatus = "pending" | "running" | "failed";
export type QueueItem = { platform: PlatformKey; model: NewModel; status: QueueStatus; error?: string };
export type QueueSnapshot = { items: QueueItem[]; running: number; pending: number; failed: number };

type Subscriber = {
  update: (snapshot: QueueSnapshot) => void;
  /** 一批模型写入成功（用于把已写入条从「新增」列表移出、刷新本地数据、记录已写入） */
  completed?: (platform: PlatformKey, ids: string[], written: MergedModel[]) => void;
};

// 队列活在模块作用域，不随组件卸载中断：关闭弹窗、切页、返回都能继续跑完。
const items: QueueItem[] = [];
const subscribers = new Set<Subscriber>();
let active = 0;

function snapshot(): QueueSnapshot {
  return {
    items: items.map((i) => ({ ...i })),
    running: items.filter((i) => i.status === "running").length,
    pending: items.filter((i) => i.status === "pending").length,
    failed: items.filter((i) => i.status === "failed").length,
  };
}

function emit() {
  const snap = snapshot();
  subscribers.forEach((s) => s.update(snap));
}

function emitCompleted(platform: PlatformKey, ids: string[], written: MergedModel[]) {
  subscribers.forEach((s) => s.completed?.(platform, ids, written));
}

export function buildEnrichPrompt(platform: PlatformKey, target: NewModel): string {
  const docUrl = DOC_URLS[platform];
  const knownName = target.name ? `（已知名称：${target.name}）` : "";
  const knownCtx = typeof target.context_length === "number" ? `（已知上下文长度：${target.context_length}）` : "";
  return `请根据你已知的模型知识或官方文档 ${docUrl} 的定义，为以下新增的 AI 模型输出结构化元数据参数。

平台：${platform}（${PLATFORM_META[platform].label}）
待添加模型：${target.id} ${knownName} ${knownCtx}

要求：
1. 请分析该模型名称与厂商，输出规范的 JSON 数组。
2. 即使未获取到确切价格，也务必返回基本的有效条目（价格可为 null），不要拒绝回答。
3. 严格按此 schema 输出一个 JSON 数组（只包含这一个模型）：
[
  {
    "platform": "${platform}",
    "key": "<模型 key，去掉厂商前缀后的规范小写横线形式，如 deepseek-v4.1-flash>",
    "id": "${target.id}",
    "name": "${target.name ?? target.id.split("/").pop() ?? target.id}",
    "provider": "<所属厂商，如 DeepSeek, OpenAI, Anthropic, Google, Meta, Qwen, MiniMax, Moonshot 等>",
    "category": "opensource",
    "context_size": ${typeof target.context_length === "number" ? target.context_length : 131072},
    "pricing": {
      "input": null,
      "output": null,
      "cache_read": null,
      "cache_write": null,
      "tiers": []
    },
    "notes": "自动提取"
  }
]
4. 只返回包含该 JSON 数组的代码块或原始 JSON，不要包含任何额外的问候或前言解释。`;
}

/** 规范化 key：去除厂商前缀，转小写短横线 */
function deriveCanonicalKey(id: string): string {
  const bare = id.split("/").pop() ?? id;
  return bare.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
}

/** 猜测厂商 */
function guessProvider(id: string, name?: string): string {
  const text = `${id} ${name ?? ""}`.toLowerCase();
  if (text.includes("deepseek")) return "DeepSeek";
  if (text.includes("openai") || text.includes("gpt-") || text.includes("o1") || text.includes("o3")) return "OpenAI";
  if (text.includes("anthropic") || text.includes("claude")) return "Anthropic";
  if (text.includes("google") || text.includes("gemini")) return "Google";
  if (text.includes("meta") || text.includes("llama")) return "Meta";
  if (text.includes("qwen")) return "Qwen";
  if (text.includes("minimax")) return "MiniMax";
  if (text.includes("kimi") || text.includes("moonshot")) return "Moonshot";
  if (text.includes("glm") || text.includes("zhipu")) return "Zhipu";
  if (text.includes("mistral")) return "Mistral";
  return "AI";
}

/** 当 LLM 提取失败或无 Key 时的兜底模型结构，确保添加 100% 成功入库 */
function buildFallbackRecord(platform: PlatformKey, target: NewModel): Record<string, any> {
  const key = deriveCanonicalKey(target.id);
  const name = target.name || (target.id.split("/").pop() ?? target.id);
  const provider = guessProvider(target.id, target.name);
  return {
    platform,
    key,
    id: target.id,
    name,
    provider,
    category: "opensource",
    context_size: typeof target.context_length === "number" ? target.context_length : 131072,
    pricing: {
      input: null,
      output: null,
      cache_read: null,
      cache_write: null,
      tiers: [],
    },
    notes: "基础元数据（可点击改价补充详细参数）",
  };
}

function extractJsonArray(text: string): unknown[] {
  // 1. 优先尝试直接 parse
  try {
    const direct = JSON.parse(text);
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === "object") return [direct];
  } catch {}

  // 2. 匹配 ```json ... ``` 或 [ ... ]
  const blockMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const candidate = blockMatch ? blockMatch[1] : text;

  const start = candidate.indexOf("[");
  const end = candidate.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }

  // 3. 匹配单个对象 { ... }
  const objStart = candidate.indexOf("{");
  const objEnd = candidate.lastIndexOf("}");
  if (objStart >= 0 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(candidate.slice(objStart, objEnd + 1));
      if (parsed && typeof parsed === "object") return [parsed];
    } catch {}
  }

  throw new Error("LLM 返回中未解析出合法的 JSON");
}

function readChoiceText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  const content = choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown })?.text === "string" ? String((part as { text?: unknown }).text) : ""))
      .join("");
  }
  return "";
}

// 写入数据文件
async function applyModels(records: unknown[]): Promise<MergedModel[]> {
  const resp = await fetch("/api/maintenance/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models: records }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await resp.text();
  let body: { ok?: boolean; error?: string; updated?: Array<{ model: MergedModel }> } = {};
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`服务响应异常 (${resp.status}): ${text.slice(0, 100)}`);
  }
  if (!resp.ok || !body.ok) throw new Error(body.error ?? `写入失败 ${resp.status}`);
  return (body.updated ?? []).map((u) => u.model);
}

// 单个模型：针对 CommandCode 优先从服务端直接抓取官方 Next.js RSC 精准价格，避免 LLM 遗漏与未设置
async function runItem(item: QueueItem, ccKey: string): Promise<MergedModel[]> {
  let records: unknown[] | null = null;

  // 1. CommandCode 平台：优先调用官方文档底层流式接口提取 100% 精确参数
  if (item.platform === "cmdc") {
    try {
      const resp = await fetch("/api/maintenance/doc-models?platform=cmdc", {
        signal: AbortSignal.timeout(25000),
      });
      if (resp.ok) {
        const body = (await resp.json()) as { models?: Array<Record<string, any>> };
        const found = (body.models ?? []).find(
          (m) =>
            m.id === item.model.id ||
            m.key === deriveCanonicalKey(item.model.id) ||
            m.id?.toLowerCase() === item.model.id.toLowerCase()
        );
        if (found) {
          records = [found];
        }
      }
    } catch (e) {
      console.warn(`[enrich-queue] 直取官方文档数据失败，尝试备用机制:`, e);
    }
  }

  // 2. 若未从官方文档接口直接匹配到（或属于 OpenCode 平台），且有 API Key，走 LLM 智能提取
  if (!records && ccKey) {
    try {
      const resp = await fetch(ENRICH_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ccKey}` },
        body: JSON.stringify({
          model: ENRICH_MODEL_ID,
          messages: [{ role: "user", content: buildEnrichPrompt(item.platform, item.model) }],
          temperature: 0.1,
          stream: false,
          reasoning_effort: "low",
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (resp.ok) {
        const text = await resp.text();
        const extracted = extractJsonArray(readChoiceText(JSON.parse(text) as unknown));
        if (extracted.length > 0) {
          records = extracted;
        }
      }
    } catch (e) {
      console.warn(`[enrich-queue] LLM 提取模型 ${item.model.id} 参数失败，降级为保底模板:`, e);
    }
  }

  // 3. 若均未提取成功，使用基础兜底结构保证添加成功（后续可随时重配价格）
  if (!records || records.length === 0) {
    records = [buildFallbackRecord(item.platform, item.model)];
  }

  return await applyModels(records);
}

function dropItem(item: QueueItem) {
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
}

async function pump() {
  const ccKey = loadApiKeys().cmdc;
  while (active < CONCURRENCY) {
    const next = items.find((i) => i.status === "pending");
    if (!next) break;
    // 同步占位，避免同一 tick 内被重复取走
    next.status = "running";
    active += 1;
    emit();
    void (async () => {
      try {
        const written = await runItem(next, ccKey);
        const ids = [next.model.id];
        dropItem(next);
        emit();
        emitCompleted(next.platform, ids, written);
        toast.success(`已新增 ${next.model.name ?? next.model.id}（${PLATFORM_META[next.platform].label}）`);
      } catch (error) {
        next.status = "failed";
        next.error = error instanceof Error ? error.message : "新增失败";
        emit();
        toast.error(`新增 ${next.model.id} 失败：${next.error}`);
      } finally {
        active -= 1;
        if (items.some((i) => i.status === "pending")) void pump();
      }
    })();
  }
}

/** 入队若干个模型的新增任务；已在队列中的同 id 会跳过。 */
export function submitEnrich(platform: PlatformKey, models: NewModel[]) {
  const fresh = models.filter((m) => !items.some((i) => i.platform === platform && i.model.id === m.id));
  if (fresh.length === 0) return;
  for (const model of fresh) items.push({ platform, model, status: "pending" });
  emit();
  void pump();
}

/** 重试一个失败的模型。 */
export function retryEnrich(platform: PlatformKey, model: NewModel) {
  const existing = items.find((i) => i.platform === platform && i.model.id === model.id);
  if (existing) {
    existing.status = "pending";
    existing.error = undefined;
  } else {
    items.push({ platform, model, status: "pending" });
  }
  emit();
  void pump();
}

export function subscribeEnrich(sub: Subscriber): () => void {
  subscribers.add(sub);
  sub.update(snapshot());
  return () => {
    subscribers.delete(sub);
  };
}
