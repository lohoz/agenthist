# `agenthist export`

Export sessions from the AgentHist history library to a `.agenthist` archive.

## Usage

```text
agenthist export [--all]
                 [--agent <codex|claude|opencode|pi>]...
                 [--workspace <directory>]...
                 [--session <session-ref>]...
                 [-o|--output <file.agenthist>]
                 [--language <en|zh>]
```

Use `--all` for an explicit full export. `--agent`, `--workspace`, and `--session` are repeatable and can be combined to narrow the selection. Workspace values resolve from the current directory and match scanned workspace paths exactly.

```bash
agenthist export --all -o backup.agenthist
agenthist export --agent codex -o codex.agenthist
agenthist export --workspace ../api --workspace ../web -o projects.agenthist
agenthist export --session <session-ref-1> --session <session-ref-2> -o selected.agenthist
```

`--all` cannot be combined with a filter. Bulk export includes every safely migratable matching session and clearly lists anything skipped. An explicit `--session` selection is strict and fails if that session cannot be exported.

In a terminal, running the command without options opens the selection interface. `--language en|zh` selects its initial language. Scripts, non-TTY environments, and `--json` use direct export.

When the output path is omitted, AgentHist creates a timestamped filename in the current directory. Existing files are never overwritten.

After exporting, run `agenthist inspect <file>` to review the archive.
