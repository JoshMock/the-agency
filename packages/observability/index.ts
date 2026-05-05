/**
 * Pi Observability Extension
 *
 * Emits one OTel GenAI-compatible JSONL document per assistant turn, matching
 * the schema produced by pi-sessions-to-otel.ts so both sources index into the
 * same Elasticsearch index without mapping conflicts.
 *
 * Additional fields captured at runtime that the offline ETL cannot provide:
 *   - pi.session.skills          – names of every skill loaded at prompt time
 *   - pi.session.skill_paths     – filesystem paths of loaded skills
 *   - pi.session.tools           – names of all active tools
 *   - pi.session.tool_sources    – source metadata (builtin / extension / sdk)
 *   - pi.session.commands        – slash commands registered at prompt time
 *   - pi.turn.exchange_id        – stable ID grouping one user prompt + all its
 *                                  assistant turns (set on before_agent_start,
 *                                  shared across every turn in that exchange)
 *   - pi.response_id             – provider response ID (used as ES _id)
 *
 * Output goes to a configurable sink (handled separately).
 *
 * Semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import type {
  AssistantMessage,
  ToolResultMessage,
} from '@mariozechner/pi-ai'
import type {
  BuildSystemPromptOptions,
  ExtensionAPI,
  Skill,
  ToolInfo,
} from '@mariozechner/pi-coding-agent'
import { SeverityNumber } from '@opentelemetry/api-logs'
import type { ExportResult } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type Logger,
  type LogRecordExporter,
  type ReadableLogRecord,
} from '@opentelemetry/sdk-logs'
import * as crypto from 'node:crypto'

import { FileJsonlExporter } from './file-exporter.ts'

/** Extracted tool call for the span document. */
interface SpanToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  arguments_text: string
}

/** Extracted tool result for the span document. */
interface SpanToolResult {
  tool_call_id: string
  tool_name: string
  output: string
}

/** Result of extracting content from an assistant message. */
interface ExtractedAssistantContent {
  text: string | undefined
  thinking: string | undefined
  toolCalls: SpanToolCall[]
}

/** Metadata about a loaded skill, trimmed for ES storage. */
interface SkillMeta {
  name: string
  path: string
  source: string
  scope: string
}

/** Metadata about an active tool, trimmed for ES storage. */
interface ToolMeta {
  name: string
  source: string
  scope: string
}

/**
 * One OTel GenAI span document, emitted per assistant turn.
 * Schema matches pi-sessions-to-otel.ts output exactly for fields shared
 * between both sources.
 */
interface SpanDocument {
  [key: string]: unknown
  '@timestamp': string
  'span.id': string
  'trace.id': string
  'span.name': string
}

/** Summary of configured observability exporters. */
interface ExporterStatus {
  fileEnabled: boolean
  otlpEnabled: boolean
}

/** Health state of a single export sink. */
type SinkHealth = 'pending' | 'ok' | 'error'

/** Minimal UI reference needed to update the status pill. */
interface UiRef {
  setStatus(key: string, value: string | undefined): void
  theme: { fg(color: string, text: string): string }
}

const PROVIDER_TO_SYSTEM: Record<string, string> = {
  anthropic: 'anthropic',
  'github-copilot': 'anthropic',
  openai: 'openai',
  azure: 'azure.openai',
  bedrock: 'aws.bedrock',
  google: 'google_ai_studio',
  vertex: 'vertex_ai',
  litellm: 'anthropic',
  ollama: 'ollama',
  cursor: 'openai',
}

const OTEL_STATUS_KEY = 'otel'

/** Map a pi provider + model hint to an OTel gen_ai.system value. */
export function inferSystem (provider: string, model: string): string {
  const p = provider.toLowerCase()
  const m = model.toLowerCase()
  for (const [k, v] of Object.entries(PROVIDER_TO_SYSTEM)) {
    if (p.includes(k)) {
      if (k === 'github-copilot' && (m.includes('gpt') || m.includes('o1') || m.includes('o3'))) return 'openai'
      return v
    }
  }
  if (m.includes('claude')) return 'anthropic'
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'openai'
  if (m.includes('gemini')) return 'google_ai_studio'
  return provider || 'unknown'
}

/**
 * Extract text blocks from an assistant message, returning the joined text
 * and thinking content as separate strings.
 */
