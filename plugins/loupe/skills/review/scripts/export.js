#!/usr/bin/env node
'use strict';

/**
 * Loupe shareable export. Turns a saved run (~/.loupe/runs/<timestamp>.json)
 * into a scrubbed summary a developer can review and send to a lead, who
 * combines several with aggregate.js.
 *
 * What it keeps: per-category counts and grades, gap findings per 10
 * sessions, and each finding's recommendation and proposed artifact, both
 * scrubbed. What it drops: session IDs, cwd paths, branches, prompt
 * excerpts and apply prompts (the developer still has those locally).
 *
 * Usage:
 *   node export.js [--run <run json path>] [--as <name>] [--redact "term1,term2"] [--remember] [--out <path>]
 *
 * --run       defaults to the most recent run in ~/.loupe/runs/
 * --as        the name the lead sees; defaults to exportName in
 *             ~/.loupe/config.json, then git's global user.name
 * --redact    extra terms (client or coworker names) to replace, added to
 *             exportRedact and the files in exportRedactFiles (a shared
 *             team list, one term per line) in ~/.loupe/config.json
 * --remember  saves the name and the --redact terms to ~/.loupe/config.json
 * --out       defaults to ~/.loupe/exports/<run timestamp>.json
 *
 * Prints a preview of exactly what was written, including capitalized
 * words that may be names nobody listed, then the file path as the last
 * line.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createScrubber } = require('./scrub');
const { resolveDeveloperName, collectRedactTerms, findPossibleNames, rememberChoices } = require('./export-setup');

const LOUPE_DIR = path.join(os.homedir(), '.loupe');
const RUNS_DIR = path.join(LOUPE_DIR, 'runs');
const EXPORTS_DIR = path.join(LOUPE_DIR, 'exports');
const CONFIG_FILE = path.join(LOUPE_DIR, 'config.json');

const EXPORT_SCHEMA = 'loupe-export/1';
const SESSIONS_PER_RATE = 10;

const CATEGORY_LABELS = {
  A: 'Guidelines',
  B: 'Skills',
  C: 'Hooks',
  D: 'MCPs',
  E: 'Model routing',
  F: 'Multi-agent',
  G: 'Session hygiene',
};

function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readJsonSafe(CONFIG_FILE) || {};

  const runPath = args.run || findLatestRunPath();
  if (!runPath) fail('No Loupe runs found in ~/.loupe/runs/. Run /loupe:review first.');
  const run = readJson(runPath);

  const extraTerms = splitList(args.redact);
  const { terms: redactTerms, unreadableFiles } = collectRedactTerms(
    { ...config, exportRedactFiles: (config.exportRedactFiles || []).map(expandHome) },
    extraTerms,
  );
  const developer = resolveDeveloperName(args.as, config);
  const exported = buildExport(run, developer, redactTerms);

  if (args.remember) {
    fs.mkdirSync(LOUPE_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(rememberChoices(config, { name: developer, redactTerms: extraTerms }), null, 2) + '\n');
  }

  const outPath = args.out || path.join(EXPORTS_DIR, path.basename(runPath));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(exported, null, 2) + '\n');

  const notes = { possibleNames: findPossibleNames(exported), unreadableFiles, remembered: Boolean(args.remember) };
  process.stdout.write(renderPreview(exported, notes) + '\n' + outPath + '\n');
}

function buildExport(run, developer, redactTerms) {
  const { scrub, getReplacementCount } = createScrubber(redactTerms);
  const sessionsAnalyzed = run.sessionsAnalyzed || 0;

  const categories = {};
  const findings = [];
  for (const [letter, result] of Object.entries(run.categories)) {
    categories[letter] = summarizeCategory(letter, result, sessionsAnalyzed);
    for (const finding of result.confirmedFindings || []) {
      findings.push({
        category: letter,
        isGap: finding.is_gap !== false,
        evidenceSessionCount: (finding.evidence_session_ids || []).length,
        mergedFindingCount: (finding.merged_findings || []).length,
        title: finding.title ? scrub(finding.title) : null,
        recommendation: scrub(finding.recommendation),
        proposedArtifact: scrub(finding.proposed_artifact),
      });
    }
  }

  return {
    schema: EXPORT_SCHEMA,
    developer,
    exportedAt: new Date().toISOString(),
    runGeneratedAt: run.generatedAt,
    profile: run.profile,
    gradingModels: run.gradingModels || [],
    sessionsAnalyzed,
    categories,
    findings,
    replacementCount: getReplacementCount(),
  };
}

function summarizeCategory(letter, result, sessionsAnalyzed) {
  const graded = result.confirmedFindingCount + result.rejectedAtGradingCount;
  return {
    label: CATEGORY_LABELS[letter],
    grade: result.grade,
    score: result.score,
    candidates: result.heuristicCandidateCount,
    graded,
    gaps: result.gapFindingCount,
    affirming: result.affirmingFindingCount,
    rejected: result.rejectedAtGradingCount,
    gapsPer10Sessions: ratePer10Sessions(result.gapFindingCount, sessionsAnalyzed),
  };
}

function ratePer10Sessions(count, sessions) {
  if (!sessions) return null;
  return Math.round((count / sessions) * SESSIONS_PER_RATE * 10) / 10;
}

function renderPreview(exported, notes = {}) {
  const lines = [
    `Loupe export for "${exported.developer}" (run ${exported.runGeneratedAt}, ${exported.sessionsAnalyzed} sessions)`,
    '',
    'Category          Gaps  Per 10 sessions  Graded/Candidates',
  ];
  for (const category of Object.values(exported.categories)) {
    const rate = category.gapsPer10Sessions === null ? '-' : String(category.gapsPer10Sessions);
    lines.push(
      `  ${category.label.padEnd(16)}${String(category.gaps).padStart(4)}  ${rate.padStart(15)}  ${category.graded}/${category.candidates}`,
    );
  }
  lines.push('', `Findings (${exported.findings.length}), exactly as they will be shared:`);
  exported.findings.forEach((finding, index) => {
    const kind = finding.isGap ? 'gap' : 'good habit';
    const heading = finding.title ? `${finding.title}. ${finding.recommendation}` : finding.recommendation;
    lines.push('', `${index + 1}. [${CATEGORY_LABELS[finding.category]}, ${kind}] ${heading}`);
    if (finding.proposedArtifact) lines.push(indent(finding.proposedArtifact));
  });
  lines.push(
    '',
    `${exported.replacementCount} item(s) were replaced (secrets, emails, URLs, IPs, home paths, redact terms).`,
    'Read the findings above before sharing. Client or coworker names are only removed if they are',
    'in --redact, exportRedact or an exportRedactFiles list in ~/.loupe/config.json.',
  );
  if (notes.possibleNames && notes.possibleNames.length > 0) {
    lines.push('', `Possible names still in the findings: ${notes.possibleNames.join(', ')}`);
  }
  for (const file of notes.unreadableFiles || []) lines.push(`Could not read redact list ${file}; its terms were not applied.`);
  if (notes.remembered) lines.push(`Saved the name "${exported.developer}" and the --redact terms to ~/.loupe/config.json.`);
  return lines.join('\n');
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => `     ${line}`)
    .join('\n');
}

function findLatestRunPath() {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const runFiles = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort();
  return runFiles.length ? path.join(RUNS_DIR, runFiles[runFiles.length - 1]) : null;
}

function splitList(value) {
  return value ? value.split(',').map((term) => term.trim()).filter(Boolean) : [];
}

const BOOLEAN_FLAGS = new Set(['remember']);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const name = argv[i].slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      args[name] = true;
      continue;
    }
    args[name] = argv[i + 1];
    i++;
  }
  return args;
}

function expandHome(filePath) {
  return filePath.replace(/^~(?=$|[\\/])/, os.homedir());
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonSafe(filePath) {
  try {
    return readJson(filePath);
  } catch (err) {
    return null;
  }
}

function fail(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { buildExport, EXPORT_SCHEMA, CATEGORY_LABELS };
