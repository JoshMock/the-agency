import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { findHostTool, guestNpmCpu, guestPlatformTag, npmVersionSupportsLibc } from './host-tools.js'

describe('findHostTool', () => {
  it('finds an executable on PATH and returns its absolute path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vmpi-tool-'))
    try {
      const bin = join(dir, 'mytool')
      writeFileSync(bin, '#!/bin/sh\n')
      chmodSync(bin, 0o755)
      assert.equal(findHostTool('mytool', { platform: 'linux', pathEnv: dir }), bin)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns null when the tool is not found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vmpi-tool-'))
    try {
      assert.equal(findHostTool('nope', { platform: 'linux', pathEnv: dir }), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores non-executable files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vmpi-tool-'))
    try {
      const bin = join(dir, 'plainfile')
      writeFileSync(bin, 'data')
      chmodSync(bin, 0o644)
      assert.equal(findHostTool('plainfile', { platform: 'linux', pathEnv: dir }), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('searches later PATH entries when earlier ones lack the tool', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vmpi-tool-'))
    const dir = mkdtempSync(join(tmpdir(), 'vmpi-tool-'))
    try {
      const bin = join(dir, 'mytool')
      writeFileSync(bin, '#!/bin/sh\n')
      chmodSync(bin, 0o755)
      assert.equal(findHostTool('mytool', { platform: 'linux', pathEnv: [empty, dir].join(delimiter) }), bin)
    } finally {
      rmSync(empty, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('guestNpmCpu', () => {
  it('maps arm64 to arm64', () => {
    assert.equal(guestNpmCpu('arm64'), 'arm64')
  })

  it('maps x64 to x64', () => {
    assert.equal(guestNpmCpu('x64'), 'x64')
  })

  it('throws on an unsupported architecture', () => {
    assert.throws(() => guestNpmCpu('ia32'), /unsupported host architecture/)
  })
})

describe('guestPlatformTag', () => {
  it('composes the linux/cpu/musl tag', () => {
    assert.equal(guestPlatformTag('arm64'), 'linux-arm64-musl')
    assert.equal(guestPlatformTag('x64'), 'linux-x64-musl')
  })
})

describe('npmVersionSupportsLibc', () => {
  it('is true for npm >= 10.2', () => {
    assert.equal(npmVersionSupportsLibc('10.2.0'), true)
    assert.equal(npmVersionSupportsLibc('10.9.4'), true)
    assert.equal(npmVersionSupportsLibc('11.0.0'), true)
  })

  it('is false for npm < 10.2', () => {
    assert.equal(npmVersionSupportsLibc('10.1.5'), false)
    assert.equal(npmVersionSupportsLibc('9.9.9'), false)
    assert.equal(npmVersionSupportsLibc('0.0'), false)
  })
})
