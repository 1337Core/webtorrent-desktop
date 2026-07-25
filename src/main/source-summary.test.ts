import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { measureSource } from './source-summary'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'source-summary-'))
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

describe('measureSource', () => {
  it('measures a single chosen file', async () => {
    const file = path.join(root, 'clip.mp4')
    await writeFile(file, Buffer.alloc(64))

    expect(await measureSource(file)).toEqual({
      fileCount: 1,
      totalBytes: 64
    })
  })

  it('walks a directory the way creation will, skipping dotfiles', async () => {
    await mkdir(path.join(root, 'season'), { recursive: true })
    await writeFile(path.join(root, 'season', 'one.mp4'), Buffer.alloc(10))
    await writeFile(path.join(root, 'season', 'two.mp4'), Buffer.alloc(20))
    await writeFile(path.join(root, '.DS_Store'), Buffer.alloc(4_096))
    await mkdir(path.join(root, '.hidden'), { recursive: true })
    await writeFile(path.join(root, '.hidden', 'nope.bin'), Buffer.alloc(99))

    expect(await measureSource(root)).toEqual({
      fileCount: 2,
      totalBytes: 30
    })
  })

  it('never follows a symlink into another tree', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'source-summary-out-'))
    await writeFile(path.join(outside, 'big.bin'), Buffer.alloc(1_000))
    await writeFile(path.join(root, 'small.bin'), Buffer.alloc(5))
    await symlink(outside, path.join(root, 'link'))

    try {
      expect(await measureSource(root)).toEqual({
        fileCount: 1,
        totalBytes: 5
      })
      expect(await measureSource(path.join(root, 'link'))).toBeNull()
    } finally {
      await rm(outside, { force: true, recursive: true })
    }
  })

  it('reports nothing for a path that cannot be measured', async () => {
    expect(await measureSource(path.join(root, 'missing'))).toBeNull()
  })
})
