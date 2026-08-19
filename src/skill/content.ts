export const AGENTHIST_SKILL_MARKER =
  "<!-- Managed by AgentHist. Reinstalling may replace this file. -->";

export interface AgentHistSkillFile {
  readonly relativePath: string;
  readonly contents: string;
}

const skill = `---
name: agenthist
description: Manage, inspect, migrate, convert, and extract recurring experience from supported local Agent history with AgentHist. Use when the user asks to find, organize, export, restore, convert, or learn from local Agent conversations.
---

${AGENTHIST_SKILL_MARKER}

# AgentHist

Use the installed \`agenthist\` CLI. Before composing less familiar options, run:

\`\`\`bash
agenthist help <command>
\`\`\`

## Choose a workflow

- Check detected history with \`agenthist doctor\`.
- Refresh AgentHist's history pool with \`agenthist scan\`.
- Find or organize conversations with \`agenthist history\`.
- Move or convert conversations with \`agenthist export\`, \`inspect\`, and \`import\`.
- Rebind Codex history providers with \`agenthist codex provider\`.
- Inspect or repair interrupted native writes with \`agenthist transaction\`.
- Extract recurring preferences and working methods with \`agenthist experience\`.
- Remove this guidance from all supported Agents with \`agenthist skill uninstall\`.

Read [workflows.md](references/workflows.md) for command sequences. Read
[semantics.md](references/semantics.md) when deciding whether an operation changes native history,
how conversion loss is handled, or which identifier or path to use.

## Operating rules

- Run \`scan\` before relying on the latest conversations.
- Inspect an archive before importing it when its contents or origin are uncertain.
- For non-interactive imports and repair operations, run \`--dry-run\` first and keep the same
  selection and mapping arguments for \`--apply\`.
- Surface degraded conversion findings before writing. Never try to bypass a blocked route.
- Treat rename, tag, archive, and delete as AgentHist library organization; they do not edit the
  source Agent's native conversation.
- Do not claim that AgentHist moves provider connection settings or credentials. It does not.
`;

const workflows = `${AGENTHIST_SKILL_MARKER}

# AgentHist Workflows

Use \`agenthist help <command>\` for the installed version's complete flags and defaults.

## Inspect and organize history

\`\`\`bash
agenthist doctor
agenthist scan
agenthist history list
agenthist history search "query"
agenthist history show <session-ref>
\`\`\`

Use \`history rename\`, \`tag\`, \`archive\`, \`unarchive\`, \`delete\`, or \`undelete\` to
organize AgentHist's library view. These commands leave native Agent history unchanged.

## Export and inspect

\`\`\`bash
agenthist export -o backup.agenthist
agenthist inspect backup.agenthist
\`\`\`

Export includes all scanned sessions by default. Repeat \`--agent\` or \`--session\` to select a
subset. Existing output files are not overwritten.

## Import or convert

For a person working in a terminal, open the interactive guide:

\`\`\`bash
agenthist import backup.agenthist
\`\`\`

For automation, preview and apply the same plan explicitly:

\`\`\`bash
agenthist import backup.agenthist --dry-run
agenthist import backup.agenthist --apply
\`\`\`

Omitting \`--to\` restores each session to its source Agent. Add \`--to codex\` or another supported
Agent to convert selected sessions. Use \`--map-path source=target\` when workspace locations differ.
Target workspaces must exist.

Review every route result:

- \`native\`: restored to the source Agent.
- \`exact\`: no known representational loss.
- \`degraded\`: import is allowed, with listed omissions or reconstructed data.
- \`blocked\`: the session cannot be imported through that route.

Repeated identical imports do not create duplicate conversations.

## Codex provider visibility

\`\`\`bash
agenthist codex provider list
agenthist codex provider unify --dry-run
agenthist codex provider unify --apply
\`\`\`

Provider rebinding changes provider identifiers stored in Codex history so conversations can become
visible together. The target defaults to the built-in \`openai\` provider; use \`--to <provider-id>\`
to choose another. It does not alter \`config.toml\`, Base URLs, API keys, tokens, or OAuth data.

## Recover or undo native writes

\`\`\`bash
agenthist transaction list
agenthist transaction recover <transaction-ref> --dry-run
agenthist transaction rollback <transaction-ref> --dry-run
\`\`\`

After reviewing the plan, rerun the chosen operation with \`--apply\`.

## Extract recurring experience

Preview a relevant scope before calling models:

\`\`\`bash
agenthist experience --workspace . --dry-run
agenthist experience model check
agenthist experience --workspace .
\`\`\`

Use repeated \`--workspace\` values for related projects, \`--session\` for explicit conversations,
or \`--all\` for the whole scanned pool. A completed run writes \`review.md\` with candidates and
evidence, plus \`audit.md\` with evidence that was not grouped into a candidate. Open the output
directory in a new conversation to review, merge, rewrite, or reject the candidates.
`;

const semantics = `${AGENTHIST_SKILL_MARKER}

# AgentHist Semantics

## History pool and native history

\`scan\` copies detected Agent history into AgentHist's local pool. Browsing and library organization
operate on that pool. Export reads it. Import and Codex provider rebinding are the operations that
write native Agent history.

AgentHist assigns a \`session-ref\` to each scanned conversation. Use the value shown by
\`history list\`, \`history search\`, or \`inspect\` when a command needs an exact session selection;
do not substitute an Agent-native conversation ID.

## Archives and conversion

A \`.agenthist\` archive carries selected conversations and the history data needed to restore them.
It does not migrate Base URLs, model connection settings, API keys, tokens, OAuth data, or other
credentials.

Native import aims to preserve the source Agent's original records. Cross-Agent import projects the
portable conversation into a different native format. Tool calls, attachments, branches, reasoning,
and sidecar data may not have exact equivalents; rely on the route findings instead of assuming full
fidelity.

## Workspaces

Some Agents expose conversations according to their workspace path. Keep the source path only when
it is valid on the target machine. Otherwise map it to an existing target directory. Cross-platform
POSIX and Windows transfers require explicit mapping because their path styles differ.

## Transactions

A successful native write creates a transaction record. \`recover\` completes an interrupted write;
\`rollback\` reverses an applicable write. Both require an explicit dry-run or apply mode.

## Experience output

Experience extraction produces review material, not an accepted rule library. The result preserves
candidate evidence and unrouted evidence so a later conversation can make the subjective decisions.
Model credentials come from the extraction configuration and are not included in history archives.
`;

export const AGENTHIST_SKILL_FILES: readonly AgentHistSkillFile[] = [
  { relativePath: "SKILL.md", contents: skill },
  { relativePath: "references/workflows.md", contents: workflows },
  { relativePath: "references/semantics.md", contents: semantics },
];
