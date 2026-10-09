import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import express from "express";
import { ApiSettingsStore, apiSettingsPath, apiSettingsRouter } from "../../server/api-settings";

const key = "sk-or-v1-" + "test-only-credential".repeat(3);
const other = "sk-or-v1-" + "replacement-fixture".repeat(3);
async function temporary(t: TestContext) {
  const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, "paper-studio-settings-"));
  t.after(async () => {
    assert.equal(dirname(root), parent);
    assert.ok(root.startsWith(join(parent, "paper-studio-settings-")));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test("API settings fall back to environment, mask credentials, persist and reload without touching .env", async t => {
  const root = await temporary(t), env = { OPENROUTER_API_KEY: key }, path = join(root, "api-settings.json");
  const settings = new ApiSettingsStore(path, env);
  await settings.init();
  assert.equal(settings.status().source, "environment");
  assert.ok(!JSON.stringify(settings.status()).includes(key));
  const saved = await settings.save(other);
  assert.equal(saved.source, "saved");
  assert.equal(env.OPENROUTER_API_KEY, other);
  assert.equal(JSON.parse(await readFile(path, "utf8")).connections[0].apiKey, other);
  assert.deepEqual(await readdir(root), ["api-settings.json"]);
  const restartedEnv = { OPENROUTER_API_KEY: key }, restarted = new ApiSettingsStore(path, restartedEnv);
  await restarted.init();
  assert.equal(restartedEnv.OPENROUTER_API_KEY, other);
  assert.deepEqual(restarted.status(), saved);
});

test("API settings reject malformed input without replacing a valid key", async t => {
  const root = await temporary(t), env = { OPENROUTER_API_KEY: key }, settings = new ApiSettingsStore(join(root, "api-settings.json"), env);
  for (const value of [undefined, null, "", "not-a-key", key + "\nInjected: header", 17, key.repeat(10)])
    assert.throws(() => settings.save(value), /有效/);
  assert.equal(env.OPENROUTER_API_KEY, key);
  assert.deepEqual(await readdir(root), []);
  await settings.save(" " + other + "\n");
  assert.equal(env.OPENROUTER_API_KEY, other);
});

test("concurrent saves keep the persisted key and runtime key consistent", async t => {
  const root = await temporary(t), env = {}, path = join(root, "api-settings.json");
  const settings = new ApiSettingsStore(path, env);
  await Promise.all([settings.save(key), settings.save(other)]);
  assert.equal((env as NodeJS.ProcessEnv).OPENROUTER_API_KEY, other);
  assert.equal(JSON.parse(await readFile(path, "utf8")).connections[0].apiKey, other);
});

test("read-only connectivity testing uses the key endpoint, never changes configuration or returns raw provider data", async t => {
  const root = await temporary(t), env = { OPENROUTER_API_KEY: key }, calls: { url: string; auth: string }[] = [];
  const mock = (async (url, options) => {
    calls.push({ url: String(url), auth: (options!.headers as Record<string, string>).Authorization });
    return Response.json({ data: { label: other, key: other, limit_remaining: 4.25 } });
  }) as typeof fetch;
  const settings = new ApiSettingsStore(join(root, "api-settings.json"), env, mock);
  const result = await settings.test(other);
  assert.deepEqual(calls, [{ url: "https://openrouter.ai/api/v1/key", auth: "Bearer " + other }]);
  assert.equal(result.ok, true); assert.equal(result.limitRemaining, 4.25);
  assert.ok(!JSON.stringify(result).includes(other));
  assert.equal(env.OPENROUTER_API_KEY, key);
  assert.deepEqual(await readdir(root), []);
  await settings.test(); assert.equal(calls[1].auth, "Bearer " + key);
});

test("connection failures and unexpected upstream bodies do not disclose secrets", async t => {
  const root = await temporary(t), path = join(root, "api-settings.json");
  for (const code of [401, 403, 429, 500]) {
    const mock = (async () => Response.json({ error: { message: key } }, { status: code })) as typeof fetch;
    await assert.rejects(new ApiSettingsStore(path, { OPENROUTER_API_KEY: key }, mock).test(), error => {
      assert.ok(!(error as Error).message.includes(key)); return true;
    });
  }
  const networkError = (async () => { throw Error("Authorization: Bearer " + key); }) as typeof fetch;
  await assert.rejects(new ApiSettingsStore(path, { OPENROUTER_API_KEY: key }, networkError).test(), /网络/);
  const empty = (async () => Response.json({ data: null })) as typeof fetch;
  await assert.rejects(new ApiSettingsStore(path, { OPENROUTER_API_KEY: key }, empty).test(), /无法识别/);
  const management = (async () => Response.json({ data: { is_management_key: true } })) as typeof fetch;
  await assert.rejects(new ApiSettingsStore(path, { OPENROUTER_API_KEY: key }, management).test(), /管理用/);
  await assert.rejects(new ApiSettingsStore(path, {}).test(), /尚未配置/);
});

test("test configuration is isolated from both formal credentials and manuscript exports", () => {
  const cwd = resolve("settings-location-fixture");
  assert.equal(apiSettingsPath({}, cwd), join(cwd, ".local", "api-settings.json"));
  assert.equal(apiSettingsPath({ PAPER_TEST_MODE: "1", PAPER_TEST_ROOT: join("outputs", "test", "settings") }, cwd),
    join(cwd, "outputs", "test", "settings", "api-settings.json"));
});

test("corrupt saved configuration fails without printing the stored credential", async t => {
  const root = await temporary(t), path = join(root, "api-settings.json");
  await writeFile(path, JSON.stringify({ apiKey: "invalid-" + key }));
  await assert.rejects(new ApiSettingsStore(path, {}).init(), error => {
    assert.ok(!(error as Error).message.includes(key)); return true;
  });
});

test("settings HTTP routes require local host, same origin and explicit JSON mutation headers", async t => {
  const root = await temporary(t), env = { OPENROUTER_API_KEY: key };
  const app = express(); app.use(express.json());
  app.use("/api/settings", apiSettingsRouter(new ApiSettingsStore(join(root, "api-settings.json"), env)));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(done => server.once("listening", done));
  t.after(() => new Promise<void>((done, fail) => server.close(error => error ? fail(error) : done())));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const status = await fetch(base + "/api/settings");
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.ok(!(await status.text()).includes(key));
  const body = JSON.stringify({ apiKey: other });
  assert.equal((await fetch(base + "/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403);
  const headers = { "Content-Type": "application/json", "X-Paper-Studio-Settings": "1" };
  assert.equal((await fetch(base + "/api/settings", { method: "POST", headers: { ...headers, Origin: "https://external.example" }, body })).status, 403);
  const rebindingStatus = await new Promise<number | undefined>((done, fail) => {
    const request = httpRequest(base + "/api/settings", { headers: { Host: "external.example" } }, response => {
      response.resume(); response.once("end", () => done(response.statusCode));
    });
    request.once("error", fail); request.end();
  });
  assert.equal(rebindingStatus, 403);
  assert.equal(env.OPENROUTER_API_KEY, key);
  const saved = await fetch(base + "/api/settings", { method: "POST", headers: { ...headers, Origin: base }, body });
  assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes(other));
  assert.equal(env.OPENROUTER_API_KEY, other);
});
