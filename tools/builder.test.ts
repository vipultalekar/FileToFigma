import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IRDocument } from '@web2figma/ir';
import { IR_VERSION, defaultLayout } from '@web2figma/ir';
import { doc, frame, image, rect, resetIds, solid, text, transformDocument } from '@web2figma/transform';
import { buildDocument } from '../apps/plugin/src/builder/build.js';
import { pickStyle, resolveFont } from '../apps/plugin/src/builder/fonts.js';
import { flattenInferredLayouts } from '../apps/plugin/src/builder/escapeHatches.js';
import {
  checkEditability,
  describeTree,
  findByName,
  installMockFigma,
  renderToSvg,
  resizeAndReflow,
  type MockFigma,
  type MockNode,
  MockTextNode,
} from './mock-figma/index.js';

/**
 * Builder tests (PRD section 15). They run the real builder against the mock
 * Figma API, which is how M0, M2 and the editability assertion are verified
 * without a Figma session.
 */

let figmaMock: MockFigma;

beforeEach(() => {
  resetIds();
  figmaMock = installMockFigma();
});

afterEach(() => figmaMock.uninstall());

const asDoc = (root: ReturnType<typeof frame>): IRDocument => doc(root);

describe('font resolution ladder', () => {
  const available = [
    { family: 'Inter', style: 'Regular' },
    { family: 'Inter', style: 'Bold' },
    { family: 'Inter', style: 'Medium' },
    { family: 'Roboto Mono', style: 'Regular' },
    { family: 'Source Serif Pro', style: 'Regular' },
  ];

  it('takes an exact match first', () => {
    const r = resolveFont(
      { family: 'Inter', weight: 400, italic: false, fallbackStack: [], classification: 'sans-serif' },
      available,
    );
    expect(r).toMatchObject({ substituted: false, via: 'exact' });
  });

  it('falls to the nearest weight in the same family', () => {
    const r = resolveFont(
      { family: 'Inter', weight: 500, italic: false, fallbackStack: [], classification: 'sans-serif' },
      available,
    );
    expect(r.resolved.style).toBe('Medium');
    expect(r.via).toBe('weight');
  });

  it('uses the substitution table for common web fonts', () => {
    const r = resolveFont(
      { family: 'SF Pro Text', weight: 400, italic: false, fallbackStack: [], classification: 'sans-serif' },
      available,
    );
    expect(r.resolved.family).toBe('Inter');
    expect(r.substituted).toBe(true);
  });

  it('falls back by classification for an unknown serif', () => {
    const r = resolveFont(
      { family: 'Whatever Serif', weight: 400, italic: false, fallbackStack: [], classification: 'serif' },
      available,
    );
    expect(r.resolved.family).toBe('Source Serif Pro');
    expect(r.via).toBe('classification');
  });

  it('picks the nearest available weight name', () => {
    expect(pickStyle(['Regular', 'Bold'], 700, false)).toBe('Bold');
    expect(pickStyle(['Regular', 'Bold'], 500, false)).toBe('Regular');
    expect(pickStyle(['Regular', 'Italic'], 400, true)).toBe('Italic');
  });
});

describe('M0 walking skeleton', () => {
  it('builds a blue frame containing a text node and a rectangle', async () => {
    const ir = asDoc(
      frame({
        rect: rect(0, 0, 400, 240),
        name: 'Demo',
        fills: [solid(0.15, 0.35, 0.95)],
        corner: [12, 12, 12, 12],
        children: [
          text({ rect: rect(24, 24, 352, 32), characters: 'Hello from Web2Figma' }),
          frame({ rect: rect(24, 72, 352, 120), name: 'Rectangle', fills: [solid(1, 1, 1)] }),
        ],
      }),
    );
    const { root, report } = await buildDocument(ir);

    expect(root.type).toBe('FRAME');
    expect(root.fills[0]).toMatchObject({ type: 'SOLID' });
    expect(root.children).toHaveLength(2);
    expect(root.children[0]?.type).toBe('TEXT');
    expect((root.children[0] as MockTextNode).characters).toBe('Hello from Web2Figma');
    expect(report.nodesCreated).toMatchObject({ frame: 2, text: 1 });
    expect(report.warnings.filter((w) => w.severity === 'dropped')).toHaveLength(0);
  });

  it('loads every font before setting characters', async () => {
    const ir = asDoc(
      frame({
        rect: rect(0, 0, 200, 60),
        children: [
          text({
            rect: rect(0, 0, 200, 20),
            characters: 'Bold text',
            segments: [
              {
                start: 0,
                end: 9,
                font: {
                  family: 'Inter',
                  weight: 700,
                  italic: false,
                  fallbackStack: [],
                  classification: 'sans-serif',
                },
                size: 16,
                color: solid(0, 0, 0),
              },
            ],
          }),
        ],
      }),
    );
    // The mock throws from setRangeFontName when the font was not loaded, so a
    // clean build is the assertion.
    const { report } = await buildDocument(ir);
    expect(report.warnings.some((w) => w.property === 'text-range')).toBe(false);
  });
});

