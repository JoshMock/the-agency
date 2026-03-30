#!/usr/bin/env bash
#
# Tests for common.sh hook parser and pure-logic helpers.
# Run: bash common.test.sh
#
# All tests use an in-memory hooks.yml via a tmpdir; nothing outside the
# tmpdir is created, modified, or deleted.

set -euo pipefail

SCRIPT_DIR="$(CDPATH="" cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

# Pretend the tmpdir is the repo root so _get_hook_commands finds hooks.yml
mkdir -p "$TEST_DIR/.specify"
get_repo_root() { echo "$TEST_DIR"; }

# Source the file under test, then override get_repo_root
source "$SCRIPT_DIR/common.sh"
get_repo_root() { echo "$TEST_DIR"; }

#==============================================================================
# Test harness
#==============================================================================
_pass=0 _fail=0 _total=0

assert_eq() {
    local label="$1" expected="$2" actual="$3"
    (( ++_total ))
    if [[ "$expected" == "$actual" ]]; then
    (( ++_pass ))
        echo "  ✓ $label"
    else
    (( ++_fail ))
        echo "  ✗ $label"
        echo "    expected: $(printf '%q' "$expected")"
        echo "    actual:   $(printf '%q' "$actual")"
    fi
}

assert_exit() {
    local label="$1" expected="$2"
    shift 2
    (( ++_total ))
    local rc=0
    "$@" >/dev/null 2>&1 || rc=$?
    if [[ "$rc" == "$expected" ]]; then
    (( ++_pass ))
        echo "  ✓ $label"
    else
    (( ++_fail ))
        echo "  ✗ $label"
        echo "    expected exit $expected, got $rc"
    fi
}

# helper: collect null-delimited _get_hook_commands output into $REPLY
# (newlines within a single command are preserved)
collect_commands() {
    local hook="$1"
    local -a cmds=()
    while IFS= read -r -d '' item; do
        cmds+=("$item")
    done < <(_get_hook_commands "$hook")
    REPLY_ARRAY=("${cmds[@]+"${cmds[@]}"}")
    # also set REPLY to newline-joined for simple single-command assertions
    local IFS=$'\n'
    REPLY="${cmds[*]+"${cmds[*]}"}"
}

write_hooks() { cat > "$TEST_DIR/.specify/hooks.yml"; }

#==============================================================================
# Hook parser — _get_hook_commands
#==============================================================================
echo "--- _get_hook_commands ---"

# single-line command
write_hooks << 'YAML'
hooks:
  greet:
    - echo "hello"
YAML
collect_commands greet
assert_eq "single-line command" 'echo "hello"' "$REPLY"

# multiple commands under one hook
write_hooks << 'YAML'
hooks:
  multi:
    - echo "one"
    - echo "two"
    - echo "three"
YAML
collect_commands multi
assert_eq "multiple commands: count" "3" "${#REPLY_ARRAY[@]}"
assert_eq "multiple commands: first" 'echo "one"' "${REPLY_ARRAY[0]}"
assert_eq "multiple commands: last" 'echo "three"' "${REPLY_ARRAY[2]}"

# nonexistent hook returns nothing
collect_commands nonexistent
assert_eq "nonexistent hook returns empty" "" "$REPLY"

# selects only the requested hook
write_hooks << 'YAML'
hooks:
  alpha:
    - echo "a"
  beta:
    - echo "b"
YAML
collect_commands alpha
assert_eq "selects correct hook (alpha)" 'echo "a"' "$REPLY"
collect_commands beta
assert_eq "selects correct hook (beta)" 'echo "b"' "$REPLY"

# skips YAML comments
write_hooks << 'YAML'
hooks:
  # this is a comment
  commented:
    # another comment
    - echo "not a comment"
YAML
collect_commands commented
assert_eq "skips comments" 'echo "not a comment"' "$REPLY"

# strips surrounding double quotes
write_hooks << 'YAML'
hooks:
  quoted:
    - "echo hello"
YAML
collect_commands quoted
assert_eq "strips surrounding double quotes" "echo hello" "$REPLY"

# does not strip partial quotes
write_hooks << 'YAML'
hooks:
  partial_quotes:
    - echo "hello world"
YAML
collect_commands partial_quotes
assert_eq "preserves internal quotes" 'echo "hello world"' "$REPLY"

#==============================================================================
# Block scalars (| and >)
#==============================================================================
echo "--- block scalars ---"

# literal block scalar (|)
write_hooks << 'YAML'
hooks:
  block_literal:
    - |
      if true; then
        echo "yes"
      fi
YAML
collect_commands block_literal
expected=$'if true; then\n  echo "yes"\nfi'
assert_eq "literal block scalar (|)" "$expected" "$REPLY"

# block scalar followed by another hook
write_hooks << 'YAML'
hooks:
  first:
    - |
      echo "block"
      echo "content"
  second:
    - echo "after"
YAML
collect_commands first
assert_eq "block scalar terminated by next hook" $'echo "block"\necho "content"' "$REPLY"
collect_commands second
assert_eq "hook after block scalar" 'echo "after"' "$REPLY"

