import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import initExtension, { TOOL_NAME, EVENT_NAME } from './index.ts'

type ToolDef = {
  name: string
  label: string
  description: string
  promptSnippet?: string
  promptGuidelines?: string[]
  parameters: unknown
  execute: (toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<{
    content: Array<{ type: string; text: string }>
    details: Record<string, unknown>
  }>
}

function createMockPi () {
  const tools: Record<string, ToolDef> = {}
  const emitted: Array<{ event: string; data: unknown }> = []

  return {
    pi: {
      registerTool (def: ToolDef) {
        tools[def.name] = def
      },
      events: {
        emit (event: string, data: unknown) {
          emitted.push({ event, data })
        },
      },
    },
    tools,
    emitted,
  }
}

async function execTool (tools: Record<string, ToolDef>, value: unknown) {
  return tools[TOOL_NAME].execute('call-1', { value }, null, null, null)
}

describe('return-type extension', () => {
  it('registers the return_result tool', () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    assert.ok(tools[TOOL_NAME], `expected tool "${TOOL_NAME}" to be registered`)
  })

  it('tool has a non-empty label, description, promptSnippet, and promptGuidelines', () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    const tool = tools[TOOL_NAME]
    assert.ok(tool.label.length > 0)
    assert.ok(tool.description.length > 0)
    assert.ok(tool.promptSnippet && tool.promptSnippet.length > 0)
    assert.ok(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0)
  })

  it('registers exactly one tool', () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    assert.equal(Object.keys(tools).length, 1)
  })

  it('execute returns value serialised as JSON in content', async () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    const result = await execTool(tools, { answer: 42 })
    assert.equal(result.content[0].type, 'text')
    assert.equal(result.content[0].text, JSON.stringify({ answer: 42 }))
  })

  it('execute includes value in details', async () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    const result = await execTool(tools, { answer: 42 })
    assert.deepEqual(result.details.value, { answer: 42 })
  })

  it('execute emits the return_type:result event with value', async () => {
    const { pi, tools, emitted } = createMockPi()
    initExtension(pi as any)
    await execTool(tools, { answer: 42 })
    assert.equal(emitted.length, 1)
    assert.equal(emitted[0].event, EVENT_NAME)
    assert.deepEqual(emitted[0].data, { value: { answer: 42 } })
  })

  it('handles an object value', async () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    const value = { name: 'Alice', scores: [1, 2, 3] }
    const result = await execTool(tools, value)
    assert.deepEqual(JSON.parse(result.content[0].text), value)
    assert.deepEqual(result.details.value, value)
  })

  it('handles an array value', async () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    const value = [1, 'two', true, null]
    const result = await execTool(tools, value)
    assert.deepEqual(JSON.parse(result.content[0].text), value)
    assert.deepEqual(result.details.value, value)
  })

  it('handles a string value', async () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    const result = await execTool(tools, 'hello world')
    assert.equal(JSON.parse(result.content[0].text), 'hello world')
    assert.equal(result.details.value, 'hello world')
  })

  it('handles a number value', async () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    const result = await execTool(tools, 3.14)
    assert.equal(JSON.parse(result.content[0].text), 3.14)
    assert.equal(result.details.value, 3.14)
  })

  it('handles a boolean value', async () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    const result = await execTool(tools, false)
    assert.equal(JSON.parse(result.content[0].text), false)
    assert.equal(result.details.value, false)
  })

  it('handles a null value', async () => {
    const { pi, tools } = createMockPi()
    initExtension(pi as any)
    const result = await execTool(tools, null)
    assert.equal(JSON.parse(result.content[0].text), null)
    assert.equal(result.details.value, null)
  })

  it('emits a separate event for each call', async () => {
    const { pi, tools, emitted } = createMockPi()
    initExtension(pi as any)
    await execTool(tools, 1)
    await execTool(tools, 2)
    assert.equal(emitted.length, 2)
    assert.deepEqual((emitted[0].data as any).value, 1)
    assert.deepEqual((emitted[1].data as any).value, 2)
  })
})
