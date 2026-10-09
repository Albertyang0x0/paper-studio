import type { ApiConnection } from "../shared/api-settings";
/** This type must never be serialized to clients or paper projects. */
export type ServerConnection = Omit<ApiConnection, "configured" | "keyHint"> & { apiKey?: string };
export type ProviderModel = { id: string; name: string; vision?: boolean };
export type ProviderResult = { text?: string; image?: string; model?: string; usage?: unknown; provider?: string; finishReason?: string };
export class ProviderError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}
export function redactProviderError(message: unknown, connection: ServerConnection) {
  let safe = String(message);
  if (connection.apiKey) safe = safe.split(connection.apiKey).join("[redacted]");
  return safe.replace(/sk-[a-zA-Z0-9_-]{8,}/g, "[redacted]").slice(0, 600);
}
export function dataImage(url: string) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z\d+/=]+)$/.exec(url);
  if (!match) throw new ProviderError("图片输入必须是本地 PNG/JPEG/WebP 数据。");
  return { mimeType: match[1], data: match[2] };
}
