import type { ImageAsset } from '@web2figma/ir';
import { hashAsset } from '@web2figma/shared';

/**
 * Image inlining (PRD section 5).
 *
 * Inlining has to happen at capture time: the plugin sandbox has no network and
 * the plugin UI iframe would hit CORS on most CDNs. A tainted canvas falls back
 * to a host-permission fetch, then to an average-colour placeholder.
 */

export const MAX_EDGE = 2048;
export const RECOMPRESS_ABOVE = 500 * 1024;

export type CorsFetcher = (url: string) => Promise<string | null>;

export interface AssetStoreOptions {
  /** Supplied by the extension background script, which has host permissions. */
  fetchViaBackground?: CorsFetcher;
  maxEdge?: number;
  doc?: Document;
  /** Re-read srcset and take the sharpest candidate. Default true. */
  preferHighRes?: boolean;
}

export interface SrcsetCandidate {
  url: string;
  /** Effective pixel width, from a `w` descriptor or `x` times the layout width. */
  width: number;
}

/**
 * Parse a srcset attribute. `w` descriptors give a pixel width directly; `x`
 * descriptors are multipliers over the element's layout width, so the caller
 * passes that in to make the two comparable.
 */
export function parseSrcset(srcset: string, layoutWidth = 0): SrcsetCandidate[] {
  if (!srcset.trim()) return [];
  return srcset
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url = '', descriptor = ''] = part.split(/\s+/);
      if (/^\d+(\.\d+)?w$/.test(descriptor)) return { url, width: parseFloat(descriptor) };
      if (/^\d+(\.\d+)?x$/.test(descriptor)) {
        return { url, width: parseFloat(descriptor) * (layoutWidth || 1) };
      }
      // A bare URL is the 1x candidate.
      return { url, width: layoutWidth || 1 };
    })
    .filter((c) => c.url !== '');
}

/**
 * The sharpest source an <img> offers, looking at its own srcset and at the
 * <source> elements of a wrapping <picture>. Returns null when there is nothing
 * better than what the browser already chose.
 */
export function bestSource(img: HTMLImageElement): string | null {
  const layoutWidth = img.getBoundingClientRect().width || img.width || 0;
  const candidates: SrcsetCandidate[] = [...parseSrcset(img.getAttribute('srcset') ?? '', layoutWidth)];

  const picture = img.closest('picture');
  if (picture) {
    for (const source of Array.from(picture.querySelectorAll('source'))) {
      // Skip art-directed sources meant for other viewports: their crop differs
      // from what was on screen, so taking them would change the design.
      if (source.getAttribute('media')) continue;
      candidates.push(...parseSrcset(source.getAttribute('srcset') ?? '', layoutWidth));
    }
  }
  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => (b.width > a.width ? b : a));
  const current = img.currentSrc || img.src;
  const currentWidth = candidates.find((c) => absolute(img, c.url) === current)?.width ?? 0;
  if (best.width <= currentWidth) return null;
  return absolute(img, best.url);
}

function absolute(img: HTMLImageElement, url: string): string {
  try {
    return new URL(url, img.ownerDocument.baseURI).href;
  } catch {
    return url;
  }
}

function guessMime(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  switch (ext) {
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'avif':
      return 'image/avif';
    default:
      return 'image/png';
  }
}

export interface StoredAsset {
  id: string;
  asset: ImageAsset;
}

/** Collects assets, deduped by content hash (PRD section 5). */
export class AssetStore {
  private readonly byHash = new Map<string, string>();
  private readonly assets: Record<string, ImageAsset> = {};
  private readonly byUrl = new Map<string, string | null>();
  private counter = 0;

  constructor(private readonly options: AssetStoreOptions = {}) {}

  get all(): Record<string, ImageAsset> {
    return this.assets;
  }

  /** Register raw base64 bytes, returning the (possibly existing) asset id. */
  put(bytes: string, mime: string, width: number, height: number): string {
    const hash = hashAsset(bytes);
    const existing = this.byHash.get(hash);
    if (existing) return existing;
    const id = `a${++this.counter}`;
    this.byHash.set(hash, id);
    this.assets[id] = { bytes, mime, width, height, hash };
    return id;
  }

