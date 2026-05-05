
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExportResult } from '@opentelemetry/core'
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs'

/** Writes OTel log records as JSONL to a file, one record's attributes per line. */
export class FileJsonlExporter implements LogRecordExporter {
  private readonly filePath: string

  /** Parent directory is created automatically if it does not exist. */
  constructor(filePath: string) {
    this.filePath = filePath
    mkdirSync(dirname(filePath), { recursive: true })
  }

  /**
   * Uses appendFileSync intentionally — the BatchLogRecordProcessor calls
   * export off the hot path, so sync I/O is fine and avoids open file handles.
   */
  export(records: ReadableLogRecord[], resultCallback: (result: ExportResult) => void): void {
    try {
      for (const record of records) {
        appendFileSync(this.filePath, JSON.stringify(record.attributes) + '\n', 'utf8')
      }
      resultCallback({ code: 0 })
    } catch (err) {
      resultCallback({ code: 1, error: err as Error })
    }
  }

  /** No-op shutdown; no open handles to release. */
  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}
