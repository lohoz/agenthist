# `agenthist scan`

Copy local Agent history into the AgentHist history library.

## Usage

```text
agenthist scan [--agent <codex|claude|opencode|pi>]...
```

Repeat `--agent` to select multiple Agents. When omitted, AgentHist scans every detected Agent.

Running the command again reuses unchanged sessions and refreshes new, changed, or removed sources. The result reports how many sessions were reused, rebuilt, and removed. If no history is found, the command exits successfully with an informational message.

The scan updates only the AgentHist data directory. Original Agent history remains unchanged.
