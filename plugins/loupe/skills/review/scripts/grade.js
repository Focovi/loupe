#!/usr/bin/env node
'use strict';

/**
 * Loupe grading pass (Full Spec §3).
 *
 * Wraps a single headless `claude -p` call on a PINNED model — never
 * whatever model happens to be invoking the /loupe:review skill — so grade
 * consistency (§5) doesn't drift with the invoking session's model choice.
 * Runs the same on macOS, Linux and Windows: no shell, no bash, no jq.
 *
 * Usage:
 *   node grade.js <category letter A-G> < cluster.json
 *
 * Reads one candidate cluster as JSON on stdin, prints one graded
 * recommendation as JSON on stdout: {category, evidence_session_ids,
 * recommendation, proposed_artifact, apply_prompt, grading_model}.
 * Exits 1 with a JSON error on stderr when anything fails.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

// Explicitly named, not an alias like "sonnet" — aliases track "latest" and
// would silently drift the rubric's judgment call over time. Every
// developer must grade with the same ID or their results stop being
// comparable; the ID is recorded on each graded result so the team view
// can tell. Override with LOUPE_GRADE_MODEL only to repin deliberately.
const DEFAULT_GRADE_MODEL = 'claude-sonnet-5-5';
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_KEYS = ['category', 'evidence_session_ids'];
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const EXIT_FAILURE = 1;

const HEURISTICS_SCRIPT = path.join(__dirname, 'heuristics.js');
const PROMPT_SCRIPT = path.join(__dirname, 'build-grade-prompt.js');

class GradeError extends Error {
  constructor(payload) {
    super(payload.error);
    this.payload = payload;
  }
}

function main() {
  const category = process.argv[2];
  if (!category) fail({ error: 'usage: grade.js <category letter A-G>, cluster JSON on stdin' });

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-grade-'));
  try {
    const graded = gradeCluster(category, fs.readFileSync(0, 'utf8'), workDir);
    process.stdout.write(JSON.stringify(graded) + '\n');
  } catch (err) {
    fail(err instanceof GradeError ? err.payload : { error: err.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function gradeCluster(category, clusterJson, workDir) {
  const model = resolveGradeModel(process.env);
  const cluster = parseJson(clusterJson, 'candidate cluster is not valid JSON');
  const sessionIds = cluster.evidenceSessionIds || cluster.evidence_session_ids || [];
  if (sessionIds.length === 0) throw new GradeError({ error: 'candidate cluster has no evidenceSessionIds' });

  const clusterFile = path.join(workDir, 'cluster.json');
  const digestFile = path.join(workDir, 'digest.json');
  fs.writeFileSync(clusterFile, clusterJson);
  fs.writeFileSync(digestFile, runNode([HEURISTICS_SCRIPT, '--digest', sessionIds.join(',')]));
  const prompt = runNode([PROMPT_SCRIPT, category, clusterFile, digestFile]);

  const envelope = callClaude(prompt, model);
  if (envelope.is_error) throw new GradeError({ error: 'claude -p call failed', detail: envelope });

  // The grading call itself creates a new Claude Code session — exclude it
  // from future Loupe runs the same way the orchestrating skill session is
  // excluded (§3 self-referential exclusion).
  if (envelope.session_id) markSessionAsSelf(envelope.session_id);

  const graded = extractJson(envelope.result);
  if (!graded) throw new GradeError({ error: 'model did not return valid JSON', raw: envelope.result });
  const missing = REQUIRED_KEYS.filter((key) => !(key in graded));
  if (missing.length > 0) throw new GradeError({ error: 'graded response missing keys', missing, raw: graded });

  return { ...graded, grading_model: model };
}

function resolveGradeModel(env) {
  const model = env.LOUPE_GRADE_MODEL || DEFAULT_GRADE_MODEL;
  // The ID reaches a command line on Windows (via cmd.exe for claude.cmd),
  // so only plain model-ID characters are allowed.
  if (!MODEL_ID_PATTERN.test(model)) throw new GradeError({ error: 'LOUPE_GRADE_MODEL is not a valid model ID', model });
  return model;
}

function runNode(args) {
  return execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES });
}

function callClaude(prompt, model) {
  // No tool access: this is a pure text-in/text-out grading call, and
  // denying tools keeps it fast, cheap, and unable to recurse into Loupe's
  // own scripts. The prompt goes on stdin: --allowedTools takes a list
  // and would swallow a trailing prompt argument.
  const claudeArgs = ['-p', '--model', model, '--output-format', 'json', '--allowedTools', ''];
  const invocation = buildClaudeInvocation(claudeArgs, { platform: process.platform, env: process.env });
  const result = spawnSync(invocation.command, invocation.args, {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) {
    throw new GradeError({ error: 'could not run the claude CLI', detail: result.error.message, command: invocation.command });
  }
  const envelope = parseJson(result.stdout, null);
  if (!envelope) {
    throw new GradeError({ error: 'claude -p call failed', exitCode: result.status, stderr: (result.stderr || '').trim() });
  }
  return envelope;
}

/**
 * Works out how to start `claude` without a shell. On Windows a native
 * install is claude.exe and runs directly; an npm install is claude.cmd,
 * which Node can only start through cmd.exe. LOUPE_CLAUDE_BIN overrides
 * the lookup.
 */
function buildClaudeInvocation(claudeArgs, { platform, env, findOnPath = findExecutableOnPath }) {
  const configured = env.LOUPE_CLAUDE_BIN;
  if (platform !== 'win32') return { command: configured || 'claude', args: claudeArgs, windowsVerbatimArguments: false };

  const executable = configured || findOnPath(['claude.exe', 'claude.cmd'], env) || 'claude.exe';
  if (!/\.(cmd|bat)$/i.test(executable)) return { command: executable, args: claudeArgs, windowsVerbatimArguments: false };

  const commandLine = [executable, ...claudeArgs].map(quoteForCmd).join(' ');
  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

// Every argument here is a fixed flag, a validated model ID or a path, so
// plain double quoting is enough; an empty argument becomes "".
function quoteForCmd(arg) {
  return /^[A-Za-z0-9._:\\/-]+$/.test(arg) ? arg : `"${arg}"`;
}

function findExecutableOnPath(names, env) {
  const pathValue = env.PATH || env.Path || '';
  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function markSessionAsSelf(sessionId) {
  try {
    execFileSync(process.execPath, [HEURISTICS_SCRIPT, '--mark-self', sessionId], { stdio: 'ignore' });
  } catch (err) {
    // non-fatal — worst case this grading session gets analyzed next run
  }
}

/**
 * Models sometimes add prose before/after the JSON, or wrap it in a
 * markdown fence, despite being told to respond with only the JSON
 * object. Try progressively more forgiving extraction rather than
 * trusting the instruction alone.
 */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const attempts = [
    text.trim(),
    (text.match(/```(?:json)?\s*([\s\S]*?)```/i) || [])[1],
    (text.match(/\{[\s\S]*\}/) || [])[0],
  ];
  for (const candidate of attempts) {
    if (!candidate) continue;
    const parsed = parseJson(candidate.trim(), null);
    if (parsed) return parsed;
  }
  return null;
}

function parseJson(text, errorMessage) {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (errorMessage === null) return null;
    throw new GradeError({ error: errorMessage });
  }
}

function fail(payload) {
  process.stderr.write(JSON.stringify(payload) + '\n');
  process.exit(EXIT_FAILURE);
}

if (require.main === module) main();

module.exports = { extractJson, buildClaudeInvocation, resolveGradeModel, DEFAULT_GRADE_MODEL };
