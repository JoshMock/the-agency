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
    'api.openrouter.ai'
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
   * Pi will be able to reach it at `http://my-api.local` or
   * `https://my-api.local` from inside the sandbox.
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
   * Example — expose Ollama at http://ollama.local:11434 inside the VM:
   * ```json
   * { "hostname": "ollama.local", "port": 11434 }
   * ```
   *
   * Under the hood this uses Gondolin's `tcp.hosts` mapping (raw TCP tunnel,
   * bypasses the HTTP MITM proxy) combined with `allowedInternalHosts` so the
   * HTTP hooks permit connections to the resolved internal IP.
   */
  localServices?: LocalService[]
}

/**
 * Per-secret configuration entry. Each key in `VmpiConfig.secrets` names the
 * env var that will be set inside the VM. The `hosts` array constrains which
 * hostnames Gondolin's HTTP proxy is allowed to forward the secret to, and
 * `env` lets you read the value from a differently-named host env var.
 */
export interface SecretEntryConfig {
  /**
   * Hostnames the HTTP proxy may forward this secret to.
   * Requests to any other host will not carry this secret.
   * Example: `["api.github.com"]`.
   */
  hosts: string[]

  /**
   * Name of the host environment variable that holds the secret value.
   * Defaults to the key name (the name used inside the VM) when omitted.
   * Use this when the host var is named differently from the guest var.
   */
  env?: string
}

/**
 * Secrets configuration block in `.vmpirc.json`.
 * Each key is the env var name that will be set inside the VM.
 *
 * Example — forward a GitHub token scoped to api.github.com:
 * ```json
 * { "GITHUB_TOKEN": { "hosts": ["api.github.com"] } }
 * ```
 */
export type SecretsConfig = Record<string, SecretEntryConfig>
/** Top-level vmpi configuration file schema. */
export interface VmpiConfig {
  /** RAM in MiB (default: 512). */
  memory?: number

  /** vCPU count (default: 1). */
  cpus?: number

  /** Path to the pi config directory on the host (default: `~/.pi`). */
  piConfigDir?: string

  /** Directory where vmpi stores state (default: `~/.vmpi`). */
  stateDir?: string

  /** Network policy settings for the sandbox VM. */
  network?: NetworkConfig

  /**
   * Extra MiB to add to Gondolin's rootfs image during setup if free space is
   * insufficient to store the pi bundle. Resizing is skipped when the rootfs
   * already has enough headroom. (default: 128)
   */
  rootfsExtraMb?: number

  /**
   * Additional Alpine packages to install in the guest during `vmpi setup`.
   * The packages in `DEFAULT_GUEST_PACKAGES` are always installed regardless
   * of this field.
   */
  guestPackages?: string[]

  /**
   * Shell commands to run inside the VM after packages are installed, before
   * the base checkpoint is saved. Each command is executed via `/bin/sh -c`.
   * A non-zero exit code aborts setup. Useful for installing language-specific
   * tools that are not available as Alpine packages, e.g.:
   * `["npm install -g typescript", "gem install rails"]`.
   */
  postSetupHooks?: string[]

  /**
   * Secrets to inject into the VM at runtime.
   * Each key is the env var name set inside the VM; the value object specifies
   * the allowed hosts and the host-side env var to read from.
   */
  secrets?: SecretsConfig

  /**
   * Arbitrary host directories to mount into the VM at runtime.
   * Each entry maps a host path to an absolute guest path.
   * `~` at the start of `host` is expanded to the current user's home directory.
   *
   * Example — expose a tool's config directory inside the VM:
   * ```json
   * [{ "host": "~/.config/some-tool", "guest": "/root/.config/some-tool" }]
   * ```
   */
  mounts?: DirectoryMount[]
}

/** A single host-to-guest directory mount mapping. */
export interface DirectoryMount {
  /**
   * Absolute path (or `~`-prefixed path) on the host to mount into the VM.
   * Example: `"~/.config/some-tool"` or `"/home/user/data"`.
   */
  host: string

  /**
   * Absolute path inside the VM guest where the directory will be mounted.
   * Example: `"/root/.config/some-tool"`.
   */
  guest: string
}

/** A resolved local service entry with the upstream address string. */
export interface ResolvedLocalService {
  /** Guest-visible hostname. */
  hostname: string
  /** Upstream address in `host:port` form for Gondolin's tcp.hosts map. */
  upstream: string
}

