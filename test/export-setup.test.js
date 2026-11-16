'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveDeveloperName,
  collectRedactTerms,
  findPossibleNames,
  rememberChoices,
  addToSharedList,
} = require('../plugins/loupe/skills/review/scripts/export-setup');

const noGitName = () => '';

test('resolveDeveloperName prefers --as, then the saved name, then git', () => {
  assert.equal(resolveDeveloperName('Sam', { exportName: 'Saved' }, () => 'Git Name'), 'Sam');
  assert.equal(resolveDeveloperName(undefined, { exportName: 'Saved' }, () => 'Git Name'), 'Saved');
  assert.equal(resolveDeveloperName(undefined, {}, () => 'Git Name'), 'Git Name');
});

test('resolveDeveloperName falls back to unnamed without git', () => {
  assert.equal(resolveDeveloperName(undefined, {}, noGitName), 'unnamed');
});

test('collectRedactTerms merges config, extra terms and shared list files', () => {
  const files = { '/team/redact.txt': '# clients\nAcme\n\nGlobex  \n' };
  const config = { exportRedact: ['Initech'], exportRedactFiles: ['/team/redact.txt'] };

  const { terms, unreadableFiles } = collectRedactTerms(config, ['Acme', 'Hooli'], (file) => files[file] ?? null);

  assert.deepEqual(terms, ['Initech', 'Acme', 'Hooli', 'Globex']);
  assert.deepEqual(unreadableFiles, []);
});

test('collectRedactTerms reports a list file it cannot read', () => {
  const { terms, unreadableFiles } = collectRedactTerms({ exportRedactFiles: ['/missing.txt'] }, [], () => null);

  assert.deepEqual(terms, []);
  assert.deepEqual(unreadableFiles, ['/missing.txt']);
});

function exportWith(findings, developer = 'Sam Lee') {
  return { developer, findings };
}

test('findPossibleNames lists capitalized words mid-sentence, most frequent first', () => {
  const exported = exportWith([
    { title: 'Add a skill for the Globex deploy', recommendation: 'Sessions for Globex and Initech repeat it.', proposedArtifact: null },
  ]);

  assert.deepEqual(findPossibleNames(exported), ['Globex', 'Initech']);
});

test('findPossibleNames skips sentence starts, headings, tool words and acronyms', () => {
  const exported = exportWith([
    { title: 'Route polling to Haiku', recommendation: 'Sessions ran Bash and Grep. The CI and PR checks.', proposedArtifact: '## Steps\n- Run the build' },
  ]);

  assert.deepEqual(findPossibleNames(exported), []);
});

test('findPossibleNames leaves out the developer name and redacted terms', () => {
  const exported = exportWith([{ title: 'Ask Sam Lee about [redacted] work', recommendation: 'x', proposedArtifact: null }]);

  assert.deepEqual(findPossibleNames(exported), []);
});

test('rememberChoices saves the name and adds terms without losing other settings', () => {
  const config = { projectRoots: ['~/code'], exportRedact: ['Acme'] };

  const saved = rememberChoices(config, { name: 'Sam', redactTerms: ['Acme', 'Globex'] });

  assert.deepEqual(saved, { projectRoots: ['~/code'], exportRedact: ['Acme', 'Globex'], exportName: 'Sam' });
});

function fakeList(text) {
  const appended = [];
  return { appended, io: { readText: () => text, appendText: (file, added) => appended.push(added) } };
}

test('addToSharedList appends only the terms the list does not have, ignoring case', () => {
  const { appended, io } = fakeList('# team list\nAcme\n');

  const added = addToSharedList('team.txt', ['acme', 'Globex', 'Globex', ' Initech '], io);

  assert.deepEqual(added, ['Globex', 'Initech']);
  assert.deepEqual(appended, ['Globex\nInitech\n']);
});

test('addToSharedList starts a new line when the list does not end with one', () => {
  const { appended, io } = fakeList('Acme');

  addToSharedList('team.txt', ['Globex'], io);

  assert.deepEqual(appended, ['\nGlobex\n']);
});

test('addToSharedList writes nothing when every term is already listed', () => {
  const { appended, io } = fakeList('Acme\n');

  const added = addToSharedList('team.txt', ['Acme'], io);

  assert.deepEqual(added, []);
  assert.deepEqual(appended, []);
});

test('addToSharedList throws when the list cannot be read', () => {
  assert.throws(() => addToSharedList('missing.txt', ['Acme'], { readText: () => null }), /could not read missing\.txt/);
});
