/**
 * Pi Observability Extension
 *
 * Records a JSONL timeseries of tool calls, agent turns, model changes, token
 * usage, and session lifecycle to ~/.pi/observability/<date>-<sessionId>.jsonl.
 * Each record is written asynchronously so it never blocks the session.
 *
 * The extension also exposes:
 *   - /observe           – show current output file and session stats
 *   - /observe tags      – trigger AI tagging for the current session now
 *   - observe_analyze    – tool the LLM can call to build per-session analysis
 *                          from any JSONL file
 *
 * JSONL record types (all include @timestamp, sessionId, sessionFile, cwd):
 *   session_start   – fired once when the session opens
 *   session_end     – fired on shutdown with aggregate totals
 *   turn_start      – fired at the start of each LLM turn
 *   turn_end        – fired at the end of each LLM turn with token counts
 *   tool_call       – fired for every tool execution with duration + error flag
 *   model_change    – fired when the active model changes
 *   command         – fired when user runs a /command
 *   session_tags    – AI-generated tags for the session (async, best-effort)
 */

import { complete } from '@mariozechner/pi-ai'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ─── Record types ─────────────────────────────────────────────────────────────

/** Fields present on every JSONL record. */
interface BaseRecord {
  /** Discriminator. */
  type: string
  /** ISO-8601 timestamp when the record was emitted. */
  '@timestamp': string
  /** Unique ID for this Pi session.  Stable across /reload; changes on /new. */
  sessionId: string
  /** Absolute path to the .pi session file, or null for ephemeral sessions. */
  sessionFile: string | null
  /** Working directory at the time of the event. */
  cwd: string
}

interface SessionStartRecord extends BaseRecord {
  type: 'session_start'
}

interface SessionEndRecord extends BaseRecord {
  type: 'session_end'
  /** Wall-clock duration of the whole session in milliseconds. */
  durationMs: number
  totalTurns: number
  totalToolCalls: number
  totalTokensIn: number
  totalTokensOut: number
  model: string | null
  provider: string | null
}

interface TurnStartRecord extends BaseRecord {
  type: 'turn_start'
  /** Groups the turn_start, turn_end, and tool_call records for this turn. */
  turnId: string
  turnIndex: number
  model: string
  provider: string
}

interface TurnEndRecord extends BaseRecord {
  type: 'turn_end'
  turnId: string
  turnIndex: number
  /** Wall-clock duration from turn_start to turn_end in milliseconds. */
  durationMs: number
  tokensIn: number | null
  tokensOut: number | null
  toolCallCount: number
}

interface ToolCallRecord extends BaseRecord {
  type: 'tool_call'
  turnId: string
  toolCallId: string
  toolName: string
  /** Wall-clock execution time in milliseconds. */
  durationMs: number
  isError: boolean
  /** First 300 chars of JSON-serialised tool arguments. */
  argsSummary: string
}

interface ModelChangeRecord extends BaseRecord {
  type: 'model_change'
  model: string
  provider: string
  previousModel: string | null
  previousProvider: string | null
  /** "set" | "cycle" | "restore" */
  source: string
}

interface CommandRecord extends BaseRecord {
  type: 'command'
  command: string
  args: string
}

interface SessionTagsRecord extends BaseRecord {
  type: 'session_tags'
  tags: string[]
  summary: string
  taggingModel: string
}

type ObsRecord =
  | SessionStartRecord
  | SessionEndRecord
  | TurnStartRecord
  | TurnEndRecord
  | ToolCallRecord
  | ModelChangeRecord
  | CommandRecord
  | SessionTagsRecord

// ─── Async JSONL writer ───────────────────────────────────────────────────────

/**
 * Non-blocking JSONL writer.
 *
 * Records are serialised synchronously (cheap string work) then pushed onto a
 * queue.  A `setImmediate`-driven drain loop handles all I/O so the calling
 * thread is never blocked waiting for disk.
 */
class AsyncJSONLWriter {
  private queue: string[] = []
  private draining = false
  private fd: number | null = null
  private filePath: string | null = null

  /** Open (or create) the output file.  Synchronous so the path is ready immediately. */
  open(filePath: string): void {
    const dir = path.dirname(filePath)
    fs.mkdirSync(dir, { recursive: true })
    this.fd = fs.openSync(filePath, 'a')
    this.filePath = filePath
  }

