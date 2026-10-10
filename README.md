# ThreadBridge

Save and search your ChatGPT, Claude and Gemini history locally, and make it available to Codex or other MCP clients. ThreadBridge stores conversations, revisions and sync progress in SQLite on your computer. Claude and Gemini adapters are experimental and still require live-account verification.

[中文说明](README.zh-CN.md) · [Usage](docs/usage.md) · [Browser setup](NATIVE-SETUP.md) · [Operations](docs/operations.md)

## Features

- Import raw ChatGPT JSON exports, including message branches and attachment references.
- Add platforms in Settings and verify each browser login. Background workers retain independent progress and cooldowns.
- Discover conversation IDs, sync content, or monitor new IDs through a Chrome/Edge extension. ChatGPT also discovers project and archive directories.
- Archive ChatGPT messages already loaded while browsing, with explicit coverage labels for partial content.
- Search local history, read revisions, and consume changes with acknowledged cursors.
- Navigate a local binary index of archived versions and branches. Visiting AI clients fill summaries from the leaves upward; Settings shows indexing and summary progress separately. See [chat index](docs/chat-index.md).
- Inspect sync progress, pause/resume all added platforms, import ChatGPT JSON, and sort every column across the combined history. Help is available in hover/focus bubbles.
- Connect through a local stdio MCP server. No OpenAI API key or external database is required.

## Quick start

Requires Node.js 24 or newer. The CLI has no third-party runtime dependencies. Run from the repository directory:

```sh
git clone https://github.com/Enmani/ThreadBridge.git
cd ThreadBridge
node src/cli.mjs import --account personal --input /path/to/conversations.json
node src/cli.mjs status --account personal
node src/cli.mjs search --account personal --query "project"
node src/cli.mjs read --account personal --id CHAT_UUID
```

The default database is `data/history.sqlite`, relative to the working directory. Use an absolute `--db` path when calling from elsewhere. Keep the same database and `--account` name across tools.

Start the dashboard with `npm run dashboard`, then open `http://127.0.0.1:17321`. On Windows, `scripts/start-dashboard.ps1` runs it in the background and uses the native host configuration when present.

The CLI importer accepts raw JSON containing `mapping`. The dashboard additionally accepts supported text exports; their coverage is recorded as `export-text`.

## Browser sync

Load `extension/` as an unpacked extension in Chrome or Edge, then register its Native Messaging host. The included installer supports Windows. See [installation steps](NATIVE-SETUP.md).

The installer starts with ChatGPT. Open Settings → Add platform to add Claude or Gemini using the same browser profile. Settings displays Connected only after login validation; adding a platform does not switch the history view. Claude organizations and Gemini account indices can be specified when adding. Sync progress and cooldowns survive restarts; closing the browser stops collection. Directory-only mode does not request conversation bodies. ChatGPT browsing archives are controlled separately.

## MCP

[codex-mcp.example.toml](codex-mcp.example.toml) shows separate local-only servers for each provider. Replace its absolute paths before use. Each exposes `list_threads`, `search_history`, `fetch_threads`, `get_changes`, `ack_changes`, `get_sync_status` and `chat_index`. CLI commands accept `--provider chatgpt|claude|gemini` (default: ChatGPT).

An optional Codex native adapter can read known conversation IDs when the desktop app exposes its internal pipe. That interface is experimental and returns bounded text. See [usage](docs/usage.md).

## Data and limits

Data stays in your local database; the extension contacts the added platforms for browser sync. Claude and Gemini session credentials remain in the browser. ChatGPT token-based developer tools may save a local session file. Never publish `data/`, session files or real conversation exports.

Browser sync depends on undocumented website endpoints and may break when a website changes. Claude and Gemini snapshots are labeled `bounded-text`; their complete branch coverage is unconfirmed. Gemini reads request at most 10,000 turns and reject a response that reaches the window or signals more data. An archived tree does not prove the server returned everything. Deleted and temporary chats cannot be recovered, and attachment files are not downloaded. Full-account coverage and long-running sync have not been established by the automated tests.

## Development

```sh
npm ci
npm run precheck
```

`precheck` checks JavaScript syntax, the 500-line module limit, and the automated tests. Fixtures are synthetic; tests do not require a ChatGPT login. GitHub Actions runs the same command on Windows and Linux with Node.js 24.

[Architecture and docs](docs/README.md) · [Contributing](CONTRIBUTING.md) · [Tasks](TODO.md) · [Security](SECURITY.md)

MIT licensed. Adapted upstream workflows are credited in [third-party notices](THIRD-PARTY-NOTICES.md), with their license texts preserved in `third_party/`.
