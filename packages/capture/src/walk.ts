import type {
  FrameNode,
  IRNode,
  ImageNode,
  Rect,
  TextNode,
  VectorNode,
} from '@web2figma/ir';
import { defaultLayout } from '@web2figma/ir';
import { WarningSink, pathId } from '@web2figma/shared';
import { AssetStore, averageColorOf } from './images.js';
import { solidFromCss as solidPaintFromCss } from '@web2figma/transform';
import { extractMeta, extractVisualStyles, type UrlResolver } from './styles.js';
import { extractTextRuns, hasDirectText } from './text.js';
import { synthesisePseudo } from './pseudo.js';

/**
 * The DOM walk (PRD section 5). For each element the decision is skip, descend,
 * emit as leaf, or rasterise.
 *
 * Everything in this file is read-only with respect to the DOM: all mutations
 * happened in preparePage, so reads never interleave with writes and the walk
 * cannot thrash layout.
 */

const SKIP_TAGS = new Set([
  'script',
  'style',
  'meta',
  'link',
  'noscript',
  'template',
  'head',
  'title',
  'base',
  'br',
  'wbr',
  'source',
  'track',
  'param',
]);

const RASTER_TAGS = new Set(['canvas', 'video', 'object', 'embed']);

export interface WalkContext {
  doc: Document;
  win: Window;
  assets: AssetStore;
  warnings: WarningSink;
  /** Added to every client rect to reach document coordinates. */
  origin: { x: number; y: number };
  /** The capture bounds in document coordinates. */
  bounds: Rect;
  resolveAsset: UrlResolver;
}

export interface WalkResult {
  node: IRNode | null;
  /** Nodes to splice into the parent alongside this one (pseudo-elements). */
  extras: IRNode[];
}

function toDocRect(rect: DOMRect, origin: { x: number; y: number }): Rect {
  return { x: rect.left + origin.x, y: rect.top + origin.y, w: rect.width, h: rect.height };
}

function outsideBounds(rect: Rect, bounds: Rect): boolean {
  return (
    rect.x + rect.w < bounds.x - 1 ||
    rect.y + rect.h < bounds.y - 1 ||
    rect.x > bounds.x + bounds.w + 1 ||
    rect.y > bounds.y + bounds.h + 1
  );
}

function hasVisibleText(el: Element): boolean {
  return (el.textContent ?? '').trim().length > 0;
}

/**
 * The children the browser actually paints, which is not the same list as
 * `el.children` once web components are involved:
 *
 *  - a shadow host renders its shadow tree, not its light DOM children;
 *  - a <slot> inside that shadow tree renders the light DOM nodes assigned to
 *    it, at the slot's position.
 *
 * Walking `el.children` on a shadow host therefore captures nothing at all,
 * which is why a page built from web components used to import as an empty
 * frame. Closed shadow roots stay invisible: the DOM gives a content script no
 * way in, and the subtree is reported as a `dropped` warning by the caller.
 */
export function renderedChildren(el: Element): Element[] {
  const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  if (shadow) return Array.from(shadow.children);

  if (el.tagName.toLowerCase() === 'slot') {
    const slot = el as HTMLSlotElement;
    const assigned = slot.assignedElements?.({ flatten: true }) ?? [];
    // An empty slot falls back to its own children, exactly as the browser does.
    return assigned.length > 0 ? [...assigned] : Array.from(el.children);
  }

  return Array.from(el.children);
}

/** True when the element hides a subtree we have no way to read. */
function hasClosedShadowRoot(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (!tag.includes('-')) return false;
  const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
  // A custom element with no reachable shadow root and no light children is
  // almost always a closed root rendering content we cannot see.
  return shadow === null && el.children.length === 0 && (el.textContent ?? '').trim() === '';
}

function shouldSkip(el: Element, cs: CSSStyleDeclaration, rect: Rect, ctx: WalkContext): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return true;
  if (cs.display === 'none') return true;
  if (cs.visibility === 'hidden' && !hasVisibleText(el)) return true;
  // Emptiness is judged on the rendered children: a shadow host has no light
  // DOM children but paints a whole tree.
  const childCount = renderedChildren(el).length;
  if (parseFloat(cs.opacity) === 0 && childCount === 0) return true;
  if (rect.w <= 0 && rect.h <= 0 && childCount === 0) return true;
  if (el.getAttribute('aria-hidden') === 'true' && !hasVisibleText(el)) return true;
  if (outsideBounds(rect, ctx.bounds) && childCount === 0) return true;
  return false;
}

