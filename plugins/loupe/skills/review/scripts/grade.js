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
 *
 * The call runs isolated from the developer's own setup: no settings,
 * CLAUDE.md, plugins, skills, MCP servers, hooks or tools, Loupe's own
 * system prompt, a pinned effort level, and a JSON schema for the answer.
 * That keeps it cheap (about 1,300 tokens of overhead instead of 50,000)
 * and makes every developer's grades come from the same grader.
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
// Pinned for the same reason as the model: otherwise the call inherits the
// effort of whichever session started the review.
const GRADE_EFFORT = 'medium';
// Recorded with the model, so runs graded before the grader was isolated
// show up as a different grading setup in the report and the team view.
const GRADER_SETUP = 'isolated grader, medium effort';
// A safety cap per call. A full grading prompt costs well under this.
const MAX_CALL_BUDGET_USD = '2';
// Plain words only: on Windows this reaches cmd.exe for claude.cmd.
const GRADER_SYSTEM_PROMPT =
  'You are the grader for Loupe. Follow the instructions in the user message and answer only with the JSON object it asks for.';
const NULLABLE_STRING = { type: ['string', 'null'] };
const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string' },
    evidence_session_ids: { type: 'array', items: { type: 'string' } },
    is_gap: { type: ['boolean', 'null'] },
    title: NULLABLE_STRING,
    recommendation: NULLABLE_STRING,
    proposed_artifact: {},
    apply_prompt: NULLABLE_STRING,
    rejected_reason: { type: 'string' },
  },
  required: ['category', 'evidence_session_ids'],
};
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_KEYS = GRADE_SCHEMA.required;
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

  const envelope = callClaude(prompt, model, GRADE_SCHEMA);
  if (envelope.is_error) throw new GradeError({ error: 'claude -p call failed', detail: envelope });

  const graded = readAnswer(envelope);
  if (!graded) throw new GradeError({ error: 'model did not return valid JSON', raw: envelope.result });
  const missing = REQUIRED_KEYS.filter((key) => !(key in graded));
  if (missing.length > 0) throw new GradeError({ error: 'graded response missing keys', missing, raw: graded });

  return { ...graded, grading_model: `${model} (${GRADER_SETUP})`, grading_cost_usd: costOf(envelope) };
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

/**
 * One isolated, structured `claude -p` call. No tools keeps it a pure
 * text-in/text-out call that can't recurse into Loupe's own scripts. No
 * session persistence means it leaves no transcript for the next review
 * to filter out. The prompt goes on stdin: --tools takes a list and would
 * swallow a trailing prompt argument.
 */
function callClaude(prompt, model, schema) {
  const claudeArgs = [
    '-p',
    '--model', model,
    '--effort', GRADE_EFFORT,
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt', GRADER_SYSTEM_PROMPT,
    '--tools', '',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--max-budget-usd', MAX_CALL_BUDGET_USD,
  ];
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
 * the lookup. Otherwise the Claude Code running this session wins
 * (CLAUDE_CODE_EXECPATH): the desktop app bundles its own copy and puts
 * none on PATH, and that copy is the one already signed in.
 */
function buildClaudeInvocation(claudeArgs, { platform, env, findOnPath = findExecutableOnPath }) {
  const configured = env.LOUPE_CLAUDE_BIN || env.CLAUDE_CODE_EXECPATH;
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

// Every argument here is a fixed flag, a validated model ID, a path, the
// plain-words system prompt or the schema JSON, none with cmd.exe's special
// characters, so double quoting with escaped inner quotes is enough; an
// empty argument becomes "".
function quoteForCmd(arg) {
  return /^[A-Za-z0-9._:\\/-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
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

/** What claude -p says the call cost, or null when it reports nothing. */
function costOf(envelope) {
  return typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : null;
}

/**
 * The schema-checked answer, or for a Claude Code that returns none, the
 * JSON found in the reply text.
 */
function readAnswer(envelope) {
  if (envelope.structured_output && typeof envelope.structured_output === 'object') return envelope.structured_output;
  return extractJson(envelope.result);
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

module.exports = {
  extractJson,
  readAnswer,
  buildClaudeInvocation,
  resolveGradeModel,
  callClaude,
  GradeError,
  DEFAULT_GRADE_MODEL,
  GRADE_SCHEMA,
};
