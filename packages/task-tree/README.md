# pi-task-tree

Tree-based task orchestration in a single Node.js process for [Pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) agent swarms.

[DAG](https://en.wikipedia.org/wiki/Directed_acyclic_graph)-based task orchestration for [Pi](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) agent swarms. Define tasks as nodes in a tree and `pi-task-tree` will execute them in the right order, running independent tasks in parallel. To keep things simple and prevent this turning into a Kubernetes competitor, all orchestration happens within a single Node process.

While targeted at Pi agents, all agent instantiation is handled externally, so this could easily be applied to many other single-process orchestration use cases.

## Installation

```bash
npm install @the-agency/pi-task-tree
```

## Concepts

- `TaskNode`: a named unit of work. It holds an async function, a list of dependency nodes, and tracks its own `status` (`pending` | `done` | `failed`) and `result`.
- `TaskManager`: collects `TaskNode`s and runs them via `runAll()`, which topologically sorts the graph and executes independent tasks concurrently.
- `parseTaskTree`: parses a YAML document into a ready-to-run `TaskManager`, so you can define task graphs declaratively instead of in code.

## YAML DSL

`parseTaskTree` lets you describe a task graph in YAML and receive a configured `TaskManager` back. You supply a factory function that converts each task's spec (prompt, model, thinking level) into the actual async work — keeping the parser decoupled from how agents are invoked.

### DSL format

```yaml
tasks:
  - name: fetch
    prompt:                           # array of strings
      - "Retrieve the dataset"
      - "Focus on structured formats"
    model: anthropic/claude-opus-4-5  # optional — "provider/name" string
    thinking: medium             # optional — none | low | medium | high
    tasks:                       # optional sub-tasks; auto-depend on their parent
      - name: clean
        prompt:
          - "Clean the data"
      - name: summarize
        prompt:
          - "Summarize the clean data"
        depends_on: [clean]      # cross-sibling explicit dependency
  - name: report
    prompt:
      - "Write a final report"
    depends_on: [summarize]      # depends_on uses global task names
```

#### Dependency rules

- If two tasks are siblings, they will run concurrently unless `depends_on` is explicitly set.
- Sub-tasks implicitly depend on their parent — they start only after the parent finishes.
- `depends_on` adds explicit dependencies by name (global scope, any nesting depth).
- Both are deduplicated, so listing a parent in `depends_on` is harmless.

### Usage

```typescript
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from '@mariozechner/pi-coding-agent'
import { parseTaskTree, type TaskSpecFactory } from '@the-agency/pi-task-tree'

const authStorage = AuthStorage.create()
const modelRegistry = new ModelRegistry(authStorage)
const sessionManager = SessionManager.inMemory()

const factory = (spec) => async () => {
  const model = modelRegistry.find(spec.model.provider, spec.model.name)

  const { session } = await createAgentSession({
    sessionManager,
    authStorage,
    modelRegistry,
    model
  })

  const mode = new InteractiveMode(session, {
    initialMessage: spec.prompt
  })
  await mode.run()
}

const manager = parseTaskTree(yamlString, factory)
await manager.runAll()

Independent tasks (and sub-tasks of different parents) execute concurrently; tasks with dependencies wait until all their deps are done.

### Validation

`parseTaskTree` throws synchronously for:
- Non-object YAML or a missing top-level `tasks` array
- Duplicate task names
- `depends_on` entries that reference an unknown task name
- `model` values that are not a `"provider/name"` string or a `{provider, name}` object
## Programmatic API

You can also build task graphs directly in code, which gives you full control over how results flow between tasks.

The example below spins up three specialised Pi agents to research, write, and review a blog post. The `research` agent runs first, `writer` and `reviewer` both depend on it, and `publisher` waits for both.

```typescript
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from '@mariozechner/pi-coding-agent'
import { TaskNode, TaskManager } from '@the-agency/pi-task-tree'

// AgentContext can be anything — here it's a factory that creates Pi sessions
type AgentFactory = () => ReturnType<typeof createAgentSession>

async function makeSession () {
  const authStorage = AuthStorage.create()
  const modelRegistry = new ModelRegistry(authStorage)
  return createAgentSession({
    sessionManager: SessionManager.inMemory(),
    authStorage,
    modelRegistry,
  })
}

// collect text from session events
async function prompt (session: Awaited<ReturnType<typeof createAgentSession>>['session'], text: string): Promise<string> {
  let output = ''
  const unsub = session.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      output += event.assistantMessageEvent.delta
    }
  })
  await session.prompt(text)
  unsub()
  return output
}