describe('style application', () => {
  it('applies radius, stroke, shadow and clipping', async () => {
    const ir = asDoc(
      frame({
        rect: rect(0, 0, 100, 100),
        name: 'Card',
        fills: [solid(1, 1, 1)],
        strokes: [{ paint: solid(0, 0, 0, 0.1), weight: 2, align: 'INSIDE', dash: [6, 4] }],
        corner: [8, 8, 8, 8],
        clip: true,
        effects: [
          {
            type: 'DROP_SHADOW',
            color: { r: 0, g: 0, b: 0, a: 0.2 },
            offset: { x: 0, y: 4 },
            radius: 8,
            spread: 0,
          },
        ],
      }),
    );
    const { root } = await buildDocument(ir);
    expect(root.topLeftRadius).toBe(8);
    expect(root.strokeWeight).toBe(2);
    expect(root.dashPattern).toEqual([6, 4]);
    expect(root.clipsContent).toBe(true);
    expect(root.effects[0]).toMatchObject({ type: 'DROP_SHADOW', radius: 8 });
  });

  it('registers image assets once and reuses the hash', async () => {
    const ir = doc(
      frame({
        rect: rect(0, 0, 100, 100),
        children: [
          image({ rect: rect(0, 0, 50, 50), assetId: 'a1' }),
          image({ rect: rect(50, 0, 50, 50), assetId: 'a1' }),
        ],
      }),
      {
        images: {
          a1: { bytes: 'AAAA', mime: 'image/png', width: 10, height: 10, hash: 'h1' },
        },
      },
    );
    const { root } = await buildDocument(ir);
    expect(figmaMock.images).toHaveLength(1);
    const fills = root.children.map((c) => c.fills[0]);
    expect(fills.every((f) => f?.type === 'IMAGE')).toBe(true);
  });

  it('substitutes a placeholder and keeps going when a node throws', async () => {
    const ir = asDoc(
      frame({
        rect: rect(0, 0, 100, 100),
        children: [
          { ...frame({ rect: rect(0, 0, 50, 50) }), kind: 'vector', svg: 'not an svg' } as never,
          frame({ rect: rect(0, 50, 50, 50), name: 'Survivor' }),
        ],
      }),
    );
    const { root, report } = await buildDocument(ir);
    expect(root.children).toHaveLength(2);
    expect(findByName(root, 'Survivor')).toBeDefined();
    expect(report.warnings.some((w) => w.property === 'svg')).toBe(true);
  });
});

describe('M2 auto layout', () => {
  const cardGrid = (): IRDocument => {
    const cards = Array.from({ length: 6 }, (_, i) =>
      frame({
        rect: rect((i % 3) * 210, Math.floor(i / 3) * 160, 200, 150),
        name: `Card ${i + 1}`,
        fills: [solid(1, 1, 1)],
        children: [text({ rect: rect(16, 16, 168, 20), characters: `Card ${i + 1}` })],
      }),
    );
    return asDoc(
      frame({
        rect: rect(0, 0, 640, 310),
        name: 'Grid',
        meta: {
          tag: 'div',
          classes: [],
          display: 'flex',
          flex: {
            direction: 'row',
            wrap: 'wrap',
            justifyContent: 'flex-start',
            alignItems: 'flex-start',
            rowGap: 10,
            columnGap: 10,
          },
        },
        children: cards,
      }),
    );
  };

  it('imports a flexbox card grid with auto layout throughout', async () => {
    const { doc: transformed, stats } = transformDocument(cardGrid());
    expect(stats.layout.byReason.flex).toBeGreaterThan(0);

    const { root, report } = await buildDocument(transformed);
    expect(root.layoutMode).toBe('HORIZONTAL');
    expect(root.layoutWrap).toBe('WRAP');
    expect(report.autoLayoutCoverage.withLayout).toBeGreaterThan(0);
  });

  it('reflows the cards when the root frame is widened by 200px', async () => {
    const { doc: transformed } = transformDocument(cardGrid());
    const { root } = await buildDocument(transformed);
    figmaMock.solve();

    // Three cards per row at 640px; at 940px a fourth fits, so card 4 must
    // move up into the first row. That is the reflow M2 is asked to prove.
    expect(root.children[3]?.y).toBeGreaterThan(0);
    resizeAndReflow(root, 300);
    expect(root.children[3]?.y).toBe(root.children[0]?.y);
    const report = checkEditability(root);
    expect(report.overlaps).toEqual([]);
    expect(report.clipped).toEqual([]);
  });

  it('keeps children inside a widened vertical stack', async () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      frame({
        rect: rect(0, i * 60, 400, 50),
        name: `Row ${i + 1}`,
        fills: [solid(0.9, 0.9, 0.9)],
      }),
    );
    const { doc: transformed } = transformDocument(
      asDoc(frame({ rect: rect(0, 0, 400, 230), name: 'Stack', children: rows })),
    );
    const { root } = await buildDocument(transformed);
    figmaMock.solve();
    resizeAndReflow(root, 200);

    expect(root.layoutMode).toBe('VERTICAL');
    for (const child of root.children) {
      expect(child.x + child.width).toBeLessThanOrEqual(root.width + 0.5);
    }
    expect(checkEditability(root).overlaps).toEqual([]);
  });

  it('positions absolute children last so layout does not move them', async () => {
    const overlay = frame({
      rect: rect(300, 10, 60, 24),
      name: 'Badge',
      fills: [solid(1, 0.8, 0)],
      meta: {
        tag: 'div',
        classes: [],
        testId: 'Badge',
        position: 'absolute',
        inset: { top: '10px', right: '10px', bottom: 'auto', left: 'auto' },
      },
    });
    const ir = asDoc(
      frame({
        rect: rect(0, 0, 400, 200),
        name: 'Hero',
        children: [
          frame({ rect: rect(0, 0, 400, 80), name: 'Top', fills: [solid(0.9, 0.9, 0.9)], meta: { tag: 'div', classes: [], testId: 'Top' } }),
          frame({ rect: rect(0, 90, 400, 80), name: 'Bottom', fills: [solid(0.8, 0.8, 0.8)], meta: { tag: 'div', classes: [], testId: 'Bottom' } }),
          overlay,
        ],
      }),
    );
    const { doc: transformed } = transformDocument(ir);
    const { root } = await buildDocument(transformed);
    const badge = findByName(root, 'Badge') as MockNode;
    expect(badge.layoutPositioning).toBe('ABSOLUTE');
    expect(badge.x).toBe(300);
    expect(badge.constraints.horizontal).toBe('MAX');
  });
});

