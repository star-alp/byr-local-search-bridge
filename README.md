# 邮人全搜 Agent Bridge / CLI

这个仓库让支持终端的本地 AI 通过命令行使用“邮人全搜”浏览器扩展。Bridge 只监听本机 `127.0.0.1`，把 Agent 的结构化请求转发给已经打开的扩展页面。

## 环境要求

- Node.js 22 或更高版本。
- Chrome 中已经安装“邮人全搜”扩展。
- 论坛登录和扩展页面使用同一个 Chrome 用户配置。

## 小白用户：只需要让 AI 执行两步

在扩展的“AI 协助”窗口点击“复制给 AI”，把提示词交给本地 AI。AI 应先在本仓库目录执行：

```bash
node agent-cli.mjs setup --url "扩展 Agent 页面地址"
node agent-cli.mjs doctor
```

`setup` 会自动启动 Bridge、记住本机配置，并尝试在安装扩展的 Chrome 用户配置中打开正确页面。用户不需要手动填写端口或令牌。`doctor` 会检查 Bridge、扩展 WebSocket 和 Agent API 是否都已准备好。

连接成功后，Agent 可以先执行一次：

```bash
node agent-cli.mjs guide --pretty
```

`guide` 会一次返回当前连接、已选版面、索引数量、请求强度、正在进行的任务和推荐下一步命令。它是 Agent 接手扩展时的首选入口；`doctor` 成功时也会附带同样的引导信息。

## 最常用的搜索命令

```bash
# 推荐：先查本地索引，结果不足时由 AI 决定是否补充在线搜索
node agent-cli.mjs ask --query "关键词" --mode auto --scope last-used --limit 20 --pretty

# 完全只查本地索引，不访问论坛，适合多个 Agent 并行查询
node agent-cli.mjs ask --query "关键词" --mode local --scope last-used --limit 20 --pretty

# 从论坛在线读取，结果会边读取边返回，新内容自动增量写入扩展本地索引
node agent-cli.mjs ask --query "关键词" --mode online --scope last-used --limit 20 --pretty
```

`auto` 当前是“本地优先”的明确策略：CLI 先返回本地命中，并告诉 Agent 是否建议再执行 `online`。这样多个查询不会同时占用论坛请求；需要在线更新时再单独启动一个在线任务。

## 连接诊断和状态

```bash
node agent-cli.mjs capabilities
node agent-cli.mjs status
node agent-cli.mjs context
node agent-cli.mjs resources
node agent-cli.mjs failures
node agent-cli.mjs tasks
```

- `capabilities`：查看扩展支持的 API 和参数。
- `status`：查看当前搜索状态和进度。
- `context`：查看当前范围、登录状态和任务摘要。
- `resources`：查看本地索引、缓存和请求资源。
- `failures`：查看失败请求。
- `tasks`：查看最近任务的轻量摘要。

## 范围、预览和请求强度

```bash
node agent-cli.mjs boards --query "学习"
node agent-cli.mjs scopes
node agent-cli.mjs preview --query "关键词" --scope last-used
node agent-cli.mjs request-profile --profile high
```

搜索可以使用 `--scope last-used`、`--scope recommended` 或 `--scope saved:<范围 ID>`。也可以用 `--boards 版面1,版面2` 指定版面。页数和日期范围参数与扩展页面一致，例如 `--board-pages 3`、`--thread-pages 2`、`--time-range 30d`。

请求预设有 `stable`（省资源）、`fast`（平衡）和 `high`（极速）。大范围在线读取时，建议先用 `preview` 查看请求量，再决定是否提高强度。

## 在线任务控制和增量结果

```bash
node agent-cli.mjs status
node agent-cli.mjs results --limit 20
node agent-cli.mjs pause --search-id "搜索标识"
node agent-cli.mjs resume --search-id "搜索标识"
node agent-cli.mjs retry --search-id "搜索标识"
node agent-cli.mjs cancel --search-id "搜索标识"
```

在线搜索可以使用 `--stream` 输出 JSONL 增量事件。每条结果包含主题或回帖类型、版面、作者、摘要、命中类型和原文链接；CLI 不返回论坛密码、Cookie 或完整网页正文。

## 返回格式

普通输出是一个 JSON 对象，主要字段包括：

- `ok`：调用是否成功。
- `searchId`：在线任务标识。
- `summary`：状态、命中数量、失败数量。
- `results`：搜索结果数组。
- `index`：本地索引条数及最近更新时间。

需要脚本逐条处理时使用 `--format jsonl` 或 `--stream`。结果游标只在当前扩展页面和当前搜索中有效，刷新或切换搜索后应重新读取。

## Windows、macOS 和 Linux

所有平台都使用同一组 Node.js 命令。`setup` 会自动寻找安装扩展的 Chrome 用户配置：

- macOS：通过 Chrome AppleScript 优先复用已打开的浏览器。
- Windows：寻找 Google Chrome 的用户数据目录并打开对应 profile。
- Linux：寻找 Google Chrome、Chromium 的用户数据目录和可执行文件。

如果系统权限或浏览器策略阻止自动打开页面，直接在已安装扩展的 Chrome 用户配置中打开扩展 Agent 页面，然后再次执行 `doctor` 即可。

## 安全边界

- Bridge 只绑定 `127.0.0.1`，不接受局域网连接。
- 扩展主动连接 Bridge；Bridge 不读取浏览器密码、Cookie 或其他标签页内容。
- 只读诊断请求会自动重试；启动、暂停、继续和重试任务不会自动重复执行。
- 配置保存在当前用户的本地配置目录，普通用户不需要查看或手动编辑它。
