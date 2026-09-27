#!/usr/bin/env bash
# Baseline runner: install/build/lint/test a tree with a sandboxed HOME so the
# real ~/.agent-recall store is never read or written. Usage:
#   run-baseline.sh <tree-dir> <label> <out-dir>
set -u
TREE="$1"; LABEL="$2"; OUT="$3"
mkdir -p "$OUT"
SANDBOX="$(mktemp -d)"
MARKER="$OUT/$LABEL.marker"; : > "$MARKER"
export HOME="$SANDBOX" USERPROFILE="$SANDBOX" AGENT_RECALL_ROOT="$SANDBOX/.agent-recall"
unset AGENT_RECALL_SUPABASE_URL AGENT_RECALL_SUPABASE_KEY AGENT_RECALL_EMBEDDING_PROVIDER \
      AGENT_RECALL_EMBEDDING_KEY OPENAI_API_KEY AGENT_RECALL_EMBEDDINGS AGENT_RECALL_EMBEDDINGS_HOME
cd "$TREE" || exit 2
RESULTS="$OUT/$LABEL.results.jsonl"; : > "$RESULTS"
step() {
  local name="$1"; shift
  local t0=$(date +%s)
  "$@" > "$OUT/$LABEL.$name.log" 2>&1
  local rc=$?
  printf '{"label":"%s","step":"%s","cmd":"%s","exit_code":%d,"secs":%d,"head":"%s"}\n' \
    "$LABEL" "$name" "$*" "$rc" "$(( $(date +%s) - t0 ))" "$(git rev-parse HEAD)" >> "$RESULTS"
}
step install npm ci --no-audit --no-fund
step build npm run build
step lint npm run lint
for p in core mcp-server sdk cli; do
  step "test-$p" npm test -w "packages/$p"
done
# Real store must be untouched.
: > "$OUT/$LABEL.real-store-touched.txt"
for REAL in "/c/Users/tong/.agent-recall" "/e/AI-Agent-Data/agent-recall"; do
  find "$REAL" -type f -newer "$MARKER" 2>/dev/null >> "$OUT/$LABEL.real-store-touched.txt"
done
echo "touched_real_store_files=$(wc -l < "$OUT/$LABEL.real-store-touched.txt")" >> "$OUT/$LABEL.summary.txt"
echo "sandbox=$SANDBOX" >> "$OUT/$LABEL.summary.txt"
