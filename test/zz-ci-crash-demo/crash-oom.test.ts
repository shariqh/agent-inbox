import v8 from 'node:v8'
import { it } from 'vitest'
it('ooms', () => {
  v8.setFlagsFromString('--max-heap-size=64')
  const a: unknown[] = []
  for (;;) a.push(new Array(1e5).fill(1))
})
