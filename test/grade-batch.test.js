'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { describeResult, collectResults } = require('../plugins/loupe/skills/review/scripts/grade-batch');

const BATCH_SCRIPT = path.join(__dirname, '../plugins/loupe/skills/review/scripts/grade-batch.js');
const FAKE_CALL_MS = 400;

// Stands in for the claude CLI: accepts category B, rejects C, fails on D,
// and logs when each call starts and ends, so the test can check the calls
// overlapped. Timing the whole batch instead failed on a busy machine.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
const log = (event) => fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, event + ' ' + Date.now() + '\\n');
log('start');
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => setTimeout(() => {
  log('end');
  const category = (input.match(/"categoryLetter":"([A-G])"/) || input.match(/Category ([A-G]) /))[1];
  if (category === 'D') { process.stdout.write('not json'); process.exit(1); }
  const graded = category === 'C'
    ? { category, evidence_session_ids: [], recommendation: null, rejected_reason: 'one-off' }
    : { category, evidence_session_ids: ['s1'], recommendation: 'Do the thing.' };
  process.stdout.write(JSON.stringify({ is_error: false, result: JSON.stringify(graded) }));
}, ${FAKE_CALL_MS}));
`;

function setup(letters) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-batch-test-'));
  const claudeBin = path.join(dir, 'claude');
  fs.writeFileSync(claudeBin, FAKE_CLAUDE, { mode: 0o755 });
  const entries = letters.map((categoryLetter) => ({ categoryLetter, reach: 2, cluster: { evidenceSessionIds: ['s1', 's2'] } }));
  const heuristicsPath = path.join(dir, 'heuristics.json');
  fs.writeFileSync(heuristicsPath, JSON.stringify({ gradingQueue: { entries } }));
  const logPath = path.join(dir, 'calls.log');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, LOUPE_CLAUDE_BIN: claudeBin, FAKE_CLAUDE_LOG: logPath };
  return { dir, heuristicsPath, outDir: path.join(dir, 'graded'), env, logPath };
}

// The most calls running at one moment. A sequential batch gives 1.
function maxConcurrentCalls(logPath) {
  const events = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => line.split(' '))
    .sort((a, b) => Number(a[1]) - Number(b[1]) || (a[0] === 'end' ? -1 : 1));
  let running = 0;
  let most = 0;
  for (const [kind] of events) {
    running += kind === 'start' ? 1 : -1;
    most = Math.max(most, running);
  }
  return most;
}

function runBatch({ heuristicsPath, outDir, env }, extraArgs) {
  return execFileSync(process.execPath, [BATCH_SCRIPT, heuristicsPath, '--out', outDir, ...extraArgs], { env, encoding: 'utf8' });
}

test('grade-batch grades a batch side by side and reports each result', { skip: process.platform === 'win32' }, () => {
  const ctx = setup(['B', 'B', 'C', 'D', 'B']);
  const output = runBatch(ctx, ['--start', '0', '--count', '4']);

  assert.match(output, /\[1\/5\] Skills: accepted/);
  assert.match(output, /\[3\/5\] Hooks: rejected \(one-off\)/);
  assert.match(output, /\[4\/5\] MCPs: error \(/);
  assert.match(output, /next: --start 4/);
  assert.ok(maxConcurrentCalls(ctx.logPath) >= 2, 'the calls ran one at a time');
  assert.ok(fs.existsSync(path.join(ctx.outDir, '04.err')));

  const last = runBatch(ctx, ['--start', '4']);
  assert.match(last, /\[5\/5\] Skills: accepted/);
  assert.match(last, /done/);

  const collected = collectResults(ctx.outDir);
  assert.equal(collected.length, 4, 'the failed cluster is left out');
  assert.equal(collected[2].category, 'C');
});

test('grade-batch skips clusters that already have a result', { skip: process.platform === 'win32' }, () => {
  const ctx = setup(['B']);
  fs.mkdirSync(ctx.outDir);
  fs.writeFileSync(path.join(ctx.outDir, '01.json'), JSON.stringify({ category: 'B', recommendation: 'Earlier.' }));
  assert.match(runBatch(ctx, []), /Skills: accepted \(already graded\)/);
});

test('describeResult names rejections with their reason', () => {
  assert.equal(describeResult({ recommendation: 'x' }), 'accepted');
  assert.equal(describeResult({ recommendation: null, rejected_reason: 'too thin' }), 'rejected (too thin)');
  assert.equal(describeResult(null), 'rejected (no reason given)');
});
