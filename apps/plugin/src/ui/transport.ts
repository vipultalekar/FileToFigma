import type { BuilderMessage, Envelope, IRDocument, ImageAsset } from '@web2figma/ir';
import { countNodes } from '@web2figma/ir';
import { decodePayload } from '@web2figma/shared';

/**
 * UI iframe -> sandbox transport (PRD section 6).
 *
 * postMessage is structured-clone based and stalls the UI thread on large
 * payloads, so the structural IR goes first and assets stream individually,
 * each under the 1MB chunk budget, with an ack per chunk.
 */

const CHUNK_LIMIT = 900 * 1024;

export type ProgressHandler = (message: BuilderMessage) => void;

function send(envelope: Envelope): void {
  parent.postMessage({ pluginMessage: envelope }, '*');
}

/** Split an oversized base64 payload into ack-able pieces. */
function chunk(bytes: string): string[] {
  if (bytes.length <= CHUNK_LIMIT) return [bytes];
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_LIMIT) out.push(bytes.slice(i, i + CHUNK_LIMIT));
  return out;
}

export class SandboxBridge {
  private seq = 0;
  private readonly pendingAcks = new Map<number, () => void>();

  constructor(private readonly onMessage: ProgressHandler) {
    window.addEventListener('message', (event: MessageEvent) => {
      const message = (event.data as { pluginMessage?: BuilderMessage }).pluginMessage;
      if (!message) return;
      if (message.t === 'ack') {
        this.pendingAcks.get(message.seq)?.();
        this.pendingAcks.delete(message.seq);
        return;
      }
      this.onMessage(message);
    });
  }

  /** Send a complete document: skeleton first, then assets, then commit. */
  async sendDocument(doc: IRDocument, build: { createStyles?: boolean } = {}): Promise<void> {
    const images = doc.images;
    const skeleton: IRDocument = { ...doc, images: {} };
    send({ t: 'begin', total: countNodes(doc.root), doc: skeleton });

    for (const [id, asset] of Object.entries(images)) {
      await this.sendAsset(id, asset);
    }
    // Build options travel with the commit so the sandbox stays stateless.
    parent.postMessage({ pluginMessage: { t: 'commit', ...build } }, '*');
  }

  private async sendAsset(id: string, asset: ImageAsset): Promise<void> {
    const pieces = chunk(asset.bytes);
    for (let i = 0; i < pieces.length; i++) {
      const seq = ++this.seq;
      // Multi-part assets are reassembled by id, so each piece carries the same id.
      const payload: Envelope = {
        t: 'asset',
        seq,
        id: pieces.length === 1 ? id : `${id}#${i}`,
        bytes: pieces[i] as string,
        mime: asset.mime,
      };
      await new Promise<void>((resolve) => {
        this.pendingAcks.set(seq, resolve);
        send(payload);
        // Never hang the import on a dropped ack.
        setTimeout(resolve, 4000);
      });
    }
  }

  abort(reason: string): void {
    send({ t: 'abort', reason });
  }

  command(t: string, extra: Record<string, unknown> = {}): void {
    parent.postMessage({ pluginMessage: { t, ...extra } }, '*');
  }
}

/* ----------------------------------------------------------- T1 and T2 -- */

/** T1: decode a clipboard payload produced by the extension. */
export async function decodeClipboard(payload: string): Promise<IRDocument> {
  const doc = await decodePayload<IRDocument>(payload);
  if (!doc || typeof doc !== 'object' || !('root' in doc)) {
    throw new Error('That does not look like a Web2Figma payload.');
  }
  return doc;
}

export function getRelayOrigin(): string {
  try {
    const custom = localStorage.getItem('web2figma_relay_url');
    if (custom && custom.trim()) {
      return custom.trim().replace(/\/+$/, '');
    }
  } catch {}
  return 'http://localhost:3579';
}

export function setRelayOrigin(url: string): void {
  try {
    const clean = url.trim().replace(/\/+$/, '');
    if (clean && clean !== 'http://localhost:3579') {
      localStorage.setItem('web2figma_relay_url', clean);
    } else {
      localStorage.removeItem('web2figma_relay_url');
    }
  } catch {}
}

export interface RelayHealthInfo {
  ok: boolean;
  geminiConfigured?: boolean;
  latestId?: string | null;
  latestAt?: number | null;
  latestSource?: string | null;
}

/** T2: local relay health check. */
export async function relayHealth(): Promise<RelayHealthInfo> {
  try {
    const res = await fetch(`${getRelayOrigin()}/health`, { method: 'GET' });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as {
      ok?: boolean;
      geminiConfigured?: boolean;
      latestId?: string | null;
      latestAt?: number | null;
      latestSource?: string | null;
    };
    return {
      ok: Boolean(data.ok),
      geminiConfigured: data.geminiConfigured,
      latestId: data.latestId,
      latestAt: data.latestAt,
      latestSource: data.latestSource,
    };
  } catch {
    return { ok: false };
  }
}

export async function relayLatest(): Promise<IRDocument | null> {
  const res = await fetch(`${getRelayOrigin()}/ir/latest`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Relay error ${res.status}`);
  return (await res.json()) as IRDocument;
}

export interface RenderRequest {
  width?: number;
  widths?: number[];
  fullPage?: boolean;
  colorScheme?: 'light' | 'dark';
}

export async function relayRender(
  url: string,
  options: RenderRequest = {},
): Promise<IRDocument> {
  const res = await fetch(`${getRelayOrigin()}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, ...options }),
  });
  if (!res.ok) throw new Error(`Relay could not render: ${res.status} ${await res.text()}`);
  return (await res.json()) as IRDocument;
}

export async function relayImage(
  dataUrl: string,
  options: { width?: number; apiKey?: string } = {},
): Promise<IRDocument> {
  const res = await fetch(`${getRelayOrigin()}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, ...options }),
  });
  if (!res.ok) throw new Error(`Relay could not convert the image: ${res.status} ${await res.text()}`);
  return (await res.json()) as IRDocument;
}
