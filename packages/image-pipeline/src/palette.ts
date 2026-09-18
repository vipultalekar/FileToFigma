/**
 * Palette extraction (PRD section 9).
 *
 * k-means over the pixels, k = 8. Passing real hex values to the model stops it
 * inventing approximate colours, which is the most visible failure mode in a
 * screenshot import.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface PaletteEntry {
  hex: string;
  /** Share of sampled pixels, 0..1. */
  weight: number;
}

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Uint8Array | Uint8ClampedArray;
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (n: number): string => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function distance(a: Rgb, b: Rgb): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

/** Sample at most `limit` pixels; a full 1440x3000 image is 4M pixels. */
function samplePixels(image: RgbaImage, limit = 20_000): Rgb[] {
  const total = image.width * image.height;
  const step = Math.max(1, Math.floor(total / limit));
  const out: Rgb[] = [];
  for (let i = 0; i < total; i += step) {
    const o = i * 4;
    const alpha = image.data[o + 3] ?? 255;
    if (alpha < 16) continue;
    out.push({ r: image.data[o] ?? 0, g: image.data[o + 1] ?? 0, b: image.data[o + 2] ?? 0 });
  }
  return out;
}

export function kMeansPalette(image: RgbaImage, k = 8, iterations = 12): PaletteEntry[] {
  const pixels = samplePixels(image);
  if (pixels.length === 0) return [];

  // k-means++ style seeding: spread the initial centres out, which converges
  // faster and avoids the all-grey palette random seeding often produces.
  const centres: Rgb[] = [pixels[Math.floor(pixels.length / 2)] as Rgb];
  while (centres.length < k) {
    let best: Rgb | null = null;
    let bestScore = -1;
    for (let i = 0; i < pixels.length; i += Math.max(1, Math.floor(pixels.length / 512))) {
      const p = pixels[i] as Rgb;
      const nearest = Math.min(...centres.map((c) => distance(p, c)));
      if (nearest > bestScore) {
        bestScore = nearest;
        best = p;
      }
    }
    if (!best) break;
    centres.push(best);
  }

  const assignments = new Array<number>(pixels.length).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (let i = 0; i < pixels.length; i++) {
      const p = pixels[i] as Rgb;
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = distance(p, centres[c] as Rgb);
        if (d < bestDistance) {
          bestDistance = d;
          bestIndex = c;
        }
      }
      if (assignments[i] !== bestIndex) {
        assignments[i] = bestIndex;
        moved = true;
      }
    }
    if (!moved) break;

    const sums = centres.map(() => ({ r: 0, g: 0, b: 0, n: 0 }));
    for (let i = 0; i < pixels.length; i++) {
      const bucket = sums[assignments[i] as number];
      const p = pixels[i] as Rgb;
      if (!bucket) continue;
      bucket.r += p.r;
      bucket.g += p.g;
      bucket.b += p.b;
      bucket.n++;
    }
    for (let c = 0; c < centres.length; c++) {
      const bucket = sums[c];
      if (!bucket || bucket.n === 0) continue;
      centres[c] = { r: bucket.r / bucket.n, g: bucket.g / bucket.n, b: bucket.b / bucket.n };
    }
  }

  const counts = centres.map(() => 0);
  for (const a of assignments) counts[a] = (counts[a] ?? 0) + 1;

  return centres
    .map((c, i) => ({ hex: toHex(c), weight: (counts[i] ?? 0) / pixels.length }))
    .filter((entry) => entry.weight > 0.005)
    .sort((a, b) => b.weight - a.weight);
}

/** Relative luminance, used to pick readable text colours from the palette. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const lin = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
