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

## Status

Pre-build. See the [Loupe project hub](https://app.notion.com/p/3a604596974b81ee8877eac1e2a252e8)
in Notion for the full spec, build phases, and task backlog.
