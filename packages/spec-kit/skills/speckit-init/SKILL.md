---
description: Initialize the .specify/ workspace in the current repo by copying the speckit templates into place. Run this once per project before using any other speckit skills.
---

## User Input

```text
$ARGUMENTS
```

## Outline

Set up the `.specify/` workspace for the current repository by copying the speckit templates into place. This is a prerequisite for all other speckit skills.

1. **Locate repo root**:
   ```bash
   git rev-parse --show-toplevel
   ```
   If this fails (not a git repository), abort with:
   > **Error**: Not inside a git repository. Initialize a git repo first (`git init`), then re-run `/speckit-init`.

2. **Check if `.specify/` already exists** at `{repo_root}/.specify/`:
   - If it **does** exist, report:
     > `.specify/` is already initialized at `{repo_root}/.specify/`. Nothing to do.

     List the top-level contents of `.specify/` so the user can confirm what is present.
     Suggest next steps (e.g. `/speckit-specify` to start a new feature).
     **Stop here.**

3. **Copy the templates** into place:
   ```bash
   cp -r "$(dirname SKILL_PATH)/../../specify-templates/." "$(git rev-parse --show-toplevel)/.specify/"
   ```
   Preserve all directory structure and file permissions.

4. **Make scripts executable**:
   ```bash
   chmod +x "$(git rev-parse --show-toplevel)/.specify/scripts/bash/"*.sh
   ```

5. **Verify** the copy succeeded by listing the installed structure:
   ```bash
   find "$(git rev-parse --show-toplevel)/.specify" -type f | sort
   ```

6. **Update `AGENTS.md`** at the repo root with a section describing `.specify/`:
   - Check if `AGENTS.md` exists at `{repo_root}/AGENTS.md`.
   - If it does **not** exist, create it with only the section below.
   - If it **does** exist, append the section below to the end of the file (skip if a `## Spec-Kit` section is already present).
   - The section to add:
     ```markdown
     ## Spec-Kit

     This repository uses the [spec-kit](https://github.com/github/spec-kit) workflow for AI-assisted feature development.
     Spec-kit is a convention for structuring feature specs, plans, and tasks in a `.specify/` directory so that AI agents can read and act on them.
     This project uses an opinionated local tooling layer to generate the artifacts that live there — the source of truth for the workflow itself is the spec-kit repo linked above.

     ### `.specify/` directory

     | Path | Purpose |
     |------|---------|
     | `.specify/templates/` | Markdown templates for specs, plans, tasks, and checklists |
     | `.specify/memory/` | Long-lived context files (e.g. `constitution.md`) read by agents |
     | `.specify/scripts/` | Helper shell scripts for common workflow steps |
     | `.specify/hooks.yml` | CI/automation hook definitions |

     ### How to use it

     - Start a new feature: `/speckit-specify` — creates a spec from a template and opens a clarification loop.
     - Generate a plan: `/speckit-plan` — converts an approved spec into a structured plan.
     - Break into tasks: `/speckit-tasks` — decomposes a plan into trackable tasks.
     - Implement: `/speckit-implement` — works through tasks and updates checklists.
     ```

7. **Report** success:
   - Confirm `.specify/` was created at the repo root.
   - List key installed paths (templates/, memory/, scripts/, hooks.yml).
   - Confirm whether `AGENTS.md` was created or updated.
   - Suggest the next step: `/speckit-constitution` to set up the project constitution, or `/speckit-specify` to jump straight into writing a feature spec.
