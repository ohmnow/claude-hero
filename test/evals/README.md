# ClaudeHero Evals

Comprehensive test suite for validating ClaudeHero behavior in real-world scenarios.

## Structure

- `eval-runner.sh` — Main runner script, pipes test inputs through the hook
- `fixtures/` — JSON input fixtures simulating Claude Code hook events
- `expected/` — Expected outputs for comparison
- `edge-cases/` — Adversarial and boundary-condition tests

## How It Works

ClaudeHero is a Claude Code hook. It reads JSON from stdin and outputs JSON to stdout (context injection) or stderr (user messages). Exit codes matter:
- `0` = success (suggestions injected as context)
- `2` = critical alert (blocks the action)

Each eval pipes a fixture JSON into `node dist/index.js` and checks:
1. Exit code matches expected
2. Stdout contains expected context (if any)
3. Stderr contains expected user messages (if any)
4. No crashes on edge cases

## Running

```bash
# Run all evals
./test/evals/eval-runner.sh

# Run a specific category
./test/evals/eval-runner.sh security
./test/evals/eval-runner.sh edge-cases
```
