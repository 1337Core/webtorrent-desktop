import { describe, expect, it } from 'vitest'
import {
  createClientOptions,
  createPeerId,
  WEBTORRENT_USER_AGENT
} from './client-config'

describe('WebTorrent client configuration', () => {
  it('creates a native 20-byte WebTorrent Updated peer id', () => {
    const first = createPeerId()
    const second = createPeerId()

    expect(first).toHaveLength(20)
    expect(new TextDecoder().decode(first)).toMatch(
      /^-WU0100-[A-Za-z0-9_-]{12}$/u
    )
    expect(second).not.toEqual(first)
  })

  it('keeps every implicit network service disabled for private torrents', () => {
    expect(createClientOptions('private')).toMatchObject({
      dht: false,
      lsd: false,
      natPmp: false,
      natUpnp: false,
      secure: 1,
      tracker: false,
      userAgent: WEBTORRENT_USER_AGENT,
      utPex: false,
      utp: false,
      webSeeds: false
    })
  })

  it('enables only receive-side PEX for the public profile', () => {
    const dht = { bootstrap: ['203.0.113.1:6881'] }
    expect(createClientOptions('public', { dht })).toMatchObject({
      dht,
      maxConns: 55,
      tracker: false,
      utPex: true,
      webSeeds: false
    })
  })

  it('bounds disposable staging clients and ignores DHT for private mode', () => {
    expect(createClientOptions('staging')).toMatchObject({
      dht: false,
      maxConns: 4,
      utPex: false
    })
    expect(
      createClientOptions('private', {
        dht: { bootstrap: ['203.0.113.1:6881'] }
      })
    ).toMatchObject({ dht: false })
  })
})
