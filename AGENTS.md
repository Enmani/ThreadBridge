# Project instructions

- Read README.md and the files you intend to change. Follow CORE-ENGINEERING-PRINCIPLES.md.
- Verification entry point: `npm ci`, then `npm run precheck` with Node.js 24 or newer.
- Keep JavaScript modules below 500 lines. Prefer existing modules and dependencies.
- Treat SQLite as the source of truth. Preserve account/workspace isolation, transactions, leases and consumer cursors.
- Keep coverage labels accurate: `full-tree`, `bounded-text`, `page-text`, `export-text`.
- Never commit or log credentials, real transcripts, browser profiles, exports or local runtime configuration. Tests use synthetic fixtures.
- Read DESIGN.md before changing the dashboard. Update relevant docs when commands or behavior change.
- Track unfinished work in TODO.md. Do not add placeholder tests or claim live verification from mocks.
