import { describe, expect, it } from 'vitest'
import {
  filterIceCandidates,
  parseWssMessage,
  validateSdp,
  WssMessageError,
  WSS_MESSAGE_LIMITS
} from './wss-message'

const INFO_HASH = 'a'.repeat(20)
const PEER_ID = 'b'.repeat(20)
const OFFER_ID = 'c'.repeat(20)

function sdp(
  candidates: ReadonlyArray<string> = [
    'candidate:1 1 udp 1 93.184.216.34 6881 typ host'
  ]
): string {
  return [
    'v=0',
    'o=- 1 1 IN IP4 0.0.0.0',
    's=-',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    ...candidates.map(line => `a=${line}`)
  ].join('\r\n')
}

describe('parseWssMessage', () => {
  it('reads a bounded announce response', () => {
    const message = parseWssMessage(
      JSON.stringify({
        complete: 3,
        incomplete: 4,
        info_hash: INFO_HASH,
        interval: 120,
        'tracker id': 'abc',
        'warning message': 'slow'
      })
    )

    expect(message).toEqual({
      kind: 'announce',
      value: {
        complete: 3,
        failureReason: null,
        incomplete: 4,
        infoHash: INFO_HASH,
        interval: 120,
        trackerId: 'abc',
        warningMessage: 'slow'
      }
    })
  })

  it('reads an offer and an answer signal', () => {
    const offer = parseWssMessage(
      JSON.stringify({
        info_hash: INFO_HASH,
        offer: { sdp: sdp(), type: 'offer' },
        offer_id: OFFER_ID,
        peer_id: PEER_ID
      })
    )
    expect(offer).toMatchObject({
      kind: 'signal',
      value: { kind: 'offer', offerId: OFFER_ID, peerId: PEER_ID }
    })

    const answer = parseWssMessage(
      JSON.stringify({
        answer: { sdp: sdp(), type: 'answer' },
        info_hash: INFO_HASH,
        offer_id: OFFER_ID,
        peer_id: PEER_ID
      })
    )
    expect(answer).toMatchObject({ value: { kind: 'answer' } })
  })

  it('rejects oversized, unparseable, and non-object frames', () => {
    expect(() =>
      parseWssMessage('x'.repeat(WSS_MESSAGE_LIMITS.maxMessageBytes + 1))
    ).toThrow(expect.objectContaining({ code: 'MESSAGE_TOO_LARGE' }) as Error)
    expect(() => parseWssMessage('{')).toThrow(
      expect.objectContaining({ code: 'UNPARSEABLE' }) as Error
    )
    expect(() => parseWssMessage('[]')).toThrow(
      expect.objectContaining({ code: 'NOT_AN_OBJECT' }) as Error
    )
    expect(() => parseWssMessage('"text"')).toThrow(
      expect.objectContaining({ code: 'NOT_AN_OBJECT' }) as Error
    )
  })

  it('rejects unknown keys and oversized text fields', () => {
    expect(() =>
      parseWssMessage(JSON.stringify({ info_hash: INFO_HASH, surprise: 1 }))
    ).toThrow(expect.objectContaining({ code: 'FIELD_INVALID' }) as Error)
    expect(() =>
      parseWssMessage(
        JSON.stringify({
          'failure reason': 'x'.repeat(WSS_MESSAGE_LIMITS.maxFailureBytes + 1),
          info_hash: INFO_HASH
        })
      )
    ).toThrow(WssMessageError)
    expect(() =>
      parseWssMessage(
        JSON.stringify({
          info_hash: INFO_HASH,
          'tracker id': 'x'.repeat(WSS_MESSAGE_LIMITS.maxTrackerIdBytes + 1)
        })
      )
    ).toThrow(WssMessageError)
    expect(() =>
      parseWssMessage(
        JSON.stringify({ action: 'scrape', info_hash: INFO_HASH })
      )
    ).toThrow(WssMessageError)
  })

  it('requires exact twenty-byte binary identities', () => {
    expect(() =>
      parseWssMessage(JSON.stringify({ info_hash: 'short' }))
    ).toThrow(WssMessageError)
    expect(() =>
      parseWssMessage(JSON.stringify({ info_hash: '☃'.repeat(20) }))
    ).toThrow(WssMessageError)
    expect(() =>
      parseWssMessage(
        JSON.stringify({
          info_hash: INFO_HASH,
          offer: { sdp: sdp(), type: 'offer' },
          offer_id: 'short',
          peer_id: PEER_ID
        })
      )
    ).toThrow(WssMessageError)
  })

  it('rejects a malformed session description envelope', () => {
    for (const envelope of [
      { sdp: sdp() },
      { extra: 1, sdp: sdp(), type: 'offer' },
      { sdp: sdp(), type: 'answer' },
      'not-an-object'
    ]) {
      expect(() =>
        parseWssMessage(
          JSON.stringify({
            info_hash: INFO_HASH,
            offer: envelope,
            offer_id: OFFER_ID,
            peer_id: PEER_ID
          })
        )
      ).toThrow(expect.objectContaining({ code: 'SDP_INVALID' }) as Error)
    }
  })
})

