import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import initExtension from './index.ts'

type CommandHandler = (args: string | undefined, ctx: any) => Promise<void>

function createMockPi () {
  const commands: Record<string, { description: string; handler: CommandHandler }> = {}

  return {
    pi: {
      registerCommand (name: string, config: { description: string; handler: CommandHandler }) {
        commands[name] = config
      },
    },
    commands,
  }
}

function createMockCtx () {
  const messages: string[] = []

  return {
    sendUserMessage (msg: string) {
      messages.push(msg)
      return Promise.resolve()
    },
    messages,
  }
}

const expectedCommands = [
  'speckit-init',
  'speckit-specify',
  'speckit-clarify',
  'speckit-plan',
  'speckit-tasks',
  'speckit-taskstoissues',
  'speckit-checklist',
  'speckit-analyze',
  'speckit-implement',
  'speckit-constitution',
]

describe('spec-kit extension', () => {
  it('registers all speckit commands', () => {
    const { pi, commands } = createMockPi()
    initExtension(pi as any)

    for (const name of expectedCommands) {
      assert.ok(commands[name], `expected command "${name}" to be registered`)
    }
  })

  it('registers no extra commands', () => {
    const { pi, commands } = createMockPi()
    initExtension(pi as any)

    assert.equal(Object.keys(commands).length, expectedCommands.length)
  })

  it('each command has a non-empty description', () => {
    const { pi, commands } = createMockPi()
    initExtension(pi as any)

    for (const name of expectedCommands) {
      assert.ok(commands[name].description.length > 0, `expected "${name}" to have a description`)
    }
  })

  it('command handler sends the skill content as a user message', async () => {
    const { pi, commands } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    await commands['speckit-init'].handler(undefined, ctx)

    assert.equal(ctx.messages.length, 1)
    assert.ok(ctx.messages[0].length > 0)
  })

  it('command handler substitutes $ARGUMENTS in skill content', async () => {
    const { pi, commands } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    await commands['speckit-specify'].handler('my feature', ctx)

    assert.ok(!ctx.messages[0].includes('$ARGUMENTS'), 'expected $ARGUMENTS to be replaced')
    assert.ok(ctx.messages[0].includes('my feature'), 'expected args to appear in message')
  })

  it('command handler replaces all occurrences of $ARGUMENTS', async () => {
    const { pi, commands } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    // use speckit-init which may or may not have $ARGUMENTS; test against a command we know works
    await commands['speckit-specify'].handler('test-arg', ctx)

    const occurrences = (ctx.messages[0].match(/\$ARGUMENTS/g) ?? []).length
    assert.equal(occurrences, 0)
  })

  it('command handler treats undefined args as empty string substitution', async () => {
    const { pi, commands } = createMockPi()
    initExtension(pi as any)
    const ctx = createMockCtx()

    await commands['speckit-specify'].handler(undefined, ctx)

    assert.ok(!ctx.messages[0].includes('$ARGUMENTS'))
  })
})
