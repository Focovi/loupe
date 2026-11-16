'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  extractJson,
  readAnswer,
  callClaude,
  GRADE_SCHEMA,
  buildClaudeInvocation,
  resolveGradeModel,
  DEFAULT_GRADE_MODEL,
} = require('../plugins/loupe/skills/review/scripts/grade');

const CLAUDE_ARGS = ['-p', '--model', 'claude-sonnet-5-5', '--output-format', 'json', '--allowedTools', ''];

test('extractJson accepts bare, fenced and prose-wrapped JSON', () => {
  assert.deepEqual(extractJson('{"category":"A"}'), { category: 'A' });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"category":"B"}\n```'), { category: 'B' });
  assert.deepEqual(extractJson('Sure. {"category":"C"} Hope that helps.'), { category: 'C' });
  assert.equal(extractJson('no json here'), null);
  assert.equal(extractJson(undefined), null);
});

test('default model is a full, explicit ID', () => {
  assert.match(DEFAULT_GRADE_MODEL, /^claude-[a-z]+-\d/);
  assert.equal(resolveGradeModel({}), DEFAULT_GRADE_MODEL);
  assert.equal(resolveGradeModel({ LOUPE_GRADE_MODEL: 'claude-test-1' }), 'claude-test-1');
  assert.throws(() => resolveGradeModel({ LOUPE_GRADE_MODEL: 'x & del' }));
});

test('macOS and Linux run claude directly', () => {
  const invocation = buildClaudeInvocation(CLAUDE_ARGS, { platform: 'darwin', env: {} });
  assert.deepEqual(invocation, { command: 'claude', args: CLAUDE_ARGS, windowsVerbatimArguments: false });
});

test('Windows runs claude.exe directly', () => {
  const invocation = buildClaudeInvocation(CLAUDE_ARGS, {
    platform: 'win32',
    env: {},
    findOnPath: () => 'C:\\Users\\alex\\.local\\bin\\claude.exe',
  });
  assert.equal(invocation.command, 'C:\\Users\\alex\\.local\\bin\\claude.exe');
  assert.deepEqual(invocation.args, CLAUDE_ARGS);
});

test('Windows runs claude.cmd through cmd.exe with quoted arguments', () => {
  const invocation = buildClaudeInvocation(CLAUDE_ARGS, {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
    findOnPath: () => 'C:\\Program Files\\nodejs\\claude.cmd',
  });
  assert.equal(invocation.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.deepEqual(invocation.args, [
    '/d',
    '/s',
    '/c',
    '""C:\\Program Files\\nodejs\\claude.cmd" -p --model claude-sonnet-5-5 --output-format json --allowedTools """',
  ]);
});

test('LOUPE_CLAUDE_BIN overrides the lookup', () => {
  const invocation = buildClaudeInvocation(CLAUDE_ARGS, { platform: 'linux', env: { LOUPE_CLAUDE_BIN: '/opt/claude/bin/claude' } });
  assert.equal(invocation.command, '/opt/claude/bin/claude');
});

test('the Claude Code running the session is used when claude is not on PATH', () => {
  const execPath = '/Applications/Claude/claude-code/2.1.0/claude';

  const invocation = buildClaudeInvocation(CLAUDE_ARGS, { platform: 'darwin', env: { CLAUDE_CODE_EXECPATH: execPath } });

  assert.equal(invocation.command, execPath);
});

test('LOUPE_CLAUDE_BIN wins over the running Claude Code', () => {
  const env = { LOUPE_CLAUDE_BIN: '/opt/claude/bin/claude', CLAUDE_CODE_EXECPATH: '/Applications/Claude/claude' };

  const invocation = buildClaudeInvocation(CLAUDE_ARGS, { platform: 'darwin', env });

  assert.equal(invocation.command, '/opt/claude/bin/claude');
});

test('Windows runs the running Claude Code without a PATH lookup', () => {
  const execPath = 'C:\\Users\\alex\\AppData\\Roaming\\Claude\\claude-code\\claude.exe';

  const invocation = buildClaudeInvocation(CLAUDE_ARGS, {
    platform: 'win32',
    env: { CLAUDE_CODE_EXECPATH: execPath },
    findOnPath: () => assert.fail('PATH should not be searched'),
  });

  assert.equal(invocation.command, execPath);
  assert.equal(invocation.windowsVerbatimArguments, false);
});

// Stands in for claude: records its arguments and answers with a
// schema-checked result, the way claude -p --json-schema does.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS, JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const graded = { category: 'B', evidence_session_ids: ['s1'], title: 'Add a skill', recommendation: 'Do it.' };
  process.stdout.write(JSON.stringify({ is_error: false, result: '', structured_output: graded }));
});
`;

function withFakeClaude() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-grade-test-'));
  const claudeBin = path.join(dir, 'claude');
  fs.writeFileSync(claudeBin, FAKE_CLAUDE, { mode: 0o755 });
  const argsFile = path.join(dir, 'args.json');
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, LOUPE_CLAUDE_BIN: claudeBin, FAKE_CLAUDE_ARGS: argsFile };
  return { dir, env, readArgs: () => JSON.parse(fs.readFileSync(argsFile, 'utf8')) };
}

