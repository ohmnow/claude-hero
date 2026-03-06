#!/usr/bin/env bash
# ClaudeHero Eval Runner
# Pipes test fixtures through the hook and validates behavior
#
# Usage:
#   ./test/evals/eval-runner.sh           # Run all evals
#   ./test/evals/eval-runner.sh security  # Run security evals only
#   ./test/evals/eval-runner.sh edge      # Run edge case evals only
#   ./test/evals/eval-runner.sh safe      # Run false-positive evals only

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK="$PROJECT_DIR/dist/index.js"
FILTER="${1:-all}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0
RESULTS=()

# Create empty transcript for evals (hook expects it to exist)
echo '' > /tmp/claude-hero-eval-transcript.jsonl

# Clean up any stale state
STATE_DIR="${XDG_RUNTIME_DIR:-${HOME}/.cache}/claude-hero"
rm -f "$STATE_DIR/state.json" "$STATE_DIR/state.lock" 2>/dev/null || true

###############################################################################
# Helpers
###############################################################################

run_fixture() {
  local name="$1"
  local fixture="$2"
  local expect_exit="$3"        # 0 or 2
  local expect_stderr="$4"      # substring expected in stderr (empty = don't check)
  local expect_no_stderr="$5"   # substring that must NOT appear in stderr (empty = don't check)
  local description="$6"

  # Reset cooldowns between tests
  rm -f "$STATE_DIR/state.json" "$STATE_DIR/state.lock" 2>/dev/null || true

  local stdout stderr exit_code
  stdout=$(node "$HOOK" < "$fixture" 2>/tmp/ch-eval-stderr.txt) && exit_code=$? || exit_code=$?
  stderr=$(cat /tmp/ch-eval-stderr.txt)

  local passed=true
  local reasons=""

  # Check exit code
  if [ "$exit_code" != "$expect_exit" ]; then
    passed=false
    reasons="${reasons}  exit code: got $exit_code, expected $expect_exit\n"
  fi

  # Check stderr contains expected string
  if [ -n "$expect_stderr" ] && ! echo "$stderr" | grep -qi "$expect_stderr"; then
    passed=false
    reasons="${reasons}  stderr missing: '$expect_stderr'\n"
  fi

  # Check stderr does NOT contain unwanted string
  if [ -n "$expect_no_stderr" ] && echo "$stderr" | grep -qi "$expect_no_stderr"; then
    passed=false
    reasons="${reasons}  stderr contains unwanted: '$expect_no_stderr'\n"
  fi

  if $passed; then
    echo -e "  ${GREEN}✓${NC} $name — $description"
    ((PASS++))
  else
    echo -e "  ${RED}✗${NC} $name — $description"
    echo -e "${RED}${reasons}${NC}"
    if [ -n "$stderr" ]; then
      echo -e "    ${YELLOW}stderr: $(echo "$stderr" | head -3)${NC}"
    fi
    ((FAIL++))
  fi
}

###############################################################################
# Security Evals — SHOULD trigger critical alerts (exit 2)
###############################################################################

run_security_evals() {
  echo -e "\n${CYAN}═══ Security Evals (should BLOCK) ═══${NC}"

  run_fixture \
    "SEC-001" \
    "$SCRIPT_DIR/fixtures/security-hardcoded-stripe-key.json" \
    "2" \
    "SECRET" \
    "" \
    "Detects hardcoded Stripe live key"

  run_fixture \
    "SEC-002" \
    "$SCRIPT_DIR/fixtures/security-hardcoded-github-pat.json" \
    "2" \
    "SECRET" \
    "" \
    "Detects hardcoded GitHub PAT (ghp_)"

  run_fixture \
    "SEC-003" \
    "$SCRIPT_DIR/fixtures/security-force-push-main.json" \
    "2" \
    "DANGEROUS" \
    "" \
    "Blocks force push to main"

  run_fixture \
    "SEC-004" \
    "$SCRIPT_DIR/fixtures/security-commit-env-file.json" \
    "2" \
    "COMMIT" \
    "" \
    "Blocks committing .env file"

  run_fixture \
    "SEC-005" \
    "$SCRIPT_DIR/fixtures/security-reset-hard.json" \
    "2" \
    "DANGEROUS" \
    "" \
    "Blocks git reset --hard"

  run_fixture \
    "SEC-006" \
    "$SCRIPT_DIR/fixtures/security-bearer-token-in-code.json" \
    "2" \
    "SECRET" \
    "" \
    "Detects bearer token in code"

  run_fixture \
    "SEC-007" \
    "$SCRIPT_DIR/fixtures/security-slack-token.json" \
    "2" \
    "SECRET" \
    "" \
    "Detects Slack token (xoxb-)"
}

###############################################################################
# False Positive Evals — should NOT trigger critical (exit 0)
###############################################################################

