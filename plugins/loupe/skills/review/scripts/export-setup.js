'use strict';

/**
 * First-run setup for exports: which name the lead sees, which terms to
 * redact, and which words in the findings look like names nobody listed.
 *
 * Secrets, emails, URLs and paths have a shape the scrubber recognizes.
 * Client and coworker names don't, so the export lists the capitalized
 * words that could be names and the developer decides which to redact.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const UNNAMED_DEVELOPER = 'unnamed';
const MAX_POSSIBLE_NAMES = 20;
const COMMENT_LINE_PATTERN = /^\s*#/;
// A capitalized word, or dotted and joined parts (Acme.Billing, AcmeCorp).
const CAPITALIZED_WORD_PATTERN = /\b[A-Z][A-Za-z0-9]*(?:[.-][A-Z][A-Za-z0-9]*)*\b/g;
// Start of text, after sentence punctuation, or at the start of a line,
// list item or Markdown heading.
const SENTENCE_START_PATTERN = /((^|\n)\s*[-*#>\d.]*\s*|[.!?:]\s+|["'(`]\s*)$/;
const ALL_CAPS_PATTERN = /^[A-Z0-9.-]+$/;
// Words that are capitalized in findings but name tools, not people or
// clients. Matched case-sensitively.
const KNOWN_TERMS = new Set([
  'Add', 'Agent', 'Always', 'Ask', 'Avoid', 'Bash', 'Before', 'Claude', 'Code', 'Copy', 'Create', 'Delegate',
  'Docker', 'Edit', 'Explore', 'Git', 'GitHub', 'Glob', 'Grep', 'Haiku', 'JavaScript', 'Keep', 'Markdown',
  'Never', 'Node', 'NotebookEdit', 'Opus', 'Prefer', 'Python', 'React', 'Read', 'Route', 'Run', 'Skill',
  'Skills', 'Sonnet', 'Stop', 'Task', 'TodoWrite', 'TypeScript', 'Use', 'Users', 'WebFetch', 'WebSearch',
  'When', 'Write',
]);

/** --as, then the saved exportName, then git's user.name, then "unnamed". */
function resolveDeveloperName(argName, config, readGitName = readGlobalGitName) {
  return argName || config.exportName || readGitName() || UNNAMED_DEVELOPER;
}

function readGlobalGitName() {
  try {
    return execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    return '';
  }
}

/**
 * Terms from exportRedact plus every file in exportRedactFiles (one term
 * per line, # for comments), so a team can share one list. A file that
 * can't be read is reported, not fatal: the developer sees it in the
 * preview before anything is sent.
 */
function collectRedactTerms(config, extraTerms, readText = readTextOrNull) {
  const terms = [...(config.exportRedact || []), ...extraTerms];
  const unreadableFiles = [];
  for (const file of config.exportRedactFiles || []) {
    const text = readText(file);
    if (text === null) {
      unreadableFiles.push(file);
      continue;
    }
    terms.push(...listTerms(text));
  }
  const cleaned = terms.map((term) => term.trim()).filter(Boolean);
  return { terms: [...new Set(cleaned)], unreadableFiles };
}

function listTerms(text) {
  return text.split('\n').filter((line) => line.trim() && !COMMENT_LINE_PATTERN.test(line)).map((line) => line.trim());
}

/**
 * Appends the terms the shared list doesn't have yet (ignoring case), so
 * a teammate's next export redacts them without anyone deciding again.
 * Returns the terms added. Throws when the list can't be read or written,
 * so the caller can say the terms were not shared.
 */
function addToSharedList(filePath, terms, { readText = readTextOrNull, appendText = appendTextToFile } = {}) {
  const existing = readText(filePath);
  if (existing === null) throw new Error(`could not read ${filePath}`);
  const listed = new Set(listTerms(existing).map((term) => term.toLowerCase()));
  const added = [];
  for (const term of terms.map((t) => t.trim()).filter(Boolean)) {
    if (listed.has(term.toLowerCase())) continue;
    listed.add(term.toLowerCase());
    added.push(term);
  }
  if (added.length === 0) return added;
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  appendText(filePath, separator + added.join('\n') + '\n');
  return added;
}

function appendTextToFile(filePath, text) {
  fs.appendFileSync(filePath, text);
}

function readTextOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return null;
  }
}

/**
 * Capitalized words that appear mid-sentence in the exported findings,
 * most frequent first: the likely client, product and coworker names.
 * Known tool words, acronyms and the developer's own name are left out.
 */
function findPossibleNames(exported) {
  const counts = new Map();
  for (const finding of exported.findings) {
    for (const text of [finding.title, finding.recommendation, artifactText(finding.proposedArtifact)]) {
      for (const word of midSentenceCapitalizedWords(text || '')) counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  const ownNameParts = new Set(String(exported.developer).split(/\s+/));
  return [...counts]
    .filter(([word]) => !KNOWN_TERMS.has(word) && !ALL_CAPS_PATTERN.test(word) && !ownNameParts.has(word))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_POSSIBLE_NAMES)
    .map(([word]) => word);
}

function artifactText(artifact) {
  if (!artifact) return '';
  return typeof artifact === 'string' ? artifact : JSON.stringify(artifact);
}

function midSentenceCapitalizedWords(text) {
  const words = [];
  for (const match of text.matchAll(CAPITALIZED_WORD_PATTERN)) {
    if (!SENTENCE_START_PATTERN.test(text.slice(0, match.index))) words.push(match[0]);
  }
  return words;
}

/** Saves the name and adds the redact terms to config, keeping the rest. */
function rememberChoices(config, { name, redactTerms }) {
  const savedTerms = new Set(config.exportRedact || []);
  for (const term of redactTerms) savedTerms.add(term);
  return { ...config, exportName: name, exportRedact: [...savedTerms] };
}

module.exports = {
  UNNAMED_DEVELOPER,
  resolveDeveloperName,
  collectRedactTerms,
  findPossibleNames,
  rememberChoices,
  addToSharedList,
};
