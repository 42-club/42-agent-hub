"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, ChevronDown, LoaderCircle, RefreshCw, Search } from "lucide-react";
import type { AgentEntity, ProviderConnection } from "@/domain/types";
import { api, Avatar, brandForVendor, Dialog, ErrorNotice, errorMessage } from "./ui";

interface CatalogModel { id: string; name: string; vendor: string }
interface ModelCatalog { models: CatalogModel[]; source: "openrouter" | "cache" }

const VENDORS: Record<string, string> = {
  anthropic: "Anthropic", openai: "OpenAI", google: "Google", deepseek: "DeepSeek",
  "meta-llama": "Meta", meta: "Meta", qwen: "Qwen", mistralai: "Mistral",
  "x-ai": "xAI", cohere: "Cohere", moonshotai: "Moonshot AI", minimax: "MiniMax",
  "z-ai": "Z.ai", nvidia: "NVIDIA", amazon: "Amazon", microsoft: "Microsoft",
};

function vendorFromId(modelId: string): string {
  const prefix = modelId.trim().split("/")[0].replace(/^~/, "");
  return VENDORS[prefix.toLowerCase()] || prefix;
}

function displayModelName(model: CatalogModel): string {
  return model.name.trim().slice(0, 80) || model.id.split("/").slice(1).join("/");
}

export function AgentDialog({ agent, provider, onClose, onSaved }: { agent?: AgentEntity; provider?: ProviderConnection; onClose: () => void; onSaved: () => Promise<void> }) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [query, setQuery] = useState("");
  const [modelId, setModelId] = useState(agent?.modelId || "");
  const [manual, setManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setCatalogLoading(true);
    setCatalogError(null);
    api<ModelCatalog>("/api/models", { signal: controller.signal }).then((data) => {
      if (!controller.signal.aborted) setCatalog(data);
    }).catch((cause) => {
      if (!controller.signal.aborted) {
        setCatalogError(errorMessage(cause));
        setManual(true);
      }
    }).finally(() => { if (!controller.signal.aborted) setCatalogLoading(false); });
    return () => controller.abort();
  }, [catalogAttempt]);
  const selected = catalog?.models.find((model) => model.id === modelId.trim());
  const vendor = selected?.vendor || vendorFromId(modelId);
  const modelName = selected ? displayModelName(selected) : modelId.trim().split("/").slice(1).join("/");
  const searchTerms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = catalog?.models.filter((model) => searchTerms.every((term) => `${model.name} ${model.id} ${model.vendor}`.toLowerCase().includes(term))) || [];
  const shownModels = matches.slice(0, 8);
  const validId = /^[^\s/]+\/[^\s]+$/.test(modelId.trim());
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    if (!provider) return setError("OpenRouter 连接尚未准备好，请刷新页面后重试。");
    if (!validId || !modelName) return setError("请选择一个模型，或输入完整的 Model ID，例如 anthropic/claude-sonnet-4.6。");
    setBusy(true);
    try {
      await api(agent ? `/api/agents/${agent.id}` : "/api/agents", {
        method: agent ? "PUT" : "POST",
        body: JSON.stringify({ providerId: provider.id, vendor, modelId: modelId.trim(), modelName: modelName.slice(0, 80), color: brandForVendor(vendor).background }),
      });
      await onSaved();
      onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog open onClose={() => { if (!busy) onClose(); }} title={agent ? "编辑 Agent" : "邀请一位新 Agent"} description="选一个模型，它会以自己的名字和厂商头像入座。">
    <form onSubmit={submit}>
      <div className="modal-body model-picker-body">
        <div className="agent-preview">
          <Avatar name={modelName || "AI"} vendor={vendor} size="large" />
          <div><h3>{modelName || "选择一个模型"}</h3><p>{vendor ? `${vendor} · 通过 OpenRouter` : "所有模型统一通过 OpenRouter 连接"}</p></div>
        </div>
        <label className="field model-search-field">搜索模型<span className="model-search-input"><Search size={17} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (shownModels[0]) { setModelId(shownModels[0].id); setManual(false); setError(null); }
          }
        }} placeholder="搜索 Claude、GPT、Gemini、DeepSeek…" autoComplete="off" /></span></label>
        {catalogLoading ? <div className="catalog-loading" role="status"><LoaderCircle className="spin" size={17} />正在读取 OpenRouter 模型目录…</div> : catalogError ? <div className="catalog-unavailable"><p>暂时无法读取模型目录。你仍可在下方输入 Model ID。</p><button type="button" className="text-link" onClick={() => setCatalogAttempt((attempt) => attempt + 1)}><RefreshCw size={13} />重新加载目录</button></div> : <>
          <div className="model-search-results" aria-label="可选模型">
            {shownModels.map((model) => <button type="button" key={model.id} className={`model-search-result ${modelId === model.id ? "selected" : ""}`} onClick={() => { setModelId(model.id); setManual(false); setError(null); }} aria-pressed={modelId === model.id}>
              <Avatar name={displayModelName(model)} vendor={model.vendor} size="small" />
              <span><strong>{displayModelName(model)}</strong><code>{model.id}</code></span>
              {modelId === model.id && <Check size={16} />}
            </button>)}
            {shownModels.length === 0 && <p className="model-no-results">没有找到匹配模型。试试其他名称，或手动输入 Model ID。</p>}
          </div>
          <p className="catalog-summary">{matches.length} 个匹配模型{matches.length > 8 ? "，显示前 8 个；输入更具体的名称缩小范围。" : "。"}{catalog?.source === "cache" ? " 当前使用已缓存的官方目录。" : " 来自 OpenRouter 官方目录。"}</p>
        </>}
        <button type="button" className="manual-model-toggle" onClick={() => setManual((value) => !value)} aria-expanded={manual}>手动输入 Model ID<ChevronDown size={14} className={manual ? "rotated" : ""} /></button>
        {manual && <label className="field manual-model-field">完整 Model ID<input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder="anthropic/claude-sonnet-4.6" spellCheck={false} autoComplete="off" maxLength={160} /><span className="manual-model-hint">厂商和显示名称会自动识别。目录以外的 ID 会在运行时由 OpenRouter 验证。</span></label>}
        {modelId && !manual && <div className="selected-model-id"><span>已选择</span><code>{modelId}</code></div>}
        {!provider?.configured && <p className="form-hint">OpenRouter 尚未配置密钥。现在可以先创建 Agent，之后在设置中连接，或使用离线演示。</p>}
        <ErrorNotice message={error} />
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button primary" disabled={busy || !provider || !validId}>{busy ? "正在保存…" : "保存 Agent"}</button></div>
    </form>
  </Dialog>;
}

