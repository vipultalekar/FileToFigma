import type { FrameNode, IRNode, Rect, TextNode } from '@web2figma/ir';
import { defaultLayout } from '@web2figma/ir';
import { backgroundToFills, cornerRadius, solidFromCss } from '@web2figma/transform';
import { buildSegment, buildTextStyle } from './text.js';
import type { WalkContext } from './walk.js';

/**
 * ::before and ::after synthesis (PRD section 5).
 *
 * Icons, dividers, badges and quote marks live in pseudo-elements on real
 * sites, so they are a named requirement rather than an extra. They cannot be
 * measured directly, so their box is derived by comparing the parent's border
 * box against the boxes of its real children.
 */

export interface PseudoResult {
  before: IRNode[];
  after: IRNode[];
}

const NONE = new Set(['none', 'normal', '']);

function contentText(raw: string): string | null {
  const value = raw.trim();
  if (NONE.has(value)) return null;
  // Computed content is quoted; counters and attr() are not reproducible.
  const quoted = /^"(.*)"$/s.exec(value) ?? /^'(.*)'$/s.exec(value);
  if (quoted) return (quoted[1] as string).replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex) =>
    String.fromCodePoint(parseInt(hex as string, 16)),
  );
  if (value.startsWith('url(')) return '';
  return null;
}

function px(value: string): number {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Estimate the pseudo box. A pseudo-element sits inside the parent's padding
 * box, before or after the real children, so the free space on the relevant
 * side is the best available estimate of where it rendered.
 */
function estimateRect(
  parentRect: Rect,
  cs: CSSStyleDeclaration,
  pseudo: CSSStyleDeclaration,
  childRects: Rect[],
  which: 'before' | 'after',
): Rect {
  const width = px(pseudo.width) || px(pseudo.minWidth) || 0;
  const height = px(pseudo.height) || px(pseudo.minHeight) || 0;
  const padLeft = px(cs.paddingLeft);
  const padTop = px(cs.paddingTop);
  const padRight = px(cs.paddingRight);
  const padBottom = px(cs.paddingBottom);

  const positioned = pseudo.position === 'absolute' || pseudo.position === 'fixed';
  if (positioned) {
    const left = pseudo.left !== 'auto' ? px(pseudo.left) : null;
    const top = pseudo.top !== 'auto' ? px(pseudo.top) : null;
    const right = pseudo.right !== 'auto' ? px(pseudo.right) : null;
    const bottom = pseudo.bottom !== 'auto' ? px(pseudo.bottom) : null;
    const w = width || (left !== null && right !== null ? parentRect.w - left - right : 0);
    const h = height || (top !== null && bottom !== null ? parentRect.h - top - bottom : 0);
    return {
      x: parentRect.x + (left ?? (right !== null ? parentRect.w - right - w : 0)),
      y: parentRect.y + (top ?? (bottom !== null ? parentRect.h - bottom - h : 0)),
      w: Math.max(w, 1),
      h: Math.max(h, 1),
    };
  }

  const contentLeft = parentRect.x + padLeft;
  const contentTop = parentRect.y + padTop;
  const contentRight = parentRect.x + parentRect.w - padRight;
  const contentBottom = parentRect.y + parentRect.h - padBottom;

  if (childRects.length === 0) {
    return {
      x: contentLeft,
      y: contentTop,
      w: width || contentRight - contentLeft,
      h: height || contentBottom - contentTop,
    };
  }

  const firstLeft = Math.min(...childRects.map((r) => r.x));
  const lastRight = Math.max(...childRects.map((r) => r.x + r.w));

  if (which === 'before') {
    const free = Math.max(0, firstLeft - contentLeft);
    return {
      x: contentLeft,
      y: contentTop,
      w: width || free || 1,
      h: height || contentBottom - contentTop,
    };
  }
  const free = Math.max(0, contentRight - lastRight);
  return {
    x: contentRight - (width || free || 1),
    y: contentTop,
    w: width || free || 1,
    h: height || contentBottom - contentTop,
  };
}

function build(
  el: Element,
  cs: CSSStyleDeclaration,
  parentRect: Rect,
  parentId: string,
  which: 'before' | 'after',
  ctx: WalkContext,
): IRNode[] {
  const pseudo = ctx.win.getComputedStyle(el, `::${which}`);
  const text = contentText(pseudo.content);
  if (text === null) return [];
  if (pseudo.display === 'none' || parseFloat(pseudo.opacity) === 0) return [];

  const childRects = Array.from(el.children).map((child) => {
    const r = child.getBoundingClientRect();
    return { x: r.left + ctx.origin.x, y: r.top + ctx.origin.y, w: r.width, h: r.height };
  });
  const rect = estimateRect(parentRect, cs, pseudo, childRects, which);
  if (rect.w <= 0 || rect.h <= 0) return [];

  const id = `${parentId}:${which}`;
  const fills = backgroundToFills(
    {
      color: pseudo.backgroundColor,
      image: pseudo.backgroundImage,
      size: pseudo.backgroundSize,
      position: pseudo.backgroundPosition,
      repeat: pseudo.backgroundRepeat,
      width: rect.w,
      height: rect.h,
    },
    ctx.resolveAsset,
    (property, detail) => ctx.warnings.info(id, property, detail),
  );

  const frame: FrameNode = {
    kind: 'frame',
    id,
    name: `::${which}`,
    rect,
    opacity: parseFloat(pseudo.opacity) || 1,
    visible: true,
    effects: [],
    meta: { tag: 'span', classes: [], pseudo: which, position: pseudo.position },
    children: [],
    fills,
    strokes: [],
    corner: cornerRadius(
      [
        pseudo.borderTopLeftRadius,
        pseudo.borderTopRightRadius,
        pseudo.borderBottomRightRadius,
        pseudo.borderBottomLeftRadius,
      ],
      rect.w,
      rect.h,
    ),
    clip: false,
    layout: { ...defaultLayout(), absolute: pseudo.position === 'absolute' },
  };

  if (text !== '') {
    const node: TextNode = {
      kind: 'text',
      id: `${id}:t`,
      name: text.slice(0, 24),
      rect,
      opacity: 1,
      visible: true,
      effects: [],
      meta: { tag: 'span', classes: [], pseudo: which },
      characters: text,
      segments: [buildSegment(pseudo, text.length)],
      style: buildTextStyle(pseudo, { inline: true }),
      layout: defaultLayout(),
    };
    // A text-only pseudo needs no frame around it.
    if (fills.length === 0) return [node];
    frame.children.push({ ...node, rect: { ...rect, x: rect.x, y: rect.y } });
  }

  if (fills.length === 0 && frame.children.length === 0) {
    // An empty ::before with a border is the classic divider or arrow.
    const border = solidFromCss(pseudo.borderTopColor);
    if (!border || px(pseudo.borderTopWidth) === 0) return [];
    frame.fills = [border];
  }

  ctx.warnings.info(id, 'pseudo-element', `::${which} synthesised`);
  return [frame];
}

export function synthesisePseudo(
  el: Element,
  cs: CSSStyleDeclaration,
  parentRect: Rect,
  parentId: string,
  ctx: WalkContext,
): PseudoResult {
  return {
    before: build(el, cs, parentRect, parentId, 'before', ctx),
    after: build(el, cs, parentRect, parentId, 'after', ctx),
  };
}
