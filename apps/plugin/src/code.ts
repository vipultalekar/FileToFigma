import type { BuilderMessage, Envelope, IRDocument } from '@web2figma/ir';
import { IR_VERSION, defaultLayout } from '@web2figma/ir';
import { buildDocument } from './builder/build.js';
import { flattenInferredLayouts, rasteriseSubtree, selectByIrIds } from './builder/escapeHatches.js';

/**
 * Sandbox entry point (PRD section 3): deliberately dumb.
 *
 * It receives a finished IR, streams in the image assets, and calls the
 * builder. No decisions are made here; the UI iframe does the transport and the
 * transform package made every layout and style choice long before this.
 */

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });

let pending: IRDocument | null = null;
let lastRoot: FrameNode | null = null;

const post = (message: BuilderMessage): void => figma.ui.postMessage(message);

figma.ui.onmessage = async (msg: Envelope | { t: string; [k: string]: unknown }) => {
  try {
    switch (msg.t) {
      case 'begin': {
        const doc = (msg as Extract<Envelope, { t: 'begin' }>).doc;
        if (doc.version !== IR_VERSION) {
          post({ t: 'error', message: `IR version ${doc.version} is not supported (expected ${IR_VERSION})` });
          return;
        }
        pending = doc;
        pending.images = {};
        post({ t: 'progress', done: 0, total: (msg as { total: number }).total, stage: 'received' });
        return;
      }

      case 'asset': {
        const m = msg as Extract<Envelope, { t: 'asset' }>;
        if (pending) {
          // An asset over the chunk budget arrives as `id#0`, `id#1`, ...
          const hash = m.id.indexOf('#');
          const id = hash === -1 ? m.id : m.id.slice(0, hash);
          const existing = pending.images[id];
          pending.images[id] = {
            bytes: existing ? existing.bytes + m.bytes : m.bytes,
            mime: m.mime,
            width: 0,
            height: 0,
            hash: id,
          };
        }
        post({ t: 'ack', seq: m.seq });
        return;
      }

      case 'commit': {
        if (!pending) {
          post({ t: 'error', message: 'commit without a document' });
          return;
        }
        const doc = pending;
        pending = null;
        const { root, report } = await buildDocument(doc, {
          onProgress: (done, total, stage) => post({ t: 'progress', done, total, stage }),
        });
        lastRoot = root;
        post({ t: 'done', report });
        return;
      }

      case 'abort': {
        pending = null;
        figma.notify(`Import aborted: ${(msg as { reason: string }).reason}`);
        return;
      }

      case 'demo': {
        // M0 walking skeleton: a hardcoded three-node IR, no capture involved.
        const { root, report } = await buildDocument(demoDocument());
        lastRoot = root;
        post({ t: 'done', report });
        return;
      }

      case 'flatten': {
        const target = figma.currentPage.selection.length > 0
          ? figma.currentPage.selection
          : lastRoot
            ? [lastRoot]
            : [];
        const n = flattenInferredLayouts(target);
        figma.notify(`Flattened ${n} inferred layout${n === 1 ? '' : 's'}`);
        return;
      }

      case 'rasterise': {
        const n = await rasteriseSubtree(figma.currentPage.selection);
        figma.notify(`Rasterised ${n} selection${n === 1 ? '' : 's'}`);
        return;
      }

      case 'select-warned': {
        const ids = ((msg as Record<string, unknown>).ids as string[] | undefined) ?? [];
        const root = lastRoot ?? (figma.currentPage.children[0] as SceneNode | undefined);
        if (!root) return;
        const hits = selectByIrIds(root, ids);
        if (hits.length > 0) {
          figma.currentPage.selection = hits;
          figma.viewport.scrollAndZoomIntoView(hits);
        }
        figma.notify(`Selected ${hits.length} affected layer${hits.length === 1 ? '' : 's'}`);
        return;
      }

      case 'close':
        figma.closePlugin();
        return;

      default:
        return;
    }
  } catch (err) {
    post({ t: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

/** PRD section 14, M0: a blue frame containing a text node and a rectangle. */
function demoDocument(): IRDocument {
  const font = {
    family: 'Inter',
    weight: 600,
    italic: false,
    fallbackStack: ['sans-serif'],
    classification: 'sans-serif' as const,
  };
  return {
    version: IR_VERSION,
    source: { kind: 'html', ref: 'demo', capturedAt: new Date().toISOString() },
    viewport: { width: 400, height: 240, dpr: 1 },
    fonts: [font],
    images: {},
    warnings: [],
    root: {
      kind: 'frame',
      id: 'demo-root',
      name: 'Web2Figma demo',
      rect: { x: 0, y: 0, w: 400, h: 240 },
      opacity: 1,
      visible: true,
      effects: [],
      meta: { tag: 'body', classes: [] },
      fills: [{ type: 'SOLID', color: { r: 0.15, g: 0.35, b: 0.95 }, opacity: 1 }],
      strokes: [],
      corner: [12, 12, 12, 12],
      clip: true,
      layout: {
        ...defaultLayout(),
        mode: 'VERTICAL',
        padding: [24, 24, 24, 24],
        itemSpacing: 16,
        reason: 'flex',
      },
      children: [
        {
          kind: 'text',
          id: 'demo-text',
          name: 'Hello Figma',
          rect: { x: 24, y: 24, w: 352, h: 32 },
          opacity: 1,
          visible: true,
          effects: [],
          meta: { tag: 'h1', classes: [] },
          characters: 'Hello from Web2Figma',
          segments: [
            {
              start: 0,
              end: 20,
              font,
              size: 24,
              color: { type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 },
            },
          ],
          style: {
            align: 'LEFT',
            verticalAlign: 'TOP',
            lineHeight: { unit: 'AUTO' },
            letterSpacing: { unit: 'PIXELS', value: 0 },
            autoResize: 'HEIGHT',
          },
          layout: { ...defaultLayout(), sizing: { h: 'FILL', v: 'HUG' } },
        },
        {
          kind: 'frame',
          id: 'demo-rect',
          name: 'Rectangle',
          rect: { x: 24, y: 72, w: 352, h: 120 },
          opacity: 1,
          visible: true,
          effects: [
            {
              type: 'DROP_SHADOW',
              color: { r: 0, g: 0, b: 0, a: 0.25 },
              offset: { x: 0, y: 4 },
              radius: 12,
              spread: 0,
            },
          ],
          meta: { tag: 'div', classes: [] },
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
          strokes: [],
          corner: [8, 8, 8, 8],
          clip: false,
          children: [],
          layout: { ...defaultLayout(), sizing: { h: 'FILL', v: 'FIXED' }, reason: 'leaf' },
        },
      ],
    },
  };
}
