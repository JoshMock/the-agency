# Research: npm packages for multi-sink observability streaming

**Goal:** find npm packages that accept a pre-built structured object once and fan it out
to multiple output sinks (Elasticsearch, Loki, CloudWatch, OTLP collectors, files, etc.)
with as little custom code as possible.

## Context

The current `index.ts` emits a pre-flattened OTel/ECS-hybrid `SpanDocument` object via
a no-op `emit(span, docId)` stub. The object already has all semantic fields set
(`@timestamp`, `span.id`, `gen_ai.*`, `pi.*`, etc.). The question is what library
should back that stub to deliver documents to one or more configurable destinations.

---

## Candidate 1: `@opentelemetry/sdk-logs` + exporter packages

**npm packages:** `@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`,
`@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/exporter-logs-otlp-grpc`,
`@opentelemetry/exporter-logs-otlp-proto`

**Version (all):** 0.216.0 (experimental)

**How multi-sink works:** `LoggerProvider` accepts an array of `processors` at
construction time. Each processor wraps one exporter. Adding more sinks = adding more
processors to the array. This is the SDK's native fan-out mechanism.

```typescript
import {
  LoggerProvider,
  BatchLogRecordProcessor,
  SimpleLogRecordProcessor,
  ConsoleLogRecordExporter,
} from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'

const provider = new LoggerProvider({
  processors: [
    new SimpleLogRecordProcessor(new ConsoleLogRecordExporter()),
    new BatchLogRecordProcessor(new OTLPLogExporter({ url: 'http://localhost:4318/v1/logs' })),
    // add more exporters here with zero new logic
  ],
})
const logger = provider.getLogger('pi-observability')

// in emit():
logger.emit({
  severityText: 'INFO',
  body: JSON.stringify(span),
  attributes: span as Record<string, unknown>,
})
```

**Available exporters (official):**
- `@opentelemetry/exporter-logs-otlp-http` — OTLP over HTTP/JSON (→ Grafana, Jaeger, any OpenTelemetry Collector)
- `@opentelemetry/exporter-logs-otlp-grpc` — OTLP over gRPC
- `@opentelemetry/exporter-logs-otlp-proto` — OTLP over HTTP/protobuf
- `ConsoleLogRecordExporter` — built into `@opentelemetry/sdk-logs`, no extra package
- Custom exporter = implement `LogRecordExporter` interface (two methods: `export`, `shutdown`)

**OTLP Collector = universal bridge:** Routing through the OpenTelemetry Collector
(`otel/opentelemetry-collector`) lets a single OTLP exporter fan out to Elasticsearch,
Loki, Datadog, CloudWatch, and more from a YAML config file, with no app code changes.

