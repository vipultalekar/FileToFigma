/**
 * Transport codec: IR document <-> compact transferable string.
 *
 * T1 (clipboard) needs a text payload, so the pipeline is
 *   JSON -> gzip (CompressionStream where available) -> base64.
 * Both browser and Node have the pieces; neither has them under the same names,
 * hence the capability checks rather than an import.
 */

const MAGIC = 'W2F1:';

declare const Buffer: { from(s: string, enc: string): { toString(enc: string): string } } | undefined;

function hasCompressionStream(): boolean {
  return typeof (globalThis as Record<string, unknown>).CompressionStream === 'function';
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    // Node path, avoids the 64k argument-count limit of String.fromCharCode.
    const b = Buffer as unknown as { from(a: Uint8Array): { toString(e: string): string } };
    return b.from(bytes).toString('base64');
  }
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    const b = Buffer as unknown as { from(s: string, e: string): Uint8Array };
    return new Uint8Array(b.from(b64, 'base64'));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function streamThrough(bytes: Uint8Array, kind: 'gzip' | 'gunzip'): Promise<Uint8Array> {
  const g = globalThis as unknown as {
    CompressionStream: new (f: string) => ReadableWritablePair<Uint8Array, Uint8Array>;
    DecompressionStream: new (f: string) => ReadableWritablePair<Uint8Array, Uint8Array>;
    Response: new (b: BodyInit) => { arrayBuffer(): Promise<ArrayBuffer> };
    Blob: new (parts: BlobPart[]) => Blob;
  };
  const transform =
    kind === 'gzip' ? new g.CompressionStream('gzip') : new g.DecompressionStream('gzip');
  const stream = new (globalThis as unknown as { Blob: new (p: BlobPart[]) => Blob }).Blob([
    bytes as unknown as BlobPart,
  ])
    .stream()
    .pipeThrough(transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  const buf = await new g.Response(stream as unknown as BodyInit).arrayBuffer();
  return new Uint8Array(buf);
}

/** Encode any JSON-serialisable value to a clipboard-safe string. */
export async function encodePayload(value: unknown): Promise<string> {
  const json = JSON.stringify(value);
  const raw = new TextEncoder().encode(json);
  if (!hasCompressionStream()) return `${MAGIC}0:${bytesToBase64(raw)}`;
  const gz = await streamThrough(raw, 'gzip');
  return `${MAGIC}1:${bytesToBase64(gz)}`;
}

export async function decodePayload<T>(payload: string): Promise<T> {
  const trimmed = payload.trim();
  if (!trimmed.startsWith(MAGIC)) {
    // Allow raw JSON too: it makes manual testing and fixtures painless.
    return JSON.parse(trimmed) as T;
  }
  const body = trimmed.slice(MAGIC.length);
  const sep = body.indexOf(':');
  const flag = body.slice(0, sep);
  const b64 = body.slice(sep + 1);
  const bytes = base64ToBytes(b64);
  const raw = flag === '1' ? await streamThrough(bytes, 'gunzip') : bytes;
  return JSON.parse(new TextDecoder().decode(raw)) as T;
}

export function approxPayloadBytes(value: unknown): number {
  return JSON.stringify(value).length;
}
