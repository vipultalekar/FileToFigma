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
