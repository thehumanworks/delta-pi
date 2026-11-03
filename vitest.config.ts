import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        test: { name: 'unit', include: ['test/*.test.ts'] },
      },
      {
        // The whole extension in process, on a fake pi and a clock each test moves (test/kit).
        test: { name: 'behaviour', include: ['test/behaviour/*.test.ts'], testTimeout: 30_000 },
      },
      {
        // Each end-to-end test starts real pi processes; one file at a time keeps their timing honest.
        test: { name: 'e2e', include: ['test/e2e/*.test.ts'], fileParallelism: false, testTimeout: 120_000 },
      },
    ],
  },
})
