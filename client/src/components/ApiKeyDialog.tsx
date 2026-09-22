/* Editorial Atlas reminder: credentials stay in the user's browser filing cabinet; the UI makes storage scope and clear actions explicit. */

import { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Save, Trash2, X } from "lucide-react";
import { PlatformKey, PLATFORM_META } from "@/lib/model-catalog";

const STORAGE_KEY = "model-catalog.api-keys.v1";

type ApiKeys = Record<PlatformKey, string>;

type ApiKeyDialogProps = {
  open: boolean;
  onClose: () => void;
};

export function loadApiKeys(): ApiKeys {
  if (typeof window === "undefined") return { opencode: "", cmdc: "" };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return { opencode: typeof parsed.opencode === "string" ? parsed.opencode : "", cmdc: typeof parsed.cmdc === "string" ? parsed.cmdc : "" };
  } catch {
    return { opencode: "", cmdc: "" };
  }
}

export function persistApiKeys(keys: ApiKeys) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

export default function ApiKeyDialog({ open, onClose }: ApiKeyDialogProps) {
  const [keys, setKeys] = useState<ApiKeys>({ opencode: "", cmdc: "" });
  const [visible, setVisible] = useState<Record<PlatformKey, boolean>>({ opencode: false, cmdc: false });
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (open) {
      setKeys(loadApiKeys());
      setSaved(false);
    }
  }, [open]);

  if (!open) return null;

  const save = () => {
    persistApiKeys(keys);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const clear = (platform: PlatformKey) => {
    const next = { ...keys, [platform]: "" };
    setKeys(next);
    persistApiKeys(next);
  };

  return (
    <>
      <button className="dialog-backdrop" type="button" onClick={onClose} aria-label="关闭 API Key 设置" />
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="api-key-title">
        <div className="dialog-heading"><div className="dialog-title"><div className="dialog-icon"><KeyRound size={18} /></div><div><p className="eyebrow">LOCAL SETTINGS / CREDENTIALS</p><h2 id="api-key-title">设置 API Key</h2></div></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
        <p className="dialog-intro">Key 只保存在当前浏览器的 localStorage 中。测试请求会直接从浏览器发送到所选平台，不会经过本目录的服务器。</p>
        <div className="key-fields">
          {(["opencode", "cmdc"] as PlatformKey[]).map((platform) => <div className="key-field" key={platform}><div className="key-field-label"><span className={`key-platform-dot key-platform-dot--${platform}`} />{PLATFORM_META[platform].label}<code>{platform === "opencode" ? "OPENCODE_API_KEY" : "CC_KEY"}</code></div><div className="key-input-wrap"><input type={visible[platform] ? "text" : "password"} value={keys[platform]} onChange={(event) => setKeys({ ...keys, [platform]: event.target.value })} placeholder={`粘贴 ${PLATFORM_META[platform].label} Key`} autoComplete="off" /><button type="button" onClick={() => setVisible({ ...visible, [platform]: !visible[platform] })} aria-label={visible[platform] ? "隐藏 Key" : "显示 Key"}>{visible[platform] ? <EyeOff size={16} /> : <Eye size={16} />}</button>{keys[platform] && <button type="button" onClick={() => clear(platform)} aria-label={`清除 ${PLATFORM_META[platform].label} Key`}><Trash2 size={15} /></button>}</div></div>)}
        </div>
        <div className="dialog-footer"><span className="dialog-security"><span className="live-dot" />仅本机浏览器可见</span><div className="dialog-actions"><button className="text-button text-button--dark" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={save}>{saved ? "已保存" : "保存设置"} {saved ? <span>✓</span> : <Save size={15} />}</button></div></div>
      </section>
    </>
  );
}
