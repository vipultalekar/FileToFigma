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
  async sendDocument(doc: IRDocument): Promise<void> {
    const images = doc.images;
    const skeleton: IRDocument = { ...doc, images: {} };
    send({ t: 'begin', total: countNodes(doc.root), doc: skeleton });

    for (const [id, asset] of Object.entries(images)) {
      await this.sendAsset(id, asset);
    }
    send({ t: 'commit' });
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

export const RELAY_ORIGIN = 'http://localhost:3579';

/** T2: local relay. Returns null when the relay is not running. */
export async function relayHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${RELAY_ORIGIN}/health`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function relayLatest(): Promise<IRDocument | null> {
  const res = await fetch(`${RELAY_ORIGIN}/ir/latest`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Relay error ${res.status}`);
  return (await res.json()) as IRDocument;
}

export async function relayRender(
  url: string,
  options: { width?: number; fullPage?: boolean } = {},
): Promise<IRDocument> {
  const res = await fetch(`${RELAY_ORIGIN}/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, ...options }),
  });
  if (!res.ok) throw new Error(`Relay could not render: ${res.status} ${await res.text()}`);
  return (await res.json()) as IRDocument;
}

export async function relayImage(
  dataUrl: string,
  options: { width?: number } = {},
): Promise<IRDocument> {
  const res = await fetch(`${RELAY_ORIGIN}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, ...options }),
  });
  if (!res.ok) throw new Error(`Relay could not convert the image: ${res.status} ${await res.text()}`);
  return (await res.json()) as IRDocument;
}
