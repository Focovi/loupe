#!/usr/bin/env node
'use strict';

/**
 * Merges graded findings that describe the same habit before report.js
 * scores them. Each category is graded cluster by cluster, so one habit
 * seen in several projects comes back as several findings and is
 * penalized once per project. Wording differs too much between findings
 * for a text-similarity threshold, so one pinned `claude -p` call per
 * category groups them instead.
 *
 * Usage:
 *   node consolidate.js <graded recommendations array path>
 *
 * Prints the graded array with duplicates merged into the first finding of
 * each group. Rejected findings pass through untouched. A failed call
 * leaves that category as it was: consolidation never loses a finding.
 */

const fs = require('fs');
const { callClaude, readAnswer, resolveGradeModel } = require('./grade');

const MIN_FINDINGS_TO_CONSOLIDATE = 2;
const PROMPT_FIELD_MAX_CHARS = 1200;

function main() {
  const gradedPath = process.argv[2];
  if (!gradedPath) {
    process.stderr.write('usage: consolidate.js <graded recommendations array path>\n');
    process.exit(1);
  }
  const graded = JSON.parse(fs.readFileSync(gradedPath, 'utf8'));
  const model = resolveGradeModel(process.env);
  const consolidated = consolidateFindings(graded, (prompt) => groupWithClaude(prompt, model));
  process.stdout.write(JSON.stringify(consolidated, null, 2) + '\n');
}

/**
 * `askForGroups(prompt)` returns the model's parsed JSON, or null on
 * failure. It is a parameter so tests can stand in for the model.
 */
function consolidateFindings(graded, askForGroups) {
  const batches = batchConfirmedFindings(graded);
  const replacements = new Map();
  const removed = new Set();

  for (const findings of batches) {
    const response = askForGroups(buildConsolidationPrompt(findings.map((f) => f.finding)));
    const groups = parseGroups(response, findings.length);
    if (!groups) {
      process.stderr.write(`consolidate: kept category ${findings[0].finding.category} as graded (no valid grouping)\n`);
      continue;
    }
    for (const group of groups) {
      if (group.length < 2) continue;
      const members = group.map((i) => findings[i]);
      replacements.set(members[0].index, mergeFindings(members.map((m) => m.finding)));
      members.slice(1).forEach((m) => removed.add(m.index));
    }
  }

  return graded.flatMap((finding, index) => {
    if (removed.has(index)) return [];
    return [replacements.get(index) || finding];
  });
}

// Gap findings and "working well" findings are never merged with each
// other, so they are grouped separately within each category.
function batchConfirmedFindings(graded) {
  const batches = new Map();
  graded.forEach((finding, index) => {
    if (!finding || !finding.recommendation) return;
    const key = `${finding.category}:${finding.is_gap === false ? 'good' : 'gap'}`;
    if (!batches.has(key)) batches.set(key, []);
    batches.get(key).push({ finding, index });
  });
  return [...batches.values()].filter((batch) => batch.length >= MIN_FINDINGS_TO_CONSOLIDATE);
}

function buildConsolidationPrompt(findings) {
  const listed = findings
    .map((f, i) => [`[${i}]`, `Recommendation: ${clip(f.recommendation)}`, `Proposed artifact: ${clip(f.proposed_artifact)}`].join('\n'))
    .join('\n\n');
  return [
    'You are merging duplicate findings for Loupe, a tool that reviews a developer\'s own Claude Code session history.',
    '',
    'Each finding below was produced separately, often from a different project. Group findings that describe the same underlying habit or would be fixed by the same change, even when they name different projects, tools or wording. Keep findings apart when they would need different fixes.',
    '',
    listed,
    '',
    'Respond with ONLY a JSON object, no commentary: {"groups": [[0, 2], [1], [3]]}. Every index appears in exactly one group. Order each group by how well its finding covers the shared habit, best first.',
  ].join('\n');
}

/**
 * Accepts only a grouping that uses every index exactly once; anything else
 * is treated as a failed call.
 */
function parseGroups(response, findingCount) {
  if (!response || !Array.isArray(response.groups)) return null;
  const seen = new Set();
  for (const group of response.groups) {
    if (!Array.isArray(group) || group.length === 0) return null;
    for (const index of group) {
      if (!Number.isInteger(index) || index < 0 || index >= findingCount || seen.has(index)) return null;
      seen.add(index);
    }
  }
  return seen.size === findingCount ? response.groups : null;
}

function mergeFindings([primary, ...duplicates]) {
  const evidence = [primary, ...duplicates].flatMap((f) => f.evidence_session_ids || []);
  return {
    ...primary,
    evidence_session_ids: [...new Set(evidence)],
    merged_findings: duplicates.map((f) => ({
      title: f.title,
      recommendation: f.recommendation,
      proposed_artifact: f.proposed_artifact,
      evidence_session_ids: f.evidence_session_ids || [],
    })),
  };
}

const GROUPS_SCHEMA = {
  type: 'object',
  properties: { groups: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } },
  required: ['groups'],
};

function groupWithClaude(prompt, model) {
  try {
    const envelope = callClaude(prompt, model, GROUPS_SCHEMA);
    if (envelope.is_error) return null;
    return readAnswer(envelope);
  } catch (err) {
    process.stderr.write(`consolidate: ${err.message}\n`);
    return null;
  }
}

function clip(text) {
  if (typeof text !== 'string') return '';
  return text.length > PROMPT_FIELD_MAX_CHARS ? text.slice(0, PROMPT_FIELD_MAX_CHARS) + '…' : text;
}

if (require.main === module) main();

module.exports = { consolidateFindings, buildConsolidationPrompt, parseGroups, mergeFindings };