describe('validateSdp', () => {
  it('accepts exactly one data-channel application section', () => {
    expect(validateSdp(sdp())).toContain('m=application')
  })

  it('rejects audio, video, missing, and duplicated sections', () => {
    expect(() =>
      validateSdp(sdp().replace('m=application', 'm=audio'))
    ).toThrow(WssMessageError)
    expect(() =>
      validateSdp(`${sdp()}\r\nm=video 9 UDP/TLS/RTP/SAVPF 96`)
    ).toThrow(WssMessageError)
    expect(() => validateSdp('v=0\r\ns=-')).toThrow(WssMessageError)
    expect(() =>
      validateSdp(
        `${sdp()}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel`
      )
    ).toThrow(WssMessageError)
  })

  it('rejects oversized descriptions, lines, and candidate counts', () => {
    expect(() =>
      validateSdp('x'.repeat(WSS_MESSAGE_LIMITS.maxSdpBytes + 1))
    ).toThrow(WssMessageError)
    expect(() =>
      validateSdp(
        `${sdp()}\r\n${'x'.repeat(WSS_MESSAGE_LIMITS.maxSdpLineBytes + 1)}`
      )
    ).toThrow(WssMessageError)
    expect(() =>
      validateSdp(
        sdp(
          Array.from(
            { length: WSS_MESSAGE_LIMITS.maxCandidates + 1 },
            (_value, index) =>
              `candidate:${index} 1 udp 1 93.184.216.34 ${6881 + index} typ host`
          )
        )
      )
    ).toThrow(WssMessageError)
  })
})

describe('filterIceCandidates', () => {
  it('keeps public IPv4 candidates and drops everything else', () => {
    const filtered = filterIceCandidates(
      sdp([
        'candidate:1 1 udp 1 93.184.216.34 6881 typ host',
        'candidate:2 1 udp 1 2001:db8::1 6881 typ host',
        'candidate:3 1 udp 1 fe80::1 6881 typ host',
        'candidate:4 1 udp 1 127.0.0.1 6881 typ host',
        'candidate:5 1 udp 1 100.64.0.1 6881 typ host',
        'candidate:6 1 udp 1 abcdef01-2345.local 6881 typ host',
        'candidate:7 1 udp 1 10.0.0.7 6881 typ host'
      ]),
      { allowPrivateNetwork: false }
    )

    expect(filtered).toContain('93.184.216.34')
    for (const removed of [
      '2001:db8::1',
      'fe80::1',
      'candidate:4',
      '100.64.0.1',
      '.local',
      '10.0.0.7'
    ]) {
      expect(filtered).not.toContain(removed)
    }
  })

  it('admits RFC 1918 candidates only with the torrent grant', () => {
    const candidates = sdp(['candidate:1 1 udp 1 192.168.1.9 6881 typ host'])

    expect(() =>
      filterIceCandidates(candidates, { allowPrivateNetwork: false })
    ).toThrow(expect.objectContaining({ code: 'NO_USABLE_CANDIDATE' }) as Error)
    expect(
      filterIceCandidates(candidates, { allowPrivateNetwork: true })
    ).toContain('192.168.1.9')
  })

  it('always removes remote-candidates lines', () => {
    const filtered = filterIceCandidates(
      `${sdp()}\r\na=remote-candidates:1 10.0.0.1 6881`,
      { allowPrivateNetwork: true }
    )
    expect(filtered).not.toContain('remote-candidates')
  })
})
