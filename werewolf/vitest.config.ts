import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'public/**/*.test.js'],
    environment: 'node',
    testTimeout: 30000,
  },
});
