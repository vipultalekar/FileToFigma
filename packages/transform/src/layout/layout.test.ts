import { beforeEach, describe, expect, it } from 'vitest';
import type { FrameNode, IRNode } from '@web2figma/ir';
import { WarningSink } from '@web2figma/shared';
import { doc, frame, image, rect, resetIds, solid, text } from '../testing/factory.js';
import { detectWrap, gapRegularity, scoreAxis, separation, alignment } from './score.js';
import { decideSizing, derivePadding, derivePrimaryAlign, deriveCounterAlign } from './sizing.js';
import { inferLayout } from './geometric.js';
import { childSizingFromFlex, constraintsFromInset, mapFlex, mapGrid } from './tier1.js';
import { cleanClassName, looksLikeButton, looksLikeCard, nameNode, nameTree } from './naming.js';
import { inferDocumentLayout } from './index.js';

beforeEach(() => resetIds());

const stack = (n: number, gap = 10, h = 40): IRNode[] =>
  Array.from({ length: n }, (_, i) =>
    frame({ rect: rect(0, i * (h + gap), 200, h), name: `item${i}` }),
  );

describe('scoreAxis', () => {
  it('scores a clean vertical stack near 1', () => {
    const s = scoreAxis(stack(4), 'vertical');
    expect(s.separation).toBe(1);
    expect(s.alignment).toBe(1);
    expect(s.gapRegularity).toBe(1);
    expect(s.score).toBeCloseTo(1);
  });

  it('scores the wrong axis low', () => {
    const s = scoreAxis(stack(4), 'horizontal');
    expect(s.score).toBeLessThan(0.65);
  });

  it('measures separation as the fraction of non-overlapping pairs', () => {
    const kids = [
      frame({ rect: rect(0, 0, 100, 50) }),
      frame({ rect: rect(0, 25, 100, 50) }), // overlaps
      frame({ rect: rect(0, 100, 100, 50) }),
    ];
    expect(separation(kids, 'vertical')).toBeCloseTo(0.5);
  });

  it('measures alignment on the counter axis', () => {
    const kids = [
      frame({ rect: rect(0, 0, 100, 20) }),
      frame({ rect: rect(0, 30, 80, 20) }),
      frame({ rect: rect(50, 60, 20, 20) }),
    ];
    expect(alignment(kids, 'vertical')).toBeCloseTo(2 / 3);
  });

  it('penalises irregular gaps', () => {
    expect(gapRegularity([10, 10, 10])).toBe(1);
    expect(gapRegularity([2, 40, 5])).toBeLessThan(0.5);
  });

  it('returns children sorted along the axis', () => {
    const kids = [
      frame({ rect: rect(0, 100, 10, 10), name: 'b' }),
      frame({ rect: rect(0, 0, 10, 10), name: 'a' }),
    ];
    expect(scoreAxis(kids, 'vertical').ordered.map((k) => k.name)).toEqual(['a', 'b']);
  });
});

describe('detectWrap', () => {
  const cards = (rows: number, perRow: number): IRNode[] => {
    const out: IRNode[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < perRow; c++) {
        out.push(frame({ rect: rect(c * 210, r * 160, 200, 150) }));
      }
    }
    return out;
  };

  it('detects a card grid', () => {
    const w = detectWrap(cards(2, 3));
    expect(w.isWrap).toBe(true);
    expect(w.rows).toHaveLength(2);
    expect(w.itemSpacing).toBe(10);
    expect(w.rowSpacing).toBe(10);
  });

  it('allows a partial trailing row', () => {
    const kids = [...cards(2, 3), frame({ rect: rect(0, 320, 200, 150) })];
    expect(detectWrap(kids).isWrap).toBe(true);
  });

  it('rejects a single row', () => {
    expect(detectWrap(cards(1, 4)).isWrap).toBe(false);
  });

  it('rejects rows of wildly different heights', () => {
    const kids = [
      frame({ rect: rect(0, 0, 200, 150) }),
      frame({ rect: rect(210, 0, 200, 150) }),
      frame({ rect: rect(0, 160, 200, 400) }),
      frame({ rect: rect(210, 160, 200, 400) }),
    ];
    expect(detectWrap(kids).isWrap).toBe(false);
  });
});

