'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyHookRequest,
  followsFileEditTool,
  isManualWorkTurn,
  collectUsedMcpServers,
  countIndependentSerialChunks,
  isPersonTypedTurn,
  detectGuidelineCandidates,
  detectSkillCandidates,
  detectSessionHygieneCandidates,
  correctionRateSlope,
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

const COMPACTION_SUMMARY = 'This session is being continued from a previous conversation. Never commit generated files.';

test('isPersonTypedTurn drops injected user-role text', () => {
  assert.equal(isPersonTypedTurn(human("don't touch the lockfile")), true);
  assert.equal(isPersonTypedTurn(human(COMPACTION_SUMMARY)), false);
  assert.equal(isPersonTypedTurn(human('<system-reminder>never skip hooks</system-reminder>')), false);
  assert.equal(isPersonTypedTurn(human('<scheduled-task>always run the report</scheduled-task>')), false);
  assert.equal(isPersonTypedTurn(human('<cross-session-message>stop doing that</cross-session-message>')), false);
  assert.equal(isPersonTypedTurn(human('<artifact-view-context>never mind</artifact-view-context>')), false);
  assert.equal(isPersonTypedTurn(human('[Request interrupted by user for tool use]')), false);
  assert.equal(isPersonTypedTurn(human('Background (from the session that started this one): never push to main.')), false);
});

test('detectGuidelineCandidates ignores injected corrections', () => {
  const injected = '<system-reminder>never edit generated files</system-reminder>';
  const sessions = [
    { sessionId: 's1', turns: [human(injected), human("don't use var, use const")] },
    { sessionId: 's2', turns: [human(injected), human("don't use var here, use const")] },
  ];
  const clusters = detectGuidelineCandidates(new Map([['repo', sessions]]));
  assert.equal(clusters.length, 1);
  assert.match(clusters[0].representativeText, /use const/);
  assert.deepEqual(clusters[0].evidenceSessionIds, ['s1', 's2']);
});

test('detectGuidelineCandidates finds nothing when only injected text repeats', () => {
  const injected = '<system-reminder>never edit generated files</system-reminder>';
  const sessions = [
    { sessionId: 's1', turns: [human(injected), human('looks good')] },
    { sessionId: 's2', turns: [human(injected), human('ship it')] },
  ];
  assert.deepEqual(detectGuidelineCandidates(new Map([['repo', sessions]])), []);
});

test('correctionRateSlope skips injected turns when windowing', () => {
  const calm = Array.from({ length: 20 }, () => human('next step please'));
  const reminders = Array.from({ length: 10 }, () => human("<system-reminder>don't skip tests</system-reminder>"));
  assert.equal(correctionRateSlope({ turns: [...calm, ...reminders] }), 0);
});

test('correctionRateSlope still sees rising typed corrections', () => {
  const calm = Array.from({ length: 10 }, () => human('next step please'));
  const corrections = Array.from({ length: 10 }, () => human("no, don't do that"));
  assert.equal(correctionRateSlope({ turns: [...calm, human(COMPACTION_SUMMARY), ...corrections] }), 1);
});

test('detectGuidelineCandidates needs the correction in two or more sessions', () => {
  const sessions = [
    { sessionId: 's1', turns: [human("don't use var, use const"), human("don't use var here, use const")] },
    { sessionId: 's2', turns: [human('next step please')] },
  ];
  assert.deepEqual(detectGuidelineCandidates(new Map([['repo', sessions]])), []);
});

test('detectGuidelineCandidates counts repeated text once per session', () => {
  const repeated = "don't use var, use const";
  const sessions = [
    { sessionId: 's1', turns: [human(repeated), human(repeated), human(repeated)] },
    { sessionId: 's2', turns: [human(repeated)] },
  ];
  const clusters = detectGuidelineCandidates(new Map([['repo', sessions]]));
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].occurrenceCount, 2);
  assert.deepEqual(clusters[0].evidenceSessionIds, ['s1', 's2']);
});

test('detectSkillCandidates keeps a sample of evidence and the full count', () => {
  const sessions = Array.from({ length: 12 }, (_, i) => ({
    sessionId: `s${i}`,
    turns: [{ ...assistant(tool('Read', {}), tool('Edit', {}), tool('Bash', {})), timestamp: `2026-01-${String(i + 1).padStart(2, '0')}` }],
  }));
  const [cluster] = detectSkillCandidates(new Map([['repo', sessions]]));
  assert.equal(cluster.evidenceSessionCount, 12);
  assert.equal(cluster.evidenceSessionIds.length, 8);
  assert.equal(cluster.evidenceSessionIds[0], 's11', 'most recent first');
});

function risingSession(sessionId, correctionCount) {
  const calm = Array.from({ length: 10 }, () => human('next step please'));
  const late = Array.from({ length: 10 }, (_, i) => human(i < correctionCount ? "no, don't do that" : 'next step please'));
  return { sessionId, turns: [...calm, ...late] };
}

test('detectSessionHygieneCandidates ignores a rising correction rate in one session', () => {
  const clusters = detectSessionHygieneCandidates(new Map([['repo', [risingSession('s1', 8), risingSession('s2', 0)]]]));
  assert.deepEqual(clusters.filter((c) => c.signal === 'rising-correction-rate'), []);
});

test('detectSessionHygieneCandidates groups rising sessions, steepest first', () => {
  const sessions = [risingSession('s1', 3), risingSession('s2', 8), risingSession('s3', 0)];
  const [cluster] = detectSessionHygieneCandidates(new Map([['repo', sessions]])).filter((c) => c.signal === 'rising-correction-rate');
  assert.deepEqual(cluster.evidenceSessionIds, ['s2', 's1']);
  assert.equal(cluster.evidenceSessionCount, 2);
  assert.equal(cluster.maxSlope, 0.8);
});
