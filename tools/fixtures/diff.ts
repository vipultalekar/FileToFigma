import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { getBrowser } from './capture.js';

/**
 * Visual diff (PRD section 15 layer 3).
 *
 * Figma cannot be driven headlessly, so the builder runs against the mock and
 * its SVG render is screenshotted in the same browser as the source page. It is
 * an approximation of Figma's renderer, but it catches almost every regression
 * and runs in CI with no Figma session.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const OUT_DIR = resolve(here, '../out');

export async function rasteriseSvg(
  svg: string,
  width: number,
  height: number,
): Promise<Buffer> {
  const context = await (await getBrowser()).newContext({
    viewport: { width, height: Math.min(height, 4000) },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  try {
    await page.setContent(
      `<!DOCTYPE html><html><body style="margin:0;background:#fff">${svg}</body></html>`,
      { waitUntil: 'load' },
    );
    return await page.screenshot({ fullPage: true });
  } finally {
    await page.close();
    await context.close();
  }
}

export interface VisualDiff {
  ratio: number;
  width: number;
  height: number;
  diffPath?: string;
}

/**
 * Compare two PNGs. Images are cropped to their common area: the Figma render
 * and the browser render differ by a pixel or two in total height because line
 * breaking differs, which the PRD explicitly accepts.
 */
export async function comparePngs(
  a: Buffer,
  b: Buffer,
  options: { name?: string; threshold?: number; writeDiff?: boolean } = {},
): Promise<VisualDiff> {
  const left = PNG.sync.read(a);
  const right = PNG.sync.read(b);
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);

  const cropped = (png: PNG): PNG => {
    if (png.width === width && png.height === height) return png;
    const out = new PNG({ width, height });
    PNG.bitblt(png, out, 0, 0, width, height, 0, 0);
    return out;
  };

  const l = cropped(left);
  const r = cropped(right);
  const diff = new PNG({ width, height });
  const changed = pixelmatch(l.data, r.data, diff.data, width, height, {
    threshold: options.threshold ?? 0.2,
    includeAA: false,
  });

  const result: VisualDiff = { ratio: changed / (width * height), width, height };

  if (options.writeDiff && options.name) {
    await mkdir(OUT_DIR, { recursive: true });
    const diffPath = resolve(OUT_DIR, `${options.name}.diff.png`);
    await writeFile(diffPath, PNG.sync.write(diff));
    await writeFile(resolve(OUT_DIR, `${options.name}.source.png`), PNG.sync.write(l));
    await writeFile(resolve(OUT_DIR, `${options.name}.figma.png`), PNG.sync.write(r));
    result.diffPath = diffPath;
  }
  return result;
}

export { chromium };
