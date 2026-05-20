import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { cosmiconfigSync } = require('cosmiconfig') as typeof import('cosmiconfig')

/**
 * Known LLM provider names and other built-in network presets mapped to the
 * domains they require. Used to build network allowlists for the sandbox VM.
 */
export const PROVIDER_DOMAINS: Record<string, readonly string[]> = {
  'github-copilot': [
    '*.githubcopilot.com',
    'api.github.com',
    'copilot-proxy.githubusercontent.com',
  ],
  gemini: [
    'generativelanguage.googleapis.com',
    'oauth2.googleapis.com',
    'www.googleapis.com',
  ],
  openai: [
    'api.openai.com',
  ],
  anthropic: [
    'api.anthropic.com',
  ],
  ollama: [
    'localhost',
    '127.0.0.1',
  ],
  github: [
    'github.com',
    '*.github.com',
    '*.githubusercontent.com',
  ],
  openrouter: [
    'openrouter.ai'
  ],
  'llama.cpp': [
    'localhost',
    '127.0.0.1',
  ],
}

/** A single host-to-local-port mapping for the `localServices` config option. */
interface LocalService {
  /**
   * Hostname the VM uses to reach this service (e.g. `"my-api.local"`).
   * Pi will be able to reach it at `http:
   * `https:
   */
  hostname: string

  /**
   * Host port the service is listening on (e.g. `8080`).
   * Traffic to `hostname` inside the VM is forwarded to `127.0.0.1:<port>`
   * on the host.
   */
  port: number
}

/** Network policy configuration for the sandbox VM. */
interface NetworkConfig {
  /**
   * Base network policy applied while pi is running.
   * - `"allow-all"` — unrestricted network access
   * - `"deny-all"` — no network access at all
   * - `"custom"` — allow only the domains resolved from `providers` and `allowedDomains`
   *
   * Defaults to `"custom"` when providers or allowedDomains are specified,
   * otherwise `"deny-all"`.
   */
  policy?: 'allow-all' | 'deny-all' | 'custom'

  /**
   * LLM provider names whose domains should be reachable from the VM.
   * Values must be keys of `PROVIDER_DOMAINS`.
   */
  providers?: string[]

  /**
   * Additional domains or patterns to allow (e.g. `["my-llm.example.com"]`).
   * Merged with any domains resolved from `providers`.
   */
  allowedDomains?: string[]

  /**
   * Host-side services to expose inside the VM.
   *
   * Each entry makes a local port on the host reachable from inside the
   * sandbox under a chosen hostname. Useful for local LLM servers, databases,
   * or any service running on localhost that pi needs to talk to.
   *
   * Example — expose Ollama at http:
   * ```json
   * { "hostname": "ollama.local", "port": 11434 }
   * ```
   *
   * Note: The VM is not a full Linux machine, so it cannot directly resolve
   * hostnames like `localhost`, `127.0.0.1`, or `host.docker.internal`.
   * Gondolin's TCP proxy allows you to map any hostname to a local port.
   */
  localServices?: LocalService[]

  /**
   * Secrets to inject into the VM. Each key is the guest environment variable
   * name, and the value specifies which hosts can receive the secret.
   * For example:
   * ```json
   * {
   *   "GITHUB_TOKEN": { "hosts": ["api.github.com", "github.com"] }
   * }
   * ```
   * The secret value is resolved from the host's environment (e.g. `GITHUB_TOKEN`).
   * This is a cross-platform feature that works on Linux, macOS, and Windows.
   */
  secrets?: Record<string, { hosts: string[]; env?: string }>
}

/** Configuration for vmpi. */
export interface VmpiConfig {
  /**
   * RAM in MiB to allocate to the VM.
   * Defaults to 512.
   */
  memory?: number

  /**
   * Number of vCPUs to allocate to the VM.
   * Defaults to 1.
   */
  cpus?: number

  /**
   * Path to the pi configuration directory on the host.
   * Defaults to `~/.pi`.
   */
  piConfigDir?: string

  /**
   * Path to vmpi's state directory on the host.
   * Defaults to `~/.vmpi`.
   */
  stateDir?: string

