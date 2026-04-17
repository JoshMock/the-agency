import { describe, it, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cwdToSessionDirName,
  sessionDirNameToCwd,
  prepareSessionsForVm,
  collectSessionsFromVm,
} from './sessions.js'

/** Creates a temporary pi config dir, returning its path and a cleanup function. */
function makeTmpPiDir(): { piDir: string; cleanup: () => void } {
  const piDir = join(tmpdir(), `vmpi-sessions-test-${Date.now()}`)
  mkdirSync(piDir, { recursive: true })
  return { piDir, cleanup: () => rmSync(piDir, { recursive: true, force: true }) }
}

/**
 * Resolves the sessions dir paths for a given host CWD inside a pi config dir.
 * Creates the sessions parent directory but not the session subdirectories.
 */
function sessionPaths(piDir: string, hostCwd: string): {
  sessionsDir: string
  hostSessionDir: string
  vmSessionDir: string
} {
  const sessionsDir = join(piDir, 'agent', 'sessions')
  return {
    sessionsDir,
    hostSessionDir: join(sessionsDir, cwdToSessionDirName(hostCwd)),
    vmSessionDir: join(sessionsDir, '--workspace--'),
  }
}

describe('cwdToSessionDirName', () => {
  it('encodes a typical absolute path', () => {
    assert.equal(
      cwdToSessionDirName('/home/alice/Code/my-project'),
      '--home-alice-Code-my-project--',
    )
  })

  it('encodes the root path', () => {
    assert.equal(cwdToSessionDirName('/'), '----')
  })

  it('encodes a single-segment path', () => {
    assert.equal(cwdToSessionDirName('/workspace'), '--workspace--')
  })

  it('encodes a path whose segments already contain dashes', () => {
    assert.equal(
      cwdToSessionDirName('/home/alice/my-proj'),
      '--home-alice-my-proj--',
    )
  })

  it('encodes a deep nested path', () => {
    assert.equal(
      cwdToSessionDirName('/home/alice/Code/the-agency/packages/vmpi'),
      '--home-alice-Code-the-agency-packages-vmpi--',
    )
  })

  it('encodes /workspace and decodes back via sessionDirNameToCwd', () => {
    const encoded = cwdToSessionDirName('/workspace')
    assert.equal(sessionDirNameToCwd(encoded), '/workspace')
  })
})

describe('sessionDirNameToCwd', () => {
  it('decodes --workspace-- to /workspace', () => {
    assert.equal(sessionDirNameToCwd('--workspace--'), '/workspace')
  })

  it('decodes the root encoding', () => {
    assert.equal(sessionDirNameToCwd('----'), '/')
  })

  it('decodes a path with no dashes in segments', () => {
    assert.equal(
      sessionDirNameToCwd('--home-alice-Code--'),
      '/home/alice/Code',
    )
  })
})

describe('prepareSessionsForVm', () => {
  let piDir: string
  let cleanup: () => void

  beforeEach(() => {
    ({ piDir, cleanup } = makeTmpPiDir())
  })

  afterEach(() => cleanup())

  it('is a no-op when no host session dir exists', () => {
    prepareSessionsForVm('/home/alice/myproject', piDir)
    const { sessionsDir } = sessionPaths(piDir, '/home/alice/myproject')
    assert.ok(!existsSync(sessionsDir) || readdirSync(sessionsDir).length === 0)
  })

  it('copies the host CWD session dir to --workspace--', () => {
    const { hostSessionDir, vmSessionDir } = sessionPaths(piDir, '/home/alice/myproject')
    mkdirSync(hostSessionDir, { recursive: true })
    writeFileSync(join(hostSessionDir, 'session-1.json'), '{}')

    prepareSessionsForVm('/home/alice/myproject', piDir)

    assert.ok(existsSync(vmSessionDir))
    assert.ok(!lstatSync(vmSessionDir).isSymbolicLink())
    assert.ok(existsSync(join(vmSessionDir, 'session-1.json')))
  })

  it('preserves file modification times so --continue picks the right session', () => {
    const { hostSessionDir, vmSessionDir } = sessionPaths(piDir, '/home/alice/myproject')
    mkdirSync(hostSessionDir, { recursive: true })

    const oldFile = join(hostSessionDir, 'old-session.jsonl')
    const newFile = join(hostSessionDir, 'new-session.jsonl')
    writeFileSync(oldFile, '{"old": true}')
    writeFileSync(newFile, '{"new": true}')

    const oldTime = new Date('2024-01-01T00:00:00Z')
    const newTime = new Date('2025-06-15T12:00:00Z')
    utimesSync(oldFile, oldTime, oldTime)
    utimesSync(newFile, newTime, newTime)

    prepareSessionsForVm('/home/alice/myproject', piDir)

    const copiedOld = statSync(join(vmSessionDir, 'old-session.jsonl'))
    const copiedNew = statSync(join(vmSessionDir, 'new-session.jsonl'))
    assert.ok(
      copiedNew.mtimeMs > copiedOld.mtimeMs,
      `newer session mtime (${copiedNew.mtimeMs}) should be greater than older session mtime (${copiedOld.mtimeMs})`,
    )
  })

  it('is a no-op when host CWD is /workspace', () => {
    const { sessionsDir, vmSessionDir } = sessionPaths(piDir, '/workspace')
    mkdirSync(vmSessionDir, { recursive: true })

    prepareSessionsForVm('/workspace', piDir)

    assert.deepEqual(readdirSync(sessionsDir), ['--workspace--'])
  })

  it('is a no-op when --workspace-- already exists', () => {
    const { hostSessionDir, vmSessionDir } = sessionPaths(piDir, '/home/alice/myproject')
    mkdirSync(hostSessionDir, { recursive: true })
    mkdirSync(vmSessionDir, { recursive: true })
    writeFileSync(join(vmSessionDir, 'existing.json'), '"already-there"')

    prepareSessionsForVm('/home/alice/myproject', piDir)

    assert.ok(existsSync(join(vmSessionDir, 'existing.json')))
  })
})

