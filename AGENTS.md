# AGENTS.md

Guide for AI agents and developers working on Chat-Share. User-facing docs are in [README.md](README.md) ([简体中文](README.zh-CN.md)). Read this before changing code.

## 1. What this is

A Paseo plugin that snapshots one agent conversation into a secret GitHub Gist, plus a static viewer that renders it in the browser. No backend of our own: the plugin server talks to GitHub through `gh auth token`, and the viewer reads the Gist raw URL directly.

Two subsystems share code in `shared/`:

| Subsystem | Directories | Runs in | Takes effect via |
| :--- | :--- | :--- | :--- |
| **Paseo plugin** | `client/`, `server/`, `index.client.tsx`, `index.server.ts`, `paseo-plugin.json` | Local Paseo daemon (server) and desktop/web app (client) | `git push` for GitHub installs; `paseo plugin reload chat-share` for local-path installs |
| **Session viewer** | `viewer/`, `shared/` | Static SPA on Cloudflare Pages, production `https://chat-share.pages.dev` | GitHub Actions on push to `main` (see §8) |

`shared/` is imported by both. Anything in it must work in Node, the browser and the plugin client, and must not import DOM-only or `node:` modules.

## 2. Repository map

```text
index.client.tsx        plugin client entry: setLocale + registerHeaders(createSharePopover)
index.server.ts         plugin server entry: settings + RPC handlers (share-agent, list-shares, list-all-shares, delete-share)
paseo-plugin.json       manifest: id chat-share, requires paseo >=0.14.0, build step `npm ci --omit=dev --ignore-scripts`
client/
  header.ts             workspace header button (popover), registered per workspace
  directory.ts          workspace/agent directory subscription, 200-entry cursor pages, buffers updates until the snapshot is complete
  share-popover.tsx     agent list, per-row Share/Copy/Share-again actions, staleness check, pending state per conversation
  manage-shares.tsx     modal listing all Chat-Share Gists with batch delete
  i18n.ts               plugin text (zh/en) and translateError()
  provider-icons.ts     Claude/Codex marks (copied from the Paseo client)
  web.ts                menu positioning helpers
server/
  share.ts              readSnapshot -> toShare -> optional lockContent -> Gist create/list/delete; ShareFailure
  passwords.ts          password store: $PASEO_HOME/plugin-data/chat-share/share-passwords.json (0600)
shared/
  format.ts             types, constants (MAX_SHARE_BYTES, PBKDF2_ITERATIONS, SHARE_PASSWORD), parseShare/parseStoredShare, ShareError
  convert.ts            pure timeline -> ShareDocument; local-image replacement (uses mdast positions)
  snapshot.ts           readSnapshot: one limit:0 request, else paged with epoch/cursor checks, max 3 retries
  encryption.ts         PBKDF2 key derivation, lockContent / unlock (AES-256-GCM)
  download.ts           Markdown download generator
  tools.ts              tool labels, one-line summaries, edit line diffs
  plugin.ts             zod schemas, RPC definitions, settings, DEFAULT_VIEWER_URL
viewer/
  index.html, vite.config.ts, public/_headers (CSP)
  src/main.ts           app shell, preferences, load -> showShare / showLock
  src/load.ts           fragment -> raw Gist URL, size-capped streaming fetch
  src/render.ts         timeline DOM, merged folding, icon swap, diffs
  src/markdown.ts       markdown-it (HTML off) + highlight.js (12 grammars, no auto-detect), safe links
  src/outline.ts        turn outline navigation
  src/i18n.ts           viewer text (en/zh) and browserLocale
  src/icons.ts          inlined Remix Icon paths (no icon package dependency)
  src/style.css         theme/layout; loads Geist from node_modules/@fontsource-variable/geist
  src/dev-preview.*     dev-only JSON file picker, loaded only under import.meta.env.DEV (main.ts)
scripts/preview.ts      local harness serving viewer/dist with the real _headers plus synthetic shares
tests/                  vitest unit tests + fixtures.ts; tests/browser/viewer.spec.ts is Playwright
.github/workflows/deploy-pages.yml
```

## 3. Data flow

**Share (plugin).** The popover calls the `share-agent` RPC. The server fetches the agent, then `readSnapshot` reads the whole timeline (`limit: 0` when possible; otherwise paged and verified against `epoch`, `reset`, `gap`, `staleCursor`, retried at most 3 times, then an explicit error, never a partial session). `toShare` converts it, the 10,000,000-byte limit is checked, and for encrypted shares a generated 6-digit password goes through `lockContent` (version 2 envelope). The server creates a secret Gist with the single file `chat-share.json` and a description `Chat-Share snapshot <agentId> <epoch> <maxSeq>[ locked]`; that description is how the latest link is restored after a reload and how deletion verifies a Gist belongs to Chat-Share. The RPC returns only the viewer URL, snapshot version and optional password.

