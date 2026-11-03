// @ts-check
// Lint rules that catch what the type checker does not: promises left floating, untrusted values used as
// `any`, unchecked switches, and code reaching past the seams the extension is built around (see AGENTS.md).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/** Modules that may not be imported outside the files that own them, and where to go instead. */
const boundaries = {
  childProcess: {
    name: 'node:child_process',
    message: 'Run programs through host.process (src/core/process.ts), which tests replace.',
  },
  fs: { name: 'node:fs', message: 'Use src/core/files.ts, or host.store for the extension state.' },
  fsPromises: { name: 'node:fs/promises', message: 'Use src/core/files.ts, or host.store for the extension state.' },
  pi: {
    name: '@earendil-works/pi-coding-agent',
    allowTypeImports: true,
    message: 'Reach pi through the Host (src/core/host.ts); only index.ts binds it.',
  },
}
const restrict = (...paths) => ['error', { paths }]

export default tseslint.config(
  { ignores: ['node_modules/', 'test/fixtures/'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true, requireDefaultForNonUnion: false },
      ],
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
      // An `async` function without `await` still promises its result; several satisfy an async contract.
      '@typescript-eslint/require-await': 'off',
      // Every empty block says why it may be empty.
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-restricted-imports': restrict(boundaries.childProcess, boundaries.fs, boundaries.fsPromises, boundaries.pi),
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'Import statically: pi loads every module of the extension up front.',
        },
      ],
    },
  },
  // The files that own a boundary may cross it.
  { files: ['index.ts'], rules: { 'no-restricted-imports': restrict(boundaries.childProcess) } },
  {
    files: ['src/core/process.ts'],
    rules: { 'no-restricted-imports': restrict(boundaries.fs, boundaries.fsPromises) },
  },
  { files: ['src/core/files.ts'], rules: { 'no-restricted-imports': restrict(boundaries.childProcess) } },
  {
    // The band and the transcript's renderers draw with pi's own theme and components.
    files: ['src/band/renderers.ts'],
    rules: { 'no-restricted-imports': restrict(boundaries.childProcess, boundaries.fs, boundaries.fsPromises) },
  },
  {
    files: ['test/**/*.ts', '*.config.ts'],
    rules: {
      // Tests, fakes and fixtures may use `any` for the shapes they inspect.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
      'no-restricted-imports': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
)
