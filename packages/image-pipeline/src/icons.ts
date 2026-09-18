import type { OcrLine } from './ocr.js';
import type { RgbaImage } from './palette.js';

/**
 * Icon detection (PRD section 9): small, high-contrast regions containing no
 * OCR text. Each one is cropped and handed to the model as a placeholder it can
 * position, rather than asking it to draw an icon it cannot see.
 */

export interface IconRegion {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell {
  contrast: boolean;
}

const CELL = 8;

function localContrast(image: RgbaImage, x0: number, y0: number, size: number): number {
  let min = 255;
  let max = 0;
  for (let y = y0; y < Math.min(y0 + size, image.height); y++) {
    for (let x = x0; x < Math.min(x0 + size, image.width); x++) {
      const o = (y * image.width + x) * 4;
      const lum =
        0.299 * (image.data[o] ?? 0) + 0.587 * (image.data[o + 1] ?? 0) + 0.114 * (image.data[o + 2] ?? 0);
      min = Math.min(min, lum);
      max = Math.max(max, lum);
    }
  }
  return max - min;
}

function overlapsText(region: IconRegion, lines: readonly OcrLine[]): boolean {
  return lines.some(
    (l) =>
      region.x < l.x + l.w &&
      region.x + region.w > l.x &&
      region.y < l.y + l.h &&
      region.y + region.h > l.y,
  );
}

/**
 * Coarse connected-component pass over an 8px grid. Precision matters less than
 * recall here: a false positive costs one stray image, a miss costs an icon.
 */
export function detectIcons(
  image: RgbaImage,
  lines: readonly OcrLine[],
  options: { minSize?: number; maxSize?: number; threshold?: number } = {},
): IconRegion[] {
  const minSize = options.minSize ?? 12;
  const maxSize = options.maxSize ?? 96;
  const threshold = options.threshold ?? 60;

  const cols = Math.ceil(image.width / CELL);
  const rows = Math.ceil(image.height / CELL);
  const grid: Cell[] = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      grid[r * cols + c] = {
        contrast: localContrast(image, c * CELL, r * CELL, CELL) > threshold,
      };
    }
  }

  const seen = new Uint8Array(cols * rows);
  const regions: IconRegion[] = [];
  let nextId = 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const index = r * cols + c;
      if (seen[index] || !grid[index]?.contrast) continue;

      // Flood fill the contrast blob.
      const stack = [index];
      seen[index] = 1;
      let minC = c;
      let maxC = c;
      let minR = r;
      let maxR = r;

      while (stack.length > 0) {
        const current = stack.pop() as number;
        const cr = Math.floor(current / cols);
        const cc = current % cols;
        minC = Math.min(minC, cc);
        maxC = Math.max(maxC, cc);
        minR = Math.min(minR, cr);
        maxR = Math.max(maxR, cr);

        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) continue;
          const ni = nr * cols + nc;
          if (seen[ni] || !grid[ni]?.contrast) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }

      const region: IconRegion = {
        id: nextId,
        x: minC * CELL,
        y: minR * CELL,
        w: (maxC - minC + 1) * CELL,
        h: (maxR - minR + 1) * CELL,
      };
      const square = Math.abs(region.w - region.h) <= Math.max(region.w, region.h) * 0.6;
      const sized =
        region.w >= minSize && region.h >= minSize && region.w <= maxSize && region.h <= maxSize;
      if (sized && square && !overlapsText(region, lines)) {
        regions.push(region);
        nextId++;
      }
    }
  }

  return regions;
}
