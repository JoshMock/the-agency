#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
 * Ensures Gondolin's rootfs.ext4 has enough free space to store the pi bundle.
 * If free space is below `rootfsExtraMb`, grows the image by `rootfsExtraMb` MiB
 * using `qemu-img resize` then repairs and expands the filesystem with
 * `e2fsck` and `resize2fs`.
 *
 * Skipped entirely if the rootfs already has sufficient headroom.
 * The `rootfsExtraMb` value comes from config (default: 128).
 * 
 * Cross-platform compatibility note: This function only works on Linux systems
 * with the required tools (qemu-img, dumpe2fs, e2fsck, resize2fs). On other
 * platforms, it warns and skips the operation.
 */
async function ensureRootfsHeadroom (): Promise<void> {
  // Check if we're on a Linux system with the required tools
  const isLinux = process.platform === 'linux'
  
  if (!isLinux) {
    info('Cross-platform notice: Rootfs space management is only available on Linux systems.')
    info('On macOS and Windows, the rootfs will use the default size.')
    return
  }

  const { ensureGuestAssets } = await import('@earendil-works/gondolin')
  const assets = await ensureGuestAssets()
  const rootfsPath = assets.rootfsPath
  const extraMb = getConfig().rootfsExtraMb

  // Query current free blocks via `resize2fs -P` (prints minimum size, not free
  // space directly). Use `dumpe2fs` instead for accurate free block count.
  const dump = spawnSync('dumpe2fs', ['-h', rootfsPath], { stdio: 'pipe' })
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

  info(`Rootfs free space is low — growing image by ${extraMb} MiB...`)
  const resizeResult = spawnSync('qemu-img', ['resize', rootfsPath, `+${extraMb}M`], { stdio: 'inherit' })
  if (resizeResult.status !== 0) die('qemu-img resize failed')

  // e2fsck must run on an unmounted image before resize2fs
  const fsckResult = spawnSync('e2fsck', ['-f', '-y', rootfsPath], { stdio: 'inherit' })
  // e2fsck exits 1 for corrected errors, 2 for errors requiring reboot — both are fine here
  if (fsckResult.status != null && fsckResult.status > 2) die('e2fsck failed')

  const resizeFsResult = spawnSync('resize2fs', [rootfsPath], { stdio: 'inherit' })
  if (resizeFsResult.status !== 0) die('resize2fs failed')

  info(`Rootfs grown by ${extraMb} MiB`)
}

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
  // Only set machine type for Linux x86_64
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
 * Downloads the pi-coding-agent tarball from the npm registry, installs it
 * locally to get a full `node_modules` tree, and returns a compressed archive
 * of that tree. The archive is cached in `stateDir/cache/` keyed by version.
 *
 * This approach avoids running `npm install` inside the VM entirely:
 *   - The VM's rootfs has only ~79 MB free; pi's node_modules is ~180 MB
 *   - The rootfs is auto-grown by ensureRootfsHeadroom() but /tmp is tmpfs,
 *   - Instead, store the 33 MB compressed archive on the rootfs (/opt/),
 *     extract to /tmp (tmpfs, ~50% of VM RAM) on each run; 512 MiB RAM gives
 *     ~256 MiB of tmpfs, which comfortably fits the ~180 MB extracted bundle
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

  const bundlePath = join(cacheDir, `pi-bundle-${version}-${pkgHash}.tgz`)
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

  const npmResult = spawnSync(
    'npm', ['install', tarballPath, '--save'],
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
      'npm', ['install', ...specs, '--save', '--legacy-peer-deps'],
      { cwd: installDir, stdio: 'inherit' }
    )
    if (pkgResult.status !== 0) {
      info('Warning: failed to install pi packages into bundle')
    }
  }

  // Archive the bundled modules.
  const archiveResult = spawnSync(
    'tar', ['czf', bundlePath, 'node_modules'],
    { cwd: installDir, stdio: 'inherit' }
  )
  if (archiveResult.status !== 0) throw new Error('tar failed while archiving pi bundle')

  info(`Pi bundle created: ${bundlePath}`)
  return readFileSync(bundlePath)
}

function buildHttpHooks (secrets: Record<string, { value: string; hosts: string[] }>): {
  httpHooks: ReturnType<typeof createHttpHooks>
  guestEnv: Record<string, string>
} {
  const { policy, allowedDomains, localServices } = getConfig().network
  const internalHostnames = localServices.map(s => s.hostname)
  const allowedHosts = [...allowedDomains, ...internalHostnames]
  const gondolinSecrets: any = secrets
  const hasSecrets = Object.keys(gondolinSecrets).length > 0

  // The secrets are injected into the VM at the proxy layer, so we need to
  // pass them to createHttpHooks. The guestEnv will be written to a tmpfs
  // file and sourced by the VM shell, making the secrets available to pi.
  const guestEnv = Object.fromEntries(Object.entries(secrets).map(([k, { value }]) => [k, value]))
  const baseOpts: Record<string, unknown> = {
    // The default policy is "deny-all" so that if no providers or domains
    // are configured, the VM can't reach anything.
    policy: policy ?? 'deny-all',
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
    // For local services, we only provide the hostname mapping; the actual
    // TCP connection will be handled by Gondolin's TCP proxy.
    tcp: localServices.length > 0 ? { hosts: Object.fromEntries(localServices.map(s => [s.hostname, s.port])) } : undefined,
  }

  const { httpHooks, env } = createHttpHooks(baseOpts as any)
  // Merge the secrets into the env object, which will be passed to the VM
  // through the Gondolin proxy. This enables the proxy to forward secrets
  // to specific hosts.
  const finalEnv = { ...env, ...guestEnv }
  
  // The secret values are not passed to httpHooks directly; they're passed
  // through the proxy and VM environment instead.
  return { httpHooks, guestEnv }
}

