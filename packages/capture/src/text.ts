import type { Rect, TextSegment, TextStyle } from '@web2figma/ir';
import {
  autoResize,
  letterSpacing as mapLetterSpacing,
  lineClamp,
  lineHeight as mapLineHeight,
  solidFromCss,
  textAlign,
  textCase,
  textDecoration,
  toFontRequest,
  verticalAlign,
} from '@web2figma/transform';

/**
 * Text run extraction (PRD section 5).
 *
 * An element can hold both text and element children, so each text run is
 * measured with Range.getClientRects rather than taking the parent's box.
 * Adjacent runs are merged back into one node with ranged segments by the
 * normalisation pass.
 */

export interface TextRun {
  characters: string;
  rect: Rect;
  /** Measured width of the glyphs, which drives HUG versus FILL. */
  intrinsic: { w: number; h: number };
  segment: TextSegment;
  style: TextStyle;
}

function unionRects(rects: DOMRectList | DOMRect[]): DOMRect | null {
  const list = Array.from(rects).filter((r) => r.width > 0 || r.height > 0);
  if (list.length === 0) return null;
  const left = Math.min(...list.map((r) => r.left));
  const top = Math.min(...list.map((r) => r.top));
  const right = Math.max(...list.map((r) => r.right));
  const bottom = Math.max(...list.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

export function buildTextStyle(cs: CSSStyleDeclaration, opts: { inline: boolean }): TextStyle {
  const fontSize = parseFloat(cs.fontSize) || 16;
  const clamped = lineClamp((cs as unknown as { webkitLineClamp?: string }).webkitLineClamp ?? null);
  const truncate = cs.textOverflow === 'ellipsis';
  const style: TextStyle = {
    align: textAlign(cs.textAlign, cs.direction),
    verticalAlign: verticalAlign(cs.verticalAlign),
    lineHeight: mapLineHeight(cs.lineHeight, fontSize),
    letterSpacing: mapLetterSpacing(cs.letterSpacing, fontSize),
    autoResize: autoResize({ truncate, clamped: clamped !== undefined, inline: opts.inline }),
  };
  const tc = textCase(cs.textTransform);
  if (tc) style.case = tc;
  if (truncate) style.truncate = true;
  if (clamped !== undefined) style.maxLines = clamped;
  return style;
}

export function buildSegment(
  cs: CSSStyleDeclaration,
  length: number,
  link?: string,
): TextSegment {
  const size = parseFloat(cs.fontSize) || 16;
  const segment: TextSegment = {
    start: 0,
    end: length,
    font: toFontRequest(cs.fontFamily, cs.fontWeight, cs.fontStyle),
    size,
    color: solidFromCss(cs.color) ?? { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 },
  };
  const decoration = textDecoration(cs.textDecorationLine || cs.textDecoration);
  if (decoration) segment.decoration = decoration;
  if (link) segment.link = link;
  return segment;
}

/**
 * Collect the direct text children of an element as measured runs. Whitespace
 * between block elements produces empty runs, which are dropped here rather
 * than becoming empty layers.
 */
export function extractTextRuns(
  el: Element,
  cs: CSSStyleDeclaration,
  origin: { x: number; y: number },
): TextRun[] {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  const runs: TextRun[] = [];
  const inline = /^(inline|inline-block|inline-flex)$/.test(cs.display);
  const href = el.closest('a')?.getAttribute('href') ?? undefined;

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType !== win.Node.TEXT_NODE) continue;
    const raw = child.textContent ?? '';
    const characters = raw.replace(/\s+/g, ' ');
    if (characters.trim() === '') continue;

    const range = doc.createRange();
    range.selectNodeContents(child);
    const box = unionRects(range.getClientRects());
    const measured = range.getBoundingClientRect();
    range.detach?.();
    if (!box || box.width <= 0 || box.height <= 0) continue;

    const style = buildTextStyle(cs, { inline });
    runs.push({
      characters,
      rect: {
        x: box.left + origin.x,
        y: box.top + origin.y,
        w: box.width,
        h: box.height,
      },
      intrinsic: { w: measured.width, h: measured.height },
      segment: buildSegment(cs, characters.length, href),
      style,
    });
  }
  return runs;
}

/** True when this element's own text should be emitted as text nodes. */
export function hasDirectText(el: Element): boolean {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 && (child.textContent ?? '').trim() !== '') return true;
  }
  return false;
}
