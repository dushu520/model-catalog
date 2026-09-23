/* Editorial Atlas reminder: testing is an inspectable action—protocol, platform ID, and request state are always visible beside the response. */

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, Play, Send, X } from "lucide-react";
import { loadApiKeys } from "@/components/ApiKeyDialog";
import { commandCodeModelUrl, displayProtocol, formatPrice, MergedModel, PlatformKey, PLATFORM_META, Pricing } from "@/lib/model-catalog";

type TestDialogProps = {
  model: MergedModel | null;
  initialPlatform?: PlatformKey | null;
  onClose: () => void;
  onOpenSettings: () => void;
};

type TestResult = { kind: "success" | "error"; text: string } | null;

function endpointFor(platform: PlatformKey, protocol: string) {
  if (platform === "opencode") return `https://opencode.ai/zen/go/v1/${protocol === "responses" ? "responses" : protocol === "messages" ? "messages" : "chat/completions"}`;
  return `https://api.commandcode.ai/provider/v1/${protocol === "messages" ? "messages" : "chat/completions"}`;
}

type PriceQuote = { name?: string | null; input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null; note?: string };

function quoteTierName(raw: Record<string, unknown>): string | null {
  // 阈值原文在 context（如 ≤ 272K），优先展示；label 多为 Standard/Long context 这类通用名
  const label = [raw.context, raw.label, raw.name].find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim();
  if (!label || /^(standard|default|base)$/i.test(label)) return null;
  return label.replace(/<=/g, "≤").replace(/>=/g, "≥").replace(/([<>])\s+/g, "$1");
}

