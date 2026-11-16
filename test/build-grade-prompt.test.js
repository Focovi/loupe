'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { OUTPUT_CONTRACT } = require('../plugins/loupe/skills/review/scripts/build-grade-prompt');

test('the output contract keeps names of people and clients out of shared fields', () => {
  assert.match(OUTPUT_CONTRACT, /never name a person, client, customer or their company/);
  assert.match(OUTPUT_CONTRACT, /title, recommendation and proposed_artifact may be shared/);
});
