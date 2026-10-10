# Contributing

Use Node.js 24 or newer. Install test dependencies with `npm ci`, then run `npm run precheck` before submitting a pull request.

Describe the behavior being changed and how you checked it. Changes to sync, storage or imports should preserve account isolation, restart recovery, coverage labels and consumer acknowledgements. Use synthetic conversations in tests and bug reports. Include documentation changes for new commands or user-visible behavior.

Modules and data flow are described in [the documentation index](docs/README.md). Open work is in [TODO.md](TODO.md).

Do not attach real conversation exports, SQLite databases, tokens, native configuration files or browser profiles to issues or pull requests.
