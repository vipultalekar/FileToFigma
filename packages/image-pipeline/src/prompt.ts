import type { IconRegion } from './icons.js';
import type { OcrLine } from './ocr.js';
import type { PaletteEntry } from './palette.js';

/**
 * The vision model prompt contract (PRD section 9).
 *
 * Flexbox is not a style preference here: it maps to Auto Layout at confidence
 * 1.0, and a model that emits absolute positioning throws away the entire
 * point of the pipeline. The prompt says so in those terms.
 */

export interface PromptInput {
  width: number;
  height: number;
  lines: OcrLine[];
  palette: PaletteEntry[];
  icons: IconRegion[];
}

export const SYSTEM_PROMPT = [
  'You reconstruct a user interface as a single self-contained HTML document.',
  'You are given ground truth: exact text strings with their positions, the exact colour palette, and icon positions.',
  'You never invent copy, never approximate a colour, and never describe what you are doing.',
].join(' ');

export function buildPrompt(input: PromptInput): string {
  const textBlock = input.lines
    .map(
      (l) =>
        `- "${l.text.replace(/"/g, '\\"')}" at x=${Math.round(l.x)} y=${Math.round(l.y)} w=${Math.round(
          l.w,
        )} h=${Math.round(l.h)} fontSize=${l.estimatedFontSize}`,
    )
    .join('\n');

  const paletteBlock = input.palette
    .map((p) => `- ${p.hex} (${Math.round(p.weight * 100)}% of pixels)`)
    .join('\n');

  const iconBlock =
    input.icons.length > 0
      ? input.icons
          .map((i) => `- data-icon="${i.id}" at x=${i.x} y=${i.y} w=${i.w} h=${i.h}`)
          .join('\n')
      : '- none detected';

  return `Rebuild this interface as HTML.

OUTPUT RULES
1. Return one HTML document and nothing else. No markdown fence, no commentary.
2. All CSS goes in a single <style> block. No external resources and no web font imports.
3. Use flexbox for every container. Only use absolute positioning where an element genuinely overlaps another.
4. Use only the supplied palette hex values.
5. Use the supplied text strings verbatim, including punctuation and case.
6. Set the body width to exactly ${input.width}px so the render matches the source 1:1.
7. Add data-role attributes (header, nav, card, button, input, footer, sidebar) to the containers that deserve them.
8. For every icon listed below, emit <img data-icon="N"> at that position and size. Do not draw icons yourself.

Rule 3 is the important one: flexbox containers become editable Auto Layout frames, absolute positioning does not.

IMAGE SIZE
${input.width} x ${input.height} px

TEXT (ground truth, use verbatim)
${textBlock || '- none detected'}

PALETTE (use only these)
${paletteBlock || '- #ffffff (100% of pixels)'}

ICONS
${iconBlock}
`;
}

/** The correction turn of the verification loop (PRD section 9). */
export function buildCorrectionPrompt(diffPercent: number, hints: string[]): string {
  return `The render differs from the source by ${diffPercent.toFixed(1)}% of pixels.

Fix the layout and return the corrected full HTML document, same rules as before.
Focus on:
${hints.map((h) => `- ${h}`).join('\n')}

Do not restructure containers that already match; change only what the difference requires.`;
}

/** Models like to wrap HTML in a fence even when told not to. */
export function stripFence(output: string): string {
  const trimmed = output.trim();
  const fence = /^```(?:html)?\s*([\s\S]*?)```$/i.exec(trimmed);
  const body = (fence ? (fence[1] as string) : trimmed).trim();
  const start = body.search(/<!DOCTYPE html|<html/i);
  return (start > 0 ? body.slice(start) : body).trim();
}
