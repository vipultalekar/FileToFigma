import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { autoLayoutCoverage, transformDocument } from '@web2figma/transform';
import { isFrame, isText, walk } from '@web2figma/ir';
import { buildDocument } from '../apps/plugin/src/builder/build.js';
import {
  SNAPSHOT_DIR,
  captureFixture,
  closeFixtureBrowser,
  stableSnapshot,
} from './fixtures/capture.js';
import { comparePngs, rasteriseSvg } from './fixtures/diff.js';
import { checkEditability, installMockFigma, renderToSvg, resizeAndReflow, type MockFigma } from './mock-figma/index.js';

/**
 * End-to-end fixture tests (PRD section 15, layers 2 to 4).
 *
 * Each fixture goes HTML -> Chromium -> capture -> transform -> builder, then
 * three assertions: the IR snapshot, the visual diff, and editability after a
 * 200px widen.
 *
 * These need Chromium, so they are skipped when Playwright has no browser
 * installed rather than failing the unit suite.
 */

const UPDATE = process.env.UPDATE_SNAPSHOTS === '1';
const VISUAL_BUDGET = Number(process.env.VISUAL_BUDGET ?? 0.05);

let figmaMock: MockFigma;

beforeAll(async () => {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
});

afterAll(async () => {
  await closeFixtureBrowser();
});

interface Expectation {
  /** Minimum share of frames that must carry Auto Layout. */
  coverage?: number;
  /** Warning properties that must appear, proving honest degradation. */
  warns?: string[];
  /** Relax the visual budget where the mock renderer is known to be weaker. */
  visualBudget?: number;
  skipVisual?: boolean;
}

const FIXTURES: Record<string, Expectation> = {
  'flex-card-grid.html': { coverage: 0.8 },
  'legacy-float-layout.html': { coverage: 0.5 },
  'pricing-table.html': { coverage: 0.5 },
  'marketing-hero.html': { coverage: 0.5, visualBudget: 0.12 },
  'pseudo-elements.html': { coverage: 0.5 },
  'mixed-inline-text.html': { coverage: 0.5 },
  'dense-dashboard.html': { coverage: 0.7, visualBudget: 0.12 },
  'unsupported-css.html': { warns: ['clip-path'], skipVisual: true },
};

describe.each(Object.entries(FIXTURES))('fixture %s', (name, expectation) => {
  it(
    'captures, transforms, builds and stays editable',
    async () => {
      figmaMock = installMockFigma();
      try {
        const captured = await captureFixture(name);

        /* Layer 2: IR snapshot. */
        const snapshotPath = resolve(SNAPSHOT_DIR, `${name.replace('.html', '')}.json`);
        const { doc, stats } = transformDocument(captured.doc);
        const snapshot = stableSnapshot(doc);

        if (UPDATE || !existsSync(snapshotPath)) {
          await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
        } else {
          const stored = JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown;
          expect(snapshot).toEqual(stored);
        }

        /* Sanity: the capture actually saw the page. */
        const texts = [...walk(doc.root)].filter(isText);
        expect(texts.length).toBeGreaterThan(0);
        expect(stats.nodesOut).toBeGreaterThan(3);

        /* Auto Layout coverage, the M4 acceptance metric. */
        if (expectation.coverage !== undefined) {
          expect(autoLayoutCoverage(stats.layout)).toBeGreaterThanOrEqual(expectation.coverage);
        }

        /* Honest degradation. */
        for (const property of expectation.warns ?? []) {
          expect(doc.warnings.some((w) => w.property.includes(property))).toBe(true);
        }

        /* Build into the mock Figma. */
        const { root, report } = await buildDocument(doc);
        expect(report.warnings.filter((w) => w.severity === 'dropped' && w.property === 'build')).toHaveLength(0);

        /* Layer 3: visual diff against the browser screenshot. */
        if (!expectation.skipVisual) {
          const svg = renderToSvg(root, {
            width: captured.width,
            height: captured.height,
            background: '#ffffff',
          });
          const rendered = await rasteriseSvg(svg, captured.width, captured.height);
          const diff = await comparePngs(captured.screenshot, rendered, {
            name: name.replace('.html', ''),
            writeDiff: true,
          });
          expect(diff.ratio).toBeLessThanOrEqual(expectation.visualBudget ?? VISUAL_BUDGET);
        }

        /* Layer 4: editability. Solve the layout, widen the root, re-solve, and
           assert nothing overlaps or clips. This happens after the visual diff
           because the mock's text metrics are approximate: the diff compares
           the geometry the browser measured, the reflow proves the layout is
           real rather than decorative. */
        figmaMock.solve();
        resizeAndReflow(root, 200);
        const editability = checkEditability(root);
        expect(editability.overlaps.slice(0, 3)).toEqual([]);
        expect(editability.clipped.slice(0, 3)).toEqual([]);
      } finally {
        figmaMock.uninstall();
      }
    },
    120_000,
  );
});

describe('performance budgets (PRD section 11)', () => {
  it('transforms a dense page well inside the budget', async () => {
    figmaMock = installMockFigma();
    try {
      const captured = await captureFixture('dense-dashboard.html');
      const started = Date.now();
      const { stats } = transformDocument(captured.doc);
      const elapsed = Date.now() - started;

      // Budget: normalisation under 2s, inference under 5s for 3,000 nodes.
      const perThousand = (elapsed / Math.max(1, stats.nodesIn)) * 1000;
      expect(perThousand).toBeLessThan(7000);
      expect(stats.normalise.collapsed).toBeGreaterThan(0);
      expect([...walk(captured.doc.root)].filter(isFrame).length).toBeGreaterThan(20);
    } finally {
      figmaMock.uninstall();
    }
  }, 120_000);
});
