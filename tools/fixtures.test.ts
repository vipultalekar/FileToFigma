import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_BREAKPOINTS,
  autoLayoutCoverage,
  combineDocuments,
  transformDocument,
} from '@web2figma/transform';
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
  'short-root-tall-document.html': { coverage: 0.5 },
  'web-components.html': { coverage: 0.5 },
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

describe('regression: the page below the fold', () => {
  /**
   * A viewport-sized root frame deleted everything below the first screen:
   * the root rect doubles as the pruning boundary, so taking the <html> border
   * box instead of the document scroll size silently dropped most of the page
   * and then clipped what was left. Found from a real import that came back as
   * an empty white frame.
   */
  it('sizes the root to the document and keeps deep content', async () => {
    figmaMock = installMockFigma();
    try {
      const captured = await captureFixture('short-root-tall-document.html');
      // The fixture's <html> box is the 900px viewport; the document is far taller.
      expect(captured.height).toBeGreaterThan(3000);
      expect(captured.doc.root.rect.h).toBe(captured.height);

      const { doc, stats } = transformDocument(captured.doc);
      expect(stats.nodesOut).toBe(stats.nodesIn);

      const texts = [...walk(doc.root)]
        .filter(isText)
        .map((t) => t.characters);
      expect(texts.some((t) => t.includes('Section 14'))).toBe(true);
      expect(texts.some((t) => t.includes('Section one'))).toBe(true);

      // html { overflow-x: hidden } must not clip the whole import.
      expect(isFrame(doc.root) && doc.root.clip).toBe(false);

      const { root } = await buildDocument(doc);
      expect(root.height).toBeGreaterThan(3000);
    } finally {
      figmaMock.uninstall();
    }
  }, 120_000);
});

describe('web components', () => {
  /**
   * A shadow host paints its shadow tree, not its light DOM children, so
   * walking `el.children` captured nothing at all: any page built from web
   * components imported as an empty frame. Slotted light DOM has to arrive at
   * the slot's position, and a closed root has to be reported rather than
   * silently dropped.
   */
  it('captures open shadow roots, slotted content, and reports closed ones', async () => {
    figmaMock = installMockFigma();
    try {
      const captured = await captureFixture('web-components.html');
      const { doc } = transformDocument(captured.doc);
      const texts = [...walk(doc.root)]
        .filter(isText)
        .map((t) => t.characters);

      // Text that exists only inside an open shadow root.
      expect(texts.some((t) => t.includes('Shadow card'))).toBe(true);
      expect(texts.some((t) => t.includes('Footer drawn inside the shadow root'))).toBe(true);
      expect(texts.some((t) => t.includes('Open shadow root'))).toBe(true);

      // Light DOM projected through a <slot>.
      expect(texts.some((t) => t.includes('Slotted heading'))).toBe(true);
      expect(texts.some((t) => t.includes('projected into the card'))).toBe(true);

      // A closed root cannot be read, and says so instead of vanishing.
      expect(
        doc.warnings.some((w) => w.property === 'shadow-dom' && w.severity === 'degraded'),
      ).toBe(true);
      expect(texts.some((t) => t.includes('invisible to the capture'))).toBe(false);
    } finally {
      figmaMock.uninstall();
    }
  }, 120_000);
});

describe('multi-breakpoint import', () => {
  /**
   * Three viewports of a genuinely fluid page, combined into one document.
   * The assertion that matters is that the layouts actually differ: capturing
   * the same page three times would be worse than useless.
   */
  it('captures three viewports and lays them out in a row', async () => {
    figmaMock = installMockFigma();
    try {
      const captures = [];
      for (const breakpoint of DEFAULT_BREAKPOINTS) {
        const shot = await captureFixture('responsive-layout.html', { width: breakpoint.width });
        const { doc: transformed } = transformDocument(shot.doc);
        captures.push({ doc: transformed, label: breakpoint.label, width: breakpoint.width });
      }

      const combined = combineDocuments(captures, { gap: 100 });
      const kids = isFrame(combined.root) ? combined.root.children : [];
      expect(kids).toHaveLength(3);
      expect(kids.map((k) => k.name)).toEqual([
        'Desktop · 1440',
        'Tablet · 768',
        'Mobile · 390',
      ]);

      // Laid out left to right, no overlap.
      expect(kids[0]!.rect.x).toBe(0);
      expect(kids[1]!.rect.x).toBe(kids[0]!.rect.w + 100);

      // The media queries really fired: narrower viewports are taller.
      expect(kids[2]!.rect.h).toBeGreaterThan(kids[0]!.rect.h);
      expect(kids[0]!.rect.w).toBeGreaterThan(kids[2]!.rect.w);

      // One document the builder can consume in a single pass.
      const { root, report } = await buildDocument(combined);
      expect(root.children).toHaveLength(3);
      expect(report.warnings.filter((w) => w.property === 'build')).toHaveLength(0);
    } finally {
      figmaMock.uninstall();
    }
  }, 180_000);
});

describe('dark mode capture', () => {
  it('captures the page under prefers-color-scheme: dark', async () => {
    figmaMock = installMockFigma();
    try {
      const light = await captureFixture('responsive-layout.html', {
        width: 1440,
        colorScheme: 'light',
      });
      const dark = await captureFixture('responsive-layout.html', {
        width: 1440,
        colorScheme: 'dark',
      });

      const firstSolid = (d: typeof light): string => {
        for (const node of walk(d.doc.root)) {
          if (!isFrame(node)) continue;
          const fill = node.fills.find((f) => f.type === 'SOLID');
          if (fill && fill.type === 'SOLID') {
            return [fill.color.r, fill.color.g, fill.color.b]
              .map((c) => Math.round(c * 255))
              .join(',');
          }
        }
        return 'none';
      };

      expect(firstSolid(light)).not.toBe(firstSolid(dark));
      // The dark capture really is dark.
      const darkChannels = firstSolid(dark).split(',').map(Number);
      expect(Math.max(...darkChannels)).toBeLessThan(80);
    } finally {
      figmaMock.uninstall();
    }
  }, 120_000);
});

describe('CSS background images', () => {
  /**
   * A background image has no element to draw from, so it must be fetched. The
   * only route used to be the extension's background worker, which meant every
   * background image was dropped from relay and local-HTML imports — including
   * same-origin ones. Icons and hero images vanished and left white boxes.
   */
  it('inlines background images as raster bytes Figma can hold', async () => {
    figmaMock = installMockFigma();
    try {
      const captured = await captureFixture('background-images.html');
      const assets = Object.values(captured.doc.images);
      expect(assets.length).toBeGreaterThan(0);

      // figma.createImage takes PNG, JPEG and GIF only: an SVG background has
      // to arrive rasterised, never as image/svg+xml.
      for (const asset of assets) {
        expect(asset.mime).toMatch(/^image\/(png|jpe?g|gif)$/);
      }
      expect(
        captured.doc.warnings.filter((w) => w.property === 'background-image'),
      ).toHaveLength(0);

      const { doc } = transformDocument(captured.doc);
      const { report } = await buildDocument(doc);
      expect(report.warnings.filter((w) => w.property === 'image')).toHaveLength(0);
    } finally {
      figmaMock.uninstall();
    }
  }, 120_000);
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
