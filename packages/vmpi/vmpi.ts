#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Command } from 'commander'
import {
  VM,
  VmCheckpoint,
  RealFSProvider,
  createHttpHooks,
} from '@earendil-works/gondolin'
import { loadConfig, type ResolvedConfig } from './config.ts'
import { prepareSessionsForVm, collectSessionsFromVm } from './sessions.ts'

let _config: ResolvedConfig | undefined
let debugMode = false

/** Lazily loads and caches the resolved configuration. */
function getConfig(): ResolvedConfig {
  if (_config == null) _config = loadConfig()
  return _config
}

/** Path to the qcow2 base checkpoint file. */
function checkpointFile(): string {
  return join(getConfig().stateDir, 'base-checkpoint.qcow2')
}

/** Prints a fatal error to stderr and exits with code 1. */
function die(message: string): never {
  console.error(`[vmpi] error: ${message}`)
  process.exit(1)
}

/** Prints an informational message to stderr. */
function info(message: string): void {
  console.error(`[vmpi] ${message}`)
}

/**
 * Checks all host prerequisites before running setup or a sandbox session.
 * Hard failures call `die()`; soft warnings (KVM unavailable) print to stderr.
 *
 * Checks:
 *   - Node.js >= 23.6.0 (Gondolin requirement)
 *   - qemu-system-x86_64 in PATH
 *   - qemu-img in PATH (required for qcow2 overlay / checkpointing)
 *   - /dev/kvm readable+writable (warns if absent; VM falls back to TCG, which is slower)
 */
function checkPrerequisites(): void {
  // Node.js version
  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
  if (nodeMajor < 23 || (nodeMajor === 23 && nodeMinor < 6)) {
    die(`Node.js >= 23.6.0 is required (found ${process.version}). ` +
      'Upgrade via nvm, fnm, or your package manager.')
  }

  // Required binaries
  const required: [string, string][] = [
    ['qemu-system-x86_64', 'Arch: sudo pacman -S qemu-system-x86  |  Ubuntu: sudo apt install qemu-system-x86'],
    ['qemu-img',           'Arch: sudo pacman -S qemu-img         |  Ubuntu: sudo apt install qemu-utils'],
  ]
  for (const [bin, hint] of required) {
    if (spawnSync('which', [bin], { stdio: 'pipe' }).status !== 0) {
      die(`${bin} not found. Install it and try again.\n  ${hint}`)
    }
  }

  // KVM (soft warning — falls back to TCG emulation, which is much slower)
  try {
    accessSync('/dev/kvm', constants.R_OK | constants.W_OK)
  } catch {
    console.error('[vmpi] warning: /dev/kvm not accessible — falling back to TCG (software emulation). ' +
      'VMs will boot significantly slower. To enable KVM: check that the kvm kernel module is loaded ' +
      'and that your user has rw access to /dev/kvm.')
  }
}

/**
 * Returns `sandbox` options shared by all VM.create() calls:
 * - forces `q35` machine type on Linux x86_64 to fix Gondolin's broken
 *   `microvm` default (which has no PCI bus but generates PCI device args)
 * - enables network debug logging when `--debug` is passed
 */
function sandboxOptions(): import('@earendil-works/gondolin').VMOptions['sandbox'] {
  const opts: import('@earendil-works/gondolin').VMOptions['sandbox'] = {}
  if (process.platform === 'linux' && process.arch === 'x64') {
    opts.machineType = 'q35'
  }
  return opts
}

/**
 * Returns the debug log callback when `--debug` is active, otherwise null
 * (suppresses all Gondolin debug output).
 */
function debugLog(): import('@earendil-works/gondolin').VMOptions['debugLog'] {
  if (!debugMode) return null
  return (component: import('@earendil-works/gondolin').DebugComponent, message: string) => {
    process.stderr.write(`[gondolin:${component}] ${message}\n`)
  }
}

/**
 * Runs a shell command inside a VM, streaming output to stderr.
 * In normal mode only guest stderr is shown (stdout is discarded).
 * In debug mode both streams are shown, prefixed with [stdout]/[stderr].
 * Throws if the command exits with a non-zero code.
 */
