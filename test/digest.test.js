'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDigestBundle } = require('../plugins/loupe/skills/review/scripts/heuristics');

function longSession(sessionId, turnCount) {
  const turns = [];
  for (let i = 0; i < turnCount; i++) {
    turns.push({ type: 'user', isMeta: false, isToolResultTurn: false, text: `step ${i} `.repeat(40), toolUses: [] });
    turns.push({ type: 'assistant', text: 'done', toolUses: [{ name: 'Bash', input: { command: 'x'.repeat(200) } }] });
  }
  return { sessionId, turns };
}

test('buildDigestBundle keeps up to 80 turns per session when they fit', () => {
  const bundle = buildDigestBundle([longSession('s1', 100)], { sessionsRequested: 3 });
  assert.equal(bundle.sessionsRequested, 3);
  assert.equal(bundle.sessionsIncluded, 1);
  assert.equal(bundle.maxTurnsPerSession, 80);
  assert.equal(bundle.sessions[0].turnsIncludedInDigest, 80);
});

test('buildDigestBundle shrinks turns per session to fit the budget', () => {
  const sessions = Array.from({ length: 10 }, (_, i) => longSession(`s${i}`, 200));
  const maxChars = 200000;
  const bundle = buildDigestBundle(sessions, { maxChars });
  assert.equal(bundle.sessionsIncluded, 10, 'every session stays in the sample');
  assert.ok(bundle.maxTurnsPerSession < 80);
  assert.ok(JSON.stringify(bundle.sessions).length <= maxChars);
});

test('buildDigestBundle stops shrinking at the turn floor', () => {
  const bundle = buildDigestBundle([longSession('s1', 200)], { maxChars: 10 });
  assert.equal(bundle.maxTurnsPerSession, 10);
});

test('findSessionsById opens files named by session and falls back to a scan', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { findSessionsById } = require('../plugins/loupe/skills/review/scripts/heuristics');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loupe-digest-test-'));
  const line = (sessionId) => JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'hi' } }) + '\n';
  fs.writeFileSync(path.join(dir, 'aaa.jsonl'), line('aaa'));
  fs.writeFileSync(path.join(dir, 'renamed.jsonl'), line('bbb'));
  fs.writeFileSync(path.join(dir, 'ccc.jsonl'), line('ccc'));
  const files = ['aaa', 'renamed', 'ccc'].map((name) => path.join(dir, `${name}.jsonl`));

  const found = findSessionsById(['bbb', 'aaa', 'missing'], files);
  assert.deepEqual(found.map((s) => s.sessionId), ['bbb', 'aaa']);
});
