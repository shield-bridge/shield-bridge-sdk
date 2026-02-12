import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Silence expected console output from SDK (deprecation warnings, switch logs)
    silent: true,
    coverage: {
      provider: 'v8',
      include: ['src/utils/**'],
      reporter: ['text', 'lcov'],
    },
  },
});
