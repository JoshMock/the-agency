---
name: pi-optimize
description: Audit and tune a Pi coding agent setup for token/cost efficiency. Use when asked to reduce Pi token spend, cut context bloat, speed up cold starts, lower cache-miss cost, prune skills, tune compaction/cache warming, or apply the pi-usage efficiency recommendations to settings.json and AGENTS.md files.
---

A checklist for finding and fixing the token-waste patterns that drive avoidable Pi spend. Work top-down; each item is independent. Measure before and after (`wc -c` on prompts, `showCacheMissNotices` in transcript).

Settings paths below use `~/.pi/agent/`; adjust if the user's config lives elsewhere.

## 1. System prompt bloat (every turn pays for it)

The system prompt = Pi built-ins + every loaded `AGENTS.md` + every enabled skill description. It is cached, but every cache miss (model switch, restart, pause > ~5 min) re-bills it at full input price.

- Measure: `wc -c ~/.pi/agent/AGENTS.md <project>/AGENTS.md`.
- Cut from `AGENTS.md`: rules the model already follows (don't lie, be concise), restatements of Pi defaults, philosophical/meta prose, duplicated examples. Convert declarative lists to one-line imperatives.
- Keep high-signal discriminators: output-format rules, `jj` vs `git` rules, TDD requirement, `rg`/`fd` preferences, commit-trailer requirements.
- Put generic rules once in the global `AGENTS.md` (loaded everywhere); put project-only rules in that project's `AGENTS.md`. Never duplicate the same block across many project files.

## 2. Prune the skill roster

Every enabled skill's description sits in every system prompt (~350 chars each). Never-invoked skills are pure dead weight.

- Find candidates: skills the user never triggers. If session telemetry exists, count SKILL.md reads per skill; otherwise ask the user which they recognize using.
- Archive, don't delete (reversible): `mkdir -p ~/.pi/agent/skills-archive && mv ~/.pi/agent/skills/<name> ~/.pi/agent/skills-archive/`.
- Check for duplicate skill source dirs (e.g. `~/.agents/skills` and `~/.pi/agent/skills`). A skill only leaves the roster when archived from the dir Pi actually discovers it in — archive from all of them.
- Archived skills still run on demand via `/skill:<path>` or `--skill <path>`.

## 3. Subagent context strategy (biggest single lever)

`context: "fork"` inherits the full parent conversation; a long fork re-pays a 100k+ token prefix on nearly every turn (cache efficiency drops to single digits). This produces the most expensive sessions by far.

- Default subagent `context` to `fresh`. Use `fork` only when the task truly needs the evolving parent conversation.
- Feed a fresh subagent exactly what it needs via the `task` field and `reads[]` (file injection), not conversation history.
- For parallelism, use PARALLEL mode with bounded fresh tasks instead of forking N copies of a large context.
- If fork is genuinely needed, `/compact` the parent first to shrink the inherited prefix.
- Add a "Subagents: default fresh" note to the global `AGENTS.md`.

## 4. Cap large tool outputs

Tool results are injected verbatim and persist in context until compaction, so a one-time 100k-char dump becomes recurring overhead.

- `bash`: pipe anything that may exceed ~200 lines through `head`/`rg`/`wc`. Never `cat` a large or generated file; grep for structure or the specific entry.
- `read`: check size (`wc -l`) first, then use `offset`/`limit` for files > ~300 lines. Never read generated files in full.
- Test/build output: capture to `/tmp/<name>.txt`, then `rg` for failures only.
- Prefer diffs (`jj diff --stat`, `jj diff <path>`) over re-reading whole files after edits.
- Encode these as a "Tool output discipline" block in the global `AGENTS.md`.

## 5. Cache warming for idle sessions

Default `cacheWarming: "streaming"` stops warming once the agent settles, so cache expires during human review pauses and the next prompt re-bills the whole prefix.

- Set in `~/.pi/agent/settings.json`:
  ```json
  { "cacheWarming": "idle", "showCacheMissNotices": true }
  ```
- `"idle"` refreshes before expiry when the expected avoided miss cost beats the refresh cost. The notices make real cache-miss rate visible so the change can be verified.

## 6. Reduce tool error rate

Each failed tool call forces a recovery turn at full accumulated-context cost. Common causes: accumulated type errors, wrong `jj` subcommands, sandbox denials, missing tools.

- Add project-specific guards to that project's `AGENTS.md`: narrow/incremental typechecks (check the changed file, not the whole repo; full check once before done), the valid `jj` subcommand set, filesystem boundaries for the sandbox.
- Fail fast in chained bash (`set -e`) so the failing step is obvious.

## 7. Tune compaction for long sessions

Defaults compact only near the context limit (~183k on a 200k window), after many turns have already paid for a bloated context.

- Set in `~/.pi/agent/settings.json`:
  ```json
  { "compaction": { "enabled": true, "reserveTokens": 32768, "keepRecentTokens": 15000 } }
  ```
- Use per-model overrides to compact earlier on pricier models.
- Compact proactively with `/compact <note>` when switching tasks mid-session; split into a fresh session after 2+ auto-compactions or a major task change.

## Verify

- `wc -c` on the global and project `AGENTS.md` before/after to confirm reductions.
- Enable `showCacheMissNotices` and run a few real sessions to confirm fewer misses.
- After pruning skills, confirm the kept ones still trigger and archived ones still run via `/skill:<path>`.