/** Resolved network policy settings. */
export interface ResolvedNetwork {
  policy: 'allow-all' | 'deny-all' | 'custom'
  allowedDomains: string[]
  localServices: ResolvedLocalService[]
}

/** Fully resolved configuration with all defaults applied. */
export interface ResolvedConfig {
  memory: number
  cpus: number
  piConfigDir: string
  stateDir: string
  rootfsExtraMb: number
  /** Alpine packages to install in the guest (defaults + user extras). */
  guestPackages: string[]
  /** Shell commands to run after package installation, before checkpointing. */
  postSetupHooks: string[]
  network: ResolvedNetwork
  /**
   * Resolved secrets ready to pass to Gondolin's `createHttpHooks`.
   * Only entries whose host env var was present are included.
   */
  secrets: Record<string, ResolvedSecretEntry>
  /**
   * Secrets that were declared in config but whose host env var was absent.
   * Each entry carries the guest-side name and the host env var that was expected.
   */
  missingSecrets: Array<{ name: string; envVarName: string }>
  /** Resolved directory mounts to pass to the VM's virtual filesystem. */
  mounts: DirectoryMount[]
}

/** Alpine packages always installed in the guest, regardless of user config. */
export const DEFAULT_GUEST_PACKAGES: readonly string[] = [
  // version control
  'git',
  // file/text search (used by pi's find and grep tools)
  'fd',
  'ripgrep',
  // HTTP and data tools
  'curl',
  'jq',
  // scripting runtimes
  'bash',
  'python3',
  'py3-pip',
  'nodejs',
  'npm',
  // build and file utilities
  'make',
  'patch',
  'file',
  'sqlite',
]

/**
 * Returns the full list of Alpine packages to install in the guest.
 * Always includes `DEFAULT_GUEST_PACKAGES`; appends any extra packages from
 * the config without duplicates.
 */
export function resolveGuestPackages (extra: string[] | undefined): string[] {
  const result = new Set(DEFAULT_GUEST_PACKAGES)
  for (const pkg of extra ?? []) result.add(pkg)
  return [...result]
}

/** A single resolved secret with its host allowlist and value. */
export interface ResolvedSecretEntry {
  /**
   * Hostnames the HTTP proxy may forward this secret to.
   * Mirrors `SecretEntryConfig.hosts` after validation.
   */
  hosts: string[]

  /** Resolved secret value read from the host environment. */
  value: string
}

/** Return value of `resolveSecrets`. */
export interface ResolvedSecretsResult {
  resolved: Record<string, ResolvedSecretEntry>
  missing: Array<{ name: string; envVarName: string }>
}

/**
 * Resolves the configured secrets by reading values from the host environment.
 * Returns both the resolved entries and a list of secrets whose host env var
 * was absent, so callers can warn the user about misconfiguration.
 *
 * The optional `env` parameter defaults to `process.env` and exists only to
 * make this function unit-testable without polluting the real environment.
 */
export function resolveSecrets (
  secrets: SecretsConfig | undefined,
  env: NodeJS.ProcessEnv = process.env
): ResolvedSecretsResult {
  const resolved: Record<string, ResolvedSecretEntry> = {}
  const missing: Array<{ name: string; envVarName: string }> = []
  for (const [name, cfg] of Object.entries(secrets ?? {})) {
    const envVarName = cfg.env ?? name
    const value = env[envVarName]
    if (value != null) {
      resolved[name] = { hosts: cfg.hosts, value }
    } else {
      missing.push({ name, envVarName })
    }
  }
  return { resolved, missing }
}

/**
 * Resolves the effective allowed-domain list from providers and explicit domains.
 */
export function resolveAllowedDomains (network: NetworkConfig | undefined): string[] {
  const domains = new Set<string>()

  for (const provider of network?.providers ?? []) {
    const providerDomains = PROVIDER_DOMAINS[provider]
    if (providerDomains == null) {
      const known = Object.keys(PROVIDER_DOMAINS).join(', ')
      throw new Error(`Unknown provider "${provider}". Known providers: ${known}`)
    }
    for (const d of providerDomains) domains.add(d)
  }

  for (const d of network?.allowedDomains ?? []) {
    domains.add(d)
  }

  return [...domains]
}

/**
 * Determines the effective network policy based on config values.
 * If an explicit policy is set, it is used directly. Otherwise, the policy is
 * inferred: `"custom"` when any domains are configured, `"deny-all"` otherwise.
 */
