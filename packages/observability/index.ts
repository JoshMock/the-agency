/**
 * Pi Observability Extension
 *
 * Emits one OTel GenAI-compatible span per assistant turn. Spans are exported
 * via OTLP when a collector endpoint is configured, or written to JSONL files
 * under ~/.pi/observability/ when no endpoint is set.
 *
 * Standard OpenTelemetry environment variables:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT  - OTLP collector URL (enables OTLP export)
 *   OTEL_EXPORTER_OTLP_HEADERS   - comma-separated key=value auth headers
 *   OTEL_EXPORTER_OTLP_PROTOCOL  - http/json (default), http/protobuf, grpc
 *   OTEL_SERVICE_NAME             - overrides the default service name
 *
 * When no OTLP endpoint is set, spans are written to
 * ~/.pi/observability/YYYY-MM-DD.jsonl (one file per day, one span per line).
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
import type { ExportResult, Tracer } from '@opentelemetry/api'
import { ROOT_CONTEXT, TraceFlags, trace } from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Extracted tool call for the span. */
interface SpanToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  arguments_text: string
}

/** Extracted tool result for the span. */
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

/** Metadata about a loaded skill. */
interface SkillMeta {
  name: string
  path: string
  source: string
  scope: string
}

/** Metadata about an active tool. */
interface ToolMeta {
  name: string
  source: string
  scope: string
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
 * Extract text, thinking, and tool call blocks from an assistant message.
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
 * Extract text output from tool result messages.
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

/**
 * Span exporter that appends one JSON line per span to a daily file under
 * a configurable directory (default: ~/.pi/observability/).
 * The file for each day is named YYYY-MM-DD.jsonl.
 */
export class FileSpanExporter implements SpanExporter {
  /** Absolute path to the directory where JSONL files are written. */
  readonly dir: string

  constructor (dir?: string) {
    this.dir = dir ?? path.join(os.homedir(), '.pi', 'observability')
  }

  /**
   * Append each span as a JSON line to today's JSONL file.
   * Creates the directory if it does not exist.
   */
  export (spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const date = new Date().toISOString().slice(0, 10)
    const file = path.join(this.dir, `${date}.jsonl`)
    const lines = spans.map((span) => JSON.stringify(serializeSpan(span))).join('\n') + '\n'

    fs.mkdir(this.dir, { recursive: true }, (mkdirErr) => {
      if (mkdirErr) {
        resultCallback({ code: ExportResultCode.FAILED, error: mkdirErr })
        return
      }
      fs.appendFile(file, lines, (appendErr) => {
        if (appendErr) {
          resultCallback({ code: ExportResultCode.FAILED, error: appendErr })
        } else {
          resultCallback({ code: ExportResultCode.SUCCESS })
        }
      })
    })
  }

  /** No-op: file writes are fire-and-forget. */
  shutdown (): Promise<void> {
    return Promise.resolve()
  }
}

/**
 * Serialize a ReadableSpan to a plain JSON-serialisable object.
 * HrTime values are converted to milliseconds since Unix epoch.
 */
function serializeSpan (span: ReadableSpan): Record<string, unknown> {
  const ctx = span.spanContext()
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    startTimeMs: hrTimeToMs(span.startTime),
    endTimeMs: hrTimeToMs(span.endTime),
    attributes: span.attributes,
    status: span.status,
  }
}

/** Convert an OTel HrTime ([seconds, nanoseconds]) to milliseconds. */
function hrTimeToMs (hrTime: [number, number]): number {
  return hrTime[0] * 1000 + hrTime[1] / 1e6
}

/** Return value of createTracerProvider. */
export interface TracerProviderResult {
  provider: BasicTracerProvider
  sinkLabel: string
}

/**
 * Initialise a tracer provider.
 *
 * When OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) is
 * set, an OTLPTraceExporter is used and spans are sent to that collector.
 * Otherwise a FileSpanExporter is used and spans are written to daily JSONL
 * files under ~/.pi/observability/.
 *
 * Returns an object containing the provider and a short label describing the
 * active sink ("otlp:<host>" or "otlp:file").
 */
export function createTracerProvider (): TracerProviderResult {
  const endpoint =
    process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
    process.env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT']

  let exporter: SpanExporter
  let sinkLabel: string

  if (endpoint) {
    exporter = new OTLPTraceExporter()
    sinkLabel = `otlp:${new URL(endpoint).host}`
  } else {
    exporter = new FileSpanExporter()
    sinkLabel = 'otlp:file'
  }

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      'service.name': process.env['OTEL_SERVICE_NAME'] ?? 'pi-coding-agent',
      'telemetry.sdk.name': 'pi-observability-extension',
    }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })

  return { provider, sinkLabel }
}

