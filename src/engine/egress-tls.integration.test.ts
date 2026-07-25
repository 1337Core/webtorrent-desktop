import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EgressPolicy } from './network-policy'

/**
 * Real-TLS proof for the shared egress path every mediated transport uses.
 *
 * The certificate authority is generated for this run and trusted only inside
 * this process, so nothing about the production trust store changes and no key
 * material lives in the repository. The server runs on loopback while the
 * policy is told the hostname resolves there, which is exactly the shape the
 * plan authorizes for an integration fixture: it can reach the one ephemeral
 * endpoint this test created and nothing else.
 */
const HOSTNAME = 'tracker.test'
const OTHER_HOSTNAME = 'other.test'

let fixtureRoot = ''
let originalCertificates: ReadonlyArray<string> = []
let servers: Server[] = []

type Identity = { certificate: string; key: string }

function openssl(args: ReadonlyArray<string>): void {
  execFileSync('openssl', [...args], { stdio: 'pipe' })
}

/** One throwaway authority and the leaf certificates it signs. */
async function createIdentities(): Promise<{
  authority: string
  other: Identity
  wanted: Identity
}> {
  const at = (name: string): string => path.join(fixtureRoot, name)
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    at('ca.key'),
    '-out',
    at('ca.crt'),
    '-days',
    '1',
    '-subj',
    '/CN=WebTorrent Updated Test CA'
  ])

  const leaf = async (hostname: string, prefix: string): Promise<Identity> => {
    await writeFile(at(`${prefix}.ext`), `subjectAltName=DNS:${hostname}\n`)
    openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      at(`${prefix}.key`),
      '-out',
      at(`${prefix}.csr`),
      '-subj',
      `/CN=${hostname}`
    ])
    openssl([
      'x509',
      '-req',
      '-in',
      at(`${prefix}.csr`),
      '-CA',
      at('ca.crt'),
      '-CAkey',
      at('ca.key'),
      '-CAcreateserial',
      '-out',
      at(`${prefix}.crt`),
      '-days',
      '1',
      '-extfile',
      at(`${prefix}.ext`)
    ])
    return {
      certificate: await readFile(at(`${prefix}.crt`), 'utf8'),
      key: await readFile(at(`${prefix}.key`), 'utf8')
    }
  }

  return {
    authority: await readFile(at('ca.crt'), 'utf8'),
    other: await leaf(OTHER_HOSTNAME, 'other'),
    wanted: await leaf(HOSTNAME, 'wanted')
  }
}

async function listen(identity: Identity): Promise<number> {
  const server = createServer(
    { cert: identity.certificate, key: identity.key },
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-bittorrent' })
      response.end('d4:infod6:lengthi0eee')
    }
  )
  servers.push(server)
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (typeof address === 'string' || address === null) {
    throw new Error('The fixture server never bound a port')
  }
  return address.port
}

let identities: Awaited<ReturnType<typeof createIdentities>>

beforeAll(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'webtorrent-updated-tls-'))
  identities = await createIdentities()
  originalCertificates = tls.getCACertificates()
  // Trusted for this process only; the production trust store is untouched.
  tls.setDefaultCACertificates([...originalCertificates, identities.authority])
}, 60_000)

afterAll(async () => {
  if (originalCertificates.length > 0) {
    tls.setDefaultCACertificates([...originalCertificates])
  }
  if (fixtureRoot) await rm(fixtureRoot, { force: true, recursive: true })
})

afterEach(async () => {
  await Promise.all(
    servers.map(
      server =>
        new Promise<void>(resolve => {
          server.close(() => resolve())
        })
    )
  )
  servers = []
})

function policyFor(): EgressPolicy {
  return new EgressPolicy({
    dnsLookup: async hostname => {
      expect(hostname).toBe(HOSTNAME)
      return [{ address: '127.0.0.1', family: 4 }]
    },
    testOnlyAllowLoopback: true
  })
}

describe('egress TLS', () => {
  it('verifies the original host while the socket is pinned to an address', async () => {
    const port = await listen(identities.wanted)

    const result = await policyFor().fetchRemoteTorrentBytes(
      `https://${HOSTNAME}:${port}/torrent`,
      { allowHttp: false }
    )

    // The connection went to 127.0.0.1 but presented and verified the
    // certificate for the name the user asked for.
    expect(result.finalUrl).toBe(`https://${HOSTNAME}:${port}/torrent`)
    expect(new TextDecoder().decode(result.bytes)).toContain('length')
  })

  it('rejects a certificate issued for a different host', async () => {
    const port = await listen(identities.other)

    await expect(
      policyFor().fetchRemoteTorrentBytes(
        `https://${HOSTNAME}:${port}/torrent`,
        { allowHttp: false }
      )
    ).rejects.toMatchObject({ code: 'REQUEST_FAILED' })
  })

  it('rejects a certificate the fixture authority never signed', async () => {
    const at = path.join(fixtureRoot, 'rogue')
    await writeFile(`${at}.ext`, `subjectAltName=DNS:${HOSTNAME}\n`)
    openssl([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${at}.key`,
      '-out',
      `${at}.crt`,
      '-days',
      '1',
      '-subj',
      `/CN=${HOSTNAME}`,
      '-addext',
      `subjectAltName=DNS:${HOSTNAME}`
    ])
    const port = await listen({
      certificate: await readFile(`${at}.crt`, 'utf8'),
      key: await readFile(`${at}.key`, 'utf8')
    })

    // Right hostname, untrusted issuer: the name alone never satisfies the
    // policy.
    await expect(
      policyFor().fetchRemoteTorrentBytes(
        `https://${HOSTNAME}:${port}/torrent`,
        { allowHttp: false }
      )
    ).rejects.toMatchObject({ code: 'REQUEST_FAILED' })
  })
})
