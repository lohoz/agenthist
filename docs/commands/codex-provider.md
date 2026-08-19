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
