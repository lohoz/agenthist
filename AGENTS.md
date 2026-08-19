# AgentHist Repository Guide

## Scope

AgentHist manages, searches, exports, imports, migrates, and converts history from supported local coding Agents. It also extracts recurring experience and installs the AgentHist usage skill.

History metadata such as Codex provider bindings may be rewritten. Connection settings and credentials, including base URLs, API keys, tokens, and OAuth data, are outside the product scope.

## Structure

- `src/agents`: Agent-specific formats, discovery, conversion, and native storage.
- `src/domain`: Shared types and contracts.
- `src/application`: Use cases and orchestration.
- `src/infrastructure`: Filesystem, SQLite, archives, state, and transactions.
- `src/cli`: Commands and interactive terminal flows.
- `src/experience`: Experience extraction.
- `src/skill`: AgentHist skill installation.
- `tests`: All automated tests.

## Design Rules

- Keep Agent-specific behavior inside its corresponding module under `src/agents`.
- Move code into shared layers only when the underlying behavior is genuinely common.
- Detect storage formats and capabilities instead of branching on Agent release versions.
- Do not add speculative fallbacks or compatibility code for behavior that has not been released.
- Keep changes focused and avoid abstractions or dependencies without an immediate use.

## Data Safety

- Scanning and library overlay operations must not modify native Agent history.
- Native imports must remain transactional and support dry-run, rollback, and recovery.
- Do not migrate or modify Agent connection settings or credentials.

## Verification

- Keep all tests under `tests` and use deterministic, synthetic fixtures.
- Do not require credentials, network access, or real user history in the normal test suite.
- Run verification in proportion to the change. Use `npm run verify` for product code and `npm run smoke:package` for package or distribution changes.
- Avoid redundant gates and unnecessarily large test matrices.

## Git Workflow

- Use Conventional Commits with these types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, and `chore`.
- Use `main` for stable releases and `develop` for integration work.
- Name working branches `feature/<name>`, `bugfix/<name>`, `hotfix/<name>`, or `release/<version>`.
- Rebase a working branch onto its target branch before merging.
- Merge completed working branches with `git merge --no-ff`.
- Preserve existing user changes and never use destructive Git commands without explicit approval.
- Do not commit or push unless the user explicitly requests it.
