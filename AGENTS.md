# AGENTS.md

本文件为协助开发 Chat-Share 项目的 AI 代理（Agents）及开发者提供运维与架构指引。

---

## 1. 架构边界与部署机制

Chat-Share 包含两个独立运行但共享逻辑的子系统：

| 子系统 | 涵盖目录 | 运行环境 | 生效与部署方式 |
| :--- | :--- | :--- | :--- |
| **Paseo 插件端** | `client/`, `server/`, `index.client.tsx`, `index.server.ts`, `paseo-plugin.json` | 运行于本地 Paseo Daemon 与桌面/Web 客户端 | 通过 `git push` 发布，或在本地通过 `paseo plugin reload` / `paseo plugin install` 生效。 |
| **会话查看器前端** | `viewer/`, `shared/` | 托管在 **Cloudflare Pages** 上的纯静态单页应用（生产域名：`https://chat-share.pages.dev`） | **已配置 GitHub Actions 自动部署**（`.github/workflows/deploy-pages.yml`）。当推送到 `main` 时会自动运行测试、构建并部署到生产环境；无需本地手动部署。 |

---

## 2. 哪些改动会触发/需要重新部署到 Cloudflare Pages？

凡是涉及查看器页面视觉、交互、渲染与解析逻辑的改动，均需部署到 Cloudflare Pages：

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

## 3. 部署与发布机制

### 方式 A：GitHub Actions 自动部署（主要通道，已打通并验证）
项目已配置并成功运行 `.github/workflows/deploy-pages.yml`（已配置 `CLOUDFLARE_API_TOKEN` 与 Account ID）：
- 当 `main` 分支接收到包含 `viewer/`、`shared/` 或 `package.json` 的修改时，会自动执行测试、构建并发布至 Cloudflare Pages。
- **发布流程**：只需提交并推送至 `main` 分支：
  ```bash
  git push origin main
  ```
- **查看部署状态**：可以通过 GitHub CLI 检查工作流运行状态：
  ```bash
  gh run list --workflow="deploy-pages.yml" --limit 3
  ```
- **线上验证**：部署完成后，验证生产环境是否已加载最新编译哈希的资源：
  ```bash
  curl -s https://chat-share.pages.dev | grep -o 'assets/index-[^"]*'
  ```

### 方式 B：本地 Wrangler 手动部署（仅限应急）
若 GitHub Actions 异常或需要在本地快速发布排查，可按以下命令手动操作：
```bash
npm run typecheck && npm test
npm run build
npx --yes wrangler pages deploy viewer/dist --project-name chat-share --branch main
```

---

## 4. 前端交互规范（已对齐设计）

在修改查看器前端交互时，请务必遵守已对齐的视觉规范：
1. **多步骤合并折叠**：连续的思考与工具调用折叠为外层的 summary 行（如 `思考 1 次，运行 11 个命令`），展开后显示各个具体步骤。
2. **树形分组引导线**：展开后的子步骤与详细输出必须具备左侧树形竖向连线（`border-left`）和缩进，提供明确的层级归属感。
3. **取消整行 Hover 底色**：鼠标移动到条目上时，**不要**让整行出现灰色背景条高亮，保持页面清爽。
4. **左侧图标悬浮替换**：
   - 默认状态：左侧显示对应工具/思考的原生类型图标；
   - 鼠标悬浮：左侧图标动态切换为展开箭头 `>`；
   - 展开状态：左侧箭头转为向下展开 `v`，点击可再次折叠。
5. **移除右侧多余小箭头**：整行的展开/折叠状态统一由左侧图标呈现，行右侧不放置多余的箭头按钮。
6. **整行可点击**：整个 summary 区域均可轻点触发展开/折叠，保持 `cursor: pointer` 手势。

---

## 5. 关键安全与开发规范

- **CSP 安全规范**：Cloudflare Pages 包含严格的 CSP（见 `viewer/public/_headers`）。测试查看器改动时，确保运行浏览器测试（`npm run test:browser`），严禁引入内联样式（inline style）或未授权的外部脚本。
- **本地端到端预览**：可在部署前运行 `npm run preview`，在 `http://127.0.0.1:4173/?preview=design#local-preview/00000000000000000000000000000001` 本地预览完整的 CSP 与生产构建表现。
- **隐私边界**：`.local/` 目录存放本地实测提取的真实会话，**严禁**复制到 fixtures 中或提交到 Git 仓库。
