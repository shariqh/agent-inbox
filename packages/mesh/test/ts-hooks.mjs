// Runs this package's TypeScript sources in a child Node 24 (type stripping) for
// the tests that need a real process: `./x.js` imports from a `.ts` file resolve
// to `./x.ts`, and with LOAD_SPY=1 every `@a2a-js/sdk` import is reported on
// stderr, so a test can prove a code path never loads the SDK.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (process.env.LOAD_SPY === '1' && specifier.startsWith('@a2a-js/sdk')) process.stderr.write(`load-spy: ${specifier}\n`)
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
      const ts = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
      if (existsSync(fileURLToPath(ts))) return next(ts.href, context)
    }
    return next(specifier, context)
  },
})
