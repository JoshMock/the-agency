/**
 * Tests for utilities extracted from the observability extension.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileJsonlExporter } from './file-exporter.ts'

import {
  buildLoggerProvider,
  extractAssistantText,
  extractToolResults,
  inferSystem,
  stripSkillBlocks,
  stripUndefined,
} from './index.ts'

/** Returns a unique temp file path for a test. */
function tempPath (prefix = 'obs-test'): string {
  return join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}.jsonl`)
}

describe('stripSkillBlocks', () => {
  it('returns plain text unchanged', () => {
    assert.equal(stripSkillBlocks('hello world'), 'hello world')
  })

  it('strips a paired skill block', () => {
    const input = '<skill name="foo">\nYou must always do this.\n</skill>\ndo the thing'
    assert.equal(stripSkillBlocks(input).trim(), 'do the thing')
  })

  it('strips a self-closing annotation tag on its own line', () => {
    const input = '<available_skills/>\nyou should update the README'
    assert.equal(stripSkillBlocks(input).trim(), 'you should update the README')
  })

  it('strips multiple annotation blocks', () => {
    const input = [
      '<skill name="a">\nmust always\n</skill>',
      'real instruction',
      '<skill name="b">\nnever skip\n</skill>',
    ].join('\n')
    assert.equal(stripSkillBlocks(input).trim(), 'real instruction')
  })

  it('strips blocks with kebab-case tag names', () => {
    const input = '<available-skills>\nmust do this\n</available-skills>\nactual text'
    assert.equal(stripSkillBlocks(input).trim(), 'actual text')
  })

  it('strips blocks with underscore tag names', () => {
    const input = '<context_block>\nmust always\n</context_block>\nactual text'
    assert.equal(stripSkillBlocks(input).trim(), 'actual text')
  })

  it('preserves user text when annotation appears first', () => {
    const input = '<skill name="speckit">\nYou must always use the tool.\n</skill>\nimplement feature X'
    assert.equal(stripSkillBlocks(input).trim(), 'implement feature X')
  })

  it('does not strip inline self-closing tags within prose', () => {
    const input = '<skill name="foo">\nskip this\n</skill>\nuse <MyComponent /> in the JSX'
    const result = stripSkillBlocks(input)
    assert.ok(result.includes('<MyComponent />'), 'inline JSX tag should be preserved')
  })

  it('returns empty string when entire content is one skill block', () => {
    const input = '<skill name="x">\nsome instructions\n</skill>'
    assert.equal(stripSkillBlocks(input).trim(), '')
  })

  it('strips blocks with attributes on the opening tag', () => {
    const input = '<skill name="foo" location="/path/to/SKILL.md">\ncontent\n</skill>\nuser text'
    assert.equal(stripSkillBlocks(input).trim(), 'user text')
  })
})

describe('inferSystem', () => {
  it('maps known providers directly', () => {
    assert.equal(inferSystem('anthropic', 'claude-sonnet'), 'anthropic')
    assert.equal(inferSystem('openai', 'gpt-4'), 'openai')
    assert.equal(inferSystem('google', 'gemini-pro'), 'google_ai_studio')
  })

  it('maps github-copilot to openai for gpt/o-series models', () => {
    assert.equal(inferSystem('github-copilot', 'gpt-4'), 'openai')
    assert.equal(inferSystem('github-copilot', 'o1-mini'), 'openai')
    assert.equal(inferSystem('github-copilot', 'o3-preview'), 'openai')
  })

  it('maps github-copilot to anthropic for claude models', () => {
    assert.equal(inferSystem('github-copilot', 'claude-sonnet-4'), 'anthropic')
  })

  it('falls back to model name when provider is unrecognized', () => {
    assert.equal(inferSystem('unknown', 'claude-xyz'), 'anthropic')
    assert.equal(inferSystem('unknown', 'gpt-xyz'), 'openai')
    assert.equal(inferSystem('unknown', 'gemini-xyz'), 'google_ai_studio')
  })

  it('returns provider name for unrecognized combinations', () => {
    assert.equal(inferSystem('custom', 'custom-model'), 'custom')
  })

  it('returns unknown when nothing matches', () => {
    assert.equal(inferSystem('', ''), 'unknown')
  })
})

describe('stripUndefined', () => {
  it('removes undefined keys while preserving null and other values', () => {
    const obj: Record<string, unknown> = { a: 1, b: undefined, c: null, d: 'str', e: false }
    stripUndefined(obj)
    assert.deepEqual(Object.keys(obj).sort(), ['a', 'c', 'd', 'e'])
    assert.equal(obj.a, 1)
    assert.equal(obj.c, null)
    assert.equal(obj.d, 'str')
    assert.equal(obj.e, false)
  })

  it('handles an empty object', () => {
    const obj: Record<string, unknown> = {}
    stripUndefined(obj)
    assert.deepEqual(obj, {})
  })

  it('handles an object with only undefined values', () => {
    const obj: Record<string, unknown> = { a: undefined, b: undefined }
    stripUndefined(obj)
    assert.deepEqual(obj, {})
  })
})

describe('extractAssistantText', () => {
  it('extracts plain text blocks', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello world' }],
    } as unknown as Parameters<typeof extractAssistantText>[0]
    const result = extractAssistantText(msg)
    assert.equal(result.text, 'hello world')
    assert.equal(result.thinking, undefined)
    assert.deepEqual(result.toolCalls, [])
  })

  it('joins multiple text blocks with double newline', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    } as unknown as Parameters<typeof extractAssistantText>[0]
    const result = extractAssistantText(msg)
    assert.equal(result.text, 'first\n\nsecond')
  })

  it('extracts thinking blocks', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'let me think...' },
        { type: 'text', text: 'done' },
      ],
    } as unknown as Parameters<typeof extractAssistantText>[0]
    const result = extractAssistantText(msg)
    assert.equal(result.thinking, 'let me think...')
    assert.equal(result.text, 'done')
  })

  it('extracts tool calls', () => {
    const msg = {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'tc-1',
          name: 'read_file',
          arguments: { path: 'index.ts' },
        },
      ],
    } as unknown as Parameters<typeof extractAssistantText>[0]
    const result = extractAssistantText(msg)
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].id, 'tc-1')
    assert.equal(result.toolCalls[0].name, 'read_file')
    assert.deepEqual(result.toolCalls[0].arguments, { path: 'index.ts' })
    assert.equal(result.toolCalls[0].arguments_text, '{"path":"index.ts"}')
  })

  it('skips empty text and thinking blocks', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: '  ' },
        { type: 'thinking', thinking: '' },
        { type: 'text', text: 'real' },
      ],
    } as unknown as Parameters<typeof extractAssistantText>[0]
    const result = extractAssistantText(msg)
    assert.equal(result.text, 'real')
    assert.equal(result.thinking, undefined)
  })
})

describe('extractToolResults', () => {
  it('extracts text from tool results', () => {
    const results = [
      {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'file contents' }],
      },
    ] as unknown as Parameters<typeof extractToolResults>[0]
    const extracted = extractToolResults(results)
    assert.equal(extracted.length, 1)
    assert.equal(extracted[0].tool_call_id, 'tc-1')
    assert.equal(extracted[0].tool_name, 'read')
    assert.equal(extracted[0].output, 'file contents')
  })

  it('joins multiple text parts with newline', () => {
    const results = [
      {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
      },
    ] as unknown as Parameters<typeof extractToolResults>[0]
    const extracted = extractToolResults(results)
    assert.equal(extracted[0].output, 'line 1\nline 2')
  })

  it('returns empty output when no text content', () => {
    const results = [
      {
        role: 'toolResult',
        toolCallId: 'tc-1',
        toolName: 'read',
        content: [],
      },
    ] as unknown as Parameters<typeof extractToolResults>[0]
    const extracted = extractToolResults(results)
    assert.equal(extracted[0].output, '')
  })
})

describe('FileJsonlExporter', () => {
  it('writes attributes as JSONL and calls resultCallback with code 0', () => {
    const path = tempPath('file-exporter-test')
    try {
      const exporter = new FileJsonlExporter(path)
      const records = [
        { attributes: { 'span.name': 'turn_1', model: 'claude' } },
        { attributes: { 'span.name': 'turn_2', model: 'gpt-4' } },
      ] as any[]
      let callbackResult: { code: number; error?: Error } | undefined
      exporter.export(records, (r) => { callbackResult = r })
      assert.equal(callbackResult?.code, 0)
      const lines = readFileSync(path, 'utf8').trim().split('\n')
      assert.equal(lines.length, 2)
      assert.deepEqual(JSON.parse(lines[0]), { 'span.name': 'turn_1', model: 'claude' })
      assert.deepEqual(JSON.parse(lines[1]), { 'span.name': 'turn_2', model: 'gpt-4' })
    } finally {
      if (existsSync(path)) unlinkSync(path)
    }
  })

  it('creates the parent directory if it does not exist', () => {
    const dir = join(tmpdir(), `obs-test-${Math.random().toString(36).slice(2)}`)
    const path = join(dir, 'out.jsonl')
    try {
      const exporter = new FileJsonlExporter(path)
      exporter.export([{ attributes: { a: 1 } }] as any[], () => {})
      assert.ok(existsSync(path))
    } finally {
      if (existsSync(path)) unlinkSync(path)
    }
  })

  it('calls resultCallback with code 1 on a write failure', () => {
    const dir = join(tmpdir(), `obs-ro-${Math.random().toString(36).slice(2)}`)
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o444)
    const path = join(dir, 'out.jsonl')
    const exporter = new FileJsonlExporter(path)
    let callbackResult: { code: number; error?: Error } | undefined
    exporter.export([{ attributes: { x: 1 } }] as any[], (r) => { callbackResult = r })
    assert.equal(callbackResult?.code, 1)
    assert.ok(callbackResult?.error instanceof Error)
  })

  it('shutdown resolves without error', async () => {
    const path = tempPath('file-exporter-test')
    const exporter = new FileJsonlExporter(path)
    await assert.doesNotReject(() => exporter.shutdown())
  })
})

describe('buildLoggerProvider', () => {
  it('writes a log record to the file after shutdown', async () => {
    const path = tempPath('obs-provider-test')
    try {
      const { provider, logger } = buildLoggerProvider(path)
      logger.emit({ body: 'test', attributes: { 'span.name': 'gen_ai chat claude', foo: 'bar' } })
      await provider.shutdown()
      assert.ok(existsSync(path), 'output file should exist')
      const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
      assert.equal(lines.length, 1)
      const doc = JSON.parse(lines[0])
      assert.equal(doc['span.name'], 'gen_ai chat claude')
      assert.equal(doc.foo, 'bar')
    } finally {
      if (existsSync(path)) unlinkSync(path)
    }
  })

  it('calls onResult with file sink and true after a successful export', async () => {
    const path = tempPath('obs-provider-test')
    const results: Array<{ sink: string; success: boolean }> = []
    try {
      const { provider, logger } = buildLoggerProvider(path, (sink, success) => {
        results.push({ sink, success })
      })
      logger.emit({ body: 'test', attributes: { x: 1 } })
      await provider.shutdown()
      assert.ok(results.length >= 1)
      assert.equal(results[0].sink, 'file')
      assert.equal(results[0].success, true)
    } finally {
      if (existsSync(path)) unlinkSync(path)
    }
  })
})
