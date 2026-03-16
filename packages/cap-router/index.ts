import assert from 'node:assert'
import { createAgentSession, AuthStorage, SessionManager, ModelRegistry, DefaultResourceLoader } from '@mariozechner/pi-coding-agent'
import type { CreateAgentSessionOptions, ResourceLoader } from '@mariozechner/pi-coding-agent'
import type { Model } from '@mariozechner/pi-ai'

const authStorage = AuthStorage.create()

const paramDefaults = {
  sessionManager: SessionManager.inMemory(),
  authStorage,
}

const modelRegistry = new ModelRegistry(authStorage)

interface Session {
  prompt(text: string): Promise<string | { text: string }>
}

type SessionFactory = (options?: CreateAgentSessionOptions) => Promise<Session>

interface RouteParams extends Omit<CreateAgentSessionOptions, 'sessionManager' | 'authStorage'> {}

interface PromptRouteEntry {
  params: RouteParams
  description: string
}

interface RouterModelConfig {
  provider: string
  model: string
}

export class BaseRouter {
  protected routes: Map<string, object>
  protected factory: SessionFactory

  constructor (sessionFactory: SessionFactory = createAgentSession as unknown as SessionFactory) {
    this.routes = new Map()
    this.factory = sessionFactory
  }

  async selectRoute (_input: string): Promise<Session> {
    throw new Error('selectRoute not implemented')
  }
}

/**
 * Create an agent session using the selected agent name
 */
export class BasicRouter extends BaseRouter {
  declare protected routes: Map<string, RouteParams>

  addRoute (name: string, params: RouteParams = {}): void {
    assert.ok(typeof name === 'string', 'name must be a string')
    this.routes.set(name, params)
  }

  async selectRoute (input: string): Promise<Session> {
    const routeParams = this.routes.get(input)
    if (routeParams == null) throw new Error(`Route not found: ${input}`)
    return await this.factory({ ...paramDefaults, ...routeParams })
  }
}

/**
 * Create an agent session by selecting the best agent for a given prompt based on the agent's description
 */
export class PromptRouter extends BaseRouter {
  declare protected routes: Map<string, PromptRouteEntry>
  private selectionModel: Model<any> | undefined
  private loader: ResourceLoader | null | undefined

  constructor ({ provider, model }: RouterModelConfig, sessionFactory: SessionFactory = createAgentSession as unknown as SessionFactory) {
    assert.ok(typeof provider === 'string', 'Model provider must be a string')
    assert.ok(typeof model === 'string', 'Model name must be a string')
    super(sessionFactory)
    this.selectionModel = modelRegistry.find(provider, model)
  }

  async _resourceLoader (): Promise<ResourceLoader | null> {
    if (this.loader != null) return this.loader

    this.loader = new DefaultResourceLoader({
      systemPrompt: 'You are a model router that selects the best inference model for a given task.',
    })
    await this.loader.reload()
    return this.loader
  }

  addRoute (name: string, description: string, params: RouteParams = {}): void {
    assert.ok(typeof name === 'string', 'name must be a string')
    assert.ok(typeof description === 'string', 'description must be a string')
    this.routes.set(name, { params, description })
  }

  /**
   * Has a lightweight model choose the most appropriate model for the provided prompt.
   */
  async selectRoute (prompt: string): Promise<Session> {
    if (this.routes.size === 0) throw new Error('No routes configured')
    const options = Array.from(this.routes.entries())
      .map(([key, value]) => `- ${key}: ${value.description}`)
      .join('\n')
    const selectionSession = await this.factory({
      ...paramDefaults,
      model: this.selectionModel,
      resourceLoader: await this._resourceLoader() ?? undefined,
    })
    const response = await selectionSession.prompt(`Choose the best route from the following options for the given task. ONLY return the route name, nothing else.

## Routes

${options}

## Task

${prompt}`)
    const selectedName = (typeof response === 'string' ? response : response.text).trim()
    const selectedRoute = this.routes.get(selectedName)
    if (selectedRoute == null) throw new Error(`Route not found: ${selectedName}`)
    return await this.factory({ ...paramDefaults, ...selectedRoute.params })
  }
}
