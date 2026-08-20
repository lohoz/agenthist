<div align="center">
  <h1>AgentHist</h1>
  <p><strong>Local coding Agent history management, migration, conversion, and cross-session experience extraction.</strong></p>
  <p>English | <a href="README.zh-CN.md">简体中文</a></p>
  <p>
    <a href="https://www.npmjs.com/package/agenthist"><img alt="npm" src="https://img.shields.io/npm/v/agenthist?label=npm"></a>
    <a href="https://github.com/lohoz/agenthist/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue"></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey">
  </p>
</div>

## Overview

AgentHist brings sessions from supported coding Agents into one place for browsing, searching, exporting, and selective importing. It supports cross-machine migration within the same Agent and conversion between Agents.

It can also find recurring requirements, preferences, and working methods across sessions, then organize them into evidence-backed candidates for review, merging, and refinement. Incremental processing and tiered model calls reduce the cost of repeated analysis.

## ✨ Highlights

- **Unified history:** Browse, search, and organize sessions from supported Agents through one interface.
- **Selective migration:** Export by Agent or session, preview the archive on another machine, and choose what to restore.
- **Cross-Agent conversion:** Choose a target Agent during import and see what each conversion preserves, omits, or reconstructs.
- **Safe writes:** Detect duplicate sessions, report conflicts before writing, and recover or roll back changes through transactions.
- **Cross-session experience extraction:** Find recurring requirements and working methods while retaining source evidence and ungrouped samples.

## 🤖 Supported Agents

