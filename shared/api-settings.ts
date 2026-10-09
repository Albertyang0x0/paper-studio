export type ApiProtocol = "openrouter" | "openai-compatible" | "gemini" | "anthropic";
export const protocolLabels: Record<ApiProtocol, string> = {
  openrouter: "OpenRouter", "openai-compatible": "OpenAI 兼容", gemini: "Gemini 原生", anthropic: "Anthropic 原生",
};
export const protocolDefaults: Record<ApiProtocol, { baseUrl: string; textModel: string; imageModel: string; imageApi: "chat" | "images" }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", textModel: "google/gemini-3.1-pro-preview", imageModel: "google/gemini-3-pro-image", imageApi: "chat" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", textModel: "", imageModel: "", imageApi: "images" },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta", textModel: "gemini-3.1-pro-preview", imageModel: "gemini-3-pro-image", imageApi: "chat" },
  anthropic: { baseUrl: "https://api.anthropic.com", textModel: "claude-opus-4-7", imageModel: "", imageApi: "chat" },
};
export type ApiConnection = {
  id: string; name: string; protocol: ApiProtocol; baseUrl: string;
  textModel: string; imageModel: string; imageApi: "chat" | "images";
  requiresKey: boolean; configured: boolean; keyHint?: string;
  revision: number; source: "saved" | "environment"; updatedAt?: string;
};
export type ConnectionDraft = Pick<ApiConnection, "name" | "protocol" | "baseUrl" | "textModel" | "imageModel" | "imageApi" | "requiresKey"> & { id?: string; apiKey?: string };
export type ApiSettingsStatus = {
  provider: ApiProtocol; configured: boolean; keyHint?: string;
  source: "saved" | "environment" | "none"; updatedAt?: string;
  connections: ApiConnection[]; defaultConnectionId: string; defaultImageConnectionId: string;
};
export type ApiConnectionResult = { ok: true; message: string; limitRemaining?: number };
