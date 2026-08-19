# `agenthist experience`

Extract recurring experience candidates and their source evidence from scanned history.

## Usage

```text
agenthist experience [--dry-run]
                     [--workspace <directory>]...
                     [--session <session-ref>]... [--all]
                     [--agent <agent>]... [--since <date>]
                     [--max-input-tokens <count>]
                     [--max-deep-input-tokens <count>]
                     [--request-input-tokens <count>]
                     [-o|--output <directory>]
agenthist experience model check
```

## History scope

| Option | Purpose |
| --- | --- |
| `--workspace <directory>` | Select a workspace directory tree; repeatable |
| `--session <session-ref>` | Select a session; repeatable |
| `--all` | Select all history |
| `--agent <agent>` | Filter by Agent; repeatable |
| `--since <date>` | Restrict the date range |

`--workspace`, `--session`, and `--all` are mutually exclusive. When all three are omitted, the current workspace is used. Active and archived sessions are included; deleted sessions are excluded.

## Execution modes

`--dry-run` reports the scope, index changes, request count, and estimated tokens. It does not read model settings, write output, or send network requests. It cannot be combined with `--output`.

`agenthist experience model check` validates the model settings and connection without sending history content.

## Model settings

Settings are read in this order: process environment, `.env.agenthist` in the current directory, then `.env` in the current directory.

| Variable | Default and purpose |
| --- | --- |
| `AGENTHIST_EXPERIENCE_BACKEND` | `api`; local Agent CLIs: `codex`, `claude`, `opencode`, `pi` |
| `AGENTHIST_EXPERIENCE_BASE_URL` | Required by `api` |
| `AGENTHIST_EXPERIENCE_API_KEY` | Required by `api` |
| `AGENTHIST_EXPERIENCE_FAST_MODEL` | Required by `api`; local Agents use their default model when omitted |
| `AGENTHIST_EXPERIENCE_DEEP_MODEL` | Reuses the fast model when omitted |
| `AGENTHIST_EXPERIENCE_DEEP_BASE_URL` | Reuses the main Base URL; only applies with a deep model |
| `AGENTHIST_EXPERIENCE_DEEP_API_KEY` | Reuses the main API key; required when the deep endpoint has another origin |

The minimum API configuration is:

```dotenv
AGENTHIST_EXPERIENCE_BASE_URL=https://example.com/v1
AGENTHIST_EXPERIENCE_API_KEY=your-key
AGENTHIST_EXPERIENCE_FAST_MODEL=fast-model
```

Add a deep model to use two models on the same endpoint. To use another service for the deep stage, also set its Base URL and API key:

```dotenv
AGENTHIST_EXPERIENCE_DEEP_MODEL=deep-model
AGENTHIST_EXPERIENCE_DEEP_BASE_URL=https://deep.example.com/v1
AGENTHIST_EXPERIENCE_DEEP_API_KEY=your-deep-key
```

A configured local Agent CLI needs only one setting:

```dotenv
AGENTHIST_EXPERIENCE_BACKEND=codex
```

Choose an Agent CLI listed above. Add `AGENTHIST_EXPERIENCE_FAST_MODEL` and `AGENTHIST_EXPERIENCE_DEEP_MODEL` only when specific models are needed; their values are passed directly to the CLI.

When no AgentHist model setting exists, AgentHist checks supported local Agent CLIs in its built-in order. The first CLI that returns the expected result is saved in a minimal template; if none works, AgentHist writes an API template and exits. The check sends a real model request without history and may incur a small provider charge.

## Provider compatibility

The API backend uses OpenAI-compatible Chat Completions. The endpoint must accept Bearer authentication, `messages`, `max_completion_tokens`, and strict JSON Schema in `response_format`, then return text in `choices[0].message.content`.

Agent CLIs use their active authentication, model, and provider configuration, including a third-party Base URL and API key already configured for that Agent. AgentHist does not read or copy those credentials. Codex runs ephemerally with execution tools and hooks disabled; Claude Code uses safe mode with tools and session persistence disabled; OpenCode uses a temporary no-tools agent and session database; Pi uses no-session print mode with tools and local resources disabled. No analysis session is retained. AgentHist API Base URLs and keys are never passed to Agent CLIs.

AgentHist parses and validates every result locally. Run `agenthist experience model check` to verify the selected backend and each distinct model profile without sending history.

## Output

Use `-o` or `--output` to set the output directory. When omitted, AgentHist creates an `agenthist-experience-*` directory in the current directory. Existing directories are never overwritten.

| File | Contents |
| --- | --- |
| `review.md` | Candidates, evidence, source excerpts, and a review prompt |
| `audit.md` | Evidence that was not included in a candidate group |

See the fully synthetic [review](../examples/experience/review.md) and
[audit](../examples/experience/audit.md) examples for representative research and software-development results.
Chinese translations are also available for the [review](../examples/experience/review.zh-CN.md) and
[audit](../examples/experience/audit.zh-CN.md).

Use the result directory as context in a new conversation to review, merge, rewrite, or reject candidates.

Evidence indexes and model results are cached for unchanged sessions.

## Input budgets

| Option | Default |
| --- | ---: |
| `--max-input-tokens` | 50000 |
| `--max-deep-input-tokens` | 128000 |
| `--request-input-tokens` | 64000 |

All three options accept non-negative integers.

See the [README](../../README.md#-experience-extraction) for a quick workflow.
