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
})
