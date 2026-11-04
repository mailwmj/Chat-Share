# Chat-Share

[English](README.md) · **简体中文**

把一个 [Paseo](https://paseo.sh) agent 会话变成一个链接。同事不用安装、不用账号，打开就能看清方案和代码是怎么形成的。

Chat-Share 由一个 Paseo 插件和一个静态查看器组成。插件把 Claude Code 或 Codex 会话的完整快照上传到 **GitHub secret Gist**，并复制查看器链接；托管在 [chat-share.pages.dev](https://chat-share.pages.dev) 的查看器直接在浏览器里读取这个 Gist。

- 从 workspace 顶部工具栏一键得到链接。
- 完整时间线：消息、思考、工具调用、代码改动和报错，保留原始字段。
- 单栏阅读器，支持 Markdown 和代码高亮。思考和工具调用默认折叠为一行；带大纲、明暗主题和手机布局。
- 可把任意分享下载为单个 Markdown 文件，方便交给其他 agent 分析。
- 可选加密，密码由系统生成 6 位数字。
- 查看器把分享内容视为不可信：不渲染原始 HTML，屏蔽 `javascript:` 链接，严格 CSP。
- 支持简体中文和英文，都跟随宿主语言。

## 安装

运行 Paseo daemon 的机器需要：

- Paseo 0.14.0 及以上（含 0.14.0 预发布版）
- Node.js 和 npm
- [GitHub CLI](https://cli.github.com)（`gh`），已用 `gh auth login` 登录并授权创建 Gist

```sh
paseo plugin install github:mailwmj/Chat-Share
```

服务端通过 `gh auth token` 认证。插件不保存凭据，也不会把凭据发给客户端。

使用自己的查看器：打开 **设置 → 插件 → Chat-Share**，填入查看器地址并保存。留空则使用 `https://chat-share.pages.dev`。

## 使用

点击任意 workspace 顶部工具栏的 **分享**（窄窗口在 **··· → 分享会话**）。弹窗按标签页顺序列出未归档的 agent。

| 状态 | 该行的操作 |
| :--- | :--- |
| 从未分享，或会话之后有变化 | **分享**：创建新快照并复制链接 |
| 会话与上次快照一致 | **复制链接**；旁边的菜单有 **重新分享** 和 **重新加密分享** |

- 再次分享会生成新快照，旧链接内容不变。
- 重命名会话不会让快照过期。
- **管理分享链接** 列出当前 `gh` 账号下所有 Chat-Share Gist，从新到旧，支持批量删除；也可以直接到 GitHub 删除 Gist。删除后缓存的内容约 5 分钟才失效。
- 上限为 **10,000,000 字节**。超过就显示大小并报错，绝不悄悄丢内容。

### 加密分享

行内菜单的 **加密分享** 会用系统生成的 6 位数字密码加密快照（PBKDF2-SHA256，1,000,000 次迭代，AES-256-GCM），标题也一并加密。复制时链接下方会带上密码，读者必须先输入密码才能看到任何内容。

这能让内容在 GitHub 上不可读，也能挡住只拿到链接的人，但**不是强保护**：

- 连链接带密码一起转发的人都能读全文。需要时请删掉密码那一行，单独发送。
- 没有服务端限制尝试次数，拿到链接的人可以离线穷举全部一百万种密码：单核 CPU 约 50 小时，GPU 可能只要几分钟。不要用它保护机密。
- 把明文会话改为加密分享，不影响之前的明文链接，需要手动去 GitHub 删除那些 Gist。

daemon 把每个密码明文保存在 `$PASEO_HOME/plugin-data/chat-share/share-passwords.json`（默认 `~/.paseo`，仅所有者可读），所以重启后仍能复制。在没有该文件的机器上无法复制链接，按钮会变成 **加密分享**。

## 开发

```sh
npm ci --ignore-scripts
npm run typecheck      # 查看器与插件，两个 tsconfig 项目
npm test               # vitest，11 个文件
npm run build          # 查看器 -> viewer/dist
npm run preview        # 生产构建 + 生产 CSP，监听 127.0.0.1:4173
npm run test:browser   # 对 preview 运行 Playwright，需要 Google Chrome
npm run dev            # Vite 开发服务器，带本地 JSON 文件选择器
```

从本地目录安装插件（不会执行清单里的安装步骤，请先自己运行 `npm ci`）：

```sh
paseo plugin install /absolute/path/to/Chat-Share
paseo plugin reload chat-share
```

预览地址（预览工具向未修改的生产查看器提供合成的分享数据，不访问 GitHub）：

```text
http://127.0.0.1:4173/?preview=design#local-preview/00000000000000000000000000000001
```

其他 `preview=` 取值：`locked`、`malicious`、`benchmark`、`invalid`、`oversized`、`deleted`、`failure`。`claude` 和 `codex` 读取你自己的 `.local/claude.json` / `.local/codex.json`（已加入 gitignore，是 Chat-Share 格式的 JSON）；这两个文件不存在时，Playwright 测试会跳过对应用例。

架构、约定和部署流程见 [AGENTS.md](AGENTS.md)。

## 分享格式

每个分享是 secret Gist 中的一个文件 `chat-share.json`。查看器链接为 `https://<查看器>/#<GitHub 用户名>/<gist ID>`。查看器不带凭据读取 `https://gist.githubusercontent.com/<用户名>/<id>/raw/chat-share.json`，从不调用 GitHub API。

- **版本 1**：会话元数据、来源 epoch 与窗口，以及保留原始字段的全部时间线条目。唯一的替换是本地图片（`file:`、`data:`），换成一行标记；`http(s)` 图片保留。
- **版本 2**：用 AES-GCM 信封包裹一个版本 1 文档。
- 未知条目类型以折叠的通用行显示。
- 只有 Paseo 提供依据时才标注截断（`[Content truncated]`、`...[truncated N chars]`、`truncated: true`）；shell 输出恰好达到 65,536 个 UTF-16 码元时标为“可能已截断”。

## 安全模型

- 分享内容不可信。Markdown 渲染时禁用 HTML 并限制链接协议。
- 外部图片自动加载（有意的决定）。
- [`viewer/public/_headers`](viewer/public/_headers) 配置 CSP：脚本和样式仅同源，数据请求仅允许 `gist.githubusercontent.com`，`frame-ancestors 'none'`。
- 默认分享不加密也不扫描敏感信息：有链接就能读全文。

## 许可

[MIT](LICENSE) © 2026 mailwmj
