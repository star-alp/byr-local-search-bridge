/* 邮人全搜本地 Agent Bridge：仅监听本机回环地址，支持多 Agent 请求排队并转发版本化请求。 */

import http from "node:http";
import crypto from "node:crypto";
import process from "node:process";

const PROTOCOL_VERSION = 1;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 17832;
const REQUEST_TIMEOUT_MS = 30_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const ALLOWED_METHODS = new Set(["getCapabilities", "getStatus", "getContext", "getResourceUsage", "getFailures", "localSearch", "listTasks", "getTask", "previewSearch", "setRequestProfile", "listScopes", "listBoards", "startSearch", "getResults", "pauseSearch", "resumeSearch", "retrySearch", "cancelSearch"]);

function parseArgs(argv) {
  const [first, ...rest] = argv;
  const options = { command: first && !first.startsWith("-") ? first : "start" };
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

function integerOption(options, name, fallback, min, max) {
  const value = options[name] === undefined ? fallback : Number(options[name]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} 必须是 ${min}～${max} 的整数`);
  return value;
}

function tokenValue(value) {
  const token = value || crypto.randomBytes(24).toString("base64url");
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(token)) throw new Error("--token 必须是 16～128 位字母、数字、下划线或短横线");
  return token;
}

function jsonResponse(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  response.end(body);
}

function frameText(value) {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

function closeFrame() {
  return Buffer.from([0x88, 0]);
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      const longLength = buffer.readBigUInt64BE(offset + 2);
      if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket 消息过大");
      length = Number(longLength);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (offset + frameLength > buffer.length) break;
    let payloadStart = offset + headerLength;
    let payload = buffer.subarray(payloadStart + maskLength, payloadStart + maskLength + length);
    if (masked) {
      const mask = buffer.subarray(payloadStart, payloadStart + 4);
      payload = Buffer.from(payload);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    frames.push({ opcode, payload });
    offset += frameLength;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function socketError(socket) {
  socket.on("error", () => {});
  return socket;
}

function upgradeSocket(request, socket, head, role, token, state) {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (requestUrl.pathname !== "/agent" || requestUrl.searchParams.get("role") !== role || requestUrl.searchParams.get("token") !== token) {
    socket.destroy();
    return;
  }
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") { socket.destroy(); return; }
  const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socketError(socket);
  socket.setNoDelay(true);
  if (head?.length) socket.emit("data", head);

  if (role === "extension") {
    const previous = state.connections.extension;
    if (previous) {
      state.connections.extension = null;
      state.onClose("extension", previous);
      try { previous.write(closeFrame()); } catch {}
      previous.destroy();
    }
    state.connections.extension = socket;
  } else {
    state.connections.agents.add(socket);
    state.connections.agent = socket;
  }
  state.buffers.set(socket, Buffer.alloc(0));
  const send = (message) => { if (!socket.destroyed) socket.write(frameText(message)); };
  send.socket = socket;
  socket.on("data", (chunk) => {
    state.buffers.set(socket, Buffer.concat([state.buffers.get(socket) || Buffer.alloc(0), chunk]));
    let parsed;
    try { parsed = parseFrames(state.buffers.get(socket)); }
    catch { socket.destroy(); return; }
    state.buffers.set(socket, parsed.rest);
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x8) { socket.end(closeFrame()); return; }
      if (frame.opcode === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, frame.payload.length]), frame.payload])); continue; }
      if (frame.opcode !== 0x1) continue;
      let message;
      try { message = JSON.parse(frame.payload.toString("utf8")); }
      catch { send({ type: "error", code: "INVALID_MESSAGE", message: "Bridge 收到的消息不是有效 JSON" }); continue; }
      state.onMessage(role, message, send);
    }
  });
  socket.on("close", () => {
    state.buffers.delete(socket);
    if (role === "extension" && state.connections.extension === socket) {
      state.connections.extension = null;
      state.onClose(role, socket);
    } else if (role === "agent") {
      state.connections.agents.delete(socket);
      if (state.connections.agent === socket) state.connections.agent = [...state.connections.agents].at(-1) || null;
      state.onClose(role, socket);
    }
  });
  send({ type: "connected", protocolVersion: PROTOCOL_VERSION, role });
  state.onConnect(role);
}

function createBridgeServer({ host = DEFAULT_HOST, port = DEFAULT_PORT, token = tokenValue(), requestTimeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const state = {
    connections: { extension: null, agent: null, agents: new Set() },
    buffers: new Map(),
    pending: new Map(),
    requestQueue: [],
    requestSequence: 0,
    requestTimeoutMs: Math.max(1, Number(requestTimeoutMs) || REQUEST_TIMEOUT_MS),
    extensionBusy: false,
    onMessage: () => {},
    onConnect: () => {},
    onClose: () => {}
  };
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || host}`);
    if (requestUrl.pathname !== "/health") {
      jsonResponse(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "Bridge 地址不存在" } });
      return;
    }
    if (requestUrl.searchParams.get("token") !== token) {
      jsonResponse(response, 401, { ok: false, error: { code: "UNAUTHORIZED", message: "Bridge 令牌无效" } });
      return;
    }
    jsonResponse(response, 200, { ok: true, service: "byr-local-search-agent-bridge", protocolVersion: PROTOCOL_VERSION, extensionConnected: Boolean(state.connections.extension), agentConnected: state.connections.agents.size > 0, queuedRequests: state.requestQueue.length + state.pending.size, requestTimeoutMs: state.requestTimeoutMs });
  });
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || host}`);
    const role = requestUrl.searchParams.get("role");
    if (role !== "extension" && role !== "agent") { socket.destroy(); return; }
    upgradeSocket(request, socket, head, role, token, state);
  });
  const listen = () => new Promise((resolve, reject) => {
    const onError = (error) => { server.off("listening", onListening); reject(error); };
    const onListening = () => { server.off("error", onError); resolve(server.address()); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
  const close = () => new Promise((resolve) => {
    const sockets = [state.connections.extension, ...state.connections.agents];
    for (const socket of new Set(sockets)) if (socket && !socket.destroyed) socket.end(closeFrame());
    server.close(() => resolve());
  });
  return { server, state, host, port, token, listen, close };
}

function routeBridgeMessages(bridge) {
  const { state } = bridge;
  const extensionError = { ok: false, apiVersion: 1, error: { code: "EXTENSION_DISCONNECTED", message: "邮人全搜扩展连接已断开" } };
  const timeoutError = { ok: false, apiVersion: 1, error: { code: "EXTENSION_REQUEST_TIMEOUT", message: "扩展请求超时，Bridge 已释放队列；请稍后重试" } };
  const sendResponse = (socket, id, result) => {
    if (socket && !socket.destroyed) socket.write(frameText({ type: "response", id, result }));
  };
  const clearTimer = (request) => {
    if (request?.timer) {
      clearTimeout(request.timer);
      request.timer = null;
    }
  };
  const failQueued = (result) => {
    for (const request of state.requestQueue) sendResponse(request.socket, request.id, result);
    state.requestQueue.length = 0;
  };
  const timeoutRequest = (request) => {
    if (!state.pending.has(request.bridgeId)) return;
    state.pending.delete(request.bridgeId);
    clearTimer(request);
    // 本地查询没有副作用，允许超时请求单独失败，不影响正在进行的在线任务队列。
    if (request.parallel) {
      sendResponse(request.socket, request.id, timeoutError);
      return;
    }
    state.extensionBusy = false;
    sendResponse(request.socket, request.id, timeoutError);
    failQueued(timeoutError);
    const extension = state.connections.extension;
    if (extension) {
      state.connections.extension = null;
      try { extension.destroy(); } catch {}
    }
  };
  const dispatch = (request) => {
    state.pending.set(request.bridgeId, request);
    state.connections.extension.write(frameText({ type: "request", id: request.bridgeId, method: request.method, argument: request.argument }));
    request.timer = setTimeout(() => timeoutRequest(request), state.requestTimeoutMs);
  };
  const pump = () => {
    if (state.extensionBusy || !state.connections.extension) return;
    while (state.requestQueue.length) {
      const request = state.requestQueue.shift();
      if (!request.socket || request.socket.destroyed) continue;
      state.extensionBusy = true;
      dispatch(request);
      return;
    }
  };
  state.onConnect = (role) => {
    if (role === "extension") pump();
  };
  state.onClose = (role, socket) => {
    if (role === "extension") {
      for (const request of state.pending.values()) {
        clearTimer(request);
        sendResponse(request.socket, request.id, extensionError);
      }
      failQueued(extensionError);
      state.pending.clear();
      state.extensionBusy = false;
      return;
    }
    state.requestQueue = state.requestQueue.filter((request) => request.socket !== socket);
    for (const request of state.pending.values()) if (request.socket === socket) request.socket = null;
  };
  state.onMessage = (role, message, send) => {
    if (message.type === "hello") {
      send({ type: "hello", ok: true, protocolVersion: PROTOCOL_VERSION, extensionConnected: Boolean(state.connections.extension), agentConnected: state.connections.agents.size > 0, queuedRequests: state.requestQueue.length + state.pending.size, requestTimeoutMs: state.requestTimeoutMs });
      return;
    }
    if (role === "agent" && message.type === "request") {
      if (typeof message.id !== "string" || !message.id || typeof message.method !== "string" || !ALLOWED_METHODS.has(message.method)) {
        send({ type: "response", id: message.id || "", result: { ok: false, apiVersion: 1, error: { code: "INVALID_REQUEST", message: "Bridge 请求的方法或标识无效" } } });
        return;
      }
      if (!state.connections.extension) {
        send({ type: "response", id: message.id, result: { ok: false, apiVersion: 1, error: { code: "EXTENSION_NOT_CONNECTED", message: "邮人全搜扩展尚未连接，请先在浏览器打开带 Bridge 参数的扩展页面" } } });
        return;
      }
      const request = { bridgeId: `bridge-${Date.now().toString(36)}-${++state.requestSequence}`, socket: send.socket || state.connections.agent, id: message.id, method: message.method, argument: message.argument };
      if (message.method === "localSearch") {
        // 本地索引查询只读内存和 IndexedDB，可与在线搜索或其他 Agent 查询并行发送。
        request.parallel = true;
        dispatch(request);
        return;
      }
      state.requestQueue.push(request);
      pump();
      return;
    }
    if (role === "extension" && message.type === "response") {
      if (typeof message.id !== "string" || !state.pending.has(message.id)) return;
      const request = state.pending.get(message.id);
      state.pending.delete(message.id);
      clearTimer(request);
      if (!request.parallel) state.extensionBusy = false;
      sendResponse(request.socket, request.id, message.result);
      if (!request.parallel) pump();
    }
  };
}

function cliHelp() {
  return `邮人全搜 Agent Bridge（Node.js 22 或更高版本）\n\n用法：\n  node agent-bridge.mjs start [--port 17832] [--token <令牌>]\n  node agent-bridge.mjs health --port 17832 --token <令牌>\n\n说明：Bridge 只监听 127.0.0.1；支持多个 Agent 连接。在线搜索与任务控制按顺序处理，只读 localSearch 可并行执行；单个请求默认 30 秒超时。\n`;
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(cliHelp()); return null; }
  const command = options.command || "start";
  const port = integerOption(options, "port", DEFAULT_PORT, 1024, 65535);
  const token = tokenValue(options.token);
  if (command === "health") {
    const response = await fetch(`http://${DEFAULT_HOST}:${port}/health?token=${encodeURIComponent(token)}`);
    process.stdout.write(`${await response.text()}\n`);
    return null;
  }
  if (command !== "start") throw new Error(`无法识别命令：${command}`);
  const bridge = createBridgeServer({ port, token });
  routeBridgeMessages(bridge);
  const address = await bridge.listen();
  process.stdout.write(`${JSON.stringify({ ok: true, service: "byr-local-search-agent-bridge", protocolVersion: PROTOCOL_VERSION, host: address.address, port: address.port, token, websocket: `ws://${DEFAULT_HOST}:${address.port}/agent` })}\n`);
  const stop = async () => { await bridge.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return bridge;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { message: error.message || "Bridge 启动失败" } })}\n`);
    process.exitCode = 1;
  });
}

export { PROTOCOL_VERSION, REQUEST_TIMEOUT_MS, createBridgeServer, frameText, parseArgs, parseFrames, routeBridgeMessages, tokenValue };
