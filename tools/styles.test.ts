import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { doc, frame, rect, resetIds, solid, text, transformDocument } from '@web2figma/transform';
import { buildDocument } from '../apps/plugin/src/builder/build.js';
import { collectStyleCandidates, nameColor } from '../apps/plugin/src/builder/styles.js';
import { installMockFigma, type MockFigma, type MockNode } from './mock-figma/index.js';

/**
 * Figma style creation. The interesting behaviour is the threshold: a style per
 * one-off colour leaves a designer with a list to delete, so only values the
 * page actually repeats earn one.
 */

let figmaMock: MockFigma;

beforeEach(() => {
  resetIds();
  figmaMock = installMockFigma();
});

afterEach(() => figmaMock.uninstall());

const brand = solid(0.145, 0.388, 0.922); // #2563EB

function page() {
  const buttons = Array.from({ length: 4 }, (_, i) =>
    frame({
      rect: rect(0, i * 60, 200, 48),
      name: `Button ${i + 1}`,
      fills: [brand],
      children: [
        text({
          rect: rect(12, i * 60 + 14, 176, 20),
          characters: `Action ${i + 1}`,
          segments: [
            {
              start: 0,
              end: 8,
              font: {
                family: 'Inter',
                weight: 600,
                italic: false,
                fallbackStack: [],
                classification: 'sans-serif',
              },
              size: 16,
              color: solid(1, 1, 1),
            },
          ],
        }),
      ],
    }),
  );
  // A colour used exactly once must not become a style.
  buttons.push(
    frame({ rect: rect(0, 260, 200, 48), name: 'One off', fills: [solid(0.9, 0.2, 0.4)] }),
  );
  return doc(frame({ rect: rect(0, 0, 200, 320), name: 'Page', children: buttons }));
}

describe('nameColor', () => {
  it('names colours by hue family, tone step and hex', () => {
    // #2563EB is blue-600 in every design system that ships a ramp.
    expect(nameColor({ r: 0.145, g: 0.388, b: 0.922 }, 1)).toBe('Blue 600 / 2563EB');
    expect(nameColor({ r: 1, g: 1, b: 1 }, 1)).toBe('White / FFFFFF');
    expect(nameColor({ r: 0, g: 0, b: 0 }, 1)).toBe('Black / 000000');
    expect(nameColor({ r: 0.5, g: 0.5, b: 0.5 }, 1)).toMatch(/^Grey/);
  });

  it('records a translucent colour in the name', () => {
    expect(nameColor({ r: 0, g: 0, b: 0 }, 0.5)).toBe('Black / 000000 50%');
  });
});

describe('collectStyleCandidates', () => {
  it('keeps only values used at least the threshold number of times', () => {
    const { doc: ir } = transformDocument(page());
    const { colors, texts } = collectStyleCandidates(ir, { minUses: 3 });
    // The brand blue and the white text repeat; the one-off pink does not.
    expect(colors.size).toBe(2);
    expect(texts.size).toBe(0); // fonts are unresolved until the builder runs
  });

  it('lowering the threshold admits more values', () => {
    const { doc: ir } = transformDocument(page());
    expect(collectStyleCandidates(ir, { minUses: 1 }).colors.size).toBeGreaterThan(2);
  });
});

