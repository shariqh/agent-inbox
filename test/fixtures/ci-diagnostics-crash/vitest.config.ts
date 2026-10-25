// The real Vitest run behind test/ci-diagnostics.test.ts (#359): the CI-only pool
// and flags, one fixture whose worker dies, nothing else from the main config.
import { defineConfig } from 'vitest/config'
import { ciDiagnostics } from '../../ci-diagnostics.js'

export default defineConfig({
  test: {
    include: ['kills-its-worker.fixture.ts'],
    ...(ciDiagnostics(process.env) ?? {}),
  },
})
