#!/usr/bin/env node
/**
 * Parse pi agent session files and write OTel GenAI-compliant span documents
 * to an Elasticsearch instance — with full message text preserved.
 *
 * Each document represents one LLM API call (assistant response turn) and includes:
 *   - OTel GenAI semantic convention fields
 *   - Full assistant text output
 *   - Full thinking block text
 *   - All tool calls with names + arguments
 *   - All tool results (output of tool calls made in this turn)
 *   - The user message text that triggered this turn
 *   - Session context (cwd, model, provider, thinking level, etc.)
 *
 * Semantic Conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'

// ─── Config from env ────────────────────────────────────────────────────────

/**
 * Read an environment variable, falling back to a default value if provided.
 * Throws when the variable is unset and no default is given.
 */
function env (key: string, defaultValue?: string): string {
  const val = process.env[key]
  if (val == null) {
    if (defaultValue !== undefined) return defaultValue
    throw new Error(`Missing required environment variable: ${key}`)
  }
  return val
}

/** Elasticsearch base URL. */
const ES_URL = env('PI_OTEL_ES_URL')
/** Elasticsearch API key for authorization. */
const ES_API_KEY = env('PI_OTEL_ES_API_KEY')
/** Target Elasticsearch index name. */
const INDEX = env('PI_OTEL_INDEX', 'pi-otel-genai-spans')
/** Root directory containing pi session folders. */
const SESSIONS_ROOT = path.resolve(
  os.homedir(),
  env('PI_OTEL_SESSIONS_ROOT', '.pi/agent/sessions')
)

/** Default headers for every ES request. */
const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Authorization: `ApiKey ${ES_API_KEY}`,
}

// ─── Types ──────────────────────────────────────────────────────────────────

/** Generic Elasticsearch request body shape. */
interface EsRequestBody {
  [key: string]: unknown
}

/** Generic Elasticsearch response shape. */
interface EsResponse {
  [key: string]: unknown
  /** Whether any bulk items failed. */
  errors?: boolean
  /** Result items from a bulk operation. */
  items?: Array<{ index?: { error?: unknown } }>
  /** Aggregation results. */
  aggregations?: Record<string, unknown>
  /** Document count from a count query. */
  count?: number
}

/** A single content block inside a pi message. */
interface MessageContent {
  /** Block discriminator. */
  type?: string
  /** Text content when type is 'text'. */
  text?: string
  /** Thinking content when type is 'thinking'. */
  thinking?: string
  /** Tool call ID when type is 'toolCall'. */
  id?: string
  /** Tool name when type is 'toolCall'. */
  name?: string
  /** Tool arguments when type is 'toolCall'. */
  arguments?: Record<string, unknown>
}

/** Token and cost usage for a single LLM turn. */
interface MessageUsage {
  /** Input token count. */
  input?: number
  /** Output token count. */
  output?: number
  /** Cache-read input tokens. */
  cacheRead?: number
  /** Cache-write input tokens. */
  cacheWrite?: number
  /** Total token count (or sum of input + output). */
  totalTokens?: number
  /** Cost breakdown in USD. */
  cost?: {
    total?: number
    input?: number
    output?: number
  }
}

/** A pi message object embedded in a session event. */
interface Message {
  /** Message role: user, assistant, toolResult, etc. */
  role?: string
  /** Content blocks (text, thinking, toolCall). */
  content?: Array<string | MessageContent> | unknown
  /** Token and cost usage. */
  usage?: MessageUsage
  /** Model identifier. */
  model?: string
  /** Provider identifier. */
  provider?: string
  /** API flavor (e.g. 'anthropic', 'openai'). */
  api?: string
  /** Stop reason from the LLM response. */
  stopReason?: string
  /** Epoch milliseconds timestamp. */
  timestamp?: number
  /** Associated tool call ID for toolResult messages. */
  toolCallId?: string
  /** Tool name for toolResult messages. */
  toolName?: string
  /** Provider-specific response ID. */
  responseId?: string
}

