/* Compare: side-by-side rate card for models listed on both platforms. */

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowUpRight, BarChart3, Settings2, SlidersHorizontal } from "lucide-react";
import { Link } from "wouter";
import ApiKeyDialog from "@/components/ApiKeyDialog";
import ModelDrawer from "@/components/ModelDrawer";
import TestDialog from "@/components/TestDialog";
import rawData from "@/data/models.merged.json";
import { loadHiddenKeys } from "@/lib/hidden-models";
import { CatalogData, formatPrice, formatTokens, MergedModel, PlatformKey } from "@/lib/model-catalog";

const catalog = rawData as CatalogData;
const allSharedModels = Object.values(catalog.models).filter((model) => model.coverage.count === 2);

function monthlyAllowance(model: MergedModel, platform: PlatformKey) {
  const value = model.platforms[platform]?.allowance?.monthly_usd;
  return typeof value === "number" ? value : null;
}

function coefficient(model: MergedModel, platform: PlatformKey) {
  const allowance = monthlyAllowance(model, platform);
  return allowance === null ? null : allowance / 10;
}

function ratio(model: MergedModel) {
  const oc = coefficient(model, "opencode");
  const cc = coefficient(model, "cmdc");
  return oc !== null && cc !== null && oc !== 0 ? cc / oc : null;
}

type PriceQuote = { name: string | null; input?: number | null; output?: number | null; cacheRead?: number | null };

function cleanTierName(raw: Record<string, unknown>): string | null {
  // 阈值原文在 context（如 ≤ 272K），优先展示；Standard/Default/Base 这类通用名视为无档名
  const label = [raw.context, raw.label, raw.name].find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim();
  if (!label || /^(standard|default|base)$/i.test(label)) return null;
  return label.replace(/<=/g, "≤").replace(/>=/g, "≥").replace(/([<>≤≥])\s+/g, "$1");
}

