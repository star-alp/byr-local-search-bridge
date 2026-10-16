/* 邮人全搜本地 Agent CLI：支持调试 Chrome 和本机 Agent Bridge 两种连接方式，并提供预览、控制和增量输出。 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";

const AGENT_GLOBAL = "__BYR_LOCAL_SEARCH_AGENT_V1__";
const DEFAULT_BRIDGE_PORT = 17832;
const CONFIG_FILE_NAME = "bridge.json";

function configFilePath() {
  const base = process.platform === "win32"
    ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "byr-local-search", CONFIG_FILE_NAME);
}

function readBridgeConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(configFilePath(), "utf8"));
    if (!value || typeof value !== "object") return null;
    return value;
  } catch {
    return null;
  }
}

function writeBridgeConfig(value) {
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function bridgeUrl(url, port, token) {
  const target = new URL(url);
  target.searchParams.set("agent", "1");
  target.searchParams.set("api", "1");
  target.searchParams.set("action", "configure");
  target.searchParams.set("bridge", "1");
  target.searchParams.set("bridgePort", String(port));
  target.searchParams.set("bridgeToken", token);
  target.searchParams.set("stream", "1");
  return target.toString();
}

function baseExtensionUrl(url) {
  if (!url) return "";
  const target = new URL(url);
  for (const key of ["bridge", "bridgePort", "bridgeToken"]) target.searchParams.delete(key);
  return target.toString();
}

async function bridgeHealth(port, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health?token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(800) });
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, ...body, ok: Boolean(response.ok && body?.ok) };
  } catch (error) {
    return { status: 0, ok: false, error: error.message || "Bridge 暂不可访问" };
  }
}

async function waitForBridge(port, token, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await bridgeHealth(port, token);
    if (latest.ok) return latest;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return latest || { ok: false, status: 0, error: "Bridge 启动超时" };
}

function startBridgeProcess(port, token) {
  const bridgeFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-bridge.mjs");
  const child = spawn(process.execPath, [bridgeFile, "start", "--port", String(port), "--token", token], {
    cwd: path.dirname(bridgeFile),
    detached: true,
    stdio: "ignore"
  });
  child.unref();
}

function processString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function runProcess(command, args, detached = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached, stdio: detached ? "ignore" : ["ignore", "ignore", "pipe"] });
    child.once("error", reject);
    if (detached) {
      child.once("spawn", () => { child.unref(); resolve(); });
      return;
    }
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} 返回状态 ${code}`)));
  });
}

async function openUrl(url) {
  if (process.platform === "darwin" && url.startsWith("chrome-extension://")) {
    const extensionPrefix = url.slice(0, url.indexOf("/search.html") + 1);
    const script = `tell application "Google Chrome"
activate
set targetWindow to missing value
repeat with currentWindow in windows
  repeat with currentTab in tabs of currentWindow
    if ((URL of currentTab) starts with ${processString(extensionPrefix)}) then
      set targetWindow to contents of currentWindow
      exit repeat
    end if
  end repeat
  if targetWindow is not missing value then exit repeat
end repeat
if targetWindow is missing value then set targetWindow to front window
tell targetWindow to make new tab with properties {URL:${processString(url)}}
end tell`;
    try {
      await runProcess("osascript", ["-e", script]);
      return;
    } catch {
      // AppleScript 未获授权时退回系统默认打开方式。
    }
  }
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  await runProcess(command, args, true);
}

function bridgeCredentials(options) {
  const saved = readBridgeConfig() || {};
  const port = numberOption(options, "port", saved.port || DEFAULT_BRIDGE_PORT, 1024, 65535);
  const token = String(options.token || saved.token || "");
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(token)) throw new Error("尚未配置 Bridge 令牌，请先运行 node agent-cli.mjs setup");
  return { port, token, saved };
}

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const options = { command: first && !first.startsWith("-") ? first : "capabilities" };
  const values = first && !first.startsWith("-") ? rest : argv;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") { options.help = true; continue; }
    if (!value.startsWith("--")) throw new Error(`无法识别参数：${value}`);
    const equal = value.indexOf("=");
    const key = equal >= 0 ? value.slice(2, equal) : value.slice(2);
    if (!key) throw new Error("参数名称不能为空");
    if (equal >= 0) options[key] = value.slice(equal + 1);
    else if (values[index + 1] && !values[index + 1].startsWith("--")) options[key] = values[++index];
    else options[key] = true;
  }
  return options;
}

function numberOption(options, name, fallback, min, max) {
  const value = options[name] === undefined ? fallback : Number(options[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} 必须是 ${min}～${max} 的整数`);
  return value;
}

function cliHelp() {
  return `邮人全搜 Agent CLI（Node.js 22 或更高版本）

用法：
  node agent-cli.mjs setup --url "<扩展 Agent 页面 URL>"
  node agent-cli.mjs doctor
  node agent-cli.mjs ask --query "<关键词>"
  node agent-cli.mjs preview --query "<关键词>"
  node agent-cli.mjs context
  node agent-cli.mjs capabilities [--port 9222]
  node agent-cli.mjs capabilities --transport bridge --port 17832 --token <令牌>
  node agent-cli.mjs search --query "<关键词>" [--mode online] [--scope last-used] [--wait]
  node agent-cli.mjs status [--port 9222]
  node agent-cli.mjs results [--cursor <游标>] [--limit 20]
  node agent-cli.mjs scopes | boards [--query <版面名称或 ID>]
  node agent-cli.mjs cancel --search-id <搜索标识>
  node agent-cli.mjs pause --search-id <搜索标识>
  node agent-cli.mjs resume --search-id <搜索标识>
  node agent-cli.mjs retry --search-id <搜索标识>

常用参数：
  --port 9222       Chrome DevTools Protocol 本地端口
  --transport bridge 使用本地 Agent Bridge；默认使用 CDP
  --token <令牌>    Agent Bridge 启动时输出的连接令牌
  --url <扩展 URL>  没有已打开的搜索页时尝试新建扩展页面
  --wait            搜索命令等待完成并输出最终结果
  --no-open         setup 不自动打开扩展页面
  --pretty          美化 JSON 输出
  --stream          搜索时逐条输出新增结果，最后输出 done 事件
  --query <关键词>  搜索关键词；请使用引号包住包含空格的内容

小白用户推荐：先让 AI 执行 setup，再使用 ask；端口、令牌和轮询过程会自动处理。
`;
}

function output(value, pretty = false) {
  process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

async function listTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`无法读取 Chrome 调试目标（HTTP ${response.status}）`);
  return response.json();
}

async function openTarget(port, url) {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Chrome 未允许通过调试接口打开扩展页面（HTTP ${response.status}）`);
  return response.json();
}

async function findTarget(port, url) {
  let targets = await listTargets(port);
  const matches = (target) => target.type === "page"
    && target.webSocketDebuggerUrl
    && (url ? target.url === url : /\/search\.html(?:\?|$)/u.test(target.url || ""));
  let target = targets.find(matches);
  if (!target && url) {
    target = await openTarget(port, url);
  }
  if (!target) throw new Error("未找到邮人全搜搜索页；请先打开扩展页面，或用 --url 提供扩展 URL");
  return target;
}

function blockedExtensionPageMessage(page, targetUrl) {
  if (!targetUrl?.startsWith("chrome-extension://")) return "";
  const text = String(page?.bodyText || "");
  if (page?.href !== "chrome-error://chromewebdata/" && !/ERR_BLOCKED_BY_CLIENT/u.test(text)) return "";
  return "当前调试 Chrome 未安装或未启用邮人全搜扩展；CLI 连接到的 Chrome 用户配置与扩展所在配置不同。请在同一个 Chrome 用户配置中安装/加载扩展，并从启动时开启调试端口的浏览器运行 CLI；不要直接在地址栏打开 chrome-extension:// 地址。";
}

function connectDebugger(url) {
  if (typeof WebSocket !== "function") throw new Error("当前 Node.js 没有内置 WebSocket，请使用 Node.js 22 或更高版本");
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("无法连接 Chrome 调试目标")), { once: true });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message || "Chrome 调试命令失败"));
    else callback.resolve(message);
  });
  socket.addEventListener("close", () => {
    for (const callback of pending.values()) callback.reject(new Error("Chrome 调试连接已关闭"));
    pending.clear();
  });
  return {
    async evaluate(expression) {
      await ready;
      const id = ++nextId;
      const response = await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      const result = response.result?.result;
      if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text || "扩展页面执行失败");
      if (result?.subtype === "error") throw new Error(result.description || "扩展页面执行失败");
      return result?.value;
    },
    close() { socket.close(); }
  };
}

function connectBridge(port, token) {
  if (typeof WebSocket !== "function") throw new Error("当前 Node.js 没有内置 WebSocket，请使用 Node.js 22 或更高版本");
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(String(token || ""))) throw new Error("Bridge 需要有效的 --token");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/agent?role=agent&token=${encodeURIComponent(token)}`);
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", role: "agent", protocolVersion: 1 }));
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => reject(new Error(`无法连接本地 Agent Bridge（127.0.0.1:${port}）`)), { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type !== "response" || !message.id) return;
    const callback = pending.get(message.id);
    if (!callback) return;
    pending.delete(message.id);
    callback(message.result);
  });
  socket.addEventListener("close", () => {
    for (const callback of pending.values()) callback({ ok: false, error: { message: "本地 Agent Bridge 连接已关闭" } });
    pending.clear();
  });
  return {
    async request(method, argument) {
      await ready;
      const id = `${Date.now().toString(36)}-${++nextId}`;
      const result = await new Promise((resolve) => {
        pending.set(id, resolve);
        socket.send(JSON.stringify({ type: "request", id, method, argument }));
      });
      if (!result?.ok) throw new Error(result?.error?.message || `${method} 调用失败`);
      return result;
    },
    close() { socket.close(); }
  };
}

async function invoke(debuggerClient, method, argument) {
  const encoded = argument === undefined ? "undefined" : JSON.stringify(argument);
  const expression = `(async()=>{const agent=globalThis[${JSON.stringify(AGENT_GLOBAL)}];if(!agent)return {ok:false,error:{code:"AGENT_UNAVAILABLE",message:"当前 Chrome 页面没有加载邮人全搜 Agent API，请确认扩展已安装在同一个 Chrome 用户配置中，并重新加载扩展页面"}};return await agent[${JSON.stringify(method)}](${encoded});})()`;
  const result = await debuggerClient.evaluate(expression);
  if (!result?.ok) throw new Error(result?.error?.message || `${method} 调用失败`);
  return result;
}

async function invokeClient(client, method, argument) {
  if (client.request) return client.request(method, argument);
  return invoke(client, method, argument);
}

function searchOptions(options) {
  const fields = ["query", "mode", "scope", "boardPages", "threadPages", "timeRange", "dateFrom", "dateTo", "persist", "confirm"];
  const result = {};
  for (const field of fields) {
    const flag = field.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
    if (options[field] !== undefined) result[field] = options[field];
    else if (options[flag] !== undefined) result[field] = options[flag];
  }
  if (options.boards !== undefined) result.boards = String(options.boards).split(",").map((name) => name.trim()).filter(Boolean);
  for (const field of ["persist", "confirm"]) if (result[field] !== undefined) result[field] = result[field] === true || result[field] === "1" || result[field] === "true";
  for (const field of ["boardPages", "threadPages"]) if (result[field] !== undefined) result[field] = result[field] === "all" ? null : Number(result[field]);
  return result;
}

function applyChanges(results, items) {
  for (const item of items) {
    if (item.operation === "remove") results.delete(item.id);
    else results.set(item.id, item);
  }
}

async function waitForResults(client, start, options) {
  const results = new Map();
  let cursor;
  let latest;
  const limit = numberOption(options, "limit", 100, 1, 100);
  while (true) {
    const page = await invokeClient(client, "getResults", { ...(cursor ? { cursor } : {}), limit });
    latest = page;
    const items = page.items || [];
    applyChanges(results, items);
    cursor = page.nextCursor;
    if (options.stream) {
      items.forEach((item) => output({ type: item.operation === "remove" ? "remove" : "result", searchId: page.searchId, total: page.total, item }, false));
    }
    if (options.progress) process.stderr.write(`搜索状态：${page.status} · 已找到 ${page.total} 条\n`);
    if (!page.running && !page.hasMore) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const status = await invokeClient(client, "getStatus");
  const resultLimit = options.resultLimit === undefined ? undefined : numberOption(options, "resultLimit", 20, 1, 100);
  const items = [...results.values()];
  return { ok: true, searchId: start.searchId || latest.searchId, status, total: results.size, results: resultLimit ? items.slice(0, resultLimit) : items };
}

async function runCommand(client, options) {
  if (options.command === "search" || options.command === "ask") {
    if (options.command === "ask" && !String(options.query || "").trim()) throw new Error("ask 需要 --query 搜索关键词");
    const start = await invokeClient(client, "startSearch", searchOptions(options));
    if (options.command === "ask" || options.wait || options.watch) {
      const waitOptions = options.command === "ask" ? { ...options, resultLimit: options.limit === undefined ? 20 : Number(options.limit) } : options;
      const result = await waitForResults(client, start, waitOptions);
      if (options.stream) output({ type: "done", ...result }, false);
      else output(result, options.pretty);
    }
    else output(start, options.pretty);
    return;
  }
  if (options.command === "results") {
    const limit = numberOption(options, "limit", 20, 1, 100);
    output(await invokeClient(client, "getResults", { ...(options.cursor ? { cursor: options.cursor } : {}), limit }), options.pretty);
    return;
  }
  if (options.command === "cancel") {
    if (!options["search-id"]) throw new Error("cancel 需要 --search-id");
    output(await invokeClient(client, "cancelSearch", { searchId: options["search-id"] }), options.pretty);
    return;
  }
  if (["pause", "resume", "retry"].includes(options.command)) {
    if (!options["search-id"]) throw new Error(`${options.command} 需要 --search-id`);
    const method = { pause: "pauseSearch", resume: "resumeSearch", retry: "retrySearch" }[options.command];
    output(await invokeClient(client, method, { searchId: options["search-id"] }), options.pretty);
    return;
  }
  if (options.command === "preview") {
    if (!String(options.query || "").trim()) throw new Error("preview 需要 --query 搜索关键词");
    output(await invokeClient(client, "previewSearch", searchOptions(options)), options.pretty);
    return;
  }
  const methods = { capabilities: "getCapabilities", status: "getStatus", context: "getContext", scopes: "listScopes", boards: "listBoards" };
  const method = methods[options.command];
  if (!method) throw new Error(`无法识别命令：${options.command}`);
  const argument = options.command === "boards" && options.query ? { query: options.query } : undefined;
  output(await invokeClient(client, method, argument), options.pretty);
}

async function runSetup(options) {
  const saved = readBridgeConfig() || {};
  const explicitPort = options.port !== undefined;
  const initialPort = numberOption(options, "port", saved.port || DEFAULT_BRIDGE_PORT, 1024, 65535);
  const token = String(options.token || saved.token || newToken());
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(token)) throw new Error("--token 必须是 16～128 位字母、数字、下划线或短横线");
  const requestedUrl = options.url || saved.extensionUrl || "";
  let selected = null;
  let lastHealth;
  for (let offset = 0; offset <= 10; offset += 1) {
    const port = initialPort + offset;
    if (port > 65535) break;
    lastHealth = await bridgeHealth(port, token);
    if (lastHealth.ok) { selected = { port, health: lastHealth, reused: true }; break; }
    if (lastHealth.status === 401 && explicitPort) throw new Error(`端口 ${port} 已有其他 Bridge，令牌不匹配；请更换 --port 或提供正确的 --token`);
    if (lastHealth.status === 401) continue;
    startBridgeProcess(port, token);
    const health = await waitForBridge(port, token);
    if (health.ok) { selected = { port, health, reused: false }; break; }
    lastHealth = health;
  }
  if (!selected) throw new Error(`无法启动本地 Bridge：${lastHealth?.error || `端口 ${initialPort} 不可用`}`);
  const extensionUrl = requestedUrl ? baseExtensionUrl(requestedUrl) : saved.extensionUrl || "";
  const openedUrl = extensionUrl ? bridgeUrl(extensionUrl, selected.port, token) : "";
  const configPath = writeBridgeConfig({ port: selected.port, token, extensionUrl, updatedAt: new Date().toISOString() });
  let opened = false;
  if (openedUrl && !options["no-open"]) {
    await openUrl(openedUrl);
    opened = true;
    selected.health = await waitForBridge(selected.port, token, 5000);
  }
  return {
    ok: true,
    ready: Boolean(selected.health.extensionConnected),
    service: "byr-local-search-agent-bridge",
    transport: "bridge",
    port: selected.port,
    tokenSaved: true,
    reused: selected.reused,
    extensionPageOpened: opened,
    extensionConnected: Boolean(selected.health.extensionConnected),
    configPath,
    message: selected.health.extensionConnected
      ? "扩展已连接，AI 可以直接使用 ask 搜索"
      : (opened ? "扩展页面已打开，请等待 Agent 连接" : (extensionUrl ? "Bridge 已启动；请打开扩展页面以完成连接" : "Bridge 已启动；请提供扩展页面 URL 以完成连接"))
  };
}

async function runDoctor(options) {
  const credentials = bridgeCredentials(options);
  const health = await bridgeHealth(credentials.port, credentials.token);
  const result = {
    ok: false,
    ready: false,
    transport: "bridge",
    port: credentials.port,
    checks: { config: Boolean(credentials.saved.token), bridge: Boolean(health.ok), extension: false, api: false },
    extensionConnected: Boolean(health.extensionConnected),
    message: ""
  };
  if (!health.ok) {
    result.message = health.status === 401 ? "Bridge 令牌不匹配，请重新运行 setup 或检查 --token" : "无法连接 Bridge，请先运行 node agent-cli.mjs setup";
    return result;
  }
  result.checks.extension = Boolean(health.extensionConnected);
  if (!health.extensionConnected) {
    result.message = "Bridge 正常，但扩展尚未连接；请打开 setup 输出的扩展页面";
    return result;
  }
  const client = connectBridge(credentials.port, credentials.token);
  try {
    const capabilities = await client.request("getCapabilities");
    result.checks.api = Boolean(capabilities.ok && capabilities.ready);
  } catch (error) {
    result.message = error.message || "无法调用扩展 Agent API";
    return result;
  } finally {
    client.close();
  }
  result.ok = result.ready = result.checks.api;
  result.message = result.ready ? "Bridge、扩展和 Agent API 均已连接" : "扩展已连接，但 Agent API 尚未准备好";
  return result;
}

async function run(options) {
  if (options.help) { process.stdout.write(cliHelp()); return; }
  if (options.command === "setup") { output(await runSetup(options), options.pretty); return; }
  if (options.command === "doctor") {
    let result;
    try { result = await runDoctor(options); }
    catch (error) { result = { ok: false, ready: false, checks: { config: false, bridge: false, extension: false, api: false }, message: error.message || "诊断失败" }; }
    output(result, options.pretty);
    return result.ready ? 0 : 1;
  }
  const bridgeCommands = new Set(["ask", "preview", "context", "pause", "resume", "retry"]);
  const transport = options.transport || (bridgeCommands.has(options.command) ? "bridge" : "cdp");
  if (!["cdp", "bridge"].includes(transport)) throw new Error("--transport 只能是 cdp 或 bridge");
  if (transport === "bridge") {
    const credentials = bridgeCredentials(options);
    const client = connectBridge(credentials.port, credentials.token);
    try { await runCommand(client, options); }
    finally { client.close(); }
    return;
  }
  const port = numberOption(options, "port", 9222, 1, 65535);
  const target = await findTarget(port, options.url);
  const client = connectDebugger(target.webSocketDebuggerUrl);
  try {
    const page = await client.evaluate("({href: location.href, bodyText: document.body?.innerText?.slice(0, 500) || \"\"})");
    const blockedMessage = blockedExtensionPageMessage(page, target.url);
    if (blockedMessage) throw new Error(blockedMessage);
    await runCommand(client, options);
  } finally {
    client.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    const exitCode = await run(parseArgs(argv));
    if (Number.isInteger(exitCode)) process.exitCode = exitCode;
  } catch (error) {
    output({ ok: false, error: { message: error.message || "CLI 调用失败" } });
    process.exitCode = 1;
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirect) main();

export { applyChanges, blockedExtensionPageMessage, bridgeUrl, configFilePath, connectBridge, invokeClient, parseArgs, runDoctor, searchOptions, waitForResults };