| Agent | Browse and search | Same-Agent migration | Convert to other Agents |
| --- | --- | --- | --- |
| [Codex](https://github.com/openai/codex) | ✓ | ✓ | ✓ |
| [Claude Code](https://github.com/anthropics/claude-code) | ✓ | ✓ | ✓ |
| [OpenCode](https://github.com/anomalyco/opencode) | ✓ | ✓ | ✓ |
| [Pi](https://github.com/earendil-works/pi) | ✓ | ✓ | ✓ |

## 📦 Installation

Node.js 24 is required.

```bash
npm install -g agenthist
```

You can also run it with npx:

```bash
npx agenthist --help
```

## Let Agents use AgentHist

Install the AgentHist Skill so supported Agents can choose the appropriate commands when managing, migrating, or extracting knowledge from history:

```bash
agenthist skill install
```

The Skill is installed for every supported Agent by default. Repeat `--agent` to select specific Agents. Remove it with `agenthist skill uninstall`; see [`agenthist skill`](docs/commands/skill.md) for details.

## ⌨️ Commands

| Command | Purpose |
| --- | --- |
| [`doctor`](docs/commands/doctor.md) | Check local Agent history locations |
| [`scan`](docs/commands/scan.md) | Update the AgentHist history library |
| [`history`](docs/commands/history.md) | Browse, search, and organize sessions |
| [`export`](docs/commands/export.md) | Create a `.agenthist` archive |
| [`inspect`](docs/commands/inspect.md) | Inspect an exported archive |
| [`import`](docs/commands/import.md) | Restore sessions or convert them to another Agent |
| [`experience`](docs/commands/experience.md) | Extract recurring experience from history |
| [`skill`](docs/commands/skill.md) | Install or remove the AgentHist Skill |
| [`codex provider`](docs/commands/codex-provider.md) | Organize Codex sessions by provider |
| [`transaction`](docs/commands/transaction.md) | Inspect, roll back, and recover write operations |

See the [command reference](docs/commands/README.md) for the complete index.

## 🗂️ Manage history

Check local history locations before the first scan:

```bash
agenthist doctor
```

Then scan, browse, and search:

```bash
agenthist scan
agenthist history list
agenthist history search "keyword"
agenthist history show <session-ref>
```

`scan` copies discovered history into AgentHist's local history library. Run it again whenever you want to add new or updated sessions.

A `session-ref` is AgentHist's unique identifier for a source session, such as `ahsr1_codex_ck1_7d4c...`. Find it in `history list` or `history search` output.

## 🔄 Migration and conversion

Update the history library and export it on the source machine:

```bash
agenthist scan
agenthist export -o backup.agenthist
```

`export` includes every safely migratable session by default and reports anything skipped. Filter by Agent or `session-ref` when you only need part of the history:

```bash
agenthist export --agent codex -o codex.agenthist
agenthist export --session <session-ref> -o selected.agenthist
```

An explicit `--session` selection is strict: the export fails instead of silently omitting that session.

After moving the file to the target machine, run:

```bash
agenthist inspect backup.agenthist
agenthist import backup.agenthist
```

`import` opens an interactive interface for selecting sessions, target Agents, workspace paths, and the final write plan. All sessions are selected by default and routed back to their source Agents.

### Workspace paths

Each session records its source workspace. If the directory differs on the target machine, choose a new location interactively or provide a path mapping:

```bash
agenthist import backup.agenthist --dry-run \
  --map-path /home/alice/projects=/Users/alice/work
```

Target directories must exist. A path mapping is required when migrating between Windows and Linux or macOS.

### Convert between Agents

The interactive import lets you choose a target Agent per session. For scripts, use `--to` to convert all selected sessions. Preview first, then apply the same plan:

```bash
agenthist import backup.agenthist --to claude --dry-run
agenthist import backup.agenthist --to claude --apply
```

Native migration preserves the Agent's original records. Cross-Agent conversion lists omitted or reconstructed content before writing; sessions that cannot be converted reliably are blocked.

See [`agenthist import`](docs/commands/import.md) for details.

## 🧠 Experience extraction

Find recurring requirements, preferences, and working methods across sessions while retaining source evidence for every candidate.

### Select history

```bash
agenthist experience --all --dry-run
agenthist experience --workspace ../api --workspace ../web --dry-run
agenthist experience --session <session-ref> --dry-run
```

Process all history, one or more workspaces, or selected sessions. `--dry-run` shows the scope, model request count, and estimated tokens without contacting a model.

### Configure models

On first use, AgentHist checks supported local Agent CLIs with a small request that contains no history. It saves the first working CLI in `.env.agenthist`; if none works, it creates an API template.

To choose a configured local Agent CLI:

```dotenv
AGENTHIST_EXPERIENCE_BACKEND=codex # or another supported Agent CLI
```

The Agent CLI's default model is used unless `AGENTHIST_EXPERIENCE_FAST_MODEL` or `AGENTHIST_EXPERIENCE_DEEP_MODEL` is set.

For an OpenAI-compatible API:

```dotenv
AGENTHIST_EXPERIENCE_BACKEND=api
AGENTHIST_EXPERIENCE_BASE_URL=https://example.com/v1
AGENTHIST_EXPERIENCE_API_KEY=your-key
AGENTHIST_EXPERIENCE_FAST_MODEL=fast-model

# Optional
AGENTHIST_EXPERIENCE_DEEP_MODEL=deep-model
```

The fast model extracts evidence; the optional deep model organizes candidates across sessions. Without a deep model, the fast model handles both stages.

```bash
agenthist experience model check
```

This checks the selected backend without sending history. See [`agenthist experience`](docs/commands/experience.md) for all model settings.

### Review the results

After checking the scope and model settings, run:

```bash
agenthist experience --all
```

By default, AgentHist creates an `agenthist-experience-*` directory in the current directory:

| File | Contents | Example |
| --- | --- | --- |
| `review.md` | Candidates and supporting evidence | [View](docs/examples/experience/review.md) |
| `audit.md` | Evidence that was not included in a candidate group | [View](docs/examples/experience/audit.md) |

Start a new conversation with the complete result directory to review, merge, rewrite, or reject candidates against the evidence.

Repeated runs reuse the local evidence index and cached model results for unchanged sessions. See [`agenthist experience`](docs/commands/experience.md) for scope selection, model variables, and input budgets.

## Notes

- `.agenthist` archives contain chat content and related history data. Handle them as carefully as the original conversations.
- AgentHist handles history records only. It does not migrate Base URLs, API keys, tokens, OAuth data, or other connection settings.
- Run `agenthist help <command>` for help in the terminal.

See the [FAQ](docs/faq.md) for common questions.

## Build from source

From the project directory:

```bash
npm ci
npm run build
npm link
agenthist --help
```

## License

[MIT](LICENSE)
