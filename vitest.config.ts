import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Mirror the tsconfig `@/*` -> `./*` path alias so route-level tests (which
// import via `@/lib/...`) resolve under vitest. Test-only; no runtime effect.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
})
