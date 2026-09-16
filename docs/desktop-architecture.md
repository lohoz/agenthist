# AgentHist Desktop architecture

AgentHist Desktop brings the existing history engine to Windows, macOS and Linux without creating a second implementation of scanning, conversion, migration, or transaction safety.

## Decision

The desktop application uses Electron, React, TypeScript, Vite, Tailwind CSS, shadcn-style Radix primitives, and Lucide icons.

Electron is preferred over Tauri here because the existing product is a Node.js 24 TypeScript application with substantial use of `node:sqlite`, filesystem APIs, streaming archives, process launchers, and Agent-specific parsers. Electron can run those modules in its main process without a sidecar or a second Rust implementation. The selected Electron runtime must be tested for the exact `node:sqlite` API used by AgentHist before a build can be considered releasable.

The existing source layout remains the shared core. Moving it wholesale into a directory named `core` would add churn without improving the boundary:

```text
src/domain          stable values and contracts
src/agents          Agent-specific discovery, parsing, native formats, and launch specs
src/application     shared use cases and orchestration
src/infrastructure  snapshots, archives, SQLite, state locks, and transactions
src/experience      evidence extraction and review-pack generation
        │
        ├── src/cli      terminal adapter (retained)
        └── src/desktop  desktop facade, Electron main/preload, and React renderer
```

## Security boundary

```text
untrusted local history
        ↓
AgentHist parsers and application services (Electron main/worker)
        ↓ validated, bounded DTOs
typed IPC handlers
        ↓
context-isolated preload API
        ↓
sandboxed React renderer
```

The renderer has no Node.js, filesystem, environment, or arbitrary process access. Production windows use `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and `webSecurity: true`. Every IPC invoke must originate from the current window's main frame at the exact packaged `file://` renderer URL before arguments or service code are considered. IPC accepts product identifiers such as a validated AgentHist session reference, never an arbitrary command line. External links, Markdown links, and local paths are treated as untrusted input. Clipboard write is the only granted browser permission; it is limited to that same trusted frame, while clipboard read remains denied.

Packaged applications enable ASAR integrity and `OnlyLoadAppFromAsar`, and disable `NODE_OPTIONS`. `RunAsNode` remains enabled for one bounded reason: Windows Continue starts a runner from the application's own verified asar using the Electron-bundled Node runtime. It is never exposed through preload or renderer IPC.

Native writes retain the existing dry-run, duplicate/conflict classification, transaction, rollback, and recovery path. A desktop dialog is an adapter around those guarantees, not a shortcut around them.

## Desktop application facade

Electron main calls a desktop-oriented facade which in turn calls `src/application` APIs. It is responsible for:

- converting core values to small serializable DTOs;
- isolating per-Agent detection and refresh failures;
- serializing writes while continuing to serve the most recent successful read model;
- emitting typed progress events;
- keeping stateful import/export catalogs and temporary extraction directories out of IPC;
- mapping internal exceptions to stable, redacted desktop errors;
- resolving trusted Agent executables and creating safe launch plans;
- storing the small set of desktop preferences.

CLI JSON envelopes, ANSI renderers, TTY wizards, and shell strings are not reused as an IPC protocol.

## History performance model

The current v2 snapshot embeds every complete conversation in one `index.json`. Consequently, a 50-row list or one search currently parses the complete history of an Agent. Renderer virtualization alone cannot solve that cost.

Desktop therefore maintains a rebuildable local read index derived from the immutable AgentHist snapshots. It stores bounded summaries and searchable text by session/revision, supports indexed Agent/workspace filters and recent-first pagination, and stores conversation chunks addressable by stable item position. The source snapshots remain authoritative; the read index may be deleted and rebuilt without touching native Agent history.

Startup follows this order:

1. Open the last valid read index and show recent chats.
2. Detect sources and incrementally scan each ready Agent in the background.
3. Update the derived index for changed snapshots.
4. Publish a new list revision to the renderer.

One corrupt Agent or stale derived index produces a partial error and rebuild option; it must not blank healthy Agents. Search queries hit the local index and never trigger a source scan.

Long conversations are requested in chunks and window-rendered in React. Conversation search returns stable item positions so the renderer can fetch and reveal the matching chunk.

## Continue and process launch

Original-Agent Continue reuses `prepareResumeLaunch`. Cross-Agent Continue reuses `findExistingHistoryTransfer` and `transferHistorySession`, showing the core conversion findings before apply.

