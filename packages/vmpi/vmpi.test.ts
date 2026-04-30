import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHttpHooks, type HttpIpAllowInfo } from '@earendil-works/gondolin'

/**
 * Wraps `httpHooks.isIpAllowed` to record denied hostnames into a set.
 * This mirrors the production logic in `buildHttpHooks`.
 */
function withDeniedHostTracking(
  httpHooks: ReturnType<typeof createHttpHooks>['httpHooks'],
  denied: Set<string>,
): void {
  const inner = httpHooks.isIpAllowed
  httpHooks.isIpAllowed = async (info: HttpIpAllowInfo) => {
    const allowed = inner == null ? true : await inner(info)
    if (!allowed) denied.add(info.hostname)
    return allowed
  }
}

describe('denied-host tracking', () => {
  it('records hostname when isIpAllowed returns false', async () => {
    const { httpHooks } = createHttpHooks({ allowedHosts: ['allowed.example.com'] })
    const denied = new Set<string>()
    withDeniedHostTracking(httpHooks, denied)

    const info: HttpIpAllowInfo = { hostname: 'blocked.example.com', ip: '1.2.3.4', family: 4, port: 443, protocol: 'https' }
    const result = await httpHooks.isIpAllowed!(info)

    assert.equal(result, false)
    assert.deepEqual([...denied], ['blocked.example.com'])
  })

  it('does not record hostname when isIpAllowed returns true', async () => {
    const { httpHooks } = createHttpHooks({ allowedHosts: ['allowed.example.com'] })
    const denied = new Set<string>()
    withDeniedHostTracking(httpHooks, denied)

    const info: HttpIpAllowInfo = { hostname: 'allowed.example.com', ip: '1.2.3.4', family: 4, port: 443, protocol: 'https' }
    const result = await httpHooks.isIpAllowed!(info)

    assert.equal(result, true)
    assert.equal(denied.size, 0)
  })

  it('records multiple distinct denied hostnames', async () => {
    const { httpHooks } = createHttpHooks({ allowedHosts: ['allowed.example.com'] })
    const denied = new Set<string>()
    withDeniedHostTracking(httpHooks, denied)

    for (const hostname of ['one.example.com', 'two.example.com', 'one.example.com']) {
      await httpHooks.isIpAllowed!({ hostname, ip: '1.2.3.4', family: 4, port: 443, protocol: 'https' })
    }

    assert.deepEqual([...denied].sort(), ['one.example.com', 'two.example.com'])
  })
})
