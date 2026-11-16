'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { combineByDeveloper, renderMarkdown } = require('../plugins/loupe/skills/review/scripts/aggregate');
const { EXPORT_SCHEMA } = require('../plugins/loupe/skills/review/scripts/export');

const AGGREGATE_SCRIPT = path.join(__dirname, '..', 'plugins', 'loupe', 'skills', 'review', 'scripts', 'aggregate.js');

function exportFor(developer, { sessions = 10, skillGaps = 0, runAt = '2026-11-01T00:00:00.000Z', models = ['model-x'] } = {}) {
  const categories = {};
  for (const letter of 'ABCDEFG') categories[letter] = { gaps: 0, affirming: 0, graded: 0, candidates: 0 };
  categories.B = { gaps: skillGaps, affirming: 0, graded: skillGaps, candidates: skillGaps + 1 };
  const findings = Array.from({ length: skillGaps }, (_, i) => ({
    category: 'B',
    isGap: true,
    evidenceSessionCount: 2,
    recommendation: `Encode procedure ${i} as a skill.`,
    proposedArtifact: null,
  }));
  return { schema: EXPORT_SCHEMA, developer, runGeneratedAt: runAt, sessionsAnalyzed: sessions, gradingModels: models, categories, findings };
}

test('several exports from one developer are summed and the rate recomputed', () => {
  const [alex] = combineByDeveloper([
    exportFor('alex', { sessions: 10, skillGaps: 1, runAt: '2026-10-01T00:00:00.000Z' }),
    exportFor('alex', { sessions: 30, skillGaps: 3, runAt: '2026-11-01T00:00:00.000Z' }),
  ]);
  assert.equal(alex.exportCount, 2);
  assert.equal(alex.sessionsAnalyzed, 40);
  assert.equal(alex.categories.B.gaps, 4);
  assert.equal(alex.categories.B.gapsPer10Sessions, 1);
  assert.equal(alex.firstRun, '2026-10-01T00:00:00.000Z');
  assert.equal(alex.lastRun, '2026-11-01T00:00:00.000Z');
  assert.equal(alex.findings.length, 4);
});

test('developers are sorted by name', () => {
  const names = combineByDeveloper([exportFor('sam'), exportFor('alex')]).map((d) => d.developer);
  assert.deepEqual(names, ['alex', 'sam']);
});

test('a category with gaps for two developers is called out as a team pattern', () => {
  const markdown = renderMarkdown(combineByDeveloper([exportFor('alex', { skillGaps: 1 }), exportFor('sam', { skillGaps: 2 })]));
  assert.match(markdown, /\*\*Skills\*\*: gaps for 2 of 2 developers \(alex, sam\)/);
  assert.match(markdown, /Encode procedure 0 as a skill\./);
});

test('no team pattern is claimed when only one developer has gaps', () => {
  const markdown = renderMarkdown(combineByDeveloper([exportFor('alex', { skillGaps: 1 }), exportFor('sam')]));
  assert.match(markdown, /No category has gaps for more than one developer/);
});

test('exports graded with different models get a warning', () => {
  const mixed = renderMarkdown(combineByDeveloper([exportFor('alex'), exportFor('sam', { models: ['model-y'] })]));
  assert.match(mixed, /graded with different models/);
  const same = renderMarkdown(combineByDeveloper([exportFor('alex'), exportFor('sam')]));
  assert.doesNotMatch(same, /graded with different models/);
});

test('the CLI reads a folder and skips files that are not exports', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-aggregate-'));
  fs.writeFileSync(path.join(dir, 'alex.json'), JSON.stringify(exportFor('alex', { skillGaps: 1 })));
  fs.writeFileSync(path.join(dir, 'other.json'), JSON.stringify({ schema: 'something-else' }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

  const result = spawnSync(process.execPath, [AGGREGATE_SCRIPT, dir], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /^# Loupe team view/);
  assert.match(result.stdout, /## alex/);
  assert.match(result.stderr, /Skipping .*other\.json/);
  assert.match(result.stderr, /Skipping .*broken\.json/);
});

test('the CLI fails clearly when nothing valid is found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-aggregate-empty-'));
  const result = spawnSync(process.execPath, [AGGREGATE_SCRIPT, dir], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No valid Loupe exports found/);
});
