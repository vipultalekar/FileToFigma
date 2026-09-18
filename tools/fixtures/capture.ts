import { build } from 'esbuild';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium, type Browser } from 'playwright';
import type { IRDocument } from '@web2figma/ir';

/**
 * Fixture capture harness (PRD section 15).
 *
 * Fixtures are frozen local HTML, never live URLs: a test that fetches the
 * internet breaks and then gets disabled. Chromium renders them, the real
 * capture bundle runs inside the page, and the IR comes back for snapshotting
 * and for the visual diff.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = resolve(here, '../../fixtures');
export const SNAPSHOT_DIR = resolve(FIXTURE_DIR, 'snapshots');

let bundleCache: string | null = null;

/** Bundle the capture package for injection, straight from source. */
export async function captureBundle(): Promise<string> {
  if (bundleCache) return bundleCache;
  // Resolve from inside the capture package so its own workspace links (and
  // therefore @web2figma/ir and @web2figma/transform) are on the search path.
  const captureRoot = resolve(here, '../../packages/capture');
  const result = await build({
    stdin: {
      contents: `
        import { captureDocument } from './src/index.js';
        window.__web2figma = {
          capture: async (options) => (await captureDocument(document.documentElement, options ?? {})).doc,
        };
      `,
      resolveDir: captureRoot,
      loader: 'ts',
    },
    // The capture sources import each other with .js specifiers, which is what
    // TypeScript emits; map them back onto the .ts files on disk.
    resolveExtensions: ['.ts', '.js'],
    plugins: [
      {
        name: 'ts-source-resolver',
        setup(b) {
          b.onResolve({ filter: /\.js$/ }, (args) => {
            if (args.kind === 'entry-point' || !args.path.startsWith('.')) return null;
            const candidate = resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
            return existsSync(candidate) ? { path: candidate } : null;
          });
        },
      },
    ],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome114'],
    write: false,
    logLevel: 'silent',
  });
  bundleCache = result.outputFiles?.[0]?.text ?? '';
  return bundleCache;
}

export async function listFixtures(): Promise<string[]> {
  const files = await readdir(FIXTURE_DIR);
  return files.filter((f) => f.endsWith('.html')).sort();
}

export interface FixtureCapture {
  name: string;
  doc: IRDocument;
  screenshot: Buffer;
  width: number;
  height: number;
}

/**
 * Fixtures are served over http rather than opened as file:// URLs.
 * Chromium gives a file:// page an opaque origin, where fetch() is blocked and
 * images taint the canvas — so a file:// harness cannot exercise the asset
 * inlining that every real capture depends on, and would report failures that
 * do not happen in practice (and hide ones that do).
 */
let server: Server | null = null;
let origin = '';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

export async function fixtureOrigin(): Promise<string> {
  if (server && origin) return origin;
  server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
    // Never serve outside the fixture directory.
    const target = normalize(join(FIXTURE_DIR, path));
    if (!target.startsWith(FIXTURE_DIR)) {
      res.writeHead(403).end();
      return;
    }
    readFile(target)
      .then((body) => {
        res.writeHead(200, { 'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream' });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404).end();
      });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  origin = `http://127.0.0.1:${port}`;
  return origin;
}

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({ headless: true });
  return browser;
}

export async function closeFixtureBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
    origin = '';
  }
}

export async function captureFixture(
  name: string,
  options: { width?: number; colorScheme?: 'light' | 'dark' } = {},
): Promise<FixtureCapture> {
  const file = resolve(FIXTURE_DIR, name);
  const html = await readFile(file, 'utf8');
  const width = options.width ?? detectWidth(html) ?? 1280;

  const context = await (await getBrowser()).newContext({
    viewport: { width, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: options.colorScheme ?? 'light',
  });
  const page = await context.newPage();
  try {
    const base = await fixtureOrigin();
    await page.goto(`${base}/${name}`, { waitUntil: 'networkidle' });
    const screenshot = await page.screenshot({ fullPage: true });
    await page.addScriptTag({ content: await captureBundle() });
    const doc = (await page.evaluate(async () => {
      const api = (window as unknown as { __web2figma: { capture: (o?: unknown) => Promise<unknown> } })
        .__web2figma;
      return api.capture({ skipPrepare: false, scrollDelay: 30 });
    })) as IRDocument;
    const size = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
    doc.source = { kind: 'html', ref: name, capturedAt: '1970-01-01T00:00:00.000Z' };
    return { name, doc, screenshot, width: size.w, height: size.h };
  } finally {
    await page.close();
    await context.close();
  }
}

function detectWidth(html: string): number | null {
  const m = /body\s*{[^}]*width:\s*(\d+)px/.exec(html);
  return m ? parseInt(m[1] as string, 10) : null;
}

/**
 * Snapshots are compared after stripping the volatile parts: asset payloads are
 * large and encoder-dependent, so only their shape is recorded.
 */
export function stableSnapshot(doc: IRDocument): unknown {
  const strip = (node: unknown): unknown => {
    const n = node as Record<string, unknown> & { children?: unknown[] };
    const out: Record<string, unknown> = {
      kind: n.kind,
      name: n.name,
      rect: roundRect(n.rect as { x: number; y: number; w: number; h: number }),
    };
    if (n.kind === 'text') out.characters = n.characters;
    if (n.kind === 'frame') {
      const layout = n.layout as { mode: string; reason: string; itemSpacing: number };
      out.layout = { mode: layout.mode, reason: layout.reason, itemSpacing: Math.round(layout.itemSpacing) };
      out.children = (n.children ?? []).map(strip);
    }
    return out;
  };
  return {
    version: doc.version,
    root: strip(doc.root),
    warnings: doc.warnings
      .filter((w) => w.severity !== 'info')
      .map((w) => ({ severity: w.severity, property: w.property }))
      .sort((a, b) => a.property.localeCompare(b.property)),
  };
}

function roundRect(r: { x: number; y: number; w: number; h: number }): number[] {
  return [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)];
}
