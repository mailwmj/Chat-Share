# Chat-Share

A Paseo plugin that uploads one complete agent snapshot to a secret GitHub Gist and returns a browser viewer link. The agreed specification is [docs/requirements.md](docs/requirements.md). The viewer has not been deployed; its URL starts empty.

## Install and configure

Requires Paseo 0.14.0 (including 0.14.0 prereleases), Node/npm on the daemon, and a separately hosted production viewer.

```sh
paseo plugin install github:<owner>/<repo>
# For development, after the full npm install below:
paseo plugin install /absolute/path/to/Chat-Share
```

Open **Settings → Plugins → Chat-Share → 会话分享**, enter **查看器 URL**, and save. Sharing fails before uploading while this is empty. The server first uses `gh auth token`, then **备用 GitHub token** when gh cannot supply one.

Prefer `gh`; if a fallback token is needed, limit it to the `gist` scope. It is stored in plaintext, and clients with daemon management permission can read it.

Use **分享** in any workspace header (or **··· → 分享会话** in compact layouts). The popover lists non-archived agents, newest first. Clicking an agent uploads immediately. The link is copied and stays visible with **复制链接**, including when clipboard access fails. Delete the Gist on GitHub to revoke a link; cached raw content can remain readable for about five minutes.

## Run

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run preview
```

The preview listens only on `127.0.0.1:4173` and applies the built `_headers`, including CSP. The production site is `viewer/dist/`; publish only that directory in a later milestone.

```text
http://127.0.0.1:4173/?preview=design#local-preview/00000000000000000000000000000001
http://127.0.0.1:4173/?preview=malicious#local-preview/00000000000000000000000000000001
http://127.0.0.1:4173/?preview=claude#local-preview/00000000000000000000000000000001
http://127.0.0.1:4173/?preview=codex#local-preview/00000000000000000000000000000001
```

The local preview harness supplies a synthetic raw-Gist response or a gitignored real export to the unmodified production viewer. It injects an external same-origin bootstrap, so the production CSP stays intact. This harness and its local-file transport are never included in `viewer/dist/`. No share is published by opening these URLs. `invalid`, `oversized`, `deleted`, and `failure` are additional preview cases.

For interactive development, `npm run dev` adds a local JSON file picker. Vite removes the picker module, labels, and styles from the production graph. The Vite dev server is not the CSP verification target.

## Local real exports

```sh
npm run export:local
```

This reads recent Claude and Codex sessions using the installed Paseo CLI's authenticated SDK transport. It writes `.local/claude.json` and `.local/codex.json`, with aggregate-only console output. It neither uploads data nor changes Paseo configuration. Set `PASEO_CLI_ROOT` if the CLI is not under the global npm module directory.

`.local/`, browser screenshots, dependencies, test output, and `viewer/dist/` are gitignored. Tests and repository fixtures are synthetic. Never copy real exports into fixtures or commit them.

## Verify in Chrome

With the production preview running:

```sh
npm run test:browser
```

The browser tests use an installed Google Chrome (`channel: chrome`). They check the malicious fixture and both local exports at desktop/mobile widths, in light/dark, with English/Chinese UI. Screenshots and aggregate console/CSP diagnostics go to `.local/screenshots/`. Additional checks cover actual downloads, error states, fragment injection, external image loading, and deliberate CSP violations. There are no unexpected CSP violations in the ordinary rendering cases; the negative test expects the policy to block inline JavaScript, inline CSS, and a disallowed connection.

## Format and conversion

`shared/format.ts` defines version 1: session metadata, the source epoch/window, complete timeline entries, and field-specific truncation annotations. Entries retain arbitrary original fields, including tool payloads, `agentMessage`, plugins, notifications, and future item types. The one content substitution is local image data/references; HTTP(S) images remain.

`shared/convert.ts` is pure. Markdown image replacement applies only to user, assistant, and reasoning prose; tool source, commands, outputs, and diffs remain verbatim. Typed image objects are replaced only when they carry local image bytes or a local URL. HTTP(S) image objects and payload-free image-shaped values remain. `shared/snapshot.ts` prefers one `limit: 0` daemon response. If pagination is necessary, it checks epochs/cursors and change flags, enforces the initial window boundary, and retries a changed snapshot at most three times. It returns an explicit error after repeated inconsistency, never a partial session.

The serialized share must fit **10,000,000 UTF-8 bytes**. The viewer enforces this while streaming, validates the external JSON envelope, and rejects unsupported versions or excessive nesting. Unknown item types remain visible as collapsed generic rows. Full entries remain accessible within disclosures. Adjacent reasoning entries merge into one row, and consecutive reasoning and tool call rows fold into a merged row, for display only. A run with a single row renders without the extra level.

The Markdown download has an escaped title heading, compact session metadata, and each message once in a safe Markdown fence. Known tools use the same readable summaries as the viewer, followed by input, real multiline output, diffs, and errors. Unknown tools, plugins, notifications, and future types retain the complete item as pretty-printed JSON once. Transport envelopes are omitted. Backtick fence lengths adapt to content, so quoted headings or fences cannot become structural sections.

Truncation provenance is field-specific: only a suffix `[Content truncated]` on `plain_text.text`, a suffix `...[truncated N chars]` on `edit.unifiedDiff`, or `truncated: true` directly on search/worktree details is definite. Quoted markers in messages and arbitrary payloads never count. Shell output and failed-shell error content at 65,536 UTF-16 units are marked as possibly truncated.

The share filename is `chat-share.json`. A published URL will use `#<GitHub user>/<gist ID>`; the viewer fetches `https://gist.githubusercontent.com/<user>/<id>/raw/chat-share.json`, without credentials or GitHub API calls.

## Plugin layout and runtime

The repository root contains `paseo-plugin.json`, `index.client.tsx` and `index.server.ts`, with runtime-specific code in `client/` and `server/`. Both plugin and viewer reuse `shared/`; viewer DOM code is outside the plugin graph. `npm run typecheck` also checks the plugin with `tsconfig.plugin.json` without DOM libraries.

For GitHub installs and updates, Paseo runs the manifest's `npm ci --omit=dev --ignore-scripts` in a managed candidate checkout before validating and activating it. Local-path installs and reloads use that directory directly and do not run manifest preparation; run the full development install yourself. The host supplies `@getpaseo/plugin`, `zod`, React/React Native and React Query. The parser/diff libraries are production dependencies; SDK/type/test tooling stays in devDependencies.

Header registrations follow an owned workspace directory subscription, including workspaces opened later and reconnects. Workspace and agent directories use 200-entry cursor pages, buffering updates until the snapshot is complete. The server runs `readSnapshot` → `toShare` → Gist upload. Credentials and GitHub requests stay on the server; the sharing RPC returns only the viewer URL. If a successful create response is unusable but supplies a valid Gist ID, the server attempts deletion before returning a sanitized error. A broken connection or an unreadable response without an ID cannot guarantee cleanup, and POSTs are never automatically retried.

## Dependencies

- `markdown-it`: HTML-disabled Markdown rendering with restricted link protocols.
- `highlight.js`: only 12 common language grammars, no language auto-detection.
- `mdast-util-from-markdown`: source positions for safe inline/reference-image replacement, preserving the original Markdown. This avoids an incomplete image regex or private markdown-it internals.
- `diff`: line diffs for old/new edits. Edit-distance work is bounded; an unusually large unrelated edit displays a complete whole-file replacement.

Vite, TypeScript, Vitest/jsdom, Playwright, and tsx are development tools. Geist is a self-hosted font build asset, with no external font or stylesheet requests.
