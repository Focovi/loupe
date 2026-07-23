#!/usr/bin/env node
'use strict';

/**
 * Loupe scoring engine, run history, and report rendering (Full Spec §5,
 * §4, §3.5): per-category letter grades, a profile-weighted composite
 * grade, ~/.loupe/runs/ history with run-over-run deltas, a terminal
 * summary on stdout, and a self-contained HTML report written to
 * ~/.loupe/reports/<timestamp>.html.
 *
 * Usage:
 *   node report.js --candidates <heuristics.js output path> --graded <graded recommendations array path> [--profile <name>] [--json]
 *
 * --json prints the raw run JSON to stdout instead of rendering the report
 * (used for scripting/testing; not part of the normal skill flow).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME_DIR = os.homedir();
const RUNS_DIR = path.join(HOME_DIR, '.loupe', 'runs');
const REPORTS_DIR = path.join(HOME_DIR, '.loupe', 'reports');
const CONFIG_FILE = path.join(HOME_DIR, '.loupe', 'config.json');
const TERMINAL_SUMMARY_MAX_RECOMMENDATIONS = 8;
const TERMINAL_SUMMARY_MIN_RECOMMENDATIONS = 5;

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
  const { profileName, dialWeights } = resolveProfile(args);

  const run = buildRun({ candidates, gradedRecommendations, profileName, dialWeights });
  const previousRun = loadMostRecentRun();
  run.deltas = previousRun ? computeDeltas(run, previousRun) : null;
  persistRun(run);

  if ('json' in args) {
    process.stdout.write(JSON.stringify(run, null, 2) + '\n');
    return;
  }

  const confirmedRecommendations = gradedRecommendations.filter((r) => r.recommendation);
  const reportPath = writeHtmlReport(run, confirmedRecommendations);
  process.stdout.write(renderTerminalSummary(run, confirmedRecommendations, reportPath));
}

// §3.5 precedence, highest first: --optimize (explicit for this run) >
// nearest .loupe.json walking up from cwd (per-repo default) >
// ~/.loupe/config.json (personal default) > built-in "balanced".
function resolveProfile(args) {
  if (args.optimize) {
    return { profileName: 'custom', dialWeights: parseCustomWeights(args.optimize) };
  }
  if (args.profile && PRESET_PROFILES[args.profile]) {
    return { profileName: args.profile, dialWeights: PRESET_PROFILES[args.profile] };
  }

  const repoProfile = readNearestRepoProfile(args.cwd || process.cwd());
  const profileName = repoProfile || readDefaultProfileName();
  return { profileName, dialWeights: PRESET_PROFILES[profileName] || PRESET_PROFILES[DEFAULT_PROFILE_NAME] };
}

function parseCustomWeights(optimizeArg) {
  const weights = {};
  for (const pair of optimizeArg.split(',')) {
    const [dial, value] = pair.split('=');
    if (dial && value !== undefined) weights[dial.trim()] = Number(value);
  }
  return normalizeWeights({
    cost: weights.cost || 0,
    speed: weights.speed || 0,
    quality: weights.quality || 0,
    interaction: weights.interaction || 0,
  });
}

function normalizeWeights(weights) {
  const total = Object.values(weights).reduce((sum, w) => sum + w, 0);
  if (total <= 0) return PRESET_PROFILES[DEFAULT_PROFILE_NAME];
  return Object.fromEntries(Object.entries(weights).map(([dial, w]) => [dial, w / total]));
}

function readNearestRepoProfile(startDir) {
  let dir = startDir;
  while (true) {
    const config = readJsonSafe(path.join(dir, '.loupe.json'));
    if (config) return config.profile || null;
    const parentDir = path.dirname(dir);
    if (parentDir === dir || dir === HOME_DIR) return null;
    dir = parentDir;
  }
}

function readJsonSafe(filePath) {
  try {
    return readJson(filePath);
  } catch (err) {
    return null;
  }
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

// ---------------------------------------------------------------------------
// Terminal summary (§4.1)
// ---------------------------------------------------------------------------

const CATEGORY_LABELS = {
  A: 'Guidelines',
  B: 'Skills',
  C: 'Hooks',
  D: 'MCPs',
  E: 'Model routing',
  F: 'Multi-agent',
  G: 'Session hygiene',
};

function renderTerminalSummary(run, confirmedRecommendations, reportPath) {
  const lines = [];
  lines.push(`Loupe review: composite grade ${run.compositeGrade} (${run.compositeScore}/100), profile "${run.profile}"`);
  lines.push(`${run.sessionsAnalyzed} sessions analyzed across ${Object.keys(run.categories).length} categories.`);
  lines.push('');

  for (const letter of Object.keys(CATEGORY_KEYS)) {
    const cat = run.categories[letter];
    const delta = run.deltas ? run.deltas.perCategory[letter] : null;
    const arrow = delta ? deltaArrow(delta.direction) : '';
    lines.push(`  ${CATEGORY_LABELS[letter].padEnd(17)} ${cat.grade} (${cat.score}) ${arrow}`);
  }

  if (run.deltas && run.deltas.regressions.length > 0) {
    lines.push('');
    lines.push('⚠ Regression (2+ letter grade drop):');
    for (const r of run.deltas.regressions) {
      lines.push(`  ${CATEGORY_LABELS[r.category]}: ${r.from} → ${r.to}`);
    }
  }

  lines.push('');
  const ranked = rankRecommendations(confirmedRecommendations, run.dialWeights).slice(0, TERMINAL_SUMMARY_MAX_RECOMMENDATIONS);
  if (ranked.length === 0) {
    lines.push('No confirmed recommendations this run.');
  } else {
    lines.push(`Top recommendations (${ranked.length}):`);
    for (const rec of ranked) {
      lines.push(`  (${CATEGORY_LABELS[rec.category]}) ${firstSentence(rec.recommendation)}`);
    }
  }

  lines.push('');
  lines.push(`Full report: ${reportPath}`);
  return lines.join('\n') + '\n';
}

function deltaArrow(direction) {
  if (direction === 'up') return '▲';
  if (direction === 'down') return '▼';
  return '';
}

function rankRecommendations(confirmedRecommendations, dialWeights) {
  // §4.1: ranked by (frequency of the underlying pattern × estimated
  // friction). No direct friction measure is available from the grading
  // output, so evidence-session count is used as the proxy for frequency.
  // §3.5: "the terminal summary ranking actually changes when you switch
  // profiles" — so frequency alone isn't enough; a recommendation also
  // ranks higher when its category serves the active profile's dials more
  // (via the same CATEGORY_DIAL_RELEVANCE weighting the composite score
  // uses), so a cost-weighted profile surfaces different top recommendations
  // than a quality-weighted one even on identical underlying data.
  return [...confirmedRecommendations].sort((a, b) => rankScore(b, dialWeights) - rankScore(a, dialWeights));
}

function rankScore(recommendation, dialWeights) {
  const frequency = (recommendation.evidence_session_ids || []).length;
  const relevance = CATEGORY_DIAL_RELEVANCE[recommendation.category];
  const profileFit = relevance ? dotProduct(dialWeights, relevance) : 1;
  return frequency * profileFit;
}

function firstSentence(text) {
  const match = /^.*?[.!?](?=\s|$)/.exec(text || '');
  return match ? match[0] : text;
}

// ---------------------------------------------------------------------------
// HTML report (§4.2)
// ---------------------------------------------------------------------------

function writeHtmlReport(run, confirmedRecommendations) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const fileName = run.generatedAt.replace(/[:.]/g, '-') + '.html';
  const reportPath = path.join(REPORTS_DIR, fileName);
  const allRuns = loadAllRuns();
  fs.writeFileSync(reportPath, renderHtmlReport(run, confirmedRecommendations, allRuns));
  return reportPath;
}

const DIAL_LABELS = { cost: 'Cost', speed: 'Speed', quality: 'Quality', interaction: 'Interaction' };
const DIAL_TAGS_PER_CATEGORY = 2;

function topDialsForCategory(letter) {
  const relevance = CATEGORY_DIAL_RELEVANCE[letter];
  return Object.entries(relevance)
    .sort((a, b) => b[1] - a[1])
    .slice(0, DIAL_TAGS_PER_CATEGORY)
    .map(([dial]) => dial);
}

function loadAllRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs.readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson(path.join(RUNS_DIR, f)));
}

function renderHtmlReport(run, confirmedRecommendations, allRuns) {
  const grouped = groupRecommendationsByCategory(confirmedRecommendations, run.dialWeights);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Loupe review, ${escapeHtml(run.generatedAt)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${REPORT_CSS}</style>
</head>
<body class="viz-root">
<main>
${renderHeader(run)}
${renderRegressionBanner(run)}
${renderCategoryTable(run, allRuns, grouped)}
${renderRecommendationsSection(grouped)}
</main>
<script>${REPORT_JS}</script>
</body>
</html>`;
}

function groupRecommendationsByCategory(confirmedRecommendations, dialWeights) {
  const ranked = rankRecommendations(confirmedRecommendations, dialWeights);
  const groups = [];
  for (const letter of Object.keys(CATEGORY_KEYS)) {
    const items = ranked.filter((r) => r.category === letter);
    if (items.length > 0) groups.push({ letter, items });
  }
  return groups;
}

function renderHeader(run) {
  const weights = Object.entries(run.dialWeights)
    .map(([dial, w]) => `${DIAL_LABELS[dial]} ${Math.round(w * 100)}%`)
    .join(', ');
  return `<header class="report-header">
  <div class="composite-badge grade-${run.compositeGrade}">${escapeHtml(run.compositeGrade)}</div>
  <div>
    <h1>Loupe review</h1>
    <p class="meta">Composite score ${run.compositeScore}/100 &middot; profile "${escapeHtml(run.profile)}" (${escapeHtml(weights)}) &middot; ${run.sessionsAnalyzed} sessions analyzed &middot; ${escapeHtml(formatTimestamp(run.generatedAt))}</p>
  </div>
</header>`;
}

function renderRegressionBanner(run) {
  if (!run.deltas || run.deltas.regressions.length === 0) return '';
  const items = run.deltas.regressions
    .map((r) => `<li><strong>${escapeHtml(CATEGORY_LABELS[r.category])}</strong>: ${escapeHtml(r.from)} → ${escapeHtml(r.to)}</li>`)
    .join('');
  return `<div class="banner banner-critical">
  <strong>Regression flagged.</strong> The following categories dropped 2 or more letter grades since the last run:
  <ul>${items}</ul>
</div>`;
}

function renderCategoryTable(run, allRuns, grouped) {
  const hasContent = new Set(grouped.map((g) => g.letter));
  const rows = Object.keys(CATEGORY_KEYS).map((letter) => renderCategoryRow(letter, run, allRuns, hasContent.has(letter))).join('');
  return `<section>
  <h2>Grade breakdown</h2>
  <p class="meta">Categories with confirmed recommendations link to them below; grayed-out swatches had none this run.</p>
  <table class="grade-table">
    <thead><tr><th>Category</th><th>Grade</th><th>Score</th><th>Trend</th><th>Confirmed</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function renderCategoryRow(letter, run, allRuns, isLinkable) {
  const cat = run.categories[letter];
  const delta = run.deltas ? run.deltas.perCategory[letter] : null;
  const deltaLabel = delta ? `${deltaArrow(delta.direction)} ${delta.previousGrade} → ${delta.currentGrade}` : 'first run';
  const scoreHistory = allRuns.map((r) => r.categories[letter].score);
  const swatchClass = isLinkable ? `swatch-${escapeHtml(letter)}` : 'swatch-empty';
  const label = `<span class="category-swatch ${swatchClass}"></span>${escapeHtml(CATEGORY_LABELS[letter])}`;
  const categoryCell = isLinkable
    ? `<a class="category-link" href="#rec-${escapeHtml(letter)}">${label}</a>`
    : `<span class="category-empty" title="No confirmed recommendations this run">${label}</span>`;
  return `<tr>
    <td>${categoryCell}</td>
    <td><span class="grade-pill grade-${cat.grade}">${escapeHtml(cat.grade)}</span></td>
    <td>${cat.score}</td>
    <td>${renderSparkline(scoreHistory)}<span class="delta-label">${escapeHtml(deltaLabel)}</span></td>
    <td>${cat.confirmedFindingCount} <span class="muted">(${cat.gapFindingCount} gap, ${cat.affirmingFindingCount} affirming)</span></td>
  </tr>`;
}

const SPARKLINE_WIDTH = 80;
const SPARKLINE_HEIGHT = 20;
const SPARKLINE_PADDING = 3;

function renderSparkline(scores) {
  if (scores.length < 2) return '<span class="muted">not enough history</span>';

  const points = scores.map((score, i) => {
    const x = SPARKLINE_PADDING + (i / (scores.length - 1)) * (SPARKLINE_WIDTH - 2 * SPARKLINE_PADDING);
    const y = SPARKLINE_HEIGHT - SPARKLINE_PADDING - (score / 100) * (SPARKLINE_HEIGHT - 2 * SPARKLINE_PADDING);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lastPoint = points[points.length - 1].split(',');

  return `<svg class="sparkline" width="${SPARKLINE_WIDTH}" height="${SPARKLINE_HEIGHT}" viewBox="0 0 ${SPARKLINE_WIDTH} ${SPARKLINE_HEIGHT}">
    <polyline points="${points.join(' ')}" class="sparkline-line" />
    <circle cx="${lastPoint[0]}" cy="${lastPoint[1]}" r="2.5" class="sparkline-dot" />
  </svg>`;
}

function renderRecommendationsSection(grouped) {
  const total = grouped.reduce((sum, g) => sum + g.items.length, 0);
  if (total === 0) {
    return '<section><h2>Recommendations</h2><p>No confirmed recommendations this run.</p></section>';
  }
  const sections = grouped.map(renderCategoryGroup).join('');
  return `<section>
  <h2>Recommendations (${total})</h2>
  ${sections}
</section>`;
}

function renderCategoryGroup(group) {
  const cards = group.items.map(renderRecommendationCard).join('');
  return `<div class="category-group" id="rec-${escapeHtml(group.letter)}">
  <h3 class="category-group-title"><span class="category-swatch swatch-${escapeHtml(group.letter)}"></span>${escapeHtml(CATEGORY_LABELS[group.letter])}</h3>
  ${cards}
</div>`;
}

function renderRecommendationCard(rec) {
  const evidenceIds = (rec.evidence_session_ids || []).map((id) => `<code>${escapeHtml(id)}</code>`).join(', ');
  const affirmingTag = rec.is_gap === false ? '<span class="tag tag-good">working well, codify it</span>' : '';
  const dialTags = topDialsForCategory(rec.category)
    .map((dial) => `<span class="tag tag-dial">${escapeHtml(DIAL_LABELS[dial])}</span>`)
    .join('');
  return `<article class="rec-card">
  <div class="rec-header">
    ${affirmingTag}
    ${dialTags}
  </div>
  <p class="rec-text">${escapeHtml(rec.recommendation)}</p>
  <details class="artifact-details">
    <summary>Proposed artifact &amp; apply prompt</summary>
    ${rec.proposed_artifact ? `<h4>Proposed artifact</h4><pre class="code-block"><code>${escapeHtml(rec.proposed_artifact)}</code></pre>` : ''}
    <h4>Apply prompt</h4>
    <div class="apply-block">
      <pre class="code-block"><code>${escapeHtml(rec.apply_prompt || '')}</code></pre>
      <button type="button" class="copy-btn" data-copy-text="${escapeHtml(rec.apply_prompt || '')}">Copy</button>
    </div>
  </details>
  <p class="evidence">Evidence: ${evidenceIds || '<span class="muted">none</span>'}</p>
</article>`;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function formatTimestamp(isoString) {
  return new Date(isoString).toUTCString();
}

// ---------------------------------------------------------------------------
// Inline CSS / JS (self-contained — §7, no build step, no CDN)
// ---------------------------------------------------------------------------

const REPORT_CSS = `
:root {
  --surface-1:      #fcfcfb;
  --page-plane:     #f9f9f7;
  --text-primary:   #0b0b0b;
  --text-secondary: #52514e;
  --text-muted:     #898781;
  --gridline:       #e1e0d9;
  --border:         rgba(11,11,11,0.10);
  --status-good:    #0ca30c;
  --status-warning: #fab219;
  --status-serious: #ec835a;
  --status-critical:#d03b3b;
  --series-1: #2a78d6; --series-2: #1baf7a; --series-3: #eda100; --series-4: #008300;
  --series-5: #4a3aa7; --series-6: #e34948; --series-7: #e87ba4;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface-1:      #1a1a19;
    --page-plane:     #0d0d0d;
    --text-primary:   #ffffff;
    --text-secondary: #c3c2b7;
    --text-muted:     #898781;
    --gridline:       #2c2c2a;
    --border:         rgba(255,255,255,0.10);
    --status-good:    #0ca30c;
    --status-warning: #fab219;
    --status-serious: #ec835a;
    --status-critical:#d03b3b;
    --series-1: #3987e5; --series-2: #199e70; --series-3: #c98500; --series-4: #008300;
    --series-5: #9085e9; --series-6: #e66767; --series-7: #d55181;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1rem 4rem;
  background: var(--page-plane); color: var(--text-primary);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 780px; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 0.75rem; }
h3 { font-size: 0.85rem; margin: 1rem 0 0.35rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em; }
p { margin: 0.4rem 0; }
.meta { color: var(--text-secondary); font-size: 0.9rem; }
.muted { color: var(--text-muted); }
.report-header { display: flex; align-items: center; gap: 1.25rem; }
.composite-badge {
  flex: none; width: 64px; height: 64px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  font-size: 1.75rem; font-weight: 600; color: #fff;
  background: var(--status-good);
}
.composite-badge.grade-A, .composite-badge.grade-B { background: var(--status-good); }
.composite-badge.grade-C { background: var(--status-warning); color: #2b2200; }
.composite-badge.grade-D { background: var(--status-serious); }
.composite-badge.grade-F { background: var(--status-critical); }
.banner { border-radius: 8px; padding: 0.75rem 1rem; margin-top: 1.5rem; font-size: 0.9rem; }
.banner-critical { background: color-mix(in srgb, var(--status-critical) 12%, var(--surface-1)); border: 1px solid var(--status-critical); }
.banner ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
.grade-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
.grade-table th, .grade-table td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--gridline); vertical-align: middle; }
.grade-table th { color: var(--text-muted); font-weight: 500; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
.grade-pill {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.8rem; height: 1.8rem; border-radius: 6px; font-weight: 600; color: #fff; font-size: 0.85rem;
}
.grade-pill.grade-A, .grade-pill.grade-B { background: var(--status-good); }
.grade-pill.grade-C { background: var(--status-warning); color: #2b2200; }
.grade-pill.grade-D { background: var(--status-serious); }
.grade-pill.grade-F { background: var(--status-critical); }
.category-swatch { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-right: 0.5rem; vertical-align: middle; }
.swatch-A { background: var(--series-1); }
.swatch-B { background: var(--series-2); }
.swatch-C { background: var(--series-3); }
.swatch-D { background: var(--series-4); }
.swatch-E { background: var(--series-5); }
.swatch-F { background: var(--series-6); }
.swatch-G { background: var(--series-7); }
.sparkline { vertical-align: middle; margin-right: 0.5rem; }
.sparkline-line { fill: none; stroke: var(--text-muted); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.sparkline-dot { fill: var(--series-1); stroke: var(--surface-1); stroke-width: 2; }
.delta-label { font-size: 0.82rem; color: var(--text-secondary); vertical-align: middle; }
.category-link { color: var(--text-primary); text-decoration: none; border-bottom: 1px dashed var(--text-muted); cursor: pointer; }
.category-link:hover { border-bottom-style: solid; }
.category-empty { color: var(--text-muted); cursor: default; }
.swatch-empty { background: transparent; border: 1px solid var(--text-muted); }
.category-group { margin-top: 1.5rem; scroll-margin-top: 1rem; }
.category-group-title {
  font-size: 1rem; color: var(--text-primary); text-transform: none; letter-spacing: normal;
  padding-top: 0.6rem; margin-top: 0; border-top: 2px solid var(--gridline);
}
.rec-card { border: 1px solid var(--border); border-radius: 10px; padding: 0.85rem 1.1rem; margin-bottom: 0.75rem; background: var(--surface-1); }
.rec-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; }
.tag { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 999px; background: color-mix(in srgb, var(--status-good) 16%, var(--surface-1)); color: var(--status-good); }
.tag-dial { background: var(--page-plane); color: var(--text-secondary); border: 1px solid var(--border); }
.rec-text { font-size: 0.93rem; }
.artifact-details { margin-top: 0.5rem; }
.artifact-details summary {
  cursor: pointer; font-size: 0.82rem; color: var(--text-secondary);
  padding: 0.3rem 0; user-select: none;
}
.artifact-details summary:hover { color: var(--text-primary); }
.artifact-details[open] summary { margin-bottom: 0.25rem; }
.artifact-details h4 { font-size: 0.78rem; margin: 0.75rem 0 0.3rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.03em; }
.code-block {
  background: var(--page-plane); border: 1px solid var(--border); border-radius: 6px;
  padding: 0.75rem; font-size: 0.82rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
}
.apply-block { position: relative; }
.copy-btn {
  position: absolute; top: 0.5rem; right: 0.5rem;
  font: inherit; font-size: 0.78rem; padding: 0.25rem 0.6rem;
  border-radius: 6px; border: 1px solid var(--border); background: var(--surface-1); color: var(--text-primary);
  cursor: pointer;
}
.copy-btn:hover { background: var(--page-plane); }
.copy-btn.copied { background: var(--status-good); color: #fff; border-color: var(--status-good); }
.evidence { font-size: 0.8rem; color: var(--text-secondary); }
.evidence code { font-size: 0.78rem; }
table { table-layout: auto; }
@media (max-width: 480px) {
  .grade-table { display: block; overflow-x: auto; }
}
`;

const REPORT_JS = `
document.addEventListener('click', function (event) {
  var btn = event.target.closest('.copy-btn');
  if (!btn) return;
  var text = btn.getAttribute('data-copy-text') || '';
  copyToClipboard(text).then(function () {
    var original = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(function () { btn.textContent = original; btn.classList.remove('copied'); }, 1500);
  });
});

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
  }
  return legacyCopy(text);
}

function legacyCopy(text) {
  return new Promise(function (resolve) {
    var textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand('copy'); } catch (err) { /* best effort */ }
    document.body.removeChild(textarea);
    resolve();
  });
}
`;

main();
