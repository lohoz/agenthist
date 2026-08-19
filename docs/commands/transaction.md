# `agenthist transaction`

Inspect and manage native-history write transactions created by AgentHist.

## Usage

```text
agenthist transaction list
agenthist transaction rollback <transaction-ref> (--dry-run|--apply)
agenthist transaction recover <transaction-ref> (--dry-run|--apply)
```

| Action | Description |
| --- | --- |
| `list` | Show each transaction's Agent, status, phase, direction, time, change count, and failure details |
| `rollback` | Undo sessions or provider changes written by a transaction |
| `recover` | Handle an interrupted write whose status is `needs_recovery` |

`rollback` and `recover` require either `--dry-run` or `--apply`. A dry run reports readiness and conflicts. The operation stops if the target history has changed.
