import { AsyncLocalStorage } from "node:async_hooks";
import { apiSettings } from "./api-settings";
import type { ServerConnection } from "./provider-types";
type Context = { profiles: ServerConnection[]; textDefault: string; imageDefault: string; text?: string; image?: string };
const contexts = new AsyncLocalStorage<Context>();
export function withApiConnections<T>(bindings: { text?: string; image?: string }, callback: () => T, settings = apiSettings): T {
  const previous = contexts.getStore(), snapshot = previous ?? settings.snapshot();
  return contexts.run({ ...snapshot, text: bindings.text || previous?.text, image: bindings.image || previous?.image }, callback);
}
export function runtimeConnection(id?: string, kind: "text" | "image" = "text") {
  const context = contexts.getStore();
  if (!context) return apiSettings.resolve(id, kind);
  const wanted = id || context[kind] || (kind === "text" ? context.textDefault : context.imageDefault);
  const profile = context.profiles.find(p => p.id === wanted);
  if (!profile) throw Error("绑定的 API 连接已不存在，请重新选择连接。");
  if (profile.requiresKey && !profile.apiKey) throw Error("API 连接尚未配置 key。");
  if (kind === "image" && profile.protocol === "anthropic") throw Error("Anthropic 不能生成图片，请选择其他连接。");
  return profile;
}
export function defaultTextModel(id?: string) { return apiSettings.resolve(id, "text", false).textModel; }
export function defaultImageModel(id?: string) { return runtimeConnection(id, "image").imageModel; }
