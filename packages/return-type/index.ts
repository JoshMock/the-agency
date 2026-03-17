import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'

export const TOOL_NAME = 'return_result'
export const EVENT_NAME = 'return_type:result'

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: TOOL_NAME,
    label: 'Return Result',
    description:
      'Return a structured value as the final result of this agent turn. ' +
      'Call this once with your answer instead of writing results to disk.',
    promptSnippet: 'Return a structured JSON value as the final result of this turn',
    promptGuidelines: [
      'Call return_result exactly once when you have computed your final answer.',
      'Pass the entire result as the `value` argument — it may be any JSON value ' +
        '(object, array, string, number, boolean, or null).',
      'Do not write results to disk when return_result is available; use it instead.',
    ],
    parameters: Type.Object({
      value: Type.Any({
        description:
          'The structured value to return. May be any JSON value: object, array, string, number, boolean, or null.',
      }),
    }),

    async execute (_toolCallId, params, _signal, _onUpdate, _ctx) {
      pi.events.emit(EVENT_NAME, { value: params.value })

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(params.value) }],
        details: { value: params.value },
      }
    },
  })
}
