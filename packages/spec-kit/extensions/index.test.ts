import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import initExtension from './index.ts'

type CommandHandler = (args: string | undefined, ctx: any) => Promise<void>

function createMockPi () {
  const commands: Record<string, { description: string; handler: CommandHandler }> = {}
  const messages: string[] = []

  return {
    pi: {
      registerCommand (name: string, config: { description: string; handler: CommandHandler }) {
        commands[name] = config
      },
      sendUserMessage (msg: string) {
        messages.push(msg)
        return Promise.resolve()
      },
    },
    commands,
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
    const { pi, commands, messages } = createMockPi()
    initExtension(pi as any)

    await commands['speckit-init'].handler(undefined, {})

    assert.equal(messages.length, 1)
    assert.ok(messages[0].length > 0)
  })

  it('command handler substitutes $ARGUMENTS in skill content', async () => {
    const { pi, commands, messages } = createMockPi()
    initExtension(pi as any)

    await commands['speckit-specify'].handler('my feature', {})

    assert.ok(!messages[0].includes('$ARGUMENTS'), 'expected $ARGUMENTS to be replaced')
    assert.ok(messages[0].includes('my feature'), 'expected args to appear in message')
  })

  it('command handler replaces all occurrences of $ARGUMENTS', async () => {
    const { pi, commands, messages } = createMockPi()
    initExtension(pi as any)

    await commands['speckit-specify'].handler('test-arg', {})

    const occurrences = (messages[0].match(/\$ARGUMENTS/g) ?? []).length
    assert.equal(occurrences, 0)
  })

  it('command handler treats undefined args as empty string substitution', async () => {
    const { pi, commands, messages } = createMockPi()
    initExtension(pi as any)

    await commands['speckit-specify'].handler(undefined, {})

    assert.ok(!messages[0].includes('$ARGUMENTS'))
  })
})