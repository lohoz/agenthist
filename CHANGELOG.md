# Changelog

All notable changes to AgentHist are documented in this file. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-16

### Added

- Add packaged Windows, macOS and Linux desktop applications with a sandboxed renderer, searchable local history index, conversation reading, transfer, resume, recovery, Experience, and settings flows.
- Add EXE, DMG, application ZIP, AppImage, DEB and RPM release targets, source ZIP and checksums, with native package launch checks. Community packages are unsigned.

- Add compact cross-Agent workspace trees, Agent logos, Settings provider unification and one-request Experience extraction using detected native API configuration.

### Changed

- Add an explicit, opt-in lossy conversion path to Desktop import and continuation flows. It retains safe user and assistant text when a full cross-Agent conversion is blocked and reports omitted content before writing; the CLI continues to block lossy routes.
- Extend conversion and resume planning so Desktop and CLI use the same validation, dry-run, transaction, rollback, and recovery guarantees.
- Make empty, filtered, first-run, and hidden-history states actionable; improve dense settings and conversion text legibility; and present conversion findings as user-facing Chinese explanations instead of internal codes.
- Add an active/hidden conversation view so AgentHist-only hides can be found and restored without touching native Agent history.

### Fixed

- Forward the explicit lossy-conversion choice through the real `.agenthist` archive import path.
- Isolate damaged Agent sources and derived indexes so healthy history remains available and can be rebuilt safely.
- Distinguish unsupported Claude transcripts from filesystem and unexpected failures so transient read errors cannot silently remove sessions from a new snapshot.
- Prevent stale refresh, selection, conversation, transaction, workspace-mapping, and import responses from replacing newer Desktop state or hiding a completed import.
- Reload an open conversation when its source revision changes without cancelling an in-flight resume plan.
- Keep `ELECTRON_RUN_AS_NODE` out of the selected Windows terminal process, strengthen bootstrap cleanup, and reject linked Desktop settings directories.
- Report an actionable Node.js 24 requirement before loading unsupported SQLite APIs.
- Harden process launch, shutdown draining, snapshot-equivalence checks, conversion planning, and long-conversation handling.

[0.3.0]: https://github.com/lohoz/agenthist/compare/v0.2.2...v0.3.0
