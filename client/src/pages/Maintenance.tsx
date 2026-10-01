/* Editorial Atlas reminder: maintenance is a workbench—two platform columns scan side by side, new models stay inspectable before landing. */

import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Heart, Loader2, Plus, RefreshCw, RotateCw, Search, Settings2, Tag, Trash2, X } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import ApiKeyDialog, { loadApiKeys } from "@/components/ApiKeyDialog";
import PricingDialog from "@/components/PricingDialog";
import TestDialog from "@/components/TestDialog";
import rawData from "@/data/models.merged.json";
import {
  retryEnrich,
  subscribeEnrich,
  submitEnrich,
  type NewModel,
  type QueueItem,
  type QueueSnapshot,
} from "@/lib/enrich-queue";
import { isFavorite, loadFavorites, toggleFavorite, type FavoriteRef } from "@/lib/favorites";
import { hideModelKey, loadHiddenKeys, persistHiddenKeys, unhideModelKey } from "@/lib/hidden-models";
import { CatalogData, MergedModel, PlatformKey, PLATFORM_META } from "@/lib/model-catalog";
import { useCatalog } from "@/contexts/CatalogContext";

const catalog = rawData as CatalogData;

const LIVE_ENDPOINTS: Record<PlatformKey, string> = {
  opencode: "https://opencode.ai/zen/go/v1/models",
  cmdc: "https://api.commandcode.ai/provider/v1/models",
};

type LiveItem = { id: string; name?: string; context_length?: number };
type RemovedModel = { key: string; name: string; id: string };
type ReportTab = "added" | "removed";
type Report = { platform: PlatformKey; added: NewModel[]; removed: RemovedModel[]; total: number; tab: ReportTab };

