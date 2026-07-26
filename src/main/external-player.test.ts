import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Diagnostics } from './diagnostics'
import { ExternalPlayer, ExternalPlayerError } from './external-player'

const MEDIA_PORT = 52_000
const TOKEN = 'a'.repeat(43)
const MEDIA_URL = `http://127.0.0.1:${MEDIA_PORT}/v1/media/${TOKEN}`

let root = ''
let playerPath = ''
let launches: Array<{ args: ReadonlyArray<string>; file: string }> = []

function diagnostics(): Diagnostics {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
}

function createPlayer(
  options: { launch?: () => void; mediaPort?: number | null } = {}
): ExternalPlayer {
  return new ExternalPlayer({
    diagnostics: diagnostics(),
    getMediaPort: () =>
      options.mediaPort === undefined ? MEDIA_PORT : options.mediaPort,
    launch:
      options.launch ??
      ((file, args) => {
        launches.push({ args, file })
      })
  })
}

beforeEach(async () => {
  launches = []
  root = await mkdtemp(path.join(tmpdir(), 'wu-player-'))
  playerPath = path.join(root, 'player')
  await writeFile(playerPath, '#!/bin/sh\n')
  await chmod(playerPath, 0o700)
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

describe('ExternalPlayer', () => {
  it('launches the chosen player with the media URL as one argument', async () => {
    await createPlayer().open({ mediaUrl: MEDIA_URL, playerPath })

    expect(launches).toEqual([{ args: [MEDIA_URL], file: playerPath }])
  })

  it('refuses a URL that is not an engine media route', async () => {
    const player = createPlayer()

    for (const mediaUrl of [
      'https://example.com/movie.mp4',
      `http://127.0.0.1:${MEDIA_PORT}/v1/media/`,
      `http://127.0.0.1:${MEDIA_PORT}/v1/media/${TOKEN}?x=1`,
      `http://127.0.0.1:${MEDIA_PORT}/../etc/passwd`,
      `http://localhost:${MEDIA_PORT}/v1/media/${TOKEN}`,
      `http://127.0.0.1:${MEDIA_PORT + 1}/v1/media/${TOKEN}`,
      `http://user:pass@127.0.0.1:${MEDIA_PORT}/v1/media/${TOKEN}`,
      'not-a-url'
    ]) {
      await expect(player.open({ mediaUrl, playerPath })).rejects.toMatchObject(
        { code: 'URL_NOT_AUTHORIZED' }
      )
    }
    expect(launches).toEqual([])
  })

  it('refuses any URL while the engine reports no media port', async () => {
    await expect(
      createPlayer({ mediaPort: null }).open({
        mediaUrl: MEDIA_URL,
        playerPath
      })
    ).rejects.toMatchObject({ code: 'URL_NOT_AUTHORIZED' })
  })

  it('refuses a relative, absent, symlinked, or unexecutable player', async () => {
    const player = createPlayer()
    const notExecutable = path.join(root, 'plain.txt')
    await writeFile(notExecutable, 'text')
    const linked = path.join(root, 'linked')
    await symlink(playerPath, linked)

    for (const candidate of [
      'player',
      `${root}/./player`,
      path.join(root, 'absent'),
      notExecutable,
      linked
    ]) {
      await expect(
        player.open({ mediaUrl: MEDIA_URL, playerPath: candidate })
      ).rejects.toBeInstanceOf(ExternalPlayerError)
    }
    expect(launches).toEqual([])
  })

  it('reports a failing launch as one fixed error', async () => {
    const failing = createPlayer({
      launch: () => {
        throw new Error('spawn failed')
      }
    })

    await expect(
      failing.open({ mediaUrl: MEDIA_URL, playerPath })
    ).rejects.toMatchObject({ code: 'LAUNCH_FAILED' })
  })
})

describe('macOS application bundles', () => {
  /** A bundle shaped the way the open panel returns one. */
  async function createBundle(
    name: string,
    options: Readonly<{
      executableName?: string
      declared?: string | null
    }> = {}
  ): Promise<string> {
    const bundlePath = path.join(root, `${name}.app`)
    await mkdir(path.join(bundlePath, 'Contents', 'MacOS'), {
      recursive: true
    })
    const declared = options.declared === undefined ? name : options.declared
    if (declared !== null) {
      await writeFile(
        path.join(bundlePath, 'Contents', 'Info.plist'),
        `<plist><dict><key>CFBundleExecutable</key><string>${declared}</string></dict></plist>`
      )
    }
    const executable = path.join(
      bundlePath,
      'Contents',
      'MacOS',
      options.executableName ?? name
    )
    await writeFile(executable, '#!/bin/sh\n')
    await chmod(executable, 0o700)
    return bundlePath
  }

  it('launches the executable a chosen bundle declares', async () => {
    const bundlePath = await createBundle('Player')

    await createPlayer().open({ mediaUrl: MEDIA_URL, playerPath: bundlePath })

    expect(launches).toEqual([
      {
        args: [MEDIA_URL],
        file: path.join(bundlePath, 'Contents', 'MacOS', 'Player')
      }
    ])
  })

  it('falls back to the bundle name when no executable is declared', async () => {
    const bundlePath = await createBundle('Fallback', { declared: null })

    await createPlayer().open({ mediaUrl: MEDIA_URL, playerPath: bundlePath })

    expect(launches[0]?.file).toBe(
      path.join(bundlePath, 'Contents', 'MacOS', 'Fallback')
    )
  })

  it('refuses a declared executable that leaves the bundle', async () => {
    const bundlePath = await createBundle('Escape', {
      declared: '../../../../usr/bin/env',
      executableName: 'Escape'
    })

    await expect(
      createPlayer().open({ mediaUrl: MEDIA_URL, playerPath: bundlePath })
    ).rejects.toMatchObject({ code: 'PLAYER_NOT_AUTHORIZED' })
    expect(launches).toEqual([])
  })

  it('refuses a bundle whose declared executable is missing', async () => {
    const bundlePath = await createBundle('Missing', {
      executableName: 'Other'
    })

    await expect(
      createPlayer().open({ mediaUrl: MEDIA_URL, playerPath: bundlePath })
    ).rejects.toBeInstanceOf(ExternalPlayerError)
    expect(launches).toEqual([])
  })
})