describe('padding and alignment derivation', () => {
  it('derives padding from the extreme child edges', () => {
    const parent = frame({
      rect: rect(0, 0, 200, 100),
      children: [frame({ rect: rect(16, 8, 168, 84) })],
    });
    expect(derivePadding(parent, parent.children).padding).toEqual([8, 16, 8, 16]);
  });

  it('clamps negative padding and reports overflow', () => {
    const parent = frame({
      rect: rect(0, 0, 100, 100),
      children: [frame({ rect: rect(-10, 0, 120, 100) })],
    });
    const r = derivePadding(parent, parent.children);
    expect(r.padding).toEqual([0, 0, 0, 0]);
    expect(r.overflow).toBe(true);
  });

  it('reads SPACE_BETWEEN when interior gaps dwarf the padding', () => {
    const parent = frame({ rect: rect(0, 0, 400, 40) });
    const kids = [
      frame({ rect: rect(0, 0, 80, 40) }),
      frame({ rect: rect(320, 0, 80, 40) }),
    ];
    expect(derivePrimaryAlign(parent, kids, 'HORIZONTAL', [240], [0, 0, 0, 0])).toBe(
      'SPACE_BETWEEN',
    );
  });

  it('reads CENTER on the counter axis when children share a centre', () => {
    const parent = frame({ rect: rect(0, 0, 200, 100) });
    const kids = [
      frame({ rect: rect(50, 0, 100, 20) }),
      frame({ rect: rect(75, 30, 50, 20) }),
    ];
    expect(deriveCounterAlign(parent, kids, 'VERTICAL')).toBe('CENTER');
  });
});

describe('decideSizing', () => {
  const parent = frame({ rect: rect(0, 0, 200, 100) });

  it('FILLs a child that matches the content width', () => {
    const child = frame({ rect: rect(0, 0, 200, 40) });
    expect(decideSizing(parent, child, [0, 0, 0, 0], 'VERTICAL').h).toBe('FILL');
  });

  it('HUGs text vertically so it can reflow', () => {
    const child = text({ rect: rect(0, 0, 120, 20), characters: 'hello' });
    expect(decideSizing(parent, child, [0, 0, 0, 0], 'VERTICAL').v).toBe('HUG');
  });

  it('FILLs text whose measured width is narrower than its box', () => {
    const child = text({
      rect: rect(0, 0, 200, 20),
      characters: 'hello',
      meta: { tag: 'p', classes: [], intrinsic: { w: 60, h: 20 } },
    });
    expect(decideSizing(parent, child, [0, 0, 0, 0], 'VERTICAL').h).toBe('FILL');
  });

  it('keeps wrapped cards FIXED so the wrap survives', () => {
    const child = frame({ rect: rect(0, 0, 200, 40) });
    expect(decideSizing(parent, child, [0, 0, 0, 0], 'WRAP').h).toBe('FIXED');
  });
});

