#!/usr/bin/env node
// vmpi - run pi sandboxed in a Firecracker microVM via vmsan
//
// Usage: vmpi [pi args...]
//        vmpi setup   -- (re)build the base snapshot
//        vmpi status  -- show snapshot and VM info
//
// On first run, vmpi auto-builds a base snapshot by installing pi via npm.
// Subsequent runs boot from that snapshot, upload the current directory and
// ~/.pi into the VM, run `pi update`, then hand control to pi inside the sandbox.
//
// Requires: vmsan installed, sudo access, tar

import { readFileSync, existsSync, readdirSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, basename, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Command } from 'commander'
import {
  createVmsan,
  AgentClient,
  ShellSession,
  resolveVmState,
  waitForAgent,
  vmsanPaths,
  type VMService,
  type VmsanPaths,
} from 'vmsan'
import { loadConfig, type ResolvedConfig } from './config.ts'
import { uploadSessions, downloadSessions } from './sessions.ts'

// ── Config ────────────────────────────────────────────────────────────────────

let _config: ResolvedConfig | undefined

/** Lazily loads and caches the resolved configuration. */
function getConfig(): ResolvedConfig {
  if (_config == null) _config = loadConfig()
  return _config
}

/** Returns the path to the snapshot ID file within the state directory. */
function snapshotIdFile(): string {
  return join(getConfig().stateDir, 'base-snapshot-id')
}


// ── Helpers ──────────────────────────────────────────────────────────────────

function die(message: string): never {
  console.error(`[vmpi] error: ${message}`)
  process.exit(1)
}

function info(message: string): void {
  console.error(`[vmpi] ${message}`)
}

/**
 * Runs a command inside a VM as root and streams its output to stderr.
 * Throws if the command exits with a non-zero code.
 */
async function vmExec(agent: AgentClient, cmd: string, args: string[]): Promise<void> {
  const result = await (await agent.exec(
    { cmd, args },
    {
      onStdout: (line) => process.stderr.write(line + '\n'),
      onStderr: (line) => process.stderr.write(line + '\n'),
    },
  )).wait()

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')} (exit code ${result.exitCode})`)
  }
}

/**
 * Creates an AgentClient connected to a running VM and waits for the agent
 * to be ready.
 */
async function connectAgent(vmId: string, paths: VmsanPaths): Promise<AgentClient> {
  const { state, guestIp, port } = resolveVmState(vmId, paths)
  await waitForAgent(guestIp, port)
  return new AgentClient(`http://${guestIp}:${port}`, state.agentToken)
}

/**
 * Creates a vmsan snapshot of a running VM and returns its ID.
 * SnapshotService is not part of vmsan's public API, so we invoke the CLI
 * for this single operation.
 */
function snapshotCreate(vmId: string): string {
  const result = spawnSync(
    'vmsan', ['--json', 'snapshot', 'create', vmId],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] },
  )
  if (result.error) throw result.error
  if (result.status !== 0) die(`vmsan snapshot create failed (exit code ${result.status})`)
  const lines = result.stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i])
      if (obj.snapshotId != null) return obj.snapshotId as string
    } catch { /* ignore non-json lines */ }
  }
  die('Could not parse snapshotId from vmsan snapshot create output')
}

/**
 * Tars a local directory and uploads it into the VM, extracting at destInVm.
 * Uses agent.writeFiles for the transfer — no CLI invocation needed.
 */
async function uploadDir(
  agent: AgentClient,
  localDir: string,
  destInVm: string,
): Promise<void> {
  const tarPath = join(tmpdir(), `vmpi-upload-${Date.now()}.tar.gz`)
  try {
    const tarResult = spawnSync('tar', ['czf', tarPath, '-C', dirname(localDir), basename(localDir)],
      { stdio: 'inherit' })
    if (tarResult.status !== 0) throw new Error(`tar failed archiving ${localDir} (exit code ${tarResult.status})`)
    const content = readFileSync(tarPath)
    await agent.writeFiles([{ path: basename(tarPath), content }], '/tmp')
    await vmExec(agent, 'tar', ['xzf', `/tmp/${basename(tarPath)}`, '-C', dirname(destInVm)])
    await vmExec(agent, 'rm', [`/tmp/${basename(tarPath)}`])
  } finally {
    rmSync(tarPath, { force: true })
  }
}

/**
 * Switches the VM from the initial allow-all to the user-configured network
 * policy. Called after `pi update` finishes so that the agent session running
 * under the user sees the restricted policy.
 */
