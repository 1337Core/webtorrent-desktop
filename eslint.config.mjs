import eslint from '@eslint/js'
import globals from 'globals'
import { builtinModules } from 'node:module'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const nodeImportPatterns = [
  'node:*',
  ...builtinModules
    .filter(moduleName => !moduleName.startsWith('_'))
    .flatMap(moduleName => [moduleName, `${moduleName}/*`])
]

const processNeutralImportRestrictions = {
  paths: [
    {
      name: 'electron',
      message: 'Electron APIs belong behind a process-specific boundary.'
    },
    {
      name: 'electron-store',
      message: 'Durable application state is owned by the main process.'
    },
    {
      name: 'webtorrent',
      message: 'WebTorrent is owned by the engine utility process.'
    }
  ],
  patterns: [
    {
      group: nodeImportPatterns,
      message: 'Node APIs are unavailable across this process boundary.'
    }
  ]
}

const outsideProcessDirectoryPattern = directories =>
  `^(?:\\./)*\\.\\.(?:/\\.\\.)*/(?:${directories.join('|')})(?:/|$)`

export default [
  {
    ignores: [
      '.github/**',
      'bin/**',
      'build/**',
      'dist/**',
      'out/**',
      'node_modules/**',
      'src/**/*.js',
      'static/**',
      'test/**'
    ]
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node
    },
    rules: eslint.configs.recommended.rules
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...tseslint.configs.recommendedTypeChecked.rules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/shared/**/*.ts'],
    languageOptions: {
      globals: globals.browser
    },
    rules: {
      'no-restricted-imports': ['error', processNeutralImportRestrictions]
    }
  },
  {
    files: ['src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...processNeutralImportRestrictions,
          patterns: [
            ...processNeutralImportRestrictions.patterns,
            {
              regex: outsideProcessDirectoryPattern([
                'engine',
                'main',
                'preload',
                'renderer'
              ]),
              message: 'Shared modules may import only other shared modules.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          ...processNeutralImportRestrictions,
          patterns: [
            ...processNeutralImportRestrictions.patterns,
            {
              regex: outsideProcessDirectoryPattern([
                'engine',
                'main',
                'preload'
              ]),
              message:
                'The renderer may import only renderer and shared modules.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/main/**/*.ts'],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'webtorrent',
              message: 'WebTorrent is owned by the engine utility process.'
            }
          ],
          patterns: [
            {
              regex: outsideProcessDirectoryPattern([
                'engine',
                'preload',
                'renderer'
              ]),
              message:
                'The main process may import only main and shared modules.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/preload/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron-store',
              message: 'Durable application state is owned by the main process.'
            },
            {
              name: 'webtorrent',
              message: 'WebTorrent is owned by the engine utility process.'
            }
          ],
          patterns: [
            {
              group: nodeImportPatterns,
              message: 'The preload bridge must not import Node APIs.'
            },
            {
              regex: outsideProcessDirectoryPattern([
                'engine',
                'main',
                'renderer'
              ]),
              message: 'The preload may import only preload and shared modules.'
            }
          ]
        }
      ]
    }
  },
  {
    files: ['src/engine/**/*.ts'],
    languageOptions: {
      globals: globals.node
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'The engine uses the utility-process parent port, not Electron UI APIs.'
            },
            {
              name: 'electron-store',
              message: 'Durable application state is owned by the main process.'
            }
          ],
          patterns: [
            {
              regex: outsideProcessDirectoryPattern([
                'main',
                'preload',
                'renderer'
              ]),
              message: 'The engine may import only engine and shared modules.'
            }
          ]
        }
      ]
    }
  }
]
