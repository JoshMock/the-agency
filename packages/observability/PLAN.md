# Implementation Plan: OTel SDK Logs sinks

## Context

`index.ts` has a fully-built `SpanDocument` object and a no-op `emit(span, docId)` stub.
The goal is to replace that stub with a real `LoggerProvider` that fans out to:

1. **File (JSONL)** — always on; writes one file per session to `~/.pi/observability/`
   (restoring the original behavior described in the README)
2. **OTLP** — active only when `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` is set; all other
   OTLP config (`headers`, `timeout`, `protocol`, batch tuning) flows through standard
   `OTEL_*` env vars automatically with no extra code

Each `SpanDocument` is passed as `attributes` on the `LogRecord` so the full flat
structure is preserved in both sinks.

---

## Milestone 1: Dependencies

### Task 1.1 — Add packages to `package.json`

Add to npm dependencies:

- `@opentelemetry/sdk-logs`
- `@opentelemetry/api-logs`
- `@opentelemetry/exporter-logs-otlp-http`

```json
```

`@opentelemetry/sdk-logs` provides `LoggerProvider`, `BatchLogRecordProcessor`,
`SimpleLogRecordProcessor`, and `ConsoleLogRecordExporter`.
`@opentelemetry/exporter-logs-otlp-http` provides `OTLPLogExporter` (covers
`http/json` and `http/protobuf` protocols; gRPC is a separate package not needed here).
`@opentelemetry/api-logs` provides `SeverityNumber`.

---

## Milestone 2: FileJsonlExporter

A simple custom `LogRecordExporter` that writes one JSON line per record to a file.

### Task 2.1 — Create `file-exporter.ts`

```typescript
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExportResult } from '@opentelemetry/core'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'

export class FileJsonlExporter implements LogRecordExporter {
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    mkdirSync(dirname(filePath), { recursive: true })
  }

  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    try {
      for (const record of records) {
        appendFileSync(this.filePath, JSON.stringify(record.attributes) + '\n', 'utf8')
      }
      resultCallback({ code: 0 })  // ExportResultCode.SUCCESS
    } catch (err) {
      resultCallback({ code: 1, error: err as Error })  // ExportResultCode.FAILED
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
```

Note: `appendFileSync` is used intentionally — the `BatchLogRecordProcessor` already
calls `export` from outside the hot path, so synchronous I/O here is fine and avoids
managing open file handles.

Add a small `otel` status pill to the Pi TUI if possible. Green for `on`, red for `off` + name what exporter is running (e.g. `otel: file` in green when file exporter is on and working)

### Task 2.2 — Tests for `FileJsonlExporter`

In `index.test.ts`, add a `describe('FileJsonlExporter')` block that:

- Exports two `ReadableLogRecord`-shaped objects to a temp file path
- Reads the file back, splits on newline, parses each JSON line
- Asserts `attributes` round-trips correctly
- Asserts `resultCallback` is called with `code: 0`
- Asserts a failed write (unwritable path) calls `resultCallback` with `code: 1`

Use `node:os` `tmpdir()` + a random suffix for the temp file path; clean up in
each test with `fs.unlinkSync` inside a try/finally.

---

## Milestone 3: Wire `emit()` to `LoggerProvider`

### Task 3.1 — Add `buildLoggerProvider()` to `index.ts`

Add a function inside the default export (after the variable declarations, before the
event handlers) that constructs the provider with the correct set of processors:

```typescript
function buildLoggerProvider(filePath: string) {
  const { LoggerProvider, BatchLogRecordProcessor } = await import('@opentelemetry/sdk-logs')
  // ... or top-level import

  const processors = [
    new BatchLogRecordProcessor(new FileJsonlExporter(filePath)),
  ]

  if (process.env['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT'] != null) {
    const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-http')
    processors.push(new BatchLogRecordProcessor(new OTLPLogExporter()))
    // OTLPLogExporter() with no args reads all OTEL_EXPORTER_OTLP_* env vars automatically
  }

  const provider = new LoggerProvider({ processors })
  return provider.getLogger('pi-observability')
}
```

Use top-level static imports (not dynamic) since the packages are real deps and
Node's type stripping handles them fine. The `if` check on the env var controls
which processors are registered.

### Task 3.2 — Derive the output file path

The file path follows the same convention as the original package:
`~/.pi/observability/YYYY-MM-DD-<sessionId[0:8]>.jsonl`

Add a helper:

```typescript
function observabilityFilePath(sessionId: string): string {
  const date = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp'
  return `${home}/.pi/observability/${date}-${sessionId.slice(0, 8)}.jsonl`
}
```

### Task 3.3 — Initialize provider in `session_start`

After `sessionId` is set in the `session_start` handler:

```typescript
const filePath = observabilityFilePath(sessionId)
otelLogger = buildLoggerProvider(filePath)
```

Declare `let otelLogger` at the top of the default export function alongside the
other state variables (typed as `Logger | undefined`).

### Task 3.4 — Replace no-op `emit()`

```typescript
function emit(span: SpanDocument, _docId: string): void {
  if (otelLogger == null) return
  otelLogger.emit({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: span['span.name'] as string,
    attributes: span as Record<string, unknown>,
  })
}
```

The full `SpanDocument` lands in `attributes`; both the file exporter and the OTLP
exporter preserve it verbatim.

### Task 3.5 — Shut down provider on session end

Verified: `session_shutdown` is defined in `ExtensionAPI` at
`node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts` line 676:
```typescript
on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
```

Use it directly — no fallback needed:

```typescript
pi.on('session_shutdown', async () => {
  await provider?.shutdown()
})
```

`shutdown()` flushes all buffered records in the `BatchLogRecordProcessor` before resolving.
Because pi awaits extension shutdown handlers, records will not be lost at exit.
Print the flush status to Pi TUI during shutdown so user understands any delay.

---

## Milestone 4: README update

### Task 4.1 — Update README

Replace the "Output location" section with:

- **Default (file):** JSONL is written to `~/.pi/observability/YYYY-MM-DD-<id[0:8]>.jsonl`
  one file per session; directory is created automatically.
- **OTLP (opt-in):** Set `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` to activate. All standard
  `OTEL_EXPORTER_OTLP_*` env vars are respected automatically (headers, protocol,
  timeout, batch tuning). Example:
  ```bash
  export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4318/v1/logs
  export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer your-token"
  ```

Remove the outdated Elasticsearch bulk-index example (that workflow is now handled by
pointing the OTLP endpoint at a collector or directly at Elastic's OTLP ingest).

---

## Key decisions captured

- **`BatchLogRecordProcessor` over `Simple`** — async batching by default; behavior
  tunable via `OTEL_BLRP_*` env vars without code changes.
- **`appendFileSync` in `FileJsonlExporter`** — batch processor calls `export` off the
  hot path; sync I/O is simpler and avoids open file handle management.
- **`OTLPLogExporter()` with no constructor args** — lets the OTel spec env vars do all
  the work; adding the exporter to the processor array is the only code required.
- **No gRPC package** — `@opentelemetry/exporter-logs-otlp-http` covers `http/json`
  and `http/protobuf`; gRPC is a separate install if ever needed.
- **`attributes: span`** — the full flat `SpanDocument` is preserved in both sinks
  without any re-mapping.
