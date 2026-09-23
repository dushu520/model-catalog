/* Editorial Atlas reminder: shared data helpers keep platform provenance explicit and favor scan-friendly values over opaque transforms. */

export type PlatformKey = "opencode" | "cmdc";

export type Pricing = {
  currency?: string;
  input?: number | null;
  output?: number | null;
  cache_read?: number | null;
  cache_write?: number | null;
  tiers?: Array<Record<string, string | number | null>>;
  time_of_day?: unknown;
};

export type Allowance = {
  monthly_usd?: number | null;
  requests_5h?: number | null;
  requests_week?: number | null;
  requests_month?: number | null;
  plan_allowance?: string | Record<string, number | null> | null;
};

export type PlatformRecord = {
  id: string;
  protocols?: string[];
  multimodal?: string[];
  multimodal_web?: string[];
  pricing?: Pricing;
  allowance?: Allowance;
  discount?: {
    percent?: number | null;
    allowance_multiplier?: number | null;
    free?: boolean;
    note?: string | null;
  };
  notes?: string | null;
  source?: string | null;
  deprecated?: boolean;
  [key: string]: unknown;
};

export type MergedModel = {
  key: string;
  name: string;
  name_by_platform?: Partial<Record<PlatformKey, string>>;
  provider: string;
  category: "premium" | "opensource" | string;
  reasoning?: boolean | null;
  reasoning_by_platform?: Partial<Record<PlatformKey, boolean | null>>;
  /** 支持的推理强度档位（模型级，如 ["off","low","high","max"]），来自客户端可用配置 */
  reasoning_efforts?: string[];
  tool_use?: boolean | null;
  open_weights?: boolean | null;
  context_size?: number | null;
  context_size_by_platform?: Partial<Record<PlatformKey, number | null>>;
  max_output?: number | null;
  max_output_by_platform?: Partial<Record<PlatformKey, number | null>>;
  release_date?: string | null;
  release_date_by_platform?: Partial<Record<PlatformKey, string | null>>;
  updated_at?: string | null;
  updated_at_by_platform?: Partial<Record<PlatformKey, string | null>>;
  platforms: Partial<Record<PlatformKey, PlatformRecord>>;
  coverage: {
    platforms: PlatformKey[];
    count: number;
  };
  capabilities: {
    multimodal: string[];
    protocols: string[];
    platform_count: number;
  };
  sources: string[];
};

export type CatalogData = {
  meta: {
    generated_at: string;
    platforms: Record<PlatformKey, {
      label: string;
      site: string;
      model_count: number;
      subscription: string;
    }>;
    aggregation: {
      raw_records: number;
      merged_models: number;
      matching_strategy: string;
    };
  };
  models: Record<string, MergedModel>;
};

export const PLATFORM_META: Record<PlatformKey, { label: string; short: string; color: string }> = {
  opencode: { label: "OpenCode Go", short: "OC", color: "orange" },
  cmdc: { label: "CommandCode", short: "CC", color: "mint" },
};

export const PLATFORM_KEYS: PlatformKey[] = ["opencode", "cmdc"];

export const modalityLabels: Record<string, string> = {
  text: "文本",
  image: "图像",
  video: "视频",
  pdf: "PDF",
  audio: "音频",
  file: "文件",
};

export function formatTokens(value?: number | null) {
  if (value === null || value === undefined) return "未公开";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 ? 2 : 0)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 ? 1 : 0)}K`;
  return value.toLocaleString("en-US");
}

export function formatPrice(value?: number | null) {
  if (value === null || value === undefined) return "—";
  if (value >= 1) return `$${value.toFixed(2)}`;
  // 保留 3 位有效数字并去掉尾随 0：0.007→$0.007，0.0028→$0.0028，0.003625→$0.00363
  return `$${value.toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}

export function formatDate(value?: string | null) {
  if (!value) return "未公开";
  return value.replaceAll("-", ".");
}

export function displayProtocol(protocol?: string) {
  if (protocol === "messages") return "Messages";
  if (protocol === "responses") return "Responses";
  return protocol ? protocol.charAt(0).toUpperCase() + protocol.slice(1) : "—";
}

export function getPrimaryPricing(model: MergedModel) {
  const record = model.platforms.opencode ?? model.platforms.cmdc;
  return record?.pricing;
}

export function getDefaultContext(model: MergedModel) {
  return model.context_size ?? model.context_size_by_platform?.opencode ?? model.context_size_by_platform?.cmdc;
}

export function getDefaultUpdatedAt(model: MergedModel) {
  return model.updated_at ?? model.updated_at_by_platform?.opencode ?? model.updated_at_by_platform?.cmdc;
}

// CommandCode 为每个模型建了在线页 commandcode.ai/models/<slug>（OpenCode 没有）。
// slug 规则经全库实测：取平台 id 去掉厂商前缀（`vendor/name` 只留 name），再把点号换成横线
// （`gpt-5.6-luna` → `gpt-5-6-luna`）。命中率 70/72，未单独建页的 id 会 302 跳到模型列表页。
export function commandCodeModelUrl(id: string): string {
  const slug = id.split("/").pop()!.replace(/\./g, "-").trim();
  return `https://commandcode.ai/models/${encodeURIComponent(slug)}`;
}
