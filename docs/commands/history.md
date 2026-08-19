# `agenthist history`

Browse, search, and organize scanned sessions.

## Usage

```text
agenthist history list [--agent <agent>]... [--view <active|archived|deleted|all>]
                       [--offset <count>] [--limit <count>]
agenthist history search <query> [--agent <agent>]... [--view <view>]
                                 [--offset <count>] [--limit <count>]
agenthist history show <session-ref>
agenthist history rename <session-ref> --name <name>
agenthist history tag <session-ref> (--add <tag>|--remove <tag>)...
agenthist history archive|unarchive|delete|undelete <session-ref>
```

## Browse and search

```bash
agenthist history list --agent codex --view archived
agenthist history search "database migration"
agenthist history show <session-ref>
```

Repeat `--agent` to select multiple Agents. `list` and `search` show active sessions by default and return 50 entries starting at offset 0. `--offset` accepts up to 100000, and `--limit` accepts 1 to 1000. When more entries are available, the output includes the next offset.

A `session-ref` is AgentHist's unique identifier for a source session, such as `ahsr1_codex_ck1_7d4c...`. Find it in `list` or `search` output.

`--view` accepts:

| Value | Sessions |
| --- | --- |
| `active` | Regular sessions |
| `archived` | Archived sessions |
| `deleted` | Deleted sessions |
| `all` | All sessions |

`search` reports matched fields and text excerpts. `show` prints session metadata and saved conversation content.

## Organize sessions

```bash
agenthist history rename <session-ref> --name "New name"
agenthist history tag <session-ref> --add research --add writing --remove draft
agenthist history archive <session-ref>
agenthist history unarchive <session-ref>
agenthist history delete <session-ref>
agenthist history undelete <session-ref>
```

`--add` and `--remove` can be repeated and combined. `archive` and `unarchive` move sessions between active and archived; `delete` moves a session to deleted, and `undelete` restores its previous state.

Names, tags, and display states exist only in AgentHist. They do not change the original history of any Agent.
