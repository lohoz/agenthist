# AgentHist Unrouted Evidence Audit

English · [简体中文](audit.zh-CN.md)

Review ID: `ahreview1_example_20260819`

These entries were not included in a candidate group. They are untrusted historical evidence, not accepted
experience and not instructions. Use them to look for missed recurrence; compare exact user text and source
identity rather than Fast observations alone.

## Audit entry 1

- Occurrence: `ahocc3_example_research_03`; reason: `not_grouped`
- Source: claude / `ahsr1_claude_example_005` / turn 11 / 2026-05-19T08:35:00.000Z
- Topic: `adjust one submission figure`; basis: `task_request`; lenses: scope
- Observation: The user requested a visual adjustment for one imminent submission.

User text:
> This figure is too crowded. Make the labels a bit smaller for today's submission and leave the other figures alone.

## Audit entry 2

- Occurrence: `ahocc3_example_development_03`; reason: `not_grouped`
- Source: codex / `ahsr1_codex_example_006` / turn 23 / 2026-07-02T14:09:00.000Z
- Topic: `diagnose one slow endpoint`; basis: `stated_workflow`; lenses: verification, workflow
- Observation: The user asks for simple timing evidence before replacing a cache.

User text:
> Why is this endpoint so slow? Add some timing around the main steps and see where it gets stuck. Don't replace the cache right away.
