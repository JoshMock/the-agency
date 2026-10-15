import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import initExtension, {
  CoordinatorFormatError,
  TASK_TREE_FILENAME,
  buildClarifyInstruction,
  buildPlanInstruction,
  parseClarifyResponse,
  parseTaskTreeYaml,
  validateTaskTree,
  writeTaskTree,
} from './index.ts'
import { parseTaskTree } from '../task-tree/index.ts'

/** a well-formed tree: failing tests first, an explicit human gate, then implementation */
const VALID_TREE = `tasks:
  - name: clarify
    prompt:
      - "Restate the requested change and list the open questions"
  - name: red-tests
    prompt:
      - "Write tests that fail for the right reason"
    depends_on: [clarify]
  - name: plan-review
    pause: true
    message: "Review the plan and the failing tests before implementation starts"
    depends_on: [red-tests]
  - name: implement
    prompt:
      - "Make the failing tests pass"
    model: anthropic/claude-opus-4-5
    thinking: high
    depends_on: [plan-review]
  - name: open-pr
    prompt:
      - "Open a pull request with the finished work"
    depends_on: [implement]
`

/** same shape, but nothing ever stops for a human */
const TREE_WITHOUT_GATE = `tasks:
  - name: implement
    prompt:
      - "Do the work"
  - name: open-pr
    prompt:
      - "Open a pull request"
    depends_on: [implement]
`

const noopFactory = () => async () => {}

function createMockPi () {
  const tools: Record<string, any> = {}
  const commands: Record<string, any> = {}
  const sent: string[] = []
  return {
    pi: {
      registerTool (config: any) { tools[config.name] = config },
      registerCommand (name: string, config: any) { commands[name] = config },
      sendUserMessage (text: string) { sent.push(text) },
    },
    tools,
    commands,
    sent,
  }
}

function createMockCtx (cwd: string) {
  const notifications: Array<{ message: string; level: string }> = []
  return {
    cwd,
    hasUI: true,
    ui: {
      notify (message: string, level: string) { notifications.push({ message, level }) },
      setStatus () {},
    },
    notifications,
  }
}

describe('parseTaskTreeYaml', () => {
  it('returns raw YAML unchanged', () => {
    assert.equal(parseTaskTreeYaml(VALID_TREE), VALID_TREE)
  })

  it('strips a fenced code block and surrounding prose', () => {
    const raw = `Here is the plan:\n\n\`\`\`yaml\n${VALID_TREE}\`\`\`\n\nLet me know what to change.`
    assert.equal(parseTaskTreeYaml(raw), VALID_TREE)
  })

  it('throws when the response contains no tasks document', () => {
    assert.throws(() => parseTaskTreeYaml('I need more information first.'), CoordinatorFormatError)
  })
})

describe('parseClarifyResponse', () => {
  const response = JSON.stringify({
    questions: [{ id: 'scope', question: 'Which repos are in scope?', why: 'cloning the wrong repo wastes a run' }],
    repos: [{ repo: 'the-agency', reason: 'the change lands in packages/coordinator', inScope: true }],
  })

  it('parses a fenced JSON response', () => {
    const parsed = parseClarifyResponse('```json\n' + response + '\n```')
    assert.equal(parsed.questions.length, 1)
    assert.equal(parsed.questions[0].id, 'scope')
    assert.equal(parsed.repos[0].repo, 'the-agency')
    assert.equal(parsed.repos[0].inScope, true)
  })

  it('treats an empty question list as "nothing to ask"', () => {
    const parsed = parseClarifyResponse('{"questions": [], "repos": []}')
    assert.deepEqual(parsed.questions, [])
  })

  it('throws on a response that is not JSON', () => {
    assert.throws(() => parseClarifyResponse('Sure! Let me ask you a few things.'), CoordinatorFormatError)
  })

  it('throws when the questions are not in the documented shape', () => {
    assert.throws(() => parseClarifyResponse('{"questions": "which repo?"}'), CoordinatorFormatError)
    assert.throws(() => parseClarifyResponse('{"questions": [{"id": "a"}]}'), CoordinatorFormatError)
  })
})

describe('buildClarifyInstruction', () => {
  it('carries the task and demands questions before any plan', () => {
    const instruction = buildClarifyInstruction('add OTel spans to the coordinator')
    assert.match(instruction, /add OTel spans to the coordinator/)
    assert.match(instruction, /before/i)
    assert.match(instruction, /question/i)
    assert.match(instruction, /repo/i)
    assert.match(instruction, /no task tree|do not emit|not emit/i)
  })
})

describe('buildPlanInstruction', () => {
  it('carries the task, the answers and the in-scope repos', () => {
    const instruction = buildPlanInstruction({
      task: 'add a coordinator package',
      answers: [{ id: 'scope', question: 'Which repos are in scope?', answer: 'the-agency only' }],
      repos: [{ repo: 'the-agency', reason: 'monorepo', inScope: true }],
    })
    assert.match(instruction, /add a coordinator package/)
    assert.match(instruction, /the-agency only/)
    assert.match(instruction, /pause: true/)
    assert.match(instruction, /red|failing test/i)
  })
})