  /**
   * Extra MiB to add to the Gondolin rootfs image during `vmpi setup` when
   * free space is below this threshold. Increase this if setup fails with
   * a disk-full error. On macOS and Windows, this setting is ignored due to
   * lack of rootfs management tools.
   * Defaults to 128.
   */
  rootfsExtraMb?: number

  /**
   * Additional Alpine packages to install in the guest during `vmpi setup`,
   * in addition to the defaults: `git`, `fd`, `ripgrep`, `curl`, `jq`, `bash`,
   * `python3`, `py3-pip`, `nodejs`, `npm`, `make`, `patch`, `file`, `sqlite`.
   */
  guestPackages?: string[]

  /**
   * Shell commands to run inside the VM after packages are installed,
   * before the checkpoint is saved. Each command runs via `/bin/sh -c`.
   * A non-zero exit aborts setup. Use this to install tools not available
   * as Alpine packages, e.g. `npm install -g typescript` or `gem install rails`.
   */
  postSetupHooks?: string[]

  /**
   * Host directories to mount into the VM at runtime.
   * Each entry maps a host path to an absolute guest path.
   * The `host` path supports a leading `~`.
   * Example:
   * ```json
   * [{ "host": "~/.config/some-tool", "guest": "/root/.config/some-tool" }]
   * ```
   */
  mounts?: Array<{ host: string; guest: string }>

  /**
   * Network configuration for the sandbox VM.
   */
  network?: NetworkConfig
}

export interface ResolvedSecretEntry {
  value: string
  hosts: string[]
}

export interface ResolvedConfig extends VmpiConfig {
  /**
   * The resolved pi configuration directory on the host.
   */
  piConfigDir: string

  /**
   * The resolved vmpi state directory on the host.
   */
  stateDir: string

  /**
   * The resolved network policy.
   */
  network: {
    policy: 'allow-all' | 'deny-all' | 'custom'
    allowedDomains: string[]
    localServices: LocalService[]
    secrets: Record<string, ResolvedSecretEntry>
    missingSecrets: Array<{ name: string; envVarName: string }>
  }

  /**
   * The resolved guest packages to install.
   */
  guestPackages: string[]

  /**
   * The resolved post-setup hooks.
   */
  postSetupHooks: string[]

  /**
   * The resolved mounts to mount in the VM.
   */
  mounts: Array<{ host: string; guest: string }>

  /**
   * The extra MiB to add to the rootfs image (on Linux).
   * On macOS and Windows, this is ignored.
   */
  rootfsExtraMb: number
}

/**
 * Resolves the network policy based on the configuration.
 */
function resolvePolicy (network: VmpiConfig['network'], allowedDomains: string[]): 'allow-all' | 'deny-all' | 'custom' {
  if (network?.policy !== undefined) return network.policy
  if (allowedDomains.length > 0) return 'custom'
  return 'deny-all'
}

/**
 * Resolves allowed domains from the network configuration.
 */
function resolveAllowedDomains (network: VmpiConfig['network']): string[] {
  const domains = new Set<string>()
  
  if (network?.providers) {
    for (const provider of network.providers) {
      const providerDomains = PROVIDER_DOMAINS[provider]
      if (!providerDomains) {
        throw new Error(`Unknown LLM provider: ${provider}. Known providers: ${Object.keys(PROVIDER_DOMAINS).join(', ')}`)
      }
      for (const domain of providerDomains) {
        domains.add(domain)
      }
    }
  }
  
  if (network?.allowedDomains) {
    for (const domain of network.allowedDomains) {
      domains.add(domain)
    }
  }
  
  return [...domains]
}

/**
 * Resolves local services from the network configuration.
 */
function resolveLocalServices (network: VmpiConfig['network']): LocalService[] {
  return network?.localServices || []
}

/**
 * Resolves guest packages from the configuration.
 */
