import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Keep secrets from a developer's real .env out of the test process.
    env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
  },
});
