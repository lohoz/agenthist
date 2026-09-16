# Desktop verification

All automated checks use synthetic histories and isolated temporary state. Real user histories, credentials, build logs and machine-specific reports are excluded from Git.

| Check | Command |
| --- | --- |
| Core, renderer and E2E types | `npm run typecheck` |
| Shared core, preload and renderer build | `npm run build` |
| Core unit and integration tests | `npm test` after building |
| React component tests | `npm run test:desktop` |
| Combined source gate | `npm run verify` |
| Installed CLI package | `npm run smoke:package` |
| Packaged GUI launch | `node scripts/smoke-desktop-launch.mjs` after packaging |
| Windows interaction and transaction scenarios | `npm run test:e2e` |
| Windows installer/portable/install/uninstall checks | `npm run smoke:desktop-artifacts` |
| Long-running synthetic history mutations | `npm run soak:desktop -- --rounds 10 --sessions 1000` |

The release workflow tests source and packaged startup on Windows x64, macOS x64/ARM64 and Linux x64/ARM64. Linux startup runs under Xvfb. Smoke tests use a loopback debugging port to inspect a packaged application; normal application launches enable no server or remote debugging port.

The Windows E2E suite covers the compact directory tree, mixed Agents, merged subagent conversations, search, continuation, native transfer and rollback, provider unification, settings, direct model API checks against a local synthetic server, and one-request full-history experience extraction. Model tests normally use deterministic responses and make no requests to production APIs.

The source-only ZIP is generated with `git archive` from the release commit. Native installers are separate release assets. `SHA256SUMS.txt` is generated from the exact published artifacts, rather than keeping stale hashes in source documentation.

See [build and release instructions](desktop-build.md). Passing packaged startup is evidence that the native runtime opens the app and can query history; it is not a claim that every desktop environment, terminal emulator or OS version has been physically tested.
