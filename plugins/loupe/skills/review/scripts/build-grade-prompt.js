#!/usr/bin/env node
'use strict';

/**
 * Builds the grading prompt for a single candidate cluster (Full Spec §3).
 * Not invoked directly by the skill — grade.sh shells out to this to
 * compose the rubric + evidence digest before calling the pinned model.
 *
 * Usage: node build-grade-prompt.js <category> <clusterJsonPath> <digestJsonPath>
 */

const fs = require('fs');

const RUBRICS = {
  A: 'Category A — Guidelines (CLAUDE.md). The signal is a correction that recurs across sessions/projects, not a one-off. Write a literal proposed CLAUDE.md line or short section, and name which of the evidence sessions it would have prevented needing to happen.',
  B: 'Category B — Skills (.claude/skills/). The signal is a multi-step procedure re-explained or re-derived from scratch across sessions instead of encoded once. Propose a skill name, a one-line trigger description, and a draft SKILL.md skeleton (headings and bullet points only — not the fully written skill).',
  C: 'Category C — Hooks (settings.json). The signal is a fixed, non-creative follow-up the user manually asks for after edits (lint, test, format, a repeated check). Recommend a specific hook type (PostToolUse, PreToolUse, Stop, SessionStart, or UserPromptSubmit) with a matcher and the command it should run.',
  D: 'Category D — MCPs. Either a gap (manual work an already-connected or plausible MCP would remove) or underuse (a connected MCP that never gets called). Name the specific MCP to add or actually use, and which evidence session(s) it would have saved a step in.',
  E: 'Category E — Model routing. Judge whether task complexity matched the model used across the evidence sessions — not to shame a single session, but to describe a "this type of task → this model" pattern worth adopting going forward.',
  F: 'Category F — Single-agent vs multi-agent (Task tool). Judge, from the evidence, whether the flagged work chunks were genuinely independent (a case for spawning parallel subagents next time) or actually sequential/dependent despite superficially similar tool calls (in which case say so plainly and do not recommend parallelizing). Do not assume the heuristic pre-filter was right — the evidence transcript is what you are actually judging.',
  G: 'Category G — Session & memory hygiene. Give a concrete, numeric threshold or trigger observed in the evidence (e.g. "correction rate climbs past X around turn Y") — not a generic "keep sessions short" platitude.',
};

const OUTPUT_CONTRACT = `Respond with ONLY a single JSON object (no markdown fences, no commentary before or after) matching exactly this shape:
{
  "category": "<the category letter>",
  "evidence_session_ids": ["<session ids this recommendation is grounded in>"],
  "is_gap": <true if this documents something missing/wrong that needs fixing, false if the evidence actually shows GOOD behavior worth codifying/preserving as a rule (e.g. a model switch that correctly matched task complexity, or work that was correctly kept serial) — categories E and F in particular can go either way; don't force a gap framing onto a positive finding>,
  "recommendation": "<2-4 sentence human-readable recommendation>",
  "proposed_artifact": "<the literal text/config/skeleton this category's Output column calls for>",
  "apply_prompt": "<a self-contained prompt a person could paste into a fresh Claude Code session to make this change — include target file path, exact change, and a verification step>"
}
If, after reviewing the evidence, you conclude the heuristic pre-filter was wrong and this isn't actually a real recommendation, respond instead with:
{"category": "<letter>", "evidence_session_ids": [], "is_gap": null, "recommendation": null, "proposed_artifact": null, "apply_prompt": null, "rejected_reason": "<why the evidence doesn't support this>"}

Style: do not use em dashes (—) anywhere in any field. Use a comma, period, colon, or parentheses instead.`;

function main() {
  const [category, clusterPath, digestPath] = process.argv.slice(2);
  const rubric = RUBRICS[category];
  if (!rubric) {
    process.stderr.write(`unknown category "${category}" — expected one of A-G\n`);
    process.exit(1);
  }

  const cluster = fs.readFileSync(clusterPath, 'utf8');
  const digest = fs.readFileSync(digestPath, 'utf8');

  const prompt = [
    'You are grading a candidate recommendation for Loupe, a tool that reviews a developer\'s own Claude Code session history and proposes concrete workflow improvements grounded in evidence — never generic best-practice advice.',
    '',
    rubric,
    '',
    'A cheap structural heuristic pre-filtered this candidate cluster. Your job is to look at the actual evidence below and decide whether it holds up, then produce the structured recommendation.',
    '',
    '--- CANDIDATE CLUSTER (from the heuristic pre-filter) ---',
    cluster.trim(),
    '',
    '--- EVIDENCE DIGEST (condensed session content — human turns and tool names/args only, no full tool outputs) ---',
    digest.trim(),
    '',
    OUTPUT_CONTRACT,
  ].join('\n');

  process.stdout.write(prompt);
}

main();
