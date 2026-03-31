import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'

import { cwdToSessionDirName, sessionDirNameToCwd } from './sessions.ts'

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
      cwdToSessionDirName('/home/alice/Code/the-agency/packages/agent-vm'),
      '--home-alice-Code-the-agency-packages-agent-vm--',
    )
  })
})

describe('sessionDirNameToCwd', () => {
  // sessionDirNameToCwd replaces all `-` with `/`, so it is only unambiguous
  // for paths whose segments contain no literal `-` characters. Its primary
  // use in vmpi is decoding `--workspace--` → `/workspace`.

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

describe('cwdToSessionDirName for /workspace round-trip', () => {
  it('encodes /workspace and decodes back', () => {
    const encoded = cwdToSessionDirName('/workspace')
    assert.equal(sessionDirNameToCwd(encoded), '/workspace')
  })
})
