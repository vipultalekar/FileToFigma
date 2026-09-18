import { beforeEach, describe, expect, it } from 'vitest';
import { isFrame, walk } from '@web2figma/ir';
import { doc, frame, image, rect, resetIds, solid, text } from './testing/factory.js';
import { DEFAULT_BREAKPOINTS, combineDocuments } from './combine.js';

beforeEach(() => resetIds());

const capture = (width: number, height = 400) =>
  doc(
    frame({
      rect: rect(0, 0, width, height),
      name: 'Page',
      fills: [solid(1, 1, 1)],
      children: [
        text({ rect: rect(16, 16, width - 32, 24), characters: 'Heading' }),
        image({ rect: rect(16, 56, width - 32, 200), assetId: 'a1' }),
      ],
    }),
    {
      images: { a1: { bytes: 'AAAA', mime: 'image/png', width: 10, height: 10, hash: 'h1' } },
      fonts: [
        {
          family: 'Inter',
          weight: 400,
          italic: false,
          fallbackStack: [],
          classification: 'sans-serif',
        },
      ],
    },
  );

describe('combineDocuments', () => {
  it('returns the document untouched when there is only one', () => {
    const only = capture(1440);
    expect(combineDocuments([{ doc: only, label: 'Desktop' }])).toBe(only);
  });

  it('lays breakpoints out in a row with a gap', () => {
    const combined = combineDocuments(
      [
        { doc: capture(1440), label: 'Desktop', width: 1440 },
        { doc: capture(768), label: 'Tablet', width: 768 },
        { doc: capture(390), label: 'Mobile', width: 390 },
      ],
      { gap: 100 },
    );

    expect(isFrame(combined.root)).toBe(true);
    const kids = isFrame(combined.root) ? combined.root.children : [];
    expect(kids.map((k) => k.rect.x)).toEqual([0, 1540, 2408]);
    expect(kids.map((k) => k.name)).toEqual([
      'Desktop · 1440',
      'Tablet · 768',
      'Mobile · 390',
    ]);
    // Wrapper spans the row without a trailing gap.
    expect(combined.root.rect.w).toBe(1440 + 100 + 768 + 100 + 390);
  });

  it('names a frame after the requested viewport, not the captured width', () => {
    // A fixed-width page reports the same document width at every breakpoint;
    // naming from that made all three frames read as identical.
    const combined = combineDocuments([
      { doc: capture(1200), label: 'Desktop', width: 1440 },
      { doc: capture(1200), label: 'Mobile', width: 390 },
    ]);
    const kids = isFrame(combined.root) ? combined.root.children : [];
    expect(kids.map((k) => k.name)).toEqual(['Desktop · 1440', 'Mobile · 390']);
  });

  it('keeps each breakpoint at its captured width', () => {
    const combined = combineDocuments([
      { doc: capture(1440), label: 'Desktop' },
      { doc: capture(390), label: 'Mobile' },
    ]);
    const kids = isFrame(combined.root) ? combined.root.children : [];
    expect(kids.every((k) => k.layout.sizing.h === 'FIXED')).toBe(true);
    expect(isFrame(combined.root) && combined.root.layout.mode).toBe('HORIZONTAL');
  });

  it('namespaces node ids so two captures cannot collide', () => {
    const combined = combineDocuments([
      { doc: capture(1440), label: 'Desktop' },
      { doc: capture(390), label: 'Mobile' },
    ]);
    const ids = [...walk(combined.root)].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith('b0:')).length).toBeGreaterThan(0);
    expect(ids.filter((id) => id.startsWith('b1:')).length).toBeGreaterThan(0);
  });

  it('namespaces assets and keeps every reference pointing at the right one', () => {
    const combined = combineDocuments([
      { doc: capture(1440), label: 'Desktop' },
      { doc: capture(390), label: 'Mobile' },
    ]);
    expect(Object.keys(combined.images).sort()).toEqual(['b0-a1', 'b1-a1']);
    const assetIds = [...walk(combined.root)]
      .filter((n) => n.kind === 'image')
      .map((n) => (n as { assetId: string }).assetId);
    expect(assetIds.sort()).toEqual(['b0-a1', 'b1-a1']);
  });

  it('merges fonts without duplicating them', () => {
    const combined = combineDocuments([
      { doc: capture(1440), label: 'Desktop' },
      { doc: capture(390), label: 'Mobile' },
    ]);
    expect(combined.fonts).toHaveLength(1);
  });

  it('carries warnings across with prefixed node ids', () => {
    const a = capture(1440);
    a.warnings = [{ nodeId: 'f1', severity: 'degraded', property: 'clip-path', message: 'x' }];
    const combined = combineDocuments([
      { doc: a, label: 'Desktop' },
      { doc: capture(390), label: 'Mobile' },
    ]);
    expect(combined.warnings[0]?.nodeId).toBe('b0:f1');
  });

  it('offers the conventional breakpoint set', () => {
    expect(DEFAULT_BREAKPOINTS.map((b) => b.width)).toEqual([1440, 768, 390]);
  });
});
