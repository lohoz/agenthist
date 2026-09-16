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

It can also find recurring requirements, preferences, and working methods across sessions, then organize them into evidence-backed candidates for review, merging, and refinement. The GUI combines extraction and organization into one model request; the CLI also retains its incremental evidence workflow.

## ✨ Highlights

- **Unified history:** Browse, search, and organize sessions from supported Agents through one interface.
- **Continue with any Agent:** Pick a recent conversation and reopen it with its source Agent or another supported Agent.
- **Selective migration:** Export all history or filter by Agent, workspace, or session, then choose what to restore on the target machine.
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

For the CLI, Node.js 24 is required.

```bash
npm install -g agenthist
```

You can also run it with npx:

```bash
npx agenthist --help
```

### GUI desktop application

Download the package for your operating system and architecture from [GitHub Releases](https://github.com/lohoz/agenthist/releases/latest). AgentHist Desktop bundles Electron: **no Node.js installation or web server is needed**.

| Platform | Packages |
| --- | --- |
| Windows x64 | Setup.exe / Portable.exe |
| macOS Intel / Apple Silicon | x64 / arm64 DMG and application ZIP |
| Linux x64 / ARM64 | DEB, RPM and AppImage |

### CLI command line

The npm / npx commands above install the CLI for interactive terminal use, scripts and automation. GUI and CLI share history parsing, migration and transaction logic. Continuing a conversation requires the corresponding Agent to be installed locally. To use the CLI from this source version, run `npm run build && npm link`.

## 🖥️ GUI workflow

- **Chats:** A compact disk → directory → conversation tree groups every Agent under the same workspace, with search, bulk export and hidden-history recovery.
- **Continue:** Reopen a native session or preview a cross-Agent conversion. Converted sessions appear immediately in history.
- **Experience:** Select an Agent's existing API configuration, test the model, then preview all history or selected conversations. One model request produces final experience candidates; repeated context is compacted losslessly on the local machine.
- **Settings:** Grouped appearance, history providers, Agent paths, experience models and terminal settings. Codex provider unification supports preview, confirmation and transactional rollback.

<p align="center"><img src="readme-pic/public/history.png" alt="AgentHist history and directory tree" width="100%"></p>

| Cross-Agent continuation | Experience extraction |
| --- | --- |
| ![Conversion preview](readme-pic/public/conversion.png) | ![Experience preview](readme-pic/public/experience.png) |

<details>
<summary>Settings screenshot</summary>

![Settings](readme-pic/public/settings.png)

</details>

Screenshots use synthetic examples or redacted content, without private histories or API credentials.

## 🛠️ GUI build and packaging

```bash
git clone --branch ui https://github.com/lohoz/agenthist.git
cd agenthist
npm ci
npm run desktop:dev
```

Development requires Node.js 24. Run packaging on the target operating system:

```bash
npm run desktop:dist:win                 # Windows x64: EXE
npm run desktop:dist:mac -- --arm64      # Apple Silicon: DMG / ZIP
npm run desktop:dist:mac -- --x64        # Intel Mac: DMG / ZIP
npm run desktop:dist:linux -- --x64      # Linux: DEB / RPM / AppImage
npm run desktop:dist:linux -- --arm64    # Linux ARM64
```

Artifacts are written to `release/`; `npm run desktop:pack` creates only the unpacked application for the current host. DMG packaging requires macOS. See the [complete build guide](docs/desktop-build.md#english) for dependencies, installation, signing, verification and release automation. Community builds are unsigned and macOS is not notarized.

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
| [`resume`](docs/commands/resume.md) | Continue a conversation with any supported Agent |
| [`export`](docs/commands/export.md) | Create a `.agenthist` file |
| [`inspect`](docs/commands/inspect.md) | Inspect an exported file |
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

Refresh and browse interactively:

```bash
agenthist history # Refresh and browse local Agent history
```

The explicit commands remain available for scripts and exact operations:

```bash
agenthist scan
agenthist history list
agenthist history search "keyword"
agenthist history show <session-ref>
```

`scan` copies discovered history into AgentHist's local history library. Run it again whenever you want to add new or updated sessions.

A `session-ref` is AgentHist's unique identifier for a source session, such as `ahsr1_codex_ck1_7d4c...`. Find it in `history list` or `history search` output.

### Continue a conversation

Browse recent conversations and choose which Agent should continue one:

```bash
agenthist resume
agenthist resume --last
agenthist resume --last --agent claude
```

The current workspace is shown first. Choosing the source Agent opens its native session; choosing another Agent previews the conversion before creating and opening the target session. See [`agenthist resume`](docs/commands/resume.md).

## 🔄 Migration and conversion

Export on the source machine:

```bash
agenthist export # Refresh history and open interactive selection
```

For a direct export, update the scanned snapshot first:

```bash
agenthist scan
agenthist export --all -o backup.agenthist # Export all history
```

Bulk export includes every safely migratable session and reports anything skipped. For a partial export, use repeatable filters:

```bash
agenthist export --agent codex -o codex.agenthist
agenthist export --workspace ../api --workspace ../web -o projects.agenthist
agenthist export --session <session-ref> -o selected.agenthist
```

`--agent`, `--workspace`, and `--session` can be combined. An explicit `--session` selection is strict: the export fails instead of silently omitting that session.

After moving the file to the target machine, run:

```bash
agenthist inspect                  # Choose and inspect an AgentHist file
agenthist inspect backup.agenthist # Inspect a specific file
agenthist import                   # Choose a file and open interactive import
agenthist import backup.agenthist  # Open a specific file
```

All sessions are selected by default and routed back to their source Agents.

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

- `.agenthist` files contain chat content and related history data. Handle them as carefully as the original conversations.
- AgentHist handles history records only. It does not migrate Base URLs, API keys, tokens, OAuth data, or other connection settings.
- Run `agenthist help <command>` for help in the terminal.

See the [FAQ](docs/faq.md) for common questions. Release history, security reporting, and local-data handling are documented in the [changelog](CHANGELOG.md), [security policy](SECURITY.md), and [privacy guide](PRIVACY.md).

## Build from source

From the project directory:

```bash
npm ci
npm run build
npm link
agenthist --help
```

## Acknowledgments

Thanks to the [linuxdo community](https://linux.do/) for discussion, sharing, and feedback.

## License

[MIT](LICENSE)
