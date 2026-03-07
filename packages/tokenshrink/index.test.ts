import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import initExtension from './index.ts'

type Handler = (event: any, ctx: any) => any
type CommandHandler = (args: string, ctx: any) => any

function createMockPi () {
  const handlers: Record<string, Handler> = {}
  const commands: Record<string, { handler: CommandHandler }> = {}

  return {
    pi: {
      on (event: string, handler: Handler) {
        handlers[event] = handler
      },
      registerCommand (name: string, config: { handler: CommandHandler }) {
        commands[name] = config
      },
    },
    handlers,
    commands,
  }
}

function createMockCtx (hasUI = true) {
  const statuses: Record<string, string | undefined> = {}
  const notifications: Array<{ msg: string; level: string }> = []
  return {
    hasUI,
    ui: {
      setStatus (key: string, val?: string) { statuses[key] = val },
      notify (msg: string, level: string) { notifications.push({ msg, level }) },
    },
    statuses,
    notifications,
  }
}

describe('tokenshrink extension', () => {
  it('registers context handler and tokenshrink command', () => {
    const { pi, handlers, commands } = createMockPi()
    initExtension(pi as any)
    assert.ok(handlers.context)
    assert.ok(commands.tokenshrink)
  })

  it('skips tool and system role messages', () => {
    const { pi, handlers } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    const event = {
      messages: [
        { role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
        { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
      ],
    }

    const result = handlers.context(event, ctx)
    assert.deepEqual(result?.messages, event.messages)
  })

  it('skips messages with no content', () => {
    const { pi, handlers } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    const event = { messages: [{ role: 'user' }, { role: 'user', content: [] }] }
    handlers.context(event, ctx)
  })

  it('skips non-text content parts', () => {
    const { pi, handlers } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    const event = {
      messages: [
        { role: 'user', content: [{ type: 'image', url: 'http://example.com' }] },
      ],
    }

    const result = handlers.context(event, ctx)
    assert.equal(result.messages[0].content[0].type, 'image')
  })

  it('does nothing when disabled via command', async () => {
    const { pi, handlers, commands } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    await commands.tokenshrink.handler('off', ctx)

    const event = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
      ],
    }

    const result = handlers.context(event, ctx)
    assert.equal(result, undefined)
    assert.equal(ctx.statuses.tokenshrink, 'TokenShrink off')
  })

  it('toggles on and off via command', async () => {
    const { pi, commands } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    await commands.tokenshrink.handler('off', ctx)
    assert.equal(ctx.notifications.at(-1)?.msg, 'TokenShrink disabled')

    await commands.tokenshrink.handler('on', ctx)
    assert.equal(ctx.notifications.at(-1)?.msg, 'TokenShrink enabled')

    await commands.tokenshrink.handler('toggle', ctx)
    assert.equal(ctx.notifications.at(-1)?.msg, 'TokenShrink disabled')
  })

  it('shows status summary with no args', async () => {
    const { pi, commands } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    await commands.tokenshrink.handler('', ctx)
    assert.ok(ctx.notifications.at(-1)?.msg.includes('TokenShrink on'))
  })
})
