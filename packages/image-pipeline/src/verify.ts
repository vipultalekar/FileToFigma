import type { RgbaImage } from './palette.js';

/**
 * Verification loop support (PRD section 9): render the generated HTML, diff it
 * against the source, and feed the difference back for a correction. Two passes
 * is usually the point of diminishing returns; three is the cap.
 */

export interface DiffResult {
  /** Fraction of pixels that differ, 0..1. */
  ratio: number;
  /** Worst regions, as hints for the correction turn. */
  hints: string[];
}

const THRESHOLD = 48;

export function diffImages(a: RgbaImage, b: RgbaImage, gridSize = 4): DiffResult {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  if (width === 0 || height === 0) return { ratio: 1, hints: ['the render produced no pixels'] };

  const cells = new Array(gridSize * gridSize).fill(0) as number[];
  const cellTotals = new Array(gridSize * gridSize).fill(0) as number[];
  let different = 0;
  let total = 0;

  const step = Math.max(1, Math.floor(Math.min(width, height) / 600));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      const delta =
        Math.abs((a.data[ia] ?? 0) - (b.data[ib] ?? 0)) +
        Math.abs((a.data[ia + 1] ?? 0) - (b.data[ib + 1] ?? 0)) +
        Math.abs((a.data[ia + 2] ?? 0) - (b.data[ib + 2] ?? 0));
      const cell =
        Math.min(gridSize - 1, Math.floor((y / height) * gridSize)) * gridSize +
        Math.min(gridSize - 1, Math.floor((x / width) * gridSize));
      cellTotals[cell] = (cellTotals[cell] ?? 0) + 1;
      total++;
      if (delta > THRESHOLD) {
        different++;
        cells[cell] = (cells[cell] ?? 0) + 1;
      }
    }
  }

  const ratio = total === 0 ? 1 : different / total;
  const ranked = cells
    .map((count, index) => ({
      index,
      share: (cellTotals[index] ?? 0) === 0 ? 0 : count / (cellTotals[index] as number),
    }))
    .sort((x, y2) => y2.share - x.share)
    .slice(0, 3)
    .filter((c) => c.share > 0.1);

  const bandNames = ['top', 'upper middle', 'lower middle', 'bottom'];
  const columnNames = ['left', 'centre left', 'centre right', 'right'];
  const hints = ranked.map((c) => {
    const row = Math.floor(c.index / gridSize);
    const col = c.index % gridSize;
    return `${bandNames[Math.min(row, 3)]} ${columnNames[Math.min(col, 3)]} differs by ${Math.round(
      c.share * 100,
    )}%`;
  });

  return { ratio, hints };
}

export const MAX_ITERATIONS = 3;

/** Stop when the diff is good enough or improvement has stalled. */
export function shouldIterate(
  iteration: number,
  ratio: number,
  previousRatio: number,
  target = 0.05,
): boolean {
  if (iteration >= MAX_ITERATIONS) return false;
  if (ratio <= target) return false;
  // A correction that improves by less than a fifth is not worth another turn.
  return iteration === 0 || previousRatio - ratio > previousRatio * 0.2;
}
