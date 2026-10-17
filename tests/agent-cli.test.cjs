/* 邮人全搜 Agent CLI 回归测试：验证命令解析、参数转换和增量结果合并。 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

test("Agent CLI 帮助信息可直接从 Node.js 输出", () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const result = spawnSync(process.execPath, [file, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Chrome DevTools Protocol/);
  assert.match(result.stdout, /node agent-cli\.mjs search/);
  assert.match(result.stdout, /node agent-cli\.mjs setup/);
  assert.match(result.stdout, /node agent-cli\.mjs doctor --fix/);
  assert.match(result.stdout, /node agent-cli\.mjs guide/);
  assert.match(result.stdout, /node agent-cli\.mjs ask/);
});

test("setup 会生成带 Bridge 参数的扩展页面地址", async () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const { bridgeUrl, parseArgs } = await import(`file://${file}`);
  const parsed = parseArgs(["setup", "--url", "chrome-extension://example/search.html?agent=1&api=1"]);
  assert.equal(parsed.command, "setup");
  const url = new URL(bridgeUrl(parsed.url, 17832, "0123456789abcdef0123456789abcdef"));
  assert.equal(url.searchParams.get("bridge"), "1");
  assert.equal(url.searchParams.get("bridgePort"), "17832");
  assert.equal(url.searchParams.get("agent"), "1");
  assert.equal(url.searchParams.get("api"), "1");
});

test("Agent CLI 将命令参数转换为扩展 API 参数", async () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const { parseArgs, searchOptions } = await import(`file://${file}`);
  const parsed = parseArgs(["search", "--query", "<关键词>", "--mode=online", "--board-pages", "all", "--persist", "1", "--boards", "A,B"]);
  assert.equal(parsed.command, "search");
  assert.deepEqual(searchOptions(parsed), { query: "<关键词>", mode: "online", boardPages: null, persist: true, boards: ["A", "B"] });
});

test("Agent CLI 合并 upsert 和 remove 增量结果", async () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const { applyChanges } = await import(`file://${file}`);
  const results = new Map([["a", { id: "a", title: "旧标题" }]]);
  applyChanges(results, [{ id: "a", operation: "upsert", title: "新标题" }, { id: "b", operation: "upsert", title: "新增" }]);
  assert.equal(results.get("a").title, "新标题");
  assert.equal(results.size, 2);
  applyChanges(results, [{ id: "a", operation: "remove" }]);
  assert.deepEqual([...results.keys()], ["b"]);
});

test("Agent CLI 对未安装扩展的调试 Chrome 给出中文诊断", async () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const { blockedExtensionPageMessage, parseArgs } = await import(`file://${file}`);
  assert.equal(parseArgs(["capabilities", "--port", "9222", "--url", "chrome-extension://<扩展ID>/search.html"]).url, "chrome-extension://<扩展ID>/search.html");
  assert.match(blockedExtensionPageMessage({ href: "chrome-error://chromewebdata/", bodyText: "ERR_BLOCKED_BY_CLIENT" }, "chrome-extension://<扩展ID>/search.html"), /未安装或未启用邮人全搜扩展/u);
  assert.equal(blockedExtensionPageMessage({ href: "chrome-extension://<扩展ID>/search.html", bodyText: "" }, "chrome-extension://<扩展ID>/search.html"), "");
});

test("Agent CLI 支持选择本地 Bridge 传输", async () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const { AGENT_COMMANDS, parseArgs } = await import(`file://${file}`);
  const parsed = parseArgs(["status", "--transport", "bridge", "--port", "17832", "--token", "0123456789abcdef0123456789abcdef"]);
  assert.equal(parsed.transport, "bridge");
  assert.equal(parsed.port, "17832");
  assert.equal(parsed.token, "0123456789abcdef0123456789abcdef");
  assert.equal(AGENT_COMMANDS.has("resources"), true);
  assert.equal(AGENT_COMMANDS.has("failures"), true);
  assert.equal(AGENT_COMMANDS.has("request-profile"), true);
  assert.equal(AGENT_COMMANDS.has("guide"), true);
});

test("Agent CLI 能从 Windows 和 Linux Chrome 配置目录识别扩展所在 profile", async () => {
  const file = path.join(__dirname, "..", "agent-cli.mjs");
  const { chromeProfileRoots, findInstalledChromeProfile, extensionIdFromUrl } = await import(`file://${file}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "byr-profile-"));
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const profile = path.join(temp, "Profile 7");
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, "Preferences"), JSON.stringify({ extensions: { settings: { [extensionId]: { path: "/extension" } } } }));
  assert.equal(extensionIdFromUrl(`chrome-extension://${extensionId}/search.html`), extensionId);
  assert.equal(chromeProfileRoots("win32", { LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local" }, "C:\\Users\\demo").some((item) => item.includes("Google")), true);
  assert.equal(chromeProfileRoots("linux", { XDG_CONFIG_HOME: "/tmp/config" }, "/home/demo").includes("/tmp/config/google-chrome"), true);
  assert.equal(findInstalledChromeProfile(`chrome-extension://${extensionId}/search.html`, { roots: [temp] }).profileDirectory, "Profile 7");
  fs.rmSync(temp, { recursive: true, force: true });
});
