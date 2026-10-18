import { defineConfig } from 'vitest/config'

// Unit tests only: node_modules and the dashboard app ship their own test files
// and must never be part of this workspace's contract checks.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dashboard/**', 'packages/**/node_modules/**'],
  },
})
