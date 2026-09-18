import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FontRequest } from '@web2figma/ir';
import { doc, frame, rect, resetIds, solid, text } from '@web2figma/transform';
import { buildDocument } from '../apps/plugin/src/builder/build.js';
import { installMockFigma, type MockFigma, MockTextNode } from './mock-figma/index.js';

/**
 * Regression: font resolution used to reach only the deduplicated FontRequest
 * instances that collectFonts returned. Every other text segment carried its
 * own object with the same key, never learned what its font resolved to, and
 * silently fell back to Inter — on every import, for most of the text.
 */

let figmaMock: MockFigma;

beforeEach(() => {
  resetIds();
  figmaMock = installMockFigma();
});

afterEach(() => figmaMock.uninstall());

/** A fresh object each time, exactly as capture produces per text run. */
const georgia = (): FontRequest => ({
  family: 'Georgia',
  weight: 700,
  italic: false,
  fallbackStack: ['serif'],
  classification: 'serif',
});

function pageWithRepeatedFont(count: number) {
  const runs = Array.from({ length: count }, (_, i) =>
    text({
      rect: rect(0, i * 30, 400, 24),
      characters: `Serif heading ${i + 1}`,
      segments: [
        {
          start: 0,
          end: 15,
          // Separate instances, same font: the shape that exposed the bug.
          font: georgia(),
          size: 24,
          color: solid(0, 0, 0),
        },
      ],
    }),
  );
  return doc(frame({ rect: rect(0, 0, 400, count * 30), name: 'Page', children: runs }));
}

describe('font resolution reaches every segment', () => {
  it('applies the resolved font to all text nodes, not just the first', async () => {
    const { report } = await buildDocument(pageWithRepeatedFont(5));

    const texts = figmaMock.created.filter(
      (n): n is MockTextNode => n instanceof MockTextNode,
    );
    expect(texts).toHaveLength(5);

    for (const node of texts) {
      // Georgia is not installed in the mock, so it resolves to Source Serif Pro.
      expect(node.fontName.family).toBe('Source Serif Pro');
      // The ranged style has to be applied too, which is the half that broke.
      expect(node.ranges[0]?.font).toEqual({ family: 'Source Serif Pro', style: 'Bold' });
    }

    // One substitution reported, not five: the dedupe itself still works.
    expect(report.fontSubstitutions).toHaveLength(1);
    expect(report.fontSubstitutions[0]).toMatchObject({ requested: 'Georgia 700' });
    expect(report.warnings.filter((w) => w.property === 'text-range')).toHaveLength(0);
  });

  it('leaves a segment alone when its font cannot be resolved at all', async () => {
    const { report } = await buildDocument(pageWithRepeatedFont(2));
    // Nothing dropped: an unresolvable font still lands on the Inter fallback.
    expect(report.warnings.filter((w) => w.severity === 'dropped')).toHaveLength(0);
  });
});