export function extractAssistantText (msg: AssistantMessage): ExtractedAssistantContent {
  const textParts: string[] = []
  const thinkingParts: string[] = []
  const toolCalls: SpanToolCall[] = []

  for (const block of msg.content) {
    if (block.type === 'text') {
      const t = block.text.trim()
      if (t.length > 0) textParts.push(t)
    } else if (block.type === 'thinking') {
      const t = (block as { type: 'thinking'; thinking: string }).thinking.trim()
      if (t.length > 0) thinkingParts.push(t)
    } else if (block.type === 'toolCall') {
      const tc = block as { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
      toolCalls.push({
        id: tc.id ?? '',
        name: tc.name ?? '',
        arguments: tc.arguments ?? {},
        arguments_text: Object.keys(tc.arguments ?? {}).length > 0 ? JSON.stringify(tc.arguments) : '',
      })
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join('\n\n') : undefined,
    thinking: thinkingParts.length > 0 ? thinkingParts.join('\n\n') : undefined,
    toolCalls,
  }
}

/**
 * Extract text output from tool result messages that belong to a given set of
 * tool call IDs.
 */
export function extractToolResults (
  toolResults: ToolResultMessage[]
): SpanToolResult[] {
  return toolResults.map((tr) => {
    const parts: string[] = []
    for (const c of tr.content) {
      if (c.type === 'text') {
        const t = c.text.trim()
        if (t.length > 0) parts.push(t)
      }
    }
    return {
      tool_call_id: tr.toolCallId,
      tool_name: tr.toolName,
      output: parts.join('\n'),
    }
  })
}

/**
 * Build trimmed skill metadata from the systemPromptOptions skills array.
 * Skills with disableModelInvocation are excluded from the system prompt but
 * we include them here for observability completeness.
 */
function buildSkillMeta (skills: Skill[] | undefined): SkillMeta[] {
  if (skills == null || skills.length === 0) return []
  return skills.map((s) => ({
    name: s.name,
    path: s.filePath,
    source: s.source,
    scope: s.source != null && (s.source.includes('~') || s.source.includes(process.env['HOME'] ?? '/home')) ? 'user' : 'project',
  }))
}

/** Build trimmed tool metadata from pi.getAllTools(). */
function buildToolMeta (tools: ToolInfo[]): ToolMeta[] {
  return tools.map((t) => ({
    name: t.name,
    source: t.sourceInfo.source,
    scope: t.sourceInfo.scope,
  }))
}

/** Strip undefined values from an object in-place. */
export function stripUndefined (obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key]
  }
}

/** Build the per-session JSONL observability file path. */
function observabilityFilePath (sessionId: string): string {
  const date = new Date().toISOString().slice(0, 10)
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp'
  return `${home}/.pi/observability/${date}-${sessionId.slice(0, 8)}.jsonl`
}

/** Build a themed status pill string using per-sink health colors. */
function buildStatusLabel (ui: UiRef, fileHealth: SinkHealth, otlpHealth: SinkHealth, status: ExporterStatus): string {
  const color = (h: SinkHealth): string => h === 'ok' ? 'success' : h === 'error' ? 'error' : 'dim'
  const parts: string[] = []
  if (status.fileEnabled) parts.push(ui.theme.fg(color(fileHealth), 'file'))
  if (status.otlpEnabled) parts.push(ui.theme.fg(color(otlpHealth), 'otlp'))
  if (parts.length === 0) return ui.theme.fg('dim', 'off')
  return `otel: ${parts.join(ui.theme.fg('dim', '+'))}`
}

/**
 * Wraps a LogRecordExporter to invoke a callback after each export attempt.
 * Used to surface success/failure to the UI status pill.
 */
class TrackingExporter implements LogRecordExporter {
  constructor(
    private inner: LogRecordExporter,
    private onResult: (success: boolean) => void
  ) {}

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    this.inner.export(records, (result) => {
      if (records.length > 0) this.onResult(result.code === 0)
      resultCallback(result)
    })
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown()
  }
}

/** Return value of buildLoggerProvider. */
interface LoggerProviderBuild {
  provider: LoggerProvider
  logger: Logger
  status: ExporterStatus
}