function norm(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function bare(value: string) {
  return value.split("/").pop() ?? value;
}

function localNorms(models: MergedModel[], platform: PlatformKey): Set<string> {
  const out = new Set<string>();
  for (const model of models) {
    const record = model.platforms[platform];
    out.add(norm(model.key));
    if (record?.id) {
      out.add(norm(record.id));
      out.add(norm(bare(record.id)));
    }
  }
  return out;
}

async function fetchLiveDirect(platform: PlatformKey, key: string): Promise<LiveItem[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const resp = await fetch(LIVE_ENDPOINTS[platform], { headers, signal: AbortSignal.timeout(30000) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { data?: LiveItem[] };
  return body.data ?? [];
}

async function fetchLiveViaServer(platform: PlatformKey): Promise<LiveItem[]> {
  const resp = await fetch(`/api/maintenance/live?platform=${platform}`, { signal: AbortSignal.timeout(45000) });
  const body = (await resp.json()) as { items?: LiveItem[]; error?: string };
  if (!resp.ok) throw new Error(body.error ?? `代理请求失败 ${resp.status}`);
  return body.items ?? [];
}

function formatPriceShort(value?: number | null) {
  if (value === null || value === undefined) return "—";
  if (value >= 1) return `$${value.toFixed(2)}`;
  // 保留 3 位有效数字并去掉尾随 0：0.007→$0.007，0.0028→$0.0028，0.003625→$0.00363
  return `$${value.toPrecision(3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}`;
}

type MaintQuote = { name?: string | null; input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null };

function maintTierName(raw: Record<string, unknown>): string | null {
  // 阈值原文在 context（如 ≤ 272K），优先展示；label 多为 Standard/Long context 这类通用名
  const label = [raw.context, raw.label, raw.name].find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim();
  if (!label || /^(standard|default|base)$/i.test(label)) return null;
  return label.replace(/<=/g, "≤").replace(/>=/g, "≥").replace(/([<>])\s+/g, "$1");
}

function collectMaintQuotes(pricing: {
  input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown; time_of_day?: unknown; tiers?: unknown;
} | undefined): MaintQuote[] {
  if (!pricing) return [];
  const quotes: MaintQuote[] = [];
  const tod = pricing.time_of_day as
    | { offPeak?: Record<string, unknown>; peak?: Record<string, unknown> }
    | undefined;
  const num = (row: Record<string, unknown> | undefined, ...keys: string[]): number | null => {
    for (const key of keys) {
      const value = row?.[key];
      if (typeof value === "number") return value;
    }
    return null;
  };
  if (tod && (tod.offPeak || tod.peak)) {
    if (tod.offPeak) {
      quotes.push({ name: "Off-Peak", input: num(tod.offPeak, "inputCost", "input"), output: num(tod.offPeak, "outputCost", "output"), cacheRead: num(tod.offPeak, "cacheReadCost", "cache_read"), cacheWrite: num(tod.offPeak, "cacheWriteCost", "cache_write") });
    }
    if (tod.peak) {
      quotes.push({ name: "Peak", input: num(tod.peak, "inputCost", "input"), output: num(tod.peak, "outputCost", "output"), cacheRead: num(tod.peak, "cacheReadCost", "cache_read"), cacheWrite: num(tod.peak, "cacheWriteCost", "cache_write") });
    }
  }
  if (Array.isArray(pricing.tiers)) {
    for (const raw of pricing.tiers as Array<Record<string, unknown>>) {
      const tier = (raw ?? {}) as Record<string, unknown>;
      const label = maintTierName(tier);
      const quote: MaintQuote = {
        name: label,
        input: typeof tier.input === "number" ? tier.input : null,
        output: typeof tier.output === "number" ? tier.output : null,
        cacheRead: typeof tier.cache_read === "number" ? tier.cache_read : null,
        cacheWrite: typeof tier.cache_write === "number" ? tier.cache_write : null,
      };
      // 无名 tiers 若与已收录任一条价格完全相同，视为同一档，不重复收录
      if (!label) {
        const sig = [quote.input, quote.output, quote.cacheRead, quote.cacheWrite].join("|");
        if (quotes.some((q) => [q.input, q.output, q.cacheRead, q.cacheWrite].join("|") === sig)) continue;
      }
      quotes.push(quote);
    }
  }
  // 去重：同一档名 + 同一组价格只保留一条
  const seen = new Set<string>();
  const deduped = quotes.filter((quote) => {
    const key = [quote.name, quote.input, quote.output, quote.cacheRead, quote.cacheWrite].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length > 0) return deduped;
  // 单一报价：直接价，无档名
  const single: MaintQuote = {
    name: null,
    input: typeof pricing.input === "number" ? pricing.input : null,
    output: typeof pricing.output === "number" ? pricing.output : null,
    cacheRead: typeof pricing.cache_read === "number" ? pricing.cache_read : null,
    cacheWrite: typeof pricing.cache_write === "number" ? pricing.cache_write : null,
  };
  if (single.input === null && single.output === null && single.cacheRead === null && single.cacheWrite === null) return [];
  return [single];
}

function quotePrice(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : formatPriceShort(value);
}

function RowPrice({ model, platform }: { model: MergedModel; platform: PlatformKey }) {
  const pricing = model.platforms[platform]?.pricing as
    | { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown; time_of_day?: unknown; tiers?: unknown }
    | undefined;
  const quotes = collectMaintQuotes(pricing);
  if (quotes.length === 0) {
    return <span className="maint-price"><strong>价格未公开</strong></span>;
  }
  return (
    <span className="maint-price maint-price--quotes" title="USD 每 1M token">
      {quotes.map((quote, index) => (
        <span key={`${quote.name ?? "std"}-${index}`} className="maint-price-line">
          {quote.name && <em>{quote.name}</em>}
          <span>入 <strong>{quotePrice(quote.input)}</strong></span>
          <span>出 <strong>{quotePrice(quote.output)}</strong></span>
          <span>缓读 <strong>{quotePrice(quote.cacheRead)}</strong></span>
          {typeof quote.cacheWrite === "number" && <span>缓写 <strong>{quotePrice(quote.cacheWrite)}</strong></span>}
        </span>
      ))}
    </span>
  );
}

function ColumnList({
  title,
  short,
  models,
  hiddenView,
  favorites,
  removingKey,
  onHide,
  onUnhide,
  onTest,
  onToggleFavorite,
  onEditPricing,
  onDelete,
}: {
  title: string;
  short: string;
  models: MergedModel[];
  hiddenView: boolean;
  favorites: FavoriteRef[];
  removingKey?: string;
  onHide: (key: string) => void;
  onUnhide: (key: string) => void;
  onTest: (model: MergedModel, platform: PlatformKey) => void;
  onToggleFavorite: (model: MergedModel, platform: PlatformKey) => void;
  onEditPricing: (model: MergedModel, platform: PlatformKey) => void;
  onDelete: (model: MergedModel, platform: PlatformKey) => void;
}) {
  if (models.length === 0) {
    return <div className="maint-empty">{hiddenView ? "没有已隐藏的该平台模型。" : "该平台暂无模型。"}</div>;
  }
  return (
    <div className="maint-list">
      {models.map((model, index) => (
        <div className="maint-row" key={model.key}>
          <span className="maint-index">{String(index + 1).padStart(2, "0")}</span>
          <div className="maint-identity">
            <button className="maint-name" type="button" title="测试该模型" onClick={() => onTest(model, title as PlatformKey)}>{model.name}</button>
            <code>{model.platforms[title as PlatformKey]?.id ?? model.key}</code>
          </div>
          <RowPrice model={model} platform={title as PlatformKey} />
          <span className="maint-actions">
            <button
              className="maint-edit"
              type="button"
              title="修改该平台价格"
              onClick={() => onEditPricing(model, title as PlatformKey)}
            >
              <Tag size={14} />
              改价
            </button>
            <button
              className={isFavorite(favorites, title as PlatformKey, model.key) ? "maint-fav is-active" : "maint-fav"}
              type="button"
              title={isFavorite(favorites, title as PlatformKey, model.key) ? "取消喜爱" : "加入我的模型"}
              aria-pressed={isFavorite(favorites, title as PlatformKey, model.key)}
              onClick={() => onToggleFavorite(model, title as PlatformKey)}
            >
              <Heart size={14} />
            </button>
            <button
              className="maint-hide"
              type="button"
              title={hiddenView ? "恢复显示" : "隐藏该模型"}
              onClick={() => (hiddenView ? onUnhide(model.key) : onHide(model.key))}
            >
              {hiddenView ? <Eye size={14} /> : <EyeOff size={14} />}
              {hiddenView ? "恢复" : "隐藏"}
            </button>
            <button
              className="maint-del"
              type="button"
              title={`从 ${short} 移除该模型`}
              disabled={removingKey === `${model.key}-${title}`}
              onClick={() => onDelete(model, title as PlatformKey)}
            >
              {removingKey === `${model.key}-${title}` ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
              删除
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

export default function Maintenance() {
  const [hiddenKeys, setHiddenKeys] = useState<string[]>(() => loadHiddenKeys());
  const [showHidden, setShowHidden] = useState(false);
  const [platformFilter, setPlatformFilter] = useState<PlatformKey | "all">("cmdc");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [live, setLive] = useState<Record<PlatformKey, LiveItem[]>>({ opencode: [], cmdc: [] });
  const [liveAt, setLiveAt] = useState<Record<PlatformKey, string>>({ opencode: "", cmdc: "" });
  const [refreshing, setRefreshing] = useState<Record<PlatformKey, boolean>>({ opencode: false, cmdc: false });
  const [report, setReport] = useState<Report | null>(null);
  const [removing, setRemoving] = useState("");
  const [queue, setQueue] = useState<QueueSnapshot>({ items: [], running: 0, pending: 0, failed: 0 });
  const [applied, setApplied] = useState<MergedModel[]>([]);
  const [localModels, setLocalModels] = useState<MergedModel[]>(() => Object.values(catalog.models));
  const [localLoading, setLocalLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [testModel, setTestModel] = useState<MergedModel | null>(null);
  const [testPlatform, setTestPlatform] = useState<PlatformKey | null>(null);
  const [priceEdit, setPriceEdit] = useState<{ model: MergedModel; platform: PlatformKey } | null>(null);
  const [favorites, setFavorites] = useState<FavoriteRef[]>(() => loadFavorites());

  const openTest = (model: MergedModel, platform: PlatformKey) => {
    setTestModel(model);
    setTestPlatform(model.platforms[platform] ? platform : null);
  };

  const closeTest = () => {
    setTestModel(null);
    setTestPlatform(null);
  };

  const openPricing = (model: MergedModel, platform: PlatformKey) => {
    setPriceEdit({ model, platform });
  };

  const { refresh: refreshGlobalCatalog } = useCatalog();

  const reloadLocal = async (silent = false) => {
    setLocalLoading(true);
    try {
      const resp = await fetch("/api/maintenance/local", { signal: AbortSignal.timeout(15000) });
      const body = (await resp.json()) as { models?: Record<string, MergedModel> };
      if (resp.ok && body.models) {
        setLocalModels(Object.values(body.models));
        void refreshGlobalCatalog();
      }
    } catch {
      if (!silent) toast.error("本地数据拉取失败，仍显示构建时快照");
    } finally {
      setLocalLoading(false);
    }
  };

  useEffect(() => {
    reloadLocal(true);
  }, []);

  // 订阅后台新增队列：弹窗关了、页面切走了，任务仍在跑；完成一条数据就刷新一条。
  useEffect(() => {
    const unsubscribe = subscribeEnrich({
      update: setQueue,
      completed: (platform, ids, written) => {
        const idSet = new Set(ids);
        setReport((prev) =>
          prev && prev.platform === platform ? { ...prev, added: prev.added.filter((item) => !idSet.has(item.id)) } : prev,
        );
        if (written.length > 0) setApplied((prev) => [...written, ...prev]);
        void reloadLocal(true);
      },
    });
    return unsubscribe;
  }, []);

  const queueItemFor = (platform: PlatformKey, id: string): QueueItem | undefined =>
    queue.items.find((i) => i.platform === platform && i.model.id === id);
  const queuePending = queue.running + queue.pending;

  const hiddenSet = useMemo(() => new Set(hiddenKeys), [hiddenKeys]);
  const allModels = localModels;
  const visibleModels = useMemo(() => allModels.filter((model) => !hiddenSet.has(model.key)), [allModels, hiddenSet]);
  const hiddenModels = useMemo(() => allModels.filter((model) => hiddenSet.has(model.key)), [allModels, hiddenSet]);
  const sourceModels = showHidden ? hiddenModels : visibleModels;
  const filteredModels = useMemo(() => {
    const text = query.trim().toLowerCase();
    if (!text) return sourceModels;
    return sourceModels.filter((model) => {
      const ocId = model.platforms.opencode?.id ?? "";
      const ccId = model.platforms.cmdc?.id ?? "";
      return [model.key, model.name, model.provider ?? "", ocId, ccId].some((field) => field.toLowerCase().includes(text));
    });
  }, [query, sourceModels]);
  const ocModels = useMemo(() => filteredModels.filter((model) => model.platforms.opencode).sort((a, b) => a.name.localeCompare(b.name)), [filteredModels]);
  const ccModels = useMemo(() => filteredModels.filter((model) => model.platforms.cmdc).sort((a, b) => a.name.localeCompare(b.name)), [filteredModels]);
  const shownPlatforms = platformFilter === "all" ? (["opencode", "cmdc"] as PlatformKey[]) : ([platformFilter] as PlatformKey[]);

  useEffect(() => {
    persistHiddenKeys(hiddenKeys);
  }, [hiddenKeys]);

  const handleHide = (key: string) => {
    setHiddenKeys(hideModelKey(key));
    toast.success(`已隐藏 ${key}，首页与对比页不再显示`);
  };

  const handleToggleFavorite = (model: MergedModel, platform: PlatformKey) => {
    const next = toggleFavorite(favorites, platform, model.key);
    setFavorites(next);
    toast.success(isFavorite(next, platform, model.key) ? `已加入我的模型（${PLATFORM_META[platform].label}）` : `已取消喜爱 ${model.name}`);
  };

  const handleUnhide = (key: string) => {
    setHiddenKeys(unhideModelKey(key));
    toast.success(`已恢复 ${key}`);
  };

  const refreshOne = async (platform: PlatformKey) => {
    setRefreshing((prev) => ({ ...prev, [platform]: true }));
    try {
      const keys = loadApiKeys();
      let items: LiveItem[];
      try {
        items = await fetchLiveDirect(platform, keys[platform]);
      } catch {
        items = await fetchLiveViaServer(platform);
      }
      setLive((prev) => ({ ...prev, [platform]: items }));
      setLiveAt((prev) => ({ ...prev, [platform]: new Date().toLocaleString("zh-CN", { hour12: false }) }));
      const local = localNorms(allModels, platform);
      const added = items.filter((item) => !local.has(norm(item.id)) && !local.has(norm(bare(item.id))));
      const locals = visibleModels.filter((model) => model.platforms[platform]);
      const liveNorms = new Set(items.flatMap((item) => [norm(item.id), norm(bare(item.id))]));
      const removed = locals
        .filter((model) => {
          const record = model.platforms[platform];
          const ids = [model.key, record?.id ?? "", record?.id ? bare(record.id) : ""].filter(Boolean);
          return !ids.some((id) => liveNorms.has(norm(id)));
        })
        .map((model) => ({ key: model.key, name: model.name, id: model.platforms[platform]?.id ?? model.key }));
      setReport({ platform, added, removed, total: items.length, tab: added.length > 0 ? "added" : "removed" });
      toast.success(`${PLATFORM_META[platform].label} 已拉取 ${items.length} 个：新增 ${added.length}，移除 ${removed.length}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "拉取失败");
    } finally {
      setRefreshing((prev) => ({ ...prev, [platform]: false }));
    }
  };

  const [syncingPrices, setSyncingPrices] = useState<Record<PlatformKey, boolean>>({ opencode: false, cmdc: false });

  const syncPrices = async (platform: PlatformKey) => {
    if (platform !== "cmdc") {
      toast.info("当前 OpenCode 官方暂无公开流式价格接口，可通过改价或对比更新");
      return;
    }
    setSyncingPrices((prev) => ({ ...prev, [platform]: true }));
    try {
      const resp = await fetch("/api/maintenance/doc-models?platform=cmdc", { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) throw new Error(`获取官方价格失败 (${resp.status})`);
      const body = (await resp.json()) as { models?: Array<Record<string, any>> };
      const docModels = body.models ?? [];
      if (docModels.length === 0) throw new Error("未获取到官方模型数据");

      const applyResp = await fetch("/api/maintenance/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: docModels }),
        signal: AbortSignal.timeout(45000),
      });
      const applyBody = (await applyResp.json()) as { ok?: boolean; error?: string; actions?: string[] };
      if (!applyResp.ok || !applyBody.ok) throw new Error(applyBody.error ?? `更新失败: ${applyResp.status}`);

      await reloadLocal(true);
      toast.success(`已全量同步 ${docModels.length} 个模型的官方最新价格、阶梯分档与上下文限制！`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "价格同步失败");
    } finally {
      setSyncingPrices((prev) => ({ ...prev, [platform]: false }));
    }
  };

  // 新增改为后台队列：直接提取官方精准价格秒级入库
  const addOne = (platform: PlatformKey, item: NewModel) => {
    submitEnrich(platform, [item]);
  };

  const addAll = (platform: PlatformKey, items: NewModel[]) => {
    submitEnrich(platform, items);
  };

  const retryOne = (platform: PlatformKey, item: NewModel) => {
    retryEnrich(platform, item);
  };

  const removeOne = async (platform: PlatformKey, target: RemovedModel) => {
    const sure = window.confirm(`确认移除 ${target.name}（${target.id}）在 ${PLATFORM_META[platform].label} 的平台参数吗？若无其他平台将彻底删除该模型。`);
    if (!sure) return;
    setRemoving(target.key);
    try {
      const resp = await fetch("/api/maintenance/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: target.key, platform }),
        signal: AbortSignal.timeout(30000),
      });
      const body = (await resp.json()) as { ok?: boolean; error?: string; action?: string; deleted?: boolean; remaining?: string[] };
      if (!resp.ok || !body.ok) {
        if (resp.status === 404) {
          setReport((prev) => (prev && prev.platform === platform ? { ...prev, removed: prev.removed.filter((item) => item.key !== target.key) } : prev));
          await reloadLocal(true);
          toast.info(`「${target.name}」在配置中已不存在（数据可能已更新），列表已刷新`);
          return;
        }
        throw new Error(body.error ?? `移除失败 ${resp.status}`);
      }
      setReport((prev) => (prev && prev.platform === platform ? { ...prev, removed: prev.removed.filter((item) => item.key !== target.key) } : prev));
      await reloadLocal(true);
      toast.success(body.deleted ? `已彻底删除 ${target.key}（无剩余平台）` : `${body.action ?? "已移除平台参数"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "移除失败");
    } finally {
      setRemoving("");
    }
  };

  const handleDeleteModel = async (model: MergedModel, platform: PlatformKey) => {
    const platformRec = model.platforms[platform];
    const platformId = platformRec?.id ?? model.key;
    const isOnlyPlatform = Object.keys(model.platforms).length <= 1;
    const promptText = isOnlyPlatform
      ? `确认从 ${PLATFORM_META[platform].label} 移除模型「${model.name}」（${platformId}）吗？\n\n注意：该模型仅在此平台存在，移除后将彻底从目录中删除！`
      : `确认从 ${PLATFORM_META[platform].label} 移除模型「${model.name}」（${platformId}）吗？\n\n（该模型在其他平台的数据仍会保留）`;

    const sure = window.confirm(promptText);
    if (!sure) return;

    const opKey = `${model.key}-${platform}`;
    setRemoving(opKey);
    try {
      const resp = await fetch("/api/maintenance/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: model.key, platform }),
        signal: AbortSignal.timeout(30000),
      });
      const body = (await resp.json()) as { ok?: boolean; error?: string; action?: string; deleted?: boolean };
      if (!resp.ok || !body.ok) throw new Error(body.error ?? `删除失败: ${resp.status}`);

      await reloadLocal(true);
      toast.success(body.deleted ? `已从目录彻底删除 ${model.name}` : `已从 ${PLATFORM_META[platform].label} 移除 ${model.name}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setRemoving("");
    }
  };

  return (
    <div className="catalog-app maint-app">
      <header className="topbar">
        <Link className="brand-lockup" href="/" aria-label="返回 Model Catalog 首页">
          <img src="/model-catalog-mark.svg" alt="" className="brand-mark" />
          <span className="brand-wordmark"><strong>MODEL</strong><span>CATALOG</span></span>
        </Link>
        <nav className="topnav"><Link href="/">模型目录</Link><Link href="/favorites">我的模型</Link><Link href="/compare">性价比对比</Link><Link className="is-active" href="/maintenance">模型维护</Link></nav>
        <div className="topbar-actions">
          <button className="topbar-icon-link" type="button" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />API Key 设置</button>
        </div>
      </header>

      <main className="maint-main">
        <section className="maint-head">
          <div>
            <p className="eyebrow eyebrow--orange">MAINTENANCE / 03</p>
            <h1>双平台模型维护</h1>
            <p className="maint-desc">默认显示 CommandCode，可切换 OpenCode 或双平台对照。每行显示模型名、平台侧模型 ID 与价格；隐藏后，首页与对比页不再显示。</p>
            {queuePending > 0 && (
              <span className="maint-queue-pill" role="status">
                <Loader2 size={13} className="spin" />
                后台新增中：运行 {queue.running} · 排队 {queue.pending}
              </span>
            )}
            {queue.failed > 0 && queuePending === 0 && (
              <span className="maint-queue-pill maint-queue-pill--error" role="status">
                <RotateCw size={13} />
                {queue.failed} 条新增失败，可在更新报告里重试
              </span>
            )}
          </div>
          <div className="maint-head-actions">
            <div className="maint-search">
              <Search size={14} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索模型名 / ID / 厂商"
                aria-label="搜索模型"
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="maint-platform-switch" role="group" aria-label="平台切换">
              {(["cmdc", "opencode", "all"] as const).map((p) => (
                <button
                  key={p}
                  className={platformFilter === p ? "maint-switch-btn is-active" : "maint-switch-btn"}
                  type="button"
                  aria-pressed={platformFilter === p}
                  onClick={() => setPlatformFilter(p)}
                >
                  {p === "all" ? "双平台" : PLATFORM_META[p].label}
                </button>
              ))}
            </div>
            <button className={showHidden ? "primary-button" : "outline-button"} type="button" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? <Eye size={15} /> : <EyeOff size={15} />} {showHidden ? "查看正常列表" : `查看已隐藏（${hiddenModels.length}）`}
            </button>
          </div>
        </section>

        <section className={shownPlatforms.length === 2 ? "maint-columns" : "maint-columns maint-columns--single"}>
          {shownPlatforms.map((platform) => (
            <div className={`maint-column maint-column--${platform}`} key={platform}>
              <div className="maint-column-head">
                <div className="maint-column-title">
                  <span className={`maint-platform-badge maint-platform-badge--${platform}`}>{PLATFORM_META[platform].label}</span>
                  <div>
                    <h2>{platform === "opencode" ? ocModels.length : ccModels.length} 个模型</h2>
                    {liveAt[platform] && <small>官方 /models 拉取于 {liveAt[platform]}，共 {live[platform].length} 个</small>}
                  </div>
                </div>
                <div className="maint-column-actions">
                  {platform === "cmdc" && (
                    <button
                      className="outline-button"
                      type="button"
                      title="从官方文档直接全量同步最新价格与分档"
                      onClick={() => syncPrices(platform)}
                      disabled={syncingPrices[platform]}
                    >
                      {syncingPrices[platform] ? <Loader2 size={14} className="spin" /> : <Tag size={14} />} 全量同步价格
                    </button>
                  )}
                  <button className="primary-button" type="button" onClick={() => refreshOne(platform)} disabled={refreshing[platform]}>
                    {refreshing[platform] ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />} 更新模型
                  </button>
                </div>
              </div>
              <ColumnList
                title={platform}
                short={PLATFORM_META[platform].short}
                models={platform === "opencode" ? ocModels : ccModels}
                hiddenView={showHidden}
                favorites={favorites}
                removingKey={removing}
                onHide={handleHide}
                onUnhide={handleUnhide}
                onTest={openTest}
                onToggleFavorite={handleToggleFavorite}
                onEditPricing={openPricing}
                onDelete={handleDeleteModel}
              />
            </div>
          ))}
        </section>

        {applied.length > 0 && (
          <section className="maint-applied">
            <p className="eyebrow eyebrow--orange">APPLIED / 已写入</p>
            <h2>本次已插入 {applied.length} 个模型</h2>
            <div className="maint-list">
              {applied.map((model) => (
                <div className="maint-row" key={model.key}>
                  <div className="maint-identity"><strong>{model.name}</strong><code>{model.key}</code></div>
                  <span className="maint-platforms">{model.coverage.platforms.join(" + ")}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer className="catalog-footer">
        <div><img src="/model-catalog-mark.svg" alt="" className="footer-mark" /><span>Model Catalog / maintenance workbench</span></div>
        <span>更新先经官方 /models 对比；新增参数由 deepseek-v4.1-flash 提取并写入</span>
      </footer>
      <ApiKeyDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <TestDialog model={testModel} initialPlatform={testPlatform} onClose={closeTest} onOpenSettings={() => setSettingsOpen(true)} />
      {priceEdit && (
        <PricingDialog
          model={priceEdit.model}
          platform={priceEdit.platform}
          onClose={() => setPriceEdit(null)}
          onSaved={async () => {
            await reloadLocal(true);
          }}
        />
      )}

      {report && (
        <div className="maint-report-mask" role="dialog" aria-modal="true" aria-label="更新对比结果">
          <div className="maint-report">
            <div className="maint-report-head">
              <div>
                <p className="eyebrow eyebrow--orange">{PLATFORM_META[report.platform].label} / 更新报告</p>
                <h2>成功拉取 {report.total} 个模型</h2>
              </div>
              <button className="maint-close" type="button" onClick={() => setReport(null)} aria-label="关闭更新报告">
                <X size={18} />
              </button>
            </div>
            <div className="maint-tabs" role="tablist" aria-label="新增与移除">
              <button
                className={report.tab === "added" ? "maint-tab is-active" : "maint-tab"}
                type="button"
                role="tab"
                aria-selected={report.tab === "added"}
                onClick={() => setReport({ ...report, tab: "added" })}
              >
                新增（{report.added.length}）
              </button>
              <button
                className={report.tab === "removed" ? "maint-tab is-active" : "maint-tab"}
                type="button"
                role="tab"
                aria-selected={report.tab === "removed"}
                onClick={() => setReport({ ...report, tab: "removed" })}
              >
                移除（{report.removed.length}）
              </button>
            </div>
            {report.tab === "added" ? (
              <div>
                {report.added.length === 0 ? (
                  <div className="maint-empty">无新增模型，可切换到移除 Tab 或直接关闭。</div>
                ) : (
                  <>
                    <div className="maint-report-actions">
                      <button className="maint-add" type="button" onClick={() => addAll(report.platform, report.added)}>
                        <Plus size={14} />
                        全部新增（{report.added.length}）
                      </button>
                      <span className="maint-queue-note">后台平稳处理中，可关闭本窗口继续</span>
                    </div>
                    <div className="maint-report-list">
                      {report.added.map((item) => {
                        const state = queueItemFor(report.platform, item.id);
                        return (
                          <div className="maint-report-row" key={item.id}>
                            <div className="maint-identity"><strong>{item.name ?? item.id}</strong><code>{item.id}</code></div>
                            {state ? (
                              <span className={`maint-job maint-job--${state.status}`}>
                                {state.status === "running" && <><Loader2 size={14} className="spin" />提取中…</>}
                                {state.status === "pending" && <>排队中</>}
                                {state.status === "failed" && (
                                  <button className="maint-retry" type="button" title={state.error} onClick={() => retryOne(report.platform, item)}>
                                    <RotateCw size={13} />重试
                                  </button>
                                )}
                              </span>
                            ) : (
                              <button className="maint-add" type="button" onClick={() => addOne(report.platform, item)}>
                                <Plus size={14} />
                                新增
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
                <p className="maint-hint">新增通过 deepseek-v4.1-flash 提取参数或自动初始化基础模型写入对应平台，支持写入后即刻改价。任务在后台队列运行，可随时关闭窗口。</p>
              </div>
            ) : (
              <div>
                {report.removed.length === 0 ? (
                  <div className="maint-empty">无移除模型，可切换到新增 Tab 或直接关闭。</div>
                ) : (
                  <div className="maint-report-list">
                    {report.removed.map((item) => (
                      <div className="maint-report-row" key={item.key}>
                        <div className="maint-identity"><strong>{item.name}</strong><code>{item.id}</code></div>
                        <button
                          className="maint-remove"
                          type="button"
                          disabled={removing === item.key}
                          onClick={() => removeOne(report.platform, item)}
                        >
                          {removing === item.key ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                          移除模型
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <p className="maint-hint">移除即从 models.merged.json 删除该平台参数；无剩余平台则彻底删除整条模型，写前自动备份。</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
