# `agenthist doctor`

Check whether AgentHist can find history from supported Agents.

## Usage

```text
agenthist doctor [--agent <codex|claude|opencode|pi>]...
```

Repeat `--agent` to select multiple Agents. When omitted, AgentHist checks every supported Agent.

| Status | Meaning |
| --- | --- |
| `ready` | The requested history is readable |
| `not_detected` | No history was found for the Agent |
| `blocked` | A history location was found but cannot be read safely |
| `error` | The check failed |

The command does not create an AgentHist data directory or read message content. Use the [global path options](README.md#global-options) for custom history locations.
