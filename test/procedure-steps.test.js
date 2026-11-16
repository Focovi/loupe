'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProcedureSteps,
  commandSteps,
  unscriptedSessionSteps,
} = require('../plugins/loupe/skills/review/scripts/procedure-steps');

function human(text) {
  return { type: 'user', isMeta: false, isToolResultTurn: false, text, toolUses: [] };
}

function assistant(...toolUses) {
  return { type: 'assistant', text: null, toolUses };
}

function bash(command) {
  return { type: 'tool_use', name: 'Bash', input: { command } };
}

test('commandSteps keeps command names and subcommands from a chain', () => {
  assert.deepEqual(commandSteps('cd app && npm ci && gh pr create --fill'), ['npm ci', 'gh pr create']);
});

test('commandSteps keeps the second word of two-level git commands', () => {
  assert.deepEqual(commandSteps('git worktree add ../x && git stash pop'), ['git worktree add', 'git stash pop']);
});

test('commandSteps drops looking around and read-only git', () => {
  assert.deepEqual(commandSteps('git status; git log --oneline | head -5; ls -la'), []);
});

test('commandSteps does not split on pipes inside quotes', () => {
  assert.deepEqual(commandSteps('grep -E "Post|Put|Patch" api.js'), []);
});

test('commandSteps ignores heredoc bodies and inline scripts', () => {
  const command = "python3 - <<'EOF'\nimport json\ndeploy()\nEOF";

  assert.deepEqual(commandSteps(command), []);
});

test('commandSteps names scripts by file', () => {
  assert.deepEqual(commandSteps('./scripts/release.sh v2 && node tools/check-links.js'), ['release.sh', 'node check-links.js']);
});

test('commandSteps skips git -C and wrappers to reach the subcommand', () => {
  assert.deepEqual(commandSteps('git -C ../app push origin main && FOO=1 npx prettier --write .'), ['git push', 'prettier']);
});

test('unscriptedSessionSteps stops once a skill loads', () => {
  const session = {
    turns: [
      assistant(bash('make build'), { type: 'tool_use', name: 'Skill', input: { skill: 'deploy' } }, bash('make deploy')),
    ],
  };

  assert.deepEqual(unscriptedSessionSteps(session), ['make build']);
});

test('unscriptedSessionSteps stops at a slash command but not a built-in one', () => {
  const session = {
    turns: [
      human('<command-name>/clear</command-name>'),
      assistant(bash('make build')),
      human('<command-name>/deploy</command-name>'),
      assistant(bash('make deploy')),
    ],
  };

  assert.deepEqual(unscriptedSessionSteps(session), ['make build']);
});

test('unscriptedSessionSteps skips a scheduled task run', () => {
  const session = { turns: [human('<scheduled-task name="nightly">\nRun the report.'), assistant(bash('make report'))] };

  assert.deepEqual(unscriptedSessionSteps(session), []);
});

test('unscriptedSessionSteps keeps MCP tool calls as steps', () => {
  const session = { turns: [assistant({ type: 'tool_use', name: 'mcp__ci__getBuild', input: {} }, { type: 'tool_use', name: 'Read', input: {} })] };

  assert.deepEqual(unscriptedSessionSteps(session), ['mcp__ci__getBuild']);
});

test('buildProcedureSteps drops steps found in most sessions', () => {
  const sessions = Array.from({ length: 20 }, (_, i) => ({
    sessionId: `s${i}`,
    turns: [assistant(bash('git commit -m x'), bash(i < 2 ? 'terraform apply' : 'npm test'))],
  }));

  const steps = buildProcedureSteps(sessions);

  assert.deepEqual(steps.get('s0'), ['terraform apply']);
  assert.deepEqual(steps.get('s5'), []);
});
