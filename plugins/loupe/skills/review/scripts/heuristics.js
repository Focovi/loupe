#!/usr/bin/env node
'use strict';

/**
 * Loupe heuristic pre-filtering pass (Full Spec §1, §1.1, §2, §3).
 *
 * Discovers local Claude Code session transcripts, groups them into logical
 * projects, and runs cheap structural/regex detectors for each of the seven
 * recommendation categories (A-G). Outputs candidate clusters as JSON to
 * stdout — no LLM grading happens here (that's grade.js, Phase 2).
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
const grouping = require('./grouping');
const { PROCEDURE_GRAM_LENGTH, buildProcedureSteps, findRecurringStepRuns } = require('./procedure-steps');

const HOME_DIR = os.homedir();
const PROJECTS_DIR = path.join(HOME_DIR, '.claude', 'projects');
const LOUPE_DIR = path.join(HOME_DIR, '.loupe');
const GROUPS_FILE = path.join(LOUPE_DIR, 'groups.json');
const CONFIG_FILE = path.join(LOUPE_DIR, 'config.json');
const EXCLUDED_SESSIONS_FILE = path.join(LOUPE_DIR, 'excluded-sessions.json');
const RUNS_DIR = path.join(LOUPE_DIR, 'runs');
// Either separator: a Windows session may call the scripts with
// backslashes (cmd, PowerShell) or forward slashes (Git Bash).
const LOUPE_SCRIPTS_PATH_PATTERN = /skills[\\/]+review[\\/]+scripts/;
// Must match the opening lines build-grade-prompt.js and consolidate.js
// send verbatim.
const LOUPE_PROMPT_SIGNATURES = ['grading a candidate recommendation for Loupe', 'merging duplicate findings for Loupe'];

const DUMP_SCHEMA_LINE_COUNT = 8;
const DIGEST_MAX_TURNS = 80;
const DIGEST_TEXT_TRUNCATE_CHARS = 300;
const DIGEST_TOOL_ARG_TRUNCATE_CHARS = 150;
// A grading prompt holds every digest it is given, so the digest is capped
// by session count and by total size. Without the caps a 145-session skills
// cluster built a prompt past the model's context limit. The budget is in
// characters of digest JSON, roughly 4 per token.
const DIGEST_MAX_SESSIONS = 10;
const DIGEST_MAX_CHARS = 360000;
const DIGEST_MIN_TURNS = 10;
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
// A long stretch of lookups in the main session, one round trip after
// another, is exploration a subagent could run and hand back as a summary,
// keeping the main context for the work itself. Short runs are not: grading
// rejected three or four quick reads every time, since a subagent costs
// more than they do.
const MIN_EXPLORATION_ROUND_TRIPS = 10;
// Claude Code renamed the subagent tool from Task to Agent; transcripts
// from either era must count, or every session reads as "never delegated".
const SUBAGENT_TOOL_NAMES = new Set(['Task', 'Agent']);
// Only lookups count as exploration. Other Bash calls (build, test,
// commit) are the work itself.
const LOOKUP_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
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
// reminders, scheduled-task prompts, interrupt markers, task briefs sent by
// another session and other injected context. Their boilerplate ("never
// edit generated files by hand") matched hundreds of times and drowned out
// what people actually asked for.
const INJECTED_TURN_PATTERN = /^\s*(<(system-reminder|scheduled-task|command-[a-z]+|local-command-[a-z]+|task-notification|cross-session-message|artifact-[a-z-]+|side-sessions-event|ci-monitor-event|bash-[a-z]+)\b|This session is being continued from a previous conversation|Caveat: |\[Request interrupted by user|Background \(from the session that started this one\))/i;
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
  const includedIds = sessionIds.slice(0, DIGEST_MAX_SESSIONS);
  const sessions = findSessionsById(includedIds, discoverTranscriptFiles());
  const bundle = buildDigestBundle(sessions, { sessionsRequested: sessionIds.length });
  process.stdout.write(JSON.stringify(bundle, null, 2) + '\n');
}

// A transcript is normally named <sessionId>.jsonl, so those are opened
// directly. Parsing every file until the right ones turn up took about 10
// seconds per grading call on a large history; the full scan is kept only
// for the few sessions whose file is named differently.
function findSessionsById(sessionIds, files) {
  const wanted = new Set(sessionIds);
  const found = new Map();
  const filesByName = new Map(files.map((file) => [path.basename(file, '.jsonl'), file]));

  for (const sessionId of wanted) {
    const file = filesByName.get(sessionId);
    const session = file ? safeParseTranscriptFile(file) : null;
    if (session && session.sessionId === sessionId) found.set(sessionId, session);
  }

  for (const file of files) {
    if (found.size === wanted.size) break;
    if (found.has(path.basename(file, '.jsonl'))) continue;
    const session = safeParseTranscriptFile(file);
    if (session && wanted.has(session.sessionId) && !found.has(session.sessionId)) found.set(session.sessionId, session);
  }

  return sessionIds.filter((id) => found.has(id)).map((id) => found.get(id));
}

// Halves the turns kept per session until the digests fit the budget, so a
// cluster of long sessions still grades on a sample of every session rather
// than on a few sessions in full.
function buildDigestBundle(sessions, { sessionsRequested = sessions.length, maxChars = DIGEST_MAX_CHARS } = {}) {
  let maxTurns = DIGEST_MAX_TURNS;
  let digests = sessions.map((s) => buildSessionDigest(s, maxTurns));
  while (JSON.stringify(digests).length > maxChars && maxTurns > DIGEST_MIN_TURNS) {
    maxTurns = Math.max(DIGEST_MIN_TURNS, Math.floor(maxTurns / 2));
    digests = sessions.map((s) => buildSessionDigest(s, maxTurns));
  }
  return { sessionsRequested, sessionsIncluded: digests.length, maxTurnsPerSession: maxTurns, sessions: digests };
}

function safeParseTranscriptFile(filePath) {
  try {
    return parseTranscriptFile(filePath);
  } catch (err) {
    return null;
  }
}

function buildSessionDigest(session, maxTurns = DIGEST_MAX_TURNS) {
  const relevantTurns = session.turns.filter((t) => isHumanTypedTurn(t) || t.type === 'assistant');
  const sampledTurns = sampleHeadAndTail(relevantTurns, maxTurns);

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
// optional: the orchestrating session (calls heuristics.js/grade.js via
// Bash, caught below by tool-call inspection) and each grading *child*
// session grade.js spawns via `claude -p` (does its own independent
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
  return LOUPE_SCRIPTS_PATH_PATTERN.test(toolUse.input.command);
}

function isLoupeGradingPrompt(turn) {
  return isHumanTypedTurn(turn) && LOUPE_PROMPT_SIGNATURES.some((signature) => turn.text.includes(signature));
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
// as a user turn. Used by every detector that reads what the person asked
// for (A, C, D and G); the session digest keeps the looser check so the
// grader still sees the context the model was given.
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
  const config = readJsonSafe(CONFIG_FILE, {});
  return grouping.suggestGroups(sessions.map((session) => session.cwd), {
    homeDir: HOME_DIR,
    roots: Array.isArray(config.projectRoots) ? config.projectRoots : null,
  });
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
    if (repoPaths.some((repoPath) => grouping.isSameOrInside(session.cwd, grouping.expandHome(repoPath, HOME_DIR)))) {
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
  const resolvedPath = path.resolve(grouping.expandHome(repoArg, HOME_DIR));
  return grouping.isSameOrInside(session.cwd, resolvedPath);
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

// Looks for short person-typed turns matching a predicate, then clusters
// the matches by text similarity to find a *recurring* pattern rather than
// a one-off.
function detectRecurringTurnPatternCandidates(groupedSessions, turnMatches) {
  const clusters = [];

  for (const [groupName, sessions] of groupedSessions) {
    const matchedTurns = [];
    for (const session of sessions) {
      // The same text typed or re-injected again in one session counts once,
      // so one long session can't pass for a recurring pattern.
      const textsSeenInSession = new Set();
      for (let i = 0; i < session.turns.length; i++) {
        const turn = session.turns[i];
        if (!isPersonTypedTurn(turn)) continue;
        if (!turnMatches(turn, session, i)) continue;
        const text = turn.text.trim();
        const dedupeKey = text.toLowerCase().replace(/\s+/g, ' ');
        if (textsSeenInSession.has(dedupeKey)) continue;
        textsSeenInSession.add(dedupeKey);
        matchedTurns.push({ sessionId: session.sessionId, text });
      }
    }

    const textClusters = clusterBySimilarity(matchedTurns, (item) => normalizeForSimilarity(item.text));
    for (const cluster of textClusters) {
      const evidenceSessionIds = [...new Set(cluster.map((c) => c.sessionId))];
      if (evidenceSessionIds.length < MIN_CLUSTER_SIZE) continue;
      clusters.push({
        group: groupName,
        representativeText: cluster[0].text,
        occurrenceCount: cluster.length,
        evidenceSessionIds,
      });
    }
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Category B — Skills (.claude/skills/)
// ---------------------------------------------------------------------------

// A procedure needs this many sessions to count as re-derived rather than
// a one-off; two sessions sharing three steps is often coincidence.
const MIN_PROCEDURE_SESSIONS = 3;
// A recurring run joins a larger one when at least this share of its
// sessions are already in it: both are parts of one procedure.
const PROCEDURE_MERGE_OVERLAP = 0.5;
const MAX_PROCEDURE_STEPS = 8;

function detectSkillCandidates(groupedSessions) {
  const allSessions = [...groupedSessions.values()].flat();
  const stepsBySession = buildProcedureSteps(allSessions);
  const sessionsById = new Map(allSessions.map((session) => [session.sessionId, session]));
  const clusters = [];

  for (const [groupName, sessions] of groupedSessions) {
    const runs = findRecurringStepRuns(stepsBySession, sessions.map((session) => session.sessionId))
      .filter((run) => run.sessionIds.size >= MIN_PROCEDURE_SESSIONS);

    for (const procedure of mergeOverlappingRuns(runs)) {
      const procedureSessions = [...procedure.sessionIds].map((id) => sessionsById.get(id));
      const repoPath = procedureSessions[0].cwd;
      clusters.push({
        group: groupName,
        occurrenceCount: procedureSessions.length,
        procedureSteps: procedure.steps,
        hasExistingSkillDir: repoPath ? fs.existsSync(path.join(repoPath, '.claude', 'skills')) : false,
        ...cappedEvidence(mostRecentSessionIds(procedureSessions)),
      });
    }
  }

  return clusters;
}

// Overlapping runs (A>B>C and B>C>D in the same sessions) are one
// procedure. Widest runs seed procedures; each later run joins the first
// procedure that already holds most of its sessions.
function mergeOverlappingRuns(runs) {
  const procedures = [];
  const widestFirst = [...runs].sort((a, b) => b.sessionIds.size - a.sessionIds.size);
  for (const run of widestFirst) {
    const home = procedures.find((procedure) => sharedSessionShare(run, procedure) >= PROCEDURE_MERGE_OVERLAP);
    if (!home) {
      procedures.push({ steps: [...run.steps], sessionIds: new Set(run.sessionIds) });
      continue;
    }
    for (const id of run.sessionIds) home.sessionIds.add(id);
    home.steps = extendSteps(home.steps, run.steps);
  }
  return procedures;
}

function sharedSessionShare(run, procedure) {
  let shared = 0;
  for (const id of run.sessionIds) if (procedure.sessionIds.has(id)) shared++;
  return shared / run.sessionIds.size;
}

// Grows the procedure by one step when the run continues it at either end.
function extendSteps(steps, run) {
  if (steps.length >= MAX_PROCEDURE_STEPS) return steps;
  const overlap = PROCEDURE_GRAM_LENGTH - 1;
  if (sameSteps(steps.slice(-overlap), run.slice(0, overlap))) return [...steps, run[overlap]];
  if (sameSteps(steps.slice(0, overlap), run.slice(1))) return [run[0], ...steps];
  return steps;
}

function sameSteps(a, b) {
  return a.length === b.length && a.every((step, i) => step === b[i]);
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
// category crowd every other one out of the grading queue. Long exploration
// needs MIN_CLUSTER_SIZE sessions to be a habit rather than a one-off.
function detectAgentParallelismCandidates(groupedSessions) {
  const clusters = [];

  for (const [groupName, sessions] of groupedSessions) {
    const exploringSessions = [];
    const trivialDelegationSessions = [];
    for (const session of sessions) {
      const roundTrips = longestExplorationRoundTrips(session);
      const flagged = { sessionId: session.sessionId, roundTrips };
      if (roundTrips >= MIN_EXPLORATION_ROUND_TRIPS) exploringSessions.push(flagged);
      if (delegatesOnlyTrivialWork(session)) trivialDelegationSessions.push(flagged);
    }
    if (new Set(exploringSessions.map((entry) => entry.sessionId)).size >= MIN_CLUSTER_SIZE) {
      clusters.push(buildAgentCluster(groupName, 'long-exploration-in-main-session', exploringSessions));
    }
    if (trivialDelegationSessions.length > 0) {
      clusters.push(buildAgentCluster(groupName, 'subagents-for-trivial-work', trivialDelegationSessions));
    }
  }

  return clusters;
}

function buildAgentCluster(groupName, signal, flaggedSessions) {
  const ranked = [...flaggedSessions].sort((a, b) => b.roundTrips - a.roundTrips);
  return {
    group: groupName,
    signal,
    longestExplorationRoundTrips: ranked[0].roundTrips,
    ...cappedEvidence(ranked.map((entry) => entry.sessionId)),
  };
}

function delegatesOnlyTrivialWork(session) {
  const prompts = collectSubagentPrompts(session);
  return prompts.length > 0 && prompts.every(isTrivialSubagentPrompt);
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

// The most lookup round trips in a row, with no other tool call and no
// person turn between them. Lookups sent together in one message wait for
// one round trip, so they count once.
function longestExplorationRoundTrips(session) {
  let longest = 0;
  let current = 0;
  let isRoundTripOpen = false;
  for (const turn of session.turns) {
    if (isPersonTypedTurn(turn)) current = 0;
    if (turn.isToolResultTurn || isPersonTypedTurn(turn)) {
      isRoundTripOpen = false;
      continue;
    }
    for (const toolUse of turn.toolUses) {
      if (!isLookupToolUse(toolUse)) {
        current = 0;
        isRoundTripOpen = true;
        continue;
      }
      if (isRoundTripOpen) continue;
      current++;
      isRoundTripOpen = true;
      longest = Math.max(longest, current);
    }
  }
  return longest;
}

function isLookupToolUse(toolUse) {
  if (LOOKUP_TOOL_NAMES.has(toolUse.name)) return true;
  const command = toolUse.name === 'Bash' && toolUse.input ? toolUse.input.command : null;
  return typeof command === 'string' && READ_ONLY_BASH_PATTERN.test(command);
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
      clusters.push({ group: groupName, signal: 'no-claude-md', ...cappedEvidence(mostRecentSessionIds(sessions)) });
    }

    const risingCluster = buildRisingCorrectionCluster(groupName, sessions);
    if (risingCluster) clusters.push(risingCluster);
  }

  return clusters;
}

// One cluster per group, and only when two or more sessions show the rise:
// a single long session is an anecdote, not a habit worth a threshold.
// Steepest sessions come first so the digest sample shows the clearest cases.
function buildRisingCorrectionCluster(groupName, sessions) {
  const rising = sessions
    .map((session) => ({ session, slope: correctionRateSlope(session) }))
    .filter((entry) => entry.slope !== null && entry.slope >= HYGIENE_SLOPE_THRESHOLD)
    .sort((a, b) => b.slope - a.slope);
  if (rising.length < MIN_CLUSTER_SIZE) return null;

  const slopes = rising.map((entry) => entry.slope);
  return {
    group: groupName,
    signal: 'rising-correction-rate',
    maxSlope: slopes[0],
    medianSlope: slopes[Math.floor(slopes.length / 2)],
    ...cappedEvidence(rising.map((entry) => entry.session.sessionId)),
  };
}

function correctionRateSlope(session) {
  const humanTurns = session.turns.filter(isPersonTypedTurn);
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
  longestExplorationRoundTrips,
  isPersonTypedTurn,
  detectGuidelineCandidates,
  detectSkillCandidates,
  detectAgentParallelismCandidates,
  detectSessionHygieneCandidates,
  correctionRateSlope,
  buildDigestBundle,
  buildSessionDigest,
  findSessionsById,
};
