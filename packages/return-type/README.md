# @the-agency/pi-return-type

A [Pi](https://github.com/badlogic/pi-mono) extension that registers a `return_result` tool, letting the agent hand back a structured JSON value directly to your code — no disk writes, no text parsing.

## The problem

By default, when you use the Pi SDK to run an agent programmatically, results come out as streamed text. To get structured data you have to either:

- parse JSON out of a prose response (fragile), or
- instruct the agent to write a file then read it back (clunky).

## The solution

This extension registers a `return_result` tool. When active, the agent calls it instead of writing to disk. Your code listens for the result on the `pi.events` bus (or via session events) and gets the value as a plain JavaScript object — fully typed if you cast it.

The `promptGuidelines` baked into the tool tell the LLM to call `return_result` exactly once with the final answer, and to prefer it over disk I/O.

## Installation

```bash
npm install @the-agency/pi-return-type
```

Add it to your `settings.json` pi packages list to use it globally, or load it programmatically with the SDK (see below).

## SDK usage

```typescript
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent'
import { EVENT_NAME } from '@the-agency/pi-return-type'
import returnTypeExtension from '@the-agency/pi-return-type'

interface FileAnalysis {
  language: string
  lineCount: number
  hasTests: boolean
}

async function analyzeFile(path: string): Promise<FileAnalysis> {
  const authStorage = AuthStorage.create()
  const modelRegistry = new ModelRegistry(authStorage)

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () =>
      'You are a code analysis assistant. ' +
      'When you have finished your analysis, call return_result with your findings.',
    extensionFactories: [returnTypeExtension],
  })
  await loader.reload()

  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoader: loader,
  })

  return new Promise((resolve, reject) => {
    session.subscribe((event) => {
      if (event.type === 'agent_end') session.dispose()
    })

    // Resolve as soon as the tool fires
    loader.getEventBus().on(EVENT_NAME, ({ value }) => {
      resolve(value as FileAnalysis)
    })

    session.prompt(
      `Analyse the file at ${path}. Return an object with fields: ` +
      `language (string), lineCount (number), hasTests (boolean).`
    ).catch(reject)
  })
}

const result = await analyzeFile('./src/index.ts')
console.log(result.language)   // "TypeScript"
console.log(result.lineCount)  // 42
console.log(result.hasTests)   // true
```

### Using the session event bus instead

If you prefer not to thread through the event bus, you can listen directly on session events:

```typescript
session.subscribe((event) => {
  if (
    event.type === 'tool_execution_end' &&
    event.toolName === 'return_result' &&
    !event.isError
  ) {
    // event.result.details.value is the raw value
    // event.result.content[0].text is JSON.stringify(value)
    const value = JSON.parse(event.result.content[0].text)
    resolve(value)
  }
})
```

## Tool reference

**`return_result`**

| Field | Value |
|---|---|
| Tool name | `return_result` |
| Event emitted | `return_type:result` |
| Event payload | `{ value: unknown }` |

Parameters:

| Parameter | Type | Description |
|---|---|---|
| `value` | any JSON value | The structured result to return. Objects, arrays, strings, numbers, booleans, and `null` are all accepted. |

## Exports

```typescript
// Default export: the extension factory (pass to extensionFactories or load via pi -e)
export default function (pi: ExtensionAPI): void

// Named constants (useful when wiring up event listeners)
export const TOOL_NAME: 'return_result'
export const EVENT_NAME: 'return_type:result'
```

## License

MIT
