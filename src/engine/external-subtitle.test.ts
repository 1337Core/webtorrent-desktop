import {
  lstat,
  mkdtemp,
  mkdir,
  realpath,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ExternalSubtitleError,
  readExternalSubtitle
} from './external-subtitle'
import { SUBTITLE_LIMITS } from './subtitles'
import type { ExternalSubtitleGrant } from '../shared/engine-api'

const roots: string[] = []

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'external-subtitle-'))
  roots.push(directory)
  return directory
}

async function captureGrant(filePath: string): Promise<ExternalSubtitleGrant> {
  const canonicalPath = await realpath(filePath)
  const file = await lstat(canonicalPath, { bigint: true })
  const parentPaths: string[] = []
  const filesystemRoot = path.parse(canonicalPath).root
  let current = path.dirname(canonicalPath)
  while (current !== filesystemRoot) {
    parentPaths.push(current)
    current = path.dirname(current)
  }
  parentPaths.reverse()
  return {
    canonicalPath,
    file: {
      device: file.dev.toString(),
      inode: file.ino.toString(),
      modifiedNs: file.mtimeNs.toString(),
      size: file.size.toString()
    },
    parentChain: await Promise.all(
      parentPaths.map(async parentPath => {
        const parent = await lstat(parentPath, { bigint: true })
        return {
          device: parent.dev.toString(),
          inode: parent.ino.toString(),
          path: parentPath
        }
      })
    )
  }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(
    roots.splice(0).map(directory =>
      rm(directory, {
        force: true,
        recursive: true
      })
    )
  )
})

describe('readExternalSubtitle', () => {
  it('reads one selected SRT without exposing its path in the track', async () => {
    const directory = await root()
    const subtitlePath = path.join(directory, 'captions.SRT')
    await writeFile(
      subtitlePath,
      '1\n00:00:01,000 --> 00:00:02,000\nHello there.\n'
    )

    const track = await readExternalSubtitle(
      subtitlePath,
      await captureGrant(subtitlePath)
    )

    expect(track.vtt).toContain('Hello there.')
    expect(track.label.length).toBeGreaterThan(0)
    expect(JSON.stringify(track)).not.toContain(subtitlePath)
  })

  it('rejects unsupported paths and unauthorized directories', async () => {
    const directory = await root()
    const textPath = path.join(directory, 'captions.txt')
    const srtPath = path.join(directory, 'captions.srt')
    const linkedPath = path.join(directory, 'linked.srt')
    const nested = path.join(directory, 'nested.srt')
    await writeFile(textPath, 'not a subtitle')
    await writeFile(srtPath, '1\n00:00:00,000 --> 00:00:01,000\nHello\n')
    await symlink(srtPath, linkedPath)
    await mkdir(nested)

    await expect(
      readExternalSubtitle(textPath, await captureGrant(textPath))
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED'
    })
    await expect(
      readExternalSubtitle(nested, await captureGrant(srtPath))
    ).rejects.toBeInstanceOf(ExternalSubtitleError)
  })

  it('rejects a chooser grant after an ancestor symlink is swapped', async () => {
    const directory = await root()
    const first = path.join(directory, 'first')
    const second = path.join(directory, 'second')
    const selectedParent = path.join(directory, 'selected')
    await mkdir(first)
    await mkdir(second)
    await writeFile(
      path.join(first, 'captions.srt'),
      '1\n00:00:00,000 --> 00:00:01,000\nFirst\n'
    )
    await writeFile(
      path.join(second, 'captions.srt'),
      '1\n00:00:00,000 --> 00:00:01,000\nSecond\n'
    )
    await symlink(first, selectedParent)
    const selectedPath = path.join(selectedParent, 'captions.srt')
    const grant = await captureGrant(selectedPath)

    await unlink(selectedParent)
    await symlink(second, selectedParent)

    await expect(
      readExternalSubtitle(selectedPath, grant)
    ).rejects.toBeInstanceOf(ExternalSubtitleError)
    await expect(
      readExternalSubtitle(selectedPath, grant)
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE'
    })
  })

  it('enforces the source byte ceiling before parsing', async () => {
    const directory = await root()
    const subtitlePath = path.join(directory, 'huge.srt')
    await writeFile(
      subtitlePath,
      new Uint8Array(SUBTITLE_LIMITS.maxSourceBytes + 1)
    )

    await expect(
      readExternalSubtitle(subtitlePath, await captureGrant(subtitlePath))
    ).rejects.toMatchObject({ code: 'TOO_LARGE' })
  })
})
