import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

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
 * Copies the host's session directory for `hostCwd` into the `--workspace--`
 * slot inside `piConfigDir` (which is a temp snapshot of the host's ~/.pi).
 * This lets pi running at `/workspace` inside the VM find prior sessions.
 *
 * We copy rather than symlink because the host's `--workspace--` symlink may
 * point to an absolute host path that has no meaning inside the guest.
 *
 * If no matching session directory exists on the host, this is a no-op.
 * If `hostCwd` is already `/workspace`, the slot is already in the right place.
 */
export function prepareSessionsForVm(hostCwd: string, piConfigDir: string): void {
  const hostDirName = cwdToSessionDirName(hostCwd)
  const vmDirName = cwdToSessionDirName('/workspace')

  if (hostDirName === vmDirName) return

  const sessionsDir = join(piConfigDir, 'agent', 'sessions')
  const hostSessionDir = join(sessionsDir, hostDirName)
  const vmSessionDir = join(sessionsDir, vmDirName)

  if (!existsSync(hostSessionDir)) return

  mkdirSync(sessionsDir, { recursive: true })

  if (!existsSync(vmSessionDir)) {
    cpSync(hostSessionDir, vmSessionDir, { recursive: true })
  }
}

/**
 * Merges sessions written to the `--workspace--` slot back into the host
 * CWD session directory, then removes the `--workspace--` copy.
 *
 * Pi appends to session files in-place when continuing a session, so the VM
 * copy of an existing file may be larger than the host's original. Files are
 * moved when new (not on host) or replaced when the VM copy is larger (new
 * content was appended). Same-size copies -- unchanged files that were only
 * mirrored for context -- are left on the host as-is.
 *
 * `snapshotDir` is the temporary pi config snapshot that the VM wrote to
 * (i.e. where `--workspace--` lives). `hostPiConfigDir` is the real host
 * pi config dir (i.e. `~/.pi`) where sessions should be written back.
 * When omitted, `hostPiConfigDir` defaults to `snapshotDir` (used in tests).
 *
 * This is a no-op when `hostCwd` is `/workspace` or if no `--workspace--`
 * directory exists.
 */
export function collectSessionsFromVm(
  hostCwd: string,
  snapshotDir: string,
  hostPiConfigDir: string = snapshotDir,
): void {
  const hostDirName = cwdToSessionDirName(hostCwd)
  const vmDirName = cwdToSessionDirName('/workspace')

  if (hostDirName === vmDirName) return

  const snapshotSessionsDir = join(snapshotDir, 'agent', 'sessions')
  const hostSessionsDir = join(hostPiConfigDir, 'agent', 'sessions')
  const hostSessionDir = join(hostSessionsDir, hostDirName)
  const vmSessionDir = join(snapshotSessionsDir, vmDirName)

  if (!existsSync(vmSessionDir)) return

  // Guard against stale symlinks left by a previous vmpi version.
  if (lstatSync(vmSessionDir).isSymbolicLink()) {
    unlinkSync(vmSessionDir)
    return
  }

  mkdirSync(hostSessionDir, { recursive: true })
  for (const file of readdirSync(vmSessionDir)) {
    const src = join(vmSessionDir, file)
    const dest = join(hostSessionDir, file)
    if (!existsSync(dest) || statSync(src).size > statSync(dest).size) {
      renameSync(src, dest)
    }
  }
  rmSync(vmSessionDir, { recursive: true, force: true })
}
