import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'

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

/**
 * Maps provider names to the host environment variable that holds the API key.
 * Providers without a key-based credential (ollama, llama.cpp) are omitted.
 */
export const PROVIDER_API_KEY_ENV: Record<string, string> = {
  'github-copilot': 'GITHUB_TOKEN',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  github: 'GITHUB_TOKEN',
  openrouter: 'OPENROUTER_API_KEY',
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
  /** RAM in MiB (default: 1024). */
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

  /**
   * When `true`, mount the host directory read-only so guest code cannot
   * modify host files. Defaults to read-write when omitted.
   */
  readonly?: boolean
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

/**
 * Minimum safe guest RAM in MiB. Below this, the /tmp tmpfs cap (memory * 0.75)
 * falls below the ~250 MiB the pi bundle needs to extract, causing ENOSPC.
 */
export const MIN_MEMORY_MB = 512

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
 * Builds a `SecretsConfig` from the configured providers, auto-scoping each
 * provider's API-key env var to that provider's allowed domains. Providers
 * without a key-based credential (ollama, llama.cpp) are skipped.
 *
 * When multiple providers share an env var (e.g. github and github-copilot
 * both use GITHUB_TOKEN), their domain sets are unioned.
 */
export function buildProviderSecretsConfig (providers: string[] | undefined): SecretsConfig {
  const envVarDomains = new Map<string, Set<string>>()
  for (const provider of providers ?? []) {
    const envVar = PROVIDER_API_KEY_ENV[provider]
    if (envVar == null) continue
    const domains = PROVIDER_DOMAINS[provider]
    if (domains == null) continue
    if (!envVarDomains.has(envVar)) envVarDomains.set(envVar, new Set())
    for (const d of domains) envVarDomains.get(envVar)!.add(d)
  }
  const result: SecretsConfig = {}
  for (const [envVar, domains] of envVarDomains) {
    result[envVar] = { hosts: [...domains] }
  }
  return result
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
 * Home-relative paths that are blocked from host mounts by default.
 * Mounting these directories would expose credentials or secrets to any code
 * running inside the VM.
 */
export const SENSITIVE_HOST_PREFIXES: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.gnupg',
  '~/.kube',
  '~/.config/gcloud',
  '~/.netrc',
  '~/.git-credentials',
  '~/.password-store',
  '~/.local/share/keyrings',
  '~/.docker',
  '~/.config/gh',
  '~/.azure',
  '~/Library/Keychains',
]

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
    if (m.readonly != null && typeof m.readonly !== 'boolean') throw new Error(`mounts[${i}]: "readonly" must be a boolean`)

    const hostInput = m.host.trim()
    const guest = m.guest.trim()

    if (hostInput.length === 0) throw new Error(`mounts[${i}]: "host" must be a non-empty string`)
    if (guest.length === 0) throw new Error(`mounts[${i}]: "guest" must be a non-empty string`)
    if (!guest.startsWith('/')) throw new Error(`mounts[${i}]: "guest" must be an absolute path (got: "${guest}")`)
    if (reservedGuestPaths.has(guest)) throw new Error(`mounts[${i}]: "guest" path "${guest}" is reserved`)
    if (seenGuests.has(guest)) throw new Error(`mounts[${i}]: duplicate guest path "${guest}"`)

    seenGuests.add(guest)

    const home = homedir()
    const host = hostInput.startsWith('~/')
      ? join(home, hostInput.slice(2))
      : hostInput === '~' ? home : hostInput

    // Check for sensitive host paths after ~ expansion
    const sensitiveExpanded = SENSITIVE_HOST_PREFIXES.map(p =>
      p.startsWith('~/') ? join(home, p.slice(2)) : p
    )
    for (const sensitive of sensitiveExpanded) {
      if (host === sensitive || host.startsWith(sensitive + sep)) {
        throw new Error(`mounts[${i}]: sensitive host path "${host}" is not allowed`)
      }
    }

    return { host, guest, ...(m.readonly != null ? { readonly: m.readonly } : {}) }
  })
}

/**
 * Config keys that can expand the guest's host capabilities. These are trusted
 * inputs and are read only from the host-owned trusted config file. Any of
 * these declared in a project-local `.vmpirc.*` are dropped with a warning so
 * an untrusted repository cannot influence the sandbox protecting the host.
 */
export const SECURITY_FIELDS = ['network', 'mounts', 'secrets', 'piConfigDir', 'stateDir'] as const

/**
 * Returns the default trusted config directory (`$XDG_CONFIG_HOME/vmpi` or
 * `~/.config/vmpi`), where host-owned security-sensitive config lives.
 */
export function trustedConfigDir (): string {
  // XDG spec: $XDG_CONFIG_HOME is honored only when set to a non-empty absolute
  // path; otherwise it is ignored and ~/.config is used. Accepting an empty or
  // relative value would resolve the trusted dir against cwd, letting an
  // untrusted checkout supply a trusted config.
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg != null && xdg !== '' && isAbsolute(xdg) ? xdg : join(homedir(), '.config')
  return join(base, 'vmpi')
}

/**
 * Removes security-sensitive fields from a project-local config, warning for
 * each dropped field. Mutates and returns the same object.
 */
export function stripSecurityFields (project: VmpiConfig, source?: string): VmpiConfig {
  for (const field of SECURITY_FIELDS) {
    if (field in project) {
      const from = source != null ? ` (from ${source})` : ''
      console.warn(
        `[vmpi] warning: ignoring security-sensitive field "${field}" in project config${from}. ` +
        `Move it to the trusted config at ${join(trustedConfigDir(), 'config.json')}.`
      )
      delete project[field]
    }
  }
  return project
}

