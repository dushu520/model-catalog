/* Editorial Atlas reminder: adding models is a background errand, not a modal hostage—jobs run at a fixed concurrency, outlive the dialog, and land one result at a time. */

import { toast } from "sonner";
import { loadApiKeys } from "@/components/ApiKeyDialog";
import { MergedModel, PlatformKey, PLATFORM_META } from "@/lib/model-catalog";

const ENRICH_MODEL_ID = "deepseek/deepseek-v4-flash";
const ENRICH_ENDPOINT = "https://api.commandcode.ai/provider/v1/chat/completions";
const CONCURRENCY = 3;

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
  return `使用 ${docUrl} 获取模型 ${ENRICH_MODEL_ID} 不存在时的模型ID，价格、上下文大小等相关参数，并用json返回。\n\n平台：${platform}（${PLATFORM_META[platform].label}）\n新增模型清单（以 /models 返回的真实调用 id 为准）：\n- ${target.id}\n\n要求：\n1. 对上新增模型，从官方文档页提取参数；关闭推理，只输出结构化 JSON。\n2. 严格按此 schema 输出 JSON 数组（每个记录 = 一个平台侧），字段缺省即官方页面未提供，不要编造：\n[{"platform":"${platform}","key":"<id 去厂商前缀后的规范小写横线形>","id":"<与上面清单完全一致的真实调用 id>","name":"<模型名>","provider":"<厂商>","category":"opensource|premium","context_size":<数字>,"pricing":{"input":<USD/1M>,"output":<USD/1M>,"cache_read":<USD/1M>,"cache_write":<USD/1M>,"tiers":[...]},"allowance":{"monthly_usd":<数字>,"plan_allowance":{...}},"notes":"<备注>"}]\n3. 价格单位一律 USD / 每 1M token；有分档（tier/峰谷）放 pricing.tiers。\n4. 只返回 JSON 数组，不要其他解释文字。`;
}

function extractJsonArray(text: string): unknown[] {
  const direct = (() => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  })();
  if (Array.isArray(direct)) return direct;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("LLM 返回中未找到 JSON 数组");
  const parsed: unknown = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("LLM 返回不是 JSON 数组");
  return parsed;
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

// 单个模型：LLM 提取参数 → 写入 data 文件。返回写入的模型列表。
async function runItem(item: QueueItem, ccKey: string): Promise<MergedModel[]> {
  const resp = await fetch(ENRICH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ccKey}` },
    body: JSON.stringify({
      model: ENRICH_MODEL_ID,
      messages: [{ role: "user", content: buildEnrichPrompt(item.platform, item.model) }],
      temperature: 0,
      stream: false,
      // CommandCode 只接受 low|medium|high|xhigh|max，用最低档 low 近似关闭推理
      reasoning_effort: "low",
    }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`参数提取失败 ${resp.status}: ${text.slice(0, 300)}`);
  const results = extractJsonArray(readChoiceText(JSON.parse(text) as unknown));
  const resp2 = await fetch("/api/maintenance/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models: results }),
    signal: AbortSignal.timeout(30000),
  });
  const body = (await resp2.json()) as { ok?: boolean; error?: string; updated?: Array<{ model: MergedModel }> };
  if (!resp2.ok || !body.ok) throw new Error(body.error ?? `写入失败 ${resp2.status}`);
  return (body.updated ?? []).map((u) => u.model);
}

function dropItem(item: QueueItem) {
  const index = items.indexOf(item);
  if (index >= 0) items.splice(index, 1);
}

async function pump() {
  const ccKey = loadApiKeys().cmdc;
  if (!ccKey) {
    const orphans = items.filter((i) => i.status === "pending");
    for (const o of orphans) {
      o.status = "failed";
      o.error = "未设置 CommandCode API Key";
    }
    if (orphans.length > 0) {
      emit();
      toast.error("尚未设置 CommandCode API Key，请先在设置中填入 CC_KEY");
    }
    return;
  }
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
