import Anthropic from "@anthropic-ai/sdk";
import { dataImage, ProviderError, redactProviderError, type ServerConnection, type ProviderResult } from "../provider-types";
function client(connection: ServerConnection, request: typeof fetch) {
  return new Anthropic({ apiKey: connection.apiKey, baseURL: connection.baseUrl, fetch: (input,init)=>request(input,{...init,redirect:'error'}), maxRetries: 0, timeout: 360000 });
}
export async function anthropicModels(connection: ServerConnection, request: typeof fetch, signal?: AbortSignal) {
  try { return (await client(connection, request).models.list({ limit: 100 }, { signal })).data.map(m => ({ id: m.id, name: m.display_name, vision: true })); }
  catch (error) { throw new ProviderError(redactProviderError(error instanceof Error ? error.message : error, connection), error instanceof Anthropic.APIError ? error.status ?? 502 : 502); }
}
export async function anthropicText(connection: ServerConnection, model: string, system: string, text: string, images: string[], maxTokens: number, signal: AbortSignal, request: typeof fetch): Promise<ProviderResult> {
  const content: Anthropic.ContentBlockParam[] = [{ type: "text", text }, ...images.map(url => {
    const image = dataImage(url);
    return { type: "image" as const, source: { type: "base64" as const, media_type: image.mimeType as "image/png" | "image/jpeg" | "image/webp", data: image.data } };
  })];
  try {
    const response = await client(connection, request).messages.stream({
      model, max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
      thinking: /(?:opus|sonnet)-4-[67]/.test(model) ? { type: "adaptive" } : undefined,
    }, { signal }).finalMessage();
    return { text: response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map(b => b.text).join("\n"), model: response.model, usage: response.usage, provider: "anthropic", finishReason: response.stop_reason ?? undefined };
  } catch (error) {
    throw new ProviderError(redactProviderError(error instanceof Error ? error.message : error, connection), error instanceof Anthropic.APIError ? error.status ?? 502 : 502);
  }
}