/** A single event from a pi session JSONL file. */
interface Event {
  /** Unique event ID. */
  id?: string
  /** Event discriminator: session, message, model_change, etc. */
  type?: string
  /** ISO-8601 timestamp. */
  timestamp?: string
  /** Parent event ID for building chains. */
  parentId?: string
  /** Payload when type is 'message'. */
  message?: Message
  /** New model ID when type is 'model_change'. */
  modelId?: string
  /** New provider when type is 'model_change'. */
  provider?: string
  /** New thinking level when type is 'thinking_level_change'. */
  thinkingLevel?: string
  /** Working directory when type is 'session'. */
  cwd?: string
}

/** Extracted tool call from an assistant message. */
interface ToolCall {
  /** Tool call ID. */
  id: string
  /** Tool name. */
  name: string
  /** Parsed arguments object. */
  arguments: Record<string, unknown>
  /** Serialized arguments JSON. */
  arguments_text: string
}

/** Extracted tool result for a given assistant turn. */
interface ToolResult {
  /** ID of the corresponding tool call. */
  tool_call_id: string
  /** Tool name. */
  tool_name: string
  /** Combined text output from the tool. */
  output: string
}

/** Final OTel GenAI span document written to Elasticsearch. */
interface SpanDocument {
  /** Dynamic span fields. */
  [key: string]: unknown
  /** OTel timestamp. */
  '@timestamp': string
  /** Span identifier. */
  'span.id': string
  /** Trace/session identifier. */
  'trace.id': string
  /** Human-readable span name. */
  'span.name': string
}

// ─── Elasticsearch helpers ──────────────────────────────────────────────────

/**
 * Send an HTTP request to Elasticsearch and return the parsed JSON response.
 */
async function esRequest (
  method: string,
  path: string,
  body?: EsRequestBody
): Promise<EsResponse> {
  const url = `${ES_URL}${path}`
  const response = await fetch(url, {
    method,
    headers: HEADERS,
    body: body != null ? JSON.stringify(body) : undefined,
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`ES ${method} ${path} => ${response.status}: ${text.slice(0, 600)}`)
  }

  return JSON.parse(text) as EsResponse
}

// ─── Provider mapping ───────────────────────────────────────────────────────

/**
 * Map from provider name fragments to gen_ai.system values.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
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

/**
 * Map a pi provider (and optional model hint) to an OTel gen_ai.system value.
 */
function inferSystem (provider: string, model: string): string {
  const p = (provider ?? '').toLowerCase()
  const m = (model ?? '').toLowerCase()

  for (const [k, v] of Object.entries(PROVIDER_TO_SYSTEM)) {
    if (p.includes(k)) {
      if (k === 'github-copilot' && (m.includes('gpt') || m.includes('o1') || m.includes('o3'))) {
        return 'openai'
      }
      return v
    }
  }

  if (m.includes('claude')) return 'anthropic'
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'openai'
  if (m.includes('gemini')) return 'google_ai_studio'
  return provider || 'unknown'
}

// ─── Walk parent chain to find nearest user message ─────────────────────────

/** Result of walking the parent chain to find the nearest user message. */
interface UserMessageResult {
  /** Text content of the user message. */
  text: string
  /** Event ID of the user message event, usable as an exchange grouping key. */
  eventId: string
}

/**
 * Walk the parent chain from an assistant message to find the most recent user
 * message, returning both its text and its event ID.
 */
function findUserMessage (
  eventById: Map<string, Event>,
  startParentId: string | undefined
): UserMessageResult | undefined {
  const visited = new Set<string>()
  let currentId = startParentId

  while (currentId != null && !visited.has(currentId)) {
    visited.add(currentId)
    const ev = eventById.get(currentId)
    if (ev == null) break

    if (ev.type === 'message') {
      const msg = ev.message ?? {}
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const parts: string[] = []
        for (const c of msg.content) {
          if (typeof c === 'object' && c != null && c.type === 'text') {
            const t = (c.text ?? '').trim()
            if (t.length > 0) parts.push(t)
          }
        }
        if (parts.length > 0) return { text: parts.join('\n'), eventId: ev.id ?? '' }
      }
    }

    currentId = ev.parentId
  }

  return undefined
}

