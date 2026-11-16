'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { consolidateFindings, parseGroups, buildConsolidationPrompt } = require('../plugins/loupe/skills/review/scripts/consolidate');

function finding(category, recommendation, evidence, extra = {}) {
  return { category, recommendation, proposed_artifact: `${recommendation} artifact`, evidence_session_ids: evidence, ...extra };
}

const rejected = { category: 'B', recommendation: null, rejected_reason: 'one-off', evidence_session_ids: [] };

test('consolidateFindings merges a group into its first finding', () => {
  const graded = [
    finding('B', 'Close out after merge in repo one', ['a', 'b']),
    rejected,
    finding('B', 'Wrap up merged work in repo two', ['b', 'c']),
    finding('B', 'Write a release skill', ['d']),
  ];
  const result = consolidateFindings(graded, () => ({ groups: [[0, 1], [2]] }));

  assert.equal(result.length, 3);
  assert.deepEqual(result[0].evidence_session_ids, ['a', 'b', 'c']);
  assert.equal(result[0].merged_findings.length, 1);
  assert.equal(result[0].merged_findings[0].recommendation, 'Wrap up merged work in repo two');
  assert.equal(result[1], rejected);
  assert.equal(result[2].recommendation, 'Write a release skill');
});

test('consolidateFindings leaves a category alone when the grouping is invalid', () => {
  const graded = [finding('B', 'one', ['a']), finding('B', 'two', ['b'])];
  assert.deepEqual(consolidateFindings(graded, () => null), graded);
  assert.deepEqual(consolidateFindings(graded, () => ({ groups: [[0, 0, 1]] })), graded);
});

test('consolidateFindings skips categories with a single finding and keeps gaps apart from good habits', () => {
  const prompts = [];
  const graded = [
    finding('A', 'only one', ['a']),
    finding('E', 'good routing', ['b'], { is_gap: false }),
    finding('E', 'bad routing', ['c'], { is_gap: true }),
  ];
  const result = consolidateFindings(graded, (prompt) => {
    prompts.push(prompt);
    return { groups: [[0, 1]] };
  });
  assert.equal(prompts.length, 0);
  assert.deepEqual(result, graded);
});

test('parseGroups needs every index exactly once', () => {
  assert.deepEqual(parseGroups({ groups: [[1, 0], [2]] }, 3), [[1, 0], [2]]);
  assert.equal(parseGroups({ groups: [[0, 1]] }, 3), null);
  assert.equal(parseGroups({ groups: [[0, 3], [1], [2]] }, 3), null);
  assert.equal(parseGroups({ groups: [[0], []] }, 1), null);
  assert.equal(parseGroups({}, 1), null);
});

test('buildConsolidationPrompt carries the self-exclusion signature', () => {
  assert.match(buildConsolidationPrompt([finding('B', 'x', [])]), /merging duplicate findings for Loupe/);
});
