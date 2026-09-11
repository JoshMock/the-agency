import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Platform-specific directories to search for host tools in addition to PATH.
 * On macOS, Homebrew's e2fsprogs formula is keg-only (not linked into
 * <prefix>/bin), so its binaries live in the keg's sbin directory.
 */
export const EXTRA_TOOL_DIRS: Record<string, string[]> = {
  darwin: [
    '/opt/homebrew/opt/e2fsprogs/sbin',
    '/opt/homebrew/opt/e2fsprogs/bin',
    '/usr/local/opt/e2fsprogs/sbin',
    '/usr/local/opt/e2fsprogs/bin',
  ],
  linux: [],
}

/**
 * Resolves a host tool by name, searching PATH first, then platform-specific
 * extra directories. Returns the absolute path, or null when not found.
 * `platform` and `pathEnv` default to the current process but are injectable
 * for testing.
 */
export function findHostTool (
  tool: string,
  { platform = process.platform, pathEnv = process.env.PATH ?? '' }: { platform?: string, pathEnv?: string } = {}
): string | null {
  const pathDirs = pathEnv.split(delimiter).filter(d => d !== '')
  const extraDirs = EXTRA_TOOL_DIRS[platform] ?? []
  for (const dir of [...pathDirs, ...extraDirs]) {
    const candidate = join(dir, tool)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch { /* not here — keep searching */ }
  }
  return null
}

/**
 * npm `--cpu` value matching the guest VM architecture. Gondolin runs the
 * guest at the host's architecture, so map process.arch directly. `arch`
 * defaults to the current process but is injectable for testing.
 */
export function guestNpmCpu (arch: string = process.arch): string {
  switch (arch) {
    case 'arm64': return 'arm64'
    case 'x64': return 'x64'
    default: throw new Error(`unsupported host architecture for building the pi bundle: ${arch}`)
  }
}

/** Short platform tag used in the bundle cache filename. */
export function guestPlatformTag (arch: string = process.arch): string {
  return `linux-${guestNpmCpu(arch)}-musl`
}

/**
 * Returns true when an npm version string (e.g. `"10.2.4"`) supports the
 * `--libc` flag (npm >= 10.2). Pure parsing logic, split out for testing.
 */
export function npmVersionSupportsLibc (version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major > 10 || (major === 10 && minor >= 2)
}

let _npmSupportsLibc: boolean | undefined

/**
 * Returns true when the npm on PATH supports the `--libc` flag (npm >= 10.2).
 * Older npm versions silently ignore unknown platform flags in some cases and
 * fail hard in others, so the flag is only passed when supported. Cached.
 */
export function npmSupportsLibc (): boolean {
  if (_npmSupportsLibc == null) {
    const res = spawnSync('npm', ['--version'], { stdio: 'pipe' })
    _npmSupportsLibc = npmVersionSupportsLibc(res.stdout?.toString().trim() ?? '0.0')
  }
  return _npmSupportsLibc
}
