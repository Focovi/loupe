'use strict';

/**
 * Text scrubbing for Loupe exports. A shared export leaves the developer's
 * machine, so anything that identifies a person, a machine or a secret is
 * replaced before it is written. Patterns catch what has a recognizable
 * shape (secrets, emails, URLs, IPs, home paths). Names of clients and
 * coworkers have no shape, so they come from an explicit redact list.
 */

const os = require('os');

const SECRET = '[secret]';

// Order matters: secrets and URLs go first so that a token inside a URL, or
// an email-like userinfo part of a URL, is removed as a whole.
const SHAPE_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, SECRET],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, SECRET],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, SECRET],
  [/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}\b/g, SECRET],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, SECRET],
  [/\b[A-Fa-f0-9]{32,}\b/g, SECRET],
  // Session IDs and their 8-character short forms let a reader line a
  // finding up with a specific transcript, so they never leave the machine.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[session]'],
  [/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,12}\b/g, '[session]'],
  [/\bhttps?:\/\/[^\s"'`)<>\]]+/g, '[url]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]'],
  [/(?:\/Users|\/home)\/[^/\s"'`]+/g, '~'],
  [/\b[A-Za-z]:\\Users\\[^\\\s"'`]+/g, '~'],
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildTermPatterns(redactTerms) {
  return redactTerms
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => [new RegExp(identifierAwareTermSource(term), 'g'), '[redacted]']);
}

// Matches a term case-insensitively wherever it is a word or an identifier
// part: search_kombo, KomboAtsClient and getKomboClient all match, while
// kombos does not. The match is case-insensitive through character classes
// rather than the i flag, because the camelCase checks need real case.
function identifierAwareTermSource(term) {
  const caseless = escapeRegExp(term).replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
  const start = '(?:(?<![A-Za-z0-9])|(?<=[a-z0-9])(?=[A-Z]))';
  const end = '(?![a-z0-9])';
  return `${start}${caseless}${end}`;
}

/**
 * Returns a scrubber that replaces sensitive text and counts what it
 * replaced, so the export preview can tell the developer how much changed.
 */
function createScrubber(redactTerms = []) {
  const homeDirPattern = [new RegExp(escapeRegExp(os.homedir()), 'g'), '~'];
  const patterns = [homeDirPattern, ...SHAPE_PATTERNS, ...buildTermPatterns(redactTerms)];
  let replacementCount = 0;

  function scrub(value) {
    if (value === null || value === undefined) return value;
    let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    for (const [pattern, replacement] of patterns) {
      text = text.replace(pattern, () => {
        replacementCount += 1;
        return replacement;
      });
    }
    return text;
  }

  return { scrub, getReplacementCount: () => replacementCount };
}

module.exports = { createScrubber };
