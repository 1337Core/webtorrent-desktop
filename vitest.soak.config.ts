import { defineConfig } from 'vitest/config'

/**
 * The section 18.5 soak suite runs on its own. It is excluded from the default
 * Vitest include so `npm test` stays deterministic and quick, and it needs an
 * explicit collector so heap retention is measured rather than guessed.
 */
export default defineConfig({
  test: {
    execArgv: ['--expose-gc'],
    fileParallelism: false,
    include: ['src/engine/soak/**/*.soak.ts'],
    maxWorkers: 1,
    minWorkers: 1,
    pool: 'forks',
    reporters: ['verbose']
  }
})