describe('collectSessionsFromVm', () => {
  let piDir: string
  let cleanup: () => void

  beforeEach(() => {
    ({ piDir, cleanup } = makeTmpPiDir())
  })

  afterEach(() => cleanup())

  it('is a no-op when --workspace-- does not exist', () => {
    collectSessionsFromVm('/home/alice/myproject', piDir)
  })

  it('moves new session files to the host dir and removes --workspace--', () => {
    const { hostSessionDir, vmSessionDir } = sessionPaths(piDir, '/home/alice/myproject')
    mkdirSync(hostSessionDir, { recursive: true })
    writeFileSync(join(hostSessionDir, 'old-session.json'), '"old"')
    mkdirSync(vmSessionDir, { recursive: true })
    writeFileSync(join(vmSessionDir, 'old-session.json'), '"old"')
    writeFileSync(join(vmSessionDir, 'new-session.json'), '"new"')

    collectSessionsFromVm('/home/alice/myproject', piDir)

    assert.ok(!existsSync(vmSessionDir))
    assert.ok(existsSync(join(hostSessionDir, 'new-session.json')))
  })

  it('does not overwrite a host file when the VM copy is the same size', () => {
    const { hostSessionDir, vmSessionDir } = sessionPaths(piDir, '/home/alice/myproject')
    mkdirSync(hostSessionDir, { recursive: true })
    writeFileSync(join(hostSessionDir, 'existing.json'), '"same-content"')
    mkdirSync(vmSessionDir, { recursive: true })
    writeFileSync(join(vmSessionDir, 'existing.json'), '"same-content"')
    writeFileSync(join(vmSessionDir, 'new.json'), '"new"')

    collectSessionsFromVm('/home/alice/myproject', piDir)

    assert.equal(readFileSync(join(hostSessionDir, 'existing.json'), 'utf8'), '"same-content"')
    assert.ok(existsSync(join(hostSessionDir, 'new.json')))
  })

  it('overwrites a host file when the VM copy is larger (pi appended to it)', () => {
    const { hostSessionDir, vmSessionDir } = sessionPaths(piDir, '/home/alice/myproject')
    mkdirSync(hostSessionDir, { recursive: true })
    writeFileSync(join(hostSessionDir, 'session.jsonl'), 'original')
    mkdirSync(vmSessionDir, { recursive: true })
    writeFileSync(join(vmSessionDir, 'session.jsonl'), 'original\nappended turn')

    collectSessionsFromVm('/home/alice/myproject', piDir)

    assert.equal(readFileSync(join(hostSessionDir, 'session.jsonl'), 'utf8'), 'original\nappended turn')
    assert.ok(!existsSync(vmSessionDir))
  })

  it('cleans up a stale symlink left by a previous vmpi version', () => {
    const { hostSessionDir, vmSessionDir } = sessionPaths(piDir, '/home/alice/myproject')
    mkdirSync(hostSessionDir, { recursive: true })
    writeFileSync(join(hostSessionDir, 'session-1.json'), '{}')
    symlinkSync(hostSessionDir, vmSessionDir)
    assert.ok(lstatSync(vmSessionDir).isSymbolicLink())

    collectSessionsFromVm('/home/alice/myproject', piDir)

    assert.ok(!existsSync(vmSessionDir))
    assert.ok(existsSync(join(hostSessionDir, 'session-1.json')))
  })

  it('is a no-op when host CWD is /workspace', () => {
    const { vmSessionDir } = sessionPaths(piDir, '/workspace')
    mkdirSync(vmSessionDir, { recursive: true })

    collectSessionsFromVm('/workspace', piDir)

    assert.ok(existsSync(vmSessionDir))
  })

 it('writes session files to hostPiConfigDir when it differs from snapshotDir', () => {
   const { piDir: snapshotDir, cleanup: cleanupSnapshot } = makeTmpPiDir()
   try {
     const { vmSessionDir } = sessionPaths(snapshotDir, '/home/alice/myproject')
     const { hostSessionDir } = sessionPaths(piDir, '/home/alice/myproject')
     mkdirSync(vmSessionDir, { recursive: true })
     writeFileSync(join(vmSessionDir, 'new-session.json'), '"new"')

     collectSessionsFromVm('/home/alice/myproject', snapshotDir, piDir)

     assert.ok(!existsSync(vmSessionDir), '--workspace-- removed from snapshot')
     assert.ok(existsSync(join(hostSessionDir, 'new-session.json')), 'session written to real host config dir')
   } finally {
     cleanupSnapshot()
   }
 })
})
