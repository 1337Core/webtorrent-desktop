import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))

import type { Diagnostics } from './diagnostics'
import { PayloadTrash, PayloadTrashError } from './payload-trash'

let root = ''
let trashed: string[] = []
let trash: PayloadTrash

function diagnostics(): Diagnostics {
  return {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  } as unknown as Diagnostics
}

function createTrash(
  trashItem?: (target: string) => Promise<void>
): PayloadTrash {
  return new PayloadTrash({
    diagnostics: diagnostics(),
    trashItem:
      trashItem ??
      (target => {
        trashed.push(target)
        return Promise.resolve()
      })
  })
}

beforeEach(async () => {
  trashed = []
  root = await mkdtemp(path.join(tmpdir(), 'wu-trash-'))
  trash = createTrash()
  await mkdir(path.join(root, 'payload'), { recursive: true })
  await writeFile(path.join(root, 'payload', 'first.bin'), 'one')
  await writeFile(path.join(root, 'payload', 'second.bin'), 'two')
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

describe('PayloadTrash', () => {
  it('trashes every manifest file and reports the absent ones', async () => {
    const report = await trash.delete({
      files: ['payload/first.bin', 'payload/second.bin', 'payload/absent.bin'],
      root,
      torrentDirectory: null
    })

    expect(report.trashed).toEqual([
      path.join(root, 'payload', 'first.bin'),
      path.join(root, 'payload', 'second.bin')
    ])
    expect(report.missing).toEqual([path.join(root, 'payload', 'absent.bin')])
    expect(trashed).toHaveLength(2)
  })

  it('removes an emptied torrent-owned directory but never the root', async () => {
    const report = await trash.delete({
      files: ['payload/first.bin', 'payload/second.bin'],
      root,
      torrentDirectory: 'payload'
    })

    // The fake trash does not unlink, so the directory is still populated and
    // must not be removed.
    expect(report.trashed).not.toContain(path.join(root, 'payload'))

    await rm(path.join(root, 'payload'), { force: true, recursive: true })
    await mkdir(path.join(root, 'payload'))
    const emptied = await trash.delete({
      files: [],
      root,
      torrentDirectory: 'payload'
    })
    expect(emptied.trashed).toEqual([path.join(root, 'payload')])

    await expect(
      trash.delete({ files: [], root, torrentDirectory: '.' })
    ).rejects.toMatchObject({ code: 'UNSAFE_TARGET' })
  })

  it('refuses paths that escape the authorized root', async () => {
    for (const file of [
      '../escape.bin',
      '/etc/passwd',
      'payload/../../escape.bin',
      './payload/first.bin',
      ''
    ]) {
      await expect(
        trash.delete({ files: [file], root, torrentDirectory: null })
      ).rejects.toBeInstanceOf(PayloadTrashError)
    }
    expect(trashed).toEqual([])
  })

  it('refuses an unauthorized or denormalized root', async () => {
    for (const target of ['relative/path', `${root}/./payload`]) {
      await expect(
        trash.delete({ files: [], root: target, torrentDirectory: null })
      ).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' })
    }
  })

  it('trashes a symlink as a link and never follows it', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'wu-trash-outside-'))
    try {
      const target = path.join(outside, 'real.bin')
      await writeFile(target, 'untouched')
      await symlink(target, path.join(root, 'payload', 'link.bin'))

      const report = await trash.delete({
        files: ['payload/link.bin'],
        root,
        torrentDirectory: null
      })

      expect(report.trashed).toEqual([path.join(root, 'payload', 'link.bin')])
      expect(trashed).toEqual([path.join(root, 'payload', 'link.bin')])
    } finally {
      await rm(outside, { force: true, recursive: true })
    }
  })

  it('reports a failing trash operation as one fixed error', async () => {
    const failing = createTrash(() => Promise.reject(new Error('denied')))

    await expect(
      failing.delete({
        files: ['payload/first.bin'],
        root,
        torrentDirectory: null
      })
    ).rejects.toMatchObject({ code: 'TRASH_FAILED' })
  })

  it('leaves a populated torrent directory in place', async () => {
    const report = await trash.delete({
      files: [],
      root,
      torrentDirectory: 'payload'
    })

    expect(report.trashed).toEqual([])
  })
})
