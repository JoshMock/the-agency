// vmpi configuration — loaded via cosmiconfig from .vmpirc, vmpi.config.js, etc.

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const { cosmiconfigSync } = require('cosmiconfig') as typeof import('cosmiconfig')

// ── Provider domain allowlists ────────────────────────────────────────────────

/**
 * Known LLM provider names mapped to the domains they require.
 * Used to build network allowlists for the sandbox VM.
 */
export const PROVIDER_DOMAINS: Record<string, readonly string[]> = {
  'github-copilot': [
    'api.githubcopilot.com',
    '*.github.com',
    'api.github.com',
    'copilot-proxy.githubusercontent.com',
  ],
  gemini: [
    'generativelanguage.googleapis.com',
    '*.googleapis.com',
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
}

// ── Config types ──────────────────────────────────────────────────────────────

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

/** Fully resolved configuration with all defaults applied. */
export interface ResolvedConfig {
  memory: number
  cpus: number
  piConfigDir: string
  stateDir: string
  network: {
    policy: 'allow-all' | 'deny-all' | 'custom'
    allowedDomains: string[]
  }
}

// ── Loading ───────────────────────────────────────────────────────────────────

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
 * Loads vmpi configuration from cosmiconfig search paths and environment
 * variable overrides, returning a fully resolved config with defaults applied.
 *
 * Search locations (in priority order):
 * - `vmpi` key in `package.json`
 * - `.vmpirc`, `.vmpirc.json`, `.vmpirc.yaml`, `.vmpirc.yml`
 * - `vmpi.config.js`, `vmpi.config.cjs`
 */
export function loadConfig(): ResolvedConfig {
  const explorer = cosmiconfigSync('vmpi')
  const result = explorer.search()
  const file: VmpiConfig = result?.config ?? {}

  // env vars override file config
  const memory = num(process.env.VMPI_MEMORY) ?? file.memory ?? 256
  const cpus = num(process.env.VMPI_CPUS) ?? file.cpus ?? 1
  const piConfigDir = process.env.PI_CONFIG_DIR ?? file.piConfigDir ?? join(homedir(), '.pi')
  const stateDir = process.env.VMPI_STATE_DIR ?? file.stateDir ?? join(homedir(), '.vmpi')

  const allowedDomains = resolveAllowedDomains(file.network)
  const policy = resolvePolicy(file.network, allowedDomains)

  if (policy === 'deny-all' && allowedDomains.length > 0) {
    throw new Error(
      'Network policy is "deny-all" but providers or allowedDomains are configured. ' +
      'Use policy "custom" to allow specific domains, or remove the domain lists.',
    )
  }

  return { memory, cpus, piConfigDir, stateDir, network: { policy, allowedDomains } }
}

/** Parses a string as a number, returning undefined for missing/NaN values. */
function num(value: string | undefined): number | undefined {
  if (value == null) return undefined
  const n = Number(value)
  return Number.isNaN(n) ? undefined : n
}
