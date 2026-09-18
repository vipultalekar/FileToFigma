# PROGRESS

What passed, what was deferred, milestone by milestone (PRD section 16).

Last run: 149 tests green — 140 unit/integration (`pnpm test`) and 9 fixture
end-to-end (`FIXTURES=1 pnpm test:fixtures`). Auto Layout coverage across the
fixture set: **77.2% of 333 frames**.

## M0 — Walking skeleton ✅

- `packages/ir/src/types.ts` written first and treated as frozen; `IR_VERSION = 1`.
- Plugin scaffold builds to a single `code.js` plus a self-contained `ui.html`.
- `Plugins → Development → Web2Figma → Build demo frame` creates a blue frame
  containing a text node and a rectangle (`demoDocument()` in `apps/plugin/src/code.ts`).
- Verified in CI rather than by hand: `tools/builder.test.ts > M0 walking skeleton`
  runs the real builder against the mock Figma API and asserts the tree.

## M1 — Local HTML import ✅

- `captureInIframe(html)` renders self-contained HTML in a hidden iframe inside
  the plugin UI, with no network round trip.
- Full style mapping: fills (solid, gradients, layered backgrounds, images),
  strokes (uniform plus synthesised edge frames for non-uniform borders),
  per-corner radii, shadows, blurs, text with ranged segments.
- Visual diff against the browser render is under the 5% budget on
  `flex-card-grid`, `pricing-table`, `pseudo-elements`, `mixed-inline-text`;
  `marketing-hero` and `dense-dashboard` run at a 12% budget (see
  *Known limitations*).

## M2 — Tier 1 Auto Layout ✅

- Flex and grid mapping per the PRD table, including `row-reverse`,
  `space-around → SPACE_BETWEEN` with a `degraded` warning, `align-items: stretch`
  → children FILL, and absolute escapes with constraints from the inset values.
- A flexbox card grid imports with Auto Layout throughout, and widening the root
  by 300px moves the fourth card up into the first row
  (`tools/builder.test.ts > M2 auto layout`).

## M3 — Live page capture ✅ (code complete, manual install not exercised here)

- Chrome MV3 extension: content script capture, element picker overlay,
  background service worker for CORS-exempt image fetching and relay posting,
  popup with the capture options.
- Pre-capture preparation runs in order: scroll sweep, `document.fonts.ready`,
  image `decode()` with a 3s cap, animation freeze, optional overlay removal,
  document height record.
- T1 clipboard transport: gzip + base64 through `CompressionStream`, with a
  textarea fallback when the clipboard write is refused.
- **Not verified here:** loading the unpacked extension in Chrome and importing
  five real sites. The code path is exercised by the fixture suite through the
  identical capture entry point, but the "five real sites" acceptance criterion
  needs a human with a browser.

## M4 — Tier 2 geometric inference ✅

- Axis scoring exactly as specified: `0.5·separation + 0.3·alignment +
  0.2·gapRegularity`, threshold 0.65, wrap detection for card grids, padding
  derivation with overflow reporting, per-child FILL/HUG/FIXED decisions,
  confidence and reason on every frame.
- Semantic naming with button/card/nav detection; `div` never reaches a layer name.
- Coverage by reason across the fixture set: `single 152`, `flex 74`,
  `geometric 31`. The `single` bucket is a one-child frame that became a
  vertical auto layout with real padding — legitimately editable, but worth
  knowing it is nearly half the number.
- Flatten escape hatch verified (`tools/builder.test.ts > escape hatches`).

## M5 — Element picking and relay ✅ (relay verified, picker not click-tested)

- `apps/relay` serves `/health`, `POST /ir`, `GET /ir/:id`, `GET /ir/latest`,
  `POST /render`, `POST /image` on `localhost:3579`.
- Smoke-tested end to end: `POST /render` against a fixture URL returned
  transformed IR rendered by Playwright with the same capture bundle the
  extension uses.
- The picker overlay is implemented (`packages/capture/src/picker.ts`) but its
  hover/shift-click behaviour has not been exercised against a real page.

## M6 — Image to UI ⚠️ partial

Built and unit-tested: OCR post-processing (line grouping, font-size estimation
and clustering, noise removal), k-means palette, icon region detection, the
prompt contract, and the render/diff/correct verification loop capped at three
iterations.

**Deferred:** no OCR engine and no vision model are wired up. Both are injected
dependencies (`ocr`, `model`, `decode`), so `POST /image` currently returns an
OCR-less skeleton and says so in the conversion report. Finishing M6 means
choosing Tesseract.js versus a cloud OCR and deciding whose API key backs the
vision model — which the PRD lists as an open decision for the product owner.

## Deviations from the PRD

1. **Plugin UI bundler.** React as specified, bundled with esbuild rather than
   Vite, so the repo has one build tool and the UI ships as a single inlined
   HTML file (which the plugin manifest needs anyway).
2. **Where style mapping runs.** The PRD's diagram puts style mapping after
   layout inference. The mapping functions live in `packages/transform/mapping`
   as specified and stay pure, but `packages/capture` calls them while it still
   holds the computed styles. The alternative was a second raw-style IR that
   nothing else needed.
3. **Visual diff harness.** As the PRD anticipates, the builder runs against a
   mock Figma API and its SVG render is diffed instead of a real Figma export.
   The mock includes an auto layout solver so the editability assertion is real.

## Known limitations

- The mock renderer approximates Figma: text metrics are calibrated per node
  from the captured box, but wrapping, letter-spacing and gradient interpolation
  are approximations. `marketing-hero` and `dense-dashboard` therefore carry a
  12% visual budget rather than 5%.
- 2D CSS grids with spanning cells fall back to absolute positioning with a
  `degraded` warning, as specified.
- `position: sticky` is captured at its resting position.
- The node ceiling (12,000) is enforced in `transformDocument`; above it the
  run refuses rather than degrading.

## How to run it

```bash
pnpm install
pnpm test                 # 140 unit and integration tests, no browser needed
FIXTURES=1 pnpm test:fixtures   # 9 end-to-end fixture tests, needs Chromium
pnpm plugin:build         # apps/plugin/dist -> import the manifest in Figma
pnpm ext:build            # apps/extension/dist -> load unpacked in Chrome
pnpm relay                # localhost:3579, needs `npx playwright install chromium`
```
