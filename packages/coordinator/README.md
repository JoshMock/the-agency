# pi-coordinator

A [Pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) extension that
turns a free-text task description into a **reviewable** [pi-task-tree](../task-tree/)
plan: it asks its clarifying questions first, names the repositories it believes are in
scope (with reasons), and then writes the task tree to `task-tree.yaml` for a human to
read and edit.

It runs nothing. The developer decides when the tree is executed.

## Install

```sh
pi install npm:@the-agency/pi-coordinator
```

## Usage

```
/coordinate add a token-cost report to pi-observability
```

The coordinator replies with the questions whose answers would change the plan, plus the
repositories it thinks are involved and why. Answer them, then it writes `task-tree.yaml`:

```yaml
tasks:
  - name: clarify
    prompt:
      - "Restate the requested change and list the open questions"
  - name: red-tests
    prompt:
      - "Write tests that fail for the right reason"
    depends_on: [clarify]
  - name: plan-review
    pause: true
    message: "Review the plan and the failing tests before implementation starts"
    depends_on: [red-tests]
  - name: implement
    prompt:
      - "Make the failing tests pass"
    depends_on: [plan-review]
  - name: open-pr
    prompt:
      - "Open a pull request with the finished work"
    depends_on: [implement]
```

Then, deliberately:

```sh
pi --task-tree task-tree.yaml
```

## Why it refuses to guess

Two rules are enforced in code rather than asked for in a prompt:

- **No answers, no plan.** The clarification pass produces questions and repo decisions
  only. A task tree is emitted only once the questions have been answered — guessing the
  answers is exactly what wastes a run.
- **A tree must contain a human gate.** `emit_task_tree` rejects any tree with no
  `pause: true` checkpoint. The project's position is that the pipeline stops and asks
  rather than proceeding and reporting, so a tree that can run start-to-finish
  unattended is not an acceptable plan.

Both refusals are covered by tests.

## Commands and tools

### `/coordinate <task>`

Injects the clarification instructions into the session: ask before planning, name the
repositories and reasons, emit no tree yet.

### `emit_task_tree` tool

| Parameter | Type | Description |
|-----------|------|-------------|
| `yaml` | `string` | the pi-task-tree YAML document to write |
| `overwrite` | `boolean` | replace an existing `task-tree.yaml` (default: `false`) |

Validates the document, then writes it. Validation is delegated to `parseTaskTree` from
`@the-agency/pi-task-tree` so the DSL rules — duplicate names, unknown `depends_on`
targets, model and thinking values — are never reimplemented here; the only rule this
package adds is the human gate. An invalid tree is rejected and nothing is written, and an
existing `task-tree.yaml` is never replaced silently.

## API

The prompt builders, response parsers, validator and writer are exported for use outside
the extension:

```ts
import { buildClarifyInstruction, buildPlanInstruction, parseClarifyResponse,
  parseTaskTreeYaml, validateTaskTree, writeTaskTree } from '@the-agency/pi-coordinator'
```

- `buildClarifyInstruction(task: string): string` — the ask-first instructions
- `buildPlanInstruction({ task, answers, repos }): string` — the write-the-tree instructions
- `parseClarifyResponse(raw: string): ClarificationResult` — questions + repo decisions,
  tolerant of fenced JSON, throws `CoordinatorFormatError` on anything else
- `parseTaskTreeYaml(raw: string): string` — pulls the YAML document out of a response
- `validateTaskTree(yaml, { requireGate }): string[]` — errors, empty when acceptable
- `writeTaskTree(yaml, cwd, { overwrite }): Promise<WriteResult>` — validate, then write

## Design notes

- **The coordinator is a conversation, not an engine.** Asking is a session concern, so
  the extension injects instructions and lets the session's own model ask. No second
  model client, no API keys, no orchestration runtime.
- **The plan is an artifact.** `task-tree.yaml` is edited like any other file, and the
  human gate is a `pause: true` node rather than an approval prompt inside a runner.
- **`pi-task-tree` and its dependencies are imported from the workspace** rather than
  from a published version, because `pi-task-tree`'s `main` points at a `dist/` build and
  the packages here are consumed as TypeScript source. Worth revisiting when
  `pi-task-tree` is published.

## Testing

```sh
npm test
```

Tests cover the prompt builders, both parsers, the validator (including that its output
agrees with the real `parseTaskTree` on a well-formed tree), the writer's refusal to
clobber, and the extension's registration, `/coordinate` injection and `emit_task_tree`
behaviour.

## License

MIT
