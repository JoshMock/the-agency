/**
 * pi-coordinator — plan before you execute.
 *
 * Turns a free-text task description into a **reviewable** `pi-task-tree` plan.
 * The coordinator asks its clarifying questions first, names the repositories it
 * believes are in scope (with reasons), and only then writes a task tree to disk
 * for a human to read, edit and hand to `pi-task-tree` deliberately.
 *
 * It intentionally does **not** run anything, and it refuses to guess: if a
 * question is unanswered, no task tree is emitted at all. That is the point of
 * the package rather than an oversight — see the design notes in the README.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { Type } from '@sinclair/typebox'
import { access, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'

import { PauseNode, parseTaskTree } from '../task-tree/index.ts'

/** name of the plan artifact written into the working directory */
export const TASK_TREE_FILENAME = 'task-tree.yaml'

/** thrown when a model response is not the shape the coordinator asked for */
export class CoordinatorFormatError extends Error {
  /** @param message - what was wrong with the response */
  constructor (message: string) {
    super(message)
    this.name = 'CoordinatorFormatError'
  }
}

/** a question the coordinator cannot answer on the developer's behalf */
export interface ClarifyingQuestion {
  /** short stable identifier, e.g. `scope` */
  id: string
  /** the question as it should be put to the developer */
  question: string
  /** why the answer changes the plan — the reason to spend attention on it */
  why: string
}

/** the coordinator's view of one repository */
export interface RepoDecision {
  /** repository name, e.g. `the-agency` */
  repo: string
  /** why the coordinator believes it is (or is not) in scope */
  reason: string
  /** whether the coordinator proposes to include it in the run */
  inScope: boolean
}

/** the parsed result of the clarification pass */
export interface ClarificationResult {
  questions: ClarifyingQuestion[]
  repos: RepoDecision[]
}

/** an answered clarifying question, fed back into the planning pass */
export interface ClarificationAnswer {
  id: string
  question: string
  answer: string
}

/** options for {@link validateTaskTree} */
export interface ValidateOptions {
  /**
   * require at least one `pause: true` checkpoint in the tree (default: `true`).
   *
   * the project's stated principle is that the pipeline stops and asks rather
   * than proceeding and reporting, so a tree with no human gate is rejected.
   */
  requireGate?: boolean
}

/** result of {@link writeTaskTree} */
export interface WriteResult {
  /** absolute path the tree was (or would have been) written to */
  path: string
  /** validation or refusal errors; empty when the write succeeded */
  errors: string[]
  /** whether the file was actually written */
  written: boolean
}

const GATE_REQUIRED_MESSAGE =
  'task tree has no pause checkpoint: add a "pause: true" task before anything ' +
  'is implemented or opened as a pull request, so the plan stops and asks'

const NOOP_FACTORY = () => async () => {}

/**
 * instructions injected into the session to run the clarification pass.
 *
 * @param task - the developer's free-text task description
 * @returns the message to send to the agent
 */
export function buildClarifyInstruction (task: string): string {
  return [
    'You are coordinating a task before any of it runs. Do not write code, do',
    'not open a pull request, and do not emit a task tree yet.',
    '',
    'Task:',
    task.trim(),
    '',
    'Work out what you cannot work out alone:',
    '1. Ask the questions whose answers would change the plan (scope, target',
    '   files or packages, ambiguous requirements, anything safely guessable but',
    '   expensive to get wrong). Ask before you plan.',
    '2. Name the repositories you believe are in scope, and why. Say so if you',
    '   think a repository is involved but should stay out of scope.',
    '',
    'Reply with JSON only, in this shape:',
    '{"questions":[{"id":"scope","question":"...","why":"..."}],',
    ' "repos":[{"repo":"the-agency","reason":"...","inScope":true}]}',
    '',
    'An empty "questions" array is a valid answer, but only if you genuinely have',
    'nothing to ask. Do not invent questions to look thorough.',
  ].join('\n')
}

/**
 * instructions injected once the questions have been answered: author the tree.
 *
 * @param input - the task, the answered questions and the agreed repositories
 * @returns the message to send to the agent
 */
