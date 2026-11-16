'use strict';

// Category B looks for a multi-step procedure worked out by hand in several
// sessions. Tool names alone (Read, Edit, Bash) are shared by nearly every
// session, so comparing them clustered unrelated work together. Instead,
// each session is reduced to its significant steps: the command heads it
// ran (`git push`, `npm run`, `./deploy.sh`) and the MCP tools it called,
// in order. A run of steps that recurs across sessions is a procedure.

// Steps in a row that make up one procedure fingerprint.
const PROCEDURE_GRAM_LENGTH = 3;
// A step seen in more than this share of all sessions is routine (build,
// commit, push) and says nothing about a specific procedure.
const ROUTINE_STEP_SESSION_SHARE = 0.2;
// Below this many sessions there is too little data to call a step routine.
const ROUTINE_STEP_MIN_SESSIONS = 20;
// Subcommand words kept after the command name (`gh pr create`).
const MAX_SUBCOMMAND_WORDS = 2;

const MCP_TOOL_PREFIX = 'mcp__';
const SKILL_TOOL_NAME = 'Skill';
const READ_TOOL_NAME = 'Read';
const BASH_TOOL_NAME = 'Bash';
const SKILL_FILE_PATTERN = /(^|[\\/])SKILL\.md$/;
// A scheduled task runs its own prompt file, so it is scripted too.
const SCHEDULED_TASK_PATTERN = /^\s*<scheduled-task\b/;
const SLASH_COMMAND_NAME_PATTERN = /<command-name>\/?([^<\s]+)<\/command-name>/;
// Built-in commands manage the session; they don't run a scripted procedure.
const BUILT_IN_COMMANDS = new Set([
  'clear', 'compact', 'config', 'context', 'cost', 'effort', 'exit', 'fast', 'help', 'hooks', 'login',
  'logout', 'mcp', 'memory', 'model', 'permissions', 'plugin', 'resume', 'rewind', 'status', 'usage',
]);

// Looking around, moving around and plumbing: never a procedure step.
const INCIDENTAL_COMMANDS = new Set([
  'awk', 'basename', 'cat', 'cd', 'chmod', 'cp', 'cut', 'date', 'diff', 'dirname', 'du', 'echo', 'env',
  'export', 'false', 'file', 'find', 'grep', 'head', 'jq', 'less', 'ls', 'mkdir', 'mv', 'open', 'printf',
  'pwd', 'readlink', 'realpath', 'rg', 'rm', 'sed', 'set', 'sleep', 'sort', 'source', 'stat', 'tail',
  'tee', 'test', 'touch', 'tr', 'true', 'type', 'uniq', 'unset', 'wc', 'which', 'xargs',
]);
const SHELL_KEYWORDS = new Set([
  'break', 'case', 'continue', 'do', 'done', 'elif', 'else', 'esac', 'exit', 'fi', 'for', 'if', 'return', 'then',
  'until', 'while',
]);
// Wrappers that run the command after them.
const COMMAND_WRAPPERS = new Set(['sudo', 'time', 'nohup', 'exec', 'npx', 'command']);
const INTERPRETERS = new Set(['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'ruby', 'deno', 'bun', 'pwsh']);
// An interpreter fed inline code runs a one-off script, not a named step.
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '-', '--eval']);
const READ_ONLY_SUBCOMMAND_PATTERN = /^(git (log|show|diff|blame|status|branch|rev-parse|symbolic-ref|ls-files|ls-remote|remote|config)|gh (pr|issue|run) (view|list|diff|checks))\b/;
const SCRIPT_FILE_PATTERN = /\.(sh|bash|js|mjs|cjs|ts|py|rb|ps1)$/;
const SUBCOMMAND_WORD_PATTERN = /^[a-z][a-z0-9-]*$/;
// Two characters at least: single letters are loop variables and REPL input.
const COMMAND_NAME_PATTERN = /^[a-z][\w.-]+$/i;
// git -C <dir> and git -c <key=value> come before the subcommand.
const GIT_OPTIONS_WITH_VALUE = new Set(['-C', '-c']);
// Most git subcommands are one word, so `git push origin` stays `git push`;
// these take a second word that names the action.
const GIT_TWO_WORD_COMMANDS = new Set(['bisect', 'notes', 'remote', 'stash', 'submodule', 'worktree']);

const HEREDOC_PATTERN = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?(?:\n\s*\2(?=\s|$)|$)/g;
const QUOTED_STRING_PATTERN = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const LINE_CONTINUATION_PATTERN = /\\\n/g;
const COMMAND_SEPARATOR_PATTERN = /&&|\|\||[;|\n]/;
const ENV_ASSIGNMENT_PATTERN = /^\w+=/;
const INLINE_BODY_MARKER = '<<inline>>';

// Returns each session's unscripted significant steps, minus the steps that
// are routine across all of this person's work. Routine is judged on every
// step, scripted or not: a commit that /ship makes is still a commit.
function buildProcedureSteps(sessions) {
  const routineSteps = findRoutineSteps(sessions.map(allSessionSteps));
  const stepsBySession = new Map();
  for (const session of sessions) {
    const unscripted = unscriptedSessionSteps(session).filter((step) => !routineSteps.has(step));
    stepsBySession.set(session.sessionId, collapseRepeats(unscripted));
  }
  return stepsBySession;
}

function allSessionSteps(session) {
  const steps = [];
  for (const turn of session.turns) {
    for (const toolUse of turn.toolUses) steps.push(...toolUseSteps(toolUse));
  }
  return steps;
}