async function vmExec(vm: VM, cmd: string): Promise<void> {
  // Use array form (/bin/sh -c) rather than string form (/bin/sh -lc) because
  // the Alpine login shell doesn't populate PATH, so `npm`, `pi`, etc. are not
  // found when using the login-shell string shorthand.
  const proc = vm.exec(['/bin/sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' })
  for await (const { stream, text } of proc.output()) {
    if (debugMode) {
      process.stderr.write(`[${stream}] ${text}`)
    } else if (stream === 'stderr') {
      process.stderr.write(text)
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
 *   - We can't resize the rootfs without modifying Gondolin's cached image
 *   - Instead, store the 33 MB compressed archive on the rootfs (/opt/),
 *     extract to /tmp (tmpfs, 486 MB) on each run
 */
async function buildPiBundle(): Promise<Buffer> {
  const cacheDir = join(getConfig().stateDir, 'cache')
  const registryUrl = 'https://registry.npmjs.org/@mariozechner%2Fpi-coding-agent'

  info('Fetching pi package metadata...')
  const meta = await fetch(registryUrl).then(r => r.json()) as Record<string, any>
  const version: string = meta['dist-tags']['latest']
  const tarballUrl: string = meta['versions'][version]['dist']['tarball']
  const integrity: string = meta['versions'][version]['dist']['integrity']

  // Include a hash of the user's pi package list in the cache key so the
  // bundle is rebuilt when packages are added or removed.
  let pkgHash = 'no-pkgs'
  const settingsPath = join(getConfig().piConfigDir, 'agent', 'settings.json')
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages?: string[] }
      const pkgs = (settings.packages ?? []).sort().join(',')
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
    { cwd: installDir, stdio: 'inherit' },
  )
  if (npmResult.status !== 0) throw new Error('npm install failed while building pi bundle')

  // Also install the user's pi packages into the bundle so they're available
  // inside the VM without network access.
  // settingsPath is already resolved above for the cache key
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { packages?: string[] }
      const packages = (settings.packages ?? []).filter(p => p.startsWith('npm:'))
      if (packages.length > 0) {
        info(`Installing ${packages.length} pi package(s) into bundle...`)
        const specs = packages.map(p => p.slice('npm:'.length))
        const pkgResult = spawnSync(
          'npm', ['install', ...specs, '--save', '--legacy-peer-deps'],
          { cwd: installDir, stdio: 'inherit' },
        )
        if (pkgResult.status !== 0) {
          info('Warning: some pi packages failed to install — they will be skipped in the VM')
        }
      }
    } catch {
      info('Warning: could not read pi settings.json — skipping pi package installation')
    }
  }

  // Archive just the node_modules directory
  info('Compressing bundle...')
  mkdirSync(cacheDir, { recursive: true })
  const archiveResult = spawnSync(
    'tar', ['czf', bundlePath, 'node_modules'],
    { cwd: installDir, stdio: 'inherit' },
  )
  if (archiveResult.status !== 0) throw new Error('tar failed while archiving pi bundle')

  // Clean up the install dir (keep only the cached archive)
  spawnSync('rm', ['-rf', installDir], { stdio: 'inherit' })

  info(`Bundle ready: ${bundlePath} (${(readFileSync(bundlePath).length / 1e6).toFixed(1)} MB)`)
  return readFileSync(bundlePath)
}

/**
 * Builds the `httpHooks` option enforcing the configured network policy.
 * Returns `undefined` for `allow-all` (no hooks = unrestricted egress).
 * Returns hooks with an empty allowlist for `deny-all`.
 * Returns hooks with the configured domain list for `custom`.
 *
 * `localServices` hostnames are added to `allowedInternalHosts` so Gondolin's
 * internal-IP block does not reject connections to the mapped host ports.
 */
