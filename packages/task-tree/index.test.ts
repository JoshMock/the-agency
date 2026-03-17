import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { TaskNode, TaskManager, PauseNode } from './index.ts'

const mockAgent = { provider: 'mock', model: 'noop' }

describe('TaskNode', () => {
  it('runs its function and sets status to done', async () => {
    const node = new TaskNode('a', async () => 42)
    await node.run(mockAgent)
    assert.equal(node.status, 'done')
    assert.equal(node.result, 42)
  })

  it('sets status to failed and rethrows on error', async () => {
    const err = new Error('boom')
    const node = new TaskNode('a', async () => { throw err })
    await assert.rejects(() => node.run(mockAgent), err)
    assert.equal(node.status, 'failed')
    assert.equal(node.result, err)
  })

  it('passes the agent context through to the task function', async () => {
    let received: unknown
    const node = new TaskNode('a', async (agent) => { received = agent })
    await node.run(mockAgent)
    assert.equal(received, mockAgent)
  })

  it('waits for deps before running', async () => {
    const order: string[] = []
    const dep = new TaskNode('dep', async () => { order.push('dep') })
    const child = new TaskNode('child', async () => { order.push('child') }, [dep])

    await dep.run(mockAgent)
    await child.run(mockAgent)

    assert.deepEqual(order, ['dep', 'child'])
  })

  it('waitUntilDone resolves immediately when already done', async () => {
    const node = new TaskNode('a', async () => 'result')
    await node.run(mockAgent)
    const val = await node.waitUntilDone()
    assert.equal(val, 'result')
  })
})

describe('TaskManager', () => {
  it('runs a single task', async () => {
    const manager = new TaskManager()
    let ran = false
    manager.addTask(new TaskNode('a', async () => { ran = true }))
    await manager.runAll(mockAgent)
    assert.equal(ran, true)
  })

  it('runs independent tasks', async () => {
    const manager = new TaskManager()
    const ran: string[] = []
    manager.addTask(new TaskNode('a', async () => { ran.push('a') }))
    manager.addTask(new TaskNode('b', async () => { ran.push('b') }))
    await manager.runAll(mockAgent)
    assert.equal(ran.length, 2)
    assert.ok(ran.includes('a'))
    assert.ok(ran.includes('b'))
  })

  it('runs tasks in dependency order', async () => {
    const manager = new TaskManager()
    const order: string[] = []

    const a = new TaskNode('a', async () => { order.push('a') })
    const b = new TaskNode('b', async () => { order.push('b') }, [a])
    const c = new TaskNode('c', async () => { order.push('c') }, [b])

    manager.addTask(a)
    manager.addTask(b)
    manager.addTask(c)
    await manager.runAll(mockAgent)

    assert.deepEqual(order, ['a', 'b', 'c'])
  })

  it('runs tasks with multiple deps only after all deps complete', async () => {
    const manager = new TaskManager()
    const order: string[] = []

    const a = new TaskNode('a', async () => { order.push('a') })
    const b = new TaskNode('b', async () => { order.push('b') })
    const c = new TaskNode('c', async () => { order.push('c') }, [a, b])

    manager.addTask(a)
    manager.addTask(b)
    manager.addTask(c)
    await manager.runAll(mockAgent)

    assert.ok(order.indexOf('c') > order.indexOf('a'), 'c must run after a')
    assert.ok(order.indexOf('c') > order.indexOf('b'), 'c must run after b')
  })

  it('runs diamond dependency graph correctly', async () => {
    const manager = new TaskManager()
    const order: string[] = []

    //   a
    //  / \
    // b   c
    //  \ /
    //   d
    const a = new TaskNode('a', async () => { order.push('a') })
    const b = new TaskNode('b', async () => { order.push('b') }, [a])
    const c = new TaskNode('c', async () => { order.push('c') }, [a])
    const d = new TaskNode('d', async () => { order.push('d') }, [b, c])

    manager.addTask(a)
    manager.addTask(b)
    manager.addTask(c)
    manager.addTask(d)
    await manager.runAll(mockAgent)

    assert.equal(order[0], 'a')
    assert.equal(order[3], 'd')
    assert.ok(order.includes('b'))
    assert.ok(order.includes('c'))
  })

  it('passes results between tasks via agent context', async () => {
    const manager = new TaskManager()
    const results: Record<string, unknown> = {}

    const scrape = new TaskNode('scrape', async () => {
      results.scrape = 'raw data'
      return 'raw data'
    })
    const summarize = new TaskNode('summarize', async () => {
      results.summarize = `summary of: ${results.scrape}`
      return results.summarize
    }, [scrape])

    manager.addTask(scrape)
    manager.addTask(summarize)
    await manager.runAll(mockAgent)

    assert.equal(summarize.result, 'summary of: raw data')
  })

  it('runs parallel tasks concurrently (not sequentially)', async () => {
    const manager = new TaskManager()
    const DELAY = 50
    const started: number[] = []

    const makeDelayedTask = (name: string) =>
      new TaskNode(name, async () => {
        started.push(Date.now())
        await new Promise(resolve => setTimeout(resolve, DELAY))
      })

    manager.addTask(makeDelayedTask('a'))
    manager.addTask(makeDelayedTask('b'))
    manager.addTask(makeDelayedTask('c'))

    const t0 = Date.now()
    await manager.runAll(mockAgent)
    const elapsed = Date.now() - t0

    // all 3 started within a small window of each other (not DELAY*3)
    const spread = Math.max(...started) - Math.min(...started)
    assert.ok(spread < DELAY, `tasks started ${spread}ms apart, expected < ${DELAY}ms`)
    // total time should be close to one DELAY, not three
    assert.ok(elapsed < DELAY * 2, `total elapsed ${elapsed}ms, expected < ${DELAY * 2}ms`)
  })

  it('works with no tasks', async () => {
    const manager = new TaskManager()
    await assert.doesNotReject(() => manager.runAll(mockAgent))
  })

  it('propagates task failures', async () => {
    const manager = new TaskManager()
    manager.addTask(new TaskNode('bad', async () => { throw new Error('fail') }))
    await assert.rejects(() => manager.runAll(mockAgent), /fail/)
  })
})

