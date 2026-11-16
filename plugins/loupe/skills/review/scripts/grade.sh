#!/usr/bin/env bash
# Kept so existing macOS/Linux callers keep working. The grader is
# grade.js, which also runs on Windows; call it directly.
exec node "$(dirname "${BASH_SOURCE[0]}")/grade.js" "$@"
