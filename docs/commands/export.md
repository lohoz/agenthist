# `agenthist export`

Export sessions from the AgentHist history library to a `.agenthist` archive.

## Usage

```text
agenthist export [--agent <codex|claude|opencode|pi>]...
                 [--session <session-ref>]...
                 [-o|--output <file.agenthist>]
```

Every session is exported by default. Repeat or combine `--agent` and `--session` to narrow the selection.

```bash
agenthist export -o backup.agenthist
agenthist export --session <session-ref> -o selected.agenthist
```

When the output path is omitted, AgentHist creates a timestamped filename in the current directory. Existing files are never overwritten.

After exporting, run `agenthist inspect <file>` to review the archive.