function buildHttpHooks(): ReturnType<typeof createHttpHooks>['httpHooks'] | undefined {
  const { policy, allowedDomains, localServices } = getConfig().network
  const internalHostnames = localServices.map(s => s.hostname)

  if (policy === 'allow-all') {
    info('Network policy: allow-all (unrestricted)')
    return undefined
  }

  if (policy === 'deny-all') {
    info('Network policy: deny-all')
    if (internalHostnames.length === 0) return createHttpHooks({ allowedHosts: [] }).httpHooks
    // Even with deny-all, local services must still be reachable.
    return createHttpHooks({ allowedHosts: [], allowedInternalHosts: internalHostnames }).httpHooks
  }

  // custom
  info(`Network policy: custom (${allowedDomains.length} allowed domain(s)${internalHostnames.length > 0 ? `, ${internalHostnames.length} local service(s)` : ''})`)
  return createHttpHooks({
    allowedHosts: allowedDomains,
    allowedInternalHosts: internalHostnames,
  }).httpHooks
}

/**
 * Builds the base checkpoint. Installs pi on the host, archives the
 * `node_modules` tree, writes it to `/opt/pi-modules.tgz` on the VM's
 * rootfs, then saves a qcow2 disk checkpoint. Subsequent `vmpi` runs
 * resume from that checkpoint and extract the bundle to `/tmp` at startup.
 */
async function cmdSetup(): Promise<void> {
  checkPrerequisites()
  info('Building base checkpoint (installing pi)...')
  mkdirSync(getConfig().stateDir, { recursive: true })

  const piBundle = await buildPiBundle()
  const { memory, cpus } = getConfig()

  // `cow` rootfs mode requires `qemu-img`; `memory` uses QEMU's built-in
  // snapshot mode and needs no extra tooling. We use `cow` here because we
  // are about to checkpoint the disk.
  const vm = await VM.create({
    sandbox: sandboxOptions(),
    memory: `${memory}M`,
    cpus,
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
function cmdStatus(): void {
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

/** Runs pi in a sandboxed VM resumed from the base checkpoint. */
async function cmdRun(args: string[]): Promise<void> {
  checkPrerequisites()
  if (!existsSync(checkpointFile())) {
    info('No base checkpoint found — running setup first...')
    await cmdSetup()
  }

  const { memory, cpus, piConfigDir, network: { localServices } } = getConfig()
  const httpHooks = buildHttpHooks()

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
  cpSync(piConfigDir, piConfigSnapshotDir, { recursive: true })

  info(`Resuming sandbox VM from checkpoint...`)
  const checkpoint = VmCheckpoint.load(checkpointFile())
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
    ].join(' && '))

    info("Launching pi in sandbox (type 'exit' or Ctrl-D to quit)...")
    console.error('')

    const piArgs = args.map(a => JSON.stringify(a)).join(' ')
    const proc = vm.shell({
      command: ['/bin/sh', '-c', `cd /workspace && pi ${piArgs}; exit $?`],
      attach: true,
    })

    const result = await proc

    info('Collecting sessions from VM...')
    collectSessionsFromVm(process.cwd(), piConfigSnapshotDir)
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

  memory          RAM in MiB                  (env: VMPI_MEMORY,    default: 256)
  cpus            vCPU count                  (env: VMPI_CPUS,      default: 1)
  piConfigDir     pi config dir on host       (env: PI_CONFIG_DIR,  default: ~/.pi)
  stateDir        vmpi state dir on host      (env: VMPI_STATE_DIR, default: ~/.vmpi)
  network.policy                allow-all | deny-all | custom (inferred when providers/domains set)
  network.providers             LLM providers: github-copilot, gemini, openai, anthropic, ollama
  network.allowedDomains        Additional domain patterns to allow
  network.localServices         Host services to expose inside the VM:
                                  [{ "hostname": "my-api.local", "port": 8080 }]
                                Connect inside the VM as http://my-api.local:8080

Example .vmpirc.json:
  {
    "memory": 512,
    "network": {
      "providers": ["github-copilot", "anthropic"],
      "allowedDomains": ["my-llm.example.com"],
      "localServices": [{ "hostname": "ollama.local", "port": 11434 }]
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
