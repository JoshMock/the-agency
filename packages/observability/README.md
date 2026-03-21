# @the-agency/pi-observability

Observability extension for [Pi](https://github.com/badlogic/pi-mono).  Writes a JSONL timeseries of every tool call, agent turn, model change, and session lifecycle event to `~/.pi/observability/`.  The output is Elasticsearch-ready so you can track usage patterns over time.

## Features

- **Zero-overhead JSONL logging** — records are queued and flushed asynchronously with `setImmediate`; the session is never blocked
- **Rich timeseries** — every record carries `@timestamp`, `sessionId`, `sessionFile`, `cwd`, and a unique `turnId` so you can group and correlate events
- **Token tracking** — `turn_end` records include `tokensIn` / `tokensOut` (when the provider returns usage)
- **Tool profiling** — every `tool_call` record includes `toolName`, `durationMs`, `isError`, and a 300-char `argsSummary`
- **Model tracking** — `model_change` records capture every provider + model switch with the change source (`set` / `cycle` / `restore`)
- **Command tracking** — `/commands` typed by the user are captured as `command` records
- **AI-generated session tags** — on shutdown the extension silently calls a cheap/fast model (Gemini Flash → Haiku → GPT-4o-mini in priority order) and writes a `session_tags` record with single-word tags like `typescript`, `feature`, `pi-extension`, `bugfix`, etc.
- **`/observe` command** — show the current JSONL file path and session totals at any time
- **`observe_analyze` tool** — the LLM can call this to parse any JSONL file and return aggregated metrics

## JSONL record schema

All records share these base fields:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Record discriminator (see below) |
| `@timestamp` | ISO-8601 | When the record was emitted |
| `sessionId` | UUID | Stable per Pi session (changes on `/new`, not `/reload`) |
| `sessionFile` | string \| null | Absolute path to the `.pi` session file |
| `cwd` | string | Working directory at the time of the event |

### Record types

#### `session_start`
Emitted once when the session opens.

#### `session_end`
Emitted on shutdown.  Adds: `durationMs`, `totalTurns`, `totalToolCalls`, `totalTokensIn`, `totalTokensOut`, `model`, `provider`.

#### `turn_start`
Emitted at the start of each LLM turn.  Adds: `turnId`, `turnIndex`, `model`, `provider`.

#### `turn_end`
Emitted when a turn finishes.  Adds: `turnId`, `turnIndex`, `durationMs`, `tokensIn`, `tokensOut`, `toolCallCount`.

#### `tool_call`
Emitted for every tool execution.  Adds: `turnId`, `toolCallId`, `toolName`, `durationMs`, `isError`, `argsSummary`.

#### `model_change`
Emitted when the active model changes.  Adds: `model`, `provider`, `previousModel`, `previousProvider`, `source`.

#### `command`
Emitted when the user runs a `/command`.  Adds: `command`, `args`.

#### `session_tags`
Emitted asynchronously (best-effort) on shutdown.  Adds: `tags` (string[]), `summary`, `taggingModel`.

## Elasticsearch index template

A minimal mapping for an ILM-managed index:

```json
{
  "mappings": {
    "properties": {
      "@timestamp":     { "type": "date" },
      "type":           { "type": "keyword" },
      "sessionId":      { "type": "keyword" },
      "sessionFile":    { "type": "keyword" },
      "cwd":            { "type": "keyword" },
      "turnId":         { "type": "keyword" },
      "toolCallId":     { "type": "keyword" },
      "toolName":       { "type": "keyword" },
      "model":          { "type": "keyword" },
      "provider":       { "type": "keyword" },
      "tags":           { "type": "keyword" },
      "durationMs":     { "type": "long" },
      "tokensIn":       { "type": "long" },
      "tokensOut":      { "type": "long" },
      "isError":        { "type": "boolean" },
      "argsSummary":    { "type": "text" },
      "summary":        { "type": "text" }
    }
  }
}
```

Bulk-index a file:

```bash
# jq converts each line to the two-line Elasticsearch bulk format
jq -c '. | {"index": {"_index": "pi-observability"}}, .' \
  ~/.pi/observability/2025-01-15-abc12345.jsonl \
  | curl -s -H 'Content-Type: application/x-ndjson' \
         -XPOST 'http://localhost:9200/_bulk' \
         --data-binary @-
```

## Commands

### `/observe`

Show the current JSONL output path and session statistics:

```
Observability JSONL: /Users/you/.pi/observability/2025-01-15-abc12345.jsonl
Session ID: abc12345-...
Turns: 7 | Tool calls: 23
Tokens in: 14200 | out: 3400
Model: claude-sonnet-4-5 (anthropic)
```

### `/observe tags`

Trigger AI tagging for the current session immediately (instead of waiting for shutdown).

## `observe_analyze` tool

The LLM can call this tool to get aggregated metrics for any JSONL file:

```
observe_analyze({ jsonl_path: "/path/to/file.jsonl" })
```

Returns:

```json
{
  "filePath": "...",
  "sessions": 1,
  "turns": 12,
  "totalTokensIn": 28400,
  "totalTokensOut": 6800,
  "avgTurnDurationMs": 4200,
  "modelsUsed": ["anthropic/claude-sonnet-4-5"],
  "tags": ["typescript", "feature", "pi-extension"],
  "toolStats": [
    { "tool": "bash",  "calls": 18, "errors": 1, "avgDurationMs": 320 },
    { "tool": "read",  "calls": 9,  "errors": 0, "avgDurationMs": 12  },
    { "tool": "write", "calls": 4,  "errors": 0, "avgDurationMs": 8   }
  ],
  "recordCount": 67
}
```

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

## Output location

JSONL files are written to:

```
~/.pi/observability/YYYY-MM-DD-<sessionId[0:8]>.jsonl
```

One file is created per Pi session.  The directory is created automatically on first use.

## Performance

- All record serialisation happens synchronously (fast string work only)
- All file I/O runs in a `setImmediate` drain loop — the calling thread is never blocked
- AI tagging runs entirely after `session_shutdown` is fired; it cannot delay the session
- Tag generation uses the cheapest available model (≈200 output tokens)