describe('inferLayout (Tier 2)', () => {
  it('infers a vertical stack with even spacing', () => {
    const parent = frame({ rect: rect(0, 0, 200, 190), children: stack(4) });
    const spec = inferLayout(parent);
    expect(spec.mode).toBe('VERTICAL');
    expect(spec.itemSpacing).toBe(10);
    expect(spec.reason).toBe('geometric');
    expect(spec.confidence).toBeGreaterThan(0.65);
  });

  it('infers a horizontal row', () => {
    const kids = [0, 1, 2].map((i) => frame({ rect: rect(i * 110, 0, 100, 40) }));
    const parent = frame({ rect: rect(0, 0, 320, 40), children: kids });
    expect(inferLayout(parent).mode).toBe('HORIZONTAL');
  });

  it('falls back to absolute when children overlap chaotically', () => {
    const kids = [
      frame({ rect: rect(0, 0, 100, 100) }),
      frame({ rect: rect(20, 10, 100, 100) }),
      frame({ rect: rect(5, 60, 30, 90) }),
    ];
    const parent = frame({ rect: rect(0, 0, 200, 200), children: kids });
    const w = new WarningSink();
    const spec = inferLayout(parent, { warnings: w });
    expect(spec.mode).toBe('NONE');
    expect(spec.reason).toBe('fallback');
    expect(parent.children.every((c) => c.layout?.absolute)).toBe(true);
    expect(w.count).toBe(1);
  });

  it('emits WRAP for a card grid', () => {
    const kids: IRNode[] = [];
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) kids.push(frame({ rect: rect(c * 210, r * 160, 200, 150) }));
    }
    const parent = frame({ rect: rect(0, 0, 620, 310), children: kids });
    const spec = inferLayout(parent);
    expect(spec.mode).toBe('WRAP');
    expect(spec.counterAxisSpacing).toBe(10);
  });

  it('treats a leaf as mode NONE with full confidence', () => {
    const spec = inferLayout(frame({ rect: rect(0, 0, 10, 10) }));
    expect(spec).toMatchObject({ mode: 'NONE', reason: 'leaf', confidence: 1 });
  });

  it('turns irregular gaps into leading padding on the child frames', () => {
    const kids = [
      frame({ rect: rect(0, 0, 200, 40) }),
      frame({ rect: rect(0, 44, 200, 40) }),
      frame({ rect: rect(0, 164, 200, 40) }),
    ];
    const parent = frame({ rect: rect(0, 0, 200, 204), children: kids });
    const spec = inferLayout(parent);
    expect(spec.mode).toBe('VERTICAL');
    expect(spec.itemSpacing).toBe(0);
    expect((kids[2] as FrameNode).layout.padding[0]).toBe(80);
  });

  it('ignores absolutely positioned children when choosing an axis', () => {
    const kids = [
      ...stack(3),
      frame({
        rect: rect(10, 10, 20, 20),
        layout: { ...frame({ rect: rect(0, 0, 1, 1) }).layout, absolute: true },
      }),
    ];
    const parent = frame({ rect: rect(0, 0, 200, 140), children: kids });
    expect(inferLayout(parent).mode).toBe('VERTICAL');
  });
});

describe('Tier 1 flex mapping', () => {
  const flexFrame = (over: Partial<FrameNode['meta']['flex']> = {}, children: IRNode[] = []) =>
    frame({
      rect: rect(0, 0, 300, 100),
      children,
      meta: {
        tag: 'div',
        classes: [],
        display: 'flex',
        flex: {
          direction: 'row',
          wrap: 'nowrap',
          justifyContent: 'flex-start',
          alignItems: 'stretch',
          rowGap: 0,
          columnGap: 12,
          ...over,
        },
      },
    });

  it('maps row and column directions', () => {
    expect(mapFlex(flexFrame(), [0, 0, 0, 0])?.mode).toBe('HORIZONTAL');
    expect(mapFlex(flexFrame({ direction: 'column' }), [0, 0, 0, 0])?.mode).toBe('VERTICAL');
  });

  it('maps gap to itemSpacing', () => {
    expect(mapFlex(flexFrame(), [0, 0, 0, 0])?.itemSpacing).toBe(12);
    expect(
      mapFlex(flexFrame({ direction: 'column', rowGap: 24 }), [0, 0, 0, 0])?.itemSpacing,
    ).toBe(24);
  });

  it('maps justify-content, warning on space-around', () => {
    expect(mapFlex(flexFrame({ justifyContent: 'center' }), [0, 0, 0, 0])?.primaryAlign).toBe(
      'CENTER',
    );
    expect(
      mapFlex(flexFrame({ justifyContent: 'space-between' }), [0, 0, 0, 0])?.primaryAlign,
    ).toBe('SPACE_BETWEEN');
    const w = new WarningSink();
    const spec = mapFlex(flexFrame({ justifyContent: 'space-around' }), [0, 0, 0, 0], w);
    expect(spec?.primaryAlign).toBe('SPACE_BETWEEN');
    expect(w.all[0]?.severity).toBe('degraded');
  });

  it('maps align-items including baseline', () => {
    expect(mapFlex(flexFrame({ alignItems: 'baseline' }), [0, 0, 0, 0])?.counterAlign).toBe(
      'BASELINE',
    );
    expect(mapFlex(flexFrame({ alignItems: 'flex-end' }), [0, 0, 0, 0])?.counterAlign).toBe('MAX');
  });

  it('maps wrap to WRAP with counterAxisSpacing from row-gap', () => {
    const spec = mapFlex(flexFrame({ wrap: 'wrap', rowGap: 16 }), [0, 0, 0, 0]);
    expect(spec?.mode).toBe('WRAP');
    expect(spec?.counterAxisSpacing).toBe(16);
  });

  it('reverses children for row-reverse', () => {
    const a = frame({ rect: rect(0, 0, 10, 10), name: 'a' });
    const b = frame({ rect: rect(20, 0, 10, 10), name: 'b' });
    const node = flexFrame({ direction: 'row-reverse' }, [a, b]);
    mapFlex(node, [0, 0, 0, 0]);
    expect(node.children.map((c) => c.name)).toEqual(['b', 'a']);
  });

  it('gives a flex-grow child FILL on the main axis', () => {
    const child = frame({
      rect: rect(0, 0, 100, 40),
      meta: {
        tag: 'div',
        classes: [],
        flex: { direction: 'row', wrap: 'nowrap', justifyContent: 'flex-start', alignItems: 'stretch', rowGap: 0, columnGap: 0, grow: 1 },
      },
    });
    expect(childSizingFromFlex(flexFrame(), child, 'h').h).toBe('FILL');
  });

  it('returns null for a non-flex frame', () => {
    expect(mapFlex(frame({ rect: rect(0, 0, 10, 10) }), [0, 0, 0, 0])).toBeNull();
  });

  it('marks absolutely positioned children and derives constraints', () => {
    const child = frame({
      rect: rect(0, 0, 10, 10),
      meta: {
        tag: 'div',
        classes: [],
        position: 'absolute',
        inset: { top: 'auto', right: '0px', bottom: '0px', left: 'auto' },
      },
    });
    const node = flexFrame({}, [child]);
    mapFlex(node, [0, 0, 0, 0]);
    expect(child.layout?.absolute).toBe(true);
    expect(constraintsFromInset(child)).toEqual({ h: 'MAX', v: 'MAX' });
  });
});

