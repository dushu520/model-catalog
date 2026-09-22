/* Editorial Atlas reminder: the page is a dark archive desk with a paper-like result stream, asymmetric index rail, and orange signal marks. */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownAZ,
  ArrowUpRight,
  Check,
  Settings2,
  ChevronDown,
  Download,
  Filter,
  Layers3,
  ListFilter,
  Search,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import ApiKeyDialog from "@/components/ApiKeyDialog";
import ModelDrawer from "@/components/ModelDrawer";
import TestDialog from "@/components/TestDialog";
import rawData from "@/data/models.merged.json";
import { loadHiddenKeys } from "@/lib/hidden-models";
import {
  CatalogData,
  displayProtocol,
  formatPrice,
  formatTokens,
  getDefaultContext,
  getDefaultUpdatedAt,
  MergedModel,
  modalityLabels,
  PlatformKey,
  PLATFORM_KEYS,
  PLATFORM_META,
} from "@/lib/model-catalog";

const catalog = rawData as CatalogData;
const allCatalogModels = Object.values(catalog.models);
const spotlightModel = catalog.models["deepseek-v4-flash"];
const categories = ["全部类型", "premium", "opensource"] as const;

type CategoryFilter = (typeof categories)[number];
type PlatformFilter = "all" | PlatformKey | "both";
type SortOption = "recommended" | "name" | "context" | "updated";

function categoryLabel(category: string) {
  return category === "opensource" ? "开源" : category === "premium" ? "商业" : category;
}

function formatCount(value: number) {
  return value.toLocaleString("zh-CN");
}

function ModelAvatar({ model }: { model: MergedModel }) {
  const first = model.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  return <div className={`model-avatar model-avatar--${model.category}`}>{first || "AI"}</div>;
}

function PlatformDots({ model }: { model: MergedModel }) {
  return (
    <div className="platform-dots" aria-label={`覆盖平台：${model.coverage.platforms.map((platform) => PLATFORM_META[platform].label).join("、")}`}>
      {PLATFORM_KEYS.map((platform) => <span key={platform} className={`platform-dot platform-dot--${platform} ${model.platforms[platform] ? "is-active" : ""}`} title={PLATFORM_META[platform].label}>{PLATFORM_META[platform].short}</span>)}
    </div>
  );
}

