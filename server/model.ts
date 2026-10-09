import type { Reference, RunEvent } from "../shared/types";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeConnection } from "./provider-runtime";
import { providerText } from "./provider-transport";
import { recordProviderUsage } from "./provider-usage";
import { ProviderError, redactProviderError } from "./provider-types";
export type Log = (
  stage: string,
  status: RunEvent["status"],
  message: string,
) => void;
let catalog: Promise<any[]> | undefined;
async function reasoningFor(model: string) {
  catalog ??= fetch("https://openrouter.ai/api/v1/models", {
    signal: AbortSignal.timeout(15000),
  })
    .then((r) => r.json())
    .then((r: any) => r.data ?? [])
    .catch(() => []);
  const meta = (await catalog).find((m) => m.id === model)?.reasoning;
  if (!meta) return undefined;
  const supported = meta.supported_efforts as string[] | undefined;
  const effort = model === 'google/gemini-3.1-pro-preview' && supported?.includes('high')
    ? (process.env.PAPER_REASONING_EFFORT ?? 'high')
    : meta.mandatory
    ? supported?.includes("minimal")
      ? "minimal"
      : supported?.includes("low")
        ? "low"
        : meta.default_effort
    : "none";
  return { effort, exclude: true };
}
async function supportsJson(model: string) {
  await reasoningFor(model);
  return (
    (await catalog)
      ?.find((m) => m.id === model)
      ?.supported_parameters?.includes("response_format") ?? false
  );
}
export async function referenceImages(references: Reference[]) {
  return Promise.all(
    references.slice(0, 3).map(async (r) => {
      const dataUrl = r.dataUrl ?? r.url;
      if (
        dataUrl &&
        /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl) &&
        dataUrl.length < 5600000
      )
        return dataUrl;
      if (/^\/references\/[a-zA-Z0-9-]+\.png$/.test(r.url)) {
        const bytes = await readFile(join(process.cwd(), "public", r.url));
        return `data:image/png;base64,${bytes.toString("base64")}`;
      }
      throw Error(`Reference ${r.name} is not an accepted local image`);
    }),
  );
}
/** Optional local style examples are not a deployment dependency or distributable asset. */
export async function bundledReferenceImages(cwd = process.cwd()) {
  const images = await Promise.all(['multi-panel', 'nested-memory', 'trajectory'].map(async id => {
    try { return `data:image/png;base64,${(await readFile(join(cwd, 'public', 'references', id + '.png'))).toString('base64')}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }));
  return images.filter((image): image is string => image !== undefined);
}
export async function modelJson(
  model: string, system: string, data: unknown, images: string[] = [],
  signal?: AbortSignal, maxTokens = 8000, jsonFormat = true, connectionId?: string,
) {
  const connection = runtimeConnection(connectionId);
  let error: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw Error("Generation cancelled");
    const started = Date.now();
    try {
      const openrouter = connection.protocol === "openrouter";
      const options = openrouter ? { temperature: 0.25, reasoning: await reasoningFor(model),
        response_format: jsonFormat && (await supportsJson(model)) ? { type: "json_object" } : undefined } : undefined;
      const tokens = /gemini-3\.1-pro/.test(model) ? Math.max(attempt ? 48000 : 32000, maxTokens + 20000)
        : attempt ? Math.min(18000, maxTokens * 1.5) : maxTokens;
      const result = await providerText(connection, model,
        system + (attempt ? "\nThe last response was invalid. Return only a complete valid JSON object following the contract." : ""),
        JSON.stringify(data), images, tokens, jsonFormat,
        signal ? AbortSignal.any([signal, AbortSignal.timeout(360000)]) : AbortSignal.timeout(360000),
        fetch, options);
      await recordProviderUsage(connection, model, result, started, { attempt });
      if (typeof result.text !== "string") throw Error("Model returned no textual program");
      const start = result.text.indexOf("{"), end = result.text.lastIndexOf("}");
      return JSON.parse(result.text.slice(start, end + 1));
    } catch (failure) {
      if (signal?.aborted) throw Error("Generation cancelled");
      if (failure instanceof ProviderError && failure.status < 500 && failure.status !== 429) throw failure;
      error = failure;
      if (attempt < 2 && failure instanceof ProviderError) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw Error("模型调用或 JSON 输出无效：" + redactProviderError(error, connection));
}
export function boundModel(connectionId?: string, base: typeof modelJson = modelJson): typeof modelJson {
  return (model, system, data, images, signal, maxTokens, jsonFormat, explicit) =>
    base(model, system, data, images, signal, maxTokens, jsonFormat, explicit || connectionId);
}
