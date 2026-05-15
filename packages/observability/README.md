# @the-agency/pi-observability

Pi extension that emits one [OTel GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)-compatible span document per assistant turn. Documents are written to a configurable sink (Elasticsearch by default) and share a schema with `pi-sessions-to-otel.ts` so both sources index into the same index without mapping conflicts.

## What it captures

Each span document represents one LLM API call and includes:

- OTel GenAI semantic convention fields (`gen_ai.*`)
- Token usage and cost per turn (`gen_ai.usage.*`, `cost.*`)
- Full assistant text, thinking blocks, tool calls, and tool results
- User message text (skill injection blocks stripped)
- Session context: working directory, session file, session ID, active skills, tools, and registered commands
- Model and provider info, thinking level, response ID
- A stable `pi.turn.exchange_id` grouping all turns from one user prompt

## Schema

All documents share these top-level fields:

| Field | Type | Description |
|-------|------|-------------|
| `@timestamp` | ISO-8601 | When the assistant turn completed |
| `span.id` | UUID | Unique span identifier |
| `trace.id` | string | Session ID (groups all spans in one session) |
| `span.name` | string | `gen_ai chat <model>` |
| `duration.us` | long | Turn duration in microseconds |
| `gen_ai.system` | keyword | Normalized provider name (e.g. `anthropic`, `openai`) |
| `gen_ai.operation.name` | keyword | Always `chat` |
| `gen_ai.request.model` | keyword | Model ID sent in the request |
| `gen_ai.response.model` | keyword | Model ID returned in the response |
| `gen_ai.response.finish_reasons` | keyword[] | Stop reason(s) from the provider |
| `gen_ai.usage.input_tokens` | long | |
| `gen_ai.usage.output_tokens` | long | |
| `gen_ai.usage.cache_read_input_tokens` | long | |
| `gen_ai.usage.cache_creation_input_tokens` | long | |
| `gen_ai.usage.total_tokens` | long | |
| `message.user.text` | text | User prompt text |
| `message.assistant.text` | text | Assistant response text |
| `message.assistant.thinking` | text | Thinking block content, if present |
| `tool_calls` | object[] | `{id, name, arguments, arguments_text}` per call |
| `tool_results` | object[] | `{tool_call_id, tool_name, output}` per result |
| `turn.tool_call_count` | long | |
| `turn.tool_result_count` | long | |
| `pi.session.id` | keyword | Stable session UUID |
| `pi.session.cwd` | keyword | Working directory |
| `pi.session.start` | ISO-8601 | Session start time |
| `pi.session.file` | keyword | Path to the `.pi` session file |
| `pi.session.skills` | object[] | `{name, path, source, scope}` for each loaded skill |
| `pi.session.skill_names` | keyword[] | Skill names only |
| `pi.session.tools` | object[] | `{name, source, scope}` for each active tool |
| `pi.session.active_tools` | keyword[] | Active tool names only |
| `pi.session.commands` | keyword[] | Registered slash command names |
| `pi.turn.exchange_id` | keyword | UUID shared across all turns in one user prompt |
| `pi.model.provider` | keyword | Raw provider name from pi |
| `pi.model.api` | keyword | API identifier |
| `pi.thinking_level` | keyword | Thinking level if set |
| `pi.thinking.present` | boolean | Whether a thinking block was present |
| `pi.response_id` | keyword | Provider response ID (used as ES `_id`) |
| `cost.total_usd` | float | |
| `cost.input_usd` | float | |
| `cost.output_usd` | float | |
| `service.name` | keyword | Always `pi-coding-agent` |
| `telemetry.sdk.name` | keyword | Always `pi-observability-extension` |

Fields with no value are omitted (not written as `null`).

## `pi-sessions-to-otel.ts`

A standalone ETL script that reads existing pi session JSONL files and bulk-indexes them into Elasticsearch. Produces the same schema as the live extension so historical and live data share one index.

### Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PI_OTEL_ES_URL` | yes | — | Elasticsearch base URL |
| `PI_OTEL_ES_API_KEY` | yes | — | Elasticsearch API key |
| `PI_OTEL_INDEX` | no | `pi-otel-genai-spans` | Target index name |
| `PI_OTEL_SESSIONS_ROOT` | no | `~/.pi/agent/sessions` | Root directory of pi session folders |

### Usage

```bash
PI_OTEL_ES_URL=http://localhost:9200 \
PI_OTEL_ES_API_KEY=your_key \
node --experimental-transform-types pi-sessions-to-otel.ts
```

## Installation

### Project-local

Add to `.pi/settings.json` in your project:

```json
{
  "packages": ["npm:@the-agency/pi-observability"]
}
```

### Global

```bash
pi install npm:@the-agency/pi-observability
```