The CLI runner inherits its calling terminal. Desktop extracts the non-visual orchestration into a shared application service and adds a Windows launcher that detects or stores a trusted absolute terminal executable outside the workspace. Windows Terminal discovery prioritizes the stable per-user `Microsoft\WindowsApps\wt.exe` execution alias used by Explorer's packaged “Open in Terminal” integration; a versioned `Program Files\WindowsApps` launcher saved by an older build is validated and mapped back to that alias. The selected terminal receives a fixed PowerShell bootstrap and starts an Electron-bundled runner from the verified asar; that runner uses `cross-spawn` with `shell: false` and the original Agent argument array. Workspace paths, native IDs, environment, and Agent arguments travel through bounded one-time private files and are never interpolated into PowerShell source. A runner acknowledgement prevents the single-instance terminal process from being mistaken for a successful Agent launch. If no terminal can be detected, or the configured terminal does not acknowledge launch, Desktop returns an actionable Settings error and does not fall back to a different terminal. The normal background refresh discovers subsequent Agent changes.

Desktop import, refresh, resume, Experience, settings, and recovery operations enter one fair FIFO state gate. Shutdown closes admission, drains accepted work and temporary handles, persists the latest window bounds, and then quits. Transaction rollback accepts a newer snapshot head only when every recovery-relevant snapshot value is deeply equivalent; a real content change remains blocked.

## Experience scope

POSIX desktop launches use the configured terminal executable and literal argument array. Linux supports WezTerm, Alacritty, GNOME Terminal, Konsole and the system terminal alternative. macOS can use Terminal.app through a fixed AppleScript whose command values are passed as arguments and individually quoted, or a configured terminal emulator. No Agent prompt is interpolated into script source.

Desktop extraction uses one model request to produce the final experience candidates. Local preparation keeps every selected evidence record and losslessly shares repeated user and adjacent-context text through a text table when that encoding is smaller. Task and source identities remain separate; local validation binds every quoted source to its original conversation. The input budget follows the native model context configuration (Codex `model_context_window`, OpenCode model `limit.context`, or Pi model `contextWindow`) with output space and safety headroom reserved. Without capacity metadata, the default single-request input budget is 128,000 tokens; legacy 50,000/64,000 multi-stage defaults do not cap this path. There is no per-eight-card batching, topic consolidation request, model-based repair, or automatic retry. If even the lossless full input exceeds the configured capacity, the UI asks for a larger-context model or corrected capacity metadata, rather than asking users to discard conversations. The preview reports complete coverage, compression estimates and the effective budget.

Desktop Experience reads the selected Agent's current API configuration through its Agent module. Model checks and extraction share the same direct HTTP client for Responses, Chat Completions, and Messages; they do not start an Agent CLI. Checks make a small structured model request with no history and report the detected model, protocol, endpoint origin, duration, and HTTP failure status. Extraction accepts streaming responses with a 90-second inactivity timeout and a bounded overall request duration. Native connection files remain unchanged, and API credentials stay in the main process. OAuth-only or command-generated credentials that cannot be read as a direct API credential produce a configuration error instead of falling back to an unrelated endpoint.

The existing Experience domain produces a structured evidence-backed review pack and publishes `review.md` plus `audit.md`. It intentionally stops before accepting or rejecting candidates and has no persistent Accept/Edit/Merge/Ignore model.

The first desktop implementation exposes the real workflow: scope preview, model check, progress, generated candidates/evidence, source-session navigation, and opening the published review. It does not pretend that review decisions are already stored. Persistent decisions will only be added with an explicit domain and storage design plus tests.

## UI language

The CC-Switch reference was reviewed for its compact navigation, 8 px base radius, 32–40 px controls, neutral one-pixel borders, single blue accent, quiet secondary text, explicit selected/hover states, and light/dark tokens. AgentHist adopts those proportions, not its code, glass effects, logo, provider cards, or product structure.

The default route is Chats. The only primary navigation is Chats, Experience, and Settings. The central interaction remains Find → Read → Resume; migration tools live in contextual menus and dialogs rather than a dashboard.

## Verification gates

- Existing CLI build, tests, CLI smoke, and npm package smoke.
- Core read-index, corruption, conversion/resume planning, and transaction tests.
- Renderer component and accessibility tests.
- IPC contract/integration tests with temporary synthetic history only.
- Electron E2E with scan, search, detail, in-conversation find, dialogs, settings, and restart restoration.
- Windows packaged smoke for isolated unpacked, Portable, installed, and uninstalled forms with no source-tree ancestry, Node on PATH, localhost application server, or system Node dependency.
- Deterministic 1,000/10,000-session performance runs and repeated add/grow/delete/corrupt/index-mismatch/directory-missing/reopen soak cycles.

Concrete results, hashes, and environment limitations are recorded in [the Desktop verification report](desktop-verification.md).
