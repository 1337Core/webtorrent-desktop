import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

await Promise.all([
  rm(resolve(root, 'build'), { force: true, recursive: true }),
  rm(resolve(root, 'out'), { force: true, recursive: true })
])
