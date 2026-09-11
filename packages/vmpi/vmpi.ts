#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import {
  VM,
  VmCheckpoint,
  RealFSProvider,
  createHttpHooks,
  type VMOptions,
  type DebugComponent,
  type HttpIpAllowInfo,
} from '@earendil-works/gondolin'
import { loadConfig, type ResolvedConfig } from './config.js'
import { prepareSessionsForVm, collectSessionsFromVm } from './sessions.js'

let _config: ResolvedConfig | undefined
let debugMode = false

/**
 * Tracks hostnames the VM attempted to reach but were denied by the network
 * policy. Populated in --debug mode only. null when debug audit is inactive.
 */
let debugDeniedHosts: Set<string> | null = null

/**
 * Tracks executables the VM attempted to run but could not find.
 * Populated in --debug mode only. null when debug audit is inactive.
 */
let debugMissingExes: Set<string> | null = null

/** Lazily loads and caches the resolved configuration. */
function getConfig (): ResolvedConfig {
  if (_config == null) _config = loadConfig()
  return _config
}

/** Path to the qcow2 base checkpoint file. */
function checkpointFile (): string {
  return join(getConfig().stateDir, 'base-checkpoint.qcow2')
}

/** Prints a fatal error to stderr and exits with code 1. */
function die (message: string): never {
  console.error(`[vmpi] error: ${message}`)
  process.exit(1)
}

/** Prints an informational message to stderr. */
function info (message: string): void {
  console.error(`[vmpi] ${message}`)
}

/**
 * Platform-specific directories to search for host tools in addition to PATH.
 * On macOS, Homebrew's e2fsprogs formula is keg-only (not linked into
 * <prefix>/bin), so its binaries live in the keg's sbin directory.
 */
