#!/usr/bin/env node
'use strict';

/**
 * Loupe scoring engine + run history (Full Spec §5, §3.5).
 *
 * Phase 3 scope: per-category letter grades, a profile-weighted composite
 * grade, and ~/.loupe/runs/ history read/write with run-over-run deltas.
 * The self-contained HTML report and terminal summary (§4) are Phase 4 —
 * this script currently emits JSON only.
 *
 * Usage:
 *   node report.js --candidates <heuristics.js output path> --graded <graded recommendations array path> [--profile <name>]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = os.homedir();
const RUNS_DIR = path.join(HOME_DIR, '.loupe', 'runs');
const CONFIG_FILE = path.join(HOME_DIR, '.loupe', 'config.json');

const CATEGORY_KEYS = {
  A: 'A_guidelines',
  B: 'B_skills',
  C: 'C_hooks',
  D: 'D_mcps',
  E: 'E_modelRouting',
  F: 'F_agentParallelism',
  G: 'G_sessionHygiene',
};

const PENALTY_PER_CONFIRMED_FINDING = 15;
const PENALTY_REPEAT_UNHEEDED_GUIDELINE = 40;
const GRADE_CUTOFFS = [
  [90, 'A'],
  [80, 'B'],
  [70, 'C'],
  [60, 'D'],
  [0, 'F'],
];
const REGRESSION_LETTER_DROP_THRESHOLD = 2;
const GRADE_RANK = { A: 4, B: 3, C: 2, D: 1, F: 0 };

// §3.5 gives a qualitative table of how much each category matters to each
// dial, not exact numbers. This matrix is this script's own numeric
// interpretation of that table (documented here, not hidden) — e.g. D's
// "quality" column in §3.5 is literally "—" (no stated rationale), so D's
// quality relevance is set near zero rather than force-split evenly.
const CATEGORY_DIAL_RELEVANCE = {
  A: { cost: 0.20, speed: 0.15, quality: 0.30, interaction: 0.35 },
  B: { cost: 0.20, speed: 0.30, quality: 0.20, interaction: 0.30 },
  C: { cost: 0.25, speed: 0.30, quality: 0.25, interaction: 0.20 },
  D: { cost: 0.35, speed: 0.30, quality: 0.05, interaction: 0.30 },
  E: { cost: 0.30, speed: 0.25, quality: 0.30, interaction: 0.15 },
  F: { cost: 0.20, speed: 0.40, quality: 0.20, interaction: 0.20 },
  G: { cost: 0.20, speed: 0.20, quality: 0.25, interaction: 0.35 },
};

const PRESET_PROFILES = {
  prototype: { cost: 0.40, speed: 0.35, quality: 0.10, interaction: 0.15 },
  production: { cost: 0.15, speed: 0.15, quality: 0.45, interaction: 0.25 },
  learning: { cost: 0.15, speed: 0.10, quality: 0.25, interaction: 0.50 },
  balanced: { cost: 0.25, speed: 0.25, quality: 0.25, interaction: 0.25 },
};
const DEFAULT_PROFILE_NAME = 'balanced';

function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = readJson(args.candidates);
  const gradedRecommendations = args.graded ? readJson(args.graded) : [];
  const profileName = args.profile || readDefaultProfileName();
  const dialWeights = PRESET_PROFILES[profileName] || PRESET_PROFILES[DEFAULT_PROFILE_NAME];

  const run = buildRun({ candidates, gradedRecommendations, profileName, dialWeights });
  const previousRun = loadMostRecentRun();
  run.deltas = previousRun ? computeDeltas(run, previousRun) : null;

  persistRun(run);
  process.stdout.write(JSON.stringify(run, null, 2) + '\n');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    args[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readDefaultProfileName() {
  try {
    const config = readJson(CONFIG_FILE);
    return config.profile || DEFAULT_PROFILE_NAME;
  } catch (err) {
    return DEFAULT_PROFILE_NAME;
  }
}

// ---------------------------------------------------------------------------
// Per-category scoring (§5)
// ---------------------------------------------------------------------------

function buildRun({ candidates, gradedRecommendations, profileName, dialWeights }) {
  const categoryResults = {};
  for (const letter of Object.keys(CATEGORY_KEYS)) {
    categoryResults[letter] = scoreCategory(letter, candidates, gradedRecommendations);
  }

  const composite = computeCompositeScore(categoryResults, dialWeights);

  return {
    generatedAt: new Date().toISOString(),
    profile: profileName,
    dialWeights,
    sessionsAnalyzed: candidates.sessionsAnalyzed,
    categories: categoryResults,
    compositeScore: composite,
    compositeGrade: scoreToGrade(composite),
  };
}

function scoreCategory(letter, candidates, gradedRecommendations) {
  const forThisCategory = gradedRecommendations.filter((r) => r.category === letter);
  const confirmedFindings = forThisCategory.filter((r) => r.recommendation);
  // is_gap defaults true for categories where the rubric never offered a
  // positive framing (A-D, G) and for any older graded output that
  // predates the field — only E and F's rubric explicitly allows a
  // "this is good, codify it" outcome (§2's Output column for E/F is
  // phrased as a pattern, not strictly a problem).
  const gapFindings = confirmedFindings.filter((r) => r.is_gap !== false);
  const affirmingFindings = confirmedFindings.filter((r) => r.is_gap === false);

  const score = clamp(100 - penaltyForCategory(letter, gapFindings), 0, 100);

  return {
    score,
    grade: scoreToGrade(score),
    heuristicCandidateCount: (candidates.candidates[CATEGORY_KEYS[letter]] || []).length,
    confirmedFindingCount: confirmedFindings.length,
    gapFindingCount: gapFindings.length,
    affirmingFindingCount: affirmingFindings.length,
    rejectedAtGradingCount: forThisCategory.length - confirmedFindings.length,
    confirmedFindings,
  };
}

function penaltyForCategory(letter, gapFindings) {
  let penalty = gapFindings.length * PENALTY_PER_CONFIRMED_FINDING;
  if (letter === 'A' && hasUnheededRepeatGuideline(gapFindings)) {
    penalty += PENALTY_REPEAT_UNHEEDED_GUIDELINE;
  }
  return penalty;
}

function hasUnheededRepeatGuideline(confirmedFindings) {
  // Placeholder for run-over-run "same correction re-issued after already
  // flagged" detection — needs the previous run's accepted A recommendation
  // text to compare against, which computeDeltas() has but scoreCategory()
  // doesn't yet receive. Left false (no extra penalty applied) rather than
  // guessed; wiring this through is real follow-up work, not silently
  // pretended to be solved.
  return false;
}

function scoreToGrade(score) {
  for (const [threshold, grade] of GRADE_CUTOFFS) {
    if (score >= threshold) return grade;
  }
  return 'F';
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Composite grade (§5 + §3.5)
// ---------------------------------------------------------------------------

function computeCompositeScore(categoryResults, dialWeights) {
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [letter, relevance] of Object.entries(CATEGORY_DIAL_RELEVANCE)) {
    const effectiveWeight = dotProduct(dialWeights, relevance);
    weightedSum += categoryResults[letter].score * effectiveWeight;
    totalWeight += effectiveWeight;
  }

  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

function dotProduct(weightsA, weightsB) {
  return Object.keys(weightsA).reduce((sum, dial) => sum + weightsA[dial] * (weightsB[dial] || 0), 0);
}

// ---------------------------------------------------------------------------
// Run history (§4, §5)
// ---------------------------------------------------------------------------

function persistRun(run) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const fileName = run.generatedAt.replace(/[:.]/g, '-') + '.json';
  fs.writeFileSync(path.join(RUNS_DIR, fileName), JSON.stringify(run, null, 2) + '\n');
}

function loadMostRecentRun() {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const runFiles = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort();
  if (runFiles.length === 0) return null;
  return readJson(path.join(RUNS_DIR, runFiles[runFiles.length - 1]));
}

function computeDeltas(currentRun, previousRun) {
  const perCategory = {};
  const regressions = [];

  for (const letter of Object.keys(CATEGORY_KEYS)) {
    const delta = computeCategoryDelta(letter, currentRun, previousRun);
    perCategory[letter] = delta;
    if (delta.rankDrop >= REGRESSION_LETTER_DROP_THRESHOLD) {
      regressions.push({ category: letter, from: delta.previousGrade, to: delta.currentGrade });
    }
  }

  return {
    previousRunAt: previousRun.generatedAt,
    compositeScoreDelta: currentRun.compositeScore - previousRun.compositeScore,
    perCategory,
    regressions,
  };
}

function computeCategoryDelta(letter, currentRun, previousRun) {
  const currentGrade = currentRun.categories[letter].grade;
  const previousGrade = previousRun.categories[letter].grade;
  const rankDrop = GRADE_RANK[previousGrade] - GRADE_RANK[currentGrade];

  return {
    previousGrade,
    currentGrade,
    previousScore: previousRun.categories[letter].score,
    currentScore: currentRun.categories[letter].score,
    direction: rankDrop > 0 ? 'down' : rankDrop < 0 ? 'up' : 'flat',
    rankDrop,
  };
}

main();
