import { beforeEach, describe, expect, it } from 'vitest';
import { isFrame, isText, walk } from '@web2figma/ir';
import type { FrameNode, TextNode } from '@web2figma/ir';
import { WarningSink } from '@web2figma/shared';
import { doc, frame, image, rect, resetIds, solid, text } from '../testing/factory.js';
import { collapseWrappers } from './collapse.js';
import { dedupeAssets } from './dedupeAssets.js';
import { mergeTextRuns } from './mergeText.js';
import { prune } from './prune.js';
import { rebaseCoordinates } from './rebase.js';
import { resolveStacking } from './stacking.js';
import { normalise } from './index.js';

beforeEach(() => resetIds());

describe('prune', () => {
  it('drops zero-area and invisible leaves', () => {
    const root = frame({
      rect: rect(0, 0, 100, 100),
      children: [
        text({ rect: rect(0, 0, 50, 0), characters: 'zero height' }),
        frame({ rect: rect(0, 0, 10, 10), visible: false }),
        text({ rect: rect(0, 10, 50, 20), characters: 'keep' }),
      ],
    });
    const out = prune(root) as FrameNode;
    expect(out.children).toHaveLength(1);
    expect((out.children[0] as TextNode).characters).toBe('keep');
  });

  it('keeps a zero-size frame that still positions children', () => {
    const root = frame({
      rect: rect(0, 0, 100, 100),
      children: [
        frame({
          rect: rect(0, 0, 0, 0),
          children: [text({ rect: rect(5, 5, 20, 10), characters: 'hi' })],
        }),
      ],
    });
    expect((prune(root) as FrameNode).children).toHaveLength(1);
  });

  it('logs a warning when it removes nodes', () => {
    const w = new WarningSink();
    prune(
      frame({
        rect: rect(0, 0, 10, 10),
        children: [frame({ rect: rect(0, 0, 0, 0) })],
      }),
      w,
    );
    expect(w.count).toBe(1);
  });
});

describe('collapseWrappers', () => {
  it('replaces an undecorated single-child wrapper with its child', () => {
    const leaf = text({ rect: rect(0, 0, 100, 20), characters: 'Hello' });
    const root = frame({
      rect: rect(0, 0, 100, 20),
      children: [
        frame({
          rect: rect(0, 0, 100, 20),
          children: [frame({ rect: rect(0, 0, 100, 20), children: [leaf] })],
        }),
      ],
    });
    const { root: out, stats } = collapseWrappers(root);
    expect(stats.removed).toBe(2);
    expect((out as FrameNode).children[0]).toBe(leaf);
  });

  it('keeps a wrapper that paints', () => {
    const root = frame({
      rect: rect(0, 0, 100, 20),
      children: [
        frame({
          rect: rect(0, 0, 100, 20),
          fills: [solid(1, 0, 0)],
          children: [text({ rect: rect(0, 0, 100, 20), characters: 'x' })],
        }),
      ],
    });
    expect(collapseWrappers(root).stats.removed).toBe(0);
  });

  it('keeps a wrapper whose box differs from its child', () => {
    const root = frame({
      rect: rect(0, 0, 100, 40),
      children: [
        frame({
          rect: rect(0, 0, 100, 40),
          children: [text({ rect: rect(10, 10, 80, 20), characters: 'x' })],
        }),
      ],
    });
    expect(collapseWrappers(root).stats.removed).toBe(0);
  });

  it('never collapses the root away', () => {
    const child = text({ rect: rect(0, 0, 10, 10), characters: 'x' });
    const root = frame({ rect: rect(0, 0, 10, 10), children: [child] });
    const { root: out } = collapseWrappers(root);
    expect(isFrame(out)).toBe(true);
  });
});

describe('rebaseCoordinates', () => {
  it('converts document-absolute rects to parent-relative', () => {
    const root = frame({
      rect: rect(0, 100, 200, 200),
      children: [
        frame({
          rect: rect(20, 140, 100, 50),
          children: [text({ rect: rect(30, 150, 40, 10), characters: 'deep' })],
        }),
      ],
    });
    rebaseCoordinates(root);
    expect(root.rect).toEqual({ x: 0, y: 0, w: 200, h: 200 });
    const mid = root.children[0] as FrameNode;
    expect(mid.rect).toEqual({ x: 20, y: 40, w: 100, h: 50 });
    expect(mid.children[0]!.rect).toEqual({ x: 10, y: 10, w: 40, h: 10 });
  });

  it('is idempotent', () => {
    const root = frame({
      rect: rect(0, 50, 100, 100),
      children: [frame({ rect: rect(10, 60, 20, 20) })],
    });
    rebaseCoordinates(root);
    rebaseCoordinates(root);
    expect(root.children[0]!.rect.y).toBe(10);
  });
});