// shared results store — tasks read from and write to this
const shared: Record<string, string> = {}

const research = new TaskNode('research', async (makeAgent: AgentFactory) => {
  const { session } = await makeAgent()
  shared.research = await prompt(session, 'Research the current state of WebAssembly in 2025. Return key findings as bullet points.')
  session.dispose()
})

const write = new TaskNode('write', async (makeAgent: AgentFactory) => {
  const { session } = await makeAgent()
  shared.draft = await prompt(session, `Write a 400-word blog post based on these findings:\n\n${shared.research}`)
  session.dispose()
}, [research])

const review = new TaskNode('review', async (makeAgent: AgentFactory) => {
  const { session } = await makeAgent()
  shared.feedback = await prompt(session, `Review this draft for clarity and accuracy:\n\n${shared.draft}`)
  session.dispose()
}, [research])

const publish = new TaskNode('publish', async (makeAgent: AgentFactory) => {
  const { session } = await makeAgent()
  shared.final = await prompt(session,
    `Apply this reviewer feedback to produce the final post.\n\nDraft:\n${shared.draft}\n\nFeedback:\n${shared.feedback}`
  )
  session.dispose()
  console.log('Final post:\n', shared.final)
}, [write, review])

const manager = new TaskManager()
manager.addTask(research)
manager.addTask(write)
manager.addTask(review)
manager.addTask(publish)

// execution graph:
//   research
//   ├── write ──┐
//   └── review ─┴── publish
await manager.runAll(makeSession)
```

`write` and `review` execute in parallel once `research` finishes. `publish` only starts when both are done.

## API reference

### `parseTaskTree(yamlString, factory)`

| param | type | description |
|-------|------|-------------|
| `yamlString` | `string` | YAML source conforming to the DSL format above |
| `factory` | `TaskSpecFactory` | converts a leaf spec into a `TaskFunc` |

Returns a `TaskManager` with all nodes registered and dependencies wired. Call `runAll()` to execute.

`TaskSpecFactory` signature:

```typescript
type TaskSpecFactory = (
  spec: { name: string; prompt: string[]; model?: ModelSpec; thinking?: ThinkingLevel }
) => (agent: AgentContext) => Promise<unknown>
```

where `ModelSpec` is `{ provider: string; name: string }` — always fully resolved from the raw YAML value.

When a `model` is specified in YAML as either a `"provider/name"` string or a `{provider, name}` object,
`parseTaskTree` normalises it to a `ModelSpec` before passing it to the factory. Use
`modelRegistry.find(spec.model.provider, spec.model.name)` to obtain the Pi model object.

**`parseModelSpec(raw: string | ModelSpec): ModelSpec`** — exported utility that normalises a raw model
value to a `ModelSpec`. Throws if a string does not contain exactly one `/` with non-empty parts on both sides.

`ThinkingLevel`: `'none' | 'low' | 'medium' | 'high'`

### `new TaskNode(name, func, deps?)`

| param | type | description |
|-------|------|-------------|
| `name` | `string` | unique identifier |
| `func` | `(agent: AgentContext) => Promise<unknown>` | the work to perform |
| `deps` | `TaskNode[]` | nodes that must complete before this one runs (default: `[]`) |

Properties: `status` (`'pending' | 'done' | 'failed'`), `result` (return value or thrown error).

### `new TaskManager()`

#### `addTask(node: TaskNode): void`

Register a task. Call this for every node before `runAll`.

#### `runAll(agent?: AgentContext): Promise<void>`

Topologically sort all registered tasks and execute them, running independent tasks concurrently. Throws if any task throws.

## License

MIT
