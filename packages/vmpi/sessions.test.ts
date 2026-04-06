import { describe, it, beforeEach, afterEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  cwdToSessionDirName,
  sessionDirNameToCwd,
  prepareSessionsForVm,
  collectSessionsFromVm,
} from './sessions.ts'

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
  let tmpPiDir: string

  beforeEach(() => {
    tmpPiDir = join(tmpdir(), `vmpi-sessions-test-${Date.now()}`)
    mkdirSync(tmpPiDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpPiDir, { recursive: true, force: true })
  })

  it('is a no-op when no host session dir exists', () => {
    prepareSessionsForVm('/home/alice/myproject', tmpPiDir)
    const sessionsDir = join(tmpPiDir, 'agent', 'sessions')
    assert.ok(!existsSync(sessionsDir) || readdirSync(sessionsDir).length === 0)
  })

  it('copies the host CWD session dir to --workspace--', () => {
    const hostDirName = cwdToSessionDirName('/home/alice/myproject')
    const sessionsDir = join(tmpPiDir, 'agent', 'sessions')
    const hostSessionDir = join(sessionsDir, hostDirName)
    mkdirSync(hostSessionDir, { recursive: true })
    writeFileSync(join(hostSessionDir, 'session-1.json'), '{}')

    prepareSessionsForVm('/home/alice/myproject', tmpPiDir)

    const vmSessionDir = join(sessionsDir, '--workspace--')
    assert.ok(existsSync(vmSessionDir), '--workspace-- should exist after prepare')
    assert.ok(!lstatSync(vmSessionDir).isSymbolicLink(), '--workspace-- should be a real directory')
    assert.ok(existsSync(join(vmSessionDir, 'session-1.json')), 'session file should be copied')
  })

  it('is a no-op when host CWD is /workspace', () => {
    const sessionsDir = join(tmpPiDir, 'agent', 'sessions')
    mkdirSync(join(sessionsDir, '--workspace--'), { recursive: true })

    prepareSessionsForVm('/workspace', tmpPiDir)

    const entries = readdirSync(sessionsDir)
    assert.deepEqual(entries, ['--workspace--'])
  })

  it('is a no-op when --workspace-- already exists', () => {
    const hostDirName = cwdToSessionDirName('/home/alice/myproject')
    const sessionsDir = join(tmpPiDir, 'agent', 'sessions')
    const hostSessionDir = join(sessionsDir, hostDirName)
    const vmSessionDir = join(sessionsDir, '--workspace--')
    mkdirSync(hostSessionDir, { recursive: true })
    mkdirSync(vmSessionDir, { recursive: true })
    writeFileSync(join(vmSessionDir, 'existing.json'), '"already-there"')

    prepareSessionsForVm('/home/alice/myproject', tmpPiDir)

    assert.ok(existsSync(join(vmSessionDir, 'existing.json')))
  })
})

describe('collectSessionsFromVm', () => {
  let tmpPiDir: string

  beforeEach(() => {
    tmpPiDir = join(tmpdir(), `vmpi-sessions-test-${Date.now()}`)
    mkdirSync(tmpPiDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpPiDir, { recursive: true, force: true })
  })

  it('is a no-op when --workspace-- does not exist', () => {
    collectSessionsFromVm('/home/alice/myproject', tmpPiDir)
  })

  it('merges --workspace-- back into the host CWD session dir and removes it', () => {
    const hostDirName = cwdToSessionDirName('/home/alice/myproject')
    const sessionsDir = join(tmpPiDir, 'agent', 'sessions')
    const hostSessionDir = join(sessionsDir, hostDirName)
    const vmSessionDir = join(sessionsDir, '--workspace--')

    // simulate: prepare copied sessions, VM wrote a new session
    mkdirSync(hostSessionDir, { recursive: true })
    writeFileSync(join(hostSessionDir, 'old-session.json'), '"old"')
    mkdirSync(vmSessionDir, { recursive: true })
    writeFileSync(join(vmSessionDir, 'old-session.json'), '"old"')
    writeFileSync(join(vmSessionDir, 'new-session.json'), '"new"')

    collectSessionsFromVm('/home/alice/myproject', tmpPiDir)

    assert.ok(!existsSync(vmSessionDir), '--workspace-- should be removed after collect')
    assert.ok(existsSync(join(hostSessionDir, 'new-session.json')), 'new session should be moved to host dir')
  })

  it('does not overwrite existing files when merging', () => {
    const hostDirName = cwdToSessionDirName('/home/alice/myproject')
    const sessionsDir = join(tmpPiDir, 'agent', 'sessions')
    const hostSessionDir = join(sessionsDir, hostDirName)
    const vmSessionDir = join(sessionsDir, '--workspace--')

    mkdirSync(hostSessionDir, { recursive: true })
    writeFileSync(join(hostSessionDir, 'existing.json'), '"original"')
    mkdirSync(vmSessionDir, { recursive: true })
    writeFileSync(join(vmSessionDir, 'existing.json'), '"vm-version"')
    writeFileSync(join(vmSessionDir, 'new.json'), '"new"')

    collectSessionsFromVm('/home/alice/myproject', tmpPiDir)

    assert.equal(readFileSync(join(hostSessionDir, 'existing.json'), 'utf8'), '"original"')
    assert.ok(existsSync(join(hostSessionDir, 'new.json')))
  })

  it('cleans up a stale symlink left by a previous vmpi version', () => {
    const hostDirName = cwdToSessionDirName('/home/alice/myproject')
    const sessionsDir = join(tmpPiDir, 'agent', 'sessions')
    const hostSessionDir = join(sessionsDir, hostDirName)
    const vmSessionDir = join(sessionsDir, '--workspace--')
    mkdirSync(hostSessionDir, { recursive: true })
    writeFileSync(join(hostSessionDir, 'session-1.json'), '{}')
    symlinkSync(hostSessionDir, vmSessionDir)
    assert.ok(lstatSync(vmSessionDir).isSymbolicLink())

    collectSessionsFromVm('/home/alice/myproject', tmpPiDir)

    assert.ok(!existsSync(vmSessionDir), 'stale symlink should be removed')
    assert.ok(existsSync(join(hostSessionDir, 'session-1.json')), 'host dir should be untouched')
  })

  it('is a no-op when host CWD is /workspace', () => {
    const sessionsDir = join(tmpPiDir, 'agent', 'sessions')
    mkdirSync(join(sessionsDir, '--workspace--'), { recursive: true })

    collectSessionsFromVm('/workspace', tmpPiDir)

    assert.ok(existsSync(join(sessionsDir, '--workspace--')))
  })
})
