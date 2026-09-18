import type {
  FrameNode,
  IRDocument,
  IRNode,
  ImageNode,
  NodeMeta,
  Paint,
  Rect,
  TextNode,
} from '@web2figma/ir';
import { IR_VERSION, defaultLayout } from '@web2figma/ir';

/**
 * Hand-built IR for unit tests and fixtures. Kept in src (not a test file) so
 * the fixture tools and the mock-Figma harness can use it too.
 */

let counter = 0;
const nextId = (prefix: string): string => `${prefix}${++counter}`;

export function resetIds(): void {
  counter = 0;
}

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

export const solid = (r: number, g: number, b: number, opacity = 1): Paint => ({
  type: 'SOLID',
  color: { r, g, b },
  opacity,
});

export function frame(
  init: Partial<FrameNode> & { rect: Rect },
): FrameNode {
  const meta: NodeMeta = { tag: 'div', classes: [], ...(init.meta ?? {}) };
  return {
    id: init.id ?? nextId('f'),
    name: init.name ?? 'Frame',
    kind: 'frame',
    rect: init.rect,
    opacity: init.opacity ?? 1,
    visible: init.visible ?? true,
    effects: init.effects ?? [],
    meta,
    children: init.children ?? [],
    fills: init.fills ?? [],
    strokes: init.strokes ?? [],
    corner: init.corner ?? [0, 0, 0, 0],
    clip: init.clip ?? false,
    layout: init.layout ?? defaultLayout(),
    ...(init.rotation !== undefined ? { rotation: init.rotation } : {}),
    ...(init.blendMode !== undefined ? { blendMode: init.blendMode } : {}),
  };
}

export function text(
  init: Partial<TextNode> & { rect: Rect; characters: string },
): TextNode {
  const font = {
    family: 'Inter',
    weight: 400,
    italic: false,
    fallbackStack: [],
    classification: 'sans-serif' as const,
  };
  return {
    id: init.id ?? nextId('t'),
    name: init.name ?? init.characters.slice(0, 24),
    kind: 'text',
    rect: init.rect,
    opacity: init.opacity ?? 1,
    visible: init.visible ?? true,
    effects: init.effects ?? [],
    meta: { tag: 'span', classes: [], ...(init.meta ?? {}) },
    characters: init.characters,
    segments: init.segments ?? [
      {
        start: 0,
        end: init.characters.length,
        font,
        size: 16,
        color: solid(0, 0, 0),
      },
    ],
    style: init.style ?? {
      align: 'LEFT',
      verticalAlign: 'TOP',
      lineHeight: { unit: 'AUTO' },
      letterSpacing: { unit: 'PIXELS', value: 0 },
      autoResize: 'HEIGHT',
    },
    layout: init.layout ?? defaultLayout(),
  };
}

export function image(
  init: Partial<ImageNode> & { rect: Rect; assetId: string },
): ImageNode {
  return {
    id: init.id ?? nextId('i'),
    name: init.name ?? 'Image',
    kind: 'image',
    rect: init.rect,
    opacity: init.opacity ?? 1,
    visible: init.visible ?? true,
    effects: init.effects ?? [],
    meta: { tag: 'img', classes: [], ...(init.meta ?? {}) },
    assetId: init.assetId,
    scaleMode: init.scaleMode ?? 'FILL',
    corner: init.corner ?? [0, 0, 0, 0],
    strokes: init.strokes ?? [],
    layout: init.layout ?? defaultLayout(),
  };
}

export function doc(root: IRNode, init: Partial<IRDocument> = {}): IRDocument {
  return {
    version: IR_VERSION,
    source: { kind: 'html', ref: 'test', capturedAt: '2026-01-01T00:00:00.000Z' },
    viewport: { width: root.rect.w, height: root.rect.h, dpr: 1 },
    root,
    fonts: [],
    images: {},
    warnings: [],
    ...init,
  };
}
