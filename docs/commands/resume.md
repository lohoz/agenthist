# `agenthist resume`

Continue a captured conversation with its source Agent or another supported Agent.

## Usage

```text
agenthist resume
agenthist resume --last [--agent <codex|claude|opencode|pi>]
agenthist resume --session <session-ref> [--agent <agent>]
```

`agenthist resume` refreshes local history, opens a single-session browser, and asks which Agent should continue the conversation. The current workspace and its newest sessions are shown first.

```bash
agenthist resume                  # Browse conversations
agenthist resume --last           # Continue the latest conversation
agenthist resume --last --agent pi
```

The source Agent opens its existing native session. A different target Agent runs the same conversion preflight and transactional write used by import. Known losses are shown before confirmation; blocked conversions are not written.

The selected target Agent CLI must be installed and available on `PATH`. AgentHist checks this before writing a converted session.

When the same captured revision already has a converted target, `resume` reopens that target instead of creating a duplicate.

When the Agent exits, AgentHist refreshes that Agent's history. Use `--session` when an exact AgentHist session reference is already available.
