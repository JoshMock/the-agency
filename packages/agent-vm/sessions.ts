import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { AgentClient } from 'vmsan'
/**
 * Converts an absolute filesystem path to the session directory name format
 * used by pi: strips the leading `/`, replaces all remaining `/` with `-`,
 * and wraps the result in `--`.
 *
 * Example: `/home/alice/Code/my-project` → `--home-alice-Code-my-project--`
 */
export function cwdToSessionDirName(cwd: string): string {
  const inner = cwd.replace(/^\//, '').replace(/\//g, '-')
  return `--${inner}--`
}

/**
 * Reverses `cwdToSessionDirName`: strips the leading and trailing `--`,
 * prepends a `/`, and replaces `-` back with `/`.
 *
 * Note: this is a best-effort reversal. Since both `/` and `-` in the
 * original path both become `-` in the encoded form, the decoded path is
 * ambiguous when the original path contains literal `-` segments. In
 * practice vmpi only needs to decode the VM-side name (`--workspace--`),
 * which is unambiguous.
 *
 * Example: `--home-alice-Code-my-project--` → `/home/alice/Code/my-project`
 */
export function sessionDirNameToCwd(dirName: string): string {
  const inner = dirName.replace(/^--/, '').replace(/--$/, '')
  return '/' + inner.replace(/-/g, '/')
}

/**
 * Uploads the host's session directory for `hostCwd` into the VM, stored
 * under the VM-side session directory name for `/workspace`. This allows pi
 * running at `/workspace` inside the VM to find and continue prior sessions
 * that were created on the host at `hostCwd`.
 *
 * If no matching session directory exists on the host, this is a no-op.
 */
export async function uploadSessions(
  agent: AgentClient,
  hostCwd: string,
  piConfigDir: string,
): Promise<void> {
  const hostDirName = cwdToSessionDirName(hostCwd)
  const hostSessionsDir = join(piConfigDir, 'agent', 'sessions')
  const hostSessionDir = join(hostSessionsDir, hostDirName)

  if (!existsSync(hostSessionDir)) return

  const vmDirName = cwdToSessionDirName('/workspace')
  const tarPath = join(tmpdir(), `vmpi-sessions-up-${Date.now()}.tar.gz`)

  try {
    // tar the session dir under a name matching the VM-side path
    const renamedTarPath = join(tmpdir(), `vmpi-sessions-stage-${Date.now()}`)
    mkdirSync(renamedTarPath, { recursive: true })
    const stageDir = join(renamedTarPath, vmDirName)
    // copy: tar out → tar in under the vm dir name
    spawnSync('cp', ['-r', hostSessionDir, stageDir], { stdio: 'inherit' })
    spawnSync('tar', ['czf', tarPath, '-C', renamedTarPath, vmDirName], { stdio: 'inherit' })
    rmSync(renamedTarPath, { recursive: true, force: true })

    const content = readFileSync(tarPath)
    const tarName = basename(tarPath)
    await agent.writeFiles([{ path: tarName, content }], '/tmp')

    // extract into the VM's pi sessions directory
    const vmSessionsDir = '/root/.pi/agent/sessions'
    const mkdirResult = await (await agent.exec(
      { cmd: 'mkdir', args: ['-p', vmSessionsDir] },
    )).wait()
    if (mkdirResult.exitCode !== 0) throw new Error('mkdir failed in VM for sessions dir')

    const tarResult = await (await agent.exec(
      { cmd: 'tar', args: ['xzf', `/tmp/${tarName}`, '-C', vmSessionsDir] },
    )).wait()
    if (tarResult.exitCode !== 0) throw new Error('tar extract failed in VM for sessions')

    await (await agent.exec({ cmd: 'rm', args: [`/tmp/${tarName}`] })).wait()
  } finally {
    rmSync(tarPath, { force: true })
  }
}

/**
 * Downloads the VM-side session directory for `/workspace` back to the host,
 * storing it under the session directory name matching `hostCwd`. This
 * preserves any new sessions created during the VM run so they can be resumed
 * with `pi --continue` or `vmpi --continue` in future invocations.
 *
 * If the VM-side session directory does not exist, this is a no-op.
 */
export async function downloadSessions(
  agent: AgentClient,
  hostCwd: string,
  piConfigDir: string,
): Promise<void> {
  const vmDirName = cwdToSessionDirName('/workspace')
  const vmSessionDir = `/root/.pi/agent/sessions/${vmDirName}`

  // check if the directory exists in the VM
  const checkResult = await (await agent.exec(
    { cmd: 'test', args: ['-d', vmSessionDir] },
  )).wait()
  if (checkResult.exitCode !== 0) return

  const tarName = `vmpi-sessions-down-${Date.now()}.tar.gz`
  const vmTarPath = `/tmp/${tarName}`

  const tarResult = await (await agent.exec(
    { cmd: 'tar', args: ['czf', vmTarPath, '-C', '/root/.pi/agent/sessions', vmDirName] },
  )).wait()
  if (tarResult.exitCode !== 0) throw new Error('tar failed in VM when downloading sessions')

  const tarBuf = await agent.readFile(vmTarPath)
  if (tarBuf == null) throw new Error('readFile returned null for session tar')

  const localTar = join(tmpdir(), tarName)
  try {
    writeFileSync(localTar, tarBuf)

    const hostSessionsDir = join(piConfigDir, 'agent', 'sessions')
    const hostDirName = cwdToSessionDirName(hostCwd)
    const hostSessionDir = join(hostSessionsDir, hostDirName)

    // extract the vm-named dir, then rename it to the host-cwd name
    const stagingDir = join(tmpdir(), `vmpi-sessions-stage-${Date.now()}`)
    mkdirSync(stagingDir, { recursive: true })
    try {
      spawnSync('tar', ['xzf', localTar, '-C', stagingDir], { stdio: 'inherit' })

      const extractedDir = join(stagingDir, vmDirName)
      if (!existsSync(extractedDir)) {
        throw new Error(`Expected extracted session dir not found: ${extractedDir}`)
      }

      mkdirSync(hostSessionsDir, { recursive: true })

      // merge: move any new/updated files from extracted dir into the host session dir
      if (!existsSync(hostSessionDir)) {
        renameSync(extractedDir, hostSessionDir)
      } else {
        // host dir already exists — move new files in without clobbering existing ones
        for (const file of readdirSync(extractedDir)) {
          const dest = join(hostSessionDir, file)
          if (!existsSync(dest)) {
            renameSync(join(extractedDir, file), dest)
          }
        }
        rmSync(extractedDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(stagingDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(localTar, { force: true })
  }
}
