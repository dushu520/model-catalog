/* Editorial Atlas reminder: the detail view behaves like an opened archival work sheet; provenance stays visible and every platform keeps its own raw record. */

import { useState } from "react";
import {
  ArrowUpRight,
  CalendarDays,
  Check,
  Clipboard,
  ExternalLink,
  Layers3,
  X,
} from "lucide-react";
import {
  commandCodeModelUrl,
  displayProtocol,
  formatDate,
  formatPrice,
  formatTokens,
  modalityLabels,
  MergedModel,
  PlatformKey,
  PLATFORM_META,
} from "@/lib/model-catalog";

type ModelDrawerProps = {
  model: MergedModel | null;
  onClose: () => void;
};

function valueOrDash(value: unknown) {
  if (value === null || value === undefined || value === "") return "未公开";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

function PlatformRecordBlock({ platform, model }: { platform: PlatformKey; model: MergedModel }) {
  const [copied, setCopied] = useState(false);
  const record = model.platforms[platform];
  if (!record) return null;

  const copyId = async () => {
    await navigator.clipboard?.writeText(record.id);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <section className={`platform-record platform-record--${platform}`}>
      <div className="record-heading">
        <div className="record-platform-mark">{PLATFORM_META[platform].short}</div>
        <div>
          <p className="eyebrow">平台记录</p>
          <h3>{PLATFORM_META[platform].label}</h3>
        </div>
        <span className="record-status">已收录</span>
      </div>
      <div className="id-line">
        <code>{record.id}</code>
        <button className="icon-button icon-button--small" type="button" onClick={copyId} aria-label="复制模型 ID">
          {copied ? <Check size={15} /> : <Clipboard size={15} />}
        </button>
      </div>
      <div className="record-grid">
        <div className="record-metric">
          <span>协议</span>
          <strong>{(record.protocols ?? []).map(displayProtocol).join(" · ") || "—"}</strong>
        </div>
        <div className="record-metric">
          <span>输入 / 输出</span>
          <strong>{formatPrice(record.pricing?.input)} / {formatPrice(record.pricing?.output)}</strong>
        </div>
        <div className="record-metric">
          <span>缓存读取</span>
          <strong>{formatPrice(record.pricing?.cache_read)}</strong>
        </div>
        <div className="record-metric">
          <span>月额度</span>
          <strong>{record.allowance?.monthly_usd ? `$${record.allowance.monthly_usd}` : typeof record.allowance?.plan_allowance === "object" && record.allowance.plan_allowance ? Object.entries(record.allowance.plan_allowance).map(([plan, value]) => `${plan}: ${value ?? "—"}`).join(" · ") : record.allowance?.plan_allowance || "—"}</strong>
        </div>
      </div>
      <div className="record-footer">
        <span>平台侧更新时间 {formatDate(record.updated_at as string | null)}</span>
        {record.source && <span className="source-label">来源已保留</span>}
      </div>
      {platform === "cmdc" && (
        <a className="record-online-link" href={commandCodeModelUrl(record.id)} target="_blank" rel="noreferrer">
          <ExternalLink size={13} />
          在 CommandCode 查看在线模型信息
        </a>
      )}
    </section>
  );
}

export default function ModelDrawer({ model, onClose }: ModelDrawerProps) {
  if (!model) return null;

  return (
    <>
      <button className="drawer-backdrop" type="button" onClick={onClose} aria-label="关闭模型详情" />
      <aside className="detail-drawer" aria-label={`${model.name} 模型详情`}>
        <div className="drawer-header">
          <div className="drawer-kicker"><Layers3 size={15} /> MODEL RECORD / {model.key}</div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭详情"><X size={19} /></button>
        </div>
        <div className="drawer-scroll">
          <div className="drawer-title-block">
            <div className="model-avatar model-avatar--drawer">{model.name.slice(0, 1)}</div>
            <div>
              <h2>{model.name}</h2>
              <p>{model.provider} <span>·</span> {model.category === "opensource" ? "开源" : "商业"}</p>
            </div>
          </div>

          <div className="detail-chip-row">
            <span className="detail-chip detail-chip--accent">{model.coverage.count === 2 ? "双平台" : "单平台"}</span>
            {model.reasoning && <span className="detail-chip">Reasoning</span>}
            {model.reasoning_efforts && model.reasoning_efforts.length > 0 && <span className="detail-chip detail-chip--effort">推理档位 · {model.reasoning_efforts.length}</span>}
            {model.tool_use && <span className="detail-chip">Tool use</span>}
            {model.capabilities.protocols.map((protocol) => <span className="detail-chip" key={protocol}>{displayProtocol(protocol)}</span>)}
          </div>

          <div className="fact-strip">
            <div><span>上下文</span><strong>{formatTokens(model.context_size)}</strong></div>
            <div><span>最大输出</span><strong>{formatTokens(model.max_output)}</strong></div>
            <div><span>更新</span><strong>{formatDate(model.updated_at)}</strong></div>
          </div>

          <section className="detail-section">
            <div className="section-title-row"><div><p className="eyebrow">平台拆解</p><h3>每个平台，保留自己的事实</h3></div><ArrowUpRight size={18} /></div>
            {(["opencode", "cmdc"] as PlatformKey[]).map((platform) => <PlatformRecordBlock key={platform} platform={platform} model={model} />)}
          </section>

          <section className="detail-section detail-section--plain">
            <div className="section-title-row"><div><p className="eyebrow">能力标签</p><h3>可用于快速筛选</h3></div></div>
            <div className="capability-list">
              {model.capabilities.multimodal.map((mode) => <span key={mode}>{modalityLabels[mode] ?? mode}</span>)}
            </div>
          </section>

          {model.reasoning_efforts && model.reasoning_efforts.length > 0 && (
            <section className="detail-section detail-section--plain">
              <div className="section-title-row"><div><p className="eyebrow">推理强度</p><h3>reasoning efforts</h3></div></div>
              <div className="capability-list effort-tags">
                {model.reasoning_efforts.map((effort) => <span className="effort-tag" key={effort}>{effort}</span>)}
              </div>
            </section>
          )}

          <section className="detail-section detail-section--plain source-section">
            <div className="section-title-row"><div><p className="eyebrow">溯源</p><h3>数据更新时间与来源</h3></div><CalendarDays size={18} /></div>
            <p>模型身份由平台 ID 归一化合并；发生名称、上下文或更新时间差异时，详情中优先保留平台侧原始值。</p>
            <div className="source-links">
              {(["opencode", "cmdc"] as PlatformKey[]).filter((platform) => model.platforms[platform]).map((platform) => <a href={platform === "opencode" ? "https://opencode.ai/docs/zh-cn/go" : "https://commandcode.ai/docs/resources/pricing-limits"} target="_blank" rel="noreferrer" key={platform}>{PLATFORM_META[platform].label} 文档 <ExternalLink size={13} /></a>)}
            </div>
          </section>
        </div>
      </aside>
    </>
  );
}