describe('PauseNode', () => {
  it('calls the handler with name and message, then sets status to done', async () => {
    const calls: Array<{ name: string; message?: string }> = []
    const node = new PauseNode('gate', async (ctx) => { calls.push(ctx) }, 'please review')
    await node.run(mockAgent)
    assert.equal(node.status, 'done')
    assert.deepEqual(calls, [{ name: 'gate', message: 'please review' }])
  })

  it('works without a message', async () => {
    const calls: Array<{ name: string; message?: string }> = []
    const node = new PauseNode('gate', async (ctx) => { calls.push(ctx) })
    await node.run(mockAgent)
    assert.deepEqual(calls, [{ name: 'gate', message: undefined }])
  })

  it('blocks dependent tasks until the handler resolves', async () => {
    let resolveGate!: () => void
    const gatePromise = new Promise<void>(resolve => { resolveGate = resolve })
    const order: string[] = []

    const gate = new PauseNode('gate', async () => {
      await gatePromise
      order.push('gate')
    })
    const after = new TaskNode('after', async () => { order.push('after') }, [gate])

    const manager = new TaskManager()
    manager.addTask(gate)
    manager.addTask(after)

    const runPromise = manager.runAll(mockAgent)
    // give the event loop a tick — 'after' must not have run yet
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(order, [], 'after should not run before gate resolves')

    resolveGate()
    await runPromise
    assert.deepEqual(order, ['gate', 'after'])
  })

  it('sets status to failed and rethrows when handler throws', async () => {
    const err = new Error('rejected')
    const node = new PauseNode('gate', async () => { throw err })
    await assert.rejects(() => node.run(mockAgent), err)
    assert.equal(node.status, 'failed')
  })
})
