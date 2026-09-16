# Security Policy

## Supported versions

Security fixes are made for the latest published release and the current `main` branch. Older releases should be upgraded before a report is evaluated.

## Reporting a vulnerability

Use GitHub's private **Report a vulnerability** flow for this repository. Do not open a public issue for a suspected vulnerability and do not attach real Agent history, credentials, access tokens, or unredacted filesystem paths. A small synthetic reproduction is preferred.

Useful reports include the affected AgentHist version and platform, the security boundary crossed, impact, and reproducible steps. High-value areas include archive parsing, native-history writes and recovery, path handling, Electron IPC, external links, and process launch.

Agent provider connection settings and credentials are outside AgentHist's migration scope, but accidental exposure of them by AgentHist is a valid security issue.
