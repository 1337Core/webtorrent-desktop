import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { rm } from 'node:fs/promises'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

const root = resolve(import.meta.dirname, '..')
const outputRoot = resolve(root, 'build')
const nodeExternals = [
  'electron',
  ...builtinModules,
  ...builtinModules.map(module => `node:${module}`)
]

await rm(outputRoot, { force: true, recursive: true })

async function buildNodeEntry({
  entry,
  fileName,
  format,
  outDir,
  external = []
}) {
  await build({
    configFile: false,
    logLevel: 'info',
    build: {
      emptyOutDir: false,
      lib: {
        entry: resolve(root, entry),
        fileName: () => fileName,
        formats: [format]
      },
      minify: false,
      outDir: resolve(outputRoot, outDir),
      rollupOptions: {
        external: [...nodeExternals, ...external]
      },
      sourcemap: true,
      target: 'node24'
    }
  })
}

await buildNodeEntry({
  entry: 'src/main/index.ts',
  fileName: 'index.cjs',
  format: 'cjs',
  outDir: 'main'
})

await buildNodeEntry({
  entry: 'src/preload/index.ts',
  fileName: 'index.cjs',
  format: 'cjs',
  outDir: 'preload'
})

await buildNodeEntry({
  entry: 'src/engine/index.ts',
  external: ['webtorrent'],
  fileName: 'index.mjs',
  format: 'es',
  outDir: 'engine'
})

await build({
  base: './',
  configFile: false,
  logLevel: 'info',
  plugins: [react()],
  root: resolve(root, 'src', 'renderer'),
  build: {
    emptyOutDir: false,
    outDir: resolve(outputRoot, 'renderer'),
    sourcemap: true,
    target: 'chrome142'
  }
})
