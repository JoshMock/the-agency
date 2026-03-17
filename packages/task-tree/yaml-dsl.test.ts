import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseTaskTree,
  parseModelSpec,
  type LeafTaskSpec,
  type TaskSpecFactory,
  type PauseHandler,
} from './yaml-dsl.ts'

const mockAgent = { provider: 'mock' }

/** factory that records which specs were invoked and resolves immediately */
function trackingFactory (log: LeafTaskSpec[]): TaskSpecFactory {
  return (spec) => async () => { log.push(spec) }
}

/** factory that returns a delayed task for concurrency tests */
function delayFactory (delay: number): TaskSpecFactory {
  return () => async () => new Promise(resolve => setTimeout(resolve, delay))
}

/** minimal factory — just a no-op */
const noop: TaskSpecFactory = () => async () => {}

describe('parseTaskTree', () => {
  it('runs a flat list of independent tasks', async () => {
    const ran: string[] = []
    const factory: TaskSpecFactory = (spec) => async () => { ran.push(spec.name) }

    const manager = parseTaskTree(`
tasks:
  - name: a
    prompt: ["Task A"]
  - name: b
    prompt: ["Task B"]
`, factory)

    await manager.runAll(mockAgent)
    assert.equal(ran.length, 2)
    assert.ok(ran.includes('a'))
    assert.ok(ran.includes('b'))
  })

  it('passes prompt, model (string), and thinking to the factory', async () => {
    const captured: LeafTaskSpec[] = []

    const manager = parseTaskTree(`
tasks:
  - name: t
    prompt: ["Do the thing"]
    model: anthropic/claude-opus-4-5
    thinking: high
`, trackingFactory(captured))

    await manager.runAll(mockAgent)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].name, 't')
    assert.deepEqual(captured[0].prompt, ['Do the thing'])
    assert.deepEqual(captured[0].model, { provider: 'anthropic', name: 'claude-opus-4-5' })
    assert.equal(captured[0].thinking, 'high')
  })

  it('passes a multi-string prompt array to the factory', async () => {
    const captured: LeafTaskSpec[] = []

    const manager = parseTaskTree(`
tasks:
  - name: t
    prompt:
      - "First instruction"
      - "Second instruction"
      - "Third instruction"
`, trackingFactory(captured))

    await manager.runAll(mockAgent)
    assert.deepEqual(captured[0].prompt, ['First instruction', 'Second instruction', 'Third instruction'])
  })

  it('passes model object {provider, name} to the factory', async () => {
    const captured: LeafTaskSpec[] = []

    const manager = parseTaskTree(`
tasks:
  - name: t
    prompt: ["Do the thing"]
    model:
      provider: openai
      name: gpt-4o
`, trackingFactory(captured))

    await manager.runAll(mockAgent)
    assert.deepEqual(captured[0].model, { provider: 'openai', name: 'gpt-4o' })
  })

  it('sub-tasks auto depend on their parent', async () => {
    const order: string[] = []
    const factory: TaskSpecFactory = (spec) => async () => { order.push(spec.name) }

    const manager = parseTaskTree(`
tasks:
  - name: parent
    prompt: ["Parent task"]
    tasks:
      - name: child
        prompt: ["Child task"]
`, factory)

    await manager.runAll(mockAgent)
    assert.equal(order[0], 'parent')
    assert.equal(order[1], 'child')
  })

  it('honours explicit depends_on between siblings', async () => {
    const order: string[] = []
    const factory: TaskSpecFactory = (spec) => async () => { order.push(spec.name) }

    const manager = parseTaskTree(`
tasks:
  - name: fetch
    prompt: ["Fetch data"]
  - name: process
    prompt: ["Process data"]
    depends_on: [fetch]
  - name: report
    prompt: ["Report"]
    depends_on: [process]
`, factory)

    await manager.runAll(mockAgent)
    assert.deepEqual(order, ['fetch', 'process', 'report'])
  })

  it('combines parent dependency with explicit depends_on', async () => {
    const order: string[] = []
    const factory: TaskSpecFactory = (spec) => async () => { order.push(spec.name) }

    // child depends on parent (implicit) AND sibling (explicit)
    const manager = parseTaskTree(`
tasks:
  - name: a
    prompt: ["A"]
  - name: b
    prompt: ["B"]
    tasks:
      - name: c
        prompt: ["C"]
        depends_on: [a]
`, factory)

    await manager.runAll(mockAgent)
    // c must come after both a and b
    assert.ok(order.indexOf('c') > order.indexOf('a'), 'c must run after a')
    assert.ok(order.indexOf('c') > order.indexOf('b'), 'c must run after b')
  })

  it('deduplicates dep when parent is also listed in depends_on', async () => {
    const order: string[] = []
    const factory: TaskSpecFactory = (spec) => async () => { order.push(spec.name) }

    const manager = parseTaskTree(`
tasks:
  - name: parent
    prompt: ["Parent"]
    tasks:
      - name: child
        prompt: ["Child"]
        depends_on: [parent]
`, factory)

    await manager.runAll(mockAgent)
    assert.equal(order[0], 'parent')
    assert.equal(order[1], 'child')
  })

  it('runs deeply nested sub-tasks in order', async () => {
    const order: string[] = []
    const factory: TaskSpecFactory = (spec) => async () => { order.push(spec.name) }

    const manager = parseTaskTree(`
tasks:
  - name: l1
    prompt: ["Level 1"]
    tasks:
      - name: l2
        prompt: ["Level 2"]
        tasks:
          - name: l3
            prompt: ["Level 3"]
`, factory)

    await manager.runAll(mockAgent)
    assert.deepEqual(order, ['l1', 'l2', 'l3'])
  })

  it('runs independent tasks concurrently', async () => {
    const DELAY = 50
    const manager = parseTaskTree(`
tasks:
  - name: x
    prompt: ["X"]
  - name: y
    prompt: ["Y"]
  - name: z
    prompt: ["Z"]
`, delayFactory(DELAY))

    const t0 = Date.now()
    await manager.runAll(mockAgent)
    const elapsed = Date.now() - t0

    // should finish in ~DELAY, not DELAY*3
    assert.ok(elapsed < DELAY * 2, `elapsed ${elapsed}ms — tasks may not be concurrent`)
  })

  describe('validation errors', () => {
    it('throws on non-object YAML', () => {
      assert.throws(
        () => parseTaskTree('just a string', noop),
        /must be an object/
      )
    })

    it('throws when top-level tasks key is missing', () => {
      assert.throws(
        () => parseTaskTree('name: foo', noop),
        /top-level "tasks" array/
      )
    })

    it('throws on duplicate task names', () => {
      assert.throws(
        () => parseTaskTree(`
tasks:
  - name: a
    prompt: ["A"]
  - name: a
    prompt: ["A again"]
`, noop),
        /duplicate task name: "a"/
      )
    })

    it('throws on unknown depends_on reference', () => {
      assert.throws(
        () => parseTaskTree(`
tasks:
  - name: a
    prompt: ["A"]
    depends_on: [nope]
`, noop),
        /depends_on unknown task "nope"/
      )
    })

    it('throws on model string without a slash', () => {
      assert.throws(
        () => parseTaskTree(`
tasks:
  - name: a
    prompt: ["A"]
    model: claude-opus-4-5
`, noop),
        /model must be a "provider\/name" string or \{provider, name\} object/
      )
    })

    it('throws on model string with leading slash', () => {
      assert.throws(
        () => parseTaskTree(`
tasks:
  - name: a
    prompt: ["A"]
    model: /claude-opus-4-5
`, noop),
        /model must be/
      )
    })

    it('throws on model string with trailing slash', () => {
      assert.throws(
        () => parseTaskTree(`
tasks:
  - name: a
    prompt: ["A"]
    model: anthropic/
`, noop),
        /model must be/
      )
    })

    it('throws on model string with multiple slashes', () => {
      assert.throws(
        () => parseTaskTree(`
tasks:
  - name: a
    prompt: ["A"]
    model: a/b/c
`, noop),
        /model must be/
      )
    })
  })
})

