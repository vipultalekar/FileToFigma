import type { FrameNode, IRDocument, IRNode, Warning } from '@web2figma/ir';
import { IR_VERSION, defaultLayout, isFrame, isImage, walk } from '@web2figma/ir';
import { fontKey } from './mapping/text.js';

/**
 * Combine several captures of the same page into one document, laid out side by
 * side. This is how a responsive import arrives in Figma: one frame per
 * breakpoint, in a row, rather than three separate pastes.
 *
 * It runs on *transformed* documents, where rects are already parent-relative,
 * so placing a capture only means setting its root's x. Running it on raw IR
 * would break the rebase pass, which measures children against their own root.
 */

export interface CombineInput {
  doc: IRDocument;
  /** Shown as the frame name: "Desktop", "Tablet", "Mobile", ... */
  label: string;
  /**
   * The viewport width this capture was requested at. The frame is named after
   * it rather than after the captured document width, which on a fixed-width
   * page is the same number at every breakpoint and reads as a bug.
   */
  width?: number;
}

export interface CombineOptions {
  /** Gap between breakpoint frames, in px. */
  gap?: number;
  name?: string;
}

export function combineDocuments(
  inputs: readonly CombineInput[],
  options: CombineOptions = {},
): IRDocument {
  if (inputs.length === 0) throw new Error('combineDocuments needs at least one document');
  const first = inputs[0] as CombineInput;
  if (inputs.length === 1) return first.doc;

  const gap = options.gap ?? 120;
  const children: IRNode[] = [];
  const images: IRDocument['images'] = {};
  const warnings: Warning[] = [];
  const fonts = new Map<string, IRDocument['fonts'][number]>();

  let offset = 0;
  let tallest = 0;

  inputs.forEach((input, index) => {
    const prefix = `b${index}`;
    // Ids must not collide: they key the plugin data the escape hatches read,
    // and the "select affected layers" action in the report.
    namespace(input.doc, prefix);

    const root = input.doc.root;
    root.name = `${input.label} · ${Math.round(input.width ?? root.rect.w)}`;
    root.rect = { ...root.rect, x: offset, y: 0 };
    children.push(root);

    offset += root.rect.w + gap;
    tallest = Math.max(tallest, root.rect.h);

    Object.assign(images, input.doc.images);
    warnings.push(...input.doc.warnings);
    for (const font of input.doc.fonts) {
      const key = fontKey(font);
      if (!fonts.has(key)) fonts.set(key, font);
    }
  });

  const root: FrameNode = {
    kind: 'frame',
    id: 'breakpoints',
    name: options.name ?? 'Breakpoints',
    rect: { x: 0, y: 0, w: Math.max(0, offset - gap), h: tallest },
    opacity: 1,
    visible: true,
    effects: [],
    meta: { tag: 'div', classes: [] },
    children,
    fills: [],
    strokes: [],
    corner: [0, 0, 0, 0],
    clip: false,
    layout: {
      ...defaultLayout(),
      mode: 'HORIZONTAL',
      itemSpacing: gap,
      counterAlign: 'MIN',
      sizing: { h: 'HUG', v: 'HUG' },
      confidence: 1,
      reason: 'flex',
    },
  };

  // Each breakpoint keeps the width it was captured at; only the wrapper hugs.
  for (const child of children) {
    child.layout = { ...child.layout, sizing: { h: 'FIXED', v: 'FIXED' } };
  }

  return {
    version: IR_VERSION,
    source: {
      kind: first.doc.source.kind,
      ref: first.doc.source.ref,
      capturedAt: first.doc.source.capturedAt,
    },
    viewport: first.doc.viewport,
    root,
    fonts: [...fonts.values()],
    images,
    warnings,
  };
}

/** Prefix every node id and asset id in a document so two can be merged. */
function namespace(doc: IRDocument, prefix: string): void {
  const assetMap = new Map<string, string>();
  for (const id of Object.keys(doc.images)) {
    const next = `${prefix}-${id}`;
    assetMap.set(id, next);
    doc.images[next] = doc.images[id] as IRDocument['images'][string];
    delete doc.images[id];
  }

  for (const node of walk(doc.root)) {
    node.id = `${prefix}:${node.id}`;
    if (isImage(node)) node.assetId = assetMap.get(node.assetId) ?? node.assetId;
    if (isFrame(node)) {
      for (const fill of node.fills) {
        if (fill.type === 'IMAGE') fill.assetId = assetMap.get(fill.assetId) ?? fill.assetId;
      }
    }
  }

  doc.warnings = doc.warnings.map((w) => ({
    ...w,
    nodeId: w.nodeId === '' ? '' : `${prefix}:${w.nodeId}`,
  }));
}

/** The breakpoint set the UI offers, widest first so the row reads naturally. */
export const DEFAULT_BREAKPOINTS: { label: string; width: number }[] = [
  { label: 'Desktop', width: 1440 },
  { label: 'Tablet', width: 768 },
  { label: 'Mobile', width: 390 },
];
