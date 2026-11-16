'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { createScrubber } = require('../plugins/loupe/skills/review/scripts/scrub');

function scrubOnce(text, redactTerms) {
  return createScrubber(redactTerms).scrub(text);
}

test('secrets with a recognizable shape are replaced', () => {
  const cases = [
    'AKIAABCDEFGHIJKLMNOP',
    'ASIAABCDEFGHIJKLMNOP',
    `ghp_${'a1'.repeat(18)}`,
    `sk-${'x9'.repeat(12)}`,
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----',
    'f'.repeat(16) + '0123456789abcdef',
  ];
  for (const secret of cases) {
    assert.equal(scrubOnce(`value ${secret} end`), 'value [secret] end', secret);
  }
});

test('emails, URLs and IPs are replaced', () => {
  assert.equal(scrubOnce('mail alex.lee+dev@example.co.uk now'), 'mail [email] now');
  assert.equal(scrubOnce('see https://internal.example.com/a?token=1 now'), 'see [url] now');
  assert.equal(scrubOnce('host 10.0.12.7 down'), 'host [ip] down');
});

test('a URL with credentials is replaced whole, not as an email', () => {
  assert.equal(scrubOnce('clone https://alex:pw@git.example.com/repo.git'), 'clone [url]');
});

test('home paths on every platform become ~', () => {
  assert.equal(scrubOnce('/Users/alex/code/app'), '~/code/app');
  assert.equal(scrubOnce('/home/alex/code/app'), '~/code/app');
  assert.equal(scrubOnce('C:\\Users\\alex\\code\\app'), '~\\code\\app');
  assert.equal(scrubOnce(path.join(os.homedir(), 'notes.md')), path.join('~', 'notes.md'));
});

test('session IDs and their short forms are replaced', () => {
  assert.equal(scrubOnce('in 3f2a9c10-1b2c-4d5e-8f90-a1b2c3d4e5f6 ok'), 'in [session] ok');
  assert.equal(scrubOnce('session 3f2a9c10 retried'), 'session [session] retried');
});

test('ordinary text that only looks a bit like an ID is kept', () => {
  const kept = [
    'version 20261005',
    'the deadbeef marker',
    'ticket ABC-123',
    'example-repo/main',
    '~/.claude/skills/review/SKILL.md',
    'run prettier then dotnet format',
  ];
  for (const text of kept) assert.equal(scrubOnce(text), text);
});

test('redact terms match inside identifiers but not as part of longer words', () => {
  const scrubbed = scrubOnce('search_acme AcmeApiClient getAcmeClient ACME acme. acmes', ['acme']);
  assert.equal(scrubbed, 'search_[redacted] [redacted]ApiClient get[redacted]Client [redacted] [redacted]. acmes');
});

test('multi-word redact terms match case-insensitively', () => {
  assert.equal(scrubOnce('Asked jane DOE to review', ['Jane Doe']), 'Asked [redacted] to review');
});

test('redact terms with regex characters are matched literally', () => {
  assert.equal(scrubOnce('uses a.b and axb', ['a.b']), 'uses [redacted] and axb');
});

test('blank redact terms are ignored', () => {
  assert.equal(scrubOnce('nothing here', ['', '  ']), 'nothing here');
});

test('null passes through, objects are stringified before scrubbing', () => {
  const { scrub } = createScrubber();
  assert.equal(scrub(null), null);
  assert.equal(scrub(undefined), undefined);
  assert.match(scrub({ contact: 'alex@example.com' }), /"contact": "\[email\]"/);
});

test('the replacement count covers every replacement across calls', () => {
  const { scrub, getReplacementCount } = createScrubber(['acme']);
  scrub('alex@example.com and 10.0.0.1');
  scrub('acme');
  assert.equal(getReplacementCount(), 3);
});
