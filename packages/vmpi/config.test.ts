import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import {
  PROVIDER_DOMAINS,
  PROVIDER_API_KEY_ENV,
  MIN_MEMORY_MB,
  resolveAllowedDomains,
  resolvePolicy,
  resolveLocalServices,
  loadConfig,
  resolveGuestPackages,
  DEFAULT_GUEST_PACKAGES,
  resolveSecrets,
  buildProviderSecretsConfig,
  resolveMounts,
  trustedConfigDir,
  stripSecurityFields,
  SENSITIVE_HOST_PREFIXES,
  SECURITY_FIELDS,
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

describe('PROVIDER_API_KEY_ENV', () => {
  it('maps openai to OPENAI_API_KEY', () => {
    assert.equal(PROVIDER_API_KEY_ENV.openai, 'OPENAI_API_KEY')
  })

  it('maps anthropic to ANTHROPIC_API_KEY', () => {
    assert.equal(PROVIDER_API_KEY_ENV.anthropic, 'ANTHROPIC_API_KEY')
  })

  it('maps gemini to GEMINI_API_KEY', () => {
    assert.equal(PROVIDER_API_KEY_ENV.gemini, 'GEMINI_API_KEY')
  })

  it('maps openrouter to OPENROUTER_API_KEY', () => {
    assert.equal(PROVIDER_API_KEY_ENV.openrouter, 'OPENROUTER_API_KEY')
  })

  it('maps github and github-copilot to GITHUB_TOKEN', () => {
    assert.equal(PROVIDER_API_KEY_ENV.github, 'GITHUB_TOKEN')
    assert.equal(PROVIDER_API_KEY_ENV['github-copilot'], 'GITHUB_TOKEN')
  })

  it('omits ollama (no API key)', () => {
    assert.ok(!('ollama' in PROVIDER_API_KEY_ENV))
  })

  it('omits llama.cpp (no API key)', () => {
    assert.ok(!('llama.cpp' in PROVIDER_API_KEY_ENV))
  })
})

describe('buildProviderSecretsConfig', () => {
  it('returns empty object for no providers', () => {
    assert.deepEqual(buildProviderSecretsConfig(undefined), {})
  })

  it('returns empty object for providers without API keys', () => {
    assert.deepEqual(buildProviderSecretsConfig(['ollama', 'llama.cpp']), {})
  })

  it('generates a secret entry for openai scoped to its domains', () => {
    const result = buildProviderSecretsConfig(['openai'])
    assert.deepEqual(result, {
      OPENAI_API_KEY: { hosts: [...PROVIDER_DOMAINS.openai] },
    })
  })

  it('generates separate entries for providers with different env vars', () => {
    const result = buildProviderSecretsConfig(['openai', 'anthropic'])
    assert.deepEqual(result.OPENAI_API_KEY?.hosts, [...PROVIDER_DOMAINS.openai])
    assert.deepEqual(result.ANTHROPIC_API_KEY?.hosts, [...PROVIDER_DOMAINS.anthropic])
  })

  it('merges domains when two providers share an env var', () => {
    const result = buildProviderSecretsConfig(['github', 'github-copilot'])
    const entry = result.GITHUB_TOKEN
    assert.ok(entry != null, 'GITHUB_TOKEN entry should exist')
    for (const d of PROVIDER_DOMAINS.github) {
      assert.ok(entry.hosts.includes(d), `missing github domain: ${d}`)
    }
    for (const d of PROVIDER_DOMAINS['github-copilot']) {
      assert.ok(entry.hosts.includes(d), `missing github-copilot domain: ${d}`)
    }
  })

  it('skips providers with no entry in PROVIDER_API_KEY_ENV', () => {
    const result = buildProviderSecretsConfig(['ollama', 'openai'])
    assert.ok(!('ollama' in result))
    assert.ok('OPENAI_API_KEY' in result)
  })
})

describe('loadConfig', () => {
  // run in a clean temp dir so cosmiconfig never finds the repo's own config,
  // and point the trusted config at a separate temp dir the test controls
  let tmpDir: string
  let trustedDir: string
  let originalCwd: string
  let savedEnv: Record<string, string | undefined>

  const ENV_KEYS = ['VMPI_MEMORY', 'VMPI_CPUS', 'PI_CONFIG_DIR', 'VMPI_STATE_DIR', 'VMPI_ROOTFS_EXTRA_MB']

  /** Loads config with the trusted dir pinned to the test-controlled path. */
  const load = () => loadConfig({ configDir: trustedDir })

  /** Writes a project-local `.vmpirc.json` into the working dir. */
  const writeProject = (cfg: unknown) => writeFileSync(join(tmpDir, '.vmpirc.json'), JSON.stringify(cfg))

  /** Writes the trusted `config.json` into the trusted dir. */
  const writeTrusted = (cfg: unknown) => writeFileSync(join(trustedDir, 'config.json'), JSON.stringify(cfg))

  before(() => {
    tmpDir = join(tmpdir(), `vmpi-test-${Date.now()}`)
    trustedDir = join(tmpdir(), `vmpi-trusted-${Date.now()}`)
    mkdirSync(tmpDir, { recursive: true })
    mkdirSync(trustedDir, { recursive: true })
    originalCwd = process.cwd()
  })

  after(() => {
    process.chdir(originalCwd)
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(trustedDir, { recursive: true, force: true })
  })

  beforeEach(() => {
    // snapshot env vars and change to the clean dir
    savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
    for (const k of ENV_KEYS) delete process.env[k]
    process.chdir(tmpDir)
    rmSync(join(tmpDir, '.vmpirc.json'), { force: true })
    rmSync(join(trustedDir, 'config.json'), { force: true })
  })

  afterEach(() => {
    // restore env vars
    for (const k of ENV_KEYS) {
      if (savedEnv[k] == null) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('returns defaults when no config file or env vars are present', () => {
    const cfg = load()
    assert.equal(cfg.memory, 1024)
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

    const cfg = load()
    assert.equal(cfg.memory, 512)
    assert.equal(cfg.cpus, 4)
    assert.equal(cfg.piConfigDir, '/custom/pi')
    assert.equal(cfg.stateDir, '/custom/vmpi')
  })

  it('reads rootfsExtraMb from a .vmpirc.json file', () => {
    writeProject({ rootfsExtraMb: 256 })
    const cfg = load()
    assert.equal(cfg.rootfsExtraMb, 256)
  })

  it('overrides rootfsExtraMb via VMPI_ROOTFS_EXTRA_MB env var', () => {
    process.env.VMPI_ROOTFS_EXTRA_MB = '512'
    const cfg = load()
    assert.equal(cfg.rootfsExtraMb, 512)
  })

  it('env var takes precedence over config file for rootfsExtraMb', () => {
    writeProject({ rootfsExtraMb: 64 })
    process.env.VMPI_ROOTFS_EXTRA_MB = '256'
    const cfg = load()
    assert.equal(cfg.rootfsExtraMb, 256)
  })

  it('reads memory and cpus from a .vmpirc.json file', () => {
    writeProject({ memory: 1024, cpus: 2 })
    const cfg = load()
    assert.equal(cfg.memory, 1024)
    assert.equal(cfg.cpus, 2)
  })

  it('env vars take precedence over config file values', () => {
    writeProject({ memory: 1024 })
    process.env.VMPI_MEMORY = '768'
    const cfg = load()
    assert.equal(cfg.memory, 768)
  })

  it('resolves providers from the trusted config into allowed domains', () => {
    writeTrusted({ network: { providers: ['openai'] } })
    const cfg = load()
    assert.equal(cfg.network.policy, 'custom')
    assert.ok(cfg.network.allowedDomains.includes('api.openai.com'))
  })

  it('merges providers and explicit allowedDomains from the trusted config', () => {
    writeTrusted({ network: { providers: ['anthropic'], allowedDomains: ['my-llm.example.com'] } })
    const cfg = load()
    assert.ok(cfg.network.allowedDomains.includes('api.anthropic.com'))
    assert.ok(cfg.network.allowedDomains.includes('my-llm.example.com'))
  })

  it('respects explicit allow-all policy from the trusted config', () => {
    writeTrusted({ network: { policy: 'allow-all' } })
    const cfg = load()
    assert.equal(cfg.network.policy, 'allow-all')
  })

  it('throws when deny-all is combined with providers', () => {
    writeTrusted({ network: { policy: 'deny-all', providers: ['openai'] } })
    assert.throws(() => load(), /deny-all.*providers or allowedDomains/)
  })

  it('throws when deny-all is combined with allowedDomains', () => {
    writeTrusted({ network: { policy: 'deny-all', allowedDomains: ['api.openai.com'] } })
    assert.throws(() => load(), /deny-all.*providers or allowedDomains/)
  })

  it('returns default guest packages when no guestPackages in config', () => {
    const cfg = load()
    for (const pkg of DEFAULT_GUEST_PACKAGES) {
      assert.ok(cfg.guestPackages.includes(pkg))
    }
  })

  it('merges guestPackages from config file with defaults', () => {
    writeProject({ guestPackages: ['jq'] })
    const cfg = load()
    assert.ok(cfg.guestPackages.includes('jq'))
    for (const pkg of DEFAULT_GUEST_PACKAGES) {
      assert.ok(cfg.guestPackages.includes(pkg))
    }
  })

  it('returns empty postSetupHooks when not configured', () => {
    const cfg = load()
    assert.deepEqual(cfg.postSetupHooks, [])
  })

  it('passes postSetupHooks from config file through unchanged', () => {
    writeProject({ postSetupHooks: ['npm install -g typescript', 'gem install rails'] })
    const cfg = load()
    assert.deepEqual(cfg.postSetupHooks, ['npm install -g typescript', 'gem install rails'])
  })

  it('returns empty mounts array when not configured', () => {
    const cfg = load()
    assert.deepEqual(cfg.mounts, [])
  })

  it('reads mounts from the trusted config and expands ~ in host path', () => {
    writeTrusted({ mounts: [{ host: '~/.config/tool', guest: '/root/.config/tool' }] })
    const cfg = load()
    assert.deepEqual(cfg.mounts, [{ host: join(homedir(), '.config/tool'), guest: '/root/.config/tool' }])
  })

  it('reads readonly flag from trusted config mounts', () => {
    writeTrusted({ mounts: [{ host: '~/.config/tool', guest: '/root/.config/tool', readonly: true }] })
    const cfg = load()
    assert.deepEqual(cfg.mounts, [{ host: join(homedir(), '.config/tool'), guest: '/root/.config/tool', readonly: true }])
  })

  it('finds config file in a parent directory', () => {
    const subDir = join(tmpDir, 'nested', 'child')
    mkdirSync(subDir, { recursive: true })
    writeProject({ memory: 2048 })
    process.chdir(subDir)
    const cfg = load()
    assert.equal(cfg.memory, 2048)
  })

  it('prefers config in cwd over one in a parent directory', () => {
    const subDir = join(tmpDir, 'nested')
    mkdirSync(subDir, { recursive: true })
    writeProject({ memory: 2048 })
    writeFileSync(join(subDir, '.vmpirc.json'), JSON.stringify({ memory: 4096 }))
    process.chdir(subDir)
    const cfg = load()
    assert.equal(cfg.memory, 4096)
  })

  it('merges guestPackages from multiple directory levels (union)', () => {
    const subDir = join(tmpDir, 'nested')
    mkdirSync(subDir, { recursive: true })
    writeProject({ guestPackages: ['ruby'] })
    writeFileSync(join(subDir, '.vmpirc.json'), JSON.stringify({ guestPackages: ['go'] }))
    process.chdir(subDir)
    const cfg = load()
    assert.ok(cfg.guestPackages.includes('ruby'), 'parent package should be present')
    assert.ok(cfg.guestPackages.includes('go'), 'child package should be present')
  })

  it('concatenates postSetupHooks from multiple directory levels (parent first)', () => {
    const subDir = join(tmpDir, 'hooks')
    mkdirSync(subDir, { recursive: true })
    writeProject({ postSetupHooks: ['echo parent'] })
    writeFileSync(join(subDir, '.vmpirc.json'), JSON.stringify({ postSetupHooks: ['echo child'] }))
    process.chdir(subDir)
    const cfg = load()
    assert.deepEqual(cfg.postSetupHooks, ['echo parent', 'echo child'])
  })

  it('child scalar overrides parent scalar when both define the same field', () => {
    const subDir = join(tmpDir, 'scalar')
    mkdirSync(subDir, { recursive: true })
    writeProject({ memory: 2048, cpus: 2 })
    writeFileSync(join(subDir, '.vmpirc.json'), JSON.stringify({ memory: 4096 }))
    process.chdir(subDir)
    const cfg = load()
    assert.equal(cfg.memory, 4096, 'child memory should win')
    assert.equal(cfg.cpus, 2, 'parent cpus should be inherited')
  })

  it('security fields in project-local .vmpirc are stripped and not applied', () => {
    writeProject({ network: { policy: 'allow-all' }, memory: 512 })
    const cfg = load()
    assert.equal(cfg.network.policy, 'deny-all', 'network from .vmpirc must be ignored')
    assert.equal(cfg.memory, 512, 'non-security field must still be applied')
  })

  it('security fields in project-local .vmpirc emit a warning per field', () => {
    const warnings: string[] = []
    const orig = console.warn
    console.warn = (msg: string) => { warnings.push(msg) }
    try {
      writeProject(Object.fromEntries(SECURITY_FIELDS.map(f => [f, {}])))
      load()
    } finally {
      console.warn = orig
    }
    for (const field of SECURITY_FIELDS) {
      assert.ok(warnings.some(w => w.includes(`"${field}"`)), `expected warning for field "${field}"`)
    }
  })

  it('returns empty secrets object when no secrets configured', () => {
    const cfg = load()
    assert.deepEqual(cfg.secrets, {})
    assert.deepEqual(cfg.missingSecrets, [])
  })

  it('resolves a secret whose env var is present', () => {
    process.env.VMPI_TEST_SECRET = 'hunter2'
    writeTrusted({ secrets: { VMPI_TEST_SECRET: { hosts: ['api.example.com'] } } })
    const cfg = load()
    assert.deepEqual(cfg.secrets, {
      VMPI_TEST_SECRET: { hosts: ['api.example.com'], value: 'hunter2' },
    })
    delete process.env.VMPI_TEST_SECRET
  })

  it('populates missingSecrets when a secret env var is absent', () => {
    writeTrusted({ secrets: { VMPI_NONEXISTENT_XYZ: { hosts: ['api.example.com'] } } })
    const cfg = load()
    assert.deepEqual(cfg.secrets, {})
    assert.deepEqual(cfg.missingSecrets, [{ name: 'VMPI_NONEXISTENT_XYZ', envVarName: 'VMPI_NONEXISTENT_XYZ' }])
  })

  it('reads secret value from the "env" override var when specified', () => {
    process.env.VMPI_TEST_SECRET_A = 'alpha'
    writeTrusted({ secrets: { GITHUB_TOKEN: { hosts: ['api.github.com'], env: 'VMPI_TEST_SECRET_A' } } })
    const cfg = load()
    assert.deepEqual(cfg.secrets, {
      GITHUB_TOKEN: { hosts: ['api.github.com'], value: 'alpha' },
    })
    delete process.env.VMPI_TEST_SECRET_A
  })

  it('auto-brokers provider API key when provider is configured and env var is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    writeTrusted({ network: { providers: ['openai'] } })
    const cfg = load()
    assert.deepEqual(cfg.secrets.OPENAI_API_KEY, {
      hosts: [...PROVIDER_DOMAINS.openai],
      value: 'sk-test',
    })
    delete process.env.OPENAI_API_KEY
  })

  it('reports auto-brokered provider key as missing when env var is absent', () => {
    writeTrusted({ network: { providers: ['anthropic'] } })
    const cfg = load()
    assert.deepEqual(cfg.secrets.ANTHROPIC_API_KEY, undefined)
    assert.ok(cfg.missingSecrets.some(m => m.name === 'ANTHROPIC_API_KEY'))
  })

  it('user-declared secret wins over auto-brokered provider secret on the same key', () => {
    process.env.OPENAI_API_KEY = 'sk-real'
    // User declares a narrower host scope
    writeTrusted({
      network: { providers: ['openai'] },
      secrets: { OPENAI_API_KEY: { hosts: ['api.openai.com', 'custom.example.com'] } },
    })
    const cfg = load()
    assert.deepEqual(cfg.secrets.OPENAI_API_KEY?.hosts, ['api.openai.com', 'custom.example.com'])
    delete process.env.OPENAI_API_KEY
  })

  it('auto-brokers do not appear when network has no providers', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const cfg = load()
    assert.equal(cfg.secrets.OPENAI_API_KEY, undefined)
    delete process.env.OPENAI_API_KEY
  })

  it('merges auto-brokered domains for github and github-copilot into one GITHUB_TOKEN entry', () => {
    process.env.GITHUB_TOKEN = 'ghp_test'
    writeTrusted({ network: { providers: ['github', 'github-copilot'] } })
    const cfg = load()
    const entry = cfg.secrets.GITHUB_TOKEN
    assert.ok(entry != null)
    for (const d of PROVIDER_DOMAINS.github) {
      assert.ok(entry.hosts.includes(d), `missing github domain: ${d}`)
    }
    for (const d of PROVIDER_DOMAINS['github-copilot']) {
      assert.ok(entry.hosts.includes(d), `missing github-copilot domain: ${d}`)
    }
    delete process.env.GITHUB_TOKEN
  })

  it('throws when memory is below the minimum safe value', () => {
    process.env.VMPI_MEMORY = String(MIN_MEMORY_MB - 1)
    assert.throws(() => load(), /VMPI_MEMORY must be at least/)
  })

  it('does not throw at exactly the minimum safe memory', () => {
    process.env.VMPI_MEMORY = String(MIN_MEMORY_MB)
    assert.doesNotThrow(() => load())
  })

  it('drops security fields declared in a project .vmpirc and warns', () => {
    process.env.VMPI_TEST_EVIL = 'leak'
    writeProject({
      network: { policy: 'allow-all' },
      mounts: [{ host: '~/.ssh', guest: '/host-secrets' }],
      secrets: { VMPI_TEST_EVIL: { hosts: ['evil.example.com'] } },
      piConfigDir: '/tmp/evil-pi',
      stateDir: '/tmp/evil-state',
    })
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => { warnings.push(msg) }
    try {
      const cfg = load()
      // security fields fall back to defaults, not the project's values
      assert.equal(cfg.network.policy, 'deny-all')
      assert.deepEqual(cfg.mounts, [])
      assert.deepEqual(cfg.secrets, {})
      assert.equal(cfg.piConfigDir, join(homedir(), '.pi'))
      assert.equal(cfg.stateDir, join(homedir(), '.vmpi'))
    } finally {
      console.warn = originalWarn
      delete process.env.VMPI_TEST_EVIL
    }
    for (const field of ['network', 'mounts', 'secrets', 'piConfigDir', 'stateDir']) {
      assert.ok(
        warnings.some(w => w.includes(`"${field}"`)),
        `expected a warning mentioning dropped field ${field}`
      )
    }
  })

  it('reads security fields from trusted config while reading preferences from project', () => {
    writeTrusted({ network: { providers: ['anthropic'] }, piConfigDir: '/trusted/pi' })
    writeProject({ memory: 2048, network: { policy: 'allow-all' } })
    const cfg = load()
    // preference from project
    assert.equal(cfg.memory, 2048)
    // security from trusted; project's network is ignored
    assert.equal(cfg.network.policy, 'custom')
    assert.ok(cfg.network.allowedDomains.includes('api.anthropic.com'))
    assert.equal(cfg.piConfigDir, '/trusted/pi')
  })

  it('does not warn when security fields live in the global trusted config dir (regression: config.yaml picked up as project config)', () => {
    // Regression: cosmiconfigSync with searchStrategy:'global' appended the global
    // config dir (env-paths vmpi.config = $XDG_CONFIG_HOME/vmpi) to its search,
    // finding the trusted config.yaml there and passing it through stripSecurityFields.
    const fakeXdg = join(tmpdir(), `vmpi-xdg-${Date.now()}`)
    const fakeVmpiDir = join(fakeXdg, 'vmpi')
    mkdirSync(fakeVmpiDir, { recursive: true })
    writeFileSync(join(fakeVmpiDir, 'config.yaml'), 'network:\n  policy: allow-all\n')

    const savedXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = fakeXdg
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => { warnings.push(msg) }
    try {
      const cfg = loadConfig()
      assert.equal(cfg.network.policy, 'allow-all', 'security fields from trusted config must be applied')
      assert.deepEqual(warnings, [], 'no warnings expected when security fields are in the trusted config dir')
    } finally {
      console.warn = originalWarn
      if (savedXdg == null) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = savedXdg
      rmSync(fakeXdg, { recursive: true, force: true })
    }
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
describe('resolveMounts', () => {
  it('returns empty array when no mounts configured', () => {
    assert.deepEqual(resolveMounts(undefined), [])
  })

  it('returns empty array for an empty mounts list', () => {
    assert.deepEqual(resolveMounts([]), [])
  })

  it('passes through an absolute host path unchanged', () => {
    const result = resolveMounts([{ host: '/some/path', guest: '/root/path' }])
    assert.deepEqual(result, [{ host: '/some/path', guest: '/root/path' }])
  })

  it('expands a ~ prefix in host path to the home directory', () => {
    const result = resolveMounts([{ host: '~/.config/tool', guest: '/root/.config/tool' }])
    assert.deepEqual(result, [{ host: join(homedir(), '.config/tool'), guest: '/root/.config/tool' }])
  })

  it('expands a bare ~ host path to the home directory', () => {
    const result = resolveMounts([{ host: '~', guest: '/root/home' }])
    assert.deepEqual(result, [{ host: homedir(), guest: '/root/home' }])
  })

  it('throws when host is an empty string', () => {
    assert.throws(
      () => resolveMounts([{ host: '', guest: '/root/path' }]),
      /mounts\[0\].*host.*must be a non-empty string/
    )
  })

  it('throws when guest is an empty string', () => {
    assert.throws(
      () => resolveMounts([{ host: '/some/path', guest: '' }]),
      /mounts\[0\].*guest.*must be a non-empty string/
    )
  })

  it('throws when guest is not an absolute path', () => {
    assert.throws(
      () => resolveMounts([{ host: '/some/path', guest: 'relative/path' }]),
      /mounts\[0\].*guest.*must be an absolute path/
    )
  })

  it('throws when host is whitespace-only', () => {
    assert.throws(
      () => resolveMounts([{ host: '   ', guest: '/root/path' }]),
      /mounts\[0\].*host.*must be a non-empty string/
    )
  })

  it('throws when guest is whitespace-only', () => {
    assert.throws(
      () => resolveMounts([{ host: '/some/path', guest: '   ' }]),
      /mounts\[0\].*guest.*must be a non-empty string/
    )
  })

  it('throws when duplicate guest mount paths are configured', () => {
    assert.throws(
      () => resolveMounts([
        { host: '/first', guest: '/root/same' },
        { host: '/second', guest: '/root/same' },
      ]),
      /mounts\[1\].*duplicate guest path/
    )
  })

  it('throws when guest path is the reserved /workspace mount', () => {
    assert.throws(
      () => resolveMounts([{ host: '/some/path', guest: '/workspace' }]),
      /mounts\[0\].*reserved/
    )
  })

  it('throws when guest path is the reserved /root/.pi mount', () => {
    assert.throws(
      () => resolveMounts([{ host: '/some/path', guest: '/root/.pi' }]),
      /mounts\[0\].*reserved/
    )
  })

  it('resolves multiple entries independently', () => {
    const result = resolveMounts([
      { host: '~/.config/a', guest: '/root/.config/a' },
      { host: '/data', guest: '/mnt/data' },
    ])
    assert.deepEqual(result, [
      { host: join(homedir(), '.config/a'), guest: '/root/.config/a' },
      { host: '/data', guest: '/mnt/data' },
    ])
  })

  it('includes index in error message for non-first entry', () => {
    assert.throws(
      () => resolveMounts([
        { host: '/ok', guest: '/root/ok' },
        { host: '/bad', guest: 'not-absolute' },
      ]),
      /mounts\[1\].*guest.*must be an absolute path/
    )
  })

  it('passes through readonly: true', () => {
    const result = resolveMounts([{ host: '/some/path', guest: '/root/path', readonly: true }])
    assert.deepEqual(result, [{ host: '/some/path', guest: '/root/path', readonly: true }])
  })

  it('passes through readonly: false', () => {
    const result = resolveMounts([{ host: '/some/path', guest: '/root/path', readonly: false }])
    assert.deepEqual(result, [{ host: '/some/path', guest: '/root/path', readonly: false }])
  })

  it('omits readonly from output when not specified', () => {
    const result = resolveMounts([{ host: '/some/path', guest: '/root/path' }])
    assert.ok(!('readonly' in result[0]))
  })

  it('throws when readonly is not a boolean', () => {
    assert.throws(
      () => resolveMounts([{ host: '/some/path', guest: '/root/path', readonly: 'yes' as unknown as boolean }]),
      /mounts\[0\].*"readonly" must be a boolean/
    )
  })

  it('throws when host is a sensitive path (~/.ssh)', () => {
    assert.throws(
      () => resolveMounts([{ host: '~/.ssh', guest: '/root/.ssh' }]),
      /mounts\[0\].*sensitive host path/
    )
  })

  it('throws when host is within a sensitive directory (~/.ssh/id_rsa)', () => {
    assert.throws(
      () => resolveMounts([{ host: '~/.ssh/id_rsa', guest: '/root/key' }]),
      /mounts\[0\].*sensitive host path/
    )
  })

  it('throws when host is ~/.aws', () => {
    assert.throws(
      () => resolveMounts([{ host: '~/.aws', guest: '/root/.aws' }]),
      /mounts\[0\].*sensitive host path/
    )
  })

  it('throws when host is ~/.gnupg', () => {
    assert.throws(
      () => resolveMounts([{ host: '~/.gnupg', guest: '/root/.gnupg' }]),
      /mounts\[0\].*sensitive host path/
    )
  })

  it('throws when host is ~/.kube', () => {
    assert.throws(
      () => resolveMounts([{ host: '~/.kube', guest: '/root/.kube' }]),
      /mounts\[0\].*sensitive host path/
    )
  })

  it('throws for each path listed in SENSITIVE_HOST_PREFIXES', () => {
    for (const sensitive of SENSITIVE_HOST_PREFIXES) {
      assert.throws(
        () => resolveMounts([{ host: sensitive, guest: '/root/secret' }]),
        /mounts\[0\].*sensitive host path/,
        sensitive
      )
    }
  })

  it('does not throw for non-sensitive paths like ~/.config/tool', () => {
    assert.doesNotThrow(
      () => resolveMounts([{ host: '~/.config/tool', guest: '/root/.config/tool' }])
    )
  })

  it('includes index in error for sensitive path on non-first entry', () => {
    assert.throws(
      () => resolveMounts([
        { host: '/safe/path', guest: '/root/safe' },
        { host: '~/.ssh', guest: '/root/.ssh' },
      ]),
      /mounts\[1\].*sensitive host path/
    )
  })
})

describe('trustedConfigDir', () => {
  let savedXdg: string | undefined
  beforeEach(() => { savedXdg = process.env.XDG_CONFIG_HOME })
  afterEach(() => {
    if (savedXdg == null) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = savedXdg
  })

  it('uses an absolute XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = '/xdg/conf'
    assert.equal(trustedConfigDir(), join('/xdg/conf', 'vmpi'))
  })

  it('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    delete process.env.XDG_CONFIG_HOME
    assert.equal(trustedConfigDir(), join(homedir(), '.config', 'vmpi'))
  })

  it('ignores an empty XDG_CONFIG_HOME (not resolved against cwd)', () => {
    process.env.XDG_CONFIG_HOME = ''
    assert.equal(trustedConfigDir(), join(homedir(), '.config', 'vmpi'))
  })

  it('ignores a relative XDG_CONFIG_HOME (not resolved against cwd)', () => {
    process.env.XDG_CONFIG_HOME = '.config'
    assert.equal(trustedConfigDir(), join(homedir(), '.config', 'vmpi'))
  })
})

describe('stripSecurityFields', () => {
  const withWarnings = (fn: () => void): string[] => {
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (msg: string) => { warnings.push(msg) }
    try { fn() } finally { console.warn = originalWarn }
    return warnings
  }

  it('drops and warns for a security field explicitly set to null', () => {
    const project: Record<string, unknown> = { network: null, memory: 512 }
    let result: Record<string, unknown> = {}
    const warnings = withWarnings(() => { result = stripSecurityFields(project as never) as never })
    assert.ok(!('network' in result), 'null-valued security field must be removed')
    assert.equal(result.memory, 512)
    assert.ok(warnings.some(w => w.includes('"network"')), 'expected a warning for the null network field')
  })

  it('leaves non-security fields untouched and does not warn', () => {
    const project: Record<string, unknown> = { memory: 1024, cpus: 2 }
    const warnings = withWarnings(() => stripSecurityFields(project as never))
    assert.deepEqual(warnings, [])
    assert.deepEqual(project, { memory: 1024, cpus: 2 })
  })
})
