/* Editorial Atlas reminder: prices are edited in place—one tier at a time, with the baseline tier always mirrored back to the root price so every page keeps reading the same number. */

import { useEffect, useState } from "react";
import { Loader2, Save, Tag, X } from "lucide-react";
import { toast } from "sonner";
import { MergedModel, PlatformKey, PLATFORM_META } from "@/lib/model-catalog";
import { getMaintenanceHeaders } from "@/lib/maint-auth";

const PRICE_FIELDS = [
  { key: "input", label: "输入 / M" },
  { key: "output", label: "输出 / M" },
  { key: "cache_read", label: "缓存读 / M" },
  { key: "cache_write", label: "缓存写 / M" },
] as const;

type PriceField = (typeof PRICE_FIELDS)[number]["key"];
type PriceValues = Record<PriceField, string>;

type PricingDialogProps = {
  model: MergedModel;
  platform: PlatformKey;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
};

function tierLabel(tier: Record<string, unknown>, index: number): string {
  const raw = [tier.context, tier.label, tier.name].find((v): v is string => typeof v === "string" && v.trim().length > 0)?.trim();
  if (raw) return raw.replace(/<=/g, "≤").replace(/>=/g, "≥").replace(/([<>])\s+/g, "$1");
  return index === 0 ? "标准档" : `档 ${index + 1}`;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toInput(value: unknown): string {
  const n = asNumber(value);
  return n === null ? "" : String(n);
}

export default function PricingDialog({ model, platform, onClose, onSaved }: PricingDialogProps) {
  const record = model.platforms[platform];
  const pricing = record?.pricing as Record<string, unknown> | undefined;
  const tiers = Array.isArray(pricing?.tiers) ? (pricing?.tiers as Array<Record<string, unknown>>) : [];
  const hasTiers = tiers.length > 0;

  const sourceAt = (index: number): Record<string, unknown> => (hasTiers ? (tiers[index] ?? {}) : (pricing ?? {}));
  const valuesAt = (index: number): PriceValues => {
    const src = sourceAt(index);
    return {
      input: toInput(src.input),
      output: toInput(src.output),
      cache_read: toInput(src.cache_read),
      cache_write: toInput(src.cache_write),
    };
  };

  const [tierIndex, setTierIndex] = useState(0);
  const [values, setValues] = useState<PriceValues>(() => valuesAt(0));
  const [monthly, setMonthly] = useState(() => toInput(record?.allowance?.monthly_usd));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValues(valuesAt(0));
    setTierIndex(0);
  }, [model.key, platform]);

  const selectTier = (index: number) => {
    setTierIndex(index);
    setValues(valuesAt(index));
  };

  // 空字符串 = 未公开 → 提交 null（清空该字段）；否则必须是合法非负数字
  const parseField = (raw: string): number | null | undefined => {
    const text = raw.trim();
    if (!text) return null;
    const n = Number(text);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  };

  const save = async () => {
    const patch: Record<string, number | null> = {};
    for (const { key, label } of PRICE_FIELDS) {
      const parsed = parseField(values[key]);
      if (parsed === undefined) {
        toast.error(`${label.replace(" / M", "")} 需要是非负数字，留空表示未公开`);
        return;
      }
      patch[key] = parsed;
    }
    const parsedMonthly = parseField(monthly);
    if (parsedMonthly === undefined) {
      toast.error("月额度需要是非负数字，留空表示未公开");
      return;
    }

    setSaving(true);
    try {
      const resp = await fetch("/api/maintenance/pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getMaintenanceHeaders() },
        body: JSON.stringify({ key: model.key, platform, tierIndex, ...patch, monthly_usd: parsedMonthly }),
        signal: AbortSignal.timeout(30000),
      });
      const body = (await resp.json()) as { ok?: boolean; error?: string; action?: string };
      if (!resp.ok || !body.ok) throw new Error(body.error ?? `保存失败 ${resp.status}`);
      toast.success(`已更新 ${model.name}（${PLATFORM_META[platform].label}）${tierIndex === 0 && hasTiers ? " 基准档" : ""}价格`);
      await onSaved();
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const mirrorsRoot = !hasTiers || tierIndex === 0;

  return (
    <>
      <button className="dialog-backdrop" type="button" onClick={onClose} aria-label="关闭价格编辑" />
      <section className="settings-dialog pricing-dialog" role="dialog" aria-modal="true" aria-labelledby="pricing-title">
        <div className="dialog-heading">
          <div className="dialog-title">
            <div className="dialog-icon dialog-icon--price"><Tag size={18} /></div>
            <div>
              <p className="eyebrow">PRICING / {PLATFORM_META[platform].label}</p>
              <h2 id="pricing-title">{model.name}</h2>
            </div>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>

        <p className="dialog-intro">
          编辑该平台侧价格，单位 <strong>USD / 每 1M token</strong>。留空表示官方未公开。价格写入 <code>models.merged.json</code> 前会自动备份。
          <br />
          <code>{record?.id ?? model.key}</code>
        </p>

        {hasTiers ? (
          <div className="pricing-tiers">
            <span className="pricing-band-label">价格档位（共 {tiers.length} 档）</span>
            <div className="pricing-tier-list" role="group" aria-label="选择要编辑的价格档位">
              {tiers.map((tier, index) => (
                <button
                  key={`${tierLabel(tier, index)}-${index}`}
                  className={index === tierIndex ? "pricing-tier is-active" : "pricing-tier"}
                  type="button"
                  aria-pressed={index === tierIndex}
                  onClick={() => selectTier(index)}
                >
                  {tierLabel(tier, index)}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="pricing-tiers">
            <span className="pricing-band-label">单一价格（无分档）</span>
          </div>
        )}

        <div className="pricing-grid">
          {PRICE_FIELDS.map(({ key, label }) => (
            <label className="pricing-field" key={key}>
              <span>{label}</span>
              <input
                value={values[key]}
                onChange={(event) => setValues((prev) => ({ ...prev, [key]: event.target.value }))}
                inputMode="decimal"
                placeholder="未公开"
                aria-label={label}
              />
            </label>
          ))}
        </div>

        <label className="pricing-field pricing-field--allowance">
          <span>月额度 monthly_usd</span>
          <input
            value={monthly}
            onChange={(event) => setMonthly(event.target.value)}
            inputMode="decimal"
            placeholder="未公开"
            aria-label="月额度 monthly_usd"
          />
        </label>

        {mirrorsRoot && (
          <p className="maint-hint">这是该平台的主价格档，保存时会同步写回根级主价格，首页、对比页与 LiteLLM 导出随之更新。</p>
        )}

        <div className="dialog-footer">
          <span className="dialog-security"><i className="live-dot" />写前自动备份</span>
          <div className="dialog-actions">
            <button className="maint-hide" type="button" onClick={onClose} disabled={saving}>取消</button>
            <button className="maint-add" type="button" onClick={save} disabled={saving}>
              {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
              保存价格
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