/** Strip undefined values from an object in-place. */
function stripUndefined (obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key]
  }
}

// ─── Parse one session file's events → list of span docs ────────────────────

/**
 * Parse a list of session events into OTel GenAI span documents.
 */
function extractSpans (
  events: Event[],
  sessionDirName: string,
  sourceFile: string
): SpanDocument[] {
  const spans: SpanDocument[] = []
  let sessionId: string | undefined
  let sessionCwd = sessionDirName.replace(/--/g, '/').replace(/^\//, '')
  let sessionStartTs: string | undefined
  let currentModel: string | undefined
  let currentProvider: string | undefined
  let currentThinkingLevel: string | undefined

  const eventById = new Map<string, Event>()
  for (const ev of events) {
    if (ev.id != null) eventById.set(ev.id, ev)
  }

  const toolResultsByParent = new Map<string, Event[]>()
  for (const ev of events) {
    if (ev.type === 'message') {
      const msg = ev.message ?? {}
      if (msg.role === 'toolResult') {
        const pid = ev.parentId ?? ''
        if (pid.length > 0) {
          const list = toolResultsByParent.get(pid) ?? []
          list.push(ev)
          toolResultsByParent.set(pid, list)
        }
      }
    }
  }

  for (const ev of events) {
    if (ev.type === 'session') {
      sessionId = ev.id ?? sessionId
      sessionStartTs = ev.timestamp ?? sessionStartTs
      if (ev.cwd != null) sessionCwd = ev.cwd
    } else if (ev.type === 'model_change') {
      currentModel = ev.modelId ?? currentModel
      currentProvider = ev.provider ?? currentProvider
    } else if (ev.type === 'thinking_level_change') {
      currentThinkingLevel = ev.thinkingLevel
    } else if (ev.type === 'message') {
      const msg = ev.message ?? {}
      if (msg.role !== 'assistant') continue

      const usage = msg.usage ?? {}
      const inputTokens = usage.input ?? 0
      const outputTokens = usage.output ?? 0
      const cacheRead = usage.cacheRead ?? 0
      const cacheWrite = usage.cacheWrite ?? 0
      const totalTokens = usage.totalTokens ?? (inputTokens + outputTokens)

      const cost = usage.cost ?? {}
      const costTotal = cost.total ?? 0
      const costInput = cost.input ?? 0
      const costOutput = cost.output ?? 0

      const model = msg.model ?? currentModel ?? 'unknown'
      const provider = msg.provider ?? currentProvider ?? 'unknown'
      const api = msg.api ?? ''
      const stopReason = msg.stopReason ?? ''

      const evTs = ev.timestamp
      const msgTs = msg.timestamp
      let timestamp: string
      if (evTs != null) {
        timestamp = evTs
      } else if (msgTs != null) {
        timestamp = new Date(msgTs).toISOString()
      } else {
        timestamp = sessionStartTs ?? new Date().toISOString()
      }

      let durationMs: number | undefined
      const parentId = ev.parentId
      if (parentId != null) {
        const parentEv = eventById.get(parentId)
        const parentTs = parentEv?.timestamp
        if (parentTs != null && evTs != null) {
          const t1 = new Date(parentTs).getTime()
          const t2 = new Date(evTs).getTime()
          const ms = t2 - t1
          if (!Number.isNaN(ms) && ms >= 0) durationMs = ms
        }
      }

      const content = Array.isArray(msg.content) ? msg.content : []

      const textParts: string[] = []
      const thinkingParts: string[] = []
      const toolCalls: ToolCall[] = []

      for (const c of content) {
        if (c == null || typeof c !== 'object') continue
        const ct = (c as MessageContent).type
        if (ct === 'text') {
          const t = ((c as MessageContent).text ?? '').trim()
          if (t.length > 0) textParts.push(t)
        } else if (ct === 'thinking') {
          const t = ((c as MessageContent).thinking ?? '').trim()
          if (t.length > 0) thinkingParts.push(t)
        } else if (ct === 'toolCall') {
          const args = (c as MessageContent).arguments ?? {}
          toolCalls.push({
            id: (c as MessageContent).id ?? '',
            name: (c as MessageContent).name ?? '',
            arguments: args,
            arguments_text: Object.keys(args).length > 0
              ? JSON.stringify(args)
              : '',
          })
        }
      }

      const toolResults: ToolResult[] = []
      const evId = ev.id ?? ''
      for (const trEv of toolResultsByParent.get(evId) ?? []) {
        const trMsg = trEv.message ?? {}
        const trParts: string[] = []
        const trContent = Array.isArray(trMsg.content) ? trMsg.content : []
        for (const c of trContent) {
          if (c == null || typeof c !== 'object') continue
          if ((c as MessageContent).type === 'text') {
            const t = ((c as MessageContent).text ?? '').trim()
            if (t.length > 0) trParts.push(t)
          }
        }
        toolResults.push({
          tool_call_id: trMsg.toolCallId ?? '',
          tool_name: trMsg.toolName ?? '',
          output: trParts.join('\n'),
        })
      }

      const userMessage = findUserMessage(eventById, ev.parentId)
      const userText = userMessage?.text
      const exchangeId = userMessage?.eventId
      const genAiSystem = inferSystem(provider, model)

      const span: Record<string, unknown> = {
        '@timestamp': timestamp,
        'span.id': evId,
        'trace.id': sessionId ?? path.basename(path.dirname(sourceFile)),
        'parent.id': ev.parentId,
        'span.name': `gen_ai chat ${model}`,
        ...(durationMs != null ? { 'duration.us': durationMs * 1000 } : {}),

        'gen_ai.system': genAiSystem,
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': model,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': stopReason.length > 0 ? [stopReason] : [],
        'gen_ai.usage.input_tokens': inputTokens,
        'gen_ai.usage.output_tokens': outputTokens,
        'gen_ai.usage.cache_read_input_tokens': cacheRead,
        'gen_ai.usage.cache_creation_input_tokens': cacheWrite,
        'gen_ai.usage.total_tokens': totalTokens,

        'pi.turn.exchange_id': exchangeId,
        'message.user.text': userText,
        ...(textParts.length > 0
          ? { 'message.assistant.text': textParts.join('\n\n') }
          : {}),
        ...(thinkingParts.length > 0
          ? { 'message.assistant.thinking': thinkingParts.join('\n\n') }
          : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(toolResults.length > 0 ? { tool_results: toolResults } : {}),
        'turn.tool_call_count': toolCalls.length,
        'turn.tool_result_count': toolResults.length,

        'pi.session.id': sessionId,
        'pi.session.cwd': sessionCwd,
        'pi.session.start': sessionStartTs,
        'pi.turn.id': evId,
        'pi.turn.parent_id': ev.parentId,
        'pi.model.provider': provider,
        'pi.model.api': api.length > 0 ? api : undefined,
        'pi.thinking_level': currentThinkingLevel,
        'pi.thinking.present': thinkingParts.length > 0,
        'pi.source_file': sourceFile,
        'pi.response_id': msg.responseId,

        'cost.total_usd': costTotal,
        'cost.input_usd': costInput,
        'cost.output_usd': costOutput,

        'service.name': 'pi-coding-agent',
        'telemetry.sdk.name': 'pi-session-etl',
      }

      stripUndefined(span)

      spans.push(span as SpanDocument)
    }
  }

  return spans
}

/**
 * Read all JSONL files in a session directory and produce span documents.
 */
async function parseSessionDir (sessionDir: string): Promise<SpanDocument[]> {
  const spans: SpanDocument[] = []
  const entries = await fs.promises.readdir(sessionDir)
  const jsonlFiles = entries
    .filter((f) => f.endsWith('.jsonl'))
    .sort()

  for (const file of jsonlFiles) {
    const filePath = path.join(sessionDir, file)
    const events: Event[] = []

    try {
      const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

      for await (const line of rl) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          events.push(JSON.parse(trimmed) as Event)
        } catch {
          /* ignore malformed JSON lines */
        }
      }
    } catch {
      /* ignore unreadable files */
      continue
    }

    if (events.length > 0) {
      spans.push(
        ...extractSpans(events, path.basename(sessionDir), filePath)
      )
    }
  }

  return spans
}