describe('Tier 1 grid mapping', () => {
  const gridFrame = (cols: string[], rows: string[], children: IRNode[] = []) =>
    frame({
      rect: rect(0, 0, 600, 400),
      children,
      meta: {
        tag: 'div',
        classes: [],
        display: 'grid',
        grid: {
          templateColumns: cols,
          templateRows: rows,
          rowGap: 16,
          columnGap: 24,
          justifyContent: 'start',
          alignItems: 'stretch',
        },
      },
    });

  it('maps a single-row grid to a horizontal layout', () => {
    const r = mapGrid(gridFrame(['1fr', '1fr', '1fr'], ['auto']), [0, 0, 0, 0]);
    expect(r?.spec.mode).toBe('HORIZONTAL');
    expect(r?.spec.itemSpacing).toBe(24);
    expect(r?.spec.confidence).toBe(0.8);
  });

  it('maps a single-column grid to a vertical layout', () => {
    const r = mapGrid(gridFrame(['1fr'], ['auto', 'auto']), [0, 0, 0, 0]);
    expect(r?.spec.mode).toBe('VERTICAL');
    expect(r?.spec.itemSpacing).toBe(16);
  });

  it('groups a 2D grid into rows', () => {
    const cell = (row: number, col: number) =>
      frame({
        rect: rect(col * 200, row * 200, 180, 180),
        meta: {
          tag: 'div',
          classes: [],
          grid: {
            templateColumns: [],
            templateRows: [],
            rowGap: 0,
            columnGap: 0,
            justifyContent: 'start',
            alignItems: 'start',
            cell: { rowStart: row + 1, rowEnd: row + 2, colStart: col + 1, colEnd: col + 2 },
          },
        },
      });
    const node = gridFrame(['1fr', '1fr'], ['auto', 'auto'], [cell(0, 0), cell(0, 1), cell(1, 0), cell(1, 1)]);
    const r = mapGrid(node, [0, 0, 0, 0]);
    expect(r?.rows).toHaveLength(2);
    expect(r?.spec.mode).toBe('VERTICAL');
  });

  it('falls back when a cell spans rows', () => {
    const spanning = frame({
      rect: rect(0, 0, 100, 400),
      meta: {
        tag: 'div',
        classes: [],
        grid: {
          templateColumns: [],
          templateRows: [],
          rowGap: 0,
          columnGap: 0,
          justifyContent: 'start',
          alignItems: 'start',
          cell: { rowStart: 1, rowEnd: 3, colStart: 1, colEnd: 2 },
        },
      },
    });
    const w = new WarningSink();
    const r = mapGrid(gridFrame(['1fr', '1fr'], ['auto', 'auto'], [spanning]), [0, 0, 0, 0], w);
    expect(r?.spec.mode).toBe('NONE');
    expect(w.all[0]?.severity).toBe('degraded');
  });
});

