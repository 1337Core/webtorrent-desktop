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

/**
 * A separate end-to-end build. Automation drives the packaged app through
 * Chrome DevTools, which the release build refuses: `--remote-debugging-port`
 * is a dangerous launch switch. This constant is compiled in only when the
 * build is explicitly requested for automation, and package verification
 * proves the release artifact does not carry it.
 */
const isE2eBuild = process.env.WEBTORRENT_UPDATED_E2E === '1'
if (isE2eBuild) {
  console.log('build: automation build — remote debugging is permitted')
}

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
    define: {
      __WEBTORRENT_UPDATED_E2E_BUILD__: JSON.stringify(isE2eBuild)
    },
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
      sourcemap: false,
      target: 'node24'
    }
  })
}

await buildNodeEntry({
  entry: 'src/main/index.ts',
  external: ['chokidar', 'electron-store'],
  fileName: 'index.mjs',
  format: 'es',
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
  external: [
    '@thaunknown/simple-peer',
    'bencode',
    'create-torrent',
    'parse-torrent',
    // `subtitle` reaches an old CommonJS readable-stream that calls `require`
    // at load time, which no ES bundle can satisfy; it stays external.
    'subtitle',
    'undici',
    'webtorrent',
    'ws'
  ],
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
    sourcemap: false,
    target: 'chrome142'
  }
})
