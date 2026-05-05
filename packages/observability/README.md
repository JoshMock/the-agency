# @the-agency/pi-observability

Observability extension for [Pi](https://github.com/badlogic/pi-mono). Emits one OpenTelemetry GenAI-compatible span document per assistant turn and writes it through OTel SDK Logs exporters.

## Features

- **OTel GenAI span shape**: output uses OpenTelemetry format and conventions
- **Default file sink**: JSONL output is always written to `~/.pi/observability/` (one file per session)
- **Optional OTLP sink**: enabled when `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set
- **Standard OTel configuration**: OTLP protocol, headers, timeout, and batch behavior are controlled by normal `OTEL_*` environment variables
- **Rich runtime context**: captures skills, tools, active commands, exchange IDs, model/provider metadata, token usage, and tool call/result summaries

## Output location

By default, this extension writes JSONL to:

```text
~/.pi/observability/YYYY-MM-DD-<sessionId[0:8]>.jsonl
```

- One file is created per Pi session.
- The directory is created automatically.
- Each line is one flat span document.

## OTLP export (opt-in)

Set `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` to enable OTLP logs export in addition to file output.

Example:

```bash
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4318/v1/logs
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your-token"
```

When OTLP is enabled, the exporter uses standard OpenTelemetry environment variables automatically (for example headers, protocol, timeout, and batch tuning) without extension-specific config.

## Installation

### Project-local (recommended)

Add to `.pi/settings.json` in your project:

```json
{
  "packages": ["./packages/observability"]
}
```

### Global

```bash
pi install ./packages/observability
```

Or link directly in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["/absolute/path/to/packages/observability"]
}
```

## Notes

- File export is always active.
- OTLP export is additive and only active when `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set.
- On session shutdown, the extension flushes batched records before exit.
