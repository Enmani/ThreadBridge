# Third-party notices

ThreadBridge combines endpoint workflows and synchronization approaches from:

- chatgpt-sync 0.12.5 — Copyright (c) 2026 Pavel Voronin. https://github.com/pavel-voronin/chatgpt-sync — CDP session transport, directory watermark and overlap. Adapted in src/transport.mjs and src/discovery.mjs.
- export-chatgpt 0.2.0 — Copyright (c) 2026 Brian Lacy. https://github.com/brianjlacy/export-chatgpt — active/archived buckets and cursor-based project enumeration. Adapted in src/discovery.mjs.
- GPT2Claude-Migration-Kit — Copyright (c) 2026 Siamsnus. https://github.com/Siamsnus/GPT2Claude-Migration-Kit — project discovery cascade, conversation batch endpoint and individual fallback. Adapted in src/discovery.mjs and src/sync.mjs.

All three upstream projects use the MIT License. Original license texts are preserved in third_party/<project>/LICENSE. Reviewed from their default branches on 2026-10-01. This project does not bundle their UIs or runtime dependency trees.

The native adapter follows the protocol observed in an installed codex-app-tools adapter; its source is not bundled. Native transport is internal and may change between Codex versions.