describe('resolveStacking', () => {
  it('orders siblings by paint order, not DOM order', () => {
    const root = frame({
      rect: rect(0, 0, 100, 100),
      children: [
        frame({ rect: rect(0, 0, 10, 10), name: 'positive', meta: { tag: 'div', classes: [], position: 'absolute', zIndex: 5 } }),
        frame({ rect: rect(0, 0, 10, 10), name: 'static' }),
        frame({ rect: rect(0, 0, 10, 10), name: 'negative', meta: { tag: 'div', classes: [], position: 'absolute', zIndex: -1 } }),
      ],
    });
    resolveStacking(root);
    expect(root.children.map((c) => c.name)).toEqual(['negative', 'static', 'positive']);
  });

  it('is stable for equal layers', () => {
    const root = frame({
      rect: rect(0, 0, 10, 10),
      children: [
        frame({ rect: rect(0, 0, 1, 1), name: 'a' }),
        frame({ rect: rect(0, 0, 1, 1), name: 'b' }),
        frame({ rect: rect(0, 0, 1, 1), name: 'c' }),
      ],
    });
    resolveStacking(root);
    expect(root.children.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeTextRuns', () => {
  it('merges adjacent runs into one node with offset segments', () => {
    const a = text({ rect: rect(0, 0, 40, 20), characters: 'Hello ' });
    const b = text({ rect: rect(40, 0, 30, 20), characters: 'world' });
    const root = frame({ rect: rect(0, 0, 100, 20), children: [a, b] });
    mergeTextRuns(root);
    expect(root.children).toHaveLength(1);
    const merged = root.children[0] as TextNode;
    expect(merged.characters).toBe('Hello world');
    expect(merged.segments).toHaveLength(2);
    expect(merged.segments[1]).toMatchObject({ start: 6, end: 11 });
    expect(merged.rect).toEqual({ x: 0, y: 0, w: 70, h: 20 });
  });

  it('inserts a space when a run wraps to the next line', () => {
    const a = text({ rect: rect(0, 0, 40, 20), characters: 'Hello' });
    const b = text({ rect: rect(0, 20, 30, 20), characters: 'world' });
    const root = frame({ rect: rect(0, 0, 100, 40), children: [a, b] });
    mergeTextRuns(root);
    expect((root.children[0] as TextNode).characters).toBe('Hello world');
  });

  it('does not merge across an intervening image', () => {
    const root = frame({
      rect: rect(0, 0, 100, 20),
      children: [
        text({ rect: rect(0, 0, 20, 20), characters: 'a' }),
        image({ rect: rect(20, 0, 20, 20), assetId: 'x' }),
        text({ rect: rect(40, 0, 20, 20), characters: 'b' }),
      ],
    });
    mergeTextRuns(root);
    expect(root.children).toHaveLength(3);
  });

  it('does not merge runs far apart vertically', () => {
    const root = frame({
      rect: rect(0, 0, 100, 200),
      children: [
        text({ rect: rect(0, 0, 20, 20), characters: 'a' }),
        text({ rect: rect(0, 120, 20, 20), characters: 'b' }),
      ],
    });
    mergeTextRuns(root);
    expect(root.children).toHaveLength(2);
  });
});

describe('dedupeAssets', () => {
  it('collapses identical payloads and rewrites references', () => {
    const d = doc(
      frame({
        rect: rect(0, 0, 100, 100),
        children: [
          image({ rect: rect(0, 0, 50, 50), assetId: 'a' }),
          image({ rect: rect(50, 0, 50, 50), assetId: 'b' }),
        ],
      }),
      {
        images: {
          a: { bytes: 'AAAA', mime: 'image/png', width: 1, height: 1, hash: 'h1' },
          b: { bytes: 'AAAA', mime: 'image/png', width: 1, height: 1, hash: 'h1' },
        },
      },
    );
    const stats = dedupeAssets(d);
    expect(stats.after).toBe(1);
    const ids = [...walk(d.root)].filter((n) => n.kind === 'image').map((n) => (n as never as { assetId: string }).assetId);
    expect(new Set(ids).size).toBe(1);
  });

  it('drops unreferenced assets', () => {
    const d = doc(frame({ rect: rect(0, 0, 10, 10) }), {
      images: { orphan: { bytes: 'X', mime: 'image/png', width: 1, height: 1, hash: 'h' } },
    });
    dedupeAssets(d);
    expect(Object.keys(d.images)).toHaveLength(0);
  });
});

describe('normalise', () => {
  it('runs every pass in order and reports stats', () => {
    const d = doc(
      frame({
        rect: rect(0, 0, 200, 100),
        children: [
          frame({
            rect: rect(0, 0, 200, 40),
            children: [
              frame({
                rect: rect(0, 0, 200, 40),
                children: [text({ rect: rect(10, 10, 80, 20), characters: 'Title' })],
              }),
            ],
          }),
          frame({ rect: rect(0, 0, 0, 0) }),
        ],
      }),
    );
    const stats = normalise(d);
    expect(stats.collapsed).toBeGreaterThan(0);
    const texts = [...walk(d.root)].filter(isText);
    expect(texts).toHaveLength(1);
    // Rebased: the text sits inside its parent, not at document coordinates.
    expect(texts[0]!.rect.x).toBe(10);
  });
});