function collectQuotes(pricing: Pricing | undefined): PriceQuote[] {
  if (!pricing) return [];
  const quotes: PriceQuote[] = [];
  const tod = pricing.time_of_day as
    | { windows?: unknown; offPeak?: Record<string, unknown>; peak?: Record<string, unknown> }
    | undefined;
  if (tod && (tod.offPeak || tod.peak)) {
    const peakHours = typeof (tod as Record<string, unknown>).peakHoursPerDay === "number" ? `${(tod as Record<string, unknown>).peakHoursPerDay}h/天` : "";
    const windows = typeof tod.windows === "string" ? tod.windows : "";
    const num = (row: Record<string, unknown> | undefined, ...keys: string[]): number | null => {
      for (const key of keys) {
        const value = row?.[key];
        if (typeof value === "number") return value;
      }
      return null;
    };
    if (tod.offPeak) {
      quotes.push({
        name: "Off-Peak",
        input: num(tod.offPeak, "inputCost", "input"),
        output: num(tod.offPeak, "outputCost", "output"),
        cacheRead: num(tod.offPeak, "cacheReadCost", "cache_read"),
        cacheWrite: num(tod.offPeak, "cacheWriteCost", "cache_write"),
        note: [windows && `窗口 ${windows}`, peakHours && `峰时 ${peakHours}`].filter(Boolean).join("；"),
      });
    }
    if (tod.peak) {
      quotes.push({
        name: "Peak",
        input: num(tod.peak, "inputCost", "input"),
        output: num(tod.peak, "outputCost", "output"),
        cacheRead: num(tod.peak, "cacheReadCost", "cache_read"),
        cacheWrite: num(tod.peak, "cacheWriteCost", "cache_write"),
        note: [windows && `窗口 ${windows}`, peakHours && `峰时 ${peakHours}`].filter(Boolean).join("；"),
      });
    }
  }
  if (Array.isArray(pricing.tiers)) {
    for (const raw of pricing.tiers) {
      const tier = (raw ?? {}) as Record<string, unknown>;
      const label = quoteTierName(tier);
      const num = (...keys: string[]): number | null => {
        for (const key of keys) {
          const value = tier[key];
          if (typeof value === "number") return value;
        }
        return null;
      };
      const quote: PriceQuote = {
        name: label,
        input: num("input"),
        output: num("output"),
        cacheRead: num("cache_read"),
        cacheWrite: num("cache_write"),
        note: [
          typeof tier.list_input === "number" ? `挂牌入 ${formatPrice(tier.list_input)}` : "",
          typeof tier.list_output === "number" ? `挂牌出 ${formatPrice(tier.list_output)}` : "",
        ].filter(Boolean).join("；"),
      };
      // 无名 tiers 若与已收录的 Off-Peak/Peak 任一条价格完全相同，视为同一档，不重复收录
      if (!label) {
        const sig = [quote.input, quote.output, quote.cacheRead, quote.cacheWrite].join("|");
        const dup = quotes.some(
          (q) => [q.input, q.output, q.cacheRead, q.cacheWrite].join("|") === sig,
        );
        if (dup) continue;
      }
      quotes.push(quote);
    }
  }
  // 去重：同一档名 + 同一组价格只保留一条
  const seen = new Set<string>();
  return quotes.filter((quote) => {
    const key = [quote.name, quote.input, quote.output, quote.cacheRead, quote.cacheWrite, quote.note ?? ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function singleQuote(pricing: Pricing): PriceQuote | null {
  const keys = ["input", "output", "cache_read", "cache_write"] as const;
  const values = keys.map((key) => pricing[key]);
  if (!values.some((value) => typeof value === "number")) return null;
  // 单一报价不带档名
  return {
    name: null,
    input: typeof pricing.input === "number" ? pricing.input : null,
    output: typeof pricing.output === "number" ? pricing.output : null,
    cacheRead: typeof pricing.cache_read === "number" ? pricing.cache_read : null,
    cacheWrite: typeof pricing.cache_write === "number" ? pricing.cache_write : null,
  };
}

function collectQuotesResolved(pricing: Pricing | undefined): PriceQuote[] {
  const quotes = collectQuotes(pricing);
  if (quotes.length > 0) return quotes;
  if (!pricing) return [];
  const single = singleQuote(pricing);
  return single ? [single] : [];
}

function readResponse(payload: unknown) {
  if (!payload || typeof payload !== "object") return JSON.stringify(payload, null, 2);
  const value = payload as Record<string, unknown>;
  const output = value.output ?? value.choices ?? value.content ?? value.message ?? value.data;
  if (typeof output === "string") return output;
  if (output) return JSON.stringify(output, null, 2);
  return JSON.stringify(payload, null, 2);
}

export default function TestDialog({ model, initialPlatform, onClose, onOpenSettings }: TestDialogProps) {
  const availablePlatforms = useMemo(() => (model ? (Object.keys(model.platforms) as PlatformKey[]) : []), [model]);
  const [platform, setPlatform] = useState<PlatformKey>("opencode");
  const [protocol, setProtocol] = useState("chat");
  const [prompt, setPrompt] = useState("用一句话说明你适合处理什么类型的编程任务。\n请保持简洁，不要调用工具。 ");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult>(null);

  useEffect(() => {
    if (!model) return;
    const nextPlatform =
      (initialPlatform && model.platforms[initialPlatform] ? initialPlatform : model.platforms.opencode ? "opencode" : "cmdc") as PlatformKey;
    setPlatform(nextPlatform);
    setProtocol(model.platforms[nextPlatform]?.protocols?.[0] ?? "chat");
    setResult(null);
  }, [initialPlatform, model]);

  useEffect(() => {
    const supported = model?.platforms[platform]?.protocols ?? [];
    if (supported.length && !supported.includes(protocol)) setProtocol(supported[0]);
  }, [model, platform, protocol]);

  const record = model?.platforms[platform];
  const protocols = record?.protocols ?? [];
  const keys = loadApiKeys();
  const quotes = useMemo(() => collectQuotesResolved(record?.pricing), [record]);

  if (!model) return null;

  const runTest = async () => {
    const key = keys[platform];
    if (!key) {
      setResult({ kind: "error", text: `尚未设置 ${PLATFORM_META[platform].label} API Key。请先打开设置。` });
      return;
    }
    if (!record) return;
    setRunning(true);
    setResult(null);
    const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
    if (platform === "cmdc" && protocol === "messages") headers["x-api-key"] = key;
    let body: Record<string, unknown>;
    if (protocol === "responses") body = { model: record.id, input: prompt };
    else if (protocol === "messages") body = { model: record.id, max_tokens: 1024, messages: [{ role: "user", content: prompt }] };
    else body = { model: record.id, messages: [{ role: "user", content: prompt }], temperature: 0.3 };

    try {
      const response = await fetch(endpointFor(platform, protocol), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      let payload: unknown = text;
      try { payload = JSON.parse(text); } catch { /* keep plain text */ }
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${readResponse(payload)}`);
      setResult({ kind: "success", text: readResponse(payload) });
    } catch (error) {
      setResult({ kind: "error", text: error instanceof Error ? error.message : "请求失败，请检查 Key、协议和网络访问权限。" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <button className="dialog-backdrop" type="button" onClick={onClose} aria-label="关闭模型测试" />
      <section className="test-dialog" role="dialog" aria-modal="true" aria-labelledby="test-title">
        <div className="dialog-heading"><div className="dialog-title"><div className="dialog-icon dialog-icon--test"><Play size={17} /></div><div><p className="eyebrow">LIVE TEST / {model.key}</p><h2 id="test-title">测试 {model.name}</h2></div></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
        <div className="test-context"><span className="test-context-label">当前调用身份</span><span className="test-context-id"><code>{record?.id ?? "该平台未收录"}</code>{platform === "cmdc" && record && <a className="test-context-link" href={commandCodeModelUrl(record.id)} target="_blank" rel="noreferrer"><ExternalLink size={12} />在线信息</a>}</span></div>
        <div className="test-price-row test-price-row--quotes" aria-label="当前平台全部报价">
          <span className="test-price-label">价格（USD / 1M token）</span>
          <span className="test-price-quote-list">
            {quotes.map((quote, index) => (
              <span className="test-price-line" key={`${quote.name ?? "std"}-${index}`}>
                {quote.name && <em>{quote.name}</em>}
                <span>入 <strong>{quote.input === null || quote.input === undefined ? "—" : formatPrice(quote.input)}</strong></span>
                <span>出 <strong>{quote.output === null || quote.output === undefined ? "—" : formatPrice(quote.output)}</strong></span>
                <span>缓读 <strong>{quote.cacheRead === null || quote.cacheRead === undefined ? "—" : formatPrice(quote.cacheRead)}</strong></span>
                <span>缓写 <strong>{quote.cacheWrite === null || quote.cacheWrite === undefined ? "—" : formatPrice(quote.cacheWrite)}</strong></span>
                {quote.note && <small>{quote.note}</small>}
              </span>
            ))}
          </span>
        </div>
        <div className="test-fields">
          <div className="test-field"><label>平台</label><div className="test-tabs">{availablePlatforms.map((item) => <button type="button" key={item} className={platform === item ? "is-selected" : ""} onClick={() => setPlatform(item)}>{PLATFORM_META[item].label}</button>)}</div></div>
          <div className="test-field"><label>协议 <span>模型允许的协议</span></label><div className="test-tabs test-tabs--protocol">{protocols.length ? protocols.map((item) => <button type="button" key={item} className={protocol === item ? "is-selected" : ""} onClick={() => setProtocol(item)}>{displayProtocol(item)}</button>) : <span className="test-empty">平台未提供协议记录</span>}</div></div>
          <div className="test-field"><label htmlFor="test-prompt">测试内容</label><textarea id="test-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} /></div>
        </div>
        {result && <div className={`test-result test-result--${result.kind}`}><div className="test-result-top"><span>{result.kind === "success" ? "RESPONSE RECEIVED" : "REQUEST NOTE"}</span><span>{platform.toUpperCase()} / {protocol.toUpperCase()}</span></div><pre>{result.text}</pre></div>}
        <div className="dialog-footer"><span className="dialog-security"><span className="live-dot" />{keys[platform] ? "已找到本地 Key" : "尚未设置本地 Key"}</span><div className="dialog-actions"><button className="text-button text-button--dark" type="button" onClick={onOpenSettings}>设置 Key</button><button className="primary-button" type="button" onClick={runTest} disabled={running || !record || !prompt.trim()}>{running ? <><Loader2 size={15} className="spin" />请求中</> : <><Send size={15} />发送测试</>}</button></div></div>
      </section>
    </>
  );
}