/**
 * Emit one OTel span for a completed assistant turn.
 *
 * All Gen AI attributes, message content, tool calls/results, session metadata,
 * and cost fields are set as span attributes. Complex values (arrays of objects)
 * are JSON-serialised. The session ID is used as the OTel trace ID so all turns
 * in one session share a trace.
 */
function emitSpan (
  tracer: Tracer,
  spanName: string,
  traceId: string,
  rootSpanId: string,
  startTimeMs: number,
  endTimeMs: number,
  attributes: Record<string, unknown>
): void {
  const normalizedTraceId = traceId.replace(/-/g, '').padEnd(32, '0').slice(0, 32)
  const parentCtx = trace.setSpanContext(ROOT_CONTEXT, {
    traceId: normalizedTraceId,
    spanId: rootSpanId,
    traceFlags: TraceFlags.SAMPLED,
    isRemote: true,
  })

  const span = tracer.startSpan(spanName, { startTime: startTimeMs }, parentCtx)

  for (const [key, value] of Object.entries(attributes)) {
    if (value == null) continue
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      span.setAttribute(key, value)
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      span.setAttribute(key, value as string[])
    } else {
      span.setAttribute(key, JSON.stringify(value))
    }
  }

  span.end(endTimeMs)
}

export default function (pi: ExtensionAPI) {
  const { provider: tracerProvider, sinkLabel } = createTracerProvider()
  const tracer = tracerProvider.getTracer('pi-observability-extension')

  let sessionId: string | undefined
  let sessionRootSpanId = crypto.randomBytes(8).toString('hex')
  let sessionFile: string | null = null
  let sessionStartTs: string | undefined
  let cwd = process.cwd()
  let currentModel: string | undefined
  let currentProvider: string | undefined
  let currentThinkingLevel: string | undefined

  let currentExchangeId: string | undefined
  let currentExchangeSkills: SkillMeta[] = []
  let currentExchangeTools: ToolMeta[] = []
  let currentExchangeActiveToolNames: string[] = []
  let currentExchangeCommands: string[] = []
  let currentUserText: string | undefined

  let currentTurnStartMs: number | undefined

  pi.on('session_start', async (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile() ?? null
    cwd = ctx.cwd
    sessionStartTs = new Date().toISOString()

    const entries = ctx.sessionManager.getEntries()
    const sessionEntry = entries.find((e) => e.type === 'session')
    sessionRootSpanId = crypto.randomBytes(8).toString('hex')
    sessionId =
      (sessionEntry as Record<string, unknown> | undefined)?.['id'] as string | undefined ??
      crypto.randomUUID()

    const { theme } = ctx.ui
    ctx.ui.setStatus('pi-observability', theme.fg('accent', '\u2b21 ') + theme.fg('dim', sinkLabel))
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

    currentUserText = stripSkillBlocks(event.prompt).trim() || undefined
  })

  pi.on('turn_start', async (_event, ctx) => {
    currentTurnStartMs = Date.now()
    cwd = ctx.cwd
  })

  pi.on('turn_end', async (event, _ctx) => {
    const msg = event.message as AssistantMessage | undefined
    if (msg?.role !== 'assistant') return

    const usage = msg.usage ?? {}
    const cost = usage.cost ?? {}
    const model = msg.model ?? currentModel ?? 'unknown'
    const provider = (msg.provider as string | undefined) ?? currentProvider ?? 'unknown'
    const endTimeMs = msg.timestamp
    const startTimeMs = currentTurnStartMs ?? endTimeMs

    const { text, thinking, toolCalls } = extractAssistantText(msg)
    const toolResults = extractToolResults(event.toolResults)

    const attributes: Record<string, unknown> = {
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
      'message.assistant.text': text,
      'message.assistant.thinking': thinking,
      'tool_calls': toolCalls.length > 0 ? toolCalls : undefined,
      'tool_results': toolResults.length > 0 ? toolResults : undefined,
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
      'pi.model.api': msg.api as string | undefined,
      'pi.thinking_level': currentThinkingLevel,
      'pi.thinking.present': thinking != null,
      'pi.response_id': msg.responseId,

      'cost.total_usd': cost.total,
      'cost.input_usd': cost.input,
      'cost.output_usd': cost.output,
    }

    stripUndefined(attributes)

    emitSpan(
      tracer,
      `gen_ai chat ${model}`,
      sessionId ?? cwd,
      sessionRootSpanId,
      startTimeMs,
      endTimeMs,
      attributes
    )
  })
}

/**
 * Strip injected skill/annotation blocks from a prompt before storing user text.
 * Handles both paired-tag form (`<skill name="...">...</skill>`) and
 * self-closing form (`<available_skills/>`).
 */
export function stripSkillBlocks (text: string): string {
  let result = text.replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, '')
  result = result.replace(/^[ \t]*<[\w-]+[^>]*\/>\s*$/gm, '')
  return result
}
