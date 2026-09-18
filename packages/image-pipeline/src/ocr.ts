/**
 * OCR handling (PRD section 9).
 *
 * The vision model never transcribes: it is handed OCR output as ground truth
 * and told to use those strings verbatim. That removes paraphrasing and
 * hallucinated copy entirely.
 *
 * The OCR engine itself is pluggable — Tesseract.js locally by default, a cloud
 * engine when the user opts in — so this module only owns the shapes and the
 * post-processing.
 */

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  confidence?: number;
}

export interface OcrLine {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  estimatedFontSize: number;
  confidence: number;
}

export type OcrEngine = (image: string) => Promise<OcrWord[]>;

/** Latin glyph boxes are roughly 1.4x the font size (PRD section 9). */
export const CAP_HEIGHT_RATIO = 1.4;

export function estimateFontSize(boxHeight: number): number {
  return Math.max(8, Math.round(boxHeight / CAP_HEIGHT_RATIO));
}

/** Group words into lines by vertical overlap, then by reading order. */
export function groupIntoLines(words: readonly OcrWord[]): OcrLine[] {
  const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: OcrWord[][] = [];

  for (const word of sorted) {
    const line = lines.find((l) => {
      const first = l[0] as OcrWord;
      const overlap =
        Math.min(first.y + first.h, word.y + word.h) - Math.max(first.y, word.y);
      return overlap > Math.min(first.h, word.h) * 0.5;
    });
    if (line) line.push(word);
    else lines.push([word]);
  }

  return lines.map((line) => {
    const ordered = [...line].sort((a, b) => a.x - b.x);
    const x = Math.min(...ordered.map((w) => w.x));
    const y = Math.min(...ordered.map((w) => w.y));
    const right = Math.max(...ordered.map((w) => w.x + w.w));
    const bottom = Math.max(...ordered.map((w) => w.y + w.h));
    const confidences = ordered.map((w) => w.confidence ?? 1);
    return {
      text: ordered.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(),
      x,
      y,
      w: right - x,
      h: bottom - y,
      estimatedFontSize: estimateFontSize(bottom - y),
      confidence: confidences.reduce((a, b) => a + b, 0) / confidences.length,
    };
  });
}

/**
 * Cluster nearby font sizes onto shared values, so body text lands on one size
 * instead of drifting a pixel per line (PRD section 9).
 */
export function clusterFontSizes(lines: OcrLine[], tolerance = 2): OcrLine[] {
  const sizes = [...new Set(lines.map((l) => l.estimatedFontSize))].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const size of sizes) {
    const last = clusters[clusters.length - 1];
    if (last && size - (last[last.length - 1] as number) <= tolerance) last.push(size);
    else clusters.push([size]);
  }
  // Each cluster collapses onto the size that the most lines already use.
  const canonical = new Map<number, number>();
  for (const cluster of clusters) {
    const counts = cluster.map((size) => ({
      size,
      n: lines.filter((l) => l.estimatedFontSize === size).length,
    }));
    const winner = counts.sort((a, b) => b.n - a.n)[0]?.size ?? cluster[0] ?? 16;
    for (const size of cluster) canonical.set(size, winner);
  }
  return lines.map((l) => ({
    ...l,
    estimatedFontSize: canonical.get(l.estimatedFontSize) ?? l.estimatedFontSize,
  }));
}

/** Drop the noise OCR always produces: single stray marks and empty boxes. */
export function cleanLines(lines: OcrLine[], minConfidence = 0.4): OcrLine[] {
  return lines.filter(
    (l) => l.text.length > 0 && l.confidence >= minConfidence && !/^[^\w\s]$/.test(l.text),
  );
}

export async function runOcr(image: string, engine: OcrEngine): Promise<OcrLine[]> {
  const words = await engine(image);
  return cleanLines(clusterFontSizes(groupIntoLines(words)));
}
