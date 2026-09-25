import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { createHttpHooks, type HttpIpAllowInfo } from '@earendil-works/gondolin'
import { parseStringPackages } from './packages.js'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SNAPSHOT_DENIED, snapshotFilter, buildHttpHooks, renderPolicy } from './vmpi.js'
import { cwdToSessionDirName } from './sessions.js'

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

describe('buildHttpHooks', () => {
  const noSecrets: Record<string, never> = {}
  const oneSecret = {
    MY_KEY: { value: 'real-secret-value', hosts: ['api.example.com'], placeholder: 'placeholder-value' },
  }
  const allowAll = { policy: 'allow-all' as const, allowedDomains: [], localServices: [] }
  const denyAll = { policy: 'deny-all' as const, allowedDomains: [], localServices: [] }

  it('allow-all with no secrets returns no hooks and empty env', () => {
    const { httpHooks, guestEnv } = buildHttpHooks(noSecrets, allowAll)
    assert.equal(httpHooks, undefined)
    assert.deepEqual(guestEnv, {})
  })

  it('allow-all with secrets returns hooks (secret mediation active)', () => {
    const { httpHooks, guestEnv } = buildHttpHooks(oneSecret, allowAll)
    assert.ok(httpHooks != null, 'httpHooks should be present so secrets are mediated')
    assert.notEqual(guestEnv['MY_KEY'], 'real-secret-value', 'raw secret value must not be exposed to guest')
    assert.ok(typeof guestEnv['MY_KEY'] === 'string' && guestEnv['MY_KEY'].length > 0, 'placeholder must be set')
  })

  it('deny-all with secrets returns hooks', () => {
    const { httpHooks, guestEnv } = buildHttpHooks(oneSecret, denyAll)
    assert.ok(httpHooks != null)
    assert.notEqual(guestEnv['MY_KEY'], 'real-secret-value')
  })
})

describe('renderPolicy', () => {
  const base = {
    memory: 1024,
    cpus: 1,
    piConfigDir: '/home/user/.pi',
    stateDir: '/home/user/.vmpi',
    rootfsExtraMb: 128,
    guestPackages: [],
    postSetupHooks: [],
    missingSecrets: [],
  }

  it('no mounts, no domains, no secrets', () => {
    const config = { ...base, mounts: [], network: { policy: 'deny-all' as const, allowedDomains: [], localServices: [] }, secrets: {} }
    const out = renderPolicy(config, '/my/project')
    assert.ok(out.includes('/my/project -> /workspace (rw)'))
    assert.ok(out.includes('Additional host mounts:\n  none'))
    assert.ok(out.includes('policy: deny-all'))
    assert.ok(out.includes('Secrets:\n  none'))
    assert.ok(out.includes('Pi auth.json:\n  not exposed'))
    assert.ok(out.includes('Project-local security config:\n  ignored'))
  })

  it('shows resolved secrets with hosts', () => {
    const secrets = { GITHUB_TOKEN: { hosts: ['api.github.com', 'github.com'], value: 'ghp_xxx' } }
    const config = { ...base, mounts: [], network: { policy: 'custom' as const, allowedDomains: ['github.com'], localServices: [] }, secrets }
    const out = renderPolicy(config, '/proj')
    assert.ok(out.includes('GITHUB_TOKEN -> api.github.com, github.com (brokered)'))
    assert.ok(out.includes('  github.com'))
  })

  it('shows missing secrets', () => {
    const config = { ...base, mounts: [], network: { policy: 'custom' as const, allowedDomains: [], localServices: [] }, secrets: {}, missingSecrets: [{ name: 'OPENAI_API_KEY', envVarName: 'OPENAI_API_KEY' }] }
    const out = renderPolicy(config, '/proj')
    assert.ok(out.includes('OPENAI_API_KEY (missing: $OPENAI_API_KEY)'))
  })

  it('shows additional host mounts', () => {
    const mounts = [{ host: '/home/user/.config/tool', guest: '/root/.config/tool', readonly: true }]
    const config = { ...base, mounts, network: { policy: 'allow-all' as const, allowedDomains: [], localServices: [] }, secrets: {} }
    const out = renderPolicy(config, '/proj')
    assert.ok(out.includes('/home/user/.config/tool -> /root/.config/tool [ro]'))
  })

  it('shows local services and notes them as internal exceptions', () => {
    const localServices = [{ hostname: 'my-api.local', upstream: 'localhost:8080' }]
    const config = { ...base, mounts: [], network: { policy: 'custom' as const, allowedDomains: [], localServices }, secrets: {} }
    const out = renderPolicy(config, '/proj')
    assert.ok(out.includes('my-api.local -> localhost:8080'))
    assert.ok(out.includes('blocked (except local services above)'))
  })
})

describe('per-directory checkpoint isolation', () => {
  it('two different CWDs produce different checkpoint subdirectories under the same stateDir', () => {
    const stateDir = '/home/user/.vmpi'
    const dirA = cwdToSessionDirName('/home/alice/project-a')
    const dirB = cwdToSessionDirName('/home/alice/project-b')
    assert.notEqual(dirA, dirB)
    const checkpointA = join(stateDir, dirA, 'base-checkpoint.qcow2')
    const checkpointB = join(stateDir, dirB, 'base-checkpoint.qcow2')
    assert.ok(checkpointA.startsWith(stateDir))
    assert.ok(checkpointB.startsWith(stateDir))
    assert.notEqual(checkpointA, checkpointB)
  })
})
