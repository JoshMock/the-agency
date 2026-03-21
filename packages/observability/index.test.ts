/**
 * Tests for the AsyncJSONLWriter and record aggregation logic used by the
 * observability extension.  We test the writer and aggregation in isolation
 * without needing a live Pi process.
 */

import assert from 'node:assert/strict'
import { test, describe, beforeEach, afterEach } from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'

// ─── Inline AsyncJSONLWriter (copy to avoid importing the full extension) ─────

class AsyncJSONLWriter {
  queue: string[] = []
  private draining = false
  private fd: number | null = null
  private filePath: string | null = null

  open(filePath: string): void {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    this.fd = fs.openSync(filePath, 'a')
    this.filePath = filePath
  }

  write(record: object): void {
    try {
      this.queue.push(JSON.stringify(record) + '\n')
      if (!this.draining) this.scheduleDrain()
    } catch { /* ignore */ }
  }

  async flush(): Promise<void> {
    if (this.queue.length === 0) return
    await new Promise<void>((resolve) => {
      const check = () => {
        if (this.queue.length === 0) resolve()
        else setImmediate(check)
      }
      setImmediate(check)
    })
  }

  close(): void {
    if (this.fd !== null) {
      try { fs.closeSync(this.fd) } catch { /* ignore */ }
      this.fd = null
    }
  }

  getFilePath(): string | null { return this.filePath }

  private scheduleDrain(): void {
    if (this.draining || this.fd === null) return
    this.draining = true
    setImmediate(() => this.drainLoop())
  }

  private drainLoop(): void {
    if (this.fd === null) { this.draining = false; return }
    const batch = this.queue.splice(0, 100).join('')
    if (!batch) { this.draining = false; return }
    try { fs.writeSync(this.fd, batch) } catch { /* ignore */ }
    if (this.queue.length > 0) setImmediate(() => this.drainLoop())
    else this.draining = false
  }
}

// ─── Aggregation logic (mirrors extension) ───────────────────────────────────

interface ToolCallRecord { type: 'tool_call'; toolName: string; isError: boolean; durationMs: number; sessionId: string }
interface TurnEndRecord { type: 'turn_end'; tokensIn: number | null; tokensOut: number | null; durationMs: number; sessionId: string }
interface ModelChangeRecord { type: 'model_change'; provider: string; model: string; sessionId: string }
interface SessionTagsRecord { type: 'session_tags'; tags: string[]; sessionId: string }
type Record_ = ToolCallRecord | TurnEndRecord | ModelChangeRecord | SessionTagsRecord | { type: string; sessionId: string }

function aggregate(records: Record_[]) {
  const toolCalls: Record<string, number> = {}
  const toolErrors: Record<string, number> = {}
  const toolDurations: Record<string, number[]> = {}
  const modelsUsed = new Set<string>()
  const sessions = new Set<string>()
  const turnDurations: number[] = []
  let totalIn = 0
  let totalOut = 0
  let turnCount = 0
  let tags: string[] = []

  for (const r of records) {
    sessions.add(r.sessionId)
    if (r.type === 'tool_call') {
      const tc = r as ToolCallRecord
      toolCalls[tc.toolName] = (toolCalls[tc.toolName] ?? 0) + 1
      if (tc.isError) toolErrors[tc.toolName] = (toolErrors[tc.toolName] ?? 0) + 1
      ;(toolDurations[tc.toolName] ??= []).push(tc.durationMs)
    }
    if (r.type === 'model_change') {
      const mc = r as ModelChangeRecord
      modelsUsed.add(`${mc.provider}/${mc.model}`)
    }
    if (r.type === 'turn_end') {
      const te = r as TurnEndRecord
      turnCount++
      totalIn += te.tokensIn ?? 0
      totalOut += te.tokensOut ?? 0
      turnDurations.push(te.durationMs)
    }
    if (r.type === 'session_tags') tags = (r as SessionTagsRecord).tags
  }

  const avg = (arr: number[]) =>
    arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0

  return {
    sessions: sessions.size,
    turns: turnCount,
    totalTokensIn: totalIn,
    totalTokensOut: totalOut,
    avgTurnDurationMs: avg(turnDurations),
    modelsUsed: [...modelsUsed],
    tags,
    toolStats: Object.entries(toolCalls)
      .sort(([, a], [, b]) => b - a)
      .map(([name, calls]) => ({
        tool: name,
        calls,
        errors: toolErrors[name] ?? 0,
        avgDurationMs: avg(toolDurations[name] ?? []),
      })),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AsyncJSONLWriter', () => {
  let tmpFile: string

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `obs-test-${crypto.randomUUID()}.jsonl`)
  })

  afterEach(() => {
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
  })

  test('creates the file on open', () => {
    const w = new AsyncJSONLWriter()
    w.open(tmpFile)
    w.close()
    assert.ok(fs.existsSync(tmpFile), 'file should be created')
  })

  test('writes records as valid JSONL after flush', async () => {
    const w = new AsyncJSONLWriter()
    w.open(tmpFile)
    w.write({ type: 'session_start', '@timestamp': '2025-01-01T00:00:00Z' })
    w.write({ type: 'turn_start', turnIndex: 0 })
    await w.flush()
    w.close()

    const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0]!) as { type: string }
    assert.equal(first.type, 'session_start')
  })

  test('appends to an existing file', async () => {
    const w1 = new AsyncJSONLWriter()
    w1.open(tmpFile)
    w1.write({ type: 'session_start' })
    await w1.flush()
    w1.close()

    const w2 = new AsyncJSONLWriter()
    w2.open(tmpFile)
    w2.write({ type: 'turn_start' })
    await w2.flush()
    w2.close()

    const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
  })

  test('getFilePath returns the opened path', () => {
    const w = new AsyncJSONLWriter()
    assert.equal(w.getFilePath(), null)
    w.open(tmpFile)
    assert.equal(w.getFilePath(), tmpFile)
    w.close()
  })

  test('writes many records without losing any', async () => {
    const w = new AsyncJSONLWriter()
    w.open(tmpFile)
    const count = 200
    for (let i = 0; i < count; i++) w.write({ type: 'tool_call', i })
    await w.flush()
    w.close()
    const lines = fs.readFileSync(tmpFile, 'utf8').trim().split('\n')
    assert.equal(lines.length, count)
  })

  test('flush resolves immediately when queue is empty', async () => {
    const w = new AsyncJSONLWriter()
    w.open(tmpFile)
    await assert.doesNotReject(w.flush())
    w.close()
  })
})

