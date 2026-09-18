import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'tools/**/*.test.ts', 'apps/**/*.test.ts'],
    environment: 'node',
    coverage: { provider: 'v8', include: ['packages/transform/src/**'] },
  },
  resolve: {
    alias: {
      '@web2figma/ir': resolve(__dirname, 'packages/ir/src/index.ts'),
      '@web2figma/shared': resolve(__dirname, 'packages/shared/src/index.ts'),
      '@web2figma/transform': resolve(__dirname, 'packages/transform/src/index.ts'),
      '@web2figma/capture': resolve(__dirname, 'packages/capture/src/index.ts'),
      '@web2figma/image-pipeline': resolve(
        __dirname,
        'packages/image-pipeline/src/index.ts',
      ),
    },
  },
});