describe('escape hatches', () => {
  it('flattens only low-confidence inferred layouts', async () => {
    const messy = frame({
      rect: rect(0, 0, 200, 200),
      name: 'Messy',
      meta: { tag: 'div', classes: [], testId: 'Messy' },
      children: [
        frame({ rect: rect(0, 0, 120, 120), name: 'a', fills: [solid(0.5, 0.5, 0.5)] }),
        frame({ rect: rect(30, 20, 120, 120), name: 'b', fills: [solid(0.5, 0.5, 0.5)] }),
        frame({ rect: rect(10, 90, 60, 100), name: 'c', fills: [solid(0.5, 0.5, 0.5)] }),
      ],
    });
    const clean = frame({
      rect: rect(0, 210, 200, 130),
      name: 'Clean',
      meta: { tag: 'div', classes: [], testId: 'Clean' },
      children: [
        frame({ rect: rect(0, 210, 200, 40), name: 'x', fills: [solid(0.5, 0.5, 0.5)] }),
        frame({ rect: rect(0, 260, 200, 40), name: 'y', fills: [solid(0.5, 0.5, 0.5)] }),
        frame({ rect: rect(0, 310, 200, 40), name: 'z', fills: [solid(0.5, 0.5, 0.5)] }),
      ],
    });
    const { doc: transformed } = transformDocument(
      asDoc(frame({ rect: rect(0, 0, 200, 350), name: 'Root', children: [messy, clean] })),
    );
    const { root } = await buildDocument(transformed);

    const cleanNode = findByName(root, 'Clean') as MockNode;
    expect(cleanNode.layoutMode).not.toBe('NONE');

    const flattened = flattenInferredLayouts([root], 0.99);
    expect(flattened).toBeGreaterThan(0);
    expect(cleanNode.layoutMode).toBe('NONE');
  });
});

describe('svg rendering harness', () => {
  it('renders a built tree to SVG for the visual diff', async () => {
    const ir = asDoc(
      frame({
        rect: rect(0, 0, 200, 100),
        name: 'Root',
        fills: [solid(1, 1, 1)],
        children: [text({ rect: rect(10, 10, 180, 20), characters: 'Diff me' })],
      }),
    );
    const { root } = await buildDocument(ir);
    const svg = renderToSvg(root, { width: 200, height: 100 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('Diff me');
    expect(describeTree(root)).toContain('Root');
  });
});

describe('report', () => {
  it('records coverage, substitutions and warnings', async () => {
    const ir = asDoc(
      frame({
        rect: rect(0, 0, 200, 100),
        children: [
          text({
            rect: rect(0, 0, 200, 20),
            characters: 'Georgia text',
            segments: [
              {
                start: 0,
                end: 12,
                font: {
                  family: 'Georgia',
                  weight: 400,
                  italic: false,
                  fallbackStack: ['serif'],
                  classification: 'serif',
                },
                size: 16,
                color: solid(0, 0, 0),
              },
            ],
          }),
        ],
      }),
    );
    const { doc: transformed } = transformDocument(ir);
    const { report } = await buildDocument(transformed);
    expect(report.fontSubstitutions[0]).toMatchObject({ requested: 'Georgia 400' });
    expect(report.autoLayoutCoverage.frames).toBeGreaterThan(0);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects an unsupported IR version', async () => {
    const ir = { ...asDoc(frame({ rect: rect(0, 0, 10, 10) })), version: IR_VERSION + 1 };
    expect(() => transformDocument(ir)).toThrow(/version/i);
  });

  it('keeps the default layout export in sync with the builder expectations', () => {
    expect(defaultLayout().mode).toBe('NONE');
  });
});
