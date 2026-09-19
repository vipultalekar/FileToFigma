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
  'You extract exact text strings, colors, and layout structure directly from the screenshot.',
  'You never add conversational text and never describe what you are doing. Return only HTML.',
].join(' ');

export function buildPrompt(input: PromptInput): string {
  const hasText = input.lines.length > 0;
  const textBlock = hasText
    ? input.lines
        .map(
          (l) =>
            `- "${l.text.replace(/"/g, '\\"')}" at x=${Math.round(l.x)} y=${Math.round(l.y)} w=${Math.round(
              l.w,
            )} h=${Math.round(l.h)} fontSize=${l.estimatedFontSize}`,
        )
        .join('\n')
    : '';

  const hasPalette = input.palette.length > 0;
  const paletteBlock = hasPalette
    ? input.palette
        .map((p) => `- ${p.hex} (${Math.round(p.weight * 100)}% of pixels)`)
        .join('\n')
    : '';

  const iconBlock =
    input.icons.length > 0
      ? input.icons
          .map((i) => `- data-icon="${i.id}" at x=${i.x} y=${i.y} w=${i.w} h=${i.h}`)
          .join('\n')
      : '- none detected';

  const textRule = hasText
    ? '5. Use the supplied text strings verbatim, including punctuation and case.'
    : '5. Read all visible text directly from the screenshot and transcribe every headline, title, label, button, and description verbatim.';

  const paletteRule = hasPalette
    ? '4. Use only the supplied palette hex values.'
    : '4. Extract and match the exact colors, backgrounds, borders, and shadows visible in the screenshot.';

  return `Rebuild this interface as HTML.

OUTPUT RULES
1. Return one HTML document and nothing else. No markdown fence, no commentary.
2. All CSS goes in a single <style> block. Start <style> with:
   * { box-sizing: border-box; margin: 0; padding: 0; }
   body { width: ${input.width}px; max-width: ${input.width}px; min-height: ${input.height}px; overflow-x: hidden; margin: 0 auto; display: flex; flex-direction: column; font-family: Inter, system-ui, -apple-system, sans-serif; }
3. Use flexbox for every container (display: flex; flex-direction: column or row). Only use absolute positioning where an element genuinely overlaps another (e.g. floating action button, badges).
${paletteRule}
${textRule}
6. VIEWPORT & OVERFLOW CONSTRAINTS:
   - Body width is exactly ${input.width}px.
   - Every section, card, banner, and wrapper must fit within ${input.width}px (use width: 100% or max-width: 100%).
   - Containers must use natural height (height: auto) with consistent flex gaps (gap: 10px-16px). Do NOT use excessive fixed heights or justify-content: space-between on tall cards, which causes massive empty vertical gaps.
   - NEVER let any element, card, or text overflow horizontally outside ${input.width}px.
   - For horizontal carousels or cards, wrap in a flex row with gap: 12px; overflow-x: auto; width: 100%; and card widths fitting comfortably on screen (e.g. width: calc(100% - 48px); max-width: 280px; flex-shrink: 0;).
7. PROPORTIONS & SPACING:
   - Maintain tight, realistic mobile proportions matching the screenshot (${input.width} x ${input.height} px).
   - Use compact gaps (8px-16px) and paddings (12px-16px).
   - Card font sizes 13px-15px, headlines 18px-22px, small tags/badges 10px-12px.
   - The total page height should naturally fit the content (~${input.height}px).
8. NAVIGATION BAR:
   - If a bottom navigation bar exists, place it in-flow at the very bottom of the document (do NOT use position: fixed):
     width: 100%; height: 60px; display: flex; flex-direction: row; justify-content: space-around; align-items: center; background: #ffffff; border-top: 1px solid #e5e5e5; margin-top: 16px;
   - Each nav item should have an icon and a text label below it (display: flex; flex-direction: column; align-items: center; gap: 4px; font-size: 11px; color: #555;).
   - If there is a center Floating Action Button (FAB) '+', position it relative to the nav or centered.
9. ICONS, LOGOS & GRAPHICS (CRITICAL - NO BROKEN IMAGES):
   - Never emit <img> tags with missing, broken, or dummy URLs. This creates ugly grey placeholder boxes.
   - For all icons and symbols (search, bell, pin, arrow, stars, home, categories, chat, profile, plus, bulb, clock, box), use clean Unicode emojis/symbols (🔍, 🔔, ▾, →, 📍, 💡, 🕒, 📦, 🏠, ⊞, 💬, 👤, +) or clean inline SVG (<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="..."/></svg>).
   - For logos and brand titles (e.g. 'EVENT KABAADI'), render them as real HTML text with spans/colors, NOT images.
   - For photo cards, use a styled placeholder container with a subtle background and a camera/photo label or icon.
10. Add data-role attributes (header, nav, card, button, input, footer, sidebar) to the containers that deserve them.

Rule 3 is essential: flexbox containers become editable Auto Layout frames, absolute positioning does not.

IMAGE SIZE
${input.width} x ${input.height} px
${hasText ? `\nTEXT (ground truth, use verbatim)\n${textBlock}\n` : ''}
${hasPalette ? `\nPALETTE (use only these)\n${paletteBlock}\n` : ''}
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
