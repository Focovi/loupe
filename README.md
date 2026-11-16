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

## Requirements

Every OS needs Claude Code, signed in, either the desktop app or the CLI,
and Node.js 18 or later (`node`) on your `PATH`. Loupe's scripts are plain
Node with no dependencies and no install step. The grader runs the same
Claude Code your session runs (`CLAUDE_CODE_EXECPATH`), so the desktop app
needs no `claude` on your `PATH`.

| OS | Also needed | Notes |
| --- | --- | --- |
| macOS | nothing | |
| Linux | nothing | The report opens with `xdg-open`. |
| Windows | Git for Windows (Git Bash) | Claude Code runs its Bash tool through Git Bash. The grader starts `claude.exe` (native install) or `claude.cmd` (npm install) without a shell. Set `LOUPE_CLAUDE_BIN` to a full path to use a different `claude`. |

## Grading model

Every candidate is graded by one headless `claude -p` call on a pinned
model, `claude-sonnet-5-5`, never the model of the session you run
`/loupe:review` from. Grades from different models are not comparable, so
everyone on a team should grade with the same ID: leave
`LOUPE_GRADE_MODEL` unset unless the whole team repins together.

The call runs isolated from your own setup: no settings, CLAUDE.md,
plugins, skills, MCP servers, hooks or tools, Loupe's own system prompt, a
pinned effort level (`medium`), a JSON schema for the answer, a cost cap
per call, and no saved session. So your configuration never sways your
grades, each call carries about 1,300 tokens of overhead instead of about
50,000, and grading leaves no transcripts behind for the next review.
Runs record the setup with the model (`claude-sonnet-5-5 (isolated
grader, medium effort)`), so the report warns when you compare against a
run graded before this change. Each run
records the model it used (`gradingModels` in `~/.loupe/runs/*.json` and in
exports), the terminal summary warns when it differs from your previous
run, and the team view warns when exports were graded with different
models.

## Grades

Each category starts at 100 and loses 15 points per confirmed gap. A run
grades at most 20 candidate clusters, split evenly between the categories
that have candidates, and slots a category can't use go to the others.
A category graded more than its even share is scored at its share, at the
same rate of real gaps: 5 gaps in 8 graded clusters, with a share of about
3, cost 27 points instead of 75. Without this, the category with the most
candidates (usually skills) got the most slots and the lowest grade.

## Projects

Loupe groups sessions into projects by the git repository each session ran
in. Worktrees count as their main repository, so a bare + worktree layout
(`<Repo>/.bare`, `<Repo>/main`, `<Repo>/<feature>`) is one project. For a
folder that no longer exists, the first folder below a project root is
used; the default root is `~/Developer`, and you can list your own:

```json
{ "projectRoots": ["~/code", "D:\\src"] }
```

in `~/.loupe/config.json`. Anything else falls back to the session's own
folder. Home, project roots and temp folders are never projects. The first
run writes the suggestion to `~/.loupe/groups.json`; edit that file to
merge or rename projects. Later runs keep your entries as they are and
only add projects that no entry covers yet, such as a repo you started
after the first run.

## Development

```
node --test
```

## Sharing with a lead

Ask Claude to "export my Loupe review" (or run `/loupe:review --export`).
`export.js` writes a scrubbed summary to `~/.loupe/exports/`: per-category
counts, gap findings per 10 sessions, and each finding's recommendation and
proposed artifact. Session IDs, paths, branches, prompt excerpts and apply
prompts are dropped. Secrets, emails, URLs, IPs and home paths are replaced.
The grader is told to describe people and clients by role ("a teammate",
"the client") rather than by name, so most findings carry no names.
Client and coworker names are only replaced if you list them, so the
preview also lists capitalized words in the findings that may be names, and
Claude asks which to redact. List them with `--redact`, `exportRedact` in
`~/.loupe/config.json`, or a shared team file named in `exportRedactFiles`
(one term per line):

```json
{ "exportName": "Sam Lee", "exportRedact": ["Acme"], "exportRedactFiles": ["~/team/loupe-redact.txt"] }
```

The name defaults to git's global `user.name`; `--remember` saves the name
and `--redact` terms for next time, and `--share-redactions` adds the
`--redact` terms to the first `exportRedactFiles` list so the rest of the
team never has to decide on them again (share the updated file). Read the preview before you send the
file.

A lead combines the exports they receive with `aggregate.js <folder>`, which
prints a Markdown team view with guidance for each developer.

## Status

Usable, in early trials. The review, the scrubbed export and the team view
all work, with unit tests for the scrubber, export, aggregation, grouping,
grading and detectors. Windows support is covered by unit tests only and
has not yet been run on a Windows machine. See the [Loupe project hub](https://app.notion.com/p/3a604596974b81ee8877eac1e2a252e8)
in Notion for the full spec, build phases, and task backlog.