describe('naming', () => {
  it('prefers aria-label, then testid, then content', () => {
    expect(
      nameNode(frame({ rect: rect(0, 0, 1, 1), meta: { tag: 'div', classes: [], ariaLabel: 'Main menu' } })),
    ).toBe('Main menu');
    expect(
      nameNode(frame({ rect: rect(0, 0, 1, 1), meta: { tag: 'div', classes: [], testId: 'hero' } })),
    ).toBe('hero');
  });

  it('never names a layer div', () => {
    expect(nameNode(frame({ rect: rect(0, 0, 1, 1) }))).not.toBe('div');
  });

  it('strips hashed and utility class noise', () => {
    expect(cleanClassName('css-1x2y3z')).toBeNull();
    expect(cleanClassName('px-4')).toBeNull();
    expect(cleanClassName('md:flex')).toBeNull();
    expect(cleanClassName('pricing-card')).toBe('Pricing card');
  });

  it('detects buttons and cards', () => {
    const button = frame({
      rect: rect(0, 0, 120, 40),
      fills: [solid(0, 0, 1)],
      meta: { tag: 'a', classes: [] },
      children: [text({ rect: rect(12, 10, 96, 20), characters: 'Get started' })],
      layout: { ...frame({ rect: rect(0, 0, 1, 1) }).layout, padding: [10, 12, 10, 12] },
    });
    expect(looksLikeButton(button)).toBe(true);
    expect(nameNode(button)).toBe('Button / Get started');

    const card = frame({
      rect: rect(0, 0, 300, 400),
      fills: [solid(1, 1, 1)],
      corner: [8, 8, 8, 8],
      children: [
        image({ rect: rect(0, 0, 300, 200), assetId: 'a' }),
        text({ rect: rect(16, 216, 268, 24), characters: 'Product name' }),
      ],
    });
    expect(looksLikeCard(card)).toBe(true);
  });

  it('numbers repeated sibling names', () => {
    const root = frame({
      rect: rect(0, 0, 100, 100),
      children: [
        frame({ rect: rect(0, 0, 10, 10), meta: { tag: 'section', classes: [] } }),
        frame({ rect: rect(0, 20, 10, 10), meta: { tag: 'section', classes: [] } }),
      ],
    });
    nameTree(root);
    expect(root.children.map((c) => c.name)).toEqual(['Section', 'Section 2']);
  });
});

describe('inferDocumentLayout', () => {
  it('reports coverage by reason', () => {
    const d = doc(
      frame({
        rect: rect(0, 0, 200, 190),
        children: [
          frame({ rect: rect(0, 0, 200, 40), children: stack(2) }),
          frame({ rect: rect(0, 50, 200, 40) }),
          frame({ rect: rect(0, 100, 200, 40) }),
        ],
      }),
    );
    const stats = inferDocumentLayout(d);
    expect(stats.frames).toBeGreaterThan(0);
    expect(stats.withLayout).toBeGreaterThan(0);
    expect(Object.keys(stats.byReason)).toContain('geometric');
  });

  it('leaves everything absolute when disabled (M1 behaviour)', () => {
    const d = doc(frame({ rect: rect(0, 0, 200, 100), children: stack(3) }));
    const stats = inferDocumentLayout(d, { disabled: true });
    expect(stats.withLayout).toBe(0);
    expect((d.root as FrameNode).children.every((c) => c.layout?.absolute)).toBe(true);
  });
});