function ModelRow({ model, index, onSelect, onTest }: { model: MergedModel; index: number; onSelect: (model: MergedModel) => void; onTest: (model: MergedModel) => void }) {
  const primary = model.platforms.opencode ?? model.platforms.cmdc;
  return (
    <div className="model-row" role="button" tabIndex={0} onClick={() => onSelect(model)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(model); } }} style={{ "--row-delay": `${Math.min(index * 28, 260)}ms` } as React.CSSProperties}>
      <div className="row-index">{String(index + 1).padStart(2, "0")}</div>
      <ModelAvatar model={model} />
      <div className="row-identity">
        <div className="row-title"><strong>{model.name}</strong>{model.coverage.count === 2 && <span className="merge-badge"><Check size={11} />已合并</span>}</div>
        <div className="row-subtitle"><code>{model.key}</code><span>·</span><span>{model.provider}</span></div>
      </div>
      <div className="row-fact row-fact--context"><span>上下文</span><strong>{formatTokens(getDefaultContext(model))}</strong></div>
      <div className="row-fact row-fact--protocol"><span>协议</span><strong>{model.capabilities.protocols.map(displayProtocol).join(" · ") || "—"}</strong></div>
      <div className="row-platforms"><PlatformDots model={model} /><button className="row-test" type="button" onClick={(event) => { event.stopPropagation(); onTest(model); }}>测试</button><span className="row-arrow"><ArrowUpRight size={17} /></span></div>
      <div className="row-mobile-meta"><span>{formatTokens(getDefaultContext(model))} context</span><span>{primary?.pricing ? `${formatPrice(primary.pricing.input)} / 1M` : "价格未公开"}</span></div>
    </div>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [platform, setPlatform] = useState<PlatformFilter>("all");
  const [category, setCategory] = useState<CategoryFilter>("全部类型");
  const [modality, setModality] = useState("all");
  const [reasoningOnly, setReasoningOnly] = useState(false);
  const [sort, setSort] = useState<SortOption>("recommended");
  const [selectedModel, setSelectedModel] = useState<MergedModel | null>(null);
  const [testModel, setTestModel] = useState<MergedModel | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [visibleCount, setVisibleCount] = useState(10);
  const [hiddenVersion, setHiddenVersion] = useState(0);
  const models = useMemo(() => {
    void hiddenVersion;
    const hidden = new Set(loadHiddenKeys());
    return allCatalogModels.filter((model) => !hidden.has(model.key));
  }, [hiddenVersion]);

  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const result = models.filter((model) => {
      const searchable = [model.key, model.name, model.provider, ...(model.coverage.platforms.map((item) => PLATFORM_META[item].label)), ...Object.values(model.platforms).flatMap((record) => record?.id ?? "")].join(" ").toLowerCase();
      const matchesQuery = !normalizedQuery || searchable.includes(normalizedQuery);
      const matchesPlatform = platform === "all" || (platform === "both" ? model.coverage.count === 2 : Boolean(model.platforms[platform]));
      const matchesCategory = category === "全部类型" || model.category === category;
      const matchesModality = modality === "all" || model.capabilities.multimodal.includes(modality);
      const matchesReasoning = !reasoningOnly || model.reasoning;
      return matchesQuery && matchesPlatform && matchesCategory && matchesModality && matchesReasoning;
    });

    return [...result].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "context") return (getDefaultContext(b) ?? 0) - (getDefaultContext(a) ?? 0);
      if (sort === "updated") return (getDefaultUpdatedAt(b) ?? "").localeCompare(getDefaultUpdatedAt(a) ?? "");
      return Number(b.coverage.count === 2) - Number(a.coverage.count === 2) || a.name.localeCompare(b.name);
    });
  }, [category, modality, models, platform, query, reasoningOnly, sort]);

  const clearFilters = () => {
    setQuery("");
    setPlatform("all");
    setCategory("全部类型");
    setModality("all");
    setReasoningOnly(false);
    setSort("recommended");
  };

  // 筛选/排序条件变化时，列表回到"只看前 10 条"的默认态
  useEffect(() => {
    setVisibleCount(10);
  }, [category, modality, models, platform, query, reasoningOnly, sort]);

  useEffect(() => {
    const onFocus = () => setHiddenVersion((v) => v + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const exportData = () => {
    const blob = new Blob([JSON.stringify(catalog, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "models.merged.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const copyKey = async () => {
    await navigator.clipboard?.writeText("deepseek-v4-flash");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="catalog-app">
      <header className="topbar">
        <a className="brand-lockup" href="/" aria-label="Model Catalog 首页">
          <img src="/model-catalog-mark.svg" alt="" className="brand-mark" />
          <span className="brand-wordmark"><strong>MODEL</strong><span>CATALOG</span></span>
        </a>
        <div className="topbar-context"><span className="live-dot" />数据快照 / 2026.09.02</div>
        <div className="topbar-actions">
          <a href={catalog.meta.platforms.opencode.site} target="_blank" rel="noreferrer">OpenCode 文档 <ArrowUpRight size={13} /></a>
          <a className="compare-link" href="/favorites">我的模型 <ArrowUpRight size={13} /></a>
          <a className="compare-link" href="/compare">性价比对比 <ArrowUpRight size={13} /></a>
          <a className="compare-link" href="/maintenance">模型维护 <ArrowUpRight size={13} /></a>
          <button className="topbar-icon-link" type="button" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />API Key 设置</button>
          <button className="outline-button" type="button" onClick={exportData}><Download size={15} />导出聚合 JSON</button>
        </div>
      </header>

      <main>
        <section className="hero-panel">
          <div className="hero-image" aria-hidden="true" />
          <div className="hero-gridline" aria-hidden="true" />
          <div className="hero-copy">
            <p className="eyebrow eyebrow--light"><span>01</span> MODEL DIRECTORY / CROSS-PLATFORM INDEX</p>
            <h1>把模型资料，<em>整理成一张可核对的图。</em></h1>
            <p className="hero-description">合并 OpenCode Go 与 CommandCode 的基础数据。用一个模型身份，查看不同平台的 ID、协议、价格与额度差异。</p>
            <div className="hero-actions"><a className="primary-button" href="#directory">进入目录 <ArrowDownAZ size={16} /></a><button className="text-button text-button--light" type="button" onClick={copyKey}>{copied ? <Check size={15} /> : <Terminal size={15} />} 试试 deepseek-v4-flash</button></div>
          </div>
          <div className="hero-ledger">
            <div className="ledger-top"><span>CATALOG NOTE</span><span>v1.0.0</span></div>
            <div className="ledger-title">{formatCount(catalog.meta.aggregation.merged_models)}<small> 个模型身份</small></div>
            <div className="ledger-rule" />
            <div className="ledger-row"><span>原始平台记录</span><strong>{catalog.meta.aggregation.raw_records}</strong></div>
            <div className="ledger-row"><span>双平台交集</span><strong>{models.filter((model) => model.coverage.count === 2).length}</strong></div>
            <div className="ledger-row"><span>独立平台字段</span><strong>保留</strong></div>
          </div>
        </section>

        <section className="directory-layout" id="directory">
          <aside className="filter-rail">
            <div className="rail-heading"><div><p className="eyebrow">INDEX / FILTER</p><h2>筛选目录</h2></div><SlidersHorizontal size={18} /></div>
            <div className="filter-group">
              <label className="filter-label">来源平台</label>
              <div className="segmented-control segmented-control--stacked">
                <button type="button" className={platform === "all" ? "is-selected" : ""} onClick={() => setPlatform("all")}><span>全部记录</span><b>{formatCount(models.length)}</b></button>
                <button type="button" className={platform === "both" ? "is-selected" : ""} onClick={() => setPlatform("both")}><span>两个平台都有</span><b>{models.filter((model) => model.coverage.count === 2).length}</b></button>
                <button type="button" className={platform === "opencode" ? "is-selected" : ""} onClick={() => setPlatform("opencode")}><span><i className="mini-dot mini-dot--orange" />OpenCode Go</span><b>{catalog.meta.platforms.opencode.model_count}</b></button>
                <button type="button" className={platform === "cmdc" ? "is-selected" : ""} onClick={() => setPlatform("cmdc")}><span><i className="mini-dot mini-dot--mint" />CommandCode</span><b>{catalog.meta.platforms.cmdc.model_count}</b></button>
              </div>
            </div>
            <div className="filter-group">
              <label className="filter-label">模型类型</label>
              <div className="filter-pills">{categories.map((item) => <button type="button" key={item} className={category === item ? "is-selected" : ""} onClick={() => setCategory(item)}>{item === "全部类型" ? item : categoryLabel(item)}</button>)}</div>
            </div>
            <div className="filter-group">
              <label className="filter-label">输入能力</label>
              <div className="select-wrap"><select value={modality} onChange={(event) => setModality(event.target.value)}><option value="all">全部模态</option>{Object.entries(modalityLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><ChevronDown size={15} /></div>
            </div>
            <div className="filter-group filter-group--last"><label className="switch-row"><span><Sparkles size={16} />仅显示推理模型</span><input type="checkbox" checked={reasoningOnly} onChange={(event) => setReasoningOnly(event.target.checked)} /><i /></label></div>
            <div className="rail-note"><span className="note-mark">i</span><p>匹配规则：先按平台模型 ID 归一化，再对供应商前缀做显式别名处理。平台原始字段不会被覆盖。</p></div>
          </aside>

          <div className="results-column">
            <div className="results-toolbar">
              <div className="results-heading"><div className="heading-mark"><ListFilter size={16} /></div><div><p className="eyebrow">MODEL RECORDS</p><h2>模型列表 <span>{filteredModels.length}</span></h2></div></div>
              <div className="results-controls"><div className="search-field"><Search size={17} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、ID 或供应商" aria-label="搜索名称、ID 或供应商" />{query && <button type="button" onClick={() => setQuery("")} aria-label="清除搜索"><X size={15} /></button>}</div><div className="select-wrap select-wrap--sort"><ArrowDownAZ size={15} /><select value={sort} onChange={(event) => setSort(event.target.value as SortOption)} aria-label="排序方式"><option value="recommended">推荐排序</option><option value="name">按名称</option><option value="context">按上下文</option><option value="updated">按更新时间</option></select><ChevronDown size={14} /></div></div>
            </div>
            <div className="active-filters">{(platform !== "all" || category !== "全部类型" || modality !== "all" || reasoningOnly || query) && <><span>当前条件</span>{query && <button type="button" onClick={() => setQuery("")}>“{query}” <X size={12} /></button>}{platform !== "all" && <button type="button" onClick={() => setPlatform("all")}>{platform === "both" ? "双平台" : PLATFORM_META[platform].label} <X size={12} /></button>}{category !== "全部类型" && <button type="button" onClick={() => setCategory("全部类型")}>{categoryLabel(category)} <X size={12} /></button>}{modality !== "all" && <button type="button" onClick={() => setModality("all")}>{modalityLabels[modality]} <X size={12} /></button>}{reasoningOnly && <button type="button" onClick={() => setReasoningOnly(false)}>推理模型 <X size={12} /></button>}<button type="button" className="clear-filters" onClick={clearFilters}>清空</button></>}</div>
            <div className="model-table-head"><span>序号 / 模型身份</span><span>上下文</span><span>协议</span><span>平台</span></div>
            <div className="model-list">{filteredModels.slice(0, visibleCount).map((model, index) => <ModelRow key={model.key} model={model} index={index} onSelect={setSelectedModel} onTest={setTestModel} />)}</div>
            {filteredModels.length > visibleCount && <div className="show-more-row"><button type="button" className="show-more-button" onClick={() => setVisibleCount(filteredModels.length)}>查看全部 {filteredModels.length} 个模型 <ChevronDown size={14} /></button></div>}
            {visibleCount > 10 && filteredModels.length > 10 && <div className="show-more-row show-more-row--collapse"><button type="button" className="show-more-button" onClick={() => setVisibleCount(10)}>收起 <ChevronDown size={14} className="collapse-caret" /><span>回到前 10 条</span></button></div>}
            {filteredModels.length === 0 && <div className="empty-state"><div className="empty-icon"><Filter size={20} /></div><h3>没有匹配的模型记录</h3><p>换一个名称、平台或能力条件试试。</p><button type="button" className="outline-button" onClick={clearFilters}>清空筛选</button></div>}
            <div className="results-footnote"><span>显示 {Math.min(visibleCount, filteredModels.length)} / {models.length} 个模型身份</span><span>点击任意一行打开详情</span></div>
          </div>

          <aside className="peek-sheet" aria-label="固定模型预览">
            <div className="peek-tab">PINNED / SAMPLE RECORD</div>
            <div className="peek-sheet-top"><span>档案预览</span><Layers3 size={16} /></div>
            <div className="peek-model-title"><ModelAvatar model={spotlightModel} /><div><p className="eyebrow">共同模型身份</p><h3>{spotlightModel.name}</h3><code>{spotlightModel.key}</code></div></div>
            <div className="peek-divider" />
            <div className="peek-id"><span>CommandCode ID</span><code>{spotlightModel.platforms.cmdc?.id ?? "未收录"}</code></div>
            <div className="peek-stat"><span>平台覆盖</span><strong>{spotlightModel.coverage.platforms.map((item) => PLATFORM_META[item].short).join(" + ")}</strong></div>
            <div className="peek-stat"><span>上下文 / 输出</span><strong>{formatTokens(spotlightModel.context_size)} / {formatTokens(spotlightModel.max_output)}</strong></div>
            <div className="peek-stat"><span>协议</span><strong>{spotlightModel.capabilities.protocols.map(displayProtocol).join(" · ")}</strong></div>
            <div className="peek-source"><span className="mini-dot mini-dot--orange" />保留 2 份平台原始记录</div>
            <button className="peek-open" type="button" onClick={() => setSelectedModel(spotlightModel)}>打开完整档案 <ArrowUpRight size={15} /></button>
          </aside>
        </section>

        <section className="merge-preview-section">
          <div className="merge-preview-copy"><p className="eyebrow eyebrow--orange">MERGE PREVIEW / 02</p><h2>共同的身份在上层，差异留在平台下面。</h2><p>这是合并数据集的核心结构：共享的名称、供应商与能力放在模型根部，OpenCode 与 CommandCode 的 ID、协议、价格、额度和来源保持独立。</p><button className="outline-button outline-button--dark" type="button" onClick={() => setSelectedModel(catalog.models["deepseek-v4-flash"])}>查看 deepseek-v4-flash <ArrowUpRight size={15} /></button></div>
          <div className="json-preview"><div className="json-topbar"><span><i /> merged record</span><button type="button" onClick={copyKey}>{copied ? <Check size={14} /> : <Terminal size={14} />} 复制 key</button></div><pre><span className="json-punctuation">{`{`}</span>{"\n  "}<span className="json-key">"deepseek-v4-flash"</span><span className="json-punctuation">: {`{`}</span>{"\n    "}<span className="json-key">"provider"</span><span className="json-punctuation">: </span><span className="json-string">"DeepSeek"</span><span className="json-punctuation">,</span>{"\n    "}<span className="json-key">"coverage"</span><span className="json-punctuation">: [</span><span className="json-string">"opencode"</span><span className="json-punctuation">, </span><span className="json-string">"cmdc"</span><span className="json-punctuation">],</span>{"\n    "}<span className="json-key">"platforms"</span><span className="json-punctuation">: {`{`}</span>{"\n      "}<span className="json-key">"opencode"</span><span className="json-punctuation">: {`{ ... }`},</span>{"\n      "}<span className="json-key">"cmdc"</span><span className="json-punctuation">: {`{ ... }`}</span>{"\n    "}<span className="json-punctuation">{`}`}</span>{"\n  "}<span className="json-punctuation">{`}`}</span>{"\n"}<span className="json-punctuation">{`}`}</span></pre></div>
        </section>
      </main>

      <section className="api-note">
        <details>
          <summary><span className="api-note-mark">i</span>API 说明 <span className="api-note-hint">本目录自带的 HTTP 接口，供脚本 / 工具调用</span><ChevronDown size={14} className="api-note-caret" /></summary>
          <div className="api-note-body">
            <p>目录服务运行在 <code>http://localhost:3006</code>，返回聚合后的模型数据。只读接口：</p>
            <div className="api-endpoint"><code>GET /api/models/list</code><span>每平台模型清单：{`{ "opencode": [{id,name},...], "cmdc": [...] }`}（id 为平台真实调用 ID）</span></div>
            <div className="api-endpoint"><code>GET /api/models?platform=oc&amp;model=deepseek</code><span>按平台 / 名称过滤模型记录；platform 支持 oc / opencode / cc / cmdc / cc-goat，model 匹配 key 或名称</span></div>
            <div className="api-endpoint"><code>GET /api/models/favorite?platform=cc-goat</code><span>收藏模型（dsh 等 agent 配置用）：只输出后端持久化的收藏，字段为 id / name / contextWindow / maxTokens / input（输入模态）/ reasoningEfforts（off 恒 null，其余仅输出支持档）；cmdc 对外显示为 cc-goat</span></div>
            <pre className="api-example">{`curl "http://localhost:3006/api/models/list"
curl "http://localhost:3006/api/models?platform=cmdc&model=gemini"
curl "http://localhost:3006/api/models/favorite?platform=cc-goat"`}</pre>
          </div>
        </details>
      </section>

      <footer className="catalog-footer"><div><img src="/model-catalog-mark.svg" alt="" className="footer-mark" /><span>Model Catalog / cross-platform model index</span></div><span>数据快照：{catalog.meta.generated_at} · 原始来源由平台字段保留</span></footer>
      <ModelDrawer model={selectedModel} onClose={() => setSelectedModel(null)} />
      <TestDialog model={testModel} onClose={() => setTestModel(null)} onOpenSettings={() => { setTestModel(null); setSettingsOpen(true); }} />
      <ApiKeyDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
