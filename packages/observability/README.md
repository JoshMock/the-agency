# @the-agency/pi-observability

Pi extension that emits one [OTel GenAI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)-compatible span per assistant turn. Spans are always exported — to an OTLP collector when one is configured, or to local JSONL files otherwise.

## What it captures

Each span represents one LLM API call and includes:

- OTel GenAI semantic convention attributes (`gen_ai.*`)
- Token usage and cost per turn (`gen_ai.usage.*`, `cost.*`)
- Full assistant text, thinking blocks, tool calls, and tool results
- User message text (skill injection blocks stripped)
- Session context: working directory, session file, session ID, active skills, tools, and registered commands
- Model and provider info, thinking level, response ID
- A stable `pi.turn.exchange_id` grouping all turns from one user prompt

## Sinks

### File sink (default)

When no OTLP endpoint is configured, spans are written to daily JSONL files:

```
~/.pi/observability/YYYY-MM-DD.jsonl
```

One JSON object per line, one file per day. Useful for local inspection with `jq` or importing into any tool that accepts JSONL.

The status bar shows `⬡ otlp:file`.

### OTLP sink

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send spans to any OTLP-compatible backend (Grafana Tempo, Jaeger, Elastic APM, Honeycomb, Datadog, etc.).

| Variable | Description |
|----------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP collector URL (e.g. `http://localhost:4318`) |
| `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `key=value` auth headers |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` (default), `http/protobuf`, or `grpc` |
| `OTEL_SERVICE_NAME` | Overrides the default service name (`pi-coding-agent`) |

These are the standard [OpenTelemetry environment variables](https://opentelemetry.io/docs/specs/otel/protocol/exporter/) — no extension-specific configuration required.

The status bar shows `⬡ otlp:<host>` where `<host>` is the collector's hostname and port.

## Span attributes

| Attribute | Type | Description |
|-----------|------|-------------|
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
| `tool_calls` | json | `{id, name, arguments, arguments_text}` per call |
| `tool_results` | json | `{tool_call_id, tool_name, output}` per result |
| `turn.tool_call_count` | long | |
| `turn.tool_result_count` | long | |
| `pi.session.id` | keyword | Stable session UUID (also used as OTel trace ID) |
| `pi.session.cwd` | keyword | Working directory |
| `pi.session.start` | ISO-8601 | Session start time |
| `pi.session.file` | keyword | Path to the `.pi` session file |
| `pi.session.skills` | json | `{name, path, source, scope}` for each loaded skill |
| `pi.session.skill_names` | keyword[] | Skill names only |
| `pi.session.tools` | json | `{name, source, scope}` for each active tool |
| `pi.session.active_tools` | keyword[] | Active tool names only |
| `pi.session.commands` | keyword[] | Registered slash command names |
| `pi.turn.exchange_id` | keyword | UUID shared across all turns in one user prompt |
| `pi.model.provider` | keyword | Raw provider name from pi |
| `pi.model.api` | keyword | API identifier |
| `pi.thinking_level` | keyword | Thinking level if set |
| `pi.thinking.present` | boolean | Whether a thinking block was present |
| `pi.response_id` | keyword | Provider response ID |
| `cost.total_usd` | float | |
| `cost.input_usd` | float | |
| `cost.output_usd` | float | |

Attributes with no value are omitted.

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

## Examples

### Local file sink (no configuration needed)

```bash
pi chat
# spans written to ~/.pi/observability/YYYY-MM-DD.jsonl
```

Inspect with `jq`:

```bash
jq '.attributes["gen_ai.usage.input_tokens"]' ~/.pi/observability/$(date +%Y-%m-%d).jsonl
```

### Send to a local OTel collector

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
pi chat
```

### Send to Elastic APM

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://your-cluster.apm.us-east-1.aws.cloud.es.io
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your_secret_token"
pi chat
```