const EXTRA_TOOL_DIRS: Record<string, string[]> = {
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
 */
function findHostTool (tool: string): string | null {
  const pathDirs = (process.env.PATH ?? '').split(delimiter).filter(d => d !== '')
  const extraDirs = EXTRA_TOOL_DIRS[process.platform] ?? []
  for (const dir of [...pathDirs, ...extraDirs]) {
    const candidate = join(dir, tool)
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch { /* not here — keep searching */ }
  }
  return null
}

/** Platform-specific hint appended to messages when e2fsprogs is missing. */
function e2fsprogsHint (): string {
  return process.platform === 'darwin'
    ? ' (install it with: brew install e2fsprogs)'
    : ' (install e2fsprogs via your package manager)'
}

/**
 * Ensures Gondolin's rootfs.ext4 has enough free space to store the pi bundle.
 * If free space is below `rootfsExtraMb`, grows the image by `rootfsExtraMb` MiB
 * using `qemu-img resize` then repairs and expands the filesystem with
 * `e2fsck` and `resize2fs`.
 *
 * Skipped entirely if the rootfs already has sufficient headroom.
 * The `rootfsExtraMb` value comes from config (default: 128).
 *
 * Requires e2fsprogs on the host. On macOS these tools are not part of the
 * base system; `brew install e2fsprogs` provides them (keg-only, which is
 * why findHostTool also probes the Homebrew keg paths).
 */
async function ensureRootfsHeadroom (): Promise<void> {
  const { ensureGuestAssets } = await import('@earendil-works/gondolin')
  const assets = await ensureGuestAssets()
  const rootfsPath = assets.rootfsPath
  const extraMb = getConfig().rootfsExtraMb

  // Query current free blocks via `resize2fs -P` (prints minimum size, not free
  // space directly). Use `dumpe2fs` instead for accurate free block count.
  const dumpe2fs = findHostTool('dumpe2fs')
  if (dumpe2fs == null) {
    info(`Warning: dumpe2fs not found — skipping rootfs resize check${e2fsprogsHint()}`)
    return
  }
  const dump = spawnSync(dumpe2fs, ['-h', rootfsPath], { stdio: 'pipe' })
  if (dump.status !== 0) {
    info('Warning: could not inspect rootfs with dumpe2fs — skipping resize check')
    return
  }
  const dumpOut = dump.stdout.toString()
  const freeBlocksMatch = dumpOut.match(/Free blocks:\s+(\d+)/)
  const blockSizeMatch = dumpOut.match(/Block size:\s+(\d+)/)
  if (freeBlocksMatch == null || blockSizeMatch == null) {
    info('Warning: could not parse rootfs free space — skipping resize check')
    return
  }
  const freeMb = (parseInt(freeBlocksMatch[1]) * parseInt(blockSizeMatch[1])) / (1024 * 1024)
  info(`Rootfs free space: ${freeMb.toFixed(1)} MiB (threshold: ${extraMb} MiB)`)

  if (freeMb >= extraMb) {
    info('Rootfs has sufficient headroom — skipping resize')
    return
  }

  const e2fsck = findHostTool('e2fsck')
  const resize2fs = findHostTool('resize2fs')
  if (e2fsck == null || resize2fs == null) {
    die(`rootfs free space is low but e2fsck/resize2fs were not found — cannot grow the image${e2fsprogsHint()}`)
  }

  info(`Rootfs free space is low — growing image by ${extraMb} MiB...`)
  const resizeResult = spawnSync('qemu-img', ['resize', rootfsPath, `+${extraMb}M`], { stdio: 'inherit' })
  if (resizeResult.status !== 0) die('qemu-img resize failed')

  // e2fsck must run on an unmounted image before resize2fs
  const fsckResult = spawnSync(e2fsck, ['-f', '-y', rootfsPath], { stdio: 'inherit' })
  // e2fsck exits 1 for corrected errors, 2 for errors requiring reboot — both are fine here
  if (fsckResult.status != null && fsckResult.status > 2) die('e2fsck failed')

  const resizeFsResult = spawnSync(resize2fs, [rootfsPath], { stdio: 'inherit' })
  if (resizeFsResult.status !== 0) die('resize2fs failed')

  info(`Rootfs grown by ${extraMb} MiB`)
}

/**
/**
 * Returns `sandbox` options shared by all VM.create() calls:
 * - forces `q35` machine type on Linux x86_64 to fix Gondolin's broken
 *   `microvm` default (which has no PCI bus but generates PCI device args)
 * - enables network debug logging when `--debug` is passed
 * - sets `console: 'none'` so QEMU uses `-serial null` instead of `-serial stdio`,
 *   keeping the Node.js event loop free and the Pi TUI responsive
 */
function sandboxOptions (): VMOptions['sandbox'] {
  const opts: VMOptions['sandbox'] = {}
  if (process.platform === 'linux' && process.arch === 'x64') {
    opts.machineType = 'q35'
  }
  opts.console = 'none'
  return opts
}

/**
 * Returns the debug log callback when `--debug` is active, otherwise null
 * (suppresses all Gondolin debug output).
 */
function debugLog (): VMOptions['debugLog'] {
  if (!debugMode) return null
  return (component: DebugComponent, message: string) => {
    process.stderr.write(`[gondolin:${component}] ${message}\n`)
  }
}

/**
 * Runs a shell command inside a VM, streaming output to stderr.
 * In normal mode only guest stderr is shown (stdout is discarded).
 * In debug mode both streams are shown, prefixed with [stdout]/[stderr].
 * Throws if the command exits with a non-zero code.
 */
async function vmExec (vm: VM, cmd: string, { forwardStdout = true }: { forwardStdout?: boolean } = {}): Promise<void> {
  // Use array form (/bin/sh -c) rather than string form (/bin/sh -lc) because
  // the Alpine login shell doesn't populate PATH, so `npm`, `pi`, etc. are not
  // found when using the login-shell string shorthand.
  const proc = vm.exec(['/bin/sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' })
  for await (const { stream, text } of proc.output()) {
    if (debugMode) {
      process.stderr.write(`[${stream}] ${text}`)
    } else if (stream === 'stderr') {
      process.stderr.write(text)
    } else if (stream === 'stdout' && forwardStdout) {
      process.stdout.write(text)
    }
  }
  const result = await proc
  if (!result.ok) {
    throw new Error(`Command failed: ${cmd} (exit code ${result.exitCode})`)
  }
}

/**
 * npm `--cpu` value matching the guest VM architecture. Gondolin runs the
 * guest at the host's architecture, so map process.arch directly.
 */
function guestNpmCpu (): string {
  switch (process.arch) {
    case 'arm64': return 'arm64'
    case 'x64': return 'x64'
    default: throw new Error(`unsupported host architecture for building the pi bundle: ${process.arch}`)
  }
}

let _npmSupportsLibc: boolean | undefined

/**
 * Returns true when the npm on PATH supports the `--libc` flag (npm >= 10.2).
 * Older npm versions silently ignore unknown platform flags in some cases and
 * fail hard in others, so the flag is only passed when supported.
 */
function npmSupportsLibc (): boolean {
  if (_npmSupportsLibc == null) {
    const res = spawnSync('npm', ['--version'], { stdio: 'pipe' })
    const [major = 0, minor = 0] = (res.stdout?.toString().trim() ?? '0.0').split('.').map(Number)
    _npmSupportsLibc = major > 10 || (major === 10 && minor >= 2)
  }
  return _npmSupportsLibc
}

/**
 * npm install flags that target the guest platform (Alpine Linux on the
 * host's CPU architecture, musl libc) instead of the host platform. Without
 * these, npm resolves platform-specific optional dependencies (napi prebuilds
 * such as `@mariozechner/clipboard-*`) for the host OS/arch/libc, producing
 * binaries that cannot load inside the VM.
 */
function guestPlatformNpmArgs (): string[] {
  const args = ['--os=linux', `--cpu=${guestNpmCpu()}`]
  if (npmSupportsLibc()) args.push('--libc=musl')
  else info('Warning: npm < 10.2 does not support --libc — bundle may contain wrong-libc native modules')
  return args
}

/** Short platform tag used in the bundle cache filename. */
function guestPlatformTag (): string {
  return `linux-${guestNpmCpu()}-musl`
}

/**
 * Downloads the pi-coding-agent tarball from the npm registry, installs it
 * locally to get a full `node_modules` tree, and returns a compressed archive
 * of that tree. The archive is cached in `stateDir/cache/`, keyed by version,
 * guest platform, and the user's pi package list.
 *
 * This approach avoids running `npm install` inside the VM entirely:
 *   - The VM's rootfs has only ~90 MiB free; pi's node_modules needs ~250 MiB
 *     once extracted (many small files; tmpfs spends a 4 KiB page on each)
 *   - Instead, store the ~27 MB compressed archive on the rootfs (/opt/),
 *     and extract to /tmp (tmpfs) on each run. /tmp is remounted with an
 *     explicit size before extraction because the kernel default (50% of
 *     guest RAM) is too small for the bundle at lower memory settings.
 */
async function buildPiBundle (): Promise<Buffer> {
  const cacheDir = join(getConfig().stateDir, 'cache')
  const registryUrl = 'https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent'

  info('Fetching pi package metadata...')
  const meta = await fetch(registryUrl).then(r => r.json()) as Record<string, any>
  const version: string = meta['dist-tags']['latest']
  const tarballUrl: string = meta['versions'][version]['dist']['tarball']
  const integrity: string = meta['versions'][version]['dist']['integrity']

  // Include a hash of the user's pi package list in the cache key so the
  // bundle is rebuilt when packages are added or removed.
  let pkgHash = 'no-pkgs'
  const settingsPath = join(getConfig().piConfigDir, 'agent', 'settings.json')
  let piPackages: string[] = []
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages?: string[] }
      piPackages = settings.packages ?? []
      const pkgs = piPackages.sort().join(',')
      pkgHash = createHash('sha1').update(pkgs).digest('hex').slice(0, 8)
    } catch { /* use default */ }
  }

  const bundlePath = join(cacheDir, `pi-bundle-${version}-${guestPlatformTag()}-${pkgHash}.tgz`)
  if (existsSync(bundlePath)) {
    info(`Using cached pi bundle (${version})`)
    return readFileSync(bundlePath)
  }

  // Download the tarball
  info(`Downloading pi ${version}...`)
  const arrayBuf = await fetch(tarballUrl).then(r => r.arrayBuffer())
  const tarball = Buffer.from(arrayBuf as ArrayBuffer)

  // Verify integrity (sha512)
  if (integrity.startsWith('sha512-')) {
    const expected = integrity.slice('sha512-'.length)
    const actual = createHash('sha512').update(tarball).digest('base64')
    if (actual !== expected) {
      throw new Error(`Integrity check failed for pi tarball (${version})`)
    }
  }

  // Install locally to get a full node_modules tree, then archive it.
  // Using a temp dir so we don't pollute anything.
  info(`Installing pi ${version} locally to build bundle...`)
  const installDir = join(cacheDir, `pi-install-${version}`)
  mkdirSync(installDir, { recursive: true })
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'pi-bundle', version: '1.0.0', private: true }))

  const tarballPath = join(installDir, 'pi.tgz')
  writeFileSync(tarballPath, tarball)

  const platformArgs = guestPlatformNpmArgs()
  const npmResult = spawnSync(
    'npm', ['install', tarballPath, '--save', ...platformArgs],
    { cwd: installDir, stdio: 'inherit' }
  )
  if (npmResult.status !== 0) throw new Error('npm install failed while building pi bundle')

  // Also install the user's pi packages into the bundle so they're available
  // inside the VM without network access.
  const npmPackages = piPackages.filter(p => p.startsWith('npm:'))
  if (npmPackages.length > 0) {
    info(`Installing ${npmPackages.length} pi package(s) into bundle...`)
    const specs = npmPackages.map(p => p.slice('npm:'.length))
    const pkgResult = spawnSync(
      'npm', ['install', ...specs, '--save', '--legacy-peer-deps', ...platformArgs],
      { cwd: installDir, stdio: 'inherit' }
    )
    if (pkgResult.status !== 0) {
      info('Warning: some pi packages failed to install — they will be skipped in the VM')
    }
  }

  // Archive just the node_modules directory
  info('Compressing bundle...')
  mkdirSync(cacheDir, { recursive: true })
  const archiveResult = spawnSync(
    'tar', ['czf', bundlePath, 'node_modules'],
    { cwd: installDir, stdio: 'inherit' }
  )
  if (archiveResult.status !== 0) throw new Error('tar failed while archiving pi bundle')

  // Clean up the install dir (keep only the cached archive)
  spawnSync('rm', ['-rf', installDir], { stdio: 'inherit' })

  info(`Bundle ready: ${bundlePath} (${(readFileSync(bundlePath).length / 1e6).toFixed(1)} MB)`)
  return readFileSync(bundlePath)
}

