import { defineConfig } from 'vitest/config';

// Needs a running Kafka broker (KAFKA_BROKERS, default localhost:9092).
// Locally: `docker compose up -d kafka`. In CI: the Kafka service container.
export default defineConfig({
  // Resolve workspace packages to their TypeScript sources (package.json "source" condition)
  resolve: { conditions: ['source', 'module', 'node', 'import', 'default'] },
  ssr: { resolve: { conditions: ['source', 'node', 'import', 'default'], externalConditions: ['source'] } },
  test: {
    include: ['tests/**/*.integration.test.ts'],
    environment: 'node',
    testTimeout: 90_000,
    hookTimeout: 90_000,
  },
});
