'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildGradingQueue, clusterReach } = require('../grading-queue');

function clusters(count, reach) {
  return Array.from({ length: count }, (_, i) => ({ id: i, evidenceSessionIds: Array.from({ length: reach }, (_, j) => `s${j}`) }));
}

test('clusterReach prefers evidenceSessionCount, then the wider of sessions and occurrences', () => {
  assert.equal(clusterReach({ evidenceSessionCount: 40, evidenceSessionIds: ['a'] }), 40);
  assert.equal(clusterReach({ evidenceSessionIds: ['a', 'b'], occurrenceCount: 5 }), 5);
  assert.equal(clusterReach({ evidenceSessionIds: ['a', 'b', 'c'], occurrenceCount: 1 }), 3);
  assert.equal(clusterReach({}), 0);
});

test('a high-reach category cannot take the other categories\' shares', () => {
  const queue = buildGradingQueue({
    A_guidelines: clusters(30, 1),
    B_skills: clusters(30, 2),
    F_agentParallelism: clusters(60, 50),
    G_sessionHygiene: clusters(30, 1),
  });
  assert.equal(queue.queued, 20);
  assert.equal(queue.perCategoryShare, 5);
  assert.deepEqual(queue.queuedByCategory, { A: 5, B: 5, F: 5, G: 5 });
  assert.equal(queue.skipped, 150 - 20);
});

test('unused slots are redistributed by reach', () => {
  const queue = buildGradingQueue({
    C_hooks: clusters(2, 3),
    D_mcps: clusters(1, 4),
    E_modelRouting: clusters(10, 1),
    F_agentParallelism: clusters(40, 2),
  });
  assert.equal(queue.perCategoryShare, 5);
  assert.deepEqual(queue.queuedByCategory, { C: 2, D: 1, E: 5, F: 12 });
  assert.equal(queue.queued, 20);
});

test('fewer candidates than slots queues everything', () => {
  const queue = buildGradingQueue({ A_guidelines: clusters(2, 1), C_hooks: [], D_mcps: clusters(1, 1) });
  assert.equal(queue.queued, 3);
  assert.equal(queue.skipped, 0);
  assert.deepEqual(Object.keys(queue.queuedByCategory), ['A', 'D']);
});

test('more categories than slots keeps the widest-reach clusters', () => {
  const queue = buildGradingQueue({ A_guidelines: clusters(1, 1), B_skills: clusters(1, 9), C_hooks: clusters(1, 5) }, 2);
  assert.equal(queue.queued, 2);
  assert.deepEqual(queue.queuedByCategory, { A: 0, B: 1, C: 1 });
});

test('entries carry the category letter and the cluster for grade.sh', () => {
  const cluster = { evidenceSessionIds: ['s1'] };
  const queue = buildGradingQueue({ D_mcps: [cluster] });
  assert.deepEqual(queue.entries, [{ categoryLetter: 'D', reach: 1, cluster }]);
});

test('empty candidates give an empty queue', () => {
  const queue = buildGradingQueue({});
  assert.equal(queue.queued, 0);
  assert.deepEqual(queue.entries, []);
});
