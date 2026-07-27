import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureExternalSubtitleGrant } from './subtitle-file-grant'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(directory => rm(directory, { force: true, recursive: true }))
  )
})

describe('captureExternalSubtitleGrant', () => {
  it('captures a regular file and its complete canonical parent chain', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'subtitle-grant-'))
    roots.push(directory)
    const filePath = path.join(directory, 'captions.srt')
    await writeFile(filePath, 'caption')

    const grant = await captureExternalSubtitleGrant(filePath)

    expect(grant.file.size).toBe('7')
    expect(grant.parentChain.at(-1)?.path).toBe(
      path.dirname(grant.canonicalPath)
    )
  })

  it('rejects final symlinks and directories', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'subtitle-grant-'))
    roots.push(directory)
    const filePath = path.join(directory, 'captions.srt')
    const linkedPath = path.join(directory, 'linked.srt')
    const nestedPath = path.join(directory, 'nested')
    await writeFile(filePath, 'caption')
    await symlink(filePath, linkedPath)
    await mkdir(nestedPath)

    await expect(
      captureExternalSubtitleGrant(linkedPath)
    ).rejects.toBeInstanceOf(Error)
    await expect(
      captureExternalSubtitleGrant(nestedPath)
    ).rejects.toBeInstanceOf(Error)
  })
})
