import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import {
  PROVIDER_DOMAINS,
  resolveAllowedDomains,
  resolvePolicy,
  resolveLocalServices,
  loadConfig,
  resolveGuestPackages,
  DEFAULT_GUEST_PACKAGES,
  resolveSecrets,
} from './config.js'

describe('resolveAllowedDomains', () => {
  it('returns empty array when no network config supplied', () => {
    assert.deepEqual(resolveAllowedDomains(undefined), [])
  })

  it('returns empty array for empty network config', () => {
    assert.deepEqual(resolveAllowedDomains({}), [])
  })

  it('expands a single provider to its domains', () => {
    const result = resolveAllowedDomains({ providers: ['openai'] })
    assert.deepEqual(result, [...PROVIDER_DOMAINS.openai])
  })

  it('merges domains from multiple providers without duplicates', () => {
    const result = resolveAllowedDomains({ providers: ['openai', 'anthropic'] })
    const expected = [
      ...PROVIDER_DOMAINS.openai,
      ...PROVIDER_DOMAINS.anthropic,
    ]
    assert.deepEqual(result, expected)
  })

  it('includes explicit allowedDomains alongside provider domains', () => {
    const result = resolveAllowedDomains({
      providers: ['openai'],
      allowedDomains: ['my-llm.example.com'],
    })
    assert.ok(result.includes('api.openai.com'))
    assert.ok(result.includes('my-llm.example.com'))
  })

  it('deduplicates domains that appear in both a provider and allowedDomains', () => {
    const result = resolveAllowedDomains({
      providers: ['openai'],
      allowedDomains: ['api.openai.com'],
    })
    assert.equal(result.filter(d => d === 'api.openai.com').length, 1)
  })

  it('works with allowedDomains only (no providers)', () => {
    const result = resolveAllowedDomains({ allowedDomains: ['custom.example.com'] })
    assert.deepEqual(result, ['custom.example.com'])
  })

  it('throws for an unknown provider name', () => {
    assert.throws(
      () => resolveAllowedDomains({ providers: ['not-a-real-provider'] }),
      /Unknown provider "not-a-real-provider"/
    )
  })

  it('lists all known providers in the error message', () => {
    assert.throws(
      () => resolveAllowedDomains({ providers: ['bogus'] }),
      new RegExp(Object.keys(PROVIDER_DOMAINS).join(', '))
    )
  })
})

describe('resolvePolicy', () => {
  it('returns deny-all when no config and no domains', () => {
    assert.equal(resolvePolicy(undefined, []), 'deny-all')
  })

  it('returns custom when domains are present and no explicit policy', () => {
    assert.equal(resolvePolicy(undefined, ['api.openai.com']), 'custom')
  })

  it('respects an explicit allow-all policy even with no domains', () => {
    assert.equal(resolvePolicy({ policy: 'allow-all' }, []), 'allow-all')
  })

  it('respects an explicit deny-all policy', () => {
    assert.equal(resolvePolicy({ policy: 'deny-all' }, []), 'deny-all')
  })

  it('respects an explicit custom policy', () => {
    assert.equal(resolvePolicy({ policy: 'custom' }, []), 'custom')
  })

  it('explicit policy takes precedence over inferred policy from domains', () => {
    assert.equal(resolvePolicy({ policy: 'allow-all' }, ['api.openai.com']), 'allow-all')
  })
})

describe('PROVIDER_DOMAINS', () => {
  const knownProviders = ['github-copilot', 'gemini', 'openai', 'anthropic', 'ollama', 'github', 'openrouter', 'llama.cpp']

  it('contains all expected providers', () => {
    for (const p of knownProviders) {
      assert.ok(p in PROVIDER_DOMAINS, `missing provider: ${p}`)
    }
  })

  it('every provider has at least one domain', () => {
    for (const [provider, domains] of Object.entries(PROVIDER_DOMAINS)) {
      assert.ok(domains.length > 0, `${provider} has no domains`)
    }
  })
})