/**
 * Builds the Gondolin HTTP hooks enforcing the configured network policy, and
 * returns the `env` map that Gondolin produces from the secrets block.
 *
 * Gondolin's `secrets` parameter scopes each secret to a set of allowed hosts:
 * the proxy injects the value only on requests to those hosts, and the returned
 * `env` object contains the env vars to set inside the VM guest.
 *
 * For `allow-all` policy no hooks are created (unrestricted egress). Secrets
 * are still resolved so their `env` values reach the guest.
 */
function buildHttpHooks (
  secrets: Record<string, import('./config.js').ResolvedSecretEntry>
): { httpHooks: ReturnType<typeof createHttpHooks>['httpHooks'] | undefined; guestEnv: Record<string, string> } {
  const { policy, allowedDomains, localServices } = getConfig().network
  const internalHostnames = localServices.map(s => s.hostname)
  // We cast to `any` because the Gondolin type for `secrets` is not re-exported.
  const gondolinSecrets: any = secrets
  const hasSecrets = Object.keys(gondolinSecrets).length > 0

  if (policy === 'allow-all') {
    info('Network policy: allow-all (unrestricted)')
    // No httpHooks, but still expose the env vars in the guest.
    const guestEnv = Object.fromEntries(Object.entries(secrets).map(([k, { value }]) => [k, value]))
    return { httpHooks: undefined, guestEnv }
  }

  const baseOpts: Record<string, unknown> = {
    allowedHosts: policy === 'deny-all' ? [] : allowedDomains,
  }
  if (internalHostnames.length > 0) baseOpts.allowedInternalHosts = internalHostnames
  if (hasSecrets) baseOpts.secrets = gondolinSecrets
  if (policy === 'deny-all') {
    info('Network policy: deny-all')
  } else {
    info(`Network policy: custom (${allowedDomains.length} allowed domain(s)${internalHostnames.length > 0 ? `, ${internalHostnames.length} local service(s)` : ''})`)
  }

  const { httpHooks, env } = createHttpHooks(baseOpts as any)

  if (debugDeniedHosts != null) {
    const inner = httpHooks.isIpAllowed
    httpHooks.isIpAllowed = async (info: HttpIpAllowInfo) => {
      const allowed = inner == null ? true : await inner(info)
      if (!allowed) debugDeniedHosts!.add(info.hostname)
      return allowed
    }
  }

  return { httpHooks, guestEnv: (env ?? {}) as Record<string, string> }
}

