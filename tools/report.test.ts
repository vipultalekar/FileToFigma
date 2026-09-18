import { afterAll, describe, expect, it } from 'vitest';
import { autoLayoutCoverage, transformDocument } from '@web2figma/transform';
import { captureFixture, closeFixtureBrowser, listFixtures } from './fixtures/capture.js';

/**
 * The M4 acceptance metric (PRD section 14): Auto Layout coverage across the
 * whole fixture set must exceed 70% of frames. Reported per fixture so a
 * regression names the page that caused it.
 */

const RUN = process.env.FIXTURES === '1';

afterAll(async () => {
  if (RUN) await closeFixtureBrowser();
});

describe.skipIf(!RUN)('auto layout coverage across the fixture set', () => {
  it('exceeds 70% of frames', async () => {
    const fixtures = await listFixtures();
    let frames = 0;
    let withLayout = 0;
    const rows: string[] = [];
    const reasons: Record<string, number> = {};

    for (const name of fixtures) {
      const captured = await captureFixture(name);
      const { stats } = transformDocument(captured.doc);
      frames += stats.layout.frames;
      withLayout += stats.layout.withLayout;
      for (const [reason, n] of Object.entries(stats.layout.byReason)) {
        reasons[reason] = (reasons[reason] ?? 0) + n;
      }
      rows.push(
        `${name.padEnd(28)} ${String(stats.nodesOut).padStart(5)} nodes  ${(
          autoLayoutCoverage(stats.layout) * 100
        )
          .toFixed(1)
          .padStart(5)}% of ${String(stats.layout.frames).padStart(4)} frames`,
      );
    }

    const overall = frames === 0 ? 0 : withLayout / frames;
    console.log(
      [
        '',
        'Auto Layout coverage (PRD section 14, M4 acceptance)',
        ...rows,
        '-'.repeat(64),
        `overall ${(overall * 100).toFixed(1)}% of ${frames} frames`,
        `by reason: ${Object.entries(reasons)
          .map(([r, n]) => `${r} ${n}`)
          .join(', ')}`,
        '',
      ].join('\n'),
    );

    expect(overall).toBeGreaterThan(0.7);
  }, 180_000);
});
