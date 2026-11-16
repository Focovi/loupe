#!/usr/bin/env node
'use strict';

/**
 * Builds the grading prompt for a single candidate cluster (Full Spec §3).
 * Not invoked directly by the skill — grade.js runs this to
 * compose the rubric + evidence digest before calling the pinned model.
 *
 * Usage: node build-grade-prompt.js <category> <clusterJsonPath> <digestJsonPath>
 */

const fs = require('fs');

const RUBRICS = {
  A: 'Category A — Guidelines (CLAUDE.md). The signal is a correction that recurs across sessions/projects, not a one-off. Write a literal proposed CLAUDE.md line or short section, and name which of the evidence sessions it would have prevented needing to happen.',
  B: 'Category B — Skills (.claude/skills/). The signal is a multi-step procedure re-explained or re-derived from scratch across sessions instead of encoded once. The cluster\'s procedureSteps are the commands (names and subcommands only) and MCP tools those sessions ran in this order without a skill or slash command driving them; steps common to most sessions (build, commit, push) were already left out. evidenceSessionCount sessions ran them and evidenceSessionIds is a sample. Decide by counting digested sessions. A session supports the cluster when it ran at least half of procedureSteps, in roughly the listed order, as one job with one purpose (for example a release, a site rebuild, a UI check). A step counts as run when the digest shows its command, even cut off, or the session text says it ran. Accept when 3 or more digested sessions support it; reject when 2 or fewer do, even if those sessions are vivid. Other sampled sessions doing unrelated work is expected and is not a reason to reject. Also reject when a skill or slash command the sessions actually invoked already drives these steps; a doc, CI job or script alone does not count as coverage. Propose a skill name, a one-line trigger description, and a draft SKILL.md skeleton (headings and bullet points only — not the fully written skill).',
  C: 'Category C — Hooks (settings.json). The signal is a fixed, non-creative follow-up the user manually asks for after edits (lint, test, format, a repeated check). Recommend a specific hook type (PostToolUse, PreToolUse, Stop, SessionStart, or UserPromptSubmit) with a matcher and the command it should run. The cluster\'s action field names the check (test, lint, format, typecheck, build); the pre-filter already skipped actions an existing PostToolUse, Stop or SubagentStop hook covers. Only evidenceSessionIds (a sample when evidenceSessionCount is larger) are in the digest.',
  D: 'Category D — MCPs. Either a gap (manual work an already-connected or plausible MCP would remove) or underuse (a connected MCP that never gets called). Name the specific MCP to add or actually use, and which evidence session(s) it would have saved a step in. For a gap, availableMcpServers lists what is already configured, so prefer "use the one you have" when it fits. For underuse, scope says whether the servers are user-wide (judged across sessionsConsidered sessions in every project) or project-level; the digest holds only a sample of the most recent sessions.',
  E: 'Category E — Model routing. Judge whether task complexity matched the model used across the evidence sessions — not to shame a single session, but to describe a "this type of task → this model" pattern worth adopting going forward. Each cluster is one session, flagged by signal. For short-session-expensive-model, reject a session that was a single quick question or lookup: one trivial exchange is too little to set a routing rule. For model-switch-mid-session, judge the switch itself: accept only when the models are in different tiers (for example Opus and Sonnet or Haiku) and the switch lines up with a change in the kind of work. A switch between two versions of the same tier says nothing about routing, so reject it rather than recommending a model for work the switch did not touch.',
  F: 'Category F — Single-agent vs multi-agent (Task tool). Judge the cluster\'s signal from the evidence. For long-exploration-in-main-session, the main session ran longestExplorationRoundTrips or more lookups (Read, Grep, Glob, web fetches, read-only shell commands) one round trip after another, with no other tool call between. Decide whether that exploration could have gone to a subagent that returns a summary, keeping the main context for the work, or to one message of parallel tool calls. Decide by counting digested sessions. A session supports the cluster when it has a run of 10 or more lookups that were mostly locating code or reading reference material (searches, directory listings, web docs) whose results could have come back as a short summary. Reads of files the session then edited, or lookups each chosen from the result before, do not count toward the 10. Accept when 2 or more digested sessions support it; reject when 0 or 1 do. A mix is common: count only the separable part of each run, and do not accept or reject on the overall impression. For subagents-for-trivial-work, judge whether the delegated tasks were too small to be worth a subagent. Do not assume the heuristic pre-filter was right; the evidence transcript is what you are judging. A cluster covers one project: evidenceSessionCount sessions were flagged, and evidenceSessionIds is a sample of them, longest exploration first.',
  G: 'Category G — Session & memory hygiene. Give a concrete, numeric threshold or trigger observed in the evidence (e.g. "correction rate climbs past X around turn Y") — not a generic "keep sessions short" platitude. For rising-correction-rate, the cluster covers every session in one project whose correction rate rose by at least 0.15 between its first and last 10 typed turns, steepest first; maxSlope and medianSlope summarize them.',
};

