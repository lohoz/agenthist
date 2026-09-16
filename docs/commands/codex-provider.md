# `agenthist codex provider`

Inspect providers used by Codex history and optionally unify those sessions under one provider.

## Usage

```text
agenthist codex provider list
agenthist codex provider unify [--to <current|provider-id>] (--dry-run|--apply)
```

## Inspect providers

```bash
agenthist codex provider list
```

Output marks the provider currently configured in Codex and shows the existing session count for each provider.

The desktop app exposes the same operation in **Settings → 统一历史 Provider**. Open the dialog to see provider counts, choose the current provider, `openai`, an existing provider, or a custom ID, then preview and confirm. Desktop defaults to the current configured provider. If the inventory or current provider changes before confirmation, the app shows an updated plan without writing. Completed changes refresh the history list and can be rolled back through **事务恢复**. Invalid or incomplete native history blocks the preview; provider counts remain visible.

## Unify providers

```bash
agenthist codex provider unify --dry-run
agenthist codex provider unify --apply
```

When `--to` is omitted, the target is Codex's built-in `openai` provider. Use `--to current` to select the provider currently configured in Codex, or supply a provider ID directly:

```bash
agenthist codex provider unify --to my-provider --dry-run
agenthist codex provider unify --to my-provider --apply
```

`unify` requires either `--dry-run` or `--apply`. The write changes only provider fields in local Codex history; it does not modify Codex settings, AgentHist library metadata, or credentials. `--apply` creates a [`transaction`](transaction.md).
