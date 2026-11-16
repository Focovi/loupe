#!/usr/bin/env node
'use strict';

/**
 * Loupe team view. Combines exports from export.js (one or more per
 * developer) into a Markdown summary a lead can use to give each developer
 * individual guidance.
 *
 * Runs are incremental, so one export covers only the sessions since that
 * developer's previous run. Several exports from the same developer are
 * therefore summed, not deduplicated.
 *
 * Usage:
 *   node aggregate.js <export file or folder> [...more] [--json]
 */

const fs = require('fs');
const path = require('path');
const { EXPORT_SCHEMA, CATEGORY_LABELS } = require('./export');

const SESSIONS_PER_RATE = 10;
const CATEGORY_LETTERS = Object.keys(CATEGORY_LABELS);
const UNRECORDED_MODEL = 'unrecorded';

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const inputs = argv.filter((arg) => !arg.startsWith('--'));
  if (inputs.length === 0) fail('usage: aggregate.js <export file or folder> [...more] [--json]');

  const exports = inputs.flatMap(expandToJsonFiles).map(readExport).filter(Boolean);
  if (exports.length === 0) fail('No valid Loupe exports found.');

  const developers = combineByDeveloper(exports);
  process.stdout.write(asJson ? JSON.stringify(developers, null, 2) + '\n' : renderMarkdown(developers));
}

function expandToJsonFiles(input) {
  if (!fs.statSync(input).isDirectory()) return [input];
  return fs
    .readdirSync(input)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(input, name));
}

function readExport(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (data.schema === EXPORT_SCHEMA) return data;
    process.stderr.write(`Skipping ${filePath}: not a ${EXPORT_SCHEMA} file.\n`);
  } catch (err) {
    process.stderr.write(`Skipping ${filePath}: ${err.message}\n`);
  }
  return null;
}

function combineByDeveloper(exports) {
  const byName = new Map();
  for (const exported of exports) {
    if (!byName.has(exported.developer)) byName.set(exported.developer, emptyDeveloper(exported.developer));
    addExport(byName.get(exported.developer), exported);
  }
  const developers = [...byName.values()];
  for (const developer of developers) finalizeRates(developer);
  return developers.sort((a, b) => a.developer.localeCompare(b.developer));
}

function emptyDeveloper(name) {
  const categories = {};
  for (const letter of CATEGORY_LETTERS) categories[letter] = { gaps: 0, affirming: 0, graded: 0, candidates: 0 };
  return { developer: name, exportCount: 0, sessionsAnalyzed: 0, firstRun: null, lastRun: null, gradingModels: [], categories, findings: [] };
}

function addExport(developer, exported) {
  developer.exportCount += 1;
  developer.sessionsAnalyzed += exported.sessionsAnalyzed;
  developer.firstRun = minIso(developer.firstRun, exported.runGeneratedAt);
  developer.lastRun = maxIso(developer.lastRun, exported.runGeneratedAt);
  for (const model of exportGradingModels(exported)) {
    if (!developer.gradingModels.includes(model)) developer.gradingModels.push(model);
  }
  for (const letter of CATEGORY_LETTERS) {
    const source = exported.categories[letter];
    if (!source) continue;
    const target = developer.categories[letter];
    target.gaps += source.gaps;
    target.affirming += source.affirming;
    target.graded += source.graded;
    target.candidates += source.candidates;
  }
  developer.findings.push(...exported.findings);
}

// Exports made before the grading model was recorded say nothing about it.
function exportGradingModels(exported) {
  const models = exported.gradingModels || [];
  return models.length ? models : [UNRECORDED_MODEL];
}

function finalizeRates(developer) {
  for (const category of Object.values(developer.categories)) {
    category.gapsPer10Sessions = developer.sessionsAnalyzed
      ? Math.round((category.gaps / developer.sessionsAnalyzed) * SESSIONS_PER_RATE * 10) / 10
      : null;
  }
}

function renderMarkdown(developers) {
  const lines = ['# Loupe team view', ''];
  lines.push(...renderGradingModelWarning(developers));
  lines.push(...renderOverviewTable(developers), '');
  lines.push(...renderTeamPatterns(developers), '');
  for (const developer of developers) lines.push(...renderDeveloper(developer), '');
  lines.push(
    '_Rates are gap findings per 10 sessions. Each run grades at most 20 candidate clusters, so a high',
    'candidate count with few graded means some patterns were not checked. Grades are not comparable',
    'between people; use the findings._',
  );
  return lines.join('\n') + '\n';
}

// Rates are only comparable when every export was graded by the same
// model, so a mix is called out before anything else.
function renderGradingModelWarning(developers) {
  const allModels = new Set(developers.flatMap((d) => d.gradingModels));
  if (allModels.size <= 1) return [];
  const lines = ['> **Warning: these exports were graded with different models, so rates are not fully comparable.**'];
  for (const developer of developers) lines.push(`> - ${developer.developer}: ${developer.gradingModels.join(', ')}`);
  lines.push('> Ask everyone to run the same Loupe version without LOUPE_GRADE_MODEL set, then re-export.', '');
  return lines;
}

function renderOverviewTable(developers) {
  const header = ['Developer', 'Sessions', ...CATEGORY_LETTERS.map((l) => CATEGORY_LABELS[l])];
  const rows = developers.map((developer) => [
    developer.developer,
    String(developer.sessionsAnalyzed),
    ...CATEGORY_LETTERS.map((letter) => formatRate(developer.categories[letter].gapsPer10Sessions)),
  ]);
  return [
    '## Gap findings per 10 sessions',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ];
}

function renderTeamPatterns(developers) {
  const lines = ['## Team patterns', ''];
  for (const letter of CATEGORY_LETTERS) {
    const withGaps = developers.filter((d) => d.categories[letter].gaps > 0).map((d) => d.developer);
    if (withGaps.length >= 2) {
      lines.push(`- **${CATEGORY_LABELS[letter]}**: gaps for ${withGaps.length} of ${developers.length} developers (${withGaps.join(', ')}). Worth a team-wide fix.`);
    }
  }
  if (lines.length === 2) lines.push('- No category has gaps for more than one developer.');
  return lines;
}

function renderDeveloper(developer) {
  const lines = [
    `## ${developer.developer}`,
    '',
    `${developer.sessionsAnalyzed} sessions across ${developer.exportCount} export(s), runs ${dateOnly(developer.firstRun)} to ${dateOnly(developer.lastRun)}.`,
    '',
  ];
  const gaps = developer.findings.filter((f) => f.isGap);
  const habits = developer.findings.filter((f) => !f.isGap);
  lines.push('**Guidance**', '');
  lines.push(...(gaps.length ? gaps.map(renderFinding) : ['- No confirmed gaps.']));
  if (habits.length) lines.push('', '**Good habits to keep**', '', ...habits.map(renderFinding));
  return lines;
}

function renderFinding(finding) {
  const text = (finding.recommendation || '').replace(/\s+/g, ' ').trim();
  return `- (${CATEGORY_LABELS[finding.category]}, ${finding.evidenceSessionCount} sessions) ${text}`;
}

function formatRate(rate) {
  return rate === null ? '-' : String(rate);
}

function dateOnly(iso) {
  return iso ? iso.slice(0, 10) : '?';
}

function minIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function maxIso(a, b) {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { combineByDeveloper, renderMarkdown };
