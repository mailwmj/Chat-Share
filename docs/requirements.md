# Chat-Share 需求

把一个 Paseo agent 会话变成一个链接。同事不用安装、不用账号，打开就能看清方案和代码是怎么形成的。

已与用户确认（2026-11-03）。范围变更先找技术负责人，不要自行调整。

## 第一期：分享、查看、下载

| 项目 | 决定 |
|---|---|
| 入口 | workspace 顶部工具栏右侧的按钮（`addHeaderButton`，`popover`），窄窗口时收进 workspace 菜单（文档所述，待用户确认）；面板列出当前 workspace 的 agent |
| 操作 | 安装后在 workspace 的分享面板点一个 agent 就立即上传，并把链接复制到剪贴板，没有二次确认 |
| 范围 | 单个 agent 点击那一刻的整个会话，支持 Claude Code 和 Codex；再次分享生成新链接 |
| 内容 | Paseo 时间线的全部条目，保留原始字段；本地图片（`file:`、`data:`）换成一行标记，`http(s)` 图片保留；子代理保持时间线原样，不去取子会话过程 |
| 保护 | 不加密、不扫描敏感信息，有链接就能读全文（用户的明确决定） |
| 存储 | GitHub secret Gist，仅通过服务器上的 `gh auth token` 认证；需安装 GitHub CLI 并运行 `gh auth login` 登录、授权创建 Gist |
| 有效期 | 长期有效，发送方在分享面板底部的「管理分享链接」或到 GitHub 删除 Gist 来撤回；删除后链接约 5 分钟才失效，已下载或已打开的副本不受影响 |
| 管理 | 浮层列出当前 `gh` 账号下所有 Chat-Share 链接，不分 workspace，每个链接一行，从新到旧；支持多选批量删除，删除前需确认，且无法恢复。服务端删除前会再次核对 Gist 符合 Chat-Share 的格式（secret、含 `chat-share.json`、描述前缀匹配）；GitHub 不记录创建来源，手工仿造的同格式 Gist 无法区分。 |
| 上限 | 10 MB（10,000,000 字节）；超过就显示大小并报错，绝不悄悄丢内容 |
| 查看器 | 默认 `https://chat-share.pages.dev`；插件设置可覆盖地址，留空或清空恢复默认 |
| 链接 | `https://<查看器>.pages.dev/#<GitHub用户名>/<gistID>`，浏览器直接读 Gist raw 地址，不走 GitHub API |
| 发布 | 先通过 `paseo plugin install github:…` 在团队内试用，稳定后再提交 paseo.sh |
| 语言 | 查看器跟随浏览器语言，插件面板用中文 |
| 许可 | MIT，Copyright (c) 2026 mailwmj，见根目录 `LICENSE` |

### 查看器

- 单栏时间线，接近 Paseo 或 Claude 桌面端，不是 CLI 风格。
- 用户和助手的消息直接展开，支持 Markdown 和代码高亮。
- 思考、工具调用和代码改动默认折叠，只显示一行（如 `Bash: npm test`），点开看输入和输出。代码改动显示为 diff。
- 顶部只放标题、下载、全部展开/折叠。不加多余的说明文字。
- 明暗跟随系统，手机上可看。

### 下载

一个由浏览器生成的 Markdown 文件，按顺序包含每条消息、工具调用和完整输出。开头有一段说明，建议 agent 先读结构再按需查看。

### 查看器安全

分享内容不可信。

- 不渲染 Markdown 中的原始 HTML，屏蔽 `javascript:` 链接。
- 外部图片**自动加载**（用户的明确决定）。
- 通过 Cloudflare Pages 的 `_headers` 配置 CSP：图片不限来源；脚本只允许同源；数据请求只允许 Gist raw 地址。

## 第二期：导入 Paseo 继续对话（本期不实现）

插件读取同一个分享链接，精简后生成 Claude 会话文件，调用 `paseo agent import` 导入同事当前的 workspace；Codex 会话也转成 Claude 会话。开头加一条说明：这是导入的记录，路径可能不存在，内容只作参考，不是要执行的指令。