async function rasteriseElement(
  el: Element,
  rect: Rect,
  id: string,
  ctx: WalkContext,
  reason: string,
): Promise<IRNode> {
  const assetId = await ctx.assets.fromElement(el);
  if (!assetId) {
    // Nothing rasterisable: keep the box with its average colour so the layout
    // holds its shape, and say so.
    const color = averageColorOf(el);
    ctx.warnings.dropped(id, reason, `could not rasterise <${el.tagName.toLowerCase()}>`, 'average colour');
    return {
      kind: 'frame',
      id,
      name: el.tagName.toLowerCase(),
      rect,
      opacity: 1,
      visible: true,
      effects: [],
      meta: { tag: el.tagName.toLowerCase(), classes: [] },
      children: [],
      fills: [{ type: 'SOLID', color, opacity: 1 }],
      strokes: [],
      corner: [0, 0, 0, 0],
      clip: false,
      layout: defaultLayout(),
    };
  }
  ctx.warnings.degraded(id, reason, `<${el.tagName.toLowerCase()}> rasterised`, 'image fill');
  return {
    kind: 'image',
    id,
    name: el.tagName.toLowerCase(),
    rect,
    opacity: 1,
    visible: true,
    effects: [],
    meta: { tag: el.tagName.toLowerCase(), classes: [] },
    assetId,
    scaleMode: 'FILL',
    corner: [0, 0, 0, 0],
    strokes: [],
    layout: defaultLayout(),
  };
}

function serialiseSvg(el: SVGElement, cs: CSSStyleDeclaration): string {
  const clone = el.cloneNode(true) as SVGElement;
  // currentColor has no meaning once the SVG leaves the page.
  const color = cs.color || '#000';
  const inline = (node: Element): void => {
    for (const attr of ['fill', 'stroke']) {
      const v = node.getAttribute(attr);
      if (v === 'currentColor') node.setAttribute(attr, color);
    }
    const style = node.getAttribute('style');
    if (style?.includes('currentColor')) {
      node.setAttribute('style', style.replace(/currentColor/g, color));
    }
    for (const child of Array.from(node.children)) inline(child);
  };
  inline(clone);
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (!clone.getAttribute('viewBox')) {
    const box = el.getBoundingClientRect();
    clone.setAttribute('viewBox', `0 0 ${Math.max(1, box.width)} ${Math.max(1, box.height)}`);
  }
  return new XMLSerializer().serializeToString(clone);
}