export function OpenRouterDialog({ provider, onClose, onSaved }: { provider?: ProviderConnection; onClose: () => void; onSaved: () => Promise<void> }) {
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true); setError(null);
    try {
      await api(provider ? `/api/providers/${provider.id}` : "/api/providers", {
        method: provider ? "PUT" : "POST",
        body: JSON.stringify({ name: "OpenRouter", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: apiKey.trim() }),
      });
      setApiKey("");
      await onSaved(); onClose();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <Dialog open onClose={() => { if (!busy) onClose(); }} title={provider?.configured ? "更新 OpenRouter 密钥" : "连接 OpenRouter"} description="一次连接，即可让不同厂商的模型加入圆桌。">
    <form onSubmit={submit}><div className="modal-body"><label className="field">{provider?.configured ? "新的 API Key" : "OpenRouter API Key"}<input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider?.configured ? "输入新密钥以替换已有密钥" : "输入你的 OpenRouter API Key"} required autoComplete="new-password" spellCheck={false} maxLength={4096} /></label><p className="form-hint">密钥只保存在服务端，保存后不会显示或回传到浏览器。关闭此窗口会保留已有连接。</p><ErrorNotice message={error} /></div><div className="modal-footer"><button type="button" className="button secondary" onClick={onClose} disabled={busy}>取消</button><button className="button primary" disabled={busy || !apiKey.trim()}>{busy ? "正在保存…" : "保存密钥"}</button></div></form>
  </Dialog>;
}