/**
 * Loads vmpi configuration and returns a fully resolved config with defaults
 * applied.
 *
 * Security-sensitive fields (`network`, `mounts`, `secrets`, `piConfigDir`,
 * `stateDir`) are read only from the trusted host config file
 * (`$XDG_CONFIG_HOME/vmpi/config.{json,yaml,yml}`). Non-security preferences
 * (`memory`, `cpus`, `rootfsExtraMb`, `guestPackages`, `postSetupHooks`) are
 * additionally read from a project-local `.vmpirc.*` searched from the current
 * working directory upward; any security fields it declares are dropped with a
 * warning. Environment variable overrides are host-controlled and always apply.
 *
 * The `configDir` option overrides the trusted config directory and exists only
 * to make this function unit-testable.
 */
export function loadConfig (opts: { configDir?: string } = {}): ResolvedConfig {
  const trustedExplorer = cosmiconfigSync('vmpi', {
    searchPlaces: ['config.json', 'config.yaml', 'config.yml'],
    searchStrategy: 'none',
  })
  const trusted: VmpiConfig = trustedExplorer.search(opts.configDir ?? trustedConfigDir())?.config ?? {}

  const project = mergeProjectConfigs(collectProjectConfigs())

  const memory = num(process.env.VMPI_MEMORY) ?? project.memory ?? trusted.memory ?? 1024
  if (memory < MIN_MEMORY_MB) {
    throw new Error(
      `VMPI_MEMORY must be at least ${MIN_MEMORY_MB} MiB (got ${memory}). ` +
      `The pi bundle needs ~250 MiB of /tmp space; at this memory size the cap would be ${Math.floor(memory * 0.75)} MiB.`
    )
  }
  const cpus = num(process.env.VMPI_CPUS) ?? project.cpus ?? trusted.cpus ?? 1
  const piConfigDir = process.env.PI_CONFIG_DIR ?? trusted.piConfigDir ?? join(homedir(), '.pi')
  const stateDir = process.env.VMPI_STATE_DIR ?? trusted.stateDir ?? join(homedir(), '.vmpi')
  const rootfsExtraMb = num(process.env.VMPI_ROOTFS_EXTRA_MB) ?? project.rootfsExtraMb ?? trusted.rootfsExtraMb ?? 128

  const allowedDomains = resolveAllowedDomains(trusted.network)
  const policy = resolvePolicy(trusted.network, allowedDomains)
  const localServices = resolveLocalServices(trusted.network)
  const guestPackages = resolveGuestPackages(project.guestPackages ?? trusted.guestPackages)
  const postSetupHooks = project.postSetupHooks ?? trusted.postSetupHooks ?? []
  const autoProviderSecrets = buildProviderSecretsConfig(trusted.network?.providers)
  // User-declared secrets win on key conflicts.
  const mergedSecrets = { ...autoProviderSecrets, ...(trusted.secrets ?? {}) }
  const { resolved: secrets, missing: missingSecrets } = resolveSecrets(mergedSecrets)
  const mounts = resolveMounts(trusted.mounts)

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

/**
 * Walks from the current working directory up to (but not including) the home
 * directory, collecting any `.vmpirc.*` config files found along the way.
 * Returns them ordered from most-general (furthest from cwd) to most-specific
 * (cwd itself), so later entries win when merged.
 */
function collectProjectConfigs (): Array<{ config: VmpiConfig; filepath: string }> {
  const home = homedir()
  const cwd = process.cwd()

  const dirs: string[] = []
  let dir = cwd
  while (dir !== home) {
    dirs.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break // filesystem root
    dir = parent
  }
  dirs.reverse() // most-general first so most-specific wins on merge

  const explorer = cosmiconfigSync('vmpi', {
    searchPlaces: ['.vmpirc.json', '.vmpirc.yaml', '.vmpirc.yml'],
    searchStrategy: 'none',
  })

  const results: Array<{ config: VmpiConfig; filepath: string }> = []
  for (const d of dirs) {
    const result = explorer.search(d)
    if (result != null) results.push({ config: result.config, filepath: result.filepath })
  }
  return results
}

/**
 * Merges an ordered list of project configs (most-general first, most-specific
 * last). Scalar fields use last-wins. `guestPackages` is unioned.
 * `postSetupHooks` is concatenated (parent hooks run before child hooks).
 * Security-sensitive fields are stripped from each config with a warning.
 */
function mergeProjectConfigs (configs: Array<{ config: VmpiConfig; filepath: string }>): VmpiConfig {
  const merged: VmpiConfig = {}
  for (const { config: cfg, filepath } of configs) {
    const safe = stripSecurityFields({ ...cfg }, filepath)
    if (safe.memory != null) merged.memory = safe.memory
    if (safe.cpus != null) merged.cpus = safe.cpus
    if (safe.rootfsExtraMb != null) merged.rootfsExtraMb = safe.rootfsExtraMb
    if (safe.guestPackages != null) {
      merged.guestPackages = [...new Set([...(merged.guestPackages ?? []), ...safe.guestPackages])]
    }
    if (safe.postSetupHooks != null) {
      merged.postSetupHooks = [...(merged.postSetupHooks ?? []), ...safe.postSetupHooks]
    }
  }
  return merged
}