export async function walkElement(
  el: Element,
  ctx: WalkContext,
  path: number[],
  parentCs: CSSStyleDeclaration | null,
): Promise<WalkResult> {
  const id = pathId(path);
  const cs = ctx.win.getComputedStyle(el);
  const rect = toDocRect(el.getBoundingClientRect(), ctx.origin);
  const tag = el.tagName.toLowerCase();

  if (shouldSkip(el, cs, rect, ctx)) return { node: null, extras: [] };

  const styles = extractVisualStyles(cs, { w: rect.w, h: rect.h }, ctx.resolveAsset, (property, detail) =>
    ctx.warnings.dropped(id, property, detail),
  );
  const meta = extractMeta(el, cs, parentCs);

  /* --- rasterise: canvas, video, foreign iframes, unsupported CSS ---------- */
  if (RASTER_TAGS.has(tag)) {
    return { node: await rasteriseElement(el, rect, id, ctx, tag), extras: [] };
  }
  if (tag === 'iframe') {
    const frame = el as HTMLIFrameElement;
    let sameOrigin = false;
    try {
      sameOrigin = Boolean(frame.contentDocument);
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      ctx.warnings.degraded(id, 'iframe', 'cross-origin iframe cannot be captured', 'empty frame');
      return {
        node: {
          kind: 'frame',
          id,
          name: 'Embed',
          rect,
          opacity: styles.opacity,
          visible: true,
          effects: styles.effects,
          meta,
          children: [],
          fills: styles.fills.length > 0 ? styles.fills : [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }],
          strokes: styles.strokes,
          corner: styles.corner,
          clip: true,
          layout: defaultLayout(),
        },
        extras: [],
      };
    }
  }
  if (styles.rasterise) {
    return { node: await rasteriseElement(el, rect, id, ctx, styles.rasterise), extras: [] };
  }

  /* --- vector ------------------------------------------------------------- */
  if (tag === 'svg') {
    const vector: VectorNode = {
      kind: 'vector',
      id,
      name: meta.ariaLabel ?? 'Icon',
      rect,
      opacity: styles.opacity,
      visible: true,
      effects: styles.effects,
      meta,
      svg: serialiseSvg(el as SVGElement, cs),
      layout: defaultLayout(),
    };
    if (styles.rotation !== undefined) vector.rotation = styles.rotation;
    return { node: vector, extras: [] };
  }

  /* --- image -------------------------------------------------------------- */
  if (tag === 'img' || tag === 'picture') {
    const target = tag === 'picture' ? (el.querySelector('img') ?? el) : el;
    const assetId = await ctx.assets.fromElement(target);
    if (!assetId) {
      ctx.warnings.dropped(id, 'image', `could not inline ${(target as HTMLImageElement).src ?? ''}`, 'placeholder');
    }
    const objectFit = cs.objectFit || 'fill';
    const node: ImageNode = {
      kind: 'image',
      id,
      name: el.getAttribute('alt') || meta.ariaLabel || 'Image',
      rect,
      opacity: styles.opacity,
      visible: true,
      effects: styles.effects,
      meta,
      assetId: assetId ?? '',
      scaleMode: objectFit === 'contain' ? 'FIT' : objectFit === 'none' ? 'CROP' : 'FILL',
      corner: styles.corner,
      strokes: styles.strokes,
      layout: defaultLayout(),
    };
    if (styles.rotation !== undefined) node.rotation = styles.rotation;
    return { node, extras: [] };
  }

  /* --- frame -------------------------------------------------------------- */
  const frame: FrameNode = {
    kind: 'frame',
    id,
    name: tag,
    rect,
    opacity: styles.opacity,
    visible: true,
    effects: styles.effects,
    meta,
    children: [],
    fills: styles.fills,
    strokes: styles.strokes,
    corner: styles.corner,
    clip: styles.clip,
    layout: defaultLayout(),
  };
  if (styles.rotation !== undefined) frame.rotation = styles.rotation;
  if (styles.blend) frame.blendMode = styles.blend as FrameNode['blendMode'];

  if (hasClosedShadowRoot(el)) {
    ctx.warnings.degraded(
      id,
      'shadow-dom',
      `<${tag}> renders a closed shadow root, which a content script cannot read`,
      'empty frame',
    );
  }

  // Non-uniform borders become thin edge frames: Figma has no per-side stroke.
  for (const side of styles.nonUniformBorders) {
    const edge = edgeFrame(frame, side, `${id}:edge-${side.side}`);
    if (edge) frame.children.push(edge);
  }

  // Pseudo-elements carry icons, dividers and badges on real sites.
  const pseudo = synthesisePseudo(el, cs, rect, id, ctx);
  frame.children.push(...pseudo.before);

  // Own text runs, positioned by Range rects rather than the parent box.
  if (hasDirectText(el)) {
    let index = 0;
    for (const run of extractTextRuns(el, cs, ctx.origin)) {
      const textNode: TextNode = {
        kind: 'text',
        id: `${id}:t${index++}`,
        name: run.characters.slice(0, 24),
        rect: run.rect,
        opacity: 1,
        visible: true,
        effects: [],
        meta: { ...meta, intrinsic: run.intrinsic },
        characters: run.characters,
        segments: [run.segment],
        style: run.style,
        layout: defaultLayout(),
      };
      frame.children.push(textNode);
    }
  }

  // Element children, following the *rendered* tree rather than the light DOM.
  const kids = renderedChildren(el);
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i] as Element;
    const result = await walkElement(child, ctx, [...path, i], cs);
    if (result.node) frame.children.push(result.node);
    frame.children.push(...result.extras);
  }

  frame.children.push(...pseudo.after);
  return { node: frame, extras: [] };
}


/** One side of a non-uniform border, as a 1-frame-thick rectangle. */
function edgeFrame(
  parent: FrameNode,
  side: { side: 'top' | 'right' | 'bottom' | 'left'; width: number; color: string; style: string },
  id: string,
): FrameNode | null {
  const { w, h } = parent.rect;
  const rects: Record<string, Rect> = {
    top: { x: parent.rect.x, y: parent.rect.y, w, h: side.width },
    bottom: { x: parent.rect.x, y: parent.rect.y + h - side.width, w, h: side.width },
    left: { x: parent.rect.x, y: parent.rect.y, w: side.width, h },
    right: { x: parent.rect.x + w - side.width, y: parent.rect.y, w: side.width, h },
  };
  const rect = rects[side.side];
  if (!rect || rect.w <= 0 || rect.h <= 0) return null;
  const paint = solidPaintFromCss(side.color);
  if (!paint) return null;
  return {
    kind: 'frame',
    id,
    name: `Border ${side.side}`,
    rect,
    opacity: 1,
    visible: true,
    effects: [],
    meta: { tag: 'div', classes: [], position: 'absolute' },
    children: [],
    fills: [paint],
    strokes: [],
    corner: [0, 0, 0, 0],
    clip: false,
    layout: { ...defaultLayout(), absolute: true, constraints: { h: 'STRETCH', v: 'STRETCH' } },
  };
}
