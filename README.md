# Chat-Share

**English** · [简体中文](README.zh-CN.md)

Turn a [Paseo](https://paseo.sh) agent conversation into a link. Colleagues need no install and no account: they open the link and read how a plan and its code came to be.

Chat-Share is a Paseo plugin plus a static viewer. The plugin uploads one complete snapshot of a Claude Code or Codex conversation to a **secret GitHub Gist** and copies a viewer link. The viewer, hosted at [chat-share.pages.dev](https://chat-share.pages.dev), reads the Gist directly in the browser.

- One click from the workspace header to a copied link.
- Complete timeline: messages, reasoning, tool calls, diffs and errors, with original fields kept.
- Single-column reader with Markdown and syntax highlighting. Reasoning and tool calls are folded to one line each; an outline, light/dark theme and mobile layout are included.
- Download any share as a single Markdown file that another agent can analyze.
- Optional encryption with a generated 6-digit password.
- The viewer treats shared content as untrusted: no raw HTML, no `javascript:` links, strict CSP.
- English and Simplified Chinese; both follow the host language.

## Install

Requirements on the machine that runs the Paseo daemon:

- Paseo 0.14.0 or later (prereleases of 0.14.0 included)
- Node.js and npm
- [GitHub CLI](https://cli.github.com) (`gh`), logged in with permission to create Gists: `gh auth login`

```sh
paseo plugin install github:mailwmj/Chat-Share
```

The server authenticates with `gh auth token`. No credential is stored by the plugin or sent to the client.

To use your own viewer, open **Settings → Plugins → Chat-Share**, enter the viewer URL and save. An empty value uses `https://chat-share.pages.dev`.

## Use

Click **Share** in any workspace header (or **··· → Share conversation** in compact layouts). The popover lists non-archived agents in tab order.

| State | Row action |
| :--- | :--- |
| Never shared, or the conversation changed since | **Share** creates a new snapshot and copies its link |
| Conversation matches the last snapshot | **Copy link**, with **Share again** and **Share encrypted again** in the menu beside it |

- Sharing again creates a new snapshot. Earlier links keep their original content.
- Renaming a conversation does not make its snapshot stale.
- **Manage share links** lists every Chat-Share Gist under the current `gh` account, newest first, with batch delete. You can also delete the Gist on GitHub. Cached raw content can stay readable for about five minutes.
- The size limit is **10,000,000 bytes**. Larger conversations fail with their size. Content is never dropped silently.

### Encrypted shares

**Share encrypted**, in the row menu, encrypts the snapshot (PBKDF2-SHA256, 1,000,000 iterations, AES-256-GCM) with a generated 6-digit password. The title is encrypted too. Copying then includes the password under the link, and the reader enters it before seeing anything.

This keeps the content unreadable on GitHub and from anyone who only has the link. It is **not strong protection**:

- Anyone who receives the link and password together can read the conversation. Remove the password line and send it separately if that matters.
- Nothing limits attempts, so someone with the link can try all one million codes offline: about 50 hours on one CPU core, likely minutes on a GPU. Do not rely on it for secrets.
- Encrypting a conversation does not affect earlier plaintext links. Delete those Gists.

The daemon keeps each password in plaintext in `$PASEO_HOME/plugin-data/chat-share/share-passwords.json` (default `~/.paseo`, owner-readable only), so copying works after a restart. Where that file is missing, the link cannot be copied and the action becomes **Share encrypted**.

## Development

```sh
npm ci --ignore-scripts
npm run typecheck      # viewer and plugin, two tsconfig projects
npm test               # vitest, 11 files
npm run build          # viewer -> viewer/dist
npm run preview        # production build + production CSP on 127.0.0.1:4173
npm run test:browser   # Playwright against the preview; needs Google Chrome
npm run dev            # Vite dev server with a local JSON file picker
```

Install the plugin from a local checkout (this does not run the manifest's install step, so run `npm ci` yourself first):

```sh
paseo plugin install /absolute/path/to/Chat-Share
paseo plugin reload chat-share
```

Preview URLs (the harness serves synthetic shares to the unmodified production viewer, without touching GitHub):

```text
http://127.0.0.1:4173/?preview=design#local-preview/00000000000000000000000000000001
```

Other `preview=` values: `locked`, `malicious`, `benchmark`, `invalid`, `oversized`, `deleted`, `failure`. `claude` and `codex` read your own `.local/claude.json` / `.local/codex.json` (gitignored; a Chat-Share JSON file). The Playwright tests skip those two when the files are absent.

See [AGENTS.md](AGENTS.md) for architecture, conventions and the deployment flow.

## Share format

Each share is one file, `chat-share.json`, in a secret Gist. The viewer link is `https://<viewer>/#<GitHub user>/<gist id>`. The viewer fetches `https://gist.githubusercontent.com/<user>/<id>/raw/chat-share.json` without credentials and never calls the GitHub API.

- **Version 1** holds session metadata, the source epoch and window, and every timeline entry with its original fields. The only substitution is local images (`file:`, `data:`), which become a one-line marker; `http(s)` images stay.
- **Version 2** wraps a version 1 document in an AES-GCM envelope.
- Unknown entry types stay visible as collapsed generic rows.
- Truncation is marked only where Paseo gives evidence (`[Content truncated]`, `...[truncated N chars]`, `truncated: true`). Shell output at exactly 65,536 UTF-16 units is marked as possibly truncated.

## Security model

- Shared content is untrusted. Markdown is rendered with HTML disabled and restricted link protocols.
- External images load automatically (a deliberate decision).
- [`viewer/public/_headers`](viewer/public/_headers) sets a CSP: scripts and styles from the same origin only, data requests only to `gist.githubusercontent.com`, `frame-ancestors 'none'`.
- Default shares are not encrypted and not scanned for secrets: anyone with the link can read the full text.

## License

[MIT](LICENSE) © 2026 mailwmj