// ─── Index mapping ──────────────────────────────────────────────────────────

/** Elasticsearch index mapping for OTel GenAI spans. */
const MAPPING: EsRequestBody = {
  mappings: {
    properties: {
      '@timestamp': { type: 'date' },
      'span.id': { type: 'keyword' },
      'trace.id': { type: 'keyword' },
      'parent.id': { type: 'keyword' },
      'span.name': { type: 'keyword' },
      'duration.us': { type: 'long' },

      'gen_ai.system': { type: 'keyword' },
      'gen_ai.operation.name': { type: 'keyword' },
      'gen_ai.request.model': { type: 'keyword' },
      'gen_ai.response.model': { type: 'keyword' },
      'gen_ai.response.finish_reasons': { type: 'keyword' },
      'gen_ai.usage.input_tokens': { type: 'long' },
      'gen_ai.usage.output_tokens': { type: 'long' },
      'gen_ai.usage.cache_read_input_tokens': { type: 'long' },
      'gen_ai.usage.cache_creation_input_tokens': { type: 'long' },
      'gen_ai.usage.total_tokens': { type: 'long' },

      'message.user.text': {
        type: 'text',
        fields: { keyword: { type: 'keyword', ignore_above: 512 } },
      },
      'message.assistant.text': {
        type: 'text',
        fields: { keyword: { type: 'keyword', ignore_above: 512 } },
      },
      'message.assistant.thinking': {
        type: 'text',
        fields: { keyword: { type: 'keyword', ignore_above: 512 } },
      },

      tool_calls: {
        type: 'nested',
        properties: {
          id: { type: 'keyword' },
          name: { type: 'keyword' },
          arguments_text: { type: 'text' },
          arguments: { type: 'object', enabled: false },
        },
      },
      tool_results: {
        type: 'nested',
        properties: {
          tool_call_id: { type: 'keyword' },
          tool_name: { type: 'keyword' },
          output: { type: 'text' },
        },
      },
      'turn.tool_call_count': { type: 'integer' },
      'turn.tool_result_count': { type: 'integer' },

      'pi.session.id': { type: 'keyword' },
      'pi.session.cwd': { type: 'keyword' },
      'pi.session.start': { type: 'date' },
      'pi.turn.exchange_id': { type: 'keyword' },
      'pi.turn.id': { type: 'keyword' },
      'pi.turn.parent_id': { type: 'keyword' },
      'pi.model.provider': { type: 'keyword' },
      'pi.model.api': { type: 'keyword' },
      'pi.thinking_level': { type: 'keyword' },
      'pi.thinking.present': { type: 'boolean' },
      'pi.source_file': { type: 'keyword' },
      'pi.response_id': { type: 'keyword' },

      'cost.total_usd': { type: 'float' },
      'cost.input_usd': { type: 'float' },
      'cost.output_usd': { type: 'float' },

      'service.name': { type: 'keyword' },
      'telemetry.sdk.name': { type: 'keyword' },
    },
  },
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Main entry point: scan sessions, extract spans, and index into Elasticsearch.
 */
async function main (): Promise<void> {
  console.log(`Scanning sessions in: ${SESSIONS_ROOT}`)

  let sessionDirs: string[]
  try {
    const entries = await fs.promises.readdir(SESSIONS_ROOT, {
      withFileTypes: true,
    })
    sessionDirs = entries
      .filter((d) => d.isDirectory())
      .map((d) => path.join(SESSIONS_ROOT, d.name))
      .sort()
  } catch (err) {
    console.error(`Failed to read sessions root: ${SESSIONS_ROOT}`, err)
    process.exit(1)
  }

  console.log(`Found ${sessionDirs.length} session directories\n`)

  const allSpans: SpanDocument[] = []
  for (let i = 0; i < sessionDirs.length; i++) {
    const sd = sessionDirs[i]
    const spans = await parseSessionDir(sd)
    if (spans.length > 0) {
      const label = path.basename(sd).slice(0, 60)
      console.log(`  [${String(i + 1).padStart(2, '0')}/${sessionDirs.length}] ${label.padEnd(60)} ${String(spans.length).padStart(5)} spans`)
    }
    allSpans.push(...spans)
  }

  console.log(`\nTotal spans extracted: ${allSpans.length}`)

  if (allSpans.length === 0) {
    console.log('Nothing to index.')
    return
  }

  // Delete + recreate index
  console.log(`\nDeleting index '${INDEX}' if it exists...`)
  try {
    await esRequest('DELETE', `/${INDEX}`)
    console.log('  Deleted.')
  } catch (err) {
    console.log('  (not found — skipping)')
  }

  console.log(`Creating index '${INDEX}' with mapping...`)
  await esRequest('PUT', `/${INDEX}`, MAPPING)
  console.log('  Created.\n')

  // Bulk index in batches
  const BATCH = 250
  let indexed = 0
  let errors = 0

  console.log(`Indexing ${allSpans.length} spans...`)
  for (let i = 0; i < allSpans.length; i += BATCH) {
    const batch = allSpans.slice(i, i + BATCH)
    const lines: string[] = []

    for (const span of batch) {
      const docId = (span['pi.response_id'] as string | undefined) ??
        (span['span.id'] as string) ??
        `span-${i}`
      lines.push(JSON.stringify({ index: { _index: INDEX, _id: docId } }))
      lines.push(JSON.stringify(span))
    }

    const body = lines.join('\n') + '\n'
    const response = await fetch(`${ES_URL}/_bulk`, {
      method: 'POST',
      headers: {
        ...HEADERS,
        'Content-Type': 'application/x-ndjson',
      },
      body,
    })

    const result = (await response.json()) as EsResponse

    if (result.errors) {
      for (const item of result.items ?? []) {
        const idx = item.index ?? {}
        if (idx.error != null) {
          errors += 1
          if (errors <= 5) {
            console.log(`  ⚠ Error: ${JSON.stringify(idx.error).slice(0, 200)}`)
          }
        } else {
          indexed += 1
        }
      }
    } else {
      indexed += batch.length
    }

    if (Math.floor(i / BATCH) % 10 === 0) {
      console.log(`  ... ${indexed.toLocaleString()} indexed so far`)
    }
  }

  console.log(`\n✅  Indexed: ${indexed.toLocaleString()}   Errors: ${errors}`)

  // Post-index stats
  console.log('\n' + '='.repeat(60))
  await esRequest('POST', `/${INDEX}/_refresh`)
  const countRes = await esRequest('GET', `/${INDEX}/_count`)
  console.log(`Total docs in '${INDEX}': ${(countRes.count ?? 0).toLocaleString()}`)

  console.log('\n🔢 Top models by call count:')
  const modelRes = await esRequest('POST', `/${INDEX}/_search`, {
    size: 0,
    aggs: {
      by_model: { terms: { field: 'gen_ai.request.model', size: 12 } },
    },
  })
  const modelBuckets =
    ((modelRes.aggregations?.by_model as Record<string, unknown>)?.buckets as
      Array<{ key: string; doc_count: number }>) ?? []
  for (const b of modelBuckets) {
    console.log(`   ${b.key.padEnd(40)} ${String(b.doc_count).padStart(6)} calls`)
  }

  console.log('\n📊 Token usage by provider:')
  const providerRes = await esRequest('POST', `/${INDEX}/_search`, {
    size: 0,
    aggs: {
      by_provider: {
        terms: { field: 'pi.model.provider', size: 10 },
        aggs: {
          in: { sum: { field: 'gen_ai.usage.input_tokens' } },
          out: { sum: { field: 'gen_ai.usage.output_tokens' } },
          cr: { sum: { field: 'gen_ai.usage.cache_read_input_tokens' } },
        },
      },
    },
  })
  const providerBuckets =
    ((providerRes.aggregations?.by_provider as Record<string, unknown>)?.buckets as
      Array<{
        key: string
        doc_count: number
        in: { value: number }
        out: { value: number }
        cr: { value: number }
      }>) ?? []
  for (const b of providerBuckets) {
    const inp = Math.round(b.in.value)
    const out = Math.round(b.out.value)
    const cr = Math.round(b.cr.value)
    console.log(
      `   ${b.key.padEnd(20)} ${String(b.doc_count).padStart(5)} calls  in=${inp.toLocaleString().padStart(12)}  out=${out.toLocaleString().padStart(10)}  cache_read=${cr.toLocaleString().padStart(14)}`
    )
  }

  console.log('\n🛠  Tool calls distribution:')
  const toolRes = await esRequest('POST', `/${INDEX}/_search`, {
    size: 0,
    aggs: {
      tc_stats: { stats: { field: 'turn.tool_call_count' } },
      thinking: { filter: { term: { 'pi.thinking.present': true } } },
      with_tools: { filter: { range: { 'turn.tool_call_count': { gt: 0 } } } },
    },
  })
  const tc =
    (toolRes.aggregations?.tc_stats as {
      min?: number
      max?: number
      avg?: number
      sum?: number
    }) ?? {}
  const wt = (toolRes.aggregations?.thinking as { doc_count?: number })?.doc_count ?? 0
  const wtools =
    (toolRes.aggregations?.with_tools as { doc_count?: number })?.doc_count ?? 0
  console.log(
    `   min=${tc.min ?? 0}  max=${tc.max ?? 0}  avg=${(tc.avg ?? 0).toFixed(2)}  total=${Math.round(tc.sum ?? 0).toLocaleString()}`
  )
  console.log(`   Turns with ≥1 tool call:    ${wtools.toLocaleString()}`)
  console.log(`   Turns with extended thinking: ${wt.toLocaleString()}`)

  console.log('\n🔧 Top tools used:')
  const topToolsRes = await esRequest('POST', `/${INDEX}/_search`, {
    size: 0,
    aggs: {
      tools: {
        nested: { path: 'tool_calls' },
        aggs: {
          by_name: { terms: { field: 'tool_calls.name', size: 15 } },
        },
      },
    },
  })
  const toolBuckets =
    (((topToolsRes.aggregations?.tools as Record<string, unknown>)?.by_name as
      Record<string, unknown>)?.buckets as Array<{ key: string; doc_count: number }>) ?? []
  for (const b of toolBuckets) {
    console.log(`   ${b.key.padEnd(30)} ${String(b.doc_count).padStart(6)} calls`)
  }

  console.log('\n📁 Top working directories:')
  const cwdRes = await esRequest('POST', `/${INDEX}/_search`, {
    size: 0,
    aggs: {
      by_cwd: { terms: { field: 'pi.session.cwd', size: 12 } },
    },
  })
  const cwdBuckets =
    ((cwdRes.aggregations?.by_cwd as Record<string, unknown>)?.buckets as
      Array<{ key: string; doc_count: number }>) ?? []
  for (const b of cwdBuckets) {
    console.log(`   ${b.key.padEnd(55)} ${String(b.doc_count).padStart(5)} spans`)
  }

  console.log(`\nIndex: ${ES_URL}/${INDEX}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