  /** Enqueue a record.  Returns immediately; never throws. */
  write(record: ObsRecord): void {
    try {
      this.queue.push(JSON.stringify(record) + '\n')
      if (!this.draining) this.scheduleDrain()
    } catch {
      // serialisation errors are silently swallowed
    }
  }

  /** Flush all pending records. Resolves when the queue is empty. */
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
    try { fs.writeSync(this.fd, batch) } catch { /* ignore write errors */ }
    if (this.queue.length > 0) setImmediate(() => this.drainLoop())
    else this.draining = false
  }
}

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const writer = new AsyncJSONLWriter()

  // ── Session-level state ────────────────────────────────────────────────────
  const sessionId = crypto.randomUUID()
  const sessionStartMs = Date.now()

  let currentModel: string | null = null
  let currentProvider: string | null = null
  let sessionFile: string | null = null
  let cwd = process.cwd()

  // turn state
  let currentTurnId: string | null = null
  let currentTurnIndex = 0
  let currentTurnStartMs = 0
  let currentTurnToolCount = 0

  // per-tool start time keyed by toolCallId
  const toolStartTimes = new Map<string, number>()

  // session-level totals
  let totalTurns = 0
  let totalToolCalls = 0
  let totalTokensIn = 0
  let totalTokensOut = 0

  // ── Helpers ────────────────────────────────────────────────────────────────

  function now(): string { return new Date().toISOString() }

  function base(): Omit<BaseRecord, 'type'> {
    return { '@timestamp': now(), sessionId, sessionFile, cwd }
  }

  function emit(record: ObsRecord): void { writer.write(record) }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile() ?? null
    cwd = ctx.cwd

    const dir = path.join(os.homedir(), '.pi', 'observability')
    const dateStr = new Date().toISOString().slice(0, 10)
    const shortId = sessionId.slice(0, 8)
    writer.open(path.join(dir, `${dateStr}-${shortId}.jsonl`))

    emit({ type: 'session_start', ...base() })
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    // Emit session_end synchronously (tags may arrive after via generateTags)
    emit({
      type: 'session_end',
      ...base(),
      durationMs: Date.now() - sessionStartMs,
      totalTurns,
      totalToolCalls,
      totalTokensIn,
      totalTokensOut,
      model: currentModel,
      provider: currentProvider,
    })

    // Fire-and-forget AI tagging; flush waits for everything including tags
    generateTags(ctx).catch(() => {}).finally(async () => {
      await writer.flush()
      writer.close()
    })
  })

  // ── Model tracking ─────────────────────────────────────────────────────────

  pi.on('model_select', async (event, _ctx) => {
    const prev = currentModel
    const prevProv = currentProvider
    currentModel = event.model.id
    currentProvider = event.model.provider

    emit({
      type: 'model_change',
      ...base(),
      model: currentModel,
      provider: currentProvider,
      previousModel: prev,
      previousProvider: prevProv,
      source: event.source,
    })
  })

  // ── Turn tracking ──────────────────────────────────────────────────────────

  pi.on('turn_start', async (event, ctx) => {
    currentTurnId = crypto.randomUUID()
    currentTurnIndex = event.turnIndex
    currentTurnStartMs = Date.now()
    currentTurnToolCount = 0
    cwd = ctx.cwd

    emit({
      type: 'turn_start',
      ...base(),
      turnId: currentTurnId,
      turnIndex: event.turnIndex,
      model: currentModel ?? 'unknown',
      provider: currentProvider ?? 'unknown',
    })
  })

  pi.on('turn_end', async (event, _ctx) => {
    if (!currentTurnId) return

    const usage = extractUsage(event)
    totalTurns++

    emit({
      type: 'turn_end',
      ...base(),
      turnId: currentTurnId,
      turnIndex: currentTurnIndex,
      durationMs: Date.now() - currentTurnStartMs,
      tokensIn: usage?.inputTokens ?? null,
      tokensOut: usage?.outputTokens ?? null,
      toolCallCount: currentTurnToolCount,
    })

    totalTokensIn += usage?.inputTokens ?? 0
    totalTokensOut += usage?.outputTokens ?? 0
  })

  // ── Tool tracking ──────────────────────────────────────────────────────────

  pi.on('tool_execution_start', async (event, _ctx) => {
    toolStartTimes.set(event.toolCallId, Date.now())
  })

  pi.on('tool_execution_end', async (event, _ctx) => {
    if (!currentTurnId) return
    const startMs = toolStartTimes.get(event.toolCallId) ?? Date.now()
    toolStartTimes.delete(event.toolCallId)
    currentTurnToolCount++
    totalToolCalls++

    emit({
      type: 'tool_call',
      ...base(),
      turnId: currentTurnId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      durationMs: Date.now() - startMs,
      isError: event.isError ?? false,
      argsSummary: JSON.stringify(event.args ?? {}).slice(0, 300),
    })
  })

  // ── Command tracking ───────────────────────────────────────────────────────

  pi.on('input', async (event, _ctx) => {
    const text = event.text.trim()
    if (!text.startsWith('/')) return
    const spaceIdx = text.indexOf(' ')
    const command = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)
    const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1)
    emit({ type: 'command', ...base(), command, args })
  })

  // ── Usage extraction helper ────────────────────────────────────────────────

  function extractUsage(event: unknown): { inputTokens: number; outputTokens: number } | null {
    try {
      const msg = (event as { message?: { usage?: { inputTokens?: number; outputTokens?: number } } }).message
      if (msg?.usage) {
        return { inputTokens: msg.usage.inputTokens ?? 0, outputTokens: msg.usage.outputTokens ?? 0 }
      }
    } catch { /* ignore */ }
    return null
  }

  // ── AI tagging ─────────────────────────────────────────────────────────────

  /**
   * Summarise the session and ask a cheap/fast model to emit single-word tags.
   * Runs asynchronously; never throws out (errors are swallowed).
   */
  async function generateTags(ctx: Parameters<Parameters<ExtensionAPI['on']>[1]>[1]): Promise<void> {
    const cheapModel = findCheapModel(ctx)
    if (!cheapModel) return

    const apiKey = await ctx.modelRegistry.getApiKey(cheapModel)
    if (!apiKey) return

    // Build a concise session summary from the branch entries
    const entries = ctx.sessionManager.getBranch()
    const toolNames: string[] = []
    const userTexts: string[] = []

    for (const entry of entries) {
      if (entry.type !== 'message') continue
      const msg = entry.message as Record<string, unknown>
      if (msg.role === 'toolResult' && typeof msg.toolName === 'string') {
        toolNames.push(msg.toolName as string)
      }
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const part of msg.content as Array<Record<string, unknown>>) {
          if (part.type === 'text' && typeof part.text === 'string') {
            userTexts.push(part.text.slice(0, 200))
          }
        }
      }
    }

    const uniqueTools = [...new Set(toolNames)].join(', ')
    const sampleTexts = userTexts.slice(0, 5).join(' | ')
    const inputSummary = `Tools used: ${uniqueTools || 'none'}. User messages: ${sampleTexts || 'none'}.`

    const tagPrompt = `You are a concise tagger for AI coding-agent sessions.

Given this session summary, output a JSON array of 3-8 single-word lowercase tags categorising:
- programming language(s) in use (e.g. "typescript", "go", "python", "rust")
- type of work (e.g. "bugfix", "feature", "refactor", "docs", "testing", "config", "infra")
- domain (e.g. "pi", "pi-extension", "web", "cli", "database", "devops")

Session summary:
${inputSummary}

Respond with ONLY a JSON array. Example: ["typescript","feature","pi-extension"]`

    try {
      const response = await complete(
        cheapModel,
        { messages: [{ role: 'user', content: [{ type: 'text', text: tagPrompt }], timestamp: Date.now() }] },
        { apiKey, maxTokens: 200 }
      )

      const text = response.content
        .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
        .map((c) => c.text)
        .join('')

      const match = text.match(/\[.*?\]/s)
      if (!match) return

      const tags = JSON.parse(match[0]) as unknown[]
      if (!Array.isArray(tags)) return

      emit({
        type: 'session_tags',
        ...base(),
        tags: tags.filter((t): t is string => typeof t === 'string'),
        summary: inputSummary.slice(0, 500),
        taggingModel: `${cheapModel.provider}/${cheapModel.id}`,
      })
    } catch {
      // best-effort; never surface to the user
    }
  }

  /** Returns the cheapest/fastest model available in the registry. */
  function findCheapModel(ctx: Parameters<Parameters<ExtensionAPI['on']>[1]>[1]) {
    const candidates = [
      { provider: 'google', id: 'gemini-2.0-flash' },
      { provider: 'google', id: 'gemini-2.5-flash' },
      { provider: 'google', id: 'gemini-1.5-flash' },
      { provider: 'anthropic', id: 'claude-haiku-4-5' },
      { provider: 'anthropic', id: 'claude-3-haiku-20240307' },
      { provider: 'openai', id: 'gpt-4o-mini' },
    ]
    for (const c of candidates) {
      const m = ctx.modelRegistry.find(c.provider, c.id)
      if (m) return m
    }
    return null
  }

  // ── /observe command ───────────────────────────────────────────────────────

  pi.registerCommand('observe', {
    description: 'Show observability file + session stats, or: /observe tags (generate tags now)',
    handler: async (args, ctx) => {
      const sub = args?.trim().toLowerCase()

      if (sub === 'tags') {
        ctx.ui.notify('Generating session tags in background…', 'info')
        generateTags(ctx).catch(() => {})
        return
      }

      const file = writer.getFilePath() ?? '(not yet open)'
      ctx.ui.notify(
        [
          `Observability JSONL: ${file}`,
          `Session ID: ${sessionId}`,
          `Turns: ${totalTurns} | Tool calls: ${totalToolCalls}`,
          `Tokens in: ${totalTokensIn} | out: ${totalTokensOut}`,
          `Model: ${currentModel ?? 'unknown'} (${currentProvider ?? 'unknown'})`,
        ].join('\n'),
        'info'
      )
    },
  })

  // ── observe_analyze tool ───────────────────────────────────────────────────

  pi.registerTool({
    name: 'observe_analyze',
    label: 'Observability: Analyze Session',
    description:
      'Reads a Pi observability JSONL file and produces a structured per-session analysis ' +
      'with tool usage frequencies, average durations, token totals, models used, and any ' +
      'AI-generated tags. Omit jsonl_path to analyse the current session.',
    promptSnippet: 'Analyse a Pi observability JSONL file and return aggregated session metrics',
    parameters: Type.Object({
      jsonl_path: Type.Optional(
        Type.String({ description: 'Path to the .jsonl file. Defaults to the current session file.' })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const filePath = params.jsonl_path ?? writer.getFilePath()
      if (!filePath) {
        throw new Error('No observability file is open and no path was provided.')
      }

      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf8')
      } catch (e) {
        throw new Error(`Cannot read ${filePath}: ${(e as Error).message}`)
      }

      const records = raw
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try { return [JSON.parse(line) as ObsRecord] }
          catch { return [] }
        })

      // ── aggregate ──────────────────────────────────────────────────────
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
        switch (r.type) {
          case 'tool_call': {
            const tc = r as ToolCallRecord
            toolCalls[tc.toolName] = (toolCalls[tc.toolName] ?? 0) + 1
            if (tc.isError) toolErrors[tc.toolName] = (toolErrors[tc.toolName] ?? 0) + 1
            ;(toolDurations[tc.toolName] ??= []).push(tc.durationMs)
            break
          }
          case 'model_change': {
            const mc = r as ModelChangeRecord
            modelsUsed.add(`${mc.provider}/${mc.model}`)
            break
          }
          case 'turn_end': {
            const te = r as TurnEndRecord
            turnCount++
            totalIn += te.tokensIn ?? 0
            totalOut += te.tokensOut ?? 0
            turnDurations.push(te.durationMs)
            break
          }
          case 'session_tags':
            tags = (r as SessionTagsRecord).tags
            break
        }
      }

      const avg = (arr: number[]) =>
        arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0

      const toolStats = Object.entries(toolCalls)
        .sort(([, a], [, b]) => b - a)
        .map(([name, calls]) => ({
          tool: name,
          calls,
          errors: toolErrors[name] ?? 0,
          avgDurationMs: avg(toolDurations[name] ?? []),
        }))

      const analysis = {
        filePath,
        sessions: sessions.size,
        turns: turnCount,
        totalTokensIn: totalIn,
        totalTokensOut: totalOut,
        avgTurnDurationMs: avg(turnDurations),
        modelsUsed: [...modelsUsed],
        tags,
        toolStats,
        recordCount: records.length,
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(analysis, null, 2) }],
        details: { analysis },
      }
    },
  })
}