**Processor types:**
- `SimpleLogRecordProcessor` — synchronous, good for low-volume / development
- `BatchLogRecordProcessor` — async batching, configurable via env vars
  (`OTEL_BLRP_MAX_QUEUE_SIZE`, `OTEL_BLRP_EXPORT_TIMEOUT`, etc.) per the
  [OpenTelemetry SDK configuration spec](https://opentelemetry.io/docs/languages/sdk-configuration/general/)

**Fit to this package:** Very high. The data is already structured as an OTel span
document. Wrapping it in a `LogRecord` is two lines. The `processors` array is the
canonical single-config-point fan-out. The package stays zero-dependency at runtime
until the user opts in to a specific exporter.

**Caveats:**
- `@opentelemetry/sdk-logs` is marked experimental (breaking changes possible)
- Documents are sent as LogRecords, not spans — backends receive them under the Logs
  signal, not Traces. The flat field structure is preserved as `attributes`.
- No direct Elasticsearch bulk-API sink in the official packages; needs OTel Collector
  or a custom exporter.

**Sources:**
- [npm: @opentelemetry/sdk-logs](https://www.npmjs.com/package/@opentelemetry/sdk-logs)
- [OpenTelemetry JS exporters docs](https://opentelemetry.io/docs/languages/js/exporters/)

---

## Candidate 2: Winston + `winston-transport` ecosystem

**npm packages:** `winston` (v3.19.0), plus community transports

**How multi-sink works:** `winston.createLogger({ transports: [...] })` accepts any
number of Transport instances. Each transport is independent — level filtering, format,
and destination are configured per-transport.

```typescript
import winston from 'winston'
import WinstonElasticsearch from 'winston-elasticsearch'
import { OpenTelemetryTransportV3 } from '@opentelemetry/winston-transport'

const logger = winston.createLogger({
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'spans.jsonl' }),
    new WinstonElasticsearch({ node: 'http://localhost:9200', index: 'pi-spans' }),
    new OpenTelemetryTransportV3(), // bridges into OTel LoggerProvider
  ],
})

// in emit():
logger.info('span', span)
```

**Available community transports (partial list):**

| Transport package | Destination |
|---|---|
| `winston-elasticsearch` (v0.19.0) | Elasticsearch bulk API |
| `winston-loki` (v6.1.4) | Grafana Loki |
| `winston-aws-cloudwatch` (v3.0.0) | AWS CloudWatch Logs |
| `winston-logzio` (v5.2.0) | Logz.io |
| `@logtail/winston` (v0.5.8) | Better Stack (Logtail) |
| `winston-sumologic-transport` (v5.5.2) | Sumo Logic |
| `@opentelemetry/winston-transport` (v0.26.0) | OTel LoggerProvider |
| `winston-daily-rotate-file` (v5.0.0) | Rotating local log files |

Sources: [npm search: winston transport](https://www.npmjs.com/search?q=winston+transport),
[winston README](https://github.com/winstonjs/winston#transports),
[@opentelemetry/winston-transport](https://www.npmjs.com/package/@opentelemetry/winston-transport)

**Custom transport API:** Extend `winston-transport` and implement `log(info, callback)`.
The `info` object is the full payload including all metadata fields.

**Fit to this package:** High. The `SpanDocument` can be passed as the metadata argument
to `logger.info()` — all fields are preserved. The `transports` array is the single
config point. The ecosystem has direct Elasticsearch and Loki transports that avoid
the need for an intermediate collector.

**Caveats:**
- Winston ships ~350 KB of runtime dependency including `logform`, `readable-stream`,
  `triple-beam`, etc. Non-trivial for a pi extension that currently has zero runtime deps.
- `winston` v4 is in development and may break community transports.
- The `docId` needed for Elasticsearch `_id` requires custom transport code or the
  `idField` option in `winston-elasticsearch`.

**Sources:**
- [npm: winston](https://www.npmjs.com/package/winston)
- [npm: winston-elasticsearch](https://www.npmjs.com/package/winston-elasticsearch)
- [winston docs: multiple transports](https://github.com/winstonjs/winston#multiple-transports-of-the-same-type)

---

## Candidate 3: Pino + `pino.transport({ targets })`

**npm packages:** `pino` (latest), plus target-specific transport packages

**How multi-sink works:** `pino.transport({ targets: [...] })` fans log records out to
named transport modules running in a worker thread. Each target specifies a module name
and options object. Level filtering is applied per-target.

```typescript
import pino from 'pino'

const transport = pino.transport({
  targets: [
    { target: 'pino/file', options: { destination: '/tmp/spans.jsonl' } },
    { target: 'pino-elasticsearch', options: { node: 'http://localhost:9200', index: 'pi-spans' } },
    { target: 'pino-opentelemetry-transport', level: 'info' },
  ],
})
const logger = pino({ level: 'info' }, transport)

// in emit():
logger.info(span)
```

**Available community transports (v7+ compatible):**

| Transport package | Destination |
|---|---|
| `pino-elasticsearch` (v8.1.0) | Elasticsearch bulk API |
| `pino-loki` | Grafana Loki |
| `pino-opentelemetry-transport` | OTLP collector (gRPC / HTTP / protobuf) |
| `@axiomhq/pino` | Axiom.co |
| `@logtail/pino` (v0.5.8) | Better Stack |
| `pino-roll` (v4.0.0) | Rolling local log files |
| `pino-pretty` | Pretty-printed console |
| `pino-seq-transport` | Seq log server |

Sources: [pino transports docs](https://github.com/pinojs/pino/blob/main/docs/transports.md),
[npm: pino-elasticsearch](https://www.npmjs.com/package/pino-elasticsearch),
[npm: pino-opentelemetry-transport](https://www.npmjs.com/package/pino-opentelemetry-transport)

**pino-opentelemetry-transport** is particularly notable: it maps Pino log records to
OTel LogRecords and supports `logRecordProcessorOptions` as an array, meaning multiple
OTel exporters are configurable from within the pino transport options object. It also
respects standard `OTEL_EXPORTER_OTLP_*` environment variables.

**Fit to this package:** Medium-high for the pino + targets approach; the fan-out is
worker-thread-based (async by default), which is good for a pi extension. However,
pino is designed for string/object log emission, and the `SpanDocument` would be
serialized as the log body — losing Pino's level semantics somewhat. Also, `options`
passed to transports must be JSON-serializable (no functions), which can be limiting.

**Caveats:**
- Worker thread isolation means transport options must be plain-serializable objects.
- Pino adds ~200 KB to runtime deps.
- Per-target level filtering requires `logger.level` to be set low enough first.

**Sources:**
- [pino-elasticsearch: using multiple streams](https://github.com/pinojs/pino-elasticsearch#using-multiple-streams-output-to-console-and-elasticsearch)
- [pino transport docs: multiple targets](https://github.com/pinojs/pino/blob/main/docs/transports.md#b-targets-multiple-destinations)

---

## Candidate 4: LogLayer

**npm package:** `loglayer` (v9.1.0)

**How multi-sink works:** LogLayer is a thin TypeScript logging orchestration library.
The `transport` constructor option accepts either a single transport or an array of
transports. Each transport wraps a specific backend (pino, winston, OTel, Datadog,
Axiom, etc.). This is a unified fluent API over whatever backends are configured.

```typescript
import { LogLayer } from 'loglayer'
import { OpenTelemetryTransport } from '@loglayer/transport-opentelemetry'
import { WinstonTransport } from '@loglayer/transport-winston'
import winston from 'winston'

const log = new LogLayer({
  transport: [
    new OpenTelemetryTransport(),
    new WinstonTransport({ logger: winston.createLogger({ transports: [...] }) }),
  ],
})

// in emit():
log.withMetadata(span).info('span')
```

**Available official transports:**

| Package | Backend |
|---|---|
| `@loglayer/transport-opentelemetry` (v4.0.2) | OTel Logs SDK |
| `@loglayer/transport-pino` (v3.0.2) | Pino |
| `@loglayer/transport-winston` (v3.0.2) | Winston |
| `@loglayer/transport-datadog` (v4.0.2) | Datadog (server) |
| `@loglayer/transport-axiom` (v3.0.2) | Axiom.co |
| `@loglayer/transport-betterstack` (v2.0.3) | Better Stack |
| `@loglayer/transport-aws-cloudwatch-logs` | Amazon CloudWatch |
| `@loglayer/transport-google-cloud-logging` | Google Cloud Logging |
| `@loglayer/transport-new-relic` | New Relic |
| `@loglayer/transport-sentry` | Sentry |
| `@loglayer/transport-victoria-logs` | VictoriaLogs |
| `@loglayer/transport-http` (v2.1.0) | Generic HTTP (batching + retry) |

Sources: [loglayer.dev/transports](https://loglayer.dev/transports/),
[loglayer.dev/configuration](https://loglayer.dev/configuration.html)

**Fit to this package:** Medium. LogLayer provides the clearest "array of transports =
multiple sinks" DX, and it has first-class TypeScript support and an OTel transport.
However it is an extra indirection layer — each LogLayer transport still delegates to
the underlying library (pino, winston, etc.), so dependencies stack up. Also LogLayer
is built around structured log messages with `withMetadata()`, which maps reasonably
but not perfectly to the pre-built `SpanDocument` pattern.

**Caveats:**
- LogLayer itself is tiny, but each `@loglayer/transport-*` brings in its underlying
  library as a peer dependency.
- The `@loglayer/transport-opentelemetry` transport delegates to `@opentelemetry/sdk-logs`,
  so Candidate 1 is effectively a subset of using LogLayer with that transport.

---

## Comparison summary

| | OTel SDK Logs | Winston | Pino | LogLayer |
|---|---|---|---|---|
| Single config point | `processors: [...]` | `transports: [...]` | `targets: [...]` | `transport: [...]` |
| Typescript-native | Yes | Partial | Partial | Yes |
| Runtime dep size | Small (per exporter) | ~350 KB | ~200 KB | Tiny + peer deps |
| Direct ES bulk sink | Custom exporter needed | `winston-elasticsearch` | `pino-elasticsearch` | Via Winston/Pino |
| Direct Loki sink | Via OTel Collector | `winston-loki` | `pino-loki` | Via Winston/Pino |
| OTLP/Collector support | Native | `@opentelemetry/winston-transport` | `pino-opentelemetry-transport` | `@loglayer/transport-opentelemetry` |
| Custom sink effort | Implement 2-method interface | Extend class, implement `log()` | Write worker-thread module | Extend `BaseTransport` |
| Stability | Experimental | Stable (v3) | Stable | Stable (v9) |

---

## Recommendation

**For this package, `@opentelemetry/sdk-logs` with per-exporter packages is the best
fit** for the following reasons:

1. The `SpanDocument` is already structured as OTel telemetry. Wrapping it in a
   `LogRecord` (`body` + `attributes`) is minimal adapter code.

2. `LoggerProvider({ processors: [...] })` is the exact "single config point, multiple
   sinks" pattern requested. Adding a new sink is one line in the processors array.

3. The package currently has zero runtime dependencies. OTel exporter packages are
   small and only need to be installed by users who want that specific sink.

4. Routing through the OpenTelemetry Collector (a separate process, not a dep)
   provides a universal fan-out to Elasticsearch, Loki, Datadog, CloudWatch, and
   any other OTel-compatible backend — all configurable in a YAML file with no code
   changes.

5. When the OTel Collector approach is too heavy, direct exporters like
   `@opentelemetry/exporter-logs-otlp-http` work against any OTLP-accepting backend
   (Grafana Cloud, Axiom, Honeycomb, etc.).

**If direct Elasticsearch or Loki sinks are required without an intermediate
collector**, Winston with `winston-elasticsearch` and `winston-loki` is the simplest
path — the `transports` array maps directly to the existing `emit` stub pattern.

### Suggested architecture for `emit`

```typescript
// Configuration-driven: user provides processors at extension init time
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'

const provider = new LoggerProvider({
  processors: [
    // File: use a custom SimpleFileExporter (no extra dep needed)
    // OTLP: one line per destination
    new BatchLogRecordProcessor(
      new OTLPLogExporter({ url: 'http://localhost:4318/v1/logs' })
    ),
  ],
})
const otelLogger = provider.getLogger('pi-observability')

function emit(span: SpanDocument, _docId: string): void {
  otelLogger.emit({
    body: JSON.stringify(span),
    attributes: span as Record<string, unknown>,
    severityText: 'INFO',
  })
}
```

---

## Sources

- [npm: @opentelemetry/sdk-logs v0.216.0](https://www.npmjs.com/package/@opentelemetry/sdk-logs)
- [npm: @opentelemetry/exporter-logs-otlp-http](https://www.npmjs.com/package/@opentelemetry/exporter-logs-otlp-http)
- [OpenTelemetry JS exporters docs](https://opentelemetry.io/docs/languages/js/exporters/)
- [npm: winston v3.19.0](https://www.npmjs.com/package/winston)
- [winston README: transports](https://github.com/winstonjs/winston#transports)
- [npm: winston-elasticsearch v0.19.0](https://www.npmjs.com/package/winston-elasticsearch)
- [npm: @opentelemetry/winston-transport v0.26.0](https://www.npmjs.com/package/@opentelemetry/winston-transport)
- [pino transports docs](https://github.com/pinojs/pino/blob/main/docs/transports.md)
- [pino-elasticsearch: multiple streams](https://github.com/pinojs/pino-elasticsearch#using-multiple-streams-output-to-console-and-elasticsearch)
- [npm: pino-opentelemetry-transport](https://www.npmjs.com/package/pino-opentelemetry-transport)
- [LogLayer available transports](https://loglayer.dev/transports/)
- [LogLayer configuration](https://loglayer.dev/configuration.html)
- [LogLayer getting started](https://loglayer.dev/getting-started.html)
- [npm: loglayer v9.1.0](https://www.npmjs.com/package/loglayer)
- [npm: @loglayer/transport-opentelemetry v4.0.2](https://www.npmjs.com/package/@loglayer/transport-opentelemetry)
