---
name: review
description: Reads your local Claude Code session transcripts and recommends guideline, skill, hook, MCP, model-routing, multi-agent, and session-hygiene improvements grounded in what you actually did. Run on demand as /loupe:review.
---

# Loupe Review

Orchestrates a local, on-demand review of your own Claude Code session
history. Never touches your repos — every output is advisory, with an
Apply prompt you choose whether to hand to Claude Code yourself. See the
"Loupe — Full Spec" Notion page (linked from the project hub) for the full
design; this file implements §3's orchestration.

All script paths below are relative to `${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/`.

## Scoping to a repo or branch (optional)

If the user invoked this with arguments (e.g. `/loupe:review Sidelit`,
`/loupe:review --branch main`, `/loupe:review --repo ~/Developer/Sidelit/main --branch fix/android-signin`),
or asks in chat to scope the review, forward them to `heuristics.js` in
Step 2 as `--repo <name-or-path>` and/or `--branch <name>`. `--repo`
accepts either a `~/.loupe/groups.json` project name (the common case,
e.g. `Sidelit`) or a literal path for one specific repo/worktree. With no
arguments, the review covers everything (subject to the incremental
filtering below) — that's the default and normal case. `--export` is not a
scope argument: it means "share my review", covered under "Sharing a review
with a lead" at the end, and needs no new review run.

## Reporting progress (read this before Step 1)

A full run makes up to 20 real, sequential `claude -p` calls in Step 4, each
taking anywhere from 15 seconds to over a minute. **Nothing about this skill
is fast, and none of it streams on its own** — a Bash tool call's output
only appears once that call finishes, so if you silently run the steps below
back to back, the user sees nothing happen for several minutes and has no
way to tell a real run apart from a hang. Narrate as you go: a one-line text
message (not a tool call) before each numbered step below, and — this is the
important one — **a one-line update after every single grading call in Step
4**, not just at the end of the batch. Treat silence during Step 4 as a bug.

## Steps