/**
 * Wraps a string in POSIX single-quotes, escaping any embedded single-quote
 * characters. Safe to use in `/bin/sh` scripts.
 */
function shellQuote (s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * Builds the base checkpoint. Installs pi on the host, archives the
 * `node_modules` tree, writes it to `/opt/pi-modules.tgz` on the VM's
 * rootfs, then saves a qcow2 disk checkpoint. Subsequent `vmpi` runs
 * resume from that checkpoint and extract the bundle to `/tmp` at startup.
 */
async function cmdSetup (): Promise<void> {
  await ensureRootfsHeadroom()
  info('Building base checkpoint (installing pi)...')
  mkdirSync(getConfig().stateDir, { recursive: true })

  const piBundle = await buildPiBundle()
  const { memory, cpus, guestPackages, postSetupHooks } = getConfig()

  // `cow` rootfs mode requires `qemu-img`; `memory` uses QEMU's built-in
  // snapshot mode and needs no extra tooling. We use `cow` here because we
  // are about to checkpoint the disk.
  // Allow-all HTTP hooks so post-setup hooks (e.g. `npm install -g …`) can
  // reach the internet. Setup runs under host control, not sandboxed pi, so
  // the user's runtime network policy does not apply here.
  const { httpHooks: setupHttpHooks } = createHttpHooks({ allowedHosts: undefined } as any)
  const vm = await VM.create({
    sandbox: sandboxOptions(),
    memory: `${memory}M`,
    cpus,
    httpHooks: setupHttpHooks,
    startTimeoutMs: 0,
    debugLog: debugLog(),
  })

  const cleanup = async () => {
    info('Cleaning up setup VM...')
    try { await vm.close() } catch { /* ignore */ }
  }
  process.on('SIGINT', () => { cleanup().then(() => process.exit()) })
  process.on('SIGTERM', () => { cleanup().then(() => process.exit()) })

  try {
    // Write the pre-built node_modules bundle to /opt/ on the rootfs.
    // /tmp is tmpfs and not captured by checkpoints; /opt/ is on the
    // disk and will be present in every VM resumed from this checkpoint.
    info('Uploading pi bundle to VM...')
    await vm.exec(['/bin/sh', '-c', 'mkdir -p /opt'])
    await vm.fs.writeFile('/opt/pi-modules.tgz', piBundle)
    const r = await vm.exec(['/bin/sh', '-c', 'df -h / && ls -lh /opt/pi-modules.tgz'])
    if (debugMode) process.stderr.write(r.stdout)

    info(`Installing guest packages: ${guestPackages.join(', ')}...`)
    await vm.exec(['/bin/sh', '-c', `apk add --no-cache ${guestPackages.join(' ')}`])

    if (postSetupHooks.length > 0) {
      info(`Running ${postSetupHooks.length} post-setup hook(s)...`)
      for (const cmd of postSetupHooks) {
        info(`  $ ${cmd}`)
        await vmExec(vm, cmd)
      }
    }

    info('Creating base checkpoint...')
    const checkpoint = await vm.checkpoint(checkpointFile())
    info(`Base checkpoint ready: ${checkpoint.path}`)

    writeFileSync(checkpointFile() + '.meta', JSON.stringify({
      createdAt: new Date().toISOString(),
    }))
  } finally {
    await cleanup()
  }
}

/** Shows checkpoint status. */
function cmdStatus (): void {
  const cpPath = checkpointFile()
  if (existsSync(cpPath)) {
    let extra = ''
    const metaPath = cpPath + '.meta'
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        if (meta.createdAt) extra = `  (created ${meta.createdAt})`
      } catch { /* ignore */ }
    }
    console.log(`Base checkpoint: ${cpPath}${extra}`)
  } else {
    console.log('Base checkpoint: not set up (run: vmpi setup)')
  }
}

