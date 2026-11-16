'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractJson,
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
