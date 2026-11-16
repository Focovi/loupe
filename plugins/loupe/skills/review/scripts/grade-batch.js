#!/usr/bin/env node
'use strict';

/**
 * Grades a slice of the grading queue several clusters at a time.
 *
 * One `grade.js` call takes 15 seconds to several minutes, and running 20
 * of them one after another made a full review take over half an hour.
 * This runs a batch of them side by side. The review skill calls it once
 * per batch so it can report progress between batches, and so no single
 * call outlasts a tool timeout.
 *
 * Usage:
 *   node grade-batch.js <heuristics output path> --out <dir> [--start N] [--count N]
 *   node grade-batch.js --collect --out <dir>
 *
 * Each cluster's result goes to <dir>/NN.json, or <dir>/NN.err when grading
 * failed. A cluster that already has a result is skipped, so a batch can be
 * re-run safely. Prints one progress line per cluster, in queue order.
 * --collect prints every successful result as one JSON array, ready for
 * consolidate.js.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { CATEGORY_LABELS } = require('./export');

const GRADE_SCRIPT = path.join(__dirname, 'grade.js');
// Measured on a 20-cluster queue: 4 at a time took 113 s, 6 took 93 s and
// 8 took 73 s, with no errors and no batch over 30 s.
const DEFAULT_BATCH_SIZE = 8;
const REASON_MAX_CHARS = 100;
const RESULT_NAME_DIGITS = 2;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) fail('usage: grade-batch.js <heuristics output path> --out <dir> [--start N] [--count N] | --collect --out <dir>');

  if (args.collect) {
    process.stdout.write(JSON.stringify(collectResults(args.out), null, 2) + '\n');
    return;
  }

  const heuristics = JSON.parse(fs.readFileSync(args.heuristicsPath, 'utf8'));
  const entries = heuristics.gradingQueue.entries;
  const start = Number(args.start || 0);
  const count = Number(args.count || DEFAULT_BATCH_SIZE);
  fs.mkdirSync(args.out, { recursive: true });

  const slice = entries.slice(start, start + count).map((entry, offset) => ({ entry, position: start + offset }));
  const lines = await Promise.all(slice.map(({ entry, position }) => gradeEntry(entry, position, args.out)));
  lines.forEach((line, i) => process.stdout.write(`[${slice[i].position + 1}/${entries.length}] ${line}\n`));
  const next = start + slice.length;
  process.stdout.write(next < entries.length ? `next: --start ${next}\n` : 'done\n');
}

async function gradeEntry(entry, position, outDir) {
  const label = CATEGORY_LABELS[entry.categoryLetter] || entry.categoryLetter;
  const resultPath = path.join(outDir, `${resultName(position)}.json`);
  const errorPath = path.join(outDir, `${resultName(position)}.err`);
  if (fs.existsSync(resultPath)) return `${label}: ${describeResult(readJson(resultPath))} (already graded)`;

  const { code, stdout, stderr } = await runGrade(entry);
  if (code === 0) {
    fs.writeFileSync(resultPath, stdout);
    fs.rmSync(errorPath, { force: true });
    return `${label}: ${describeResult(JSON.parse(stdout))}`;
  }
  fs.writeFileSync(errorPath, stderr || `grade.js exited with ${code}\n`);
  return `${label}: error (${clip(firstErrorMessage(stderr))})`;
}

function runGrade(entry) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GRADE_SCRIPT, entry.categoryLetter], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => resolve({ code: 1, stdout, stderr: JSON.stringify({ error: err.message }) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(entry.cluster));
  });
}

function describeResult(graded) {
  if (graded && graded.recommendation) return 'accepted';
  return `rejected (${clip(graded && graded.rejected_reason)})`;
}

function collectResults(outDir) {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((name) => /^\d+\.json$/.test(name))
    .sort()
    .map((name) => readJson(path.join(outDir, name)))
    .filter(Boolean);
}

function firstErrorMessage(stderr) {
  const parsed = readJsonText(stderr);
  return (parsed && parsed.error) || (stderr || '').trim().split('\n')[0] || 'unknown error';
}

function resultName(position) {
  return String(position + 1).padStart(RESULT_NAME_DIGITS, '0');
}

function clip(text) {
  if (typeof text !== 'string' || text.length === 0) return 'no reason given';
  return text.length > REASON_MAX_CHARS ? text.slice(0, REASON_MAX_CHARS) + '…' : text;
}

function readJson(filePath) {
  return readJsonText(fs.readFileSync(filePath, 'utf8'));
}

function readJsonText(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function parseArgs(argv) {
  const args = { collect: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--collect') args.collect = true;
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--start') args.start = argv[++i];
    else if (arg === '--count') args.count = argv[++i];
    else args.heuristicsPath = arg;
  }
  return args;
}

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { describeResult, collectResults, parseArgs, resultName };
