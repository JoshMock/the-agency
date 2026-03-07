/**
 * Hashline Edit extension for Pi.
 *
 * Exposes two tools:
 *   - hashline_read: read a file with hashline annotations (LINE#HASH:TEXT)
 *   - hashline_edit: apply edits using hashline references for precise,
 *     staleness-checked line addressing
 *
 * Ported from oh-my-pi's hashline edit mode.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type, type Static } from '@sinclair/typebox'
import { StringEnum } from '@mariozechner/pi-ai'
import { readFile, writeFile, access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { resolve, dirname } from 'node:path'
import {
  formatHashLines,
  parseTag,
  applyHashlineEdits,
  HashlineMismatchError,
  type HashlineEdit,
} from './hashline.js'

const DEFAULT_MAX_BYTES = 50 * 1024
const DEFAULT_MAX_LINES = 2000

const hashlineReadSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
  offset: Type.Optional(
    Type.Number({ description: 'Line number to start reading from (1-indexed)' })
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Maximum number of lines to read' })
  ),
})

const editItemSchema = Type.Object({
  op: StringEnum(['replace', 'append', 'prepend'] as const, {
    description:
      'Operation: "replace" replaces line(s) at pos (through end if given), ' +
      '"append" inserts lines after pos (or at EOF if omitted), ' +
      '"prepend" inserts lines before pos (or at BOF if omitted)',
  }),
  pos: Type.Optional(
    Type.String({
      description:
        'Line reference as "LINE#HASH" (e.g. "5#ZP"). Required for replace. ' +
        'Optional for append (default: EOF) and prepend (default: BOF).',
    })
  ),
  end: Type.Optional(
    Type.String({
      description:
        'End of range for multi-line replace, as "LINE#HASH". ' +
        'If omitted, only the single line at pos is replaced.',
    })
  ),
  lines: Type.Array(Type.String(), {
    description: 'New lines to insert or replace with (one string per line, no trailing newlines)',
  }),
})

const hashlineEditSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
  edits: Type.Array(editItemSchema, {
    description:
      'Array of edit operations. Each references lines by LINE#HASH tags ' +
      'obtained from hashline_read. Hashes are validated before any mutation.',
  }),
  create_if_missing: Type.Optional(
    Type.Boolean({
      description:
        'If true and the file does not exist, create it with the ' +
        'content from the first append/prepend edit. Default: false.',
    })
  ),
})

type EditItem = Static<typeof editItemSchema>

function normalizePath (path: string): string {
  return path.startsWith('@') ? path.slice(1) : path
}

function parseEditItems (items: EditItem[]): HashlineEdit[] {
  return items.map((item) => {
    switch (item.op) {
      case 'replace': {
        if (item.pos == null) {
          throw new Error('replace requires a "pos" reference')
        }
        const pos = parseTag(item.pos)
        const end = item.end != null ? parseTag(item.end) : undefined
        return { op: 'replace' as const, pos, end, lines: item.lines }
      }
      case 'append': {
        const pos = item.pos != null ? parseTag(item.pos) : undefined
        return { op: 'append' as const, pos, lines: item.lines }
      }
      case 'prepend': {
        const pos = item.pos != null ? parseTag(item.pos) : undefined
        return { op: 'prepend' as const, pos, lines: item.lines }
      }
      default:
        throw new Error(`Unknown op: ${(item as any).op}`)
    }
  })
}

export default function (pi: ExtensionAPI) {
  // disable built-in edit tools so the LLM uses hashline_read/hashline_edit
  pi.on('session_start', async () => {
    const active = pi.getActiveTools()
    const without = active.filter(
      (t) => t !== 'edit' && t !== 'hashline_read' && t !== 'hashline_edit'
    )
    pi.setActiveTools([...without, 'hashline_read', 'hashline_edit'])
  })

  pi.registerTool({
    name: 'hashline_read',
    label: 'Hashline Read',
    description:
      'Read a file with hashline annotations. Each line is prefixed with ' +
      'LINE#HASH (e.g. `5#ZP:  const x = 1;`). Use these LINE#HASH ' +
      'references in hashline_edit to make precise, staleness-checked edits. ' +
      'Output is truncated to 2000 lines or 50KB.',
    parameters: hashlineReadSchema,

    async execute (_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, normalizePath(params.path))

      try {
        await access(filePath, constants.R_OK)
      } catch {
        return {
          content: [{ type: 'text', text: `File not found: ${params.path}` }],
          isError: true,
        }
      }

      try {
        const raw = await readFile(filePath, 'utf-8')
        const allLines = raw.split('\n')
        const totalLines = allLines.length

        const startIdx = params.offset ? Math.max(0, params.offset - 1) : 0
        const endIdx = params.limit
          ? Math.min(totalLines, startIdx + params.limit)
          : totalLines
        const selectedLines = allLines.slice(startIdx, endIdx)
        const startLine = startIdx + 1

        const formatted = formatHashLines(
          selectedLines.join('\n'),
          startLine
        )

        // truncation
        let output = formatted
        const outputLines = output.split('\n')
        let truncated = false

        if (outputLines.length > DEFAULT_MAX_LINES) {
          output = outputLines.slice(0, DEFAULT_MAX_LINES).join('\n')
          truncated = true
        }

        if (Buffer.byteLength(output, 'utf-8') > DEFAULT_MAX_BYTES) {
          const lines = output.split('\n')
          let bytes = 0
          let cutoff = lines.length
          for (let i = 0; i < lines.length; i++) {
            bytes += Buffer.byteLength(lines[i], 'utf-8') + 1
            if (bytes > DEFAULT_MAX_BYTES) {
              cutoff = i
              break
            }
          }
          output = lines.slice(0, cutoff).join('\n')
          truncated = true
        }

        if (truncated) {
          const shownLines = output.split('\n').length
          output += `\n\n[Showing ${shownLines} of ${totalLines} lines. Use offset/limit for more.]`
        } else if (startIdx > 0 || endIdx < totalLines) {
          const shownLines = selectedLines.length
          output += `\n\n[Showing lines ${startLine}-${startIdx + shownLines} of ${totalLines}.]`
        }

        return {
          content: [{ type: 'text', text: output }],
          details: { totalLines, startLine, shownLines: selectedLines.length },
        }
      } catch (error: any) {
        return {
          content: [
            { type: 'text', text: `Error reading file: ${error.message}` },
          ],
          isError: true,
        }
      }
    },
  })

  pi.registerTool({
    name: 'hashline_edit',
    label: 'Hashline Edit',
    description:
      'Edit a file using hashline references obtained from hashline_read. ' +
      'Each edit targets lines by their LINE#HASH tag, which acts as a ' +
      'staleness check — if the file changed since the last read, hash ' +
      'mismatches are caught before any mutation.\n\n' +
      'Operations:\n' +
      '  replace: Replace line at pos (or range pos..end) with new lines\n' +
      '  append:  Insert lines after pos (or at end of file if pos omitted)\n' +
      '  prepend: Insert lines before pos (or at start of file if pos omitted)\n\n' +
      'Multiple edits are applied atomically (all-or-nothing on validation).',
    parameters: hashlineEditSchema,

    async execute (_toolCallId, params, _signal, _onUpdate, ctx) {
      const filePath = resolve(ctx.cwd, normalizePath(params.path))

      // handle file creation
      let fileExists = true
      try {
        await access(filePath, constants.R_OK)
      } catch {
        fileExists = false
      }

      if (!fileExists) {
        if (!params.create_if_missing) {
          return {
            content: [
              {
                type: 'text',
                text: `File not found: ${params.path}. Use create_if_missing: true to create it.`,
              },
            ],
            isError: true,
          }
        }

        // collect all lines from edits to form the new file
        const allNewLines: string[] = []
        for (const edit of params.edits) {
          if (edit.op === 'append' || edit.op === 'prepend') {
            allNewLines.push(...edit.lines)
          }
        }

        if (allNewLines.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'Cannot create file: no append/prepend lines provided.',
              },
            ],
            isError: true,
          }
        }

        const content = allNewLines.join('\n')
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, content, 'utf-8')

        return {
          content: [
            {
              type: 'text',
              text: `Created ${params.path} (${allNewLines.length} lines)`,
            },
          ],
          details: { created: true, lines: allNewLines.length },
        }
      }

      // read current content
      let text: string
      try {
        text = await readFile(filePath, 'utf-8')
      } catch (error: any) {
        return {
          content: [
            { type: 'text', text: `Error reading file: ${error.message}` },
          ],
          isError: true,
        }
      }

      // parse edit items into typed edits
      let edits: HashlineEdit[]
      try {
        edits = parseEditItems(params.edits)
      } catch (error: any) {
        return {
          content: [
            { type: 'text', text: `Invalid edit: ${error.message}` },
          ],
          isError: true,
        }
      }

      // apply edits
      try {
        const result = applyHashlineEdits(text, edits)

        if (result.firstChangedLine == null) {
          let msg = 'No changes applied.'
          if (result.noopEdits && result.noopEdits.length > 0) {
            msg += ` ${result.noopEdits.length} edit(s) were no-ops (content already matches).`
          }
          return { content: [{ type: 'text', text: msg }] }
        }

        await writeFile(filePath, result.lines, 'utf-8')

        const parts: string[] = [
          `Applied ${params.edits.length} edit(s) to ${params.path}`,
        ]

        if (result.warnings && result.warnings.length > 0) {
          parts.push('Warnings:')
          for (const w of result.warnings) {
            parts.push(`  - ${w}`)
          }
        }

        if (result.noopEdits && result.noopEdits.length > 0) {
          parts.push(
            `Note: ${result.noopEdits.length} edit(s) were no-ops.`
          )
        }

        return {
          content: [{ type: 'text', text: parts.join('\n') }],
          details: {
            firstChangedLine: result.firstChangedLine,
            warnings: result.warnings,
            noopCount: result.noopEdits?.length ?? 0,
          },
        }
      } catch (error: any) {
        if (error instanceof HashlineMismatchError) {
          return {
            content: [{ type: 'text', text: error.message }],
            isError: true,
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: `Error applying edits: ${error.message}`,
            },
          ],
          isError: true,
        }
      }
    },
  })
}
