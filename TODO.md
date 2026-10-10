# Open tasks

- [ ] Verify a clean Windows browser installation of the standalone repository, including login, ID-only discovery, passive archive and restart recovery. Record versions and anonymized results.
- [ ] Verify Claude and Gemini with real logged-in browser profiles: account/organization selection, old-history pagination, edits, rate limits and restart recovery. Synthetic protocol fixtures do not establish live compatibility.
- [ ] Verify compact dashboard and Settings in a real browser, including hover/focus bubbles, column sorting, light/dark, narrow screens and 200% zoom. Current development browser blocked the isolated preview with `ERR_BLOCKED_BY_CLIENT`.
- [ ] Establish Gemini long-conversation pagination before supporting responses at the 10,000-turn window. Current adapter rejects truncated windows and retains pending work.
- [ ] Measure long-running incremental sync and full-account coverage against an independently known directory. Automated fixtures cannot establish remote completeness.
- [ ] Add Native Messaging registration instructions and installers for macOS and Linux before claiming browser-sync installation support on those systems.

Run `npm run precheck` for local changes. Do not place private transcripts or databases in verification records.
