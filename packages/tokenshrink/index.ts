/**
 * TokenShrink extension: compresses context messages to save tokens before LLM calls.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { compress } from 'tokenshrink'

type TokenShrinkDomain = 'auto' | 'code' | 'medical' | 'legal' | 'business'

type TextContent = {
  type: 'text'
  text: string
  [key: string]: unknown
}

type Message = {
  role?: string
  content?: Array<TextContent | { type: string; [key: string]: unknown }>
  [key: string]: unknown
}

const MIN_ORIGINAL_TOKENS = 120
const MIN_SAVED_TOKENS = 12
const CODE_PATTERN =
  /```|\b(class|interface|function|const|let|var|import|export|namespace|SELECT|UPDATE|INSERT|DELETE)\b|=>|#include|<\/?[A-Za-z][^>]*>/i
const STATUS_KEY = 'tokenshrink'

export default function (pi: ExtensionAPI) {
  let enabled = true
  let lastSaved = 0
  let lastCompressed = 0

  pi.on('context', (event, ctx) => {
    if (!enabled) {
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, 'TokenShrink off')
      return
    }

    const messages = event.messages as Message[]
    let saved = 0
    let compressedParts = 0

    for (const message of messages) {
      if (!shouldProcessMessage(message)) continue
      if (!Array.isArray(message.content)) continue

      message.content = message.content.map((part) => {
        if (!isTextContent(part)) return part
        const domain = selectDomain(part.text, message.role)
        const result = compressText(part.text, domain)
        if (!result) return part

        saved += result.stats.tokensSaved
        compressedParts += 1

        return { ...part, text: result.compressed }
      })
    }

    lastSaved = saved
    lastCompressed = compressedParts

    if (ctx.hasUI) {
      ctx.ui.setStatus(
        STATUS_KEY,
        compressedParts > 0 ? `TokenShrink saved ~${saved} tokens` : undefined
      )
    }

    return { messages }
  })

  pi.registerCommand('tokenshrink', {
    description: 'Toggle TokenShrink or show recent savings (usage: /tokenshrink [on|off|toggle])',
    handler: async (args, ctx) => {
      const normalized = args?.trim().toLowerCase()

      if (normalized === 'on' || normalized === 'off' || normalized === 'toggle') {
        enabled = normalized === 'toggle' ? !enabled : normalized === 'on'
        const status = enabled ? 'enabled' : 'disabled'

        if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, enabled ? 'TokenShrink on' : undefined)
        ctx.ui.notify(`TokenShrink ${status}`, 'info')
        return
      }

      const summary = enabled
        ? `TokenShrink on; last save ~${lastSaved} tokens across ${lastCompressed} part${lastCompressed === 1 ? '' : 's'}.`
        : 'TokenShrink is currently off.'
      ctx.ui.notify(summary, 'info')
    },
  })
}

function shouldProcessMessage (message: Message): boolean {
  if (!message.content?.length) return false
  if (message.role === 'tool') return false
  if (message.role === 'system') return false
  return true
}

function isTextContent (content: unknown): content is TextContent {
  return (
    content != null &&
    typeof content === 'object' &&
    (content as { type?: string }).type === 'text' &&
    typeof (content as { text?: unknown }).text === 'string'
  )
}

function selectDomain (text: string, role?: string): TokenShrinkDomain {
  if (role === 'user' || role === 'assistant' || role === 'custom') {
    if (CODE_PATTERN.test(text)) return 'code'
  }
  return 'auto'
}

function compressText (text: string, domain: TokenShrinkDomain) {
  const result = compress(text, { domain })
  const { originalTokens, totalCompressedTokens, tokensSaved } = result.stats

  if (originalTokens < MIN_ORIGINAL_TOKENS) return null
  if (tokensSaved < MIN_SAVED_TOKENS) return null
  if (totalCompressedTokens >= originalTokens) return null

  return result
}
