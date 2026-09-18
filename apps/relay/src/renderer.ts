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

export async function renderUrl(url: string, options: RenderOptions = {}): Promise<IRDocument> {
  const width = options.width ?? 1440;
  const height = options.height ?? 900;
  const context = await (await getBrowser()).newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });
  if (options.cookies?.length) {
    await context.addCookies(
      options.cookies.map((c) => ({ ...c, path: c.path ?? '/' })),
    );
  }

  const page = await context.newPage();
  try {
    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: options.timeoutMs ?? 45_000,
    });
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
    await page.setContent(html, { waitUntil: 'networkidle' });
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
    await page.setContent(html, { waitUntil: 'networkidle' });
    return await page.screenshot({ fullPage: options.fullPage ?? true });
  } finally {
    await page.close();
    await context.close();
  }
}
