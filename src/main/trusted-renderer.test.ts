import { describe, expect, it } from 'vitest'
import { isTrustedApplicationUrl } from './trusted-renderer'

describe('isTrustedApplicationUrl', () => {
  it('accepts only the exact application document and optional hash', () => {
    expect(isTrustedApplicationUrl('app://bundle/index.html')).toBe(true)
    expect(isTrustedApplicationUrl('app://bundle/index.html#settings')).toBe(
      true
    )
  })

  it.each([
    'app://bundle/',
    'app://bundle/other.html',
    'app://bundle/index.html?next=https://example.com',
    'app://bundle.evil/index.html',
    'app://user@bundle/index.html',
    'file:///index.html',
    'https://bundle/index.html',
    'not a url'
  ])('rejects deceptive or non-application URL %s', url => {
    expect(isTrustedApplicationUrl(url)).toBe(false)
  })
})