describe('aggregate', () => {
  const sid = 'session-1'

  test('counts tool calls and errors', () => {
    const records: Record_[] = [
      { type: 'tool_call', toolName: 'bash', isError: false, durationMs: 100, sessionId: sid },
      { type: 'tool_call', toolName: 'bash', isError: true,  durationMs: 50,  sessionId: sid },
      { type: 'tool_call', toolName: 'read', isError: false, durationMs: 10,  sessionId: sid },
    ]
    const result = aggregate(records)
    const bash = result.toolStats.find((t) => t.tool === 'bash')!
    assert.equal(bash.calls, 2)
    assert.equal(bash.errors, 1)
    const read = result.toolStats.find((t) => t.tool === 'read')!
    assert.equal(read.calls, 1)
    assert.equal(read.errors, 0)
  })

  test('sorts toolStats by call count descending', () => {
    const records: Record_[] = [
      { type: 'tool_call', toolName: 'read', isError: false, durationMs: 10, sessionId: sid },
      { type: 'tool_call', toolName: 'bash', isError: false, durationMs: 10, sessionId: sid },
      { type: 'tool_call', toolName: 'bash', isError: false, durationMs: 10, sessionId: sid },
    ]
    const result = aggregate(records)
    assert.equal(result.toolStats[0]!.tool, 'bash')
    assert.equal(result.toolStats[1]!.tool, 'read')
  })

  test('calculates average tool duration', () => {
    const records: Record_[] = [
      { type: 'tool_call', toolName: 'bash', isError: false, durationMs: 100, sessionId: sid },
      { type: 'tool_call', toolName: 'bash', isError: false, durationMs: 200, sessionId: sid },
    ]
    const result = aggregate(records)
    assert.equal(result.toolStats[0]!.avgDurationMs, 150)
  })

  test('sums token counts from turn_end records', () => {
    const records: Record_[] = [
      { type: 'turn_end', tokensIn: 100, tokensOut: 50,  durationMs: 1000, sessionId: sid },
      { type: 'turn_end', tokensIn: 200, tokensOut: 100, durationMs: 2000, sessionId: sid },
    ]
    const result = aggregate(records)
    assert.equal(result.totalTokensIn, 300)
    assert.equal(result.totalTokensOut, 150)
    assert.equal(result.turns, 2)
  })

  test('handles null token values', () => {
    const records: Record_[] = [
      { type: 'turn_end', tokensIn: null, tokensOut: null, durationMs: 500, sessionId: sid },
    ]
    const result = aggregate(records)
    assert.equal(result.totalTokensIn, 0)
    assert.equal(result.totalTokensOut, 0)
  })

  test('calculates average turn duration', () => {
    const records: Record_[] = [
      { type: 'turn_end', tokensIn: 0, tokensOut: 0, durationMs: 1000, sessionId: sid },
      { type: 'turn_end', tokensIn: 0, tokensOut: 0, durationMs: 3000, sessionId: sid },
    ]
    const result = aggregate(records)
    assert.equal(result.avgTurnDurationMs, 2000)
  })

  test('collects unique models used', () => {
    const records: Record_[] = [
      { type: 'model_change', provider: 'anthropic', model: 'claude-sonnet-4-5', sessionId: sid },
      { type: 'model_change', provider: 'google',    model: 'gemini-2.5-pro',    sessionId: sid },
      { type: 'model_change', provider: 'anthropic', model: 'claude-sonnet-4-5', sessionId: sid },
    ]
    const result = aggregate(records)
    assert.equal(result.modelsUsed.length, 2)
    assert.ok(result.modelsUsed.includes('anthropic/claude-sonnet-4-5'))
    assert.ok(result.modelsUsed.includes('google/gemini-2.5-pro'))
  })

  test('captures session_tags', () => {
    const records: Record_[] = [
      { type: 'session_tags', tags: ['typescript', 'feature', 'pi-extension'], sessionId: sid },
    ]
    const result = aggregate(records)
    assert.deepEqual(result.tags, ['typescript', 'feature', 'pi-extension'])
  })

  test('counts unique sessions', () => {
    const records: Record_[] = [
      { type: 'session_start', sessionId: 'a' } as Record_,
      { type: 'session_start', sessionId: 'b' } as Record_,
      { type: 'turn_end', tokensIn: 0, tokensOut: 0, durationMs: 100, sessionId: 'a' },
    ]
    const result = aggregate(records)
    assert.equal(result.sessions, 2)
  })

  test('returns zero avgTurnDurationMs when no turns', () => {
    const result = aggregate([])
    assert.equal(result.avgTurnDurationMs, 0)
  })
})
