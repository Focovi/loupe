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

const CORRECTION_PATTERN = /\b(no+,|don'?t|never|always|instead|stop doing|actually,? (please|just)?|please stop|that'?s wrong|not like that)\b/i;
const HOOK_REQUEST_PATTERN = /\b(run (the )?(lint|tests?|typecheck|format(ter)?)|please (lint|format|test)|check for [a-z ]+ tells?|run tsc)\b/i;
const MANUAL_WORK_PATTERN = /\b(copy(-| )?paste|paste this|from the browser|manually (check|copy|update|paginate)|switch(ing)? tabs? to (check|copy|grab))\b/i;
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

  const result = runHeuristicPass({ full: args.includes('--full') });
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

function detectHookCandidates(groupedSessions) {
  return detectRecurringTurnPatternCandidates(groupedSessions, (turn, session, index) => {
    if (!HOOK_REQUEST_PATTERN.test(turn.text)) return false;
    return followsFileEditTool(session.turns, index);
  });
}

function followsFileEditTool(turns, currentIndex) {
  for (let i = currentIndex - 1; i >= 0 && i >= currentIndex - 3; i--) {
    const priorTurn = turns[i];
    const editedFile = priorTurn.toolUses.some((toolUse) => EDIT_TOOL_NAMES.has(toolUse.name));
    if (editedFile) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Category D — MCPs
// ---------------------------------------------------------------------------

function detectMcpCandidates(groupedSessions) {
  const clusters = [];
  for (const [groupName, sessions] of groupedSessions) {
    clusters.push(...detectUnusedMcpServers(groupName, sessions));
    clusters.push(...detectManualWorkGap(groupName, sessions));
  }
  return clusters;
}

function detectUnusedMcpServers(groupName, sessions) {
  const repoPath = sessions.find((s) => s.cwd)?.cwd;
  const configuredServers = repoPath ? readConfiguredMcpServers(repoPath) : [];
  const usedServers = collectUsedMcpServers(sessions);
  const unusedServers = configuredServers.filter((serverName) => !usedServers.has(serverName));

  if (unusedServers.length === 0) return [];
  return [{ group: groupName, signal: 'underuse', unusedServers, evidenceSessionIds: sessions.map((s) => s.sessionId) }];
}

function detectManualWorkGap(groupName, sessions) {
  const manualWorkSessionIds = [];
  for (const session of sessions) {
    for (const turn of session.turns) {
      if (isHumanTypedTurn(turn) && MANUAL_WORK_PATTERN.test(turn.text)) {
        manualWorkSessionIds.push(session.sessionId);
      }
    }
  }

  if (manualWorkSessionIds.length < MIN_CLUSTER_SIZE) return [];
  return [{ group: groupName, signal: 'gap', evidenceSessionIds: [...new Set(manualWorkSessionIds)] }];
}

function readConfiguredMcpServers(repoPath) {
  const mcpConfig = readJsonSafe(path.join(repoPath, '.mcp.json'), null);
  if (!mcpConfig || typeof mcpConfig.mcpServers !== 'object') return [];
  return Object.keys(mcpConfig.mcpServers);
}

function collectUsedMcpServers(sessions) {
  const used = new Set();
  for (const session of sessions) {
    for (const turn of session.turns) {
      for (const toolUse of turn.toolUses) {
        const match = /^mcp__([^_]+)__/.exec(toolUse.name || '');
        if (match) used.add(match[1]);
      }
    }
  }
  return used;
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

function detectAgentParallelismCandidates(groupedSessions) {
  const clusters = [];

  for (const [groupName, sessions] of groupedSessions) {
    for (const session of sessions) {
      const usesTaskTool = session.turns.some((turn) => turn.toolUses.some((tu) => tu.name === 'Task'));
      const independentChunks = countIndependentSerialChunks(session);

      if (!usesTaskTool && independentChunks >= MIN_CLUSTER_SIZE) {
        clusters.push({ group: groupName, signal: 'serial-independent-work', independentChunks, evidenceSessionIds: [session.sessionId] });
      }
      if (usesTaskTool && independentChunks === 0) {
        clusters.push({ group: groupName, signal: 'subagents-for-trivial-work', evidenceSessionIds: [session.sessionId] });
      }
    }
  }

  return clusters;
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
      toolCalls.push({ name: toolUse.name, target: extractToolTarget(toolUse) });
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

function isSameToolDifferentTarget(callA, callB) {
  return callA.name === callB.name && callA.target !== null && callB.target !== null && callA.target !== callB.target;
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

function runHeuristicPass({ full = false } = {}) {
  const excludedSessionIds = loadExcludedSessionIds();
  const { sessions: discoveredSessions, skippedFiles, newlyExcluded } = loadAnalyzableSessions(excludedSessionIds);
  persistNewlyDetectedSelfSessions(newlyExcluded);

  const lastReviewAt = full ? null : findLastReviewTimestamp();
  const { sessions: allSessions, skippedAsAlreadyReviewed } = filterSinceLastReview(discoveredSessions, lastReviewAt);

  const { groups, wasGenerated } = loadOrSuggestGroups(allSessions);
  const groupedSessions = assignSessionsToGroups(allSessions, groups);

  return {
    generatedAt: new Date().toISOString(),
    incremental: lastReviewAt !== null,
    reviewedSince: lastReviewAt,
    sessionsAnalyzed: allSessions.length,
    sessionsSkippedAlreadyReviewed: skippedAsAlreadyReviewed,
    sessionsExcludedSelfReferential: newlyExcluded.length,
    filesSkipped: skippedFiles,
    groupsWereAutoGenerated: wasGenerated,
    groupCount: groupedSessions.size,
    candidates: detectAllCategoryCandidates(groupedSessions),
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

main();
