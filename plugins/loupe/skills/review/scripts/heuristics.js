#!/usr/bin/env node
'use strict';

/**
 * Loupe heuristic pre-filtering pass (Full Spec §1, §1.1, §2, §3).
 *
 * Discovers local Claude Code session transcripts, groups them into logical
 * projects, and runs cheap structural/regex detectors for each of the seven
 * recommendation categories (A-G). Outputs candidate clusters as JSON to
 * stdout — no LLM grading happens here (that's grade.sh, Phase 2).
 *
 * Usage:
 *   node heuristics.js                 run the full pass, print JSON
 *   node heuristics.js --dump-schema   print raw shape of the first few
 *                                      lines of a real transcript, then exit
 *   node heuristics.js --mark-self <sessionId>
 *                                      tag a session as a Loupe run so it is
 *                                      excluded from future analysis
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  matchMcpServerName,
  readUserMcpServers,
  readProjectMcpServers,
  readPluginMcpServers,
  readFollowUpHookCommands,
} = require('./claude-config');
const { buildGradingQueue } = require('./grading-queue');

const HOME_DIR = os.homedir();
const PROJECTS_DIR = path.join(HOME_DIR, '.claude', 'projects');
const LOUPE_DIR = path.join(HOME_DIR, '.loupe');
const GROUPS_FILE = path.join(LOUPE_DIR, 'groups.json');
const EXCLUDED_SESSIONS_FILE = path.join(LOUPE_DIR, 'excluded-sessions.json');
const RUNS_DIR = path.join(LOUPE_DIR, 'runs');
const DEVELOPER_DIR_NAME = 'Developer';
const LOUPE_SCRIPTS_PATH_FRAGMENT = path.join('skills', 'review', 'scripts');
// Must match the opening line build-grade-prompt.js sends verbatim.
const LOUPE_GRADING_PROMPT_SIGNATURE = 'grading a candidate recommendation for Loupe';

const DUMP_SCHEMA_LINE_COUNT = 8;
const DIGEST_MAX_TURNS = 80;
const DIGEST_TEXT_TRUNCATE_CHARS = 300;
const DIGEST_TOOL_ARG_TRUNCATE_CHARS = 150;
const SHORT_TURN_MAX_CHARS = 200;
const MIN_CLUSTER_SIZE = 2;
// Calibrated against real paraphrased corrections ("use grafana not axiom"
// phrased three different ways scores 0.33-0.44 jaccard) — 0.6 caught none
// of them. 0.3 is the floor that catches real paraphrase while still
// requiring genuine shared vocabulary, not just common filler words.
const SIMILARITY_THRESHOLD = 0.3;
const SHORT_SESSION_MAX_TURNS = 6;
const LONG_SESSION_MIN_TURNS = 40;
const HYGIENE_WINDOW_TURNS = 10;
const HYGIENE_SLOPE_THRESHOLD = 0.15;
const EXPENSIVE_MODEL_PATTERN = /opus/i;
const CHEAP_MODEL_PATTERN = /haiku/i;
const REAL_MODEL_NAME_PATTERN = /claude/i;
// Same-tool/different-target runs are a coarse, over-inclusive proxy for
// "independent work chunks" — pure tool-call structure can't distinguish
// genuinely independent audits from a sequential grep/find chain that
// converges on one answer. True independence judgment is deferred to
// grade.sh (§3); isCleanIndependentRun() below screens out the specific
// failure pattern Phase 6 validation actually observed (revisited
// targets), which lets this match §2's own example length (3: "audit file
// A, then file B, then file C") instead of padding the threshold to
// compensate for a weaker filter.
const INDEPENDENT_RUN_MIN_LENGTH = 3;
// Claude Code renamed the subagent tool from Task to Agent; transcripts
// from either era must count, or every session reads as "never delegated".
const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent']);
// Only lookups can be independent chunks. Consecutive Bash calls with
// different commands are almost always one dependent pipeline (build,
// test, commit), and counting them flagged most sessions as parallelizable.
const INDEPENDENT_LOOKUP_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
const READ_ONLY_BASH_PATTERN = /^\s*(cat|head|tail|sed -n|grep|rg|ls|find|wc|jq|git (log|show|diff|blame)|gh (pr|issue|run) (view|list|diff))\b/;
const TRIVIAL_SUBAGENT_PROMPT_MAX_CHARS = 200;

// Wide clusters keep a sample of evidence sessions (each one is digested
// into the grading prompt) and report the full count beside it.
const MAX_EVIDENCE_SESSIONS = 8;
const CLUSTER_SAMPLE_COUNT = 3;
const CLUSTER_SAMPLE_TEXT_CHARS = 160;
const HOOK_REQUEST_MAX_CHARS = 300;
// How far back to look for the edit a follow-up request reacts to.
const EDIT_LOOKBACK_MAX_TURNS = 200;
// Typed asks are short; a long turn that mentions copying or a console is
// usually a brief or a pasted document. Pasted blocks don't count.
const MANUAL_WORK_MAX_TYPED_CHARS = 500;
// Below these, "never called" says more about the sample than the server.
const MIN_SESSIONS_FOR_USER_MCP_UNDERUSE = 10;
const MIN_SESSIONS_FOR_PROJECT_MCP_UNDERUSE = 3;
const ALL_PROJECTS_GROUP = '(all projects)';

const CORRECTION_PATTERN = /\b(no+,|don'?t|never|always|instead|stop doing|actually,? (please|just)?|please stop|that'?s wrong|not like that)\b/i;
// Each action pairs the phrasings people use to ask for a fixed follow-up
// check with the command shape of a hook that would already do it.
// Phrasings come from real transcripts ("run all tests", "build, run all
// tests", "let's fix the dotnet format"); "format it for slack" and other
// non-code formatting is deliberately excluded.
const HOOK_ACTIONS = [
  {
    action: 'test',
    request: /\b(re-?run|run) (all |the |all the |unit |integration |e2e |full |the full |the unit |the integration )?(tests?|test suite|specs)\b(?! plan)|\bmake sure (all )?(the )?tests? (still )?pass|\b(npm|pnpm|yarn|bun) (run )?test\b|\b(dotnet|go|cargo) test\b|\bpytest\b|\b(do|did) (the |all )?tests? pass/i,
    hookCommand: /\b(tests?|jest|vitest|pytest|mocha|rspec|phpunit)\b/i,
  },
  {
    action: 'lint',
    request: /\b(re-?run|run|fix) (the )?(lint(er|ers|ing)?|eslint|ruff|rubocop|golangci-lint)\b|\blint (it|this|that|the (code|files?|changes))\b|\b(npm|pnpm|yarn|bun) (run )?lint\b/i,
    hookCommand: /\b(lint|eslint|ruff|rubocop|golangci-lint|stylelint)\b/i,
  },
  {
    action: 'format',
    request: /\b(re-?run|run|fix) (the )?(prettier|formatter|dotnet format|csharpier|black|gofmt|rustfmt)\b|\bformat the (code|files?|changes)\b(?!\s+(for|to|as|in|so|like|into))|\b(dotnet format|npx prettier|prettier --(write|check)|ruff format)\b/i,
    hookCommand: /\b(format|prettier|black|csharpier|gofmt|rustfmt|fmt)\b/i,
  },
  {
    action: 'typecheck',
    request: /\b(re-?run|run|fix) (the )?(tsc|typecheck|type-?check(er|ing)?|type errors|mypy|pyright)\b|\btsc --noEmit\b/i,
    hookCommand: /\b(tsc|typecheck|type-check|mypy|pyright)\b/i,
  },
  {
    action: 'build',
    request: /\b(re-?run|run|fix) (the )?build\b|\b(check|verify|make sure|confirm) (that )?(the |it )?(builds?|compiles?)\b|\bdoes it (still )?(build|compile)\b|\b(dotnet|npm run|pnpm|yarn|cargo|go|swift|xcodebuild) build\b|^build(,|\s+(and|then)\b)/i,
    hookCommand: /\b(build|compile|xcodebuild)\b/i,
  },
];
// Manual relaying of something an MCP could fetch or do directly: copying
// between tools, checking a console or dashboard by hand, or pasting an
// error or log output into the chat.
const MANUAL_WORK_PATTERN = /\b(copy(-| )?past(e|ed|ing)|i (copied|pasted|grabbed|exported|downloaded)|paste (this|it|the [a-z]+) (in|into|here)|from the (browser|console|dashboard|portal|web ui|website)|manually (check(ed|ing)?|cop(y|ied)|updat(e|ed|ing)|paginat(e|ing)|deploy(ed|ing)?|run|ran|enter(ed)?|typ(e|ed)|scan(ned)?|add(ed)?|trigger(ed)?|creat(e|ed))|by hand|switch(ing)? tabs?|in the (aws |azure |gcp )?console|check (the )?([\w.-]+ ){0,3}(logs|alarms?|dashboards?|metrics|traces) (in|on|from)|i (checked|looked) (in|on|at) (the )?[\w.-]+ (ui|dashboard|console|portal))\b/i;
const PASTED_EXTERNAL_OUTPUT_PATTERN = /<pasted_content\b[^>]*>[\s\S]*?\b(error|exception|traceback|stack ?trace|failed|fatal)\b/i;
// User-role turns the person didn't type: compaction summaries, system
// reminders, scheduled-task prompts and other injected context. Their
// boilerplate ("never edit generated files by hand") matched hundreds of
// times and drowned out what people actually asked for.
const INJECTED_TURN_PATTERN = /^\s*(<(system-reminder|scheduled-task|command-[a-z]+|local-command-[a-z]+|task-notification|cross-session-message|artifact-content[a-z-]*|side-sessions-event|ci-monitor-event|bash-[a-z]+)\b|This session is being continued from a previous conversation|Caveat: )/i;
const PASTED_CONTENT_BLOCK_PATTERN = /<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content[^>]*>/gi;
// Bash commands that write files, for sessions that edit without the Edit
// tool (heredocs, sed -i, scripted rewrites).
const BASH_FILE_EDIT_PATTERN = /\bsed\s+-i|\bperl\s+-p?i|\bapply_patch\b|\bgit apply\b|\bcat\s*>{1,2}\s*[^&\s]|\btee\s+(-a\s+)?[^|\s-]|\bopen\([^)]*,\s*['"][wa]/;
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'NotebookEdit']);

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--dump-schema')) {
    dumpSchema();
    return;
  }

  const markSelfIndex = args.indexOf('--mark-self');
  if (markSelfIndex !== -1) {
    const sessionId = args[markSelfIndex + 1];
    markSessionAsSelf(sessionId);
    return;
  }

  const digestIndex = args.indexOf('--digest');
  if (digestIndex !== -1) {
    const sessionIds = (args[digestIndex + 1] || '').split(',').filter(Boolean);
    printDigest(sessionIds);
    return;
  }

  const repoIndex = args.indexOf('--repo');
  const branchIndex = args.indexOf('--branch');

  const result = runHeuristicPass({
    full: args.includes('--full'),
    repo: repoIndex !== -1 ? args[repoIndex + 1] : null,
    branch: branchIndex !== -1 ? args[branchIndex + 1] : null,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// --dump-schema debug flag
// ---------------------------------------------------------------------------

function dumpSchema() {
  const files = discoverTranscriptFiles();
  if (files.length === 0) {
    process.stdout.write(JSON.stringify({ error: 'no transcript files found under ' + PROJECTS_DIR }) + '\n');
    return;
  }
  const lines = readLines(files[0]).slice(0, DUMP_SCHEMA_LINE_COUNT);
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      return { __parseError: err.message, __raw: line.slice(0, 200) };
    }
  });
  process.stdout.write(JSON.stringify({ file: files[0], lines: parsed }, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Condensed digest for the grading pass (§3): "user turns, tool_use
// names/args (not full outputs), model used, session length" — never full
// tool outputs, to keep grading calls cheap.
// ---------------------------------------------------------------------------

function printDigest(sessionIds) {
  const wanted = new Set(sessionIds);
  const files = discoverTranscriptFiles();
  const digests = [];

  for (const file of files) {
    if (digests.length === wanted.size) break;
    const session = safeParseTranscriptFile(file);
    if (!session || !wanted.has(session.sessionId)) continue;
    digests.push(buildSessionDigest(session));
  }

  process.stdout.write(JSON.stringify({ sessions: digests }, null, 2) + '\n');
}

function safeParseTranscriptFile(filePath) {
  try {
    return parseTranscriptFile(filePath);
  } catch (err) {
    return null;
  }
}

function buildSessionDigest(session) {
  const relevantTurns = session.turns.filter((t) => isHumanTypedTurn(t) || t.type === 'assistant');
  const sampledTurns = sampleHeadAndTail(relevantTurns, DIGEST_MAX_TURNS);

  // Interleaved, in order, with per-turn model attribution — a flattened
  // "humanTurns" + "toolUses" split (the original design) loses turn order
  // and can't tell the grading pass which model handled which task, which
  // is exactly what category E (model routing) needs to judge anything.
  const turns = sampledTurns.map((turn) => ({
    role: turn.type === 'assistant' ? 'assistant' : 'human',
    model: turn.type === 'assistant' ? turn.model : undefined,
    text: turn.text ? truncate(turn.text, DIGEST_TEXT_TRUNCATE_CHARS) : undefined,
    toolUses: turn.toolUses.length
      ? turn.toolUses.map((tu) => ({ name: tu.name, args: truncate(JSON.stringify(tu.input || {}), DIGEST_TOOL_ARG_TRUNCATE_CHARS) }))
      : undefined,
  }));

  const modelsUsed = [...new Set(session.turns.filter((t) => t.model && REAL_MODEL_NAME_PATTERN.test(t.model)).map((t) => t.model))];

  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    gitBranch: session.gitBranch,
    turnCount: session.turns.length,
    turnsIncludedInDigest: sampledTurns.length,
    modelsUsed,
    turns,
  };
}

function sampleHeadAndTail(items, maxItems) {
  if (items.length <= maxItems) return items;
  const halfSize = Math.floor(maxItems / 2);
  return [...items.slice(0, halfSize), ...items.slice(-halfSize)];
}

function truncate(text, maxChars) {
  if (typeof text !== 'string') return text;
  return text.length > maxChars ? text.slice(0, maxChars) + '…' : text;
}

// ---------------------------------------------------------------------------
// Self-referential exclusion (§3)
// ---------------------------------------------------------------------------

function markSessionAsSelf(sessionId) {
  if (!sessionId) {
    process.stderr.write('--mark-self requires a session ID argument\n');
    process.exitCode = 1;
    return;
  }
  const excluded = readJsonSafe(EXCLUDED_SESSIONS_FILE, { sessionIds: [] });
  if (!excluded.sessionIds.includes(sessionId)) {
    excluded.sessionIds.push(sessionId);
    writeJson(EXCLUDED_SESSIONS_FILE, excluded);
  }
  process.stdout.write(JSON.stringify({ marked: sessionId }) + '\n');
}

function loadExcludedSessionIds() {
  const excluded = readJsonSafe(EXCLUDED_SESSIONS_FILE, { sessionIds: [] });
  return new Set(excluded.sessionIds);
}

// Two distinct kinds of session are self-referential and neither is
// optional: the orchestrating session (calls heuristics.js/grade.sh via
// Bash, caught below by tool-call inspection) and each grading *child*
// session grade.sh spawns via `claude -p` (does its own independent
// reasoning/tool calls and never references Loupe's scripts at all, so
// tool-call inspection can't see it — caught by matching the fixed prompt
// signature build-grade-prompt.js always sends). --mark-self tags child
// sessions too, but that's mutable state; this is a stable backstop that
// still works even if ~/.loupe/excluded-sessions.json is ever lost.
function isLoupeInvocationSession(session) {
  return session.turns.some((turn) =>
    turn.toolUses.some((toolUse) => isLoupeScriptInvocation(toolUse))
  ) || session.turns.some(isLoupeGradingPrompt);
}

function isLoupeScriptInvocation(toolUse) {
  if (toolUse.name !== 'Bash' || !toolUse.input || typeof toolUse.input.command !== 'string') {
    return false;
  }
  return toolUse.input.command.includes(LOUPE_SCRIPTS_PATH_FRAGMENT);
}

function isLoupeGradingPrompt(turn) {
  return isHumanTypedTurn(turn) && turn.text.includes(LOUPE_GRADING_PROMPT_SIGNATURE);
}

function persistNewlyDetectedSelfSessions(sessionIds) {
  if (sessionIds.length === 0) return;
  const excluded = readJsonSafe(EXCLUDED_SESSIONS_FILE, { sessionIds: [] });
  const merged = new Set([...excluded.sessionIds, ...sessionIds]);
  writeJson(EXCLUDED_SESSIONS_FILE, { sessionIds: [...merged] });
}

// ---------------------------------------------------------------------------
// Transcript discovery & defensive parsing (§1)
// ---------------------------------------------------------------------------

function discoverTranscriptFiles() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const files = [];
  for (const projectDir of fs.readdirSync(PROJECTS_DIR)) {
    const fullDir = path.join(PROJECTS_DIR, projectDir);
    if (!fs.statSync(fullDir).isDirectory()) continue;
    for (const entry of fs.readdirSync(fullDir)) {
      if (entry.endsWith('.jsonl')) files.push(path.join(fullDir, entry));
    }
  }
  return files;
}

function readLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
}

function parseTranscriptFile(filePath) {
  const turns = [];
  let sessionId = null;
  let cwd = null;
  let gitBranch = null;

  for (const line of readLines(filePath)) {
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      continue; // malformed line — skip, never crash the run
    }
    sessionId = sessionId || raw.sessionId || null;
    cwd = cwd || raw.cwd || null;
    gitBranch = gitBranch || raw.gitBranch || null;

    const turn = normalizeTurn(raw);
    if (turn) turns.push(turn);
  }

  if (!sessionId) return null;
  return { sessionId, cwd, gitBranch, filePath, turns };
}

function normalizeTurn(raw) {
  if (raw.type !== 'user' && raw.type !== 'assistant' && raw.type !== 'system') return null;

  const message = raw.message || {};
  const contentBlocks = Array.isArray(message.content) ? message.content : null;

  return {
    type: raw.type,
    isMeta: !!raw.isMeta,
    timestamp: raw.timestamp || null,
    model: message.model || null,
    text: extractTextContent(message.content),
    isToolResultTurn: contentBlocks !== null && contentBlocks.some((b) => b && b.type === 'tool_result'),
    toolUses: contentBlocks ? contentBlocks.filter((b) => b && b.type === 'tool_use') : [],
  };
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const textBlocks = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string');
  if (textBlocks.length === 0) return null;
  return textBlocks.map((b) => b.text).join('\n');
}

function isHumanTypedTurn(turn) {
  return turn.type === 'user' && !turn.isMeta && !turn.isToolResultTurn && typeof turn.text === 'string' && turn.text.trim().length > 0;
}

// Stricter than isHumanTypedTurn: also drops injected context that arrives
// as a user turn. Used by the C and D detectors, whose phrase matching is
// most sensitive to that boilerplate.
function isPersonTypedTurn(turn) {
  return isHumanTypedTurn(turn) && !INJECTED_TURN_PATTERN.test(turn.text);
}

// ---------------------------------------------------------------------------
// Project grouping (§1.1)
// ---------------------------------------------------------------------------

function loadOrSuggestGroups(sessions) {
  const existing = readJsonSafe(GROUPS_FILE, null);
  if (existing) return { groups: existing, wasGenerated: false };

  const suggested = suggestGroups(sessions);
  if (Object.keys(suggested).length > 0) {
    fs.mkdirSync(LOUPE_DIR, { recursive: true });
    writeJson(GROUPS_FILE, suggested);
  }
  return { groups: suggested, wasGenerated: true };
}

function suggestGroups(sessions) {
  const groups = {};
  for (const session of sessions) {
    const suggestion = suggestProjectForPath(session.cwd);
    if (!suggestion) continue;
    if (!groups[suggestion.projectName]) groups[suggestion.projectName] = [];
    if (!groups[suggestion.projectName].includes(suggestion.repoPath)) {
      groups[suggestion.projectName].push(suggestion.repoPath);
    }
  }
  return groups;
}

function suggestProjectForPath(cwd) {
  if (!cwd) return null;
  const parts = cwd.split(path.sep).filter(Boolean);
  const devIndex = parts.findIndex((part) => part === DEVELOPER_DIR_NAME);
  if (devIndex === -1 || devIndex + 1 >= parts.length) return null;
  const projectName = parts[devIndex + 1];
  const repoPath = path.sep + path.join(...parts.slice(0, devIndex + 2));
  return { projectName, repoPath };
}

function assignSessionsToGroups(sessions, groups) {
  const assignments = new Map(); // groupKey -> sessions[]
  for (const session of sessions) {
    const groupKey = findGroupForSession(session, groups) || session.cwd || session.sessionId;
    if (!assignments.has(groupKey)) assignments.set(groupKey, []);
    assignments.get(groupKey).push(session);
  }
  return assignments;
}

function findGroupForSession(session, groups) {
  if (!session.cwd) return null;
  for (const [groupName, repoPaths] of Object.entries(groups)) {
    if (repoPaths.some((repoPath) => session.cwd === repoPath || session.cwd.startsWith(repoPath + path.sep))) {
      return groupName;
    }
  }
  return null;
}

// --repo/--branch scoping. --repo accepts either a groups.json project
// name (e.g. "Sidelit") or a literal path (e.g. "~/Developer/Sidelit" or
// "/Users/mison/Developer/Sidelit/main" for one worktree specifically) —
// tried as a group name first since that's the common case, falling back
// to a path prefix match so an ungrouped or one-off repo still works.
function filterByScope(sessions, groups, { repo, branch }) {
  let filtered = sessions;
  if (repo) filtered = filtered.filter((session) => sessionMatchesRepo(session, groups, repo));
  if (branch) filtered = filtered.filter((session) => session.gitBranch === branch);
  return filtered;
}

function sessionMatchesRepo(session, groups, repoArg) {
  if (findGroupForSession(session, groups) === repoArg) return true;
  if (!session.cwd) return false;
  const resolvedPath = path.resolve(repoArg.replace(/^~/, HOME_DIR));
  return session.cwd === resolvedPath || session.cwd.startsWith(resolvedPath + path.sep);
}

// ---------------------------------------------------------------------------
// Shared similarity helper (used by categories A, B, F)
// ---------------------------------------------------------------------------

function normalizeForSimilarity(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);
}

function jaccardSimilarity(wordsA, wordsB) {
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersectionSize = 0;
  for (const word of setA) if (setB.has(word)) intersectionSize++;
  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

function clusterBySimilarity(items, getWords) {
  const clusters = [];
  const assigned = new Array(items.length).fill(false);

  for (let i = 0; i < items.length; i++) {
    if (assigned[i]) continue;
    const cluster = [items[i]];
    assigned[i] = true;
    const wordsI = getWords(items[i]);

    for (let j = i + 1; j < items.length; j++) {
      if (assigned[j]) continue;
      const similarity = jaccardSimilarity(wordsI, getWords(items[j]));
      if (similarity >= SIMILARITY_THRESHOLD) {
        cluster.push(items[j]);
        assigned[j] = true;
      }
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) clusters.push(cluster);
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Category A — Guidelines (CLAUDE.md)
// ---------------------------------------------------------------------------

function detectGuidelineCandidates(groupedSessions) {
  return detectRecurringTurnPatternCandidates(groupedSessions, (turn) => {
    if (turn.text.length > SHORT_TURN_MAX_CHARS) return false;
    return CORRECTION_PATTERN.test(turn.text);
  });
}

// Shared by categories A and C: both look for short human turns matching a
// regex, then cluster the matches by text similarity to find a *recurring*
// pattern rather than a one-off.
function detectRecurringTurnPatternCandidates(groupedSessions, turnMatches) {
  const clusters = [];

  for (const [groupName, sessions] of groupedSessions) {
    const matchedTurns = [];
    for (const session of sessions) {
      for (let i = 0; i < session.turns.length; i++) {
        const turn = session.turns[i];
        if (!isHumanTypedTurn(turn)) continue;
        if (!turnMatches(turn, session, i)) continue;
        matchedTurns.push({ sessionId: session.sessionId, text: turn.text.trim() });
      }
    }

    const textClusters = clusterBySimilarity(matchedTurns, (item) => normalizeForSimilarity(item.text));
    for (const cluster of textClusters) {
      clusters.push({
        group: groupName,
        representativeText: cluster[0].text,
        occurrenceCount: cluster.length,
        evidenceSessionIds: [...new Set(cluster.map((c) => c.sessionId))],
      });
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Category B — Skills (.claude/skills/)
// ---------------------------------------------------------------------------

function detectSkillCandidates(groupedSessions) {
  const clusters = [];

  for (const [groupName, sessions] of groupedSessions) {
    const sessionSignatures = sessions
      .map((session) => ({ sessionId: session.sessionId, session, signature: buildToolSequenceSignature(session) }))
      .filter((entry) => entry.signature.length >= MIN_CLUSTER_SIZE);

    const signatureClusters = clusterBySimilarity(sessionSignatures, (entry) => entry.signature);
    for (const cluster of signatureClusters) {
      const repoPath = cluster[0].session.cwd;
      clusters.push({
        group: groupName,
        occurrenceCount: cluster.length,
        sharedToolPattern: cluster[0].signature.slice(0, 12),
        hasExistingSkillDir: repoPath ? fs.existsSync(path.join(repoPath, '.claude', 'skills')) : false,
        evidenceSessionIds: cluster.map((c) => c.sessionId),
      });
    }
  }

  return clusters;
}

function buildToolSequenceSignature(session) {
  const signature = [];
  for (const turn of session.turns) {
    for (const toolUse of turn.toolUses) {
      signature.push(toolUse.name);
    }
  }
  return signature;
}

// ---------------------------------------------------------------------------
// Category C — Hooks (settings.json)
// ---------------------------------------------------------------------------

// A request only points at a hook when it is the same fixed follow-up each
// time, so matches are grouped by action (tests, lint, ...) rather than by
// wording: "run all tests" and "build, then run the tests before I merge"
// are the same missing hook. Actions that recur within one project become
// project clusters; the rest, when they recur across projects, become one
// user-level cluster (a Stop hook in ~/.claude/settings.json covers all).
function detectHookCandidates(groupedSessions) {
  const clusters = [];
  const unclusteredByAction = new Map();

  for (const [groupName, sessions] of groupedSessions) {
    const existingHookCommands = readFollowUpHookCommands(distinctSessionCwds(sessions));
    for (const [action, requests] of collectHookRequestsByAction(sessions)) {
      if (existingHookCommands.some((command) => hookCommandCoversAction(command, action))) continue;
      // Recurring means across sessions; asking twice in one sitting is not.
      if (new Set(requests.map((request) => request.sessionId)).size >= MIN_CLUSTER_SIZE) {
        clusters.push(buildHookCluster(groupName, 'project', action, requests));
        continue;
      }
      if (!unclusteredByAction.has(action)) unclusteredByAction.set(action, []);
      unclusteredByAction.get(action).push(...requests.map((request) => ({ ...request, group: groupName })));
    }
  }

  const userHookCommands = readFollowUpHookCommands([]);
  for (const [action, requests] of unclusteredByAction) {
    const groupCount = new Set(requests.map((request) => request.group)).size;
    if (groupCount < MIN_CLUSTER_SIZE) continue;
    if (userHookCommands.some((command) => hookCommandCoversAction(command, action))) continue;
    clusters.push({ ...buildHookCluster(ALL_PROJECTS_GROUP, 'user', action, requests), projectCount: groupCount });
  }
  return clusters;
}

function buildHookCluster(groupName, scope, action, requests) {
  return {
    group: groupName,
    scope,
    action,
    representativeText: truncate(requests[0].text, CLUSTER_SAMPLE_TEXT_CHARS),
    sampleTexts: requests.slice(0, CLUSTER_SAMPLE_COUNT).map((r) => truncate(r.text, CLUSTER_SAMPLE_TEXT_CHARS)),
    occurrenceCount: requests.length,
    ...cappedEvidence(requests.map((r) => r.sessionId)),
  };
}

function collectHookRequestsByAction(sessions) {
  const requestsByAction = new Map();
  for (const session of sessions) {
    session.turns.forEach((turn, index) => {
      if (!isPersonTypedTurn(turn)) return;
      const text = turn.text.trim();
      if (text.length > HOOK_REQUEST_MAX_CHARS) return;
      const actions = classifyHookRequest(text);
      if (actions.length === 0 || !followsFileEditTool(session.turns, index)) return;
      for (const action of actions) {
        if (!requestsByAction.has(action)) requestsByAction.set(action, []);
        requestsByAction.get(action).push({ sessionId: session.sessionId, text });
      }
    });
  }
  return requestsByAction;
}

function classifyHookRequest(text) {
  return HOOK_ACTIONS.filter((hookAction) => hookAction.request.test(text)).map((hookAction) => hookAction.action);
}

function hookCommandCoversAction(command, action) {
  const hookAction = HOOK_ACTIONS.find((candidate) => candidate.action === action);
  return !!hookAction && hookAction.hookCommand.test(command);
}

// A follow-up check only makes sense once the session has changed files.
// The edit is often several replies back ("run all tests before I merge"
// comes after review and a summary), not in the last few turns, and many
// sessions edit through Bash rather than the Edit tool.
function followsFileEditTool(turns, currentIndex) {
  const earliestIndex = Math.max(0, currentIndex - EDIT_LOOKBACK_MAX_TURNS);
  for (let i = currentIndex - 1; i >= earliestIndex; i--) {
    if (turns[i].toolUses.some(isFileEditToolUse)) return true;
  }
  return false;
}

function isFileEditToolUse(toolUse) {
  if (EDIT_TOOL_NAMES.has(toolUse.name)) return true;
  const command = toolUse.name === 'Bash' && toolUse.input ? toolUse.input.command : null;
  return typeof command === 'string' && BASH_FILE_EDIT_PATTERN.test(command);
}

function distinctSessionCwds(sessions) {
  return [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
}

// Grading digests every evidence session, so wide clusters carry a sample
// plus the full count (which the grading queue ranks reach by).
function cappedEvidence(sessionIds) {
  const distinctIds = [...new Set(sessionIds)];
  return {
    evidenceSessionIds: distinctIds.slice(0, MAX_EVIDENCE_SESSIONS),
    evidenceSessionCount: distinctIds.length,
  };
}

// ---------------------------------------------------------------------------
// Category D — MCPs
// ---------------------------------------------------------------------------

function detectMcpCandidates(groupedSessions) {
  const userServers = [...new Set([...readUserMcpServers(), ...readPluginMcpServers()])];
  const allSessions = [...groupedSessions.values()].flat();
  const clusters = [...detectUnusedUserMcpServers(userServers, allSessions)];

  for (const [groupName, sessions] of groupedSessions) {
    const projectServers = readConfiguredMcpServers(distinctSessionCwds(sessions));
    clusters.push(...detectUnusedMcpServers(groupName, sessions, projectServers));
    clusters.push(...detectManualWorkGap(groupName, sessions, [...userServers, ...projectServers]));
  }
  return clusters;
}

// User-level and plugin servers load in every project, so their underuse
// is judged once across every analyzed session; judged per project, each
// project that simply doesn't need a server would raise its own cluster.
function detectUnusedUserMcpServers(userServers, allSessions) {
  if (allSessions.length < MIN_SESSIONS_FOR_USER_MCP_UNDERUSE) return [];
  const usedServers = collectUsedMcpServers(allSessions, userServers);
  const unusedServers = userServers.filter((serverName) => !usedServers.has(serverName));
  if (unusedServers.length === 0) return [];
  return [{
    group: ALL_PROJECTS_GROUP,
    signal: 'underuse',
    scope: 'user',
    unusedServers,
    sessionsConsidered: allSessions.length,
    ...cappedEvidence(mostRecentSessionIds(allSessions)),
  }];
}

function detectUnusedMcpServers(groupName, sessions, projectServers) {
  if (projectServers.length === 0 || sessions.length < MIN_SESSIONS_FOR_PROJECT_MCP_UNDERUSE) return [];
  const usedServers = collectUsedMcpServers(sessions, projectServers);
  const unusedServers = projectServers.filter((serverName) => !usedServers.has(serverName));
  if (unusedServers.length === 0) return [];
  return [{
    group: groupName,
    signal: 'underuse',
    scope: 'project',
    unusedServers,
    sessionsConsidered: sessions.length,
    ...cappedEvidence(mostRecentSessionIds(sessions)),
  }];
}

function detectManualWorkGap(groupName, sessions, availableServers) {
  const matches = [];
  for (const session of sessions) {
    for (const turn of session.turns) {
      if (isPersonTypedTurn(turn) && isManualWorkTurn(turn.text)) {
        matches.push({ sessionId: session.sessionId, text: turn.text.trim() });
      }
    }
  }

  const evidence = cappedEvidence(matches.map((m) => m.sessionId));
  if (evidence.evidenceSessionCount < MIN_CLUSTER_SIZE) return [];
  return [{
    group: groupName,
    signal: 'gap',
    occurrenceCount: matches.length,
    sampleTexts: matches.slice(0, CLUSTER_SAMPLE_COUNT).map((m) => truncate(m.text, CLUSTER_SAMPLE_TEXT_CHARS)),
    // Lets the grader tell "add an MCP" apart from "use the one you have".
    availableMcpServers: availableServers,
    ...evidence,
  }];
}

function isManualWorkTurn(text) {
  if (INJECTED_TURN_PATTERN.test(text)) return false;
  const typedText = text.replace(PASTED_CONTENT_BLOCK_PATTERN, ' ');
  if (typedText.length > MANUAL_WORK_MAX_TYPED_CHARS) return false;
  return MANUAL_WORK_PATTERN.test(typedText) || PASTED_EXTERNAL_OUTPUT_PATTERN.test(text);
}

// Project-scoped servers for the folders a group's sessions ran in: each
// folder's .mcp.json plus its ~/.claude.json projects entry. User-level and
// plugin servers are read separately (see detectMcpCandidates).
function readConfiguredMcpServers(projectPaths) {
  const names = new Set();
  for (const projectPath of projectPaths) {
    for (const name of readProjectMcpServers(projectPath)) names.add(name);
    for (const name of readPluginMcpServers(projectPath)) names.add(name);
  }
  return [...names];
}

function collectUsedMcpServers(sessions, serverNames) {
  const used = new Set();
  if (serverNames.length === 0) return used;
  for (const session of sessions) {
    for (const turn of session.turns) {
      for (const toolUse of turn.toolUses) {
        const serverName = matchMcpServerName(toolUse.name, serverNames);
        if (serverName) used.add(serverName);
      }
    }
  }
  return used;
}

function mostRecentSessionIds(sessions) {
  return [...sessions]
    .sort((a, b) => (getSessionLastActivityTimestamp(b) || '').localeCompare(getSessionLastActivityTimestamp(a) || ''))
    .map((s) => s.sessionId);
}

// ---------------------------------------------------------------------------
// Category E — Model routing
// ---------------------------------------------------------------------------

function detectModelRoutingCandidates(groupedSessions) {
  const clusters = [];

  for (const [groupName, sessions] of groupedSessions) {
    for (const session of sessions) {
      const modelsUsed = [...new Set(
        session.turns.filter((t) => t.model && REAL_MODEL_NAME_PATTERN.test(t.model)).map((t) => t.model)
      )];
      const turnCount = session.turns.length;
      const usesExpensiveModel = modelsUsed.some((m) => EXPENSIVE_MODEL_PATTERN.test(m));
      const usesCheapModel = modelsUsed.some((m) => CHEAP_MODEL_PATTERN.test(m));

      if (usesExpensiveModel && turnCount <= SHORT_SESSION_MAX_TURNS) {
        clusters.push({ group: groupName, signal: 'short-session-expensive-model', evidenceSessionIds: [session.sessionId] });
      }
      if (usesCheapModel && turnCount >= LONG_SESSION_MIN_TURNS) {
        clusters.push({ group: groupName, signal: 'long-session-cheap-model', evidenceSessionIds: [session.sessionId] });
      }
      if (modelsUsed.length > 1) {
        clusters.push({ group: groupName, signal: 'model-switch-mid-session', models: modelsUsed, evidenceSessionIds: [session.sessionId] });
      }
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Category F — Single-agent vs multi-agent (Task tool)
// ---------------------------------------------------------------------------

// One cluster per project and signal, not per session: the grader judges a
// habit better from several examples, and per-session clusters let this
// category crowd every other one out of the grading queue.
function detectAgentParallelismCandidates(groupedSessions) {
  const clusters = [];

  for (const [groupName, sessions] of groupedSessions) {
    const serialSessions = [];
    const trivialDelegationSessions = [];
    for (const session of sessions) {
      const subagentPrompts = collectSubagentPrompts(session);
      const independentChunks = countIndependentSerialChunks(session);

      if (subagentPrompts.length === 0 && independentChunks >= MIN_CLUSTER_SIZE) {
        serialSessions.push({ sessionId: session.sessionId, independentChunks });
      }
      if (subagentPrompts.length > 0 && independentChunks === 0 && subagentPrompts.every(isTrivialSubagentPrompt)) {
        trivialDelegationSessions.push({ sessionId: session.sessionId, independentChunks });
      }
    }
    if (serialSessions.length > 0) clusters.push(buildAgentCluster(groupName, 'serial-independent-work', serialSessions));
    if (trivialDelegationSessions.length > 0) clusters.push(buildAgentCluster(groupName, 'subagents-for-trivial-work', trivialDelegationSessions));
  }

  return clusters;
}

function buildAgentCluster(groupName, signal, flaggedSessions) {
  const ranked = [...flaggedSessions].sort((a, b) => b.independentChunks - a.independentChunks);
  return {
    group: groupName,
    signal,
    independentChunks: ranked[0].independentChunks,
    ...cappedEvidence(ranked.map((entry) => entry.sessionId)),
  };
}

function collectSubagentPrompts(session) {
  const prompts = [];
  for (const turn of session.turns) {
    for (const toolUse of turn.toolUses) {
      if (!SUBAGENT_TOOL_NAMES.has(toolUse.name)) continue;
      const prompt = toolUse.input && typeof toolUse.input.prompt === 'string' ? toolUse.input.prompt : '';
      prompts.push(prompt);
    }
  }
  return prompts;
}

function isTrivialSubagentPrompt(prompt) {
  return prompt.length <= TRIVIAL_SUBAGENT_PROMPT_MAX_CHARS;
}

function countIndependentSerialChunks(session) {
  const toolCalls = flattenToolCalls(session);
  const runs = findSameToolDifferentTargetRuns(toolCalls);
  return runs.filter((run) => isCleanIndependentRun(run, toolCalls)).length;
}

function findSameToolDifferentTargetRuns(toolCalls) {
  if (toolCalls.length === 0) return [];
  const runs = [];
  let currentRun = [toolCalls[0]];

  for (let i = 1; i < toolCalls.length; i++) {
    if (isSameToolDifferentTarget(toolCalls[i - 1], toolCalls[i])) {
      currentRun.push(toolCalls[i]);
      continue;
    }
    if (currentRun.length >= INDEPENDENT_RUN_MIN_LENGTH) runs.push(currentRun);
    currentRun = [toolCalls[i]];
  }
  if (currentRun.length >= INDEPENDENT_RUN_MIN_LENGTH) runs.push(currentRun);
  return runs;
}

// Phase 6 validation: every real F candidate graded got rejected, and the
// common thread was a target getting touched again later in the session —
// a shared debug loop mutating one config file, a design-review edit
// sequence revisited after a build check. Genuinely independent, one-shot
// work doesn't need revisiting. This can't prove independence (heuristics
// alone can't, per §2), but it directly screens out the failure pattern
// grading actually observed, trading recall for precision on purpose.
function isCleanIndependentRun(run, allToolCalls) {
  const runTargets = new Set(run.map((call) => call.target));
  return !allToolCalls.some((call) => !run.includes(call) && runTargets.has(call.target));
}

function flattenToolCalls(session) {
  const toolCalls = [];
  for (const turn of session.turns) {
    for (const toolUse of turn.toolUses) {
      toolCalls.push({ name: toolUse.name, target: extractToolTarget(toolUse), isLookup: isLookupToolUse(toolUse) });
    }
  }
  return toolCalls;
}

function extractToolTarget(toolUse) {
  const input = toolUse.input || {};
  if (typeof input.file_path === 'string') return input.file_path;
  if (typeof input.path === 'string') return input.path;
  if (typeof input.pattern === 'string') return input.pattern;
  if (typeof input.command === 'string') return input.command.slice(0, 80);
  return null;
}

function isLookupToolUse(toolUse) {
  if (INDEPENDENT_LOOKUP_TOOL_NAMES.has(toolUse.name)) return true;
  const command = toolUse.name === 'Bash' && toolUse.input ? toolUse.input.command : null;
  return typeof command === 'string' && READ_ONLY_BASH_PATTERN.test(command);
}

function isSameToolDifferentTarget(callA, callB) {
  return callA.isLookup && callB.isLookup && callA.name === callB.name && callA.target !== null && callB.target !== null && callA.target !== callB.target;
}

// ---------------------------------------------------------------------------
// Category G — Session & memory hygiene
// ---------------------------------------------------------------------------

function detectSessionHygieneCandidates(groupedSessions) {
  const clusters = [];

  const hasGlobalClaudeMd = fs.existsSync(path.join(HOME_DIR, '.claude', 'CLAUDE.md'));

  for (const [groupName, sessions] of groupedSessions) {
    const repoPath = sessions.find((s) => s.cwd)?.cwd;
    const hasRepoClaudeMd = repoPath ? fs.existsSync(path.join(repoPath, 'CLAUDE.md')) : false;
    const hasClaudeMd = hasRepoClaudeMd || hasGlobalClaudeMd;

    if (!hasClaudeMd && sessions.length >= MIN_CLUSTER_SIZE) {
      clusters.push({ group: groupName, signal: 'no-claude-md', evidenceSessionIds: sessions.map((s) => s.sessionId) });
    }

    for (const session of sessions) {
      const slope = correctionRateSlope(session);
      if (slope !== null && slope >= HYGIENE_SLOPE_THRESHOLD) {
        clusters.push({ group: groupName, signal: 'rising-correction-rate', slope, evidenceSessionIds: [session.sessionId] });
      }
    }
  }

  return clusters;
}

function correctionRateSlope(session) {
  const humanTurns = session.turns.filter(isHumanTypedTurn);
  if (humanTurns.length < HYGIENE_WINDOW_TURNS * 2) return null;

  const firstWindow = humanTurns.slice(0, HYGIENE_WINDOW_TURNS);
  const lastWindow = humanTurns.slice(-HYGIENE_WINDOW_TURNS);
  const firstRate = correctionRate(firstWindow);
  const lastRate = correctionRate(lastWindow);
  return lastRate - firstRate;
}

function correctionRate(turns) {
  const correctionCount = turns.filter((t) => CORRECTION_PATTERN.test(t.text)).length;
  return correctionCount / turns.length;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function runHeuristicPass({ full = false, repo = null, branch = null } = {}) {
  const excludedSessionIds = loadExcludedSessionIds();
  const { sessions: discoveredSessions, skippedFiles, newlyExcluded } = loadAnalyzableSessions(excludedSessionIds);
  persistNewlyDetectedSelfSessions(newlyExcluded);

  // Groups are resolved from the full discovered set, before any
  // repo/branch narrowing — auto-suggestion (§1.1) needs the whole
  // picture to cluster sensibly, and --repo itself can name a group.
  const { groups, wasGenerated } = loadOrSuggestGroups(discoveredSessions);

  const lastReviewAt = full ? null : findLastReviewTimestamp();
  const { sessions: sinceLastReview, skippedAsAlreadyReviewed } = filterSinceLastReview(discoveredSessions, lastReviewAt);
  const allSessions = filterByScope(sinceLastReview, groups, { repo, branch });

  const groupedSessions = assignSessionsToGroups(allSessions, groups);
  const candidates = detectAllCategoryCandidates(groupedSessions);

  return {
    generatedAt: new Date().toISOString(),
    incremental: lastReviewAt !== null,
    reviewedSince: lastReviewAt,
    scope: { repo, branch },
    sessionsAnalyzed: allSessions.length,
    sessionsSkippedAlreadyReviewed: skippedAsAlreadyReviewed,
    sessionsExcludedSelfReferential: newlyExcluded.length,
    filesSkipped: skippedFiles,
    groupsWereAutoGenerated: wasGenerated,
    groupCount: groupedSessions.size,
    candidates,
    gradingQueue: buildGradingQueue(candidates),
  };
}

// §5's trend view already needs run history ("this correction keeps
// recurring even after you added the rule") — reusing that same
// ~/.loupe/runs/ history to bound each run to "what's new" is what makes
// repeat reviews fast and cheap instead of re-grading the same old
// sessions every time.
function findLastReviewTimestamp() {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const runFiles = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort();
  if (runFiles.length === 0) return null;
  const latestRun = readJsonSafe(path.join(RUNS_DIR, runFiles[runFiles.length - 1]));
  return latestRun ? latestRun.generatedAt : null;
}

function filterSinceLastReview(sessions, lastReviewAt) {
  if (!lastReviewAt) return { sessions, skippedAsAlreadyReviewed: 0 };

  const isNew = (session) => {
    const lastActivity = getSessionLastActivityTimestamp(session);
    return lastActivity === null || lastActivity > lastReviewAt;
  };

  const newSessions = sessions.filter(isNew);
  return { sessions: newSessions, skippedAsAlreadyReviewed: sessions.length - newSessions.length };
}

function getSessionLastActivityTimestamp(session) {
  const timestamps = session.turns.map((t) => t.timestamp).filter(Boolean);
  return timestamps.length > 0 ? timestamps.sort().pop() : null;
}

function loadAnalyzableSessions(excludedSessionIds) {
  const sessions = [];
  const skippedFiles = [];
  const newlyExcluded = [];

  for (const file of discoverTranscriptFiles()) {
    let session;
    try {
      session = parseTranscriptFile(file);
    } catch (err) {
      skippedFiles.push({ file, error: err.message });
      continue;
    }
    if (!session) {
      skippedFiles.push({ file, error: 'no sessionId found' });
      continue;
    }
    if (excludedSessionIds.has(session.sessionId)) continue;
    if (isLoupeInvocationSession(session)) {
      newlyExcluded.push(session.sessionId);
      continue;
    }
    sessions.push(session);
  }

  return { sessions, skippedFiles, newlyExcluded };
}

function detectAllCategoryCandidates(groupedSessions) {
  return {
    A_guidelines: detectGuidelineCandidates(groupedSessions),
    B_skills: detectSkillCandidates(groupedSessions),
    C_hooks: detectHookCandidates(groupedSessions),
    D_mcps: detectMcpCandidates(groupedSessions),
    E_modelRouting: detectModelRoutingCandidates(groupedSessions),
    F_agentParallelism: detectAgentParallelismCandidates(groupedSessions),
    G_sessionHygiene: detectSessionHygieneCandidates(groupedSessions),
  };
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------

function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = {
  classifyHookRequest,
  followsFileEditTool,
  isManualWorkTurn,
  collectUsedMcpServers,
  countIndependentSerialChunks,
};
