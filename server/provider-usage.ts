import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { outputPath } from "./storage";
import type { ServerConnection, ProviderResult } from "./provider-types";
export async function recordProviderUsage(connection: ServerConnection, model: string, result: ProviderResult, started: number, extra: object = {}) {
  await mkdir(outputPath("usage"), { recursive: true });
  const record = JSON.stringify({ time: new Date().toISOString(), model, returnedModel: result.model, connectionId: connection.id,
    protocol: connection.protocol, provider: result.provider, elapsedMs: Date.now() - started,
    finishReason: result.finishReason, usage: result.usage, ...extra });
  // Never record credentials, including keys echoed by a custom gateway.
  const safe = connection.apiKey ? record.split(connection.apiKey).join("[redacted]") : record;
  await appendFile(join(outputPath("usage"), connection.protocol === "openrouter" ? "openrouter.jsonl" : "providers.jsonl"), safe + "\n");
}