describe('loadConfig', () => {
  // run in a clean temp dir so cosmiconfig never finds the repo's own config
  let tmpDir: string
  let originalCwd: string
  let savedEnv: Record<string, string | undefined>

  const ENV_KEYS = ['VMPI_MEMORY', 'VMPI_CPUS', 'PI_CONFIG_DIR', 'VMPI_STATE_DIR', 'VMPI_ROOTFS_EXTRA_MB']

  before(() => {
    tmpDir = join(tmpdir(), `vmpi-test-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    originalCwd = process.cwd()
  })

  after(() => {
    process.chdir(originalCwd)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    // snapshot env vars and change to the clean dir
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    process.chdir(tmpDir)
    rmSync(join(tmpDir, '.vmpirc.json'), { force: true })
  })

  afterEach(() => {
    // restore env vars
    for (const k of ENV_KEYS) {
      if (savedEnv[k] == null) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('returns defaults when no config file or env vars are present', () => {
    const cfg = loadConfig()
    assert.equal(cfg.memory, 512)
    assert.equal(cfg.cpus, 1)
    assert.equal(cfg.piConfigDir, join(homedir(), '.pi'))
    assert.equal(cfg.stateDir, join(homedir(), '.vmpi'))
    assert.equal(cfg.rootfsExtraMb, 128)
    assert.equal(cfg.network.policy, 'deny-all')
    assert.deepEqual(cfg.network.allowedDomains, [])
  })

  it('applies env var overrides', () => {
    process.env.VMPI_MEMORY = '512'
    process.env.VMPI_CPUS = '4'
    process.env.PI_CONFIG_DIR = '/custom/pi'
    process.env.VMPI_STATE_DIR = '/custom/vmpi'

    const cfg = loadConfig()
    assert.equal(cfg.memory, 512)
    assert.equal(cfg.cpus, 4)
    assert.equal(cfg.piConfigDir, '/custom/pi')
    assert.equal(cfg.stateDir, '/custom/vmpi')
  })

  it('reads rootfsExtraMb from a .vmpirc.json file', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({ rootfsExtraMb: 256 }))
    const cfg = loadConfig()
    assert.equal(cfg.rootfsExtraMb, 256)
  })

  it('overrides rootfsExtraMb via VMPI_ROOTFS_EXTRA_MB env var', () => {
    process.env.VMPI_ROOTFS_EXTRA_MB = '512'
    const cfg = loadConfig()
    assert.equal(cfg.rootfsExtraMb, 512)
  })

  it('env var takes precedence over config file for rootfsExtraMb', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({ rootfsExtraMb: 64 }))
    process.env.VMPI_ROOTFS_EXTRA_MB = '256'
    const cfg = loadConfig()
    assert.equal(cfg.rootfsExtraMb, 256)
  })

  it('reads memory and cpus from a .vmpirc.json file', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({ memory: 1024, cpus: 2 }))
    const cfg = loadConfig()
    assert.equal(cfg.memory, 1024)
    assert.equal(cfg.cpus, 2)
  })

  it('env vars take precedence over config file values', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({ memory: 1024 }))
    process.env.VMPI_MEMORY = '128'
    const cfg = loadConfig()
    assert.equal(cfg.memory, 128)
  })

  it('resolves providers from a config file into allowed domains', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({
      network: { providers: ['openai'] },
    }))
    const cfg = loadConfig()
    assert.equal(cfg.network.policy, 'custom')
    assert.ok(cfg.network.allowedDomains.includes('api.openai.com'))
  })

  it('merges providers and explicit allowedDomains', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({
      network: {
        providers: ['anthropic'],
        allowedDomains: ['my-llm.example.com'],
      },
    }))
    const cfg = loadConfig()
    assert.ok(cfg.network.allowedDomains.includes('api.anthropic.com'))
    assert.ok(cfg.network.allowedDomains.includes('my-llm.example.com'))
  })

  it('respects explicit allow-all policy', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({
      network: { policy: 'allow-all' },
    }))
    const cfg = loadConfig()
    assert.equal(cfg.network.policy, 'allow-all')
  })

  it('throws when deny-all is combined with providers', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({
      network: { policy: 'deny-all', providers: ['openai'] },
    }))
    assert.throws(() => loadConfig(), /deny-all.*providers or allowedDomains/)
  })

  it('throws when deny-all is combined with allowedDomains', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({
      network: { policy: 'deny-all', allowedDomains: ['api.openai.com'] },
    }))
    assert.throws(() => loadConfig(), /deny-all.*providers or allowedDomains/)
  })

  it('returns default guest packages when no guestPackages in config', () => {
    const cfg = loadConfig()
    for (const pkg of DEFAULT_GUEST_PACKAGES) {
      assert.ok(cfg.guestPackages.includes(pkg))
    }
  })

  it('merges guestPackages from config file with defaults', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({ guestPackages: ['jq'] }))
    const cfg = loadConfig()
    assert.ok(cfg.guestPackages.includes('jq'))
    for (const pkg of DEFAULT_GUEST_PACKAGES) {
      assert.ok(cfg.guestPackages.includes(pkg))
    }
  })

  it('returns empty postSetupHooks when not configured', () => {
    const cfg = loadConfig()
    assert.deepEqual(cfg.postSetupHooks, [])
  })

  it('passes postSetupHooks from config file through unchanged', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({ postSetupHooks: ['npm install -g typescript', 'gem install rails'] }))
    const cfg = loadConfig()
    assert.deepEqual(cfg.postSetupHooks, ['npm install -g typescript', 'gem install rails'])
  })

  it('finds config file in a parent directory', () => {
    const subDir = join(tmpDir, 'nested', 'child')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({ memory: 2048 }))
    process.chdir(subDir)
    const cfg = loadConfig()
    assert.equal(cfg.memory, 2048)
  })

  it('prefers config in cwd over one in a parent directory', () => {
    const subDir = join(tmpDir, 'nested')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({ memory: 2048 }))
    writeFileSync(join(subDir, '.vmpirc.json'), JSON.stringify({ memory: 4096 }))
    process.chdir(subDir)
    const cfg = loadConfig()
    assert.equal(cfg.memory, 4096)
  })

  it('returns empty secrets object when no secrets configured', () => {
    const cfg = loadConfig()
    assert.deepEqual(cfg.secrets, {})
    assert.deepEqual(cfg.missingSecrets, [])
  })

  it('resolves a secret whose env var is present', () => {
    process.env.VMPI_TEST_SECRET = 'hunter2'
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({
      secrets: { VMPI_TEST_SECRET: { hosts: ['api.example.com'] } },
    }))
    const cfg = loadConfig()
    assert.deepEqual(cfg.secrets, {
      VMPI_TEST_SECRET: { hosts: ['api.example.com'], value: 'hunter2' },
    })
    delete process.env.VMPI_TEST_SECRET
  })

  it('populates missingSecrets when a secret env var is absent', () => {
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({
      secrets: { VMPI_NONEXISTENT_XYZ: { hosts: ['api.example.com'] } },
    }))
    const cfg = loadConfig()
    assert.deepEqual(cfg.secrets, {})
    assert.deepEqual(cfg.missingSecrets, [{ name: 'VMPI_NONEXISTENT_XYZ', envVarName: 'VMPI_NONEXISTENT_XYZ' }])
  })

  it('reads secret value from the "env" override var when specified', () => {
    process.env.VMPI_TEST_SECRET_A = 'alpha'
    writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify({
      secrets: { GITHUB_TOKEN: { hosts: ['api.github.com'], env: 'VMPI_TEST_SECRET_A' } },
    }))
    const cfg = loadConfig()
    assert.deepEqual(cfg.secrets, {
      GITHUB_TOKEN: { hosts: ['api.github.com'], value: 'alpha' },
    })
    delete process.env.VMPI_TEST_SECRET_A
  })
})

describe('resolveGuestPackages', () => {
  it('returns the default packages when no extras given', () => {
    const result = resolveGuestPackages(undefined)
    for (const pkg of DEFAULT_GUEST_PACKAGES) {
      assert.ok(result.includes(pkg), `expected default package '${pkg}' to be present`)
    }
  })

  it('includes extra packages alongside defaults', () => {
    const result = resolveGuestPackages(['jq', 'curl'])
    assert.ok(result.includes('jq'))
    assert.ok(result.includes('curl'))
    for (const pkg of DEFAULT_GUEST_PACKAGES) {
      assert.ok(result.includes(pkg))
    }
  })

  it('deduplicates packages that are already in defaults', () => {
    const result = resolveGuestPackages(['git', 'jq'])
    assert.equal(result.filter(p => p === 'git').length, 1)
    assert.ok(result.includes('jq'))
  })
})

describe('resolveLocalServices', () => {
  it('returns empty array when no config supplied', () => {
    assert.deepEqual(resolveLocalServices(undefined), [])
  })

  it('returns empty array for empty localServices list', () => {
    assert.deepEqual(resolveLocalServices({ localServices: [] }), [])
  })

  it('resolves a single entry to hostname and upstream address', () => {
    const result = resolveLocalServices({ localServices: [{ hostname: 'my-api.local', port: 8080 }] })
    assert.deepEqual(result, [{ hostname: 'my-api.local', upstream: '127.0.0.1:8080' }])
  })

  it('resolves multiple entries', () => {
    const result = resolveLocalServices({
      localServices: [
        { hostname: 'ollama.local', port: 11434 },
        { hostname: 'db.local', port: 5432 },
      ],
    })
    assert.deepEqual(result, [
      { hostname: 'ollama.local', upstream: '127.0.0.1:11434' },
      { hostname: 'db.local', upstream: '127.0.0.1:5432' },
    ])
  })

  it('throws for missing hostname', () => {
    assert.throws(
      () => resolveLocalServices({ localServices: [{ hostname: '', port: 8080 }] }),
      /hostname.*must be a non-empty string/
    )
  })

  it('throws when hostname is an IPv4 address', () => {
    assert.throws(
      () => resolveLocalServices({ localServices: [{ hostname: '127.0.0.1', port: 8080 }] }),
      /hostname.*must be a DNS name, not an IP address/
    )
  })

  it('throws when hostname contains a colon (IP:port syntax)', () => {
    assert.throws(
      () => resolveLocalServices({ localServices: [{ hostname: '127.0.0.1:8080', port: 8080 }] }),
      /hostname.*must be a DNS name, not an IP address/
    )
  })

  it('throws for port out of range', () => {
    assert.throws(
      () => resolveLocalServices({ localServices: [{ hostname: 'x.local', port: 0 }] }),
      /port.*must be an integer/
    )
    assert.throws(
      () => resolveLocalServices({ localServices: [{ hostname: 'x.local', port: 65536 }] }),
      /port.*must be an integer/
    )
  })

  it('throws for non-integer port', () => {
    assert.throws(
      () => resolveLocalServices({ localServices: [{ hostname: 'x.local', port: 8080.5 }] }),
      /port.*must be an integer/
    )
  })
})

describe('resolveSecrets', () => {
  it('returns empty object when no secrets config supplied', () => {
    const { resolved, missing } = resolveSecrets(undefined, {})
    assert.deepEqual(resolved, {})
    assert.deepEqual(missing, [])
  })

  it('returns empty object for an empty secrets record', () => {
    const { resolved, missing } = resolveSecrets({}, { SOME_VAR: 'value' })
    assert.deepEqual(resolved, {})
    assert.deepEqual(missing, [])
  })

  it('resolves a secret whose env var is present', () => {
    const { resolved, missing } = resolveSecrets(
      { GITHUB_TOKEN: { hosts: ['api.github.com'] } },
      { GITHUB_TOKEN: 'ghp_abc123' }
    )
    assert.deepEqual(resolved, {
      GITHUB_TOKEN: { hosts: ['api.github.com'], value: 'ghp_abc123' },
    })
    assert.deepEqual(missing, [])
  })

  it('reports missing secret when env var is absent', () => {
    const { resolved, missing } = resolveSecrets(
      { MISSING_TOKEN: { hosts: ['api.example.com'] } },
      {}
    )
    assert.deepEqual(resolved, {})
    assert.deepEqual(missing, [{ name: 'MISSING_TOKEN', envVarName: 'MISSING_TOKEN' }])
  })

  it('returns only the present subset and reports missing when some secrets are absent', () => {
    const { resolved, missing } = resolveSecrets(
      {
        TOKEN_A: { hosts: ['a.example.com'] },
        TOKEN_B: { hosts: ['b.example.com'] },
        TOKEN_C: { hosts: ['c.example.com'] },
      },
      { TOKEN_A: 'hello', TOKEN_C: 'world' }
    )
    assert.deepEqual(resolved, {
      TOKEN_A: { hosts: ['a.example.com'], value: 'hello' },
      TOKEN_C: { hosts: ['c.example.com'], value: 'world' },
    })
    assert.deepEqual(missing, [{ name: 'TOKEN_B', envVarName: 'TOKEN_B' }])
  })

  it('reads the value from a different host env var when "env" is set', () => {
    const { resolved, missing } = resolveSecrets(
      { GITHUB_TOKEN: { hosts: ['api.github.com'], env: 'MY_PAT' } },
      { MY_PAT: 'ghp_xyz' }
    )
    assert.deepEqual(resolved, {
      GITHUB_TOKEN: { hosts: ['api.github.com'], value: 'ghp_xyz' },
    })
    assert.deepEqual(missing, [])
  })

  it('prefers the "env" var name over the key name when both are present', () => {
    const { resolved } = resolveSecrets(
      { GITHUB_TOKEN: { hosts: ['api.github.com'], env: 'MY_PAT' } },
      { GITHUB_TOKEN: 'wrong', MY_PAT: 'correct' }
    )
    assert.equal(resolved.GITHUB_TOKEN?.value, 'correct')
  })

  it('preserves the hosts array on the resolved entry', () => {
    const hosts = ['api.github.com', 'github.com']
    const { resolved } = resolveSecrets({ GITHUB_TOKEN: { hosts } }, { GITHUB_TOKEN: 'tok' })
    assert.deepEqual(resolved.GITHUB_TOKEN?.hosts, hosts)
  })
})