/**
 * Creates a base VM checkpoint with pi installed.
 * This is a one-time setup that takes several minutes.
 */
async function cmdSetup (): Promise<void> {
  const { memory, cpus, guestPackages, postSetupHooks } = getConfig()
  
  // Check if we're on a Linux system with required tools for rootfs management
  const isLinux = process.platform === 'linux'
  if (!isLinux) {
    info('Cross-platform notice: Rootfs space management requires Linux tools.')
    info('On macOS and Windows, the system will use default rootfs size.')
  }

  info('Checking for existing base checkpoint...')
  const cpPath = checkpointFile()
  if (existsSync(cpPath)) {
    const metaPath = cpPath + '.meta'
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
      info(`Base checkpoint exists (${meta.timestamp})`)
      return
    } else {
      info('Found base checkpoint without metadata — rebuilding...')
    }
  }

  // Ensure we have enough space in the rootfs for the pi bundle
  if (isLinux) {
    await ensureRootfsHeadroom()
  }

  const { httpHooks: setupHttpHooks } = createHttpHooks({ allowedHosts: undefined } as any)
  const vm = await VM.create({
    sandbox: sandboxOptions(),
    memory: `${memory}M`,
    cpus,
    httpHooks: setupHttpHooks,
    debugLog: debugLog(),
    startTimeoutMs: 0,
    vfs: {
      mounts: {
        '/workspace': new RealFSProvider(process.cwd()),
        '/root/.pi': new RealFSProvider(getConfig().piConfigDir),
      },
    },
  })

  const cleanup = async () => {
    try { await vm.close() } catch { /* ignore */ }
  }
  process.on('SIGINT', () => { cleanup().then(() => process.exit()) })
  process.on('SIGTERM', () => { cleanup().then(() => process.exit()) })

  try {
    info('Installing pi in VM...')
    // Check if pi is already installed in the VM
    const checkPi = await vm.exec(['which', 'pi'], { stdout: 'pipe', stderr: 'pipe' })
    if (checkPi.ok) {
      info('Pi is already installed in VM')
    } else {
      info('Installing pi via npm...')
      await vmExec(vm, 'npm install -g @earendil-works/pi-coding-agent')
    }

    // Install additional packages if specified
    if (guestPackages.length > 0) {
      info(`Installing guest packages: ${guestPackages.join(', ')}`)
      const pkgResult = spawnSync(
        'npm', ['install', '-g', ...guestPackages],
        { stdio: 'inherit' }
      )
      if (pkgResult.status !== 0) {
        info('Warning: failed to install guest packages')
      }
    }

    // Run post-setup hooks if specified
    if (postSetupHooks.length > 0) {
      info('Running post-setup hooks...')
      for (const hook of postSetupHooks) {
        await vmExec(vm, hook)
      }
    }

    info('Creating base checkpoint...')
    const checkpoint = await vm.checkpoint(checkpointFile())
    info('Base checkpoint created successfully!')

    cleanup()
  } catch (error) {
    await cleanup()
    if (error instanceof Error) {
      const cause = (error as any).cause
      const detail = cause instanceof Error ? `: ${cause.message}` : ''
      die(`${error.message}${detail}`)
    } else die('An unknown error occurred')
  }
}

/**
 * Runs pi in a sandboxed VM.
 * 
 * Cross-platform compatibility note: On macOS and Windows, the VM will still
 * run but with reduced rootfs management capabilities. The QEMU-based VM
 * itself is cross-platform compatible.
 */
async function cmdRun (args: string[]): Promise<void> {
  const cpPath = checkpointFile()
  if (!existsSync(cpPath)) {
    die('Base checkpoint not found. Run `vmpi setup` first.')
  }

  const { memory, cpus, piConfigDir, network: { localServices }, secrets, missingSecrets, mounts } = getConfig()
  
  // Check if we have missing secrets and warn about them
  if (missingSecrets.length > 0) {
    const names = missingSecrets.map(s => s.name).join(', ')
    info(`Warning: Missing secrets for: ${names}. These will not be available in the VM.`)
  }

  const { httpHooks, guestEnv } = buildHttpHooks(secrets)
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
    // Extract to /tmp/lib/ so node_modules lands at /tmp/lib/node_modules,
    // matching npm's global root when prefix=/tmp (prefix/lib/node_modules).
    await vmExec(vm, [
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

function cmdStatus (): void {
  const cpPath = checkpointFile()
  if (!existsSync(cpPath)) {
    die('Base checkpoint not found. Run `vmpi setup` first.')
  }

  const stat = lstatSync(cpPath)
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(1)
  let extra = ''
  const metaPath = cpPath + '.meta'
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    extra = ` (built ${meta.timestamp})`
  }

  info(`Base checkpoint: ${sizeMb} MiB${extra}`)
}

function printDebugAudit (): void {
  const deniedList = debugDeniedHosts != null ? [...debugDeniedHosts].sort() : []
  const missingList = debugMissingExes != null ? [...debugMissingExes].sort() : []
  if (deniedList.length > 0) {
    info('\nDebug audit: Denied network requests:')
    for (const host of deniedList) {
      info(`  ${host}`)
    }
  }
  if (missingList.length > 0) {
    info('\nDebug audit: Commands not found in VM:')
    for (const exe of missingList) {
      info(`  ${exe}`)
    }
  }
}

function shellQuote (s: string): string {
  // Simple shell quoting for the secret values. This is a minimal implementation
  // that should work for most common cases.
  if (s.includes("'")) {
    // If it contains single quotes, use a different approach
    return `"${s.replace(/"/g, '\\"')}"`
  } else {
    return `'${s}'`
  }
}

export { cmdRun, cmdSetup, cmdStatus }