import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import { protocolDefaults, type ApiSettingsStatus, type ApiConnectionResult, type ConnectionDraft, type ApiProtocol } from "../shared/api-settings";
import { storageConfig } from "./storage";
import { testProvider } from "./provider-transport";
import { ProviderError, type ServerConnection } from "./provider-types";

export class ApiSettingsError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function apiSettingsPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  const storage = storageConfig(env, cwd);
  return join(storage.testing ? storage.root : join(cwd, ".local"), "api-settings.json");
}
const legacyId = "openrouter-default";
function keyValue(value: unknown, protocol: ApiProtocol) {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\s\x00-\x1f]/.test(value.trim()))
    throw new ApiSettingsError("请输入有效的 API key。");
  if (protocol === "openrouter" && !/^sk-or-[A-Za-z0-9_-]{16,256}$/.test(value.trim()))
    throw new ApiSettingsError("请输入有效的 OpenRouter API key（以 sk-or- 开头）。");
  return value.trim();
}
function normalize(value: Partial<ConnectionDraft>, previous?: ServerConnection): ServerConnection {
  if (!value || !Object.hasOwn(protocolDefaults,value.protocol??'')) throw new ApiSettingsError("接口协议无效。");
  const protocol = value.protocol!, defaults = protocolDefaults[protocol];
  let url: URL; try { url = new URL(String(value.baseUrl ?? defaults.baseUrl).trim()); }
  catch { throw new ApiSettingsError("Base URL 无效。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new ApiSettingsError("Base URL 只能是 HTTP/HTTPS 服务地址，不能包含密钥、查询参数或用户名密码。");
  const baseUrl = url.toString().replace(/\/+$/, "");
  if (protocol === "openrouter" && baseUrl !== protocolDefaults.openrouter.baseUrl)
    throw new ApiSettingsError("OpenRouter 地址固定；自定义网关请使用 OpenAI 兼容协议。");
  if (/\/(?:chat\/completions|images\/generations|messages)$/.test(baseUrl))
    throw new ApiSettingsError("请填写 Base URL，不要包含具体接口路径。");
  const requiresKey = protocol === "openai-compatible" ? value.requiresKey !== false : true;
  if(value.apiKey!==undefined&&typeof value.apiKey!=='string')throw new ApiSettingsError('API key 无效。');
  const supplied = value.apiKey?.trim();
  const changed = previous && (previous.baseUrl !== baseUrl || previous.protocol !== protocol);
  if (changed && !supplied && requiresKey) throw new ApiSettingsError("服务地址或协议改变后，请重新填写对应的 API key。");
  const apiKey = !requiresKey ? undefined : supplied ? keyValue(supplied, protocol) : previous?.apiKey;
  if (requiresKey && !apiKey && value.id !== legacyId) throw new ApiSettingsError("请输入该连接的 API key。");
  const name = String(value.name ?? "").trim();
  if (!name || name.length > 80 || /[\x00-\x1f]/.test(name) || (apiKey && (name===apiKey || apiKey.length>=8&&(name.includes(apiKey) || baseUrl.includes(apiKey)))))
    throw new ApiSettingsError("连接名称或服务地址无效，不应包含密钥。");
  const model = (entry: unknown) => {
    const result = String(entry ?? "").trim();
    if (result && (!/^[\w./:-]{1,150}$/.test(result) || apiKey&&(result===apiKey||apiKey.length>=8&&result.includes(apiKey)))) throw new ApiSettingsError("模型 ID 无效，不能填写 API key。");
    return result;
  };
  return {
    id: previous?.id ?? value.id ?? randomUUID(), name, protocol, baseUrl, apiKey, requiresKey,
    textModel: model(value.textModel), imageModel: protocol === "anthropic" ? "" : model(value.imageModel),
    imageApi: protocol === "openai-compatible" && value.imageApi === "images" ? "images" : "chat",
    revision: (previous?.revision ?? 0) + 1, source: "saved", updatedAt: new Date().toISOString(),
  };
}
/** This registry never returns raw credentials to clients or project exporters. */
export class ApiSettingsStore {
  private profiles?: ServerConnection[];
  private textDefault = legacyId;
  private imageDefault = legacyId;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private path = apiSettingsPath(), private env: NodeJS.ProcessEnv = process.env, private request: typeof fetch = fetch) {}
  private all(): ServerConnection[] {
    return this.profiles ?? [{
      id: legacyId, name: "OpenRouter", protocol: "openrouter", ...protocolDefaults.openrouter,
      textModel: this.env.OPENROUTER_TEXT_MODEL ?? protocolDefaults.openrouter.textModel,
      imageModel: this.env.OPENROUTER_IMAGE_MODEL ?? protocolDefaults.openrouter.imageModel,
      apiKey: this.env.OPENROUTER_API_KEY?.trim(), requiresKey: true, revision: 0, source: "environment",
    }];
  }
  async init() {
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw new Error("无法读取本地 API 设置文件。"); }
    try {
      const data = JSON.parse(raw);
      if (data.version === 2) {
        if (!Array.isArray(data.connections) || !data.connections.length || data.connections.length > 40) throw Error();
        this.profiles = data.connections.map((entry: ServerConnection) => {
          const key = entry.apiKey ?? (entry.id === legacyId && entry.source === "environment" ? this.env.OPENROUTER_API_KEY : undefined);
          const normalized = normalize({ ...entry, apiKey: key });
          return { ...normalized, revision: Number(entry.revision) || 0, source: entry.source === "environment" ? "environment" : "saved", updatedAt: entry.updatedAt };
        });
        if (new Set(this.profiles!.map(p => p.id)).size !== this.profiles!.length) throw Error();
        this.textDefault = data.defaultConnectionId; this.imageDefault = data.defaultImageConnectionId;
        this.resolve(this.textDefault, "text", false); this.resolve(this.imageDefault, "image", false);
      } else {
        const apiKey = keyValue(data.apiKey, "openrouter");
        this.profiles = [{ ...this.all()[0], apiKey, source: "saved", revision: 1, updatedAt: data.updatedAt }];
      }
      const legacy = this.all().find(p => p.id === legacyId);
      if (legacy?.apiKey) this.env.OPENROUTER_API_KEY = legacy.apiKey;
    } catch { throw new Error("本地 API 设置文件无效，请检查 .local/api-settings.json。"); }
  }
  snapshot() { return { profiles: structuredClone(this.all()), textDefault: this.textDefault, imageDefault: this.imageDefault }; }
  resolve(id?: string, kind: "text" | "image" = "text", requireReady = true): ServerConnection {
    const connection = this.all().find(p => p.id === (id || (kind === "image" ? this.imageDefault : this.textDefault)));
    if (!connection) throw new ApiSettingsError("绑定的 API 连接已不存在，请重新选择连接。");
    if (kind === "image" && connection.protocol === "anthropic") throw new ApiSettingsError("Anthropic 不能作为图片生成连接。");
    if (requireReady && connection.requiresKey && !connection.apiKey) throw new ApiSettingsError("连接尚未配置 API key，请打开 API 设置。");
    return structuredClone(connection);
  }
  status(): ApiSettingsStatus {
    const defaults = this.resolve(undefined, "text", false);
    const connections = this.all().map(({ apiKey, ...profile }) => ({
      ...profile, configured: !profile.requiresKey || Boolean(apiKey), keyHint: apiKey ? "••••" + (apiKey.length>4?' '+apiKey.slice(-4):'') : undefined,
    }));
    return { provider: defaults.protocol, configured: !defaults.requiresKey || Boolean(defaults.apiKey),
      keyHint: defaults.apiKey ? "••••"+(defaults.apiKey.length>4?' '+defaults.apiKey.slice(-4):'') : undefined,
      source: defaults.requiresKey && !defaults.apiKey ? "none" : defaults.source, updatedAt: defaults.updatedAt,
      connections, defaultConnectionId: this.textDefault, defaultImageConnectionId: this.imageDefault };
  }
  private transaction(change: (profiles: ServerConnection[]) => { profiles: ServerConnection[]; text?: string; image?: string }) {
    const task = this.writes.then(async () => {
      const changed = change(structuredClone(this.all()));
      const text = changed.text ?? this.textDefault, image = changed.image ?? this.imageDefault;
      const temporary = this.path + "." + randomUUID() + ".tmp";
      const stored = changed.profiles.map(p => p.source === "environment" ? { ...p, apiKey: undefined } : p);
      try {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, JSON.stringify({ version: 2, connections: stored, defaultConnectionId: text, defaultImageConnectionId: image }, null, 2), { flag: "wx", mode: 0o600 });
        await rename(temporary, this.path);
      } catch { throw new ApiSettingsError("API 设置保存失败，现有配置未修改。", 500); }
      finally { await rm(temporary, { force: true }).catch(() => {}); }
      this.profiles = changed.profiles; this.textDefault = text; this.imageDefault = image;
      const legacy = this.profiles.find(p => p.id === legacyId);
      if (legacy?.apiKey) this.env.OPENROUTER_API_KEY = legacy.apiKey;
      return this.status();
    });
    this.writes = task.catch(() => {}); return task;
  }
  save(value: unknown) {
    const key = keyValue(value, "openrouter");
    return this.upsert({ ...this.resolve(legacyId, "text", false), apiKey: key });
  }
  upsert(value: ConnectionDraft) {
    if(value?.id===this.imageDefault&&value.protocol==='anthropic')throw new ApiSettingsError('此连接仍是默认图片连接，请先更换默认图片连接。');
    // Validation is repeated inside the serialized write to avoid stale key reuse.
    normalize(value, value?.id ? this.all().find(p => p.id === value.id) : undefined);
    return this.transaction(profiles => {
      const previous = value.id ? profiles.find(p => p.id === value.id) : undefined;
      if (value.id && !previous) throw new ApiSettingsError("连接已不存在，请重新打开设置。");
      if (!previous && profiles.length >= 40) throw new ApiSettingsError("最多保存 40 个连接。");
      const connection = normalize(value, previous);
      const next = previous ? profiles.map(p => p.id === previous.id ? connection : p) : [...profiles, connection];
      const defaultReady = this.resolve(undefined, "text", false);
      const switchDefault = defaultReady.requiresKey && !defaultReady.apiKey;
      return { profiles: next, text: switchDefault ? connection.id : undefined,
        image: switchDefault && connection.protocol !== "anthropic" ? connection.id : undefined };
    });
  }
  defaults(text: string, image: string) {
    this.resolve(text, "text"); this.resolve(image, "image", false);
    return this.transaction(profiles => {
      if (!profiles.some(p => p.id === text) || !profiles.some(p => p.id === image && p.protocol !== "anthropic")) throw new ApiSettingsError("默认连接已不存在。");
      return { profiles, text, image };
    });
  }
  remove(id: string) {
    return this.transaction(profiles => {
      if (id === this.textDefault || id === this.imageDefault) throw new ApiSettingsError("请先更换默认连接，再删除。");
      if (!profiles.some(p => p.id === id)) throw new ApiSettingsError("连接不存在。");
      return { profiles: profiles.filter(p => p.id !== id) };
    });
  }
  async test(value?: unknown): Promise<ApiConnectionResult> {
    if (value && typeof value === "object") {
      const input = value as { connectionId?: string; draft?: ConnectionDraft; apiKey?: unknown };
      if (input.draft) {
        const previous = input.draft.id ? this.all().find(p => p.id === input.draft!.id) : undefined;
        return testProvider(normalize(input.draft, previous), this.request);
      }
      if (input.connectionId) return testProvider(this.resolve(input.connectionId), this.request);
      if (input.apiKey !== undefined) return this.test(input.apiKey);
    }
    const connection = this.resolve(undefined, "text", false);
    if (value !== undefined) connection.apiKey = keyValue(value, connection.protocol);
    if (connection.requiresKey && !connection.apiKey) throw new ApiSettingsError("尚未配置 API key，请先填写。");
    try { return await testProvider(connection, this.request); }
    catch (error) { if (error instanceof ProviderError) throw new ApiSettingsError(error.message, error.status === 401 ? 401 : 502); throw error; }
  }
}
export const apiSettings = new ApiSettingsStore();
export function apiSettingsRouter(store: ApiSettingsStore) {
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host ?? "");
    const localPeer = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
    if (!localHost || !localPeer) return res.status(403).json({ error: "API 设置仅允许本机访问。" });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: "不允许跨站访问 API 设置。" });
    if (req.method !== "GET" && (!req.is("application/json") || req.get("X-Paper-Studio-Settings") !== "1"))
      return res.status(403).json({ error: "请通过工作台修改 API 设置。" });
    next();
  });
  const action = (operation: (body: any) => Promise<unknown>) => async (req: any, res: any) => {
    try { res.json(await operation(req.body)); }
    catch (error) { const known = error instanceof ApiSettingsError || error instanceof ProviderError;
      res.status(known ? error.status : 500).json({ error: known ? error.message : "API 设置操作失败。" }); }
  };
  router.get("/", (_req, res) => res.json(store.status()));
  router.post("/", action(body => store.save(body?.apiKey)));
  router.post("/connections", action(body => store.upsert(body)));
  router.post("/defaults", action(body => store.defaults(body?.defaultConnectionId, body?.defaultImageConnectionId)));
  router.post("/remove", action(body => store.remove(body?.connectionId)));
  router.post("/test", action(body => store.test(body?.draft || body?.connectionId ? body : body?.apiKey)));
  return router;
}