describe('style binding never destroys paints', () => {
  /**
   * Binding a style replaces a node's whole paints array. Binding one built
   * from a single solid onto a node that stacks a gradient over a colour, or
   * onto the fill of a node whose *stroke* supplied the colour, silently
   * rewrites the design. These only bind where it is unambiguous.
   */
  const gradient = {
    type: 'GRADIENT_LINEAR' as const,
    stops: [
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
    ],
    transform: [
      [1, 0, 0],
      [0, 1, 0],
    ] as [[number, number, number], [number, number, number]],
  };

  it('leaves a multi-fill node alone', async () => {
    const layered = Array.from({ length: 4 }, (_, i) =>
      frame({
        rect: rect(0, i * 60, 200, 48),
        name: `Layered ${i + 1}`,
        meta: { tag: 'div', classes: [], testId: `layered-${i}` },
        // A solid under a gradient: exactly what a hero section looks like.
        fills: [brand, gradient],
      }),
    );
    const ir = doc(frame({ rect: rect(0, 0, 200, 260), name: 'Page', children: layered }));
    const { doc: transformed } = transformDocument(ir);
    await buildDocument(transformed, { createStyles: true, minStyleUses: 3 });

    // The style exists, but nothing was bound, so both paints survive.
    expect(figmaMock.styles.some((s) => s.name.includes('Blue'))).toBe(true);
    const built = figmaMock.created.filter((n: MockNode) => n.name.startsWith('layered-'));
    expect(built).toHaveLength(4);
    for (const node of built) {
      expect(node.fillStyleId).toBe('');
      expect(node.fills).toHaveLength(2);
    }
  });

  it('binds a stroke colour to the stroke, never to the fill', async () => {
    const outlined = Array.from({ length: 4 }, (_, i) =>
      frame({
        rect: rect(0, i * 60, 200, 48),
        name: `Outlined ${i + 1}`,
        meta: { tag: 'div', classes: [], testId: `outlined-${i}` },
        fills: [solid(1, 1, 1)],
        strokes: [{ paint: brand, weight: 1, align: 'INSIDE' }],
      }),
    );
    const ir = doc(frame({ rect: rect(0, 0, 200, 260), name: 'Page', children: outlined }));
    const { doc: transformed } = transformDocument(ir);
    await buildDocument(transformed, { createStyles: true, minStyleUses: 3 });

    const built = figmaMock.created.filter((n: MockNode) => n.name.startsWith('outlined-'));
    expect(built).toHaveLength(4);
    for (const node of built) {
      expect(node.strokeStyleId).not.toBe('');
      // The white fill must not have been replaced by the blue stroke colour.
      expect(node.fills[0]).toMatchObject({ color: { r: 1, g: 1, b: 1 } });
    }
  });

  it('does not flatten text that carries ranged formatting', async () => {
    const font = (weight: number) => ({
      family: 'Inter',
      weight,
      italic: false,
      fallbackStack: [],
      classification: 'sans-serif' as const,
    });
    const mixed = Array.from({ length: 4 }, (_, i) =>
      text({
        rect: rect(0, i * 30, 400, 24),
        characters: 'Regular and bold together',
        segments: [
          { start: 0, end: 12, font: font(400), size: 16, color: solid(0, 0, 0) },
          { start: 12, end: 25, font: font(700), size: 16, color: solid(0, 0, 0) },
        ],
      }),
    );
    const ir = doc(frame({ rect: rect(0, 0, 400, 130), name: 'Page', children: mixed }));
    const { doc: transformed } = transformDocument(ir);
    await buildDocument(transformed, { createStyles: true, minStyleUses: 3 });

    const built = figmaMock.created.filter((n: MockNode) => n.type === 'TEXT');
    expect(built).toHaveLength(4);
    for (const node of built) {
      expect(node.textStyleId).toBe('');
      expect(node.fillStyleId).toBe('');
    }
  });
});

describe('applyStyles through the builder', () => {
  it('creates and binds colour and text styles when asked', async () => {
    const { doc: ir } = transformDocument(page());
    const { report } = await buildDocument(ir, { createStyles: true, minStyleUses: 3 });

    expect(report.stylesCreated).toBeDefined();
    expect(figmaMock.styles.length).toBeGreaterThan(0);
    expect(figmaMock.styles.some((s) => s.name.includes('Blue'))).toBe(true);
    expect(figmaMock.styles.some((s) => s.type === 'TEXT')).toBe(true);

    // Every button frame should carry the paint style binding.
    const bound = figmaMock.created.filter((n: MockNode) => n.fillStyleId !== '');
    expect(bound.length).toBeGreaterThanOrEqual(4);

    const textNodes = figmaMock.created.filter((n: MockNode) => n.type === 'TEXT');
    expect(textNodes.every((n) => n.textStyleId !== '')).toBe(true);
  });

  it('creates nothing when the option is off', async () => {
    const { doc: ir } = transformDocument(page());
    const { report } = await buildDocument(ir);
    expect(report.stylesCreated).toBeUndefined();
    expect(figmaMock.styles).toHaveLength(0);
  });

  it('names styles under one prefix so they group in the picker', async () => {
    const { doc: ir } = transformDocument(page());
    await buildDocument(ir, { createStyles: true, minStyleUses: 3 });
    expect(figmaMock.styles.every((s) => s.name.startsWith('Web/'))).toBe(true);
  });
});
