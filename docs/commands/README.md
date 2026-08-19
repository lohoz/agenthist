# Command reference

Run `agenthist <command> --help` for concise usage information.

| Command | Description |
| --- | --- |
| [`doctor`](doctor.md) | Check history locations and availability |
| [`scan`](scan.md) | Scan history from every supported Agent |
| [`history`](history.md) | Browse, search, and organize sessions |
| [`export`](export.md) | Create a `.agenthist` archive |
| [`inspect`](inspect.md) | Inspect and validate a `.agenthist` archive |
| [`import`](import.md) | Restore or convert sessions |
| [`experience`](experience.md) | Extract recurring experience across sessions |
| [`skill`](skill.md) | Install or remove the AgentHist Skill |
| [`codex provider`](codex-provider.md) | Inspect and unify Codex providers |
| [`transaction`](transaction.md) | Manage native-history write transactions |
| `help` | Show help for the root command or a specific command |
| `version` | Show the AgentHist version |

## Help and version

```bash
agenthist help [command]
agenthist import --help
agenthist version
agenthist --version
```

## Global options

Place global options before the command:

```text
--json                         Write JSON output
--state-dir <path>             Set the AgentHist data directory
--codex-home <path>            Set the Codex home directory
--codex-sqlite-home <path>     Set the Codex SQLite home directory
--codex-profile <name>         Set the Codex profile
--opencode-data-root <path>    Set the OpenCode data root
--opencode-db <path>           Set the OpenCode database
--claude-config-dir <path>     Set the Claude Code configuration directory
--pi-session-dir <path>        Set the Pi session directory
-h, --help                     Show help
-v, --version                  Show the version
```

The path options support Agent histories stored outside their default locations.

Examples:

```bash
agenthist --state-dir /data/agenthist scan
agenthist --json history list
```

## JSON and exit codes

`--json` uses the `agenthist.output/v1` envelope. Human-readable output may omit lengthy details; JSON retains the complete result.

| Code | Meaning |
| ---: | --- |
| `0` | Command succeeded |
| `2` | Invalid arguments or usage |
| `3` | Operation failed; `doctor` also uses this code when no history is detected |
| `4` | `doctor` found a history location but cannot read it safely |
| `9` | Internal error; `doctor` also uses this code when a check fails |