  /**
   * Inline an <img>, <canvas> or <video> element. Returns null when every
   * strategy failed, and the caller emits a placeholder.
   */
  async fromElement(el: Element): Promise<string | null> {
    const doc = this.options.doc ?? el.ownerDocument;
    const win = doc.defaultView ?? window;

    if (el instanceof win.HTMLCanvasElement) {
      return this.fromCanvas(el);
    }
    if (el instanceof win.HTMLVideoElement) {
      const canvas = doc.createElement('canvas');
      canvas.width = el.videoWidth || Math.round(el.getBoundingClientRect().width);
      canvas.height = el.videoHeight || Math.round(el.getBoundingClientRect().height);
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width === 0 || canvas.height === 0) return null;
      try {
        ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
        return this.fromCanvas(canvas);
      } catch {
        return null;
      }
    }
    if (el instanceof win.HTMLImageElement) {
      // The browser picks a source for the viewport it is rendering at, which is
      // often a half-resolution variant. A design file wants the sharpest one
      // the page offers, so the srcset is re-read here and the best candidate
      // fetched; if that fails, the rendered source still works.
      const best = this.options.preferHighRes === false ? null : bestSource(el);
      if (best && best !== (el.currentSrc || el.src)) {
        const highRes = await this.fromUrl(best);
        if (highRes) return highRes;
      }
      return this.fromUrl(el.currentSrc || el.src, el);
    }
    return null;
  }

  /** Rasterise an arbitrary canvas, respecting the size caps. */
  fromCanvas(canvas: HTMLCanvasElement): string | null {
    try {
      const scaled = this.downscale(canvas);
      const dataUrl = scaled.toDataURL('image/png');
      const bytes = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (bytes.length * 0.75 > RECOMPRESS_ABOVE) {
        const webp = scaled.toDataURL('image/webp', 0.85);
        if (webp.startsWith('data:image/webp')) {
          return this.put(webp.slice(webp.indexOf(',') + 1), 'image/webp', scaled.width, scaled.height);
        }
      }
      return this.put(bytes, 'image/png', scaled.width, scaled.height);
    } catch {
      // Tainted canvas: the caller retries through the background fetcher.
      return null;
    }
  }

  async fromUrl(url: string, sourceEl?: HTMLImageElement): Promise<string | null> {
    if (!url) return null;
    if (this.byUrl.has(url)) return this.byUrl.get(url) ?? null;

    // A data: URI is already inline.
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      const mime = /data:([^;,]+)/.exec(url)?.[1] ?? 'image/png';
      const payload = url.slice(comma + 1);
      const id = this.put(payload, mime, sourceEl?.naturalWidth ?? 0, sourceEl?.naturalHeight ?? 0);
      this.byUrl.set(url, id);
      return id;
    }

    const doc = this.options.doc ?? document;
    let id: string | null = null;

    if (sourceEl && sourceEl.complete && sourceEl.naturalWidth > 0) {
      const canvas = doc.createElement('canvas');
      canvas.width = sourceEl.naturalWidth;
      canvas.height = sourceEl.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        try {
          ctx.drawImage(sourceEl, 0, 0);
          id = this.fromCanvas(canvas);
        } catch {
          id = null;
        }
      }
    }

    // A CSS background image has no element to draw from, so it has to be
    // fetched. Every context can do this for a same-origin asset and for any
    // CDN that sends CORS headers; without this the only route was the
    // extension's background worker, which meant background images were
    // dropped entirely from relay and local-HTML imports.
    if (!id) id = await this.fetchAsAsset(url, doc);

    // Loading through an <img> succeeds for some cross-origin assets that a
    // bare fetch cannot read.
    if (!id) id = await this.viaImageElement(url, doc);

    if (!id && this.options.fetchViaBackground) {
      const dataUrl = await this.options.fetchViaBackground(url);
      if (dataUrl) {
        const mime = /data:([^;,]+)/.exec(dataUrl)?.[1] ?? 'image/png';
        id = this.put(dataUrl.slice(dataUrl.indexOf(',') + 1), mime, 0, 0);
      }
    }

    this.byUrl.set(url, id);
    return id;
  }

  /** fetch + blob -> base64, the route that works for same-origin assets. */
  private async fetchAsAsset(url: string, doc: Document): Promise<string | null> {
    const win = doc.defaultView ?? window;
    try {
      const response = await win.fetch(url, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) return null;
      const blob = await response.blob();
      if (blob.size === 0 || blob.size > 12 * 1024 * 1024) return null;
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < buffer.length; i += chunk) {
        binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
      }
      const mime = blob.type || guessMime(url);
      // figma.createImage only accepts PNG, JPEG and GIF bytes. An SVG has to
      // be rasterised by the caller instead of travelling as-is, or the build
      // throws on it.
      if (mime.includes('svg')) return null;
      return this.put(win.btoa(binary), mime, 0, 0);
    } catch {
      return null;
    }
  }

  /** Last resort before the background worker: load it as an image and redraw. */
  private async viaImageElement(url: string, doc: Document): Promise<string | null> {
    const win = doc.defaultView ?? window;
    return new Promise<string | null>((resolve) => {
      const img = new (win as unknown as { Image: new () => HTMLImageElement }).Image();
      img.crossOrigin = 'anonymous';
      const done = (value: string | null): void => {
        img.onload = null;
        img.onerror = null;
        resolve(value);
      };
      img.onload = () => {
        const canvas = doc.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        if (canvas.width === 0 || canvas.height === 0) return done(null);
        const ctx = canvas.getContext('2d');
        if (!ctx) return done(null);
        try {
          ctx.drawImage(img, 0, 0);
          done(this.fromCanvas(canvas));
        } catch {
          done(null);
        }
      };
      img.onerror = () => done(null);
      // Never let one dead asset hold up the capture.
      setTimeout(() => done(null), 4000);
      img.src = url;
    });
  }

  private downscale(canvas: HTMLCanvasElement): HTMLCanvasElement {
    const maxEdge = this.options.maxEdge ?? MAX_EDGE;
    const longest = Math.max(canvas.width, canvas.height);
    if (longest <= maxEdge) return canvas;
    const scale = maxEdge / longest;
    const doc = this.options.doc ?? document;
    const out = doc.createElement('canvas');
    out.width = Math.max(1, Math.round(canvas.width * scale));
    out.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = out.getContext('2d');
    if (!ctx) return canvas;
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return out;
  }

  get totalBytes(): number {
    return Object.values(this.assets).reduce((a, b) => a + b.bytes.length * 0.75, 0);
  }
}

/** Average colour of an element's rendered box, for the placeholder fallback. */
export function averageColorOf(el: Element): { r: number; g: number; b: number } {
  const win = el.ownerDocument.defaultView ?? window;
  const cs = win.getComputedStyle(el);
  const match = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
  if (match) {
    const parts = (match[1] as string).split(',').map((n) => parseFloat(n));
    if (parts.length >= 3) {
      return {
        r: (parts[0] as number) / 255,
        g: (parts[1] as number) / 255,
        b: (parts[2] as number) / 255,
      };
    }
  }
  return { r: 0.85, g: 0.85, b: 0.85 };
}
