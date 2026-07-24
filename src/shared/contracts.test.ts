import { describe, expect, it } from 'vitest'
import { isEngineStatus } from './contracts'

describe('isEngineStatus', () => {
  it('accepts every supported engine state', () => {
    expect(isEngineStatus({ state: 'starting' })).toBe(true)
    expect(
      isEngineStatus({
        state: 'ready',
        architecture: 'arm64',
        electronVersion: '43.2.0',
        nodeVersion: '24.18.0',
        processType: 'utility',
        utpEnabled: false,
        webRtcSupported: true,
        webTorrentVersion: '3.0.16'
      })
    ).toBe(true)
    expect(isEngineStatus({ state: 'failed', message: 'unavailable' })).toBe(
      true
    )
  })

  it('rejects malformed messages', () => {
    expect(isEngineStatus(null)).toBe(false)
    expect(isEngineStatus({ state: 'ready' })).toBe(false)
    expect(isEngineStatus({ state: 'failed', message: 42 })).toBe(false)
    expect(isEngineStatus({ state: 'unknown' })).toBe(false)
  })
})
