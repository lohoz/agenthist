# `agenthist inspect`

Inspect the Agents, workspaces, and sessions in a `.agenthist` file.

## Usage

```text
agenthist inspect [file.agenthist] [--agent <codex|claude|opencode|pi>]...
                                   [--session <session-ref>]...
                                   [--limit <count>] [--cursor <cursor>]
```

In a terminal, omit the file to choose a `.agenthist` file from the current directory. A single file is opened directly; multiple files are listed newest first. Scripts and `--json` require an explicit file.

Repeat or combine `--agent` and `--session` to filter displayed content. AgentHist still validates the complete file and every stored object.

The command shows 50 sessions by default. `--limit` accepts 1 to 200. When another page is available, the output includes a `next cursor`; pass it unchanged to the next command:

```bash
agenthist inspect backup.agenthist --limit 50 --cursor <next-cursor>
```

Output includes the file summary, workspaces, and each session's source Agent, title, `session-ref`, AgentHist state, and resources for the current page.
