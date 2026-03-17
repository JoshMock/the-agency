import { parse } from 'yaml'

import { type TaskFunc, TaskManager, TaskNode, PauseNode, type PauseHandler } from './index.ts'

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high'

/** parsed provider/name pair used to look up a model via ModelRegistry */
export interface ModelSpec {
  provider: string
  name: string
}

/** a regular (agent-driven) task entry in the YAML DSL */
export interface RegularTaskSpec {
  name: string
  prompt: string[]
  /** provider/name string ("anthropic/claude-opus-4-5") or {provider, name} object */
  model?: string | ModelSpec
  thinking?: ThinkingLevel
  /** sub-tasks that automatically depend on this task */
  tasks?: TaskSpec[]
  /** explicit dependencies on other tasks by name */
  depends_on?: string[]
  pause?: false
}

/**
 * a pause/checkpoint task entry in the YAML DSL.
 *
 * when reached during execution, halts all downstream tasks until the
 * `onPause` handler supplied to {@link parseTaskTree} resolves.
 */
export interface PauseTaskSpec {
  name: string
  pause: true
  /** optional human-readable description of what to review */
  message?: string
  /** explicit dependencies on other tasks by name */
  depends_on?: string[]
  tasks?: TaskSpec[]
}

/** a single task entry in the YAML DSL — either a regular task or a pause checkpoint */
export type TaskSpec = RegularTaskSpec | PauseTaskSpec

/** top-level shape of a task tree YAML document */
interface TaskTreeDoc {
  tasks: TaskSpec[]
}

/**
 * normalises a raw model value from YAML into a {@link ModelSpec}.
 *
 * accepts either a `"provider/name"` string or a `{provider, name}` object.
 * throws if the string does not contain exactly one `/` with non-empty parts.
 */
export function parseModelSpec (raw: string | ModelSpec): ModelSpec {
  if (typeof raw !== 'string') return raw
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1 || raw.indexOf('/', slash + 1) !== -1) {
    throw new Error(
      `model must be a "provider/name" string or {provider, name} object, got: "${raw}"`
    )
  }
  return { provider: raw.slice(0, slash), name: raw.slice(slash + 1) }
}

/** the leaf spec passed to {@link TaskSpecFactory} — model is always a resolved {@link ModelSpec} */
export interface LeafTaskSpec {
  name: string
  prompt: string[]
  model?: ModelSpec
  thinking?: ThinkingLevel
}

/**
 * converts a leaf {@link TaskSpec} (no `tasks` or `depends_on`) into a
 * {@link TaskFunc}. called once per task during {@link parseTaskTree}.
 *
 * the `model` field, if present, is always a resolved {@link ModelSpec} —
 * use `modelRegistry.find(spec.model.provider, spec.model.name)` to obtain
 * the Pi model object.
 */
export type TaskSpecFactory = (spec: LeafTaskSpec) => TaskFunc

/** options for {@link parseTaskTree} */
export interface ParseTaskTreeOptions {
  /**
   * called whenever a pause checkpoint is reached during execution.
   *
   * the returned promise must resolve before any downstream tasks are allowed
   * to run. if omitted and the task tree contains a pause node, `parseTaskTree`
   * throws synchronously.
   */
  onPause?: PauseHandler
}

// ─── internal helpers ────────────────────────────────────────────────────────

interface FlatEntry {
  spec: TaskSpec
  parentName: string | undefined
}

function flattenSpecs (specs: TaskSpec[], parentName?: string): FlatEntry[] {
  const result: FlatEntry[] = []
  for (const spec of specs) {
    result.push({ spec, parentName })
    if (spec.tasks?.length) {
      result.push(...flattenSpecs(spec.tasks, spec.name))
    }
  }
  return result
}

function validateDoc (doc: unknown): asserts doc is TaskTreeDoc {
  if (doc == null || typeof doc !== 'object') {
    throw new Error('YAML document must be an object')
  }
  const { tasks } = doc as Record<string, unknown>
  if (!Array.isArray(tasks)) {
    throw new Error('YAML document must have a top-level "tasks" array')
  }
}

