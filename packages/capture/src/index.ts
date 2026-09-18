import type { FontRequest, IRDocument, IRNode, Rect } from '@web2figma/ir';
import { IR_VERSION, isText, walk } from '@web2figma/ir';
import { WarningSink } from '@web2figma/shared';
import { fontKey } from '@web2figma/transform';
import { AssetStore, type CorsFetcher } from './images.js';
import { preparePage, type PrepareOptions } from './prepare.js';
import { walkElement, type WalkContext } from './walk.js';

export * from './prepare.js';
export * from './images.js';
export * from './styles.js';
export * from './text.js';
export * from './walk.js';
export * from './pseudo.js';
export * from './picker.js';

/**
 * Capture entry points (PRD section 5). All three share one implementation and
 * differ only in where they run and how they reach the DOM.
 */

export interface CaptureOptions extends PrepareOptions {
  /** Skip preparePage, for a document already prepared by the caller. */
  skipPrepare?: boolean;
  /** Supplied by the extension background script for CORS-blocked images. */
  fetchViaBackground?: CorsFetcher;
  sourceRef?: string;
  sourceKind?: 'url' | 'html' | 'image';
}

export interface CaptureResult {
  doc: IRDocument;
  elapsedMs: number;
}

function collectFontRequests(root: IRNode): FontRequest[] {
  const seen = new Map<string, FontRequest>();
  for (const node of walk(root)) {
    if (!isText(node)) continue;
    for (const seg of node.segments) {
      const key = fontKey(seg.font);
      if (!seen.has(key)) seen.set(key, seg.font);
    }
  }
  return [...seen.values()];
}

/**
 * Capture a document or a single element. Used by the extension content script
 * (live tab, element picking) and by the plugin UI iframe (local HTML).
 */
export async function captureDocument(
  root: Element,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const started = Date.now();
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  const warnings = new WarningSink();

  let cleanup: (() => void) | null = null;
  if (!options.skipPrepare) {
    const prep = await preparePage({ ...options, doc });
    cleanup = prep.cleanup;
    for (const selector of prep.removedOverlays) {
      warnings.info('', 'overlay', `removed overlay ${selector}`);
    }
    if (!prep.fontsReady) warnings.info('', 'font', 'document.fonts.ready did not settle');
    if (prep.imagesTimedOut > 0) {
      warnings.info('', 'image', `${prep.imagesTimedOut} images timed out while decoding`);
    }
  }

  try {
    // Client rects are viewport-relative; the origin lifts them into document
    // space so the rects survive the scroll position of the capture.
    const origin = { x: win.scrollX, y: win.scrollY };
    const isWholeDocument = root === doc.documentElement || root === doc.body;
    const rootBox = root.getBoundingClientRect();
    const bounds: Rect = isWholeDocument
      ? { x: 0, y: 0, w: doc.documentElement.scrollWidth, h: doc.documentElement.scrollHeight }
      : { x: rootBox.left + origin.x, y: rootBox.top + origin.y, w: rootBox.width, h: rootBox.height };

    const assets = new AssetStore({
      doc,
      ...(options.fetchViaBackground ? { fetchViaBackground: options.fetchViaBackground } : {}),
    });

    const ctx: WalkContext = {
      doc,
      win,
      assets,
      warnings,
      origin,
      bounds,
      resolveAsset: () => null,
    };
    // Background images are resolved synchronously during the walk, so they are
    // pre-fetched here and looked up from the cache.
    const backgroundUrls = collectBackgroundUrls(root, win);
    const resolved = new Map<string, string>();
    for (const url of backgroundUrls) {
      const id = await assets.fromUrl(url);
      if (id) resolved.set(url, id);
      else warnings.dropped('', 'background-image', `could not inline ${url.slice(0, 120)}`);
    }
    ctx.resolveAsset = (url: string) => resolved.get(url) ?? null;

    const result = await walkElement(root, ctx, [], null);
    if (!result.node) throw new Error('capture produced no nodes');

    const rootNode = result.node;
    if (isWholeDocument) {
      // The root frame has to cover the whole *document*, not the <html> border
      // box (PRD section 5, step 6). On any page with `html { height: 100% }`
      // those differ by the entire scroll length, and since the root rect is
      // also the pruning boundary, taking the border box silently deleted
      // everything below the fold.
      //
      // scrollHeight alone is not the answer either: it never reports less than
      // the viewport, which would pad a short page with dead space. The honest
      // height is the taller of the element box and what was actually captured.
      // The extent has to come from the whole tree, not the direct children:
      // a body with `height: 100%` is viewport-tall while its own sections
      // overflow it by thousands of pixels.
      let contentBottom = 0;
      let contentRight = 0;
      for (const node of walk(rootNode)) {
        contentBottom = Math.max(contentBottom, node.rect.y + node.rect.h);
        contentRight = Math.max(contentRight, node.rect.x + node.rect.w);
      }
      rootNode.rect = {
        x: 0,
        y: 0,
        w: Math.max(rootNode.rect.w, contentRight),
        h: Math.max(rootNode.rect.h, contentBottom),
      };
      if (rootNode.kind === 'frame' && rootNode.clip) {
        // html/body commonly carry `overflow-x: hidden`, which would clip the
        // whole import to the first viewport once it reaches Figma.
        rootNode.clip = false;
        warnings.info(rootNode.id, 'overflow', 'root clipping removed so the full page is visible');
      }
    } else {
      // Element picking rebases the root to the origin (PRD section 5).
      rootNode.rect = { ...rootNode.rect, x: bounds.x, y: bounds.y };
    }

    const irDoc: IRDocument = {
      version: IR_VERSION,
      source: {
        kind: options.sourceKind ?? 'url',
        ref: options.sourceRef ?? win.location?.href ?? 'unknown',
        capturedAt: new Date().toISOString(),
      },
      viewport: {
        width: win.innerWidth || bounds.w,
        height: win.innerHeight || bounds.h,
        dpr: win.devicePixelRatio || 1,
      },
      root: rootNode,
      fonts: collectFontRequests(rootNode),
      images: assets.all,
      warnings: warnings.all,
    };
    return { doc: irDoc, elapsedMs: Date.now() - started };
  } finally {
    cleanup?.();
  }
}

