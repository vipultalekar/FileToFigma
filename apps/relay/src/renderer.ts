import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from 'playwright';
import { chromium } from 'playwright';
import type { IRDocument } from '@web2figma/ir';

/**
 * Playwright renderer (PRD section 5, entry point captureViaPlaywright).
 *
 * The page is rendered headlessly and the same capture bundle the extension
 * uses is injected, so a URL import and a live-tab import travel identical
 * code paths from the IR onwards.
 */

const here = dirname(fileURLToPath(import.meta.url));

export interface RenderOptions {
  width?: number;
  height?: number;
  fullPage?: boolean;
  /** Cookies to inject for an authenticated capture. */
  cookies?: { name: string; value: string; domain: string; path?: string }[];
  timeoutMs?: number;
  userAgent?: string;
  /** Emulates prefers-color-scheme, so a page's dark theme can be captured. */
  colorScheme?: 'light' | 'dark';
}

let browser: Browser | null = null;
let injectBundle: string | null = null;

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ headless: true });
  return browser;
}

async function getBundle(): Promise<string> {
  if (injectBundle) return injectBundle;
  injectBundle = await readFile(resolve(here, 'inject.js'), 'utf8');
  return injectBundle;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = null;
}

/**
 * Navigate, then give the page a chance to settle.
 *
 * `waitUntil: 'networkidle'` is the obvious choice and the wrong one: a site
 * with analytics beacons, a chat widget or any polling never reaches two
 * seconds of silence, and the whole render fails with a timeout instead of
 * returning a perfectly good page. So the navigation only waits for the DOM,
 * and quiet network is then a *preference* with its own small budget.
 */
async function gotoAndSettle(
  page: Awaited<ReturnType<Browser['newPage']>>,
  url: string,
  timeoutMs: number,
): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  // Give fonts, images and late layout a moment, but never hang on them.
  await Promise.race([
    page.waitForLoadState('networkidle', { timeout: Math.min(12_000, timeoutMs) }),
    page.waitForTimeout(Math.min(12_000, timeoutMs)),
  ]).catch(() => undefined);
}

export async function renderUrl(url: string, options: RenderOptions = {}): Promise<IRDocument> {
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  const context = await (await getBrowser()).newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    // A dark capture is just the page rendered under prefers-color-scheme:
    // dark, which is how every modern site switches theme.
    colorScheme: options.colorScheme ?? 'light',
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });
  if (options.cookies?.length) {
    await context.addCookies(
      options.cookies.map((c) => ({ ...c, path: c.path ?? '/' })),
    );
  }

  const page = await context.newPage();
  try {
    await gotoAndSettle(page, url, options.timeoutMs ?? 45_000);
    await page.addScriptTag({ content: await getBundle() });
    const doc = (await page.evaluate(async () => {
      const api = (window as unknown as { __web2figma: { capture: () => Promise<unknown> } }).__web2figma;
      return api.capture();
    })) as IRDocument;
    doc.source = { kind: 'url', ref: url, capturedAt: new Date().toISOString() };
    return doc;
  } finally {
    await page.close();
    await context.close();
  }
}

/** Render a self-contained HTML string; used by the image pipeline. */
export async function renderHtml(
  html: string,
  options: RenderOptions = {},
): Promise<IRDocument> {
  const width = options.width ?? 1440;
  const context = await (await getBrowser()).newContext({
    viewport: { width, height: options.height ?? 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page
      .waitForLoadState('networkidle', { timeout: 8_000 })
      .catch(() => undefined);
    await page.addScriptTag({ content: await getBundle() });
    const doc = (await page.evaluate(async () => {
      const api = (window as unknown as { __web2figma: { capture: () => Promise<unknown> } }).__web2figma;
      return api.capture();
    })) as IRDocument;
    doc.source = { kind: 'html', ref: options.userAgent ?? 'synthesised-html', capturedAt: new Date().toISOString() };
    return doc;
  } finally {
    await page.close();
    await context.close();
  }
}

/** Screenshot a rendered HTML string, for the image pipeline's verification loop. */
export async function screenshotHtml(
  html: string,
  options: RenderOptions = {},
): Promise<Buffer> {
  const context = await (await getBrowser()).newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
    return await page.screenshot({ fullPage: options.fullPage ?? true });
  } finally {
    await page.close();
    await context.close();
  }
}
