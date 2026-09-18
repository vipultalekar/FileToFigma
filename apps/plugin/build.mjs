import { build, context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Figma plugins need a single bundled file per runtime: one for the sandbox and
 * one self-contained HTML document for the UI iframe. esbuild does both fast
 * enough to keep watch mode instant.
 */

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const outdir = resolve(here, 'dist');

const shared = {
  bundle: true,
  format: 'esm',
  target: ['es2020'],
  logLevel: 'info',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
};

/** Inlines the bundled UI JS and CSS into one HTML file. */
async function bundleUi() {
  const result = await build({
    ...shared,
    entryPoints: [resolve(here, 'src/ui/main.tsx')],
    outfile: resolve(outdir, 'ui.js'),
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    plugins: [cssPlugin()],
    write: false,
  });

  let js = '';
  let css = '';
  for (const file of result.outputFiles ?? []) {
    if (file.path.endsWith('.css')) css += file.text;
    else js += file.text;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Web2Figma</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;
  await mkdir(outdir, { recursive: true });
  await writeFile(resolve(outdir, 'ui.html'), html, 'utf8');
}

/** Loads .css imports as a real stylesheet rather than a JS string. */
function cssPlugin() {
  return {
    name: 'inline-css',
    setup(pluginBuild) {
      pluginBuild.onLoad({ filter: /\.css$/ }, async (args) => {
        const text = await readFile(args.path, 'utf8');
        return {
          contents: `const s=document.createElement('style');s.textContent=${JSON.stringify(text)};document.head.appendChild(s);`,
          loader: 'js',
        };
      });
    },
  };
}

async function bundleSandbox() {
  await build({
    ...shared,
    entryPoints: [resolve(here, 'src/code.ts')],
    outfile: resolve(outdir, 'code.js'),
    format: 'iife',
  });
}

if (watch) {
  const ctx = await context({
    ...shared,
    entryPoints: [resolve(here, 'src/code.ts')],
    outfile: resolve(outdir, 'code.js'),
    format: 'iife',
  });
  await ctx.watch();
  await bundleUi();
  console.log('watching sandbox; re-run for UI changes');
} else {
  await bundleSandbox();
  await bundleUi();
  console.log('plugin built into apps/plugin/dist');
}