function argAfter(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test('the grading call runs isolated from the developer setup and saves no session', { skip: process.platform === 'win32' }, () => {
  const { env, readArgs } = withFakeClaude();
  const savedEnv = process.env;
  process.env = env;
  try {
    callClaude('prompt', 'claude-test-1', GRADE_SCHEMA);
  } finally {
    process.env = savedEnv;
  }

  const args = readArgs();
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(args.includes(flag), flag);
  assert.equal(argAfter(args, '--setting-sources'), '');
  assert.equal(argAfter(args, '--tools'), '');
  assert.equal(argAfter(args, '--effort'), 'medium');
  assert.match(argAfter(args, '--system-prompt'), /grader for Loupe/);
  assert.deepEqual(JSON.parse(argAfter(args, '--json-schema')), GRADE_SCHEMA);
  assert.ok(Number(argAfter(args, '--max-budget-usd')) > 0);
});

test('grade.js records the grader setup with the model', { skip: process.platform === 'win32' }, () => {
  const { env } = withFakeClaude();
  const gradeScript = path.join(__dirname, '..', 'plugins', 'loupe', 'skills', 'review', 'scripts', 'grade.js');

  const stdout = execFileSync(process.execPath, [gradeScript, 'B'], {
    env: { ...env, LOUPE_GRADE_MODEL: 'claude-test-1' },
    input: JSON.stringify({ evidenceSessionIds: ['s1'] }),
    encoding: 'utf8',
  });

  const graded = JSON.parse(stdout);
  assert.equal(graded.title, 'Add a skill');
  assert.equal(graded.grading_model, 'claude-test-1 (isolated grader, medium effort)');
});

test('readAnswer prefers the schema-checked answer', () => {
  const answer = readAnswer({ structured_output: { category: 'A' }, result: '{"category":"B"}' });

  assert.deepEqual(answer, { category: 'A' });
});

test('readAnswer falls back to JSON in the reply text', () => {
  const answer = readAnswer({ result: 'Here:\n```json\n{"category":"B"}\n```' });

  assert.deepEqual(answer, { category: 'B' });
});

test('Windows escapes the quotes inside the schema for claude.cmd', () => {
  const args = ['--json-schema', '{"type":"object"}'];

  const invocation = buildClaudeInvocation(args, {
    platform: 'win32',
    env: {},
    findOnPath: () => 'C:\\npm\\claude.cmd',
  });

  assert.equal(invocation.args[3], '"C:\\npm\\claude.cmd --json-schema "{\\"type\\":\\"object\\"}""');
});