const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object (no markdown fences, no commentary before or after) matching exactly this shape:
{
  "category": "<the category letter>",
  "evidence_session_ids": ["<session ids this recommendation is grounded in>"],
  "is_gap": <true if this documents something missing/wrong that needs fixing, false if the evidence actually shows GOOD behavior worth codifying/preserving as a rule (e.g. a model switch that correctly matched task complexity, or work that was correctly kept serial) — categories E and F in particular can go either way; don't force a gap framing onto a positive finding>,
  "title": "<the change to make, as an imperative phrase of at most 10 words, e.g. \"Add a skill for the dev deploy\">",
  "recommendation": "<at most 2 sentences and 50 words: what the evidence shows and why the change helps. Leave session IDs, ticket keys and step-by-step detail to evidence_session_ids and proposed_artifact>",
  "proposed_artifact": "<the literal text/config/skeleton this category's Output column calls for>",
  "apply_prompt": "<a self-contained prompt a person could paste into a fresh Claude Code session to make this change — include target file path, exact change, and a verification step>"
}
If, after reviewing the evidence, you conclude the heuristic pre-filter was wrong and this isn't actually a real recommendation, respond instead with:
{"category": "<letter>", "evidence_session_ids": [], "is_gap": null, "title": null, "recommendation": null, "proposed_artifact": null, "apply_prompt": null, "rejected_reason": "<why the evidence doesn't support this>"}

Names: title, recommendation and proposed_artifact may be shared with the developer's lead, so never name a person, client, customer or their company in them. Say "the developer", "a teammate", "the client" or "a customer project" instead. Tools, languages and services (Claude Code, GitHub, Jira) are fine. apply_prompt stays on the developer's machine, so it may name repos and paths.

Style: do not use em dashes (—) anywhere in any field. Use a comma, period, colon, or parentheses instead.`;

function main() {
  const [category, clusterPath, digestPath] = process.argv.slice(2);
  process.stdout.write(buildPrompt(category, clusterPath, digestPath));
}

function buildPrompt(category, clusterPath, digestPath) {
  const rubric = RUBRICS[category];
  if (!rubric) {
    process.stderr.write(`unknown category "${category}" — expected one of A-G\n`);
    process.exit(1);
  }

  const cluster = fs.readFileSync(clusterPath, 'utf8');
  const digest = fs.readFileSync(digestPath, 'utf8');

  return [
    'You are grading a candidate recommendation for Loupe, a tool that reviews a developer\'s own Claude Code session history and proposes concrete workflow improvements grounded in evidence — never generic best-practice advice.',
    '',
    rubric,
    '',
    'A cheap structural heuristic pre-filtered this candidate cluster. Your job is to look at the actual evidence below and decide whether it holds up, then produce the structured recommendation.',
    '',
    '--- CANDIDATE CLUSTER (from the heuristic pre-filter) ---',
    cluster.trim(),
    '',
    '--- EVIDENCE DIGEST (condensed session content — human turns and tool names/args only, no full tool outputs). sessionsIncluded of sessionsRequested sessions are digested, each sampled to at most maxTurnsPerSession turns from its start and end. ---',
    digest.trim(),
    '',
    OUTPUT_CONTRACT,
  ].join('\n');
}

if (require.main === module) main();

module.exports = { OUTPUT_CONTRACT, RUBRICS };
