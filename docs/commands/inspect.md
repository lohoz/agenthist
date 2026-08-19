# `agenthist inspect`

Inspect the Agents, workspaces, and sessions in a `.agenthist` archive.

## Usage

```text
agenthist inspect <file.agenthist> [--agent <codex|claude|opencode|pi>]...
                                   [--session <session-ref>]...
                                   [--limit <count>] [--cursor <cursor>]
```

Repeat or combine `--agent` and `--session` to filter displayed content. AgentHist still validates the complete archive and every stored object.

The command shows 50 sessions by default. `--limit` accepts 1 to 200. When another page is available, the output includes a `next cursor`; pass it unchanged to the next command:

```bash
agenthist inspect backup.agenthist --limit 50 --cursor <next-cursor>
```

Output includes the archive summary, workspaces, and each session's source Agent, title, `session-ref`, AgentHist state, and resources for the current page.