function collectBackgroundUrls(root: Element, win: Window): string[] {
  const urls = new Set<string>();
  const visit = (el: Element): void => {
    const cs = win.getComputedStyle(el);
    for (const value of [cs.backgroundImage, win.getComputedStyle(el, '::before').backgroundImage, win.getComputedStyle(el, '::after').backgroundImage]) {
      if (!value || value === 'none') continue;
      for (const match of value.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
        const url = match[2];
        if (url && !url.startsWith('data:')) urls.add(url);
        else if (url) urls.add(url);
      }
    }
    for (const child of Array.from(el.children)) visit(child);
  };
  visit(root);
  return [...urls];
}

/**
 * Render self-contained HTML in a hidden iframe and capture it. This is how the
 * plugin imports local HTML and AI-generated designs without a network round
 * trip (PRD section 5).
 */
export async function captureInIframe(
  html: string,
  options: CaptureOptions & { width?: number; height?: number } = {},
): Promise<CaptureResult> {
  const width = options.width ?? 1440;
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = `position:fixed;left:-99999px;top:0;width:${width}px;height:${options.height ?? 900}px;border:0;visibility:hidden;`;
  document.body.appendChild(iframe);

  try {
    const idoc = iframe.contentDocument;
    if (!idoc) throw new Error('iframe document unavailable');
    idoc.open();
    idoc.write(html);
    idoc.close();

    await new Promise<void>((resolve) => {
      if (idoc.readyState === 'complete') resolve();
      else iframe.addEventListener('load', () => resolve(), { once: true });
      // Documents written this way sometimes never fire load.
      setTimeout(resolve, 1500);
    });

    // Let the iframe grow to its content so nothing is clipped at capture time.
    const fullHeight = Math.max(
      idoc.documentElement.scrollHeight,
      idoc.body?.scrollHeight ?? 0,
      options.height ?? 0,
    );
    iframe.style.height = `${fullHeight}px`;

    const target = idoc.body ?? idoc.documentElement;
    return await captureDocument(target, {
      ...options,
      sourceKind: options.sourceKind ?? 'html',
      sourceRef: options.sourceRef ?? 'inline-html',
      doc: idoc,
    });
  } finally {
    iframe.remove();
  }
}
