// Run only by test/ci-diagnostics.test.ts, through ./vitest.config.ts (#359).
import { it } from 'vitest'

it('kills its own worker', () => {
  process.kill(process.pid, 'SIGKILL')
})