/** Build the OTel logger provider and return logger + exporter status. */
export function buildLoggerProvider (
  filePath: string,
  onResult?: (sink: 'file' | 'otlp', success: boolean) => void
): LoggerProviderBuild {
  const processors = [
    new BatchLogRecordProcessor(new TrackingExporter(new FileJsonlExporter(filePath), (ok) => onResult?.('file', ok))),
  ]

  const otlpEnabled = process.env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'] != null
  if (otlpEnabled) {
    processors.push(new BatchLogRecordProcessor(new TrackingExporter(new OTLPLogExporter(), (ok) => onResult?.('otlp', ok))))
  }

  const provider = new LoggerProvider()
  for (const processor of processors) {
    provider.addLogRecordProcessor(processor)
  }
  return {
    provider,
    logger: provider.getLogger('pi-observability'),
    status: {
      fileEnabled: true,
      otlpEnabled,
    },
  }
}

export default function (pi: ExtensionAPI) {
  let sessionId: string | undefined
  let sessionFile: string | null = null
  let sessionStartTs: string | undefined
  let cwd = process.cwd()
  let currentModel: string | undefined
  let currentProvider: string | undefined
  let currentThinkingLevel: string | undefined
  let otelProvider: LoggerProvider | undefined
  let otelLogger: Logger | undefined
  let exporterStatus: ExporterStatus = { fileEnabled: false, otlpEnabled: false }
  let uiRef: UiRef | undefined
  let fileHealth: SinkHealth = 'pending'
  let otlpHealth: SinkHealth = 'pending'

  let currentExchangeId: string | undefined
  let currentExchangeSkills: SkillMeta[] = []
  let currentExchangeTools: ToolMeta[] = []
  let currentExchangeActiveToolNames: string[] = []
  let currentExchangeCommands: string[] = []
  let currentUserText: string | undefined

  let currentTurnStartTs: string | undefined

  pi.on('session_start', async (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile() ?? null
    cwd = ctx.cwd
    sessionStartTs = new Date().toISOString()

    const entries = ctx.sessionManager.getEntries()
    const sessionEntry = entries.find((e) => e.type === 'session')
    sessionId = (sessionEntry as Record<string, unknown> | undefined)?.['id'] as string | undefined ??
      crypto.randomUUID()

    const filePath = observabilityFilePath(sessionId)
    const built = buildLoggerProvider(filePath, (sink, success) => {
      if (sink === 'file') fileHealth = success ? 'ok' : 'error'
      else otlpHealth = success ? 'ok' : 'error'
      if (uiRef != null) {
        uiRef.setStatus(OTEL_STATUS_KEY, buildStatusLabel(uiRef, fileHealth, otlpHealth, exporterStatus))
      }
    })
    otelProvider = built.provider
    otelLogger = built.logger
    exporterStatus = built.status

    if (ctx.hasUI) {
      uiRef = ctx.ui
      ctx.ui.setStatus(OTEL_STATUS_KEY, buildStatusLabel(ctx.ui, fileHealth, otlpHealth, exporterStatus))
    }
  })

  type ThinkingLevelEvent = { thinkingLevel?: string }
  pi.on('thinking_level_select' as Parameters<typeof pi.on>[0], async (event: ThinkingLevelEvent) => {
    currentThinkingLevel = event.thinkingLevel
  })

  pi.on('model_select', async (event) => {
    currentModel = event.model.id
    currentProvider = event.model.provider
  })

  pi.on('before_agent_start', async (event, _ctx) => {
    currentExchangeId = crypto.randomUUID()

    const opts: BuildSystemPromptOptions = event.systemPromptOptions
    currentExchangeSkills = buildSkillMeta(opts.skills)
    currentExchangeTools = buildToolMeta(pi.getAllTools())
    currentExchangeActiveToolNames = pi.getActiveTools()
    currentExchangeCommands = pi.getCommands().map((c) => c.name)

    currentUserText = stripSkillBlocks(event.prompt).trim() ?? undefined
  })

  pi.on('turn_start', async (_event, ctx) => {
    currentTurnStartTs = new Date().toISOString()
    cwd = ctx.cwd
  })

  pi.on('turn_end', async (event, _ctx) => {
    const msg = event.message as AssistantMessage | undefined
    if (msg?.role !== 'assistant') return

    const usage = msg.usage ?? {}
    const cost = usage.cost ?? {}
    const model = msg.model ?? currentModel ?? 'unknown'
    const provider = (msg.provider as string | undefined) ?? currentProvider ?? 'unknown'
    const timestamp = new Date(msg.timestamp).toISOString()

    let durationUs: number | undefined
    if (currentTurnStartTs != null) {
      const ms = msg.timestamp - new Date(currentTurnStartTs).getTime()
      if (!Number.isNaN(ms) && ms >= 0) durationUs = ms * 1000
    }

    const { text, thinking, toolCalls } = extractAssistantText(msg)
    const toolResults = extractToolResults(event.toolResults)

    const span: Record<string, unknown> = {
      '@timestamp': timestamp,
      'span.id': crypto.randomUUID(),
      'trace.id': sessionId ?? cwd,
      'span.name': `gen_ai chat ${model}`,
      ...(durationUs != null ? { 'duration.us': durationUs } : {}),

      'gen_ai.system': inferSystem(provider, model),
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': model,
      'gen_ai.response.model': msg.responseModel ?? model,
      'gen_ai.response.finish_reasons': msg.stopReason ? [msg.stopReason] : [],
      'gen_ai.usage.input_tokens': usage.input,
      'gen_ai.usage.output_tokens': usage.output,
      'gen_ai.usage.cache_read_input_tokens': usage.cacheRead,
      'gen_ai.usage.cache_creation_input_tokens': usage.cacheWrite,
      'gen_ai.usage.total_tokens': usage.totalTokens,

      'message.user.text': currentUserText,
      ...(text != null ? { 'message.assistant.text': text } : {}),
      ...(thinking != null ? { 'message.assistant.thinking': thinking } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(toolResults.length > 0 ? { tool_results: toolResults } : {}),
      'turn.tool_call_count': toolCalls.length,
      'turn.tool_result_count': toolResults.length,

      'pi.session.id': sessionId,
      'pi.session.cwd': cwd,
      'pi.session.start': sessionStartTs,
      'pi.session.file': sessionFile ?? undefined,
      'pi.session.skills': currentExchangeSkills.length > 0 ? currentExchangeSkills : undefined,
      'pi.session.skill_names': currentExchangeSkills.length > 0
        ? currentExchangeSkills.map((s) => s.name)
        : undefined,
      'pi.session.tools': currentExchangeTools.length > 0 ? currentExchangeTools : undefined,
      'pi.session.active_tools': currentExchangeActiveToolNames.length > 0
        ? currentExchangeActiveToolNames
        : undefined,
      'pi.session.commands': currentExchangeCommands.length > 0
        ? currentExchangeCommands
        : undefined,

      'pi.turn.exchange_id': currentExchangeId,
      'pi.model.provider': provider,
      'pi.model.api': (msg.api as string | undefined),
      'pi.thinking_level': currentThinkingLevel,
      'pi.thinking.present': thinking != null,
      'pi.response_id': msg.responseId,

      'cost.total_usd': cost.total,
      'cost.input_usd': cost.input,
      'cost.output_usd': cost.output,

      'service.name': 'pi-coding-agent',
      'telemetry.sdk.name': 'pi-observability-extension',
    }

    stripUndefined(span)

    const docId = (msg.responseId ?? span['span.id']) as string

    emit(span as SpanDocument, docId)
  })

  pi.on('session_shutdown' as Parameters<typeof pi.on>[0], async (_event, ctx) => {
    if (otelProvider == null) return

    if (ctx.hasUI) ctx.ui.notify('OTel: flushing logs...', 'info')

    try {
      await otelProvider.shutdown()
      if (ctx.hasUI) ctx.ui.notify('OTel: flush complete', 'info')
    } catch (error) {
      if (ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(`OTel: flush failed: ${message}`, 'error')
      }
    }
  })

  /** Emit a completed span document through the OTel logger provider. */
  function emit (span: SpanDocument, _docId: string): void {
    if (otelLogger == null) return
    otelLogger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: String(span['span.name'] ?? 'gen_ai chat'),
      attributes: span as Record<string, unknown>,
    })
  }
}

/**
 * Strip injected skill/annotation blocks from a prompt before storing user
 * text. Handles both paired tags (`<skill ...>...</skill>`) and self-closing
 * tags (`<available_skills/>`) on standalone lines.
 */
export function stripSkillBlocks (text: string): string {
  let result = text.replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, '')
  result = result.replace(/^[ \t]*<[\w-]+[^>]*\/>\s*$/gm, '')
  return result
}