describe('parseModelSpec', () => {
  it('parses a "provider/name" string', () => {
    assert.deepEqual(
      parseModelSpec('anthropic/claude-opus-4-5'),
      { provider: 'anthropic', name: 'claude-opus-4-5' }
    )
  })

  it('passes through an object unchanged', () => {
    const spec = { provider: 'openai', name: 'gpt-4o' }
    assert.deepEqual(parseModelSpec(spec), spec)
  })

  it('throws on a plain string with no slash', () => {
    assert.throws(() => parseModelSpec('claude-opus-4-5'), /provider\/name/)
  })

  it('throws on a string with a leading slash', () => {
    assert.throws(() => parseModelSpec('/name'), /provider\/name/)
  })

  it('throws on a string with a trailing slash', () => {
    assert.throws(() => parseModelSpec('provider/'), /provider\/name/)
  })

  it('throws on a string with multiple slashes', () => {
    assert.throws(() => parseModelSpec('a/b/c'), /provider\/name/)
  })
})

describe('pause tasks', () => {
  it('calls onPause with name and message, then unblocks downstream tasks', async () => {
    const paused: Array<{ name: string; message?: string }> = []
    const order: string[] = []
    const factory: TaskSpecFactory = (spec) => async () => { order.push(spec.name) }
    const onPause: PauseHandler = async (ctx) => {
      paused.push(ctx)
      order.push(`pause:${ctx.name}`)
    }

    const manager = parseTaskTree(`
tasks:
  - name: before
    prompt: ["Before"]
  - name: gate
    pause: true
    message: "Review before continuing"
    depends_on: [before]
  - name: after
    prompt: ["After"]
    depends_on: [gate]
`, factory, { onPause })

    await manager.runAll(mockAgent)
    assert.equal(order.indexOf('before') < order.indexOf('pause:gate'), true, 'gate must run after before')
    assert.equal(order.indexOf('pause:gate') < order.indexOf('after'), true, 'after must run after gate')
    assert.deepEqual(paused, [{ name: 'gate', message: 'Review before continuing' }])
  })

  it('pause without message passes undefined as message', async () => {
    const paused: Array<{ name: string; message?: string }> = []
    const onPause: PauseHandler = async (ctx) => { paused.push(ctx) }

    const manager = parseTaskTree(`
tasks:
  - name: gate
    pause: true
`, noop, { onPause })

    await manager.runAll(mockAgent)
    assert.deepEqual(paused, [{ name: 'gate', message: undefined }])
  })

  it('pause node acts as a dependency barrier for multiple downstream tasks', async () => {
    const order: string[] = []
    const factory: TaskSpecFactory = (spec) => async () => { order.push(spec.name) }
    const onPause: PauseHandler = async (ctx) => { order.push(`pause:${ctx.name}`) }

    const manager = parseTaskTree(`
tasks:
  - name: before
    prompt: ["Before"]
  - name: gate
    pause: true
    depends_on: [before]
  - name: after1
    prompt: ["After 1"]
    depends_on: [gate]
  - name: after2
    prompt: ["After 2"]
    depends_on: [gate]
`, factory, { onPause })

    await manager.runAll(mockAgent)
    assert.ok(order.indexOf('before') < order.indexOf('pause:gate'), 'gate after before')
    assert.ok(order.indexOf('pause:gate') < order.indexOf('after1'), 'after1 after gate')
    assert.ok(order.indexOf('pause:gate') < order.indexOf('after2'), 'after2 after gate')
  })

  it('throws at parse time if no onPause handler is provided for a pause task', () => {
    assert.throws(
      () => parseTaskTree(`
tasks:
  - name: gate
    pause: true
`, noop),
      /pause checkpoint.*onPause/
    )
  })

  it('pause task can depend on sibling tasks via depends_on', async () => {
    const order: string[] = []
    const factory: TaskSpecFactory = (spec) => async () => { order.push(spec.name) }
    const onPause: PauseHandler = async () => { order.push('gate') }

    const manager = parseTaskTree(`
tasks:
  - name: a
    prompt: ["A"]
  - name: b
    prompt: ["B"]
  - name: gate
    pause: true
    depends_on: [a, b]
  - name: c
    prompt: ["C"]
    depends_on: [gate]
`, factory, { onPause })

    await manager.runAll(mockAgent)
    assert.ok(order.indexOf('gate') > order.indexOf('a'), 'gate after a')
    assert.ok(order.indexOf('gate') > order.indexOf('b'), 'gate after b')
    assert.ok(order.indexOf('c') > order.indexOf('gate'), 'c after gate')
  })
})
