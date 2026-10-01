import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import rawData from "@/data/models.merged.json";
import { CatalogData, MergedModel } from "@/lib/model-catalog";

const catalog = rawData as CatalogData;

interface CatalogContextType {
  models: Record<string, MergedModel>;
  total: number;
  loading: boolean;
  refresh: () => Promise<void>;
  updateModel: (key: string, model: MergedModel) => void;
  removeModelKey: (key: string, platform?: string) => void;
}

const CatalogContext = createContext<CatalogContextType | undefined>(undefined);

export function CatalogProvider({ children }: { children: React.ReactNode }) {
  const [models, setModels] = useState<Record<string, MergedModel>>(() => catalog.models);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch("/api/maintenance/local", { signal: AbortSignal.timeout(10000) });
      if (resp.ok) {
        const body = (await resp.json()) as { models?: Record<string, MergedModel> };
        if (body.models && Object.keys(body.models).length > 0) {
          setModels(body.models);
        }
      }
    } catch {
      // 失败降级使用当前快照
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateModel = useCallback((key: string, model: MergedModel) => {
    setModels((prev) => ({ ...prev, [key]: model }));
  }, []);

  const removeModelKey = useCallback((key: string, platform?: string) => {
    setModels((prev) => {
      if (!platform) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      const existing = prev[key];
      if (!existing) return prev;
      const platforms = { ...existing.platforms };
      delete (platforms as any)[platform];
      if (Object.keys(platforms).length === 0) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: { ...existing, platforms } };
    });
  }, []);

  return (
    <CatalogContext.Provider
      value={{
        models,
        total: Object.keys(models).length,
        loading,
        refresh,
        updateModel,
        removeModelKey,
      }}
    >
      {children}
    </CatalogContext.Provider>
  );
}

export function useCatalog() {
  const context = useContext(CatalogContext);
  if (!context) {
    throw new Error("useCatalog must be used within a CatalogProvider");
  }
  return context;
}
