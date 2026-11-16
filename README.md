# Loupe

A Claude Code skill that reads your local session transcripts and tells you
what guidelines, skills, hooks, and MCPs would actually improve how you
work — grounded in what you did, not generic best-practice advice.

Run `/loupe:review` to get a local, self-contained HTML report across seven
categories (guidelines, skills, hooks, MCPs, model routing, single vs.
multi-agent, session/memory hygiene), each recommendation backed by
evidence from your own sessions and paired with a ready-to-paste "Apply"
prompt. V1 is strictly advisory — Loupe never writes to your repos itself.

No hosted backend, no account, no payment. Everything runs locally.

## Install

```
/plugin marketplace add focovi/loupe
/plugin install loupe@loupe
```

## Sharing with a lead

Ask Claude to "export my Loupe review" (or run `/loupe:review --export`).
`export.js` writes a scrubbed summary to `~/.loupe/exports/`: per-category
counts, gap findings per 10 sessions, and each finding's recommendation and
proposed artifact. Session IDs, paths, branches, prompt excerpts and apply
prompts are dropped. Secrets, emails, URLs, IPs and home paths are replaced.
Client and coworker names are only replaced if you list them with
`--redact` or `exportRedact` in `~/.loupe/config.json`, so read the preview
before you send the file.

A lead combines the exports they receive with `aggregate.js <folder>`, which
prints a Markdown team view with guidance for each developer.

## Status

Pre-build. See the [Loupe project hub](https://app.notion.com/p/3a604596974b81ee8877eac1e2a252e8)
in Notion for the full spec, build phases, and task backlog.
