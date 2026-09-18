# Web2Figma

Paste a URL or drop an image, get a Figma frame you can immediately redesign.

Web2Figma converts a live web page, a local HTML file, or a UI screenshot into
native, fully editable Figma layers with Auto Layout applied. It runs on your
machine, needs no account, and reports every property it could not reproduce
instead of dropping it silently.

## How it works

Three input paths converge on one Intermediate Representation, and exactly one
builder consumes it. No input path ever talks to the Figma API directly.

```
live tab (extension)  ─┐
URL (Playwright relay) ─┼─→ capture → raw IR → normalise → layout inference → final IR → builder → Figma nodes
local HTML (iframe)   ─┘                                                          ▲
image → OCR + palette + vision model → synthesised HTML ──────────────────────────┘
```

| Package | What it owns |
| --- | --- |
| `packages/ir` | The contract. Types only, no dependencies. |
| `packages/capture` | DOM walking and style extraction. Browser only. |
| `packages/transform` | Normalisation, layout inference, CSS mapping. Pure, isomorphic. |
| `packages/image-pipeline` | OCR, palette, icons, prompt contract, verification loop. |
| `packages/shared` | Warnings, hashing, transport codec, logging. |
| `apps/plugin` | Figma plugin: sandbox builder plus the React UI. |
| `apps/extension` | Chrome MV3 extension: capture, element picker, transport. |
| `apps/relay` | Local Node server and Playwright renderer. |
| `tools` | Mock Figma API, fixture harness, visual diff. |

The plugin sandbox is deliberately dumb: it receives a finished IR and
translates it one-to-one into API calls. Every decision — what is a text node,
what gets Auto Layout, which font substitutes for which — is made before the IR
reaches it, which keeps the slow, hard-to-debug runtime free of logic and the
transform layer testable in plain Node.

## Install

```bash
pnpm install
```

### The Figma plugin

```bash
pnpm plugin:build
```

Then in Figma: **Plugins → Development → Import plugin from manifest** and pick
`apps/plugin/manifest.json`. Press **Build demo frame** to check the install.

### The Chrome extension

```bash
pnpm ext:build
```

Then in Chrome: **chrome://extensions → Developer mode → Load unpacked** and
pick `apps/extension/dist`. `Alt+Shift+F` captures the page, `Alt+Shift+E`
starts the element picker.

### The local relay (optional, enables URL import)

```bash
npx playwright install chromium   # once
pnpm relay                        # listens on http://localhost:3579
```

## Using it

| You want | Do this |
| --- | --- |
| A page you are looking at | Extension → Capture page, then paste into the plugin |
| One component from a page | Extension → Pick an element, click the nav bar |
| A URL, without leaving Figma | Start the relay, then plugin → URL tab |
| The same page at three breakpoints | URL tab → tick Desktop, Tablet and Mobile |
| A page's dark theme | URL tab → Theme: Dark |
| Colour and text styles in the file | Tick **Styles** in the header before importing |
| A local or AI-generated HTML file | Plugin → Local HTML tab, drop the file |
| A screenshot | Start the relay, then plugin → Image tab (see PROGRESS.md) |

After every import the plugin shows a conversion report: nodes created, Auto
Layout coverage by inference reason, font substitutions, and every degraded or
dropped property with a **select affected layers** button. Two escape hatches
sit next to it — flatten low-confidence inferred layouts, and rasterise a
selection that imported badly.

## Testing

```bash
pnpm test                        # 161 unit and integration tests, no browser
FIXTURES=1 pnpm test:fixtures    # 16 golden-fixture end-to-end tests, needs Chromium
FIXTURES=1 npx vitest run tools/report.test.ts   # Auto Layout coverage report
```

The fixture suite renders each frozen page in Chromium, captures it, transforms
it, builds it against a mock Figma API, compares the render pixel by pixel, then
widens the root frame by 200px and asserts that nothing overlaps or clips. That
last step is what proves the Auto Layout is real rather than decorative.

## Status

See [PROGRESS.md](PROGRESS.md) for what passed and what was deferred per
milestone. M0 to M5 are complete; M6 needs an OCR engine and a vision model
wired to the injected hooks.

## Licence

MIT. Everything goes through the public Figma Plugin API; no part of this
project depends on Figma's undocumented clipboard format.