async function applyNetworkPolicy(vmService: VMService, vmId: string): Promise<void> {
  const { policy, allowedDomains } = getConfig().network

  if (policy === 'allow-all') {
    info('Network policy: allow-all (unrestricted)')
    return
  }

  info(policy === 'deny-all'
    ? 'Applying network policy: deny-all'
    : `Applying network policy: custom (${allowedDomains.length} allowed domain(s))`)

  await vmService.updateNetworkPolicy(vmId, policy, allowedDomains, [], [])
}

// ── Commands ──────────────────────────────────────────────────────────────────

/** Builds the base snapshot by installing pi into a fresh VM and snapshotting it. */
async function cmdSetup(): Promise<void> {
  info('Building base snapshot...')

  const paths = vmsanPaths()
  const vmService = await createVmsan()

  info(`Creating setup VM (${getConfig().memory} MiB, ${getConfig().cpus} vCPU, node24 runtime, network enabled for setup)...`)
  const { vmId } = await vmService.create({
    memMib: getConfig().memory,
    vcpus: getConfig().cpus,
    runtime: 'node24',
    networkPolicy: 'allow-all',
  })
  info(`VM ${vmId} is up`)

  const cleanup = async () => {
    info('Cleaning up setup VM...')
    try {
      await vmService.stop(vmId)
      await vmService.remove(vmId)
    } catch (e: any) {
      info(`Warning: Cleanup failed, you may need to run 'sudo vmsan remove ${vmId}' manually. Error: ${e.message}`)
    }
  }

  process.on('SIGINT', () => { cleanup().then(() => process.exit()) })
  process.on('SIGTERM', () => { cleanup().then(() => process.exit()) })

  try {
    const agent = await connectAgent(vmId, paths)

    info('Installing pi...')
    await vmExec(agent, 'npm', ['install', '-g', '@mariozechner/pi-coding-agent'])

    // the node24 image ships git, curl, node, npm, and python3 — only pip is missing
    info('Bootstrapping pip...')
    await vmExec(agent, 'curl', ['-sSo', '/tmp/get-pip.py', 'https://bootstrap.pypa.io/get-pip.py'])
    await vmExec(agent, 'python3', ['/tmp/get-pip.py', '--user', '--break-system-packages'])

    info('Creating snapshot...')
    const snapshotId = snapshotCreate(vmId)

    mkdirSync(getConfig().stateDir, { recursive: true })
    writeFileSync(snapshotIdFile(), snapshotId)
    info(`Base snapshot ready: ${snapshotId} (stored in ${snapshotIdFile()})`)
  } finally {
    await cleanup()
  }
}

/** Shows snapshot ID and running VMs without requiring sudo when no VMs exist. */
function cmdStatus(): void {
  if (existsSync(snapshotIdFile())) {
    console.log(`Base snapshot: ${readFileSync(snapshotIdFile(), 'utf8').trim()}`)
  } else {
    console.log('Base snapshot: not set up (run: vmpi setup)')
  }

  // read VM state files directly — avoids sudo when no VMs exist
  const vmsDir = join(homedir(), '.vmsan', 'vms')
  const vmFiles = existsSync(vmsDir)
    ? readdirSync(vmsDir).filter(f => f.endsWith('.json'))
    : []

  if (vmFiles.length === 0) {
    console.log('\nNo VMs found.')
    return
  }

  // VMs exist — list them via the SDK
  createVmsan().then(svc => {
    console.log('')
    for (const vm of svc.list()) {
      console.log(`${vm.id}  status=${vm.status}  runtime=${vm.runtime ?? 'unknown'}`)
    }
  }).catch((e: Error) => die(e.message))
}