describe('validateTaskTree', () => {
  it('accepts a well-formed tree', () => {
    assert.deepEqual(validateTaskTree(VALID_TREE), [])
  })

  it('accepts what the real pi-task-tree parser accepts', () => {
    const manager = parseTaskTree(VALID_TREE, noopFactory, { onPause: async () => {} })
    assert.equal(manager.tasks.size, 5)
    assert.deepEqual(validateTaskTree(VALID_TREE), [])
  })

  it('rejects a tree with no human gate', () => {
    const errors = validateTaskTree(TREE_WITHOUT_GATE)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /pause/)
  })

  it('allows the gate requirement to be waived', () => {
    assert.deepEqual(validateTaskTree(TREE_WITHOUT_GATE, { requireGate: false }), [])
  })

  it('reports duplicate task names from the task-tree parser', () => {
    const errors = validateTaskTree(`tasks:
  - name: implement
    prompt: ["Do the work"]
  - name: implement
    pause: true
`, { requireGate: false })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /duplicate task name/)
  })

  it('reports dependencies on unknown tasks', () => {
    const errors = validateTaskTree(`tasks:
  - name: implement
    prompt: ["Do the work"]
    depends_on: [does-not-exist]
`, { requireGate: false })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /unknown task/)
  })

  it('reports YAML that does not parse', () => {
    const errors = validateTaskTree('tasks:\n  - name: [unclosed')
    assert.equal(errors.length, 1)
  })
})

describe('writeTaskTree', () => {
  let cwd: string
  before(async () => { cwd = await mkdtemp(join(tmpdir(), 'coordinator-')) })
  after(async () => { await rm(cwd, { recursive: true, force: true }) })

  it('writes the tree and reports the path', async () => {
    const result = await writeTaskTree(VALID_TREE, cwd)
    assert.equal(result.errors.length, 0)
    assert.equal(result.written, true)
    assert.equal(result.path, join(cwd, TASK_TREE_FILENAME))
    assert.equal(await readFile(result.path, 'utf8'), VALID_TREE)
  })

  it('refuses to clobber an existing tree without overwrite', async () => {
    const result = await writeTaskTree(VALID_TREE, cwd)
    assert.equal(result.written, false)
    assert.match(result.errors.join('\n'), /exists/)
    assert.equal(await readFile(result.path, 'utf8'), VALID_TREE)
  })

  it('writes nothing when the tree is invalid', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coordinator-'))
    const result = await writeTaskTree(TREE_WITHOUT_GATE, dir)
    assert.equal(result.written, false)
    assert.match(result.errors.join('\n'), /pause/)
    await assert.rejects(readFile(join(dir, TASK_TREE_FILENAME), 'utf8'))
    await rm(dir, { recursive: true, force: true })
  })
})

describe('coordinator extension', () => {
  let cwd: string
  before(async () => { cwd = await mkdtemp(join(tmpdir(), 'coordinator-ext-')) })
  after(async () => { await rm(cwd, { recursive: true, force: true }) })

  function setup () {
    const mock = createMockPi()
    initExtension(mock.pi as any)
    return { ...mock, ctx: createMockCtx(cwd) }
  }

  it('registers the emit_task_tree tool and the coordinate command', () => {
    const { tools, commands } = setup()
    assert.ok(tools.emit_task_tree)
    assert.ok(commands.coordinate)
    assert.match(tools.emit_task_tree.description, /does not run/i)
  })

  it('injects the clarification instruction when /coordinate runs', async () => {
    const { commands, sent, ctx } = setup()
    await commands.coordinate.handler('add a coordinator package', ctx)
    assert.equal(sent.length, 1)
    assert.match(sent[0], /add a coordinator package/)
    assert.equal(ctx.notifications.length, 1)
  })

  it('writes a valid tree handed to emit_task_tree', async () => {
    const { tools, ctx } = setup()
    const result = await tools.emit_task_tree.execute('call-1', { yaml: VALID_TREE }, undefined, undefined, ctx)
    assert.equal(result.isError, undefined)
    assert.match(result.content[0].text, /task-tree\.yaml/)
    assert.equal(await readFile(join(cwd, TASK_TREE_FILENAME), 'utf8'), VALID_TREE)
  })

  it('rejects an invalid tree instead of writing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coordinator-ext-bad-'))
    const mock = createMockPi()
    initExtension(mock.pi as any)
    const ctx = createMockCtx(dir)
    const result = await mock.tools.emit_task_tree.execute('call-2', { yaml: TREE_WITHOUT_GATE }, undefined, undefined, ctx)
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /pause/)
    await assert.rejects(readFile(join(dir, TASK_TREE_FILENAME), 'utf8'))
    await rm(dir, { recursive: true, force: true })
  })

  it('won\'t overwrite an existing tree unless asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'coordinator-ext-clobber-'))
    await writeFile(join(dir, TASK_TREE_FILENAME), VALID_TREE)
    const mock = createMockPi()
    initExtension(mock.pi as any)
    const ctx = createMockCtx(dir)
    const blocked = await mock.tools.emit_task_tree.execute('call-3', { yaml: VALID_TREE }, undefined, undefined, ctx)
    assert.equal(blocked.isError, true)
    const allowed = await mock.tools.emit_task_tree.execute('call-4', { yaml: VALID_TREE, overwrite: true }, undefined, undefined, ctx)
    assert.equal(allowed.isError, undefined)
    await rm(dir, { recursive: true, force: true })
  })
})
