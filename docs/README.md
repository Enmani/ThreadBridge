# Documentation

- [Project overview](../README.md) / [中文说明](../README.zh-CN.md)
- [Commands, imports, coverage and MCP](usage.md)
- [Chrome/Edge installation on Windows](../NATIVE-SETUP.md)
- [Start, stop, back up and restore](operations.md)
- [Sync transport and recovery](../SYNC-CHANNEL.md)
- [Directory and content modes](../ADR.md)
- [Passive browser archive](../ADR-BROWSER-ARCHIVE.md)
- [JSON import](../ADR-JSON-IMPORT.md)
- [Provider isolation, connections and sorting](../ADR-PROVIDERS.md)
- [Chat index and AI summary workflow](chat-index.md) · [Index architecture](../ADR-CHAT-INDEX.md)
- [Dashboard behavior](../DESIGN.md)
- [Third-party notices](../THIRD-PARTY-NOTICES.md)
- [Contributing](../CONTRIBUTING.md) and [open tasks](../TODO.md)

## Architecture

Browser extension → Native Messaging host → validated conversation models → account-scoped SQLite → CLI, MCP and dashboard.

`src/transport.mjs` and `src/browser-transport.mjs` handle remote reads. `src/discovery.mjs` enumerates directories; `src/sync.mjs` coordinates content reads. `src/model.mjs` validates trees. `src/store.mjs` stores archives, revisions and change cursors. Browser and text imports have separate storage adapters so partial content cannot replace full trees. `src/native.mjs` provides the optional Codex pipe adapter.

Database schemas are created and upgraded at startup. Back up before updating an existing installation. Development checks use the single `npm run precheck` entry point.
