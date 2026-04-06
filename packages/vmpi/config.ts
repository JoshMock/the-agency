import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { cosmiconfigSync } = require('cosmiconfig') as typeof import('cosmiconfig')

/**
 * Known LLM provider names mapped to the domains they require.
 * Used to build network allowlists for the sandbox VM.
 */
export const PROVIDER_DOMAINS: Record<string, readonly string[]> = {
  'github-copilot': [
    // API calls: Copilot tokens embed a proxy-ep field that maps to
    // api.{sku}.githubcopilot.com. A wildcard covers all plan tiers
    // (individual, business, enterprise) without hard-coding each one.
    // Source: https://docs.github.com/en/copilot/reference/copilot-allowlist-reference
    '*.githubcopilot.com',
    // OAuth token refresh hits api.github.com/copilot_internal/v2/token
    'api.github.com',
    // Legacy/fallback API proxy
    'copilot-proxy.githubusercontent.com',
  ],
  gemini: [
    // Gemini API (generativelanguage) and Vertex AI (aiplatform)
    // Source: https://ai.google.dev/gemini-api/docs/quickstart
    'generativelanguage.googleapis.com',
    // OAuth token refresh hits oauth2.googleapis.com and www.googleapis.com
    'oauth2.googleapis.com',
    'www.googleapis.com',
  ],
  openai: [
    // Source: https://platform.openai.com/docs/api-reference/introduction
    'api.openai.com',
  ],
  anthropic: [
    // Source: https://docs.anthropic.com/en/api/getting-started
    'api.anthropic.com',
  ],
  ollama: [
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

/** Top-level vmpi configuration file schema. */
export interface VmpiConfig {
  /** RAM in MiB (default: 256). */
  memory?: number

  /** vCPU count (default: 1). */
  cpus?: number

  /** Path to the pi config directory on the host (default: `~/.pi`). */
  piConfigDir?: string

  /** Directory where vmpi stores state (default: `~/.vmpi`). */
  stateDir?: string

  /** Network policy settings for the sandbox VM. */
  network?: NetworkConfig
}

/** A resolved local service entry with the upstream address string. */
export interface ResolvedLocalService {
  /** Guest-visible hostname. */
  hostname: string
  /** Upstream address in `host:port` form for Gondolin's tcp.hosts map. */
  upstream: string
}

/** Fully resolved configuration with all defaults applied. */
export interface ResolvedConfig {
  memory: number
  cpus: number
  piConfigDir: string
  stateDir: string
  network: {
    policy: 'allow-all' | 'deny-all' | 'custom'
    allowedDomains: string[]
    localServices: ResolvedLocalService[]
  }
}

/**
 * Resolves the effective allowed-domain list from providers and explicit domains.
 */
export function resolveAllowedDomains(network: NetworkConfig | undefined): string[] {
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
export function resolvePolicy(
  network: NetworkConfig | undefined,
  allowedDomains: string[],
): 'allow-all' | 'deny-all' | 'custom' {
  if (network?.policy != null) return network.policy

  return allowedDomains.length > 0 ? 'custom' : 'deny-all'
}

/**
 * Resolves and validates the `localServices` config entries.
 * Throws if any entry has an invalid hostname or port.
 */
export function resolveLocalServices(network: NetworkConfig | undefined): ResolvedLocalService[] {
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
        `Use a name like "my-service.local" and set "port" to the host port (e.g. 8080).`,
      )
    }
    if (!Number.isInteger(svc.port) || svc.port < 1 || svc.port > 65535) {
      throw new Error(`network.localServices[${i}]: "port" must be an integer between 1 and 65535`)
    }
    return { hostname: svc.hostname, upstream: `127.0.0.1:${svc.port}` }
  })
}

/**
 * Loads vmpi configuration from cosmiconfig search paths and environment
 * variable overrides, returning a fully resolved config with defaults applied.
 *
 * Search locations (in priority order):
 * - `.vmpirc.json`, `.vmpirc.yaml`, `.vmpirc.yml`
 */
export function loadConfig(): ResolvedConfig {
  const explorer = cosmiconfigSync('vmpi', {
    searchPlaces: ['.vmpirc.json', '.vmpirc.yaml', '.vmpirc.yml'],
  })
  const result = explorer.search()
  const file: VmpiConfig = result?.config ?? {}

  const memory = num(process.env.VMPI_MEMORY) ?? file.memory ?? 256
  const cpus = num(process.env.VMPI_CPUS) ?? file.cpus ?? 1
  const piConfigDir = process.env.PI_CONFIG_DIR ?? file.piConfigDir ?? join(homedir(), '.pi')
  const stateDir = process.env.VMPI_STATE_DIR ?? file.stateDir ?? join(homedir(), '.vmpi')

  const allowedDomains = resolveAllowedDomains(file.network)
  const policy = resolvePolicy(file.network, allowedDomains)
  const localServices = resolveLocalServices(file.network)

  if (policy === 'deny-all' && allowedDomains.length > 0) {
    throw new Error(
      'Network policy is "deny-all" but providers or allowedDomains are configured. ' +
      'Use policy "custom" to allow specific domains, or remove the domain lists.',
    )
  }

  return { memory, cpus, piConfigDir, stateDir, network: { policy, allowedDomains, localServices } }
}

/** Parses a string as a number, returning undefined for missing/NaN values. */
function num(value: string | undefined): number | undefined {
  if (value == null) return undefined
  const n = Number(value)
  return Number.isNaN(n) ? undefined : n
}
