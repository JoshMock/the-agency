import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHttpHooks, type HttpIpAllowInfo } from '@earendil-works/gondolin'
import { parseStringPackages } from './packages.js'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SNAPSHOT_DENIED, snapshotFilter } from './vmpi.js'

/**
 * Wraps `httpHooks.isIpAllowed` to record denied hostnames into a set.
 * This mirrors the production logic in `buildHttpHooks`.
 */
function withDeniedHostTracking (
  httpHooks: ReturnType<typeof createHttpHooks>['httpHooks'],
  denied: Set<string>
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

describe('parseStringPackages', () => {
  it('returns string entries unchanged', () => {
    assert.deepEqual(parseStringPackages({ packages: ['npm:foo', 'git:bar'] }), ['npm:foo', 'git:bar'])
  })

  it('drops object-shaped entries (e.g. nono packages)', () => {
    assert.deepEqual(
      parseStringPackages({ packages: ['npm:foo', { source: '/some/path' }, 'git:bar'] }),
      ['npm:foo', 'git:bar']
    )
  })

  it('drops null and number entries', () => {
    assert.deepEqual(parseStringPackages({ packages: [null, 42, 'npm:foo'] }), ['npm:foo'])
  })

  it('returns empty array when packages is absent', () => {
    assert.deepEqual(parseStringPackages({}), [])
  })
})

describe('SNAPSHOT_DENIED + snapshotFilter', () => {
  it('returns false for agent/auth.json', () => {
    assert.equal(snapshotFilter('/base', '/base/agent/auth.json'), false)
  })

  it('returns false for agent/trust.json', () => {
    assert.equal(snapshotFilter('/base', '/base/agent/trust.json'), false)
  })

  it('returns true for a non-denied file', () => {
    assert.equal(snapshotFilter('/base', '/base/agent/config.json'), true)
  })

  it('returns true for the root dir itself', () => {
    assert.equal(snapshotFilter('/base', '/base'), true)
  })

  it('SNAPSHOT_DENIED contains exactly the two credential files', () => {
    assert.deepEqual([...SNAPSHOT_DENIED].sort(), ['agent/auth.json', 'agent/trust.json'])
  })

  it('cpSync with snapshotFilter excludes denied files and copies normal files', () => {
    const src = mkdtempSync(join(tmpdir(), 'vmpi-test-src-'))
    const dst = mkdtempSync(join(tmpdir(), 'vmpi-test-dst-'))
    try {
      mkdirSync(join(src, 'agent'))
      writeFileSync(join(src, 'agent', 'auth.json'), '{"secret":"yes"}')
      writeFileSync(join(src, 'agent', 'trust.json'), '{"trusted":"yes"}')
      writeFileSync(join(src, 'agent', 'config.json'), '{"setting":"ok"}')
      writeFileSync(join(src, 'run-history.jsonl'), '{}')

      cpSync(src, dst, {
        recursive: true,
        preserveTimestamps: true,
        filter: (s) => snapshotFilter(src, s),
      })

      assert.equal(existsSync(join(dst, 'agent')), true, 'agent dir should be created')
      assert.equal(existsSync(join(dst, 'agent', 'auth.json')), false, 'auth.json must not be copied')
      assert.equal(existsSync(join(dst, 'agent', 'trust.json')), false, 'trust.json must not be copied')
      assert.equal(existsSync(join(dst, 'agent', 'config.json')), true, 'config.json should be copied')
      assert.equal(existsSync(join(dst, 'run-history.jsonl')), true, 'run-history.jsonl should be copied')
    } finally {
      rmSync(src, { recursive: true, force: true })
      rmSync(dst, { recursive: true, force: true })
    }
  })
})
