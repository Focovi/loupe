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

## Steps

1. **Self-tag this run before anything else.** Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/heuristics.js" --mark-self "$CLAUDE_CODE_SESSION_ID"
   ```
   This session is itself a Claude Code session and would otherwise show up
   as data in the *next* review run — tag it first so it never grades
   itself (§3, "self-referential exclusion").

2. **Run the heuristic pre-filtering pass.** Run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/heuristics.js"
   ```
   Capture the JSON it prints — it has a `candidates` object keyed
   `A_guidelines` through `G_sessionHygiene`, each an array of candidate
   clusters. These are cheap structural pre-filters, not final
   recommendations — some will get rejected in the next step once an LLM
   actually looks at the evidence, and that's expected, not a bug.

3. **Flatten candidates into a grading queue.** Build a list of
   `{categoryLetter, cluster}` pairs from every array in `candidates`
   (e.g. `A_guidelines` → letter `A`, `B_skills` → letter `B`, and so on
   through `G_sessionHygiene` → `G`). One entry per cluster, not per raw
   session — a cluster already aggregates its evidence session IDs, and
   grading is priced per call (§3), so grading the cluster once instead of
   grading each underlying session separately is the whole point of the
   pre-filtering step.

   **Temporary cost guard:** until Phase 5's `--optimize` dial system
   lands, cap the queue at 20 clusters total for a single run. If there
   are more, keep the 20 with the largest `evidenceSessionIds` /
   `occurrenceCount` (whichever the cluster has) — the widest-reach
   candidates are the most worth a grading call — and tell the user in
   the terminal summary how many were skipped and why.

4. **Grade each queued cluster.** For each `{categoryLetter, cluster}`
   pair, run:
   ```
   echo '<cluster JSON>' | "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/grade.sh" <categoryLetter>
   ```
   `grade.sh` shells out to a pinned model in headless mode (§3) so grading
   consistency never depends on whichever model happened to invoke this
   skill. It prints one graded recommendation JSON on success. Two non-fatal
   outcomes are expected and should not stop the run:
   - The graded response has `"recommendation": null` with a
     `rejected_reason` — the LLM looked at the actual evidence and decided
     the heuristic was wrong. Drop it, but keep the reason around in case
     the terminal summary wants to mention how many were screened out this
     way.
   - `grade.sh` exits non-zero (a `claude -p` failure or a malformed model
     response) — log it and continue with the rest of the queue. One bad
     grading call should never abort the whole run.

5. **Collect the results.** Gather every successfully graded, non-rejected
   recommendation into a single list. Each has
   `{category, evidence_session_ids, recommendation, proposed_artifact, apply_prompt}`.

6. **Score the run.** Write step 2's heuristics output to a temp file and
   step 5's collected recommendations (the full graded array, including
   rejected ones — `report.js` uses rejection counts too) to another temp
   file, then run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/review/scripts/report.js" --candidates <heuristics-output.json> --graded <graded-recommendations.json>
   ```
   This computes per-category letter grades and a profile-weighted
   composite grade (§5, §3.5), persists the full run to
   `~/.loupe/runs/<timestamp>.json`, and — once a prior run exists — prints
   run-over-run deltas and flags any category that dropped 2+ letter
   grades.

7. **Present the run.** Print a plain-text summary to the terminal:
   composite grade, per-category grades (with ▲/▼ deltas if a previous run
   exists), and the full text of each confirmed recommendation with its
   evidence session IDs and Apply prompt. Note explicitly which categories
   came back empty and whether that's because nothing was found or because
   everything got rejected at grading — those mean different things.

   *(The self-contained HTML report (§4) is Phase 4's job — until it
   lands, the terminal summary above is this skill's full output.)*
