import { build, context } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * MV3 wants plain files in one directory: content.js, background.js, popup.js,
 * popup.html and the manifest. Content scripts stay vanilla TS so the injected
 * bundle stays small (PRD section 13).
 */

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, 'dist');
const watch = process.argv.includes('--watch');

const options = {
  bundle: true,
  format: 'iife',
  target: ['chrome114'],
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  entryPoints: {
    content: resolve(here, 'content/content.ts'),
    popup: resolve(here, 'popup/popup.ts'),
  },
  outdir,
};

const backgroundOptions = {
  ...options,
  format: 'esm',
  entryPoints: { background: resolve(here, 'background/background.ts') },
};

await mkdir(outdir, { recursive: true });

if (watch) {
  const [a, b] = await Promise.all([context(options), context(backgroundOptions)]);
  await Promise.all([a.watch(), b.watch()]);
} else {
  await Promise.all([build(options), build(backgroundOptions)]);
}

await copyFile(resolve(here, 'manifest.json'), resolve(outdir, 'manifest.json'));
await copyFile(resolve(here, 'popup/popup.html'), resolve(outdir, 'popup.html'));

console.log('extension built into apps/extension/dist (load unpacked)');
