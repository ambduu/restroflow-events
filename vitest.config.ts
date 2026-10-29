import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (package.json "source" condition)
  resolve: { conditions: ['source', 'module', 'node', 'import', 'default'] },
  ssr: { resolve: { conditions: ['source', 'node', 'import', 'default'], externalConditions: ['source'] } },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'services/*/test/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
