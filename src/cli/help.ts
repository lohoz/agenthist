import { colorizeHuman } from "./command-support.js";

const commands = [
  ["doctor", "Inspect supported Agent history sources"],
  ["scan", "Capture history from every detected Agent"],
  ["history", "List, search, show, and organize captured history"],
  ["experience", "Extract recurring experience from captured history"],
  ["skill", "Install or remove AgentHist usage guidance"],
  ["export", "Export captured history and report skipped sessions"],
  ["inspect", "Inspect an .agenthist file without importing it"],
  ["import", "Restore or convert history from an .agenthist file"],
  ["codex", "Manage Codex-specific history, including provider rebinding"],
  ["transaction", "List, roll back, or recover native writes"],
  ["help", "Show help for one command"],
  ["version", "Show the AgentHist version"],
] as const;

const commandHelpText: Readonly<Record<string, string>> = {
  doctor: `Usage:
  agenthist doctor [--agent <codex|claude|opencode|pi>]...

Inspect detected history sources without creating AgentHist state or reading chat bodies.
The default is every supported Agent.
`,
  scan: `Usage:
  agenthist scan [--agent <codex|claude|opencode|pi>]...

Copy detected native history into the local AgentHist history pool.
The default is every detected Agent; --agent is an optional filter.
`,
  history: `Usage:
  agenthist history list [--agent <agent>]... [--view <active|archived|deleted|all>]
                         [--offset <count>] [--limit <count>]
  agenthist history search <query> [--agent <agent>]... [--view <view>]
                                   [--offset <count>] [--limit <count>]
  agenthist history show <session-ref>
  agenthist history rename <session-ref> --name <name>
  agenthist history tag <session-ref> (--add <tag>|--remove <tag>)...
  agenthist history archive|unarchive|delete|undelete <session-ref>

Browse or organize the scanned history pool. Organizing changes only AgentHist's library
overlay; it never modifies the Agent's native history. List/search default to active,
offset 0, and limit 50; limit may be at most 1000. Results report the current page,
remaining count, and next offset when another page exists.
`,
  experience: `Usage:
  agenthist experience [--dry-run]
                       [--workspace <directory>]...
                       [--session <session-ref>]... [--all]
                       [--agent <agent>]... [--since <date>]
                       [--max-input-tokens <count>]
                       [--max-deep-input-tokens <count>]
                       [--request-input-tokens <count>]
                       [-o|--output <directory>]
  agenthist experience model check

The command builds or reuses the history evidence index. With no scope option it uses the current
directory as its workspace; repeat --workspace for several directory trees, repeat --session
for exact sessions, or use --all explicitly. Dry-run reports the bounded plan without model
configuration, output files, or network requests. A complete run uses the fast model for
evidence and the deep model for candidate organization, then writes review.md with candidates
and source material plus audit.md with unrouted evidence. Give that directory to any AI;
AgentHist does not accept, reject, store, or otherwise constrain the review result. Models can
run through a compatible Chat Completions endpoint or a supported local Agent CLI.
Model check sends no history.
`,
  skill: `Usage:
  agenthist skill install [--agent <codex|claude|opencode|pi>]... [--force]
  agenthist skill uninstall

Install the AgentHist usage Skill. The default is every supported Agent;
--agent is an optional filter. Reinstalling updates content managed by AgentHist.
An existing skill with the same name is preserved unless --force is given.

Uninstall removes AgentHist-managed copies from all supported locations. Custom content with the
same skill name is preserved.
`,
  export: `Usage:
  agenthist export [--agent <agent>]... [--session <session-ref>]... [-o <file.agenthist>]

Export a portable .agenthist file from scanned history. Bulk export includes every safely
migratable session and reports anything skipped. --agent is an optional bulk filter.
An explicit --session selection is strict and fails if that session cannot be exported.
Existing output files are never overwritten.
`,
  inspect: `Usage:
  agenthist inspect <file.agenthist> [--agent <agent>]... [--session <session-ref>]...
                    [--limit <count>] [--cursor <cursor>]

Deeply validate an archive and show a bounded entry list without importing it.
Each row identifies the source Agent. The workspace summary lists every source path so
cross-machine mappings can be prepared without opening native archive metadata.
Filters and pagination affect presentation only; validation still covers the whole file.
The default limit is 50 and the maximum is 200.
`,
  import: `Usage:
  agenthist import <file.agenthist> [--dry-run|--apply]
                   [--agent <agent>]... [--session <session-ref>]...
                   [--to <agent>]
                   [--target <agent>=<path>]... [--map-path <source>=<target>]...
                   [--codex-provider <current|preserve|provider-id>]
                   [--language <en|zh>]

Import every archive entry by default. --agent selects source Agents and --session selects
exact source session references. Without --to, each session returns to its source Agent;
with --to, every selected session is restored or projected to that Agent. In a terminal,
omitting --dry-run and --apply opens the import guide for browsing, previewing, selecting,
mapping, planning, and one final confirmation. --dry-run plans without writing and --apply
executes after the same full preflight; scripts and --json must choose one explicitly.
The interactive guide follows the terminal locale, can switch languages with l, and accepts
--language for an explicit English or Chinese start. Non-interactive output remains English.
Repeated identical imports do not create duplicate conversations. Codex history binds to
the target's current provider unless --codex-provider says otherwise.
Without --map-path, source workspace paths remain unchanged only when source and target use
the same path style. POSIX/Windows transfers require an explicit mapping. Every selected Agent's
final workspace must exist so restored sessions remain visible in its normal workspace view.
Every path decision is shown before the session summary.
Degraded routes report their known findings and may be applied; blocked routes return nonzero
and write nothing. JSON includes complete route, session, workspace, resource, and transaction results.
`,
  codex: `Usage:
  agenthist codex provider list
  agenthist codex provider unify [--to <current|provider-id>] (--dry-run|--apply)

Inspect or rebind provider identifiers stored in Codex history. Rebinding changes history
visibility only; it never migrates Base URLs, API keys, tokens, OAuth, or connection settings.
The target defaults to the built-in openai provider when --to is omitted.
`,
  transaction: `Usage:
  agenthist transaction list
  agenthist transaction rollback <transaction-ref> (--dry-run|--apply)
  agenthist transaction recover <transaction-ref> (--dry-run|--apply)

Inspect and safely finish or undo native history writes. Rollback and recover always require
an explicit execution mode.
`,
  help: `Usage:
  agenthist help [command]
  agenthist <command> --help

Show root help or concise help for one public command.
`,
  version: `Usage:
  agenthist version
  agenthist --version

Show the AgentHist version.
`,
};