/** Prints usage information and exits. */
/** Runs pi in a sandboxed VM restored from the base snapshot. */
async function cmdRun(args: string[]): Promise<void> {
  if (!existsSync(snapshotIdFile())) {
    info('No base snapshot found — running setup first...')
    await cmdSetup()
  }

  const snapId = readFileSync(snapshotIdFile(), 'utf8').trim()
  const paths = vmsanPaths()
  const vmService = await createVmsan()
  let vmId: string | undefined

  const cleanup = async () => {
    if (vmId == null) return
    info(`Stopping and removing VM ${vmId}...`)
    try {
      await vmService.stop(vmId)
      await vmService.remove(vmId)
    } catch (e: any) {
      info(`Note: Could not auto-cleanup VM ${vmId}. It may already be gone, or run 'sudo vmsan remove ${vmId}'.`)
    }
  }

  process.on('SIGINT', () => { cleanup().then(() => process.exit()) })
  process.on('SIGTERM', () => { cleanup().then(() => process.exit()) })

  // boot with allow-all so pi update can reach the network, lock down afterward
  info(`Creating sandboxed VM from base snapshot ${snapId}...`)
  const result = await vmService.create({
    memMib: getConfig().memory,
    vcpus: getConfig().cpus,
    networkPolicy: 'allow-all',
    snapshotId: snapId,
  })
  vmId = result.vmId
  info(`VM ${vmId} is up`)

  try {
    const agent = await connectAgent(vmId, paths)

    info('Uploading current directory...')
    const cwdTar = join(tmpdir(), `vmpi-cwd-${Date.now()}.tar.gz`)
    try {
      const tarResult = spawnSync('tar', [
        'czf', cwdTar,
        '--exclude=.git',
        '--exclude=node_modules',
        '--exclude=.next',
        '--exclude=dist',
        '--exclude=__pycache__',
        '--exclude=*.pyc',
        '-C', process.cwd(),
        '.',
      ], { stdio: 'inherit' })
      if (tarResult.status !== 0) throw new Error(`tar failed creating CWD archive (exit code ${tarResult.status})`)
      const cwdContent = readFileSync(cwdTar)
      await agent.writeFiles([{ path: basename(cwdTar), content: cwdContent }], '/tmp')
      await vmExec(agent, 'mkdir', ['-p', '/workspace'])
      await vmExec(agent, 'tar', ['xzf', `/tmp/${basename(cwdTar)}`, '-C', '/workspace'])
      await vmExec(agent, 'rm', [`/tmp/${basename(cwdTar)}`])
    } finally {
      rmSync(cwdTar, { force: true })
    }

    if (existsSync(getConfig().piConfigDir)) {
      info('Uploading pi config (~/.pi)...')
      await uploadDir(agent, getConfig().piConfigDir, '/root/.pi')

      info('Running pi update to install packages...')
      await vmExec(agent, 'pi', ['update'])
    } else {
      info('No ~/.pi directory found, skipping')
    }

    info('Uploading sessions for current directory...')
    await uploadSessions(agent, process.cwd(), getConfig().piConfigDir)

    await applyNetworkPolicy(vmService, vmId)

    info("Launching pi in sandbox (type 'exit' or Ctrl-D to quit)...")
    console.error('')

    const { state, guestIp, port } = resolveVmState(vmId, paths)
    const piArgs = args.map(a => JSON.stringify(a)).join(' ')
    const session = new ShellSession({
      host: guestIp,
      port,
      token: state.agentToken,
      user: 'root',
      initialCommand: `cd /workspace && pi ${piArgs}; exit $?\n`,
    })

    await session.connect()

    info('Downloading sessions from VM...')
    await downloadSessions(agent, process.cwd(), getConfig().piConfigDir)
    process.exit(0)

  } catch (error) {
    await cleanup()
    if (error instanceof Error) {
      const cause = (error as any).cause
      const detail = cause instanceof Error ? `: ${cause.message}` : ''
      die(`${error.message}${detail}`)
    } else die('An unknown error occurred')
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const CONFIG_HELP = `
Configuration (.vmpirc.json, vmpi.config.js, "vmpi" key in package.json, etc.):

  memory          RAM in MiB                  (env: VMPI_MEMORY,    default: 256)
  cpus            vCPU count                  (env: VMPI_CPUS,      default: 1)
  piConfigDir     pi config dir on host       (env: PI_CONFIG_DIR,  default: ~/.pi)
  stateDir        vmpi state dir on host      (env: VMPI_STATE_DIR, default: ~/.vmpi)
  network.policy          allow-all | deny-all | custom (inferred when providers/domains set)
  network.providers       LLM providers: github-copilot, gemini, openai, anthropic, ollama
  network.allowedDomains  Additional domain patterns to allow

Example .vmpirc.json:
  {
    "memory": 512,
    "network": {
      "providers": ["github-copilot", "anthropic"],
      "allowedDomains": ["my-llm.example.com"]
    }
  }
`

const program = new Command()
  .name('vmpi')
  .description('Run pi sandboxed in a Firecracker microVM via vmsan')
  .addHelpText('after', `\n${CONFIG_HELP}`)

// default command: vmpi [piArgs...]
program
  .argument('[piArgs...]', 'arguments forwarded to pi inside the VM')
  .passThroughOptions()
  .allowUnknownOption()
  .action(async (piArgs: string[]) => {
    await cmdRun(piArgs)
  })

program
  .command('setup')
  .description('(Re)build the base VM snapshot')
  .action(async () => {
    await cmdSetup()
  })

program
  .command('status')
  .description('Show base snapshot ID and running VMs')
  .action(() => {
    cmdStatus()
  })

// vmsan's network namespace and jailer operations require root
if (process.getuid?.() !== 0) {
  console.error('[vmpi] error: vmpi must be run as root (use: sudo -E vmpi)')
  process.exit(1)
}

program.parseAsync(process.argv).catch(error => {
  if (error instanceof Error) die(error.message)
  else die('An unknown error occurred')
})