1. **Self-tag this run before anything else.** Tell the user you're starting
   a review. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/heuristics.js" --mark-self "$CLAUDE_CODE_SESSION_ID"
   ```
   This session is itself a Claude Code session and would otherwise show up
   as data in the *next* review run — tag it first so it never grades
   itself (§3, "self-referential exclusion").

2. **Run the heuristic pre-filtering pass.** Tell the user you're scanning
   session history. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/heuristics.js"
   ```
   By default this is **incremental** — if a prior run exists in
   `~/.loupe/runs/`, only sessions active since that run's timestamp get
   analyzed, so a second review is fast and cheap instead of re-grading
   everything from scratch. The output's `incremental` and `reviewedSince`
   fields tell you which mode ran; `sessionsSkippedAlreadyReviewed` says how
   many were skipped as already covered. If the result comes back with
   `sessionsAnalyzed: 0` because everything is already covered, tell the
   user that plainly ("nothing new since your last review on \<date\>")
   instead of running an empty grading pass. Pass `--full` instead to force
   a full re-scan — do this if the user explicitly asks for a full history
   review, or if `~/.loupe/excluded-sessions.json` was ever reset (a full
   scan is the only way to re-derive self-referential exclusions from
   scratch in that case).

   Capture the JSON it prints — it has a `candidates` object keyed
   `A_guidelines` through `G_sessionHygiene`, each an array of candidate
   clusters. These are cheap structural pre-filters, not final
   recommendations — some will get rejected in the next step once an LLM
   actually looks at the evidence, and that's expected, not a bug. Report
   the totals to the user now (e.g. "Scanned N sessions, found M candidate
   clusters across 7 categories") so they see something concrete before the
   slow part starts.

3. **Take the grading queue.** Step 2's JSON also has a `gradingQueue`
   object, already built from `candidates`: one entry per cluster (not per
   raw session, since a cluster already aggregates its evidence session IDs
   and grading is priced per call, §3), each
   `{categoryLetter, reach, cluster}`. Use its `entries` in order as the
   queue for step 4; don't rebuild it by hand.

   **Temporary cost guard:** until Phase 5's `--optimize` dial system
   lands, the queue holds at most 20 clusters (`totalSlots`). They are
   shared fairly so one noisy category can't take every slot:
   - Every category with at least one candidate gets an equal share
     (`perCategoryShare`, 20 divided by the number of such categories,
     rounded down), filled with that category's widest-reach clusters.
     Reach is `evidenceSessionCount` when the cluster has it (wide clusters
     carry a sample of evidence IDs plus the full count), otherwise the
     larger of `evidenceSessionIds` length and `occurrenceCount`.
   - Slots a category can't use, because it has fewer clusters than its
     share, go back into a pool filled by reach across every category.

   Tell the user in the terminal summary how many were skipped and why,
   per category (`skippedByCategory`), e.g. "graded 20 of 143 candidates;
   skipped 40 multi-agent and 83 skills candidates past their share".

4. **Grade each queued cluster, narrating as you go.** This step is the
   entire wall-clock cost of a run, so it's the one place silence reads as
   broken. Before starting, tell the user how many clusters are queued
   ("Grading 14 candidates, this takes a few minutes..."). Then for each
   `{categoryLetter, cluster}` pair, in order:
   ```
   echo '<cluster JSON>' | "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/grade.sh" <categoryLetter>
   ```
   and **immediately after that call returns, before starting the next
   one**, post a single short line: `[i/total] <category label>:
   accepted` / `rejected (<short reason>)` / `error`. That line is a plain
   text message, not a tool call, so the user actually sees it appear
   between calls instead of after a long gap. Two non-fatal outcomes are
   expected and should not stop the run:
   - The graded response has `"recommendation": null` with a
     `rejected_reason` — the LLM looked at the actual evidence and decided
     the heuristic was wrong. Drop it, but keep the reason around for the
     progress line above and in case the terminal summary wants to mention
     how many were screened out this way.
   - `grade.sh` exits non-zero (a `claude -p` failure or a malformed model
     response) — log it, say so in the progress line, and continue with the
     rest of the queue. One bad grading call should never abort the whole
     run.

5. **Collect the results.** Gather every successfully graded, non-rejected
   recommendation into a single list. Each has
   `{category, evidence_session_ids, recommendation, proposed_artifact, apply_prompt}`.

6. **Score the run and build the report.** Tell the user you're scoring the
   run and building the report. Write step 2's heuristics
   output to a temp file and step 5's collected recommendations (the full
   graded array, including rejected ones — `report.js` uses rejection
   counts too) to another temp file, then run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/report.js" --candidates <heuristics-output.json> --graded <graded-recommendations.json>
   ```
   This computes per-category letter grades and a profile-weighted
   composite grade (§5, §3.5), persists the full run to
   `~/.loupe/runs/<timestamp>.json`, writes the self-contained HTML report
   to `~/.loupe/reports/<timestamp>.html`, and prints a terminal summary
   (composite grade, per-category grades with ▲/▼ deltas once a prior run
   exists, and the top 5-8 recommendations) to stdout — that stdout output
   is exactly what to relay back to the user, verbatim, don't re-derive it.
   The last line of stdout is the HTML report's file path.

7. **Open the report and present the run.** Open the HTML report path from
   step 6 automatically (`open <path>` on macOS) so it's already on screen,
   then show the user the terminal summary. Note explicitly which
   categories came back empty and whether that's because nothing was found
   or because everything got rejected at grading — those mean different
   things.

## Sharing a review with a lead (only when asked)

Run this only when the user asks to export, share or send their review
(e.g. `/loupe:review --export`, "share this with my lead"). Never export on
your own initiative: the export leaves the user's machine, and they decide
what goes.

1. Ask which name the lead should see, unless `exportName` is set in
   `~/.loupe/config.json`, and whether any client or coworker names appear
   in their findings. Those have no recognizable shape, so the scrubber only
   removes them when listed.
2. Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/export.js" --as "<name>" [--redact "Client A,Coworker B"] [--run <run json path>]
   ```
   With no `--run`, it exports the most recent run. It writes
   `~/.loupe/exports/<run timestamp>.json` and prints a preview of exactly
   what was written; the last line is the file path.
3. Show the user the preview verbatim and ask them to read every finding
   before sending the file. If something should not leave, re-run with more
   `--redact` terms. The file goes wherever the user sends it; you never
   send it yourself.

Runs are incremental, so one export covers only the sessions since the
previous run. A developer who reviews often can send several exports; the
team view sums them.

## Building a team view (for a lead)

When a lead asks to combine exports they received:
```
node "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/aggregate.js" <folder or files...> [--json]
```
It prints Markdown: gap findings per 10 sessions for each developer and
category, categories where two or more developers have gaps, and each
developer's findings as guidance plus good habits to keep. Relay it as is.
Rates are per 10 sessions because letter grades drop as session counts
rise, so grades are not comparable between people.
