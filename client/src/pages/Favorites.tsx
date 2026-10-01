/* My Models: the user's per-platform favorites, read live from localStorage.
   Each row shows one platform-side: model name, platform call id, context/max output, price. */

import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, HeartCrack, Settings2 } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";
import ApiKeyDialog from "@/components/ApiKeyDialog";
import ModelDrawer from "@/components/ModelDrawer";
import TestDialog from "@/components/TestDialog";
import rawData from "@/data/models.merged.json";
import { loadFavorites, reloadFavorites, removeFavorite, type FavoriteRef } from "@/lib/favorites";
import { CatalogData, formatPrice, formatTokens, MergedModel, PlatformKey, PLATFORM_META } from "@/lib/model-catalog";

const catalog = rawData as CatalogData;

type FavRow = { ref: FavoriteRef; model: MergedModel };

function priceText(model: MergedModel, platform: PlatformKey): string {
  const pricing = model.platforms[platform]?.pricing;
  const parts: string[] = [];
  if (typeof pricing?.input === "number") parts.push(`入 ${formatPrice(pricing.input)}`);
  if (typeof pricing?.output === "number") parts.push(`出 ${formatPrice(pricing.output)}`);
  return parts.length > 0 ? parts.join(" / ") : "价格未公开";
}

function effortsText(model: MergedModel): string {
  const efforts = model.reasoning_efforts;
  if (!efforts || efforts.length === 0) return "—";
  return efforts.join(" · ");
}

import { useCatalog } from "@/contexts/CatalogContext";

export default function Favorites() {
  const [favorites, setFavorites] = useState<FavoriteRef[]>(() => loadFavorites());
  const { models } = useCatalog();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [drawerModel, setDrawerModel] = useState<MergedModel | null>(null);
  const [testModel, setTestModel] = useState<MergedModel | null>(null);
  const [testPlatform, setTestPlatform] = useState<PlatformKey | null>(null);

  useEffect(() => {
    reloadFavorites().then((next) => {
      if (next) setFavorites(next);
    });
    const onFocus = () => {
      setFavorites(loadFavorites());
      reloadFavorites().then((next) => {
        if (next) setFavorites(next);
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const rows: FavRow[] = useMemo(() => {
    const out: FavRow[] = [];
    for (const ref of favorites) {
      const model = models[ref.key] ?? catalog.models[ref.key];
      if (model && model.platforms[ref.platform]) out.push({ ref, model });
    }
    return out;
  }, [favorites, models]);

  const openTest = (model: MergedModel, platform: PlatformKey) => {
    setTestModel(model);
    setTestPlatform(model.platforms[platform] ? platform : null);
  };

  const closeTest = () => {
    setTestModel(null);
    setTestPlatform(null);
  };

  const handleRemove = (row: FavRow) => {
    setFavorites(removeFavorite(favorites, row.ref.platform, row.ref.key));
    toast.success(`已取消喜爱 ${row.model.name}（${PLATFORM_META[row.ref.platform].label}）`);
  };

  return (
    <div className="catalog-app maint-app">
      <header className="topbar">
        <Link className="brand-lockup" href="/" aria-label="返回 Model Catalog 首页">
          <img src="/model-catalog-mark.svg" alt="" className="brand-mark" />
          <span className="brand-wordmark"><strong>MODEL</strong><span>CATALOG</span></span>
        </Link>
        <nav className="topnav"><Link href="/">模型目录</Link><Link className="is-active" href="/favorites">我的模型</Link><Link href="/compare">性价比对比</Link><Link href="/maintenance">模型维护</Link></nav>
        <div className="topbar-actions">
          <button className="topbar-icon-link" type="button" onClick={() => setSettingsOpen(true)}><Settings2 size={15} />API Key 设置</button>
        </div>
      </header>

      <main className="maint-main">
        <section className="maint-head">
          <div>
            <p className="eyebrow eyebrow--orange">FAVORITES / 04</p>
            <h1>我的模型</h1>
            <p className="maint-desc">在模型维护页点心形收藏的平台侧模型会显示在这里。点击行查看详情，模型名可直接测试。</p>
          </div>
          <div className="maint-head-actions">
            <span className="maint-count">共 {rows.length} 个收藏</span>
          </div>
        </section>

        {rows.length === 0 ? (
          <div className="maint-empty" style={{ marginTop: 24 }}>
            还没有收藏。去<Link href="/maintenance">模型维护</Link>页点每行右侧的心形图标，把常用模型收进来。
          </div>
        ) : (
          <section className="compare-section">
            <div className="compare-table-wrap">
              <table className="compare-table fav-table">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th>平台</th>
                    <th>上下文窗口</th>
                    <th>最大输出</th>
                    <th>价格 / 1M</th>
                    <th>推理档位</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ ref, model }, index) => {
                    const record = model.platforms[ref.platform];
                    return (
                      <tr key={`${ref.platform}:${ref.key}`} onClick={() => setDrawerModel(model)}>
                        <td>
                          <div className="compare-model-cell">
                            <span className="compare-index">{String(index + 1).padStart(2, "0")}</span>
                            <div>
                              <strong>{model.name}</strong>
                              <code>{record?.id ?? model.key}</code>
                            </div>
                          </div>
                        </td>
                        <td><span className={`maint-platform-badge maint-platform-badge--${ref.platform}`}>{PLATFORM_META[ref.platform].short}</span></td>
                        <td>{model.context_size ? formatTokens(model.context_size) : "未公开"}</td>
                        <td>{model.max_output ? formatTokens(model.max_output) : "未公开"}</td>
                        <td>{priceText(model, ref.platform)}</td>
                        <td>{effortsText(model)}</td>
                        <td>
                          <span className="maint-actions">
                            <button
                              className="table-test"
                              type="button"
                              title="测试该模型"
                              onClick={(event) => { event.stopPropagation(); openTest(model, ref.platform); }}
                            >
                              测试 <ArrowUpRight size={13} />
                            </button>
                            <button
                              className="maint-fav is-active"
                              type="button"
                              title="取消喜爱"
                              aria-label={`取消喜爱 ${model.name}`}
                              onClick={(event) => { event.stopPropagation(); handleRemove({ ref, model }); }}
                            >
                              <HeartCrack size={14} />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="compare-foot"><span>显示 {rows.length} 个收藏模型</span><span>点击行查看完整平台详情</span></div>
          </section>
        )}
      </main>

      <footer className="catalog-footer">
        <div><img src="/model-catalog-mark.svg" alt="" className="footer-mark" /><span>Model Catalog / my models</span></div>
        <span>收藏存于浏览器本地；/api/models/favorite 输出同样内容供外部调用</span>
      </footer>
      <ApiKeyDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ModelDrawer model={drawerModel} onClose={() => setDrawerModel(null)} />
      <TestDialog model={testModel} initialPlatform={testPlatform} onClose={closeTest} onOpenSettings={() => setSettingsOpen(true)} />
    </div>
  );
}
