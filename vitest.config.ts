import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Vite would otherwise claim <root>/public as its static publicDir and refuse to
  // transform anything inside it ("this file is in /public … can only be referenced
  // via HTML tags"). test/dom/ imports public/app.js directly, so this is mandatory.
  // Nothing here changes a byte on disk: public/ still has no build step and the
  // browser/Electron keep resolving '/x.js' from their own root.
  publicDir: false,
  resolve: {
    // The viewer's browser-absolute specifiers ('/app.js', '/attention.js', …) mapped
    // onto <repo>/public/. A '/' is not in [\w.-], so absolute filesystem paths are
    // deliberately not captured.
    alias: [
      {
        find: /^\/([\w.-]+\.js)$/,
        replacement: `${fileURLToPath(new URL('./public/', import.meta.url))}$1`,
      },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 15000,
    // No global `environment`: the node suite (store, mcp, infer) stays on node and
    // DOM files opt in with a `// @vitest-environment jsdom` docblock.
  },
})
