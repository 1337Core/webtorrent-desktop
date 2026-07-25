import { describe, expect, it, vi } from 'vitest'
import {
  DANGEROUS_LAUNCH_SWITCHES,
  findDangerousLaunchSwitch
} from './launch-policy'

describe('findDangerousLaunchSwitch', () => {
  it.each(DANGEROUS_LAUNCH_SWITCHES)(
    'rejects Chromium parsed switch %s regardless of raw spelling',
    switchName => {
      const hasSwitch = vi.fn((name: string) => name === switchName)

      expect(findDangerousLaunchSwitch({ hasSwitch })).toBe(switchName)
    }
  )

  it('allows an ordinary command line', () => {
    expect(findDangerousLaunchSwitch({ hasSwitch: () => false })).toBeNull()
  })

  it('permits remote debugging only in the automation build', () => {
    const debugging = {
      hasSwitch: (name: string) => name === 'remote-debugging-port'
    }
    const unsafe = { hasSwitch: (name: string) => name === 'no-sandbox' }

    expect(findDangerousLaunchSwitch(debugging)).toBe('remote-debugging-port')
    expect(
      findDangerousLaunchSwitch(debugging, { automationBuild: true })
    ).toBeNull()
    // Automation never relaxes anything else.
    expect(findDangerousLaunchSwitch(unsafe, { automationBuild: true })).toBe(
      'no-sandbox'
    )
  })
})