**View (browser).** Link: `<viewer>/#<GitHub login>/<gist id>` (login 1–39 chars, gist id 20–40 hex). `load.ts` fetches `https://gist.githubusercontent.com/<login>/<id>/raw/chat-share.json` with `credentials: 'omit'`, enforcing the size cap while streaming. Version 1 renders directly. Version 2 prompts for the password; the derived key (not the password) is cached in `sessionStorage` per URL. Download builds Markdown in the browser from the same parsed document.

## 4. Invariants (do not break)

- **Never ship a partial or silently altered snapshot.** The only content substitution is local images (`file:`/`data:` references and typed image objects carrying local bytes), applied to user/assistant/reasoning prose only. Tool commands, outputs and diffs stay verbatim. `http(s)` images stay. Unknown fields and item types are preserved.
- **Truncation provenance is field-specific:** suffix `[Content truncated]` on `plain_text.text`, suffix `...[truncated N chars]` on `edit.unifiedDiff`, or `truncated: true` on search/worktree details. Quoted markers in messages never count. Shell output at 65,536 UTF-16 units is "possibly truncated".
- **Oversize is an error with the size,** never a trim. Encrypted size is checked after encryption.
- **Credentials never leave the server.** RPCs return links, versions or short typed errors. A Gist POST is never retried; if a create response is unusable but contains a Gist id, the server tries to delete it before returning a sanitized error.
- **Deletion verifies the Gist** (secret, contains `chat-share.json`, description prefix) before deleting. GitHub does not record the creator, so a hand-made lookalike cannot be told apart.
- **Format changes are versioned.** Keep version 1 readable. Planned phase two (importing a share back into Paseo as a Claude session) depends on the data retaining user/assistant text, edits, tool calls, errors and sub-agent results.
- **Client code cannot import `node:`.** Network calls and secrets belong in the server handlers. The host supplies `@getpaseo/plugin`, `zod`, React/React Native and React Query; do not bundle them.
- **Settings** (`preferences`, id `sharing`, version 2) hold only `viewerUrl`. Bump `version` and keep `migrate` when changing the schema; the SDK persists the migrated document at plugin start.

## 5. i18n gotcha

- Plugin client text uses `t(zh, en)` from `client/i18n.ts`.
- Server errors and `ShareFailure` messages are **Chinese strings** that the client maps to English in `translateError()` (exact-match table plus a size regex). When you add or reword a server error, update that table, and the test in `tests/client-i18n.test.ts`.
- Viewer strings live in `viewer/src/i18n.ts` (en, zh-CN). Other locales fall back to English.

## 6. Commands and tests

```sh
npm ci --ignore-scripts
npm run typecheck     # tsc for viewer/scripts/tests, then tsc -p tsconfig.plugin.json (no DOM lib, to keep the plugin graph clean)
npm test              # vitest (jsdom), tests/*.test.ts
npm run build         # vite -> viewer/dist
npm run preview       # tsx scripts/preview.ts on 127.0.0.1:4173; REQUIRES a prior `npm run build` (reads viewer/dist/_headers)
npm run test:browser  # Playwright (channel: chrome); starts `npm run preview` but does NOT build first
npm run dev           # Vite dev server + local file picker; not a CSP verification target
```

| Test file | Covers |
| :--- | :--- |
| `conversion.test.ts`, `snapshot.test.ts` | `shared/convert.ts`, `shared/snapshot.ts` |
| `encryption.test.ts` | lock/unlock, password parsing |
| `download-polish.test.ts` | Markdown download |
| `share-server.test.ts`, `settings.test.ts` | server share/list/delete, settings and migration |
| `plugin-client.test.ts`, `share-menu-position.test.ts`, `client-i18n.test.ts` | popover, manage dialog, menu placement, translations |
| `viewer.test.ts`, `review-regressions.test.ts` | viewer rendering/loading and past regressions |
| `tests/browser/viewer.spec.ts` | real Chrome under production CSP: malicious fixture, encryption flow, downloads, outline, reader preferences, hover icon swap |

`tests/fixtures.ts` holds the synthetic shares (`designShare`, `maliciousShare`, `benchmarkShare`). It is used by the unit tests, the browser tests **and** `scripts/preview.ts`, so it is not test-only; do not delete it. Fixtures must stay synthetic.

CI runs `typecheck` and `npm test` only. Run `test:browser` yourself for any viewer change (§9).

## 7. What needs a Pages deployment

Anything the viewer bundle or its CSP depends on:

- `viewer/**` (`render.ts`, `style.css`, `main.ts`, `load.ts`, `markdown.ts`, `outline.ts`, `i18n.ts`, `icons.ts`, `index.html`, `public/_headers`, `vite.config.ts`)
- `shared/**` (`tools.ts`, `convert.ts`, `download.ts`, `format.ts`, `encryption.ts`, `plugin.ts`, `snapshot.ts`) when the viewer imports it
- `package.json` / `package-lock.json` (they change the build)

Changes only under `client/`, `server/`, `index.*` or `paseo-plugin.json` need no Pages deployment; they ship by `git push` and `paseo plugin reload`.