function isPauseSpec (spec: TaskSpec): spec is PauseTaskSpec {
  return (spec as PauseTaskSpec).pause === true
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * parse a YAML string into a ready-to-run {@link TaskManager}.
 *
 * ## DSL shape
 * ```yaml
 * tasks:
 *   - name: fetch
 *     prompt:
 *       - "Retrieve the dataset"
 *       - "Focus on structured formats"
 *     model: anthropic/claude-opus-4-5   # "provider/name" string
 *     thinking: medium
 *     tasks:                      # sub-tasks auto-depend on their parent
 *       - name: clean
 *         prompt:
 *           - "Clean the data"
 *       - name: summarize
 *         prompt:
 *           - "Summarize the clean data"
 *         depends_on: [clean]     # cross-sibling dependency
 *   - name: review-checkpoint
 *     pause: true                 # halts execution until onPause resolves
 *     message: "Review the cleaned data before reporting"
 *     depends_on: [summarize]
 *   - name: report
 *     prompt:
 *       - "Write a report"
 *     depends_on: [review-checkpoint]
 * ```
 *
 * ### dependency rules
 * - sub-tasks implicitly depend on their parent task
 * - `depends_on` lists additional dependencies by name (global scope)
 * - duplicate task names and references to unknown names are errors
 *
 * @param yamlString - raw YAML source
 * @param factory    - converts a leaf spec into the async {@link TaskFunc} that
 *                     will be executed at runtime
 * @param options    - optional config; supply `onPause` to handle pause checkpoints
 */
export function parseTaskTree (
  yamlString: string,
  factory: TaskSpecFactory,
  options: ParseTaskTreeOptions = {}
): TaskManager {
  const doc = parse(yamlString) as unknown
  validateDoc(doc)

  const flat = flattenSpecs(doc.tasks)

  // validate unique names
  const seen = new Set<string>()
  for (const { spec } of flat) {
    if (seen.has(spec.name)) {
      throw new Error(`duplicate task name: "${spec.name}"`)
    }
    seen.add(spec.name)
  }

  const allNames = seen

  // validate depends_on references
  for (const { spec } of flat) {
    for (const dep of spec.depends_on ?? []) {
      if (!allNames.has(dep)) {
        throw new Error(
          `task "${spec.name}" depends_on unknown task "${dep}"`
        )
      }
    }
  }

  // validate that pause nodes have an onPause handler
  for (const { spec } of flat) {
    if (isPauseSpec(spec) && options.onPause == null) {
      throw new Error(
        `task "${spec.name}" is a pause checkpoint but no onPause handler was provided to parseTaskTree`
      )
    }
  }

  // validate model specs
  for (const { spec } of flat) {
    if (isPauseSpec(spec)) continue
    const s = spec as RegularTaskSpec
    if (s.model == null) continue
    try {
      parseModelSpec(s.model)
    } catch {
      throw new Error(
        `task "${spec.name}": model must be a "provider/name" string or {provider, name} object`
      )
    }
  }

  // first pass: create all nodes (deps wired in second pass)
  const nodeMap = new Map<string, TaskNode>()
  for (const { spec } of flat) {
    if (isPauseSpec(spec)) {
      nodeMap.set(spec.name, new PauseNode(spec.name, options.onPause!, spec.message))
    } else {
      const rs = spec as RegularTaskSpec
      const { tasks: _tasks, depends_on: _deps, model, pause: _pause, ...rest } = rs as RegularTaskSpec & { pause?: false }
      const leafSpec: LeafTaskSpec = {
        ...rest,
        ...(model != null ? { model: parseModelSpec(model) } : {}),
      }
      nodeMap.set(spec.name, new TaskNode(spec.name, factory(leafSpec)))
    }
  }

  // second pass: wire dependencies
  for (const { spec, parentName } of flat) {
    const node = nodeMap.get(spec.name)!
    // use a set to deduplicate (e.g. if parent is also listed in depends_on)
    const depNames = new Set<string>(spec.depends_on ?? [])
    if (parentName != null) depNames.add(parentName)
    node.deps = [...depNames].map(n => nodeMap.get(n)!)
  }

  const manager = new TaskManager()
  for (const node of nodeMap.values()) {
    manager.addTask(node)
  }
  return manager
}