function renderCommandHelp(text: string, color: boolean): string {
  return text.split("\n").map((line) => {
    if (line === "Usage:") return colorizeHuman(line, "section", color);
    if (line.startsWith("  agenthist ")) {
      return `  ${colorizeHuman("agenthist", "info", color)}${line.slice("  agenthist".length)}`;
    }
    return line;
  }).join("\n");
}

export function rootHelp(color = false): string {
  const commandLines = commands
    .map(([name, description]) => `  ${colorizeHuman(name.padEnd(12), "info", color)}${description}`)
    .join("\n");

  return `${colorizeHuman("AgentHist", "strong", color)} manages, migrates, and extracts recurring experience from local Agent history.

${colorizeHuman("Usage:", "section", color)}
  ${colorizeHuman("agenthist", "info", color)} [global options] <command>

${colorizeHuman("Commands:", "section", color)}
${commandLines}

${colorizeHuman("Common global options:", "section", color)}
  --json              Emit a stable JSON result envelope
  --state-dir <path>  Use another AgentHist state directory
  -h, --help          Show help
  -v, --version       Show version

${colorizeHuman("Run 'agenthist help <command>' for command usage and defaults.", "muted", color)}
`;
}

export function commandHelp(command: string, color = false): string | undefined {
  const help = commandHelpText[command];
  return help === undefined ? undefined : renderCommandHelp(help, color);
}
