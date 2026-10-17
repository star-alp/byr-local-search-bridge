/* 邮人全搜 Agent Bridge 回归测试：验证本机回环 WebSocket 的鉴权与请求转发。 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const TOKEN = "0123456789abcdef0123456789abcdef";

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return socket;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "agent-cli.mjs"), ...args], { encoding: "utf8" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("Agent Bridge 只转发已认证的扩展请求并返回结果", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  const agent = await openSocket(`ws://127.0.0.1:${port}/agent?role=agent&token=${TOKEN}`);
  const extensionMessages = [];
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    extensionMessages.push(message);
    if (message.type === "request") extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, method: message.method, argument: message.argument } }));
  });
  agent.send(JSON.stringify({ type: "request", id: "request-1", method: "getStatus", argument: undefined }));
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bridge 请求超时")), 1000);
    agent.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "response" || message.id !== "request-1") return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  assert.deepEqual(response.result, { ok: true, apiVersion: 1, method: "getStatus" });
  assert.equal(extensionMessages.some((message) => message.type === "request" && message.method === "getStatus"), true);
  const health = await (await fetch(`http://127.0.0.1:${port}/health?token=${TOKEN}`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.extensionConnected, true);
  assert.equal(health.agentConnected, true);
  agent.send(JSON.stringify({ type: "request", id: "request-invalid", method: "readCookies" }));
  const invalid = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bridge 未拒绝未知方法")), 1000);
    agent.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "response" || message.id !== "request-invalid") return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  assert.equal(invalid.result.error.code, "INVALID_REQUEST");
  extension.close();
  agent.close();
  await bridge.close();
});

test("Agent CLI 可以通过 Bridge 调用扩展 API", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "request") extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, bridge: true } }));
  });
  const result = await runCli(["capabilities", "--transport", "bridge", "--port", String(port), "--token", TOKEN]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).bridge, true);
  extension.close();
  await bridge.close();
});

test("Agent Bridge 转发新的上下文和任务控制方法", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "request") extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, method: message.method } }));
  });
  const result = await runCli(["context", "--transport", "bridge", "--port", String(port), "--token", TOKEN]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).method, "getContext");
  const tasks = await runCli(["tasks", "--transport", "bridge", "--port", String(port), "--token", TOKEN]);
  assert.equal(tasks.code, 0, tasks.stderr);
  assert.equal(JSON.parse(tasks.stdout).method, "listTasks");
  const guide = await runCli(["guide", "--transport", "bridge", "--port", String(port), "--token", TOKEN, "--query", "课程资料"]);
  assert.equal(guide.code, 0, guide.stderr);
  assert.equal(JSON.parse(guide.stdout).method, "getGuide");
  const task = await runCli(["task", "--transport", "bridge", "--port", String(port), "--token", TOKEN, "--search-id", "task-1"]);
  assert.equal(task.code, 0, task.stderr);
  assert.equal(JSON.parse(task.stdout).method, "getTask");
  const pause = await runCli(["pause", "--transport", "bridge", "--port", String(port), "--token", TOKEN, "--search-id", "search-1"]);
  assert.equal(pause.code, 0, pause.stderr);
  assert.equal(JSON.parse(pause.stdout).method, "pauseSearch");
  const profile = await runCli(["request-profile", "--transport", "bridge", "--port", String(port), "--token", TOKEN, "--profile", "high"]);
  assert.equal(profile.code, 0, profile.stderr);
  assert.equal(JSON.parse(profile.stdout).method, "setRequestProfile");
  extension.close();
  await bridge.close();
});

test("Agent Bridge 支持多个 Agent 连接并按顺序处理请求", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  const agentA = await openSocket(`ws://127.0.0.1:${port}/agent?role=agent&token=${TOKEN}`);
  const agentB = await openSocket(`ws://127.0.0.1:${port}/agent?role=agent&token=${TOKEN}`);
  const methods = [];
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "request") return;
    methods.push(message.method);
    const delay = methods.length === 1 ? 50 : 0;
    setTimeout(() => extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, method: message.method } })), delay);
  });
  const request = (socket, id, method) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bridge 多 Agent 请求超时")), 1000);
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "response" || message.id !== id) return;
      clearTimeout(timer);
      resolve(message.result);
    });
    socket.send(JSON.stringify({ type: "request", id, method }));
  });
  const [resultA, resultB] = await Promise.all([request(agentA, "agent-a", "getStatus"), request(agentB, "agent-b", "getContext")]);
  assert.equal(resultA.method, "getStatus");
  assert.equal(resultB.method, "getContext");
  assert.deepEqual(methods, ["getStatus", "getContext"]);
  const health = await (await fetch(`http://127.0.0.1:${port}/health?token=${TOKEN}`)).json();
  assert.equal(health.agentConnected, true);
  assert.equal(health.queuedRequests, 0);
  extension.close();
  agentA.close();
  agentB.close();
  await bridge.close();
});

test("Agent CLI 只对幂等读取请求自动重试临时断线", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const cliModule = await import("../agent-cli.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  let reads = 0;
  let starts = 0;
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "request") return;
    if (message.method === "getStatus") {
      reads += 1;
      extension.send(JSON.stringify({ type: "response", id: message.id, result: reads === 1
        ? { ok: false, apiVersion: 1, error: { code: "EXTENSION_DISCONNECTED", message: "模拟扩展重连" } }
        : { ok: true, apiVersion: 1, method: message.method } }));
    }
    if (message.method === "startSearch") {
      starts += 1;
      extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: false, apiVersion: 1, error: { code: "EXTENSION_DISCONNECTED", message: "模拟扩展重连" } } }));
    }
  });
  const client = cliModule.connectBridge(port, TOKEN);
  const status = await client.request("getStatus");
  assert.equal(status.method, "getStatus");
  assert.equal(reads, 2);
  await assert.rejects(() => client.request("startSearch", { query: "test" }), /模拟扩展重连/u);
  assert.equal(starts, 1);
  client.close();
  extension.close();
  await bridge.close();
});

test("Agent Bridge 请求超时会释放当前请求和排队请求", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN, requestTimeoutMs: 25 });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  const agent = await openSocket(`ws://127.0.0.1:${port}/agent?role=agent&token=${TOKEN}`);
  extension.addEventListener("message", () => {});
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Bridge 超时响应未返回")), 1000);
    agent.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "response" || message.id !== "timeout-1") return;
      clearTimeout(timer);
      resolve(message.result);
    });
  });
  agent.send(JSON.stringify({ type: "request", id: "timeout-1", method: "getStatus" }));
  const result = await response;
  assert.equal(result.error.code, "EXTENSION_REQUEST_TIMEOUT");
  const health = await (await fetch(`http://127.0.0.1:${port}/health?token=${TOKEN}`)).json();
  assert.equal(health.queuedRequests, 0);
  assert.equal(health.extensionConnected, false);
  agent.close();
  extension.close();
  await bridge.close();
});

test("Agent CLI 的 ask 会自动启动搜索、等待完成并返回结果", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "request") return;
    if (message.method === "startSearch") extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, searchId: "search-1", running: true } }));
    if (message.method === "getResults") extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, searchId: "search-1", running: false, hasMore: false, nextCursor: null, total: 1, items: [{ id: "thread:Study:1", type: "thread", title: "课程资料", url: "https://bbs.byr.cn/article/Study/1" }] } }));
    if (message.method === "getStatus") extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, searchId: "search-1", status: "complete", running: false } }));
    if (message.method === "localSearch") extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, mode: "local", index: { documents: 8, lastUpdatedAt: 1234 }, total: 1, results: [{ id: "local:1", title: "本地资料" }] } }));
  });
  const result = await runCli(["ask", "--transport", "bridge", "--port", String(port), "--token", TOKEN, "--query", "课程资料", "--limit", "1"]);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.total, 1);
  assert.equal(output.results[0].title, "课程资料");
  const streamed = await runCli(["ask", "--transport", "bridge", "--port", String(port), "--token", TOKEN, "--query", "课程资料", "--limit", "1", "--stream"]);
  assert.equal(streamed.code, 0, streamed.stderr);
  const events = streamed.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].type, "result");
  assert.equal(events[0].schemaVersion, 1);
  assert.equal(events.at(-1).type, "done");
  const formatted = await runCli(["ask", "--transport", "bridge", "--port", String(port), "--token", TOKEN, "--query", "课程资料", "--limit", "1", "--format", "jsonl"]);
  assert.equal(formatted.code, 0, formatted.stderr);
  assert.equal(JSON.parse(formatted.stdout.trim().split("\n").at(-1)).type, "done");
  const local = await runCli(["ask", "--transport", "bridge", "--port", String(port), "--token", TOKEN, "--query", "本地资料", "--mode", "local", "--limit", "1"]);
  assert.equal(local.code, 0, local.stderr);
  assert.equal(JSON.parse(local.stdout).mode, "local");
  assert.equal(JSON.parse(local.stdout).index.documents, 8);
  const auto = await runCli(["ask", "--transport", "bridge", "--port", String(port), "--token", TOKEN, "--query", "本地资料", "--mode", "auto", "--limit", "1"]);
  assert.equal(auto.code, 0, auto.stderr);
  const autoOutput = JSON.parse(auto.stdout);
  assert.equal(autoOutput.mode, "auto");
  assert.equal(autoOutput.auto.onlineStarted, false);
  extension.close();
  await bridge.close();
});

test("Agent Bridge 允许多个本地查询并行，不阻塞在线请求队列", async () => {
  const bridgeModule = await import("../agent-bridge.mjs");
  const bridge = bridgeModule.createBridgeServer({ port: 0, token: TOKEN });
  bridgeModule.routeBridgeMessages(bridge);
  await bridge.listen();
  const port = bridge.server.address().port;
  const extension = await openSocket(`ws://127.0.0.1:${port}/agent?role=extension&token=${TOKEN}`);
  const agent = await openSocket(`ws://127.0.0.1:${port}/agent?role=agent&token=${TOKEN}`);
  const received = [];
  extension.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type !== "request") return;
    received.push(message.method);
    setTimeout(() => extension.send(JSON.stringify({ type: "response", id: message.id, result: { ok: true, apiVersion: 1, method: message.method } })), 25);
  });
  const request = (id, method) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("并行本地查询超时")), 1000);
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "response" || message.id !== id) return;
      clearTimeout(timer);
      agent.removeEventListener("message", onMessage);
      resolve(message.result);
    };
    agent.addEventListener("message", onMessage);
    agent.send(JSON.stringify({ type: "request", id, method, argument: { query: id } }));
  });
  const [first, second, online] = await Promise.all([request("local-a", "localSearch"), request("local-b", "localSearch"), request("online-status", "getStatus")]);
  assert.equal(first.method, "localSearch");
  assert.equal(second.method, "localSearch");
  assert.equal(online.method, "getStatus");
  assert.deepEqual(received, ["localSearch", "localSearch", "getStatus"]);
  agent.close();
  extension.close();
  await bridge.close();
});