export function buildPlanInstruction (input: {
  task: string
  answers: ClarificationAnswer[]
  repos: RepoDecision[]
}): string {
  const answers = input.answers.length
    ? input.answers.map(a => `- ${a.question}\n  answer: ${a.answer}`).join('\n')
    : '- (none — the developer judged the task unambiguous)'

  const repos = input.repos.length
    ? input.repos.map(r => `- ${r.repo} (${r.inScope ? 'in scope' : 'out of scope'}): ${r.reason}`).join('\n')
    : '- (none named)'

  return [
    'Now write the task tree. Still do not run anything.',
    '',
    'Task:',
    input.task.trim(),
    '',
    'Answers:',
    answers,
    '',
    'Repositories:',
    repos,
    '',
    'Rules for the tree:',
    '- Tests are written first and must fail for the right reason before',
    '  implementation starts — make that a separate task with an explicit',
    '  dependency from the implementation.',
    '- Include at least one human gate, as a pause checkpoint:',
    '  `pause: true` with a `message` saying exactly what you want reviewed.',
    '- Put the gate after the plan and the failing tests, and before',
    '  implementation; add a second gate before anything that is merged.',
    '- Model and thinking are opt-in; omit them unless a task needs them.',
    '',
    'Emit the tree by calling the emit_task_tree tool with the YAML document.',
    'It will reject a tree that is structurally invalid or has no human gate.',
  ].join('\n')
}

/**
 * strip prose and code fences from a model response that should contain YAML.
 *
 * @param raw - the model's raw response
 * @returns the normalized YAML document, ending in exactly one newline
 * @throws CoordinatorFormatError when no `tasks:` document is present
 */
export function parseTaskTreeYaml (raw: string): string {
  const fenced = /```(?:ya?ml)?\s*\n([\s\S]*?)```/.exec(raw)
  const candidate = fenced ? fenced[1] : raw

  const start = candidate.search(/^tasks\s*:/m)
  if (start === -1) {
    throw new CoordinatorFormatError('response contains no "tasks:" document')
  }

  return candidate.slice(start).replace(/\s*$/, '') + '\n'
}

/**
 * parse the clarification pass response.
 *
 * @param raw - the model's raw response, as JSON or fenced JSON
 * @returns the questions and repository decisions
 * @throws CoordinatorFormatError when the response is not JSON in the expected shape
 */
export function parseClarifyResponse (raw: string): ClarificationResult {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(raw)
  const candidate = (fenced ? fenced[1] : raw).trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    throw new CoordinatorFormatError('clarification response is not JSON')
  }

  if (parsed == null || typeof parsed !== 'object') {
    throw new CoordinatorFormatError('clarification response must be a JSON object')
  }

  const { questions, repos } = parsed as Record<string, unknown>

  if (!Array.isArray(questions)) {
    throw new CoordinatorFormatError('clarification response needs a "questions" array')
  }

  const parsedQuestions: ClarifyingQuestion[] = questions.map((q, i) => {
    const entry = q as Record<string, unknown>
    if (entry == null || typeof entry !== 'object') {
      throw new CoordinatorFormatError(`questions[${i}] must be an object`)
    }
    if (typeof entry.id !== 'string' || typeof entry.question !== 'string') {
      throw new CoordinatorFormatError(`questions[${i}] needs string "id" and "question" fields`)
    }
    return {
      id: entry.id,
      question: entry.question,
      why: typeof entry.why === 'string' ? entry.why : '',
    }
  })

  if (repos != null && !Array.isArray(repos)) {
    throw new CoordinatorFormatError('"repos" must be an array when present')
  }

  const parsedRepos: RepoDecision[] = (repos ?? []).map((r, i) => {
    const entry = r as Record<string, unknown>
    if (entry == null || typeof entry !== 'object' || typeof entry.repo !== 'string') {
      throw new CoordinatorFormatError(`repos[${i}] needs a string "repo" field`)
    }
    return {
      repo: entry.repo,
      reason: typeof entry.reason === 'string' ? entry.reason : '',
      inScope: entry.inScope !== false,
    }
  })

  return { questions: parsedQuestions, repos: parsedRepos }
}