/**
 * Prints the debug audit report to stdout after a pi session ends.
 * Lists any hostnames the VM was denied access to and any executables it
 * tried to invoke but could not find. Called only in --debug mode.
 */
function printDebugAudit (): void {
  const deniedList = debugDeniedHosts != null ? [...debugDeniedHosts].sort() : []
  const missingList = debugMissingExes != null ? [...debugMissingExes].sort() : []
  if (deniedList.length === 0 && missingList.length === 0) return
  console.log('')
  console.log('[vmpi debug audit]')
  if (missingList.length > 0) {
    console.log('  missing executables (attempted but not found):')
    for (const exe of missingList) console.log(`    ${exe}`)
  }
  if (deniedList.length > 0) {
    console.log('  blocked hostnames (attempted but denied by network policy):')
    for (const host of deniedList) console.log(`    ${host}`)
  }
}

/** Runs pi in a sandboxed VM resumed from the base checkpoint. */
async function cmdRun (args: string[]): Promise<void> {
  if (!existsSync(checkpointFile())) {
    info('No base checkpoint found — running setup first...')
    await cmdSetup()
  }

  const { memory, cpus, piConfigDir, network: { localServices }, secrets, missingSecrets, mounts } = getConfig()
  const { httpHooks, guestEnv } = buildHttpHooks(secrets)

  for (const { name, envVarName } of missingSecrets) {
    const hint = name === envVarName ? `$${envVarName}` : `$${envVarName} (for guest var ${name})`
    console.error(`[vmpi] warning: secret "${name}" is configured but ${hint} is not set on the host — it will not be injected into the VM`)
  }

  // Build tcp.hosts map and dns config for any local services.
  // Gondolin's tcp.hosts tunnels raw TCP from a synthetic guest hostname to a
  // host port. It requires per-host synthetic DNS so each hostname gets its own
  // unique IP that the NAT table can use to route back to the right upstream.
  const hasTcp = localServices.length > 0
  const tcpHosts = hasTcp
    ? Object.fromEntries(localServices.map(s => [s.hostname, s.upstream]))
    : undefined
  const dnsOptions = hasTcp
    ? { mode: 'synthetic' as const, syntheticHostMapping: 'per-host' as const }
    : undefined

  info('Preparing pi config snapshot...')
  // Copy piConfigDir into a temp dir so the VM gets a clean snapshot of the
  // host's ~/.pi without mounting the live directory. This avoids triggering
  // asdf reshims or other host-side side effects (e.g. pi-lsp reinstalls).
  const piConfigSnapshotDir = mkdtempSync(join(tmpdir(), 'vmpi-pi-config-'))
  const cleanupSnapshot = () => {
    try { rmSync(piConfigSnapshotDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  cpSync(piConfigDir, piConfigSnapshotDir, { recursive: true, preserveTimestamps: true })

  info('Resuming sandbox VM from checkpoint...')
  const checkpoint = VmCheckpoint.load(checkpointFile())
  const userMountProviders = Object.fromEntries(
    mounts.map(m => [m.guest, new RealFSProvider(m.host)])
  )
  const vm = await checkpoint.resume({
    sandbox: sandboxOptions(),
    memory: `${memory}M`,
    cpus,
    httpHooks,
    ...(dnsOptions ? { dns: dnsOptions } : {}),
    ...(tcpHosts ? { tcp: { hosts: tcpHosts } } : {}),
    startTimeoutMs: 0,
    debugLog: debugLog(),
    vfs: {
      mounts: {
        '/workspace': new RealFSProvider(process.cwd()),
        '/root/.pi': new RealFSProvider(piConfigSnapshotDir),
        ...userMountProviders,
      },
    },
  })

  const cleanup = async () => {
    info('Closing VM...')
    try { await vm.close() } catch { /* ignore */ }
    cleanupSnapshot()
  }
  process.on('SIGINT', () => { cleanup().then(() => process.exit()) })
  process.on('SIGTERM', () => { cleanup().then(() => process.exit()) })

  try {
    info('Preparing sessions for current directory...')
    prepareSessionsForVm(process.cwd(), piConfigSnapshotDir)

    info('Extracting pi bundle...')
    // /tmp is a tmpfs whose kernel-default size is 50% of guest RAM. That is
    // too small for the extracted bundle: at 512 MiB RAM the cap is ~233 MiB
    // (~466 MiB MemTotal on aarch64 after kernel reservations), while the
    // bundle needs ~250 MiB of tmpfs (its ~19k small files each spend a full
    // 4 KiB page). Remount /tmp with an explicit, larger cap before extracting.
    // The cap is only an upper bound — pages are allocated on demand — so
    // deriving it from the configured memory keeps every memory setting safe.
    const tmpfsMb = Math.floor(memory * 0.75)
    // Extract to /tmp/lib/ so node_modules lands at /tmp/lib/node_modules,
    // matching npm's global root when prefix=/tmp (prefix/lib/node_modules).
    await vmExec(vm, [
      `mount -o remount,size=${tmpfsMb}M /tmp`,
      'mkdir -p /tmp/lib',
      'tar xzf /opt/pi-modules.tgz -C /tmp/lib/',
      'npm config set prefix /tmp',
      'ln -sf /tmp/lib/node_modules/.bin/pi /usr/bin/pi',
    ].join(' && '), { forwardStdout: false })

    if (debugMode) {
      debugDeniedHosts = new Set()
      debugMissingExes = new Set()
      // Write a bash init script that records any command the shell cannot find.
      // BASH_ENV is sourced by bash for every non-interactive invocation, which
      // covers all `bash -c` calls that pi makes for its bash tool.
      const initScript = [
        'command_not_found_handle() {',
        '  printf "%s\\n" "$1" >> /tmp/vmpi-debug-missing-exes.log',
        '  return 127',
        '}',
      ].join('\n')
      await vm.fs.writeFile('/tmp/vmpi-init.sh', Buffer.from(initScript + '\n', 'utf8'))
    }

    info("Launching pi in sandbox (type 'exit' or Ctrl-D to quit)...")
    console.error('')

    const piArgs = args.map(a => JSON.stringify(a)).join(' ')

    // Inject secrets into the VM by writing a tmpfs env file and sourcing it.
    // `guestEnv` comes from Gondolin's `createHttpHooks`, which scopes each
    // secret to its declared host allowlist at the proxy layer. The file is
    // on /tmp (tmpfs) so values are never written to persistent storage.
    const guestEnvEntries = Object.entries(guestEnv)
    if (guestEnvEntries.length > 0) {
      const names = guestEnvEntries.map(([k]) => k).join(', ')
      info(`Injecting ${guestEnvEntries.length} secret(s) into VM: ${names}`)
      const lines = guestEnvEntries.map(([k, v]) => `export ${k}=${shellQuote(v)}`).join('\n')
      await vm.fs.writeFile('/tmp/.vmpi-secrets', Buffer.from(lines + '\n', 'utf8'))
    }

    const secretsPreamble = guestEnvEntries.length > 0 ? '. /tmp/.vmpi-secrets && ' : ''
    const proc = vm.shell({
      env: [
        'TERM=xterm-256color',
        ...(debugMode ? ['BASH_ENV=/tmp/vmpi-init.sh'] : []),
      ],
      command: ['/bin/sh', '-c', `${secretsPreamble}cd /workspace && pi ${piArgs}; exit $?`],
      attach: true,
    })
    const result = await proc

    if (debugMode) {
      try {
        const logBuf = await vm.fs.readFile('/tmp/vmpi-debug-missing-exes.log')
        const lines = logBuf.toString('utf8').split('\n').filter((l: string) => l.trim() !== '')
        for (const line of lines) debugMissingExes!.add(line.trim())
      } catch {
        // File absent when no missing-executable events occurred.
      }
      printDebugAudit()
    }

    info('Collecting sessions from VM...')
    collectSessionsFromVm(process.cwd(), piConfigSnapshotDir, piConfigDir)
    cleanupSnapshot()

    process.exit(result.exitCode)
  } catch (error) {
    await cleanup()
    if (error instanceof Error) {
      const cause = (error as any).cause
      const detail = cause instanceof Error ? `: ${cause.message}` : ''
      die(`${error.message}${detail}`)
    } else die('An unknown error occurred')
  }
}

const CONFIG_HELP = `
Configuration (.vmpirc.json, .vmpirc.yaml, .vmpirc.yml):

  memory          RAM in MiB                  (env: VMPI_MEMORY,    default: 1024)
  cpus            vCPU count                  (env: VMPI_CPUS,      default: 1)
  piConfigDir     pi config dir on host       (env: PI_CONFIG_DIR,  default: ~/.pi)
  stateDir        vmpi state dir on host      (env: VMPI_STATE_DIR, default: ~/.vmpi)
  network.policy                allow-all | deny-all | custom (inferred when providers/domains set)
  network.providers             Built-in presets: github-copilot, gemini, openai, anthropic, ollama, github
  network.allowedDomains        Additional domain patterns to allow
  network.localServices         Host services to expose inside the VM:
                                  [{ "hostname": "my-api.local", "port": 8080 }]
  secrets                       Secrets to forward into the VM, scoped to specific hosts.
                                Each key is the guest env var name:
                                  { "GITHUB_TOKEN": { "hosts": ["api.github.com"] } }
                                Override the host-side var name with "env":
                                  { "GITHUB_TOKEN": { "hosts": ["api.github.com"], "env": "MY_PAT" } }
  mounts                        Host directories to mount into the VM at runtime.
                                Each entry maps a host path to an absolute guest path.
                                  [{ "host": "~/.config/some-tool", "guest": "/root/.config/some-tool" }]

Example .vmpirc.json (using the gh CLI with a GitHub token):
  {
    "network": {
      "providers": ["anthropic", "github"]
    },
    "guestPackages": ["github-cli"],
    "secrets": {
      "GITHUB_TOKEN": { "hosts": ["api.github.com", "github.com"] }
    }
  }
`

const program = new Command()
  .name('vmpi')
  .description('Run pi sandboxed in a QEMU microVM via Gondolin')
  .addHelpText('after', `\n${CONFIG_HELP}`)

program
  .argument('[piArgs...]', 'arguments forwarded to pi inside the VM')
  .passThroughOptions()
  .allowUnknownOption()
  .option('--debug', 'enable Gondolin debug logging')
  .action(async (piArgs: string[], opts: { debug?: boolean }) => {
    if (opts.debug) debugMode = true
    await cmdRun(piArgs)
  })

program
  .command('setup')
  .description('(Re)build the base VM checkpoint')
  .option('--debug', 'enable Gondolin debug logging')
  .action(async (opts: { debug?: boolean }) => {
    if (opts.debug) debugMode = true
    await cmdSetup()
  })

program
  .command('status')
  .description('Show base checkpoint status')
  .action(() => {
    cmdStatus()
  })

program.parseAsync(process.argv).catch(error => {
  if (error instanceof Error) die(error.message)
  else die('An unknown error occurred')
})
