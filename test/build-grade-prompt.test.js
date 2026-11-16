'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OUTPUT_CONTRACT, RUBRICS } = require('../plugins/loupe/skills/review/scripts/build-grade-prompt');

test('the output contract keeps names of people and clients out of shared fields', () => {
  assert.match(OUTPUT_CONTRACT, /never name a person, client, customer or their company/);
  assert.match(OUTPUT_CONTRACT, /title, recommendation and proposed_artifact may be shared/);
});

// Borderline clusters flipped between runs when the rubric left the bar
// to the grader's overall impression, so these categories decide by count.
test('skills are judged by how many digested sessions ran the procedure', () => {
  assert.match(RUBRICS.B, /Accept when 3 or more digested sessions support it; reject when 2 or fewer do/);
  assert.match(RUBRICS.B, /even cut off/);
});

test('long exploration is judged by how many sessions had a separable run', () => {
  assert.match(RUBRICS.F, /Accept when 2 or more digested sessions support it; reject when 0 or 1 do/);
});

test('model routing says how to judge each single-session signal', () => {
  assert.match(RUBRICS.E, /For short-session-expensive-model, reject a session that was a single quick question/);
  assert.match(RUBRICS.E, /A switch between two versions of the same tier says nothing about routing/);
});
