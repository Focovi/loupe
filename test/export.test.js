'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { buildExport, EXPORT_SCHEMA } = require('../plugins/loupe/skills/review/scripts/export');

const EXPORT_SCRIPT = path.join(__dirname, '..', 'plugins', 'loupe', 'skills', 'review', 'scripts', 'export.js');
const SESSION_A = '3f2a9c10-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const SESSION_B = '7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f';

function category(overrides = {}) {
  return {
    score: 100,
    grade: 'A',
    heuristicCandidateCount: 0,
    confirmedFindingCount: 0,
    gapFindingCount: 0,
    affirmingFindingCount: 0,
    rejectedAtGradingCount: 0,
    confirmedFindings: [],
    ...overrides,
  };
}

function sampleRun(overrides = {}) {
  const categories = {};
  for (const letter of 'ABCDEFG') categories[letter] = category();
  categories.B = category({
    score: 85,
    grade: 'B',
    heuristicCandidateCount: 4,
    confirmedFindingCount: 1,
    gapFindingCount: 1,
    rejectedAtGradingCount: 2,
    confirmedFindings: [
      {
        category: 'B',
        evidence_session_ids: [SESSION_A, SESSION_B],
        is_gap: true,
        recommendation: `Sessions 3f2a9c10 and 7c1d2e3f re-derive the Acme deploy steps in /Users/alex/code/app.`,
        proposed_artifact: { name: 'deploy-acme', steps: ['ask alex@example.com'] },
        apply_prompt: 'Create /Users/alex/code/app/.claude/skills/deploy-acme/SKILL.md',
      },
    ],
  });
  categories.F = category({
    affirmingFindingCount: 1,
    confirmedFindingCount: 1,
    confirmedFindings: [
      { category: 'F', evidence_session_ids: [SESSION_A], is_gap: false, recommendation: 'Serial work was kept serial.', proposed_artifact: null, apply_prompt: null },
    ],
  });
  return { generatedAt: '2026-11-01T10:00:00.000Z', profile: 'balanced', sessionsAnalyzed: 20, gradingModels: ['model-x'], categories, ...overrides };
}

test('the export keeps counts and rates and marks good habits', () => {
  const exported = buildExport(sampleRun(), 'alex', []);
  assert.equal(exported.schema, EXPORT_SCHEMA);
  assert.equal(exported.developer, 'alex');
  assert.equal(exported.sessionsAnalyzed, 20);
  assert.deepEqual(exported.gradingModels, ['model-x']);
  assert.deepEqual(exported.categories.B, {
    label: 'Skills',
    grade: 'B',
    score: 85,
    candidates: 4,
    graded: 3,
    gaps: 1,
    affirming: 0,
    rejected: 2,
    gapsPer10Sessions: 0.5,
  });
  assert.equal(exported.findings.length, 2);
  assert.equal(exported.findings[0].evidenceSessionCount, 2);
  assert.equal(exported.findings[1].isGap, false);
});

test('the export drops session IDs, apply prompts and home paths', () => {
  const serialized = JSON.stringify(buildExport(sampleRun(), 'alex', []));
  for (const leaked of [SESSION_A, SESSION_B, '3f2a9c10', '7c1d2e3f', '/Users/alex', 'alex@example.com']) {
    assert.ok(!serialized.includes(leaked), `export contains ${leaked}`);
  }
  assert.ok(!serialized.includes('apply_prompt'));
  assert.ok(!serialized.includes('evidence_session_ids'));
});

test('redact terms apply to recommendations and proposed artifacts', () => {
  const exported = buildExport(sampleRun(), 'alex', ['Acme']);
  const [finding] = exported.findings;
  assert.ok(!/acme/i.test(finding.recommendation));
  assert.ok(!/acme/i.test(finding.proposedArtifact));
  assert.ok(exported.replacementCount > 0);
});

test('a run with no sessions has no rate instead of dividing by zero', () => {
  const exported = buildExport(sampleRun({ sessionsAnalyzed: 0 }), 'alex', []);
  assert.equal(exported.categories.B.gapsPer10Sessions, null);
});

test('a run made before grading models were recorded exports an empty list', () => {
  const run = sampleRun();
  delete run.gradingModels;
  assert.deepEqual(buildExport(run, 'alex', []).gradingModels, []);
});

test('the CLI writes the export, merges config redact terms and ends with the path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-export-'));
  const loupeDir = path.join(home, '.loupe');
  fs.mkdirSync(loupeDir);
  fs.writeFileSync(path.join(loupeDir, 'config.json'), JSON.stringify({ exportName: 'from-config', exportRedact: ['Acme'] }));
  const runPath = path.join(home, 'run.json');
  fs.writeFileSync(runPath, JSON.stringify(sampleRun()));
  const outPath = path.join(home, 'out', 'export.json');

  const stdout = execFileSync(process.execPath, [EXPORT_SCRIPT, '--run', runPath, '--out', outPath], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  });

  const lines = stdout.trim().split('\n');
  assert.equal(lines[lines.length - 1], outPath);
  const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.equal(written.developer, 'from-config');
  assert.ok(!/acme/i.test(JSON.stringify(written.findings)));
  assert.match(stdout, /Read the findings above before sharing/);
});