# block scalar at end of file (EOF flush)
write_hooks << 'YAML'
hooks:
  eof_block:
    - |
      echo "last"
      echo "in file"
YAML
collect_commands eof_block
assert_eq "block scalar at EOF" $'echo "last"\necho "in file"' "$REPLY"

# block scalar with conditional logic (the original bug)
write_hooks << 'YAML'
hooks:
  conditional:
    - |
      if [[ -n "${MY_VAR:-}" ]]; then
        echo "$MY_VAR"
      else
        echo "default"
      fi
YAML
collect_commands conditional
expected=$'if [[ -n "${MY_VAR:-}" ]]; then\n  echo "$MY_VAR"\nelse\n  echo "default"\nfi'
assert_eq "block scalar with conditional" "$expected" "$REPLY"

# folded block scalar (>)
write_hooks << 'YAML'
hooks:
  block_folded:
    - >
      echo
      "folded"
YAML
collect_commands block_folded
# the parser treats > identically to | (preserves lines as-is)
assert_eq "folded block scalar (>)" $'echo\n"folded"' "$REPLY"

# mix of block scalar and simple commands in one hook
write_hooks << 'YAML'
hooks:
  mixed:
    - echo "before"
    - |
      echo "block"
      echo "scalar"
    - echo "after"
YAML
collect_commands mixed
assert_eq "mixed: count" "3" "${#REPLY_ARRAY[@]}"
assert_eq "mixed: simple before block" 'echo "before"' "${REPLY_ARRAY[0]}"
assert_eq "mixed: block scalar" $'echo "block"\necho "scalar"' "${REPLY_ARRAY[1]}"
assert_eq "mixed: simple after block" 'echo "after"' "${REPLY_ARRAY[2]}"

#==============================================================================
# hook_defined
#==============================================================================
echo "--- hook_defined ---"

write_hooks << 'YAML'
hooks:
  exists:
    - echo "hi"
YAML
assert_exit "hook_defined returns 0 for existing hook" 0 hook_defined exists
assert_exit "hook_defined returns 1 for missing hook" 1 hook_defined nope

#==============================================================================
# run_hook — execution and template substitution
#==============================================================================
echo "--- run_hook ---"

write_hooks << 'YAML'
hooks:
  say:
    - echo "hello"
YAML
result=$(run_hook say)
assert_eq "run_hook executes simple command" "hello" "$result"

# template variable substitution
write_hooks << 'YAML'
hooks:
  greet_user:
    - echo "hi {{name}}"
YAML
result=$(run_hook greet_user "name=Alice")
assert_eq "run_hook substitutes {{name}}" "hi Alice" "$result"

# multiple template variables
write_hooks << 'YAML'
hooks:
  path_hook:
    - echo "{{root}}/specs/{{id}}"
YAML
result=$(run_hook path_hook "root=/repo" "id=003-auth")
assert_eq "run_hook substitutes multiple vars" "/repo/specs/003-auth" "$result"

# run_hook with block scalar
write_hooks << 'YAML'
hooks:
  block_run:
    - |
      if [[ -n "${MY_VAR:-}" ]]; then
        echo "$MY_VAR"
      else
        echo "fallback"
      fi
YAML
result=$(run_hook block_run)
assert_eq "run_hook executes block scalar (fallback)" "fallback" "$result"
result=$(MY_VAR="override" run_hook block_run)
assert_eq "run_hook executes block scalar (env set)" "override" "$result"

# run_hook with multiple commands
write_hooks << 'YAML'
hooks:
  multi_run:
    - echo "one"
    - echo "two"
YAML
result=$(run_hook multi_run)
expected=$'one\ntwo'
assert_eq "run_hook executes multiple commands" "$expected" "$result"

# run_hook does nothing for undefined hook
result=$(run_hook undefined_hook 2>&1)
assert_eq "run_hook silently skips undefined hook" "" "$result"

#==============================================================================
# check_feature_branch
#==============================================================================
echo "--- check_feature_branch ---"

assert_exit "valid feature branch 001-foo" 0 check_feature_branch "001-feature-name" "true"
assert_exit "valid feature branch 999-bar" 0 check_feature_branch "999-bar" "true"
assert_exit "rejects non-feature branch" 1 check_feature_branch "main" "true"
assert_exit "rejects branch without 3-digit prefix" 1 check_feature_branch "01-short" "true"
assert_exit "skips validation when no git" 0 check_feature_branch "anything" "false"

#==============================================================================
# missing hooks.yml
#==============================================================================
echo "--- missing hooks.yml ---"

rm -f "$TEST_DIR/.specify/hooks.yml"
collect_commands any_hook
assert_eq "missing hooks.yml returns empty" "" "$REPLY"
assert_exit "hook_defined returns 1 when no hooks.yml" 1 hook_defined any_hook

#==============================================================================
# Summary
#==============================================================================
echo ""
echo "--- Results: $_pass/$_total passed, $_fail failed ---"
(( _fail == 0 ))