## 8. Deployment

**Primary: GitHub Actions** (`.github/workflows/deploy-pages.yml`). A push to `main` touching `viewer/**`, `shared/**`, `package.json`, `package-lock.json` or the workflow runs `npm ci`, `typecheck`, `npm test`, `npm run build`, then `wrangler pages deploy viewer/dist --project-name chat-share --branch main`. It can also be started manually (`workflow_dispatch`). Secrets: `CLOUDFLARE_API_TOKEN`, and optionally `CLOUDFLARE_ACCOUNT_ID` (the workflow has a built-in fallback account id).

```sh
git push origin main
gh run list --workflow="deploy-pages.yml" --limit 3
curl -s https://chat-share.pages.dev | grep -o 'assets/index-[^"]*'   # compare with the local build hash
```

**Emergency: local Wrangler.**

```sh
npm run typecheck && npm test
npm run build
npx --yes wrangler pages deploy viewer/dist --project-name chat-share --branch main
```

**Forks:** change `--project-name`, the account id/secrets, `DEFAULT_VIEWER_URL` in `shared/plugin.ts`, and the `github:` install path in the README.

## 9. Viewer interaction spec (agreed design)

1. **Merged folding.** Consecutive reasoning and tool calls fold into one outer summary row (e.g. "1 thought, 11 commands"); expanding shows each step. A run with a single row renders without the extra level. Adjacent reasoning entries merge. This is display-only.
2. **Tree guide lines.** Expanded children and output have a left vertical line (`border-left`) and indentation.
3. **No row hover background.** Hovering must not tint the whole row.
4. **Left icon swap.** Default: the tool/reasoning type icon. Hover: a `>` chevron. Expanded: `v`; click collapses.
5. **No right-hand arrows.** Open/closed state is shown only by the left icon.
6. **Whole summary row is clickable** with `cursor: pointer`.
7. User and assistant messages are always expanded; the top bar holds only title, download and expand/collapse all, with no explanatory captions. Light/dark follows the system; mobile is supported.

## 10. Security and privacy rules

- **CSP** (`viewer/public/_headers`): `default-src 'none'`, same-origin scripts/styles/fonts, `img-src * data: blob:`, `connect-src https://gist.githubusercontent.com`, `frame-ancestors 'none'`. **No inline styles, inline scripts or new external origins.** Verify viewer changes with `npm run build && npm run test:browser`; the suite includes a negative test that the CSP blocks inline JS/CSS and a disallowed connection.
- Markdown renders with HTML disabled and restricted link protocols. Shared content is always untrusted.
- External images auto-load by design.
- **Privacy:** `.local/` holds real sessions and screenshots and is gitignored. Never copy real sessions into fixtures, tests or commits. `claude` / `codex` preview cases and their browser tests read `.local/claude.json` / `.local/codex.json` when present and skip otherwise.
- Default shares are not encrypted or secret-scanned. Encryption is a 6-digit code with no attempt limiting: it stops casual access, not offline brute force. Do not describe it as strong protection.

## 11. Paseo facts the code relies on

Measured on Paseo 0.14.0; recheck before depending on them.

- Timeline read: `paseo.agents.ref(id).timeline.refetch({ direction, cursor, limit, projection })`. Separate requests are not atomic, hence the epoch/cursor checks.
- Item types: `user_message`, `assistant_message`, `reasoning`, `tool_call`, `todo`, `error`, `compaction`, `plugin`, `notification`. Tool details are discriminated by `detail.type` (`shell`, `read`, `edit`, `write`, `search`, `fetch`, `worktree_setup`, `sub_agent`, `plain_text`, `plan`, `unknown`); only `unknown` has generic `input`/`output`, keep the whole object.
- Images appear as Markdown references in message text (local `file:` or URL) or as `{type:"image",data,mimeType}` objects.
- Gist raw responses: `text/plain`, `access-control-allow-origin: *`, `max-age=300`, URL must include the username. Deleted Gists stay readable for ~5 minutes. Gists of 12 MiB were created fine; the unauthenticated API is 60 requests/hour/IP and truncates files over 1 MB, which is why the viewer avoids it.
- Plugin API: `addHeaderButton` binds to a workspace; `copyText` only writes the clipboard; `useToast` is a hook. There is no plugin storage API, so passwords live in the daemon-side file above. Local-path installs do not run the manifest `build` step.

## 12. Release checklist

1. `npm run typecheck && npm test && npm run build && npm run test:browser`
2. `git status` is clean; nothing from `.local/` or `.taste-skill/` is tracked.
3. Viewer changes: push to `main`, watch `gh run list`, and confirm the production asset hash.
4. Plugin changes: push, then `paseo plugin install github:mailwmj/Chat-Share` (or `paseo plugin reload chat-share` locally) and click through a share, a re-share, an encrypted share and the manage dialog.
5. Docs: keep `README.md` and `README.zh-CN.md` in sync, and this file current when architecture, scripts or the deploy flow change.
