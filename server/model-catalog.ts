import type { ModelOption } from "../src/domain/types";

const VENDORS: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", deepseek: "DeepSeek", "meta-llama": "Meta", qwen: "Qwen", mistralai: "Mistral", "x-ai": "xAI", "z-ai": "Z.ai", moonshotai: "Moonshot", minimax: "MiniMax", nvidia: "NVIDIA" };
let cache: ModelOption[] | undefined;
let expiresAt = 0;
let pending: Promise<{ models: ModelOption[]; source: "openrouter" | "cache" }> | undefined;

export async function getModelCatalog(): Promise<{ models: ModelOption[]; source: "openrouter" | "cache" }> {
  if (cache && Date.now() < expiresAt) return { models: cache, source: "cache" };
  if (pending) return pending;
  pending = (async () => {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error("Model catalog unavailable");
      const body = await response.json() as { data?: Array<{ id: string; name: string; supported_parameters?: string[]; architecture?: { output_modalities?: string[] } }> };
      if (!Array.isArray(body.data)) throw new Error("Invalid model catalog");
      const models = body.data.filter((model) => typeof model.id === "string" && typeof model.name === "string" && model.supported_parameters?.includes("tools") && (!model.architecture?.output_modalities || model.architecture.output_modalities.includes("text")))
        .map((model) => { const vendorId = model.id.split("/")[0].replace(/^~/, ""); return { id: model.id, name: model.name.replace(/^[^:]+:\s*/, ""), vendor: VENDORS[vendorId] ?? vendorId }; })
        .sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));
      if (!models.length) throw new Error("Empty model catalog");
      cache = models;
      expiresAt = Date.now() + 10 * 60_000;
      return { models, source: "openrouter" as const };
    } catch (error) {
      if (cache) return { models: cache, source: "cache" as const };
      throw error;
    }
  })();
  try { return await pending; } finally { pending = undefined; }
}
