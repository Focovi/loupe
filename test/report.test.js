'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRun,
  effectiveGapCount,
  fairShareOfGradingSlots,
  computeDeltas,
  renderTerminalSummary,
} = require('../plugins/loupe/skills/review/scripts/report');

const BALANCED = { cost: 0.25, speed: 0.25, quality: 0.25, interaction: 0.25 };

function candidatesWith(counts, totalSlots = 20) {
  const keys = ['A_guidelines', 'B_skills', 'C_hooks', 'D_mcps', 'E_modelRouting', 'F_agentParallelism', 'G_sessionHygiene'];
  const candidates = Object.fromEntries(keys.map((key) => [key, Array.from({ length: counts[key[0]] || 0 }, () => ({}))]));
  return { sessionsAnalyzed: 100, candidates, gradingQueue: { totalSlots } };
}

function graded(category, gaps, rejected) {
  return [
    ...Array.from({ length: gaps }, () => ({ category, recommendation: 'Fix it.', evidence_session_ids: ['s'] })),
    ...Array.from({ length: rejected }, () => ({ category, recommendation: null, rejected_reason: 'no' })),
  ];
}

test('fairShareOfGradingSlots splits slots across categories with candidates', () => {
  assert.equal(fairShareOfGradingSlots(candidatesWith({ A: 1, B: 9, D: 3, F: 2 })), 5);
  assert.equal(fairShareOfGradingSlots({ candidates: { A_guidelines: [{}] } }), Infinity);
});

test('effectiveGapCount scales only categories graded past their share', () => {
  assert.equal(effectiveGapCount(2, 3, 5), 2);
  assert.equal(effectiveGapCount(5, 10, 5), 2.5);
  assert.equal(effectiveGapCount(0, 10, 5), 0);
});

test('a category given extra slots scores on its gap rate, not its gap count', () => {
  const candidates = candidatesWith({ A: 1, B: 9, D: 3, F: 2 });
  const run = buildRun({
    candidates,
    gradedRecommendations: [...graded('A', 0, 1), ...graded('B', 5, 5), ...graded('D', 2, 1), ...graded('F', 1, 1)],
    profileName: 'balanced',
    dialWeights: BALANCED,
  });

  assert.equal(run.scoringMethod, 'fair-share/1');
  assert.equal(run.categories.B.effectiveGapCount, 2.5);
  assert.equal(run.categories.B.score, 63, 'scaled from 5 gaps (25) to 2.5 gaps');
  assert.equal(run.categories.D.score, 70, 'within its share, every gap counts');
  assert.equal(run.categories.A.score, 100);
});

test('merged findings still count as graded clusters', () => {
  const candidates = candidatesWith({ A: 1, B: 9, D: 3, F: 2 });
  const merged = { category: 'B', recommendation: 'Fix it.', merged_findings: [{}, {}] };
  const run = buildRun({
    candidates,
    gradedRecommendations: [merged, ...graded('B', 2, 5)],
    profileName: 'balanced',
    dialWeights: BALANCED,
  });
  assert.equal(run.categories.B.gradedCount, 10);
  assert.equal(run.categories.B.effectiveGapCount, 1.5);
});

function runWithPreviousScoring(previousScoringMethod) {
  const run = buildRun({ candidates: candidatesWith({ B: 2 }), gradedRecommendations: graded('B', 1, 1), profileName: 'balanced', dialWeights: BALANCED });
  run.deltas = computeDeltas(run, { ...run, scoringMethod: previousScoringMethod, gradingModels: [] });
  return run;
}

test('the summary warns when the previous run used the older scoring', () => {
  const run = runWithPreviousScoring(undefined);
  assert.match(renderTerminalSummary(run, [], 'report.html'), /two scoring methods/);
});

test('the summary does not warn when both runs used the same scoring', () => {
  const run = runWithPreviousScoring('fair-share/1');
  assert.doesNotMatch(renderTerminalSummary(run, [], 'report.html'), /two scoring methods/);
});
