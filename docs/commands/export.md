# `agenthist export`

Export sessions from the AgentHist history library to a `.agenthist` archive.

## Usage

```text
agenthist export [--agent <codex|claude|opencode|pi>]...
                 [--session <session-ref>]...
                 [-o|--output <file.agenthist>]
```

Bulk export includes every safely migratable session and clearly lists anything skipped. Repeat `--agent` to narrow the bulk selection. An explicit `--session` selection is strict and fails if that session cannot be exported.

```bash
agenthist export -o backup.agenthist
agenthist export --session <session-ref> -o selected.agenthist
```

When the output path is omitted, AgentHist creates a timestamped filename in the current directory. Existing files are never overwritten.

After exporting, run `agenthist inspect <file>` to review the archive.
