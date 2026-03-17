/** execution state of a {@link TaskNode} */

type TaskStatus = 'pending' | 'done' | 'failed'

/** opaque handle passed through to every task function — typically a Pi `AgentSession` or a factory that creates one */

export type AgentContext = unknown

/** async work unit: receives an {@link AgentContext} and returns an arbitrary result */

export type TaskFunc = (agent: AgentContext) => Promise<unknown>

/**
 * a single node in a task dependency graph.
 *
 * each node wraps an async function, tracks its own execution state, and
 * holds references to any nodes that must complete before it can run.
 */
export class TaskNode {
  name: string
  func: TaskFunc
  deps: TaskNode[]
  status: TaskStatus
  result: unknown

  /**
   * @param name - unique identifier used by {@link TaskManager} to track the node
   * @param func - the async work to perform; receives the agent context passed to {@link TaskNode.run}
   * @param deps - nodes that must finish before this node starts (default: `[]`)
   */
  constructor (name: string, func: TaskFunc, deps: TaskNode[] = []) {
    this.name = name
    this.func = func
    this.deps = deps
    this.status = 'pending'
    this.result = null
  }

  /**
   * execute this node's function.
   *
   * waits for all {@link TaskNode.deps} to reach a terminal state first, then
   * invokes {@link TaskNode.func}. sets `status` to `'done'` on success or
   * `'failed'` on error (re-throwing the error either way).
   *
   * @param agent - context forwarded to the task function
   * @returns the value resolved by the task function
   */
  async run (agent: AgentContext): Promise<any> {
    await Promise.all(this.deps.map(dep => dep.waitUntilDone()))

    try {
      this.result = await this.func(agent)
      this.status = 'done'
    } catch (err) {
      this.status = 'failed'
      this.result = err
      throw err
    }

    return this.result
  }

  /**
   * poll until this node leaves the `'pending'` state.
   *
   * resolves with `result` once status is `'done'` or `'failed'`. used
   * internally by dependent nodes in {@link TaskNode.run}.
   *
   * @returns the node's `result` (return value or thrown error)
   */
  async waitUntilDone (): Promise<any> {
    while (this.status === 'pending') await new Promise(resolve => setTimeout(resolve, 100))
    return this.result
  }
}

/**
 * collects {@link TaskNode}s and executes them as a DAG.
 *
 * call {@link TaskManager.addTask} for every node, then
 * {@link TaskManager.runAll} to run them. independent tasks execute
 * concurrently; dependent tasks wait until all their deps are done.
 */
export class TaskManager {
  tasks: Map<string, TaskNode>

  constructor () {
    this.tasks = new Map()
  }

  /**
   * register a task node with the manager.
   *
   * @param taskNode - the node to register; its `name` must be unique
   */
  addTask (taskNode: TaskNode): void {
    this.tasks.set(taskNode.name, taskNode)
  }

  /**
   * topologically sort all registered tasks and execute them.
   *
   * uses Kahn's algorithm to group tasks into waves: all tasks in a wave
   * have no unmet dependencies and run concurrently via `Promise.all`.
   * each completed wave unlocks the next. throws immediately if any task
   * throws.
   *
   * @param agent - forwarded to every {@link TaskNode.run} call
   */
  async runAll (agent?: AgentContext): Promise<void> {
    // Kahn's algorithm: build in-degree map and reverse adjacency list
    const inDegree = new Map<string, number>()
    const dependents = new Map<string, TaskNode[]>()

    for (const task of this.tasks.values()) {
      if (!inDegree.has(task.name)) inDegree.set(task.name, 0)
      for (const dep of task.deps) {
        if (!inDegree.has(dep.name)) inDegree.set(dep.name, 0)
        inDegree.set(task.name, (inDegree.get(task.name) ?? 0) + 1)
        if (!dependents.has(dep.name)) dependents.set(dep.name, [])
        dependents.get(dep.name)!.push(task)
      }
    }

    // start with tasks that have no dependencies
    let wave = [...this.tasks.values()].filter(t => inDegree.get(t.name) === 0)

    while (wave.length > 0) {
      await Promise.all(wave.map(task => task.run(agent)))

      const nextWave: TaskNode[] = []
      for (const task of wave) {
        for (const dependent of (dependents.get(task.name) ?? [])) {
          const remaining = (inDegree.get(dependent.name) ?? 0) - 1
          inDegree.set(dependent.name, remaining)
          if (remaining === 0) nextWave.push(dependent)
        }
      }
      wave = nextWave
    }
  }
}

export { parseTaskTree, type TaskSpec, type TaskSpecFactory, type ThinkingLevel } from './yaml-dsl.ts'

/**
 * called when a {@link PauseNode} is reached during execution.
 *
 * receives the pause task's name and optional human-readable message.
 * the returned promise must resolve before downstream tasks are allowed to run.
 */
export type PauseHandler = (context: { name: string; message?: string }) => Promise<void>

/**
 * a checkpoint node that halts downstream execution until a human approves.
 *
 * when reached during {@link TaskManager.runAll}, this node calls the supplied
 * {@link PauseHandler} and waits for it to resolve before unblocking its dependents.
 * use it to inject review gates between phases of a task tree.
 */
export class PauseNode extends TaskNode {
  /** optional human-readable description shown to the reviewer */
  message: string | undefined

  /**
   * @param name    - unique identifier (same rules as {@link TaskNode})
   * @param handler - async callback invoked when this node runs; resolves to approve
   * @param message - optional description of what to review
   * @param deps    - nodes that must finish before this checkpoint runs
   */
  constructor (
    name: string,
    handler: PauseHandler,
    message?: string,
    deps: TaskNode[] = [],
  ) {
    super(name, () => handler({ name, message }), deps)
    this.message = message
  }
}
