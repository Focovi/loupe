#!/usr/bin/env bash
# Loupe grading pass (Full Spec §3).
#
# Wraps a single headless `claude -p` call on a PINNED model — never
# whatever model happens to be invoking the /loupe:review skill — so grade
# consistency (§5) doesn't drift with the invoking session's model choice.
#
# Usage:
#   node heuristics.js | jq -c '.candidates.A_guidelines[0]' | \
#     scripts/grade.sh A
#
# Reads one candidate cluster as JSON on stdin, prints one graded
# recommendation as JSON on stdout: {category, evidence_session_ids,
# recommendation, proposed_artifact, apply_prompt}.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Explicitly named, not an alias like "sonnet" — aliases track "latest" and
# would silently drift the rubric's judgment call over time. Override with
# LOUPE_GRADE_MODEL if you want to repin deliberately.
GRADE_MODEL="${LOUPE_GRADE_MODEL:-claude-sonnet-5}"

CATEGORY="${1:-}"
if [ -z "$CATEGORY" ]; then
  echo '{"error":"usage: grade.sh <category letter A-G>, cluster JSON on stdin"}' >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

CLUSTER_FILE="$WORK_DIR/cluster.json"
DIGEST_FILE="$WORK_DIR/digest.json"
PROMPT_FILE="$WORK_DIR/prompt.txt"
RESPONSE_FILE="$WORK_DIR/response.json"

cat > "$CLUSTER_FILE"

SESSION_IDS="$(node -e '
  const cluster = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const ids = cluster.evidenceSessionIds || cluster.evidence_session_ids || [];
  process.stdout.write(ids.join(","));
' "$CLUSTER_FILE")"

if [ -z "$SESSION_IDS" ]; then
  echo '{"error":"candidate cluster has no evidenceSessionIds"}' >&2
  exit 1
fi

node "$SCRIPT_DIR/heuristics.js" --digest "$SESSION_IDS" > "$DIGEST_FILE"
node "$SCRIPT_DIR/build-grade-prompt.js" "$CATEGORY" "$CLUSTER_FILE" "$DIGEST_FILE" > "$PROMPT_FILE"

# No tool access: this is a pure text-in/text-out grading call, and denying
# tools keeps it fast, cheap, and unable to recurse into Loupe's own scripts.
claude -p --model "$GRADE_MODEL" --output-format json --allowedTools "" \
  < "$PROMPT_FILE" > "$RESPONSE_FILE"

node -e '
  const fs = require("fs");
  const envelope = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const heuristicsPath = process.argv[2];

  if (envelope.is_error) {
    console.error(JSON.stringify({ error: "claude -p call failed", detail: envelope }));
    process.exit(1);
  }

  // The grading call itself creates a new Claude Code session — exclude it
  // from future Loupe runs the same way the orchestrating skill session is
  // excluded (§3 self-referential exclusion), or it would show up as data
  // in the next review.
  if (envelope.session_id) {
    try {
      require("child_process").execFileSync("node", [heuristicsPath, "--mark-self", envelope.session_id]);
    } catch (err) {
      // non-fatal — worst case this grading session gets analyzed next run
    }
  }

  // Models sometimes wrap JSON in a markdown fence despite being told not
  // to — strip it defensively rather than trusting the instruction alone.
  const stripFence = (text) => text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  let graded;
  try {
    graded = JSON.parse(stripFence(envelope.result));
  } catch (err) {
    console.error(JSON.stringify({ error: "model did not return valid JSON", raw: envelope.result }));
    process.exit(1);
  }

  const requiredKeys = ["category", "evidence_session_ids"];
  const missing = requiredKeys.filter((key) => !(key in graded));
  if (missing.length > 0) {
    console.error(JSON.stringify({ error: "graded response missing keys", missing, raw: graded }));
    process.exit(1);
  }

  console.log(JSON.stringify(graded));
' "$RESPONSE_FILE" "$SCRIPT_DIR/heuristics.js"
