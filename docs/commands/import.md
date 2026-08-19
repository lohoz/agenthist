# `agenthist import`

Restore sessions from a `.agenthist` archive, with optional conversion to another Agent format.

## Usage

```text
agenthist import <file.agenthist> [--dry-run|--apply]
                                  [--agent <agent>]... [--session <session-ref>]...
                                  [--to <agent>]
                                  [--target <agent>=<path>]...
                                  [--map-path <source>=<target>]...
                                  [--codex-provider <current|preserve|provider-id>]
                                  [--language <en|zh>]
```

## Interactive mode

```bash
agenthist import backup.agenthist
```

In a terminal, omitting `--dry-run` and `--apply` opens the import interface:

1. Select sessions and preview their contents.
2. Choose a target Agent for each session.
3. Confirm or change workspace paths.
4. Review the import plan and confirm the write.

The interface follows the terminal language by default. Press `l` to switch between English and Chinese, or use `--language en|zh` to choose the initial language. Only interface text is localized.

When provided, `--agent`, `--session`, `--to`, `--target`, and `--map-path` become the initial selections in the interface.

## Non-interactive mode

```bash
agenthist import backup.agenthist --dry-run
agenthist import backup.agenthist --apply
```

`--dry-run` creates a plan without writing. `--apply` validates the plan and writes it. Scripts, non-TTY environments, and `--json` mode require one of these flags. `--language` applies only to interactive mode.

## Selection and routing

All sessions are selected by default and routed to their source Agents.

| Option | Purpose |
| --- | --- |
| `--agent <agent>` | Filter by source Agent; repeatable |
| `--session <session-ref>` | Select an exact session; repeatable |
| `--to <agent>` | Route every selected session to one target Agent |
| `--target <agent>=<path>` | Set the target history root; one per Agent |
| `--map-path <source>=<target>` | Map workspace paths; repeatable |

```bash
agenthist import backup.agenthist --agent codex --to claude --dry-run
agenthist import backup.agenthist --map-path /old/project=/new/project --dry-run
```

For `--target`, paths refer to the Codex home, Claude Code configuration directory, OpenCode data root, or Pi session directory. Target workspaces must exist. Migration between POSIX and Windows paths requires `--map-path`.

## Codex provider

When any session targets Codex, choose its provider with:

```bash
--codex-provider current
--codex-provider preserve
--codex-provider <provider-id>
```

The default is the provider currently configured on the target machine. `preserve` keeps each source value; a provider ID selects that value explicitly. AgentHist does not modify `config.toml`.

## Import results

| Result | Meaning |
| --- | --- |
| `native` | Restored to the source Agent |
| `exact` | Converted with no known content loss |
| `degraded` | Some content was omitted or reconstructed; the session can still be imported |
| `blocked` | The session cannot be converted reliably |

`degraded` sessions can be written. If any selected session is `blocked`, the operation fails without writing. In interactive mode, exclude blocked sessions and preview again.

Duplicate sessions appear as `already on target`. Content conflicts are reported before writing. A successful write creates a [`transaction`](transaction.md).

See the [README](../../README.md#-migration-and-conversion) for a quick migration workflow.