run_safe_evals() {
  echo -e "\n${CYAN}═══ False Positive Evals (should PASS, exit 0) ═══${NC}"

  run_fixture \
    "SAFE-001" \
    "$SCRIPT_DIR/fixtures/safe-commit-env-example.json" \
    "0" \
    "" \
    "CRITICAL" \
    "Allows committing .env.example (template file)"

  run_fixture \
    "SAFE-002" \
    "$SCRIPT_DIR/fixtures/safe-normal-code-edit.json" \
    "0" \
    "" \
    "CRITICAL" \
    "Normal code edit — no false alarms"

  run_fixture \
    "SAFE-003" \
    "$SCRIPT_DIR/fixtures/safe-git-push-feature.json" \
    "0" \
    "" \
    "CRITICAL" \
    "Normal push to feature branch — no false alarms"

  run_fixture \
    "SAFE-004" \
    "$SCRIPT_DIR/fixtures/safe-commit-message-mentions-secret.json" \
    "0" \
    "" \
    "CRITICAL" \
    "Commit message mentioning 'api key' — not a real secret"

  run_fixture \
    "SAFE-005" \
    "$SCRIPT_DIR/fixtures/safe-prompt-about-env-vars.json" \
    "0" \
    "" \
    "CRITICAL" \
    "Prompt about env vars — informational, not dangerous"
}

###############################################################################
# Edge Case Evals — should not crash (exit 0, graceful degradation)
###############################################################################

run_edge_evals() {
  echo -e "\n${CYAN}═══ Edge Case Evals (should not crash) ═══${NC}"

  run_fixture \
    "EDGE-001" \
    "$SCRIPT_DIR/edge-cases/malformed-input-empty.json" \
    "0" \
    "" \
    "" \
    "Empty JSON object — graceful error"

  run_fixture \
    "EDGE-002" \
    "$SCRIPT_DIR/edge-cases/malformed-input-missing-fields.json" \
    "0" \
    "" \
    "" \
    "Missing transcript_path — graceful error"

  run_fixture \
    "EDGE-003" \
    "$SCRIPT_DIR/edge-cases/malformed-input-bad-event.json" \
    "0" \
    "" \
    "" \
    "Invalid hook_event_name — graceful error"

  run_fixture \
    "EDGE-004" \
    "$SCRIPT_DIR/edge-cases/malformed-input-number-fields.json" \
    "0" \
    "" \
    "" \
    "Wrong types (numbers instead of strings) — graceful error"

  run_fixture \
    "EDGE-005" \
    "$SCRIPT_DIR/edge-cases/prompt-injection-attempt.json" \
    "0" \
    "" \
    "" \
    "Prompt injection attempt — no crash, sanitized"

  run_fixture \
    "EDGE-006" \
    "$SCRIPT_DIR/edge-cases/path-traversal-transcript.json" \
    "0" \
    "" \
    "" \
    "Path traversal in transcript_path — graceful error"

  run_fixture \
    "EDGE-007" \
    "$SCRIPT_DIR/edge-cases/unicode-prompt.json" \
    "0" \
    "" \
    "" \
    "Unicode/emoji in prompt — no crash"

  # Generate and test very long prompt (50KB)
  echo -e "  ${YELLOW}→ Generating 50KB prompt...${NC}"
  local long_prompt
  long_prompt=$(python3 -c "print('A' * 50000)" 2>/dev/null || printf '%0.sA' $(seq 1 50000))
  local tmpfile
  tmpfile=$(mktemp)
  cat > "$tmpfile" <<EOF
{
  "session_id": "eval-edge-long",
  "transcript_path": "/tmp/claude-hero-eval-transcript.jsonl",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "$long_prompt"
}
EOF
  run_fixture \
    "EDGE-008" \
    "$tmpfile" \
    "0" \
    "" \
    "" \
    "50KB prompt — no crash or hang"
  rm -f "$tmpfile"

  # Test with completely invalid JSON
  echo "not json at all {{{" > /tmp/ch-eval-bad-json.txt
  run_fixture \
    "EDGE-009" \
    "/tmp/ch-eval-bad-json.txt" \
    "0" \
    "" \
    "" \
    "Invalid JSON input — graceful error"
}

###############################################################################
# Main
###############################################################################

echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     ClaudeHero Eval Suite v0.3.0         ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"

# Check hook exists
if [ ! -f "$HOOK" ]; then
  echo -e "${RED}Error: dist/index.js not found. Run 'npm run build' first.${NC}"
  exit 1
fi

case "$FILTER" in
  security|sec)
    run_security_evals
    ;;
  safe|false-positive|fp)
    run_safe_evals
    ;;
  edge|edge-cases)
    run_edge_evals
    ;;
  all|*)
    run_security_evals
    run_safe_evals
    run_edge_evals
    ;;
esac

# Summary
echo -e "\n${CYAN}═══════════════════════════════════════════${NC}"
echo -e "  ${GREEN}Passed: $PASS${NC}  ${RED}Failed: $FAIL${NC}"
if [ "$FAIL" -gt 0 ]; then
  echo -e "  ${RED}⚠ $FAIL eval(s) failed!${NC}"
  exit 1
else
  echo -e "  ${GREEN}✅ All evals passed!${NC}"
fi