/**
 * validate a task tree against the real `pi-task-tree` DSL, plus the
 * project rule that the pipeline must stop and ask.
 *
 * structural rules (duplicate names, unknown dependencies, model and thinking
 * values) are the parser's job and are deliberately not reimplemented here.
 *
 * @param yamlText - the YAML document to check
 * @param options - see {@link ValidateOptions}
 * @returns human-readable errors; empty means the tree is acceptable
 */
export function validateTaskTree (yamlText: string, options: ValidateOptions = {}): string[] {
  const requireGate = options.requireGate ?? true

  let manager
  try {
    manager = parseTaskTree(yamlText, NOOP_FACTORY, { onPause: async () => {} })
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)]
  }

  if (requireGate) {
    const hasGate = [...manager.tasks.values()].some(node => node instanceof PauseNode)
    if (!hasGate) return [GATE_REQUIRED_MESSAGE]
  }

  return []
}

/**
 * write a validated task tree into a working directory.
 *
 * validation happens first, so an invalid tree never touches the filesystem, and
 * an existing tree is never replaced silently.
 *
 * @param yamlText - the YAML document to write
 * @param cwd - directory to write {@link TASK_TREE_FILENAME} into
 * @param options - `overwrite: true` replaces an existing tree
 * @returns where it went, what went wrong, and whether it was written
 */
export async function writeTaskTree (
  yamlText: string,
  cwd: string,
  options: { overwrite?: boolean } = {}
): Promise<WriteResult> {
  const path = join(cwd, TASK_TREE_FILENAME)
  const errors = validateTaskTree(yamlText)
  if (errors.length) return { path, errors, written: false }

  if (!options.overwrite) {
    try {
      await access(path, constants.F_OK)
      return {
        path,
        errors: [`${TASK_TREE_FILENAME} already exists; pass overwrite to replace it`],
        written: false,
      }
    } catch {
      // no existing tree — safe to write
    }
  }

  await writeFile(path, parseTaskTreeYaml(yamlText))
  return { path, errors: [], written: true }
}

/**
 * Pi extension entry point.
 *
 * Registers `/coordinate` (asks first) and the `emit_task_tree` tool (validates
 * and writes the plan). Nothing here executes a task tree.
 *
 * @param pi - the Pi extension API
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand('coordinate', {
    description:
      'Plan a task before running it: ask the questions that would change the plan, name the repos, and write a reviewable task tree (usage: /coordinate <task>)',
    handler: async (args, ctx) => {
      const task = (args ?? '').trim()
      if (!task) {
        if (ctx.hasUI) ctx.ui.notify('Usage: /coordinate <task description>', 'warning')
        return
      }

      pi.sendUserMessage(buildClarifyInstruction(task))
      if (ctx.hasUI) ctx.ui.notify('Coordinator: asking before planning', 'info')
    },
  })

  pi.registerTool({
    name: 'emit_task_tree',
    label: 'Emit Task Tree',
    description:
      'Validate a pi-task-tree YAML document and write it to ' +
      `${TASK_TREE_FILENAME} for human review. The tree is checked against the ` +
      'pi-task-tree DSL and must contain at least one "pause: true" checkpoint. ' +
      'This tool does not run the tree — the developer decides when to execute it.',
    parameters: Type.Object({
      yaml: Type.String({ description: 'The pi-task-tree YAML document to write' }),
      overwrite: Type.Optional(
        Type.Boolean({ description: `Replace an existing ${TASK_TREE_FILENAME}` })
      ),
    }),

    async execute (_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await writeTaskTree(params.yaml, ctx.cwd, {
        overwrite: params.overwrite ?? false,
      })

      if (result.errors.length) {
        return {
          content: [{ type: 'text', text: `Rejected, nothing written:\n${result.errors.join('\n')}` }],
          isError: true,
        }
      }

      return {
        content: [{
          type: 'text',
          text:
            `Wrote ${TASK_TREE_FILENAME} for review. Nothing has been executed. ` +
            'Read it, edit it, then hand it to pi-task-tree when you are ready.',
        }],
      }
    },
  })
}
