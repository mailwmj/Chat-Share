# AGENTS.md

本文件为协助开发 Chat-Share 项目的 AI 代理（Agents）及开发者提供运维与架构指引。

---

## 1. 架构边界与部署机制

Chat-Share 包含两个独立运行但共享逻辑的子系统：

| 子系统 | 涵盖目录 | 运行环境 | 生效与部署方式 |
| :--- | :--- | :--- | :--- |
| **Paseo 插件端** | `client/`, `server/`, `index.client.tsx`, `index.server.ts`, `paseo-plugin.json` | 运行于本地 Paseo Daemon 与桌面/Web 客户端 | 通过 `git push` 发布，或在本地通过 `paseo plugin reload` / `paseo plugin install` 生效。 |
| **会话查看器前端** | `viewer/`, `shared/` | 托管在 **Cloudflare Pages** 上的纯静态单页应用（生产域名：`https://chat-share.pages.dev`） | **无 GitHub 自动部署 Webhook**。只要修改了前端代码，仅 `git push` 到 GitHub 是**不会生效**的，必须执行 Wrangler 部署命令。 |

---

## 2. 哪些改动必须重新部署到 Cloudflare Pages？

凡是涉及查看器页面视觉、交互、渲染与解析逻辑的改动，均必须重新部署到 Cloudflare Pages：

1. **`viewer/` 目录下的任何修改**：
   - `viewer/src/render.ts`（时间线渲染、折叠/展开、图标切换等）；
   - `viewer/src/style.css`（主题、布局、排版、样式规则等）；
   - `viewer/src/main.ts`、`viewer/src/load.ts`、`viewer/src/markdown.ts`、`viewer/src/i18n.ts`；
   - `viewer/index.html`、`viewer/public/_headers`（CSP 策略配置）；
   - `viewer/vite.config.ts`。
2. **`shared/` 共享模块下的修改**（被 `viewer/` 引用）：
   - `shared/tools.ts`（工具摘要与标签格式化）；
   - `shared/convert.ts`（会话数据结构转换）；
   - `shared/download.ts`（Markdown 下载文件生成逻辑）；
   - `shared/format.ts`（数据类型定义与常量）。

> 💡 **提示**：如果仅修改了 `client/`（Paseo 工具栏弹窗）或 `server/`（Paseo Gist 上传逻辑），则无需部署 Cloudflare Pages。

---

## 3. 查看器部署流程与标准命令

完成代码修改后，务必遵循以下步骤进行验证、编译和部署：

### 步骤 1：质量检查与单元测试
```bash
npm run typecheck
npm test
```

### 步骤 2：编译生产包
构建产物将输出至 `viewer/dist/`：
```bash
npm run build
```

### 步骤 3：部署到 Cloudflare Pages
通过 Wrangler 将构建产物部署到生产环境（绑定 `chat-share` 项目与 `main` 分支）：
```bash
npx --yes wrangler pages deploy viewer/dist --project-name chat-share --branch main
```

### 步骤 4：线上验证
部署完成后，可以通过 curl 验证生产环境是否已加载最新编译哈希的 JS/CSS 资源：
```bash
curl -s https://chat-share.pages.dev | grep -o 'assets/index-[^"]*'
```

---

## 4. 关键规范与注意事项

- **CSP 安全规范**：Cloudflare Pages 部署包含严格的 CSP（见 `viewer/public/_headers`）。测试查看器改动时，确保运行浏览器测试（`npm run test:browser`），避免引入内联样式或违规资源脚本。
- **本地端到端预览**：可在部署前运行 `npm run preview`，在 `http://127.0.0.1:4173/?preview=design#local-preview/00000000000000000000000000000001` 本地预览完整的 CSP 与生产构建表现。
- **隐私边界**：`.local/` 目录存放本地实测提取的真实会话，**严禁**复制到 fixtures 中或提交到 Git 仓库。
