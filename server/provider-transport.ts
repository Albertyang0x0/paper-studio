import type { ApiConnectionResult } from "../shared/api-settings";
import { ProviderError, dataImage, redactProviderError, type ServerConnection, type ProviderModel, type ProviderResult } from "./provider-types";
import { anthropicModels, anthropicText } from "./providers/anthropic";

function headers(connection: ServerConnection): Record<string, string> {
  if (!connection.apiKey) return {};
  return connection.protocol === "gemini" ? { "x-goog-api-key": connection.apiKey } : { Authorization: `Bearer ${connection.apiKey}` };
}
function ready(connection: ServerConnection) {
  if (connection.requiresKey && !connection.apiKey) throw new ProviderError(`连接“${connection.name}”尚未配置 API key。`, 400);
}
async function json(connection: ServerConnection, path: string, body: unknown | undefined, signal: AbortSignal, request: typeof fetch) {
  ready(connection);
  let response: Response;
  try { response = await request(connection.baseUrl + path, { method: body === undefined ? "GET" : "POST",
    headers: { ...headers(connection), ...(body === undefined || body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...(connection.protocol === "openrouter" ? { "X-OpenRouter-Title": "Paper Studio" } : {}) },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body), signal, redirect: "error" }); }
  catch { throw new ProviderError(`无法连接“${connection.name}”，请检查服务地址、网络或代理。`); }
  const result = await response.json().catch(() => undefined) as any;
  if (!response.ok) throw new ProviderError(redactProviderError(result?.error?.message ?? result?.message ?? `接口 HTTP ${response.status}`, connection), response.status);
  if (!result) throw new ProviderError("接口未返回有效 JSON。");
  return result;
}
export async function providerModels(connection: ServerConnection, request: typeof fetch = fetch): Promise<ProviderModel[]> {
  ready(connection); const signal = AbortSignal.timeout(20000);
  const sanitized=(models:ProviderModel[])=>models.filter(m=>/^[\w./:-]{1,150}$/.test(m.id)&&!(connection.apiKey&&(m.id===connection.apiKey||connection.apiKey.length>=8&&m.id.includes(connection.apiKey))))
    .map(m=>({...m,name:redactProviderError(m.name,connection)}));
  if (connection.protocol === "anthropic") return sanitized(await anthropicModels(connection, request, signal));
  const payload = await json(connection, "/models", undefined, signal, request);
  const models = connection.protocol === "gemini" ? payload.models : payload.data;
  if (!Array.isArray(models)) throw new ProviderError("该服务未返回兼容的模型列表。模型 ID 仍可手动填写。");
  return sanitized(models.map((m: any) => ({ id: String(connection.protocol === "gemini" ? m.name?.replace(/^models\//, "") : m.id), name: String(m.displayName ?? m.name ?? m.id), vision: m.architecture?.input_modalities?.includes("image") })));
}
export async function testProvider(connection: ServerConnection, request: typeof fetch = fetch): Promise<ApiConnectionResult> {
  if (connection.protocol !== "openrouter") {
    const models = await providerModels(connection, request);
    return { ok: true, message: `已连接“${connection.name}”，读取到 ${models.length} 个模型。` };
  }
  const result = await json(connection, "/key", undefined, AbortSignal.timeout(20000), request);
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) throw new ProviderError("OpenRouter 返回了无法识别的连接信息。");
  if (result.data.is_management_key || result.data.is_provisioning_key) throw new ProviderError("这是管理用 key，请使用可调用模型的 OpenRouter API key。", 400);
  return { ok: true, message: "已连接 OpenRouter。", limitRemaining: typeof result.data.limit_remaining === "number" && Number.isFinite(result.data.limit_remaining) ? result.data.limit_remaining : undefined };
}
export async function providerText(connection: ServerConnection, model: string, system: string, text: string, images: string[], maxTokens: number, jsonFormat: boolean, signal: AbortSignal, request: typeof fetch = fetch, openrouterOptions?: unknown): Promise<ProviderResult> {
  ready(connection);
  if (connection.protocol === "anthropic") return anthropicText(connection, model, system, text, images, maxTokens, signal, request);
  if (connection.protocol === "gemini") {
    const result = await json(connection, `/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`, {
      systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text }, ...images.map(url => ({ inlineData: dataImage(url) }))] }],
      generationConfig: { maxOutputTokens: maxTokens, ...(jsonFormat ? { responseMimeType: "application/json" } : {}) },
    }, signal, request);
    return { text: result.candidates?.[0]?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join(""), model, usage: result.usageMetadata, provider: "gemini", finishReason: result.candidates?.[0]?.finishReason };
  }
  const completionLimit=connection.protocol==='openai-compatible'&&(new URL(connection.baseUrl).hostname==='api.openai.com'||/^(?:openai\/)?(?:gpt-5(?:[.\-/]|$)|o\d(?:[\-/]|$))/i.test(model))
    ? {max_completion_tokens:maxTokens}:{max_tokens:maxTokens};
  const result = await json(connection, "/chat/completions", {
    model, messages: [{ role: "system", content: system }, { role: "user", content: images.length ? [{ type: "text", text }, ...images.map(url => ({ type: "image_url", image_url: { url } }))] : text }],
    ...completionLimit, ...(connection.protocol === "openrouter" ? openrouterOptions as object : {}),
  }, signal, request);
  const content = result.choices?.[0]?.message?.content;
  return { text: typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p.text ?? "").join("") : undefined,
    model: result.model, usage: result.usage, provider: result.provider ?? connection.protocol, finishReason: result.choices?.[0]?.finish_reason };
}
export async function providerImage(connection: ServerConnection, model: string, prompt: string, references: string[], signal: AbortSignal, request: typeof fetch = fetch): Promise<ProviderResult> {
  ready(connection);
  if (connection.protocol === "anthropic") throw new ProviderError("Anthropic 原生接口不能生成图片，请选择另一个图片连接。", 400);
  let result: any, image: string | undefined;
  if (connection.protocol === "gemini") {
    result = await json(connection, `/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`, {
      contents: [{ role: "user", parts: [{ text: prompt }, ...references.map(url => ({ inlineData: dataImage(url) }))] }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" } },
    }, signal, request);
    const part = result.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data && !p.thought)?.inlineData;
    if (part) image = `data:${part.mimeType};base64,${part.data}`;
  } else if (connection.imageApi === "images") {
    let body: unknown = { model, prompt, n: 1 };
    if (references.length) {
      const form = new FormData(); form.set("model", model); form.set("prompt", prompt);
      references.forEach((url, index) => { const data = dataImage(url); form.append("image[]", new Blob([Buffer.from(data.data, "base64")], { type: data.mimeType }), `reference-${index}.png`); });
      body = form;
    }
    result = await json(connection, references.length ? "/images/edits" : "/images/generations", body, signal, request);
    image = result.data?.[0]?.b64_json ? `data:image/png;base64,${result.data[0].b64_json}` : result.data?.[0]?.url;
  } else {
    result = await json(connection, "/chat/completions", { model, messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...references.map(url => ({ type: "image_url", image_url: { url } }))] }],
      modalities: ["image", "text"], image_config: { aspect_ratio: "16:9", image_size: "2K" } }, signal, request);
    image = result.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  }
  if (!image) throw new ProviderError("图片接口没有返回图片，请检查模型与图片接口类型。");
  if (!image.startsWith("data:")) {
    let url: URL; try { url = new URL(image); } catch { throw new ProviderError("图片接口返回了无效地址。"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new ProviderError("图片下载地址必须是 HTTPS。");
    const response = await request(url, { signal, redirect: "error" });
    if (!response.ok) throw new ProviderError("无法下载接口返回的图片。");
    const mime = response.headers.get("content-type")?.split(";")[0];
    if (!mime || !["image/png", "image/jpeg", "image/webp"].includes(mime)) throw new ProviderError("图片接口返回了不支持的图片类型。");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 24_000_000) throw new ProviderError("图片接口返回的图片过大。");
    image = `data:${mime};base64,${bytes.toString("base64")}`;
  }
  dataImage(image);
  return { image, model: result.model ?? model, usage: result.usage ?? result.usageMetadata, provider: result.provider ?? connection.protocol };
}
