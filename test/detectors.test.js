'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyHookRequest,
  followsFileEditTool,
  isManualWorkTurn,
  collectUsedMcpServers,
  countIndependentSerialChunks,
} = require('../plugins/loupe/skills/review/scripts/heuristics');

function human(text) {
  return { type: 'user', isMeta: false, isToolResultTurn: false, text, toolUses: [] };
}

function assistant(...toolUses) {
  return { type: 'assistant', text: null, toolUses };
}

function tool(name, input) {
  return { type: 'tool_use', name, input };
}

test('classifyHookRequest recognizes common follow-up phrasings', () => {
  assert.deepEqual(classifyHookRequest('run all tests'), ['test']);
  assert.deepEqual(classifyHookRequest('build, run all tests'), ['test', 'build']);
  assert.deepEqual(classifyHookRequest("let's fix the dotnet format"), ['format']);
  assert.deepEqual(classifyHookRequest('can you run the linter again'), ['lint']);
  assert.deepEqual(classifyHookRequest('does it still compile?'), ['build']);
  assert.deepEqual(classifyHookRequest('run tsc --noEmit'), ['typecheck']);
});

test('classifyHookRequest ignores non-code formatting and test plans', () => {
  assert.deepEqual(classifyHookRequest('format it for slack'), []);
  assert.deepEqual(classifyHookRequest('run the test plan against staging'), []);
  assert.deepEqual(classifyHookRequest('what is the date format?'), []);
});

test('followsFileEditTool sees Edit and Bash file writes in the previous reply', () => {
  const viaEdit = [human('fix it'), assistant(tool('Edit', { file_path: 'a.js' })), assistant(tool('Bash', { command: 'git status' })), human('run the tests')];
  assert.equal(followsFileEditTool(viaEdit, 3), true);

  const viaBash = [human('fix it'), assistant(tool('Bash', { command: "sed -i '' 's/a/b/' app.js" })), human('run the tests')];
  assert.equal(followsFileEditTool(viaBash, 2), true);
});

test('followsFileEditTool counts an edit several replies back', () => {
  const turns = [assistant(tool('Edit', { file_path: 'a.js' })), human('looks good'), assistant(tool('Read', { file_path: 'a.js' })), human('run all tests before I merge')];
  assert.equal(followsFileEditTool(turns, 3), true);
});

test('followsFileEditTool is false before any edit', () => {
  const turns = [human('what does this do?'), assistant(tool('Read', { file_path: 'a.js' }), tool('Bash', { command: 'git log -5' })), human('run the tests')];
  assert.equal(followsFileEditTool(turns, 2), false);
});

test('isManualWorkTurn catches relayed output and console checks', () => {
  assert.equal(isManualWorkTurn('I copied this from the dashboard'), true);
  assert.equal(isManualWorkTurn('check the api logs in staging for errors'), true);
  assert.equal(isManualWorkTurn('<pasted_content id="1"> ERROR: relation "orders" does not exist </pasted_content>'), true);
  assert.equal(isManualWorkTurn('check whoami and log in again'), false);
  assert.equal(isManualWorkTurn('looks good, merge it'), false);
  assert.equal(isManualWorkTurn('This session is being continued from a previous conversation. Never edit generated files by hand.'), false);
  assert.equal(isManualWorkTurn('<system-reminder>resolve it rather than by hand</system-reminder>'), false);
});

test('collectUsedMcpServers matches full configured names', () => {
  const sessions = [{ turns: [assistant(tool('mcp__plugin_acme_acme-cards__show', {}), tool('mcp__docs__search', {}))] }];
  const used = collectUsedMcpServers(sessions, ['plugin_acme_acme-cards', 'docs', 'issue-tracker']);
  assert.deepEqual([...used].sort(), ['docs', 'plugin_acme_acme-cards']);
});

test('countIndependentSerialChunks counts lookup runs but not Bash pipelines', () => {
  const lookups = { turns: [assistant(tool('Read', { file_path: 'a.js' }), tool('Read', { file_path: 'b.js' }), tool('Read', { file_path: 'c.js' }))] };
  assert.equal(countIndependentSerialChunks(lookups), 1);

  const pipeline = { turns: [assistant(tool('Bash', { command: 'npm run build' }), tool('Bash', { command: 'npm test' }), tool('Bash', { command: 'git commit -m x' }))] };
  assert.equal(countIndependentSerialChunks(pipeline), 0);
});
