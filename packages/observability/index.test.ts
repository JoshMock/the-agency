/**
 * Tests for utilities exported from the observability extension.
 */

import assert from 'node:assert/strict'
import { describe, it, afterEach, beforeEach } from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  FileSpanExporter,

  buildSkillContents,
  createTracerProvider,
  extractAssistantText,
  extractToolResults,
  inferSystem,
  stripSkillBlocks,
  stripUndefined,
} from './index.ts'

describe('createTracerProvider', () => {
  let savedEndpoint: string | undefined
  let savedTracesEndpoint: string | undefined

  beforeEach(() => {
    savedEndpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
    savedTracesEndpoint = process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']
    delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
    delete process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']
  })

  afterEach(() => {
    if (savedEndpoint !== undefined) {
      process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = savedEndpoint
    } else {
      delete process.env['OTEL_EXPORTER_OTLP_ENDPOINT']
    }
    if (savedTracesEndpoint !== undefined) {
      process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = savedTracesEndpoint
    } else {
      delete process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']
    }
  })

  it('returns a file sink when no OTLP endpoint env var is set', () => {
    const { provider, sinkLabel } = createTracerProvider()
    assert.ok(provider != null)
    assert.equal(sinkLabel, 'otlp:file')
  })

  it('returns an OTLP sink when OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] = 'http://localhost:4318'
    const { provider, sinkLabel } = createTracerProvider()
    assert.ok(provider != null)
    assert.equal(sinkLabel, 'otlp:localhost:4318')
  })

  it('returns an OTLP sink when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is set', () => {
    process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = 'http://collector:4318'
    const { provider, sinkLabel } = createTracerProvider()
    assert.ok(provider != null)
    assert.equal(sinkLabel, 'otlp:collector:4318')
  })
})

describe('FileSpanExporter', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-obs-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes spans as JSONL to a daily file', () => new Promise<void>((resolve) => {
    const exporter = new FileSpanExporter(tmpDir)
    const fakeSpan = makeFakeSpan('my-span', 'abc123traceId0000000000000000000', 'span0000id000001')

    exporter.export([fakeSpan], (result) => {
      assert.equal(result.code, 0)
      const date = new Date().toISOString().slice(0, 10)
      const file = path.join(tmpDir, `${date}.jsonl`)
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
      assert.equal(lines.length, 1)
      const doc = JSON.parse(lines[0])
      assert.equal(doc.name, 'my-span')
      assert.equal(doc.traceId, 'abc123traceId0000000000000000000')
      assert.equal(doc.spanId, 'span0000id000001')
      assert.ok(typeof doc.startTimeMs === 'number')
      assert.ok(typeof doc.endTimeMs === 'number')
      assert.ok(doc.attributes != null)
      resolve()
    })
  }))

  it('appends multiple export calls to the same daily file', () => new Promise<void>((resolve) => {
    const exporter = new FileSpanExporter(tmpDir)
    const span1 = makeFakeSpan('span-one', 'trace1'.padEnd(32, '0'), 'spanid1'.padEnd(16, '0'))
    const span2 = makeFakeSpan('span-two', 'trace2'.padEnd(32, '0'), 'spanid2'.padEnd(16, '0'))

    exporter.export([span1], () => {
      exporter.export([span2], (result) => {
        assert.equal(result.code, 0)
        const date = new Date().toISOString().slice(0, 10)
        const file = path.join(tmpDir, `${date}.jsonl`)
        const lines = fs.readFileSync(file, 'utf-8').trim().split('\n')
        assert.equal(lines.length, 2)
        assert.equal(JSON.parse(lines[0]).name, 'span-one')
        assert.equal(JSON.parse(lines[1]).name, 'span-two')
        resolve()
      })
    })
  }))

  it('creates the output directory if it does not exist', () => new Promise<void>((resolve) => {
    const nested = path.join(tmpDir, 'deep', 'nested')
    const exporter = new FileSpanExporter(nested)
    const fakeSpan = makeFakeSpan('x', 'a'.repeat(32), 'b'.repeat(16))

    exporter.export([fakeSpan], (result) => {
      assert.equal(result.code, 0)
      assert.ok(fs.existsSync(nested))
      resolve()
    })
  }))
})

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

function makeFakeSpan (name: string, traceId: string, spanId: string): Parameters<FileSpanExporter['export']>[0][number] {
  return {
    name,
    kind: 0,
    spanContext: () => ({ traceId, spanId, traceFlags: 1, isRemote: false }),
    parentSpanContext: undefined,
    startTime: [1700000000, 0] as [number, number],
    endTime: [1700000001, 0] as [number, number],
    duration: [1, 0] as [number, number],
    status: { code: 0 },
    attributes: { 'gen_ai.system': 'anthropic' },
    links: [],
    events: [],
    ended: true,
    resource: { attributes: {} } as unknown as Parameters<FileSpanExporter['export']>[0][number]['resource'],
    instrumentationScope: { name: 'test' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  }
}

describe('buildSkillContents', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-obs-skills-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reads file content for each skill', () => {
    const skillPath = path.join(tmpDir, 'my-skill.md')
    fs.writeFileSync(skillPath, '# My Skill\nDo stuff.')
    const skills = [{ name: 'my-skill', filePath: skillPath }]
    const result = buildSkillContents(skills as Parameters<typeof buildSkillContents>[0])
    assert.equal(result.length, 1)
    assert.equal(result[0].name, 'my-skill')
    assert.equal(result[0].path, skillPath)
    assert.equal(result[0].content, '# My Skill\nDo stuff.')
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(buildSkillContents([]), [])
  })

  it('omits skills whose file cannot be read', () => {
    const skills = [{ name: 'missing', filePath: path.join(tmpDir, 'nonexistent.md') }]
    const result = buildSkillContents(skills as Parameters<typeof buildSkillContents>[0])
    assert.equal(result.length, 0)
  })

  it('reads multiple skills', () => {
    const pathA = path.join(tmpDir, 'a.md')
    const pathB = path.join(tmpDir, 'b.md')
    fs.writeFileSync(pathA, 'skill A content')
    fs.writeFileSync(pathB, 'skill B content')
    const skills = [
      { name: 'skill-a', filePath: pathA },
      { name: 'skill-b', filePath: pathB },
    ]
    const result = buildSkillContents(skills as Parameters<typeof buildSkillContents>[0])
    assert.equal(result.length, 2)
    assert.equal(result[0].name, 'skill-a')
    assert.equal(result[0].content, 'skill A content')
    assert.equal(result[1].name, 'skill-b')
    assert.equal(result[1].content, 'skill B content')
  })
})