function resolveGuestPackages (guestPackages: VmpiConfig['guestPackages']): string[] {
  const DEFAULT_GUEST_PACKAGES = [
    'git',
    'fd',
    'ripgrep',
    'curl',
    'jq',
    'bash',
    'python3',
    'py3-pip',
    'nodejs',
    'npm',
    'make',
    'patch',
    'file',
    'sqlite',
  ]
  
  const result = new Set(DEFAULT_GUEST_PACKAGES)
  
  if (guestPackages) {
    for (const pkg of guestPackages) {
      result.add(pkg)
    }
  }
  
  return [...result]
}

/**
 * Resolves secrets from the configuration.
 */
function resolveSecrets (secrets: VmpiConfig['network']['secrets']): {
  resolved: Record<string, ResolvedSecretEntry>
  missing: Array<{ name: string; envVarName: string }>
} {
  const env = process.env
  const result: Record<string, ResolvedSecretEntry> = {}
  const missing: Array<{ name: string; envVarName: string }> = []
  
  if (!secrets) return { resolved: result, missing }
  
  for (const [name, cfg] of Object.entries(secrets)) {
    const envVarName = cfg.env ?? name
    const value = env[envVarName]
    
    if (!value) {
      missing.push({ name, envVarName })
      continue
    }
    
    result[name] = {
      value,
      hosts: cfg.hosts
    }
  }
  
  return { resolved: result, missing }
}

/**
 * Resolves mounts from the configuration.
 */
function resolveMounts (mounts: VmpiConfig['mounts']): Array<{ host: string; guest: string }> {
  const reservedGuestPaths = new Set(['/workspace', '/root/.pi'])
  const seenGuests = new Set<string>()
  
  if (!mounts) return []
  
  const resolvedMounts = []
  
  for (const m of mounts) {
    const hostInput = m.host.trim()
    const guest = m.guest.trim()
    
    if (reservedGuestPaths.has(guest)) {
      throw new Error(`Mount guest path '${guest}' is reserved and cannot be overridden`)
    }
    
    if (seenGuests.has(guest)) {
      throw new Error(`Mount guest path '${guest}' is specified multiple times`)
    }
    
    seenGuests.add(guest)
    
    let host = hostInput
    if (host.startsWith('~/')) {
      host = join(homedir(), host.slice(2))
    }
    
    resolvedMounts.push({ host, guest })
  }
  
  return resolvedMounts
}

/**
 * Loads the vmpi configuration from the current directory up to the root.
 */
export function loadConfig (): ResolvedConfig {
  const explorer = cosmiconfigSync('vmpi', {
    searchPlaces: [
      '.vmpirc.json',
      '.vmpirc.yaml',
      '.vmpirc.yml',
      'vmpirc.json',
      'vmpirc.yaml',
      'vmpirc.yml',
    ],
  })
  
  const result = explorer.search()
  const file: VmpiConfig = result?.config ?? {}
  
  const memory = num(process.env.VMPI_MEMORY) ?? file.memory ?? 512
  const cpus = num(process.env.VMPI_CPUS) ?? file.cpus ?? 1
  const piConfigDir = process.env.PI_CONFIG_DIR ?? file.piConfigDir ?? join(homedir(), '.pi')
  const stateDir = process.env.VMPI_STATE_DIR ?? file.stateDir ?? join(homedir(), '.vmpi')
  const rootfsExtraMb = num(process.env.VMPI_ROOTFS_EXTRA_MB) ?? file.rootfsExtraMb ?? 128
  
  const allowedDomains = resolveAllowedDomains(file.network)
  const policy = resolvePolicy(file.network, allowedDomains)
  const localServices = resolveLocalServices(file.network)
  const guestPackages = resolveGuestPackages(file.guestPackages)
  const postSetupHooks = file.postSetupHooks ?? []
  const { resolved: secrets, missing: missingSecrets } = resolveSecrets(file.network?.secrets)
  const mounts = resolveMounts(file.mounts)
  
  return {
    ...file,
    memory,
    cpus,
    piConfigDir,
    stateDir,
    rootfsExtraMb,
    network: {
      policy,
      allowedDomains,
      localServices,
      secrets,
      missingSecrets,
    },
    guestPackages,
    postSetupHooks,
    mounts,
  }
}

function num (value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (isNaN(n)) return undefined
  return n
}