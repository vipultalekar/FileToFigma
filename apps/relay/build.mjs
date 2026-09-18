import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Two bundles: the server itself (Node, Playwright left external) and the
 * capture bundle that gets injected into the rendered page.
 */

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, 'dist');

await build({
  entryPoints: [resolve(here, 'src/server.ts')],
  outfile: resolve(outdir, 'server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  external: ['playwright'],
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

await build({
  entryPoints: [resolve(here, 'src/inject-entry.ts')],
  outfile: resolve(outdir, 'inject.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome114'],
  logLevel: 'info',
});

console.log('relay built into apps/relay/dist');
