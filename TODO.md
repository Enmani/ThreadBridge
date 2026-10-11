# Open tasks

- [ ] Investigate intermittent local fixture failures in the recent-head and mandatory-scope checks during a full-suite run. Isolated checks and the final full suite pass; the cause is not established. Strict assertions and synthetic failure diagnostics remain in place.

- [ ] Verify a clean Windows browser installation of the standalone repository, including login, ID-only discovery, passive archive and restart recovery. Record versions and anonymized results.
- [ ] Verify Claude and Gemini with real logged-in browser profiles: account/organization selection, old-history pagination, edits, rate limits and restart recovery. Synthetic protocol fixtures do not establish live compatibility.
- [ ] Verify compact dashboard and Settings in a real browser, including hover/focus bubbles, column sorting, light/dark, narrow screens and 200% zoom. Current development browser blocked the isolated preview with `ERR_BLOCKED_BY_CLIENT`.
- [ ] Establish Gemini long-conversation pagination before supporting responses at the 10,000-turn window. Current adapter rejects truncated windows and retains pending work.
- [ ] Measure first-download throughput and 429 frequency with a real account using the adaptive defaults; compare against the previous 90-second interval without removing saved history or resetting cooldowns. Login cache tests cover timing and scope changes, not every website login implementation.
- [ ] Measure long-running incremental sync and full-account coverage against an independently known directory. Automated fixtures cannot establish remote completeness.
- [ ] Measure binary indexing time, disk growth and query/summary usefulness on a real large local archive. Verify a real AI client's bottom-up summary workflow; synthetic tests establish mechanics only.
- [ ] Verify real OpenAI, Claude and Gemini API connections, supported text models, quotas and summary quality with explicit test accounts. Local HTTP protocol fixtures establish request conversion, not live cloud compatibility.

Local-model smoke check: the existing `qwen3.8-coder390` service completed a synthetic chat summary through the connection registry and worker. A 256-token output budget exhausted on reasoning; the compatible transport now reserves 1,024 tokens while retaining the 280-byte final-summary limit. This does not establish large-archive performance or semantic quality.
- [ ] Add Native Messaging registration instructions and installers for macOS and Linux before claiming browser-sync installation support on those systems.

Run `npm run precheck` for local changes. Do not place private transcripts or databases in verification records.