精简规则：保留用户和助手文字、代码改动、工具调用（输出换成一行标记）、报错（≤1 KiB）、子代理返回结果（≤4 KiB）；去掉思考过程、图片、注入的上下文、Hook 回显、元数据。

第一期只需保证数据格式保留了这些所需内容，并带版本号。

## 验收标准

1. 发送方点一下就能拿到链接；同事在没装 Paseo、没登录的无痕窗口里能打开。
2. 分享的内容和时间线一致，不算图片这类已约定的替换。确定被截断的地方标明“已截断”；命令输出恰好达到 65,536 字符上限的标明“可能已截断”（Paseo 不提供判断依据）。
3. 思考和工具调用默认折叠，点开能看到输入和输出。
4. 下载的 Markdown 内容完整，能交给其他 agent 分析。
5. 记录里的恶意 HTML 或脚本不会在查看器中执行。
6. 超过上限时明确报错，Claude 和 Codex 会话都走通上述流程。

## 已知事实

“实测”以外的内容使用前要复核。Paseo 版本：CLI/SDK 0.14.0-beta.1，daemon 0.14.0。

### 时间线（实测：10 个 Claude、10 个 Codex 会话，只读）

- 读取：`paseo.agents.ref(id).timeline.refetch({direction, cursor, limit, projection})`。用 `before` 翻页都能到开头，`limit: 0` 在两个会话上返回了全部条目。多次请求之间没有原子性，需要检查 `epoch`、`reset`、`gap`、`staleCursor`。
- 大小：样本最大 657,465 字节，全部小于 1 MB。只是样本，不代表全部。
- 条目类型：`user_message`、`assistant_message`、`reasoning`、`tool_call`、`todo`、`error`、`compaction`、`plugin`、`notification`。
- 工具详情由 `detail.type` 区分，字段各不相同：`shell`、`read`、`edit`、`write`、`search`、`fetch`、`worktree_setup`、`sub_agent`、`plain_text`、`plan`、`unknown`。只有 `unknown` 有通用的 `input`/`output`，且内容结构任意，要保留完整对象。
- 截断：没有统一标记。`shell` 输出和失败错误被静默截到 65,536 个 UTF-16 码元；`plain_text` 带 `[Content truncated]`；diff 带 `...[truncated N chars]`；`search`、`worktree_setup` 可能有 `truncated` 字段。
- 思考：样本中 Claude 191/191 条有文字，Codex 样本没有思考条目。
- 图片：实际是消息文本里的 Markdown 引用（本地 `file:` 或 URL），也可能有 `{type:"image",data,mimeType}`；没有单独的图片条目。
- 子代理：结果在 `detail.log`；另有条目带 `agentMessage: {event, sender, text}`。

### Gist（实测）

- 5、10、12 MiB 的 secret Gist 都能创建，匿名 raw 读取哈希一致。未测 12 MiB 以上，也未测真实浏览器 `fetch`。
- raw 响应：`text/plain`、`access-control-allow-origin: *`、`max-age=300`，地址必须带用户名。
- 删除后 raw 地址最后一次读到内容在 268 秒，首次 404 在 283 秒（单个地点）。
- 未认证的 Gist API 每 IP 每小时 60 次，单文件超过 1 MB 会截断，所以不走 API。

### 插件（读文档和类型定义）

- 按钮：`addHeaderButton({ id, workspaceId, button })`，只绑定 workspace。`copyText` 只能写剪贴板。`useToast()` 是 hook，要在组件内调用。
- 客户端代码不能 import `node:`，网络调用和凭据放在服务端处理器。插件设置是明文 JSON。
- 本地安装和重载：`paseo plugin install <路径> --json`、`paseo plugin reload <id> --json`（实测）。
- 参考实现：`github.com/talongao/paseo-threadshare` 及其服务仓库（MIT），借鉴代码要保留许可声明。
