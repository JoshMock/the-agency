# @the-agency/pi-spec-kit

A [Pi](https://github.com/mariozechner/pi-coding-agent) package that integrates GitHub's [Spec Kit](https://github.com/github/spec-kit) in a Pi-native way, to support a spec-driven development workflow for planning and building features in a software repository.

## Overview

This extension provides a set of slash commands, meant to be executed mostly in order, that guide you through a repeatable feature development lifecycle, from writing specs, generating implementation tasks and then executing implementation tasks. Configuration and templates live in a `.specify/` directory at your repo root, while feature artifacts (specs, plans, tasks) are stored in a `specs/` directory — both are version-controllable and shareable with your team.

## Installation

```bash
pi install @the-agency/pi-spec-kit
```

## Workflow

The typical flow for a new feature:

```sh
# one-time setup per repo
/speckit-init

# write the spec for a new feature
/speckit-specify

# analyze the spec and resolve any ambiguities
/speckit-clarify

# create the technical plan
/speckit-plan

# break the plan down into tasks
/speckit-tasks

# consistency check before coding
/speckit-analyze

# execute the tasks
/speckit-implement
```

## Commands

Read the [Spec Kit README](https://github.com/github/spec-kit) for a more detailed introduction to the workflow.

### `/speckit-init`

Initialize the `.specify/` workspace in the current repository. Must be run once before using any other command.

### `/speckit-constitution <project description>`

Create or update the project constitution at `.specify/memory/constitution.md`. The constitution defines project-level principles that all specs and plans must respect.

### `/speckit-checklist <domain>`

Generate a domain-specific requirements-quality checklist. Validates completeness, clarity, and consistency of requirements rather than checking implementation.

### `/speckit-specify <feature description>`

Create or update a feature specification from a plain-language description. No technical implementation details yet. Generates a feature branch and a `spec.md` from the built-in spec template.

### `/speckit-clarify`

Analyze the current `spec.md` for ambiguities and ask targeted clarification questions. Encodes your answers directly back into the spec. Run this before `/speckit-plan` to reduce downstream rework.

### `/speckit-plan <technical implementation details>`

Generate a technical implementation plan (`plan.md`) from the current feature spec. Produces supporting design artifacts (data models, API contracts, quickstart guide) and validates against the project constitution.

### `/speckit-tasks`

Break down the `plan.md` into a dependency-ordered `tasks.md` ready for implementation.

### `/speckit-analyze`

Perform a read-only cross-artifact analysis of `spec.md`, `plan.md`, and `tasks.md` to surface inconsistencies, duplications, and constitution violations before you start coding.

### `/speckit-implement`

Execute the implementation plan by working through all tasks defined in `tasks.md`.

### `/speckit-taskstoissues`

Convert the tasks in `tasks.md` into GitHub Issues on the repository's remote. Requires the GitHub MCP server tool.

## Artifacts

Configuration and templates are stored under `.specify/`. Feature artifacts are stored under `specs/`:

| Path | Description |
|---|---|
| `.specify/memory/constitution.md` | Project principles that govern all specs |
| `.specify/scripts/bash/` | Helper scripts used by the skills |
| `.specify/templates/` | Source templates for all artifacts |
| `specs/<branch>/plan.md` | Technical implementation plan |
| `specs/<branch>/spec.md` | Feature specification |
| `specs/<branch>/tasks.md` | Ordered implementation tasks |

## Hooks

`.specify/hooks.yml` lets you customize the shell-level operations that the workflow scripts perform at key points. It ships with three built-in hooks:

All hooks are optional. If `hooks.yml` is missing entirely, or a hook has no commands defined, the scripts silently skip it and continue.

| Hook | When it runs | Default command |
|---|---|---|
| `fetch_remotes` | Before auto-numbering a new feature branch | `git fetch --all --prune` |
| `list_branches` | To enumerate existing branches for auto-numbering | `git branch -a` |
| `create_branch` | After a new feature is initialized | `git checkout -b "{{branch_name}}"` |

Each hook is a named list of shell commands. Use `{{variable_name}}` in a command string to interpolate values passed by the calling script (e.g. `{{branch_name}}` is replaced with the computed branch name like `003-user-auth`).

```yaml
hooks:
  # Fetch remotes before auto-numbering a new branch.
  fetch_remotes:
    - git fetch --all --prune

  # List branches for auto-numbering.
  list_branches:
    - git branch -a

  # Create the feature branch.
  create_branch:
    - git checkout -b "{{branch_name}}"
    - git push -u origin "{{branch_name}}"  # optional: push immediately
```

To add extra steps, append more commands under the relevant hook. To disable a hook, remove or comment out its commands.

## License

MIT
