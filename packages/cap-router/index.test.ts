import { test } from 'node:test'
import assert from 'node:assert'
import { BasicRouter, PromptRouter } from './index.ts'

test('BasicRouter', t => {
  const mockSession = { session: 'mock', prompt: async (_: string) => '' }
  const mockFactory = async () => mockSession

  t.test('addRoute', t => {
    t.test('adds route', () => {
      const router = new BasicRouter(mockFactory)
      router.addRoute('test', {})
      assert.equal((router as any).routes.size, 1)
    })
  })

  t.test('selectRoute', async t => {
    t.test('returns session from factory', async () => {
      const router = new BasicRouter(mockFactory)
      router.addRoute('test')
      const result = await router.selectRoute('test')
      assert.equal(result, mockSession)
    })

    t.test('throws when route not found', async () => {
      const router = new BasicRouter(mockFactory)
      await assert.rejects(() => router.selectRoute('missing'), /Route not found: missing/)
    })
  })
})

test('PromptRouter', t => {
  // provider/model don't need to be real since the factory is always mocked
  const makeRouter = (factory: (...args: any[]) => any) =>
    new PromptRouter({ provider: 'amazon-bedrock', model: 'test-model' }, factory)

  // returns a factory whose first call yields a selection session and subsequent calls yield a route session
  const makeFactory = (promptResponse: string | { text: string }) => {
    let callCount = 0
    const routeSession = { session: 'mock', prompt: async (_: string) => '' }
    return {
      factory: async () => {
        if (callCount++ === 0) return { prompt: async () => promptResponse }
        return routeSession
      },
      routeSession,
    }
  }

  t.test('addRoute', t => {
    t.test('stores name, description, and params', () => {
      const router = makeRouter(async () => {})
      router.addRoute('code', 'writes code', { cwd: '/tmp' } as any)
      assert.deepEqual((router as any).routes.get('code'), { description: 'writes code', params: { cwd: '/tmp' } })
    })

    t.test('defaults params to empty object', () => {
      const router = makeRouter(async () => {})
      router.addRoute('code', 'writes code')
      assert.deepEqual((router as any).routes.get('code')!.params, {})
    })

    t.test('throws if name is not a string', () => {
      const router = makeRouter(async () => {})
      assert.throws(() => router.addRoute(1 as unknown as string, 'writes code'), /name must be a string/)
    })

    t.test('throws if description is not a string', () => {
      const router = makeRouter(async () => {})
      assert.throws(() => router.addRoute('code', 123 as unknown as string), /description must be a string/)
    })
  })

  t.test('selectRoute', async t => {
    t.test('throws when no routes configured', async () => {
      const router = makeRouter(async () => {})
      await assert.rejects(() => router.selectRoute('task'), /No routes configured/)
    })

    t.test('selects route by string response', async () => {
      const { factory, routeSession } = makeFactory('code')
      const router = makeRouter(factory)
      router._resourceLoader = async () => null
      router.addRoute('code', 'writes code')
      router.addRoute('search', 'searches the web')
      const result = await router.selectRoute('write a function')
      assert.equal(result, routeSession)
    })

    t.test('trims whitespace from response', async () => {
      const { factory, routeSession } = makeFactory(' code\n')
      const router = makeRouter(factory)
      router._resourceLoader = async () => null
      router.addRoute('code', 'writes code')
      const result = await router.selectRoute('write a function')
      assert.equal(result, routeSession)
    })

    t.test('handles object response with .text', async () => {
      const { factory, routeSession } = makeFactory({ text: 'search' })
      const router = makeRouter(factory)
      router._resourceLoader = async () => null
      router.addRoute('code', 'writes code')
      router.addRoute('search', 'searches the web')
      const result = await router.selectRoute('find something')
      assert.equal(result, routeSession)
    })

    t.test('throws when route name not found', async () => {
      const { factory } = makeFactory('unknown-route')
      const router = makeRouter(factory)
      router._resourceLoader = async () => null
      router.addRoute('code', 'writes code')
      await assert.rejects(() => router.selectRoute('task'), /Route not found: unknown-route/)
    })
  })
})