// Steps taken while a skill, slash command or scheduled task runs follow
// its script, which is already encoded. Once one starts, the rest of the
// session counts as scripted: a skill keeps driving after the person replies.
function unscriptedSessionSteps(session) {
  const steps = [];
  for (const turn of session.turns) {
    if (startsScriptedRun(turn)) return steps;
    for (const toolUse of turn.toolUses) {
      if (loadsSkill(toolUse)) return steps;
      steps.push(...toolUseSteps(toolUse));
    }
  }
  return steps;
}

function startsScriptedRun(turn) {
  if (turn.type !== 'user' || typeof turn.text !== 'string') return false;
  if (SCHEDULED_TASK_PATTERN.test(turn.text)) return true;
  const match = SLASH_COMMAND_NAME_PATTERN.exec(turn.text);
  return match !== null && !BUILT_IN_COMMANDS.has(match[1]);
}

function loadsSkill(toolUse) {
  if (toolUse.name === SKILL_TOOL_NAME) return true;
  const filePath = toolUse.input && toolUse.input.file_path;
  return toolUse.name === READ_TOOL_NAME && typeof filePath === 'string' && SKILL_FILE_PATTERN.test(filePath);
}

function toolUseSteps(toolUse) {
  if (toolUse.name.startsWith(MCP_TOOL_PREFIX)) return [toolUse.name];
  if (toolUse.name !== BASH_TOOL_NAME) return [];
  const command = toolUse.input && toolUse.input.command;
  return typeof command === 'string' ? commandSteps(command) : [];
}

function commandSteps(command) {
  const flattened = command
    .replace(HEREDOC_PATTERN, ` ${INLINE_BODY_MARKER} $3`)
    .replace(LINE_CONTINUATION_PATTERN, ' ')
    .replace(QUOTED_STRING_PATTERN, '""');
  return flattened
    .split(COMMAND_SEPARATOR_PATTERN)
    .map(commandHead)
    .filter((head) => head !== null);
}

// The command name plus its subcommand words, or null when the segment is
// incidental (looking around, plumbing) or a one-off inline script.
function commandHead(segment) {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && (ENV_ASSIGNMENT_PATTERN.test(words[0]) || COMMAND_WRAPPERS.has(words[0]))) words.shift();
  if (words.length === 0) return null;

  if (isScriptPath(words[0])) return baseName(words[0]);
  const name = words[0];
  if (!COMMAND_NAME_PATTERN.test(name) || INCIDENTAL_COMMANDS.has(name) || SHELL_KEYWORDS.has(name)) return null;
  if (INTERPRETERS.has(name)) return interpreterHead(name, words.slice(1));

  const head = [name, ...subcommandWords(name, words.slice(1))].join(' ');
  return READ_ONLY_SUBCOMMAND_PATTERN.test(head) ? null : head;
}

// A script run by path is named by its file; its arguments are not steps.
function isScriptPath(word) {
  return word.includes('/') && SCRIPT_FILE_PATTERN.test(word);
}

function interpreterHead(interpreter, args) {
  if (args.some((arg) => INLINE_CODE_FLAGS.has(arg) || arg === INLINE_BODY_MARKER)) return null;
  const script = args.find((arg) => !arg.startsWith('-'));
  if (!script || !SCRIPT_FILE_PATTERN.test(script)) return null;
  return `${interpreter} ${baseName(script)}`;
}

function subcommandWords(name, args) {
  const words = [];
  for (let i = 0; i < args.length && words.length < maxSubcommandWords(name, words); i++) {
    if (name === 'git' && GIT_OPTIONS_WITH_VALUE.has(args[i])) {
      i++;
      continue;
    }
    if (!SUBCOMMAND_WORD_PATTERN.test(args[i])) break;
    words.push(args[i]);
  }
  return words;
}

function maxSubcommandWords(name, wordsSoFar) {
  if (name !== 'git') return MAX_SUBCOMMAND_WORDS;
  return wordsSoFar.length > 0 && GIT_TWO_WORD_COMMANDS.has(wordsSoFar[0]) ? 2 : 1;
}

function baseName(filePath) {
  return filePath.replace(/^.*[\\/]/, '');
}

function findRoutineSteps(stepsPerSession) {
  const routine = new Set();
  if (stepsPerSession.length < ROUTINE_STEP_MIN_SESSIONS) return routine;

  const sessionCounts = new Map();
  for (const steps of stepsPerSession) {
    for (const step of new Set(steps)) sessionCounts.set(step, (sessionCounts.get(step) || 0) + 1);
  }
  for (const [step, count] of sessionCounts) {
    if (count / stepsPerSession.length > ROUTINE_STEP_SESSION_SHARE) routine.add(step);
  }
  return routine;
}

function collapseRepeats(steps) {
  return steps.filter((step, i) => step !== steps[i - 1]);
}

// Runs of PROCEDURE_GRAM_LENGTH distinct steps, each with the sessions it
// appears in, for the given session IDs.
function findRecurringStepRuns(stepsBySession, sessionIds) {
  const runs = new Map();
  for (const sessionId of sessionIds) {
    const steps = stepsBySession.get(sessionId) || [];
    for (let start = 0; start + PROCEDURE_GRAM_LENGTH <= steps.length; start++) {
      const run = steps.slice(start, start + PROCEDURE_GRAM_LENGTH);
      if (new Set(run).size < PROCEDURE_GRAM_LENGTH) continue;
      const key = run.join('\n');
      if (!runs.has(key)) runs.set(key, { steps: run, sessionIds: new Set() });
      runs.get(key).sessionIds.add(sessionId);
    }
  }
  return [...runs.values()];
}

module.exports = {
  PROCEDURE_GRAM_LENGTH,
  buildProcedureSteps,
  unscriptedSessionSteps,
  commandSteps,
  findRecurringStepRuns,
};
