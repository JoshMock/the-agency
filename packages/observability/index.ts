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
import * as crypto from 'node:crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Provider → gen_ai.system mapping ────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Session-level state ──────────────────────────────────────────────────

  let sessionId: string | undefined
  let sessionFile: string | null = null
  let sessionStartTs: string | undefined
  let cwd = process.cwd()
  let currentModel: string | undefined
  let currentProvider: string | undefined
  let currentThinkingLevel: string | undefined

  // snapshot of skills + tools captured at before_agent_start, held until
  // the turn produces a span document to attach them to
  let currentExchangeId: string | undefined
  let currentExchangeSkills: SkillMeta[] = []
  let currentExchangeTools: ToolMeta[] = []
  let currentExchangeActiveToolNames: string[] = []
  let currentExchangeCommands: string[] = []
  let currentUserText: string | undefined

  // turn state
  let currentTurnStartTs: string | undefined

  // ── Session start ────────────────────────────────────────────────────────

  pi.on('session_start', async (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile() ?? null
    cwd = ctx.cwd
    sessionStartTs = new Date().toISOString()

    // use the session file's embedded ID when available, otherwise generate one
    const entries = ctx.sessionManager.getEntries()
    const sessionEntry = entries.find((e) => e.type === 'session')
    sessionId = (sessionEntry as Record<string, unknown> | undefined)?.['id'] as string | undefined ??
      crypto.randomUUID()
  })

  // ── Thinking level tracking ──────────────────────────────────────────────

  type ThinkingLevelEvent = { thinkingLevel?: string }
  pi.on('thinking_level_select' as Parameters<typeof pi.on>[0], async (event: ThinkingLevelEvent) => {
    currentThinkingLevel = event.thinkingLevel
  })

  // ── Model tracking ───────────────────────────────────────────────────────

  pi.on('model_select', async (event) => {
    currentModel = event.model.id
    currentProvider = event.model.provider
  })

  // ── Capture context at the moment a prompt is sent ───────────────────────

  pi.on('before_agent_start', async (event, _ctx) => {
    // fresh exchange ID for every user prompt
    currentExchangeId = crypto.randomUUID()

    const opts: BuildSystemPromptOptions = event.systemPromptOptions
    currentExchangeSkills = buildSkillMeta(opts.skills)
    currentExchangeTools = buildToolMeta(pi.getAllTools())
    currentExchangeActiveToolNames = pi.getActiveTools()
    currentExchangeCommands = pi.getCommands().map((c) => c.name)

    // extract plain user text (strip injected <skill> blocks)
    currentUserText = stripSkillBlocks(event.prompt).trim() || undefined
  })

  // ── Turn timing ──────────────────────────────────────────────────────────

  pi.on('turn_start', async (_event, ctx) => {
    currentTurnStartTs = new Date().toISOString()
    cwd = ctx.cwd
  })

  // ── Emit one span per completed assistant turn ───────────────────────────

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

    // use pi.response_id as document ID when available (matches ETL idempotency)
    const docId = (msg.responseId ?? span['span.id']) as string

    emit(span as SpanDocument, docId)
  })

  // ── Output sink (to be wired up separately) ──────────────────────────────

  /**
   * Emit a completed span document.
   * The body of this function is intentionally left as a no-op stub —
   * the output sink (file, HTTP, Elasticsearch bulk API, etc.) will be
   * configured separately.
   */
  function emit (_span: SpanDocument, _docId: string): void {
    // sink implementation goes here
  }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Strip injected skill/annotation blocks from a prompt before storing user
 * text.  Handles both the paired-tag form (`<skill name="...">...</skill>`)
 * and the self-closing form (`<available_skills/>`).
 */
export function stripSkillBlocks (text: string): string {
  // paired tags: <tag-name ...>...</tag-name>
  let result = text.replace(/<([\w-]+)[^>]*>[\s\S]*?<\/\1>/g, '')
  // self-closing annotation tags on their own line
  result = result.replace(/^[ \t]*<[\w-]+[^>]*\/>\s*$/gm, '')
  return result
}