export function resolvePolicy (
  network: NetworkConfig | undefined,
  allowedDomains: string[]
): 'allow-all' | 'deny-all' | 'custom' {
  if (network?.policy != null) return network.policy

  return allowedDomains.length > 0 ? 'custom' : 'deny-all'
}

/**
 * Resolves and validates the `localServices` config entries.
 * Throws if any entry has an invalid hostname or port.
 */
export function resolveLocalServices (network: NetworkConfig | undefined): ResolvedLocalService[] {
  return (network?.localServices ?? []).map((svc, i) => {
    if (!svc.hostname || typeof svc.hostname !== 'string') {
      throw new Error(`network.localServices[${i}]: "hostname" must be a non-empty string`)
    }
    // Reject raw IP addresses — the TCP tunnel requires a DNS name so Gondolin's
    // synthetic DNS can assign the hostname a unique guest IP for routing.
    // Use a hostname like "my-api.local" and let vmpi map it to 127.0.0.1:<port>.
    if (/^\d+\.\d+\.\d+\.\d+$/.test(svc.hostname) || svc.hostname.includes(':')) {
      throw new Error(
        `network.localServices[${i}]: "hostname" must be a DNS name, not an IP address. ` +
        'Use a name like "my-service.local" and set "port" to the host port (e.g. 8080).'
      )
    }
    if (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535) {
      throw new Error(`network.localServices[${i}]: "port" must be an integer between 1 and 65535`)
    }
    return { hostname: svc.hostname, upstream: `127.0.0.1:${svc.port}` }
  })
}

/**
 * Resolves and validates the `mounts` config entries.
 * Expands a leading `~` in `host` to the current user's home directory.
 * Throws if any entry has an empty `host` or non-absolute `guest` path.
 */
export function resolveMounts (mounts: DirectoryMount[] | undefined): DirectoryMount[] {
  const reservedGuestPaths = new Set(['/workspace', '/root/.pi'])
  const seenGuests = new Set<string>()

  return (mounts ?? []).map((m, i) => {
    if (typeof m.host !== 'string') throw new Error(`mounts[${i}]: "host" must be a non-empty string`)
    if (typeof m.guest !== 'string') throw new Error(`mounts[${i}]: "guest" must be a non-empty string`)

    const hostInput = m.host.trim()
    const guest = m.guest.trim()

    if (hostInput.length === 0) throw new Error(`mounts[${i}]: "host" must be a non-empty string`)
    if (guest.length === 0) throw new Error(`mounts[${i}]: "guest" must be a non-empty string`)
    if (!guest.startsWith('/')) throw new Error(`mounts[${i}]: "guest" must be an absolute path (got: "${guest}")`)
    if (reservedGuestPaths.has(guest)) throw new Error(`mounts[${i}]: "guest" path "${guest}" is reserved`)
    if (seenGuests.has(guest)) throw new Error(`mounts[${i}]: duplicate guest path "${guest}"`)

    seenGuests.add(guest)

    const host = hostInput.startsWith('~/')
      ? join(homedir(), hostInput.slice(2))
      : hostInput === '~' ? homedir() : hostInput
    return { host, guest }
  })
}

/**
 * Loads vmpi configuration from cosmiconfig search paths and environment
 * variable overrides, returning a fully resolved config with defaults applied.
 *
 * Searches for `.vmpirc.json`, `.vmpirc.yaml`, or `.vmpirc.yml` starting from
 * the current working directory and walking up the file tree to the home
 * directory.
 */
export function loadConfig (): ResolvedConfig {
  const explorer = cosmiconfigSync('vmpi', {
    searchPlaces: ['.vmpirc.json', '.vmpirc.yaml', '.vmpirc.yml'],
    searchStrategy: 'global',
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
  const { resolved: secrets, missing: missingSecrets } = resolveSecrets(file.secrets)
  const mounts = resolveMounts(file.mounts)

  if (policy === 'deny-all' && allowedDomains.length > 0) {
    throw new Error(
      'Network policy is "deny-all" but providers or allowedDomains are configured. ' +
      'Use policy "custom" to allow specific domains, or remove the domain lists.'
    )
  }

  return { memory, cpus, piConfigDir, stateDir, rootfsExtraMb, guestPackages, postSetupHooks, secrets, missingSecrets, mounts, network: { policy, allowedDomains, localServices } }
}

/** Parses a string as a number, returning undefined for missing/NaN values. */
function num (value: string | undefined): number | undefined {
  if (value == null) return undefined
  const n = Number(value)
  return Number.isNaN(n) ? undefined : n
}