function collectCompareQuotes(pricing: {
  input?: unknown; output?: unknown; cache_read?: unknown; time_of_day?: unknown; tiers?: unknown;
} | undefined): PriceQuote[] {
  if (!pricing) return [];
  const quotes: PriceQuote[] = [];
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
      quotes.push({ name: "Off-Peak", input: num(tod.offPeak, "inputCost", "input"), output: num(tod.offPeak, "outputCost", "output"), cacheRead: num(tod.offPeak, "cacheReadCost", "cache_read") });
    }
    if (tod.peak) {
      quotes.push({ name: "Peak", input: num(tod.peak, "inputCost", "input"), output: num(tod.peak, "outputCost", "output"), cacheRead: num(tod.peak, "cacheReadCost", "cache_read") });
    }
  }
  if (Array.isArray(pricing.tiers)) {
    for (const raw of pricing.tiers as Array<Record<string, unknown>>) {
      const tier = (raw ?? {}) as Record<string, unknown>;
      const quote: PriceQuote = {
        name: cleanTierName(tier),
        input: typeof tier.input === "number" ? tier.input : null,
        output: typeof tier.output === "number" ? tier.output : null,
        cacheRead: typeof tier.cache_read === "number" ? tier.cache_read : null,
      };
      // 无名 tiers 若与已收录任一条价格完全相同，视为同一档，不重复收录
      if (!quote.name) {
        const sig = [quote.input, quote.output, quote.cacheRead].join("|");
        if (quotes.some((q) => [q.input, q.output, q.cacheRead].join("|") === sig)) continue;
      }
      quotes.push(quote);
    }
  }
  // 去重：同一档名 + 同一组价格只保留一条
  const seen = new Set<string>();
  const deduped = quotes.filter((quote) => {
    const key = [quote.name, quote.input, quote.output, quote.cacheRead].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (deduped.length > 0) return deduped;
  // 单一报价：直接价，无档名
  const single: PriceQuote = {
    name: null,
    input: typeof pricing.input === "number" ? pricing.input : null,
    output: typeof pricing.output === "number" ? pricing.output : null,
    cacheRead: typeof pricing.cache_read === "number" ? pricing.cache_read : null,
  };
  if (single.input === null && single.output === null && single.cacheRead === null) return [];
  return [single];
}

// 价格单元格：每模型永远只占一行；单档沿用原格式，多档只在格内加行、档名写最前
function priceCell(model: MergedModel, key: "input" | "output" | "cache_read") {
  const pick = (quote: PriceQuote): number | null | undefined =>
    key === "input" ? quote.input : key === "output" ? quote.output : quote.cacheRead;
  const ocQuotes = collectCompareQuotes(model.platforms.opencode?.pricing);
  const ccQuotes = collectCompareQuotes(model.platforms.cmdc?.pricing);
  if (ocQuotes.length === 0 && ccQuotes.length === 0) {
    return <span className="price-merged">—</span>;
  }
  // 只按当前列比较：档名 + 本列价格一致才合并，避免其他列差异导致重复行
  const sig = (quotes: PriceQuote[]) => quotes.map((q) => [q.name, pick(q)].join("|")).join(";");
  // 两边一致→单值；多档→只在格内按档加行。同一横行即同一档，档名只在输入列标一次，其余列裸价
  if (sig(ocQuotes) === sig(ccQuotes)) {
    const showName = key === "input";
    const line = (quote: PriceQuote) =>
      showName && quote.name ? `${quote.name} ${formatPrice(pick(quote))}` : formatPrice(pick(quote));
    if (ocQuotes.length === 1) {
      return <span className="price-merged">{line(ocQuotes[0])}</span>;
    }
    return (
      <span className="price-split">
        {ocQuotes.map((quote, index) => (
          <span key={`${quote.name ?? "std"}-${index}`} className="price-merged">
            {line(quote)}
          </span>
        ))}
      </span>
    );
  }
  // 不一致→保持原先 OC / CC 上下两行，某边有多档只在该边格内加行
  const renderSide = (quotes: PriceQuote[], side: "oc" | "cc") => {
    const tag = side === "oc" ? "OC" : "CC";
    return quotes.map((quote, index) => (
      <span key={`${side}-${quote.name ?? "std"}-${index}`} className={`price-tag price-tag--${side}`}>
        {quote.name ? `${tag} ${quote.name} ${formatPrice(pick(quote))}` : `${tag} ${formatPrice(pick(quote))}`}
      </span>
    ));
  };
  return (
    <span className="price-split">
      {ocQuotes.length > 0 && renderSide(ocQuotes, "oc")}
      {ccQuotes.length > 0 && renderSide(ccQuotes, "cc")}
    </span>
  );
}

function money(value: number | null) {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function ratioLabel(value: number | null) {
  return value === null ? "—" : `${value.toFixed(2)}×`;
}

export default function Compare() {
  const [query, setQuery] = useState("");
  const [onlyAboveOne, setOnlyAboveOne] = useState(false);
  const [selectedModel, setSelectedModel] = useState<MergedModel | null>(null);
  const [testModel, setTestModel] = useState<MergedModel | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hiddenVersion, setHiddenVersion] = useState(0);
  const sharedModels = useMemo(() => {
    void hiddenVersion;
    const hidden = new Set(loadHiddenKeys());
    return allSharedModels.filter((model) => !hidden.has(model.key));
  }, [hiddenVersion]);

  useEffect(() => {
    const onFocus = () => setHiddenVersion((v) => v + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const rows = useMemo(() => sharedModels.filter((model) => {
    const terms = query.split(/[,，]/).map((term) => term.trim().toLowerCase()).filter(Boolean);
    const haystack = `${model.name} ${model.key} ${model.provider}`.toLowerCase();
    const matches = terms.length === 0 || terms.some((term) => haystack.includes(term));
    const value = ratio(model);
    return matches && (!onlyAboveOne || (value !== null && value >= 1));
  }).sort((a, b) => (ratio(b) ?? -1) - (ratio(a) ?? -1)), [onlyAboveOne, query, sharedModels]);

  return (
    <div className="catalog-app compare-app">
      <header className="topbar">
        <Link className="brand-lockup" href="/" aria-label="返回 Model Catalog 首页"><img src="/model-catalog-mark.svg" alt="" className="brand-mark" /><span className="brand-wordmark"><strong>MODEL</strong><span>CATALOG</span></span></Link>
        <nav className="topnav"><Link href="/">模型目录</Link><Link href="/favorites">我的模型</Link><Link className="is-active" href="/compare">性价比对比</Link><Link href="/maintenance">模型维护</Link></nav>
        <div className="topbar-actions"><button className="topbar-icon-link" type="button" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />API Key 设置</button></div>
      </header>
      <main className="compare-main">
        <div className="compare-intro"><Link className="back-link" href="/"><ArrowLeft size={15} />返回模型目录</Link><p className="eyebrow eyebrow--orange">02 / VALUE LEDGER</p><div className="compare-title-row"><div><h1>同一模型，<em>哪边更值。</em></h1><p>仅比较两个平台都收录的模型。价格系数 = 月额度 ÷ 10；价格比 = CC 价格系数 ÷ OC 价格系数，数值越大表示 CC 相对额度更高。</p></div><div className="compare-stat"><BarChart3 size={18} /><strong>{sharedModels.length}</strong><span>个双平台模型</span></div></div></div>
        <section className="formula-band"><div><span className="formula-label">01 / 月额度</span><strong>OC / CC</strong><small>平台记录中的月额度（USD）</small></div><div className="formula-symbol">÷ 10</div><div><span className="formula-label">02 / 价格系数</span><strong>月额度 ÷ 10</strong><small>统一为可比较的额度倍数</small></div><div className="formula-symbol">→</div><div><span className="formula-label">03 / 价格比</span><strong>CC 系数 ÷ OC 系数</strong><small>数值越大，CC 性价比越高</small></div></section>
        <section className="compare-section"><div className="compare-toolbar"><div className="compare-toolbar-title"><SlidersHorizontal size={16} /><span>共同模型 / 按价格比降序</span></div><div className="compare-controls"><label className="compare-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型，可用逗号分隔多关键词" /><span>⌕</span></label><label className="compare-toggle"><input type="checkbox" checked={onlyAboveOne} onChange={(event) => setOnlyAboveOne(event.target.checked)} /><i />仅看 CC ≥ OC</label></div></div><div className="compare-table-wrap"><table className="compare-table"><thead><tr><th rowSpan={2}>模型</th><th colSpan={3}>单价 / M token</th><th colSpan={2}>月额度 / USD</th><th colSpan={2}>价格系数</th><th rowSpan={2}>价格比</th><th rowSpan={2} aria-label="操作" /></tr><tr className="subhead"><th>输入 / M</th><th>输出 / M</th><th>缓存读 / M</th><th><span className="pf-dot pf-dot--oc" />OC</th><th><span className="pf-dot pf-dot--cc" />CC</th><th><span className="pf-dot pf-dot--oc" />OC</th><th><span className="pf-dot pf-dot--cc" />CC</th><th /><th /></tr></thead><tbody>{rows.map((model, index) => { const ocCoeff = coefficient(model, "opencode"); const ccCoeff = coefficient(model, "cmdc"); const modelRatio = ratio(model); return <tr key={model.key} className={modelRatio !== null && modelRatio >= 1 ? "is-positive" : ""} onClick={() => setSelectedModel(model)}><td><div className="compare-model-cell"><span className="compare-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{model.name}</strong><code>{model.key}</code><small>{model.provider} · {formatTokens(model.context_size)} context</small></div></div></td><td>{priceCell(model, "input")}</td><td>{priceCell(model, "output")}</td><td>{priceCell(model, "cache_read")}</td><td className="is-oc-col">{money(monthlyAllowance(model, "opencode"))}</td><td className="is-cc-col">{money(monthlyAllowance(model, "cmdc"))}</td><td className="is-oc-col">{ratioLabel(ocCoeff)}</td><td className="is-cc-col">{ratioLabel(ccCoeff)}</td><td><div className={`ratio-cell ${modelRatio !== null && modelRatio >= 1 ? "is-positive" : ""}`}><strong>{ratioLabel(modelRatio)}</strong><span>{ratioLabel(ccCoeff)} / {ratioLabel(ocCoeff)}</span></div></td><td><button className="table-test" type="button" onClick={(event) => { event.stopPropagation(); setTestModel(model); }}>测试 <ArrowUpRight size={13} /></button></td></tr>})}</tbody></table>{rows.length === 0 && <div className="compare-empty">没有符合条件的双平台模型。</div>}</div><div className="compare-foot"><span>显示 {rows.length} / {sharedModels.length} 个双平台模型</span><span>点击行查看完整平台详情</span></div></section>
      </main>
      <footer className="catalog-footer"><div><img src="/model-catalog-mark.svg" alt="" className="footer-mark" /><span>Model Catalog / value ledger</span></div><span>价格来自聚合数据的各平台价格字段</span></footer>
      <ModelDrawer model={selectedModel} onClose={() => setSelectedModel(null)} />
      <TestDialog model={testModel} onClose={() => setTestModel(null)} onOpenSettings={() => { setTestModel(null); setSettingsOpen(true); }} />
      <ApiKeyDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
