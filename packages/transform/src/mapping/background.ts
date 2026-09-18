import type { Paint, ScaleMode } from '@web2figma/ir';
import { solidFromCss } from './color.js';
import { gradientToPaint, isGradient, splitTopLevel } from './gradient.js';

/**
 * background-color + background-image -> Figma fills (PRD section 10).
 *
 * Two order facts drive this file:
 *  - CSS lists background layers top-first; Figma paints the fills array
 *    bottom-first. The array is reversed on the way out.
 *  - background-color always sits underneath every image layer.
 */

export interface BackgroundInput {
  color: string | null;
  /** The raw `background-image` computed value, possibly comma-separated. */
  image: string | null;
  size: string | null;
  position: string | null;
  repeat: string | null;
  width: number;
  height: number;
}

/** Resolves a url() found in a background into a captured asset id. */
export type AssetResolver = (url: string) => string | null;

export function backgroundSizeToScaleMode(
  size: string | null,
  repeat: string | null,
): ScaleMode {
  const s = (size ?? '').trim().toLowerCase();
  const r = (repeat ?? '').trim().toLowerCase();
  if (r.startsWith('repeat') && r !== 'repeat-x' && r !== 'repeat-y' && s !== 'cover') {
    return 'TILE';
  }
  if (s === 'contain') return 'FIT';
  if (s === 'cover' || s === '') return 'FILL';
  // Explicit lengths behave closest to CROP in Figma, which keeps the source
  // pixels and lets the user nudge the crop rather than silently rescaling.
  if (/\d/.test(s)) return 'CROP';
  return 'FILL';
}

export function extractUrl(layer: string): string | null {
  const m = /url\((['"]?)(.*?)\1\)/i.exec(layer);
  return m ? (m[2] as string) : null;
}

/**
 * Build the fills array for an element. `layers` are returned bottom-first,
 * ready to hand to Figma.
 */
export function backgroundToFills(
  input: BackgroundInput,
  resolveAsset: AssetResolver,
  onDrop?: (reason: string, detail: string) => void,
): Paint[] {
  const fills: Paint[] = [];

  const base = solidFromCss(input.color);
  if (base) fills.push(base);

  const imageValue = (input.image ?? '').trim();
  if (imageValue && imageValue.toLowerCase() !== 'none') {
    const layers = splitTopLevel(imageValue);
    const sizes = splitTopLevel(input.size ?? '');
    const repeats = splitTopLevel(input.repeat ?? '');

    // CSS paints layer 0 on top, so walk backwards to emit bottom-first.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = (layers[i] as string).trim();
      if (!layer || layer.toLowerCase() === 'none') continue;

      if (isGradient(layer)) {
        const paint = gradientToPaint(layer, input.width, input.height);
        if (paint) fills.push(paint);
        else onDrop?.('background-image', `unparsed gradient: ${layer.slice(0, 80)}`);
        continue;
      }

      const url = extractUrl(layer);
      if (url) {
        const assetId = resolveAsset(url);
        if (assetId) {
          fills.push({
            type: 'IMAGE',
            assetId,
            scaleMode: backgroundSizeToScaleMode(
              sizes[i] ?? sizes[0] ?? null,
              repeats[i] ?? repeats[0] ?? null,
            ),
          });
        } else {
          onDrop?.('background-image', `asset unavailable: ${url.slice(0, 120)}`);
        }
        continue;
      }

      onDrop?.('background-image', `unsupported layer: ${layer.slice(0, 80)}`);
    }
  }

  return fills;
}
